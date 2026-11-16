// MASK (glossary §3; 05-holds §3.4 item 2; HLD-15, HLD-19, HLD-21; 03-data DAT-20, DAT-23, DAT-35; rulings R-04, R3-18…R3-21,
// R3-50). Per path p, in this order:
//   1. p's scope class is QUARANTINED, SAVE_ONLY or UNMANAGED                        → A[p]   'path_class'
//   2. p is a path of a non-terminal ON_DISK local_only record, or of an ON_DISK
//      record carrying a whole-path guard (05-holds §2) or a guard outside Table 3
//      (HLD-05 fail closed, ruling R3-EF4-29)                                          → A[p]   'local_only' / 'whole_path_guard'
//   3. p is covered by an ON_DISK PIN with a non-empty guard set                      → A[p]   'pin'
//   4. p is covered by an ON_DISK CONFLICTED record, or an OFF_DISK record carrying
//      claim-breach                                                                    → A[p]   'conflicted'
//   5. for each ON_DISK ACTIVE PATCH with a non-empty guard set on p, in ULID order:
//      x := mf(x, H1'[p], H0'[p]) from x = X[p] (H0', H1' = REBASE, so H0' = A[p])     → x      'patch'
//      rc 1…127 (or a REBASE conflict) → the path takes A[p] and the record id is reported in `conflicted` (the caller
//      transitions it to CONFLICTED: MASK writes no registry state, R3-19)
//   6. otherwise X[p].
// "→ A[p]" is absent when A has no entry for p. Every other OFF_DISK record masks nothing (INV-HLD-OFFDISK), and an INCOMING record
// masks nothing at any step (final review F5; R3-21 as amended: it holds TIP's bytes, none of this disk's).
//
// Step 5 runs no merge-file on a binary (DAT-04: a NUL in the first 8,000 bytes of any side) or filtered path (the caller's
// `mergeable`: text and unfiltered at EPOCH_BASE): such a path is withheld whole (step-2 treatment, R3-18). With an ABSENT side
// (A[p], X[p], H0[p] or H1[p]) no merge-file runs either: the whole-file form of the same merge decides (cur == base → other;
// other == base or cur == other → cur; else a conflict). Step-5 outputs are hashed by route (c) (`hash-object -w --stdin
// --no-filters`, stored form) because the next merge-file --object-id reads them; MASK runs only in materializing or publishing
// iterations (R3-19, glossary §26.1 W6). A merge-file error (an exit outside 0…127: a missing or corrupt object; or an abnormal end that
// mergeFileRc reads as −1, ruling G1-RC: a git BUG()/fatal, a kill, a count without git's marker rows) is an operator error, never a
// conflict: HoldOperatorError{op: 'mask'} (05 F1; HOLD_MASK_INVALID at the caller).
//
// HLD-19 (R3-20): assertSPub over S_pub and assertP over P; HLD-21: heldRanges. All three compute rows in-process (rows over
// stored-form blobs, or the reverse merge of one record); none runs `git diff -U0` (L-HOLD-STORES, Task 8). The diff rows come
// from src/regions/mapper.ts's hunks() — FoldMapper/1, the one line mapper (REG-07, R4-17: the row source is the only change).
// Nothing here reads claim state (HLD-06).
//
// Mutants (R-29, R3-50), one site each in this file: M19 (step 5 from the unrebased pair), M25 (QUARANTINED paths not reset by
// step 1), M28 (step 5 replaces the held rows at their original row numbers instead of the reverse merge).
import { hunks } from '../regions/mapper.js';   // the one admitted src/regions import (L-CLAIMFREE-HOLDS); the one line mapper (REG-07)
import { hasBom, isBinaryBytes, rows } from '../data/rows.js';
import type { ScopeClass } from '../data/scope.js';
import { mergeFile } from '../git/merge.js';
import { ABSENT, type Oid, type OidOrAbsent } from '../git/oid.js';
import type { GitRepo, TreeEntry, TreeMap } from '../git/repo.js';
import { KilledAt } from '../ports/crashpoint.js';
import { HoldOperatorError, RebaseCache } from './rebase.js';
import { blobAt, guardName, hasWholePathGuard, heldSide, isTerminal, isUnknownGuard, type BlobMap, type HoldRecord } from './record.js';

/** `mergeable(p)`: text and unfiltered at EPOCH_BASE (the engine binds pathIsText && !pathIsFiltered). */
export interface MaskInputs { A: TreeMap; scope: (path: string) => ScopeClass; records: readonly HoldRecord[]; mergeable: (path: string) => boolean; }
/** Mutant flags the engine sets from EngineDeps.testMutants (M19, M25, M28; R3-50). */
export interface MaskOptions { m19?: boolean; m25?: boolean; m28?: boolean; }
export interface MaskResult {
  entries: Map<string, TreeEntry>;       // MASK(X); a masked path that A lacks is absent
  withheld: ReadonlySet<string>;         // whole path := A[p] (steps 1–4, binary/filtered PATCH, step-5 conflict)
  partial: ReadonlySet<string>;          // step 5 applied
  conflicted: string[];                  // record ids whose step-5 merge had rc ≠ 0 → the caller transitions them to CONFLICTED
}
export type MaskReason = 'path_class' | 'local_only' | 'whole_path_guard' | 'pin' | 'conflicted' | 'patch' | null;
export type MaskAssert = { ok: true } | { ok: false; clause: 'reapply' | 'revert_line' | 'p_class' | 'p_local_only' | 'p_withheld' | 'p_range'; path: string };

type RecordReason = Exclude<MaskReason, 'path_class' | null>;

/** Step order of the record reasons (step 2's two forms first). */
const RANK: Readonly<Record<RecordReason, number>> = { local_only: 0, whole_path_guard: 1, pin: 2, conflicted: 3, patch: 4 };

const PATH_CLASSES: ReadonlySet<ScopeClass> = new Set<ScopeClass>(['QUARANTINED', 'SAVE_ONLY', 'UNMANAGED']);

/**
 * The earliest step at which r masks its paths, or null when r masks nothing. Final review F5 (R3-21 as amended by Task 6: "INCOMING
 * records never make a path LOCAL_ONLY"): an INCOMING record holds TIP's bytes and none of this disk's (ON_DISK by schema only), so it
 * masks nothing — its local_only flag (a secret-like name, a non-LIVE class) keeps only its mirror effect, the content-free stub. No
 * INCOMING guard is whole-path (05 §2) and INCOMING is never CONFLICTED, so step 2's local_only form was the only one it reached; a
 * path it shares with a local_only PATCH or PIN (a local-only-conflict) stays masked by that record. MASK step 2, HLD-19's P clause
 * (assertP 'p_local_only') and HLD-42's withholding records all read this function.
 * Ruling R3-EF4-29 (HLD-05 fail closed, version skew): an ON_DISK record carrying any guard outside Table 3 (a newer daemon's) is
 * whole-path at step 2, never a step-5 record — step 5 could report it in `conflicted`, and no state patch may be committed onto it.
 */
function recordReason(r: HoldRecord): RecordReason | null {
  if (isTerminal(r) || r.kind === 'INCOMING') return null;
  if (r.residence === 'ON_DISK') {
    if (r.local_only) return 'local_only';
    if (hasWholePathGuard(r) || r.guards.some(isUnknownGuard)) return 'whole_path_guard';
    if (r.kind === 'PIN' && r.guards.length > 0) return 'pin';
    if (r.state === 'CONFLICTED') return 'conflicted';
    if (r.kind === 'PATCH' && r.state === 'ACTIVE' && r.guards.length > 0) return 'patch';
    return null;
  }
  // OFF_DISK: only a claim-breach path pin (step 4).
  return r.guards.some((g) => guardName(g) === 'claim-breach') ? 'conflicted' : null;
}

/** path → the earliest record step that masks it. */
function recordIndex(records: readonly HoldRecord[]): Map<string, RecordReason> {
  const idx = new Map<string, RecordReason>();
  for (const r of records) {
    const reason = recordReason(r);
    if (reason === null) continue;
    for (const p of r.paths) {
      const had = idx.get(p);
      if (had === undefined || RANK[reason] < RANK[had]) idx.set(p, reason);
    }
  }
  return idx;
}

const byId = (x: HoldRecord, y: HoldRecord): number => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

/** path → its step-5 records in ULID order, for every path whose first masking step is 5. */
function stepFiveChains(records: readonly HoldRecord[], idx: ReadonlyMap<string, RecordReason>): Map<string, HoldRecord[]> {
  const out = new Map<string, HoldRecord[]>();
  for (const r of [...records].sort(byId)) {
    if (recordReason(r) !== 'patch') continue;
    for (const p of r.paths) {
      if (idx.get(p) !== 'patch') continue;
      const chain = out.get(p);
      if (chain === undefined) out.set(p, [r]);
      else chain.push(r);
    }
  }
  return out;
}

/** The original base side: h0, or s1 for a stage record. */
function baseSide(r: HoldRecord): BlobMap {
  return 'h0' in r.blobs ? r.blobs.h0 : r.blobs.s1;
}

/** A record side's blob of p (record.ts's blobAt: own properties only); a path the side does not name is ABSENT. */
const sideOf = (m: BlobMap, p: string): OidOrAbsent => blobAt(m, p) ?? ABSENT;
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
type Op = HoldOperatorError['op'];

/** DAT-04 on the bytes of every non-ABSENT side (one cat-file --batch); a missing or corrupt object is an operator error. */
async function anyBinary(repo: GitRepo, op: Op, p: string, holdId: string, sides: readonly OidOrAbsent[]): Promise<boolean> {
  const unique = [...new Set(sides.filter((s): s is Oid => s !== ABSENT))];
  let bufs: Buffer[];
  try {
    bufs = await repo.readBlobs(unique);
  } catch (e) {
    if (e instanceof KilledAt) throw e;
    throw new HoldOperatorError(op, p, holdId, message(e));
  }
  return bufs.some((b) => isBinaryBytes(b));
}

/**
 * One operator step mf(cur, base, other) → the result blob (written by route (c) when `write`, else only hashed), or null for a
 * conflict (rc 1…127). With an ABSENT side the whole-file form decides and no merge-file runs (R3-18).
 */
async function mf(repo: GitRepo, op: Op, p: string, holdId: string, cur: OidOrAbsent, base: OidOrAbsent, other: OidOrAbsent, write: boolean): Promise<OidOrAbsent | null> {
  if (cur === ABSENT || base === ABSENT || other === ABSENT) {
    if (cur === base) return other;
    if (other === base || cur === other) return cur;
    return null;
  }
  let m;
  try {
    m = await mergeFile(repo, cur, base, other);
  } catch (e) {
    if (e instanceof KilledAt) throw e;
    throw new HoldOperatorError(op, p, holdId, message(e));
  }
  if (m.rc >= 1 && m.rc <= 127) return null;
  if (m.rc !== 0) throw new HoldOperatorError(op, p, holdId, 'merge-file ended abnormally, its stderr names an error, or its exit is not a conflict count (mergeFileRc -1)');
  return repo.hashBytes(m.out, write);
}

/** REBASE(r, p) through the shared cache (keyed (id, rev, p, A[p])): [H0'[p], H1'[p]], or null for a REBASE conflict. */
async function rebaseOne(cache: RebaseCache, op: Op, r: HoldRecord, p: string, A: TreeMap): Promise<readonly [OidOrAbsent, OidOrAbsent] | null> {
  let out;
  try {
    out = await cache.rebase({ ...r, paths: [p] }, A);
  } catch (e) {
    if (e instanceof HoldOperatorError && e.op !== op) throw new HoldOperatorError(op, p, r.id, e.message);
    throw e;
  }
  return out.ok ? [sideOf(out.h0p, p), sideOf(out.h1p, p)] : null;
}

/** Mutant M28 (R3-50; its only site): the held rows replaced at their ORIGINAL row numbers — a positional per-hunk withdrawal. */
async function positionalWithdrawal(repo: GitRepo, p: string, holdId: string, cur: Oid, h0: Oid, h1: Oid): Promise<Oid> {
  let bufs: Buffer[];
  try {
    bufs = await repo.readBlobs([cur, h0, h1]);
  } catch (e) {
    if (e instanceof KilledAt) throw e;
    throw new HoldOperatorError('mask', p, holdId, message(e));
  }
  const [x, r0, r1] = [rows(bufs[0]!), rows(bufs[1]!), rows(bufs[2]!)];
  for (const h of hunks(r0, r1).reverse()) x.splice(h.bLo - 1, h.bHi - h.bLo + 1, ...r0.slice(h.aLo - 1, h.aHi));
  return repo.hashBytes(Buffer.concat(x), true);
}

type StepFive = { kind: 'ok'; oid: OidOrAbsent } | { kind: 'whole' } | { kind: 'conflict'; id: string };

/** Step 5 on p from x = X[p] over its chain (ULID order). */
async function stepFive(repo: GitRepo, p: string, x: OidOrAbsent, chain: readonly HoldRecord[], inp: MaskInputs, cache: RebaseCache, o: MaskOptions): Promise<StepFive> {
  if (!inp.mergeable(p)) return { kind: 'whole' };
  const sides: OidOrAbsent[] = [x, inp.A.get(p)?.oid ?? ABSENT];
  for (const r of chain) sides.push(sideOf(baseSide(r), p), sideOf(heldSide(r), p));
  if (await anyBinary(repo, 'mask', p, chain[0]!.id, sides)) return { kind: 'whole' };
  let cur = x;
  for (const r of chain) {
    const h0 = sideOf(baseSide(r), p);
    const h1 = sideOf(heldSide(r), p);
    if (o.m28 === true && cur !== ABSENT && h0 !== ABSENT && h1 !== ABSENT) {
      cur = await positionalWithdrawal(repo, p, r.id, cur, h0, h1);
      continue;
    }
    let pairNow: readonly [OidOrAbsent, OidOrAbsent];
    if (o.m19 === true) {
      // Mutant M19 (R3-50; its only site): step 5 from the unrebased pair (H0, H1) instead of REBASE's (H0', H1').
      pairNow = [h0, h1];
    } else {
      const rb = await rebaseOne(cache, 'mask', r, p, inp.A);
      if (rb === null) return { kind: 'conflict', id: r.id };
      pairNow = rb;
    }
    const next = await mf(repo, 'mask', p, r.id, cur, pairNow[1], pairNow[0], true);
    if (next === null) return { kind: 'conflict', id: r.id };
    cur = next;
  }
  return { kind: 'ok', oid: cur };
}

/**
 * The entry of p holding `oid`: in X's mode whenever X has p (a record holds blobs, never a mode, so a local mode change is not
 * held, also when the output is A's bytes); else A's entry when it is A's blob, else a regular entry in A's mode; none for ABSENT.
 */
function entryOf(p: string, oid: OidOrAbsent, x: TreeEntry | undefined, a: TreeEntry | undefined): TreeEntry | undefined {
  if (oid === ABSENT) return undefined;
  if (x !== undefined) return x.oid === oid ? x : { path: p, mode: x.mode, oid };
  if (a !== undefined && a.oid === oid) return a;
  return { path: p, mode: a?.mode ?? '100644', oid };
}

/** Why MASK resets p to A[p] (the first step of steps 1–4 that applies), 'patch' when a step-5 record covers it, else null. Synchronous. */
export function maskReason(path: string, inp: MaskInputs): MaskReason {
  if (PATH_CLASSES.has(inp.scope(path))) return 'path_class';
  return recordIndex(inp.records).get(path) ?? null;
}

/**
 * MASK(X), 05 §3.4 item 2 steps 1–6 over the paths of X and A: a path withheld whole takes A's entry (absent when A has none),
 * a step-5 path the reverse merges' result, every other path X's entry or its absence. Writes no registry state; X and the
 * inputs are not modified. A merge-file error throws HoldOperatorError{op: 'mask'} and no entry map escapes.
 */
export async function maskEntries(repo: GitRepo, X: TreeMap, inp: MaskInputs, cache: RebaseCache, o: MaskOptions = {}): Promise<MaskResult> {
  const idx = recordIndex(inp.records);
  const chains = stepFiveChains(inp.records, idx);
  const entries = new Map<string, TreeEntry>();
  const withheld = new Set<string>();
  const partial = new Set<string>();
  const conflicted: string[] = [];
  const whole = (p: string, a: TreeEntry | undefined): void => {
    if (a !== undefined) entries.set(p, a);
    withheld.add(p);
  };
  for (const p of [...new Set([...X.keys(), ...inp.A.keys()])].sort()) {
    const x = X.get(p);
    const a = inp.A.get(p);
    const cls = inp.scope(p);
    // Mutant M25 (R3-50; its only site): step 1 leaves a QUARANTINED path unreset.
    if (PATH_CLASSES.has(cls) && !(o.m25 === true && cls === 'QUARANTINED')) {
      whole(p, a);
      continue;
    }
    const reason = idx.get(p);
    if (reason === undefined) {
      if (x !== undefined) entries.set(p, x);
      continue;
    }
    if (reason !== 'patch') {
      whole(p, a);
      continue;
    }
    const s = await stepFive(repo, p, x?.oid ?? ABSENT, chains.get(p)!, inp, cache, o);
    if (s.kind === 'ok') {
      const e = entryOf(p, s.oid, x, a);
      if (e !== undefined) entries.set(p, e);
      partial.add(p);
    } else {
      whole(p, a);
      if (s.kind === 'conflict' && !conflicted.includes(s.id)) conflicted.push(s.id);
    }
  }
  return { entries, withheld, partial, conflicted };
}

/**
 * Held ranges of rows `m` (MASK_PATCH(S_disk[p])) against rows `s` (S_disk[p]): the 1-based inclusive S_disk rows that m lacks,
 * and for a pure deletion after S_disk row k the zero-length range [k + 1, k] (diff -U0's "+k,0").
 */
function rowRanges(m: readonly Buffer[], s: readonly Buffer[]): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = [];
  for (const h of hunks(m, s)) {
    if (h.bHi >= h.bLo) out.push([h.bLo, h.bHi]);
    else if (h.aHi >= h.aLo) out.push([h.bLo, h.bLo - 1]);
  }
  return out;
}

/**
 * The bytes of p's entries' blobs (empty for an absent entry); reads existing blobs only. A missing or corrupt object is an
 * operator error (HoldOperatorError{op: 'mask'}; holdId '' — held ranges are per path, no single record is at hand).
 */
async function bytesOf(repo: GitRepo, p: string, oids: ReadonlyArray<Oid | undefined>): Promise<Buffer[]> {
  const present = [...new Set(oids.filter((o): o is Oid => o !== undefined))];
  const got = new Map<string, Buffer>();
  let bufs: Buffer[];
  try {
    bufs = await repo.readBlobs(present);
  } catch (e) {
    if (e instanceof KilledAt) throw e;
    throw new HoldOperatorError('mask', p, '', message(e));
  }
  present.forEach((o, i) => got.set(o, bufs[i]!));
  return oids.map((o) => (o === undefined ? Buffer.alloc(0) : got.get(o)!));
}

/**
 * Rows for comparison the way canon compares them (03-data D1 step 4, `sameRowContents`): the BOM is removed before the rows are
 * taken (it stays a form, never row content; row numbers are unchanged, it lives in row 1) and the mapper's line equality ignores
 * every ending (04 §3.4 step 1).
 */
const contentRows = (b: Buffer): Buffer[] => rows(hasBom(b) ? b.subarray(3) : b);

/**
 * HLD-21: per step-5 path of sPub, the 1-based inclusive stored-form rows of diff(MASK_PATCH(S_disk[p]), S_disk[p]) (a held pure
 * deletion after S_disk row k is [k + 1, k]), row content compared as canon compares it (BOM and endings ignored); a path whose
 * held change is not on disk has no entry. Reads existing blobs only: no object is written and no `git diff` runs (rows
 * in-process, L-HOLD-STORES); an unreadable blob is a HoldOperatorError{op: 'mask'}.
 */
export async function heldRanges(repo: GitRepo, sDisk: TreeMap, sPub: MaskResult): Promise<Map<string, Array<readonly [number, number]>>> {
  const out = new Map<string, Array<readonly [number, number]>>();
  for (const p of [...sPub.partial].sort()) {
    const s = sDisk.get(p)?.oid;
    const m = sPub.entries.get(p)?.oid;
    if (s === m) continue;
    const [mb, sb] = await bytesOf(repo, p, [m, s]);
    const ranges = rowRanges(contentRows(mb!), contentRows(sb!));
    if (ranges.length > 0) out.set(p, ranges);
  }
  return out;
}

const fail = (clause: Exclude<MaskAssert, { ok: true }>['clause'], path: string): MaskAssert => ({ ok: false, clause, path });
const isRevert = (r: HoldRecord): boolean => r.guards.some((g) => guardName(g) === 'revert');

/** Re-applies the chain's records to y in reverse ULID order (mf(y, H0', H1')); null on a conflict or a REBASE conflict. */
async function reapply(repo: GitRepo, p: string, y: OidOrAbsent, chain: readonly HoldRecord[], A: TreeMap, cache: RebaseCache): Promise<OidOrAbsent | null> {
  const rev = [...chain].reverse();
  for (let i = 0; i < rev.length; i++) {
    const r = rev[i]!;
    const rb = await rebaseOne(cache, 'reapply', r, p, A);
    if (rb === null) return null;
    const next = await mf(repo, 'reapply', p, r.id, y, rb[0], rb[1], i < rev.length - 1);   // intermediates are read by the next merge
    if (next === null) return null;
    y = next;
  }
  return y;
}

/** The tree under test lacks r's held change on p: the reverse merge mf(x, H1'[p], H0'[p]) is clean and returns x unchanged. */
async function lacksHeldChange(repo: GitRepo, p: string, x: OidOrAbsent, r: HoldRecord, A: TreeMap, cache: RebaseCache): Promise<boolean> {
  const rb = await rebaseOne(cache, 'reapply', r, p, A);
  if (rb === null) return false;
  return (await mf(repo, 'reapply', p, r.id, x, rb[1], rb[0], false)) === x;
}

/**
 * HLD-19 on S_pub, outside the paths S_pub withholds whole:
 * - 'reapply' (read as reapply(S_pub) == reapply(S_disk), R3-75): re-applying every step-5 PATCH of p (mf(cur, H0', H1'),
 *   reverse ULID order) to S_pub[p] gives what re-applying them to S_disk[p] gives — S_disk[p] itself whenever every held change is on disk (re-applying an applied change is idempotent);
 *   a record whose held change is no longer on disk (R1 ends it GONE in the same iteration) is re-added on both sides. A path
 *   with no step-5 record has S_pub[p] == S_disk[p].
 * - 'revert_line': S_pub[p] carries no line of an ON_DISK `revert` record's H0'→H1' change (lacksHeldChange).
 * Rows in-process; objects only for re-application intermediates (a materializing iteration, R3-19).
 */
export async function assertSPub(repo: GitRepo, sDisk: TreeMap, sPub: MaskResult, inp: MaskInputs, cache: RebaseCache): Promise<MaskAssert> {
  const chains = stepFiveChains(inp.records, recordIndex(inp.records));
  const paths = [...new Set([...sDisk.keys(), ...sPub.entries.keys(), ...sPub.partial])].filter((p) => !sPub.withheld.has(p)).sort();
  for (const p of paths) {
    const y = sPub.entries.get(p)?.oid ?? ABSENT;
    const d = sDisk.get(p)?.oid ?? ABSENT;
    const chain = chains.get(p) ?? [];
    if (chain.length === 0) {
      if (y !== d) return fail('reapply', p);
      continue;
    }
    const sides: OidOrAbsent[] = [y, d, inp.A.get(p)?.oid ?? ABSENT];
    for (const r of chain) sides.push(sideOf(baseSide(r), p), sideOf(heldSide(r), p));
    if (!inp.mergeable(p) || (await anyBinary(repo, 'reapply', p, chain[0]!.id, sides))) return fail('reapply', p);   // MASK withholds such a path whole
    const fromPub = await reapply(repo, p, y, chain, inp.A, cache);
    const fromDisk = await reapply(repo, p, d, chain, inp.A, cache);
    if (fromPub === null || fromDisk === null || fromPub !== fromDisk) return fail('reapply', p);
  }
  for (const p of paths) {
    const reverts = (chains.get(p) ?? []).filter(isRevert);
    const x = sPub.entries.get(p)?.oid ?? ABSENT;
    for (const r of reverts) if (!(await lacksHeldChange(repo, p, x, r, inp.A, cache))) return fail('revert_line', p);
  }
  return { ok: true };
}

const differs = (x: TreeEntry | undefined, y: TreeEntry | undefined): boolean =>
  x === undefined ? y !== undefined : y === undefined || x.oid !== y.oid || x.mode !== y.mode;

/**
 * HLD-19 on P (HLD-42), over the paths where P differs from A, clause by clause: 'p_class' (QUARANTINED, SAVE_ONLY, UNMANAGED),
 * 'p_local_only' (a path of a non-terminal ON_DISK local_only record), 'p_withheld' (a path withheld whole by a record: steps 2–4,
 * or a binary/filtered step-5 path), 'p_range' (a step-5 path of inp.records whose P blob still carries a held change:
 * lacksHeldChange fails for one of its step-5 records — the reverse merge of each record decides "no held range differs from A",
 * so no row list is needed). Rows in-process; REBASE through a cache of its own (a publishing iteration, R3-19).
 *
 * Plan 3 Task 2 fix round 1 (controller note): the contract's fourth parameter `ranges` (HLD-21's held ranges) is removed. The
 * held ranges of a path are rows of the last materialized S_disk, computed from the same step-5 records whose reverse merge this
 * clause already runs, so they can add no path the records do not name; a stale range (a record released between maskStep and
 * publishStep) would only fail a P that may now carry the change (R3-57). Contract line `assertP(repo, P, inp, ranges)` and
 * Task 12's call site read `assertP(repo, P, inp)`.
 */
export async function assertP(repo: GitRepo, P: TreeMap, inp: MaskInputs): Promise<MaskAssert> {
  const idx = recordIndex(inp.records);
  const chains = stepFiveChains(inp.records, idx);
  const changed = [...new Set([...P.keys(), ...inp.A.keys()])].filter((p) => differs(P.get(p), inp.A.get(p))).sort();
  for (const p of changed) if (PATH_CLASSES.has(inp.scope(p))) return fail('p_class', p);
  for (const p of changed) if (idx.get(p) === 'local_only') return fail('p_local_only', p);
  for (const p of changed) {
    const reason = idx.get(p);
    if (reason !== undefined && reason !== 'patch') return fail('p_withheld', p);
  }
  for (const p of changed) {
    const chain = chains.get(p);
    if (chain === undefined) continue;
    const sides: OidOrAbsent[] = [P.get(p)?.oid ?? ABSENT, inp.A.get(p)?.oid ?? ABSENT];
    for (const r of chain) sides.push(sideOf(baseSide(r), p), sideOf(heldSide(r), p));
    if (!inp.mergeable(p) || (await anyBinary(repo, 'reapply', p, chain[0]!.id, sides))) return fail('p_withheld', p);
  }
  const cache = new RebaseCache(repo, inp.mergeable);
  for (const p of changed) {
    const x = P.get(p)?.oid ?? ABSENT;
    for (const r of chains.get(p) ?? []) if (!(await lacksHeldChange(repo, p, x, r, inp.A, cache))) return fail('p_range', p);
  }
  return { ok: true };
}

