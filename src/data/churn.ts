// The churn guard's pure parts (03-data §3.8 "Churn guard", §3.10 churnVerdict, DAT-39; glossary §20 data numbers; ruling
// R3-35): the share of a text's rows a change rewrote, and the verdict over a path's observation history. A path changed at
// ≥ CHURN_SNAPSHOTS consecutive snapshots, each change with no hook attribution and rewriting ≥ CHURN_REWRITE_RATIO of the
// rows (or the path binary), is a generator suspect. Bytes in, numbers out: no git, no I/O. The engine side (which ticks
// observe a path, prev and next bytes, the record) is src/engine/dataRecords.ts's churnStep.
//
// Cost (Task 7 fix rounds 1 and 2, controller rulings "bound the churn diff"): an observation runs on the loop, synchronously,
// for every changed LIVE path of a detection tick, so its work is bounded, never quadratic. The common leading and trailing
// rows are trimmed first, in one linear pass over the bytes, and the caps bound only the rows between them (a middle beyond a
// cap counts as a whole rewrite, 1, without a diff). The verdict only compares the share with CHURN_REWRITE_RATIO, so
// n·log n bounds over the rows that occur once on each side decide most changes without a diff; only a change that neither
// bound decides runs Myers, with its edit distance capped by a work budget; a change still undecided after that counts BELOW
// the ratio (a false negative only delays a record, a false positive would mask a human's file whole, F-DAT-04).
import { commonRowEnds, internRows } from './linediff.js';
import { rows } from './rows.js';

/** Glossary §20: the newest 3 consecutive snapshots decide. */
export const CHURN_SNAPSHOTS = 3;
/** Glossary §20: each of them rewrites ≥ 20 % of the rows. */
export const CHURN_REWRITE_RATIO = 0.2;
/** The byte cap of one side's middle (the rows between the common leading and trailing rows): beyond it, a whole rewrite. */
export const CHURN_DIFF_MAX_BYTES = 8 * 1_048_576;
/** The row cap of one side's middle (the 1.3 MB 26,436-row fixture is well inside): beyond it, a whole rewrite. */
export const CHURN_DIFF_MAX_ROWS = 100_000;
/** The Myers work budget of one observation, in diagonal steps ((rows of the two middles) × edit distance). */
export const CHURN_DIFF_MAX_WORK = 10_000_000;

/** One snapshot's change of a path: hook-attributed (AttributionPort.hookAttributed), the rewritten-rows share, and binary (DAT-04). */
export interface ChurnObservation { attributed: boolean; rewrittenRatio: number; binary: boolean; }

/**
 * churnVerdict (03-data §3.10): 'generated?' when the newest CHURN_SNAPSHOTS observations (history is oldest first) are all
 * unattributed and each rewrites ≥ CHURN_REWRITE_RATIO of the rows or is binary ("or the path is binary", DAT-39); else
 * 'none'. Older observations never matter: an attributed change three snapshots back no longer breaks the chain. Pure.
 */
export function churnVerdict(history: readonly ChurnObservation[]): 'none' | 'generated?' {
  if (history.length < CHURN_SNAPSHOTS) return 'none';
  const newest = history.slice(history.length - CHURN_SNAPSHOTS);
  const qualifies = (o: ChurnObservation): boolean => !o.attributed && (o.binary || o.rewrittenRatio >= CHURN_REWRITE_RATIO);
  return newest.every(qualifies) ? 'generated?' : 'none';
}

/** The number of rows of a blob (LF-ended rows plus a final run without LF), counting at most `cap + 1`. */
function rowCount(blob: Buffer, cap: number): number {
  let n = 0;
  let start = 0;
  for (;;) {
    const nl = blob.indexOf(0x0a, start);
    if (nl < 0) break;
    n += 1;
    if (n > cap) return n;
    start = nl + 1;
  }
  return start < blob.length ? n + 1 : n;
}

/**
 * The share of prev's rows that next does not keep: 1 − |matched rows| ÷ |rows(prev)|, rows compared with their endings
 * ignored (a LF ↔ CRLF rewrite of the same rows is 0, D-20), matched rows being a longest common subsequence (Myers). An
 * empty prev gives 1 when next has a row and 0 when both are empty. Pure, and bounded in cost:
 *  1. the common leading and trailing rows match (linediff's commonRowEnds: linear, compared in place);
 *  2. a middle (the rows between them) beyond CHURN_DIFF_MAX_BYTES or CHURN_DIFF_MAX_ROWS on either side → 1, a whole
 *     rewrite, nothing split or diffed;
 *  3. on the middles, the rows that occur once on each side anchor the match (patience): a longest increasing run of their
 *     positions bounds the matched rows from above (with every other row matched as often as both sides hold it) and, with the
 *     gaps between consecutive anchors filled, from below. The lower bound of the share decides ≥ the ratio (a wholesale
 *     rewrite or a reordering, Myers' quadratic cases, cost n·log n); equal bounds are the exact share (a block move of rows
 *     that occur once);
 *  4. else Myers' edit distance D on the middles, capped at the distance that would reach the ratio and at
 *     CHURN_DIFF_MAX_WORK ÷ (n + m): found → the exact share; not found under the ratio cap → a lower bound ≥ the ratio;
 *  5. else (the work budget ran out first) the anchored upper bound of the share, when it is below the ratio; otherwise the
 *     change is undecided and counts below the ratio: its best lower bound (< the ratio) is returned.
 * So within the caps a value ≥ CHURN_REWRITE_RATIO is a lower bound of the exact share (never a false positive); a value
 * below the ratio is exact when Myers or equal bounds decided it (always so within the work budget, e.g. for ≤ 80-row texts),
 * else an upper bound below the ratio, or, undecided, a lower bound — then the exact share may be at or above the ratio.
 */
export function rewrittenRatio(prev: Buffer, next: Buffer): number {
  if (prev.length === 0) return next.length === 0 ? 0 : 1;
  const ends = commonRowEnds(prev, next);
  const midA = prev.subarray(ends.aStart, ends.aEnd);
  const midB = next.subarray(ends.bStart, ends.bEnd);
  if (midA.length > CHURN_DIFF_MAX_BYTES || midB.length > CHURN_DIFF_MAX_BYTES) return 1;
  if (rowCount(midA, CHURN_DIFF_MAX_ROWS) > CHURN_DIFF_MAX_ROWS || rowCount(midB, CHURN_DIFF_MAX_ROWS) > CHURN_DIFF_MAX_ROWS) return 1;
  const { A, B, alphabet } = internRows(rows(midA), rows(midB));
  const n = A.length;
  const m = B.length;
  const total = ends.rows + n;
  if (n === 0) return 0;
  if (m === 0) return n / total;

  const bounds = anchoredBounds(A, B, alphabet);
  if (bounds.lower / total >= CHURN_REWRITE_RATIO || bounds.lower === bounds.upper) return bounds.lower / total;

  // Myers on the middles: unmatched = (n − m + D) / 2, so the share reaches the ratio once D ≥ dRatio.
  const dRatio = Math.max(0, Math.ceil(2 * CHURN_REWRITE_RATIO * total - (n - m)));
  const dBudget = Math.floor(CHURN_DIFF_MAX_WORK / (n + m));
  const dMax = Math.min(n + m, dRatio, dBudget);
  const d = editDistance(A, B, dMax);
  if (d !== null) return (n - m + d) / 2 / total;
  const lower = Math.max(bounds.lower, (n - m + dMax + 1) / 2) / total;   // D ≥ dMax + 1
  if (lower >= CHURN_REWRITE_RATIO) return lower;

  // The work budget ran out under the ratio: the anchored common subsequence decides below it, or nothing does.
  const upper = bounds.upper / total;
  return upper < CHURN_REWRITE_RATIO ? upper : lower;
}

/**
 * Myers' forward greedy (An O(ND) Difference Algorithm, §3) over A × B: the insert/delete edit distance, or null when it
 * exceeds dMax. O((N + M) · dMax) time, O(dMax) space.
 */
function editDistance(A: Int32Array, B: Int32Array, dMax: number): number | null {
  const n = A.length;
  const m = B.length;
  const off = dMax + 1;
  const v = new Int32Array(2 * dMax + 3);
  v[off + 1] = 0;
  for (let d = 0; d <= dMax; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return d;
    }
  }
  return null;
}

/** The indexes of a longest strictly increasing subsequence of v, in order (patience sorting with back links). O(k log k). */
function longestIncreasing(v: readonly number[]): number[] {
  const tails: number[] = [];
  const back = new Int32Array(v.length);
  for (let t = 0; t < v.length; t++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (v[tails[mid]!]! < v[t]!) lo = mid + 1;
      else hi = mid;
    }
    back[t] = lo > 0 ? tails[lo - 1]! : -1;
    tails[lo] = t;
  }
  const out = new Array<number>(tails.length);
  let t = tails.length > 0 ? tails[tails.length - 1]! : -1;
  for (let c = tails.length - 1; c >= 0; c--) {
    out[c] = t;
    t = back[t]!;
  }
  return out;
}

/**
 * Bounds of A's unmatched rows (n − |a longest common subsequence of A and B|), from the anchors: the ids that occur exactly
 * once in A and once in B. In any common subsequence the matched anchors keep their order on both sides, so at most a longest
 * increasing run of the anchors' B positions (taken in A order) matches, and every other id matches at most min(its count in
 * A, in B) times: `lower` = n − that run − Σ those minima. The run itself plus, in each gap between two consecutive run
 * anchors (and before the first and after the last), the rows matched by extending from both ends of the gap and then by an
 * in-order greedy match inside it, is a common subsequence: `upper` = n − its length. O((n + m) log n + alphabet).
 */
function anchoredBounds(A: Int32Array, B: Int32Array, alphabet: number): { lower: number; upper: number } {
  const n = A.length;
  const m = B.length;
  const inA = new Int32Array(alphabet);
  const inB = new Int32Array(alphabet);
  const posB = new Int32Array(alphabet);
  for (let i = 0; i < n; i++) inA[A[i]!]! += 1;
  for (let j = 0; j < m; j++) {
    inB[B[j]!]! += 1;
    posB[B[j]!] = j;
  }
  let shared = 0;   // Σ min(count in A, count in B) over the ids that are not anchors
  for (let id = 0; id < alphabet; id++) if (inA[id] !== 1 || inB[id] !== 1) shared += Math.min(inA[id]!, inB[id]!);
  const anchorA: number[] = [];
  const anchorB: number[] = [];
  for (let i = 0; i < n; i++) {
    const id = A[i]!;
    if (inA[id] === 1 && inB[id] === 1) {
      anchorA.push(i);
      anchorB.push(posB[id]!);
    }
  }
  const run = longestIncreasing(anchorB);
  const lower = n - run.length - shared;

  // B's positions by id (ascending), and per id a cursor that only moves forward: the gaps are visited in order on both sides.
  const first = new Int32Array(alphabet + 1);
  for (let id = 0; id < alphabet; id++) first[id + 1] = first[id]! + inB[id]!;
  const flat = new Int32Array(m);
  const fill = first.slice(0, alphabet);
  for (let j = 0; j < m; j++) {
    const id = B[j]!;
    flat[fill[id]!] = j;
    fill[id] = fill[id]! + 1;
  }
  const cursor = first.slice(0, alphabet);
  const gap = (aLo: number, aHi: number, bLo: number, bHi: number): number => {
    let head = 0;
    while (aLo + head < aHi && bLo + head < bHi && A[aLo + head] === B[bLo + head]) head++;
    let tail = 0;
    while (aHi - tail > aLo + head && bHi - tail > bLo + head && A[aHi - 1 - tail] === B[bHi - 1 - tail]) tail++;
    let at = bLo + head - 1;
    const limit = bHi - tail;
    let greedy = 0;
    for (let i = aLo + head; i < aHi - tail; i++) {
      const id = A[i]!;
      const end = first[id + 1]!;
      let c = cursor[id]!;
      while (c < end && flat[c]! <= at) c++;
      cursor[id] = c;
      if (c < end && flat[c]! < limit) {
        at = flat[c]!;
        cursor[id] = c + 1;
        greedy += 1;
      }
    }
    return head + tail + greedy;
  };
  let matched = run.length;
  let a0 = 0;
  let b0 = 0;
  for (const t of run) {
    matched += gap(a0, anchorA[t]!, b0, anchorB[t]!);
    a0 = anchorA[t]! + 1;
    b0 = anchorB[t]! + 1;
  }
  matched += gap(a0, n, b0, m);
  return { lower, upper: n - matched };
}
