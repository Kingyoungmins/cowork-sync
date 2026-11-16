// The provenance journal prov/<enc(b)>.jsonl (05-holds §2 "provenance journal entry", HLD-25; 01-engine ENG-36, ENG-37;
// glossary §6; rulings R3-36, R3-59): one JSON line per live code commit that LA_C advances over on TIP's first-parent chain,
// {commit, writer, cs_ids, t_local_ms, paths: {p: {add, del}}}, where add/del are the SHA-1 hashes of the non-trivial
// stored-form rows the commit added to or removed from p (against its first parent). The revert detector (src/holds/revert.ts)
// reads it: a removed row another writer added, or a re-added row another writer removed, within 14 days of local append time.
//
// A rebuildable cache (glossary §6): load() checks the file against the state's LA_C — a journal whose newest entry is a
// first-parent ancestor of LA_C is advanced to it ('loaded'; a kill at apply.state or inside the append leaves it one commit
// behind, R3-59), anything else (missing, corrupt, off the chain, empty) is rebuilt over (rebuildFrom, LA_C] with t_local_ms =
// the rebuild time ('rebuilt'). The journal keeps its load point (the LA_C of the last load) and appends only commits after it;
// before load() advance() does nothing (R3-59: a joiner never turns the team's pre-join history into 14-day protection).
//
// Row changes are computed in-process (matchedRows over stored-form rows, endings ignored, stripEnding for hashing): no
// `git diff -U0` here (L-HOLD-STORES: only revertDetector and taintOnlyH1 call it). The tree diff of each commit is one
// `diff-tree -r` (src/holds takes no private copy of src/engine's treeDiff helpers). Bounded (Task 8 fix round 1, controller
// ruling): a binary path (a NUL in the first 8,000 bytes of either side), and a text path whose add + del hashes would exceed
// PROV_PATH_HASH_CAP, is recorded as a summary — one whole-blob hash (blobHash) per present side — which the revert detector
// compares whole (HLD-28 holds a binary path only as a whole-file PIN; an over-cap text path keeps its whole-file restore and
// deletion protection, not its rows). Entries older than 14 days of local append time are pruned at the next append (the file is
// then rewritten by temp file + rename, EPERM/EACCES/EBUSY retried 3 × 50 ms); a plain append is one Fs.appendFile. A failed
// advance marks the journal stale and the next advance reloads it (load over the file), so a failed span is journaled at the next
// LA_C move of the same run (Task 8 fix round 1, controller ruling). This module reads no claim state (HLD-06).
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { parseCsTrailers, parseWriter } from '../board/boardCommit.js';
import type { PeerId } from '../board/ids.js';
import { commonRowEnds, matchedRows } from '../data/linediff.js';
import { isBinaryBytes, rows, stripEnding } from '../data/rows.js';
import { isOid, parseOid, type Oid } from '../git/oid.js';
import type { GitRepo } from '../git/repo.js';
import { parseMessage } from '../git/trailers.js';
import type { Clock } from '../ports/clock.js';
import { KilledAt } from '../ports/crashpoint.js';
import { errnoCode, type Fs } from '../ports/fs.js';
import type { Log } from '../ports/log.js';

/** 14 days, local time of append (HLD-25). */
export const PROV_RETENTION_MS = 1_209_600_000;

/**
 * The most add + del row hashes one entry keeps for one path (≈ 176 KB of JSON); above it, and always for a binary path, the path's
 * change is the whole-blob summary (Task 8 fix round 1, controller ruling: no unbounded growth, a per-path cap with a summary entry).
 */
export const PROV_PATH_HASH_CAP = 4_096;

/** The whole-blob hash of a summary side: SHA-1 hex of the raw stored-form bytes (a multi-row blob never equals a row's lineHash). */
export function blobHash(bytes: Buffer): string {
  return createHash('sha1').update(bytes).digest('hex');
}

/** One rewrite of the whole file (temp + rename) is retried this often on a Windows reader without share-delete, as StatusWriter. */
const WRITE_RETRIES = 3;
const WRITE_RETRY_MS = 50;
const RETRYABLE: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY']);

export interface ProvEntry { commit: string; writer: string; cs_ids: string[]; t_local_ms: number; paths: Record<string, { add: string[]; del: string[] }>; }

/**
 * Commits one walk reads at most (rev-list --max-count): a rebuild keeps the newest of them, and an advance over a longer span
 * than this is treated as off the chain (rebuilt from the caller's bound). Retention bounds the span in practice.
 */
const CHAIN_MAX = 10_000;
/**
 * Rows of the changed middle of a blob pair (after the common leading and trailing rows) above which the row changes are the
 * multiset difference of the middles instead of Myers' (matchedRows): a whole-file rewrite of a large file costs O(n) then, not
 * O(n·d). The two agree except for a row that only moved inside the middle, which Myers counts as removed and added.
 */
const MYERS_MAX_MIDDLE_ROWS = 20_000;
const LF = 0x0a;
const BASE_KEY = 'Cowork-Base';
const WRITER_KEY = 'Cowork-Writer';
const HASH_RE = /^[0-9a-f]{40}$/;
const REGULAR: ReadonlySet<string> = new Set(['100644', '100755']);
const ZERO_OID = /^0+$/;

/** 05 §2 non-trivial line: stored form without EOL, non-empty after removing whitespace, not made only of Unicode P* / S* characters. */
export function isNonTrivial(line: Buffer): boolean {
  const s = line.toString('utf8').replace(/\s/gu, '');
  return s.length > 0 && !/^[\p{P}\p{S}]+$/u.test(s);
}

/** SHA-1 hex of the stored-form line without its EOL (one trailing LF or CR LF is dropped first, so a row may be passed whole). */
export function lineHash(line: Buffer): string {
  return createHash('sha1').update(stripEnding(line)).digest('hex');
}

/**
 * The rows of a blob that are not matched in the other (endings ignored): Myers on the changed middle, its multiset difference
 * beyond MYERS_MAX_MIDDLE_ROWS. Shared with the revert detector (src/holds/revert.ts: binary deltas and a RESOLVED_PUBLISH
 * record's own change), never copied.
 */
export function unmatchedRows(prev: Buffer, next: Buffer): { removed: Buffer[]; added: Buffer[] } {
  const ends = commonRowEnds(prev, next);
  const a = rows(prev.subarray(ends.aStart, ends.aEnd));
  const b = rows(next.subarray(ends.bStart, ends.bEnd));
  if (a.length + b.length <= MYERS_MAX_MIDDLE_ROWS) {
    const ma = new Set<number>();
    const mb = new Set<number>();
    for (const [i, j] of matchedRows(a, b)) {
      ma.add(i);
      mb.add(j);
    }
    return { removed: a.filter((_, i) => !ma.has(i)), added: b.filter((_, j) => !mb.has(j)) };
  }
  const key = (r: Buffer): string => stripEnding(r).toString('latin1');
  const left = new Map<string, number>();
  for (const r of a) left.set(key(r), (left.get(key(r)) ?? 0) + 1);
  const added: Buffer[] = [];
  for (const r of b) {
    const n = left.get(key(r)) ?? 0;
    if (n > 0) left.set(key(r), n - 1);
    else added.push(r);
  }
  const right = new Map<string, number>();
  for (const r of b) right.set(key(r), (right.get(key(r)) ?? 0) + 1);
  const removed: Buffer[] = [];
  for (const r of a) {
    const n = right.get(key(r)) ?? 0;
    if (n > 0) right.set(key(r), n - 1);
    else removed.push(r);
  }
  return { removed, added };
}

/**
 * The add/del hashes of the non-trivial rows a change prev → next (null = absent) added and removed; sorted, unique. A binary side,
 * or more than PROV_PATH_HASH_CAP hashes, gives the summary instead: add = [blobHash(next)], del = [blobHash(prev)] (present sides).
 */
function rowChanges(prev: Buffer | null, next: Buffer | null): { add: string[]; del: string[] } {
  const summary = { add: next === null ? [] : [blobHash(next)], del: prev === null ? [] : [blobHash(prev)] };
  if ((prev !== null && isBinaryBytes(prev)) || (next !== null && isBinaryBytes(next))) return summary;
  const u = prev === null ? { removed: [], added: next === null ? [] : rows(next) }
    : next === null ? { removed: rows(prev), added: [] } : unmatchedRows(prev, next);
  const hashes = (rs: readonly Buffer[]): string[] => {
    const out = new Set<string>();
    for (const r of rs) {
      const line = stripEnding(r);
      if (isNonTrivial(line)) out.add(lineHash(line));
    }
    return [...out].sort();
  };
  const add = hashes(u.added);
  const del = hashes(u.removed);
  return add.length + del.length > PROV_PATH_HASH_CAP ? summary : { add, del };
}

const byCodeUnit = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

/** One JSON line as written (the key order of glossary §6's entry, paths sorted). */
function entryLine(e: ProvEntry): string {
  const paths: Record<string, { add: string[]; del: string[] }> = {};
  for (const p of Object.keys(e.paths).sort(byCodeUnit)) {
    const c = e.paths[p]!;
    Object.defineProperty(paths, p, { value: { add: [...c.add], del: [...c.del] }, enumerable: true, writable: true, configurable: true });
  }
  return JSON.stringify({ commit: e.commit, writer: e.writer, cs_ids: e.cs_ids, t_local_ms: e.t_local_ms, paths });
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const hashList = (v: unknown): v is string[] => Array.isArray(v) && v.every((h) => typeof h === 'string' && HASH_RE.test(h));

/** One line as entryLine writes it; null for anything else (a corrupt journal is rebuilt). */
function parseEntry(line: string): ProvEntry | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObj(v) || Object.keys(v).sort().join(',') !== 'commit,cs_ids,paths,t_local_ms,writer') return null;
  const { commit, writer, cs_ids, t_local_ms, paths } = v;
  if (!isOid(commit) || typeof writer !== 'string' || !Array.isArray(cs_ids) || !cs_ids.every((c) => typeof c === 'string')) return null;
  if (typeof t_local_ms !== 'number' || !Number.isSafeInteger(t_local_ms) || t_local_ms < 0 || !isObj(paths)) return null;
  for (const c of Object.values(paths)) {
    if (!isObj(c) || Object.keys(c).sort().join(',') !== 'add,del' || !hashList(c['add']) || !hashList(c['del'])) return null;
  }
  return v as unknown as ProvEntry;
}

/** A live commit of a walk: its oid, its parents and its message. */
interface ChainCommit { oid: Oid; parents: Oid[]; message: string; }

type FileState = { kind: 'missing' } | { kind: 'corrupt' } | { kind: 'ok'; entries: ProvEntry[] };

export class ProvenanceJournal {
  private readonly d: { fs: Fs; file: string; repo: GitRepo; clock: Clock; peer: PeerId; log: Log };
  private entries: ProvEntry[] = [];
  private loaded = false;
  /**
   * An advance failed (a git or fs error): the file and the memory may lack its span, which a later advance's (old, next] never
   * walks again, so the next advance reloads instead (load(next, rebuildFrom()) over the file: advanced, or rebuilt). Task 8 fix
   * round 1, controller ruling.
   */
  private stale = false;
  /** The LA_C of the last load (R3-59): advance appends only commits after it. */
  private loadPoint: Oid | null = null;
  /** Per line hash: the writer and append time of every entry that added (adds) or removed (dels) it. */
  private adds = new Map<string, Array<{ writer: string; t: number }>>();
  private dels = new Map<string, Array<{ writer: string; t: number }>>();
  /** load and advance run one at a time. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(d: { fs: Fs; file: string; repo: GitRepo; clock: Clock; peer: PeerId; log: Log }) {
    this.d = d;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  /**
   * prov/<enc(b)>.jsonl at a start or restart: a journal whose newest entry is laC, or an older first-parent ancestor of it (advanced
   * to laC), is 'loaded'; a missing, corrupt or empty file, or one whose newest entry is off laC's chain, is rebuilt over
   * (rebuildFrom, laC] with t_local_ms = now ('rebuilt'; rebuildFrom null = from the live chain's root, exclusive). Genesis and join
   * call load(tip, tip): an empty journal. The load point becomes laC.
   */
  load(laC: Oid, rebuildFrom: Oid | null): Promise<'loaded' | 'rebuilt'> {
    return this.serial(async () => (await this.loadNow(laC, rebuildFrom)).result);
  }

  /** load()'s body (inside serial); also a stale journal's next advance. The entries appended (all of them for a rebuild). */
  private async loadNow(laC: Oid, rebuildFrom: Oid | null): Promise<{ result: 'loaded' | 'rebuilt'; appended: number }> {
    const file = await this.readFile();
    if (file.kind === 'ok' && file.entries.length > 0) {
      const newest = parseOid(file.entries[file.entries.length - 1]!.commit);
      const chain = newest === laC ? [] : await this.chainAfter(newest, laC);
      if (chain !== null) {
        this.setEntries(file.entries);
        const have = new Set(file.entries.map((e) => e.commit));
        const entries = await this.entriesFor(chain.filter((c) => !have.has(c.oid)));
        await this.append(entries);
        this.loaded = true;
        this.stale = false;
        this.loadPoint = laC;
        return { result: 'loaded', appended: entries.length };
      }
    }
    await this.rebuild(laC, rebuildFrom, file.kind === 'ok' ? (file.entries.length === 0 ? 'empty' : 'off_chain') : file.kind);
    return { result: 'rebuilt', appended: this.entries.length };
  }

  /**
   * One entry per live commit in (max(old, load point), next] on next's first-parent chain, oldest first (an entry the journal
   * holds already is not appended again); entries older than 14 days are pruned at this append. When old is not on next's
   * first-parent chain (a re-anchor) the journal is rebuilt over (rebuildFrom(), next] instead. After a failed advance (stale) it
   * reloads: load(next, rebuildFrom()) over the file, which fills the failed span. A no-op before load(). Returns the number of
   * entries appended (rebuilt). Called only through core.ts's advanceProvenance (R3-59). A failure marks the journal stale.
   */
  advance(old: Oid, next: Oid, rebuildFrom: () => Promise<Oid | null>): Promise<number> {
    return this.serial(async () => {
      if (!this.loaded || old === next) return 0;
      try {
        if (this.stale) return (await this.loadNow(next, await rebuildFrom())).appended;
        const chain = await this.chainAfter(old, next);
        if (chain === null) {
          await this.rebuild(next, await rebuildFrom(), 'off_chain');
          return this.entries.length;
        }
        let commits = chain;
        const at = this.loadPoint === null ? -1 : commits.findIndex((c) => c.oid === this.loadPoint);
        if (at >= 0) commits = commits.slice(at + 1);
        const have = new Set(this.entries.map((e) => e.commit));
        commits = commits.filter((c) => !have.has(c.oid));
        if (commits.length === 0) return 0;
        const entries = await this.entriesFor(commits);
        await this.append(entries);
        return entries.length;
      } catch (e) {
        this.stale = true;
        throw e;
      }
    });
  }

  /** The commit of the newest entry; null for an empty journal (lostStateRebuild's advance-or-load choice). */
  newest(): Oid | null {
    const e = this.entries[this.entries.length - 1];
    return e === undefined ? null : parseOid(e.commit);
  }

  /**
   * The journal's entries in append (first-parent) order, as loaded and appended — read-only; the caller filters the 14-day window.
   * Plan 3 Task 17 (Algorithm REV step 1's C(t), step 5's own add/del sets, the kept hunks' later writers): src/holds/revertCs.ts.
   */
  journalEntries(): readonly ProvEntry[] {
    return this.entries;
  }

  /** The writers whose entries within the retention window list `hash` as added. */
  addedBy(hash: string): readonly string[] {
    return this.writersOf(this.adds, hash);
  }

  /** The writers whose entries within the retention window list `hash` as removed. */
  deletedBy(hash: string): readonly string[] {
    return this.writersOf(this.dels, hash);
  }

  // ---- internals ----

  private writersOf(index: ReadonlyMap<string, ReadonlyArray<{ writer: string; t: number }>>, hash: string): string[] {
    const cutoff = Math.floor(this.d.clock.wallMs()) - PROV_RETENTION_MS;
    const out = new Set<string>();
    for (const x of index.get(hash) ?? []) if (x.t >= cutoff) out.add(x.writer);
    return [...out];
  }

  private setEntries(entries: ProvEntry[]): void {
    this.entries = entries;
    this.adds = new Map();
    this.dels = new Map();
    for (const e of entries) this.indexEntry(e);
  }

  private indexEntry(e: ProvEntry): void {
    for (const c of Object.values(e.paths)) {
      for (const [index, hashes] of [[this.adds, c.add], [this.dels, c.del]] as const) {
        for (const h of hashes) {
          let list = index.get(h);
          if (list === undefined) index.set(h, (list = []));
          list.push({ writer: e.writer, t: e.t_local_ms });
        }
      }
    }
  }

  private async readFile(): Promise<FileState> {
    let buf: Buffer;
    try {
      buf = await this.d.fs.readFile(this.d.file);
    } catch (e) {
      return errnoCode(e) === 'ENOENT' ? { kind: 'missing' } : { kind: 'corrupt' };
    }
    if (buf.length === 0) return { kind: 'ok', entries: [] };
    if (buf[buf.length - 1] !== LF) return { kind: 'corrupt' };   // a torn last line
    let lines: string[];
    try {
      lines = buf.toString('utf8').split('\n').slice(0, -1);   // a file beyond V8's string limit throws here: rebuilt
    } catch {
      return { kind: 'corrupt' };
    }
    const entries: ProvEntry[] = [];
    for (const line of lines) {
      const e = parseEntry(line);
      if (e === null) return { kind: 'corrupt' };
      entries.push(e);
    }
    return { kind: 'ok', entries };
  }

  /** The commits in (old, next] on next's first-parent chain, oldest first; null when old is not on that chain (or too far back). */
  private async chainAfter(old: Oid, next: Oid): Promise<ChainCommit[] | null> {
    if (old === next) return [];
    const newestFirst = await this.walk(next, old);
    const oldest = newestFirst[newestFirst.length - 1];
    if (oldest === undefined || oldest.parents[0] !== old) return null;
    return newestFirst.reverse();
  }

  /** rev-list --first-parent next [^stop] (at most CHAIN_MAX, newest first), with each commit's parents and message. */
  private async walk(next: Oid, stop: Oid | null): Promise<ChainCommit[]> {
    const args = ['rev-list', '--first-parent', '--no-commit-header', `--max-count=${CHAIN_MAX}`, '--format=%x00%H%n%P%n%B', next];
    if (stop !== null) args.push(`^${stop}`);
    const r = await this.d.repo.run(args);
    const out: ChainCommit[] = [];
    for (const record of r.stdout.toString('utf8').split('\0').slice(1)) {
      const nl1 = record.indexOf('\n');
      const nl2 = nl1 < 0 ? -1 : record.indexOf('\n', nl1 + 1);
      if (nl2 < 0) throw new Error(`provenance: unexpected rev-list record ${JSON.stringify(record.slice(0, 120))}`);
      const oid = parseOid(record.slice(0, nl1));
      const parents = record.slice(nl1 + 1, nl2).split(' ').filter((x) => x.length > 0).map((x) => parseOid(x));
      out.push({ oid, parents, message: record.slice(nl2 + 1) });
    }
    return out;
  }

  /** The entries of `commits` (oldest first) appended now; a root commit has no entry. */
  private async entriesFor(commits: readonly ChainCommit[]): Promise<ProvEntry[]> {
    const now = Math.floor(this.d.clock.wallMs());
    const out: ProvEntry[] = [];
    for (const c of commits) {
      const parent = c.parents[0];
      if (parent === undefined) continue;
      out.push({ commit: c.oid, ...writerOf(c.message), t_local_ms: now, paths: await this.pathChanges(parent, c.oid) });
    }
    return out;
  }

  /** The non-empty add/del row hashes of every regular path diff-tree lists between parent and commit (no renames). */
  private async pathChanges(parent: Oid, commit: Oid): Promise<Record<string, { add: string[]; del: string[] }>> {
    const r = await this.d.repo.run(['diff-tree', '-r', '-z', '--no-renames', '--no-commit-id', parent, commit]);
    const parts = r.stdout.toString('utf8').split('\0');
    const changes: Array<{ path: string; before: Oid | null; after: Oid | null }> = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const meta = parts[i]!;
      const path = parts[i + 1]!;
      const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) [A-Z]/.exec(meta);
      if (m === null) throw new Error(`provenance: unexpected diff-tree record ${JSON.stringify(meta.slice(0, 120))}`);
      const before = REGULAR.has(m[1]!) && !ZERO_OID.test(m[3]!) ? parseOid(m[3]!) : null;
      const after = REGULAR.has(m[2]!) && !ZERO_OID.test(m[4]!) ? parseOid(m[4]!) : null;
      if (before !== null || after !== null) changes.push({ path, before, after });
    }
    const oids = [...new Set(changes.flatMap((c) => [c.before, c.after]).filter((o): o is Oid => o !== null))];
    const bytes = new Map<string, Buffer>();
    const bufs = await this.d.repo.readBlobs(oids);
    oids.forEach((o, i) => bytes.set(o, bufs[i]!));
    const paths: Record<string, { add: string[]; del: string[] }> = {};
    for (const c of changes.sort((x, y) => byCodeUnit(x.path, y.path))) {
      const ch = rowChanges(c.before === null ? null : bytes.get(c.before)!, c.after === null ? null : bytes.get(c.after)!);
      if (ch.add.length > 0 || ch.del.length > 0) Object.defineProperty(paths, c.path, { value: ch, enumerable: true, writable: true, configurable: true });
    }
    return paths;
  }

  /** Appends entries (one appendFile), or rewrites the file without the entries older than 14 days when any is (prune at append). */
  private async append(entries: readonly ProvEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const cutoff = Math.floor(this.d.clock.wallMs()) - PROV_RETENTION_MS;
    const kept = this.entries.filter((e) => e.t_local_ms >= cutoff);
    await this.d.fs.mkdirp(dirname(this.d.file));
    if (kept.length !== this.entries.length) {
      await this.writeAll([...kept, ...entries]);
    } else {
      await this.d.fs.appendFile(this.d.file, Buffer.from(entries.map((e) => `${entryLine(e)}\n`).join(''), 'utf8'));
    }
    if (kept.length !== this.entries.length) this.setEntries([...kept, ...entries]);
    else {
      this.entries = [...this.entries, ...entries];
      for (const e of entries) this.indexEntry(e);
    }
  }

  /**
   * The whole file by temp file + rename; EPERM/EACCES/EBUSY (a reader without share-delete, an indexer or antivirus on Windows)
   * retried 3 × 50 ms on the Clock port like StatusWriter; on a final failure the temp file is removed and the error propagates.
   */
  private async writeAll(entries: readonly ProvEntry[]): Promise<void> {
    const { fs, file, clock } = this.d;
    await fs.mkdirp(dirname(file));
    const tmp = `${file}.tmp`;
    const bytes = Buffer.from(entries.map((e) => `${entryLine(e)}\n`).join(''), 'utf8');
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.writeFile(tmp, bytes);
        await fs.rename(tmp, file);
        return;
      } catch (e) {
        if (e instanceof KilledAt) throw e;   // a simulated kill leaves what a kill leaves
        if (!RETRYABLE.has(errnoCode(e) ?? '') || attempt >= WRITE_RETRIES) {
          await fs.unlink(tmp).catch(() => undefined);
          throw e;
        }
        await clock.sleep(WRITE_RETRY_MS);
      }
    }
  }

  /** HLD-25 rebuild: (rebuildFrom, laC] on laC's first-parent chain (the newest CHAIN_MAX), t_local_ms = now; the load point becomes laC. */
  private async rebuild(laC: Oid, rebuildFrom: Oid | null, why: string): Promise<void> {
    const commits = rebuildFrom === laC ? [] : (await this.walk(laC, rebuildFrom)).reverse();
    const entries = await this.entriesFor(commits);
    await this.writeAll(entries);
    this.setEntries(entries);
    this.loaded = true;
    this.stale = false;
    this.loadPoint = laC;
    this.d.log.write('info', 'PROV_REBUILT', { why, from: rebuildFrom, to: laC, entries: entries.length });
  }
}

/** The writer of a live commit: `branch:<X>` for a base-move commit (Cowork-Base: X), else the peer of its Cowork-Writer ('' when it has none). */
function writerOf(message: string): { writer: string; cs_ids: string[] } {
  const { trailers } = parseMessage(message);
  const cs_ids = parseCsTrailers(trailers).cs.map((c) => c.csId);
  const base = trailers.find((t) => t.key === BASE_KEY);
  if (base !== undefined) return { writer: `branch:${base.value}`, cs_ids };
  const w = trailers.find((t) => t.key === WRITER_KEY);
  const id = w === undefined ? null : parseWriter(w.value);
  return { writer: id?.peer ?? '', cs_ids };
}
