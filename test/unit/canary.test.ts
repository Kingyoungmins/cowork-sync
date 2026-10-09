import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canary } from '../sim/peers.js';

test('canary(runId) is exactly COWORK_CANARY_<runId>', () => {
  assert.equal(canary('r1'), 'COWORK_CANARY_r1');
  assert.equal(canary('3f9a0c1b2d4e'), 'COWORK_CANARY_3f9a0c1b2d4e');
  assert.equal(canary('seed-7_A'), 'COWORK_CANARY_seed-7_A');
});

test('different run ids give different canaries; the same run id gives the same one', () => {
  assert.notEqual(canary('run1'), canary('run2'));
  assert.equal(canary('run1'), canary('run1'));
});

test('canary refuses a run id that is not a plain token', () => {
  for (const bad of ['', 'a b', "a'b", 'a"b', 'a\rb', 'a\nb', 'a/b', '한글', 'a%b']) {
    assert.throws(() => canary(bad), /bad run id/, JSON.stringify(bad));
  }
});
