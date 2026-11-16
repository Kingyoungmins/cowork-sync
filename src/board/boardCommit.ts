// Board and live code commits: trailers, the board tree, reading a board commit back and the commit shapes
// (glossary §3, §5; 02-protocol §3.1; PRO-01…PRO-03, PRO-07; 01-engine §3.4, ENG-12, ENG-20; SEC-03).
// The board tree is a metadata tree built with mktree from existing blobs and trees (ruling R-15).
// Author, committer (+0000) and the forced commit.gpgSign=false come from GitRepo.commitTree and the runner.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { isOid, OidError, parseOid, type Oid } from '../git/oid.js';
import { GitCommandError, parseCommitObject, type CommitInfo, type FileMode, type GitRepo, type MktreeEntry } from '../git/repo.js';
import { SKIP_SUBJECT_PREFIX, type Trailer } from '../git/trailers.js';
import { validId, validPathSyntax } from '../sec/validators.js';
import { formatOpId, parseOpId, type EpochId, type PeerId } from './ids.js';
import { BoardCapError, OPS_MAX_BYTES, OPS_MAX_LINES, serializeOps, type Op } from './ops.js';
import { PROTO, readProtocol, serializeProtocol, type ProtocolJson } from './protocol.js';

/** The Cowork-Writer of a publish intent: its code commit and its board commit share it (glossary §5). */
export interface WriterId { peer: PeerId; epoch: EpochId; seq: number; }
export interface CsTrailer { csId: string; state: 'closed' | 'checkpoint'; seq: number; origin: 'prompt' | 'wake' | 'human'; checks: 'pass' | 'fail' | 'skipped'; paths: number; }

export const BOARD_SUBJECT = '[skip ci] ***NO_CI*** cowork board';
export const CODE_SUBJECT = '[skip ci] ***NO_CI*** cowork live';
export const STATE_SUBJECT = 'cowork-state';

export interface BoardCommitData {
  oid: Oid; parents: Oid[]; firstParent: Oid | null; liveCode: Oid;
  /** null: missing, repeated or malformed Cowork-Writer (every op of the commit is a no-op). */
  writer: WriterId | null;
  cs: CsTrailer[];
  protocol: ProtocolJson;
  /**
   * The first 1,000 lines as stored, decoded as strict UTF-8: a line that is not UTF-8 reads as '' (an empty,
   * malformed line that keeps its position). An ops.jsonl over 64 KiB is not truncated: the whole commit is
   * malformed (readBoardCommit throws BoardMalformedError 'ops_too_large').
   */
  opsLines: string[];
  /** checkpoint/state.json (null when not read: ReadBoardOptions.checkpoint false; a commit without one is malformed) */
  checkpoint: Buffer | null;
  /** held/<id>/ subtrees present ([] when not read: ReadBoardOptions.held false) */
  heldIds: string[];
}
/** What a writer knows before the commit exists. */
export type BoardDraft = Omit<BoardCommitData, 'oid' | 'parents' | 'firstParent'>;

/** One held/<hold_id>/<stage>/<path> blob entry (glossary §3; HLD-04): no entry exists for an ABSENT side. */
export interface HeldBlob { stage: 'h0' | 'h1' | 's1' | 's2' | 's3'; path: string; oid: Oid; }

export interface BoardBuild {
  /** null only for B0 */
  prevBoard: Oid | null;
  /** C, or TIP for a board-only publish, or L0 */
  liveCode: Oid;
  writer: WriterId;
  ops: readonly Op[];
  cs: readonly CsTrailer[];
  csPaths: ReadonlyMap<string, readonly string[]>;
  /** B0 only; later commits carry the previous protocol.json blob by oid */
  protocol: ProtocolJson | null;
  /** a new checkpoint/state.json, or null to carry the previous entry */
  checkpoint: Buffer | null;
  /**
   * held/ edits (Plan 3 Task 3; HLD-04, PRO-27): `put` replaces or adds held/<id>/ (built by buildHeldTree), `remove` drops
   * it; every other held/ entry of the previous board is carried by oid. Absent: the previous held/ tree is carried as is.
   */
  held?: { put: ReadonlyMap<string, readonly HeldBlob[]>; remove: ReadonlySet<string> };
}

export type LiveShape = 'genesis' | 'ordinary' | 'base_move';

/**
 * The 5 MB board tree cap (glossary §20). 02-protocol §3.1 sizes the board tree as ops.jsonl + protocol.json +
 * checkpoint/state.json + every tree object under held/ (MB, not MiB: the glossary writes MiB where it means it).
 */
export const BOARD_TREE_MAX_BYTES = 5_000_000;
/** The board commit object itself (headers, message and trailers), type- and size-checked unpeeled before it is read. */
export const BOARD_COMMIT_OBJECT_MAX_BYTES = 1_048_576;
/**
 * The board's root tree object (final review minor, board): an honest root lists at most four entries (PRO-02: ops.jsonl,
 * protocol.json, checkpoint/, held/; under 200 bytes with sha256 names), so a root over 4 KiB is a malformed board
 * commit (`board_too_large`), refused by its size before anything lists it (the builder lists the previous root on
 * every publish).
 */
export const BOARD_ROOT_TREE_MAX_BYTES = 4_096;
/**
 * The most object bytes one `cat-file --batch` of readCommitsChecked reads (32 MiB): a long range is read in chunks
 * of at most this many bytes by the sizes `--batch-check` reported, so memory stays bounded whatever the range; a
 * realistic range (small commits) is still one call.
 */
export const BATCH_READ_MAX_BYTES = 33_554_432;

/**
 * Why readBoardCommit refused a commit: the oid names no commit (`not_commit`: a tag, tree or blob, never peeled),
 * not a board commit (no parent), the commit object, its root tree or an entry it would read breaks a board cap, or
 * its tree has no checkpoint/state.json blob (`entry_missing`, final review FA-2: PRO-02 requires it on every board
 * commit, B0 included, and no publish could carry it). Callers treat it like a failed board shape check (01-engine
 * §3.7 CHECK, ENG-20): the commit is never folded. buildBoardCommit throws it (`entry_missing`) for a previous board it
 * cannot carry protocol.json or the checkpoint from.
 */
export type BoardMalformedReason = 'no_parent' | 'ops_too_large' | 'board_too_large' | 'commit_too_large' | 'not_commit' | 'entry_missing';
export class BoardMalformedError extends Error {
  readonly reason: BoardMalformedReason;
  constructor(reason: BoardMalformedReason, message: string) {
    super(message);
    this.name = 'BoardMalformedError';
    this.reason = reason;
  }
}

/**
 * Remote content that is no board chain the live chain readers or the fold accept, typed at its source like
 * BoardMalformedError (Task 15 ruling): a board commit whose live code has no parent (live_code), a live chain with no
 * Cowork-Base, several Cowork-Base trailers or a base commit of neither shape (live_base), a board chain whose
 * first-parent shape the fold refuses. Defined in src/board because the fold throws it (src/board imports nothing from
 * src/engine); src/engine/errors.ts re-exports it. A start refuses START_REMOTE{board_malformed} for exactly these two
 * classes, never for a plain Error (a local failure).
 */
export class RemoteContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteContentError';
  }
}

const SKIP_CHECKS = 'skip-checks';
const PROTO_KEY = 'Cowork-Proto';
const WRITER_KEY = 'Cowork-Writer';
const SEAT_KEY = 'Cowork-Seat';
const CS_KEY = 'Cowork-CS';
const CS_PATHS_KEY = 'Cowork-CS-Paths';
const BASE_KEY = 'Cowork-Base';
const HUMAN = 'human';

const OPS_FILE = 'ops.jsonl';
const PROTOCOL_FILE = 'protocol.json';
const CHECKPOINT_DIR = 'checkpoint';
const STATE_FILE = 'state.json';
const HELD_DIR = 'held';

/** Cowork-CS-Paths is written only for a change-set of at most 256 paths (glossary §5, HLD-37). */
const CS_PATHS_MAX = 256;
/** Inflate bound: 256 paths of at most 4,096 bytes and their 255 NUL separators. */
const CS_PATHS_MAX_BYTES = CS_PATHS_MAX * 4_096 + CS_PATHS_MAX - 1;

const CS_STATES: ReadonlySet<string> = new Set(['closed', 'checkpoint']);
const CS_ORIGINS: ReadonlySet<string> = new Set(['prompt', 'wake', 'human']);
const CS_CHECKS: ReadonlySet<string> = new Set(['pass', 'fail', 'skipped']);
const COUNT_RE = /^(?:0|[1-9][0-9]*)$/;
const ENTRY_MODES: ReadonlySet<string> = new Set(['100644', '100755', '120000', '160000', '040000']);

/** `<peer_id>/<epoch>/<seq>`: the op id grammar; throws on anything formatOpId refuses. */
export function formatWriter(w: WriterId): string {
  return formatOpId(w);
}

export function parseWriter(s: string): WriterId | null {
  return parseOpId(s);
}

const isCount = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;

function parseCount(s: string): number | null {
  if (!COUNT_RE.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

function formatCs(c: CsTrailer): string {
  if (!validId('cs', c.csId) || !CS_STATES.has(c.state) || !CS_ORIGINS.has(c.origin) || !CS_CHECKS.has(c.checks) || !isCount(c.seq) || !isCount(c.paths)) {
    throw new Error(`${CS_KEY}: invalid change-set trailer ${JSON.stringify(c)}`);
  }
  return `${c.csId} state=${c.state} seq=${c.seq} origin=${c.origin} checks=${c.checks} paths=${c.paths}`;
}

/** `<cs_id> state=… seq=… origin=… checks=… paths=…`, exactly in that order; null otherwise. */
function parseCs(value: string): CsTrailer | null {
  const t = value.split(' ');
  if (t.length !== 6) return null;
  const field = (i: number, key: string): string | null => (t[i]!.startsWith(`${key}=`) ? t[i]!.slice(key.length + 1) : null);
  const csId = t[0]!;
  const state = field(1, 'state');
  const seq = field(2, 'seq');
  const origin = field(3, 'origin');
  const checks = field(4, 'checks');
  const paths = field(5, 'paths');
  if (!validId('cs', csId) || state === null || !CS_STATES.has(state) || origin === null || !CS_ORIGINS.has(origin) || checks === null || !CS_CHECKS.has(checks)) return null;
  const seqN = seq === null ? null : parseCount(seq);
  const pathsN = paths === null ? null : parseCount(paths);
  if (seqN === null || pathsN === null) return null;
  return { csId, state: state as CsTrailer['state'], seq: seqN, origin: origin as CsTrailer['origin'], checks: checks as CsTrailer['checks'], paths: pathsN };
}

/** git's path order: UTF-8 bytes. */
const byUtf8 = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** base64url(zlib(NUL-joined sorted paths)), duplicates removed; more than 256 paths or an invalid path throws. */
export function encodeCsPaths(paths: readonly string[]): string {
  const unique = [...new Set(paths)];
  if (unique.length > CS_PATHS_MAX) throw new RangeError(`${CS_PATHS_KEY}: ${unique.length} paths > ${CS_PATHS_MAX}`);
  for (const p of unique) {
    if (!validPathSyntax(p)) throw new Error(`${CS_PATHS_KEY}: invalid path ${JSON.stringify(p)}`);
  }
  unique.sort(byUtf8);
  return deflateSync(Buffer.from(unique.join('\0'), 'utf8')).toString('base64url');
}

/** The inverse of encodeCsPaths; null unless it is base64url zlib of at most 256 distinct valid UTF-8 paths. */
export function decodeCsPaths(s: string): string[] | null {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.from(s, 'base64url'), { maxOutputLength: CS_PATHS_MAX_BYTES });
  } catch {
    return null;
  }
  const text = raw.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(raw)) return null;
  if (text.length === 0) return [];
  const paths = text.split('\0');
  if (paths.length > CS_PATHS_MAX || !paths.every((p) => validPathSyntax(p)) || new Set(paths).size !== paths.length) return null;
  return paths;
}

/**
 * The valid Cowork-CS trailers in order (a repeated cs_id keeps its first) and, per cs_id, the decoded
 * Cowork-CS-Paths list — kept only when it belongs to a Cowork-CS of the commit and has its `paths` count.
 * Malformed trailers are skipped; a change-set without a list is one whole-commit closure (HLD-37).
 */
export function parseCsTrailers(trailers: readonly Trailer[]): { cs: CsTrailer[]; paths: Map<string, string[]> } {
  const cs: CsTrailer[] = [];
  const counts = new Map<string, number>();
  for (const t of trailers) {
    if (t.key !== CS_KEY) continue;
    const c = parseCs(t.value);
    if (c === null || counts.has(c.csId)) continue;
    cs.push(c);
    counts.set(c.csId, c.paths);
  }
  const paths = new Map<string, string[]>();
  for (const t of trailers) {
    if (t.key !== CS_PATHS_KEY) continue;
    const sp = t.value.indexOf(' ');
    if (sp <= 0) continue;
    const csId = t.value.slice(0, sp);
    const n = counts.get(csId);
    if (n === undefined || paths.has(csId)) continue;
    const list = decodeCsPaths(t.value.slice(sp + 1));
    if (list !== null && list.length === n) paths.set(csId, list);
  }
  return { cs, paths };
}

function headTrailers(w: WriterId): Trailer[] {
  return [{ key: SKIP_CHECKS, value: 'true' }, { key: PROTO_KEY, value: String(PROTO) }, { key: WRITER_KEY, value: formatWriter(w) }];
}

/** One Cowork-CS per change-set, then one Cowork-CS-Paths per change-set of at most 256 paths (HLD-37). */
function csTrailers(cs: readonly CsTrailer[], csPaths: ReadonlyMap<string, readonly string[]>): Trailer[] {
  const lines: Trailer[] = [];
  const pathLines: Trailer[] = [];
  const seen = new Set<string>();
  for (const c of cs) {
    if (seen.has(c.csId)) throw new Error(`${CS_KEY}: change-set ${c.csId} listed twice`);
    seen.add(c.csId);
    lines.push({ key: CS_KEY, value: formatCs(c) });
    const list = csPaths.get(c.csId);
    if (list === undefined) {
      if (c.paths <= CS_PATHS_MAX) throw new Error(`${CS_PATHS_KEY}: no path list for ${c.csId} (paths=${c.paths} <= ${CS_PATHS_MAX})`);
      continue;
    }
    const n = new Set(list).size;
    if (n !== c.paths) throw new Error(`${CS_KEY}: ${c.csId} has paths=${c.paths} but ${n} paths are listed`);
    if (n <= CS_PATHS_MAX) pathLines.push({ key: CS_PATHS_KEY, value: `${c.csId} ${encodeCsPaths(list)}` });
  }
  return [...lines, ...pathLines];
}

/**
 * Live code commit trailers (glossary §5): skip-checks, Cowork-Proto, Cowork-Writer, one Cowork-Seat per
 * distinct seat (`human` or a 32-hex seat id; sorted), the Cowork-CS/Cowork-CS-Paths trailers, and
 * Cowork-Base: <base> for L0 and base-move commits (base null otherwise).
 */
export function liveCommitTrailers(writer: WriterId, seats: readonly string[], cs: readonly CsTrailer[], csPaths: ReadonlyMap<string, readonly string[]>, base: Oid | null): Trailer[] {
  const out = headTrailers(writer);
  for (const seat of [...new Set(seats)].sort()) {
    if (seat !== HUMAN && !validId('hex128', seat)) throw new Error(`${SEAT_KEY}: not a seat id ${JSON.stringify(seat)}`);
    out.push({ key: SEAT_KEY, value: seat });
  }
  out.push(...csTrailers(cs, csPaths));
  if (base !== null) out.push({ key: BASE_KEY, value: parseOid(base) });
  return out;
}

/** Board commit trailers (PRO-01): skip-checks, Cowork-Proto, Cowork-Writer, then Cowork-CS/Cowork-CS-Paths. */
export function boardTrailers(writer: WriterId, cs: readonly CsTrailer[], csPaths: ReadonlyMap<string, readonly string[]>): Trailer[] {
  return [...headTrailers(writer), ...csTrailers(cs, csPaths)];
}

/** The top-level entries of a tree (or of a commit's tree), by name. */
async function topEntries(repo: GitRepo, treeish: Oid): Promise<Map<string, MktreeEntry>> {
  const out = new Map<string, MktreeEntry>();
  const r = await repo.run(['ls-tree', '-z', parseOid(treeish)]);
  for (const rec of r.stdout.toString('utf8').split('\0')) {
    if (rec.length === 0) continue;
    const tab = rec.indexOf('\t');
    const meta = tab < 0 ? [] : rec.slice(0, tab).split(' ');
    const [mode = '', type = '', oid = ''] = meta;
    if (meta.length !== 3 || !ENTRY_MODES.has(mode) || (type !== 'blob' && type !== 'tree' && type !== 'commit')) {
      throw new Error(`ls-tree: unexpected record ${JSON.stringify(rec.slice(0, 120))}`);
    }
    const name = rec.slice(tab + 1);
    out.set(name, { name, mode: mode as FileMode | '040000', type, oid: parseOid(oid) });
  }
  return out;
}

async function checkpointEntry(repo: GitRepo, state: Buffer): Promise<MktreeEntry> {
  const blob = await repo.hashBytes(state, true);
  const tree = await repo.mktree([{ name: STATE_FILE, mode: '100644', type: 'blob', oid: blob }]);
  return { name: CHECKPOINT_DIR, mode: '040000', type: 'tree', oid: tree };
}

const HELD_STAGES: readonly HeldBlob['stage'][] = ['h0', 'h1', 's1', 's2', 's3'];
const STAGE_SET: ReadonlySet<string> = new Set(HELD_STAGES);
/** The one entry mode under held/: a regular file (no executable, symlink or gitlink entry is ever written or read). */
const HELD_MODE = '100644';

/** A directory of the held tree being built: blob leaves and subdirectories by entry name. */
interface DirNode { blobs: Map<string, Oid>; dirs: Map<string, DirNode>; }
const dirNode = (): DirNode => ({ blobs: new Map(), dirs: new Map() });

/**
 * A metadata tree planned for one `git mktree -z --batch`: its entries (a subtree's oid already the prediction of the tree
 * written before it), the oid git will print for it and the size of its object, both computed from git's tree object
 * format: `<mode> <name>` NUL `<raw id>` per entry, a subtree's mode written `40000`, entries in git's order (by name
 * bytes, a subtree's name compared as if it ended in '/'), hashed as `tree <size>` NUL `<body>`.
 */
interface PlannedTree { entries: readonly MktreeEntry[]; oid: Oid; size: number; }

/** The hash of the object format the oids belong to: SHA-1 for 40 hex characters, SHA-256 for 64. */
type ObjectHash = 'sha1' | 'sha256';
function objectHashOf(oids: Iterable<string>): ObjectHash {
  let len: number | null = null;
  for (const o of oids) {
    if (!isOid(o)) throw new TypeError(`buildHeldTree: ${JSON.stringify(o)} is not an object id`);
    if (len !== null && o.length !== len) throw new TypeError('buildHeldTree: object ids of two object formats');
    len = o.length;
  }
  return len === 64 ? 'sha256' : 'sha1';
}

const NUL = String.fromCharCode(0);
const NUL_BYTE = Buffer.from(NUL, 'utf8');
const entryKey = (e: MktreeEntry): Buffer => Buffer.from(e.mode === '040000' ? `${e.name}/` : e.name, 'utf8');

function planTree(entries: readonly MktreeEntry[], hash: ObjectHash): PlannedTree {
  const sorted = [...entries].sort((a, b) => Buffer.compare(entryKey(a), entryKey(b)));
  const parts: Buffer[] = [];
  for (const e of sorted) parts.push(Buffer.from(`${e.mode === '040000' ? '40000' : e.mode} ${e.name}`, 'utf8'), NUL_BYTE, Buffer.from(e.oid, 'hex'));
  const body = Buffer.concat(parts);
  const oid = createHash(hash).update(Buffer.from(`tree ${body.length}`, 'utf8')).update(NUL_BYTE).update(body).digest('hex') as Oid;
  return { entries: sorted, oid, size: body.length };
}

/** The trees of a DirNode, children before their parent (the order one `mktree --batch` can write them in); the root last. */
function planDir(node: DirNode, hash: ObjectHash, out: PlannedTree[]): PlannedTree {
  const entries: MktreeEntry[] = [];
  for (const [name, oid] of node.blobs) entries.push({ name, mode: HELD_MODE, type: 'blob', oid });
  for (const [name, sub] of node.dirs) entries.push({ name, mode: '040000', type: 'tree', oid: planDir(sub, hash, out).oid });
  const t = planTree(entries, hash);
  out.push(t);
  return t;
}

/**
 * Writes planned trees, children first, with one `git mktree -z --batch` process (R-15: metadata trees by mktree only):
 * one tree per NUL-terminated record group, an empty record between trees. git checks every entry's object (a planned
 * subtree it has not written yet fails the parent) and prints one oid per tree; an oid other than the planned one is an
 * OidError (a build failure).
 */
async function mktreeBatch(repo: GitRepo, trees: readonly PlannedTree[]): Promise<void> {
  if (trees.length === 0) return;
  const records: string[] = [];
  for (const t of trees) {
    for (const e of t.entries) {
      if (e.name.length === 0 || e.name.includes('/') || e.name.includes(NUL)) throw new Error(`invalid tree entry name ${JSON.stringify(e.name)}`);
      records.push(`${e.mode} ${e.type} ${parseOid(e.oid)}\t${e.name}`);
    }
    records.push('');
  }
  const args = ['mktree', '-z', '--batch'];
  const r = await repo.run(args, { stdin: Buffer.from(records.map((x) => `${x}${NUL}`).join(''), 'utf8') });
  const printed = r.stdout.toString('utf8').split('\n');
  trees.forEach((t, i) => {
    if (printed[i] !== t.oid) throw new OidError(`git mktree --batch printed ${JSON.stringify(printed[i] ?? '')} for tree ${i + 1} of ${trees.length}, planned ${t.oid}`);
  });
  if (printed.length !== trees.length + 1 || printed[trees.length] !== '') throw new OidError(`git mktree --batch printed ${printed.length - 1} lines for ${trees.length} trees`);
}

/** One record's held/<id>/ subtree, planned: its trees children first (the subtree's own tree last) and their bytes. */
interface PlannedHeld { trees: PlannedTree[]; root: PlannedTree; bytes: number; }

/** The checks and the plan of buildHeldTree (no git call); see there. */
function planHeld(blobs: readonly HeldBlob[]): PlannedHeld {
  if (!Array.isArray(blobs) || blobs.length === 0) throw new TypeError('buildHeldTree: a held/ subtree needs at least one blob (R3-56)');
  const root = dirNode();
  for (const b of blobs) {
    if (!STAGE_SET.has(b.stage)) throw new TypeError(`buildHeldTree: ${JSON.stringify(b.stage)} is not a stage`);
    if (!validPathSyntax(b.path)) throw new TypeError(`buildHeldTree: ${JSON.stringify(b.path)} is not a valid path`);
    if (!isOid(b.oid)) throw new TypeError(`buildHeldTree: ${JSON.stringify(b.oid)} is not an object id`);
    const parts = [b.stage, ...b.path.split('/')];
    const leaf = parts.pop()!;
    let node = root;
    for (const part of parts) {
      if (node.blobs.has(part)) throw new TypeError(`buildHeldTree: ${b.stage}/${b.path} needs ${part} as a directory and a file`);
      let next = node.dirs.get(part);
      if (next === undefined) {
        next = dirNode();
        node.dirs.set(part, next);
      }
      node = next;
    }
    if (node.blobs.has(leaf)) throw new TypeError(`buildHeldTree: ${b.stage}/${b.path} is listed twice`);
    if (node.dirs.has(leaf)) throw new TypeError(`buildHeldTree: ${b.stage}/${b.path} is a directory of another entry`);
    node.blobs.set(leaf, b.oid);
  }
  const trees: PlannedTree[] = [];
  const top = planDir(root, objectHashOf(blobs.map((b) => b.oid)), trees);
  return { trees, root: top, bytes: trees.reduce((n, t) => n + t.size, 0) };
}

/**
 * The held/<id>/ subtree of one record: `<stage>/<repo path>` blob entries as nested trees (mode 100644), every directory
 * written by one `git mktree -z --batch` process (R-15). Throws a TypeError, before any git call, on an empty list (R3-56: a
 * record with nothing held gets no subtree), a stage outside h0/h1/s1/s2/s3, a path validPathSyntax refuses, an oid that is
 * no oid (or oids of two object formats), a repeated (stage, path), or a path that would be both a file and a directory.
 */
export async function buildHeldTree(repo: GitRepo, blobs: readonly HeldBlob[]): Promise<Oid> {
  const plan = planHeld(blobs);
  await mktreeBatch(repo, plan.trees);
  return plan.root.oid;
}

/**
 * The held/ entry of a new board tree (BoardBuild.held): the previous held/ subtrees (carried by oid) minus `remove`, with
 * every `put` planned by planHeld; none when nothing remains. Every put subtree and the new held/ tree are written by one
 * `mktree --batch`. Every put and removed id must be a ULID (TypeError) and no id may be both put and removed (Error);
 * removing an id that is not there changes nothing. Returns the entry, the §3.1 bytes and the listing bytes
 * (HELD_LISTING_MAX_BYTES) of each put subtree (computed while planning, no git call) and the ids carried from the previous held/.
 */
async function editedHeld(repo: GitRepo, carried: MktreeEntry | undefined, edit: NonNullable<BoardBuild['held']>): Promise<{ entry: MktreeEntry | undefined; putBytes: Map<string, number>; putListing: Map<string, number>; carriedIds: string[] }> {
  for (const id of [...edit.put.keys(), ...edit.remove]) {
    if (!validId('ulid', id)) throw new TypeError(`buildBoardCommit: held/ id ${JSON.stringify(id)} is not a ULID`);
  }
  for (const id of edit.remove) {
    if (edit.put.has(id)) throw new Error(`buildBoardCommit: held/${id} is both put and removed`);
  }
  const children = carried === undefined || carried.type !== 'tree' ? new Map<string, MktreeEntry>() : await topEntries(repo, carried.oid);
  for (const id of edit.remove) children.delete(id);
  const carriedIds = [...children.keys()].filter((id) => !edit.put.has(id));
  const trees: PlannedTree[] = [];
  const putBytes = new Map<string, number>();
  const putListing = new Map<string, number>();
  for (const [id, blobs] of edit.put) {
    const plan = planHeld(blobs);
    trees.push(...plan.trees);
    putBytes.set(id, plan.bytes);
    putListing.set(id, blobs.reduce((n, b) => n + Buffer.byteLength(`${HELD_DIR}/${id}/${b.stage}/${b.path}`, 'utf8'), 0));
    children.set(id, { name: id, mode: '040000', type: 'tree', oid: plan.root.oid });
  }
  if (children.size === 0) {
    await mktreeBatch(repo, trees);
    return { entry: undefined, putBytes, putListing, carriedIds };
  }
  const top = planTree([...children.values()], objectHashOf([...children.values()].map((e) => e.oid)));
  await mktreeBatch(repo, [...trees, top]);
  return { entry: { name: HELD_DIR, mode: '040000', type: 'tree', oid: top.oid }, putBytes, putListing, carriedIds };
}

/** The previous board's side of the §3.1 sum and of the held/ listing (HELD_LISTING_MAX_BYTES), measured for a build with puts. */
interface PrevMeasure { files: number; held: number; byId: Map<string, number>; listing: number; listingById: Map<string, number>; }

/** The listing bytes of the held/<id>/ subtree `f` (each of its entries' paths, with `held/<id>/` before them). */
const idListing = (id: Buffer | string, f: TreeFacts): number => f.rows * (HELD_PREFIX_BYTES + Buffer.byteLength(id) + 1) + f.rel;

/**
 * The previous board's §3.1 sum, its held/ part per id and its held/ listing per id, never listing a held blob: one `cat-file
 * --batch-check` of the previous ops.jsonl, protocol.json and checkpoint/state.json, and the held/ walk of the previous held/
 * tree (heldTrees: from the walk's cache, which the fold's read of prevBoard filled, or three git calls). A tree object is
 * counted at every path it appears under (the strict reading for a subtree shared by two records). A non-tree entry at the held/
 * root adds its listed path (`held/<name>`) to its name's listing and nothing to the §3.1 sum (integration I-2: the readers count it).
 *
 * Final review F13 round 2 (E-1, E-5): this used an `ls-tree -r -d` of the previous held/, which is not bounded by the reader's
 * checks (the §3.1 sum bounds tree paths, not their bytes, and git's own depth limit is below the deepest valid held path), so
 * it goes through the bounded walk too. The walk reads up to BATCH_READ_MAX_BYTES of distinct trees here, not the cap: R3-74
 * builds on a board whose held/ part is over the cap (left by a writer that ignored the rule), whose sum saturates one past
 * the cap and so refuses any put, as R3-74 says. A held/ tree the walk cannot find is a GitCommandError (a build failure: the
 * writer cannot show the build within the cap); one past the walk's own bounds is a BoardMalformedError (build_failed).
 */
async function measurePrev(repo: GitRepo, prevBoard: Oid, prevHeld: Oid | null): Promise<PrevMeasure> {
  const files = [`${prevBoard}:${OPS_FILE}`, `${prevBoard}:${PROTOCOL_FILE}`, `${prevBoard}:${CHECKPOINT_DIR}/${STATE_FILE}`];
  const args = ['cat-file', '--batch-check'];
  const r = await repo.run(args, { stdin: Buffer.from(`${files.join('\n')}\n`, 'utf8') });
  const out: PrevMeasure = { files: 0, held: 0, byId: new Map(), listing: 0, listingById: new Map() };
  for (const e of batchCheck(r.stdout, files.length)) if (e !== null && e.type === 'blob') out.files += e.size;
  if (prevHeld === null) return out;
  const hashBytes = prevHeld.length / 2;
  const trees = await heldTrees(repo, prevHeld, hashBytes, BATCH_READ_MAX_BYTES);
  const root = trees?.facts.get(prevHeld);
  const body = trees?.bodies.get(prevHeld);
  if (trees === null || root === undefined || body === undefined) {
    throw new GitCommandError(args, r.code, Buffer.from(`buildBoardCommit: the held/ tree ${prevHeld} of ${prevBoard} is missing, so the board cap cannot be measured`, 'utf8'));
  }
  out.held = root.sum;
  out.listing = root.rows * HELD_PREFIX_BYTES + root.rel;
  eachTreeEntry(body, hashBytes, (mode, start, end, oid) => {
    const id = body.toString('utf8', start, end);
    if (!isTreeMode(mode)) {
      // Integration I-2 (r2 rereview E): a non-tree entry at the held/ root (only a forger's board has one) is carried like any other
      // root entry, and the readers list it as `held/<name>` (heldOver: one row, its name's bytes) — so the writer counts it too.
      out.listingById.set(id, (out.listingById.get(id) ?? 0) + HELD_PREFIX_BYTES + (end - start));
      return;
    }
    const c = trees.facts.get(oid);
    if (c === undefined) return;
    out.byId.set(id, (out.byId.get(id) ?? 0) + c.sum);
    out.listingById.set(id, (out.listingById.get(id) ?? 0) + idListing(body.subarray(start, end), c));
  });
  return out;
}

/**
 * Tree = the previous board tree with ops.jsonl replaced (+ checkpoint when given), protocol.json and held/
 * carried by oid (mktree, R-15); nothing else of the previous tree is carried (PRO-02). `b.held` puts, replaces and
 * removes held/<id>/ subtrees, every other held/ entry carried by oid (Plan 3 Task 3). Parents
 * [prevBoard, liveCode], or [L0] for B0, which needs protocol and the height-0 checkpoint (PRO-07).
 * Every op must be the writer's own (peer, epoch) with a seq below the writer seq (PRO-09, PRO-16).
 * Never builds a commit readBoardCommit would refuse: ops.jsonl over its caps, ops.jsonl + protocol.json +
 * checkpoint/state.json or the held/ tree object over BOARD_TREE_MAX_BYTES, or a commit object over
 * BOARD_COMMIT_OBJECT_MAX_BYTES throws BoardCapError. (No put can make held/ deeper than HELD_MAX_TREE_DEPTH or put a tree at a
 * path longer than HELD_MAX_TREE_PATH_BYTES: planHeld refuses any path validPathSyntax refuses.)
 *
 * The writer's 02-protocol §3.1 cap (PRO-06; controller ruling R3-74, spec-edit list 02 §3.1): the sum S = ops.jsonl +
 * protocol.json + checkpoint/state.json + every tree object under held/ (held/ included) may not GROW past
 * BOARD_TREE_MAX_BYTES. A build is refused with BoardCapError, before commit-tree, exactly when its S is over the cap and
 * either it puts a held/ subtree while the previous board's S was over the cap already, or its held/ part is larger than the
 * previous board's. Growth is read on the held/ part: ops.jsonl is replaced by every commit and checkpoint/state.json at
 * every checkpoint height, so a whole-sum comparison would refuse an ending op or a checkpoint on an over-cap board at
 * random. Carry-only, removal-only and ending-op builds therefore always land, and an over-cap board (left by a writer that
 * ignored the rule) never blocks publishing. Only a build with puts is measured: put subtrees by the sizes planned for them,
 * carried ones by measurePrev (tree objects only); a carry-only or removal-only build cannot grow held/ and costs no call.
 * The held/ listing (HELD_LISTING_MAX_BYTES, final review F13 r2 E-1) follows the same growth rule on the same measures: a
 * build with puts whose held/ would list more than the cap is refused when the previous held/ listed more already, or when
 * it lists more than the previous one (BoardCapError, so the publish withholds the puts as for the tree cap).
 */
export async function buildBoardCommit(repo: GitRepo, b: BoardBuild): Promise<Oid> {
  const trailers = boardTrailers(b.writer, b.cs, b.csPaths);
  for (const op of b.ops) {
    const id = parseOpId(op.id);
    if (id === null || id.peer !== b.writer.peer || id.epoch !== b.writer.epoch || id.seq >= b.writer.seq) {
      throw new Error(`buildBoardCommit: op ${JSON.stringify(op.id)} is not an op of writer ${formatWriter(b.writer)} below its seq`);
    }
  }
  // serializeOps refuses more than 1,000 ops, a line over 16 KiB and more than 64 KiB (BoardCapError).
  const entries: MktreeEntry[] = [{ name: OPS_FILE, mode: '100644', type: 'blob', oid: await repo.hashBytes(serializeOps(b.ops), true) }];
  /** The previous board's held/ tree; the result of b.held's edit (when given). */
  let prevHeld: Oid | null = null;
  let edited: Awaited<ReturnType<typeof editedHeld>> | null = null;
  if (b.prevBoard === null) {
    if (b.protocol === null) throw new Error('buildBoardCommit: B0 needs protocol.json (PRO-07)');
    if (b.checkpoint === null) throw new Error('buildBoardCommit: B0 needs the height-0 checkpoint/state.json (PRO-07)');
    entries.push({ name: PROTOCOL_FILE, mode: '100644', type: 'blob', oid: await repo.hashBytes(serializeProtocol(b.protocol), true) });
    entries.push(await checkpointEntry(repo, b.checkpoint));
    edited = b.held === undefined ? null : await editedHeld(repo, undefined, b.held);
    if (edited?.entry !== undefined) entries.push(edited.entry);
  } else {
    if (b.protocol !== null) throw new Error('buildBoardCommit: protocol.json is written only at genesis and carried after it (PRO-04)');
    const prev = await topEntries(repo, b.prevBoard);
    // A previous board with nothing to carry is a malformed board (typed: publish's build_failed, never a crash).
    const protocol = prev.get(PROTOCOL_FILE);
    if (protocol === undefined || protocol.type !== 'blob') throw new BoardMalformedError('entry_missing', `buildBoardCommit: previous board ${b.prevBoard} has no protocol.json to carry`);
    entries.push(protocol);
    if (b.checkpoint !== null) {
      entries.push(await checkpointEntry(repo, b.checkpoint));
    } else {
      const ck = prev.get(CHECKPOINT_DIR);
      if (ck === undefined || ck.type !== 'tree') throw new BoardMalformedError('entry_missing', `buildBoardCommit: previous board ${b.prevBoard} has no checkpoint/ to carry`);
      entries.push(ck);
    }
    const carried = prev.get(HELD_DIR);
    if (carried?.type === 'tree') prevHeld = carried.oid;
    edited = b.held === undefined ? null : await editedHeld(repo, carried, b.held);
    const held = edited === null ? (carried?.type === 'tree' ? carried : undefined) : edited.entry;
    if (held !== undefined) entries.push(held);
  }
  const tree = await repo.mktree(entries);
  // The same rule readBoardCommit applies, on the same batch-check of the new tree (carried entries included): a size
  // over a cap is this build's (BoardCapError); a carried checkpoint/ without state.json is the previous board's.
  const found = await boardEntries(repo, tree);
  const over = capViolation(found);
  if (over !== null && over.reason === 'entry_missing') throw new BoardMalformedError(over.reason, `buildBoardCommit: previous board ${b.prevBoard ?? '(none)'} carries ${over.detail}`);
  if (over !== null) {
    // The cap that tripped, in capViolation's order (EF5 minors: BoardCapError.cap).
    const cap = (found.root?.size ?? 0) > BOARD_ROOT_TREE_MAX_BYTES ? BOARD_ROOT_TREE_MAX_BYTES : over.reason === 'ops_too_large' ? OPS_MAX_BYTES : BOARD_TREE_MAX_BYTES;
    throw new BoardCapError(`buildBoardCommit: the board tree would have ${over.detail}`, cap);
  }
  // The writer's cap (02-protocol §3.1, PRO-06, R3-74): only a build with puts can grow held/ (see above).
  if (edited !== null && edited.putBytes.size > 0) {
    const files = (found.ops?.size ?? 0) + (found.protocol?.size ?? 0) + (found.checkpoint?.size ?? 0);
    const prevSide: PrevMeasure = b.prevBoard === null
      ? { files: 0, held: 0, byId: new Map(), listing: 0, listingById: new Map() }
      : await measurePrev(repo, b.prevBoard, prevHeld);
    let held = found.held?.size ?? 0;
    for (const n of edited.putBytes.values()) held += n;
    for (const id of edited.carriedIds) held += prevSide.byId.get(id) ?? 0;
    const total = files + held;
    const prevTotal = prevSide.files + prevSide.held;
    if (total > BOARD_TREE_MAX_BYTES && (prevTotal > BOARD_TREE_MAX_BYTES || held > prevSide.held)) {
      throw new BoardCapError(
        `buildBoardCommit: the board tree would be ${total} bytes (files ${files}, held/ trees ${held}) > ${BOARD_TREE_MAX_BYTES}; `
        + `the previous board is ${prevTotal} bytes (held/ trees ${prevSide.held}), and a held/ put may neither grow held/ past the cap nor land on an over-cap board`,
        BOARD_TREE_MAX_BYTES,
      );
    }
    // The held/ listing cap (final review F13 r2, E-1; HELD_LISTING_MAX_BYTES), by the same growth rule: the readers refuse a
    // held/ over it, so a writer never grows one past it (a put while over it, or a put that makes it larger, is refused).
    let listing = 0;
    for (const n of edited.putListing.values()) listing += n;
    for (const id of edited.carriedIds) listing += prevSide.listingById.get(id) ?? 0;
    if (listing > HELD_LISTING_MAX_BYTES && (prevSide.listing > HELD_LISTING_MAX_BYTES || listing > prevSide.listing)) {
      throw new BoardCapError(
        `buildBoardCommit: held/ would list ${listing} bytes of entry paths > ${HELD_LISTING_MAX_BYTES} (the previous board lists ${prevSide.listing}), `
        + 'and a held/ put may neither grow the listing past the cap nor land on an over-cap held/',
        HELD_LISTING_MAX_BYTES,
      );
    }
  }
  const parents = b.prevBoard === null ? [b.liveCode] : [b.prevBoard, b.liveCode];
  const commit = await repo.commitTree({ tree, parents, subject: BOARD_SUBJECT, trailers });
  // The header (identity, dates) is git's, so the object is measured once written; a refused commit stays unreferenced.
  const size = await objectSize(repo, commit);
  if (size > BOARD_COMMIT_OBJECT_MAX_BYTES) {
    throw new BoardCapError(`buildBoardCommit: the board commit object would be ${size} bytes > ${BOARD_COMMIT_OBJECT_MAX_BYTES}`, BOARD_COMMIT_OBJECT_MAX_BYTES);
  }
  return commit;
}

/** Stage order (h0, h1, s1, s2, s3), then the repo path by UTF-8 bytes (git's order). */
function heldOrder(a: HeldBlob, b: HeldBlob): number {
  return a.stage === b.stage ? byUtf8(a.path, b.path) : HELD_STAGES.indexOf(a.stage) - HELD_STAGES.indexOf(b.stage);
}

/**
 * The well-formed held/ blob entries of a board commit under `prefix` (`held` or `held/<id>`), by hold id, listed from the
 * held/ walk's tree bodies (never an `ls-tree -r`). An entry is read only as `held/<ULID>/<stage>/<valid path>` naming a
 * regular, non-executable file (git's canonical mode 100644; a teammate's malformed subtree is skipped, never an error); each
 * list is in heldOrder. One `cat-file --batch-check` of `<board>:held` (and of the prefix), then the reader's verdict on held/
 * and the walk of the prefix tree, both from the walk's cache when the board was read before (the fold's read fills it).
 *
 * Final review F13 round 2 (E-1, E-5): the old `ls-tree -r` was not bounded by the §3.1 sum — it bounds the number of entries,
 * not the bytes of their paths, so a held/ far under 5 MB could list past V8's string limit (ERR_STRING_TOO_LONG, thrown out
 * of mirrorSync's heldOfTip) — nor by a JS mode parse that disagreed with git's, and git's own depth limit (2,048) is below
 * the deepest valid held path. checkHeldTreeCap refuses a held/ over the §3.1 sum, deeper or at longer paths than any valid
 * held path, or listing more than HELD_LISTING_MAX_BYTES (board_too_large), so what is listed here is bounded by those caps.
 */
async function heldEntries(repo: GitRepo, board: Oid, prefix: string): Promise<Map<string, HeldBlob[]>> {
  const hashBytes = board.length / 2;
  const names = prefix === HELD_DIR ? [`${parseOid(board)}:${HELD_DIR}`] : [`${parseOid(board)}:${HELD_DIR}`, `${board}:${prefix}`];
  const found = batchCheck((await repo.run(['cat-file', '--batch-check'], { stdin: Buffer.from(`${names.join('\n')}\n`, 'utf8') })).stdout, names.length);
  const treeOf = (e: EntryInfo | null | undefined): Oid | null => (e !== null && e !== undefined && e.type === 'tree' ? e.oid : null);
  const held = treeOf(found[0]);
  const start = names.length === 1 ? held : treeOf(found[1]);
  const byId = new Map<string, HeldBlob[]>();
  if (held === null || start === null) return byId;   // no held/ (or no such subtree): nothing listed, as before
  await checkHeldTreeCap(repo, held, hashBytes);
  const trees = await heldTrees(repo, start, hashBytes, BOARD_TREE_MAX_BYTES);
  if (trees === null) return byId;
  const stack: Array<{ oid: string; path: string }> = [{ oid: start, path: prefix }];
  while (stack.length > 0) {
    const { oid, path } = stack.pop()!;
    const raw = trees.bodies.get(oid);
    if (raw === undefined) continue;   // absent: a missing object or one of another type
    eachTreeEntry(raw, hashBytes, (mode, s, e, child) => {
      const full = `${path}/${raw.toString('utf8', s, e)}`;
      if (isTreeMode(mode)) {
        stack.push({ oid: child, path: full });
        return;
      }
      // Only a regular-file blob is a held entry: an executable, a symlink or a gitlink is malformed (never written here).
      const parts = full.split('/');
      if (!isHeldFileMode(mode) || parts.length < 4 || parts[0] !== HELD_DIR) return;
      const id = parts[1]!;
      const stage = parts[2]!;
      const p = parts.slice(3).join('/');
      if (!validId('ulid', id) || !STAGE_SET.has(stage) || !validPathSyntax(p)) return;
      let list = byId.get(id);
      if (list === undefined) {
        list = [];
        byId.set(id, list);
      }
      list.push({ stage: stage as HeldBlob['stage'], path: p, oid: child });
    });
  }
  for (const list of byId.values()) list.sort(heldOrder);
  return byId;
}

/** The held/<holdId>/ entries of a board commit's tree, in stage/path order; null when it has none (or holdId is no ULID). */
export async function readHeld(repo: GitRepo, board: Oid, holdId: string): Promise<HeldBlob[] | null> {
  if (!validId('ulid', holdId)) return null;
  return (await heldEntries(repo, board, `${HELD_DIR}/${holdId}`)).get(holdId) ?? null;
}

/**
 * Every held/ subtree of a board commit from one listing of held/ (R3-26 "once per fetched board tip"; heldEntries: the held/
 * walk, never an `ls-tree -r`), by hold id, each in stage/path order; empty when the board has no held/; board_too_large for a
 * held/ the readers refuse. The engine reads it only through its cached wrapper heldOfTip.
 */
export async function readHeldAll(repo: GitRepo, board: Oid): Promise<Map<string, HeldBlob[]>> {
  return heldEntries(repo, board, HELD_DIR);
}

/**
 * `cat-file -s`: the size of an object without reading it; a missing object throws GitCommandError. Only for a
 * commit commit-tree just wrote: `-s` measures the named object, so it must never guard a read of a foreign oid
 * (a tag would pass as small while `cat-file commit` peels it; readBoardCommit uses objectTypesAndSizes).
 */
async function objectSize(repo: GitRepo, o: Oid): Promise<number> {
  const text = (await repo.run(['cat-file', '-s', parseOid(o)])).stdout.toString('utf8').trim();
  const size = Number(text);
  if (!/^[0-9]+$/.test(text) || !Number.isSafeInteger(size)) throw new Error(`cat-file -s: unexpected output ${JSON.stringify(text.slice(0, 40))}`);
  return size;
}

/** readBoardCommit's first call: the type and size of the object an oid names, as `<type> <size>`. */
const TYPE_SIZE_CHECK = '--batch-check=%(objecttype) %(objectsize)';

/**
 * The type and size of the object each oid names, unpeeled (a tag reads as `tag`, never as the object it wraps), in
 * one `cat-file --batch-check`; nothing is read. null when the object is missing (`<oid> missing`); any other output
 * is git misbehaving, not board content, and throws a plain Error.
 */
async function objectTypesAndSizes(repo: GitRepo, oids: readonly Oid[]): Promise<Array<{ type: string; size: number } | null>> {
  const names = oids.map((o) => parseOid(o));
  const out = (await repo.run(['cat-file', TYPE_SIZE_CHECK], { stdin: Buffer.from(`${names.join('\n')}\n`, 'utf8') })).stdout.toString('utf8');
  const lines = out.split('\n');
  if (lines.length !== names.length + 1 || lines[names.length] !== '') {
    throw new Error(`cat-file --batch-check: ${lines.length - 1} records for ${names.length} objects`);
  }
  return names.map((name, i) => {
    const line = lines[i]!;
    const parts = line.split(' ');
    if (parts.length === 2 && parts[0] === name && parts[1] === 'missing') return null;
    const [type = '', sizeText = ''] = parts;
    const size = Number(sizeText);
    if (parts.length !== 2 || !/^[a-z]+$/.test(type) || !/^[0-9]+$/.test(sizeText) || !Number.isSafeInteger(size)) {
      throw new Error(`cat-file --batch-check: unexpected record ${JSON.stringify(line.slice(0, 120))}`);
    }
    return { type, size };
  });
}

/**
 * A 2-part `cat-file --batch(-check)` record has no object to read: `<name> missing`, `<name> ambiguous`,
 * `<oid> submodule` (a gitlink, git 2.46+) or any later word of that form. It reads as an absent entry.
 */
function isAbsentRecord(parts: readonly string[]): boolean {
  return parts.length === 2 && parts[0]!.length > 0 && /^[a-z]+$/.test(parts[1]!);
}

export interface BatchObject { type: string; body: Buffer; }

/** `cat-file --batch` records; a 2-part record (missing, ambiguous, submodule, ...) is null. */
export function batchObjects(out: Buffer, expected: number): Array<BatchObject | null> {
  const items: Array<BatchObject | null> = [];
  let pos = 0;
  while (items.length < expected) {
    const nl = out.indexOf(0x0a, pos);
    if (nl < 0) throw new Error('cat-file --batch: truncated output');
    const parts = out.toString('utf8', pos, nl).split(' ');
    pos = nl + 1;
    if (isAbsentRecord(parts)) {
      items.push(null);
      continue;
    }
    const size = Number(parts[2]);
    if (parts.length !== 3 || !Number.isSafeInteger(size) || size < 0 || pos + size > out.length) {
      throw new Error(`cat-file --batch: malformed header ${JSON.stringify(parts.join(' ').slice(0, 120))}`);
    }
    items.push({ type: parts[1]!, body: out.subarray(pos, pos + size) });
    pos += size + 1;
  }
  return items;
}

/**
 * The object type a raw tree-entry mode names, as git reads it (tree-walk.c get_mode, then canon_mode): git accumulates the
 * octal digits into an unsigned 32-bit int, so only the low bits survive, and S_IFMT picks the type — 0o040000 a subtree,
 * 0o100000 or 0o120000 a blob (file or symlink), anything else a gitlink. The last six digits hold every bit S_IFMT and the
 * permission bits read (bits 0–17), so they are parsed alone: a whole-string parse of a mode longer than about 17 digits
 * loses those low bits as a JS number while git still descends the entry (final review F13 r2, E-1: such a mode passes
 * fetch.fsckObjects, only a zero-padded one is refused). Shared with batchRead.ts (one parse for every reader).
 */
export function modeType(mode: string): 'tree' | 'blob' | 'commit' {
  const fmt = Number.parseInt(mode.slice(-6), 8) & 0o170000;
  return fmt === 0o040000 ? 'tree' : fmt === 0o100000 || fmt === 0o120000 ? 'blob' : 'commit';
}

/** Whether a raw tree-entry mode names a subtree for git: octal digits only (git refuses any other byte), then modeType. */
function isTreeMode(mode: string): boolean {
  return /^[0-7]+$/.test(mode) && modeType(mode) === 'tree';
}

/** A held/ entry is a regular, non-executable file: git's canon_mode of the stored mode is 100644 (what `ls-tree` prints). */
function isHeldFileMode(mode: string): boolean {
  if (!/^[0-7]+$/.test(mode)) return false;
  const m = Number.parseInt(mode.slice(-6), 8);
  return (m & 0o170000) === 0o100000 && (m & 0o100) === 0;
}

/**
 * Calls `fn` for each `<mode> <name>\0<hash>` entry of a raw tree object, in stored order: the mode as stored, the byte range
 * of the name in `raw` and the entry's object id. A truncated entry is a malformed tree object (a plain Error: git never
 * writes one and fetch.fsckObjects refuses one).
 */
function eachTreeEntry(raw: Buffer, hashBytes: number, fn: (mode: string, nameStart: number, nameEnd: number, oid: Oid) => void): void {
  let pos = 0;
  while (pos < raw.length) {
    const sp = raw.indexOf(0x20, pos);
    const nul = sp < 0 ? -1 : raw.indexOf(0x00, sp + 1);
    if (nul < 0 || nul + 1 + hashBytes > raw.length) throw new Error('readBoardCommit: malformed tree object');
    fn(raw.toString('latin1', pos, sp), sp + 1, nul, raw.toString('hex', nul + 1, nul + 1 + hashBytes) as Oid);
    pos = nul + 1 + hashBytes;
  }
}

/** Names of the subtree entries of a raw tree object (`<mode> <name>\0<hash>` records; git's mode parse, modeType). */
export function subtreeNames(raw: Buffer, hashBytes: number): string[] {
  const names: string[] = [];
  eachTreeEntry(raw, hashBytes, (mode, start, end) => {
    if (isTreeMode(mode)) names.push(raw.toString('utf8', start, end));
  });
  return names;
}

// ---- the held/ walk (02-protocol §3.1; final review F13, round 2 E-1, E-2, E-3) -------------------------------------------

/** SEC-35 (validPathSyntax): a valid repo path is at most 4,096 UTF-8 bytes, so it has at most 2,048 components. */
const REPO_PATH_MAX_BYTES = 4_096;
/**
 * The deepest tree a valid held/ holds, in tree levels below held/ (held/ itself is level 0): `<hold_id>` 1, `<stage>` 2, then
 * the directories of a repo path of at most 2,048 components, at most 2,047 levels (final review F13 r2, E-2). A held/ with a
 * deeper tree can hold no valid entry there, and no writer builds one (planHeld validates every path): board_too_large.
 */
export const HELD_MAX_TREE_DEPTH = 2 + REPO_PATH_MAX_BYTES / 2 - 1;
/**
 * The longest `/`-joined path below held/ at which a valid held/ holds a tree: `<ULID>/<stage>/` (30 bytes) and the directory
 * of a repo path of at most 4,096 bytes (at most 4,094 bytes: a name of at least one byte follows it). A held/ with a tree at a
 * longer path can hold no valid entry there, and no writer builds one: board_too_large (final review F13 r2, E-1).
 */
export const HELD_MAX_TREE_PATH_BYTES = 26 + 1 + 2 + 1 + (REPO_PATH_MAX_BYTES - 2);
/**
 * The held/ listing cap (final review F13 r2, E-1): the bytes of every entry path a full listing of held/ names — one
 * `held/<id>/<stage>/<path>` per non-tree entry, counted at every path it appears under, as `ls-tree -r` would print them —
 * at most 32 MiB (BATCH_READ_MAX_BYTES, one batch read). The §3.1 sum bounds the number of entries but not their path
 * bytes (each line carries its full path), so the readers refuse a held/ over this (board_too_large) and readHeldAll's result
 * stays bounded, and the writer never grows a held/ past it (buildBoardCommit, as for the §3.1 sum).
 */
export const HELD_LISTING_MAX_BYTES = 33_554_432;
/** git's core.maxTreeDepth for the walk's traversal: past HELD_MAX_TREE_DEPTH, so git traverses every valid held/ in full. */
const WALK_MAX_TREE_DEPTH = HELD_MAX_TREE_DEPTH + 2;
/** The one stderr text the walk reads: git stopping at core.maxTreeDepth (LC_ALL=C is forced, so the text is git's own). */
const DEPTH_EXCEEDED = 'exceeded maximum allowed tree depth';
const HELD_PREFIX_BYTES = HELD_DIR.length + 1;

/**
 * What the walk knows of one tree object, a pure function of its content (so cached by oid): its object size and, over every
 * path below it (each counted at every path it appears under), the §3.1 sum of its tree objects (itself included), the depth
 * of its deepest subtree in levels, the bytes of its longest `/`-joined subtree path, and the number of its non-tree entries
 * and the bytes of their paths relative to it. Each saturates one past the cap it is checked against, so a deduplicated tree
 * bomb's astronomical counts stay small numbers.
 */
interface TreeFacts { size: number; sum: number; height: number; longest: number; rows: number; rel: number; }
/** The trees at and below a walked root: the facts and the raw body of each tree object, by oid. */
interface HeldTrees { facts: ReadonlyMap<string, TreeFacts>; bodies: ReadonlyMap<string, Buffer>; }

const sat = (n: number, max: number): number => (n > max ? max + 1 : n);

/** The facts of a tree from its raw body, its size and the facts of its subtrees (an unknown subtree is absent: no tree object). */
function treeFacts(raw: Buffer, size: number, hashBytes: number, known: ReadonlyMap<string, TreeFacts>): TreeFacts {
  let sum = size;
  let height = 0;
  let longest = 0;
  let rows = 0;
  let rel = 0;
  eachTreeEntry(raw, hashBytes, (mode, start, end, oid) => {
    const name = end - start;
    if (!isTreeMode(mode)) {
      rows = sat(rows + 1, HELD_LISTING_MAX_BYTES);
      rel = sat(rel + name, HELD_LISTING_MAX_BYTES);
      return;
    }
    const c = known.get(oid);
    if (c === undefined) return;   // a missing object or one of another type: no tree is there
    sum = sat(sum + c.sum, BOARD_TREE_MAX_BYTES);
    height = Math.max(height, sat(1 + c.height, HELD_MAX_TREE_DEPTH));
    longest = Math.max(longest, sat(name + (c.longest > 0 ? 1 + c.longest : 0), HELD_MAX_TREE_PATH_BYTES));
    rows = sat(rows + c.rows, HELD_LISTING_MAX_BYTES);
    rel = sat(rel + c.rows * (name + 1) + c.rel, HELD_LISTING_MAX_BYTES);
  });
  return { size, sum: sat(sum, BOARD_TREE_MAX_BYTES), height, longest, rows, rel };
}

/** Why a held/ tree with these facts is board_too_large, or null (the four held/ caps; see HELD_MAX_TREE_DEPTH and the others). */
function heldOver(f: TreeFacts): string | null {
  if (f.sum > BOARD_TREE_MAX_BYTES) return `tree objects sum to more than the ${BOARD_TREE_MAX_BYTES}-byte board tree cap (02-protocol §3.1)`;
  if (f.height > HELD_MAX_TREE_DEPTH) return `holds a tree more than ${HELD_MAX_TREE_DEPTH} levels deep, deeper than any valid held path`;
  if (f.longest > HELD_MAX_TREE_PATH_BYTES) return `holds a tree at a path of more than ${HELD_MAX_TREE_PATH_BYTES} bytes, longer than any valid held path`;
  if (f.rows * HELD_PREFIX_BYTES + f.rel > HELD_LISTING_MAX_BYTES) return `would list more than ${HELD_LISTING_MAX_BYTES} bytes of entry paths`;
  return null;
}

const tooLarge = (detail: string): BoardMalformedError => new BoardMalformedError('board_too_large', `the held/ tree ${detail}`);
const isTooLarge = (e: unknown): e is BoardMalformedError => e instanceof BoardMalformedError && e.reason === 'board_too_large';

/**
 * The walk's memory per repo (content-addressed, so a clear is always sound): the facts of every tree it measured, the bodies
 * it read (for the listings), and the held/ roots it refused before any facts existed (git's depth limit, too many trees).
 */
interface WalkCache { facts: Map<string, TreeFacts>; bodies: Map<string, Buffer>; bodyBytes: number; over: Map<string, string>; }
const walkCaches = new WeakMap<GitRepo, WalkCache>();
const BODY_CACHE_MAX_BYTES = 16_777_216;
const HELD_CAP_CACHE_MAX = 8_192;
function walkCacheOf(repo: GitRepo): WalkCache {
  let c = walkCaches.get(repo);
  if (c === undefined) {
    c = { facts: new Map(), bodies: new Map(), bodyBytes: 0, over: new Map() };
    walkCaches.set(repo, c);
  }
  return c;
}

/** No held/ within `readMax` bytes of distinct trees has more: a non-empty tree object is at least hashBytes + 4 bytes. */
export const maxDistinctTrees = (hashBytes: number, readMax: number): number => Math.floor(readMax / (hashBytes + 4)) + 1;

/**
 * The facts cache's size (integration I-2, r2 rereview E): twice the distinct trees a held/ the readers accept can have (SHA-1, the
 * smallest hash: 416,668), so with least-recently-used eviction (rememberFacts) one board's trees survive the next board's walk. The
 * clear-all at 131,072 it replaces made every other walk of a near-cap held/ (> 131k distinct trees) re-read every tree.
 */
export const FACTS_CACHE_MAX = 2 * maxDistinctTrees(20, BOARD_TREE_MAX_BYTES);

/**
 * The facts cache's update after a walk (integration I-2): every `hits` oid the cache holds moves to the most recently used end, then
 * the least recently used entries go until `fresh` fits under `max`, then `fresh` is added. A walk lists every tree of its board, so
 * with max ≥ 2 × the trees of one walk the previous walk's trees are all newer than anything evicted by the next one.
 */
export function rememberFacts<V>(cache: Map<string, V>, hits: Iterable<string>, fresh: ReadonlyArray<readonly [string, V]>, max: number): void {
  for (const o of hits) {
    const v = cache.get(o);
    if (v === undefined) continue;
    cache.delete(o);
    cache.set(o, v);
  }
  let excess = cache.size + fresh.length - max;
  if (excess > 0) {
    for (const k of cache.keys()) {
      cache.delete(k);
      if (--excess <= 0) break;
    }
  }
  for (const [k, v] of fresh) cache.set(k, v);
}

/**
 * Every distinct tree object at and below `root`, from one `rev-list --objects --filter=blob:none --missing=allow-any`: git's
 * own traversal (its mode parse decides what a subtree is, a tree reached by many paths is listed once, a missing object is
 * skipped and a tree-mode entry naming another type is listed as that object), with core.maxTreeDepth = WALK_MAX_TREE_DEPTH.
 * `{over}` when git stops at that depth, or when its output names more trees than `readMax` bytes of distinct trees can hold
 * (checked on the output's length, before it is decoded).
 */
async function listTrees(repo: GitRepo, root: Oid, hashBytes: number, readMax: number): Promise<{ oids: Oid[] } | { over: string }> {
  const args = ['rev-list', '--objects', '--no-object-names', '--filter=blob:none', '--missing=allow-any', parseOid(root)];
  const r = await repo.run(args, { okCodes: [0, 128], config: { 'core.maxTreeDepth': String(WALK_MAX_TREE_DEPTH) } });
  if (r.code !== 0) {
    if (r.stderr.toString('utf8').includes(DEPTH_EXCEEDED)) return { over: `holds a tree more than ${WALK_MAX_TREE_DEPTH} levels deep (git's traversal stopped)` };
    throw new GitCommandError(args, r.code, r.stderr);
  }
  if (r.stdout.length > maxDistinctTrees(hashBytes, readMax) * (root.length + 1)) return { over: `has more distinct tree objects than ${readMax} bytes can hold` };
  const oids = r.stdout.toString('latin1').split('\n');
  if (oids.pop() !== '') throw new Error('rev-list: unterminated output');
  for (const o of oids) if (o.length !== root.length || !isOid(o)) throw new Error(`rev-list: unexpected record ${JSON.stringify(o.slice(0, 80))}`);
  return { oids: oids as Oid[] };
}

/**
 * The held/ walk (02-protocol §3.1; final review F13, round 2 E-1/E-2/E-3): three git calls whatever the depth or shape of the
 * held/ (or held/<id>/) tree `root` — no `ls-tree -r`, no call per tree level. listTrees names every distinct tree at and
 * below it; one `cat-file --batch-check` sizes those the cache does not know (and, with `allBodies`, those whose body is not
 * cached), refusing board_too_large when the distinct trees alone are over `readMax` bytes (each is counted at least once in
 * the §3.1 sum, so this bounds what step three reads); one `cat-file --batch` reads their bodies. The facts of each new tree
 * are computed from its entries and its subtrees' facts (TreeFacts) and cached by oid, so a changed held/ reads only its new
 * trees, and a deduplicated bomb is measured from its handful of distinct objects. Returns the facts and bodies of the trees
 * it read or knew (`allBodies`: every body below `root`), or null when `root` itself is absent (rev-list skips a missing
 * object). A tree rev-list listed that batch-check then cannot find is a GitCommandError (git disagreeing with itself); one
 * of another type (a tree-mode entry naming a blob, which fetch.fsckObjects refuses) reads as absent.
 */
async function walkTrees(repo: GitRepo, root: Oid, hashBytes: number, allBodies: boolean, readMax: number): Promise<HeldTrees | null> {
  const cache = walkCacheOf(repo);
  const listed = await listTrees(repo, root, hashBytes, readMax);
  if ('over' in listed) throw tooLarge(listed.over);
  if (!listed.oids.includes(root)) return null;
  // A snapshot of what the cache knows now: a clear while the reads below run must not make a known subtree read as absent.
  const facts = new Map<string, TreeFacts>();
  const bodies = new Map<string, Buffer>();
  const sizes = new Map<string, number>();
  const unknown: Oid[] = [];
  for (const o of listed.oids) {
    const f = cache.facts.get(o);
    const b = cache.bodies.get(o);
    if (f !== undefined) {
      facts.set(o, f);
      sizes.set(o, f.size);
    }
    if (b !== undefined) bodies.set(o, b);
    if (f === undefined || (allBodies && b === undefined)) unknown.push(o);
  }
  const toRead: Oid[] = [];
  if (unknown.length > 0) {
    const args = ['cat-file', '--batch-check'];
    const r = await repo.run(args, { stdin: Buffer.from(`${unknown.join('\n')}\n`, 'utf8') });
    batchCheck(r.stdout, unknown.length).forEach((e, i) => {
      const o = unknown[i]!;
      if (e === null) throw new GitCommandError(args, r.code, Buffer.from(`the held/ walk: ${o} is listed by rev-list but missing`, 'utf8'));
      if (e.type !== 'tree') return;   // a tree-mode entry naming another type: absent
      sizes.set(o, e.size);
      toRead.push(o);
    });
  }
  let distinct = 0;
  for (const n of sizes.values()) distinct += n;
  if (distinct > readMax) throw tooLarge(`has more than ${readMax} bytes of distinct tree objects (02-protocol §3.1)`);
  if (toRead.length > 0) {
    const r = await repo.run(['cat-file', '--batch'], { stdin: Buffer.from(`${toRead.join('\n')}\n`, 'utf8') });
    batchObjects(r.stdout, toRead.length).forEach((o, i) => {
      const oid = toRead[i]!;
      if (o === null || o.type !== 'tree' || o.body.length !== sizes.get(oid)) throw new Error(`the held/ walk: cat-file --batch disagrees with --batch-check on ${oid}`);
      bodies.set(oid, Buffer.from(o.body));   // a copy of its own, never a view keeping the whole output alive
    });
  }
  // The facts of every tree read without known facts, children first (an explicit stack: a held/ may be thousands deep).
  const fresh: string[] = [];
  for (const start of toRead) {
    if (facts.has(start)) continue;
    const stack: Array<{ oid: string; kids: string[] | null }> = [{ oid: start, kids: null }];
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      if (top.kids === null) {
        const kids: string[] = [];
        eachTreeEntry(bodies.get(top.oid)!, hashBytes, (mode, _s, _e, oid) => {
          if (isTreeMode(mode) && !facts.has(oid) && bodies.has(oid)) kids.push(oid);
        });
        top.kids = kids;
      }
      const kid = top.kids.pop();
      if (kid !== undefined) {
        if (!facts.has(kid)) {
          if (stack.length > sizes.size) throw new Error('the held/ walk: a tree cycle');   // content addressing forbids one
          stack.push({ oid: kid, kids: null });
        }
        continue;
      }
      facts.set(top.oid, treeFacts(bodies.get(top.oid)!, sizes.get(top.oid)!, hashBytes, facts));
      fresh.push(top.oid);
      stack.pop();
    }
  }
  rememberFacts(cache.facts, listed.oids, fresh.map((o) => [o, facts.get(o)!] as const), FACTS_CACHE_MAX);
  let added = 0;
  for (const o of toRead) added += bodies.get(o)!.length;
  if (cache.bodyBytes + added > BODY_CACHE_MAX_BYTES) {
    cache.bodies.clear();
    cache.bodyBytes = 0;
  }
  if (added <= BODY_CACHE_MAX_BYTES) {
    for (const o of toRead) {
      if (cache.bodies.has(o)) continue;
      cache.bodies.set(o, bodies.get(o)!);
      cache.bodyBytes += bodies.get(o)!.length;
    }
  }
  return { facts, bodies };
}

/** Every tree at and below `root` from the walk's cache alone (facts and body of each), or null at the first one it lacks. */
function cachedTrees(cache: WalkCache, root: Oid, hashBytes: number): HeldTrees | null {
  const facts = new Map<string, TreeFacts>();
  const bodies = new Map<string, Buffer>();
  const stack: string[] = [root];
  while (stack.length > 0) {
    const o = stack.pop()!;
    if (bodies.has(o)) continue;
    const f = cache.facts.get(o);
    const b = cache.bodies.get(o);
    if (f === undefined || b === undefined) return null;
    facts.set(o, f);
    bodies.set(o, b);
    eachTreeEntry(b, hashBytes, (mode, _s, _e, oid) => {
      if (isTreeMode(mode) && !bodies.has(oid)) stack.push(oid);
    });
  }
  return { facts, bodies };
}

/** Every tree at and below `root` with its body (the listings and the writer's measure): from the cache, else one walk. */
async function heldTrees(repo: GitRepo, root: Oid, hashBytes: number, readMax: number): Promise<HeldTrees | null> {
  return cachedTrees(walkCacheOf(repo), root, hashBytes) ?? walkTrees(repo, root, hashBytes, true, readMax);
}

/**
 * The reader's held/ verdict (02-protocol §3.1 and the held/ caps; final review F13, round 2 E-1/E-2): throws board_too_large
 * when the held/ tree's §3.1 sum is over BOARD_TREE_MAX_BYTES, when it holds a tree deeper than HELD_MAX_TREE_DEPTH or at a
 * path longer than HELD_MAX_TREE_PATH_BYTES, or when its listing is over HELD_LISTING_MAX_BYTES — never expanding it. From
 * the cache when its facts are known (the fold's per-commit read of a carried held/ costs no call; so does the incident
 * check's range once the fold or another read measured it), else one walk (three git calls).
 */
async function checkHeldTreeCap(repo: GitRepo, held: Oid, hashBytes: number): Promise<void> {
  const cache = walkCacheOf(repo);
  const known = cache.over.get(held);
  if (known !== undefined) throw tooLarge(known);
  let f = cache.facts.get(held);
  if (f === undefined) {
    try {
      f = (await walkTrees(repo, held, hashBytes, false, BOARD_TREE_MAX_BYTES))?.facts.get(held);
    } catch (e) {
      if (isTooLarge(e)) {
        if (cache.over.size >= HELD_CAP_CACHE_MAX) cache.over.clear();
        cache.over.set(held, e.message.replace(/^the held\/ tree /, ''));
      }
      throw e;
    }
  }
  if (f === undefined) return;   // absent: nothing under held/ to measure (readBoardCommit found it a tree, so a race)
  const over = heldOver(f);
  if (over !== null) throw tooLarge(over);
}

export interface EntryInfo { oid: Oid; type: string; size: number; }

/** `cat-file --batch-check` records (`<oid> <type> <size>`); a 2-part record (missing, ambiguous, submodule, ...) is null. */
export function batchCheck(out: Buffer, expected: number): Array<EntryInfo | null> {
  const lines = out.toString('utf8').split('\n');
  const items: Array<EntryInfo | null> = [];
  for (let i = 0; i < expected; i++) {
    const line = lines[i];
    if (line === undefined || i + 1 >= lines.length) throw new Error('cat-file --batch-check: truncated output');
    const parts = line.split(' ');
    if (isAbsentRecord(parts)) {
      items.push(null);
      continue;
    }
    const size = Number(parts[2]);
    if (parts.length !== 3 || !isOid(parts[0]) || !Number.isSafeInteger(size) || size < 0) {
      throw new Error(`cat-file --batch-check: malformed record ${JSON.stringify(line.slice(0, 120))}`);
    }
    items.push({ oid: parts[0] as Oid, type: parts[1]!, size });
  }
  return items;
}

/**
 * The root tree object and the four entries of a board tree the fold reads; null when missing or of another type (a
 * gitlink included).
 */
export interface BoardEntries { root: EntryInfo | null; ops: EntryInfo | null; protocol: EntryInfo | null; checkpoint: EntryInfo | null; held: EntryInfo | null; }

/**
 * One `cat-file --batch-check` of `<tree>` itself, `<tree>:ops.jsonl`, `:protocol.json`, `:checkpoint/state.json` and
 * `:held`, for every tree: types and sizes only, nothing listed or read.
 */
async function boardEntriesOf(repo: GitRepo, trees: readonly Oid[]): Promise<BoardEntries[]> {
  const names = trees.flatMap((tree) => [`${tree}`, `${tree}:${OPS_FILE}`, `${tree}:${PROTOCOL_FILE}`, `${tree}:${CHECKPOINT_DIR}/${STATE_FILE}`, `${tree}:${HELD_DIR}`]);
  const checked = await repo.run(['cat-file', '--batch-check'], { stdin: Buffer.from(`${names.join('\n')}\n`, 'utf8') });
  const ofType = (e: EntryInfo | null | undefined, type: string): EntryInfo | null => (e !== null && e !== undefined && e.type === type ? e : null);
  const all = batchCheck(checked.stdout, names.length);
  return trees.map((_, i) => {
    const [root, ops, protocol, checkpoint, held] = all.slice(5 * i, 5 * i + 5);
    return { root: ofType(root, 'tree'), ops: ofType(ops, 'blob'), protocol: ofType(protocol, 'blob'), checkpoint: ofType(checkpoint, 'blob'), held: ofType(held, 'tree') };
  });
}

async function boardEntries(repo: GitRepo, tree: Oid): Promise<BoardEntries> {
  return (await boardEntriesOf(repo, [tree]))[0]!;
}

/**
 * The board tree rules on types and sizes alone, shared by readBoardCommit, checkBoardCommits and the builder's
 * self-check, in this order: a root tree object over BOARD_ROOT_TREE_MAX_BYTES (`board_too_large`), an ops.jsonl over
 * 64 KiB (`ops_too_large`), ops.jsonl + protocol.json + checkpoint/state.json or a held/ tree object over
 * BOARD_TREE_MAX_BYTES (`board_too_large`), no checkpoint/state.json blob (`entry_missing`, final review FA-2).
 */
export function capViolation(e: BoardEntries): { reason: 'ops_too_large' | 'board_too_large' | 'entry_missing'; detail: string } | null {
  const root = e.root?.size ?? 0;
  if (root > BOARD_ROOT_TREE_MAX_BYTES) return { reason: 'board_too_large', detail: `a root tree object of ${root} bytes > ${BOARD_ROOT_TREE_MAX_BYTES}` };
  if (e.ops !== null && e.ops.size > OPS_MAX_BYTES) return { reason: 'ops_too_large', detail: `an ops.jsonl of ${e.ops.size} bytes > ${OPS_MAX_BYTES}` };
  const files = (e.ops?.size ?? 0) + (e.protocol?.size ?? 0) + (e.checkpoint?.size ?? 0);
  const held = e.held?.size ?? 0;
  if (files > BOARD_TREE_MAX_BYTES || held > BOARD_TREE_MAX_BYTES) {
    return { reason: 'board_too_large', detail: `more than the ${BOARD_TREE_MAX_BYTES}-byte board tree cap (files ${files}, held/ ${held})` };
  }
  if (e.checkpoint === null) return { reason: 'entry_missing', detail: 'no checkpoint/state.json blob (PRO-02)' };
  return null;
}

/** Strict UTF-8 that keeps a BOM as stored (the default decoder would strip it and make a BOM line valid). */
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** A line that is not valid UTF-8 (PRO-03) reads as '': a no-op that keeps its position. */
function decodeLine(bytes: Uint8Array): string {
  try {
    return UTF8_STRICT.decode(bytes);
  } catch {
    return '';
  }
}

/** The first 1,000 lines, an unterminated last line included; readBoardCommit has refused anything over 64 KiB. */
export function opsLinesOf(buf: Buffer | null): string[] {
  const lines: string[] = [];
  if (buf === null) return lines;
  let pos = 0;
  while (lines.length < OPS_MAX_LINES && pos < buf.length) {
    const lf = buf.indexOf(0x0a, pos);
    const end = lf < 0 ? buf.length : lf;
    lines.push(decodeLine(buf.subarray(pos, end)));
    pos = end + 1;
  }
  return lines;
}

/**
 * A copy of a validated ASCII id (an oid, a peer, epoch or change-set id) in a string of its own (final review FA-3): a
 * substring keeps the whole string it was cut from alive in V8, here a commit text of up to 1 MiB.
 */
function ownAscii(s: string): string {
  return Buffer.from(s, 'latin1').toString('latin1');
}

function ownWriter(w: WriterId | null): WriterId | null {
  return w === null ? null : { peer: ownAscii(w.peer), epoch: ownAscii(w.epoch), seq: w.seq };
}

/**
 * Reads what the fold needs from a board commit (02-protocol §3.3 inputs) in four git calls plus, when the board carries a
 * held/ tree the walk has not measured, the held/ walk's three (checkHeldTreeCap; its facts are cached per tree object, so a
 * carried held/ costs nothing across the fold's per-commit reads): one `cat-file --batch-check='%(objecttype) %(objectsize)'` of the unpeeled oid, the
 * commit (`cat-file commit`), one `cat-file --batch-check` of ops.jsonl, protocol.json, checkpoint/state.json and held/, then
 * one `cat-file --batch` of the well-typed ones. Types and sizes are checked before any content is read.
 * Errors from the board's content are typed BoardMalformedError: an oid that names a tag, tree or blob, whatever
 * its size (`not_commit`; a tag is never peeled, so it cannot carry an over-cap commit past the size check), a
 * commit object over BOARD_COMMIT_OBJECT_MAX_BYTES (`commit_too_large`, never read), a commit without parents
 * (`no_parent`), a root tree object over BOARD_ROOT_TREE_MAX_BYTES, an ops.jsonl over 64 KiB (`ops_too_large`),
 * ops.jsonl + protocol.json + checkpoint/state.json over BOARD_TREE_MAX_BYTES, the held/ tree object over it, the §3.1
 * sum of every tree object under held/ over it, or a held/ deeper than HELD_MAX_TREE_DEPTH, with a tree at a path longer than
 * HELD_MAX_TREE_PATH_BYTES or listing more than HELD_LISTING_MAX_BYTES (`board_too_large`, final review F13 and its round 2;
 * the oversized object is never read and held/ is never expanded), no checkpoint/state.json blob (`entry_missing`). A missing
 * oid is not board content: it throws a plain Error, as does git output of the wrong shape. Any other missing or
 * mistyped entry, and any 2-part batch record (missing, ambiguous, a gitlink's `submodule`, or another word), reads
 * as absent: no ops, readProtocol(null), no held ids.
 * `opts` (final review FA-3) leaves the checkpoint or held/ body unread: every check above still runs on its type and
 * size; `checkpoint` is then null and `heldIds` []. Nothing returned keeps a larger object alive: the checkpoint is a
 * Buffer of its own (never a view of the whole `cat-file --batch` output), and the writer's and the change-sets' ids
 * are strings of their own (never substrings of the commit text, up to 1 MiB, which V8 would keep with them).
 */
export async function readBoardCommit(repo: GitRepo, oid: Oid, opts: ReadBoardOptions = {}): Promise<BoardCommitData> {
  const object = (await objectTypesAndSizes(repo, [oid]))[0] ?? null;
  if (object === null) throw new Error(`readBoardCommit: ${oid} is missing`);
  if (object.type !== 'commit') {
    throw new BoardMalformedError('not_commit', `readBoardCommit: ${oid} is a ${object.type}, not a commit (a board ref names a commit; a tag is never peeled)`);
  }
  if (object.size > BOARD_COMMIT_OBJECT_MAX_BYTES) {
    throw new BoardMalformedError('commit_too_large', `readBoardCommit: ${oid} is a ${object.size}-byte commit object > ${BOARD_COMMIT_OBJECT_MAX_BYTES}`);
  }
  const info = await repo.readCommit(oid);
  const last = info.parents[info.parents.length - 1];
  if (last === undefined) throw new BoardMalformedError('no_parent', `readBoardCommit: ${oid} has no parent, so it is not a board commit`);
  const found = await boardEntries(repo, info.tree);
  const over = capViolation(found);
  if (over !== null) throw new BoardMalformedError(over.reason, `readBoardCommit: ${oid} has ${over.detail}`);
  // 02-protocol §3.1 held/ part (final review F13): the per-path sum of every tree object under held/, not just the root
  // held/ tree object capViolation checked, so a deduplicated tree bomb (a tiny root reached by astronomically many paths)
  // is refused board_too_large and never expanded; with round 2's depth, path and listing caps on held/ (checkHeldTreeCap).
  // Always checked (sizes are, even with held false); cached per tree object, so the fold's per-commit read of a carried
  // held/ costs no call.
  if (found.held !== null) await checkHeldTreeCap(repo, found.held.oid, oid.length / 2);
  const ops = found.ops;
  const protocol = found.protocol;
  const checkpoint = opts.checkpoint === false ? null : found.checkpoint;
  const held = opts.held === false ? null : found.held;
  const present = [ops, protocol, checkpoint, held].filter((e): e is EntryInfo => e !== null);
  const bodies = new Map<EntryInfo, Buffer>();
  if (present.length > 0) {
    const r = await repo.run(['cat-file', '--batch'], { stdin: Buffer.from(`${present.map((e) => e.oid).join('\n')}\n`, 'utf8') });
    batchObjects(r.stdout, present.length).forEach((o, i) => {
      const e = present[i]!;
      if (o === null || o.type !== e.type || o.body.length !== e.size) throw new Error(`readBoardCommit: cat-file --batch disagrees with --batch-check on ${e.oid}`);
      bodies.set(e, o.body);
    });
  }
  const body = (e: EntryInfo | null): Buffer | null => (e === null ? null : (bodies.get(e) ?? null));
  const heldBody = body(held);
  const checkpointBody = body(checkpoint);
  const writers = info.trailers.filter((t) => t.key === WRITER_KEY);
  return {
    oid,
    parents: [...info.parents],
    firstParent: info.parents.length >= 2 ? info.parents[0]! : null,
    liveCode: last,
    writer: writers.length === 1 ? ownWriter(parseWriter(writers[0]!.value)) : null,
    cs: parseCsTrailers(info.trailers).cs.map((c) => ({ ...c, csId: ownAscii(c.csId) })),
    protocol: readProtocol(body(protocol)),
    opsLines: opsLinesOf(body(ops)),
    checkpoint: checkpointBody === null ? null : Buffer.from(checkpointBody),
    heldIds: heldBody === null ? [] : subtreeNames(heldBody, oid.length / 2),
  };
}

/**
 * What readBoardCommit leaves unread (final review FA-3): the fold reads checkpoint/state.json only at a checkpoint
 * height (or where it starts) and never held/ in Plan 2; every type and size check still runs. Both default to true.
 */
export interface ReadBoardOptions {
  /** false: checkpoint/state.json is checked but not read, and `checkpoint` is null. */
  checkpoint?: boolean;
  /** false: the held/ tree object is checked but not read, and `heldIds` is []. */
  held?: boolean;
}

/**
 * A commit as readCommitsChecked found it: parsed into its shape record (shapeRecord: what boardShapeOk and liveShape
 * read), or why it was not read (readBoardCommit's first two refusals).
 */
export type CheckedCommit = { commit: CommitInfo; refused: null } | { commit: null; refused: 'not_commit' | 'commit_too_large' };

/**
 * The shape record of a commit (final review FA-3): exactly what boardShapeOk and liveShape read, in strings of its
 * own, so a range of commits keeps a few hundred bytes per commit whatever its message holds (each board commit may be
 * up to 1 MiB, and a hostile range packs thousands of them into a small push). oid and tree as parsed
 * (parseCommitObject copies the oids out of the commit text); the parents as parsed when there are at most three, else
 * the first two and the last (git and fsck accept a commit repeating one existing parent ~21,000 times in 1 MiB); the
 * subject is SKIP_SUBJECT_PREFIX when it starts with it, else ''; the trailers are one `skip-checks` and one
 * `Cowork-Proto` (values dropped: only their presence is a marker) when present, and the first two `Cowork-Base`
 * trailers, each value kept only when it is an oid (else ''). Every verdict is the same as on the full CommitInfo: the
 * shape checks read a parent count of 0, 1, 2 or more, the first two parents and (the incident check's live code
 * commit) the last one; the markers are presence tests; a Cowork-Base count of 0, 1 or "more" is all liveShape tells
 * apart; a value that is no oid never equals a parent nor passes isOid.
 */
function shapeRecord(c: CommitInfo): CommitInfo {
  const trailers: Trailer[] = [];
  let skip = false;
  let proto = false;
  let bases = 0;
  for (const t of c.trailers) {
    if (t.key === SKIP_CHECKS && !skip) {
      skip = true;
      trailers.push({ key: SKIP_CHECKS, value: '' });
    } else if (t.key === PROTO_KEY && !proto) {
      proto = true;
      trailers.push({ key: PROTO_KEY, value: '' });
    } else if (t.key === BASE_KEY && bases < 2) {
      bases += 1;
      trailers.push({ key: BASE_KEY, value: isOid(t.value) ? ownAscii(t.value) : '' });
    }
  }
  const p = c.parents;
  const parents = p.length <= 3 ? [...p] : [p[0]!, p[1]!, p[p.length - 1]!];
  return { oid: c.oid, tree: c.tree, parents, subject: c.subject.startsWith(SKIP_SUBJECT_PREFIX) ? SKIP_SUBJECT_PREFIX : '', trailers };
}

/**
 * Many commits in few git calls whatever their number (the incident check walks whole ranges, 01-engine §3.7): one
 * `cat-file --batch-check` of type and size, unpeeled, then `cat-file --batch` of the commits within
 * BOARD_COMMIT_OBJECT_MAX_BYTES, in chunks of at most BATCH_READ_MAX_BYTES by those sizes (one call for a realistic
 * range; a range of large commits takes one call per 32 MiB). Each commit is reduced to its shape record (shapeRecord)
 * as soon as it is parsed, so what the range keeps does not grow with the commits' messages (final review FA-3). An
 * oid naming another type (`not_commit`) or an oversized commit (`commit_too_large`) is never read. A missing oid is
 * not board content: it throws a plain Error.
 */
export async function readCommitsChecked(repo: GitRepo, oids: readonly Oid[]): Promise<CheckedCommit[]> {
  if (oids.length === 0) return [];
  const infos = await objectTypesAndSizes(repo, oids);
  const refused = infos.map((info, i): CheckedCommit['refused'] => {
    if (info === null) throw new Error(`readCommitsChecked: ${oids[i]!} is missing`);
    return info.type !== 'commit' ? 'not_commit' : info.size > BOARD_COMMIT_OBJECT_MAX_BYTES ? 'commit_too_large' : null;
  });
  // Chunks by cumulative size; every commit read is ≤ BOARD_COMMIT_OBJECT_MAX_BYTES < BATCH_READ_MAX_BYTES, so each
  // chunk holds at least one. A repeated oid is read once.
  const chunks: Array<{ oids: Oid[]; bytes: number }> = [];
  const queued = new Set<Oid>();
  oids.forEach((oid, i) => {
    if (refused[i] !== null || queued.has(oid)) return;
    queued.add(oid);
    const size = infos[i]!.size;
    const last = chunks[chunks.length - 1];
    if (last !== undefined && last.bytes + size <= BATCH_READ_MAX_BYTES) {
      last.oids.push(oid);
      last.bytes += size;
    } else {
      chunks.push({ oids: [oid], bytes: size });
    }
  });
  const read = new Map<Oid, CommitInfo>();
  for (const chunk of chunks) {
    const r = await repo.run(['cat-file', '--batch'], { stdin: Buffer.from(`${chunk.oids.join('\n')}\n`, 'utf8') });
    batchObjects(r.stdout, chunk.oids.length).forEach((o, k) => {
      const oid = chunk.oids[k]!;
      if (o === null || o.type !== 'commit' || o.body.length > BOARD_COMMIT_OBJECT_MAX_BYTES) {
        throw new Error(`readCommitsChecked: cat-file --batch disagrees with --batch-check on ${oid}`);
      }
      // Reduced before the next commit is parsed (final review FA-3): the range keeps a few hundred bytes per commit.
      read.set(oid, shapeRecord(parseCommitObject(oid, o.body.toString('utf8'))));
    });
  }
  return oids.map((oid, i): CheckedCommit => {
    const why = refused[i] ?? null;
    if (why !== null) return { commit: null, refused: why };
    const commit = read.get(oid);
    if (commit === undefined) throw new Error(`readCommitsChecked: ${oid} was not read`);
    return { commit, refused: null };
  });
}

/** A board commit as checkBoardCommits found it: refused is readBoardCommit's BoardMalformedReason, or null. */
export interface CheckedBoardCommit { commit: CommitInfo | null; refused: BoardMalformedReason | null; }

/**
 * readBoardCommit's refusals for many board commits, with no entry content read: three git calls when the commit
 * objects total at most 32 MiB (any realistic range), and one more `cat-file --batch` per further chunk of up to
 * 32 MiB (readCommitsChecked's chunks, BATCH_READ_MAX_BYTES; every closed chunk holds over 31 MiB). The checks:
 * readCommitsChecked (`not_commit`, `commit_too_large`), `no_parent`, then one `cat-file --batch-check` of the
 * root tree and the four board entries of every remaining tree (`ops_too_large`, `board_too_large`, `entry_missing`;
 * the same capViolation readBoardCommit and buildBoardCommit use), then readBoardCommit's held/ verdict (checkHeldTreeCap: the
 * held/ walk's three git calls per held/ tree it has not measured). A commit that passes reads in readBoardCommit without a
 * BoardMalformedError, so the incident check refuses exactly what the fold could not read. A missing oid throws a
 * plain Error.
 */
export async function checkBoardCommits(repo: GitRepo, oids: readonly Oid[]): Promise<CheckedBoardCommit[]> {
  const out: CheckedBoardCommit[] = (await readCommitsChecked(repo, oids)).map((c) => (
    c.commit === null ? { commit: null, refused: c.refused } : { commit: c.commit, refused: c.commit.parents.length === 0 ? 'no_parent' : null }
  ));
  const pending = out.filter((c): c is { commit: CommitInfo; refused: null } => c.commit !== null && c.refused === null);
  if (pending.length > 0) {
    const entries = await boardEntriesOf(repo, pending.map((c) => c.commit.tree));
    entries.forEach((e, k) => {
      const over = capViolation(e);
      if (over !== null) (pending[k] as CheckedBoardCommit).refused = over.reason;
    });
    // 02-protocol §3.1 held/ part and the held/ caps (final review F13 and round 2): refuse a held/ exactly as readBoardCommit
    // does, so the incident check refuses what the fold could not read. The walk's facts are cached per tree object
    // (checkHeldTreeCap), which a held/ carried by oid across the range hits (and so does the fold's read after it); every
    // commit whose held/ breaks a cap is refused board_too_large.
    for (let k = 0; k < pending.length; k++) {
      if (pending[k]!.refused !== null) continue;
      const held = entries[k]!.held;
      if (held === null) continue;
      try {
        await checkHeldTreeCap(repo, held.oid, oids[0]!.length / 2);
      } catch (e) {
        if (!(e instanceof BoardMalformedError && e.reason === 'board_too_large')) throw e;
        (pending[k] as CheckedBoardCommit).refused = 'board_too_large';
      }
    }
  }
  return out;
}

/** The skip subject and the skip-checks and Cowork-Proto trailers every live and board commit carries (values are the fold's business). */
function hasMarkers(c: CommitInfo): boolean {
  return c.subject.startsWith(SKIP_SUBJECT_PREFIX) && c.trailers.some((t) => t.key === SKIP_CHECKS) && c.trailers.some((t) => t.key === PROTO_KEY);
}

/**
 * Board shape (glossary §3, 02-protocol §3.1): the markers, and parents [expectedPrev, live code commit],
 * or the single parent [L0] when expectedPrev is null (B0). Structural only: a missing writer or another
 * proto value is not a shape violation. Whether the last parent is a valid live step is liveShape's.
 */
export function boardShapeOk(c: CommitInfo, expectedPrev: Oid | null): boolean {
  if (!hasMarkers(c)) return false;
  if (expectedPrev === null) return c.parents.length === 1;
  return c.parents.length === 2 && c.parents[0] === expectedPrev;
}

/**
 * The three live code commit shapes (01-engine §3.4) of c as the step after expectedPrev: genesis (no parents,
 * exactly one Cowork-Base naming a commit; expectedPrev null), ordinary ([expectedPrev], no Cowork-Base) and
 * base_move ([expectedPrev, X] with exactly one Cowork-Base: X); null otherwise — so a last parent that jumps
 * anywhere but a direct child of the previous live code commit has no shape. A board-only publish that
 * repeats the last parent (c == expectedPrev) is the caller's equal case, not a step.
 */
export function liveShape(c: CommitInfo, expectedPrev: Oid | null): LiveShape | null {
  if (!hasMarkers(c)) return null;
  const bases = c.trailers.filter((t) => t.key === BASE_KEY).map((t) => t.value);
  if (expectedPrev === null) return c.parents.length === 0 && bases.length === 1 && isOid(bases[0]) ? 'genesis' : null;
  if (c.parents[0] !== expectedPrev) return null;
  if (c.parents.length === 1) return bases.length === 0 ? 'ordinary' : null;
  if (c.parents.length === 2) return bases.length === 1 && bases[0] === c.parents[1] ? 'base_move' : null;
  return null;
}
