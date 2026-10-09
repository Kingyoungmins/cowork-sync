// Per-op verdicts of the fold (Plan 8a Task 2; 12 §3.3.3, §9.7 items 1 and 6; rulings R-V03, R-V04).
// foldCommit reports, for every ops.jsonl line of the draft, what the fold decided: effective, unfolded (a type
// this build folds as a no-op after generic validity, PLAN2_FOLDED_TYPES) or rejected (malformed, generic, type).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WriterId } from '../../../src/board/boardCommit.js';
import { canonicalJson, MAX_JSON_DEPTH, type Json } from '../../../src/board/canonicalJson.js';
import { foldCommit, initialFoldState, serializeFold, type FoldState, type OpVerdict } from '../../../src/board/fold.js';
import { eventCid, OPS_MAX_BYTES, OPS_MAX_LINES, parseOpLine, PLAN2_FOLDED_TYPES, type OpType } from '../../../src/board/ops.js';
import { ZERO_PEER } from '../../../src/viz/model/frame.js';
import { generateBoard } from '../../helpers/foldBoard.js';
import { draft, DRAFT_PROTOCOL } from '../../helpers/vizEvents.js';

const A = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
const B = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';
const EA = 'ea0aea0aea0aea0aea0aea0aea0aea0a';
const EA2 = 'ea2aea2aea2aea2aea2aea2aea2aea2a';
const EB = 'eb0beb0beb0beb0beb0beb0beb0beb0b';
const SEAT = '5ea75ea75ea75ea75ea75ea75ea75ea7';
const ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OID40 = 'c'.repeat(40);

const L = (o: Record<string, Json>): string => canonicalJson(o);
const id = (peer: string, epoch: string, seq: number): string => `${peer}/${epoch}/${seq}`;
const W = (peer: string, epoch: string, seq: number): WriterId => ({ peer, epoch, seq });

function joinL(peer: string, epoch: string, seq: number): string {
  return L({
    id: id(peer, epoch, seq), type: 'join', display: 'Peer', plugin_version: '0.2.0', plugin_sha: 'f'.repeat(64), proto: 1, regionSpec: 'rs-1',
    config_fingerprint: { filters: {}, autocrlf: '', eol_attrs: '', git: '2.47.1' }, coauthor_optin: false,
  });
}
const capsL = (peer: string, epoch: string, seq: number): string =>
  L({ id: id(peer, epoch, seq), type: 'caps', custom_refs: true, lease: true, delete: true, push_options: false, two_parent_ok: true });
const leaveL = (peer: string, epoch: string, seq: number): string => L({ id: id(peer, epoch, seq), type: 'leave' });
const seatStartL = (peer: string, epoch: string, seq: number): string => L({ id: id(peer, epoch, seq), type: 'seat_start', seat_id: SEAT, permission_mode: 'default' });
const seatEndL = (peer: string, epoch: string, seq: number): string => L({ id: id(peer, epoch, seq), type: 'seat_end', seat_id: SEAT, permission_mode: 'default' });
const eventL = (peer: string, epoch: string, seq: number, kind = 'freeze', cid?: string): string => {
  const i = id(peer, epoch, seq);
  return L({ id: i, type: 'event', cid: cid ?? eventCid(i, kind as 'freeze'), kind, refs: [], reason_code: 'TEST_REASON' });
};
const saveL = (peer: string, epoch: string, seq: number): string =>
  L({ id: id(peer, epoch, seq), type: 'save', save_commit: OID40, saved_live: OID40, chain_base: OID40, released_claim_ids: [] });

/** A generic-valid op of every type outside the Plan 2 fold's effects (opaque in Plan 2: only SEC-35 fields are checked). */
const UNFOLDED_SAMPLES: Readonly<Record<string, (i: string) => string>> = {
  claim: (i) => L({ id: i, type: 'claim', path: 'src/a.ts', claim_id: 'abcdefghijklmnop' }),
  release: (i) => L({ id: i, type: 'release', claim_id: 'abcdefghijklmnop' }),
  request: (i) => L({ id: i, type: 'request', path: 'src/a.ts', req_id: ULID }),
  request_status: (i) => L({ id: i, type: 'request_status', req_id: ULID, status: 'open' }),
  answer: (i) => L({ id: i, type: 'answer', req_id: ULID, text: 'ok' }),
  note: (i) => L({ id: i, type: 'note', target: null, text: 'hi' }),
  presume_absent: (i) => L({ id: i, type: 'presume_absent', peer: B }),
  hold: (i) => L({ id: i, type: 'hold', hold_id: ULID, paths: ['src/a.ts'] }),
};

/** Every OpType, so a new type fails the typecheck here until the tripwire below knows it. */
const ALL_TYPES: Record<OpType, true> = {
  join: true, leave: true, caps: true, seat_start: true, seat_end: true, claim: true, release: true, request: true, request_status: true,
  answer: true, note: true, presume_absent: true, hold: true, event: true, save: true,
};

/** B0 by A (join, caps) folded from the empty state: A is active in epoch EA with last_seq 3. */
function genesis(): FoldState {
  return foldCommit(initialFoldState(DRAFT_PROTOCOL), draft({ writer: W(A, EA, 3), opsLines: [joinL(A, EA, 1), capsL(A, EA, 2)] }), A).state;
}

const v = (line: number, opId: string | null, type: OpVerdict['type'], verdict: OpVerdict['verdict'], reason?: OpVerdict['reason']): OpVerdict =>
  (reason === undefined ? { line, opId, type, verdict } : { line, opId, type, verdict, reason });

test('opVerdicts has one entry per ops.jsonl line, in order', () => {
  const s0 = genesis();
  // An empty board commit.
  assert.deepEqual(foldCommit(s0, draft({ writer: W(A, EA, 4), opsLines: [] }), A).opVerdicts, []);

  // 1,000 lines: every tenth a valid event of A (seqs increasing), the rest malformed.
  const lines: string[] = [];
  let seq = 3;
  for (let i = 0; i < OPS_MAX_LINES; i++) lines.push(i % 10 === 0 ? eventL(A, EA, ++seq) : '[]');
  const thousand = foldCommit(s0, draft({ writer: W(A, EA, seq + 1), opsLines: lines }), A).opVerdicts;
  assert.equal(thousand.length, OPS_MAX_LINES);
  thousand.forEach((x, i) => {
    assert.equal(x.line, i);
    if (i % 10 === 0) assert.deepEqual(x, v(i, id(A, EA, 4 + i / 10), 'event', 'effective'));
    else assert.deepEqual(x, v(i, null, 'unknown', 'rejected', 'malformed'));
  });

  // Past the 1,000-line bound: one entry per line still, the extra lines are never read (generic).
  const extra = [...lines, eventL(A, EA, seq + 1), '[]', 'x'];
  const over = foldCommit(s0, draft({ writer: W(A, EA, seq + 2), opsLines: extra }), A).opVerdicts;
  assert.equal(over.length, OPS_MAX_LINES + 3);
  for (let i = OPS_MAX_LINES; i < extra.length; i++) assert.deepEqual(over[i], v(i, null, 'unknown', 'rejected', 'generic'));

  // A commit whose writer is null: every line rejected/generic, whatever it holds.
  const none = foldCommit(s0, draft({ writer: null, opsLines: [eventL(A, EA, 4), '{"truncated":', leaveL(A, EA, 5)] }), A).opVerdicts;
  assert.deepEqual(none, [v(0, null, 'unknown', 'rejected', 'generic'), v(1, null, 'unknown', 'rejected', 'generic'), v(2, null, 'unknown', 'rejected', 'generic')]);
  // A writer the fold cannot attribute (seq 0) is the same as none.
  const bad = foldCommit(s0, draft({ writer: W(A, EA, 0), opsLines: [eventL(A, EA, 4)] }), A).opVerdicts;
  assert.deepEqual(bad, [v(0, null, 'unknown', 'rejected', 'generic')]);
});

test('effective for join, leave, caps, seat_start, seat_end, event and save; unfolded for claim, release, request, request_status, answer, note, presume_absent and hold; rejected with malformed, generic or type', () => {
  const s0 = genesis();

  // Every type once, generic-valid, in one commit of A (leave last: it ends A's activity).
  const kinds: Array<[OpType, (i: string) => string]> = [
    ['join', (i) => joinL(A, EA, Number(i.split('/')[2]))],
    ['caps', (i) => capsL(A, EA, Number(i.split('/')[2]))],
    ['seat_start', (i) => seatStartL(A, EA, Number(i.split('/')[2]))],
    ['seat_end', (i) => seatEndL(A, EA, Number(i.split('/')[2]))],
    ['event', (i) => eventL(A, EA, Number(i.split('/')[2]))],
    ['save', (i) => saveL(A, EA, Number(i.split('/')[2]))],
    ...Object.entries(UNFOLDED_SAMPLES).map(([t, f]) => [t as OpType, f] as [OpType, (i: string) => string]),
    ['leave', (i) => leaveL(A, EA, Number(i.split('/')[2]))],
  ];
  const lines = kinds.map(([, f], k) => f(id(A, EA, 4 + k)));
  const r = foldCommit(s0, draft({ writer: W(A, EA, 4 + kinds.length), opsLines: lines }), A);
  assert.deepEqual(r.opVerdicts, kinds.map(([t], k) => v(k, id(A, EA, 4 + k), t, PLAN2_FOLDED_TYPES.has(t) ? 'effective' : 'unfolded')));
  assert.equal(r.state.peers[A]!.status, 'left');

  // malformed: bad JSON, nesting past MAX_JSON_DEPTH, an id parseOpId refuses, an unknown type.
  let deep: Json = 'x';
  for (let d = 0; d < MAX_JSON_DEPTH + 1; d++) deep = [deep];
  const malformed = [
    '{"id":',
    JSON.stringify({ id: id(A, EA, 4), type: 'note', target: null, text: 'deep', extra: deep }),   // canonicalJson refuses it
    L({ id: `${A}/${EA}/9007199254740993`, type: 'leave' }),
    L({ id: id(A, EA, 5), type: 'dance' }),
  ];
  const m = foldCommit(s0, draft({ writer: W(A, EA, 9), opsLines: malformed }), A).opVerdicts;
  assert.deepEqual(m, malformed.map((_, i) => v(i, null, 'unknown', 'rejected', 'malformed')));
  // An id parseOpId refuses gets the same verdict whichever check refuses it: parseOpLine refuses it today (so the
  // fold's own parseOpId guard is a second line of defence that reports the same thing).
  for (const line of malformed) assert.equal(parseOpLine(line), null, line.slice(0, 60));

  // generic: a wrong writer, a seq at or below last_seq, out-of-order seqs, a duplicated op id (the first decides).
  const g = [
    eventL(B, EB, 4),            // another peer's op in A's commit
    eventL(A, EA, 3),            // seq 3 <= last_seq 3
    eventL(A, EA, 8),            // effective
    eventL(A, EA, 7),            // below the previous op of the commit
    eventL(A, EA, 9),            // effective
    eventL(A, EA, 9),            // the same op id again
    eventL(A, EA, 20),           // not below the writer seq 12
  ];
  const gv = foldCommit(s0, draft({ writer: W(A, EA, 12), opsLines: g }), A).opVerdicts;
  assert.deepEqual(gv, [
    v(0, id(B, EB, 4), 'event', 'rejected', 'generic'),
    v(1, id(A, EA, 3), 'event', 'rejected', 'generic'),
    v(2, id(A, EA, 8), 'event', 'effective'),
    v(3, id(A, EA, 7), 'event', 'rejected', 'generic'),
    v(4, id(A, EA, 9), 'event', 'effective'),
    v(5, id(A, EA, 9), 'event', 'rejected', 'generic'),
    v(6, id(A, EA, 20), 'event', 'rejected', 'generic'),
  ]);

  // generic: a retired epoch (A rejoined in EA2; a later commit written in EA).
  const s1 = foldCommit(s0, draft({ writer: W(A, EA2, 2), opsLines: [joinL(A, EA2, 1)] }), A).state;
  assert.deepEqual(s1.peers[A]!.retired_epochs, [EA]);
  const retired = foldCommit(s1, draft({ writer: W(A, EA, 20), opsLines: [eventL(A, EA, 10)] }), A).opVerdicts;
  assert.deepEqual(retired, [v(0, id(A, EA, 10), 'event', 'rejected', 'generic')]);

  // generic: an op past the 64 KiB loop bound (the line whose LF crosses it, and every line after it).
  const pad = (seq: number): string => L({ id: id(A, EA, seq), type: 'note', target: null, text: 'p'.repeat(15_000) });
  const big: string[] = [];
  let bytes = 0;
  let seq = 3;
  while (bytes <= OPS_MAX_BYTES) {
    const line = pad(++seq);
    big.push(line);
    bytes += Buffer.byteLength(line, 'utf8') + 1;
  }
  const cut = big.length - 1;   // its LF lies past 64 KiB
  big.push(eventL(A, EA, ++seq));
  const bv = foldCommit(s0, draft({ writer: W(A, EA, seq + 1), opsLines: big }), A).opVerdicts;
  assert.equal(bv.length, big.length);
  for (let i = 0; i < cut; i++) assert.deepEqual(bv[i], v(i, id(A, EA, 4 + i), 'note', 'unfolded'));
  assert.deepEqual(bv[cut], v(cut, null, 'unknown', 'rejected', 'generic'));
  assert.deepEqual(bv[cut + 1], v(cut + 1, null, 'unknown', 'rejected', 'generic'));

  // type: a seat_start of a live seat; a conflict-kind event whose cid is already folded.
  const cid = 'K1CXD234';
  const live = foldCommit(s0, draft({ writer: W(A, EA, 6), opsLines: [seatStartL(A, EA, 4), eventL(A, EA, 5, 'K1', cid)] }), A);
  assert.deepEqual(live.opVerdicts, [v(0, id(A, EA, 4), 'seat_start', 'effective'), v(1, id(A, EA, 5), 'event', 'effective')]);
  const again = foldCommit(live.state, draft({ writer: W(A, EA, 9), opsLines: [seatStartL(A, EA, 7), eventL(A, EA, 8, 'K1', cid)] }), A);
  assert.deepEqual(again.opVerdicts, [v(0, id(A, EA, 7), 'seat_start', 'rejected', 'type'), v(1, id(A, EA, 8), 'event', 'rejected', 'type')]);
});

test('state and opVerdicts do not depend on self', () => {
  const gen = generateBoard('p8a-verdicts-self', 600);
  const selves = [...gen.peers, ZERO_PEER];
  const runs = selves.map((self) => {
    let s = initialFoldState(gen.protocol);
    const out: Array<{ state: Buffer; verdicts: OpVerdict[] }> = [];
    for (const c of gen.commits) {
      const r = foldCommit(s, draft({ writer: c.writer, protocol: gen.protocol, opsLines: c.lines }), self);
      s = r.state;
      out.push({ state: serializeFold(s), verdicts: r.opVerdicts });
    }
    return out;
  });
  let rejected = 0;
  let effective = 0;
  for (let h = 0; h < gen.commits.length; h++) {
    const base = runs[0]![h]!;
    assert.equal(base.verdicts.length, gen.commits[h]!.lines.length);
    for (const verdict of base.verdicts) {
      if (verdict.verdict === 'rejected') rejected++;
      if (verdict.verdict === 'effective') effective++;
    }
    for (let k = 1; k < runs.length; k++) {
      assert.ok(runs[k]![h]!.state.equals(base.state), `height ${h}: the state differs for self ${selves[k]}`);
      assert.deepEqual(runs[k]![h]!.verdicts, base.verdicts, `height ${h}: the verdicts differ for self ${selves[k]}`);
    }
  }
  // The generated board exercises both outcomes (a vacuous board could not tell).
  assert.ok(rejected > 50 && effective > 50, `rejected ${rejected}, effective ${effective}`);
});

test('tripwire: every OpType outside PLAN2_FOLDED_TYPES folds as a no-op', () => {
  const unfolded = (Object.keys(ALL_TYPES) as OpType[]).filter((t) => !PLAN2_FOLDED_TYPES.has(t));
  assert.ok(unfolded.length > 0);
  const s0 = genesis();
  for (const t of unfolded) {
    const sample = UNFOLDED_SAMPLES[t];
    assert.ok(sample !== undefined, `no generic-valid sample of ${t}: add one when a type joins the unfolded set`);
    const line = sample(id(A, EA, 4));
    const withOp = foldCommit(s0, draft({ writer: W(A, EA, 5), opsLines: [line] }), A);
    const without = foldCommit(s0, draft({ writer: W(A, EA, 5), opsLines: [] }), A);
    assert.deepEqual(withOp.opVerdicts, [v(0, id(A, EA, 4), t, 'unfolded')], t);
    // Equal except the writer's last_seq (the op's seq is a seq the writer used).
    const norm = (s: FoldState): Buffer => serializeFold({ ...s, peers: { ...s.peers, [A]: { ...s.peers[A]!, last_seq: 0 } } });
    assert.ok(norm(withOp.state).equals(norm(without.state)), `${t} changed the fold state: move it into PLAN2_FOLDED_TYPES with its effect (R-V03)`);
  }
});
