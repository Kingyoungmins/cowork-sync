import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import * as fc from 'fast-check';
import { matchedRows } from '../../src/data/linediff.js';
import { stripEnding } from '../../src/data/rows.js';

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
