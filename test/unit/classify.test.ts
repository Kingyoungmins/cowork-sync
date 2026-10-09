import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPush,
  NONRETRYABLE_STREAK,
  type PushObservation,
  type PushOutcome,
} from '../../src/git/classify.js';

test('NONRETRYABLE_STREAK is 3 (glossary §26.2 item 2)', () => {
  assert.equal(NONRETRYABLE_STREAK, 3);
});

// Exhaustive table: ourOpIdsPresent x refMovedSinceLease x previousStreak 0..4.
const TABLE: Array<[ourOpIdsPresent: boolean, refMovedSinceLease: boolean, previousStreak: number, outcome: PushOutcome, streak: number]> = [
  [true, false, 0, 'landed', 0],
  [true, false, 1, 'landed', 0],
  [true, false, 2, 'landed', 0],
  [true, false, 3, 'landed', 0],
  [true, false, 4, 'landed', 0],
  [true, true, 0, 'landed', 0],
  [true, true, 1, 'landed', 0],
  [true, true, 2, 'landed', 0],
  [true, true, 3, 'landed', 0],
  [true, true, 4, 'landed', 0],
  [false, true, 0, 'lease_lost', 0],
  [false, true, 1, 'lease_lost', 0],
  [false, true, 2, 'lease_lost', 0],
  [false, true, 3, 'lease_lost', 0],
  [false, true, 4, 'lease_lost', 0],
  [false, false, 0, 'transient', 1],
  [false, false, 1, 'transient', 2],
  [false, false, 2, 'nonretryable', 3],
  [false, false, 3, 'nonretryable', 4],
  [false, false, 4, 'nonretryable', 5],
];

test('classifyPush follows the outcome table', () => {
  for (const [ourOpIdsPresent, refMovedSinceLease, previousStreak, outcome, streak] of TABLE) {
    const o: PushObservation = { refMovedSinceLease, ourOpIdsPresent, previousStreak };
    assert.deepEqual(classifyPush(o), { outcome, streak }, JSON.stringify(o));
  }
});

test('three consecutive unchanged-ref rejections of one publish become nonretryable', () => {
  let streak = 0;
  const seen: PushOutcome[] = [];
  for (let i = 0; i < 3; i++) {
    const r = classifyPush({ refMovedSinceLease: false, ourOpIdsPresent: false, previousStreak: streak });
    seen.push(r.outcome);
    streak = r.streak;
  }
  assert.deepEqual(seen, ['transient', 'transient', 'nonretryable']);
  assert.equal(streak, NONRETRYABLE_STREAK);
});

test('a lease loss or a landing between transients restarts the count', () => {
  let streak = 0;
  const steps: Array<[boolean, boolean]> = [
    [false, false], // transient 1
    [false, false], // transient 2
    [false, true], // lease lost -> 0
    [false, false], // transient 1
    [false, false], // transient 2
    [true, false], // landed -> 0
    [false, false], // transient 1
  ];
  const outcomes: PushOutcome[] = [];
  for (const [ourOpIdsPresent, refMovedSinceLease] of steps) {
    const r = classifyPush({ refMovedSinceLease, ourOpIdsPresent, previousStreak: streak });
    outcomes.push(r.outcome);
    streak = r.streak;
  }
  assert.deepEqual(outcomes, ['transient', 'transient', 'lease_lost', 'transient', 'transient', 'landed', 'transient']);
  assert.equal(streak, 1);
});

test('rejection text never changes the outcome', () => {
  const texts = [
    ' ! [remote rejected] refs/cowork/main/board -> refs/cowork/main/board (cannot lock ref)',
    ' ! [remote rejected] HEAD -> refs/cowork/main/board (failed)',
    'error: fatal error in commit_refs',
    'remote: error: GH013: Repository rule violations found',
    ' ! [rejected] (stale info)',
  ];
  for (const [ourOpIdsPresent, refMovedSinceLease, previousStreak, outcome, streak] of TABLE) {
    for (const stderr of texts) {
      const withText = { refMovedSinceLease, ourOpIdsPresent, previousStreak, stderr, message: stderr } as PushObservation;
      assert.deepEqual(classifyPush(withText), { outcome, streak });
    }
  }
});

test('classifyPush rejects a bad previousStreak with RangeError', () => {
  for (const previousStreak of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => classifyPush({ refMovedSinceLease: false, ourOpIdsPresent: false, previousStreak }),
      RangeError,
      String(previousStreak),
    );
  }
});

test('classifyPush rejects non-boolean flags with TypeError', () => {
  const bad = [
    { refMovedSinceLease: 'no', ourOpIdsPresent: false, previousStreak: 0 },
    { refMovedSinceLease: false, ourOpIdsPresent: undefined, previousStreak: 0 },
    { refMovedSinceLease: 0, ourOpIdsPresent: 1, previousStreak: 0 },
  ];
  for (const o of bad) {
    assert.throws(() => classifyPush(o as unknown as PushObservation), TypeError, JSON.stringify(o));
  }
});

test('classifyPush does not mutate its input', () => {
  const o: PushObservation = Object.freeze({ refMovedSinceLease: false, ourOpIdsPresent: false, previousStreak: 1 });
  assert.deepEqual(classifyPush(o), { outcome: 'transient', streak: 2 });
  assert.deepEqual(o, { refMovedSinceLease: false, ourOpIdsPresent: false, previousStreak: 1 });
});
