// The engine-side adapter of the claim host view (R4-36) — Task 5. src/claims may not import src/engine (R4-02):
// claimHostOf is the one place EngineCore is read into a ClaimHostView.
import type { PeerId } from '../board/ids.js';
import type { Scope, ScopeClass } from '../data/scope.js';
import type { HunkAttributionPort } from '../claims/attribution.js';
import type { BreachPort } from '../claims/breach.js';
import type { ClaimHostView } from '../claims/host.js';
import type { SuspectPort } from '../claims/ports.js';
import type { Oid } from '../git/oid.js';
import type { TreeMap } from '../git/repo.js';
import type { RegionCode, RegionCodeParams } from '../regions/codes.js';
import type { EngineCore } from './core.js';
import { flowScope } from './core.js';
import { raiseRegionCode } from './regionCodes.js';

/**
 * The claim host view of `core` (R4-36): its repo, region service and claim store, the fold at the leased tip
 * (core.leasedFold, set after every fold of prepareIteration), the newest iteration's scope (UNMANAGED before
 * one) and epoch base, and the test-build mutant flags (M21, M22, M46_n, R4-62). The optional RegionDeps ports
 * fall back to their Plan-2-shaped defaults (Task 12 binds csAttribution, Task 15 logBreach).
 */
export function claimHostOf(core: EngineCore): ClaimHostView {
  const deps = core.deps;
  return {
    repo: core.repo,
    regions: core.regions,
    store: core.claims,
    self: core.peerId,
    epoch: core.revertEpoch() ?? '',
    regionSpec: deps.regionSpec,
    fold: () =>
      core.leasedFold === null
        ? null
        : { tip: core.leasedFold.tip, state: core.leasedFold.state, order: new Map() },   // Folder.claimOrder (Task 8) fills it
    view: () => null,   // claimViewStep (Task 13) fills it
    scope: (p) => scopeOf(core, p),
    epochBase: () => epochBaseOf(core),
    tipMap: () => tipMapOf(core),
    localSeats: (): ReadonlySet<string> => new Set(),   // the fold's live seats of this peer (Tasks 9 and 11 read it)
    peerDisplay: (peer: PeerId): string => core.displayName(peer) ?? peer,
    attribution: deps.regions.attribution ?? ({ seatsOf: () => [] } as HunkAttributionPort),
    suspect: deps.regions.suspect ?? ({ isSuspect: () => false } as SuspectPort),
    breach: deps.regions.breach ?? ({ onBreach: () => undefined } as BreachPort),   // logBreach (Task 15) replaces it
    flags: {
      perPcForeignness: deps.testMutants.has('M21'),
      matchByLabel: deps.testMutants.has('M22'),
      skipChecks: skipChecksOf(deps.testMutants),
    },
    raise: <C extends RegionCode>(code: C, params: RegionCodeParams[C]): void => raiseRegionCode(core, code, params),
    trace: deps.trace,
    log: deps.log,
  };
}

function skipChecksOf(mutants: ReadonlySet<string>): ReadonlySet<1 | 2 | 3 | 4> {
  const out = new Set<1 | 2 | 3 | 4>();
  for (const n of [1, 2, 3, 4] as const) if (mutants.has(`M46_${n}`)) out.add(n);
  return out;
}

/** The newest prepared iteration's scope class of `p`; UNMANAGED when no iteration can class it. */
function scopeOf(core: EngineCore, p: string): ScopeClass {
  const s: Scope | null = flowScope(core)(p);
  return s === null ? 'UNMANAGED' : s.cls;
}

function epochBaseOf(core: EngineCore): Oid {
  const e = core.view?.meta.EPOCH_BASE;
  if (e === undefined) throw new Error('claimHostOf: epochBase before a state exists');
  return e;
}

function tipMapOf(core: EngineCore): TreeMap {
  const now = core.revertTreesNow();
  if (now === null) throw new Error('claimHostOf: tipMap before a fold');
  return now.TIP;
}
