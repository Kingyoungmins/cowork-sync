// test/unit/claude.signals.test.ts — Task 6's signal cells (R5-24, R5-23, R5-20 unit half, R2-C1…R2-C3, A6-4,
// A6-8, A6-10, A6-13, F05-09; 06 test 29's unit half). Engine doubles for SignalPump; ctx doubles for the
// `signal.emit` step, the IdleTimer and captureIdentity (Task 8's DiskSnapshots has landed; the SE5-03 "late"
// case is pinned with a `take` double that throws).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { VirtualClock } from '../sim/vclock.js';
import { TraceRecorder } from '../sim/traceRecorder.js';
import { GatedClock } from '../helpers/gatedClock.js';
import { SignalPump, IdleTimer, greenCheck, captureIdentity, onContextReset, identityMemoSizeForTest } from '../../src/claude/daemon/signals.js';
import { runStep } from '../../src/claude/daemon/pipeline.js';
import type { Engine } from '../../src/engine/loop.js';
import type { CsSignal, SeatActivity } from '../../src/holds/signals.js';
import type { Log, LogParam } from '../../src/ports/log.js';
import type { Fs, FsLstat } from '../../src/ports/fs.js';
import type { DaemonCtx, HookRequest } from '../../src/claude/daemon/ctx.js';
import type { HookHeader, HookPayload, HookEvent } from '../../src/claude/wire/frames.js';

const S = 's'.repeat(32);

interface LogRow { code: string; params?: Readonly<Record<string, LogParam>> }
const logOf = (rows: LogRow[]): Log => ({ write: (_l, code, params) => rows.push({ code, params }) }) as Log;

/** An Engine double: signal records synchronously and returns a promise that never settles (or rejects). */
const engineCalls: CsSignal[] = [];
function engineDouble(opts?: { reject?: boolean; table?: Array<{ cs_id: string; cap_seq: number }>; openCs?: string | null; paths?: string[] }): Engine {
  engineCalls.length = 0;
  return {
    markSince: () => undefined, foldedHeight: () => 0,
    signal: (s: CsSignal) => {
      engineCalls.push(s);
      return opts?.reject === true ? Promise.reject(new Error('engine down')) : new Promise<void>(() => {});
    },
    core: { cs: { table: () => ({ cs: opts?.table ?? [] }) } },
    openCsOf: () => (opts?.openCs === undefined ? null : opts.openCs),
    csPaths: () => opts?.paths ?? ['src/a.ts'],
    checkpointCommands: () => ['npm test', 'pytest -q'],
  } as unknown as Engine;
}

const neverPending = (): Promise<void> => new Promise(() => {});

test('Engine.signal is never awaited on the reply path; three sends, three calls in order (R5-24, A6-4)', () => {
  const logs: LogRow[] = [];
  const engine = engineDouble();
  const pump = new SignalPump(engine, logOf(logs));
  pump.send({ kind: 'prompt', seat: S, humanOrigin: true, nonce: false });
  pump.send({ kind: 'stop', seat: S });
  pump.send({ kind: 'effect', seat: S, agent: null, toolUseId: 'tu1', paths: ['src/a.ts'], turnOrigin: 'prompt' });
  assert.equal(engineCalls.length, 3);                              // each recorded before send returned
  assert.deepEqual(engineCalls.map((c) => c.kind), ['prompt', 'stop', 'effect']);
  assert.equal(logs.length, 0);
});

test('a rejecting Engine.signal logs one CS_SIGNAL_REJECTED line and touches nothing else (A6-9)', async () => {
  const logs: LogRow[] = [];
  const pump = new SignalPump(engineDouble({ reject: true }), logOf(logs));
  pump.send({ kind: 'stop', seat: S });
  await new Promise<void>((r) => { setTimeout(r, 5).unref(); });   // let the rejection land
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.code, 'CS_SIGNAL_REJECTED');
  assert.equal(logs[0]!.params?.['kind'], 'stop');
});

test('cand_seq is one per-CS counter seeded from Plan 3 cap_seq (A6-4, A13-5, X5-12)', () => {
  const engine = engineDouble({ table: [{ cs_id: 'S/1', cap_seq: 4 }] });
  const pump = new SignalPump(engine, logOf([]));
  assert.equal(pump.nextCandSeq('S/1'), 5);
  assert.equal(pump.nextCandSeq('S/1'), 6);
  assert.equal(pump.nextCandSeq('S/2'), 1);                        // no entry → starts at 1
  const fresh = new SignalPump(engine, logOf([]));                 // a daemon restart reads cap_seq again
  assert.equal(fresh.nextCandSeq('S/1'), 5);
});

test('greenCheck: ok on exit 0 or no exposed status, false on failure; green only on an ok PostToolUse (R5-23, A6-8)', () => {
  const commands = ['npm test', 'pytest -q'];
  const ptu = (command: string, tool_name: string, exit_status: number | null, event: 'PostToolUse' | 'PostToolUseFailure' | 'PermissionDenied' = 'PostToolUse'): Extract<HookPayload, { event: 'PostToolUse' | 'PostToolUseFailure' | 'PermissionDenied' }> =>
    ({ event, tool_name, tool_use_id: 'tu1', path: null, read: null, exit_status, command } as Extract<HookPayload, { event: 'PostToolUse' | 'PostToolUseFailure' | 'PermissionDenied' }>);
  assert.deepEqual(greenCheck(ptu('npm test -- --watch=false', 'Bash', 0), commands), { checksRun: true, green: true });
  assert.deepEqual(greenCheck(ptu('npm test', 'Bash', 1), commands), { checksRun: false, green: false });   // plan 2812: checksRun is checks_run's ok
  assert.deepEqual(greenCheck(ptu('pytest -q', 'Bash', null), commands), { checksRun: true, green: true });   // 06 §8 Q6 default
  assert.deepEqual(greenCheck(ptu('pytest -q', 'Bash', 3, 'PostToolUseFailure'), commands), { checksRun: false, green: false });
  assert.deepEqual(greenCheck(ptu('npm test', 'Bash', null, 'PermissionDenied'), commands), { checksRun: null, green: false });
  assert.deepEqual(greenCheck(ptu('npm testx', 'Bash', 0), commands), { checksRun: null, green: false });     // not a prefix with whitespace
  assert.deepEqual(greenCheck(ptu('npm test', 'Monitor', 0), commands), { checksRun: null, green: false });
  assert.deepEqual(greenCheck(ptu('  npm test', 'PowerShell', 0), commands), { checksRun: true, green: true });   // leading spaces
});

test('captureIdentity: known post-images are used without any read; missing is ABSENT; a throwing take is late (R5-20, A6-5, SE5-03)', async () => {
  const clock = new GatedClock({ startMono: 0 });
  const root = resolve('/t6-capture-root');
  const lstatCalls: string[] = [];
  const fs = {
    lstat: async (p: string) => {
      lstatCalls.push(p);
      return p === join(root, 'src', 'gone.ts') ? null : { size: 3, mtimeNs: 1n, ino: 1n, dev: 1n, mode: 0o100644, isFile: true, isDirectory: false, isSymbolicLink: false } as FsLstat;
    },
    readFile: async () => Buffer.alloc(3, 2),
  } as unknown as Fs;
  const ctx = { repo: { root }, ports: { clock, fs }, reads: { take: async () => { throw new Error('take failed'); }, release: async () => undefined } } as unknown as DaemonCtx;
  const oid = 'a'.repeat(40) as never;
  const known = new Map([['src/a.ts', { path: 'src/a.ts', oid, bytes: Buffer.alloc(3, 1), spill: null, size: 3 }]]);
  const out = await captureIdentity(S, ['src/a.ts', 'src/gone.ts'], known, ctx, 150);
  assert.deepEqual(out, { 'src/a.ts': oid, 'src/gone.ts': 'ABSENT' });   // known: no read; missing: ABSENT
  assert.deepEqual(lstatCalls, [join(root, 'src', 'gone.ts')]);           // the known path used no lstat; the clone's absolute path
  const late = await captureIdentity(S, ['src/b.ts'], new Map(), ctx, 150);   // needs a read → the take throws → null
  assert.equal(late, null);
});

function turnState(): Record<string, unknown> {
  return { pending: [], origin: null, promptId: null, recordedPromptId: null, lastHumanPromptMono: null, wakeTurnStartMono: null };
}

function req(event: HookEvent, payload: HookPayload, turn: Record<string, unknown> | null = null): { r: HookRequest; d: { deny: null } } {
  const h = { seat_key: 'k'.repeat(64), claude_pid: 1, session_id: 's1', prompt_id: null, agent_id: null, agent_type: null, permission_mode: 'default', repo_root: '/', plugin_version: '0.0.0', hook_proto: 3 } as HookHeader;
  return { r: { frame: { t: 'hook', event, h, payload }, seat: { seatId: S, turn } } as unknown as HookRequest, d: { deny: null } };
}

test('the signal set of 06 §3.12.1, per event, through signal.emit (R2-C1, BL3-01, CCI-36)', async () => {
  const clock = new VirtualClock({ startMono: 0 });
  const sends: CsSignal[] = [];
  const engine = engineDouble();
  const pump = new SignalPump(engine, logOf([]));
  const ctx = {
    ports: { clock, fs: {} as Fs }, signals: { send: (s: CsSignal) => sends.push(s), nextCandSeq: (csId: string) => pump.nextCandSeq(csId) },
    engine, reads: { take: async () => { throw new Error('Plan 5 Task 8'); } },
  } as unknown as DaemonCtx;
  const { r, d } = req('UserPromptSubmit', { event: 'UserPromptSubmit', nonces: [] }, turnState());
  (r as unknown as { turn: unknown }).turn = { doorbell: false, newTurn: true, origin: 'human' };
  await runStep('signal.emit', r, d as never, ctx);
  assert.deepEqual(sends, [{ kind: 'prompt', seat: S, humanOrigin: true, nonce: false }]);
  sends.length = 0;
  const { r: rw, d: dw } = req('UserPromptSubmit', { event: 'UserPromptSubmit', nonces: [] }, turnState());
  (rw as unknown as { turn: unknown }).turn = { doorbell: false, newTurn: true, origin: 'wake' };
  await runStep('signal.emit', rw, dw as never, ctx);
  assert.deepEqual(sends, []);                                     // a wake turn opens nothing
  sends.length = 0;
  const { r: rg, d: dg } = req('PostToolUse', { event: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'tu1', path: null, read: null, exit_status: 0, command: 'npm test' });
  await runStep('signal.emit', rg, dg as never, ctx);
  assert.deepEqual(sends, [{ kind: 'checks_run', seat: S, ok: true }]);   // no open CS → only checks_run
  sends.length = 0;
  (ctx as unknown as { engine: Engine }).engine = engineDouble({ openCs: 'S/1', paths: ['src/a.ts'] });
  await runStep('signal.emit', rg, dg as never, ctx);
  assert.deepEqual(sends, [
    { kind: 'checks_run', seat: S, ok: true },
    { kind: 'checkpoint', seat: S, source: 'green', candSeq: 1, paths: ['src/a.ts'] },   // the stub threw → no expect (late)
  ]);
  sends.length = 0;
  const { r: rf, d: df } = req('PostToolUse', { event: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'tu2', path: null, read: null, exit_status: 1, command: 'npm test' });
  await runStep('signal.emit', rf, df as never, ctx);
  assert.deepEqual(sends, [{ kind: 'checks_run', seat: S, ok: false }]);   // the failing run: checks_run{ok: false}, no checkpoint (plan 2812)
  sends.length = 0;
  const { r: rs, d: ds } = req('Stop', { event: 'Stop', stop_hook_active: false, background_tasks_running: 0, ids_in_last_message: null });
  await runStep('signal.emit', rs, ds as never, ctx);
  assert.deepEqual(sends, [{ kind: 'stop', seat: S }]);
  sends.length = 0;
  for (const [event, kind] of [['StopFailure', 'stop_failure'], ['SessionEnd', 'session_end']] as const) {
    const { r: rx, d: dx } = req(event, { event, reason: null } as HookPayload);
    await runStep('signal.emit', rx, dx as never, ctx);
    assert.deepEqual(sends, [{ kind, seat: S }]);
    sends.length = 0;
  }
  const { r: rsa, d: dsa } = req('SubagentStop', { event: 'SubagentStop', stop_hook_active: false, background_tasks_running: 0, ids_in_last_message: null });
  rsa.frame.h.agent_id = 'a1';
  await runStep('signal.emit', rsa, dsa as never, ctx);
  assert.deepEqual(sends, [{ kind: 'subagent_stop', seat: S, agent: 'a1' }]);
});

test('SessionStart compact and SubagentStart/Stop fire onContextReset; startup fires nothing (F05-09, A6-13)', async () => {
  const clock = new VirtualClock({ startMono: 0 });
  const ctx = { ports: { clock, fs: {} as Fs }, signals: { send: () => undefined }, engine: engineDouble(), reads: { take: async () => { throw new Error('Plan 5 Task 8'); } } } as unknown as DaemonCtx;
  const seen: Array<{ seatId: string; agentId: string | null; why: string }> = [];
  const off = onContextReset((r) => seen.push(r));
  for (const src of ['startup', 'compact', 'clear', 'resume', 'fork'] as const) {
    seen.length = 0;
    const { r, d } = req('SessionStart', { event: 'SessionStart', source: src, transcript_path: null, messaging_present: true, static_policy_hits: [] });
    await runStep('signal.emit', r, d as never, ctx);
    if (src === 'startup') assert.deepEqual(seen, []);
    else assert.deepEqual(seen, [{ seatId: S, agentId: null, why: src }]);
  }
  const { r: r1, d: d1 } = req('SubagentStart', { event: 'SubagentStart', agent_id: 'a1', agent_type: null, cwd: '/' });
  seen.length = 0;
  await runStep('signal.emit', r1, d1 as never, ctx);
  assert.deepEqual(seen, [{ seatId: S, agentId: 'a1', why: 'subagent_start' }]);
  const { r: r2, d: d2 } = req('SubagentStop', { event: 'SubagentStop', stop_hook_active: false, background_tasks_running: 0, ids_in_last_message: null });
  r2.frame.h.agent_id = 'a1';
  await runStep('signal.emit', r2, d2 as never, ctx);
  assert.deepEqual(seen.at(-1), { seatId: S, agentId: 'a1', why: 'subagent_stop' });
  off();
  seen.length = 0;
  const { r: r3, d: d3 } = req('SessionStart', { event: 'SessionStart', source: 'compact', transcript_path: null, messaging_present: true, static_policy_hits: [] });
  await runStep('signal.emit', r3, d3 as never, ctx);
  assert.deepEqual(seen, []);                                      // the unsubscribe stopped delivery
});

function idleCtx(clock: VirtualClock, row: { activity: 'IDLE' | 'MID_TURN'; lastHookMono: number | null }, txns: number, out: CsSignal[]): DaemonCtx {
  const seat: { seatId: string; turn: Record<string, unknown>; lastHookMono: number | null; activity: SeatActivity } =
    { seatId: S, turn: turnState(), lastHookMono: row.lastHookMono, activity: row.activity };
  return {
    ports: { clock }, seats: { seats: () => [{ seat_id: S, number: 1, activity: row.activity, wiring: 'FULL', flags: [], lastHookMono: seat.lastHookMono }], bySeatId: () => seat as never },
    leases: { openFor: () => ({ inflight: 0, txns }) }, signals: { send: (s: CsSignal) => out.push(s) },
  } as unknown as DaemonCtx;
}

test('idle_10min after 10 min without a hook carries activity and txnOpen, once per gap (A6-10, HLD-34)', async () => {
  const clock = new VirtualClock({ startMono: 0 });
  const out: CsSignal[] = [];
  const ctx = idleCtx(clock, { activity: 'MID_TURN', lastHookMono: 0 }, 1, out);
  clock.advance(599_999);
  await runTickerId('idle', ctx);
  assert.deepEqual(out, []);
  clock.advance(1);
  await runTickerId('idle', ctx);
  assert.deepEqual(out, [{ kind: 'idle_10min', seat: S, activity: 'MID_TURN', txnOpen: true }]);
  clock.advance(300_000);
  await runTickerId('idle', ctx);
  assert.equal(out.length, 1);                                     // once per silence
  const seat = (ctx as unknown as { seats: { bySeatId: () => { lastHookMono: number | null } } }).seats.bySeatId();
  seat.lastHookMono = clock.monoMs();                              // a hook arrives
  await runTickerId('idle', ctx);                                  // its tick re-arms the timer (nothing sent)
  assert.equal(out.length, 1);
  clock.advance(600_000);
  await runTickerId('idle', ctx);
  assert.equal(out.length, 2);
  assert.deepEqual(out[1], { kind: 'idle_10min', seat: S, activity: 'MID_TURN', txnOpen: true });
  const out2: CsSignal[] = [];
  const clock2 = new VirtualClock({ startMono: 0 });
  const ctx2 = idleCtx(clock2, { activity: 'IDLE', lastHookMono: 0 }, 0, out2);
  clock2.advance(600_000);
  await runTickerId('idle', ctx2);
  assert.deepEqual(out2, [{ kind: 'idle_10min', seat: S, activity: 'IDLE', txnOpen: false }]);
});

async function runTickerId(id: 'idle', ctx: DaemonCtx): Promise<void> {
  const { runTicker } = await import('../../src/claude/daemon/pipeline.js');
  await runTicker(id, ctx);
}

test('the idle ticker keeps one IdleTimer per daemon ctx (one per ctx in a WeakMap, reused by the same ctx; F2 #63)', async () => {
  const { runTicker } = await import('../../src/claude/daemon/pipeline.js');
  const clock = new VirtualClock({ startMono: 0 });
  const out: CsSignal[] = [];
  const ctx = idleCtx(clock, { activity: 'IDLE', lastHookMono: 0 }, 0, out);
  clock.advance(600_000);
  await runTicker('idle', ctx);
  assert.equal(out.length, 1);
  await runTicker('idle', ctx);
  assert.equal(out.length, 1);                                     // the same ctx reuses the timer
  void neverPending; void new TraceRecorder();
});

// ---- F2 wave (t6-signals) ----------------------------------------------------------------------------------------------

const flush = (): Promise<void> => new Promise<void>((r) => { setImmediate(r); });
const realDelay = (ms: number): Promise<void> => new Promise<void>((r) => { setTimeout(r, ms).unref(); });

test("SignalPump.send's promise resolves once the signal is in Engine.signal's queue, without waiting for that queue; it never rejects and logs a rejection once (A6-4 as amended by R-F2-5 and C-8, A6-9)", async () => {
  const logs: LogRow[] = [];
  const calls: CsSignal[] = [];
  let release: (() => void) | null = null;
  const held = { signal: (s: CsSignal) => { calls.push(s); return new Promise<void>((r) => { release = r; }); } } as unknown as Engine;
  const pump = new SignalPump(held, logOf(logs));
  const p = pump.send({ kind: 'stop', seat: S }) as unknown;
  assert.ok(p instanceof Promise, 'send returns a promise');
  assert.deepEqual(calls.map((c) => c.kind), ['stop']);            // Engine.signal called (queued) before send returned
  let settled = false;
  void p.then(() => { settled = true; });
  await flush();
  await flush();
  assert.equal(settled, true);                                     // C-8: no wait on the engine's exclusive queue
  assert.ok(release !== null);
  (release as () => void)();
  await flush();
  assert.equal(logs.length, 0);
  // A rejection (now or later) logs exactly one CS_SIGNAL_REJECTED line and the promise still resolves.
  const rej = new SignalPump({ signal: () => Promise.reject(new Error('engine down')) } as unknown as Engine, logOf(logs));
  const pr = rej.send({ kind: 'stop', seat: S }) as unknown;
  assert.ok(pr instanceof Promise);
  await pr;
  await flush();
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.code, 'CS_SIGNAL_REJECTED');
  assert.deepEqual(logs[0]!.params, { kind: 'stop', error: 'Error' });   // C-15 (SEC-38): the errno code or the name, never the message — the landed form the merge carried
  // A synchronous throw: the same line, and a resolved promise.
  const logs2: LogRow[] = [];
  const thr = new SignalPump({ signal: () => { throw new Error('sync throw'); } } as unknown as Engine, logOf(logs2));
  const pt = thr.send({ kind: 'prompt', seat: S, humanOrigin: true, nonce: false }) as unknown;
  assert.ok(pt instanceof Promise);
  await pt;
  assert.equal(logs2.length, 1);
  assert.deepEqual(logs2[0]!.params, { kind: 'prompt', error: 'Error' });   // C-15: the name, never the message (the landed form)
});

test('two daemon ctxs ticking alternately each send idle_10min once per silence (F2 #63)', async () => {
  const { runTicker } = await import('../../src/claude/daemon/pipeline.js');
  const clock = new VirtualClock({ startMono: 0 });
  const outA: CsSignal[] = [];
  const outB: CsSignal[] = [];
  const a = idleCtx(clock, { activity: 'IDLE', lastHookMono: 0 }, 0, outA);
  const b = idleCtx(clock, { activity: 'IDLE', lastHookMono: 0 }, 0, outB);
  clock.advance(600_000);
  for (let i = 0; i < 10; i++) {
    await runTicker('idle', a);
    await runTicker('idle', b);
  }
  assert.equal(outA.length, 1);
  assert.equal(outB.length, 1);
});

// captureIdentity's ctx doubles: a fixed absolute repo root (nothing is read from it — the fs doubles answer), a
// GatedClock (its sleep waits for advance, so the budget timer fires only when the test moves time), reads doubles.
const ROOT = resolve('/t6-capture-root');
const absOf = (p: string): string => join(ROOT, ...p.split('/'));
const statOf = (n: number): FsLstat => ({ size: 3, mtimeNs: BigInt(n), ino: 1n, dev: 1n, mode: 0o100644, isFile: true, isDirectory: false, isSymbolicLink: false });
const oidOf = (n: number): never => n.toString(16).padStart(40, '0') as never;
interface CaptureRig { ctx: DaemonCtx; clock: GatedClock; lstats: string[]; reads: string[]; takes: Array<{ path: string; snap: object }>; releases: object[]; other: string[]; sends: CsSignal[] }
function captureRig(o: { lstat?: (abs: string) => FsLstat | null; readFile?: (abs: string) => Promise<Buffer>; take?: (p: string) => Promise<object>; engine?: object }): CaptureRig {
  const clock = new GatedClock({ startMono: 0 });
  const rig: CaptureRig = { ctx: null as never, clock, lstats: [], reads: [], takes: [], releases: [], other: [], sends: [] };
  const fs = {
    lstat: async (p: string) => { rig.lstats.push(p); return o.lstat === undefined ? statOf(1) : o.lstat(p); },
    readFile: (p: string) => { rig.reads.push(p); return o.readFile === undefined ? Promise.resolve(Buffer.from('abc')) : o.readFile(p); },
  } as unknown as Fs;
  let n = 0;
  const readsImpl: Record<string, unknown> = {
    take: async (p: string) => {
      const snap = o.take === undefined ? { path: p, oid: oidOf(++n), bytes: null, spill: null, size: 3 } : await o.take(p);
      rig.takes.push({ path: p, snap });
      return snap;
    },
    release: async (snap: object) => { rig.releases.push(snap); },
  };
  const reads = new Proxy(readsImpl, { get: (t, k) => { if (k !== 'take' && k !== 'release' && typeof k === 'string') rig.other.push(k); return t[k as string]; } });
  rig.ctx = { repo: { root: ROOT }, ports: { clock, fs }, reads, engine: o.engine, signals: { send: (s: CsSignal) => { rig.sends.push(s); } } } as unknown as DaemonCtx;
  return rig;
}

test('captureIdentity gives up at the budget while a read is still running; the late read still fills the memo and releases its snapshot (F2 #64)', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown): void => { unhandled.push(e); };
  process.on('unhandledRejection', onUnhandled);
  try {
    let finish: ((b: Buffer) => void) | null = null;
    let held = true;
    const rig = captureRig({ readFile: () => (held ? new Promise<Buffer>((r) => { finish = r; }) : Promise.resolve(Buffer.from('abc'))) });
    const p = captureIdentity(S, ['src/big.bin'], new Map(), rig.ctx, 150);
    await flush();
    rig.clock.advance(150);
    assert.equal(await Promise.race([p, realDelay(100).then(() => 'pending' as const)]), null);   // over budget → late (SE5-03)
    held = false;
    assert.ok(finish !== null);
    (finish as (b: Buffer) => void)(Buffer.from('abc'));
    await flush();
    await flush();
    assert.equal(rig.takes.length, 1);
    assert.deepEqual(rig.releases, [rig.takes[0]!.snap]);
    const readsBefore = rig.reads.length;
    const again = await captureIdentity(S, ['src/big.bin'], new Map(), rig.ctx, 150);   // same lstat stat → the memo's oid
    assert.equal(rig.reads.length, readsBefore);
    assert.deepEqual(again, { 'src/big.bin': (rig.takes[0]!.snap as { oid: string }).oid });
    await flush();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test("signal.emit's Stop reply is not held past the capture bound by a slow read (F2 #64, CCI-36)", async () => {
  const engine = { openCsOf: () => 'S/1', csPaths: () => ['src/big.bin'], checkpointCommands: () => [] };
  const rig = captureRig({ readFile: () => new Promise<Buffer>(() => {}), engine });
  const { r, d } = req('Stop', { event: 'Stop', stop_hook_active: false, background_tasks_running: 0, ids_in_last_message: null });
  const step = runStep('signal.emit', r, d as never, rig.ctx);
  await flush();
  rig.clock.advance(150);
  assert.equal(await Promise.race([step.then(() => 'replied' as const), realDelay(100).then(() => 'held' as const)]), 'replied');
  assert.deepEqual(rig.sends, [{ kind: 'stop', seat: S }]);       // no expect: taken late by Plan 3
});

test('every snapshot captureIdentity takes is released once its oid is read (F2 #64)', async () => {
  const rig = captureRig({});
  const out = await captureIdentity(S, ['src/a.ts', 'src/b.ts', 'src/c.ts'], new Map(), rig.ctx, 150);
  assert.ok(out !== null);
  await flush();
  assert.equal(rig.takes.length, 3);
  assert.deepEqual(rig.releases, rig.takes.map((t) => t.snap));    // the same objects, once each
  assert.deepEqual(rig.other, []);                                 // route (b): no other DiskSnapshots member (plan 2815)
  assert.deepEqual(rig.takes.map((t) => t.path), ['src/a.ts', 'src/b.ts', 'src/c.ts']);   // DiskSnapshots keys stay repo-relative
});

test('a CS path that is not a stageable repository path is never read and yields no identity (F2 #81)', async () => {
  for (const bad of ['../outside.txt', 'C:/abs.txt', '/abs.txt', '.git/config', 'GIT~1/config']) {
    const rig = captureRig({});
    assert.equal(await captureIdentity(S, ['src/ok.ts', bad], new Map(), rig.ctx, 150), null, bad);
    assert.deepEqual(rig.lstats, [], bad);
    assert.deepEqual(rig.reads, [], bad);
  }
});

test('closing signals carry expect computed within 150 ms, else none (late) (R5-20, A6-5)', async () => {
  // A 50-path CS: 47 memo hits, 2 changed stats, 1 deleted path → 50 entries with 2 reads, inside the bound.
  {
    const paths = Array.from({ length: 50 }, (_, i) => `memo/f${i}.ts`);
    const stat = new Map(paths.map((p) => [absOf(p), statOf(1)] as [string, FsLstat | null]));
    let rig: CaptureRig;
    rig = captureRig({ lstat: (abs) => stat.get(abs) ?? null, readFile: () => { rig.clock.advance(3); return Promise.resolve(Buffer.from('abc')); } });
    const first = await captureIdentity(S, paths, new Map(), rig.ctx, 10_000);
    assert.ok(first !== null);
    assert.equal(rig.reads.length, 50);
    stat.set(absOf('memo/f3.ts'), statOf(2));
    stat.set(absOf('memo/f7.ts'), statOf(2));
    stat.set(absOf('memo/f9.ts'), null);                           // deleted
    const readsBefore = rig.reads.length;
    const second = await captureIdentity(S, paths, new Map(), rig.ctx, 150);
    assert.ok(second !== null);
    assert.equal(Object.keys(second).length, 50);
    assert.equal(second['memo/f9.ts'], 'ABSENT');
    assert.equal(rig.reads.length - readsBefore, 2);                // the two changed paths only
    assert.equal(second['memo/f0.ts'], first['memo/f0.ts']);        // a memo hit keeps its oid
  }
  // 50 stat-dirty paths at 5 ms per read (250 ms) → null.
  {
    const paths = Array.from({ length: 50 }, (_, i) => `slow/f${i}.ts`);
    let rig: CaptureRig;
    rig = captureRig({ readFile: () => { rig.clock.advance(5); return Promise.resolve(Buffer.from('abc')); } });
    assert.equal(await captureIdentity(S, paths, new Map(), rig.ctx, 150), null);
  }
  // An unstable read (the stat moves under every read) → null.
  {
    let m = 0;
    const rig = captureRig({ lstat: () => statOf(++m) });
    assert.equal(await captureIdentity(S, ['unstable/a.ts'], new Map(), rig.ctx, 150), null);
  }
  // A take that throws → null, and no exception escapes.
  {
    const rig = captureRig({ take: () => Promise.reject(new Error('take failed')) });
    assert.equal(await captureIdentity(S, ['throw/a.ts'], new Map(), rig.ctx, 150), null);
  }
  // Known post-images are used with no read.
  {
    const rig = captureRig({});
    const known = new Map([['known/a.ts', { path: 'known/a.ts', oid: oidOf(7), bytes: Buffer.from('abc'), spill: null, size: 3 }]]);
    assert.deepEqual(await captureIdentity(S, ['known/a.ts'], known, rig.ctx, 150), { 'known/a.ts': oidOf(7) });
    assert.deepEqual(rig.lstats, []);
    assert.deepEqual(rig.reads, []);
  }
});

test('per-CS counters and the identity memo are bounded (F2 #72)', async () => {
  const pump = new SignalPump(engineDouble(), logOf([]));
  for (let i = 0; i < 1_000; i++) {
    const seat = i.toString(16).padStart(32, '0');
    pump.nextCandSeq(`${seat}/1`);
    void pump.send({ kind: 'seat_end', seat });
  }
  const last = (pump as unknown as { sizesForTest(): { last: number } }).sizesForTest().last;
  assert.ok(last <= 1, `cand_seq entries ${last}`);
  let i = 0;
  const engine = { openCsOf: () => 'S/1', csPaths: () => [`bounded/f${i}.ts`], checkpointCommands: () => [] };
  const rig = captureRig({ engine });
  for (i = 0; i < 1_000; i++) {
    const { r, d } = req('Stop', { event: 'Stop', stop_hook_active: false, background_tasks_running: 0, ids_in_last_message: null });
    await runStep('signal.emit', r, d as never, rig.ctx);
  }
  assert.equal(rig.sends.length, 1_000);
  assert.ok(rig.sends.every((s) => s.kind === 'stop' && 'expect' in s));   // each close carried its identity
  const size = identityMemoSizeForTest(rig.ctx);
  assert.ok(size <= 1, `memo entries ${size}`);
});

test("cand_seq totally orders one CS's green, edit and tool captures and is independent per CS (R1-123)", async () => {
  const T = 't'.repeat(32);
  const got: CsSignal[] = [];
  const table = [{ cs_id: 'S/1', cap_seq: 0 }, { cs_id: 'T/1', cap_seq: 0 }];
  const engine = {
    signal: (s: CsSignal) => { got.push(s); return Promise.resolve(); },
    core: { cs: { table: () => ({ cs: table }) } },
    openCsOf: (seatId: string) => (seatId === S ? 'S/1' : seatId === T ? 'T/1' : null),
    csPaths: () => ['src/a.ts'],
    checkpointCommands: () => ['npm test'],
  } as unknown as Engine;
  const pump = new SignalPump(engine, logOf([]));
  const rig = captureRig({ lstat: () => null, engine });           // every path ABSENT: an identity with no read
  (rig.ctx as unknown as { signals: SignalPump }).signals = pump;
  const green = async (seatId: string): Promise<void> => {
    const { r, d } = req('PostToolUse', { event: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'tu1', path: null, read: null, exit_status: 0, command: 'npm test' });
    (r as unknown as { seat: { seatId: string } }).seat.seatId = seatId;
    await runStep('signal.emit', r, d as never, rig.ctx);
  };
  await green(S);                                                   // green checkpoint of S → 1
  void pump.send({ kind: 'checkpoint', seat: S, source: 'edit', candSeq: pump.nextCandSeq('S/1'), paths: ['src/a.ts'] });   // a Task 13 double → 2
  await green(T);                                                   // green checkpoint of T → 1 for T/1
  void pump.send({ kind: 'checkpoint', seat: S, source: 'tool', candSeq: pump.nextCandSeq('S/1'), paths: ['src/a.ts'] });   // a Task 14 double → 3
  const ofS = got.filter((s): s is Extract<CsSignal, { kind: 'checkpoint' }> => s.kind === 'checkpoint' && s.seat === S);
  assert.deepEqual(ofS.map((s) => [s.source, s.candSeq]), [['green', 1], ['edit', 2], ['tool', 3]]);   // send order, no repeat, no decrease
  const ofT = got.filter((s): s is Extract<CsSignal, { kind: 'checkpoint' }> => s.kind === 'checkpoint' && s.seat === T);
  assert.deepEqual(ofT.map((s) => s.candSeq), [1]);
  table[0]!.cap_seq = 3;                                            // Plan 3 recorded S/1's three captures and T/1's one
  table[1]!.cap_seq = 1;
  const fresh = new SignalPump(engine, logOf([]));
  assert.equal(fresh.nextCandSeq('S/1'), 4);
  assert.equal(fresh.nextCandSeq('T/1'), 2);
});
