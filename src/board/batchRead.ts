// Batched board and live commit readers (12 §3.3.2, §9.7 items 2, 3 and 8; Plan 8a rulings R-V05, R-V69).
//
// One round = two git processes whatever its size (≤ READ_BATCH_MAX board commits): one `cat-file --batch-check` that
// names every object the round could read (types and sizes, nothing read), then one `cat-file --batch` of the distinct
// well-typed objects within the board caps, at most BATCH_READ_MAX_BYTES of output (R-V69: the items that fit, a
// prefix, are read; the caller continues from `next`). Plan 2's size-before-read ruling holds: an over-cap, mistyped or
// missing object is reported per item and never named on the --batch stdin. The parsers are boardCommit.ts's own
// (exported for this file, R-V02), so a batched read equals readBoardCommit field for field (checkpoint aside: only
// read at heights divisible by 256, where the fold compares it, PRO-28) — except that an entry the fold would read (git
// finds it and its mode names the fold's type) whose object is missing from the store (a partial clone) is reported
// `missing` where readBoardCommit would lazily fetch it. No hostile board stops a room (R-V74): a round git dies on is
// read again item by item within the same byte budget per call, and an object that git or the commit parser cannot read
// is a per-item `unreadable`.
import { isOid, type Oid } from '../git/oid.js';
import { GitCommandError, parseCommitObject as parseCommitText, type CommitInfo } from '../git/repo.js';
import type { GitResult } from '../git/runner.js';
import type { Trailer } from '../git/trailers.js';
import {
  BATCH_READ_MAX_BYTES, batchCheck, batchObjects, BOARD_COMMIT_OBJECT_MAX_BYTES, capViolation, opsLinesOf, parseCsTrailers, parseWriter, subtreeNames,
  type BoardCommitData, type BoardEntries, type BoardMalformedReason, type CsTrailer, type EntryInfo, type WriterId,
} from './boardCommit.js';
import { CHECKPOINT_EVERY } from './fold.js';
import { readProtocol } from './protocol.js';

/** GitRepo and VizGit both satisfy it; an exit code other than 0 throws. */
export interface BatchGit { run(args: string[], opts: { stdin: Buffer }): Promise<GitResult>; }

/** The most board commits (or live commits) one round names: one `cat-file --batch-check` and one `cat-file --batch` each. */
export const READ_BATCH_MAX = 1_280;

export interface LiveRead {
  oid: Oid;
  /** Equals GitRepo.readCommit(oid). */
  info: CommitInfo;
  /** Exactly one Cowork-Writer that parseWriter accepts, else null. */
  writer: WriterId | null;
  /** Cowork-Seat values in trailer order. */
  seats: string[];
  /** parseCsTrailers(info.trailers). */
  cs: CsTrailer[];
  csPaths: Map<string, string[]>;
  /** The single Cowork-Base value when isOid, else null. */
  base: Oid | null;
}
/**
 * missing stops the room (R-V19); not_commit, commit_too_large and unreadable (git dies reading the commit object, or
 * its header does not parse, R-V74) read as a live shape of null.
 */
export interface LiveReadFailure { oid: Oid | null; malformed: 'missing' | 'not_commit' | 'commit_too_large' | 'unreadable'; }
export interface BoardRead extends BoardCommitData {
  height: number;
  /** The board commit (boardShapeOk input). */
  info: CommitInfo;
  /** The decoded Cowork-CS-Paths of the board commit (12 §9.7 item 2). */
  csPaths: Map<string, string[]>;
  /**
   * The live commit it names (its last parent); 'same' = the preceding item's (or opts.prevLive), not read again; null
   * when opts.withLive is false. A board commit whose last parent is not the one the batch named (a parent count other
   * than 2, or 1 at height 0) reads as `not_commit`: its live shape is null (R-V05).
   */
  live: LiveRead | LiveReadFailure | 'same' | null;
}
/**
 * missing: the board commit, its tree, or an entry object the fold reads is not in the store (R-V19: stops the room; see
 * lostObject for which entries count). unreadable (R-V74): git dies on something the item names even when it is read
 * alone (a board tree its lookups cannot decode, an object it cannot inflate, the item's live commit included), or the
 * board commit's header does not parse; the room goes on (a no-op draft, R-V19).
 */
export interface BoardReadFailure { oid: Oid; height: number; malformed: BoardMalformedReason | 'missing' | 'unreadable'; }

/**
 * One call of a batched reader (R-V69): the results of a prefix of the items, in item order, and `next`, the index of
 * the first item not read (`reads.length`; the number of items when all were read). The objects read for the prefix
 * add up to at most BATCH_READ_MAX_BYTES of `cat-file --batch` output on both paths: the one --batch of the round, or,
 * when git dies on the round (R-V74), the --batch calls of the item-by-item rounds together (an object counts once per
 * --batch that reads it; an `unreadable` item counts nothing). The prefix is never empty when there are items (one
 * item's objects are at most ~13 MB by the caps). The caller continues from `next` in its next call (readBoardCommits:
 * with prevLive = the liveCode of the last read when it is a BoardRead, else null).
 */
export interface BatchReads<T> { reads: T[]; next: number; }

export function isBoardReadFailure(r: BoardRead | BoardReadFailure): r is BoardReadFailure {
  return 'malformed' in r;
}

const WRITER_KEY = 'Cowork-Writer';
const SEAT_KEY = 'Cowork-Seat';
const BASE_KEY = 'Cowork-Base';
const OPS_FILE = 'ops.jsonl';
const PROTOCOL_FILE = 'protocol.json';
const HELD_DIR = 'held';
const CHECKPOINT_DIR = 'checkpoint';
const STATE_FILE = 'state.json';
const CHECKPOINT_STATE = `${CHECKPOINT_DIR}/${STATE_FILE}`;
/** git's die() exit code: git refused what a round names (R-V74), unlike a spawn failure, a watchdog kill or an abort. */
const GIT_DIED = 128;
/** Per board item, after <oid>: its tree, the four entries the fold reads, and the checkpoint directory (R-V05, R-V69). */
const ITEM_SUFFIXES = ['', '^{tree}', `:${OPS_FILE}`, `:${PROTOCOL_FILE}`, `:${HELD_DIR}`, `:${CHECKPOINT_DIR}`, `:${CHECKPOINT_DIR}/${STATE_FILE}`] as const;
/**
 * `--batch-check` prints `<name> missing` both for a path the tree does not hold and for an object the store lacks, so
 * a board tree (and its checkpoint/ tree) is read when a name did not resolve; an honest one is ~150 bytes, and one over
 * this is not read (its unresolved names read as absent, as readBoardCommit reads them).
 */
const TREE_READ_MAX_BYTES = 65_536;

/** The commit-object parse (tree and parent header lines, message through parseMessage); equals GitRepo.readCommit (tested). */
export function parseCommitObject(oid: Oid, body: Buffer): CommitInfo {
  return parseCommitText(oid, body.toString('utf8'));
}

/** The single Cowork-Writer value parseWriter accepts, else null (board and live commits alike). */
function writerOf(trailers: readonly Trailer[]): WriterId | null {
  const writers = valuesOf(trailers, WRITER_KEY);
  return writers.length === 1 ? parseWriter(writers[0]!) : null;
}

function valuesOf(trailers: readonly Trailer[], key: string): string[] {
  return trailers.filter((t) => t.key === key).map((t) => t.value);
}

/**
 * parseCommitObject, or null when the header does not parse: since Plan 2 FA-1 it reads the header exactly as git
 * does, so that is a commit git itself cannot parse (no `tree <hex>` first line, or a `parent` line right after it
 * whose value is not an object id), which a fetch without fsck can still bring (R-V74).
 */
function parsedCommit(oid: Oid, body: Buffer): CommitInfo | null {
  try {
    return parseCommitObject(oid, body);
  } catch {
    return null;
  }
}

/** The held ids: subtreeNames of the held/ tree, or none when it does not parse (R-V74: an unparseable tree reads as absent). */
function heldIdsOf(raw: Buffer | null, hashBytes: number): string[] {
  if (raw === null) return [];
  try {
    return subtreeNames(raw, hashBytes);
  } catch {
    return [];
  }
}

function liveRead(oid: Oid, body: Buffer): LiveRead | LiveReadFailure {
  const info = parsedCommit(oid, body);
  if (info === null) return { oid, malformed: 'unreadable' };
  const bases = valuesOf(info.trailers, BASE_KEY);
  const { cs, paths } = parseCsTrailers(info.trailers);
  const base = bases.length === 1 ? bases[0] : undefined;
  return { oid, info, writer: writerOf(info.trailers), seats: valuesOf(info.trailers, SEAT_KEY), cs, csPaths: paths, base: isOid(base) ? base : null };
}

/** What a --batch-check record says about a commit we might read: why not, or null when it can be read. */
function commitRefusal(e: EntryInfo | null): 'missing' | 'not_commit' | 'commit_too_large' | null {
  if (e === null) return 'missing';
  if (e.type !== 'commit') return 'not_commit';
  return e.size > BOARD_COMMIT_OBJECT_MAX_BYTES ? 'commit_too_large' : null;
}

const ofType = (e: EntryInfo | null | undefined, type: string): EntryInfo | null => (e !== null && e !== undefined && e.type === type ? e : null);

/** One record of a raw tree object: the mode digits and the name bytes, as stored. */
interface TreeEntry { mode: string; name: Buffer; }

/**
 * The records of a raw tree object (`<mode> <name>\0<hash>`), in stored order; null when the tree was not read (over
 * TREE_READ_MAX_BYTES) or git could not decode it (a mode that is not octal digits, no space, an empty name, no NUL, a
 * short hash). Such a tree's unresolved names read as absent, as readBoardCommit reads them: it never parses the board
 * tree or checkpoint/, and an unparseable tree never fails the item, nor the round (R-V19).
 */
function treeEntries(raw: Buffer | undefined, hashBytes: number): TreeEntry[] | null {
  if (raw === undefined) return null;
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < raw.length) {
    const sp = raw.indexOf(0x20, pos);
    const nul = sp < 0 ? -1 : raw.indexOf(0x00, sp + 1);
    if (nul < 0 || nul === sp + 1 || nul + 1 + hashBytes > raw.length) return null;
    const mode = raw.toString('latin1', pos, sp);
    if (!/^[0-7]+$/.test(mode)) return null;
    entries.push({ mode, name: raw.subarray(sp + 1, nul) });
    pos = nul + 1 + hashBytes;
  }
  return entries;
}

/**
 * The object type git takes an entry of this mode to name (canon_mode on the S_IFMT bits): a directory is a tree, a
 * regular file or a symlink a blob, and every other mode a gitlink (`<oid> submodule` when the object is absent).
 */
function modeType(mode: string): 'tree' | 'blob' | 'commit' {
  const fmt = Number.parseInt(mode.slice(-6), 8) & 0o170000;
  return fmt === 0o040000 ? 'tree' : fmt === 0o100000 || fmt === 0o120000 ? 'blob' : 'commit';
}

/**
 * The entry git's own lookup (tree-walk.c find_tree_entry) takes for `path` in one tree: the first entry of that name,
 * skipping entries longer than the path and stopping at the first entry that sorts after it, so an unsorted tree can
 * hide a name; for `dir/rest`, the `dir` entry git descends into (a tree by its mode), else null.
 */
function findEntry(entries: readonly TreeEntry[], path: string): TreeEntry | null {
  const want = Buffer.from(path, 'utf8');
  for (const e of entries) {
    const n = e.name.length;
    if (n > want.length) continue;
    const cmp = Buffer.compare(want.subarray(0, n), e.name);
    if (cmp > 0) continue;
    if (cmp < 0) return null;
    if (n === want.length) return e;
    if (want[n] !== 0x2f) continue;
    return modeType(e.mode) === 'tree' ? e : null;
  }
  return null;
}

/** The bytes one object adds to the `cat-file --batch` output: `<oid> <type> <size>\n<body>\n`. */
function recordBytes(e: EntryInfo): number {
  return Buffer.byteLength(`${e.oid} ${e.type} ${e.size}\n`, 'utf8') + e.size + 1;
}

/** One --batch-check of `names` (newline-free object names). */
async function check(git: BatchGit, names: readonly string[]): Promise<Array<EntryInfo | null>> {
  for (const n of names) if (/[\n\r]/.test(n)) throw new Error(`cat-file --batch-check: invalid object name ${JSON.stringify(n)}`);
  const r = await git.run(['cat-file', '--batch-check'], { stdin: Buffer.from(`${names.join('\n')}\n`, 'utf8') });
  return batchCheck(r.stdout, names.length);
}

/**
 * The objects a round reads, item by item in order: each item's not-yet-queued objects join while the --batch output,
 * added to the `spent` bytes the call already read in earlier rounds (R-V74's item-by-item path), stays within
 * BATCH_READ_MAX_BYTES; the first item always joins when nothing was spent. `next` is the first item that did not join,
 * `bytes` the --batch output of the queued objects (the sum of recordBytes).
 */
function budget(wants: ReadonlyArray<ReadonlyArray<EntryInfo | null>>, spent: number): { queued: Map<Oid, EntryInfo>; next: number; bytes: number } {
  const queued = new Map<Oid, EntryInfo>();
  let bytes = 0;
  for (let i = 0; i < wants.length; i++) {
    const fresh = new Map<Oid, EntryInfo>();
    for (const e of wants[i]!) if (e !== null && !queued.has(e.oid)) fresh.set(e.oid, e);
    let cost = 0;
    for (const e of fresh.values()) cost += recordBytes(e);
    if ((i > 0 || spent > 0) && spent + bytes + cost > BATCH_READ_MAX_BYTES) return { queued, next: i, bytes };
    bytes += cost;
    for (const [oid, e] of fresh) queued.set(oid, e);
  }
  return { queued, next: wants.length, bytes };
}

/** One --batch of the queued objects; each body is checked against the type and size --batch-check reported. */
async function read(git: BatchGit, queued: ReadonlyMap<Oid, EntryInfo>): Promise<Map<Oid, Buffer>> {
  const bodies = new Map<Oid, Buffer>();
  if (queued.size === 0) return bodies;
  const list = [...queued.values()];
  const r = await git.run(['cat-file', '--batch'], { stdin: Buffer.from(`${list.map((e) => e.oid).join('\n')}\n`, 'utf8') });
  batchObjects(r.stdout, list.length).forEach((o, i) => {
    const e = list[i]!;
    if (o === null || o.type !== e.type || o.body.length !== e.size) throw new Error(`cat-file --batch disagrees with --batch-check on ${e.oid}`);
    bodies.set(e.oid, o.body);
  });
  return bodies;
}

function checkItems(n: number, what: string): void {
  if (n > READ_BATCH_MAX) throw new RangeError(`${what}: ${n} items > ${READ_BATCH_MAX} in one batch`);
}

/** git exited with its die() code: something the call named made it refuse (BatchGit throws GitCommandError on rc ≠ 0). */
function gitDied(e: unknown): boolean {
  return e instanceof GitCommandError && e.code === GIT_DIED;
}

/** A round's reads and `next`, with the --batch output bytes of the objects it read (the sum of recordBytes). */
interface Round<T> extends BatchReads<T> { bytes: number; }

/**
 * R-V74 (no hostile board stops a room): when git dies on a round — a board tree its lookups cannot decode, an object
 * it cannot inflate — the round is read again one item at a time; an item whose own round still makes git die reads
 * `unreadable(i)` and costs nothing, every other item exactly as it would have (`one(i, reads so far, bytes spent)`).
 * The item rounds keep R-V69's budget for the call: their --batch outputs add up to at most BATCH_READ_MAX_BYTES, so
 * an item i > 0 that would push the sum over is not read (`one` returns it unread: its round stops after the
 * --batch-check) and the call returns `next = i`; the caller reads it in its next call. Any other failure (a spawn
 * failure, a watchdog kill, an abort, a parse error) is thrown, as before.
 */
async function roundOrItems<T>(whole: () => Promise<Round<T>>, count: number, one: (i: number, done: readonly T[], spent: number) => Promise<Round<T>>, unreadable: (i: number) => T): Promise<BatchReads<T>> {
  try {
    const { reads, next } = await whole();
    return { reads, next };
  } catch (e) {
    if (!gitDied(e)) throw e;
  }
  const reads: T[] = [];
  let spent = 0;
  for (let i = 0; i < count; i++) {
    let r: Round<T>;
    try {
      r = await one(i, reads, spent);
    } catch (e) {
      if (!gitDied(e)) throw e;
      r = { reads: [unreadable(i)], next: 1, bytes: 0 };
    }
    if (r.next === 0) return { reads, next: i };   // only when spent > 0, so i > 0: the prefix is never empty
    spent += r.bytes;
    reads.push(r.reads[0]!);
  }
  return { reads, next: count };
}

/** One item's --batch-check records and what they already decide. */
interface Plan {
  oid: Oid;
  height: number;
  commit: EntryInfo | null;
  refused: 'missing' | 'not_commit' | 'commit_too_large' | null;
  /** The records of <oid>^{tree}, :held... in ITEM_SUFFIXES order after the commit. */
  root: EntryInfo | null;
  ckDir: EntryInfo | null;
  raw: { ops: EntryInfo | null; protocol: EntryInfo | null; held: EntryInfo | null; ckState: EntryInfo | null };
  entries: BoardEntries;
  over: ReturnType<typeof capViolation>;
  /** A name did not resolve: an absent entry or a missing object; only the trees tell which. */
  unresolved: boolean;
  live: EntryInfo | null;
}

/**
 * True when the store lacks an object the fold reads through the board commit's tree: the tree itself, ops.jsonl,
 * protocol.json, held/, or checkpoint/state.json (and the checkpoint/ tree on the way to it). An unresolved name is a
 * lost object only when git's own lookup of the name the fold reads finds its entry (findEntry) and the entry's mode
 * names the type the fold reads there (a blob for ops.jsonl, protocol.json and state.json, a tree for held/ and for the
 * checkpoint/ directory git descends into); a wrongly typed or gitlink entry reads as absent whatever the store holds,
 * as the fold reads it. A tree that was not read or does not parse reads its unresolved names as absent (treeEntries).
 */
function lostObject(p: Plan, bodies: ReadonlyMap<Oid, Buffer>): boolean {
  if (p.root === null) return true;   // a commit always has a tree
  if (!p.unresolved) return false;
  const hashBytes = p.oid.length / 2;
  const top = treeEntries(bodies.get(p.root.oid), hashBytes);
  if (top === null) return false;
  const lost = (entries: readonly TreeEntry[], name: string, type: 'blob' | 'tree', rec: EntryInfo | null): boolean => {
    if (rec !== null) return false;
    const e = findEntry(entries, name);
    return e !== null && modeType(e.mode) === type;
  };
  if (lost(top, OPS_FILE, 'blob', p.raw.ops) || lost(top, PROTOCOL_FILE, 'blob', p.raw.protocol) || lost(top, HELD_DIR, 'tree', p.raw.held)) return true;
  // checkpoint/state.json: the entry git's lookup of the whole path takes. A record named `checkpoint/state.json`
  // that comes first is a full-name match git takes as the leaf itself: it counts by its own mode, and checkpoint/ is
  // never descended into. Otherwise it is the `checkpoint` directory, the same first entry `<oid>:checkpoint` resolved
  // to (p.ckDir), and its tree, or the state.json in it, counts only then: git's lookup reaches it.
  if (p.raw.ckState !== null) return false;
  const e = findEntry(top, CHECKPOINT_STATE);
  if (e === null) return false;
  if (e.name.length === Buffer.byteLength(CHECKPOINT_STATE, 'utf8')) return modeType(e.mode) === 'blob';
  if (p.ckDir === null) return true;   // the checkpoint/ tree git descends into is not in the store
  if (p.ckDir.type !== 'tree') return false;
  const sub = treeEntries(bodies.get(p.ckDir.oid), hashBytes);
  return sub !== null && lost(sub, STATE_FILE, 'blob', null);
}

/**
 * One round. One `cat-file --batch-check` naming, per item, <oid>, <oid>^{tree}, <oid>:ops.jsonl, <oid>:protocol.json,
 * <oid>:held, <oid>:checkpoint, <oid>:checkpoint/state.json and, with withLive, <oid>^2 (<oid>^1 at height 0); then one
 * `cat-file --batch` of the distinct well-typed objects within the caps, for the items that fit BATCH_READ_MAX_BYTES of
 * output (R-V69; see BatchReads): the board commit, its entries (checkpoint/state.json only at heights divisible by 256),
 * the board tree and checkpoint/ tree when a name did not resolve (≤ 64 KiB each; that is how an absent entry is told
 * from a missing object: `missing` only when git's lookup finds the entry, its mode names the type the fold reads and
 * the store lacks the object; a wrongly typed or gitlink entry, or a tree that is over 64 KiB or does not parse, reads
 * as absent, see lostObject), and the live commit (not for an item refused by a cap, nor the caller's prevLive when no
 * later item names it). The checkpoint is size-checked at every height, so a board commit carrying an over-cap one is refused
 * exactly as readBoardCommit refuses it. Every BoardCommitData field equals readBoardCommit(oid) except checkpoint (null
 * off multiples of 256; a copy, not a view of the git output). Refusals in readBoardCommit's order (not_commit,
 * commit_too_large, no_parent, the board size caps, a root tree over BOARD_ROOT_TREE_MAX_BYTES included), then `missing`
 * for a tree or entry object the store lacks (a missing board commit is `missing` first), then `entry_missing` (no
 * checkpoint/state.json blob, Plan 2 FA-2; a checkpoint/state.json whose object the store lacks is `missing`).
 * Over-cap, mistyped or missing objects are reported per item and never read.
 * R-V74: a board commit whose header does not parse is `unreadable`; a held/ tree that does not parse gives no held ids;
 * a round git dies on (exit 128) is read again item by item (see roundOrItems: `unreadable` for those git still dies
 * on, two processes per item, the items' --batch outputs together within BATCH_READ_MAX_BYTES, so `next` can stop
 * short of items.length there too). items.length > READ_BATCH_MAX → RangeError; no items → no git process.
 */
export async function readBoardCommits(git: BatchGit, items: ReadonlyArray<{ oid: Oid; height: number }>, opts: { withLive?: boolean; prevLive?: Oid | null } = {}): Promise<BatchReads<BoardRead | BoardReadFailure>> {
  checkItems(items.length, 'readBoardCommits');
  for (const { oid, height } of items) {
    if (!isOid(oid) || !Number.isSafeInteger(height) || height < 0) throw new TypeError(`readBoardCommits: invalid item ${JSON.stringify({ oid, height })}`);
  }
  if (items.length === 0) return { reads: [], next: 0 };
  const withLive = opts.withLive === true;
  const prevLive = opts.prevLive ?? null;
  return roundOrItems(
    () => boardRound(git, items, withLive, prevLive, 0),
    items.length,
    // The preceding item's live commit, as the caller of a next round passes it (null after a failure).
    (i, done, spent) => boardRound(git, [items[i]!], withLive, i === 0 ? prevLive : liveCodeOf(done[i - 1]!), spent),
    (i) => ({ oid: items[i]!.oid, height: items[i]!.height, malformed: 'unreadable' }),
  );
}

function liveCodeOf(r: BoardRead | BoardReadFailure): Oid | null {
  return isBoardReadFailure(r) ? null : r.liveCode;
}

/**
 * One round of readBoardCommits over validated, non-empty items (see readBoardCommits), after `spent` bytes of --batch
 * output the call already read (see budget).
 */
async function boardRound(git: BatchGit, items: ReadonlyArray<{ oid: Oid; height: number }>, withLive: boolean, prevLive: Oid | null, spent: number): Promise<Round<BoardRead | BoardReadFailure>> {
  const per = ITEM_SUFFIXES.length + (withLive ? 1 : 0);
  const names: string[] = [];
  for (const { oid, height } of items) {
    for (const s of ITEM_SUFFIXES) names.push(`${oid}${s}`);
    if (withLive) names.push(`${oid}^${height === 0 ? 1 : 2}`);
  }
  const recs = await check(git, names);

  const plans = items.map(({ oid, height }, i): Plan => {
    const [commit = null, root = null, ops = null, protocol = null, held = null, ckDir = null, ckState = null, live = null] = recs.slice(per * i, per * i + per);
    const refused = commitRefusal(commit);
    const entries: BoardEntries = { root: ofType(root, 'tree'), ops: ofType(ops, 'blob'), protocol: ofType(protocol, 'blob'), held: ofType(held, 'tree'), checkpoint: ofType(ckState, 'blob') };
    const over = refused === null ? capViolation(entries) : null;
    const unresolved = [root, ops, protocol, held, ckDir, ckState].some((r) => r === null);
    return { oid, height, commit, refused, root, ckDir, raw: { ops, protocol, held, ckState }, entries, over, unresolved, live: withLive ? live : null };
  });
  // The caller's prevLive is read only when an item after the first names it.
  const laterLives = new Set<Oid>();
  plans.forEach((p, i) => {
    if (i > 0 && p.refused === null && p.over === null && p.live !== null) laterLives.add(p.live.oid);
  });
  const smallTree = (e: EntryInfo | null): EntryInfo | null => (e !== null && e.type === 'tree' && e.size <= TREE_READ_MAX_BYTES ? e : null);
  const { queued, next, bytes } = budget(plans.map((p, i): Array<EntryInfo | null> => {
    if (p.refused !== null) return [];
    // entry_missing (no checkpoint/state.json blob) is told from a lost object by the trees, as below (lostObject).
    if (p.over !== null) return p.over.reason === 'entry_missing' && p.unresolved ? [p.commit, smallTree(p.root), p.raw.ckState === null ? smallTree(p.ckDir) : null] : [p.commit];
    const want: Array<EntryInfo | null> = [p.commit, p.entries.ops, p.entries.protocol, p.entries.held];
    if (p.height % CHECKPOINT_EVERY === 0) want.push(p.entries.checkpoint);
    if (p.unresolved) want.push(smallTree(p.root), p.raw.ckState === null ? smallTree(p.ckDir) : null);
    if (p.live !== null && commitRefusal(p.live) === null && !(i === 0 && p.live.oid === prevLive && !laterLives.has(p.live.oid))) want.push(p.live);
    return want;
  }), spent);
  const bodies = await read(git, queued);
  const body = (e: EntryInfo | null): Buffer | null => (e === null ? null : (bodies.get(e.oid) ?? null));

  const out: Array<BoardRead | BoardReadFailure> = [];
  for (const p of plans.slice(0, next)) {
    const { oid, height } = p;
    let res: BoardRead | BoardReadFailure;
    const info = p.refused === null ? parsedCommit(oid, body(p.commit)!) : null;
    const last = info === null ? undefined : info.parents[info.parents.length - 1];
    if (p.refused !== null) res = { oid, height, malformed: p.refused };
    else if (info === null) res = { oid, height, malformed: 'unreadable' };
    else if (last === undefined) res = { oid, height, malformed: 'no_parent' };
    else if (p.over !== null && p.over.reason !== 'entry_missing') res = { oid, height, malformed: p.over.reason };
    else if (lostObject(p, bodies)) res = { oid, height, malformed: 'missing' };
    else if (p.over !== null) res = { oid, height, malformed: p.over.reason };
    else {
      const { cs, paths } = parseCsTrailers(info.trailers);
      const checkpoint = height % CHECKPOINT_EVERY === 0 ? body(p.entries.checkpoint) : null;
      const prev: Oid | null = out.length === 0 ? prevLive : liveCodeOf(out[out.length - 1]!);
      res = {
        oid, parents: [...info.parents], firstParent: info.parents.length >= 2 ? info.parents[0]! : null, liveCode: last,
        writer: writerOf(info.trailers), cs, protocol: readProtocol(body(p.entries.protocol)), opsLines: opsLinesOf(body(p.entries.ops)),
        checkpoint: checkpoint === null ? null : Buffer.from(checkpoint),
        heldIds: heldIdsOf(body(p.entries.held), oid.length / 2),
        height, info, csPaths: paths,
        live: withLive ? liveOf(p.live, info, height, last, prev, bodies) : null,
      };
    }
    out.push(res);
  }
  return { reads: out, next, bytes };
}

/** The live result of a parsed board commit (see BoardRead.live). */
function liveOf(rec: EntryInfo | null, info: CommitInfo, height: number, last: Oid, prev: Oid | null, bodies: ReadonlyMap<Oid, Buffer>): LiveRead | LiveReadFailure | 'same' {
  if (info.parents.length !== (height === 0 ? 1 : 2)) return { oid: last, malformed: 'not_commit' };
  if (rec === null) return { oid: last, malformed: 'missing' };
  if (rec.oid === prev) return 'same';
  const refused = commitRefusal(rec);
  if (refused !== null) return { oid: rec.oid, malformed: refused };
  const b = bodies.get(rec.oid);
  if (b === undefined) throw new Error(`readBoardCommits: live commit ${rec.oid} was not read`);
  return liveRead(rec.oid, b);
}

/**
 * Commit objects only, never a tree: one --batch-check, one --batch of the commits that fit BATCH_READ_MAX_BYTES of
 * output (≤ READ_BATCH_MAX oids; a repeated oid is read once; see BatchReads for the prefix and `next`). R-V74: a
 * commit whose header does not parse is `unreadable`; a round git dies on (exit 128) is read again one distinct oid at a
 * time (see roundOrItems), `unreadable` for those git still dies on, within the same BATCH_READ_MAX_BYTES per call.
 */
export async function readLiveCommits(git: BatchGit, oids: readonly Oid[]): Promise<BatchReads<LiveRead | LiveReadFailure>> {
  checkItems(oids.length, 'readLiveCommits');
  for (const o of oids) if (!isOid(o)) throw new TypeError(`readLiveCommits: not an object id ${JSON.stringify(o)}`);
  if (oids.length === 0) return { reads: [], next: 0 };
  return roundOrItems(
    () => liveRound(git, oids, 0),
    oids.length,
    // A repeated oid is the earlier read, not read again (it costs nothing).
    async (i, done, spent) => {
      const first = oids.indexOf(oids[i]!);
      return first < i ? { reads: [done[first]!], next: 1, bytes: 0 } : liveRound(git, [oids[i]!], spent);
    },
    (i) => ({ oid: oids[i]!, malformed: 'unreadable' }),
  );
}

/** One round of readLiveCommits over validated, non-empty oids, after `spent` bytes of --batch output (see budget). */
async function liveRound(git: BatchGit, oids: readonly Oid[], spent: number): Promise<Round<LiveRead | LiveReadFailure>> {
  const recs = await check(git, oids);
  const { queued, next, bytes } = budget(recs.map((e) => (commitRefusal(e ?? null) === null ? [e ?? null] : [])), spent);
  const bodies = await read(git, queued);
  const reads = oids.slice(0, next).map((oid, i): LiveRead | LiveReadFailure => {
    const refused = commitRefusal(recs[i] ?? null);
    if (refused !== null) return { oid, malformed: refused };
    return liveRead(oid, bodies.get(oid)!);
  });
  return { reads, next, bytes };
}
