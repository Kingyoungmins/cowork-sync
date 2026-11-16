// A user's `git gc --prune=now` against the private index (Plan 3 Task EF, item 4; 01-engine §6 error table, row "Missing object after
// user gc --prune=now": write-tree / merge rc 128 → reseed private index from state:snap, retry; nothing shown to the user or Claude).
// A blob a materialization wrote for the private index only (reachable from no ref and not from .git/index) is pruned by gc; the next
// materialization's write-tree then exits 128. Snapshotter.materialize reseeds the private index from state:snap, runs a fresh tick
// and materializes once more, so S_raw holds the disk again. Real clones; git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Oid } from '../../src/git/oid.js';
import { writeWork } from '../helpers/coreFixture.js';
import { LogRecorder, prep, withCores } from '../helpers/publishHelpers.js';
import { gitIn } from '../helpers/startFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const A2 = 'one\nTWO by the human\nthree\nfour\nfive\nsix\nseven\neight\n';
const B2 = 'alpha\nBETA by the human\ngamma\n';

test('a blob only the private index holds, pruned by git gc --prune=now: the next materialization reseeds the private index from state:snap (PRIVATE_INDEX_RESEEDED), retries once and S_raw and S_disk hold both edits', T10, async () => {
  await withCores('snap-gc', { n: 1 }, async (fx) => {
    const p = fx.peers[0]!;
    const log = new LogRecorder();
    p.deps.log = log;
    await prep(p, true);
    // The first edit is materialized: its blob is written for the private index only (no capture, no ref names it).
    await writeWork(p, 'src/a.txt', A2);
    fx.advance(2_500);
    const it1 = await prep(p, true);
    const blobA = it1.mat!.sRawMap.get('src/a.txt')!.oid as Oid;
    assert.notEqual(blobA, it1.A.get('src/a.txt')!.oid, 'the private index holds the edit');
    const snap = p.core.view!.snap;
    assert.equal((await p.core.repo.readTreeMap(snap)).get('src/a.txt')?.oid === blobA, false, 'state:snap does not name it');
    await gitIn(p, ['gc', '-q', '--prune=now']);
    assert.equal(await p.core.repo.hasObject(blobA, 'blob'), false, 'gc pruned the private-index-only blob');
    // A second edit, then a materialization: write-tree over the private index meets the pruned blob (rc 128).
    await writeWork(p, 'src/b.txt', B2);
    fx.advance(2_500);
    const it2 = await prep(p, true);
    const mat = it2.mat!;
    for (const m of [mat.sRawMap, mat.sDiskMap]) {
      assert.equal((await p.core.repo.readBlob(m.get('src/a.txt')!.oid)).toString('utf8'), A2, 'the first edit, re-read from disk');
      assert.equal((await p.core.repo.readBlob(m.get('src/b.txt')!.oid)).toString('utf8'), B2, 'the second edit');
    }
    assert.ok(await p.core.repo.hasObject(mat.sRawMap.get('src/a.txt')!.oid, 'blob'), 'the re-read blob exists again');
    const reseeded = log.lines.filter((l) => l.code === 'PRIVATE_INDEX_RESEEDED');
    assert.equal(reseeded.length, 1, `one reseed: ${log.text()}`);
    assert.equal(reseeded[0]!.params['snap'], snap, 'from state:snap');
    // The next materialization needs no reseed (the private index is whole again).
    await writeWork(p, 'src/a.txt', `${A2}nine\n`);
    fx.advance(2_500);
    const it3 = await prep(p, true);
    assert.equal((await p.core.repo.readBlob(it3.mat!.sRawMap.get('src/a.txt')!.oid)).toString('utf8'), `${A2}nine\n`);
    assert.equal(log.lines.filter((l) => l.code === 'PRIVATE_INDEX_RESEEDED').length, 1, 'no second reseed');
  });
});

test('a write-tree rc 128 that is not a missing object (no pruned entry in the private index) is not retried: the error propagates', T10, async () => {
  await withCores('snap-gc-other', { n: 1 }, async (fx) => {
    const p = fx.peers[0]!;
    const log = new LogRecorder();
    p.deps.log = log;
    await prep(p, true);
    await writeWork(p, 'src/a.txt', A2);
    fx.advance(2_500);
    const repo = p.core.repo;
    const run = repo.run.bind(repo);
    let failed = 0;
    repo.run = async (args, o) => {
      if (args[0] === 'write-tree' && failed === 0) {
        failed += 1;
        return run(['write-tree', '--prefix=no-such-dir/'], o);   // "prefix not found": rc 128, every object present
      }
      return run(args, o);
    };
    try {
      await assert.rejects(prep(p, true), /write-tree/);
    } finally {
      Reflect.deleteProperty(repo, 'run');
    }
    assert.equal(failed, 1);
    assert.equal(log.lines.filter((l) => l.code === 'PRIVATE_INDEX_RESEEDED').length, 0, 'no reseed');
  });
});
