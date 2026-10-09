// status.json (glossary §14 exactly; 01-engine §3.16; ENG-56, ENG-57; rulings R-16, R-27, R-35).
//
//   computeStatus   pure: the state by the §3.16 precedence (refused > incident > frozen > paused > offline > degraded >
//                   ok; 'down' only from `down`, the last write of an orderly exit), the one publish pause shown
//                   (OFFLINE/AUTH > NONRETRYABLE > VERSION), and the message code of the highest condition with its
//                   params: offline carries {label, explanation, offline_for_s} (glossary §25.2 item 4); in ok,
//                   BRANCH_REWRITTEN (R-08), else HOST_THROTTLED {source, until_min, budget, fallback_left_s, signal}
//                   (R-16; it never changes the state), else the last engine event, else null. The params follow
//                   the chapter that owns each code: INCIDENT{n, why, old_board, old_code, new_board, new_code,
//                   displaced} (01-engine §2, the INCIDENT log line's names), NOT_CONVERGED{cause, guard|reason|check,
//                   paths, causes} (each path's cause with its 01-engine §2 qualifier, NotConvergedWhy; `cause` and its
//                   qualifier the headline one), DEFERRED{reason, paths}
//   StatusWriter    temp file + rename through the Fs port; EPERM/EACCES/EBUSY (a Windows reader without share-delete)
//                   retried 3 × 50 ms on the Clock port, then this write is skipped (false); the temp file never stays
import { join } from 'node:path';
import type { ThrottleSignal } from '../board/governor.js';
import type { Json } from '../board/canonicalJson.js';
import type { Clock } from '../ports/clock.js';
import { errnoCode, type Fs } from '../ports/fs.js';
import type { FreezeReason } from './meta.js';

export type StatusState = 'ok' | 'degraded' | 'offline' | 'frozen' | 'incident' | 'paused' | 'refused' | 'down';
export type PublishPause = null | 'OFFLINE' | 'AUTH' | 'NONRETRYABLE' | 'VERSION';
/**
 * The cause of a not_converged path (01-engine §2 NOT_CONVERGED: phantom | not_applicable | round_trip | blocked_publish |
 * publish_assert). Plan 2 additions: push_unresolved (Task 14 carry: a kept ambiguous push intent's pairs), deferred
 * (R-05: a deferral that outlived one apply) and fetch_owed (Task 17: a fetch owed since a suspend for 60 s; the ready
 * pairs it keeps from publishing).
 */
export type NotConvergedCause = 'phantom' | 'not_applicable' | 'round_trip' | 'blocked_publish' | 'publish_assert' | 'push_unresolved' | 'deferred' | 'fetch_owed';
/**
 * A not_converged path's cause with the qualifier 01-engine §2 gives it (Task 17 fix round 2), under its own name:
 * not_applicable "with its guard" (collision, unmaterializable, quarantine-review, filter-failure); blocked_publish "with
 * the publish pause or FREEZE reason" as `reason` (blockedPublishReason), or, when a held record keeps the path (a
 * DECISION record waiting for a human verb, a P2-PIN), that record's `guard`; publish_assert "the failing ENG-41 letter or
 * INV-MASK" as `check`; deferred (R-05) its defer-table `reason`. The other causes carry none.
 */
export type NotConvergedWhy =
  | { cause: 'not_applicable'; guard?: string }
  | { cause: 'blocked_publish'; reason: string }
  | { cause: 'blocked_publish'; guard: string }
  | { cause: 'publish_assert'; check: string }
  | { cause: 'deferred'; reason: string }
  | { cause: 'phantom' | 'round_trip' | 'push_unresolved' | 'fetch_owed' };

export interface StatusJson {   // glossary §14 exactly; no other field
  v: 1; state: StatusState; freeze_reasons: FreezeReason[]; publish_pause: PublishPause;
  branch: string; peer_id: string; plugin_version: string;
  heartbeat_mono_ms: number; loop_period_ms: number;
  last_fetch_age_ms: number | null; last_push_age_ms: number | null;
  pending: { cs_ready: number; cs_open: number; holds_active: number; holds_local_only: number; incoming: number; not_converged: string[] };
  claims_held: number; requests_in: number; requests_out: number;
  adopt: { state: 'current' | 'blocked'; reasons: string[] };
  message_code: string | null; message_params: Record<string, Json>;
}

export interface StatusInputs {
  refused: { code: string; params: Record<string, Json> } | null;
  down: { code: 'IDLE_NO_SESSION' | null } | null;
  freeze: readonly FreezeReason[];
  offline: { label: 'OFFLINE' | 'AUTH'; explanation: string; offlineForS: number } | null;
  nonretryable: { holdId: string } | null;
  version: { form: 'proto' | 'regionSpec'; cause: 'checkpoint_mismatch' | null } | null;
  notConverged: readonly string[]; pendingOlderThan60s: boolean;
  /**
   * Contract extension (Task 14 carry ruling): a kept ambiguous push intent older than 60 s is NOT_CONVERGED with cause
   * 'push_unresolved' (degraded), also when the intent carries no path (a board-only publish).
   */
  notConvergedCause?: NotConvergedCause | null;
  /**
   * Contract extension (Task 17 fix rounds 1 and 2): the cause of each not_converged path with its 01-engine §2 qualifier
   * (a path without one shows not_applicable with no guard).
   */
  notConvergedCauses?: ReadonlyMap<string, NotConvergedWhy>;
  /** Contract extension (Task 17 fix round 1): DEFERRED's params, the reason and paths of the pending paths older than 60 s. */
  deferred?: { reason: string; paths: readonly string[] } | null;
  /** Contract extension (Task 17 fix round 1): INCIDENT's params while INCIDENT is set (never another event's params). */
  incident?: Readonly<Record<string, Json>> | null;
  /**
   * HOST_THROTTLED (R-16). Contract widening (Task 7 ruling): `signal` is null when the governor is in fallback for an own
   * folded event with no own signal known to this run (fallbackSource() null, rendered with source 'own').
   */
  throttle: { source: string; untilMin: number; budget: number; fallbackLeftS: number; signal: ThrottleSignal | 'team' | null } | null;
  branchRewritten: { hb: string; hr: string } | null;
  lastEvent: { code: string; params: Record<string, Json> } | null;
  counts: { csReady: number; csOpen: number; holdsActive: number; holdsLocalOnly: number; incoming: number };
  branch: string; peerId: string; pluginVersion: string;
  heartbeatMs: number; loopPeriodMs: number; lastFetchAgeMs: number | null; lastPushAgeMs: number | null;
}

type Message = { code: string | null; params: Record<string, Json> };

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The one publish pause shown (§3.16): OFFLINE/AUTH > NONRETRYABLE > VERSION. */
export function publishPauseOf(i: Pick<StatusInputs, 'offline' | 'nonretryable' | 'version'>): PublishPause {
  return i.offline !== null ? i.offline.label : i.nonretryable !== null ? 'NONRETRYABLE' : i.version !== null ? 'VERSION' : null;
}

/**
 * blocked_publish's qualifier (01-engine §2 "with the publish pause or FREEZE reason"), by the status precedence: INCIDENT,
 * another FREEZE reason (the first), PAUSED, then the publish pause shown; null when nothing blocks a publish.
 */
export function blockedPublishReason(freeze: readonly FreezeReason[], pause: PublishPause): string | null {
  if (freeze.includes('INCIDENT')) return 'INCIDENT';
  return freeze.find((r) => r !== 'PAUSED') ?? (freeze.includes('PAUSED') ? 'PAUSED' : pause);
}

/** One cause as JSON: `cause`, then its qualifier under its 01-engine §2 name (guard, reason or check), never an undefined key. */
function whyJson(w: NotConvergedWhy): Record<string, Json> {
  const out: Record<string, Json> = { cause: w.cause };
  if ('guard' in w && w.guard !== undefined) out['guard'] = w.guard;
  if ('reason' in w) out['reason'] = w.reason;
  if ('check' in w) out['check'] = w.check;
  return out;
}

/** State, message code and params by the §3.16 precedence (first match). */
function stateOf(i: StatusInputs, notConverged: readonly string[]): { state: StatusState } & Message {
  if (i.down !== null) return { state: 'down', code: i.down.code, params: {} };
  if (i.refused !== null) return { state: 'refused', code: i.refused.code, params: { ...i.refused.params } };
  if (i.freeze.includes('INCIDENT')) return { state: 'incident', code: 'INCIDENT', params: { ...(i.incident ?? {}) } };
  if (i.freeze.some((r) => r !== 'PAUSED')) return { state: 'frozen', code: 'FROZEN', params: { reasons: [...i.freeze] } };
  if (i.freeze.length > 0) return { state: 'paused', code: 'PAUSED', params: {} };
  if (i.offline !== null) {
    return { state: 'offline', code: 'OFFLINE', params: { label: i.offline.label, explanation: i.offline.explanation, offline_for_s: i.offline.offlineForS } };
  }
  if (i.nonretryable !== null) return { state: 'degraded', code: 'NONRETRYABLE', params: { hold_id: i.nonretryable.holdId } };
  if (i.version !== null) return { state: 'degraded', code: 'VERSION_PAUSED', params: { form: i.version.form, cause: i.version.cause } };
  const explicit = i.notConvergedCause ?? null;
  if (notConverged.length > 0 || explicit !== null) {
    const whys = notConverged.map((p): NotConvergedWhy => i.notConvergedCauses?.get(p) ?? { cause: 'not_applicable' });
    // The headline: an explicit cause (no qualifier), else the first path's cause with its qualifier.
    const head: Record<string, Json> = explicit !== null ? { cause: explicit } : whyJson(whys[0]!);
    return { state: 'degraded', code: 'NOT_CONVERGED', params: { ...head, paths: [...notConverged], causes: whys.map(whyJson) } };
  }
  if (i.pendingOlderThan60s) {
    const d = i.deferred ?? null;
    return { state: 'degraded', code: 'DEFERRED', params: d === null ? {} : { reason: d.reason, paths: [...d.paths].sort(byCodeUnit) } };
  }
  if (i.branchRewritten !== null) return { state: 'ok', code: 'BRANCH_REWRITTEN', params: { hb: i.branchRewritten.hb, hr: i.branchRewritten.hr } };
  if (i.throttle !== null) {
    const t = i.throttle;
    return { state: 'ok', code: 'HOST_THROTTLED', params: { source: t.source, until_min: t.untilMin, budget: t.budget, fallback_left_s: t.fallbackLeftS, signal: t.signal } };
  }
  if (i.lastEvent !== null) return { state: 'ok', code: i.lastEvent.code, params: { ...i.lastEvent.params } };
  return { state: 'ok', code: null, params: {} };
}

/** State precedence refused > incident > frozen > paused > offline > degraded > ok ('down' only from `down`); message_code of the highest condition; in 'ok': BRANCH_REWRITTEN, else HOST_THROTTLED, else lastEvent, else null. Pure. */
export function computeStatus(i: StatusInputs): StatusJson {
  const notConverged = [...new Set(i.notConverged)].sort(byCodeUnit);
  const pause = publishPauseOf(i);
  const s = stateOf(i, notConverged);
  return {
    v: 1, state: s.state, freeze_reasons: [...i.freeze], publish_pause: pause,
    branch: i.branch, peer_id: i.peerId, plugin_version: i.pluginVersion,
    heartbeat_mono_ms: i.heartbeatMs, loop_period_ms: i.loopPeriodMs,
    last_fetch_age_ms: i.lastFetchAgeMs, last_push_age_ms: i.lastPushAgeMs,
    pending: {
      cs_ready: i.counts.csReady, cs_open: i.counts.csOpen, holds_active: i.counts.holdsActive, holds_local_only: i.counts.holdsLocalOnly,
      incoming: i.counts.incoming, not_converged: notConverged,
    },
    claims_held: 0, requests_in: 0, requests_out: 0,   // claims and requests are Plans 4 and 6
    adopt: { state: 'current', reasons: [] },          // adopt is Plan 7 (LIF-31)
    message_code: s.code, message_params: s.params,
  };
}

/** 01-engine §3.16: the retries of one write on a held file, and their spacing (a chapter-local constant). */
const RETRIES = 3;
const RETRY_MS = 50;
/** A reader holding status.json without share-delete (EPERM/EACCES), or mid-rename (EBUSY), on Windows. */
const RETRYABLE: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY']);

export class StatusWriter {
  private readonly fs: Fs;
  private readonly file: string;
  private readonly tmp: string;
  private readonly clock: Clock;
  /** Writes are queued: one status write at a time, in call order. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(fs: Fs, file: string, tmpDir: string, clock: Clock) {
    this.fs = fs;
    this.file = file;
    this.tmp = join(tmpDir, 'status.json.tmp');
    this.clock = clock;
  }

  /** temp + rename; EPERM/EACCES/EBUSY retry 3 × 50 ms, then skip (false). Any other error propagates (the temp file removed). */
  write(s: StatusJson): Promise<boolean> {
    const run = this.tail.then(() => this.writeNow(s));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async writeNow(s: StatusJson): Promise<boolean> {
    const bytes = Buffer.from(`${JSON.stringify(s)}\n`, 'utf8');
    for (let attempt = 0; ; attempt++) {
      try {
        await this.fs.writeFile(this.tmp, bytes);
        await this.fs.rename(this.tmp, this.file);
        return true;
      } catch (e) {
        const retryable = RETRYABLE.has(errnoCode(e) ?? '');
        if (!retryable || attempt >= RETRIES) {
          await this.fs.unlink(this.tmp).catch(() => undefined);
          if (retryable) return false;
          throw e;
        }
        await this.clock.sleep(RETRY_MS);
      }
    }
  }
}
