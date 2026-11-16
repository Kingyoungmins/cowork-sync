// REBASE (05-holds §3.4 item 1; HLD-13, HLD-14; rulings R3-18, R3-19): H1'[p] = mf(A[p], H0[p], H1[p]), always single-step
// from the record's ORIGINAL pair ((s1, s2) for a stage record), H0' = A, through Plan 2's mergeFile (merge-file -p
// --object-id with MERGE_FLAGS). A is ENG's per-path base, never tree(LA_C)[p] (the caller passes it). rc 1…127 is a
// conflict; any other rc (mergeFile's −1: a missing or corrupt object, a killed git, or an abnormal end such as git 2.53's BUG()
// abort read as exit 3 with no marker row — mergeFileRc, ruling G1-RC) is an operator error, never a conflict.
//
// No merge-file runs on a binary or filtered path or with an ABSENT side (R3-18): there the whole-path rule decides —
// H1' = H1 when A[p] == H0[p] or A[p] == H1[p], else a conflict. Binary is decided by the caller's `mergeable` (EPOCH_BASE
// attributes: text and unfiltered) and by the bytes themselves (DAT-04: a NUL in the first 8,000 bytes of any side), so
// git merge-file never sees a binary side (it would refuse it as an error).
//
// Outputs are written by route (c) (`hash-object -w --stdin --no-filters`, stored form) because the next merge-file
// --object-id reads them; REBASE runs only in materializing or publishing iterations (R3-19, glossary §26.1 W6). Results
// are cached per path by (r.id, r.rev, p, A[p]) and the path's original pair (so a rev evaluated before its commit cannot answer
// for other blobs of that rev number); a REBASE that throws caches nothing. This module reads no claim state (HLD-06).
import { isBinaryBytes } from '../data/rows.js';
import { mergeFile } from '../git/merge.js';
import { ABSENT, type Oid, type OidOrAbsent } from '../git/oid.js';
import type { GitRepo, TreeMap } from '../git/repo.js';
import { KilledAt } from '../ports/crashpoint.js';
import { blobAt, heldSide, setBlob, type BlobMap, type HoldRecord } from './record.js';

export type RebaseOutcome = { ok: true; h0p: BlobMap; h1p: BlobMap } | { ok: false; conflicted: string[] };

/**
 * A merge-file exit outside 0…127 (Plan 2's mergeFile rc −1: a missing or corrupt object, a killed git) is an operator error,
 * never a conflict (HLD-14's "rc ≠ 0 means conflict" is read as rc 1…127). REBASE and MASK throw it and cache nothing;
 * Task 2 maps it to HOLD_MASK_INVALID (05 F1).
 */
export class HoldOperatorError extends Error {
  readonly op: 'rebase' | 'mask' | 'reapply';
  readonly path: string;
  readonly holdId: string;
  constructor(op: 'rebase' | 'mask' | 'reapply', path: string, holdId: string, detail?: string) {
    super(`${op} of hold ${holdId} on ${JSON.stringify(path)}: ${detail ?? 'operator error'}`);
    this.name = 'HoldOperatorError';
    this.op = op;
    this.path = path;
    this.holdId = holdId;
  }
}

/** One path's REBASE: the new held blob, or null for a conflict. */
type PathResult = OidOrAbsent | null;

export class RebaseCache {
  private readonly repo: GitRepo;
  private readonly mergeable: (path: string) => boolean;
  private readonly memo = new Map<string, PathResult>();

  constructor(repo: GitRepo, mergeable: (path: string) => boolean) {
    this.repo = repo;
    this.mergeable = mergeable;
  }

  /**
   * REBASE(r, p) for every path of r: H1'[p] = mf(A[p], H0[p], H1[p]) (stage record: mf(A[p], s1[p], s2[p])), H0'[p] = A[p];
   * the whole-path rule for a path that is not mergeable, binary or has an ABSENT side. A path a filter-failure record holds
   * no h1 for is a conflict (nothing to rebase). Throws HoldOperatorError (and caches nothing) on a merge-file error.
   */
  async rebase(r: HoldRecord, A: TreeMap): Promise<RebaseOutcome> {
    const base = 'h0' in r.blobs ? r.blobs.h0 : r.blobs.s1;
    const held = heldSide(r);
    const fresh = new Map<string, PathResult>();
    const h0p: BlobMap = {};
    const h1p: BlobMap = {};
    const conflicted: string[] = [];
    for (const p of r.paths) {
      const a: OidOrAbsent = A.get(p)?.oid ?? ABSENT;
      setBlob(h0p, p, a);
      // (id, rev, p, A[p]) plus the path's original pair: a rev evaluated before it is committed (commitMany's HLD-07 check over
      // the batch's patched records) never answers for other blobs a later commit gives that rev number.
      const h0 = blobAt(base, p);
      const h1 = blobAt(held, p);
      const key = `${r.id}\u0000${r.rev}\u0000${p}\u0000${a}\u0000${h0 ?? ''}\u0000${h1 ?? ''}`;
      let out = this.memo.get(key);
      if (out === undefined) {
        out = await this.rebasePath(r.id, p, a, h0, h1);
        fresh.set(key, out);
      }
      if (out === null) conflicted.push(p);
      else setBlob(h1p, p, out);
    }
    for (const [k, v] of fresh) this.memo.set(k, v);
    return conflicted.length > 0 ? { ok: false, conflicted } : { ok: true, h0p, h1p };
  }

  /**
   * HLD-07 (R3-14): h1 equals r's CURRENT H1' (its REBASE at A) on every path, and names exactly r's paths. r's stored held side is
   * its H1' only while A equals r's original base on every path (mf(A, A, H1) = H1; the whole-path rule's A == H0): only then is
   * equality with the stored side decided without git. Once an apply has moved A under r (HLD-02/HLD-14 keep the original pair), an
   * h1 equal to the stored side is another change — a stale save that also drops the newer teammate line (final review r2 D-1,
   * INV-HLD-NOREVERT) — and a REBASE conflict at A means r has no H1', so nothing converges.
   */
  async converges(r: HoldRecord, A: TreeMap, h1: BlobMap): Promise<boolean> {
    const keys = Object.keys(h1).sort();
    if (keys.length !== r.paths.length || keys.some((k, i) => k !== r.paths[i])) return false;
    const base = 'h0' in r.blobs ? r.blobs.h0 : r.blobs.s1;
    const held = heldSide(r);
    const atBase = r.paths.every((p) => blobAt(base, p) === (A.get(p)?.oid ?? ABSENT));
    if (atBase && r.paths.every((p) => blobAt(held, p) !== undefined && blobAt(held, p) === blobAt(h1, p))) return true;
    const out = await this.rebase(r, A);
    return out.ok && r.paths.every((p) => blobAt(out.h1p, p) === blobAt(h1, p));
  }

  /**
   * Bounds memory; stale keys simply miss. The core calls it at every iteration start (prepareIteration): a cached output is a
   * loose object nothing references, which a user's `git gc` between iterations may prune (the daemon itself never runs gc).
   */
  clear(): void {
    this.memo.clear();
  }

  private async rebasePath(holdId: string, p: string, a: OidOrAbsent, h0: OidOrAbsent | undefined, h1: OidOrAbsent | undefined): Promise<PathResult> {
    if (h0 === undefined || h1 === undefined) return null;
    if (a === ABSENT || h0 === ABSENT || h1 === ABSENT || !this.mergeable(p) || (await this.anyBinary(holdId, p, [a, h0, h1]))) {
      return a === h0 || a === h1 ? h1 : null;   // the whole-path rule (R3-18)
    }
    let m;
    try {
      m = await mergeFile(this.repo, a, h0, h1);
    } catch (e) {
      if (e instanceof KilledAt) throw e;
      throw new HoldOperatorError('rebase', p, holdId, e instanceof Error ? e.message : String(e));
    }
    if (m.rc >= 1 && m.rc <= 127) return null;
    if (m.rc !== 0) throw new HoldOperatorError('rebase', p, holdId, 'merge-file ended abnormally, its stderr names an error, or its exit is not a conflict count (mergeFileRc -1)');
    return this.repo.hashBytes(m.out, true);
  }

  /** DAT-04 on the bytes of every side (one cat-file --batch); a missing or corrupt object is an operator error. */
  private async anyBinary(holdId: string, p: string, sides: readonly Oid[]): Promise<boolean> {
    const unique = [...new Set(sides)];
    let bufs: Buffer[];
    try {
      bufs = await this.repo.readBlobs(unique);
    } catch (e) {
      if (e instanceof KilledAt) throw e;
      throw new HoldOperatorError('rebase', p, holdId, e instanceof Error ? e.message : String(e));
    }
    return bufs.some((b) => isBinaryBytes(b));
  }
}
