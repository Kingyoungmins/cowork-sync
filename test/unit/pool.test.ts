// The pool's dispatch rule and the inline binding (REG-31; R4-13, R4-15, OQ-5, R2-C02). Every handler here is a test
// handler (inlineWorkers' handlers option), so Tasks 3–13 filling the production handlers leave these tests green.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { threadId } from 'node:worker_threads';
import { clockBudgets, testBudgetInjector } from '../../src/regions/budgets.js';
import { JobQueue, type RegionJob, type WorkerPriority } from '../../src/regions/pool.js';
import { inlineWorkers } from '../../src/regions/worker/inline.js';
import { initParser } from '../../src/regions/worker/parser.js';
import { testRegionRuntime, testWorkerInit } from '../helpers/regionRuntime.js';
import { VirtualClock } from '../sim/vclock.js';

const HUNKS: RegionJob = { kind: 'hunks', from: [], to: [] };
const MAP: RegionJob = { kind: 'map', from: [], to: [], ranges: [[1, 1]], mode: 'local' };

test('JobQueue orders fg > save > bg, FIFO within a class, fg jobs only on fg', () => {
  const q = new JobQueue();
  const names = new Map<number, string>();
  const pushed: ReadonlyArray<readonly [string, WorkerPriority]> = [['bg1', 'bg'], ['save1', 'save'], ['fg1', 'fg'], ['bg2', 'bg'], ['save2', 'save'], ['fg2', 'fg']];
  for (const [name, priority] of pushed) names.set(q.push(HUNKS, priority), name);
  assert.equal(names.size, 6, 'every push gets its own id');
  assert.equal(q.size, 6);
  const take = (w: 'fg' | 'bg'): string | null => {
    const e = q.next(w);
    if (e === null) return null;
    assert.equal(e.job, HUNKS);
    assert.equal(e.priority, pushed.find(([n]) => n === names.get(e.id))?.[1]);
    return names.get(e.id) ?? '?';
  };
  // An idle fg worker takes save/bg work once the fg jobs are gone.
  assert.deepEqual([take('fg'), take('fg'), take('fg')], ['fg1', 'fg2', 'save1']);
  assert.deepEqual([take('bg'), take('bg'), take('bg'), take('bg')], ['save2', 'bg1', 'bg2', null]);
  assert.equal(q.size, 0);

  // next('bg') never returns an fg job, even when only fg jobs remain.
  const only = new JobQueue();
  only.push(HUNKS, 'fg');
  only.push(HUNKS, 'fg');
  assert.equal(only.next('bg'), null);
  assert.equal(only.size, 2);
  assert.equal(only.next('fg')?.priority, 'fg');
});

test('inlineWorkers runs jobs on the calling thread in submission order', async () => {
  const runtime = await testRegionRuntime();
  let index = 0;
  const threads: number[] = [];
  let mapCalls = 0;
  const pool = await inlineWorkers(runtime, {
    handlers: {
      hunks: async () => {
        threads.push(threadId);
        const i = index++;
        return [{ aLo: i, aHi: 0, bLo: 0, bHi: 0 }];
      },
      map: async () => {
        mapCalls += 1;
        return 'WHOLE_FILE';
      },
    },
  });
  try {
    const settled: number[] = [];
    const results = await Promise.all([0, 1, 2, 3, 4].map((n) => pool.run(HUNKS, n % 2 === 0 ? 'bg' : 'fg', null).then((r) => {
      settled.push(n);
      return r;
    })));
    assert.deepEqual(results, [0, 1, 2, 3, 4].map((i) => ({ kind: 'ok', value: [{ aLo: i, aHi: 0, bLo: 0, bHi: 0 }] })));
    assert.deepEqual(settled, [0, 1, 2, 3, 4], 'resolved in submission order');
    assert.deepEqual(threads, [threadId, threadId, threadId, threadId, threadId], 'on the calling thread');

    // A job whose deadline is already expired at dispatch resolves {kind: 'deadline'} and never reaches its handler.
    const inject = testBudgetInjector();
    const budgets = clockBudgets(new VirtualClock(), inject);
    inject.expire('map', 1);
    assert.deepEqual(await pool.run(MAP, 'fg', budgets.deadline('map')), { kind: 'deadline' });
    assert.equal(mapCalls, 0);
    // Under the virtual clock a live deadline is passed through and never expires on its own.
    assert.deepEqual(await pool.run(MAP, 'fg', budgets.deadline('map')), { kind: 'ok', value: 'WHOLE_FILE' });
    assert.equal(mapCalls, 1);

    // availability() is the in-process parser's.
    const host = await initParser(testWorkerInit(runtime));
    assert.deepEqual(Object.fromEntries(pool.availability()), Object.fromEntries(host.availability()));
    assert.deepEqual(Object.fromEntries(pool.availability()), { python: 'ok', javascript: 'ok', typescript: 'ok', tsx: 'ok', c_sharp: 'ok' });
  } finally {
    await pool.close();
  }

  const throwing = await inlineWorkers(runtime, { handlers: { hunks: async () => { throw new Error('test handler'); } } });
  try {
    assert.deepEqual(await throwing.run(HUNKS, 'fg', null), { kind: 'crashed' });
    // The handler that a throw broke does not stop the queue.
    assert.deepEqual(await throwing.run(HUNKS, 'fg', null), { kind: 'crashed' });
  } finally {
    await throwing.close();
  }
  assert.deepEqual(await throwing.run(HUNKS, 'fg', null), { kind: 'crashed' }, 'a closed pool runs nothing');
});
