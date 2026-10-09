import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, type Json } from '../../src/board/canonicalJson.js';
import { H, parseOpId } from '../../src/board/ids.js';
import { eventCid, OPS_MAX_BYTES, OPS_MAX_LINES, serializeOps, type EventKind, type Op, type OpDraft } from '../../src/board/ops.js';
import { allowedInAll, allowedInState, Outbox, type PushState, type SeqAllocator } from '../../src/board/outbox.js';

const PEER = '0123456789abcdef0123456789abcdef';
const EPOCH = 'fedcba9876543210fedcba9876543210';
const OTHER_PEER = '00000000000000000000000000000001';
const OTHER_EPOCH = '00000000000000000000000000000002';
const SEAT = '00112233445566778899aabbccddeeff';
const ULID = '01J9ZQ3C5X0000000000000000';
const OID = 'a'.repeat(40);
const SELF = { peer: PEER, epoch: EPOCH };
const ROOM = { maxOps: OPS_MAX_LINES, maxBytes: OPS_MAX_BYTES };

/** meta.seq_next stand-in: hands out n, n+1, … and counts calls. */
class Counter implements SeqAllocator {
  calls = 0;
  constructor(public n: number) {}
  next(): number {
    this.calls += 1;
    return this.n++;
  }
}

const seqOf = (op: Op): number => (parseOpId(op.id) as { seq: number }).seq;
const seqs = (ops: readonly Op[]): number[] => ops.map(seqOf);

const claim = (n: number): OpDraft => ({ type: 'claim', claim_id: `cl-${n}`, path: `src/f${n}.ts` });
const requestStatus = (): OpDraft => ({ type: 'request_status', req_id: ULID, to_holder: { seat: SEAT }, status: 'asked' });
const leave = (): OpDraft => ({ type: 'leave' });
const event = (kind: EventKind, reason = 'HOST_THROTTLED', cid = ''): OpDraft => ({ type: 'event', cid, kind, refs: [], reason_code: reason });
const answer = (verb: string): OpDraft => ({ type: 'answer', req_id: ULID, to_holder: { seat: SEAT }, verb, by: 'human', reason_code: 'ANSWER_GIVEN' });

test('intent [c(10), r(11)] writer 12 loses, intent [r(11)] writer 13 lands, and c is renumbered above 13', () => {
  const alloc = new Counter(10);
  const box = new Outbox();
  box.add(claim(1));
  box.add(requestStatus());

  // Intent 1 against T: both ops get their seqs on first placement, then the writer seq.
  const intent1 = box.take(['ok'], SELF, alloc, ROOM);
  assert.deepEqual(seqs(intent1), [10, 11]);
  assert.deepEqual(intent1.map((o) => o.type), ['claim', 'request_status']);
  const writer1 = alloc.next();
  assert.equal(writer1, 12);
  const [c, r] = intent1 as [Op, Op];

  // Intent 1 loses the CAS: nothing lands, ids are kept. The peer enters the regionSpec VERSION pause:
  // the claim may not leave, the request_status may, and it keeps its id across the rebuild.
  const intent2 = box.take(['version_board_only'], SELF, alloc, ROOM);
  assert.deepEqual(intent2, [r]);
  const writer2 = alloc.next();
  assert.equal(writer2, 13);

  // Intent 2 lands: r leaves the outbox, c (seq 10 < 13, not in the intent) is renumbered above 13.
  box.landed(new Set([r.id]), writer2, alloc, SELF);
  assert.equal(box.size, 1);
  assert.equal(box.take(['version_board_only'], SELF, alloc, ROOM).length, 0, 'c still waits during the pause');
  const intent3 = box.take(['ok'], SELF, alloc, ROOM);
  assert.equal(intent3.length, 1);
  const c2 = intent3[0] as Op;
  assert.equal(c2.type, 'claim');
  assert.ok(seqOf(c2) > 13, `renumbered seq ${seqOf(c2)} > 13`);
  assert.notEqual(c2.id, c.id);
  assert.deepEqual({ ...c2, id: c.id }, c, 'only the id changed');
  // The new id is still this (peer, epoch); a third intent's writer seq is above it.
  assert.deepEqual({ peer: parseOpId(c2.id)?.peer, epoch: parseOpId(c2.id)?.epoch }, SELF);
  assert.ok(alloc.next() > seqOf(c2));
  // A rebuild of intent 3 keeps c's new id (ids are kept until landing).
  assert.deepEqual(box.take(['ok'], SELF, alloc, ROOM), [c2]);
});

test('renumberAtOrBelow renumbers ops at or below the folded last_seq, order kept', () => {
  const alloc = new Counter(5);
  const box = new Outbox();
  box.add(claim(1)); // a: 5
  box.add(claim(2)); // b: 6
  box.add(claim(3)); // c: 7
  const [a, b, c] = box.take(['ok'], SELF, alloc, ROOM) as [Op, Op, Op];
  assert.deepEqual(seqs([a, b, c]), [5, 6, 7]);
  box.add(leave()); // d: not yet placed, no seq

  // Nothing at or below 4: no renumbering, no seq spent.
  const before = alloc.calls;
  box.renumberAtOrBelow(4, alloc, SELF);
  assert.equal(alloc.calls, before);

  // The folded last_seq of our own epoch at the leased tip is 6: a and b would fold as no-ops.
  box.renumberAtOrBelow(6, alloc, SELF);
  assert.equal(alloc.calls, before + 2, 'one new seq per renumbered op');
  const out = box.take(['ok'], SELF, alloc, ROOM);
  const byClaim = new Map(out.filter((o) => o.type === 'claim').map((o) => [String((o as { claim_id?: Json }).claim_id), o]));
  const a2 = byClaim.get('cl-1') as Op;
  const b2 = byClaim.get('cl-2') as Op;
  const c2 = byClaim.get('cl-3') as Op;
  assert.ok(seqOf(a2) > 6 && seqOf(b2) > 6, 'both above the folded last_seq');
  assert.ok(seqOf(a2) < seqOf(b2), 'the renumbered ops keep their relative order');
  assert.equal(c2.id, c.id, 'an op above last_seq keeps its id');
  // ops.jsonl order is seq order; the never-placed leave gets the newest seq.
  assert.deepEqual(out.map((o) => o.type), ['claim', 'claim', 'claim', 'leave']);
  assert.deepEqual(seqs(out), [...seqs(out)].sort((x, y) => x - y));
  assert.ok(seqOf(out[3] as Op) > seqOf(b2));
  assert.doesNotThrow(() => serializeOps(out));
});

/** One draft per op type, every event kind, every answer verb, both health reasons; labelled. */
function everyDraft(): Array<[string, OpDraft]> {
  const out: Array<[string, OpDraft]> = [
    ['join', { type: 'join', display: 'Ann', plugin_version: '0.0.0', plugin_sha: 'abc', proto: 1, regionSpec: 'rs-1', config_fingerprint: { filters: {}, autocrlf: '', eol_attrs: '', git: '2.47.0' }, coauthor_optin: false }],
    ['leave', leave()],
    ['caps', { type: 'caps', custom_refs: true, lease: true, delete: true, push_options: false, two_parent_ok: true }],
    ['seat_start', { type: 'seat_start', seat_id: SEAT, permission_mode: 'default' }],
    ['seat_end', { type: 'seat_end', seat_id: SEAT, permission_mode: 'default' }],
    ['claim', claim(1)],
    ['release', { type: 'release', claim_ids: ['cl-1'], reason: 'explicit' }],
    ['request', { type: 'request', req_id: ULID, kind: 'handoff', path: 'src/f1.ts', claim_ids: ['cl-1'] }],
    ['request_status', requestStatus()],
    ['note', { type: 'note', target: null, text: 'hello' }],
    ['presume_absent', { type: 'presume_absent', peer: OTHER_PEER, epoch: OTHER_EPOCH, last_seq_seen: 3 }],
    ['hold', { type: 'hold', hold_id: ULID, paths: ['src/f1.ts'] }],
    ['save', { type: 'save', save_commit: OID, saved_live: OID, chain_base: OID, released_claim_ids: [] }],
  ];
  for (const verb of ['accept', 'decline', 'later', 'release', 'grant']) out.push([`answer:${verb}`, answer(verb)]);
  const conflictCid = H('x', 'y');
  for (const kind of ['K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7', 'breach'] as const) out.push([`event:${kind}`, event(kind, 'CONFLICT_SEEN', conflictCid)]);
  for (const kind of ['freeze', 'unfreeze', 'incident', 'nonretryable'] as const) out.push([`event:${kind}`, event(kind, 'EPOCH_CHANGED')]);
  out.push(['event:health:HOST_THROTTLED', event('health', 'HOST_THROTTLED')]);
  out.push(['event:health:BOARD_FULL', event('health', 'BOARD_FULL')]);
  return out;
}

/** 02-protocol §3.8 "What may be pushed in which state", transcribed independently of the implementation. */
const FROZEN_ALLOWED = new Set([
  'event:freeze', 'event:unfreeze', 'event:health:HOST_THROTTLED', 'event:health:BOARD_FULL', // freeze-class and health events
  'answer:accept', 'answer:decline', 'answer:later', 'answer:release', 'answer:grant', 'request_status', // answer-class
  'release', 'seat_end', 'leave', // release-class
  'hold', // hold mirrors
]);
const VERSION_BOARD_ONLY_ALLOWED = new Set(['join', 'leave', 'seat_end', 'release', 'request_status', 'answer:decline', 'answer:later', 'answer:release', 'hold']);
const STATES: readonly PushState[] = ['ok', 'frozen', 'incident', 'config_net', 'offline', 'nonretryable', 'version_proto', 'version_board_only'];
function expected(state: PushState, label: string): boolean {
  switch (state) {
    case 'ok':
      return true;
    case 'frozen':
      return FROZEN_ALLOWED.has(label);
    case 'version_board_only':
      return VERSION_BOARD_ONLY_ALLOWED.has(label);
    default:
      return false; // FREEZE with INCIDENT, FREEZE with CONFIG(url|public), OFFLINE/AUTH, NONRETRYABLE, VERSION proto form
  }
}

const labelOf = (op: Op): string => {
  if (op.type === 'event') return op.kind === 'health' ? `event:health:${op.reason_code}` : `event:${op.kind}`;
  if (op.type === 'answer') return `answer:${String((op as { verb?: Json }).verb)}`;
  return op.type;
};

test('every op type in every PushState follows the 02-protocol §3.8 table; the most restrictive row wins', () => {
  const drafts = everyDraft();
  assert.equal(drafts.length, 32);
  for (const state of STATES) {
    for (const [label, d] of drafts) {
      assert.equal(allowedInState(d, state), expected(state, label), `${label} in ${state}`);
    }
    // T-PRO-23 in unit form: enqueue every op type, exactly the allowed ones leave, in seq order.
    const box = new Outbox();
    for (const [, d] of drafts) box.add(d);
    const want = drafts.filter(([label]) => expected(state, label)).map(([label]) => label);
    assert.equal(box.pendingAllowed([state]), want.length > 0, `pendingAllowed in ${state}`);
    const alloc = new Counter(1);
    const out = box.take([state], SELF, alloc, ROOM);
    assert.deepEqual(out.map(labelOf), want, `take in ${state}`);
    assert.equal(alloc.calls, want.length, `seqs are allocated only for placed ops in ${state}`);
    assert.equal(box.size, drafts.length, 'take leaves every op in the outbox until it lands');
    assert.doesNotThrow(() => serializeOps(out));
  }

  // Where rows overlap, the more restrictive one decides. FREEZE with INCIDENT and FREEZE with
  // CONFIG(url|public) are FREEZE rows too, but forbid even the plain FREEZE row's list.
  for (const [label, d] of drafts) {
    if (allowedInState(d, 'frozen')) {
      assert.equal(allowedInState(d, 'incident'), false, `${label}: INCIDENT forbids every outbox push`);
      assert.equal(allowedInState(d, 'config_net'), false, `${label}: CONFIG(url|public) forbids every push`);
    }
    // Nesting: every restricted row is a subset of ok; the empty rows are subsets of every row.
    for (const state of STATES) {
      if (allowedInState(d, state)) assert.equal(allowedInState(d, 'ok'), true, `${label}: ${state} ⊆ ok`);
    }
  }
  // HOST_THROTTLED (PRO-55) may leave in the ok and FREEZE rows, never in a VERSION row.
  const throttled = event('health', 'HOST_THROTTLED');
  assert.deepEqual(STATES.filter((s) => allowedInState(throttled, s)), ['ok', 'frozen']);
  // request and presume_absent leave only in the ok / degraded row.
  for (const label of ['request', 'presume_absent']) {
    const d = (drafts.find(([l]) => l === label) as [string, OpDraft])[1];
    assert.deepEqual(STATES.filter((s) => allowedInState(d, s)), ['ok'], label);
  }
  // The FREEZE row and the VERSION regionSpec row are incomparable: neither is a subset of the other,
  // so one PushState value cannot carry both; take and pendingAllowed take every active state (P2-PUSHSTATES).
  const frozenOnly = drafts.filter(([, d]) => allowedInState(d, 'frozen') && !allowedInState(d, 'version_board_only')).map(([l]) => l);
  const versionOnly = drafts.filter(([, d]) => allowedInState(d, 'version_board_only') && !allowedInState(d, 'frozen')).map(([l]) => l);
  assert.deepEqual(frozenOnly, ['answer:accept', 'answer:grant', 'event:freeze', 'event:unfreeze', 'event:health:HOST_THROTTLED', 'event:health:BOARD_FULL']);
  assert.deepEqual(versionOnly, ['join']);
});

test('FREEZE and the VERSION regionSpec pause together allow only the intersection; [] behaves like ok', () => {
  const drafts = everyDraft();
  // An EPOCH freeze plus checkpoint_mismatch (ruling P2-PUSHSTATES): an op leaves only if every active row allows it.
  const both: readonly PushState[] = ['frozen', 'version_board_only'];
  const want = ['leave', 'seat_end', 'release', 'request_status', 'hold', 'answer:decline', 'answer:later', 'answer:release'];
  const allowed = drafts.filter(([, d]) => allowedInAll(d, both)).map(([l]) => l);
  assert.deepEqual(allowed, want);
  const byLabel = (l: string): OpDraft => (drafts.find(([x]) => x === l) as [string, OpDraft])[1];
  assert.equal(allowedInState(byLabel('join'), 'version_board_only'), true);
  assert.equal(allowedInAll(byLabel('join'), both), false, 'join: VERSION allows it, FREEZE refuses it');
  assert.equal(allowedInState(byLabel('answer:accept'), 'frozen'), true);
  assert.equal(allowedInAll(byLabel('answer:accept'), both), false, 'answer accept: FREEZE allows it, VERSION refuses it');
  assert.equal(allowedInAll(event('health', 'HOST_THROTTLED'), both), false, 'no event leaves while VERSION holds');
  // The order of the states does not matter, a repeated state changes nothing, and one more empty row empties it.
  assert.deepEqual(drafts.filter(([, d]) => allowedInAll(d, ['version_board_only', 'frozen', 'frozen'])).map(([l]) => l), want);
  assert.deepEqual(drafts.filter(([, d]) => allowedInAll(d, [...both, 'offline'])).map(([l]) => l), []);
  // A one-element list is that row.
  for (const state of STATES) {
    for (const [label, d] of drafts) assert.equal(allowedInAll(d, [state]), allowedInState(d, state), `${label} in [${state}]`);
  }
  // An unknown state is refused, wherever it stands in the list.
  assert.throws(() => allowedInAll(leave(), ['ok', 'bogus' as PushState]), RangeError);
  assert.throws(() => allowedInAll(leave(), ['incident', 'bogus' as PushState]), RangeError);

  // take and pendingAllowed apply the intersection: oldest seq first among the ops both rows allow.
  const box = new Outbox();
  for (const [, d] of drafts) box.add(d);
  assert.equal(box.pendingAllowed(both), true);
  const alloc = new Counter(1);
  const out = box.take(both, SELF, alloc, ROOM);
  assert.deepEqual(out.map(labelOf), want);
  assert.equal(alloc.calls, want.length, 'no seq for an op either row refuses');
  const onlyRefused = new Outbox();
  onlyRefused.add(byLabel('join'));
  onlyRefused.add(byLabel('answer:accept'));
  onlyRefused.add(event('freeze', 'EPOCH_CHANGED'));
  assert.equal(onlyRefused.pendingAllowed(['frozen']), true);
  assert.equal(onlyRefused.pendingAllowed(['version_board_only']), true);
  assert.equal(onlyRefused.pendingAllowed(both), false, 'each op is allowed by one row, none by both');
  assert.deepEqual(onlyRefused.take(both, SELF, new Counter(1), ROOM), []);

  // [] (no restricting condition) is the ok row: every op leaves.
  for (const [label, d] of drafts) assert.equal(allowedInAll(d, []), true, label);
  const all = new Outbox();
  for (const [, d] of drafts) all.add(d);
  assert.equal(all.pendingAllowed([]), true);
  const viaEmpty = all.take([], SELF, new Counter(1), ROOM);
  assert.deepEqual(viaEmpty.map(labelOf), drafts.map(([l]) => l));
  assert.deepEqual(all.take(['ok'], SELF, new Counter(1_000), ROOM), viaEmpty, 'the same ops under the same ids as [ok]');
  assert.equal(new Outbox().pendingAllowed([]), false, 'nothing queued');
});

test('event drafts get cid = H(id, kind) at allocation and again after renumbering', () => {
  const alloc = new Counter(20);
  const box = new Outbox();
  box.add(event('health', 'HOST_THROTTLED'));
  box.add(event('freeze', 'EPOCH_CHANGED', H('stale', 'cid'))); // a non-conflict kind's cid is always its own H(id, kind)
  const conflictCid = H('winner-op', 'loser-op');
  box.add(event('K4', 'CONFLICT_SEEN', conflictCid)); // a conflict kind carries H(winner, loser), given by the caller
  box.add(claim(1)); // stays behind during FREEZE, so the health event lands without it

  const first = box.take(['frozen'], SELF, alloc, ROOM);
  assert.deepEqual(first.map(labelOf), ['event:health:HOST_THROTTLED', 'event:freeze']);
  const [health, freeze] = first as [Extract<Op, { type: 'event' }>, Extract<Op, { type: 'event' }>];
  assert.equal(health.cid, H(health.id, 'health'));
  assert.equal(health.cid, eventCid(health.id, 'health'));
  assert.equal(freeze.cid, H(freeze.id, 'freeze'));
  const writer = alloc.next();
  box.landed(new Set([freeze.id]), writer, alloc, SELF); // only the freeze event made it into the landed intent

  const second = box.take(['ok'], SELF, alloc, ROOM);
  assert.deepEqual(second.map(labelOf), ['event:health:HOST_THROTTLED', 'event:K4', 'claim']);
  const [health2, k4] = second as [Extract<Op, { type: 'event' }>, Extract<Op, { type: 'event' }>];
  assert.ok(seqOf(health2) > writer, 'renumbered above the landed writer seq');
  assert.notEqual(health2.id, health.id);
  assert.equal(health2.cid, H(health2.id, 'health'), 'the own-id cid is recomputed with the new id');
  assert.notEqual(health2.cid, health.cid);
  assert.equal(k4.cid, conflictCid, 'a conflict cid does not depend on the op id');

  // renumberAtOrBelow recomputes it too.
  box.renumberAtOrBelow(seqOf(k4), alloc, SELF);
  const third = box.take(['ok'], SELF, alloc, ROOM);
  const health3 = third.find((o) => labelOf(o) === 'event:health:HOST_THROTTLED') as Extract<Op, { type: 'event' }>;
  assert.ok(seqOf(health3) > seqOf(k4));
  assert.equal(health3.cid, H(health3.id, 'health'));
  assert.equal((third.find((o) => labelOf(o) === 'event:K4') as Extract<Op, { type: 'event' }>).cid, conflictCid);
});

test('take keeps within 1,000 ops and 64 KiB, oldest seq first', () => {
  // 1,200 leave ops: the 64 KiB cap binds before the 1,000-op cap (a leave line is ~90 bytes).
  const alloc = new Counter(1);
  const box = new Outbox();
  for (let i = 0; i < 1_200; i++) box.add(leave());
  const huge = { maxOps: 1_000_000, maxBytes: 1_000_000_000 }; // a room above the caps is clamped to them
  const first = box.take(['ok'], SELF, alloc, huge);
  const bytes = serializeOps(first).length;
  assert.ok(first.length <= OPS_MAX_LINES);
  assert.ok(bytes <= OPS_MAX_BYTES, `${bytes} <= ${OPS_MAX_BYTES}`);
  const line = Buffer.byteLength(canonicalJson(first[first.length - 1] as unknown as Json)) + 1;
  assert.ok(bytes + line + 16 > OPS_MAX_BYTES, `the window is filled (${bytes} bytes, one more line ~${line})`);
  assert.equal(alloc.calls, first.length, 'ops left out are not allocated a seq');
  assert.deepEqual(seqs(first), Array.from({ length: first.length }, (_, i) => i + 1), 'oldest first, consecutive seqs');

  // The rest leave in the following windows, in seq order, after the first window's ops landed.
  const writer = alloc.next();
  box.landed(new Set(first.map((o) => o.id)), writer, alloc, SELF);
  const second = box.take(['ok'], SELF, alloc, huge);
  assert.equal(first.length + second.length, 1_200);
  assert.ok(seqOf(second[0] as Op) > writer);
  assert.doesNotThrow(() => serializeOps(second));

  // The 1,000-op cap and a smaller room both bind.
  const box2 = new Outbox();
  for (let i = 0; i < 20; i++) box2.add(leave());
  assert.equal(box2.take(['ok'], SELF, new Counter(1), { maxOps: 7, maxBytes: OPS_MAX_BYTES }).length, 7);
  assert.equal(box2.take(['ok'], SELF, new Counter(100), { maxOps: OPS_MAX_LINES, maxBytes: 0 }).length, 0);

  // Big lines: four ~15 KiB events fit in 64 KiB, the fifth does not, and the small op behind it waits
  // too (oldest seq first: nothing jumps the queue to fill the gap).
  const big = (n: number): OpDraft => ({ type: 'event', cid: '', kind: 'incident', refs: Array.from({ length: 750 }, (_, i) => `r${n}-${String(i).padStart(14, '0')}`), reason_code: 'EPOCH_CHANGED' });
  const box3 = new Outbox();
  for (let i = 0; i < 5; i++) box3.add(big(i));
  box3.add(leave());
  const alloc3 = new Counter(1);
  const out3 = box3.take(['ok'], SELF, alloc3, ROOM);
  const lineBytes = Buffer.byteLength(canonicalJson(out3[0] as unknown as Json)) + 1;
  assert.ok(lineBytes > 15_000 && lineBytes <= 16_384, `big line ${lineBytes}`);
  assert.equal(out3.length, 4);
  assert.deepEqual(out3.map((o) => o.type), ['event', 'event', 'event', 'event']);
  assert.ok(serializeOps(out3).length <= OPS_MAX_BYTES);
  assert.equal(alloc3.calls, 4);
});

test('toJson and fromJson round-trip allocated ids', () => {
  const alloc = new Counter(41);
  const box = new Outbox();
  box.add(claim(1));
  box.add(event('health', 'HOST_THROTTLED'));
  box.add(leave());
  const placed = box.take(['frozen'], SELF, alloc, ROOM); // health (41) and leave (42) get ids; the claim does not
  assert.deepEqual(seqs(placed), [41, 42]);

  const j = box.toJson();
  const again = Outbox.fromJson(JSON.parse(JSON.stringify(j)) as Json);
  assert.equal(again.size, 3);
  assert.equal(canonicalJson(again.toJson()), canonicalJson(j), 'stable serialization');
  // The allocated ids survive: a rebuild after a restart places the same ops under the same ids.
  const alloc2 = new Counter(100);
  assert.deepEqual(again.take(['frozen'], SELF, alloc2, ROOM), placed);
  assert.equal(alloc2.calls, 0);
  const all = again.take(['ok'], SELF, alloc2, ROOM);
  assert.deepEqual(all.map(labelOf), ['event:health:HOST_THROTTLED', 'leave', 'claim']);
  assert.deepEqual(seqs(all), [41, 42, 100]);
  // The constructor takes the same entries.
  assert.equal(canonicalJson(new Outbox([]).toJson()), canonicalJson(new Outbox().toJson()));

  // Garbage is refused, never silently dropped (a swallowed entry would be a lost op).
  const placedLeave = placed[1] as unknown as Json;
  const garbage: Json[] = [
    null, 7, 'x', {}, [], { entries: 'x' },
    { entries: [null] },
    { entries: [{ draft: null, op: null }] },
    { entries: [{ draft: { type: 'nope' }, op: null }] },
    { entries: [{ draft: leave() as Json, op: { id: 'bad', type: 'leave' } }] },
    { entries: [{ draft: leave() as Json, op: placedLeave }, { draft: leave() as Json, op: placedLeave }] }, // one id twice
  ];
  for (const bad of garbage) assert.throws(() => Outbox.fromJson(bad), TypeError, canonicalJson(bad));
  // An op that does not match its draft is corrupt.
  const [first] = (JSON.parse(JSON.stringify(j)) as { entries: Array<{ draft: Json; op: Json }> }).entries as [{ draft: Json; op: Json }];
  const tampered = { ...(j as { entries: Json[] }), entries: [{ draft: claim(9) as Json, op: first.op }] };
  assert.throws(() => Outbox.fromJson(tampered as Json), TypeError);
});

test('drop removes matching drafts and add refuses a draft that cannot form a valid op', () => {
  const box = new Outbox();
  box.add(event('health', 'HOST_THROTTLED'));
  box.add(event('health', 'BOARD_FULL'));
  box.add(leave());
  const isThrottled = (d: OpDraft): boolean => d.type === 'event' && (d as { reason_code?: Json }).reason_code === 'HOST_THROTTLED';
  assert.equal(box.drop(isThrottled), 1);
  assert.equal(box.drop(isThrottled), 0);
  assert.equal(box.size, 2);
  assert.throws(() => box.add({ type: 'event', cid: '', kind: 'health', refs: [], reason_code: 'not a code' } as OpDraft), TypeError);
  assert.throws(() => box.add({ type: 'nope' } as unknown as OpDraft), TypeError);
  assert.throws(() => box.add({ type: 'claim', claim_id: 'x', path: '../escape' } as OpDraft), TypeError);
  assert.equal(box.size, 2);
});
