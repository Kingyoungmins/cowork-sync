import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realClock } from '../../src/ports/clock.js';
import { realScheduler } from '../../src/ports/scheduler.js';
import { seatHarness, type SeatHarness } from '../helpers/seatHarness.js';

// The 44.8 h nudge/transitions hang (2026-11-08..10): d.close stops the ticker loop's re-arm, but the
// timeout the loop's last step scheduled keeps re-arming every 1 s against the harness's frozen GatedClock
// — its remaining never reaches 0 — and that one ref'd Timeout held the whole test file's process open
// after every cell had passed. The harness now collects every timer the daemon's realScheduler arms and
// clears the last one in close/cleanup; these cells pin that contract (Decision 7-19: cleanup releases
// every handle).

test('realScheduler reports every armed timer through onTimer (the harness cleanup contract)', async () => {
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const sched = realScheduler(realClock, (t) => timers.push(t));
  const t0 = realClock.monoMs();
  sched.schedule(() => undefined, t0 + 5_000);   // far past the 5 ms grace: the timer stays pending, always armed
  await new Promise<void>((r) => setTimeout(r, 20));   // let setImmediate arm the real setTimeout
  assert.equal(timers.length, 1, 'the one pending setTimeout the scheduler armed');
  clearTimeout(timers[0]!);
});

test('after cleanup the harness leaves no scheduler timer keeping the process alive', async () => {
  let h: SeatHarness | null = null;
  try {
    h = await seatHarness({ peers: 1 });
    // One sync round: the hello arms the daemon's 1 s ticker loop (its timer is the one that used to leak).
    const seat = h.fakeSeat(0, { socketValue: `${h.endpoint(0)}-timer`, mode: 'direct' });
    await seat.hello();
    await new Promise<void>((r) => setTimeout(r, 50));
  } finally {
    if (h !== null) await h.cleanup();
  }
  const pending = (process as unknown as { getActiveResourcesInfo(): string[] }).getActiveResourcesInfo()
    .filter((r) => r === 'Timeout');
  assert.deepEqual(pending, [], 'after cleanup every daemon-scheduler Timeout is cleared (the 44.8 h hang regression)');
});
