// Myers row diff with endings ignored (03-data D1 step 3, the MIXED matched-row check).
// Rows are interned to integers by their content without the ending, the common prefix and suffix
// are matched directly, and the middle is split at a point of an optimal path by the linear-space
// bisection of Myers' "An O(ND) Difference Algorithm" §4b (the diff-match-patch form), so memory is
// O(N + M) and a fixture-sized file with a few edits costs a few passes over its rows.
import { stripEnding } from './rows.js';

/** Myers diff of two row lists compared with endings ignored; the matched index pairs in order. Pure. */
export function matchedRows(a: readonly Buffer[], b: readonly Buffer[]): Array<[number, number]> {
  const ids = new Map<string, number>();
  const intern = (row: Buffer): number => {
    const key = stripEnding(row).toString('latin1');
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
    }
    return id;
  };
  const A = Int32Array.from(a, intern);
  const B = Int32Array.from(b, intern);
  const out: Array<[number, number]> = [];
  diffRange(A, B, 0, A.length, 0, B.length, out);
  return out;
}

/** Appends the matched pairs of A[aLo..aHi) x B[bLo..bHi) to out, in order. */
function diffRange(A: Int32Array, B: Int32Array, aLo: number, aHi: number, bLo: number, bHi: number, out: Array<[number, number]>): void {
  while (aLo < aHi && bLo < bHi && A[aLo] === B[bLo]) {
    out.push([aLo, bLo]);
    aLo++;
    bLo++;
  }
  let sa = aHi;
  let sb = bHi;
  while (sa > aLo && sb > bLo && A[sa - 1] === B[sb - 1]) {
    sa--;
    sb--;
  }
  if (aLo < sa && bLo < sb) {
    const split = bisect(A, B, aLo, sa, bLo, sb);
    if (split !== null) {
      const [x, y] = split;
      if ((x === aLo && y === bLo) || (x === sa && y === sb)) throw new Error('matchedRows: degenerate split');
      diffRange(A, B, aLo, x, bLo, y, out);
      diffRange(A, B, x, sa, y, sb, out);
    }
  }
  for (let k = 0; k < aHi - sa; k++) out.push([sa + k, sb + k]);
}

/**
 * The end of the forward snake where the forward and backward furthest-reaching D-paths meet:
 * a point on an optimal edit path. null when the ranges share no row. Both ranges are non-empty,
 * with different first rows and different last rows.
 */
function bisect(A: Int32Array, B: Int32Array, aLo: number, aHi: number, bLo: number, bHi: number): [number, number] | null {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const maxD = Math.ceil((n + m) / 2);
  const off = maxD;
  const len = 2 * maxD;
  const v1 = new Int32Array(len).fill(-1);
  const v2 = new Int32Array(len).fill(-1);
  v1[off + 1] = 0;
  v2[off + 1] = 0;
  const delta = n - m;
  // With an odd delta the paths meet while extending forward, with an even one while extending backward.
  const front = delta % 2 !== 0;
  // Diagonals that ran off the edit graph are skipped in later rounds.
  let k1start = 0;
  let k1end = 0;
  let k2start = 0;
  let k2end = 0;
  for (let d = 0; d < maxD; d++) {
    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      const k1o = off + k1;
      let x1 = k1 === -d || (k1 !== d && v1[k1o - 1]! < v1[k1o + 1]!) ? v1[k1o + 1]! : v1[k1o - 1]! + 1;
      let y1 = x1 - k1;
      while (x1 < n && y1 < m && A[aLo + x1] === B[bLo + y1]) {
        x1++;
        y1++;
      }
      v1[k1o] = x1;
      if (x1 > n) {
        k1end += 2;
      } else if (y1 > m) {
        k1start += 2;
      } else if (front) {
        const k2o = off + delta - k1;
        if (k2o >= 0 && k2o < len && v2[k2o] !== -1) {
          // The backward path on this diagonal, mirrored into forward coordinates.
          if (x1 >= n - v2[k2o]!) return [aLo + x1, bLo + y1];
        }
      }
    }
    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      const k2o = off + k2;
      let x2 = k2 === -d || (k2 !== d && v2[k2o - 1]! < v2[k2o + 1]!) ? v2[k2o + 1]! : v2[k2o - 1]! + 1;
      let y2 = x2 - k2;
      while (x2 < n && y2 < m && A[aLo + n - x2 - 1] === B[bLo + m - y2 - 1]) {
        x2++;
        y2++;
      }
      v2[k2o] = x2;
      if (x2 > n) {
        k2end += 2;
      } else if (y2 > m) {
        k2start += 2;
      } else if (!front) {
        const k1o = off + delta - k2;
        if (k1o >= 0 && k1o < len && v1[k1o] !== -1) {
          const x1 = v1[k1o]!;
          const y1 = x1 - (k1o - off);
          if (x1 >= n - x2) return [aLo + x1, bLo + y1];
        }
      }
    }
  }
  return null;
}
