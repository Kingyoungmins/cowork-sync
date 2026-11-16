// What an engine is built from (01-engine §3.5): the ports, the trace and log, the lease, attribution, the
// repository and branch identity, and the test-build switches (rulings R-11, R-25, R-29, R-35).
import { createHash } from 'node:crypto';
import type { PeerId } from '../board/ids.js';
import type { RepoPaths } from '../git/repo.js';
import type { OidOrAbsent } from '../git/oid.js';
import type { DeferReason } from '../holds/groups.js';
import type { EditCheckPort, PublishGatePort, SymbolPort, T0RegionsPort } from '../holds/ports.js';
import type { Ports } from '../ports/index.js';
import type { LeasePort } from '../ports/lease.js';
import type { Log } from '../ports/log.js';
import type { Trace } from '../ports/trace.js';
import type { RefNamespace } from './refs.js';
import type { HunkAttributionPort } from '../claims/attribution.js';
import type { BreachPort } from '../claims/breach.js';
import type { RegionHost } from '../claims/host.js';
import type { SuspectPort } from '../claims/ports.js';
import type { RegionBudgets } from '../regions/budgets.js';
import type { RegionWorkers } from '../regions/pool.js';
import type { RegionRuntime } from '../regions/runtime.js';

// Ruling R-29 + R3-50; one site each (Plan 3 sites: M19/M25/M28 Task 2, M38/M39 Task 6, M33 Task 8).
export type MutantId = 'M05' | 'M06' | 'M07' | 'M12' | 'M17' | 'M18' | 'M19' | 'M20' | 'M25' | 'M28' | 'M33' | 'M38' | 'M39' | 'M21' | 'M22' | 'M46_1' | 'M46_2' | 'M46_3' | 'M46_4' | 'M44' | 'M40' | 'M41';   // one site each (R-29; Plan 4's flags on the claim host, R4-62); X-114: one union, appended in place — M44 is Task 6's turn-origin site (A6-11), M40/M41 are Task 8's hook-read sites (11 §3.9)

/**
 * Whether a removal or a large shrink of a path is attributed to an actor (glossary §20, ENG-25, HLD-32).
 * Plan 5 binds hook windows for seat deltas; until then a human edit is never attributed by a hook.
 */
export interface AttributionPort {
  removalAttributed(path: string): boolean; shrinkAttributed(path: string): boolean;   // Plan 2 (R-25)
  /** HLD-26 (a): the delta lies in an Edit|Write|MultiEdit|NotebookEdit hook window of a live seat (Plan 5 binds). */
  observedEdit(path: string): boolean;
  /** DAT-39: the delta lies in any seat hook window (Plan 5 binds). */
  hookAttributed(path: string): boolean;
}

/**
 * Ruling R-25: a human shrink publishes once two detection ticks ≥ 1 s apart (Δmono) saw the same shrunken
 * stat, so shrinks count as attributed; deletions keep the 1 s two-read rule, so removals do not. No hook window
 * exists before Plan 5 (R3-08): every delta is a human one, unobserved (HLD-26) and not hook-attributed (DAT-39).
 */
export const humanOnlyAttribution: AttributionPort = Object.freeze({
  removalAttributed: (_path: string): boolean => false,
  shrinkAttributed: (_path: string): boolean => true,
  observedEdit: (_path: string): boolean => false,
  hookAttributed: (_path: string): boolean => false,
});

/** sha256, lowercase hex, over the parts sorted by UTF-16 code units and joined by '\n'; a part holding '\n' throws. */
export function regionSpecId(parts: readonly string[]): string {
  for (const p of parts) {
    if (typeof p !== 'string' || p.includes('\n')) throw new TypeError(`regionSpecId: invalid part ${JSON.stringify(p)}`);
  }
  return createHash('sha256').update(Buffer.from([...parts].sort().join('\n'), 'utf8')).digest('hex');
}

/** The regionSpec of a Plan 2 build (PRO-47, PRO-48): no grammars yet (Plan 4). */
export const PLAN2_REGION_SPEC: string = regionSpecId(['FoldMapper/1', 'extent-convention/1', 'label-convention/1']);

/** One applied write group's path detail (06 §2 A8-5): Plan 2's apply has no writer seam yet, so it always passes detail
 *  without it (or without the whole argument) and Plan 5's X5-06 read takes writer as null. */
export interface AppliedPath { path: string; from: OidOrAbsent; to: OidOrAbsent; writer: PeerId | null; }

/**
 * The engine-facing Claude port (06 §3.7.3, §3.7.5; ENG-23, ENG-31; 01 §3.11 P1). Bound at every EngineDeps
 * construction site as `claude: noClaude` until Plan 5 Task 8 binds DeferSet; Plan 2/3 behaviour keeps R5-55's
 * neutral answers, so no engine iteration reaches a throwing stub.
 */
export interface ClaudeEnginePort {
  txnOpen(): boolean;                                                         // any Bash|PowerShell|Monitor TXN open on this worktree → no detection tick, no materialization, no apply
  deferred(): ReadonlyMap<string, DeferReason>;                               // deferredPaths(worktree): fence | read_lease | txn | conflicted_leased (R5-25)
  recheck(paths: readonly string[]): ReadonlyMap<string, DeferReason>;        // P1 re-check of one write group (a fence or TXN opened after J)
  fenced(): ReadonlySet<string>;                                              // INFLIGHT-fenced paths: never re-read by a tick (TickInput.skip, ENG-23)
  /** After every written group, once, with exactly the written paths (A8-5). */
  applied(paths: readonly string[], detail?: ReadonlyArray<AppliedPath>): void;
}

/** Plan 2/3 behaviour: nothing open, nothing deferred, nothing fenced; applied() ignores its arguments (R5-55). */
export const noClaude: ClaudeEnginePort = Object.freeze({
  txnOpen: (): boolean => false,
  deferred: (): ReadonlyMap<string, DeferReason> => new Map(),
  recheck: (): ReadonlyMap<string, DeferReason> => new Map(),
  fenced: (): ReadonlySet<string> => new Set(),
  applied: (): void => undefined,
});

export interface EngineDeps {
  ports: Ports;                    // git = createGitRunner with hooksPath <coworkDir>/empty-hooks, DAEMON_ENV, sshCommand, testBuild
  trace: Trace; log: Log; lease: LeasePort; attribution: AttributionPort;
  /** Plan 5 Task 1 (X5-01): the daemon's Claude port; default noClaude until Task 8 binds DeferSet. */
  claude: ClaudeEnginePort;
  heartbeatMs: () => number;       // R-35
  paths: RepoPaths;
  branch: string; namespace: RefNamespace;
  url: string;                     // pinned URL, never a remote name
  display: string;                 // validName-checked
  pluginVersion: string; pluginSha: string; regionSpec: string;
  platform: NodeJS.Platform;
  testBuild: boolean; testMutants: ReadonlySet<MutantId>;
  /**
   * Plan 3 Task 10 (R3-03, R3-04, R3-07): the edit check, T0 items 1–2, the B1 gate with the claim PREDICATE and the symbol branch.
   * Production, SIM, tools/real/two-clone.ts and both test fixtures bind plan3Ports() (grammarlessEditCheck, passT0Regions, openGate,
   * noSymbols); Plan 4's plan4Ports(host) replaces it at the same sites (X-111).
   */
  editCheck: EditCheckPort; t0Regions: T0RegionsPort; gate: PublishGatePort; symbols: SymbolPort;
  /**
   * Plan 4 Task 5 (R4-36, B3-05): the region module at every construction site — productionRegionDeps in
   * src/daemon/run.ts and tools/real/two-clone.ts, testRegionDeps in the fixtures and SIM. createEngineCore attaches
   * deps.regions.host to its claim host view (R4-36); a later core over the same deps re-attaches.
   */
  regions: RegionDeps;
}

/**
 * The region module's deps (04 §3.1): the runtime, the worker pool, the budgets, the host the claim ports read and
 * the daemon's one security Log (R4-52, X-34: built by src/daemon/run.ts, a Plan 2 fileLog until Plan 5). The
 * optional ports (R4-05, R4-51) have their defaults in the engine's claim host view: csAttribution, logBreach,
 * noSuspect (Tasks 12 and 15 land them).
 */
export interface RegionDeps {
  readonly runtime: RegionRuntime;
  readonly workers: RegionWorkers;
  readonly budgets: RegionBudgets;
  readonly host: RegionHost;
  readonly securityLog: Log;
  readonly attribution?: HunkAttributionPort;   // default csAttribution (R4-05; Plan 5 binds)
  readonly breach?: BreachPort;                 // default logBreach (R4-51; Plan 6 binds)
  readonly suspect?: SuspectPort;               // default noSuspect (Plan 6 binds)
}
