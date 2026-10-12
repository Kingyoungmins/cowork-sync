// One room's store (12 §3.3.3, §3.8, §3.9.1, §3.9.2, §3.10.5, §3.10.6, §6; VIZ-07, VIZ-09, VIZ-11, VIZ-13, VIZ-14, VIZ-15, VIZ-26,
// VIZ-41; rulings R-V19, R-V21, R-V28, R-V29, R-V31, R-V46): the window [h0, h1] of a room's board, folded by the room source
// into the deterministic timeline of model/timeline.ts and kept within the memory budget, the live poll step, timeline pages
// and "load earlier", the room's badges and its local overlay.
//
// Memory (VIZ-41): no TimelineBuilder outlives an operation. Each one builds a fresh builder from what the store keeps — the live
// head continues from the head's carry on an unfrozen copy of the current layout (TimelineBuilder.replay(carry, layout, false)),
// a re-fold of a dropped range replays from a kept checkpoint on a frozen copy, and "load earlier" opens a segment on the current
// layout — so desks that any of them appends land in the one layout every later builder starts from (VIZ-16). Kept for the whole
// window: at every checkpoint height (and at each segment start) the fold state, the builder's carry and with it the scene at the
// last position of that height; the rewind-bar ticks; the seen anchors. Kept for the newest heights only: events and cards above
// the oldest kept checkpoint at or above h1 − 2,048 (so at most 2,048 heights, and every page above it is served from memory).
//
// Concurrency: tick(), page() and earlier() of one room run one at a time (the poll loop and the HTTP routes call them), so a room
// never has two git children at once (12 §3.9.2) and the source's pinned tip is never moved under a page's re-fold.
import { CHECKPOINT_EVERY, type FoldState } from '../../board/fold.js';
import type { Clock } from '../../ports/clock.js';
import type { Fs } from '../../ports/fs.js';
import { STATUS_STATES } from '../i18n/codes.js';
import type { Card } from '../model/cards.js';
import type { PeerRef, SceneEvent, SeatRef } from '../model/events.js';
import { ZERO_PEER, type Frame } from '../model/frame.js';
import { emptyLayout, type Layout, type LayoutDelta } from '../model/layout.js';
import { lookTable } from '../model/looks.js';
import { emptyScene, SceneReducer, type Scene } from '../model/scene.js';
import { TimelineBuilder, type Carry } from '../model/timeline.js';
import type { BoundedReader } from '../source/boundedRead.js';
import type { Overlay, RoomSource, RoomSpec, TipInfo } from '../source/roomSource.js';
import { overlayOf, readPeerFile, readStatus, youOf, type StatusRead } from '../source/status.js';
import type { CardModel, PeerInfo, PetInfo, RoomBadge, RoomDelta, RoomSnapshotModel, StoreLike, Tick, TimelinePageModel } from './models.js';
import type { VizLog } from './vizLog.js';

export interface StoreDeps { clock: Clock; fs: Fs; reader: BoundedReader; log: VizLog; viewerVersion: string; machineMonoMs(): number; }
/** Heights of events and cards kept in memory per room (VIZ-41); heights per timeline page and per "load earlier" segment (R-V29);
 *  more new board commits than this in one tick make one snapshot delta (12 §3.9.2); the cards a snapshot carries. */
export const RETAIN_HEIGHTS = 2_048, PAGE_HEIGHTS = 256, SNAPSHOT_AFTER = 64, LAST_CARDS = 200;

/** 12 §3.3.3: the initial window holds the tip and at least this many heights below it (h0 = 256 · ⌊max(0, t − 1,023) / 256⌋). */
const WINDOW_BELOW = 1_023;
/** The room's badges in the order they are served (RoomBadge's own order). */
const BADGE_ORDER: readonly RoomBadge[] = ['UI_VIZ_VERSION_SKEW', 'UI_VIZ_NEWER_PROTOCOL', 'UI_VIZ_CHECKPOINT_MISMATCH', 'UI_VIZ_INCIDENT_FROZEN', 'UI_VIZ_NO_BOARD'];
/** The status read standing in for a status.json never read (a read that failed before any succeeded). */
const NOT_READ: StatusRead = { present: true, unreadable: false, mtimeNs: null, fields: null };

type TickResult = { delta: RoomDelta | null; overlay: Overlay | null; change: 'state' | 'rebuilt' | null };

/**
 * A kept resume point: the fold state after height h and the builder's carry there — at a segment start, that segment's start
 * carry (its start scene, no saved desks); h = −1 is the genesis segment's start (initialFoldState, frames from 0).
 */
interface Point { h: number; state: FoldState; carry: Carry; }
/** The head of the window: the fold state after h1, the builder's carry at h1 and the tip info of h1 (advance() compares with it). */
interface Head { state: FoldState; carry: Carry; tip: TipInfo; }
/** What the store keeps of one window (replaced as a whole by a rebuild). */
interface RoomWindow {
  h0: number;
  h1: number;
  layout: Layout;
  points: Point[];                    // ascending h: every segment start and every checkpoint height inside the window
  lo: number;                         // events and cards of heights above lo are kept (lo is a point's h)
  events: SceneEvent[];
  cards: Card[];
  ticks: Tick[];                      // the whole window
  anchors: Map<number, number>;       // height → Δmono of its fold by tick()'s fast-forward (R-V28); the whole window
  unknown: number;
  head: Head;
}
/** What one run of frames gave (folded by one builder). */
interface Run { events: SceneEvent[]; cards: Card[]; unknown: number; points: Point[]; protoMismatch: boolean; mismatch: boolean; last: Frame | null; }
/** The page-ready output of a fresh "load earlier" segment, served without folding it again. */
interface Fresh { c0: number; end: number; events: SceneEvent[]; cards: Card[]; }

/** R-V28: the rewind-bar glyph of a scene event, or null. */
function glyphOf(e: SceneEvent): Tick['glyph'] | null {
  switch (e.kind) {
    case 'publish': return 'publish';
    case 'conflict': return 'conflict';
    case 'request_open': return 'request';
    case 'save': return 'save';
    case 'person_enter': case 'person_respawn': case 'person_exit': return 'door';
    case 'person_freeze': return 'freeze';
    default: return null;
  }
}
function ticksOf(events: readonly SceneEvent[]): Tick[] {
  const out: Tick[] = [];
  for (const e of events) {
    const glyph = glyphOf(e);
    if (glyph !== null) out.push({ h: e.height, glyph });
  }
  return out;
}

/** The first index of a height-ordered list whose height is above h. */
function firstAbove<T>(list: readonly T[], h: number, heightOf: (x: T) => number): number {
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (heightOf(list[mid]!) > h) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
const eventHeight = (e: SceneEvent): number => e.height;
const cardHeight = (c: Card): number => c.at.height;
/** The items of heights (lo, hi]. */
const between = <T>(list: readonly T[], lo: number, hi: number, heightOf: (x: T) => number): T[] => list.slice(firstAbove(list, lo, heightOf), firstAbove(list, hi, heightOf));

/** The additions from layout a to layout b, as one delta (what LayoutBuilder.takeDelta gives across them); null when none. */
function layoutDelta(a: Layout, b: Layout): LayoutDelta | null {
  if (b.version === a.version) return null;
  return {
    fromVersion: a.version, version: b.version,
    zones: b.zones.filter((z, i) => i >= a.zones.length || z.cells.length !== a.zones[i]!.cells.length).map((z) => ({ index: z.index, key: z.key, cells: [...z.cells] })),
    desks: b.desks.slice(a.desks.length), homeOrder: b.homeOrder.slice(a.homeOrder.length),
  };
}

/** The scene at the last position of height h (its last event, or (h, 0, 0) with an empty beat when it has none), from a kept
 *  carry scene and the events after it up to h — the same form as TimelineBuilder.carry(). */
function sceneAtEnd(start: Scene, events: readonly SceneEvent[], layout: Layout, h: number): Scene {
  const r = new SceneReducer(start, () => layout);
  for (const e of events) {
    if (e.height > h) break;
    r.push(e);
  }
  const s = r.scene();
  if (s.at.height < h) {
    s.at = { height: h, sub: 0, k: 0 };
    s.beat = [];
  }
  return s;
}

function peerInfos(s: FoldState): Map<PeerRef, PeerInfo> {
  const out = new Map<PeerRef, PeerInfo>();
  for (const peer of Object.keys(s.peers).sort()) {
    const r = s.peers[peer]!;
    out.set(peer, { display: r.display, pluginVersion: r.plugin_version, status: r.status });
  }
  return out;
}
function petInfos(s: Scene): Map<SeatRef, PetInfo> {
  const out = new Map<SeatRef, PetInfo>();
  for (const seat of [...s.pets.keys()].sort()) {
    const p = s.pets.get(seat)!;
    out.set(seat, { owner: p.owner, live: p.live, ssCode: p.ssCode, variant: p.variant });
  }
  return out;
}
/** The entries of `after` that are new or differ from `before`. */
function changedOnly<K, V extends object>(before: ReadonlyMap<K, V>, after: ReadonlyMap<K, V>): Map<K, V> {
  const out = new Map<K, V>();
  for (const [k, v] of after) {
    const was = before.get(k);
    if (was === undefined || JSON.stringify(was) !== JSON.stringify(v)) out.set(k, v);
  }
  return out;
}

/** Pushes every frame into `b`; checkpoint heights `keep` admits become points (the fold state after them and b's carry there).
 *  Stops at the first error (a missing object, R-V19; a git failure), returning what was folded before it. */
async function foldRun(b: TimelineBuilder, frames: AsyncIterable<Frame>, keep: (h: number) => boolean, each?: (f: Frame) => void): Promise<{ run: Run; error: unknown }> {
  const run: Run = { events: [], cards: [], unknown: 0, points: [], protoMismatch: false, mismatch: false, last: null };
  try {
    for await (const f of frames) {
      const o = b.push(f);
      for (const e of o.events) run.events.push(e);
      for (const c of o.cards) run.cards.push(c);
      run.unknown += o.unknown;
      if (f.protoMismatch) run.protoMismatch = true;
      if (f.checkpoint === 'mismatch') run.mismatch = true;
      if (f.height % CHECKPOINT_EVERY === 0 && keep(f.height)) run.points.push({ h: f.height, state: f.after, carry: b.carry() });
      run.last = f;
      each?.(f);
    }
    return { run, error: null };
  } catch (e) {
    return { run, error: e };
  }
}

export class RoomStore implements StoreLike {
  readonly ready: Promise<void>;
  private readonly spec: RoomSpec;
  private readonly source: RoomSource;
  private readonly deps: StoreDeps;
  private markReady: () => void = () => {};
  private started: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private win: RoomWindow | null = null;
  /** The room's badges, one set (Task 20 adds UI_VIZ_CLAIMS_PENDING to it): VERSION_SKEW from the overlay, NEWER_PROTOCOL and
   *  CHECKPOINT_MISMATCH latched by any frame of the window (a rebuild clears them), INCIDENT_FROZEN, NO_BOARD. */
  private readonly badges = new Set<RoomBadge>();
  private gone = false;
  private frozen = false;
  /** The last parsed heartbeat when the room froze: a rebuild needs a newer one (VIZ-14). */
  private freezeHeartbeat = Number.NEGATIVE_INFINITY;
  /** A tip the last fold did not reach (a missing object, R-V19): folded towards again next tick without waiting for changed(). */
  private pending: TipInfo | null = null;
  /** The last window build failed after the tip resolved: built again next tick. */
  private retryBuild = false;
  private status: StatusRead | null = null;
  private peerFile: PeerRef | null = null;
  private overlay: Overlay | null = null;
  private overlayKey = '';
  /** The room header (badges, gone, unknown) as last reported; a tick reports 'state' when it differs. */
  private reported = '';

  constructor(spec: RoomSpec, source: RoomSource, deps: StoreDeps) {
    this.spec = spec;
    this.source = source;
    this.deps = deps;
    this.ready = new Promise<void>((resolve) => { this.markReady = resolve; });
  }

  /** The first window (VIZ-09): never rejects — a missing board, a git failure or an incident state leave an empty room with its
   *  badge, and `ready` resolves either way. Idempotent. */
  init(): Promise<void> {
    this.started ??= this.exclusive(() => this.initNow()).then(() => this.markReady(), () => this.markReady());
    return this.started;
  }

  async tick(): Promise<TickResult> {
    await this.init();
    return this.exclusive(() => this.tickNow());
  }

  async page(from: number, to: number): Promise<TimelinePageModel | null> {
    await this.init();
    return this.exclusive(() => this.pageNow(from, to));
  }

  async earlier(): Promise<TimelinePageModel | null> {
    await this.init();
    return this.exclusive(async () => {
      const w = this.win;
      if (w === null) return null;
      const x = await this.extend(w);
      if (x === null) return null;
      // The new segment's own heights: [h0' + 1, hs] (the old h0 included), or [0, 255] of the genesis segment's 257.
      const f = firstHeight(w.h0);
      const p = await this.servePage(w, f, f + PAGE_HEIGHTS - 1, x.fresh);
      return p === null ? null : { ...p, layout: x.layout };
    });
  }

  snapshot(): RoomSnapshotModel {
    const w = this.win;
    const common = { spec: this.spec, gone: this.gone, badges: this.badgeList(), overlay: this.overlay };
    if (w === null) {
      return {
        ...common, window: { h0: 0, h1: 0 }, unknown: 0, layout: emptyLayout(), looks: new Map(), peers: new Map(), pets: new Map(),
        scene: emptyScene({ height: 0, sub: 0, k: 0 }), cards: [], ticks: [],
      };
    }
    return {
      ...common, window: { h0: w.h0, h1: w.h1 }, unknown: w.unknown, layout: w.layout, looks: lookTable(w.layout.homeOrder),
      peers: peerInfos(w.head.state), pets: petInfos(w.head.carry.scene), scene: w.head.carry.scene, cards: this.lastCards(w), ticks: [...w.ticks],
    };
  }

  // ---- the operations, one at a time ------------------------------------------------------------------------------------

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async initNow(): Promise<void> {
    const gitDir = this.spec.gitDir;
    if (gitDir !== null) this.peerFile = await readPeerFile(gitDir, this.deps.reader);
    await this.refreshLocal();
    if (this.status?.fields?.state === 'incident') this.freeze();
    else await this.build(emptyLayout());
    this.reported = this.header();
  }

  /** One poll step (12 §3.9.2): the local status, then the board — unless the room is gone or frozen. */
  private async tickNow(): Promise<TickResult> {
    const overlay = await this.refreshLocal();
    let delta: RoomDelta | null = null;
    let rebuilt = false;
    if (!this.gone && (await this.gitDirGone())) this.gone = true;
    if (!this.gone) {
      if (this.frozen) {
        if (this.thawed()) rebuilt = await this.build(this.win?.layout ?? emptyLayout());
      } else if (this.status?.fields?.state === 'incident') {
        this.freeze();
      } else if (this.win === null) {
        if (this.retryBuild || (await this.changed())) rebuilt = await this.build(emptyLayout());
      } else {
        delta = await this.follow(this.win);
      }
    }
    const header = this.header();
    const change = rebuilt ? 'rebuilt' : header !== this.reported ? 'state' : null;
    this.reported = header;
    return { delta, overlay, change };
  }

  /** The window for the current tip on `layout` (R-V21: a rebuild keeps the desks), swapped in whole on success. */
  private async build(layout: Layout): Promise<boolean> {
    try {
      const tip = await this.source.tip();
      this.retryBuild = false;
      if (tip === null) {
        this.badges.add('UI_VIZ_NO_BOARD');
        return false;
      }
      const { w, run } = await this.window(tip, layout);
      this.win = w;
      this.frozen = false;
      this.pending = null;
      for (const b of ['UI_VIZ_INCIDENT_FROZEN', 'UI_VIZ_NO_BOARD', 'UI_VIZ_NEWER_PROTOCOL', 'UI_VIZ_CHECKPOINT_MISMATCH'] as const) this.badges.delete(b);
      this.latch(run);
      return true;
    } catch (e) {
      this.noBoard(e);
      this.retryBuild = true;
      return false;
    }
  }

  /** VIZ-09: h0 = 256 · ⌊max(0, t − 1,023) / 256⌋; from initialFoldState at 0 (frames from 0), else from the checkpoint at h0. */
  private async window(tip: TipInfo, layout: Layout): Promise<{ w: RoomWindow; run: Run }> {
    const h0 = CHECKPOINT_EVERY * Math.floor(Math.max(0, tip.height - WINDOW_BELOW) / CHECKPOINT_EVERY);
    const start = await this.source.startAt(h0);
    const b = TimelineBuilder.open(h0, start, layout);
    const startCarry = b.carry();
    const { run, error } = await foldRun(b, this.source.frames(start, h0 === 0 ? 0 : h0 + 1, tip.height, this.self()), () => true);
    if (error !== null) throw error;
    if ((run.last?.height ?? start.height) !== tip.height) throw new RangeError(`RoomStore: the window of a tip at ${tip.height} ended at ${run.last?.height ?? start.height}`);
    const w: RoomWindow = {
      h0, h1: tip.height, layout: b.timeline().layout, points: [{ h: start.height, state: start, carry: startCarry }, ...run.points],
      lo: start.height, events: run.events, cards: run.cards, ticks: ticksOf(run.events), anchors: new Map(), unknown: run.unknown,
      head: { state: run.last?.after ?? start, carry: b.carry(), tip },
    };
    retain(w);
    return { w, run };
  }

  /** NEWER_PROTOCOL and CHECKPOINT_MISMATCH from a run's frames (12 §3.3.3 "Version coupling", "Checkpoints"): display only. */
  private latch(run: Run): void {
    if (run.protoMismatch) this.badges.add('UI_VIZ_NEWER_PROTOCOL');
    if (run.mismatch) this.badges.add('UI_VIZ_CHECKPOINT_MISMATCH');
  }

  /** changed() → advance() (R-V31) → fold a fast-forward; a pending tip is folded towards without waiting for changed(). */
  private async follow(w: RoomWindow): Promise<RoomDelta | null> {
    try {
      let target: TipInfo;
      if (await this.changed()) {
        const a = await this.source.advance(w.head.tip);
        if (a.kind === 'none') {
          this.pending = null;
          this.badges.delete('UI_VIZ_NO_BOARD');
          return null;
        }
        if (a.kind === 'gone') {
          this.pending = null;
          this.badges.add('UI_VIZ_NO_BOARD');
          return null;
        }
        if (a.kind === 'rewrite') {
          this.freeze();
          return null;
        }
        target = a.to;
      } else if (this.pending !== null) {
        target = this.pending;
      } else {
        return null;
      }
      return await this.fastForward(w, target);
    } catch (e) {
      this.noBoard(e);
      return null;
    }
  }

  /** Folds h1 + 1 … target onto the head (every height folded here gets its seen anchor, R-V28); what folded before a failure is
   *  kept, the rest stays pending (R-V19). > SNAPSHOT_AFTER heights → one snapshot delta. */
  private async fastForward(w: RoomWindow, target: TipInfo): Promise<RoomDelta | null> {
    const layout0 = w.layout, peers0 = peerInfos(w.head.state), pets0 = petInfos(w.head.carry.scene), h1 = w.h1;
    const b = TimelineBuilder.replay(w.head.carry, w.layout, false);
    const anchors: Array<[number, number]> = [];
    const { run, error } = await foldRun(b, this.source.frames(w.head.state, w.h1 + 1, target.height, this.self()), () => true,
      (f) => anchors.push([f.height, this.deps.clock.monoMs()]));
    const last = run.last;
    if (last !== null) {
      w.h1 = last.height;
      w.layout = b.timeline().layout;
      w.head = { state: last.after, carry: b.carry(), tip: last.height === target.height ? target : { height: last.height, key: last.oid } };
      w.events = w.events.concat(run.events);
      w.cards = w.cards.concat(run.cards);
      w.ticks = w.ticks.concat(ticksOf(run.events));
      w.points = w.points.concat(run.points);
      for (const [h, at] of anchors) w.anchors.set(h, at);
      w.unknown += run.unknown;
      this.latch(run);
      retain(w);
    }
    if (error !== null) {
      this.pending = target;
      this.noBoard(error);
    } else {
      this.pending = null;
      this.badges.delete('UI_VIZ_NO_BOARD');
    }
    if (last === null) return null;
    const base = {
      roomId: this.spec.id, window: { h0: w.h0, h1: w.h1 }, layout: layoutDelta(layout0, w.layout),
      peers: changedOnly(peers0, peerInfos(w.head.state)), pets: changedOnly(pets0, petInfos(w.head.carry.scene)),
    };
    // A snapshot carries the ticks of the newly folded heights only, like a timeline delta: h0 never moves here, so the page appends
    // them to the window's ticks it holds (8a final review B1; the whole window's would turn a big catch-up into a reset).
    if (w.h1 - h1 > SNAPSHOT_AFTER) return { ...base, kind: 'snapshot', events: [], cards: this.lastCards(w), ticks: ticksOf(run.events), scene: w.head.carry.scene };
    return { ...base, kind: 'timeline', events: run.events, cards: run.cards.map((c) => this.model(w, c)), ticks: ticksOf(run.events), scene: null };
  }

  /** "Load earlier" (R-V29): one segment of 256 below h0 on the current layout, its new desks as one layout delta; no anchor. */
  private async extend(w: RoomWindow): Promise<{ fresh: Fresh; layout: LayoutDelta | null } | null> {
    if (w.h0 === 0 || this.frozen) return null;
    const hs = w.h0, h0 = hs - PAGE_HEIGHTS;
    try {
      const start = await this.source.startAt(h0);
      const b = TimelineBuilder.open(h0, start, w.layout);
      const startCarry = b.carry();
      // The segment's own checkpoints (0 in the genesis segment) become points; hs keeps the start point of the segment above.
      const { run, error } = await foldRun(b, this.source.frames(start, h0 === 0 ? 0 : h0 + 1, hs, this.self()), (h) => h < hs);
      if (error !== null) throw error;
      if (run.last?.height !== hs) throw new RangeError(`RoomStore: the segment below ${hs} ended at ${run.last?.height ?? start.height}`);
      const layout = b.timeline().layout;
      const delta = layoutDelta(w.layout, layout);
      w.h0 = h0;
      w.layout = layout;
      w.points = [{ h: start.height, state: start, carry: startCarry }, ...run.points, ...w.points];
      w.ticks = ticksOf(run.events).concat(w.ticks);
      w.unknown += run.unknown;
      this.latch(run);
      const lo = retainedFrom(w);
      if (lo < w.lo) {
        w.events = between(run.events, lo, hs, eventHeight).concat(w.events);
        w.cards = between(run.cards, lo, hs, cardHeight).concat(w.cards);
        w.lo = lo;
      }
      return { fresh: { c0: start.height, end: hs, events: run.events, cards: run.cards }, layout: delta };
    } catch (e) {
      this.log(() => this.deps.log.error('UI_VIZ_NO_BOARD', e));
      return null;
    }
  }

  /** 12 §3.10.5: a `from` below the window's first height (h0 + 1; height h0 belongs to the segment below) extends the window by one
   *  segment and answers its page from max(from, its first height) (R-V29; a `to` below that reads as the segment's page); otherwise
   *  the page as asked. */
  private async pageNow(from: number, to: number): Promise<TimelinePageModel | null> {
    const w = this.win;
    if (w === null || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < 0) return null;
    if (from >= firstHeight(w.h0)) return this.servePage(w, from, to, null);
    const x = await this.extend(w);
    if (x === null) return null;
    const f = Math.max(from, firstHeight(w.h0));
    const p = await this.servePage(w, f, to < f ? f + PAGE_HEIGHTS - 1 : to, x.fresh);
    return p === null ? null : { ...p, layout: x.layout };
  }

  /**
   * The page [from, to] of the window (from at or above its first height), to clipped at h1, at 256 heights and at the next segment
   * start — every checkpoint height, so a page holds heights of one segment (hs, hs + 256] only (glossary "segment"). Its scene: the
   * segment's start scene when from is the segment's first height (hs + 1, or 0 for the genesis segment), else the scene at the last
   * position of from − 1 (12 §3.10.6). Served from memory when every event it needs is kept, else re-folded from the kept point c at
   * or below from − 1: the frames c + 1 … to, at most 256 folds and at most 255 before from (VIZ-26), on a frozen copy of the head
   * layout, with the stored seen anchors (R-V28). Never while frozen.
   */
  private async servePage(w: RoomWindow, from: number, to: number, fresh: Fresh | null): Promise<TimelinePageModel | null> {
    if (from < firstHeight(w.h0) || from > w.h1 || to < from) return null;
    const next = from === 0 ? PAGE_HEIGHTS : PAGE_HEIGHTS * Math.ceil(from / PAGE_HEIGHTS);
    to = Math.min(to, w.h1, from + PAGE_HEIGHTS - 1, next);
    const c = pointFor(w, from);
    let events: SceneEvent[];
    let cards: Card[];
    if (fresh !== null && c.h >= fresh.c0 && to <= fresh.end) {
      events = between(fresh.events, c.h, to, eventHeight);
      cards = between(fresh.cards, c.h, to, cardHeight);
    } else if (c.h >= w.lo) {
      events = between(w.events, c.h, to, eventHeight);
      cards = between(w.cards, c.h, to, cardHeight);
    } else {
      if (this.frozen) return null;                              // VIZ-14: no fold while frozen
      const b = c.h < 0 ? TimelineBuilder.open(0, c.state, w.layout) : TimelineBuilder.replay(c.carry, w.layout);
      const { run, error } = await foldRun(b, this.source.frames(c.state, c.h + 1, to, this.self()), () => false);
      if (error !== null) {
        this.log(() => this.deps.log.error('UI_VIZ_NO_BOARD', error));
        return null;
      }
      events = run.events;
      cards = run.cards;
    }
    const scene = sceneAtEnd(c.carry.scene, events, w.layout, from - 1);
    return {
      roomId: this.spec.id, from, to, scene,
      events: events.slice(firstAbove(events, from - 1, eventHeight)),
      cards: cards.slice(firstAbove(cards, from - 1, cardHeight)).map((k) => this.model(w, k)),
      layout: null,
    };
  }

  // ---- local status, badges, freezing ----------------------------------------------------------------------------------

  /** status.json on mtime change (12 §3.3.6) and the overlay; the overlay when it differs from the last one, else null. Demo rooms
   *  read nothing and have none. */
  private async refreshLocal(): Promise<Overlay | null> {
    const gitDir = this.spec.gitDir;
    if (gitDir === null) return null;
    try {
      this.status = await readStatus(gitDir, this.status, this.deps);
    } catch (e) {
      this.log(() => this.deps.log.error('UI_VIZ_STATUS_UNREADABLE', e));    // EIO and the like: the previous read stays
    }
    let o = overlayOf(this.status ?? NOT_READ, this.deps.machineMonoMs(), this.deps.viewerVersion, youOf(this.peerFile, this.status));
    // R-V43, VIZ-13 (8a final review): a state outside the closed set (a newer daemon, a hand edit) keeps the last light of the set;
    // the projection serves '?' only before any valid state.
    const kept = this.overlay?.state;
    if (!STATUS_STATES.has(o.state) && kept !== undefined && STATUS_STATES.has(kept)) o = { ...o, state: kept };
    if (o.versionSkew) this.badges.add('UI_VIZ_VERSION_SKEW');
    else this.badges.delete('UI_VIZ_VERSION_SKEW');
    const key = JSON.stringify(o);
    if (key === this.overlayKey) return null;
    this.overlay = o;
    this.overlayKey = key;
    return o;
  }

  /** The source's change trigger (no git while the stat pairs are unchanged); a failure counts as a change. */
  private async changed(): Promise<boolean> {
    try {
      return await this.source.changed();
    } catch {
      return true;
    }
  }

  /** 12 §6: the gitdir moved or was deleted — the room greys out and keeps its history (no git call follows). */
  private async gitDirGone(): Promise<boolean> {
    const gitDir = this.spec.gitDir;
    if (gitDir === null) return false;
    try {
      return (await this.deps.fs.lstat(gitDir)) === null;
    } catch {
      return false;
    }
  }

  /** VIZ-14: stop folding at the last folded scene. */
  private freeze(): void {
    if (!this.frozen) this.log(() => this.deps.log.write('UI_VIZ_INCIDENT_FROZEN'));
    this.frozen = true;
    this.freezeHeartbeat = this.status?.fields?.heartbeat_mono_ms ?? Number.NEGATIVE_INFINITY;
    this.pending = null;
    this.retryBuild = false;
    this.badges.add('UI_VIZ_INCIDENT_FROZEN');
  }

  /** VIZ-14: the room's daemon reports another state than incident, with a heartbeat newer than the one at the freeze that is fresh
   *  by 12 §3.3.6 (the overlay is not down). */
  private thawed(): boolean {
    const f = this.status?.fields ?? null;
    return f !== null && f.state !== 'incident' && f.heartbeat_mono_ms > this.freezeHeartbeat && this.overlay !== null && !this.overlay.down;
  }

  /** R-V19, 12 §6: a missing board or live object, a vanished ref, a git failure — the last scene stays; retried next tick. */
  private noBoard(e: unknown): void {
    this.badges.add('UI_VIZ_NO_BOARD');
    this.log(() => this.deps.log.error('UI_VIZ_NO_BOARD', e));
  }

  /** R-V46: the fold's self — the peer file, else status.json's peer_id, else zeros (the timeline does not depend on it). */
  private self(): string {
    return youOf(this.peerFile, this.status) ?? ZERO_PEER;
  }

  private badgeList(): RoomBadge[] {
    return BADGE_ORDER.filter((b) => this.badges.has(b));
  }

  private header(): string {
    return JSON.stringify([this.badgeList(), this.gone, this.win?.unknown ?? 0]);
  }

  private model(w: RoomWindow, card: Card): CardModel {
    return { card, foldedAt: w.anchors.get(card.at.height) ?? null };
  }

  private lastCards(w: RoomWindow): CardModel[] {
    return w.cards.slice(-LAST_CARDS).map((c) => this.model(w, c));
  }

  /** Logging never breaks a tick. */
  private log(fn: () => void): void {
    try {
      fn();
    } catch {
      // a log line the log refuses is dropped
    }
  }
}

/** The oldest kept point at or above h1 − RETAIN_HEIGHTS: events and cards above it stay in memory (at most 2,048 heights). */
function retainedFrom(w: RoomWindow): number {
  const floor = w.h1 - RETAIN_HEIGHTS;
  for (const p of w.points) if (p.h >= floor) return p.h;
  return floor;
}

/** Drops the events and cards at or below the retained floor (VIZ-41). */
function retain(w: RoomWindow): void {
  const lo = retainedFrom(w);
  if (lo <= w.lo) return;
  w.events = w.events.slice(firstAbove(w.events, lo, eventHeight));
  w.cards = w.cards.slice(firstAbove(w.cards, lo, cardHeight));
  w.lo = lo;
}

/** The window's first height (glossary "segment": a segment that starts at hs holds the heights hs + 1 up to the next segment's hs,
 *  the genesis segment from height 0): h0 + 1, or 0 when h0 = 0. Height h0 > 0 itself belongs to the segment below. */
function firstHeight(h0: number): number {
  return h0 === 0 ? 0 : h0 + 1;
}

/** The kept point a page from `from` starts from: the greatest point at or below from − 1 (the window's start point for its first
 *  height). */
function pointFor(w: RoomWindow, from: number): Point {
  let c = w.points[0]!;
  for (const p of w.points) if (p.h <= from - 1) c = p;
  return c;
}
