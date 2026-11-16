// JavaScript region tables (Plan 4 Task 4; 04 §3.3 "Units per language" JS/TS/TSX row, extent-convention/1, label-convention/1,
// §3.13 <imports>; R1-075, R1-077, R2-B02, REG-16). The TypeScript and TSX half of "JavaScript and TypeScript units" is in
// tables.ts.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Label } from '../../src/regions/types.js';
import { testTable, withoutSigSlice, type UnitShape } from '../helpers/regionRuntime.js';

const L = (kind: string, qualname: string, simple: string, type = '', disc = ''): Label => ({ kind, qualname, simple, type, disc });
const BLOCK = L('block', '', '');

/** kind:qualname[#disc][:nonleaf][:residue]:ranges — a compact view of one unit. */
const view = (u: UnitShape): string =>
  `${u.kind}:${u.label.qualname}${u.label.disc === '' ? '' : `#${u.label.disc}`}${u.leaf ? '' : ':nonleaf'}${u.residue ? ':residue' : ''}:${JSON.stringify(u.ranges)}`;

const JS = [
  "const x = require('x');",            // 1  <imports>
  "export { a } from './a';",           // 2  <imports>
  "import y from 'y';",                 // 3  <imports>
  '',                                   // 4
  '// decl does a thing',               // 5  attached comment
  'function decl(a) {',                 // 6
  '  return a;',                        // 7
  '}',                                  // 8
  'function* gen() {',                  // 9
  '  yield 1;',                         // 10
  '}',                                  // 11
  'class K {',                          // 12 residue
  '  n = 1;',                           // 13 residue (class field)
  '  get v() {',                        // 14
  '    return this._v;',                // 15
  '  }',                                // 16
  '  set v(x) {',                       // 17
  '    this._v = x;',                   // 18
  '  }',                                // 19
  '}',                                  // 20 residue
  'const h = () => 1;',                 // 21
  'let g = function () {',              // 22
  '  return 2;',                        // 23
  '};',                                 // 24
  'var Q = class {',                    // 25
  '  m() {}',                           // 26
  '};',                                 // 27
  'api = {',                            // 28 gap
  '  get() {',                          // 29
  '    return 1;',                      // 30
  '  },',                               // 31
  '  put: function () {',               // 32
  '    return 2;',                      // 33
  '  },',                               // 34
  '};',                                 // 35 gap
  '(function () {',                     // 36 gap
  '  function inner() {}',              // 37
  '})();',                              // 38 gap
  'console.log(1);',                    // 39 gap
];

test('JavaScript and TypeScript units', async () => {
  const t = await testTable('m.js', Buffer.from(`${JS.join('\n')}\n`, 'utf8'));
  assert.equal(t.grammar, 'javascript');
  assert.deepEqual(t.imports, [1, 3], 'require(), export … from and import are import-class nodes');
  assert.deepEqual(withoutSigSlice(t.units).map(view), [
    'function:decl:[[5,8]]',
    'function:gen:[[9,11]]',
    'class:K:nonleaf:[[12,20]]',
    'class:K:residue:[[12,13],[20,20]]',
    'method:K.v#get:[[14,16]]',
    'method:K.v#set:[[17,19]]',
    'const:h:[[21,21]]',
    'const:g:[[22,24]]',
    'const:Q:nonleaf:[[25,27]]',
    'const:Q:residue:[[25,25],[27,27]]',
    'method:Q.m:[[26,26]]',
    'block::[[28,28]]',
    'method:api.get:[[29,31]]',
    'method:api.put:[[32,34]]',
    'block::[[35,36]]',
    'function:inner:[[37,37]]',
    'block::[[38,39]]',
  ]);
  const get = t.units.find((u) => u.label.disc === 'get');
  assert.deepEqual(get?.label, L('method', 'K.v', 'v', 'K', 'get'));
  assert.deepEqual(t.units.find((u) => u.label.qualname === 'api.put')?.label, L('method', 'api.put', 'put', '', ''));
  // 04 §3.3 JS/TS row: a const/let/var with a single declarator bound to an arrow function, a function expression or a class is kind const
  assert.deepEqual(['h', 'g'].map((q) => t.units.find((u) => u.label.qualname === q)?.label), [L('const', 'h', 'h'), L('const', 'g', 'g')]);
  assert.deepEqual(t.units.filter((u) => u.label.qualname === 'Q').map((u) => [u.kind, u.label]), [['const', L('const', 'Q', 'Q')], ['const', L('const', 'Q', 'Q')]]);
  assert.deepEqual(t.units.find((u) => u.label.qualname === 'Q.m')?.label, L('method', 'Q.m', 'm', 'Q'));
  assert.deepEqual(t.units.find((u) => u.label.qualname === 'inner')?.label, L('function', 'inner', 'inner'), 'an IIFE body is top level');
  assert.deepEqual(t.units.filter((u) => u.kind === 'block').map((u) => u.label), [BLOCK, BLOCK, BLOCK]);
  assert.equal(t.errorCount, 0);
});

test('JavaScript: export wrappers, default exports, object bindings, one-line collisions and UMD arguments', async () => {
  const src = [
    'export function e() {}',                  // 1
    'export default function () {',            // 2
    '  return 1;',                             // 3
    '}',                                       // 4
    'export const z = () => 2;',               // 5
    'const obj = { a() {}, b: () => 1, c: 3 };',   // 6 a and b share the row: b folds into a
    'class P { m() {} }',                      // 7 a member on the header row is residue
    '(function (root, factory) {',             // 8
    '  root.x = factory();',                   // 9
    '})(this, function () {',                  // 10
    '  function fromFactory() {}',             // 11
    '});',                                     // 12
  ].join('\n');
  const t = await testTable('m.js', Buffer.from(`${src}\n`, 'utf8'));
  assert.deepEqual(withoutSigSlice(t.units).map(view), [
    'function:e:[[1,1]]',
    'function:default:[[2,4]]',
    'const:z:[[5,5]]',
    'method:obj.a:[[6,6]]',
    'class:P:nonleaf:[[7,7]]',
    'class:P:residue:[[7,7]]',
    'block::[[8,10]]',
    'function:fromFactory:[[11,11]]',
    'block::[[12,12]]',
  ]);
});
