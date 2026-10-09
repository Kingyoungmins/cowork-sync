// Plan 8a Task 13: seeking on the page (12 §3.9.1 "Seeking", §3.5.3 "Rewinding"; VIZ-16, VIZ-26; R-V51): a reduced scene
// every 64 heights of each segment, equal to reducing from the segment start; the head layout kept; the static layer's options.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import type { Position, SceneEvent } from '../../../src/viz/model/events.js';
import { emptyLayout, isDashed, LayoutBuilder, type Layout } from '../../../src/viz/model/layout.js';
import { deskDimmed, reduceScene, type Scene, type TimelineView } from '../../../src/viz/model/scene.js';
import { SEEK_CACHE_EVERY, SeekCache, staticFor } from '../../../src/viz/ui/seek.js';
import { ev } from '../../helpers/vizEvents.js';
import { eventsArb, RANDOM_OFFICE, START } from '../../helpers/vizScene.js';

const END = Number.MAX_SAFE_INTEGER;
const at = (height: number, sub = 0, k = 0): Position => ({ height, sub, k });

/** A view of segments every 256 heights whose start scenes are the scenes at the end of their hs (as the store serves them). */
function viewOf(events: SceneEvent[], layout: Layout = RANDOM_OFFICE, h0 = 0): TimelineView {
  const top = Math.max(h0, events.at(-1)?.height ?? 0);
  const whole: TimelineView = { segments: [{ hs: h0, start: START }], events, layout };
  const segments: Array<{ hs: number; start: Scene }> = [{ hs: h0, start: START }];
  for (let hs = h0 + 256; hs <= top; hs += 256) segments.push({ hs, start: reduceScene(whole, at(hs, END, END)) });
  return { segments, events, layout };
}

test('T-VIZ-seek (page): at 200 random positions the scene from the nearest cached 64-height scene equals reducing from the segment start', () => {
  assert.equal(SEEK_CACHE_EVERY, 64);
  const events = fc.sample(eventsArb({ minLength: 300, maxLength: 300 }), { numRuns: 1, seed: 8_013 })[0]!;
  const view = viewOf(events);
  const top = events.at(-1)!.height;
  assert.ok(view.segments.length >= 3, `${view.segments.length} segments over ${top} heights`);
  const cache = new SeekCache(() => view);
  const rnd = fc.sample(fc.record({ h: fc.integer({ min: 0, max: top + 10 }), sub: fc.integer({ min: 0, max: 1_002 }), k: fc.integer({ min: 0, max: 3 }) }), { numRuns: 200, seed: 13 });
  // The random positions, then every 64-height boundary, the segment starts and the events' own positions around them.
  const positions: Position[] = rnd.map((r) => at(r.h, r.sub, r.k));
  for (let h = 0; h <= top + 64; h += 64) positions.push(at(h), at(h, END, END), at(h + 1));
  for (const e of events.filter((_, i) => i % 7 === 0)) positions.push(at(e.height, e.sub, e.k), at(e.height, e.sub, e.k + 1));
  for (const p of positions) assert.deepEqual(cache.sceneAt(p), reduceScene(view, p), `${p.height}.${p.sub}.${p.k}`);
  // A second pass hits the cache and still agrees; a returned scene is a copy.
  for (const p of positions.slice(0, 50)) {
    const s = cache.sceneAt(p);
    s.characters.clear();
    s.beat.length = 0;
    assert.deepEqual(cache.sceneAt(p), reduceScene(view, p));
  }

  // Live growth: events appended to the view (higher heights) never stale a cached scene.
  const more = fc.sample(eventsArb({ from: top + 1, minLength: 40, maxLength: 40 }), { numRuns: 1, seed: 21 })[0]!;
  const live: TimelineView = { segments: view.segments, events: [...events, ...more], layout: view.layout };
  let cur: TimelineView = view;
  const grown = new SeekCache(() => cur);
  for (const p of positions.slice(0, 80)) assert.deepEqual(grown.sceneAt(p), reduceScene(cur, p));
  cur = live;
  const top2 = more.at(-1)!.height;
  for (let h = 0; h <= top2 + 1; h += 37) assert.deepEqual(grown.sceneAt(at(h, 500, 1)), reduceScene(cur, at(h, 500, 1)), `live ${h}`);

  // "Load earlier": a segment prepended below h0, then invalidate; every position still agrees.
  const early = fc.sample(eventsArb({ from: 0, minLength: 30, maxLength: 30 }), { numRuns: 1, seed: 34 })[0]!.filter((e) => e.height < 256);
  const shifted = events.map((e) => ({ ...e, height: e.height + 256 }));
  const before = viewOf(shifted, RANDOM_OFFICE, 256);
  const extended = viewOf([...early, ...shifted]);
  let v = before;
  const pager = new SeekCache(() => v);
  assert.equal(pager.holds(255), false);
  assert.equal(pager.holds(256), true);
  assert.equal(pager.holds(top + 256), true);
  for (const p of positions.slice(0, 40)) {
    const q = at(p.height + 256, p.sub, p.k);
    assert.deepEqual(pager.sceneAt(q), reduceScene(v, q));
  }
  v = extended;
  pager.invalidate(0);
  assert.equal(pager.holds(0), true);
  for (const p of [...positions.slice(0, 40), at(3), at(100, 1_001), at(255, END, END)]) assert.deepEqual(pager.sceneAt(p), reduceScene(v, p));
  // An empty view holds nothing.
  assert.equal(new SeekCache(() => ({ segments: [], events: [], layout: RANDOM_OFFICE })).holds(0), false);
});

test('T-VIZ-layout (seek): a seek keeps the head layout — the layout version is unchanged and no desk is removed — and staticFor passes dashedFrom = the seek height, null when live', () => {
  // A head layout whose desks were first touched at heights 1, 50, 300 and 700, one of them carrying a lockbox.
  const b = new LayoutBuilder(emptyLayout());
  b.home('a1a1a1');
  b.desk('src/a.ts', 1);
  b.desk('src/b.ts', 50);
  b.desk('src/c.ts', 300);
  b.desk('test/d.ts', 700);
  const built = b.layout();
  const layout: Layout = { ...built, desks: built.desks.map((d) => (d.ordinal === 2 ? { ...d, lockbox: true } : d)) };
  const events: SceneEvent[] = [
    ev('person_enter', [1, 1, 0], { peer: 'a1a1a1' }),
    ev('publish', [2, 1_001, 0], { actor: { peer: 'a1a1a1' }, target: 1, others: [], paths: ['src/a.ts'], n: 1, state: 'closed', checks: 'pass', origin: 'human' }),
    ev('publish', [50, 1_001, 0], { actor: { peer: 'a1a1a1' }, target: 2, others: [], paths: ['src/b.ts'], n: 1, state: 'closed', checks: 'pass', origin: 'human' }),
    ev('publish', [300, 1_001, 0], { actor: { peer: 'a1a1a1' }, target: 3, others: [], paths: ['src/c.ts'], n: 1, state: 'closed', checks: 'pass', origin: 'human' }),
    ev('publish', [700, 1_001, 0], { actor: { peer: 'a1a1a1' }, target: 4, others: [], paths: ['test/d.ts'], n: 1, state: 'closed', checks: 'pass', origin: 'human' }),
  ];
  const view = viewOf(events, layout);
  const snapshot = JSON.stringify({ version: layout.version, desks: layout.desks, zones: layout.zones, homeOrder: layout.homeOrder });
  const cache = new SeekCache(() => view);
  for (const h of [0, 10, 49, 50, 299, 400, 699, 700, 800]) {
    const s = cache.sceneAt(at(h, END, END));
    // The head layout is untouched: same object, same version, every desk still there.
    assert.equal(view.layout, layout);
    assert.equal(JSON.stringify({ version: layout.version, desks: layout.desks, zones: layout.zones, homeOrder: layout.homeOrder }), snapshot);
    const past = staticFor(layout, s, { live: false, coarse: false });
    assert.equal(past.dashedFrom, h);
    const dashed = layout.desks.filter((d) => past.dashedFrom !== null && d.first > past.dashedFrom).map((d) => d.ordinal);
    assert.deepEqual(dashed, layout.desks.filter((d) => isDashed(d, s.at)).map((d) => d.ordinal), `dashed at ${h}`);
    assert.deepEqual([...past.dimmed].sort((x, y) => x - y), layout.desks.filter((d) => deskDimmed(s, d.ordinal)).map((d) => d.ordinal), `dimmed at ${h}`);
    assert.deepEqual([...past.lockboxDesks], [2]);
    assert.equal(past.coarse, false);
    const now = staticFor(layout, s, { live: true, coarse: true });
    assert.equal(now.dashedFrom, null);
    assert.equal(now.coarse, true);
  }
  // At 400 the desk first touched at 700 is dashed and the one last used at 50 is dimmed (≥ 256 heights without an event).
  const s400 = cache.sceneAt(at(400, END, END));
  const o = staticFor(layout, s400, { live: false, coarse: false });
  assert.deepEqual(layout.desks.filter((d) => o.dashedFrom !== null && d.first > o.dashedFrom).map((d) => d.ordinal), [4]);
  assert.ok(o.dimmed.has(1) && o.dimmed.has(2) && !o.dimmed.has(3));
});
