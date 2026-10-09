// The fetcher (01-engine §3.5 step 1, §3.6; ENG-13, ENG-18, ENG-19; glossary §25 F10): one fetch at a time, spaced, with
// the offline clock and the network backoff.
//
// - Single flight: a fetch() while one is in flight returns that fetch's promise, forced or not (O-FETCH: a peer never
//   runs two fetches at once).
// - Never sleeps (ruling P2-NOSLEEP, ENG-19): a fetch() inside the spacing (≥ FETCH_SPACING_MS from the previous start)
//   or inside the network backoff returns the last view at once with `deferred: true` and no git call, so the iteration
//   goes on with snapshots and captures. force skips the spacing, never the backoff, never the single flight. A fetch
//   that took longer than the spacing is followed by the next one right after it ends. fetchNow() (the human-typed
//   recover, 01-engine §3.7 step 1; Task 16 fix-round ruling) skips the spacing and the backoff, never the single flight.
// - Network backoff: after a failure in which the remote did not answer, 30 s doubling to 5 min from the failure's
//   completion (the governor's NET_BACKOFF_* numbers); any answer of the remote resets it.
// - Local failure (ruling P2-FETCHLOCAL): the remote answered but the local ref update failed (FetchResult.remoteAnswered
//   with ok false, e.g. a stale refs/cowork-remote lock): the view says `localFailure`, it arms no backoff and it is
//   never OFFLINE.
// - offline(): no answer of the remote for > OFFLINE_AFTER_MS of Δmono, counted from construction (daemon start; every
//   timer restarts there, ENG-05) until the first answer.
// - abandon() (suspend gap or watchdog kill, step 0a; ruling P2-ABORT): the in-flight fetch is aborted (its git process
//   tree is killed through GitCallOptions.abort) and its result discarded — it changes no state and emits no trace —
//   and, once it has settled (its process exited), its waiters are served by a forced fetch; a fetch() in between
//   joins them. With nothing in flight, the next fetch is forced.
// - A FetchImpl that throws (a local git failure, not a network outcome: fetchRefs reports those as ok: false) rejects
//   the waiters and changes nothing but the spacing.
// Every timestamp is this PC's monotonic clock (Δmono; INV-CLOCK).
import { NET_BACKOFF_MAX_MS, NET_BACKOFF_MIN_MS } from '../board/governor.js';
import type { PeerId } from '../board/ids.js';
import { fetchRefs, type FetchResult, type FetchSpec } from '../git/fetch.js';
import { readHttpThrottle, type HttpThrottle } from '../git/httpStatus.js';
import { ABSENT, type OidOrAbsent } from '../git/oid.js';
import type { GitRepo } from '../git/repo.js';
import type { Clock } from '../ports/clock.js';
import type { Trace } from '../ports/trace.js';
import type { RefNames } from './refs.js';

export const FETCH_SPACING_MS = 2_500;
export const OFFLINE_AFTER_MS = 30_000;
/**
 * board, code (the mirror: a lease value only, PRO-13) and branch per remote ref; ABSENT when ls-remote showed the ref
 * missing (or, when ok is false, when no local copy exists — a failed fetch reports the local refs as they stand).
 * firstOfRun: the first successful fetch of this Fetcher (PRO-55's restart rule; the governor counts no landings from it).
 * deferred (P2-NOSLEEP): no fetch ran (spacing or backoff); the fields are the last view's, except firstOfRun, which is
 * false (no fetch ran). Before any fetch completed, a deferred view is ok false with every ref ABSENT.
 * localFailure (P2-FETCHLOCAL): the remote answered but the local ref update failed (shown distinctly, not OFFLINE).
 */
export interface FetchView {
  ok: boolean; board: OidOrAbsent; code: OidOrAbsent; branch: OidOrAbsent; completedMono: number; httpThrottle: HttpThrottle; killedByWatchdog: boolean; firstOfRun: boolean;
  deferred: boolean;
  localFailure: boolean;
}
/** abort (P2-ABORT, an addition to the contract's three parameters): abandon() fires it; fetchRefs passes it to every network call. */
export type FetchImpl = (repo: GitRepo, url: string, specs: readonly FetchSpec[], abort?: AbortSignal) => Promise<FetchResult>;

interface Flight {
  promise: Promise<FetchView>;
  resolve(v: FetchView): void;
  reject(e: unknown): void;
  /** The current attempt's controller; abandon() aborts it. */
  controller: AbortController;
  /** abandon() was called during the current attempt: its result is discarded and a forced attempt follows. */
  abandoned: boolean;
}

const hex = (v: OidOrAbsent): string | null => (v === ABSENT ? null : v);

export class Fetcher {
  private readonly repo: GitRepo;
  private readonly url: string;
  private readonly refs: RefNames;
  private readonly clock: Clock;
  private readonly trace: Trace;
  private readonly peer: PeerId;
  private readonly impl: FetchImpl;
  /** Told of every completed fetch (never a deferred view, an abandoned attempt or a throw): the Engine's observer. */
  private readonly onFetched: ((v: FetchView) => void) | null;
  /** Construction (daemon start): the offline clock's origin until the remote first answers. */
  private readonly createdMono: number;
  private lastStart: number | null = null;
  private lastSuccess: number | null = null;
  /** The last completion at which the remote answered (ok or a local failure): the offline clock. */
  private lastAnswered: number | null = null;
  private failures = 0;
  private backoffUntil: number | null = null;
  private sawOk = false;
  private forceNext = false;
  private lastView: FetchView | null = null;
  private flight: Flight | null = null;

  /** onFetched (Task 17 fix round 1, an addition to the contract's parameters): the Engine's hook on completed fetches. */
  constructor(d: { repo: GitRepo; url: string; refs: RefNames; clock: Clock; trace: Trace; peer: PeerId; impl?: FetchImpl; onFetched?: (v: FetchView) => void }) {
    this.repo = d.repo;
    this.url = d.url;
    this.refs = d.refs;
    this.clock = d.clock;
    this.trace = d.trace;
    this.peer = d.peer;
    this.impl = d.impl ?? fetchRefs;
    this.onFetched = d.onFetched ?? null;
    this.createdMono = d.clock.monoMs();
  }

  /**
   * Single flight: during an in-flight fetch, await it; else, if ≥ 2.5 s since the previous start, fetch. Never sleeps
   * (P2-NOSLEEP): inside the spacing or a backoff it returns the last view at once with `deferred: true` (the iteration
   * continues with snapshots and captures, ENG-19); force skips the spacing (never the backoff, never the single flight).
   */
  fetch(force = false): Promise<FetchView> {
    if (this.flight !== null) return this.flight.promise;
    const now = this.clock.monoMs();
    const forced = force || this.forceNext;
    if (this.backoffUntil !== null && now < this.backoffUntil) return Promise.resolve(this.deferredView());
    if (!forced && this.lastStart !== null && now < this.lastStart + FETCH_SPACING_MS) return Promise.resolve(this.deferredView());
    return this.launch();
  }

  /**
   * The human-typed /cowork recover's fetch (01-engine §3.7 Recover step 1: "unless a fetch succeeds now"): it skips the
   * spacing AND the network backoff, never the single flight (a fetch in flight is awaited). Its outcome feeds the backoff
   * and the offline clock like any fetch: a success ends the backoff, a failure extends it.
   */
  fetchNow(): Promise<FetchView> {
    if (this.flight !== null) return this.flight.promise;
    return this.launch();
  }

  private launch(): Promise<FetchView> {
    this.forceNext = false;
    let resolve!: Flight['resolve'];
    let reject!: Flight['reject'];
    const promise = new Promise<FetchView>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const flight: Flight = { promise, resolve, reject, controller: new AbortController(), abandoned: false };
    this.flight = flight;
    void this.fly(flight);
    return promise;
  }

  lastSuccessMono(): number | null {
    return this.lastSuccess;
  }

  /** OFFLINE: no answer of the remote for > 30 s of Δmono (a local failure is an answer, P2-FETCHLOCAL). */
  offline(): { offline: boolean; offlineForMs: number } {
    const offlineForMs = Math.max(0, this.clock.monoMs() - (this.lastAnswered ?? this.createdMono));
    return { offline: offlineForMs > OFFLINE_AFTER_MS, offlineForMs };
  }

  /** The earliest start of an unforced fetch: the spacing after the previous start, or the backoff after a network failure. */
  nextAllowedMono(): number {
    const spaced = this.lastStart === null ? this.createdMono : this.lastStart + FETCH_SPACING_MS;
    return this.backoffUntil === null ? spaced : Math.max(spaced, this.backoffUntil);
  }

  inFlight(): boolean {
    return this.flight !== null;
  }

  /**
   * Suspend gap: the in-flight fetch is ABORTED (process tree killed via GitCallOptions.abort) and its result discarded;
   * the next fetch starts only after the aborted process exited (O-FETCH: never two fetches at once). With nothing in
   * flight, the next fetch is forced.
   */
  abandon(): void {
    const f = this.flight;
    if (f === null) {
      this.forceNext = true;
      return;
    }
    f.abandoned = true;
    f.controller.abort();
  }

  /** Runs attempts until one is not abandoned; an abandoned attempt is waited for (its process exits) before the next. */
  private async fly(flight: Flight): Promise<void> {
    for (;;) {
      this.lastStart = this.clock.monoMs();
      let result: FetchResult;
      try {
        result = await this.impl(this.repo, this.url, this.refs.fetchSpecs, flight.controller.signal);
      } catch (e) {
        if (flight.abandoned) {
          this.restart(flight);
          continue;
        }
        this.flight = null;
        flight.reject(e);
        return;
      }
      if (flight.abandoned) {
        this.restart(flight);
        continue;
      }
      this.flight = null;
      flight.resolve(this.complete(result));
      return;
    }
  }

  /** The waiters of an abandoned attempt get a forced one (the spacing is skipped; it ran outside any backoff). */
  private restart(flight: Flight): void {
    flight.abandoned = false;
    flight.controller = new AbortController();
  }

  private deferredView(): FetchView {
    const last = this.lastView;
    if (last === null) {
      return {
        ok: false, board: ABSENT, code: ABSENT, branch: ABSENT, completedMono: this.createdMono, httpThrottle: null, killedByWatchdog: false,
        firstOfRun: false, deferred: true, localFailure: false,
      };
    }
    return { ...last, firstOfRun: false, deferred: true };
  }

  private complete(result: FetchResult): FetchView {
    const now = this.clock.monoMs();
    const answered = result.ok || result.remoteAnswered;
    if (answered) {
      this.lastAnswered = now;
      this.failures = 0;
      this.backoffUntil = null;
    } else {
      this.failures += 1;
      this.backoffUntil = now + Math.min(NET_BACKOFF_MIN_MS * 2 ** (this.failures - 1), NET_BACKOFF_MAX_MS);
    }
    if (result.ok) this.lastSuccess = now;
    const firstOfRun = result.ok && !this.sawOk;
    if (result.ok) this.sawOk = true;
    const value = (ref: string): OidOrAbsent => result.values.get(ref) ?? ABSENT;
    const view: FetchView = {
      ok: result.ok,
      board: value(this.refs.remoteBoard),
      code: value(this.refs.remoteCode),
      branch: value(this.refs.remoteBranch),
      completedMono: now,
      httpThrottle: readHttpThrottle(result.stderr),
      killedByWatchdog: result.killedByWatchdog,
      firstOfRun,
      deferred: false,
      localFailure: !result.ok && answered,
    };
    this.lastView = view;
    this.trace.emit({ kind: 'fetch', peer: this.peer, ok: view.ok, board: hex(view.board), code: hex(view.code), branch: hex(view.branch) });
    this.onFetched?.(view);
    return view;
  }
}
