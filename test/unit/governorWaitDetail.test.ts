// Governor.waitDetail() (Plan 3 Task 18; rev 2.5, F14; 02-protocol §3.8 wait_detail(), FEAT-F14-13; 10-product §3.5.1 O6): the
// governor's wait for a ready group as the flow displays it — read-only (no attempt counted, no anchor, level or timer moved, no
// pruning of the 60 s windows) and the first blocking term in the display priority window > own_spacing > peer_cap > team_guard >
// in_flight > backoff, which is not mayAttempt's evaluation order. A Governor on a VirtualClock; no git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOid, type Oid } from '../../src/git/oid.js';
import { Governor, type AttemptEnd, type GovernorParams } from '../../src/board/governor.js';
import { VirtualClock } from '../sim/vclock.js';

const P12: GovernorParams = { budget: 12, G_s: 5, S_s: 1.5 };
const oid = (n: number): Oid => parseOid(n.toString(16).padStart(40, '0'));
const END: AttemptEnd = { durationMs: 1_000, killed: false, hadRefStatus: true, transient: false, landed: false };

function attempt(g: Governor, e: Partial<AttemptEnd> = {}): void {
  g.onAttemptStart();
  g.onAttemptEnd({ ...END, ...e });
}

/** Every field of the governor (its private state included, the clock aside) as one string: the byte-equal comparison. */
function stateOf(g: Governor): string {
  return JSON.stringify(Object.entries(g).filter(([k]) => k !== 'clock'));
}

test('waitDetail is read-only: 1,000 calls between two iterations leave attemptsInWindow(), the anchors, the throttle level and the fallback timers byte-equal', () => {
  const c = new VirtualClock();
  const g = new Governor(c, P12);
  g.onFetch(oid(1), 0, true, true);
  attempt(g);                                   // an attempt that will age past the 60 s window, unpruned
  c.advance(30_000);
  g.onFetch(oid(2), 3, false, true);            // three observed landings, an anchor move and a pre-emption
  attempt(g, { transient: true });              // k + 1 and the ENG-44 backoff armed
  g.onSignal('http_429', true, false);          // the 30 min fallback timer
  g.onThrottleEventFolded(false);               // a teammate's folded HOST_THROTTLED event
  c.advance(31_000);                            // the first attempt is now 61 s old and still in the governor's list
  const derived = (): unknown[] => [g.attemptsInWindow(), g.effective(), g.fallbackLeftMs(), g.mode(), g.fallbackSource(), g.toMeta()];
  const derivedBefore = derived();
  const before = stateOf(g);
  assert.ok(before.includes('"attempts"'), 'the serialized state carries the attempt list');
  assert.equal(JSON.parse(before).find(([k]: [string]) => k === 'attempts')[1].length, 2, 'the aged attempt is still listed (unpruned)');
  const answers = new Set<string>();
  for (let i = 0; i < 1_000; i++) answers.add(JSON.stringify(i % 2 === 0 ? g.waitDetail() : g.waitDetail(1 + ((i >> 1) % 8))));
  assert.equal(stateOf(g), before, 'no field of the governor changed (no prune, no anchor, level or timer moved)');
  assert.deepEqual(derived(), derivedBefore, 'attemptsInWindow(), the level and the fallback timers read the same');
  // Hand-computed (fallback: B_eff 6, S_eff 3 s; k = 1: G_eff 20 s; the anchor 31 s old): ranks 1–4 and the default rank (1) see the
  // window open; ranks 5–8 wait 20 s + (rank − 1) · 3 s − 31 s. Nothing else blocks (1 own attempt and 3 landings in the window, the
  // own spacing over, the 30 s backoff over). The same answers at every call: nothing moved between them.
  assert.deepEqual([...answers].sort(), [
    { ms: 0, term: 'window' }, { ms: 1_000, term: 'window' }, { ms: 4_000, term: 'window' }, { ms: 7_000, term: 'window' }, { ms: 10_000, term: 'window' },
  ].map((x) => JSON.stringify(x)).sort());
  // An iteration after the calls still sees the aged attempt pruned only by its own entry points (onFetch here).
  g.onFetch(oid(2), 0, false, true);
  assert.equal(g.attemptsInWindow(), 1, 'only the transient attempt is inside the window');
});

test("waitDetail follows the display priority, not mayAttempt's order: own_spacing before team_guard when both block, backoff alone gives backoff, a running push gives in_flight, B_eff own attempts in 60 s give peer_cap, and nothing blocking gives {ms: 0, term: 'window'}", () => {
  // own_spacing and team_guard both block (the window is open): own_spacing is shown; ms is the time until every term is clear.
  {
    const c = new VirtualClock();
    const g = new Governor(c, P12);
    g.onFetch(oid(1), 0, true, true);
    c.advance(1_000);
    g.onFetch(oid(2), 12, false, true);   // 12 = B_eff observed landings: the sliding team guard holds until they are 60 s old
    c.advance(5_500);
    attempt(g);                           // the own spacing runs 5 s from here
    c.advance(500);
    assert.deepEqual(g.waitDetail(1), { ms: 54_000, term: 'own_spacing' });
    assert.equal(g.mayAttempt(1, true, true), false);
    c.advance(4_500);                     // the own spacing is over; the team guard alone remains
    assert.deepEqual(g.waitDetail(1), { ms: 49_500, term: 'team_guard' });
  }
  // backoff alone: the ENG-44 transient backoff (30 s) outlasts the doubled G_eff.
  {
    const c = new VirtualClock();
    const g = new Governor(c, P12);
    g.onFetch(oid(1), 0, true, true);
    attempt(g, { transient: true });      // k = 1 → G_eff 10 s; backoff 30 s from now
    c.advance(20_000);
    assert.deepEqual(g.waitDetail(1), { ms: 10_000, term: 'backoff' });
  }
  // a running push: in_flight (a lower bound of 0 ms: the push's end is not known), once the own spacing since its start is over …
  {
    const c = new VirtualClock();
    const g = new Governor(c, P12);
    g.onFetch(oid(1), 0, true, true);
    c.advance(10_000);                    // the window has opened
    g.onAttemptStart();
    c.advance(1_000);
    // … and own_spacing while it is not: mayAttempt tests "no attempt in flight" before the spacing, the display shows the spacing first.
    assert.deepEqual(g.waitDetail(1), { ms: 4_000, term: 'own_spacing' });
    c.advance(5_000);
    assert.deepEqual(g.waitDetail(1), { ms: 0, term: 'in_flight' });
    assert.equal(g.mayAttempt(1, true, true), false);
  }
  // B_eff (12) own attempts in the last 60 s: peer_cap until the oldest one ages out — after the own spacing since the last of them,
  // which blocks too right after it and is shown first (own_spacing before peer_cap).
  {
    const c = new VirtualClock();
    const g = new Governor(c, P12);
    g.onFetch(oid(1), 0, true, true);
    c.advance(10_000);                    // the window has opened
    for (let i = 0; i < 12; i++) {
      attempt(g);
      c.advance(1);
    }
    assert.deepEqual(g.waitDetail(1), { ms: 59_988, term: 'own_spacing' }, 'own spacing (4,999 ms) and peer cap (59,988 ms) both block');
    c.advance(6_000 - 12);
    assert.deepEqual(g.waitDetail(1), { ms: 54_000, term: 'peer_cap' });
  }
  // Every other adjacent pair of the display order, both terms blocking, the earlier one shown:
  // window before own_spacing: an own attempt, then a teammate's landing moves the window anchor.
  {
    const c = new VirtualClock();
    const g = new Governor(c, P12);
    g.onFetch(oid(1), 0, true, true);
    c.advance(6_000);
    attempt(g);                           // the own spacing runs 5 s from here
    c.advance(1_000);
    g.onFetch(oid(2), 1, false, true);    // the anchor moves to now: the window (5 s) and the own spacing (4 s left) both block
    assert.deepEqual(g.waitDetail(1), { ms: 5_000, term: 'window' });
  }
  // peer_cap before team_guard: B_eff observed landings and B_eff own attempts in the same 60 s.
  {
    const c = new VirtualClock();
    const g = new Governor(c, P12);
    g.onFetch(oid(1), 0, true, true);
    c.advance(1_000);
    g.onFetch(oid(2), 12, false, true);   // 12 landings at 1 s (the anchor moves there)
    c.advance(5_000);                     // the window has opened
    for (let i = 0; i < 12; i++) {
      attempt(g);
      c.advance(1);
    }
    c.advance(6_000 - 12);                // the own spacing is over; peer cap 54 s, team guard 49 s
    assert.deepEqual(g.waitDetail(1), { ms: 54_000, term: 'peer_cap' });
  }
  // team_guard before in_flight: an attempt in flight while B_eff observed landings are in the window.
  {
    const c = new VirtualClock();
    const g = new Governor(c, P12);
    g.onFetch(oid(1), 0, true, true);
    c.advance(1_000);
    g.onFetch(oid(2), 12, false, true);
    c.advance(6_000);
    g.onAttemptStart();
    c.advance(5_000);                     // its own spacing is over; the team guard has 49 s left
    assert.deepEqual(g.waitDetail(1), { ms: 49_000, term: 'team_guard' });
  }
  // in_flight before backoff: an exempt attempt (R-21) started while the ENG-44 backoff runs.
  {
    const c = new VirtualClock();
    const g = new Governor(c, P12);
    g.onFetch(oid(1), 0, true, true);
    attempt(g, { transient: true });      // k = 1 → G_eff 10 s; backoff 30 s from now
    c.advance(12_000);
    g.onAttemptStart();
    c.advance(10_000);                    // its own spacing (10 s) is over; the backoff has 8 s left
    assert.deepEqual(g.waitDetail(1), { ms: 8_000, term: 'in_flight' });
  }
  // the window itself: rank 3 waits G_eff + 2·S_eff after the anchor; nothing blocking → {ms: 0, term: 'window'}.
  {
    const c = new VirtualClock();
    const g = new Governor(c, P12);
    g.onFetch(oid(1), 0, true, true);
    c.advance(1_000);
    assert.deepEqual(g.waitDetail(3), { ms: 7_000, term: 'window' });
    assert.deepEqual(g.waitDetail(1), { ms: 4_000, term: 'window' });
    // Without a rank, waitDetail uses the rank of the last mayAttempt/msUntilWindow (3 here), never a fixed 1.
    assert.equal(g.msUntilWindow(3), 7_000);
    assert.deepEqual(g.waitDetail(), { ms: 7_000, term: 'window' });
    c.advance(7_000);
    assert.deepEqual(g.waitDetail(3), { ms: 0, term: 'window' });
    assert.equal(g.mayAttempt(3, true, true), true);
  }
  // no tip observed yet: the window's wait is not known (ms null, never Infinity, which JSON turns into null silently on Plan 5's IPC
  // path), as mayAttempt's "no window before the first observation".
  {
    const g = new Governor(new VirtualClock(), P12);
    const w = g.waitDetail(1);
    assert.deepEqual(w, { ms: null, term: 'window' });
    assert.equal(JSON.stringify(w), '{"ms":null,"term":"window"}');
  }
});

test('waitDetail\'s ms is mayAttempt\'s own wait: it equals msUntilWindow(rank) at every rank whenever work is pending, no attempt is in flight and a tip was observed', () => {
  // A deterministic walk over the governor's inputs (fetches with landings, own attempts — some transient, some slow —, throttle
  // signals, time): after every step the displayed wait and the wait mayAttempt itself uses agree (one source, FEAT-F14-13).
  const c = new VirtualClock();
  const g = new Governor(c, P12);
  let seed = 7;
  const next = (n: number): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed % n;
  };
  let tip = 1;
  g.onFetch(oid(tip), 0, true, true);
  let checked = 0;
  for (let step = 0; step < 400; step++) {
    const op = next(10);
    if (op < 4) c.advance(next(15_000));
    else if (op < 6) g.onFetch(oid(++tip), next(6), false, true);
    else if (op < 9) attempt(g, { transient: next(3) === 0, durationMs: next(4) === 0 ? 11_000 : 1_000 });
    else g.onSignal('http_5xx', true, false);
    for (let rank = 1; rank <= 4; rank++) {
      assert.equal(g.waitDetail(rank).ms, g.msUntilWindow(rank), `step ${step}, rank ${rank}`);
      checked += 1;
    }
  }
  assert.equal(checked, 1_600);
  assert.ok(g.attemptsInWindow() > 0);
});
