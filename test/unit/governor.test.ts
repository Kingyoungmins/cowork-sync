import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOid, type Oid } from '../../src/git/oid.js';
import { genesisProtocol, readProtocol } from '../../src/board/protocol.js';
import {
  EVENT_SPACING_MS,
  FALLBACK_LOCAL,
  FALLBACK_MS,
  G_CAP_MS,
  Governor,
  NET_BACKOFF_MAX_MS,
  NET_BACKOFF_MIN_MS,
  NORMAL_LOCAL,
  RESTART_EVENT_HEIGHTS,
  SLOW_PUSH_MS,
  WINDOW_MS,
  type AttemptEnd,
  type GovernorParams,
  type ThrottleSignal,
} from '../../src/board/governor.js';
import { VirtualClock } from '../sim/vclock.js';

const P12: GovernorParams = { budget: 12, G_s: 5, S_s: 1.5 };
const oid = (n: number): Oid => parseOid(n.toString(16).padStart(40, '0'));
const MIN = 60_000;

/** One attempt as governedPush reports it: a fast push with a per-ref status line, here a lease loss. */
const END: AttemptEnd = { durationMs: 1_000, killed: false, hadRefStatus: true, transient: false, landed: false };
function attempt(g: Governor, e: Partial<AttemptEnd> = {}): void {
  g.onAttemptStart();
  g.onAttemptEnd({ ...END, ...e });
}

/** Advances to the first instant (1 ms steps over [from, to]) at which mayAttempt is true; -1 when none. */
function firstOpen(c: VirtualClock, g: Governor, rank: number, toMs: number, exempt = false): number {
  while (c.monoMs() <= toMs) {
    if (g.mayAttempt(rank, true, true, exempt)) return c.monoMs();
    c.advance(1);
  }
  return -1;
}

test('the constants are the glossary §27.2 / 02-protocol §3.8 values', () => {
  assert.deepEqual({ ...NORMAL_LOCAL }, { B: 24, G_ms: 2_500, S_ms: 750 });
  assert.deepEqual({ ...FALLBACK_LOCAL }, { B: 6, G_ms: 10_000, S_ms: 3_000 });
  assert.ok(Object.isFrozen(NORMAL_LOCAL) && Object.isFrozen(FALLBACK_LOCAL));
  assert.equal(FALLBACK_MS, 1_800_000);
  assert.equal(EVENT_SPACING_MS, 900_000);
  assert.equal(G_CAP_MS, 60_000);
  assert.equal(WINDOW_MS, 60_000);
  assert.equal(SLOW_PUSH_MS, 10_000);
  assert.equal(RESTART_EVENT_HEIGHTS, 180);
  assert.equal(NET_BACKOFF_MIN_MS, 30_000);
  assert.equal(NET_BACKOFF_MAX_MS, 300_000);
});

test('the window opens at G_eff + (rank − 1)·S_eff after the anchor; the anchor moves only on a tip change or the own ok', () => {
  const c = new VirtualClock();
  const g = new Governor(c, P12);
  assert.deepEqual(g.effective(), { B: 12, Gbase_ms: 5_000, S_ms: 1_500, G_ms: 5_000, k: 0 });
  // No anchor before the first observation of the board tip: no window yet.
  assert.equal(g.mayAttempt(1, true, true), false);
  assert.equal(g.msUntilWindow(1), Infinity);

  g.onFetch(oid(1), 0, true, true); // anchor := now (t = 0)
  assert.equal(g.msUntilWindow(1), 5_000);
  assert.equal(g.msUntilWindow(3), 8_000); // 5 s + 2 · 1.5 s
  assert.equal(firstOpen(c, g, 3, 20_000), 8_000);
  assert.equal(g.mayAttempt(1, true, true), true);

  // A fetch that sees the same tip does not move the anchor.
  c.advance(1_000); // t = 9 s
  g.onFetch(oid(1), 0, false, true);
  assert.equal(g.mayAttempt(3, true, true), true);
  // Nothing else moves it either: a parameter refresh from the same tip, an event queued.
  g.setParams(P12);
  g.onEventQueued();
  assert.equal(g.msUntilWindow(3), 0);

  // A tip change moves it.
  g.onFetch(oid(2), 1, false, true); // anchor := 9 s
  assert.equal(g.mayAttempt(3, true, true), false);
  assert.equal(g.msUntilWindow(3), 8_000);
  assert.equal(g.msUntilWindow(1), 5_000);
  assert.equal(firstOpen(c, g, 1, 30_000), 14_000);

  // The own ok moves it: anchor := receipt of ok; the own spacing also runs from the attempt.
  g.onAttemptStart();
  assert.equal(g.mayAttempt(1, true, true), false, 'no attempt while one is in flight');
  c.advance(1_200);
  g.onAttemptEnd({ ...END, durationMs: 1_200, landed: true });
  g.onOwnOk(oid(3)); // anchor := 15.2 s
  assert.equal(g.msUntilWindow(1), 5_000);
  assert.equal(firstOpen(c, g, 1, 40_000), 20_200);
  // The next fetch reveals our own commit as the tip: not a tip change, the anchor stays.
  c.advance(500);
  g.onFetch(oid(3), 0, false, true);
  assert.equal(g.mayAttempt(1, true, true), true);

  // Nothing pending: no attempt, and no time-based wake.
  assert.equal(g.mayAttempt(1, false, true), false);
  assert.equal(g.msUntilWindow(1), Infinity);
  assert.equal(g.mayAttempt(1, true, false), false, 'state does not allow');
  assert.equal(g.msUntilWindow(1), Infinity);
});

test('no 13th attempt within 60 s at B = 12', () => {
  const c = new VirtualClock();
  const g = new Governor(c, P12);
  g.onFetch(oid(1), 0, true, true);
  // exempt isolates the per-peer cap from the window and the G_eff spacing.
  for (let i = 0; i < 12; i++) {
    assert.equal(g.mayAttempt(1, true, true, true), true, `attempt ${i + 1}`);
    attempt(g);
    c.advance(1_000);
  }
  assert.equal(g.attemptsInWindow(), 12);
  // t = 12 s: the 13th waits until the first (t = 0) is 60 s old.
  assert.equal(g.mayAttempt(1, true, true, true), false);
  assert.equal(g.mayAttempt(1, true, true), false);
  assert.equal(g.msUntilWindow(1), 48_000);
  assert.equal(firstOpen(c, g, 1, 70_000, true), 60_000);
  assert.equal(g.attemptsInWindow(), 11);
  attempt(g);
  assert.equal(g.mayAttempt(1, true, true, true), false, 'the cap binds again');
  assert.equal(firstOpen(c, g, 1, 70_000, true), 61_000);
});

test('12 observed landings within 40 s block every attempt until the oldest is 60 s old, then exactly one; aging never bypasses it; in fallback it stops at 6', () => {
  const c = new VirtualClock();
  const g = new Governor(c, P12);
  g.onFetch(oid(1), 50, true, true); // first fetch of the run: history, not landings
  assert.equal(g.mayAttempt(1, true, true, true), true, 'a joiner is not held 60 s by the history its first fetch revealed');
  c.advance(1_000);
  g.onFetch(oid(2), 6, false, true); // t = 1 s: one fetch revealing 6
  c.advance(1_000);
  attempt(g, { landed: true });
  g.onOwnOk(oid(3)); // t = 2 s: its own ok
  for (let i = 0; i < 5; i++) {
    c.advance(7_600);
    g.onFetch(oid(4 + i), 1, false, true); // five more fetches, the last at t = 40 s
  }
  assert.equal(c.monoMs(), 40_000);
  // Pending work, rank 1 and aged (five pre-emptions since the own attempt): the window alone would open
  // at t = 45 s (G_base after the last anchor), but the guard holds until the six oldest are 60 s old.
  assert.equal(g.msUntilWindow(1), 21_000);
  for (let t = 40_000; t < 61_000; t += 250) {
    assert.equal(g.mayAttempt(1, true, true), false, `t = ${t}`);
    assert.equal(g.mayAttempt(1, true, true, true), false, `exempt, t = ${t}`);
    c.advance(250);
  }
  assert.equal(c.monoMs(), 61_000);
  assert.equal(g.mayAttempt(1, true, true), true);
  g.onAttemptStart(); // exactly one
  assert.equal(g.mayAttempt(1, true, true), false);
  c.advance(1_000);
  g.onAttemptEnd({ ...END, landed: true });
  g.onOwnOk(oid(20)); // 7 landings in the last 60 s now: the guard is open, the window is not
  assert.equal(g.mayAttempt(1, true, true), false);

  // Normal mode: 11 landings leave the guard open, the 12th closes it.
  const c2 = new VirtualClock();
  const n = new Governor(c2, P12);
  n.onFetch(oid(1), 0, true, true);
  n.onFetch(oid(2), 11, false, true);
  assert.equal(n.mayAttempt(1, true, true, true), true);
  n.onFetch(oid(3), 1, false, true);
  assert.equal(n.mayAttempt(1, true, true, true), false);

  // Fallback: B_eff = 6, so the guard stops at 6 observed landings.
  const c3 = new VirtualClock();
  const f = new Governor(c3, P12);
  f.onFetch(oid(1), 0, true, true);
  f.onSignal('http_429', true, true);
  assert.equal(f.effective().B, 6);
  f.onFetch(oid(2), 5, false, true);
  assert.equal(f.mayAttempt(1, true, true, true), true);
  f.onFetch(oid(3), 1, false, true);
  assert.equal(f.mayAttempt(1, true, true, true), false);
  assert.equal(f.msUntilWindow(1), 60_000);
});

test('two pre-emptions age a peer to rank 1 at G_base', () => {
  const c = new VirtualClock();
  const g = new Governor(c, P12);
  g.onFetch(oid(1), 0, true, true);
  attempt(g, { killed: true });
  attempt(g, { killed: true }); // k = 2: G_eff = 20 s
  assert.equal(g.effective().G_ms, 20_000);
  c.advance(30_000); // the own G_eff spacing (from t = 0) is over

  g.onFetch(oid(2), 1, false, true); // t = 30 s: one pre-emption
  assert.equal(g.msUntilWindow(4), 24_500); // not aged: G_eff + 3 · S_eff
  c.advance(1_000);
  g.onFetch(oid(3), 1, false, true); // t = 31 s: two pre-emptions → aged
  assert.equal(g.msUntilWindow(4), 5_000); // rank 1 at G_base, throttle ignored for the shared window
  assert.equal(firstOpen(c, g, 4, 60_000), 36_000);

  // The own G_eff spacing still holds for an aged peer.
  const c2 = new VirtualClock();
  const s = new Governor(c2, P12);
  s.onFetch(oid(1), 0, true, true);
  attempt(s, { killed: true });
  attempt(s, { killed: true }); // G_eff 20 s from t = 0
  c2.advance(1_000);
  s.onFetch(oid(2), 1, false, true);
  s.onFetch(oid(3), 1, false, true); // aged at t = 1 s: the window opens at 6 s, the spacing at 20 s
  assert.equal(firstOpen(c2, s, 4, 60_000), 20_000);

  // What does not count: a tip change while nothing is pending, the own ok, and changes before the own
  // last attempt (the count restarts at each attempt).
  const c3 = new VirtualClock();
  const h = new Governor(c3, P12);
  h.onFetch(oid(1), 0, true, true);
  h.onFetch(oid(2), 1, false, false); // not pending
  h.onFetch(oid(3), 1, false, true); // one
  attempt(h, { landed: true });
  h.onOwnOk(oid(4)); // the own ok is not a pre-emption; the attempt restarted the count
  h.onFetch(oid(5), 1, false, true); // one
  assert.equal(h.msUntilWindow(4), 9_500, 'one pre-emption since the own attempt: not aged');
  h.mayAttempt(4, false, true); // pending became false: the count restarts
  h.onFetch(oid(6), 1, false, true); // one
  assert.equal(h.msUntilWindow(4), 9_500);
  h.onFetch(oid(7), 1, false, true); // two
  assert.equal(h.msUntilWindow(4), 5_000);

  // An ambiguous push whose landing the classify fetch revealed before onOwnOk: still the own commit.
  const c4 = new VirtualClock();
  const a = new Governor(c4, P12);
  a.onFetch(oid(1), 0, true, true);
  a.onAttemptStart();
  a.onFetch(oid(2), 1, false, true); // the classify fetch sees our Bnew as the new tip
  a.onAttemptEnd({ ...END, hadRefStatus: false, landed: true });
  a.onOwnOk(oid(2));
  a.onFetch(oid(3), 1, false, true); // one real pre-emption: not aged
  assert.equal(a.msUntilWindow(4), 14_500, 'k = 1 after the status-less attempt: G_eff 10 s + 3 · 1.5 s (aged would be 10 s)');
});

test('k rises on > 10 s, killed, status-less and transient attempts, falls by one otherwise, and G_eff never exceeds 60 s', () => {
  const c = new VirtualClock();
  const g = new Governor(c, P12);
  g.onFetch(oid(1), 0, true, true);
  const k = (): number => g.effective().k;
  attempt(g, { durationMs: SLOW_PUSH_MS + 1 });
  assert.equal(k(), 1);
  assert.equal(g.effective().G_ms, 10_000);
  attempt(g, { killed: true });
  assert.equal(k(), 2);
  attempt(g, { hadRefStatus: false });
  assert.equal(k(), 3);
  assert.equal(g.effective().G_ms, 40_000);
  attempt(g, { transient: true });
  assert.equal(k(), 4);
  assert.equal(g.effective().G_ms, G_CAP_MS, '5 s · 2^4 = 80 s is capped at 60 s');
  for (let i = 0; i < 10; i++) attempt(g, { killed: true });
  assert.equal(g.effective().G_ms, 60_000);
  assert.equal(k(), 4, 'k stops rising once G_eff reaches the cap');
  attempt(g); // a lease loss with a per-ref status within 10 s
  assert.equal(k(), 3, 'one lowering takes effect at once');
  assert.equal(g.effective().G_ms, 40_000);
  attempt(g, { durationMs: SLOW_PUSH_MS }); // exactly 10 s is "within 10 s"
  assert.equal(k(), 2);
  attempt(g, { landed: true });
  assert.equal(k(), 1);
  attempt(g, { landed: true });
  attempt(g, { landed: true });
  assert.equal(k(), 0, 'never below 0');

  // At most one increment per attempt.
  attempt(g, { durationMs: 20_000, killed: true, hadRefStatus: false, transient: true });
  assert.equal(k(), 1);
  // A transient rejection is never lowered by its fast per-ref status.
  attempt(g, { durationMs: 10, transient: true });
  assert.equal(k(), 2);

  // In fallback k multiplies the fallback G_base, still capped at 60 s.
  g.onSignal('http_5xx', true, true);
  assert.deepEqual(g.effective(), { B: 6, Gbase_ms: 10_000, S_ms: 3_000, G_ms: 40_000, k: 2 });
  attempt(g, { transient: true });
  assert.equal(g.effective().G_ms, 60_000);
});

test('after a transient the next window waits for the stricter of G_eff and the 30 s doubling backoff', () => {
  const c = new VirtualClock();
  const g = new Governor(c, P12);
  g.onFetch(oid(1), 0, true, true);
  assert.equal(firstOpen(c, g, 1, 10_000), 5_000);
  g.onAttemptStart();
  c.advance(1_000);
  g.onAttemptEnd({ ...END, transient: true }); // t = 6 s: k = 1 (G_eff 10 s), backoff 30 s
  assert.equal(g.msUntilWindow(1), 30_000, 'the backoff is stricter than G_eff');
  assert.equal(firstOpen(c, g, 1, 200_000), 36_000);
  g.onAttemptStart();
  c.advance(1_000);
  g.onAttemptEnd({ ...END, transient: true }); // t = 37 s: k = 2 (G_eff 20 s), backoff 60 s
  assert.equal(g.msUntilWindow(1), 60_000);
  assert.equal(firstOpen(c, g, 1, 200_000), 97_000, 'the third attempt starts ≈ 90 s after the first rejection');
  g.onAttemptStart();
  c.advance(1_000);
  g.onAttemptEnd({ ...END, transient: true }); // backoff 120 s
  assert.equal(g.msUntilWindow(1), 120_000);
  // A status-less (network) failure doubles the same backoff (ruling P2-NETBACKOFF; the streak is unchanged).
  c.advance(120_000);
  attempt(g, { hadRefStatus: false });
  assert.equal(g.msUntilWindow(1), 240_000);
  // The doubling stops at 5 min.
  c.advance(240_000);
  attempt(g, { transient: true });
  assert.equal(g.msUntilWindow(1), NET_BACKOFF_MAX_MS);
  // A landing (or a lease loss) resets it: the next transient waits 30 s again.
  c.advance(NET_BACKOFF_MAX_MS);
  for (let i = 0; i < 4; i++) attempt(g, { landed: true }); // k back to 0
  assert.equal(g.effective().k, 0);
  attempt(g, { transient: true }); // k = 1 (G_eff 10 s), backoff 30 s, not 5 min
  assert.equal(g.msUntilWindow(1), NET_BACKOFF_MIN_MS);
  c.advance(NET_BACKOFF_MIN_MS);
  attempt(g, { transient: true }); // backoff 60 s, k = 2
  assert.equal(g.msUntilWindow(1), 60_000);
  attempt(g);
  attempt(g); // two lease losses: the level resets, k back to 0
  attempt(g, { transient: true }); // k = 1, backoff 30 s
  assert.equal(g.msUntilWindow(1), NET_BACKOFF_MIN_MS);

  // When G_eff is the stricter one, it decides.
  const c2 = new VirtualClock();
  const h = new Governor(c2, P12);
  h.onFetch(oid(1), 0, true, true);
  for (let i = 0; i < 4; i++) attempt(h, { durationMs: SLOW_PUSH_MS + 1 }); // G_eff = 60 s; slow lease losses (a ref status) arm no backoff
  assert.equal(h.msUntilWindow(1), 60_000);
  c2.advance(60_000);
  h.onAttemptStart();
  c2.advance(2_000);
  h.onAttemptEnd({ ...END, durationMs: 2_000, transient: true });
  assert.equal(h.msUntilWindow(1), 58_000, 'G_eff spacing from the attempt start (60 s) beats the 30 s backoff');
});

test('a push failure without a ref status (transport failure, watchdog kill) arms the same 30 s doubling backoff, up to 5 min', () => {
  const c = new VirtualClock();
  const g = new Governor(c, P12);
  g.onFetch(oid(1), 0, true, true);
  assert.equal(firstOpen(c, g, 1, 10_000), 5_000);
  // A proxy kills the push at the 90 s watchdog (ruling P2-NETBACKOFF, ENG-19). G_eff alone (k = 1: 10 s
  // from the attempt start, 90 s ago) would allow the next 90 s push at once; the backoff holds it 30 s.
  g.onAttemptStart();
  c.advance(90_000);
  g.onAttemptEnd({ durationMs: 90_000, killed: true, hadRefStatus: false, transient: false, landed: false }); // t = 95 s
  assert.equal(g.effective().k, 1);
  assert.equal(g.mayAttempt(1, true, true), false, 'no back-to-back push after a kill');
  assert.equal(g.msUntilWindow(1), NET_BACKOFF_MIN_MS);
  assert.equal(firstOpen(c, g, 1, 200_000), 125_000);
  // A fast transport failure (no per-ref status line): 60 s.
  g.onAttemptStart();
  c.advance(2_000);
  g.onAttemptEnd({ ...END, durationMs: 2_000, hadRefStatus: false }); // t = 127 s, k = 2 (G_eff 20 s)
  assert.equal(g.msUntilWindow(1), 60_000);
  // Network failures and transient rejections double one backoff: 120 s, 240 s, then 5 min at most.
  c.advance(60_000);
  attempt(g, { transient: true });
  assert.equal(g.msUntilWindow(1), 120_000);
  c.advance(120_000);
  attempt(g, { killed: true, hadRefStatus: false });
  assert.equal(g.msUntilWindow(1), 240_000);
  c.advance(240_000);
  attempt(g, { hadRefStatus: false });
  assert.equal(g.msUntilWindow(1), NET_BACKOFF_MAX_MS);
  c.advance(NET_BACKOFF_MAX_MS);
  attempt(g, { hadRefStatus: false });
  assert.equal(g.msUntilWindow(1), NET_BACKOFF_MAX_MS, 'never above 5 min');
  // A status-less push that the fresh fetch resolved as landed resets it like any landing: only G_eff
  // (k = 4: 60 s) spaces the next attempt, and the doubling restarts at 30 s (30, 60, then 120 s).
  c.advance(NET_BACKOFF_MAX_MS);
  attempt(g, { hadRefStatus: false, landed: true });
  assert.equal(g.msUntilWindow(1), G_CAP_MS);
  for (const want of [G_CAP_MS, G_CAP_MS, 120_000]) {
    c.advance(g.msUntilWindow(1));
    attempt(g, { hadRefStatus: false });
    assert.equal(g.msUntilWindow(1), want);
  }
  // exempt (R-21) does not wait for it, as for a transient.
  assert.equal(g.mayAttempt(1, true, true, true), true);
});

test('an onAttemptEnd that refuses its input still ends the attempt, so the governor never wedges', () => {
  const c = new VirtualClock();
  const g = new Governor(c, P12);
  g.onFetch(oid(1), 0, true, true);
  const bad: unknown[] = [Number.NaN, -1, -0.5, undefined, '5'];
  for (const durationMs of bad) {
    assert.ok(firstOpen(c, g, 1, c.monoMs() + WINDOW_MS) >= 0, `the ordinary window opens again (durationMs ${String(durationMs)})`);
    g.onAttemptStart();
    assert.equal(g.mayAttempt(1, true, true, true), false, 'in flight');
    assert.throws(() => g.onAttemptEnd({ ...END, durationMs: durationMs as number }), RangeError);
    assert.equal(g.mayAttempt(1, true, true, true), true, 'the refused end cleared the attempt in flight');
    assert.throws(() => g.onAttemptEnd(END), /no attempt in flight/, 'the attempt already ended');
  }
  g.onAttemptStart();
  assert.throws(() => g.onAttemptEnd(null as unknown as AttemptEnd), TypeError);
  assert.equal(g.mayAttempt(1, true, true, true), true);
  assert.equal(g.attemptsInWindow(), bad.length + 1, 'every started attempt still counts for the cap');
  assert.equal(g.effective().k, 0, 'a refused end changes nothing else');
  // And a later well-formed attempt is governed as usual.
  assert.ok(firstOpen(c, g, 1, c.monoMs() + WINDOW_MS) >= 0);
  attempt(g, { transient: true });
  assert.equal(g.effective().k, 1);
  assert.equal(g.msUntilWindow(1), NET_BACKOFF_MIN_MS);
});

test('onOwnOk after the classify fetch revealed Bnew below a newer tip counts Bnew once and the newer commit as one pre-emption', () => {
  // Caller contract: `revealed` counts every new first-parent commit, the own Bnew included; onOwnOk adds
  // nothing a fetch completed since the attempt started already observed, and never moves the tip back.
  // Landings: 9 observed, then the classify fetch reveals Bnew = oid(3) and a teammate's oid(4) on top.
  const c = new VirtualClock();
  const g = new Governor(c, P12);
  g.onFetch(oid(1), 0, true, true);
  g.onFetch(oid(2), 9, false, false);
  c.advance(5_000);
  assert.equal(g.mayAttempt(1, true, true), true);
  g.onAttemptStart(); // lease oid(2), t = 5 s
  c.advance(1_000);
  g.onFetch(oid(4), 2, false, true); // t = 6 s, the classify fetch
  g.onAttemptEnd({ ...END, landed: true });
  g.onOwnOk(oid(3));
  assert.equal(g.mayAttempt(1, true, true, true), true, 'eleven landings observed, not twelve: the guard is open');

  // Pre-emptions: the T → oid(4) change is one (it carries a teammate commit); the next fetch of the same
  // tip is no change, so the peer is not aged and the anchor stays at the classify fetch (6 s).
  const c2 = new VirtualClock();
  const h = new Governor(c2, P12);
  h.onFetch(oid(1), 0, true, true);
  c2.advance(5_000);
  h.onAttemptStart();
  c2.advance(1_000);
  h.onFetch(oid(4), 2, false, true);
  h.onAttemptEnd({ ...END, landed: true });
  h.onOwnOk(oid(3));
  c2.advance(2_000);
  h.onFetch(oid(4), 0, false, true); // t = 8 s, the next loop's fetch
  assert.equal(h.msUntilWindow(4), 7_500, 'one pre-emption: 5 s + 3 · 1.5 s from 6 s');
  h.onFetch(oid(5), 1, false, true); // a second teammate commit: aged, rank 1 at G_base from 8 s
  assert.equal(h.msUntilWindow(4), 5_000);

  // Restart (ENG-53 push-intent resolution by observation): the first fetch of the run revealed Bnew below
  // a newer tip as history; the ok update then reaches onOwnOk with no attempt in this run. Nothing moves.
  const c3 = new VirtualClock();
  const r = new Governor(c3, P12);
  r.onFetch(oid(4), 40, true, true); // t = 0
  c3.advance(1_000);
  r.onOwnOk(oid(3));
  c3.advance(1_000);
  r.onFetch(oid(4), 0, false, true);
  assert.equal(r.msUntilWindow(1), 3_000, 'still anchored at the first fetch (t = 0)');
  r.onFetch(oid(5), 1, false, true);
  assert.equal(r.msUntilWindow(4), 9_500, 'one pre-emption, not two');
});

test('each throttle signal switches to B 6, G 10 s, S 3 s for the next decision and back after 30 min; a second signal restarts the timer', () => {
  const signals: ThrottleSignal[] = ['http_429', 'http_5xx', 'slow_push', 'rejection_streak'];
  for (const s of signals) {
    const c = new VirtualClock();
    const g = new Governor(c, P12);
    g.onFetch(oid(1), 0, true, true);
    assert.equal(g.mode(), 'normal');
    assert.equal(g.fallbackSource(), null);
    assert.equal(g.fallbackLeftMs(), 0);
    c.advance(7_000);
    assert.equal(g.mayAttempt(2, true, true), true, 'normal: 5 s + 1.5 s');
    g.onSignal(s, true, true);
    assert.equal(g.mode(), 'fallback');
    assert.equal(g.fallbackSource(), s);
    assert.deepEqual(g.effective(), { B: 6, Gbase_ms: 10_000, S_ms: 3_000, G_ms: 10_000, k: 0 });
    assert.equal(g.mayAttempt(2, true, true), false, 'the very next decision uses the fallback window (13 s)');
    assert.equal(g.msUntilWindow(2), 6_000);
    assert.equal(g.fallbackLeftMs(), FALLBACK_MS);
    c.advance(FALLBACK_MS - 1);
    assert.equal(g.mode(), 'fallback');
    assert.equal(g.fallbackLeftMs(), 1);
    c.advance(1);
    assert.equal(g.mode(), 'normal');
    assert.equal(g.fallbackSource(), null);
    assert.deepEqual(g.effective(), { B: 12, Gbase_ms: 5_000, S_ms: 1_500, G_ms: 5_000, k: 0 });
  }

  // A second signal restarts the 30 min.
  const c = new VirtualClock();
  const g = new Governor(c, P12);
  g.onSignal('slow_push', true, true);
  c.advance(20 * MIN);
  g.onSignal('http_5xx', false, false);
  c.advance(20 * MIN);
  assert.equal(g.mode(), 'fallback', '40 min after the first signal, 20 after the second');
  assert.equal(g.fallbackLeftMs(), 10 * MIN);
  assert.equal(g.fallbackSource(), 'http_5xx');
  c.advance(10 * MIN);
  assert.equal(g.mode(), 'normal');

  // Folding a HOST_THROTTLED event (own or a teammate's) also holds fallback for 30 min of this peer's Δmono.
  const c2 = new VirtualClock();
  const t = new Governor(c2, P12);
  t.onThrottleEventFolded(false);
  assert.equal(t.mode(), 'fallback');
  assert.equal(t.fallbackSource(), 'team');
  assert.equal(t.effective().B, 6);
  c2.advance(10 * MIN);
  t.onSignal('http_429', false, false);
  assert.equal(t.fallbackSource(), 'http_429', 'an own signal is the reported source while it holds');
  assert.equal(t.fallbackLeftMs(), FALLBACK_MS);
  c2.advance(FALLBACK_MS);
  assert.equal(t.mode(), 'normal');
});

test('postEvent only for a push signal or a fetch with pending work, at most once per 15 min; a follower never posts', () => {
  const c = new VirtualClock();
  const g = new Governor(c, P12);
  // A fetch-only signal with nothing else pending: fallback, no event (INV-PRO-QUIET).
  assert.deepEqual(g.onSignal('http_429', false, false), { postEvent: false });
  assert.equal(g.mode(), 'fallback');
  // A fetch signal while other work is pending, or any push signal: one event.
  assert.deepEqual(g.onSignal('http_429', false, true), { postEvent: true });
  assert.deepEqual(g.onSignal('slow_push', true, false), { postEvent: true }, 'onSignal itself does not stamp the event');
  g.onEventQueued();
  assert.deepEqual(g.onSignal('slow_push', true, true), { postEvent: false });
  c.advance(EVENT_SPACING_MS - 1);
  assert.deepEqual(g.onSignal('rejection_streak', true, true), { postEvent: false });
  c.advance(1);
  assert.deepEqual(g.onSignal('rejection_streak', true, true), { postEvent: true }, '15 min after the queued event');
  // The fold of its own event counts like queueing it (e.g. the restart rule's fold of a recent own event).
  g.onThrottleEventFolded(true);
  c.advance(EVENT_SPACING_MS - 1);
  assert.deepEqual(g.onSignal('http_5xx', true, true), { postEvent: false });
  c.advance(1);
  assert.deepEqual(g.onSignal('http_5xx', true, true), { postEvent: true });

  // A follower: in fallback only because it folded a teammate's event. Nothing it does posts on that
  // account — following has no posting path, its fallback is not its own (not persisted), and a
  // fetch-only signal still posts nothing.
  const c2 = new VirtualClock();
  const f = new Governor(c2, P12);
  f.onThrottleEventFolded(false);
  assert.equal(f.mode(), 'fallback');
  assert.equal(f.toMeta(), null);
  assert.deepEqual(f.onSignal('http_429', false, false), { postEvent: false });
  // Ruling P2-R18: ANY HOST_THROTTLED event this daemon folded — a teammate's too — counts toward the
  // 15 min ("folded, or put in its outbox, by this daemon"): even an own push signal posts nothing within
  // 15 min of folding a teammate's event; the team already has one.
  assert.deepEqual(f.onSignal('slow_push', true, true), { postEvent: false });
  c2.advance(EVENT_SPACING_MS - 1);
  assert.deepEqual(f.onSignal('http_5xx', true, true), { postEvent: false });
  c2.advance(1);
  assert.deepEqual(f.onSignal('http_5xx', true, true), { postEvent: true }, '15 min after the folded teammate event');
  // Every later fold restarts the 15 min, whoever wrote the event.
  f.onThrottleEventFolded(false);
  c2.advance(EVENT_SPACING_MS - 1);
  assert.deepEqual(f.onSignal('slow_push', true, true), { postEvent: false });
  c2.advance(1);
  assert.deepEqual(f.onSignal('slow_push', true, true), { postEvent: true });
});

test('fallbackSource names the own signal while an own folded event is the only cause, never the team', () => {
  // The ordinary own episode: a push signal, the event is queued, lands and is folded 5 min later.
  const c = new VirtualClock();
  const g = new Governor(c, P12);
  assert.deepEqual(g.onSignal('http_5xx', true, false), { postEvent: true });
  g.onEventQueued();
  c.advance(5 * MIN);
  g.onThrottleEventFolded(true);
  assert.equal(g.fallbackSource(), 'http_5xx');
  c.advance(26 * MIN); // the own signal is 31 min old: only the own folded event (26 min) holds fallback
  assert.equal(g.mode(), 'fallback');
  assert.equal(g.fallbackLeftMs(), 4 * MIN);
  assert.equal(g.fallbackSource(), 'http_5xx', 'the cause is still this peer, not a teammate');
  assert.equal(g.toMeta(), null, 'only a live own signal is persisted (ENG-05)');
  c.advance(4 * MIN);
  assert.equal(g.mode(), 'normal');
  assert.equal(g.fallbackSource(), null);

  // The same after a restart that restored the own fallback and then folded the own event (R-17).
  const c2 = new VirtualClock();
  const r = new Governor(c2, P12);
  r.restore({ signal: 'rejection_streak' });
  c2.advance(2 * MIN);
  r.onThrottleEventFolded(true);
  c2.advance(FALLBACK_MS - MIN); // restored signal 31 min old, own fold 29 min old
  assert.equal(r.mode(), 'fallback');
  assert.equal(r.fallbackSource(), 'rejection_streak');

  // A teammate's event that outlives the own causes is reported as the team's.
  const c3 = new VirtualClock();
  const t = new Governor(c3, P12);
  t.onSignal('http_429', true, true);
  t.onThrottleEventFolded(true);
  c3.advance(10 * MIN);
  t.onThrottleEventFolded(false);
  c3.advance(25 * MIN); // own signal and own fold 35 min old, the teammate's fold 25 min old
  assert.equal(t.mode(), 'fallback');
  assert.equal(t.fallbackSource(), 'team');
  assert.equal(t.fallbackLeftMs(), 5 * MIN);

  // Contract gap (flagged in the report): an own folded event with no own signal known to this run
  // (a restart whose meta.throttle was null) has no ThrottleSignal to name; it is not reported as the
  // team's. The mode is still fallback.
  const c4 = new VirtualClock();
  const u = new Governor(c4, P12);
  u.onThrottleEventFolded(true);
  assert.equal(u.mode(), 'fallback');
  assert.equal(u.fallbackLeftMs(), FALLBACK_MS);
  assert.equal(u.fallbackSource(), null);
});

test('a budget-3 board gives B_eff 3; a missing G_s reads 10', () => {
  const c = new VirtualClock();
  const three = readProtocol(Buffer.from(JSON.stringify(genesisProtocol(3, 'rs')), 'utf8'));
  const g = new Governor(c, three);
  assert.deepEqual(g.effective(), { B: 3, Gbase_ms: 20_000, S_ms: 6_000, G_ms: 20_000, k: 0 });
  g.onFetch(oid(1), 0, true, true);
  for (let i = 0; i < 3; i++) attempt(g);
  assert.equal(g.mayAttempt(1, true, true, true), false, 'per-peer cap 3');
  const g2 = new Governor(new VirtualClock(), three);
  g2.onFetch(oid(1), 0, true, true);
  g2.onFetch(oid(2), 3, false, true);
  assert.equal(g2.mayAttempt(1, true, true, true), false, 'team guard 3');

  // The stricter of the board and the local constants: a board above B_local = 24 still gives 24.
  const wide = new Governor(new VirtualClock(), { budget: 48, G_s: 1.25, S_s: 0.375 });
  assert.deepEqual(wide.effective(), { B: 24, Gbase_ms: 2_500, S_ms: 750, G_ms: 2_500, k: 0 });

  // A missing G_s reads as 10 (readProtocol), and so does a malformed one handed to the governor.
  const noG = readProtocol(Buffer.from('{"proto":1,"regionSpec":"rs","budget":12,"S_s":1.5}', 'utf8'));
  assert.equal(noG.G_s, 10);
  assert.equal(new Governor(c, noG).effective().Gbase_ms, 10_000);
  for (const bad of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
    const h = new Governor(c, { budget: 12, G_s: bad, S_s: 1.5 });
    assert.equal(h.effective().Gbase_ms, 10_000, `G_s ${bad}`);
    const b = new Governor(c, { budget: bad, G_s: 5, S_s: bad });
    assert.deepEqual(b.effective(), { B: 6, Gbase_ms: 10_000, S_ms: 3_000, G_ms: 10_000, k: 0 }, `budget/S_s ${bad}`);
  }
  // setParams applies the tip's protocol.json to the next decision.
  const s = new Governor(c, P12);
  s.setParams(three);
  assert.equal(s.effective().B, 3);
  // A non-integer G_s in whole ms (budget 7: 8.572 s) gives exact ms.
  assert.deepEqual(new Governor(c, genesisProtocol(7, 'rs')).effective(), { B: 7, Gbase_ms: 8_572, S_ms: 2_572, G_ms: 8_572, k: 0 });
});

test('restore(meta.throttle) restarts the own fallback for 30 min', () => {
  const c = new VirtualClock();
  const g = new Governor(c, P12);
  assert.equal(g.toMeta(), null);
  g.restore(null);
  assert.equal(g.mode(), 'normal');
  g.restore({ signal: 'rejection_streak' });
  assert.equal(g.mode(), 'fallback');
  assert.equal(g.fallbackSource(), 'rejection_streak');
  assert.equal(g.fallbackLeftMs(), FALLBACK_MS);
  assert.deepEqual(g.toMeta(), { signal: 'rejection_streak' });
  c.advance(FALLBACK_MS - 1);
  assert.deepEqual(g.toMeta(), { signal: 'rejection_streak' });
  c.advance(1);
  assert.equal(g.mode(), 'normal');
  assert.equal(g.toMeta(), null);

  // toMeta round-trips through a restart: a new governor (a new run, mono restarted) restores it.
  const live = new Governor(new VirtualClock(), P12);
  live.onSignal('http_429', true, true);
  const meta = live.toMeta();
  assert.deepEqual(meta, { signal: 'http_429' });
  const c2 = new VirtualClock({ startMono: 5 });
  const next = new Governor(c2, P12);
  next.restore(JSON.parse(JSON.stringify(meta)) as { signal: ThrottleSignal });
  assert.equal(next.fallbackLeftMs(), FALLBACK_MS);
  // Only the own fallback is persisted: a followed team event is not (the restart rule refolds it).
  const f = new Governor(new VirtualClock(), P12);
  f.onThrottleEventFolded(false);
  assert.equal(f.toMeta(), null);
  assert.throws(() => g.restore({ signal: 'teapot' as ThrottleSignal }), TypeError);
});

test('±600 s wall offsets and a 2 h suspend give identical decisions', () => {
  type Step = (g: Governor, c: VirtualClock) => void;
  const script: Step[] = [
    (g) => g.onFetch(oid(1), 4, true, true),
    (_g, c) => c.advance(4_000),
    (g) => g.onFetch(oid(2), 2, false, true),
    (_g, c) => c.advance(3_000),
    (g) => g.onFetch(oid(3), 1, false, true),
    (_g, c) => c.advance(6_000),
    (g) => g.onAttemptStart(),
    (_g, c) => c.advance(11_000),
    (g) => g.onAttemptEnd({ ...END, durationMs: 11_000, transient: true }),
    (g) => void g.onSignal('slow_push', true, true),
    (g) => g.onEventQueued(),
    (_g, c) => c.advance(29_000),
    (g) => g.onFetch(oid(4), 3, false, true),
    (_g, c) => c.advance(20 * MIN),
    (g) => void g.onSignal('http_429', false, false),
    (_g, c) => c.advance(25 * MIN),
    (g) => g.onThrottleEventFolded(false),
    (_g, c) => c.advance(31 * MIN),
  ];
  function run(c: VirtualClock, suspendAt: number | null): string[] {
    const g = new Governor(c, P12);
    const log: string[] = [];
    script.forEach((step, i) => {
      if (i === suspendAt) c.suspend(7_200_000);
      step(g, c);
      for (const rank of [1, 3]) log.push(`${i}:${rank}:${g.mayAttempt(rank, true, true)}:${g.mayAttempt(rank, true, true, true)}:${g.msUntilWindow(rank)}`);
      log.push(`${i}:${g.mode()}:${g.fallbackLeftMs()}:${String(g.fallbackSource())}:${JSON.stringify(g.effective())}:${g.attemptsInWindow()}:${JSON.stringify(g.toMeta())}`);
    });
    return log;
  }
  const base = run(new VirtualClock(), null);
  assert.ok(base.some((l) => l.includes(':true:')), 'the script reaches open windows');
  assert.ok(base.some((l) => l.includes(':fallback:')), 'and fallback');
  assert.deepEqual(run(new VirtualClock({ wallOffsetMs: 600_000 }), null), base);
  assert.deepEqual(run(new VirtualClock({ wallOffsetMs: -600_000 }), null), base);
  assert.deepEqual(run(new VirtualClock({ wallOffsetMs: -600_000, driftPpm: 500 }), null), base);
  for (const at of [1, 7, 12, 15]) assert.deepEqual(run(new VirtualClock({ wallOffsetMs: 600_000 }), at), base, `2 h suspend before step ${at}`);
});

test('exempt skips the window and the spacing but never the cap or the guard', () => {
  const c = new VirtualClock();
  const g = new Governor(c, P12);
  // No board tip observed yet (genesis probe): no window exists, but an exempt attempt may start.
  assert.equal(g.mayAttempt(1, true, true), false);
  assert.equal(g.mayAttempt(1, true, true, true), true);
  // Exempt still needs pending work, an allowing state and no attempt in flight.
  assert.equal(g.mayAttempt(1, false, true, true), false);
  assert.equal(g.mayAttempt(1, true, false, true), false);
  g.onAttemptStart();
  assert.equal(g.mayAttempt(1, true, true, true), false);
  assert.throws(() => g.onAttemptStart(), Error, 'two attempts in flight');
  g.onAttemptEnd({ ...END, transient: true }); // k = 1 and a 30 s backoff
  // The G_eff spacing and the transient backoff are not waited for (R-21: bounded by the per-peer cap).
  assert.equal(g.mayAttempt(1, true, true), false);
  assert.equal(g.mayAttempt(1, true, true, true), true);
  for (let i = 0; i < 11; i++) attempt(g, { transient: true });
  assert.equal(g.attemptsInWindow(), 12);
  assert.equal(g.mayAttempt(1, true, true, true), false, 'never the cap');
  c.advance(WINDOW_MS);
  assert.equal(g.mayAttempt(1, true, true, true), true);

  // Never the guard: 12 landings in the last 60 s block an exempt attempt too.
  const c2 = new VirtualClock();
  const h = new Governor(c2, P12);
  h.onFetch(oid(1), 0, true, false);
  h.onFetch(oid(2), 12, false, false);
  assert.equal(h.mayAttempt(1, true, true, true), false, 'never the guard');
  assert.equal(h.msUntilWindow(1), WINDOW_MS);
  c2.advance(WINDOW_MS);
  assert.equal(h.mayAttempt(1, true, true, true), true);
  assert.equal(h.mayAttempt(1, true, true), true, 'and the ordinary window has long opened');
});
