// The production RegionDeps binding (R4-36, B3-05, R4-78): the shipped runtime from <distDir>/grammars, the two
// thread workers on dist/worker.js, the budgets on the caller's clock, a fresh RegionHost and the caller's one
// security Log stored unchanged (X-34: Plan 4 opens no writer of it). Test builds bind testRegionDeps
// (test/helpers/regionDeps.ts): src/** may not import src/regions/worker/inline.ts (L-REGION-DEPS).
import { join } from 'node:path';
import type { Clock } from '../ports/clock.js';
import type { Fs } from '../ports/fs.js';
import type { Log } from '../ports/log.js';
import { RegionHost } from '../claims/host.js';
import { clockBudgets } from '../regions/budgets.js';
import { threadWorkers } from '../regions/pool.js';
import { RegionRuntimeMissingError, loadRegionRuntime } from '../regions/runtime.js';
import type { RegionDeps } from './deps.js';

export async function productionRegionDeps(o: { fs: Fs; clock: Clock; distDir: string; securityLog: Log }): Promise<RegionDeps> {
  const runtime = await loadRegionRuntime(o.fs, join(o.distDir, 'grammars'));
  const workers = await threadWorkers(runtime, { threads: 2, workerPath: join(o.distDir, 'worker.js'), clock: o.clock });
  const host = new RegionHost();
  return { runtime, workers, budgets: clockBudgets(o.clock), host, securityLog: o.securityLog };
}
