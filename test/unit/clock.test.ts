import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  type Clock,
  realClock,
  anchorNow,
  elapsedMono,
  ownStaleness,
  suspendGapMs,
  SUSPEND_GAP_THRESHOLD_MS,
} from '../../src/ports/clock.js';
import { SIM_WALL_EPOCH_MS, VirtualClock } from '../sim/vclock.js';

// One random clock step for the property tests. `as const` keeps `kind` typed as
// 'advance' | 'suspend' so `clock[s.kind](s.ms)` type-checks.
const step = fc.record({
  kind: fc.constantFrom('advance' as const, 'suspend' as const),
  ms: fc.integer({ min: 0, max: 120_000 }),
});

test('SUSPEND_GAP_THRESHOLD_MS is 5 s (11-testing §3.2)', () => {
  assert.equal(SUSPEND_GAP_THRESHOLD_MS, 5000);
});

test('realClock.monoMs never goes backwards', () => {
  let prev = realClock.monoMs();
  for (let i = 0; i < 10_000; i++) {
    const now = realClock.monoMs();
    assert.ok(now >= prev, `mono went back: ${prev} -> ${now}`);
    prev = now;
  }
});

test('realClock.wallMs is epoch milliseconds', () => {
  const before = Date.now();
  const w = realClock.wallMs();
  const after = Date.now();
  assert.ok(w >= before && w <= after, `${before} <= ${w} <= ${after}`);
});

test('realClock.sleep waits about the requested time and treats negatives as 0', async () => {
  const a = anchorNow(realClock);
  await realClock.sleep(30);
  assert.ok(elapsedMono(realClock, a) >= 25, `slept only ${elapsedMono(realClock, a)} ms`);
  await realClock.sleep(-5);
});

test('anchorNow returns a frozen {mono, wall} pair from the given clock', () => {
  const c = new VirtualClock({ startMono: 1234, wallOffsetMs: 600_000 });
  const a = anchorNow(c);
  assert.equal(a.mono, 1234);
  assert.equal(a.wall, c.wallMs());
  assert.ok(Object.isFrozen(a));
});

test('advance moves both clocks; helpers see no suspend', () => {
  const c = new VirtualClock();
  const a = anchorNow(c);
  c.advance(1000);
  assert.equal(elapsedMono(c, a), 1000);
  assert.equal(ownStaleness(c, a), 1000);
  assert.equal(suspendGapMs(c, a), 0);
});

test('suspend moves wall only: observers keep Δmono, own staleness takes Δwall', () => {
  const c = new VirtualClock();
  const a = anchorNow(c);
  c.advance(1000);
  c.suspend(7000);
  assert.equal(elapsedMono(c, a), 1000);
  assert.equal(ownStaleness(c, a), 8000);
  assert.equal(suspendGapMs(c, a), 7000);
  assert.ok(suspendGapMs(c, a) > SUSPEND_GAP_THRESHOLD_MS);
});

test('a wall clock set backwards never shortens own staleness below Δmono', () => {
  let mono = 0;
  let wall = 1_000_000;
  const c: Clock = { monoMs: () => mono, wallMs: () => wall, sleep: async () => {} };
  const a = anchorNow(c);
  mono += 2000;
  wall -= 60_000;
  assert.equal(elapsedMono(c, a), 2000);
  assert.equal(ownStaleness(c, a), 2000);
  assert.equal(suspendGapMs(c, a), -62_000);
});

test('VirtualClock: startMono, wall offset, sleep advances virtual time', async () => {
  const c0 = new VirtualClock();
  const plus = new VirtualClock({ wallOffsetMs: 600_000 });
  const minus = new VirtualClock({ wallOffsetMs: -600_000, startMono: 50 });
  assert.equal(c0.monoMs(), 0);
  assert.equal(plus.wallMs() - c0.wallMs(), 600_000);
  assert.equal(minus.wallMs() - c0.wallMs(), -600_000);
  assert.equal(minus.monoMs(), 50);
  const a = anchorNow(c0);
  await c0.sleep(250);
  assert.equal(elapsedMono(c0, a), 250);
  assert.equal(suspendGapMs(c0, a), 0);
  await c0.sleep(-10);
  assert.equal(elapsedMono(c0, a), 250);
});

test('SIM_WALL_EPOCH_MS is 2026-01-01T00:00:00Z and wallOffsetMs is an offset from it, never an absolute time', () => {
  assert.equal(SIM_WALL_EPOCH_MS, 1_767_225_600_000);
  assert.equal(new Date(SIM_WALL_EPOCH_MS).toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(new VirtualClock().wallMs(), SIM_WALL_EPOCH_MS);
  assert.equal(new VirtualClock({ wallOffsetMs: 600_000 }).wallMs(), SIM_WALL_EPOCH_MS + 600_000);
  assert.equal(new VirtualClock({ wallOffsetMs: -600_000 }).wallMs(), SIM_WALL_EPOCH_MS - 600_000);
  // The misuse this pins: passing an absolute time as the offset adds the epoch twice.
  const misused = new VirtualClock({ wallOffsetMs: SIM_WALL_EPOCH_MS });
  assert.equal(new Date(misused.wallMs()).toISOString(), '2082-01-01T00:00:00.000Z');
});

test('driftPpm: advance and sleep move wall by ms*(1+driftPpm/1e6); mono and suspend do not drift', async () => {
  const fast = new VirtualClock({ driftPpm: 100 });
  const a = anchorNow(fast);
  fast.advance(1_000_000);
  assert.equal(fast.monoMs(), 1_000_000);
  assert.equal(fast.wallMs() - SIM_WALL_EPOCH_MS, 1_000_100);
  assert.equal(suspendGapMs(fast, a), 100);
  await fast.sleep(1_000_000);
  assert.equal(fast.monoMs(), 2_000_000);
  assert.equal(fast.wallMs() - SIM_WALL_EPOCH_MS, 2_000_200);
  fast.suspend(5000);
  assert.equal(fast.monoMs(), 2_000_000);
  assert.equal(fast.wallMs() - SIM_WALL_EPOCH_MS, 2_005_200);

  // A slow clock with an offset and a start mono: neither the offset nor startMono drifts.
  const slow = new VirtualClock({ driftPpm: -250, wallOffsetMs: -600_000, startMono: 5000 });
  assert.equal(slow.wallMs(), SIM_WALL_EPOCH_MS - 600_000);
  assert.equal(slow.monoMs(), 5000);
  const b = anchorNow(slow);
  slow.advance(2_000_000);
  assert.equal(slow.wallMs() - b.wall, 1_999_500);
  assert.equal(elapsedMono(slow, b), 2_000_000);
  assert.equal(ownStaleness(slow, b), 2_000_000);
  assert.equal(suspendGapMs(slow, b), -500);
});

test('driftPpm accrues on the total advanced time: many small steps drift as far as one big step', () => {
  const small = new VirtualClock({ driftPpm: 100 });
  const big = new VirtualClock({ driftPpm: 100 });
  for (let i = 0; i < 20_000; i++) small.advance(1);
  big.advance(20_000);
  assert.equal(small.monoMs(), 20_000);
  assert.equal(small.wallMs() - SIM_WALL_EPOCH_MS, 20_002);
  assert.equal(small.wallMs(), big.wallMs());
  assert.ok(Number.isInteger(small.wallMs()));
});

test('VirtualClock rejects negative and non-finite steps and out-of-range options', () => {
  const c = new VirtualClock();
  assert.throws(() => c.advance(-1), RangeError);
  assert.throws(() => c.advance(Number.NaN), RangeError);
  assert.throws(() => c.suspend(-1), RangeError);
  assert.throws(() => c.suspend(Number.POSITIVE_INFINITY), RangeError);
  assert.throws(() => new VirtualClock({ wallOffsetMs: Number.NaN }), RangeError);
  assert.throws(() => new VirtualClock({ startMono: -1 }), RangeError);
  assert.throws(() => new VirtualClock({ driftPpm: Number.NaN }), RangeError);
  assert.throws(() => new VirtualClock({ driftPpm: 1_000_000 }), RangeError);
  assert.throws(() => new VirtualClock({ driftPpm: -1_000_000 }), RangeError);
  assert.equal(c.monoMs(), 0);
  assert.equal(c.wallMs(), SIM_WALL_EPOCH_MS);
});

test('wall never moves backwards and stays an integer for integer steps, at any allowed drift', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -999_999, max: 999_999 }),
      fc.integer({ min: -600_000, max: 600_000 }),
      fc.array(step, { maxLength: 50 }),
      (driftPpm, offset, steps) => {
        const c = new VirtualClock({ wallOffsetMs: offset, driftPpm });
        let prevWall = c.wallMs();
        let prevMono = c.monoMs();
        for (const s of steps) {
          c[s.kind](s.ms);
          const wall = c.wallMs();
          assert.ok(Number.isInteger(wall), `wall ${wall} is not an integer`);
          assert.ok(wall >= prevWall, `wall went back: ${prevWall} -> ${wall}`);
          assert.ok(c.monoMs() >= prevMono);
          prevWall = wall;
          prevMono = c.monoMs();
        }
      },
    ),
    { seed: 20261002, numRuns: 300 },
  );
});

test('INV-CLOCK: helper results do not depend on the wall offset (±600 s), at any drift', () => {
  fc.assert(
    fc.property(fc.integer({ min: -600_000, max: 600_000 }), fc.integer({ min: -1000, max: 1000 }), fc.array(step, { maxLength: 30 }), (offset, driftPpm, steps) => {
      const ref = new VirtualClock({ driftPpm });
      const off = new VirtualClock({ wallOffsetMs: offset, driftPpm });
      const aRef = anchorNow(ref);
      const aOff = anchorNow(off);
      for (const s of steps) {
        ref[s.kind](s.ms);
        off[s.kind](s.ms);
        assert.equal(elapsedMono(off, aOff), elapsedMono(ref, aRef));
        assert.equal(ownStaleness(off, aOff), ownStaleness(ref, aRef));
        assert.equal(suspendGapMs(off, aOff), suspendGapMs(ref, aRef));
      }
    }),
    { seed: 20261002, numRuns: 200 },
  );
});
