// The typed `hold` op (Plan 3 Task 3): glossary §7 fields parsed field by field (F1, PRO-05, PRO-21, R3-11, R3-24),
// its unions pinned equal to record.ts's (src/board imports nothing from src/holds, so the pin lives here), the
// PLAN2_FOLDED_TYPES move (F4), the 16 KiB line cap (PRO-06) and isHoldCreation (F9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BoardDraft, WriterId } from '../../src/board/boardCommit.js';
import { canonicalJson, type Json } from '../../src/board/canonicalJson.js';
import { foldCommit, initialFoldState, type FoldedHold } from '../../src/board/fold.js';
import {
  BoardCapError,
  HOLD_OP_KINDS,
  HOLD_OP_OFFERS,
  HOLD_OP_RESIDENCES,
  HOLD_OP_STATES,
  isHoldCreation,
  OP_MAX_LINE_BYTES,
  parseOpLine,
  PLAN2_FOLDED_TYPES,
  serializeOps,
  type HoldOp,
  type HoldOpGuard,
  type Op,
  type OpaqueOp,
  type OpDraft,
} from '../../src/board/ops.js';
import { genesisProtocol } from '../../src/board/protocol.js';
import type { Oid } from '../../src/git/oid.js';
import { GUARD_TABLE, serializeRecord, type Guard, type HoldKind, type HoldRecord, type HoldState, type Offer, type Residence } from '../../src/holds/record.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

/** Exact type equality (both directions). */
type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;

const PEER = '0123456789abcdef0123456789abcdef';
const EPOCH = 'fedcba9876543210fedcba9876543210';
const HOLD_ID = '01J9ZQ3C5X0000000000000000';
const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);
const id = (seq: number): string => `${PEER}/${EPOCH}/${seq}`;
const line = (v: Record<string, unknown>): string => canonicalJson(v as Json);

const GUARDS: Json = [
  { name: 'conflict', class: 'DECISION', owner: 'DAT' },
  { name: 'frobnicate', class: 'PREDICATE', owner: 'a later plan' },
];

/** A hold op with every glossary §7 field (rev 2 of a CONFLICTED PATCH); `o` overrides fields. */
function holdObj(o: Record<string, Json> = {}): Record<string, Json> {
  return {
    id: id(13), type: 'hold', hold_id: HOLD_ID, rev: 2, prev_rev: 1, kind: 'PATCH', residence: 'ON_DISK', state: 'CONFLICTED', offer: 'none',
    guards: GUARDS, paths: ['docs/b.md', 'src/a.ts'], origin: 'human', cs_ids: [`${PEER}/human/2`, `${PEER}/human/1`], peer_authors: [PEER],
    local_only: false, ...o,
  };
}

const HOLD_OP_KEYS = ['cs_ids', 'guards', 'hold_id', 'id', 'kind', 'local_only', 'offer', 'origin', 'paths', 'peer_authors', 'prev_rev', 'residence', 'rev', 'state', 'type'];

/** A valid record (an ACTIVE PATCH on a.txt): the template the record-schema probes edit. */
const RECORD_BASE: HoldRecord = {
  id: HOLD_ID, rev: 1, owner: PEER, kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', offer: 'none', declines: 0, displaced_by: null,
  paths: ['a.txt'], blobs: { h0: { 'a.txt': OID_A as Oid }, h1: { 'a.txt': OID_B as Oid } }, guards: [{ name: 'conflict', class: 'DECISION', owner: 'DAT' }],
  origin: 'human', cs_ids: [], peer_authors: [], local_only: false, age_anchor: { since_rev: 1, anchor_wall_ms: 0, mono_accum_ms: 0 }, proto: 1,
};
/** Whether record.ts's schema (serializeRecord) accepts r. */
function accepts(r: unknown): boolean {
  try {
    serializeRecord(r as HoldRecord);
    return true;
  } catch {
    return false;
  }
}

test('parseOpLine types a hold op with exactly the glossary §7 fields', T10, () => {
  const extras: Record<string, Json> = {
    blobs: { h0: { 'docs/b.md': OID_A, 'src/a.ts': 'ABSENT' }, h1: { 'docs/b.md': OID_B, 'src/a.ts': OID_A } },
    owner: PEER, declines: 2, displaced_by: id(9), age_anchor: { since_rev: 1, anchor_wall_ms: 1_700_000_000_000, mono_accum_ms: 5 }, text: 'smuggled note',
  };
  const op = parseOpLine(line(holdObj(extras)));
  assert.ok(op !== null, 'a hold line with extra fields parses');
  assert.equal(op.type, 'hold');
  assert.deepEqual(Object.keys(op).sort(), HOLD_OP_KEYS, 'exactly the glossary §7 fields, plus id and type');
  assert.deepEqual(op, holdObj());
  // guards are the record's {name, class, owner} objects verbatim, an unknown name included (HLD-05, R3-24).
  const h = op as HoldOp;
  assert.deepEqual(h.guards, GUARDS);
  assert.ok(h.guards.some((g) => g.name === 'frobnicate'));
  // Re-serialized, the op is the canonical line of the §7 fields alone.
  assert.equal(canonicalJson(op as unknown as Json), line(holdObj()));
  // A guard's own extra key is dropped too: the op keeps {name, class, owner}.
  const g2 = parseOpLine(line(holdObj({ guards: [{ name: 'revert', class: 'DECISION', owner: 'HLD', note: 'x' }] })));
  assert.ok(g2 !== null);
  assert.deepEqual((g2 as HoldOp).guards, [{ name: 'revert', class: 'DECISION', owner: 'HLD' }]);
  // Every value set of the record schema parses: kinds, states (with a matching residence), offers, a create (prev_rev null).
  for (const kind of ['PATCH', 'PIN', 'INCOMING']) assert.notEqual(parseOpLine(line(holdObj({ kind }))), null, kind);
  for (const [state, residence] of [['ACTIVE', 'ON_DISK'], ['PARKED', 'OFF_DISK'], ['SUBSUMED', null], ['GONE', null], ['RESOLVED_PUBLISH', null], ['RESOLVED_DISCARD', null]] as const) {
    assert.notEqual(parseOpLine(line(holdObj({ state, residence }))), null, state);
  }
  for (const offer of ['none', 'pending_leftover', 'offered', 'accepted', 'returned']) assert.notEqual(parseOpLine(line(holdObj({ offer }))), null, offer);
  assert.equal((parseOpLine(line(holdObj({ rev: 1, prev_rev: null }))) as HoldOp | null)?.prev_rev, null);
  assert.equal((parseOpLine(line(holdObj({ local_only: true }))) as HoldOp | null)?.local_only, true);
});

test('parseOpLine refuses a hold op with a malformed field', T10, () => {
  const bad: Array<[string, Record<string, Json>]> = [
    ['hold_id not a ULID', { hold_id: 'x' }],
    ['rev 0', { rev: 0 }],
    ['rev fractional', { rev: 1.5 }],
    ['prev_rev equal to rev', { rev: 2, prev_rev: 2 }],
    ['prev_rev above rev', { rev: 2, prev_rev: 3 }],
    ['prev_rev a string', { prev_rev: 'a' }],
    ['prev_rev 0', { rev: 2, prev_rev: 0 }],
    ['kind SNAPSHOT', { kind: 'SNAPSHOT' }],
    ['residence IN_RAM', { residence: 'IN_RAM' }],
    ['state WIP', { state: 'WIP' }],
    ['offer maybe', { offer: 'maybe' }],
    ['paths unsorted', { paths: ['b.txt', 'a.txt'] }],
    ['paths repeated', { paths: ['a.txt', 'a.txt'] }],
    ['path with a colon', { paths: ['docs/12:30-notes.md'] }],
    ['path not a string', { paths: [1] }],
    ['cs_ids malformed', { cs_ids: ['cs-1'] }],
    // A full-length (32-character) peer id in upper case: the only thing wrong with it is the case.
    ['peer_authors upper case', { peer_authors: [PEER.toUpperCase()] }],
    ['guard class MAYBE', { guards: [{ name: 'conflict', class: 'MAYBE', owner: 'DAT' }] }],
    ['guard with an empty name', { guards: [{ name: '', class: 'DECISION', owner: 'DAT' }] }],
    ['guard without an owner', { guards: [{ name: 'conflict', class: 'DECISION' }] }],
    ['guard a string', { guards: ['conflict'] }],
    ['guards not an array', { guards: { name: 'conflict' } }],
    ['local_only a string', { local_only: 'yes' }],
    ['origin empty', { origin: '' }],
  ];
  for (const [what, o] of bad) assert.equal(parseOpLine(line(holdObj(o))), null, what);
  // A missing §7 field is malformed too.
  for (const k of HOLD_OP_KEYS.filter((x) => x !== 'id' && x !== 'type')) {
    const o = holdObj();
    delete o[k];
    assert.equal(parseOpLine(line(o)), null, `without ${k}`);
  }
  // Boundary values of the same fields still parse.
  assert.notEqual(parseOpLine(line(holdObj({ rev: 9, prev_rev: 1 }))), null, 'a rev gap');
  assert.notEqual(parseOpLine(line(holdObj({ paths: ['a.txt', 'b.txt'] }))), null);
  assert.notEqual(parseOpLine(line(holdObj({ cs_ids: [], peer_authors: [], guards: [] }))), null, 'empty lists');
});

test("guard name, guard owner and origin follow record.ts's text rule: 1–256 UTF-16 units, no C0 control and no DEL", T10, () => {
  const ch = (code: number): string => String.fromCharCode(code);
  const candidates: Array<[string, string, boolean]> = [
    ['256 units', 'x'.repeat(256), true],
    ['257 units', 'x'.repeat(257), false],
    ['one unit', 'x', true],
    ['empty', '', false],
    ['NUL', `a${ch(0x00)}b`, false],
    ['TAB', `a${ch(0x09)}b`, false],
    ['LF', `a${ch(0x0a)}`, false],
    ['US (0x1f)', `${ch(0x1f)}a`, false],
    ['DEL', `a${ch(0x7f)}`, false],
    ['space', 'a b', true],
    ['C1 (0x80) is not a C0 control', `a${ch(0x80)}b`, true],
    ['non-ASCII', `\u{d55c}\u{ae00} \u{1f600}`, true],
    // 255 units plus a surrogate pair: 257 UTF-16 units (the limit counts units, not code points).
    ['a surrogate pair past 256 units', `${'x'.repeat(255)}\u{1f600}`, false],
  ];
  const guard = (o: Partial<HoldOpGuard>): HoldOpGuard => ({ name: 'frobnicate', class: 'DECISION', owner: 'HLD', ...o });
  for (const [what, s, ok] of candidates) {
    const cases: Array<[string, Record<string, Json>, Partial<HoldRecord>]> = [
      ['guard name', { guards: [guard({ name: s })] as unknown as Json }, { guards: [guard({ name: s })] }],
      ['guard owner', { guards: [guard({ owner: s })] as unknown as Json }, { guards: [guard({ owner: s })] }],
      ['origin', { origin: s }, { origin: s }],
    ];
    for (const [field, op, rec] of cases) {
      assert.equal(parseOpLine(line(holdObj(op))) !== null, ok, `${field}: ${what}`);
      // Parity with the record schema: a record field the registry stores is a field its op carries, and vice versa.
      assert.equal(accepts({ ...RECORD_BASE, ...rec }), ok, `record.ts ${field}: ${what}`);
    }
  }
});

test('paths [] is valid only with a host-reject guard', T10, () => {
  const pathless = (guards: Json): string => line(holdObj({ kind: 'PIN', state: 'ACTIVE', paths: [], cs_ids: [], origin: 'daemon', guards }));
  const ok = parseOpLine(pathless([{ name: 'host-reject', class: 'DECISION', owner: 'ENG' }]));
  assert.ok(ok !== null, 'the pathless host-reject PIN (R3-11)');
  assert.deepEqual((ok as HoldOp).paths, []);
  assert.equal(parseOpLine(pathless([{ name: 'phantom', class: 'DECISION', owner: 'ENG' }])), null, 'another guard');
  assert.equal(parseOpLine(pathless([])), null, 'no guard');
  // Only a PIN may be pathless, as record.ts admits it (kind PIN with the host-reject guard): a pathless PATCH or INCOMING
  // carrying host-reject is malformed.
  for (const kind of ['PATCH', 'INCOMING']) {
    assert.equal(parseOpLine(line(holdObj({ kind, state: 'ACTIVE', paths: [], cs_ids: [], origin: 'daemon', guards: [{ name: 'host-reject', class: 'DECISION', owner: 'ENG' }] }))), null, `a pathless ${kind}`);
  }
  // The guard's name part decides (a guard `<name>:<arg>`), as record.ts's guardName reads it.
  assert.notEqual(parseOpLine(pathless([{ name: 'host-reject:push', class: 'DECISION', owner: 'ENG' }])), null, 'host-reject with an argument');
  // Its terminal op (resume ends it SUBSUMED with host-reject kept, R3-39) parses too.
  assert.notEqual(parseOpLine(line(holdObj({ kind: 'PIN', state: 'SUBSUMED', residence: null, paths: [], cs_ids: [], origin: 'daemon', guards: [{ name: 'host-reject', class: 'DECISION', owner: 'ENG' }] }))), null);
});

test("the board's hold unions equal record.ts's", T10, () => {
  // Type level: mutual assignability of every union (the parser's sets are declared in src/board).
  const kinds: Equals<HoldOp['kind'], HoldKind> = true;
  const states: Equals<HoldOp['state'], HoldState> = true;
  const offers: Equals<HoldOp['offer'], Offer> = true;
  const residences: Equals<HoldOp['residence'], Residence | null> = true;
  const guards: Equals<HoldOpGuard, Guard> = true;
  assert.ok(kinds && states && offers && residences && guards);
  // Run time: each record union written out as an exhaustive key set (a missing or extra key fails typecheck) …
  const recordKinds: Record<HoldKind, true> = { PATCH: true, PIN: true, INCOMING: true };
  const recordStates: Record<HoldState, true> = { ACTIVE: true, CONFLICTED: true, PARKED: true, SUBSUMED: true, GONE: true, RESOLVED_PUBLISH: true, RESOLVED_DISCARD: true };
  const recordOffers: Record<Offer, true> = { none: true, pending_leftover: true, offered: true, accepted: true, returned: true };
  const recordResidences: Record<Residence, true> = { ON_DISK: true, OFF_DISK: true };
  assert.deepEqual([...HOLD_OP_KINDS].sort(), Object.keys(recordKinds).sort());
  assert.deepEqual([...HOLD_OP_STATES].sort(), Object.keys(recordStates).sort());
  assert.deepEqual([...HOLD_OP_OFFERS].sort(), Object.keys(recordOffers).sort());
  assert.deepEqual([...HOLD_OP_RESIDENCES].sort(), Object.keys(recordResidences).sort());

  // … and the sets the record schema accepts, probed through serializeRecord, equal the parser's.
  const base = RECORD_BASE;
  assert.ok(accepts(base), 'the probe template is a valid record');
  const residencesOrNull: Array<string | null> = ['ON_DISK', 'OFF_DISK', null];
  const probe = (field: 'kind' | 'state' | 'offer' | 'residence', candidates: ReadonlyArray<string | null>): Array<string | null> =>
    candidates.filter((c) => {
      if (field === 'kind' || field === 'offer') return accepts({ ...base, [field]: c });
      if (field === 'state') return residencesOrNull.some((residence) => accepts({ ...base, state: c, residence }));
      return [...HOLD_OP_STATES, 'SUBSUMED'].some((state) => accepts({ ...base, residence: c, state }));
    });
  const extra = ['SNAPSHOT', 'patch', 'WIP', 'maybe', 'IN_RAM', '', 'ABSENT'];
  assert.deepEqual(probe('kind', [...HOLD_OP_KINDS, ...extra]).sort(), [...HOLD_OP_KINDS].sort());
  assert.deepEqual(probe('state', [...HOLD_OP_STATES, ...extra]).sort(), [...HOLD_OP_STATES].sort());
  assert.deepEqual(probe('offer', [...HOLD_OP_OFFERS, ...extra]).sort(), [...HOLD_OP_OFFERS].sort());
  const residence = probe('residence', [...HOLD_OP_RESIDENCES, null, ...extra]);
  assert.ok(residence.includes(null), 'residence: null (a terminal record)');
  assert.deepEqual(residence.filter((x) => x !== null).sort(), [...HOLD_OP_RESIDENCES].sort(), 'residence: the two values');
  // The guard classes of the board op are the record's: every Table 3 class parses in an op.
  for (const r of GUARD_TABLE) assert.notEqual(parseOpLine(line(holdObj({ guards: [{ name: r.name, class: r.cls, owner: r.owner }] }))), null, r.name);
});

const P1 = 'a1'.repeat(16);
const E1 = 'e1'.repeat(16);
const L0 = '1'.repeat(40) as Oid;
const PROTOCOL = genesisProtocol(12, 'rs-1');
const W = (seq: number): WriterId => ({ peer: P1, epoch: E1, seq });
const draft = (writer: WriterId, lines: string[], heldIds: string[] = []): BoardDraft => ({ liveCode: L0, writer, cs: [], protocol: PROTOCOL, opsLines: lines, checkpoint: null, heldIds });
const joinLine = line({
  id: `${P1}/${E1}/1`, type: 'join', display: 'P1', plugin_version: '0.3.0', plugin_sha: 'f'.repeat(64), proto: 1, regionSpec: 'rs-1',
  config_fingerprint: { filters: {}, autocrlf: '', eol_attrs: '', git: '2.47.1' }, coauthor_optin: false,
});

test('PLAN2_FOLDED_TYPES contains hold and OpaqueOp no longer does', T10, () => {
  // Type level: the opaque types lost 'hold'; Op carries HoldOp.
  const opaqueTypes: Equals<OpaqueOp['type'], 'claim' | 'release' | 'request' | 'request_status' | 'answer' | 'note' | 'presume_absent'> = true;
  const inOp: Equals<Extract<Op, { type: 'hold' }>, HoldOp> = true;
  assert.ok(opaqueTypes && inOp);
  assert.deepEqual([...PLAN2_FOLDED_TYPES].sort(), ['caps', 'event', 'hold', 'join', 'leave', 'save', 'seat_end', 'seat_start']);

  // A hold line now has a fold effect.
  const s0 = foldCommit(initialFoldState(PROTOCOL), draft(W(2), [joinLine]), P1).state;
  const hold = line(holdObj({ id: `${P1}/${E1}/3`, rev: 1, prev_rev: null, state: 'ACTIVE', peer_authors: [] }));
  const r = foldCommit(s0, draft(W(4), [hold], [HOLD_ID]), P1);
  assert.deepEqual(r.ownRejections, []);
  assert.deepEqual(r.landedOwnOpIds, [`${P1}/${E1}/3`]);
  assert.equal(r.state.holds[HOLD_ID]?.rev, 1);
  assert.equal(r.state.record_count, s0.record_count + 1);

  // The seven others stay opaque no-ops: parsed with every field kept, folded with no effect and no rejection.
  const opaque = [
    { type: 'claim', claim_id: 'abcdefghijklmnop', path: 'src/a.ts', zz_future: 1 },
    { type: 'release', claim_ids: ['abcdefghijklmnop'], reason: 'explicit' },
    { type: 'request', req_id: HOLD_ID, kind: 'handoff', path: 'src/a.ts', attempt: 1 },
    { type: 'request_status', req_id: HOLD_ID, status: 'asked' },
    { type: 'answer', req_id: HOLD_ID, verb: 'decline', by: 'human', reason_code: 'REQUEST_DECLINED' },
    { type: 'note', target: null, text: 'hello' },
    { type: 'presume_absent', peer: PEER, epoch: EPOCH, last_seq_seen: 1 },
  ];
  const lines = opaque.map((o, i) => line({ ...o, id: `${P1}/${E1}/${3 + i}` }));
  for (const [i, l] of lines.entries()) {
    assert.ok(!PLAN2_FOLDED_TYPES.has(opaque[i]!.type as never), opaque[i]!.type);
    assert.deepEqual(parseOpLine(l), JSON.parse(l), `${opaque[i]!.type} keeps every field`);
  }
  const r2 = foldCommit(s0, draft(W(20), lines), P1);
  assert.deepEqual(r2.ownRejections, []);
  assert.equal(r2.landedOwnOpIds.length, 7);
  for (const k of ['claims', 'requests', 'holds', 'notes'] as const) assert.deepEqual(r2.state[k], {}, k);
  assert.equal(r2.state.record_count, s0.record_count);
});

test('serializeOps round-trips a hold op and refuses a hold line over 16,384 bytes', T10, () => {
  const op = parseOpLine(line(holdObj()));
  assert.ok(op !== null);
  const bytes = serializeOps([op]);
  assert.equal(bytes.toString('utf8'), `${line(holdObj())}\n`);
  assert.deepEqual(parseOpLine(bytes.toString('utf8').slice(0, -1)), op);
  // A PIN over 300 paths: an 18 KB canonical line is a cap error (PRO-06, 02 §3.1), never a malformed op.
  const paths = Array.from({ length: 300 }, (_, i) => `src/module-${String(i).padStart(3, '0')}/${'c'.repeat(34)}-${String(i).padStart(3, '0')}.ts`).sort();
  const big: HoldOp = { ...(op as HoldOp), kind: 'PIN', paths };
  const size = Buffer.byteLength(canonicalJson(big as unknown as Json), 'utf8');
  assert.ok(size > 17_500 && size < 18_500 && size > OP_MAX_LINE_BYTES, `the 300-path line is ${size} bytes`);
  assert.throws(() => serializeOps([big]), (e: unknown) => e instanceof BoardCapError && /16384/.test(e.message));
  assert.equal(parseOpLine(canonicalJson(big as unknown as Json)), null, 'a reader folds the over-cap line as malformed');
});

test('isHoldCreation is true exactly for hold drafts with prev_rev null', T10, () => {
  const { id: _id, ...rest } = holdObj({ rev: 1, prev_rev: null });
  const create = rest as unknown as OpDraft;
  assert.equal(isHoldCreation(create), true, 'a create draft');
  assert.equal(isHoldCreation({ ...(rest as object), rev: 4, prev_rev: 3 } as unknown as OpDraft), false, 'prev_rev 3');
  assert.equal(isHoldCreation(parseOpLine(line(holdObj({ rev: 1, prev_rev: null }))) as Op), true, 'a create op');
  assert.equal(isHoldCreation(parseOpLine(line(holdObj())) as Op), false, 'an update op');
  const others: OpDraft[] = [
    { type: 'leave' },
    { type: 'event', cid: '', kind: 'health', refs: [], reason_code: 'BOARD_FULL' },
    { type: 'note', target: null, text: 'x', prev_rev: null },
    { type: 'request', req_id: HOLD_ID, kind: 'handoff', path: 'a.txt', prev_rev: null },
  ];
  for (const d of others) assert.equal(isHoldCreation(d), false, String(d.type));
});

test('PRO-05: hold oids appear only as held/ entries', T10, () => {
  // Type level: neither HoldOp nor FoldedHold has a blob-id or a text field — their keys are exactly these.
  const opKeys: Equals<keyof HoldOp, 'id' | 'type' | 'hold_id' | 'rev' | 'prev_rev' | 'kind' | 'residence' | 'state' | 'offer' | 'guards' | 'paths' | 'origin' | 'cs_ids' | 'peer_authors' | 'local_only'> = true;
  const foldedKeys: Equals<keyof FoldedHold, 'rev' | 'kind' | 'residence' | 'state' | 'offer' | 'guards' | 'paths' | 'origin' | 'cs_ids' | 'peer_authors' | 'local_only' | 'owner' | 'terminal_height'> = true;
  const guardKeys: Equals<keyof HoldOpGuard, 'name' | 'class' | 'owner'> = true;
  assert.ok(opKeys && foldedKeys && guardKeys);
  // Run time: a smuggled blobs field (and any oid-bearing extra) is dropped at parse, so the fold never stores it.
  const smuggled = line(holdObj({ id: `${P1}/${E1}/3`, rev: 1, prev_rev: null, blobs: { h1: { 'src/a.ts': OID_A } }, oid: OID_B, held: [OID_A] }));
  const op = parseOpLine(smuggled);
  assert.ok(op !== null);
  assert.ok(smuggled.includes('"blobs"'), 'the line carries the smuggled field');
  for (const k of ['blobs', 'oid', 'held']) assert.ok(!Object.hasOwn(op, k), `${k} is dropped`);
  assert.ok(!canonicalJson(op as unknown as Json).includes(OID_A) && !canonicalJson(op as unknown as Json).includes(OID_B));
  const s0 = foldCommit(initialFoldState(PROTOCOL), draft(W(2), [joinLine]), P1).state;
  const s1 = foldCommit(s0, draft(W(4), [smuggled], [HOLD_ID]), P1).state;
  const entry = s1.holds[HOLD_ID];
  assert.ok(entry !== undefined);
  const text = canonicalJson(entry as unknown as Json);
  assert.ok(!text.includes(OID_A) && !text.includes(OID_B), 'no oid reaches the folded entry');
});
