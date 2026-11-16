// The one touch predicate (Plan 4 Task 6; 04 §3.6 steps 1–6 and the paragraph after them, §3.3 extent-convention/1, REG-04,
// REG-13, REG-14, REG-17, R1-006, R1-044, R1-100…R1-107, R4-18, T-REG-02). touch is pure: hand-built hunks and tables for the
// step tests, the production 'table' handler (testTable) for the residue and block tables.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { isBlankRow, lineArray } from '../../src/regions/lines.js';
import { hunks, imageOf } from '../../src/regions/mapper.js';
import { touch, type TouchClaim, type TouchInput, type TouchReason } from '../../src/regions/touch.js';
import type { Hunk, NoTable, NoTableReason, Ranges, RegionTable, TableOrNone, Unit } from '../../src/regions/types.js';
import { fixture, s9Generator, type FixtureTouchReason } from '../helpers/regionFixtures.js';
import { testTable } from '../helpers/regionRuntime.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const OWN = 'a'.repeat(64);
const SYMBOL: TouchClaim = { granularity: 'symbol', regionSpec: OWN };
const noTable = (reason: NoTableReason): NoTable => ({ kind: 'NO_TABLE', reason, lineCount: null });
const BUDGET = noTable('budget');

/** A leaf unit with only what touch reads (ranges, leaf); the label is a block label. */
const leaf = (unitId: number, ranges: Ranges): Unit => ({
  unitId, kind: 'block', label: { kind: 'block', qualname: '', simple: '', type: '', disc: '' }, ranges, parentUnitId: null, leaf: true, residue: false, sigSlice: null, granularity: 'block',
});
const tableOf = (units: readonly Unit[], errorSpans: Ranges = [], lineCount = 300): RegionTable => ({
  grammar: null, regionSpec: OWN, decodable: true, lineCount, units, imports: null, errorSpans, errorCount: errorSpans.length, labelCounts: {},
});
const EMPTY = tableOf([]);

/** touch with inPost = imageOf([h], inBase) (the caller's image of the claim under the hunk list). */
function check(h: Hunk, inBase: Ranges, post: TableOrNone, o: { c?: TouchClaim; groupNameHit?: boolean } = {}): { touch: boolean; reason: TouchReason } {
  return touch(h, o.c ?? SYMBOL, { inBase, inPost: imageOf([h], inBase), post, groupNameHit: o.groupNameHit ?? false }, OWN);
}
const T = (reason: TouchReason): { touch: boolean; reason: TouchReason } => ({ touch: reason !== 'none', reason });

/** One-row pure insertion after base line k; a modification of rows lo..hi; a deletion of rows lo..hi. */
const insertAfter = (k: number, n = 1): Hunk => ({ aLo: k + 1, aHi: k, bLo: k + 1, bHi: k + n });
const modify = (lo: number, hi: number): Hunk => ({ aLo: lo, aHi: hi, bLo: lo, bHi: hi });
const remove = (lo: number, hi: number): Hunk => ({ aLo: lo, aHi: hi, bLo: lo, bHi: lo - 1 });

test('step 1: a foreign regionSpec, a WHOLE_FILE mapping or a file claim touches every hunk', () => {
  const claim: Ranges = [[300, 310]];
  const far = modify(100, 100);   // 200 rows away from the claim
  assert.deepEqual(check(far, claim, EMPTY, { c: { granularity: 'symbol', regionSpec: 'f'.repeat(64) } }), T('degraded-whole-file'));
  assert.deepEqual(touch(far, SYMBOL, { inBase: 'WHOLE_FILE', inPost: 'WHOLE_FILE', post: EMPTY, groupNameHit: false }, OWN), T('degraded-whole-file'));
  assert.deepEqual(check(far, claim, EMPTY, { c: { granularity: 'file', regionSpec: OWN } }), T('degraded-whole-file'));
  assert.deepEqual(check(far, claim, EMPTY), T('none'), 'own regionSpec, a mapped range, symbol: no touch');
  assert.deepEqual(check(far, claim, EMPTY, { c: { granularity: 'block', regionSpec: OWN } }), T('none'));
});

test('steps 2 and 3 on a 10-row base with claim [[4, 6]]', () => {
  const claim: Ranges = [[4, 6]];
  // post = NO_TABLE{budget}: a hunk that reached step 4 would answer boundary-no-table
  assert.deepEqual(check(modify(6, 6), claim, BUDGET), T('base-overlap'));
  assert.deepEqual(check(remove(3, 4), claim, BUDGET), T('base-overlap'));
  assert.deepEqual(check(insertAfter(4), claim, BUDGET), T('insert-inside'));
  assert.deepEqual(check(insertAfter(5), claim, BUDGET), T('insert-inside'));
  assert.deepEqual(check(insertAfter(6), claim, BUDGET), T('boundary-no-table'), 'k == hi is step 4');
  assert.deepEqual(check(insertAfter(3), claim, BUDGET), T('boundary-no-table'), 'k == lo - 1 is step 4');
  assert.deepEqual(check(insertAfter(7), claim, BUDGET), T('none'), 'k == hi + 1 is no step');
  assert.deepEqual(check(remove(1, 2), claim, BUDGET), T('none'));
  // a multi-range claim (a residue): each range has its own boundaries
  const residue: Ranges = [[2, 3], [8, 8]];
  assert.deepEqual(check(insertAfter(2), residue, BUDGET), T('insert-inside'));
  assert.deepEqual(check(insertAfter(8), residue, BUDGET), T('boundary-no-table'));
  assert.deepEqual(check(insertAfter(7), residue, BUDGET), T('boundary-no-table'));
  assert.deepEqual(check(insertAfter(5), residue, BUDGET), T('none'));
});

test('step 4 decides boundary insertions by extent, error span or missing table', async () => {
  const claim: Ranges = [[4, 6]];
  const after6 = insertAfter(6);   // post row 7
  assert.deepEqual(check(after6, claim, tableOf([leaf(1, [[1, 2]]), leaf(2, [[4, 7]])])), T('boundary-in-extent'));
  assert.deepEqual(check(after6, claim, tableOf([leaf(2, [[4, 6]])], [[7, 7]])), T('boundary-in-error'));
  for (const reason of ['budget', 'conflict_markers', 'binary', 'special', 'grammarless_small'] as const) {
    assert.deepEqual(check(after6, claim, noTable(reason)), T('boundary-no-table'), reason);
  }
  assert.deepEqual(check(after6, claim, tableOf([leaf(2, [[4, 6]])])), T('none'), 'outside the extent, no error, a table');
  // the extent is the leaf unit containing the claim's image, never a neighbour's (row 7 is the next unit's attached comment)
  assert.deepEqual(check(after6, claim, tableOf([leaf(2, [[4, 6]]), leaf(3, [[7, 9]])])), T('none'));
  // an error span elsewhere decides nothing
  assert.deepEqual(check(after6, claim, tableOf([leaf(2, [[4, 6]])], [[1, 1], [9, 9]])), T('none'));
  // one inserted row of several inside the extent is enough (the hunk extends the claimed unit)
  assert.deepEqual(check(insertAfter(6, 3), claim, tableOf([leaf(2, [[4, 7]]), leaf(3, [[9, 9]])])), T('boundary-in-extent'));
  // a WHOLE_FILE image cannot place the claim in post: P2 touch; a TOMBSTONE image has no extent
  const ws = touch(after6, SYMBOL, { inBase: claim, inPost: 'WHOLE_FILE', post: tableOf([leaf(2, [[4, 6]])]), groupNameHit: false }, OWN);
  assert.deepEqual(ws, T('degraded-whole-file'));
  const tomb = touch(after6, SYMBOL, { inBase: claim, inPost: 'TOMBSTONE', post: tableOf([leaf(2, [[4, 7]])]), groupNameHit: false }, OWN);
  assert.deepEqual(tomb, T('none'));

  // a block claim on special/big.md (class 6): rows 5-8 are one blank-line block, row 9 is empty
  const big = fixture('special/big.md');
  const baseTable = await testTable('special/big.md', big);
  const block = baseTable.units.find((u) => u.ranges[0]?.[0] === 5);
  assert.deepEqual(block?.ranges, [[5, 8]]);
  assert.ok(isBlankRow(lineArray(big)[8] as Buffer, 9), 'row 9 is empty');
  const BLOCK: TouchClaim = { granularity: 'block', regionSpec: OWN };
  for (const [after, expect] of [[8, 'boundary-in-extent'], [9, 'none']] as const) {
    const lines = big.toString('utf8').split('\n');
    lines.splice(after, 0, 'Paragraph 1 line three.');
    const post = Buffer.from(lines.join('\n'), 'utf8');
    const hs = hunks(lineArray(big), lineArray(post));
    assert.deepEqual(hs, [insertAfter(after)]);
    const inp: TouchInput = { inBase: [[5, 8]], inPost: imageOf(hs, [[5, 8]]), post: await testTable('special/big.md', post), groupNameHit: false };
    assert.deepEqual(touch(hs[0] as Hunk, BLOCK, inp, OWN), T(expect), `a row inserted after row ${after}`);
  }
});

/** Copied row for row from Task 4's test/unit/tables.python.test.ts (PY25_ROWS, "Python units, residue, consts, gap blocks and
 *  <imports>"; ruling PF-9: a test file is never imported). Row numbers: imports 1-2, f 4-9, C 11-20 (x = 1, blank 13, getter
 *  14-16, blank 17, setter 18-20), blank 21, NAME 22, total 23, two statements 24-25. */
const PY25_ROWS: readonly string[] = [
  'import os',
  'from typing import Any',
  '',
  '# Compute things.',
  '@decorator',
  'def f(a, b=1):',
  '    def inner():',
  '        return a',
  '    return inner()',
  '',
  'class C(Base):',
  '    x = 1',
  '',
  '    @property',
  '    def v(self):',
  '        return self._v',
  '',
  '    @v.setter',
  '    def v(self, value):',
  '        self._v = value',
  '',
  'NAME = compute()',
  'total: int = 0',
  'print("side effect")',
  'print("more")',
];
const py25 = (rows: readonly string[]): Buffer => Buffer.from(`${rows.join('\n')}\n`, 'utf8');

test('a modify hunk on a blank residue row touches the residue claim', async () => {
  const base = py25(PY25_ROWS);
  const baseTable = await testTable('m.py', base);
  const residue = baseTable.units.find((u) => u.residue && u.label.qualname === 'C');
  assert.deepEqual(residue?.ranges, [[11, 13], [17, 17]], "C's residue (Task 4's table, R4-18)");
  const baseRows = lineArray(base);
  for (const r of [13, 17, 21]) assert.ok(isBlankRow(baseRows[r - 1] as Buffer, r), `row ${r} is blank`);
  const inBase = residue?.ranges as Ranges;
  for (const [row, text, expect] of [[13, '    z = 3', 'base-overlap'], [17, '    z = 3', 'base-overlap'], [21, 'y = 2', 'none']] as const) {
    const rows = [...PY25_ROWS];
    rows[row - 1] = text;
    const post = py25(rows);
    const hs = hunks(baseRows, lineArray(post));
    assert.deepEqual(hs, [modify(row, row)], `row ${row}`);
    const inp: TouchInput = { inBase, inPost: imageOf(hs, inBase), post: await testTable('m.py', post), groupNameHit: false };
    assert.deepEqual(touch(hs[0] as Hunk, SYMBOL, inp, OWN), T(expect), `row ${row} replaced by ${text}`);
  }
});

test('step 5: a group-name hit touches with no range overlap; steps run in order', () => {
  const claim: Ranges = [[300, 310]];
  assert.deepEqual(check(modify(100, 100), claim, EMPTY, { groupNameHit: true }), T('group-name'));
  assert.deepEqual(check(insertAfter(500), claim, EMPTY, { groupNameHit: true }), T('group-name'));
  assert.deepEqual(check(modify(305, 305), claim, EMPTY, { groupNameHit: true }), T('base-overlap'), 'the first matching step wins');
  assert.deepEqual(check(insertAfter(305), claim, BUDGET, { groupNameHit: true }), T('insert-inside'));
  assert.deepEqual(check(insertAfter(310), claim, BUDGET, { groupNameHit: true }), T('boundary-no-table'));
  assert.deepEqual(check(modify(100, 100), claim, EMPTY, { groupNameHit: false }), T('none'));
});

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** The repo-relative modules a source file imports (import and export-from declarations). */
function importsOf(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(join(REPO, file), 'utf8'), ts.ScriptTarget.ES2022, true);
  return sf.statements.flatMap((s) => ((ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) && s.moduleSpecifier !== undefined && ts.isStringLiteral(s.moduleSpecifier) ? [s.moduleSpecifier.text] : []));
}

const LABEL_READS: ReadonlySet<string> = new Set(['label', 'qualname', 'simple', 'disc', 'labelCounts', 'labelKey', 'Label', 'LabelKey']);

test('touch takes no registry, own-claim or label input', () => {
  const claimKeys: Exact<keyof TouchClaim, 'granularity' | 'regionSpec'> = true;
  const inputKeys: Exact<keyof TouchInput, 'inBase' | 'inPost' | 'post' | 'groupNameHit'> = true;
  assert.ok(claimKeys && inputKeys);
  for (const file of ['src/regions/touch.ts', 'src/regions/contained.ts']) {
    for (const m of importsOf(file)) {
      assert.doesNotMatch(m, /(^|\/)(board|holds|claims|engine)(\/|$)/, `${file} imports ${m}`);
      assert.ok(m.startsWith('./'), `${file} imports only from src/regions: ${m}`);
    }
    // every identifier in the code (comments are not nodes): no Label field and no label helper is read
    const sf = ts.createSourceFile(file, readFileSync(join(REPO, file), 'utf8'), ts.ScriptTarget.ES2022, true);
    const seen: string[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && LABEL_READS.has(n.text)) seen.push(n.text);
      if (ts.isStringLiteral(n) && LABEL_READS.has(n.text)) seen.push(n.text);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    assert.deepEqual(seen, [], `${file} reads no label`);
  }
});

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Every exported name of a module (declarations with an export modifier and export { … } specifiers). */
function exportedNames(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const exported = (s: ts.Statement): boolean => ts.canHaveModifiers(s) && (ts.getModifiers(s) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  for (const s of sf.statements) {
    if (ts.isExportDeclaration(s) && s.exportClause !== undefined && ts.isNamedExports(s.exportClause)) {
      for (const e of s.exportClause.elements) out.push(e.name.text);
    } else if (exported(s)) {
      if (ts.isVariableStatement(s)) {
        for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name)) out.push(d.name.text);
      } else if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s) || ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s) || ts.isEnumDeclaration(s)) && s.name !== undefined) {
        out.push(s.name.text);
      }
    }
  }
  return out;
}

test('touch is the one exported touch decision', () => {
  const found: string[] = [];
  for (const full of walk(join(REPO, 'src'))) {
    const file = relative(REPO, full).split('\\').join('/');
    const sf = ts.createSourceFile(file, readFileSync(full, 'utf8'), ts.ScriptTarget.ES2022, true);
    for (const name of exportedNames(sf)) if (/^(touch|touches|touchesClaim|isTouch\w*)$/.test(name)) found.push(`${file}:${name}`);
  }
  assert.deepEqual(found, ['src/regions/touch.ts:touch']);

  const all: Record<TouchReason, true> = {
    'base-overlap': true, 'insert-inside': true, 'boundary-in-extent': true, 'boundary-in-error': true, 'boundary-no-table': true,
    'group-name': true, 'degraded-whole-file': true, none: true,
  };
  assert.equal(Object.keys(all).length, 8);
  const eight: Exact<TouchReason, 'base-overlap' | 'insert-inside' | 'boundary-in-extent' | 'boundary-in-error' | 'boundary-no-table' | 'group-name' | 'degraded-whole-file' | 'none'> = true;
  const fixtureReasons: Exact<FixtureTouchReason, TouchReason> = true;
  type Oracle = ReturnType<typeof s9Generator> extends Iterable<infer S> ? S extends { readonly oracle: infer O } ? O : never : never;
  const oracleIsRanges: Oracle extends Ranges ? true : false = true;
  assert.ok(eight && fixtureReasons && oracleIsRanges);
  for (const m of importsOf('test/helpers/regionFixtures.ts')) assert.doesNotMatch(m, /src\/regions/, `Task 2's fixtures import nothing from src/regions: ${m}`);
});
