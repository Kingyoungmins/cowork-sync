// The Engine and its loop (01-engine §3.5 the whole iteration, out-of-cycle request (a), preconditions; §3.6; §3.15;
// §3.16; ENG-13…ENG-19, ENG-55…ENG-57; CCI-50; rulings R-07, R-08, R-09, R-11, R-16, R-18, R-26, R-27, R-28, R-35; the
// Plan 1 ledger carry "monotonic time across sleep"; the Task 13/14/15 carries named below).
//
// Engine.iterate() runs one iteration, never two at once (start, recover, resume and drain queue behind it too):
//   0a  suspend, two anchors (Task 17 ruling): Δwall − Δmono > 5 s since the START of the previous iteration (a sleep
//       that began inside that iteration counts), or Δmono > 3 × the loop period since its END (a long iteration is no
//       suspend) → the in-flight fetch is abandoned and a fetch is owed: until one SUCCEEDS no apply or publish
//       decision is made (LIF-39), while snapshots and captures go on (LIF-38)
//   0b  .git/index.lock (ENG-15): the iteration only fetches and folds (no ring sweep, tick, observation or
//       materialization); INDEX_LOCK_WAIT{age} once after 30 s of one mtime; the lock is never deleted
//   0c  epoch (R-09): E1, or FREEZE(EPOCH) set by one state update with a board-only `freeze` event queued; while it
//       holds the iteration fetches and folds and may push that event board-only, nothing else; E1 again lifts it with
//       an `unfreeze` event
//   0d  lease (CCI-50, R-11): after 2 min without one no new capture and no apply; ready pairs still flush
//   1–3 prepareIteration (fetch, incident check, fold + VERSION, detection tick, materialize when a capture is due or
//       the apply is admitted); its incident branch enters or keeps INCIDENT and the iteration stops there (no TIP)
//   2   clearIncidentIfHealed (UNFROZEN{reasons: [INCIDENT]}); the R-08 branch classification (BRANCH_REWRITTEN)
//   4   the eol-bom records of R-07 on the materialized S_disk; S_pub := MASK(S_disk) with INV-MASK asserted (a
//       violation stays in status as not_converged{publish_assert}); capture (only when captureDue) + journal
//   5   a kept push intent resolved first (P2-PUSHINTENT-FIRST), then applyStep
//   6   publishStep (it hands the iteration fetch's HTTP throttle signal to the governor; an iteration that never
//       reaches it calls publish.ts's handOverThrottle, Task 14 carry)
//   7   status.json and the engine events (R-27: status and the daemon log only)
//
// The daemon lock (R-26) lives here too: `daemon.js run` and the test fixtures hold <coworkDir>/daemon.lock while an
// Engine starts (restart, ENG-53's own-leftover deletions), recovers or resumes; Engine asserts it at each of them.
import { join } from 'node:path';
import type { Json } from '../board/canonicalJson.js';
import { governorRank, type VersionVerdict } from '../board/fold.js';
import type { PeerId } from '../board/ids.js';
import type { PushState } from '../board/outbox.js';
import { ABSENT, type Oid } from '../git/oid.js';
import type { ReadyPair } from '../holds/changesets.js';
import type { DeferReason } from '../holds/groups.js';
import { maskEntries, maskReason, type MaskInputs } from '../holds/mask.js';
import { guardName, isTerminal, type HoldRecord } from '../holds/record.js';
import { anchorNow, elapsedMono, machineMonoMs, processStartMonoMs, SUSPEND_GAP_THRESHOLD_MS, suspendGapMs, type Anchor, type Clock } from '../ports/clock.js';
import { KilledAt } from '../ports/crashpoint.js';
import { errnoCode, type Fs } from '../ports/fs.js';
import { LEASE_EXIT_MS, LEASE_STOP_SYNC_MS, type LeasePort } from '../ports/lease.js';
import type { LogParam } from '../ports/log.js';
import type { Scheduler } from '../ports/scheduler.js';
import { applyNeeded, applyStep, type ApplyReport } from './apply.js';
import { heldPathInP } from './assertions.js';
import {
  captureDue, createEngineCore, ensureAttrs, foldPatch, phantomPaths, pinnedPaths, prepareIteration, pushStatesOf, tickInputOf,
  type EngineCore, type IterationCtx,
} from './core.js';
import type { EngineDeps } from './deps.js';
import { epochVerdict, INDEX_LOCK_NOTICE_MS, observeEpoch, type EpochObservation } from './epoch.js';
import type { FetchView } from './fetcher.js';
import { liveBase } from './incident.js';
import type { FreezeReason } from './meta.js';
import { handOverThrottle, publishStep, publishTreeRefused, resolvePushIntent, type PublishReport } from './publish.js';
import { clearIncidentIfHealed, enterIncident, incidentStatus, recover, type RecoverResult } from './recover.js';
import { StartRefused } from './restart.js';
import type { Materialized } from './snapshot.js';
import { startDispatch, takeStartCapture, type StartOptions, type StartResult } from './start.js';
import { StateCasLostError } from './state.js';
import { blockedPublishReason, computeStatus, publishPauseOf, StatusWriter, type NotConvergedWhy, type PublishPause, type StatusInputs, type StatusJson } from './status.js';
import { DAEMON_LOCK_FILE, parseLockHolder as parseHolder, processAlive, type DaemonLockHolder } from './daemonFiles.js';
import { diffPaths } from './treeDiff.js';

export const LOOP_ACTIVE_MS = 2_500;
export const LOOP_IDLE_MS = 10_000;
export const SUSPEND_LOOP_FACTOR = 3;          // Δmono > 3 × loop period between iterations = suspended (Global Constraints)

export interface IterationReport { n: number; fetched: boolean; applied: boolean; pushAttempts: number; landed: boolean; frozen: boolean; incident: boolean; active: boolean; nextDueMs: number; }
export interface EngineInspection {
  peerId: PeerId; laC: Oid; laB: Oid; aTree: Oid; snapTree: Oid; epochBase: Oid;
  freeze: FreezeReason[]; publishPause: PublishPause;
  pending: Record<string, DeferReason>; notConverged: string[];
  holds: HoldRecord[]; ready: ReadyPair[]; pushAttempts: number; status: StatusJson;
  /** Contract extension (Task 17 fix round 2): each not_converged path's cause with its 01-engine §2 qualifier. */
  notConvergedWhy?: Record<string, NotConvergedWhy>;
}
/** Step 4's INV-MASK check result (Engine.sPubHolds): the first held path that differs from A in S_pub and heldPathInP's letter. */
export interface MaskViolation { path: string; check: 'i' | 'INV-MASK'; }
export interface LoopHandle { stop(): Promise<void>; readonly finished: Promise<void>; }

// ---- the daemon lock (ruling R-26) ----------------------------------------------------------------------------------

export { DAEMON_LOCK_FILE, type DaemonLockHolder } from './daemonFiles.js';

/** coworkDir → the instance id this process holds daemon.lock with. */
const heldLocks = new Map<string, string>();

/**
 * A holder that no longer holds the lock: one that started later on the machine-wide monotonic clock than this boot has
 * run (it started before a reboot, whatever process now has its pid: final review FC minor); a pid that is not alive;
 * or this process's own pid under an instance this process does not hold, or with another start time (a pid reused
 * after a crash or a reboot — `kill(pid, 0)` cannot tell those from a live daemon).
 */
function staleHolder(h: DaemonLockHolder, coworkDir: string, alive: (pid: number) => boolean): boolean {
  if (h.started !== null && h.started > machineMonoMs()) return true;
  if (h.pid === process.pid) return heldLocks.get(coworkDir) !== h.instance || h.started !== processStartMonoMs();
  return !alive(h.pid);
}

/** A daemon.lock that names no holder is a crash leftover only once it is this much older than a file written now. */
const NO_HOLDER_STALE_MS = 10_000;

/**
 * Final review FC minor (TOCTOU): a daemon.lock whose content names no holder is either a crash inside its one write
 * (stale) or a concurrent creator between its exclusive create and that write (held). Told apart by age: older than
 * NO_HOLDER_STALE_MS against a probe file written now in the same directory (file-system time against file-system
 * time, as the restart marker does); the probe is removed again.
 */
async function noHolderStale(fs: Fs, coworkDir: string, file: string): Promise<boolean> {
  const probe = join(coworkDir, `${DAEMON_LOCK_FILE}.probe-${process.pid}`);
  try {
    await fs.writeFile(probe, Buffer.from('cowork daemon.lock age probe\n', 'utf8'));
    const now = await fs.lstat(probe);
    const lock = await fs.lstat(file);
    if (now === null) return false;
    if (lock === null) return true;   // gone meanwhile: the next attempt creates it
    return now.mtimeNs - lock.mtimeNs >= BigInt(NO_HOLDER_STALE_MS) * 1_000_000n;
  } finally {
    await fs.unlink(probe).catch(() => undefined);
  }
}

/**
 * <coworkDir>/daemon.lock (R-26): an exclusive create holding {pid, plugin_version, instance, started}. A stale lock (see
 * staleHolder), or one whose content names no holder and is NO_HOLDER_STALE_MS old (a crash inside its one write), is
 * replaced once; a live holder, or a young lock that names none (a concurrent creator mid-write, noHolderStale), refuses.
 * The IPC-bind single instance is Plan 5; two daemons that both misread a stale lock still cannot both write (the state
 * CAS).
 */
export class DaemonLock {
  readonly file: string;
  readonly holder: DaemonLockHolder;
  private readonly fs: Fs;
  private readonly coworkDir: string;
  private released = false;

  private constructor(fs: Fs, coworkDir: string, holder: DaemonLockHolder) {
    this.fs = fs;
    this.coworkDir = coworkDir;
    this.file = join(coworkDir, DAEMON_LOCK_FILE);
    this.holder = holder;
  }

  static async acquire(fs: Fs, coworkDir: string, who: { pluginVersion: string; instance: string }, alive: (pid: number) => boolean = processAlive): Promise<DaemonLock | { held: DaemonLockHolder | null }> {
    await fs.mkdirp(coworkDir);
    const holder: DaemonLockHolder = { pid: process.pid, plugin_version: who.pluginVersion, instance: who.instance, started: processStartMonoMs() };
    const file = join(coworkDir, DAEMON_LOCK_FILE);
    const bytes = Buffer.from(`${JSON.stringify(holder)}\n`, 'utf8');
    let seen: DaemonLockHolder | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await fs.writeFileExclusive(file, bytes);
        heldLocks.set(coworkDir, holder.instance);
        return new DaemonLock(fs, coworkDir, holder);
      } catch (e) {
        if (errnoCode(e) !== 'EEXIST') throw e;
      }
      let buf: Buffer;
      try {
        buf = await fs.readFile(file);
      } catch (e) {
        if (errnoCode(e) === 'ENOENT') continue;   // released meanwhile
        throw e;
      }
      seen = parseHolder(buf);
      if (seen !== null && !staleHolder(seen, coworkDir, alive)) return { held: seen };
      if (seen === null && !(await noHolderStale(fs, coworkDir, file))) return { held: null };
      if (attempt > 0) break;
      try {
        await fs.unlink(file);   // stale (or it names no holder)
      } catch (e) {
        if (errnoCode(e) !== 'ENOENT') throw e;
      }
    }
    return { held: seen };
  }

  /** The holding process died (a crash, or a SIM kill): forget this process's in-memory hold and leave the file behind,
   *  as a dead process would. The next acquire then sees a stale lock (staleHolder) and takes it over. Idempotent. */
  abandon(): void {
    if (this.released) return;
    this.released = true;
    if (heldLocks.get(this.coworkDir) === this.holder.instance) heldLocks.delete(this.coworkDir);
  }

  /** Removes the file when it still names this holder; idempotent. */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    if (heldLocks.get(this.coworkDir) === this.holder.instance) heldLocks.delete(this.coworkDir);
    let cur: DaemonLockHolder | null = null;
    try {
      cur = parseHolder(await this.fs.readFile(this.file));
    } catch (e) {
      if (errnoCode(e) === 'ENOENT') return;
      throw e;
    }
    if (cur !== null && cur.instance === this.holder.instance && cur.pid === this.holder.pid) await this.fs.unlink(this.file);
  }
}

/** This process holds <coworkDir>/daemon.lock: it acquired it and the file still names it. */
export async function daemonLockHeld(fs: Fs, coworkDir: string): Promise<boolean> {
  const instance = heldLocks.get(coworkDir);
  if (instance === undefined) return false;
  try {
    const h = parseHolder(await fs.readFile(join(coworkDir, DAEMON_LOCK_FILE)));
    return h !== null && h.instance === instance && h.pid === process.pid && h.started === processStartMonoMs();
  } catch {
    return false;
  }
}

// ---- the Engine -----------------------------------------------------------------------------------------------------

/** A kept push intent shows as NOT_CONVERGED{push_unresolved} after this long, and is logged at most this often (Task 14 carry). */
const INTENT_UNRESOLVED_MS = 60_000;
const INTENT_LOG_EVERY_MS = 600_000;
/** glossary §14 / 01-engine §3.16: a pending path older than this makes the state degraded. */
const PENDING_OLD_MS = 60_000;
/** A fetch owed since a suspend shows as NOT_CONVERGED{fetch_owed} (degraded) once it is this old, and is logged once. */
const FETCH_OWED_MS = 60_000;
/** meta.pending reasons of not-applicable paths (R-05): listed in not_converged at once. */
const NOT_APPLICABLE: ReadonlySet<string> = new Set(['collision', 'unmaterializable', 'quarantine']);
/** not_applicable's guard (01-engine §2) by meta.pending reason: an incoming change to a quarantined path waits for review (07-coordination {NCCAUSE} #4). */
const NOT_APPLICABLE_GUARD: Readonly<Record<string, string>> = { collision: 'collision', unmaterializable: 'unmaterializable', quarantine: 'quarantine-review' };
/** DECISION-guarded Plan 2 records that wait for a human verb (R-03): their paths stay in not_converged. */
const WAITING_GUARDS: ReadonlySet<string> = new Set(['restart', 'phantom', 'host-reject', 'join']);
const NO_VERSION: VersionVerdict = { proto: false, regionSpec: false, checkpointMismatch: false };
/**
 * OFFLINE's explanation (01-engine §2; SEC-18: auth | host | network | network-or-auth). SEC-18 derives it from
 * structured evidence, which Plan 2 does not classify: a fetch the remote did not answer is named by the label that
 * covers both causes.
 */
const OFFLINE_EXPLANATION = 'network-or-auth';

/** Log params from Json params (objects and arrays as their JSON text). */
function logParams(params: Readonly<Record<string, Json>>): Record<string, LogParam> {
  const out: Record<string, LogParam> = {};
  for (const [k, v] of Object.entries(params)) out[k] = v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : JSON.stringify(v);
  return out;
}

/** 01-engine §2's 8-hex form of an oid (BRANCH_REWRITTEN's Hb and Hr). */
const hex8 = (oid: string): string => oid.slice(0, 8);

export class Engine {
  readonly peerId: PeerId;
  readonly core: EngineCore;
  private readonly status: StatusWriter;
  /** This Engine's creation (the daemon start): offline_for_s counts from here until a fetch succeeds. */
  private readonly createdMono: number;
  /** The queue every operation runs in: one at a time, in call order. */
  private tail: Promise<unknown> = Promise.resolve();
  private n = 0;
  private started = false;
  private drainedFlag = false;
  private refused: { code: string; params: Record<string, Json> } | null = null;
  private down: { code: 'IDLE_NO_SESSION' | null } | null = null;
  private lastEvent: { code: string; params: Record<string, Json> } | null = null;
  private lastStatus: StatusJson | null = null;
  /**
   * 0a: the START of the previous iteration (the suspend gap Δwall − Δmono counts from it), its END and the period the
   * loop used after it (Δmono > SUSPEND_LOOP_FACTOR × period counts from the end).
   */
  private prevStart: Anchor | null = null;
  private prevEnd: Anchor | null = null;
  private period = LOOP_ACTIVE_MS;
  /**
   * The fetch owed since a suspend (LIF-39), until one succeeds: `sinceMono` the suspend that made it owed; `force` until
   * the first forced fetch after it has completed — a failed one (a network failure, or a LOCAL one, P2-FETCHLOCAL) is
   * followed by the normal schedule (the spacing, the loop period and any network backoff), never by a forced fetch
   * every iteration; `logged` its one NOT_CONVERGED{fetch_owed} log line once it is FETCH_OWED_MS old.
   */
  private owed: { sinceMono: number; force: boolean; logged: boolean } | null = null;
  private freshRequested = false;
  private wake: (() => void) | null = null;
  /** The completed (non-deferred) fetches of the current operation, told by the Fetcher's hook (Engine.create). */
  private views: FetchView[] = [];
  private indexLock: { mtimeNs: bigint | null; sinceMono: number; noticed: boolean } | null = null;
  private lastVersion: VersionVerdict | null = null;
  private lastCarried: ReadonlySet<string> = new Set();
  private lastFilterFailures: ReadonlySet<string> = new Set();
  /** ENG-28: the INV-MASK violation of the last iteration that checked S_pub (null once one passes). */
  private maskViolation: MaskViolation | null = null;
  /**
   * Final review FC-2 (ENG-41, 01-engine §2 NOT_CONVERGED{cause: publish_assert, check}): the check that aborted the last
   * publishStep (PublishReport.assert); kept while publishes are skipped, cleared by a publishStep that got past every
   * check (landed, nothing, lease_lost, transient, nonretryable, network).
   */
  private publishAssert: { check: string; path: string | null } | null = null;
  /** Final review FC-4: this iteration's publishStep report (null when the iteration never reached publishStep). */
  private lastPublish: PublishReport | null = null;
  private branch: { key: string; value: { hb: string; hr: string } | null } | null = null;
  private pendingSince = new Map<string, number>();
  private deferredApplies = new Map<string, number>();
  private intentSince: number | null = null;
  private intentLogged: number | null = null;
  private wasOffline = false;
  private wasVersion = false;

  private constructor(core: EngineCore) {
    this.core = core;
    this.peerId = core.peerId;
    const { coworkDir } = core.deps.paths;
    this.status = new StatusWriter(core.deps.ports.fs, join(coworkDir, 'status.json'), join(coworkDir, 'tmp'), core.deps.ports.clock);
    this.createdMono = core.deps.ports.clock.monoMs();
  }

  /**
   * Every completed fetch of this clone (the iteration's own, publish's classify fetch, recover's) reaches the Engine
   * through the hook it gives the Fetcher at construction (no method of the core is replaced): the report's `fetched`,
   * the suspend rule's "a fetch succeeded" and the throttle hand-over read them.
   */
  static async create(deps: EngineDeps): Promise<Engine> {
    let engine: Engine | null = null;
    const core = await createEngineCore(deps, {
      onFetched: (v) => {
        engine?.views.push(v);
      },
    });
    engine = new Engine(core);
    return engine;
  }

  get drained(): boolean {
    return this.drainedFlag;
  }

  /** runLoop's hook: an out-of-cycle request starts an iteration at once (at most one in flight). */
  setWake(f: (() => void) | null): void {
    this.wake = f;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Restart, recover and resume run only while daemon.lock is held (R-26; Task 15 carry). */
  private async assertLock(what: string): Promise<void> {
    const { fs } = this.core.deps.ports;
    if (!(await daemonLockHeld(fs, this.core.deps.paths.coworkDir))) {
      throw new Error(`Engine.${what}: daemon.lock is not held by this process (restart, recover and resume run only under it)`);
    }
  }

  private event(level: 'info' | 'warn' | 'error', code: string, params: Record<string, Json>): void {
    this.lastEvent = { code, params };
    this.core.deps.log.write(level, code, logParams(params));
  }

  /** Table 3.3-A (startDispatch, R-23) under daemon.lock; a StartRefused escaping a direct restart() maps to the same refusal. */
  start(opts: StartOptions): Promise<StartResult> {
    return this.exclusive(async () => {
      await this.assertLock('start');
      let r: StartResult;
      try {
        r = await startDispatch(this.core, opts);
      } catch (e) {
        if (!(e instanceof StartRefused)) throw e;
        r = { ok: false, code: e.code, params: e.params };
      }
      if (r.ok) {
        this.started = true;
        this.refused = null;
        this.prevStart = null;
        this.prevEnd = null;
        this.core.deps.log.write('info', 'STARTED', { mode: r.mode });
        const lost = r.restart?.lostState ?? null;
        if (lost !== null) this.event('warn', 'LOST_STATE', { mode: lost.mode, records: lost.records.length, paths: lost.paths.length });
        if (takeStartCapture(this.core)) await this.captureAtStart();
      } else {
        this.refused = { code: r.code, params: r.params };
        this.core.deps.log.write('warn', r.code, logParams(r.params));
      }
      await this.writeStatus();
      return r;
    });
  }

  iterate(): Promise<IterationReport> {
    return this.exclusive(() => this.iterateNow());
  }

  /** /cowork done: the open human change-set closes at the next iteration (HLD-35), which starts at once. */
  done(): void {
    this.core.cs.done();
    this.wake?.();
  }

  /**
   * Out-of-cycle request (a): the next iteration starts at once. A request that arrives while a fetch is in flight waits
   * for that fetch instead of starting another (01-engine §3.5): the next iteration decides on its answer. Otherwise the
   * next iteration fetches at once, inside the 2.5 s spacing. Never two fetches at once.
   */
  requestFreshFetch(): void {
    if (!this.core.fetcher.inFlight()) this.freshRequested = true;
    this.wake?.();
  }

  /** The human-typed recover as a request inside the running daemon (queued behind the iteration in flight) or in a `daemon.js recover` process; daemon.lock held either way. */
  recover(confirm: string | null): Promise<RecoverResult> {
    return this.exclusive(async () => {
      await this.assertLock('recover');
      this.views = [];
      const r = await recover(this.core, confirm);
      if (r.ok && r.done) this.event('info', 'RECOVERED', { mode: r.preview.mode });
      await this.writeStatus();
      return r;
    });
  }

  /**
   * R-28: meta.nonretryable and the rejection streak cleared by one state CAS; false when there is nothing to clear.
   * Final review FC-5 (05-holds: host-reject is "lifted by human /cowork resume (the publish is retried)", ENG-45): the
   * host-reject PIN that meta.nonretryable names ends first (RESOLVED_PUBLISH, guard kept so a pathless record stays
   * valid), so P2-PIN no longer holds its change-sets back and the next iterations retry the rejected publish; before
   * the CAS, so a crash between the two leaves the pause (the next resume clears it), never a PIN nothing lifts.
   */
  resumeAfterNonretryable(): Promise<boolean> {
    return this.exclusive(async () => {
      await this.assertLock('resumeAfterNonretryable');
      const view = this.core.view;
      if (view === null || (view.meta.nonretryable === null && view.meta.rejections === null)) return false;
      const holdId = view.meta.nonretryable?.hold_id ?? null;
      const pin = holdId === null ? undefined : this.core.holds.get(holdId);
      if (pin !== undefined && !isTerminal(pin) && pin.guards.some((g) => guardName(g) === 'host-reject')) {
        await this.core.holds.transition(pin.id, { state: 'RESOLVED_PUBLISH', residence: null });
      }
      // R-27: a non-retryable rejection posts `event{kind: nonretryable}` only after the pause lifts (queued in this update).
      if (view.meta.nonretryable !== null) this.core.outbox.add({ type: 'event', cid: '', kind: 'nonretryable', refs: [], reason_code: 'NONRETRYABLE' });
      const fp = foldPatch(this.core);
      await this.core.commit({
        meta: { ...view.meta, ...(fp?.meta ?? {}), nonretryable: null, rejections: null, outbox: this.core.outbox.toJson() },
        ...(fp !== null ? { fold: fp.fold } : {}),
      });
      this.core.deps.log.write('info', 'RESUMED', { hold_id: view.meta.nonretryable?.hold_id ?? null });
      return true;
    });
  }

  /** The last status.json and what the SIM oracles read. */
  async inspect(): Promise<EngineInspection> {
    const view = this.core.view;
    if (view === null) throw new Error('Engine.inspect: no state (start first)');
    const inputs = this.statusInputs();
    const status = computeStatus(inputs);
    return {
      peerId: this.peerId, laC: view.laC, laB: view.laB, aTree: view.base, snapTree: view.snap, epochBase: view.meta.EPOCH_BASE,
      freeze: [...view.meta.freeze_reasons], publishPause: status.publish_pause,
      pending: { ...view.meta.pending }, notConverged: [...status.pending.not_converged],
      holds: [...this.core.holds.all()], ready: [...this.core.cs.ready()], pushAttempts: this.core.pushAttempts, status,
      notConvergedWhy: Object.fromEntries(inputs.notConvergedCauses ?? []),
    };
  }

  /** ENG-55 / CCI-50: finish the operation in flight, write status.json `down` (IDLE_NO_SESSION or no code); no iteration after it. */
  drain(downCode: 'IDLE_NO_SESSION' | null): Promise<void> {
    return this.exclusive(async () => {
      if (this.drainedFlag) return;
      this.drainedFlag = true;
      this.down = { code: downCode };
      this.core.deps.log.write('info', 'DRAINED', { code: downCode });
      await this.writeStatus();
    });
  }

  // ---- one iteration ----------------------------------------------------------------------------------------------

  private async iterateNow(): Promise<IterationReport> {
    const core = this.core;
    const { deps } = core;
    const clock = deps.ports.clock;
    // This iteration's START, taken before anything else: the next iteration's suspend gap counts from here, so a sleep
    // that begins inside this iteration (during its fetch, say) is seen by the next one.
    const startAnchor = anchorNow(clock);
    const n = ++this.n;
    if (this.drainedFlag) return this.report(n, false, null, false, false, false);
    if (!this.started || core.view === null) throw new Error('Engine.iterate: start() has not succeeded');
    const pushesBefore = core.pushAttempts;
    this.views = [];
    this.lastPublish = null;

    // 0a suspend (Plan 1 ledger carry; two anchors, Task 17 ruling): Δwall − Δmono > 5 s since the START of the
    // previous iteration, or Δmono > 3 × the period the loop used since its END (a long iteration is no suspend). A fetch
    // is owed until one succeeds; the first one after the suspend is forced (it skips the spacing), the later ones follow
    // the normal schedule.
    const prevStart = this.prevStart;
    this.prevStart = startAnchor;
    if (prevStart !== null && this.prevEnd !== null) {
      const gap = suspendGapMs(clock, prevStart);
      const dMono = elapsedMono(clock, this.prevEnd);
      if (gap > SUSPEND_GAP_THRESHOLD_MS || dMono > SUSPEND_LOOP_FACTOR * this.period) {
        core.fetcher.abandon();
        this.owed = { sinceMono: this.owed?.sinceMono ?? clock.monoMs(), force: true, logged: this.owed?.logged ?? false };
        deps.log.write('info', 'SUSPEND_GAP', { gap_ms: Math.round(gap), mono_ms: Math.round(dMono) });
      }
    }
    const force = this.owed?.force === true || this.freshRequested;
    this.freshRequested = false;

    // 0b index.lock, 0c the epoch (R-09), 0d the lease (CCI-50). Under index.lock or FREEZE(EPOCH) the iteration only
    // fetches and folds (ENG-15, LIF-10, glossary §8): no ring sweep, no detection tick, no change-set observation, no
    // materialization — the work tree belongs to the human's git command.
    const obs = await observeEpoch(core.repo, deps.ports.fs);
    const lockOnly = this.trackIndexLock(obs, clock.monoMs());
    const epochFrozen = epochVerdict(obs, core.view.meta.expected_epoch) === 'FREEZE';
    await this.setEpochFreeze(epochFrozen, obs);
    const leaseStopped = deps.lease.idleMs() >= LEASE_STOP_SYNC_MS;
    const fetchFoldOnly = lockOnly || epochFrozen;
    const captureAllowed = !fetchFoldOnly && !leaseStopped;

    // 1–3.
    const prepared = await prepareIteration(core, n, { materialize: captureAllowed ? 'auto' : false, forceFetch: force, fetchFoldOnly });
    // LIF-39 / ENG-16: a suspend is answered only by a fetch that succeeded (a fresh fold); until one has, no apply or
    // publish decision is made — and captures go on (LIF-38), also while the remote stays away for a whole backoff. A
    // forced fetch that completed and failed (the remote unreachable, or a LOCAL failure such as a stale ref lock, which
    // arms no backoff: P2-FETCHLOCAL) is not forced again: the owed fetch then follows the normal schedule — the spacing,
    // the loop period and the network backoff — and shows in status after FETCH_OWED_MS.
    if (this.views.some((v) => v.ok)) {
      this.owed = null;
    } else if (this.owed?.force === true && this.views.length > 0) {
      this.owed.force = false;
      deps.log.write('warn', 'FETCH_OWED', { local: this.views.some((v) => v.localFailure) });
    }
    let apply: ApplyReport | null = null;
    let landed = false;
    let applyPending = false;
    if (!prepared.ok) {
      handOverThrottle(core, this.views[0] ?? null, pushStatesOf(core, this.lastVersion ?? NO_VERSION));
      if (prepared.why === 'incident') {
        // No IterationCtx and no TIP: enter or keep the incident, write status, stop.
        await enterIncident(core, prepared.verdict, prepared.T);
      } else {
        deps.log.write('error', 'ITERATION_SKIPPED', { why: prepared.why });
      }
    } else {
      const it = prepared.it;
      // An incident that healed by itself (its check passes again) is UNFROZEN (01-engine §3.7, R-27).
      if (await clearIncidentIfHealed(core, it)) this.event('info', 'UNFROZEN', { reasons: ['INCIDENT'] });
      this.lastVersion = it.version;
      if (it.tick !== null) {
        // Final review FB-6: a TIP path this clone carries by its name alone (`a:b.txt`; `aux.c` on Windows) is never
        // written and A never follows it, so it is in no tick's carry set (A ∪ the private index): listed here too.
        const tipOnly = it.A === it.tipMap ? [] : [...it.tipMap.keys()].filter((p) => !it.A.has(p) && core.snapshot.isCarried(p));
        this.lastCarried = tipOnly.length === 0 ? it.tick.carried : new Set([...it.tick.carried, ...tipOnly]);
        this.lastFilterFailures = new Set([...it.tick.excluded].filter(([, why]) => why === 'filter_failure').map(([p]) => p));
      }
      await this.classifyBranch(it);
      const fetchedNow = it.fetched !== null && !it.fetched.deferred ? it.fetched : null;
      if (lockOnly || (epochFrozen && this.owed !== null)) {
        // ENG-15: fetch and fold only (or a frozen iteration that still owes its fetch).
        handOverThrottle(core, fetchedNow, it.pushStates);
      } else if (epochFrozen) {
        // R-09 / glossary §8: no capture, apply or work-tree write; the board-only freeze event may leave.
        const publish = this.notePublish(await publishStep(core, it));
        if (publish.outcome === 'landed') landed = true;
      } else {
        let maskOk = true;
        if (captureAllowed && captureDue(core) && it.mat === null) {
          it.mat = await core.snapshot.materialize(tickInputOf(core, it));
          await ensureAttrs(core, it.epochBase, it.mat.sDiskMap.keys());
        }
        if (it.mat !== null) {
          await this.eolBomRecords(it, it.mat);
          // ENG-28: an INV-MASK violation aborts the capture and every publish of this iteration, and stays in status
          // (not_converged, cause publish_assert) until an iteration passes the check.
          const held = await this.sPubHolds(it, it.mat);
          this.maskViolation = held;
          if (held !== null) {
            maskOk = false;
            deps.log.write('error', 'NOT_CONVERGED', { cause: 'publish_assert', check: held.check, path: held.path });
          }
        }
        if (captureAllowed && maskOk && captureDue(core)) await this.capture(it);
        if (this.owed !== null) {
          // LIF-39: a fetch is owed since a suspend; the capture above went on, no apply or publish decision.
          handOverThrottle(core, fetchedNow, it.pushStates);
        } else {
          if (core.view!.intent.kind === 'push') {
            const r = await resolvePushIntent(core, it);
            if (r.outcome === 'landed') landed = true;
            // Task 19 ruling (fix round 3): a path the capture above deferred for a pair the intent named re-closes once
            // the intent resolved. Not landed (discarded: A, so this iteration's S_disk, unchanged), it re-closes here,
            // before this iteration's publish, and the pair drops it: a created-then-deleted file is never re-sent. Landed,
            // the next iteration's capture (a fresh S_disk over the new A, which has p) captures the deletion; until then
            // no pair covers p, so P[p] = A[p] = C[p] and nothing is published for p.
            const discarded = r.outcome !== 'landed' && r.why === 'resolved';
            if (discarded && captureAllowed && maskOk && it.mat !== null && captureDue(core)) await this.capture(it);
          }
          apply = await applyStep(core, it);
          if (maskOk) {
            const publish = this.notePublish(await publishStep(core, it));
            if (publish.outcome === 'landed') landed = true;
          } else {
            handOverThrottle(core, fetchedNow, it.pushStates);
          }
          if (apply.ran) this.countDeferrals();
        }
      }
      applyPending = applyNeeded(core, it);
    }
    return this.finish(n, pushesBefore, apply, landed, applyPending);
  }

  /** 7: the iteration's bookkeeping, events, status.json, trace and report; its end anchors the next Δmono check. */
  private async finish(n: number, pushesBefore: number, apply: ApplyReport | null, landed: boolean, applyPending: boolean): Promise<IterationReport> {
    const core = this.core;
    const view = core.view!;
    const clock = core.deps.ports.clock;
    const now = clock.monoMs();
    // A kept push intent's age (Task 14 carry): NOT_CONVERGED{push_unresolved} after 60 s, logged at most once per 10 min.
    if (view.intent.kind === 'push') {
      this.intentSince ??= now;
      if (now - this.intentSince > INTENT_UNRESOLVED_MS && (this.intentLogged === null || now - this.intentLogged >= INTENT_LOG_EVERY_MS)) {
        this.intentLogged = now;
        core.deps.log.write('error', 'NOT_CONVERGED', { cause: 'push_unresolved', bnew: view.intent.bnew, held_s: Math.floor((now - this.intentSince) / 1_000) });
      }
    } else {
      this.intentSince = null;
      this.intentLogged = null;
    }
    // A fetch owed since a suspend for FETCH_OWED_MS: NOT_CONVERGED{fetch_owed} in status (statusInputs), logged once.
    if (this.owed !== null && !this.owed.logged && now - this.owed.sinceMono >= FETCH_OWED_MS) {
      this.owed.logged = true;
      core.deps.log.write('error', 'NOT_CONVERGED', { cause: 'fetch_owed', owed_s: Math.floor((now - this.owed.sinceMono) / 1_000) });
    }
    for (const p of Object.keys(view.meta.pending)) if (!this.pendingSince.has(p)) this.pendingSince.set(p, now);
    for (const p of [...this.pendingSince.keys()]) if (!Object.prototype.hasOwnProperty.call(view.meta.pending, p)) this.pendingSince.delete(p);

    // Engine events of conditions (R-27): status.json and the daemon log. OFFLINE carries the same offline_for_s as the
    // status written with it (one source).
    const off = core.fetcher.offline();
    if (off.offline !== this.wasOffline) {
      this.wasOffline = off.offline;
      if (off.offline) core.deps.log.write('warn', 'OFFLINE', { label: 'OFFLINE', explanation: OFFLINE_EXPLANATION, offline_for_s: this.offlineForS() });
      else this.event('info', 'ONLINE', {});
    }
    const v = this.lastVersion ?? NO_VERSION;
    const version = v.proto || v.regionSpec || v.checkpointMismatch;
    if (version !== this.wasVersion) {
      this.wasVersion = version;
      if (version) core.deps.log.write('warn', 'VERSION_PAUSED', { form: v.proto ? 'proto' : 'regionSpec', cause: !v.proto && !v.regionSpec ? 'checkpoint_mismatch' : null });
    }

    const active = this.activeNow(applyPending);
    this.period = active ? LOOP_ACTIVE_MS : LOOP_IDLE_MS;
    await this.writeStatus();
    const fetched = this.views.some((x) => x.ok);
    const applied = apply?.ran === true;
    const pushes = core.pushAttempts - pushesBefore;
    core.deps.trace.emit({ kind: 'iteration', peer: core.peerId, n, fetched, applied, pushes });
    this.prevEnd = anchorNow(clock);
    return this.report(n, fetched, apply, landed, active, true, pushes);
  }

  private report(n: number, fetched: boolean, apply: ApplyReport | null, landed: boolean, active: boolean, live: boolean, pushes = 0): IterationReport {
    const meta = this.core.view?.meta;
    return {
      n, fetched, applied: apply?.ran === true, pushAttempts: pushes, landed,
      frozen: (meta?.freeze_reasons.length ?? 0) > 0, incident: meta?.freeze_reasons.includes('INCIDENT') === true,
      active, nextDueMs: live ? this.nextDue(active) : LOOP_IDLE_MS,
    };
  }

  /** Work pending (01-engine §3.5 period): an open or due change-set, ready pairs, outbox ops, an intent, pending paths, an apply to do, a stranded restore or a forced fetch still owed. */
  private activeNow(applyPending: boolean): boolean {
    const core = this.core;
    const view = core.view!;
    const cs = core.cs.counts();
    return cs.open > 0 || cs.ready > 0 || core.outbox.size > 0 || view.intent.kind !== 'none' || Object.keys(view.meta.pending).length > 0
      || applyPending || core.writer.strandedPaths().length > 0 || this.owed?.force === true || this.indexLock !== null;
  }

  /**
   * This iteration's publishStep report (final review FC-2, FC-4): the iteration's report for nextDue, and the publish_assert
   * kept for status — set by a report carrying an aborting check, cleared by one that got past every check (landed,
   * nothing, lease_lost, transient, nonretryable, network), kept on a skip or another abort (the check did not run).
   */
  private notePublish(r: PublishReport): PublishReport {
    this.lastPublish = r;
    if (r.assert !== null) this.publishAssert = r.assert;
    else if (r.outcome !== 'skipped' && r.outcome !== 'aborted') this.publishAssert = null;
    return r;
  }

  /**
   * The loop period, or sooner when a governed window is what keeps pending publish work waiting: only after this
   * iteration's publishStep was skipped for the window or made an attempt (final review FC-4). Any other skip — no
   * publishStep (index.lock, FREEZE, an owed fetch, an INV-MASK abort), an aborting check, a filter failure, a stranded
   * restore — waits the period: the window opening changes nothing for it, and an earlier iteration would only spin.
   */
  private nextDue(active: boolean): number {
    const core = this.core;
    const period = active ? LOOP_ACTIVE_MS : LOOP_IDLE_MS;
    const lp = this.lastPublish;
    if (lp === null || !(lp.attempted || (lp.outcome === 'skipped' && lp.why === 'window'))) return period;
    const fold = foldPatch(core)?.fold ?? core.view?.fold ?? null;
    if (fold === null || (core.cs.ready().length === 0 && core.outbox.size === 0)) return period;
    const w = core.governor.msUntilWindow(governorRank(fold, core.peerId));
    return Number.isFinite(w) ? Math.max(0, Math.min(period, Math.ceil(w))) : period;
  }

  /** 0b (ENG-15, LIF-10): true while .git/index.lock exists; INDEX_LOCK_WAIT{age} once after it kept one mtime for 30 s (Δmono). */
  private trackIndexLock(obs: EpochObservation, nowMono: number): boolean {
    if (!obs.indexLock.present) {
      if (this.indexLock !== null && this.lastEvent?.code === 'INDEX_LOCK_WAIT') this.lastEvent = null;
      this.indexLock = null;
      return false;
    }
    const m = obs.indexLock.mtimeNs;
    if (this.indexLock === null || this.indexLock.mtimeNs !== m) {
      this.indexLock = { mtimeNs: m, sinceMono: nowMono, noticed: false };
    } else if (!this.indexLock.noticed && nowMono - this.indexLock.sinceMono >= INDEX_LOCK_NOTICE_MS) {
      this.indexLock.noticed = true;
      // 08-lifecycle §2: INDEX_LOCK_WAIT{age} — whole seconds the lock kept its mtime.
      this.event('warn', 'INDEX_LOCK_WAIT', { age: Math.floor((nowMono - this.indexLock.sinceMono) / 1_000) });
    }
    return true;
  }

  /** 0c (R-09): FREEZE(EPOCH) set or lifted by one state update, with one board-only freeze/unfreeze event queued (R-27). */
  private async setEpochFreeze(frozen: boolean, obs: EpochObservation): Promise<void> {
    const core = this.core;
    const view = core.view!;
    if (view.meta.freeze_reasons.includes('EPOCH') === frozen) return;
    const reasons: FreezeReason[] = frozen ? [...view.meta.freeze_reasons, 'EPOCH'] : view.meta.freeze_reasons.filter((r) => r !== 'EPOCH');
    core.outbox.add({ type: 'event', cid: '', kind: frozen ? 'freeze' : 'unfreeze', refs: [], reason_code: frozen ? 'FROZEN' : 'UNFROZEN' });
    const fp = foldPatch(core);
    await core.commit({ meta: { ...view.meta, ...(fp?.meta ?? {}), freeze_reasons: reasons, outbox: core.outbox.toJson() }, ...(fp !== null ? { fold: fp.fold } : {}) });
    // 01-engine §2: FROZEN{reasons, …} (here with what the observation found) and UNFROZEN{reasons lifted}.
    if (frozen) {
      this.event('warn', 'FROZEN', { reasons: ['EPOCH'], symref: obs.symref, head: obs.head, stash: obs.stash, markers: obs.markers.join(',') });
    } else {
      this.event('info', 'UNFROZEN', { reasons: ['EPOCH'] });
    }
  }

  /** R-08: BRANCH_REWRITTEN when Hr is missing or Hb = live_base(TIP) is not an ancestor of Hr; otherwise Hr ≠ Hb is ignored. */
  private async classifyBranch(it: IterationCtx): Promise<void> {
    const f = it.fetched;
    if (f === null || f.deferred || !f.ok) return;
    const hr = f.branch;
    const key = `${it.tip} ${hr === ABSENT ? '' : hr}`;
    if (this.branch?.key === key) return;
    const core = this.core;
    let value: { hb: string; hr: string } | null = null;
    try {
      const hb = (await liveBase(core.repo, it.tip)).base;
      // 01-engine §2: Hb and Hr as 8 hex, Hr `missing` when the branch is gone.
      if (hr === ABSENT || !(await core.repo.isAncestor(hb, hr))) value = { hb: hex8(hb), hr: hr === ABSENT ? 'missing' : hex8(hr) };
    } catch (e) {
      if (e instanceof KilledAt) throw e;
      return;   // undecidable this iteration (a missing object): try again at the next fetch
    }
    // Logged on the way in, the first classification included.
    if (value !== null && (this.branch?.value ?? null) === null) core.deps.log.write('warn', 'BRANCH_REWRITTEN', { hb: value.hb, hr: value.hr });
    this.branch = { key, value };
  }

  /**
   * R-07: a canon REFUSE(eol-bom) on a LIVE path holds it in one ON_DISK PATCH with the whole-path guard `eol-bom`
   * (masked, DAT-06; a newer refused version updates its h1); a later materialized snapshot in which the path passes
   * canon drops the guard and ends the record GONE (the refused bytes left the disk; no record piles up ACTIVE).
   */
  private async eolBomRecords(it: IterationCtx, mat: Materialized): Promise<void> {
    const core = this.core;
    const records = core.holds.nonTerminal().filter((r) => r.kind === 'PATCH' && r.paths.length === 1 && r.guards.some((g) => guardName(g) === 'eol-bom'));
    const refused = [...mat.canonRefused];
    await ensureAttrs(core, it.epochBase, refused);
    for (const p of refused) {
      if (it.scope(p).cls !== 'LIVE') continue;
      const blobs = { h0: { [p]: it.A.get(p)?.oid ?? ABSENT }, h1: { [p]: mat.sRawMap.get(p)?.oid ?? ABSENT } };
      const existing = records.find((r) => r.paths[0] === p);
      if (existing === undefined) {
        const id = await core.holds.hold({ kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: [p], blobs, guard: 'eol-bom', origin: 'daemon', cs_ids: [], displaced_by: null, local_only: false });
        core.deps.log.write('warn', 'EOL_BOM_HELD', { path: p, hold_id: id });
      } else if ('h1' in existing.blobs && existing.blobs.h1[p] !== blobs.h1[p]) {
        await core.holds.transition(existing.id, { blobs });
      }
    }
    const unsettled = new Set([...(it.tick?.excluded.keys() ?? []), ...mat.excluded.keys()]);
    for (const r of records) {
      const p = r.paths[0]!;
      if (mat.canonRefused.has(p) || unsettled.has(p)) continue;
      await core.holds.transition(r.id, { guards: [], state: 'GONE', residence: null });
      core.deps.log.write('info', 'EOL_BOM_RELEASED', { path: p, hold_id: r.id, state: 'GONE' });
    }
  }

  /** Step 4: S_pub := MASK(S_disk) with INV-MASK asserted (no held path differs from A); the violation, or null. */
  private async sPubHolds(it: IterationCtx, mat: Materialized): Promise<MaskViolation | null> {
    const core = this.core;
    const records = core.holds.maskingRecords();
    await ensureAttrs(core, it.epochBase, [...diffPaths(it.A, mat.sDiskMap), ...records.flatMap((r) => r.paths)]);
    const inp: MaskInputs = { A: it.A, scope: (p) => it.scope(p).cls, records };
    const sPub = maskEntries(mat.sDiskMap, inp);
    const held = heldPathInP(it.A, sPub, (p) => {
      const r = maskReason(p, inp);
      return r !== null && r !== 'path_class';
    }, (p) => it.scope(p).cls);
    return held === null ? null : { path: held.path, check: held.letter };
  }

  /**
   * R-22 'all' (final review FC-8): the local work M a genesis or join closed (start.ts captureLocalWork) is captured at
   * once, by step 4 like every capture — the R-07 eol-bom holds, S_pub := MASK(S_disk) with INV-MASK, the captureDue gate
   * — so its change-set holds what was on disk at the start, and an edit made after it waits its own quiet period. What
   * cannot run here (an incident or another failed prepare, an INV-MASK violation, a stranded restore, no lease) leaves
   * the CS closed for the loop's first capture.
   */
  private async captureAtStart(): Promise<void> {
    const core = this.core;
    if (!captureDue(core) || core.deps.lease.idleMs() >= LEASE_STOP_SYNC_MS) return;
    const prepared = await prepareIteration(core, 0, { materialize: true, forceFetch: true });
    if (!prepared.ok || prepared.it.mat === null) {
      core.deps.log.write('warn', 'START_LOCAL_CAPTURE_DEFERRED', { why: prepared.ok ? 'no_snapshot' : prepared.why });
      return;
    }
    const it = prepared.it;
    const mat = prepared.it.mat;
    await this.eolBomRecords(it, mat);
    const held = await this.sPubHolds(it, mat);
    this.maskViolation = held;
    if (held !== null) {
      core.deps.log.write('error', 'NOT_CONVERGED', { cause: 'publish_assert', check: held.check, path: held.path });
      return;
    }
    if (captureDue(core)) await this.capture(it);
  }

  /** HLD-40: the due human change-set captured from this iteration's S_disk and journaled (one state update). */
  private async capture(it: IterationCtx): Promise<void> {
    const core = this.core;
    if (it.mat === null) throw new Error('capture: the iteration materialized nothing');
    const prev = core.view!;
    // Task 19 ruling (fix round 3): the pairs a kept push intent names are never shrunk (their ok update reads A_cap from them).
    const kept = prev.intent.kind === 'push' ? new Set(prev.intent.cs_ids) : new Set<string>();
    const cap = await core.cs.capture(core.repo, it.mat.sDiskMap, it.A, core.scratch('r'), kept);
    if (cap === null) return;
    const fp = foldPatch(core);
    try {
      await core.commit({ ready: core.cs.ready(), meta: { ...prev.meta, ...(fp?.meta ?? {}), cs_human_next: cap.nextN }, ...(fp !== null ? { fold: fp.fold } : {}) });
    } catch (e) {
      // ChangeSets changed memory first (Task 11 ruling): a non-fatal failure restores it, so the CS closes again.
      if (!(e instanceof StateCasLostError) && !(e instanceof KilledAt)) core.cs.restore(prev.ready, prev.meta.cs_human_next);
      throw e;
    }
  }

  /** ENG-57: a deferral is listed once it outlived one apply (it was pending at two applies in a row). */
  private countDeferrals(): void {
    const pending = this.core.view!.meta.pending;
    for (const p of [...this.deferredApplies.keys()]) if (!Object.prototype.hasOwnProperty.call(pending, p)) this.deferredApplies.delete(p);
    for (const [p, why] of Object.entries(pending)) if (!NOT_APPLICABLE.has(why)) this.deferredApplies.set(p, (this.deferredApplies.get(p) ?? 0) + 1);
  }

  // ---- status.json -------------------------------------------------------------------------------------------------

  /**
   * not_converged with the cause of each path and its 01-engine §2 qualifier (NOT_CONVERGED, §3.16, ENG-28, ENG-57, R-03,
   * R-05, R-10, P2-CARRY, Task 14 carry). One cause per path, the first that applies: publish_assert (check: the letter),
   * phantom, push_unresolved, fetch_owed, not_applicable (guard: unmaterializable for a P2-CARRY path, filter-failure,
   * collision, unmaterializable or quarantine-review for a not-applicable incoming change), deferred (reason: the defer
   * reason), blocked_publish (guard: the DECISION record or P2-PIN that holds it; reason: `blockReason`, the FREEZE reason
   * or publish pause that keeps a ready pair).
   */
  private notConverged(unresolved: boolean, fetchOwed: boolean, blockReason: string | null): Map<string, NotConvergedWhy> {
    const core = this.core;
    const view = core.view;
    const out = new Map<string, NotConvergedWhy>();
    const add = (p: string, w: NotConvergedWhy): void => {
      if (!out.has(p)) out.set(p, w);
    };
    if (this.maskViolation !== null) add(this.maskViolation.path, { cause: 'publish_assert', check: this.maskViolation.check });
    // Final review FC-2: the check that aborted the last publishStep — on its path, or, for a check that names none, on
    // every path of the ready pairs the publish would compose (P2-PIN-skipped pairs are another cause's).
    const pa = this.publishAssert;
    if (pa !== null) {
      if (pa.path !== null) {
        add(pa.path, { cause: 'publish_assert', check: pa.check });
      } else {
        const pinned = pinnedPaths(core);
        for (const pair of core.cs.ready()) {
          if (!pair.paths.some((p) => pinned.has(p))) for (const p of pair.paths) add(p, { cause: 'publish_assert', check: pa.check });
        }
      }
    }
    for (const p of phantomPaths(core)) add(p, { cause: 'phantom' });
    const local = (): void => {
      for (const p of this.lastCarried) add(p, { cause: 'not_applicable', guard: 'unmaterializable' });
      for (const p of this.lastFilterFailures) add(p, { cause: 'not_applicable', guard: 'filter-failure' });
    };
    if (view === null) {
      local();
      return out;
    }
    // Final review FB-5 backstop: an ON_DISK `conflict` record (MASK step 4 resets its path in every P) waits too.
    const waiting = core.holds.nonTerminal().map((r) => ({ r, guard: r.guards.map((g) => guardName(g)).find((g) => WAITING_GUARDS.has(g) || (g === 'conflict' && r.residence === 'ON_DISK')) }));
    for (const { r, guard } of waiting) if (guard === 'phantom') for (const p of r.paths) add(p, { cause: 'phantom' });
    const intentCs = unresolved && view.intent.kind === 'push' ? new Set(view.intent.cs_ids) : new Set<string>();
    for (const pair of core.cs.ready()) if (intentCs.has(pair.csId)) for (const p of pair.paths) add(p, { cause: 'push_unresolved' });
    // A fetch owed since a suspend for FETCH_OWED_MS keeps every ready pair from publishing (LIF-39).
    if (fetchOwed) for (const pair of core.cs.ready()) for (const p of pair.paths) add(p, { cause: 'fetch_owed' });
    local();
    for (const [p, why] of Object.entries(view.meta.pending)) {
      if (NOT_APPLICABLE.has(why)) add(p, { cause: 'not_applicable', guard: NOT_APPLICABLE_GUARD[why] ?? why });
      else if ((this.deferredApplies.get(p) ?? 0) >= 2) add(p, { cause: 'deferred', reason: why });
    }
    // DECISION records waiting for a human verb keep their paths from publishing (guard: the record's).
    const heldBy = new Map<string, string>();
    for (const { r, guard } of waiting) {
      if (guard === undefined) continue;
      for (const p of r.paths) {
        if (!heldBy.has(p)) heldBy.set(p, guard);
        add(p, { cause: 'blocked_publish', guard });
      }
    }
    // Ready publication groups a publish pause or a FREEZE keeps from publishing (02-protocol §3.11 A2; reason: the FREEZE
    // reason or the pause), and pairs a held PIN skips (P2-PIN; guard: that PIN's).
    const states = pushStatesOf(core, this.lastVersion ?? NO_VERSION);
    const pinned = pinnedPaths(core);
    for (const pair of core.cs.ready()) {
      const pin = pair.paths.find((p) => pinned.has(p));
      const why: NotConvergedWhy | null = states.length > 0 ? { cause: 'blocked_publish', reason: blockReason ?? states[0]! }
        : pin !== undefined ? { cause: 'blocked_publish', guard: heldBy.get(pin) ?? 'pin' } : null;
      if (why !== null) for (const p of pair.paths) add(p, why);
    }
    // Final review FB-6: a publish whose OUT git could not build here (TIP holds a root name no index on this OS can hold,
    // `a:b.txt` on Windows) waits until the name leaves TIP: the paths of every ready pair it composes (P2-PIN-skipped
    // pairs are another cause's) are listed like the carried name itself.
    if (publishTreeRefused(core) !== null) {
      for (const pair of core.cs.ready()) {
        if (!pair.paths.some((p) => pinned.has(p))) for (const p of pair.paths) add(p, { cause: 'not_applicable', guard: 'unmaterializable' });
      }
    }
    return out;
  }

  /** offline_for_s (01-engine §2, glossary §25.2 item 4): whole seconds of local Δmono since the last successful fetch — the one source of the status param and the OFFLINE log line. */
  private offlineForS(): number {
    const since = this.core.fetcher.lastSuccessMono() ?? this.createdMono;
    return Math.floor(Math.max(0, this.core.deps.ports.clock.monoMs() - since) / 1_000);
  }

  /** INCIDENT's params (01-engine §2; the names of the INCIDENT log line): n, why, old and observed oids, displaced ref or kept_local. */
  private incidentParams(): Record<string, Json> {
    const view = this.core.view!;
    const st = incidentStatus(this.core);
    const inc = view.meta.incident;
    return {
      n: st?.n ?? inc?.n ?? null, why: st?.why ?? null,
      old_board: view.laB, old_code: view.laC, new_board: inc?.observed_board ?? null, new_code: inc?.observed_code ?? null,
      displaced: st === null ? null : st.displaced === 'kept_local' ? 'kept_local' : st.ref,
    };
  }

  private statusInputs(): StatusInputs {
    const core = this.core;
    const { deps } = core;
    const now = deps.ports.clock.monoMs();
    const view = core.view;
    const meta = view?.meta ?? null;
    const off = core.fetcher.offline();
    const lastOk = core.fetcher.lastSuccessMono();
    const gov = core.governor;
    let throttle: StatusInputs['throttle'] = null;
    if (gov.mode() === 'fallback') {
      // Task 7 ruling: a null fallbackSource() in fallback is an own folded event with no own signal known: 'own'.
      const src = gov.fallbackSource();
      const left = gov.fallbackLeftMs();
      throttle = { source: src === 'team' ? 'team' : 'own', untilMin: Math.ceil(left / 60_000), budget: gov.effective().B, fallbackLeftS: Math.ceil(left / 1_000), signal: src };
    }
    const v = this.lastVersion;
    const version: StatusInputs['version'] = v === null ? null
      : v.proto ? { form: 'proto', cause: null }
      : v.regionSpec ? { form: 'regionSpec', cause: null }
      : v.checkpointMismatch ? { form: 'regionSpec', cause: 'checkpoint_mismatch' } : null;
    const unresolved = this.intentSince !== null && now - this.intentSince > INTENT_UNRESOLVED_MS;
    const nonTerminal = core.holds.nonTerminal();
    const counts = core.cs.counts();
    const fetchOwed = this.owed !== null && now - this.owed.sinceMono >= FETCH_OWED_MS;
    const offline: StatusInputs['offline'] = off.offline ? { label: 'OFFLINE', explanation: OFFLINE_EXPLANATION, offlineForS: this.offlineForS() } : null;
    const nonretryable: StatusInputs['nonretryable'] = meta !== null && meta.nonretryable !== null ? { holdId: meta.nonretryable.hold_id } : null;
    const blockReason = blockedPublishReason(meta?.freeze_reasons ?? [], publishPauseOf({ offline, nonretryable, version }));
    const notConverged = this.notConverged(unresolved, fetchOwed, blockReason);
    // DEFERRED{reason, paths}: the pending paths older than 60 s, with the first one's reason.
    const pending = meta?.pending ?? {};
    const old = [...this.pendingSince].filter(([p, t]) => now - t >= PENDING_OLD_MS && Object.prototype.hasOwnProperty.call(pending, p)).map(([p]) => p).sort();
    return {
      refused: this.refused, down: this.down, freeze: meta?.freeze_reasons ?? [],
      offline,
      nonretryable,
      version,
      notConverged: [...notConverged.keys()],
      notConvergedCauses: notConverged,
      pendingOlderThan60s: old.length > 0,
      deferred: old.length > 0 ? { reason: String(pending[old[0]!]), paths: old } : null,
      // The owed fetch is the headline when both apply: a kept push intent is resolved only after a fetch succeeded. A
      // publish_assert that reached no path (a board-only publish, final review FC-2) still makes the state degraded.
      notConvergedCause: fetchOwed ? 'fetch_owed' : unresolved ? 'push_unresolved'
        : this.publishAssert !== null && ![...notConverged.values()].some((w) => w.cause === 'publish_assert') ? 'publish_assert' : null,
      incident: meta !== null && meta.freeze_reasons.includes('INCIDENT') ? this.incidentParams() : null,
      throttle,
      branchRewritten: this.branch?.value ?? null,
      lastEvent: this.lastEvent,
      counts: {
        csReady: counts.ready, csOpen: counts.open,
        holdsActive: nonTerminal.filter((r) => !r.local_only).length, holdsLocalOnly: nonTerminal.filter((r) => r.local_only).length,
        incoming: meta === null ? 0 : Object.keys(meta.pending).length,
      },
      branch: deps.branch, peerId: core.peerId, pluginVersion: deps.pluginVersion,
      heartbeatMs: deps.heartbeatMs(), loopPeriodMs: this.period,
      lastFetchAgeMs: lastOk === null ? null : now - lastOk,
      lastPushAgeMs: core.lastPushMono === null ? null : now - core.lastPushMono,
    };
  }

  /** status.json on every iteration and transition (ENG-56); a failing write never stops the engine. */
  private async writeStatus(): Promise<void> {
    const s = computeStatus(this.statusInputs());
    this.lastStatus = s;
    try {
      await this.status.write(s);
    } catch (e) {
      if (e instanceof KilledAt) throw e;
      this.core.deps.log.write('warn', 'STATUS_WRITE_FAILED', { code: errnoCode(e) ?? 'unknown' });
    }
  }

  /** The status last written (null before the first write). */
  lastStatusJson(): StatusJson | null {
    return this.lastStatus;
  }
}

// ---- runLoop ------------------------------------------------------------------------------------------------------

/** Production driver: iterate() every LOOP_ACTIVE_MS while active, else LOOP_IDLE_MS (or sooner per nextDueMs), one at a time; drain(IDLE_NO_SESSION) after LEASE_EXIT_MS without a lease. */
export function runLoop(engine: Engine, d: { scheduler: Scheduler; clock: Clock; lease: LeasePort }): LoopHandle {
  let stopping = false;
  let ended = false;
  let gen = 0;
  let running = false;
  let wakeWanted = false;
  let current: Promise<void> = Promise.resolve();
  let resolveFinished!: () => void;
  let rejectFinished!: (e: unknown) => void;
  const finished = new Promise<void>((res, rej) => {
    resolveFinished = res;
    rejectFinished = rej;
  });
  finished.catch(() => undefined);   // the caller decides whether to await it

  const end = (e?: unknown): void => {
    if (ended) return;
    ended = true;
    engine.setWake(null);
    if (e === undefined) resolveFinished();
    else rejectFinished(e);
  };
  const schedule = (delayMs: number): void => {
    const g = ++gen;
    d.scheduler.schedule(() => tick(g), d.clock.monoMs() + Math.max(0, delayMs));
  };
  const idleExit = async (): Promise<boolean> => {
    if (d.lease.idleMs() < LEASE_EXIT_MS) return false;
    await engine.drain('IDLE_NO_SESSION');
    end();
    return true;
  };
  const tick = async (g: number): Promise<void> => {
    if (g !== gen || stopping || ended) return;
    running = true;
    const run = (async (): Promise<void> => {
      try {
        if (await idleExit()) return;
        const rep = await engine.iterate();
        if (stopping || ended) return;
        if (await idleExit()) return;
        if (wakeWanted) {
          wakeWanted = false;
          schedule(0);
        } else {
          schedule(rep.nextDueMs);
        }
      } catch (e) {
        end(e);
      } finally {
        running = false;
      }
    })();
    current = run;
    await run;
  };
  engine.setWake(() => {
    if (ended || stopping) return;
    if (running) wakeWanted = true;
    else schedule(0);
  });
  schedule(0);
  return {
    finished,
    async stop(): Promise<void> {
      if (!ended) {
        stopping = true;
        await current;
        if (!ended) {
          try {
            await engine.drain(null);
            end();
          } catch (e) {
            end(e);
          }
        }
      }
      await finished;
    },
  };
}
