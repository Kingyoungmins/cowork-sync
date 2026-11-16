// test/helpers/regionDeps.ts — Task 5: the test RegionDeps binding. Unit tests and SIM bind inlineWorkers over
// testRegionRuntime() (the pinned grammars in node_modules), the caller's clock (a VirtualClock by default, so no budget
// expires unless a test advances it or injects an overrun), a fresh RegionHost and a silent security log. src/** may not
// import src/regions/worker/inline.ts (L-REGION-DEPS): only tests and tools bind it.
// testDaemonRegionDeps is the in-tree daemon's binding (audit #15): src/daemon/run.ts reads the shipped runtime beside its own
// module only (dist/ when shipped), so a test running runDaemon from src/ passes this one instead (runDaemon's 4th argument).
import type { HunkAttributionPort } from '../../src/claims/attribution.js';
import type { BreachPort } from '../../src/claims/breach.js';
import type { DaemonOptions } from '../../src/daemon/run.js';
import type { Clock } from '../../src/ports/clock.js';
import type { Log } from '../../src/ports/log.js';
import type { RegionDeps } from '../../src/engine/deps.js';
import { RegionHost } from '../../src/claims/host.js';
import { clockBudgets, type BudgetInjector } from '../../src/regions/budgets.js';
import { inlineWorkers } from '../../src/regions/worker/inline.js';
import { VirtualClock } from '../sim/vclock.js';
import { testRegionRuntime } from './regionRuntime.js';

/** The test RegionDeps of one construction site: its own inline pool over the pinned grammars (close it in the site's teardown),
 *  budgets from clockBudgets(clock, injector), a fresh host, a silent security log unless one is given, and the optional ports
 *  only when given (Tasks 12 and 15 bind their defaults). */
export async function testRegionDeps(o: { clock?: Clock; injector?: BudgetInjector; attribution?: HunkAttributionPort; breach?: BreachPort; securityLog?: Log } = {}): Promise<RegionDeps> {
  const runtime = await testRegionRuntime();
  const workers = await inlineWorkers(runtime);
  const securityLog: Log = o.securityLog ?? { write: () => undefined };
  return {
    runtime, workers, budgets: clockBudgets(o.clock ?? new VirtualClock(), o.injector), host: new RegionHost(), securityLog,
    ...(o.attribution === undefined ? {} : { attribution: o.attribution }),
    ...(o.breach === undefined ? {} : { breach: o.breach }),
  };
}

/** runDaemon's region binding for in-tree tests: testRegionDeps on the daemon's clock with the daemon's one security Log (X-34). */
export const IN_TREE_DAEMON: DaemonOptions = Object.freeze({
  regionDeps: (o: { clock: Clock; securityLog: Log }): Promise<RegionDeps> => testRegionDeps({ clock: o.clock, securityLog: o.securityLog }),
});
