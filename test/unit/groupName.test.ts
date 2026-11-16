// The group-name rule (Plan 4 Task 6; 04 §3.12, REG-17, REG-14, R2-B01, R2-H01, R4-45; T-REG-10 unit part). Added and claimed
// units come from the production 'table' handler (testTable) over real C#, TypeScript, Python and JavaScript sources, so the
// labels are label-convention/1's (Task 4); declaresPartial is the partial-type grep's pattern over one file's post bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupNameHit, type PartialTypeInfo } from '../../src/regions/groupName.js';
import { lineArray, rangesIntersect } from '../../src/regions/lines.js';
import { hunks } from '../../src/regions/mapper.js';
import { declaresPartial } from '../../src/regions/partial.js';
import type { Hunk, RegionTable, Unit } from '../../src/regions/types.js';
import { fixture } from '../helpers/regionFixtures.js';
import { testTable } from '../helpers/regionRuntime.js';

const u8 = (s: string): Buffer => Buffer.from(s, 'utf8');

/** The leaf unit of t with this qualname and disc. */
function unit(t: RegionTable, qualname: string, disc: string): Unit {
  const hits = t.units.filter((u) => u.leaf && u.label.qualname === qualname && u.label.disc === disc);
  assert.equal(hits.length, 1, `${qualname}#${disc}: exactly one unit`);
  return hits[0] as Unit;
}

/** The post leaf units the hunks between base and post add or rewrite (the "added" input as a caller computes it). */
function added(base: Buffer, post: Buffer, postTable: RegionTable): { hunks: Hunk[]; units: Unit[] } {
  const hs = hunks(lineArray(base), lineArray(post));
  const units = postTable.units.filter((u) => u.leaf && hs.some((h) => h.bLo <= h.bHi && rangesIntersect(u.ranges, [[h.bLo, h.bHi]])));
  return { hunks: hs, units };
}

const cs = (body: string, ns = 'N', type = 'Svc', partial = 'partial '): Buffer =>
  u8(`namespace ${ns}\n{\n    public ${partial}class ${type}\n    {\n${body}    }\n}\n`);

test('C# overload additions hit a claimed member by (type qualname, simple)', async () => {
  const svc = await testTable('Svc.cs', fixture('csharp/Svc.cs'));
  const calc = unit(svc, 'N.Svc.Calc', '(int)');
  const claimed = [calc];

  // S6(b): an overload added in the same file, not adjacent to the held one
  const post = fixture('csharp/Svc.new_overload.cs');
  const add = added(fixture('csharp/Svc.cs'), post, await testTable('Svc.cs', post));
  assert.deepEqual(add.units.map((u) => `${u.kind}:${u.label.qualname}#${u.label.disc}`).sort(), ['method:N.Svc.Calc#(decimal)', 'type:N.Svc#'], 'the new overload and the residue row after it');
  assert.equal(groupNameHit('c_sharp', add.units, claimed, null), true);

  // an overload in a partial part of the type (another file)
  const long = unit(await testTable('Svc.Part2.long.cs', fixture('csharp/Svc.Part2.long.cs')), 'N.Svc.Calc', '(long)');
  assert.equal(long.label.type, 'N.Svc');
  assert.equal(groupNameHit('c_sharp', [long], claimed, null), true);

  const reset2 = unit(await testTable('Svc.Part3.cs', cs('        public void Reset2()\n        {\n        }\n')), 'N.Svc.Reset2', '()');
  assert.equal(groupNameHit('c_sharp', [reset2], claimed, null), false, 'another simple name');
  const other = unit(await testTable('Other.cs', cs('        public int Calc(int x)\n        {\n            return x;\n        }\n', 'N', 'Other', '')), 'N.Other.Calc', '(int)');
  assert.equal(groupNameHit('c_sharp', [other], claimed, null), false, 'another type');

  const members = await testTable('Members.cs', cs([
    '        public Svc()\n        {\n        }\n',
    '        public Svc(int x)\n        {\n        }\n',
    '        public static Svc operator +(Svc a, Svc b) => a;\n',
    '        public static Svc operator +(Svc a, int b) => a;\n',
    '        public int this[int i] => i;\n',
    '        public int this[string s] => 0;\n',
    '        public int Prop { get; set; }\n',
  ].join('')));
  const ctor0 = unit(members, 'N.Svc.Svc', '()');
  const ctor1 = unit(members, 'N.Svc.Svc', '(int)');
  assert.equal(ctor0.kind, 'ctor');
  assert.equal(groupNameHit('c_sharp', [ctor1], [ctor0], null), true, 'a constructor overload');
  const plus = members.units.filter((u) => u.leaf && u.label.simple === 'op_Addition');
  assert.equal(plus.length, 2);
  assert.equal(groupNameHit('c_sharp', [plus[1] as Unit], [plus[0] as Unit], null), true, 'an operator overload');
  const items = members.units.filter((u) => u.leaf && u.kind === 'indexer');
  assert.deepEqual(items.map((u) => [u.label.simple, u.label.disc]), [['Item', '(int)'], ['Item', '(string)']]);
  assert.equal(groupNameHit('c_sharp', [items[1] as Unit], [items[0] as Unit], null), true, 'an indexer overload');

  // properties, fields and the type's residue are no overload group; nothing matches without a claimed member
  const prop = unit(members, 'N.Svc.Prop', '');
  assert.equal(groupNameHit('c_sharp', [prop], [prop], null), false, 'a property is no group member');
  assert.equal(groupNameHit('c_sharp', add.units, [], null), false);
  // an unlabeled unit (a SEC-35-failing label: kind kept, four empty fields) never matches (Task 4 ruling)
  const blank = { kind: 'method', qualname: '', simple: '', type: '', disc: '' };
  const unlabeled = (u: Unit): Unit => ({ ...u, label: blank });
  assert.equal(groupNameHit('c_sharp', [unlabeled(reset2)], [unlabeled(calc)], null), false);
  assert.equal(groupNameHit('c_sharp', [unlabeled(long)], claimed, null), false);
});

test('TypeScript overload sets hit; Python and JavaScript never', async () => {
  const base = fixture('csharp/overloads.ts');
  const post = fixture('csharp/overloads.post.ts');
  for (const path of ['overloads.ts', 'overloads.tsx'] as const) {
    const f = unit(await testTable(path, base), 'f', 'overload');
    const add = added(base, post, await testTable(path, post));
    assert.deepEqual(add.hunks, [{ aLo: 4, aHi: 3, bLo: 4, bHi: 4 }], 'function f(x: boolean): boolean; after row 3');
    assert.deepEqual(add.units.map((u) => [u.label.qualname, u.label.disc]), [['f', 'overload']]);
    assert.equal(groupNameHit(path.endsWith('.tsx') ? 'tsx' : 'typescript', add.units, [f], null), true, path);
  }
  // a lone signature of the same name added away from the claimed set
  const lone = await testTable('lone.ts', u8(`${base.toString('utf8')}\nfunction f(x: boolean): boolean;\n`));
  const loneUnit = lone.units.find((u) => u.leaf && u.label.qualname === 'f' && u.label.disc === '') as Unit;
  assert.ok(loneUnit !== undefined);
  assert.equal(groupNameHit('typescript', [loneUnit], [unit(await testTable('overloads.ts', base), 'f', 'overload')], null), true, 'joins the overload set');
  const g = unit(await testTable('g.ts', u8('function g(x: number): number {\n  return x;\n}\n')), 'g', '');
  assert.equal(groupNameHit('typescript', [g], [unit(await testTable('overloads.ts', base), 'f', 'overload')], null), false, 'another name');

  // Python @overload stubs of compute_total (py_overload_stubs_above): same qualname, never a group-name hit
  const pyBase = fixture('big_lf.py');
  const pyPost = fixture('rc_touch/py_overload_stubs_above.post.py');
  const pyAdd = added(pyBase, pyPost, await testTable('big_lf.py', pyPost));
  assert.deepEqual(pyAdd.units.map((u) => [u.label.qualname, JSON.stringify(u.ranges)]), [['compute_total', '[[5331,5332]]']]);
  const total = unit(await testTable('big_lf.py', pyBase), 'compute_total', '');
  assert.equal(groupNameHit('python', pyAdd.units, [total], null), false);
  assert.equal(groupNameHit('python', [total], [total], { simpleName: 'x', files: [], failed: true }, { path: 'big_lf.py', fileDeclaresPartial: true }), false);
  // JavaScript get balance() above the held setter
  const jsBase = fixture('rc_touch/account.js');
  const jsPost = fixture('rc_touch/js_getter_above_setter.post.js');
  const jsAdd = added(jsBase, jsPost, await testTable('account.js', jsPost));
  assert.deepEqual(jsAdd.units.map((u) => [u.label.qualname, u.label.disc]), [['Account.balance', 'get']]);
  const setter = unit(await testTable('account.js', jsBase), 'Account.balance', 'set');
  assert.equal(groupNameHit('javascript', jsAdd.units, [setter], null), false);
  assert.equal(groupNameHit('javascript', [setter], [setter], null), false);
});

test('a failed partial grep makes every hunk of every partial file of the type a hit', async () => {
  const claimed = [unit(await testTable('Svc.cs', fixture('csharp/Svc.cs')), 'N.Svc.Calc', '(int)')];
  const part2 = fixture('csharp/Svc.Part2.cs');
  const part2Post = u8(part2.toString('utf8').replace('    }\n}\n', '\n        public string Name2()\n        {\n            return "svc2";\n        }\n    }\n}\n'));
  const add = added(part2, part2Post, await testTable('Svc.Part2.cs', part2Post));
  assert.ok(add.units.some((u) => u.label.qualname === 'N.Svc.Name2'));
  const failed: PartialTypeInfo = { simpleName: 'Svc', files: ['Svc.cs', 'Svc.Part2.cs'], failed: true };
  const at = (path: string, bytes: Buffer): { path: string; fileDeclaresPartial: boolean } => ({ path, fileDeclaresPartial: declaresPartial(bytes, 'Svc') });

  assert.equal(groupNameHit('c_sharp', add.units, claimed, failed, at('Svc.Part2.cs', part2Post)), true, 'a hunk in a listed partial file');
  const otherPartial = cs('        public void Helper()\n        {\n        }\n');
  const helper = unit(await testTable('Other.cs', otherPartial), 'N.Svc.Helper', '()');
  assert.equal(groupNameHit('c_sharp', [helper], claimed, failed, at('Other.cs', otherPartial)), true, 'a file whose bytes declare a partial part');
  const otherPlain = cs('        public void Helper()\n        {\n        }\n', 'N', 'Svc2');
  const helper2 = unit(await testTable('Other.cs', otherPlain), 'N.Svc2.Helper', '()');
  assert.equal(groupNameHit('c_sharp', [helper2], claimed, failed, at('Other.cs', otherPlain)), false, 'no partial Svc declaration');
  assert.equal(groupNameHit('c_sharp', add.units, claimed, { ...failed, failed: false }, at('Svc.Part2.cs', part2Post)), false, 'a grep that did not fail');
  // the empty file list of a real failure (R4-45) still catches the listed file through its own bytes
  assert.equal(groupNameHit('c_sharp', add.units, claimed, { ...failed, files: [] }, at('Svc.Part2.cs', part2Post)), true);
  // no hunk to place: a failed grep touches (P2); a normal hit stands beside the fallback (labels add, never clear)
  assert.equal(groupNameHit('c_sharp', add.units, claimed, failed), true);
  const long = unit(await testTable('Svc.Part2.long.cs', fixture('csharp/Svc.Part2.long.cs')), 'N.Svc.Calc', '(long)');
  assert.equal(groupNameHit('c_sharp', [long], claimed, failed, { path: 'Elsewhere.cs', fileDeclaresPartial: false }), true);
});

test('declaresPartial: the partial-type pattern over one file, line by line', () => {
  const yes = [
    'public partial class Svc\n', 'partial class Svc{ }\n', 'partial  struct Svc<T>\n', 'partial record Svc', 'internal partial record Svc\r\n',
    'partial\tinterface Svc : IOther\n', 'x\n    public sealed partial class Svc // trailing\n', 'partial class Svc\u{E9}x\n',
  ];
  for (const s of yes) assert.equal(declaresPartial(u8(s), 'Svc'), true, JSON.stringify(s));
  const no = ['partial class SvcExtra\n', 'partial class Svc2\n', 'partial class Svc_\n', 'class Svc\n', 'partial\nclass Svc\n', 'partial enum Svc\n', 'partial class\nSvc\n', ''];
  for (const s of no) assert.equal(declaresPartial(u8(s), 'Svc'), false, JSON.stringify(s));
  const hangul = '\u{D55C}\u{AE00}';
  assert.equal(declaresPartial(u8(`partial class ${hangul}\n`), hangul), true);
  assert.equal(declaresPartial(u8(`partial class ${hangul}2\n`), hangul), false);
  // bytes that are not UTF-8 around the declaration do not hide it
  assert.equal(declaresPartial(Buffer.concat([Buffer.from([0xff, 0xfe, 0x0a]), u8('partial class Svc\n')]), 'Svc'), true);
  // a name with regex metacharacters is matched literally
  assert.equal(declaresPartial(u8('partial class S.c\n'), 'S.c'), true);
  assert.equal(declaresPartial(u8('partial class Sxc\n'), 'S.c'), false);
});
