// 05-holds Table 3, the 05 §2 guard argument grammar, {REASON} keys, the local_only causes and the whole-path test
// (Plan 3 Task 1; HLD-03, HLD-05, R3-09, R3-12).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { canonicalBytes, type Json } from '../../src/board/canonicalJson.js';
import type { ScopeClass } from '../../src/data/scope.js';
import { ABSENT, parseOid } from '../../src/git/oid.js';
import { HOLD_CODES } from '../../src/holds/codes.js';
import type { OfferEvent } from '../../src/holds/offers.js';
import {
  GUARD_TABLE, PLAN2_GUARD_CLASS, TERMINAL_STATES, guardArg, guardRow, hasWholePathGuard, isUnknownGuard, localOnlyCauses, makeGuard,
  parseRecord, reasonKey, type Guard, type GuardName, type HoldKind, type HoldRecord, type Plan2Guard, type ReasonKey,
} from '../../src/holds/record.js';
import { HoldRegistry } from '../../src/holds/registry.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;

const O = (c: string): ReturnType<typeof parseOid> => parseOid(c.repeat(40));
const PEER = '0123456789abcdef0123456789abcdef';
const ULID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ULID_B = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const ULID_C = '01ARZ3NDEKTSV4RRFFQ69G5FAX';
const CLAIM = 'abcdefghij234567';

/** A record over `paths` with the guards made from `full` names (unknown names planted verbatim as DECISION). */
function rec(full: readonly string[], o: { id?: string; kind?: HoldKind; local_only?: boolean; paths?: string[] } = {}): HoldRecord {
  const paths = o.paths ?? ['src/a.ts'];
  const h: Record<string, ReturnType<typeof parseOid>> = {};
  for (const p of paths) h[p] = O('1');
  const guards: Guard[] = full.map((g) => (guardRow(g) === null ? { name: g, class: 'DECISION', owner: 'XYZ' } : makeGuard(g)));
  return {
    id: o.id ?? ULID_A, rev: 1, owner: PEER, kind: o.kind ?? 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', offer: 'none',
    declines: 0, displaced_by: null, paths, blobs: { h0: { ...h }, h1: { ...h } }, guards, origin: 'human',
    cs_ids: [], peer_authors: [], local_only: o.local_only ?? false, age_anchor: { since_rev: 1, anchor_wall_ms: 0, mono_accum_ms: 0 }, proto: 1,
  };
}

const ROWS: ReadonlyArray<readonly [string, 'P' | 'D', string, ReasonKey, boolean, boolean, boolean]> = [
  ['claim', 'P', 'HLD/REG', 'answer', false, false, true],
  ['dependency', 'P', 'HLD', 'bundle', false, false, true],
  ['t0', 'P', 'HLD/REG', 'checks', false, false, false],
  ['unreadable', 'P', 'HLD/ENG', 'unstable', false, false, false],
  ['unstable', 'P', 'HLD/ENG', 'unstable', false, false, false],
  ['lock', 'P', 'HLD/ENG', 'incoming', false, false, false],
  ['unmaterializable', 'P', 'DAT', 'incoming', false, false, false],
  ['eol-bom', 'P', 'DAT', 'form', true, false, false],
  ['eol-form', 'P', 'DAT', 'form', false, false, false],
  ['markers', 'P', 'DAT/HLD', 'markers', true, false, false],
  ['local-only-conflict', 'P', 'HLD', 'incoming', false, false, false],
  ['filter-failure', 'D', 'DAT/SEC', 'local', false, true, false],
  ['secret-scan', 'D', 'SEC (local human, glossary \u{00a7}16)', 'local', false, true, false],
  ['revert', 'D', 'HLD', 'revert', false, true, false],
  ['conflict', 'D', 'DAT', 'conflict', false, true, false],
  ['claim-breach', 'D', 'DAT/COO', 'conflict', false, true, false],
  ['base-move', 'D', 'ENG', 'git', false, false, false],
  ['join', 'D', 'LIF', 'user', false, true, false],
  ['restart', 'D', 'ENG', 'git', false, true, false],
  ['phantom', 'D', 'ENG', 'user', false, true, false],
  ['host-reject', 'D', 'ENG', 'user', false, false, false],
  ['portability', 'D', 'DAT', 'user', true, false, false],
  ['generated?', 'D', 'DAT', 'user', true, true, true],
  ['collision', 'D', 'DAT', 'user', false, true, true],
  ['quarantine-review', 'D', 'SEC (local human)', 'user', false, false, false],
  ['wake-scope', 'D', 'local human', 'wake-scope', false, true, false],
];

/** A guard name of `full` with no required argument (claim and dependency get valid ones). */
function full(name: string): string {
  if (name === 'claim') return `claim:${CLAIM}`;
  if (name === 'dependency') return `dependency:${ULID_C}`;
  return name;
}

test('GUARD_TABLE is 05-holds Table 3 in row order with class, owner, key and flags', T10, () => {
  assert.equal(GUARD_TABLE.length, 26);
  assert.deepEqual(
    GUARD_TABLE.map((r) => [r.name, r.cls === 'PREDICATE' ? 'P' : 'D', r.owner, r.key, r.wholePath, r.humanRelease, r.takesArg]),
    ROWS.map((r) => [...r]),
  );
  assert.ok(Object.isFrozen(GUARD_TABLE) && GUARD_TABLE.every((r) => Object.isFrozen(r)));
});

test('Plan2Guard and PLAN2_GUARD_CLASS are views of GUARD_TABLE', T10, () => {
  const plan2: Plan2Guard[] = ['conflict', 'restart', 'phantom', 'host-reject', 'eol-bom', 'join'];
  assert.deepEqual(Object.keys(PLAN2_GUARD_CLASS).sort(), [...plan2].sort());
  for (const g of plan2) {
    const row = guardRow(g)!;
    assert.equal(PLAN2_GUARD_CLASS[g], row.cls);
    assert.equal(PLAN2_GUARD_CLASS[g], g === 'eol-bom' ? 'PREDICATE' : 'DECISION');
    assert.equal(makeGuard(g).owner, { conflict: 'DAT', 'eol-bom': 'DAT', restart: 'ENG', phantom: 'ENG', 'host-reject': 'ENG', join: 'LIF' }[g]);
  }
  const plan2IsGuardName: Equals<Plan2Guard extends GuardName ? true : false, true> = true;
  assert.ok(plan2IsGuardName);
});

test('makeGuard applies the 05 §2 argument grammar', T10, () => {
  for (const ok of [`dependency:${ULID_A}`, `claim:${CLAIM}`, 'generated?', 'generated?:exclude', 'collision', 'collision:keep', 'lock']) {
    const g = makeGuard(ok);
    const row = guardRow(ok)!;
    assert.deepEqual(g, { name: ok, class: row.cls, owner: row.owner }, ok);
  }
  for (const bad of ['dependency', 'dependency:x', 'claim:ABCDEFGHIJ234567', 'generated?:keep', 'collision:take', 'markers:1', 'lock:x', 'snapshot', 'transform', '']) {
    assert.throws(() => makeGuard(bad), TypeError, JSON.stringify(bad));
  }
  assert.equal(guardArg(makeGuard('generated?:exclude')), 'exclude');
  assert.equal(guardArg(makeGuard('collision:keep')), 'keep');
  assert.equal(guardArg(makeGuard(`dependency:${ULID_A}`)), ULID_A);
  assert.equal(guardArg(makeGuard('lock')), null);
  assert.equal(makeGuard('lock').class, 'PREDICATE');
  assert.equal(makeGuard('revert').owner, 'HLD');
});

test('a guard name outside Table 3 loads and is unknown', T10, () => {
  const r = rec(['frobnicate']);
  assert.deepEqual(r.guards, [{ name: 'frobnicate', class: 'DECISION', owner: 'XYZ' }]);
  const back = parseRecord(canonicalBytes(r as unknown as Json));
  assert.deepEqual(back.guards, r.guards);
  assert.equal(guardRow('frobnicate'), null);
  assert.equal(isUnknownGuard(back.guards[0]!), true);
  assert.equal(isUnknownGuard(makeGuard('revert')), false);
  assert.throws(() => makeGuard('frobnicate'), TypeError);
});

test('reasonKey follows 05 §2', T10, () => {
  const none = (): undefined => undefined;
  assert.equal(reasonKey(rec(['revert'], { local_only: true }), none), 'local');
  assert.equal(reasonKey(rec(['lock', 'revert']), none), 'revert');
  assert.equal(reasonKey(rec(['conflict', 'revert']), none), 'revert', 'row 14 precedes row 15; record order ignored');
  assert.equal(reasonKey(rec(['markers', 'eol-bom']), none), 'form', 'row 8 before row 10');
  const claimPin = rec([`claim:${CLAIM}`], { id: ULID_B, kind: 'PIN' });
  const shadow = rec([`claim:${CLAIM}`], { id: ULID_B, kind: 'PATCH' });
  const revertPatch = rec(['revert'], { id: ULID_B });
  const dep = rec([`dependency:${ULID_B}`]);
  assert.equal(reasonKey(dep, (id) => (id === ULID_B ? claimPin : undefined)), 'answer');
  assert.equal(reasonKey(dep, (id) => (id === ULID_B ? shadow : undefined)), 'answer');
  assert.equal(reasonKey(dep, (id) => (id === ULID_B ? revertPatch : undefined)), 'bundle');
  assert.equal(reasonKey(dep, none), 'bundle');
  assert.equal(reasonKey(rec([]), none), null);
  assert.equal(reasonKey(rec(['frobnicate']), none), 'user', 'unknown names rank after every Table 3 row');
  assert.equal(reasonKey(rec(['frobnicate', 'conflict']), none), 'conflict');

  const names = GUARD_TABLE.map((r) => r.name);
  fc.assert(
    fc.property(fc.subarray(names, { minLength: 1 }), fc.boolean(), (subset, reversed) => {
      const order = reversed ? [...subset].reverse() : subset;
      const r = rec(order.map(full));
      const idx = subset.map((n) => names.indexOf(n));
      const decision = idx.filter((i) => GUARD_TABLE[i]!.cls === 'DECISION');
      const pick = decision.length > 0 ? Math.min(...decision) : Math.min(...idx);
      assert.equal(reasonKey(r, none), GUARD_TABLE[pick]!.key);
    }),
    { numRuns: 500 },
  );
});

test('localOnlyCauses recognises every HLD-03 cause', T10, () => {
  const live = (): ScopeClass => 'LIVE';
  const no = (): boolean => false;
  const r = (paths: string[], guards: string[] = []): Pick<HoldRecord, 'paths' | 'guards'> => ({ paths, guards: guards.map((g) => makeGuard(g)) });
  assert.deepEqual(localOnlyCauses(r(['.env']), live, false, no), ['secret-like']);
  assert.deepEqual(localOnlyCauses(r(['config/secrets.yml']), live, false, no), ['secret-like']);
  assert.deepEqual(localOnlyCauses(r(['src/a.ts'], ['filter-failure']), live, false, no), ['filter-failure']);
  assert.deepEqual(localOnlyCauses(r(['src/a.ts'], ['secret-scan']), live, false, no), ['secret-scan']);
  const cls = (m: Record<string, ScopeClass>) => (p: string): ScopeClass => m[p] ?? 'LIVE';
  assert.deepEqual(localOnlyCauses(r(['.github/workflows/ci.yml']), cls({ '.github/workflows/ci.yml': 'QUARANTINED' }), false, no), ['not-live']);
  assert.deepEqual(localOnlyCauses(r(['.gitignore']), cls({ '.gitignore': 'SAVE_ONLY' }), false, no), ['not-live']);
  // Row 9 (LOCAL_ONLY) only through this record: its own effect, LIVE for the cause; through another record's secret-scan: not live.
  const own = cls({ 'src/k.txt': 'LOCAL_ONLY' });
  assert.deepEqual(localOnlyCauses(r(['src/k.txt'], ['revert']), own, false, no), []);
  assert.deepEqual(localOnlyCauses(r(['src/k.txt'], ['revert']), own, false, (p) => p === 'src/k.txt'), ['not-live']);
  assert.deepEqual(localOnlyCauses(r(['src/a.ts']), live, true, no), ['marker-companion']);
  assert.deepEqual(localOnlyCauses(r(['src/a.ts']), live, false, no), []);
  assert.deepEqual(localOnlyCauses(r(['.env', 'src/a.ts']), live, false, no), ['secret-like']);
});

test('localOnlyCauses: a record carrying `portability` is not-live whatever the D5 scope answers, until the guard is released (final review F3)', T10, () => {
  // DAT-33 / D6 rule 2.6: the name is NOT_ADMITTED while D7 fails, and the guard holds exactly that long; the registry's scope is D5
  // (scopeOfTracked, no D7 row), which classes the stageable name LIVE once its attributes were requested (ensureRecordAttrs).
  const live = (): ScopeClass => 'LIVE';
  const no = (): boolean => false;
  const r = (paths: string[], guards: string[] = []): Pick<HoldRecord, 'paths' | 'guards'> => ({ paths, guards: guards.map((g) => makeGuard(g)) });
  assert.deepEqual(localOnlyCauses(r(['con.py'], ['portability']), live, false, no), ['not-live']);
  assert.deepEqual(localOnlyCauses(r(['readme.md'], ['portability']), live, false, no), ['not-live']);
  // One 'not-live' cause, also when a path's scope class is not LIVE either; causes stay in declaration order.
  assert.deepEqual(localOnlyCauses(r(['.gitignore'], ['portability']), (): ScopeClass => 'SAVE_ONLY', false, no), ['not-live']);
  assert.deepEqual(localOnlyCauses(r(['.env'], ['portability']), live, false, no), ['secret-like', 'not-live']);
  // The rev of the release (D7 passed: the guard is gone) recomputes from the LIVE scope: not local_only (R3-17, portability.test.ts).
  assert.deepEqual(localOnlyCauses(r(['readme.md']), live, false, no), []);
});

test('localOnlyCauses fails closed: a path the scope cannot classify is not-live (R3-71)', T10, () => {
  const no = (): boolean => false;
  const boom = (p: string): ScopeClass => {
    throw new Error(`attributes of ${JSON.stringify(p)} were not requested this iteration`);
  };
  assert.deepEqual(localOnlyCauses({ paths: ['src/a.ts'], guards: [makeGuard('revert')] }, boom, false, no), ['not-live']);
  // One unclassifiable path of several is enough; the other causes are still listed.
  const one = (p: string): ScopeClass => (p === 'src/b.ts' ? boom(p) : 'LIVE');
  assert.deepEqual(localOnlyCauses({ paths: ['src/a.ts', 'src/b.ts'], guards: [] }, one, false, no), ['not-live']);
  assert.deepEqual(localOnlyCauses({ paths: ['.env', 'src/b.ts'], guards: [makeGuard('secret-scan')] }, one, true, no), ['secret-scan', 'secret-like', 'not-live', 'marker-companion']);
});

test('hasWholePathGuard: eol-bom, generated?, generated?:exclude, portability, markers and every guard of a local_only record', T10, () => {
  for (const g of ['eol-bom', 'generated?', 'generated?:exclude', 'portability', 'markers']) assert.equal(hasWholePathGuard(rec([g])), true, g);
  for (const g of ['revert', 'conflict', `dependency:${ULID_B}`]) assert.equal(hasWholePathGuard(rec([g])), false, g);
  assert.equal(hasWholePathGuard(rec(['revert'], { local_only: true })), true);
  assert.equal(hasWholePathGuard(rec([])), false);
});

test('TERMINAL_STATES is HOLDS_ONLY_TERMINAL', T10, () => {
  assert.deepEqual([...TERMINAL_STATES].sort(), ['GONE', 'RESOLVED_DISCARD', 'RESOLVED_PUBLISH', 'SUBSUMED']);
});

test('nothing of the 05 §1 deferred list exists', T10, () => {
  const kinds: Equals<HoldKind, 'PATCH' | 'PIN' | 'INCOMING'> = true;
  const noOverride: Equals<Extract<GuardName, 'override' | 'adopt' | 'snapshot' | 'transform'>, never> = true;
  const noCycle: Equals<Extract<OfferEvent, 'cycle' | 'fork' | 'cycle_detected'>, never> = true;
  assert.ok(kinds && noOverride && noCycle);
  for (const m of ['adopt', 'override', 'export', 'fork']) assert.equal(m in HoldRegistry.prototype, false, m);
  assert.equal(HOLD_CODES.includes('HOLD_NOT_DURABLE'), false);
  assert.equal(GUARD_TABLE.some((r) => ['snapshot', 'transform', 'override', 'adopt'].includes(r.name)), false);
  assert.equal(ABSENT, 'ABSENT');
});
