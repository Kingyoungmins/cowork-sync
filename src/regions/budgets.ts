// Region budgets (04-regions §3.18, §2 chapter-local numbers; REG-31; rulings R4-13, R4-15): every time budget is a
// Deadline on the Clock port's monotonic time, so under SIM's virtual clock with inline jobs nothing expires unless a
// test injects the overrun (TST-03). An overrun always degrades to a larger claim, a touch, WHOLE_FILE or incomplete,
// never to "no conflict" (the callers' rule).
import type { Clock } from '../ports/clock.js';

/** 04 §3.18 and glossary §20 "Region numbers"; ms unless named otherwise. */
export const BUDGETS: Readonly<{
  gateMs: 15; parseMs: 400; mapLocalMs: 200; predictWaitMs: 10; t0Ms: 500; t0StopFactor: 4; editCheckMs: 500; editCheckStopFactor: 1;
  callerGrepMs: 150; partialGrepMs: 100; cacheBytes: 314_572_800; liveTreesPerWorker: 8; regionBudgetDedupeMs: 1_800_000; workerGraceMs: 1_000;
}> = Object.freeze({
  gateMs: 15,
  parseMs: 400,
  mapLocalMs: 200,
  predictWaitMs: 10,
  t0Ms: 500,
  t0StopFactor: 4,
  editCheckMs: 500,
  editCheckStopFactor: 1,
  callerGrepMs: 150,
  partialGrepMs: 100,
  cacheBytes: 314_572_800,
  liveTreesPerWorker: 8,
  regionBudgetDedupeMs: 1_800_000,
  workerGraceMs: 1_000,
} as const);

export type BudgetKind = 'parse' | 'map' | 'predict_wait' | 't0' | 'edit_check' | 'caller_grep' | 'partial_grep' | 'gate';
export interface Deadline { readonly kind: BudgetKind; readonly budgetMs: number; expired(): boolean; remainingMs(): number; }
export interface RegionBudgets { deadline(kind: BudgetKind, factor?: number): Deadline; }   // factor: T0 stops at 4×, the edit check at 1×
/** Test builds only (Plan 7's L-DIST strips it): the next n deadlines of a kind start expired, or a job of that kind stalls ms (T-REG-29's 0.6 s, T-REG-15's 200 ms cap).
 *  expire(kind, n): the next n deadlines of that kind start expired. stallMs(kind, ms): the next deadline of that kind reports ms of extra elapsed time (remainingMs()
 *  lowered by ms; expired once ms ≥ budgetMs × factor); no thread sleeps, so inline and thread runs and SIM stay deterministic. */
export interface BudgetInjector { expire(kind: BudgetKind, times: number): void; stallMs(kind: BudgetKind, ms: number): void; }

/** The base budget of each kind, before the caller's factor. */
const BASE_MS: Readonly<Record<BudgetKind, number>> = Object.freeze({
  parse: BUDGETS.parseMs,
  map: BUDGETS.mapLocalMs,
  predict_wait: BUDGETS.predictWaitMs,
  t0: BUDGETS.t0Ms,
  edit_check: BUDGETS.editCheckMs,
  caller_grep: BUDGETS.callerGrepMs,
  partial_grep: BUDGETS.partialGrepMs,
  gate: BUDGETS.gateMs,
});

/** What one new deadline of a kind takes from an injector: start expired, and/or extra elapsed ms. */
interface Injected { readonly expire: boolean; readonly stallMs: number; }

/** The pending injections of each testBudgetInjector(), reachable only through clockBudgets. */
const INJECTIONS = new WeakMap<BudgetInjector, (kind: BudgetKind) => Injected>();

const NOTHING: Injected = Object.freeze({ expire: false, stallMs: 0 });

/** Deadlines on the Clock port's monotonic time; under SIM's virtual clock with inline jobs nothing expires unless injected (TST-03). */
export function clockBudgets(clock: Clock, inject?: BudgetInjector): RegionBudgets {
  const take = inject === undefined ? undefined : INJECTIONS.get(inject);
  return Object.freeze({
    deadline(kind: BudgetKind, factor = 1): Deadline {
      if (!Number.isFinite(factor) || factor <= 0) throw new RangeError(`deadline(${kind}): factor must be a finite number > 0, got ${factor}`);
      const budgetMs = BASE_MS[kind] * factor;
      const start = clock.monoMs();
      const injected = take === undefined ? NOTHING : take(kind);
      const elapsed = (): number => Math.max(0, clock.monoMs() - start) + injected.stallMs;
      return Object.freeze({
        kind,
        budgetMs,
        expired: (): boolean => injected.expire || elapsed() >= budgetMs,
        remainingMs: (): number => (injected.expire ? 0 : Math.max(0, budgetMs - elapsed())),
      });
    },
  });
}

export function testBudgetInjector(): BudgetInjector {
  const expires = new Map<BudgetKind, number>();
  const stalls = new Map<BudgetKind, number[]>();
  const injector: BudgetInjector = Object.freeze({
    expire(kind: BudgetKind, times: number): void {
      if (!Number.isSafeInteger(times) || times < 0) throw new RangeError(`expire(${kind}): times must be an integer >= 0, got ${times}`);
      expires.set(kind, (expires.get(kind) ?? 0) + times);
    },
    stallMs(kind: BudgetKind, ms: number): void {
      if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`stallMs(${kind}): ms must be a finite number >= 0, got ${ms}`);
      stalls.set(kind, [...(stalls.get(kind) ?? []), ms]);
    },
  });
  INJECTIONS.set(injector, (kind: BudgetKind): Injected => {
    const left = expires.get(kind) ?? 0;
    if (left > 0) expires.set(kind, left - 1);
    const queue = stalls.get(kind) ?? [];
    const stallMs = queue.length > 0 ? (queue.shift() as number) : 0;
    return left > 0 || stallMs > 0 ? { expire: left > 0, stallMs } : NOTHING;
  });
  return injector;
}
