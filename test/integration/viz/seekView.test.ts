// Plan 8a Task 8 (fix round 1, finding 1, controller ruling Option A): the page's RoomView (src/viz/ui/roomView.ts) over a real
// RoomStore — "load earlier" lines the page and the store up on the glossary's segments (a segment that starts at hs holds the
// heights hs + 1 up to the next segment's hs, the genesis segment from height 0), so the page holds the old h0's events and every
// height it holds, the old h0s included, reduces to the scene the server's reduceScene gives over the store's timeline (VIZ-26,
// 12 §3.3.5, §3.9.1, §3.10.5, R-V29). Real board in a clone on a file:// remote; the page's io calls the store directly (the
// model-typed TimelinePageModel is what the page unprojects).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZERO_PEER } from '../../../src/viz/model/frame.js';
import { prependTimeline, type Timeline } from '../../../src/viz/model/timeline.js';
import { RoomView, type ViewPage } from '../../../src/viz/ui/roomView.js';
import { BoardWriter } from '../../../tools/viz/boardWriter.js';
import { VirtualClock } from '../../sim/vclock.js';
import { makeRepoFixture } from '../../helpers/repoFixture.js';
import { collect, sourceOf } from '../../helpers/vizSource.js';
import { eventsIn, gitRoom, pubs, reference, sceneAtEnd } from '../../helpers/vizStore.js';

test('T-VIZ-seek (page view over the store): after "load earlier" the page holds the old h0\'s events and every held height, the old h0 included, reduces to the server\'s scene', async () => {
  const fx = await makeRepoFixture('viz-seek-view');
  try {
    const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'main', seed: 'seek-view' });
    await w.genesis('ann');
    await w.join('bob');
    await w.commitMany(pubs(1_540));
    const clock = new VirtualClock();
    const r = gitRoom(fx, w.ref, { clock });
    await r.store.init();
    const m = r.store.snapshot();
    assert.deepEqual(m.window, { h0: 512, h1: 1_541 });

    const asked: Array<[number, number]> = [];
    let tl: RoomView<ViewPage> | null = null;
    tl = new RoomView<ViewPage>(m.spec.id, m.scene, m.window, m.layout, {
      page: async (from, to) => {
        asked.push([from, to]);
        const p = await r.store.page(from, to);
        return p === null ? null : { room: p.roomId, from: p.from, to: p.to, start: p.scene, events: p.events };
      },
      // The page applies the earlier pages' layout deltas (R-V49): the head layout with the appended desks.
      merged: () => { tl!.setLayout(r.store.snapshot().layout); },
      changed: () => {},
    });
    // Twice "load earlier": the page first holds the whole window down to h0, then each earlier segment (the non-genesis one at
    // 256, then the genesis one).
    await tl.earlier();
    assert.equal(tl.h0, 256);
    await tl.earlier();
    assert.equal(tl.h0, 0);
    assert.equal(r.store.snapshot().window.h0, 0, 'the page and the store agree on the window');

    // The store's timeline, built independently: the window at 512 with the segments (256, 512] and [0, 256] prepended.
    const { src } = sourceOf(fx, w.ref);
    await src.tip();
    let t: Timeline = (await reference(fx, w.ref, 512)).timeline;
    for (const h0 of [256, 0]) {
      const start = await src.startAt(h0);
      t = prependTimeline(t, { h0, start, frames: await collect(src.frames(start, h0 === 0 ? 0 : h0 + 1, t.segments[0]!.hs, ZERO_PEER)) });
    }
    assert.deepEqual(t.segments.map((s) => s.hs), [0, 256, 512]);
    assert.deepEqual(r.store.snapshot().layout, t.layout);

    // VIZ-26: every held height reduces to the server's scene — around each segment start (the old h0s 256 and 512 are heights of
    // the segment below them) and across the window.
    const heights = new Set<number>([0, 1, 2, 254, 255, 256, 257, 258, 510, 511, 512, 513, 514, 767, 768, 769, 1_540, 1_541]);
    for (let h = 0; h <= 1_541; h += 37) heights.add(h);
    for (const h of [...heights].sort((a, b) => a - b)) {
      const s = tl.sceneAt(h);
      assert.ok(s !== null, `${h} is held`);
      assert.deepEqual(s, sceneAtEnd(t, h), `the scene at ${h}`);
    }
    // The old h0s' own events are held (their cards reach the log).
    for (const h of [256, 512]) {
      const want = eventsIn(t.events, h, h);
      assert.ok(want.length > 0);
      assert.deepEqual(tl.view().events.filter((e) => e.height === h), want, `the events of ${h}`);
    }
    // The earlier segments as the page asked for them: [257, 512] (one page), then the genesis segment [0, 256] in two pages.
    assert.deepEqual(asked.slice(-3), [[257, 512], [0, 256], [256, 256]]);
  } finally {
    await fx.cleanup();
  }
});
