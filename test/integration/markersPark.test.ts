// The markers park (Plan 3 Task 5; 05-holds §3.4 item 3, HLD-16, HLD-17; 03-data DAT-46, I-DAT-12; 05 I11, F7, TC-HLD-06
// markers-park part; Review Focus 2; ruling R3-15): (1) one registry commit creates the marker companion (h0 = A[p], h1 = M[p]
// = route (b) -w of the staged copy, OFF_DISK PARKED, no guard, local_only), (2) writeLocalGroup(M → A), (3) one commit releases
// `markers` on r and moves it OFF_DISK; a failed write ends the companion GONE; a restart settles an interrupted one by
// observation. Real git on file:// clones; never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { markersPark, restore } from '../../src/engine/holdOps.js';
import { publishStep } from '../../src/engine/publish.js';
import { restart } from '../../src/engine/restart.js';
import type { Oid } from '../../src/git/oid.js';
import { KilledAt, setCrashHandler } from '../../src/ports/crashpoint.js';
import { readWork, workPath, writeWork } from '../helpers/coreFixture.js';
import { blob, P, prepIt, recordLog, registryCommits, remoteCoworkBlobs, stages, nr, withPeers } from '../helpers/holdOpsFixture.js';
import { T9, t9 } from '../helpers/maskFixture.js';
import { editAndCapture, prep } from '../helpers/publishHelpers.js';
import { gitIn, restartCore } from '../helpers/startFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

/** The disk after a conflicted RESTORE of a K4 record over an overlapping edit: cowork: restore markers on rows 2, 4, 6, 8. */
const ROWS = '1\n<<<<<<< cowork:disk\nTWO\n||||||| cowork:base\n2\n=======\ntwo\n>>>>>>> cowork:held\n3\n4\n5\n6\n7\n8\n9\n';
const MARKER_ROW = /^(<{7}|\|{7}|>{7}) cowork:/m;
const HUMAN = { humanEvidence: true, displacedBy: null } as const;

test('the markers park keeps the marker file in a local_only companion and writes A', T10, async () => {
  await withPeers('mpark', {}, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, P, ROWS);
    const it = await prepIt(p, { holdPaths: [P] });
    const t = it.A.get(P)!.oid;
    const s = stages(t, await blob(p, t9([2, 'two'])), await blob(p, t9([2, 'team'])));
    // r: a K4 record restored over an overlapping edit — ON_DISK ACTIVE, `conflict` released, `markers` added.
    const r = await p.core.holds.hold(nr({ guard: 'markers', origin: 'daemon', blobs: s }));
    const before = p.core.holds.get(r)!;
    const { commits, result } = await registryCommits(p, () => markersPark(p.core, it, r, HUMAN));
    assert.equal(result.kind, 'PARKED');
    const companion = result.kind === 'PARKED' ? result.companion : null;
    assert.ok(companion !== null);
    assert.equal(commits, 2, 'commit 1 (the companion) and commit 2 (r)');
    const c = p.core.holds.get(companion)!;
    assert.deepEqual([c.kind, c.residence, c.state, c.guards.length, c.local_only, c.origin, c.displaced_by], ['PATCH', 'OFF_DISK', 'PARKED', 0, true, 'daemon', null]);
    assert.ok('h1' in c.blobs);
    assert.equal(c.blobs.h0[P], t, 'h0 = A[p]');
    assert.equal((await p.core.repo.readBlob(c.blobs.h1[P] as Oid)).toString('utf8'), ROWS, 'h1 = M[p], the marker file byte-exact');
    assert.equal(p.core.holds.local().companions[companion], r, 'local().companions[r′] = r');
    assert.deepEqual(await readWork(p, P), Buffer.from(T9), 'writeLocalGroup(M → A)');
    const after = p.core.holds.get(r)!;
    assert.deepEqual([after.residence, after.state, after.guards.map((g) => g.name)], ['OFF_DISK', 'PARKED', []], 'markers released, OFF_DISK PARKED');
    assert.deepEqual(after.blobs, before.blobs, "r's blobs are unchanged");
    // An r still CONFLICTED stays CONFLICTED.
    await writeWork(p, 'src/u9.txt', ROWS);
    const it2 = await prepIt(p, { holdPaths: ['src/u9.txt'] });
    const u = it2.A.get('src/u9.txt')!.oid;
    const r2 = await p.core.holds.hold(nr({ paths: ['src/u9.txt'], state: 'CONFLICTED', guard: 'markers', origin: 'daemon', blobs: stages(u, await blob(p, t9([2, 'x'])), await blob(p, t9([2, 'y'])), 'src/u9.txt') }));
    const out2 = await markersPark(p.core, it2, r2, HUMAN);
    assert.equal(out2.kind, 'PARKED');
    assert.deepEqual([p.core.holds.get(r2)!.residence, p.core.holds.get(r2)!.state], ['OFF_DISK', 'CONFLICTED']);
  });
});

test('after a markers park no object reachable from refs/cowork/* contains a restore-marker row', T10, async () => {
  await withPeers('mpark-no-rows', {}, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, P, ROWS);
    const it = await prepIt(p, { holdPaths: [P] });
    const t = it.A.get(P)!.oid;
    const r = await p.core.holds.hold(nr({ guard: 'markers', origin: 'daemon', blobs: stages(t, await blob(p, t9([2, 'two'])), await blob(p, t9([2, 'team']))) }));
    assert.equal((await markersPark(p.core, it, r, HUMAN)).kind, 'PARKED');
    // The peer keeps publishing: a later change of another path lands.
    await editAndCapture(fx, p, { 'src/other.txt': 'other, later\n' });
    fx.advance(30_000);
    assert.equal((await publishStep(p.core, await prep(p))).outcome, 'landed');
    const blobs = await remoteCoworkBlobs(fx);
    assert.ok(blobs.length > 0);
    for (const b of blobs) assert.doesNotMatch(b.toString('latin1'), MARKER_ROW, 'no restore-marker row reaches refs/cowork/*');
  });
});

test('a failed markers park ends the companion GONE and leaves r unchanged', T10, async () => {
  for (const failure of ['LOCKED', 'MISMATCH'] as const) {
    await withPeers(`mpark-fail-${failure}`, {}, async (fx) => {
      const p = fx.peers[0]!;
      await writeWork(p, P, ROWS);
      const it = await prepIt(p, { holdPaths: [P] });
      const r = await p.core.holds.hold(nr({ guard: 'markers', origin: 'daemon', blobs: stages(it.A.get(P)!.oid, await blob(p, t9([2, 'two'])), await blob(p, t9([2, 'team']))) }));
      const before = p.core.holds.get(r)!;
      let release: (() => void) | null = null;
      let written = ROWS;
      // Between the companion's commit and the writer's pre-image check: a share-none holder, or an edit.
      p.fs.interpose('writeFileExclusive', '.new', async () => {
        if (failure === 'LOCKED') release = p.fs.holdLock(workPath(p, P), 'share-none');
        else await writeFile(workPath(p, P), (written = `${ROWS}an edit\n`));
      });
      const head0 = p.core.holds.head();
      const out = await markersPark(p.core, it, r, HUMAN);
      (release as (() => void) | null)?.();
      assert.deepEqual(out, { kind: failure });
      const companions = p.core.holds.companionsOf(r);
      assert.equal(companions.length, 1);
      assert.equal(companions[0]!.state, 'GONE', 'the companion ends GONE');
      const chain = await p.core.repo.firstParents(p.core.holds.head()!, head0, 100);
      assert.equal(chain.length, 2, 'the companion commit and one commit ending it');
      const after = p.core.holds.get(r)!;
      assert.deepEqual([after.residence, after.rev, after.guards.map((g) => g.name)], [before.residence, before.rev, ['markers']], 'r unchanged: ON_DISK with markers');
      assert.deepEqual(await readWork(p, P), Buffer.from(written), 'disk unchanged by the park');
    });
  }
});

test('restoring a marker companion writes its rows back and adds markers', T10, async () => {
  await withPeers('mpark-restore', {}, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, P, ROWS);
    const it = await prepIt(p, { holdPaths: [P] });
    const r = await p.core.holds.hold(nr({ guard: 'markers', origin: 'daemon', blobs: stages(it.A.get(P)!.oid, await blob(p, t9([2, 'two'])), await blob(p, t9([2, 'team']))) }));
    const parked = await markersPark(p.core, it, r, HUMAN);
    const companion = parked.kind === 'PARKED' ? parked.companion! : '';
    const log = recordLog(p);
    // Task 12b (carry 4): the park's shrink of P (marker rows → A) is a tick-excluded `shrink` until a second stable snapshot, and a
    // hold operator never decides on a tick-excluded path (materializedFor): one more tick first.
    fx.advance(2_500);
    await prepIt(p, { materialize: false });
    fx.advance(2_500);
    const it2 = await prepIt(p, { holdPaths: [P] });
    assert.deepEqual(await restore(p.core, it2, companion, { humanEvidence: true, actor: 'human' }), { kind: 'RESTORED', markers: true });
    assert.deepEqual(await readWork(p, P), Buffer.from(ROWS), 'the disk is byte-equal to M');
    const c = p.core.holds.get(companion)!;
    assert.deepEqual([c.residence, c.state, c.guards.map((g) => g.name)], ['ON_DISK', 'ACTIVE', ['markers']]);
    assert.ok(log.lines.some((l) => l.code === 'RESTORE_MARKERS' && l.params['id'] === companion), 'RESTORE_MARKERS logged');
  });
});

test('settleMarkersParks completes or undoes an interrupted markers park by observation', T10, async () => {
  for (const kill of [{ point: 'registry.cas', nth: 2 }, { point: 'apply.group.phase2', nth: 1 }] as const) {
    await withPeers(`mpark-settle-${kill.point}`, {}, async (fx) => {
      const p = fx.peers[0]!;
      await writeWork(p, P, ROWS);
      const it = await prepIt(p, { holdPaths: [P] });
      const r = await p.core.holds.hold(nr({ guard: 'markers', origin: 'daemon', blobs: stages(it.A.get(P)!.oid, await blob(p, t9([2, 'two'])), await blob(p, t9([2, 'team']))) }));
      let hits = 0;
      setCrashHandler((name) => {
        if (name === kill.point && ++hits === kill.nth) throw new KilledAt(name);
      });
      await assert.rejects(markersPark(p.core, it, r, HUMAN), KilledAt);
      setCrashHandler(null);
      await gitIn(p, ['gc', '-q', '--prune=now']);
      await restartCore(p);
      await restart(p.core);
      const comps = p.core.holds.companionsOf(r);
      assert.equal(comps.length, 1, 'one companion, never lost or duplicated');
      const rec = p.core.holds.get(r)!;
      if (kill.point === 'registry.cas') {
        assert.deepEqual(await readWork(p, P), Buffer.from(ROWS), 'the rows are still on disk');
        assert.equal(comps[0]!.state, 'GONE', 'the companion ends GONE');
        assert.deepEqual([rec.residence, rec.guards.map((g) => g.name)], ['ON_DISK', ['markers']], 'r unchanged');
      } else {
        assert.deepEqual(await readWork(p, P), Buffer.from(T9), 'the disk is A');
        assert.equal(comps[0]!.state, 'PARKED', 'the companion keeps the rows');
        assert.deepEqual([rec.residence, rec.state, rec.guards.map((g) => g.name)], ['OFF_DISK', 'PARKED', []], 'commit 2 written: markers released, r OFF_DISK');
      }
      assert.deepEqual(p.core.holds.local().inflight, {}, 'the in-flight entry is cleared');
    });
  }
});

test('a completed markers park is never settled again: restoring r with conflicting rows, then a restart, keeps the companion holding M', T10, async () => {
  // Findings 1/5 shape (A): only a markers park whose in-flight entry is still set is settled; a completed one has none.
  await withPeers('mpark-completed-restart', {}, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, P, ROWS);
    const it = await prepIt(p, { holdPaths: [P] });
    const r = await p.core.holds.hold(nr({ guard: 'markers', origin: 'daemon', blobs: stages(it.A.get(P)!.oid, await blob(p, t9([2, 'two'])), await blob(p, t9([2, 'team']))) }));
    const parked = await markersPark(p.core, it, r, HUMAN);
    assert.equal(parked.kind, 'PARKED');
    const companion = parked.kind === 'PARKED' ? parked.companion! : '';
    const held = p.core.holds.get(companion)!;
    // The human edits row 2, then restores r (05 §3.4 item 3: "r stays restorable from its own blobs"): the merge conflicts, so r
    // is ON_DISK again carrying `markers`, with fresh rows on disk.
    await writeWork(p, P, t9([2, 'TWO again']));
    fx.advance(2_500);
    await prepIt(p, { materialize: false });
    fx.advance(1_500);   // the file is less than half of the marker file the stat cache last saw: a second tick 1 s later confirms it (R-25)
    const it2 = await prepIt(p, { holdPaths: [P] });
    assert.deepEqual(await restore(p.core, it2, r, { humanEvidence: true, actor: 'human' }), { kind: 'RESTORED', markers: true });
    const rowsNow = await readWork(p, P);
    const before = p.core.holds.get(r)!;
    assert.deepEqual([before.residence, before.guards.map((g) => g.name)], ['ON_DISK', ['markers']]);
    // A plain restart (stop/start, reboot) with the new rows still on disk.
    await restartCore(p);
    await restart(p.core);
    const c = p.core.holds.get(companion)!;
    assert.deepEqual([c.residence, c.state], ['OFF_DISK', 'PARKED'], 'the companion still holds M');
    assert.deepEqual(c.blobs, held.blobs);
    const after = p.core.holds.get(r)!;
    assert.deepEqual([after.residence, after.state, after.rev, after.guards.map((g) => g.name)], [before.residence, before.state, before.rev, ['markers']], 'r unchanged');
    assert.deepEqual(await readWork(p, P), rowsNow, 'the new rows are untouched');
  });
});

test('a markers park killed after its write whose disk then changed keeps the companion and r, and logs HOLD_DISK_CHANGED', T10, async () => {
  // Findings 1/5 shape (B): registry.cas hit 3 is commit 2's (the snap transition is a state commit): the disk is A, commit 2 is not
  // written, and the human edits the file while the daemon is down. Neither M nor A is on disk: nothing is guessed.
  await withPeers('mpark-settle-neither', {}, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, P, ROWS);
    const it = await prepIt(p, { holdPaths: [P] });
    const r = await p.core.holds.hold(nr({ guard: 'markers', origin: 'daemon', blobs: stages(it.A.get(P)!.oid, await blob(p, t9([2, 'two'])), await blob(p, t9([2, 'team']))) }));
    let hits = 0;
    setCrashHandler((name) => {
      if (name === 'registry.cas' && ++hits === 3) throw new KilledAt(name);
    });
    await assert.rejects(markersPark(p.core, it, r, HUMAN), KilledAt);
    setCrashHandler(null);
    assert.deepEqual(await readWork(p, P), Buffer.from(T9), 'the write landed (disk = A)');
    const EDIT = t9([5, 'five by the human']);
    await writeFile(workPath(p, P), EDIT);
    await gitIn(p, ['gc', '-q', '--prune=now']);
    await restartCore(p);
    const log = recordLog(p);
    await restart(p.core);
    const comps = p.core.holds.companionsOf(r);
    assert.equal(comps.length, 1);
    assert.deepEqual([comps[0]!.residence, comps[0]!.state], ['OFF_DISK', 'PARKED'], 'the companion keeps M');
    const h1 = 'h1' in comps[0]!.blobs ? comps[0]!.blobs.h1[P] : undefined;
    assert.equal((await p.core.repo.readBlob(h1 as Oid)).toString('utf8'), ROWS, 'M survives');
    const rec = p.core.holds.get(r)!;
    assert.deepEqual([rec.residence, rec.guards.map((g) => g.name)], ['ON_DISK', ['markers']], 'r left as it is');
    assert.deepEqual(p.core.holds.local().inflight, {}, 'the in-flight entry is cleared');
    assert.deepEqual(log.lines.filter((l) => l.code === 'HOLD_DISK_CHANGED').map((l) => l.params), [{ hid: r }], 'HOLD_DISK_CHANGED once');
    assert.deepEqual(await readWork(p, P), Buffer.from(EDIT), "the human's edit is untouched");
  });
});
