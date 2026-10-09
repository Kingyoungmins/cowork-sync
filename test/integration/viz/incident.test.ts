// Plan 8a Task 8: the incident freeze and the rebuild (12 §3.3.3, §6 "Board rewritten … or status.json.state = incident"; VIZ-14;
// R-V21): a non-fast-forward rewrite, or status.json state 'incident', folds nothing of the new chain and freezes the room at its
// last folded scene; only after this PC's daemon reports a non-incident state with a heartbeat newer than the one at the freeze,
// and fresh by 12 §3.3.6, is the room rebuilt from the current tip on its old layout (desks keep their ordinals) and reported as
// 'rebuilt' (the page reloads the world). And 12 §6's gone row (Task 8 fix round 1): a gitdir that moved or was deleted greys the
// room out, keeps its history and stops its git. Real boards in a clone on a file:// remote; status.json written by the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, renameSync } from 'node:fs';
import type { Layout } from '../../../src/viz/model/layout.js';
import { BoardWriter } from '../../../tools/viz/boardWriter.js';
import { VirtualClock } from '../../sim/vclock.js';
import { makeRepoFixture } from '../../helpers/repoFixture.js';
import { kinds } from '../../helpers/vizSource.js';
import { gitRoom, pubs, reference, ticksOf, writeStatus, type GitRoom } from '../../helpers/vizStore.js';

/** The machine-wide monotonic clock the overlay reads (12 §3.3.6), moved by the test. */
const machine = { now: 1_000_000 };
const status = (gitDir: string, state: string, heartbeat: number): void => writeStatus(gitDir, { state, heartbeat_mono_ms: heartbeat, loop_period_ms: 2_500 });

async function frozenTicks(r: GitRoom, clock: VirtualClock, n: number): Promise<void> {
  const folds = r.spy.folds, frames = r.spy.frames.length;
  for (let i = 0; i < n; i++) {
    clock.advance(2_500);
    const t = await r.store.tick();
    assert.deepEqual([t.delta, t.change], [null, null], `frozen tick ${i}`);
  }
  assert.deepEqual([r.spy.folds, r.spy.frames.length], [folds, frames], 'nothing folded while frozen');
}

/** Every desk of `before` is in `after` with its ordinal and key (VIZ-16, R-V21). */
function keepsDesks(before: Layout, after: Layout): void {
  assert.deepEqual(after.desks.slice(0, before.desks.length), before.desks);
  assert.deepEqual(after.homeOrder.slice(0, before.homeOrder.length), before.homeOrder);
}

test('T-VIZ-incident: a non-fast-forward rewrite, or status.json state incident, folds nothing of the new chain and freezes the room with UI_VIZ_INCIDENT_FROZEN; after a non-incident state with a fresh heartbeat the room is rebuilt from the new tip on its old layout and reports rebuilt', async () => {
  const fx = await makeRepoFixture('viz-incident');
  try {
    const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'main', seed: 'incident' });
    await w.genesis('ann');
    await w.join('bob');
    await w.commitMany(pubs(60, 'first'));
    const git = fx.paths.gitDir;
    status(git, 'ok', machine.now);
    const clock = new VirtualClock();
    const r = gitRoom(fx, w.ref, { clock, deps: { machineMonoMs: () => machine.now } });
    await r.store.init();
    const held = r.store.snapshot();
    assert.deepEqual([held.window, held.badges], [{ h0: 0, h1: 61 }, []]);

    // 1. A rewrite: the board diverges at 40 and grows with new paths. Nothing of the new chain is folded.
    await w.rewrite(40);
    await w.commitMany(pubs(30, 'second'));
    clock.advance(2_500);
    const calls = r.git.calls.length;
    const folds = r.spy.folds;
    const frozen = await r.store.tick();
    assert.deepEqual([frozen.delta, frozen.change], [null, 'state']);
    assert.ok(!kinds(r.git.calls.slice(calls)).some((k) => k.startsWith('cat-file')), 'no board commit of the new chain is read');
    assert.equal(r.spy.folds, folds);
    let m = r.store.snapshot();
    assert.deepEqual([m.window, m.badges, m.scene, m.cards, m.layout], [held.window, ['UI_VIZ_INCIDENT_FROZEN'], held.scene, held.cards, held.layout], 'the last folded scene stays');
    // Still frozen: the same heartbeat; then this PC's daemon in state incident (fresh); then 'ok' with a stale heartbeat.
    await frozenTicks(r, clock, 2);
    machine.now += 2_500;
    status(git, 'incident', machine.now);
    await frozenTicks(r, clock, 2);
    status(git, 'ok', machine.now);
    machine.now += 3 * 2_500 + 1;
    await frozenTicks(r, clock, 1);
    // What is held is still served.
    assert.ok((await r.store.page(10, 20)) !== null);

    // A non-incident state with a fresh heartbeat newer than the freeze's: rebuilt from the new tip on the old layout.
    status(git, 'ok', machine.now - 100);
    clock.advance(2_500);
    const thawed = await r.store.tick();
    assert.deepEqual([thawed.delta, thawed.change], [null, 'rebuilt']);
    m = r.store.snapshot();
    const ref = await reference(fx, w.ref, 0, held.layout);
    assert.deepEqual([m.window, m.badges], [{ h0: 0, h1: 70 }, []]);
    assert.deepEqual(m.scene, ref.carry.scene);
    assert.deepEqual(m.layout, ref.timeline.layout);
    keepsDesks(held.layout, m.layout);
    assert.ok(m.layout.desks.some((d) => d.key.startsWith('second/')), 'the new chain\'s paths appended');
    assert.deepEqual(m.ticks, ticksOf(ref.timeline.events));
    assert.ok(m.cards.every((c) => c.foldedAt === null), 'the rebuilt window has no seen anchor');
    // It follows the new chain from there.
    await w.commitMany(pubs(2, 'third'));
    clock.advance(2_500);
    const t = await r.store.tick();
    assert.deepEqual([t.change, t.delta?.kind, t.delta?.window], [null, 'timeline', { h0: 0, h1: 72 }]);

    // 2. status.json state 'incident' without a rewrite: frozen, even with fast-forward commits waiting.
    const layout2 = r.store.snapshot().layout;
    const at2 = r.store.snapshot();
    status(git, 'incident', machine.now);
    await w.commitMany(pubs(3, 'fourth'));
    clock.advance(2_500);
    const folds2 = r.spy.folds;
    const frozen2 = await r.store.tick();
    assert.deepEqual([frozen2.delta, frozen2.change, frozen2.overlay?.state], [null, 'state', 'incident']);
    assert.equal(r.spy.folds, folds2, 'nothing folded while the state is incident');
    m = r.store.snapshot();
    assert.deepEqual([m.window, m.badges, m.scene], [at2.window, ['UI_VIZ_INCIDENT_FROZEN'], at2.scene]);
    await frozenTicks(r, clock, 2);
    machine.now += 2_500;
    status(git, 'ok', machine.now);
    clock.advance(2_500);
    const thawed2 = await r.store.tick();
    assert.deepEqual([thawed2.delta, thawed2.change], [null, 'rebuilt']);
    m = r.store.snapshot();
    const ref2 = await reference(fx, w.ref, 0, layout2);
    assert.deepEqual([m.window, m.badges, m.scene], [{ h0: 0, h1: 75 }, [], ref2.carry.scene]);
    keepsDesks(layout2, m.layout);
  } finally {
    await fx.cleanup();
  }
});

test('gone (12 §6): a gitdir that moved or was deleted greys the room out at the next tick — a state change, the last scene and history kept — and no git process runs for it again', async () => {
  const fx = await makeRepoFixture('viz-gone');
  const git = fx.paths.gitDir, moved = `${fx.paths.gitDir}-moved`;
  try {
    const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'main', seed: 'gone' });
    await w.genesis('ann');
    await w.join('bob');
    await w.commitMany(pubs(10));
    const clock = new VirtualClock();
    const r = gitRoom(fx, w.ref, { clock });
    await r.store.init();
    const held = r.store.snapshot();
    assert.deepEqual([held.window, held.gone, held.badges], [{ h0: 0, h1: 11 }, false, []]);
    renameSync(git, moved);
    const calls = r.git.calls.length;
    clock.advance(2_500);
    const t = await r.store.tick();
    assert.deepEqual([t.delta, t.change], [null, 'state']);
    let m = r.store.snapshot();
    assert.deepEqual([m.gone, m.window, m.scene, m.cards, m.ticks], [true, held.window, held.scene, held.cards, held.ticks], 'greyed out, its history kept');
    assert.ok((await r.store.page(1, 11)) !== null, 'what is held is still served');
    // Sticky until the viewer restarts (12 §6), even when the gitdir comes back: no git process from the tick that saw it gone on.
    renameSync(moved, git);
    for (let i = 0; i < 3; i++) {
      clock.advance(25_000);
      assert.deepEqual((await r.store.tick()).change, null);
    }
    m = r.store.snapshot();
    assert.deepEqual([m.gone, m.scene], [true, held.scene]);
    assert.equal(r.git.calls.length, calls, 'no git process for a gone room');
  } finally {
    if (existsSync(moved)) renameSync(moved, git);
    await fx.cleanup();
  }
});
