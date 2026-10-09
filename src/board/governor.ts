// The push governor (02-protocol §3.8; PRO-39…PRO-46, PRO-54's counter as input, PRO-55; glossary §20 governor
// row as revised by §27.2; 01-engine ENG-44's §3.6 backoff and ENG-46; rulings R-17, R-18, R-20, R-21).
//
// Every timer is a Δmono from a local Anchor (anchorNow / elapsedMono, INV-CLOCK): no wall-clock value is
// read, so wall offsets, drift and suspends change no decision, and a suspend only makes this peer wait
// longer. Nothing here is persisted except toMeta()'s own fallback signal (ENG-05, no timestamp).
//
// Caller contract (Tasks 12–15):
// - onFetch after every completed fetch with the board tip T, the classify step's fresh fetch included;
//   `revealed` = every new first-parent board commit since the tip this governor last observed, an own
//   Bnew included (after a direct onOwnOk that tip is Bnew, so a later fetch does not count Bnew again);
//   `pending` = allowed pending work (pending ∧ state_allows of §3.8).
// - every push attempt: mayAttempt (exempt per R-21) → onAttemptStart → push → (classify: fresh fetch →
//   onFetch) → onAttemptEnd once the attempt is classified, on every path; onOwnOk when it landed (also
//   the restart's push-intent resolution). onOwnOk counts the own landing and moves the anchor only when
//   no fetch since the attempt started has observed the board past its lease; a fetch that revealed Bnew
//   (or a newer tip above it) already counted it among `revealed`, and the tip never moves back to Bnew.
// - Throttle signals → onSignal; a queued HOST_THROTTLED event → onEventQueued; a folded HOST_THROTTLED
//   event, own or a teammate's (and PRO-55's restart rule, RESTART_EVENT_HEIGHTS) → onThrottleEventFolded;
//   protocol.json of the tip → setParams.
import type { Oid } from '../git/oid.js';
import { anchorNow, elapsedMono, type Anchor, type Clock } from '../ports/clock.js';

/** readProtocol of the board tip: budget per minute, G_s and S_s in seconds. */
export interface GovernorParams { budget: number; G_s: number; S_s: number; }
export type GovernorMode = 'normal' | 'fallback';
export type ThrottleSignal = 'http_429' | 'http_5xx' | 'slow_push' | 'rejection_streak';

/** Local constants of normal mode: the code's ceiling, so the board's protocol.json decides within 6–24 (PRO-55). */
export const NORMAL_LOCAL: Readonly<{ B: number; G_ms: number; S_ms: number }> = Object.freeze({ B: 24, G_ms: 2_500, S_ms: 750 });
/** Local constants of fallback mode (glossary §27.2). */
export const FALLBACK_LOCAL: Readonly<{ B: number; G_ms: number; S_ms: number }> = Object.freeze({ B: 6, G_ms: 10_000, S_ms: 3_000 });
/** Fallback lasts 30 min Δmono after the last own signal or folded HOST_THROTTLED event. */
export const FALLBACK_MS = 1_800_000;
/** At most one HOST_THROTTLED event per 15 min per peer. */
export const EVENT_SPACING_MS = 900_000;
/** The throttle level k doubles G_eff up to 60 s. */
export const G_CAP_MS = 60_000;
/** The per-peer cap and the sliding team guard count over the last 60 s Δmono. */
export const WINDOW_MS = 60_000;
/** An attempt slower than this raises k (PRO-44) and is a throttle signal (PRO-55). */
export const SLOW_PUSH_MS = 10_000;
/** PRO-55 restart rule: a HOST_THROTTLED event within this many first-parent heights counts as folded at the first fetch. */
export const RESTART_EVENT_HEIGHTS = 180;
/** Network backoff (glossary §20, ENG-19) and the transient-rejection backoff (ENG-44, R-20): 30 s doubling to 5 min. */
export const NET_BACKOFF_MIN_MS = 30_000;
export const NET_BACKOFF_MAX_MS = 300_000;

/** One governed attempt as classified by its caller (never by text): duration, watchdog kill, porcelain status, transient rejection, landed. */
export interface AttemptEnd { durationMs: number; killed: boolean; hadRefStatus: boolean; transient: boolean; landed: boolean; }

const SIGNALS: ReadonlySet<string> = new Set<ThrottleSignal>(['http_429', 'http_5xx', 'slow_push', 'rejection_streak']);
/** What a missing or malformed protocol.json field reads as (02-protocol §3.1): the stricter side. */
const PARAM_FALLBACK: GovernorParams = { budget: 6, G_s: 10, S_s: 3 };

const positive = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);

function sanitize(p: GovernorParams): GovernorParams {
  return { budget: positive(p?.budget, PARAM_FALLBACK.budget), G_s: positive(p?.G_s, PARAM_FALLBACK.G_s), S_s: positive(p?.S_s, PARAM_FALLBACK.S_s) };
}

/** protocol.json seconds → whole ms, rounded up (the stricter side); float noise below 1 µs is ignored (8.572 → 8,572). */
const toMs = (s: number): number => Math.ceil(Math.round(s * 1e6) / 1e3);

/** `n` events observed at one instant (one fetch can reveal several landings). */
interface Bucket { at: Anchor; n: number; }

export class Governor {
  private readonly clock: Clock;
  private params: GovernorParams;
  /** The observed board tip; undefined until the first observation of this run. */
  private anchorTip: Oid | null | undefined = undefined;
  /** anchorTip when the own last attempt started (its lease as this governor saw it); undefined before any attempt. */
  private tipAtAttemptStart: Oid | null | undefined = undefined;
  /** When anchorTip was observed (fetch completion) or the own ok was received. */
  private anchor: Anchor | null = null;
  private landings: Bucket[] = [];
  private attempts: Anchor[] = [];
  private lastAttempt: Anchor | null = null;
  private inFlight = false;
  /** PRO-44 throttle level. */
  private k = 0;
  /** Tip changes by others while allowed work was pending, since the own last attempt or since pending became true. */
  private preempted = 0;
  /** The tip of the latest counted pre-emption, so an own commit first seen by a fetch can be taken back. */
  private preemptTip: Oid | null | undefined = undefined;
  /** Allowed pending work as of the last onFetch / mayAttempt. */
  private pending = false;
  /** Consecutive transient rejections paced by the ENG-44 backoff, and when the last one ended. */
  private backoffLevel = 0;
  private backoffFrom: Anchor | null = null;
  /** The own last throttle signal (onSignal or restore); kept after its 30 min to name an own folded event's cause. */
  private lastSignal: { at: Anchor; signal: ThrottleSignal } | null = null;
  /** The last fold of a HOST_THROTTLED event written by this peer, and by a teammate. */
  private lastFoldedOwn: Anchor | null = null;
  private lastFoldedTeam: Anchor | null = null;
  /** The last HOST_THROTTLED event this daemon queued, or folded from any writer (the 15-min spacing, P2-R18). */
  private lastEvent: Anchor | null = null;

  constructor(clock: Clock, params: GovernorParams) {
    this.clock = clock;
    this.params = sanitize(params);
  }

  /** The tip's protocol.json; a missing or malformed field reads as budget 6 / G_s 10 / S_s 3 (stricter). */
  setParams(params: GovernorParams): void {
    this.params = sanitize(params);
  }

  /**
   * A fetch completed with board tip T: anchor := now when T changed; `revealed` new first-parent commits are
   * observed landings unless firstOfRun (history, 02-protocol §2); a tip change by another writer while
   * `pending` counts one pre-emption (not on the first observation of the run).
   */
  onFetch(tip: Oid | null, revealed: number, firstOfRun: boolean, pending: boolean): void {
    if (!Number.isSafeInteger(revealed) || revealed < 0) throw new RangeError(`governor: revealed must be a count, got ${String(revealed)}`);
    this.notePending(pending);
    const now = anchorNow(this.clock);
    if (!firstOfRun && revealed > 0) this.landings.push({ at: now, n: revealed });
    if (tip !== this.anchorTip) {
      const seenBefore = this.anchorTip !== undefined;
      this.anchorTip = tip;
      this.anchor = now;
      if (seenBefore && !firstOfRun && pending && tip !== null) {
        this.preempted += 1;
        this.preemptTip = tip;
      }
    }
    this.prune();
  }

  /**
   * The own push landed (board ok, or an ambiguous push resolved as landed; also the restart's push-intent
   * resolution). Three cases, by what this governor has observed:
   * - the tip is still the one seen when the attempt started (a direct ok, no fetch since): anchor_tip :=
   *   Bnew, anchor := now and one observed landing;
   * - a fetch already revealed Bnew as the tip: that fetch counted the landing; anchor := now (the ok's
   *   receipt) and a pre-emption it counted for Bnew is taken back (it was this peer's own commit);
   * - a fetch already revealed a newer tip above Bnew: nothing — that fetch counted Bnew among `revealed`
   *   and its one tip change; moving anchor_tip back to Bnew would make the next fetch of the same tip a
   *   second tip change (a second pre-emption, a second anchor move) and count Bnew twice.
   */
  onOwnOk(bnew: Oid): void {
    if (this.anchorTip === bnew) {
      if (this.preemptTip === bnew && this.preempted > 0) this.preempted -= 1;
      this.preemptTip = undefined;
      this.anchor = anchorNow(this.clock);
    } else if (this.anchorTip === this.tipAtAttemptStart) {
      const now = anchorNow(this.clock);
      this.anchorTip = bnew;
      this.landings.push({ at: now, n: 1 });
      this.anchor = now;
    }
    this.prune();
  }

  /** One attempt starts: counted for the cap (PRO-41), the own spacing runs from here, the pre-emption count restarts. */
  onAttemptStart(): void {
    if (this.inFlight) throw new Error('governor: an attempt is already in flight');
    const now = anchorNow(this.clock);
    this.attempts.push(now);
    this.lastAttempt = now;
    this.inFlight = true;
    this.tipAtAttemptStart = this.anchorTip;
    this.preempted = 0;
    this.preemptTip = undefined;
    this.prune();
  }

  /**
   * PRO-44: an attempt that took > 10 s, was killed, returned no per-ref status or was a transient rejection
   * raises k by one (until G_eff reaches 60 s); any other lowers it by one. A transient rejection, or a
   * failure without a per-ref status line (hadRefStatus false and not landed: a transport failure or a
   * watchdog kill), arms one backoff of 30 s doubling to 5 min (ENG-44 / R-20 for transients, ENG-19's
   * network backoff for the others, ruling P2-NETBACKOFF); a landing or a lease loss (a per-ref status, not
   * transient) resets it, as PRO-54 resets the streak. The attempt is no longer in flight as soon as this is
   * called, also when the input is refused (TypeError / RangeError, nothing else changes): a refused end
   * never wedges the governor.
   */
  onAttemptEnd(e: AttemptEnd): void {
    if (!this.inFlight) throw new Error('governor: no attempt in flight');
    this.inFlight = false;
    if (typeof e !== 'object' || e === null) throw new TypeError('governor: onAttemptEnd needs an AttemptEnd');
    if (typeof e.durationMs !== 'number' || !(e.durationMs >= 0)) throw new RangeError(`governor: durationMs must be >= 0, got ${String(e.durationMs)}`);
    if (e.durationMs > SLOW_PUSH_MS || e.killed || !e.hadRefStatus || e.transient) {
      if (this.effective().Gbase_ms * 2 ** this.k < G_CAP_MS) this.k += 1;
    } else {
      this.k = Math.max(0, this.k - 1);
    }
    if (e.transient || (!e.hadRefStatus && !e.landed)) {
      this.backoffLevel += 1;
      this.backoffFrom = anchorNow(this.clock);
    } else {
      this.backoffLevel = 0;
      this.backoffFrom = null;
    }
  }

  /**
   * A throttle signal (PRO-55): last_signal := now, so the very next decision is in fallback. postEvent when
   * the signal came from a push, or from a fetch with other pending work, and no HOST_THROTTLED event was
   * folded (from any writer, a teammate's included) or queued by this daemon within 15 min (ruling P2-R18,
   * 02-protocol §3.8 "folded, or put in its outbox, by this daemon"). Posting is the caller's: it queues the
   * event and calls onEventQueued.
   */
  onSignal(s: ThrottleSignal, fromPush: boolean, otherPending: boolean): { postEvent: boolean } {
    if (!SIGNALS.has(s)) throw new TypeError(`governor: unknown throttle signal ${JSON.stringify(s)}`);
    this.lastSignal = { at: anchorNow(this.clock), signal: s };
    const spaced = this.ago(this.lastEvent) >= EVENT_SPACING_MS;
    return { postEvent: (fromPush || otherPending) && spaced };
  }

  /**
   * A HOST_THROTTLED health event was folded: fallback for 30 min of this peer's Δmono, and the 15-min
   * event spacing restarts whoever wrote it (P2-R18), so a follower never posts its own on top. `own` (the
   * event's writer is this peer) only decides what fallbackSource reports.
   */
  onThrottleEventFolded(own: boolean): void {
    const now = anchorNow(this.clock);
    if (own) this.lastFoldedOwn = now;
    else this.lastFoldedTeam = now;
    this.lastEvent = now;
  }

  /** This peer put a HOST_THROTTLED event in its outbox. */
  onEventQueued(): void {
    this.lastEvent = anchorNow(this.clock);
  }

  mode(): GovernorMode {
    return this.fallbackLeftMs() > 0 ? 'fallback' : 'normal';
  }

  /** PRO-04 stricter-of: B_eff = min(B_local, budget), G_base = max(G_local, G_s, 60 s / B_eff), S_eff = max(S_local, S_s), G_eff = min(60 s, G_base · 2^k). */
  effective(): { B: number; Gbase_ms: number; S_ms: number; G_ms: number; k: number } {
    const local = this.mode() === 'normal' ? NORMAL_LOCAL : FALLBACK_LOCAL;
    const B = Math.min(local.B, this.params.budget);
    const S_ms = Math.max(local.S_ms, toMs(this.params.S_s));
    const Gbase_ms = Math.max(local.G_ms, toMs(this.params.G_s), Math.ceil(WINDOW_MS / B));
    const G_ms = Math.min(G_CAP_MS, Gbase_ms * 2 ** this.k);
    return { B, Gbase_ms, S_ms, G_ms, k: this.k };
  }

  /**
   * PRO-40: allowed pending work, no attempt in flight, fewer than B_eff own attempts and fewer than B_eff
   * observed landings in the last 60 s (the cap and the sliding guard; aging never bypasses either), and —
   * unless exempt — Δ since the anchor ≥ wait(self) (G_eff + (rank − 1)·S_eff, or G_base once aged by two
   * pre-emptions), Δ since the own last attempt ≥ G_eff and the transient backoff over (R-20). There is no
   * window before the first observation of a tip. exempt (R-21: genesis probe and push, human recover)
   * skips the window, the G_eff spacing and the transient backoff, never the cap or the guard. A false
   * pending or stateAllows restarts the pre-emption count ("since pending became true").
   */
  mayAttempt(rank: number, pending: boolean, stateAllows: boolean, exempt?: boolean): boolean {
    checkRank(rank);
    const allowed = pending && stateAllows;
    this.notePending(allowed);
    if (!allowed || this.inFlight) return false;
    return this.waitMs(rank, exempt === true) === 0;
  }

  /** Δmono until mayAttempt(rank, …) could be true with nothing else changing; Infinity when nothing is pending, an attempt is in flight or no tip was observed yet. */
  msUntilWindow(rank: number): number {
    checkRank(rank);
    if (!this.pending || this.inFlight) return Infinity;
    return this.waitMs(rank, false);
  }

  /** Δmono left in fallback (the latest of the own signal's and the folded events' 30 min); 0 in normal mode. */
  fallbackLeftMs(): number {
    return Math.max(
      0,
      FALLBACK_MS - this.ago(this.lastSignal?.at ?? null),
      FALLBACK_MS - this.ago(this.lastFoldedOwn),
      FALLBACK_MS - this.ago(this.lastFoldedTeam),
    );
  }

  /**
   * Who holds this peer in fallback, own causes first: the own signal while its 30 min hold; else, while a
   * folded event of this peer's own holds, the own signal that led to it (its kind, past its own 30 min);
   * else 'team' while a teammate's folded event holds; else null. An own folded event with no own signal
   * known to this run (a restart whose meta.throttle was null) has no ThrottleSignal to name and is never
   * reported as the team's: null although the mode is fallback (a contract gap: the type has no 'own').
   */
  fallbackSource(): ThrottleSignal | 'team' | null {
    if (this.lastSignal !== null && this.ago(this.lastSignal.at) < FALLBACK_MS) return this.lastSignal.signal;
    if (this.lastSignal !== null && this.ago(this.lastFoldedOwn) < FALLBACK_MS) return this.lastSignal.signal;
    if (this.ago(this.lastFoldedTeam) < FALLBACK_MS) return 'team';
    return null;
  }

  /** Own attempts started in the last 60 s Δmono. */
  attemptsInWindow(): number {
    return this.attempts.filter((a) => this.ago(a) < WINDOW_MS).length;
  }

  /** meta.throttle (ENG-05): the own fallback's signal while it holds, without a timestamp; a followed team event is not persisted. */
  toMeta(): { signal: ThrottleSignal } | null {
    if (this.lastSignal === null || this.ago(this.lastSignal.at) >= FALLBACK_MS) return null;
    return { signal: this.lastSignal.signal };
  }

  /** Daemon start (R-17): a persisted own fallback restarts for a full 30 min from now; null restores nothing. */
  restore(m: { signal: ThrottleSignal } | null): void {
    if (m === null) return;
    if (typeof m !== 'object' || !SIGNALS.has(m.signal)) throw new TypeError(`governor: meta.throttle ${JSON.stringify(m)} is not a throttle signal`);
    this.lastSignal = { at: anchorNow(this.clock), signal: m.signal };
  }

  private ago(a: Anchor | null): number {
    return a === null ? Infinity : elapsedMono(this.clock, a);
  }

  private notePending(p: boolean): void {
    this.pending = p;
    if (!p) {
      this.preempted = 0;
      this.preemptTip = undefined;
    }
  }

  /** Δmono until every condition of mayAttempt holds (each, once true, stays true while nothing happens). */
  private waitMs(rank: number, exempt: boolean): number {
    const eff = this.effective();
    let w = Math.max(this.windowWait(this.attempts.map((at) => ({ at, n: 1 })), eff.B), this.windowWait(this.landings, eff.B));
    if (!exempt) {
      if (this.anchor === null) return Infinity;
      const wait = this.preempted >= 2 ? eff.Gbase_ms : eff.G_ms + (rank - 1) * eff.S_ms;
      w = Math.max(w, wait - this.ago(this.anchor));
      if (this.lastAttempt !== null) w = Math.max(w, eff.G_ms - this.ago(this.lastAttempt));
      if (this.backoffLevel > 0 && this.backoffFrom !== null) {
        const backoff = Math.min(NET_BACKOFF_MAX_MS, NET_BACKOFF_MIN_MS * 2 ** (this.backoffLevel - 1));
        w = Math.max(w, backoff - this.ago(this.backoffFrom));
      }
    }
    return Math.max(0, w);
  }

  /** Δmono until fewer than B events (oldest first) remain in the last 60 s; 0 when already so. */
  private windowWait(items: readonly Bucket[], B: number): number {
    const live = items.filter((x) => this.ago(x.at) < WINDOW_MS);
    const total = live.reduce((s, x) => s + x.n, 0);
    if (total < B) return 0;
    const mustAge = total - (Math.ceil(B) - 1);
    let aged = 0;
    for (const x of live) {
      aged += x.n;
      if (aged >= mustAge) return WINDOW_MS - this.ago(x.at);
    }
    return Infinity;
  }

  /** Drops attempts and landings older than the 60 s window (they never count again: Δmono only grows). */
  private prune(): void {
    this.attempts = this.attempts.filter((a) => this.ago(a) < WINDOW_MS);
    this.landings = this.landings.filter((x) => this.ago(x.at) < WINDOW_MS);
  }
}

function checkRank(rank: number): void {
  if (!Number.isSafeInteger(rank) || rank < 1) throw new RangeError(`governor: rank must be an integer >= 1, got ${String(rank)}`);
}
