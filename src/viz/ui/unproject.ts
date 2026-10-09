// The page's inverse of the projection rule (12 §3.10.6; R-V23, R-V47, R-V49, R-V73): a served EventVM, SceneVM or LayoutVM
// back into the model's SceneEvent, Scene or Layout, so the page reduces with the model's own reducer (VIZ-26). Pos → (height,
// sub, k), [key, value] arrays → Maps; every id stays the handle it was served as (12 §3.13: reduceScene treats every id as an
// opaque string), and a pet event keeps its owner handle. Pure and DOM-free (R-V33).
import type { ActorRef, Position, SceneEvent } from '../model/events.js';
import { BIG_TABLE_KEY, OVERFLOW_ZONE, type Desk, type Layout, type Zone } from '../model/layout.js';
import type { ActorState, CharacterState, ClaimState, DeskState, PetState, Place, Scene } from '../model/scene.js';
import type { ActorStateVM, ActorVM, EventVM, LayoutDeltaVM, LayoutVM, PlaceVM, Pos, SceneVM } from '../server/viewModel.js';

const posOf = (p: Pos): Position => ({ height: p[0], sub: p[1], k: p[2] });
const posOrNull = (p: Pos | null): Position | null => (p === null ? null : posOf(p));
const actorOf = (a: ActorVM): ActorRef => ('peer' in a ? { peer: a.peer } : { seat: a.seat });

function placeOf(p: PlaceVM): Place {
  switch (p.at) {
    case 'home': return { at: 'home', spot: p.spot };
    case 'chair': case 'stool': case 'beside': return { at: p.at, desk: p.desk };
    case 'visitor': return { at: 'visitor', desk: p.desk, tile: p.tile };
    case 'facing': return { at: 'facing', actor: actorOf(p.actor), desk: p.desk };
    case 'behind': return { at: 'behind', peer: p.peer };
  }
}
function actorStateOf(s: ActorStateVM): ActorState {
  return { place: placeOf(s.place), pose: s.pose, lastPublish: posOrNull(s.lastPublish), lastDesk: s.lastDesk, lastClaimOp: posOrNull(s.lastClaimOp) };
}

/** A deep copy of the event with `at` restored to height, sub and k; nested actors, lines and arrays copied. */
export function unprojectEvent(e: EventVM): SceneEvent {
  const { at, ...rest } = e;
  // ActorVM and LineVM have the model's shapes ({peer} | {seat}, {actor} | {claimId}) over handles: a deep copy is the unprojection.
  return { height: at[0], sub: at[1], k: at[2], ...structuredClone(rest) } as unknown as SceneEvent;
}

/** R-V73: the claim's `at` (the position of its newest claim_take or claim_move). Served by Task 9's projection; a scene served
 *  without it falls back to the scene's own position (no claim op is later than the scene). */
type ClaimEntryVM = SceneVM['claims'][number][1] & { at?: Pos };

export function unprojectScene(s: SceneVM): Scene {
  const characters = new Map<string, CharacterState>();
  for (const [k, c] of s.characters) {
    characters.set(k, { ...actorStateOf(c), ghost: c.ghost, absent: c.absent, frozen: c.frozen, slowedUntil: c.slowedUntil, rules: c.rules, credit: c.credit });
  }
  const pets = new Map<string, PetState>();
  for (const [k, p] of s.pets) pets.set(k, { ...actorStateOf(p), owner: p.owner, variant: p.variant, live: p.live, ssCode: p.ssCode });
  const desks = new Map<number, DeskState>();
  for (const [k, d] of s.desks) {
    desks.set(k, { lastEvent: d.lastEvent, chair: d.chair === null ? null : actorOf(d.chair), visitors: d.visitors.map(actorOf), more: d.more, claims: [...d.claims] });
  }
  const claims = new Map<string, ClaimState>();
  for (const [k, raw] of s.claims) {
    const c: ClaimEntryVM = raw;
    claims.set(k, {
      seat: c.seat, desk: c.desk, order: c.order, label: c.label === null ? null : { simple: c.label.simple, qualname: c.label.qualname },
      granularity: c.granularity, lines: c.lines === null ? null : [c.lines[0], c.lines[1]], stale: c.stale, reservedFor: c.reservedFor,
      grantee: c.grantee === null ? null : actorOf(c.grantee), otherRules: c.otherRules, at: posOf(c.at ?? s.at),
    });
  }
  const requests: Scene['requests'] = new Map();
  for (const [k, r] of s.requests) requests.set(k, { from: actorOf(r.from), holder: actorOf(r.holder), desk: r.desk, status: r.status });
  const boxes: Scene['boxes'] = new Map();
  for (const [k, b] of s.boxes) boxes.set(k, { owner: actorOf(b.owner), desk: b.desk, holdKind: b.holdKind, residence: b.residence, state: b.state, localOnly: b.localOnly });
  const bangs: Scene['bangs'] = new Map();
  for (const [k, b] of s.bangs) bangs.set(k, { on: actorOf(b.on), desk: b.desk });
  return {
    at: posOf(s.at), badge: s.badge, branchMovedAt: s.branchMovedAt, characters, pets, desks, claims, requests, boxes, bangs, beat: s.beat.map(unprojectEvent),
  };
}

/** A served desk as the model's Desk. The served form names no key: the page's key is the path of a file desk, the plaque of a
 *  folder desk + '/', the zone sign + '/…' for a shelf and '⌂' for the big table — opaque on the page, where nothing looks a desk
 *  up by key (deskOf is rebuilt from the paths). */
function deskOf(d: LayoutVM['desks'][number], zones: readonly Zone[]): Desk {
  const key = d.kind === 'big_table' ? BIG_TABLE_KEY
    : d.kind === 'file' ? d.path ?? `#${d.ordinal}`
    : d.kind === 'folder' ? `${d.plaque ?? `#${d.ordinal}`}/`
    : `${(d.zone === null ? undefined : zones[d.zone]?.key) ?? `#${d.ordinal}`}/${OVERFLOW_ZONE}`;
  return Object.freeze({ ordinal: d.ordinal, key, kind: d.kind, zone: d.zone, cell: d.cell, slot: d.slot, path: d.path, lockbox: d.lockbox, first: d.first });
}

/** The model's Layout: zone keys are the served signs; deskOf rebuilt from the file desks' paths (a Map). */
export function unprojectLayout(l: LayoutVM): Layout {
  const zones: Zone[] = l.zones.map((z) => ({ index: z.index, key: z.sign, cells: [...z.cells] }));
  const desks = l.desks.map((d) => deskOf(d, zones));
  const index = new Map<string, number>();
  for (const d of desks) if (d.kind === 'file' && d.path !== null) index.set(d.path, d.ordinal);
  return { version: l.version, zones, desks, homeOrder: [...l.homeOrder], deskOf: index };
}

/**
 * R-V49: d.version ≤ l.version → l itself (already applied: the stream and the TimelinePage carry the same delta);
 * d.from_version ≠ l.version → 'reload' (a gap); else l plus the delta as a new LayoutVM — grown zones replaced by index and new
 * ones appended, desks appended in ordinal order, new homeOrder entries appended (R-V57: a home-only delta is a real step).
 * A delta that does not follow (a zone or desk out of order, another sign at an existing zone index) is a gap too.
 */
export function applyLayoutDeltaVM(l: LayoutVM, d: LayoutDeltaVM): LayoutVM | 'reload' {
  if (d.version <= l.version) return l;
  if (d.from_version !== l.version) return 'reload';
  const zones = l.zones.map((z) => ({ index: z.index, sign: z.sign, cells: [...z.cells] }));
  for (const z of d.zones) {
    const copy = { index: z.index, sign: z.sign, cells: [...z.cells] };
    if (z.index < zones.length && zones[z.index]!.sign === z.sign) zones[z.index] = copy;
    else if (z.index === zones.length) zones.push(copy);
    else return 'reload';                                   // out of order, or another zone at that index (model applyLayoutDelta refuses it)
  }
  const desks = [...l.desks];
  for (const desk of d.desks) {
    if (desk.ordinal !== desks.length) return 'reload';
    desks.push({ ...desk });
  }
  const present = new Set(l.homeOrder);
  const homeOrder = [...l.homeOrder];
  for (const h of d.homeOrder) {
    if (!present.has(h)) {
      present.add(h);
      homeOrder.push(h);
    }
  }
  return { version: d.version, zones, desks, homeOrder };
}
