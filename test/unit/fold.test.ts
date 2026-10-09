// The fold (Plan 2 Task 6): 02-protocol §3.3 7-step algorithm and generic validity, the Plan 2 op effects
// (ruling R-12), the ranked set and governor rank (PRO-39), teamRegionSpec unanimity (PRO-48) and the
// PRO-55 restart look-back. Pure unit tests over BoardDrafts; the git-reading Folder is in
// test/integration/folder.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BoardDraft, WriterId } from '../../src/board/boardCommit.js';
import { canonicalJson, type Json } from '../../src/board/canonicalJson.js';
import { H } from '../../src/board/ids.js';
import { eventCid, type EventKind } from '../../src/board/ops.js';
import { genesisProtocol, type ProtocolJson } from '../../src/board/protocol.js';
import {
  CHECKPOINT_EVERY,
  COMPACT_AGE,
  foldCommit,
  governorRank,
  initialFoldState,
  K_EVICT,
  liveSet,
  parseFold,
  rankedSet,
  recentThrottleEvent,
  REPLAY_MAX,
  serializeFold,
  type FoldState,
  type FoldStepResult,
  type OwnRejection,
} from '../../src/board/fold.js';
import type { Oid } from '../../src/git/oid.js';

const SELF = '5e1f5e1f5e1f5e1f5e1f5e1f5e1f5e1f';
const OTHER = '07e207e207e207e207e207e207e207e2';
const E1 = 'e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1';
const E2 = 'e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2';
const E3 = 'e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3';
const EO ='0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e';
const SEAT1 = '5ea15ea15ea15ea15ea15ea15ea15ea1';
const SEAT2 = '5ea25ea25ea25ea25ea25ea25ea25ea2';
const SEAT3 = '5ea35ea35ea35ea35ea35ea35ea35ea3';
const L0 = '1'.repeat(40) as Oid;
const OID = (c: string): string => c.repeat(40);
const RS1 = 'rs-1';
const PROTOCOL: ProtocolJson = genesisProtocol(12, RS1);

const opId = (peer: string, epoch: string, seq: number): string => `${peer}/${epoch}/${seq}`;
const W = (peer: string, epoch: string, seq: number): WriterId => ({ peer, epoch, seq });
const L = (o: Record<string, Json>): string => canonicalJson(o);

function joinL(peer: string, epoch: string, seq: number, regionSpec = RS1, display = 'Peer'): string {
  return L({
    id: opId(peer, epoch, seq), type: 'join', display, plugin_version: '0.2.0', plugin_sha: 'f'.repeat(64), proto: 1, regionSpec,
    config_fingerprint: { filters: {}, autocrlf: '', eol_attrs: '', git: '2.47.1' }, coauthor_optin: false,
  });
}
const leaveL = (peer: string, epoch: string, seq: number): string => L({ id: opId(peer, epoch, seq), type: 'leave' });
const seatStartL = (peer: string, epoch: string, seq: number, seat: string, mode = 'default'): string =>
  L({ id: opId(peer, epoch, seq), type: 'seat_start', seat_id: seat, permission_mode: mode });
const seatEndL = (peer: string, epoch: string, seq: number, seat: string): string =>
  L({ id: opId(peer, epoch, seq), type: 'seat_end', seat_id: seat, permission_mode: 'default' });
const capsL = (peer: string, epoch: string, seq: number): string =>
  L({ id: opId(peer, epoch, seq), type: 'caps', custom_refs: true, lease: true, delete: false, push_options: false, two_parent_ok: true });

function eventL(
  peer: string, epoch: string, seq: number, kind: EventKind = 'freeze',
  o: { cid?: string; refs?: string[]; reason_code?: string; extra?: Record<string, Json> } = {},
): string {
  const id = opId(peer, epoch, seq);
  return L({ ...(o.extra ?? {}), id, type: 'event', cid: o.cid ?? eventCid(id, kind), kind, refs: o.refs ?? [], reason_code: o.reason_code ?? 'EPOCH_CHANGED' });
}
const cidOf = (peer: string, epoch: string, seq: number, kind: EventKind = 'freeze'): string => eventCid(opId(peer, epoch, seq), kind);

function draft(writer: WriterId | null, lines: readonly string[], protocol: ProtocolJson = PROTOCOL): BoardDraft {
  return { liveCode: L0, writer, cs: [], protocol, opsLines: [...lines], checkpoint: null, heldIds: [] };
}

/** One board folded commit by commit, as `self` sees it. */
class Board {
  state: FoldState;
  constructor(readonly self: string, protocol: ProtocolJson = PROTOCOL) {
    this.state = initialFoldState(protocol);
  }
  commit(writer: WriterId | null, lines: readonly string[], protocol: ProtocolJson = PROTOCOL): FoldStepResult {
    const r = foldCommit(this.state, draft(writer, lines, protocol), this.self);
    this.state = r.state;
    return r;
  }
}

const rej = (id: string, type: OwnRejection['type'], reason: OwnRejection['reason']): OwnRejection => ({ opId: id, type, reason });
const eventIds = (s: FoldState): string[] => Object.values(s.events).map((e) => e.op_id).sort();

test('the fold constants are the glossary §20 board numbers', () => {
  assert.equal(CHECKPOINT_EVERY, 256);
  assert.equal(COMPACT_AGE, 512);
  assert.equal(K_EVICT, 200);
  assert.equal(REPLAY_MAX, 255);
});

test('generic validity for the Plan 2 types gives the exact no-op and own-rejection sets', () => {
  const b = new Board(SELF);
  b.commit(W(OTHER, EO, 3), [joinL(OTHER, EO, 1), capsL(OTHER, EO, 2)]);
  b.commit(W(SELF, E1, 11), [joinL(SELF, E1, 10)]);
  assert.equal(b.state.peers[SELF]?.last_seq, 11);

  // An own commit mixing every generic failure with valid ops.
  const padded = eventL(SELF, E1, 16, 'freeze', { extra: { pad: 'x'.repeat(16_400) } });
  assert.ok(Buffer.byteLength(padded, 'utf8') > 16_384);
  const r = b.commit(W(SELF, E1, 40), [
    eventL(OTHER, E1, 20),                                   // wrong writer: another peer, the writer's epoch, a seq that passes every other check
    eventL(SELF, E1, 11),                                    // seq <= last_seq
    eventL(SELF, E1, 13),                                    // valid
    eventL(SELF, E1, 12),                                    // out of order within the commit
    L({ id: opId(SELF, E1, 14), type: 'bogus' }),            // unknown type
    eventL(SELF, E1, 15, 'freeze', { extra: { zzz: 1 } }),   // unknown field: ignored, valid
    padded,                                                  // a line over 16 KiB
    eventL(SELF, E1, 17),                                    // valid
    eventL(SELF, E1, 40),                                    // seq not below the writer seq
  ]);
  assert.deepEqual(eventIds(b.state), [opId(SELF, E1, 13), opId(SELF, E1, 15), opId(SELF, E1, 17)].sort());
  assert.deepEqual(Object.keys(b.state.events[cidOf(SELF, E1, 15)] ?? {}).sort(), ['height', 'kind', 'op_id', 'reason_code', 'refs']);
  assert.deepEqual(r.ownRejections, [
    rej(opId(OTHER, E1, 20), 'event', 'generic'),
    rej(opId(SELF, E1, 11), 'event', 'generic'),
    rej(opId(SELF, E1, 12), 'event', 'generic'),
    rej(opId(SELF, E1, 14), 'unknown', 'type'),
    rej(opId(SELF, E1, 16), 'event', 'type'),
    rej(opId(SELF, E1, 40), 'event', 'generic'),
  ]);
  assert.deepEqual(r.landedOwnOpIds, [opId(SELF, E1, 13), opId(SELF, E1, 15), opId(SELF, E1, 17)]);
  assert.equal(b.state.peers[SELF]?.last_seq, 40);

  // Another writer's commit: its no-ops are not own rejections, even when a forged op names this peer.
  const before = eventIds(b.state);
  const r2 = b.commit(W(OTHER, EO, 50), [eventL(SELF, E1, 41), eventL(OTHER, EO, 3)]);
  assert.deepEqual(eventIds(b.state), before);
  assert.deepEqual(r2.ownRejections, []);
  assert.deepEqual(r2.landedOwnOpIds, []);

  // Inactive epoch: after leave only a join is valid.
  b.commit(W(SELF, E1, 42), [leaveL(SELF, E1, 41)]);
  assert.equal(b.state.peers[SELF]?.status, 'left');
  const r3 = b.commit(W(SELF, E1, 45), [eventL(SELF, E1, 43), seatStartL(SELF, E1, 44, SEAT1)]);
  assert.deepEqual(r3.ownRejections, [rej(opId(SELF, E1, 43), 'event', 'generic'), rej(opId(SELF, E1, 44), 'seat_start', 'generic')]);
  assert.deepEqual(eventIds(b.state), before);
  assert.deepEqual(b.state.seats, {});
  assert.equal(b.state.peers[SELF]?.last_seq, 45);

  // Retired epoch: a join from E2 retires E1; everything E1 writes afterwards is a no-op, join included.
  b.commit(W(SELF, E2, 2), [joinL(SELF, E2, 1)]);
  assert.deepEqual(b.state.peers[SELF]?.retired_epochs, [E1]);
  const r4 = b.commit(W(SELF, E1, 50), [eventL(SELF, E1, 46), joinL(SELF, E1, 47)]);
  assert.deepEqual(r4.ownRejections, [rej(opId(SELF, E1, 46), 'event', 'generic'), rej(opId(SELF, E1, 47), 'join', 'generic')]);
  assert.equal(b.state.peers[SELF]?.epoch, E2);
  assert.equal(b.state.peers[SELF]?.last_seq, 2, 'a commit of a retired epoch does not move the recorded epoch counter');
  assert.equal(b.state.peers[SELF]?.last_height, b.state.height, 'but it consumed a window');

  // Line 1,001 is never read.
  const blanks = Array.from({ length: 999 }, () => '');
  const r5 = b.commit(W(SELF, E2, 10), [...blanks, eventL(SELF, E2, 3), eventL(SELF, E2, 4)]);
  assert.deepEqual(r5.landedOwnOpIds, [opId(SELF, E2, 3)]);
  assert.deepEqual(r5.ownRejections, [], 'blank lines carry no op id, and line 1,001 is not read');
  assert.ok(b.state.events[cidOf(SELF, E2, 3)] !== undefined);
  assert.equal(b.state.events[cidOf(SELF, E2, 4)], undefined);

  // Lines whose LF lies past the first 64 KiB are never read.
  const big = (seq: number): string => eventL(SELF, E2, seq, 'freeze', { extra: { pad: 'y'.repeat(9_850) } });
  assert.ok(Buffer.byteLength(big(11), 'utf8') < 16_384 && Buffer.byteLength(big(11), 'utf8') > 9_900);
  const lines = [11, 12, 13, 14, 15, 16, 17].map(big);
  const sizes = lines.map((l) => Buffer.byteLength(l, 'utf8') + 1);
  assert.ok(sizes.slice(0, 6).reduce((a, n) => a + n, 0) <= 65_536 && sizes.reduce((a, n) => a + n, 0) > 65_536);
  const r6 = b.commit(W(SELF, E2, 30), lines);
  assert.deepEqual(r6.landedOwnOpIds, [11, 12, 13, 14, 15, 16].map((s) => opId(SELF, E2, s)));
  assert.deepEqual(r6.ownRejections, []);
  assert.equal(b.state.events[cidOf(SELF, E2, 17)], undefined);

  // The epoch half of the writer check: the writer's peer with another epoch (the retired E1, an unknown E3),
  // seqs above last_seq (30) and below the writer seq, in order — only (peer, epoch) can reject them.
  const before7 = eventIds(b.state);
  const r7 = b.commit(W(SELF, E2, 60), [eventL(SELF, E1, 55), eventL(SELF, E3, 56)]);
  assert.deepEqual(r7.ownRejections, [rej(opId(SELF, E1, 55), 'event', 'generic'), rej(opId(SELF, E3, 56), 'event', 'generic')]);
  assert.deepEqual(r7.landedOwnOpIds, []);
  assert.deepEqual(eventIds(b.state), before7);
  assert.equal(b.state.peers[SELF]?.last_seq, 60);
});

test('[join(1), seat_start(2), event(3)] with writer seq 4 from a new epoch after last_seq 4,812 folds valid and sets last_seq 4', () => {
  const b = new Board(OTHER);
  b.commit(W(OTHER, E1, 4_812), [joinL(OTHER, E1, 4_811)]);
  assert.equal(b.state.peers[OTHER]?.last_seq, 4_812);
  const r = b.commit(W(OTHER, E2, 4), [joinL(OTHER, E2, 1), seatStartL(OTHER, E2, 2, SEAT1, 'acceptEdits'), eventL(OTHER, E2, 3)]);
  assert.deepEqual(r.ownRejections, []);
  assert.deepEqual(r.landedOwnOpIds, [opId(OTHER, E2, 1), opId(OTHER, E2, 2), opId(OTHER, E2, 3)]);
  const p = b.state.peers[OTHER];
  assert.ok(p !== undefined);
  assert.equal(p.epoch, E2);
  assert.equal(p.status, 'active');
  assert.deepEqual(p.retired_epochs, [E1]);
  assert.equal(p.last_seq, 4);
  assert.equal(p.last_height, 1);
  assert.deepEqual(b.state.seats[`${OTHER}/${E2}/${SEAT1}`], { status: 'live', permission_mode: 'acceptEdits' });
  assert.deepEqual(b.state.events[cidOf(OTHER, E2, 3)], { kind: 'freeze', refs: [], reason_code: 'EPOCH_CHANGED', op_id: opId(OTHER, E2, 3), height: 1 });
});

test('a join of a new epoch retires the old one; leave; a rejoin after leave', () => {
  const b = new Board(SELF);
  b.commit(W(OTHER, E1, 3), [joinL(OTHER, E1, 1), seatStartL(OTHER, E1, 2, SEAT1)]);
  assert.deepEqual(liveSet(b.state), [OTHER]);

  // h1: a join from E2 retires E1 and ends E1's seats.
  b.commit(W(OTHER, E2, 2), [joinL(OTHER, E2, 1, RS1, 'Renamed')]);
  let p = b.state.peers[OTHER]!;
  assert.equal(p.epoch, E2);
  assert.deepEqual(p.retired_epochs, [E1]);
  assert.equal(p.display, 'Renamed');
  assert.deepEqual(b.state.seats[`${OTHER}/${E1}/${SEAT1}`], { status: 'ended', permission_mode: 'default', ended_height: 1 });

  // h2: the retired epoch can no longer write anything.
  b.commit(W(OTHER, E1, 10), [eventL(OTHER, E1, 5), joinL(OTHER, E1, 6)]);
  assert.deepEqual(b.state.events, {});
  assert.equal(b.state.peers[OTHER]!.epoch, E2);

  // h3: a seat, then leave in the same commit: the seat ends with the epoch.
  b.commit(W(OTHER, E2, 5), [seatStartL(OTHER, E2, 3, SEAT2), leaveL(OTHER, E2, 4)]);
  p = b.state.peers[OTHER]!;
  assert.equal(p.status, 'left');
  assert.deepEqual(b.state.seats[`${OTHER}/${E2}/${SEAT2}`], { status: 'ended', permission_mode: 'default', ended_height: 3 });
  assert.deepEqual(liveSet(b.state), []);

  // h4: a left epoch writes no seat.
  b.commit(W(OTHER, E2, 8), [seatStartL(OTHER, E2, 6, SEAT3)]);
  assert.equal(b.state.seats[`${OTHER}/${E2}/${SEAT3}`], undefined);
  assert.equal(b.state.peers[OTHER]!.last_seq, 8);

  // h5: a rejoin of the same epoch is active again, keeps its counter and may write at once.
  b.commit(W(OTHER, E2, 12), [joinL(OTHER, E2, 10, RS1, 'Back'), seatStartL(OTHER, E2, 11, SEAT3)]);
  p = b.state.peers[OTHER]!;
  assert.equal(p.status, 'active');
  assert.equal(p.epoch, E2);
  assert.deepEqual(p.retired_epochs, [E1]);
  assert.equal(p.display, 'Back');
  assert.equal(p.last_seq, 12);
  assert.deepEqual(b.state.seats[`${OTHER}/${E2}/${SEAT3}`], { status: 'live', permission_mode: 'default' });
  assert.deepEqual(liveSet(b.state), [OTHER]);

  // A seat end, and a seat restart after it.
  b.commit(W(OTHER, E2, 15), [seatEndL(OTHER, E2, 13, SEAT3), seatStartL(OTHER, E2, 14, SEAT3, 'plan')]);
  assert.deepEqual(b.state.seats[`${OTHER}/${E2}/${SEAT3}`], { status: 'live', permission_mode: 'plan' });
});

test('claim, release, request, request_status, answer, note, presume_absent and hold fold as no-ops', () => {
  const b = new Board(SELF);
  b.commit(W(SELF, E1, 3), [joinL(SELF, E1, 1), seatStartL(SELF, E1, 2, SEAT1)]);
  b.commit(W(OTHER, EO, 2), [joinL(OTHER, EO, 1)]);
  const reqId = '01J9ZQ3C5X0000000000000000';
  const opaque = (writer: string, epoch: string, first: number): string[] => [
    L({ id: opId(writer, epoch, first), type: 'claim', claim_id: 'abcdefghijklmnop', path: 'src/a.ts', anchor: OID('a'), base_blob: OID('b'), ranges: [[1, 2]], tombstones: [], granularity: 'block', label: { kind: 'fn' }, regionSpec: RS1, cs_id: `${SEAT1}/1`, holder: { peer: writer, seat: SEAT1, agent: 'main' } }),
    L({ id: opId(writer, epoch, first + 1), type: 'release', claim_ids: ['abcdefghijklmnop'], reason: 'explicit' }),
    L({ id: opId(writer, epoch, first + 2), type: 'request', req_id: reqId, kind: 'handoff', ckind: 'claim_visible', path: 'src/a.ts', attempt: 1 }),
    L({ id: opId(writer, epoch, first + 3), type: 'request_status', req_id: reqId, status: 'asked' }),
    L({ id: opId(writer, epoch, first + 4), type: 'answer', req_id: reqId, verb: 'decline', by: 'human', reason_code: 'REQUEST_DECLINED' }),
    L({ id: opId(writer, epoch, first + 5), type: 'note', target: null, text: 'hello' }),
    L({ id: opId(writer, epoch, first + 6), type: 'presume_absent', peer: OTHER, epoch: EO, last_seq_seen: 1 }),
    L({ id: opId(writer, epoch, first + 7), type: 'hold', hold_id: reqId, rev: 1, prev_rev: null, paths: ['src/a.ts'], local_only: false }),
  ];

  for (const [writer, epoch, first, seqC] of [[SELF, E1, 4, 12], [OTHER, EO, 3, 11]] as const) {
    const before = b.state;
    const lines = opaque(writer, epoch, first);
    const r = b.commit(W(writer, epoch, seqC), lines);
    assert.deepEqual(r.ownRejections, [], `${writer === SELF ? 'own' : 'teammate'} Plan 2 no-op types are not rejections`);
    assert.deepEqual(r.landedOwnOpIds, writer === SELF ? lines.map((l) => (JSON.parse(l) as { id: string }).id) : []);
    // Only the step-5 counters and the height move.
    const expected = structuredClone(before);
    expected.height = before.height + 1;
    expected.peers[writer]!.last_height = before.height + 1;
    expected.peers[writer]!.last_seq = seqC;
    assert.equal(serializeFold(b.state).toString('utf8'), serializeFold(expected).toString('utf8'));
    for (const k of ['claims', 'requests', 'holds', 'notes'] as const) assert.deepEqual(b.state[k], {});
  }
});

test('a conflict-kind event whose cid is folded is a no-op; a non-conflict event records op_id and height', () => {
  const b = new Board(SELF);
  b.commit(W(SELF, E1, 2), [joinL(SELF, E1, 1)]);
  b.commit(W(OTHER, EO, 2), [joinL(OTHER, EO, 1)]);
  const CID = H(opId(OTHER, EO, 1), opId(SELF, E1, 1));

  const r1 = b.commit(W(OTHER, EO, 5), [eventL(OTHER, EO, 3, 'K4', { cid: CID, refs: ['src/a.ts'], reason_code: 'CONFLICT_K4' })]);
  assert.deepEqual(r1.ownRejections, []);
  const first = { kind: 'K4', refs: ['src/a.ts'], reason_code: 'CONFLICT_K4', op_id: opId(OTHER, EO, 3), height: 2 };
  assert.deepEqual(b.state.events[CID], first);

  // The same cid again, from a teammate and from this peer (another conflict kind): no-ops; the own one is a type rejection.
  b.commit(W(OTHER, EO, 9), [eventL(OTHER, EO, 6, 'K4', { cid: CID, reason_code: 'CONFLICT_K4' })]);
  const r3 = b.commit(W(SELF, E1, 9), [eventL(SELF, E1, 4, 'breach', { cid: CID, reason_code: 'FENCE_BREACH' })]);
  assert.deepEqual(b.state.events[CID], first);
  assert.deepEqual(r3.ownRejections, [rej(opId(SELF, E1, 4), 'event', 'type')]);
  assert.deepEqual(r3.landedOwnOpIds, []);

  // A non-conflict event is recorded under its cid with its op id and height.
  const r4 = b.commit(W(SELF, E1, 12), [eventL(SELF, E1, 10, 'health', { reason_code: 'HOST_THROTTLED' }), eventL(SELF, E1, 11, 'nonretryable', { refs: ['x'], reason_code: 'NONRETRYABLE' })]);
  assert.deepEqual(r4.landedOwnOpIds, [opId(SELF, E1, 10), opId(SELF, E1, 11)]);
  assert.deepEqual(b.state.events[cidOf(SELF, E1, 10, 'health')], { kind: 'health', refs: [], reason_code: 'HOST_THROTTLED', op_id: opId(SELF, E1, 10), height: 5 });
  assert.deepEqual(b.state.events[cidOf(SELF, E1, 11, 'nonretryable')], { kind: 'nonretryable', refs: ['x'], reason_code: 'NONRETRYABLE', op_id: opId(SELF, E1, 11), height: 5 });
  assert.equal(b.state.record_count, 3);
});

test('last_height and last_seq advance even when every op of a commit is a no-op', () => {
  const b = new Board(SELF);
  b.commit(W(SELF, E1, 2), [joinL(SELF, E1, 1)]);
  b.commit(W(OTHER, EO, 2), [joinL(OTHER, EO, 1)]);
  assert.equal(b.state.peers[SELF]?.last_seq, 2);

  const r = b.commit(W(SELF, E1, 9), ['{bad', eventL(SELF, E1, 1), seatEndL(SELF, E1, 3, SEAT1)]);
  assert.deepEqual(r.landedOwnOpIds, []);
  assert.deepEqual(r.ownRejections, [rej(opId(SELF, E1, 1), 'event', 'generic'), rej(opId(SELF, E1, 3), 'seat_end', 'type')]);
  assert.equal(b.state.height, 2);
  assert.equal(b.state.peers[SELF]?.last_height, 2);
  assert.equal(b.state.peers[SELF]?.last_seq, 9);

  // A commit with no ops at all (a code publish without ops) consumed a window too.
  b.commit(W(SELF, E1, 12), []);
  assert.equal(b.state.peers[SELF]?.last_height, 3);
  assert.equal(b.state.peers[SELF]?.last_seq, 12);

  // Without a Cowork-Writer nothing is attributed: only the height moves.
  const before = b.state;
  b.commit(null, [eventL(SELF, E1, 13)]);
  assert.equal(b.state.height, 4);
  assert.deepEqual(b.state.peers, before.peers);
  assert.deepEqual(b.state.events, {});

  // A lower writer seq of the recorded epoch never lowers last_seq (an op id folded once stays folded).
  b.commit(W(SELF, E1, 5), []);
  assert.equal(b.state.peers[SELF]?.last_seq, 12);
  assert.equal(b.state.peers[SELF]?.last_height, 5);
});

test('compaction at 512 drops the ended seat and the event of height 0 and keeps those of height 1, one height too young', () => {
  const b = new Board(SELF);
  const key = (seat: string): string => `${SELF}/${E1}/${seat}`;
  // h0: SEAT1 starts and ends, SEAT3 starts and stays live, one event.
  b.commit(W(SELF, E1, 6), [joinL(SELF, E1, 1), seatStartL(SELF, E1, 2, SEAT1), seatEndL(SELF, E1, 3, SEAT1), seatStartL(SELF, E1, 4, SEAT3), eventL(SELF, E1, 5)]);
  // h1: SEAT2 starts and ends, one event.
  b.commit(W(SELF, E1, 10), [seatStartL(SELF, E1, 7, SEAT2), seatEndL(SELF, E1, 8, SEAT2), eventL(SELF, E1, 9)]);
  let seq = 10;
  while (b.state.height < 511) b.commit(W(SELF, E1, ++seq), []);
  assert.equal(b.state.height, 511);
  assert.deepEqual(Object.keys(b.state.seats).sort(), [key(SEAT1), key(SEAT2), key(SEAT3)].sort(), 'the checkpoint at 256 dropped nothing');
  assert.deepEqual(b.state.seats[key(SEAT1)], { status: 'ended', permission_mode: 'default', ended_height: 0 });
  assert.equal(Object.keys(b.state.events).length, 2);
  assert.equal(b.state.record_count, 4);

  b.commit(W(SELF, E1, ++seq), []);   // the 513th commit, at height 512
  assert.equal(b.state.height, 512);
  assert.equal(b.state.seats[key(SEAT1)], undefined, 'ended at 0 = 512 − 512: dropped');
  assert.deepEqual(b.state.seats[key(SEAT2)], { status: 'ended', permission_mode: 'default', ended_height: 1 }, 'ended at 1: one height too young');
  assert.deepEqual(b.state.seats[key(SEAT3)], { status: 'live', permission_mode: 'default' }, 'a live seat is never compacted');
  assert.equal(b.state.events[cidOf(SELF, E1, 5)], undefined);
  assert.equal(b.state.events[cidOf(SELF, E1, 9)]?.height, 1);
  assert.equal(b.state.record_count, 2);
  assert.ok(parseFold(serializeFold(b.state)) !== null);
});

/** A board where A, B and C join at heights 0, 1, 2 and then B and C alternate until `until`. */
function threePeers(until: number): { b: Board; A: string; B: string; C: string } {
  const [A, B, C] = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)] as const;
  const b = new Board(A);
  b.commit(W(A, E1, 2), [joinL(A, E1, 1)]);
  b.commit(W(B, E1, 2), [joinL(B, E1, 1)]);
  b.commit(W(C, E1, 2), [joinL(C, E1, 1)]);
  for (let h = 3, seq = 3; h <= until; h++, seq++) {
    const who = h % 2 === 1 ? B : C;
    b.commit(W(who, E1, seq), []);
  }
  return { b, A, B, C };
}

test('rankedSet drops ghosts after 200 heights; governorRank orders by (last_height, peer_id) with peers without commits first and gives 1 outside R', () => {
  const { b, A, B, C } = threePeers(199);
  assert.equal(b.state.height, 199);
  assert.deepEqual(liveSet(b.state), [A, B, C]);
  assert.deepEqual(rankedSet(b.state), [A, B, C], 'A last wrote at height 0: 199 heights ago it is still ranked');
  // last_height: A 0, C 198, B 199.
  assert.equal(governorRank(b.state, A), 1);
  assert.equal(governorRank(b.state, C), 2);
  assert.equal(governorRank(b.state, B), 3);

  b.commit(W(C, E1, 300), []);
  assert.equal(b.state.height, 200);
  assert.deepEqual(liveSet(b.state), [A, B, C]);
  assert.deepEqual(rankedSet(b.state), [B, C], 'no commit in the last 200 heights: A is a ghost');
  assert.equal(governorRank(b.state, A), 1, 'a ghost takes rank 1');
  assert.equal(governorRank(b.state, B), 1);
  assert.equal(governorRank(b.state, C), 2);
  assert.equal(governorRank(b.state, 'd'.repeat(32)), 1, 'an unknown peer (a new joiner) takes rank 1');

  // Peers without a landed commit (last_height -1, a hand-built state: the fold itself always sets it at
  // the join) rank first, ties broken by peer id; -1 is a height like any other for the ghost rule.
  const s = structuredClone(threePeers(10).b.state);   // last_height: A 0, B 9, C 10
  const D = '0d'.repeat(16);
  const E = '0e'.repeat(16);
  for (const p of [E, D]) s.peers[p] = { ...structuredClone(s.peers[A]!), last_height: -1 };
  assert.deepEqual(rankedSet(s), [D, E, A, B, C]);
  assert.deepEqual([D, E, A, B, C].map((p) => governorRank(s, p)), [1, 2, 3, 4, 5]);
  s.peers[C]!.last_height = s.peers[B]!.last_height;
  assert.deepEqual([B, C].map((p) => governorRank(s, p)), [4, 5], 'equal last_height: peer id ascending');
  const late = structuredClone(b.state);
  late.peers[D] = { ...structuredClone(late.peers[B]!), last_height: -1 };
  assert.ok(!rankedSet(late).includes(D), 'at height 200 a peer without commits is a ghost');
  assert.equal(governorRank(late, D), 1);

  // A peer that left is outside R.
  b.commit(W(B, E1, 400), [leaveL(B, E1, 399)]);
  assert.deepEqual(rankedSet(b.state), [C]);
  assert.equal(governorRank(b.state, B), 1);
});

test('teamRegionSpec switches only when every peer of R announced the same value; a ghost does not block', () => {
  const [A, B, C, D] = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32), 'd'.repeat(32)] as const;
  const b = new Board(A);
  const seq: Record<string, number> = { [A]: 0, [B]: 0, [C]: 0, [D]: 0 };
  const next = (p: string): number => ++seq[p]!;
  const post = (p: string, regionSpec: string | null): void => {
    const lines = regionSpec === null ? [] : [joinL(p, E1, next(p), regionSpec)];
    b.commit(W(p, E1, next(p)), lines);
  };
  for (const p of [A, B, C, D]) post(p, RS1);
  assert.equal(b.state.teamRegionSpec, RS1);
  // D stays silent from height 3 on; A, B, C upgrade one by one while D is still in R.
  post(A, 'rs-2');
  assert.equal(b.state.teamRegionSpec, RS1);
  post(B, 'rs-2');
  assert.equal(b.state.teamRegionSpec, RS1);
  post(C, 'rs-2');
  assert.equal(b.state.height, 6);
  assert.deepEqual(rankedSet(b.state), [A, B, C, D]);
  assert.equal(b.state.teamRegionSpec, RS1, 'D (in R) still announces rs-1');
  const rot = [A, B, C];
  while (b.state.height < 202) post(rot[b.state.height % 3]!, null);
  assert.equal(b.state.height, 202);
  assert.deepEqual(rankedSet(b.state), [A, B, C, D]);
  assert.equal(b.state.teamRegionSpec, RS1);
  post(A, null);
  assert.equal(b.state.height, 203);
  assert.deepEqual(rankedSet(b.state), [A, B, C], 'D last wrote at height 3');
  assert.equal(b.state.teamRegionSpec, 'rs-2', 'the ghost D does not block the switch');

  // Disagreement inside R blocks a switch.
  post(A, 'rs-3');
  post(B, 'rs-3');
  assert.equal(b.state.teamRegionSpec, 'rs-2');
  post(C, 'rs-4');
  assert.equal(b.state.teamRegionSpec, 'rs-2');
  post(C, 'rs-3');
  assert.equal(b.state.teamRegionSpec, 'rs-3');
});

test('recentThrottleEvent sees a HOST_THROTTLED health event within the last 180 heights only', () => {
  const b = new Board(SELF);
  let n = 1;
  b.commit(W(SELF, E1, (n += 1)), [joinL(SELF, E1, 1)]);
  assert.equal(recentThrottleEvent(b.state, 180), false);
  b.commit(W(SELF, E1, (n += 2)), [
    eventL(SELF, E1, n - 1, 'health', { reason_code: 'BOARD_FULL' }),
  ]);
  b.commit(W(SELF, E1, (n += 2)), [eventL(SELF, E1, n - 1, 'freeze', { reason_code: 'HOST_THROTTLED' })]);
  assert.equal(recentThrottleEvent(b.state, 180), false, 'another reason code or another kind does not count');
  b.commit(W(SELF, E1, (n += 2)), [eventL(SELF, E1, n - 1, 'health', { reason_code: 'HOST_THROTTLED' })]);
  const at = b.state.height;
  assert.equal(at, 3);
  assert.equal(recentThrottleEvent(b.state, 180), true);
  while (b.state.height < at + 179) b.commit(W(SELF, E1, (n += 1)), []);
  assert.equal(recentThrottleEvent(b.state, 180), true, '179 heights later it is within the last 180');
  b.commit(W(SELF, E1, (n += 1)), []);
  assert.equal(b.state.height, at + 180);
  assert.equal(recentThrottleEvent(b.state, 180), false, '180 heights later it is not');
  assert.equal(recentThrottleEvent(b.state, 181), true);
});

test('serializeFold is canonical and parseFold accepts exactly what it writes', () => {
  const b = new Board(SELF);
  b.commit(W(SELF, E1, 6), [joinL(SELF, E1, 1), capsL(SELF, E1, 2), seatStartL(SELF, E1, 3, SEAT1), seatEndL(SELF, E1, 4, SEAT1), eventL(SELF, E1, 5)]);
  b.commit(W(SELF, E1, 8), [L({ id: opId(SELF, E1, 7), type: 'save', save_commit: OID('a'), saved_live: OID('b'), chain_base: OID('c'), released_claim_ids: ['x'] })]);
  const bytes = serializeFold(b.state);
  assert.equal(bytes.toString('utf8'), canonicalJson(b.state as unknown as Json));
  assert.deepEqual(b.state.caps, { custom_refs: true, lease: true, delete: false, push_options: false, two_parent_ok: true });
  assert.deepEqual(b.state.last_save, { save_commit: OID('a'), saved_live: OID('b'), chain_base: OID('c'), height: 1 });
  assert.equal(b.state.record_count, 2, 'one event and one ended seat');
  const back = parseFold(bytes);
  assert.ok(back !== null);
  assert.deepEqual(back, b.state);
  assert.ok(serializeFold(back).equals(bytes));
  const init = initialFoldState(PROTOCOL);
  assert.deepEqual(parseFold(serializeFold(init)), init);

  const text = bytes.toString('utf8');
  for (const bad of [
    Buffer.from(`﻿${text}`, 'utf8'),                       // BOM
    Buffer.from(`${text}\n`, 'utf8'),                            // not canonical bytes
    Buffer.from(JSON.stringify(b.state, null, 1), 'utf8'),       // not canonical bytes
    Buffer.from(text.replace('"v":1', '"v":2'), 'utf8'),         // unknown version
    Buffer.from(text.replace('"record_count":2', '"record_count":3'), 'utf8'),
    Buffer.from(text.replace(`"height":1`, '"height":1.5'), 'utf8'),
    Buffer.from(text.replace('"teamRegionSpec":', '"extra":1,"teamRegionSpec":'), 'utf8'),
    Buffer.from('{}', 'utf8'),
    Buffer.from('null', 'utf8'),
    Buffer.from([0xff, 0xfe, 0x00]),
  ]) {
    assert.equal(parseFold(bad), null, bad.toString('utf8').slice(0, 60));
  }
});

// Final review minor (board): a fold at height h dates every record at or below h (an event or an ended seat at the
// height that made it, a peer's last board commit, the last save). A state that dates one above its own height is no
// fold's output: trusted as a joiner's checkpoint (glossary §24 default 9) a future-dated HOST_THROTTLED event would
// read as newly folded on every later fold (core's `e.height > prevHeight`) and restart the fallback every tick.
test('parseFold refuses a state with a record dated above its own height (event, ended seat, peer last_height, last save)', () => {
  const b = new Board(SELF);
  b.commit(W(SELF, E1, 6), [joinL(SELF, E1, 1), capsL(SELF, E1, 2), seatStartL(SELF, E1, 3, SEAT1), seatEndL(SELF, E1, 4, SEAT1), eventL(SELF, E1, 5, 'health', { reason_code: 'HOST_THROTTLED' })]);
  b.commit(W(SELF, E1, 8), [L({ id: opId(SELF, E1, 7), type: 'save', save_commit: OID('a'), saved_live: OID('b'), chain_base: OID('c'), released_claim_ids: [] })]);
  const s = b.state;
  assert.equal(s.height, 1);
  assert.ok(parseFold(serializeFold(s)) !== null, 'control: the fold itself parses');
  const cid = Object.keys(s.events)[0]!;
  const seat = Object.keys(s.seats)[0]!;
  const edits: Array<[string, (x: FoldState, d: number) => void]> = [
    ['an event', (x, d) => { x.events[cid]!.height = x.height + d; }],
    ['an ended seat', (x, d) => { x.seats[seat]!.ended_height = x.height + d; }],
    ['a peer\'s last board commit', (x, d) => { x.peers[SELF]!.last_height = x.height + d; }],
    ['the last save', (x, d) => { x.last_save!.height = x.height + d; }],
  ];
  for (const [what, edit] of edits) {
    const atHeight = structuredClone(s);
    edit(atHeight, 0);
    assert.ok(parseFold(serializeFold(atHeight)) !== null, `${what} dated at the state's own height parses`);
    const future = structuredClone(s);
    edit(future, 1);
    assert.equal(parseFold(serializeFold(future)), null, `${what} dated one height above the state's`);
    const far = structuredClone(s);
    edit(far, 1_000_000);
    assert.equal(parseFold(serializeFold(far)), null, `${what} dated far above the state's`);
  }
});
