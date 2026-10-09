// What the page holds of one room's timeline (12 §3.9.1 "Seeking", §3.9.2, §3.10.5 "Timeline pages"; VIZ-26; R-V29, R-V49): the
// world's head scene as a segment at h1, the stream's events above it, and timeline pages loaded below it as contiguous segments
// {hs: from − 1, start: page.scene}, with the 64-height seek cache over them; and the live queue the page plays one height per beat.
// The server clips a page's `to` at the next segment start, so one range [from, L] can come back in several pages: they join the
// view only when the whole range arrived, each page checked to be this room's, to start where it was asked and to stay inside what
// was asked — so the view is always one contiguous run of heights and a height is held exactly when it lies in it. One load runs
// per room at a time: a seek made meanwhile replaces the waiting target (the newest wins and runs next, never dropped), "load
// earlier" waits its turn, and a room_snapshot drops what is in flight for the old view. Pure and DOM-free (R-V33): the page passes
// the page request and applies what else a page carries (layout deltas, cards, pet owners) when its range merges.
import type { SceneEvent } from '../model/events.js';
import type { Layout } from '../model/layout.js';
import { comparePos, SceneReducer, type Scene, type TimelineView } from '../model/scene.js';
import { liveSnap } from './anim.js';
import { SeekCache } from './seek.js';

/** Heights per timeline request (12 §3.10.5): one segment of 256 (R-V29). */
export const PAGE_HEIGHTS_MAX = 256;

const END = Number.MAX_SAFE_INTEGER;

/** One timeline page as the page reads it (a TimelinePage unprojected): its room, the served range (`to` as clipped), the scene at the
 *  end of from − 1 and the events of [from, to]. */
export interface ViewPage { room: string; from: number; to: number; start: Scene; events: SceneEvent[]; }

export interface RoomPageIo<P extends ViewPage> {
  /** GET /api/v1/rooms/<id>/timeline?from=&to= read as a page; null when refused, failed or malformed. */
  page(from: number, to: number): Promise<P | null>;
  /** The pages of one whole range, in ascending order, as they join the view (before h0 moves down for an earlier page): the page
   *  applies their layout deltas (R-V49), cards and pet owners (R-V47). */
  merged(pages: readonly P[]): void;
  /** A load started or ended, or a range joined the view. */
  changed(): void;
}

/** A planned request: the range [from, to] directly below the lowest held height, or the earlier segment (R-V29). */
interface Job { from: number; to: number; earlier: boolean; }

const posKey = (e: SceneEvent): string => `${e.height}.${e.sub}.${e.k}`;

export class RoomView<P extends ViewPage = ViewPage> {
  readonly id: string;
  /** The room's window (12 §3.9.1 "Axis"): h0 moves down with "load earlier", h1 up with the stream. */
  h0: number;
  h1: number;
  private layoutNow: Layout;
  private segments: Array<{ hs: number; start: Scene }>;
  private events: SceneEvent[] = [];
  private seekCache: SeekCache;
  private headReducer: SceneReducer;
  private busy = false;
  private target: number | null = null;              // the newest height a seek waits for
  private earlierWanted = false;
  private epoch = 0;                                 // bumped by snapshot(): pages asked for the old view are dropped
  private draining: Promise<void> = Promise.resolve();

  constructor(id: string, start: Scene, window: { h0: number; h1: number }, layout: Layout, private readonly io: RoomPageIo<P>) {
    this.id = id;
    this.h0 = window.h0;
    this.h1 = window.h1;
    this.layoutNow = layout;
    this.segments = [{ hs: window.h1, start }];
    this.seekCache = new SeekCache(() => this.view());
    this.headReducer = new SceneReducer(start, () => this.layoutNow);
  }

  get layout(): Layout {
    return this.layoutNow;
  }
  /** The head layout (a seek never changes it, 12 §3.5.3); desks only append (R-V49), so no held scene changes. */
  setLayout(l: Layout): void {
    this.layoutNow = l;
  }

  /** The TimelineView the page reduces (12 §3.3.5 segments). */
  view(): TimelineView {
    return { segments: this.segments, events: this.events, layout: this.layoutNow };
  }

  /** The newest scene: the head plus every stream event (a copy). */
  head(): Scene {
    return this.headReducer.scene();
  }

  /** The stream's events, in position order: each kept once (one at or below the newest held one is skipped); h1 follows the payload.
   *  Returns the events newly held, in order. */
  append(events: readonly SceneEvent[], h1: number): SceneEvent[] {
    const out: SceneEvent[] = [];
    for (const e of events) {
      const last = this.events[this.events.length - 1];
      if (last !== undefined && comparePos(e, last) <= 0) continue;
      try {
        this.headReducer.push(e);
      } catch {
        continue;                                    // not after the head scene: already in it
      }
      this.events.push(e);
      out.push(e);
    }
    this.h1 = Math.max(this.h1, h1);
    return out;
  }

  /** room_snapshot (12 §3.9.2): the view restarts as one segment at the new tip; a load in flight for the old view is dropped (its
   *  waiting target and "load earlier" stay and load again against the new view). */
  snapshot(start: Scene, window: { h0: number; h1: number }): void {
    this.epoch++;
    this.h0 = Math.min(this.h0, window.h0);
    this.h1 = window.h1;
    this.segments = [{ hs: window.h1, start }];
    this.events = [];
    this.seekCache = new SeekCache(() => this.view());
    this.headReducer = new SceneReducer(start, () => this.layoutNow);
  }

  /** The newest height the page knows. */
  top(): number {
    return Math.max(this.h1, this.events.length === 0 ? Number.NEGATIVE_INFINITY : this.events[this.events.length - 1]!.height);
  }

  /** The page holds every event of h: h lies in the one contiguous run from the lowest segment to the top. */
  holds(h: number): boolean {
    return Number.isSafeInteger(h) && h >= this.segments[0]!.hs && h <= this.top();
  }

  /** The scene at the end of height h, or null when the page does not hold h (VIZ-26: never a scene of another height). */
  sceneAt(h: number): Scene | null {
    return this.holds(h) ? this.seekCache.sceneAt({ height: h, sub: END, k: END }) : null;
  }

  /** The next height above h that has an event the page holds, else null. */
  nextHeight(h: number): number | null {
    const ev = this.events;
    let lo = 0, hi = ev.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (ev[mid]!.height > h) hi = mid;
      else lo = mid + 1;
    }
    return lo < ev.length ? ev[lo]!.height : null;
  }

  loading(): boolean {
    return this.busy;
  }
  /** "Load earlier" can be used: an earlier segment exists and no load runs. */
  canEarlier(): boolean {
    return this.h0 > 0 && !this.busy;
  }

  /** Loads pages until h is held (within the window). While a load runs, h replaces the waiting target and loads after it. Resolves
   *  when the room's loads have drained (or one failed); the caller reads holds(). */
  want(h: number): Promise<void> {
    this.target = h;
    return this.pump();
  }

  /** The page no longer waits for a height (it went live, or showed a held one): a load in flight finishes, nothing more is asked. */
  dropTarget(): void {
    this.target = null;
  }

  /** "Load earlier" (12 §3.9.1, R-V29): the held range is made contiguous down to h0, then the window grows by one segment of 256. */
  earlier(): Promise<void> {
    if (this.h0 > 0) this.earlierWanted = true;
    return this.pump();
  }

  private pump(): Promise<void> {
    if (!this.busy) this.draining = this.drain();
    return this.draining;
  }

  private async drain(): Promise<void> {
    this.busy = true;
    this.io.changed();
    try {
      for (let job = this.plan(); job !== null; job = this.plan()) {
        const epoch = this.epoch;
        const pages = await this.range(job, epoch);
        if (epoch !== this.epoch) continue;          // a snapshot replaced the view meanwhile: plan again against it
        if (pages === null) {
          this.target = null;                        // failed: nothing waits any more (the page stays where it was)
          this.earlierWanted = false;
          break;
        }
        this.merge(pages);
        if (job.earlier) this.earlierWanted = false;
        this.io.changed();
      }
    } finally {
      this.busy = false;
      this.io.changed();
    }
  }

  /** The next range to request, or null when the waiting target is held and no earlier segment is asked for. The window holds the
   *  heights from its first one (h0 + 1; height h0 > 0 belongs to the segment below and shows as the window segment's start scene),
   *  so the lowest segment the window can reach starts at h0 (−1 for the genesis segment, whose heights start at 0); an earlier
   *  segment is asked as its own heights [h0' + 1, h0] (12 §3.3.5; the genesis segment [0, h0], which the server answers in two
   *  pages). */
  private plan(): Job | null {
    const lowest = this.segments[0]!.hs;
    const floor = firstHeight(this.h0) - 1;
    const down = (goal: number): Job | null =>
      (lowest > goal ? { from: Math.max(floor + 1, lowest - (PAGE_HEIGHTS_MAX - 1)), to: lowest, earlier: false } : null);
    if (this.target !== null) {
      const job = down(Math.max(this.target, floor));
      if (job !== null) return job;
      this.target = null;
    }
    if (this.earlierWanted) {
      if (this.h0 <= 0) {
        this.earlierWanted = false;
        return null;
      }
      return down(floor) ?? { from: firstHeight(Math.max(0, this.h0 - PAGE_HEIGHTS_MAX)), to: this.h0, earlier: true };
    }
    return null;
  }

  /** The pages of [from, to], each continuing where the last one ended; null when one fails or does not fit (another room, another
   *  start, beyond what was asked, an event outside its range), or when the view changed meanwhile (the caller plans again). */
  private async range(job: Job, epoch: number): Promise<P[] | null> {
    const pages: P[] = [];
    for (let f = job.from; f <= job.to;) {
      let p: P | null;
      try {
        p = await this.io.page(f, job.to);
      } catch {
        return null;
      }
      if (epoch !== this.epoch) return null;
      if (p === null || p.room !== this.id || p.from !== f || !Number.isSafeInteger(p.to) || p.to < f || p.to > job.to) return null;
      const from = p.from, to = p.to;
      if (!p.events.every((e) => e.height >= from && e.height <= to)) return null;
      pages.push(p);
      f = p.to + 1;
    }
    return pages;
  }

  /** One whole range joins the view: its segments below the lowest one (each page from the scene at the end of from − 1), its events
   *  among the held ones (each position once); an earlier segment's range [h0' + 1, h0] (or [0, h0]) moves h0 down to h0'. */
  private merge(pages: readonly P[]): void {
    this.io.merged(pages);
    for (const p of pages) this.segments.push({ hs: p.from - 1, start: p.start });
    this.segments.sort((a, b) => a.hs - b.hs);
    const held = new Set(this.events.map(posKey));
    const added = pages.flatMap((p) => p.events).filter((e) => !held.has(posKey(e)));
    if (added.length > 0) this.events = [...added, ...this.events].sort(comparePos);
    this.h0 = Math.min(this.h0, Math.max(0, pages[0]!.from - 1));
  }
}

/** The first height of a window that starts at h0 (glossary "segment": h0 + 1, or 0 for the genesis segment). */
function firstHeight(h0: number): number {
  return h0 === 0 ? 0 : h0 + 1;
}

/** One live beat (12 §3.9.2, §3.7 "Beats"): the events of the next queued height played onto the scene on screen, or a snap to the
 *  newest scene when more than 5 s of beats are queued ("caught up" at the newest queued height). */
export type LiveBeat =
  | { kind: 'beat'; height: number; events: SceneEvent[]; scene: Scene }
  | { kind: 'snap'; height: number; scene: Scene };

/** The live scene on screen and the stream events not yet played (300 ms beats, a snap after a 5 s backlog). */
export class LivePlayer {
  private shown: SceneReducer;
  private queue: SceneEvent[] = [];

  constructor(start: Scene, private readonly layout: () => Layout) {
    this.shown = new SceneReducer(start, layout);
  }

  /** The scene on screen becomes s; nothing stays queued. */
  reset(s: Scene): void {
    this.shown = new SceneReducer(s, this.layout);
    this.queue = [];
  }
  push(events: readonly SceneEvent[]): void {
    this.queue.push(...events);
  }
  queued(): number {
    return this.queue.length;
  }
  /** The scene on screen (a copy). */
  scene(): Scene {
    return this.shown.scene();
  }

  /** The next beat, or null with nothing queued; head gives the newest scene for a snap. */
  beat(head: () => Scene): LiveBeat | null {
    if (this.queue.length === 0) return null;
    const heights = new Set(this.queue.map((e) => e.height));
    if (liveSnap(heights.size)) {
      const height = this.queue[this.queue.length - 1]!.height;
      this.reset(head());
      return { kind: 'snap', height, scene: this.scene() };
    }
    const height = this.queue[0]!.height;
    const events = this.queue.filter((e) => e.height === height);
    this.queue = this.queue.filter((e) => e.height !== height);
    for (const e of events) {
      try {
        this.shown.push(e);
      } catch {
        // already on screen
      }
    }
    return { kind: 'beat', height, events, scene: this.scene() };
  }
}
