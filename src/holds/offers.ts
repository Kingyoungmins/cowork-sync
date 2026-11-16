// The HLD-09 offer transition table (05-holds HLD-09; ruling R3-06). Pure: HoldRegistry.offerEvent applies it. Plan 3 fires
// no promoter, answer, request_status or presume_absent (those are Plans 5–6's), so a Plan 3 record reaches
// `pending_leftover` only in tests. An acknowledgment and the automatic re-attempt change the `request` op only, never the
// record, so neither is an event here.
import { guardName, type HoldRecord, type Offer } from './record.js';

export type OfferEvent = 'born_leftover' | 'promote' | 'handoff' | 'k6_timer' | 'accepted' | 'declined' | 'released' | 'presume_absent'
  | 'holder_seat_end' | 'request_returned' | 'grant_ended';

/** HLD-09: at 2 folded declines of one (requester, claim_id, H1) the item goes to the requester's human. */
export const DECLINES_TO_HUMAN = 2;

const PROMOTERS: ReadonlySet<OfferEvent> = new Set<OfferEvent>(['promote', 'handoff', 'k6_timer']);
const RETURNS: ReadonlySet<OfferEvent> = new Set<OfferEvent>(['declined', 'released', 'presume_absent', 'holder_seat_end', 'request_returned']);

/**
 * HLD-09: none|returned → pending_leftover (born_leftover); pending_leftover → offered (promote, handoff, k6_timer; never while
 * wake-scope holds, HLD-66); offered → accepted; offered → returned (declined, released, presume_absent, holder_seat_end,
 * request_returned); accepted → returned (grant_ended only); otherwise null. Pure.
 */
export function offerNext(r: Pick<HoldRecord, 'offer' | 'guards'>, ev: OfferEvent): Offer | null {
  switch (r.offer) {
    case 'none':
    case 'returned':
      return ev === 'born_leftover' ? 'pending_leftover' : null;
    case 'pending_leftover':
      if (!PROMOTERS.has(ev)) return null;
      return r.guards.some((g) => guardName(g) === 'wake-scope') ? null : 'offered';
    case 'offered':
      if (ev === 'accepted') return 'accepted';
      return RETURNS.has(ev) ? 'returned' : null;
    case 'accepted':
      return ev === 'grant_ended' ? 'returned' : null;
  }
}
