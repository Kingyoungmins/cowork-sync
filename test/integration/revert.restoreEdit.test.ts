// EF4 round 2 R-2 (ruling R3-EF4-13, 05 §3.6 D2 step 1; class mask-iv-neighbour, seed meas-holds-18): the revert detector judged a
// conflicted RESTORE's observed write as an unobserved change once the human edited the file again before the next materialization
// (glossary §26.1 W6: no materialization between them), so it held a second `revert` record whose H1 was built from the restore-marker
// rows the daemon itself wrote (taintOnlyH1 over the marker block). The two revert records rewrite the same row; after a K4 TAKE_TIP
// apply displaces both, the next MASK's HLD-19 re-application conflicts (HOLD_MASK_INVALID, the SIM's INV-MASK (iv)), and while the
// marker-bearing record is ACTIVE every publish aborts on ENG-41 (j). R3-EF4-13: when an observed write (HLD-26 (b)) of p happened since
// the private-index entry, the delta judged is diff(written blob, S_disk[p]) — the write itself is observed, only the change after it is
// judged (ObservedWrites.take). contract.md Global Constraints: every Plan 3 writeLocal write is recorded "so no detector counts it as
// an unobserved delta". Seed 18's shape on src/t9.txt (T9 = "1\n…9\n"):
//   teammate: row 8 "8" → "eight by team" (journal: "eight by team" added and "8" deleted by the teammate), applied;
//   human:    row 5 → "five local", row 8 → "EIGHT local x" (unobserved) → revert record KC (removes the teammate's row);
//   restore:  an OFF_DISK K4 record (s1 = T9, s2 = T9{8:"LOCAL held eight"}) restores with markers on row 8 (base row "8");
//   human:    edits the disk row inside the marker block (unobserved) → before the fix a second revert record MV (re-adds "8");
//   teammate: row 5 → "five by team"; the apply's merge conflicts on row 5 → K4 TAKE_TIP writes TIP over both held changes;
//   next iteration: maskStep's assertSPub must hold (no HOLD_MASK_INVALID).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyStep } from '../../src/engine/apply.js';
import { revertStep } from '../../src/engine/detect.js';
import { evaluateRecords, restore } from '../../src/engine/holdOps.js';
import { maskStep, recordStep } from '../../src/engine/holdSteps.js';
import { publishStep } from '../../src/engine/publish.js';
import { hasRestoreMarkerRow } from '../../src/data/rows.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import { blobAt, heldSide, TERMINAL_STATES, type HoldRecord } from '../../src/holds/record.js';
import { readWork, writeWork, type PeerFixture } from '../helpers/coreFixture.js';
import { blob, nr, P, prepIt, recordLog, stages, withPeers } from '../helpers/holdOpsFixture.js';
import { T9, t9 } from '../helpers/maskFixture.js';
import { buf, captureReady, prep } from '../helpers/publishHelpers.js';
import { gitIn } from '../helpers/startFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };
const HUMAN = { humanEvidence: true, actor: 'human' } as const;

const TEAM8 = 'eight by team';
const reverts = (p: PeerFixture): HoldRecord[] =>
  p.core.holds.nonTerminal().filter((r) => r.guards.some((g) => g.name === 'revert'));

/** Every non-terminal, non-local_only record whose held side (h1 / s2) carries a restore-marker row: "<id> <stage>". */
async function markerHeld(p: PeerFixture): Promise<string[]> {
  const out: string[] = [];
  for (const r of p.core.holds.all()) {
    if ((TERMINAL_STATES as ReadonlySet<string>).has(r.state) || r.local_only) continue;
    for (const path of r.paths) {
      const o = blobAt(heldSide(r), path);
      if (o === undefined || o === ABSENT) continue;
      if (hasRestoreMarkerRow(await p.core.repo.readBlob(o as Oid))) out.push(`${r.id} rev ${r.rev} held[${path}]`);
    }
  }
  return out;
}

/** A detection tick, 1.5 s, then a materializing iteration and revertStep (revert.test.ts's `detect`). */
async function detect(fx: { advance(ms: number): void }, p: PeerFixture): Promise<string[]> {
  await prepIt(p);
  fx.advance(1_500);
  return revertStep(p.core, await prepIt(p, { materialize: true }));
}

/**
 * Seed 18's prologue: the teammate's row 8 applied, an OFF_DISK CONFLICTED K4 record of this peer, the human's edit (one revert record
 * KC), the conflicted restore of the K4 record (cowork: markers on row 8, base section "8"), then the human's edit of the disk row inside
 * the marker block before any materialization. Returns KC's ids.
 */
async function restoreThenEdit(fx: { advance(ms: number): void; pushTeamChange(files: Record<string, Buffer>): Promise<unknown> }, p: PeerFixture): Promise<string[]> {
  await fx.pushTeamChange({ [P]: buf(t9([8, TEAM8])) });
  fx.advance(10_000);
  const a1 = await applyStep(p.core, await prepIt(p, { forceFetch: true }));
  assert.ok(a1.written.includes(P), JSON.stringify(a1));
  assert.deepEqual(await detect(fx, p), [], 'applied bytes are no local delta');
  // An earlier K4 displacement of this peer (seed 18's record of step 2), OFF_DISK CONFLICTED: s1 = T9, s2 = its local row 8.
  const k4 = await p.core.holds.hold(nr({
    residence: 'OFF_DISK', state: 'CONFLICTED', guard: 'conflict', origin: 'daemon',
    blobs: stages(await blob(p, T9), await blob(p, t9([8, 'LOCAL held eight'])), await blob(p, t9([8, TEAM8]))),
  }));
  // The human removes the teammate's row (and edits row 5): one revert record KC.
  await writeWork(p, P, t9([5, 'five local'], [8, 'EIGHT local x']));
  const kc = await detect(fx, p);
  assert.equal(kc.length, 1, 'KC: the teammate row removed');
  // The displaced K4 record restored over the disk: row 8 conflicts → cowork: markers (the base section holds "8").
  assert.deepEqual(await restore(p.core, await prepIt(p, { holdPaths: [P] }), k4, HUMAN), { kind: 'RESTORED', markers: true });
  const restored = (await readWork(p, P))!.toString('utf8');
  assert.ok(restored.includes('||||||| cowork:base\n8\n'), restored);
  // The human edits the disk row inside the marker block before any materialization (seed 18's step 55).
  await writeWork(p, P, restored.replace('EIGHT local x', 'EIGHT local y'));
  return kc;
}

test('R3-EF4-13: a restore write followed by an unobserved edit is judged from the restore write (HLD-26 (b)): no revert record of the restore-written marker rows', T10, async () => {
  await withPeers('ef4r2-r2-restore-then-edit', {}, async (fx) => {
    const p = fx.peers[0]!;
    const kc = await restoreThenEdit(fx, p);
    const ids = await detect(fx, p);
    assert.deepEqual(await markerHeld(p), [], 'no mirrored record holds a restore-marker row (05 §3.4 item 3, DAT-46, INV-SECRET)');
    assert.deepEqual(ids, [], 'the remainder after the observed restore write (EIGHT local x → y) reverts nothing');
    assert.deepEqual(reverts(p).map((r) => r.id), kc, 'KC alone');
  });
});

test('R3-EF4-13: a teammate row removed after the observed restore write is still a revert, judged from the written blob', T10, async () => {
  await withPeers('ef4r2-r2-restore-then-revert', {}, async (fx) => {
    const p = fx.peers[0]!;
    // The teammate adds row "team row 3a" after row 3 (its own line, journaled add by the teammate), applied.
    await fx.pushTeamChange({ [P]: buf(T9.replace('3\n', '3\nteam row 3a\n')) });
    fx.advance(10_000);
    assert.ok((await applyStep(p.core, await prepIt(p, { forceFetch: true }))).written.includes(P));
    assert.deepEqual(await detect(fx, p), []);
    // An OFF_DISK PARKED PATCH of this peer on row 7, restored cleanly over the disk (no markers): the restore write is observed.
    const parked = await p.core.holds.hold(nr({
      residence: 'OFF_DISK', state: 'PARKED', guard: null, origin: 'human',
      blobs: { h0: { [P]: await blob(p, T9.replace('3\n', '3\nteam row 3a\n')) }, h1: { [P]: await blob(p, T9.replace('3\n', '3\nteam row 3a\n').replace('7\n', 'seven held\n')) } },
    }));
    assert.deepEqual(await restore(p.core, await prepIt(p, { holdPaths: [P] }), parked, HUMAN), { kind: 'RESTORED', markers: false });
    const restored = (await readWork(p, P))!.toString('utf8');
    assert.ok(restored.includes('seven held\n') && restored.includes('team row 3a\n'), restored);
    // Before any materialization the human's stale buffer drops the teammate's row: the change after the write is unobserved.
    await writeWork(p, P, restored.replace('team row 3a\n', ''));
    const ids = await detect(fx, p);
    assert.equal(ids.length, 1, `one revert record for the teammate row removed after the restore: ${JSON.stringify(ids)}`);
    const r = p.core.holds.get(ids[0]!)!;
    assert.ok(r.guards.some((g) => g.name === 'revert'), JSON.stringify(r.guards));
    const h1 = (await p.core.repo.readBlob(blobAt(heldSide(r), P) as Oid)).toString('utf8');
    assert.ok(!h1.includes('team row 3a'), `the held side is the revert (teammate row removed): ${JSON.stringify(h1)}`);
  });
});

test('R3-EF4-13: a restore\'s written blob survives a user\'s gc --prune=now before the edit after it is materialized (the registry\'s blobs/ keeps it), so the remainder is still judged from it', T10, async () => {
  await withPeers('ef4r2-r2-written-pruned', {}, async (fx) => {
    const p = fx.peers[0]!;
    await fx.pushTeamChange({ [P]: buf(t9([8, TEAM8])) });
    fx.advance(10_000);
    assert.ok((await applyStep(p.core, await prepIt(p, { forceFetch: true }))).written.includes(P));
    assert.deepEqual(await detect(fx, p), []);
    const k4 = await p.core.holds.hold(nr({
      residence: 'OFF_DISK', state: 'CONFLICTED', guard: 'conflict', origin: 'daemon',
      blobs: stages(await blob(p, T9), await blob(p, t9([8, 'LOCAL held eight'])), await blob(p, t9([8, TEAM8]))),
    }));
    assert.deepEqual(await restore(p.core, await prepIt(p, { holdPaths: [P] }), k4, HUMAN), { kind: 'RESTORED', markers: true });
    const restored = (await readWork(p, P))!.toString('utf8');
    const written = await p.core.repo.hashBytes(Buffer.from(restored, 'utf8'), false);
    assert.equal(await p.core.repo.hasObject(written, 'blob'), true, 'the restore wrote its merged result (route (c) -w)');
    // A user's gc --prune=now (01-engine:145 prunes objects only a private index names): the registry's chain names the restore's
    // target under blobs/ (its inflight entry), so revertStep can still read the side it judges from.
    await gitIn(p, ['gc', '-q', '--prune=now']);
    assert.equal(await p.core.repo.hasObject(written, 'blob'), true, 'the restore\'s written blob survives gc (registry blobs/)');
    await writeWork(p, P, restored.replace('LOCAL held eight', 'LOCAL held eight, edited'));
    assert.deepEqual(await detect(fx, p), [], 'the edit after the observed restore write reverts nothing');
    assert.deepEqual(await markerHeld(p), [], 'no mirrored record holds a restore-marker row');
  });
});

test('R3-EF4-13: after a K4 TAKE_TIP displaces the held revert(s), the next MASK passes HLD-19 (no HOLD_MASK_INVALID)', T10, async () => {
  await withPeers('ef4r2-r2-mask-after-k4', {}, async (fx) => {
    const p = fx.peers[0]!;
    await restoreThenEdit(fx, p);
    await detect(fx, p);
    const before = reverts(p).map((r) => `${r.id} rev ${r.rev}`);
    // The teammate's row 5: the apply's merge conflicts on row 5 → K4 TAKE_TIP (TIP written over every held change on P).
    await fx.pushTeamChange({ [P]: buf(t9([5, 'five by team'], [8, TEAM8])) });
    fx.advance(10_000);
    const it = await prepIt(p, { forceFetch: true, materialize: true });
    const ap = await applyStep(p.core, it);
    assert.ok(ap.written.includes(P), JSON.stringify(ap));
    await recordStep(p.core, it, ap);
    assert.deepEqual(await readWork(p, P), Buffer.from(t9([5, 'five by team'], [8, TEAM8])), 'TAKE_TIP wrote TIP');
    // The next materializing iteration: MASK over S_disk = TIP and the revert records still ON_DISK (R1 ends them after it).
    const log = recordLog(p);
    fx.advance(2_500);
    const it2 = await prepIt(p, { materialize: true });
    const ok = await maskStep(p.core, it2);
    const invalid = log.lines.filter((l) => l.code === 'HOLD_MASK_INVALID').map((l) => JSON.stringify(l.params));
    assert.deepEqual({ ok, maskInvalid: p.core.maskInvalid, invalid }, { ok: true, maskInvalid: false, invalid: [] },
      `revert records before the apply: ${JSON.stringify(before)}; now: ${JSON.stringify(reverts(p).map((r) => `${r.id} rev ${r.rev} ${r.residence} ${r.state}`))}`);
  });
});

test('R3-EF4-13 (seeds 21, 77): after the restore and the edit inside the marker block, an unrelated change still lands (no held/ blob with restore-marker rows for ENG-41 (j))', T10, async () => {
  await withPeers('ef4r2-r2-publish-after', {}, async (fx) => {
    const p = fx.peers[0]!;
    await restoreThenEdit(fx, p);
    await detect(fx, p);
    // An unrelated human change: the board push carries every pending hold draft (05 §3.4 item 3: no held/ blob with marker rows).
    await writeWork(p, 'src/other.txt', 'other, after the restore\n');
    await prep(p);
    fx.advance(20_000);
    await captureReady(p, await prep(p, true));
    fx.advance(30_000);
    const r = await publishStep(p.core, await prep(p));
    assert.deepEqual({ outcome: r.outcome, why: r.why ?? null }, { outcome: 'landed', why: null }, `marker-held: ${JSON.stringify(await markerHeld(p))}`);
  });
});

test('R3-EF4-13 (seeds 21, 77, guard): once every revert record ended GONE, the next publish lands', T10, async () => {
  await withPeers('ef4r2-r2-gone-then-publish', {}, async (fx) => {
    const p = fx.peers[0]!;
    await restoreThenEdit(fx, p);
    await detect(fx, p);
    const marked = await markerHeld(p);
    // The human resolves the markers by taking the team row: every revert's held change leaves the disk, R1 ends them GONE.
    await writeWork(p, P, t9([5, 'five local'], [8, TEAM8]));
    await prepIt(p);
    fx.advance(1_500);
    const it = await prepIt(p, { materialize: true });
    assert.deepEqual(await revertStep(p.core, it), []);
    await evaluateRecords(p.core, it, new Set(), []);
    assert.deepEqual(reverts(p).map((r) => r.id), [], 'every revert record ended (GONE)');
    await writeWork(p, 'src/other.txt', 'other, after the resolution\n');
    await prep(p);
    fx.advance(20_000);
    await captureReady(p, await prep(p, true));
    fx.advance(30_000);
    const r = await publishStep(p.core, await prep(p));
    assert.deepEqual({ outcome: r.outcome, why: r.why ?? null }, { outcome: 'landed', why: null }, `marker-held records before the resolution: ${JSON.stringify(marked)}`);
  });
});

// EF4 round 2 I2-2 (ruling R3-EF4-21, final review F1's rule; r2 rereview R newBreakage[0]): an ObservedWrites entry lives only until the
// write it names can no longer appear as a delta. When the disk returns to the exact private-index bytes before the next materialization
// (the human's stale buffer or an undo after a restore), the revert detector never takes p's entry; an apply then moves p's private-index
// entry (the writer's round trip to M). Before the fix the lingering entry re-based the next delta: the human's removal of the applied
// teammate row was judged diff(W, E) instead of diff(M, E) and made no revert record — the row went out at the next publish
// (INV-HLD-NOREVERT, the unsafe direction). Now the apply forgets p's entry with the entry it moves (written, deleted or set index-only).
test('R3-EF4-21: a restore write whose entry outlived a stale save back to the indexed bytes is forgotten when an apply moves the private-index entry; the removal of the applied teammate row is a revert', T10, async () => {
  await withPeers('ef4r2-i22-linger-apply', {}, async (fx) => {
    const p = fx.peers[0]!;
    const detectAndEvaluate = async (): Promise<string[]> => {
      await prepIt(p);
      fx.advance(1_500);
      const it = await prepIt(p, { materialize: true });
      const ids = await revertStep(p.core, it);
      await evaluateRecords(p.core, it, new Set(), []);
      return ids;
    };
    const T3a = T9.replace('3\n', '3\nteam row 3a\n');
    await fx.pushTeamChange({ [P]: buf(T3a) });
    fx.advance(10_000);
    assert.ok((await applyStep(p.core, await prepIt(p, { forceFetch: true }))).written.includes(P));
    assert.deepEqual(await detectAndEvaluate(), []);
    const D = (await readWork(p, P))!.toString('utf8');
    assert.equal(D, T3a);
    // A clean restore of an OFF_DISK PARKED PATCH writes W (row 7 → 'seven held'): an observed write.
    const parked = await p.core.holds.hold(nr({
      residence: 'OFF_DISK', state: 'PARKED', guard: null, origin: 'human',
      blobs: { h0: { [P]: await blob(p, T3a) }, h1: { [P]: await blob(p, T3a.replace('7\n', 'seven held\n')) } },
    }));
    assert.deepEqual(await restore(p.core, await prepIt(p, { holdPaths: [P] }), parked, HUMAN), { kind: 'RESTORED', markers: false });
    const W = await blob(p, T3a.replace('7\n', 'seven held\n'));
    assert.ok((await readWork(p, P))!.toString('utf8').includes('seven held\n'));
    // The human's stale buffer (or an undo) puts D back before any materialization: no delta for p, the entry is never taken.
    await writeWork(p, P, D);
    assert.deepEqual(await detectAndEvaluate(), [], 'disk == private-index entry: no delta');
    assert.ok(p.core.observed.peek(P, W), 'premise: the restore write\'s entry lingers');
    // A teammate adds row 6a; applied (the writer round-trips the private index to M).
    const M = T3a.replace('6\n', '6\nteam row 6a\n');
    await fx.pushTeamChange({ [P]: buf(M) });
    fx.advance(10_000);
    const it = await prepIt(p, { forceFetch: true, materialize: true });
    const ap = await applyStep(p.core, it);
    assert.ok(ap.written.includes(P), JSON.stringify(ap));
    await recordStep(p.core, it, ap);
    assert.equal((await readWork(p, P))!.toString('utf8'), M);
    const forgotten = !p.core.observed.peek(P, W);
    assert.deepEqual(await detectAndEvaluate(), [], 'applied bytes are no local delta');
    // The human removes the applied teammate row 6a (and edits row 2): E != W, E != M — judged from M.
    await writeWork(p, P, M.replace('team row 6a\n', '').replace('2\n', 'two local\n'));
    const ids = await detectAndEvaluate();
    assert.equal(ids.length, 1, `one revert record for the applied teammate row removed: ${JSON.stringify(ids)}`);
    const r = p.core.holds.get(ids[0]!)!;
    assert.ok(r.guards.some((g) => g.name === 'revert'), JSON.stringify(r.guards));
    const h1 = (await p.core.repo.readBlob(blobAt(heldSide(r), P) as Oid)).toString('utf8');
    assert.ok(!h1.includes('team row 6a'), `the held side is the revert (teammate row 6a removed): ${JSON.stringify(h1)}`);
    assert.ok(forgotten, 'the apply that moved P\'s private-index entry forgot the restore write');
  });
});
