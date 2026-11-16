// The mass-change breaker (Plan 3 Task 8; 05-holds HLD-30, glossary §20 "MASS breaker window"; CS-29): unobserved-delta paths
// first seen inside one 30 s Δmono window above max(10, 2 % of tracked) trip 'window'; an unobserved deletion of a file holding
// another writer's non-trivial line trips 'peer_lines'. On a VirtualClock; peerLinesIn is a test function.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MASS_MIN_FILES, MASS_TRACKED_RATIO, MASS_WINDOW_MS, MassBreaker, type BreakerInput } from '../../src/holds/breaker.js';
import { VirtualClock } from '../sim/vclock.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const edits = (prefix: string, n: number, o: Partial<BreakerInput> = {}): BreakerInput[] =>
  Array.from({ length: n }, (_, i) => ({ path: `${prefix}${i}.py`, deletion: false, observed: false, ...o }));
const never = async (): Promise<boolean> => false;

test("tracked 100: 10 unobserved paths first seen within 30 s do not trip; the 11th trips 'window'", T10, async () => {
  assert.deepEqual([MASS_MIN_FILES, MASS_WINDOW_MS, MASS_TRACKED_RATIO], [10, 30_000, 0.02]);
  const clock = new VirtualClock({ startMono: 1_000 });
  const b = new MassBreaker(clock);
  for (const e of edits('a', 10)) {
    assert.equal(await b.observe([e], 100, never), null);
    clock.advance(2_000);
  }
  assert.equal(await b.observe(edits('z', 1), 100, never), 'window');
});

test('tracked 1,000: the threshold is 20 (2 %), so 20 paths do not trip and 21 do', T10, async () => {
  const clock = new VirtualClock({ startMono: 1_000 });
  const b = new MassBreaker(clock);
  assert.equal(await b.observe(edits('a', 20), 1_000, never), null);
  assert.equal(await b.observe(edits('b', 1), 1_000, never), 'window');
  const c = new MassBreaker(clock);
  assert.equal(await c.observe(edits('a', 21), 1_000, never), 'window', 'in one tick too');
});

test('only paths first seen inside one 30 s Δmono window count: 6 at t = 0 and 5 at t = 35 s do not trip; 6 at t = 0 and 5 at t = 25 s trip', T10, async () => {
  const clock = new VirtualClock({ startMono: 1_000 });
  const b = new MassBreaker(clock);
  assert.equal(await b.observe(edits('a', 6), 100, never), null);
  clock.advance(35_000);
  assert.equal(await b.observe(edits('b', 5), 100, never), null);

  const clock2 = new VirtualClock({ startMono: 1_000 });
  const c = new MassBreaker(clock2);
  assert.equal(await c.observe(edits('a', 6), 100, never), null);
  clock2.advance(25_000);
  assert.equal(await c.observe(edits('b', 5), 100, never), 'window');
});

test('observed paths never count, and a path seen again counts once', T10, async () => {
  const clock = new VirtualClock({ startMono: 1_000 });
  const b = new MassBreaker(clock);
  assert.equal(await b.observe(edits('o', 40, { observed: true }), 100, never), null, 'observed deltas (Claude edits, attributed writes)');
  for (let i = 0; i < 12; i++) {
    assert.equal(await b.observe(edits('same', 10), 100, never), null, `the same 10 paths again (${i})`);
    clock.advance(1_000);
  }
  assert.equal(await b.observe(edits('new', 1), 100, never), 'window', 'one more distinct path');
});

test("an unobserved deletion whose peerLinesIn answers true trips 'peer_lines' with a single path; an observed deletion or peerLinesIn false does not", T10, async () => {
  const clock = new VirtualClock({ startMono: 1_000 });
  const asked: string[] = [];
  const peer = async (p: string): Promise<boolean> => {
    asked.push(p);
    return p === 'f.py';
  };
  const b = new MassBreaker(clock);
  assert.equal(await b.observe([{ path: 'g.py', deletion: true, observed: false }], 100, peer), null, 'no peer line in g.py');
  assert.equal(await b.observe([{ path: 'f.py', deletion: true, observed: true }], 100, peer), null, 'an observed deletion');
  assert.equal(await b.observe([{ path: 'f.py', deletion: false, observed: false }], 100, peer), null, 'not a deletion');
  assert.deepEqual(asked, ['g.py'], 'peerLinesIn is asked only for unobserved deletions');
  const c = new MassBreaker(clock);
  assert.equal(await c.observe([{ path: 'f.py', deletion: true, observed: false }], 100, peer), 'peer_lines');
});

test("'.git/index.lock' and '.git/logs/HEAD' never count: 15 such inputs do not trip", T10, async () => {
  const clock = new VirtualClock({ startMono: 1_000 });
  const b = new MassBreaker(clock);
  const peer = async (): Promise<boolean> => true;
  const inputs: BreakerInput[] = [];
  for (let i = 0; i < 8; i++) inputs.push({ path: '.git/index.lock', deletion: i % 2 === 0, observed: false });
  for (let i = 0; i < 7; i++) inputs.push({ path: '.git/logs/HEAD', deletion: i % 2 === 0, observed: false });
  assert.equal(inputs.length, 15);
  assert.equal(await b.observe(inputs, 100, peer), null);
  assert.equal(await b.observe(edits('a', 10), 100, never), null, 'they did not take a place in the window either');
});

test('reset() forgets every first-seen time', T10, async () => {
  const clock = new VirtualClock({ startMono: 1_000 });
  const b = new MassBreaker(clock);
  assert.equal(await b.observe(edits('a', 10), 100, never), null);
  b.reset();
  assert.equal(await b.observe(edits('b', 10), 100, never), null);
  assert.equal(await b.observe(edits('c', 1), 100, never), 'window', 'the window still counts after a reset');
});
