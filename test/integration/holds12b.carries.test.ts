// The controller's carries addressed to Plan 3 Task 12b (impl-12b.md "Controller notes", items 2–7; item 1, the hold-code slot's
// clearing rule, is in escalation.test.ts): Engine.resolve under a live INCIDENT is a coded refusal (2); a copy-restore copy a crash
// left before its RESTORE completed is recognised and settled at restart (3); a hold operator never decides on a path the tick excluded
// or on a pre-image the disk no longer holds, and a holdPaths-only materialization settles no edit-checkpoint candidate (4); the
// governor's pending input withholds code in the iteration that formed the post-resume MASS batch, as publishStep does (5); a signal
// delivered before start() is replayed by the start (6). Item 7 (the start-time capture through captureStep) is in startHolds.test.ts.
// Real clones of one file:// remote (makeCores / makeEngines); git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utimes, writeFile } from 'node:fs/promises';
import { createEngineCore, markBatchFormed, materializedFor, materializedOver } from '../../src/engine/core.js';
import { captureStep, queueSignal } from '../../src/engine/csStep.js';
import { park } from '../../src/engine/holdOps.js';
import { Engine } from '../../src/engine/loop.js';
import { handOverThrottleFor, mirrorSync, publishPending } from '../../src/engine/publish.js';
import { resolve } from '../../src/engine/resolve.js';
import { restart } from '../../src/engine/restart.js';
import { KilledAt, setCrashHandler } from '../../src/ports/crashpoint.js';
import type { CsSignal } from '../../src/holds/signals.js';
import { readWork, workPath, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { withEngines } from '../helpers/engineFixture.js';
import { blob, nr, pair, prepIt, withMaps, withPeers } from '../helpers/holdOpsFixture.js';
import { forceRemote } from '../helpers/incidentFixture.js';
import { T9, t9 } from '../helpers/maskFixture.js';
import { win } from '../helpers/mirrorFixture.js';
import { roundsUntil, T10 } from '../helpers/loopHoldsFixture.js';
import { buf, editAndCapture, withCores } from '../helpers/publishHelpers.js';
import { HUMAN, landHoldOps } from '../helpers/resolveFixture.js';

const P = 'src/t9.txt';
const Q = 'src/q9.txt';
const SEAT = 'a'.repeat(32);

test('carry 2: Engine.resolve under a live INCIDENT returns a coded refusal with its next command (HOLD_FROZEN {hid, reason: INCIDENT}), never a throw', T10, async () => {
  await withEngines('c12b-incident', { n: 1, files: { 'README.md': buf('# incident\n'), 'x.txt': buf('x\n') } }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    await fx.rounds(2);
    const A = await p.core.repo.readTreeMap(p.core.view!.base);
    const id = await p.core.holds.hold({ kind: 'PATCH', residence: 'OFF_DISK', state: 'PARKED', paths: ['x.txt'], guard: 'revert', origin: 'human', cs_ids: [], displaced_by: null, blobs: { h0: { 'x.txt': A.get('x.txt')!.oid }, h1: { 'x.txt': await p.core.repo.hashBytes(buf('x held\n'), true) } } });
    const { board: B1 } = await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
    await roundsUntil(fx, async () => (await readWork(p, 'x.txt'))?.toString('utf8') === 'x v1\n', 'applied');
    const B0 = (await p.core.repo.readCommit(B1)).parents[0]!;
    await forceRemote(fx, p, p.core.refs.remoteBoard, B0);   // the remote board rewound: board_not_ff
    await fx.rounds(1);
    assert.ok(p.core.view!.meta.freeze_reasons.includes('INCIDENT'), 'the loop entered the incident');
    const r = await fx.resolve(0, id, 'restore');
    assert.deepEqual(r, { kind: 'refused', code: 'HOLD_FROZEN', params: { hid: id, reason: 'INCIDENT' } });
    assert.equal(p.core.holds.get(id)!.residence, 'OFF_DISK', 'nothing changed');
  });
});

/** Peer 0 holds a revert record over P, parked and mirrored with its held/ subtree; then its leave op folds (resolve.copyrestore's setup). */
async function foreignParked(fx: CoreFixture): Promise<{ p: PeerFixture; rev: string }> {
  const p = fx.peers[0]!;
  await writeWork(p, P, t9([2, 'two'], [6, 'six']));
  const it0 = await prepIt(p, { materialize: false });
  const a = it0.A.get(P)!.oid;
  const rev = await p.core.holds.hold(nr({ paths: [P], blobs: pair(a, await blob(p, t9([2, 'two'])), P) }));
  const it = await prepIt(p, { holdPaths: [P] });
  assert.equal((await resolve(p.core, it, rev, 'park', HUMAN)).kind, 'done');
  await landHoldOps(fx, p);
  p.core.outbox.add({ type: 'leave' });
  for (let i = 0; i < 6 && p.core.outbox.size > 0; i++) await win(fx, p);
  assert.equal(p.core.outbox.size, 0, 'the leave op landed');
  return { p, rev };
}

test('carry 3: a crash inside a copy-restore after the copy was created leaves no live copy: restart recognises it (local.json copies) and ends it GONE, and the human\'s repeat restores from a fresh copy', T10, async () => {
  for (const nth of [2, 4]) {
    await withCores(`c12b-copycrash-${nth}`, { n: 2, files: { 'README.md': buf('# copy crash\n'), [P]: buf(T9), [Q]: buf(T9) } }, async (fx) => {
      const { rev } = await foreignParked(fx);
      const q = fx.peers[1]!;
      const it = await prepIt(q, { forceFetch: true, holdPaths: [P] });
      let hits = 0;
      setCrashHandler((name) => {
        if (name === 'registry.cas' && ++hits === nth) throw new KilledAt(name);
      });
      try {
        await assert.rejects(resolve(q.core, it, rev, 'restore', HUMAN), (e: unknown) => e instanceof KilledAt, `killed at registry.cas #${nth}`);
      } finally {
        setCrashHandler(null);
      }
      // A process restart of q.
      q.core = await createEngineCore(q.deps);
      const copies = q.core.holds.all().filter((r) => r.paths[0] === P);
      assert.equal(copies.length, 1, `#${nth}: the copy was created before the kill`);
      assert.deepEqual(Object.values(q.core.holds.local().copies), [rev], `#${nth}: marked as a copy of ${rev}`);
      await restart(q.core);
      const after = q.core.holds.get(copies[0]!.id)!;
      assert.equal(after.state, 'GONE', `#${nth}: no live OFF_DISK copy after the restart`);
      assert.deepEqual(q.core.holds.local().copies, {}, `#${nth}: the mark cleared`);
      assert.deepEqual(await readWork(q, P), Buffer.from(T9), `#${nth}: the disk untouched`);
      // The repeat restores from a fresh copy.
      const it2 = await prepIt(q, { forceFetch: true, holdPaths: [P] });
      const res = await resolve(q.core, it2, rev, 'restore', HUMAN);
      assert.equal(res.kind, 'done', JSON.stringify(res));
      assert.ok(res.kind === 'done' && res.created !== null && res.created !== copies[0]!.id, 'a fresh copy');
      assert.deepEqual(await readWork(q, P), Buffer.from(t9([2, 'two'])));
      assert.deepEqual(q.core.holds.local().copies, {}, 'a completed copy-restore leaves no mark');
      await mirrorSync(q.core, it2);
    });
  }
});

test('carry 4: materializedFor is false for a holdPaths path the tick excluded (a stale S_disk), park writes nothing and refuses MISMATCH when the target equals a pre-image the disk no longer holds, and a holdPaths-only materialization settles no candidate', T10, async () => {
  await withPeers('c12b-stale', { files: { 'README.md': buf('#\n'), [P]: buf(T9), 'src/u9.txt': buf(T9) } }, async (fx) => {
    const p = fx.peers[0]!;
    // (a) A path in its quiet period (an mtime of this PC's now): excluded by the tick, so not current for a hold operator.
    await writeFile(workPath(p, P), Buffer.from(t9([3, 'three']), 'utf8'));
    const now = p.clock.wallMs() / 1_000;
    await utimes(workPath(p, P), now, now);
    const it = await prepIt(p, { materialize: false, holdPaths: [P] });
    assert.ok(it.tick!.excluded.has(P), 'the tick excluded it');
    assert.equal(materializedOver(it, [P]), true, 'its last stable entry is in S_disk');
    assert.equal(materializedFor(it, [P]), false, 'not current for a hold operator');
    // (b) A revert PATCH whose held bytes are on disk, parked over an S_disk that still reads A (stale): the target equals that
    // pre-image, so nothing would be written — the park verifies the disk and refuses instead of parking the bytes unmasked.
    fx.advance(2_000);
    await writeWork(p, P, t9([2, 'two']));
    const it1 = await prepIt(p, { materialize: false });
    const a = it1.A.get(P)!.oid;
    const id = await p.core.holds.hold(nr({ paths: [P], blobs: pair(a, await blob(p, t9([2, 'two'])), P) }));
    const fresh = await prepIt(p, { holdPaths: [P] });
    const stale = withMaps(fresh, { sDisk: { [P]: a } });
    const out = await park(p.core, stale, id, { humanEvidence: true, displacedBy: null, refreshMustBeDurable: false });
    assert.deepEqual(out, { kind: 'MISMATCH' });
    assert.equal(p.core.holds.get(id)!.residence, 'ON_DISK', 'the record stays ON_DISK');
    assert.deepEqual(await readWork(p, P), Buffer.from(t9([2, 'two'])), 'nothing written');
    // (c) A seat's edit checkpoint pending while an iteration materializes only a hold-record occasion's paths.
    const effect: CsSignal = { kind: 'effect', seat: SEAT, agent: null, toolUseId: 'toolu_1', paths: ['src/u9.txt'], turnOrigin: 'prompt' };
    await writeWork(p, 'src/u9.txt', t9([5, 'five']));
    queueSignal(p.core, effect);
    await prepIt(p, { materialize: false });
    assert.equal(queueSignal(p.core, { kind: 'checkpoint', seat: SEAT, source: 'edit', candSeq: 1, paths: ['src/u9.txt'] }), true);
    const partial = await prepIt(p, { materialize: false, holdPaths: [P] });
    const r = await captureStep(p.core, partial);
    assert.deepEqual(r, { captured: [], candidates: [] }, 'no candidate settled from a partial S_disk');
    assert.equal(p.core.cs.pendingCandidates().length, 1, 'the candidate waits for a full materialization');
    const full = await prepIt(p, { materialize: true });
    assert.equal((await captureStep(p.core, full)).candidates.length, 1, 'settled at the next full materialization');
  });
});

// Fix round 1 (finding 2): the production path — the iteration fetch's throttle signal handed to the governor (handOverThrottleFor,
// publishStep's first act; R-18's otherPending) and PRO-42's publishPending — in a batch-forming iteration with only code pending.
test('carry 5: in the iteration whose massResumeStep formed the post-resume batch, with only code pending, the fetch\'s throttle signal counts no code as other pending work (handOverThrottleFor) and drafts no HOST_THROTTLED, and publishPending reports nothing, as publishStep withholds that code', T10, async () => {
  await withCores('c12b-batch', { n: 1, files: { 'README.md': buf('#\n'), [P]: buf(T9) } }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    await editAndCapture(fx, p, { [P]: t9([2, 'two']) });
    const seen: boolean[] = [];
    const onSignal = core.governor.onSignal.bind(core.governor);
    core.governor.onSignal = (s, fromPush, otherPending) => {
      seen.push(otherPending);
      return onSignal(s, fromPush, otherPending);
    };
    const throttleEvents = (): number => core.outbox.drafts().filter((d) => d.type === 'event' && (d as { reason_code?: string }).reason_code === 'HOST_THROTTLED').length;
    // The batch-forming iteration (massResumeStep's markBatchFormed): a ready group with an unpublished pair and no allowed board op.
    const it = await prepIt(p, { materialize: false, forceFetch: true });
    assert.ok(it.fetched !== null, 'the iteration fetched');
    assert.equal(core.cs.ready().length, 1, 'one ready pair');
    assert.equal(core.outbox.pendingAllowed(it.pushStates), false, 'only code is pending');
    markBatchFormed(it);
    assert.equal(await publishPending(core, it), false, 'publishPending: no code pending in the batch-forming iteration');
    handOverThrottleFor(core, it, { ...it.fetched, deferred: false, httpThrottle: 'http_429' });
    assert.deepEqual(seen, [false], 'the governor\'s otherPending counts no code');
    assert.equal(throttleEvents(), 0, 'no HOST_THROTTLED event drafted');
    // Control: the next iteration formed no batch, so the same code is other pending work.
    const it2 = await prepIt(p, { materialize: false, forceFetch: true });
    assert.ok(it2.fetched !== null, 'the iteration fetched');
    assert.equal(await publishPending(core, it2), true, 'publishPending: the code is pending');
    handOverThrottleFor(core, it2, { ...it2.fetched, deferred: false, httpThrottle: 'http_429' });
    assert.deepEqual(seen, [false, true], 'the governor\'s otherPending counts the code');
  });
});

test('carry 6: a signal delivered before start() is replayed into the change-set table the start restored (a join, and a restart)', T10, async () => {
  await withEngines('c12b-early', { n: 2, files: { 'README.md': buf('#\n'), 'g.txt': buf('g1\ng2\ng3\n'), 'h.txt': buf('h1\nh2\nh3\n') } }, async (fx) => {
    const [p, q] = fx.peers as [typeof fx.peers[number], typeof fx.peers[number]];
    const seatCs = (x: typeof p, path: string) => x.core.cs.table().cs.filter((e) => e.kind === 'seat' && e.seat === SEAT && e.paths.includes(path));
    const s0 = await p.engine.start({ publishLocal: null });
    assert.ok(s0.ok && s0.mode === 'genesis');
    // A join: the seat's hook fires before the joiner's start() (no state yet, so no CS cache either).
    await fx.signal(1, { kind: 'effect', seat: SEAT, agent: null, toolUseId: 'toolu_join', paths: ['h.txt'], turnOrigin: 'prompt' });
    const s1 = await q.engine.start({ publishLocal: null });
    assert.ok(s1.ok && s1.mode === 'join', JSON.stringify(s1));
    assert.equal(seatCs(q, 'h.txt').length, 1, 'the joiner\'s early effect is in the table');
    assert.equal(seatCs(q, 'h.txt')[0]!.state, 'open');
    await fx.rounds(2);
    // A capture of the loop journals the CS table (the start's restore then rebuilds the table from it and the cache).
    await writeWork(p, 'README.md', '# edited\n');
    fx.advance(21_000);
    await roundsUntil(fx, async () => p.core.view!.keep.has('cs') && p.core.cs.ready().length === 0, 'captured and published');
    await p.engine.drain(null);
    // A restart: a new Engine, and a seat's hook fires before its start() ran (the seat wrote g.txt meanwhile).
    const fresh = await Engine.create(p.deps);
    p.engine = fresh;
    p.core = fresh.core;
    await writeWork(p, 'g.txt', 'g1\ng2 seat\ng3\n');
    await fx.signal(0, { kind: 'effect', seat: SEAT, agent: null, toolUseId: 'toolu_early', paths: ['g.txt'], turnOrigin: 'prompt' });
    const r = await fresh.start({ publishLocal: null });
    assert.ok(r.ok && r.mode === 'restart', JSON.stringify(r));
    assert.equal(seatCs(p, 'g.txt').length, 1, 'the early effect is in the table');
    assert.equal(seatCs(p, 'g.txt')[0]!.state, 'open');
    await fx.rounds(2);
    assert.equal(seatCs(p, 'g.txt').length, 1, 'still the seat\'s');
    assert.ok(!p.core.cs.table().cs.some((e) => e.kind !== 'seat' && e.paths.includes('g.txt')), 'no human CS took the seat\'s change');
  });
});
