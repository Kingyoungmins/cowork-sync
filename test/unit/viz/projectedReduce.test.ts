// Plan 8a Task 9: VIZ-26 over the projection (12 §3.10.6, §3.13; R-V23, R-V43, R-V47, R-V73): the page reduces projected
// events with the same reducer, over handles, from the projected start scene; at every position its scene equals the
// projected server scene, so replay on the page equals live on the server. Hand-written sequences of Task 5, one event of
// every kind, and random sequences of every kind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { HAND_SEQUENCES, OFFICE, RANDOM_OFFICE, eventsArb } from '../../helpers/vizScene.js';
import { allKindsEvents, layoutOf, projectedReduction } from '../../helpers/vizModels.js';

test('VIZ-26 (projection): reducing projected events from the projected start scene equals the projected server scene at every position', () => {
  for (const [name, seq] of HAND_SEQUENCES) {
    const { server, page } = projectedReduction(seq(), OFFICE);
    assert.equal(page.length, server.length);
    page.forEach((s, i) => assert.deepEqual(s, server[i], `${name} after event ${i}`));
  }
  const all = projectedReduction(allKindsEvents(), layoutOf());
  all.page.forEach((s, i) => assert.deepEqual(s, all.server[i], `all kinds after event ${i}`));
  // The claim's position travels with it (R-V73): the page's unprojected claim keeps the server's `at`.
  const afterMove = all.serverVM[22]!;   // claim_take C1 at 11.1, claim_take C2 at 11.2, claim_move C1 at 12.1
  assert.deepEqual(afterMove.claims.map(([, c]) => c.at), [[12, 1, 0], [11, 2, 0]]);
  assert.deepEqual([...all.page[22]!.claims.values()].map((c) => c.at), [{ height: 12, sub: 1, k: 0 }, { height: 11, sub: 2, k: 0 }]);
});

test('VIZ-26 (projection): random sequences of every kind reduce alike on the page and on the server', () => {
  fc.assert(
    fc.property(eventsArb({ maxLength: 40 }), (events) => {
      const { server, page } = projectedReduction(events, RANDOM_OFFICE);
      page.forEach((s, i) => assert.deepEqual(s, server[i], `after event ${i}`));
    }),
    { numRuns: 60 },
  );
});
