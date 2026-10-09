// Placement (12 §3.5.4; VIZ-17): the target desk of a change-set, home spots, the character and pet precedence lists,
// chairs and visitor tiles. Shared with the page (R-V35): imports only events.ts, layout.ts and, for types only, scene.ts:
// scene.ts calls this module at run time, so comparePos is defined here and re-exported by scene.ts (no runtime cycle).
//
// Every id is an opaque string (12 §3.13): nothing here splits a seat id or orders by an id. Ties are broken by board
// positions (lastPublish, lastClaimOp, ClaimState.at), by desk ordinals and event heights, and by homeOrder and variants,
// all of which a renaming of peers and seats (the page's handles) leaves unchanged.
// Facing another actor is entered only by request_open (VIZ-17): the reducer passes that event's request as the hint, and
// otherwise an actor only keeps facing the open request it already faces. A poofed pet is placed once by the reducer
// (behind its owner) and never visited here again (settlePlaces skips it).
import { actorKey, type ActorRef, type DeskRef, type PeerRef, type Position, type SeatRef } from './events.js';
import { BIG_TABLE, type Layout } from './layout.js';
import type { CharacterState, DeskState, PetState, Place, Scene } from './scene.js';

/** Lexicographic (height, sub, k): negative, 0 or positive, as Array.prototype.sort expects. Exported to the rest of the
 *  code by scene.ts (the contract's home of comparePos). */
export function comparePos(a: Position, b: Position): number {
  if (a.height !== b.height) return a.height < b.height ? -1 : 1;
  if (a.sub !== b.sub) return a.sub < b.sub ? -1 : 1;
  if (a.k !== b.k) return a.k < b.k ? -1 : 1;
  return 0;
}

/** desks: the desk of each path (repeats allowed). Target: most paths; ties → lastDesk; then the lexicographically first desk key. Others ascending. */
export function targetDesk(desks: readonly DeskRef[], layout: Layout, lastDesk: DeskRef | null): { target: DeskRef; others: DeskRef[] } {
  if (desks.length === 0) return { target: BIG_TABLE, others: [] };
  const count = new Map<DeskRef, number>();
  for (const d of desks) count.set(d, (count.get(d) ?? 0) + 1);
  let max = 0;
  for (const n of count.values()) if (n > max) max = n;
  const tied = [...count.keys()].filter((d) => count.get(d) === max);
  const target = lastDesk !== null && tied.includes(lastDesk) ? lastDesk : tied.reduce((a, b) => (compareDeskKeys(layout, a, b) <= 0 ? a : b));
  return { target, others: [...count.keys()].filter((d) => d !== target).sort((a, b) => a - b) };
}

/** Desk keys in UTF-16 code-unit order; a desk the layout lacks after every known one; then by ordinal. */
function compareDeskKeys(layout: Layout, a: DeskRef, b: DeskRef): number {
  const ka = layout.desks[a]?.key, kb = layout.desks[b]?.key;
  if (ka !== undefined && kb !== undefined && ka !== kb) return ka < kb ? -1 : 1;
  if (ka === undefined && kb !== undefined) return 1;
  if (kb === undefined && ka !== undefined) return -1;
  return a - b;
}

/** The index of peer in homeOrder (§3.6); a peer the layout does not list stands after every listed one. */
export function homeSpot(layout: Layout, peer: PeerRef): number {
  const i = layout.homeOrder.indexOf(peer);
  return i >= 0 ? i : layout.homeOrder.length;
}

/** What the reducer tells placement about the event it just applied: the actor it concerns and where that event sends it. */
export type PlaceHint =
  | { actor: string; kind: 'face'; request: string }      // request_open: its requester faces the holder
  | { actor: string; kind: 'stool'; desk: DeskRef };      // grant_start: the grantee's stool

/** Where an actor is before chairs and visitor tiles are handed out: at a desk (sitting or visiting), or at a final place. */
type Spot = { desk: DeskRef } | { place: Place };

/** The facts placement reads, indexed once per scene. */
interface Index {
  requestsFrom: Map<string, Array<{ id: string; holder: ActorRef; desk: DeskRef }>>;   // open requests by requester actorKey
  newestHeld: Map<SeatRef, { desk: DeskRef; at: Position }>;                           // each seat's newest HELD (non-STALE) claim
  stoolDesks: Map<string, Set<DeskRef>>;                                               // desks of the claims granted to an actor
  petsOf: Map<PeerRef, Array<[SeatRef, PetState]>>;                                    // live pets by owner
}

function indexOf(s: Scene): Index {
  const ix: Index = { requestsFrom: new Map(), newestHeld: new Map(), stoolDesks: new Map(), petsOf: new Map() };
  for (const [id, r] of s.requests) push(ix.requestsFrom, actorKey(r.from), { id, holder: r.holder, desk: r.desk });
  for (const c of s.claims.values()) {
    if (!c.stale) {
      const cur = ix.newestHeld.get(c.seat);
      if (cur === undefined || comparePos(c.at, cur.at) > 0) ix.newestHeld.set(c.seat, { desk: c.desk, at: c.at });
    }
    if (c.grantee !== null) add(ix.stoolDesks, actorKey(c.grantee), c.desk);
  }
  for (const [seat, p] of s.pets) if (p.live) push(ix.petsOf, p.owner, [seat, p]);
  return ix;
}
function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const a = m.get(k);
  if (a === undefined) m.set(k, [v]);
  else a.push(v);
}
function add<K, V>(m: Map<K, Set<V>>, k: K, v: V): void {
  const a = m.get(k);
  if (a === undefined) m.set(k, new Set([v]));
  else a.add(v);
}

const copyActor = (a: ActorRef): ActorRef => ('peer' in a ? { peer: a.peer } : { seat: a.seat });
const sameActor = (a: ActorRef, b: ActorRef): boolean => actorKey(a) === actorKey(b);

/** The desk an actor stands at, when its place names one. */
function deskOfPlace(p: Place): DeskRef | null {
  return p.at === 'home' || p.at === 'behind' ? null : p.desk;
}

/**
 * One desk of several candidates: the one the event names, else the one the actor is already at (it stays where its last
 * event put it), else the candidate desk with the most recent event, then the lowest ordinal.
 */
function pickDesk(s: Scene, candidates: ReadonlySet<DeskRef>, hinted: DeskRef | null, current: DeskRef | null): DeskRef {
  if (hinted !== null && candidates.has(hinted)) return hinted;
  if (current !== null && candidates.has(current)) return current;
  let best: DeskRef | null = null, bestEvent = -Infinity;
  for (const d of candidates) {
    const e = s.desks.get(d)?.lastEvent ?? -1;
    if (best === null || e > bestEvent || (e === bestEvent && d < best)) {
      best = d;
      bestEvent = e;
    }
  }
  return best!;
}

/** Precedence 1 for either kind of actor: facing the holder of the open request named by request_open, or still faced. */
function facingOf(ix: Index, key: string, current: Place, hint: PlaceHint | null): Place | null {
  const requests = ix.requestsFrom.get(key);
  if (requests === undefined) return null;
  if (hint !== null && hint.actor === key && hint.kind === 'face') {
    const r = requests.find((q) => q.id === hint.request);
    if (r !== undefined) return { at: 'facing', actor: copyActor(r.holder), desk: r.desk };
  }
  if (current.at === 'facing') {
    const cur = current;
    const r = requests.find((q) => q.desk === cur.desk && sameActor(q.holder, cur.actor));
    if (r !== undefined) return { at: 'facing', actor: copyActor(r.holder), desk: r.desk };
  }
  return null;
}

/**
 * Pet precedence: open request > the desk of its newest HELD claim (by claim-op position) > granted stool > newest
 * change-set target > behind its character. A poofed pet (only petPlace asks) stands behind its owner.
 */
function petSpot(s: Scene, ix: Index, seat: SeatRef, p: PetState, hint: PlaceHint | null): Spot {
  if (!p.live) return { place: { at: 'behind', peer: p.owner } };
  const key = actorKey({ seat });
  const facing = facingOf(ix, key, p.place, hint);
  if (facing !== null) return { place: facing };
  const held = ix.newestHeld.get(seat);
  if (held !== undefined) return { desk: held.desk };
  const stools = ix.stoolDesks.get(key);
  if (stools !== undefined) {
    const at = pickDesk(s, stools, hint !== null && hint.actor === key && hint.kind === 'stool' ? hint.desk : null, p.place.at === 'stool' ? p.place.desk : null);
    return { place: { at: 'stool', desk: at } };
  }
  if (p.lastDesk !== null) return { desk: p.lastDesk };
  return { place: { at: 'behind', peer: p.owner } };
}

/**
 * Character precedence: open human request > the target desk of its newest human change-set when that publish is newer than
 * every claim op of its pets > beside the desk where most of its pets sit, when they hold claims > its home spot. A ghost
 * or a presumed-absent character stands at its home spot (§3.5.4 persistence: person_ghost and person_absent end its stay).
 */
function characterSpot(s: Scene, ix: Index, layout: Layout, peer: PeerRef, c: CharacterState, petSpots: ReadonlyMap<string, Spot>, hint: PlaceHint | null): Spot {
  const home: Spot = { place: { at: 'home', spot: homeSpot(layout, peer) } };
  if (c.absent || c.ghost) return home;
  const facing = facingOf(ix, actorKey({ peer }), c.place, hint);
  if (facing !== null) return { place: facing };
  const pets = ix.petsOf.get(peer) ?? [];
  if (c.lastPublish !== null && c.lastDesk !== null) {
    const lastPublish = c.lastPublish;
    if (pets.every(([, p]) => p.lastClaimOp === null || comparePos(lastPublish, p.lastClaimOp) > 0)) return { desk: c.lastDesk };
  }
  if (pets.some(([seat]) => ix.newestHeld.has(seat))) {
    const count = new Map<DeskRef, number>();
    for (const [seat] of pets) {
      const sp = petSpots.get(actorKey({ seat }));
      const d = sp === undefined ? null : 'desk' in sp ? sp.desk : sp.place.at === 'stool' ? sp.place.desk : null;
      if (d !== null) count.set(d, (count.get(d) ?? 0) + 1);
    }
    let max = 0;
    for (const n of count.values()) if (n > max) max = n;
    if (max > 0) {
      const tied = new Set([...count.keys()].filter((d) => count.get(d) === max));
      return { place: { at: 'beside', desk: pickDesk(s, tied, null, c.place.at === 'beside' ? c.place.desk : null) } };
    }
  }
  return home;
}

/** The position of the newest HELD (non-STALE) claim at desk d of each seat holding one there. */
function heldAt(s: Scene, d: DeskRef): Map<SeatRef, Position> {
  const out = new Map<SeatRef, Position>();
  for (const c of s.claims.values()) {
    if (c.stale || c.desk !== d) continue;
    const cur = out.get(c.seat);
    if (cur === undefined || comparePos(c.at, cur) > 0) out.set(c.seat, c.at);
  }
  return out;
}

/**
 * The actors at desk d in seating order — the chair first, then the visitor tiles: HELD claim holders by their newest HELD
 * claim at d (ClaimState.at), newest first, then publishers by lastPublish, newest first.
 */
function seatOrder(s: Scene, d: DeskRef, actors: readonly ActorRef[]): ActorRef[] {
  const held = heldAt(s, d);
  const stateOf = (a: ActorRef): CharacterState | PetState | undefined => ('peer' in a ? s.characters.get(a.peer) : s.pets.get(a.seat));
  const newestFirst = (x: Position | null, y: Position | null): number =>
    x === null ? (y === null ? 0 : 1) : y === null ? -1 : comparePos(y, x);
  const fallback = (a: ActorRef, b: ActorRef): number => {
    const va = 'seat' in a ? (s.pets.get(a.seat)?.variant ?? 0) : -1, vb = 'seat' in b ? (s.pets.get(b.seat)?.variant ?? 0) : -1;
    if (va !== vb) return va - vb;
    const ka = actorKey(a), kb = actorKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;                          // reached only by inconsistent hand-made scenes
  };
  const heldOf = (a: ActorRef): Position | null => ('seat' in a ? held.get(a.seat) ?? null : null);
  const holders = actors.filter((a) => heldOf(a) !== null);
  const publishers = actors.filter((a) => heldOf(a) === null);
  holders.sort((a, b) => newestFirst(heldOf(a), heldOf(b)) || fallback(a, b));
  publishers.sort((a, b) => newestFirst(stateOf(a)?.lastPublish ?? null, stateOf(b)?.lastPublish ?? null) || fallback(a, b));
  return [...holders, ...publishers];
}

const VISITOR_TILES_SHOWN = 4;

/** The chair, the visitors on tiles 0–3 and the "+n" of an ordered desk group. */
function seatsOf(order: readonly ActorRef[]): { chair: ActorRef | null; visitors: ActorRef[]; more: number } {
  const rest = order.slice(1);
  return { chair: order[0] === undefined ? null : copyActor(order[0]), visitors: rest.slice(0, VISITOR_TILES_SHOWN).map(copyActor), more: Math.max(0, rest.length - VISITOR_TILES_SHOWN) };
}

/** The actors whose place is a chair or a visitor tile of desk d. */
function seatedAt(s: Scene, d: DeskRef): ActorRef[] {
  const out: ActorRef[] = [];
  const at = (p: Place): boolean => (p.at === 'chair' || p.at === 'visitor') && p.desk === d;
  for (const [peer, c] of s.characters) if (at(c.place)) out.push({ peer });
  for (const [seat, p] of s.pets) if (p.live && at(p.place)) out.push({ seat });
  return out;
}

/** The place of the actor at index i of a desk's seating order. */
function seatPlace(d: DeskRef, i: number): Place {
  return i === 0 ? { at: 'chair', desk: d } : { at: 'visitor', desk: d, tile: i - 1 };
}

/** Resolves a spot to a place against the actors already seated at its desk. */
function resolve(s: Scene, spot: Spot, self: ActorRef): Place {
  if ('place' in spot) return spot.place;
  const others = seatedAt(s, spot.desk).filter((a) => !sameActor(a, self));
  const order = seatOrder(s, spot.desk, [...others, self]);
  return seatPlace(spot.desk, order.findIndex((a) => sameActor(a, self)));
}

/** Newest HELD claim holder, else most recent publisher; other claim holders first, then publishers by recency; beyond 4 visitors → more. */
export function seatDesk(s: Scene, d: DeskRef): { chair: ActorRef | null; visitors: ActorRef[]; more: number } {
  return seatsOf(seatOrder(s, d, seatedAt(s, d)));
}

/** Precedence 1–4 for the scene as it stands (no event hint: an actor never newly faces another, VIZ-17). */
export function characterPlace(s: Scene, peer: PeerRef, layout: Layout): Place {
  const c = s.characters.get(peer);
  if (c === undefined) return { at: 'home', spot: homeSpot(layout, peer) };
  const ix = indexOf(s);
  const petSpots = new Map<string, Spot>();
  for (const [seat, p] of ix.petsOf.get(peer) ?? []) petSpots.set(actorKey({ seat }), petSpot(s, ix, seat, p, null));
  return resolve(s, characterSpot(s, ix, layout, peer, c, petSpots, null), { peer });
}

/**
 * Open request > newest HELD claim chair > granted stool > newest CS target > behind; a poofed pet stands behind its owner.
 * A seat with no pet in the scene has no known owner (a seat id is opaque, never parsed): it stands at the home spot of an
 * owner the layout does not list (homeOrder.length, as homeSpot gives one). Never throws.
 */
export function petPlace(s: Scene, seat: SeatRef, layout: Layout): Place {
  const p = s.pets.get(seat);
  if (p === undefined) return { at: 'home', spot: layout.homeOrder.length };
  return resolve(s, petSpot(s, indexOf(s), seat, p, null), { seat });
}

const sitPose = (p: Place): 'sit' | 'idle' => (p.at === 'chair' || p.at === 'stool' ? 'sit' : 'idle');

function samePlace(a: Place, b: Place): boolean {
  switch (a.at) {
    case 'home': return b.at === 'home' && a.spot === b.spot;
    case 'behind': return b.at === 'behind' && a.peer === b.peer;
    case 'visitor': return b.at === 'visitor' && a.desk === b.desk && a.tile === b.tile;
    case 'facing': return b.at === 'facing' && a.desk === b.desk && sameActor(a.actor, b.actor);
    default: return b.at === a.at && deskOfPlace(b) === a.desk;
  }
}

const emptyDesk = (): DeskState => ({ lastEvent: null, chair: null, visitors: [], more: 0, claims: [] });

/**
 * The reducer's placement step (mutates s, the reducer's private copy): every actor placed by its precedence list, every
 * desk's chair, visitors and "+n" handed out, and the desk table kept sparse. An actor whose place changes, or the actor
 * `reset` names (its own publish, claim, grant, request or entry), takes the pose of its new place: 'sit' on a chair or a
 * stool, else 'idle'; every other actor keeps its pose (relaxed stays relaxed). Idempotent: settling twice changes nothing.
 * A poofed pet is skipped (only its `live` is read): pet_poof placed it, and its cost here does not grow with their number.
 */
export function settlePlaces(s: Scene, layout: Layout, hint: PlaceHint | null, reset: string | null): void {
  const ix = indexOf(s);
  const spots = new Map<string, Spot>();
  for (const [seat, p] of s.pets) if (p.live) spots.set(actorKey({ seat }), petSpot(s, ix, seat, p, hint));
  for (const [peer, c] of s.characters) spots.set(actorKey({ peer }), characterSpot(s, ix, layout, peer, c, spots, hint));

  const groups = new Map<DeskRef, ActorRef[]>();
  const actorOf = (key: string, peerOrSeat: string, isPeer: boolean): void => {
    const sp = spots.get(key)!;
    if ('desk' in sp) push(groups, sp.desk, isPeer ? { peer: peerOrSeat } : { seat: peerOrSeat });
  };
  for (const peer of s.characters.keys()) actorOf(actorKey({ peer }), peer, true);
  for (const [seat, p] of s.pets) if (p.live) actorOf(actorKey({ seat }), seat, false);

  const places = new Map<string, Place>();
  for (const [key, sp] of spots) if ('place' in sp) places.set(key, sp.place);
  for (const [d, actors] of groups) {
    const order = seatOrder(s, d, actors);
    order.forEach((a, i) => places.set(actorKey(a), seatPlace(d, i)));
    const ds = s.desks.get(d) ?? emptyDesk();
    Object.assign(ds, seatsOf(order));
    s.desks.set(d, ds);
  }
  for (const [d, ds] of s.desks) {
    if (!groups.has(d)) Object.assign(ds, { chair: null, visitors: [], more: 0 });
    if (ds.lastEvent === null && ds.chair === null && ds.visitors.length === 0 && ds.claims.length === 0) s.desks.delete(d);
  }

  const apply = (key: string, st: CharacterState | PetState): void => {
    const np = places.get(key)!;
    const moved = !samePlace(st.place, np);
    st.place = np;
    if (moved || key === reset) st.pose = sitPose(np);
  };
  for (const [peer, c] of s.characters) apply(actorKey({ peer }), c);
  for (const [seat, p] of s.pets) if (p.live) apply(actorKey({ seat }), p);
}
