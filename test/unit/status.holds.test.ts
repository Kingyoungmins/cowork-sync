// status.json message ladders with holds (Plan 3 Task 12a; 05-holds HLD-24; rulings R3-46, R3-61; CS-12; contract addition 4):
// in 'ok' the message is BRANCH_REWRITTEN, else HOST_THROTTLED, else lastEvent, else CS_NO_CHECKS_CONFIGURED, else null; in
// 'degraded' with only not_converged entries making it so, R3-61's "lastEvent (fed by core.holdCode)" — the separate hold-code slot
// StatusInputs.holdCode (fix round 1 ruling: Plan 2's engine events such as ONLINE, UNFROZEN, FROZEN or LOST_STATE never take that
// rung) — else HOLD_DIVERGED_REGIONS {n, age}, else Plan 2's degraded code; every higher state and every specific Plan 2 degraded
// condition keeps Plan 2's message. Pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStatus, type StatusInputs } from '../../src/engine/status.js';

function base(over: Partial<StatusInputs> = {}): StatusInputs {
  return {
    refused: null, down: null, freeze: [], offline: null, nonretryable: null, version: null,
    notConverged: [], pendingOlderThan60s: false, throttle: null, branchRewritten: null, lastEvent: null,
    counts: { csReady: 0, csOpen: 0, holdsActive: 0, holdsLocalOnly: 0, incoming: 0 },
    branch: 'main', peerId: 'a'.repeat(32), pluginVersion: '0.0.0',
    heartbeatMs: 1, loopPeriodMs: 2_500, lastFetchAgeMs: 10, lastPushAgeMs: null,
    diverged: null, noChecksConfigured: false, holdCode: null,
    ...over,
  };
}

const msg = (i: StatusInputs): [string, string | null, unknown] => {
  const s = computeStatus(i);
  return [s.state, s.message_code, s.message_params];
};

const THROTTLE: StatusInputs['throttle'] = { source: 'own', untilMin: 12, budget: 6, fallbackLeftS: 700, signal: 'http_429' };
const BRANCH = { hb: 'h'.repeat(8), hr: 'missing' };
const EVENT = { code: 'HOLD_SUBSUMED', params: { hid: '01J0000000000000000000000A', path: 'a.py' } };

test('computeStatus in the ok state takes BRANCH_REWRITTEN, else HOST_THROTTLED, else lastEvent, else CS_NO_CHECKS_CONFIGURED, else null', () => {
  // Every rung present: the highest wins.
  const all = { branchRewritten: BRANCH, throttle: THROTTLE, lastEvent: EVENT, noChecksConfigured: true };
  assert.deepEqual(msg(base(all)), ['ok', 'BRANCH_REWRITTEN', BRANCH]);
  assert.deepEqual(msg(base({ ...all, branchRewritten: null })), ['ok', 'HOST_THROTTLED', { source: 'own', until_min: 12, budget: 6, fallback_left_s: 700, signal: 'http_429' }]);
  assert.deepEqual(msg(base({ ...all, branchRewritten: null, throttle: null })), ['ok', 'HOLD_SUBSUMED', EVENT.params]);
  assert.deepEqual(msg(base({ ...all, branchRewritten: null, throttle: null, lastEvent: null })), ['ok', 'CS_NO_CHECKS_CONFIGURED', {}]);
  assert.deepEqual(msg(base({ noChecksConfigured: false })), ['ok', null, {}]);
  // HOLD_DIVERGED_REGIONS is never an ok message (its condition makes the state degraded, R3-61).
  assert.deepEqual(msg(base({ diverged: { n: 1, oldestAgeS: 5 }, noChecksConfigured: false })), ['ok', null, {}]);
  // CS_NO_CHECKS_CONFIGURED is an ok rung only: a degraded or higher state never shows it.
  assert.deepEqual(msg(base({ noChecksConfigured: true, notConverged: ['a.py'] }))[1], 'NOT_CONVERGED');
  assert.deepEqual(msg(base({ noChecksConfigured: true, freeze: ['MASS'] }))[1], 'FROZEN');
});

test('computeStatus in the degraded state takes lastEvent, else HOLD_DIVERGED_REGIONS {n, age}, else Plan 2\'s degraded code, when only not_converged entries make it degraded', () => {
  // not_converged holds an ON_DISK record's path (R3-46): the state is degraded.
  const nc: Partial<StatusInputs> = {
    notConverged: ['src/a.py'], notConvergedCauses: new Map([['src/a.py', { cause: 'blocked_publish', guard: 'revert' }]]),
  };
  const notPortable = { code: 'PATH_NOT_PORTABLE', params: { path: 'src/old:v2.py', rule: 2 } };
  const notConverged = ['degraded', 'NOT_CONVERGED', {
    cause: 'blocked_publish', guard: 'revert', paths: ['src/a.py'], causes: [{ cause: 'blocked_publish', guard: 'revert' }],
  }];
  // R3-61's "lastEvent (fed by core.holdCode)" is the hold-code slot.
  assert.deepEqual(msg(base({ ...nc, holdCode: notPortable, diverged: { n: 2, oldestAgeS: 75 } })), ['degraded', 'PATH_NOT_PORTABLE', notPortable.params]);
  assert.deepEqual(msg(base({ ...nc, diverged: { n: 2, oldestAgeS: 75 } })), ['degraded', 'HOLD_DIVERGED_REGIONS', { n: 2, age: 75 }]);
  assert.deepEqual(msg(base({ ...nc, diverged: null })), notConverged);
  // Fix round 1 (finding 5): a Plan 2 engine event in lastEvent (ONLINE after an outage, UNFROZEN, FROZEN, LOST_STATE, RECOVERED) never
  // takes the degraded rung: HOLD_DIVERGED_REGIONS, else NOT_CONVERGED, stays the message; the hold slot still outranks both.
  const plan2Events: Array<NonNullable<StatusInputs['lastEvent']>> = [
    { code: 'ONLINE', params: {} }, { code: 'UNFROZEN', params: { reasons: ['EPOCH'] } }, { code: 'LOST_STATE', params: { mode: 'rebuild', records: 0, paths: 0 } },
  ];
  for (const plan2 of plan2Events) {
    assert.deepEqual(msg(base({ ...nc, lastEvent: plan2, diverged: { n: 2, oldestAgeS: 75 } })), ['degraded', 'HOLD_DIVERGED_REGIONS', { n: 2, age: 75 }], plan2.code);
    assert.deepEqual(msg(base({ ...nc, lastEvent: plan2, diverged: null })), notConverged, plan2.code);
    assert.deepEqual(msg(base({ ...nc, lastEvent: plan2, holdCode: notPortable, diverged: { n: 2, oldestAgeS: 75 } })), ['degraded', 'PATH_NOT_PORTABLE', notPortable.params], plan2.code);
    // The ok ladder keeps the engine event (Plan 2's rung).
    assert.deepEqual(msg(base({ lastEvent: plan2, noChecksConfigured: true })), ['ok', plan2.code, plan2.params], plan2.code);
  }
  // A higher state keeps Plan 2's message (the hold rung is the degraded state's only).
  const hold = { ...nc, holdCode: notPortable, lastEvent: notPortable, diverged: { n: 2, oldestAgeS: 75 } };
  assert.deepEqual(msg(base({ ...hold, freeze: ['MASS'] })), ['frozen', 'FROZEN', { reasons: ['MASS'] }]);
  assert.deepEqual(msg(base({ ...hold, offline: { label: 'OFFLINE', explanation: 'network-or-auth', offlineForS: 42 } })),
    ['offline', 'OFFLINE', { label: 'OFFLINE', explanation: 'network-or-auth', offline_for_s: 42 }]);
  assert.deepEqual(msg(base({ ...hold, freeze: ['INCIDENT'], incident: { n: 1 } }))[1], 'INCIDENT');
  assert.deepEqual(msg(base({ ...hold, refused: { code: 'START_PREVIEW', params: {} } }))[1], 'START_PREVIEW');
  // A specific Plan 2 degraded condition outranks the generic not-converged one: its message stays.
  assert.deepEqual(msg(base({ ...hold, nonretryable: { holdId: 'X' } })), ['degraded', 'NONRETRYABLE', { hold_id: 'X' }]);
  assert.deepEqual(msg(base({ ...hold, version: { form: 'proto', cause: null } })), ['degraded', 'VERSION_PAUSED', { form: 'proto', cause: null }]);
  assert.equal(msg(base({ ...hold, notConvergedCause: 'push_unresolved' }))[1], 'NOT_CONVERGED');
  assert.deepEqual((computeStatus(base({ ...hold, notConvergedCause: 'fetch_owed' })).message_params as { cause: string }).cause, 'fetch_owed');
  // A degraded state with no not_converged entry (only a deferral older than 60 s) keeps DEFERRED.
  assert.deepEqual(msg(base({ pendingOlderThan60s: true, deferred: { reason: 'locked', paths: ['d.txt'] }, holdCode: notPortable, lastEvent: notPortable, diverged: { n: 2, oldestAgeS: 75 } })),
    ['degraded', 'DEFERRED', { reason: 'locked', paths: ['d.txt'] }]);
  // diverged.n = 0 is no divergence.
  assert.equal(msg(base({ ...nc, diverged: { n: 0, oldestAgeS: 0 } }))[1], 'NOT_CONVERGED');
});
