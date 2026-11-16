// C# region tables (Plan 4 Task 4; 04 §3.3 "Units per language" C# row, extent-convention/1 steps 1-2 (attributes, `///`),
// label-convention/1 (CLR names, normalized parameter type lists); R1-075, R1-077, R1-078, R4-19, OQ-16).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Label } from '../../src/regions/types.js';
import { testTable, withoutSigSlice, type UnitShape } from '../helpers/regionRuntime.js';

const L = (kind: string, qualname: string, simple: string, type = '', disc = ''): Label => ({ kind, qualname, simple, type, disc });
const view = (u: UnitShape): string =>
  `${u.kind}:${u.label.qualname}${u.label.disc === '' ? '' : `#${u.label.disc}`}${u.leaf ? '' : ':nonleaf'}${u.residue ? ':residue' : ''}:${JSON.stringify(u.ranges)}`;

const BLOCK_SCOPED = [
  'extern alias X;',                                      // 1 <imports>
  'using System;',                                        // 2 <imports>
  'using System.Collections.Generic;',                    // 3 <imports>
  '',                                                     // 4
  'namespace N',                                          // 5 gap
  '{',                                                    // 6 gap
  '    /// <summary>The service.</summary>',              // 7 attached to Svc
  '    public class Svc',                                 // 8
  '    {',                                                // 9
  '        private int _f = 1, _g = 2;',                  // 10
  '        public event EventHandler Changed;',           // 11
  '        public int Prop { get; set; }',                // 12
  '',                                                     // 13
  '        /// <summary>Builds one.</summary>',           // 14 attached to the ctor
  '        public Svc() { }',                             // 15
  '        ~Svc() { }',                                   // 16
  '',                                                     // 17
  '        [Obsolete]',                                   // 18 starts Calc(int)
  '        public int Calc(int x) { return x; }',         // 19
  '        public double Calc(double x) { return x; }',   // 20
  '        public int Calc(int x, string s) { return x; }',   // 21
  '        public static Svc operator +(Svc a, Svc b) => a;', // 22
  '        public static implicit operator int(Svc s) => 0;', // 23
  '        public int this[int i] => i;',                 // 24
  '        public void Gen<T>(Dictionary<string, List<T>> map, ref int r, int? n, params object[] rest) { }', // 25
  '',                                                     // 26
  '        class Inner',                                  // 27
  '        {',                                            // 28
  '            void M() { }',                             // 29
  '        }',                                            // 30
  '    }',                                                // 31
  '}',                                                    // 32 gap
];

test('C# units with CLR names and overload discriminators', async () => {
  const t = await testTable('Svc.cs', Buffer.from(`${BLOCK_SCOPED.join('\n')}\n`, 'utf8'));
  assert.equal(t.grammar, 'c_sharp');
  assert.deepEqual(t.imports, [1, 3], 'using and extern alias are import-class');
  assert.deepEqual(withoutSigSlice(t.units).map(view), [
    'block::[[5,6]]',
    'type:N.Svc:nonleaf:[[7,31]]',
    'type:N.Svc:residue:[[7,9],[13,13],[17,17],[26,26],[31,31]]',
    'field:N.Svc._f:[[10,10]]',
    'event:N.Svc.Changed:[[11,11]]',
    'property:N.Svc.Prop:[[12,12]]',
    'ctor:N.Svc.Svc#():[[14,15]]',
    'dtor:N.Svc.Finalize#():[[16,16]]',
    'method:N.Svc.Calc#(int):[[18,19]]',
    'method:N.Svc.Calc#(double):[[20,20]]',
    'method:N.Svc.Calc#(int,string):[[21,21]]',
    'operator:N.Svc.op_Addition#(Svc,Svc):[[22,22]]',
    'operator:N.Svc.op_Implicit#(Svc):[[23,23]]',
    'indexer:N.Svc.Item#(int):[[24,24]]',
    'method:N.Svc.Gen#(Dictionary<string,List<T>>,ref:int,Nullable<int>,object[]):[[25,25]]',
    'type:N.Svc.Inner:nonleaf:[[27,30]]',
    'type:N.Svc.Inner:residue:[[27,28],[30,30]]',
    'method:N.Svc.Inner.M#():[[29,29]]',
    'block::[[32,32]]',
  ]);
  const label = (q: string, disc?: string): Label | undefined => t.units.find((u) => u.leaf && u.label.qualname === q && (disc === undefined || u.label.disc === disc))?.label;
  assert.deepEqual(label('N.Svc'), L('type', 'N.Svc', 'Svc'));
  assert.deepEqual(label('N.Svc.Calc', '(int)'), L('method', 'N.Svc.Calc', 'Calc', 'N.Svc', '(int)'));
  assert.deepEqual(label('N.Svc.Calc', '(double)'), L('method', 'N.Svc.Calc', 'Calc', 'N.Svc', '(double)'));
  assert.deepEqual(label('N.Svc.Calc', '(int,string)'), L('method', 'N.Svc.Calc', 'Calc', 'N.Svc', '(int,string)'));
  assert.deepEqual(label('N.Svc.Svc'), L('ctor', 'N.Svc.Svc', 'Svc', 'N.Svc', '()'));
  assert.deepEqual(label('N.Svc.Finalize'), L('dtor', 'N.Svc.Finalize', 'Finalize', 'N.Svc', '()'));
  assert.deepEqual(label('N.Svc.op_Addition'), L('operator', 'N.Svc.op_Addition', 'op_Addition', 'N.Svc', '(Svc,Svc)'));
  assert.deepEqual(label('N.Svc.op_Implicit'), L('operator', 'N.Svc.op_Implicit', 'op_Implicit', 'N.Svc', '(Svc)'));
  assert.deepEqual(label('N.Svc.Item'), L('indexer', 'N.Svc.Item', 'Item', 'N.Svc', '(int)'));
  assert.deepEqual(label('N.Svc.Prop'), L('property', 'N.Svc.Prop', 'Prop', 'N.Svc', ''));
  assert.deepEqual(label('N.Svc.Changed'), L('event', 'N.Svc.Changed', 'Changed', 'N.Svc', ''));
  assert.deepEqual(label('N.Svc._f'), L('field', 'N.Svc._f', '_f', 'N.Svc', ''));
  assert.deepEqual(label('N.Svc.Inner'), L('type', 'N.Svc.Inner', 'Inner', 'N.Svc'));
  assert.deepEqual(label('N.Svc.Inner.M'), L('method', 'N.Svc.Inner.M', 'M', 'N.Svc.Inner', '()'));
  for (const u of t.units) {
    for (const field of Object.values(u.label)) assert.doesNotMatch(field, /\s/u, `no label field contains whitespace: ${JSON.stringify(u.label)}`);
  }
  assert.equal(t.errorCount, 0);
});

test('C# file-scoped namespaces, struct, interface, enum and record', async () => {
  const src = [
    'using System;',                      // 1
    '',                                   // 2
    'namespace N.Gen;',                   // 3 gap
    '',                                   // 4
    'public class Svc',                   // 5
    '{',                                  // 6
    '    public int Calc(int x) => x;',   // 7
    '}',                                  // 8
    'public struct S { public int X; }',  // 9
    'public interface I',                 // 10
    '{',                                  // 11
    '    int Get();',                     // 12
    '}',                                  // 13
    'public enum E { A, B }',             // 14
    'public record R(int A, string B);',  // 15
  ].join('\n');
  const t = await testTable('Gen.cs', Buffer.from(`${src}\n`, 'utf8'));
  assert.deepEqual(t.imports, [1, 1]);
  assert.deepEqual(withoutSigSlice(t.units).map(view), [
    'block::[[3,3]]',
    'type:N.Gen.Svc:nonleaf:[[5,8]]',
    'type:N.Gen.Svc:residue:[[5,6],[8,8]]',
    'method:N.Gen.Svc.Calc#(int):[[7,7]]',
    'type:N.Gen.S:nonleaf:[[9,9]]',
    'type:N.Gen.S:residue:[[9,9]]',
    'type:N.Gen.I:nonleaf:[[10,13]]',
    'type:N.Gen.I:residue:[[10,11],[13,13]]',
    'method:N.Gen.I.Get#():[[12,12]]',
    'type:N.Gen.E:nonleaf:[[14,14]]',
    'type:N.Gen.E:residue:[[14,14]]',
    'type:N.Gen.R:nonleaf:[[15,15]]',
    'type:N.Gen.R:residue:[[15,15]]',
  ]);
});
