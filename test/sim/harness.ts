// Deterministic multi-peer SIM loop (11-testing §3.3; Plan 1 skeleton, Plan 2 Task 18 additions).
// Same SeedTuple => same op-log, same trace and same remote ref oids (TST-03). What makes that true is pinned
// here and in the fixtures, not hoped for:
// - every random choice comes from seededRandom(seed + '/sim') or seededRandom(seed + '/scheduler'), and engines
//   derive their own Random from the seed (ctx.seed);
// - every commit carries an explicit identity and a date from a VirtualClock (engines pass
//   GitCallOptions.wallMsForDates = clock.wallMs()); the seed commit uses Task 12's fixed date;
// - directory listings go through the Fs port, whose readdir is sorted by code unit (Task 4), and
//   git sorts tree entries itself, so file-creation order never reaches an oid;
// - nothing that reaches the op-log reads the real clock, timer resolution, GitResult.durationMs or
//   the temp root path (push trace events carry the remote URL: comparisons normalise it).
// On a failure the temp root is kept and <root>/artifacts holds op-log.jsonl, trace.jsonl, copies of the remote
// logs and a bundle of the remote (11-testing §3.3 Failure).
//
// Plan 2 (Task 18) adds, all behind the optional 4th argument (without it, or with no option set, a run is exactly
// the Plan 1 run: the same draws, op-log and oids):
// - an op generator (run step 1): each step either runs one generated operation (`SimOp`, logged with its detail) or,
//   when the generator returns null, one engine step of a random peer (the Plan 1 step);
// - crash injection (run step 4): p per step of arming a KilledAt at a random peer's next crashpoint, thrown only
//   while that peer's engine step runs from the harness (never inside a generated operation); a crash still armed
//   when the op budget ends is disarmed (`crash_disarmed`), and the caller's crash handler is put back after the run;
// - quiescence (run step 5, ruling R-32 as amended in Task 19's fix round 2): rounds in which every peer clock advances
//   loopMs and every engine steps once in peer-name order, until every peer has run k rounds since it observed the
//   remote board tip — a successful `fetch` trace event of that tip in a quiescence round, so after the forced heal;
//   the count restarts at every tip change, and a peer whose engine registers no trace name counts from the tip's last
//   change — (T*), at most maxRounds ("no quiescence" otherwise); then extraLoops more rounds counting push attempts and
//   tip changes; the afterEveryOp oracles run after every round, the atQuiescence oracles once at the end;
// - host emulation (§3.3): a partition renames the bare remote away (fetches and pushes fail fast), heal renames it
//   back; the harness heals (logging the outage it ended) and clears pending rejections before quiescence;
// - advanceClocks(ctx, ms): virtual time passes for a scripted step exactly as between two harness steps.
import { copyFile, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { EngineInspection } from '../../src/engine/loop.js';
import type { GitRunner } from '../../src/git/runner.js';
import { KilledAt, setCrashHandler } from '../../src/ports/crashpoint.js';
import { randomInt, seededRandom, type Random } from '../../src/ports/random.js';
import { makeTempRoot, testRunner } from '../helpers/tmp.js';
import { clonePeer, seedRemote, type PeerClone } from './peers.js';
import { createBareRemote, type BareRemote } from './remote.js';
import { TraceRecorder } from './traceRecorder.js';
import { VirtualClock } from './vclock.js';
import { VirtualScheduler } from './vscheduler.js';

export interface SeedTuple { seed: string; peers: number; ops: number; }
export interface OpLogEntry { step: number; peer: string; kind: string; detail: string; }
export type SimPhase = 'ops' | 'quiescence' | 'extra';
export interface SimContext {
  root: string; remote: BareRemote; peers: PeerClone[]; git: GitRunner; random: Random;
  clocks: Map<string, VirtualClock>; scheduler: VirtualScheduler; opLog: OpLogEntry[];
  /** The tuple's seed (Task 18 extension: realEngine binds seededRandom(`${seed}/${peer}`) per peer). */
  readonly seed: string;
  /** Every peer's engine, in ctx.peers order (filled right after the factory ran). */
  engines: SimEngine[];
  /** The run's TraceRecorder: every engine emits into it; names maps peer ids to peer names. */
  trace: TraceRecorder;
  phase: SimPhase;
  /** Set once the quiescence phase ended (null before, and in runs without one). */
  quiescence: QuiescenceInfo | null;
}
export interface SimEngine {
  readonly peer: PeerClone;
  step(ctx: SimContext): Promise<void>;
  inspect?(): Promise<EngineInspection>;
  /** Push attempts counted so far (cumulative across restarts). */
  pushAttempts?(): number;
}
export type EngineFactory = (ctx: SimContext, peer: PeerClone) => SimEngine;
export interface Oracle {
  name: string;
  afterEveryOp?(ctx: SimContext): Promise<string | null>;
  atQuiescence?(ctx: SimContext): Promise<string | null>;
}
/** One generated operation; run() returns its op-log detail. */
export interface SimOp { readonly peer: string; readonly kind: string; run(ctx: SimContext): Promise<string>; }
/** null → one engine step of a random peer (the Plan 1 step). */
export interface OpGenerator { next(ctx: SimContext, step: number): SimOp | null; }
export interface QuiescenceOptions { loopMs: number; k: number; extraLoops: number; maxRounds: number; }
export const DEFAULT_QUIESCENCE: QuiescenceOptions = Object.freeze({ loopMs: 2_500, k: 20, extraLoops: 40, maxRounds: 400 });
export interface QuiescenceInfo { reached: boolean; tStar: string | null; rounds: number; pushAttemptsInExtra: number; boardChangedInExtra: boolean; }
export interface SimOptions {
  generator?: OpGenerator;
  /** Omitted = Plan 1 behaviour (no quiescence phase). */
  quiescence?: QuiescenceOptions;
  seedFiles?: Record<string, Buffer>;
  peerProfile?: (index: number) => { autocrlf: boolean; withFilter: boolean };
  /** p per step of arming a KilledAt at a random peer's next crashpoint. */
  crash?: { rate: number };
}
export interface SimResult {
  ok: boolean;
  failure?: { oracle: string; message: string; step: number };
  opLog: OpLogEntry[];
  remoteRefs: Record<string, string>;
  /** Set only when ok is false: <root>/artifacts; the temp root is kept and the caller removes it. */
  artifactsDir?: string;
  /** Set when the run had a quiescence phase. */
  quiescence?: QuiescenceInfo;
}

/** Peer wall offsets are drawn from ±600 s and drifts from ±100 ppm (11-testing §3.2 Clock SIM binding, F-PEER-4). */
const MAX_SKEW_S = 600;
const MAX_DRIFT_PPM = 100;
/** Each step advances virtual time by 1–5 s. */
const STEP_MIN_MS = 1_000;
const STEP_SPREAD_MS = 4_000;
/** Scheduler tasks drained after each step; more means an engine reschedules itself forever. */
const MAX_TASKS_PER_STEP = 10_000;
/** Crash arming draws an integer below this; rate × CRASH_SCALE of them arm. */
const CRASH_SCALE = 1_000_000;
const SEED_FILES: Record<string, Buffer> = {
  'README.md': Buffer.from('cowork-sync SIM fixture\n', 'utf8'),
  'notes.txt': Buffer.from('seed\n', 'utf8'),
};

// ---- host emulation: partitions (11-testing §3.3 "Partitions: rename remote.git") ------------------------------------

/** A partitioned remote lives at `${remote.dir}${PARTITION_SUFFIX}`; remote.dir (and so remote.url) is gone meanwhile. */
export const PARTITION_SUFFIX = '.partitioned';

async function exists(p: string): Promise<boolean> {
  return (await lstat(p).catch(() => null)) !== null;
}

/** Error codes of a transient Windows holder (antivirus, an indexer, a just-exited git). */
const HOLDER_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * `fn` retried while it fails with a transient Windows holder's code, `delayMs` of real time apart, `attempts` calls in
 * all (default 41 × 50 ms); any other error, or the last attempt's, is thrown. Test code only: the real delay never
 * reaches the op-log, an oid or an engine.
 */
export async function retryTransientHolder<T>(fn: () => Promise<T>, opts?: { attempts?: number; delayMs?: number }): Promise<T> {
  const attempts = opts?.attempts ?? 41;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= attempts || code === undefined || !HOLDER_CODES.has(code)) throw e;
      await delay(opts?.delayMs ?? 50);
    }
  }
}

/** A directory rename, retried while Windows reports a transient holder. */
async function renameDir(from: string, to: string): Promise<void> {
  await retryTransientHolder(() => rename(from, to));
}

export async function remotePartitioned(ctx: Pick<SimContext, 'remote'>): Promise<boolean> {
  return !(await exists(ctx.remote.dir)) && (await exists(`${ctx.remote.dir}${PARTITION_SUFFIX}`));
}

/** When a partition began (virtual mono) and how long it was drawn to last. */
export interface PartitionPlan { readonly sinceMono: number; readonly plannedMs: number; }
const plans = new WeakMap<BareRemote, PartitionPlan>();

/** The plan of the remote's current partition (given to partitionRemote), or null. */
export function partitionPlan(ctx: Pick<SimContext, 'remote'>): PartitionPlan | null {
  return plans.get(ctx.remote) ?? null;
}

/** Renames the bare remote away and records `plan`; false when it already was. */
export async function partitionRemote(ctx: Pick<SimContext, 'remote'>, plan?: PartitionPlan): Promise<boolean> {
  if (await remotePartitioned(ctx)) return false;
  await renameDir(ctx.remote.dir, `${ctx.remote.dir}${PARTITION_SUFFIX}`);
  if (plan !== undefined) plans.set(ctx.remote, plan);
  return true;
}

/** Renames a partitioned bare remote back; false when it was not partitioned. */
export async function healRemote(ctx: Pick<SimContext, 'remote'>): Promise<boolean> {
  if (!(await remotePartitioned(ctx))) return false;
  await renameDir(`${ctx.remote.dir}${PARTITION_SUFFIX}`, ctx.remote.dir);
  plans.delete(ctx.remote);
  return true;
}

/**
 * The op-log detail of a heal at virtual mono `nowMono`: `for_ms` is the outage the partition really had, `planned_ms`
 * what it was drawn for (a heal drawn early, or the harness's at the end of the op budget, cuts it short).
 */
export function healDetail(plan: PartitionPlan | null, nowMono: number): string {
  return plan === null ? '' : `for_ms=${nowMono - plan.sinceMono} planned_ms=${plan.plannedMs}`;
}

// ---- host emulation: transient rejections (11-testing §3.3, F-NET-10) ------------------------------------------------

/** createBareRemote's control file (test/sim/remote.ts): {count, kind, refSubstring}, read by the pre-receive hook. */
const REJECT_CONTROL_FILE = 'remote-control.json';

/** Rejections rejectNext armed that no push has consumed yet (0 without a control file). */
export async function rejectsPending(ctx: Pick<SimContext, 'root'>): Promise<number> {
  let text: string;
  try {
    text = await readFile(join(ctx.root, REJECT_CONTROL_FILE), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw e;
  }
  const count = (JSON.parse(text) as { count?: unknown }).count;
  return typeof count === 'number' && count > 0 ? count : 0;
}

// ---- virtual time ------------------------------------------------------------------------------------------------------

/** Per run: the harness's clock mover (every peer clock and the scheduler clock) and the scheduler clock. */
const runs = new WeakMap<SimContext, { advance(ms: number): void; schedClock: VirtualClock }>();

function runOf(ctx: SimContext): { advance(ms: number): void; schedClock: VirtualClock } {
  const r = runs.get(ctx);
  if (r === undefined) throw new Error('not the SimContext of a running runSim');
  return r;
}

/** Virtual time passes as between two harness steps: every peer clock and the scheduler clock move `ms`. */
export function advanceClocks(ctx: SimContext, ms: number): void {
  runOf(ctx).advance(ms);
}

/** The scheduler clock's mono (it runs ahead of the peer clocks when a drained task was scheduled in their future). */
export function schedulerMonoMs(ctx: SimContext): number {
  return runOf(ctx).schedClock.monoMs();
}

// ---- oracles and artifacts ---------------------------------------------------------------------------------------

async function firstFailure(
  oracles: Oracle[],
  phase: 'afterEveryOp' | 'atQuiescence',
  ctx: SimContext,
  step: number,
): Promise<SimResult['failure'] | undefined> {
  for (const o of oracles) {
    const check = o[phase];
    if (check === undefined) continue;
    const message = await check.call(o, ctx);
    if (message !== null) return { oracle: o.name, message, step };
  }
  return undefined;
}

async function copyOrEmpty(from: string, to: string): Promise<void> {
  try {
    await copyFile(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    await writeFile(to, Buffer.alloc(0));
  }
}

const jsonl = (rows: readonly unknown[]): Buffer => Buffer.from(rows.map((e) => `${JSON.stringify(e)}\n`).join(''), 'utf8');

/**
 * Writes <root>/artifacts: op-log.jsonl, trace.jsonl (every TraceRecorder event, in emission order), remote-log.jsonl
 * and reftx-log.jsonl (copies of the Task 11 hook logs, empty when the hook never ran) and remote.bundle (`git bundle
 * create --all` of the bare remote, healed first; remote.bundle.err.txt instead when git refuses, e.g. for an empty
 * remote).
 */
async function keepArtifacts(root: string, git: GitRunner, remote: BareRemote | undefined, opLog: OpLogEntry[], trace: TraceRecorder): Promise<string> {
  const dir = join(root, 'artifacts');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'op-log.jsonl'), jsonl(opLog));
  await writeFile(join(dir, 'trace.jsonl'), jsonl(trace.events));
  await copyOrEmpty(join(root, 'remote-log.jsonl'), join(dir, 'remote-log.jsonl'));
  await copyOrEmpty(join(root, 'reftx-log.jsonl'), join(dir, 'reftx-log.jsonl'));
  if (remote !== undefined) {
    await healRemote({ remote }).catch(() => false);
    const b = await git.run(['bundle', 'create', '-q', join(dir, 'remote.bundle'), '--all'], { class: 'local', cwd: remote.dir });
    if (b.code !== 0) await writeFile(join(dir, 'remote.bundle.err.txt'), b.stderr);
  }
  return dir;
}

/** The remote board tip: the oid of the one ref ending in '/board' (several: their oids joined by ','), or null. */
async function boardTip(remote: BareRemote): Promise<string | null> {
  const refs = await remote.refs();
  const boards = Object.keys(refs).filter((r) => r.endsWith('/board')).sort();
  return boards.length === 0 ? null : boards.map((r) => refs[r]).join(',');
}

/**
 * The peer names (through trace.names) whose successful `fetch` event emitted at or after `mark` fetched `tip`: its board
 * value is the tip, or one of the tips boardTip joined with ',' (absent = null on both sides).
 */
function observersOf(trace: TraceRecorder, mark: number, tip: string | null): Set<string> {
  const boards = new Set<string | null>(tip === null ? [null] : tip.split(','));
  const out = new Set<string>();
  for (const ev of trace.since(mark)) {
    if (ev.kind !== 'fetch' || !ev.ok || !boards.has(ev.board)) continue;
    const name = trace.names.get(ev.peer);
    if (name !== undefined) out.add(name);
  }
  return out;
}

function checkOptions(opts: SimOptions | undefined): void {
  const q = opts?.quiescence;
  if (q !== undefined) {
    for (const [k, v] of Object.entries(q)) {
      if (!Number.isSafeInteger(v) || v < (k === 'extraLoops' ? 0 : 1)) throw new Error(`runSim: quiescence.${k} must be an integer >= ${k === 'extraLoops' ? 0 : 1}, got ${String(v)}`);
    }
  }
  const rate = opts?.crash?.rate;
  if (rate !== undefined && !(rate >= 0 && rate <= 1)) throw new Error(`runSim: crash.rate must be in [0, 1], got ${rate}`);
}

export async function runSim(t: SeedTuple, makeEngine: EngineFactory, oracles: Oracle[], opts?: SimOptions): Promise<SimResult> {
  if (!Number.isInteger(t.peers) || t.peers < 1) throw new Error(`runSim: peers must be a positive integer, got ${t.peers}`);
  if (!Number.isInteger(t.ops) || t.ops < 0) throw new Error(`runSim: ops must be a non-negative integer, got ${t.ops}`);
  checkOptions(opts);
  const { root, cleanup } = await makeTempRoot('sim');
  const git = testRunner();
  const opLog: OpLogEntry[] = [];
  let remote: BareRemote | undefined;
  const trace = new TraceRecorder();
  let keep = false;
  const crash = opts?.crash;
  /** The peer whose next crashpoint throws (armed), and the peer whose engine step the harness is running (active). */
  let armed: string | null = null;
  let active: string | null = null;
  // The caller's handler is put back when the run ends.
  const callerHandler = crash === undefined ? null : setCrashHandler((name) => {
    if (armed !== null && active === armed) {
      armed = null;
      throw new KilledAt(name);
    }
  });
  try {
    const random = seededRandom(`${t.seed}/sim`);
    const schedClock = new VirtualClock();
    const scheduler = new VirtualScheduler(schedClock, seededRandom(`${t.seed}/scheduler`));

    remote = await createBareRemote(root, git, 'main');
    await seedRemote(remote, root, git, opts?.seedFiles ?? SEED_FILES);

    const peers: PeerClone[] = [];
    const clocks = new Map<string, VirtualClock>();
    for (let i = 0; i < t.peers; i++) {
      const name = `p${i}`;
      // Odd peers use the Windows checkout profile (core.autocrlf=true), 11-testing §3.3 setup 3.
      const profile = opts?.peerProfile?.(i) ?? { autocrlf: i % 2 === 1, withFilter: false };
      peers.push(await clonePeer(remote, root, { name, autocrlf: profile.autocrlf, withFilter: profile.withFilter }, git));
      // wallOffsetMs is an offset from SIM_WALL_EPOCH_MS (VirtualClock adds the epoch itself).
      const skewMs = (randomInt(random, 2 * MAX_SKEW_S + 1) - MAX_SKEW_S) * 1000;
      const driftPpm = randomInt(random, 2 * MAX_DRIFT_PPM + 1) - MAX_DRIFT_PPM;
      clocks.set(name, new VirtualClock({ wallOffsetMs: skewMs, driftPpm }));
    }

    const ctx: SimContext = {
      root, remote, peers, git, random, clocks, scheduler, opLog,
      seed: t.seed, engines: [], trace, phase: 'ops', quiescence: null,
    };
    const advance = (ms: number): void => {
      for (const c of clocks.values()) c.advance(ms);
      schedClock.advance(ms);
    };
    runs.set(ctx, { advance, schedClock });
    const engines = peers.map((p) => makeEngine(ctx, p));
    ctx.engines.push(...engines);
    /** The harness's own heal (at the end of the op budget and of the run), with the outage it ended. */
    const forcedHeal = async (step: number): Promise<void> => {
      const plan = partitionPlan(ctx);
      if (await healRemote(ctx)) opLog.push({ step, peer: '*', kind: 'heal', detail: `forced ${healDetail(plan, schedClock.monoMs())}`.trimEnd() });
    };
    const stepEngine = async (engine: SimEngine): Promise<void> => {
      active = engine.peer.name;
      try {
        await engine.step(ctx);
      } finally {
        active = null;
      }
    };
    const drain = async (step: number): Promise<void> => {
      await scheduler.runUntilIdle(MAX_TASKS_PER_STEP);
      if (scheduler.pending() > 0) throw new Error(`scheduler still has ${scheduler.pending()} tasks after step ${step}`);
    };
    const maybeArm = (step: number): void => {
      if (crash === undefined) return;
      const hit = randomInt(random, CRASH_SCALE) < Math.round(crash.rate * CRASH_SCALE);
      if (!hit || armed !== null) return;
      const name = (peers[randomInt(random, peers.length)] as PeerClone).name;
      armed = name;
      opLog.push({ step, peer: name, kind: 'crash_armed', detail: '' });
    };

    const generator = opts?.generator;
    let failure: SimResult['failure'] | undefined;
    for (let step = 0; step < t.ops && failure === undefined; step++) {
      if (generator === undefined) {
        // The Plan 1 step (draw order: peer, then dt).
        const i = randomInt(random, engines.length);
        const engine = engines[i] as SimEngine;
        const dt = STEP_MIN_MS + randomInt(random, STEP_SPREAD_MS + 1);
        advance(dt);
        maybeArm(step);
        // The 'step' entry comes first so the engine can read its step number from the op-log tail.
        opLog.push({ step, peer: engine.peer.name, kind: 'step', detail: `dt=${dt}` });
        await stepEngine(engine);
      } else {
        const dt = STEP_MIN_MS + randomInt(random, STEP_SPREAD_MS + 1);
        advance(dt);
        maybeArm(step);
        const op = generator.next(ctx, step);
        if (op === null) {
          const engine = engines[randomInt(random, engines.length)] as SimEngine;
          opLog.push({ step, peer: engine.peer.name, kind: 'step', detail: `dt=${dt}` });
          await stepEngine(engine);
        } else {
          // Logged before it runs, so anything the operation logs follows it; its detail is filled in afterwards.
          const entry: OpLogEntry = { step, peer: op.peer, kind: op.kind, detail: `dt=${dt}` };
          opLog.push(entry);
          const detail = await op.run(ctx);
          if (detail !== '') entry.detail = `dt=${dt} ${detail}`;
        }
      }
      await drain(step);
      failure = await firstFailure(oracles, 'afterEveryOp', ctx, step);
    }

    let next = t.ops;
    // Crashes end with the operation budget too: one still armed never fires in a quiescence or extra round.
    if (armed !== null) {
      opLog.push({ step: next, peer: armed, kind: 'crash_disarmed', detail: '' });
      armed = null;
    }
    let quiescence: QuiescenceInfo | undefined;
    const q = opts?.quiescence;
    if (failure === undefined && q !== undefined) {
      // Faults end with the operation budget: the remote is reachable and accepts pushes again.
      await forcedHeal(next);
      await remote.clearRejects();
      const byName = [...engines].sort((a, b) => (a.peer.name < b.peer.name ? -1 : a.peer.name > b.peer.name ? 1 : 0));
      const totalPushes = (): number => engines.reduce((s, e) => s + (e.pushAttempts?.() ?? 0), 0);
      let tip = await boardTip(remote);
      const round = async (): Promise<SimResult['failure'] | undefined> => {
        const step = next++;
        advance(q.loopMs);
        opLog.push({ step, peer: '*', kind: 'round', detail: `${ctx.phase} tip=${tip ?? '-'}` });
        for (const e of byName) await stepEngine(e);
        await drain(step);
        return firstFailure(oracles, 'afterEveryOp', ctx, step);
      };
      ctx.phase = 'quiescence';
      let rounds = 0;
      // R-32 as amended (02-protocol §3.11): K counts a peer's iterations since it OBSERVED the tip — a successful
      // fetch of it in a quiescence round, i.e. after the forced heal — and restarts at every tip change. A peer still in
      // network backoff has observed nothing yet, so it is not quiescent. `since` counts rounds since the tip last
      // changed: the rule for a peer whose engine registers no trace name (a stub that emits no fetch event).
      let since = 0;
      let lastChange = 0;
      const observed = new Map<string, number>();
      let reached = false;
      while (failure === undefined && rounds < q.maxRounds) {
        rounds++;
        const mark = trace.events.length;
        failure = await round();
        const now = await boardTip(remote);
        if (now !== tip) {
          tip = now;
          since = 0;
          lastChange = rounds;
          observed.clear();
        } else {
          since++;
          for (const [name, n] of observed) observed.set(name, n + 1);
        }
        for (const name of observersOf(trace, mark, tip)) if (!observed.has(name)) observed.set(name, 0);
        const tracked = new Set(trace.names.values());
        if (byName.every((e) => (tracked.has(e.peer.name) ? (observed.get(e.peer.name) ?? -1) : since) >= q.k)) {
          reached = true;
          break;
        }
      }
      quiescence = { reached, tStar: reached ? tip : null, rounds, pushAttemptsInExtra: 0, boardChangedInExtra: false };
      if (failure === undefined && !reached) {
        // The per-peer rule above, in words: which peers stayed short of K, and why (never observed the tip, or too few
        // rounds since they did; an untracked peer counts from the tip's last change).
        const tracked = new Set(trace.names.values());
        const short = byName.flatMap((e) => {
          const name = e.peer.name;
          if (!tracked.has(name)) return since >= q.k ? [] : [`${name} (${since} of ${q.k} rounds since the tip last changed)`];
          const n = observed.get(name);
          if (n === undefined) return [`${name} (never observed it)`];
          return n >= q.k ? [] : [`${name} (${n} of ${q.k} rounds since it observed it)`];
        });
        failure = {
          oracle: 'QUIESCENCE',
          message: `no quiescence within ${q.maxRounds} rounds: R-32 needs every peer to run K = ${q.k} rounds after it observed the board tip `
            + `(tip ${tip ?? '-'}, last changed in round ${lastChange}); short of K: ${short.join(', ')}`,
          step: next,
        };
      }
      if (failure === undefined) {
        ctx.phase = 'extra';
        const tStar = tip;
        const before = totalPushes();
        let changed = false;
        for (let x = 0; x < q.extraLoops && failure === undefined; x++) {
          failure = await round();
          if ((await boardTip(remote)) !== tStar) changed = true;
        }
        quiescence = { ...quiescence, pushAttemptsInExtra: totalPushes() - before, boardChangedInExtra: changed };
      }
      ctx.quiescence = quiescence;
    }
    if (failure === undefined) failure = await firstFailure(oracles, 'atQuiescence', ctx, next);

    await forcedHeal(next);
    const remoteRefs = await remote.refs();
    const extra = quiescence !== undefined ? { quiescence } : {};
    if (failure === undefined) return { ok: true, opLog, remoteRefs, ...extra };
    keep = true;
    const artifactsDir = await keepArtifacts(root, git, remote, opLog, trace);
    return { ok: false, failure, opLog, remoteRefs, artifactsDir, ...extra };
  } catch (e) {
    // A thrown engine/fixture error is a failure too: keep the root and say where it is.
    keep = true;
    const where = await keepArtifacts(root, git, remote, opLog, trace).catch(() => root);
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`runSim(${t.seed}): ${message}; artifacts kept in ${where}`, { cause: e });
  } finally {
    if (crash !== undefined) setCrashHandler(callerHandler);
    if (!keep) await cleanup();
  }
}
