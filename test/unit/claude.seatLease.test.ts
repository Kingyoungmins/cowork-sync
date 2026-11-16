// Plan 5 Task 5 phase 2 — SeatLeasePort (CCI-50, R5-35, R2-I1, BL2-01, OQ-12 (r3); 06 §3.17.1).
// A seat's lease is valid while its last heartbeat is ≤ SEAT_HEARTBEAT_VALID_MS old, or a hook arrived within the
// validity window, or a NO_MCP seat's claude pid is alive; the human lease (renewHuman 60 min, grantHuman 1–480 min)
// holds the peer awake on its own. idleMs() is 0 while any lease is valid, else Δmono since the last one ended.
// X-40: a seat whose own lease stops being valid is reported once to coordHooks.onLeaseLost(seatId).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VirtualClock } from '../sim/vclock.js';
import { SeatLeasePort } from '../../src/claude/daemon/seatLease.js';
import { SeatRegistry } from '../../src/claude/daemon/seats.js';
import { C } from '../../src/claude/wire/constants.js';
import { seededRandom } from '../../src/ports/random.js';
import { noTrace } from '../../src/ports/trace.js';
import type { CsSignal } from '../../src/holds/signals.js';
import type { HookEvent, McpHelloFrame } from '../../src/claude/wire/frames.js';
import type { OpDraft } from '../../src/board/ops.js';

type SeatDraft = Extract<OpDraft, { type: 'seat_start' | 'seat_end' | 'event' }>;

interface Harness {
  clock: VirtualClock;
  seats: SeatRegistry;
  lease: SeatLeasePort;
  drafts: SeatDraft[];
  signals: CsSignal[];
  idles: boolean[];
  pidsAlive: Set<number>;
  leaseLost: string[];
  /** Every pidAlive probe the registry made (SeatLeasePort's clause (c) and the 5 s ticker share it). */
  pidCalls: number[];
  /** leaseSeats() reads through the source SeatLeasePort was built over. */
  sourceReads: { n: number };
}

const K = 'k';

function harness(): Harness {
  const clock = new VirtualClock();
  const drafts: SeatDraft[] = [];
  const signals: CsSignal[] = [];
  const idles: boolean[] = [];
  const pidsAlive = new Set<number>([4242]);
  const leaseLost: string[] = [];
  const pidCalls: number[] = [];
  const sourceReads = { n: 0 };
  const seats = new SeatRegistry({
    clock, random: seededRandom('lease-test'), trace: noTrace, peer: 'p1',
    outbox: (d) => drafts.push(d),
    pidAlive: (pid) => { pidCalls.push(pid); return pidsAlive.has(pid); },
    notice: () => undefined,
    signals: { send: (s) => signals.push(s) },
    onLeaseLost: (seatId) => leaseLost.push(seatId),
  });
  // The lease reads the real registry through a counting wrapper (the SeatLeaseSource surface, structurally).
  const source = {
    leaseSeats: () => { sourceReads.n++; return seats.leaseSeats(); },
    pidAlive: (pid: number) => seats.pidAlive(pid),
    queuePeerIdle: () => seats.queuePeerIdle(),
  };
  const lease = new SeatLeasePort(source, clock, (entered) => idles.push(entered), (seatId) => leaseLost.push(seatId));
  return { clock, seats, lease, drafts, signals, idles, pidsAlive, leaseLost, pidCalls, sourceReads };
}

function hello(clock: VirtualClock, id: string): McpHelloFrame {
  void clock;
  return { t: 'hello', seat_id: id, seat_key: `k${id.slice(0, 3)}`, claude_pid: 4242, cc_version: '2.1.0', plugin_version: '0.6.0', hook_proto: 1, messaging_present: true };
}

const HEAD = { seat_key: K, claude_pid: 4242, session_id: 's1', prompt_id: null, agent_id: null, agent_type: null, permission_mode: 'default', repo_root: '/r', plugin_version: '0.6.0', hook_proto: 1 };

test('idleMs is 0 while a heartbeat ≤ 45 s old or a human lease is valid; a hook refreshes the seat lease', () => {
  const h = harness();
  const seat = h.seats.fromHello(hello(h.clock, '11111111111111111111111111111111'));
  assert.equal(seat.seatId, '11111111111111111111111111111111');
  // Heartbeat at 0: valid to exactly 45,000, idle at 50,000.
  h.clock.advance(C.SEAT_HEARTBEAT_VALID_MS);
  assert.equal(h.lease.idleMs(), 0);
  h.clock.advance(5_000);
  assert.equal(h.lease.idleMs(), 5_000);
  // A hook refreshes its seat's lease (06 §3.17.1: a hook within the validity window).
  h.clock.advance(10_000);
  h.seats.fromHook({ ...HEAD, session_id: 's1' });
  h.seats.observeActivity(seat, 'UserPromptSubmit', { event: 'UserPromptSubmit', nonces: [] });
  assert.equal(h.lease.idleMs(), 0);
  h.clock.advance(C.SEAT_HEARTBEAT_VALID_MS + 5_000);
  assert.equal(h.lease.idleMs(), 5_000);
});

test('a NO_MCP seat with a live pid keeps idleMs at 0 whatever the time; its pid death starts the idle count', async () => {
  const h = harness();
  const seat = h.seats.fromHook({ ...HEAD, session_id: 's1' });   // no hello → seatId null until awaitBound
  const minted = h.seats.awaitBound(seat, h.clock.monoMs() + C.MCP_PAIRING_MS);
  h.clock.advance(C.MCP_PAIRING_MS);                              // mint at 3,000, NO_MCP, pid 4242 alive
  await minted;
  assert.equal(seat.wiring, 'NO_MCP');
  h.clock.advance(C.SEAT_HEARTBEAT_VALID_MS * 10);
  assert.equal(h.lease.idleMs(), 0, 'pid alive → lease valid');
  h.pidsAlive.delete(4242);
  await h.seats.tick();                                           // the 5 s pid check ends it
  assert.ok(seat.ended);
  assert.ok(h.lease.idleMs() <= C.CLAUDE_PID_CHECK_MS + 1, 'idle counts from the end instant');
});

test('an ended seat never counts; a second seat keeps idleMs 0 while its lease is valid', () => {
  const h = harness();
  const a = h.seats.fromHello(hello(h.clock, '11111111111111111111111111111111'));
  void h.seats.end(a, 'mcp_eof');
  h.clock.advance(60_000);
  assert.ok(h.lease.idleMs() > 0, 'only the ended seat → idle');
  const before = h.lease.idleMs();
  h.seats.fromHello(hello(h.clock, '22222222222222222222222222222222'));
  assert.equal(h.lease.idleMs(), 0, 'the live seat holds the peer awake');
  assert.ok(before > 0);
});

test('renewHuman holds 60 min; grantHuman clamps 1–480 with a RangeError outside; 480 min = 28,800,000 ms', () => {
  const h = harness();
  h.clock.advance(10_000);
  h.lease.renewHuman();
  assert.equal(h.lease.idleMs(), 0);
  h.clock.advance(C.HUMAN_LEASE_MS);
  assert.equal(h.lease.idleMs(), 0, 'valid to exactly 60 min');
  h.clock.advance(1);
  assert.equal(h.lease.idleMs(), 1);
  assert.throws(() => h.lease.grantHuman(0), RangeError);
  assert.throws(() => h.lease.grantHuman(C.HUMAN_LEASE_MAX_MIN + 1), RangeError);
  const t = h.clock.monoMs();
  h.lease.grantHuman(C.HUMAN_LEASE_MAX_MIN);
  assert.equal(h.lease.idleMs(), 0);
  h.clock.advance(28_800_000);
  assert.equal(h.lease.idleMs(), 0, '480 min holds');
  h.clock.advance(1);
  assert.equal(h.lease.idleMs(), h.clock.monoMs() - t - 28_800_000);
});

test('onIdle(true) exactly once when idleMs first becomes > 0 with one PEER_IDLE health draft; onIdle(false) once with no event', () => {
  const h = harness();
  const seat = h.seats.fromHello(hello(h.clock, '11111111111111111111111111111111'));
  void seat;
  h.clock.advance(C.SEAT_HEARTBEAT_VALID_MS + 1);
  assert.ok(h.lease.idleMs() > 0, 'idle first becomes > 0 here');
  assert.deepEqual(h.idles, [true]);
  assert.deepEqual(h.leaseLost, ['11111111111111111111111111111111'], 'X-40: the first loss episode is reported once');
  const health = h.drafts.filter((d): d is Extract<SeatDraft, { type: 'event' }> => d.type === 'event' && d.reason_code === 'PEER_IDLE');
  assert.equal(health.length, 1, 'exactly one PEER_IDLE health draft');
  assert.equal(health[0]!.kind, 'health');
  assert.deepEqual(health[0]!.refs, []);
  assert.equal(health[0]!.reason_code, 'PEER_IDLE');
  h.clock.advance(1_000);
  assert.deepEqual(h.idles, [true], 'no repeat while idle');
  h.seats.fromHook({ ...HEAD, seat_key: 'k111', session_id: 's1' });
  h.seats.observeActivity(h.seats.byKey('k111')!, 'UserPromptSubmit', { event: 'UserPromptSubmit', nonces: [] });
  assert.equal(h.lease.idleMs(), 0);
  assert.deepEqual(h.idles, [true, false], 'onIdle(false) once when a lease is valid again');
  assert.equal(h.drafts.filter((d) => d.type === 'event' && (d as { reason_code: string }).reason_code === 'PEER_IDLE').length, 1, 'no health event on leaving idle');
  h.clock.advance(C.SEAT_HEARTBEAT_VALID_MS + 1);
  assert.ok(h.lease.idleMs() > 0, 'idle again');
  assert.deepEqual(h.idles, [true, false, true], 'the next idle entry fires again');
  // The hook above carries seat_key 'k111', the hello's own key (hello() derives `k` + the id's first three
  // characters), so it regained S's lease: this idle is S's second loss episode, reported once more (X-40: one
  // report per seatId per loss episode; F2 #54, #102).
  assert.deepEqual(h.leaseLost, ['11111111111111111111111111111111', '11111111111111111111111111111111'],
    'X-40: each of the two loss episodes is reported once');
});

test('X-40: a seat lease lost, regained and lost again is reported once per episode (F2 #54, #102)', () => {
  const h = harness();
  const S = '33333333333333333333333333333333';
  const seat = h.seats.fromHello(hello(h.clock, S));                // heartbeat at 0
  h.clock.advance(C.SEAT_HEARTBEAT_VALID_MS + 1);
  for (let i = 0; i < 3; i++) assert.ok(h.lease.idleMs() > 0);
  assert.deepEqual(h.leaseLost, [S], 'one report for the first episode, however many reads see it');
  h.seats.onHeartbeat(seat);                                         // the lease is valid again
  assert.equal(h.lease.idleMs(), 0);
  assert.deepEqual(h.leaseLost, [S]);
  h.clock.advance(C.SEAT_HEARTBEAT_VALID_MS + 1);
  assert.ok(h.lease.idleMs() > 0);
  assert.deepEqual(h.leaseLost, [S, S], 'the second episode is reported once more');
  assert.ok(h.lease.idleMs() > 0);
  assert.deepEqual(h.leaseLost, [S, S]);
});

test('an ended NO_MCP seat never counts while its pid lives (recycled pid), and idleMs probes each live NO_MCP pid once (F2 #54)', async () => {
  const h = harness();
  const seat = h.seats.fromHook({ ...HEAD, session_id: 's1' });     // no hello → minted NO_MCP by awaitBound
  const minted = h.seats.awaitBound(seat, h.clock.monoMs() + C.MCP_PAIRING_MS);
  h.clock.advance(C.MCP_PAIRING_MS);
  await minted;
  assert.equal(seat.wiring, 'NO_MCP');
  h.clock.advance(C.SEAT_HEARTBEAT_VALID_MS + 1);                   // past the hook's own validity: the pid clause alone holds it
  h.pidCalls.length = 0;
  const reads0 = h.sourceReads.n;
  assert.equal(h.lease.idleMs(), 0, 'pid alive → lease valid');
  assert.deepEqual(h.pidCalls, [4242], 'one pidAlive probe for the one live NO_MCP seat');
  assert.equal(h.sourceReads.n - reads0, 1, 'one leaseSeats() read per idleMs()');
  await h.seats.end(seat, 'pid_gone');                               // ended, while 4242 stays alive (a recycled pid)
  assert.ok(h.pidsAlive.has(4242));
  h.clock.advance(60_000);
  h.pidCalls.length = 0;
  const reads1 = h.sourceReads.n;
  const idle = h.lease.idleMs();
  assert.ok(idle > 0, `an ended seat never counts (plan 2743): idleMs ${idle}`);
  assert.equal(idle, 60_000, 'idle counts from the end instant');
  assert.deepEqual(h.pidCalls, [], 'an ended seat is never pid-probed');
  assert.equal(h.sourceReads.n - reads1, 1, 'the idle path reuses the one leaseSeats() read');
});

test('the human lease alone holds idleMs at 0 without ever reporting a seat lease loss', () => {
  const h = harness();
  h.lease.renewHuman();
  h.clock.advance(C.SEAT_HEARTBEAT_VALID_MS + 1_000_000);
  assert.equal(h.lease.idleMs(), 0);
  assert.deepEqual(h.idles, []);
  assert.deepEqual(h.leaseLost, []);
  assert.equal(h.drafts.filter((d) => d.type === 'event').length, 0);
});
