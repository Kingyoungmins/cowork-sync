// Plan 8a Task 8: the room store's initial window (12 §3.3.3; VIZ-09; R-V28): the window of a tip at t starts at
// h0 = 256·⌊max(0, t − 1,023)/256⌋ — from initialFoldState at 0 (frames from height 0), else from the checkpoint at h0 (frames
// from h0 + 1) — with the scene at the tip, the layout, the unknown count, the whole window's ticks and the last 200 cards (no
// seen anchor). Moved out of store.test.ts in fix round 1 to keep each file within the 60 s integration budget (one reference
// fold per tip). A real board in a clone on a file:// remote written by tools/viz/boardWriter.ts; a VirtualClock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZERO_PEER } from '../../../src/viz/model/frame.js';
import { BoardWriter } from '../../../tools/viz/boardWriter.js';
import { VirtualClock } from '../../sim/vclock.js';
import { makeRepoFixture } from '../../helpers/repoFixture.js';
import { script } from '../../helpers/vizSource.js';
import { gitRoom, reference, ticksOf } from '../../helpers/vizStore.js';

test('the window starts at 256·⌊max(0, t − 1,023)/256⌋', async () => {
  const fx = await makeRepoFixture('viz-store-window');
  try {
    const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'main', seed: 'store-window' });
    await w.genesis('ann');
    const clock = new VirtualClock();
    for (const [t, h0] of [[0, 0], [1, 0], [1_022, 0], [1_023, 0], [1_024, 0], [1_279, 256], [1_280, 256], [5_000, 3_840]] as const) {
      if (t === 1) await w.join('bob');
      else if (t > w.tip().height) await w.commitMany(script(t - w.tip().height));
      assert.equal(w.tip().height, t);
      const r = gitRoom(fx, w.ref, { clock });
      await r.store.init();
      assert.deepEqual(r.spy.startAt, [h0], `t = ${t}: one start state, at h0`);
      assert.deepEqual(r.spy.frames, [{ from: h0 === 0 ? 0 : h0 + 1, to: t, start: h0 === 0 ? -1 : h0, self: ZERO_PEER }],
        `t = ${t}: ${h0 === 0 ? 'initialFoldState, frames from height 0' : 'the checkpoint state at h0, frames from h0 + 1'}`);
      const m = r.store.snapshot();
      assert.deepEqual([m.window, m.badges, m.gone], [{ h0, h1: t }, [], false]);
      const ref = await reference(fx, w.ref, h0);
      assert.deepEqual(m.scene, ref.carry.scene, `t = ${t}: the scene at the tip`);
      assert.deepEqual(m.layout, ref.timeline.layout);
      assert.equal(m.unknown, ref.unknown);
      assert.deepEqual(m.ticks, ticksOf(ref.timeline.events), 'the ticks of the whole window');
      assert.deepEqual(m.cards, ref.timeline.cards.slice(-200).map((card) => ({ card, foldedAt: null })), 'the last 200 cards; no seen anchor (R-V28)');
    }
  } finally {
    await fx.cleanup();
  }
});
