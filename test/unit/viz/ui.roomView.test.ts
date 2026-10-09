// Plan 8a Task 14 (fix round 1, R-V33): what the page holds of one room's timeline, DOM-free (src/viz/ui/roomView.ts): the
// world's head scene as a segment at h1, the stream's events above it, and timeline pages loaded below it (12 §3.9.1, §3.10.5;
// VIZ-26; R-V29). A range the server clips at a segment start comes back in several pages and joins the view only when the whole
// range arrived; a page that fails, names another room or another start leaves the view as it was; one load runs per room at a
// time and the newest seek target waits for it (never dropped); a room_snapshot drops a load in flight for the old view; "load
// earlier" extends h0 by one segment; the live queue plays one height per beat and snaps after a 5 s backlog. Every scene the
// view returns equals the server's reduceScene at that height, and a height the page does not hold returns no scene.
// Task 8 fix round 1 (finding 1, Option A): the fake server follows the store's page rules over the glossary's segments — a
// segment that starts at hs (with a start scene of its own, never the scene the segment below ends with) holds the heights
// hs + 1 up to the next segment's hs, the genesis segment from height 0 — so the page asks the window from h0 + 1 and "load
// earlier" asks [h0' + 1, h0] (the genesis segment [0, h0], in two pages), and its h0 follows the server's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import type { Position, SceneEvent } from '../../../src/viz/model/events.js';
import { reduceScene, type Scene, type TimelineView } from '../../../src/viz/model/scene.js';
import { BACKLOG_SNAP_MS, LIVE_BEAT_MS } from '../../../src/viz/ui/anim.js';
import { LivePlayer, PAGE_HEIGHTS_MAX, RoomView, type ViewPage } from '../../../src/viz/ui/roomView.js';
import { ev } from '../../helpers/vizEvents.js';
import { eventsArb, RANDOM_OFFICE, START } from '../../helpers/vizScene.js';

const END = Number.MAX_SAFE_INTEGER;
const ROOM = 'rABCDEFGH';
const SEG = 256;
const end = (h: number): Position => ({ height: h, sub: END, k: END });

/** A board's whole timeline as the server folds it, from height 0. */
const EVENTS: SceneEvent[] = fc.sample(eventsArb({ minLength: 160, maxLength: 160 }), { numRuns: 1, seed: 14_014 })[0]!.filter((e) => e.height <= 1_400);
const WHOLE: TimelineView = { segments: [{ hs: 0, start: START }], events: EVENTS, layout: RANDOM_OFFICE };
const serverScene = (h: number): Scene => reduceScene(WHOLE, end(h));
/** The start scene of the segment that starts at hs > 0: like the store's (12 §3.3.5: the state at hs, an empty beat, at (hs, 0, 0))
 *  and marked with a branchMovedAt no event sets, so it never equals the scene the segment below ends with. */
const startOf = (hs: number): Scene => ({ ...serverScene(hs), at: { height: hs, sub: 0, k: 0 }, beat: [], branchMovedAt: -1_000_000 - hs });
/** The window's first height: h0 + 1 (height h0 belongs to the segment below), 0 for the genesis segment. */
const firstOf = (h0: number): number => (h0 === 0 ? 0 : h0 + 1);

/** The fake server of one room whose window starts at w0: the store's page rules (12 §3.10.5, §3.10.6; R-V29) over its timeline —
 *  the segment at w0 and, after each "load earlier", one more segment 256 heights below. */
class Server {
  h0: number;
  constructor(private readonly w0: number) {
    this.h0 = w0;
  }
  /** The server's timeline now: the segments from h0 up (the genesis one at 0 with the empty start scene), the events above h0. */
  timeline(): TimelineView {
    const segments = [{ hs: 0, start: START }];
    for (let hs = SEG; hs <= this.w0; hs += SEG) segments.push({ hs, start: startOf(hs) });
    return { segments: segments.filter((s) => s.hs >= this.h0), events: EVENTS.filter((e) => e.height >= firstOf(this.h0)), layout: RANDOM_OFFICE };
  }
  scene(h: number): Scene {
    return reduceScene(this.timeline(), end(h));
  }
  /** The page [from, to]: a `from` below the window's first height extends the window by one segment and answers from that
   *  segment's first height (a `to` below it reads as the segment's page); `to` clipped at 256 heights and at the next multiple of
   *  256; the scene is the segment's start scene at a segment's first height, else the scene at the end of from − 1. */
  page(from: number, to: number): ViewPage | null {
    if (from < firstOf(this.h0)) {
      this.h0 -= SEG;
      from = Math.max(from, firstOf(this.h0));
      if (to < from) to = from + SEG - 1;
    }
    const clipped = Math.min(to, from + SEG - 1, from === 0 ? SEG : SEG * Math.ceil(from / SEG));
    const t = this.timeline();
    const seg = t.segments.find((s) => s.hs > 0 && s.hs + 1 === from);
    const start = from === 0 ? START : seg !== undefined ? seg.start : reduceScene(t, end(from - 1));
    return { room: ROOM, from, to: clipped, start, events: t.events.filter((e) => e.height >= from && e.height <= clipped) };
  }
}
/** Pages of a window from 0 (no segment below), for the fault cases. */
const PLAIN = new Server(0);

interface Deferred { from: number; to: number; answer(p: ViewPage | null): void; }
/** A room view over the fake server; `hold` keeps every request open until the test answers it; `fault` replaces an answer. */
function roomOf(o: { h0: number; h1: number; hold?: boolean; fault?: (from: number, to: number, n: number) => ViewPage | null | undefined; id?: string }) {
  const server = new Server(o.h0);
  const asked: Array<[number, number]> = [];
  const open: Deferred[] = [];
  const merged: Array<Array<[number, number]>> = [];
  let changed = 0;
  const withRoom = (p: ViewPage | null): ViewPage | null => (p === null ? null : { ...p, room: o.id ?? ROOM });
  const tl = new RoomView<ViewPage>(o.id ?? ROOM, server.scene(o.h1), { h0: o.h0, h1: o.h1 }, RANDOM_OFFICE, {
    page: (from, to) => {
      asked.push([from, to]);
      const n = asked.length;
      const answer = (): ViewPage | null => {
        const f = o.fault?.(from, to, n);
        return f === undefined ? withRoom(server.page(from, to)) : f;
      };
      if (o.hold !== true) return Promise.resolve(answer());
      return new Promise((resolve) => open.push({ from, to, answer: (p) => resolve(withRoom(p)) }));
    },
    merged: (pages) => { merged.push(pages.map((p) => [p.from, p.to])); },
    changed: () => { changed++; },
  });
  return { tl, server, asked, open, merged, changed: () => changed };
}
type Room = ReturnType<typeof roomOf>;
/** Lets the view's pending promise callbacks run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
};
/** Every scene the view holds equals the server's; a height it does not hold returns no scene. */
function assertScenes(r: Room, from: number, to: number, label: string): number {
  let n = 0;
  for (let h = from; h <= to; h += h % 7 === 0 ? 1 : 5) {
    const s = r.tl.sceneAt(h);
    assert.ok(s !== null, `${label}: the view holds ${h}`);
    assert.deepEqual(s, r.server.scene(h), `${label}: the scene at ${h}`);
    n++;
  }
  return n;
}

test('T-VIZ-seek (page view): clipped pages complete their range before it joins the view, and every held height reduces to the server\'s scene', async () => {
  assert.equal(PAGE_HEIGHTS_MAX, 256);
  assert.ok(EVENTS.length > 40 && EVENTS.at(-1)!.height > 700, `${EVENTS.length} events up to ${EVENTS.at(-1)!.height}`);
  const h1 = 600;
  const r = roomOf({ h0: 0, h1 });
  // Only the head is held at first; nothing below it, nothing above the top.
  assert.equal(r.tl.holds(h1), true);
  assert.equal(r.tl.holds(h1 - 1), false);
  assert.equal(r.tl.sceneAt(h1 - 1), null, 'a height the page does not hold has no scene');
  assert.equal(r.tl.sceneAt(h1 + 1), null);
  assert.deepEqual(r.tl.sceneAt(h1), serverScene(h1));
  await r.tl.want(10);
  // [345, 600] is clipped at 512, [89, 344] at 256, then [0, 88]: each range in pages that continue where the last one ended.
  assert.deepEqual(r.asked, [[345, 600], [513, 600], [89, 344], [257, 344], [0, 88]]);
  assert.deepEqual(r.merged, [[[345, 512], [513, 600]], [[89, 256], [257, 344]], [[0, 88]]], 'each range joins the view whole, in ascending order');
  assert.equal(r.tl.loading(), false);
  assert.ok(r.changed() >= 4, 'changed when the load started, after each range and when it ended');
  const compared = assertScenes(r, 0, h1, 'clipped');
  assert.ok(compared > 100, `${compared} heights compared`);
  // The stream's events above the head: each kept once, in order; the view still reduces to the server's scenes.
  const above = EVENTS.filter((e) => e.height > h1);
  const first = r.tl.append(above.slice(0, 10), above[9]!.height);
  assert.deepEqual(first, above.slice(0, 10));
  assert.deepEqual(r.tl.append(above.slice(5, 20), above[19]!.height), above.slice(10, 20), 'events at or below the newest held one are skipped');
  assert.equal(r.tl.top(), above[19]!.height);
  assertScenes(r, h1, above[19]!.height, 'stream');
  assert.deepEqual(r.tl.head(), reduceScene(WHOLE, { height: above[19]!.height, sub: above[19]!.sub, k: above[19]!.k }));
  // nextHeight: the next height above h with an event the page holds.
  const heights = [...new Set(EVENTS.filter((e) => e.height <= above[19]!.height).map((e) => e.height))];
  assert.equal(r.tl.nextHeight(-1), heights[0]);
  assert.equal(r.tl.nextHeight(heights[3]!), heights[4]);
  assert.equal(r.tl.nextHeight(above[19]!.height), null);
});

test('T-VIZ-seek (page view): a failed second page, or a page for another room or another start, leaves the view as it was; the next want loads the range again', async () => {
  const h1 = 600;
  for (const [label, bad] of [
    ['failed', (): ViewPage | null => null],
    ['another room', (): ViewPage | null => ({ ...PLAIN.page(513, 600)!, room: 'rZZZZZZZZ' })],
    ['another start', (): ViewPage | null => PLAIN.page(514, 600)],
    ['beyond the asked end', (): ViewPage | null => ({ ...PLAIN.page(513, 600)!, to: 601 })],
    ['an event outside the page', (): ViewPage | null => ({ ...PLAIN.page(513, 600)!, events: [...PLAIN.page(513, 600)!.events, ev('room_open', [700, 0, 0], {})] })],
  ] as const) {
    let failing = true;
    const r = roomOf({ h0: 0, h1, fault: (from) => (failing && from === 513 ? bad() : undefined) });
    await r.tl.want(400);
    // The first page [345, 512] arrived, the second did not: nothing joined the view, so no height of the gap counts as held.
    assert.deepEqual(r.asked, [[345, 600], [513, 600]], label);
    assert.deepEqual(r.merged, [], `${label}: nothing merged`);
    for (const h of [345, 400, 512, 550, 599]) {
      assert.equal(r.tl.holds(h), false, `${label}: ${h} is not held`);
      assert.equal(r.tl.sceneAt(h), null, `${label}: no scene at ${h}`);
    }
    assert.equal(r.tl.loading(), false, `${label}: the load ended`);
    failing = false;
    await r.tl.want(400);
    assert.deepEqual(r.merged, [[[345, 512], [513, 600]]], `${label}: loaded again, whole`);
    assertScenes(r, 345, h1, label);
  }
});

test('T-VIZ-seek (page view): a seek made while a load runs is kept — the newest target loads after it, an older one is dropped; "load earlier" waits for it; each room loads on its own', async () => {
  const h1 = 1_100;
  const r = roomOf({ h0: 0, h1, hold: true });
  const done = r.tl.want(1_000);
  assert.equal(r.tl.loading(), true);
  assert.equal(r.tl.canEarlier(), false, '"load earlier" is greyed while a load runs');
  // Two more seeks while [845, 1100] is in flight: the newest (700) wins, 10 is dropped.
  void r.tl.want(10);
  void r.tl.want(700);
  // Meanwhile another room loads at once: no page-wide flag blocks it.
  const other = roomOf({ h0: 0, h1, id: 'rBCDEFGHJ' });
  await other.tl.want(900);
  assert.deepEqual(other.asked, [[845, 1_100], [1_025, 1_100]]);
  assert.equal(other.tl.holds(900), true);
  // Answer every request as it comes.
  const answered: Array<[number, number]> = [];
  for (let i = 0; i < 20 && (r.open.length > 0 || r.tl.loading()); i++) {
    const d = r.open.shift();
    if (d !== undefined) {
      answered.push([d.from, d.to]);
      d.answer(r.server.page(d.from, d.to));
    }
    await settle();
  }
  await done;
  assert.deepEqual(answered, [[845, 1_100], [1_025, 1_100], [589, 844], [769, 844]], 'the first target\'s range, then the newest target\'s; never the dropped one');
  assert.equal(r.tl.holds(700), true);
  assert.equal(r.tl.holds(10), false, 'the older target was dropped');
  assertScenes(r, 589, h1, 'seek during a load');
  // "load earlier" while a seek runs: queued, then run — never dropped.
  const e = roomOf({ h0: 512, h1: 700, hold: true });
  const seek = e.tl.want(650);
  const earlier = e.tl.earlier();
  for (let i = 0; i < 20 && (e.open.length > 0 || e.tl.loading()); i++) {
    const d = e.open.shift();
    if (d !== undefined) d.answer(e.server.page(d.from, d.to));
    await settle();
  }
  await Promise.all([seek, earlier]);
  // The seek's range from the window's first height [513, 700], then the earlier segment's own heights [257, 512] (R-V29): h0
  // moves down by 256, as the server's.
  assert.deepEqual(e.asked, [[513, 700], [257, 512]]);
  assert.deepEqual([e.tl.h0, e.server.h0], [256, 256]);
  assert.equal(e.tl.canEarlier(), true);
  assertScenes(e, 256, 700, 'load earlier');
});

test('T-VIZ-seek (page view): "load earlier" asks the segment\'s own heights [h0\' + 1, h0] (the genesis segment [0, h0], in two pages), so the page\'s h0 follows the server\'s and the old h0 reduces to the scene the segment below ends with (VIZ-26)', async () => {
  const r = roomOf({ h0: 512, h1: 700 });
  // The window's first height is 513 (512 belongs to the segment below): the lowest page starts there, and the window start 512 is
  // held as its segment's start scene.
  await r.tl.want(512);
  assert.deepEqual(r.asked, [[513, 700]]);
  assert.equal(r.tl.holds(511), false);
  assert.deepEqual(r.tl.sceneAt(512), r.server.scene(512));
  assert.deepEqual(r.tl.sceneAt(512), { ...startOf(512), at: end(512) }, 'the window start: its segment\'s start scene');
  // "Load earlier" twice: [257, 512] in one page, then the genesis segment's 257 heights [0, 256] as [0, 255] and [256, 256], one range.
  await r.tl.earlier();
  assert.deepEqual([r.tl.h0, r.server.h0], [256, 256]);
  await r.tl.earlier();
  assert.deepEqual([r.tl.h0, r.server.h0, r.tl.canEarlier()], [0, 0, false]);
  // Every held height reduces to the server's scene — the old h0s 256 and 512 (each now a height of the segment below it) and their
  // neighbours included — and the page holds every event of [0, 700].
  for (const h of [0, 1, 254, 255, 256, 257, 258, 510, 511, 512, 513, 514, 699, 700]) {
    assert.deepEqual(r.tl.sceneAt(h), r.server.scene(h), `the scene at ${h}`);
  }
  assert.notDeepEqual(r.tl.sceneAt(512), { ...startOf(512), at: end(512) }, 'the old h0 is no longer its old segment\'s start scene');
  assertScenes(r, 0, 700, 'after two earlier pages');
  assert.deepEqual(r.tl.view().events, EVENTS.filter((e) => e.height <= 700), 'every event of [0, 700], each once');
  assert.deepEqual(r.asked, [[513, 700], [257, 512], [0, 256], [256, 256]]);
  assert.deepEqual(r.merged, [[[513, 700]], [[257, 512]], [[0, 255], [256, 256]]], 'the genesis segment joins the view whole');
});

test('T-VIZ-seek (page view): a room_snapshot during a load drops the pages loaded for the old view and loads again for the new one; a snapshot leaves older heights unheld until they are wanted again', async () => {
  const r = roomOf({ h0: 0, h1: 600, hold: true });
  const done = r.tl.want(400);
  assert.deepEqual(r.asked, [[345, 600]]);
  // The snapshot (the scene at the new tip 900) arrives while [345, 600] is in flight.
  r.tl.snapshot(serverScene(900), { h0: 0, h1: 900 });
  assert.equal(r.tl.h1, 900);
  assert.equal(r.tl.holds(600), false, 'the old head is no longer held');
  assert.equal(r.tl.sceneAt(600), null);
  assert.deepEqual(r.tl.head(), serverScene(900));
  for (let i = 0; i < 20 && (r.open.length > 0 || r.tl.loading()); i++) {
    const d = r.open.shift();
    if (d !== undefined) d.answer(r.server.page(d.from, d.to));
    await settle();
  }
  await done;
  // [345, 600] answered for the old view is never merged, and its range stops there; the target 400 is loaded again from the new
  // head 900.
  assert.deepEqual(r.asked, [[345, 600], [645, 900], [769, 900], [389, 644], [513, 644]]);
  assert.deepEqual(r.merged, [[[645, 768], [769, 900]], [[389, 512], [513, 644]]]);
  assertScenes(r, 389, 900, 'after a snapshot');
  // A later snapshot with nothing in flight: the replay position below it is not held until the page wants it again.
  r.tl.snapshot(serverScene(1_000), { h0: 0, h1: 1_000 });
  assert.equal(r.tl.holds(400), false);
  assert.equal(r.tl.sceneAt(400), null);
  const again = r.tl.want(400);
  for (let i = 0; i < 20 && (r.open.length > 0 || r.tl.loading()); i++) {
    const d = r.open.shift();
    if (d !== undefined) d.answer(r.server.page(d.from, d.to));
    await settle();
  }
  await again;
  assertScenes(r, 400, 1_000, 'after a second snapshot');
});

test('T-VIZ-seek (page view): the live queue plays one height per beat and snaps to the newest scene after a 5 s backlog', () => {
  const live = new LivePlayer(START, () => RANDOM_OFFICE);
  assert.equal(live.beat(() => START), null, 'nothing queued');
  const few = EVENTS.filter((e) => e.height <= EVENTS[0]!.height + 400).slice(0, 12);
  const heights = [...new Set(few.map((e) => e.height))];
  assert.ok(heights.length >= 3 && heights.length * LIVE_BEAT_MS <= BACKLOG_SNAP_MS, `${heights.length} heights`);
  live.push(few);
  const played: number[] = [];
  for (let b = live.beat(() => START); b !== null; b = live.beat(() => START)) {
    assert.equal(b.kind, 'beat');
    if (b.kind !== 'beat') break;
    played.push(b.height);
    assert.deepEqual(b.events, few.filter((e) => e.height === b.height));
    assert.deepEqual(b.scene, reduceScene({ ...WHOLE, events: few }, { height: b.height, sub: b.events.at(-1)!.sub, k: b.events.at(-1)!.k }));
  }
  assert.deepEqual(played, heights);
  // More than 5 s of beats queued (17 heights × 300 ms): one snap to the head scene at the newest queued height.
  const many = Array.from({ length: 17 }, (_, i) => ev('room_open', [2_000 + i, 0, 0], {}));
  live.push(many);
  const head = serverScene(1_234);
  const snap = live.beat(() => head);
  assert.deepEqual(snap, { kind: 'snap', height: 2_016, scene: head });
  assert.equal(live.queued(), 0);
  assert.deepEqual(live.scene(), head);
});
