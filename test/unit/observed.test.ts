// ObservedWrites (Plan 3 Task 5; HLD-26 (b), R3-36): every Plan 3 writeLocal write is recorded by path and written blob, and a
// snapshot delta landing exactly on it is observed once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ABSENT, parseOid } from '../../src/git/oid.js';
import { ObservedWrites } from '../../src/holds/observed.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const X = parseOid('a'.repeat(40));
const Y = parseOid('b'.repeat(40));

test('ObservedWrites consumes a recorded write exactly once', T10, () => {
  const o = new ObservedWrites();
  o.record('a.txt', X);
  assert.equal(o.consume('a.txt', X), true, 'the recorded write is observed');
  assert.equal(o.consume('a.txt', X), false, 'and only once');
  assert.equal(o.consume('b.txt', X), false, 'another path is not the recorded write');
});

test('final review F1: consume is one-shot per path — a materialized delta that does not land on the recorded write ends the entry too', T10, () => {
  const o = new ObservedWrites();
  o.record('a.txt', X);
  assert.equal(o.consume('a.txt', Y), false, 'another blob is not the recorded write');
  assert.equal(o.peek('a.txt', X), false, 'and the entry is gone: the disk moved past the write');
  assert.equal(o.consume('a.txt', X), false, 'a later delta landing on the old write is not observed');
});

test('final review F1: forget drops the entry of a write the private index already holds (the park family, --discard, the DAT-08 repair)', T10, () => {
  const o = new ObservedWrites();
  o.record('a.txt', X);
  o.record('b.txt', Y);
  o.forget('a.txt');
  assert.equal(o.peek('a.txt', X), false, 'forgotten');
  assert.equal(o.consume('a.txt', X), false, 'a later delta landing on the forgotten write is unobserved');
  assert.equal(o.consume('b.txt', Y), true, 'another path keeps its entry');
  o.forget('never.txt');   // forgetting a path with no entry is a no-op
});

test('peek reads a recorded write without forgetting it; a deletion is recorded as ABSENT; a newer write replaces the older', T10, () => {
  const o = new ObservedWrites();
  o.record('a.txt', X);
  assert.equal(o.peek('a.txt', X), true);
  assert.equal(o.peek('a.txt', X), true, 'peek does not forget');
  assert.equal(o.peek('a.txt', Y), false);
  o.record('a.txt', Y);
  assert.equal(o.peek('a.txt', X), false, 'the newer write replaced the older');
  assert.equal(o.consume('a.txt', Y), true);
  o.record('gone.txt', ABSENT);
  assert.equal(o.peek('gone.txt', ABSENT), true, 'a deletion lands on ABSENT');
  assert.equal(o.peek('gone.txt', X), false);
  assert.equal(o.consume('gone.txt', ABSENT), true);
});
