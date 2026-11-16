// The one tree-sitter row helper (Plan 4 Task 4; REG-01, L-OFFSETS, 04 §3.2 item 2, extent-convention/1 step 3) and the
// incremental re-parse it feeds (R1-081, R4-14): rows are read only here, and an edit built by inputEdit gives the same
// tree as a cold parse in every form (LF, CRLF, BOM, astral and Hangul text).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Parser, Tree } from 'web-tree-sitter';
import type { Language } from '../../src/regions/types.js';
import { endRow, inputEdit, ownsRows, rowsOf } from '../../src/regions/worker/lineTable.js';
import { initParser, type ParserHost } from '../../src/regions/worker/parser.js';
import { testRegionRuntime, testWorkerInit } from '../helpers/regionRuntime.js';

const u8 = (s: string): Buffer => Buffer.from(s, 'utf8');
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

test('endRow is 1-based and drops a row when the column is 0 (extent-convention/1 step 3)', () => {
  assert.equal(endRow({ row: 9, column: 0 }), 9);
  assert.equal(endRow({ row: 9, column: 4 }), 10);
  assert.equal(endRow({ row: 0, column: 1 }), 1);
});

test('rowsOf gives [startPosition.row + 1, endRow(endPosition)], never an inverted range', () => {
  assert.deepEqual(rowsOf({ startPosition: { row: 4, column: 2 }, endPosition: { row: 8, column: 1 } }), [5, 9]);
  assert.deepEqual(rowsOf({ startPosition: { row: 0, column: 0 }, endPosition: { row: 25, column: 0 } }), [1, 25]);
  // a zero-width (MISSING) node at the start of a row is that one row
  assert.deepEqual(rowsOf({ startPosition: { row: 5, column: 0 }, endPosition: { row: 5, column: 0 } }), [6, 6]);
});

test('ownsRows: a node owns its rows when only whitespace shares its first and last row', () => {
  const rows = ['\u{feff}  # c', 'x = 1  # trailing', '    /* a', '       b */  ', '/* c */ y();'];
  const rowText = (r: number): string => rows[r - 1] ?? '';
  // row 1: BOM and indentation before the comment
  assert.equal(ownsRows({ startPosition: { row: 0, column: 3 }, endPosition: { row: 0, column: 6 } }, rowText), true);
  // row 2: code before the comment
  assert.equal(ownsRows({ startPosition: { row: 1, column: 7 }, endPosition: { row: 1, column: 17 } }, rowText), false);
  // rows 3-4: a block comment followed only by spaces
  assert.equal(ownsRows({ startPosition: { row: 2, column: 4 }, endPosition: { row: 3, column: 11 } }, rowText), true);
  // row 5: code after the comment
  assert.equal(ownsRows({ startPosition: { row: 4, column: 0 }, endPosition: { row: 4, column: 7 } }, rowText), false);
});

/** The old-tree argument of every Parser.parse call made while body runs (null for a cold parse). */
function spyOldTrees<T>(body: (olds: Array<Tree | null>) => T): T {
  const olds: Array<Tree | null> = [];
  const original = Parser.prototype.parse;
  Parser.prototype.parse = function (this: Parser, ...args: Parameters<Parser['parse']>): ReturnType<Parser['parse']> {
    olds.push(args[1] instanceof Tree ? args[1] : null);
    return original.apply(this, args);
  };
  try {
    return body(olds);
  } finally {
    Parser.prototype.parse = original;
  }
}

/** Parses `prev` cold under key 'prev', then `next` incrementally from it; returns both the incremental and a cold tree's S-expression. */
function both(host: ParserHost, lang: Language, prev: Buffer, next: Buffer, n: number): { inc: string; cold: string } {
  const first = host.parse(lang, prev, `prev-${n}`, null);
  assert.equal(typeof first, 'object');
  const edit = inputEdit(prev, next);
  assert.notEqual(edit, null);
  const t1 = spyOldTrees((olds) => {
    const t = host.parse(lang, next, `inc-${n}`, null, { key: `prev-${n}`, edit });
    assert.equal(olds.length, 1);
    assert.ok(olds[0] !== null, 'the re-parse starts from an edited copy of the live tree of prev');
    return t;
  });
  assert.equal(typeof t1, 'object');
  const inc = (t1 as Exclude<typeof t1, string>).rootNode.toString();
  const t2 = host.parse(lang, next, `cold-${n}`, null);
  const cold = (t2 as Exclude<typeof t2, string>).rootNode.toString();
  return { inc, cold };
}

test('inputEdit: an incremental re-parse equals a cold parse (UTF-16 units, BOM, CRLF, astral, Hangul)', async () => {
  const host = await initParser(testWorkerInit(await testRegionRuntime()));
  try {
    const py = 'import os\n\n\ndef f(a):\n    s = "\u{1F600}\u{ac00}"\n    return a\n\n\ndef g():\n    return 2\n';
    const cases: Array<[Language, Buffer, Buffer]> = [
      ['python', u8(py), u8(py.replace('return a', 'return a + 1'))],
      ['python', u8(py), u8(py.replace('    return 2\n', ''))],
      ['python', u8(py), u8(py.replace('\u{1F600}', '\u{1F601}\u{1F602}'))],
      ['python', u8(py), u8(py.replace('def g():', '# \u{d55c}\u{ae00}\ndef g():'))],
      ['python', Buffer.concat([BOM, u8(py.split('\n').join('\r\n'))]), Buffer.concat([BOM, u8(py.replace('return a', 'return (a').split('\n').join('\r\n'))])],
      ['python', u8(py), Buffer.concat([BOM, u8(py)])],
      ['javascript', u8('function f(a) {\n  return a;\n}\nconst h = () => 1;\n'), u8('function f(a) {\n  return [a, "\u{2028}"];\n}\nconst h = () => 1;\n')],
      ['c_sharp', u8('class A\n{\n    int F(int x) { return x; }\n}\n'), u8('class A\n{\n    int F(int x) { return x; }\n    int G() { return 1; }\n}\n')],
    ];
    cases.forEach(([lang, prev, next], i) => {
      const { inc, cold } = both(host, lang, prev, next, i);
      assert.equal(inc, cold, `case ${i} (${lang})`);
    });
    // the live tree of prev is left as it was (the edit went to a copy): parsing prev again from it changes nothing
    const py0 = u8(py);
    const py1 = u8(py.replace('return a', 'return a * 2'));
    host.parse('python', py0, 'prev-fresh', null);
    host.parse('python', py1, 'next-fresh', null, { key: 'prev-fresh', edit: inputEdit(py0, py1) });
    const again = spyOldTrees((olds) => {
      const t = host.parse('python', py0, 'prev-again', null, { key: 'prev-fresh', edit: inputEdit(py0, py0) });
      assert.ok(olds[0] !== null);
      return t;
    });
    const coldPrev = host.parse('python', py0, 'prev-cold', null);
    assert.equal((again as Exclude<typeof again, string>).rootNode.toString(), (coldPrev as Exclude<typeof coldPrev, string>).rootNode.toString());
    // an old key with no live tree parses cold
    spyOldTrees((olds) => {
      host.parse('python', py0, 'x', null, { key: 'never-parsed', edit: inputEdit(py0, py0) });
      assert.deepEqual(olds, [null]);
    });
    // identical bytes: a zero-length edit
    assert.notEqual(inputEdit(u8(py), u8(py)), null);
    // a side that is not UTF-8 has no edit (the caller parses cold)
    assert.equal(inputEdit(Buffer.from([0xb0, 0xa1, 0x0a]), u8('x\n')), null);
  } finally {
    host.dispose();
  }
});
