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
//   Plan 3 Task 12a (contract addition 5, the §Interfaces order; Plan 2 Task 17's steps kept in place, the hold steps inserted):
//   5a  a kept push intent resolved first on this iteration's own IterationCtx (P2-PUSHINTENT-FIRST; never a second fetch)
//   3D  detectStep (holdSteps.ts): the transient clocks, the mass-change breaker on the tick, repair/portability/churn; on a
//       materialization the post-resume MASS batch, the revert detector and R-07's eol-bom creation — before any merge or capture
//   4M  maskStep: S_pub := MASK(S_disk) kept in memory with assertSPub (R3-57: HOLD_MASK_INVALID blocks code until the next passing
//       one) and Plan 2's INV-MASK check (ENG-28: a violation stays in status as not_converged{publish_assert}); then captureStep
//       (R3-40: every capture of the loop journals the CS table) — closing captures only when captureDue, edit-checkpoint
//       candidates settled through EngineDeps.editCheck
//   5   applyStep, then recordStep (5R, the loop's only R1 call site; the PREDICATE guards, incomingStep)
//   6   publishStep (it hands the iteration fetch's HTTP throttle signal to the governor; an iteration that never
//       reaches it calls publish.ts's handOverThrottle, Task 14 carry)
//   T   timerStep (HLD-43 nudges; Task 12b: escalationStep — HOLD_CREATED, the +10 min revert event — and s6Step, the 24 h auto-park)
//   7   status.json and the engine events (R-27: status and the daemon log only), then writeCsCache after an iteration that
//       committed state (and, G2 #24, after every Engine operation outside the iteration that did: cacheAfter).
//       Writer.sweepRing stays where Plan 2 Task 17 put it, at the start of prepareIteration (step 1): the next
//       iteration's sweep is the one after this iteration's timers, and a sweep that empties strandedPaths() lets that same
//       iteration materialize and capture.
//   The materialize decision: true while an edit-checkpoint candidate is pending or the post-resume MASS batch is (massResumePending),
//   no restore stranded; else 'auto' (a capture due, an admitted apply), or in an out-of-cycle iteration the capture gate alone
//   (captureDue); holdPaths = the DAT-08 repairs due (repairDue) and, from Task 12b, in a loop iteration the S6 candidates' paths (s6Due).
//   Task 12b: drain() flushes the age anchors and never parks; durabilityReport() and parkAllForStop(leaveOpId) are Plan 7's stop
//   primitives; inspect().restoreOffers lists the PARKED records once the start's TIP is applied (HLD-64).
//   Engine.signal (ENG-13 (b)/(c)) queues a change-set signal through the same queue as every operation and, when it asks, runs one
//   out-of-cycle iteration of steps 0–4 (no 5a, apply, R, publish or T; then status and the CS cache) after the hook-named paths'
//   300 ms quiet period (fix round 1).
//
// The daemon lock (R-26) lives here too: `daemon.js run` and the test fixtures hold <coworkDir>/daemon.lock while an
// Engine starts (restart, ENG-53's own-leftover deletions), recovers or resumes; Engine asserts it at each of them.
import { join } from 'node:path';
import type { Json } from '../board/canonicalJson.js';
import { governorRank, type VersionVerdict } from '../board/fold.js';
import type { PeerId } from '../board/ids.js';
import type { ClaimLabel } from '../board/ops.js';
import type { PushState } from '../board/outbox.js';
import { ABSENT, type Oid } from '../git/oid.js';
import type { Draft, ClaimView, ConfirmResult, PredictQuery, PredictResult, SeatEffect, SeatKey, ViewClaim } from '../claims/types.js';
import type { RevertPrediction } from '../claims/revertPredict.js';
import type { ReadyPair } from '../holds/changesets.js';
import type { DeferReason } from '../holds/groups.js';
import { heldPins, type CsTable } from '../holds/changesets.js';
import { isDurable } from '../holds/mirror.js';
import { guardName, type HoldRecord } from '../holds/record.js';
import type { MirrorRejectReason } from '../holds/registry.js';
import type { CsSignal } from '../holds/signals.js';
import type { TreeMap } from '../git/repo.js';
import { validPathSyntax } from '../sec/validators.js';
import { anchorNow, elapsedMono, machineMonoMs, processStartMonoMs, SUSPEND_GAP_THRESHOLD_MS, suspendGapMs, type Anchor, type Clock } from '../ports/clock.js';
import { KilledAt } from '../ports/crashpoint.js';
import { errnoCode, type Fs } from '../ports/fs.js';
import { LEASE_EXIT_MS, LEASE_STOP_SYNC_MS, type LeasePort } from '../ports/lease.js';
import type { LogParam } from '../ports/log.js';
import type { Scheduler } from '../ports/scheduler.js';
import { applyNeeded, applyStep, type ApplyReport } from './apply.js';
import { heldPathInP } from './assertions.js';
import { predictRevertStep, predictStep, seatEffectStep } from './claimsStep.js';
import { claimsHeld, claimViewOfStep, claimViewStep, verifiedLabelStep } from './labelStep.js';
import {
  attachFlowLoop, captureDue, createEngineCore, currentA, ensureAttrs, ensureRecordAttrs, foldPatch, massResumePending, noteDaemonStarted, phantomPaths,
  prepareIteration, pushStatesOf, readmitApply, tickInputOf, type EngineCore, type IterationCtx,
} from './core.js';
import { buildFlowInputs, hasShadow, type EngineFlowInputs } from './flowInputs.js';
import { captureStep, queueSignal, writeCsCache } from './csStep.js';
import { portabilityStep, repairDue } from './dataRecords.js';
import { breakerTick, revertStep } from './detect.js';
import { detectStep, eolBomCreate, holdAges, holdStatusInputs, maskOf, maskStep, noteEffect, recordStep, settleHoldCode, timerStep } from './holdSteps.js';
import { durabilityOn, durabilityReport, parkAllForStop, RESTORE_NEXT, s6Due, seedEscalation, stopCandidates, type DurabilityReport } from './escalation.js';
import type { EngineDeps } from './deps.js';
import { epochVerdict, INDEX_LOCK_NOTICE_MS, observeEpoch, type EpochObservation } from './epoch.js';
import type { FetchView } from './fetcher.js';
import { liveBase } from './incident.js';
import type { FreezeReason } from './meta.js';
import {
  handOverThrottle, handOverThrottleFor, heldOfTip, lastComposedP, maskedOf, maskInputsOf, mirrorSync, publishStep, publishTreeRefused, resolvePushIntent,
  type PublishReport,
} from './publish.js';
import { clearIncidentIfHealed, enterIncident, incidentStatus, recover, type RecoverResult } from './recover.js';
import { resolve, type ResolveOptions, type ResolveResult, type ResolveVerb } from './resolve.js';
import { StartRefused } from './restart.js';
import { resume, type ResumeReport } from './resume.js';
import { DELETE_CONFIRM_MS, QUIET_MS, SHRINK_STABLE_MS, type Materialized } from './snapshot.js';
import { startDispatch, takeStartCapture, type StartOptions, type StartResult } from './start.js';
import { blockedPublishReason, computeStatus, publishPauseOf, StatusWriter, type NotConvergedWhy, type PublishPause, type StatusInputs, type StatusJson } from './status.js';
import { DAEMON_LOCK_FILE, parseLockHolder as parseHolder, processAlive, type DaemonLockHolder } from './daemonFiles.js';

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
  // ---- Plan 3 Task 12a (the oracles' and tests' inputs) ----
  /** S_pub (EngineCore.sPub's entries): the MASK of the last materialized S_disk; null before the first materialization (R3-19). */
  sPub: TreeMap | null;
  /** The P of the newest composition of this run (publish.ts lastComposedP); null before the first. */
  lastP: TreeMap | null;
  /** The registry head (HoldRegistry.head()); null before the first registry commit. */
  registryHead: Oid | null;
  /** Δmono since each meta.pending path was first seen pending by this Engine (ms). */
  pendingAgeMs: Record<string, number>;
  /** The CS table (ChangeSets.table()). */
  csTable: CsTable;
  /** Per record: durable on the fetched board (isDurable, R3-26), and its local.rejected reason (HOLD_MIRROR_REJECTED). */
  mirror: Record<string, { durable: boolean; rejected: MirrorRejectReason | null }>;
  /** EngineCore.ranges (HLD-21): the held ranges of S_pub's step-5 paths. */
  ranges: Record<string, Array<readonly [number, number]>>;
  /** HoldRegistry.ageMs of every non-terminal record, by id (holdTimersSettled's input, Task 13). */
  holdAgeMs: Record<string, number>;
  /**
   * Plan 3 Task 12b (HLD-64, contract addition 3): this peer's OFF_DISK PARKED record ids, offered for RESTORE — empty until the start's
   * first apply step has run with nothing applicable left (TIP applied); the first time it is non-empty after a start the daemon logs
   * HOLD_PARKED {hids, next: '/cowork resolve <id> --restore'} once.
   */
  restoreOffers: string[];
  /** Plan 4 Task 5 (R1-058): the consumer map's claim inputs — the view over the fold at the leased tip (null until Task 13),
   *  the store's drafts (Task 11 fills them), the CS blocks as [csId, overlaps] pairs (R4-28) and the fold's claim order
   *  (Folder.claimOrder, Task 8; an empty Map until then). */
  claims: { view: ClaimView | null; drafts: readonly Draft[]; blocked: ReadonlyArray<readonly [string, string]>; order: ReadonlyMap<string, number> };
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
  /** Plan 3 Task 12a: the IterationCtx of the newest prepared iteration (holdStatusInputs reads its tick). */
  private lastIt: IterationCtx | null = null;
  /** Plan 3 Task 12a (R3-61): the core.holdCode last taken into lastEvent (a newer object is a newer hold code). */
  private seenHoldCode: EngineCore['holdCode'] = null;
  /** Plan 3 Task 12a (ENG-13): the out-of-cycle iteration requested and not started yet (signals arriving meanwhile join it). */
  private outOfCycle: Promise<IterationReport | null> | null = null;
  /** The Δmono at which the last out-of-cycle iteration started (one per loop slot, ENG-13). */
  private outOfCycleStart: number | null = null;
  /** Plan 3 Task 12b (carry 6): signals delivered before a start succeeded, replayed by it (replayEarlySignals). */
  private readonly earlySignals: CsSignal[] = [];
  /** Plan 3 Task 12b (HLD-64): this start's TIP has been applied (an apply step ran with nothing applicable left). */
  private tipApplied = false;
  /** Plan 3 Task 12b (HLD-64): the start's HOLD_PARKED {hids, next} line was logged. */
  private offersLogged = false;

  private constructor(core: EngineCore) {
    this.core = core;
    this.peerId = core.peerId;
    const { coworkDir } = core.deps.paths;
    this.status = new StatusWriter(core.deps.ports.fs, join(coworkDir, 'status.json'), join(coworkDir, 'tmp'), core.deps.ports.clock);
    this.createdMono = core.deps.ports.clock.monoMs();
    // Plan 3 Task 12b (HLD-60): the records the registry re-attached at core creation (HLD-01) are no new creations.
    seedEscalation(core);
    // Plan 3 Task 18 (fix round 1, finding 10): the flow reads the publish pause status.json shows and the loop period this Engine chose.
    attachFlowLoop(core, () => ({ paused: publishPauseOf(this.pauseInputs()) !== null, loopPeriodMs: this.period }));
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

  /**
   * G2 #24 (HLD-36, R3-40, R3-69): an Engine operation outside the iteration — start, recover, resume, resolve, the stop's durability
   * report and park — that committed state (a park's snap transition and withdrawal, a resolve's registry-driven state updates, a
   * restart's settlement, a recover's re-anchor, resume's MASS lift, setEpochFreeze) or changed the change-set table's membership (a
   * --publish's observe, a start's restore) rewrites the CS cache as finish() does after an iteration: readCsCache accepts a cache only
   * when it names the current state commit, so a crash before the next state-committing iteration would otherwise lose every open
   * change-set's membership and fold its deltas into one recovered CS. Written only when `fn` returns and `keep(result)` holds (a crash
   * or a throw writes nothing, as a killed process would not), and only by an Engine whose start succeeded: a `daemon.js recover` or
   * `daemon.js resume` process never restored the table (attachCsTable runs at start), so its empty table must not become a cache that
   * names the new state commit.
   */
  private async cacheAfter<T>(fn: () => Promise<T>, keep: (r: T) => boolean = () => true): Promise<T> {
    const core = this.core;
    const commit = core.view?.commit ?? null;
    const before = membership(core);
    const r = await fn();
    if (keep(r) && this.started && core.view !== null && (core.view.commit !== commit || membership(core) !== before)) await writeCsCache(core);
    return r;
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
    return this.exclusive(() => this.cacheAfter(async () => {
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
        // Plan 3 Task 12b (HLD-64): RESTORE is offered only after this start's TIP has been applied.
        this.tipApplied = false;
        this.offersLogged = false;
        this.core.deps.log.write('info', 'STARTED', { mode: r.mode });
        const lost = r.restart?.lostState ?? null;
        if (lost !== null) this.event('warn', 'LOST_STATE', { mode: lost.mode, records: lost.records.length, paths: lost.paths.length });
        // Plan 3 Task 12b (carry 6): the signals delivered before this start, replayed into the restored change-set table.
        await this.replayEarlySignals();
        if (takeStartCapture(this.core)) await this.captureAtStart();
        // Plan 3 Task 18 (F14): the detection ticks this start ran set the flow's start anchors (FEAT-F14-14).
        noteDaemonStarted(this.core);
      } else {
        this.refused = { code: r.code, params: r.params };
        this.core.deps.log.write('warn', r.code, logParams(r.params));
      }
      await this.writeStatus();
      return r;
    }, (r) => r.ok));
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
    return this.exclusive(() => this.cacheAfter(async () => {
      await this.assertLock('recover');
      this.views = [];
      const r = await recover(this.core, confirm);
      if (r.ok && r.done) this.event('info', 'RECOVERED', { mode: r.preview.mode });
      await this.writeStatus();
      return r;
    }));
  }

  /**
   * The human's resume (Plan 3 Task 8; R-28 extended, ENG-45, HLD-31; rulings R3-38, R3-39): resume.ts's resume() under
   * daemon.lock, queued behind the iteration in flight — meta.nonretryable and the rejection streak cleared, the host-reject guard
   * of the record meta.nonretryable names released (the pathless PIN ends SUBSUMED, guards kept), MASS lifted with
   * snap_pre_freeze kept for the post-resume batch; one registry commit before one state CAS, so a crash between the two leaves
   * the pause (the next resume clears it). All false, and nothing written, when nothing is pending.
   */
  resume(): Promise<ResumeReport> {
    return this.exclusive(() => this.cacheAfter(async () => {
      await this.assertLock('resume');
      // Final review F12: the host-reject guard's release rev recomputes local_only (R3-12) — in `daemon.js resume`, before any iteration.
      await scopeRecordPaths(this.core, 'resume');
      return resume(this.core);
    }));
  }

  /**
   * `/cowork resolve` (Plan 3 Task 11; R3-02, F-HLD-1 engine part): between iterations, never overlapping iterate() (queued behind the
   * operation in flight, like every Engine operation), under daemon.lock. A fresh fetch first: one prepareIteration with a forced fetch
   * that materializes the record's paths (PrepareOptions.holdPaths, the hold-record occasion), then resolve.ts's resolve() on it and
   * status.json. A record this registry does not hold but the fresh fold names (HLD-64's copy-restore of a left peer's record) gets a
   * second iteration materializing the fold's paths for it. An iteration that cannot be prepared (an incident, no state) throws.
   * The loop's gates first (Task 11 fix round 1 ruling): 0b and 0c exactly as iterate() runs them (trackIndexLock, the epoch verdict
   * and setEpochFreeze — FREEZE(EPOCH) set or lifted by the same state update and board-only event), and under either the iterations
   * only fetch and fold (no ring sweep, tick, observation or materialization), so resolve()'s writeGate answers a verb that would write
   * with locked ['.git/index.lock'] or HOLD_FROZEN. A forced fetch that did not succeed (failed, or deferred inside a backoff) is
   * refused with the loop's FETCH_OWED {hid, local} before resolve() runs: no answer, not even HOLD_ALREADY_RESOLVED, comes from a
   * stale fold (HLD-57 (b)).
   */
  resolve(id: string, verb: ResolveVerb, o: ResolveOptions): Promise<ResolveResult> {
    return this.exclusive(() => this.cacheAfter(async () => {
      await this.assertLock('resolve');
      const core = this.core;
      if (!this.started || core.view === null) throw new Error('Engine.resolve: start() has not succeeded');
      // 0b index.lock and 0c the epoch, as iterateNow runs them.
      const obs = await observeEpoch(core.repo, core.deps.ports.fs);
      const lockOnly = this.trackIndexLock(obs, core.deps.ports.clock.monoMs());
      const epochFrozen = epochVerdict(obs, core.view.meta.expected_epoch) === 'FREEZE';
      await this.setEpochFreeze(epochFrozen, obs);
      const fetchFoldOnly = lockOnly || epochFrozen;
      const prepare = async (paths: readonly string[], forceFetch: boolean): Promise<IterationCtx | ResolveResult> => {
        this.views = [];
        const p = await prepareIteration(core, ++this.n, { materialize: false, forceFetch, fetchFoldOnly, holdPaths: new Set(paths) });
        if (p.ok) {
          // Final review F11: its tick and its hold-path materialization meet step D before resolve() decides anything.
          await detectOutOfLoop(core, p.it);
          return p.it;
        }
        // Plan 3 Task 12b (carry 2): a live INCIDENT (no trusted TIP to answer from, HLD-57 (b)) is a coded refusal with its next command
        // (HOLD_FROZEN: `/cowork status` shows the incident and its recover step), never a throw (`daemon.js resolve` exit 2); the loop's
        // own iteration enters or keeps the incident. A snapshot that failed is "repeat the command" (HOLD_DISK_CHANGED).
        await this.writeStatus();
        if (p.why === 'incident') return { kind: 'refused', code: 'HOLD_FROZEN', params: { hid: id, reason: 'INCIDENT' } };
        if (p.why === 'snapshot_failed') return { kind: 'refused', code: 'HOLD_DISK_CHANGED', params: { hid: id } };
        if (p.why === 'config_net') return { kind: 'refused', code: 'HOLD_FROZEN', params: { hid: id, reason: 'CONFIG' } };
        throw new Error(`Engine.resolve: the iteration could not be prepared (${p.why})`);
      };
      const first = await prepare(core.holds.get(id)?.paths ?? [], true);
      if ('kind' in first) return first;
      let it = first;
      const f = it.fetched;
      if (f === null || f.deferred || !f.ok) {
        await this.writeStatus();
        return { kind: 'refused', code: 'FETCH_OWED', params: { hid: id, local: f !== null && !f.deferred && f.localFailure } };
      }
      const folded = core.holds.get(id) === undefined && Object.hasOwn(it.fold.holds, id) ? it.fold.holds[id] : undefined;
      if (folded !== undefined && folded.paths.length > 0) {
        const second = await prepare(folded.paths, false);
        if ('kind' in second) return second;
        it = second;
      }
      const r = await resolve(core, it, id, verb, o);
      await this.writeStatus();
      return r;
    }));
  }

  /** R-28's verb, now Engine.resume(): its report's `nonretryable` (a NONRETRYABLE pause or a rejection streak was cleared). */
  async resumeAfterNonretryable(): Promise<boolean> {
    return (await this.resume()).nonretryable;
  }

  /**
   * ENG-13 (b)/(c) (Plan 3 Task 12a; R3-05, R3-41, CS-09): a change-set signal (a seat effect, prompt, boundary, checkpoint, checks_run,
   * idle_10min or activity) queued into the CS table through queueSignal — inside the Engine's one queue, so never during start or
   * restart (its restore and R-01 re-form), an iteration or a resolve — with writeCsCache when it changed the table's membership (an
   * effect also starts HLD-43's uncovered-effect clock). When it asks for an out-of-cycle iteration (a boundary, a checkpoint, an
   * idle_10min that closed a CS) and the engine has started, it waits until the hook-named paths are past the 300 ms quiet period
   * (01-engine §3.8 step 2, never waived for them, test 55) and runs one out-of-cycle iteration of steps 0–4 (01-engine §3.5 (b)/(c),
   * ENG-13: gates, fetch, fold, snapshot, the outgoing guards and the capture — no apply, no publish, no timers; iterateNow's
   * 'outOfCycle' mode) through the same queue: a request made while one waits to start joins it, so at most one is in flight and one
   * waits; a boundary's starts at once, while an edit checkpoint's waits for the end of the previous out-of-cycle iteration's loop slot
   * (LOOP_ACTIVE_MS after it started), so edit checkpoints arriving meanwhile coalesce into one iteration per slot. Resolves after that
   * iteration's capture step — its capture journaled, status and the CS cache written (fix round 1 ruling); the apply and the publish of
   * what it captured are the next loop iteration's. A signal made while start() runs is queued behind it. Plan 3 Task 12b (carry 6): a
   * signal made before any start() succeeded touches nothing — the start's restore would rebuild the table without it — and is kept,
   * in order, and replayed by the successful start right after its restore (replayEarlySignals).
   */
  async signal(s: CsSignal): Promise<void> {
    const core = this.core;
    const clock = core.deps.ports.clock;
    const ask = await this.exclusive(async () => {
      if (!this.started) {
        this.earlySignals.push(s);
        return false;
      }
      const before = membership(core);
      const asks = queueSignal(core, s);
      if (s.kind === 'effect') noteEffect(core, s.seat);
      if (core.view !== null && membership(core) !== before) await writeCsCache(core);
      return asks;
    });
    if (!ask || !this.started || this.drainedFlag) return;
    if (s.kind === 'checkpoint') await this.quiet(s.paths);
    let run = this.outOfCycle;
    if (run === null) {
      run = (async (): Promise<IterationReport | null> => {
        // ENG-13: a boundary starts its iteration at once; edit checkpoints coalesce into one out-of-cycle iteration per loop slot
        // (test 55): a checkpoint inside the slot of the previous out-of-cycle iteration waits for the slot's end.
        const wait = s.kind !== 'checkpoint' || this.outOfCycleStart === null ? 0 : this.outOfCycleStart + LOOP_ACTIVE_MS - clock.monoMs();
        if (wait > 0) await clock.sleep(wait);
        return this.exclusive(async () => {
          this.outOfCycle = null;
          this.outOfCycleStart = clock.monoMs();
          return this.drainedFlag ? null : this.iterateNow('outOfCycle');
        });
      })();
      this.outOfCycle = run;
    }
    await run;
  }

  /**
   * Plan 3 Task 12b (carry 6): the signals delivered before this start, in order, into the change-set table the start restored (its
   * journaled table and cache, R3-69), the CS cache written when they changed its membership; one that asks for an out-of-cycle
   * iteration wakes the loop (its next iteration runs at once and captures what is due).
   */
  private async replayEarlySignals(): Promise<void> {
    const core = this.core;
    const early = this.earlySignals.splice(0);
    if (early.length === 0) return;
    const before = membership(core);
    let asks = false;
    for (const s of early) {
      if (queueSignal(core, s)) asks = true;
      if (s.kind === 'effect') noteEffect(core, s.seat);
    }
    if (core.view !== null && membership(core) !== before) await writeCsCache(core);
    if (asks) this.wake?.();
  }

  /** ENG-13 / 01-engine §3.8 step 2 for hook-named paths: waits (Clock.sleep) until each existing path's mtime is ≥ 300 ms old on this PC's wall clock; a future mtime waits for 300 ms of an unchanged stat. */
  private async quiet(paths: readonly string[]): Promise<void> {
    const { fs, clock } = this.core.deps.ports;
    const workTree = this.core.deps.paths.workTree;
    const future = new Map<string, bigint>();
    for (let round = 0; round < 100; round++) {
      let wait = 0;
      for (const p of paths) {
        if (!validPathSyntax(p)) continue;
        let st;
        try {
          st = await fs.lstat(join(workTree, ...p.split('/')));
        } catch {
          continue;
        }
        if (st === null) continue;
        const age = clock.wallMs() - Number(st.mtimeNs / 1_000_000n);
        if (age >= QUIET_MS) continue;
        if (age < 0) {
          // A future mtime: quiet once its stat stayed unchanged for one quiet period.
          if (future.get(p) === st.mtimeNs) continue;
          future.set(p, st.mtimeNs);
          wait = Math.max(wait, QUIET_MS);
        } else {
          wait = Math.max(wait, QUIET_MS - age);
        }
      }
      if (wait <= 0) return;
      await clock.sleep(wait);
    }
  }

  /** HLD-21 (Plan 5's G1 deny reads it): the held ranges of `path` in S_pub — 1-based inclusive stored-form rows; [] for a path with none (a PIN path, a whole-path record). */
  heldRanges(path: string): ReadonlyArray<readonly [number, number]> {
    return this.core.ranges.get(path) ?? [];
  }

  /**
   * Plan 3 Task 18 (rev 2.5, F14; X-11, UX-33): F14's engine inputs, from the last iteration's in-memory state — synchronous, no git
   * process, no Fs call, no write (flowInputs.ts buildFlowInputs); not queued behind the operation in flight.
   */
  flowInputs(): EngineFlowInputs {
    return buildFlowInputs(this.core);
  }

  /** Plan 3 Task 18 (X-11): stage O9's test for one path — a member path of an open seat CS a non-terminal SHADOW names (flowInputs.ts hasShadow). */
  hasShadow(path: string): boolean {
    return hasShadow(this.core, path);
  }

  // ---- Plan 4 Task 5 (R1-058): the consumer map on the engine — stubs until Tasks 11–13 bind the real steps ----

  /** CONFIRM's seat effect (Task 11 binds). */
  seatEffect(e: SeatEffect): Promise<ConfirmResult> {
    return seatEffectStep(this.core, e);
  }

  /** PREDICT (Task 11 binds). */
  predict(q: PredictQuery): Promise<PredictResult> {
    return predictStep(this.core, q);
  }

  /** The claim view over the fold at the leased tip (Task 13 binds). */
  claimView(): ClaimView | null {
    return claimViewStep(this.core);
  }

  /** The F05 reader-seat view (Task 13 binds). */
  claimViewOf(reader: SeatKey): readonly ViewClaim[] {
    return claimViewOfStep(this.core, reader);
  }

  /** The verified label (REG-34; Task 13 binds). */
  verifiedLabel(claimId: string, anchor: Oid): ClaimLabel | null {
    return verifiedLabelStep(this.core, claimId, anchor);
  }

  /** REV step 6's prediction (Task 12 binds). */
  predictRevert(results: ReadonlyMap<string, Buffer | 'ABSENT'>, tip: Oid): Promise<RevertPrediction> {
    return predictRevertStep(this.core, results, tip);
  }

  /** The last status.json and what the SIM oracles read. */
  async inspect(): Promise<EngineInspection> {
    const core = this.core;
    const view = core.view;
    if (view === null) throw new Error('Engine.inspect: no state (start first)');
    const inputs = this.statusInputs();
    const status = computeStatus(inputs);
    const now = core.deps.ports.clock.monoMs();
    const fp = foldPatch(core);
    const fold = fp?.fold ?? view.fold;
    const board = fp?.meta.fold_board ?? view.meta.fold_board;
    const held = board === null ? null : await heldOfTip(core, board);
    const rejected = core.holds.local().rejected;
    const mirror: EngineInspection['mirror'] = {};
    for (const r of core.holds.all()) {
      mirror[r.id] = { durable: fold !== null && held !== null && isDurable(r, fold.holds[r.id], held.get(r.id) ?? null), rejected: rejected[r.id]?.reason ?? null };
    }
    return {
      peerId: this.peerId, laC: view.laC, laB: view.laB, aTree: view.base, snapTree: view.snap, epochBase: view.meta.EPOCH_BASE,
      freeze: [...view.meta.freeze_reasons], publishPause: status.publish_pause,
      pending: { ...view.meta.pending }, notConverged: [...status.pending.not_converged],
      holds: [...core.holds.all()], ready: [...core.cs.ready()], pushAttempts: core.pushAttempts, status,
      notConvergedWhy: Object.fromEntries(inputs.notConvergedCauses ?? []),
      sPub: core.sPub === null ? null : new Map(core.sPub.entries), lastP: lastComposedP(core), registryHead: core.holds.head(),
      pendingAgeMs: Object.fromEntries([...this.pendingSince].map(([p, t]) => [p, now - t])),
      csTable: core.cs.table(), mirror,
      ranges: Object.fromEntries([...core.ranges].map(([p, r]) => [p, [...r]])),
      holdAgeMs: holdAges(core),
      restoreOffers: this.restoreOffers(),
      claims: { view: claimViewStep(core), drafts: core.claims.drafts(), blocked: [...core.claims.blockedAll()], order: new Map() },
    };
  }

  /**
   * ENG-55 / CCI-50: finish the operation in flight, write status.json `down` (IDLE_NO_SESSION or no code); no iteration after it.
   * Plan 3 Task 12b (HLD-63, 05 §2, R3-45, B1): every non-terminal record's accumulated Δmono is flushed into its age_anchor in one
   * registry commit with no hold op (HoldRegistry.flushAgeAnchors), so a restart keeps the ages; drain never parks (a daemon exiting
   * on lease loss or IDLE_NO_SESSION must not, HLD-63 — the stop's park is parkAllForStop, Plan 7's).
   */
  drain(downCode: 'IDLE_NO_SESSION' | null): Promise<void> {
    return this.exclusive(async () => {
      if (this.drainedFlag) return;
      this.drainedFlag = true;
      this.down = { code: downCode };
      // Final review F12: the age-anchor revs recompute local_only (R3-12), also in a process that never prepared an iteration
      // (`daemon.js resume`, a recover or resolve whose start was refused, a crash inside start). Ruling R3-FF2-C1: an Engine with
      // no state (a lost or too-new state at create: resume, resolve's HOLD_NOT_OWNER, recover's RECOVER_NOT_IN_INCIDENT, a crash
      // before the start attached one) has no EPOCH_BASE to scope at, so its revs carry local_only unchanged.
      await scopeRecordPaths(this.core, 'drain');
      await this.core.holds.flushAgeAnchors({ carryLocalOnly: this.core.view === null });
      this.core.deps.log.write('info', 'DRAINED', { code: downCode });
      await this.writeStatus();
    });
  }

  /**
   * HLD-62 / HLD-63 step 2 for Plan 7's stop (Plan 3 Task 12b, R3-45): queued behind the operation in flight, one fetch and fold (a
   * fetch-and-fold-only prepareIteration: no ring sweep, tick or materialization), then escalation.ts's durabilityReport against the
   * fetched board tip. A fold that cannot be had (an incident: no trusted TIP) reports against the last folded board of the state.
   */
  durabilityReport(): Promise<DurabilityReport> {
    return this.exclusive(() => this.cacheAfter(async () => {
      const core = this.core;
      if (!this.started || core.view === null) throw new Error('Engine.durabilityReport: start() has not succeeded');
      this.views = [];
      const p = await prepareIteration(core, ++this.n, { materialize: false, forceFetch: true, fetchFoldOnly: true });
      if (p.ok) return durabilityReport(core, p.it);
      const fp = foldPatch(core);
      return durabilityOn(core, fp?.fold ?? core.view.fold, fp?.meta.fold_board ?? core.view.meta.fold_board);
    }));
  }

  /**
   * HLD-63 step 3 for Plan 7's stop (Plan 3 Task 12b, R3-45): after Plan 7 allocated the `leave` op's seq, every ON_DISK PATCH/PIN with
   * local_only false is parked with displaced_by = leaveOpId (escalation.ts parkAllForStop), in one iteration that materializes their
   * paths (PrepareOptions.holdPaths, no forced fetch: the stop's step 1 fetched) — and another such iteration whenever a candidate's path
   * was rewritten by an earlier park of this stop (ruling R3-FF2-C2) — then the mirrors of every registry change it made — the
   * parks, and a refresh rev a `failed` record committed (fix round 1) — are drafted (mirrorSync; the stop's final publish carries them)
   * and status.json written. The loop's 0b/0c gates first: under .git/index.lock or FREEZE(EPOCH) (a human
   * git operation owns the work tree) nothing is written and every record is `failed`, as when the iteration cannot be prepared.
   */
  parkAllForStop(leaveOpId: string): Promise<{ parked: string[]; companions: string[]; failed: string[] }> {
    return this.exclusive(() => this.cacheAfter(async () => {
      await this.assertLock('parkAllForStop');
      const core = this.core;
      if (!this.started || core.view === null) throw new Error('Engine.parkAllForStop: start() has not succeeded');
      const candidates = stopCandidates(core);
      const all = { parked: [] as string[], companions: [] as string[], failed: candidates.map((r) => r.id) };
      if (candidates.length === 0) return { ...all, failed: [] };
      const obs = await observeEpoch(core.repo, core.deps.ports.fs);
      if (obs.indexLock.present || epochVerdict(obs, core.view.meta.expected_epoch) === 'FREEZE') return all;
      this.views = [];
      const p = await prepareIteration(core, ++this.n, { materialize: false, forceFetch: false, holdPaths: new Set(candidates.flatMap((r) => r.paths)) });
      if (!p.ok) return all;
      const head = core.holds.head();
      // Final review F11: step D on this tick and materialization before any park reads its S_disk; a revert record it makes on a candidate's
      // path is a candidate itself (escalation.ts reads stopCandidates again) and is drafted below with the parks.
      await detectOutOfLoop(core, p.it);
      // Ruling R3-FF2-C2 (HLD-63 step 3): a candidate on a path an earlier park of this stop rewrote parks on a fresh materialization of
      // the remaining candidates' paths — after the quiet period of the bytes that park just wrote (the tick excludes a path younger than
      // QUIET_MS, and an excluded path has no current S_disk), and with step D on it as on the first.
      // Integration I-4 (r2 rereview C): a park that shrank a path by more than 50 % leaves it excluded as 'shrink' on that fresh tick (the
      // stat cache still has the pre-park size; R-25 confirms a shrink by a second sighting >= SHRINK_STABLE_MS later), and an excluded
      // path has no current S_disk either: the stop waits that interval once and prepares again (one more tick, step D on it too). The
      // same holds for a 'deletion_pending' removal (DELETE_CONFIRM_MS); a park's own deletion never is one (its private-index entry goes).
      let last = p.it;
      const rematerialize = async (paths: readonly string[]): Promise<IterationCtx | null> => {
        await this.quiet(paths);
        let it: IterationCtx | null = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          if (attempt > 0) await core.deps.ports.clock.sleep(Math.max(SHRINK_STABLE_MS, DELETE_CONFIRM_MS));
          this.views = [];
          const q = await prepareIteration(core, ++this.n, { materialize: false, forceFetch: false, holdPaths: new Set(paths) });
          if (!q.ok) return null;
          await detectOutOfLoop(core, q.it);
          last = q.it;
          it = q.it;
          const excluded = q.it.tick?.excluded;
          if (excluded === undefined || !paths.some((x) => excluded.get(x) === 'shrink' || excluded.get(x) === 'deletion_pending')) break;
        }
        return it;
      };
      const r = await parkAllForStop(core, p.it, leaveOpId, rematerialize);
      // Fix round 1 (minor a): any registry change is drafted — a park, and also a refresh rev committed by a park that then
      // reported REFRESHED (its record `failed` until that rev is durable, R3-45): the stop's final publish carries it.
      if (core.holds.head() !== head) await mirrorSync(core, last);
      await this.writeStatus();
      return r;
    }));
  }

  // ---- one iteration ----------------------------------------------------------------------------------------------

  /**
   * One iteration. `mode` 'loop' (iterate(), runLoop) runs the whole of 01-engine §3.5; 'outOfCycle' (Engine.signal: a change-set
   * boundary (b) or an edit checkpoint (c), ENG-13; Plan 3 Task 12a fix round 1, finding 2) runs steps 0–4 only — the step-0 gates,
   * prepareIteration (sweep, fetch, incident check, fold, tick, materialize), the incident branch, the R-08 classification, detectStep,
   * maskStep with the INV-MASK check and captureStep — and then step 7 (status, the iteration trace, writeCsCache always): no push intent
   * resolution (step 6's classification; captureStep already keeps a kept intent's pairs and settles no candidate while one is kept),
   * no apply, recordStep, publishStep or timerStep. The iteration fetch's throttle signal still reaches the governor (publishStep is not
   * reached). Its materialize decision never asks for an apply's objects: true for a pending edit checkpoint, the post-resume MASS
   * batch or a due capture (no restore stranded), else false.
   */
  private async iterateNow(mode: 'loop' | 'outOfCycle' = 'loop'): Promise<IterationReport> {
    const oneShot = mode === 'outOfCycle';
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
    const commitBefore = core.view.commit;
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
    // R3-EF4-26: this one lease read is the iteration's (PrepareOptions.leaseIdleMs): its capture gate and materialization below, and the
    // apply admission prepareIteration decides with them — a lease renewed during the fetch never admits an apply this iteration did not
    // materialize for (it would materialize after detectStep).
    const leaseIdleMs = deps.lease.idleMs();
    const leaseStopped = leaseIdleMs >= LEASE_STOP_SYNC_MS;
    const fetchFoldOnly = lockOnly || epochFrozen;
    const captureAllowed = !fetchFoldOnly && !leaseStopped;

    // 1–3. Plan 3 Task 12a (contract addition 5): materialize while an edit-checkpoint candidate is pending or the post-resume MASS
    // batch is (no restore stranded), else 'auto'; the DAT-08 repairs due materialize their paths (W6 (c)). An out-of-cycle iteration
    // (steps 0–4) has no apply to materialize for: 'auto' becomes the capture gate alone (captureDue, false while a restore is stranded).
    const forced = (core.cs.pendingCandidates().length > 0 || massResumePending(core)) && core.writer.strandedPaths().length === 0;
    const materialize: boolean | 'auto' = !captureAllowed ? false : forced ? true : oneShot ? captureDue(core) : 'auto';
    // Plan 3 Task 12b: and the paths of the records old enough for S6 (HLD-61), so the loop that parks them has a current S_disk — in a
    // loop iteration only (fix round 1, minor c): s6Step runs in timerStep, which an out-of-cycle iteration (steps 0–4) never reaches.
    const holdPaths = captureAllowed ? new Set([...repairDue(core), ...(oneShot ? [] : await s6Due(core))]) : new Set<string>();
    const prepared = await prepareIteration(core, n, { materialize, forceFetch: force, fetchFoldOnly, leaseIdleMs, ...(holdPaths.size > 0 ? { holdPaths } : {}) });
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
      this.lastIt = it;
      // An incident that healed by itself (its check passes again) is UNFROZEN (01-engine §3.7, R-27).
      if (await clearIncidentIfHealed(core, it)) {
        this.event('info', 'UNFROZEN', { reasons: ['INCIDENT'] });
        // R3-EF4-26: the heal changed the freeze set prepareIteration decided the apply admission with; decided again before detectStep
        // (an out-of-cycle iteration never applies: no materialization for it).
        if (!oneShot) await readmitApply(core, it);
      }
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
        handOverThrottleFor(core, it, fetchedNow);
      } else if (epochFrozen) {
        // R-09 / glossary §8: no capture, apply or work-tree write; the board-only freeze event may leave (step 6: not out of cycle).
        if (oneShot) {
          handOverThrottleFor(core, it, fetchedNow);
        } else {
          const publish = this.notePublish(await publishStep(core, it));
          if (publish.outcome === 'landed') landed = true;
        }
      } else {
        // 5a P2-PUSHINTENT-FIRST (Task 12a order): a kept push intent is resolved on this iteration's own context, before any hold
        // step, capture or apply — never by a second fetch, and only with a fetch of this iteration that succeeded (owed: none did).
        // Task 19 ruling (fix round 3) carried: a pair the intent names is never shrunk while it is kept; resolved first, a discarded
        // intent's deferred path re-closes in this iteration's capture below (A unchanged), a landed one's in the capture over the new A.
        // An out-of-cycle iteration (steps 0–4) leaves the intent to the next loop iteration (its classification is step 6's).
        if (!oneShot && core.view!.intent.kind === 'push' && this.owed === null) {
          const r = await resolvePushIntent(core, it);
          if (r.outcome === 'landed') landed = true;
        }
        // A capture that fell due without prepare's materialization materializes here — never while a TXN is open (06 §3.7.3:
        // "no snapshot and no apply"; F2 #104): it.txnOpen = a TXN was open when this iteration decided its tick (no tick ran,
        // so a materialization now would capture a stage the TXN's writes may have overtaken); the live read = a TXN opened
        // after the prepare. The capture waits for the iteration after the close.
        if (captureAllowed && !it.txnOpen && !core.deps.claude.txnOpen() && captureDue(core) && it.mat === null) {
          it.mat = await core.snapshot.materialize(tickInputOf(core, it));
          await ensureAttrs(core, it.epochBase, it.mat.sDiskMap.keys());
        }
        // 3D: before any merge or capture (ENG-14).
        await detectStep(core, it);
        // 4M: S_pub with assertSPub (R3-57) and Plan 2's INV-MASK check (ENG-28: a violation aborts the capture and every publish of
        // this iteration and stays in status as not_converged{publish_assert} until an iteration passes the check).
        let maskOk = true;
        if (it.mat !== null) {
          const held = await this.sPubHolds(it, it.mat);
          this.maskViolation = held;
          if (held !== null) {
            maskOk = false;
            deps.log.write('error', 'NOT_CONVERGED', { cause: 'publish_assert', check: held.check, path: held.path });
          }
        }
        // The capture (R3-40): closing captures when captureDue, edit-checkpoint candidates; P2-STRANDED-SKIP inside.
        if (captureAllowed && maskOk) await captureStep(core, it);
        if (oneShot || this.owed !== null) {
          // ENG-13 (b)/(c): an out-of-cycle iteration ends after step 4. LIF-39: a fetch is owed since a suspend; the capture above went
          // on, no apply or publish decision.
          handOverThrottleFor(core, it, fetchedNow);
        } else {
          apply = await applyStep(core, it);
          // 5R: R1 and the PREDICATE guards after the writes (HLD-08).
          await recordStep(core, it, apply);
          if (maskOk) {
            const publish = this.notePublish(await publishStep(core, it));
            if (publish.outcome === 'landed') landed = true;
          } else {
            handOverThrottleFor(core, it, fetchedNow);
          }
          if (apply.ran) this.countDeferrals();
        }
      }
      // T (contract addition 8); not in an out-of-cycle iteration (steps 0–4).
      if (!oneShot) await timerStep(core, it);
      applyPending = applyNeeded(core, it);
      // HLD-64 (Task 12b): the start's TIP is applied once an apply step ran and nothing applicable is left.
      if (apply !== null && !applyPending) this.tipApplied = true;
    }
    return this.finish(n, pushesBefore, apply, landed, applyPending, commitBefore, oneShot);
  }

  /**
   * 7: the iteration's bookkeeping, events, status.json, trace and report; its end anchors the next Δmono check. Plan 3 Task 12a:
   * writeCsCache after an iteration that committed state (R3-40, HLD-36), and always after an out-of-cycle one (`cache`: Engine.signal
   * resolves once that iteration's status and cache are written, fix round 1 ruling).
   */
  private async finish(n: number, pushesBefore: number, apply: ApplyReport | null, landed: boolean, applyPending: boolean, commitBefore: Oid, cache = false): Promise<IterationReport> {
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
    this.noteRestoreOffers();
    await this.writeStatus();
    if (cache || core.view!.commit !== commitBefore) await writeCsCache(core);
    const fetched = this.views.some((x) => x.ok);
    const applied = apply?.ran === true;
    const pushes = core.pushAttempts - pushesBefore;
    core.deps.trace.emit({ kind: 'iteration', peer: core.peerId, n, fetched, applied, pushes });
    this.prevEnd = anchorNow(clock);
    return this.report(n, fetched, apply, landed, active, true, pushes);
  }

  /** HLD-64 (Task 12b, contract addition 3): this peer's OFF_DISK PARKED records, offered for RESTORE once the start's TIP is applied. */
  private restoreOffers(): string[] {
    if (!this.tipApplied) return [];
    return this.core.holds.nonTerminal().filter((r) => r.residence === 'OFF_DISK' && r.state === 'PARKED' && r.owner === this.peerId).map((r) => r.id);
  }

  /** The first time the offers are non-empty after a start: HOLD_PARKED {hids, next} in the daemon log, once. */
  private noteRestoreOffers(): void {
    if (this.offersLogged) return;
    const offers = this.restoreOffers();
    if (offers.length === 0) return;
    this.offersLogged = true;
    this.core.deps.log.write('info', 'HOLD_PARKED', { hids: offers.join(','), next: RESTORE_NEXT });
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
   * Step 4 M (Plan 3 Task 12a): maskStep (holdSteps.ts: S_pub := MASK(S_disk) kept in EngineCore.sPub, assertSPub with R3-57's
   * EngineCore.maskInvalid, the held ranges, the `mask` trace), then Plan 2's INV-MASK check over S_pub (ENG-28: no held path
   * differs from A; a step-5 partial path differs by design, so `masked` is compose's per-path formula, maskedOf). The violation, or
   * null — also when MASK could not run (05 F1: maskStep raised HOLD_MASK_INVALID; no code is published while it holds).
   */
  private async sPubHolds(it: IterationCtx, mat: Materialized): Promise<MaskViolation | null> {
    const core = this.core;
    if (it.mat !== mat) throw new Error('sPubHolds: not this iteration\'s materialization');
    await maskStep(core, it);
    const m = maskOf(core, it);
    if (m === null) return null;
    const inp = maskInputsOf(core, it, core.holds.maskingRecords());
    const held = heldPathInP(it.A, m.entries, maskedOf(inp, m.withheld), (p) => it.scope(p).cls);
    return held === null ? null : { path: held.path, check: held.letter };
  }

  /**
   * R-22 'all' (final review FC-8): the local work M a genesis or join closed (start.ts captureLocalWork) is captured at
   * once, by step 4 like every capture — the R-07 eol-bom holds, S_pub := MASK(S_disk) with INV-MASK, the captureDue gate
   * — so its change-set holds what was on disk at the start, and an edit made after it waits its own quiet period. What
   * cannot run here (an incident or another failed prepare, an INV-MASK violation, a stranded restore, no lease) leaves
   * the CS closed for the loop's first capture.
   * Plan 3 Task 12b: this first detection tick runs portabilityStep before anything publishes (R3-53: blocked() holds a name no
   * record can carry, so no group of the human CS is ready around the gate), the hold mirrors are drafted for the first window
   * (mirrorSync, HLD-64: every non-durable record re-mirrored), and the capture is captureStep's (R3-40, carry 7): the CS table is
   * journaled with the pair in the same state update, as every capture of the loop does — never Plan 2's table-less shape.
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
    if (it.tick !== null) await portabilityStep(core, it);
    await mirrorSync(core, it);
    await eolBomCreate(core, it, mat);
    const held = await this.sPubHolds(it, mat);
    this.maskViolation = held;
    if (held !== null) {
      core.deps.log.write('error', 'NOT_CONVERGED', { cause: 'publish_assert', check: held.check, path: held.path });
      return;
    }
    if (captureDue(core)) await captureStep(core, it);
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
        const pinned = heldPinPaths(core);
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
    const pinned = heldPinPaths(core);
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

  /**
   * The publish pause's inputs (status.ts publishPauseOf: OFFLINE, NONRETRYABLE, the VERSION verdict of the last prepared iteration) —
   * one source for status.json and for the flow's `paused` (Plan 3 Task 18 fix round 1, finding 10: attachFlowLoop in the constructor).
   */
  private pauseInputs(): Pick<StatusInputs, 'offline' | 'nonretryable' | 'version'> {
    const meta = this.core.view?.meta ?? null;
    const v = this.lastVersion;
    const version: StatusInputs['version'] = v === null ? null
      : v.proto ? { form: 'proto', cause: null }
      : v.regionSpec ? { form: 'regionSpec', cause: null }
      : v.checkpointMismatch ? { form: 'regionSpec', cause: 'checkpoint_mismatch' } : null;
    const offline: StatusInputs['offline'] = this.core.fetcher.offline().offline
      ? { label: 'OFFLINE', explanation: OFFLINE_EXPLANATION, offlineForS: this.offlineForS() } : null;
    const nonretryable: StatusInputs['nonretryable'] = meta !== null && meta.nonretryable !== null ? { holdId: meta.nonretryable.hold_id } : null;
    return { offline, nonretryable, version };
  }

  private statusInputs(): StatusInputs {
    const core = this.core;
    const { deps } = core;
    const now = deps.ports.clock.monoMs();
    const view = core.view;
    const meta = view?.meta ?? null;
    const lastOk = core.fetcher.lastSuccessMono();
    const gov = core.governor;
    let throttle: StatusInputs['throttle'] = null;
    if (gov.mode() === 'fallback') {
      // Task 7 ruling: a null fallbackSource() in fallback is an own folded event with no own signal known: 'own'.
      const src = gov.fallbackSource();
      const left = gov.fallbackLeftMs();
      throttle = { source: src === 'team' ? 'team' : 'own', untilMin: Math.ceil(left / 60_000), budget: gov.effective().B, fallbackLeftS: Math.ceil(left / 1_000), signal: src };
    }
    const unresolved = this.intentSince !== null && now - this.intentSince > INTENT_UNRESOLVED_MS;
    const fetchOwed = this.owed !== null && now - this.owed.sinceMono >= FETCH_OWED_MS;
    const pauseIn = this.pauseInputs();
    const { offline, nonretryable, version } = pauseIn;
    const blockReason = blockedPublishReason(meta?.freeze_reasons ?? [], publishPauseOf(pauseIn));
    // Plan 3 Task 12a (R3-46, HLD-24): Plan 2's not_converged entries extended by Plan 3's, the counts, diverged and the newest hold
    // code. The hold code feeds the degraded rung through its own slot (StatusInputs.holdCode, R3-61, fix round 1: a Plan 2 engine
    // event never takes that rung); for the ok ladder it also becomes lastEvent when it is newer than the engine's own last event.
    const pushBlocked = pushStatesOf(core, this.lastVersion ?? NO_VERSION).length > 0;
    // Taken into the ok ladder's lastEvent first: the degraded rung's slot reports only a current code (holdStatusInputs; Task 12b, carry
    // 1) and writeStatus clears a stale one (settleHoldCode), which never takes a newer code away from the ok ladder.
    if (core.holdCode !== null && core.holdCode !== this.seenHoldCode) {
      this.seenHoldCode = core.holdCode;
      this.lastEvent = core.holdCode;
    }
    // R3-EF4-6 (HLD-24, R3-30): pending.incoming counts a meta.pending row only while it is younger than 60 s, aged by pendingSince — the
    // anchor of DEFERRED{} below and of inspect().pendingAgeMs (a row not yet seen at an iteration's end has age 0: young).
    const pendingAgeMs = new Map([...this.pendingSince].map(([p, t]) => [p, now - t] as const));
    const holds = holdStatusInputs(core, this.lastIt, { base: this.notConverged(unresolved, fetchOwed, blockReason), blockReason: pushBlocked ? blockReason : null, pendingAgeMs });
    const notConverged = holds.notConvergedCauses;
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
      holdCode: holds.lastEvent,
      counts: holds.counts,
      diverged: holds.diverged,
      noChecksConfigured: core.config.checks.checkpoint.length === 0,
      branch: deps.branch, peerId: core.peerId, pluginVersion: deps.pluginVersion,
      heartbeatMs: deps.heartbeatMs(), loopPeriodMs: this.period,
      lastFetchAgeMs: lastOk === null ? null : now - lastOk,
      lastPushAgeMs: core.lastPushMono === null ? null : now - core.lastPushMono,
    };
  }

  /** status.json on every iteration and transition (ENG-56); a failing write never stops the engine. */
  private async writeStatus(): Promise<void> {
    const inputs = this.statusInputs();
    // Plan 3 Task 12b fix round 1 (minor b): the hold-code slot's clearing step, with this status's full not_converged causes (Plan 2's
    // and Plan 3's); every status read (statusInputs, inspect, holdStatusInputs) leaves the slot as it is.
    settleHoldCode(this.core, inputs.notConvergedCauses ?? new Map());
    const s = computeStatus(inputs);
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

  /** Task 7 (A7-6): registers one observer called with every status.json this engine computes and hands to its
   *  StatusWriter — on the write call, before the file I/O (a skipped write still reached the observers); returns
   *  the unsubscribe. */
  onStatus(cb: (s: StatusJson) => void): () => void {
    return this.status.onWrite(cb);
  }
}

/** The paths of the held PINs (heldPins; Plan 3 Task 10 replaced Plan 2's P2-PIN list): the loop's not_converged reasons for pairs a held PIN keeps back. */
function heldPinPaths(core: EngineCore): Set<string> {
  return new Set(heldPins(core.holds).flatMap((pin) => pin.paths));
}

/** The change-set table's membership (every CS's id, state and paths): Engine.signal writes the cache when a signal changed it (HLD-36). */
function membership(core: EngineCore): string {
  return JSON.stringify(core.cs.table().cs.map((e) => [e.cs_id, e.state, e.paths]));
}

/**
 * Plan 3 final review F11 (01-engine §3.5 step 4, §3.8 occasion (c), ENG-14; 05-holds HLD-27, HLD-30): the two step-D guards that
 * consume per-tick and per-materialization state, run on an iteration prepared outside the loop (Engine.resolve's prepares,
 * parkAllForStop) before anything acts on it — the mass-change breaker on its tick's dirty-set changes (a per-tick delta: the next loop
 * tick never sees them again) and the revert detector on its hold-path materialization (Materialized.prevMap is the only copy of the
 * private-index entries it moved, so the next loop materialization has no delta for those paths). Not detectStep: its massResumeStep
 * would form HLD-31's post-resume batch from a partial S_disk, and its repair, portability and churn steps are the loop's. A MASS trip
 * here enters FREEZE(MASS) as the loop's would (human verbs stay allowed under it, HLD-57/HLD-58); a fetch-and-fold-only iteration has
 * neither a tick nor a materialization.
 */
async function detectOutOfLoop(core: EngineCore, it: IterationCtx): Promise<void> {
  if (it.tick !== null) await breakerTick(core, it);
  if (it.mat !== null) await revertStep(core, it);
}

/**
 * Plan 3 final review F12 (05-holds §2 and HLD-03 "recomputed at every rev"; R3-12, R3-71): before the registry revs an Engine writes
 * outside an iteration — resume's release of the host-reject guard, drain's age-anchor flush — the start-time scope holds A and the
 * attributes of every non-terminal record's paths at EPOCH_BASE (R3-12: "before the first iteration of a run … the scope at EPOCH_BASE
 * built from the start-time AttrCache and team config"; ensureRecordAttrs "wherever the map is reset"). In a process that never prepared
 * an iteration (`daemon.js resume`: create, resume, drain with no start; a recover or resolve whose start was refused; a crash inside
 * start) the map is empty, so without this R3-71's fail-closed rule made every record local_only: the next run stripped every
 * held/<id>/ from the board (INV-HLD-DURABLE) and withheld the records' whole files. In a running daemon the map is already at
 * EPOCH_BASE: only paths a record gained since the last iteration are asked, nothing is re-based. A failure to read A or the attributes
 * leaves the fail-closed rule as it is (R3-71: local_only never fails open) and is logged (RECORD_SCOPE_FAILED {at, error}, ruling
 * R3-FF2-C1: never silent). With no state (view null) there is nothing to scope at: resume writes no rev then, and drain's revs carry
 * local_only unchanged (HoldRegistry.flushAgeAnchors' carryLocalOnly).
 */
async function scopeRecordPaths(core: EngineCore, at: 'resume' | 'drain'): Promise<void> {
  const view = core.view;
  if (view === null) return;
  try {
    await currentA(core);
    await ensureRecordAttrs(core, view.meta.EPOCH_BASE);
  } catch (e) {
    if (e instanceof KilledAt) throw e;
    core.deps.log.write('error', 'RECORD_SCOPE_FAILED', { at, error: e instanceof Error ? e.name : 'unknown' });
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
