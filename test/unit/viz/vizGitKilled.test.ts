// Plan 8a final review, fix Group D (§4a "a watchdog-killed or aborted git call reads as 'no such ref'"): VizGit over a spying runner
// that answers each call with a killed or aborted result. On Windows the runner's tree kill (taskkill /F) makes git exit with code 1,
// which is rev-parse's "no such ref"; so a killed or aborted call must throw before its exit code is looked at, never read as an answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GitCallOptions } from '../../../src/git/flags.js';
import { GitCommandError } from '../../../src/git/repo.js';
import type { GitResult, GitRunner } from '../../../src/git/runner.js';
import { createVizGit } from '../../../src/viz/source/vizGit.js';

const WIN = process.platform === 'win32';
const GIT_DIR = WIN ? 'C:\\repo\\.git' : '/repo/.git';
const DATA_DIR = WIN ? 'C:\\data dir' : '/data dir';
const OID = 'a'.repeat(40);

/** A runner that records every call and answers each with `answer(args)`. */
function spyRunner(answer: (args: string[]) => GitResult): GitRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run(args: string[], _opts: GitCallOptions): Promise<GitResult> {
      calls.push([...args]);
      return Promise.resolve(answer(args));
    },
  };
}

const result = (code: number, stdout: string, how: { killedByWatchdog?: boolean; aborted?: boolean } = {}): GitResult => ({
  code, stdout: Buffer.from(stdout, 'utf8'), stderr: Buffer.alloc(0), killedByWatchdog: how.killedByWatchdog ?? false, aborted: how.aborted ?? false, durationMs: 0,
});

/** Every VizGit call, each answered by `r` (stdout fitting the call when its code is 0). */
const calls = (vg: ReturnType<typeof createVizGit>): Array<[string, () => Promise<unknown>]> => [
  ['revParse', () => vg.revParse('refs/cowork-remote/main/board')],
  ['remoteRefs', () => vg.remoteRefs()],
  ['chainCount', () => vg.chainCount(OID as never)],
  ['chain', () => vg.chain(OID as never, 0, 5)],
  ['version', () => vg.version()],
  ['run --batch-check', () => vg.run(['cat-file', '--batch-check'], { stdin: Buffer.from(`${OID}\n`) })],
  ['run --batch', () => vg.run(['cat-file', '--batch'], { stdin: Buffer.from(`${OID}\n`) })],
];

const STDOUT: Readonly<Record<string, string>> = {
  'rev-parse': `${OID}\n`, 'for-each-ref': `${OID} refs/cowork-remote/main/board\n`, 'rev-list': `${OID}\n`, version: 'git version 2.45.0\n', 'cat-file': '',
};
const countOut = (args: string[]): string => (args.includes('--count') ? '1\n' : STDOUT[args[0]!] ?? '');

test('VizGit: a watchdog-killed call throws GitCommandError, also when its exit code is one the call accepts (rev-parse\'s 1 is not "no such ref" then)', async () => {
  for (const code of [1, 0, -1, 128]) {
    const runner = spyRunner((args) => result(code, code === 0 ? countOut(args) : '', { killedByWatchdog: true }));
    const vg = createVizGit({ runner, gitDir: GIT_DIR, dataDir: DATA_DIR });
    for (const [name, call] of calls(vg)) {
      await assert.rejects(call(), (e: unknown) => e instanceof GitCommandError && e.code === code, `${name}, exit code ${code}`);
    }
    assert.equal(runner.calls.length, calls(vg).length, 'each call reached the runner once');
  }
});

test('VizGit: an aborted call (the viewer stopping, ruling P2-ABORT) throws GitCommandError, whatever its exit code', async () => {
  for (const code of [1, 0, -1]) {
    const runner = spyRunner((args) => result(code, code === 0 ? countOut(args) : '', { aborted: true }));
    const vg = createVizGit({ runner, gitDir: GIT_DIR, dataDir: DATA_DIR });
    for (const [name, call] of calls(vg)) {
      await assert.rejects(call(), (e: unknown) => e instanceof GitCommandError && e.code === code, `${name}, exit code ${code}`);
    }
  }
});

test('VizGit: a call that finished on its own keeps its meaning — rev-parse exit 1 is "no such ref" (null), exit 0 its oid; any other code throws', async () => {
  const answers = new Map<string, GitResult>();
  const runner = spyRunner((args) => answers.get(args[0]!) ?? result(0, countOut(args)));
  const vg = createVizGit({ runner, gitDir: GIT_DIR, dataDir: DATA_DIR });
  answers.set('rev-parse', result(1, ''));
  assert.equal(await vg.revParse('refs/cowork-remote/main/board'), null);
  answers.set('rev-parse', result(0, `${OID}\n`));
  assert.equal(await vg.revParse('refs/cowork-remote/main/board'), OID);
  answers.set('rev-parse', result(128, ''));
  await assert.rejects(vg.revParse('refs/cowork-remote/main/board'), GitCommandError);
  answers.set('for-each-ref', result(1, ''));
  await assert.rejects(vg.remoteRefs(), GitCommandError);
  answers.delete('for-each-ref');
  assert.deepEqual(await vg.remoteRefs(), [{ ref: 'refs/cowork-remote/main/board', oid: OID }]);
});
