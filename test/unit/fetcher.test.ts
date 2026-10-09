import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FetchResult, FetchSpec } from '../../src/git/fetch.js';
import { ABSENT, parseOid, type Oid } from '../../src/git/oid.js';
import type { GitRepo } from '../../src/git/repo.js';
import type { Trace, TraceEvent } from '../../src/ports/trace.js';
import { FETCH_SPACING_MS, Fetcher, OFFLINE_AFTER_MS, type FetchImpl, type FetchView } from '../../src/engine/fetcher.js';
import { RELEASE_NAMESPACE, refNames } from '../../src/engine/refs.js';
import { VirtualClock } from '../sim/vclock.js';

const PEER = '0123456789abcdef0123456789abcdef';
const URL = 'file:///srv/remote.git';
const refs = refNames('main', RELEASE_NAMESPACE);
/** The FetchImpl is injected, so the repo is never touched. */
const repo = {} as GitRepo;
const X1 = parseOid('1'.repeat(40));
const X2 = parseOid('2'.repeat(40));
const BR = parseOid('3'.repeat(40));
const MIRROR = parseOid('4'.repeat(40));

/** Ruling P2-NOSLEEP: the Fetcher never waits on the Clock port, so any sleep fails the test. */
class NoSleepClock extends VirtualClock {
  override async sleep(): Promise<void> {
    throw new Error('the Fetcher slept on the Clock port (P2-NOSLEEP)');
  }
}

function okResult(board: Oid): FetchResult {
  return {
    ok: true, remoteAnswered: true, values: new Map([[refs.remoteBoard, board], [refs.remoteCode, MIRROR], [refs.remoteBranch, BR]]),
    code: 0, killedByWatchdog: false, durationMs: 0, stderr: Buffer.alloc(0),
  };
}
function failResult(stderr = 'fatal: unable to access: Could not resolve host', killed = false): FetchResult {
  return { ok: false, remoteAnswered: false, values: new Map(), code: 128, killedByWatchdog: killed, durationMs: 0, stderr: Buffer.from(stderr, 'utf8') };
}
/** The remote answered (ls-remote rc 0) but the local ref update failed, e.g. a stale refs/cowork-remote lock. */
function localFailResult(board: Oid): FetchResult {
  return {
    ok: false, remoteAnswered: true, values: new Map([[refs.remoteBoard, board], [refs.remoteCode, MIRROR], [refs.remoteBranch, BR]]),
    code: 1, killedByWatchdog: false, durationMs: 0, stderr: Buffer.from("error: cannot lock ref 'refs/cowork-remote/main/board'", 'utf8'),
  };
}

interface Deferred<T> { promise: Promise<T>; resolve(v: T): void; }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(cond(), what);
}

function recorder(): Trace & { events: TraceEvent[] } {
  const events: TraceEvent[] = [];
  return { events, emit: (ev) => events.push(ev) };
}

/** A deferred view: the last view's fields, no fetch ran (never firstOfRun). */
const deferredOf = (v: FetchView): FetchView => ({ ...v, deferred: true, firstOfRun: false });

/** A FetchImpl that records each start (Δmono of the clock) and answers from a queue of results or promises. */
function scripted(clock: VirtualClock, answers: Array<FetchResult | Promise<FetchResult> | ((n: number) => FetchResult)>): { impl: FetchImpl; starts: number[]; specs: Array<readonly FetchSpec[]> } {
  const starts: number[] = [];
  const specs: Array<readonly FetchSpec[]> = [];
  const impl: FetchImpl = (_repo, url, s) => {
    assert.equal(url, URL);
    starts.push(clock.monoMs());
    specs.push(s);
    const a = answers[Math.min(starts.length - 1, answers.length - 1)]!;
    return Promise.resolve(typeof a === 'function' ? a(starts.length) : a);
  };
  return { impl, starts, specs };
}

test('a 7 s fetch starts no second fetch; a request during it awaits it; the next starts right after it ends', async () => {
  const clock = new NoSleepClock();
  const trace = recorder();
  const slow = deferred<FetchResult>();
  const s = scripted(clock, [slow.promise, okResult(X2)]);
  const f = new Fetcher({ repo, url: URL, refs, clock, trace, peer: PEER, impl: s.impl });
  const p1 = f.fetch();
  await flush();
  assert.deepEqual(s.starts, [0]);
  assert.equal(f.inFlight(), true);
  assert.equal(s.specs[0], refs.fetchSpecs, 'the three glossary §4 refspecs');
  clock.advance(3_000);
  const p2 = f.fetch(true);          // a gate fresh-fetch request during the slow fetch (force skips spacing, never the single flight)
  const p3 = f.fetch();
  await flush();
  assert.deepEqual(s.starts, [0], 'no second fetch while one is in flight');
  clock.advance(4_000);
  slow.resolve(okResult(X1));
  const [v1, v2, v3] = await Promise.all([p1, p2, p3]);
  assert.deepEqual(v1, {
    ok: true, board: X1, code: MIRROR, branch: BR, completedMono: 7_000, httpThrottle: null, killedByWatchdog: false, firstOfRun: true,
    deferred: false, localFailure: false,
  });
  assert.deepEqual(v2, v1, 'the request during the fetch got that fetch');
  assert.deepEqual(v3, v1);
  assert.equal(f.inFlight(), false);
  const v4 = await f.fetch();
  assert.deepEqual(s.starts, [0, 7_000], 'the next starts right after it ends (it took longer than 2.5 s)');
  assert.equal(v4.board, X2);
  assert.equal(v4.firstOfRun, false);
  assert.deepEqual(trace.events, [
    { kind: 'fetch', peer: PEER, ok: true, board: X1, code: MIRROR, branch: BR },
    { kind: 'fetch', peer: PEER, ok: true, board: X2, code: MIRROR, branch: BR },
  ]);
});

test('fetch starts are at least 2.5 s apart', async () => {
  const clock = new NoSleepClock({ startMono: 500 });
  const trace = recorder();
  // [gap before the request, how long the fetch takes if it starts]
  const plan: Array<[number, number]> = [[0, 200], [100, 0], [1_000, 1_200], [2_400, 3_000], [0, 100], [2_600, 0], [7_000, 2_499], [0, 0], [1, 2_501], [0, 0]];
  let took = 0;
  const starts: number[] = [];
  const impl: FetchImpl = () => {
    starts.push(clock.monoMs());
    clock.advance(took);
    return Promise.resolve(okResult(starts.length % 2 === 1 ? X1 : X2));
  };
  const f = new Fetcher({ repo, url: URL, refs, clock, trace, peer: PEER, impl });
  const expected: number[] = [];
  let last: FetchView | null = null;
  for (const [gap, duration] of plan) {
    clock.advance(gap);
    took = duration;
    const requested = clock.monoMs();
    const due = expected.length === 0 || requested >= expected[expected.length - 1]! + FETCH_SPACING_MS;
    if (due) expected.push(requested);
    const v = await f.fetch();
    if (due) {
      assert.equal(v.deferred, false, `request at ${requested} starts a fetch`);
      assert.equal(f.nextAllowedMono(), requested + FETCH_SPACING_MS, `next allowed after the start at ${requested}`);
      last = v;
    } else {
      // Inside the spacing: the last view at once, no git call, no time spent (P2-NOSLEEP).
      assert.deepEqual(v, deferredOf(last!), `request at ${requested} is deferred`);
      assert.equal(clock.monoMs(), requested);
    }
  }
  assert.deepEqual(starts, expected);
  assert.deepEqual(starts, [500, 4_200, 7_200, 9_900, 16_900, 19_400, 21_901]);
  for (let k = 1; k < starts.length; k++) assert.ok(starts[k]! - starts[k - 1]! >= FETCH_SPACING_MS, `starts ${k - 1} and ${k} are ${starts[k]! - starts[k - 1]!} ms apart`);
  assert.equal(trace.events.length, starts.length, 'a deferred request emits no fetch trace');
});

test('offline after 30 s Δmono; backoff 30 s, 60 s, … 300 s; a success resets it', async () => {
  const clock = new NoSleepClock({ startMono: 1_000 });
  let mode: 'fail' | 'ok' | 'throttled' = 'fail';
  const s = scripted(clock, [() => (mode === 'ok' ? okResult(X1) : mode === 'throttled' ? failResult('error: RPC failed; HTTP 429 curl 22', true) : failResult())]);
  const f = new Fetcher({ repo, url: URL, refs, clock, trace: recorder(), peer: PEER, impl: s.impl });
  // Every timer restarts at construction (daemon start); no fetch has succeeded yet.
  assert.equal(f.lastSuccessMono(), null);
  assert.deepEqual(f.offline(), { offline: false, offlineForMs: 0 });
  clock.advance(OFFLINE_AFTER_MS);
  assert.deepEqual(f.offline(), { offline: false, offlineForMs: OFFLINE_AFTER_MS }, 'not before > 30 s');
  clock.advance(1);
  assert.deepEqual(f.offline(), { offline: true, offlineForMs: OFFLINE_AFTER_MS + 1 });
  // Failed attempts back off 30 s doubling to 5 min, each measured from the failure. fetch() never waits it out:
  // inside the backoff it returns the last view at once, forced or not (P2-NOSLEEP).
  const backoffs: number[] = [];
  for (let k = 0; k < 7; k++) {
    const v = await f.fetch();
    assert.deepEqual({ ok: v.ok, deferred: v.deferred, localFailure: v.localFailure, firstOfRun: v.firstOfRun, board: v.board }, { ok: false, deferred: false, localFailure: false, firstOfRun: false, board: ABSENT });
    const backoff = f.nextAllowedMono() - v.completedMono;
    backoffs.push(backoff);
    clock.advance(backoff - 1);
    const n = s.starts.length;
    assert.deepEqual(await f.fetch(), deferredOf(v), `attempt ${k}: 1 ms before the backoff ends`);
    assert.deepEqual(await f.fetch(true), deferredOf(v), `attempt ${k}: force never skips the backoff`);
    assert.equal(s.starts.length, n, 'no git call inside the backoff');
    clock.advance(1);
  }
  assert.deepEqual(backoffs, [30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
  for (let k = 1; k < s.starts.length; k++) assert.equal(s.starts[k]! - s.starts[k - 1]!, backoffs[k - 1], `attempt ${k} waited its backoff`);
  assert.deepEqual(f.offline(), { offline: true, offlineForMs: clock.monoMs() - 1_000 });
  // The transport report reaches the view: HTTP status for the throttle fallback and a watchdog kill.
  mode = 'throttled';
  const t = await f.fetch();
  assert.equal(t.httpThrottle, 'http_429');
  assert.equal(t.killedByWatchdog, true);
  // A success resets the backoff and the offline clock.
  mode = 'ok';
  clock.advance(f.nextAllowedMono() - clock.monoMs());
  const okView = await f.fetch();
  assert.equal(okView.ok, true);
  assert.equal(okView.firstOfRun, true, 'the first successful fetch of the run');
  assert.equal(okView.board, X1);
  assert.equal(f.lastSuccessMono(), okView.completedMono);
  assert.deepEqual(f.offline(), { offline: false, offlineForMs: 0 });
  assert.equal(f.nextAllowedMono(), s.starts[s.starts.length - 1]! + FETCH_SPACING_MS, 'plain spacing again');
  mode = 'fail';
  clock.advance(FETCH_SPACING_MS);
  const again = await f.fetch();
  assert.equal(again.completedMono - okView.completedMono, FETCH_SPACING_MS);
  assert.equal(f.nextAllowedMono() - again.completedMono, 30_000, 'the backoff restarts at 30 s');
  clock.advance(OFFLINE_AFTER_MS - FETCH_SPACING_MS);
  assert.deepEqual(f.offline(), { offline: false, offlineForMs: OFFLINE_AFTER_MS }, 'offline counts from the last answer of the remote');
  clock.advance(1);
  assert.equal(f.offline().offline, true);
});

test('fetch() never sleeps: inside the spacing or a backoff it returns the last view at once with deferred true and no git call; force skips only the spacing (ruling P2-NOSLEEP)', async () => {
  const clock = new NoSleepClock();
  const trace = recorder();
  const s = scripted(clock, [okResult(X1), failResult(), okResult(X2)]);
  const f = new Fetcher({ repo, url: URL, refs, clock, trace, peer: PEER, impl: s.impl });
  const v1 = await f.fetch();
  assert.equal(v1.deferred, false);
  clock.advance(1_000);
  assert.deepEqual(await f.fetch(), deferredOf(v1), 'inside the 2.5 s spacing');
  assert.equal(clock.monoMs(), 1_000, 'no virtual time passed');
  assert.deepEqual(s.starts, [0]);
  // force skips the spacing ...
  const v2 = await f.fetch(true);
  assert.deepEqual({ ok: v2.ok, deferred: v2.deferred }, { ok: false, deferred: false });
  assert.deepEqual(s.starts, [0, 1_000]);
  // ... never the 30 s network backoff that failure armed.
  for (const step of [0, FETCH_SPACING_MS, 29_999 - FETCH_SPACING_MS]) {
    clock.advance(step);
    assert.deepEqual(await f.fetch(), deferredOf(v2), `${clock.monoMs()}: unforced`);
    assert.deepEqual(await f.fetch(true), deferredOf(v2), `${clock.monoMs()}: forced`);
  }
  assert.deepEqual(s.starts, [0, 1_000], 'no git call during the backoff');
  assert.equal(f.inFlight(), false);
  // After the backoff a fetch runs.
  clock.advance(1);
  const v3 = await f.fetch();
  assert.deepEqual({ ok: v3.ok, deferred: v3.deferred, board: v3.board }, { ok: true, deferred: false, board: X2 });
  assert.deepEqual(s.starts, [0, 1_000, 31_000]);
  assert.equal(trace.events.length, 3, 'deferred views emit no fetch trace');
});

test('a local failure (the remote answered) is never offline and arms no network backoff (ruling P2-FETCHLOCAL)', async () => {
  const clock = new NoSleepClock();
  const s = scripted(clock, [localFailResult(X1), localFailResult(X1), failResult(), okResult(X2)]);
  const f = new Fetcher({ repo, url: URL, refs, clock, trace: recorder(), peer: PEER, impl: s.impl });
  clock.advance(OFFLINE_AFTER_MS + 1);
  const v1 = await f.fetch();
  assert.deepEqual({ ok: v1.ok, localFailure: v1.localFailure, board: v1.board, deferred: v1.deferred }, { ok: false, localFailure: true, board: X1, deferred: false });
  assert.deepEqual(f.offline(), { offline: false, offlineForMs: 0 }, 'the remote answered');
  assert.equal(f.lastSuccessMono(), null, 'but nothing was fetched');
  assert.equal(f.nextAllowedMono(), clock.monoMs() + FETCH_SPACING_MS, 'plain spacing, no network backoff');
  clock.advance(FETCH_SPACING_MS);
  const v2 = await f.fetch();
  assert.equal(v2.localFailure, true);
  assert.equal(f.nextAllowedMono(), clock.monoMs() + FETCH_SPACING_MS);
  // A network failure after it backs off 30 s (the first network failure), and offline counts from the last answer.
  clock.advance(FETCH_SPACING_MS);
  const v3 = await f.fetch();
  assert.deepEqual({ ok: v3.ok, localFailure: v3.localFailure }, { ok: false, localFailure: false });
  assert.equal(f.nextAllowedMono() - v3.completedMono, 30_000);
  assert.deepEqual(f.offline(), { offline: false, offlineForMs: FETCH_SPACING_MS });
  clock.advance(30_000);
  assert.equal(f.offline().offline, true);
  const v4 = await f.fetch();
  assert.deepEqual({ ok: v4.ok, localFailure: v4.localFailure, firstOfRun: v4.firstOfRun }, { ok: true, localFailure: false, firstOfRun: true });
  assert.deepEqual(s.starts, [OFFLINE_AFTER_MS + 1, OFFLINE_AFTER_MS + 1 + FETCH_SPACING_MS, OFFLINE_AFTER_MS + 1 + 2 * FETCH_SPACING_MS, OFFLINE_AFTER_MS + 1 + 2 * FETCH_SPACING_MS + 30_000]);
});

test('abandon() forces the next fetch', async () => {
  const clock = new NoSleepClock();
  const trace = recorder();
  const exited = deferred<void>();
  const starts: number[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const impl: FetchImpl = async (_repo, _url, _specs, abort) => {
    starts.push(clock.monoMs());
    signals.push(abort);
    const n = starts.length;
    if (n === 4) {
      // Hung (e.g. across a suspend) until aborted; the killed process then takes a moment to exit; its result is discarded.
      await new Promise<void>((res) => abort?.addEventListener('abort', () => res(), { once: true }));
      await exited.promise;
      return okResult(X1);
    }
    if (n === 6) return failResult();
    return okResult(n === 5 ? X2 : X1);
  };
  const f = new Fetcher({ repo, url: URL, refs, clock, trace, peer: PEER, impl });
  await f.fetch();
  clock.advance(1_000);
  // Nothing in flight: the next fetch skips the 2.5 s spacing, the one after it is spaced again.
  f.abandon();
  assert.equal(f.inFlight(), false);
  assert.equal((await f.fetch()).deferred, false);
  assert.equal((await f.fetch()).deferred, true, 'spaced again');
  clock.advance(FETCH_SPACING_MS);
  await f.fetch();
  assert.deepEqual(starts, [0, 1_000, 3_500]);
  // In flight: abandon() aborts it, and nothing new starts until the aborted fetch has exited (O-FETCH).
  clock.advance(FETCH_SPACING_MS);
  const pStale = f.fetch();
  await flush();
  assert.deepEqual(starts, [0, 1_000, 3_500, 6_000]);
  clock.advance(100);
  f.abandon();
  assert.equal(signals[3]?.aborted, true, 'the in-flight fetch is aborted');
  assert.equal(f.inFlight(), true, 'in flight until the aborted fetch exits and the forced one completes');
  const joined = f.fetch();
  await flush();
  assert.deepEqual(starts, [0, 1_000, 3_500, 6_000], 'no second fetch while the aborted one is alive');
  clock.advance(50);
  exited.resolve();
  const fresh = await pStale;
  assert.deepEqual(starts, [0, 1_000, 3_500, 6_000, 6_150], 'the forced fetch starts as soon as the aborted one exited');
  assert.equal(fresh.board, X2, 'the waiter of the abandoned fetch never sees its result');
  assert.deepEqual(await joined, fresh, 'a request after abandon() joins the forced fetch');
  assert.deepEqual(trace.events.map((e) => (e.kind === 'fetch' ? e.board : null)), [X1, X1, X1, X2], 'no trace of the abandoned fetch');
  // abandon() skips the spacing, never a network backoff (force never does, P2-NOSLEEP).
  clock.advance(FETCH_SPACING_MS);
  const failed = await f.fetch();
  assert.equal(failed.ok, false);
  assert.equal(f.nextAllowedMono() - failed.completedMono, 30_000);
  f.abandon();
  assert.deepEqual(await f.fetch(), deferredOf(failed), 'inside the backoff even after abandon()');
  assert.equal(starts.length, 6);
  clock.advance(30_000);
  const after = await f.fetch();
  assert.equal(after.ok, true);
  assert.deepEqual(starts.slice(5), [8_650, 38_650]);
});

test('abandon() during a fetch never has two fetches alive at once (O-FETCH, ruling P2-ABORT)', async () => {
  const clock = new NoSleepClock();
  let started = 0;
  let alive = 0;
  let maxAlive = 0;
  const impl: FetchImpl = (_repo, _url, _specs, abort) => {
    started += 1;
    alive += 1;
    maxAlive = Math.max(maxAlive, alive);
    const n = started;
    return new Promise<FetchResult>((resolve) => {
      // The process exits a moment after its kill (or at once for the last one); a fetch nobody aborts runs on.
      const exit = (): void => { setTimeout(() => { alive -= 1; resolve(okResult(n % 2 === 1 ? X1 : X2)); }, 5); };
      if (n >= 4) exit();
      else abort?.addEventListener('abort', exit, { once: true });
    });
  };
  const f = new Fetcher({ repo, url: URL, refs, clock, trace: recorder(), peer: PEER, impl });
  const p = f.fetch();
  // Three suspend gaps in a row, each while a fetch hangs.
  for (let k = 1; k <= 3; k++) {
    await until(() => started === k, `fetch ${k} started`);
    f.abandon();
  }
  const v = await p;
  assert.equal(started, 4);
  assert.equal(maxAlive, 1, 'never two fetches alive at once');
  assert.equal(alive, 0);
  assert.equal(v.board, X2, 'the waiter got the fourth (first unabandoned) fetch');
});

test('fetchNow() (the human-typed recover, 01-engine §3.7 step 1) skips the spacing and the network backoff, never the single flight', async () => {
  const clock = new NoSleepClock();
  const gate = deferred<FetchResult>();
  const s = scripted(clock, [failResult(), okResult(X1), gate.promise, okResult(X2)]);
  const f = new Fetcher({ repo, url: URL, refs, clock, trace: recorder(), peer: PEER, impl: s.impl });
  const failed = await f.fetch();
  assert.equal(failed.ok, false);
  clock.advance(1_000);
  assert.deepEqual(await f.fetch(true), deferredOf(failed), 'a forced fetch waits out the 30 s backoff');
  // The human's fetch runs now, inside the backoff, and its success ends the backoff.
  const now = await f.fetchNow();
  assert.deepEqual({ ok: now.ok, deferred: now.deferred, board: now.board }, { ok: true, deferred: false, board: X1 });
  assert.deepEqual(s.starts, [0, 1_000]);
  assert.equal(f.offline().offline, false);
  // Inside the spacing it runs too; while a fetch is in flight it joins that fetch.
  const flying = f.fetchNow();
  const joined = f.fetchNow();
  assert.equal(f.inFlight(), true);
  gate.resolve(okResult(X2));
  assert.deepEqual([(await flying).board, (await joined).board], [X2, X2]);
  assert.deepEqual(s.starts, [0, 1_000, 1_000], 'one process for both requests');
});
