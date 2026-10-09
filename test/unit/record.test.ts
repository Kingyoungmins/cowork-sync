import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalBytes, type Json } from '../../src/board/canonicalJson.js';
import { ABSENT, parseOid } from '../../src/git/oid.js';
import {
  PLAN2_GUARD_CLASS, TERMINAL_STATES, WHOLE_PATH_GUARDS, heldSide, isTerminal, parseRecord, serializeRecord,
  type HoldRecord, type HoldState, type Plan2Guard,
} from '../../src/holds/record.js';

const O = (c: string): ReturnType<typeof parseOid> => parseOid(c.repeat(40));
const PEER = '0123456789abcdef0123456789abcdef';
const ID = '01J9ZQ3V5W6X7Y8Z9A0B1C2D3E';
const HANGUL = 'docs/\u{D55C}.md';

/** A K4 stage record (R-02): every glossary §9 field with a non-trivial value, one ABSENT side. */
function stageRecord(): HoldRecord {
  return {
    id: ID, rev: 3, owner: PEER,
    kind: 'PATCH', residence: 'ON_DISK', state: 'CONFLICTED', offer: 'none',
    declines: 0, displaced_by: `${PEER}/fedcba9876543210fedcba9876543210/17`,
    paths: [HANGUL, 'src/a.txt'].sort(),
    blobs: {
      s1: { [HANGUL]: O('1'), 'src/a.txt': O('2') },
      s2: { [HANGUL]: O('3'), 'src/a.txt': ABSENT },
      s3: { [HANGUL]: O('4'), 'src/a.txt': O('5') },
    },
    guards: [{ name: 'conflict', class: 'DECISION', owner: 'DAT' }],
    origin: 'human', cs_ids: [`${PEER}/human/4`], peer_authors: ['fedcba9876543210fedcba9876543210'], local_only: false,
    age_anchor: { since_rev: 1, anchor_wall_ms: 1_767_225_600_000, mono_accum_ms: 1250 }, proto: 1,
  };
}

/** An eol-bom PATCH (h0/h1). */
function patchRecord(): HoldRecord {
  return {
    ...stageRecord(), id: '01J9ZQ3V5W6X7Y8Z9A0B1C2D3F', rev: 1, state: 'ACTIVE', displaced_by: null, paths: ['settings.ini'],
    blobs: { h0: { 'settings.ini': O('6') }, h1: { 'settings.ini': O('7') } },
    guards: [{ name: 'eol-bom', class: 'PREDICATE', owner: 'DAT' }], cs_ids: [], peer_authors: [],
  };
}

const SCHEMA_KEYS = [
  'id', 'rev', 'owner', 'kind', 'residence', 'state', 'offer', 'declines', 'displaced_by', 'paths', 'blobs', 'guards',
  'origin', 'cs_ids', 'peer_authors', 'local_only', 'age_anchor', 'proto',
].sort();

test('records round-trip the glossary §9 schema; ABSENT sides serialize as "ABSENT"', () => {
  for (const r of [stageRecord(), patchRecord()]) {
    const buf = serializeRecord(r);
    assert.ok(buf.equals(canonicalBytes(r as unknown as Json)), 'serializeRecord is canonical JSON');
    assert.deepEqual(parseRecord(buf), r);
    const obj = JSON.parse(buf.toString('utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(obj).sort(), SCHEMA_KEYS, 'exactly the glossary §9 keys');
    assert.deepEqual(Object.keys(obj['age_anchor'] as object).sort(), ['anchor_wall_ms', 'mono_accum_ms', 'since_rev']);
  }
  const text = serializeRecord(stageRecord()).toString('utf8');
  assert.ok(text.includes('"src/a.txt":"ABSENT"'), 'an ABSENT side is the string "ABSENT"');
  assert.ok(text.includes('docs/\u{D55C}.md'), 'paths are UTF-8, not escaped');

  // heldSide: h1 for an h0/h1 record, s2 for a stage record.
  assert.deepEqual(heldSide(patchRecord()), { 'settings.ini': O('7') });
  assert.deepEqual(heldSide(stageRecord()), { [HANGUL]: O('3'), 'src/a.txt': ABSENT });

  // Terminal states carry no residence.
  assert.deepEqual([...TERMINAL_STATES].sort(), ['GONE', 'RESOLVED_DISCARD', 'RESOLVED_PUBLISH', 'SUBSUMED']);
  const gone: HoldRecord = { ...patchRecord(), residence: null, state: 'GONE' };
  assert.equal(isTerminal(gone), true);
  assert.deepEqual(parseRecord(serializeRecord(gone)), gone);
  assert.equal(isTerminal(stageRecord()), false);
  // OFF_DISK records (Table 1): PARKED and CONFLICTED.
  for (const state of ['PARKED', 'CONFLICTED'] as HoldState[]) {
    const r: HoldRecord = { ...stageRecord(), residence: 'OFF_DISK', state };
    assert.deepEqual(parseRecord(serializeRecord(r)), r);
  }
  // The ring late-write PATCH (R-03 (iii)): OFF_DISK PARKED with no guard.
  const late: HoldRecord = { ...patchRecord(), residence: 'OFF_DISK', state: 'PARKED', guards: [], origin: 'daemon' };
  assert.deepEqual(parseRecord(serializeRecord(late)), late);
  // An unknown guard name parses (HLD-05: a DECISION guard this daemon never releases).
  const unknown: HoldRecord = { ...patchRecord(), guards: [{ name: 'dependency:01J9ZQ3V5W6X7Y8Z9A0B1C2D3E', class: 'PREDICATE', owner: 'HLD' }] };
  assert.deepEqual(parseRecord(serializeRecord(unknown)), unknown);
});

test('records outside the schema are refused on both sides', () => {
  const bad: Array<[string, HoldRecord]> = [
    ['ON_DISK PARKED (Table 1)', { ...stageRecord(), state: 'PARKED' }],
    ['OFF_DISK ACTIVE (Table 1)', { ...stageRecord(), residence: 'OFF_DISK', state: 'ACTIVE' }],
    ['a terminal state with a residence', { ...stageRecord(), state: 'SUBSUMED' }],
    ['a live state without a residence', { ...stageRecord(), residence: null }],
    ['unsorted paths', { ...stageRecord(), paths: ['src/a.txt', HANGUL] }],
    ['an invalid path', { ...patchRecord(), paths: ['../x'], blobs: { h0: { '../x': O('6') }, h1: { '../x': O('7') } } }],
    ['a blob map key outside paths', { ...patchRecord(), blobs: { h0: { 'settings.ini': O('6'), 'other.txt': O('6') }, h1: { 'settings.ini': O('7') } } }],
    ['a blob map missing a path', { ...patchRecord(), blobs: { h0: {}, h1: { 'settings.ini': O('7') } } }],
    ['a short oid', { ...patchRecord(), blobs: { h0: { 'settings.ini': 'abc' as never }, h1: { 'settings.ini': O('7') } } }],
    ['a non-ULID id', { ...stageRecord(), id: 'not-a-ulid' }],
    ['rev 0', { ...stageRecord(), rev: 0 }],
    ['an unknown kind', { ...stageRecord(), kind: 'SHADOW' as never }],
    ['an invalid cs id', { ...stageRecord(), cs_ids: ['x/human/1'] }],
    ['proto 2', { ...stageRecord(), proto: 2 as never }],
    ['an empty path list', { ...patchRecord(), paths: [], blobs: { h0: {}, h1: {} } }],
  ];
  for (const [what, r] of bad) {
    assert.throws(() => serializeRecord(r), TypeError, `serialize: ${what}`);
    assert.throws(() => parseRecord(canonicalBytes(r as unknown as Json)), TypeError, `parse: ${what}`);
  }
  const ok = serializeRecord(patchRecord());
  assert.throws(() => parseRecord(Buffer.from(JSON.stringify(patchRecord(), null, 2), 'utf8')), TypeError, 'non-canonical bytes');
  assert.throws(() => parseRecord(Buffer.concat([ok, Buffer.from('\n')])), TypeError, 'a trailing newline is not canonical');
  assert.throws(() => parseRecord(Buffer.from('{', 'utf8')), TypeError, 'not JSON');
  const extra = { ...(JSON.parse(ok.toString('utf8')) as object), extra: 1 };
  assert.throws(() => parseRecord(canonicalBytes(extra as Json)), TypeError, 'an extra key');
});

test('a host-reject PIN of a board-only publish has no path (05-holds F6: one PIN per NONRETRYABLE); every other record needs one', () => {
  const hostReject: HoldRecord = {
    ...patchRecord(), kind: 'PIN', paths: [], blobs: { h0: {}, h1: {} }, origin: 'daemon',
    guards: [{ name: 'host-reject', class: 'DECISION', owner: 'ENG' }],
  };
  assert.deepEqual(parseRecord(serializeRecord(hostReject)), hostReject);
  const bad: Array<[string, HoldRecord]> = [
    ['a pathless PIN with another guard', { ...hostReject, guards: [{ name: 'join', class: 'DECISION', owner: 'LIF' }] }],
    ['a pathless host-reject PATCH', { ...hostReject, kind: 'PATCH' }],
    ['a pathless host-reject stage record', { ...hostReject, blobs: { s1: {}, s2: {}, s3: {} } }],
    ['a pathless PIN with no guard', { ...hostReject, guards: [] }],
  ];
  for (const [what, r] of bad) {
    assert.throws(() => serializeRecord(r), TypeError, `serialize: ${what}`);
    assert.throws(() => parseRecord(canonicalBytes(r as unknown as Json)), TypeError, `parse: ${what}`);
  }
});

test('PLAN2_GUARD_CLASS matches 05-holds Table 3', () => {
  // Table 3: eol-bom is a PREDICATE guard (DAT); conflict (DAT), restart, phantom, host-reject (ENG) and join (LIF) are DECISION guards.
  const table3: Record<Plan2Guard, 'PREDICATE' | 'DECISION'> = {
    conflict: 'DECISION', restart: 'DECISION', phantom: 'DECISION', 'host-reject': 'DECISION', 'eol-bom': 'PREDICATE', join: 'DECISION',
  };
  assert.deepEqual({ ...PLAN2_GUARD_CLASS }, table3);
  assert.deepEqual(Object.keys(PLAN2_GUARD_CLASS).sort(), ['conflict', 'eol-bom', 'host-reject', 'join', 'phantom', 'restart']);
  assert.ok(Object.isFrozen(PLAN2_GUARD_CLASS));
  // 05-holds §2 "whole-path guard": eol-bom, generated?, portability, markers.
  assert.deepEqual([...WHOLE_PATH_GUARDS].sort(), ['eol-bom', 'generated?', 'markers', 'portability']);
});
