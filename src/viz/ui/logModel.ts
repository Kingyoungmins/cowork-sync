// The log panel's model (12 §3.8 "Cards", "Activity cards", "Card content", "Filters", "Memory"; VIZ-11, VIZ-24, VIZ-25;
// R-V28): one card per id in board-position order, at most 2,000; request_status as a chip of its request card; answers under
// their request; consecutive publishes of one actor merged after filtering, with at most 5 file chips and "+n"; the seen labels;
// and each card's template code and parameters, with teammate text kept for the quoted frame only. Pure and DOM-free (R-V33);
// every table keyed by a served id is a Map (VIZ-37).
import { CARD_GROUP } from '../model/cards.js';
import type { ActorVM, CardVM, EventVM, Handle, Pos } from '../server/viewModel.js';

export interface LogFilter { peer: Handle | null; desk: number | null; groups: ReadonlySet<CardVM['group']>; system: boolean; }
export type LogRow =
  | { kind: 'card'; card: CardVM; answers: CardVM[]; chips: string[] }
  | { kind: 'merged'; actor: ActorVM; cards: CardVM[]; chips: string[]; more: number };   // consecutive publishes of one actor, ≤ 5 chips
export const CARDS_MAX = 2_000, CHIPS_MAX = 5;

const PUBLISH = 'UI_VIZ_CARD_PUBLISH', REQUEST = 'UI_VIZ_CARD_REQUEST', ANSWER = 'UI_VIZ_CARD_ANSWER';
const MINUTE_MS = 60_000;

const comparePos = (a: Pos, b: Pos): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const sameActor = (a: ActorVM | null, b: ActorVM | null): boolean =>
  a !== null && b !== null && ('peer' in a ? 'peer' in b && a.peer === b.peer : 'seat' in b && a.seat === b.seat);
const isPeer = (a: ActorVM | null, h: Handle): boolean => a !== null && 'peer' in a && a.peer === h;

/** A card the page holds: the copy first received and the page's monotonic time it arrived (the basis of its seen_ms). */
interface Held { card: CardVM; receivedAt: number; }

export class LogModel {
  private cards: Held[] = [];                                      // ascending board position
  private readonly byId = new Map<string, Held>();
  private readonly statuses = new Map<string, { at: Pos; status: string }>();   // request display id → its newest status

  /** Cards in any order, each id kept once (the first copy); beyond 2,000 the oldest drop (fetched again by page). */
  add(cards: readonly CardVM[], receivedAtMono: number): void {
    let added = false;
    for (const card of cards) {
      if (this.byId.has(card.id)) continue;
      const held: Held = { card, receivedAt: receivedAtMono };
      this.byId.set(card.id, held);
      this.cards.push(held);
      added = true;
    }
    if (!added) return;
    this.cards.sort((a, b) => comparePos(a.card.at, b.card.at));
    if (this.cards.length > CARDS_MAX) {
      for (const h of this.cards.slice(0, this.cards.length - CARDS_MAX)) this.byId.delete(h.card.id);
      this.cards = this.cards.slice(this.cards.length - CARDS_MAX);
    }
  }

  /** request_status → a chip of its request card (a page-side join): the newest status by board position, kept by request id
   *  whether or not the card has arrived; every other event is ignored. */
  status(e: EventVM): void {
    if (e.kind !== 'request_status') return;
    const prev = this.statuses.get(e.request);
    if (prev !== undefined && comparePos(e.at, prev.at) < 0) return;
    this.statuses.set(e.request, { at: [e.at[0], e.at[1], e.at[2]], status: e.status });
    if (this.statuses.size > CARDS_MAX) {
      let oldest: [string, Pos] | null = null;
      for (const [id, s] of this.statuses) if (oldest === null || comparePos(s.at, oldest[1]) < 0) oldest = [id, s.at];
      this.statuses.delete(oldest![0]);
    }
  }

  /** The rows of the cards that pass every filter (AND); answers nest under a request row that passed; publishes merge after filtering. */
  rows(f: LogFilter): LogRow[] {
    const rows: LogRow[] = [];
    const requests = new Map<string, Extract<LogRow, { kind: 'card' }>>();
    for (const { card } of this.cards) {
      if (!passes(card, f)) continue;
      if (card.code === ANSWER && card.parent !== null) {
        const req = requests.get(card.parent);
        if (req !== undefined) {
          req.answers.push(card);
          continue;
        }
      }
      if (card.code === PUBLISH && card.actor !== null) {
        const last = rows[rows.length - 1];
        if (last !== undefined && last.kind === 'merged' && sameActor(last.actor, card.actor)) last.cards.push(card);
        else rows.push({ kind: 'merged', actor: card.actor, cards: [card], chips: [], more: 0 });
        continue;
      }
      const status = card.code === REQUEST && card.displayId !== null ? this.statuses.get(card.displayId) : undefined;
      const row: Extract<LogRow, { kind: 'card' }> = { kind: 'card', card, answers: [], chips: status === undefined ? [] : [status.status] };
      if (card.code === REQUEST && card.displayId !== null && !requests.has(card.displayId)) requests.set(card.displayId, row);
      rows.push(row);
    }
    for (const r of rows) {
      if (r.kind !== 'merged') continue;
      const paths = new Set<string>();
      let unserved = 0;
      for (const c of r.cards) {
        for (const p of c.paths) paths.add(p);
        unserved += Math.max(0, c.n - c.paths.length);      // paths the server did not serve (R-V50)
      }
      r.chips = [...paths].slice(0, CHIPS_MAX);
      r.more = paths.size + unserved - r.chips.length;
    }
    return rows;
  }

  /** The cards the page holds at a height, in board position order (the rewind tick's hover text, 12 §3.9.1): the log's own store,
   *  so the page keeps at most 2,000 cards per room and the oldest go first (12 §3.8 "Memory"). */
  at(height: number): CardVM[] {
    let lo = 0, hi = this.cards.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.cards[mid]!.card.at[0] < height) lo = mid + 1;
      else hi = mid;
    }
    const out: CardVM[] = [];
    for (let i = lo; i < this.cards.length && this.cards[i]!.card.at[0] === height; i++) out.push(this.cards[i]!.card);
    return out;
  }

  /** A key of what the rows render as: each row's cards, answers, chips and "+n", and each card's position label. It changes exactly
   *  when the panel's list would, so the panel rebuilds its DOM only then (keeping text selection and a screen reader's place). */
  key(rows: readonly LogRow[], nowMono: number, replay: boolean): string {
    const label = (c: CardVM): string => {
      const s = this.seenLabel(c, nowMono, replay);
      return s.kind === 'seen_ago' ? `${c.id}~${s.n}` : `${c.id}~${s.kind}`;
    };
    return JSON.stringify(rows.map((r) => (r.kind === 'card'
      ? [label(r.card), r.chips, r.answers.map(label)]
      : [r.cards.map(label), r.chips, r.more])));
  }

  /** → UI_VIZ_SEEN_AGO {n} (seen_ms plus the page's own Δmono since the card arrived, in whole minutes), UI_VIZ_SEEN_BEFORE_OPEN
   *  with '#<height>' for a card the viewer did not see arrive, '#<height>' in replay (VIZ-11, R-V28). */
  seenLabel(c: CardVM, nowMono: number, replay: boolean): { kind: 'seen_ago'; n: number } | { kind: 'before_open'; height: number } | { kind: 'height'; height: number } {
    const height = c.at[0];
    if (replay) return { kind: 'height', height };
    const held = this.byId.get(c.id);
    const seen = held === undefined ? c.seen_ms : held.card.seen_ms;
    if (seen === null) return { kind: 'before_open', height };
    const since = held === undefined ? 0 : nowMono - held.receivedAt;
    return { kind: 'seen_ago', n: Math.max(0, Math.floor((seen + since) / MINUTE_MS)) };
  }
}

function passes(c: CardVM, f: LogFilter): boolean {
  if (c.group === 'system' ? !f.system : !f.groups.has(c.group)) return false;
  if (f.peer !== null && !isPeer(c.actor, f.peer) && !isPeer(c.target, f.peer)) return false;
  return f.desk === null || c.desks.includes(f.desk);
}

/**
 * The card's template and its parameters, and the teammate free text for the quoted note frame (12 §3.11). The text is never a
 * parameter and never a code: it is placed only in the frame, through textContent. Names come from the page's name tags; a code
 * outside the closed card list (a forged code slot) becomes UI_INTERNAL_ERROR, the renderer's own miss, and shows no text.
 * (Final review §4a, Group B) {id} is the card's display id, else the request it answers (an answer card's parent); {path} is the
 * first file chip, else the name of the card's first desk by kind (`deskNameOf`: model/labels.ts deskName over the page's layout;
 * a request or a hold card carries a desk and no file chip), none at the big table or without a namer.
 */
export function cardText(c: CardVM, nameOf: (a: ActorVM) => string, deskNameOf: (d: number) => string | null = () => null): { code: string; params: Record<string, string | number>; quoted: string | null } {
  if (CARD_GROUP[c.code] === undefined) return { code: 'UI_INTERNAL_ERROR', params: {}, quoted: null };
  const params: Record<string, string | number> = { n: c.n };
  if (c.actor !== null) params['name'] = nameOf(c.actor);
  if (c.target !== null) params['target'] = nameOf(c.target);
  const path = c.paths.length > 0 ? c.paths[0]! : c.desks.length > 0 ? deskNameOf(c.desks[0]!) : null;
  if (path !== null) params['path'] = path;
  const id = c.displayId ?? c.parent;
  if (id !== null) params['id'] = id;
  return { code: c.code, params, quoted: c.text };
}
