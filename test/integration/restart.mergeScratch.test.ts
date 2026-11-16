// test/integration/restart.mergeScratch.test.ts — F2 #153 (sweep half; ruling R-T8B-8): ENG-53 step 2's own-leftover pass
// removes the merge-file scratch a crash left behind — <coworkDir>/tmp/merge-<pid>-<n>/ (src/git/merge.ts, ruling
// G1-FILEFORM; normally removed in a finally) — without an age check (P2-OWNLOCKS: every merge runs inside an Engine
// operation of the daemon.lock holder), name-scoped: another tmp/ entry stays. 01-engine l. 198: nothing in tmp/ is a store.
// A merge in the restarted engine still runs. A separate file so the shared restart.test.ts stays untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mergeFile } from '../../src/git/merge.js';
import { buf, withCores } from '../helpers/publishHelpers.js';
import { restartCore, startOk } from '../helpers/startFixture.js';

test('restart removes the merge-file scratch leftovers tmp/merge-* (a directory with its side files, an empty one, a plain file) and keeps every other tmp/ entry; a merge still runs after it (F2 #153)', { timeout: 10 * 60_000 }, async () => {
  await withCores('restart-merge-scratch', { n: 1 }, async (fx) => {
    const p = fx.peers[0]!;
    const tmp = join(p.deps.paths.coworkDir, 'tmp');
    const full = join(tmp, 'merge-99999-1');
    const sideFile = join(full, `0.${'a'.repeat(40)}`);
    const empty = join(tmp, 'merge-99999-2');
    const plain = join(tmp, 'merge-x');
    const keep = join(tmp, 'keep.txt');
    await mkdir(full, { recursive: true });
    await writeFile(sideFile, 'a side the crash left\n');
    await mkdir(empty, { recursive: true });
    await writeFile(plain, 'a plain file named merge-x\n');
    await writeFile(keep, 'not a merge name\n');
    await restartCore(p);
    await startOk(p, 'restart');
    assert.equal(existsSync(full), false, 'tmp/merge-99999-1/ (with its side file) removed');
    assert.equal(existsSync(empty), false, 'tmp/merge-99999-2/ (empty) removed');
    assert.equal(existsSync(plain), false, 'the plain file tmp/merge-x removed');
    assert.equal(existsSync(keep), true, 'tmp/keep.txt is not a merge name: untouched');
    assert.equal(readFileSync(keep, 'utf8'), 'not a merge name\n');
    // The restarted engine still merges (its own scratch under tmp/ is created and removed).
    const repo = p.core.repo;
    const base = await repo.hashBytes(buf('one\ntwo\nthree\n'), true);
    const ours = await repo.hashBytes(buf('ONE\ntwo\nthree\n'), true);
    const theirs = await repo.hashBytes(buf('one\ntwo\nTHREE\n'), true);
    const m = await mergeFile(repo, ours, base, theirs);
    assert.equal(m.rc, 0, 'a clean merge');
    assert.equal(m.out.toString('utf8'), 'ONE\ntwo\nTHREE\n');
    assert.ok(existsSync(tmp), 'tmp/ is still there');
  });
});
