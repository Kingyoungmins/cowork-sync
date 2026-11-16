// Own `hold` op rejections and local rejections of the mirror (Plan 3 Task 4; 02-protocol PRO-21 writer side, PRO-24,
// PRO-38; 05-holds F5 (engine side), F6, HLD-10, HLD-62; TC-HLD-09 mirror-rejection half, T-PRO-05 own-op handling, T-PRO-13
// variant; Review Focus 4; rulings R3-25, R3-27, R3-70): transient host rejections are no host-reject record, every stale
// prev_rev rejection is re-drafted from the folded rev and never recorded, a validator rejection is told once and never
// re-issued (not even after a restart), an op line over 16 KiB is a local rejection, and a rejected record stays non-durable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureAttrs } from '../../src/engine/core.js';
import { mirrorSync } from '../../src/engine/publish.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import { mirrorKey, projectOp } from '../../src/holds/mirror.js';
import type { CoreFixture, PeerFixture } from '../helpers/coreFixture.js';
import { T9, t9 } from '../helpers/maskFixture.js';
import { durableAt, durableNow, holdOpsOf, holdPatch, opLine, plantOwn, remoteTip, win } from '../helpers/mirrorFixture.js';
import { buf, LogRecorder, prep, pushCalls, withCores } from '../helpers/publishHelpers.js';
import { restartCore } from '../helpers/startFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const P = 'src/t9.txt';
const FILES: Record<string, Buffer> = {
  'README.md': buf('# mirror rejections fixture\n'),
  [P]: buf(T9),
  'src/a.txt': buf('a1\na2\na3\n'),
};
const REVERT_ONLY = [{ name: 'revert', class: 'DECISION', owner: 'HLD' }];

/** The HOLD_MIRROR_REJECTED log lines of record id. */
const told = (log: LogRecorder, id: string): Array<Record<string, unknown>> => log.lines.filter((l) => l.code === 'HOLD_MIRROR_REJECTED' && l.params['hold_id'] === id).map((l) => ({ ...l.params }));

/** Record id's projection as an op line under `opId` at (rev, prev_rev), with `over` applied (a planted op of the same record). */
function planted(p: PeerFixture, id: string, opId: string, rev: number, prev: number | null, over: Record<string, unknown> = {}): string {
  return opLine(opId, { ...projectOp(p.core.holds.get(id)!, prev), rev, prev_rev: prev, ...over });
}

/** A `join` PIN over 300 LIVE paths `src/gen/f<nnn>-<40 × 'x'>.txt`: its op line is about 18 KB (over 16 KiB). */
async function bigPin(p: PeerFixture): Promise<string> {
  const it = await prep(p);
  const paths = Array.from({ length: 300 }, (_, i) => `src/gen/f${String(i).padStart(3, '0')}-${'x'.repeat(40)}.txt`);
  await ensureAttrs(p.core, it.epochBase, paths);
  const y = await p.core.repo.hashBytes(buf('generated\n'), true);
  const id = await p.core.holds.hold({
    kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths,
    blobs: { h0: Object.fromEntries(paths.map((q) => [q, ABSENT])), h1: Object.fromEntries(paths.map((q) => [q, y])) },
    guard: 'join', origin: 'human', cs_ids: [], displaced_by: null,
  });
  assert.equal(p.core.holds.get(id)!.local_only, false, 'LIVE paths: a mirrored record, not a stub');
  return id;
}

/** A validator rejection of r: a board commit under P1's own writer id carries an op for r whose path fails SEC-35. */
async function plantValidator(fx: CoreFixture, p: PeerFixture, id: string): Promise<Oid> {
  return plantOwn(fx, p, await prep(p), (opId) => [planted(p, id, opId(0), 1, null, { paths: ['docs/12:30-notes.md'] })]);
}

test('05 F6: hold ops rejected \'(failed)\' twice and then accepted land in the third window with no host-reject record', T10, async () => {
  await withCores('mrej-f6', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prep(p);
    const { id } = await holdPatch(p, P, t9([4, 'four held']));
    await fx.remote.rejectNext(2, 'transient-failed', '/board');
    assert.equal((await win(fx, p)).r.outcome, 'transient');
    assert.equal((await win(fx, p, 31_000)).r.outcome, 'transient');
    const third = await win(fx, p, 61_000);
    assert.equal(third.r.outcome, 'landed', JSON.stringify(third.r));
    assert.deepEqual((await holdOpsOf(p, third.r.bnew!)).map((o) => [o.hold_id, o.prev_rev]), [[id, null]]);
    assert.deepEqual(p.core.holds.all().filter((r) => r.guards.some((g) => g.name === 'host-reject')), [], 'no host-reject record');
    assert.equal(p.core.view!.meta.nonretryable, null);
    assert.equal(await durableNow(p, id), true);
  });
});

test('every stale prev_rev rejection is re-drafted from the folded rev and never makes the record HOLD_MIRROR_REJECTED', T10, async () => {
  await withCores('mrej-race', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const log = new LogRecorder();
    p.deps.log = log;
    await prep(p);
    const { id } = await holdPatch(p, P, t9([4, 'four held']));
    assert.equal((await win(fx, p)).r.outcome, 'landed', 'rev 1 folded');
    await p.core.holds.addGuard(id, 'join');   // registry rev 2
    /**
     * The window carrying r's pending op {rev, prev} is rejected by the host (the op keeps its seq); a test-written commit under
     * P1's writer id and next seq then lands an op of r at the same (rev, prev_rev) showing an older state (no join guard);
     * P1's op lands after it and folds as a prev_rev rejection.
     */
    const race = async (rev: number, prev: number): Promise<void> => {
      await fx.remote.rejectNext(1, 'transient-failed', '/board');
      const w = await win(fx, p);
      assert.equal(w.r.outcome, 'transient', JSON.stringify(w.r));
      assert.deepEqual((await holdOpsOf(p, w.r.bnew!)).map((o) => [o.rev, o.prev_rev]), [[rev, prev]], 'exactly this op of r');
      assert.ok(fx.trace.ofKind('mirror').some((e) => e.bnew === w.r.bnew && e.holds.some((h) => h.id === id)), 'its mirror trace event lists r');
      const sent = p.core.outbox.allocatedHold(id);
      assert.deepEqual([sent?.rev, sent?.prev_rev], [rev, prev], 'P1\'s op is allocated');
      await plantOwn(fx, p, await prep(p), (opId) => [planted(p, id, opId(0), rev, prev, { guards: REVERT_ONLY })]);
      await prep(p);   // the fetch that reveals the planted commit moves the governor's anchor; the next window waits G_eff and the 30 s backoff from it
      const landed = await win(fx, p, 31_000);
      assert.equal(landed.r.outcome, 'landed', JSON.stringify(landed.r));
      assert.deepEqual((await holdOpsOf(p, landed.r.bnew!)).map((o) => [o.rev, o.prev_rev]), [[rev, prev]], 'P1\'s op, renumbered, lands after the planted one');
    };
    await race(2, 1);
    // The rejection is drained at the next fold: one re-draft from the folded rev 2, also when two windows see the same tip.
    const it = await prep(p);
    assert.equal(it.fold.holds[id]?.rev, 2);
    assert.deepEqual((await mirrorSync(p.core, it)).drafted, [id]);
    assert.deepEqual((await mirrorSync(p.core, it)).drafted, [], 'at most one re-draft per folded rejection');
    const pending = p.core.outbox.pendingHold(id);
    assert.deepEqual([pending?.rev, pending?.prev_rev], [3, 2], 're-drafted {prev_rev: 2}');
    // The same planting against the re-drafted op: re-drafted again from the folded rev 3.
    await race(3, 2);
    const final = await win(fx, p);
    assert.equal(final.r.outcome, 'landed', JSON.stringify(final.r));
    assert.deepEqual((await holdOpsOf(p, final.r.bnew!)).map((o) => [o.rev, o.prev_rev]), [[4, 3]], 're-drafted {prev_rev: 3}');
    assert.equal(await durableNow(p, id), true, 'durable after the third op folds');
    assert.ok(!Object.hasOwn(p.core.holds.local().rejected, id), 'local.rejected never names r');
    assert.deepEqual(told(log, id), [], 'HOLD_MIRROR_REJECTED is never raised (and no log line for the races)');
    assert.notEqual(p.core.holdCode?.code, 'HOLD_MIRROR_REJECTED');
  });
});

test('a validator rejection is never re-issued and is told once', T10, async () => {
  await withCores('mrej-validator', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const log = new LogRecorder();
    p.deps.log = log;
    await prep(p);
    const { id, h0, h1 } = await holdPatch(p, P, t9([4, 'four held']));
    const tip = await plantValidator(fx, p, id);
    const pushes = pushCalls(p);   // the planted push is this peer's runner's
    for (let i = 0; i < 10; i++) {
      const { r } = await win(fx, p);
      assert.equal(r.outcome, 'nothing', `window ${i}: ${JSON.stringify(r)}`);
    }
    assert.equal(await remoteTip(fx, p), tip, 'no hold op for r is pushed');
    assert.equal(pushCalls(p), pushes);
    assert.deepEqual(p.core.holds.local().rejected[id], { key: mirrorKey(p.core.holds.get(id)!), reason: 'validator' });
    assert.deepEqual(told(log, id), [{ hold_id: id, reason: 'validator' }], 'told once over 10 windows');
    assert.deepEqual(p.core.holdCode, { code: 'HOLD_MIRROR_REJECTED', params: { hold_id: id, reason: 'validator' } });
    const r = p.core.holds.get(id)!;
    assert.deepEqual([r.residence, r.state], ['ON_DISK', 'ACTIVE'], 'the record stays ON_DISK, never parked');
    for (const o of [h0, h1]) assert.ok(await p.core.repo.hasObject(o as Oid, 'blob'), 'every blob kept');
    assert.equal(await durableNow(p, id), false);
    // The record's mirror key changes: one op, and local.rejected is cleared once it is durable.
    await p.core.holds.addGuard(id, 'join');
    const { r: next } = await win(fx, p);
    assert.equal(next.outcome, 'landed', JSON.stringify(next));
    assert.deepEqual((await holdOpsOf(p, next.bnew!)).map((o) => [o.hold_id, o.prev_rev]), [[id, null]]);
    assert.equal((await win(fx, p)).r.outcome, 'nothing');
    assert.ok(!Object.hasOwn(p.core.holds.local().rejected, id), 'cleared once durable');
    assert.equal(await durableNow(p, id), true);
    assert.equal(told(log, id).length, 1);
  });
});

test('a restart does not re-issue a rejected key', T10, async () => {
  await withCores('mrej-restart', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const log = new LogRecorder();
    p.deps.log = log;
    await prep(p);
    const { id } = await holdPatch(p, P, t9([4, 'four held']));
    await plantValidator(fx, p, id);
    const pushes = pushCalls(p);   // the planted push is this peer's runner's
    assert.equal((await win(fx, p)).r.outcome, 'nothing');
    assert.equal(p.core.holds.local().rejected[id]?.reason, 'validator');
    await restartCore(p);
    assert.deepEqual(await mirrorSync(p.core, await prep(p)), { drafted: [], rejected: [] }, 'nothing drafted for r, nothing raised');
    assert.equal(p.core.holdCode, null);
    assert.equal(told(log, id).length, 1);
    for (let i = 0; i < 3; i++) assert.equal((await win(fx, p)).r.outcome, 'nothing');
    assert.equal(pushCalls(p), pushes);
  });
});

test('Review Focus 4: a PIN whose op line exceeds 16 KiB is a local rejection', T10, async () => {
  await withCores('mrej-16k', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const log = new LogRecorder();
    p.deps.log = log;
    const id = await bigPin(p);
    const tip = await remoteTip(fx, p);
    for (let i = 0; i < 10; i++) assert.equal((await win(fx, p)).r.outcome, 'nothing', `window ${i}`);
    assert.equal(await remoteTip(fx, p), tip, 'never in any Bnew');
    assert.equal(pushCalls(p), 0);
    assert.equal(p.core.outbox.size, 0);
    assert.deepEqual(told(log, id), [{ hold_id: id, reason: 'validator' }], 'HOLD_MIRROR_REJECTED once');
    assert.equal(p.core.holds.local().rejected[id]?.reason, 'validator');
    assert.equal(await durableNow(p, id), false);
  });
});

test('T-PRO-13 variant, durability half: a HOLD_MIRROR_REJECTED record stays non-durable at 24 virtual hours', T10, async () => {
  await withCores('mrej-24h', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const rejected = await bigPin(p);
    const { id: mirrored } = await holdPatch(p, 'src/a.txt', 'a1\na2 held\na3\n');
    assert.equal((await win(fx, p)).r.outcome, 'landed');
    assert.equal(p.core.holds.local().rejected[rejected]?.reason, 'validator');
    fx.advance(24 * 3_600_000);
    const it = await prep(p);
    assert.ok(p.core.holds.ageMs(p.core.holds.get(rejected)!) >= 24 * 3_600_000);
    assert.ok(p.core.holds.ageMs(p.core.holds.get(mirrored)!) >= 24 * 3_600_000, 'the same age');
    assert.equal(await durableAt(p, it, rejected), false);
    assert.equal(await durableAt(p, it, mirrored), true);
  });
});
