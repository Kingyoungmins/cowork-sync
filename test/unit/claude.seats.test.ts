// Plan 5 Task 5 phase 2 — SeatRegistry (CCI-31…CCI-33, R1-801…R1-806, R2-B1…R2-B8, INV-CCI-SEAT; 06 §3.11).
// Identity/continuity, the 3 s pairing window, lazy second-repo registration, seat numbers never reused,
// seat end (MCP EOF / pid death; SessionEnd is not an end), display precedence with one health event per
// change, the HOOK_ONLY notice per cause, activity from hooks only, O-SEAT (fast-check).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { VirtualClock } from '../sim/vclock.js';
import { SeatRegistry, DISPLAY_PRECEDENCE } from '../../src/claude/daemon/seats.js';
import { C } from '../../src/claude/wire/constants.js';
import { CCI_CODES } from '../../src/claude/wire/codes.js';
import { seededRandom, randomHex } from '../../src/ports/random.js';
import { TraceRecorder } from '../sim/traceRecorder.js';
import type { CsSignal, SeatActivity } from '../../src/holds/signals.js';
import type { HookEvent, McpHelloFrame } from '../../src/claude/wire/frames.js';
import type { OpDraft } from '../../src/board/ops.js';
import type { Trace } from '../../src/ports/trace.js';
import { OPS_MAX_BYTES, OPS_MAX_LINES } from '../../src/board/ops.js';
import { allowedInAll, Outbox, type SeqAllocator } from '../../src/board/outbox.js';

type SeatDraft = Extract<OpDraft, { type: 'seat_start' | 'seat_end' | 'event' }>;
type RegionsCalls = Array<{ holder: { peer: string; seat: string }; reason: string; target: readonly string[] | 'all' }>;

interface Harness {
  clock: VirtualClock;
  seats: SeatRegistry;
  drafts: SeatDraft[];
  signals: CsSignal[];
  notices: Array<{ seatId: string; code: string; params: Record<string, unknown> }>;
  trace: TraceRecorder;
  pidsAlive: Set<number>;
  regions: RegionsCalls;
}

const HOOK_PROTO = 1;
const PLUGIN = '0.6.0';
const MODE = 'default';
const S1 = '11111111111111111111111111111111';
const S2 = '22222222222222222222222222222222';
const S3 = '33333333333333333333333333333333';

function harness(seed = 'seats', log?: import('../../src/ports/log.js').Log): Harness {
  const clock = new VirtualClock();
  const drafts: SeatDraft[] = [];
  const signals: CsSignal[] = [];
  const notices: Harness['notices'] = [];
  const trace = new TraceRecorder();
  const pidsAlive = new Set<number>([4242]);
  const regions: RegionsCalls = [];
  const seats = new SeatRegistry({
    clock, random: seededRandom(seed), trace: trace as unknown as Trace, peer: 'p1',
    outbox: (d) => drafts.push(d),
    pidAlive: (pid) => pidsAlive.has(pid),
    notice: (seatId, code, params) => notices.push({ seatId, code, params }),
    signals: { send: (s) => signals.push(s) },
    regions: { releaseClaims: (holder, reason, target) => { regions.push({ holder, reason, target }); return { drafts: [], refused: [] }; } },
    ...(log === undefined ? {} : { log }),
  });
  return { clock, seats, drafts, signals, notices, trace, pidsAlive, regions };
}

function hello(clock: VirtualClock, id: string, opts?: { key?: string; messaging?: boolean }): McpHelloFrame {
  void clock;
  return { t: 'hello', seat_id: id, seat_key: opts?.key ?? 'K1', claude_pid: 4242, cc_version: '2.1.0', plugin_version: PLUGIN, hook_proto: HOOK_PROTO, messaging_present: opts?.messaging ?? true };
}

function head(key: string, sessionId: string): { seat_key: string; claude_pid: number; session_id: string; permission_mode: string; plugin_version: string; hook_proto: number } {
  return { seat_key: key, claude_pid: 4242, session_id: sessionId, permission_mode: MODE, plugin_version: PLUGIN, hook_proto: HOOK_PROTO };
}

/** A hook call through the registry: fromHook for the registration side + observeActivity for the activity side. */
function sendHook(h: Harness, key: string, sessionId: string, event: HookEvent, activityPayload?: unknown): void {
  const seat = h.seats.fromHook(head(key, sessionId));
  h.seats.observeActivity(seat, event, activityPayload ?? {});
}

const hexId = (): string => randomHex(seededRandom('ids'), 16);

// outbox.test.ts's fixtures (PRO-45 cells): the writer's (peer, epoch), the ops.jsonl room and a seq allocator.
const SELF = { peer: '0123456789abcdef0123456789abcdef', epoch: 'fedcba9876543210fedcba9876543210' };
const ROOM = { maxOps: OPS_MAX_LINES, maxBytes: OPS_MAX_BYTES };
class Counter implements SeqAllocator {
  calls = 0;
  constructor(public n: number) {}
  next(): number {
    this.calls += 1;
    return this.n++;
  }
}

const healthCodes = (drafts: readonly SeatDraft[]): readonly string[] =>
  drafts.filter((d): d is Extract<SeatDraft, { type: 'event' }> => d.type === 'event').map((d) => d.reason_code);

// ---------------------------------------------------------------- continuity (bullet 1)

test('continuity: the first hello id is kept; another id aliases; clear/compact/resume/fork keep the seat and accumulate sessionIds', () => {
  const h = harness();
  const seat = h.seats.fromHook(head('K1', 's1'));
  assert.equal(seat.number, 1);
  assert.equal(seat.seatId, null, 'created by a hook: seatId null until bound');
  const bound = h.seats.fromHello(hello(h.clock, S1));
  assert.equal(bound, seat);
  assert.equal(seat.seatId, S1);
  assert.equal(seat.wiring, 'FULL');
  h.seats.fromHello(hello(h.clock, S2));
  assert.deepEqual([...seat.aliases], [S2]);
  assert.equal(seat.seatId, S1);
  assert.equal(h.seats.bySeatId(S2), seat);
  for (const [sid, source] of [['s2', 'clear'], ['s3', 'compact'], ['s4', 'resume'], ['s5', 'fork']] as const) {
    h.seats.fromHook(head('K1', sid));   // SessionStart with `source`; registration keeps the seat
  }
  assert.equal(seat.number, 1);
  assert.deepEqual([...seat.sessionIds].sort(), ['s1', 's2', 's3', 's4', 's5']);
  const seatEvents = h.trace.ofKind('seat');
  assert.equal(seatEvents.filter((e) => e.op === 'register').length, 1);
  assert.equal(seatEvents.filter((e) => e.op === 'alias').length, 1);
});

// ---------------------------------------------------------------- pairing (bullet 2)

test('pairing: no hello within 3 s mints a 32-hex id with NO_MCP; a later hello becomes an alias with FULL; untilMono 1000 mints at 1000', async () => {
  const h = harness('seats');
  const seat = h.seats.fromHook(head('K1', 's1'));
  const p = h.seats.awaitBound(seat, h.clock.monoMs() + 5_000);
  h.clock.advance(C.MCP_PAIRING_MS - 1);
  let settled = false;
  void p.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, 'unresolved at 2,999 ms');
  const expected = randomHex(seededRandom('seats'), 16);
  h.clock.advance(1);
  const id = await p;
  assert.equal(id, expected, 'the minted id equals randomHex(random, 16)');
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(seat.wiring, 'NO_MCP');
  assert.deepEqual(healthCodes(h.drafts), ['SEAT_NO_MCP']);
  h.clock.advance(1_000);
  h.seats.fromHello(hello(h.clock, S2));
  assert.equal(seat.seatId, id, 'seatId unchanged after mint');
  assert.deepEqual([...seat.aliases], [S2]);
  assert.equal(seat.wiring, 'FULL', 'wiring left at the MCP hello');
  assert.deepEqual(healthCodes(h.drafts), ['SEAT_NO_MCP', 'SEAT_FULL']);

  // untilMono 1000 (a 1.5 s hook): the mint happens at 1000.
  const h2 = harness('seats2');
  const s2 = h2.seats.fromHook(head('K1', 's1'));
  const p2 = h2.seats.awaitBound(s2, 1_000);
  h2.clock.advance(1_000);
  const id2 = await p2;
  assert.match(id2, /^[0-9a-f]{32}$/);
  assert.equal(s2.createdMono, 0);
});

test('a hello arriving first binds immediately; awaitBound resolves the hello id at once', async () => {
  const h = harness();
  const seat = h.seats.fromHook(head('K1', 's1'));
  h.clock.advance(200);
  h.seats.fromHello(hello(h.clock, S1));
  assert.equal(seat.wiring, 'FULL');
  assert.equal(await h.seats.awaitBound(seat, h.clock.monoMs() + 5_000), S1);
});

// ---------------------------------------------------------------- lazy second repo (bullet 3)

test('a second SeatRegistry (another repo) registers the same seat_key lazily: its own #1, NO_MCP after 3 s', async () => {
  const other = harness('seats-other');
  const seat = other.seats.fromHook(head('K1', 's1'));
  const minted = other.seats.awaitBound(seat, other.clock.monoMs() + 5_000);
  other.clock.advance(C.MCP_PAIRING_MS);
  const id = await minted;
  assert.equal(seat.number, 1);
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(seat.wiring, 'NO_MCP');
});

// ---------------------------------------------------------------- numbers (bullet 4)

test('numbers 1,2,3 in registration order, never reused after an end; a fresh registry restarts at 1', async () => {
  const h = harness();
  const a = h.seats.fromHook(head('K1', 's1'));
  const b = h.seats.fromHook(head('K2', 's1'));
  const c = h.seats.fromHook(head('K3', 's1'));
  assert.deepEqual([a.number, b.number, c.number], [1, 2, 3]);
  await h.seats.end(b, 'mcp_eof');
  const d = h.seats.fromHook(head('K4', 's1'));
  assert.equal(d.number, 4);
  h.seats.fromHook(head('K1', 's9'));   // a clear SessionStart keeps seat 1
  assert.equal(a.number, 1);
  const fresh = harness('fresh');
  assert.equal(fresh.seats.fromHook(head('K1', 's1')).number, 1);
});

// ---------------------------------------------------------------- end (bullet 5)

test('end: one seat_end draft, one regions.releaseClaims call, one signal, every onEnd once, trace end; a second end is a no-op', async () => {
  const h = harness();
  const seat = h.seats.fromHello(hello(h.clock, S1));
  const ends: string[] = [];
  h.seats.onEnd(async (s) => { ends.push(s.seatId ?? '?'); });
  h.seats.onEnd(async () => { ends.push('second'); });
  assert.equal(seat.permissionMode, MODE);
  await h.seats.end(seat, 'mcp_eof');
  assert.ok(seat.ended);
  assert.equal(seat.activity, 'ENDED');
  const endDrafts = h.drafts.filter((d): d is Extract<SeatDraft, { type: 'seat_end' }> => d.type === 'seat_end');
  assert.equal(endDrafts.length, 1);
  assert.deepEqual(endDrafts[0], { type: 'seat_end', seat_id: S1, permission_mode: MODE });
  assert.equal(h.regions.length, 1);
  assert.deepEqual(h.regions[0], { holder: { peer: 'p1', seat: S1 }, reason: 'seat_end', target: 'all' });
  assert.deepEqual(h.signals, [{ kind: 'activity', seat: S1, activity: 'ENDED' }, { kind: 'seat_end', seat: S1 }]);
  assert.deepEqual(ends, [S1, 'second']);
  const endTrace = h.trace.ofKind('seat').filter((e) => e.op === 'end');
  assert.equal(endTrace.length, 1);
  assert.equal(endTrace[0]!.why, 'mcp_eof');
  await h.seats.end(seat, 'mcp_eof');
  assert.equal(h.drafts.filter((d) => d.type === 'seat_end').length, 1, 'the second end is a no-op');
  assert.equal(ends.length, 2);
  assert.equal(h.regions.length, 1);
});

test('F2 #110: a throwing onEnd listener is isolated — the next listener still runs and the end completes; the throw is logged (ROBUST round, t5-compose review)', async () => {
  const lines: Array<{ level: string; code: string; params: Record<string, unknown> | undefined }> = [];
  const h = harness('seats', { write: (level, code, params) => { lines.push({ level, code, params }); } });
  const seat = h.seats.fromHello(hello(h.clock, S1));
  h.seats.onEnd(async () => { throw new Error('probe-onEnd'); });
  const second: string[] = [];
  h.seats.onEnd(async (s) => { second.push(s.seatId ?? '?'); });
  await h.seats.end(seat, 'mcp_eof');
  assert.ok(seat.ended, 'the end completes');
  assert.deepEqual(second, [S1], 'the next listener still runs');
  const err = lines.find((l) => l.code === 'DAEMON_INTERNAL_ERROR');
  assert.ok(err !== undefined, 'the throw is logged');
  assert.equal((err!.params as { where?: string }).where, 'seat.onEnd');
  assert.equal((err!.params as { error?: string }).error, 'Error: probe-onEnd');
});

test('pid death ends the seat within 5 s via the seats ticker; a SessionEnd reason clear ends nothing', async () => {
  const h = harness();
  const seat = h.seats.fromHello(hello(h.clock, S1));
  h.pidsAlive.delete(4242);
  h.clock.advance(100);
  await h.seats.tick();
  assert.ok(!seat.ended, 'before the 5 s check');
  h.clock.advance(C.CLAUDE_PID_CHECK_MS);
  await h.seats.tick();
  assert.ok(seat.ended, 'ended at the next check (≤ 5 s after the death)');
  const endTrace = h.trace.ofKind('seat').filter((e) => e.op === 'end');
  assert.equal(endTrace[0]!.why, 'pid_gone');

  const h2 = harness();
  const s2 = h2.seats.fromHello(hello(h2.clock, S1));
  sendHook(h2, 'K1', 's1', 'SessionEnd');
  assert.ok(!s2.ended, 'SessionEnd with reason clear ends nothing');
});

// ---------------------------------------------------------------- precedence + health (bullet 6)

test('display precedence NO_HOOKS > PAUSED > DEGRADED > NO_MCP > HOOK_ONLY > PULL_MODE > FULL; one health event per change; every code in CCI_CODES', () => {
  assert.deepEqual([...DISPLAY_PRECEDENCE], ['NO_HOOKS', 'PAUSED', 'DEGRADED', 'NO_MCP', 'HOOK_ONLY', 'PULL_MODE', 'FULL']);
  const h = harness();
  const seat = h.seats.fromHello(hello(h.clock, S1));
  const display = (): string => h.seats.seatWiring(S1).display;
  assert.equal(display(), 'FULL');
  h.seats.setFlag(seat, 'PULL_MODE', true);
  assert.equal(display(), 'PULL_MODE');
  h.seats.setFlag(seat, 'DEGRADED', true);
  assert.equal(display(), 'DEGRADED');
  h.seats.setFlag(seat, 'DEGRADED', false);
  assert.equal(display(), 'PULL_MODE');
  h.seats.setWiring(seat, 'HOOK_ONLY', 'no_messaging');
  assert.equal(display(), 'HOOK_ONLY');
  h.seats.setFlag(seat, 'PAUSED', true);
  assert.equal(display(), 'PAUSED');
  h.seats.setWiring(seat, 'NO_HOOKS', null);
  assert.equal(display(), 'NO_HOOKS');
  const codes = healthCodes(h.drafts);
  assert.deepEqual(codes, ['SEAT_FULL', 'SEAT_PULL_MODE', 'DEGRADED', 'SEAT_PULL_MODE', 'HOOK_ONLY', 'PAUSED', 'NOHOOKS']);
  for (const c of codes) assert.ok(CCI_CODES.includes(c), c);
  const before = codes.length;
  h.seats.setFlag(seat, 'PULL_MODE', true);   // already on
  h.seats.setWiring(seat, 'NO_HOOKS', null);  // unchanged
  assert.equal(healthCodes(h.drafts).length, before, 'a no-change call queues none');
  // NO_MCP maps to SEAT_NO_MCP.
  const h2 = harness();
  const s2 = h2.seats.fromHello(hello(h2.clock, S2));
  h2.seats.setFlag(s2, 'PULL_MODE', true);
  h2.seats.setWiring(s2, 'NO_MCP', null);
  assert.deepEqual(healthCodes(h2.drafts), ['SEAT_FULL', 'SEAT_PULL_MODE', 'SEAT_NO_MCP']);
});

// ---------------------------------------------------------------- HOOK_ONLY notices (bullet 7)

test('HOOK_ONLY on one seat: every re-establishing hello re-arms the notice; a bound seat\'s no-messaging hello notices no_messaging (F2 #100)', async () => {
  // plan:2738's sequence on ONE bound seat. The re-establishing hellos of steps 4 and 6 make the next step's
  // precondition true ("on an open connection").
  const h = harness();
  const seat = h.seats.fromHello(hello(h.clock, S1));                  // 1. FULL
  assert.equal(seat.wiring, 'FULL');
  const noticesOf = (cause: string): number => h.notices.filter((n) => n.seatId === S1 && n.code === 'HOOK_ONLY' && (n.params as { cause?: string }).cause === cause).length;
  for (let i = 0; i < 5; i++) sendHook(h, 'K1', 's1', 'UserPromptSubmit');
  h.seats.onMcpClosed(seat);                                           // 2. pid still alive
  assert.equal(seat.wiring, 'HOOK_ONLY');
  assert.equal(seat.wiringCause, 'mcp_lost');
  assert.equal(noticesOf('mcp_lost'), 1);
  h.seats.fromHello(hello(h.clock, S1));                               // 3. a reconnect hello
  assert.equal(seat.wiring, 'FULL');
  assert.equal(seat.wiringCause, null);
  h.seats.onMcpClosed(seat);
  assert.equal(noticesOf('mcp_lost'), 2, 'one more notice on the next loss');
  h.seats.fromHello(hello(h.clock, S1));                               // 4. a reconnect: the connection is open again
  assert.equal(seat.wiring, 'FULL');
  // 5. A heartbeat gap > SEAT_HEARTBEAT_VALID_MS on an open connection with hooks arriving → HOOK_ONLY 'mcp_lost', one more notice.
  h.seats.onHeartbeat(seat);
  h.clock.advance(C.SEAT_HEARTBEAT_VALID_MS + 1);
  sendHook(h, 'K1', 's1', 'UserPromptSubmit');
  await h.seats.tick();
  assert.equal(seat.wiring, 'HOOK_ONLY');
  assert.equal(seat.wiringCause, 'mcp_lost');
  assert.equal(noticesOf('mcp_lost'), 3, 'the reconnect re-armed the once-per-cause notice');
  h.seats.fromHello(hello(h.clock, S1));                               // 6.
  assert.equal(seat.wiring, 'FULL');
  assert.equal(seat.wiringCause, null);
  h.seats.fromHello(hello(h.clock, S1, { messaging: false }));         // 7. the bound seat's no-messaging hello
  assert.equal(seat.wiring, 'HOOK_ONLY');
  assert.equal(seat.wiringCause, 'no_messaging');
  assert.equal(noticesOf('no_messaging'), 1);
  h.seats.fromHello(hello(h.clock, S1));                               // 8. a messaging hello: FULL, and the cause it leaves is re-armed
  assert.equal(seat.wiring, 'FULL');
  h.seats.fromHello(hello(h.clock, S1, { messaging: false }));         // 9. no_messaging again: one more notice
  assert.equal(seat.wiringCause, 'no_messaging');
  assert.equal(noticesOf('no_messaging'), 2, 'leaving no_messaging re-armed its once-per-cause notice');
  // The first-bind no_messaging path (a fresh registry).
  const h2 = harness();
  const s2 = h2.seats.fromHello(hello(h2.clock, S2, { messaging: false }));
  assert.equal(s2.wiring, 'HOOK_ONLY');
  assert.equal(s2.wiringCause, 'no_messaging');
  assert.equal(h2.notices.filter((n) => n.code === 'HOOK_ONLY' && (n.params as { cause?: string }).cause === 'no_messaging').length, 1);
});

// ---------------------------------------------------------------- activity (bullet 8)

test('activity from hooks only, one signal per change, never on unchanged; seats() lists the summary', async () => {
  const h = harness();
  const seat = h.seats.fromHello(hello(h.clock, S1));
  const acts: SeatActivity[] = [];
  const drive = (event: HookEvent, payload?: unknown): void => {
    const before = h.signals.length;
    sendHook(h, 'K1', 's1', event, payload);
    for (let i = before; i < h.signals.length; i++) {
      const s = h.signals[i]!;
      if (s.kind === 'activity') acts.push(s.activity);
    }
  };
  drive('SessionStart');
  assert.deepEqual(acts, [], 'SessionStart sets no activity (initial IDLE is not a change)');
  drive('UserPromptSubmit');
  assert.deepEqual(acts, ['MID_TURN']);
  const mid = acts.length;
  drive('PreToolUse');
  drive('PostToolUse');
  assert.equal(acts.length, mid, 'MID_TURN → MID_TURN is no signal');
  drive('Notification', { type: 'permission_prompt' });
  assert.deepEqual(acts, ['MID_TURN', 'AWAITING_PERMISSION']);
  drive('PostToolUse');
  assert.deepEqual(acts, ['MID_TURN', 'AWAITING_PERMISSION', 'MID_TURN']);
  drive('Stop', { background_tasks_running: 2 });
  assert.equal(acts[acts.length - 1], 'MID_TURN', 'Stop with background > 0 stays MID_TURN');
  drive('Stop', { background_tasks_running: 0 });
  assert.deepEqual(acts, ['MID_TURN', 'AWAITING_PERMISSION', 'MID_TURN', 'IDLE']);
  drive('StopFailure');
  assert.equal(acts.length, 4, 'StopFailure → IDLE is no change');
  drive('Notification', { type: 'idle_prompt' });
  assert.equal(acts.length, 4);
  await h.seats.end(seat, 'mcp_eof');
  const endActs = h.signals.filter((s) => s.kind === 'activity').map((s) => (s as { activity: SeatActivity }).activity);
  assert.deepEqual(endActs.slice(-1), ['ENDED'], 'the end sends the ENDED activity signal');
  assert.equal(h.signals.filter((s) => s.kind === 'seat_end').length, 1);
  const list = h.seats.seats();
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], { seat_id: S1, number: 1, activity: 'ENDED', wiring: 'FULL', flags: [], lastHookMono: list[0]!.lastHookMono });
  assert.ok(typeof list[0]!.lastHookMono === 'number');
});

// ---------------------------------------------------------------- FREEZE ops (bullet 10, plan 2747)

test('a registered seat queues seat_start and a health event; under [frozen] take returns the health event, not seat_start; seat_end leaves while frozen; seat_start after the freeze lifts (PRO-45, F2 #39)', async () => {
  const box = new Outbox();
  const drafts: SeatDraft[] = [];
  const seats = new SeatRegistry({
    clock: new VirtualClock(), random: seededRandom('freeze'), trace: new TraceRecorder() as unknown as Trace, peer: 'p1',
    outbox: (d) => { drafts.push(d); box.add(d); },
    pidAlive: () => true, notice: () => undefined, signals: { send: () => undefined },
  });
  const seat = seats.fromHook({ ...head('K1', 's1'), permission_mode: 'acceptEdits' });
  seats.fromHello(hello(new VirtualClock(), S1));
  const start = drafts.find((d) => d.type === 'seat_start');
  const health = drafts.find((d) => d.type === 'event');
  assert.deepEqual(start, { type: 'seat_start', seat_id: S1, permission_mode: 'acceptEdits' });
  assert.ok(health !== undefined && health.type === 'event' && health.kind === 'health');
  assert.equal(allowedInAll(start!, ['frozen']), false, 'PRO-45: seat_start waits out a freeze');
  assert.equal(allowedInAll(health, ['frozen']), true, 'PRO-45: health events leave while frozen');
  const alloc = new Counter(1);
  const frozen1 = box.take(['frozen'], SELF, alloc, ROOM);
  assert.ok(frozen1.length > 0);
  assert.ok(frozen1.every((op) => op.type === 'event' && op.kind === 'health'), `frozen take: ${frozen1.map((op) => op.type).join(',')}`);
  await seats.end(seat, 'mcp_eof');
  const end = drafts.find((d) => d.type === 'seat_end');
  assert.ok(end !== undefined);
  assert.equal(allowedInAll(end, ['frozen']), true, 'PRO-45: seat_end leaves while frozen');
  const frozen2 = box.take(['frozen'], SELF, alloc, ROOM);
  assert.ok(frozen2.some((op) => op.type === 'seat_end'), 'seat_end taken while still frozen');
  assert.ok(!frozen2.some((op) => op.type === 'seat_start'));
  const lifted = box.take([], SELF, alloc, ROOM);
  const started = lifted.filter((op) => op.type === 'seat_start');
  assert.equal(started.length, 1, 'seat_start taken once the freeze lifts');
  assert.equal((started[0] as { permission_mode?: string }).permission_mode, 'acceptEdits');
});

// ---------------------------------------------------------------- bounded memory (F2 #57)

test('ended seats are bounded: 1,000 seat starts and ends keep exactly the newest 256 ended seats; numbers keep increasing; a late hello for a kept ended seat touches nothing, one for a forgotten seat registers anew (F2 #57)', async () => {
  const h = harness();
  const ids = seededRandom('bounded-ids');
  for (let i = 0; i < 1_000; i++) {
    const seat = h.seats.fromHello(hello(h.clock, randomHex(ids, 16), { key: `K${i}` }));
    await h.seats.end(seat, 'mcp_eof');
  }
  // Exactly the newest 256 ended seats are kept whole (one key and one id each): K744 … K999.
  assert.deepEqual(h.seats.sizesForTest(), { order: 256, byKey: 256, byId: 256 });
  assert.equal(h.seats.fromHook(head('K-next', 's1')).number, 1_001, 'numbers are never reused');
  const registers = (): number => h.trace.ofKind('seat').filter((e) => e.op === 'register').length;
  const registersBefore = registers();
  const late = h.seats.fromHello(hello(h.clock, randomHex(ids, 16), { key: 'K999' }));
  assert.equal(registers(), registersBefore, 'a late hello registers nothing');
  assert.equal(late.ended, true);
  // The oldest kept ended seat still behaves as today: its late hello touches nothing.
  const oldestKept = h.seats.fromHello(hello(h.clock, randomHex(ids, 16), { key: 'K744' }));
  assert.equal(registers(), registersBefore, 'K744 is still kept: its late hello registers nothing');
  assert.equal(oldestKept.ended, true);
  // The newest forgotten one registers anew (the F2 #57 Ruling): a new live seat with the next number.
  const forgotten = h.seats.fromHello(hello(h.clock, randomHex(ids, 16), { key: 'K743' }));
  assert.equal(registers(), registersBefore + 1, 'K743 was forgotten: its hello registers a new seat');
  assert.equal(forgotten.ended, false);
  assert.equal(forgotten.number, 1_002);
});

// ---------------------------------------------------------------- O-SEAT (bullet 9)

type Act =
  | { c: 'hook'; k: number; sid: number }
  | { c: 'hello'; k: number; id: number }
  | { c: 'mcpDrop'; k: number } | { c: 'mcpEof'; k: number } | { c: 'pidDie'; k: number }
  | { c: 'churn'; k: number; src: 'clear' | 'compact' | 'resume' | 'fork'; sid: number }
  | { c: 'tick'; ms: number };

test('O-SEAT (unit): fast-check 300 runs — one register per key, aliases only after binding, ≤ 1 end, numbers strictly increasing, churn keeps the seat', () => {
  const keyArb = fc.constantFrom(1, 2, 3) as fc.Arbitrary<number>;
  const cmd: fc.Arbitrary<Act> = fc.oneof(
    fc.record({ c: fc.constant('hook'), k: keyArb, sid: fc.nat(4) }) as fc.Arbitrary<Act>,
    fc.record({ c: fc.constant('hello'), k: keyArb, id: fc.nat(3) }) as fc.Arbitrary<Act>,
    fc.record({ c: fc.constant('mcpDrop'), k: keyArb }) as fc.Arbitrary<Act>,
    fc.record({ c: fc.constant('mcpEof'), k: keyArb }) as fc.Arbitrary<Act>,
    fc.record({ c: fc.constant('pidDie'), k: keyArb }) as fc.Arbitrary<Act>,
    fc.record({ c: fc.constant('churn'), k: keyArb, src: fc.constantFrom('clear', 'compact', 'resume', 'fork'), sid: fc.nat(4) }) as fc.Arbitrary<Act>,
    fc.record({ c: fc.constant('tick'), ms: fc.nat(6_000) }) as fc.Arbitrary<Act>,
  );
  fc.assert(fc.property(fc.array(cmd, { maxLength: 60 }), (acts) => {
    const h = harness();
    const ids = [S1, S2, S3];
    const byKey = new Map<number, unknown>();
    for (const a of acts) {
      try {
        switch (a.c) {
          case 'hook': byKey.set(a.k, h.seats.fromHook(head(`K${a.k}`, `s${a.sid}`))); break;
          case 'hello': {
            const known = byKey.get(a.k);
            const id = ids[a.id] ?? hexId();
            const f = hello(h.clock, id, { key: `K${a.k}` });
            if (known !== undefined) h.seats.fromHello(f);
            else byKey.set(a.k, h.seats.fromHello({ ...f }));    // an unpaired hello creates its own seat
            break;
          }
          case 'mcpDrop': { const seat = byKey.get(a.k); if (seat !== undefined) h.seats.onMcpClosed(seat as never); break; }
          case 'mcpEof': { const seat = byKey.get(a.k); if (seat !== undefined) void h.seats.end(seat as never, 'mcp_eof'); break; }
          case 'pidDie': {
            const seat = byKey.get(a.k);
            if (seat !== undefined) { h.pidsAlive.delete(4242); h.clock.advance(C.CLAUDE_PID_CHECK_MS); void h.seats.tick(); h.pidsAlive.add(4242); }
            break;
          }
          case 'churn': {
            const seat = byKey.get(a.k);
            if (seat !== undefined) {
              const s = h.seats.fromHook(head(`K${a.k}`, `c${a.sid}${a.src}`));
              assert.equal(s, seat, 'churn keeps the seat of its key');
            }
            break;
          }          case 'tick': h.clock.advance(a.ms); void h.seats.tick(); break;
        }
      } catch { /* a command that does not apply (an ended seat's op) is not a violation */ }
      const seatEvents = h.trace.ofKind('seat');
      // Exactly one register per seat key; numbers strictly increasing in register order.
      const registers = seatEvents.filter((e) => e.op === 'register');
      assert.equal(registers.length, new Set(registers.map((e) => (e as unknown as { seat_key: string }).seat_key)).size, 'one register per key');
      const numbers = registers.map((e) => (e as unknown as { seat_number: number }).seat_number);
      for (let i = 1; i < numbers.length; i++) assert.ok(numbers[i]! > numbers[i - 1]!, 'numbers strictly increasing in register order');
      // alias only after a binding; at most one end per key and nothing but end after it.
      let sawBind = new Map<string, boolean>();
      let sawEnd = new Map<string, boolean>();
      for (const e of seatEvents) {
        const k = (e as unknown as { seat_key: string }).seat_key;
        if (e.op === 'alias') assert.ok(sawBind.get(k) === true, 'alias follows a binding');
        if (e.op === 'flag' || e.op === 'wiring' || e.op === 'register') assert.ok(!sawEnd.get(k), 'nothing after end');
        if (e.op === 'end') { assert.ok(!sawEnd.get(k), 'at most one end'); sawEnd.set(k, true); }
        if (e.op === 'wiring') sawBind.set(k, true);
      }
    }
    // Post-run invariants: every seat's aliases exclude its seatId (never re-keyed).
    for (const seat of byKey.values()) {
      const s = seat as { seatId: string | null; aliases: readonly string[] };
      if (s.seatId !== null) assert.ok(!s.aliases.includes(s.seatId));
      for (const al of s.aliases) assert.ok(al !== s.seatId);
    }
  }), { numRuns: 300 });
});
