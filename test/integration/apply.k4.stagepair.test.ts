// EF5 X2-1 (ruling R3-EF4-25, amends R3-EF4-7/15; delta review Critical C1, probe zz_inv_k4markers_stalebase): a K4 stage pair is always
// one record's OWN change. A K4 onto (or over) a markers record r took the stages (A[p], r's held side, TIP[p]); r's held side is relative
// to r's ORIGINAL base (HLD-02/HLD-14 keep the original pair), which differs from A[p] whenever A moved under r before its conflicted
// RESTORE — the usual reason a RESTORE conflicts. That pair encodes r's change PLUS the reverse of every teammate change between r's base
// and A, and a later --restore of the K4 record (RESTORE = mf(D, s1, s2)) re-applied that reverse: the teammate's rows left the disk,
// observed (HLD-26 (b)), so no revert record, and the human CS published the removal. Now s2 := REBASE(r onto A).H1' when that is clean
// (s1 = A[p]); when the REBASE conflicts, the stages are r's own pair at p (r's base, r's held side). settleHoldOps' companion match
// follows: a marker companion keeps h0 = A[p] (05 §3.4 item 3), which the fallback's s1 no longer equals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyStep } from '../../src/engine/apply.js';
import { revertStep } from '../../src/engine/detect.js';
import { restore, settleHoldOps } from '../../src/engine/holdOps.js';
import { recordStep } from '../../src/engine/holdSteps.js';
import { restart } from '../../src/engine/restart.js';
import type { IterationCtx } from '../../src/engine/core.js';
import type { Oid } from '../../src/git/oid.js';
import { KilledAt, setCrashHandler } from '../../src/ports/crashpoint.js';
import { readWork, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { blob, nr, P, pair, prepIt, stages, text, withPeers } from '../helpers/holdOpsFixture.js';
import { T9, t9 } from '../helpers/maskFixture.js';
import { buf } from '../helpers/publishHelpers.js';
import { gitIn, restartCore } from '../helpers/startFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };
const HUMAN = { humanEvidence: true, actor: 'human' } as const;
/** A restore-marker row (DAT-46). */
const MARKER_ROW = /^(<{7}|\|{7}|>{7}) cowork:/m;

/**
 * The two shapes of a markers record r whose base is older than A. r: an OFF_DISK PARKED PATCH of this peer over P, base T9, held change
 * 'five held' on row 5. `team1` is applied first (A moves under r), the human then edits (`human`) and --restores r: the restore conflicts
 * (markers). `team2` collides with the marker file, so the next apply TAKE_TIPs P onto r (k4OntoMarkers).
 *   - clean: team1 changes row 1, far from r's row 5 — REBASE(r onto A) is clean, H1' = A with 'five held';
 *   - conflict: team1 changes row 5 too — REBASE(r onto A) conflicts, the stages are r's own pair (T9, 'five held').
 */
const SHAPES = {
  clean: {
    team1: t9([1, 'one team']), human: t9([1, 'one team'], [6, 'six local']), team2: t9([1, 'one team'], [7, 'seven team']),
  },
  conflict: {
    team1: t9([1, 'one team'], [5, 'five team']), human: t9([1, 'one team'], [5, 'five team'], [9, 'nine local']),
    team2: t9([1, 'one team'], [5, 'five team'], [9, 'nine team']),
  },
} as const;

/** The detection iterations between two steps (the probe's rhythm): a tick, then a materializing iteration whose revertStep runs. */
async function settle(fx: CoreFixture, p: PeerFixture): Promise<void> {
  fx.advance(2_000);
  await prepIt(p);
  fx.advance(1_500);
  await revertStep(p.core, await prepIt(p, { materialize: true }));
}

/** Up to the K4: r restored with markers over `team1`, `team2` pushed; the K4 apply's iteration and the blobs the assertions name. */
async function markersOverStaleBase(fx: CoreFixture, p: PeerFixture, shape: keyof typeof SHAPES): Promise<{ r: string; it: IterationCtx; base: Oid; held: Oid; a: Oid; tip: Oid }> {
  const s = SHAPES[shape];
  const base = await blob(p, T9);
  const held = await blob(p, t9([5, 'five held']));
  const r = await p.core.holds.hold(nr({ residence: 'OFF_DISK', state: 'PARKED', guard: null, origin: 'human', blobs: pair(base, held) }));
  await fx.pushTeamChange({ [P]: buf(s.team1) });
  fx.advance(10_000);
  assert.ok((await applyStep(p.core, await prepIt(p, { forceFetch: true }))).written.includes(P), 'team1 is applied: A moves under r');
  await writeWork(p, P, s.human);
  await settle(fx, p);
  const res1 = await restore(p.core, await prepIt(p, { holdPaths: [P] }), r, HUMAN);
  assert.deepEqual(res1, { kind: 'RESTORED', markers: true }, 'the first restore conflicts');
  const d1 = (await readWork(p, P))!.toString('utf8');
  assert.ok(MARKER_ROW.test(d1) && d1.startsWith('one team\n'), `the marker file keeps the teammate row: ${JSON.stringify(d1)}`);
  await settle(fx, p);
  await fx.pushTeamChange({ [P]: buf(s.team2) });
  fx.advance(11_000);
  const it = await prepIt(p, { forceFetch: true, materialize: true });
  return { r, it, base, held, a: it.A.get(P)!.oid, tip: it.tipMap.get(P)!.oid };
}

/** The K4 apply (and its recordStep); the K4 is r, OFF_DISK CONFLICTED [conflict] after the verified TIP write. */
async function k4Apply(p: PeerFixture, it: IterationCtx, r: string): Promise<void> {
  const ar = await applyStep(p.core, it);
  await recordStep(p.core, it, ar);
  assert.ok(ar.written.includes(P), JSON.stringify(ar));
  assert.deepEqual(ar.records, [r], 'the K4 is r (k4OntoMarkers)');
  const k = p.core.holds.get(r)!;
  assert.deepEqual([k.residence, k.state, k.guards.map((g) => g.name)], ['OFF_DISK', 'CONFLICTED', ['conflict']]);
}

/** The human's explicit --restore of the OFF_DISK K4 record r; the disk afterwards. */
async function restoreAgain(fx: CoreFixture, p: PeerFixture, r: string): Promise<{ res: unknown; disk: string }> {
  await settle(fx, p);
  const res = await restore(p.core, await prepIt(p, { holdPaths: [P] }), r, HUMAN);
  return { res, disk: (await readWork(p, P))!.toString('utf8') };
}

test('X2-1: a K4 onto a markers record whose base is older than A takes REBASE(r onto A) — a later --restore keeps the teammate row', T10, async () => {
  await withPeers('k4-stagepair-clean', {}, async (fx) => {
    const p = fx.peers[0]!;
    const { r, it, a, tip } = await markersOverStaleBase(fx, p, 'clean');
    assert.equal(await text(p, a), t9([1, 'one team']), 'A[p] is team1');
    await k4Apply(p, it, r);
    const k = p.core.holds.get(r)!;
    // s1 = A[p], s2 = H1' = mf(A[p], T9, T9{5:five held}): r's change rebased onto A, never r's T9-based held side (row 1 = '1').
    const h1p = await blob(p, t9([1, 'one team'], [5, 'five held']));
    assert.deepEqual(k.blobs, stages(a, h1p, tip), `stages (A[p], REBASE(r onto A), TIP[p]); s2 = ${JSON.stringify(await text(p, 's2' in k.blobs ? k.blobs.s2[P] : undefined))}`);
    // The human restores r once more: r's change only — the teammate rows stay.
    const { res, disk } = await restoreAgain(fx, p, r);
    assert.deepEqual(res, { kind: 'RESTORED', markers: false });
    assert.equal(disk, t9([1, 'one team'], [5, 'five held'], [7, 'seven team']), 'the second restore applies r\'s change and keeps both teammate rows');
  });
});

test('X2-1: a K4 onto a markers record whose REBASE onto A conflicts takes r\'s own pair (its base, its held side) — a later --restore drops no teammate row', T10, async () => {
  await withPeers('k4-stagepair-conflict', {}, async (fx) => {
    const p = fx.peers[0]!;
    const { r, it, base, held, tip } = await markersOverStaleBase(fx, p, 'conflict');
    await k4Apply(p, it, r);
    const k = p.core.holds.get(r)!;
    assert.deepEqual(k.blobs, stages(base, held, tip), `stages (r's base, r's held side, TIP[p]); s1 = ${JSON.stringify(await text(p, 's1' in k.blobs ? k.blobs.s1[P] : undefined))}`);
    // RESTORE = mf(D, T9, T9{5:five held}) over D = TIP: row 5 conflicts again (markers); rows 1 and 9 of the teammates stay.
    const { res, disk } = await restoreAgain(fx, p, r);
    assert.deepEqual(res, { kind: 'RESTORED', markers: true }, 'r\'s change still conflicts with the teammate\'s row 5');
    assert.ok(disk.startsWith('one team\n'), `the teammate's row 1 stays: ${JSON.stringify(disk)}`);
    assert.ok(disk.includes('five team\n') && disk.endsWith('nine team\n'), `the teammate's rows 5 and 9 stay: ${JSON.stringify(disk)}`);
  });
});

/** Throws KilledAt at the `nth` hit of `point` (a dead process: the core is abandoned). */
async function killedAt<T>(point: string, nth: number, fn: () => Promise<T>): Promise<void> {
  let hits = 0;
  setCrashHandler((name) => {
    if (name === point && ++hits === nth) throw new KilledAt(name);
  });
  try {
    await assert.rejects(fn(), (e: unknown) => e instanceof KilledAt && e.point === point, `killed at ${point} #${nth}`);
  } finally {
    setCrashHandler(null);
  }
}

test('X2-1 crash: a REBASE-conflict K4 onto a markers record killed after its registry commit — restart ends the redundant companion GONE; the retry keeps r\'s own pair', T10, async () => {
  await withPeers('k4-stagepair-crash', {}, async (fx) => {
    const p = fx.peers[0]!;
    const { r, it, base, held, a, tip } = await markersOverStaleBase(fx, p, 'conflict');
    const rows = await blob(p, (await readWork(p, P))!);
    // Killed right after the one registry commit of k4OntoMarkers (companion + r's stages), before any write.
    await killedAt('registry.cas', 2, () => applyStep(p.core, it));
    await gitIn(p, ['gc', '-q', '--prune=now']);
    await restartCore(p);
    await restart(p.core);
    const k = p.core.holds.get(r)!;
    assert.deepEqual([k.residence, k.state, k.guards.map((g) => g.name)], ['ON_DISK', 'CONFLICTED', ['markers', 'conflict']]);
    assert.deepEqual(k.blobs, stages(base, held, tip), 'r keeps its own pair');
    assert.deepEqual(await readWork(p, P), (await p.core.repo.readBlob(rows)), 'the marker file is still on disk');
    const comps = p.core.holds.companionsOf(r);
    assert.equal(comps.length, 1);
    assert.deepEqual(comps[0]!.blobs, pair(a, rows), 'the companion holds the marker file over A[p]');
    assert.equal(comps[0]!.state, 'GONE', 'the redundant companion (its bytes are on r\'s disk) ends GONE at restart, matched by h0 == A[p]');
    // The retry (same A, same marker file) keeps r's own pair, writes TIP and leaves one live companion.
    fx.advance(10_000);
    const ar = await applyStep(p.core, await prepIt(p, { forceFetch: true }));
    assert.ok(ar.written.includes(P), JSON.stringify(ar));
    const k2 = p.core.holds.get(r)!;
    assert.deepEqual([k2.residence, k2.state, k2.guards.map((g) => g.name)], ['OFF_DISK', 'CONFLICTED', ['conflict']]);
    assert.deepEqual(k2.blobs, stages(base, held, tip));
    const live = p.core.holds.companionsOf(r).filter((c) => c.state !== 'GONE');
    assert.equal(live.length, 1);
    assert.deepEqual(live[0]!.blobs, pair(a, rows));
  });
});

test('R3-EF4-31 (EF5 merge M-4): settleHoldOps also matches a redundant marker companion by h0 == r.s1 (a clean pair) — after A moved under an interrupted K4 (the lost-state rebuild) it still ends GONE; a companion matching neither A[p] nor s1 stays', T10, async () => {
  for (const pairShape of ['clean', 'other'] as const) {
    await withPeers(`k4-companion-s1-${pairShape}`, {}, async (fx) => {
      const p = fx.peers[0]!;
      const it0 = await prepIt(p, { holdPaths: [P] });
      const a = it0.A.get(P)!.oid;
      // The A of the interrupted K4 (its s1 for a clean pair, the companion's h0), no longer A[P] now.
      const kA = await blob(p, t9([1, 'one at the K4']));
      assert.notEqual(kA, a);
      const s1 = pairShape === 'clean' ? kA : await blob(p, t9([1, 'an older base']));
      const r = await p.core.holds.hold(nr({
        state: 'CONFLICTED', guard: 'conflict', origin: 'daemon',
        blobs: stages(s1, await blob(p, t9([1, 'one at the K4'], [5, 'five held'])), await blob(p, t9([1, 'one at the K4'], [7, 'seven team']))),
      }));
      // The marker file is still on r's disk: the companion is redundant.
      const rows = '1\n<<<<<<< cowork:disk\nTWO\n||||||| cowork:base\n2\n=======\ntwo\n>>>>>>> cowork:held\n3\n4\n5\n6\n7\n8\n9\n';
      await writeWork(p, P, rows);
      const c = await p.core.holds.hold(nr({ residence: 'OFF_DISK', state: 'PARKED', guard: null, origin: 'daemon', blobs: pair(kA, await blob(p, rows)), companionOf: r }));
      assert.deepEqual(p.core.holds.companionsOf(r).map((x) => x.id), [c]);
      await settleHoldOps(p.core);
      assert.equal(p.core.holds.get(c)!.state, pairShape === 'clean' ? 'GONE' : 'PARKED');
      const k = p.core.holds.get(r)!;
      assert.deepEqual([k.residence, k.state], ['ON_DISK', 'CONFLICTED'], 'r is left as it is');
    });
  }
});

// k4OverMarkerFile (R3-EF4-15's companion route with no markersTargetOf target): markerFreeSide picks the source record whose held side of p
// the K4 record takes — here a two-path restored markers PATCH r over [P, U] whose base at P (T9) is older than A[P]. The K4 record's pair is
// that source's own change at P: REBASE(r onto A) at P when clean, else r's own (base, held side) at P — never A[P] with r's held side.
const U = 'src/u9.txt';
/** A conflicted RESTORE's result on P: restore-marker rows in place of row 2, the rest of `around` kept. */
function rowsOver(around: string): string {
  const rows = around.split('\n');
  rows[1] = '<<<<<<< cowork:disk\nTWO\n||||||| cowork:base\n2\n=======\ntwo\n>>>>>>> cowork:held';
  return rows.join('\n');
}

for (const shape of ['clean', 'conflict'] as const) {
  test(`X2-1 (k4OverMarkerFile, ${shape}): a K4 over the marker file of a two-path markers record whose base at P is older than A takes that record's own change at P`, T10, async () => {
    await withPeers(`k4-stagepair-over-${shape}`, {}, async (fx) => {
      const p = fx.peers[0]!;
      // team1: row 8 (clean: far from r's row 2) or row 2 itself (conflict); applied, so A[P] moves under r.
      const team1 = shape === 'clean' ? t9([8, 'eight team']) : t9([2, 'two team']);
      await fx.pushTeamChange({ [P]: buf(team1) });
      fx.advance(10_000);
      assert.ok((await applyStep(p.core, await prepIt(p, { forceFetch: true }))).written.includes(P));
      await writeWork(p, P, rowsOver(team1));
      await writeWork(p, U, t9([3, 'held u']));
      const it0 = await prepIt(p, { holdPaths: [P, U] });
      const a = it0.A.get(P)!.oid;
      const base = await blob(p, T9);
      const held = await blob(p, t9([2, 'two']));
      const r = await p.core.holds.hold(nr({
        guard: 'markers', origin: 'daemon', paths: [P, U], blobs: { h0: { [P]: base, [U]: it0.A.get(U)!.oid }, h1: { [P]: held, [U]: await blob(p, t9([3, 'held u'])) } },
      }));
      const team2 = shape === 'clean' ? t9([2, 'TEAM2'], [8, 'eight team']) : t9([2, 'TEAM2']);
      await fx.pushTeamChange({ [P]: buf(team2) });
      fx.advance(10_000);
      const it = await prepIt(p, { forceFetch: true });
      const tip = it.tipMap.get(P)!.oid;
      const ar = await applyStep(p.core, it);
      assert.ok(ar.written.includes(P), JSON.stringify(ar));
      assert.equal(ar.records.length, 1);
      const id = ar.records[0]!;
      assert.notEqual(id, r, 'a new K4 record over [P] (r spans two paths)');
      const k = p.core.holds.get(id)!;
      const want = shape === 'clean' ? stages(a, await blob(p, t9([2, 'two'], [8, 'eight team'])), tip) : stages(base, held, tip);
      assert.deepEqual(k.blobs, want, `s1 = ${JSON.stringify(await text(p, 's1' in k.blobs ? k.blobs.s1[P] : undefined))}, s2 = ${JSON.stringify(await text(p, 's2' in k.blobs ? k.blobs.s2[P] : undefined))}`);
      const live = p.core.holds.companionsOf(id).filter((c) => c.state !== 'GONE');
      assert.equal(live.length, 1);
      assert.deepEqual(live[0]!.blobs, pair(a, await blob(p, rowsOver(team1))), 'the companion keeps the marker file over A[P]');
      // The human restores the K4 record: row 2 conflicts (TEAM2 vs two), and the teammate's other rows stay.
      const { res, disk } = await restoreAgain(fx, p, id);
      assert.deepEqual(res, { kind: 'RESTORED', markers: true });
      if (shape === 'clean') assert.ok(disk.includes('eight team\n'), `the teammate's row 8 stays: ${JSON.stringify(disk)}`);
      else assert.ok(disk.includes('TEAM2\n') && !disk.includes('two team\n'), `the restore is r's change over T9 against TIP: ${JSON.stringify(disk)}`);
    });
  });
}
