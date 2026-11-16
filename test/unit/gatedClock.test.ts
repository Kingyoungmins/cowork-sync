// Ruling P5-T3-1 (Plan 5 Task 3 fix r1): the shared harness-gated clock (test/helpers/gatedClock.ts) — sleep waits for the harness to
// advance, never advances time itself; time otherwise reads as test/sim/vclock.ts's VirtualClock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GatedClock } from '../helpers/gatedClock.js';
import { SIM_WALL_EPOCH_MS, VirtualClock } from '../sim/vclock.js';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
};

test('GatedClock: a sleep resolves only when advance() reaches its deadline, and never moves time', async () => {
  const clock = new GatedClock({ startMono: 100 });
  assert.ok(clock instanceof VirtualClock);
  const done: string[] = [];
  void clock.sleep(3_000).then(() => done.push('3000'));
  void clock.sleep(1_000).then(() => done.push('1000'));
  void clock.sleep(1_000).then(() => done.push('1000b'));
  await flush();
  assert.deepEqual([...done], [], 'nothing resolves on its own');
  assert.equal(clock.monoMs(), 100, 'a sleep does not advance time');
  assert.equal(clock.pending(), 3);
  clock.advance(999);
  await flush();
  assert.deepEqual([...done], []);
  clock.advance(1);
  await flush();
  assert.deepEqual([...done], ['1000', '1000b']);
  assert.equal(clock.pending(), 1);
  clock.advance(5_000);   // past the last deadline: released, in deadline order
  await flush();
  assert.deepEqual([...done], ['1000', '1000b', '3000']);
  assert.equal(clock.pending(), 0);
  assert.equal(clock.monoMs(), 6_100);
  assert.equal(clock.wallMs(), SIM_WALL_EPOCH_MS + 6_000);

  // A sleep of 0 or less is already due: it resolves without an advance.
  let zero = false;
  let negative = false;
  void clock.sleep(0).then(() => { zero = true; });
  void clock.sleep(-5).then(() => { negative = true; });
  await flush();
  assert.equal(zero, true);
  assert.equal(negative, true);
  assert.equal(clock.pending(), 0);

  // suspend() moves only wall time, so it releases no sleep (sleeps count monotonic time, as on the stock clock).
  void clock.sleep(10).then(() => done.push('10'));
  clock.suspend(60_000);
  await flush();
  assert.equal(clock.pending(), 1);
  clock.advance(10);
  await flush();
  assert.equal(done.at(-1), '10');
});
