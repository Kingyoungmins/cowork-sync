// The relative region tripwires (Plan 4 Task 7; 04 §3.15 forms (a)–(c); REG-24, INV-REG-TRIPWIRE, T-REG-08, TC-REG-01's
// tripwire half (R4-80); R1-055, R2-B04, glossary §10 K7). Tables come from RegionService.table over inlineWorkers with the
// pinned grammars (DiskSnapshotIds, no git); theirs = TIP's blob, ours = the local side, out = the merge or concat output.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { decodeStrict } from '../../src/regions/lines.js';
import { regionTripwire, type TripwireViolation } from '../../src/regions/tripwire.js';
import { labelKey, type RegionTable, type TableOrNone } from '../../src/regions/types.js';
import { fixture, fixtureBytes, sweepScenario } from '../helpers/regionFixtures.js';
import { unitService, type UnitService } from '../helpers/regionUnitService.js';

let u: UnitService;
before(async () => {
  u = await unitService();
});
after(async () => {
  await u.close();
});

const u8 = (s: string): Buffer => Buffer.from(s, 'utf8');
const rowsOf = (lines: readonly string[]): Buffer => u8(`${lines.join('\n')}\n`);
const isTable = (t: TableOrNone): t is RegionTable => !('kind' in t);
const decodes = (b: Buffer | null): boolean => b !== null && decodeStrict(b) !== null;

/** regionTripwire over the tables of three blobs of one path (a null blob = an absent path). */
async function trip(path: string, theirs: Buffer | null, ours: Buffer | null, out: Buffer): Promise<TripwireViolation[]> {
  const t = theirs === null ? null : await u.table(path, theirs);
  const o = ours === null ? null : await u.table(path, ours);
  return regionTripwire(t, o, await u.table(path, out), { theirs: decodes(theirs), out: decodes(out) });
}

async function errorCount(path: string, b: Buffer): Promise<number> {
  const t = await u.table(path, b);
  assert.ok(isTable(t) && t.grammar !== null, `${path} has a symbol table`);
  return t.errorCount;
}

/** A fixture's rows split on 0x0A (the last element is '' when it ends with a newline) and joined back unchanged. */
const split = (b: Buffer): string[] => b.toString('utf8').split('\n');
const joined = (rows: readonly string[]): Buffer => u8(rows.join('\n'));

test('form (a): errorCount(out) above errorCount(theirs) is a violation, equal or lower is not, and a new path counts theirs as 0', async () => {
  const theirs = rowsOf(['def a():', '    x = foo(1, 2', '    return x', '', '', 'def b():', '    return 1']);
  const n = await errorCount('p.py', theirs);
  assert.ok(n >= 1, 'theirs carries the unclosed paren in def a()');
  const bodyEdit = rowsOf(['def a():', '    x = foo(1, 2', '    return x', '', '', 'def b():', '    return 2']);
  assert.deepEqual(await trip('p.py', theirs, theirs, bodyEdit), []);
  const bracket = rowsOf(['def a():', '    x = foo(1, 2', '    return x', '', '', 'def b():', '    y = [1, 2', '    return 1']);
  const m = await errorCount('p.py', bracket);
  assert.ok(m > n);
  assert.deepEqual(await trip('p.py', theirs, theirs, bracket), [{ form: 'a', theirs: n, out: m }]);
  const fixed = rowsOf(['def a():', '    x = foo(1, 2)', '    return x', '', '', 'def b():', '    return 1']);
  assert.deepEqual(await trip('p.py', theirs, theirs, fixed), []);
  // a new path: theirs = null counts 0 errors
  assert.deepEqual(await trip('p.py', null, fixed, fixed), []);
  const fresh = rowsOf(['def c():', '    y = [1, 2', '    return 1']);
  assert.deepEqual(await trip('p.py', null, fresh, fresh), [{ form: 'a', theirs: 0, out: await errorCount('p.py', fresh) }]);
});

const COMPUTE_TOTAL = ['def compute_total(items):', '    return sum(items)', ''];
const KEY_COMPUTE_TOTAL = labelKey({ kind: 'function', qualname: 'compute_total', simple: 'compute_total', type: '', disc: '' });

test('form (b): a label key counted in out above max(theirs, ours) is a violation', async () => {
  const once = rowsOf(['import os', '', '', ...COMPUTE_TOTAL, '', 'def other():', '    return 1']);
  assert.deepEqual(await trip('o.py', once, once, once), []);
  const twice = rowsOf(['import os', '', '', ...COMPUTE_TOTAL, '', ...COMPUTE_TOTAL, '', 'def other():', '    return 1']);
  assert.deepEqual(await trip('o.py', once, once, twice), [{ form: 'b', key: KEY_COMPUTE_TOTAL, theirs: 1, ours: 1, out: 2 }]);
  // the concat shape (ours = LOCAL): LOCAL adds helper once → no violation; both sides have it and out has two → one violation
  const base = rowsOf(['def main():', '    return 0']);
  const helper = rowsOf(['def main():', '    return 0', '', '', 'def helper():', '    return 1']);
  assert.deepEqual(await trip('c.py', base, helper, helper), []);
  const concat = rowsOf(['def main():', '    return 0', '', '', 'def helper():', '    return 1', '', '', 'def helper():', '    return 1']);
  const key = labelKey({ kind: 'function', qualname: 'helper', simple: 'helper', type: '', disc: '' });
  assert.deepEqual(await trip('c.py', helper, helper, concat), [{ form: 'b', key, theirs: 1, ours: 1, out: 2 }]);
});

/** `# 한글 주석` in cp949 (EUC-KR bytes: not UTF-8). */
const CP949_COMMENT = Buffer.from([0x23, 0x20, 0xc7, 0xd1, 0xb1, 0xdb, 0x20, 0xc1, 0xd6, 0xbc, 0xae, 0x0a]);

test('form (c): theirs decodes as UTF-8 and out does not', async () => {
  const theirs = rowsOf(['# a comment', 'def a():', '    return 1']);
  const out = Buffer.from(theirs);
  out[3] = 0xff;   // inside the comment: no longer UTF-8
  assert.equal(decodeStrict(out), null);
  const outTable = await u.table('p.py', out);
  // a non-decodable path is class 5 (≤ 300 rows: NO_TABLE{grammarless_small}) or class 6 (a block table): no symbol table either way
  assert.ok(isTable(outTable) ? outTable.grammar === null && !outTable.decodable : outTable.reason === 'grammarless_small', 'out has the class-5/6 table of a non-decodable path');
  const vs = await trip('p.py', theirs, theirs, out);
  assert.deepEqual(vs, [{ form: 'c' }], 'and no form-(a)/(b) entry: out has no symbol table');
  // cp949 on both sides: theirs did not decode, so (c) does not apply
  const cpTheirs = Buffer.concat([CP949_COMMENT, u8('def a():\n    return 1\n')]);
  const cpOut = Buffer.concat([CP949_COMMENT, u8('def a():\n    return 2\n')]);
  assert.deepEqual(await trip('p.py', cpTheirs, cpTheirs, cpOut), []);
});

test('T-REG-08 unit: the absolute forms are never applied', async () => {
  // rc_valid_errors: valid C# whose #if/#else around a method header yields ERROR/MISSING nodes (04 §3.15 VERIFIED rc_valid_errors)
  const cs = fixture('errors/rc_valid_errors.cs');
  const csRows = split(cs);
  const n = await errorCount('Report.cs', cs);
  assert.ok(n > 0, 'the valid base already carries error nodes');
  const csEdit = joined(csRows.map((r) => (r === '            _count++;' ? '            _count += 2;' : r)));
  assert.deepEqual(await trip('Report.cs', cs, csEdit, csEdit), [], 'an edit to another method publishes');
  const addRows = csRows.slice(17, 21);   // public void Add() { … } (rows 18–21)
  assert.equal(addRows[0], '        public void Add()');
  const csDup = joined([...csRows.slice(0, 21), '', ...addRows, ...csRows.slice(21)]);
  const addKey = labelKey({ kind: 'method', qualname: 'N.Report.Add', simple: 'Add', type: 'N.Report', disc: '()' });
  assert.deepEqual(await trip('Report.cs', cs, csEdit, csDup), [{ form: 'b', key: addKey, theirs: 1, ours: 1, out: 2 }], 'a second copy of an existing method');
  const csOpen = joined([...csRows.slice(0, 19), '            if (_count > 0) {', ...csRows.slice(19)]);
  const open = await trip('Report.cs', cs, cs, csOpen);
  assert.deepEqual(open, [{ form: 'a', theirs: n, out: await errorCount('Report.cs', csOpen) }], 'an unclosed brace in another method');
  // rc_dupes: Account.value ×2 (getter/setter) and open_console ×2 (platform branches) in a valid base
  const py = fixture('dupes/rc_dupes.py');
  const pyRows = split(py);
  const pyEdit = joined(pyRows.map((r) => (r === '    return account.value' ? '    return account.value + 0' : r)));
  assert.deepEqual(await trip('accounts.py', py, pyEdit, pyEdit), [], 'an unrelated edit publishes');
  const pyDup = joined([...pyRows.slice(0, 14), '', '    @property', '    def value(self):', '        return self._value', ...pyRows.slice(14)]);
  const valueKey = labelKey({ kind: 'method', qualname: 'Account.value', simple: 'value', type: 'Account', disc: '' });
  assert.deepEqual(await trip('accounts.py', py, pyEdit, pyDup), [{ form: 'b', key: valueKey, theirs: 1, ours: 1, out: 2 }]);
  const pyOpen = joined(pyRows.map((r) => (r === '    return account.value' ? '    return [account.value' : r)));
  assert.deepEqual(await trip('accounts.py', py, py, pyOpen), [{ form: 'a', theirs: 0, out: await errorCount('accounts.py', pyOpen) }]);
});

test('TC-REG-01 tripwire counts: the same-file duplicate splices are flagged by form (b) and the undecodable one by form (c)', async () => {
  for (const name of ['S2a', 'S3a', 'S3b', 'S3c', 'S6b']) {
    const sc = sweepScenario(name);
    assert.equal(sc.caughtBy, 'tripwire_b', `${name} is caught by form (b) (R4-80)`);
    assert.ok(sc.duplicatedKey !== undefined && sc.corruptOut !== undefined, name);
    let hit = false;
    for (const [path, outBytes] of Object.entries(sc.corruptOut)) {
      if (outBytes === null) continue;
      const f = sc.files[path];
      assert.ok(f !== undefined, `${name}: ${path} is a scenario file`);
      const theirs = f.theirs === undefined || f.theirs === null ? null : fixtureBytes(f.theirs);
      const ours = f.ours === undefined || f.ours === null ? null : fixtureBytes(f.ours);
      const vs = await trip(path, theirs, ours, fixtureBytes(outBytes));
      assert.ok(!vs.some((v) => v.form === 'a'), `${name} ${path}: no form-(a) violation`);
      for (const v of vs) {
        if (v.form !== 'b' || v.key !== sc.duplicatedKey) continue;
        assert.equal(v.out, Math.max(v.theirs, v.ours) + 1, `${name}: out = max(theirs, ours) + 1`);
        hit = true;
      }
    }
    assert.ok(hit, `${name}: a form-(b) violation for ${JSON.stringify(sc.duplicatedKey)}`);
  }
  const s8 = sweepScenario('S8');
  assert.equal(s8.caughtBy, 'tripwire_c');
  assert.ok(s8.corruptOut !== undefined);
  for (const [path, outBytes] of Object.entries(s8.corruptOut)) {
    if (outBytes === null) continue;
    const f = s8.files[path];
    assert.ok(f !== undefined && f.theirs !== undefined && f.theirs !== null && f.ours !== undefined && f.ours !== null);
    assert.deepEqual(await trip(path, fixtureBytes(f.theirs), fixtureBytes(f.ours), fixtureBytes(outBytes)), [{ form: 'c' }], `S8 ${path}`);
  }
});

// ---- INV-REG-TRIPWIRE property --------------------------------------------------------------------------------------------

const VOCAB = ['alpha', 'beta', 'gamma', 'delta', 'eps', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lam', 'mu'] as const;
type UnitTpl = { kind: 'function' | 'class' | 'const'; name: string };
const unitArb = fc.record({ kind: fc.constantFrom('function' as const, 'class' as const, 'const' as const), name: fc.constantFrom(...VOCAB) });
const unitsArb = fc.array(unitArb, { minLength: 1, maxLength: 20 });

/** A unit's rows: Python or TypeScript, each unit followed by a blank row. */
function unitRows(lang: 'python' | 'typescript', t: UnitTpl): string[] {
  if (lang === 'python') {
    if (t.kind === 'function') return [`def ${t.name}(a):`, '    return a', ''];
    if (t.kind === 'class') return [`class ${t.name}:`, '    def m(self):', '        return 1', ''];
    return [`${t.name} = 1`, ''];
  }
  if (t.kind === 'function') return [`function ${t.name}(a: number): number {`, '  return a;', '}', ''];
  if (t.kind === 'class') return [`class ${t.name} {`, '  m(): number {', '    return 1;', '  }', '}', ''];
  return [`const ${t.name} = (a: number): number => a;`, ''];
}

const fileOf = (lang: 'python' | 'typescript', ts: readonly UnitTpl[]): string[] => ts.flatMap((t) => unitRows(lang, t));

test('INV-REG-TRIPWIRE property (≥ 1,000 cases)', async () => {
  for (const lang of ['python', 'typescript'] as const) {
    const path = lang === 'python' ? 'gen.py' : 'gen.ts';
    await fc.assert(fc.asyncProperty(unitsArb, unitsArb, fc.nat(), fc.nat(), async (tUnits, oUnits, pick, row) => {
      const tRows = fileOf(lang, tUnits);
      const t = rowsOf(tRows);
      const o = rowsOf(fileOf(lang, oUnits));
      const tt = await u.table(path, t);
      const ot = await u.table(path, o);
      assert.ok(isTable(tt) && tt.grammar !== null && tt.errorCount === 0, 'the generated file is valid');
      assert.ok(isTable(ot) && ot.grammar !== null);
      // (i) out = theirs: never a violation
      assert.deepEqual(regionTripwire(tt, ot, tt, { theirs: true, out: true }), []);
      // (ii) one labelled top-level unit of t duplicated (its rows copied after it)
      const top = tt.units.filter((x) => x.parentUnitId === null && x.label.qualname !== '' && x.granularity === 'symbol');
      const unit = top[pick % top.length];
      assert.ok(unit !== undefined);
      const key = labelKey(unit.label);
      const [lo, hi] = unit.ranges[0] as readonly [number, number];
      const dupRows = [...tRows.slice(0, hi), '', ...tRows.slice(lo - 1, hi), ...tRows.slice(hi)];
      const dupT = await u.table(path, rowsOf(dupRows));
      const countT = tt.labelCounts[key] ?? 0;
      if ((ot.labelCounts[key] ?? 0) <= countT) {
        const vs = regionTripwire(tt, ot, dupT, { theirs: true, out: true }).filter((v) => v.form === 'b' && v.key === key);
        assert.deepEqual(vs, [{ form: 'b', key, theirs: countT, ours: ot.labelCounts[key] ?? 0, out: countT + 1 }]);
      }
      // (iii) one `(` inserted at a statement start of the valid t
      const starts = tRows.map((r, i) => ({ r, i })).filter(({ r }) => r.trim() !== '' && !/^\s*}/.test(r));
      const at = starts[row % starts.length];
      assert.ok(at !== undefined);
      const indent = /^\s*/.exec(at.r)?.[0] ?? '';
      const broken = [...tRows];
      broken[at.i] = `${indent}(${at.r.slice(indent.length)}`;
      const bt = await u.table(path, rowsOf(broken));
      assert.ok(regionTripwire(tt, ot, bt, { theirs: true, out: true }).some((v) => v.form === 'a'), `a ( at row ${at.i + 1} is a form-(a) violation`);
    }), { numRuns: 1_000 });
  }
});

test('regionTripwire reads tables and decode flags only', async () => {
  const src = readFileSync(new URL('../../src/regions/tripwire.ts', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+['"]([^'"]+)['"]/gmu)].map((m) => m[1]);
  assert.deepEqual([...new Set(imports)], ['./types.js'], 'tripwire.ts imports only src/regions/types.ts');
  assert.ok(!/\brequire\(|\bimport\(/u.test(src), 'and loads nothing else');
  // the verdict comes from labelCounts, errorCount and the decode flags: renaming every label of ours changes nothing
  const theirs = await u.table('o.py', rowsOf(['import os', '', '', ...COMPUTE_TOTAL]));
  const ours = await u.table('o.py', rowsOf(['import os', '', '', ...COMPUTE_TOTAL, '', 'def x():', '    return 1']));
  const out = await u.table('o.py', rowsOf(['import os', '', '', ...COMPUTE_TOTAL, '', ...COMPUTE_TOTAL, '', 'def x(', '    return 1']));
  assert.ok(isTable(ours));
  const renamed: RegionTable = { ...ours, units: ours.units.map((x) => ({ ...x, label: { ...x.label, qualname: `x${x.label.qualname}` } })) };
  const flags = { theirs: true, out: true };
  const before = regionTripwire(theirs, ours, out, flags);
  assert.ok(before.some((v) => v.form === 'a') && before.some((v) => v.form === 'b'), 'the case has both forms');
  assert.deepEqual(regionTripwire(theirs, renamed, out, flags), before);
});
