// test/unit/claude.turns.test.ts — Task 6's turn-origin cells (CCI-37, R5-36, R1-901…R1-905, R2-C5, R2-C6,
// O-TURN-ORIGIN; 06 test 30's unit half). A real SeatRegistry over a VirtualClock, a TraceRecorder, and a
// TurnOrigin; the lease double answers one inflight + one TXN for the released count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VirtualClock } from '../sim/vclock.js';
import { TraceRecorder } from '../sim/traceRecorder.js';
import { SeatRegistry } from '../../src/claude/daemon/seats.js';
import { TurnOrigin, promptNonces } from '../../src/claude/daemon/turns.js';
import type { Seat } from '../../src/claude/daemon/seats.js';
import type { TraceEvent } from '../../src/ports/trace.js';
import type { Random } from '../../src/ports/random.js';

const S = 's'.repeat(32);
const N1 = 'cws-0123456789abcdef';
const N2 = 'cws-aaaaaaaaaaaaaaaa';
const K1 = 'k'.repeat(32);

function rig(opts?: { mutants?: ReadonlySet<string> }): { clock: VirtualClock; trace: TraceRecorder; seats: SeatRegistry; turns: TurnOrigin; seat: Seat } {
  const clock = new VirtualClock({ startMono: 0 });
  const trace = new TraceRecorder();
  const random: Random = { bytes: () => Buffer.alloc(16, 7) };
  const seats = new SeatRegistry({
    clock, random, trace, peer: 'peer-1',
    outbox: () => undefined, pidAlive: () => true, notice: () => undefined, signals: { send: () => undefined },
  });
  const turns = new TurnOrigin(seats, clock, trace, { openFor: () => ({ inflight: 1, txns: 1 }) },
    opts?.mutants as never);
  const seat = seats.fromHello({ t: 'hello', seat_id: S, seat_key: K1, claude_pid: 1, cc_version: null, plugin_version: '0.0.0', hook_proto: 3, messaging_present: true });
  return { clock, trace, seats, turns, seat };
}

const turnEvents = (trace: TraceRecorder): Array<Extract<TraceEvent, { kind: 'turn' }>> =>
  trace.events.filter((e): e is Extract<TraceEvent, { kind: 'turn' }> => e.kind === 'turn');

test('a human UserPromptSubmit opens a human turn and refreshes the attended window (R1-905)', () => {
  const { clock, trace, turns, seat } = rig();
  clock.advance(5_000);
  const r = turns.onPromptSubmit(seat, 'p5', []);
  assert.deepEqual(r, { kind: 'turn', origin: 'human', newTurn: true });
  assert.equal(seat.turn.lastHumanPromptMono, 5_000);
  assert.equal(seat.turn.promptId, 'p5');
  assert.equal(seat.turn.origin, 'human');
  const ev = turnEvents(trace).at(-1)!;
  assert.equal(ev.op, 'human');
  assert.equal(ev.humanPromptRefreshed, true);
  assert.equal(ev.csReset, true);
  assert.equal(ev.released, 2);          // the lease double's 1 inflight + 1 TXN
  const r2 = turns.onPromptSubmit(seat, 'p5', []);
  assert.deepEqual(r2, { kind: 'turn', origin: 'human', newTurn: false });
});

test('a nonce-carrying prompt mid-turn is a doorbell: nothing refreshed, nothing released, pending cleared (R1-902)', () => {
  const { clock, trace, turns, seat } = rig();
  turns.onPromptSubmit(seat, 'p1', []);          // human turn p1 at 0
  clock.advance(2_000);
  turns.onRingSent(seat, N1, ['e1', 'e2']);      // a ring mid-turn: not fallback-eligible
  clock.advance(1_000);
  const last = seat.turn.lastHumanPromptMono;
  const r = turns.onPromptSubmit(seat, 'p1', [N1]);
  assert.deepEqual(r, { kind: 'doorbell', delivered: [N1], wake: false });   // same prompt_id → no wake
  assert.equal(seat.turn.lastHumanPromptMono, last);                         // no attended-window refresh
  assert.equal(seat.turn.origin, 'human');                                   // the turn unchanged
  assert.equal(seat.turn.pending.length, 0);                                 // the doorbell's pending wake cleared
  const ev = turnEvents(trace).at(-1)!;
  assert.equal(ev.op, 'doorbell');
  assert.equal(ev.humanPromptRefreshed, false);
  assert.equal(ev.csReset, false);
  assert.equal(ev.released, 0);
  assert.equal(ev.nonce, N1);
});

test('idle seat + sent ring → a nonce prompt with a new prompt_id is a wake turn (rule (a), R1-901, A6-3)', () => {
  const { clock, trace, seats, turns, seat } = rig();
  turns.onPromptSubmit(seat, 'p1', []);
  turns.onStop(seat);                            // Stop of p1 at ~0
  clock.advance(80_000);
  turns.onRingSent(seat, N1, ['e1']);            // records recordedPromptId = p1
  clock.advance(36);
  const r = turns.onPromptSubmit(seat, 'p2', [N1]);
  assert.deepEqual(r, { kind: 'doorbell', delivered: [N1], wake: true });
  assert.equal(seat.turn.promptId, 'p2');
  assert.equal(seat.turn.origin, 'wake');
  const id = seat.seatId!;
  assert.equal(turns.originOf(id), 'wake');
  assert.equal(turns.requestOrigin(id), 'wake');
  assert.equal(turns.recordOrigin(id, 'a1'), 'peer-1/a1');
  turns.onStop(seat);                            // Stop of p2 clears the origin
  assert.equal(turns.originOf(id), 'prompt');
  const ev = turnEvents(trace).filter((e) => e.op === 'doorbell').at(-1)!;
  assert.equal(ev.humanPromptRefreshed, false);
  void seats;
});

test('a ring during a running human turn decides nothing (race, R5-36)', () => {
  const { clock, trace, turns, seat } = rig();
  turns.onPromptSubmit(seat, 'p3', []);
  clock.advance(200_000);
  turns.onRingSent(seat, N2, ['e3']);
  clock.advance(10);
  turns.onOtherHook(seat, 'p3');                 // PreToolUse of the running turn
  clock.advance(40);
  turns.onOtherHook(seat, 'p3');                 // PostToolUse
  assert.equal(seat.turn.origin, 'human');
  assert.ok(!turnEvents(trace).some((e) => e.op === 'wake'));
});

test('fallback (b) only classifies as wake and needs 60 s of quiet before the post (OQ-01 r2)', () => {
  const { clock, turns, seat } = rig();
  turns.onRingSent(seat, N1, ['e1']);            // last hook (creation) at 0 → quiet holds
  clock.advance(50);
  turns.onOtherHook(seat, 'p9');                 // PreToolUse with no UPS
  assert.equal(seat.turn.origin, 'wake');
  assert.equal(seat.turn.promptId, 'p9');
});

test('fallback (b) refuses a post inside the 60 s quiet window', () => {
  const { clock, trace, seats, turns } = rig();
  const seat = seats.fromHook({ seat_key: K1, claude_pid: 2, session_id: 'a2' });
  clock.advance(30_000);                         // the last hook is 30 s old
  turns.onRingSent(seat, N1, ['e1']);
  clock.advance(50);
  turns.onOtherHook(seat, 'p9');
  assert.equal(seat.turn.origin, null);          // no wake decision
  void trace; void turns;
});

test('a nonce-less UserPromptSubmit before the fallback hook blocks it (A6-2 humanPromptSincePost semantics)', () => {
  const { clock, turns, seat } = rig();
  turns.onRingSent(seat, N1, ['e1']);
  clock.advance(10_000);
  turns.onPromptSubmit(seat, 'p8', []);          // a human prompt after the post
  clock.advance(40);
  turns.onOtherHook(seat, 'p9');
  assert.equal(seat.turn.origin, 'human');       // p8's human turn stands; (b) decides nothing
});

test('a fallback hook carrying the recorded prompt_id never wakes (R5-36)', () => {
  const { clock, turns, seat } = rig();
  turns.onPromptSubmit(seat, 'p3', []);
  turns.onStop(seat);
  clock.advance(80_000);
  turns.onRingSent(seat, N1, ['e1']);            // records p3
  clock.advance(50);
  turns.onOtherHook(seat, 'p3');                 // the recorded turn's continuation
  assert.equal(seat.turn.origin, null);
});

test('/cowork expansions classify by pending wake, nonce, or wake origin (R1-904, R2-C6)', () => {
  const { clock, turns, seat } = rig();
  turns.onPromptSubmit(seat, 'p1', []);
  turns.onStop(seat);
  turns.onRingSent(seat, N1, ['e1']);            // pending with recorded p1
  assert.equal(turns.classifyExpansion(seat, 'p2', []), 'wake');              // new prompt_id while pending
  assert.equal(turns.classifyExpansion(seat, 'p1', []), 'human');             // the recorded prompt_id
  assert.equal(turns.classifyExpansion(seat, 'p9', ['cws-fedcba9876543210']), 'wake');   // any cws- nonce
  clock.advance(10);
  turns.onOtherHook(seat, 'p2');                 // (b) opens the wake turn p2
  assert.equal(turns.classifyExpansion(seat, 'p3', []), 'wake');              // the seat's turn is wake
  turns.onStop(seat);
  clock.advance(61_000);                         // the pending wake's 60 s elapse
  turns.expire();                                // the `turns` ticker's expiry
  assert.equal(turns.classifyExpansion(seat, 'p4', []), 'human');
});

test('a pending wake expires 60 s after the post; the posted nonces survive it (A6-2, R1-901)', () => {
  const { clock, trace, turns, seat } = rig();
  turns.onRingSent(seat, N1, ['e1']);
  clock.advance(59_999);
  turns.expire();
  assert.equal(turns.classifyExpansion(seat, 'p2', []), 'wake');              // still pending
  clock.advance(1);
  turns.expire();                                // 60,000: the pending state expires
  assert.equal(turns.classifyExpansion(seat, 'p3', []), 'human');
  turns.onOtherHook(seat, 'p9');                 // fallback (b) no longer applies
  assert.equal(seat.turn.origin, null);
  clock.advance(9_000);
  const r = turns.onPromptSubmit(seat, 'p4', [N1]);   // rule (a) survives the expiry
  assert.deepEqual(r, { kind: 'doorbell', delivered: [N1], wake: true });
  const r2 = turns.onPromptSubmit(seat, 'p4', ['cws-fedcba9876543210']);   // never posted → still a doorbell, no wake
  assert.deepEqual(r2, { kind: 'doorbell', delivered: [], wake: false });
  assert.equal(seat.turn.promptId, 'p4');
  void trace;
});

test('O-TURN-ORIGIN: a nonce prompt never refreshes the last human prompt (unit, R2-C5)', () => {
  const { clock, turns, seat } = rig();
  turns.onPromptSubmit(seat, 'p1', []);
  const last = seat.turn.lastHumanPromptMono;
  clock.advance(70_000);
  turns.onRingSent(seat, N1, ['e1']);
  turns.onPromptSubmit(seat, 'p2', [N1]);
  assert.equal(seat.turn.lastHumanPromptMono, last);
});

test('M44 is caught: under the mutant the same doorbell refreshes the attended window and opens a human turn (A6-11)', () => {
  const { clock, turns, seat, trace } = rig({ mutants: new Set(['M44']) });
  turns.onRingSent(seat, N1, ['e1']);
  clock.advance(3_000);
  const r = turns.onPromptSubmit(seat, 'p2', [N1]);
  assert.deepEqual(r, { kind: 'turn', origin: 'human', newTurn: true });      // treated as a human prompt
  assert.equal(seat.turn.lastHumanPromptMono, 3_000);
  assert.ok(turnEvents(trace).some((e) => e.op === 'human' && e.humanPromptRefreshed));
});

test('promptNonces collects the cws- tokens of the payload text fields (NONCE_RE)', () => {
  assert.deepEqual(promptNonces({ event: 'UserPromptSubmit', nonces: [N1, N1, N2] }), [N1, N2]);
});

// ---- F2 wave (t6-signals): the fallback (b) real-path rules, the in-flight ring race, one (b) per post, bounded maps

test('a UserPromptSubmit whose prompt_id equals a fallback-(b) turn\'s is that turn\'s human start (F2 #60)', () => {
  const { clock, trace, turns, seat } = rig();
  clock.advance(70_000);                         // no hook before: the seat's creation was a hello
  turns.onRingSent(seat, N1, ['e1']);            // eligible: no hook in the 60 s before the post, no turn open
  clock.advance(50);
  turns.onOtherHook(seat, 'p5');                 // the /cowork expansion's prompt_id reached (b) first (70,050)
  assert.equal(seat.turn.origin, 'wake');
  clock.advance(10);
  const r = turns.onPromptSubmit(seat, 'p5', []);   // the human's own nonce-less UserPromptSubmit of that prompt (70,060)
  assert.deepEqual(r, { kind: 'turn', origin: 'human', newTurn: true });
  assert.equal(seat.turn.origin, 'human');
  assert.equal(seat.turn.lastHumanPromptMono, 70_060);
  assert.equal(seat.turn.wakeTurnStartMono, null);
  const ev = turnEvents(trace).at(-1)!;
  assert.deepEqual({ op: ev.op, humanPromptRefreshed: ev.humanPromptRefreshed, csReset: ev.csReset, released: ev.released },
    { op: 'human', humanPromptRefreshed: true, csReset: true, released: 2 });
  clock.advance(40);
  turns.onOtherHook(seat, 'p5');                 // a later hook of that turn (70,100)
  assert.equal(seat.turn.origin, 'human');
});

test('every hook event but UserPromptSubmit and UserPromptExpansion is routed to fallback (b) (F2 #60)', async () => {
  const mod = await import('../../src/claude/daemon/turns.js') as { otherHookEvent?: (e: string) => boolean };
  assert.equal(typeof mod.otherHookEvent, 'function', 'turns.ts exports otherHookEvent');
  const f = mod.otherHookEvent!;
  assert.equal(f('UserPromptExpansion'), false);
  assert.equal(f('UserPromptSubmit'), false);
  for (const e of ['PreToolUse', 'PostToolUse', 'Stop', 'SessionStart', 'SubagentStop', 'Notification']) assert.equal(f(e), true, e);
});

test('a nonce UPS that arrives while its ring is in flight is the doorbell and the wake turn; the late \'sent\' leaves no pending wake (F2 #61, R-F2-17)', () => {
  const { clock, turns, seat } = rig();
  turns.onPromptSubmit(seat, 'p1', []);          // UPS p1 at 0
  clock.advance(10_000);
  turns.onStop(seat);                            // Stop at 10,000
  clock.advance(70_000);
  const t = turns as unknown as { onRingInFlight(s: Seat, n: string, ids: readonly string[]): void; onRingSent(s: Seat, n: string, ids: readonly string[]): boolean };
  t.onRingInFlight(seat, N1, ['e1']);            // the ring frame is sent at 80,000
  const last = seat.turn.lastHumanPromptMono;
  clock.advance(60);
  const r = turns.onPromptSubmit(seat, 'p2', [N1]);   // the injected prompt's UPS beats ring_result (80,060)
  assert.deepEqual(r, { kind: 'doorbell', delivered: [N1], wake: true });
  assert.equal(seat.turn.promptId, 'p2');
  assert.equal(seat.turn.origin, 'wake');
  assert.equal(seat.turn.lastHumanPromptMono, last);
  clock.advance(45);
  assert.equal(t.onRingSent(seat, N1, ['e1']), true);   // 'sent' at 80,105: the nonce was already seen
  assert.equal(seat.turn.pending.length, 0);            // no stale pending wake
  clock.advance(9_895);
  turns.onStop(seat);                            // 90,000
  clock.advance(20_000);
  assert.equal(turns.classifyExpansion(seat, 'p7', []), 'human');   // 110,000: the human's /cowork verbs are not blocked
  const h = turns.onPromptSubmit(seat, 'p8', []);
  assert.deepEqual(h, { kind: 'turn', origin: 'human', newTurn: true });
  assert.equal(turns.originOf(seat.seatId!), 'prompt');
});

test('a ring that fails after send clears its in-flight wake; a nonce already seen keeps its turn (F2 #61)', () => {
  type T = { onRingInFlight(s: Seat, n: string, ids: readonly string[]): void; onRingFailed(s: Seat, n: string): void };
  {
    const { clock, turns, seat } = rig();
    clock.advance(80_000);
    const t = turns as unknown as T;
    t.onRingInFlight(seat, N1, ['e1']);
    clock.advance(100);
    t.onRingFailed(seat, N1);                    // 'refused' / 'error' / the 5 s timeout
    assert.equal(seat.turn.pending.length, 0);
    clock.advance(1_000);
    assert.deepEqual(turns.onPromptSubmit(seat, 'p2', [N1]), { kind: 'doorbell', delivered: [], wake: false });   // that post never happened
  }
  {
    const { clock, turns, seat } = rig();
    clock.advance(80_000);
    const t = turns as unknown as T;
    t.onRingInFlight(seat, N1, ['e1']);
    clock.advance(40);
    assert.deepEqual(turns.onPromptSubmit(seat, 'p2', [N1]), { kind: 'doorbell', delivered: [N1], wake: true });
    clock.advance(60);
    t.onRingFailed(seat, N1);                    // a late failure for a nonce already seen
    assert.equal(seat.turn.origin, 'wake');
    assert.equal(seat.turn.promptId, 'p2');
    assert.equal(seat.turn.pending.length, 0);
  }
  {
    const { clock, trace, turns, seat } = rig();
    clock.advance(80_000);
    const t = turns as unknown as T;
    t.onRingInFlight(seat, N1, ['e1']);          // eligible, but still in flight
    clock.advance(50);
    turns.onOtherHook(seat, 'p9');               // (b) needs a `sent` post: nothing decided
    assert.equal(seat.turn.origin, null);
    assert.ok(!turnEvents(trace).some((e) => e.op === 'wake'));
  }
});

test('one sent post wakes at most one turn by fallback (b) (F2 #68)', () => {
  const { clock, trace, turns, seat } = rig();
  clock.advance(60_000);
  turns.onRingSent(seat, N1, ['e1']);            // the post at 60,000, eligible
  clock.advance(50);
  turns.onOtherHook(seat, 'p9');                 // 60,050: (b) → wake
  assert.equal(seat.turn.origin, 'wake');
  clock.advance(950);
  turns.onStop(seat);                            // 61,000
  clock.advance(10_000);
  turns.onOtherHook(seat, 'p10');                // 71,000: the same post must not wake a second turn
  assert.equal(seat.turn.origin, null);
  assert.equal(turnEvents(trace).filter((e) => e.op === 'wake').length, 1);
});

test('TurnOrigin\'s posted-nonce registry forgets ended seats (F2 #72)', async () => {
  const { seats, turns } = rig();
  const sized = turns as unknown as { sizesForTest(): { posted: number } };
  for (let i = 0; i < 1_000; i++) {
    const hex = i.toString(16).padStart(32, '0');
    const s = seats.fromHello({ t: 'hello', seat_id: hex, seat_key: `${hex}${hex}`, claude_pid: 10_000 + i, cc_version: null, plugin_version: '0.0.0', hook_proto: 3, messaging_present: true });
    turns.onRingSent(s, `cws-${i.toString(16).padStart(16, '0')}`, ['e']);
    await seats.end(s, 'mcp_eof');
  }
  assert.ok(sized.sizesForTest().posted <= 1, `posted size ${sized.sizesForTest().posted}`);
});
