// The pure world model (12 §3.3.5; VIZ-08, VIZ-10, VIZ-11, VIZ-12, VIZ-16, VIZ-17, VIZ-18, VIZ-21): a window of frames → an
// append-only, deterministic timeline of scene events, its layout, looks and cards. Server only: it reaches Plan 2's FoldState
// and hashes with node:crypto; no I/O, clock, randomness or DOM.
//
// Per frame (§3.3.5 steps 1–3): the op events of every effective op whose type has a row in OP_SCENE_ROWS, at sub 1 + line;
// the code events of a changed live commit by its shape (CODE_SCENE_ROWS), at sub 1,001; the derived events (room level, then
// per actor in (peer_id, seat key) order: DERIVED_ACTOR_ROWS), at sub 1,002. Every emitted event is pushed at once into the
// builder's SceneReducer, so a later row of the same frame reads the scene the earlier ones left (a pet spawned by a footprint
// before its publish, the target desk's tie-break, the rules badge). Everything else counts in the frame's `unknown`.
//
// X-91: the op → scene-event mapping is one table keyed by op type, with the code and derived rows beside it; Plans 3–7 add
// their rows (and their fixtures and goldens) in their own commits without editing TimelineBuilder.
import { createHash } from 'node:crypto';
import type { WriterId } from '../../board/boardCommit.js';
import { canonicalJson, type Json } from '../../board/canonicalJson.js';
import { parseCsActor } from '../../board/csActor.js';
import { liveSet, rankedSet, type FoldState, type PeerRec } from '../../board/fold.js';
import type { EventOp, JoinOp, Op, OpType, SeatEndOp, SeatStartOp } from '../../board/ops.js';
import { validId } from '../../sec/validators.js';
import { cardFor, type Card, type SceneRow } from './cards.js';
import { SUB_CODE, SUB_DERIVED, SUB_ROOM, type ActorRef, type DeskRef, type PeerRef, type Position, type SceneEvent } from './events.js';
import type { Frame, FrameCode } from './frame.js';
import { BIG_TABLE, emptyLayout, LayoutBuilder, type Layout, type LayoutDelta } from './layout.js';
import { lookTable, type LookTable } from './looks.js';
import { targetDesk } from './placement.js';
import { reduceScene, RELAX_HEIGHTS, SceneReducer, type CharacterState, type PetState, type Scene, type TimelineView } from './scene.js';
import { BOARD_FULL, BOARD_NEAR_FULL, ownerOfSeatKey, SLOWED_HEIGHTS, startScene } from './start.js';
// The thresholds live in start.ts (which startScene reads) and are re-exported here, their contract home, so that start.ts
// needs nothing of this module at run time and this module can import startScene and ownerOfSeatKey (no import cycle).
export { BOARD_FULL, BOARD_NEAR_FULL, SLOWED_HEIGHTS } from './start.js';

/** layout: R-V21 only (the layout an incident rebuild extends; default emptyLayout()). */
export interface WindowInput { h0: number; start: FoldState; frames: Iterable<Frame>; layout?: Layout; }
/** = 12 §3.3.5's Timeline: h0, h1, segments, events, layout, looks, cards. */
export interface Timeline extends TimelineView {
  h0: number; h1: number;
  segments: Array<{ hs: number; start: Scene }>;   // ascending hs; the initial window is one segment, each earlier page prepends one
  events: SceneEvent[];                            // ordered by position (height, sub, k)
  layout: Layout;                                  // §3.5, a function of the same input
  looks: LookTable;                                // §3.6, a function of the peer ids alone
  cards: Card[];                                   // §3.8: one per carded event, never merged or edited
}
/** The builder's carry state: the reduced scene at the segment's last position and the desks published since the segment's last save. */
export interface Carry { scene: Scene; savedDesks: DeskRef[]; }
export interface FrameOutput { events: SceneEvent[]; cards: Card[]; layout: LayoutDelta | null; unknown: number; }

const HOST_THROTTLED = 'HOST_THROTTLED';
const BOARD_FULL_CODE = 'BOARD_FULL';

/** sha256(utf8(base ‖ ':' ‖ k)), its first four bytes big-endian (R-V20). base: the op id, or "<height>:<writer peer_id or '-'>:<sub>". */
export function eventSeed(base: string, k: number): number {
  return createHash('sha256').update(`${base}:${k}`, 'utf8').digest().readUInt32BE(0);
}

/** §3.5.4: <peer>/human/<n> → that peer's character, or the writer's when <peer> ≠ writer.peer (a peer publishes only its own
 *  change-sets); <seat_id>/<turn-seq> → the pet <writer.peer>/<writer.epoch>/<seat_id>; anything parseCsActor refuses → null. */
export function actorOfCs(csId: string, writer: WriterId): ActorRef | null {
  const a = parseCsActor(csId);
  if (a === null) return null;
  return a.kind === 'human' ? { peer: writer.peer } : { seat: `${writer.peer}/${writer.epoch}/${a.seat}` };
}

// ---------------------------------------------------------------------------------------------------------------------------
// The rows (X-91)

/** A scene event without its position and seed: what a row emits (the builder assigns height, sub, k and seed). */
export type SceneEventBody = SceneEvent extends infer E ? (E extends unknown ? Omit<E, 'height' | 'sub' | 'k' | 'seed'> : never) : never;
/** What a row reads of a peer's record as the earlier effective ops of the frame left it. */
export type PeerView = Pick<PeerRec, 'epoch' | 'status' | 'plugin_version'>;

/** What every row sees: the frame, the scene as reduced so far, the layout, and the means to emit at the row's position. */
export interface RowContext {
  readonly frame: Frame;
  readonly height: number;
  readonly writer: WriterId | null;
  /** The scene after every event emitted so far (read only: shared until the next emit). */
  scene(): Scene;
  /** The current layout (read only). */
  layout(): Layout;
  /** A new character's home spot (§3.6 home-spot order: each new peer at its first appearance); call before its entry event. */
  home(peer: PeerRef): void;
  /** The desk of a desk-eligible path, allocated on first touch at this height (§3.5.3). */
  desk(path: string): DeskRef;
  /** The PeerRec facts of a peer as the earlier effective ops of this frame left them (frame.before, then setRec). */
  rec(peer: PeerRef): PeerView | undefined;
  setRec(peer: PeerRef, rec: PeerView): void;
  /** Desks a publish touched; the next save's confetti covers them. */
  published(desks: readonly DeskRef[]): void;
  /** The desks published since the segment's last save (ascending), cleared. */
  takeSavedDesks(): DeskRef[];
  emit(row: SceneRow, e: SceneEventBody): void;
  /** One fact the viewer draws nothing for (12 §3.3.3 "unknown"). */
  unknown(): void;
}
/** An effective op of the frame (verdict 'effective': the writer is attributable). */
export interface OpRowContext extends RowContext { readonly line: number; readonly op: Op; readonly writer: WriterId; }
/** The derived step's view of the frame's fold transitions (Plan 2 fold helpers, never re-derived). */
export interface DerivedContext extends RowContext {
  readonly liveBefore: ReadonlySet<PeerRef>; readonly rankedBefore: ReadonlySet<PeerRef>;
  readonly liveAfter: ReadonlySet<PeerRef>; readonly rankedAfter: ReadonlySet<PeerRef>;
}
export type OpRowMapper = (c: OpRowContext) => void;
export type CodeRowMapper = (c: RowContext) => void;
export type DerivedRoomRow = (c: DerivedContext) => void;
export type DerivedActorRow = (c: DerivedContext, actor: ActorRef) => void;

/** A character, or a live pet. */
function actorState(s: Scene, a: ActorRef): CharacterState | PetState | undefined {
  if ('peer' in a) return s.characters.get(a.peer);
  const p = s.pets.get(a.seat);
  return p !== undefined && p.live ? p : undefined;
}
/** The live pets of a peer whose seat key matches, in ascending seat key (12 §3.3.5: several seats follow ascending seat key). */
function petsOf(s: Scene, peer: PeerRef, keep: (seat: string) => boolean): string[] {
  const out: string[] = [];
  for (const [seat, p] of s.pets) if (p.live && p.owner === peer && keep(seat)) out.push(seat);
  return out.sort();
}
const recOf = (s: FoldState, peer: PeerRef): PeerRec | undefined => (Object.hasOwn(s.peers, peer) ? s.peers[peer] : undefined);
/** R-V45: the rules badge holds while the peer's regionSpec differs from the team's, in the fold state after the frame. */
const rulesAfter = (c: RowContext, peer: PeerRef): boolean => {
  const r = recOf(c.frame.after, peer);
  return r !== undefined && r.regionSpec !== c.frame.after.teamRegionSpec;
};

/**
 * join (12 §3.4 join rows, R-V42, R-V45): no record before → person_enter (join_new); another epoch → person_respawn, then
 * pet_poof per retired seat (join_epoch); the same epoch left or absent → person_enter (join_back); the same epoch with
 * another plugin_version → person_badge{version}; then the rules badge when regionSpec ≠ teamRegionSpec (after the frame)
 * differs from the drawn character's, and the credit badge when coauthor_optin ≠ false differs from it.
 */
const joinRow: OpRowMapper = (c) => {
  const op = c.op as JoinOp;
  const w = c.writer;
  const peer = w.peer;
  const prev = c.rec(peer);
  if (prev === undefined || prev.epoch !== w.epoch || prev.status !== 'active') {
    c.home(peer);
    if (prev !== undefined && prev.epoch !== w.epoch) {
      const retired = petsOf(c.scene(), peer, (seat) => !seat.startsWith(`${peer}/${w.epoch}/`));
      c.emit('join_epoch', { kind: 'person_respawn', peer });
      for (const seat of retired) c.emit('join_epoch', { kind: 'pet_poof', seat, owner: ownerOfSeatKey(seat) });
    } else {
      c.emit(prev === undefined ? 'join_new' : 'join_back', { kind: 'person_enter', peer });
    }
  }
  if (prev !== undefined && prev.epoch === w.epoch && prev.plugin_version !== op.plugin_version) {
    c.emit('join_version', { kind: 'person_badge', actor: { peer }, badge: 'version', on: true, code: null });
  }
  const ch = c.scene().characters.get(peer);
  if (ch !== undefined) {
    const rules = rulesAfter(c, peer);
    if (ch.rules !== rules) c.emit('join_rules', { kind: 'person_badge', actor: { peer }, badge: 'rules', on: rules, code: null });
    const credit = op.coauthor_optin !== false;
    if (ch.credit !== credit) c.emit('join_credit', { kind: 'person_badge', actor: { peer }, badge: 'credit', on: credit, code: null });
  }
  c.setRec(peer, { epoch: w.epoch, status: 'active', plugin_version: op.plugin_version });
};

/** leave: person_exit, then pet_poof per live pet of the peer in ascending seat key (its claims' claim_release{stop}: Plan 4). */
const leaveRow: OpRowMapper = (c) => {
  const peer = c.writer.peer;
  const seats = petsOf(c.scene(), peer, () => true);
  c.emit('leave', { kind: 'person_exit', peer });
  for (const seat of seats) c.emit('leave', { kind: 'pet_poof', seat, owner: ownerOfSeatKey(seat) });
  const prev = c.rec(peer);
  if (prev !== undefined) c.setRec(peer, { ...prev, status: 'left' });
};

const seatKey = (w: WriterId, seatId: string): string => `${w.peer}/${w.epoch}/${seatId}`;
const seatStartRow: OpRowMapper = (c) => {
  const seat = seatKey(c.writer, (c.op as SeatStartOp).seat_id);
  c.emit('seat_start', { kind: 'pet_spawn', seat, owner: ownerOfSeatKey(seat) });
};
const seatEndRow: OpRowMapper = (c) => {
  const seat = seatKey(c.writer, (c.op as SeatEndOp).seat_id);
  c.emit('seat_end', { kind: 'pet_poof', seat, owner: ownerOfSeatKey(seat) });
};

/**
 * event, by kind, on its writer: freeze → person_freeze{reason_code}; unfreeze → person_thaw; health HOST_THROTTLED →
 * person_slowed{until: height + 180}; health BOARD_FULL → room_badge{full} (when the room is not full already); any other
 * health code → person_badge{health, code}; nonretryable → person_bang{host}; breach → conflict{breach, source 'event'} on the
 * writer's character, no desk, no line (R-V44); K1..K7 → conflict{generic} with its cid; incident → nothing, unknown (R-V17).
 */
const eventRow: OpRowMapper = (c) => {
  const op = c.op as EventOp;
  const peer = c.writer.peer;
  switch (op.kind) {
    case 'freeze':
      c.emit('freeze', { kind: 'person_freeze', peer, reasonCode: op.reason_code });
      return;
    case 'unfreeze':
      c.emit('unfreeze', { kind: 'person_thaw', peer });
      return;
    case 'health':
      if (op.reason_code === HOST_THROTTLED) c.emit('slowed', { kind: 'person_slowed', peer, until: c.height + SLOWED_HEIGHTS });
      else if (op.reason_code === BOARD_FULL_CODE) {
        if (c.scene().badge !== 'full') c.emit('board_full', { kind: 'room_badge', level: 'full' });
      } else c.emit('health_other', { kind: 'person_badge', actor: { peer }, badge: 'health', on: true, code: op.reason_code });
      return;
    case 'nonretryable':
      c.emit('nonretryable', { kind: 'person_bang', peer, bang: 'host' });
      return;
    case 'incident':
      c.unknown();
      return;
    case 'breach':
      c.emit('event_breach', { kind: 'conflict', conflict: 'breach', source: 'event', on: { peer }, desk: null, holdId: null, cid: op.cid, eventKind: 'breach', line: null });
      return;
    default:
      c.emit('event_k', { kind: 'conflict', conflict: 'generic', source: 'event', on: { peer }, desk: null, holdId: null, cid: op.cid, eventKind: op.kind, line: null });
  }
};

/** save (the save completion Ls): save{desks published since the previous save} — its only image (the base move draws nothing). */
const saveRow: OpRowMapper = (c) => {
  c.emit('save', { kind: 'save', peer: c.writer.peer, desks: c.takeSavedDesks() });
};

/**
 * 12 §3.4, the rows of the effective op types of this build, keyed by op type (X-91). caps has no image and is not unknown
 * (R-V17: B0's room_open is its event). A type with no row here — claim, release, request, request_status, answer, note,
 * presume_absent, hold in Plan 2 — draws nothing even when a later build's fold made it effective, and counts in unknown;
 * Plans 3–7 add their rows here in the commit that gives the type its fold effect.
 */
export const OP_SCENE_ROWS: ReadonlyMap<OpType, OpRowMapper> = new Map<OpType, OpRowMapper>([
  ['join', joinRow],
  ['leave', leaveRow],
  ['caps', () => {}],
  ['seat_start', seatStartRow],
  ['seat_end', seatEndRow],
  ['event', eventRow],
  ['save', saveRow],
]);

/**
 * A changed, ordinary live commit (R-V18): first a pet_spawn for each seat its trailers name (Cowork-Seat values other than
 * human, seat cs_ids) that has no live pet yet, in ascending seat key; then one publish per Cowork-CS trailer in trailer order
 * — at the target desk of its paths (§3.5.4), the paths allocated sorted on first touch (§3.5.3), or at the big table with
 * paths [] when the change-set's paths are not on the board (> 256); with no Cowork-CS trailer, one publish by the writer's
 * character at the big table. A commit without an attributable writer draws nothing and counts unknown.
 */
const ordinaryCode: CodeRowMapper = (c) => {
  const f = c.frame;
  const w = f.writer;
  if (w === null) {
    c.unknown();
    return;
  }
  const seatIds = new Set<string>();
  for (const v of f.code.seats) if (v !== 'human' && validId('hex128', v)) seatIds.add(v);
  for (const t of f.cs) {
    const a = parseCsActor(t.csId);
    if (a !== null && a.kind === 'seat') seatIds.add(a.seat);
  }
  const s = c.scene();
  const spawns = [...seatIds].map((id) => seatKey(w, id)).filter((seat) => s.pets.get(seat)?.live !== true).sort();
  for (const seat of spawns) c.emit('seat_footprint', { kind: 'pet_spawn', seat, owner: ownerOfSeatKey(seat) });
  for (const t of f.cs) {
    const actor = actorOfCs(t.csId, w);
    if (actor === null) {
      c.unknown();
      continue;
    }
    const facts = { state: t.state, checks: t.checks, origin: t.origin } as const;
    const paths = f.csPaths.get(t.csId);
    if (paths === undefined) {
      c.emit('publish_big', { kind: 'publish', actor, target: BIG_TABLE, others: [], paths: [], n: t.paths, ...facts });
      c.published([BIG_TABLE]);
      continue;
    }
    const desks = [...paths].sort().map((p) => c.desk(p));
    const { target, others } = targetDesk(desks, c.layout(), actorState(c.scene(), actor)?.lastDesk ?? null);
    c.emit('publish_cs', { kind: 'publish', actor, target, others, paths: [...paths], n: t.paths, ...facts });
    c.published([target, ...others]);
  }
  if (f.cs.length === 0) {
    c.emit('publish_nocs', { kind: 'publish', actor: { peer: w.peer }, target: BIG_TABLE, others: [], paths: [], n: 0, state: 'closed', checks: 'skipped', origin: 'human' });
    c.published([BIG_TABLE]);
  }
};

/** A changed, base-move live commit: room_sign{branch_moved}, unless the frame has an effective save (then it is the save
 *  completion Ls, and the save event of step 1 is its only image). */
const baseMoveCode: CodeRowMapper = (c) => {
  if (!c.frame.ops.some((o) => o.verdict === 'effective' && o.type === 'save')) c.emit('base_move', { kind: 'room_sign', sign: 'branch_moved' });
};

/** Step 2 by code.shape (X-91); 'genesis' above height 0 and null (malformed) draw nothing and count unknown. */
export const CODE_SCENE_ROWS: ReadonlyMap<NonNullable<FrameCode['shape']>, CodeRowMapper> = new Map<NonNullable<FrameCode['shape']>, CodeRowMapper>([
  ['ordinary', ordinaryCode],
  ['base_move', baseMoveCode],
]);

const isBoardFullEvent = (o: Frame['ops'][number]): boolean => {
  if (o.verdict !== 'effective' || o.type !== 'event' || o.op === null || typeof o.op !== 'object' || Array.isArray(o.op)) return false;
  return o.op['kind'] === 'health' && o.op['reason_code'] === BOARD_FULL_CODE;
};

/**
 * The board-full level (12 §3.4): full from record_count ≥ 5,000 or a BOARD_FULL event, until a frame with record_count
 * < 5,000; otherwise near_full at ≥ 4,000, else none. room_badge{level} when it changes (a BOARD_FULL event in step 1 already
 * made its own).
 */
const boardLevelRow: DerivedRoomRow = (c) => {
  const rc = c.frame.after.record_count;
  const level = c.scene().badge;
  const next = rc >= BOARD_FULL || (level === 'full' && c.frame.ops.some(isBoardFullEvent)) ? 'full' : rc >= BOARD_NEAR_FULL ? 'near_full' : 'none';
  if (next !== level) c.emit('board_full', { kind: 'room_badge', level: next });
};

/** Derived room-level rows, before every actor's. */
export const DERIVED_ROOM_ROWS: readonly DerivedRoomRow[] = [boardLevelRow];

/** A seat key that is live in the fold state after the frame (a folded seat_start and no seat_end or retirement since). */
const liveFoldedSeat = (c: RowContext, seat: string): boolean => Object.hasOwn(c.frame.after.seats, seat) && c.frame.after.seats[seat]!.status === 'live';
/**
 * person_ghost: in liveSet(after), in rankedSet(before), not in rankedSet(after) (the fold's own ghost rule); then (VIZ-21, §8 Q7)
 * pet_poof per live pet of that peer whose seat key is not a live folded seat — a footprint-only seat, which PRO-20 lets end
 * without seat_end — in ascending seat key. A seat live in the fold keeps its pet (seat_end, retirement or leave removes it);
 * a later footprint spawns a poofed one again (ordinaryCode).
 */
const ghostRow: DerivedActorRow = (c, a) => {
  if (!('peer' in a) || !c.liveAfter.has(a.peer) || !c.rankedBefore.has(a.peer) || c.rankedAfter.has(a.peer)) return;
  const peer = a.peer;
  c.emit('ghost', { kind: 'person_ghost', peer });
  for (const seat of petsOf(c.scene(), peer, (k) => !liveFoldedSeat(c, k))) c.emit('ghost', { kind: 'pet_poof', seat, owner: ownerOfSeatKey(seat) });
};
/** person_unghost: in rankedSet(after), in liveSet(before), not in rankedSet(before). */
const unghostRow: DerivedActorRow = (c, a) => {
  if ('peer' in a && c.rankedAfter.has(a.peer) && c.liveBefore.has(a.peer) && !c.rankedBefore.has(a.peer)) c.emit('ghost', { kind: 'person_unghost', peer: a.peer });
};
/** R-V45: a rules badge that no join of the frame set (a step-6 teamRegionSpec switch) follows the fold at sub 1,002. */
const rulesRow: DerivedActorRow = (c, a) => {
  if (!('peer' in a)) return;
  const ch = c.scene().characters.get(a.peer);
  const rules = rulesAfter(c, a.peer);
  if (ch !== undefined && ch.rules !== rules) c.emit('rules_change', { kind: 'person_badge', actor: { peer: a.peer }, badge: 'rules', on: rules, code: null });
};
/** pose_relaxed exactly RELAX_HEIGHTS heights after the actor's last publish in the segment (once per publish). */
const relaxedRow: DerivedActorRow = (c, a) => {
  const last = actorState(c.scene(), a)?.lastPublish ?? null;
  if (last !== null && last.height + RELAX_HEIGHTS === c.height) c.emit('relaxed', { kind: 'pose_relaxed', actor: 'peer' in a ? { peer: a.peer } : { seat: a.seat } });
};

/** Derived per-actor rows in their order (R-V45): ghost, unghost, rules, relaxed. */
export const DERIVED_ACTOR_ROWS: readonly DerivedActorRow[] = [ghostRow, unghostRow, rulesRow, relaxedRow];

/** The actors of a scene in (peer_id, seat key) order, each character before its pets: a seat key starts with its owner's
 *  peer_id and a '/', so plain code-unit order puts it right after its character. */
function actorsOf(s: Scene): ActorRef[] {
  const keys: Array<[string, ActorRef]> = [];
  for (const peer of s.characters.keys()) keys.push([peer, { peer }]);
  for (const [seat, p] of s.pets) if (p.live) keys.push([seat, { seat }]);
  return keys.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)).map(([, a]) => a);
}

// ---------------------------------------------------------------------------------------------------------------------------
// The builder

const posOf = (p: Position): Position => ({ height: p.height, sub: p.sub, k: p.k });

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

/** The carry of a timeline's last segment: its start scene reduced over its events to the carry position, and the desks
 *  published since its last save. Reads only the timeline's public fields. */
function carryOf(t: Timeline): Carry {
  const last = t.segments.at(-1);
  if (last === undefined) throw new RangeError('TimelineBuilder.resume: a timeline has at least one segment');
  const events = t.segments.length === 1 ? t.events : t.events.slice(firstAbove(t.events, last.hs));
  const tail = events.at(-1);
  const at = tail !== undefined && tail.height === t.h1 ? posOf(tail) : { height: t.h1, sub: 0, k: 0 };
  const scene = reduceScene({ segments: [last], events, layout: t.layout }, at);
  const saved = new Set<DeskRef>();
  for (const e of events) {
    if (e.kind === 'save') saved.clear();
    else if (e.kind === 'publish') for (const d of [e.target, ...e.others]) saved.add(d);
  }
  return { scene, savedDesks: [...saved].sort((a, b) => a - b) };
}

interface BuilderInit {
  lb: LayoutBuilder; h0: number; h1: number; segments: Array<{ hs: number; start: Scene }>; events: SceneEvent[]; cards: Card[]; carry: Carry;
}
/** What a frame's rows reach of their builder: the reduced scene, the layout and the save carry. */
interface BuilderPort {
  scene(): Scene;
  layout(): Layout;
  apply(e: SceneEvent): void;
  home(peer: PeerRef): void;
  desk(path: string, h: number): DeskRef;
  published(desks: readonly DeskRef[]): void;
  takeSavedDesks(): DeskRef[];
}

/** One frame's emission state: positions, seeds, the frame's events, cards and unknown count. */
class FrameCtx implements DerivedContext {
  readonly frame: Frame;
  readonly height: number;
  readonly writer: WriterId | null;
  readonly events: SceneEvent[] = [];
  readonly cards: Card[] = [];
  unknownCount = 0;
  liveBefore: ReadonlySet<PeerRef> = new Set();
  rankedBefore: ReadonlySet<PeerRef> = new Set();
  liveAfter: ReadonlySet<PeerRef> = new Set();
  rankedAfter: ReadonlySet<PeerRef> = new Set();
  private readonly b: BuilderPort;
  private sub = SUB_ROOM;
  private k = 0;
  private base = '';
  private readonly recs = new Map<PeerRef, PeerView>();

  constructor(b: BuilderPort, frame: Frame) {
    this.b = b;
    this.frame = frame;
    this.height = frame.height;
    this.writer = frame.writer;
  }

  /** Later emits go to sub with k from 0, seeded from base. */
  at(sub: number, base: string): void {
    this.sub = sub;
    this.k = 0;
    this.base = base;
  }

  scene(): Scene { return this.b.scene(); }
  layout(): Layout { return this.b.layout(); }
  home(peer: PeerRef): void { this.b.home(peer); }
  desk(path: string): DeskRef { return this.b.desk(path, this.height); }
  rec(peer: PeerRef): PeerView | undefined { return this.recs.has(peer) ? this.recs.get(peer) : recOf(this.frame.before, peer); }
  setRec(peer: PeerRef, rec: PeerView): void { this.recs.set(peer, { epoch: rec.epoch, status: rec.status, plugin_version: rec.plugin_version }); }
  published(desks: readonly DeskRef[]): void { this.b.published(desks); }
  takeSavedDesks(): DeskRef[] { return this.b.takeSavedDesks(); }
  unknown(): void { this.unknownCount++; }

  emit(row: SceneRow, body: SceneEventBody): void {
    const k = this.k++;
    const e = { ...body, height: this.height, sub: this.sub, k, seed: eventSeed(this.base, k) } as SceneEvent;
    this.b.apply(e);
    this.events.push(e);
    const card = cardFor(e, row);
    if (card !== null) this.cards.push(card);
  }

  /** The op-row view of one effective op line. */
  forOp(line: number, op: Op, writer: WriterId): OpRowContext {
    return {
      frame: this.frame, height: this.height, line, op, writer,
      scene: () => this.scene(), layout: () => this.layout(), home: (p) => this.home(p), desk: (p) => this.desk(p),
      rec: (p) => this.rec(p), setRec: (p, r) => this.setRec(p, r), published: (d) => this.published(d), takeSavedDesks: () => this.takeSavedDesks(),
      emit: (row, e) => this.emit(row, e), unknown: () => this.unknown(),
    };
  }
}

/**
 * The timeline builder (12 §3.3.5): one segment's frames, steps 1–3 per frame, onto a layout that only grows (VIZ-16). The
 * carry — the scene at the segment's last position (with each actor's last publish, open badges and the board-full level) and
 * the desks published since the segment's last save — is everything a later frame reads besides the frame itself, so resume
 * (from a timeline) and replay (from a kept carry) continue exactly where a builder that pushed every frame would be.
 * A push that throws (an out-of-order frame, LayoutFrozenError on a replay) leaves the builder unusable.
 */
export class TimelineBuilder {
  private readonly lb: LayoutBuilder;
  private cached: Layout | null = null;
  private reducer: SceneReducer;
  private view: Scene | null = null;
  private readonly saved: Set<DeskRef>;
  private readonly h0: number;
  private last: number;
  private readonly segments: Array<{ hs: number; start: Scene }>;
  private readonly events: SceneEvent[];
  private readonly cards: Card[];
  private readonly port: BuilderPort;

  private constructor(o: BuilderInit) {
    this.lb = o.lb;
    this.h0 = o.h0;
    this.last = o.h1;
    this.segments = o.segments;
    this.events = o.events;
    this.cards = o.cards;
    this.saved = new Set(o.carry.savedDesks);
    const layoutNow = (): Layout => (this.cached ??= this.lb.layout());
    this.reducer = new SceneReducer(o.carry.scene, layoutNow);
    this.port = {
      scene: () => (this.view ??= this.reducer.scene()),
      layout: layoutNow,
      apply: (e) => {
        this.reducer.push(e);
        this.view = null;
      },
      home: (peer) => {
        if (layoutNow().homeOrder.includes(peer)) return;
        this.lb.home(peer);
        this.cached = null;
      },
      desk: (path, h) => {
        if (!this.lb.has(path)) this.cached = null;
        return this.lb.desk(path, h);
      },
      published: (desks) => {
        for (const d of desks) this.saved.add(d);
      },
      takeSavedDesks: () => {
        const out = [...this.saved].sort((a, b) => a - b);
        this.saved.clear();
        return out;
      },
    };
  }

  /** A new segment at hs = h0 from `start`: the start peers (sorted; every PeerRec, so "load earlier" reveals none) join
   *  homeOrder, then startScene. Frames run from h0 + 1, or from 0 when h0 = 0 (start = initialFoldState). */
  static open(h0: number, start: FoldState, layout: Layout = emptyLayout()): TimelineBuilder {
    const lb = new LayoutBuilder(layout);
    for (const peer of Object.keys(start.peers).sort()) lb.home(peer);
    const scene = startScene(start, h0, lb.layout());
    return new TimelineBuilder({ lb, h0, h1: h0 === 0 ? -1 : h0, segments: [{ hs: h0, start: scene }], events: [], cards: [], carry: { scene, savedDesks: [] } });
  }

  /** Append-only continuation of t (carry recomputed from t's last segment). */
  static resume(t: Timeline): TimelineBuilder {
    return new TimelineBuilder({ lb: new LayoutBuilder(t.layout), h0: t.h0, h1: t.h1, segments: [...t.segments], events: [...t.events], cards: [...t.cards], carry: carryOf(t) });
  }

  /** Re-fold of a range the store dropped: from a kept checkpoint's carry, on a frozen copy of the head layout (a frame that
   *  needs a new desk or home spot throws LayoutFrozenError). frozen = false (Plan 8a Task 8, the room store's live head): an
   *  append-only continuation from the head carry on an unfrozen copy of the current layout — its new desks and home spots
   *  come after every existing one, so the store keeps no long-lived builder (VIZ-41) and desks "load earlier" appended stay
   *  where they are (VIZ-16). The carry is not changed. */
  static replay(carry: Carry, layout: Layout, frozen = true): TimelineBuilder {
    const lb = new LayoutBuilder(layout);
    if (frozen) lb.freeze();
    const h = carry.scene.at.height;
    return new TimelineBuilder({ lb, h0: h, h1: h, segments: [{ hs: h, start: structuredClone(carry.scene) }], events: [], cards: [], carry });
  }

  /** Steps 1–3 of §3.3.5 for one frame; f.height must be h1 + 1. */
  push(f: Frame): FrameOutput {
    if (f.height !== this.last + 1) throw new RangeError(`TimelineBuilder.push: a frame at height ${f.height} does not follow height ${this.last}`);
    const c = new FrameCtx(this.port, f);
    const h = f.height;
    const by = `${h}:${f.writer?.peer ?? '-'}:`;
    if (h === 0) {
      c.at(SUB_ROOM, `${by}${SUB_ROOM}`);
      c.emit('genesis', { kind: 'room_open' });
    }
    if (f.malformed) c.unknown();                                 // R-V19: a no-op draft stands in for an unreadable board commit
    // Step 1: op events.
    for (const o of f.ops) {
      const row = o.verdict === 'effective' && o.op !== null && f.writer !== null ? OP_SCENE_ROWS.get(o.type as OpType) : undefined;
      if (row === undefined) {
        c.unknown();
        continue;
      }
      const op = o.op as unknown as Op;
      c.at(1 + o.line, op.id);
      row(c.forOp(o.line, op, f.writer!));
    }
    // Step 2: code events (height 0's L0 makes room_open only).
    if (h > 0 && f.code.changed) {
      c.at(SUB_CODE, `${by}${SUB_CODE}`);
      const row = f.code.shape === null ? undefined : CODE_SCENE_ROWS.get(f.code.shape);
      if (row === undefined) c.unknown();
      else row(c);
    }
    // Step 3: derived events.
    c.at(SUB_DERIVED, `${by}${SUB_DERIVED}`);
    c.liveBefore = new Set(liveSet(f.before));
    c.rankedBefore = new Set(rankedSet(f.before));
    c.liveAfter = new Set(liveSet(f.after));
    c.rankedAfter = new Set(rankedSet(f.after));
    for (const row of DERIVED_ROOM_ROWS) row(c);
    for (const a of actorsOf(c.scene())) for (const row of DERIVED_ACTOR_ROWS) row(c, a);
    this.last = h;
    this.events.push(...c.events);
    this.cards.push(...c.cards);
    return { events: c.events, cards: c.cards, layout: this.lb.takeDelta(), unknown: c.unknownCount };
  }

  /** The scene at the segment's last position (the last event of h1, or (h1, 0, 0) with an empty beat when h1 has none) and
   *  the desks published since the segment's last save: copies. */
  carry(): Carry {
    const s = this.reducer.scene();
    if (s.at.height < this.last) {
      s.at = { height: this.last, sub: 0, k: 0 };
      s.beat = [];
    }
    return { scene: s, savedDesks: [...this.saved].sort((a, b) => a - b) };
  }

  h1(): number {
    return this.last;
  }

  /** A snapshot of the whole timeline (a resumed one included): new arrays and layout; events, cards and start scenes shared. */
  timeline(): Timeline {
    const layout = this.lb.layout();
    return { h0: this.h0, h1: this.last, segments: [...this.segments], events: [...this.events], layout, looks: lookTable(layout.homeOrder), cards: [...this.cards] };
  }
}

export function buildTimeline(w: WindowInput): Timeline {
  const b = TimelineBuilder.open(w.h0, w.start, w.layout);
  for (const f of w.frames) b.push(f);
  return b.timeline();
}

/** extendTimeline(buildTimeline(w[0..k]), frames k+1..n) deep-equals buildTimeline(w[0..n]) (VIZ-10). */
export function extendTimeline(t: Timeline, frames: Iterable<Frame>): Timeline {
  const b = TimelineBuilder.resume(t);
  for (const f of frames) b.push(f);
  return b.timeline();
}

/**
 * earlier.h0 = t.segments[0].hs − 256 (or 0); its frames run earlier.h0 + 1 … t.segments[0].hs (from 0 when earlier.h0 = 0).
 * Prepends one segment, built on t's layout so the paths it first touches are allocated after every existing desk (§3.5.3);
 * t's segments, events and cards follow unchanged (a later segment's scenes depend only on its own start and events).
 */
export function prependTimeline(t: Timeline, earlier: WindowInput): Timeline {
  const hs = t.segments[0]?.hs ?? t.h0;
  if (earlier.h0 >= hs) throw new RangeError(`prependTimeline: an earlier page at ${earlier.h0} does not precede the window at ${hs}`);
  const b = TimelineBuilder.open(earlier.h0, earlier.start, t.layout);
  for (const f of earlier.frames) b.push(f);
  if (b.h1() !== hs) throw new RangeError(`prependTimeline: the earlier page ends at height ${b.h1()}, not at ${hs}`);
  const e = b.timeline();
  return {
    h0: e.h0, h1: t.h1,
    segments: [...e.segments, ...t.segments],
    events: [...e.events, ...t.events],
    layout: e.layout,
    looks: lookTable(e.layout.homeOrder),
    cards: [...e.cards, ...t.cards],
  };
}

/** Map keys in ascending order: numbers numerically, strings by UTF-16 code units (RFC 8785's key order). */
function compareKeys(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const x = String(a), y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
/** A timeline value as JSON: every Map as its [key, value] pairs in ascending key order. */
function toJson(v: unknown): Json {
  if (v instanceof Map) return [...(v as Map<unknown, unknown>).entries()].sort((x, y) => compareKeys(x[0], y[0])).map(([k, x]) => [toJson(k), toJson(x)]);
  if (Array.isArray(v)) return v.map(toJson);
  if (v !== null && typeof v === 'object') {
    const o = Object.create(null) as Record<string, Json>;
    for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = toJson(x);
    return o;
  }
  return v as Json;
}

/** canonicalJson of t with every Map as ascending [key, value] pairs (UTF-16 code units; numeric keys by value), deskOf included. */
export function serializeTimeline(t: Timeline): string {
  return canonicalJson(toJson(t));
}
