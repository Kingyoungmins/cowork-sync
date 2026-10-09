// Board and live code commits: trailers, the board tree, reading a board commit back and the commit shapes
// (glossary §3, §5; 02-protocol §3.1; PRO-01…PRO-03, PRO-07; 01-engine §3.4, ENG-12, ENG-20; SEC-03).
// The board tree is a metadata tree built with mktree from existing blobs and trees (ruling R-15).
// Author, committer (+0000) and the forced commit.gpgSign=false come from GitRepo.commitTree and the runner.
import { deflateSync, inflateSync } from 'node:zlib';
import { isOid, parseOid, type Oid } from '../git/oid.js';
import { parseCommitObject, type CommitInfo, type FileMode, type GitRepo, type MktreeEntry } from '../git/repo.js';
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

/**
 * Tree = the previous board tree with ops.jsonl replaced (+ checkpoint when given), protocol.json and held/
 * carried by oid (mktree, R-15); nothing else of the previous tree is carried (PRO-02). Parents
 * [prevBoard, liveCode], or [L0] for B0, which needs protocol and the height-0 checkpoint (PRO-07).
 * Every op must be the writer's own (peer, epoch) with a seq below the writer seq (PRO-09, PRO-16).
 * Never builds a commit readBoardCommit would refuse: ops.jsonl over its caps, ops.jsonl + protocol.json +
 * checkpoint/state.json or the carried held/ tree object over BOARD_TREE_MAX_BYTES, or a commit object over
 * BOARD_COMMIT_OBJECT_MAX_BYTES throws BoardCapError (the tree check runs before commit-tree).
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
  if (b.prevBoard === null) {
    if (b.protocol === null) throw new Error('buildBoardCommit: B0 needs protocol.json (PRO-07)');
    if (b.checkpoint === null) throw new Error('buildBoardCommit: B0 needs the height-0 checkpoint/state.json (PRO-07)');
    entries.push({ name: PROTOCOL_FILE, mode: '100644', type: 'blob', oid: await repo.hashBytes(serializeProtocol(b.protocol), true) });
    entries.push(await checkpointEntry(repo, b.checkpoint));
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
    const held = prev.get(HELD_DIR);
    if (held !== undefined && held.type === 'tree') entries.push(held);
  }
  const tree = await repo.mktree(entries);
  // The same rule readBoardCommit applies, on the same batch-check of the new tree (carried entries included): a size
  // over a cap is this build's (BoardCapError); a carried checkpoint/ without state.json is the previous board's.
  const over = capViolation(await boardEntries(repo, tree));
  if (over !== null && over.reason === 'entry_missing') throw new BoardMalformedError(over.reason, `buildBoardCommit: previous board ${b.prevBoard ?? '(none)'} carries ${over.detail}`);
  if (over !== null) throw new BoardCapError(`buildBoardCommit: the board tree would have ${over.detail}`);
  const parents = b.prevBoard === null ? [b.liveCode] : [b.prevBoard, b.liveCode];
  const commit = await repo.commitTree({ tree, parents, subject: BOARD_SUBJECT, trailers });
  // The header (identity, dates) is git's, so the object is measured once written; a refused commit stays unreferenced.
  const size = await objectSize(repo, commit);
  if (size > BOARD_COMMIT_OBJECT_MAX_BYTES) {
    throw new BoardCapError(`buildBoardCommit: the board commit object would be ${size} bytes > ${BOARD_COMMIT_OBJECT_MAX_BYTES}`);
  }
  return commit;
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

/** Names of the subtree entries of a raw tree object (`<mode> <name>\0<hash>` records). */
export function subtreeNames(raw: Buffer, hashBytes: number): string[] {
  const names: string[] = [];
  let pos = 0;
  while (pos < raw.length) {
    const sp = raw.indexOf(0x20, pos);
    const nul = sp < 0 ? -1 : raw.indexOf(0x00, sp + 1);
    if (nul < 0 || nul + 1 + hashBytes > raw.length) throw new Error('readBoardCommit: malformed tree object');
    if (raw.toString('latin1', pos, sp) === '40000') names.push(raw.toString('utf8', sp + 1, nul));
    pos = nul + 1 + hashBytes;
  }
  return names;
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
 * Reads what the fold needs from a board commit (02-protocol §3.3 inputs) in four git calls: one
 * `cat-file --batch-check='%(objecttype) %(objectsize)'` of the unpeeled oid, the commit (`cat-file commit`), one
 * `cat-file --batch-check` of ops.jsonl, protocol.json, checkpoint/state.json and held/, then one `cat-file --batch`
 * of the well-typed ones. Types and sizes are checked before any content is read.
 * Errors from the board's content are typed BoardMalformedError: an oid that names a tag, tree or blob, whatever
 * its size (`not_commit`; a tag is never peeled, so it cannot carry an over-cap commit past the size check), a
 * commit object over BOARD_COMMIT_OBJECT_MAX_BYTES (`commit_too_large`, never read), a commit without parents
 * (`no_parent`), a root tree object over BOARD_ROOT_TREE_MAX_BYTES, an ops.jsonl over 64 KiB (`ops_too_large`),
 * ops.jsonl + protocol.json + checkpoint/state.json or the held/ tree object over BOARD_TREE_MAX_BYTES
 * (`board_too_large`; the oversized object is never read), no checkpoint/state.json blob (`entry_missing`). A missing
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
 * the same capViolation readBoardCommit and buildBoardCommit use). A commit that passes reads in readBoardCommit without a
 * BoardMalformedError, so the incident check refuses exactly what the fold could not read. A missing oid throws a
 * plain Error.
 */
export async function checkBoardCommits(repo: GitRepo, oids: readonly Oid[]): Promise<CheckedBoardCommit[]> {
  const out: CheckedBoardCommit[] = (await readCommitsChecked(repo, oids)).map((c) => (
    c.commit === null ? { commit: null, refused: c.refused } : { commit: c.commit, refused: c.commit.parents.length === 0 ? 'no_parent' : null }
  ));
  const pending = out.filter((c): c is { commit: CommitInfo; refused: null } => c.commit !== null && c.refused === null);
  if (pending.length > 0) {
    (await boardEntriesOf(repo, pending.map((c) => c.commit.tree))).forEach((e, k) => {
      const over = capViolation(e);
      if (over !== null) (pending[k] as CheckedBoardCommit).refused = over.reason;
    });
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
