import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import * as fc from 'fast-check';
import { commonRowEnds, internRows, matchedRows } from '../../src/data/linediff.js';
import { rows, stripEnding } from '../../src/data/rows.js';

const key = (r: Buffer): string => stripEnding(r).toString('latin1');

/** Quadratic LCS length over rows compared with endings ignored (the oracle). */
function lcsLength(a: readonly Buffer[], b: readonly Buffer[]): number {
  const ka = a.map(key);
  const kb = b.map(key);
  let prev = new Array<number>(kb.length + 1).fill(0);
  for (let i = 1; i <= ka.length; i++) {
    const cur = new Array<number>(kb.length + 1).fill(0);
    for (let j = 1; j <= kb.length; j++) {
      cur[j] = ka[i - 1] === kb[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    prev = cur;
  }
  return prev[kb.length]!;
}

/** The pairs are a common subsequence: strictly increasing on both sides, rows equal ignoring endings. */
function assertCommonSubsequence(a: readonly Buffer[], b: readonly Buffer[], pairs: Array<[number, number]>): void {
  let pi = -1;
  let pj = -1;
  for (const [i, j] of pairs) {
    assert.ok(Number.isInteger(i) && Number.isInteger(j), 'integer indexes');
    assert.ok(i > pi && j > pj, `pairs strictly increasing at [${i}, ${j}]`);
    assert.ok(i < a.length && j < b.length, 'pairs in range');
    assert.equal(key(a[i]!), key(b[j]!), `a[${i}] and b[${j}] equal ignoring endings`);
    pi = i;
    pj = j;
  }
}

const row = fc
  .tuple(fc.constantFrom('', 'a', 'b', 'c', 'x\r', '#'), fc.constantFrom('\n', '\r\n', ''))
  .map(([c, e]) => Buffer.from(c + e, 'latin1'));

test('matchedRows equals a longest common subsequence of rows with endings ignored', () => {
  // Fixed cases.
  const r = (...xs: string[]): Buffer[] => xs.map((x) => Buffer.from(x, 'latin1'));
  assert.deepEqual(matchedRows([], []), []);
  assert.deepEqual(matchedRows(r('a\n'), []), []);
  assert.deepEqual(matchedRows([], r('a\n')), []);
  assert.deepEqual(matchedRows(r('a\n', 'b\n'), r('a\r\n', 'b')), [[0, 0], [1, 1]], 'endings are ignored');
  assert.deepEqual(matchedRows(r('a\n', 'b\n', 'c\n'), r('a\n', 'x\n', 'c\n')), [[0, 0], [2, 2]]);
  assert.deepEqual(matchedRows(r('a\n'), r('b\n')), []);
  // Only the ending is stripped: 'x\r\r\n' is 'x\r', not 'x'.
  assert.deepEqual(matchedRows(r('x\r\r\n'), r('x\n')), []);

  // Small alphabets force many equal rows and many alternative alignments.
  fc.assert(
    fc.property(fc.array(row, { maxLength: 40 }), fc.array(row, { maxLength: 40 }), (a, b) => {
      const pairs = matchedRows(a, b);
      assertCommonSubsequence(a, b, pairs);
      assert.equal(pairs.length, lcsLength(a, b));
    }),
    { numRuns: 600, seed: 20261006 },
  );
  // Longer inputs with edits of a shared base reach the divide-and-conquer split repeatedly.
  fc.assert(
    fc.property(
      fc.array(row, { minLength: 50, maxLength: 300 }),
      fc.array(fc.tuple(fc.nat(), fc.nat({ max: 3 }), row), { maxLength: 30 }),
      (base, edits) => {
        const next = [...base];
        for (const [pos, op, rw] of edits) {
          const at = next.length === 0 ? 0 : pos % next.length;
          if (op === 0) next.splice(at, 1);
          else if (op === 1) next.splice(at, 0, rw);
          else next[at] = rw;
        }
        const pairs = matchedRows(base, next);
        assertCommonSubsequence(base, next, pairs);
        assert.equal(pairs.length, lcsLength(base, next));
      },
    ),
    { numRuns: 150, seed: 7 },
  );

  // Fixture-sized input (26k rows) with a few edits finishes quickly and keeps every unedited row.
  const big = Array.from({ length: 26_436 }, (_, i) => Buffer.from(`line ${i}\r\n`, 'latin1'));
  const edited = big.map((x) => Buffer.from(x.toString('latin1').replace('\r\n', '\n'), 'latin1'));
  edited[100] = Buffer.from('changed\n', 'latin1');
  edited.splice(20_000, 0, Buffer.from('inserted\n', 'latin1'));
  edited.splice(5, 1);
  const pairs = matchedRows(big, edited);
  assertCommonSubsequence(big, edited, pairs);
  assert.equal(pairs.length, big.length - 2);
});

// The shared pieces of the row diff (Plan 3 Task 7 fix round 2, Global Constraint "Shared helpers, never copied"): the row
// interning matchedRows and the churn guard's rewrittenRatio both use, and the common leading/trailing rows of two blobs.

test('internRows gives two rows one id exactly when they are equal with endings ignored, ids dense from 0 over both lists', () => {
  const r = (...xs: string[]): Buffer[] => xs.map((x) => Buffer.from(x, 'latin1'));
  const { A, B, alphabet } = internRows(r('a\n', 'b\r\n', 'a', 'x\r\r\n'), r('b\n', 'c\n', 'a\r\n', 'x\r\n'));
  assert.deepEqual([...A], [0, 1, 0, 2]);
  assert.deepEqual([...B], [1, 3, 0, 4], "'x\\r\\r\\n' is 'x\\r', not 'x'");
  assert.equal(alphabet, 5);
  const empty = internRows([], []);
  assert.deepEqual([empty.A.length, empty.B.length, empty.alphabet], [0, 0, 0]);
});

/** The oracle of commonRowEnds: the common leading rows, then the common trailing rows of what is left, over rows(). */
function endsOracle(a: Buffer, b: Buffer): { aStart: number; aEnd: number; bStart: number; bEnd: number; rows: number } {
  const ra = rows(a);
  const rb = rows(b);
  let pre = 0;
  while (pre < ra.length && pre < rb.length && key(ra[pre]!) === key(rb[pre]!)) pre++;
  let suf = 0;
  while (suf < ra.length - pre && suf < rb.length - pre && key(ra[ra.length - 1 - suf]!) === key(rb[rb.length - 1 - suf]!)) suf++;
  const bytes = (rs: Buffer[]): number => rs.reduce((s, x) => s + x.length, 0);
  return {
    aStart: bytes(ra.slice(0, pre)), aEnd: a.length - bytes(ra.slice(ra.length - suf)),
    bStart: bytes(rb.slice(0, pre)), bEnd: b.length - bytes(rb.slice(rb.length - suf)), rows: pre + suf,
  };
}

test('commonRowEnds finds the common leading and trailing rows of two blobs with endings ignored, as byte offsets of whole rows', () => {
  const b = (s: string): Buffer => Buffer.from(s, 'latin1');
  assert.deepEqual(commonRowEnds(b(''), b('')), { aStart: 0, aEnd: 0, bStart: 0, bEnd: 0, rows: 0 });
  assert.deepEqual(commonRowEnds(b('a\nb\n'), b('a\r\nb')), { aStart: 4, aEnd: 4, bStart: 4, bEnd: 4, rows: 2 }, 'endings are ignored');
  assert.deepEqual(commonRowEnds(b('a\nx\nc\n'), b('a\ny\ny\nc\n')), { aStart: 2, aEnd: 4, bStart: 2, bEnd: 6, rows: 2 });
  assert.deepEqual(commonRowEnds(b('x\n'), b('x\nx\n')), { aStart: 2, aEnd: 2, bStart: 2, bEnd: 4, rows: 1 }, 'the trailing rows never overlap the leading ones');
  assert.deepEqual(commonRowEnds(b('x\r\r\n'), b('x\n')), { aStart: 0, aEnd: 4, bStart: 0, bEnd: 2, rows: 0 }, "'x\\r\\r\\n' is 'x\\r'");
  fc.assert(
    fc.property(
      fc.array(row, { maxLength: 40 }),
      fc.array(fc.tuple(fc.nat(), fc.nat({ max: 3 }), row), { maxLength: 6 }),
      (base, edits) => {
        const next = [...base];
        for (const [pos, op, rw] of edits) {
          const at = next.length === 0 ? 0 : pos % next.length;
          if (op === 0) next.splice(at, 1);
          else if (op === 1) next.splice(at, 0, rw);
          else if (op === 2) next[at] = rw;
          else if (next.length > 0) next[at] = Buffer.from(next[at]!.toString('latin1').replace(/\r?\n$/, (e) => (e === '\n' ? '\r\n' : '\n')), 'latin1');
        }
        const a = Buffer.concat(base);
        const n = Buffer.concat(next);
        assert.deepEqual(commonRowEnds(a, n), endsOracle(a, n));
      },
    ),
    { numRuns: 600, seed: 20261009 },
  );
});
