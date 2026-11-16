// Ruling R3-EF4-30 (R3-EF4-23 completed; EF5 merge item Z-3; E16-E delta re-review newBreakage[0]): local.json `restored` keeps one entry
// per path, the newest write wins. In memory ObservedWrites keeps the LAST write of p; the restart re-seeds it from `restored`, which
// local.json (canonical JSON) iterates in record-id (ULID, creation) order, and every entry of p carries the same `snap` (a restore makes
// no snap transition, HLD-57 (e)). With two restored records on one path, the newer-created one restored first, the restart re-seeded the
// OLDER write: the second restore's own write became an unobserved delta, diff(w1, w2) — with E16-E's trigger (a conflicted restore whose
// marker block re-adds a row the teammate deleted) a non-local_only revert record whose H1 holds restore-marker rows, ENG-41 (j)'s
// wedge. The same restores in creation order (the control) always re-seeded the newest. Real git on file:// clones; never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyStep } from '../../src/engine/apply.js';
import { revertStep } from '../../src/engine/detect.js';
import { restore } from '../../src/engine/holdOps.js';
import { restart } from '../../src/engine/restart.js';
import { hasRestoreMarkerRow } from '../../src/data/rows.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import { blobAt, heldSide, TERMINAL_STATES } from '../../src/holds/record.js';
import { readWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { blob, nr, P, pair, prepIt, stages, withPeers } from '../helpers/holdOpsFixture.js';
import { T9, t9 } from '../helpers/maskFixture.js';
import { buf } from '../helpers/publishHelpers.js';
import { restartCore } from '../helpers/startFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };
const HUMAN = { humanEvidence: true, actor: 'human' } as const;
const TEAM8 = 'eight by team';

/** Every non-terminal, non-local_only record whose held side holds a restore-marker row (E16-E's marker-H1 signature, ENG-41 (j)). */
async function markerHeld(p: PeerFixture): Promise<string[]> {
  const out: string[] = [];
  for (const r of p.core.holds.all()) {
    if ((TERMINAL_STATES as ReadonlySet<string>).has(r.state) || r.local_only) continue;
    for (const path of r.paths) {
      const o = blobAt(heldSide(r), path);
      if (o === undefined || o === ABSENT) continue;
      if (hasRestoreMarkerRow(await p.core.repo.readBlob(o as Oid))) out.push(`${r.id} rev ${r.rev} ${r.state} guards=${r.guards.map((g) => g.name).join('+')} held[${path}]`);
    }
  }
  return out;
}

/** A detection tick, then a materializing iteration whose revertStep runs; the revert record ids it made. */
async function detect(fx: CoreFixture, p: PeerFixture): Promise<string[]> {
  await prepIt(p);
  fx.advance(1_500);
  return revertStep(p.core, await prepIt(p, { materialize: true }));
}

test('R3-EF4-30: two restored ON_DISK records on one path, the newer-created restored first — local.json `restored` keeps only the newest write of p, so the restart re-seeds the bytes on disk', T10, async () => {
  await withPeers('restored-order', {}, async (fx) => {
    const p = fx.peers[0]!;
    const t = await blob(p, T9);
    const rOld = await p.core.holds.hold(nr({ residence: 'OFF_DISK', state: 'PARKED', guard: null as never, blobs: pair(t, await blob(p, t9([3, 'old']))) }));
    fx.advance(5_000);
    const rNew = await p.core.holds.hold(nr({ residence: 'OFF_DISK', state: 'PARKED', guard: null as never, blobs: pair(t, await blob(p, t9([7, 'new']))) }));
    assert.ok(rOld < rNew, `ids in creation order: ${rOld} < ${rNew}`);
    fx.advance(2_500);
    assert.deepEqual(await restore(p.core, await prepIt(p, { holdPaths: [P] }), rNew, HUMAN), { kind: 'RESTORED', markers: false });
    const w1 = await blob(p, (await readWork(p, P))!);
    fx.advance(2_500);
    assert.deepEqual(await restore(p.core, await prepIt(p, { holdPaths: [P] }), rOld, HUMAN), { kind: 'RESTORED', markers: false });
    const w2 = await blob(p, (await readWork(p, P))!);
    assert.notEqual(w1, w2);
    assert.equal(p.core.observed.peek(P, w2), true, 'in memory: the last write of p is observed');
    // One entry per path: the second restore's write replaced the first one's, and rNew's emptied list left local.json.
    const snap = (await p.core.repo.readTreeMap(p.core.view!.snap)).get(P)!.oid;
    assert.deepEqual(p.core.holds.local().restored, { [rOld]: [{ path: P, written: w2, snap }] });
    await restartCore(p);
    await restart(p.core);
    assert.equal(p.core.observed.peek(P, w2), true, 'the restart re-seeds the newest write w2 (the disk)');
    assert.equal(p.core.observed.peek(P, w1), false, 'never the older write w1');
    fx.advance(2_500);
    assert.deepEqual(await revertStep(p.core, await prepIt(p, { holdPaths: [P] })), [], 'no revert record');
  });
});

for (const restartBetween of [false, true]) {
  test(`R3-EF4-30 (E16-E's wedge): the newer-created record restored first (clean), then the older one (conflicted, markers); restart=${restartBetween} — no non-local_only record holds a restore-marker row and no revert record is made`, T10, async () => {
    await withPeers(`restored-order-wedge-${restartBetween}`, {}, async (fx) => {
      const p = fx.peers[0]!;
      await fx.pushTeamChange({ [P]: buf(t9([8, TEAM8])) });
      fx.advance(10_000);
      assert.ok((await applyStep(p.core, await prepIt(p, { forceFetch: true }))).written.includes(P));
      assert.deepEqual(await detect(fx, p), []);
      const A = await blob(p, t9([8, TEAM8]));
      // Older-created: an OFF_DISK K4 record whose s2 rewrites row 8 (its restore conflicts with the teammate's row 8: markers, base "8").
      const rOld = await p.core.holds.hold(nr({
        residence: 'OFF_DISK', state: 'CONFLICTED', guard: 'conflict', origin: 'daemon',
        blobs: stages(await blob(p, T9), await blob(p, t9([8, 'LOCAL held eight'])), A),
      }));
      fx.advance(5_000);
      // Newer-created: an OFF_DISK PARKED PATCH on row 3 (clean restore).
      const rNew = await p.core.holds.hold(nr({
        residence: 'OFF_DISK', state: 'PARKED', guard: null, origin: 'human',
        blobs: { h0: { [P]: A }, h1: { [P]: await blob(p, t9([3, 'three new'], [8, TEAM8])) } },
      }));
      assert.ok(rOld < rNew);
      fx.advance(2_500);
      assert.deepEqual(await restore(p.core, await prepIt(p, { holdPaths: [P] }), rNew, HUMAN), { kind: 'RESTORED', markers: false });
      fx.advance(2_500);
      assert.deepEqual(await restore(p.core, await prepIt(p, { holdPaths: [P] }), rOld, HUMAN), { kind: 'RESTORED', markers: true });
      const disk = (await readWork(p, P))!.toString('utf8');
      assert.ok(disk.includes('||||||| cowork:base\n8\n'), disk);
      if (restartBetween) {
        await restartCore(p);
        await restart(p.core);
      }
      const ids = await detect(fx, p);
      assert.deepEqual(await markerHeld(p), [], 'no non-local_only record holds a restore-marker row');
      assert.deepEqual(ids, []);
    });
  });
}

test('R3-EF4-30 control: the clean record created and restored first, the marker record created and restored second; restart — the newest write is re-seeded', T10, async () => {
  await withPeers('restored-order-control', {}, async (fx) => {
    const p = fx.peers[0]!;
    await fx.pushTeamChange({ [P]: buf(t9([8, TEAM8])) });
    fx.advance(10_000);
    assert.ok((await applyStep(p.core, await prepIt(p, { forceFetch: true }))).written.includes(P));
    assert.deepEqual(await detect(fx, p), []);
    const A = await blob(p, t9([8, TEAM8]));
    const rClean = await p.core.holds.hold(nr({
      residence: 'OFF_DISK', state: 'PARKED', guard: null, origin: 'human',
      blobs: { h0: { [P]: A }, h1: { [P]: await blob(p, t9([3, 'three new'], [8, TEAM8])) } },
    }));
    fx.advance(5_000);
    const rMarkers = await p.core.holds.hold(nr({
      residence: 'OFF_DISK', state: 'CONFLICTED', guard: 'conflict', origin: 'daemon',
      blobs: stages(await blob(p, T9), await blob(p, t9([8, 'LOCAL held eight'])), A),
    }));
    assert.ok(rClean < rMarkers);
    fx.advance(2_500);
    assert.deepEqual(await restore(p.core, await prepIt(p, { holdPaths: [P] }), rClean, HUMAN), { kind: 'RESTORED', markers: false });
    fx.advance(2_500);
    assert.deepEqual(await restore(p.core, await prepIt(p, { holdPaths: [P] }), rMarkers, HUMAN), { kind: 'RESTORED', markers: true });
    await restartCore(p);
    await restart(p.core);
    const ids = await detect(fx, p);
    assert.deepEqual(await markerHeld(p), []);
    assert.deepEqual(ids, []);
  });
});
