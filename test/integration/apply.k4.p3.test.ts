// K4 displacement (Plan 3 Task 5; 05-holds Table 2 row 1, glossary §9; ruling R3-22): a K4 record's displaced_by and
// peer_authors are set at its ON_DISK → OFF_DISK move after the verified TIP write — the op id of the Cowork-Writer trailer of the
// newest live commit that changed p, and that writer's peer id — in the same rev; ApplyReport.changedA names the paths whose A
// this apply changed. Two peers' worth of history on real file:// clones (the teammate through pushTeamChange).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sep } from 'node:path';
import { parseOpId } from '../../src/board/ids.js';
import { applyStep } from '../../src/engine/apply.js';
import { publishStep } from '../../src/engine/publish.js';
import { restart } from '../../src/engine/restart.js';
import type { Oid } from '../../src/git/oid.js';
import type { RebaseChange } from '../../src/holds/changesets.js';
import { makeGuard, type HoldRecord } from '../../src/holds/record.js';
import { KilledAt, setCrashHandler } from '../../src/ports/crashpoint.js';
import { readWork, workPath, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { blob, nr, P, pair, plantRecord, prepIt, recordLog, remoteCoworkBlobs, stages, withPeers } from '../helpers/holdOpsFixture.js';
import { t9 } from '../helpers/maskFixture.js';
import { buf, captureReady, editAndCapture, prep } from '../helpers/publishHelpers.js';
import { restartCore } from '../helpers/startFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

/** The Cowork-Writer op id of a live commit and its peer. */
async function writerOf(p: PeerFixture, live: Oid): Promise<{ op: string; peer: string }> {
  const t = (await p.core.repo.readCommit(live)).trailers.find((x) => x.key === 'Cowork-Writer');
  assert.ok(t !== undefined, 'the live commit carries Cowork-Writer');
  const id = parseOpId(t.value);
  assert.ok(id !== null);
  return { op: t.value, peer: id.peer };
}

const conflictRecords = (p: PeerFixture): HoldRecord[] => p.core.holds.all().filter((h) => h.guards.some((g) => g.name === 'conflict'));

test('an apply-side K4 record gets displaced_by and peer_authors at its OFF_DISK move', T10, async () => {
  await withPeers('k4-apply', {}, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, P, t9([2, 'two local']));
    await prepIt(p);   // the local edit is seen
    const { live } = await fx.pushTeamChange({ [P]: buf(t9([2, 'two team'])) });
    let atRename: HoldRecord | undefined;
    p.fs.interpose('rename', `src${sep}t9.txt`, async () => {
      atRename = conflictRecords(p)[0];
    });
    fx.advance(10_000);
    const it = await prepIt(p, { forceFetch: true });
    const team = await writerOf(p, live);   // fetched
    const r = await applyStep(p.core, it);
    assert.ok(r.written.includes(P), JSON.stringify(r));
    assert.ok(r.changedA.includes(P), 'changedA names the written path');
    assert.equal(r.records.length, 1);
    assert.ok(atRename !== undefined && atRename.residence === 'ON_DISK' && atRename.displaced_by === null, 'ON_DISK with no displacement before the write');
    const rec = p.core.holds.get(r.records[0]!)!;
    assert.deepEqual([rec.residence, rec.state], ['OFF_DISK', 'CONFLICTED']);
    assert.equal(rec.displaced_by, team.op, "the newest live commit in (LA_C, TIP] that changed p: the teammate's op id");
    assert.deepEqual(rec.peer_authors, [team.peer]);
    assert.equal(rec.rev, atRename.rev + 1, 'OFF_DISK, displaced_by and peer_authors in one rev');
    assert.deepEqual(await readWork(p, P), buf(t9([2, 'two team'])));
  });
});

test('a publish-side K4 record gets them at the next apply that writes TIP', T10, async () => {
  await withPeers('k4-publish', {}, async (fx) => {
    const p = fx.peers[0]!;
    await editAndCapture(fx, p, { [P]: t9([2, 'two local']), 'src/other.txt': 'other, local\n' });
    const { live } = await fx.pushTeamChange({ [P]: buf(t9([2, 'two team'])) });
    await prep(p);
    const team = await writerOf(p, live);   // fetched
    fx.advance(6_000);
    const r = await publishStep(p.core, await prep(p));
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    assert.equal(r.records.length, 1);
    const id = r.records[0]!;
    const before = p.core.holds.get(id)!;
    assert.deepEqual([before.residence, before.state, before.displaced_by, before.peer_authors], ['ON_DISK', 'CONFLICTED', null, []], 'publish side: ON_DISK, nothing displaced yet');
    assert.deepEqual(await readWork(p, P), buf(t9([2, 'two local'])), 'LOCAL stays on disk until the apply');
    // P1's next apply writes TIP[p]: the same record moves OFF_DISK with the two fields in that rev.
    fx.advance(10_000);
    const ar = await applyStep(p.core, await prepIt(p, { forceFetch: true }));
    assert.ok(ar.written.includes(P), JSON.stringify(ar));
    assert.deepEqual(ar.records, [id]);
    const rec = p.core.holds.get(id)!;
    assert.deepEqual([rec.residence, rec.state], ['OFF_DISK', 'CONFLICTED']);
    assert.equal(rec.displaced_by, team.op);
    assert.deepEqual(rec.peer_authors, [team.peer]);
    assert.deepEqual(await readWork(p, P), buf(t9([2, 'two team'])));
  });
});

// EF4 E4-1 (ruling R3-EF4-7; 05-holds §3.4 items 3–4, DAT-46, ENG-41 (j); class converge-disk-not-tstar, seeds 21 and 77): an apply
// TAKE_TIP on a path whose ON_DISK record r carries `markers` never refreshes r from disk. In one registry commit a local_only marker
// companion (PATCH, h0 = A[p], h1 = S_disk[p], OFF_DISK PARKED, companionOf r) keeps the displaced marker file, and r goes CONFLICTED
// with `conflict` and marker-free stages (A[p], r's held side, TIP[p]); after the verified TIP write r goes OFF_DISK and `markers`
// releases, unless the written bytes keep a restore-marker row (TIP's blob holds one, R3-FF3-B3), when r stays ON_DISK with `markers`
// (rulings R3-SPEC-3, R3-SPEC-6; the tests below). Before the fix the HLD-07 attach copied S_disk (its restore-marker rows) into r's s2,
// ENG-41 (j) refused every later Bnew and the peer never published again.

/** A conflicted RESTORE's result on disk: restore-marker rows around row 2 (as markersPark.test.ts). */
const ROWS = '1\n<<<<<<< cowork:disk\nTWO\n||||||| cowork:base\n2\n=======\ntwo\n>>>>>>> cowork:held\n3\n4\n5\n6\n7\n8\n9\n';
/** A restore-marker row (DAT-46). */
const MARKER_ROW = /^(<{7}|\|{7}|>{7}) cowork:/m;

/** Every blob of a mirrored (not local_only) record that holds a restore-marker row, as `<id> rev <n> <side>[<path>]`. */
async function markerOffenders(p: PeerFixture): Promise<string[]> {
  const out: string[] = [];
  for (const h of p.core.holds.all()) {
    if (h.local_only) continue;
    for (const [side, m] of Object.entries(h.blobs)) {
      for (const [path, oid] of Object.entries(m as Record<string, string>)) {
        if (!/^[0-9a-f]{40}/.test(oid)) continue;
        if (MARKER_ROW.test((await p.core.repo.readBlob(oid as Oid)).toString('utf8'))) out.push(`${h.id} rev ${h.rev} ${side}[${path}]`);
      }
    }
  }
  return out;
}

/** r: a K4 record restored over an overlapping edit — ON_DISK ACTIVE, guard `markers`, the restore-marker rows on disk. */
async function markersRecord(p: PeerFixture): Promise<{ r: string; a: Oid; held: Oid }> {
  await writeWork(p, P, ROWS);
  const it0 = await prepIt(p, { holdPaths: [P] });
  const a = it0.A.get(P)!.oid;
  const held = await blob(p, t9([2, 'two']));
  const r = await p.core.holds.hold(nr({ guard: 'markers', origin: 'daemon', blobs: stages(a, held, await blob(p, t9([2, 'team']))) }));
  return { r, a, held };
}

test('an apply-side K4 onto an ON_DISK markers record keeps the marker file in a local_only companion, never in a mirrored blob, and the peer publishes again', T10, async () => {
  await withPeers('k4-markers', {}, async (fx) => {
    const p = fx.peers[0]!;
    const { r, a, held } = await markersRecord(p);
    // A teammate changes the same row: the apply's merge of (A, S_disk, TIP) conflicts on P — TAKE_TIP and a K4 (HLD-07).
    const { live } = await fx.pushTeamChange({ [P]: buf(t9([2, 'TEAM2'])) });
    let atRename: { r: HoldRecord; companions: HoldRecord[] } | undefined;
    p.fs.interpose('rename', `src${sep}t9.txt`, async () => {
      atRename ??= { r: p.core.holds.get(r)!, companions: [...p.core.holds.companionsOf(r)] };
    });
    fx.advance(10_000);
    const it = await prepIt(p, { forceFetch: true });
    const team = await writerOf(p, live);
    const head0 = p.core.holds.head();
    const ar = await applyStep(p.core, it);
    const tip = it.tipMap.get(P)!.oid;
    const rec = p.core.holds.get(r)!;
    assert.ok(ar.written.includes(P), JSON.stringify(ar));
    assert.deepEqual(ar.records, [r], 'the K4 is r (one change, one id)');
    // Before the TIP write: the companion holds the marker file and r is ON_DISK CONFLICTED with marker-free stages.
    assert.ok(atRename !== undefined, 'the writer moved P');
    assert.deepEqual([atRename.r.residence, atRename.r.state, atRename.r.guards.map((g) => g.name)], ['ON_DISK', 'CONFLICTED', ['markers', 'conflict']]);
    assert.deepEqual(atRename.r.blobs, stages(a, held, tip), 'r keeps its held side: (A[p], r\'s held side, TIP[p])');
    assert.equal(atRename.companions.length, 1, 'the companion is committed before the write');
    // After the verified write: r OFF_DISK CONFLICTED, `markers` released, R3-22's fields.
    assert.deepEqual([rec.residence, rec.state, rec.guards.map((g) => g.name)], ['OFF_DISK', 'CONFLICTED', ['conflict']]);
    assert.deepEqual(rec.blobs, stages(a, held, tip));
    assert.equal(rec.displaced_by, team.op);
    assert.deepEqual(rec.peer_authors, [team.peer]);
    const companions = p.core.holds.companionsOf(r);
    assert.equal(companions.length, 1);
    const c = companions[0]!;
    assert.deepEqual([c.kind, c.residence, c.state, c.local_only, c.guards.length, c.displaced_by], ['PATCH', 'OFF_DISK', 'PARKED', true, 0, null]);
    assert.deepEqual(c.blobs, pair(a, await blob(p, ROWS)), 'the companion holds the marker file byte-exact over A[p]');
    assert.equal(c.origin, 'daemon');
    const chain = await p.core.repo.firstParents(p.core.holds.head()!, head0, 100);
    assert.equal(chain.length, 2, 'one commit for the companion and r, one for the OFF_DISK move');
    assert.deepEqual(await readWork(p, P), buf(t9([2, 'TEAM2'])));
    // 05 §3.4 items 3–4, DAT-46: no record that is mirrored (not local_only) holds a blob with a restore-marker row.
    assert.deepEqual(await markerOffenders(p), [], 'a mirrored record holds a restore-marker blob');
    // The peer's next publish (an unrelated local edit) lands instead of aborting with ENG-41 (j).
    await editAndCapture(fx, p, { 'src/other.txt': 'other, local\n' });
    fx.advance(6_000);
    const pr = await publishStep(p.core, await prep(p));
    assert.equal(pr.outcome, 'landed', JSON.stringify({ outcome: pr.outcome, why: pr.why }));
    for (const b of await remoteCoworkBlobs(fx)) assert.ok(!MARKER_ROW.test(b.toString('utf8')), 'a restore-marker row left this PC');
  });
});

test('an apply-side K4 onto a markers record whose TIP write does not happen ends the companion GONE and keeps r ON_DISK with marker-free stages', T10, async () => {
  await withPeers('k4-markers-locked', {}, async (fx) => {
    const p = fx.peers[0]!;
    const { r, a, held } = await markersRecord(p);
    await fx.pushTeamChange({ [P]: buf(t9([2, 'TEAM2'])) });
    fx.advance(10_000);
    const it = await prepIt(p, { forceFetch: true });
    const tip = it.tipMap.get(P)!.oid;
    // A share-read holder (Excel-like) refuses the writer's rename: the write group defers `locked`.
    const release = p.fs.holdLock(workPath(p, P), 'share-read');
    let ar;
    try {
      ar = await applyStep(p.core, it);
    } finally {
      release();
    }
    assert.equal(ar.deferred.get(P), 'locked', JSON.stringify([...ar.deferred]));
    assert.deepEqual(await readWork(p, P), buf(ROWS), 'nothing written');
    const rec = p.core.holds.get(r)!;
    assert.deepEqual([rec.residence, rec.state, rec.guards.map((g) => g.name)], ['ON_DISK', 'CONFLICTED', ['markers', 'conflict']]);
    assert.deepEqual(rec.blobs, stages(a, held, tip));
    const companions = p.core.holds.companionsOf(r);
    assert.deepEqual(companions.map((c) => c.state), ['GONE'], 'the redundant companion ends GONE (its bytes are still on r\'s disk; R3-15\'s pattern)');
    assert.deepEqual(await markerOffenders(p), []);
    // The next permitted apply, unlocked, writes TIP: r OFF_DISK without `markers`, one live companion holding the marker file.
    fx.advance(10_000);
    const ar2 = await applyStep(p.core, await prepIt(p, { forceFetch: true }));
    assert.ok(ar2.written.includes(P), JSON.stringify(ar2));
    const rec2 = p.core.holds.get(r)!;
    assert.deepEqual([rec2.residence, rec2.state, rec2.guards.map((g) => g.name)], ['OFF_DISK', 'CONFLICTED', ['conflict']]);
    assert.deepEqual(rec2.blobs, stages(a, held, tip));
    const live = p.core.holds.companionsOf(r).filter((c) => c.state !== 'GONE');
    assert.equal(live.length, 1);
    assert.deepEqual([live[0]!.residence, live[0]!.state, live[0]!.local_only], ['OFF_DISK', 'PARKED', true]);
    assert.deepEqual(live[0]!.blobs, pair(a, await blob(p, ROWS)));
    assert.deepEqual(await markerOffenders(p), []);
  });
});

// Ruling R3-SPEC-3 (HLD-08 vs R3-FF3-B3, fail closed; spec batch 1 review, HLD-08 Minor): the apply checks restore-marker rows on every
// written path, this apply's own TAKE_TIP paths included, as the restart decision (resolveWriteIntent) does. A TIP file can hold a
// '<<<<<<< cowork:' row (a teammate's git commit, R3-FF3-B3), so a K4 TAKE_TIP onto a markers record whose TIP blob keeps such a row leaves
// the record ON_DISK with `markers` (k4OffDiskPatch would release it on the premise that the disk then holds none, DAT-46). Before, the
// apply skipped the check on its TAKE_TIP paths and moved such a record OFF_DISK, `markers` released, while the disk held the row — and a
// restart deciding the same crashed apply kept it ON_DISK. A marker-free TIP blob still moves it OFF_DISK and releases `markers`.
test('R3-SPEC-3: an apply-side K4 TAKE_TIP onto an ON_DISK markers record whose TIP blob holds a restore-marker row leaves the record ON_DISK with `markers`; a marker-free TIP blob moves it OFF_DISK, `markers` released', T10, async () => {
  for (const tipRow of [true, false]) {
    await withPeers(`k4-markers-tiprow-${tipRow ? 'row' : 'clean'}`, {}, async (fx) => {
      const p = fx.peers[0]!;
      const { r, a, held } = await markersRecord(p);
      // Row 2 conflicts with the disk's rows (TAKE_TIP, a K4 onto r); row 8 of the teammate's file is a restore-marker row or not.
      const team = tipRow ? t9([2, 'TEAM2'], [8, '<<<<<<< cowork:team']) : t9([2, 'TEAM2']);
      await fx.pushTeamChange({ [P]: buf(team) });
      fx.advance(10_000);
      const it = await prepIt(p, { forceFetch: true });
      const tip = it.tipMap.get(P)!.oid;
      const ar = await applyStep(p.core, it);
      assert.ok(ar.written.includes(P), JSON.stringify(ar));
      assert.deepEqual(ar.records, [r], 'the K4 is r (one change, one id)');
      assert.equal((await readWork(p, P))!.toString('utf8'), team, 'TIP[p] is on disk');
      const rec = p.core.holds.get(r)!;
      assert.deepEqual([rec.residence, rec.state, rec.guards.map((g) => g.name)], tipRow ? ['ON_DISK', 'CONFLICTED', ['markers', 'conflict']] : ['OFF_DISK', 'CONFLICTED', ['conflict']],
        tipRow ? 'the written bytes keep a restore-marker row: r stays ON_DISK with `markers` (never unmasked)' : 'no row written: r OFF_DISK, `markers` released');
      assert.deepEqual(rec.blobs, stages(a, held, tip), 'r keeps its marker-free held side');
      const live = p.core.holds.companionsOf(r).filter((c) => c.state !== 'GONE');
      assert.equal(live.length, 1, 'the companion keeping the displaced marker file stays live');
      assert.deepEqual([live[0]!.residence, live[0]!.state, live[0]!.local_only], ['OFF_DISK', 'PARKED', true]);
      assert.deepEqual(live[0]!.blobs, pair(a, await blob(p, ROWS)));
    });
  }
});

/** Throws KilledAt at the first hit of `point` (a dead process: the core is abandoned). */
async function killedAt<T>(point: string, fn: () => Promise<T>): Promise<void> {
  let hits = 0;
  setCrashHandler((name) => {
    if (name === point && ++hits === 1) throw new KilledAt(name);
  });
  try {
    await assert.rejects(fn(), (e: unknown) => e instanceof KilledAt && e.point === point, `killed at ${point}`);
  } finally {
    setCrashHandler(null);
  }
}

/**
 * R3-SPEC-3's row variant: a K4 TAKE_TIP onto the ON_DISK markers record r whose TIP blob keeps a restore-marker row (row 8 of the
 * teammate's file). `kill`: the apply dies at apply.group.phase2 — after the write group's verified write, before the post-write move and
 * the state update — so the restart's decision completes it.
 */
async function tipRowK4(fx: CoreFixture, p: PeerFixture, kill: boolean): Promise<{ r: string; a: Oid; held: Oid; tip: Oid; team: string }> {
  const { r, a, held } = await markersRecord(p);
  const team = t9([2, 'TEAM2'], [8, '<<<<<<< cowork:team']);
  await fx.pushTeamChange({ [P]: buf(team) });
  fx.advance(10_000);
  const it = await prepIt(p, { forceFetch: true });
  const tip = it.tipMap.get(P)!.oid;
  if (kill) await killedAt('apply.group.phase2', () => applyStep(p.core, it));
  else assert.ok((await applyStep(p.core, it)).written.includes(P));
  assert.equal((await readWork(p, P))!.toString('utf8'), team, 'TIP[p] (with its restore-marker row) is on disk');
  return { r, a, held, tip, team };
}

// Ruling R3-SPEC-6 (R3-SPEC-3 completed; Plan 3 final review newBreakage): settleHoldOps' K4 completion — the restart's move of an ON_DISK
// CONFLICTED `conflict` record whose disk DISK_EQ s3 with A[p] = s3 — applies the same restore-marker row check before k4OffDiskPatch: a
// record carrying `markers` whose s3 blob holds a row stays ON_DISK with `markers`. Before, the next daemon start (or the restart after a
// crashed apply, right after its own decision kept r) released `markers` and moved r OFF_DISK while the disk still held the row, undoing
// R3-SPEC-3 at the first restart.
test('R3-SPEC-6: a markers record kept ON_DISK by a TAKE_TIP whose TIP blob holds a restore-marker row stays ON_DISK with `markers` across the next restart, and across the restart of the same apply killed after its verified write', T10, async () => {
  for (const kill of [false, true]) {
    await withPeers(`k4-markers-tiprow-restart-${kill ? 'crash' : 'plain'}`, {}, async (fx) => {
      const p = fx.peers[0]!;
      const { r, a, team } = await tipRowK4(fx, p, kill);
      const st = (): unknown[] => {
        const x = p.core.holds.get(r)!;
        return [x.residence, x.state, x.guards.map((g) => g.name), x.displaced_by];
      };
      assert.deepEqual(st(), ['ON_DISK', 'CONFLICTED', ['markers', 'conflict'], null], kill ? 'the crashed apply never moved r' : 'the apply keeps r ON_DISK (R3-SPEC-3)');
      fx.advance(2_000);
      await restartCore(p);
      const rep = await restart(p.core);
      assert.equal(rep.intent, kill ? 'apply' : 'none');
      assert.equal((await readWork(p, P))!.toString('utf8'), team, 'the disk still holds the restore-marker row');
      assert.deepEqual(st(), ['ON_DISK', 'CONFLICTED', ['markers', 'conflict'], null], 'after the restart r stays ON_DISK with `markers` (never unmasked), no displacement');
      const live = p.core.holds.companionsOf(r).filter((c) => c.state !== 'GONE');
      assert.equal(live.length, 1, 'the companion keeping the displaced marker file stays live');
      assert.deepEqual([live[0]!.residence, live[0]!.state, live[0]!.local_only], ['OFF_DISK', 'PARKED', true]);
      assert.deepEqual(live[0]!.blobs, pair(a, await blob(p, ROWS)));
    });
  }
});

/** Every RebaseChange handed to HLD-41 (ChangeSets.rebase) by the peer's current core from now on. */
function rebaseChanges(p: PeerFixture): RebaseChange[] {
  const seen: RebaseChange[] = [];
  const cs = p.core.cs;
  const rebase = cs.rebase.bind(cs);
  cs.rebase = async (repo, changes, scratch) => {
    seen.push(...changes);
    return rebase(repo, changes, scratch);
  };
  return seen;
}

// Ruling R3-SPEC-7 (the count of a kept TAKE_TIP path; Plan 3 final spec review Minor): the restart's decision of an interrupted apply
// counts a TAKE_TIP path whose `markers` records all stay ON_DISK (the written TIP blob keeps a restore-marker row) `take_tip` for HLD-41,
// as the live apply does (`how`), telling the TAKE_TIP from the journaled entry M_disk[p] being TIP[p] itself. Before, it counted `clean`
// with R[p] := M_disk[p], so a ready pair captured from the marker file stayed ready after a crash (rebased onto TIP[p]) where the
// uncrashed apply cancels it (CS_READY_CANCELLED) — readiness differed with and without a crash.
test('R3-SPEC-7: a TAKE_TIP onto a markers record whose TIP blob holds a restore-marker row counts take_tip for HLD-41 at the restart decision of the apply killed after its verified write, as the uncrashed apply counts it — the ready pair over p is cancelled either way', T10, async () => {
  for (const kill of [false, true]) {
    await withPeers(`k4-markers-tiprow-count-${kill ? 'crash' : 'plain'}`, {}, async (fx) => {
      const p = fx.peers[0]!;
      const log = recordLog(p);
      // The marker file on disk is captured into a ready pair (R[p] = the marker file; MASK withholds p at publish while r carries
      // `markers`), then a teammate's TAKE_TIP onto r writes a TIP blob that keeps a restore-marker row.
      const { r } = await markersRecord(p);
      await prep(p);
      fx.advance(20_000);
      const cap = await captureReady(p, await prep(p, true));
      assert.equal((await p.core.repo.readTreeMap(cap.R)).get(P)?.oid, await blob(p, ROWS), 'the ready pair holds the marker file at p');
      const team = t9([2, 'TEAM2'], [8, '<<<<<<< cowork:team']);
      await fx.pushTeamChange({ [P]: buf(team) });
      fx.advance(10_000);
      const it = await prepIt(p, { forceFetch: true });
      let changes: RebaseChange[];
      if (kill) {
        await killedAt('apply.group.phase2', () => applyStep(p.core, it));
        assert.ok(p.core.cs.ready().some((x) => x.csId === cap.csId), 'the crashed apply decided nothing');
        await restartCore(p);
        changes = rebaseChanges(p);
        assert.equal((await restart(p.core)).intent, 'apply');
      } else {
        changes = rebaseChanges(p);
        assert.ok((await applyStep(p.core, it)).written.includes(P));
      }
      assert.equal((await readWork(p, P))!.toString('utf8'), team, 'TIP[p] (with its restore-marker row) is on disk');
      const rec = p.core.holds.get(r)!;
      assert.deepEqual([rec.residence, rec.state, rec.guards.map((g) => g.name)], ['ON_DISK', 'CONFLICTED', ['markers', 'conflict']], 'r stays ON_DISK with `markers`');
      assert.equal(p.core.cs.ready().some((x) => x.csId === cap.csId), false, 'the ready pair over p is no longer ready');
      assert.deepEqual(changes.filter((c) => c.path === P).map((c) => [c.written, c.writtenEntry]), [['take_tip', null]], 'HLD-41 counts the kept TAKE_TIP path take_tip, with or without a crash');
      assert.ok(log.lines.some((l) => l.code === 'CS_READY_CANCELLED' && l.params['cs_id'] === cap.csId), 'CS_READY_CANCELLED for its CS');
    });
  }
});

// EF4 round 2 K-1 (ruling R3-EF4-15, R3-EF4-7 widened; r1 rereview E4 newBreakage[0]): the companion route applies whenever a non-terminal
// ON_DISK record over p carries `markers` or S_disk[p] holds a restore-marker row, whatever the holder's path count or guards. Before,
// only an ON_DISK PATCH/PIN over exactly [p] carrying `markers` and no guard outside Table 3 took it; a K4 at a path of a two-path
// restored markers record, of a markers record carrying a newer daemon's guard or of a restored marker companion fell through to plain
// hold(), whose K4 record took S_disk[p] — the restore-marker file — as s2: mirrored under held/, ENG-41 (j) refused every later Bnew.
// Now the K4 record takes marker-free stages (A[p], a marker-free held side of p, TIP[p]) and a local_only marker companion of it keeps
// the displaced marker file.

const U = 'src/u9.txt';

/**
 * Every blob of a record that is not a marker companion and holds a restore-marker row, as `<id> rev <n> <side>[<path>]`. Stricter than
 * markerOffenders: a record's local_only is recomputed at every rev (R3-12), so one that is local_only now only because another record
 * makes p LOCAL_ONLY (a restored companion) is mirrored once that record ends — only a marker companion stays local_only for good.
 */
async function markerHolders(p: PeerFixture): Promise<string[]> {
  const out: string[] = [];
  for (const h of p.core.holds.all()) {
    if (p.core.holds.isCompanion(h.id)) continue;
    for (const [side, m] of Object.entries(h.blobs)) {
      for (const [path, oid] of Object.entries(m as Record<string, string>)) {
        if (!/^[0-9a-f]{40}/.test(oid)) continue;
        if (MARKER_ROW.test((await p.core.repo.readBlob(oid as Oid)).toString('utf8'))) out.push(`${h.id} rev ${h.rev} ${side}[${path}]`);
      }
    }
  }
  return out;
}

/** The teammate changes P's row 2 and the apply TAKE_TIPs P over the marker file; the apply report and TIP[P]. */
async function k4OverRows(fx: CoreFixture, p: PeerFixture): Promise<{ ar: Awaited<ReturnType<typeof applyStep>>; tip: Oid }> {
  await fx.pushTeamChange({ [P]: buf(t9([2, 'TEAM2'])) });
  fx.advance(10_000);
  const it = await prepIt(p, { forceFetch: true });
  const tip = it.tipMap.get(P)!.oid;
  const ar = await applyStep(p.core, it);
  assert.ok(ar.written.includes(P), JSON.stringify(ar));
  assert.deepEqual(await readWork(p, P), buf(t9([2, 'TEAM2'])));
  return { ar, tip };
}

/** The K4 record of P is OFF_DISK CONFLICTED [conflict] with marker-free stages, and its one live marker companion holds the marker file. */
async function assertCompanionRoute(p: PeerFixture, k4: string, want: ReturnType<typeof stages>, a: Oid): Promise<void> {
  const k = p.core.holds.get(k4)!;
  assert.deepEqual([k.kind, k.residence, k.state, k.guards.map((g) => g.name)], ['PATCH', 'OFF_DISK', 'CONFLICTED', ['conflict']]);
  assert.deepEqual(k.blobs, want, 'the K4 record takes marker-free stages');
  const live = p.core.holds.companionsOf(k4).filter((c) => c.state !== 'GONE' && c.residence === 'OFF_DISK');
  assert.equal(live.length, 1, 'one marker companion of the K4 record keeps the marker file');
  const c = live[0]!;
  assert.deepEqual([c.kind, c.residence, c.state, c.local_only, c.guards.length, c.displaced_by], ['PATCH', 'OFF_DISK', 'PARKED', true, 0, null]);
  assert.deepEqual(c.blobs, pair(a, await blob(p, ROWS)), 'the companion holds the marker file byte-exact over A[p]');
  assert.deepEqual(await markerHolders(p), [], 'a record other than a marker companion holds a restore-marker blob');
  assert.deepEqual(await markerOffenders(p), [], 'a mirrored record holds a restore-marker blob');
}

/** The peer's next publish (an unrelated local edit) lands and no restore-marker row left this PC. */
async function publishLands(fx: CoreFixture, p: PeerFixture): Promise<void> {
  await editAndCapture(fx, p, { 'src/other.txt': 'other, local\n' });
  fx.advance(6_000);
  const pr = await publishStep(p.core, await prep(p));
  assert.equal(pr.outcome, 'landed', JSON.stringify({ outcome: pr.outcome, why: pr.why }));
  for (const b of await remoteCoworkBlobs(fx)) assert.ok(!MARKER_ROW.test(b.toString('utf8')), 'a restore-marker row left this PC');
}

test('K-1: a K4 at a path of a two-path restored markers PATCH keeps the marker file in a companion and takes the record\'s held side of p', T10, async () => {
  await withPeers('k4-markers-2path', {}, async (fx) => {
    const p = fx.peers[0]!;
    const HELD_U = t9([3, 'held u']);
    await writeWork(p, P, ROWS);   // the conflicted half of the restore
    await writeWork(p, U, HELD_U);   // the clean half
    const it0 = await prepIt(p, { holdPaths: [P, U] });
    const a = it0.A.get(P)!.oid;
    const heldP = await blob(p, t9([2, 'two']));
    const r = await p.core.holds.hold(nr({
      guard: 'markers', origin: 'daemon', paths: [P, U], blobs: { h0: { [P]: a, [U]: it0.A.get(U)!.oid }, h1: { [P]: heldP, [U]: await blob(p, HELD_U) } },
    }));
    const r0 = p.core.holds.get(r)!;
    const { ar, tip } = await k4OverRows(fx, p);
    assert.equal(ar.records.length, 1);
    assert.notEqual(ar.records[0], r, 'a new K4 record over [P] (r spans two paths: no HLD-07 target)');
    await assertCompanionRoute(p, ar.records[0]!, stages(a, heldP, tip), a);
    assert.deepEqual(p.core.holds.get(r), r0, 'the two-path markers record is untouched');
    await publishLands(fx, p);
  });
});

test('K-1: a K4 at the path of a markers record carrying a guard outside Table 3 never transitions it and keeps the marker file in a companion', T10, async () => {
  await withPeers('k4-markers-unknown', {}, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, P, ROWS);
    const it0 = await prepIt(p, { holdPaths: [P] });
    const a = it0.A.get(P)!.oid;
    const held = await blob(p, t9([2, 'two']));
    const unk = '01ARZ3NDEKTSV4RRFFQ69G5FZZ';
    await plantRecord(p, {
      id: unk, rev: 1, owner: p.core.peerId, kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', offer: 'none', declines: 0, displaced_by: null,
      paths: [P], blobs: pair(a, held), guards: [makeGuard('markers'), { name: 'future-guard', class: 'DECISION', owner: 'HLD' }], origin: 'human',
      cs_ids: [], peer_authors: [], local_only: false, age_anchor: { since_rev: 1, anchor_wall_ms: 0, mono_accum_ms: 0 }, proto: 1,
    });
    const u0 = p.core.holds.get(unk)!;
    const { ar, tip } = await k4OverRows(fx, p);
    assert.equal(ar.records.length, 1);
    assert.notEqual(ar.records[0], unk, 'never the record carrying future-guard (HLD-05)');
    await assertCompanionRoute(p, ar.records[0]!, stages(a, held, tip), a);
    assert.deepEqual(p.core.holds.get(unk), u0, 'the record carrying future-guard is untouched');
    await publishLands(fx, p);
  });
});

test('K-1: a K4 over a marker file that no record carrying `markers` holds keeps the file in a companion; the K4 takes A[p] as its local side', T10, async () => {
  await withPeers('k4-markers-norecord', {}, async (fx) => {
    const p = fx.peers[0]!;
    // Restore-marker rows on disk with no `markers` record (a stale save of an editor buffer that held a resolved restore's rows).
    await writeWork(p, P, ROWS);
    const it0 = await prepIt(p, { holdPaths: [P] });
    const a = it0.A.get(P)!.oid;
    const { ar, tip } = await k4OverRows(fx, p);
    assert.equal(ar.records.length, 1);
    await assertCompanionRoute(p, ar.records[0]!, stages(a, a, tip), a);
    await publishLands(fx, p);
  });
});

// EF4 round 2 K-2 (ruling R3-EF4-15; r1 rereview E4 newBreakage[1]; HLD-08 "the K4 local side, once ENG- verified the TIP write"): a K4
// onto a single-path ON_DISK PIN carrying `markers` makes the PIN CONFLICTED with marker-free stages; after the verified TIP write it goes
// OFF_DISK and `markers` releases like a PATCH target. Before, the post-write move (onDiskConflictRecords) took PATCH records only: the PIN
// stayed ON_DISK CONFLICTED [markers, conflict] and MASK withheld p whole until a restart's settlement moved it.
test('K-2: a K4 onto an ON_DISK markers PIN moves it OFF_DISK after the verified TIP write, `markers` released', T10, async () => {
  await withPeers('k4-markers-pin', {}, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, P, ROWS);
    const it0 = await prepIt(p, { holdPaths: [P] });
    const a = it0.A.get(P)!.oid;
    const held = await blob(p, t9([2, 'two']));
    const r = await p.core.holds.hold(nr({ kind: 'PIN', guard: 'markers', origin: 'daemon', blobs: pair(a, held) }));
    const { live } = await fx.pushTeamChange({ [P]: buf(t9([2, 'TEAM2'])) });
    fx.advance(10_000);
    const it = await prepIt(p, { forceFetch: true });
    const team = await writerOf(p, live);
    const tip = it.tipMap.get(P)!.oid;
    const ar = await applyStep(p.core, it);
    assert.ok(ar.written.includes(P), JSON.stringify(ar));
    assert.deepEqual(ar.records, [r], 'the K4 is the PIN (HLD-07)');
    const rec = p.core.holds.get(r)!;
    assert.deepEqual([rec.kind, rec.residence, rec.state, rec.guards.map((g) => g.name)], ['PIN', 'OFF_DISK', 'CONFLICTED', ['conflict']]);
    assert.deepEqual(rec.blobs, stages(a, held, tip));
    assert.equal(rec.displaced_by, team.op);
    assert.deepEqual(rec.peer_authors, [team.peer]);
    const companions = p.core.holds.companionsOf(r);
    assert.equal(companions.length, 1);
    assert.deepEqual(companions[0]!.blobs, pair(a, await blob(p, ROWS)));
    assert.deepEqual(await markerOffenders(p), []);
  });
});

// EF4 round 2 K-3 (ruling R3-EF4-15; r1 rereview E4 newBreakage[2]): a writer rejection (not a crash, not a deferral) after the companion
// commit is rolled back in-process (Task 10 caller contract) and the marker file is still on r's disk: the companion is redundant and ends
// GONE by observation (DISK_EQ its h1, R3-15's pattern), so the next apply's K4 makes the one companion that keeps the displaced file.
// Before, the companion stayed live and the retry made a second one with the same bytes.
test('K-3: a writer rejection after the companion commit ends the companion GONE, and the retry keeps one live companion', T10, async () => {
  await withPeers('k4-markers-reject', {}, async (fx) => {
    const p = fx.peers[0]!;
    const { r, a, held } = await markersRecord(p);
    await fx.pushTeamChange({ [P]: buf(t9([2, 'TEAM2'])) });
    fx.advance(10_000);
    const it = await prepIt(p, { forceFetch: true });
    const tip = it.tipMap.get(P)!.oid;
    // The writer's rename of P to its .old fails with an error that is no errno (asDefer: not a deferral): applyGroups rejects.
    p.fs.interpose('rename', `src${sep}t9.txt`, async () => {
      throw new Error('injected writer failure');
    });
    await assert.rejects(applyStep(p.core, it), /injected writer failure/);
    assert.deepEqual(await readWork(p, P), buf(ROWS), 'rolled back: the marker file is on disk');
    const rec = p.core.holds.get(r)!;
    assert.deepEqual([rec.residence, rec.state, rec.guards.map((g) => g.name)], ['ON_DISK', 'CONFLICTED', ['markers', 'conflict']]);
    assert.deepEqual(rec.blobs, stages(a, held, tip));
    assert.deepEqual(p.core.holds.companionsOf(r).map((c) => c.state), ['GONE'], 'the redundant companion ends GONE (its bytes are on r\'s disk)');
    assert.deepEqual(await markerOffenders(p), []);
    // The retry writes TIP: one live companion keeps the marker file.
    fx.advance(10_000);
    const ar = await applyStep(p.core, await prepIt(p, { forceFetch: true }));
    assert.ok(ar.written.includes(P), JSON.stringify(ar));
    assert.deepEqual([p.core.holds.get(r)!.residence, p.core.holds.get(r)!.guards.map((g) => g.name)], ['OFF_DISK', ['conflict']]);
    const live = p.core.holds.companionsOf(r).filter((c) => c.state !== 'GONE');
    assert.equal(live.length, 1, 'no second live companion');
    assert.deepEqual(live[0]!.blobs, pair(a, await blob(p, ROWS)));
  });
});

// EF4 round 2 I2-5 (r2 rereview K minors 3 and 4; ruling R3-EF4-15's "or a retry reuses it"). A writer rejection whose in-process rollback
// cannot be confirmed (rollbackIntent throws) keeps the marker companion live — it may hold the only copy — and the retry with the same
// (A[p], S_disk[p]) reuses it instead of making a second one: in the k4OntoMarkers branch (a markers record over [p]: the parent patch goes
// through transition(), no birth) and in the k4OverMarkerFile branch (rows with no `markers` holder: markerCompanion). And an error while
// settling a redundant companion after a confirmed rollback is logged (APPLY_COMPANION_SETTLE_FAILED): the writer's rejection is what
// applyStep throws, and the companion stays live (the safe side).

/** The teammate changes row 2 and the iteration's apply is rejected by the writer (P's rename to its .old fails); rollbackIntent throws after it ran. */
async function rejectedWithUnconfirmedRollback(fx: CoreFixture, p: PeerFixture): Promise<void> {
  await fx.pushTeamChange({ [P]: buf(t9([2, 'TEAM2'])) });
  fx.advance(10_000);
  const it = await prepIt(p, { forceFetch: true });
  p.fs.interpose('rename', `src${sep}t9.txt`, async () => {
    throw new Error('injected writer failure');
  });
  const writer = p.core.writer;
  const orig = writer.rollbackIntent.bind(writer);
  writer.rollbackIntent = async (intent, targets) => {
    await orig(intent, targets);
    throw new Error('injected rollback failure');
  };
  try {
    await assert.rejects(applyStep(p.core, it), /injected writer failure/);
  } finally {
    writer.rollbackIntent = orig;
  }
  assert.deepEqual(await readWork(p, P), buf(ROWS), 'the marker file is still on disk');
}

test('I2-5 (K-3 reuse, k4OntoMarkers): after a rejection whose rollback cannot be confirmed the companion stays live, and the retry reuses it — exactly one non-GONE companion', T10, async () => {
  await withPeers('k4-markers-reuse-onto', {}, async (fx) => {
    const p = fx.peers[0]!;
    const { r, a, held } = await markersRecord(p);
    await rejectedWithUnconfirmedRollback(fx, p);
    const first = p.core.holds.companionsOf(r).filter((c) => c.state !== 'GONE');
    assert.equal(first.length, 1, 'the companion stays live (the rollback could not be confirmed)');
    fx.advance(10_000);
    const it = await prepIt(p, { forceFetch: true });
    const tip = it.tipMap.get(P)!.oid;
    const ar = await applyStep(p.core, it);
    assert.ok(ar.written.includes(P), JSON.stringify(ar));
    const rec = p.core.holds.get(r)!;
    assert.deepEqual([rec.residence, rec.state, rec.guards.map((g) => g.name)], ['OFF_DISK', 'CONFLICTED', ['conflict']]);
    assert.deepEqual(rec.blobs, stages(a, held, tip));
    const live = p.core.holds.companionsOf(r).filter((c) => c.state !== 'GONE');
    assert.deepEqual(live.map((c) => c.id), [first[0]!.id], 'the retry reused the live companion: no second one');
    assert.deepEqual(live[0]!.blobs, pair(a, await blob(p, ROWS)));
    assert.deepEqual(await markerOffenders(p), []);
  });
});

test('I2-5 (K-3 reuse, k4OverMarkerFile): rows with no markers holder — the retry dedupes onto the K4 record and reuses its live companion', T10, async () => {
  await withPeers('k4-markers-reuse-over', {}, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, P, ROWS);
    const it0 = await prepIt(p, { holdPaths: [P] });
    const a = it0.A.get(P)!.oid;
    await rejectedWithUnconfirmedRollback(fx, p);
    const k4s = p.core.holds.nonTerminal().filter((h) => !p.core.holds.isCompanion(h.id) && h.guards.some((g) => g.name === 'conflict'));
    assert.equal(k4s.length, 1, JSON.stringify(k4s.map((h) => [h.id, h.residence, h.state])));
    const first = p.core.holds.companionsOf(k4s[0]!.id).filter((c) => c.state !== 'GONE');
    assert.equal(first.length, 1, 'the companion stays live (the rollback could not be confirmed)');
    fx.advance(10_000);
    const ar = await applyStep(p.core, await prepIt(p, { forceFetch: true }));
    assert.ok(ar.written.includes(P), JSON.stringify(ar));
    const companions = p.core.holds.all().filter((h) => p.core.holds.isCompanion(h.id) && h.state !== 'GONE');
    assert.deepEqual(companions.map((c) => c.id), [first[0]!.id], 'one live marker companion in all: the retry reused it');
    assert.deepEqual(companions[0]!.blobs, pair(a, await blob(p, ROWS)));
    assert.deepEqual(await markerHolders(p), []);
  });
});

test('I2-5 (K minor 4): an error while settling the redundant companion after the rollback is logged, and the writer\'s rejection is what applyStep throws', T10, async () => {
  await withPeers('k4-markers-settle-fail', {}, async (fx) => {
    const p = fx.peers[0]!;
    const log = recordLog(p);
    const { r } = await markersRecord(p);
    await fx.pushTeamChange({ [P]: buf(t9([2, 'TEAM2'])) });
    fx.advance(10_000);
    const it = await prepIt(p, { forceFetch: true });
    p.fs.interpose('rename', `src${sep}t9.txt`, async () => {
      throw new Error('injected writer failure');
    });
    const holds = p.core.holds;
    const orig = holds.transition.bind(holds);
    holds.transition = async (id, patch) => {
      if (patch.state === 'GONE') throw new Error('injected registry failure');
      return orig(id, patch);
    };
    try {
      await assert.rejects(applyStep(p.core, it), /injected writer failure/);
    } finally {
      holds.transition = orig;
    }
    assert.ok(log.lines.some((l) => l.code === 'APPLY_COMPANION_SETTLE_FAILED'), log.text());
    assert.equal(p.core.holds.companionsOf(r).filter((c) => c.state !== 'GONE').length, 1, 'the companion stays live (the safe side)');
  });
});
