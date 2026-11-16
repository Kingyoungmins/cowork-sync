// Python region tables (Plan 4 Task 4; 04 §3.3 "Units per language", extent-convention/1, label-convention/1, §3.13 <imports>;
// REG-05, REG-16, R1-075, R1-076, R1-079, R1-002, R2-B02, R4-18, R4-19, OQ-16, OQ-31, R1-034). Real grammar, real query:
// the production 'table' job handler on the calling thread (testTable).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelKey, type Label, type ParamSlice, type SigSlice } from '../../src/regions/types.js';
import { testTable, withoutSigSlice, type UnitShape } from '../helpers/regionRuntime.js';

/** The 25-row Python file of "Python units, residue, consts, gap blocks and <imports>" (ruling PF-9: Task 6 copies it row for
 *  row into test/unit/touch.test.ts). Row numbers: imports 1-2, f 4-9 (comment, decorator, def, nested inner), C 11-20
 *  (x = 1, blank 13, getter 14-16, blank 17, setter 18-20), blank 21, NAME 22, total 23, two statements 24-25. */
export const PY25_ROWS: readonly string[] = [
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

const PY25 = Buffer.from(`${PY25_ROWS.join('\n')}\n`, 'utf8');
const L = (kind: string, qualname: string, simple: string, type = '', disc = ''): Label => ({ kind, qualname, simple, type, disc });
const BLOCK = L('block', '', '');

test('Python units, residue, consts, gap blocks and <imports>', async () => {
  assert.equal(PY25_ROWS.length, 25);
  const t = await testTable('m.py', PY25);
  assert.equal(t.grammar, 'python');
  assert.equal(t.decodable, true);
  assert.equal(t.lineCount, 25);
  assert.deepEqual(t.imports, [1, 2]);
  const expected: UnitShape[] = [
    { unitId: 1, kind: 'function', label: L('function', 'f', 'f'), ranges: [[4, 9]], parentUnitId: null, leaf: true, residue: false, granularity: 'symbol' },
    { unitId: 2, kind: 'class', label: L('class', 'C', 'C'), ranges: [[11, 20]], parentUnitId: null, leaf: false, residue: false, granularity: 'symbol' },
    { unitId: 3, kind: 'class', label: L('class', 'C', 'C'), ranges: [[11, 13], [17, 17]], parentUnitId: 2, leaf: true, residue: true, granularity: 'symbol' },
    { unitId: 4, kind: 'method', label: L('method', 'C.v', 'v', 'C', ''), ranges: [[14, 16]], parentUnitId: 2, leaf: true, residue: false, granularity: 'symbol' },
    { unitId: 5, kind: 'method', label: L('method', 'C.v', 'v', 'C', 'setter'), ranges: [[18, 20]], parentUnitId: 2, leaf: true, residue: false, granularity: 'symbol' },
    { unitId: 6, kind: 'const', label: L('const', 'NAME', 'NAME'), ranges: [[22, 22]], parentUnitId: null, leaf: true, residue: false, granularity: 'symbol' },
    { unitId: 7, kind: 'const', label: L('const', 'total', 'total'), ranges: [[23, 23]], parentUnitId: null, leaf: true, residue: false, granularity: 'symbol' },
    { unitId: 8, kind: 'block', label: BLOCK, ranges: [[24, 25]], parentUnitId: null, leaf: true, residue: false, granularity: 'block' },
  ];
  assert.deepEqual(withoutSigSlice(t.units), expected);
  assert.deepEqual(t.errorSpans, []);
  assert.equal(t.errorCount, 0);
  // one key per symbol leaf unit, each counted once; blocks are not counted (R4-19: a block label is four empty fields)
  const symbolLeaves = expected.filter((u) => u.leaf && u.granularity === 'symbol');
  assert.deepEqual(t.labelCounts, Object.fromEntries(symbolLeaves.map((u) => [labelKey(u.label), 1])));
  assert.equal(Object.keys(t.labelCounts).length, 6);
});

test('sigSlice is filled on every symbol unit (Task 7, ruling PF-7)', async () => {
  const t = await testTable('m.py', PY25);
  const pos = (name: string, dflt?: string): ParamSlice => ({ name, kind: 'pos', hasDefault: dflt !== undefined, destructured: null, type: null, ...(dflt === undefined ? {} : { default: dflt }) });
  const fn = (params: ParamSlice[], decorators: string[]): SigSlice => ({ lang: 'python', unit: 'function', params, decorators, returns: null });
  const classC: SigSlice = { lang: 'python', unit: 'class', bases: ['Base'], methods: ['v'], assignments: ['x'] };
  // unitIds 1–8 as in the test above: f, C, C's residue, the getter, the setter, NAME, total, the statement block
  assert.deepEqual(t.units.map((u) => u.sigSlice), [
    fn([pos('a'), pos('b', '1')], ['decorator']),
    classC,
    classC,
    fn([pos('self')], ['property']),
    fn([pos('self'), pos('value')], ['v.setter']),
    null,   // a const unit other than __all__ carries no slice (contract addition 3)
    null,
    null,   // a block
  ]);
});

test('Python: async defs, nested classes, decorated classes, chained and tuple assignments, top-level if branches', async () => {
  const src = [
    'from __future__ import annotations',   // 1
    '# a comment between imports',           // 2
    'import sys',                            // 3
    '',                                      // 4
    '@dataclass',                            // 5
    'class Outer:',                          // 6
    '    class Inner:',                      // 7
    '        def m(self):',                  // 8
    '            return 1',                  // 9
    '',                                      // 10
    '    async def run(self):',              // 11
    '        pass',                          // 12
    '',                                      // 13
    'async def main():',                     // 14
    '    pass',                              // 15
    'a = b = 1',                             // 16
    'x, y = 1, 2',                           // 17
    'LIMIT: int',                            // 18
    'if sys.platform == "win32":',           // 19
    '    def opener():',                     // 20
    '        return 1',                      // 21
    '    SEP = ";"',                         // 22
    'else:',                                 // 23
    '    def opener():',                     // 24
    '        return 2',                      // 25
  ].join('\n');
  const t = await testTable('m.py', Buffer.from(`${src}\n`, 'utf8'));
  assert.deepEqual(t.imports, [1, 3], 'a comment between import nodes is inside <imports>');
  const byLabel = (u: UnitShape): string => `${u.kind}:${u.label.qualname}${u.label.disc === '' ? '' : `#${u.label.disc}`}:${u.leaf ? '' : 'nonleaf:'}${u.residue ? 'residue:' : ''}${JSON.stringify(u.ranges)}`;
  assert.deepEqual(withoutSigSlice(t.units).map(byLabel), [
    'class:Outer:nonleaf:[[5,12]]',
    'class:Outer:residue:[[5,6],[10,10]]',
    'class:Outer.Inner:nonleaf:[[7,9]]',
    'class:Outer.Inner:residue:[[7,7]]',
    'method:Outer.Inner.m:[[8,9]]',
    'method:Outer.run:[[11,12]]',
    'function:main:[[14,15]]',
    'block::[[16,19]]',
    'function:opener##0:[[20,21]]',
    'block::[[22,23]]',
    'function:opener##1:[[24,25]]',
  ]);
  const inner = t.units.find((u) => u.label.qualname === 'Outer.Inner' && !u.leaf);
  const m = t.units.find((u) => u.label.qualname === 'Outer.Inner.m');
  assert.equal(m?.parentUnitId, inner?.unitId);
  assert.deepEqual(m?.label, L('method', 'Outer.Inner.m', 'm', 'Outer.Inner'));
  assert.deepEqual(t.units.find((u) => u.label.qualname === 'Outer.Inner' && u.leaf)?.label, L('class', 'Outer.Inner', 'Inner', 'Outer'));
});
