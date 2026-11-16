// Ruling R3-EF4-24 (DAT-46 defence in depth; E16-E's ENG-41 (j) abort): planHeld never puts a held/ blob that carries a
// restore-marker row, for any record, terminal included. The registry makes a record whose held side carries one local_only (a
// content-free stub, registry.p3.test.ts), so these records are planted as an older build (or a record the registry missed) left
// them: non-local_only over a marker-bearing h1. Before the ruling planHeld put heldBlobs(r) of every placed op — E16-E's terminal
// GONE op too — and ENG-41 (j) aborted every publish window, so the peer's whole outbox never left.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasRestoreMarkerRow } from '../../src/data/rows.js';
import { mirrorSync, publishStep } from '../../src/engine/publish.js';
import type { Oid } from '../../src/git/oid.js';
import { GitCommandError } from '../../src/git/repo.js';
import { makeGuard, type HoldRecord } from '../../src/holds/record.js';
import type { PeerFixture } from '../helpers/coreFixture.js';
import { durableNow, heldIn, holdOpsOf, holdPatch, win } from '../helpers/mirrorFixture.js';
import { blob, P, pair, plantRecord, prepIt, recordLog, remoteCoworkBlobs, withPeers } from '../helpers/holdOpsFixture.js';
import { t9 } from '../helpers/maskFixture.js';

const T10 = { timeout: 10 * 60_000 };
const ID = '01J9ZQ3V5W6X7Y8Z9A0B1C2D4A';

/** E16-E's taint-only held side: the `||||||| cowork:base` … `>>>>>>> cowork:held` rows of a conflicted restore's marker block. */
const TAINT = t9([5, '||||||| cowork:base'], [6, '5'], [7, '>>>>>>> cowork:held']);

function revertPatch(p: { core: { peerId: string } }, a: Oid, h1: Oid, over: Partial<HoldRecord> = {}): HoldRecord {
  return {
    id: ID, rev: 1, owner: p.core.peerId, kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', offer: 'none', declines: 0,
    displaced_by: null, paths: [P], blobs: pair(a, h1), guards: [makeGuard('revert')], origin: 'daemon',
    cs_ids: [], peer_authors: [], local_only: false, age_anchor: { since_rev: 1, anchor_wall_ms: 0, mono_accum_ms: 0 }, proto: 1, ...over,
  };
}

async function noMarkerLeft(fx: Parameters<typeof remoteCoworkBlobs>[0]): Promise<void> {
  for (const b of await remoteCoworkBlobs(fx)) assert.equal(hasRestoreMarkerRow(b), false, 'no restore-marker row in refs/cowork/*');
}

test('R3-EF4-24 (E16-E shape): a terminal op whose record holds a marker-bearing h1 lands without its held/ put, and no marker blob leaves', T10, async () => {
  await withPeers('x3-marker-terminal', {}, async (fx) => {
    const p = fx.peers[0]!;
    const it0 = await prepIt(p, { holdPaths: [P] });
    const a = it0.A.get(P)!.oid;
    const taint = await blob(p, TAINT);
    assert.equal(hasRestoreMarkerRow((await p.core.repo.readBlob(taint))), true, 'premise: the held side carries the rows');
    // The record as an older build left it: non-local_only, its creation op drafted (pending) before it ended GONE.
    await plantRecord(p, revertPatch(p, a, taint));
    await mirrorSync(p.core, await prepIt(p, { forceFetch: true }));
    assert.ok(p.core.outbox.pendingHold(ID) !== null, 'premise: its creation op is pending');
    await plantRecord(p, revertPatch(p, a, taint, { rev: 2, state: 'GONE', residence: null }));
    fx.advance(10_000);
    const r = await publishStep(p.core, await prepIt(p, { forceFetch: true }));
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    const ops = await holdOpsOf(p, r.bnew!);
    assert.deepEqual(ops.map((o) => [o.hold_id, o.state]), [[ID, 'GONE']], 'the terminal op lands');
    assert.equal(await heldIn(p, r.bnew!, ID), null, 'with no held/<id>/');
    await noMarkerLeft(fx);
    const it = await prepIt(p, { forceFetch: true });
    assert.equal(it.fold.holds[ID]?.state, 'GONE', 'it folds (a terminal op needs no held/ subtree)');
  });
});

test('R3-EF4-24: a non-terminal non-local_only record over a marker-bearing h1 gets no held/ put — its op folds as a held_subtree rejection (HOLD_MIRROR_REJECTED), windows keep landing, and no marker blob leaves', T10, async () => {
  await withPeers('x3-marker-active', {}, async (fx) => {
    const p = fx.peers[0]!;
    const it0 = await prepIt(p, { holdPaths: [P] });
    const a = it0.A.get(P)!.oid;
    const taint = await blob(p, TAINT);
    await plantRecord(p, revertPatch(p, a, taint));
    fx.advance(10_000);
    const r = await publishStep(p.core, await prepIt(p, { forceFetch: true }));
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    assert.equal(await heldIn(p, r.bnew!, ID), null, 'no held/<id>/');
    await noMarkerLeft(fx);
    // The fold refuses the op (PRO-21: a non-terminal, non-local_only op without held/<id>/); the next window records it once.
    fx.advance(10_000);
    const r2 = await publishStep(p.core, await prepIt(p, { forceFetch: true }));
    assert.notEqual(r2.outcome, 'aborted', JSON.stringify(r2));
    assert.equal(p.core.holds.local().rejected[ID]?.reason, 'held_subtree');
    assert.equal(p.core.holdCode?.code, 'HOLD_MIRROR_REJECTED');
    // No re-draft storm: nothing more of it is pushed.
    assert.equal(p.core.outbox.pendingHold(ID), null, 'nothing of it pending');
    await noMarkerLeft(fx);
  });
});

// ---- Ruling R3-EF4-31 (EF5 merge M-2; X3 re-review newBreakage[0]): a blob read failure is not a marker row ----

/**
 * The peer's next `batch` cat-file --batch reads naming `oid`, and its next `single` cat-file blob reads of `oid`, made by planHeld's
 * marker check (markerBearing), fail as a spawn failure does (GitCommandError, code -1) — a transient failure of that one object.
 * Other readers of the blob in the window are left alone (the registry's own held-side marker read, R3-EF4-24, would otherwise take
 * the failure and make the record local_only for that rev, a separate accepted fail-closed path). `left()` is what has not fired.
 */
function failReadsOf(p: PeerFixture, oid: Oid, batch: number, single: number): { left: () => [number, number] } {
  const repo = p.core.repo as unknown as { readBlobs: (oids: readonly Oid[]) => Promise<Buffer[]>; readBlob: (o: Oid) => Promise<Buffer> };
  const readBlobs = repo.readBlobs.bind(p.core.repo);
  const readBlob = repo.readBlob.bind(p.core.repo);
  let b = batch;
  let s = single;
  const spawnFailed = (argv: string[]): GitCommandError => new GitCommandError(argv, -1, Buffer.from('spawn failed: EAGAIN', 'utf8'));
  const fromMarkerCheck = (): boolean => (new Error().stack ?? '').includes('markerBearing');
  repo.readBlobs = async (oids) => {
    if (b > 0 && oids.includes(oid) && fromMarkerCheck()) {
      b--;
      throw spawnFailed(['cat-file', '--batch']);
    }
    return readBlobs(oids);
  };
  repo.readBlob = async (o) => {
    if (s > 0 && o === oid && fromMarkerCheck()) {
      s--;
      throw spawnFailed(['cat-file', 'blob', o]);
    }
    return readBlob(o);
  };
  return { left: () => [b, s] };
}

/** A marker-free revert PATCH over P whose creation op mirrorSync has drafted (pending; a later mirrorSync skips it: pendingShows). */
async function draftedPatch(p: PeerFixture): Promise<{ id: string; h1: Oid }> {
  await prepIt(p, { holdPaths: [P] });   // P's attributes known, so the registry scopes it LIVE (not local_only)
  const { id, h1 } = await holdPatch(p, P, t9([4, 'four held']));
  assert.equal(hasRestoreMarkerRow(await p.core.repo.readBlob(h1)), false, 'premise: no restore-marker row');
  assert.equal(p.core.holds.get(id)!.local_only, false, 'premise: not local_only');
  await mirrorSync(p.core, await prepIt(p, { forceFetch: true }));
  assert.ok(p.core.outbox.pendingHold(id) !== null, 'premise: its creation op is pending');
  return { id, h1 };
}

test('R3-EF4-31 (M-2): one failed cat-file --batch in planHeld\'s marker check falls back to per-oid reads — a marker-free record\'s op lands with its held/ put, never a held_subtree rejection', T10, async () => {
  await withPeers('m2-marker-batch-fallback', {}, async (fx) => {
    const p = fx.peers[0]!;
    const { id, h1 } = await draftedPatch(p);
    const fail = failReadsOf(p, h1, 1, 0);
    const { r } = await win(fx, p, 10_000);
    assert.deepEqual(fail.left(), [0, 0], 'the batch read failed once');
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    assert.ok((await holdOpsOf(p, r.bnew!)).some((o) => o.hold_id === id), 'its op is placed');
    assert.ok((await heldIn(p, r.bnew!, id))?.some((b) => b.stage === 'h1' && b.oid === h1), 'with its held/<id>/ put');
    await win(fx, p, 10_000);
    assert.equal(p.core.holds.local().rejected[id], undefined, 'no fold rejection');
    assert.equal(await durableNow(p, id), true, 'durable');
  });
});

test('R3-EF4-31 (M-2): a held blob unreadable even alone holds the op back this window with HOLD_MASK_INVALID {op: mirror, path, hold_id} (as heldReadable) — no putless op, no rejection; it lands with its put once the blob reads', T10, async () => {
  await withPeers('m2-marker-unreadable', {}, async (fx) => {
    const p = fx.peers[0]!;
    const log = recordLog(p);
    const { id, h1 } = await draftedPatch(p);
    const fail = failReadsOf(p, h1, 1, 1);
    const { r } = await win(fx, p, 10_000);
    assert.deepEqual(fail.left(), [0, 0], 'the batch read and the one-object read both failed');
    assert.notEqual(r.outcome, 'aborted', JSON.stringify(r));
    assert.ok(r.bnew === null || !(await holdOpsOf(p, r.bnew)).some((o) => o.hold_id === id), 'its op is not placed this window');
    assert.deepEqual(p.core.holdCode, { code: 'HOLD_MASK_INVALID', params: { op: 'mirror', path: P, hold_id: id } });
    assert.ok(log.lines.some((l) => l.code === 'HOLD_MASK_INVALID' && l.params?.['hold_id'] === id), 'told in the daemon log');
    assert.ok(p.core.outbox.pendingHold(id) !== null, 'it stays pending');
    // The blob reads again: the op lands with its put, and the fold keeps it.
    const { r: r2 } = await win(fx, p, 10_000);
    assert.equal(r2.outcome, 'landed', JSON.stringify(r2));
    assert.ok((await holdOpsOf(p, r2.bnew!)).some((o) => o.hold_id === id), 'its op lands');
    assert.ok((await heldIn(p, r2.bnew!, id))?.some((b) => b.stage === 'h1' && b.oid === h1), 'with its held/<id>/ put');
    await win(fx, p, 10_000);
    assert.equal(p.core.holds.local().rejected[id], undefined, 'no fold rejection');
    assert.equal(await durableNow(p, id), true, 'durable');
  });
});
