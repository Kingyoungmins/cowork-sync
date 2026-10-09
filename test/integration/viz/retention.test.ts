// Plan 8a Task 8: the room store's retention and server-side seeking (12 §3.3.3 "Retention", §3.9.1 "Seeking", §3.10.5 timeline
// pages; VIZ-26, VIZ-41; R-V28, R-V29; controller ruling of 2026-10-09 on the fold bound): at most the newest 2,048 heights of
// events and cards stay in memory, the window and its ticks never shrink, a dropped range is re-folded from the kept
// checkpoint at or below it (≤ 255 folds before the page, ≤ 256 in all) and gives exactly the events and cards first served,
// pages hold ≤ 256 heights and never cross a segment start, and three "load earlier" pages change no scene above the old h0.
// Real boards in a clone on a file:// remote; a RoomSource spy counts every fold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { comparePos, SceneReducer, type Scene } from '../../../src/viz/model/scene.js';
import type { Position, SceneEvent } from '../../../src/viz/model/events.js';
import type { CardModel, TimelinePageModel } from '../../../src/viz/server/models.js';
import { RETAIN_HEIGHTS } from '../../../src/viz/server/store.js';
import { BoardWriter } from '../../../tools/viz/boardWriter.js';
import { VirtualClock } from '../../sim/vclock.js';
import { makeRepoFixture, type RepoFixture } from '../../helpers/repoFixture.js';
import { eventsIn, gitRoom, pubs, reference, sceneAtEnd, ticksOf, unplaced, type GitRoom } from '../../helpers/vizStore.js';

async function board(fx: RepoFixture, seed: string): Promise<BoardWriter> {
  const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'main', seed });
  await w.genesis('ann');
  await w.join('bob');
  return w;
}

/** The kept checkpoint a page from `from` re-folds from: the greatest multiple of 256 ≤ from − 1 (the window's first height is
 *  h0 + 1, whose page starts from the checkpoint at h0). */
const checkpointOf = (from: number): number => 256 * Math.floor((from - 1) / 256);

/** One page, with the folds and the frames calls it caused. */
async function pageOf(r: GitRoom, from: number, to: number): Promise<{ p: TimelinePageModel; folds: number; calls: GitRoom['spy']['frames'] }> {
  const f0 = r.spy.folds, c0 = r.spy.frames.length;
  const p = await r.store.page(from, to);
  assert.ok(p !== null, `page ${from}…${to}`);
  return { p, folds: r.spy.folds - f0, calls: r.spy.frames.slice(c0) };
}

test('retention: a room extended live by 3,000 heights keeps at most 2,048 heights of events and cards; the window does not shrink; ticks cover the whole window', async () => {
  const fx = await makeRepoFixture('viz-retention');
  try {
    const w = await board(fx, 'retention');
    await w.commitMany(pubs(298));
    const clock = new VirtualClock();
    const r = gitRoom(fx, w.ref, { clock });
    await r.store.init();
    assert.deepEqual(r.store.snapshot().window, { h0: 0, h1: 299 });
    for (let i = 1; i <= 6; i++) {
      await w.commitMany(pubs(500, `live${i}`));
      clock.advance(2_500);
      const t = await r.store.tick();
      assert.equal(t.delta?.kind, 'snapshot');
      assert.deepEqual(r.store.snapshot().window, { h0: 0, h1: 299 + 500 * i }, 'the window does not shrink');
    }
    const h1 = 3_299;
    const ref = await reference(fx, w.ref, 0);
    const m = r.store.snapshot();
    assert.deepEqual(m.ticks, ticksOf(ref.timeline.events), 'ticks cover the whole window');
    assert.deepEqual(m.scene, ref.carry.scene);
    // In memory: the heights above the oldest kept checkpoint at or above h1 − 2,048 — served with no fold; anything older is
    // re-folded. That checkpoint is 1,280: (1,280, 3,299] is 2,019 heights.
    const lo = 256 * Math.ceil((h1 - RETAIN_HEIGHTS) / 256);
    assert.equal(lo, 1_280);
    assert.ok(h1 - lo <= RETAIN_HEIGHTS);
    for (let b = 0; b < h1; b += 256) {
      const from = b + 1, to = Math.min(h1, b + 256);
      const { p, folds } = await pageOf(r, from, to);
      assert.deepEqual([p.from, p.to], [from, to]);
      if (b >= lo) assert.equal(folds, 0, `(${b}, ${to}] is held`);
      else assert.equal(folds, to - b, `(${b}, ${to}] was dropped: re-folded from ${b}`);
      assert.deepEqual(p.events, eventsIn(ref.timeline.events, from, to));
      assert.deepEqual(p.cards.map((c) => c.card), ref.timeline.cards.filter((c) => c.at.height >= from && c.at.height <= to));
    }
    // Height 0 (the genesis page) was dropped too.
    assert.ok((await pageOf(r, 0, 10)).folds > 0);
  } finally {
    await fx.cleanup();
  }
});

test('T-VIZ-seek (server): page() returns at most 256 heights, never across a segment start; a dropped range is re-folded from the kept checkpoint with at most 255 folds and gives the events first served for it', async () => {
  const fx = await makeRepoFixture('viz-seek-server');
  try {
    const w = await board(fx, 'seek-server');
    await w.commitMany(pubs(1_399));
    const clock = new VirtualClock({ startMono: 1_000 });
    const r = gitRoom(fx, w.ref, { clock });
    await r.store.init();
    assert.deepEqual(r.store.snapshot().window, { h0: 256, h1: 1_400 });
    // What was first served, per position: events and cards (with their seen anchors).
    const firstEvents = new Map<string, SceneEvent>();
    const firstCards = new Map<string, CardModel>();
    const key = (p: Position): string => `${p.height}.${p.sub}.${p.k}`;
    const remember = (events: readonly SceneEvent[], cards: readonly CardModel[]): void => {
      for (const e of events) if (!firstEvents.has(key(e))) firstEvents.set(key(e), e);
      for (const c of cards) if (!firstCards.has(c.card.id)) firstCards.set(c.card.id, c);
    };
    const serve = async (from: number): Promise<void> => {
      const h1 = r.store.snapshot().window.h1;
      for (let f = from; f <= h1;) {
        const { p, folds } = await pageOf(r, f, h1);
        assert.equal(folds, 0, 'served while held');
        remember(p.events, p.cards);
        f = p.to + 1;
      }
    };
    await serve(257);
    // Live: four ticks of 60 commits (timeline deltas: the stream serves their events), then four of 600 (snapshot deltas: the
    // page fetches their heights while they are held).
    for (let i = 0; i < 8; i++) {
      const before = r.store.snapshot().window.h1;
      await w.commitMany(pubs(i < 4 ? 60 : 600, `live${i}`));
      clock.advance(2_500);
      const d = (await r.store.tick()).delta;
      assert.ok(d !== null);
      if (d.kind === 'timeline') remember(d.events, d.cards);
      else await serve(before + 1);
    }
    const h1 = r.store.snapshot().window.h1;
    assert.equal(h1, 1_400 + 240 + 2_400);
    // Heights up to 2,048 are dropped now (the oldest kept checkpoint at or above h1 − 2,048 is 2,048).
    const firstOf = (from: number, to: number): { events: SceneEvent[]; cards: CardModel[] } => ({
      events: [...firstEvents.values()].filter((e) => e.height >= from && e.height <= to).sort(comparePos),
      cards: [...firstCards.values()].filter((c) => c.card.at.height >= from && c.card.at.height <= to).sort((a, b) => comparePos(a.card.at, b.card.at)),
    });
    const ref = await reference(fx, w.ref, 256);
    let refolded = 0;
    for (const from of [257, 300, 511, 512, 513, 700, 1_023, 1_024, 1_025, 1_500, 1_640, 1_641, 1_700, 2_047, 2_048, 2_049, 3_000, h1]) {
      const { p, folds, calls } = await pageOf(r, from, from + 400);
      assert.equal(p.from, from);
      assert.ok(p.to - p.from + 1 <= 256, `from ${from}: at most 256 heights`);
      assert.equal(p.to, Math.min(h1, from + 255, 256 * Math.ceil(from / 256)), `from ${from}: clipped at the next segment start`);
      const c = checkpointOf(from);
      if (c < 2_048) {
        refolded++;
        assert.deepEqual(calls, [{ from: c + 1, to: p.to, start: c, self: calls[0]!.self }], `from ${from}: one fold run from the checkpoint at ${c}`);
        assert.ok(from - 1 - c <= 255, 'at most 255 folds before the page');
        assert.equal(folds, p.to - c);
        assert.ok(folds <= 256);
      } else {
        assert.deepEqual([calls, folds], [[], 0], `from ${from}: held`);
      }
      const first = firstOf(from, p.to);
      assert.deepEqual(p.events, first.events, `from ${from}: the events first served`);
      assert.deepEqual(p.cards, first.cards, `from ${from}: the cards first served, seen anchors included`);
      assert.deepEqual(p.events, eventsIn(ref.timeline.events, from, p.to));
      if (from === 257) assert.deepEqual(p.scene, ref.timeline.segments[0]!.start);
      else assert.deepEqual(unplaced(p.scene), unplaced(sceneAtEnd(ref.timeline, from - 1)), `from ${from}: the scene at the end of ${from - 1}`);
    }
    assert.ok(refolded >= 10);
    // A segment start that "load earlier" made: a page never crosses it.
    assert.ok((await r.store.earlier()) !== null);
    const { p } = await pageOf(r, 200, 400);
    assert.deepEqual([p.from, p.to], [200, 256]);
    const next = await pageOf(r, 257, 400);
    assert.deepEqual([next.p.from, next.p.to], [257, 400]);
    assert.deepEqual(next.p.scene, ref.timeline.segments[0]!.start, 'the window segment\'s start scene');
  } finally {
    await fx.cleanup();
  }
});

test('T-VIZ-seek (server): after three earlier() pages the scene at 100 random positions above the old h0 is unchanged and no ordinal moved', async () => {
  const fx = await makeRepoFixture('viz-seek-earlier');
  try {
    const w = await board(fx, 'seek-earlier');
    await w.commitMany(pubs(400, 'old'));
    await w.commitMany(pubs(1_600, 'new'));
    const clock = new VirtualClock();
    const r = gitRoom(fx, w.ref, { clock });
    await r.store.init();
    const before = r.store.snapshot();
    assert.deepEqual(before.window, { h0: 768, h1: 2_001 });
    /** The scene at a position, as the page reduces it from the served page of its height. */
    const sceneAt = async (at: Position): Promise<Scene> => {
      const p = await r.store.page(at.height, at.height);
      assert.ok(p !== null);
      const red = new SceneReducer(p.scene, () => before.layout);
      for (const e of p.events) if (comparePos(e, at) <= 0) red.push(e);
      return red.scene();
    };
    const positions = fc.sample(fc.record({ height: fc.integer({ min: 769, max: 2_001 }), sub: fc.integer({ min: 0, max: 1_003 }), k: fc.nat({ max: 5 }) }), { numRuns: 100, seed: 8_008 });
    const scenes: Scene[] = [];
    for (const at of positions) scenes.push(await sceneAt(at));
    for (const h0 of [512, 256, 0]) {
      assert.ok((await r.store.earlier()) !== null);
      assert.equal(r.store.snapshot().window.h0, h0);
    }
    assert.equal(await r.store.earlier(), null, 'nothing below 0');
    for (let i = 0; i < positions.length; i++) assert.deepEqual(await sceneAt(positions[i]!), scenes[i], `position ${JSON.stringify(positions[i])}`);
    const after = r.store.snapshot();
    assert.deepEqual(after.layout.desks.slice(0, before.layout.desks.length), before.layout.desks, 'no ordinal moved');
    for (const [path, d] of before.layout.deskOf) assert.equal(after.layout.deskOf.get(path), d, path);
    assert.ok(after.layout.desks.length > before.layout.desks.length, 'the earlier pages appended the old/* desks');
    assert.ok(after.layout.desks.slice(before.layout.desks.length).every((d) => d.key.startsWith('old/')));
    assert.deepEqual([after.scene, after.window.h1], [before.scene, before.window.h1]);
  } finally {
    await fx.cleanup();
  }
});
