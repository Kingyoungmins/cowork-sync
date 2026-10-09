// Log cards (12 §3.3.7, §3.8): one per carded scene event, never merged or edited (merging is a log-panel render rule).
// Shared with the page (R-V35): imports only events.ts. cardFor is the §3.4 card column; the builder names each event's row.
import type { ActorRef, DeskRef, Position, SceneEvent } from './events.js';

export interface Card {
  id: string;                                    // "<height>.<sub>.<k>" of its source event
  at: Position;
  group: 'conversation' | 'activity' | 'conflict' | 'system';
  code: string;                                  // the UI_VIZ_CARD_* code of its §3.4 row
  actor: ActorRef | null; target: ActorRef | null;
  paths: string[]; n: number; desks: DeskRef[];
  displayId: string | null;                      // R…, C<cid>, or a hold id's first 8 characters
  parent: string | null;                         // an answer's request display id
  label: string | null; text: string | null;     // text: teammate free text only (note, request or answer note)
  detail: string | null;                         // a reason, status or verb code, shown only in the detail tooltip
}

/** The §3.4 row an event came from (the builder knows it; an event alone does not always tell, e.g. pet_spawn from seat_start vs a footprint). */
export type SceneRow =                           // join_back: R-V42; rules_change: a step-6 switch with no join (R-V45)
  | 'genesis' | 'join_new' | 'join_back' | 'join_epoch' | 'join_version' | 'join_rules' | 'rules_change' | 'join_credit' | 'leave' | 'seat_start' | 'seat_footprint' | 'seat_end'
  | 'publish_cs' | 'publish_big' | 'publish_nocs' | 'base_move' | 'freeze' | 'unfreeze' | 'slowed' | 'board_full' | 'health_other' | 'nonretryable'
  | 'hold_k4' | 'hold_claim' | 'hold_t0' | 'hold_breach' | 'hold_other' | 'event_breach' | 'event_k' | 'claim_new' | 'claim_reanchor' | 'claim_stale'
  | 'release' | 'reserve' | 'grant' | 'request' | 'request_status' | 'answer' | 'note' | 'presume_absent' | 'save' | 'ghost' | 'relaxed';

/**
 * Every UI_VIZ_CARD_* code of 12 §3.11 → its §3.8 group (the closed card list). A null-prototype frozen table, so a lookup
 * with any string never reaches Object.prototype.
 */
export const CARD_GROUP: Readonly<Record<string, Card['group']>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, Card['group']>, {
    UI_VIZ_CARD_REQUEST: 'conversation',
    UI_VIZ_CARD_ANSWER: 'conversation',
    UI_VIZ_CARD_NOTE: 'conversation',
    UI_VIZ_CARD_JOIN: 'conversation',
    UI_VIZ_CARD_REJOIN: 'conversation',
    UI_VIZ_CARD_LEAVE: 'conversation',
    UI_VIZ_CARD_SEAT_START: 'conversation',
    UI_VIZ_CARD_SEAT_END: 'conversation',
    UI_VIZ_CARD_ABSENT: 'conversation',
    UI_VIZ_CARD_K4: 'conflict',
    UI_VIZ_CARD_CONFLICT: 'conflict',
    UI_VIZ_CARD_BREACH: 'conflict',
    UI_VIZ_CARD_PUBLISH: 'activity',
    UI_VIZ_CARD_ROOM_OPEN: 'system',
    UI_VIZ_CARD_VERSION: 'system',
    UI_VIZ_CARD_RULES: 'system',
    UI_VIZ_CARD_HEALTH: 'system',
    UI_VIZ_CARD_FREEZE: 'system',
    UI_VIZ_CARD_THAW: 'system',
    UI_VIZ_CARD_SLOWED: 'system',
    UI_VIZ_CARD_NONRETRYABLE: 'system',
    UI_VIZ_CARD_SAVE: 'system',
    UI_VIZ_CARD_BASE_MOVE: 'system',
    UI_VIZ_CARD_BOARD_FULL: 'system',
  } satisfies Record<string, Card['group']>),
);

/** The card fields an event fills; the rest are null, [] or 0. */
type CardFacts = Partial<Pick<Card, 'actor' | 'target' | 'paths' | 'n' | 'desks' | 'displayId' | 'parent' | 'label' | 'text' | 'detail'>>;

const copyActor = (a: ActorRef): ActorRef => ('peer' in a ? { peer: a.peer } : { seat: a.seat });
/** C<cid> for a conflict event, the first 8 characters of a hold id for a hold record (12 §3.8). */
const conflictId = (e: Extract<SceneEvent, { kind: 'conflict' }>): string | null =>
  e.source === 'event' ? (e.cid === null ? null : `C${e.cid}`) : e.holdId === null ? null : e.holdId.slice(0, 8);
const conflictFacts = (e: Extract<SceneEvent, { kind: 'conflict' }>): CardFacts =>
  ({ actor: copyActor(e.on), desks: e.desk === null ? [] : [e.desk], displayId: conflictId(e) });

/**
 * The card of event e from §3.4 row `row`: its code, and the facts the card shows (the actor, the target, file chips, desks,
 * display ids, an answer's parent request, teammate free text, and a reason, status or verb code for the detail tooltip
 * only). null for an uncarded row, for the secondary events of a row (a respawn's pet_poof, a leave's claim_release, …),
 * for a rules badge turning off, for a room badge other than 'full', and for an event that is not one of its row's.
 */
function cardOf(e: SceneEvent, row: SceneRow): { code: string; facts: CardFacts } | null {
  switch (row) {
    case 'genesis':
      return e.kind === 'room_open' ? { code: 'UI_VIZ_CARD_ROOM_OPEN', facts: {} } : null;
    case 'join_new':
    case 'join_back':
      return e.kind === 'person_enter' ? { code: 'UI_VIZ_CARD_JOIN', facts: { actor: { peer: e.peer } } } : null;
    case 'join_epoch':
      return e.kind === 'person_respawn' ? { code: 'UI_VIZ_CARD_REJOIN', facts: { actor: { peer: e.peer } } } : null;
    case 'join_version':
      return e.kind === 'person_badge' && e.badge === 'version' ? { code: 'UI_VIZ_CARD_VERSION', facts: { actor: copyActor(e.actor) } } : null;
    case 'join_rules':
    case 'rules_change':
      return e.kind === 'person_badge' && e.badge === 'rules' && e.on ? { code: 'UI_VIZ_CARD_RULES', facts: { actor: copyActor(e.actor) } } : null;
    case 'leave':
      return e.kind === 'person_exit' ? { code: 'UI_VIZ_CARD_LEAVE', facts: { actor: { peer: e.peer } } } : null;
    case 'seat_start':
      return e.kind === 'pet_spawn' ? { code: 'UI_VIZ_CARD_SEAT_START', facts: { actor: { seat: e.seat } } } : null;
    case 'seat_end':
      return e.kind === 'pet_poof' ? { code: 'UI_VIZ_CARD_SEAT_END', facts: { actor: { seat: e.seat } } } : null;
    case 'publish_cs':
    case 'publish_big':
    case 'publish_nocs':
      return e.kind === 'publish'
        ? { code: 'UI_VIZ_CARD_PUBLISH', facts: { actor: copyActor(e.actor), paths: [...e.paths], n: e.n, desks: [e.target, ...e.others] } }
        : null;
    case 'base_move':
      return e.kind === 'room_sign' ? { code: 'UI_VIZ_CARD_BASE_MOVE', facts: {} } : null;
    case 'freeze':
      return e.kind === 'person_freeze' ? { code: 'UI_VIZ_CARD_FREEZE', facts: { actor: { peer: e.peer }, detail: e.reasonCode } } : null;
    case 'unfreeze':
      return e.kind === 'person_thaw' ? { code: 'UI_VIZ_CARD_THAW', facts: { actor: { peer: e.peer } } } : null;
    case 'slowed':
      return e.kind === 'person_slowed' ? { code: 'UI_VIZ_CARD_SLOWED', facts: { actor: { peer: e.peer } } } : null;
    case 'board_full':
      return e.kind === 'room_badge' && e.level === 'full' ? { code: 'UI_VIZ_CARD_BOARD_FULL', facts: {} } : null;
    case 'health_other':
      return e.kind === 'person_badge' && e.badge === 'health' ? { code: 'UI_VIZ_CARD_HEALTH', facts: { actor: copyActor(e.actor), detail: e.code } } : null;
    case 'nonretryable':
      return e.kind === 'person_bang' ? { code: 'UI_VIZ_CARD_NONRETRYABLE', facts: { actor: { peer: e.peer } } } : null;
    case 'hold_k4':
      return e.kind === 'conflict' ? { code: 'UI_VIZ_CARD_K4', facts: conflictFacts(e) } : null;
    case 'hold_claim':
    case 'hold_t0':
    case 'event_k':
      return e.kind === 'conflict' ? { code: 'UI_VIZ_CARD_CONFLICT', facts: conflictFacts(e) } : null;
    case 'hold_breach':
    case 'event_breach':
      return e.kind === 'conflict' ? { code: 'UI_VIZ_CARD_BREACH', facts: conflictFacts(e) } : null;
    case 'request':
      return e.kind === 'request_open'
        ? { code: 'UI_VIZ_CARD_REQUEST', facts: { actor: copyActor(e.from), target: copyActor(e.holder), desks: [e.desk], displayId: e.request, text: e.note } }
        : null;
    case 'answer':
      return e.kind === 'answer'
        ? { code: 'UI_VIZ_CARD_ANSWER', facts: { actor: copyActor(e.holder), parent: e.request, text: e.note, detail: e.verb } }
        : null;
    case 'note':
      return e.kind === 'note'
        ? { code: 'UI_VIZ_CARD_NOTE', facts: { actor: copyActor(e.actor), parent: e.target !== null && 'request' in e.target ? e.target.request : null, text: e.text } }
        : null;
    case 'presume_absent':
      return e.kind === 'person_absent' ? { code: 'UI_VIZ_CARD_ABSENT', facts: { actor: { peer: e.peer } } } : null;
    case 'save':
      return e.kind === 'save' ? { code: 'UI_VIZ_CARD_SAVE', facts: { actor: { peer: e.peer }, desks: [...e.desks] } } : null;
    // Uncarded rows (12 §3.4 "—"): credit badges, footprint spawns, every parcel transition, claims, reservations, grants,
    // request statuses (a chip on the request card), ghosts and relaxed poses.
    case 'join_credit':
    case 'seat_footprint':
    case 'hold_other':
    case 'claim_new':
    case 'claim_reanchor':
    case 'claim_stale':
    case 'release':
    case 'reserve':
    case 'grant':
    case 'request_status':
    case 'ghost':
    case 'relaxed':
      return null;
  }
}

/** The §3.4 Card column: null for uncarded rows and for the secondary events of a row (pet_poof/claim_release of a respawn, …);
 *  request_status → null (a chip); person_badge{rules} carded only when on; room_badge carded only on entering 'full'. */
export function cardFor(e: SceneEvent, row: SceneRow): Card | null {
  const c = cardOf(e, row);
  if (c === null) return null;
  const group = CARD_GROUP[c.code];
  if (group === undefined) return null;
  const f = c.facts;
  return {
    id: `${e.height}.${e.sub}.${e.k}`,
    at: { height: e.height, sub: e.sub, k: e.k },
    group,
    code: c.code,
    actor: f.actor ?? null,
    target: f.target ?? null,
    paths: f.paths ?? [],
    n: f.n ?? 0,
    desks: f.desks ?? [],
    displayId: f.displayId ?? null,
    parent: f.parent ?? null,
    label: f.label ?? null,
    text: f.text ?? null,
    detail: f.detail ?? null,
  };
}
