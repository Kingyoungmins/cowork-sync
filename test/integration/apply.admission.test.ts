// Ruling R3-EF4-26 (delta review C2, final review F11's rule at the apply; 01-engine §3.5 steps 3 and 5): the apply admission of one
// iteration is decided once, by prepareIteration with its materialization (step 3 materializes "only when this iteration … applies
// (step 5 admitted)"), and applyStep uses that decision — never a later clock. Before it, an iteration prepared just inside the 10 s
// coalescing window (no materialization: the apply was coalesced and no capture was due) whose applyStep ran just after the window
// materialized there, after detectStep: the revert detector (HLD-27/HLD-28) never saw the deltas that materialization moved into the
// private index, and a teammate row the human's stale save removed published (INV-HLD-NOREVERT). Only join's first apply (R3-59) keeps
// its own materialization. Real git on file:// clones; never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APPLY_COALESCE_MS, applyStep } from '../../src/engine/apply.js';
import { prepareIteration } from '../../src/engine/core.js';
import { revertStep } from '../../src/engine/detect.js';
import { detectStep } from '../../src/engine/holdSteps.js';
import { publishStep } from '../../src/engine/publish.js';
import { LEASE_STOP_SYNC_MS, type LeasePort } from '../../src/ports/lease.js';
import { readWork, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { withEngines } from '../helpers/engineFixture.js';
import { P, prepIt, withPeers } from '../helpers/holdOpsFixture.js';
import { remoteLiveFiles } from '../helpers/loopHoldsFixture.js';
import { T9 } from '../helpers/maskFixture.js';
import { blobText, buf, captureReady, prep, remoteLiveCode, treeOf } from '../helpers/publishHelpers.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };
const TEAM = T9.replace('3\n', '3\nteam row 3a\n');
const reverts = (p: PeerFixture): string[] => p.core.holds.nonTerminal().filter((r) => r.guards.some((g) => g.name === 'revert')).map((r) => r.id);

/**
 * The teammate's row 3a applied at t; the human's stale buffer then drops it and another teammate change makes the next apply needed;
 * the next iteration is prepared `offset` ms after the coalescing window ends (negative: inside it) and its applyStep runs `late` ms
 * after the prepare, as the loop runs detectStep (3D), the mask and the capture in between.
 */
async function staleSaveIteration(p: PeerFixture, fx: CoreFixture, offset: number, late: number) {
  const clock = p.core.deps.ports.clock;
  await fx.pushTeamChange({ [P]: buf(TEAM) });
  fx.advance(10_000);
  const a1 = await applyStep(p.core, await prepIt(p, { forceFetch: true }));
  assert.ok(a1.written.includes(P), JSON.stringify(a1));
  // Settle: a tick, then a materializing iteration with revertStep (no delta: the applied bytes are no local change).
  await prepIt(p);
  fx.advance(1_500);
  assert.deepEqual(await revertStep(p.core, await prepIt(p, { materialize: true })), []);
  await writeWork(p, P, T9);
  await fx.pushTeamChange({ 'src/other.txt': buf('other changed\n') });
  fx.advance(APPLY_COALESCE_MS - (clock.monoMs() - p.core.lastApplyMono!) + offset);
  const it = await prepIt(p, { forceFetch: true });   // the loop's 'auto'
  const matInPrepare = it.mat !== null;
  await detectStep(p.core, it);
  const revertsAtDetect = reverts(p).length;
  fx.advance(late);
  const lateNow = clock.monoMs() - p.core.lastApplyMono!;
  const apply = await applyStep(p.core, it);
  return { it, apply, lateNow, matInPrepare, revertsAtDetect };
}

test('R3-EF4-26: an iteration prepared inside the coalescing window does not apply although its applyStep runs after the window; the next iteration materializes in prepare, its revertStep holds the teammate-row removal, and the live chain keeps the row', T10, async () => {
  await withPeers('apply-admission-cross', {}, async (fx) => {
    const p = fx.peers[0]!;
    const { it, apply, lateNow, matInPrepare, revertsAtDetect } = await staleSaveIteration(p, fx, -100, 200);
    assert.equal(matInPrepare, false, 'prepare made no materialization (the apply coalesced, no capture due)');
    assert.equal(revertsAtDetect, 0, 'so detectStep ran no revertStep');
    assert.ok(lateNow >= APPLY_COALESCE_MS, 'applyStep ran after the window ended');
    assert.deepEqual([apply.ran, apply.skipped], [false, 'coalesced'], 'prepare\'s decision binds applyStep: no apply, no materialization after detectStep');
    assert.equal(it.mat, null, 'applyStep materialized nothing');
    assert.deepEqual(it.admission?.skipped, 'coalesced', 'the decision is on the iteration context');
    // The next iteration: admitted at prepare, which materializes for it; detectStep's revertStep sees the stale save's delta.
    fx.advance(1_500);
    const it2 = await prepIt(p, { forceFetch: true });
    assert.equal(it2.admission?.skipped, null, 'admitted');
    assert.notEqual(it2.mat, null, 'prepare materialized for the admitted apply');
    await detectStep(p.core, it2);
    assert.equal(reverts(p).length, 1, 'a revert record holds the teammate row the human removed (HLD-27, INV-HLD-NOREVERT)');
    const a2 = await applyStep(p.core, it2);
    assert.equal(a2.ran, true, JSON.stringify(a2.skipped));
    assert.ok(a2.written.includes('src/other.txt'), JSON.stringify(a2.written));
    // The human CS closes after its quiet period and publishes: the live chain keeps the teammate's row.
    fx.advance(21_000);
    const it4 = await prep(p, true);
    await detectStep(p.core, it4);
    await captureReady(p, it4);
    fx.advance(3_000);
    const it5 = await prepIt(p, { forceFetch: true });
    await detectStep(p.core, it5);
    await publishStep(p.core, it5);
    const text = await blobText(p, await treeOf(p, await remoteLiveCode(fx, p)), P);
    assert.ok(text?.includes('team row 3a'), `the live chain keeps the teammate's row: ${JSON.stringify(text)}`);
  });
});

test('R3-EF4-26 control: the iteration prepared after the coalescing window materializes in prepare, so detectStep holds the removal and the apply runs', T10, async () => {
  await withPeers('apply-admission-ctrl', {}, async (fx) => {
    const p = fx.peers[0]!;
    const { apply, matInPrepare, revertsAtDetect } = await staleSaveIteration(p, fx, 100, 200);
    assert.equal(matInPrepare, true, 'prepare materialized for the admitted apply');
    assert.equal(revertsAtDetect, 1, 'detectStep\'s revertStep held the removal');
    assert.equal(apply.ran, true);
  });
});

test('R3-EF4-26: prepareIteration records its admission and the instant it decided at; applyStep reports that decision and stamps the apply with its own instant', T10, async () => {
  await withPeers('apply-admission-stamp', {}, async (fx) => {
    const p = fx.peers[0]!;
    const clock = p.core.deps.ports.clock;
    await fx.pushTeamChange({ [P]: buf(TEAM) });
    fx.advance(10_000);
    const it = await prepIt(p, { forceFetch: true });
    assert.deepEqual(it.admission, { now: clock.monoMs(), skipped: null });
    fx.advance(700);
    const a = await applyStep(p.core, it);
    assert.equal(a.ran, true);
    assert.equal(p.core.lastApplyMono, clock.monoMs(), 'the coalescing stamp is the apply\'s own instant (≤ 1 apply per 10 s by apply time, glossary §20)');
    // Nothing applicable: the decision says so and applyStep reports it.
    fx.advance(10_000);
    const it2 = await prepIt(p, { forceFetch: true });
    assert.equal(it2.admission?.skipped, 'nothing');
    assert.equal((await applyStep(p.core, it2)).skipped, 'nothing');
    // A context prepared without materialization (join's first-apply shape) and admitted: applyStep materializes for itself.
    await fx.pushTeamChange({ 'src/other.txt': buf('other again\n') });
    fx.advance(10_000);
    const r = await prepareIteration(p.core, 9_999, { materialize: false, forceFetch: true });
    assert.ok(r.ok);
    assert.equal(r.it.mat, null);
    assert.equal(r.it.admission?.skipped, null);
    const a3 = await applyStep(p.core, r.it);
    assert.equal(a3.ran, true);
    assert.notEqual(r.it.mat, null, 'the bare materialization (R3-59)');
  });
});

test('R3-EF4-26: a loop iteration whose step-0 lease read stopped syncing admits no apply when the lease renews during its fetch — no materialization after detectStep; the next iteration applies', T10, async () => {
  await withEngines('apply-admission-lease', { n: 2 }, async (fx) => {
    await fx.startAll();
    await fx.rounds(3);
    const [p1, p2] = fx.peers as [typeof fx.peers[0], typeof fx.peers[0]];
    // p2 changes a file and publishes it; p1's next iteration would apply it.
    await writeWork(p2, 'lease.txt', 'from p2\n');
    for (let i = 0; i < 24 && (await remoteLiveFiles(fx, p2)).get('lease.txt') === undefined; i++) {
      fx.advance(2_500);
      await p2.engine.iterate();
    }
    assert.equal((await remoteLiveFiles(fx, p2)).get('lease.txt'), 'from p2\n', 'p2 published');
    // p1 has not iterated since: its lease read at step 0d says 3 min without a lease; the lease renews while it fetches.
    let renewed = false;
    const lease: LeasePort = { idleMs: () => (renewed ? 0 : 180_000) };
    p1.deps.lease = lease;
    const fetcher = p1.core.fetcher;
    const fetch = fetcher.fetch.bind(fetcher);
    fetcher.fetch = async (force) => {
      renewed = true;
      return fetch(force);
    };
    assert.ok(180_000 >= LEASE_STOP_SYNC_MS);
    fx.advance(10_000);
    const r = await p1.engine.iterate();
    assert.equal(renewed, true, 'the lease renewed during the fetch');
    assert.equal(r.applied, false, 'no apply in an iteration whose own lease read stopped syncing');
    assert.equal(await readWork(p1, 'lease.txt'), null);
    fx.advance(2_500);
    const r2 = await p1.engine.iterate();
    assert.equal(r2.applied, true, 'the next iteration (lease valid at its step 0) applies');
    assert.equal((await readWork(p1, 'lease.txt'))?.toString('utf8'), 'from p2\n');
  });
});
