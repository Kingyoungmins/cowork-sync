// Following a teammate (12 §3.8.1, rev 2.5, F32; owner decision D3; X-93): the follow camera, its pan or jump, the now card, and
// the page-memory set of who each room follows. Pure and DOM-free (R-V33); imports model/** only (Scene, comparePos, Layout,
// deskName, phOf, Tile, ActorRef), so it is in the R-V35 client program by its directory. Ids are the page's handles, opaque strings
// (VIZ-26): they are compared for equality, and pets are ordered by ascending seat handle, the view model's array order. Nothing
// here is sent, stored, logged or mirrored into the fragment (FEAT-F32-01).
import type { ActorRef, DeskRef, PeerRef, Position, SceneEvent, SeatRef } from '../model/events.js';
import { deskName, phOf } from '../model/labels.js';
import { TILE_PX, type Layout, type Tile } from '../model/layout.js';
import { comparePos, type ActorState, type Place, type Scene } from '../model/scene.js';

export const FOLLOW_PAN_MS = 300;                  // one live beat
export const NOW_ROWS_MAX = 3;                     // holding, asks and asked-by rows each, then UI_VIZ_MORE

/** shouldPoof's speed threshold (ui/path.ts, 12 §3.5.4): at 4× and faster the camera jumps (ui/** keeps follow.ts on model/** only). */
const JUMP_SPEED = 4;
const JUMP_CAUSES: ReadonlySet<string> = new Set(['seek', 'snapshot', 'earlier', 'room']);
/** 12 §3.8.1 step 1: the frame is the bounding box of the followed actors' tiles plus this margin, in tiles, on each side. */
const FRAME_MARGIN = 1;
/** The causes that compare with no previous scene (follow start, a chip click, a room switch): they evaluate the camera at once and
 *  end an honoured user scroll (FEAT-F32-04). */
const FRESH_CAUSES: ReadonlySet<string> = new Set(['start', 'chip', 'room']);
/** The causes a reader's own action makes (follow start, a chip click, a seek, "load earlier", a room switch): they still move the
 *  camera while the page is paused, by a jump. A beat and a room_snapshot are the scene's own motion, which the pause stops (12 §3.8.1
 *  "Pause control: no beats, so no pan"; WCAG 2.2.2). */
const USER_CAUSES: ReadonlySet<string> = new Set(['start', 'chip', 'seek', 'earlier', 'room']);

/** The live pets of `peer`, in ascending seat handle (a live page appends pets in event order; a served scene lists them sorted). */
function livePetsOf(s: Scene, peer: PeerRef): SeatRef[] {
  const out: SeatRef[] = [];
  for (const [seat, p] of s.pets) if (p.live && p.owner === peer) out.push(seat);
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The peer's character (when in s.characters) and every pet of s.pets whose owner is `peer` and whose `live` is true. */
export function followedActors(s: Scene, peer: PeerRef): ActorRef[] {
  const out: ActorRef[] = s.characters.has(peer) ? [{ peer }] : [];
  for (const seat of livePetsOf(s, peer)) out.push({ seat });
  return out;
}

/** The place of a character, or of a live pet; undefined when the scene has neither. */
function placeIn(s: Scene, a: ActorRef): Place | undefined {
  if ('peer' in a) return s.characters.get(a.peer)?.place;
  const p = s.pets.get(a.seat);
  return p !== undefined && p.live ? p.place : undefined;
}
const sameActor = (a: ActorRef, b: ActorRef): boolean => ('peer' in a ? 'peer' in b && a.peer === b.peer : 'seat' in b && a.seat === b.seat);
/** Structural equality of two places (a `facing` place carries an actor). */
function samePlace(a: Place, b: Place): boolean {
  switch (a.at) {
    case 'home': return b.at === 'home' && a.spot === b.spot;
    case 'behind': return b.at === 'behind' && a.peer === b.peer;
    case 'visitor': return b.at === 'visitor' && a.desk === b.desk && a.tile === b.tile;
    case 'facing': return b.at === 'facing' && a.desk === b.desk && sameActor(a.actor, b.actor);
    default: return b.at === a.at && (b.at === 'chair' || b.at === 'stool' || b.at === 'beside') && a.desk === b.desk;
  }
}
/** The followed actors of s whose place differs from prev's (a followed actor that prev lacks has moved), in followedActors order. */
function movedActors(prev: Scene, s: Scene, peer: PeerRef): ActorRef[] {
  return followedActors(s, peer).filter((a) => {
    const before = placeIn(prev, a);
    return before === undefined || !samePlace(before, placeIn(s, a)!);
  });
}

/** The followed actor whose place differs from prev's: the character first, then pets in ascending seat handle; when none moved, the
 *  character, else the first pet; null when nothing is followed at s. */
export function focusActor(prev: Scene | null, s: Scene, peer: PeerRef): ActorRef | null {
  const followed = followedActors(s, peer);
  if (followed.length === 0) return null;
  if (prev !== null) {
    const moved = movedActors(prev, s, peer);
    if (moved.length > 0) return moved[0]!;
  }
  return followed[0]!;
}

/** The camera's frame on one axis (12 §3.8.1 step 1; a Task 19 addition): the bounding box of `tiles` plus a FRAME_MARGIN (1-tile)
 *  margin, clamped to the office — rows [start, end), a tile at y covering [y, y + 1); null with no tile. */
export function cameraFrame(tiles: readonly Tile[], officeH: number): { start: number; end: number } | null {
  if (tiles.length === 0) return null;
  let lo = Number.POSITIVE_INFINITY, hi = Number.NEGATIVE_INFINITY;
  for (const t of tiles) {
    lo = Math.min(lo, t.y);
    hi = Math.max(hi, t.y);
  }
  return { start: Math.max(0, lo - FRAME_MARGIN), end: Math.min(officeH, hi + 1 + FRAME_MARGIN) };
}

/**
 * 12 §3.8.1 camera steps on one axis, in tiles (fractions allowed): the frame = the bounding box of `tiles` plus 1 tile, clamped to the
 * office ([0, officeH)); inside the view → null (step 1, skipped when `force`, a chip click); it fits → the view start that centres it,
 * clamped to [0, officeH − view.h] (step 2); else the start that centres `focus` (the first tile when there is no focus), clamped
 * (step 3). null = nothing scrolls (X-93), also with no tile. The vertical axis always; the horizontal axis, only when the office is
 * wider than the panel, through the same function with each tile's x as y and the widths as heights. The client passes placeTile's
 * tiles (render/raster.ts; ui/** imports nothing from render/**) or the zone table's tile in the coarse view.
 */
export function cameraTarget(tiles: readonly Tile[], focus: Tile | null, view: { top: number; h: number }, officeH: number, force: boolean): number | null {
  const frame = cameraFrame(tiles, officeH);
  if (frame === null) return null;
  const { start, end } = frame;
  if (!force && start >= view.top && end <= view.top + view.h) return null;
  const clamp = (top: number): number => Math.min(Math.max(0, officeH - view.h), Math.max(0, top));
  if (end - start <= view.h) return clamp((start + end) / 2 - view.h / 2);
  const f = focus ?? tiles[0]!;
  return clamp(f.y + 0.5 - view.h / 2);
}

/** The office panel as the follow camera sees it, in CSS px: its scroll offsets and its visible size. */
export interface FollowView { top: number; left: number; w: number; h: number; }
/** One camera move, in CSS px: a jump (ms 0) or a smooth scroll over `ms` (FOLLOW_PAN_MS) to (top, left). */
export interface FollowMove { top: number; left: number; motion: 'pan' | 'jump'; ms: number; }
/** One camera evaluation (12 §3.8.1, "The camera is evaluated on …"): what the office knows when it asks. */
export interface FollowStepInput {
  cause: FollowCause;
  /** The peer the room on screen follows, or null (then nothing scrolls; the scene is remembered as framed). */
  peer: PeerRef | null;
  /** The scene on screen (live: the beat's last position, the destination of its walks; replay: the rewind position), or null. */
  s: Scene | null;
  /** The tile the office draws an actor of `s` at (render/raster.ts placeTile, or the zone table's in the coarse view; ui/** imports
   *  nothing from render/**, so the office passes it). */
  tileOf(a: ActorRef): Tile;
  /** The office in tiles (model/layout.ts officeTiles). */
  office: { w: number; h: number };
  /** The office zoom Z, read only (FEAT-F32-03: follow never changes Z or the coarse view). */
  zoom: { readonly z: number };
  /** Device px per CSS px. */
  dpr: number;
  view: FollowView;
  /** The page's pause toggle (WCAG 2.2.2), the effective reduced motion (MotionPreference) and the replay speed (1 live). */
  paused: boolean; reduced: boolean; speed: number;
}

/** FEAT-F32-04: after userScrolled(), due() is false until a beat in which a followed actor's place changes (then true once, and the
 *  camera follows every beat again); scrolls the camera itself makes never call userScrolled(). prev null (follow start, a chip click,
 *  a room switch: no previous scene to compare) is always due and ends the honoured user scroll. */
export class FollowCamera {
  #held = false;
  #framed: Scene | null = null;                    // the scene the camera last evaluated (null after a room switch)
  userScrolled(): void {
    this.#held = true;
  }
  due(prev: Scene | null, s: Scene, peer: PeerRef): boolean {
    if (prev !== null && this.#held && movedActors(prev, s, peer).length === 0) return false;
    this.#held = false;
    return true;
  }
  /** Another room is on screen: nothing of it was framed yet. */
  reset(): void {
    this.#framed = null;
  }
  /**
   * The camera step of one evaluation (a Task 19 addition, pure so T-VIZ-follow-motion drives what the office runs; client/office.ts
   * only carries the move out): no follow or no scene → nothing (the scene is remembered as framed); paused → a beat or a room_snapshot
   * moves nothing and is not taken as framed (the next beat compares with what was framed before the pause), while follow start, a chip
   * click, a seek, "load earlier" and a room switch still move it, by a jump; a fresh cause (start, chip, room) compares with no previous
   * scene, any other with the framed one; due() decides whether an honoured user scroll holds the camera; then cameraTarget on the
   * vertical axis always and on the horizontal one when the office is wider than the panel (each tile's x as y, the widths as heights),
   * over the followed actors' tiles and the focus actor's (focusActor), with force for a chip click; followMotion picks the pan
   * (FOLLOW_PAN_MS) or the jump. null: nothing scrolls.
   */
  step(o: FollowStepInput): FollowMove | null {
    if (o.peer === null || o.s === null) {
      this.#framed = o.s;
      return null;
    }
    if (o.paused && !USER_CAUSES.has(o.cause)) return null;
    const s = o.s, peer = o.peer;
    const prev = FRESH_CAUSES.has(o.cause) ? null : this.#framed;
    this.#framed = s;
    if (!this.due(prev, s, peer)) return null;
    const tiles = followedActors(s, peer).map((a) => o.tileOf(a));
    const f = focusActor(prev, s, peer);
    const focus = f === null ? null : o.tileOf(f);
    const tilePx = (TILE_PX * o.zoom.z) / o.dpr;     // CSS px per tile at Z
    const force = o.cause === 'chip';
    const top = cameraTarget(tiles, focus, { top: o.view.top / tilePx, h: o.view.h / tilePx }, o.office.h, force);
    const swap = (t: Tile): Tile => ({ x: t.y, y: t.x });
    const wide = o.office.w * tilePx > o.view.w;
    const left = wide ? cameraTarget(tiles.map(swap), focus === null ? null : swap(focus), { top: o.view.left / tilePx, h: o.view.w / tilePx }, o.office.w, force) : null;
    if (top === null && left === null) return null;
    const motion = o.paused ? 'jump' : followMotion({ reducedMotion: o.reduced, speed: o.speed, cause: o.cause });
    return { top: top === null ? o.view.top : top * tilePx, left: left === null ? o.view.left : left * tilePx, motion, ms: motion === 'pan' ? FOLLOW_PAN_MS : 0 };
  }
}

/** 12 §3.5.3, §3.8.1 (a Task 19 addition, pure so T-VIZ-follow-camera tests the page's choice): what scrolls the office after a live
 *  beat of the selected room — in a room with a follow, the follow camera, whoever's event the beat carries (it replaces the 30 s rule
 *  there; another actor's event never scrolls the panel); else the 30 s rule (ui/zoom.ts FollowRule) toward the desk of the beat's
 *  first publish; null: nothing. */
export function beatScroll(followed: PeerRef | null, events: readonly SceneEvent[]): { by: 'camera' } | { by: 'rule'; desk: DeskRef } | null {
  if (followed !== null) return { by: 'camera' };
  for (const e of events) if (e.kind === 'publish') return { by: 'rule', desk: e.target };
  return null;
}

/** What makes the camera move (12 §3.8.1): follow start, a beat, a chip click, a seek, a room_snapshot, "load earlier", a room switch. */
export type FollowCause = 'start' | 'beat' | 'chip' | 'seek' | 'snapshot' | 'earlier' | 'room';

/** FEAT-F32-05 (a Task 19 addition to 12 §3.13's list, pure so T-VIZ-follow-motion runs under Node): 'jump' under effective reduced
 *  motion, at speed ≥ 4 (shouldPoof's speed threshold) and for a seek, a room_snapshot, "load earlier" or a room switch; else 'pan'
 *  over FOLLOW_PAN_MS. */
export function followMotion(o: { reducedMotion: boolean; speed: number; cause: FollowCause }): 'pan' | 'jump' {
  return o.reducedMotion || o.speed >= JUMP_SPEED || JUMP_CAUSES.has(o.cause) ? 'jump' : 'pan';
}

/** X-93's controller default (the 8a owner may refine it): ≤ NOW_ROWS_MAX entries per row list. `target` is the other side's peer handle
 *  (a pet's owner), whose name tag the client renders from the character table; `id` is the request's display id; lastShared.path is
 *  null at the big table (UI_VIZ_NOW_LAST_SHARED_TABLE). `more` is a Task 19 refinement for the UI_VIZ_MORE "+n" (the uncapped count
 *  minus the rows shown; 0 when none), ratified 2026-10-08 (reconcile §7 V-19). */
export interface NowCard {
  peer: PeerRef; here: boolean;                    // here: s.characters has peer (else the UI_VIZ_NOW_NOT_HERE row)
  holding: ReadonlyArray<{ path: string; label: string | null }>;
  asks: ReadonlyArray<{ target: string; id: string }>;
  askedBy: ReadonlyArray<{ target: string; id: string }>;
  lastShared: { path: string | null; height: number } | null;
  more: { holding: number; asks: number; askedBy: number };   // Task 19 refinement (above; ratified, V-19)
}

/** The peer an actor stands for: a character's own, a pet's owner; a seat the scene has no pet for stays its own opaque id. */
function personOf(s: Scene, a: ActorRef): string {
  return 'peer' in a ? a.peer : s.pets.get(a.seat)?.owner ?? a.seat;
}
/** The actor is the peer's character or one of its pets (live or ended). */
function isOf(s: Scene, a: ActorRef, peer: PeerRef): boolean {
  return 'peer' in a ? a.peer === peer : s.pets.get(a.seat)?.owner === peer;
}
const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** The first NOW_ROWS_MAX entries and how many more there are. */
function capRows<T>(rows: T[]): { shown: T[]; more: number } {
  return { shown: rows.slice(0, NOW_ROWS_MAX), more: Math.max(0, rows.length - NOW_ROWS_MAX) };
}

/**
 * The 12 §3.8.1 now-card table over the drawn scene and the layout only (FEAT-F32-06, -07): holding = s.claims with stale false whose
 * seat is a pet of `peer`, by desk ordinal then order (then claim-op position), label by the chair-tag rules of 12 §3.5.4 (the claim's
 * simple name, or its qualname when another claim on the desk shares that simple name; validLabel was applied when it was served);
 * asks / askedBy = s.requests whose from / holder is the peer's character or one of its pets, ascending display id; lastShared = among
 * the character and every pet of `peer` (live or ended) the ActorState with the greatest lastPublish (comparePos), its lastDesk by desk
 * kind (deskName) and lastPublish.height. Never a time, an age, an overlay value, a note's text or an aggregate over time. The header's
 * PH label is phOf(c, c.absent ? 'absent' : 'active', s.at) (model/labels.ts), which the client computes from the same scene.
 */
export function nowCard(s: Scene, layout: Layout, peer: PeerRef): NowCard {
  const held = [...s.claims].filter(([, c]) => !c.stale && s.pets.get(c.seat)?.owner === peer)
    .sort(([ia, a], [ib, b]) => a.desk - b.desk || a.order - b.order || comparePos(a.at, b.at) || byString(ia, ib));
  const holding = capRows(held.map(([id, c]) => {
    const own = c.label;
    const shared = own !== null && [...s.claims].some(([o, x]) => o !== id && x.desk === c.desk && x.label !== null && x.label.simple === own.simple);
    return { path: deskName(layout, c.desk) ?? '?', label: own === null ? null : shared ? own.qualname : own.simple };
  }));
  const requests = [...s.requests].sort(([a], [b]) => byString(a, b));
  const asks = capRows(requests.filter(([, r]) => isOf(s, r.from, peer)).map(([id, r]) => ({ target: personOf(s, r.holder), id })));
  const askedBy = capRows(requests.filter(([, r]) => isOf(s, r.holder, peer)).map(([id, r]) => ({ target: personOf(s, r.from), id })));
  const own: Array<ActorState | undefined> = [s.characters.get(peer), ...[...s.pets.values()].filter((p) => p.owner === peer)];
  let last: { at: Position; desk: DeskRef } | null = null;
  for (const st of own) {
    if (st === undefined || st.lastPublish === null || st.lastDesk === null) continue;
    if (last === null || comparePos(st.lastPublish, last.at) > 0) last = { at: st.lastPublish, desk: st.lastDesk };
  }
  return {
    peer, here: s.characters.has(peer),
    holding: holding.shown, asks: asks.shown, askedBy: askedBy.shown,
    lastShared: last === null ? null : { path: deskName(layout, last.desk), height: last.at.height },
    more: { holding: holding.more, asks: asks.more, askedBy: askedBy.more },
  };
}

/** The screen-reader label of an open request's status icon (12 §3.8 "Bubbles"); none while its status is null. */
const STATUS_ICON: ReadonlyMap<string, string> = new Map([
  ['asked', 'UI_VIZ_ICON_ASKED'], ['queued_until_turn_end', 'UI_VIZ_ICON_QUEUED'], ['awaiting_human', 'UI_VIZ_ICON_AWAITING_HUMAN'],
  ['undeliverable', 'UI_VIZ_ICON_UNDELIVERABLE'],
]);

/** One row of the now card as the page renders it (12 §3.8.1, the table top to bottom): its template and parameters (names already the
 *  name tags), `label` — the header's PH_* label (phOf; null for a ghost, and when not here), a holding row's UI_VIZ_LABEL_UNVERIFIED
 *  (the chair-tag label is unverified, 12 §3.5.4), an asks or asked-by row's UI_VIZ_ICON_* (null while the status is null) — and `link`:
 *  a holding row's file chip (sets the file filter), an asks or asked-by row's display id (scrolls the log to its card). */
export interface NowRow {
  row: 'header' | 'holding' | 'asks' | 'asked_by' | 'more' | 'last_shared' | 'nothing' | 'not_here';
  code: string;
  params: Readonly<Record<string, string | number>>;
  label: string | null;
  link: string | null;
}

/**
 * The now card's rows (a Task 19 addition, pure so T-VIZ-follow-now and -plan2 run under Node, R-V33): the header (UI_VIZ_FOLLOWING and
 * the PH label of phOf(c, c.absent ? 'absent' : 'active', s.at), so live and replay agree); not here → only UI_VIZ_NOW_NOT_HERE;
 * else the holding rows (UI_VIZ_HOLDING), then UI_VIZ_MORE "+n" when more are held, the asks rows (UI_VIZ_NOW_ASKS) and their "+n",
 * the asked-by rows (UI_VIZ_NOW_ASKED_BY) and their "+n", the last-shared row (UI_VIZ_NOW_LAST_SHARED, or _TABLE at the big table),
 * and UI_VIZ_NOW_NOTHING when none of those shows. `nameOf` gives the name tag of a peer handle (the character table).
 */
export function nowRows(card: NowCard, s: Scene, nameOf: (peer: PeerRef) => string): NowRow[] {
  const row = (r: NowRow['row'], code: string, params: Readonly<Record<string, string | number>>, label: string | null = null, link: string | null = null): NowRow =>
    ({ row: r, code, params, label, link });
  const name = nameOf(card.peer);
  const c = s.characters.get(card.peer);
  const header = row('header', 'UI_VIZ_FOLLOWING', { name }, c === undefined ? null : phOf(c, c.absent ? 'absent' : 'active', s.at));
  if (!card.here) return [header, row('not_here', 'UI_VIZ_NOW_NOT_HERE', { name })];
  const out: NowRow[] = [header];
  const more = (n: number): void => {
    if (n > 0) out.push(row('more', 'UI_VIZ_MORE', { n }));
  };
  for (const h of card.holding) out.push(row('holding', 'UI_VIZ_HOLDING', { label: h.label ?? '?' }, 'UI_VIZ_LABEL_UNVERIFIED', h.path));
  more(card.more.holding);
  const request = (r: 'asks' | 'asked_by', code: string, x: { target: string; id: string }): NowRow =>
    row(r, code, { target: nameOf(x.target), id: x.id }, STATUS_ICON.get(s.requests.get(x.id)?.status ?? '') ?? null, x.id);
  for (const x of card.asks) out.push(request('asks', 'UI_VIZ_NOW_ASKS', x));
  more(card.more.asks);
  for (const x of card.askedBy) out.push(request('asked_by', 'UI_VIZ_NOW_ASKED_BY', x));
  more(card.more.askedBy);
  const last = card.lastShared;
  if (last !== null) {
    out.push(last.path === null ? row('last_shared', 'UI_VIZ_NOW_LAST_SHARED_TABLE', { height: last.height })
      : row('last_shared', 'UI_VIZ_NOW_LAST_SHARED', { path: last.path, height: last.height }));
  }
  if (out.length === 1) out.push(row('nothing', 'UI_VIZ_NOW_NOTHING', {}));
  return out;
}

/** FEAT-F32-11 (SHOULD; a Task 19 addition): a follow started (UI_VIZ_FOLLOWING) or ended (UI_VIZ_FOLLOW_ENDED) — what the page offers
 *  the announcer for the selected room, the code rendered with the peer's name tag. */
export interface FollowNotice { code: 'UI_VIZ_FOLLOWING' | 'UI_VIZ_FOLLOW_ENDED'; peer: PeerRef; }

/** FEAT-F32-01, -02 (a Task 19 addition, pure so T-VIZ-follow-filter runs under Node): the one page-memory Map<roomId, Handle>; at
 *  most one followed peer per room; never serialized (private fields: JSON.stringify sees nothing). Selecting a room ends nothing: the
 *  client reads get(room) and pins LogFilter.peer to it. Every start and end, whatever ended it, is told to `changed` (FEAT-F32-11). */
export class FollowSet {
  readonly #rooms = new Map<string, PeerRef>();
  readonly #changed: (room: string, n: FollowNotice) => void;
  constructor(changed: (room: string, n: FollowNotice) => void = () => undefined) {
    this.#changed = changed;
  }
  get(room: string): PeerRef | null {
    return this.#rooms.get(room) ?? null;
  }
  /** The toggle or F: none → follow filterPeer (null: nothing); on → off. The followed peer after the toggle. */
  toggle(room: string, filterPeer: PeerRef | null): PeerRef | null {
    if (this.#rooms.has(room)) this.#end(room);
    else if (filterPeer !== null) {
      this.#rooms.set(room, filterPeer);
      this.#changed(room, { code: 'UI_VIZ_FOLLOWING', peer: filterPeer });
    }
    return this.get(room);
  }
  /** Another person filter, a cleared one or Esc with no export panel open → ends it; the followed peer itself again ends nothing. */
  filterChanged(room: string, peer: PeerRef | null): void {
    if (this.#rooms.has(room) && this.#rooms.get(room) !== peer) this.#end(room);
  }
  /** The reloaded world no longer lists the followed handle (R-V22) → ends it. */
  worldReloaded(room: string, characters: ReadonlySet<PeerRef>): void {
    const p = this.#rooms.get(room);
    if (p !== undefined && !characters.has(p)) this.#end(room);
  }
  #end(room: string): void {
    const p = this.#rooms.get(room);
    if (p === undefined) return;
    this.#rooms.delete(room);
    this.#changed(room, { code: 'UI_VIZ_FOLLOW_ENDED', peer: p });
  }
}
