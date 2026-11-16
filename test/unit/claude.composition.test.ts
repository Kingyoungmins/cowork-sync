// Plan 5 Task 5 phase 3a-1 — the composition root (06 §3.17; A5-5, A5-7, A5-11, A5-12, A5-14; plan 2710, 2725, 2762-2763).
// Cells that need no listening server and no harness: ctxOverrides replace exactly the named members; every pre-wired or
// hot-path stub member answers its R5-55 neutral through the real ctx; the HOOK_ONLY notice reaches an events double
// through the composition's notice delegate; attach runs convertLeftovers before attachEngine (real engines,
// makeEngines) and is re-callable (C-ATTACH: a second Engine on the same clone takes over every binding); the VersionPolicy
// defaults (A5-14); close('version') ends in ClaudeDaemonDeps.requestStop (C-STOP); the hook-read git port follows the
// attached core (C-GIT, DAT-13); plan5Bindings' twelve members, the X-111 spread and the composition slots; the ticker
// loop's TICK_ORDER cadence and its error isolation (R-F2-14); the pre-attach CS-signal queue; the source scan of
// src/daemon/run.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VirtualClock } from '../sim/vclock.js';
import { TraceRecorder } from '../sim/traceRecorder.js';
import * as composition from '../../src/claude/daemon/claudeDaemon.js';
import {
  createClaudeDaemon, plan5Bindings, noCoordHooks, noRegions, plan5WakeScope, neverRing, codeOnlyDigest, noDueRequests, noFlowEntries,
  noWrap, unavailableScan, canaryScan, type ClaudeBindings, type ClaudeDaemon, type ClaudeDaemonDeps, type RegionsPort,
} from '../../src/claude/daemon/claudeDaemon.js';
import { ClaudeServer } from '../../src/claude/daemon/server.js';
import { EventStore } from '../../src/claude/daemon/events.js';
import { LeaseTable } from '../../src/claude/daemon/leases.js';
import { TurnOrigin } from '../../src/claude/daemon/turns.js';
import { ReadSets } from '../../src/claude/daemon/post.js';
import { registerTicker } from '../../src/claude/daemon/pipeline.js';
import { Engine } from '../../src/engine/loop.js';
import type { EngineCore } from '../../src/engine/core.js';
import type { StatusJson } from '../../src/engine/status.js';
import { GitRepo } from '../../src/git/repo.js';
import { hashRouteBStdin } from '../../src/data/blobRoutes.js';
import { PLUGIN_VERSION } from '../../src/version.js';
import { HOOK_PROTO, type McpHelloFrame } from '../../src/claude/wire/frames.js';
import { C } from '../../src/claude/wire/constants.js';
import { nullLog, type Log } from '../../src/ports/log.js';
import { realFs } from '../../src/ports/fs.js';
import { seededRandom, randomHex } from '../../src/ports/random.js';
import type { Ipc } from '../../src/ports/ipc.js';
import type { Scheduler, Task } from '../../src/ports/scheduler.js';
import type { CsSignal } from '../../src/holds/signals.js';
import type { DaemonCtx } from '../../src/claude/daemon/ctx.js';
import type { SecurityLog } from '../../src/sec/securityLog.js';
import type { Params } from '../../src/claude/daemon/claudeDaemon.js';
import { loaderRepo } from '../helpers/loaderRun.js';
import { setupLiveRepo } from '../helpers/liveRepo.js';
import { makeEngines } from '../helpers/engineFixture.js';
import { gitCallsOf } from '../helpers/coreFixture.js';
import { spyRunner, type GitCall } from '../helpers/snapFixture.js';
import { testRunner } from '../helpers/tmp.js';
import { LogRecorder } from '../helpers/publishHelpers.js';

const K1 = 'a'.repeat(64);
const S = '5ea70000000000000000000000000001';
const N1 = 'cws-0123456789abcdef';

const neverTools = (): ClaudeBindings['coordTools'] => ({
  request: async () => ({ ok: true, text: '' }), respond: async () => ({ ok: true, text: '' }), note: async () => ({ ok: true, text: '' }),
  release: async () => ({ ok: true, text: '' }), show: async () => ({ ok: true, text: '' }), status: async () => ({ ok: true, text: '' }),
});

/** The twelve ClaudeBindings members (plan:1299-1301), sorted. */
const BINDING_KEYS = ['coordHooks', 'coordTools', 'digest', 'dueRequests', 'flow', 'noteScan', 'regions', 'revertView', 'slotExtra', 'wakePolicy', 'wakeScope', 'wrap'];

const helloOf = (seatId: string, key = K1): McpHelloFrame =>
  ({ t: 'hello', seat_id: seatId, seat_key: key, claude_pid: 4242, cc_version: '2.1.0', plugin_version: PLUGIN_VERSION, hook_proto: HOOK_PROTO, messaging_present: true });

interface Made {
  daemon: ClaudeDaemon; ctx: DaemonCtx; clock: VirtualClock; trace: TraceRecorder;
  repo: Awaited<ReturnType<typeof setupLiveRepo>>;
  queueCalls: Array<{ target: 'all' | string; code: string; params: Params }>;
  cleanup: () => Promise<void>;
}

/** A listener double: the server binds nothing; `onClose` observes the listener's close. */
const fakeIpc = (onClose?: () => void): Ipc => ({
  listen: async () => ({ close: async () => { onClose?.(); } }),
}) as unknown as Ipc;

/** A daemon over a real temp repo with a key; no engine attached, server never listened. */
async function makeDaemon(o?: {
  overrides?: ClaudeDaemonDeps['ctxOverrides']; pidAlive?: (pid: number) => boolean; log?: Log; scheduler?: Scheduler;
  git?: (repo: Made['repo']) => GitRepo; requestStop?: () => void; bindings?: ClaudeBindings; ipc?: Ipc;
}): Promise<Made> {
  const clock = new VirtualClock({ startMono: 1_000_000 });
  const lr = await loaderRepo({ label: 'comp-root' });
  const repo = await setupLiveRepo(lr.dir);
  const queueCalls: Made['queueCalls'] = [];
  const security: SecurityLog = { event: () => undefined, flush: async () => undefined };
  const trace = new TraceRecorder();
  const d: ClaudeDaemonDeps = {
    repo, key: Buffer.alloc(32, 7), endpoint: `\\\\.\\pipe\\comp-test-${Math.random().toString(16).slice(2)}`,
    pluginVersion: PLUGIN_VERSION, hookProto: HOOK_PROTO,
    ports: {
      clock, random: seededRandom('comp-seed'), fs: realFs, scheduler: o?.scheduler ?? { schedule: () => undefined, yieldPoint: async () => undefined },
      git: o?.git?.(repo) ?? ({} as never), ipc: o?.ipc ?? ({} as never), notifier: { raise: () => undefined },
    },
    log: o?.log ?? nullLog, security, trace,
    bindings: o?.bindings ?? { ...plan5Bindings({ testBuild: true }), coordTools: neverTools(), revertView: { view: async () => { throw new Error('unused'); } } },
    osLocale: 'en-US', pidAlive: o?.pidAlive ?? (() => false), ctxOverrides: o?.overrides, requestStop: o?.requestStop,
  };
  const daemon = createClaudeDaemon(d);
  const events = daemon.ctx.events as EventStore & Record<string, unknown>;
  const original = events.queueSeatContext.bind(events);
  events.queueSeatContext = (target: 'all' | string, code: string, params: Params): string[] => {
    queueCalls.push({ target, code, params });
    return original(target, code, params);
  };
  return { daemon, ctx: daemon.ctx, clock, trace, repo, queueCalls, cleanup: lr.cleanup };
}

/** A test scheduler that fires every due task without awaiting it, as realScheduler does; a rejection lands in
 *  `rejections` (the place realScheduler leaves unhandled). `schedules` counts schedule calls. */
class FireScheduler implements Scheduler {
  private queue: Array<{ task: Task; at: number }> = [];
  readonly rejections: unknown[] = [];
  schedules = 0;
  schedule(task: Task, atMono: number): void {
    this.schedules += 1;
    this.queue.push({ task, at: atMono });
  }
  yieldPoint(): Promise<void> { return new Promise<void>((r) => { setImmediate(r); }); }
  /** Advances the clock in 100 ms steps up to toMono; at each step fires every due task, then yields a few times. */
  async runUntil(clock: VirtualClock, toMono: number): Promise<void> {
    while (clock.monoMs() < toMono) {
      clock.advance(100);
      const now = clock.monoMs();
      const due = this.queue.filter((q) => q.at <= now);
      this.queue = this.queue.filter((q) => q.at > now);
      for (const q of due) void Promise.resolve().then(q.task).catch((e: unknown) => { this.rejections.push(e); });
      for (let i = 0; i < 8; i++) await new Promise<void>((r) => { setImmediate(r); });
    }
  }
}

// The test ticker under 'health' (no module registers it before Task 9): 'off' is a no-op, so the cells that never run
// the ticker loop are unaffected.
const tick = { mode: 'off' as 'off' | 'slow' | 'throw' | 'throwAlways', threw: false, inFlight: 0, maxInFlight: 0, runs: 0, log: [] as Array<{ id: string; mono: number }> };
function resetTick(mode: 'off' | 'slow' | 'throw' | 'throwAlways'): void {
  Object.assign(tick, { mode, threw: false, inFlight: 0, maxInFlight: 0, runs: 0, log: [] });
}
registerTicker('health', async (c: DaemonCtx): Promise<void> => {
  tick.log.push({ id: 'health', mono: c.ports.clock.monoMs() });
  tick.runs += 1;
  if (tick.mode === 'throw' && !tick.threw) { tick.threw = true; throw new Error('boom'); }
  if (tick.mode === 'throwAlways') throw new Error('boom');
  if (tick.mode === 'slow') {
    tick.inFlight += 1;
    tick.maxInFlight = Math.max(tick.maxInFlight, tick.inFlight);
    const start = c.ports.clock.monoMs();
    while (c.ports.clock.monoMs() < start + 1_500) await new Promise<void>((r) => { setImmediate(r); });
    tick.inFlight -= 1;
  }
});

/** Records the `seats` and `engineView` ticker calls (ctx.seats.tick, ctx.engine.observe) into tick.log. */
function recordTicks(ctx: DaemonCtx): void {
  const seats = ctx.seats as unknown as { tick: () => Promise<void> };
  const seatsTick = seats.tick.bind(seats);
  seats.tick = () => { tick.log.push({ id: 'seats', mono: ctx.ports.clock.monoMs() }); return seatsTick(); };
  const view = ctx.engine as unknown as { observe: (n: number) => void };
  const observe = view.observe.bind(view);
  view.observe = (n: number) => { tick.log.push({ id: 'engineView', mono: ctx.ports.clock.monoMs() }); observe(n); };
}

/** tick.log split into runs (each run starts at a `seats` call). */
const runsOf = (log: ReadonlyArray<{ id: string; mono: number }>): string[][] => {
  const runs: string[][] = [];
  for (const e of log) {
    if (e.id === 'seats') runs.push([]);
    runs.at(-1)?.push(e.id);
  }
  return runs;
};

/** Counts the subscriptions core.onHoldCode / engine.onStatus hand out and the unsubscribes called on them. */
function spySubs(core: EngineCore, engine: Engine): { live: () => { hold: number; status: number }; holdOff: () => number; statusOff: () => number } {
  const st = { hold: 0, holdOff: 0, status: 0, statusOff: 0 };
  const onHoldCode = core.onHoldCode.bind(core);
  (core as { onHoldCode: EngineCore['onHoldCode'] }).onHoldCode = (cb) => {
    st.hold += 1;
    const off = onHoldCode(cb);
    return () => { st.holdOff += 1; off(); };
  };
  const onStatus = engine.onStatus.bind(engine);
  (engine as unknown as { onStatus: Engine['onStatus'] }).onStatus = (cb) => {
    st.status += 1;
    const off = onStatus(cb);
    return () => { st.statusOff += 1; off(); };
  };
  return { live: () => ({ hold: st.hold - st.holdOff, status: st.status - st.statusOff }), holdOff: () => st.holdOff, statusOff: () => st.statusOff };
}

/** Records every Engine.signal call on this instance (the original still runs). */
function recordSignals(engine: Engine): CsSignal[] {
  const seen: CsSignal[] = [];
  const original = engine.signal.bind(engine);
  (engine as unknown as { signal: Engine['signal'] }).signal = (s: CsSignal) => { seen.push(s); return original(s); };
  return seen;
}

async function waitFor(cond: () => boolean, tries = 2_000): Promise<void> {
  for (let i = 0; i < tries && !cond(); i++) await new Promise<void>((r) => { setImmediate(r); });
}

test('A5-12 ctxOverrides: the named members are the doubles, the others the daemon built', async () => {
  const E = new EventStore(new VirtualClock({ startMono: 0 }), seededRandom('e'), new TraceRecorder());
  const R = new ReadSets();
  const { ctx, cleanup } = await makeDaemon({ overrides: { events: E, readSets: R } });
  assert.equal(ctx.events, E);
  assert.equal(ctx.readSets, R);
  assert.ok(ctx.leases instanceof LeaseTable);   // not named → the daemon's own instance
  assert.ok(ctx.turns instanceof TurnOrigin);
  await cleanup();
});

test('A5-5 hot-path and pre-wired stub members answer their neutrals through the real ctx', async () => {
  const { ctx, cleanup } = await makeDaemon();
  assert.equal(ctx.health.degradedPaths().size, 0);                    // an empty Map
  assert.equal(ctx.readSets.fullReadSet(S).size, 0);                   // an empty Set
  assert.equal(ctx.readSets.overlaps(S, 'src/a.ts', [1, 2]), false);
  assert.equal(ctx.readSets.lastApplyInto(S), null);
  assert.equal(ctx.views.get(S, 'src/a.ts'), null);
  assert.deepEqual(ctx.events.queueSeatContext('all', 'X_P5', {}), []);
  assert.deepEqual(ctx.events.nonceSeen(N1), []);
  assert.deepEqual(ctx.transitions.forSeat(S), []);
  assert.equal(await ctx.checkpoints.awaitCapture('cs-1', 1, 1_000), 'late');
  assert.equal(await ctx.shadows.convertLeftovers(), 0);
  assert.equal(ctx.events.printed('b-1'), undefined);
  assert.equal(ctx.events.nextHook(S), undefined);
  assert.equal(ctx.health.onHook(S), undefined);
  await ctx.health.tick();                                             // the async neutral resolves
  assert.equal(ctx.transitions.observe({ state: 'ok', freeze_reasons: [], publish_pause: null } as never, 1), undefined);
  assert.deepEqual(ctx.leases.openFor(S), { inflight: 0, txns: 0 });
  assert.deepEqual(ctx.leases.releaseSeat(S, {}, 'seat_end'), []);
  assert.equal(ctx.checkpoints.attachEngine(undefined as never), undefined);
  assert.ok(ctx.signals.send({ kind: 'activity', seat: S, activity: 'IDLE' }) instanceof Promise);   // I-1 (R-F2-5, F2 #32 #62): send answers the resolved promise, never undefined (PC 2's lost A5-5 pin fix, restored from wip/pc1/a2-t6-signals)
  assert.equal(ctx.ring.onResult(N1, 'sent'), undefined);
  assert.equal(ctx.turns.onOtherHook({} as never, null), undefined);
  assert.equal(ctx.turns.expire(), undefined);
  // ctx.engine is undefined until attach (decision 7-1); the engineView-dependent cells ride the attach test below.
  await cleanup();
});

test('A5-12: the composition wires SeatRegistry.notice through ctx.events.queueSeatContext (no server)', async () => {
  const { ctx, clock, queueCalls, cleanup } = await makeDaemon();
  const seat = ctx.seats.fromHook({ seat_key: K1, claude_pid: 4242, session_id: 's1' });
  clock.advance(C.MCP_PAIRING_MS);                                     // the pairing window elapses
  await ctx.seats.tick();                                              // the `seats` ticker mints the id
  const seatId = seat.seatId;
  assert.equal(seatId?.length, 32);
  const before = queueCalls.length;
  ctx.seats.setWiring(seat, 'HOOK_ONLY', 'mcp_lost');                  // a wiring change queues one health draft through the notice delegate
  assert.equal(queueCalls.length, before + 1);
  assert.equal(queueCalls.at(-1)!.target, seatId);
  assert.equal(queueCalls.at(-1)!.code, 'HOOK_ONLY');
  assert.deepEqual(queueCalls.at(-1)!.params, { cause: 'mcp_lost' });
  await cleanup();
});

test('attach calls convertLeftovers before attachEngine and binds the engine view (A5-12 order, spies, real engines)', async () => {
  const { daemon, ctx, cleanup } = await makeDaemon();
  const order: string[] = [];
  const shadows = ctx.shadows as unknown as { convertLeftovers: () => Promise<number> };
  const originalConvert = shadows.convertLeftovers.bind(shadows);
  shadows.convertLeftovers = async () => { order.push('convertLeftovers'); return originalConvert(); };
  const checkpoints = ctx.checkpoints as unknown as { attachEngine: (e: unknown) => void };
  const originalAttach = checkpoints.attachEngine.bind(checkpoints);
  checkpoints.attachEngine = (e: unknown) => { order.push('attachEngine'); originalAttach(e); };
  const fx = await makeEngines('comp-attach', { n: 1, engineDeps: () => daemon.engineDeps });
  const peer = fx.peers[0];
  await daemon.attach(peer.engine, peer.core);
  assert.ok(order.indexOf('convertLeftovers') < order.indexOf('attachEngine'), `attach order: ${order.join(',')}`);
  assert.equal(daemon.ctx.engine.peer(), peer.core.peerId);
  await fx.cleanup();
  await cleanup();
});

test('attach is re-callable: a second Engine on the same clone takes over every binding and the first engine\'s observers are unsubscribed (F2 #91 #77 #10)', async () => {
  const sched = new FireScheduler();
  const bindings: ClaudeBindings = { ...plan5Bindings({ testBuild: true }), coordTools: neverTools() };   // revertView: the composition slot (I-4)
  const { daemon, ctx, cleanup } = await makeDaemon({ scheduler: sched, bindings });
  const fx = await makeEngines('comp-reattach', { n: 1, engineDeps: () => daemon.engineDeps });
  try {
    const p = fx.peers[0]!;
    const e1 = p.engine;
    const c1 = e1.core;
    const subs1 = spySubs(c1, e1);
    await daemon.attach(e1, c1);
    const firstRevert = ctx.bindings.revertView;
    const schedulesAfterFirst = sched.schedules;
    const e2 = await Engine.create(p.deps);                            // the in-process respawn path (run.ts: Engine.create, start, attach)
    const c2 = e2.core;
    const subs2 = spySubs(c2, e2);
    const sig1 = recordSignals(e1);
    const sig2 = recordSignals(e2);
    await daemon.attach(e2, c2);
    // (a) the first engine's observers are unsubscribed; the second has one live subscription each.
    assert.equal(subs1.holdOff(), 1, 'c1.onHoldCode unsubscribed once');
    assert.equal(subs1.statusOff(), 1, 'e1.onStatus unsubscribed once');
    assert.deepEqual(subs2.live(), { hold: 1, status: 1 });
    // (c) the SignalPump reaches the second engine only.
    ctx.signals.send({ kind: 'activity', seat: S, activity: 'IDLE' });
    await waitFor(() => sig2.length > 0, 50);
    assert.equal(sig2.length, 1, 'the signal reaches e2 once');
    assert.equal(sig1.length, 0, 'the crashed engine receives no signal');
    // (d) a seat bound after the second attach queues its seat_start in c2's outbox.
    ctx.seats.fromHello(helloOf(S));
    const startsIn = (core: EngineCore): number => core.outbox.drafts().filter((x) => x.type === 'seat_start').length;
    assert.equal(startsIn(c2), 1);
    assert.equal(startsIn(c1), 0);
    // (e) the engine view answers from c2; the composition rebound its revertView slot.
    assert.equal(ctx.engine.peer(), c2.peerId);
    assert.notEqual(ctx.bindings.revertView, firstRevert, 'revertView rebound to plan3RevertView(c2)');
    assert.notEqual(ctx.bindings.revertView, (composition as Record<string, unknown>)['plan3RevertViewSlot']);
    // (f) a third attach with the same pair: still one subscription each, and no second ticker loop.
    await daemon.attach(e2, c2);
    assert.deepEqual(subs2.live(), { hold: 1, status: 1 });
    assert.equal(sched.schedules, schedulesAfterFirst, 'one ticker loop per daemon');
    // (b) the status observer: e1's writes reach nothing, e2's drain reaches Transitions once ('down').
    const observed: StatusJson[] = [];
    (ctx.transitions as unknown as { observe: (s: StatusJson, mono: number) => void }).observe = (s) => { observed.push(s); };
    await e1.drain(null);
    assert.equal(observed.length, 0, 'the first engine\'s status reaches no observer');
    await e2.drain(null);
    assert.equal(observed.length, 1);
    assert.equal(observed[0]!.state, 'down');
  } finally {
    await fx.cleanup();
    await cleanup();
  }
});

test('a CS signal sent before attach is queued and reaches the engine at attach, in order with later signals; nothing is logged (F2 #69)', async () => {
  const log = new LogRecorder();
  const { daemon, ctx, cleanup } = await makeDaemon({ log });
  const fx = await makeEngines('comp-presignal', { n: 1, engineDeps: () => daemon.engineDeps });
  try {
    const p = fx.peers[0]!;
    const seen = recordSignals(p.engine);
    const s1: CsSignal = { kind: 'activity', seat: S, activity: 'MID_TURN' };
    const s2: CsSignal = { kind: 'activity', seat: S, activity: 'IDLE' };
    ctx.signals.send(s1);
    await daemon.attach(p.engine, p.core);
    ctx.signals.send(s2);
    await waitFor(() => seen.length >= 2, 50);
    assert.deepEqual(seen, [s1, s2]);
    assert.deepEqual(log.lines.filter((l) => l.code === 'CS_SIGNAL_REJECTED'), []);
  } finally {
    await fx.cleanup();
    await cleanup();
  }
});

test('close(\'version\') drains the attached engine, closes the server, then calls requestStop exactly once; drain and removal never call it (F2 #90)', async () => {
  const order: string[] = [];
  let stops = 0;
  const { daemon, cleanup } = await makeDaemon({ requestStop: () => { stops += 1; order.push('requestStop'); }, ipc: fakeIpc(() => order.push('serverClose')) });
  const fx = await makeEngines('comp-version', { n: 1, engineDeps: () => daemon.engineDeps });
  try {
    const p = fx.peers[0]!;
    const drain = p.engine.drain.bind(p.engine);
    (p.engine as unknown as { drain: Engine['drain'] }).drain = (code) => { order.push('drain'); return drain(code); };
    await daemon.attach(p.engine, p.core);
    assert.equal(await daemon.listen(), 'serving');
    await daemon.close('version');
    assert.deepEqual(order, ['drain', 'serverClose', 'requestStop']);
    assert.equal(stops, 1);
    assert.equal(daemon.server, null, 'the server getter is null after close');
    await daemon.close('removal');
    assert.equal(stops, 1, 'removal never requests the stop');
    await daemon.close('version');
    assert.equal(stops, 1, 'once per daemon');
  } finally {
    await fx.cleanup();
    await cleanup();
  }
  let drainStops = 0;
  const b = await makeDaemon({ requestStop: () => { drainStops += 1; } });
  await b.daemon.close('drain');
  assert.equal(drainStops, 0, 'drain never requests the stop');
  await b.cleanup();
  let bareStops = 0;
  const c = await makeDaemon({ requestStop: () => { bareStops += 1; } });
  await c.daemon.close('version');                                     // never attached: the stop is still requested
  assert.equal(bareStops, 1);
  await c.cleanup();
});

test('a close(\'version\') that fails inside the server\'s version-drain trigger is logged as DAEMON_INTERNAL_ERROR, never left unhandled, and still requests the stop (R-F2-14, F2 #90)', async () => {
  const log = new LogRecorder();
  let stops = 0;
  let listenerClosed = false;
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown): void => { unhandled.push(e); };
  process.on('unhandledRejection', onUnhandled);
  const { daemon, cleanup } = await makeDaemon({ log, requestStop: () => { stops += 1; }, ipc: fakeIpc(() => { listenerClosed = true; }) });
  const fx = await makeEngines('comp-version-throw', { n: 1, engineDeps: () => daemon.engineDeps });
  try {
    const p = fx.peers[0]!;
    (p.engine as unknown as { drain: Engine['drain'] }).drain = async () => { throw new Error('drain boom'); };
    await daemon.attach(p.engine, p.core);
    assert.equal(await daemon.listen(), 'serving');
    const trigger = (daemon.server as unknown as { versionDrain: (() => void) | null }).versionDrain;
    assert.ok(trigger !== null, 'the composition bound the serve_then_drain trigger');
    trigger();
    await waitFor(() => stops === 1 && log.lines.some((l) => l.code === 'DAEMON_INTERNAL_ERROR'));
    await new Promise<void>((r) => { setTimeout(r, 20); });              // a rejection left unhandled would surface by now
    assert.deepEqual(unhandled, []);
    const errs = log.lines.filter((l) => l.code === 'DAEMON_INTERNAL_ERROR');
    assert.equal(errs.length, 1);
    assert.deepEqual(errs[0]!.params, { where: 'version_drain', error: 'Error' });
    assert.equal(stops, 1, 'the stop is requested although the drain threw');
    assert.equal(listenerClosed, true, 'the listener is closed although the drain threw');
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await fx.cleanup();
    await cleanup();
  }
});

test('after attach the hook-read port hashes under the attached core\'s attr tree and required filter drivers (DAT-13, F2 #50 #73)', async () => {
  const configCalls: GitCall[] = [];
  const configLike = (repo: Made['repo']): GitRepo => new GitRepo(spyRunner(testRunner(), configCalls),
    { workTree: repo.root, gitDir: repo.gitdir, coworkDir: repo.coworkDir },
    () => ({ attrTree: null, filterDrivers: [], identity: { name: 'cowork', email: 'daemon@cowork.invalid' }, wallMs: () => 0 }));   // run.ts's userRepo shape
  const { daemon, ctx, cleanup } = await makeDaemon({ git: configLike });
  const files: Record<string, Buffer> = {
    'README.md': Buffer.from('# core fixture\n', 'utf8'),
    'src/a.txt': Buffer.from('one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n', 'utf8'),
    'src/b.txt': Buffer.from('alpha\nbeta\ngamma\n', 'utf8'),
    '.gitattributes': Buffer.from('*.cnt filter=counting\n', 'utf8'),
  };
  const fx = await makeEngines('comp-gitport', { n: 1, files, engineDeps: () => daemon.engineDeps });
  try {
    const peer = fx.peers[0]!;
    assert.ok(peer.core.filters.drivers.includes('counting'), `drivers: ${peer.core.filters.drivers.join(',')}`);
    const bytes = Buffer.from('one\nTWO\n', 'utf8');
    const isHash = (c: GitCall): boolean => c.args.includes('hash-object') && c.args.includes('--path=src/a.txt');
    await hashRouteBStdin(peer.core.repo, bytes, 'src/a.txt', false);   // the reference: the engine's own port
    const ref = gitCallsOf(peer).filter(isHash).at(-1);
    assert.ok(ref !== undefined, 'the reference hash ran on the engine repo');
    assert.match(String(ref.opts.attrTree), /^[0-9a-f]{40}$/);
    const before = gitCallsOf(peer).length;
    const configBefore = configCalls.length;
    await daemon.attach(peer.engine, peer.core);
    const stat = await realFs.lstat(join(peer.clone.dir, 'src', 'a.txt'));
    assert.ok(stat !== null);
    const h = ctx.reads.hold('src/a.txt', { kind: 'ok', bytes, stat });
    await ctx.reads.settle(h);
    const settled = gitCallsOf(peer).slice(before).filter(isHash).at(-1);
    assert.ok(settled !== undefined, 'the settle\'s hash-object ran on the attached core\'s repo');
    assert.equal(settled.opts.attrTree, ref.opts.attrTree);
    assert.deepEqual(settled.opts.filterDrivers, ref.opts.filterDrivers);
    assert.ok((settled.opts.filterDrivers ?? []).includes('counting'));
    assert.equal(configCalls.slice(configBefore).filter((c) => c.args.includes('hash-object')).length, 0, 'no hash on the config-like repo');
    const n = gitCallsOf(peer).length;
    await ctx.ports.git.run(['rev-parse', 'HEAD']);
    assert.ok(gitCallsOf(peer).slice(n).some((c) => c.args.includes('rev-parse')), 'ctx.ports.git delegates to the attached core\'s repo');
  } finally {
    await fx.cleanup();
    await cleanup();
  }
});

test('plan5Bindings holds exactly the twelve ClaudeBindings members and noteScan is canaryScan in test builds (F2 #41 #39 #96)', () => {
  const prod = plan5Bindings({ testBuild: false });
  assert.deepEqual(Object.keys(prod).sort(), BINDING_KEYS);
  assert.equal(prod.regions, noRegions);
  assert.equal(prod.wakeScope, plan5WakeScope);
  assert.equal(prod.wakePolicy, neverRing);
  assert.equal(prod.coordHooks, noCoordHooks);
  assert.equal(prod.digest, codeOnlyDigest);
  assert.equal(prod.slotExtra, null);
  assert.equal(prod.dueRequests, noDueRequests);
  assert.equal(prod.flow, noFlowEntries);
  assert.equal(prod.wrap, noWrap);
  assert.equal(prod.noteScan, unavailableScan);
  const testBuild = plan5Bindings({ testBuild: true });
  assert.deepEqual(Object.keys(testBuild).sort(), BINDING_KEYS);
  assert.equal(testBuild.noteScan, canaryScan);
  for (const k of BINDING_KEYS) if (k !== 'noteScan') assert.equal((testBuild as unknown as Record<string, unknown>)[k], (prod as unknown as Record<string, unknown>)[k], k);
});

test('the X-111 spread replaces only the members a partial names; noCoordHooks answers null, [] and false and records nothing', async () => {
  for (const testBuild of [false, true]) {
    const o = { testBuild };
    const W = { ...neverRing };
    const D = { ...codeOnlyDigest };
    const spread = { ...plan5Bindings(o), ...{ wakePolicy: W, digest: D } } as unknown as Record<string, unknown>;
    assert.equal(spread['wakePolicy'], W);
    assert.equal(spread['digest'], D);
    const base = plan5Bindings(o) as unknown as Record<string, unknown>;
    for (const k of Object.keys(base)) if (k !== 'wakePolicy' && k !== 'digest') assert.equal(spread[k], base[k], k);
  }
  assert.equal(await noCoordHooks.onK1Deny({} as never), null);
  assert.deepEqual(await noCoordHooks.onK2({} as never), []);
  assert.equal(noCoordHooks.grantPaused(S, 'claim-1'), false);
  assert.equal(noCoordHooks.onUserPromptSubmit(S, { promptId: 'p', nonces: [], midTurn: false }), undefined);
  assert.equal(noCoordHooks.onLeaseLost(S), undefined);
  assert.equal(noCoordHooks.onRead({} as never), undefined);
  assert.ok(Object.isFrozen(noCoordHooks));
});

test('the composition binds its slots: coordTools to outboxCoord(ctx), revertView to plan3RevertView(core) at attach; a caller\'s own ports are kept', async () => {
  const slots = composition as Record<string, unknown>;
  assert.equal(typeof slots['outboxCoordSlot'], 'object', 'claudeDaemon.ts exports the coordTools slot');
  assert.equal(typeof slots['plan3RevertViewSlot'], 'object', 'claudeDaemon.ts exports the revertView slot');
  const own = plan5Bindings({ testBuild: true });
  assert.equal(own.coordTools, slots['outboxCoordSlot'], 'plan5Bindings carries the coordTools slot');
  assert.equal(own.revertView, slots['plan3RevertViewSlot'], 'plan5Bindings carries the revertView slot');
  const snapshot = { ...own };
  const a = await makeDaemon({ bindings: own });
  const fx = await makeEngines('comp-slots', { n: 1, engineDeps: () => a.daemon.engineDeps });
  try {
    assert.ok(a.ctx.bindings.coordTools !== undefined && a.ctx.bindings.coordTools !== slots['outboxCoordSlot'], 'coordTools bound at composition');
    await a.daemon.attach(fx.peers[0]!.engine, fx.peers[0]!.core);
    assert.ok(a.ctx.bindings.revertView !== undefined && a.ctx.bindings.revertView !== slots['plan3RevertViewSlot'], 'revertView bound at attach');
    assert.deepEqual(own, snapshot, 'the caller\'s bindings object is unchanged');
  } finally {
    await fx.cleanup();
    await a.cleanup();
  }
  const tools = neverTools();
  const view = { view: async (): Promise<never> => { throw new Error('double'); } };
  const b = await makeDaemon({ bindings: { ...plan5Bindings({ testBuild: true }), coordTools: tools, revertView: view } });
  assert.equal(b.ctx.bindings.coordTools, tools);
  assert.equal(b.ctx.bindings.revertView, view);
  await b.cleanup();
});

test('production src/daemon/run.ts passes no ctxOverrides (source scan, A5-12)', () => {
  const src = readFileSync(new URL('../../src/daemon/run.ts', import.meta.url), 'utf8');
  assert.ok(src.includes('createClaudeDaemon('), 'run.ts composes the daemon');
  assert.ok(!src.includes('ctxOverrides'));
});

test('EventStore.fire iterates a copy: a self-removing subscriber cannot skip its neighbour (t7b fix round 1, source scan)', () => {
  const src = readFileSync(new URL('../../src/claude/daemon/events.ts', import.meta.url), 'utf8');
  assert.ok(src.includes('for (const cb of [...this.subs]) cb(seatId, ids, how);'), 'fire() iterates a snapshot of the subscriber array');
  assert.ok(!src.includes('for (const cb of this.subs) cb(seatId, ids, how);'), 'no live-array iteration is left');
});

test('seats.onEnd drops the seat\u2019s digest seen set: dropDigestSeat beside ctx.items.endTurn (t7a fix round 1, source scan)', () => {
  const src = readFileSync(new URL('../../src/claude/daemon/claudeDaemon.ts', import.meta.url), 'utf8');
  const i = src.indexOf('ctxHolder.ctx?.items.endTurn(id);');
  assert.ok(i > 0, 'the onEnd block ends the seat\u2019s turn');
  assert.ok(src.includes('dropDigestSeat(ctxHolder.ctx!, id);'), 'the digest seen set dies with the seat');
  assert.ok(src.indexOf('dropDigestSeat(ctxHolder.ctx!, id);') < src.indexOf('meter.drop(id);', i), 'the meter drop follows in the same block');
});

test('a meter charge over 20,000 reaches SeatRegistry.setFlag(PULL_MODE) once: one SEAT_PULL_MODE health draft (A5-5)', async () => {
  const { daemon, ctx, cleanup } = await makeDaemon();
  const fx = await makeEngines('comp-meter', { n: 1, engineDeps: () => daemon.engineDeps });
  try {
    // A hello-bound (FULL) seat: a pairing-minted NO_MCP seat's display outranks PULL_MODE (glossary §3), so its
    // health draft would carry SEAT_NO_MCP.
    const seat = ctx.seats.fromHello(helloOf(S));
    const id = seat.seatId!;
    ctx.meter.touch(id);
    ctx.meter.charge(id, 'inject', 20_001);
    assert.ok(ctx.seats.seatWiring(id).flags.includes('PULL_MODE'));
    const peer = fx.peers[0]!;
    await daemon.attach(peer.engine, peer.core);                        // the buffered pre-attach drafts flush
    const pull = peer.core.outbox.drafts().filter((x) => x.type === 'event' && x.kind === 'health' && x.reason_code === 'SEAT_PULL_MODE');
    assert.equal(pull.length, 1);
  } finally {
    await fx.cleanup();
    await cleanup();
  }
});

test('after attach the seat registry carries the engine\'s peer id: the seat-end release names it (F2 #98)', async () => {
  const released: Array<{ peer: string; seat: string }> = [];
  const regions: RegionsPort = { ...noRegions, releaseClaims: (holder) => { released.push({ peer: holder.peer, seat: holder.seat }); return { drafts: [], refused: [] }; } };
  const { daemon, ctx, trace, cleanup } = await makeDaemon({ bindings: { ...plan5Bindings({ testBuild: true }), coordTools: neverTools(), regions } });
  const fx = await makeEngines('comp-peer', { n: 1, engineDeps: () => daemon.engineDeps });
  try {
    const core = fx.peers[0]!.core;
    await daemon.attach(fx.peers[0]!.engine, core);
    assert.equal(ctx.seats.peerId(), core.peerId);
    const seat = ctx.seats.fromHello(helloOf(S));
    await ctx.seats.end(seat, 'mcp_eof');
    assert.deepEqual(released, [{ peer: core.peerId, seat: S }]);
    assert.equal(trace.ofKind('seat').at(-1)!.peer, core.peerId);
  } finally {
    await fx.cleanup();
    await cleanup();
  }
});

test('a seat\'s end drops its TurnItems turn: seats.onEnd calls ctx.items.endTurn (C-3, F2 #57)', async () => {
  const { ctx, cleanup } = await makeDaemon();
  const seat = ctx.seats.fromHello(helloOf(S));
  ctx.items.record(S, null, 'denied', 'SH-1');
  ctx.items.markBlocked(S);
  await ctx.seats.end(seat, 'mcp_eof');
  assert.deepEqual(ctx.items.unacked(S), []);
  assert.equal(ctx.items.blockedThisTurn(S), false);
  await cleanup();
});

test('a seat\'s end drops its BudgetMeter window: the meter keeps no window for an ended seat (F2 #57 meter half)', async () => {
  const { ctx, cleanup } = await makeDaemon();
  const ids = seededRandom('meter-drop');
  for (let i = 0; i < 50; i++) {
    const id = randomHex(ids, 16);
    const seat = ctx.seats.fromHello(helloOf(id, `MK${i}`));
    ctx.meter.touch(id);
    ctx.meter.charge(id, 'inject', 100);
    await ctx.seats.end(seat, 'mcp_eof');
  }
  assert.equal(ctx.meter.sizeForTest(), 0, 'no window survives its seat');
  const seat = ctx.seats.fromHello(helloOf(S));
  ctx.meter.touch(S);
  ctx.meter.charge(S, 'inject', 20_001);
  assert.equal(ctx.meter.inPullMode(S), true);
  assert.equal(ctx.meter.sizeForTest(), 1);
  await ctx.seats.end(seat, 'mcp_eof');
  assert.equal(ctx.meter.sizeForTest(), 0);
  await cleanup();
});

test('tickers run in TICK_ORDER once per second, one run at a time (plan 2725, F2 #39)', async () => {
  const sched = new FireScheduler();
  const { daemon, ctx, clock, cleanup } = await makeDaemon({ scheduler: sched });
  const fx = await makeEngines('comp-tick', { n: 1, engineDeps: () => daemon.engineDeps });
  try {
    await daemon.attach(fx.peers[0]!.engine, fx.peers[0]!.core);
    recordTicks(ctx);
    resetTick('slow');
    const t0 = clock.monoMs();
    await sched.runUntil(clock, t0 + 5_000);                           // the slow ticker takes 1,500 ms virtual per run
    assert.equal(tick.maxInFlight, 1, 'the slow ticker never overlaps itself');
    assert.ok(tick.runs >= 2, `health ran ${tick.runs} times`);
    for (const run of runsOf(tick.log).slice(0, -1)) assert.deepEqual(run, ['seats', 'health', 'engineView']);
    assert.deepEqual(sched.rejections, []);
    // A fast loop ('off'): one run per second exactly.
    tick.mode = 'off';
    const from = tick.log.length;
    await sched.runUntil(clock, t0 + 10_000);
    const seatsMono = tick.log.slice(from).filter((e) => e.id === 'seats').map((e) => e.mono);
    assert.ok(seatsMono.length >= 3, `seats ran ${seatsMono.length} times`);
    for (let i = 1; i < seatsMono.length; i++) assert.equal(seatsMono[i]! - seatsMono[i - 1]!, 1_000);
    for (const run of runsOf(tick.log.slice(from)).slice(1)) assert.deepEqual(run, ['seats', 'health', 'engineView']);
  } finally {
    resetTick('off');
    await daemon.close('removal');
    await fx.cleanup();
    await cleanup();
  }
});

test('a throwing ticker is logged once as DAEMON_INTERNAL_ERROR, the later tickers of that run still run, and the loop keeps its 1 s cadence (R-F2-14, F2 #46 #101)', async () => {
  const sched = new FireScheduler();
  const log = new LogRecorder();
  const { daemon, ctx, clock, cleanup } = await makeDaemon({ scheduler: sched, log });
  const fx = await makeEngines('comp-tick-throw', { n: 1, engineDeps: () => daemon.engineDeps });
  try {
    await daemon.attach(fx.peers[0]!.engine, fx.peers[0]!.core);
    recordTicks(ctx);
    resetTick('throw');
    const t0 = clock.monoMs();
    await sched.runUntil(clock, t0 + 2_000);
    assert.deepEqual(sched.rejections, [], 'no rejection reached the scheduler');
    const runs = runsOf(tick.log);
    assert.deepEqual(runs[0], ['seats', 'health', 'engineView'], 'engineView ran in the run where health threw');
    assert.equal(tick.log.filter((e) => e.id === 'seats').length, 2, 'the next second\'s run happened');
    const errs = log.lines.filter((l) => l.code === 'DAEMON_INTERNAL_ERROR');
    assert.equal(errs.length, 1);
    assert.deepEqual(errs[0]!.params, { where: 'ticker', ticker: 'health', error: 'Error' });
    assert.equal(errs[0]!.level, 'error');
  } finally {
    resetTick('off');
    await daemon.close('removal');
    await fx.cleanup();
    await cleanup();
  }
});

test('a ticker that throws the same error every second is logged once until it recovers; no ticker runs after close (R-F2-14, F2 #46 #101)', async () => {
  const sched = new FireScheduler();
  const log = new LogRecorder();
  const { daemon, ctx, clock, cleanup } = await makeDaemon({ scheduler: sched, log });
  const fx = await makeEngines('comp-tick-flood', { n: 1, engineDeps: () => daemon.engineDeps });
  const errs = (): number => log.lines.filter((l) => l.code === 'DAEMON_INTERNAL_ERROR').length;
  try {
    await daemon.attach(fx.peers[0]!.engine, fx.peers[0]!.core);
    recordTicks(ctx);
    resetTick('throwAlways');
    const t0 = clock.monoMs();
    await sched.runUntil(clock, t0 + 5_000);
    assert.ok(tick.runs >= 4, `health ran ${tick.runs} times`);
    assert.equal(errs(), 1, 'the same error from the same ticker is logged once');
    tick.mode = 'off';                                                 // the ticker recovers ...
    await sched.runUntil(clock, t0 + 7_000);
    tick.mode = 'throwAlways';                                         // ... and fails again: logged once more
    await sched.runUntil(clock, t0 + 10_000);
    assert.equal(errs(), 2);
    assert.deepEqual(sched.rejections, []);
    // A run scheduled before close does not start after it.
    tick.mode = 'off';
    await daemon.close('removal');
    const ran = tick.log.length;
    await sched.runUntil(clock, t0 + 13_000);
    assert.equal(tick.log.length, ran, 'no ticker ran after close');
  } finally {
    resetTick('off');
    await fx.cleanup();
    await cleanup();
  }
});

test('an attach that throws leaves the previous engine\'s binding whole (C-ATTACH, F2 #91)', async () => {
  const { daemon, ctx, cleanup } = await makeDaemon();
  const fx = await makeEngines('comp-attach-throw', { n: 1, engineDeps: () => daemon.engineDeps });
  try {
    const p = fx.peers[0]!;
    const e1 = p.engine;
    const c1 = e1.core;
    const subs1 = spySubs(c1, e1);
    await daemon.attach(e1, c1);
    const view1 = ctx.engine;
    const e2 = await Engine.create(p.deps);
    const c2 = e2.core;
    const subs2 = spySubs(c2, e2);
    (c2.repo as unknown as Record<string, unknown>)['attachMark'] = 'c2';
    const sig1 = recordSignals(e1);
    const sig2 = recordSignals(e2);
    (ctx.checkpoints as unknown as { attachEngine: (e: Engine) => void }).attachEngine = () => { throw new Error('attachEngine failed'); };
    await assert.rejects(daemon.attach(e2, c2), /attachEngine failed/);
    assert.deepEqual(subs1.live(), { hold: 1, status: 1 }, 'the first engine keeps its observers');
    assert.deepEqual(subs2.live(), { hold: 0, status: 0 }, 'the failed engine keeps none');
    assert.equal(ctx.engine, view1, 'the engine view is still the first engine\'s');
    assert.equal((ctx.ports.git as unknown as Record<string, unknown>)['attachMark'], undefined, 'the git port still follows the first core');
    ctx.signals.send({ kind: 'activity', seat: S, activity: 'IDLE' });
    await waitFor(() => sig1.length > 0, 50);
    assert.equal(sig1.length, 1, 'the signal reaches the first engine');
    assert.equal(sig2.length, 0);
  } finally {
    await fx.cleanup();
    await cleanup();
  }
});

test('overlapping attaches: the newest attach wins even when an older one finishes its await last (C-ATTACH, F2 #91)', async () => {
  const { daemon, ctx, cleanup } = await makeDaemon();
  const fx = await makeEngines('comp-attach-race', { n: 1, engineDeps: () => daemon.engineDeps });
  try {
    const p = fx.peers[0]!;
    const e1 = p.engine;
    const c1 = e1.core;
    const subs1 = spySubs(c1, e1);
    const e2 = await Engine.create(p.deps);
    const c2 = e2.core;
    const subs2 = spySubs(c2, e2);
    (c2.repo as unknown as Record<string, unknown>)['attachMark'] = 'c2';
    const shadows = ctx.shadows as unknown as { convertLeftovers: () => Promise<void> };
    const convert = shadows.convertLeftovers.bind(shadows);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    shadows.convertLeftovers = async () => { calls += 1; if (calls === 1) await gate; await convert(); };
    const first = daemon.attach(e1, c1);                               // held inside convertLeftovers
    await daemon.attach(e2, c2);                                       // started later, finishes first
    release();
    await first;
    assert.deepEqual(subs2.live(), { hold: 1, status: 1 }, 'the newest engine is bound');
    assert.deepEqual(subs1.live(), { hold: 0, status: 0 }, 'the superseded attach bound nothing');
    assert.equal((ctx.ports.git as unknown as Record<string, unknown>)['attachMark'], 'c2', 'the git port follows the newest core');
    const sig1 = recordSignals(e1);
    const sig2 = recordSignals(e2);
    ctx.signals.send({ kind: 'activity', seat: S, activity: 'IDLE' });
    await waitFor(() => sig2.length > 0, 50);
    assert.equal(sig2.length, 1);
    assert.equal(sig1.length, 0);
  } finally {
    await fx.cleanup();
    await cleanup();
  }
});

test('the VersionPolicy defaults: the daemon version and A5-14 proto', async () => {
  const { ctx, cleanup } = await makeDaemon();
  assert.equal(ctx.versions.judge(PLUGIN_VERSION, HOOK_PROTO), 'serve');             // same version, own proto
  assert.equal(ctx.versions.judge('9.9.9', HOOK_PROTO), 'serve_then_drain');         // newer caller
  assert.equal(ctx.versions.judge(PLUGIN_VERSION, HOOK_PROTO + 1), 'serve');         // a newer caller proto is fine (the pinned rule)
  assert.equal(ctx.versions.judge(PLUGIN_VERSION, HOOK_PROTO + 2), 'serve');         // any newer proto serves
  assert.equal(ctx.versions.judge('0.0.1', HOOK_PROTO - 2), 'restart_required');     // older version, proto two behind
  assert.equal(C.MCP_PAIRING_MS, 3000);                                              // the pairing window the registry was built with
  await cleanup();
});

test('sendToSeat is false while no seat connection is tracked; the bind is the harness suites', async () => {
  const { ctx, cleanup } = await makeDaemon();
  const server = new ClaudeServer(ctx, Buffer.alloc(32, 7), '\\\\.\\pipe\\comp-test-placeholder');
  assert.equal(server.sendToSeat(S, { t: 'refused', code: 'X' }), false);
  server.setVersionDrain(() => undefined);                           // the additive members accept the composition's calls
  server.setReady();
  await server.close();                                              // never bound: resolves
  await cleanup();
});

test('A5-11: pre-attach the lease source is empty, so the lease idles from construction (decisions 7-1, contract 2765)', async () => {
  const { ctx, clock, cleanup } = await makeDaemon();
  // Reading (a) of decision 7-1 (raised by the harness contract: "humanLeaseMin: 0 → idleMs() > 0 from the
  // start"): a lease that has never been valid has its end at the constructor's instant, so idleMs() counts
  // from composition — with no human grant the peer is idle at once and stays idle (the PEER_IDLE draft the
  // first call queues is buffered pre-attach, decision 7-12).
  clock.advance(5_000);
  assert.equal(ctx.seatLease.idleMs(), 5_000);
  clock.advance(1_000);
  assert.equal(ctx.seatLease.idleMs(), 6_000);
  await cleanup();
});
