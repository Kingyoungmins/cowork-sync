// The view-model projection (12 §3.10.6 allowlist and never-served list, §3.10.7 untrusted text, §3.6 name tags, §3.8 seen_ms;
// VIZ-18, VIZ-26, VIZ-35, VIZ-36; rulings R-V22, R-V23, R-V27, R-V28, R-V43, R-V47, R-V50, R-V51, R-V52, R-V56, R-V73): the only
// producer of served JSON. Every value is built field by field from the model, so nothing that is not listed is served: ids
// become handles (R-V22), positions become Pos (R-V23), Maps become [key, value] arrays in ascending key order, every free-text
// string goes through vizText (the SEC-35 validator of its kind, sanitize(…, 'viz') and its cap, R-V50), and every code-typed
// field through its closed set (R-V43, read from codes.ts at projection time). projectEvent and projectScene apply the same
// mappings, so the page's reduction over projected events equals the projected server scene (VIZ-26).
import { createHash } from 'node:crypto';
import { base32c } from '../../board/ids.js';
import { validName, validPathSyntax } from '../../sec/validators.js';
import { cap, sanitize, VIZ_CAPS, VIZ_RAW_UNITS, type CapKind } from '../../text/sanitize.js';
import {
  CHARACTER_BADGES, DEMO_CAPTION_CODES, FREEZE_REASON_CODES, HEALTH_REASON_CODES, PH_CODES, PUBLISH_PAUSE_CODES, SS_CODES, STATUS_STATES,
} from '../i18n/codes.js';
import type { ActorRef, Line, PeerRef, Position, SceneEvent, SeatRef } from '../model/events.js';
import { phOf } from '../model/labels.js';
import { plaqueOf, type Desk, type Layout, type LayoutDelta, type Zone } from '../model/layout.js';
import { lookOf, type LookTable } from '../model/looks.js';
import type { ActorState, CharacterState, Place, Scene } from '../model/scene.js';
import type { DemoCaption, Overlay } from '../source/roomSource.js';
import type { CardModel, PeerInfo, PetInfo, RoomBadge, RoomDelta, RoomSnapshotModel, TimelinePageModel } from './models.js';
import { escapeJson } from './stream.js';
import type {
  ActorStateVM, ActorVM, CardVM, CaptionVM, CharacterVM, EventVM, Handle, LayoutDeltaVM, LayoutVM, LineVM, OverlayVM, PetVM, PlaceVM, Pos,
  RoomVM, SceneVM, SeatHandle, ShortId, StreamPayload, TimelinePage, World,
} from './viewModel.js';

// ---------------------------------------------------------------------------------------------------------------
// Handles and display ids (R-V22)

export interface HandleTable {
  peer(p: PeerRef): Handle; seat(s: SeatRef): SeatHandle; shortId(id: string): ShortId;
  /** R-V22: true once a later id collided with an earlier prefix (the world must be re-sent: the api publishes reset). */
  takeCollision(): boolean;
}

const PEER_HANDLE = 6, SEAT_HANDLE = 6, SHORT_ID = 8;

/** Common prefix length of two strings, in UTF-16 code units. */
function lcp(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/**
 * One namespace of R-V22 handles. A handle is the first `base` characters of the id's digest (the id itself, or for seats
 * base32c(sha256(seat key))), extended to the shortest prefix no other digest of the namespace shares: base or one more than
 * the longest common prefix with any other digest — which is always that of a neighbour in sorted order. Handles depend on
 * the set of ids only, never on the order they were seen; a digest that is a prefix of another is served whole.
 */
class IdSpace {
  private readonly digestOf = new Map<string, string>();     // id → digest
  private readonly lengthOf = new Map<string, number>();     // digest → handle length
  private readonly sorted: string[] = [];                    // digests, ascending UTF-16 order

  constructor(private readonly base: number, private readonly digest: (id: string) => string, private readonly onCollision: () => void) {}

  handle(id: string): string {
    let d = this.digestOf.get(id);
    if (d === undefined) {
      d = this.digest(id);
      this.digestOf.set(id, d);
      if (!this.lengthOf.has(d)) this.insert(d);
    }
    return d.slice(0, this.lengthOf.get(d));
  }

  private insert(d: string): void {
    let lo = 0;
    let hi = this.sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.sorted[mid]! < d) lo = mid + 1;
      else hi = mid;
    }
    const neighbours = [this.sorted[lo - 1], this.sorted[lo]];
    this.sorted.splice(lo, 0, d);
    let need = this.base;
    for (const o of neighbours) {
      if (o === undefined) continue;
      const len = lcp(d, o) + 1;
      need = Math.max(need, len);
      const cur = this.lengthOf.get(o)!;
      if (len > cur) {
        this.lengthOf.set(o, len);
        if (o.slice(0, cur) !== o.slice(0, len)) this.onCollision();   // an earlier served handle changed
      }
    }
    this.lengthOf.set(d, need);
  }
}

const seatDigest = (seat: string): string => base32c(createHash('sha256').update(seat, 'utf8').digest());

export function createHandleTable(): HandleTable {
  let collided = false;
  const flag = (): void => { collided = true; };
  const peers = new IdSpace(PEER_HANDLE, (p) => p, flag);
  const seats = new IdSpace(SEAT_HANDLE, seatDigest, flag);
  const shorts = new IdSpace(SHORT_ID, (id) => id, flag);
  return {
    peer: (p) => peers.handle(p),
    seat: (s) => seats.handle(s),
    shortId: (id) => shorts.handle(id),
    takeCollision: () => {
      const c = collided;
      collided = false;
      return c;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Served text and codes (12 §3.10.7; R-V27, R-V43, R-V50)

export type VizTextKind = 'name' | 'label' | 'path' | 'plaque' | 'branch' | 'room' | 'caption' | 'version' | 'sign' | 'note' | 'card' | 'tooltip';

/** The §3.11 cap of each served text kind (a zone sign is capped like a path: 80, middle ellipsis). */
const CAP_OF: Readonly<Record<VizTextKind, CapKind>> = Object.freeze({
  name: 'name', label: 'label', path: 'path', plaque: 'plaque', branch: 'branch', room: 'room', caption: 'caption', version: 'version',
  sign: 'path', note: 'note', card: 'card', tooltip: 'tooltip',
});
/** SEC-35 validLabel (12 §3.10.7), applied per label field. */
const VALID_LABEL = /^[\p{L}\p{M}\p{N}_.:#<>,$@[\]()-]{1,200}$/u;

/** Validators first (path: validPathSyntax else '?'; label: SEC-35 validLabel else '?'), then sanitize(…, 'viz'), then cap (raw units first,
 *  R-V50). Every served free-text string goes through it; nothing else produces served text. */
export function vizText(kind: VizTextKind, raw: string): string {
  if (kind === 'path' && !validPathSyntax(raw)) return '?';
  if (kind === 'label' && !VALID_LABEL.test(raw)) return '?';
  return cap(sanitize(raw, 'viz'), CAP_OF[kind]);
}

/** R-V43: the value when it is in `set`, else `fallback` ('?' for a non-nullable field, null for a nullable one). */
export function vizCode<F extends '?' | null>(set: ReadonlySet<string>, raw: string | null, fallback: F): string | F {
  return raw !== null && set.has(raw) ? raw : fallback;
}

export const PATHS_MAX_BYTES = 16_384;

/** R-V50: the longest prefix of the vizText'd paths whose JSON is ≤ PATHS_MAX_BYTES (the same cut on every route). Measured as
 *  escapeJson serializes it, element by element (escapeJson works per character, so the array's size is the sum of its parts). */
export function servedPaths(paths: readonly string[]): string[] {
  const out: string[] = [];
  let size = 2;                                   // []
  for (const p of paths) {
    const s = vizText('path', p);
    const add = Buffer.byteLength(escapeJson(s), 'utf8') + (out.length > 0 ? 1 : 0);
    if (size + add > PATHS_MAX_BYTES) break;
    out.push(s);
    size += add;
  }
  return out;
}

// The closed sets of the enum-like fields whose model type is a plain string (glossary §9 hold records, §7 ops; S8). An
// out-of-set value serves as '?' (non-nullable) or null (nullable), like the R-V43 code fields.
const EVENT_KINDS: ReadonlySet<string> = new Set(['K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7', 'breach', 'freeze', 'unfreeze', 'incident', 'nonretryable', 'health']);
const HOLD_KINDS: ReadonlySet<string> = new Set(['PATCH', 'PIN', 'INCOMING']);
const HOLD_RESIDENCES: ReadonlySet<string> = new Set(['ON_DISK', 'OFF_DISK']);
const HOLD_STATES: ReadonlySet<string> = new Set(['ACTIVE', 'CONFLICTED', 'PARKED', 'SUBSUMED', 'GONE', 'RESOLVED_PUBLISH', 'RESOLVED_DISCARD']);
const HOLD_OFFERS: ReadonlySet<string> = new Set(['none', 'pending_leftover', 'offered', 'accepted', 'returned']);
const REQUEST_STATUSES: ReadonlySet<string> = new Set(['asked', 'queued_until_turn_end', 'awaiting_human', 'undeliverable', 'returned']);
const ROOM_BADGES: ReadonlySet<RoomBadge> = new Set<RoomBadge>([
  'UI_VIZ_VERSION_SKEW', 'UI_VIZ_NEWER_PROTOCOL', 'UI_VIZ_CHECKPOINT_MISMATCH', 'UI_VIZ_INCIDENT_FROZEN', 'UI_VIZ_NO_BOARD',
]);
const CAPTION_CODES: ReadonlySet<string> = new Set(DEMO_CAPTION_CODES);

/**
 * S8, R-V27: every plain `string` field of viewModel.ts (one that is neither a named alias nor a literal union) → its check: 'enum' (a closed
 * set: '?' or null out of set) or the VizTextKind the projection passes it through. A test compares the keys with the generated schemas.
 */
export const SERVED_STRING_FIELDS: ReadonlyMap<string, 'enum' | VizTextKind> = new Map<string, 'enum' | VizTextKind>([
  ['CaptionVM.text', 'caption'],
  ['CardVM.label', 'label'],
  ['CardVM.paths', 'path'],
  ['CardVM.text', 'note'],
  ['CharacterVM.name', 'name'],
  ['CharacterVM.version', 'version'],
  ['EventVM.eventKind', 'enum'],
  ['EventVM.holdKind', 'enum'],
  ['EventVM.label.qualname', 'label'],
  ['EventVM.label.simple', 'label'],
  ['EventVM.note', 'note'],
  ['EventVM.offer', 'enum'],
  ['EventVM.paths', 'path'],
  ['EventVM.residence', 'enum'],
  ['EventVM.state', 'enum'],
  ['EventVM.text', 'note'],
  ['LayoutVM.desks.path', 'path'],
  ['LayoutVM.desks.plaque', 'plaque'],
  ['LayoutVM.zones.sign', 'sign'],
  ['OverlayVM.state', 'enum'],
  ['RoomVM.branch', 'branch'],
  ['RoomVM.label', 'room'],
  ['SceneVM.boxes.holdKind', 'enum'],
  ['SceneVM.boxes.residence', 'enum'],
  ['SceneVM.boxes.state', 'enum'],
  ['SceneVM.claims.label.qualname', 'label'],
  ['SceneVM.claims.label.simple', 'label'],
  ['SceneVM.requests.status', 'enum'],
  ['StreamPayload.branch', 'branch'],
  ['StreamPayload.label', 'room'],
]);

/** R-V43: a card's detail code is served only within the set of its §3.4 row (a pet's health card details its SS_* label); any
 *  other card has no detail code to serve. The sets are codes.ts's own, read at projection time. */
const DETAIL_SETS: ReadonlyMap<string, readonly ReadonlySet<string>[]> = new Map<string, readonly ReadonlySet<string>[]>([
  ['UI_VIZ_CARD_FREEZE', [FREEZE_REASON_CODES]],
  ['UI_VIZ_CARD_HEALTH', [HEALTH_REASON_CODES, SS_CODES]],
  ['UI_VIZ_CARD_SLOWED', [HEALTH_REASON_CODES]],
  ['UI_VIZ_CARD_BOARD_FULL', [HEALTH_REASON_CODES]],
  ['UI_VIZ_CARD_NONRETRYABLE', [PUBLISH_PAUSE_CODES]],
]);

// ---------------------------------------------------------------------------------------------------------------
// Name tags (12 §3.6; VIZ-18; R-V52)

const SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });
const TAG_SEP = ' \u{B7} ';
const ELLIPSIS = '\u{2026}';
/** A display ending in what looks like a handle (R-V52): it always counts as colliding, so it shows its own handle. */
const HANDLE_LOOKALIKE = /[\s.\u{B7}\u{2022}-]+[0-9a-f]{6,}$/u;

/** Default-ignorable code points. validName admits the Mn and Lo ones, but sanitize(…, 'viz') strips every one of them (follow-up FS),
 *  so a shown name holds none: the removals below are defence in depth, kept so that name comparison stays right should a name ever
 *  reach it unsanitized. The Mn ones (U+034F, U+17B4, U+17B5, U+180B–U+180D, U+180F, U+FE00–U+FE0F, U+E0100–U+E01EF) draw as
 *  nothing, so comparison removes them (fix round 1). */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;
/** The four Lo default-ignorables, the Hangul fillers. Unsanitized they do not draw as nothing: HarfBuzz keeps them visible (Uniscribe
 *  compatibility) and fillText draws a blank space (7–14 px at 14 px in Chromium), so comparison also reads each as a space (fix
 *  round 2). sanitize strips them too (FS), so on a shown name this form equals the other: defence in depth, like INVISIBLE. NFKC
 *  maps U+3164 and U+FFA0 to U+1160 and maps nothing else onto a filler. */
const HANGUL_FILLER = /[\u{115F}\u{1160}\u{3164}\u{FFA0}]/gu;

/** The sanitized display a valid name shows, or null (validName fails, or only whitespace, Hangul fillers and invisible marks are left):
 *  then the tag is peer-<handle>. */
function shownName(display: string | null): string | null {
  if (display === null || !validName(display)) return null;
  const s = sanitize(display, 'viz');
  return s.replace(INVISIBLE, '').trim() === '' ? null : s;
}

/** At most `n` graphemes and `units` code units of `s`, the last of them an ellipsis when `s` is longer. */
function cutGraphemes(s: string, n: number, units: number): string {
  const gs = Array.from(SEGMENTER.segment(s), (x) => x.segment);
  if (gs.length <= n && s.length <= units) return s;
  let out = '';
  for (let i = 0; i < gs.length && i < n - 1 && out.length + gs[i]!.length <= units - 1; i++) out += gs[i]!;
  return n > 0 && units > 0 ? out + ELLIPSIS : '';
}

/** R-V52: validName(display) ? display : `peer-<handle>`; when collide, the display capped to max(0, 20 − 3 − |handle|) graphemes + ' · ' + the
 *  whole handle (a fallback tag already shows the whole handle). */
export function nameTag(display: string | null, handle: Handle, collide: boolean): string {
  const shown = shownName(display);
  if (shown === null) return `peer-${handle}`;
  const tag = cap(shown, 'name');
  if (!collide) return tag;
  const rest = TAG_SEP.length + handle.length;
  return `${cutGraphemes(tag, Math.max(0, VIZ_CAPS.name - rest), Math.max(0, VIZ_RAW_UNITS.name - rest))}${TAG_SEP}${handle}`;
}

/** A comparison form: without default-ignorables (removed before NFKC, so a mark cannot keep a letter and its combining accent from
 *  composing, and after it, for what NFKC maps onto one), NFKC, lower case, whitespace runs as one space, trimmed. */
const comparisonForm = (s: string): string =>
  s.replace(INVISIBLE, '').normalize('NFKC').replace(INVISIBLE, '').toLowerCase().replace(/\s+/gu, ' ').trim();

/** The comparison forms of a shown name, distinct: with the Hangul fillers removed, and with each read as a space (mapped before
 *  INVISIBLE removes it). Two names that draw the same share a form, and a forged handle suffix whose separator is a filler, or that
 *  carries an invisible mark or a filler inside it, matches HANDLE_LOOKALIKE in one of them (R-V52, VIZ-18). The union only adds
 *  collisions, the direction R-V52 allows. A shown name is sanitized, which already strips the fillers and the marks (FS), so it has
 *  one form today; the two forms stay as defence in depth (8a final review). */
const nameKeys = (shown: string): readonly string[] => {
  const removed = comparisonForm(shown);
  const spaced = comparisonForm(shown.replace(HANGUL_FILLER, ' '));
  return spaced === removed ? [removed] : [removed, spaced];
};

/** R-V52: peers whose tags collide in a room: equal looks, or a shared comparison form (nameKeys: normalize('NFKC').toLowerCase(), the
 *  default-ignorables removed, the Hangul fillers also read as spaces) of the uncapped sanitized display, or a display one of whose forms
 *  matches [\s.·•-]+[0-9a-f]{6,}$ (a handle-suffix lookalike always collides). Equal capped tags collide too (VIZ-18: two 25-character
 *  names equal in their first 20 would otherwise show the same tag). */
export function tagCollisions(peers: ReadonlyMap<PeerRef, { display: string | null }>, looks: LookTable): ReadonlySet<PeerRef> {
  const out = new Set<PeerRef>();
  const groups = new Map<string, PeerRef[]>();
  const join = (key: string, p: PeerRef): void => {
    const g = groups.get(key);
    if (g === undefined) groups.set(key, [p]);
    else g.push(p);
  };
  for (const [p, { display }] of peers) {
    const look = looks.get(p) ?? lookOf(p);
    join(`look:${look.hue}:${look.accessory}`, p);
    const shown = shownName(display);
    if (shown === null) continue;
    // nameKeys gives distinct forms, so a peer joins each group at most once and never collides with itself.
    for (const key of nameKeys(shown)) {
      if (HANDLE_LOOKALIKE.test(key)) out.add(p);
      join(`name:${key}`, p);
    }
    for (const key of nameKeys(cap(shown, 'name'))) join(`tag:${key}`, p);
  }
  for (const g of groups.values()) if (g.length > 1) for (const p of g) out.add(p);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Events, scenes and cards (the projection rule)

const pos = (p: Position): Pos => [p.height, p.sub, p.k];
const posOrNull = (p: Position | null): Pos | null => (p === null ? null : pos(p));
const actorVM = (a: ActorRef, h: HandleTable): ActorVM => ('peer' in a ? { peer: h.peer(a.peer) } : { seat: h.seat(a.seat) });
const actorOrNull = (a: ActorRef | null, h: HandleTable): ActorVM | null => (a === null ? null : actorVM(a, h));
const lineVM = (l: Line, h: HandleTable): LineVM => ('actor' in l ? { actor: actorVM(l.actor, h) } : { claimId: h.shortId(l.claimId) });
const labelVM = (l: { simple: string; qualname: string } | null): { simple: string; qualname: string } | null =>
  (l === null ? null : { simple: vizText('label', l.simple), qualname: vizText('label', l.qualname) });
const noteVM = (n: string | null): string | null => (n === null ? null : vizText('note', n));
const linesVM = (l: [number, number] | null): [number, number] | null => (l === null ? null : [l[0], l[1]]);
/** Ascending UTF-16 order of the served keys. */
const byKey = <V>(entries: Array<[string, V]>): Array<[string, V]> => entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** R-V43 and VIZ-26: a health code on a pet becomes its SS_* label (PetState.ssCode), so a seat's badge code is served within SS_CODES, the set
 *  of that label; a character's within HEALTH_REASON_CODES. */
const badgeCode = (a: ActorRef, code: string | null): string | null => vizCode('peer' in a ? HEALTH_REASON_CODES : SS_CODES, code, null);

/** R-V23, R-V43, R-V47, R-V50: the SceneEvent with handles, short ids, Pos, served text and closed-set codes. */
export function projectEvent(e: SceneEvent, h: HandleTable): EventVM {
  const at = pos(e);
  const seed = e.seed;
  switch (e.kind) {
    case 'room_open':
      return { at, seed, kind: e.kind };
    case 'room_sign':
      return { at, seed, kind: e.kind, sign: e.sign };
    case 'room_badge':
      return { at, seed, kind: e.kind, level: e.level };
    case 'person_enter': case 'person_respawn': case 'person_exit': case 'person_thaw': case 'person_absent': case 'person_ghost': case 'person_unghost':
      return { at, seed, kind: e.kind, peer: h.peer(e.peer) };
    case 'person_freeze':
      return { at, seed, kind: e.kind, peer: h.peer(e.peer), reasonCode: vizCode(FREEZE_REASON_CODES, e.reasonCode, '?') };
    case 'person_slowed':
      return { at, seed, kind: e.kind, peer: h.peer(e.peer), until: e.until };
    case 'person_bang':
      return { at, seed, kind: e.kind, peer: h.peer(e.peer), bang: e.bang };
    case 'person_badge':
      return { at, seed, kind: e.kind, actor: actorVM(e.actor, h), badge: e.badge, on: e.on, code: badgeCode(e.actor, e.code) };
    case 'pet_spawn': case 'pet_poof':
      return { at, seed, kind: e.kind, seat: h.seat(e.seat), owner: h.peer(e.owner) };
    case 'pose_relaxed':
      return { at, seed, kind: e.kind, actor: actorVM(e.actor, h) };
    case 'publish':
      return {
        at, seed, kind: e.kind, actor: actorVM(e.actor, h), target: e.target, others: [...e.others], paths: servedPaths(e.paths), n: e.n,
        state: e.state, checks: e.checks, origin: e.origin,
      };
    case 'conflict':
      return {
        at, seed, kind: e.kind, conflict: e.conflict, source: e.source, on: actorVM(e.on, h), desk: e.desk, holdId: e.holdId === null ? null : h.shortId(e.holdId),
        cid: e.cid, eventKind: vizCode(EVENT_KINDS, e.eventKind, null), line: e.line === null ? null : lineVM(e.line, h),
      };
    case 'box':
      return {
        at, seed, kind: e.kind, holdId: h.shortId(e.holdId), owner: actorVM(e.owner, h), holdKind: vizCode(HOLD_KINDS, e.holdKind, '?'),
        residence: vizCode(HOLD_RESIDENCES, e.residence, '?'), state: vizCode(HOLD_STATES, e.state, '?'), offer: vizCode(HOLD_OFFERS, e.offer, '?'),
        desk: e.desk, localOnly: e.localOnly, terminal: e.terminal,
      };
    case 'claim_take': case 'claim_move':
      return {
        at, seed, kind: e.kind, claimId: h.shortId(e.claimId), seat: h.seat(e.seat), desk: e.desk, order: e.order, label: labelVM(e.label),
        granularity: e.granularity, lines: linesVM(e.lines), otherRules: e.otherRules,
      };
    case 'claim_stale':
      return { at, seed, kind: e.kind, claimId: h.shortId(e.claimId) };
    case 'claim_release':
      return { at, seed, kind: e.kind, claimId: h.shortId(e.claimId), reason: e.reason };
    case 'claim_reserve':
      return { at, seed, kind: e.kind, claimId: h.shortId(e.claimId), request: e.request, requester: actorVM(e.requester, h) };
    case 'grant_start': case 'grant_end':
      return { at, seed, kind: e.kind, claimId: h.shortId(e.claimId), grantee: actorVM(e.grantee, h) };
    case 'request_open':
      return {
        at, seed, kind: e.kind, request: e.request, from: actorVM(e.from, h), holder: actorVM(e.holder, h), desk: e.desk, requestKind: e.requestKind,
        estMinutes: e.estMinutes, attempt: e.attempt, note: noteVM(e.note),
      };
    case 'request_status':
      return { at, seed, kind: e.kind, request: e.request, holder: actorVM(e.holder, h), status: e.status };
    case 'answer':
      return { at, seed, kind: e.kind, request: e.request, holder: actorVM(e.holder, h), verb: e.verb, by: e.by, note: noteVM(e.note) };
    case 'note': {
      const t = e.target;
      const target = t === null ? null : 'claimId' in t ? { claimId: h.shortId(t.claimId) } : { request: t.request };
      return { at, seed, kind: e.kind, actor: actorVM(e.actor, h), target, text: vizText('note', e.text) };
    }
    case 'save':
      return { at, seed, kind: e.kind, peer: h.peer(e.peer), desks: [...e.desks] };
  }
}

function placeVM(p: Place, h: HandleTable): PlaceVM {
  switch (p.at) {
    case 'home': return { at: 'home', spot: p.spot };
    case 'chair': case 'stool': case 'beside': return { at: p.at, desk: p.desk };
    case 'visitor': return { at: 'visitor', desk: p.desk, tile: p.tile };
    case 'facing': return { at: 'facing', actor: actorVM(p.actor, h), desk: p.desk };
    case 'behind': return { at: 'behind', peer: h.peer(p.peer) };
  }
}

const stateVM = (s: ActorState, h: HandleTable): ActorStateVM => ({
  place: placeVM(s.place, h), pose: s.pose, lastPublish: posOrNull(s.lastPublish), lastDesk: s.lastDesk, lastClaimOp: posOrNull(s.lastClaimOp),
});

/** The same R-V43 mapping as projectEvent (VIZ-26): a frozen character stays frozen with '?' for an out-of-set reason; a pet's SS_* label
 *  within SS_CODES; box and request enums within their sets. ClaimState.at is served as Pos (R-V73). */
export function projectScene(s: Scene, h: HandleTable): SceneVM {
  return {
    at: pos(s.at),
    badge: s.badge,
    branchMovedAt: s.branchMovedAt,
    characters: byKey([...s.characters].map(([p, c]) => [h.peer(p), {
      ...stateVM(c, h), ghost: c.ghost, absent: c.absent, frozen: c.frozen === null ? null : vizCode(FREEZE_REASON_CODES, c.frozen, '?'),
      slowedUntil: c.slowedUntil, rules: c.rules, credit: c.credit,
    }])),
    pets: byKey([...s.pets].map(([seat, p]) => [h.seat(seat), {
      ...stateVM(p, h), owner: h.peer(p.owner), variant: p.variant, live: p.live, ssCode: vizCode(SS_CODES, p.ssCode, null),
    }])),
    desks: [...s.desks].map(([d, ds]): SceneVM['desks'][number] => [d, {
      lastEvent: ds.lastEvent, chair: actorOrNull(ds.chair, h), visitors: ds.visitors.map((a) => actorVM(a, h)), more: ds.more,
      claims: ds.claims.map((id) => h.shortId(id)),
    }]).sort(([a], [b]) => a - b),
    claims: byKey([...s.claims].map(([id, c]) => [h.shortId(id), {
      seat: h.seat(c.seat), desk: c.desk, order: c.order, label: labelVM(c.label), granularity: c.granularity, lines: linesVM(c.lines), stale: c.stale,
      reservedFor: c.reservedFor, grantee: actorOrNull(c.grantee, h), otherRules: c.otherRules, at: pos(c.at),
    }])),
    requests: byKey([...s.requests].map(([id, r]) => [id, {
      from: actorVM(r.from, h), holder: actorVM(r.holder, h), desk: r.desk, status: vizCode(REQUEST_STATUSES, r.status, null),
    }])),
    boxes: byKey([...s.boxes].map(([id, b]) => [h.shortId(id), {
      owner: actorVM(b.owner, h), desk: b.desk, holdKind: vizCode(HOLD_KINDS, b.holdKind, '?'), residence: vizCode(HOLD_RESIDENCES, b.residence, '?'),
      state: vizCode(HOLD_STATES, b.state, '?'), localOnly: b.localOnly,
    }])),
    bangs: byKey([...s.bangs].map(([id, b]) => [h.shortId(id), { on: actorVM(b.on, h), desk: b.desk }])),
    beat: s.beat.map((e) => projectEvent(e, h)),
  };
}

/** A request or event display id (R…, C<cid>) is served as it is; any other is a hold id, served as its R-V22 short id. */
const DISPLAY_ID_KEPT = /^[RC][0-9A-HJKMNP-TV-Z]{8}$/;

/** seen_ms = nowMono − foldedAt for a card with a seen anchor, else null (R-V28); detail within its row's set (R-V43). */
export function projectCard(c: CardModel, nowMono: number, h: HandleTable): CardVM {
  const k = c.card;
  const detailSets = DETAIL_SETS.get(k.code) ?? [];
  return {
    id: k.id, at: pos(k.at), group: k.group, code: k.code, actor: actorOrNull(k.actor, h), target: actorOrNull(k.target, h),
    paths: servedPaths(k.paths), n: k.n, desks: [...k.desks],
    displayId: k.displayId === null ? null : DISPLAY_ID_KEPT.test(k.displayId) ? k.displayId : h.shortId(k.displayId),
    parent: k.parent, label: k.label === null ? null : vizText('label', k.label), text: noteVM(k.text),
    detail: k.detail === null ? null : detailSets.some((s) => s.has(k.detail!)) ? k.detail : '?',
    seen_ms: c.foldedAt === null ? null : Math.max(0, nowMono - c.foldedAt),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Layout (12 §3.5.3; R-V51)

/** The real folder behind a zone key (the ':' escape of layout.ts's pathKey removed per segment, R-V61). */
const unescapeKey = (key: string): string => key.split('/').map((seg) => (seg.startsWith(':') ? seg.slice(1) : seg)).join('/');

const zoneVM = (z: Zone): LayoutVM['zones'][number] => ({ index: z.index, sign: vizText('sign', unescapeKey(z.key)), cells: [...z.cells] });

function deskVM(d: Desk): LayoutVM['desks'][number] {
  const plaque = plaqueOf(d);
  return {
    ordinal: d.ordinal, kind: d.kind, zone: d.zone, cell: d.cell, slot: d.slot, plaque: plaque === null ? null : vizText('plaque', plaque),
    path: d.path === null ? null : vizText('path', d.path), lockbox: d.lockbox, first: d.first,
  };
}

export function projectLayout(l: Layout, h: HandleTable): LayoutVM {
  return { version: l.version, zones: l.zones.map(zoneVM), desks: l.desks.map(deskVM), homeOrder: l.homeOrder.map((p) => h.peer(p)) };
}

export function projectLayoutDelta(d: LayoutDelta, h: HandleTable): LayoutDeltaVM {
  return { from_version: d.fromVersion, version: d.version, zones: d.zones.map(zoneVM), desks: d.desks.map(deskVM), homeOrder: d.homeOrder.map((p) => h.peer(p)) };
}

// ---------------------------------------------------------------------------------------------------------------
// Overlay, characters, pets, rooms and the world

/** Field by field (never message_params, not_converged or versionSkew); offline age in whole minutes; codes within their sets (R-V43). */
export function projectOverlay(o: Overlay | null, h: HandleTable): OverlayVM | null {
  if (o === null) return null;
  return {
    state: vizCode(STATUS_STATES, o.state, '?'),
    freeze_reasons: o.freezeReasons.filter((r) => FREEZE_REASON_CODES.has(r)),
    publish_pause: vizCode(PUBLISH_PAUSE_CODES, o.publishPause, null),
    down: o.down,
    unreadable: o.unreadable,
    offline_min: o.offlineMin === null || !Number.isFinite(o.offlineMin) ? null : Math.max(0, Math.floor(o.offlineMin)),
    holds: o.holds,
    incoming: o.incoming,
    ready: o.ready,
    you: o.you === null ? null : h.peer(o.you),
  };
}

/** The persistent character badges of a scene character (version and health only pop for a beat, from the events). */
function characterBadges(c: CharacterState | undefined): string[] {
  if (c === undefined) return [];
  const on: string[] = [];
  if (c.rules) on.push('UI_VIZ_BADGE_RULES');
  if (c.credit) on.push('UI_VIZ_BADGE_CREDIT');
  return on.filter((b) => CHARACTER_BADGES.has(b));
}

/**
 * The CharacterVMs of a room's peers (only those in `only` when given), ascending by handle: name tags over the whole room's tag collisions
 * (R-V52), CharacterVM.ph = phOf over the scene and PeerInfo.status (R-V56), never PH_OFFLINE. `scene` null (a delta without one): the
 * health label from the status alone, at `at`. Used by projectRoom, projectDelta and the api's poll sink.
 */
export function projectCharacters(
  room: { peers: ReadonlyMap<PeerRef, PeerInfo>; looks: LookTable; scene: Scene | null; at: Position },
  only: ReadonlySet<PeerRef> | null,
  h: HandleTable,
): CharacterVM[] {
  const collide = tagCollisions(room.peers, room.looks);
  const out: CharacterVM[] = [];
  for (const [p, info] of room.peers) {
    if (only !== null && !only.has(p)) continue;
    const handle = h.peer(p);
    const look = room.looks.get(p) ?? lookOf(p);
    const c = room.scene?.characters.get(p);
    out.push({
      handle, name: nameTag(info.display, handle, collide.has(p)), hue: look.hue, accessory: look.accessory,
      ph: vizCode(PH_CODES, phOf(c, info.status, room.at), null), version: vizText('version', info.pluginVersion), badges: characterBadges(c),
    });
  }
  return out.sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0));
}

function projectPets(pets: ReadonlyMap<SeatRef, PetInfo>, h: HandleTable): PetVM[] {
  return [...pets]
    .map(([s, p]): PetVM => ({ seat: h.seat(s), owner: h.peer(p.owner), live: p.live, ss: vizCode(SS_CODES, p.ssCode, null), variant: p.variant }))
    .sort((a, b) => (a.seat < b.seat ? -1 : a.seat > b.seat ? 1 : 0));
}

const ticksVM = (ticks: RoomSnapshotModel['ticks']): RoomVM['ticks'] => ticks.map((t) => ({ h: t.h, glyph: t.glyph }));

/** The room fields a `room` stream message shares with RoomVM: label and branch through vizText, badges within RoomBadge (R-V43). */
export function projectRoomHeader(m: Pick<RoomSnapshotModel, 'spec' | 'gone' | 'badges' | 'unknown'>): Pick<RoomVM, 'room_id' | 'label' | 'branch' | 'gone' | 'badges' | 'unknown'> {
  return {
    room_id: m.spec.id, label: vizText('room', m.spec.label), branch: vizText('branch', m.spec.branch), gone: m.gone,
    badges: m.badges.filter((b) => ROOM_BADGES.has(b)), unknown: m.unknown,
  };
}

/** CharacterVM.ph = phOf (R-V56) over the scene at h1 and PeerInfo.status; name tags from nameTag over tagCollisions. */
export function projectRoom(m: RoomSnapshotModel, nowMono: number, h: HandleTable): RoomVM {
  return {
    ...projectRoomHeader(m),
    window: { h0: m.window.h0, h1: m.window.h1 },
    overlay: projectOverlay(m.overlay, h),
    layout: projectLayout(m.layout, h),
    looks: byKey([...m.looks].map(([p, l]) => [h.peer(p), { hue: l.hue, accessory: l.accessory }])),
    characters: projectCharacters({ peers: m.peers, looks: m.looks, scene: m.scene, at: m.scene.at }, null, h),
    pets: projectPets(m.pets, h),
    scene: projectScene(m.scene, h),
    cards: m.cards.map((c) => projectCard(c, nowMono, h)),
    ticks: ticksVM(m.ticks),
  };
}

/** timeline or room_snapshot, each preceded by a layout message when the delta carries one (R-V49). Characters and pets: the delta's new or
 *  changed ones (name tags over the delta's own peers; the api's poll sink re-projects them over the whole room). */
export function projectDelta(d: RoomDelta, nowMono: number, h: HandleTable): StreamPayload[] {
  const out: StreamPayload[] = [];
  if (d.layout !== null) out.push({ type: 'layout', room_id: d.roomId, layout: projectLayoutDelta(d.layout, h) });
  const at: Position = d.scene?.at ?? { height: d.window.h1, sub: 0, k: 0 };
  const characters = projectCharacters({ peers: d.peers, looks: new Map([...d.peers.keys()].map((p) => [p, lookOf(p)])), scene: d.scene, at }, null, h);
  const pets = projectPets(d.pets, h);
  const cards = d.cards.map((c) => projectCard(c, nowMono, h));
  const ticks = ticksVM(d.ticks);
  if (d.kind === 'timeline') {
    out.push({ type: 'timeline', room_id: d.roomId, h1: d.window.h1, events: d.events.map((e) => projectEvent(e, h)), cards, ticks, characters, pets });
  } else {
    if (d.scene === null) throw new TypeError('projectDelta: a snapshot delta carries the scene at its tip');
    out.push({ type: 'room_snapshot', room_id: d.roomId, window: { h0: d.window.h0, h1: d.window.h1 }, scene: projectScene(d.scene, h), cards, ticks, characters, pets });
  }
  return out;
}

export function projectPage(p: TimelinePageModel, nowMono: number, h: HandleTable): TimelinePage {
  return {
    room_id: p.roomId, from: p.from, to: p.to, scene: projectScene(p.scene, h), events: p.events.map((e) => projectEvent(e, h)),
    cards: p.cards.map((c) => projectCard(c, nowMono, h)), layout: p.layout === null ? null : projectLayoutDelta(p.layout, h),
  };
}

/** Demo mode: every overlay null and the captions of served rooms (a caption's `room` is a served room id) through their closed code set or
 *  the caption text check; otherwise no caption. */
export function projectWorld(
  rooms: readonly RoomSnapshotModel[], cursor: number, demo: boolean, captions: readonly DemoCaption[], nowMono: number, h: HandleTable,
): World {
  const served = rooms.map((m) => projectRoom(demo ? { ...m, overlay: null } : m, nowMono, h));
  const ids = new Set(served.map((r) => r.room_id));
  const caps: CaptionVM[] = !demo ? [] : captions.filter((c) => ids.has(c.room)).map((c) => ({
    room_id: c.room, height: c.height, code: vizCode(CAPTION_CODES, c.code, null), text: c.text === null ? null : vizText('caption', c.text),
  }));
  return { v: 1, cursor, demo, rooms: served, captions: caps };
}
