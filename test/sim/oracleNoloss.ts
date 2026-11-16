// INV-NOLOSS and the held-bytes INV-SECRET slice (Plan 3 Task 15; 11-testing §3.4 rows INV-NOLOSS and INV-SECRET, TST-07, TST-08,
// O-NOMARKER (held side); glossary §21 INV-NOLOSS (rev 2.1 scope), §9; 05-holds §5 INV-NOLOSS harness extension, INV-HLD-DURABLE;
// 03-data §5, P-DAT-05, INV-DAT-NOMARKER, DAT-43, DAT-46; rulings R3-28, R3-48, R3-49, R3-64).
//
// The obligations are MarkerModel.live(): every marker written to a synced path and not since retired by an informed removal. Each one
// must sit in at least one location, searched in this order (locateMarker):
//   1 live            a blob of tree(live_code(board tip)) on the bare remote — the marker's path first, then any path — found through
//                     a per-tree marker index (cat-file --batch of new blobs only; a new tree is derived from the last one by diff-tree);
//   2 saved           vacuous until Plan 7;
//   3 held            a held/<id>/{h1,s2}/<path> blob of the board tip whose folded hold is non-terminal (never h0/s1/s3);
//   4 local_only_disk a peer's working file at a path of one of its non-terminal local_only records (the record owner's disk);
//   5 author_disk     the marker author's working file at the marker's path, counted only while that path is a local delta of the author
//                     (ChangeSets.openPaths(): its open CSs, closed CSs waiting for a pair and paths waiting for a recapture) or one of
//                     its captured, unpublished ready pairs carries the marker (inspect().ready, R at the path) — R3-48, 11-testing §3.4
//                     "an undisplaced edit still on its author's disk". inspect().csTable lists a human CS only from its first capture,
//                     so openPaths() is the membership read, and a pair's `paths` are the union of its R and A trees (all paths for a
//                     start capture), so R's bytes are. The ruled allowances (Task 15 fix round 1), each also counting: the author's
//                     engine is down (KilledAt, not restarted yet); the author is frozen by INCIDENT (its board was rewritten under it:
//                     nothing is applied or published, the disk is the authority); the author's own non-terminal ON_DISK record that is
//                     local_only or CONFLICTED covers the path (its residence is the disk; any other whole-path guard is not an
//                     allowance); and two windows bounded by the trace's `iteration` events — the author restarted (a check saw its
//                     engine down or re-created) and has no iteration since (R-01 re-forms the open CS at its first tick), or the
//                     marker was written at this path and its author has no iteration since the check that first saw the write (the gap
//                     between an op and the author's next tick; a fresh oracle cannot date a write, so its first check never counts it);
//                     and (ruling R3-EF4-2, a reading of R3-48 amending those two windows) a write so dated at a path absent from the
//                     author's A counts until the author's first iteration after one whose virtual mono is ≥ the write's (the author's
//                     clock at that check) + UNTRACKED_RESCAN_MS — Plan 2 Task 9's ratified untracked-listing gate (01-engine §3.8
//                     SNAPSHOT step 1; a new file in a directory the snapshot does not watch is listed by the 30 s rescan backstop,
//                     test/integration/snapshot.test.ts "found by the rescan backstop"); the extra iteration covers a tick that ran before
//                     the bound and emitted its event after it; and (ruling R3-EF4-9, a reading of R3-48 like R3-EF4-2) a file whose
//                     reads the author's FaultFs refuses (a share-none lock, F-FS-1 — the harness's own fault state) while the lock holds
//                     and, after the release, until the author's first iteration since the check that saw it released (ENG-24 makes the
//                     path UNREADABLE to every tick, so an edit no tick staged is in no CS and no pair, and its `unreadable` PIN's h1 is
//                     the private-index blob, A[p] for a never-staged edit, HLD-32; a check that never saw the lock grants no such
//                     window); and (ruling R3-EF4-10) after a restart, while every tick of the author since may have excluded the path
//                     for a future mtime (01-engine §3.8 step 2: a stat whose mtime is ahead of the wall clock is read only once it stayed
//                     unchanged QUIET_MS Δmono; the restart's reseed forgets every sighting, so its first tick only sights it; R-01 as
//                     EF2 fix round 1 F2 keeps such a handed-over path until a tick reads it) — judged test-side: the working file's mtime
//                     is ahead of the author's virtual wall clock and no author iteration since the restart's first one is QUIET_MS past
//                     it and followed by another (the extra iteration, as above, for a tick that ran before its event) — closed for that
//                     restart at the first check that finds it otherwise (the lock half of R3-EF4-10 is R3-EF4-9's window, which holds
//                     with or without a restart);
//   6 registry        a peer's own registry (readRegistry): the h1 of a non-terminal marker companion (always), or the h1/s2 of a
//                     non-terminal, non-local_only record while its pre-mirror window is open. The window for (m, r) opens at the `hold`
//                     event of the first rev of r whose held side holds m (the registry's history, git log of records/<id>.json) and
//                     closes at the owner's first landed publish/board_only push after it whose `mirror` event lists r at a rev ≥ that
//                     first rev; it stays open while a stay-open condition holds now — the owner's publishPause OFFLINE,
//                     inspect().mirror[r].rejected ≠ null, or creationDue(r, age) false (a not-applicable INCOMING record younger than
//                     60 s, R3-29) — and a condition seen earlier never re-opens a closed window (a push listing r cannot land while
//                     one holds). A landed push of a later iteration (an `iteration` event of the owner since the hold event) that does
//                     not list r first fails the oracle (a missed mirror), counted only from the check that saw the conditions clear
//                     after the last stay-open one: hold ops are drafted only by mirrorSync at the start of a publish step, so a record
//                     Algorithm P creates in that step rides the next window, never a later one. A push a host rewind took off
//                     the board (F-BR-3: the board ref moved back onto the chain an instance saw last, observeRewind) neither
//                     closes nor misses the window, so a mirror the rewind removed re-opens it until a push on the chain mirrors
//                     the record again (Plan 3 Task 16 fix round 1; a cold instance never saw the board before the move).
// `discard` is not searched: MarkerModel.noteDiscard moved the marker out of the obligations, and each new entry of discarded() is
// verified instead — the owner's record is RESOLVED_DISCARD and a `discard` trace event of that id names a held blob holding the marker
// (R3-28). A late write (lateWrites()) must be found at live, held or registry — never only on a disk — from the first check after its
// author's next iteration (reading: the writer settles a .old write at its next step; before it the bytes are only in the .old file).
// Resurrection (R3-64): a retired marker that reappears in live_code(board tip) after the board had held it and then left it since its
// retirement fails (a marker first published after its retirement — a capture of the bytes before the removal — is not a
// revert of the removal); every board commit between two checks is walked, so a removal and its resurrection inside one step are both
// seen, and each is judged once — a tip the remote moved back to (a host rewind, F-BR-3, which INV-FF owns: no engine pushed it) is a
// commit judged before, never a resurrection; a commit a peer builds on it is new and judged (Plan 3 Task 16); the message names the author, path, written step and last location the oracle saw while the marker was an obligation. Two stores (TST-08): every hold id of a `hold` event is in exactly one peer's registry, its folded owner is that peer, no clone
// or the remote has a ref under refs/cowork-held/ or refs/worktree/cowork/, and no clone has <gitdir>/cowork/quarantine/ or
// <gitdir>/cowork/conflicts/.
//
// Cadence (R3-49): afterEveryOp rechecks the markers that may have moved — new and late-write markers, markers whose model path
// changed, markers on paths named by this step's op-log details and by its apply (written, deferred), publish (diff(tip, c)), hold,
// discard and repair events, markers last seen at live or held when the board tip changed, at registry when that peer's registry head
// changed or it landed a push, and every marker last seen on a disk (a disk changes without any event); atQuiescence scans every
// obligation and runs the two-stores check. A failure names the marker, its author, its path, the step it was written and the last
// location it was seen at.
//
// oracleHeldSecret (T-05, O-NOMARKER held side), atQuiescence: no blob of the bare remote (cat-file --batch-all-objects, unreachable
// objects included) holds a row starting `<<<<<<< cowork:`, `||||||| cowork:` or `>>>>>>> cowork:`, and none is an h1/s2 blob of a
// peer's local_only record (any state) unless it is also in the tree of a live code commit at a LIVE path; a record local_only only for
// its not-live name (a `portability` PATCH with no secret-like, quarantined, filter-failure or secret-scan cause, and not a marker
// companion) is outside that set (ruling R3-EF4-18, decided from the record test-side).
//
// Everything is read test-side with the oracle's own git runner (never ctx.git, whose calls INV-OID judges): refs straight from the
// ref files (loose, else packed-refs), the registry through holdsView.readRegistry, the board fold through Plan 2's Folder over the
// bare remote. The engine is read only through its inspection surfaces (inspect() and ChangeSets.openPaths()) and the SIM adapter's
// live-Engine handle (down or re-created) — never HoldRegistry, maskEntries, isDurable, Snapshotter state, a private field or a step function.
// The harness's own fault state is read through the SIM adapter's FaultFs (faultFsOf(...).lockRefuses: the share-none window, R3-EF4-9).
import { realpathSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readHeldAll, type HeldBlob } from '../../src/board/boardCommit.js';
import { Folder, type FoldedHold, type FoldState } from '../../src/board/fold.js';
import { isQuarantined, isSecretLike } from '../../src/data/scope.js';
import { PLAN2_REGION_SPEC } from '../../src/engine/deps.js';
import type { Engine, EngineInspection } from '../../src/engine/loop.js';
import { refNames, RELEASE_NAMESPACE, type RefNamespace } from '../../src/engine/refs.js';
import { enc } from '../../src/git/enc.js';
import { parseOid, type Oid } from '../../src/git/oid.js';
import { GitRepo } from '../../src/git/repo.js';
import type { GitRunner } from '../../src/git/runner.js';
import { QUIET_MS, UNTRACKED_RESCAN_MS } from '../../src/engine/snapshot.js';
import { creationDue } from '../../src/holds/mirror.js';
import { isTerminal, parseRecord, type HoldRecord } from '../../src/holds/record.js';
import type { TraceEvent } from '../../src/ports/trace.js';
import { validPathSyntax } from '../../src/sec/validators.js';
import { testRunner } from '../helpers/tmp.js';
import { faultFsOf, isRealEngine, realEngineOf } from './engineAdapter.js';
import { PARTITION_SUFFIX, type Oracle, type SimContext } from './harness.js';
import { readRegistry, type RegistrySnapshot } from './holdsView.js';
import { findMarkers, type MarkerModel, type MarkerOwner } from './markers.js';
import type { PeerClone } from './peers.js';

/** The SIM branch (harness.ts seeds `main`; engineAdapter's BRANCH). */
const BRANCH = 'main';
/** HLD-54 / R3-29: a not-applicable INCOMING record's creation op waits this long (mirror.ts CREATION_DELAY_MS). */
const CREATION_DELAY_MS = 60_000;
/** Trees whose path map and marker index are kept (live trees, snapshots and ready pairs of every peer). */
const TREE_KEEP = 64;

export type NolossLocation = 'live' | 'saved' | 'held' | 'registry' | 'local_only_disk' | 'author_disk' | 'discard';
export interface NolossFound { at: NolossLocation; detail: string; }

// ---- the oracle's own git ---------------------------------------------------------------------------------------------

let ownGit: GitRunner | null = null;
function runner(): GitRunner {
  ownGit ??= testRunner();
  return ownGit;
}

async function git(dir: string, args: string[], okCodes: readonly number[] = [0], stdin?: Buffer): Promise<{ code: number; stdout: Buffer }> {
  const r = await runner().run(args, { class: 'local', cwd: dir, ...(stdin === undefined ? {} : { stdin }) });
  if (!okCodes.includes(r.code)) throw new Error(`oracleNoloss: git ${args.slice(0, 3).join(' ')} in ${dir} failed (${r.code}): ${r.stderr.toString('utf8').trim().slice(0, 300)}`);
  return { code: r.code, stdout: r.stdout };
}

/** Where the bare remote is now (a partition renames remote.dir away). */
async function remoteDir(ctx: SimContext): Promise<string> {
  if ((await lstat(ctx.remote.dir).catch(() => null)) !== null) return ctx.remote.dir;
  return `${ctx.remote.dir}${PARTITION_SUFFIX}`;
}

/** A ref's oid read from the ref files of `gitDir` (loose, else packed-refs), null when absent. */
async function readRef(gitDir: string, ref: string): Promise<Oid | null> {
  const loose = await readFile(join(gitDir, ...ref.split('/'))).catch(() => null);
  if (loose !== null) {
    const text = loose.toString('utf8').trim();
    if (/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(text)) return parseOid(text);
  }
  const packed = await readFile(join(gitDir, 'packed-refs')).catch(() => null);
  if (packed !== null) {
    for (const line of packed.toString('utf8').split('\n')) {
      const sp = line.indexOf(' ');
      if (sp > 0 && !line.startsWith('#') && !line.startsWith('^') && line.slice(sp + 1).trim() === ref) return parseOid(line.slice(0, sp));
    }
  }
  if (loose !== null) {
    // Neither a plain oid nor packed: a symbolic ref or a ref being written; ask git.
    const r = await git(gitDir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], [0, 1]);
    return r.code === 0 ? parseOid(r.stdout.toString('utf8').trim()) : null;
  }
  return null;
}

// ---- blobs and their markers ----------------------------------------------------------------------------------------------

/** cat-file --batch of `oids` in `dir`: content by oid (a missing object is left out). */
async function readBlobs(dir: string, oids: readonly string[]): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const want = [...new Set(oids)];
  if (want.length === 0) return out;
  const buf = (await git(dir, ['cat-file', '--batch'], [0], Buffer.from(`${want.join('\n')}\n`, 'utf8'))).stdout;
  let at = 0;
  for (let i = 0; i < want.length && at < buf.length; i++) {
    const nl = buf.indexOf(0x0a, at);
    if (nl < 0) break;
    const header = buf.subarray(at, nl).toString('utf8').split(' ');
    if (header[1] === 'missing' || header.length < 3) {
      at = nl + 1;
      continue;
    }
    const size = Number(header[2]);
    out.set(header[0] as string, buf.subarray(nl + 1, nl + 1 + size));
    at = nl + 1 + size + 1;
  }
  return out;
}

// ---- the per-call cache (locateMarker's `cache`) --------------------------------------------------------------------------

interface LiveTip { board: Oid; live: Oid; tree: Oid; }
interface BoardView { holds: Record<string, FoldedHold>; held: Map<string, HeldBlob[]>; }
interface RecordRev { rev: number; held: string[]; }
interface Moment {
  key: string;
  dir: string;
  tip: LiveTip | null;
  /** peer name → its registry snapshot at this moment (read lazily). */
  regs: Map<string, RegistrySnapshot>;
  /** peer name → its inspection, null when its engine is down (read lazily). */
  ins: Map<string, EngineInspection | null>;
  /** peer name → ChangeSets.openPaths() of its running engine. */
  open: Map<string, ReadonlySet<string> | null>;
}
interface NolossCache {
  /** oid → its markers (content-addressed: valid in any repo). */
  blobs: Map<string, readonly string[]>;
  /** tree oid → (path → regular blob oid), the newest TREE_KEEP trees. */
  trees: Map<string, Map<string, string>>;
  /** tree oid → (marker → paths). */
  treeIdx: Map<string, Map<string, string[]>>;
  /** repo dir → the last tree indexed there (the next one in that repo is a diff-tree from it). */
  lastTree: Map<string, string>;
  /** board oid → its live code commit and tree. */
  tips: Map<string, LiveTip>;
  /** peer name → its registry snapshot at the head it was read at. */
  regs: Map<string, RegistrySnapshot>;
  boards: Map<string, BoardView>;
  lastFold: { board: Oid; state: FoldState } | null;
  /** `${peer}\0${id}` → the head the history was read at and every rev's held-side blobs. */
  history: Map<string, { head: string; revs: RecordRev[] }>;
  /** `${peer}\0${id}` → trace mark since which no stay-open condition was seen (null: open now). */
  closable: Map<string, number | null>;
  /** peer name → its last inspection (a down engine keeps the last one for the window conditions). */
  lastIns: Map<string, EngineInspection>;
  moment: Moment | null;
  /**
   * marker → its path, the trace length at the check that first saw it written there (null when that check was the oracle's first:
   * the write's time is then unknown, and neither fresh-write allowance applies) and its author's virtual mono at that check (at or after
   * the real write; the untracked-listing window's start, R3-EF4-2). Kept by oracleNoloss; a cold locateMarker has none.
   */
  writes: Map<string, { path: string; at: number | null; mono: number | undefined }>;
  /** peer name → the trace length at the last check that saw its engine down or re-created (a restart); kept by oracleNoloss. */
  downAt: Map<string, number>;
  /** peer name → the Engine object the last check saw (null: down), to see a kill and restart inside one step. */
  engineSeen: Map<string, Engine | null>;
  /**
   * `${peer}\0${path}` → null while the last check of the path saw the author's FaultFs refuse its reads (a share-none lock), then the
   * trace length at the first check that saw it released (R3-EF4-9: the window lasts until the author's next `iteration` event).
   */
  lockSeen: Map<string, number | null>;
  /** `${peer}\0${path}` → the restart point (downAt) for which a check found the path no longer unread (R3-EF4-10's window closed). */
  restartRead: Map<string, number>;
  /** peer id → index of its last `iteration` trace event, over the first `iterAt` events. */
  lastIter: Map<string, number>;
  iterAt: number;
  /** The board tip the rewind watch (observeRewind) saw last; kept by oracleNoloss, so a cold locateMarker never sees a rewind. */
  rewindAt: string | null;
  /** Board commits a host rewind took off the board's chain, while the tip does not reach them again (observeRewind). */
  rewound: Set<string>;
}

const caches = new WeakMap<object, NolossCache>();
function cacheOf(cache: unknown): NolossCache {
  const key = typeof cache === 'object' && cache !== null ? cache : {};
  let c = caches.get(key);
  if (c === undefined) {
    c = {
      blobs: new Map(), trees: new Map(), treeIdx: new Map(), lastTree: new Map(), tips: new Map(), regs: new Map(), boards: new Map(), lastFold: null,
      history: new Map(), closable: new Map(), lastIns: new Map(), moment: null,
      writes: new Map(), downAt: new Map(), engineSeen: new Map(), lockSeen: new Map(), restartRead: new Map(), lastIter: new Map(), iterAt: 0,
      rewindAt: null, rewound: new Set(),
    };
    caches.set(key, c);
  }
  return c;
}

async function blobMarkers(c: NolossCache, dir: string, oids: readonly string[]): Promise<void> {
  const missing = [...new Set(oids)].filter((o) => o !== 'ABSENT' && !c.blobs.has(o));
  if (missing.length === 0) return;
  const read = await readBlobs(dir, missing);
  for (const o of missing) {
    const b = read.get(o);
    if (b !== undefined) c.blobs.set(o, findMarkers(b));
  }
}

const markersOf = (c: NolossCache, oid: string): readonly string[] => c.blobs.get(oid) ?? [];

// ---- moments: what one check reads once -------------------------------------------------------------------------------------

function momentOf(ctx: SimContext, c: NolossCache): Moment | null {
  const key = `${ctx.opLog.length}/${ctx.trace.events.length}`;
  return c.moment !== null && c.moment.key === key ? c.moment : null;
}

async function moment(ctx: SimContext, ns: RefNamespace, c: NolossCache): Promise<Moment> {
  const have = momentOf(ctx, c);
  if (have !== null) return have;
  const dir = await remoteDir(ctx);
  const board = await readRef(dir, refNames(BRANCH, ns).remoteBoard);
  let tip: LiveTip | null = null;
  if (board !== null) {
    tip = c.tips.get(board) ?? null;
    if (tip === null) {
      const live = await liveCodeOf(dir, board);
      tip = { board, live, tree: await treeOf(dir, live) };
      c.tips.set(board, tip);
    }
  }
  c.moment ={ key: `${ctx.opLog.length}/${ctx.trace.events.length}`, dir, tip, regs: new Map(), ins: new Map(), open: new Map() };
  return c.moment;
}

async function liveCodeOf(dir: string, board: string): Promise<Oid> {
  const parents = (await git(dir, ['rev-list', '--no-walk', '--parents', '-n', '1', board])).stdout.toString('utf8').trim().split(' ');
  const live = parents[parents.length - 1];
  if (parents.length < 2 || live === undefined) throw new Error(`oracleNoloss: board commit ${board} has no parent`);
  return parseOid(live);
}

async function treeOf(dir: string, commit: string): Promise<Oid> {
  return parseOid((await git(dir, ['rev-parse', `${commit}^{tree}`])).stdout.toString('utf8').trim());
}

const peerByName = (ctx: SimContext, name: string): PeerClone | undefined => ctx.peers.find((p) => p.name === name);
const peerIndex = (ctx: SimContext, name: string): number => ctx.peers.findIndex((p) => p.name === name);

function engineOf(ctx: SimContext, name: string): Engine | null {
  const i = peerIndex(ctx, name);
  const sim = i < 0 ? undefined : ctx.engines[i];
  if (sim === undefined || !isRealEngine(sim)) return null;
  return realEngineOf(sim);
}

async function inspection(ctx: SimContext, c: NolossCache, m: Moment, name: string): Promise<EngineInspection | null> {
  if (m.ins.has(name)) return m.ins.get(name) ?? null;
  const e = engineOf(ctx, name);
  let ins: EngineInspection | null = null;
  if (e !== null) {
    try {
      ins = await e.inspect();
    } catch {
      ins = null;   // no state yet (a refused start)
    }
  }
  m.ins.set(name, ins);
  if (ins !== null) c.lastIns.set(name, ins);
  m.open.set(name, e === null || ins === null ? null : e.core.cs.openPaths());
  return ins;
}

/** Whether peer `name` has an `iteration` trace event at index ≥ `at` (its last one read incrementally from the trace). */
function iteratedSince(ctx: SimContext, c: NolossCache, name: string, at: number): boolean {
  const events = ctx.trace.events;
  if (c.iterAt > events.length) {
    c.lastIter.clear();
    c.iterAt = 0;
  }
  for (let i = c.iterAt; i < events.length; i++) {
    const e = events[i] as TraceEvent;
    if (e.kind === 'iteration') c.lastIter.set(e.peer, i);
  }
  c.iterAt = events.length;
  const pid = idOf(ctx, name);
  return pid !== null && (c.lastIter.get(pid) ?? -1) >= at;
}

/**
 * What this check sees of each peer's engine (the SIM adapter's live-Engine handle): down (no Engine: before its first start, between a
 * KilledAt and the restart) or re-created since the previous check (a kill and restart inside one step) records the trace length as the
 * peer's restart point — the restart allowance lasts until the peer's next `iteration` event. A first check knows no history: it records
 * only engines that are down now.
 */
function observePeers(ctx: SimContext, c: NolossCache, first: boolean): void {
  const at = ctx.trace.events.length;
  for (const p of ctx.peers) {
    const e = engineOf(ctx, p.name);
    if (e === null || (!first && c.engineSeen.has(p.name) && c.engineSeen.get(p.name) !== e)) c.downAt.set(p.name, at);
    c.engineSeen.set(p.name, e);
  }
}

async function registryOf(ctx: SimContext, c: NolossCache, m: Moment, name: string): Promise<RegistrySnapshot> {
  const have = m.regs.get(name);
  if (have !== undefined) return have;
  const p = peerByName(ctx, name);
  if (p === undefined) return { head: null, records: new Map(), local: null };
  const head = await readRef(join(p.dir, '.git'), `refs/cowork-local/${enc(BRANCH)}/holds`);
  const known = c.regs.get(name);
  let snap: RegistrySnapshot;
  if (known !== undefined && known.head === head) snap = known;
  else {
    snap = head === null ? { head: null, records: new Map<string, HoldRecord>(), local: null } : await readRegistry(runner(), p.dir, BRANCH, head);
    c.regs.set(name, snap);
  }
  m.regs.set(name, snap);
  return snap;
}

// ---- 1 live: the per-tree marker index ------------------------------------------------------------------------------------

const REGULAR = new Set(['100644', '100755']);

async function treeMap(c: NolossCache, dir: string, tree: string): Promise<Map<string, string>> {
  const have = c.trees.get(tree);
  if (have !== undefined) return have;
  let map: Map<string, string> | null = null;
  const lastHere = c.lastTree.get(dir);
  const prev = lastHere === undefined ? undefined : c.trees.get(lastHere);
  if (prev !== undefined && lastHere !== undefined) {
    // Incremental: the last tree indexed in this repo plus diff-tree's changes (a tree gc removed falls back to ls-tree).
    const d = await git(dir, ['diff-tree', '-r', '-z', '--no-renames', lastHere, tree], [0, 128]);
    if (d.code === 0) {
      map = new Map(prev);
      const out = d.stdout.toString('utf8').split('\0');
      for (let i = 0; i + 1 < out.length; i += 2) {
        const meta = out[i] as string;
        const path = out[i + 1] as string;
        if (!meta.startsWith(':')) {
          i -= 1;   // resync (never expected: -z pairs meta and path)
          continue;
        }
        const [, dstMode = '', , dstOid = ''] = meta.slice(1).split(' ');
        if (REGULAR.has(dstMode)) map.set(path, dstOid);
        else map.delete(path);
      }
    }
  }
  if (map === null) {
    map = new Map();
    const out = (await git(dir, ['ls-tree', '-r', '-z', tree])).stdout.toString('utf8');
    for (const rec of out.split('\0')) {
      if (rec.length === 0) continue;
      const tab = rec.indexOf('\t');
      const [mode = '', , oid = ''] = rec.slice(0, tab).split(' ');
      if (REGULAR.has(mode)) map.set(rec.slice(tab + 1), oid);
    }
  }
  c.trees.set(tree, map);
  c.lastTree.set(dir, tree);
  while (c.trees.size > TREE_KEEP) {
    const oldest = c.trees.keys().next().value as string;
    c.trees.delete(oldest);
    c.treeIdx.delete(oldest);
  }
  return map;
}

/** marker → paths of the tree (every blob read once per oid, ever). */
async function treeIndex(c: NolossCache, dir: string, tree: string): Promise<Map<string, string[]>> {
  const have = c.treeIdx.get(tree);
  if (have !== undefined) return have;
  const map = await treeMap(c, dir, tree);
  await blobMarkers(c, dir, [...map.values()]);
  const idx = new Map<string, string[]>();
  for (const [path, oid] of map) {
    for (const mk of markersOf(c, oid)) {
      const l = idx.get(mk);
      if (l === undefined) idx.set(mk, [path]);
      else l.push(path);
    }
  }
  c.treeIdx.set(tree, idx);
  return idx;
}

// ---- 3 held: the board tip's fold and held/ subtrees ----------------------------------------------------------------------

function remoteRepo(dir: string): GitRepo {
  return new GitRepo(runner(), { workTree: dir, gitDir: dir, coworkDir: join(dir, 'cowork-oracle') }, () => ({
    attrTree: null, filterDrivers: [], identity: { name: 'SIM reader', email: 'reader@cowork.invalid' }, wallMs: () => 0,
  }));
}

/** A peer id that is nobody's: the Folder's `self` only labels own rejections, which a test-side fold ignores. */
const READER = '0'.repeat(32);

async function boardView(c: NolossCache, dir: string, board: Oid): Promise<BoardView> {
  const have = c.boards.get(board);
  if (have !== undefined) return have;
  const repo = remoteRepo(dir);
  const folded = await new Folder(repo, READER).foldTo(board, c.lastFold, PLAN2_REGION_SPEC);
  c.lastFold = { board, state: folded.state };
  // A copy: a later fold continued from this state must not change the view kept for this board.
  const view: BoardView = { holds: structuredClone(folded.state.holds), held: await readHeldAll(repo, board) };
  if (c.boards.size > TREE_KEEP) c.boards.delete(c.boards.keys().next().value as string);
  c.boards.set(board, view);
  return view;
}

// ---- 6 registry: record history and the pre-mirror window ------------------------------------------------------------------

/** The held side of a record: its h1 (PATCH, PIN, INCOMING) or s2 (K4 stage) blob oids, ABSENT left out. */
export function heldSide(r: HoldRecord): Array<{ stage: 'h1' | 's2'; path: string; oid: string }> {
  const out: Array<{ stage: 'h1' | 's2'; path: string; oid: string }> = [];
  const b = r.blobs as Record<string, Record<string, string>>;
  const stage = 'h1' in b ? 'h1' : 's2';
  const m = b[stage] ?? {};
  for (const path of Object.keys(m).sort()) {
    const oid = m[path] as string;
    if (oid !== 'ABSENT') out.push({ stage, path, oid });
  }
  return out;
}

/** Every rev of record `id` in the peer's registry history (git log of records/<id>.json), with its held-side blob oids. */
async function recordRevs(c: NolossCache, peerDir: string, id: string, head: string, key: string): Promise<RecordRev[]> {
  const have = c.history.get(key);
  if (have !== undefined && have.head === head) return have.revs;
  let revs: RecordRev[] = [];
  let range = [head];
  if (have !== undefined) {
    const anc = await git(peerDir, ['merge-base', '--is-ancestor', have.head, head], [0, 1]);
    if (anc.code === 0) {
      revs = [...have.revs];
      range = [head, `^${have.head}`];
    }
  }
  const out = (await git(peerDir, ['log', '--reverse', '--format=%x01%H', '--raw', '--no-abbrev', ...range, '--', `records/${id}.json`])).stdout.toString('utf8');
  const blobs: string[] = [];
  for (const line of out.split('\n')) {
    if (!line.startsWith(':')) continue;
    const fields = line.slice(1).split('\t')[0]?.split(' ') ?? [];
    const dst = fields[3];
    if (dst !== undefined && !/^0+$/.test(dst)) blobs.push(dst);
  }
  const read = await readBlobs(peerDir, blobs);
  const held: string[] = [];
  for (const o of blobs) {
    const b = read.get(o);
    if (b === undefined) continue;
    const r = parseRecord(b);
    const side = heldSide(r).map((x) => x.oid);
    held.push(...side);
    revs.push({ rev: r.rev, held: side });
  }
  await blobMarkers(c, peerDir, held);
  c.history.set(key, { head, revs });
  return revs;
}

const nameOf = (ctx: SimContext, peerId: string): string => ctx.trace.names.get(peerId) ?? peerId;
function idOf(ctx: SimContext, name: string): string | null {
  for (const [id, n] of ctx.trace.names) if (n === name) return id;
  return null;
}

type PushEvent = Extract<TraceEvent, { kind: 'push' }>;
type MirrorEvent = Extract<TraceEvent, { kind: 'mirror' }>;

/** Whether a stay-open condition holds now for record r of peer `name` (inspection, else the last one; none known: open). */
async function stayOpen(ctx: SimContext, c: NolossCache, m: Moment, name: string, r: HoldRecord): Promise<boolean> {
  const ins = (await inspection(ctx, c, m, name)) ?? c.lastIns.get(name) ?? null;
  if (ins === null) return true;
  if (ins.publishPause === 'OFFLINE') return true;
  if ((ins.mirror[r.id]?.rejected ?? null) !== null) return true;
  return !creationDue(r, ins.holdAgeMs[r.id] ?? 0);
}

/**
 * The trace mark from which a landed push that does not list r is a missed mirror (null: a stay-open condition holds now). First seen
 * clear: a not-applicable INCOMING record counts pushes from the first owner event at or after the virtual mono it turned 60 s old
 * (TraceRecorder.monoAt), every other record from the start; later: from the check that saw the conditions clear after a stay-open one.
 * The mark never applies to the push that closes the window (windowOf).
 */
async function closableMark(ctx: SimContext, c: NolossCache, m: Moment, name: string, r: HoldRecord, key: string): Promise<number | null> {
  const open = await stayOpen(ctx, c, m, name, r);
  if (open) {
    c.closable.set(key, null);
    return null;
  }
  if (c.closable.has(key)) {
    const v = c.closable.get(key) ?? null;
    if (v !== null) return v;
    const now = ctx.trace.events.length;
    c.closable.set(key, now);
    return now;
  }
  let mark = 0;
  const ins = c.lastIns.get(name);
  const age = ins?.holdAgeMs[r.id];
  if (r.kind === 'INCOMING' && age !== undefined && !creationDue(r, 0)) {
    const clock = ctx.clocks.get(name);
    const due = (clock?.monoMs() ?? 0) - (age - CREATION_DELAY_MS);
    const pid = idOf(ctx, name);
    mark = ctx.trace.events.length;
    for (let i = 0; i < ctx.trace.events.length; i++) {
      const e = ctx.trace.events[i] as TraceEvent;
      if (e.peer !== pid) continue;
      const mono = ctx.trace.monoAt(i);
      if (mono !== null && mono >= due) {
        mark = i;
        break;
      }
    }
  }
  c.closable.set(key, mark);
  return mark;
}

/**
 * The window of marker `mk` in record r of peer `name`: 'open', 'closed' (mirrored) or a missed-mirror message. rev0 = the first rev
 * whose held side holds mk; H = the `hold` event of (r, rev0). Open while a stay-open condition holds now. Otherwise, over the owner's
 * landed publish/board_only pushes after H, in trace order: the first whose mirror lists r at a rev >= rev0 closes the window, wherever it
 * lies (a stay-open condition seen earlier never skips it: a push listing r cannot land while one holds — Task 15 fix round 1); one of a
 * later iteration (an `iteration` event of the owner since H) at or after the closable mark that does not list r, before any that does, is
 * a missed mirror; none yet: open.
 */
async function windowOf(ctx: SimContext, c: NolossCache, m: Moment, name: string, peerDir: string, head: string, r: HoldRecord, mk: string): Promise<'open' | 'closed' | { missed: string }> {
  const key = `${name}\0${r.id}`;
  const revs = await recordRevs(c, peerDir, r.id, head, key);
  const rev0 = revs.find((x) => x.held.some((o) => markersOf(c, o).includes(mk)))?.rev ?? r.rev;
  const pid = idOf(ctx, name);
  if (pid === null) return 'open';
  const events = ctx.trace.events;
  let H = -1;
  for (let i = 0; i < events.length; i++) {
    const e = events[i] as TraceEvent;
    if (e.kind === 'hold' && e.peer === pid && e.id === r.id && e.rev >= rev0) {
      H = i;
      break;
    }
  }
  if (H < 0) return 'open';
  const mark = await closableMark(ctx, c, m, name, r, key);
  if (mark === null) return 'open';
  // Pushes and mirror events of the owner after H, in trace order (a push follows its own mirror event: publishStep emits `mirror`, then
  // governedPush emits `push`).
  let iterated = false;
  const mirrors = new Map<string, MirrorEvent>();
  for (let i = H + 1; i < events.length; i++) {
    const e = events[i] as TraceEvent;
    if (e.peer !== pid) continue;
    if (e.kind === 'iteration') iterated = true;
    else if (e.kind === 'mirror') mirrors.set(e.bnew, e);
    else if (e.kind === 'push') {
      const p = e as PushEvent;
      if (p.outcome !== 'landed' || p.bnew === null || (p.purpose !== 'publish' && p.purpose !== 'board_only')) continue;
      // A push a host rewind took off the board (observeRewind) neither closes the window nor misses it: its mirror is gone with it.
      if (c.rewound.has(p.bnew)) continue;
      // Closed: a landed push whose mirror lists r at a rev >= rev0 (never skipped by the mark).
      if (mirrors.get(p.bnew)?.holds.some((h) => h.id === r.id && h.rev >= rev0) === true) return 'closed';
      // Missed: a landed push of a later iteration (an `iteration` event of the owner since H) that does not carry r — mirrorSync drafts
      // at the start of every publish step, so that window had r's op to send. A push of H's own iteration may precede the draft (a
      // record Algorithm P made after mirrorSync rides the next window); a push before the closable mark was excused by a stay-open
      // condition (or the not-applicable INCOMING record's due point).
      if (iterated && i >= mark) {
        return {
          missed: `missed mirror: ${name}'s record ${r.id} holds ${mk} since rev ${rev0} (hold event #${H}), and ${name}'s landed push #${i} `
            + `(bnew ${p.bnew}) of a later iteration does not list it at a rev >= ${rev0}`,
        };
      }
    }
  }
  return 'open';
}

/**
 * The rewind watch (Plan 3 Task 16 fix round 1; F-BR-3): when the remote's board tip moved back onto the chain this instance saw last
 * (the new tip reaches no commit the previous one did not — a server-side ref move INV-FF owns, never an engine push; the crash matrix's
 * rewind lead-ins make one), every commit above the new tip on the old chain left the board, and with it the held/ mirrors those pushes
 * landed. Such a push neither closes a pre-mirror window nor misses one (windowOf), so the record's held side counts in its owner's
 * registry again until a push on the board's chain mirrors it (or one of the owner's misses it); a commit the tip reaches again (the host
 * puts the ref back, a push restores the chain) leaves the set. Seen only by an instance that watched the board before and after the move.
 */
async function observeRewind(c: NolossCache, m: Moment): Promise<void> {
  const tip = m.tip?.board ?? null;
  if (tip === null) return;   // no board (or the remote partitioned away): nothing to compare
  const prev = c.rewindAt;
  c.rewindAt = tip;
  if (prev === null || prev === tip) return;
  for (const b of [...c.rewound]) {
    const back = await git(m.dir, ['merge-base', '--is-ancestor', b, tip], [0, 1, 128]);
    if (back.code === 0) c.rewound.delete(b);
  }
  const fresh = await git(m.dir, ['rev-list', '-n', '1', tip, `^${prev}`], [0, 128]);
  if (fresh.code !== 0 || fresh.stdout.toString('utf8').trim() !== '') return;
  const gone = await git(m.dir, ['rev-list', prev, `^${tip}`], [0, 128]);
  if (gone.code !== 0) return;
  for (const l of gone.stdout.toString('utf8').split('\n')) if (l.trim().length > 0) c.rewound.add(l.trim());
}

// ---- the search ------------------------------------------------------------------------------------------------------------

interface SearchOptions { noDisk?: boolean; }
type Located = NolossFound | { missed: string } | null;

async function readDisk(p: PeerClone, path: string): Promise<Buffer | null> {
  try {
    return await readFile(join(p.dir, ...path.split('/')));
  } catch {
    return null;
  }
}

async function search(ctx: SimContext, ns: RefNamespace, mk: string, owner: MarkerOwner, c: NolossCache, o: SearchOptions = {}): Promise<Located> {
  const m = await moment(ctx, ns, c);
  // 1 live
  if (m.tip !== null) {
    const idx = await treeIndex(c, m.dir, m.tip.tree);
    const paths = idx.get(mk);
    if (paths !== undefined && paths.length > 0) {
      const at = paths.includes(owner.path) ? owner.path : (paths[0] as string);
      return { at: 'live', detail: `live ${at} @ ${m.tip.live.slice(0, 12)}` };
    }
  }
  // 2 saved: vacuous until Plan 7.
  // 3 held
  if (m.tip !== null) {
    const bv = await boardView(c, m.dir, m.tip.board);
    const cand: HeldBlob[] = [];
    for (const [id, blobs] of bv.held) {
      const f = bv.holds[id];
      if (f === undefined || isTerminalState(f.state)) continue;
      for (const b of blobs) if (b.stage === 'h1' || b.stage === 's2') cand.push(b);
    }
    await blobMarkers(c, m.dir, cand.map((b) => b.oid));
    const hit = cand.find((b) => b.path === owner.path && markersOf(c, b.oid).includes(mk)) ?? cand.find((b) => markersOf(c, b.oid).includes(mk));
    if (hit !== undefined) {
      const id = [...bv.held].find(([, bs]) => bs.includes(hit))?.[0] ?? '?';
      return { at: 'held', detail: `held ${id}/${hit.stage}/${hit.path}` };
    }
  }
  // 4 local_only_disk
  if (o.noDisk !== true) {
    for (const p of ctx.peers) {
      const reg = await registryOf(ctx, c, m, p.name);
      for (const r of reg.records.values()) {
        if (isTerminal(r) || !r.local_only) continue;
        for (const path of r.paths) {
          const b = await readDisk(p, path);
          if (b !== null && findMarkers(b).includes(mk)) return { at: 'local_only_disk', detail: `local_only_disk ${p.name}:${path} (${r.id})` };
        }
      }
    }
  }
  // 5 author_disk
  const author = peerByName(ctx, owner.peer);
  if (o.noDisk !== true && author !== undefined) {
    const b = await readDisk(author, owner.path);
    const onDisk = b === null ? [] : findMarkers(b);
    if (onDisk.includes(mk)) {
      const why = await authorCounts(ctx, c, m, author, owner.path, mk);
      if (why !== null) return { at: 'author_disk', detail: `author_disk ${author.name}:${owner.path} (${why})` };
    }
  }
  // 6 registry
  let missed: string | null = null;
  for (const p of ctx.peers) {
    const reg = await registryOf(ctx, c, m, p.name);
    if (reg.head === null) continue;
    const companions = reg.local?.companions ?? {};
    const hits: Array<{ r: HoldRecord; stage: string; path: string }> = [];
    for (const r of reg.records.values()) {
      if (isTerminal(r)) continue;
      const side = heldSide(r);
      await blobMarkers(c, p.dir, side.map((x) => x.oid));
      for (const x of side) if (markersOf(c, x.oid).includes(mk)) hits.push({ r, stage: x.stage, path: x.path });
    }
    // A marker companion's h1 counts always: it is reported first, whatever other record of the peer also holds the marker.
    const companion = hits.find((h) => Object.hasOwn(companions, h.r.id));
    if (companion !== undefined) return { at: 'registry', detail: `registry ${p.name} ${companion.r.id} rev ${companion.r.rev} ${companion.stage}/${companion.path} (marker companion)` };
    for (const h of hits) {
      if (h.r.local_only) continue;
      const w = await windowOf(ctx, c, m, p.name, p.dir, reg.head, h.r, mk);
      if (w === 'open') return { at: 'registry', detail: `registry ${p.name} ${h.r.id} rev ${h.r.rev} ${h.stage}/${h.path} (pre-mirror window open)` };
      if (w !== 'closed') {
        missed ??= w.missed;
      }
    }
  }
  return missed === null ? null : { missed };
}

const TERMINAL = new Set(['SUBSUMED', 'GONE', 'RESOLVED_PUBLISH', 'RESOLVED_DISCARD']);
const isTerminalState = (s: string): boolean => TERMINAL.has(s);

/**
 * Why the author's disk counts for `mk` at `path` (R3-48 and the allowances ruled in Task 15 fix round 1), or null. Every window is
 * bounded by the trace's `iteration` events or by the engine's own state: no allowance reads the engine's private fields or its snapshot.
 */
async function authorCounts(ctx: SimContext, c: NolossCache, m: Moment, author: PeerClone, path: string, mk: string): Promise<string | null> {
  // R3-EF4-9's lock is observed at every check of the path, whichever location answers below: the release is dated by the first check
  // that saw it released after one that saw it held.
  const lockKey = `${author.name}\0${path}`;
  if (readLocked(ctx, author, path)) c.lockSeen.set(lockKey, null);
  else if (c.lockSeen.get(lockKey) === null) c.lockSeen.set(lockKey, ctx.trace.events.length);
  const ins = await inspection(ctx, c, m, author.name);
  if (ins === null) {
    c.downAt.set(author.name, ctx.trace.events.length);   // a refused start counts as down: its restart point is now
    return 'engine down';
  }
  // A restarted engine re-forms its open human or recovered CS at its first tick (R-01): until its next iteration after the restart.
  const down = c.downAt.get(author.name);
  if (down !== undefined && !iteratedSince(ctx, c, author.name, down)) return 'restarted, no iteration since';
  // R3-EF4-10, judged here before any location answers, so the window closes at the first check that finds the path read since the restart.
  const unread = down !== undefined && (await restartUnread(ctx, c, author, path, down));
  if (ins.freeze.includes('INCIDENT')) return 'INCIDENT';
  if (m.open.get(author.name)?.has(path) === true) return 'open CS';
  // The author's own non-terminal ON_DISK record that is local_only or CONFLICTED covers the path: its residence is the disk (HLD-01).
  // Any other whole-path guard is no allowance (controller ruling, Task 15 fix round 1).
  const reg = await registryOf(ctx, c, m, author.name);
  for (const r of reg.records.values()) {
    if (isTerminal(r) || r.residence !== 'ON_DISK' || !r.paths.includes(path)) continue;
    if (r.local_only) return `ON_DISK local_only ${r.id}`;
    if (r.state === 'CONFLICTED') return `ON_DISK CONFLICTED ${r.id}`;
  }
  // A captured, unpublished ready pair that carries the marker: its R at the path holds it (a pair's `paths` are the union of its R and
  // A trees, all paths for a start capture, so the pair is asked for the bytes, not for the name).
  for (const pair of ins.ready) {
    const oid = (await treeMap(c, author.dir, pair.R)).get(path);
    if (oid === undefined) continue;
    await blobMarkers(c, author.dir, [oid]);
    if (markersOf(c, oid).includes(mk)) return `ready ${pair.csId}`;
  }
  // R3-EF4-9 (a reading of R3-48, as R3-EF4-2): a file the harness holds without read sharing (F-FS-1 lock_share_none; the author's FaultFs
  // refuses its reads) is UNREADABLE to every tick (ENG-24: a per-loop exclusion, S_pub[p] := A[p], never in the dirty set), so an edit no
  // tick staged before the lock is in no CS and no pair, and from 60 s its `unreadable` PIN holds h1 = the private-index blob (HLD-32; A[p]
  // for a never-staged edit): the author's working file is its only copy. It counts while the lock holds, and after the release until the
  // author's first iteration since the check that saw it released (that iteration's tick reads it into the open CS). The lock state is the
  // harness's own (FaultFs), never the engine's; a check that never saw the lock grants no post-release window.
  const lock = c.lockSeen.get(lockKey);
  if (lock === null) return 'share-none lock, unreadable to its engine';
  if (lock !== undefined) {
    if (!iteratedSince(ctx, c, author.name, lock)) return 'share-none lock released, no iteration of its author since';
    c.lockSeen.delete(lockKey);
  }
  // R3-EF4-10 (a reading of R3-48 amending Task 15 fix round 1's restart window): a restart hands the first tick the paths it re-forms
  // (R-01), and a path that tick did not read stays handed over until a tick reads it (EF2 fix round 1 F2) — in no open CS meanwhile.
  if (unread) return 'restarted, future mtime unread at every tick since (R-01 handover)';
  // A fresh write: the marker was written at this path and its author has no iteration since the check that first saw the write.
  const w = c.writes.get(mk);
  if (w !== undefined && w.path === path && w.at !== null && !iteratedSince(ctx, c, author.name, w.at)) return 'fresh write, no iteration of its author since';
  // R3-EF4-2: a dated write at a path absent from the author's A waits for the snapshot's untracked-listing gate (a watched directory's
  // lstat change, else the UNTRACKED_RESCAN_MS backstop since the last listing): until the author's first iteration after one at or past
  // the backstop. A path in A (a tracked edit) and an undated write (a fresh oracle's first check) get no such window.
  if (w !== undefined && w.path === path && w.at !== null && w.mono !== undefined && !(await treeMap(c, author.dir, ins.aTree)).has(path)
    && !iteratedPastBackstop(ctx, author.name, w.at, w.mono + UNTRACKED_RESCAN_MS)) return 'fresh untracked write, within the untracked-listing backstop';
  return null;
}

/**
 * Whether peer `name` has an `iteration` trace event at index ≥ `at` whose virtual mono (TraceRecorder.monoAt; unknown counts as past)
 * is ≥ `bound`, followed by another `iteration` event of that peer: R3-EF4-2's window is then closed.
 */
function iteratedPastBackstop(ctx: SimContext, name: string, at: number, bound: number): boolean {
  const pid = idOf(ctx, name);
  if (pid === null) return false;
  const events = ctx.trace.events;
  let past = false;
  for (let i = Math.max(0, at); i < events.length; i++) {
    const e = events[i] as TraceEvent;
    if (e.kind !== 'iteration' || e.peer !== pid) continue;
    if (past) return true;
    if ((ctx.trace.monoAt(i) ?? Number.POSITIVE_INFINITY) >= bound) past = true;
  }
  return false;
}

/**
 * Whether the author's file system refuses a read of `path` now (R3-EF4-9): the SIM's FaultFs (one per peer, kept across restarts — the
 * harness's fault state, not the engine's) holds a share-none lock on it. Asked for both spellings of the work file, the real path (the
 * one opLock locks: host separators under the engine's own work-tree root) and the clone's own; a peer without a real engine has none.
 */
function readLocked(ctx: SimContext, author: PeerClone, path: string): boolean {
  const i = peerIndex(ctx, author.name);
  const sim = i < 0 ? undefined : ctx.engines[i];
  if (sim === undefined || !isRealEngine(sim)) return false;
  const fs = faultFsOf(sim);
  const rel = path.split('/');
  let real = author.dir;
  try {
    real = realpathSync.native(author.dir);
  } catch {
    // the clone's own spelling only
  }
  return fs.lockRefuses('readFile', join(real, ...rel)) || fs.lockRefuses('readFile', join(author.dir, ...rel));
}

/**
 * R3-EF4-10: whether every tick of the author since its restart at `down` may have excluded `path` for a future mtime, derived test-side
 * (never from the engine's flowInputs: Task 10's carry, an oracle does not trust the engine under test). 01-engine §3.8 step 2 reads a
 * stat whose mtime is ahead of the wall clock only once it stayed unchanged QUIET_MS Δmono since its first sighting, and the restart's
 * reseed forgets every sighting: the first tick since the restart sights it, and a tick at least QUIET_MS after that one reads it.
 * Unread while the working file's mtime is ahead of the author's virtual wall now (then also at every earlier tick) and no author
 * iteration since the restart's first is QUIET_MS past it and followed by another (that later iteration's tick ran after the earlier one's
 * event, so ≥ QUIET_MS after the first tick). Closed for this restart at the first check that finds it otherwise: once the predicate is
 * false the window never re-opens until a newer restart (a later write that is ahead again is the fresh-write window's).
 */
async function restartUnread(ctx: SimContext, c: NolossCache, author: PeerClone, path: string, down: number): Promise<boolean> {
  const key = `${author.name}\0${path}`;
  if (c.restartRead.get(key) === down) return false;
  const unread = !quietPeriodPassed(ctx, author.name, down) && (await futureMtime(ctx, author, path));
  if (!unread) c.restartRead.set(key, down);
  return unread;
}

/** Whether the author's first `iteration` event at index ≥ `down` is followed by one QUIET_MS (virtual mono) past it and another after. */
function quietPeriodPassed(ctx: SimContext, name: string, down: number): boolean {
  const pid = idOf(ctx, name);
  if (pid === null) return true;
  const events = ctx.trace.events;
  for (let i = Math.max(0, down); i < events.length; i++) {
    const e = events[i] as TraceEvent;
    if (e.kind !== 'iteration' || e.peer !== pid) continue;
    const first = ctx.trace.monoAt(i);
    return first === null || iteratedPastBackstop(ctx, name, i, first + QUIET_MS);
  }
  return false;
}

/** Whether the author's working file of `path` has an mtime ahead of the author's virtual wall clock (the engine's own comparison, ms). */
async function futureMtime(ctx: SimContext, author: PeerClone, path: string): Promise<boolean> {
  const wall = ctx.clocks.get(author.name)?.wallMs();
  if (wall === undefined) return false;
  const st = await lstat(join(author.dir, ...path.split('/')), { bigint: true }).catch(() => null);
  return st !== null && st.isFile() && Number(st.mtimeNs / 1_000_000n) > wall;
}

/**
 * The first location holding marker `m` at this step in the search order above, or null (a missed mirror is null here; oracleNoloss
 * reports it). `cache` carries the per-tree marker index and the pre-mirror windows between calls: pass the same object to reuse them,
 * a fresh `{}` for a cold search.
 */
export async function locateMarker(ctx: SimContext, ns: RefNamespace, m: string, owner: { peer: string; path: string }, cache: unknown): Promise<{ at: NolossLocation; detail: string } | null> {
  const r = await search(ctx, ns, m, owner, cacheOf(cache));
  return r === null || 'missed' in r ? null : r;
}

// ---- the oracle ---------------------------------------------------------------------------------------------------------

interface Seen { at: NolossFound | null; path: string; step: number; author: string; }
interface RunState {
  cache: object;
  last: Map<string, Seen>;
  traceAt: number;
  opLogAt: number;
  tip: string | null;
  regHeads: Map<string, string | null>;
  discarded: Set<string>;
  /**
   * Board commits walked for the resurrection clause, and per retired marker what the board did with it since its retirement: 'unseen'
   * (not in live_code yet), 'present', 'left' (present, then gone). Only 'left' → present fails: a marker first published after its
   * retirement (a start capture of the pre-retirement bytes, a ready pair captured before the removal) has not been reverted.
   */
  boardAt: string | null;
  left: Map<string, 'unseen' | 'present' | 'left'>;
  /**
   * Board commits already judged (Plan 3 Task 16): each is judged once. A tip the remote moved back to — onto a commit judged before, or
   * an ancestor of the board last walked (a host rewind, F-BR-3: a server-side ref move INV-FF owns, never an engine push) — is not
   * judged again; it only lets a marker retired since go from 'unseen' to 'present'. Every commit a peer pushes on top is new.
   */
  judged: Set<string>;
  /** publish event index → its code paths (diff-tree tip c). */
  publishPaths: Map<number, string[]>;
  /** late-write marker → the trace length when the oracle first saw it noted (its check waits for the author's next iteration). */
  lateSince: Map<string, number>;
  /** Checks run so far (the first knows no history: it dates no write and sees no restart). */
  checks: number;
  /** retired marker → what the oracle last saw of it while it was an obligation (the resurrection message names it). */
  retiredSeen: Map<string, Seen>;
}

export interface NolossOracle extends Oracle {
  /** The location each obligation was last seen at by the incremental check (null: nowhere). */
  locations(ctx: SimContext): ReadonlyMap<string, NolossFound | null>;
  /**
   * A full scan of every obligation now (the run's caches — tree indexes, record histories, the windows' observed stay-open marks — but
   * every marker searched afresh), leaving the incremental check's last locations alone: the verdict and every location.
   */
  fullScan(ctx: SimContext): Promise<{ verdict: string | null; locations: Map<string, NolossFound | null> }>;
}

function writtenStep(ctx: SimContext, mk: string): number {
  for (const e of ctx.opLog) if (e.detail.includes(mk)) return e.step;
  return ctx.opLog[ctx.opLog.length - 1]?.step ?? -1;
}

const show = (f: NolossFound | null): string => (f === null ? 'nowhere' : `${f.at} (${f.detail})`);

function lossMessage(mk: string, owner: MarkerOwner, seen: Seen | undefined, step: number): string {
  return `INV-NOLOSS: marker ${mk} (author ${owner.peer}, path ${owner.path}, written at step ${seen?.step ?? step}) is in no location; last seen at ${show(seen?.at ?? null)}`;
}

async function codePaths(ctx: SimContext, e: Extract<TraceEvent, { kind: 'publish' }>): Promise<string[]> {
  if (e.c === null) return [];
  const p = peerByName(ctx, nameOf(ctx, e.peer));
  if (p === undefined) return [];
  const r = await git(p.dir, ['diff-tree', '-r', '-z', '--no-renames', '--name-only', e.tip, e.c], [0, 128]);
  return r.code === 0 ? r.stdout.toString('utf8').split('\0').filter((x) => x.length > 0) : [];
}

/** INV-NOLOSS (R3-48, R3-49, R3-64): afterEveryOp incremental, atQuiescence a full scan plus the two-stores check. */
export function oracleNoloss(markers: MarkerModel, ns: RefNamespace = RELEASE_NAMESPACE): NolossOracle {
  const runs = new WeakMap<SimContext, RunState>();
  const stateOf = (ctx: SimContext): RunState => {
    let s = runs.get(ctx);
    if (s === undefined) {
      s = {
        cache: {}, last: new Map(), traceAt: 0, opLogAt: 0, tip: null, regHeads: new Map(), discarded: new Set(), boardAt: null, left: new Map(), publishPaths: new Map(),
        lateSince: new Map(), checks: 0, retiredSeen: new Map(), judged: new Set(),
      };
      runs.set(ctx, s);
    }
    return s;
  };

  /**
   * A late write is judged from the author's first iteration after the oracle saw it noted (ENG-35: the writer settles a write through a
   * .old handle at its next step, as Plan 2's ring late-write PATCH comes; Task 13's F-ED-4 test checks it "by the next step"): before
   * that its bytes are only in the .old file, which no location reads.
   */
  const latePending = (ctx: SimContext, s: RunState, mk: string, author: string): boolean => {
    if (!markers.lateWrites().has(mk)) return false;
    let since = s.lateSince.get(mk);
    if (since === undefined) {
      since = ctx.trace.events.length;
      s.lateSince.set(mk, since);
    }
    const pid = idOf(ctx, author);
    for (let i = since; i < ctx.trace.events.length; i++) {
      const e = ctx.trace.events[i] as TraceEvent;
      if (e.kind === 'iteration' && e.peer === pid) return false;
    }
    return true;
  };

  /** Locates `mk` and records it; a failure message or null. */
  const check = async (ctx: SimContext, s: RunState, mk: string, owner: MarkerOwner, step: number): Promise<string | null> => {
    const c = cacheOf(s.cache);
    const late = markers.lateWrites().has(mk);
    if (latePending(ctx, s, mk, owner.peer)) return null;
    const r = await search(ctx, ns, mk, owner, c, late ? { noDisk: true } : {});
    const prev = s.last.get(mk);
    if (r !== null && 'missed' in r) return `INV-NOLOSS: marker ${mk} (author ${owner.peer}, path ${owner.path}, written at step ${prev?.step ?? step}): ${r.missed}`;
    if (r === null) {
      if (late) return `INV-NOLOSS: late write ${mk} (author ${owner.peer}, path ${owner.path}, written through a .old handle at step ${prev?.step ?? step}) is not in a hold record (held or registry) nor live; last seen at ${show(prev?.at ?? null)}`;
      return lossMessage(mk, owner, prev, step);
    }
    s.last.set(mk, { at: r, path: owner.path, step: prev?.step ?? step, author: owner.peer });
    return null;
  };

  const verifyDiscards = async (ctx: SimContext, s: RunState, all: boolean): Promise<string | null> => {
    const c = cacheOf(s.cache);
    const m = await moment(ctx, ns, c);
    for (const [mk, id] of markers.discarded()) {
      if (!all && s.discarded.has(mk)) continue;
      s.discarded.add(mk);
      let owner: PeerClone | null = null;
      let rec: HoldRecord | undefined;
      for (const p of ctx.peers) {
        const r = (await registryOf(ctx, c, m, p.name)).records.get(id);
        if (r !== undefined) {
          owner = p;
          rec = r;
          break;
        }
      }
      if (owner === null || rec === undefined) return `INV-NOLOSS: marker ${mk} was accounted to the RESOLVED_DISCARD of ${id}, which no peer's registry holds`;
      if (rec.state !== 'RESOLVED_DISCARD') return `INV-NOLOSS: marker ${mk} was accounted to a --discard of ${id}, but ${owner.name}'s record ${id} is ${rec.state}, not RESOLVED_DISCARD`;
      const evs = ctx.trace.ofKind('discard').filter((e) => e.id === id);
      const oids = evs.flatMap((e) => e.held.map((h) => h.blob)).filter((b): b is string => b !== null);
      await blobMarkers(c, owner.dir, oids);
      if (!oids.some((o) => markersOf(c, o).includes(mk))) {
        return `INV-NOLOSS: marker ${mk} was accounted to the RESOLVED_DISCARD of ${owner.name}'s ${id}, but no 'discard' event of ${id} names a held blob holding it (${evs.length} event(s), blobs ${oids.join(',') || '-'})`;
      }
    }
    return null;
  };

  /** The resurrection clause over every board commit since the last check (and the current tip). */
  const resurrection = async (ctx: SimContext, s: RunState): Promise<string | null> => {
    const c = cacheOf(s.cache);
    const m = await moment(ctx, ns, c);
    const retired = markers.retired();
    for (const mk of [...s.left.keys()]) if (!retired.has(mk)) s.left.delete(mk);
    for (const mk of [...s.retiredSeen.keys()]) if (!retired.has(mk)) s.retiredSeen.delete(mk);
    for (const mk of retired) if (!s.left.has(mk)) s.left.set(mk, 'unseen');
    if (m.tip === null) return null;
    const boards: Oid[] = [];
    if (s.boardAt !== null && s.boardAt !== m.tip.board) {
      const r = await git(m.dir, ['rev-list', '--first-parent', '--reverse', m.tip.board, `^${s.boardAt}`], [0, 128]);
      if (r.code === 0) for (const l of r.stdout.toString('utf8').split('\n')) if (l.trim().length > 0) boards.push(parseOid(l.trim()));
      // Nothing new: the tip moved back onto the chain already walked (a host rewind, F-BR-3) — a commit judged before.
      if (r.code === 0 && boards.length === 0) s.judged.add(m.tip.board);
    }
    s.boardAt = m.tip.board;
    if (!boards.includes(m.tip.board)) boards.push(m.tip.board);
    for (const b of boards) {
      const again = s.judged.has(b);
      s.judged.add(b);
      let tree: string = m.tip.tree;
      if (b !== m.tip.board) {
        const live = await liveCodeOf(m.dir, b).catch(() => null);
        if (live === null) continue;
        tree = await treeOf(m.dir, live);
      }
      const idx = await treeIndex(c, m.dir, tree);
      for (const [mk, was] of s.left) {
        const present = idx.has(mk);
        if (again) {
          // A commit judged before (the unchanged tip, or one the remote moved back to): only a marker retired since starts here.
          if (present && was === 'unseen') s.left.set(mk, 'present');
          continue;
        }
        if (!present) {
          if (was === 'present') s.left.set(mk, 'left');
        } else if (was !== 'left') {
          s.left.set(mk, 'present');
        } else {
          const seen = s.retiredSeen.get(mk);
          const who = seen === undefined ? ' (never seen as an obligation by this oracle)' : ` (author ${seen.author}, path ${seen.path}, written at step ${seen.step}; last seen at ${show(seen.at)})`;
          return `INV-NOLOSS (resurrection, R3-64): retired marker ${mk}${who} reappears in live_code of board ${b.slice(0, 12)} `
            + `(${(idx.get(mk) ?? []).join(', ')}) after the board had left it: a teammate's informed removal was reverted`;
        }
      }
    }
    return null;
  };

  const incremental = async (ctx: SimContext): Promise<string | null> => {
    const s = stateOf(ctx);
    const c = cacheOf(s.cache);
    const m = await moment(ctx, ns, c);
    const first = s.checks++ === 0;
    observePeers(ctx, c, first);
    await observeRewind(c, m);
    const dirtyPaths = new Set<string>();
    const dirtyPeers = new Set<string>();
    const events = ctx.trace.events;
    for (let i = s.traceAt; i < events.length; i++) {
      const e = events[i] as TraceEvent;
      switch (e.kind) {
        case 'apply': for (const p of [...e.written, ...e.deferred]) dirtyPaths.add(p); break;
        case 'hold': for (const p of e.paths) dirtyPaths.add(p); dirtyPeers.add(nameOf(ctx, e.peer)); break;
        case 'discard': for (const h of e.held) dirtyPaths.add(h.path); break;
        case 'repair': dirtyPaths.add(e.path); break;
        case 'push': if (e.outcome === 'landed') dirtyPeers.add(nameOf(ctx, e.peer)); break;
        case 'publish': {
          let paths = s.publishPaths.get(i);
          if (paths === undefined) {
            paths = await codePaths(ctx, e);
            s.publishPaths.set(i, paths);
          }
          for (const p of paths) dirtyPaths.add(p);
          break;
        }
        default: break;
      }
    }
    s.traceAt = events.length;
    const details = ctx.opLog.slice(s.opLogAt).map((e) => e.detail);
    s.opLogAt = ctx.opLog.length;
    const tipChanged = (m.tip?.board ?? null) !== s.tip;
    s.tip = m.tip?.board ?? null;
    for (const p of ctx.peers) {
      const head = await readRef(join(p.dir, '.git'), `refs/cowork-local/${enc(BRANCH)}/holds`);
      if ((s.regHeads.get(p.name) ?? null) !== head) dirtyPeers.add(p.name);
      s.regHeads.set(p.name, head);
    }
    for (const [mk, owner] of markers.live()) {
      const seen = s.last.get(mk);
      // A write first seen at this path (new, moved, or live again): dated by this check, unless it is the oracle's first.
      if (seen === undefined || seen.path !== owner.path) c.writes.set(mk, { path: owner.path, at: first ? null : events.length, mono: ctx.clocks.get(owner.peer)?.monoMs() });
      let dirty = seen === undefined || seen.at === null || seen.path !== owner.path || dirtyPaths.has(owner.path) || markers.lateWrites().has(mk);
      if (!dirty && seen !== undefined && seen.at !== null) {
        const at = seen.at.at;
        if (at === 'author_disk' || at === 'local_only_disk') dirty = true;
        else if ((at === 'live' || at === 'held') && tipChanged) dirty = true;
        else if (at === 'registry' && [...dirtyPeers].some((n) => seen.at!.detail.startsWith(`registry ${n} `))) dirty = true;
      }
      if (!dirty && details.some((d) => d.includes(owner.path))) dirty = true;
      if (!dirty) continue;
      const why = await check(ctx, s, mk, owner, seen?.step ?? writtenStep(ctx, mk));
      if (why !== null) return why;
    }
    for (const [mk, seen] of [...s.last]) {
      if (markers.live().has(mk)) continue;
      if (markers.retired().has(mk)) s.retiredSeen.set(mk, seen);
      s.last.delete(mk);
      c.writes.delete(mk);
    }
    return (await verifyDiscards(ctx, s, false)) ?? resurrection(ctx, s);
  };

  const full = async (ctx: SimContext, s: RunState, cache: object): Promise<{ verdict: string | null; locations: Map<string, NolossFound | null> }> => {
    const locations = new Map<string, NolossFound | null>();
    let verdict: string | null = null;
    const c = cacheOf(cache);
    observePeers(ctx, c, s.checks++ === 0);
    await observeRewind(c, await moment(ctx, ns, c));
    for (const [mk, owner] of markers.live()) {
      const late = markers.lateWrites().has(mk);
      if (latePending(ctx, s, mk, owner.peer)) {
        locations.set(mk, s.last.get(mk)?.at ?? null);
        continue;
      }
      const r = await search(ctx, ns, mk, owner, c, late ? { noDisk: true } : {});
      const prev = s.last.get(mk);
      if (r !== null && 'missed' in r) {
        locations.set(mk, null);
        verdict ??= `INV-NOLOSS: marker ${mk} (author ${owner.peer}, path ${owner.path}, written at step ${prev?.step ?? writtenStep(ctx, mk)}): ${r.missed}`;
        continue;
      }
      locations.set(mk, r);
      if (r === null) verdict ??= lossMessage(mk, owner, prev, writtenStep(ctx, mk));
    }
    return { verdict, locations };
  };

  return {
    name: 'INV-NOLOSS',
    async afterEveryOp(ctx: SimContext): Promise<string | null> {
      return incremental(ctx);
    },
    async atQuiescence(ctx: SimContext): Promise<string | null> {
      const s = stateOf(ctx);
      const r = await full(ctx, s, s.cache);
      if (r.verdict !== null) return r.verdict;
      for (const [mk, at] of r.locations) {
        const owner = markers.live().get(mk);
        if (owner !== undefined) s.last.set(mk, { at, path: owner.path, step: s.last.get(mk)?.step ?? writtenStep(ctx, mk), author: owner.peer });
      }
      return (await verifyDiscards(ctx, s, true)) ?? (await resurrection(ctx, s)) ?? twoStores(ctx, ns, s.cache);
    },
    locations(ctx: SimContext): ReadonlyMap<string, NolossFound | null> {
      const s = stateOf(ctx);
      return new Map([...s.last].map(([mk, v]) => [mk, v.at] as const));
    },
    async fullScan(ctx: SimContext) {
      const s = stateOf(ctx);
      return full(ctx, s, s.cache);
    },
  };
}

// ---- two stores (TST-08) ------------------------------------------------------------------------------------------------

const FORBIDDEN_REF_PREFIXES = ['refs/cowork-held/', 'refs/worktree/cowork/'] as const;
const FORBIDDEN_DIRS = ['quarantine', 'conflicts'] as const;

async function forbiddenRefs(dir: string): Promise<string[]> {
  const r = await git(dir, ['for-each-ref', '--format=%(refname)', ...FORBIDDEN_REF_PREFIXES], [0, 128]);
  const out = r.code === 0 ? r.stdout.toString('utf8').split('\n').map((l) => l.trim()).filter((l) => l.length > 0) : [];
  return out.filter((ref) => FORBIDDEN_REF_PREFIXES.some((p) => ref.startsWith(p)));
}

/**
 * TST-08's one change, two stores: every hold id of a `hold` event is in exactly one peer's registry and its folded owner is that peer;
 * no clone or the remote has a ref under refs/cowork-held/ or refs/worktree/cowork/; no clone has <gitdir>/cowork/quarantine/ or
 * <gitdir>/cowork/conflicts/. The message names the store.
 */
export async function twoStores(ctx: SimContext, ns: RefNamespace = RELEASE_NAMESPACE, cache: unknown = {}): Promise<string | null> {
  const c = cacheOf(cache);
  const m = await moment(ctx, ns, c);
  const ids = new Set(ctx.trace.ofKind('hold').map((e) => e.id));
  const where = new Map<string, string[]>();
  for (const p of ctx.peers) {
    const reg = await registryOf(ctx, c, m, p.name);
    for (const id of reg.records.keys()) {
      const l = where.get(id);
      if (l === undefined) where.set(id, [p.name]);
      else l.push(p.name);
    }
  }
  for (const id of [...ids].sort()) {
    const in_ = where.get(id) ?? [];
    if (in_.length !== 1) return `INV-NOLOSS (two stores, TST-08): hold ${id} is in ${in_.length} registries (${in_.join(', ') || 'none'}), not exactly one`;
  }
  for (const [id, peers] of [...where].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (peers.length > 1) return `INV-NOLOSS (two stores, TST-08): hold ${id} is in the registries of ${peers.join(' and ')}`;
  }
  if (m.tip !== null) {
    const bv = await boardView(c, m.dir, m.tip.board);
    for (const [id, f] of Object.entries(bv.holds)) {
      const peers = where.get(id);
      if (peers === undefined || peers.length === 0) continue;
      const holder = peers[0] as string;
      if (nameOf(ctx, f.owner) !== holder) return `INV-NOLOSS (two stores, TST-08): the board folds hold ${id} with owner ${nameOf(ctx, f.owner)}, but ${holder}'s registry holds it`;
    }
  }
  for (const [label, dir] of [...ctx.peers.map((p) => [`${p.name}'s clone`, p.dir] as const), ['the remote', m.dir] as const]) {
    const refs = await forbiddenRefs(dir);
    if (refs.length > 0) return `INV-NOLOSS (two stores, TST-08): ${label} has the ref ${refs[0]} (a second store of held bytes; L-HOLD-STORES)`;
  }
  for (const p of ctx.peers) {
    for (const d of FORBIDDEN_DIRS) {
      const at = join(realpathSync.native(p.dir), '.git', 'cowork', d);
      if ((await lstat(at).catch(() => null))?.isDirectory() === true) return `INV-NOLOSS (two stores, TST-08): ${p.name}'s clone has the directory <gitdir>/cowork/${d}/ (a second store of held bytes; L-HOLD-STORES)`;
    }
  }
  return null;
}

// ---- oracleHeldSecret ---------------------------------------------------------------------------------------------------

const RESTORE_ROW = /(^|\n)(<<<<<<<|\|\|\|\|\|\|\||>>>>>>>) cowork:/;

/**
 * Ruling R3-EF4-18 (glossary §9: a portability record is local_only for its name, not its bytes): whether local_only record `r` (not a
 * marker companion: the caller asks) is local_only only for its not-live name, decided test-side from the record alone, never from the
 * engine's scope — a PATCH carrying the `portability` guard (DAT-33's portabilityStep, its one creator) with no `filter-failure` or
 * `secret-scan` guard and no secret-like or quarantined path (glossary §16). Its bytes are publishable under a portable LIVE name, so
 * they are outside INV-SECRET-HELD's set; every other local_only cause keeps a record in it.
 */
function portabilityOnly(r: HoldRecord): boolean {
  const names = new Set(r.guards.map((g) => g.name.split(':')[0]));
  return r.kind === 'PATCH' && names.has('portability') && !names.has('filter-failure') && !names.has('secret-scan')
    && r.paths.every((p) => !isSecretLike(p) && !isQuarantined(p, null));
}

/** A path a live code tree may carry as LIVE (the D5 rows a SIM reaches without attributes: not quarantined, valid, no .gitignore, not secret-like). */
function livePath(path: string): boolean {
  return validPathSyntax(path) && !isQuarantined(path, null) && !isSecretLike(path) && path !== '.gitignore' && !path.endsWith('/.gitignore');
}

/**
 * INV-SECRET (held-bytes slice) and O-NOMARKER (held side), atQuiescence: every blob object of the bare remote (unreachable ones too)
 * is free of rows starting `<<<<<<< cowork:`, `||||||| cowork:` or `>>>>>>> cowork:`, and no h1/s2 blob of any peer's local_only record
 * (any state) is in the remote unless it is also in a live code commit's tree at a LIVE path — except a record local_only only for its
 * not-live name (portabilityOnly, ruling R3-EF4-18). The board's own shape (O-LIVE-RECORD: no held/ subtree for a local_only hold, held/
 * only at LIVE paths) still keeps such a record's bytes from held/ under its non-portable name.
 */
export function oracleHeldSecret(ns: RefNamespace = RELEASE_NAMESPACE): Oracle {
  return {
    name: 'INV-SECRET-HELD',
    async atQuiescence(ctx: SimContext): Promise<string | null> {
      return heldSecretVerdict(ctx, ns);
    },
  };
}

/** oracleHeldSecret's verdict now (exported so a test can judge a scratch copy of the remote mid-run). */
export async function heldSecretVerdict(ctx: SimContext, ns: RefNamespace = RELEASE_NAMESPACE): Promise<string | null> {
  const dir = await remoteDir(ctx);
  const buf = (await git(dir, ['cat-file', '--batch-all-objects', '--batch', '--unordered'])).stdout;
  const blobs = new Set<string>();
  let at = 0;
  while (at < buf.length) {
    const nl = buf.indexOf(0x0a, at);
    if (nl < 0) break;
    const [oid = '', type = '', sizeText = '0'] = buf.subarray(at, nl).toString('utf8').split(' ');
    const size = Number(sizeText);
    if (type === 'blob') {
      blobs.add(oid);
      const body = buf.subarray(nl + 1, nl + 1 + size).toString('latin1');
      const hit = RESTORE_ROW.exec(body);
      if (hit !== null) return `INV-SECRET / O-NOMARKER (held side): blob ${oid} of the remote holds a restore-marker row (${hit[2]} cowork:…)`;
    }
    at = nl + 1 + size + 1;
  }
  // The local_only held bytes of every peer's registry (any state), but a record local_only only for its not-live name (R3-EF4-18).
  const secret = new Map<string, string>();
  for (const p of ctx.peers) {
    const head = await readRef(join(p.dir, '.git'), `refs/cowork-local/${enc(BRANCH)}/holds`);
    if (head === null) continue;
    const reg = await readRegistry(runner(), p.dir, BRANCH, head);
    for (const r of reg.records.values()) {
      if (!r.local_only) continue;
      const companion = Object.hasOwn(reg.local?.companions ?? {}, r.id);
      if (!companion && portabilityOnly(r)) continue;
      for (const x of heldSide(r)) secret.set(x.oid, `${p.name}'s ${r.id} ${x.stage}/${x.path}${companion ? ' (marker companion)' : ''}`);
    }
  }
  const present = [...secret.keys()].filter((o) => blobs.has(o));
  if (present.length === 0) return null;
  const allowed = await liveBlobs(dir, ns);
  for (const o of present) if (!allowed.has(o)) return `INV-SECRET (held bytes): the remote holds blob ${o}, the held side of ${secret.get(o)} — a local_only record's bytes`;
  return null;
}

/**
 * Every blob at a LIVE path of a live code commit's tree: the remote code ref's history and the board's live code commit's
 * history (the code mirror lags the board by one publish, ENG-43, so the newest live commit is reachable only from the board).
 */
async function liveBlobs(dir: string, ns: RefNamespace): Promise<Set<string>> {
  const out = new Set<string>();
  const names = refNames(BRANCH, ns);
  const tips: string[] = [];
  const code = await readRef(dir, names.remoteCode);
  if (code !== null) tips.push(code);
  const board = await readRef(dir, names.remoteBoard);
  if (board !== null) tips.push(await liveCodeOf(dir, board));
  if (tips.length === 0) return out;
  const trees = (await git(dir, ['log', '--format=%T', ...tips])).stdout.toString('utf8').split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  for (const t of new Set(trees)) {
    const text = (await git(dir, ['ls-tree', '-r', '-z', t])).stdout.toString('utf8');
    for (const rec of text.split('\0')) {
      if (rec.length === 0) continue;
      const tab = rec.indexOf('\t');
      const [, type = '', oid = ''] = rec.slice(0, tab).split(' ');
      if (type === 'blob' && livePath(rec.slice(tab + 1))) out.add(oid);
    }
  }
  return out;
}
