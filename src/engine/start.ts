// Start dispatch (08-lifecycle Table 3.3-A), genesis with the host probe, join (01-engine §3.14; ENG-51, ENG-52, ENG-59
// join.first_apply; PRO-07, PRO-49, PRO-50; LIF-06…LIF-08 subsets; rulings R-08, R-19, R-21…R-23).
//
//   dispatch  rename probe tmp/ → work tree (EXDEV: START_REPO_SHAPE{reason: tmp_volume}); another branch's cowork refs
//             under a name equal to enc(b) but for case, or a state whose meta names another branch, refuse
//             START_BRANCH_NAME{reason: case_fold, other} (one loose ref directory on a case-insensitive file system);
//             own locks a killed start left removed (final review FC-6); a state ref (usable, unusable,
//             broken, or gone while this core was live) or a moved-aside broken ref a crash left (tmp/broken-state-ref-<e>-<k>)
//             → RESTART (R-23: also with the board absent; its incident check is the loop's); otherwise one fetch: board
//             present → JOIN; board and mirror absent → GENESIS; mirror only → GENESIS_BOARD_MISSING; no branch →
//             START_BRANCH_NOT_ON_REMOTE. Nothing is written before a refusal, and remote content or the network never
//             throws out of it (START_REMOTE{reason}); once genesis or join committed a state, remote content is the
//             loop's incident, never a refusal (refusals write nothing).
//   genesis   HEAD == Hr; the local-work preview (R-22, read-only) decided before any push; budget from
//             host.pushBudgetPerMin at Hr (R-19); the host probe (PRO-49, five governed steps, R-21: counted, no window);
//             then the local work materialized; L0 = tree(Hr) with Cowork-Base, B0 = [join, caps] + protocol.json + the
//             height-0 checkpoint; yieldPoint('start.beforeGenesisPush'); board and mirror in ONE push with ABSENT leases,
//             landed only when both are (by status, else by a fetch); the loser of a simultaneous genesis joins; state
//             [L0, B0], A = tree(L0)
//   join      proto; fold from the nearest checkpoint; Hb = live_base(TIP); HEAD == Hb (R-08: HEAD == Hr ≠ Hb refuses
//             START_HEAD_AHEAD{base_move: unsupported}); A := tree(HEAD) (mutant M05: tree(TIP)); the local-work preview
//             (R-22); state [L_b, T]; the join op queued for the first publish; the first apply, then LA_C := TIP;
//             crashpoint('join.first_apply'); 'all': M one human CS, closed here and captured by Engine.start at once
//             (final review FC-8: through step 4's eol-bom hold and INV-MASK); nothing opted in: the first publish is
//             board-only (ENG-52 step 8, asserted by publishStep)
//
// Fetches and the Fetcher: the dispatch, identity and genesis-classify fetches run through fetchRefs, outside the Fetcher,
// so the run's first Fetcher fetch is always a prepareIteration's (join's first apply, a restart's push-intent
// resolution, or the loop's first iteration) — where PRO-55's restart rule and the governor's first observation are
// applied to it (Fetcher's firstOfRun).
import { join as joinPath } from 'node:path';
import { buildBoardCommit, CODE_SUBJECT, liveCommitTrailers, readBoardCommit, type BoardDraft, type WriterId } from '../board/boardCommit.js';
import type { Json } from '../board/canonicalJson.js';
import { foldCommit, initialFoldState, serializeFold } from '../board/fold.js';
import { newEpoch } from '../board/ids.js';
import { serializeOps, type CapsOp, type JoinOp, type Op, type OpDraft, type TeamCaps } from '../board/ops.js';
import { Outbox } from '../board/outbox.js';
import { genesisProtocol, PROTO } from '../board/protocol.js';
import { canon } from '../data/canon.js';
import { genesisBudget, readTeamConfig } from '../data/config.js';
import type { ScopeInputs } from '../data/scope.js';
import { fetchRefs, lsRemote } from '../git/fetch.js';
import { ABSENT, type Oid, type OidOrAbsent } from '../git/oid.js';
import { pushSpec, type PushOutcomeRaw } from '../git/push.js';
import type { TreeEntry, TreeMap } from '../git/repo.js';
import { crashpoint, KilledAt } from '../ports/crashpoint.js';
import { noTrace, type PushPurpose } from '../ports/trace.js';
import { sanitizeUrl } from '../sec/redact.js';
import { applyStep } from './apply.js';
import {
  attachState, foldPatch, joinDraft, liveCodeOf, observeOwnLanding, pathIsFiltered, pathIsText, prepareIteration, sameEntry,
  setBoardOnlyFirstPublish, tickSkip, type EngineCore,
} from './core.js';
import { isRemoteContentError } from './errors.js';
import { liveBase } from './incident.js';
import { META_V, MetaTooNewError, type Meta } from './meta.js';
import { governedPush, type AttemptClass, type GovernedBody } from './publish.js';
import {
  brokenStateLeftovers, epochNow, headCheck, removeOwnLocks, restart, rootsOf, scopeInputsFor, scopeOfEntry, StartRefused, stateRefState, tickOutside,
  type RestartReport,
} from './restart.js';
import { Snapshotter, type Materialized } from './snapshot.js';
import { StageDir } from './stagedRead.js';
import { LostStateError } from './state.js';
import { StatCache } from './statCache.js';
import { isRegularEntry } from './treeDiff.js';
import { IndexRefusedPathError } from './treeEdit.js';

export type StartMode = 'genesis' | 'join' | 'restart';
export interface StartOptions { publishLocal: 'all' | 'none' | null; }
export type StartRefusal = 'GENESIS_BOARD_MISSING' | 'START_HEAD_BEHIND' | 'START_HEAD_AHEAD' | 'START_HEAD_STATE' | 'START_PREVIEW' | 'START_VERSION'
  | 'START_STATE_NEWER' | 'START_REPO_IDENTITY' | 'START_BRANCH_NOT_ON_REMOTE' | 'START_REFUSED_CUSTOM_REFS' | 'START_REFUSED_NO_LEASE' | 'START_REMOTE' | 'START_REPO_SHAPE'
  | 'START_BRANCH_NAME';
export type StartResult = { ok: true; mode: StartMode; restart: RestartReport | null } | { ok: false; code: StartRefusal; params: Record<string, Json> };

/** The probe's commits (PRO-49): the skip markers of glossary §5 (skip-checks trailer, [skip ci] ***NO_CI*** subject). */
const PROBE_SUBJECT = '[skip ci] ***NO_CI*** cowork probe';
/** PRO-49: a rejection in steps 1, 2 and 5 is the host's refusal only after this many consecutive ones with Q unchanged. */
const PROBE_TRIES = 3;
/** PRO-49 step 4: the push option whose acceptance the probe measures (glossary §5's CI skip). */
const PROBE_PUSH_OPTIONS: readonly string[] = Object.freeze(['ci.skip']);
/** A governed attempt denied by the per-peer cap or the sliding guard (never by a window, R-21) is retried after this Δ. */
const CAP_WAIT_MS = 1_000;
const CAP_WAIT_MAX = 70;
const RENAME_PROBE = 'rename-probe';
/** The rename probe's work-tree names (D6 temp names, never admitted): cowork's own, so a stale one is removed. */
const RENAME_PROBE_RE = /^~cowork-rename-probe(-[0-9]+)?\.tmp$/;
/** A Windows holder (scanner, indexer) on the probe file: EPERM/EBUSY retried this often, this far apart (Clock port). */
const RENAME_RETRIES = 3;
const RENAME_BACKOFF_MS = 100;

/** The remote did not answer a probe re-fetch: start refuses START_REMOTE{reason: unreachable}. */
class ProbeUnreachable extends Error {
  constructor() {
    super('the probe ref could not be re-fetched');
    this.name = 'ProbeUnreachable';
  }
}

const refuse = (code: StartRefusal, params: Record<string, Json> = {}): StartResult => ({ ok: false, code, params });
const short = (o: Oid): string => o.slice(0, 8);

function codeOf(e: unknown): string | undefined {
  const c = typeof e === 'object' && e !== null ? (e as NodeJS.ErrnoException).code : undefined;
  return typeof c === 'string' ? c : undefined;
}

// ---- dispatch -----------------------------------------------------------------------------------------------------

/**
 * 01-engine §1.2 "tmp on another volume" (08-lifecycle START_REPO_SHAPE{reason: tmp_volume}): a file renamed from tmp/
 * into the work-tree root (a D6 temp name, never admitted) and removed again; EXDEV means the writer's renames between
 * the work tree and tmp/ can never succeed (every modify and delete would defer 'locked' forever). Stale probe files of
 * earlier starts are removed first and a free name is always found (leftovers never fail a start); EPERM/EBUSY (a
 * Windows holder) is retried RENAME_RETRIES times RENAME_BACKOFF_MS apart; any other failure is not a volume verdict and
 * throws.
 */
async function tmpOnWorkTreeVolume(core: EngineCore): Promise<boolean> {
  const { fs, clock } = core.deps.ports;
  const root = core.deps.paths.workTree;
  for (const name of await fs.readdir(root)) {
    if (RENAME_PROBE_RE.test(name)) await fs.unlink(joinPath(root, name)).catch(() => undefined);
  }
  let b: string | null = null;
  for (let k = 0; b === null; k++) {
    const n = joinPath(root, k === 0 ? `~cowork-${RENAME_PROBE}.tmp` : `~cowork-${RENAME_PROBE}-${k}.tmp`);
    if ((await fs.lstat(n)) === null) b = n;
  }
  const a = core.path(`tmp/${RENAME_PROBE}.a`);
  await fs.writeFile(a, Buffer.from('cowork rename probe\n', 'utf8'));
  for (let i = 0; ; i++) {
    try {
      await fs.rename(a, b);
      break;
    } catch (e) {
      const c = codeOf(e);
      if ((c === 'EPERM' || c === 'EBUSY') && i < RENAME_RETRIES) {
        await clock.sleep(RENAME_BACKOFF_MS);
        continue;
      }
      await fs.unlink(a).catch(() => undefined);
      if (c === 'EXDEV') return false;
      throw e;
    }
  }
  // A probe file a holder keeps is the next start's leftover (removed first then), never this start's failure.
  await fs.unlink(b).catch(() => core.deps.log.write('warn', 'START_PROBE_FILE_KEPT', { file: b }));
  return true;
}

/** START_BRANCH_NOT_ON_REMOTE{remote}: the configured remote whose URL is the pinned one (the engine knows only the URL), else null. */
async function remoteName(core: EngineCore): Promise<string | null> {
  for (const { key, value } of await core.repo.configGetRegexp('^remote\\..+\\.url$')) {
    if (value === core.deps.url) return key.slice('remote.'.length, key.length - '.url'.length);
  }
  return null;
}

/** enc(b) back to the branch name (glossary §4: every byte outside [A-Za-z0-9_-] is %XX). */
function decodeEnc(e: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < e.length; i++) {
    const hex = e[i] === '%' ? e.slice(i + 1, i + 3) : '';
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(e.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * 08-lifecycle §1.2 START_BRANCH_NAME{reason: case_fold, other} (final review FC minor): another branch whose cowork refs
 * sit under a name equal to this branch's enc(b) but for case (refs/cowork-local/<e'>/ or refs/cowork-remote/<e'>/). On a
 * case-insensitive file system both branches' loose refs are one directory, so this branch would read, lock and move the
 * other's state; refused on every OS, so a clone behaves the same wherever it is checked out. The other branch's name,
 * or null.
 */
async function caseFoldClash(core: EngineCore): Promise<string | null> {
  const own = core.refs.e;
  const folded = own.toLowerCase();
  for (const ns of ['refs/cowork-local/', 'refs/cowork-remote/']) {
    for (const { ref } of await core.repo.listRefs(ns)) {
      const e = ref.slice(ns.length).split('/')[0] ?? '';
      if (e !== own && e.toLowerCase() === folded) return decodeEnc(e);
    }
  }
  return null;
}

/** Table 3.3-A with the automatic-respawn column (R-23): restart whenever a state ref exists; else genesis, join or a refusal. */
export async function startDispatch(core: EngineCore, opts: StartOptions): Promise<StartResult> {
  const { deps } = core;
  if (!(await tmpOnWorkTreeVolume(core))) return refuse('START_REPO_SHAPE', { reason: 'tmp_volume' });
  // Before anything under refs/cowork-local/<e>/ is read, locked or removed: on a case-insensitive file system that
  // directory may be another branch's (final review FC minor).
  const clash = await caseFoldClash(core);
  if (clash !== null) return refuse('START_BRANCH_NAME', { reason: 'case_fold', other: clash });
  // Final review FC-6: own locks a killed earlier start left (P2-OWNLOCKS; daemon.lock is held) go before the state read
  // and before any fetch — the identity fetch, genesis's and join's — or every start after a killed first one refuses or
  // crashes on them (no state exists, so the restart's own cleanup never runs).
  await removeOwnLocks(core);

  // A state ref: present (usable or not), broken, or gone while this core was live (lost state, never a re-join).
  let present = false;
  let pinned: string[] | null = null;
  try {
    const v = await core.state.read();
    if (v !== null) {
      // The state read belongs to this branch (meta.branch, final review FC minor): never attach another branch's.
      if (v.meta.branch !== deps.branch) return refuse('START_BRANCH_NAME', { reason: 'case_fold', other: v.meta.branch });
      present = true;
      pinned = v.meta.pinned.identity;
    }
  } catch (e) {
    if (e instanceof MetaTooNewError) return refuse('START_STATE_NEWER', { meta_v: e.metaV, own_v: META_V });
    if (!(e instanceof LostStateError)) throw e;
    present = true;
  }
  // A moved-aside broken state ref (tmp/broken-state-ref-<e>-<k>) left by a crash before the new state existed means a state
  // existed: present but unreadable, the lost-state rebuild (Task 15 ruling, R-23), never JOIN or START_PREVIEW.
  if (!present && (core.view !== null || (await stateRefState(core)) === 'broken' || (await brokenStateLeftovers(core)).length > 0)) present = true;
  const fetched = async (): Promise<{ ok: boolean; answered: boolean; board: OidOrAbsent; mirror: OidOrAbsent; branch: OidOrAbsent }> => {
    const f = await fetchRefs(core.repo, deps.url, core.refs.fetchSpecs);
    const at = (ref: string): OidOrAbsent => f.values.get(ref) ?? ABSENT;
    return { ok: f.ok, answered: f.remoteAnswered, board: at(core.refs.remoteBoard), mirror: at(core.refs.remoteCode), branch: at(core.refs.remoteBranch) };
  };
  if (present) {
    if (pinned !== null) {
      // 08-lifecycle §3.3 step 2.8: the pinned repo identity, checked when the remote answers (a respawn never refuses offline).
      const f = await fetched();
      if (f.ok && f.branch !== ABSENT) {
        const roots = await rootsOf(core.repo, f.branch);
        const want = [...pinned].sort();
        if (roots.length !== want.length || roots.some((r, i) => r !== want[i])) return refuse('START_REPO_IDENTITY');
      }
    }
    try {
      return { ok: true, mode: 'restart', restart: await restart(core) };
    } catch (e) {
      if (e instanceof StartRefused) return refuse(e.code, e.params);
      // Remote content typed at its source (BoardMalformedError, RemoteContentError) never escapes a start; a plain
      // Error is a local failure and is thrown as it is.
      if (isRemoteContentError(e)) return refuse('START_REMOTE', { reason: 'board_malformed' });
      throw e;
    }
  }

  const f = await fetched();
  // P2-FETCHLOCAL: the remote answered but a local ref update failed (e.g. a stale refs/cowork-remote lock) is not OFFLINE.
  if (!f.ok) return refuse('START_REMOTE', { reason: f.answered ? 'local_ref_update' : 'unreachable' });
  if (f.board === ABSENT) {
    if (f.mirror !== ABSENT) return refuse('GENESIS_BOARD_MISSING', { branch: deps.branch });
    if (f.branch === ABSENT) return refuse('START_BRANCH_NOT_ON_REMOTE', { remote: await remoteName(core), branch: deps.branch });
  }
  try {
    return f.board === ABSENT ? await genesis(core, f.branch as Oid, opts) : await join(core, f.board, f.branch, opts);
  } catch (e) {
    // Remote content typed at its source (a lost genesis race joining a malformed board, a board that changed under the
    // join's reads). A plain Error is a local failure and is thrown as it is.
    if (!isRemoteContentError(e)) throw e;
    // Task 15 ruling: refusals write nothing, so once genesis or join committed a state, remote content met after it is
    // no START_REMOTE refusal: the start is done and the loop's incident path takes over (its prepareIteration maps
    // the same content to an incident). Before any state is written the refusal stays.
    const mode = committed.get(core);
    if (mode !== undefined && core.view !== null) {
      deps.log.write('warn', 'START_REMOTE_AFTER_STATE', { mode, error: e.name });
      return { ok: true, mode, restart: null };
    }
    return refuse('START_REMOTE', { reason: 'board_malformed' });
  }
}

/** The start mode whose state genesis or join committed on this core (the ruling above: no refusal after it). */
const committed = new WeakMap<EngineCore, Exclude<StartMode, 'restart'>>();

// ---- HEAD and local work ------------------------------------------------------------------------------------------

/** LIF-07's HEAD state (restart.ts headCheck): the HEAD commit, or the START_HEAD_STATE refusal. */
async function headState(core: EngineCore): Promise<Oid | StartResult> {
  const h = await headCheck(core);
  return h.ok ? h.head : refuse('START_HEAD_STATE', { op: h.op });
}

/** R-22's counts: M (the LIVE paths of local work), N = diff(A, TIP), and the paths present but not shared. */
interface Preview { M: string[]; nIn: number; unshared: number; }

interface LocalWork extends Preview {
  A: TreeMap; aTree: Oid; mat: Materialized | null;
  /** M paths the tick could not settle (deletion pending: absent; others: unread). */
  unsettled: ReadonlyMap<string, 'absent' | 'unread'>;
}

/** N = diff(A, TIP): the paths an incoming apply would change. */
function incoming(A: TreeMap, tipMap: TreeMap): number {
  let n = 0;
  for (const [p, e] of tipMap) if (!sameEntry(A.get(p), e)) n++;
  for (const p of A.keys()) if (!tipMap.has(p)) n++;
  return n;
}

/** M, the unsettled LIVE paths and the unshared count from a tick and the changed paths (LIVE: tracked by D5, new paths admitted by D6). */
function classifyLocal(core: EngineCore, A: TreeMap, scope: ScopeInputs, changed: ReadonlySet<string>, excluded: ReadonlyMap<string, string>, notAdmitted: number): { M: string[]; unsettled: Map<string, 'absent' | 'unread'>; unshared: number } {
  const live = (p: string): boolean => {
    const e = A.get(p);
    if (e === undefined) return true;
    try {
      return scopeOfEntry(core, scope, p, e.mode).cls === 'LIVE';
    } catch {
      return false;
    }
  };
  const unsettled = new Map<string, 'absent' | 'unread'>();
  for (const [p, why] of excluded) if (!changed.has(p)) unsettled.set(p, why === 'deletion_pending' ? 'absent' : 'unread');
  const M = [...new Set([...changed, ...unsettled.keys()])].filter((p) => live(p)).sort();
  const unshared = notAdmitted + [...changed].filter((p) => !live(p)).length;
  return { M, unsettled: new Map([...unsettled].filter(([p]) => M.includes(p))), unshared };
}

/**
 * Final review FB-6: the preview, or START_REPO_SHAPE{reason: path_not_indexable} (nothing written) when git cannot
 * index A — a root drive-prefix name (`a:b.txt`) on Windows, IndexRefusedPathError — instead of a GitCommandError that
 * the daemon would respawn on forever.
 */
async function previewOrRefuse(core: EngineCore, aTree: Oid, epochBase: Oid, tipMap: TreeMap): Promise<Preview | StartResult> {
  try {
    return await previewLocalWork(core, aTree, epochBase, tipMap);
  } catch (e) {
    if (e instanceof IndexRefusedPathError) return refuse('START_REPO_SHAPE', { reason: 'path_not_indexable' });
    throw e;
  }
}

/**
 * R-22's preview, read-only (no git object, no write of the private index, no stage copy left behind): one detection
 * tick of a throwaway Snapshotter whose index is tmp/preview/p.index (read-tree A) with its own stat cache and stage
 * directory, all removed afterwards. A dirty tracked path counts as local work unless its stored form is A's: the tick's
 * id (hash-object without -w) equals A[p], or — an unfiltered text path — canon makes the disk bytes A's, compared in the
 * working-tree form (canon(disk, smudge(A[p])) == smudge(A[p]); `cat-file --filters` writes nothing). New admitted paths
 * and LIVE paths the tick could not settle count too, as in localWork. The authoritative M is localWork's, after it.
 */
async function previewLocalWork(core: EngineCore, aTree: Oid, epochBase: Oid, tipMap: TreeMap): Promise<Preview> {
  const { repo, deps } = core;
  const fs = deps.ports.fs;
  const dir = core.path('tmp/preview');
  await fs.rmrf(dir);
  await fs.mkdirp(joinPath(dir, 'stage'), 0o700);
  try {
    const stage = new StageDir(fs, joinPath(dir, 'stage'));
    const snap = new Snapshotter({
      repo, fs, clock: deps.ports.clock, trace: noTrace, peer: core.peerId, privateIndex: joinPath(dir, 'p.index'),
      scratch: { detect: joinPath(dir, 'detect.index'), canon: joinPath(dir, 'canon.index') }, stage, statCache: new StatCache(),
      attribution: deps.attribution, filters: core.filters, platform: deps.platform,
    });
    await snap.reseed(aTree);
    const A = await repo.readTreeMap(aTree);
    const scope = await scopeInputsFor(core, epochBase, [...A.keys(), ...tipMap.keys()]);
    const tick = await snap.tick({ A, aTree, epochBase, scope, skip: tickSkip(core) });
    if (tick.failed) throw new Error('start: the snapshot of the work tree failed (a refresh or diff-files error)');
    const changed = new Set<string>();
    const compare: Array<{ path: string; ref: TreeEntry }> = [];
    for (const [p, de] of tick.dirty) {
      const a = A.get(p);
      if (de.kind !== 'modify' || a === undefined) {
        changed.add(p);
        continue;
      }
      if (de.id === a.oid && de.mode === a.mode) continue;
      if (de.mode !== a.mode || !isRegularEntry(a) || pathIsFiltered(core, p) || !pathIsText(core, p)) {
        changed.add(p);
        continue;
      }
      compare.push({ path: p, ref: a });
    }
    if (compare.length > 0) {
      const refs = await repo.smudgeBlobs(compare.map(({ path, ref }) => ({ oid: ref.oid, path })));
      for (const [i, { path }] of compare.entries()) {
        let disk: Buffer | null = null;
        try {
          disk = await fs.readFile(stage.abs(path));
        } catch {
          disk = null;
        }
        const ref = refs[i]!;
        const res = disk === null ? null : canon(disk, ref, false);
        if (res === null || !res.ok || !res.out.equals(ref)) changed.add(path);
      }
    }
    const c = classifyLocal(core, A, scope, changed, tick.excluded, tick.notAdmitted.size);
    return { M: c.M, nIn: incoming(A, tipMap), unshared: c.unshared };
  } finally {
    // The cleanup never masks the preview's result (or its own error): a directory a holder keeps is the next
    // preview's leftover (removed first then), logged here.
    try {
      await fs.rmrf(dir);
    } catch (e) {
      if (e instanceof KilledAt) throw e;
      deps.log.write('warn', 'PREVIEW_CLEANUP_FAILED', { dir, code: codeOf(e) ?? 'unknown' });
    }
  }
}

/**
 * 08-lifecycle §3.3.3 / 01-engine §3.14 Join step 4 with A = tree(HEAD): the private index := read-tree A, the stat
 * cache emptied, one detection tick (every tracked path stage-read once) and, when anything differs, a materialize of
 * S_disk; M = the LIVE paths of diff(A, S_disk) (and LIVE paths still unsettled: a pending deletion, an unstable or
 * quiet file count as local work — R-22 holds or publishes all of M); N = diff(A, TIP); unshared = paths present but
 * not shared (not admitted, or a non-LIVE local change). It writes the private index and objects: it runs only after
 * every refusal the preview and the host can still give.
 */
async function localWork(core: EngineCore, aTree: Oid, epochBase: Oid, tipMap: TreeMap): Promise<LocalWork> {
  const repo = core.repo;
  const A = await repo.readTreeMap(aTree);
  await core.snapshot.reseed(aTree);
  const { inp, tick } = await tickOutside(core, A, aTree, epochBase, tipMap.keys());
  if (tick.failed) throw new Error('start: the snapshot of the work tree failed (a refresh or diff-files error)');
  const mat = tick.dirty.size > 0 ? await core.snapshot.materialize(inp) : null;
  const S = mat?.sDiskMap ?? A;
  const changed = new Set<string>();
  for (const [p, e] of S) if (!sameEntry(A.get(p), e)) changed.add(p);
  for (const p of A.keys()) if (!S.has(p)) changed.add(p);
  const excluded = new Map<string, string>([...tick.excluded, ...(mat?.excluded ?? new Map())]);
  const c = classifyLocal(core, A, inp.scope, changed, excluded, tick.notAdmitted.size);
  return { M: c.M, nIn: incoming(A, tipMap), unshared: c.unshared, A, aTree, mat, unsettled: c.unsettled };
}

/** R-22 'none': M held in one ON_DISK PIN with guard `join` (masked; the local registry). */
async function pinLocalWork(core: EngineCore, w: LocalWork): Promise<string> {
  const S = w.mat?.sDiskMap ?? w.A;
  // Path-keyed maps as own properties (Object.fromEntries defines each key): an assignment h0[p] would drop a path named
  // __proto__ (final review FC minor), and the record check would then refuse the PIN.
  const h0: Record<string, Oid | typeof ABSENT> = Object.fromEntries(w.M.map((p) => [p, w.A.get(p)?.oid ?? ABSENT]));
  const h1: Record<string, Oid | typeof ABSENT> = Object.fromEntries(w.M.map((p) => {
    const u = w.unsettled.get(p);
    // Unsettled bytes were not read: a pending deletion holds ABSENT; an unread file holds A's entry (the PIN masks the
    // whole path either way, so nothing of p is published).
    return [p, u === 'absent' ? ABSENT : (S.get(p)?.oid ?? (u === 'unread' ? (w.A.get(p)?.oid ?? ABSENT) : ABSENT))];
  }));
  return core.holds.hold({
    kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths: w.M, blobs: { h0, h1 }, guard: 'join', origin: 'human',
    cs_ids: [], displaced_by: null, local_only: false,
  });
}

/** The cores whose genesis or join closed the local work M for capture (R-22 'all'), until Engine.start takes it. */
const startCaptures = new WeakSet<EngineCore>();

/**
 * Whether this core's start closed M for capture (final review FC-8); true once: Engine.start then captures it at
 * once, through the loop's step 4.
 */
export function takeStartCapture(core: EngineCore): boolean {
  return startCaptures.delete(core);
}

/**
 * R-22 'all': M as one human CS (HLD-35), closed here and captured (HLD-40) by Engine.start right after this start
 * through the loop's step 4 like every capture (final review FC-8): the R-07 eol-bom hold of a canon-refused path,
 * S_pub := MASK(S_disk) with INV-MASK, and the captureDue gate (no capture while a restore is stranded). A direct capture
 * here would journal the raw bytes of a canon-refused path unmasked; a capture left to the first iteration would add an
 * edit made after the start to M's CS (no quiet period). Whatever Engine.start cannot capture then, the first iteration
 * does; a crash before either re-forms the CS at the restart (R-01).
 */
function captureLocalWork(core: EngineCore, M: readonly string[]): void {
  core.cs.observe(M);
  core.cs.done();
  startCaptures.add(core);
}

function previewRefusal(w: Preview): StartResult {
  return refuse('START_PREVIEW', { n_in: w.nIn, m_out: w.M.length, unshared: w.unshared });
}

/** A_set events of a start: one per path of A, cause 'genesis' or 'join' (the oracle compares them with tree(L0)/tree(HEAD)). */
function emitStartASet(core: EngineCore, A: TreeMap, cause: 'genesis' | 'join'): void {
  for (const [p, e] of [...A].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) core.deps.trace.emit({ kind: 'A_set', peer: core.peerId, path: p, blob: e.oid, cause });
}

// ---- the probe (PRO-49) --------------------------------------------------------------------------------------------

/** A governed push exempt from windows (R-21); a denial by the per-peer cap or the team guard is waited out on the clock. */
async function governedExempt(core: EngineCore, purpose: PushPurpose, body: GovernedBody, classify: (raw: PushOutcomeRaw) => Promise<AttemptClass>, pushOptions?: readonly string[]): Promise<{ raw: PushOutcomeRaw; cls: AttemptClass }> {
  for (let i = 0; ; i++) {
    const r = await governedPush(core, purpose, body, true, 1, classify, pushOptions !== undefined ? { pushOptions } : undefined);
    if (r !== 'denied') return r;
    if (i >= CAP_WAIT_MAX) throw new Error(`start: the ${purpose} push stayed denied by the push cap`);
    await core.deps.ports.clock.sleep(CAP_WAIT_MS);
  }
}

/** PRO-49 steps 1–5 (3 consecutive rejections with Q unchanged = refusal), classified by exit code, porcelain status and a re-fetch of Q, never text. */
export async function runProbe(core: EngineCore, hr: Oid): Promise<TeamCaps> {
  const { repo, deps } = core;
  const q = core.refs.probe(core.peerId);
  const empty = await repo.mktree([]);
  const commit = (parents: readonly Oid[]): Promise<Oid> =>
    repo.commitTree({ tree: empty, parents, subject: PROBE_SUBJECT, trailers: [{ key: 'skip-checks', value: 'true' }] });
  const refetch = async (): Promise<OidOrAbsent> => {
    const r = await lsRemote(repo, deps.url, [q]);
    if (!r.ok) throw new ProbeUnreachable();
    return r.values.get(q) ?? ABSENT;
  };
  /** One governed attempt; its result is Q as re-fetched after it. `goal` is Q's value when the attempt took effect. */
  const attempt = async (body: GovernedBody, goal: OidOrAbsent, pushOptions?: readonly string[]): Promise<{ status: string; q: OidOrAbsent }> => {
    let seen: OidOrAbsent = ABSENT;
    const r = await governedExempt(core, 'probe', body, async () => {
      seen = await refetch();
      const landed = seen === goal;
      return { outcome: landed ? 'landed' : 'ok', transient: false, landed };
    }, pushOptions);
    return { status: r.raw.statuses.get(q) ?? 'none', q: seen };
  };
  const caps: TeamCaps = { custom_refs: false, lease: false, delete: false, push_options: false, two_parent_ok: false };

  // A probe ref an earlier probe left (a crash between its steps 1 and 5) is this peer's own: deleted first with a
  // correct lease (a counted attempt; still the only remote deletion), else step 1's ABSENT lease could never succeed.
  let cur: OidOrAbsent = await refetch();
  for (let i = 0; i < PROBE_TRIES && cur !== ABSENT; i++) {
    cur = (await attempt({ deleteProbe: { ref: q, lease: cur } }, ABSENT)).q;
  }

  // 1 Q1 = commit-tree <empty> -p Hr, lease ABSENT.
  const q1 = await commit([hr]);
  for (let i = 0; i < PROBE_TRIES && !caps.custom_refs; i++) {
    cur = (await attempt({ specs: [pushSpec(q1, q, ABSENT)] }, q1)).q;
    caps.custom_refs = cur === q1;
  }
  if (!caps.custom_refs) return caps;

  // 2 Q2 = commit-tree <empty> -p Q1 -p Hr, lease Q:Q1.
  const q2 = await commit([q1, hr]);
  for (let i = 0; i < PROBE_TRIES; i++) {
    cur = (await attempt({ specs: [pushSpec(q2, q, q1)] }, q2)).q;
    if (cur !== q1) break;   // landed, or Q moved: a rejection counts only with Q unchanged
  }
  caps.two_parent_ok = cur === q2;

  // 3 a wrong lease must be rejected with Q unchanged.
  const before = cur;
  const x = caps.two_parent_ok ? q1 : hr;
  const q3 = await commit([q1]);
  const s3 = await attempt({ specs: [pushSpec(q3, q, x)] }, q3);
  cur = s3.q;
  caps.lease = s3.status !== 'ok' && cur === before;

  // 4 push options: -o ci.skip with a correct lease, through governedPush's pushOptions (core.caps is never touched).
  if (cur !== ABSENT) {
    const q4 = await commit([cur]);
    cur = (await attempt({ specs: [pushSpec(q4, q, cur)] }, q4, PROBE_PUSH_OPTIONS)).q;
    caps.push_options = cur === q4;
  }

  // 5 delete Q with a correct lease: the only remote deletion (INV-OID). An already absent Q is gone (Task 7 minor).
  for (let i = 0; i < PROBE_TRIES && !caps.delete; i++) {
    if (cur === ABSENT) {
      caps.delete = true;
      break;
    }
    cur = (await attempt({ deleteProbe: { ref: q, lease: cur } }, ABSENT)).q;
    caps.delete = cur === ABSENT;
  }
  deps.log.write('info', 'HOST_PROBE', { custom_refs: caps.custom_refs, lease: caps.lease, delete: caps.delete, push_options: caps.push_options, two_parent_ok: caps.two_parent_ok });
  return caps;
}

// ---- genesis (ENG-51) ---------------------------------------------------------------------------------------------

/** ENG-51 (+ R-22 local work); yieldPoint('start.beforeGenesisPush'). */
export async function genesis(core: EngineCore, hr: Oid, opts: StartOptions): Promise<StartResult> {
  const { repo, deps } = core;
  const head = await headState(core);
  if (typeof head !== 'string') return head;
  if (head !== hr) {
    return (await repo.isAncestor(head, hr)) ? refuse('START_HEAD_BEHIND', { head8: short(head), base8: short(hr) }) : refuse('START_HEAD_AHEAD', { c8: short(head) });
  }
  const hrTree = (await repo.readCommit(hr)).tree;
  const hrMap = await repo.readTreeMap(hrTree);
  // R-22, read-only: decided before any push and before anything is written.
  const preview = await previewOrRefuse(core, hrTree, hr, hrMap);
  if ('ok' in preview) return preview;   // FB-6: A cannot be indexed here
  if (preview.M.length > 0 && opts.publishLocal === null) return previewRefusal(preview);

  // protocol.json from the config at Hr, read here and never again (R-19); the governor runs on it from the probe on.
  const protocol = genesisProtocol(genesisBudget((await readTeamConfig(repo, hr)).config), deps.regionSpec);
  core.governor.setParams(protocol);
  let caps: TeamCaps;
  try {
    caps = await runProbe(core, hr);
  } catch (e) {
    if (e instanceof ProbeUnreachable) return refuse('START_REMOTE', { reason: 'unreachable' });
    throw e;
  }
  if (!caps.custom_refs) return refuse('START_REFUSED_CUSTOM_REFS');
  if (!caps.lease) return refuse('START_REFUSED_NO_LEASE', { namespace: deps.namespace.remotePrefix });

  // The local work, materialized (private index, S_disk objects) only now that no host refusal can follow.
  const work = await localWork(core, hrTree, hr, hrMap);
  if (work.M.length > 0 && opts.publishLocal === null) return previewRefusal(work);   // the authoritative M (S_disk)
  core.caps = caps;

  // L0 and B0 (PRO-07): ops [join, caps] with seqs 1 and 2, writer seq 3.
  const epoch = newEpoch(deps.ports.random);
  const writer: WriterId = { peer: core.peerId, epoch, seq: 3 };
  const L0 = await repo.commitTree({ tree: hrTree, parents: [], subject: CODE_SUBJECT, trailers: liveCommitTrailers(writer, [], [], new Map(), hr) });
  const joinOp: JoinOp = { id: `${core.peerId}/${epoch}/1`, ...(await joinDraft(core)) };
  const capsOp: CapsOp = { id: `${core.peerId}/${epoch}/2`, type: 'caps', ...caps };
  const ops: Op[] = [joinOp, capsOp];
  const draft: BoardDraft = {
    liveCode: L0, writer, cs: [], protocol, checkpoint: null, heldIds: [],
    opsLines: serializeOps(ops).toString('utf8').split('\n').filter((l) => l.length > 0),
  };
  const s0 = foldCommit(initialFoldState(protocol), draft, core.peerId).state;
  const B0 = await buildBoardCommit(repo, { prevBoard: null, liveCode: L0, writer, ops, cs: [], csPaths: new Map(), protocol, checkpoint: serializeFold(s0) });
  await deps.ports.scheduler.yieldPoint('start.beforeGenesisPush');

  // Board and mirror in ONE push with ABSENT leases (R-21: counted, no window). Landed only when BOTH refs hold the new
  // commits: by their porcelain statuses, else by a fetch outside the Fetcher (another board there: the race was lost).
  // An outcome nobody observed (no status, no answer to the fetch) is no verdict: START_REMOTE{unreachable}, and the
  // next start decides by observation (the board there: a JOIN; none: genesis again).
  let observed = false;
  let observedBoard: OidOrAbsent = ABSENT;
  let observedMirror: OidOrAbsent = ABSENT;
  const specs = [pushSpec(B0, core.refs.remoteBoard, ABSENT), pushSpec(L0, core.refs.remoteCode, ABSENT)];
  await governedExempt(core, 'genesis', { specs }, async (raw) => {
    if (raw.statuses.get(core.refs.remoteBoard) === 'ok' && raw.statuses.get(core.refs.remoteCode) === 'ok') {
      observed = true;
      observedBoard = B0;
      observedMirror = L0;
      return { outcome: 'landed', transient: false, landed: true };
    }
    const f = await fetchRefs(repo, deps.url, core.refs.fetchSpecs);
    if (!f.ok) return { outcome: 'network', transient: false, landed: false };
    observed = true;
    observedBoard = f.values.get(core.refs.remoteBoard) ?? ABSENT;
    observedMirror = f.values.get(core.refs.remoteCode) ?? ABSENT;
    const landed = observedBoard === B0 && observedMirror === L0;
    return { outcome: landed ? 'landed' : 'lease_lost', transient: false, landed };
  });
  if (!observed) {
    deps.log.write('warn', 'GENESIS_PUSH_UNOBSERVED', {});
    return refuse('START_REMOTE', { reason: 'unreachable' });
  }
  if (observedBoard !== B0 || observedMirror !== L0) {
    if (observedBoard !== ABSENT && observedBoard !== B0) {
      // The loser of a simultaneous genesis: JOIN that board (ENG-51); its probe ref is already gone.
      deps.log.write('info', 'GENESIS_LOST_RACE', { board: observedBoard });
      return join(core, observedBoard, hr, opts);
    }
    // A host that applied one ref of the non-atomic push: no genesis (the next start reads GENESIS_BOARD_MISSING with
    // only the mirror there, or joins the board when only the board landed).
    deps.log.write('error', 'GENESIS_PUSH_PARTIAL', { board: observedBoard === B0, mirror: observedMirror === L0 });
    return refuse('START_REMOTE', { reason: 'genesis_push_failed' });
  }
  observeOwnLanding(core, B0, ABSENT);

  // R-22 'none': the PIN before the state, so no state ever exists without it.
  if (work.M.length > 0 && opts.publishLocal === 'none') await pinLocalWork(core, work);
  const ep = await epochNow(repo);
  const meta: Meta = {
    v: 1, proto: 1, peer_id: core.peerId, epoch, seq_next: writer.seq + 1,
    branch: deps.branch, enc: core.refs.e,
    pinned: { url: sanitizeUrl(deps.url), identity: await rootsOf(repo, hr) },
    H_adopt: ep.head, EPOCH_BASE: hr, expected_epoch: ep,
    freeze_reasons: [], config_detail: [], incident: null, nonretryable: null, rejections: null, throttle: core.governor.toMeta(),
    pending: {}, displaced: [],
    fold_board: B0, fold_verified: null, checkpoint_mismatch: false, outbox: new Outbox().toJson(), cs_human_next: 1, incident_next: 1,
  };
  const view = await core.state.create({ laC: L0, laB: B0, base: hrTree, snap: work.mat?.sDisk ?? hrTree, meta, fold: s0 });
  attachState(core, view);
  committed.set(core, 'genesis');
  emitStartASet(core, hrMap, 'genesis');
  if (work.M.length > 0 && opts.publishLocal === 'all') captureLocalWork(core, work.M);
  return { ok: true, mode: 'genesis', restart: null };
}

// ---- join (ENG-52) ------------------------------------------------------------------------------------------------

/** ENG-52; crashpoint('join.first_apply'). Odd remote content refuses START_REMOTE{reason: board_malformed}. */
export async function join(core: EngineCore, T: Oid, hr: OidOrAbsent, opts: StartOptions): Promise<StartResult> {
  const { repo, deps } = core;
  if (hr === ABSENT) return refuse('START_BRANCH_NOT_ON_REMOTE', { remote: await remoteName(core), branch: deps.branch });
  let folded;
  let tip: Oid;
  let tipTree: Oid;
  let tipMap: TreeMap;
  let lb;
  try {
    // 08-lifecycle §3.3 step 2.8: a board of another proto allows zero pushes, not even this peer's join.
    const board = await readBoardCommit(repo, T);
    if (board.protocol.proto !== PROTO) return refuse('START_VERSION', { board_proto: board.protocol.proto, own_proto: PROTO });
    // 1 fold from the nearest checkpoint (≤ 255 replayed, trusted, PRO-29); 2 Hb := live_base(TIP).
    folded = await core.folder.foldTo(T, null, deps.regionSpec);
    ({ tip, tree: tipTree } = await liveCodeOf(core, T, board.liveCode));
    tipMap = await repo.readTreeMap(tipTree);
    lb = await liveBase(repo, tip);
  } catch (e) {
    if (isRemoteContentError(e)) return refuse('START_REMOTE', { reason: 'board_malformed' });   // typed at the source only
    throw e;
  }

  // 3 HEAD == Hb (R-08: no base move in Plan 2).
  const head = await headState(core);
  if (typeof head !== 'string') return head;
  if (head !== lb.base) {
    if (await repo.isAncestor(head, lb.base)) return refuse('START_HEAD_BEHIND', { head8: short(head), base8: short(lb.base) });
    if (head === hr) return refuse('START_HEAD_AHEAD', { c8: short(head), base_move: 'unsupported' });
    return refuse('START_HEAD_AHEAD', { c8: short(head) });
  }

  // 4 A := tree(HEAD) (mutant M05, R-29: A seeded from TIP); 6 (R-22) the preview decided read-only before anything is
  // written; then the private index := read-tree A and one snapshot.
  const headTree = (await repo.readCommit(head)).tree;
  const aTree = deps.testMutants.has('M05') ? tipTree : headTree;
  const preview = await previewOrRefuse(core, aTree, lb.base, tipMap);
  if ('ok' in preview) return preview;   // FB-6: A cannot be indexed here
  if (preview.M.length > 0 && opts.publishLocal === null) return previewRefusal(preview);
  const work = await localWork(core, aTree, lb.base, tipMap);
  if (work.M.length > 0 && opts.publishLocal === null) return previewRefusal(work);   // the authoritative M (S_disk)
  if (work.M.length > 0 && opts.publishLocal === 'none') await pinLocalWork(core, work);

  // 5 state [L_b, T]; EPOCH_BASE := Hb; H_adopt := HEAD; a new epoch; the join op queued for the first publish.
  const ep = await epochNow(repo);
  const outbox = new Outbox();
  outbox.add((await joinDraft(core)) as OpDraft);
  const v = core.folder.verification();
  const meta: Meta = {
    v: 1, proto: 1, peer_id: core.peerId, epoch: newEpoch(deps.ports.random), seq_next: 1,
    branch: deps.branch, enc: core.refs.e,
    pinned: { url: sanitizeUrl(deps.url), identity: await rootsOf(repo, hr) },
    H_adopt: ep.head, EPOCH_BASE: lb.base, expected_epoch: ep,
    freeze_reasons: [], config_detail: [], incident: null, nonretryable: null, rejections: null, throttle: core.governor.toMeta(),
    pending: {}, displaced: [],
    fold_board: T, fold_verified: v.verified, checkpoint_mismatch: v.checkpointMismatch, outbox: outbox.toJson(), cs_human_next: 1, incident_next: 1,
  };
  const view = await core.state.create({ laC: lb.introducedBy, laB: T, base: aTree, snap: work.mat?.sDisk ?? aTree, meta, fold: folded.state });
  attachState(core, view);
  committed.set(core, 'join');
  emitStartASet(core, work.A, 'join');
  // ENG-52 step 8: with nothing opted in (no local work, or 'none'), the first publish is board-only (OUT == tree(TIP)).
  if (work.M.length === 0 || opts.publishLocal !== 'all') setBoardOnlyFirstPublish(core, true);

  // 7 the first apply through the writer; LA_C := TIP only after it.
  const prepared = await prepareIteration(core, 0, { materialize: false, forceFetch: true });
  if (prepared.ok) {
    const it = prepared.it;
    const r = await applyStep(core, it);
    // Nothing applicable to write (A already equals TIP where it may): the first apply still moves LA_C and LA_B.
    const now = core.view!;
    if (!r.ran && r.skipped === 'nothing' && (now.laC !== it.tip || now.laB !== it.T) && it.T !== ABSENT) {
      const fp = foldPatch(core);
      await core.commit({ laC: it.tip, laB: it.T, ...(fp !== null ? { meta: { ...now.meta, ...fp.meta }, fold: fp.fold } : {}) });
    }
  } else {
    deps.log.write('warn', 'JOIN_FIRST_APPLY_DEFERRED', { why: prepared.why });
  }
  crashpoint('join.first_apply');
  // 8 'all': M is one human CS after the first apply (R-22), closed now and captured by the loop's first iteration.
  if (work.M.length > 0 && opts.publishLocal === 'all') captureLocalWork(core, work.M);
  return { ok: true, mode: 'join', restart: null };
}
