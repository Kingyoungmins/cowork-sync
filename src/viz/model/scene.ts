// The scene of 12 §3.3.7: who stands where and what the room shows at one board position, and the reducer that moves it
// from event to event (applyEvent, SceneReducer, reduceScene; 12 §3.3.5, §3.4). Shared with the page (R-V35): imports only
// events.ts, layout.ts and placement.ts (which imports this module for types only). Every table keyed by a board-derived
// string is a Map (VIZ-37); every id is opaque (VIZ-26: the page reduces the same events over handles).
// R-V25: ActorState carries lastDesk and lastClaimOp, and lastPublish is a Position, compared with comparePos; ClaimState
// carries `at`, the position of its newest claim op, in the same way.
import { actorKey, type ActorRef, type DeskRef, type PeerRef, type Position, type SceneEvent, type SeatRef } from './events.js';
import type { Layout } from './layout.js';
import { comparePos, homeSpot, settlePlaces, type PlaceHint } from './placement.js';

export type Place =
  | { at: 'home'; spot: number }                       // 0–15; ≥ 16 = the door cluster (§3.5.2)
  | { at: 'chair' | 'stool' | 'beside'; desk: DeskRef }   // beside = supervising (§3.5.4 character rule 3)
  | { at: 'visitor'; desk: DeskRef; tile: number }     // 0–3; ≥ 4 = counted in the desk's "+n"
  | { at: 'facing'; actor: ActorRef; desk: DeskRef }   // an open request: standing at the holder's chair
  | { at: 'behind'; peer: PeerRef };                   // a pet one tile behind its character
export interface ActorState {
  place: Place; pose: 'idle' | 'sit' | 'relaxed';
  lastPublish: Position | null;                  // R-V25: the position of the actor's newest publish (spec: a height); compared with comparePos
  lastDesk: DeskRef | null;                      // R-V25: the target desk of the actor's newest publish (target-desk tie-break, chair recency)
  lastClaimOp: Position | null;                  // R-V25: the position of the newest claim op of a pet (character precedence 2); null for characters
}
/** frozen: the folded reason code (the projection maps an out-of-set one to '?', R-V43). */
export type CharacterState = ActorState & { ghost: boolean; absent: boolean; frozen: string | null; slowedUntil: number | null; rules: boolean; credit: boolean };
/** owner: from pet_spawn (R-V47). */
export type PetState = ActorState & { owner: PeerRef; variant: number; live: boolean; ssCode: string | null };
/** claims: the desk's claim ids ordered by ranges[0][0] (ClaimState.order), ties by `at` (12 §3.5.4 chair tags). */
export interface DeskState { lastEvent: number | null; chair: ActorRef | null; visitors: ActorRef[]; more: number; claims: string[] }
/** at (Task 5 fix round 1, pending ratification; R-V25 style): the position of the claim's newest claim_take or claim_move, which
 *  tells the newest HELD claim of a desk (its chair) and of a pet (its chair, precedence 2) — 12 §3.5.4. */
export interface ClaimState { seat: SeatRef; desk: DeskRef; order: number; label: { simple: string; qualname: string } | null;
                              granularity: 'symbol' | 'block' | 'file'; lines: [number, number] | null; stale: boolean;
                              reservedFor: string | null; grantee: ActorRef | null; otherRules: boolean; at: Position }
export interface Scene {
  at: Position;
  badge: 'none' | 'near_full' | 'full';
  branchMovedAt: number | null;                  // height of the last room_sign; the sign shows while at.height − branchMovedAt < 64
  characters: Map<PeerRef, CharacterState>;
  pets: Map<SeatRef, PetState>;
  desks: Map<DeskRef, DeskState>;                // sparse (no entry = all defaults)
  claims: Map<string, ClaimState>;
  requests: Map<string, { from: ActorRef; holder: ActorRef; desk: DeskRef; status: string | null }>;   // open requests by display id
  boxes: Map<string, { owner: ActorRef; desk: DeskRef; holdKind: string; residence: string; state: string; localOnly: boolean }>;   // non-terminal records
  bangs: Map<string, { on: ActorRef; desk: DeskRef | null }>;   // persistent "!" of non-terminal conflict records, by hold id
  beat: SceneEvent[];                            // the events of at.height up to at: bubbles, sparkles, planes, one-beat "!"
}
/** Declared structurally (not Pick<Timeline, …>): scene.ts is in the client program and may not reach timeline.ts, which type-imports FoldState. */
export interface TimelineView { segments: Array<{ hs: number; start: Scene }>; events: SceneEvent[]; layout: Layout; }

export const SIGN_HEIGHTS = 64;
export const RELAX_HEIGHTS = 64;
export const DIM_HEIGHTS = 256;

/** Lexicographic (height, sub, k). Defined in placement.ts so that placement.ts needs scene.ts for types only (no runtime
 *  import cycle); this module's export of it is the contract's. */
export { comparePos };

/** A scene at `at` with nothing in it: no actor, no desk entry, no claim, request, box or "!", no badge, an empty beat. */
export function emptyScene(at: Position): Scene {
  return {
    at: { height: at.height, sub: at.sub, k: at.k },
    badge: 'none',
    branchMovedAt: null,
    characters: new Map(),
    pets: new Map(),
    desks: new Map(),
    claims: new Map(),
    requests: new Map(),
    boxes: new Map(),
    bangs: new Map(),
    beat: [],
  };
}

/** A deep copy (Maps, arrays and every nested record): two scenes never share a mutable part. */
function cloneScene(s: Scene): Scene {
  return structuredClone(s);
}
const posOf = (p: Position): Position => ({ height: p.height, sub: p.sub, k: p.k });
const copyActor = (a: ActorRef): ActorRef => ('peer' in a ? { peer: a.peer } : { seat: a.seat });

function deskEntry(s: Scene, d: DeskRef): DeskState {
  let ds = s.desks.get(d);
  if (ds === undefined) {
    ds = { lastEvent: null, chair: null, visitors: [], more: 0, claims: [] };
    s.desks.set(d, ds);
  }
  return ds;
}
/** The event names desk d: the height of the desk's last event (sparkles, planes, confetti, parcels, chairs, requests). */
function touch(s: Scene, d: DeskRef | null, h: number): void {
  if (d !== null) deskEntry(s, d).lastEvent = h;
}
function dropClaim(s: Scene, id: string, d: DeskRef): void {
  const ds = s.desks.get(d);
  if (ds !== undefined) ds.claims = ds.claims.filter((x) => x !== id);
}
/** Inserts a claim into its desk's list, kept in ranges[0][0] order (ClaimState.order), then by `at` (never by id). */
function listClaim(s: Scene, id: string, c: ClaimState): void {
  const ds = deskEntry(s, c.desk);
  const before = (x: string): boolean => {
    const o = s.claims.get(x);
    return o !== undefined && (o.order < c.order || (o.order === c.order && comparePos(o.at, c.at) < 0));
  };
  let i = 0;
  while (i < ds.claims.length && before(ds.claims[i]!)) i++;
  ds.claims.splice(i, 0, id);
}
/** A character, or a live pet. */
function actorState(s: Scene, a: ActorRef): CharacterState | PetState | undefined {
  if ('peer' in a) return s.characters.get(a.peer);
  const p = s.pets.get(a.seat);
  return p !== undefined && p.live ? p : undefined;
}
function character(s: Scene, peer: PeerRef, f: (c: CharacterState) => void): void {
  const c = s.characters.get(peer);
  if (c !== undefined) f(c);
}

/**
 * One event applied in place (the 12 §3.4 Visual column): the event joins the beat (a new height starts a new beat), the
 * facts it changes are recorded, and settlePlaces moves the actors (§3.5.4). Total: an event naming an actor, claim or
 * request the scene lacks changes nothing else. Nothing here ends by a timer: slowedUntil, the branch sign and dimmed
 * desks are read relative to the scene's position.
 */
function step(s: Scene, e: SceneEvent, layout: Layout): void {
  if (e.height !== s.at.height) s.beat = [];
  s.beat.push(structuredClone(e));
  s.at = posOf(e);
  let hint: PlaceHint | null = null;            // request_open and grant_start: where the event sends its actor
  let reset: string | null = null;
  switch (e.kind) {
    case 'room_open':
    case 'person_bang':                          // a one-beat "!" (§3.7): the beat holds it
    case 'note':
    case 'pose_relaxed':                         // after the placement below
      break;
    case 'room_sign':
      s.branchMovedAt = e.height;
      break;
    case 'room_badge':
      s.badge = e.level;
      break;
    case 'person_enter':
    case 'person_respawn': {
      // A new peer, or a known one coming back (R-V42 same-epoch rejoin, a new epoch): it walks in and goes home.
      const c = s.characters.get(e.peer);
      if (c === undefined) {
        s.characters.set(e.peer, {
          place: { at: 'home', spot: homeSpot(layout, e.peer) }, pose: 'idle', lastPublish: null, lastDesk: null, lastClaimOp: null,
          ghost: false, absent: false, frozen: null, slowedUntil: null, rules: false, credit: false,
        });
      } else {
        Object.assign(c, { absent: false, ghost: false, lastPublish: null, lastDesk: null, lastClaimOp: null });
      }
      reset = actorKey({ peer: e.peer });
      break;
    }
    case 'person_exit':
      s.characters.delete(e.peer);
      break;
    case 'person_absent':
      character(s, e.peer, (c) => { c.absent = true; });
      break;
    case 'person_ghost':
      character(s, e.peer, (c) => { c.ghost = true; });
      break;
    case 'person_unghost':
      character(s, e.peer, (c) => { c.ghost = false; });
      break;
    case 'person_freeze':
      character(s, e.peer, (c) => { c.frozen = e.reasonCode; });
      break;
    case 'person_thaw':
      character(s, e.peer, (c) => { c.frozen = null; });
      break;
    case 'person_slowed':
      character(s, e.peer, (c) => { c.slowedUntil = e.until; });
      break;
    case 'person_badge':
      // version: a pop; health on a character: a pop; rules and credit follow `on`; health on a pet: its SS_* label until
      // that seat's next health event or its poof.
      if ('peer' in e.actor) {
        const c = s.characters.get(e.actor.peer);
        if (c !== undefined && e.badge === 'rules') c.rules = e.on;
        if (c !== undefined && e.badge === 'credit') c.credit = e.on;
      } else if (e.badge === 'health') {
        const p = s.pets.get(e.actor.seat);
        if (p !== undefined && p.live) p.ssCode = e.on ? e.code : null;
      }
      break;
    case 'pet_spawn': {
      // One pet per seat key (VIZ-21): a live pet stays as it is; a poofed one comes back with its variant; a new one takes
      // the next variant of its owner in the segment. The owner is the event's (R-V47).
      const p = s.pets.get(e.seat);
      if (p === undefined) {
        let variant = 0;
        for (const q of s.pets.values()) if (q.owner === e.owner) variant++;
        s.pets.set(e.seat, { place: { at: 'behind', peer: e.owner }, pose: 'idle', lastPublish: null, lastDesk: null, lastClaimOp: null, owner: e.owner, variant, live: true, ssCode: null });
        reset = actorKey({ seat: e.seat });
      } else if (!p.live) {
        Object.assign(p, { owner: e.owner, live: true, ssCode: null, lastPublish: null, lastDesk: null, lastClaimOp: null });
        reset = actorKey({ seat: e.seat });
      }
      break;
    }
    case 'pet_poof': {
      // Kept, not live: its variant stays taken in the segment, and the projection lists it as ended (12 §3.10.6). It is
      // placed here, once, behind its owner; placement never visits it again until it spawns again.
      const p = s.pets.get(e.seat);
      if (p !== undefined && p.live) Object.assign(p, { live: false, ssCode: null, place: { at: 'behind', peer: p.owner }, pose: 'idle' });
      break;
    }
    case 'publish': {
      const st = actorState(s, e.actor);
      if (st !== undefined) {
        st.lastPublish = posOf(e);
        st.lastDesk = e.target;
        reset = actorKey(e.actor);
      }
      touch(s, e.target, e.height);
      for (const d of e.others) touch(s, d, e.height);
      break;
    }
    case 'conflict':
      // From a hold record: a persistent "!" until that record is terminal; from an event: the beat only (§3.7).
      if (e.source === 'hold' && e.holdId !== null) s.bangs.set(e.holdId, { on: copyActor(e.on), desk: e.desk });
      touch(s, e.desk, e.height);
      break;
    case 'box':
      if (e.terminal) {
        s.boxes.delete(e.holdId);
        s.bangs.delete(e.holdId);
      } else {
        s.boxes.set(e.holdId, { owner: copyActor(e.owner), desk: e.desk, holdKind: e.holdKind, residence: e.residence, state: e.state, localOnly: e.localOnly });
      }
      touch(s, e.desk, e.height);
      break;
    case 'claim_take':
    case 'claim_move': {
      // (Re)written HELD at this position (`at`: the newest HELD claim of its desk and of its pet); a move keeps the
      // reservation and the grant, and moves the claim from one desk's list to the other's.
      const prev = s.claims.get(e.claimId);
      if (prev !== undefined) {
        dropClaim(s, e.claimId, prev.desk);
        touch(s, prev.desk, e.height);
      }
      const c: ClaimState = {
        seat: e.seat, desk: e.desk, order: e.order, label: e.label === null ? null : { simple: e.label.simple, qualname: e.label.qualname },
        granularity: e.granularity, lines: e.lines === null ? null : [e.lines[0], e.lines[1]], stale: false,
        reservedFor: prev?.reservedFor ?? null, grantee: prev === undefined || prev.grantee === null ? null : copyActor(prev.grantee), otherRules: e.otherRules,
        at: posOf(e),
      };
      s.claims.set(e.claimId, c);
      listClaim(s, e.claimId, c);
      touch(s, e.desk, e.height);
      const p = s.pets.get(e.seat);
      if (p !== undefined && p.live) p.lastClaimOp = posOf(e);
      reset = actorKey({ seat: e.seat });
      break;
    }
    case 'claim_stale': {
      const c = s.claims.get(e.claimId);
      if (c !== undefined) {
        c.stale = true;
        touch(s, c.desk, e.height);
      }
      break;
    }
    case 'claim_release': {
      const c = s.claims.get(e.claimId);
      if (c !== undefined) {
        s.claims.delete(e.claimId);
        dropClaim(s, e.claimId, c.desk);
        touch(s, c.desk, e.height);
      }
      break;
    }
    case 'claim_reserve': {
      const c = s.claims.get(e.claimId);
      if (c !== undefined) {
        c.reservedFor = e.request;
        touch(s, c.desk, e.height);
      }
      break;
    }
    case 'grant_start':
    case 'grant_end': {
      const c = s.claims.get(e.claimId);
      if (c !== undefined) {
        c.grantee = e.kind === 'grant_start' ? copyActor(e.grantee) : null;
        touch(s, c.desk, e.height);
        if (e.kind === 'grant_start') {
          hint = { actor: actorKey(e.grantee), kind: 'stool', desk: c.desk };
          reset = hint.actor;
        }
      }
      break;
    }
    case 'request_open':
      // The only event that sends an actor to another actor (VIZ-17).
      s.requests.set(e.request, { from: copyActor(e.from), holder: copyActor(e.holder), desk: e.desk, status: null });
      touch(s, e.desk, e.height);
      hint = { actor: actorKey(e.from), kind: 'face', request: e.request };
      reset = hint.actor;
      break;
    case 'request_status': {
      // returned: the requester walks back; every other status is a chip on the open request.
      const r = s.requests.get(e.request);
      if (r !== undefined && e.status === 'returned') s.requests.delete(e.request);
      else if (r !== undefined) r.status = e.status;
      break;
    }
    case 'answer':
      // An answer closes its request (decline: the requester walks back; accept, grant, release: handed over), except later.
      if (e.verb !== 'later') s.requests.delete(e.request);
      break;
    case 'save':
      for (const d of e.desks) touch(s, d, e.height);
      break;
  }
  settlePlaces(s, layout, hint, reset);
  if (e.kind === 'pose_relaxed') {
    const st = actorState(s, e.actor);
    if (st !== undefined) st.pose = 'relaxed';
  }
}

/** One event onto a copy of s (pure): moves actors by placement.ts, recomputes the touched desks' chairs and visitors, keeps persistent "!" only for
 *  non-terminal hold records, ends nothing by timer except slowedUntil and the branch sign, which are read relative to at; a new height clears beat. */
export function applyEvent(s: Scene, e: SceneEvent, layout: Layout): Scene {
  const next = cloneScene(s);
  step(next, e, layout);
  return next;
}

/** The incremental form used by the timeline builder, the stores and the page's seek cache (same results as applyEvent). */
export class SceneReducer {
  private s: Scene;
  private readonly layout: () => Layout;
  private last: Position | null;

  constructor(start: Scene, layout: () => Layout) {
    this.s = cloneScene(start);
    this.layout = layout;
    const b = start.beat.at(-1);
    this.last = b === undefined ? null : posOf(b);
  }

  /**
   * Events in position order: one at or before the last pushed (or the start scene's last beat event), or before the start,
   * throws. Atomic: the event is applied to a copy, which replaces the scene only when the whole event applied.
   */
  push(e: SceneEvent): void {
    if ((this.last !== null && comparePos(e, this.last) <= 0) || comparePos(e, this.s.at) < 0) {
      throw new RangeError(`SceneReducer.push: the event at ${e.height}.${e.sub}.${e.k} is not after ${this.s.at.height}.${this.s.at.sub}.${this.s.at.k}`);
    }
    const next = cloneScene(this.s);
    step(next, e, this.layout());
    this.s = next;
    this.last = posOf(e);
  }

  /** A deep copy. */
  scene(): Scene {
    return cloneScene(this.s);
  }
}

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

/**
 * 12 §3.3.5: the start scene of the segment with the greatest hs < at.height (the first segment when none), then that
 * segment's events ≤ at — segment i holds the events of heights (hs_i, hs_i+1], the first one also those at or below its
 * hs. The result stands at `at` (never before its start scene): a later height with no event of its own has an empty beat.
 */
export function reduceScene(t: TimelineView, at: Position): Scene {
  const segs = t.segments;
  if (segs.length === 0) return emptyScene(at);
  let i = 0;
  for (let j = 0; j < segs.length; j++) if (segs[j]!.hs < at.height) i = j;
  const upTo = i + 1 < segs.length ? segs[i + 1]!.hs : Infinity;
  const s = cloneScene(segs[i]!.start);
  for (let x = i === 0 ? 0 : firstAbove(t.events, segs[i]!.hs); x < t.events.length; x++) {
    const e = t.events[x]!;
    if (e.height > upTo || comparePos(e, at) > 0) break;
    step(s, e, t.layout);
  }
  if (comparePos(at, s.at) > 0) {
    if (at.height !== s.at.height) s.beat = [];
    s.at = posOf(at);
  }
  return s;
}

/** No event for DIM_HEIGHTS heights before s.at.height. A desk with no entry (no event since its segment's start scene) is not
 *  dimmed: a start scene carries no desk history, so nothing says how long ago the desk's last event was. */
export function deskDimmed(s: Scene, d: DeskRef): boolean {
  const last = s.desks.get(d)?.lastEvent ?? null;
  return last !== null && s.at.height - last >= DIM_HEIGHTS;
}

/** at.height − branchMovedAt < SIGN_HEIGHTS */
export function signVisible(s: Scene): boolean {
  return s.branchMovedAt !== null && s.at.height - s.branchMovedAt < SIGN_HEIGHTS;
}

/** slowedUntil !== null && at.height < slowedUntil */
export function isSlowed(c: CharacterState, at: Position): boolean {
  return c.slowedUntil !== null && at.height < c.slowedUntil;
}

