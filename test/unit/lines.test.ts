// Region line arrays, the strict read-only decode, blank rows and the closed-interval range helpers
// (04-regions §3.2, §3.4 step 3; REG-01; rulings R4-18; Plan 4 Task 3's first commit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as fc from 'fast-check';
import { rows } from '../../src/data/rows.js';
import { decodeStrict, isBlankRow, lineArray, normalizeRanges, rangesIntersect } from '../../src/regions/lines.js';
import { lintSource } from '../../tools/lint/rules.js';

const bytes = (...xs: number[]): Buffer => Buffer.from(xs);
const latin = (s: string): Buffer => Buffer.from(s, 'latin1');
const hex = (rs: readonly Buffer[]): string[] => rs.map((r) => r.toString('hex'));

test('lineArray splits on 0x0A only', () => {
  // a\r\n  b<U+2028>c\n  d — U+2028 (E2 80 A8) stays inside row 2.
  const blob = Buffer.concat([latin('a\r\nb'), bytes(0xe2, 0x80, 0xa8), latin('c\nd')]);
  assert.deepEqual(hex(lineArray(blob)), [
    latin('a\r\n').toString('hex'),
    Buffer.concat([latin('b'), bytes(0xe2, 0x80, 0xa8), latin('c\n')]).toString('hex'),
    latin('d').toString('hex'),
  ]);
  // A lone CR splits nothing.
  assert.deepEqual(hex(lineArray(latin('x\ry\rz'))), [latin('x\ry\rz').toString('hex')]);
  // The BOM stays in row 1.
  const bom = Buffer.concat([bytes(0xef, 0xbb, 0xbf), latin('x\ny\n')]);
  assert.deepEqual(hex(lineArray(bom)), [Buffer.concat([bytes(0xef, 0xbb, 0xbf), latin('x\n')]).toString('hex'), latin('y\n').toString('hex')]);
  assert.deepEqual(lineArray(Buffer.alloc(0)), []);
  assert.deepEqual(hex(lineArray(latin('x\n'))), [latin('x\n').toString('hex')]);

  // One helper, never copied: lineArray is Plan 2's rows itself.
  assert.equal(lineArray, rows);
  const piece = fc.oneof(
    { weight: 3, arbitrary: fc.constant(bytes(0x0a)) },
    { weight: 2, arbitrary: fc.constant(bytes(0x0d)) },
    { weight: 1, arbitrary: fc.constant(bytes(0xe2, 0x80, 0xa8)) },
    { weight: 1, arbitrary: fc.constant(bytes(0xef, 0xbb, 0xbf)) },
    { weight: 3, arbitrary: fc.uint8Array({ minLength: 1, maxLength: 4 }).map((u) => Buffer.from(u)) },
  );
  fc.assert(
    fc.property(fc.array(piece, { maxLength: 40 }), (pieces) => {
      const blob = Buffer.concat(pieces);
      assert.deepEqual(hex(lineArray(blob)), hex(rows(blob)));
      assert.ok(Buffer.concat(lineArray(blob)).equals(blob));
    }),
    { numRuns: 1_000, seed: 3_001 },
  );
});

test('decodeStrict is fatal, keeps a BOM character and never encodes', () => {
  assert.equal(decodeStrict(latin('a\n')), 'a\n');
  assert.equal(decodeStrict(bytes(0xef, 0xbb, 0xbf, 0x78)), '\u{FEFF}x');
  assert.equal(decodeStrict(Buffer.alloc(0)), '');
  // cp949 가 (B0 A1), a lone continuation byte, the overlong NUL and a UTF-16 surrogate are not UTF-8.
  assert.equal(decodeStrict(bytes(0xb0, 0xa1)), null);
  assert.equal(decodeStrict(bytes(0x80)), null);
  assert.equal(decodeStrict(bytes(0xc0, 0x80)), null);
  assert.equal(decodeStrict(bytes(0xed, 0xa0, 0x80)), null);
  // Hangul and an astral emoji decode.
  assert.equal(decodeStrict(bytes(0xed, 0x95, 0x9c, 0xf0, 0x9f, 0x98, 0x80)), '\u{D55C}\u{1F600}');
  // src/regions/lines.ts passes L-UTF8-WRITE (and every other rule).
  const file = 'src/regions/lines.ts';
  const text = readFileSync(new URL('../../src/regions/lines.ts', import.meta.url), 'utf8');
  assert.deepEqual(lintSource(file, text), []);
});

test('isBlankRow is a byte test', () => {
  for (const [row, n] of [
    [latin('\n'), 2],
    [latin('\r\n'), 2],
    [latin(' \t\r\n'), 2],
    [latin('\t\n'), 2],
    [latin('  '), 2],
    [latin(''), 2],
    [bytes(0xef, 0xbb, 0xbf, 0x0d, 0x0a), 1],
    [bytes(0xef, 0xbb, 0xbf), 1],
    [latin('\n'), 1],
  ] as const) {
    assert.equal(isBlankRow(row, n), true, `${row.toString('hex')} as row ${n} is blank`);
  }
  for (const [row, n] of [
    [latin(' x\n'), 2],
    [latin('\f\n'), 2],
    [bytes(0xc2, 0xa0, 0x0a), 2],
    [bytes(0xb0, 0xa1, 0x0a), 2],
    [bytes(0xef, 0xbb, 0xbf, 0x0a), 2],
    [latin('\r\r\n'), 2],
  ] as const) {
    assert.equal(isBlankRow(row, n), false, `${row.toString('hex')} as row ${n} is not blank`);
  }
  // One trailing CR is removed, a lone CR without its LF too (an unterminated last row).
  assert.equal(isBlankRow(latin('  \r'), 3), true);
});

test('normalizeRanges and rangesIntersect use closed integer intervals', () => {
  assert.deepEqual(normalizeRanges([[5, 6], [1, 2], [3, 4]]), [[1, 6]]);
  assert.deepEqual(normalizeRanges([[1, 3], [2, 2]]), [[1, 3]]);
  assert.deepEqual(normalizeRanges([[3, 2]]), []);
  assert.deepEqual(normalizeRanges([]), []);
  assert.deepEqual(normalizeRanges([[7, 9], [1, 2], [4, 4], [3, 2]]), [[1, 2], [4, 4], [7, 9]]);
  assert.deepEqual(normalizeRanges([[1, 10], [2, 3], [11, 11]]), [[1, 11]]);

  assert.equal(rangesIntersect([[1, 3]], [[3, 5]]), true);
  assert.equal(rangesIntersect([[1, 3]], [[4, 5]]), false);
  assert.equal(rangesIntersect([], [[1, 1]]), false);
  assert.equal(rangesIntersect([[1, 1]], []), false);
  assert.equal(rangesIntersect([[1, 2], [8, 9]], [[3, 7]]), false);
  assert.equal(rangesIntersect([[1, 2], [8, 9]], [[3, 8]]), true);
  assert.equal(rangesIntersect([[5, 5]], [[1, 2], [5, 6]]), true);
});
