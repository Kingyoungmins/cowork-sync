// The engine core (01-engine §3.5 steps 1–3): every component of one clone wired together, and the preparation of one
// iteration — fetch, incident check, fold with its VERSION verdict, detection tick, optional materialize — shared by
// Engine.iterate, startDispatch and the tests. Entering an incident (Task 16), the capture, apply (src/engine/apply.ts)
// and publish steps are the callers'.
//
// One GitRepo per clone, reused across iterations (its live_base memo and tree cache live there), and one A map per A
// tree: the snapshot's carry cache is keyed on the identity of the A map, so A is read once per state transition, never
// per tick (ruling P2-ATREE: the map handed to the snapshot is always tree(TickInput.aTree)).
//
// Attributes: WriterDeps.isFiltered/isText and DiskEq's are synchronous, so every iteration takes one attribute
// snapshot at EPOCH_BASE over A ∪ TIP (ensureAttrs adds the dirty and S_disk paths later; the AttrCache answers known
// paths from memory). A path outside it is treated as filtered whenever the clone has a filter driver (route (b) at the
// repository root, never a stage-tree command that could run a filter: fails closed) and as text.
//
// The fold this iteration computed rides in memory (foldPatch) until the next transition carries it (R-14,
// P2-FOLDPERSIST). prepareIteration writes the state ref only to clear a narrowed apply intent this run kept for a
// stranded restore, once its sweep restored it (P2-NARROW); nothing else here writes it.
//
// Not-applicable paths (P2-NA-TRIGGER): a pending collision, unmaterializable or quarantine path is re-checked
// cheaply at every prepareIteration and stays out of the apply trigger while its re-check holds.
import { basename, dirname, join, isAbsolute, relative, resolve, sep } from 'node:path';
import { readBoardCommit, RemoteContentError } from '../board/boardCommit.js';
import type { Json } from '../board/canonicalJson.js';
import { Folder, recentThrottleEvent, type FoldState, type VersionVerdict } from '../board/fold.js';
import { Governor, RESTART_EVENT_HEIGHTS, type GovernorParams } from '../board/governor.js';
import { newPeerId, parseOpId, type PeerId } from '../board/ids.js';
import type { JoinOp, TeamCaps } from '../board/ops.js';
import { Outbox, type PushState } from '../board/outbox.js';
import { PROTO, readProtocol } from '../board/protocol.js';
import { AttrCache, type AttrSnapshot, type PathAttrs } from '../data/attrs.js';
import { hashRouteB, isFilterFailure } from '../data/blobRoutes.js';
import { DEFAULT_TEAM_CONFIG, readTeamConfig, type TeamConfig } from '../data/config.js';
import { discoverFilters, type FilterSet } from '../data/filters.js';
import { collisionKey, portable, scopeOfTracked, type PortRule, type Scope, type ScopeClass, type ScopeInputs } from '../data/scope.js';
import { enc } from '../git/enc.js';
import type { GitIdentity } from '../git/flags.js';
import { ABSENT, isOid, type Oid, type OidOrAbsent } from '../git/oid.js';
import { GitCommandError, GitRepo, type FileMode, type RepoContext, type TreeEntry, type TreeMap } from '../git/repo.js';
import { MassBreaker } from '../holds/breaker.js';
import { ChangeSets, heldPins, shadowCsIds, type PublicationGroup, type ReadyPair } from '../holds/changesets.js';
import { TransientClocks, type HoldCodeRaise } from '../holds/incoming.js';
import { forgetAll } from '../holds/lastCheck.js';
import { ObservedWrites } from '../holds/observed.js';
import { PROV_RETENTION_MS, ProvenanceJournal } from '../holds/provenance.js';
import type { MaskResult } from '../holds/mask.js';
import { RebaseCache } from '../holds/rebase.js';
import { HoldRegistry } from '../holds/registry.js';
import { guardName, isTerminal, type HoldRecord } from '../holds/record.js';
import { endRevertMarks, rederiveRevertMarks, RevertsJournal, type RevertPathInfo, type RevertTrees } from '../holds/revertCs.js';
import { anchorNow, type Anchor, type Clock } from '../ports/clock.js';
import { KilledAt } from '../ports/crashpoint.js';
import { sameStat, type Fs, type FsLstat } from '../ports/fs.js';
import type { Log, LogParam } from '../ports/log.js';
import { validId, validName, validPathSyntax } from '../sec/validators.js';
import { applyAdmission, type ApplyAdmission } from './apply.js';
import { readCsCache } from './csStep.js';
import type { EngineDeps } from './deps.js';
import { DiskEq } from './diskEq.js';
import { RegionService } from '../regions/service.js';
import { TableCache } from '../regions/cache.js';
import { SnapshotStore } from '../regions/snapshots.js';
import { ClaimStore } from '../claims/store.js';
import { claimHostOf } from './claimHost.js';
import { claimRejectionStep } from './claimsStep.js';
import { labelStep } from './labelStep.js';
import { raiseRegionCode } from './regionCodes.js';
import { isRemoteContentError } from './errors.js';
import { Fetcher, type FetchView } from './fetcher.js';
import { incidentCheck, type IncidentVerdict } from './incident.js';
import { MetaTooNewError, type FreezeReason, type Meta } from './meta.js';
import { refNames, type RefNames } from './refs.js';
import { Snapshotter, type Materialized, type TickInput, type TickResult } from './snapshot.js';
import { LostStateError, OP_SNAP_KEEP, opSnapKeep, readCsTable, readOpSnap, StateStore, type StateView, type Transition } from './state.js';
import { StageDir, stageable } from './stagedRead.js';
import { StatCache } from './statCache.js';
import { sameTreeEntry } from './treeDiff.js';
import { LOCAL_INTENT_KEEP, localIntentKeep, Writer } from './writer.js';

export type ScratchName = 'a' | 'p' | 'out' | 'r' | 'cmp' | 'detect' | 'canon' | 'add';

export interface EngineCore {
  readonly deps: EngineDeps; readonly peerId: PeerId;
  readonly repo: GitRepo; readonly refs: RefNames;
  readonly state: StateStore; readonly holds: HoldRegistry; readonly cs: ChangeSets;
  readonly snapshot: Snapshotter; readonly diskEq: DiskEq; readonly writer: Writer;
  readonly fetcher: Fetcher; readonly governor: Governor; readonly folder: Folder;
  readonly attrs: AttrCache; readonly stage: StageDir; readonly statCache: StatCache;
  view: StateView | null;          // last committed state (null before genesis or join)
  outbox: Outbox;
  filters: FilterSet; config: TeamConfig;
  caps: TeamCaps | null;           // folded team caps (push options)
  lastApplyMono: number | null; lastPushMono: number | null;
  pushAttempts: number;            // counted attempts (status, tests, SIM)
  path(rel: string): string;       // absolute path under coworkDir
  scratch(name: ScratchName): string;
  /**
   * view := state.commit(view, t). Plan 3 Task 8 (R3-59): a CAS that moves laC then advances the provenance journal
   * (advanceProvenance) unless the caller passes { provenance: 'caller' } and advances it itself (applyStep, after apply.state).
   */
  commit(t: Transition, o?: { provenance?: 'commit' | 'caller' }): Promise<StateView>;
  identity(): GitIdentity;
  // ---- Plan 3 (each member's task) ----
  readonly rebase: RebaseCache;    // Task 1 (HLD-14): REBASE and its (id, rev, A[p]) cache, mergeable(p) = pathIsText(p) && !pathIsFiltered(p); the registry's cache
  holdCode: { code: string; params: Record<string, Json> } | null;   // Task 1: newest hold code for status (R-27); every later task sets it
  /** Plan 5 Task 8 (A8-9, X5-41): subscribes cb to every hold-code raise — raiseHoldCodes notifies each listener with
   *  the raise (its code and params as given) after the status and log writes; returns the unsubscribe. */
  onHoldCode(cb: (r: HoldCodeRaise) => void): () => void;
  readonly observed: ObservedWrites;   // Task 5 (HLD-26 (b), R3-36): every Plan 3 writeLocal write, recorded after WRITTEN
  readonly transient: TransientClocks;   // Task 6 (HLD-32, HLD-54, R3-30): the 60 s transient and closure clocks, in memory (a new run starts them anew)
  readonly prov: ProvenanceJournal;      // Task 8 (HLD-25): prov/<enc(b)>.jsonl, loaded at genesis/join/restart (R3-59)
  readonly breaker: MassBreaker;         // Task 8 (HLD-30): the 30 s window, in memory
  /**
   * Task 12a (R3-19, glossary §3, ENG-28): S_pub, the MaskResult of the last materialized S_disk (maskStep), null before the first
   * materialization of this run; between materializations it stays (05 §3.4), and recordStep never recomputes it (R3-62).
   */
  sPub: MaskResult | null;
  /** Task 12a (HLD-21): the held ranges of S_pub's step-5 paths (heldRanges), set with sPub by maskStep; Engine.heldRanges reads it. */
  ranges: ReadonlyMap<string, ReadonlyArray<readonly [number, number]>>;
  /**
   * Task 12a (R3-57, R3-20, ENG-28): set by maskStep when assertSPub fails, cleared by the next passing assertSPub (an assertP failure
   * never sets it: it blocks only that publishStep's code part). While set, publishStep sends no code commit but still sends the
   * allowed board-only ops (PublishReport.maskInvalid = true), and allowedPending reports no code pending.
   */
  maskInvalid: boolean;
  // ---- Plan 3 Task 17 (rev 2.5, X-09; contract addition 1): EngineCore is the F10 kernel's RevertHost (src/holds/revertCs.ts) ----
  readonly peer: PeerId;                 // = peerId (the name the RevertHost subset reads)
  readonly clock: Clock;                 // deps.ports.clock
  readonly fs: Fs;                       // deps.ports.fs
  readonly reverts: RevertsJournal;      // cs/<enc(b)>.reverts.jsonl beside the CS cache (contract addition 3)
  /** meta.epoch of the attached state; null before one exists. */
  revertEpoch(): string | null;
  /** A (the state's base tree) and TIP (the live code of the last checked board, else of LA_B) now; TIP's map is kept for revertTreesNow. */
  revertTrees(): Promise<RevertTrees>;
  /** busyPaths' memory view: the current A map and the newest TIP map (an iteration's or revertTrees'), null before both exist. */
  revertTreesNow(): { A: TreeMap; TIP: TreeMap } | null;
  /** The scope class (the newest iteration's scope, else the start-time one; UNMANAGED when neither can class it) and attributes of paths. */
  revertPaths(paths: readonly string[]): Promise<(path: string) => RevertPathInfo>;
  /** The last materialized S_disk of this run, else the state's snap. */
  revertSDisk(): Promise<TreeMap>;
  /** DISK_EQ for the kernel: read = DiskEq.eq (ENG-11); not read = the snapshot's clean stat of exactly that blob and an unchanged lstat. */
  revertDiskEq(path: string, entry: TreeEntry | null, read: boolean): Promise<boolean>;
  /** The display name the newest fold holds for a peer id (null when none). */
  displayName(peer: string): string | null;
  // ---- Plan 4 (Task 5; the host view of src/claims/host.ts reads exactly these) ----
  readonly regions: RegionService;   // Task 5: the region module's service, built from deps.regions
  readonly claims: ClaimStore;       // Task 5: the claim store (drafts, blocks, rejections; R4-24, R4-28)
  /**
   * Task 5: the fold at the leased tip, set after every fold of prepareIteration (the claim host's fold() reads
   * it); null before the first one. Memory only.
   */
  leasedFold: { tip: Oid; state: FoldState } | null;
}

export interface IterationCtx {
  n: number; start: Anchor;
  fetched: FetchView | null;
  T: OidOrAbsent; tip: Oid; tipMap: TreeMap; A: TreeMap;
  fold: FoldState; version: VersionVerdict;
  epochBase: Oid; scopeInputs: ScopeInputs; scope(path: string): Scope;
  tick: TickResult | null; mat: Materialized | null;
  freeze: readonly FreezeReason[]; pushStates: readonly PushState[];   // P2-PUSHSTATES: every active state ([] = ok), passed to Outbox.take/pendingAllowed and Governor.onFetch's pending
  leaseIdleMs: number;
  /**
   * Plan 5 F2 (#108, R-T8B-2): a Bash|PowerShell|Monitor TXN was open when this iteration decided its tick or its materialization
   * (06 §3.7.3): no tick, no materialization, no apply. prepareIteration sets it once more after its detection tick (F2 #104 fix
   * round 2): a TXN that opened while the tick awaited its fs/git calls is named here too, so a reader of it.txnOpen alone sees the
   * TXN the materialization gate saw. Nothing sets it after prepareIteration returns.
   */
  txnOpen: boolean;
  /**
   * Ruling R3-EF4-26: this iteration's apply admission, decided once by prepareIteration with its materialization (applyAdmission);
   * applyStep uses it. Absent only on a context no apply runs on (a fetch-and-fold-only iteration, recover's incident context).
   */
  admission?: ApplyAdmission;
}

/**
 * 'auto' = when a capture is due (captureDue) or an apply would be admitted. fetchFoldOnly (Plan 2 Task 17 fix round 1, an
 * optional addition): ENG-15 (.git/index.lock) and LIF-10 / glossary §8 (FREEZE(EPOCH)) — fetch, incident check and
 * fold only: no ring sweep (it writes the work tree), no detection tick, no change-set observation, no materialization;
 * the iteration context carries tick null. holdPaths (Plan 3 Task 5): a hold-record occasion (PARK, RESTORE, a record from
 * disk bytes; glossary §26.1 W6 (c), 01-engine §3.8 (c)) materializes these paths — only these — when no full
 * materialization runs anyway (never under fetchFoldOnly, which materializes nothing). leaseIdleMs (R3-EF4-26): the caller's own lease
 * read for this iteration (the loop's step 0, which chose `materialize` by it); the iteration's leaseIdleMs is then that read, so its
 * apply admission, its capture gate and its materialization decide on one read — a lease renewed during the fetch never admits an
 * apply the iteration did not materialize for. Without it, prepareIteration reads the lease itself.
 */
export interface PrepareOptions { materialize: boolean | 'auto'; forceFetch: boolean; fetchFoldOnly?: boolean; holdPaths?: ReadonlySet<string>; leaseIdleMs?: number; }
export type Prepared =
  | { ok: true; it: IterationCtx }
  | { ok: false; why: 'incident'; verdict: Extract<IncidentVerdict, { ok: false }>; T: OidOrAbsent }
  | { ok: false; why: 'no_state' | 'snapshot_failed' | 'config_net' };   // config_net: FREEZE(CONFIG url|public), unreachable in Plan 2 (Plan 7)

/** What the core keeps beside the contract's members (one record per core). */
interface Internals {
  /** HEAD when the core was built: the attribute tree and filter base before a state exists. */
  readonly headAtCreate: Oid | null;
  /** merge.<name>.driver names and the user's core.hooksPath as a repository-relative directory, read once. */
  readonly mergeDrivers: ReadonlySet<string>;
  readonly hooksPathDir: string | null;
  /** The A map of the state's base tree: the same object until a transition changes A (P2-ATREE). */
  aTree: Oid | null;
  aMap: TreeMap | null;
  /** Plan 3 Task 17: the newest TIP map (prepareIteration's, or revertTrees'); the F10 kernel's busyPaths reads it (revertTreesNow). */
  tipMap: TreeMap | null;
  /** Attributes at attrBase of every path asked for this iteration (isFiltered, isText, scope). */
  attrBase: Oid | null;
  attrMap: Map<string, PathAttrs>;
  /** The newest fold of this run and the board it is at; persisted by the next transition (foldPatch). */
  fold: { board: Oid; state: FoldState } | null;
  /** The last board tip that passed the incident check in this run (the T of an iteration whose fetch failed). */
  lastCheckedT: Oid | null;
  /** The board tip the governor last observed through observeFetch / observeOwnLanding (its `revealed` origin). */
  observedTip: Oid | null | undefined;
  /** The board whose protocol.json the governor's parameters were last set from. */
  paramsBoard: Oid | null;
  /** live_code(T) and its tree, per board commit (immutable). */
  readonly tipOf: Map<string, { tip: Oid; tree: Oid }>;
  /** P2-NA-TRIGGER: the pending not-applicable paths whose re-check held at the last prepared iteration (out of the apply trigger). */
  naBlocked: ReadonlySet<string>;
  /**
   * Plan 3 Task 6 (R3-33 re-check, kept stat-based): per pending collision path, the lstat and TIP blob of its last DISK_EQ and the
   * verdict; DISK_EQ runs again only when either changed. In memory; emptied by attachState.
   */
  naDiskEq: Map<string, { stat: FsLstat; tip: Oid; equal: boolean }>;
  /**
   * P2-NARROW: this run's apply journaled a narrowed intent for a stranded restore (markApplyIntentKept); the
   * prepareIteration whose sweep empties writer.strandedPaths() clears it. Never set for an intent this run did not
   * journal: a fresh Writer knows no stranded path, and a crash-leftover J is the restart's (Task 15) to roll back.
   */
  keptApplyIntent: boolean;
  /**
   * ENG-52 step 8: a join with nothing opted in (R-22: no local work, or 'none') makes its first publish board-only, so
   * OUT == tree(TIP) holds by construction and is asserted before the push; any landing ends it. In memory only: a
   * restart between the join and its first publish publishes as usual (the join op still rides it).
   */
  boardOnlyFirstPublish: boolean;
  /**
   * EF2 D3 (HLD-36; R-01): the paths a ready pair names whose state:snap entry differs from A's and from the newest pair's R entry,
   * handed over by the restart's re-form (setReformAtFirstTick) and consumed path by path by the ticks that read them (EF2 fix round 1,
   * F2: an excluded, carried or skipped path stays until a tick reads it): a path a tick finds clean (S_disk = snap) holds a local delta
   * no ready pair carries, so the open human CS takes it there. In memory only; attachState empties it.
   */
  reformAtTick: ReadonlySet<string>;
  /** Plan 3 Task 18 (rev 2.5, F14; X-11, UX-33): the flow's kept facts (FlowMemory). */
  flow: FlowMemory;
  /** Plan 5 Task 8 (A8-9, X5-41): the onHoldCode listeners, notified by raiseHoldCodes after its status and log writes. */
  readonly holdCodeSubs: Set<(r: HoldCodeRaise) => void>;
}

/** Plan 3 Task 18 (rev 2.5, F14; 10-product §3.5.1 `{name}`): the writer of an incoming path as an apply's trailer read found it. */
export interface IncomingWriter {
  writer: PeerId;           // the peer of the Cowork-Writer of the newest commit changing the path that an apply's trailer read found
  name: string;             // that peer's display name in the fold of that apply (its peer id when the fold names none)
  blob: OidOrAbsent;        // TIP[p] at that read: an entry describes the current TIP only while TIP[p] is still this blob
}

/**
 * Plan 3 Task 18 (rev 2.5, F14; X-11, UX-33): what F14's query reads beside the components' own memory, each fact kept at the moment the
 * engine already has it — never read on the query path, and never by a new git process, file read or ref read on the iteration path:
 * - start: the daemon start (the first attachCsTable of this core: start, restart or rebuild): its instant, the cs_ids open then and the
 *   meta.pending paths then (a path leaves the set the first time a state shows it no longer pending); `ticks` = the detection ticks
 *   the start ran, set when Engine.start succeeded (noteDaemonStarted);
 * - pendingSeen: per meta.pending path, the Δmono this daemon first saw it there (the state commits and attaches keep it);
 * - push: the kept push intent's Bnew and the Δmono this daemon first saw it journaled;
 * - tipTree, aAtTip: the newest fold's live_code tree, and the A map current when that TIP map was taken (prepareIteration, revertTrees);
 * - loop: the Engine's own facts — its publish pause and its loop period, read at query time from their one source (attachFlowLoop);
 * - incoming: per incoming path, the writer of the newest commit an apply's trailer read of this run found changing it, merged across
 *   applies (keepIncomingWriters, audit #25: a not-applicable path's commit lies below LA_C at every later apply);
 * - aTip: incomingDifference's memo of the A ≠ TIP paths per (A map, TIP map, aAtTip) triple;
 * - reg: the registry's PHANTOM paths and SHADOW-named cs_ids per registry state (its head commit; flowRegistrySets).
 */
interface FlowMemory {
  start: { mono: number; open: ReadonlySet<string>; pending: Set<string>; ticks: number | null } | null;
  pendingSeen: Map<string, number>;
  push: { bnew: Oid; mono: number } | null;
  tipTree: Oid | null;
  aAtTip: TreeMap | null;
  loop: (() => FlowLoopFacts) | null;
  incoming: ReadonlyMap<string, IncomingWriter>;
  aTip: { A: TreeMap; T: TreeMap; A0: TreeMap; paths: readonly string[] } | null;
  reg: { head: Oid | null; phantoms: ReadonlySet<string>; shadowIds: ReadonlySet<string> } | null;
}

/** Plan 3 Task 18 (fix round 1, finding 10): what only the Engine knows — its publish pause (status.ts publishPauseOf) and loop period. */
export interface FlowLoopFacts { paused: boolean; loopPeriodMs: number; }

const internals = new WeakMap<EngineCore, Internals>();

function inner(core: EngineCore): Internals {
  const i = internals.get(core);
  if (i === undefined) throw new Error('engine core: not built by createEngineCore');
  return i;
}

const PEER_FILE = 'peer';
const NO_PATHS: ReadonlySet<string> = Object.freeze(new Set<string>());
const NO_ENTRIES: TreeMap = Object.freeze(new Map<string, TreeEntry>());
const SPECIAL: ReadonlySet<string> = new Set(['120000', '160000']);
/** live_code(T) memo bound. */
const TIP_MEMO = 64;

function codeOf(e: unknown): string | undefined {
  const c = typeof e === 'object' && e !== null ? (e as NodeJS.ErrnoException).code : undefined;
  return typeof c === 'string' ? c : undefined;
}

/** Equal entries (oid and mode); undefined = absent. The one definition is treeDiff's sameTreeEntry. */
export const sameEntry: (a: TreeEntry | undefined, b: TreeEntry | undefined) => boolean = sameTreeEntry;

/**
 * `<coworkDir>/peer` (glossary §6): the peer id of this clone. The state's meta.peer_id wins when a state exists;
 * otherwise the file's id, else a new id from the Random port, written by an exclusive create.
 */
async function resolvePeerId(deps: EngineDeps, view: StateView | null): Promise<PeerId> {
  const fs = deps.ports.fs;
  const file = join(deps.paths.coworkDir, PEER_FILE);
  const read = async (): Promise<PeerId | null> => {
    try {
      const s = (await fs.readFile(file)).toString('utf8').trim();
      return validId('hex128', s) ? s : null;
    } catch (e) {
      if (codeOf(e) === 'ENOENT') return null;
      throw e;
    }
  };
  const onFile = await read();
  const id = view?.meta.peer_id ?? onFile ?? newPeerId(deps.ports.random);
  if (onFile === null) {
    try {
      await fs.writeFileExclusive(file, Buffer.from(`${id}\n`, 'utf8'));
    } catch (e) {
      if (codeOf(e) !== 'EEXIST') throw e;
      // Written meanwhile: the state's id still wins; otherwise the file's.
      if (view === null) return (await read()) ?? id;
    }
  }
  return id;
}

/** Under a filter attribute at EPOCH_BASE; a path outside this iteration's attributes counts as filtered whenever the clone has a driver (fails closed toward route (b)). */
function filteredBy(int: Internals, filters: FilterSet, p: string): boolean {
  const a = int.attrMap.get(p);
  if (a !== undefined) return a.filter !== null;
  return filters.drivers.length > 0 || filters.overCap !== null;
}

/** Text for D1/D8 (DAT-04): not filtered and not binary by EPOCH_BASE attributes (content sniffing is canon's own). */
function textBy(int: Internals, p: string): boolean {
  const a = int.attrMap.get(p);
  return a === undefined || (a.filter === null && !a.binary && a.text !== 'unset' && a.merge !== 'binary');
}

/** The writer's and DISK_EQ's predicates, for callers that need them outside (the apply's conflict function, restart). */
export function pathIsFiltered(core: EngineCore, p: string): boolean {
  return filteredBy(inner(core), core.filters, p);
}
export function pathIsText(core: EngineCore, p: string): boolean {
  return textBy(inner(core), p);
}

/**
 * The user's core.hooksPath as a repository-relative directory when it lies inside the work tree, else null. The one
 * definition: start, restart and the lost-state rebuild scope paths with it too, so their scope equals the loop's.
 * Integration I-3 (r2 rereview F): '.' or the work-tree root itself is '' — the root, where git then runs the repository's own
 * root files as hooks; isQuarantined fails closed on it (the standard hook names at the root), never open (null).
 * Ruling R3-EF4-27: a relative value resolves against the work tree (githooks(5): hooks run at the work-tree root), so a '..' that
 * lands inside it names the directory git runs; inside = the relative path from the work tree is neither absolute nor '..'-led.
 * Pure over the strings it is given: userHooksPathDir passes realpaths, so containment is decided on them.
 */
export function hooksDir(workTree: string, value: string | null): string | null {
  if (value === null) return null;
  const v = value.trim();
  if (v.length === 0) return null;
  const rel = relative(workTree, resolve(workTree, v));
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null;
  return rel.split(sep).filter((c) => c.length > 0).join('/');
}

/** fs.realpath of p's nearest existing ancestor plus p's remaining components (a hooks directory need not exist yet). */
async function realpathNear(fs: Fs, p: string): Promise<string> {
  const rest: string[] = [];
  let cur = p;
  for (;;) {
    try {
      const real = await fs.realpath(cur);
      return rest.length === 0 ? real : join(real, ...rest);
    } catch (e) {
      if (!(e instanceof Error && typeof (e as NodeJS.ErrnoException).code === 'string')) throw e;   // only a filesystem refusal walks up
      const parent = dirname(cur);
      if (parent === cur) return p;
      rest.unshift(basename(cur));
      cur = parent;
    }
  }
}

/**
 * Ruling R3-EF4-27 (delta review I1, glossary §16): the user's core.hooksPath as hooksDir classes it, read as git reads it for its
 * own use — `git config --show-scope --type=path` (git expands `~/`; the last value whose scope is not `command`, never the runner's
 * forced -c, R3-FF2-F2), a relative value resolved against the work tree, and containment decided on realpaths (a junction or
 * symlink into the work tree, a symlinked work tree, an 8.3 alias). A valueless or invalid entry (git's exit 128 under the path
 * type: the user's own git refuses that config too) gives null plus a HOOKS_PATH_INVALID {exit} log line, never a thrown start.
 * Ruling R3-EF4-31 (EF5 merge M-1, fail closed): only exit 128 is excused — any other failure of the read (a spawn failure, the
 * runner's code -1; a signal; another exit) never read the config, so it propagates and the start (or restart) refuses rather than
 * run with the user's hooks directory LIVE.
 * Start (createEngineCore) and restart's scopeInputsFor both read it here.
 */
export async function userHooksPathDir(repo: GitRepo, fs: Fs, workTree: string, log: Log): Promise<string | null> {
  let value: string | null;
  try {
    value = await repo.configGetUser('core.hooksPath', 'path');
  } catch (e) {
    if (!(e instanceof GitCommandError) || e.code !== 128) throw e;
    log.write('warn', 'HOOKS_PATH_INVALID', { exit: String(e.code) });
    return null;
  }
  if (value === null || value.trim().length === 0) return hooksDir(workTree, value);
  const wt = await realpathNear(fs, workTree);
  return hooksDir(wt, await realpathNear(fs, resolve(workTree, value.trim())));
}

/**
 * Builds every component for one clone (no network, no state write): creates <coworkDir>, tmp/ (0o700), tmp/stage, empty-hooks/, probes the writer mode, loads the registry, discovers filters at EPOCH_BASE (or HEAD before a state exists).
 * hooks (Task 17 fix round 1, an optional addition to the contract): onFetched is the Fetcher's completed-fetch hook (the Engine's observer).
 */
export async function createEngineCore(deps: EngineDeps, hooks: { onFetched?: (v: FetchView) => void } = {}): Promise<EngineCore> {
  if (!validName(deps.display)) throw new Error(`createEngineCore: display ${JSON.stringify(deps.display)} is not a valid name`);
  const { ports, paths } = deps;
  const { fs, clock } = ports;
  const tmpDir = join(paths.coworkDir, 'tmp');
  await fs.mkdirp(paths.coworkDir);
  await fs.mkdirp(tmpDir, 0o700);
  await fs.mkdirp(join(tmpDir, 'stage'), 0o700);
  await fs.mkdirp(join(paths.coworkDir, 'empty-hooks'), 0o700);
  const refs = refNames(deps.branch, deps.namespace);

  // The repository context reads the core as it is at call time: EPOCH_BASE once a state exists (HEAD before), the
  // discovered drivers, and the peer's identity (no commit is made before the peer id is known).
  let core: EngineCore | null = null;
  let peerId = '';
  let headAtCreate: Oid | null = null;
  let drivers: readonly string[] = [];
  const ctx = (): RepoContext => ({
    attrTree: core?.view?.meta.EPOCH_BASE ?? headAtCreate,
    filterDrivers: core?.filters.drivers ?? drivers,
    identity: { name: deps.display, email: `${peerId}@cowork.invalid` },
    wallMs: () => clock.wallMs(),
  });
  const repo = new GitRepo(ports.git, paths, ctx);
  const state = new StateStore({ repo, refs, trace: deps.trace, peer: () => peerId });

  let view: StateView | null = null;
  try {
    view = await state.read();
  } catch (e) {
    // A lost or newer state is the start dispatch's to decide (Task 15): the core is built without a view.
    if (!(e instanceof LostStateError) && !(e instanceof MetaTooNewError)) throw e;
  }
  peerId = await resolvePeerId(deps, view);
  headAtCreate = await repo.resolve('HEAD');

  const epochBase = view?.meta.EPOCH_BASE ?? headAtCreate;
  const filters: FilterSet = epochBase === null ? { drivers: [], fingerprint: {}, overCap: null } : await discoverFilters(repo, fs, epochBase);
  drivers = filters.drivers;
  const config: TeamConfig = epochBase === null ? DEFAULT_TEAM_CONFIG : (await readTeamConfig(repo, epochBase)).config;
  const mergeDrivers = new Set<string>();
  for (const { key } of await repo.configGetRegexp('^merge\\..+\\.driver$')) {
    const name = key.slice('merge.'.length, key.length - '.driver'.length);
    if (name.length > 0) mergeDrivers.add(name);
  }
  // R3-FF2-F2: the user's value, never the runner's forced -c core.hooksPath=<empty-hooks> (configGet would answer that);
  // R3-EF4-27: read as a path, resolved against the work tree, contained by realpath, never a thrown start.
  const hooksPathDir = await userHooksPathDir(repo, fs, paths.workTree, deps.log);

  const int: Internals = {
    headAtCreate, mergeDrivers, hooksPathDir, aTree: null, aMap: null, tipMap: null, attrBase: null, attrMap: new Map(),
    fold: view !== null && view.fold !== null && view.meta.fold_board !== null ? { board: view.meta.fold_board, state: view.fold } : null,
    lastCheckedT: null, observedTip: undefined, paramsBoard: null, tipOf: new Map(), naBlocked: NO_PATHS, naDiskEq: new Map(), keptApplyIntent: false,
    boardOnlyFirstPublish: false, reformAtTick: NO_PATHS,
    holdCodeSubs: new Set(),
    flow: { start: null, pendingSeen: new Map(), push: null, tipTree: null, aAtTip: null, loop: null, incoming: new Map(), aTip: null, reg: null },
  };

  const scratch = (name: ScratchName): string => join(tmpDir, `${name}.index`);
  const privateIndex = join(paths.coworkDir, `${refs.e}.index`);
  const stage = new StageDir(fs, join(tmpDir, 'stage'));
  const statCache = new StatCache();
  const attrs = new AttrCache(repo, fs);
  const isFiltered = (p: string): boolean => filteredBy(int, filters, p);
  const isText = (p: string): boolean => textBy(int, p);
  // Built before the snapshot (Plan 3 Task 17): ENG-25's lift reads the revert shrink marks ChangeSets holds.
  const cs = new ChangeSets(peerId, clock, fs);
  const snapshot = new Snapshotter({
    repo, fs, clock, trace: deps.trace, peer: peerId, privateIndex,
    scratch: { detect: scratch('detect'), canon: scratch('canon') },
    stage, statCache, attribution: deps.attribution, filters, platform: deps.platform,
    revertMark: {
      has: (p: string): boolean => cs.revertMarks.pending().some((id) => cs.revertMarks.current(id)?.has(p) === true),
      covers: (p: string, content: OidOrAbsent): boolean => cs.revertMarks.covers(p, content),
    },
    // Plan 3 Task EF (01-engine §6): a write-tree rc 128 over a private-index object a user's gc pruned reseeds from state:snap.
    snapOf: () => core?.view?.snap ?? null,
    onReseed: (snap) => deps.log.write('warn', 'PRIVATE_INDEX_RESEEDED', { snap, cause: 'missing_object' }),
  });
  const diskEq = new DiskEq({
    repo, fs, stage, statCache, cmpIndex: scratch('cmp'), addIndex: scratch('add'), isFiltered, isText,
    mutants: deps.testMutants, filters, isCarried: (p) => snapshot.isCarried(p),
  });
  // Plan 3 Task 1: REBASE never merges a binary or filtered path (R3-18); the registry shares the cache (HLD-07 convergence) and
  // reads the current iteration's scope and A (R3-12).
  const rebase = new RebaseCache(repo, (p) => isText(p) && !isFiltered(p));
  const holds = new HoldRegistry({
    repo, ref: refs.holds, random: ports.random, clock, peer: peerId, trace: deps.trace, log: deps.log,
    scopeOf: () => {
      if (core === null) throw new Error('engine core: the registry asked for a scope before the core was built');
      return registryScope(core, int);
    },
    A: () => int.aMap ?? NO_ENTRIES,
    rebase,
  });
  await holds.load();
  const mode = await Writer.probeMode(fs, tmpDir, paths.workTree);
  const live = (p: string): boolean => {
    try {
      return currentScope(int, p).cls === 'LIVE';
    } catch {
      return false;
    }
  };
  // R3-71: the writer's hold-creating callbacks request the path's attributes first, at the base the current flow scopes at
  // (this iteration's EPOCH_BASE, or the base a restart/rebuild asked at; never re-basing the map; no git call when it was
  // already asked), so the registry classes it instead of failing closed; with no base at all it stays fail-closed.
  const requestAttrs = async (p: string): Promise<void> => {
    const base = int.attrBase ?? core?.view?.meta.EPOCH_BASE ?? null;
    if (core !== null && base !== null) await ensureAttrs(core, base, [p]);
  };
  const writer = new Writer({
    repo, fs, clock, scheduler: ports.scheduler, trace: deps.trace, log: deps.log, peer: peerId,
    workTree: paths.workTree, tmpDir, privateIndex, stage, statCache, diskEq, snapshot, mode, isFiltered, isText,
    random: ports.random,   // P2-ORPHANNAMES: tmp/orphan-<ulid> names from the Random port (deterministic in SIM)
    journal: async (intent) => {
      const c = core as EngineCore;
      if (c.view === null) throw new Error('writer journal: no state');
      const keep = new Map(c.view.keep);
      // P2-INTENTREACH: every blob a local intent names stays reachable by the same state commit.
      if (intent.kind === 'local') keep.set(LOCAL_INTENT_KEEP, await repo.mktree(localIntentKeep(intent)));
      else keep.delete(LOCAL_INTENT_KEEP);
      await c.commit({ intent, keep });
    },
    frozen: () => (core?.view?.meta.freeze_reasons.length ?? 0) > 0,
    // Plan 5 Task 8 (X5-01, T-P5-writer-recheck): every apply group's P1 re-check over the bound Claude port — a
    // fence or TXN opened after the intent was journaled defers the whole group before P1.
    recheck: (paths: readonly string[]) => deps.claude.recheck(paths),
    onPhantom: async (path, target) => {
      // ENG-34: the PHANTOM PIN (guard 'phantom', DECISION), never published; A[p] stays (no verified write).
      const a = int.aMap?.get(path);
      await requestAttrs(path);
      await holds.hold({
        kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths: [path],
        blobs: { h0: { [path]: a?.oid ?? ABSENT }, h1: { [path]: target.oid } },
        guard: 'phantom', origin: 'daemon', cs_ids: [], displaced_by: null, local_only: !live(path),
      });
    },
    onLateWrite: async (path, stageCopy) => {
      // ENG-35 / R-03 (iii): the late bytes by route (b), an OFF_DISK PARKED PATCH with no guard (nothing masked).
      const h1 = await hashRouteB(repo, path, stageCopy, true);
      if (isFilterFailure(h1)) throw new Error(`late write into the .old of ${path}: its clean filter refused the bytes (kept in the ring)`);
      const c = core as EngineCore;
      const sDisk = c.view === null ? undefined : (await repo.readTreeMap(c.view.snap)).get(path);
      await requestAttrs(path);
      await holds.hold({
        kind: 'PATCH', residence: 'OFF_DISK', state: 'PARKED', paths: [path],
        blobs: { h0: { [path]: sDisk?.oid ?? ABSENT }, h1: { [path]: h1 } },
        guard: null, origin: 'daemon', cs_ids: [], displaced_by: null, local_only: !live(path),
      });
    },
  });
  const fetcher = new Fetcher({ repo, url: deps.url, refs, clock, trace: deps.trace, peer: peerId, ...(hooks.onFetched !== undefined ? { onFetched: hooks.onFetched } : {}) });
  const governor = new Governor(clock, readProtocol(null));
  // The board's protocol.json is set at the first fold (prepareIteration); until then the stricter 6/10/3 hold.
  if (view !== null) governor.restore(view.meta.throttle);
  const folder = new Folder(repo, peerId, view === null ? null : { verified: view.meta.fold_verified, checkpointMismatch: view.meta.checkpoint_mismatch });
  if (view !== null) cs.restore(view.ready, view.meta.cs_human_next);
  const outbox = view === null ? new Outbox() : Outbox.fromJson(view.meta.outbox);

  // Plan 3 Task 8 (HLD-25, R3-36, R3-59): the provenance journal (loaded by genesis, join, restart and the lost-state rebuild)
  // and the mass-change breaker (HLD-30), one of each per core.
  const prov = new ProvenanceJournal({ fs, file: join(paths.coworkDir, 'prov', `${refs.e}.jsonl`), repo, clock, peer: peerId, log: deps.log });
  // Plan 4 Task 5 (R4-36): the region module's service over deps.regions' workers and budgets, and the claim store.
  const regionCache = new TableCache();
  const snapshotStore = new SnapshotStore();
  const regions = new RegionService({
    repo, workers: deps.regions.workers, budgets: deps.regions.budgets, cache: regionCache, snapshots: snapshotStore,
    regionSpec: deps.regions.runtime.regionSpec, log: deps.log, clock,
    attrs: (epochBase: Oid, ps: readonly string[]): Promise<AttrSnapshot> => attrs.snapshot(epochBase, ps),
    privateIndex, onBudget: (path, budget): void => raiseRegionCode(built as EngineCore, 'REGION_BUDGET', { path, budget }),
  });
  const claims = new ClaimStore(snapshotStore, regionCache, ports.random);
  const built: EngineCore = {
    deps, peerId, repo, refs, state, holds, cs, snapshot, diskEq, writer, fetcher, governor, folder, attrs, stage, statCache,
    view, outbox, filters, config, caps: view?.fold?.caps ?? null,
    lastApplyMono: null, lastPushMono: null, pushAttempts: 0,
    rebase, holdCode: null, observed: new ObservedWrites(), transient: new TransientClocks(clock),
    // Plan 5 Task 8 (A8-9, X5-41): the hold-code listeners (raiseHoldCodes notifies each after its log write).
    onHoldCode: (cb: (r: HoldCodeRaise) => void): (() => void) => {
      inner(built).holdCodeSubs.add(cb);
      return () => { inner(built).holdCodeSubs.delete(cb); };
    },
    prov, breaker: new MassBreaker(clock),
    sPub: null, ranges: new Map(), maskInvalid: false,
    // Plan 4 Task 5: the region module's service and the claim store; leasedFold set after every fold of prepareIteration.
    regions, claims, leasedFold: null,
    // Plan 3 Task 17 (contract addition 1): the RevertHost members.
    peer: peerId, clock, fs,
    reverts: new RevertsJournal(fs, join(paths.coworkDir, 'cs', `${enc(deps.branch)}.reverts.jsonl`), clock),
    revertEpoch: (): string | null => built.view?.meta.epoch ?? null,
    async revertTrees(): Promise<RevertTrees> {
      const v = built.view;
      if (v === null) throw new Error('engine core: no state');
      const { A } = await currentA(built);
      const { tip, tree } = await liveCodeOf(built, int.lastCheckedT ?? v.laB);
      const TIP = await repo.readTreeMap(tree);
      int.tipMap = TIP;
      int.flow.tipTree = tree;
      int.flow.aAtTip = A;
      return { A, TIP, tip };
    },
    revertTreesNow: (): { A: TreeMap; TIP: TreeMap } | null =>
      (int.aMap !== null && int.aTree === built.view?.base && int.tipMap !== null ? { A: int.aMap, TIP: int.tipMap } : null),
    async revertPaths(ps: readonly string[]): Promise<(path: string) => RevertPathInfo> {
      const v = built.view;
      if (v === null) throw new Error('engine core: no state');
      await ensureAttrs(built, v.meta.EPOCH_BASE, ps);
      return (p: string): RevertPathInfo => {
        let cls: ScopeClass;
        try {
          cls = currentScope(int, p).cls;
        } catch {
          try {
            cls = registryScope(built, int)(p);
          } catch {
            cls = 'UNMANAGED';   // fails closed: a path that cannot be classed is no revert path (NOT_LIVE)
          }
        }
        return { cls, filtered: filteredBy(int, filters, p), text: textBy(int, p) };
      };
    },
    async revertSDisk(): Promise<TreeMap> {
      const last = snapshot.last();
      if (last !== null) return last.sDiskMap;
      return built.view === null ? new Map() : repo.readTreeMap(built.view.snap);
    },
    async revertDiskEq(path: string, entry: TreeEntry | null, read: boolean): Promise<boolean> {
      if (read) return (await diskEq.eq(path, entry ?? ABSENT, snapshot.last()?.sRawMap.get(path) ?? null)).equal;
      let st: FsLstat | null;
      try {
        st = await fs.lstat(join(paths.workTree, ...path.split('/')));
      } catch {
        return false;
      }
      if (entry === null) return st === null;
      const ce = statCache.get(path);
      return st !== null && ce !== undefined && ce.state === 'clean' && ce.stat !== null && ce.id === entry.oid
        && ce.missingSinceMono === undefined && ce.shrink === undefined && sameStat(ce.stat, st);
    },
    displayName(peer: string): string | null {
      const f = int.fold?.state ?? built.view?.fold ?? null;
      return f !== null && Object.hasOwn(f.peers, peer) ? f.peers[peer]!.display : null;
    },
    path: (rel: string): string => join(paths.coworkDir, ...rel.split('/')),
    scratch,
    async commit(t: Transition, o: { provenance?: 'commit' | 'caller' } = {}): Promise<StateView> {
      const prev = built.view;
      if (prev === null) throw new Error('engine core: commit before a state exists');
      built.view = await state.commit(prev, await opSnapPruned(repo, prev, t));
      syncFlowState(int, built.view, clock.monoMs());   // Plan 3 Task 18: meta.pending's and the push intent's first sightings
      // Final review FC-1: a transition that moves LA_B (an own landing's ok update, a restart's resolution, an apply)
      // moves the checked board with it, so the T of an iteration whose fetch fails or is deferred is never behind LA_B
      // (an ancestor of LA_B would read board_not_ff: a false INCIDENT).
      if (t.laB !== undefined) int.lastCheckedT = t.laB;
      // R3-59: a CAS that moved LA_C advances the provenance journal right after it (push ok, the restart decision, a join's
      // first-apply commit), unless the caller does so itself (applyStep, after its apply.state crashpoint).
      if ((o.provenance ?? 'commit') === 'commit' && built.view.laC !== prev.laC) await advanceProvenance(built, prev.laC);
      return built.view;
    },
    identity: (): GitIdentity => ({ name: deps.display, email: `${peerId}@cowork.invalid` }),
  };
  core = built;
  internals.set(built, int);
  // Plan 4 Task 5 (R4-36): every createEngineCore over the same deps re-attaches the host (restartCore, a RESTART,
  // Task 16's upgrades): the last core created wins and every port bound to the host follows it.
  deps.regions.host.attach(claimHostOf(built));
  return built;
}

/**
 * EF2 fix round 1, F3: a transition that moves state:snap without journaling journal/keep/op_snap itself (an apply's ENG-36 update,
 * the restart's completion, a rebuild) keeps only the operator-written entries the new snap still holds — the disk moved away from an
 * operator's write once an update took other bytes for that path into snap, and a later return to the same bytes is a human change.
 * holdOps.parkWritten journals its own entries (its keep names a new op_snap tree) and is left as it is.
 */
async function opSnapPruned(repo: GitRepo, prev: StateView, t: Transition): Promise<Transition> {
  const journaled = prev.keep.get(OP_SNAP_KEEP);
  if (journaled === undefined || t.snap === undefined || t.snap === prev.snap) return t;
  if (t.keep !== undefined && t.keep.get(OP_SNAP_KEEP) !== journaled) return t;
  const ops = await readOpSnap(repo, prev);
  const snap = await repo.readTreeMap(t.snap);
  const still = new Map([...ops].filter(([p, o]) => (snap.get(p)?.oid ?? ABSENT) === o));
  if (still.size === ops.size && ops.size > 0) return t;
  const keep = new Map(t.keep ?? prev.keep);
  if (still.size === 0) keep.delete(OP_SNAP_KEEP);
  else keep.set(...(await opSnapKeep(repo, still)));
  return { ...t, keep };
}

// ---- shared helpers (apply, publish, start) ----------------------------------------------------------------------

/**
 * A state created after the core was built (genesis, join, lost-state rebuild; the test bootstrap): the core adopts it
 * — view, the persisted fold, the ready pairs and cs_human_next, the outbox and the folded caps — and forgets the
 * in-memory A and checked tip of the previous state.
 */
export function attachState(core: EngineCore, view: StateView): void {
  const int = inner(core);
  core.view = view;
  int.fold = view.fold !== null && view.meta.fold_board !== null ? { board: view.meta.fold_board, state: view.fold } : null;
  int.aTree = null;
  int.aMap = null;
  int.tipMap = null;
  int.lastCheckedT = null;
  int.naBlocked = NO_PATHS;
  int.naDiskEq.clear();
  int.keptApplyIntent = false;
  int.boardOnlyFirstPublish = false;
  int.reformAtTick = NO_PATHS;
  int.flow.aTip = null;
  syncFlowState(int, view, core.deps.ports.clock.monoMs());   // Plan 3 Task 18
  core.cs.restore(view.ready, view.meta.cs_human_next);
  // rev 2.5 (glossary §29.8): last_check/last_pass are lost when the daemon (re)attaches its state (start, restart, rebuild).
  forgetAll(core.cs.lastCheck);
  core.outbox = Outbox.fromJson(view.meta.outbox);
  core.caps = view.fold?.caps ?? null;
}

/**
 * R3-69 (Plan 3 Task 12a): the change-set table of an attached state — readCsTable(repo, view) (the journaled table, truth: orders,
 * next_order, passing, publish counts, closed CSs, seats) and readCsCache(core) (open-CS membership, only when it names
 * view.commit) — into ChangeSets.restore(view.ready, view.meta.cs_human_next, journaled, cache). attachState stays synchronous; this
 * is awaited right after every attachState call (genesis, join, restart, the lost-state rebuild — recover's re-anchor goes through
 * it — and the test bootstrap), so a cache lost between a state commit and writeCsCache never makes a non-passing pair ready or
 * restarts next_order below an existing order, and a missing or stale cache turns the unpublished deltas outside a ready pair into
 * one recovered CS (HLD-36).
 * Plan 3 Task 17 (contract addition 4; 05 §8 Q18): it ends with rederiveRevertMarks, so every start, restart, lost-state rebuild,
 * re-anchor and the test bootstrap re-derive the revert shrink marks from reverts.jsonl — no other call site.
 */
export async function attachCsTable(core: EngineCore, view: StateView): Promise<void> {
  const journaled = await readCsTable(core.repo, view);
  const cache = await readCsCache(core);
  core.cs.restore(view.ready, view.meta.cs_human_next, journaled, cache);
  await rederiveRevertMarks(core);
  // Plan 3 Task 18 (rev 2.5, F14; FEAT-F14-04's restart rule, FEAT-F14-14): the first attach of this core is the daemon start — the CSs
  // open now (restored from the journaled table and the cache) and the meta.pending rows now (whose 60 s anchors restart here).
  const flow = inner(core).flow;
  if (flow.start === null) {
    flow.start = {
      mono: core.deps.ports.clock.monoMs(),
      open: new Set(core.cs.table().cs.filter((e) => e.state === 'open').map((e) => e.cs_id)),
      pending: new Set(Object.keys(view.meta.pending)),
      ticks: null,
    };
  }
}

/**
 * Plan 3 Task 18: meta.pending's first sightings follow a state this core committed or attached (`now` for a row first seen; a row gone
 * leaves, also from the daemon-start set, so a path pending again later is no start anchor), and the push intent's (`now` for a Bnew
 * first seen; null without a push intent).
 */
function syncFlowState(int: Internals, view: StateView, now: number): void {
  const f = int.flow;
  const pending = view.meta.pending;
  for (const p of [...f.pendingSeen.keys()]) if (!Object.hasOwn(pending, p)) f.pendingSeen.delete(p);
  for (const p of Object.keys(pending)) if (!f.pendingSeen.has(p)) f.pendingSeen.set(p, now);
  if (f.start !== null) for (const p of [...f.start.pending]) if (!Object.hasOwn(pending, p)) f.start.pending.delete(p);
  const intent = view.intent;
  f.push = intent.kind !== 'push' ? null : f.push !== null && f.push.bnew === intent.bnew ? f.push : { bnew: intent.bnew, mono: now };
}

/** Plan 3 Task 18: the start succeeded (Engine.start): the detection ticks it ran are the ones whose first sightings were at the start. */
export function noteDaemonStarted(core: EngineCore): void {
  const start = inner(core).flow.start;
  if (start !== null && start.ticks === null) start.ticks = core.snapshot.flowView().ticks;
}

/**
 * Plan 3 Task 18 (fix round 1, finding 10): the Engine that drives this core hands the flow its own facts — the publish pause its status
 * shows and the loop period it chose — as a reader the query calls, so each has one source (publishPauseOf over Engine.pauseInputs,
 * which statusInputs reads too; Engine.period).
 */
export function attachFlowLoop(core: EngineCore, facts: () => FlowLoopFacts): void {
  inner(core).flow.loop = facts;
}

/**
 * Plan 3 Task 18 (10-product §3.5.1 `{name}`; audit #25): an apply's trailer read (applyStep's incoming change-sets) gives every path it
 * names the writer of the newest commit changing it (`read`; null when that commit carries no valid Cowork-Writer). The read covers
 * (base, TIP] only, and base is LA_C unless a deferred row reaches back (incomingBase): the commit of a pending not-applicable path
 * (collision, unmaterializable, quarantine — stage I2, still an `in` path), read by an earlier apply, lies below LA_C at every later
 * apply, so the read is merged into the kept writers, never put in their place (mergeIncomingWriters).
 */
export function keepIncomingWriters(core: EngineCore, read: ReadonlyMap<string, IncomingWriter | null>, A: TreeMap, TIP: TreeMap): void {
  const f = inner(core).flow;
  f.incoming = mergeIncomingWriters(f.incoming, read, A, TIP);
}

/**
 * Audit #25: the kept writers after an apply's trailer read — the kept ones, overwritten by the read's (newer: a commit changing p after
 * the kept entry's lies inside the read), a path whose newest read commit carries no valid Cowork-Writer dropped (an older commit's
 * writer never stands in), then every entry dropped whose path has A === TIP in the A this apply started from (no `in` path: an applied
 * path's entry goes at the next apply, which keeps the map to the A ≠ TIP paths and one read) or whose blob is no longer TIP[p] (it
 * describes an older TIP). A pure function of its arguments; the query's own TIP-blob check (buildFlowInputs) stays the last guard.
 */
export function mergeIncomingWriters(
  kept: ReadonlyMap<string, IncomingWriter>, read: ReadonlyMap<string, IncomingWriter | null>, A: TreeMap, TIP: TreeMap,
): Map<string, IncomingWriter> {
  const out = new Map(kept);
  for (const [p, w] of read) {
    if (w === null) out.delete(p);
    else out.set(p, w);
  }
  for (const [p, w] of out) if (sameEntry(A.get(p), TIP.get(p)) || w.blob !== (TIP.get(p)?.oid ?? ABSENT)) out.delete(p);
  return out;
}

/** Plan 3 Task 18 (rev 2.5, F14): the flow's kept facts (FlowMemory) as src/engine/flowInputs.ts reads them; memory only. */
export interface FlowAnchors {
  start: { mono: number; open: ReadonlySet<string>; pending: ReadonlySet<string>; ticks: number | null } | null;
  pendingSeen: ReadonlyMap<string, number>;
  push: { bnew: Oid; mono: number } | null;
  /** The Engine's facts now (attachFlowLoop); null on a core no Engine drives. */
  loop: FlowLoopFacts | null;
  incoming: ReadonlyMap<string, IncomingWriter>;
  /** The newest fold of this run, else the state's. */
  fold: FoldState | null;
  /** The newest TIP map (prepareIteration's, or revertTrees'); null before one. */
  tip: TreeMap | null;
}

export function flowAnchors(core: EngineCore): FlowAnchors {
  const int = inner(core);
  const f = int.flow;
  return {
    start: f.start, pendingSeen: f.pendingSeen, push: f.push, loop: f.loop?.() ?? null, incoming: f.incoming,
    fold: int.fold?.state ?? core.view?.fold ?? null, tip: int.tipMap,
  };
}

/**
 * Plan 3 Task 18 (fix round 1, finding 8): the registry's PHANTOM paths (phantomPaths) and the cs_ids its SHADOWs name (shadowCsIds),
 * derived from one nonTerminal() read per registry state — its head commit, which every registry write moves — and kept until the next
 * write (FlowMemory.reg), so a per-path caller (Plan 7's hasShadow) never re-sorts the registry. Memory only.
 */
export function flowRegistrySets(core: EngineCore): { phantoms: ReadonlySet<string>; shadowIds: ReadonlySet<string> } {
  const f = inner(core).flow;
  const head = core.holds.head();
  if (f.reg === null || f.reg.head !== head) {
    const records = core.holds.nonTerminal();
    f.reg = { head, phantoms: phantomPathsOf(records), shadowIds: shadowCsIds({ nonTerminal: () => records }) };
  }
  return f.reg;
}

/**
 * Plan 3 Task 18 (fix round 1, finding 2; 10-product §3.5.1 O2 and the `in` domain's UNMANAGED rule): the scope class and not-shared
 * reason the engine classed p with — the scope registryScope reads (the newest prepared iteration's D5 scope while the attribute map is
 * still at its base, else the start-time one) — or null when p's attributes were never requested at that base (a path no iteration
 * classed). Memory only: the iteration's attribute map, never a check-attr.
 */
export function flowScope(core: EngineCore): (p: string) => Scope | null {
  const scope = scopeNow(core, inner(core));
  return (p: string): Scope | null => {
    try {
      return scope(p);
    } catch {
      return null;
    }
  };
}

/**
 * Plan 3 Task 18 (10-product §3.5.1 domain `in`: "A[p] ≠ TIP[p] as the last iteration's apply trigger computed them, except UNMANAGED
 * paths"; 01-engine §3.11, §3.16 "Flow requests"): the paths where the in-memory A (the last iteration's, after its apply) and the newest
 * TIP map differ that the apply trigger's own rule (triggerRule, applicableDifference's) keeps — never a carried path (P2-CARRY) or a
 * PHANTOM PIN's path (ENG-34) — and that are not UNMANAGED (flowScope: their A follows TIP at the next apply, DAT-26), sorted; [] when
 * the two trees are one tree or a map is not known yet. Reading (fix round 1): a pending not-applicable path whose re-check still holds
 * (P2-NA-TRIGGER) stays listed — stage I2 is an `in` stage and UX-33 omits no path of the domain; it is also in `notApplicable`. A path
 * whose A changed since that TIP map was taken other than to it — the ok update of an own landing, which moves A and TIP alike (to the
 * published entries) while the TIP map in memory is the one fetched before the push — is no incoming change and is left out until the
 * next iteration's TIP map. Memory only: the raw difference is computed once per (A, TIP, A at TIP) triple (FlowMemory.aTip); the rule
 * and the scope are applied per call over it.
 */
export function incomingDifference(core: EngineCore): readonly string[] {
  const int = inner(core);
  const A = int.aMap;
  const T = int.tipMap;
  const A0 = int.flow.aAtTip;
  if (A === null || T === null || A0 === null || (int.aTree !== null && int.aTree === int.flow.tipTree)) return [];
  let memo = int.flow.aTip;
  if (memo === null || memo.A !== A || memo.T !== T || memo.A0 !== A0) {
    const out = new Set<string>();
    const differs = (p: string): boolean => !sameEntry(A.get(p), T.get(p)) && (A === A0 || sameEntry(A.get(p), A0.get(p)));
    for (const p of T.keys()) if (differs(p)) out.add(p);
    for (const p of A.keys()) if (!T.has(p) && differs(p)) out.add(p);
    memo = { A, T, A0, paths: [...out].sort() };
    int.flow.aTip = memo;
  }
  if (memo.paths.length === 0) return memo.paths;
  const rule = triggerRule(core, flowRegistrySets(core).phantoms);
  const scope = flowScope(core);
  return memo.paths.filter((p) => {
    const out = rule(p);
    return out !== 'carried' && out !== 'phantom' && scope(p)?.cls !== 'UNMANAGED';
  });
}

/** journal/keep/<name> of the pre-freeze snapshot tree (glossary §4, HLD-30, R3-38); detect.ts and resume.ts re-export it. */
export const SNAP_PRE_FREEZE = 'snap_pre_freeze';

/**
 * journal/keep/snap_pre_freeze is kept and MASS is not in freeze_reasons (R3-38's "post-resume batch pending" flag; Task 8's
 * predicate, defined here since Task 12a so allowedPending can read it; detect.ts and resume.ts, the contract's home of the name,
 * re-export it). While it holds iterate() materializes and publishStep sends no code until massResumeStep has run (HLD-31).
 */
export function massResumePending(core: EngineCore): boolean {
  const view = core.view;
  return view !== null && view.keep.has(SNAP_PRE_FREEZE) && !view.meta.freeze_reasons.includes('MASS');
}

/**
 * Plan 3 Task 12a (R3-57, HLD-31): no code is composed or counted pending while S_pub is invalid (EngineCore.maskInvalid) or the
 * post-resume MASS batch waits for massResumeStep (massResumePending); board-only ops are unaffected.
 */
export function codeWithheld(core: EngineCore, it?: IterationCtx): boolean {
  // Task 12b (carry 5): with the iteration, also its own post-resume batch (markBatchFormed): publishStep withholds code in the
  // iteration whose massResumeStep formed it, so the governor's pending input never counts that code either.
  return core.maskInvalid || massResumePending(core) || (it !== undefined && batchFormed.has(it));
}

/** The iterations whose massResumeStep formed the post-resume batch (HLD-31): their publishStep sends no code. */
const batchFormed = new WeakSet<IterationCtx>();

/**
 * HLD-31 "before anything publishes afterwards" (Plan 3 Task 12a): the iteration in which massResumeStep formed the post-resume batch
 * (its revert records and its one human CS, in its own state update) publishes no code either — the batch's change-set is open and
 * the first code publish comes at a later window, after the batch is in the CS table. detectStep marks it; publishStep reads it.
 */
export function markBatchFormed(it: IterationCtx): void {
  batchFormed.add(it);
}

/** Why this window's code part is skipped (PublishReport.codeSkipped), or null: R3-57's maskInvalid, or HLD-31's pending or just-formed batch. */
export function codeWithheldWhy(core: EngineCore, it: IterationCtx): 'mask_invalid' | 'mass_resume' | null {
  if (core.maskInvalid) return 'mask_invalid';
  return massResumePending(core) || batchFormed.has(it) ? 'mass_resume' : null;
}

/**
 * The join op of this peer's current epoch (glossary §7; PRO-20), as a draft: it rides this peer's first board push of an
 * epoch — after genesis and join, and after a lost-state rebuild or a recover re-anchor, which start a new epoch without
 * the join procedure (final review FC-7: a fold accepts an op of an unrecorded epoch only when it is a join, so without
 * it every later op of the peer is ignored by every fold). It must lead the ops of that push (fold.ts genericOk), and it does in
 * every state that allows a board-only push, FREEZE included (ruling R3-EF4-3; outbox.ts FROZEN_TYPES): a peer frozen before its
 * epoch's first board push (a MASS trip, an EPOCH freeze, freeze reasons a rebuild carries over) still sends the join first, so
 * the freeze events and hold mirrors that leave with it fold.
 */
export async function joinDraft(core: EngineCore): Promise<Omit<JoinOp, 'id'>> {
  const { deps, repo } = core;
  return {
    type: 'join', display: deps.display, plugin_version: deps.pluginVersion, plugin_sha: deps.pluginSha, proto: PROTO,
    regionSpec: deps.regionSpec,
    config_fingerprint: { filters: { ...core.filters.fingerprint }, autocrlf: (await repo.configGet('core.autocrlf')) ?? '', eol_attrs: '', git: '' },
    coauthor_optin: false,
  };
}

/** tree(A) of the current state and its map: the same map object until a transition changes A (P2-ATREE). */
export async function currentA(core: EngineCore): Promise<{ aTree: Oid; A: TreeMap }> {
  const int = inner(core);
  const view = core.view;
  if (view === null) throw new Error('engine core: no state');
  if (int.aTree !== view.base || int.aMap === null) {
    int.aMap = await core.repo.readTreeMap(view.base);
    int.aTree = view.base;
  }
  return { aTree: view.base, A: int.aMap };
}

/** ENG-52 step 8 (set by join with nothing opted in; cleared by any landing, applyPushOk): the next publish is board-only, OUT == tree(TIP). */
export function setBoardOnlyFirstPublish(core: EngineCore, on: boolean): void {
  inner(core).boardOnlyFirstPublish = on;
}
export function boardOnlyFirstPublish(core: EngineCore): boolean {
  return inner(core).boardOnlyFirstPublish;
}

/** The apply's ENG-36 update journaled a narrowed intent for a stranded restore (true) or cleared the intent (false) (P2-NARROW). */
export function markApplyIntentKept(core: EngineCore, kept: boolean): void {
  inner(core).keptApplyIntent = kept;
}
/** Whether this run kept a narrowed apply intent (markApplyIntentKept): a re-anchor carries the mark over its attachState. */
export function applyIntentKept(core: EngineCore): boolean {
  return inner(core).keptApplyIntent;
}

/** A transition changed A to `tree` (already committed): the in-memory A cache follows (after crashpoint('apply.state')). */
export function setCurrentA(core: EngineCore, tree: Oid, map: TreeMap): void {
  const int = inner(core);
  int.aTree = tree;
  int.aMap = map;
}

/**
 * The attributes of `paths` at epochBase join this iteration's map (one check-attr for the ones the AttrCache lacks).
 * A path failing validPathSyntax is never asked (git for Windows reads `a:b.txt` as a drive path and check-attr dies):
 * D5 makes it UNMANAGED before any attribute is read, and it is carried (P2-CARRY).
 */
export async function ensureAttrs(core: EngineCore, epochBase: Oid, paths: Iterable<string>): Promise<void> {
  const int = inner(core);
  if (int.attrBase !== epochBase) {
    int.attrMap = new Map();
    int.attrBase = epochBase;
  }
  const missing = [...new Set(paths)].filter((p) => !int.attrMap.has(p) && validPathSyntax(p));
  if (missing.length === 0) return;
  const snap = await core.attrs.snapshot(epochBase, missing);
  for (const p of missing) int.attrMap.set(p, snap.get(p));
}

/**
 * R3-71 (fix round 2): the attributes of every non-terminal hold record's paths at epochBase join the map, so a later rev of a record
 * over a path outside A ∪ TIP ∪ the tick (a new file parked or deleted since) is classed, not failed closed to local_only. Called
 * wherever the map is reset: prepareIteration, restart and the lost-state rebuild (one check-attr, only for paths the AttrCache lacks).
 */
export async function ensureRecordAttrs(core: EngineCore, epochBase: Oid): Promise<void> {
  await ensureAttrs(core, epochBase, core.holds.nonTerminal().flatMap((r) => r.paths));
}

/** An AttrSnapshot over this iteration's attribute map (a path never asked for throws, as AttrSnapshot.get does). */
function attrView(int: Internals, epochBase: Oid): AttrSnapshot {
  return {
    epochBase,
    get(path: string): PathAttrs {
      const a = int.attrBase === epochBase ? int.attrMap.get(path) : undefined;
      if (a === undefined) throw new Error(`attributes of ${JSON.stringify(path)} were not requested this iteration`);
      return a;
    },
  };
}

/** The scope of p from the last prepared iteration (the writer's callbacks have no IterationCtx). */
const lastScopes = new WeakMap<Internals, (p: string) => Scope>();
/** The EPOCH_BASE whose attributes that iteration's scope reads (registryScope uses the scope only while attrBase is still it). */
const lastScopeBase = new WeakMap<Internals, Oid>();
function currentScope(int: Internals, p: string): Scope {
  const f = lastScopes.get(int);
  if (f === undefined) throw new Error('no iteration prepared yet');
  return f(p);
}

/**
 * RegistryDeps.scopeOf (Plan 3 Task 1, R3-12): the scope class of the newest prepared iteration (the writer's callbacks and every
 * hold() inside an iteration), else the start-time scope (restart, lost-state rebuild, recover's re-anchor, genesis and join
 * before their first iteration, or after a caller re-based the attributes): D5 over A's mode, the stat cache's size, the
 * attributes at the epoch base the hold-creating caller requested them at (ensureAttrs: the EPOCH_BASE of the state it builds —
 * restart: the view's, genesis: HEAD, join: Hb, a rebuild: the new live base), the team config, the merge drivers and the hooks
 * directory. Neither ever fails open (R3-71): a path whose attributes were not requested throws, as attrView does, and the
 * registry then makes the record local_only; a hold-creating caller runs ensureAttrs over its paths first (start.ts
 * pinLocalWork, restart's liveScopes and scopeInputsFor, the writer's callbacks below; the apply and publish call sites read
 * it.scope already), and every existing record's paths are requested wherever the map is reset (ensureRecordAttrs).
 */
function registryScope(core: EngineCore, int: Internals): (p: string) => ScopeClass {
  const scope = scopeNow(core, int);
  return (p: string): ScopeClass => scope(p).cls;
}

/**
 * registryScope's scope with its reason (Plan 3 Task 18 fix round 1: the flow's O2 input reads the same one, flowScope): the newest
 * prepared iteration's while the attribute map is still at its base, else the start-time D5 scope described above.
 */
function scopeNow(core: EngineCore, int: Internals): (p: string) => Scope {
  const iteration = lastScopes.get(int);
  if (iteration !== undefined && lastScopeBase.get(int) === int.attrBase) return iteration;
  const epochBase = int.attrBase;
  const attrs: AttrSnapshot = {
    epochBase: (epochBase ?? '') as Oid,
    get: (p: string): PathAttrs => {
      const a = epochBase !== null && int.attrBase === epochBase ? int.attrMap.get(p) : undefined;
      if (a === undefined) throw new Error(`attributes of ${JSON.stringify(p)} were not requested`);
      return a;
    },
  };
  const inp: ScopeInputs = { attrs, config: core.config, mergeDrivers: int.mergeDrivers, localOnlyPaths: NO_PATHS, hooksPathDir: int.hooksPathDir };
  return (p: string): Scope => scopeOfTracked(p, int.aMap?.get(p)?.mode ?? '100644', core.statCache.get(p)?.stat?.size ?? 0, inp);
}

/** Plan 5 Task 5 phase 2 (engineView.ts; additive over core.ts): the D5 scope of a path of A or TIP from the newest
 *  prepared iteration when its attribute base still matches, else the start-time one — the same factory the loop's
 *  checks read (scopeNow), memory only, never a check-attr or a git call. */
export function engineScope(core: EngineCore): (p: string) => Scope {
  return scopeNow(core, inner(core));
}

/**
 * D5 for a path of A or TIP (or the snapshot): the mode is TIP's, else A's, a special mode (120000/160000) on either
 * side winning, so a path that is a symlink or gitlink on one side is UNMANAGED; size = max(the local staged size the
 * stat cache saw, TIP's blob size where it was measured).
 */
function scopeFunction(core: EngineCore, inp: ScopeInputs, A: TreeMap, TIP: TreeMap, tipSizes: ReadonlyMap<string, number>): (p: string) => Scope {
  const memo = new Map<string, Scope>();
  return (p: string): Scope => {
    const hit = memo.get(p);
    if (hit !== undefined) return hit;
    const a = A.get(p);
    const t = TIP.get(p);
    let mode: FileMode = t?.mode ?? a?.mode ?? '100644';
    if (a !== undefined && SPECIAL.has(a.mode) && (t === undefined || !SPECIAL.has(t.mode))) mode = a.mode;
    const size = Math.max(core.statCache.get(p)?.stat?.size ?? 0, tipSizes.get(p) ?? 0);
    const s = scopeOfTracked(p, mode, size, inp);
    memo.set(p, s);
    return s;
  };
}

/** A path the engine may name in a tree it edits and on disk: valid syntax and no U+FFFD (P2-CARRY). */
export function editable(p: string): boolean {
  return validPathSyntax(p) && !p.includes('\u{fffd}');
}

/** P2-NOFOLLOW for the caller (Task 10 ruling): every existing ancestor of p below the work-tree root is a real directory (an lstat failure counts as unsafe). */
export async function ancestorsSafe(core: EngineCore, path: string): Promise<boolean> {
  const fs = core.deps.ports.fs;
  let dir = core.deps.paths.workTree;
  for (const c of path.split('/').slice(0, -1)) {
    dir = join(dir, c);
    let st;
    try {
      st = await fs.lstat(dir);
    } catch {
      return false;
    }
    if (st === null) return true;
    if (st.isSymbolicLink || !st.isDirectory) return false;
  }
  return true;
}

/**
 * Plan 3 Task 6, the R3-33 guard: whether the disk entry lstat finds at p is spelled exactly p — each component listed by that
 * name (or its NFC form, for a volume that stores another normalization) in its parent directory. On a case-folding volume (NTFS,
 * APFS by default) lstat(p) and the staged read also land on a case variant of p, e.g. the old spelling of a teammate's case-only
 * rename that the same apply deletes: DISK_EQ through such an entry never makes p disk_equal (the creation stays a collision for a
 * loop, then is written once the variant is gone). `listings` caches readdir per directory for one caller's pass.
 */
export async function spelledExactly(core: EngineCore, path: string, listings: Map<string, readonly string[] | null> = new Map()): Promise<boolean> {
  const fs = core.deps.ports.fs;
  let dir = core.deps.paths.workTree;
  for (const c of path.split('/')) {
    let names = listings.get(dir);
    if (names === undefined) {
      try {
        names = await fs.readdir(dir);
      } catch {
        names = null;
      }
      listings.set(dir, names);
    }
    if (names === null || !names.some((n) => n === c || n.normalize('NFC') === c)) return false;
    dir = join(dir, c);
  }
  return true;
}

/**
 * An incoming path this clone cannot materialize (DAT-33 receive side): carried (P2-CARRY: not stageable, carried by
 * the tick or the snapshot), not editable, not creatable here (receivePortRule: D7 rules 1–2 by name on win32, and rule 4,
 * case, on every case-folding disk against the paths on this disk and the earlier spellings of TIP; a case pair already tracked
 * is the carry set's), or beneath a local symlink, junction or file (P2-NOFOLLOW). The apply's W loop and the per-loop re-check
 * of a pending 'unmaterializable' path (P2-NA-TRIGGER) share this one predicate.
 */
export async function unmaterializableHere(core: EngineCore, it: IterationCtx, p: string): Promise<boolean> {
  if (!stageable(p) || it.tick?.carried.has(p) === true || core.snapshot.isCarried(p) || !editable(p)) return true;
  if (receivePortRule(core, it, p, await caseFoldingDisk(core)) !== null) return true;
  return !(await ancestorsSafe(core, p));
}

/**
 * Whether D7 rule 4 (case) binds this disk on the receive side: win32 (the platform's rule, EngineDeps.platform) or a
 * case-insensitive volume (core.ignorecase; final review ledger Task 13:234, controller ruling at the Plan 2 final merge).
 */
export async function caseFoldingDisk(core: EngineCore): Promise<boolean> {
  return core.deps.platform === 'win32' || (await core.snapshot.foldsCase());
}


/** The directory prefixes of a path, then the path. */
function prefixesAndName(path: string): string[] {
  const out: string[] = [];
  for (let i = path.indexOf('/'); i >= 0; i = path.indexOf('/', i + 1)) out.push(path.slice(0, i));
  out.push(path);
  return out;
}

/** Per TIP map (lazy, rebuilt when A changes): every TIP path's name and directory prefixes by case-fold key, each spelling with
 *  whether a TIP path A also holds carries it and the smallest TIP path carrying it (D7 rule 4 on the receive side). */
const caseIndexes = new WeakMap<TreeMap, { A: TreeMap; idx: Map<string, Map<string, { inA: boolean; min: string }>> }>();

function caseIndexOf(it: IterationCtx): Map<string, Map<string, { inA: boolean; min: string }>> {
  const hit = caseIndexes.get(it.tipMap);
  if (hit !== undefined && hit.A === it.A) return hit.idx;
  const idx = new Map<string, Map<string, { inA: boolean; min: string }>>();
  for (const q of it.tipMap.keys()) {
    const inA = it.A.has(q);
    for (const y of prefixesAndName(q)) {
      const k = collisionKey(y);
      let spellings = idx.get(k);
      if (spellings === undefined) idx.set(k, (spellings = new Map()));
      const cur = spellings.get(y);
      if (cur === undefined) spellings.set(y, { inA, min: q });
      else {
        if (inA) cur.inA = true;
        if (q < cur.min) cur.min = q;
      }
    }
  }
  caseIndexes.set(it.tipMap, { A: it.A, idx });
  return idx;
}

/**
 * Plan 3 Task 6, DAT-33 receive side ("D7 rules 2–4 evaluated against this disk"): the D7 rule that keeps TIP path p from being
 * created here, or null. On win32 (the platform whose rules the apply's gate has always applied): rules 1–2 by p's own name
 * (rule 3, the length, binds new local paths only: glossary §18 forces core.longpaths=true). On a case-folding disk
 * (`foldsCase`, caseFoldingDisk: win32 or core.ignorecase; the controller's ruling at the Plan 2 final merge, which replaces
 * Plan 2's stopgap of leaving every spelling of a TIP case pair unwritten, ledger Task 13:234): rule 4 (case) against the TIP
 * paths that are on this disk already or arrive before p (a TIP path A also holds, or one sorting before p in code-unit order),
 * so of an incoming case pair the earlier spelling applies and each later one is not materialised (no second create, so no
 * EEXIST race), and a spelling A already holds keeps its file. TIP-internal: a spelling only A holds (a case-only rename's old
 * name) is no rival. The one predicate of the apply's W loop, the P2-NA-TRIGGER re-check and ApplyReport.notApplicableRules.
 */
export function receivePortRule(core: EngineCore, it: IterationCtx, p: string, foldsCase: boolean): PortRule | null {
  if (core.deps.platform === 'win32') {
    const alone = portable(p, NO_PATHS);
    if (!alone.ok) return alone.rule === 3 ? null : alone.rule;
  }
  if (!foldsCase || it.A.has(p)) return null;
  const idx = caseIndexOf(it);
  for (const x of prefixesAndName(p)) {
    for (const [y, info] of idx.get(collisionKey(x)) ?? []) if (y !== x && (info.inA || info.min < p)) return 4;
  }
  return null;
}

/**
 * meta.pending reasons of not-applicable paths (R-05, P2-QUARANTINE-IN): they leave the apply trigger while their re-check holds
 * (P2-NA-TRIGGER). Shared, never copied (EF2 fix round 1, F5): holdSteps.ts's EF2 D5 re-derivation and resolve.ts's INCOMING discard.
 */
export const NOT_APPLICABLE_REASONS: ReadonlySet<string> = new Set(['collision', 'unmaterializable', 'quarantine']);

/**
 * Ruling P2-NA-TRIGGER: the meta.pending paths with a not-applicable reason whose cheap re-check still holds this
 * iteration — quarantine: the scope is still QUARANTINED; collision: a local entry still exists at p and the snapshot
 * has not taken it in (not dirty, not in the last materialized S_disk; an lstat error rejoins, the apply decides);
 * unmaterializable: unmaterializableHere. Such a path keeps A[p] and stays out of the apply trigger; a path whose
 * re-check clears rejoins it. Deferred paths (locked, race, mismatch, unstable, disk_low…) always stay in the trigger
 * (INV-ENG-PROGRESS).
 */
async function notApplicableStill(core: EngineCore, it: IterationCtx): Promise<Set<string>> {
  const out = new Set<string>();
  const view = core.view;
  if (view === null) return out;
  const rows = Object.entries(view.meta.pending).filter(([p, why]) => NOT_APPLICABLE_REASONS.has(why) && !sameEntry(it.A.get(p), it.tipMap.get(p)));
  const memo = inner(core).naDiskEq;
  const collisions = new Set(rows.filter(([, why]) => why === 'collision').map(([p]) => p));
  for (const p of [...memo.keys()]) if (!collisions.has(p)) memo.delete(p);
  if (rows.length === 0) return out;
  await ensureAttrs(core, it.epochBase, rows.map(([p]) => p));
  const lastS = core.snapshot.last()?.sDiskMap;
  const listings = new Map<string, readonly string[] | null>();
  for (const [p, why] of rows) {
    let still: boolean;
    if (why === 'quarantine') {
      still = it.scope(p).cls === 'QUARANTINED';
    } else if (why === 'collision') {
      let st;
      try {
        st = await core.deps.ports.fs.lstat(join(core.deps.paths.workTree, ...p.split('/')));
      } catch {
        st = null;
      }
      still = st !== null && it.tick?.dirty.has(p) !== true && lastS?.has(p) !== true;
      // Plan 3 Task 6, R3-33: a local file that now equals TIP's blob (a collision take wrote it, or the human copied it) returns
      // to the apply trigger: the apply then sets A[p] := TIP[p] with no write (disk_equal) and the collision record ends. Only a
      // file spelled exactly p (spelledExactly: never a case variant the folding volume finds instead). The re-check stays cheap
      // (P2-NA-TRIGGER, stat-based): an unchanged lstat and TIP blob reuse the last definite verdict (naDiskEq) — a not-equal one
      // needs no listing and no read; DISK_EQ (and the spelling check before it) runs only when either changed, and an equal
      // verdict is confirmed by the spelling check before the path rejoins the trigger (the apply checks it again).
      const t = it.tipMap.get(p);
      if (still && st !== null && t !== undefined) {
        const m = memo.get(p);
        let equal: boolean;
        if (m !== undefined && m.tip === t.oid && sameStat(m.stat, st)) {
          equal = m.equal && (await spelledExactly(core, p, listings));
        } else if (!(await spelledExactly(core, p, listings))) {
          equal = false;
          memo.delete(p);
        } else {
          const r = await core.diskEq.eq(p, t, null);
          equal = r.equal;
          if (r.equal || r.reason === 'differs') memo.set(p, { stat: st, tip: t.oid, equal });
          else memo.delete(p);
        }
        if (equal) still = false;
      }
    } else {
      still = await unmaterializableHere(core, it, p);
    }
    if (still) out.add(p);
  }
  return out;
}

/**
 * EF2 D5 (HLD-01, HLD-53/HLD-54, ENG-31): the pending not-applicable paths whose re-check held at this iteration's prepareIteration
 * (P2-NA-TRIGGER's set). No apply reports them again (they are out of the apply trigger), so recordStep re-derives their INCOMING
 * record from the journaled meta.pending row: a kill between the apply's state commit and the record's registry CAS leaves the
 * row and no record, and the record must still exist by the first iteration after the restart.
 */
export function notApplicableBlocked(core: EngineCore): ReadonlySet<string> {
  return inner(core).naBlocked;
}

/** ApplyReport.notApplicableRules' D7 rule of an `unmaterializable` path (Task 6): receivePortRule, else p's own rule but 3, else null. */
export function notApplicableRuleOf(core: EngineCore, it: IterationCtx, p: string, foldsCase: boolean): PortRule | null {
  const alone = portable(p, NO_PATHS);
  return receivePortRule(core, it, p, foldsCase) ?? (!alone.ok && alone.rule !== 3 ? alone.rule : null);
}

/** Paths of non-terminal ON_DISK PHANTOM PINs: written once and never verified; re-applying them is the ping-pong ENG-34 breaks. */
export function phantomPaths(core: EngineCore): ReadonlySet<string> {
  return phantomPathsOf(core.holds.nonTerminal());
}

/** phantomPaths over a given list of records (Plan 3 Task 18: flowRegistrySets reads the registry once for it and for the SHADOWs). */
function phantomPathsOf(records: readonly HoldRecord[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const r of records) {
    if (r.kind === 'PIN' && r.residence === 'ON_DISK' && !isTerminal(r) && r.guards.some((g) => guardName(g) === 'phantom')) {
      for (const p of r.paths) out.add(p);
    }
  }
  return out;
}

/** Why the apply trigger leaves out a path whose A and TIP differ (triggerRule). */
export type TriggerExclusion = 'carried' | 'phantom' | 'not_applicable';

/**
 * The apply trigger's per-path rule (01-engine §3.11), one rule for applicableDifference and the flow's incomingDifference (Plan 3 Task
 * 18 fix round 1, finding 1): 'carried' (P2-CARRY: never written, read or published; listed in not_converged — the iteration's own
 * tick.carried when given, and snapshot.isCarried, which holds the last tick's carry set), 'phantom' (a PHANTOM PIN's path: ENG-34's
 * ping-pong breaker) and 'not_applicable' (P2-NA-TRIGGER: a pending not-applicable path whose re-check of the last prepared iteration
 * still holds — a collision, an unmaterializable or a quarantined path never clears by re-applying it); null = in the trigger.
 */
function triggerRule(core: EngineCore, phantoms: ReadonlySet<string>, tickCarried?: ReadonlySet<string>): (p: string) => TriggerExclusion | null {
  const blocked = inner(core).naBlocked;
  return (p: string): TriggerExclusion | null => {
    if (tickCarried?.has(p) === true || core.snapshot.isCarried(p)) return 'carried';
    if (phantoms.has(p)) return 'phantom';
    return blocked.has(p) ? 'not_applicable' : null;
  };
}

/**
 * ∃ applicable p: A[p] ≠ TIP[p]. Not applicable here (triggerRule): carried paths, paths of a PHANTOM PIN and pending not-applicable
 * paths whose re-check of this iteration still holds. UNMANAGED differences count: the apply's state update makes their A follow TIP.
 */
export function applicableDifference(core: EngineCore, it: IterationCtx): boolean {
  if (it.A === it.tipMap) return false;
  const rule = triggerRule(core, phantomPaths(core), it.tick?.carried);
  const differs = (p: string): boolean => !sameEntry(it.A.get(p), it.tipMap.get(p)) && rule(p) === null;
  for (const p of it.A.keys()) if (differs(p)) return true;
  for (const p of it.tipMap.keys()) if (!it.A.has(p) && differs(p)) return true;
  return false;
}

/**
 * TickInput.skip (ruling P2-STRANDED-SKIP): the paths whose rollback restore is stranded (writer.strandedPaths(): p is
 * absent while its .old waits at its intent name), united with the Plan 5 fences — deps.claude.fenced(), the
 * INFLIGHT-fenced paths (X5-01, ENG-23; none in Plan 2). A skipped path is never lstat'd, read or confirmed as a
 * removal, so its absence never enters the human CS, a ready pair or a publish.
 */
export function tickSkip(core: EngineCore): ReadonlySet<string> {
  const stranded = core.writer.strandedPaths();
  const collisions = collisionPaths(core);
  const fenced = core.deps.claude.fenced();
  return stranded.length === 0 && collisions.length === 0 && fenced.size === 0
    ? NO_PATHS
    : new Set([...stranded, ...collisions, ...fenced]);
}

/**
 * Plan 3 Task 6, DAT-29: the paths of non-terminal `collision` records (`collision:keep` included). While such a record lives the
 * snapshot skips p, both as a new path (D6 step 2) and as a path now in TIP (D5): never in the private index, S_disk or P.
 */
function collisionPaths(core: EngineCore): string[] {
  return core.holds.nonTerminal().filter((r) => r.guards.some((g) => guardName(g) === 'collision')).flatMap((r) => r.paths);
}

/**
 * Plan 3 Task 6: writes the newest code to core.holdCode and every code to the daemon log (R-27); the one way a src/holds step's
 * HoldCodeRaise list reaches status (incomingStep's codes). A log line carries scalars only: an array parameter is written as its
 * comma-joined text, an object as its JSON (core.holdCode keeps the value as given). INCOMING_COLLISION waits for the local
 * human (DAT-29): warn; the others info.
 */
export function raiseHoldCodes(core: EngineCore, codes: readonly HoldCodeRaise[]): void {
  for (const c of codes) {
    const flat: Record<string, LogParam> = {};
    for (const [k, v] of Object.entries(c.params)) {
      flat[k] = Array.isArray(v) ? v.map(String).join(',') : v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
    }
    core.deps.log.write(c.code === 'INCOMING_COLLISION' ? 'warn' : 'info', c.code, flat);
    core.holdCode = { code: c.code, params: c.params };
    // Plan 5 Task 8 (A8-9, X5-41): after the status and log writes. F2 #110 (R-T8B-4): a throwing daemon listener never
    // aborts the hold step nor keeps the next listener or the next raise from its call — logged by its error name only
    // (the message may name a path or hold file content); a simulated kill still propagates.
    for (const cb of inner(core).holdCodeSubs) {
      try {
        cb(c);
      } catch (e) {
        if (e instanceof KilledAt) throw e;
        core.deps.log.write('error', 'CLAUDE_LISTENER_FAILED', { at: 'onHoldCode', code: e instanceof Error ? e.name : 'unknown' });
      }
    }
  }
}

/**
 * The capture gate (ruling P2-STRANDED-SKIP): a human CS closes and captures only when ChangeSets.closeDue() and no
 * restore is stranded — while one is, closeDue waits (S_disk would claim a p the disk lacks). The one predicate for
 * 'auto' materialize and for the caller that captures (Task 17's iterate calls it instead of cs.closeDue()).
 */
export function captureDue(core: EngineCore): boolean {
  if (core.writer.strandedPaths().length > 0) return false;
  // Plan 3 Task 10 (HLD-49): closeDue reads the held PINs of the newest groups() call, so a released bundle PIN is seen now.
  core.cs.groups(heldPins(core.holds));
  return core.cs.closeDue();
}

/**
 * HLD-38's publication groups of this moment (Plan 3 Task 10): the held PINs of the registry (heldPins) and, for R3-42, the CSs a
 * non-terminal SHADOW names (shadowCsIds); the readiness allowedPending, publishPending and publishStep read.
 */
export function publicationGroups(core: EngineCore): PublicationGroup[] {
  core.cs.shadowed(shadowCsIds(core.holds));
  return core.cs.groups(heldPins(core.holds));
}

/** The TickInput of the iteration (the same A object the tick saw: P2-ATREE), with the skip set as it is now. */
export function tickInputOf(core: EngineCore, it: IterationCtx): TickInput {
  const int = inner(core);
  if (int.aTree === null || int.aMap !== it.A) throw new Error('tickInputOf: the iteration\'s A is not the current A map');
  return { A: it.A, aTree: int.aTree, epochBase: it.epochBase, scope: it.scopeInputs, skip: tickSkip(core) };
}

/** live_code(T) and its tree (the board commit's last parent, or `known` when the caller read the board commit); memoized per board commit. */
export async function liveCodeOf(core: EngineCore, T: Oid, known?: Oid): Promise<{ tip: Oid; tree: Oid }> {
  const int = inner(core);
  const hit = int.tipOf.get(T);
  if (hit !== undefined) return hit;
  let tip = known;
  if (tip === undefined) {
    const b = await core.repo.readCommit(T);
    tip = b.parents[b.parents.length - 1];
    if (tip === undefined) throw new RemoteContentError(`liveCodeOf: ${T} has no parent`);   // remote content, typed at its source
  }
  const tree = (await core.repo.readCommit(tip)).tree;
  const v = { tip, tree };
  int.tipOf.set(T, v);
  if (int.tipOf.size > TIP_MEMO) int.tipOf.delete(int.tipOf.keys().next().value as string);
  return v;
}

// ---- provenance bounds (Plan 3 Task 8; HLD-25, R3-36, R3-59) ------------------------------------------------------

/** One state-ref reflog entry: the state commit, its [LA_C, LA_B] parents and its local time (ms). */
interface StateReflogEntry { commit: Oid; laC: Oid; laB: Oid; timeMs: number; }

/**
 * The state ref's reflog, newest first (ENG-02 writes every state update with --create-reflog), one `log -g` call. An entry's
 * local time is its state commit's committer time: this PC's clock wrote it at that update (the update-ref of the same
 * transition follows at once; in a test build the commit carries the virtual clock's wallMsForDates, which the reflog's own
 * timestamp cannot), so it is compared with this PC's clock only (INV-CLOCK). [] when the ref or its reflog is gone (an
 * expired reflog, a deleted ref); an entry that is not a two-parent state commit is skipped.
 */
async function stateReflog(core: EngineCore): Promise<StateReflogEntry[]> {
  const r = await core.repo.run(['log', '-g', '-z', '--no-show-signature', '--format=%H %P %ct', core.refs.state, '--'], { okCodes: [0, 128] });
  if (r.code !== 0) return [];
  const out: StateReflogEntry[] = [];
  for (const rec of r.stdout.toString('utf8').split('\0')) {
    const parts = rec.trim().split(' ');
    if (parts.length !== 4) continue;
    const [commit, laC, laB, ct] = parts as [string, string, string, string];
    const s = Number(ct);
    if (!isOid(commit) || !isOid(laC) || !isOid(laB) || !Number.isSafeInteger(s)) continue;
    out.push({ commit: commit as Oid, laC: laC as Oid, laB: laB as Oid, timeMs: s * 1_000 });
  }
  return out;
}

/**
 * The live code of the laB of the oldest entry still in the state ref's reflog (the first entry is the genesis/join
 * StateStore.create: L0 at genesis, TIP at a join — not its laC, which is L_b at a join, R3-59); null when none remains; no meta
 * field is added (ENG-05). (Task 8)
 */
export async function stateJoinPoint(core: EngineCore): Promise<Oid | null> {
  const entries = await stateReflog(core);
  const oldest = entries[entries.length - 1];
  return oldest === undefined ? null : (await liveCodeOf(core, oldest.laB)).tip;
}

/**
 * HLD-25's rebuild start: the laC of the newest state-ref reflog entry whose local timestamp (this PC's clock, INV-CLOCK) is older
 * than clock.wallMs() − PROV_RETENTION_MS, else stateJoinPoint(core). Restart, the lost-state rebuild and a re-anchor's rebuild pass
 * it to ProvenanceJournal.load/advance (Task 8, R3-36, R3-59). A user who expired the reflog moves the bound later (Flags item 7).
 */
export async function provRebuildFrom(core: EngineCore): Promise<Oid | null> {
  const cutoff = core.deps.ports.clock.wallMs() - PROV_RETENTION_MS;
  const entries = await stateReflog(core);
  const old = entries.find((e) => e.timeMs < cutoff);
  if (old !== undefined) return old.laC;
  const oldest = entries[entries.length - 1];
  return oldest === undefined ? null : (await liveCodeOf(core, oldest.laB)).tip;
}

/**
 * R3-59: ProvenanceJournal.advance(oldLaC, view.laC, () => provRebuildFrom(core)) after a laC-moving state CAS (by commit() by
 * default; by applyStep after apply.state; by the lost-state rebuild's advance-or-load). The journal is a rebuildable cache: a
 * failure other than a crash (KilledAt) is logged (PROV_ADVANCE_FAILED, a registered log code, HOLD_LOG_CODES) and marks the
 * journal stale, and the next advance — the next LA_C move of this run — reloads it through load(view.laC, provRebuildFrom(core)),
 * which journals the failed span too (Task 8 fix round 1, controller ruling).
 */
export async function advanceProvenance(core: EngineCore, oldLaC: Oid): Promise<void> {
  const view = core.view;
  if (view === null || view.laC === oldLaC) return;
  try {
    await core.prov.advance(oldLaC, view.laC, () => provRebuildFrom(core));
  } catch (e) {
    if (e instanceof KilledAt) throw e;
    core.deps.log.write('error', 'PROV_ADVANCE_FAILED', { from: oldLaC, to: view.laC, error: e instanceof Error ? e.name : 'unknown' });
  }
}

/**
 * The fold of this run not yet in the state: what the next transition carries (R-14, P2-FOLDPERSIST) — the fold state,
 * and meta.fold_board, fold_verified and checkpoint_mismatch. null when the state already holds it.
 */
export function foldPatch(core: EngineCore): { fold: FoldState; meta: Pick<Meta, 'fold_board' | 'fold_verified' | 'checkpoint_mismatch'> } | null {
  const f = inner(core).fold;
  if (f === null) return null;
  const v = core.folder.verification();
  return { fold: f.state, meta: { fold_board: f.board, fold_verified: v.verified, checkpoint_mismatch: v.checkpointMismatch } };
}

/**
 * The governor's caller contract (src/board/governor.ts): after EVERY completed fetch, onFetch with the fetched board
 * tip, the number of first-parent board commits it revealed since the tip the governor last observed, firstOfRun and
 * the allowed pending work. A deferred view (no fetch ran) is not reported. Publish's classify fetch uses it too.
 * `known`: the caller counted the first-parent commits from `from` to the fetched tip already (the fold did).
 */
export async function observeFetch(core: EngineCore, view: FetchView, pending: boolean, known?: { from: Oid; revealed: number }): Promise<void> {
  if (view.deferred) return;
  const int = inner(core);
  // A failed fetch observed no tip: it reports the tip last observed, so the anchor stays and no pre-emption is counted.
  const tip = view.ok ? (view.board === ABSENT ? null : view.board) : (int.observedTip ?? null);
  let revealed = 0;
  const prev = int.observedTip;
  if (known !== undefined && prev === known.from) {
    revealed = tip === prev ? 0 : known.revealed;   // the fold already listed the commits from `from` to the tip
  } else if (tip !== null && prev !== undefined && prev !== null && prev !== tip) {
    try {
      revealed = (await core.repo.firstParents(tip, prev, 10_000)).length;
    } catch (e) {
      if (e instanceof KilledAt) throw e;
      revealed = 0;   // the previous tip is unknown here (a rewrite): nothing is counted
    }
  }
  core.governor.onFetch(tip, revealed, view.firstOfRun, pending);
  if (view.ok) int.observedTip = tip;
}

/** An own push landed at Bnew on lease T (Task 14's ok path, Task 15's restart resolution): governor.onOwnOk, and Bnew becomes the observed tip when nothing newer was observed. */
export function observeOwnLanding(core: EngineCore, bnew: Oid, lease: OidOrAbsent): void {
  const int = inner(core);
  core.governor.onOwnOk(bnew);
  if (int.observedTip === undefined || int.observedTip === (lease === ABSENT ? null : lease)) int.observedTip = bnew;
}

/** P2-PUSHSTATES: every active push state of the iteration ([] = ok). */
export function pushStatesOf(core: EngineCore, version: VersionVerdict): PushState[] {
  const view = core.view;
  if (view === null) return [];
  const meta = view.meta;
  const out: PushState[] = [];
  const fr = meta.freeze_reasons;
  if (fr.includes('INCIDENT')) out.push('incident');
  else if (fr.includes('CONFIG') && (meta.config_detail.includes('url') || meta.config_detail.includes('public'))) out.push('config_net');
  else if (fr.length > 0) out.push('frozen');
  if (core.fetcher.offline().offline) out.push('offline');
  if (meta.nonretryable !== null) out.push('nonretryable');
  if (version.proto) out.push('version_proto');
  else if (version.regionSpec || version.checkpointMismatch) out.push('version_board_only');
  return out;
}

/**
 * The HOST_THROTTLED health events a fold made new to this peer (P2-R18: own or a teammate's; `own` = posted by
 * `self`): every one above the previous fold's height `prevHeight`. With no previous fold (null: none persisted and none
 * this run, so the fold started from genesis or a checkpoint) the events were not posted "now": only those within the
 * last RESTART_EVENT_HEIGHTS first-parent heights count, the window of PRO-55's restart rule (recentThrottleEvent) —
 * never every historical event the board still holds.
 */
export function newlyFoldedThrottleEvents(state: FoldState, prevHeight: number | null, self: PeerId): Array<{ height: number; own: boolean }> {
  const out: Array<{ height: number; own: boolean }> = [];
  for (const e of Object.values(state.events)) {
    if (e.kind !== 'health' || e.reason_code !== 'HOST_THROTTLED') continue;
    const fresh = prevHeight === null ? state.height - e.height < RESTART_EVENT_HEIGHTS : e.height > prevHeight;
    if (fresh) out.push({ height: e.height, own: parseOpId(e.op_id)?.peer === self });
  }
  return out;
}

export type LocalOnlyReason = 'secret-scan' | 'filter-failure' | 'secret-like';
const LOCAL_ONLY_RANK: Readonly<Record<LocalOnlyReason, number>> = { 'filter-failure': 0, 'secret-scan': 1, 'secret-like': 2 };

/**
 * R3-21 (Plan 3 Task 2): the paths of non-terminal ON_DISK local_only PATCH/PIN records, the one binding of ScopeInputs.localOnlyPaths
 * (D5 row 9) and the apply's ConflictCtx.localOnly (D8 step 0, HLD-55); an OFF_DISK local_only record (a marker companion, a
 * collision take capture) masks nothing (MASK step 2, INV-HLD-OFFDISK) and leaves its path's class alone. `reason(p)` is DAT-31's
 * one reason per path: 'filter-failure' or 'secret-scan' when a covering record carries that guard (Table 3 order), else
 * 'secret-like'.
 */
export function localOnlyScope(core: EngineCore): { paths: ReadonlySet<string>; reason: (p: string) => LocalOnlyReason } {
  const reasons = new Map<string, LocalOnlyReason>();
  for (const r of core.holds.nonTerminal()) {
    // Plan 3 Task 6: an INCOMING record holds TIP's bytes, none of this disk's (it is ON_DISK by schema only): it never makes a path
    // LOCAL_ONLY, so a local-only-conflict record cannot keep the local_only record it waits for local_only (HLD-55).
    if (r.residence !== 'ON_DISK' || !r.local_only || isTerminal(r) || r.kind === 'INCOMING') continue;
    const names = new Set(r.guards.map(guardName));
    const why: LocalOnlyReason = names.has('filter-failure') ? 'filter-failure' : names.has('secret-scan') ? 'secret-scan' : 'secret-like';
    for (const p of r.paths) {
      const had = reasons.get(p);
      if (had === undefined || LOCAL_ONLY_RANK[why] < LOCAL_ONLY_RANK[had]) reasons.set(p, why);
    }
  }
  return { paths: new Set(reasons.keys()), reason: (p) => reasons.get(p) ?? 'secret-like' };
}


/**
 * Allowed pending work for the governor (Plan 3 Task 10, HLD-39, contract addition 8): code counts only when some publication group
 * is ready with an unpublished pair — the predicate publishPending uses — so a not-ready group (an uncovered open member, a held
 * PIN, R3-53's gate) never holds the head of the governor queue; or ops allowed in every active state. Task 12a (R3-57, HLD-31):
 * never code while codeWithheld (maskInvalid, or the post-resume MASS batch pending).
 */
function allowedPending(core: EngineCore, states: readonly PushState[]): boolean {
  return core.outbox.pendingAllowed(states) || codePending(core, states);
}

/**
 * The code part of allowedPending (the governor's `pending` input): some publication group is ready with an unpublished pair, in the ok
 * state; never while codeWithheld (Plan 3 Task 12a: maskInvalid, or the post-resume MASS batch pending; R3-57, HLD-31). It takes no
 * iteration (Task 12b fix round 1): its one caller, prepareIteration's observeFetch, runs before the IterationCtx exists and before
 * detectStep's massResumeStep, where a post-resume batch still due is massResumePending; the batch-forming iteration's own mark
 * (markBatchFormed) is read by the later, iteration-scoped pending inputs — publish.ts's handOverThrottle/pendingCheap and publishPending.
 */
export function codePending(core: EngineCore, states: readonly PushState[]): boolean {
  if (states.length !== 0 || core.cs.ready().length === 0 || codeWithheld(core)) return false;
  return publicationGroups(core).some((g) => g.ready);
}

/**
 * Plan 3 Task 12a (the Task 9 carry "Plan 2's first-tick re-form recaptures ready pairs' paths into a human CS"): the changed paths
 * whose tick change is not already the newest journaled ready pair's entry for the path. A path a pair carries whose dirty entry is
 * that pair's R entry (the same blob and mode — the detection id is the bytes' blob id — or a removal where R lacks the path) is a
 * change already captured: after a restart's reseed from state:snap (which predates the unpublished pairs) the first tick reports
 * it again, and observing it would put a seat's (or an earlier human CS's) captured change into the open human CS. Any other change
 * of such a path (new bytes, or bytes canon would rewrite) is observed as before. One readTreeMap per pair consulted.
 */
async function notCaptured(core: EngineCore, tick: TickResult, paths: readonly string[]): Promise<string[]> {
  const ready = core.cs.ready();
  if (ready.length === 0 || paths.length === 0) return [...paths];
  const newest = new Map<string, ReadyPair>();
  for (const pair of [...ready].sort((a, b) => a.order - b.order)) for (const p of pair.paths) newest.set(p, pair);
  const trees = new Map<Oid, TreeMap>();
  const out: string[] = [];
  for (const p of paths) {
    const pair = newest.get(p);
    const de = tick.dirty.get(p);
    if (pair === undefined || de === undefined) {
      out.push(p);
      continue;
    }
    let R = trees.get(pair.R);
    if (R === undefined) trees.set(pair.R, (R = await core.repo.readTreeMap(pair.R)));
    const r = R.get(p);
    const captured = de.kind === 'remove' ? r === undefined : r !== undefined && de.id !== null && de.id === r.oid && de.mode === r.mode;
    if (!captured) out.push(p);
  }
  return out;
}

/** EF2 D3: the restart's re-form hands the first tick the ready pairs' paths whose state:snap entry differs from A and R (reformAtTick). */
export function setReformAtFirstTick(core: EngineCore, paths: ReadonlySet<string>): void {
  inner(core).reformAtTick = paths;
}

/**
 * EF2 D3, the clean side of notCaptured at the first tick after a restart (HLD-36: "every unpublished local delta not in a ready
 * pair"; HLD-40: bytes after a capture stay in the open CS). The restart reseeds the private index from state:snap, so a path whose
 * local change an apply's ENG-36 update took into snap after the newest ready pair's capture reads clean at the tick, and the
 * re-form's diff(A, snap) skips it because a pair names it. Of the paths the re-form handed over (snap[p] ≠ A[p] and ≠ the newest
 * pair's R[p]), the LIVE ones this tick finds clean (not dirty, not excluded, not carried: S_disk[p] = snap[p]) are observed; a dirty
 * one was judged by notCaptured against the same R. The decision waits for the tick because a capture's state commit does not move
 * snap: snap can lag R while the disk already equals R (that path is dirty here and notCaptured skips it).
 *
 * EF2 fix round 1, F2: only the paths a tick decides leave the handover — clean ones (observed here, or not LIVE) and dirty or changed
 * ones (notCaptured judged them). A path the tick did not read stays handed over until a tick reads it: an exclusion (UNREADABLE under
 * a share-none holder, UNSTABLE mid-save, the quiet period, …), a carried path (P2-CARRY) and a skipped one (`skip`: a stranded restore
 * or a collision, never looked at — it is in none of the tick's sets, so it would otherwise read as clean). Dropping such a path at the
 * first tick lost its edit for good: once readable the disk equals snap, so no later tick sees a change.
 */
async function reformedAtTick(core: EngineCore, tick: TickResult, skip: ReadonlySet<string>, epochBase: Oid, scope: (p: string) => Scope): Promise<string[]> {
  const int = inner(core);
  if (int.reformAtTick.size === 0) return [];
  const handed = int.reformAtTick;
  const unread = (p: string): boolean => tick.excluded.has(p) || tick.carried.has(p) || skip.has(p);
  const kept = [...handed].filter(unread);
  int.reformAtTick = kept.length === 0 ? NO_PATHS : new Set(kept);
  const clean = [...handed].filter((p) => !unread(p) && !tick.dirty.has(p) && !tick.changed.has(p)).sort();
  if (clean.length === 0) return [];
  await ensureAttrs(core, epochBase, clean);
  return clean.filter((p) => scope(p).cls === 'LIVE');
}

/** The iterations whose materialization covered only their holdPaths (Plan 3 Task 5); a full materialization has no entry. */
const partialMats = new WeakMap<IterationCtx, ReadonlySet<string>>();

/**
 * The iteration materialized and its S_disk holds this read of every path (Plan 2's capture form): fully, or only these paths through
 * PrepareOptions.holdPaths (a path the partial materialization did not cover is current only when the tick found it clean), and no
 * path was a materialize-time exclusion. A path the tick itself excluded (its quiet period, an mtime ahead of this PC's clock, unstable,
 * a shrink waiting for its second snapshot) keeps its last stable entry here, which a capture takes as the CS's state (Plan 2).
 */
export function materializedOver(it: IterationCtx, paths: readonly string[]): boolean {
  const mat = it.mat;
  if (mat === null) return false;
  const only = partialMats.get(it);
  return paths.every((p) => !mat.excluded.has(p) && (only === undefined || only.has(p) || it.tick?.dirty.has(p) !== true));
}

/**
 * Plan 3 Task 5: the iteration's S_disk is current for every path of `paths` — materializedOver, and (Task 12b, carry 4) no path was
 * excluded by this iteration's detection tick: such a path kept its last S_disk entry, which may not be the disk now, so a hold
 * operator deciding on it (PARK's target, RESTORE's D, the markers release) would act on bytes the disk no longer holds. The hold
 * operators, S6 and the stop park run only then.
 */
export function materializedFor(it: IterationCtx, paths: readonly string[]): boolean {
  return materializedOver(it, paths) && paths.every((p) => it.tick?.excluded.has(p) !== true);
}

/** The iteration materialized only its PrepareOptions.holdPaths (a hold-record occasion, W6 (c)): no S_disk to capture or settle a candidate from. */
export function partialMaterialization(it: IterationCtx): boolean {
  return it.mat !== null && partialMats.has(it);
}

/** 01-engine §3.5 steps 1–3: fetch (Fetcher, ls-remote fallback), incident check (entering the incident is the caller's, Task 16), fold + VERSION verdict, detection tick, materialize per the option. Shared by Engine.iterate, startDispatch and tests.
 *  An answered ls-remote fallback with the board ABSENT is a successful fetch and takes the incident branch (board_missing) when a state exists.
 *  A failed fetch (transport: no answer) is NOT a failure branch (§3.5 step 1, ENG-19): the result is ok with it.fetched.ok === false and T/tip/fold of the last
 *  successfully checked board (LA_B when this run has none), so steps 3–5 (tick, capture, apply of pending paths) still run; no publish
 *  in that iteration, and pushState 'offline' once ENG-19's 30 s hold. */
export async function prepareIteration(core: EngineCore, n: number, o: PrepareOptions): Promise<Prepared> {
  const int = inner(core);
  const start = anchorNow(core.deps.ports.clock);
  // Plan 3 Task 1: REBASE outputs are unreferenced loose objects that a user's gc between iterations may prune; the cache never
  // serves one across an iteration start.
  core.rebase.clear();
  if (core.view === null) return { ok: false, why: 'no_state' };
  const repo = core.repo;

  const fetchFoldOnly = o.fetchFoldOnly === true;
  // Ring housekeeping every iteration (Task 10): expired .old files, late writes, stranded restores. A failing sweep
  // (a late write the clean filter refuses) keeps its entries for the next one and never stops the iteration. Not in a
  // fetch-and-fold-only iteration: the sweep writes the work tree.
  if (!fetchFoldOnly) {
    try {
      await core.writer.sweepRing();
    } catch (e) {
      if (e instanceof KilledAt) throw e;
      core.deps.log.write('error', 'RING_SWEEP_FAILED', { code: e instanceof Error ? e.name : 'unknown' });
    }
    // P2-NARROW: the sweep that empties writer.strandedPaths() ends the narrowed apply intent this run kept (one
    // intent-only transition; the only state write prepareIteration makes).
    if (int.keptApplyIntent && core.writer.strandedPaths().length === 0) {
      if (core.view.intent.kind === 'apply') await core.commit({ intent: { kind: 'none' }, t: new Map() });
      int.keptApplyIntent = false;
      core.deps.log.write('info', 'APPLY_INTENT_CLEARED', {});
    }
  }
  const view = core.view;

  // 1 FETCH (ENG-18, ENG-19, P2-NOSLEEP): a deferred view ran no fetch; it and a failed one continue against the last
  // successfully checked board (LA_B when this run has none) and publish nothing. A deferred view repeats the last
  // fetch's board, which an own landing since then left behind LA_B (final review FC-1): never checked against LA_B.
  const fetched = await core.fetcher.fetch(o.forceFetch);
  const T: OidOrAbsent = fetched.ok && !fetched.deferred ? fetched.board : (int.lastCheckedT ?? view.laB);

  // 2 INCIDENT CHECK (ENG-20); remote content typed at its source (BoardMalformedError, RemoteContentError: the check's,
  // the fold's and the live-chain reads') is the check's board_shape, never a crash (Task 15 ruling: one mapping).
  const incident = async (verdict: Extract<IncidentVerdict, { ok: false }>): Promise<Prepared> => {
    await observeFetch(core, fetched, false);
    return { ok: false, why: 'incident', verdict, T };
  };
  let verdict: IncidentVerdict;
  try {
    verdict = await incidentCheck(repo, view.laB, view.laC, T, core.deps.testMutants);
  } catch (e) {
    if (!isRemoteContentError(e)) throw e;
    verdict = { ok: false, why: 'board_shape', observedBoard: T === ABSENT ? null : T, observedCode: null };
  }
  if (!verdict.ok) return incident(verdict);
  const board = T as Oid;

  // FOLD (PRO-25…PRO-29) from the newest fold of this run (or the persisted one) and the VERSION verdict (ENG-55), the
  // board's protocol and live_code(T): every read of remote content before anything of this iteration is kept.
  const prevHeight = int.fold?.state.height ?? null;
  const prevBoard = int.fold?.board ?? null;
  let outcome;
  let params: GovernorParams | null = null;
  let live;
  try {
    outcome = await core.folder.foldTo(board, int.fold, core.deps.regionSpec);
    if (int.paramsBoard !== board) params = outcome.newCommits[outcome.newCommits.length - 1]?.protocol ?? (await readBoardCommit(repo, board)).protocol;
    live = await liveCodeOf(core, board, outcome.newCommits.find((c) => c.oid === board)?.liveCode);
  } catch (e) {
    if (!isRemoteContentError(e)) throw e;
    return incident({ ok: false, why: 'board_shape', observedBoard: board, observedCode: null });
  }
  int.fold = { board, state: outcome.state };
  int.lastCheckedT = board;
  core.caps = outcome.state.caps;
  // Plan 4 Task 5 (R4-36): the fold at the leased tip is the claim host's fold(); set after every fold.
  core.leasedFold = { tip: board, state: outcome.state };
  // Plan 4 Task 5 (R4-28): the own claim-op rejections of this fold, once per iteration (the stub is Task 11's).
  claimRejectionStep(core);
  // Plan 4 Task 5 (Task 13's scheduling): newly folded claim ops, once after each fold (the stub is Task 13's).
  labelStep(core, outcome);
  if (params !== null) {
    core.governor.setParams(params);
    int.paramsBoard = board;
  }
  // Folded HOST_THROTTLED events (P2-R18: own or a teammate's), and PRO-55's restart rule at the run's first fetch.
  for (const e of newlyFoldedThrottleEvents(outcome.state, prevHeight, core.peerId)) core.governor.onThrottleEventFolded(e.own);
  if (fetched.firstOfRun && !fetched.deferred && recentThrottleEvent(outcome.state, RESTART_EVENT_HEIGHTS)) {
    // own: one of the events inside the restart window is this peer's (never an older own event outside it).
    core.governor.onThrottleEventFolded(newlyFoldedThrottleEvents(outcome.state, null, core.peerId).some((e) => e.own));
  }
  const pushStates = pushStatesOf(core, outcome.version);
  await observeFetch(core, fetched, allowedPending(core, pushStates),
    prevBoard !== null && fetched.ok && fetched.board === board && (outcome.newCommits[0]?.firstParent ?? board) === prevBoard
      ? { from: prevBoard, revealed: outcome.newCommits.length } : undefined);

  // TIP, A and this iteration's attributes and scope.
  const { tip, tree: tipTree } = live;
  const tipMap = await repo.readTreeMap(tipTree);
  int.tipMap = tipMap;
  const { aTree, A } = await currentA(core);
  // Plan 3 Task 18: the flow's TIP tree and the A it was taken with.
  int.flow.tipTree = tipTree;
  int.flow.aAtTip = A;
  const epochBase = view.meta.EPOCH_BASE;
  int.attrMap = new Map();
  int.attrBase = epochBase;
  await ensureAttrs(core, epochBase, aTree === tipTree ? A.keys() : [...A.keys(), ...tipMap.keys()]);
  await ensureRecordAttrs(core, epochBase);
  const changedTip: Array<{ path: string; oid: Oid }> = [];
  if (aTree !== tipTree) {
    for (const [p, e] of tipMap) if (!sameEntry(A.get(p), e)) changedTip.push({ path: p, oid: e.oid });
  }
  const sizes = await repo.blobSizes(changedTip.map((c) => c.oid));
  const tipSizes = new Map(changedTip.map((c, i) => [c.path, sizes[i] ?? 0] as const));
  // D5 row 9 (R3-21): the paths of non-terminal ON_DISK local_only records, with DAT-31's reason per path.
  const localOnly = localOnlyScope(core);
  const scopeInputs: ScopeInputs = {
    attrs: attrView(int, epochBase), config: core.config, mergeDrivers: int.mergeDrivers, localOnlyPaths: localOnly.paths,
    localOnlyReason: localOnly.reason, hooksPathDir: int.hooksPathDir,
  };
  const scope = scopeFunction(core, scopeInputs, A, tipMap, tipSizes);
  lastScopes.set(int, scope);
  lastScopeBase.set(int, epochBase);

  if (fetchFoldOnly) {
    // ENG-15 / LIF-10 / glossary §8: fetch and fold only — the work tree belongs to the human's git command. F2 #108: the
    // TXN is read here too (a Claude `git commit` inside Bash holds index.lock and a TXN at once; the TXN is the truer reason).
    const it: IterationCtx = {
      n, start, fetched, T: board, tip, tipMap, A, fold: outcome.state, version: outcome.version,
      epochBase, scopeInputs, scope, tick: null, mat: null,
      freeze: [...view.meta.freeze_reasons], pushStates, leaseIdleMs: o.leaseIdleMs ?? core.deps.lease.idleMs(),
      txnOpen: core.deps.claude.txnOpen(),
    };
    return { ok: true, it };
  }

  // 3 SNAPSHOT: a detection tick (no object written, glossary §26.1 W6). P2-STRANDED-SKIP: a path whose restore is
  // stranded (after this iteration's sweep) is never looked at: its absence is not a deletion. Plan 3 Task 17 (decision D2): first the
  // revert shrink marks of CSs no longer pending end (a --discard since the last iteration), so ENG-25's lift never outlives its record.
  endRevertMarks(core);
  // Plan 5 Task 8 (X5-01, 06 §3.7.3, ENG-23; 01 test 55): while a TXN is open on this worktree the snapshotter and
  // the applier stay out of it — no detection tick and no materialization (a queued edit capture waits for the close);
  // the fetch, the fold, the publish and the push-intent resolution go on. The context keeps tick and mat null and
  // names the TXN in it.txnOpen (F2 #108), which is the loop's capture-time gate (loop.ts, F2 #104) and the apply
  // admission's own (admissionSkip → 'txn', F2 #59).
  const txnOpen = core.deps.claude.txnOpen();
  const tickInput: TickInput = { A, aTree, epochBase, scope: scopeInputs, skip: tickSkip(core) };
  const tick = txnOpen ? null : await core.snapshot.tick(tickInput);
  if (tick !== null && tick.failed) return { ok: false, why: 'snapshot_failed' };
  // HLD-35: the human CS opens or extends with the tick's changes on LIVE paths only (Task 11 ruling) — never with a change a ready
  // pair already carries (Plan 3 Task 12a, the Task 9 carry: after a restart's reseed from state:snap the first tick reports every
  // unpublished pair's path again; re-observing it would copy a seat's captured change into a human CS). Plan 3 Task 17 (ENG-25, §8
  // Q18): tickSettled first routes a revert CS's written paths, and a path a closing capture took while excluded, to their closed CS.
  if (tick !== null) {
    await ensureAttrs(core, epochBase, tick.changed);
    const observed = await notCaptured(core, tick, [...tick.changed].filter((p) => scope(p).cls === 'LIVE'));
    core.cs.tickSettled(new Set(observed), tick.excluded);
    core.cs.observe([...observed, ...(await reformedAtTick(core, tick, tickInput.skip, epochBase, scope))]);
  }

  const it: IterationCtx = {
    n, start, fetched, T: board, tip, tipMap, A, fold: outcome.state, version: outcome.version,
    epochBase, scopeInputs, scope, tick, mat: null,
    freeze: [...view.meta.freeze_reasons], pushStates, leaseIdleMs: o.leaseIdleMs ?? core.deps.lease.idleMs(),
    txnOpen,
  };
  // P2-NA-TRIGGER: re-check the pending not-applicable paths before anything asks the apply trigger.
  int.naBlocked = await notApplicableStill(core, it);
  // R3-EF4-26 (01-engine §3.5 step 3: materialize when this iteration "applies (step 5 admitted)"): the apply admission is decided
  // here, once, and kept on the context; applyStep uses this decision and its instant, never a later clock (applyAdmission).
  it.admission = applyAdmission(core, it, core.deps.ports.clock.monoMs());
  // 'auto': a ready-pair capture is due, or the apply of this iteration is admitted (glossary §26.1 W6: objects
  // only for the occasions that need them; a coalesced or frozen apply writes none). Neither while a restore is
  // stranded (P2-NARROW, P2-STRANDED-SKIP).
  const applyAdmitted = it.admission.skipped === null;
  // Plan 5 Task 8 (X5-01, 06 §3.7.3): the materialization is skipped whole while the TXN is open — a capture due and
  // a hold-record occasion alike (the snapshotter keeps out of the work tree; the iteration after the close runs it).
  // F2 #104 fix round 1: the port is read again here — a TXN can open while the tick above awaits its fs/git calls (the
  // daemon's PreToolUse(Bash) handler runs on the same event loop), and `txnOpen` is the read from before the tick. Fix round 2:
  // the context takes the same answer (it.txnOpen), so its readers never see the stale read.
  const txnNow = txnOpen || core.deps.claude.txnOpen();
  it.txnOpen = txnNow;
  const materialize = !txnNow && (o.materialize === true || (o.materialize === 'auto' && (captureDue(core) || applyAdmitted)));
  if (materialize) {
    it.mat = await core.snapshot.materialize(tickInput);
    await ensureAttrs(core, epochBase, it.mat.sDiskMap.keys());
  } else if (!txnNow && o.holdPaths !== undefined && o.holdPaths.size > 0) {
    // Plan 3 Task 5 (W6 (c)): a hold-record occasion materializes exactly its paths (Snapshotter.materialize's `only`).
    it.mat = await core.snapshot.materialize(tickInput, o.holdPaths);
    await ensureAttrs(core, epochBase, it.mat.sDiskMap.keys());
    partialMats.set(it, o.holdPaths);
  }
  return { ok: true, it };
}

/**
 * R3-EF4-26, the one re-decision: the incident check's heal (clearIncidentIfHealed; 01-engine §3.5 step 2 lifts INCIDENT before step 3
 * materializes for an admitted step 5) runs after prepareIteration decided this iteration's apply admission, so its freeze set changed
 * since. Called right after the heal, before any detection step: the admission is decided again now and, admitted, materialized here as
 * prepareIteration's 'auto' would have — never after detectStep. A context with a partial (holdPaths) materialization keeps prepare's
 * decision: a full materialization on top of it would hand revertStep a prevMap without the pre-partial entries of those paths.
 */
export async function readmitApply(core: EngineCore, it: IterationCtx): Promise<void> {
  if (it.admission === undefined || partialMats.has(it)) return;
  it.admission = applyAdmission(core, it, core.deps.ports.clock.monoMs());
  if (it.admission.skipped !== null || it.mat !== null) return;
  it.mat = await core.snapshot.materialize(tickInputOf(core, it));
  await ensureAttrs(core, it.epochBase, it.mat.sDiskMap.keys());
}
