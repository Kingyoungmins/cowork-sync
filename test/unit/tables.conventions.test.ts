// extent-convention/1 and label-convention/1 over the real grammars, error spans and label counts, the 432-unit form
// invariance and the incremental re-parse (Plan 4 Task 4; 04 §3.3, §3.14, §3.18 "One parse"; REG-16, R1-077, R1-078, R1-080,
// R1-035, R1-081, R4-14, R4-18, R4-19, OQ-16; T-REG-03, T-REG-07 (table half), T-REG-08 (rc_dupes label keys), T-REG-24
// (label fields), TC-REG-03).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Parser, Tree, type Node } from 'web-tree-sitter';
import { rangesIntersect } from '../../src/regions/lines.js';
import { SnapshotStore } from '../../src/regions/snapshots.js';
import { labelKey, type Label, type RegionTable, type Unit } from '../../src/regions/types.js';
import { EXTENT_CONVENTION, LABEL_CONVENTION, VALID_LABEL_FIELD } from '../../src/regions/worker/conventions.js';
import { handle as handleTable } from '../../src/regions/worker/jobs/table.js';
import { endRow } from '../../src/regions/worker/lineTable.js';
import { initParser } from '../../src/regions/worker/parser.js';
import { BIG_UNITS, fixture, fixtureBytes, FIXTURE_MANIFEST, RC_TOUCH_R2, sweepScenario, editCheckCases, type FixtureBytes } from '../helpers/regionFixtures.js';
import { blobIdOf, testRegionRuntime, testSnapshot, testTable, testTableHost, testWorkerInit, withoutSigSlice } from '../helpers/regionRuntime.js';

const py = (rows: readonly string[]): Buffer => Buffer.from(`${rows.join('\n')}\n`, 'utf8');
const unitNamed = (t: RegionTable, qualname: string, disc?: string): Unit | undefined =>
  t.units.find((u) => u.leaf && u.label.qualname === qualname && (disc === undefined || u.label.disc === disc));

test('extent-convention/1', async () => {
  assert.equal(EXTENT_CONVENTION, 'extent-convention/1');
  // step 3 is lineTable.endRow
  assert.equal(endRow({ row: 9, column: 0 }), 9);
  assert.equal(endRow({ row: 9, column: 4 }), 10);
  const t = await testTable('m.py', py([
    'import os',                 // 1
    '',                          // 2
    '# separated by a blank row',// 3 not attached
    '',                          // 4
    '# attached, row one',       // 5 attached (step 2)
    '# attached, row two',       // 6
    '@first',                    // 7 the decorator stack starts the extent (step 1)
    '@second(1)',                // 8
    'def f():',                  // 9
    '    a = 1',                 // 10
    '',                          // 11 a blank row inside the body stays in the one range
    '    return a',              // 12
    '    # the last row of f',   // 13 an indented comment that ends f's body stays in f
    'def g():',                  // 14
    '    return 2',              // 15
    '',                          // 16
    'class C:',                  // 17
    '    def m(self):',          // 18
    '        pass',              // 19
    '    x = 1',                 // 20 residue between two methods
    '    def n(self):',          // 21
    '        pass',              // 22
  ]));
  assert.deepEqual(unitNamed(t, 'f')?.ranges, [[5, 13]]);
  assert.deepEqual(unitNamed(t, 'g')?.ranges, [[14, 15]], 'the comment on row 13 is the last row of f, not attached to g');
  const residue = t.units.find((u) => u.residue && u.label.qualname === 'C');
  assert.deepEqual(residue?.ranges, [[17, 17], [20, 20]], 'residue = extent minus member extents: multi-range');
  assert.deepEqual(unitNamed(t, 'C.m')?.ranges, [[18, 19]]);
  assert.deepEqual(unitNamed(t, 'C.n')?.ranges, [[21, 22]]);
  assert.deepEqual(t.units.filter((u) => u.kind === 'block').map((u) => u.ranges), [[[3, 3]]], 'the separated comment is a gap block');
});

test('label-convention/1', async () => {
  assert.equal(LABEL_CONVENTION, 'label-convention/1');
  const t = await testTable('m.py', py([
    'class A:',
    '    @property',
    '    def x(self):',
    '        return 1',
    '    @x.setter',
    '    def x(self, v):',
    '        pass',
    '    @x.deleter',
    '    def x(self):',
    '        pass',
    'if PLATFORM:',
    '    def open_console():',
    '        return 1',
    'else:',
    '    def open_console():',
    '        return 2',
  ]));
  assert.deepEqual(t.units.filter((u) => u.label.qualname === 'A.x').map((u) => u.label.disc), ['', 'setter', 'deleter']);
  assert.deepEqual(t.units.filter((u) => u.label.qualname === 'open_console').map((u) => u.label.disc), ['#0', '#1']);
  const js = await testTable('m.ts', py(['class P {', '  get v(): number { return 1; }', '  set v(x: number) {}', '}']));
  assert.deepEqual(js.units.filter((u) => u.label.qualname === 'P.v').map((u) => u.label.disc), ['get', 'set']);
  // label keys and counts
  const l: Label = { kind: 'method', qualname: 'A.x', simple: 'x', type: 'A', disc: 'setter' };
  assert.equal(labelKey(l), 'method\u{0}A.x\u{0}setter');
  for (const [key, n] of Object.entries(t.labelCounts)) {
    assert.equal(n, t.units.filter((u) => u.leaf && u.granularity === 'symbol' && labelKey(u.label) === key).length);
  }
  // a duplicated definition counts twice
  const dup = await testTable('d.py', py(['def a():', '    pass', 'def a():', '    pass']));
  assert.equal(dup.labelCounts[labelKey({ kind: 'function', qualname: 'a', simple: 'a', type: '', disc: '' })], 2);
  // every labelled unit is counted once, class residues included: one class counts 1 (its non-leaf unit carries the same key
  // and is not counted again), two same-name classes in one file count 2
  const classA = labelKey({ kind: 'class', qualname: 'A', simple: 'A', type: '', disc: '' });
  assert.equal(t.labelCounts[classA], 1);
  const twoClasses = await testTable('c.py', py(['class A:', '    x = 1', '', 'class A:', '    y = 2', '    def m(self):', '        pass']));
  assert.deepEqual(twoClasses.labelCounts, { [classA]: 2, [labelKey({ kind: 'method', qualname: 'A.m', simple: 'm', type: 'A', disc: '' })]: 1 });
  const twoCs = await testTable('c.cs', py(['partial class S', '{', '    int a;', '}', 'partial class S', '{', '    int b;', '}']));
  assert.equal(twoCs.labelCounts[labelKey({ kind: 'type', qualname: 'S', simple: 'S', type: '', disc: '' })], 2);
});

test('rc_dupes and rc_valid_errors have distinct label keys', async () => {
  const d = await testTable('dupes/rc_dupes.py', fixture('dupes/rc_dupes.py'));
  const keys = [
    { kind: 'method', qualname: 'Account.value', simple: 'value', type: 'Account', disc: '' },
    { kind: 'method', qualname: 'Account.value', simple: 'value', type: 'Account', disc: 'setter' },
    { kind: 'function', qualname: 'open_console', simple: 'open_console', type: '', disc: '#0' },
    { kind: 'function', qualname: 'open_console', simple: 'open_console', type: '', disc: '#1' },
  ].map(labelKey);
  assert.equal(new Set(keys).size, 4);
  for (const k of keys) assert.equal(d.labelCounts[k], 1, JSON.stringify(k));
  // README "Definition rows": value#0 row 13, value#1 row 17, open_console#0 row 24, open_console#1 row 28
  assert.equal(unitNamed(d, 'Account.value', '')?.ranges[0]?.[0], 12, 'the getter extent starts at its @property row (12) above def row 13');
  assert.equal(unitNamed(d, 'open_console', '#0')?.ranges[0]?.[0], 24);
  assert.equal(unitNamed(d, 'open_console', '#1')?.ranges[0]?.[0], 28);
  assert.equal(d.errorCount, 0);

  const cs = await testTable('errors/rc_valid_errors.cs', fixture('errors/rc_valid_errors.cs'));
  const describe = cs.units.filter((u) => u.label.simple === 'Describe');
  assert.deepEqual(describe.map((u) => u.label), [
    { kind: 'method', qualname: 'N.Report.Describe', simple: 'Describe', type: 'N.Report', disc: '()#0' },
    { kind: 'method', qualname: 'N.Report.Describe', simple: 'Describe', type: 'N.Report', disc: '()#1' },
  ]);
  assert.deepEqual(describe.map((u) => u.ranges[0]?.[0]), [10, 12]);
  for (const u of describe) assert.equal(cs.labelCounts[labelKey(u.label)], 1);

  const pyErr = await testTable('errors/rc_valid_errors.py', fixture('errors/rc_valid_errors.py'));
  assert.deepEqual(pyErr.units.filter((u) => u.label.simple === 'open_console').map((u) => u.label.disc), ['#0', '#1']);
});

test('rc_valid_errors.cs reproduces 04 §3.15: valid C# with #if/#else around a method header yields MISSING \';\', ERROR and MISSING #endif', async () => {
  const bytes = fixture('errors/rc_valid_errors.cs');
  const rows = bytes.toString('utf8').split('\n');
  const rowOf = (s: string): number => rows.findIndex((r) => r.trim() === s) + 1;
  const [ifRow, elseRow, endifRow] = [rowOf('#if DEBUG'), rowOf('#else'), rowOf('#endif')];
  // the directives wrap the two header rows only: one header under #if, one under #else, the body after #endif
  assert.deepEqual([elseRow - ifRow, endifRow - elseRow], [2, 2], `#if ${ifRow}, #else ${elseRow}, #endif ${endifRow}`);
  assert.match(rows[ifRow] as string, /\bDescribe\(\)$/u);
  assert.match(rows[elseRow] as string, /\bDescribe\(\)$/u);
  assert.equal(rows[endifRow]?.trim(), '{', 'the method body follows #endif');
  // tree-sitter-c-sharp 0.23.5's error nodes, walked test-side
  const host = await testTableHost();
  const tree = host.parse('c_sharp', bytes, `rc_valid_errors:${blobIdOf(bytes)}`, null);
  assert.ok(typeof tree !== 'string', 'the grammar loaded');
  const found: Array<[string, string, number]> = [];
  const walk = (n: Node): void => {
    if (n.isError || n.isMissing) found.push([n.isMissing ? 'MISSING' : 'ERROR', n.type, n.startPosition.row + 1]);
    for (const ch of n.children) walk(ch);
  };
  walk(tree.rootNode);
  assert.deepEqual(found.map(([k, type]) => [k, type]), [['MISSING', ';'], ['ERROR', 'ERROR'], ['MISSING', '#endif']]);
  assert.equal(found[0]?.[2], ifRow + 1, 'MISSING \';\' ends the #if header');
  assert.equal(found[1]?.[2], endifRow, 'the #endif row is the ERROR');
  // the table records them: errorCount and spans over both headers and the #endif row; the branch ordinals still apply
  const t = await testTable('errors/rc_valid_errors.cs', bytes);
  assert.equal(t.errorCount, 3);
  for (const r of [ifRow + 1, elseRow + 1, endifRow]) assert.ok(rangesIntersect(t.errorSpans, [[r, r]]), `row ${r} lies in an error span: ${JSON.stringify(t.errorSpans)}`);
  assert.deepEqual(t.units.filter((u) => u.label.simple === 'Describe').map((u) => [u.label.disc, u.ranges]), [['()#0', [[ifRow + 1, ifRow + 1]]], ['()#1', [[elseRow + 1, endifRow + 3]]]]);
});

/** SEC-35's validLabel pattern, test-side (validLabel itself is Task 8's). */
const SEC35 = /^[\p{L}\p{M}\p{N}_.:#<>,$@[\]()-]{1,200}$/u;

/** Every grammar-path blob of the Task 2 corpus: the manifest's files with a grammar extension, and the code inside the
 *  sweep and edit-check scenario JSON. */
function corpus(): Array<{ name: string; path: string; bytes: Buffer }> {
  const out: Array<{ name: string; path: string; bytes: Buffer }> = [];
  const grammarPath = (p: string): boolean => /\.(py|pyi|js|mjs|cjs|jsx|ts|mts|cts|tsx|cs)$/.test(p);
  const names = Object.keys((FIXTURE_MANIFEST as { fixtures: Record<string, unknown> }).fixtures);
  for (const n of names) if (grammarPath(n)) out.push({ name: n, path: n, bytes: fixture(n) });
  for (const n of names) {
    const m = /^sweep\/([^/]+)\/scenario\.json$/.exec(n);
    if (m === null) continue;
    const s = sweepScenario(m[1]!);
    const add = (where: string, files: Record<string, FixtureBytes | null> | undefined): void => {
      for (const [p, b] of Object.entries(files ?? {})) if (b !== null && grammarPath(p)) out.push({ name: `${n}:${where}:${p}`, path: p, bytes: fixtureBytes(b) });
    };
    for (const [p, sides] of Object.entries(s.files)) {
      add('base', { [p]: sides.base });
      if (sides.ours !== undefined) add('ours', { [p]: sides.ours });
      if (sides.theirs !== undefined) add('theirs', { [p]: sides.theirs });
    }
    add('oracle', s.oracle);
    add('corruptOut', s.corruptOut);
  }
  for (const c of editCheckCases()) for (const side of ['A', 'R', 'TIP'] as const) {
    for (const [p, b] of Object.entries(c[side])) if (b !== null && grammarPath(p)) out.push({ name: `editcheck/${c.name}:${side}:${p}`, path: p, bytes: fixtureBytes(b) });
  }
  return out;
}

test('every label field of the corpus is SEC-35-safe', async () => {
  const all = corpus();
  assert.ok(all.length > 150, `corpus of ${all.length} blobs`);
  let symbolUnits = 0;
  for (const { name, path, bytes } of all) {
    let t: RegionTable;
    try {
      t = await testTable(path, bytes);
    } catch (e) {
      // classes 1, 2, 3 and 5 have no table (conflict markers, small grammarless): nothing to check
      assert.match(String(e), /path class [1235] has no table/, name);
      continue;
    }
    for (const u of t.units) {
      const fields = [u.label.qualname, u.label.simple, u.label.type, u.label.disc];
      if (u.granularity === 'block') {
        assert.deepEqual(u.label, { kind: 'block', qualname: '', simple: '', type: '', disc: '' }, name);
        continue;
      }
      symbolUnits++;
      assert.match(u.label.kind, SEC35, name);
      for (const f of fields) if (f !== '') assert.match(f, SEC35, `${name}: ${JSON.stringify(u.label)}`);
    }
  }
  assert.ok(symbolUnits > 1_000, `${symbolUnits} symbol units checked`);
});

test('a label field outside SEC-35 validLabel is never emitted: the unit is unlabeled and not counted', async () => {
  // the table's pattern is SEC-35's (Task 8's validLabel must use the same one)
  assert.equal(VALID_LABEL_FIELD.source, SEC35.source);
  assert.equal(VALID_LABEL_FIELD.flags, SEC35.flags);
  const unlabeled = (kind: string): Label => ({ kind, qualname: '', simple: '', type: '', disc: '' });
  const allSafe = (t: RegionTable): void => {
    for (const u of t.units) for (const f of [u.label.qualname, u.label.simple, u.label.type, u.label.disc]) if (f !== '') assert.match(f, SEC35, JSON.stringify(u.label));
  };
  // C# pointer and function-pointer parameter types: `*` is outside the pattern, so the overload discriminator cannot be emitted
  const cs = await testTable('m.cs', py([
    'class P',                                        // 1
    '{',                                              // 2
    '    unsafe void Ptr(int* p) {}',                 // 3
    '    unsafe void Fp(delegate*<int, void> f) {}',  // 4
    '    void Ok(int p) {}',                          // 5
    '}',                                              // 6
  ]));
  allSafe(cs);
  assert.deepEqual(cs.units.filter((u) => u.kind === 'method').map((u) => [u.label, u.ranges]), [
    [unlabeled('method'), [[3, 3]]],
    [unlabeled('method'), [[4, 4]]],
    [{ kind: 'method', qualname: 'P.Ok', simple: 'Ok', type: 'P', disc: '(int)' }, [[5, 5]]],
  ]);
  assert.deepEqual(cs.labelCounts, { 'type\u{0}P\u{0}': 1, 'method\u{0}P.Ok\u{0}(int)': 1 }, 'unlabeled units are not counted');
  // JS computed keys: `+`, quotes and spaces are outside the pattern; `[Symbol.iterator]` is inside it
  const js = await testTable('m.js', py([
    'const o = {',                       // 1
    '  [a + b]() {},',                   // 2
    "  ['x' + y]: function () {},",      // 3
    '  [Symbol.iterator]() {},',         // 4
    '};',                                // 5
    'class K {',                         // 6
    '  [a + b]() {}',                    // 7
    '  ok() {}',                         // 8
    '}',                                 // 9
  ]));
  allSafe(js);
  assert.deepEqual(js.units.filter((u) => u.kind === 'method').map((u) => [u.label, u.ranges]), [
    [unlabeled('method'), [[2, 2]]],
    [unlabeled('method'), [[3, 3]]],
    [{ kind: 'method', qualname: 'o.[Symbol.iterator]', simple: '[Symbol.iterator]', type: '', disc: '' }, [[4, 4]]],
    [unlabeled('method'), [[7, 7]]],
    [{ kind: 'method', qualname: 'K.ok', simple: 'ok', type: 'K', disc: '' }, [[8, 8]]],
  ]);
  assert.deepEqual(js.labelCounts, { 'method\u{0}o.[Symbol.iterator]\u{0}': 1, 'class\u{0}K\u{0}': 1, 'method\u{0}K.ok\u{0}': 1 });
  // a type whose own name fails (a C# Unicode escape: `\` is outside the pattern) takes its members' labels with it, because
  // their qualname and type carry its name
  const bad = await testTable('m.cs', py(['class Q\\u0031', '{', '    void N() {}', '}']));
  allSafe(bad);
  assert.equal(bad.errorCount, 0);
  assert.deepEqual(bad.units.map((u) => [u.kind, u.label]), [['type', unlabeled('type')], ['type', unlabeled('type')], ['method', unlabeled('method')]]);
  assert.deepEqual(bad.labelCounts, {});
});

/** labelCounts recomputed test-side: one count per labelled leaf symbol unit (a class through its residue). */
function tally(t: RegionTable): Record<string, number> {
  const out: Record<string, number> = {};
  for (const u of t.units) if (u.leaf && u.granularity === 'symbol' && u.label.qualname !== '') out[labelKey(u.label)] = (out[labelKey(u.label)] ?? 0) + 1;
  return out;
}

test('error spans, error counts and label counts', async () => {
  const broken: Record<string, number> = { 'cs_brace/broken.cs': 7, 'js_brace/broken.js': 11, 'py_paren/broken.py': 26, 'py_triple_quote/broken.py': 15 };
  const keys = (t: RegionTable): string[] => Object.keys(t.labelCounts).map((k) => k.replace(/\u{0}/gu, '|')).sort();
  for (const [name, row] of Object.entries(broken)) {
    const t = await testTable(`errors/S7/${name}`, fixture(`errors/S7/${name}`));
    assert.ok(t.errorCount >= 1, name);
    assert.ok(rangesIntersect(t.errorSpans, [[row, row]]), `${name}: an error span covers row ${row}: ${JSON.stringify(t.errorSpans)}`);
    const clean = name.replace(/broken/, 'clean');
    const c = await testTable(`errors/S7/${clean}`, fixture(`errors/S7/${clean}`));
    assert.equal(c.errorCount, 0, clean);
    assert.deepEqual(c.errorSpans, [], clean);
    // label counts: each key of a clean file once; a broken tree loses keys and never invents one (04 §3.14, S7)
    assert.deepEqual(c.labelCounts, tally(c), clean);
    assert.deepEqual(t.labelCounts, tally(t), name);
    assert.ok(Object.values(c.labelCounts).every((n) => n === 1), clean);
    assert.ok(keys(t).every((k) => keys(c).includes(k)) && keys(t).length < keys(c).length, `${name}: ${JSON.stringify(keys(t))} ⊊ ${JSON.stringify(keys(c))}`);
  }
  const cs = await testTable('errors/S7/cs_brace/clean.cs', fixture('errors/S7/cs_brace/clean.cs'));
  assert.deepEqual(keys(cs), ['method|N.Pricing.Calc|(double)', 'method|N.Pricing.Calc|(int)', 'method|N.Pricing.Describe|()', 'method|N.Pricing.Twice|(int)', 'type|N.Pricing|']);
  const half = await testTable('m.py', fixture('rc_touch/py_boundary_insert_half_typed.post.py'));
  assert.ok(rangesIntersect(half.errorSpans, [[5340, 5340]]), `row 5340 lies in an error span: ${JSON.stringify(half.errorSpans)}`);
  assert.deepEqual(unitNamed(half, 'compute_total')?.ranges, [[5331, 5339]]);
  const append = await testTable('m.py', fixture('rc_touch/py_append_after_last_line.post.py'));
  assert.deepEqual(unitNamed(append, 'compute_total')?.ranges, [[5331, 5340]], '04 §3.6 "post extent 5331–5340"');
  assert.equal(append.errorCount, 0);
  // both posts keep the base's 413 label keys, each counted once (compute_total included)
  const base = await testTable('big_lf.py', fixture('big_lf.py'));
  assert.equal(Object.keys(base.labelCounts).length, 413);
  for (const t of [half, append]) {
    assert.deepEqual(t.labelCounts, tally(t));
    assert.deepEqual(t.labelCounts, base.labelCounts);
  }
  assert.equal(append.labelCounts[labelKey({ kind: 'function', qualname: 'compute_total', simple: 'compute_total', type: '', disc: '' })], 1);
});

test('432 identical units in both forms', async () => {
  const wt = await testTable('big_wt.py', fixture('big_wt.py'));
  const lf = await testTable('big_lf.py', fixture('big_lf.py'));
  assert.equal(wt.units.filter((u) => u.leaf).length, BIG_UNITS);
  assert.equal(lf.units.filter((u) => u.leaf).length, BIG_UNITS);
  assert.equal(wt.lineCount, 5_960);
  assert.deepEqual(wt, lf, 'units, ranges, labels, imports, errorSpans, labelCounts and lineCount');
  assert.deepEqual(wt.imports, [3, 8]);
  assert.equal(wt.errorCount, 0);
  // the hot zone (HOT_ZONE)
  assert.deepEqual(unitNamed(wt, 'compute_total')?.ranges, [[5331, 5339]]);
  assert.deepEqual(unitNamed(wt, 'Account.balance', '')?.ranges, [[5306, 5308]]);
  assert.deepEqual(unitNamed(wt, 'Account.balance', 'setter')?.ranges, [[5310, 5314]]);
  assert.deepEqual(unitNamed(wt, 'parse')?.ranges, [[5317, 5328]]);
  assert.deepEqual(unitNamed(wt, 'compute_tax')?.ranges, [[5342, 5344]]);
  assert.deepEqual(wt.units.find((u) => !u.leaf && u.label.qualname === 'Account')?.ranges, [[5300, 5314]]);
  // the BOM+CRLF bytes as a DiskSnapshotId give the same table
  const store = new SnapshotStore();
  const disk = await testTable('big_wt.py', fixture('big_wt.py'), { ref: testSnapshot(store, 'big_wt.py', fixture('big_wt.py')) });
  assert.deepEqual(disk, lf);
});

test('incremental and cold parses give the same table', async () => {
  const rt = await testRegionRuntime();
  const inc = await initParser(testWorkerInit(rt));
  const cold = await initParser(testWorkerInit(rt));
  const table = async (host: typeof inc, path: string, bytes: Buffer, prevRef: Buffer | null): Promise<RegionTable> => {
    const t = await handleTable({ kind: 'table', lang: path.endsWith('.cs') ? 'c_sharp' : path.endsWith('.js') ? 'javascript' : 'python', cls: 4, ref: blobIdOf(bytes), bytes, regionSpec: rt.regionSpec, prevRef: prevRef === null ? null : blobIdOf(prevRef) }, { parser: host, deadline: null });
    assert.ok(t !== 'deadline' && 'units' in t);
    return t;
  };
  try {
    let incremental = 0;
    const original = Parser.prototype.parse;
    Parser.prototype.parse = function (this: Parser, ...args: Parameters<Parser['parse']>): ReturnType<Parser['parse']> {
      if (args[1] instanceof Tree) incremental++;
      return original.apply(this, args);
    };
    try {
      for (const pair of RC_TOUCH_R2) {
        const base = fixture(pair.base);
        const post = fixture(pair.post);
        await table(inc, pair.base, base, null);
        const viaInc = await table(inc, pair.base, post, base);
        const viaCold = await table(cold, pair.base, post, null);
        assert.deepEqual(withoutSigSlice(viaInc.units), withoutSigSlice(viaCold.units), pair.name);
        assert.deepEqual(viaInc, viaCold, pair.name);
      }
    } finally {
      Parser.prototype.parse = original;
    }
    assert.equal(incremental, RC_TOUCH_R2.length, 'every post re-parsed from its base tree');

    // ≤ BUDGETS.liveTreesPerWorker (8) live trees per worker: nine distinct parses keep the newest eight
    const host = await initParser(testWorkerInit(rt));
    try {
      const blobs = Array.from({ length: 9 }, (_, i) => py([`def f${i}():`, `    return ${i}`]));
      for (const b of blobs) await table(host, 'm.py', b, null);
      assert.equal(host.liveKeys().length, 8);
      assert.ok(!host.liveKeys().some((k) => k.includes(blobIdOf(blobs[0]!))), 'the oldest tree was evicted');
      assert.ok(host.liveKeys().some((k) => k.includes(blobIdOf(blobs[8]!))));
    } finally {
      host.dispose();
    }
  } finally {
    inc.dispose();
    cold.dispose();
  }
});

test('the incremental re-parse state is per ParserHost: two hosts in one realm keep their own', async () => {
  // a SIM runs several peers' inline workers in one realm: one host's parse must not drop another host's incremental state
  const rt = await testRegionRuntime();
  const a = await initParser(testWorkerInit(rt));
  const b = await initParser(testWorkerInit(rt));
  const table = async (host: typeof a, bytes: Buffer, prev: Buffer | null): Promise<RegionTable> => {
    const t = await handleTable({ kind: 'table', lang: 'python', cls: 4, ref: blobIdOf(bytes), bytes, regionSpec: rt.regionSpec, prevRef: prev === null ? null : blobIdOf(prev) }, { parser: host, deadline: null });
    assert.ok(t !== 'deadline' && 'units' in t);
    return t;
  };
  const aBase = py(['def f():', '    return 1']);
  const aPost = py(['def f():', '    return 1 + 1']);
  const bBase = py(['def g():', '    return 2']);
  const bPost = py(['def g():', '    return 2 + 2']);
  const original = Parser.prototype.parse;
  const incremental: string[] = [];
  Parser.prototype.parse = function (this: Parser, ...args: Parameters<Parser['parse']>): ReturnType<Parser['parse']> {
    if (args[1] instanceof Tree) incremental.push(String(args[0]).split('\n')[0] ?? '');
    return original.apply(this, args);
  };
  try {
    await table(a, aBase, null);
    await table(b, bBase, null);   // host b's parse between host a's base and post
    const viaA = await table(a, aPost, aBase);
    await table(b, bPost, bBase);
    assert.deepEqual(incremental, ['def f():', 'def g():'], 'each host re-parsed its post from its own base tree');
    assert.deepEqual(viaA.units.map((u) => u.label.qualname), ['f']);
  } finally {
    Parser.prototype.parse = original;
    a.dispose();
    b.dispose();
  }
});
