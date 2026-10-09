// Which folded HOST_THROTTLED events start the governor's fallback in prepareIteration (P2-R18, PRO-55's 180-height
// restart window when no fold is persisted).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialFoldState, type FoldEvent, type FoldState } from '../../src/board/fold.js';
import { RESTART_EVENT_HEIGHTS } from '../../src/board/governor.js';
import { newEpoch, newPeerId } from '../../src/board/ids.js';
import { genesisProtocol } from '../../src/board/protocol.js';
import { PLAN2_REGION_SPEC } from '../../src/engine/deps.js';
import { newlyFoldedThrottleEvents } from '../../src/engine/core.js';
import { seededRandom } from '../../src/ports/random.js';

const r = seededRandom('core-throttle');
const SELF = newPeerId(r);
const TEAM = newPeerId(r);
const EPOCH = newEpoch(r);
let seq = 0;

function event(peer: string, height: number, kind: FoldEvent['kind'] = 'health', reason = 'HOST_THROTTLED'): FoldEvent {
  return { kind, refs: [], reason_code: reason, op_id: `${peer}/${EPOCH}/${++seq}`, height };
}

/** A fold state at `height` holding `events` (cids by index). */
function stateAt(height: number, events: FoldEvent[]): FoldState {
  const s = initialFoldState(genesisProtocol(12, PLAN2_REGION_SPEC));
  s.height = height;
  events.forEach((e, i) => {
    s.events[`cid${i}`] = e;
  });
  return s;
}

const heights = (xs: ReadonlyArray<{ height: number; own: boolean }>): string[] => xs.map((x) => `${x.height}:${x.own ? 'own' : 'team'}`).sort();

test('with no previous fold only HOST_THROTTLED events within the last RESTART_EVENT_HEIGHTS heights count as folded (PRO-55), never every historical one', () => {
  assert.equal(RESTART_EVENT_HEIGHTS, 180);
  const s = stateAt(300, [
    event(TEAM, 100),                       // 200 heights old: outside
    event(TEAM, 120),                       // exactly 180 old: outside (the restart rule counts < 180)
    event(TEAM, 121),                       // 179 old: inside
    event(SELF, 290),                       // own, inside
    event(TEAM, 295, 'freeze', 'EPOCH'),    // not a throttle event
    event(TEAM, 296, 'health', 'OTHER'),    // a health event with another code
  ]);
  assert.deepEqual(heights(newlyFoldedThrottleEvents(s, null, SELF)), ['121:team', '290:own']);
  // A board whose only throttle event is old starts no fallback at all.
  assert.deepEqual(newlyFoldedThrottleEvents(stateAt(300, [event(SELF, 50), event(TEAM, 100)]), null, SELF), []);
});

test('with a previous fold every HOST_THROTTLED event above its height counts as folded, however old (P2-R18)', () => {
  const s = stateAt(300, [event(TEAM, 100), event(TEAM, 150), event(SELF, 290)]);
  assert.deepEqual(heights(newlyFoldedThrottleEvents(s, 99, SELF)), ['100:team', '150:team', '290:own']);
  assert.deepEqual(heights(newlyFoldedThrottleEvents(s, 150, SELF)), ['290:own']);
  assert.deepEqual(newlyFoldedThrottleEvents(s, 300, SELF), [], 'nothing new');
});
