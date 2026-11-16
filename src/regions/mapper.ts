// FoldMapper/1, the one line mapper (04-regions §3.4; REG-07, INV-REG-MAP, INV-CLOCK; ruling R4-17): its own line equality,
// common prefix/suffix trimming, Myers' O(ND) greedy forward algorithm with the leftmost tie-break, the image rule and the
// D cap. Frozen for proto = 1 — any change to the hunks or images it returns is a protocol change (golden test T-REG-20).
// Pure and synchronous: it reads no clock (a local-mode mapping reads time only through the Deadline its caller passes),
// imports nothing from src/ports/clock.ts and nothing from Plan 2's linediff (L-ONE-MAPPER), and never decides disk equality.
import type { Deadline } from './budgets.js';
import { normalizeRanges } from './lines.js';
import type { Hunk, MapMode, MapResult, Ranges } from './types.js';

export { normalizeRanges, rangesIntersect } from './lines.js';   // declared in lines.ts (Task 3's first commit); one helper, re-exported

export const FOLD_MAPPER = 'FoldMapper/1';
export const D_CAP = 5_000;            // step 5: D > 5,000 → WHOLE_FILE in every mode
export const LOCAL_MAP_CAP_MS = 200;   // step 5: local mode only (BUDGETS.mapLocalMs)
export const D_REANCHOR = 1_000;       // glossary §20

const LF = 0x0a;
const CR = 0x0d;

/** Step 1's comparison form: the row without one trailing LF, then without one trailing CR, then (line 1 only) without a leading EF BB BF. */
function body(row: Buffer, lineOne: boolean): Buffer {
  let end = row.length;
  if (end > 0 && row[end - 1] === LF) end--;
  if (end > 0 && row[end - 1] === CR) end--;
  const start = lineOne && end >= 3 && row[0] === 0xef && row[1] === 0xbb && row[2] === 0xbf ? 3 : 0;
  return row.subarray(start, end);
}

/** Step 1: equal after removing one trailing \r from each and, on line 1 only, a leading EF BB BF. Rows are lineArray rows (each with its LF), so one LF is
 *  removed first: a final row without an LF equals the same row with one. */
export function linesEqual(a: Buffer, b: Buffer, lineOne: boolean): boolean {
  return body(a, lineOne).equals(body(b, lineOne));
}

/** Rows interned to integers by step 1's form (row index 0 of each array is its line 1), so equal ids ⇔ linesEqual. */
function intern(from: readonly Buffer[], to: readonly Buffer[]): { A: Int32Array; B: Int32Array } {
  const ids = new Map<string, number>();
  const id = (row: Buffer, index: number): number => {
    const key = body(row, index === 0).toString('latin1');
    let v = ids.get(key);
    if (v === undefined) {
      v = ids.size;
      ids.set(key, v);
    }
    return v;
  };
  return { A: Int32Array.from(from, id), B: Int32Array.from(to, id) };
}

/** The rows left after common prefix and suffix trimming: A[a0, a0 + n) against B[a0, a0 + m) (the prefix has the same length on both sides). */
interface Window { readonly A: Int32Array; readonly B: Int32Array; readonly p: number; readonly n: number; readonly m: number; }

function trim(A: Int32Array, B: Int32Array): Window {
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let s = 0;
  while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
  return { A, B, p, n: A.length - p - s, m: B.length - p - s };
}

/** Whether the window's two sides share no row (then every path costs n + m and the one hunk is the whole window). */
function disjoint(w: Window): boolean {
  if (w.n === 0 || w.m === 0) return true;
  const seen = new Set<number>();
  for (let j = 0; j < w.m; j++) seen.add(w.B[w.p + j] as number);
  for (let i = 0; i < w.n; i++) if (seen.has(w.A[w.p + i] as number)) return false;
  return true;
}

/**
 * One round d of Myers' forward greedy algorithm ("An O(ND) Difference Algorithm and Its Variations", 1986, Fig. 2) over the window's edit graph:
 * row[i] is the furthest x reached on diagonal k = 2i − d by a path with d non-diagonal moves, −1 when no such path stays inside the grid (0 ≤ x ≤ n,
 * 0 ≤ y ≤ m). Diagonal k is entered by a move down from k + 1 (an insertion; prev[i]) or right from k − 1 (a deletion; prev[i − 1]); the textbook rule
 * `k == −d or (k != d and V[k−1] < V[k+1]) → down` is applied to the in-grid candidates, so a tie takes the move from k − 1 (the leftmost diagonal).
 * Each move is followed by the greedy snake. Returns true when (n, m) is reached.
 */
function round(w: Window, prev: Int32Array | null, d: number, row: Int32Array): boolean {
  const { A, B, p, n, m } = w;
  row.fill(-1);
  let k = Math.max(-d, -m);
  if (((k + d) & 1) !== 0) k++;
  const kEnd = Math.min(d, n);
  for (; k <= kEnd; k += 2) {
    const i = (k + d) >> 1;
    let x: number;
    if (prev === null) {
      x = 0;
    } else {
      const xd = i <= d - 1 ? (prev[i] as number) : -1;
      const xr = i >= 1 ? (prev[i - 1] as number) : -1;
      const downOk = xd >= 0 && xd - k <= m;
      const rightOk = xr >= 0 && xr + 1 <= n;
      if (downOk && (!rightOk || xr < xd)) x = xd;
      else if (rightOk) x = xr + 1;
      else continue;
    }
    let y = x - k;
    while (x < n && y < m && A[p + x] === B[p + y]) {
      x++;
      y++;
    }
    row[i] = x;
    if (x === n && y === m) return true;
  }
  return false;
}

/** Every CHECKPOINT-th row of the forward pass is kept; the backtrack replays one segment at a time from them (memory O(D²/64 + 64·D), not O(D²)). */
const CHECKPOINT = 64;

/** The forward pass: D (≤ cap), null once D exceeds cap, 'deadline' when a passed deadline expires between rounds. */
function forward(w: Window, cap: number, deadline: Deadline | null, keep: Map<number, Int32Array> | null): number | null | 'deadline' {
  let prev: Int32Array | null = null;
  for (let d = 0; d <= cap; d++) {
    if (deadline !== null && deadline.expired()) return 'deadline';
    const row = new Int32Array(d + 1);
    const done = round(w, prev, d, row);
    if (keep !== null && d % CHECKPOINT === 0) keep.set(d, row);
    if (done) return d;
    prev = row;
  }
  return null;
}

/** A diagonal run of equal rows: A[a, a + len) = B[b, b + len), 0-based whole-array indexes. */
type Snake = readonly [a: number, b: number, len: number];

/** The middle snakes of the one path the forward pass defines, in order (window-relative indexes shifted by p). */
function backtrack(w: Window, D: number, checkpoints: Map<number, Int32Array>, deadline: Deadline | null): Snake[] | 'deadline' {
  const { n, m, p } = w;
  let segBase = -1;
  let seg: Int32Array[] = [];
  const rowAt = (r: number): Int32Array | 'deadline' => {
    if (segBase < 0 || r < segBase) {
      segBase = r - (r % CHECKPOINT);
      seg = [checkpoints.get(segBase) as Int32Array];
      for (let e = segBase + 1; e <= r; e++) {
        if (deadline !== null && deadline.expired()) return 'deadline';
        const row = new Int32Array(e + 1);
        round(w, seg[seg.length - 1] as Int32Array, e, row);
        seg.push(row);
      }
    }
    return seg[r - segBase] as Int32Array;
  };
  const reversed: Snake[] = [];
  let x = n;
  let y = m;
  for (let d = D; d > 0; d--) {
    const prev = rowAt(d - 1);
    if (prev === 'deadline') return 'deadline';
    const k = x - y;
    const i = (k + d) >> 1;
    // The same choice round() made for (d, k).
    const xd = i <= d - 1 ? (prev[i] as number) : -1;
    const xr = i >= 1 ? (prev[i - 1] as number) : -1;
    const downOk = xd >= 0 && xd - k <= m;
    const rightOk = xr >= 0 && xr + 1 <= n;
    const down = downOk && (!rightOk || xr < xd);
    const start = down ? xd : xr + 1;   // x right after the move; the snake runs from there to x
    if (x > start) reversed.push([p + start, p + start - k, x - start]);
    x = down ? xd : xr;
    y = down ? xd - k - 1 : xr - k + 1;
  }
  if (x > 0) reversed.push([p, p, x]);
  return reversed.reverse();
}

/** Hunks between the snakes: maximal runs of unmatched rows, 1-based (04 §3.1 shape). */
function hunksOf(N: number, M: number, snakes: readonly Snake[]): Hunk[] {
  const out: Hunk[] = [];
  let a = 0;
  let b = 0;
  for (const [sa, sb, len] of snakes) {
    if (len === 0) continue;
    if (sa > a || sb > b) out.push({ aLo: a + 1, aHi: sa, bLo: b + 1, bHi: sb });
    a = sa + len;
    b = sb + len;
  }
  if (a < N || b < M) out.push({ aLo: a + 1, aHi: N, bLo: b + 1, bHi: M });
  return out;
}

/** Steps 1–2 under a D cap and an optional deadline: the hunks, null when D > cap, 'deadline' when the deadline expired. */
function diff(from: readonly Buffer[], to: readonly Buffer[], cap: number, deadline: Deadline | null): Hunk[] | null | 'deadline' {
  if (deadline !== null && deadline.expired()) return 'deadline';
  const { A, B } = intern(from, to);
  const w = trim(A, B);
  const prefix: Snake = [0, 0, w.p];
  const suffix: Snake = [w.p + w.n, w.p + w.m, A.length - w.p - w.n];
  if (disjoint(w)) return w.n + w.m > cap ? null : hunksOf(A.length, B.length, [prefix, suffix]);
  const checkpoints = new Map<number, Int32Array>();
  const D = forward(w, cap, deadline, checkpoints);
  if (D === null || D === 'deadline') return D;
  const middle = backtrack(w, D, checkpoints, deadline);
  if (middle === 'deadline') return 'deadline';
  return hunksOf(A.length, B.length, [prefix, ...middle, suffix]);
}

/** Steps 1–2: common prefix/suffix trimming, then Myers O(ND) with the greedy forward snake and leftmost tie-break; deterministic on every peer. */
export function hunks(from: readonly Buffer[], to: readonly Buffer[]): Hunk[] {
  return diff(from, to, Number.POSITIVE_INFINITY, null) as Hunk[];
}

/** D (04 §2): the minimal Myers edit distance in lines; null once it exceeds cap. */
export function editDistance(from: readonly Buffer[], to: readonly Buffer[], cap: number): number | null {
  const { A, B } = intern(from, to);
  const w = trim(A, B);
  if (disjoint(w)) return w.n + w.m > cap ? null : w.n + w.m;
  return forward(w, cap, null, null) as number | null;
}

/** Step 3 over a hunk list: images of unchanged lines ∪ b-sides of intersecting hunks ∪ pure insertions after k with lo ≤ k < hi (k == hi, k == lo−1 excluded); TOMBSTONE when every line is deleted and nothing is added.
 *  The union over every range is normalized; it is TOMBSTONE when it is empty (an empty range list maps to []). */
export function imageOf(hs: readonly Hunk[], ranges: Ranges): Ranges | 'TOMBSTONE' {
  if (ranges.length === 0) return [];
  const parts: Array<readonly [number, number]> = [];
  const unchanged = (from: number, to: number, lo: number, hi: number, delta: number): void => {
    const s = Math.max(from, lo);
    const e = Math.min(to, hi);
    if (s <= e) parts.push([s + delta, e + delta]);
  };
  for (const [lo, hi] of ranges) {
    if (lo > hi) continue;
    let next = 1;    // the first a-row of the current unchanged run
    let delta = 0;   // b-row − a-row on that run
    for (const h of hs) {
      unchanged(next, h.aLo - 1, lo, hi, delta);   // (a)
      const bSide = h.bLo <= h.bHi;
      if (h.aLo <= h.aHi) {
        if (bSide && h.aLo <= hi && lo <= h.aHi) parts.push([h.bLo, h.bHi]);   // (b)
      } else if (bSide && lo <= h.aHi && h.aHi < hi) {
        parts.push([h.bLo, h.bHi]);   // (c): a pure insertion after base line k = aHi
      }
      next = h.aHi + 1;
      delta = h.bHi - h.aHi;
    }
    unchanged(next, Number.POSITIVE_INFINITY, lo, hi, delta);   // (a), after the last hunk
  }
  const out = normalizeRanges(parts);
  return out.length === 0 ? 'TOMBSTONE' : out;
}

/** Steps 3–5 by one direct mapping (step 4): D > D_CAP → WHOLE_FILE in both modes; 'local' with an expired deadline → WHOLE_FILE; 'fold' has no time cap. */
export function mapRangesLines(from: readonly Buffer[], to: readonly Buffer[], ranges: Ranges, mode: 'fold'): MapResult;
export function mapRangesLines(from: readonly Buffer[], to: readonly Buffer[], ranges: Ranges, mode: 'local', deadline: Deadline): MapResult;
export function mapRangesLines(from: readonly Buffer[], to: readonly Buffer[], ranges: Ranges, mode: MapMode, deadline?: Deadline): MapResult {
  let live: Deadline | null = null;
  if (mode === 'local') {
    if (deadline === undefined) throw new TypeError('mapRangesLines: local mode needs a deadline');
    live = deadline;
  }
  const hs = diff(from, to, D_CAP, live);
  if (hs === null || hs === 'deadline') return 'WHOLE_FILE';
  const image = imageOf(hs, ranges);
  if (live !== null && live.expired()) return 'WHOLE_FILE';
  return image;
}
