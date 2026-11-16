// Test-side readers shared by the 03-data record-creator suites (Plan 3 Task 7: churn.test.ts, portability.test.ts): the
// remote board tip's live tree and a test-side `git hash-object --path`, both with plain git, never an engine function.
import assert from 'node:assert/strict';
import type { CoreFixture, PeerFixture } from './coreFixture.js';
import { testRunner } from './tmp.js';

/**
 * The live tree the remote board tip publishes (live_code = the board commit's last parent), read test-side with plain git in
 * the bare remote, as path → blob oid (the remote's code mirror ref lags one publish, so it is not read).
 */
export async function remoteLive(fx: CoreFixture, p: PeerFixture): Promise<Map<string, string>> {
  const git = async (args: string[]): Promise<string> => {
    const r = await testRunner().run(args, { class: 'local', cwd: fx.remote.dir });
    assert.equal(r.code, 0, `git ${args.join(' ')} in the remote: ${r.stderr.toString('utf8')}`);
    return r.stdout.toString('utf8');
  };
  const board = (await fx.remote.refs())[p.core.refs.remoteBoard];
  assert.ok(board !== undefined, 'a remote board');
  const parents = (await git(['show', '-s', '--format=%P', board])).trim().split(' ');
  const out = new Map<string, string>();
  for (const rec of (await git(['ls-tree', '-r', '-z', parents[parents.length - 1]!])).split('\0')) {
    const tab = rec.indexOf('\t');
    if (tab > 0) out.set(rec.slice(tab + 1), rec.slice(0, tab).split(' ')[2]!);
  }
  return out;
}

/** Test-side `git hash-object --path=<path> --stdin` in the peer's clone (its own config). */
export async function hashTestSide(p: PeerFixture, path: string, bytes: Buffer): Promise<string> {
  const r = await testRunner().run(['hash-object', `--path=${path}`, '--stdin'], { class: 'local', cwd: p.deps.paths.workTree, stdin: bytes });
  assert.equal(r.code, 0, r.stderr.toString('utf8'));
  return r.stdout.toString('utf8').trim();
}
