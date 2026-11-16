// src/claude/daemon/hookRead.ts — hook reads and disk snapshots (CCI-55, glossary §26.1 W1–W3, W6, 01 §3.8 "Hook
// requests", REG-35, R5-26). Task 8: the real bodies. The mutant sites are M40 (settle hashes the working file in
// place: the argv names it) and M41 (settle passes -w and writes an object on a hook read) — test builds only (R-29).
// No path here ever writes an object for an edit-checkpoint candidate (SE5-03's rewrite of CCI-56) and no git
// process ever opens the user's working file: bytes are read by one short read on the Fs port and hashed from
// bytes in hand by route (b) without -w (hashRouteBStdin, A8-7).
import { createHash } from 'node:crypto';
import { C } from '../wire/constants.js';
import { hashRouteB, hashRouteBStdin, isFilterFailure } from '../../data/blobRoutes.js';
import { stageable } from '../../engine/stagedRead.js';
import { sameStat } from '../../ports/fs.js';
import type { Fs, FsLstat } from '../../ports/fs.js';
import type { OidOrAbsent } from '../../git/oid.js';
import { ABSENT } from '../../git/oid.js';
import type { GitRepo } from '../../git/repo.js';
import type { StageDir } from '../../engine/stagedRead.js';
import type { MutantId } from '../../engine/deps.js';

export type ShortRead =
  | { kind: 'ok'; bytes: Buffer; stat: FsLstat }
  | { kind: 'unstable'; bytes: Buffer; stat: FsLstat }   // the second read's bytes; the window is approximate
  | { kind: 'missing' } | { kind: 'unreadable' };

declare const __COWORK_TEST_BUILD__: boolean | undefined;
function mutantActive(m: MutantId): boolean {
  return (typeof __COWORK_TEST_BUILD__ === 'undefined' || __COWORK_TEST_BUILD__) && process.env['COWORK_TEST_MUTANT'] === m;
}

function codeOf(e: unknown): string | undefined {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : undefined;
}
/** A vanished file (or a rename raced mid-read): missing, not a failure. */
function isGone(code: string | undefined): boolean {
  return code === 'ENOENT' || code === 'ENOTDIR';
}
/** EACCES/EBUSY on the read itself: the file is there but the daemon may not take it (06 §3.7.6). EISDIR/ELOOP: the
 *  entry became a directory or a link between the lstat and the read (stagedRead's rule, R5-26) (F2 #74). */
function isUnreadable(code: string | undefined): boolean {
  return code === 'EACCES' || code === 'EBUSY' || code === 'EISDIR' || code === 'ELOOP';
}

type NoBytes = { kind: 'missing' } | { kind: 'unreadable' };

/** An fs error as a ShortRead outcome (gone → missing, not takeable → unreadable); anything else is rethrown. */
function noBytesOf(e: unknown): NoBytes {
  if (isGone(codeOf(e))) return { kind: 'missing' };
  if (isUnreadable(codeOf(e))) return { kind: 'unreadable' };
  throw e;
}

/** One lstat: null → missing; not a regular file (a directory, a symlink, a junction) → unreadable, never opened — a
 *  read would follow the link (stagedRead's rule, R5-26) (F2 #74, #111). */
async function fileStat(fs: Fs, abs: string): Promise<FsLstat | NoBytes> {
  let s: FsLstat | null;
  try {
    s = await fs.lstat(abs);
  } catch (e) {
    return noBytesOf(e);
  }
  if (s === null) return { kind: 'missing' };
  if (!s.isFile) return { kind: 'unreadable' };
  return s;
}

async function readOnce(fs: Fs, abs: string): Promise<Buffer | NoBytes> {
  try {
    return await fs.readFile(abs);
  } catch (e) {
    return noBytesOf(e);
  }
}

const isNoBytes = (x: FsLstat | Buffer | NoBytes): x is NoBytes => !Buffer.isBuffer(x) && 'kind' in x;

/** A read is stable when the lstat around it did not move and the bytes are exactly that stat's size (stagedRead's rule). */
const stableRead = (before: FsLstat, after: FsLstat, bytes: Buffer): boolean => sameStat(before, after) && bytes.length === after.size;

/** Open with full sharing, read the whole file in one call, close; lstat before and after; differ (or a byte length that
 *  is not the after-stat's size) → re-read once; still differ → unstable. A directory, a symlink or a junction is never
 *  read: unreadable (stagedRead's rule; the parent components are the callers' scope check). No handle kept, no git
 *  process on the file. At most two readFile calls (CCI-55, INV-CCI-SHORTREAD, R1-507, R5-26): the pre→post lstat
 *  comparison misses a same-size same-mtime mid-read change by construction (the pre→post window is the read window);
 *  an unstable result carries the second read's bytes (06 §3.7.6). */
export async function shortRead(fs: Fs, abs: string): Promise<ShortRead> {
  const before = await fileStat(fs, abs);
  if (isNoBytes(before)) return before;
  const bytes = await readOnce(fs, abs);
  if (isNoBytes(bytes)) return bytes;
  const after = await fileStat(fs, abs);
  if (isNoBytes(after)) return after;
  if (stableRead(before, after, bytes)) return { kind: 'ok', bytes, stat: after };
  // The file moved under the read (or the read came back short): exactly one re-read; the second lstat's pre→post and
  // the byte length decide stability.
  const second = await readOnce(fs, abs);
  if (isNoBytes(second)) return second;
  let after2: FsLstat | null;
  try {
    after2 = await fs.lstat(abs);
  } catch (e) {
    return noBytesOf(e);
  }
  if (after2 !== null && !after2.isFile) return { kind: 'unreadable' };
  if (after2 === null || !stableRead(after, after2, second)) return { kind: 'unstable', bytes: second, stat: after };
  return { kind: 'ok', bytes: second, stat: after2 };
}

/** 04 §2 diskSnapshotId. */
export interface DiskSnapshot { readonly path: string; readonly oid: OidOrAbsent; readonly bytes: Buffer | null; readonly spill: string | null; readonly size: number; }

/** A8-1: bytes in hand before any hash — what the gate holds so no git process runs on its reply path (CCI-12). */
export interface HeldRead { readonly path: string; readonly bytes: Buffer; readonly stat: FsLstat; readonly unstable: boolean; readonly size: number; }

/** The internal cache entry: the DiskSnapshot fields plus the content hash the (path, SHA-256) cache is keyed by. */
interface Entry extends DiskSnapshot { readonly hash: string; }

/** One live cache entry and its references (one per settle/take/retain not yet released). */
interface Slot { readonly entry: Entry; refs: number; }
/** A hold's token: the (path, SHA-256) key its bytes are accounted under; live until its settle or unhold. */
interface HoldToken { readonly key: string; readonly hash: string; live: boolean; }
/** A settle in flight for one key: every concurrent settle of the key joins it (one git call, the bytes counted once). */
interface Pending { promise: Promise<Entry>; waiters: number; }

/** SHA-256 hex: of a hold's bytes (once per hold, F2 #64), or of a short entry key (a spill file's name). */
const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const entryKey = (path: string, hash: string): string => `${path}\u0000${hash}`;
const oidKey = (path: string, oid: OidOrAbsent): string => `${path}\u0000${oid}`;
/** The `hash` of a missing read's absence entry (never a SHA-256 hex, so it never meets a content key). */
const ABSENT_HASH = 'absent';
const EMPTY = Buffer.alloc(0);

/** The spill directory under the engine's stage root (06 §2: "beyond it spilled under tmp/stage/, deleted at
 *  release"). The one top-level name is outside every repo path namespace Plan 2 stages (a stage copy of a repo
 *  path is exactly that path; a repo tracking a top-level `.cowork-snap-spill` would collide — no real repo does).
 *  Exported: a reseed's StageDir.clear keeps this subdirectory (Ruling R-F2-16, the t8b group) (F2 #105). */
export const SPILL_DIR = '.cowork-snap-spill';

/**
 * 04 §2's diskSnapshotId table (R5-26, 06 §3.7.1): bytes in memory up to the cap (64 MB in production), beyond it
 * spilled to a file under `<stage>/.cowork-snap-spill/` (dir 0700, file 0600) that is deleted at release; never
 * serialized. The ownership contract (Ruling t8a-3, F2 #47, #105, #75, #64):
 *
 * 1. Every snapshot returned by settle, take or retain carries one reference owned by the caller; release(s) returns one.
 *    At zero the entry is evicted: it leaves the (path, SHA-256) table and the (path, oid) index (the index only while
 *    it still points at this entry), its bytes leave the memory count if they were in memory, and its spill file is
 *    unlinked if it spilled. get() borrows (no reference). release of an object that is no longer the live entry of
 *    its key (already evicted, or never this table's) is a no-op. The synchronous part (tables, memory count) is done
 *    before release returns its promise; only the unlink is awaited, and drain() awaits every unlink started so far.
 * 2. hold() returns a new HeldRead per call with a token; held bytes are accounted per (path, SHA-256) with refs, so
 *    identical bytes count once in bytesHeld(). The SHA-256 of the bytes is computed once, by hold() (a HeldRead not
 *    made by hold() — a literal — is hashed once by settle). A settle, or unhold(), ends the token (idempotent).
 * 3. Concurrent settles of one key share one git call and count the bytes once; each gets its own reference.
 * 4. Memory vs spill is `memBytes + size <= cap` for every path: a non-stageable path's bytes count against the cap and
 *    spill beyond it too (its oid is ABSENT with no git process, W6; Ruling t8a-4).
 * 5. A spill file belongs to one entry: `<sha256 of the entry key>-<seq>` with a per-instance sequence, so two entries
 *    with identical bytes never share a file and a name is never reused while an older unlink is pending.
 */
export class DiskSnapshots {
  private readonly entries = new Map<string, Slot>();        // (path, SHA-256 of the bytes) → the live entry and its refs
  private readonly byOid = new Map<string, Entry>();         // (path, oid) → a live entry (get's index)
  private readonly pending = new Map<string, Pending>();     // (path, SHA-256) → the settle in flight
  private readonly tokens = new WeakMap<HeldRead, HoldToken>();
  private readonly held = new Map<string, { size: number; refs: number }>();   // A8-1: (path, SHA-256) of the live holds
  private readonly unlinks = new Set<Promise<void>>();       // spill unlinks not settled yet (drain)
  private heldBytes = 0;                                     // Σ held bytes, identical (path, bytes) once (bytesHeld)
  private memBytes = 0;                                      // Σ live entries' bytes kept in memory (the cap's steady state)
  private spillSeq = 0;

  /** Phase 3a-1: the composition passes the repo identity and the 64 MB cap (PREIMAGE_CAP_BYTES). */
  constructor(private readonly repo: GitRepo, private readonly fs: Fs, private readonly stageDir: StageDir, private readonly capBytes: number) { }

  /** A8-1: synchronous, memory only, counted in bytesHeld(); spawns no git process. A new HeldRead per call (its token
   *  carries the one SHA-256 of the bytes); holding the same (path, bytes) again counts its bytes once. */
  hold(path: string, read: Extract<ShortRead, { kind: 'ok' | 'unstable' }>): HeldRead {
    const hash = sha256(read.bytes);
    const key = entryKey(path, hash);
    const h: HeldRead = { path, bytes: read.bytes, stat: read.stat, unstable: read.kind === 'unstable', size: read.bytes.length };
    this.tokens.set(h, { key, hash, live: true });
    const acc = this.held.get(key);
    if (acc !== undefined) {
      acc.refs += 1;
    } else {
      this.held.set(key, { size: h.size, refs: 1 });
      this.heldBytes += h.size;
    }
    return h;
  }

  /** Additive (F2 #47): ends a hold that will not be settled (a lease released before the gate's settle); its bytes
   *  leave bytesHeld() with the last hold of the same (path, bytes). Idempotent; a no-op on a settled hold. */
  unhold(h: HeldRead): void {
    const tok = this.tokens.get(h);
    if (tok === undefined || !tok.live) return;
    tok.live = false;
    const acc = this.held.get(tok.key);
    if (acc === undefined) return;
    acc.refs -= 1;
    if (acc.refs <= 0) {
      this.held.delete(tok.key);
      this.heldBytes -= acc.size;
    }
  }

  /** A8-1: the oid by route (b) `hash-object --stdin --path=<p>` (hashRouteBStdin, write false) without -w (M41: never
   *  an object); cached by (path, SHA-256 of the bytes); bytes in memory up to the cap in total, beyond it spilled under
   *  tmp/stage/ (0600, deleted at release); never serialized. A non-stageable path is carried through: no git
   *  process, no object, oid ABSENT (glossary §26.1 W6). The result carries one reference (release returns it); the
   *  hold ends either way. */
  async settle(h: HeldRead): Promise<DiskSnapshot> {
    try {
      const hash = this.tokens.get(h)?.hash ?? sha256(h.bytes);
      const key = entryKey(h.path, hash);
      const slot = this.entries.get(key);
      if (slot !== undefined) {
        slot.refs += 1;
        return slot.entry;
      }
      const joined = this.pending.get(key);
      if (joined !== undefined) {
        joined.waiters += 1;
        return await joined.promise;
      }
      const rec: Pending = { promise: Promise.resolve(null as unknown as Entry), waiters: 1 };
      rec.promise = this.mint(h, hash, key, rec);
      this.pending.set(key, rec);
      return await rec.promise;
    } finally {
      this.unhold(h);
    }
  }

  /** One settle's miss: hash, place in memory or spill, publish the entry with one reference per joined settle. */
  private async mint(h: HeldRead, hash: string, key: string, rec: Pending): Promise<Entry> {
    try {
      const oid = await this.oidOf(h);
      let entry: Entry;
      if (this.memBytes + h.size <= this.capBytes) {
        entry = { path: h.path, oid, bytes: h.bytes, spill: null, size: h.size, hash };
        this.memBytes += h.size;
      } else {
        entry = { path: h.path, oid, bytes: null, spill: await this.spillFile(key, h.bytes), size: h.size, hash };
      }
      this.entries.set(key, { entry, refs: rec.waiters });
      if (oid !== ABSENT) this.byOid.set(oidKey(h.path, oid), entry);
      return entry;
    } finally {
      this.pending.delete(key);
    }
  }

  /** The oid of a held read. M40 hashes the working file in place (the argv names it); M41 passes -w and writes an
   *  object on a hook read. Both are test builds only (R-29). */
  private async oidOf(h: HeldRead): Promise<OidOrAbsent> {
    const m40 = mutantActive('M40');
    const m41 = mutantActive('M41');
    if (m40) {
      const r = await hashRouteB(this.repo, h.path, h.path, m41);
      return isFilterFailure(r) ? ABSENT : r;
    }
    if (!stageable(h.path)) return ABSENT;
    const r = await hashRouteBStdin(this.repo, h.bytes, h.path, m41);
    return isFilterFailure(r) ? ABSENT : r;
  }

  /** Writes a new spill file `<stageDir>/.cowork-snap-spill/<sha256(entry key)>-<seq>` (0600) and returns its absolute
   *  path: one file per entry, never shared (F2 #105); an existing name (another instance's file) takes the next seq. */
  private async spillFile(key: string, bytes: Buffer): Promise<string> {
    const dir = `${this.stageDir.root}/${SPILL_DIR}`;
    await this.fs.mkdirp(dir, 0o700);
    const base = sha256(key);
    for (let tries = 0; tries < 3; tries++) {
      const file = `${dir}/${base}-${this.spillSeq++}`;
      try {
        await this.fs.writeFileExclusive(file, bytes, 0o600);
        return file;
      } catch (e) {
        if (codeOf(e) !== 'EEXIST') throw e;
      }
    }
    throw new Error(`hookRead: no free spill file name under ${dir} after 3 tries`);
  }

  /** = settle(hold(path, read)); used by every hook path that may hash before its reply (PostToolUse post-images, TXN-close
   *  reads, deny bases), never by the gate. A missing read mints (and caches) the path's absence snapshot; an unreadable
   *  read is no snapshot at all. Every result carries one reference (release returns it). */
  async take(path: string, read: ShortRead): Promise<DiskSnapshot> {
    if (read.kind === 'ok' || read.kind === 'unstable') return this.settle(this.hold(path, read));
    if (read.kind === 'missing') {
      const key = entryKey(path, ABSENT_HASH);
      const slot = this.entries.get(key);
      if (slot !== undefined) {
        slot.refs += 1;
        return slot.entry;
      }
      const entry: Entry = { path, oid: ABSENT, bytes: null, spill: null, size: 0, hash: ABSENT_HASH };
      this.entries.set(key, { entry, refs: 1 });
      this.byOid.set(oidKey(path, ABSENT), entry);
      return entry;
    }
    throw new Error(`hookRead: cannot snapshot an unreadable read of ${JSON.stringify(path)}`);
  }

  /** Additive (F2 #47): one more reference on a live snapshot, for a consumer that keeps it past its first holder (Task
   *  12's ViewBlobs, ApplyJournal, deny bases); throws on a released one. */
  retain(s: DiskSnapshot): DiskSnapshot {
    const live = this.liveSlot(s);
    if (live === null) throw new Error(`hookRead: cannot retain a released snapshot of ${JSON.stringify(s.path)}`);
    live.slot.refs += 1;
    return s;
  }

  /** Borrows (no reference): the live snapshot of (path, oid), or null. */
  get(path: string, oid: OidOrAbsent): DiskSnapshot | null {
    return this.byOid.get(oidKey(path, oid)) ?? null;
  }

  /** The snapshot's bytes; a released spilled snapshot's file is gone (ENOENT). */
  async bytesOf(s: DiskSnapshot): Promise<Buffer> {
    if (s.bytes !== null) return s.bytes;
    if (s.spill !== null) return this.fs.readFile(s.spill);
    return EMPTY;
  }

  /** Returns one reference; the last one evicts the entry (memory freed, spill file unlinked — absent is fine). A stale
   *  object is a no-op. The tables are updated before the promise is returned; it settles with the unlink. */
  release(s: DiskSnapshot): Promise<void> {
    const live = this.liveSlot(s);
    if (live === null) return Promise.resolve();
    live.slot.refs -= 1;
    if (live.slot.refs > 0) return Promise.resolve();
    return this.evict(live.key, live.slot.entry);
  }

  /** The live slot of a snapshot this table returned, or null (evicted, or not one of this table's objects). */
  private liveSlot(s: DiskSnapshot): { key: string; slot: Slot } | null {
    const hash = (s as Partial<Entry>).hash;
    if (typeof hash !== 'string') return null;
    const key = entryKey(s.path, hash);
    const slot = this.entries.get(key);
    return slot !== undefined && slot.entry === s ? { key, slot } : null;
  }

  private evict(key: string, e: Entry): Promise<void> {
    this.entries.delete(key);
    const ok = oidKey(e.path, e.oid);
    if (this.byOid.get(ok) === e) {
      this.byOid.delete(ok);
      // Two byte strings can hash to one oid through the path's filters (CRLF vs LF): the index keeps a live one.
      if (e.oid !== ABSENT) {
        for (const other of this.entries.values()) {
          if (other.entry.path === e.path && other.entry.oid === e.oid) {
            this.byOid.set(ok, other.entry);
            break;
          }
        }
      }
    }
    if (e.bytes !== null) this.memBytes -= e.size;
    if (e.spill === null) return Promise.resolve();
    const u = this.unlinkSpill(e.spill);
    this.unlinks.add(u);
    const done = (): void => { this.unlinks.delete(u); };
    u.then(done, done);
    return u;
  }

  private async unlinkSpill(file: string): Promise<void> {
    try {
      await this.fs.unlink(file);
    } catch (e) {
      if (!isGone(codeOf(e))) throw e;
    }
  }

  /** A8-1: the bytes currently held (settle and unhold end a hold). */
  bytesHeld(): number {
    return this.heldBytes;
  }

  /** Additive diagnostics (F2 #47): held bytes, in-memory bytes, live entries, spilled live entries, settles in flight. */
  stats(): { heldBytes: number; memBytes: number; entries: number; spilled: number; pending: number } {
    let spilled = 0;
    for (const s of this.entries.values()) if (s.entry.spill !== null) spilled += 1;
    return { heldBytes: this.heldBytes, memBytes: this.memBytes, entries: this.entries.size, spilled, pending: this.pending.size };
  }

  /** Additive (F2 #47): resolves when every spill unlink started so far has settled. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.unlinks]);
  }
}

/** W2: a 0-byte or > 50 % shrunk post-image relative to its pre-image is used only after a second stable read ≥ 300 ms
 *  later (the caller enforces the second read; this flag only names the danger, SHRINK_SECOND_READ_MS). */
export function emptyOrShrunk(pre: DiskSnapshot | null, post: DiskSnapshot): boolean {
  if (post.size === 0) return true;
  if (pre === null) return false;
  return 2 * post.size < pre.size;
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** A8-10 (06 §3.8.1 EOL-only/BOM-only hunks, §3.8.4 trigger (a)): equal after stripping a leading UTF-8 BOM and mapping
 *  CRLF and lone CR to LF on both sides; pure, no git; used by Task 12's post.edit before confirm. */
export function normalizedEqual(a: Buffer, b: Buffer): boolean {
  return normalizeForm(a).equals(normalizeForm(b));
}

function normalizeForm(x: Buffer): Buffer {
  const s = x.length >= 3 && x[0] === UTF8_BOM[0] && x[1] === UTF8_BOM[1] && x[2] === UTF8_BOM[2] ? x.subarray(3) : x;
  const out = Buffer.allocUnsafe(s.length);
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === 0x0d) {
      if (i + 1 < s.length && s[i + 1] === 0x0a) continue;   // CRLF: the LF is copied by its own iteration
      out[n++] = 0x0a;                                        // a lone CR becomes LF
    } else {
      out[n++] = c;
    }
  }
  return out.subarray(0, n);
}
