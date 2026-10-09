// Seeking on the page (12 §3.9.1 "Seeking", §3.5.3 "Rewinding"; VIZ-16, VIZ-26; R-V51): the page keeps a reduced scene every
// 64 heights of each segment and reduces forward from the nearest one ≤ the target in the target's segment, with the model's
// own reducer, so the result equals reduceScene from the segment start. A seek never changes the layout: the head layout stays
// and desks first touched after the scene position are drawn dashed. Pure and DOM-free (R-V33).
import type { DeskRef, Position, SceneEvent } from '../model/events.js';
import type { Layout } from '../model/layout.js';
import { deskDimmed, reduceScene, type Scene, type TimelineView } from '../model/scene.js';

export const SEEK_CACHE_EVERY = 64;

const END = Number.MAX_SAFE_INTEGER;

/** The first index of a position-ordered event list whose height is above h. */
function firstAbove(events: readonly SceneEvent[], h: number): number {
  let lo = 0, hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (events[mid]!.height > h) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** A cached scene: the reduction of its segment up to the end of height `b` (a multiple of 64 above the segment's hs). */
interface Entry { hs: number; start: Scene; scene: Scene; }

/**
 * Scenes of one room's TimelineView (12 §3.3.5: segment i holds the events of heights (hs_i, hs_i+1], the first one also those at
 * or below its hs). A scene is cached at the end of height hs + 64·m only below the target height and below the newest event's
 * height, so every event it covers has arrived (a live view grows only above its newest height; a height may arrive in several
 * messages). An entry is used only while its segment's start scene is the same object; invalidate() drops the entries a changed
 * range can reach. Every returned scene is a fresh copy.
 */
export class SeekCache {
  private readonly cache = new Map<number, Entry>();
  constructor(private readonly view: () => TimelineView) {}

  /** reduceScene(view, at), from the nearest cached scene ≤ at in at's segment. */
  sceneAt(at: Position): Scene {
    const v = this.view();
    const segs = v.segments;
    if (segs.length === 0) return reduceScene(v, at);
    let i = 0;
    for (let j = 0; j < segs.length; j++) if (segs[j]!.hs < at.height) i = j;
    const seg = segs[i]!;
    const upTo = i + 1 < segs.length ? segs[i + 1]!.hs : Number.POSITIVE_INFINITY;
    const top = v.events.length === 0 ? Number.NEGATIVE_INFINITY : v.events[v.events.length - 1]!.height;
    // The highest boundary below both the target height and the newest height (so b < at.height ≤ upTo: inside the segment).
    const b = seg.hs + SEEK_CACHE_EVERY * Math.floor((Math.min(at.height, top) - 1 - seg.hs) / SEEK_CACHE_EVERY);
    if (!(b > seg.hs)) return this.reduceFrom(v, seg.start, i === 0 ? 0 : firstAbove(v.events, seg.hs), upTo, at);
    const base = this.entry(v, i, b);
    return this.reduceFrom(v, base, firstAbove(v.events, b), upTo, at);
  }

  /** The page holds the events of h: from its first segment's hs to its newest height. */
  holds(h: number): boolean {
    const v = this.view();
    if (v.segments.length === 0) return false;
    const newest = Math.max(v.segments[v.segments.length - 1]!.hs, v.events.length === 0 ? Number.NEGATIVE_INFINITY : v.events[v.events.length - 1]!.height);
    return h >= v.segments[0]!.hs && h <= newest;
  }

  /** The page's events from fromHeight on changed (a page loaded earlier, a snapshot): every cached scene at or above it goes. */
  invalidate(fromHeight: number): void {
    for (const [b, e] of this.cache) if (b >= fromHeight || e.hs >= fromHeight) this.cache.delete(b);
  }

  /** The scene at the end of height b of segment i, built from the entry 64 heights below it (or the segment start). */
  private entry(v: TimelineView, i: number, b: number): Scene {
    const seg = v.segments[i]!;
    const hit = this.cache.get(b);
    if (hit !== undefined && hit.hs === seg.hs && hit.start === seg.start) return hit.scene;
    const prev = b - SEEK_CACHE_EVERY;
    const at: Position = { height: b, sub: END, k: END };
    const scene = prev > seg.hs
      ? this.reduceFrom(v, this.entry(v, i, prev), firstAbove(v.events, prev), b, at)
      : this.reduceFrom(v, seg.start, i === 0 ? 0 : firstAbove(v.events, seg.hs), b, at);
    this.cache.set(b, { hs: seg.hs, start: seg.start, scene });
    return scene;
  }

  /** reduceScene over one segment that starts at `start` and holds events[from..] up to height upTo, stopped at `at`. */
  private reduceFrom(v: TimelineView, start: Scene, from: number, upTo: number, at: Position): Scene {
    const events = v.events.slice(from, firstAbove(v.events, Math.min(upTo, at.height)));
    return reduceScene({ segments: [{ hs: start.at.height, start }], events, layout: v.layout }, at);
  }
}

/** The static layer's options for a scene, structurally render/raster.ts's StaticOptions (ui/** imports nothing from render/**): dashedFrom = s.at.height on a
 *  past scene, null live (R-V51); dimmed by deskDimmed; lockbox desks from the layout. */
export function staticFor(layout: Layout, s: Scene, o: { live: boolean; coarse: boolean }):
  { dashedFrom: number | null; dimmed: ReadonlySet<DeskRef>; coarse: boolean; lockboxDesks: ReadonlySet<DeskRef> } {
  const dimmed = new Set<DeskRef>();
  const lockboxDesks = new Set<DeskRef>();
  for (const d of layout.desks) {
    if (deskDimmed(s, d.ordinal)) dimmed.add(d.ordinal);
    if (d.lockbox) lockboxDesks.add(d.ordinal);
  }
  return { dashedFrom: o.live ? null : s.at.height, dimmed, coarse: o.coarse, lockboxDesks };
}
