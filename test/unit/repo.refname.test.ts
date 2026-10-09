import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOid } from '../../src/git/oid.js';
import { GitRepo, type RepoContext } from '../../src/git/repo.js';
import type { GitResult, GitRunner } from '../../src/git/runner.js';
import { REF_NAME_TABLE } from '../helpers/refNameTable.js';

const OID = parseOid('1'.repeat(40));
const CTX = (): RepoContext => ({ attrTree: null, filterDrivers: [], identity: { name: 'T', email: 't@cowork.invalid' }, wallMs: () => 0 });

/** A GitRepo over a fake runner that answers every call with exit 0 (for-each-ref: no ref; cat-file -t: commit) and records the subcommands. */
function fakeRepo(): { repo: GitRepo; calls: string[] } {
  const calls: string[] = [];
  const runner: GitRunner = {
    async run(args): Promise<GitResult> {
      calls.push(args[0]!);
      const stdout = Buffer.from(args[0] === 'cat-file' ? 'commit\n' : '', 'utf8');
      return { code: 0, stdout, stderr: Buffer.alloc(0), killedByWatchdog: false, aborted: false, durationMs: 0 };
    },
  };
  return { repo: new GitRepo(runner, { workTree: '/w', gitDir: '/w/.git', coworkDir: '/w/.git/cowork' }, CTX), calls };
}

test("GitRepo's ref checks (readRef, casRef, deleteLocalRef) follow checkRefName's table: every invalid name is refused before any git call, every valid one reaches git", async () => {
  const wrong: string[] = [];
  for (const [ref, valid] of REF_NAME_TABLE) {
    // deleteLocalRef takes cowork refs only: the row under refs/cowork-local/ (a prefix of valid components keeps the verdict).
    const local = `refs/cowork-local/${ref.slice('refs/'.length)}`;
    const cases: Array<[string, string, (repo: GitRepo) => Promise<unknown>]> = [
      ['readRef', ref, (repo) => repo.readRef(ref)],
      ['casRef', ref, (repo) => repo.casRef(ref, OID, null, 'test')],
      ['deleteLocalRef', local, (repo) => repo.deleteLocalRef(local, OID)],
    ];
    for (const [method, name, call] of cases) {
      const { repo, calls } = fakeRepo();
      let refused = false;
      try {
        await call(repo);
      } catch (e) {
        if (!(e instanceof Error) || !/invalid ref/.test(e.message)) throw e;
        refused = true;
        // checkRefName's own message: the same function as the network argv checks, not a copy of its rules.
        if (!e.message.startsWith(`${method}: invalid ref `)) wrong.push(`${method}(${JSON.stringify(name)}): message ${JSON.stringify(e.message)}`);
      }
      if (refused === valid) wrong.push(`${method}(${JSON.stringify(name)}): ${refused ? 'refused' : 'accepted'}, git says ${valid ? 'valid' : 'invalid'}`);
      if (refused && calls.length > 0) wrong.push(`${method}(${JSON.stringify(name)}): refused after git calls ${calls.join(', ')}`);
      if (!refused && calls.length === 0) wrong.push(`${method}(${JSON.stringify(name)}): accepted without reaching git`);
    }
  }
  assert.deepEqual(wrong, []);
  // A valid name reaches exactly one for-each-ref and reads as absent on empty output.
  const { repo, calls } = fakeRepo();
  assert.equal(await repo.readRef('refs/heads/feat+x'), null);
  assert.deepEqual(calls, ['for-each-ref']);
});
