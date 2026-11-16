// EF4 round 2 R-1 (ruling R3-EF4-11; class error-catfile-object-missing, E16-D; meas-holds-62 and 91): a restart after `git gc
// --prune=now` pruned a blob that only the private index named. 01-engine §3.14 Restart step 5: "private index missing or unreadable →
// read-tree <state:snap>"; R3-EF4-11: an index that names a missing object counts as unreadable, so restart reseeds before its detection
// tick (one cat-file --batch-check over the oids of the listIndex result step 5 already read). 01-engine:145 (objects-only-in-private-
// index e8, VERIFIED: objects referenced only by a private index are pruned); §6 row "Missing object after user gc --prune=now" (reseed
// the private index from state:snap, nothing shown); ENG-04. Before the fix the restart's detection tick (tickOutside, before the
// unconditional reseed at the end of restart, R3-60) read every tracked path once (the stat cache starts empty) and sized its S_raw blob
// for the shrink guard (Snapshotter.referenceSizes → GitRepo.blobSizes): the pruned blob threw "cat-file --batch-check: object missing"
// and the start failed, at every respawn. Two shapes: the SIM's (a kill at snapshot.index_written after the private index took the
// edit's blob) and a clean materialization whose blob no ref names (a snapshot-only change, ENG-04) followed by a process end. Git is
// never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Oid } from '../../src/git/oid.js';
import { KilledAt, setCrashHandler } from '../../src/ports/crashpoint.js';
import { readWork, writeWork } from '../helpers/coreFixture.js';
import { blobText, buf, captureReady, lines, LogRecorder, prep, withCores } from '../helpers/publishHelpers.js';
import { gitIn, restartCore, startOk } from '../helpers/startFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const BASE = lines(12, (i) => `row ${i}`);
const FILES: Record<string, Buffer> = { 'README.md': buf('# restart gc fixture\n'), 'a.txt': buf(BASE), 'b.txt': buf(BASE) };
const EDIT = BASE.replace('row 3\n', 'row 3 edited by the human before the restart\n');

/** Throws KilledAt at the first hit of `point` (a dead process: the core is abandoned). */
async function killedAt<T>(point: string, fn: () => Promise<T>): Promise<void> {
  setCrashHandler((name) => {
    if (name === point) throw new KilledAt(name);
  });
  try {
    await assert.rejects(fn(), (e: unknown) => e instanceof KilledAt && e.point === point, `killed at ${point}`);
  } finally {
    setCrashHandler(null);
  }
}

for (const variant of ['killed at snapshot.index_written', 'materialized, then the process ends'] as const) {
  test(`R3-EF4-11: a blob only the private index names, pruned by git gc --prune=now while the daemon is down (${variant}): the restart reseeds the private index from state:snap (PRIVATE_INDEX_RESEEDED, cause missing_object) instead of failing on cat-file --batch-check, and the edit is still captured`, T10, async () => {
    await withCores(`restart-gc-${variant.startsWith('killed') ? 'kill' : 'clean'}`, { n: 1, files: FILES }, async (fx) => {
      const p = fx.peers[0]!;
      await prep(p);
      await writeWork(p, 'a.txt', EDIT);
      fx.advance(2_500);
      if (variant === 'killed at snapshot.index_written') await killedAt('snapshot.index_written', () => prep(p, true));
      else await prep(p, true);   // a snapshot-only materialization: no state update names its blob (ENG-04)

      const privateIndex = join(p.deps.paths.coworkDir, `${p.core.refs.e}.index`);
      const blob = (await p.core.repo.listIndex(privateIndex)).get('a.txt')!.oid as Oid;
      const snap = p.core.view!.snap;
      assert.notEqual((await p.core.repo.readTreeMap(snap)).get('a.txt')?.oid, blob, 'state:snap does not name the private-index blob');
      assert.equal((await p.core.repo.readBlob(blob)).toString('utf8'), EDIT, 'the private index holds the edit');
      await gitIn(p, ['gc', '-q', '--prune=now']);
      assert.equal(await p.core.repo.hasObject(blob, 'blob'), false, 'gc pruned the private-index-only blob (01-engine:145, e8)');

      const log = new LogRecorder();
      p.deps.log = log;
      await restartCore(p);
      await startOk(p, 'restart');   // 77fcade: rejects with "cat-file --batch-check: object missing (<blob>)"
      const reseeded = log.lines.filter((l) => l.code === 'PRIVATE_INDEX_RESEEDED');
      assert.ok(reseeded.length >= 1, `PRIVATE_INDEX_RESEEDED: ${log.text()}`);
      assert.equal(reseeded[0]!.params['snap'], snap, 'reseeded from state:snap');
      assert.equal(reseeded[0]!.params['cause'], 'missing_object', 'the cause names the pruned object (core.ts onReseed form)');
      for (const [path, e] of await p.core.repo.listIndex(privateIndex)) {
        assert.ok(await p.core.repo.hasObject(e.oid as Oid, 'blob'), `${path}: every private-index entry names an existing object`);
      }

      // Nothing was lost: the edit is on disk all along, and the first iterations capture it from there (R-01 re-form or the tick).
      assert.equal((await readWork(p, 'a.txt'))?.toString('utf8'), EDIT);
      await prep(p);
      fx.advance(20_000);
      const pair = await captureReady(p, await prep(p, true));
      assert.ok(pair.paths.includes('a.txt'), `the edit is in a ready pair: ${JSON.stringify(pair.paths)}`);
      assert.equal(await blobText(p, await p.core.repo.readTreeMap(pair.R), 'a.txt'), EDIT);
    });
  });
}

test('R3-EF4-11: a restart over an intact private index (every entry names an existing object) does not reseed it before the tick', T10, async () => {
  await withCores('restart-gc-intact', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prep(p);
    await writeWork(p, 'a.txt', EDIT);
    fx.advance(2_500);
    await prep(p, true);
    const log = new LogRecorder();
    p.deps.log = log;
    await restartCore(p);
    await startOk(p, 'restart');
    assert.deepEqual(log.lines.filter((l) => l.code === 'PRIVATE_INDEX_RESEEDED').map((l) => l.params), [], 'no step-5 reseed');
  });
});
