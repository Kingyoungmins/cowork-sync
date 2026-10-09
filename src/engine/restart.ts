// Restart (01-engine §3.14 Restart; ENG-53) and the lost-state per-path rebuild (§3.14 Lost state; ENG-54); ruling R-24
// and the Task 15 carry rulings (ENG-53 cleanup scope, writer leftovers, rollback targets from the journal, the tick
// before the many-candidate decisions, push intent first, show-ref --exists for a broken state ref) and the Task 15
// fix-round rulings (the restart marker, P2-REPOLOCKS, P2-OWNLOCKS, kept leftovers renamed to known-path orphans under
// never-reused names (P2-ORPHANNAMES), the lost-state HEAD check, a broken state ref moved aside and put back on any
// failure, remote-content errors typed at their source).
//
//   restart   3 the state ref first, read-only: unusable, broken (show-ref --exists), deleted while live, or absent
//               with a moved-aside broken ref a crash left (tmp/broken-state-ref-<e>-<k>, this branch's own: a state
//               existed; listed fail-closed) → LOST STATE,
//               which needs HEAD symbolic to refs/heads/<b> with no operation in progress (else START_HEAD_STATE{op},
//               nothing written: the rebuild pins expected_epoch and H_adopt from HEAD)
//             tmp/restart-mark (through the Fs port): the one age rule left (tmp/ring-* .old files, RING_KEEP_MS) and the
//               stale packed-refs.lock report compare with ITS mtime (the file system's clock), never with the Clock port
//             2 own leftovers, WITHOUT an age check (P2-OWNLOCKS; precondition: the caller holds the daemon lock, and only
//               this daemon writes them, so a backward clock step never wedges one): every *.lock under
//               refs/cowork-local/<e>/ and refs/cowork-remote/, <e>.index.lock, tmp/*.index and tmp/*.index.lock
//               (P2-SCRATCHLOCK), tmp/*.new and tmp/stage; never .git/index.lock; never packed-refs.lock (P2-REPOLOCKS:
//               repo-wide, any git process holds it): a stale one is logged PACKED_REFS_LOCK_STALE and left
//             lost: a broken ref is moved aside to tmp/broken-state-ref-<e>-<k> (the remote checked by ls-remote first:
//               git fetch dies on a broken local ref), one fetch, the repo identity (the remote branch shares the roots
//               the live state pinned, else a root of HEAD: START_REPO_IDENTITY), the board read (START_REMOTE{unreachable
//               | board_malformed}, GENESIS_BOARD_MISSING without a board), the rebuild; a moved ref is put back on any
//               failure while no state was created (a simulated kill excepted: a dead process does nothing, and its
//               leftover sends the next start here again); every leftover goes once the new state is committed
//             5 a missing or unreadable private index → read-tree <state:snap> (before the tick that needs it)
//               one detection tick (isCarried learns the case collisions before any many-candidate decision)
//             4 apply|local intent: Writer.rollbackIntent with targets from the journal (t/M, or the local entry's
//               target), the leftover .old files through MANY CANDIDATES (a byte nothing places becomes a 'restart'
//               record; an unreadable one is renamed to tmp/orphan-<ulid>.old with a WRITE_TMP_ORPHAN{file, path} line),
//               the per-path decision, the HLD-41 rebase, ONE state update (as ENG-36 would have made it);
//               push intent: a fresh fetch and resolvePushIntent (P2-PUSHINTENT-FIRST); remote content there is the
//               incident prepareIteration reports (the intent stays kept; the loop's incident path takes over), never a
//               start refusal
//               tmp/ leftovers of earlier runs, in name order: a known-path orphan .old (WRITE_TMP_ORPHAN in a daemon
//               log) through MANY CANDIDATES against state:snap, its bytes always recorded while p is absent (they may be
//               the only copy of p); tmp/ring-*.old older than the marker by RING_KEEP_MS deleted; every other .old kept
//               and logged (never deleted blindly); .redo and .new deleted
//             the private index is reseeded from state:snap and the stat cache emptied, so the first iteration
//               stage-reads every tracked path once and re-forms the open human CS from its tick (R-01)
//   lost      reseed from tree(TIP), one tick and materialize, then per path (tree(TIP) ∪ admitted disk paths ∪ stranded
//             restores) by scope class against the distinct versions on TIP's first-parent chain back to the live base
//             (≤ 500 commits), a stranded restore's p read from its .old (final review FD: DISK_EQ form (3), the bytes a
//             later sweep relinks; an .old that gives no bytes — vanished, unreadable, unstable, refused — is decided by
//             the blob P1 verified it held, matched as a read is; never a record holding TIP[p] itself; S_disk[p], snap
//             and a kept apply intent's t/S take that reading);
//             LA_C := TIP, LA_B := T, a new epoch with its join op queued (final review FC-7: the board op, never the join
//             procedure), LOST_STATE{mode, record ids, paths}; never a wholesale seed. A re-anchor keeps a write intent
//             journaled for a stranded restore (P2-STRANDED) and this run's mark on it; a kept apply intent is rewritten
//             onto the new chain (tip, board, t/S, t/TIP; groups and t/M kept), so a restart's ENG-53 resolution of it
//             commits the re-anchor's LA_C, LA_B, snap and A again, never the old chain's (final review FC round 2).
//             No open-CS re-form follows (R-01 is a restart's): every local delta is decided here, a match or a masked
//             'restart' record (ENG-54), and the rebuild's own snapshot already holds the disk
import { isAbsolute, join, relative, sep } from 'node:path';
import { readBoardCommit } from '../board/boardCommit.js';
import type { Json } from '../board/canonicalJson.js';
import type { OpDraft } from '../board/ops.js';
import { Outbox } from '../board/outbox.js';
import { newEpoch } from '../board/ids.js';
import { canon } from '../data/canon.js';
import { readTeamConfig } from '../data/config.js';
import { scopeOfTracked, type Scope, type ScopeInputs } from '../data/scope.js';
import { fetchRefs, lsRemote } from '../git/fetch.js';
import { ABSENT, parseOid, type Absent, type Oid } from '../git/oid.js';
import { GitCommandError, type FileMode, type GitRepo, type IndexEdit, type TreeEntry, type TreeMap } from '../git/repo.js';
import type { DeferReason } from '../holds/groups.js';
import type { RebaseChange } from '../holds/changesets.js';
import { KilledAt } from '../ports/crashpoint.js';
import type { FsLstat } from '../ports/fs.js';
import type { ASetCause } from '../ports/trace.js';
import { sanitizeUrl } from '../sec/redact.js';
import { validPathSyntax } from '../sec/validators.js';
import {
  applyIntentKept, attachState, currentA, ensureAttrs, foldPatch, hooksDir, joinDraft, liveCodeOf, markApplyIntentKept, pathIsFiltered, pathIsText,
  prepareIteration, sameEntry, setCurrentA, tickSkip, type EngineCore,
} from './core.js';
import { isRemoteContentError } from './errors.js';
import { liveBase } from './incident.js';
import type { Meta } from './meta.js';
import { onDiskConflictRecords } from './apply.js';
import { resolvePushIntent } from './publish.js';
import type { TickInput, TickResult } from './snapshot.js';
import { LostStateError, StateCasLostError, type Intent, type JournalTree, type StateView } from './state.js';
import { stageable } from './stagedRead.js';
import { editTreeIndexOnly, IndexRefusedPathError } from './treeEdit.js';
import { LOCAL_INTENT_KEEP, orphanAside, RING_KEEP_MS, type StrandedRestore } from './writer.js';

export const LOST_STATE_MAX_COMMITS = 500;
export interface LostStateReport { mode: 'lost_state' | 're_anchor'; records: string[]; paths: string[]; }
export interface RestartReport { intent: Intent['kind']; rolledBackGroups: number[]; restartRecords: string[]; pushResolved: 'landed' | 'discarded' | null; lostState: LostStateReport | null; }

/** A start refusal decided inside the restart (startDispatch returns it as `{ ok: false, code, params }`). */
export class StartRefused extends Error {
  readonly code: 'START_HEAD_STATE' | 'START_REMOTE' | 'GENESIS_BOARD_MISSING' | 'START_REPO_IDENTITY' | 'START_REPO_SHAPE';
  readonly params: Record<string, Json>;
  constructor(code: StartRefused['code'], params: Record<string, Json>) {
    super(`restart refused: ${code} ${JSON.stringify(params)}`);
    this.name = 'StartRefused';
    this.code = code;
    this.params = params;
  }
}

/** Every exit code a git process can return (a show-ref probe reads them all as outcomes). */
const ANY_CODE: readonly number[] = Object.freeze(Array.from({ length: 256 }, (_, i) => i));
/** The daemon logs (ruling R-37, file names daemon-<n>.jsonl): the only record of an orphan .old's path (WRITE_TMP_ORPHAN). */
const DAEMON_LOG_DIR = 'log';
const DAEMON_LOG_RE = /^daemon-([0-9]+)\.jsonl$/;
/** The restart's own marker: every leftover age is measured against its mtime (one clock domain, deterministic in SIM). */
const RESTART_MARK = 'tmp/restart-mark';
/** P2-REPOLOCKS: a packed-refs.lock at least this old at the marker is reported (never removed). */
const PACKED_REFS_STALE_MS = 30_000;
/** A rolled-back path that is pending again after the restart's decision (01-engine §3.11: re-merged at the next apply). */
const RESTART_PENDING: DeferReason = 'race';
/** 08-lifecycle §3.4.1 / R-09: the operation markers that make a HEAD state unusable for start (START_HEAD_STATE{op}). */
export const OP_MARKERS: readonly string[] = Object.freeze(['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply', 'sequencer']);
/** Glossary §19: the longest list text a LOST_STATE line carries (the systemMessage cap), and one path's placeholder cap. */
const LIST_TEXT_MAX = 1_050;
const PATH_TEXT_MAX = 80;
const ZERO_RE = /^0+$/;

function codeOf(e: unknown): string | undefined {
  const c = typeof e === 'object' && e !== null ? (e as NodeJS.ErrnoException).code : undefined;
  return typeof c === 'string' ? c : undefined;
}

const sameAs = (x: TreeEntry | Absent | null, e: TreeEntry | undefined): boolean =>
  x !== null && (x === ABSENT ? e === undefined : e !== undefined && x.oid === e.oid && x.mode === e.mode);

// ---- shared with start.ts --------------------------------------------------------------------------------------

/**
 * ScopeInputs at `epochBase` outside an iteration (no IterationCtx before a state exists): the attributes of `paths`
 * (one check-attr, also taken into the core's attribute map by ensureAttrs; a path failing validPathSyntax is never
 * asked: D5 makes it UNMANAGED first), the team config at epochBase, the configured merge drivers and the user's hooks
 * directory by core.ts's hooksDir (the loop's own rule, so start, restart and lost-state scope equal the loop's).
 */
export async function scopeInputsFor(core: EngineCore, epochBase: Oid, paths: Iterable<string>): Promise<ScopeInputs> {
  const repo = core.repo;
  const asked = [...new Set(paths)].filter((p) => validPathSyntax(p));
  // Task 13 decision 8: the core's own attribute map learns these paths too, so the writer's and DISK_EQ's
  // isFiltered/isText (pathIsFiltered/pathIsText) answer from EPOCH_BASE instead of failing closed toward route (b).
  await ensureAttrs(core, epochBase, asked);
  const attrs = await core.attrs.snapshot(epochBase, asked);
  const mergeDrivers = new Set<string>();
  for (const { key } of await repo.configGetRegexp('^merge\\..+\\.driver$')) {
    const name = key.slice('merge.'.length, key.length - '.driver'.length);
    if (name.length > 0) mergeDrivers.add(name);
  }
  const hooksPathDir = hooksDir(core.deps.paths.workTree, await repo.configGet('core.hooksPath'));
  const config = (await readTeamConfig(repo, epochBase)).config;
  return { attrs, config, mergeDrivers, localOnlyPaths: new Set(), hooksPathDir };
}

/** D5 of a path with a known entry (a tracked or materialized path), its size from the stat cache. */
export function scopeOfEntry(core: EngineCore, inp: ScopeInputs, p: string, mode: FileMode): Scope {
  return scopeOfTracked(p, mode, core.statCache.get(p)?.stat?.size ?? 0, inp);
}

/** One detection tick outside an iteration (no object written), with the skip set of P2-STRANDED-SKIP. */
export async function tickOutside(core: EngineCore, A: TreeMap, aTree: Oid, epochBase: Oid, extraPaths: Iterable<string> = []): Promise<{ inp: TickInput; tick: TickResult }> {
  const scope = await scopeInputsFor(core, epochBase, [...A.keys(), ...extraPaths]);
  const inp: TickInput = { A, aTree, epochBase, scope, skip: tickSkip(core) };
  return { inp, tick: await core.snapshot.tick(inp) };
}

/** The sorted root commits of `commit` (the repo identity, glossary §18). */
export async function rootsOf(repo: GitRepo, commit: Oid): Promise<string[]> {
  const r = await repo.run(['rev-list', '--max-parents=0', parseOid(commit)]);
  return r.stdout.toString('utf8').split('\n').filter((l) => l.length > 0).map((l) => parseOid(l)).sort();
}

/** The expected epoch of meta (R-09): symbolic HEAD, the HEAD oid and refs/stash. */
export async function epochNow(repo: GitRepo): Promise<{ symref: string; head: Oid; stash: Oid | null }> {
  const head = await repo.resolve('HEAD');
  if (head === null) throw new Error('start: HEAD names no commit');
  const sym = await repo.run(['symbolic-ref', '-q', 'HEAD'], { okCodes: [0, 1] });
  return { symref: sym.code === 0 ? sym.stdout.toString('utf8').trim() : '', head, stash: await repo.readRef('refs/stash') };
}

/**
 * LIF-07's HEAD state (genesis, join and the lost-state rebuild): symbolic to refs/heads/<b> and no operation marker;
 * the HEAD commit, or the op that refuses START_HEAD_STATE{op} ('detached', 'other_branch', a marker name, 'unborn').
 */
export async function headCheck(core: EngineCore): Promise<{ ok: true; head: Oid } | { ok: false; op: string }> {
  const { repo, deps } = core;
  const sym = await repo.run(['symbolic-ref', '-q', 'HEAD'], { okCodes: [0, 1] });
  const symref = sym.code === 0 ? sym.stdout.toString('utf8').trim() : '';
  if (symref !== core.refs.remoteBranch) return { ok: false, op: symref === '' ? 'detached' : 'other_branch' };
  for (const m of OP_MARKERS) {
    if ((await deps.ports.fs.lstat(join(deps.paths.gitDir, m))) !== null) return { ok: false, op: m };
  }
  const head = await repo.resolve('HEAD');
  if (head === null) return { ok: false, op: 'unborn' };
  return { ok: true, head };
}

/** `git show-ref --exists <state ref>` (git ≥ 2.43): exit 0 present, 2 absent, anything else broken (Task 8 carry ruling). */
export async function stateRefState(core: EngineCore): Promise<'present' | 'absent' | 'broken'> {
  const r = await core.repo.run(['show-ref', '--exists', core.refs.state], { okCodes: ANY_CODE });
  return r.code === 0 ? 'present' : r.code === 2 ? 'absent' : 'broken';
}

/**
 * The name prefix of this branch's moved-aside broken state refs, tmp/broken-state-ref-<e>-<k> (the only names
 * freeTmpName gives them). Per branch (final review FC): tmp/ is the clone's, shared by every branch, and one branch's
 * leftover says nothing about another's state (enc(b) is [A-Za-z0-9_%-] only, and <k> is digits after the last '-',
 * so no branch's names match another's).
 */
function brokenAsidePrefix(core: EngineCore): string {
  return `broken-state-ref-${core.refs.e}-`;
}

function isBrokenAside(core: EngineCore, name: string): boolean {
  const prefix = brokenAsidePrefix(core);
  return name.startsWith(prefix) && /^[0-9]+$/.test(name.slice(prefix.length));
}

/**
 * Task 15 ruling (R-23): a leftover tmp/broken-state-ref-<e>-<k> of this branch means its state existed (a crash between
 * the move aside and the new state's commit leaves one and no state ref), so the start treats it as a state present but
 * unreadable: the lost-state rebuild, never a join or START_PREVIEW. Absolute paths, sorted. Fail-closed (final review
 * FC minor): a tmp/ that cannot be listed (anything but ENOENT) throws, never reads as "no leftover", which would let a
 * genesis or join stand in for a state that existed.
 */
export async function brokenStateLeftovers(core: EngineCore): Promise<string[]> {
  const tmp = core.path('tmp');
  let names: string[];
  try {
    names = [...(await core.deps.ports.fs.readdir(tmp))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  } catch (e) {
    if (codeOf(e) === 'ENOENT') return [];
    throw e;
  }
  return names.filter((n) => isBrokenAside(core, n)).map((n) => join(tmp, n));
}

/** Once a state is committed (and only then), the moved-aside broken refs are removed (STATE_REF_BROKEN_LEFTOVER_REMOVED). */
async function removeBrokenStateLeftovers(core: EngineCore): Promise<void> {
  for (const f of await brokenStateLeftovers(core)) {
    if (await unlinkQuiet(core, f, 'broken_state_ref')) core.deps.log.write('info', 'STATE_REF_BROKEN_LEFTOVER_REMOVED', { ref: core.refs.state, file: f });
  }
}

// ---- leftovers ----------------------------------------------------------------------------------------------------

async function lstatQuiet(core: EngineCore, p: string): Promise<FsLstat | null> {
  try {
    return await core.deps.ports.fs.lstat(p);
  } catch {
    return null;
  }
}

/** A file (never a directory) whose mtime is older than `mark` (ns, the restart marker's clock): the ring window only. */
async function olderFile(core: EngineCore, p: string, mark: bigint): Promise<boolean> {
  const st = await lstatQuiet(core, p);
  return st !== null && !st.isDirectory && st.mtimeNs < mark;
}

async function unlinkQuiet(core: EngineCore, p: string, what: string): Promise<boolean> {
  try {
    await core.deps.ports.fs.unlink(p);
    return true;
  } catch (e) {
    const c = codeOf(e);
    if (c === 'ENOENT' || c === 'ENOTDIR') return true;
    core.deps.log.write('warn', 'RESTART_LEFTOVER_KEPT', { what, code: c ?? 'unknown' });
    return false;
  }
}

async function readdirQuiet(core: EngineCore, dir: string): Promise<string[]> {
  try {
    return [...(await core.deps.ports.fs.readdir(dir))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  } catch {
    return [];
  }
}

/** Every `*.lock` file under dir (recursively). */
async function lockFilesUnder(core: EngineCore, dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await readdirQuiet(core, dir)) {
    const p = join(dir, name);
    const st = await lstatQuiet(core, p);
    if (st === null || st.isSymbolicLink) continue;
    if (st.isDirectory) out.push(...(await lockFilesUnder(core, p)));
    else if (name.endsWith('.lock')) out.push(p);
  }
  return out;
}

/**
 * tmp/restart-mark, written through the Fs port at the restart's start: its mtime is the "now" every leftover age is
 * compared with (file-system time against file-system time; a Clock port far off, a backward clock step or SIM time
 * change nothing).
 */
async function restartMark(core: EngineCore): Promise<bigint> {
  const f = core.path(RESTART_MARK);
  await core.deps.ports.fs.writeFile(f, Buffer.from('cowork restart\n', 'utf8'));
  const st = await core.deps.ports.fs.lstat(f);
  if (st === null) throw new Error('restart: the restart marker vanished');
  return st.mtimeNs;
}

/**
 * The lock and scratch-index half of ENG-53 step 2 (P2-OWNLOCKS, P2-SCRATCHLOCK), with no restart marker and no age check:
 * every lock under refs/cowork-local/<e>/ and refs/cowork-remote/, <e>.index.lock, tmp/*.index and tmp/*.index.lock.
 * Final review FC-6: startDispatch runs it first, before the state read, the identity fetch and any genesis or join
 * fetch — a killed first start leaves no state, so the restart's cleanup never runs and a stale own lock would refuse
 * (START_REMOTE{local_ref_update}) or crash (read-tree 'File exists') every later start. Precondition (P2-OWNLOCKS): the
 * caller holds daemon.lock (Engine.start asserts it), so no process of this clone's cowork writes them meanwhile. Never
 * .git/index.lock, never packed-refs.lock (P2-REPOLOCKS).
 */
export async function removeOwnLocks(core: EngineCore): Promise<void> {
  const { gitDir, coworkDir } = core.deps.paths;
  const e = core.refs.e;
  const files = [
    ...(await lockFilesUnder(core, join(gitDir, 'refs', 'cowork-local', e))),
    ...(await lockFilesUnder(core, join(gitDir, 'refs', 'cowork-remote'))),
    join(coworkDir, `${e}.index.lock`),
  ];
  const tmp = join(coworkDir, 'tmp');
  for (const name of await readdirQuiet(core, tmp)) {
    if (name.endsWith('.index') || name.endsWith('.index.lock')) files.push(join(tmp, name));
  }
  for (const f of files) {
    const st = await lstatQuiet(core, f);
    if (st !== null && !st.isDirectory) await unlinkQuiet(core, f, 'own_leftover');
  }
}

/**
 * ENG-53 step 2, own leftovers only, removed WITHOUT an age check (P2-OWNLOCKS: the caller holds the daemon lock and only
 * this daemon writes them, so one stamped after the marker — a backward clock step, a skewed peer — is as stale as any):
 * every lock under the own namespaces refs/cowork-local/<e>/ and refs/cowork-remote/ (a power loss inside update-ref or
 * fetch), <e>.index.lock, the scratch indexes and their locks (P2-SCRATCHLOCK), every tmp/*.new and the stage copies.
 * Never .git/index.lock. P2-REPOLOCKS: packed-refs.lock is repo-wide (any git process holds it) and never removed; one at
 * least 30 s older than the marker is logged PACKED_REFS_LOCK_STALE{age_s} once (git's own refusal tells the human the
 * way out). .old and .redo files are the rollback's and the later leftover step's.
 */
async function removeOwnLeftovers(core: EngineCore, mark: bigint): Promise<void> {
  const { gitDir, coworkDir } = core.deps.paths;
  await removeOwnLocks(core);
  const tmp = join(coworkDir, 'tmp');
  for (const name of await readdirQuiet(core, tmp)) {
    if (!name.endsWith('.new')) continue;
    const f = join(tmp, name);
    const st = await lstatQuiet(core, f);
    if (st !== null && !st.isDirectory) await unlinkQuiet(core, f, 'own_leftover');
  }
  const packed = await lstatQuiet(core, join(gitDir, 'packed-refs.lock'));
  if (packed !== null && !packed.isDirectory) {
    const ageMs = Number((mark - packed.mtimeNs) / 1_000_000n);
    if (ageMs >= PACKED_REFS_STALE_MS) core.deps.log.write('warn', 'PACKED_REFS_LOCK_STALE', { age_s: Math.floor(ageMs / 1_000) });
  }
  await core.stage.clear();
}

/** A file under <coworkDir> as a '/'-separated path relative to it ('tmp/orphan-1.old'), or null outside it. */
function coworkRelative(core: EngineCore, file: string): string | null {
  const dir = core.deps.paths.coworkDir;
  const rel = isAbsolute(file) ? relative(dir, file) : file;
  const norm = rel.split(sep).join('/');
  if (norm.length === 0 || norm.startsWith('../') || norm === '..' || isAbsolute(norm)) return null;
  return norm;
}

/**
 * The paths the daemon logs name for orphan files (WRITE_TMP_ORPHAN{file, path|null} lines, P2-ORPHANS,
 * P2-ORPHANNAMES), from every <coworkDir>/log/daemon-<n>.jsonl in numeric order (daemon-2 before daemon-10), keyed by
 * the file's path relative to <coworkDir>: the writer and the restart log absolute names, so the keys of one clone's own
 * logs agree with the tmp/ names it reads (a line written before the clone moved names a file outside the cowork dir
 * and is ignored: such an orphan is unknown and kept). Within one log the latest line for a file wins, a null path
 * included (the file becomes unknown); two logs that disagree about a file (two paths, or a path and null) make it
 * unknown. Only the files with a known path are returned; every other orphan is kept, never deleted blindly.
 */
async function orphanPaths(core: EngineCore): Promise<Map<string, string>> {
  const all = new Map<string, string | null>();
  const ambiguous = new Set<string>();
  const dir = core.path(DAEMON_LOG_DIR);
  const logs = (await readdirQuiet(core, dir))
    .map((n) => ({ n, m: DAEMON_LOG_RE.exec(n) }))
    .filter((x): x is { n: string; m: RegExpExecArray } => x.m !== null)
    .map(({ n, m }) => ({ n, k: Number(m[1]) }))
    .sort((a, b) => (a.k !== b.k ? a.k - b.k : a.n < b.n ? -1 : a.n > b.n ? 1 : 0))
    .map(({ n }) => n);
  for (const name of logs) {
    let text: string;
    try {
      text = (await core.deps.ports.fs.readFile(join(dir, name))).toString('utf8');
    } catch {
      continue;
    }
    const mine = new Map<string, string | null>();
    for (const line of text.split('\n')) {
      if (!line.includes('WRITE_TMP_ORPHAN')) continue;
      try {
        const o = JSON.parse(line) as { code?: unknown; params?: { file?: unknown; path?: unknown } };
        if (o.code !== 'WRITE_TMP_ORPHAN' || typeof o.params?.file !== 'string') continue;
        const key = coworkRelative(core, o.params.file);
        // The latest line wins, a path that is no string (null: the writer knew none) included.
        if (key !== null) mine.set(key, typeof o.params.path === 'string' ? o.params.path : null);
      } catch {
        // a torn line names nothing
      }
    }
    for (const [k, p] of mine) {
      if (all.has(k) && all.get(k) !== p) ambiguous.add(k);
      all.set(k, p);
    }
  }
  const out = new Map<string, string>();
  for (const [k, p] of all) if (p !== null && !ambiguous.has(k)) out.set(k, p);
  return out;
}

/** A free tmp/<prefix><k><ext> name (k from 0): the moved-aside broken state ref's (never an orphan's, P2-ORPHANNAMES). */
async function freeTmpName(core: EngineCore, prefix: string, ext: string): Promise<string> {
  for (let k = 0; ; k++) {
    const f = core.path(`tmp/${prefix}${k}${ext}`);
    if ((await lstatQuiet(core, f)) === null) return f;
  }
}

/**
 * Finding 4 (binding "never deleted blindly"): a leftover .old the restart cannot decide now (unreadable) is renamed to a
 * known-path orphan tmp/orphan-<ulid>.old (a never-reused name from the Random port, P2-ORPHANNAMES: the writer's
 * orphanAside) and logged WRITE_TMP_ORPHAN{file, path}, so the next restart's known-path branch decides it by MANY
 * CANDIDATES; a failure while drawing the name (its lstat) or renaming leaves it where it is (logged). The name it ends
 * up at.
 */
async function keepAsOrphan(core: EngineCore, file: string, path: string, why: string): Promise<string> {
  const { fs, random, clock } = core.deps.ports;
  let aside: string;
  try {
    aside = await orphanAside(fs, random, clock, core.path('tmp'), 'old');
    await fs.rename(file, aside);
  } catch (e) {
    if (e instanceof KilledAt) throw e;
    core.deps.log.write('warn', 'RESTART_OLD_KEPT', { path, read: why, code: codeOf(e) ?? 'unknown' });
    return file;
  }
  core.deps.log.write('warn', 'WRITE_TMP_ORPHAN', { file: aside, path, kept: true });
  return aside;
}

// ---- records ------------------------------------------------------------------------------------------------------

/** A 'restart' PATCH holding bytes nothing placed (ON_DISK, masked; local_only for a non-LIVE path). */
async function restartRecord(core: EngineCore, path: string, base: TreeEntry | undefined, held: Oid | Absent, live: boolean): Promise<string> {
  return core.holds.hold({
    kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: [path],
    blobs: { h0: { [path]: base?.oid ?? ABSENT }, h1: { [path]: held } },
    guard: 'restart', origin: 'daemon', cs_ids: [], displaced_by: null, local_only: !live,
  });
}

// ---- restart ------------------------------------------------------------------------------------------------------

/**
 * ENG-53: the state read first (a lost state needs the symbolic branch HEAD, else StartRefused START_HEAD_STATE with
 * nothing written), the restart marker, own leftovers, the lost-state path (StartRefused START_REMOTE / GENESIS_BOARD_MISSING
 * for an unreachable remote or odd remote content), intent resolution with the HLD-41 rebase in ONE state update, private
 * index reseed when missing, tmp/ leftovers of earlier runs.
 */
export async function restart(core: EngineCore): Promise<RestartReport> {
  const report: RestartReport = { intent: 'none', rolledBackGroups: [], restartRecords: [], pushResolved: null, lostState: null };

  // 3 the state ref, read-only first: unusable or broken, or gone while this core was live → lost state (never a re-join).
  let view: StateView | null = null;
  let lost = false;
  try {
    view = await core.state.read();
  } catch (e) {
    if (!(e instanceof LostStateError)) throw e;   // MetaTooNewError: the start refuses (START_STATE_NEWER)
    lost = true;
  }
  let broken = false;
  if (view === null && !lost) {
    const st = await stateRefState(core);
    // A moved-aside broken ref left by a crash before the new state existed is a state that existed (Task 15 ruling).
    if (core.view === null && st === 'absent' && (await brokenStateLeftovers(core)).length === 0) {
      throw new Error('restart: no state ref (the start dispatches GENESIS or JOIN)');
    }
    broken = st === 'broken';
    lost = true;
  }
  if (lost) {
    // The rebuild pins expected_epoch and H_adopt from HEAD: only the symbolic branch with no operation in progress.
    const h = await headCheck(core);
    if (!h.ok) throw new StartRefused('START_HEAD_STATE', { op: h.op });
  }

  const mark = await restartMark(core);
  try {
    await removeOwnLeftovers(core, mark);
    if (lost) {
      report.lostState = await rebuildLostState(core, broken);
      report.restartRecords = [...report.lostState.records];
      return report;
    }
    const v = view as StateView;
    attachState(core, v);
    report.intent = v.intent.kind;
    // A moved-aside broken ref next to a usable state: a crash after the new state's commit, before its removal.
    await removeBrokenStateLeftovers(core);

    // 5, before the tick that needs it: a missing or unreadable private index → read-tree <state:snap>.
    const privateIndex = join(core.deps.paths.coworkDir, `${core.refs.e}.index`);
    let indexOk = (await lstatQuiet(core, privateIndex)) !== null;
    if (indexOk) {
      try {
        await core.repo.listIndex(privateIndex);
      } catch (e) {
        if (e instanceof KilledAt) throw e;
        indexOk = false;
      }
    }
    if (!indexOk) {
      await unlinkQuiet(core, privateIndex, 'private_index');
      await core.snapshot.reseed(v.snap);
      core.deps.log.write('warn', 'PRIVATE_INDEX_RESEEDED', { snap: v.snap });
    }

    // One tick before any many-candidate decision (P2-CARRY: case collisions are known only after a tick).
    const { aTree, A } = await currentA(core);
    const { tick } = await tickOutside(core, A, aTree, v.meta.EPOCH_BASE);
    if (tick.failed) throw new Error('restart: the detection tick failed (a refresh or diff-files error on the private index)');

    // 4 the journaled intent.
    let handled: ReadonlySet<string> = new Set();
    if (v.intent.kind === 'apply' || v.intent.kind === 'local') {
      handled = await resolveWriteIntent(core, v, report);
    } else if (v.intent.kind === 'push') {
      // P2-PUSHINTENT-FIRST: resolved by observation before anything else may journal an intent. Remote content (the
      // incident check's verdicts, and the fold's or the live chain's typed errors, which prepareIteration maps to the
      // same incident) leaves the intent kept and the restart done: the loop's incident path takes over, as it would in
      // any iteration (Task 15 ruling: a state exists, so no START_REMOTE refusal).
      const prepared = await prepareIteration(core, 0, { materialize: false, forceFetch: true });
      if (prepared.ok && core.view?.intent.kind === 'push') {
        const r = await resolvePushIntent(core, prepared.it);
        report.pushResolved = r.outcome === 'landed' ? 'landed' : r.why === 'resolved' ? 'discarded' : null;
      }
    }

    // tmp/ leftovers of earlier runs (orphans, ring files, .redo).
    await resolveTmpLeftovers(core, mark, report, handled);

    // The first iteration stage-reads every tracked path once and re-forms the open human CS from its tick (R-01); a path
    // whose local change an earlier update already took into state:snap reads as unchanged there, so it joins here.
    await core.snapshot.reseed(core.view!.snap);
    await reformOpenCs(core);
    return report;
  } finally {
    await unlinkQuiet(core, core.path(RESTART_MARK), 'restart_mark');
  }
}

/**
 * R-01's re-form of the open human CS after the reseed from state:snap: the LIVE paths where A ≠ snap, minus the paths of
 * the journaled ready pairs, are observed now. snap is S_disk as the last update took it, so these are local changes no
 * ready pair carries (an apply's ENG-36 update takes an uncaptured edit into snap, and the first tick, which compares
 * the disk with snap, never sees it again); a path the disk changed since snap is observed by that tick as well. Their
 * scope comes from the attributes at EPOCH_BASE and the entry's real blob size (the stat cache is empty after the reseed).
 * First (final review FD, Task 19 round-3 residual) the ready pairs drop their vanished paths (dropVanishedReady), so a
 * created-then-deleted file whose close died with the process is never published.
 */
async function reformOpenCs(core: EngineCore): Promise<void> {
  const { A } = await currentA(core);
  const snap = await core.repo.readTreeMap(core.view!.snap);
  await dropVanishedReady(core, A, snap);
  const view = core.view!;
  const ready = new Set(core.cs.ready().flatMap((r) => r.paths));
  const candidates: Array<{ path: string; entry: TreeEntry }> = [];
  for (const p of [...new Set([...A.keys(), ...snap.keys()])].sort()) {
    if (ready.has(p)) continue;
    const a = A.get(p);
    const s = snap.get(p);
    if (sameEntry(a, s)) continue;
    candidates.push({ path: p, entry: (a ?? s) as TreeEntry });
  }
  if (candidates.length === 0) return;
  const inp = await scopeInputsFor(core, view.meta.EPOCH_BASE, candidates.map((c) => c.path));
  // The size of the bytes the CS would carry (snap's entry, else A's); a gitlink names a commit, not a blob.
  const sized = candidates.map((c) => ({ path: c.path, e: snap.get(c.path) ?? c.entry })).filter((x) => x.e.mode !== '160000');
  const sizes = await core.repo.blobSizes(sized.map((x) => x.e.oid));
  const size = new Map(sized.map((x, i) => [x.path, sizes[i] ?? 0] as const));
  const live = candidates.filter((c) => scopeOfTracked(c.path, c.entry.mode, size.get(c.path) ?? 0, inp).cls === 'LIVE').map((c) => c.path);
  if (live.length > 0) core.cs.observe(live);
}

/**
 * Final review FD (Task 19 round-3 residual). A LIVE path a ready pair holds that is absent from A and from the disk is a
 * file that pair's capture created and the user deleted since: its newest state is "absent", which a close expresses by
 * dropping the path from the older pairs (ChangeSets.capture, Task 19 ruling). That close happens in memory (the open CS,
 * or `pending` behind a kept push intent, round 3), so it dies with the process; with state:snap lacking p as well, no
 * tick after the reseed sees p again, and the loop's first publish would send the creation (R[p]) — once landed, TIP
 * holds a file the user deleted, for good. The restart makes that close now (ChangeSets.dropVanished) and journals the
 * pairs: every pair the push intent left kept by the resolution above does not name drops p; a pair it still names keeps
 * it, and p waits in pending as before the crash — only when snap lacks p, so that capture reads an S_disk without p
 * (with snap holding p the reseeded index holds it: the first tick reads the absence as a deletion still to confirm, S_disk
 * keeps p for that loop, and the tick then observes the deletion, as it would have before the crash). The disk is one
 * lstat through the Fs port; a file there, or an lstat that fails, keeps p. A false absence (an atomic save's window) only
 * drops a creation that the next tick finds again as a new file, or, with snap holding p, that the re-form observes (A ≠
 * snap), so it is captured again.
 */
async function dropVanishedReady(core: EngineCore, A: TreeMap, snap: TreeMap): Promise<void> {
  const view = core.view!;
  const kept = view.intent.kind === 'push' ? new Set(view.intent.cs_ids) : new Set<string>();
  // Paths a pair holds that A lacks (A_cap == A on every pair path, ENG-39, so R holds each), with R's entry.
  const created = new Map<string, TreeEntry>();
  const inKept = new Set<string>();
  for (const pair of core.cs.ready()) {
    const paths = pair.paths.filter((p) => !A.has(p));
    if (paths.length === 0) continue;
    const R = await core.repo.readTreeMap(pair.R);
    for (const p of paths) {
      const e = R.get(p);
      if (e === undefined) continue;
      if (!created.has(p)) created.set(p, e);
      if (kept.has(pair.csId)) inKept.add(p);
    }
  }
  const gone: string[] = [];
  for (const p of [...created.keys()].sort()) {
    if (inKept.has(p) && snap.has(p)) continue;
    let st;
    try {
      st = await core.deps.ports.fs.lstat(join(core.deps.paths.workTree, ...p.split('/')));
    } catch {
      continue;
    }
    if (st === null) gone.push(p);
  }
  if (gone.length === 0) return;
  const inp = await scopeInputsFor(core, view.meta.EPOCH_BASE, gone);
  const sized = gone.map((p) => created.get(p) as TreeEntry).filter((e) => e.mode !== '160000');
  const sizes = await core.repo.blobSizes(sized.map((e) => e.oid));
  const size = new Map(sized.map((e, i) => [e.path, sizes[i] ?? 0] as const));
  const vanished = new Set(gone.filter((p) => scopeOfTracked(p, (created.get(p) as TreeEntry).mode, size.get(p) ?? 0, inp).cls === 'LIVE'));
  if (vanished.size === 0) return;
  if (!(await core.cs.dropVanished(core.repo, vanished, kept, core.scratch('r')))) return;
  await core.commit({ ready: core.cs.ready() });
  core.deps.log.write('warn', 'RESTART_READY_VANISHED', { paths: vanished.size });
}

/**
 * The lost-state path of a restart: a broken loose state ref moved aside (git fetch dies on it; the remote is checked by
 * ls-remote first, which reads no local ref, so an unreachable remote moves nothing), one fetch outside the Fetcher (the
 * loop's first fetch of the run stays the loop's, PRO-55), the board read before the rebuild. A moved ref is put back on
 * ANY failure (a refusal or a thrown error, Task 15 ruling) while no state was created, so a later start still sees the
 * lost state (never a join); a simulated kill (KilledAt) does nothing, as a dead process would not: its leftover
 * tmp/broken-state-ref-<e>-<k> makes the next start take this path again (brokenStateLeftovers). Every such leftover is
 * removed only after the new state is committed.
 * The restart returns after it without R-01's open-CS re-form (final review FC round 2): ENG-54 decides every local
 * delta itself — a LIVE path the disk matches on TIP's chain takes that version (no delta left), any other keeps its
 * bytes in a masked 'restart' record, "not published, not overwritten" (01-engine §3.14) — so diff(A, S_disk) holds
 * only record-held paths, which a re-formed CS could not publish; and the rebuild reseeds from tree(TIP) and
 * snapshots, so the next tick starts from the disk itself (an ordinary restart reseeds from state:snap, which is why
 * it re-forms from diff(A, snap)).
 */
async function rebuildLostState(core: EngineCore, broken: boolean): Promise<LostStateReport> {
  const report = await rebuildLostStateOnce(core, broken);
  await removeBrokenStateLeftovers(core);
  return report;
}

async function rebuildLostStateOnce(core: EngineCore, broken: boolean): Promise<LostStateReport> {
  const { repo, deps } = core;
  let aside: string | null = null;
  try {
    if (broken) {
      const probe = await lsRemote(repo, deps.url, [core.refs.remoteBoard]);
      if (!probe.ok) throw new StartRefused('START_REMOTE', { reason: 'unreachable' });
      aside = await moveBrokenStateRef(core);
      // The post-move check runs here, once the aside name is known: any throw of it puts the ref back (the catch).
      await assertNotBroken(core);
    }
    const f = await fetchRefs(repo, deps.url, core.refs.fetchSpecs);
    if (!f.ok) throw new StartRefused('START_REMOTE', { reason: f.remoteAnswered ? 'local_ref_update' : 'unreachable' });
    const branch = f.values.get(core.refs.remoteBranch) ?? ABSENT;
    if (branch !== ABSENT && !(await sameRepository(core, branch))) throw new StartRefused('START_REPO_IDENTITY', {});
    const T = f.values.get(core.refs.remoteBoard) ?? ABSENT;
    // No board to rebuild against: the team's state lives with a teammate (GENESIS_BOARD_MISSING's next step: recover).
    if (T === ABSENT) throw new StartRefused('GENESIS_BOARD_MISSING', { branch: deps.branch });
    try {
      await readBoardCommit(repo, T);
      const { tip } = await liveCodeOf(core, T);
      await liveBase(repo, tip);
    } catch (e) {
      if (isRemoteContentError(e)) throw new StartRefused('START_REMOTE', { reason: 'board_malformed' });
      throw e;
    }
    return await lostStateRebuild(core, T, 'lost_state');
  } catch (e) {
    if (aside !== null && !(e instanceof KilledAt)) await restoreBrokenStateRef(core, aside);
    // Final review FB-6: TIP holds a name git refuses in any index here (a root drive-prefix name, `a:b.txt`, on Windows;
    // the reseed of tree(TIP) is the first to meet it): a refusal like join's, nothing written, never a respawn loop.
    if (e instanceof IndexRefusedPathError) throw new StartRefused('START_REPO_SHAPE', { reason: 'path_not_indexable' });
    throw e;
  }
}

/** The mode a journaled local entry's blob takes: the private index's, else A's, else 100644 (DISK_EQ is mode-blind). */
function modeFor(path: string, A: TreeMap, index: ReadonlyMap<string, TreeEntry>): FileMode {
  const m = index.get(path)?.mode ?? A.get(path)?.mode;
  return m === '100755' ? '100755' : '100644';
}

/**
 * ENG-53 step 4 for a journaled apply or local intent: writer rollback with targets from the journal, the leftover
 * .old files, the per-path MANY CANDIDATES decision, the HLD-41 rebase and ONE state update. Returns the tmp/ files it
 * handled (kept as known-path orphans), which the later leftover step leaves alone.
 */
async function resolveWriteIntent(core: EngineCore, v: StateView, report: RestartReport): Promise<ReadonlySet<string>> {
  const { repo, deps } = core;
  const intent = v.intent as Extract<Intent, { kind: 'apply' | 'local' }>;
  const { aTree, A } = await currentA(core);
  const privateIndex = join(deps.paths.coworkDir, `${core.refs.e}.index`);
  const index = await repo.listIndex(privateIndex);
  const live = await liveScopes(core, v.meta.EPOCH_BASE, A, intent.kind === 'apply' ? intent.groups.flatMap((g) => g.entries.map((e) => e.path)) : intent.entries.map((e) => e.path));

  // Targets from each journaled entry, never from a separately recorded blob (Task 10 carry ruling). t/M is read for the
  // journaled entries only: a path the apply deferred because git could not index its merged tree may hold a marker blob
  // there (final review FB-6, ratified), and such a path is never journaled.
  const M = intent.kind === 'apply' ? await repo.readTreeMap(must(v.t.get('M'), 't/M')) : null;
  const S = intent.kind === 'apply' ? await repo.readTreeMap(must(v.t.get('S'), 't/S')) : null;
  const TIP = intent.kind === 'apply' ? await repo.readTreeMap(must(v.t.get('TIP'), 't/TIP')) : null;
  const targets = new Map<string, TreeEntry | null>();
  const pre = new Map<string, TreeEntry | Absent>();
  const groupOf = new Map<string, number>();
  if (intent.kind === 'apply') {
    for (const g of intent.groups) {
      for (const e of g.entries) {
        targets.set(e.path, M!.get(e.path) ?? null);
        pre.set(e.path, S!.get(e.path) ?? ABSENT);
        groupOf.set(e.path, g.n);
      }
    }
  } else {
    for (const e of intent.entries) {
      const mode = modeFor(e.path, A, index);
      targets.set(e.path, e.target === 'DELETE' ? null : { path: e.path, mode, oid: e.target });
      pre.set(e.path, e.expected === ABSENT ? ABSENT : { path: e.path, mode, oid: e.expected });
      groupOf.set(e.path, 0);
    }
  }
  const rb = await core.writer.rollbackIntent(intent, targets);
  report.rolledBackGroups = [...rb.rolledBack];
  const complete = new Set(rb.complete);

  // Per journaled path: MANY CANDIDATES over {target, pre-image}, read first (nothing is recorded or deleted yet): the
  // leftover .old files below are decided against it.
  const decisions: Array<{ path: string; mc: Awaited<ReturnType<typeof core.diskEq.manyCandidates>>; matchesTarget: boolean; matchesPre: boolean }> = [];
  for (const path of [...targets.keys()].sort()) {
    if (!stageable(path) || core.snapshot.isCarried(path)) continue;   // never looked at (P2-CARRY): A keeps its entry
    const target = targets.get(path) ?? null;
    const p0 = pre.get(path) ?? ABSENT;
    const mc = await core.diskEq.manyCandidates(path, [target ?? ABSENT, p0]);
    const matchesTarget = mc.match !== null && (target === null ? mc.match === ABSENT : mc.match !== ABSENT && mc.match.oid === target.oid);
    const matchesPre = mc.match !== null && !matchesTarget && (p0 === ABSENT ? mc.match === ABSENT : mc.match !== ABSENT && mc.match.oid === p0.oid);
    decisions.push({ path, mc, matchesTarget, matchesPre });
  }
  // Final review FB-4: a .old matched by the pre-image is a duplicate only when p itself holds the target or the
  // pre-image; when p holds neither (a torn copy-mode write, a relink that tore p), the .old is the only copy of
  // S_raw[p] — the user's unpublished local edits — and is recorded like any other byte nothing places.
  const diskDecided = new Set(decisions.filter((d) => d.matchesTarget || d.matchesPre).map((d) => d.path));

  // Leftover .old files: matched by their pre-image while p is decided → deleted; otherwise their bytes become a
  // restart record, and the file is removed only after the record committed. A .old whose path stayed absent in a
  // rolled-back group (a relink that failed again) is always recorded: it may be the only copy of p, and p's absence
  // must never be published as a deletion (P2-NARROW-DELETE). One that cannot be read now is kept as a known-path
  // orphan (never deleted blindly).
  const recorded = new Set<string>();
  const handled = new Set<string>();
  for (const { path, file } of rb.leftoverOld) {
    const absent = (await lstatQuiet(core, join(deps.paths.workTree, ...path.split('/')))) === null;
    const strandedHere = absent && !complete.has(groupOf.get(path) ?? -1);
    const mc = await core.diskEq.manyCandidates(path, [pre.get(path) ?? ABSENT], file);
    if (mc.read === 'missing') continue;
    if (mc.match !== null && !strandedHere && diskDecided.has(path)) {
      await unlinkQuiet(core, file, 'old_matched');
      continue;
    }
    if (mc.read === 'ok' && mc.raw !== null) {
      const id = await restartRecord(core, path, A.get(path), mc.raw, live(path));
      report.restartRecords.push(id);
      recorded.add(path);
      await unlinkQuiet(core, file, 'old_recorded');
    } else {
      handled.add(await keepAsOrphan(core, file, path, mc.raw === null && mc.read === 'ok' ? 'filter_failure' : mc.read));
    }
  }

  // The per-path decision.
  const aEdits: IndexEdit[] = [];
  const changes: RebaseChange[] = [];
  const aSet: Array<{ path: string; blob: string | null }> = [];
  // A Map, written back by Object.fromEntries (own keys; group FC's LEFT item): `pending[path] = …` on a plain object would
  // call the prototype setter for a path named `__proto__` and drop it.
  const pending = new Map<string, DeferReason>(Object.entries(v.meta.pending));
  for (const { path, mc, matchesTarget, matchesPre } of decisions) {
    if (intent.kind === 'apply') {
      if (matchesTarget) {
        // The verified write happened: A[p] := TIP[p] (ENG-36 as the crashed apply would have made it).
        const t = TIP!.get(path);
        const a = A.get(path);
        aEdits.push(t === undefined ? { path, remove: true } : { path, mode: t.mode, oid: t.oid });
        aSet.push({ path, blob: t?.oid ?? null });
        // An apply-side K4 the crashed apply created before its write (R-02): TIP[p] is on disk, so EVERY ON_DISK
        // CONFLICTED conflict record of p goes OFF_DISK, not only one per path (final review FB-5).
        const recs = onDiskConflictRecords(core, path);
        changes.push({
          path, aOld: a ?? null, aNew: t ?? null, written: recs.length > 0 ? 'take_tip' : 'clean',
          sDiskBefore: S!.get(path) ?? null, writtenEntry: recs.length > 0 ? null : (M!.get(path) ?? null),
        });
        for (const id of recs) await core.holds.transition(id, { residence: 'OFF_DISK' });
        pending.delete(path);
        continue;
      }
      pending.set(path, RESTART_PENDING);
    }
    if (matchesTarget || matchesPre || recorded.has(path)) continue;
    // The bytes when they were read (raw stored by route (a)/(b)); ABSENT only for a missing file. A read that succeeded
    // while the clean filter failed holds no blob: undecided like an unreadable file, never recorded as ABSENT.
    if ((mc.read === 'ok' && mc.raw !== null) || mc.read === 'missing') {
      const id = await restartRecord(core, path, A.get(path), mc.read === 'missing' ? ABSENT : (mc.raw as Oid), live(path));
      report.restartRecords.push(id);
    } else {
      deps.log.write('warn', 'RESTART_PATH_UNDECIDED', { path, read: mc.read === 'ok' ? 'filter_failure' : mc.read });
      if (intent.kind === 'apply') pending.set(path, 'unreadable');
    }
  }

  // ONE state update: A, LA_C, LA_B, the rebased ready pairs, the intent cleared (apply: snap := t/S as ENG-36 writes).
  const rebase = await core.cs.rebase(repo, changes, core.scratch('r'));
  const newATree = await editTreeIndexOnly(repo, deps.ports.fs, aTree, aEdits, core.scratch('a'));
  const newA = newATree === aTree ? A : await repo.readTreeMap(newATree);
  const keep = new Map(v.keep);
  keep.delete(LOCAL_INTENT_KEEP);
  const fp = foldPatch(core);
  const meta: Meta = { ...v.meta, pending: Object.fromEntries(pending), ...(fp !== null ? fp.meta : {}) };
  await core.commit({
    ...(intent.kind === 'apply' ? { laC: intent.tip, laB: intent.board, snap: must(v.t.get('S'), 't/S') } : {}),
    base: newATree, meta, intent: { kind: 'none' }, t: new Map(), keep, ready: rebase.ready,
    ...(fp !== null ? { fold: fp.fold } : {}),
  });
  setCurrentA(core, newATree, newA);
  for (const s of aSet) deps.trace.emit({ kind: 'A_set', peer: core.peerId, path: s.path, blob: s.blob, cause: 'restart_decision' });
  for (const csId of rebase.cancelled) deps.log.write('info', 'CS_READY_CANCELLED', { cs_id: csId });
  if (report.restartRecords.length > 0) deps.log.write('warn', 'RESTART_RECORDS', { n: report.restartRecords.length });
  return handled;
}

function must(o: Oid | undefined, what: string): Oid {
  if (o === undefined) throw new Error(`restart: the journaled intent has no ${what}`);
  return o;
}

/** LIVE (true) or not, per path, at epochBase (unknown paths count as LIVE: a record of theirs is masked either way). */
async function liveScopes(core: EngineCore, epochBase: Oid, A: TreeMap, paths: readonly string[]): Promise<(p: string) => boolean> {
  const inp = await scopeInputsFor(core, epochBase, paths);
  return (p: string): boolean => {
    try {
      return scopeOfEntry(core, inp, p, A.get(p)?.mode ?? '100644').cls === 'LIVE';
    } catch {
      return true;
    }
  };
}

/**
 * tmp/ leftovers of earlier runs (Task 10 carry rulings, Task 15 findings), in name order, with no age check but the
 * ring's (P2-OWNLOCKS: the restart-mark age rule applies to tmp/ring-* only): a known-path orphan .old (its path in a
 * WRITE_TMP_ORPHAN line, P2-ORPHANNAMES) goes through MANY CANDIDATES against S_disk[p] (state:snap) — equal while p is
 * on disk: deleted; else (other bytes, or p absent: the orphan may be the only copy of p, e.g. a stranded restore the
 * writer moved aside) a restart record holding its bytes, then deleted; unreadable: kept; a ring .old (tmp/ring-*) whose
 * window ended RING_KEEP_MS before the marker is deleted (younger: a late write moved its mtime, kept); every other .old
 * (an orphan of unknown path, an intent name no intent names any more) is kept and logged — never deleted blindly;
 * .redo and .new files are deleted.
 */
async function resolveTmpLeftovers(core: EngineCore, mark: bigint, report: RestartReport, handled: ReadonlySet<string>): Promise<void> {
  const tmp = core.path('tmp');
  const names = (await readdirQuiet(core, tmp)).filter((n) => (n.endsWith('.old') || n.endsWith('.redo') || n.endsWith('.new')) && !handled.has(join(tmp, n)));
  if (names.length === 0) return;
  const view = core.view!;
  const known = await orphanPaths(core);
  const snap = await core.repo.readTreeMap(view.snap);
  const { A } = await currentA(core);
  const ringMark = mark - BigInt(RING_KEEP_MS) * 1_000_000n;
  for (const name of names) {
    const file = join(tmp, name);
    if (!name.endsWith('.old')) {
      await unlinkQuiet(core, file, 'tmp_leftover');
      continue;
    }
    if (name.startsWith('ring-')) {
      // A ring .old: its window ended unless a late write moved its mtime.
      if (await olderFile(core, file, ringMark)) await unlinkQuiet(core, file, 'ring_expired');
      else core.deps.log.write('warn', 'RESTART_RING_KEPT', { file });
      continue;
    }
    const path = known.get(`tmp/${name}`);
    if (path === undefined || !stageable(path)) {
      core.deps.log.write('warn', 'RESTART_ORPHAN_KEPT', { file, why: 'unknown_path' });
      continue;
    }
    const mc = await core.diskEq.manyCandidates(path, [snap.get(path) ?? ABSENT], file);
    if (mc.read === 'missing') continue;
    const onDisk = (await lstatQuiet(core, join(core.deps.paths.workTree, ...path.split('/')))) !== null;
    if (mc.match !== null && onDisk) {
      await unlinkQuiet(core, file, 'orphan_matched');
    } else if (mc.read === 'ok' && mc.raw !== null) {
      const live = await liveScopes(core, view.meta.EPOCH_BASE, A, [path]);   // each orphan's own path asked
      // The record commits (registry CAS) before the file goes: a kill in between keeps the file for the next restart.
      report.restartRecords.push(await restartRecord(core, path, A.get(path), mc.raw, live(path)));
      await unlinkQuiet(core, file, 'orphan_recorded');
    } else {
      core.deps.log.write('warn', 'RESTART_ORPHAN_KEPT', { file, read: mc.read === 'ok' ? 'filter_failure' : mc.read });
    }
  }
}

// ---- lost state ---------------------------------------------------------------------------------------------------

/**
 * The distinct versions of each needed path on TIP's first-parent chain back to the live base (the commit `stop` that
 * introduced it, exclusive), newest first, TIP's own entry first; one `git log --raw` over at most
 * LOST_STATE_MAX_COMMITS - 1 commits, which names the versions at the newest LOST_STATE_MAX_COMMITS commits.
 */
async function versionsOf(repo: GitRepo, tip: Oid, stop: Oid, need: ReadonlySet<string>, TIP: TreeMap): Promise<Map<string, Array<TreeEntry | Absent>>> {
  const out = new Map<string, Array<TreeEntry | Absent>>();
  for (const p of need) out.set(p, [TIP.get(p) ?? ABSENT]);
  if (need.size === 0 || tip === stop) return out;
  const r = await repo.run([
    'log', '--no-show-signature', '--no-color', '--first-parent', '--diff-merges=first-parent', '--raw', '-z', '--no-renames', '--no-abbrev',
    '--format=%x00%H', `--max-count=${LOST_STATE_MAX_COMMITS - 1}`, parseOid(tip), `^${parseOid(stop)}`,
  ]);
  const tokens = r.stdout.toString('utf8').split('\0');
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i] ?? '';
    const head = t.startsWith('\n') ? t.slice(1) : t;
    if (head.startsWith(':')) {
      const path = tokens[i + 1] ?? '';
      i += 2;
      const f = head.slice(1).split(' ');
      const [oldMode, , oldOid] = f;
      if (f.length < 5 || oldMode === undefined || oldOid === undefined) continue;
      const list = out.get(path);
      if (list === undefined) continue;
      const v: TreeEntry | Absent = ZERO_RE.test(oldMode) ? ABSENT : { path, mode: oldMode as FileMode, oid: parseOid(oldOid) };
      const dup = list.some((x) => (x === ABSENT ? v === ABSENT : v !== ABSENT && x.oid === v.oid && x.mode === v.mode));
      if (!dup) list.push(v);
      continue;
    }
    i += 1;
  }
  return out;
}

/**
 * The highest n of an own `<peer>/human/<n>` change-set on the newest commits of TIP's chain and in the registry. A
 * trailer whose n is not a safe integer (unparsable, oversized) is ignored, never collapsing the maximum to 0.
 */
async function maxOwnCsN(core: EngineCore, tip: Oid): Promise<number> {
  const re = new RegExp(`^Cowork-CS: ${core.peerId}/human/([1-9][0-9]*) `, 'gm');
  let max = 0;
  const take = (digits: string | undefined): void => {
    const n = Number(digits);
    if (Number.isSafeInteger(n)) max = Math.max(max, n);
  };
  const r = await core.repo.run(['log', '--no-show-signature', '--no-color', '--first-parent', '--format=%B', `--max-count=${LOST_STATE_MAX_COMMITS}`, parseOid(tip)]);
  for (const m of r.stdout.toString('utf8').matchAll(re)) take(m[1]);
  for (const rec of core.holds.all()) {
    for (const id of rec.cs_ids) {
      const m = /^[0-9a-f]{32}\/human\/([1-9][0-9]*)$/.exec(id);
      if (m !== null && id.startsWith(`${core.peerId}/`)) take(m[1]);
    }
  }
  return max;
}

/** The highest incident n among the local incident refs. */
async function maxIncidentN(core: EngineCore): Promise<number> {
  let max = 0;
  const prefix = `refs/cowork-local/${core.refs.e}/`;
  for (const { ref } of await core.repo.listRefs(prefix)) {
    const m = /^incident-([1-9][0-9]*)(-own)?$/.exec(ref.slice(prefix.length));
    if (m !== null) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/** One path as a placeholder (glossary §19: 80 characters, a middle ellipsis keeping both ends). */
function pathText(p: string): string {
  const cps = [...p];
  if (cps.length <= PATH_TEXT_MAX) return p;
  const keep = PATH_TEXT_MAX - 1;
  const head = Math.ceil(keep / 2);
  return `${cps.slice(0, head).join('')}…${cps.slice(cps.length - (keep - head)).join('')}`;
}

/** Items joined by ',' while the text stays within LIST_TEXT_MAX; how many did not fit. */
function boundedList(items: readonly string[]): { text: string; omitted: number } {
  let text = '';
  let n = 0;
  for (const it of items) {
    const next = text.length === 0 ? it : `${text},${it}`;
    if (next.length > LIST_TEXT_MAX) break;
    text = next;
    n += 1;
  }
  return { text, omitted: items.length - n };
}

/**
 * 08-lifecycle §3.3 step 2.8 for a lost state (final review FC minor): the remote branch is still this repository before
 * the rebuild re-pins its roots — exactly the roots the live state pinned (a state gone while this core was live), else
 * at least one root shared with HEAD (a broken or unusable state pins nothing readable; HEAD is this clone's own history,
 * symbolic to the branch: headCheck passed).
 */
async function sameRepository(core: EngineCore, branch: Oid): Promise<boolean> {
  const roots = await rootsOf(core.repo, branch);
  const pinned = core.view?.meta.pinned.identity ?? null;
  if (pinned !== null) {
    const want = [...pinned].sort();
    return roots.length === want.length && roots.every((r, i) => r === want[i]);
  }
  const head = await core.repo.resolve('HEAD');
  if (head === null) return true;
  const mine = new Set(await rootsOf(core.repo, head));
  return roots.some((r) => mine.has(r));
}

/** A regular blob's mode for a held raw blob: the entry's own 100755, else 100644 (DISK_EQ is mode-blind). */
function blobMode(e: TreeEntry | null): FileMode {
  return e?.mode === '100755' ? '100755' : '100644';
}

/**
 * Final review FD: MANY CANDIDATES for a path whose restore is stranded (P2-STRANDED). p is absent and its bytes are in
 * the .old a later sweep relinks at p, so they are read there (01-engine §3.3 DISK_EQ form (3), "bytes not at p"):
 * the newest candidate they match, and the raw blob that holds them. ABSENT never matches — p does not stay absent.
 * When the .old gives no bytes — it vanished (the writer's FB-3 restore puts `pre` at p), it cannot be read (unreadable:
 * e.g. a share-none holder, the same one that fails the relink; unstable), it is refused (carried, filter_failure) or its
 * clean filter fails — `pre` decides (FD fix round 1): the blob P1 verified the .old held (DISK_EQ(p, pre) between two
 * equal lstats, before the rename), matched against the candidates as a read is (preMatch), held when nothing matches.
 * Bytes a late write put in the .old are then a local change from that version once relinked, as after an 'ok' match.
 */
async function strandedCandidates(core: EngineCore, s: StrandedRestore, candidates: readonly (TreeEntry | Absent)[]): Promise<{ match: TreeEntry | null; held: Oid }> {
  const files = candidates.filter((c): c is TreeEntry => c !== ABSENT && (c.mode === '100644' || c.mode === '100755'));
  const mc = await core.diskEq.manyCandidates(s.path, files, s.old);
  if (mc.read === 'ok' && mc.raw !== null) return { match: mc.match === ABSENT ? null : mc.match, held: mc.raw };
  // The writer strands a restore only after renameToOld, which follows the pre-image check that set `pre`.
  if (s.pre === null) throw new Error(`lostStateRebuild: the stranded restore of ${JSON.stringify(s.path)} names no pre-image blob (programming error)`);
  return { match: await preMatch(core, s.path, s.pre, files), held: s.pre.oid };
}

/**
 * The newest candidate a known blob matches, compared as MANY CANDIDATES compares a read (diskEq.manyCandidates): the
 * blob itself for a filtered path (a route (b) id), else canon(blob, c) == c (canon passes a binary or non-text path
 * through), so a CRLF/BOM form of a version matches that version on every peer whatever its EOL settings.
 */
async function preMatch(core: EngineCore, path: string, pre: TreeEntry, files: readonly TreeEntry[]): Promise<TreeEntry | null> {
  if (files.length === 0) return null;
  if (pathIsFiltered(core, path)) return files.find((c) => c.oid === pre.oid) ?? null;
  const blobs = await core.repo.readBlobs([pre.oid, ...files.map((c) => c.oid)]);
  const preBytes = blobs[0] as Buffer;
  const skip = !pathIsText(core, path);
  for (let i = 0; i < files.length; i++) {
    const cBytes = blobs[i + 1] as Buffer;
    const res = canon(preBytes, cBytes, skip);
    if (res.ok && res.out.equals(cBytes)) return files[i] as TreeEntry;
  }
  return null;
}

/**
 * ENG-54 per-path rebuild against T; `paths` restricts it to the per-path primitive. LIVE unmatched → A[p] := TIP[p] +
 * 'restart' record; QUARANTINED/SAVE_ONLY → newest match else TIP, no record; UNMANAGED → TIP unread; a stranded
 * restore's p (Writer.strandedRestores) decided from its .old (final review FD); LA_C := TIP,
 * LA_B := T, new epoch, LOST_STATE. `metaOverrides` are committed in the SAME state update (the re-anchor of 01-engine
 * §3.7 step 2a clears INCIDENT, meta.incident and meta.displaced and sets the rebuilt outbox there, so a crash leaves the
 * whole re-anchor or none of it); a re-anchor also persists the fold refolded at T (PRO-25), never the old chain's.
 */
export async function lostStateRebuild(core: EngineCore, T: Oid, mode: 'lost_state' | 're_anchor', paths?: ReadonlySet<string>, metaOverrides?: Partial<Meta>): Promise<LostStateReport> {
  // The per-path primitive changes A only: meta overrides belong to a whole rebuild's one transition. Passing both is a
  // programming error, never silently ignored (Task 16 round 2).
  if (paths !== undefined && metaOverrides !== undefined) throw new Error('lostStateRebuild: metaOverrides apply to a whole rebuild only, not with `paths` (programming error)');
  const { repo, deps } = core;
  const { tip, tree: tipTree } = await liveCodeOf(core, T);
  const TIP = await repo.readTreeMap(tipTree);
  const lb = await liveBase(repo, tip);
  const epochBase = lb.base;

  // Reseed the private index from tree(TIP), empty the stat cache, one tick and materialize (every path stage-read once).
  // The per-path primitive keeps the private index and snapshots against the current A.
  const perPath = paths !== undefined;
  if (!perPath) await core.snapshot.reseed(tipTree);
  const snapBase = perPath ? await currentA(core) : { aTree: tipTree, A: TIP };
  const { inp, tick } = await tickOutside(core, snapBase.A, snapBase.aTree, epochBase, TIP.keys());
  if (tick.failed) throw new Error('lost state: the snapshot failed; the rebuild runs again at the next start');
  const mat = await core.snapshot.materialize(inp);
  const S = mat.sDiskMap;
  // Final review FD: a stranded restore (P2-STRANDED) leaves p absent with its bytes in the .old a later sweep relinks at
  // p, and the tick skipped p (P2-STRANDED-SKIP), so S holds no reading of it. Those bytes are p's disk bytes in
  // ENG-54's sense: p is decided from them below (DISK_EQ form (3)), and is in `all` even when neither TIP nor S has it
  // (T deleted p), so they never come back as an undecided local delta the human CS would publish over T's version.
  const strandedOf = new Map<string, StrandedRestore>();
  for (const s of core.writer.strandedRestores()) {
    if (paths === undefined || paths.has(s.path)) strandedOf.set(s.path, s);
  }
  const all = [...(paths ?? new Set([...TIP.keys(), ...S.keys(), ...strandedOf.keys()]))].sort();
  const scope = await scopeInputsFor(core, epochBase, all);
  const clsOf = (p: string): Scope['cls'] => {
    const e = TIP.get(p) ?? S.get(p);
    return validPathSyntax(p) ? scopeOfEntry(core, scope, p, e?.mode ?? '100644').cls : 'UNMANAGED';
  };

  // Paths whose disk is not TIP's version (or not settled): the ones that need the chain's versions.
  const unsettled = new Set([...tick.excluded.keys(), ...mat.excluded.keys()]);
  const need = new Set<string>();
  for (const p of all) {
    const cls = clsOf(p);
    if (cls !== 'LIVE' && cls !== 'QUARANTINED' && cls !== 'SAVE_ONLY') continue;
    if (!stageable(p) || core.snapshot.isCarried(p)) continue;
    if (!strandedOf.has(p) && !unsettled.has(p) && sameEntry(S.get(p), TIP.get(p))) continue;
    need.add(p);
  }
  const versions = await versionsOf(repo, tip, lb.introducedBy, need, TIP);

  // Per path: A[p] := the newest candidate the disk matches (MANY CANDIDATES; ABSENT matches ENOENT); else TIP[p], with
  // a 'restart' record holding the disk bytes for a LIVE path (QUARANTINED / SAVE_ONLY: under the path-class mask, no
  // record). Every other path (UNMANAGED, never read; carried; disk == TIP[p]) takes TIP[p]. A stranded p is read from
  // its .old (strandedCandidates); S_disk[p] becomes that reading (sEdits), as the stage read of p would have given.
  const decision = new Map<string, TreeEntry | Absent>();
  const sEdits = new Map<string, TreeEntry>();
  const records: string[] = [];
  const recordPaths: string[] = [];
  const decided: string[] = [];
  for (const p of all) {
    const t = TIP.get(p) ?? ABSENT;
    if (!need.has(p)) {
      decision.set(p, t);
      continue;
    }
    decided.push(p);
    const candidates = versions.get(p) ?? [t];
    const s = strandedOf.get(p);
    let match: TreeEntry | Absent | null;
    let held: Oid | Absent;
    if (s === undefined) {
      const mc = await core.diskEq.manyCandidates(p, candidates);
      match = mc.match;
      // The disk bytes when they were read (route (a)/(b) wrote them); ABSENT for a missing file; an unreadable or
      // unstable file (or one whose clean filter failed) is held by the entry the snapshot carried for it (masked either
      // way: nothing of p is published).
      held = mc.read === 'ok' && mc.raw !== null ? mc.raw : mc.read === 'missing' ? ABSENT : (S.get(p)?.oid ?? ABSENT);
    } else {
      const sc = await strandedCandidates(core, s, candidates);
      // FD fix round 1: a held blob that IS TIP[p] is TIP[p]'s version (a match), never a record holding A[p] itself
      // (h0 == h1 would mask every later local edit of p for nothing).
      match = sc.match ?? (t !== ABSENT && sc.held === t.oid ? t : null);
      held = sc.held;
      sEdits.set(p, match ?? { path: p, mode: blobMode(s.pre ?? (t === ABSENT ? null : t)), oid: held });
    }
    if (match !== null) {
      decision.set(p, match);
      continue;
    }
    decision.set(p, t);
    if (clsOf(p) !== 'LIVE') continue;
    records.push(await restartRecord(core, p, TIP.get(p), held, true));
    recordPaths.push(p);
  }

  // A per path (never seeded wholesale: every path above was decided on its own); a whole rebuild edits tree(TIP) where a
  // decision differs from TIP[p], the per-path primitive edits the current A for its paths only.
  const toEdit = (e: TreeEntry | Absent, p: string): IndexEdit => (e === ABSENT ? { path: p, remove: true } : { path: p, mode: e.mode, oid: e.oid });
  const report: LostStateReport = { mode, records, paths: decided };
  const fs = deps.ports.fs;
  if (perPath) {
    // The per-path primitive (DAT-26 reseed, LIF- resume): A of these paths only; nothing else changes.
    const { aTree } = await currentA(core);
    const newATree = await editTreeIndexOnly(repo, fs, aTree, [...decision].map(([p, e]) => toEdit(e, p)), core.scratch('a'));
    await core.commit({ base: newATree });
    setCurrentA(core, newATree, await repo.readTreeMap(newATree));
    await emitASet(core, all, newATree, mode === 'lost_state' ? 'lost_state' : 'recover_reanchor');
    return report;
  }
  const newATree = await editTreeIndexOnly(repo, fs, tipTree, [...decision].filter(([p, e]) => !sameAs(e, TIP.get(p))).map(([p, e]) => toEdit(e, p)), core.scratch('a'));
  // Final review FD: S_disk with each stranded p as read from its .old — the snap committed below and a kept apply
  // intent's t/S (its pre-image), so a restart's ENG-53 decision reads the relinked bytes as that pre-image and adds
  // nothing to what was decided here (no second record), and its reseed from snap sees no delta at p.
  const sDisk = await editTreeIndexOnly(repo, fs, mat.sDisk, [...sEdits].map(([p, e]) => toEdit(e, p)), core.scratch('a'));

  const view = core.view;
  const ep = await epochNow(repo);
  const random = deps.ports.random;
  const overrides: Partial<Meta> = metaOverrides ?? {};
  // Final review FC-7: the new epoch's join op, queued for the next publish (a fold ignores every non-join op of an epoch
  // it has not recorded). ENG-54's "never re-join" is the join procedure (no preview, no first apply), not this board op.
  // A re-anchor passes its own outbox (recover.ts: this join first, then the old drafts), which overrides this one.
  const joinOutbox = new Outbox([{ draft: (await joinDraft(core)) as OpDraft, op: null }]).toJson();
  // Final review FC minor (P2-STRANDED, P2-NARROW): a write intent the re-anchor finds journaled is kept for a stranded
  // restore and is the only durable name of its .old: it stays, with its journal trees (keep/ stays with every
  // transition), and so does this run's mark on a narrowed apply intent, which attachState would forget.
  const keptWrite = view !== null && (view.intent.kind === 'apply' || view.intent.kind === 'local') ? view.intent : null;
  const keptMark = applyIntentKept(core);
  let next;
  if (mode === 're_anchor' && view !== null && (await repo.readRef(core.refs.state)) === view.commit) {
    // Re-anchor on a usable state (ENG-22 step 2a): ONE transition from it; ready pairs rebased by HLD-41; the fold of
    // the new LA_B (PRO-25: refolded from a verified checkpoint when the run's fold is off T's chain, P2-REFOLD).
    // Final review FC round 2: a kept apply intent is rewritten onto the re-anchor's chain, because a restart before the
    // sweep clears it resolves it by ENG-53 (LA_C := intent.tip, LA_B := intent.board, snap := t/S, A[p] := t/TIP[p] on
    // a target match), which with the old chain's values would roll this transition back (an old LA_B off V's chain:
    // board_not_ff, a new INCIDENT, a displaced slot). Kept: its groups (the .old/.new/.redo names derive from n and
    // slot) and t/M (the group's write targets, which decide whether the group completed). Rewritten: tip := live_code(T),
    // board := T, t/S := this S_disk, t/TIP := this A, so that resolution commits this transition's LA_C, LA_B and snap
    // again and a target match leaves A as decided here (no write verified V's TIP). A stranded path's t/S entry is its
    // .old as this rebuild read it (final review FD: sDisk), the group's pre-image: the restart's relinked bytes match it
    // and keep what ENG-54 decided here (A[p] := their version on T's chain, or TIP[p] with the 'restart' record made
    // above), never a second record. A kept local intent stays as it is: its resolution never moves LA_C, LA_B or snap.
    const keptIntent: Intent = keptWrite === null ? { kind: 'none' } : keptWrite.kind === 'apply' ? { ...keptWrite, tip, board: T } : keptWrite;
    const keptT: ReadonlyMap<JournalTree, Oid> = keptWrite === null ? new Map()
      : keptWrite.kind === 'apply' ? new Map<JournalTree, Oid>([...view.t, ['S', sDisk], ['TIP', newATree]]) : view.t;
    const { A } = await currentA(core);
    const newA = await repo.readTreeMap(newATree);
    const changes: RebaseChange[] = [];
    for (const p of new Set([...A.keys(), ...newA.keys()])) {
      if (!sameEntry(A.get(p), newA.get(p))) changes.push({ path: p, aOld: A.get(p) ?? null, aNew: newA.get(p) ?? null, written: 'none', sDiskBefore: null, writtenEntry: null });
    }
    const rebase = await core.cs.rebase(repo, changes, core.scratch('r'));
    const fp = foldPatch(core);
    const from = fp !== null && fp.meta.fold_board !== null ? { board: fp.meta.fold_board, state: fp.fold }
      : view.fold !== null && view.meta.fold_board !== null ? { board: view.meta.fold_board, state: view.fold } : null;
    const folded = await core.folder.foldTo(T, from, deps.regionSpec);
    const verification = core.folder.verification();
    next = await core.commit({
      laC: tip, laB: T, base: newATree, snap: sDisk, ready: rebase.ready,
      intent: keptIntent, t: keptT,
      meta: {
        ...view.meta, epoch: newEpoch(random), seq_next: 1, pending: {}, outbox: joinOutbox,
        fold_board: T, fold_verified: verification.verified, checkpoint_mismatch: verification.checkpointMismatch,
        ...overrides,
      },
      fold: folded.state,
    });
  } else {
    const branch = await repo.readRef(core.refs.localBranch);
    const meta: Meta = {
      v: 1, proto: 1, peer_id: core.peerId, epoch: newEpoch(random), seq_next: 1,
      branch: deps.branch, enc: core.refs.e,
      pinned: { url: sanitizeUrl(deps.url), identity: await rootsOf(repo, branch ?? ep.head) },
      H_adopt: ep.head, EPOCH_BASE: epochBase,
      expected_epoch: ep,
      freeze_reasons: [], config_detail: [], incident: null, nonretryable: null, rejections: null, throttle: null,
      pending: {}, displaced: [],
      fold_board: null, fold_verified: null, checkpoint_mismatch: false, outbox: joinOutbox,
      cs_human_next: (await maxOwnCsN(core, tip)) + 1, incident_next: (await maxIncidentN(core)) + 1,
      ...overrides,
    };
    const init = { laC: tip, laB: T, base: newATree, snap: sDisk, meta };
    next = await writeLostState(core, init);
  }
  attachState(core, next);
  if (next.intent.kind === 'apply' && keptWrite?.kind === 'apply' && keptMark) markApplyIntentKept(core, true);
  await emitASet(core, all, newATree, mode === 'lost_state' ? 'lost_state' : 'recover_reanchor');
  // 01-engine §2: LOST_STATE{mode, restart record ids and paths}, each list bounded by glossary §19's caps.
  const ids = boundedList(records);
  const ps = boundedList(recordPaths.map(pathText));
  deps.log.write('warn', 'LOST_STATE', {
    mode, records: records.length, paths: decided.length,
    record_ids: ids.text, record_ids_omitted: ids.omitted, record_paths: ps.text, record_paths_omitted: ps.omitted,
  });
  return report;
}

/** The new state over a lost one: CAS from the unusable commit, else a create (a broken loose ref is moved aside first). */
async function writeLostState(core: EngineCore, init: { laC: Oid; laB: Oid; base: Oid; snap: Oid; meta: Meta }): Promise<StateView> {
  let unusable: Oid | null = null;
  try {
    // rebuild() trusts its caller: the ref is read again first. A usable state there now is another writer's.
    if ((await core.state.read()) !== null) throw new StateCasLostError(`${core.refs.state} holds a usable state again: a second writer`);
  } catch (e) {
    if (!(e instanceof LostStateError)) throw e;
    unusable = e.stateOid;
  }
  if (unusable !== null) return core.state.rebuild(unusable, init);
  if ((await stateRefState(core)) !== 'broken') return core.state.create(init);
  // Broken again since the rebuild began: moved aside, checked and created in one try that puts it back on any throw
  // (a state the create made is never overwritten: restoreBrokenStateRef checks first).
  const aside = await moveBrokenStateRef(core);
  try {
    await assertNotBroken(core);
    return await core.state.create(init);
  } catch (e) {
    if (!(e instanceof KilledAt)) await restoreBrokenStateRef(core, aside);
    throw e;
  }
}

/**
 * A broken loose state ref (garbage or an empty file after a power cut, re-confirmed by show-ref --exists): git refuses
 * update-ref and update-ref -d over it, and every fetch dies on it, so the loose file — an engine-owned ref under
 * refs/cowork-local/<e>/ — is moved aside to tmp/broken-state-ref-<e>-<k> through the Fs port (never just deleted; the caller
 * holds the daemon lock) and logged STATE_REF_BROKEN_MOVED; the rebuild then creates the state afresh. A broken ref that
 * is not a loose file (packed-refs) is not touched: GitCommandError. Any throw after the rename (before the caller
 * holds the aside name) puts the ref back here; a simulated kill (KilledAt) does nothing, as a dead process would not,
 * and its leftover tells the next start that a state existed. The aside name; the caller checks the ref after it
 * (assertNotBroken) inside its own try, which puts the ref back on any throw.
 */
async function moveBrokenStateRef(core: EngineCore): Promise<string> {
  const loose = join(core.deps.paths.gitDir, ...core.refs.state.split('/'));
  const st = await lstatQuiet(core, loose);
  if (st === null || !st.isFile) {
    throw new GitCommandError(['show-ref', '--exists', core.refs.state], 1, Buffer.from('the broken state ref is not a loose ref file', 'utf8'));
  }
  const aside = await freeTmpName(core, brokenAsidePrefix(core), '');
  await core.deps.ports.fs.rename(loose, aside);
  try {
    core.deps.log.write('security', 'STATE_REF_BROKEN_MOVED', { ref: core.refs.state, file: aside });
  } catch (e) {
    if (!(e instanceof KilledAt)) await restoreBrokenStateRef(core, aside);
    throw e;
  }
  return aside;
}

/** After a move aside: a ref that still reads broken (another broken entry, packed-refs) is no state to rebuild over. */
async function assertNotBroken(core: EngineCore): Promise<void> {
  if ((await stateRefState(core)) === 'broken') {
    throw new GitCommandError(['show-ref', '--exists', core.refs.state], 1, Buffer.from('the state ref is still broken after its loose file was moved aside', 'utf8'));
  }
}

/**
 * A failure after the broken ref was moved aside puts it back, so a later start sees the lost state again (never a
 * join) — only while no state took its place: a loose file there, or a ref that reads present, is a state the rebuild
 * created and is never overwritten (the aside file then stays, logged; the next committed state removes it). A ref that
 * still reads broken (assertNotBroken's case) gets its loose file back: the clone is as it was before the move.
 */
async function restoreBrokenStateRef(core: EngineCore, aside: string): Promise<void> {
  const loose = join(core.deps.paths.gitDir, ...core.refs.state.split('/'));
  try {
    if ((await lstatQuiet(core, loose)) !== null || (await stateRefState(core)) === 'present') {
      core.deps.log.write('error', 'STATE_REF_BROKEN_KEPT_ASIDE', { ref: core.refs.state, file: aside, code: 'state_present' });
      return;
    }
    await core.deps.ports.fs.rename(aside, loose);
    core.deps.log.write('security', 'STATE_REF_BROKEN_RESTORED', { ref: core.refs.state, file: aside });
  } catch (e) {
    if (e instanceof KilledAt) throw e;
    core.deps.log.write('error', 'STATE_REF_BROKEN_KEPT_ASIDE', { ref: core.refs.state, file: aside, code: codeOf(e) ?? 'unknown' });
  }
}

/** One A_set trace event per path, with A's entry after the rebuild (null: absent). */
async function emitASet(core: EngineCore, paths: readonly string[], tree: Oid, cause: ASetCause): Promise<void> {
  const A = await core.repo.readTreeMap(tree);
  for (const p of paths) core.deps.trace.emit({ kind: 'A_set', peer: core.peerId, path: p, blob: A.get(p)?.oid ?? null, cause });
}
