// src/claude/daemon/signals.ts — the per-seat signal pump and the capture-at-trigger identity (CCI-36, 06 §3.12.1,
// R5-20, R5-23, R5-24, R5-25; Task 6). SignalPump.send hands each CS signal to Plan 3's Engine.signal synchronously
// inside send, in call order (A6-4). Plan 3's landed Engine.signal runs its queueSignal inside the engine's one
// exclusive queue (loop.ts exclusive(): never during an iteration, a start or a resolve), so the effect reaches the
// CS table at that queue's next turn: one microtask later on an idle engine, after the in-flight operation otherwise.
// A6-4 as amended by R-F2-5 and narrowed by the controller's C-8 (F2 #32, #62): send returns a promise that resolves
// once the signal is in that queue (the synchronous enqueue inside Engine.signal), never waits for the queue, and
// never rejects — so no hook reply, including Task 12's edit-class PostToolUse that awaits its effect send, waits
// for an engine iteration (06 test 47(f) latency bound). captureIdentity keeps the A6-5 IdentityMemo; IdleTimer is
// the HLD-34 fallback (A6-10); greenCheck is R5-23/A6-8; onContextReset is F05-09's per-daemon module registry
// (A6-13, X-47).
import { join } from 'node:path';
import { ABSENT, type OidOrAbsent } from '../../git/oid.js';
import { errnoCode, sameStat, type FsLstat } from '../../ports/fs.js';
import type { Log } from '../../ports/log.js';
import type { Engine } from '../../engine/loop.js';
import { stageable } from '../../engine/stagedRead.js';
import type { CsSignal, CaptureExpect } from '../../holds/signals.js';
import { C } from '../wire/constants.js';
import type { HookPayload } from '../wire/frames.js';
import type { DaemonCtx, HookRequest } from './ctx.js';
import { shortRead, type DiskSnapshot } from './hookRead.js';
import { registerStep, registerTicker } from './pipeline.js';

// ---- SignalPump (A6-4, A13-5, X5-12) --------------------------------------------------------------------------------

export class SignalPump {
  /** csId → the last cand_seq this run returned. F2 #72: a seat's `<seat>/` entries go when send carries its
   *  seat_end (never at CS close: Task 13 can still draw for a just-closed CS, and dropping could repeat a value). */
  private readonly last = new Map<string, number>();
  /** Phase 3a-1: constructible; the composition passes the attached Engine at attach (decision 7-8's pre-attach
   *  stand-in only satisfies send's no-op). */
  constructor(private readonly engine: Engine, private readonly log: Log) {}

  /** A6-4 as amended by R-F2-5 and narrowed by C-8: send(s) calls engine.signal(s) synchronously inside send (per-seat
   *  order is the call order) and returns a promise that is already resolved: the signal is in Plan 3's exclusive queue
   *  (Engine.signal enqueues before its first await), and its CS-table effect is visible at that queue's next turn — at
   *  once on an idle engine, after an in-flight iteration otherwise; the promise never waits for that turn and never
   *  rejects. A rejection of Engine.signal (now or later) or a synchronous throw logs one CS_SIGNAL_REJECTED line
   *  {kind, error} (A6-9) and touches nothing else. Before the engine's first successful start() Plan 3 keeps the
   *  signal in its earlySignals and replays it after the start's restore (Plan 3 Task 12b), so no queueSignal runs
   *  until then. No reply-path caller needs to await it (R5-24); Task 12's post.edit may (R-F2-5) and still never
   *  waits for an iteration. */
  send(s: CsSignal): Promise<void> {
    if (s.kind === 'seat_end' && s.seat !== '') {
      for (const csId of [...this.last.keys()]) if (csId.startsWith(`${s.seat}/`)) this.last.delete(csId);
    }
    let p: Promise<void>;
    try {
      p = this.engine.signal(s);
    } catch (err) {
      this.logRejected(s, err);
      return Promise.resolve();
    }
    p.then(undefined, (err: unknown) => this.logRejected(s, err));
    return Promise.resolve();
  }

  /** A6-4/A13-5 (X5-12): the one per-CS cand_seq counter = 1 + max(the last value this run returned for csId, the
   *  CS's CsTableEntry.cap_seq). Green checkpoints (Task 6), edit candidates (Task 13) and cowork_checkpoint
   *  (Task 14) draw from it. */
  nextCandSeq(csId: string): number {
    const core = (this.engine as Engine).core as Engine['core'] | undefined;
    const cap = core === undefined ? 0 : (core.cs.table().cs.find((c) => c.cs_id === csId)?.cap_seq ?? 0);
    const next = 1 + Math.max(this.last.get(csId) ?? 0, cap);
    this.last.set(csId, next);
    return next;
  }

  /** Test-only (F2 #72): the per-CS counter's size. */
  sizesForTest(): { last: number } { return { last: this.last.size }; }

  private logRejected(s: CsSignal, err: unknown): void {
    this.log.write('error', 'CS_SIGNAL_REJECTED', { kind: s.kind, error: errnoCode(err) ?? (err instanceof Error ? err.name : 'unknown') });   // SEC-38: the errno code or the name, never the message (F2 t5-run's Code-edit request, #94)
  }
}

// ---- captureIdentity (R5-20, A6-5, SE5-03) --------------------------------------------------------------------------

interface MemoEntry { stat: FsLstat; oid: OidOrAbsent }
/** A6-5: the in-memory IdentityMemo — per path, the FsLstat and oid of the newest identity this daemon computed (a
 *  post-image, a candidate or a closing capture); a restart starts empty. F2 #42/#70: one memo per daemon ctx, keyed
 *  by the clone's absolute path (two daemons in one process never share entries). */
const identityMemos = new WeakMap<DaemonCtx, Map<string, MemoEntry>>();

function memoOf(ctx: DaemonCtx): Map<string, MemoEntry> {
  let memo = identityMemos.get(ctx);
  if (memo === undefined) {
    memo = new Map<string, MemoEntry>();
    identityMemos.set(ctx, memo);
  }
  return memo;
}

/** Test-only (F2 #72): the size of this daemon ctx's identity memo. */
export function identityMemoSizeForTest(ctx: DaemonCtx): number {
  return identityMemos.get(ctx)?.size ?? 0;
}

/** The clone's file for a repo-relative path (F2 #70: never the process cwd's). */
function cloneFile(ctx: DaemonCtx, p: string): string {
  return join(ctx.repo.root, ...p.split('/'));
}

const OVER_BUDGET = Symbol('over budget');

/** R5-20: the CS paths' content identity within budgetMs; null when over budget or a read stays unstable (SE5-03:
 *  the closing signal then goes without `expect` and Plan 3 takes the window late). Per CS path: known → its oid (no
 *  read, no object); else lstat of the clone's file equal (sameStat) to the memo → the memo's oid; else one shortRead
 *  + DiskSnapshots.take (route (b), no object; repo-relative path) → its oid; missing → ABSENT; unstable or
 *  unreadable → the whole identity null; any thrown error → null. F2 #81: a path that fails stageable() (stagedRead.ts
 *  rulings P2-CARRY, P2-DOTGIT) makes the whole identity null before any path is looked at. F2 #64: the budget is
 *  one timer per capture (armed at its first I/O) raced against every awaited step, so the hook reply never waits
 *  past budgetMs for a read or a hash still running; an abandoned step runs on in the background, writes the memo
 *  when it yields an oid and releases its snapshot, and never rejects. Every snapshot taken is released right after
 *  its oid is read (in-memory entries need DiskSnapshots' refcount, a Carry of the hookRead owner). */
export async function captureIdentity(seatId: string, csPaths: readonly string[], known: ReadonlyMap<string, DiskSnapshot>, ctx: DaemonCtx, budgetMs: number): Promise<Readonly<Record<string, OidOrAbsent>> | null> {
  void seatId;
  try {
    if (!csPaths.every((p) => stageable(p))) return null;   // never looked at, read, hashed or compared
    const clock = ctx.ports.clock;
    const start = clock.monoMs();
    const memo = memoOf(ctx);
    let overrun: Promise<typeof OVER_BUDGET> | null = null;
    const budget = (): Promise<typeof OVER_BUDGET> => {
      overrun ??= clock.sleep(Math.max(0, budgetMs - (clock.monoMs() - start))).then(() => OVER_BUDGET);
      return overrun;
    };
    const out: Record<string, OidOrAbsent> = {};
    for (const p of csPaths) {
      if (clock.monoMs() - start > budgetMs) return null;
      const k = known.get(p);
      if (k !== undefined) {
        out[p] = k.oid;                                    // the bytes already in hand (an edited post-image)
        continue;
      }
      const got = await Promise.race([identityOf(ctx, memo, p), budget()]);
      if (got === OVER_BUDGET || got === null) return null;
      out[p] = got;
    }
    if (clock.monoMs() - start > budgetMs) return null;
    return out;
  } catch {
    return null;                                           // any throw → late (SE5-03)
  }
}

/** One path's identity (captureIdentity's per-path chain). It runs to its end even after the capture gave up at the
 *  budget, and never rejects: null = no identity (unstable, unreadable, a throw). */
async function identityOf(ctx: DaemonCtx, memo: Map<string, MemoEntry>, p: string): Promise<OidOrAbsent | null> {
  try {
    const abs = cloneFile(ctx, p);
    const s1 = await ctx.ports.fs.lstat(abs);
    if (s1 === null) return ABSENT;                        // missing → ABSENT
    const m = memo.get(abs);
    if (m !== undefined && sameStat(s1, m.stat)) return m.oid;   // unchanged since the newest computed identity
    const read = await shortRead(ctx.ports.fs, abs);
    if (read.kind === 'missing') return ABSENT;
    if (read.kind !== 'ok') return null;                   // unstable (an approximate window) or unreadable
    const snap = await ctx.reads.take(p, read);            // route (b): no object written (SE5-03)
    memo.set(abs, { stat: read.stat, oid: snap.oid });     // as soon as the oid is known, even past the budget
    try {
      void Promise.resolve(ctx.reads.release(snap)).catch(() => undefined);   // the reply never waits for it
    } catch {
      // a release that throws at once frees nothing more; the oid stands
    }
    return snap.oid;
  } catch {
    return null;
  }
}

// ---- IdleTimer (HLD-34, A6-10) --------------------------------------------------------------------------------------

/** HLD-34 fallback (A6-10): one idle_10min per silence, once per hook gap. */
export class IdleTimer {
  private readonly armed = new Set<string>();
  constructor(private readonly ctx: DaemonCtx) {}

  tick(): void {
    const now = this.ctx.ports.clock.monoMs();
    for (const s of this.ctx.seats.seats()) {
      if (s.lastHookMono === null) continue;
      const silent = now - s.lastHookMono >= C.IDLE_CLOSE_MS;
      if (silent && !this.armed.has(s.seat_id)) {
        this.armed.add(s.seat_id);
        this.ctx.signals.send({ kind: 'idle_10min', seat: s.seat_id, activity: s.activity, txnOpen: this.ctx.leases.openFor(s.seat_id).txns > 0 });
      } else if (!silent) {
        this.armed.delete(s.seat_id);                      // re-arms at the seat's next hook
      }
    }
  }
}

// ---- greenCheck (R5-23, A6-8, SE5-06) -------------------------------------------------------------------------------

/** R5-23: PostToolUse/PostToolUseFailure of Bash|PowerShell whose command starts with a checks.checkpoint entry →
 *  checks_run{ok}; an ok PostToolUse is also a green checkpoint. checksRun is that checks_run's ok (true / false), or
 *  null when no checks_run is due (plan 2812: exit_status 1 → {checksRun: false, green: false}). A6-8: after
 *  trimming leading whitespace a command matches an entry c iff it equals c or starts with c followed by a whitespace
 *  character (npm test ≠ npm testx); only Bash and PowerShell calls count (a PermissionDenied close is never a
 *  checkpoint). Q6: a PostToolUse with no exposed status (exit_status null) is ok. */
export function greenCheck(p: Extract<HookPayload, { event: 'PostToolUse' | 'PostToolUseFailure' | 'PermissionDenied' }>, commands: readonly string[]): { checksRun: boolean | null; green: boolean } {
  if (p.event === 'PostToolUse') {
    if (p.tool_name !== 'Bash' && p.tool_name !== 'PowerShell') return { checksRun: null, green: false };
    if (p.command === null || !matchEntry(p.command, commands)) return { checksRun: null, green: false };
    const ok = p.exit_status === null ? true : p.exit_status === 0;   // 06 §8 Q6 default
    return { checksRun: ok, green: ok };                           // plan 2812: checksRun is checks_run's ok
  }
  if (p.event === 'PermissionDenied') return { checksRun: null, green: false };   // never a checkpoint
  const cmd = 'command' in p ? p.command : null;
  if (p.tool_name !== 'Bash' && p.tool_name !== 'PowerShell') return { checksRun: null, green: false };
  if (cmd === null || !matchEntry(cmd, commands)) return { checksRun: null, green: false };
  return { checksRun: false, green: false };
}

function matchEntry(command: string, commands: readonly string[]): boolean {
  const c = command.replace(/^\s+/, '');
  return commands.some((e) => c === e || c.startsWith(`${e} `) || c.startsWith(`${e}\t`));
}

// ---- context resets (F05-09, A6-13, X-47) ---------------------------------------------------------------------------

export interface ContextReset { seatId: string; agentId: string | null; why: 'compact' | 'clear' | 'resume' | 'fork' | 'subagent_start' | 'subagent_stop' }

type ResetCb = (r: ContextReset) => void;
const resetSubs = new Set<ResetCb>();

/** F05-09 (A6-13): the module-level registry is the only form (X-47); Plan 6's bindClaude subscribes to it. */
export function onContextReset(cb: ResetCb): () => void {
  resetSubs.add(cb);
  return () => {
    resetSubs.delete(cb);
  };
}

function contextReset(seatId: string, agentId: string | null, why: ContextReset['why']): void {
  const r: ContextReset = { seatId, agentId, why };
  for (const cb of [...resetSubs]) cb(r);
}

// ---- the `signal.emit` step and the `idle` ticker (the plan's Step behaviour note) -----------------------------------

/** The seat's open CS (A6-6); undefined pre-attach or a throwing view → null (a step never throws, R5-55). */
function openCs(ctx: DaemonCtx, seatId: string, agent: string | null): string | null {
  const eng = ctx.engine as import('./engineView.js').EngineView | undefined;
  if (eng === undefined) return null;
  try {
    return eng.openCsOf(seatId, agent);
  } catch {
    return null;
  }
}

function closeWithExpect(ctx: DaemonCtx, seatId: string, agent: string | null, s: CsSignal & { expect?: CaptureExpect }): Promise<void> {
  const csId = openCs(ctx, seatId, agent);
  if (csId === null) {
    ctx.signals.send(s);
    return Promise.resolve();
  }
  const paths = ctx.engine.csPaths(csId);
  return captureIdentity(seatId, paths, new Map(), ctx, C.CAPTURE_BOUND_MS).then((expect) => {
    ctx.signals.send(expect === null ? s : { ...s, expect });   // over budget / unstable / a throw → late (SE5-03)
    forgetPaths(ctx, paths);                                    // F2 #72: the closed CS's identities leave the memo
  });
}

/** F2 #72: drops a closed CS's paths from this daemon's identity memo (a late background read may re-add one entry
 *  per path, so the memo stays bounded by the repository's distinct paths). */
function forgetPaths(ctx: DaemonCtx, paths: readonly string[]): void {
  const memo = identityMemos.get(ctx);
  if (memo === undefined) return;
  try {
    for (const p of paths) memo.delete(cloneFile(ctx, p));
  } catch {
    // a ctx without a repo (a step double) holds no memo entry to drop
  }
}

function greenCheckpoint(ctx: DaemonCtx, seatId: string, agent: string | null): Promise<void> {
  const csId = openCs(ctx, seatId, agent);
  if (csId === null) return Promise.resolve();                // with no open CS only checks_run
  const paths = ctx.engine.csPaths(csId);
  const candSeq = ctx.signals.nextCandSeq(csId);
  return captureIdentity(seatId, paths, new Map(), ctx, C.CAPTURE_BOUND_MS).then((expect) => {
    const base: CsSignal = { kind: 'checkpoint', seat: seatId, source: 'green', candSeq, paths };
    ctx.signals.send(expect === null ? base : { ...base, expect });
  });
}

registerStep('signal.emit', (r: HookRequest, _d, ctx: DaemonCtx): Promise<void> => {
  const ev = r.frame.event;
  const seatId = r.seat.seatId ?? '';
  const agent = r.frame.h.agent_id;
  switch (ev) {
    case 'UserPromptSubmit': {
      const t = r.turn;
      if (t !== null && t.origin === 'human' && t.newTurn && !t.doorbell) ctx.signals.send({ kind: 'prompt', seat: seatId, humanOrigin: true, nonce: false });
      return Promise.resolve();
    }
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PermissionDenied': {
      const g = greenCheck(r.frame.payload as Extract<HookPayload, { event: 'PostToolUse' | 'PostToolUseFailure' | 'PermissionDenied' }>, ctx.engine.checkpointCommands());
      if (g.checksRun !== null) ctx.signals.send({ kind: 'checks_run', seat: seatId, ok: g.checksRun === true });
      if (g.green) return greenCheckpoint(ctx, seatId, agent);
      return Promise.resolve();
    }
    case 'Stop':
      return closeWithExpect(ctx, seatId, agent, { kind: 'stop', seat: seatId });
    case 'StopFailure':
      return closeWithExpect(ctx, seatId, agent, { kind: 'stop_failure', seat: seatId });
    case 'SubagentStop':
      return closeWithExpect(ctx, seatId, agent, { kind: 'subagent_stop', seat: seatId, agent: agent ?? '' }).then(() => {
        contextReset(seatId, agent ?? '', 'subagent_stop');
      });
    case 'SessionEnd':
      return closeWithExpect(ctx, seatId, agent, { kind: 'session_end', seat: seatId });
    case 'SessionStart': {
      const src = (r.frame.payload as Extract<HookPayload, { event: 'SessionStart' }>).source;
      if (src !== 'startup') contextReset(seatId, agent, src);   // compact | clear | resume | fork
      return Promise.resolve();
    }
    case 'SubagentStart': {
      const payloadAgent = (r.frame.payload as Extract<HookPayload, { event: 'SubagentStart' }>).agent_id;
      contextReset(seatId, agent ?? payloadAgent, 'subagent_start');
      return Promise.resolve();
    }
    default:
      return Promise.resolve();
  }
});

/** One IdleTimer per daemon ctx (F2 #63): the registered ticker is daemon-agnostic (claudeDaemon.ts A5-7), so two
 *  daemons in one process (seatHarness peers >= 2, the seats SIM) each keep their own once-per-silence record. */
const idleTimers = new WeakMap<DaemonCtx, IdleTimer>();
registerTicker('idle', (ctx: DaemonCtx): void => {
  let timer = idleTimers.get(ctx);
  if (timer === undefined) {
    timer = new IdleTimer(ctx);
    idleTimers.set(ctx, timer);
  }
  timer.tick();
});
