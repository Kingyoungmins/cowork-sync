// test/unit/claude.turns.property.test.ts — O-TURN-ORIGIN (unit): over 500 random turn sequences no nonce prompt
// refreshes the attended window, opens a human turn, emits prompt or resets the CS mid-turn, no mid-turn doorbell
// releases a lease, and every `wake` event is either rule (a) — a nonce UPS whose nonce has a post in flight or sent
// (or already seen) with a prompt_id different from that post's recorded one and the current turn's — or fallback (b) —
// a non-UPS hook after a SENT post that is < 60 s old, was eligible (no hook in the 60 s before it, no turn open),
// was not yet used by (b), saw no nonce-less UPS since, and whose recorded prompt_id differs from the hook's; under
// M44 the property fails (A6-11). The runner drives the registered `turn.prompt`/`signal.emit`/`turn.stop` steps over
// ctx doubles (a SignalPump spy, an engine double with no open CS), the Ringer's TurnOrigin calls (onRingInFlight at
// send, then 'sent' / 'refused' / 'error' / a silent 5 s timeout; a nonce UPS may come between — the R-F2-17 race),
// SeatRegistry.fromHook for every hook (seatRouting's lastHookMono) and the `turns` ticker's expire at each time step.
// The oracle keeps its own model of every post (F2 #66, #26); it never reads seat.turn.pending.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { VirtualClock } from '../sim/vclock.js';
import { TraceRecorder } from '../sim/traceRecorder.js';
import { SeatRegistry } from '../../src/claude/daemon/seats.js';
import { TurnOrigin } from '../../src/claude/daemon/turns.js';
import { runStep } from '../../src/claude/daemon/pipeline.js';
import { C } from '../../src/claude/wire/constants.js';
import type { Seat } from '../../src/claude/daemon/seats.js';
import type { CsSignal } from '../../src/holds/signals.js';
import type { DaemonCtx, HookRequest } from '../../src/claude/daemon/ctx.js';
import type { TraceEvent } from '../../src/ports/trace.js';
import type { Engine } from '../../src/engine/loop.js';
import type { Fs } from '../../src/ports/fs.js';
import type { Random } from '../../src/ports/random.js';
import type { MutantId } from '../../src/engine/deps.js';

const S = 's'.repeat(32);
const K1 = 'k'.repeat(64);
const NONCES = ['cws-0123456789abcdef', 'cws-aaaaaaaaaaaaaaaa', 'cws-fedcba9876543210'];

type Outcome = 'sent' | 'refused' | 'error' | 'silent';
type Cmd =
  | { c: 'ringSend'; nonce: number }                               // the Ringer sent the frame: onRingInFlight
  | { c: 'ringResult'; outcome: Outcome }                          // the oldest in-flight ring's ring_result (silent: the 5 s wait elapses)
  | { c: 'nonceUps'; nonce: number; newPrompt: boolean }
  | { c: 'humanUps' }
  | { c: 'other'; newPrompt: boolean }                             // PreToolUse/PostToolUse
  | { c: 'stop' }
  | { c: 'expansion'; nonce: number; newPrompt: boolean }
  | { c: 'time' };

const cmdsArb: fc.Arbitrary<Cmd[]> = fc.array(
  fc.oneof(
    fc.record({ c: fc.constant('ringSend' as const), nonce: fc.constantFrom(...NONCES.map((_, i) => i)) }),
    fc.record({ c: fc.constant('ringResult' as const), outcome: fc.constantFrom<Outcome>('sent', 'refused', 'error', 'silent') }),
    fc.record({ c: fc.constant('nonceUps' as const), nonce: fc.constantFrom(...NONCES.map((_, i) => i)), newPrompt: fc.boolean() }),
    fc.record({ c: fc.constant('humanUps' as const) }),
    fc.record({ c: fc.constant('other' as const), newPrompt: fc.boolean() }),
    fc.record({ c: fc.constant('stop' as const) }),
    fc.record({ c: fc.constant('expansion' as const), nonce: fc.constantFrom(...NONCES.map((_, i) => i)), newPrompt: fc.boolean() }),
    fc.record({ c: fc.constant('time' as const) }),
  ),
  { minLength: 1, maxLength: 40 },
);

function rig(mutants?: ReadonlySet<MutantId>): { clock: VirtualClock; trace: TraceRecorder; seats: SeatRegistry; turns: TurnOrigin; seat: Seat; sends: CsSignal[]; ctx: DaemonCtx } {
  const clock = new VirtualClock({ startMono: 0 });
  const trace = new TraceRecorder();
  const random: Random = { bytes: () => Buffer.alloc(16, 7) };
  const seats = new SeatRegistry({
    clock, random, trace, peer: 'peer-1',
    outbox: () => undefined, pidAlive: () => true, notice: () => undefined, signals: { send: () => undefined },
  });
  const turns = new TurnOrigin(seats, clock, trace, { openFor: () => ({ inflight: 1, txns: 1 }) }, mutants);   // something to release (F2 #66)
  const seat = seats.fromHello({ t: 'hello', seat_id: S, seat_key: K1, claude_pid: 1, cc_version: null, plugin_version: '0.0.0', hook_proto: 3, messaging_present: true });
  const sends: CsSignal[] = [];
  const engine = { openCsOf: () => null, checkpointCommands: () => [] } as unknown as Engine;
  const ctx = {
    ports: { clock, fs: {} as Fs },
    signals: { send: (s: CsSignal) => sends.push(s) },
    engine,
    events: { nonceSeen: () => [] },
    bindings: { coordHooks: { onUserPromptSubmit: () => undefined } },
    turns, seat,
  } as unknown as DaemonCtx;
  return { clock, trace, seats, turns, seat, sends, ctx };
}

function reqOf(ctx: DaemonCtx, event: string, payload: Record<string, unknown>, promptId: string): { r: HookRequest; d: { deny: null } } {
  const h = { seat_key: K1, claude_pid: 1, session_id: 's1', prompt_id: promptId, agent_id: null, agent_type: null, permission_mode: 'default', repo_root: '/', plugin_version: '0.0.0', hook_proto: 3 };
  return { r: { frame: { t: 'hook', event, h, payload }, seat: (ctx as unknown as { seat: Seat }).seat } as unknown as HookRequest, d: { deny: null } };
}

const turnEvents = (trace: TraceRecorder): Array<Extract<TraceEvent, { kind: 'turn' }>> =>
  trace.events.filter((e): e is Extract<TraceEvent, { kind: 'turn' }> => e.kind === 'turn');

/** The oracle's own record of one post (never read from seat.turn.pending). */
interface Post {
  nonce: string; state: 'inflight' | 'sent' | 'failed'; recorded: string | null; sentMono: number;
  eligible: boolean;               // no hook in the 60 s before the post and no turn open at it
  nonceLessUpsSince: boolean;      // a UserPromptSubmit without a nonce was driven since the post
  bUsed: boolean;                  // fallback (b) already woke a turn from it
  seen: boolean;                   // a UserPromptSubmit carried its nonce (the pending wake ended)
}

/** One random sequence; violations of the O-TURN-ORIGIN properties are returned (empty = the property held). */
async function run(cmds: Cmd[], mutants?: ReadonlySet<MutantId>): Promise<string[]> {
  const v: string[] = [];
  const { clock, trace, seats, turns, seat, sends, ctx } = rig(mutants);
  let promptId = 0;
  const pid = (fresh: boolean): string => `p${(fresh ? ++promptId : promptId)}`;
  let posts: Post[] = [];
  let lastHook: number | null = null;                              // the runner's own record of seat.lastHookMono
  const hook = (): void => {                                       // seatRouting's fromHook for every hook event
    seats.fromHook({ seat_key: K1, claude_pid: 1, session_id: 's1' });
    lastHook = clock.monoMs();
  };
  const fail = (p: Post): void => {                                // the Ringer's onRingFailed
    turns.onRingFailed(seat, p.nonce);
    if (p.seen) p.state = 'failed';
    else posts = posts.filter((x) => x !== p);
  };
  for (const cmd of cmds) {
    const beforeSends = sends.length;
    const beforeMono = seat.turn.lastHumanPromptMono;
    const eventsBefore = turnEvents(trace).length;
    const turnIdBefore = seat.turn.promptId;
    let hookId: string | null = null;
    switch (cmd.c) {
      case 'ringSend': {
        const nonce = NONCES[cmd.nonce]!;
        const now = clock.monoMs();
        posts = posts.filter((p) => p.nonce !== nonce);
        posts.push({
          nonce, state: 'inflight', recorded: seat.turn.promptId ?? seat.turn.recordedPromptId, sentMono: now,
          eligible: (lastHook === null || now - lastHook >= C.WAKE_QUIET_BEFORE_POST_MS) && seat.turn.origin === null,
          nonceLessUpsSince: false, bUsed: false, seen: false,
        });
        turns.onRingInFlight(seat, nonce, ['e1']);
        break;
      }
      case 'ringResult': {
        const p = posts.find((x) => x.state === 'inflight');
        if (p === undefined) break;
        if (cmd.outcome === 'sent') {
          const seenEarly = turns.onRingSent(seat, p.nonce, ['e1']);
          if (seenEarly !== p.seen) v.push(`onRingSent's seen-early answer ${seenEarly} for a post the oracle has seen=${p.seen}`);
          p.state = 'sent';
        } else {
          if (cmd.outcome === 'silent') clock.advance(C.RING_RESULT_WAIT_MS);   // no ring_result: the 5 s wait is 'error'
          fail(p);
        }
        break;
      }
      case 'nonceUps':
      case 'humanUps': {
        hook();
        const nonces = cmd.c === 'nonceUps' ? [NONCES[cmd.nonce]!] : [];
        const target = pid(cmd.c === 'nonceUps' ? cmd.newPrompt : true);   // a human UPS is always a fresh prompt
        hookId = target;
        const { r, d } = reqOf(ctx, 'UserPromptSubmit', { event: 'UserPromptSubmit', nonces }, target);
        await runStep('turn.prompt', r as never, d as never, ctx);    // the runner awaits the step
        await runStep('signal.emit', r as never, d as never, ctx);
        break;
      }
      case 'expansion': {
        hook();
        const nonces = cmd.nonce === 0 ? [NONCES[0]!] : [];
        turns.classifyExpansion(seat, pid(cmd.newPrompt), nonces);     // the step's classification only
        break;
      }
      case 'other':
        hook();
        hookId = pid(cmd.newPrompt);
        turns.onOtherHook(seat, hookId);
        if (seat.turn.origin === 'human' && turnEvents(trace).length > eventsBefore) v.push('(b) opened a human turn');
        break;
      case 'stop': {
        hook();
        const { r, d } = reqOf(ctx, 'Stop', { event: 'Stop', stop_hook_active: false, background_tasks_running: 0, ids_in_last_message: null }, 'x');
        await runStep('turn.stop', r as never, d as never, ctx);
        break;
      }
      case 'time':
        clock.advance(1_000 + Math.floor(clock.monoMs() % 89_000));    // 1 s–90 s (deterministic per position)
        for (const p of posts.filter((x) => x.state === 'inflight' && clock.monoMs() - x.sentMono >= C.RING_RESULT_WAIT_MS)) fail(p);   // the Ringer's 5 s timeout
        turns.expire();                                              // the `turns` ticker
        break;
    }
    const fresh = turnEvents(trace).slice(eventsBefore);
    const last = turnEvents(trace).at(-1);
    // Every wake decision of this step against the oracle's posts (rule (a) or fallback (b)).
    for (const ev of fresh.filter((e) => e.op === 'wake')) {
      if (cmd.c === 'nonceUps') {
        v.push('a wake event from a nonce UserPromptSubmit (rule (a) marks the doorbell)');
      } else if (cmd.c === 'other') {
        const now = clock.monoMs();
        const due = posts.find((p) => p.state === 'sent' && !p.seen && p.eligible && !p.bUsed && !p.nonceLessUpsSince && now - p.sentMono < C.PENDING_WAKE_EXPIRY_MS);
        if (due === undefined) v.push('a (b) wake with no sent, eligible, unused, unexpired post');
        else if (hookId !== null && hookId === due.recorded) v.push('a (b) wake for a hook carrying the recorded prompt_id');
        else due.bUsed = true;
      } else {
        v.push(`a wake event from ${cmd.c}`);
      }
    }
    if (cmd.c === 'nonceUps') {
      const nonce = NONCES[cmd.nonce]!;
      const posted = posts.filter((p) => p.nonce === nonce);
      const doorbell = fresh.find((e) => e.op === 'doorbell');
      // Rule (a): the doorbell opened a wake turn (seat.turn became {hookId, wake}) only for a posted nonce with a new prompt_id.
      const opened = doorbell !== undefined && seat.turn.origin === 'wake' && seat.turn.promptId === hookId && turnIdBefore !== hookId;
      if (opened && !posted.some((p) => p.recorded !== hookId)) v.push('a rule-(a) wake with no post of that nonce or the recorded prompt_id');
      if (opened && hookId === turnIdBefore) v.push("a rule-(a) wake with the current turn's prompt_id");
      for (const p of posted) p.seen = true;
      if (seat.turn.lastHumanPromptMono !== beforeMono) v.push('a nonce prompt refreshed the attended window');
      if (sends.slice(beforeSends).some((s) => s.kind === 'prompt')) v.push('a nonce prompt emitted a prompt signal');
      if (last !== undefined && last.op === 'doorbell' && fresh.includes(last)) {
        if (last.humanPromptRefreshed !== false) v.push('a doorbell refreshed the attended window');
        if (seat.turn.origin !== null && last.released !== 0) v.push('a mid-turn doorbell released a lease');
      } else {
        v.push('a nonce prompt produced no doorbell event');
      }
    }
    if (cmd.c === 'humanUps') for (const p of posts) p.nonceLessUpsSince = true;
    if (cmd.c === 'expansion' && last !== undefined && last.op === 'doorbell' && last.humanPromptRefreshed !== false) {
      v.push('an expansion refreshed the attended window');
    }
    if (seat.turn.origin !== null && seat.turn.origin !== 'human' && seat.turn.origin !== 'wake') v.push('an unknown origin');
  }
  return v;
}

// The runner awaits each step: runStep resolves after the step body (the invariants read the settled state).

test('O-TURN-ORIGIN (unit): over random sequences no nonce prompt refreshes, opens a human turn, resets mid-turn, or releases; every wake is rule (a) or a (b) whose preconditions held (500 runs)', async () => {
  await fc.assert(
    fc.asyncProperty(cmdsArb, async (cmds) => {
      const v = await run(cmds);
      assert.deepEqual(v, []);
    }),
    { numRuns: 500 },
  );
});

test('under M44 the property fails: the same nonce prompt refreshes the attended window and emits prompt (A6-11)', async () => {
  const seq: Cmd[] = [{ c: 'ringSend', nonce: 0 }, { c: 'ringResult', outcome: 'sent' }, { c: 'nonceUps', nonce: 0, newPrompt: true }];
  const v = await run(seq, new Set<MutantId>(['M44']));
  assert.ok(v.length > 0, `M44 must be caught, violations: ${JSON.stringify(v)}`);
  const vClean = await run(seq);
  assert.deepEqual(vClean, []);
});
