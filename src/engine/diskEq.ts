// DISK_EQ(p, X) and its many-candidates form (01-engine §3.3 "DISK_EQ(p, X) mechanics"; ENG-11; glossary §3,
// §26.1 W1, §26.2 item 3). Every disk read is a staged read into tmp/stage/<p>; git only ever reads that copy.
// Unfiltered paths are compared with git's check-in path and index context (a scratch index holding only X, a
// stage-tree `update-index --refresh`, then `diff-files -z` decides; the refresh's rc and text never do), because
// a bare `hash-object --path` misreports i/crlf files (VERIFIED a40da32 vs 32315a1). Filtered paths compare a route
// (b) id with X, which for a filtered path is itself a route (b) id. Only the many-candidates form writes an object.
import { join } from 'node:path';
import { canon } from '../data/canon.js';
import { hashRouteB, isFilterFailure } from '../data/blobRoutes.js';
import type { FilterSet } from '../data/filters.js';
import { ABSENT, type Absent, type Oid } from '../git/oid.js';
import { GitCommandError, type GitRepo, type TreeEntry } from '../git/repo.js';
import { resetScratchIndex, ScratchResetError } from '../git/scratchIndex.js';
import { sameStat, type Fs } from '../ports/fs.js';
import type { MutantId } from './deps.js';
import { stageable, stagedRead, type ReadOutcome, type StageDir } from './stagedRead.js';
import type { StatCache } from './statCache.js';

/**
 * 'carried' (P2-CARRY / P2-DOTGIT) and 'filter_failure' (P2-SNAPFILTERS) are refusals at the entry point: nothing was
 * looked at, read or hashed. The writer defers such a path.
 */
export type DiskEqResult = { equal: true } | { equal: false; reason: 'differs' | 'unstable' | 'unreadable' | 'error' | 'carried' | 'filter_failure' };
export interface DiskEqDeps {
  repo: GitRepo; fs: Fs; stage: StageDir; statCache: StatCache; cmpIndex: string; addIndex: string; isFiltered: (p: string) => boolean; isText: (p: string) => boolean; mutants: ReadonlySet<MutantId>;
  /** Ruling P2-SNAPFILTERS: a filtered path whose driver is over the cap or outside `drivers` is refused (filter_failure). */
  filters: FilterSet;
  /** P2-CARRY: the snapshot's current carry set (Snapshotter.isCarried); such a path is refused (carried). */
  isCarried: (p: string) => boolean;
}
/** manyCandidates' `read`: the staged read's outcome, or the entry point's refusal. */
export type ManyRead = ReadOutcome['kind'] | 'carried' | 'filter_failure';

/**
 * Commands that read the stage tree run with core.fileMode=false: stage copies are created 0644, so a 100755 entry
 * would otherwise always read as a mode change on a POSIX peer (the entry's mode decides, as on Windows).
 */
export const STAGE_TREE_CONFIG: Readonly<Record<string, string>> = Object.freeze({ 'core.fileMode': 'false' });

export type Refusal = 'carried' | 'filter_failure';
const EQUAL: DiskEqResult = Object.freeze({ equal: true });
const notEqual = (reason: 'differs' | 'unstable' | 'unreadable' | 'error' | Refusal): DiskEqResult => ({ equal: false, reason });
/** check-attr values that name no driver (attrs.ts stringValue). */
const NO_DRIVER: ReadonlySet<string> = new Set(['set', 'unset', 'unspecified']);

function sameEntry(a: TreeEntry, b: TreeEntry): boolean {
  return a.oid === b.oid && a.mode === b.mode;
}

function isGoneError(e: unknown): boolean {
  const code = typeof e === 'object' && e !== null ? (e as NodeJS.ErrnoException).code : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

// resetScratchIndex and ScratchResetError live in src/git/scratchIndex.ts (Task 15 ruling: shared with src/holds);
// re-exported here so existing imports keep working.
export { resetScratchIndex, ScratchResetError };

export class DiskEq {
  private readonly d: DiskEqDeps;

  constructor(d: DiskEqDeps) {
    this.d = d;
  }

  private workFile(path: string): string {
    return join(this.d.repo.paths.workTree, ...path.split('/'));
  }

  /**
   * Every entry point refuses first, before any look at the disk: a carried path (P2-CARRY: not stageable, a dotgit
   * alias on every platform, or in the snapshot's carry set) is 'carried'; a filtered path whose driver is over the
   * cap or outside the discovered set (P2-SNAPFILTERS: git would run it without filter.<d>.required=true, and a
   * failing clean filter would let route (b) -w store the raw bytes) is 'filter_failure'. The driver is read with one
   * `check-attr` under the context's attr.tree, only for a path isFiltered names; never cached (a personal attributes
   * file can change it). Public for the writer's creation check (final review minor: a create is refused like a modify).
   */
  async refusal(path: string): Promise<Refusal | null> {
    if (!stageable(path) || this.d.isCarried(path)) return 'carried';
    if (!this.d.isFiltered(path)) return null;
    const f = this.d.filters;
    if (f.overCap !== null) return 'filter_failure';
    let driver: string | null;
    try {
      const r = await this.d.repo.run(['check-attr', '-z', '--stdin', 'filter'], { class: 'attr', stdin: Buffer.concat([Buffer.from(path, 'utf8'), Buffer.from([0])]) });
      const v = r.stdout.toString('utf8').split(String.fromCharCode(0))[2] ?? 'unspecified';
      driver = NO_DRIVER.has(v) ? null : v;
    } catch (e) {
      if (e instanceof GitCommandError) return 'filter_failure'; // fail closed
      throw e;
    }
    return driver === null || f.drivers.includes(driver) ? null : 'filter_failure';
  }

  /**
   * ABSENT ⇔ ENOENT; clean stat-cache fast path when x equals sRaw; else one staged read + cmp.index cacheinfo, --work-tree=<tmp/stage> update-index --refresh, diff-files -z (unfiltered) or a route (b) id (filtered). No object. Mutant M18: hash-object --path of the copy compared with x for every path.
   * Refusals first (see refusal): 'carried' or 'filter_failure', without a look at the disk.
   */
  async eq(path: string, x: TreeEntry | Absent, sRaw: TreeEntry | null): Promise<DiskEqResult> {
    const refused = await this.refusal(path);
    if (refused !== null) return notEqual(refused);
    if (await this.beneathLink(path)) return notEqual('unreadable');
    const file = this.workFile(path);
    if (x === ABSENT) return this.absentEq(file);
    const ce = this.d.statCache.get(path);
    if (sRaw !== null && sameEntry(x, sRaw) && ce !== undefined && ce.state === 'clean' && ce.stat !== null
      && ce.missingSinceMono === undefined && ce.shrink === undefined) {
      let st;
      try {
        st = await this.d.fs.lstat(file);
      } catch {
        return notEqual('unreadable');
      }
      if (st !== null && sameStat(st, ce.stat)) return EQUAL;
    }
    return this.compareRead(path, file, x);
  }

  /** Variant (3): the bytes of `file` (a ring .old) compared as if they were at p (p's attributes and index context). */
  async eqFile(path: string, file: string, x: TreeEntry | Absent): Promise<DiskEqResult> {
    const refused = await this.refusal(path);
    if (refused !== null) return notEqual(refused);
    if (x === ABSENT) return this.absentEq(file);
    return this.compareRead(path, file, x);
  }

  /** MANY CANDIDATES: one staged read, raw blob r written (route (a) into addIndex, or route (b) -w); first c with canon(r, c) == c (unfiltered) or r == c (filtered); ABSENT matches ENOENT. A refusal (see refusal) reads and writes nothing. */
  async manyCandidates(path: string, candidates: readonly (TreeEntry | Absent)[], file?: string): Promise<{ match: TreeEntry | Absent | null; raw: Oid | null; read: ManyRead }> {
    const refused = await this.refusal(path);
    if (refused !== null) return { match: null, raw: null, read: refused };
    if (file === undefined && (await this.beneathLink(path))) return { match: null, raw: null, read: 'unreadable' };
    const src = file ?? this.workFile(path);
    const r = await stagedRead(this.d.fs, src);
    if (r.kind === 'missing') return { match: candidates.includes(ABSENT) ? ABSENT : null, raw: null, read: 'missing' };
    if (r.kind !== 'ok') return { match: null, raw: null, read: r.kind };
    return this.withCopy(path, r.bytes, async (copy) => {
      const filtered = this.d.isFiltered(path);
      let raw: Oid | null;
      if (filtered) {
        const h = await hashRouteB(this.d.repo, path, copy, true);
        raw = isFilterFailure(h) ? null : h;
      } else {
        raw = await this.addRaw(path);
      }
      if (raw === null) return { match: null, raw: null, read: 'ok' as const };
      const files = candidates.filter((c): c is TreeEntry => c !== ABSENT && (c.mode === '100644' || c.mode === '100755'));
      if (filtered) return { match: files.find((c) => c.oid === raw) ?? null, raw, read: 'ok' as const };
      if (files.length === 0) return { match: null, raw, read: 'ok' as const };
      const blobs = await this.d.repo.readBlobs([raw, ...files.map((c) => c.oid)]);
      const rBytes = blobs[0] as Buffer;
      const skip = !this.d.isText(path);
      for (let i = 0; i < files.length; i++) {
        const cBytes = blobs[i + 1] as Buffer;
        const res = canon(rBytes, cBytes, skip);
        if (res.ok && res.out.equals(cBytes)) return { match: files[i] as TreeEntry, raw, read: 'ok' as const };
      }
      return { match: null, raw, read: 'ok' as const };
    });
  }

  /**
   * Final review FB-7 (the read side of P2-NOFOLLOW): an existing ancestor of p below the work-tree root is a symlink, a
   * junction or not a directory (or cannot be lstat'd: fail closed). Such a p is never read: a read would resolve the
   * link and compare (or store) bytes from outside the work tree. A missing ancestor ends the walk (p is absent).
   */
  private async beneathLink(path: string): Promise<boolean> {
    let dir = this.d.repo.paths.workTree;
    for (const c of path.split('/').slice(0, -1)) {
      dir = join(dir, c);
      let st;
      try {
        st = await this.d.fs.lstat(dir);
      } catch {
        return true;
      }
      if (st === null) return false;
      if (st.isSymbolicLink || !st.isDirectory) return true;
    }
    return false;
  }

  private async absentEq(file: string): Promise<DiskEqResult> {
    try {
      return (await this.d.fs.lstat(file)) === null ? EQUAL : notEqual('differs');
    } catch {
      return notEqual('unreadable');
    }
  }

  private async compareRead(path: string, file: string, x: TreeEntry): Promise<DiskEqResult> {
    const r = await stagedRead(this.d.fs, file);
    if (r.kind === 'missing') return notEqual('differs');
    if (r.kind === 'unstable') return notEqual('unstable');
    if (r.kind === 'unreadable') return notEqual('unreadable');
    return this.withCopy(path, r.bytes, async (copy) => {
      try {
        if (this.d.mutants.has('M18') || this.d.isFiltered(path)) {
          const id = await hashRouteB(this.d.repo, path, copy, false);
          if (isFilterFailure(id)) return notEqual('error');
          return id === x.oid ? EQUAL : notEqual('differs');
        }
        return (await this.refreshCompare(path, x)) ? EQUAL : notEqual('differs');
      } catch {
        return notEqual('error');
      }
    });
  }

  /** tmp/cmp.index holding only X (p's index context); refresh against the stage tree; diff-files -z decides. */
  private async refreshCompare(path: string, x: TreeEntry): Promise<boolean> {
    const indexFile = this.d.cmpIndex;
    await resetScratchIndex(this.d.fs, indexFile);
    await this.d.repo.editIndex(indexFile, [{ path, mode: x.mode, oid: x.oid }]);
    const opts = { indexFile, workTree: this.d.stage.root, config: STAGE_TREE_CONFIG };
    // rc 0 or 1 are both normal and never read as the result (no -q: glossary §25 F12, §26.2 item 3).
    await this.d.repo.run(['update-index', '--refresh'], { ...opts, okCodes: [0, 1] });
    const diff = await this.d.repo.run(['diff-files', '-z', '--name-only'], opts);
    return !diff.stdout.toString('utf8').split('\0').includes(path);
  }

  /**
   * Route (a) into the empty scratch index addIndex: the raw blob git stores for the stage copy (an apply/hold step
   * only). `-f`: in the emptied index p is untracked, so the user's ignore rules (info/exclude, core.excludesFile, a
   * staged .gitignore copy) would otherwise refuse a tracked path with rc 1; the pathspec stays literal.
   */
  private async addRaw(path: string): Promise<Oid | null> {
    const indexFile = this.d.addIndex;
    await resetScratchIndex(this.d.fs, indexFile);
    await this.d.repo.run(['add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], {
      class: 'refupdate', indexFile, workTree: this.d.stage.root, literalPathspecs: true, config: STAGE_TREE_CONFIG,
      stdin: Buffer.from(`${path}\0`, 'utf8'),
    });
    return (await this.d.repo.listIndex(indexFile)).get(path)?.oid ?? null;
  }

  /**
   * Writes the stage copy of path for one comparison, then deletes it, unless the snapshot keeps a dirty copy of p:
   * that copy's bytes (whose id the tick computed and which a materialize must store) are put back as they were.
   */
  private async withCopy<T>(path: string, bytes: Buffer, fn: (copy: string) => Promise<T>): Promise<T> {
    let saved: Buffer | null = null;
    if (this.d.statCache.get(path)?.state === 'dirty') {
      try {
        saved = await this.d.fs.readFile(this.d.stage.abs(path));
      } catch (e) {
        if (!isGoneError(e)) throw e;
      }
    }
    const copy = await this.d.stage.write(path, bytes);
    try {
      return await fn(copy);
    } finally {
      if (saved !== null) await this.d.stage.write(path, saved);
      else await this.d.stage.remove(path);
    }
  }
}
