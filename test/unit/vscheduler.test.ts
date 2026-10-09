import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seededRandom } from '../../src/ports/random.js';
import { VirtualClock } from '../sim/vclock.js';
import { VirtualScheduler } from '../sim/vscheduler.js';

function make(): { clock: VirtualClock; sched: VirtualScheduler } {
  const clock = new VirtualClock();
  const sched = new VirtualScheduler(clock, seededRandom('vscheduler-test'));
  return { clock, sched };
}

test('runs the earliest task first and breaks ties by insertion order', async () => {
  const { clock, sched } = make();
  const t0 = clock.monoMs();
  const order: string[] = [];
  sched.schedule(() => void order.push('c'), t0 + 30);
  sched.schedule(() => void order.push('a1'), t0 + 10);
  sched.schedule(() => void order.push('x'), t0 + 20);
  sched.schedule(() => void order.push('a2'), t0 + 10);
  sched.schedule(() => void order.push('a3'), t0 + 10);
  assert.equal(sched.pending(), 5);
  while (await sched.step()) {
    /* drain */
  }
  assert.deepEqual(order, ['a1', 'a2', 'a3', 'x', 'c']);
  assert.equal(sched.pending(), 0);
});

test('step() on an empty queue returns false and leaves the clock alone', async () => {
  const { clock, sched } = make();
  const t0 = clock.monoMs();
  assert.equal(await sched.step(), false);
  assert.equal(clock.monoMs(), t0);
});

test('step() advances both clocks forward to atMono before running the task', async () => {
  const { clock, sched } = make();
  const m0 = clock.monoMs();
  const w0 = clock.wallMs();
  let seenMono = -1;
  sched.schedule(() => {
    seenMono = clock.monoMs();
  }, m0 + 500);
  assert.equal(await sched.step(), true);
  assert.equal(seenMono, m0 + 500);
  assert.equal(clock.monoMs(), m0 + 500);
  assert.equal(clock.wallMs(), w0 + 500);
});

test('a task due in the past runs without moving the clock backward', async () => {
  const { clock, sched } = make();
  clock.advance(1000);
  const t1 = clock.monoMs();
  sched.schedule(() => undefined, t1 - 100);
  assert.equal(await sched.step(), true);
  assert.equal(clock.monoMs(), t1);
});

test('step() awaits an async task to completion', async () => {
  const { clock, sched } = make();
  const order: string[] = [];
  sched.schedule(async () => {
    await Promise.resolve();
    await Promise.resolve();
    order.push('task-end');
  }, clock.monoMs());
  await sched.step();
  order.push('after-step');
  assert.deepEqual(order, ['task-end', 'after-step']);
});

test('tasks scheduled from inside a task are queued, not run inline', async () => {
  const { clock, sched } = make();
  const t0 = clock.monoMs();
  const order: string[] = [];
  sched.schedule(() => void order.push('later'), t0 + 100);
  sched.schedule(() => {
    order.push('first');
    sched.schedule(() => void order.push('child'), t0 + 50);
  }, t0 + 10);
  await sched.step();
  assert.deepEqual(order, ['first']);
  assert.equal(sched.pending(), 2);
  await sched.runUntilIdle(10);
  assert.deepEqual(order, ['first', 'child', 'later']);
});

test('a throwing task rejects step(), is removed, and the scheduler stays usable', async () => {
  const { clock, sched } = make();
  const t0 = clock.monoMs();
  const order: string[] = [];
  sched.schedule(() => {
    throw new Error('boom');
  }, t0 + 1);
  sched.schedule(() => void order.push('next'), t0 + 2);
  await assert.rejects(sched.step(), /boom/);
  assert.equal(sched.pending(), 1);
  assert.equal(await sched.step(), true);
  assert.deepEqual(order, ['next']);
});

test('step() called from inside a running task rejects (single-step only)', async () => {
  const { clock, sched } = make();
  let innerError: unknown = null;
  sched.schedule(async () => {
    try {
      await sched.step();
    } catch (e) {
      innerError = e;
    }
  }, clock.monoMs());
  sched.schedule(() => undefined, clock.monoMs() + 1);
  assert.equal(await sched.step(), true);
  assert.ok(innerError instanceof Error);
  assert.match(innerError.message, /re-entered/);
  assert.equal(sched.pending(), 1);
});

test('yieldPoint resolves without a handler and awaits the handler when set', async () => {
  const { sched } = make();
  await sched.yieldPoint('nobody-listening');

  const seen: string[] = [];
  sched.onYield = async (name: string): Promise<void> => {
    await Promise.resolve();
    seen.push(`yield:${name}`);
  };
  await sched.yieldPoint('apply.between_paths');
  seen.push('after');
  assert.deepEqual(seen, ['yield:apply.between_paths', 'after']);

  sched.onYield = null;
  await sched.yieldPoint('again');
  assert.deepEqual(seen, ['yield:apply.between_paths', 'after']);
});

test('a yieldPoint inside a task lets onYield interleave a concurrent operation', async () => {
  const { clock, sched } = make();
  const order: string[] = [];
  sched.onYield = (name: string): void => {
    order.push(`concurrent-at-${name}`);
  };
  sched.schedule(async () => {
    order.push('phase1');
    await sched.yieldPoint('writer.phase1');
    order.push('phase2');
  }, clock.monoMs());
  await sched.step();
  assert.deepEqual(order, ['phase1', 'concurrent-at-writer.phase1', 'phase2']);
});

test('runUntilIdle stops at maxSteps and reports the steps run', async () => {
  const { clock, sched } = make();
  let n = 0;
  const forever = (): void => {
    n++;
    sched.schedule(forever, clock.monoMs() + 1000);
  };
  sched.schedule(forever, clock.monoMs());
  assert.equal(await sched.runUntilIdle(5), 5);
  assert.equal(n, 5);
  assert.equal(sched.pending(), 1);

  const { clock: c2, sched: s2 } = make();
  s2.schedule(() => undefined, c2.monoMs() + 1);
  s2.schedule(() => undefined, c2.monoMs() + 2);
  assert.equal(await s2.runUntilIdle(100), 2);
  assert.equal(s2.pending(), 0);
});

test('schedule refuses a non-finite atMono', () => {
  const { sched } = make();
  assert.throws(() => sched.schedule(() => undefined, Number.NaN), RangeError);
  assert.throws(() => sched.schedule(() => undefined, Number.POSITIVE_INFINITY), RangeError);
  assert.equal(sched.pending(), 0);
});

test('exposes the seeded random it was built with', () => {
  const clock = new VirtualClock();
  const random = seededRandom('exposed');
  const sched = new VirtualScheduler(clock, random);
  assert.equal(sched.random, random);
});
