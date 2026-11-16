// 04 §3.18's budget table and the Deadline / RegionBudgets / BudgetInjector port (R2-C01, R4-13, R4-15, TST-03).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Clock } from '../../src/ports/clock.js';
import { BUDGETS, clockBudgets, testBudgetInjector, type BudgetKind } from '../../src/regions/budgets.js';
import { VirtualClock } from '../sim/vclock.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const KINDS: readonly BudgetKind[] = ['parse', 'map', 'predict_wait', 't0', 'edit_check', 'caller_grep', 'partial_grep', 'gate'];

/** A VirtualClock whose wall clock can be set forward or back without moving its monotonic time. */
class JumpClock implements Clock {
  wallJumpMs = 0;
  constructor(readonly inner: VirtualClock) {}
  monoMs(): number { return this.inner.monoMs(); }
  wallMs(): number { return this.inner.wallMs() + this.wallJumpMs; }
  sleep(ms: number): Promise<void> { return this.inner.sleep(ms); }
}

test('BUDGETS is the 04 §3.18 table', () => {
  assert.deepEqual(BUDGETS, {
    gateMs: 15, parseMs: 400, mapLocalMs: 200, predictWaitMs: 10, t0Ms: 500, t0StopFactor: 4, editCheckMs: 500, editCheckStopFactor: 1,
    callerGrepMs: 150, partialGrepMs: 100, cacheBytes: 314_572_800, liveTreesPerWorker: 8, regionBudgetDedupeMs: 1_800_000, workerGraceMs: 1_000,
  });
  assert.ok(Object.isFrozen(BUDGETS));
});

test("clockBudgets deadlines run on the Clock port's monotonic time", () => {
  const vclock = new VirtualClock({ startMono: 1_000 });
  const clock = new JumpClock(vclock);
  const budgets = clockBudgets(clock);
  const parse = budgets.deadline('parse');
  assert.equal(parse.kind, 'parse');
  assert.equal(parse.budgetMs, 400);
  assert.equal(parse.remainingMs(), 400);
  assert.equal(parse.expired(), false);
  vclock.advance(399);
  assert.equal(parse.remainingMs(), 1);
  assert.equal(parse.expired(), false);
  vclock.advance(1);
  assert.equal(parse.expired(), true);
  assert.equal(parse.remainingMs(), 0);

  assert.equal(budgets.deadline('t0', 4).budgetMs, 2_000);
  assert.equal(budgets.deadline('edit_check', 1).budgetMs, 500);
  assert.equal(budgets.deadline('gate').budgetMs, 15);
  assert.equal(budgets.deadline('caller_grep').budgetMs, 150);
  assert.equal(budgets.deadline('partial_grep').budgetMs, 100);
  assert.equal(budgets.deadline('predict_wait').budgetMs, 10);
  assert.equal(budgets.deadline('map').budgetMs, 200);

  // INV-CLOCK basis: a wall-clock jump of ±1 h changes no remainingMs().
  const open = KINDS.map((k) => budgets.deadline(k));
  vclock.advance(5);
  const before = open.map((d) => d.remainingMs());
  for (const jump of [3_600_000, -3_600_000]) {
    clock.wallJumpMs = jump;
    assert.deepEqual(open.map((d) => d.remainingMs()), before, `wall jump ${jump} ms`);
    assert.deepEqual(open.map((d) => d.expired()), before.map((r) => r === 0));
  }
});

test('under the virtual clock no deadline expires unless injected', () => {
  const vclock = new VirtualClock();
  const inject = testBudgetInjector();
  const budgets = clockBudgets(vclock, inject);
  for (let i = 0; i < 10_000; i++) {
    const d = budgets.deadline(KINDS[i % KINDS.length] as BudgetKind);
    assert.equal(d.expired(), false);
    assert.equal(d.remainingMs(), d.budgetMs);
  }

  inject.expire('parse', 2);
  const p1 = budgets.deadline('parse');
  const m1 = budgets.deadline('map');
  const p2 = budgets.deadline('parse');
  const p3 = budgets.deadline('parse');
  assert.equal(p1.expired(), true);
  assert.equal(p1.remainingMs(), 0);
  assert.equal(p2.expired(), true);
  assert.equal(p3.expired(), false);
  assert.equal(m1.expired(), false);

  inject.stallMs('edit_check', 600);
  const e1 = budgets.deadline('edit_check');
  const e2 = budgets.deadline('edit_check');
  assert.equal(e1.expired(), true, 'a 600 ms stall overruns the 500 ms edit check');
  assert.equal(e1.remainingMs(), 0);
  assert.equal(e2.expired(), false);
  assert.equal(e2.remainingMs(), 500);

  inject.stallMs('map', 150);
  const m2 = budgets.deadline('map');
  assert.equal(m2.remainingMs(), 50);
  assert.equal(m2.expired(), false);
  assert.equal(budgets.deadline('map').remainingMs(), 200);

  // An injector reaches only the budgets built with it.
  inject.expire('gate', 1);
  assert.equal(clockBudgets(vclock).deadline('gate').expired(), false);
  assert.equal(budgets.deadline('gate').expired(), true);
});

function srcFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) srcFiles(full, out);
    else if (e.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('testBudgetInjector is reached only from tests and tools', () => {
  const hits = srcFiles(join(repoRoot, 'src'))
    .map((f) => relative(repoRoot, f).split('\\').join('/'))
    .filter((f) => f !== 'src/regions/budgets.ts' && /\btestBudgetInjector\b/.test(readFileSync(join(repoRoot, f), 'utf8')));
  assert.deepEqual(hits, [], 'only tests and tools reach testBudgetInjector, so Plan 7 L-DIST can strip it');
  assert.match(readFileSync(join(repoRoot, 'src', 'regions', 'budgets.ts'), 'utf8'), /export function testBudgetInjector\(/);
});
