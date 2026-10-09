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
import { join, isAbsolute, relative, sep } from 'node:path';
import { readBoardCommit, RemoteContentError } from '../board/boardCommit.js';
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
import { portable, scopeOfTracked, type Scope, type ScopeInputs } from '../data/scope.js';
import type { GitIdentity } from '../git/flags.js';
import { ABSENT, type Oid, type OidOrAbsent } from '../git/oid.js';
import { GitRepo, type FileMode, type RepoContext, type TreeEntry, type TreeMap } from '../git/repo.js';
import { ChangeSets } from '../holds/changesets.js';
import { HoldRegistry } from '../holds/registry.js';
import { guardName, isTerminal } from '../holds/record.js';
import { anchorNow, type Anchor } from '../ports/clock.js';
import { KilledAt } from '../ports/crashpoint.js';
import { LEASE_STOP_SYNC_MS } from '../ports/lease.js';
import { validId, validName, validPathSyntax } from '../sec/validators.js';
import { APPLY_COALESCE_MS } from './apply.js';
import type { EngineDeps } from './deps.js';
import { DiskEq } from './diskEq.js';
import { isRemoteContentError } from './errors.js';
import { Fetcher, type FetchView } from './fetcher.js';
import { incidentCheck, type IncidentVerdict } from './incident.js';
import { MetaTooNewError, type FreezeReason, type Meta } from './meta.js';
import { refNames, type RefNames } from './refs.js';
import { Snapshotter, type Materialized, type TickInput, type TickResult } from './snapshot.js';
import { LostStateError, StateStore, type StateView, type Transition } from './state.js';
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
  commit(t: Transition): Promise<StateView>;   // view := state.commit(view, t)
  identity(): GitIdentity;
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
}

// 'auto' = when a capture is due (captureDue) or an apply would be admitted. fetchFoldOnly (Task 17 fix round 1, an
// optional addition): ENG-15 (.git/index.lock) and LIF-10 / glossary §8 (FREEZE(EPOCH)) — fetch, incident check and
// fold only: no ring sweep (it writes the work tree), no detection tick, no change-set observation, no materialization;
// the iteration context carries tick null.
export interface PrepareOptions { materialize: boolean | 'auto'; forceFetch: boolean; fetchFoldOnly?: boolean; }
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
}

const internals = new WeakMap<EngineCore, Internals>();

function inner(core: EngineCore): Internals {
  const i = internals.get(core);
  if (i === undefined) throw new Error('engine core: not built by createEngineCore');
  return i;
}

const PEER_FILE = 'peer';
const NO_PATHS: ReadonlySet<string> = Object.freeze(new Set<string>());
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
 */
export function hooksDir(workTree: string, value: string | null): string | null {
  if (value === null) return null;
  const v = value.trim();
  if (v.length === 0) return null;
  const rel = isAbsolute(v) ? relative(workTree, v) : v;
  if (rel.length === 0 || isAbsolute(rel)) return null;
  const parts = rel.split(sep).join('/').split('/').filter((c) => c.length > 0 && c !== '.');
  if (parts.length === 0 || parts.includes('..')) return null;
  return parts.join('/');
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
  const hooksPathDir = hooksDir(paths.workTree, await repo.configGet('core.hooksPath'));

  const int: Internals = {
    headAtCreate, mergeDrivers, hooksPathDir, aTree: null, aMap: null, attrBase: null, attrMap: new Map(),
    fold: view !== null && view.fold !== null && view.meta.fold_board !== null ? { board: view.meta.fold_board, state: view.fold } : null,
    lastCheckedT: null, observedTip: undefined, paramsBoard: null, tipOf: new Map(), naBlocked: NO_PATHS, keptApplyIntent: false,
    boardOnlyFirstPublish: false,
  };

  const scratch = (name: ScratchName): string => join(tmpDir, `${name}.index`);
  const privateIndex = join(paths.coworkDir, `${refs.e}.index`);
  const stage = new StageDir(fs, join(tmpDir, 'stage'));
  const statCache = new StatCache();
  const attrs = new AttrCache(repo, fs);
  const isFiltered = (p: string): boolean => filteredBy(int, filters, p);
  const isText = (p: string): boolean => textBy(int, p);
  const snapshot = new Snapshotter({
    repo, fs, clock, trace: deps.trace, peer: peerId, privateIndex,
    scratch: { detect: scratch('detect'), canon: scratch('canon') },
    stage, statCache, attribution: deps.attribution, filters, platform: deps.platform,
  });
  const diskEq = new DiskEq({
    repo, fs, stage, statCache, cmpIndex: scratch('cmp'), addIndex: scratch('add'), isFiltered, isText,
    mutants: deps.testMutants, filters, isCarried: (p) => snapshot.isCarried(p),
  });
  const holds = new HoldRegistry({ repo, ref: refs.holds, random: ports.random, clock, peer: peerId, trace: deps.trace, log: deps.log });
  await holds.load();
  const mode = await Writer.probeMode(fs, tmpDir, paths.workTree);
  const live = (p: string): boolean => {
    try {
      return currentScope(int, p).cls === 'LIVE';
    } catch {
      return false;
    }
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
    onPhantom: async (path, target) => {
      // ENG-34: the PHANTOM PIN (guard 'phantom', DECISION), never published; A[p] stays (no verified write).
      const a = int.aMap?.get(path);
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
  const cs = new ChangeSets(peerId, clock, fs);
  if (view !== null) cs.restore(view.ready, view.meta.cs_human_next);
  const outbox = view === null ? new Outbox() : Outbox.fromJson(view.meta.outbox);

  const built: EngineCore = {
    deps, peerId, repo, refs, state, holds, cs, snapshot, diskEq, writer, fetcher, governor, folder, attrs, stage, statCache,
    view, outbox, filters, config, caps: view?.fold?.caps ?? null,
    lastApplyMono: null, lastPushMono: null, pushAttempts: 0,
    path: (rel: string): string => join(paths.coworkDir, ...rel.split('/')),
    scratch,
    async commit(t: Transition): Promise<StateView> {
      const prev = built.view;
      if (prev === null) throw new Error('engine core: commit before a state exists');
      built.view = await state.commit(prev, t);
      // Final review FC-1: a transition that moves LA_B (an own landing's ok update, a restart's resolution, an apply)
      // moves the checked board with it, so the T of an iteration whose fetch fails or is deferred is never behind LA_B
      // (an ancestor of LA_B would read board_not_ff: a false INCIDENT).
      if (t.laB !== undefined) int.lastCheckedT = t.laB;
      return built.view;
    },
    identity: (): GitIdentity => ({ name: deps.display, email: `${peerId}@cowork.invalid` }),
  };
  core = built;
  internals.set(built, int);
  return built;
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
  int.lastCheckedT = null;
  int.naBlocked = NO_PATHS;
  int.keptApplyIntent = false;
  int.boardOnlyFirstPublish = false;
  core.cs.restore(view.ready, view.meta.cs_human_next);
  core.outbox = Outbox.fromJson(view.meta.outbox);
  core.caps = view.fold?.caps ?? null;
}

/**
 * The join op of this peer's current epoch (glossary §7; PRO-20), as a draft: it rides this peer's first board push of an
 * epoch — after genesis and join, and after a lost-state rebuild or a recover re-anchor, which start a new epoch without
 * the join procedure (final review FC-7: a fold accepts an op of an unrecorded epoch only when it is a join, so without
 * it every later op of the peer is ignored by every fold). It must lead the ops of that push (fold.ts genericOk).
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
function currentScope(int: Internals, p: string): Scope {
  const f = lastScopes.get(int);
  if (f === undefined) throw new Error('no iteration prepared yet');
  return f(p);
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
 * An incoming path this clone cannot materialize (DAT-33 receive side): carried (P2-CARRY: not stageable, carried by
 * the tick or the snapshot), not editable, not creatable on win32 (D7 rules 1–2; rule 3, case, is the carry set's),
 * or beneath a local symlink, junction or file (P2-NOFOLLOW). The apply's W loop and the per-loop re-check of a
 * pending 'unmaterializable' path (P2-NA-TRIGGER) share this one predicate.
 */
export async function unmaterializableHere(core: EngineCore, it: IterationCtx, p: string): Promise<boolean> {
  if (!stageable(p) || it.tick?.carried.has(p) === true || core.snapshot.isCarried(p) || !editable(p)) return true;
  if ((await core.snapshot.tipCollisions(it.tipMap)).has(p)) return true;   // ledger Task 13:234: two spellings in TIP
  if (core.deps.platform === 'win32') {
    const r = portable(p, new Set());
    if (!r.ok && r.rule !== 3) return true;
  }
  return !(await ancestorsSafe(core, p));
}

/** meta.pending reasons of not-applicable paths (R-05, P2-QUARANTINE-IN): they leave the apply trigger while their re-check holds (P2-NA-TRIGGER). */
const NOT_APPLICABLE_REASONS: ReadonlySet<string> = new Set(['collision', 'unmaterializable', 'quarantine']);

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
  if (rows.length === 0) return out;
  await ensureAttrs(core, it.epochBase, rows.map(([p]) => p));
  const lastS = core.snapshot.last()?.sDiskMap;
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
    } else {
      still = await unmaterializableHere(core, it, p);
    }
    if (still) out.add(p);
  }
  return out;
}

/** Paths of non-terminal ON_DISK PHANTOM PINs: written once and never verified; re-applying them is the ping-pong ENG-34 breaks. */
export function phantomPaths(core: EngineCore): ReadonlySet<string> {
  const out = new Set<string>();
  for (const r of core.holds.nonTerminal()) {
    if (r.kind === 'PIN' && r.residence === 'ON_DISK' && !isTerminal(r) && r.guards.some((g) => guardName(g) === 'phantom')) {
      for (const p of r.paths) out.add(p);
    }
  }
  return out;
}

/**
 * ∃ applicable p: A[p] ≠ TIP[p]. Not applicable here: carried paths (P2-CARRY: never written, read or published;
 * listed in not_converged), paths of a PHANTOM PIN and pending not-applicable paths whose re-check of this
 * iteration still holds (P2-NA-TRIGGER: a collision, an unmaterializable or a quarantined path never clears by
 * re-applying it). UNMANAGED differences count: the apply's state update makes their A follow TIP.
 */
export function applicableDifference(core: EngineCore, it: IterationCtx): boolean {
  if (it.A === it.tipMap) return false;
  const phantoms = phantomPaths(core);
  const blocked = inner(core).naBlocked;
  const differs = (p: string): boolean => {
    if (sameEntry(it.A.get(p), it.tipMap.get(p))) return false;
    if (it.tick?.carried.has(p) === true || core.snapshot.isCarried(p) || phantoms.has(p) || blocked.has(p)) return false;
    return true;
  };
  for (const p of it.A.keys()) if (differs(p)) return true;
  for (const p of it.tipMap.keys()) if (!it.A.has(p) && differs(p)) return true;
  return false;
}

/**
 * TickInput.skip (ruling P2-STRANDED-SKIP): the paths whose rollback restore is stranded (writer.strandedPaths(): p is
 * absent while its .old waits at its intent name), united with the Plan 5 fences (none in Plan 2). A skipped path is
 * never lstat'd, read or confirmed as a removal, so its absence never enters the human CS, a ready pair or a publish.
 */
export function tickSkip(core: EngineCore): ReadonlySet<string> {
  const stranded = core.writer.strandedPaths();
  return stranded.length === 0 ? NO_PATHS : new Set(stranded);
}

/**
 * The capture gate (ruling P2-STRANDED-SKIP): a human CS closes and captures only when ChangeSets.closeDue() and no
 * restore is stranded — while one is, closeDue waits (S_disk would claim a p the disk lacks). The one predicate for
 * 'auto' materialize and for the caller that captures (Task 17's iterate calls it instead of cs.closeDue()).
 */
export function captureDue(core: EngineCore): boolean {
  return core.writer.strandedPaths().length === 0 && core.cs.closeDue();
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

/** P2-PIN: the guards whose non-terminal ON_DISK PINs hold a ready pair back (01-engine §3.12 step 1). */
const PIN_GUARDS: ReadonlySet<string> = new Set(['join', 'phantom', 'host-reject']);

/** P2-PIN: paths of non-terminal ON_DISK PINs with guards join, phantom or host-reject (composeP skips every ready pair touching one). */
export function pinnedPaths(core: EngineCore): Set<string> {
  const out = new Set<string>();
  for (const r of core.holds.nonTerminal()) {
    if (r.kind !== 'PIN' || r.residence !== 'ON_DISK' || isTerminal(r)) continue;
    if (!r.guards.some((g) => PIN_GUARDS.has(guardName(g)))) continue;
    for (const p of r.paths) out.add(p);
  }
  return out;
}

/**
 * Allowed pending work for the governor: a ready pair composeP would include (none touching a held PIN, P2-PIN) while
 * code may be pushed, or ops allowed in every active state. A pair P2-PIN skips waits for a human, not for a window.
 */
function allowedPending(core: EngineCore, states: readonly PushState[]): boolean {
  if (core.outbox.pendingAllowed(states)) return true;
  if (states.length !== 0) return false;
  const ready = core.cs.ready();
  if (ready.length === 0) return false;
  const pinned = pinnedPaths(core);
  return ready.some((pair) => !pair.paths.some((p) => pinned.has(p)));
}

/** 01-engine §3.5 steps 1–3: fetch (Fetcher, ls-remote fallback), incident check (entering the incident is the caller's, Task 16), fold + VERSION verdict, detection tick, materialize per the option. Shared by Engine.iterate, startDispatch and tests.
 *  An answered ls-remote fallback with the board ABSENT is a successful fetch and takes the incident branch (board_missing) when a state exists.
 *  A failed fetch (transport: no answer) is NOT a failure branch (§3.5 step 1, ENG-19): the result is ok with it.fetched.ok === false and T/tip/fold of the last
 *  successfully checked board (LA_B when this run has none), so steps 3–5 (tick, capture, apply of pending paths) still run; no publish
 *  in that iteration, and pushState 'offline' once ENG-19's 30 s hold. */
export async function prepareIteration(core: EngineCore, n: number, o: PrepareOptions): Promise<Prepared> {
  const int = inner(core);
  const start = anchorNow(core.deps.ports.clock);
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
  const { aTree, A } = await currentA(core);
  const epochBase = view.meta.EPOCH_BASE;
  int.attrMap = new Map();
  int.attrBase = epochBase;
  await ensureAttrs(core, epochBase, aTree === tipTree ? A.keys() : [...A.keys(), ...tipMap.keys()]);
  const changedTip: Array<{ path: string; oid: Oid }> = [];
  if (aTree !== tipTree) {
    for (const [p, e] of tipMap) if (!sameEntry(A.get(p), e)) changedTip.push({ path: p, oid: e.oid });
  }
  const sizes = await repo.blobSizes(changedTip.map((c) => c.oid));
  const tipSizes = new Map(changedTip.map((c, i) => [c.path, sizes[i] ?? 0] as const));
  const scopeInputs: ScopeInputs = {
    attrs: attrView(int, epochBase), config: core.config, mergeDrivers: int.mergeDrivers, localOnlyPaths: NO_PATHS, hooksPathDir: int.hooksPathDir,
  };
  const scope = scopeFunction(core, scopeInputs, A, tipMap, tipSizes);
  lastScopes.set(int, scope);

  if (fetchFoldOnly) {
    // ENG-15 / LIF-10 / glossary §8: fetch and fold only — the work tree belongs to the human's git command.
    const it: IterationCtx = {
      n, start, fetched, T: board, tip, tipMap, A, fold: outcome.state, version: outcome.version,
      epochBase, scopeInputs, scope, tick: null, mat: null,
      freeze: [...view.meta.freeze_reasons], pushStates, leaseIdleMs: core.deps.lease.idleMs(),
    };
    return { ok: true, it };
  }

  // 3 SNAPSHOT: a detection tick (no object written, glossary §26.1 W6). P2-STRANDED-SKIP: a path whose restore is
  // stranded (after this iteration's sweep) is never looked at: its absence is not a deletion.
  const tickInput: TickInput = { A, aTree, epochBase, scope: scopeInputs, skip: tickSkip(core) };
  const tick = await core.snapshot.tick(tickInput);
  if (tick.failed) return { ok: false, why: 'snapshot_failed' };
  // HLD-35: the human CS opens or extends with the tick's changes on LIVE paths only (Task 11 ruling).
  await ensureAttrs(core, epochBase, tick.changed);
  core.cs.observe([...tick.changed].filter((p) => scope(p).cls === 'LIVE'));

  const it: IterationCtx = {
    n, start, fetched, T: board, tip, tipMap, A, fold: outcome.state, version: outcome.version,
    epochBase, scopeInputs, scope, tick, mat: null,
    freeze: [...view.meta.freeze_reasons], pushStates, leaseIdleMs: core.deps.lease.idleMs(),
  };
  // P2-NA-TRIGGER: re-check the pending not-applicable paths before anything asks the apply trigger.
  int.naBlocked = await notApplicableStill(core, it);
  // 'auto': a ready-pair capture is due, or the apply of this iteration will be admitted (glossary §26.1 W6: objects
  // only for the occasions that need them; a coalesced or frozen apply writes none). Neither while a restore is
  // stranded (P2-NARROW, P2-STRANDED-SKIP).
  const applyAdmitted = it.freeze.length === 0 && it.leaseIdleMs < LEASE_STOP_SYNC_MS && core.writer.strandedPaths().length === 0
    && (core.lastApplyMono === null || core.deps.ports.clock.monoMs() - core.lastApplyMono >= APPLY_COALESCE_MS)
    && applicableDifference(core, it);
  const materialize = o.materialize === true || (o.materialize === 'auto' && (captureDue(core) || applyAdmitted));
  if (materialize) {
    it.mat = await core.snapshot.materialize(tickInput);
    await ensureAttrs(core, epochBase, it.mat.sDiskMap.keys());
  }
  return { ok: true, it };
}
