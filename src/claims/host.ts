// What the port bindings and steps read from the engine core (adapter: src/engine/claimHost.ts) (R4-36) — Task 5.
// src/claims imports src/engine never (R4-02): the core's names reach it only through this view.
import type { PeerId } from '../board/ids.js';
import type { FoldState } from '../board/fold.js';
import type { ScopeClass } from '../data/scope.js';
import type { Oid } from '../git/oid.js';
import type { GitRepo, TreeMap } from '../git/repo.js';
import type { Log } from '../ports/log.js';
import type { Trace } from '../ports/trace.js';
import type { RegionCode, RegionCodeParams } from '../regions/codes.js';
import type { RegionService } from '../regions/service.js';
import type { HunkAttributionPort } from './attribution.js';
import type { BreachPort } from './breach.js';
import type { SuspectPort } from './ports.js';
import type { ClaimStore } from './store.js';
import type { ClaimView } from './types.js';

/**
 * The claim-side view of one engine core (R4-36): everything the bindings (regionGate, regionT0, regionSymbols,
 * regionEditCheck, predictRevert, placementCheck, breach, tieBreak) and the steps read. `regionSpec` is
 * EngineDeps.regionSpec, which stays PLAN2_REGION_SPEC until Task 16 makes it the runtime's (R4-55).
 */
export interface ClaimHostView {
  readonly repo: GitRepo; readonly regions: RegionService; readonly store: ClaimStore; readonly self: PeerId; readonly epoch: string; readonly regionSpec: string;
  /** The fold at the last leased tip; null before the first prepareIteration (the core's leasedFold). */
  fold(): { readonly tip: Oid; readonly state: FoldState; readonly order: ReadonlyMap<string, { height: number; line: number }> } | null;
  /** claimView(fold(), store) — null until Task 11 binds it. */
  view(): ClaimView | null;
  scope(path: string): ScopeClass; epochBase(): Oid; tipMap(): TreeMap; localSeats(): ReadonlySet<string>;
  peerDisplay(peer: PeerId): string;
  readonly attribution: HunkAttributionPort; readonly suspect: SuspectPort; readonly breach: BreachPort;
  readonly flags: { readonly perPcForeignness: boolean; readonly matchByLabel: boolean; readonly skipChecks: ReadonlySet<1 | 2 | 3 | 4> };   // M21, M22, M46_n (test builds)
  raise<C extends RegionCode>(code: C, params: RegionCodeParams[C]): void;
  readonly trace: Trace; readonly log: Log;
}

/**
 * R4-36: outlives any single core. Every createEngineCore over the same deps calls attach with its own view,
 * replacing the previous one (Plan 2's restartCore, a realEngine RESTART, Task 16's upgrades): the last core
 * created wins and get() returns its view; the old core's view is no longer reachable. get() before the first
 * attach throws.
 */
export class RegionHost {
  private v: ClaimHostView | null = null;

  attach(v: ClaimHostView): void {
    this.v = v;
  }

  get(): ClaimHostView {
    if (this.v === null) throw new Error('RegionHost: not attached');
    return this.v;
  }

  get attached(): boolean {
    return this.v !== null;
  }
}
