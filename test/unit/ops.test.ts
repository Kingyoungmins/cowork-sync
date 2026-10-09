import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, MAX_JSON_DEPTH, type Json } from '../../src/board/canonicalJson.js';
import { H } from '../../src/board/ids.js';
import {
  BoardCapError,
  eventCid,
  OP_MAX_LINE_BYTES,
  OPS_MAX_BYTES,
  OPS_MAX_LINES,
  parseOpLine,
  PLAN2_FOLDED_TYPES,
  REASON_CODE_RE,
  serializeOps,
  type EventKind,
  type Op,
  type OpType,
} from '../../src/board/ops.js';

const PEER = '0123456789abcdef0123456789abcdef';
const EPOCH = 'fedcba9876543210fedcba9876543210';
const SEAT = '00112233445566778899aabbccddeeff';
const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);
const OID_C = 'c'.repeat(64);
const HOLD_ID = '01J9ZQ3C5X0000000000000000';
const id = (seq: number): string => `${PEER}/${EPOCH}/${seq}`;
const line = (v: Record<string, unknown>): string => canonicalJson(v as Json);

/** One op of every glossary §7 type, as plain objects. */
function everyType(): Record<OpType, Record<string, Json>> {
  return {
    join: {
      id: id(1), type: 'join', display: 'Ada Lovelace', plugin_version: '0.2.0', plugin_sha: 'f'.repeat(64), proto: 1, regionSpec: 'rs-1',
      config_fingerprint: { filters: { crypt: '0'.repeat(64) }, autocrlf: 'true', eol_attrs: '', git: '2.47.1' }, coauthor_optin: false,
    },
    leave: { id: id(2), type: 'leave' },
    caps: { id: id(3), type: 'caps', custom_refs: true, lease: true, delete: false, push_options: false, two_parent_ok: true },
    seat_start: { id: id(4), type: 'seat_start', seat_id: SEAT, permission_mode: 'acceptEdits' },
    seat_end: { id: id(5), type: 'seat_end', seat_id: SEAT, permission_mode: 'default' },
    claim: {
      id: id(6), type: 'claim', claim_id: '0123456789abcdef', path: 'src/a.ts', anchor: OID_A, base_blob: OID_B, ranges: [[9, 12], [1, 4]], tombstones: [],
      granularity: 'symbol', label: { kind: 'function', qualname: 'a', simple: 'a', type: null, disc: 0 }, regionSpec: 'rs-1', cs_id: `${SEAT}/3`,
      holder: { peer: PEER, seat: SEAT, agent: 'main' },
    },
    release: { id: id(7), type: 'release', claim_ids: ['fedcba9876543210', '0123456789abcdef'], reason: 'explicit' },
    request: {
      id: id(8), type: 'request', req_id: HOLD_ID, kind: 'handoff', ckind: 'claim_visible', from: { peer: PEER, seat: SEAT, agent: 'main' },
      to_holder: { peer: PEER, seat: SEAT }, claim_ids: ['0123456789abcdef'], path: 'src/a.ts', cs_id: `${SEAT}/3`, attempt: 1, origin: 'claude',
    },
    request_status: { id: id(9), type: 'request_status', req_id: HOLD_ID, to_holder: { seat: SEAT }, status: 'asked' },
    answer: { id: id(10), type: 'answer', req_id: HOLD_ID, to_holder: { seat: SEAT }, verb: 'decline', by: 'human', reason_code: 'BUSY_NOW' },
    note: { id: id(11), type: 'note', target: null, text: 'back in 5' },
    presume_absent: { id: id(12), type: 'presume_absent', peer: PEER, epoch: EPOCH, last_seq_seen: 40 },
    hold: {
      id: id(13), type: 'hold', hold_id: HOLD_ID, rev: 1, prev_rev: null, kind: 'PATCH', residence: 'ON_DISK', state: 'CONFLICTED', offer: 'none',
      guards: ['conflict'], paths: ['src/a.ts', 'docs/b.md'], origin: 'human', cs_ids: [`${PEER}/human/2`, `${PEER}/human/1`], peer_authors: [PEER], local_only: false,
    },
    event: { id: id(14), type: 'event', cid: H(id(14), 'health'), kind: 'health', refs: [], reason_code: 'HOST_THROTTLED' },
    save: { id: id(15), type: 'save', save_commit: OID_A, saved_live: OID_B, chain_base: OID_C, released_claim_ids: ['0123456789abcdef'] },
  };
}

const OPAQUE = ['claim', 'release', 'request', 'request_status', 'answer', 'note', 'presume_absent', 'hold'] as const;
type OpaqueType = (typeof OPAQUE)[number];

/**
 * The canonical line of each opaque op of everyType(), written out by hand: keys in UTF-16 order at every
 * level, arrays in fixture order (several deliberately unsorted). Independent of canonicalJson.
 */
function opaqueCanon(): Record<OpaqueType, string> {
  return {
    claim: `{"anchor":"${OID_A}","base_blob":"${OID_B}","claim_id":"0123456789abcdef","cs_id":"${SEAT}/3","granularity":"symbol",`
      + `"holder":{"agent":"main","peer":"${PEER}","seat":"${SEAT}"},"id":"${id(6)}",`
      + `"label":{"disc":0,"kind":"function","qualname":"a","simple":"a","type":null},"path":"src/a.ts","ranges":[[9,12],[1,4]],`
      + `"regionSpec":"rs-1","tombstones":[],"type":"claim"}`,
    release: `{"claim_ids":["fedcba9876543210","0123456789abcdef"],"id":"${id(7)}","reason":"explicit","type":"release"}`,
    request: `{"attempt":1,"ckind":"claim_visible","claim_ids":["0123456789abcdef"],"cs_id":"${SEAT}/3",`
      + `"from":{"agent":"main","peer":"${PEER}","seat":"${SEAT}"},"id":"${id(8)}","kind":"handoff","origin":"claude","path":"src/a.ts",`
      + `"req_id":"${HOLD_ID}","to_holder":{"peer":"${PEER}","seat":"${SEAT}"},"type":"request"}`,
    request_status: `{"id":"${id(9)}","req_id":"${HOLD_ID}","status":"asked","to_holder":{"seat":"${SEAT}"},"type":"request_status"}`,
    answer: `{"by":"human","id":"${id(10)}","reason_code":"BUSY_NOW","req_id":"${HOLD_ID}","to_holder":{"seat":"${SEAT}"},"type":"answer","verb":"decline"}`,
    note: `{"id":"${id(11)}","target":null,"text":"back in 5","type":"note"}`,
    presume_absent: `{"epoch":"${EPOCH}","id":"${id(12)}","last_seq_seen":40,"peer":"${PEER}","type":"presume_absent"}`,
    hold: `{"cs_ids":["${PEER}/human/2","${PEER}/human/1"],"guards":["conflict"],"hold_id":"${HOLD_ID}","id":"${id(13)}","kind":"PATCH",`
      + `"local_only":false,"offer":"none","origin":"human","paths":["src/a.ts","docs/b.md"],"peer_authors":["${PEER}"],"prev_rev":null,`
      + `"residence":"ON_DISK","rev":1,"state":"CONFLICTED","type":"hold"}`,
  };
}

/** The same JSON value with every object's keys in reverse insertion order: a non-canonical spelling. */
function reversedKeys(v: Json): Json {
  if (Array.isArray(v)) return v.map(reversedKeys);
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reversedKeys(x)]));
  return v;
}

test('every glossary §7 op type parses and re-serializes byte-identically; unknown fields are ignored', () => {
  const ops = everyType();
  assert.equal(Object.keys(ops).length, 15);
  assert.deepEqual([...PLAN2_FOLDED_TYPES, ...OPAQUE].sort(), Object.keys(ops).sort());

  // The 8 opaque types (R-12) keep every field as parsed. Each is pinned against its hand-written canonical
  // line, and parsed both from that line and from a non-canonical spelling (keys reversed at every level,
  // nested objects included), so a parser that drops, adds or reorders a field or an array element, or a
  // serializer that changes the byte form or stops sorting keys, fails here.
  const canon = opaqueCanon();
  for (const type of OPAQUE) {
    assert.ok(!PLAN2_FOLDED_TYPES.has(type));
    const obj = ops[type];
    assert.equal(canonicalJson(obj), canon[type], `${type}: the fixture's canonical bytes`);
    const shuffled = JSON.stringify(reversedKeys(obj));
    assert.notEqual(shuffled, canon[type], `${type}: the shuffled spelling is not canonical`);
    for (const [form, text] of [['canonical', canon[type]], ['shuffled', shuffled]] as const) {
      const op = parseOpLine(text);
      assert.ok(op !== null, `${type} (${form}) parses`);
      assert.deepEqual(op, obj, `${type} (${form}) parses to exactly its fields`);
      assert.equal(canonicalJson(op as unknown as Json), canon[type], `${type} (${form}) re-serializes to the canonical bytes`);
      assert.equal(serializeOps([op]).toString('utf8'), `${canon[type]}\n`, `${type} (${form}) serializeOps`);
    }
    // Opaque in Plan 2: an unknown field is kept, not dropped, and does not make the op malformed.
    const extended = parseOpLine(`${shuffled.slice(0, -1)},"zz_future":[2,{"b":1,"a":0}]}`);
    assert.deepEqual(extended, { ...obj, zz_future: [2, { a: 0, b: 1 }] }, `${type} keeps an unknown field`);
    assert.equal(canonicalJson(extended as unknown as Json), `${canon[type].slice(0, -1)},"zz_future":[2,{"a":0,"b":1}]}`, `${type} unknown field bytes`);
  }

  // The 7 typed Plan 2 types parse into new objects of exactly their glossary §7 fields.
  for (const type of PLAN2_FOLDED_TYPES) {
    const obj = ops[type];
    const text = line(obj);
    const op = parseOpLine(text);
    assert.ok(op !== null, `${type} parses`);
    assert.equal(op.type, type);
    assert.deepEqual(op, obj, `${type} parses to its fields`);
    assert.equal(canonicalJson(op as unknown as Json), text, `${type} re-serializes byte-identically`);
    assert.equal(serializeOps([op]).toString('utf8'), `${text}\n`);
  }
  // Hand-written canonical lines pin the byte form independently of canonicalJson.
  const leave = `{"id":"${id(2)}","type":"leave"}`;
  assert.equal(canonicalJson(parseOpLine(leave) as unknown as Json), leave);
  const caps = `{"custom_refs":true,"delete":false,"id":"${id(3)}","lease":true,"push_options":false,"two_parent_ok":true,"type":"caps"}`;
  assert.equal(canonicalJson(parseOpLine(caps) as unknown as Json), caps);
  const joinStr = `{"coauthor_optin":"Ada <ada@example.com>","config_fingerprint":{"autocrlf":"","eol_attrs":"","filters":{},"git":"2.43.0"},`
    + `"display":"Ada","id":"${id(1)}","plugin_sha":"","plugin_version":"0.2.0","proto":1,"regionSpec":"rs","type":"join"}`;
  assert.equal(canonicalJson(parseOpLine(joinStr) as unknown as Json), joinStr);

  // Unknown fields (top level and inside config_fingerprint) are ignored: the typed op is the same.
  for (const type of PLAN2_FOLDED_TYPES) {
    const obj = ops[type];
    const extended: Record<string, Json> = { ...obj, zz_future: { nested: [1, 'x'] }, aa_first: null };
    if (type === 'join') extended['config_fingerprint'] = { ...(obj['config_fingerprint'] as Record<string, Json>), lfs: '3.5' };
    assert.deepEqual(parseOpLine(line(extended)), obj, `${type} ignores unknown fields`);
  }
  assert.deepEqual([...PLAN2_FOLDED_TYPES].sort(), ['caps', 'event', 'join', 'leave', 'save', 'seat_end', 'seat_start']);
  // Every event kind and both coauthor_optin forms parse.
  for (const kind of ['K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7', 'breach', 'freeze', 'unfreeze', 'incident', 'nonretryable', 'health'] as EventKind[]) {
    assert.notEqual(parseOpLine(line({ ...ops.event, kind, cid: H(id(14), kind) })), null, kind);
  }
});

test('malformed lines parse to null', () => {
  const ops = everyType();
  const without = (type: OpType, field: string): string => {
    const o: Record<string, Json> = { ...ops[type] };
    delete o[field];
    return line(o);
  };
  const withField = (type: OpType, field: string, value: unknown): string => line({ ...ops[type], [field]: value });
  const bad: Array<[string, string]> = [
    // Bad JSON and non-objects.
    ['empty', ''], ['truncated', '{"id":'], ['trailing garbage', `${line(ops.leave)}x`], ['null', 'null'], ['array', '[]'], ['string', '"leave"'],
    ['BOM', `\u{feff}${line(ops.leave)}`], ['huge number', `{"id":"${id(3)}","type":"note","target":null,"text":"x","n":1e999}`],
    // Missing fields.
    ['no id', without('leave', 'id')], ['no type', without('leave', 'type')], ['join without display', without('join', 'display')],
    ['join without fingerprint', without('join', 'config_fingerprint')], ['caps without lease', without('caps', 'lease')],
    ['seat_start without permission_mode', without('seat_start', 'permission_mode')], ['event without reason_code', without('event', 'reason_code')],
    ['event without refs', without('event', 'refs')], ['save without chain_base', without('save', 'chain_base')],
    ['claim without path', without('claim', 'path')], ['hold without paths', without('hold', 'paths')],
    // Wrong types and values out of range.
    ['unknown type', withField('leave', 'type', 'frobnicate')], ['proto as a string', withField('join', 'proto', '1')],
    ['proto fractional', withField('join', 'proto', 1.5)], ['coauthor_optin true', withField('join', 'coauthor_optin', true)],
    ['fingerprint filter not a string', withField('join', 'config_fingerprint', { filters: { crypt: 1 }, autocrlf: '', eol_attrs: '', git: '' })],
    ['caps lease as a string', withField('caps', 'lease', 'true')], ['seat_id upper case', withField('seat_start', 'seat_id', SEAT.toUpperCase())],
    ['seat_id short', withField('seat_end', 'seat_id', SEAT.slice(2))], ['event kind K8', withField('event', 'kind', 'K8')],
    ['event cid lower case', withField('event', 'cid', H(id(14), 'health').toLowerCase())], ['event cid empty', withField('event', 'cid', '')],
    ['event cid with I', withField('event', 'cid', 'IIIIIIII')], ['event refs not strings', withField('event', 'refs', [1])],
    ['save_commit short', withField('save', 'save_commit', 'abc123')], ['save_commit upper', withField('save', 'saved_live', OID_A.toUpperCase())],
    ['released_claim_ids not an array', withField('save', 'released_claim_ids', 'x')],
    // Ids failing SEC-35 validId.
    ['seq 0', withField('leave', 'id', `${PEER}/${EPOCH}/0`)], ['seq 01', withField('leave', 'id', `${PEER}/${EPOCH}/01`)],
    ['seq beyond MAX_SAFE_INTEGER', withField('leave', 'id', `${PEER}/${EPOCH}/9007199254740993`)],
    ['peer upper case', withField('leave', 'id', `${PEER.toUpperCase()}/${EPOCH}/2`)], ['id a number', withField('leave', 'id', 2)],
    ['hold_id not a ULID', withField('hold', 'hold_id', 'not-a-ulid')], ['cs_id malformed', withField('claim', 'cs_id', `${SEAT}/human/x`)],
    // reason_code outside the registry pattern ^[A-Z][A-Z0-9_]{2,47}$.
    ['reason_code lower', withField('event', 'reason_code', 'host_throttled')], ['reason_code too short', withField('event', 'reason_code', 'AB')],
    ['reason_code 49 chars', withField('event', 'reason_code', `A${'B'.repeat(48)}`)], ['reason_code hyphen', withField('event', 'reason_code', 'HOST-THROTTLED')],
    ['reason_code digit first', withField('event', 'reason_code', '1ABC')], ['reason_code trailing space', withField('event', 'reason_code', 'HOST_THROTTLED ')],
    ['answer reason_code', withField('answer', 'reason_code', 'busy')],
    // Paths failing validPathSyntax.
    ['claim path ..', withField('claim', 'path', '../x.ts')], ['claim path colon', withField('claim', 'path', 'docs/12:30-notes.md')],
    ['claim path absolute', withField('claim', 'path', '/etc/passwd')], ['claim path backslash', withField('claim', 'path', 'src\\a.ts')],
    ['claim path empty component', withField('claim', 'path', 'src//a.ts')], ['request path drive', withField('request', 'path', 'C:/x')],
    ['request path not NFC', withField('request', 'path', 'cafe\u{301}.md')], ['hold paths one bad', withField('hold', 'paths', ['ok.txt', 'a/../b'])],
    ['hold paths not strings', withField('hold', 'paths', [1])],
  ];
  for (const [what, text] of bad) assert.equal(parseOpLine(text), null, what);

  // Valid boundary values of the same fields still parse.
  assert.notEqual(parseOpLine(withField('event', 'reason_code', 'ABC')), null);
  assert.notEqual(parseOpLine(withField('event', 'reason_code', `A${'B'.repeat(47)}`)), null);
  assert.ok(REASON_CODE_RE.test('HOST_THROTTLED') && !REASON_CODE_RE.test('AB'));
  assert.notEqual(parseOpLine(withField('claim', 'path', 'docs/한글 파일.md')), null);

  // A line over 16 KiB is a no-op; exactly 16 KiB parses.
  const padded = (n: number): string => {
    const base = line({ ...ops.event, refs: [''] });
    return line({ ...ops.event, refs: ['x'.repeat(n - Buffer.byteLength(base, 'utf8'))] });
  };
  assert.equal(Buffer.byteLength(padded(OP_MAX_LINE_BYTES)), OP_MAX_LINE_BYTES);
  assert.notEqual(parseOpLine(padded(OP_MAX_LINE_BYTES)), null);
  assert.equal(parseOpLine(padded(OP_MAX_LINE_BYTES + 1)), null);
});

test('an op nested deeper than MAX_JSON_DEPTH is malformed, on a cold and on a warmed canonicalJson (ruling P2-DEPTH)', () => {
  const ops = everyType();
  const arrays = (n: number): string => `${'['.repeat(n)}${']'.repeat(n)}`;          // depth n (n >= 1)
  const objects = (n: number): string => `${'{"a":'.repeat(n - 1)}{}${'}'.repeat(n - 1)}`;   // depth n (n >= 1)
  // A canonical note op holding a value of depth n: the op object itself is depth n + 1.
  const note = (value: string): string => `{"deep":${value},"id":"${id(11)}","target":null,"text":"x","type":"note"}`;
  const atCap = note(arrays(MAX_JSON_DEPTH - 1));
  const pastCap = note(arrays(MAX_JSON_DEPTH));
  const huge = note(arrays(3_000));
  assert.ok(Buffer.byteLength(huge) < OP_MAX_LINE_BYTES);
  const verdicts = (): Array<Op | null> => [parseOpLine(huge), parseOpLine(pastCap), parseOpLine(atCap)];

  // Cold: nothing in this test has run canonicalJson yet.
  const cold = verdicts();
  assert.equal(cold[0], null, '3,000 deep is malformed');
  assert.equal(cold[1], null, 'one level past the cap is malformed');
  assert.ok(cold[2] !== null, 'exactly at the cap parses');
  assert.equal(canonicalJson(cold[2] as unknown as Json), atCap);

  // Warm canonicalJson (2,000 calls), then the same bytes give the same verdicts.
  for (let i = 0; i < 2_000; i++) canonicalJson(ops.claim);
  assert.deepEqual(verdicts(), cold);

  // Every depth the 16 KiB line bound allows is decided by the cap alone, for arrays and for objects.
  for (let n = 1; n <= 8_000; n += n < 200 ? 1 : 97) {
    assert.equal(parseOpLine(note(arrays(n))) === null, n + 1 > MAX_JSON_DEPTH, `arrays, op depth ${n + 1}`);
  }
  for (let n = 1; n <= 2_500; n += n < 200 ? 1 : 101) {
    assert.equal(parseOpLine(note(objects(n))) === null, n + 1 > MAX_JSON_DEPTH, `objects, op depth ${n + 1}`);
  }
  // The cap is on the line: an unknown field of a typed op counts although the parsed op drops it.
  const join = JSON.stringify(ops.join).slice(0, -1);
  assert.deepEqual(parseOpLine(`${join},"zz_future":${arrays(MAX_JSON_DEPTH - 1)}}`), ops.join);
  assert.equal(parseOpLine(`${join},"zz_future":${arrays(MAX_JSON_DEPTH)}}`), null);
  assert.equal(parseOpLine(`${join},"zz_future":${arrays(5_000)}}`), null);
});

test('serializeOps refuses 1,001 ops, more than 64 KiB, or a line over 16 KiB', () => {
  assert.equal(OPS_MAX_LINES, 1_000);
  assert.equal(OPS_MAX_BYTES, 65_536);
  assert.equal(OP_MAX_LINE_BYTES, 16_384);
  const leave = (seq: number): Op => ({ id: id(seq), type: 'leave' });
  const event = (seq: number, ref: string): Op => ({ id: id(seq), type: 'event', cid: H(id(seq), 'freeze'), kind: 'freeze', refs: [ref], reason_code: 'EPOCH_CHANGED' });

  // Canonical JSON per line, LF after every line, strictly increasing seq.
  const ops = [leave(1), event(2, 'r'), leave(9)];
  const buf = serializeOps(ops);
  assert.equal(buf.toString('utf8'), `${ops.map((o) => canonicalJson(o as unknown as Json)).join('\n')}\n`);
  assert.equal(serializeOps([]).length, 0);

  // 1,001 ops: refused by the line cap before any byte is counted.
  const many = Array.from({ length: 1_001 }, (_, i) => leave(i + 1));
  assert.throws(() => serializeOps(many), (e: unknown) => e instanceof BoardCapError && /1001/.test(e.message));

  // More than 64 KiB in total (LFs included); just under the cap is fine.
  const lineBytes = Buffer.byteLength(canonicalJson(leave(100) as unknown as Json)) + 1;
  const fit = Math.floor(OPS_MAX_BYTES / lineBytes);
  const atCap = Array.from({ length: fit }, (_, i) => leave(100 + i));
  assert.ok(serializeOps(atCap).length <= OPS_MAX_BYTES);
  const over = Array.from({ length: fit + 1 }, (_, i) => leave(100 + i));
  assert.throws(() => serializeOps(over), (e: unknown) => e instanceof BoardCapError && /65536/.test(e.message));

  // A line over 16 KiB; exactly 16 KiB is fine.
  const sized = (n: number): Op => {
    const base = Buffer.byteLength(canonicalJson(event(5, '') as unknown as Json));
    return event(5, 'y'.repeat(n - base));
  };
  assert.equal(serializeOps([sized(OP_MAX_LINE_BYTES)]).length, OP_MAX_LINE_BYTES + 1);
  assert.throws(() => serializeOps([sized(OP_MAX_LINE_BYTES + 1)]), (e: unknown) => e instanceof BoardCapError && /16384/.test(e.message));

  // Not cap errors: seqs that do not increase, and an op that would fold as malformed.
  for (const wrong of [[leave(2), leave(2)], [leave(3), leave(1)]]) {
    assert.throws(() => serializeOps(wrong), (e: unknown) => e instanceof Error && !(e instanceof BoardCapError));
  }
  const noCid: Op = { id: id(1), type: 'event', cid: '', kind: 'freeze', refs: [], reason_code: 'EPOCH_CHANGED' };
  assert.throws(() => serializeOps([noCid]), (e: unknown) => e instanceof Error && !(e instanceof BoardCapError));
});

test('eventCid is H(op id, kind)', () => {
  for (const kind of ['freeze', 'unfreeze', 'incident', 'nonretryable', 'health'] as EventKind[]) {
    assert.equal(eventCid(id(7), kind), H(id(7), kind));
  }
  assert.equal(eventCid(id(7), 'health'), 'HSG8XN4D');
  assert.equal(eventCid(id(7), 'freeze'), '6YQV501D');
  assert.notEqual(eventCid(id(7), 'health'), eventCid(id(8), 'health'));
});
