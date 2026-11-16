// The HLD-09 offer transition table (Plan 3 Task 1; R3-06, CS-40). The offer tests that need a registry (wake-scope and
// releaseGuard, offerEvent, the acknowledgment) are in test/integration/registry.p3.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DECLINES_TO_HUMAN, offerNext, type OfferEvent } from '../../src/holds/offers.js';
import { makeGuard, type Offer } from '../../src/holds/record.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;

const OFFERS: Offer[] = ['none', 'pending_leftover', 'offered', 'accepted', 'returned'];
const EVENTS: OfferEvent[] = ['born_leftover', 'promote', 'handoff', 'k6_timer', 'accepted', 'declined', 'released', 'presume_absent', 'holder_seat_end', 'request_returned', 'grant_ended'];

/** The legal pairs of HLD-09 and nothing else. */
const LEGAL: Readonly<Record<string, Offer>> = {
  'none+born_leftover': 'pending_leftover',
  'returned+born_leftover': 'pending_leftover',
  'pending_leftover+promote': 'offered',
  'pending_leftover+handoff': 'offered',
  'pending_leftover+k6_timer': 'offered',
  'offered+accepted': 'accepted',
  'offered+declined': 'returned',
  'offered+released': 'returned',
  'offered+presume_absent': 'returned',
  'offered+holder_seat_end': 'returned',
  'offered+request_returned': 'returned',
  'accepted+grant_ended': 'returned',
};

test('offerNext implements the HLD-09 table and nothing else', T10, () => {
  let nulls = 0;
  for (const offer of OFFERS) {
    for (const ev of EVENTS) {
      const got = offerNext({ offer, guards: [makeGuard('revert')] }, ev);
      const want = LEGAL[`${offer}+${ev}`] ?? null;
      assert.equal(got, want, `${offer}+${ev}`);
      if (want === null) nulls++;
    }
  }
  assert.equal(OFFERS.length * EVENTS.length, 55);
  assert.equal(nulls, 43);
  for (const [o, e] of [['none', 'promote'], ['offered', 'grant_ended'], ['accepted', 'declined'], ['returned', 'accepted']] as const) {
    assert.equal(offerNext({ offer: o, guards: [] }, e), null, `${o}+${e}`);
  }
  assert.equal(DECLINES_TO_HUMAN, 2);
  const events: Equals<OfferEvent, 'born_leftover' | 'promote' | 'handoff' | 'k6_timer' | 'accepted' | 'declined' | 'released' | 'presume_absent'
    | 'holder_seat_end' | 'request_returned' | 'grant_ended'> = true;
  assert.ok(events);
});
