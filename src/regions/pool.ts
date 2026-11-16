// The region worker pool (04-regions §3.1, §3.18, §6 "worker crashes"; REG-31; rulings R4-12…R4-15, X-21, X-37).
// RegionWorkers is a port: production binds threadWorkers (two worker_threads, fg and bg, running dist/worker.js with
// the .wasm bytes posted at spawn), unit tests and SIM bind inlineWorkers (src/regions/worker/inline.ts). One queue
// orders jobs fg > save > bg; fg jobs run only on fg, save and bg jobs run on bg and on fg while fg is idle.
// This is the only src/regions module that imports node:worker_threads (L-REGION-DEPS).
import { Worker } from 'node:worker_threads';
import type { Clock } from '../ports/clock.js';
import { BUDGETS, type Deadline } from './budgets.js';
import type { OverlapClaim } from './foldOverlap.js';
import type { SiteSet } from './interface.js';
import { LANGUAGES, type RegionRuntime } from './runtime.js';
import type { BlobRef, Hunk, Label, Language, MapMode, MapResult, Ranges, TableOrNone } from './types.js';
import type { FromWorker, ToWorker, WorkerInit } from './worker/protocol.js';

export type WorkerPriority = 'fg' | 'save' | 'bg';
export type RegionJob =
  | { kind: 'table'; lang: Language | null; cls: 4 | 6; ref: BlobRef; bytes: Buffer; regionSpec: string; prevRef: BlobRef | null }   // Task 4 (prevRef: a live tree for incremental re-parse, T_predict)
  | { kind: 'hunks'; from: readonly Buffer[]; to: readonly Buffer[] }                                                                 // Task 3
  | { kind: 'map'; from: readonly Buffer[]; to: readonly Buffer[]; ranges: Ranges; mode: MapMode }                                    // Task 3
  | { kind: 'fold_overlap'; pairs: ReadonlyArray<{ c1: OverlapClaim; c2: OverlapClaim }>; lines: ReadonlyMap<string, readonly Buffer[]> }   // Task 8
  | { kind: 'sites'; lang: Language; ref: BlobRef; bytes: Buffer; names: readonly string[] }                                         // Task 7 (calls, imports, identifiers with rows)
  | { kind: 'label_at'; lang: Language; ref: BlobRef; bytes: Buffer; line: number; regionSpec: string };                             // Task 13
/** Per kind: table → TableOrNone; hunks → Hunk[]; map → MapResult; fold_overlap → boolean[]; sites → SiteSet; label_at → Label | null. */
export type JobOutput<J extends RegionJob> = J extends { kind: 'table' } ? TableOrNone : J extends { kind: 'hunks' } ? Hunk[] : J extends { kind: 'map' } ? MapResult : J extends { kind: 'fold_overlap' } ? boolean[] : J extends { kind: 'sites' } ? SiteSet : Label | null;
export type JobResult<J extends RegionJob> = { kind: 'ok'; value: JobOutput<J> } | { kind: 'deadline' } | { kind: 'crashed' };
export interface RegionWorkers {
  run<J extends RegionJob>(job: J, priority: WorkerPriority, deadline: Deadline | null): Promise<JobResult<J>>;
  /** Per-language grammar load status (REGION_GRAMMAR_UNAVAILABLE; Plan 7's doctor row). */
  availability(): ReadonlyMap<Language, 'ok' | 'unavailable'>;
  close(): Promise<void>;
}

const CRASHED: { readonly kind: 'crashed' } = Object.freeze({ kind: 'crashed' });
const DEADLINE: { readonly kind: 'deadline' } = Object.freeze({ kind: 'deadline' });
const ALL_UNAVAILABLE: ReadonlyMap<Language, 'ok' | 'unavailable'> = new Map(LANGUAGES.map((l) => [l, 'unavailable'] as const));

/** The WorkerInit of one spawn: fresh copies of the runtime and grammar bytes (threadWorkers transfers them, R4-12). */
export function workerInitOf(runtime: RegionRuntime, name: 'fg' | 'bg', generation: number): WorkerInit {
  return {
    name,
    generation,
    runtimeWasm: new Uint8Array(runtime.runtimeWasm),
    grammars: LANGUAGES.map((l) => [l, new Uint8Array(runtime.grammars.get(l) ?? new Uint8Array(0))] as const),
  };
}

/** Which classes each worker takes, in order (R4-13): fg serves fg jobs first, then save and bg work while idle; bg never takes an fg job. */
const TAKES: Readonly<Record<'fg' | 'bg', readonly WorkerPriority[]>> = Object.freeze({ fg: ['fg', 'save', 'bg'], bg: ['save', 'bg'] });

/** R4-13's dispatch rule, unit-tested without threads: fg > save > bg, FIFO within a class; next('bg') never returns an fg job; an idle fg worker takes save/bg work. */
export class JobQueue {
  private readonly lanes: Readonly<Record<WorkerPriority, Array<{ id: number; job: RegionJob; priority: WorkerPriority }>>> = { fg: [], save: [], bg: [] };
  private lastId = 0;

  push(job: RegionJob, priority: WorkerPriority): number {
    if (!Object.hasOwn(this.lanes, priority)) throw new TypeError(`JobQueue.push: unknown priority ${String(priority)}`);
    const id = ++this.lastId;
    this.lanes[priority].push({ id, job, priority });
    return id;
  }

  next(worker: 'fg' | 'bg'): { id: number; job: RegionJob; priority: WorkerPriority } | null {
    if (!Object.hasOwn(TAKES, worker)) throw new TypeError(`JobQueue.next: unknown worker ${String(worker)}`);
    for (const p of TAKES[worker]) {
      const e = this.lanes[p].shift();
      if (e !== undefined) return e;
    }
    return null;
  }

  get size(): number {
    return this.lanes.fg.length + this.lanes.save.length + this.lanes.bg.length;
  }
}

interface Pending {
  readonly id: number;
  readonly priority: WorkerPriority;
  readonly job: RegionJob;
  readonly deadline: Deadline | null;
  settled: boolean;
  readonly resolve: (r: JobResult<RegionJob>) => void;
}

/** How many times in a row a respawned generation (1 and later) that exits before its ready message is retried; the next such exit fails the slot. */
const PRE_READY_RETRIES = 3;

/** A pool slot: one named worker across its generations. */
interface Slot {
  readonly name: 'fg' | 'bg';
  generation: number;
  worker: Worker | null;
  /** starting: spawned (or waiting to retry a spawn), no ready message yet; stopping: being terminated (a crashed result or a stall);
   *  failed: generation 0 exited before its ready message, or a respawn still did after PRE_READY_RETRIES retries (it never serves again). */
  state: 'starting' | 'idle' | 'busy' | 'stopping' | 'failed' | 'closed';
  running: Pending | null;
  /** This generation posted its ready message. */
  ready: boolean;
  /** The pool terminated this generation after a deadline (respawn cause 'stall'). */
  stalled: boolean;
  /** Respawned generations in a row that exited before their ready message (reset by a ready message). */
  preReadyFailures: number;
  /** The availability of the last generation that posted ready. */
  availability: ReadonlyMap<Language, 'ok' | 'unavailable'>;
}

function isJobResult(r: unknown): r is JobResult<RegionJob> {
  if (typeof r !== 'object' || r === null) return false;
  const kind = (r as { kind?: unknown }).kind;
  return kind === 'deadline' || kind === 'crashed' || (kind === 'ok' && 'value' in r);
}

/** Production: two worker_threads (fg, bg) running dist/worker.js with the .wasm bytes posted at spawn; one queue fg > save > bg; a worker silent BUDGETS.workerGraceMs after a deadline is terminated and respawned (04 §6 "worker crashes").
 *  The pool posts remainingMs (never an absolute time); the main thread races the reply against clock.sleep(deadline.remainingMs()) and resolves {kind: 'deadline'} on expiry.
 *  onRespawn (tests; the daemon logs it as REGION_WORKER_RESPAWN {name, cause}, Task 16, log-only, V-17) is called once per respawn, retries included.
 *  A crashed result replaces its worker (a wasm trap may leave the module unusable, so no worker survives a throw), except the entry's answer to an
 *  unregistered job kind (X-37: no handler ran, the loop goes on, the worker is kept).
 *  Generation 0 exiting before its ready message is not respawned (a bad bundle must not loop). A later generation that exits before its ready message
 *  (a transient spawn failure) is retried up to PRE_READY_RETRIES (3) times in a row, each retry BUDGETS.workerGraceMs on o.clock after the exit and
 *  reported through onRespawn(name, 'crash'); the next such exit fails the slot. A failed slot never serves again: every language reads unavailable,
 *  jobs only it could serve resolve crashed, and onSlotFailed(name) is called once (contract addition, fix round 1: the daemon logs it, Task 16, and so
 *  does not take the unavailable languages for a grammar problem). Resolves once both workers are ready (or failed). */
export async function threadWorkers(runtime: RegionRuntime, o: {
  threads: 2; workerPath: string; clock: Clock; onRespawn?(name: 'fg' | 'bg', cause: 'crash' | 'stall'): void; onSlotFailed?(name: 'fg' | 'bg'): void;
}): Promise<RegionWorkers> {   // threads is always 2 in v1 (fg, bg; R4-13)
  if (o.threads !== 2) throw new RangeError(`threadWorkers: threads must be 2 (fg, bg), got ${String(o.threads)}`);
  const queue = new JobQueue();
  const pending = new Map<number, Pending>();
  const firstStart = new Map<Slot, () => void>();
  let closing = false;
  const newSlot = (name: 'fg' | 'bg'): Slot => ({
    name, generation: 0, worker: null, state: 'starting', running: null, ready: false, stalled: false, preReadyFailures: 0, availability: ALL_UNAVAILABLE,
  });
  const fg = newSlot('fg');
  const bg = newSlot('bg');

  const settle = (p: Pending, r: JobResult<RegionJob>): void => {
    if (p.settled) return;
    p.settled = true;
    pending.delete(p.id);
    p.resolve(r);
  };
  const started = (s: Slot): void => {
    const done = firstStart.get(s);
    if (done !== undefined) {
      firstStart.delete(s);
      done();
    }
  };
  const unservable = (priority: WorkerPriority): boolean =>
    (fg.state === 'failed' && bg.state === 'failed') || (priority === 'fg' && fg.state === 'failed');

  const spawn = (s: Slot): void => {
    const init = workerInitOf(runtime, s.name, s.generation);
    const transferList = [init.runtimeWasm.buffer as ArrayBuffer, ...init.grammars.map(([, b]) => b.buffer as ArrayBuffer)];
    const w = new Worker(o.workerPath, { workerData: init, transferList });
    s.worker = w;
    s.state = 'starting';
    s.running = null;
    s.ready = false;
    s.stalled = false;
    w.on('message', (m: unknown) => onMessage(s, w, m));
    w.on('error', () => {
      // an uncaught error in the worker: its 'exit' event follows and settles the slot
    });
    w.on('exit', () => onExit(s, w));
  };

  const fail = (s: Slot): void => {
    s.state = 'failed';
    s.availability = ALL_UNAVAILABLE;
    for (const p of [...pending.values()]) {
      if (fg.running !== p && bg.running !== p && unservable(p.priority)) settle(p, CRASHED);
    }
    started(s);
    o.onSlotFailed?.(s.name);
  };

  /** The next generation of a slot that served before; a spawn that throws counts as an exit before ready. */
  const respawn = (s: Slot, cause: 'crash' | 'stall'): void => {
    s.generation += 1;
    let spawned = true;
    try {
      spawn(s);
    } catch {
      spawned = false;
      s.worker = null;
    }
    o.onRespawn?.(s.name, cause);
    if (!spawned) exitedBeforeReady(s);
  };

  /** A generation exited before its ready message: generation 0 fails its slot; a respawned one is retried (bounded) after the grace wait. */
  const exitedBeforeReady = (s: Slot): void => {
    if (s.generation === 0 || s.preReadyFailures >= PRE_READY_RETRIES) {
      fail(s);
      return;
    }
    s.preReadyFailures += 1;
    s.state = 'starting';
    void o.clock.sleep(BUDGETS.workerGraceMs).then(() => {
      if (closing) {
        s.state = 'closed';
        return;
      }
      respawn(s, 'crash');
    });
  };

  const onMessage = (s: Slot, w: Worker, m: unknown): void => {
    if (s.worker !== w || typeof m !== 'object' || m === null) return;
    const msg = m as FromWorker;
    if (msg.type === 'ready') {
      s.availability = new Map(msg.availability);
      s.ready = true;
      s.preReadyFailures = 0;
      if (s.state === 'starting') s.state = 'idle';
      started(s);
      pump();
      return;
    }
    if (msg.type === 'result') {
      const p = s.running;
      if (p === null || p.id !== msg.id) return;
      s.running = null;
      const result = isJobResult(msg.result) ? msg.result : CRASHED;
      settle(p, result);
      if (result.kind === 'crashed' && msg.unregistered !== true) {
        // R4-15: no worker survives a throw; its exit respawns the slot (cause 'crash').
        s.state = 'stopping';
        void w.terminate();
        return;
      }
      if (s.state === 'busy') s.state = 'idle';
      pump();
    }
  };

  const onExit = (s: Slot, w: Worker): void => {
    if (s.worker !== w) return;
    s.worker = null;
    const p = s.running;
    s.running = null;
    if (p !== null) settle(p, CRASHED);
    if (closing) {
      s.state = 'closed';
      return;
    }
    if (!s.ready) {
      exitedBeforeReady(s);
      return;
    }
    respawn(s, s.stalled ? 'stall' : 'crash');
  };

  const pump = (): void => {
    if (closing) return;
    // bg first: save and bg work goes to bg before an idle fg takes it, so fg stays free for fg jobs.
    for (const s of [bg, fg]) {
      while (s.state === 'idle' && s.worker !== null) {
        const q = queue.next(s.name);
        if (q === null) break;
        const p = pending.get(q.id);
        if (p === undefined || p.settled) continue;
        if (p.deadline !== null && p.deadline.expired()) {
          settle(p, DEADLINE);
          continue;
        }
        const msg: ToWorker = { type: 'job', id: p.id, job: p.job, remainingMs: p.deadline === null ? null : p.deadline.remainingMs() };
        s.running = p;
        s.state = 'busy';
        try {
          s.worker.postMessage(msg);
        } catch {
          // a job that cannot be posted (not structured-cloneable) never reaches the worker
          s.running = null;
          s.state = 'idle';
          settle(p, CRASHED);
        }
      }
    }
  };

  /** R4-15: resolve {kind:'deadline'} at the deadline; terminate the worker still running the job BUDGETS.workerGraceMs later. */
  const watchDeadline = async (p: Pending, d: Deadline): Promise<void> => {
    while (!p.settled && !d.expired()) await o.clock.sleep(Math.max(1, d.remainingMs()));
    if (p.settled) return;
    settle(p, DEADLINE);
    const s = fg.running === p ? fg : bg.running === p ? bg : null;
    if (s === null) return;   // still queued: pump drops it when it comes up
    const w = s.worker;
    const from = o.clock.monoMs();
    for (;;) {
      if (closing || s.running !== p || s.worker !== w || w === null) return;
      const left = BUDGETS.workerGraceMs - (o.clock.monoMs() - from);
      if (left <= 0) break;
      await o.clock.sleep(left);
    }
    s.stalled = true;
    s.state = 'stopping';
    void w.terminate();
  };

  await Promise.all([fg, bg].map((s) => new Promise<void>((resolve) => {
    firstStart.set(s, resolve);
    try {
      spawn(s);
    } catch {
      fail(s);
    }
  })));

  return {
    run<J extends RegionJob>(job: J, priority: WorkerPriority, deadline: Deadline | null): Promise<JobResult<J>> {
      if (closing || unservable(priority)) return Promise.resolve(CRASHED);
      if (deadline !== null && deadline.expired()) return Promise.resolve(DEADLINE);
      return new Promise<JobResult<J>>((resolve) => {
        const id = queue.push(job, priority);
        const p: Pending = { id, priority, job, deadline, settled: false, resolve: resolve as (r: JobResult<RegionJob>) => void };
        pending.set(id, p);
        if (deadline !== null) void watchDeadline(p, deadline);
        pump();
      });
    },
    availability(): ReadonlyMap<Language, 'ok' | 'unavailable'> {
      return new Map(LANGUAGES.map((l) => [l, fg.availability.get(l) === 'ok' && bg.availability.get(l) === 'ok' ? 'ok' : 'unavailable'] as const));
    },
    async close(): Promise<void> {
      closing = true;
      for (const p of [...pending.values()]) settle(p, CRASHED);
      const live = [fg.worker, bg.worker].filter((w): w is Worker => w !== null);
      await Promise.all(live.map((w) => w.terminate()));
      fg.state = 'closed';
      bg.state = 'closed';
    },
  };
}
