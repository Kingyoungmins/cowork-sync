// TypeScript and TSX region tables (Plan 4 Task 4; 04 §3.3 "Units per language" JS/TS/TSX row, extent-convention/1 step 1 —
// the export wrapper and the first overload signature —, label-convention/1 `overload`; R1-075, R1-077, R2-B02, REG-16).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Label } from '../../src/regions/types.js';
import { fixture } from '../helpers/regionFixtures.js';
import { testTable, withoutSigSlice, type UnitShape } from '../helpers/regionRuntime.js';

const L = (kind: string, qualname: string, simple: string, type = '', disc = ''): Label => ({ kind, qualname, simple, type, disc });
const view = (u: UnitShape): string =>
  `${u.kind}:${u.label.qualname}${u.label.disc === '' ? '' : `#${u.label.disc}`}${u.leaf ? '' : ':nonleaf'}${u.residue ? ':residue' : ''}:${JSON.stringify(u.ranges)}`;

const TS = [
  "import { a } from './a';",                // 1 <imports>
  'interface I {',                           // 2
  '  x: number;',                            // 3
  '}',                                       // 4
  'type T = { a: number };',                 // 5
  'enum E { A, B }',                         // 6
  '',                                        // 7
  'export function e(): void {',             // 8
  '  return;',                               // 9
  '}',                                       // 10
  'function f(x: number): number;',          // 11
  'function f(x: string): string;',          // 12
  'function f(x: any): any {',               // 13
  '  return x;',                             // 14
  '}',                                       // 15
  'export default class D {',                // 16
  '  private n = 1;',                        // 17
  '  m(): void {}',                          // 18
  '}',                                       // 19
  'abstract class Ab {',                     // 20
  '  abstract z(): void;',                   // 21
  '}',                                       // 22
  'export const k = (a: number): number => a;',   // 23
];

test('JavaScript and TypeScript units (TypeScript and TSX)', async () => {
  const t = await testTable('m.ts', Buffer.from(`${TS.join('\n')}\n`, 'utf8'));
  assert.equal(t.grammar, 'typescript');
  assert.deepEqual(t.imports, [1, 1]);
  assert.deepEqual(withoutSigSlice(t.units).map(view), [
    'type:I:nonleaf:[[2,4]]',
    'type:I:residue:[[2,4]]',
    'type:T:nonleaf:[[5,5]]',
    'type:T:residue:[[5,5]]',
    'type:E:nonleaf:[[6,6]]',
    'type:E:residue:[[6,6]]',
    'function:e:[[8,10]]',
    'function:f#overload:[[11,15]]',
    'class:D:nonleaf:[[16,19]]',
    'class:D:residue:[[16,17],[19,19]]',
    'method:D.m:[[18,18]]',
    'class:Ab:nonleaf:[[20,22]]',
    'class:Ab:residue:[[20,22]]',
    'const:k:[[23,23]]',
  ]);
  assert.deepEqual(t.units.find((u) => u.label.qualname === 'f')?.label, L('function', 'f', 'f', '', 'overload'));
  assert.deepEqual(t.units.find((u) => u.label.qualname === 'I' && u.leaf)?.label, L('type', 'I', 'I'));

  // extent-convention/1 step 1: an export_statement that wraps the declaration starts the extent, also when `export` and the
  // declaration are on different rows (a line break after `export default`, a decorator above `export class`)
  const ex = await testTable('x.ts', Buffer.from([
    '// e is exported',          // 1 attached comment (step 2)
    'export default',            // 2 the export row
    'function e(): void {',      // 3 the declaration row
    '  return;',                 // 4
    '}',                         // 5
    '@sealed',                   // 6 the export_statement starts at its decorator
    'export class X {}',         // 7
    '',
  ].join('\n'), 'utf8'));
  assert.equal(ex.errorCount, 0);
  assert.deepEqual(withoutSigSlice(ex.units).map(view), ['function:e:[[1,5]]', 'class:X:nonleaf:[[6,7]]', 'class:X:residue:[[6,7]]']);

  // csharp/overloads.ts: the comment on row 1 (step 2), the two signatures (rows 2-3) and the implementation (rows 4-6) are one unit
  const ov = await testTable('csharp/overloads.ts', fixture('csharp/overloads.ts'));
  const f = ov.units.filter((u) => u.label.simple === 'f');
  assert.deepEqual(withoutSigSlice(f).map(view), ['function:f#overload:[[1,6]]']);
  assert.deepEqual(ov.imports, null, 'export { f } has no source: not import-class');

  // TSX: a function component and an arrow component
  const tsx = await testTable('c.tsx', Buffer.from([
    'export function Comp(props: { a: number }) {',
    '  return <div>{props.a}</div>;',
    '}',
    'const Arrow = () => <span />;',
    '',
  ].join('\n'), 'utf8'));
  assert.equal(tsx.grammar, 'tsx');
  assert.deepEqual(withoutSigSlice(tsx.units).map(view), ['function:Comp:[[1,3]]', 'const:Arrow:[[4,4]]']);
  assert.equal(tsx.errorCount, 0);
});

test('TypeScript: a lone signature, exported overloads, comments inside an overload set and a declare are kept apart', async () => {
  const src = [
    'export function g(x: number): number;',    // 1
    '/** the string form */',                  // 2
    'export function g(x: string): string;',    // 3
    'export function g(x: any): any {',         // 4
    '  return x;',                              // 5
    '}',                                        // 6
    'function lone(x: number): void;',          // 7
    'declare const DEBUG: boolean;',            // 8
  ].join('\n');
  const t = await testTable('m.ts', Buffer.from(`${src}\n`, 'utf8'));
  assert.deepEqual(withoutSigSlice(t.units).map(view), ['function:g#overload:[[1,6]]', 'function:lone:[[7,7]]', 'block::[[8,8]]']);
});
