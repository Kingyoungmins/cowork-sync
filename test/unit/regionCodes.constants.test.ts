// Plan 4's one codes module (04 §3.19, 02 §2.1; R2-D01, R4-54, X-117, X-30, verify pass V-17).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAIM_REJECTED, REGION_CODES, REGION_LOG_ONLY_CODES, START_REGION_RUNTIME, type RegionCode, type RegionCodeParams,
} from '../../src/regions/codes.js';

/** Plan 7's L-CODES pattern. */
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,47}$/;

test('REGION_CODES and CLAIM_REJECTED are the 04 §3.19 and 02 §2.1 codes', () => {
  assert.deepEqual(REGION_CODES, [
    'REGION_BLOCK_ONLY', 'REGION_CONFLICT_MARKERS', 'REGION_SPEC_MISMATCH', 'REGION_WHOLE_FILE', 'REGION_BUDGET', 'CLAIM_OVERLAP',
    'REGION_GRAMMAR_UNAVAILABLE',
  ]);
  assert.equal(CLAIM_REJECTED, 'CLAIM_REJECTED');
  assert.equal(START_REGION_RUNTIME, 'START_REGION_RUNTIME');
  assert.deepEqual(REGION_LOG_ONLY_CODES, [
    'FOLD_OBJECT_MISSING', 'EDIT_CHECK_OVERRUN', 'REGION_OBJECT_MISSING', 'EDIT_CHECK_INPUT_MISMATCH', 'REGION_WORKER_RESPAWN',
    'REGION_RUNTIME_MISMATCH', 'CLAIM_BREACH_HIT',
  ]);
  assert.ok(Object.isFrozen(REGION_CODES));
  assert.ok(Object.isFrozen(REGION_LOG_ONLY_CODES));

  const all = [...REGION_CODES, CLAIM_REJECTED, START_REGION_RUNTIME, ...REGION_LOG_ONLY_CODES];
  assert.equal(all.length, 16);
  assert.equal(new Set(all).size, 16, 'no code is declared twice');
  for (const code of all) {
    assert.match(code, CODE_PATTERN, code);
    assert.ok(!code.includes('VIOLATION'), code);
  }

  // Type level (checked by tsc): REGION_BUDGET's budget is the closed enum; the reason enums are exact.
  const ok: RegionCodeParams['REGION_BUDGET'] = { path: 'a.py', budget: 'grep' };
  // @ts-expect-error 'disk' is not a region budget
  const bad: RegionCodeParams['REGION_BUDGET'] = { path: 'a.py', budget: 'disk' };
  assert.equal(ok.budget, 'grep');
  assert.equal(bad.path, 'a.py');
  type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
  const blockReason: Exact<RegionCodeParams['REGION_BLOCK_ONLY']['reason'], 'no_grammar' | 'not_utf8' | 'grammar_unavailable'> = true;
  const rejectReason: Exact<RegionCodeParams['CLAIM_REJECTED']['reason'], 'anchor' | 'base_blob' | 'ranges' | 'validator' | 'reservation'> = true;
  const codeKeys: Exact<keyof RegionCodeParams, RegionCode> = true;
  assert.ok(blockReason && rejectReason && codeKeys);
});

test('no params key names a byte, column or offset (INV-REG-COORD, SEC-38)', () => {
  // Every key of RegionCodeParams, spelled out once; tsc fails this table when the interface gains or loses a key.
  const keys: { readonly [C in RegionCode]: ReadonlyArray<keyof RegionCodeParams[C]> } = {
    REGION_BLOCK_ONLY: ['path', 'reason'],
    REGION_CONFLICT_MARKERS: ['path'],
    REGION_SPEC_MISMATCH: ['path', 'claim_id', 'peer'],
    REGION_WHOLE_FILE: ['path', 'claim_id'],
    REGION_BUDGET: ['path', 'budget'],
    CLAIM_OVERLAP: ['cs_id', 'claim_id', 'overlaps', 'path'],
    REGION_GRAMMAR_UNAVAILABLE: ['language'],
    CLAIM_REJECTED: ['claim_id', 'reason'],
  };
  type AllKeys<C extends RegionCode> = Exact2<keyof RegionCodeParams[C], (typeof keys)[C][number]>;
  type Exact2<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
  const complete: { [C in RegionCode]: AllKeys<C> } = {
    REGION_BLOCK_ONLY: true, REGION_CONFLICT_MARKERS: true, REGION_SPEC_MISMATCH: true, REGION_WHOLE_FILE: true,
    REGION_BUDGET: true, CLAIM_OVERLAP: true, REGION_GRAMMAR_UNAVAILABLE: true, CLAIM_REJECTED: true,
  };
  assert.ok(Object.values(complete).every((v) => v === true));
  assert.deepEqual(Object.keys(keys).sort(), [...REGION_CODES, CLAIM_REJECTED].sort());
  for (const [code, names] of Object.entries(keys)) {
    for (const name of names as readonly string[]) {
      assert.doesNotMatch(name, /byte|column|col$|offset|index|char|utf16/i, `${code}.${name}`);
    }
  }
});
