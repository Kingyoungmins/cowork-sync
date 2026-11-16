// A RegionService for unit tests (Plan 4 Task 7): inlineWorkers over the pinned grammars, a SnapshotStore for every blob
// (DiskSnapshotIds only, so no git object is read or written), plain attributes for every path and a VirtualClock, so no
// budget expires unless a test injects it. The repo is never called: a stored oid read through it throws.
import type { AttrSnapshot, PathAttrs } from '../../src/data/attrs.js';
import { parseOid, type Oid } from '../../src/git/oid.js';
import type { GitRepo } from '../../src/git/repo.js';
import type { Log } from '../../src/ports/log.js';
import { clockBudgets, type BudgetInjector } from '../../src/regions/budgets.js';
import { TableCache } from '../../src/regions/cache.js';
import type { RegionWorkers } from '../../src/regions/pool.js';
import { RegionService } from '../../src/regions/service.js';
import { SnapshotStore } from '../../src/regions/snapshots.js';
import type { DiskSnapshotId, TableOrNone } from '../../src/regions/types.js';
import { inlineWorkers } from '../../src/regions/worker/inline.js';
import { VirtualClock } from '../sim/vclock.js';
import { testRegionRuntime, testSnapshot } from './regionRuntime.js';

/** A fixed EPOCH_BASE for services whose attributes are stubbed (no git reads them). */
export const UNIT_EPOCH_BASE: Oid = parseOid('e'.repeat(40));

export const PLAIN_ATTRS: PathAttrs = Object.freeze({ filter: null, merge: null, text: null, binary: false, eol: null, generated: false, coworkOff: false, workingTreeEncoding: null });

export interface UnitService {
  readonly s: RegionService;
  readonly snapshots: SnapshotStore;
  readonly clock: VirtualClock;
  /** Registers bytes under path (a DiskSnapshotId; no object is written). */
  snap(path: string, bytes: Buffer): DiskSnapshotId;
  /** RegionService.table of bytes registered under path. */
  table(path: string, bytes: Buffer): Promise<TableOrNone>;
  close(): Promise<void>;
}

/** The repo stand-in: any git call is a test failure. */
const NO_REPO = new Proxy({}, { get: (_t, prop) => { throw new Error(`unit RegionService touched repo.${String(prop)}`); } }) as GitRepo;

export async function unitService(o: { inject?: BudgetInjector; workers?: RegionWorkers; repo?: GitRepo } = {}): Promise<UnitService> {
  const runtime = await testRegionRuntime();
  const workers = o.workers ?? await inlineWorkers(runtime);
  const snapshots = new SnapshotStore();
  const clock = new VirtualClock();
  const log: Log = { write: () => undefined };
  const attrs = async (epochBase: Oid): Promise<AttrSnapshot> => ({ epochBase, get: () => PLAIN_ATTRS });
  const s = new RegionService({
    repo: o.repo ?? NO_REPO, workers, budgets: clockBudgets(clock, o.inject), cache: new TableCache(), snapshots, regionSpec: runtime.regionSpec, log, clock,
    attrs, privateIndex: 'unused-private-index', onBudget: () => undefined,
  });
  const snap = (path: string, bytes: Buffer): DiskSnapshotId => testSnapshot(snapshots, path, bytes);
  return {
    s, snapshots, clock, snap,
    table: (path, bytes) => s.table(snap(path, bytes), path, { epochBase: UNIT_EPOCH_BASE }),
    close: async () => {
      if (o.workers === undefined) await workers.close();
    },
  };
}
