// The LOCAL_ONLY binding (Plan 3 Task 2; 03-data §2, §3.6 D5 row 9, DAT-23, DAT-31; D-06; ruling R3-21): ScopeInputs.localOnlyPaths
// and localOnlyReason, and the apply's ConflictCtx.localOnly (D8 step 0, HLD-55), read the paths of non-terminal ON_DISK
// local_only records only; an OFF_DISK local_only record (a marker companion) and a terminal one leave the path's class alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyStep } from '../../src/engine/apply.js';
import { localOnlyScope } from '../../src/engine/core.js';
import type { NewRecord } from '../../src/holds/registry.js';
import { writeWork, type PeerFixture } from '../helpers/coreFixture.js';
import { buf, prep, stateA, withCores } from '../helpers/publishHelpers.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const ENV = 'config/.env.local';
const FILES: Record<string, Buffer> = {
  'README.md': buf('# local-only fixture\n'),
  '.gitignore': buf('node_modules/\n'),
  [ENV]: buf('KEY=1\nA=2\nB=3\nC=4\nD=5\n'),
  'config/.env.scan': buf('TOKEN=1\n'),
  'config/.env.filter': buf('FILTERED=1\n'),
  'config/.env.gone': buf('GONE=1\n'),
  'config/.env.rank1': buf('R1=1\n'),
  'config/.env.rank2': buf('R2=1\n'),
  'config/.env.rank3': buf('R3=1\n'),
  'src/m.txt': buf('m1\nm2\nm3\n'),
};

/** A one-path ON_DISK ACTIVE PATCH over p (h0 = A[p], h1 = `held`) with `guard`; local_only is the registry's (R3-12). */
async function patch(p: PeerFixture, path: string, held: string, guard: string | null, o: Partial<NewRecord> = {}): Promise<string> {
  const A = await stateA(p);
  return p.core.holds.hold({
    kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: [path],
    blobs: { h0: { [path]: A.get(path)!.oid }, h1: { [path]: await p.core.repo.hashBytes(buf(held), true) } },
    guard, origin: 'human', cs_ids: [], displaced_by: null, ...o,
  });
}

test('a path of a non-terminal ON_DISK local_only record is LOCAL_ONLY', T10, async () => {
  await withCores('scope-localonly', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const it0 = await prep(p);
    assert.deepEqual(it0.scope(ENV), { cls: 'LIVE', reason: null }, 'a tracked secret-like path is LIVE without a record');
    const env = await patch(p, ENV, 'KEY=2\nA=2\nB=3\nC=4\nD=5\n', 'revert');
    const scan = await patch(p, 'config/.env.scan', 'TOKEN=2\n', 'secret-scan');
    const filt = await patch(p, 'config/.env.filter', 'FILTERED=2\n', 'filter-failure');
    const gone = await patch(p, 'config/.env.gone', 'GONE=2\n', 'revert');
    await p.core.holds.transition(gone, { state: 'GONE' });
    const parent = await patch(p, 'src/m.txt', 'm1\nmarker\nm3\n', 'markers');
    const companion = await patch(p, 'src/m.txt', 'm1\nmarker\nm3\n', null, { residence: 'OFF_DISK', state: 'PARKED', companionOf: parent });
    const ign = await patch(p, '.gitignore', 'dist/\n', 'revert');
    for (const id of [env, scan, filt, companion, ign]) assert.equal(p.core.holds.get(id)!.local_only, true, `${id} is local_only`);
    assert.equal(p.core.holds.get(companion)!.residence, 'OFF_DISK');

    const it = await prep(p);
    assert.deepEqual(it.scope(ENV), { cls: 'LOCAL_ONLY', reason: 'secret-like' });
    assert.deepEqual(it.scope('config/.env.scan'), { cls: 'LOCAL_ONLY', reason: 'secret-scan' });
    assert.deepEqual(it.scope('config/.env.filter'), { cls: 'LOCAL_ONLY', reason: 'filter-failure' });
    assert.equal(it.scope('config/.env.gone').cls, 'LIVE', 'a terminal record leaves the path LIVE');
    assert.equal(it.scope('src/m.txt').cls, 'LIVE', 'a marker companion (OFF_DISK) leaves the path LIVE');
    assert.deepEqual(it.scope('.gitignore'), { cls: 'SAVE_ONLY', reason: 'save-only' }, 'one reason per path: row 6 first');
    assert.deepEqual([...it.scopeInputs.localOnlyPaths].sort(), ['.gitignore', 'config/.env.filter', 'config/.env.local', 'config/.env.scan']);
  });
});

test('DAT-31: one reason per path, ranked over every record on the path (filter-failure, then secret-scan, then secret-like)', T10, async () => {
  await withCores('scope-localonly-rank', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prep(p);
    // Two records per path, created in ULID order; the stronger reason wins whichever record came first (never the first or the
    // last record alone).
    const ids = [
      await patch(p, 'config/.env.rank1', 'R1=2\n', 'secret-scan'),
      await patch(p, 'config/.env.rank1', 'R1=3\n', 'revert'),
      await patch(p, 'config/.env.rank2', 'R2=2\n', 'revert'),
      await patch(p, 'config/.env.rank2', 'R2=3\n', 'secret-scan'),
      await patch(p, 'config/.env.rank3', 'R3=2\n', 'secret-scan'),
      await patch(p, 'config/.env.rank3', 'R3=3\n', 'filter-failure'),
    ];
    assert.equal(new Set(ids).size, ids.length, 'six records (different changes, HLD-07)');
    for (const id of ids) assert.deepEqual([p.core.holds.get(id)!.residence, p.core.holds.get(id)!.local_only], ['ON_DISK', true], id);
    const it = await prep(p);
    assert.deepEqual(it.scope('config/.env.rank1'), { cls: 'LOCAL_ONLY', reason: 'secret-scan' }, 'a weaker record after a stronger one');
    assert.deepEqual(it.scope('config/.env.rank2'), { cls: 'LOCAL_ONLY', reason: 'secret-scan' }, 'a stronger record after a weaker one');
    assert.deepEqual(it.scope('config/.env.rank3'), { cls: 'LOCAL_ONLY', reason: 'filter-failure' }, 'filter-failure over secret-scan');
    const lo = localOnlyScope(p.core);
    assert.deepEqual(['config/.env.rank1', 'config/.env.rank2', 'config/.env.rank3'].map((x) => lo.reason(x)), ['secret-scan', 'secret-scan', 'filter-failure']);
  });
});

test('ConflictCtx.localOnly is true exactly for paths of non-terminal ON_DISK local_only records', T10, async () => {
  await withCores('conflict-localonly', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prep(p);
    await patch(p, ENV, 'KEY=local\nA=2\nB=3\nC=4\nD=5\n', 'revert');
    const parent = await patch(p, 'src/m.txt', 'm1\nmarker\nm3\n', 'markers');
    await patch(p, 'src/m.txt', 'm1\nmarker\nm3\n', null, { residence: 'OFF_DISK', state: 'PARKED', companionOf: parent });
    // The binding the apply's conflict context reads (and prepareIteration's ScopeInputs).
    const lo = localOnlyScope(p.core);
    assert.equal(lo.paths.has(ENV), true);
    assert.equal(lo.paths.has('src/m.txt'), false, 'the OFF_DISK companion\'s path');
    // Through the apply: a teammate's edit of the same line of config/.env.local reaches the conflict function, whose step 0
    // answers from ConflictCtx.localOnly: the local version is never displaced (DEFER local_only_conflict).
    await writeWork(p, ENV, 'KEY=local\nA=2\nB=3\nC=4\nD=5\n');
    await prep(p);
    await fx.pushTeamChange({ [ENV]: buf('KEY=team\nA=2\nB=3\nC=4\nD=5\n') });
    fx.advance(10_000);
    const it = await prep(p, 'auto');
    assert.deepEqual([...it.scopeInputs.localOnlyPaths], [ENV]);
    const r = await applyStep(p.core, it);
    assert.equal(r.ran, true, String(r.skipped));
    assert.equal(r.deferred.get(ENV), 'local_only_conflict');
  });
});
