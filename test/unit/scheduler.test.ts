import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realClock } from '../../src/ports/clock.js';
import { realScheduler } from '../../src/ports/scheduler.js';

test('runs tasks in atMono order and never before atMono', async () => {
  const sched = realScheduler(realClock);
  const t0 = realClock.monoMs();
  const seen: Array<{ name: string; at: number; ran: number }> = [];
  await new Promise<void>((done) => {
    const rec = (name: string, at: number) => (): void => {
      seen.push({ name, at, ran: realClock.monoMs() });
      if (seen.length === 3) done();
    };
    sched.schedule(rec('late', t0 + 100), t0 + 100);
    sched.schedule(rec('early', t0 + 20), t0 + 20);
    sched.schedule(rec('mid', t0 + 60), t0 + 60);
  });
  assert.deepEqual(
    seen.map((s) => s.name),
    ['early', 'mid', 'late'],
  );
  for (const s of seen) assert.ok(s.ran >= s.at, `${s.name} ran at ${s.ran} before ${s.at}`);
});

test('a task due in the past runs asynchronously, never inside schedule()', async () => {
  const sched = realScheduler(realClock);
  let ran = false;
  sched.schedule(() => {
    ran = true;
  }, realClock.monoMs() - 1000);
  assert.equal(ran, false);
  await new Promise<void>((r) => setTimeout(r, 20));
  assert.equal(ran, true);
});

test('async tasks are started at their time', async () => {
  const sched = realScheduler(realClock);
  const t0 = realClock.monoMs();
  const done = await new Promise<number>((resolve) => {
    sched.schedule(async () => {
      await Promise.resolve();
      resolve(realClock.monoMs());
    }, t0 + 15);
  });
  assert.ok(done >= t0 + 15);
});

test('yieldPoint lets already-queued event-loop work run first', async () => {
  const sched = realScheduler(realClock);
  const order: string[] = [];
  setImmediate(() => order.push('immediate'));
  await sched.yieldPoint('apply.between_paths');
  order.push('after-yield');
  assert.deepEqual(order, ['immediate', 'after-yield']);
});
