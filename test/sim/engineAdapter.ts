// The real Engine as a SimEngine (Plan 2 Task 18; 11-testing §3.3 setup step 4 and run steps 2 and 4; TST-02, TST-03).
// Per peer: an Engine bound to the peer's VirtualClock, ctx.scheduler, seededRandom(`${seed}/${peer}`), a FaultFs over
// the real disk, ctx.git, ctx.trace, alwaysLeased, humanOnlyAttribution, heartbeatMs = clock.monoMs, url =
// ctx.remote.url and testBuild true, holding the peer's daemon.lock (as `daemon.js run` does: start, restart and every
// own-leftover deletion run only under it) and logging to <coworkDir>/log/daemon-0.jsonl in fileLog's format (restart
// reads the orphan lines there).
//
// The adapter drives the engine only through its contract: Engine.create, start(), iterate(), inspect() and the
// EngineCore push counter. A peer's first step is start() (Table 3.3-A: genesis, join or restart); later steps are
// iterate(). A KilledAt ends the step: the engine is dropped (the process died) and the next step acquires the lock
// again, re-creates the Engine from disk and start()s it, which is a RESTART. A process that dies leaves what a killed
// process leaves, drawn from seededRandom(`${seed}/crash`): about 1 kill in 4 leaves its daemon.lock behind (the
// restart takes the stale lock over), and about 1 in 4 loses a tail of the log lines it had queued but not written.
//
// Start refusals (ruling R-SIM-01): START_REMOTE{unreachable | genesis_push_failed} is retried at the peer's next step
// only while the remote is partitioned or a transient rejection is pending (or was pending when the attempt began: the
// attempt may have consumed the last one); once neither holds, a peer still unstarted 2 steps later fails the run.
// Every other refusal throws at once.
//
// The human-typed recover (Task 19): RecoverableSimEngine.recover(ctx) is `/cowork recover` then `--confirm=<id>` on the
// peer's running Engine (its public verb, under its daemon.lock, in its own queue: what `daemon.js` does with an
// in-daemon recover request); a dead engine boots first, as the peer's next step would; a KilledAt ends it like a step.
//
// Determinism: the peer's Random is created once and kept across re-creations (re-seeding would replay the same
// bytes: the same orphan ULIDs, P2-ORPHANNAMES); the log is written at the end of every step, so no file write of a
// step outlives it; nothing here reads real time or Math.random.
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { humanOnlyAttribution, PLAN2_REGION_SPEC, type EngineDeps, type MutantId } from '../../src/engine/deps.js';
import { DaemonLock, Engine, type EngineInspection } from '../../src/engine/loop.js';
import type { RecoverResult } from '../../src/engine/recover.js';
import { RELEASE_NAMESPACE, type RefNamespace } from '../../src/engine/refs.js';
import type { Clock } from '../../src/ports/clock.js';
import { KilledAt } from '../../src/ports/crashpoint.js';
import { realFs, type Fs } from '../../src/ports/fs.js';
import { alwaysLeased } from '../../src/ports/lease.js';
import { fileLog, type Log, type LogLevel, type LogParam } from '../../src/ports/log.js';
import { randomInt, seededRandom, type Random } from '../../src/ports/random.js';
import { PLUGIN_VERSION } from '../../src/version.js';
import { FaultFs } from './faultfs.js';
import { recordGitCalls } from './gitCalls.js';
import { rejectsPending, remotePartitioned, type EngineFactory, type SimContext, type SimEngine } from './harness.js';
import type { PeerClone } from './peers.js';

/** publishLocal defaults to 'all' (an edit op may precede a peer's first step). */
export interface RealEngineOptions { publishLocal?: 'all' | 'none'; mutants?: ReadonlySet<MutantId>; namespace?: RefNamespace; }

/** A SimEngine that also takes the human-typed `/cowork recover` (the real engine's adapter). */
export interface RecoverableSimEngine extends SimEngine {
  /**
   * `/cowork recover` (a preview), then `--confirm=<its id>` when the preview is not already done, on the running Engine;
   * a dead engine boots first (a RESTART, as the peer's next step would; a refused or killed boot runs no recover). A
   * KilledAt ends the call as it ends a step. Returns every result, in order (empty when no recover ran).
   */
  recover(ctx: SimContext): Promise<RecoverResult[]>;
}

export function isRecoverable(e: SimEngine): e is RecoverableSimEngine {
  return typeof (e as Partial<RecoverableSimEngine>).recover === 'function';
}

const BRANCH = 'main';
const PLUGIN_SHA = 'f'.repeat(64);
/** START_REMOTE reasons a later step retries while the remote is partitioned or rejecting (R-SIM-01). */
const RETRIED_START: ReadonlySet<string> = new Set(['unreachable', 'genesis_push_failed']);
/** R-SIM-01: a peer still unstarted this many of its steps after the partition healed or the rejections ran out fails. */
const GRACE_STEPS = 2;
/** About 1 kill in KEEP_LOCK_ONE_IN leaves daemon.lock behind; about 1 in DROP_LOG_ONE_IN loses a queued log tail. */
const KEEP_LOCK_ONE_IN = 4;
const DROP_LOG_ONE_IN = 4;

/** Lets every pending microtask run (fileLog hands each line to its Fs on a promise chain of microtasks). */
const settle = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * fileLog itself (its line format and call order) over an in-memory queue: flush() appends every queued line to the
 * log file through the peer's Fs; a killed process may lose a tail of them first (die()).
 */
class SimLog implements Log {
  private readonly inner: Log;
  private queued: Buffer[] = [];

  constructor(private readonly fs: Fs, clock: Clock, private readonly file: string) {
    const queue: Fs = { ...realFs, appendFile: async (_p: string, data: Buffer): Promise<void> => { this.queued.push(data); } };
    this.inner = fileLog(queue, clock, file);
  }

  write(level: LogLevel, code: string, params?: Readonly<Record<string, LogParam>>): void {
    this.inner.write(level, code, params);
  }

  /** Every line written so far, on disk (an append failure drops the lines, as fileLog drops a line). */
  async flush(): Promise<void> {
    await settle();
    const lines = this.queued;
    this.queued = [];
    if (lines.length > 0) await this.fs.appendFile(this.file, Buffer.concat(lines)).catch(() => undefined);
  }

  /** A killed process: with `drop`, only a drawn head of the queued lines reaches the disk. Returns the op-log note. */
  async die(r: Random, drop: boolean): Promise<string> {
    await settle();
    let note = 'flushed';
    if (drop) {
      const keep = this.queued.length === 0 ? 0 : randomInt(r, this.queued.length);
      note = `dropped:${this.queued.length - keep}`;
      this.queued = this.queued.slice(0, keep);
    }
    await this.flush();
    return note;
  }
}

/** One Random per run for what killed processes leave behind (never ctx.random: crash runs keep their op draws). */
const crashRandoms = new WeakMap<SimContext, Random>();
function crashRandom(ctx: SimContext): Random {
  let r = crashRandoms.get(ctx);
  if (r === undefined) {
    r = seededRandom(`${ctx.seed}/crash`);
    crashRandoms.set(ctx, r);
  }
  return r;
}

class RealSimEngine implements RecoverableSimEngine {
  readonly peer: PeerClone;
  private readonly deps: EngineDeps;
  private readonly log: SimLog;
  private readonly publishLocal: 'all' | 'none';
  private engine: Engine | null = null;
  private lock: DaemonLock | null = null;
  /** Lock instance ids: one per acquisition (one per daemon process). */
  private generation = 0;
  /** Push attempts of the engines this peer dropped (EngineCore.pushAttempts restarts at 0 in a new core). */
  private pushBase = 0;
  /** R-SIM-01: refused steps left before an unstarted peer fails, once a retried refusal's reason is gone (0: none). */
  private graceLeft = 0;

  constructor(ctx: SimContext, peer: PeerClone, opts: RealEngineOptions) {
    this.peer = peer;
    this.publishLocal = opts.publishLocal ?? 'all';
    const clock = ctx.clocks.get(peer.name);
    if (clock === undefined) throw new Error(`realEngine: no clock for ${peer.name}`);
    const fs = new FaultFs(realFs);
    const workTree = realpathSync.native(peer.dir);
    const paths = { workTree, gitDir: join(workTree, '.git'), coworkDir: join(workTree, '.git', 'cowork') };
    this.log = new SimLog(fs, clock, join(paths.coworkDir, 'log', 'daemon-0.jsonl'));
    this.deps = {
      ports: { clock, random: seededRandom(`${ctx.seed}/${peer.name}`), scheduler: ctx.scheduler, fs, git: ctx.git },
      trace: ctx.trace, log: this.log, lease: alwaysLeased, attribution: humanOnlyAttribution,
      heartbeatMs: () => clock.monoMs(),
      paths, branch: BRANCH, namespace: opts.namespace ?? RELEASE_NAMESPACE, url: ctx.remote.url, display: `Peer ${peer.name}`,
      pluginVersion: PLUGIN_VERSION, pluginSha: PLUGIN_SHA, regionSpec: PLAN2_REGION_SPEC,
      platform: process.platform, testBuild: true, testMutants: opts.mutants ?? new Set(),
    };
  }

  async step(ctx: SimContext): Promise<void> {
    await this.run(ctx, async (at) => {
      if (this.engine === null) await this.boot(ctx, at);
      else await this.engine.iterate();
    });
  }

  async recover(ctx: SimContext): Promise<RecoverResult[]> {
    const out: RecoverResult[] = [];
    await this.run(ctx, async (at) => {
      if (this.engine === null) await this.boot(ctx, at);
      const engine = this.engine;
      if (engine === null) return;   // the boot was refused (retried at the peer's next step)
      const preview = await engine.recover(null);
      out.push(preview);
      if (preview.ok && !preview.done) out.push(await engine.recover(preview.preview.id));
    });
    return out;
  }

  /** One engine call as one daemon process step: a KilledAt ends it (the process died), anything else is thrown. */
  private async run(ctx: SimContext, body: (at: number) => Promise<void>): Promise<void> {
    const at = ctx.opLog[ctx.opLog.length - 1]?.step ?? -1;
    let killed: KilledAt | null = null;
    try {
      await body(at);
    } catch (e) {
      if (!(e instanceof KilledAt)) {
        await this.log.flush();
        throw e;
      }
      killed = e;
    }
    if (killed === null) await this.log.flush();
    else await this.die(ctx, at, killed.point);
  }

  async inspect(): Promise<EngineInspection> {
    if (this.engine === null) throw new Error(`realEngine ${this.peer.name}: no running engine (not started, or killed and not restarted yet)`);
    return this.engine.inspect();
  }

  pushAttempts(): number {
    return this.pushBase + (this.engine?.core.pushAttempts ?? 0);
  }

  /** daemon.lock, a new Engine from disk, start(). */
  private async boot(ctx: SimContext, at: number): Promise<void> {
    const { fs } = this.deps.ports;
    const { coworkDir } = this.deps.paths;
    const rejectsBefore = await rejectsPending(ctx);
    if (this.lock === null) {
      // Every SIM daemon of this peer shares this process's pid and none runs while the adapter boots one, so a
      // daemon.lock naming this pid was left by a killed one: stale, taken over (R-26's dead-holder rule).
      const lock = await DaemonLock.acquire(fs, coworkDir, { pluginVersion: PLUGIN_VERSION, instance: `sim-${this.peer.name}-${++this.generation}` }, (pid) => pid !== process.pid);
      if (!(lock instanceof DaemonLock)) throw new Error(`realEngine ${this.peer.name}: daemon.lock is held by ${JSON.stringify(lock.held)}`);
      this.lock = lock;
    }
    await fs.mkdirp(join(coworkDir, 'log'));
    const engine = await Engine.create(this.deps);
    ctx.trace.names.set(engine.peerId, this.peer.name);
    this.engine = engine;
    const r = await engine.start({ publishLocal: this.publishLocal });
    if (r.ok) {
      this.graceLeft = 0;
      ctx.opLog.push({ step: at, peer: this.peer.name, kind: 'start', detail: `${r.mode} ${this.lock.holder.instance}` });
      return;
    }
    // The daemon exits with its refusal (lock released); a retried one is run again at the peer's next step.
    this.drop();
    await this.releaseLock();
    const refused = `start refused ${r.code} ${JSON.stringify(r.params)}`;
    const reason = r.params['reason'];
    if (r.code !== 'START_REMOTE' || typeof reason !== 'string' || !RETRIED_START.has(reason)) {
      throw new Error(`realEngine ${this.peer.name}: ${refused}`);
    }
    let note: string;
    if ((await remotePartitioned(ctx)) || rejectsBefore > 0 || (await rejectsPending(ctx)) > 0) {
      this.graceLeft = GRACE_STEPS;
      note = 'retry';
    } else if (this.graceLeft > 1) {
      this.graceLeft -= 1;
      note = `grace=${this.graceLeft}`;
    } else if (this.graceLeft === 1) {
      throw new Error(`realEngine ${this.peer.name}: still not started ${GRACE_STEPS} steps after the partition healed or the transient rejections ran out: ${refused}`);
    } else {
      throw new Error(`realEngine ${this.peer.name}: ${refused}`);
    }
    ctx.opLog.push({ step: at, peer: this.peer.name, kind: 'start_refused', detail: `${r.code} ${reason} ${note}` });
  }

  /** A KilledAt: the process died, so its engine is gone; its daemon.lock and its queued log tail may be left behind. */
  private async die(ctx: SimContext, at: number, point: string): Promise<void> {
    const instance = this.lock?.holder.instance ?? '-';
    this.drop();
    const r = crashRandom(ctx);
    const keepLock = randomInt(r, KEEP_LOCK_ONE_IN) === 0;
    const dropLog = randomInt(r, DROP_LOG_ONE_IN) === 0;
    const log = await this.log.die(r, dropLog);
    if (keepLock && this.lock !== null) {
      this.lock.abandon();   // the file stays: a stale lock naming a dead daemon; the dead process's memory is gone too
      this.lock = null;
    }
    else await this.releaseLock();
    ctx.opLog.push({ step: at, peer: this.peer.name, kind: 'killed', detail: `${point} ${instance} lock=${keepLock ? 'kept' : 'released'} log=${log}` });
  }

  private drop(): void {
    if (this.engine !== null) this.pushBase += this.engine.core.pushAttempts;
    this.engine = null;
  }

  private async releaseLock(): Promise<void> {
    const lock = this.lock;
    this.lock = null;
    if (lock !== null) await lock.release();
  }
}

/**
 * Per peer: Engine bound to the peer VirtualClock, ctx.scheduler, seededRandom(`${seed}/${peer}`), FaultFs(realFs), ctx.git,
 * ctx.trace, alwaysLeased, humanOnlyAttribution, heartbeatMs = clock.monoMs, url = ctx.remote.url, testBuild true. First
 * step: start(); a refusal throws, except START_REMOTE{unreachable | genesis_push_failed} while the remote is partitioned
 * or a transient rejection is pending, which the peer's next step retries (ruling R-SIM-01; still unstarted 2 steps
 * after the partition healed or the rejections ran out, the run fails). Later: iterate(). A KilledAt ends the step; the
 * next step re-creates the Engine from disk (RESTART). The run's git calls are recorded from here on (gitCalls.ts).
 */
export function realEngine(opts?: RealEngineOptions): EngineFactory {
  const o = opts ?? {};
  return (ctx: SimContext, peer: PeerClone): SimEngine => {
    recordGitCalls(ctx.git);   // INV-OID's fault clause judges every engine git call, from the first step on
    return new RealSimEngine(ctx, peer, o);
  };
}
