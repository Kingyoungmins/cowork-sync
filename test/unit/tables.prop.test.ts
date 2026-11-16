// Properties of the region tables (Plan 4 Task 4; ≥ 1,000 fast-check cases per property per language, R4-64):
// TC-REG-03 / T-REG-03's property half (tree-sitter rows equal 0x0A-split rows in the LF, CRLF and BOM+CRLF forms; R1-061,
// REG-01) and T-REG-23 (INV-REG-PARTITION: leaf units, <imports> and gap blocks partition the non-blank rows; R1-034, R4-18,
// OQ-15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { isBlankRow, lineArray } from '../../src/regions/lines.js';
import type { Range, RegionTable } from '../../src/regions/types.js';
import { formVariant, unitFileArb } from '../helpers/regionFixtures.js';
import { testTable } from '../helpers/regionRuntime.js';

const RUNS = 1_000;

/** Text pieces that must not move a row: Hangul, an astral emoji, U+2028 (a JS/Unicode line separator that is not 0x0A) and curly quotes. */
const PIECES = ['\u{d55c}\u{ae00}', '\u{1F600}', '\u{2028}', '\u{2018}x\u{2019}', '\u{201C}y\u{201D}', 'plain', ' '];
const textArb = fc.array(fc.constantFrom(...PIECES), { minLength: 0, maxLength: 6 }).map((a) => a.join(''));
/** Comments hold every piece but U+2028, which C# reads as a line terminator (a comment ends there); it stays inside string literals. */
const commentArb = fc.array(fc.constantFrom(...PIECES.filter((p) => p !== '\u{2028}')), { minLength: 0, maxLength: 6 }).map((a) => a.join(''));

/** attached[n]: unit n has a comment row directly above its declaration row (extent-convention/1 step 2 starts it there). */
interface Gen { readonly rows: string[]; readonly markers: number; readonly attached: readonly boolean[]; }

/** A Python file: functions whose def row carries `# MARK-<n>`, string literals holding the pieces, Hangul comments, blank rows. */
const pyArb: fc.Arbitrary<Gen> = fc.array(fc.record({ comment: fc.option(commentArb, { nil: null }), body: textArb, blank: fc.nat(2) }), { minLength: 1, maxLength: 8 })
  .map((fs) => {
    const rows: string[] = [];
    fs.forEach((f, n) => {
      if (f.comment !== null) rows.push(`# ${f.comment}`);
      rows.push(`def f_${n}():  # MARK-${n}`, `    s = "${f.body}"`, `    t = '''${f.body}`, `${f.body}'''`, '    return s', ...Array.from({ length: f.blank }, () => ''));
    });
    return { rows, markers: fs.length, attached: fs.map((f) => f.comment !== null) };
  });

/** A C# file: one class whose methods carry `// MARK-<n>` on their header row, verbatim strings holding the pieces. */
const csArb: fc.Arbitrary<Gen> = fc.array(fc.record({ comment: fc.option(commentArb, { nil: null }), body: textArb, blank: fc.nat(2) }), { minLength: 1, maxLength: 8 })
  .map((fs) => {
    const rows: string[] = ['namespace N', '{', '    public class Svc', '    {'];
    fs.forEach((f, n) => {
      if (f.comment !== null) rows.push(`        // ${f.comment}`);
      rows.push(`        public string M_${n}() // MARK-${n}`, '        {', `            var s = @"${f.body}";`, `            return s + "${f.body.replace(/\u{2028}/gu, '')}";`, '        }', ...Array.from({ length: f.blank }, () => ''));
    });
    rows.push('    }', '}');
    return { rows, markers: fs.length, attached: fs.map((f) => f.comment !== null) };
  });

const lf = (g: Gen): Buffer => Buffer.from(`${g.rows.join('\n')}\n`, 'utf8');
const shape = (t: RegionTable): unknown => t.units.map((u) => [u.kind, u.label, u.ranges, u.leaf, u.residue]);

async function rowsProperty(path: string, arb: fc.Arbitrary<Gen>, simple: (n: number) => string): Promise<void> {
  await fc.assert(fc.asyncProperty(arb, async (g) => {
    const base = lf(g);
    const forms = [base, formVariant(base, { bom: false, crlf: true }), formVariant(base, { bom: true, crlf: true })];
    const tables: RegionTable[] = [];
    for (const b of forms) tables.push(await testTable(path, b));
    assert.deepEqual(shape(tables[1]!), shape(tables[0]!), 'CRLF form');
    assert.deepEqual(shape(tables[2]!), shape(tables[0]!), 'BOM+CRLF form');
    for (const [b, t] of forms.map((b, i) => [b, tables[i]!] as const)) {
      const rows = lineArray(b);
      for (let n = 0; n < g.markers; n++) {
        const at = rows.findIndex((r) => r.includes(Buffer.from(`MARK-${n}`, 'ascii')));
        const unit = t.units.find((u) => u.label.simple === simple(n));
        assert.ok(unit !== undefined && at >= 0, `unit ${simple(n)}`);
        // the marker sits on the declaration row: the unit starts there, or exactly one row above when the generator put a comment
        // directly above it (step 2); one row early without such a comment, or any other row, fails
        const first = unit.ranges[0]![0];
        const expected = at + 1 - (g.attached[n] === true ? 1 : 0);
        assert.equal(first, expected, `${simple(n)} starts at row ${first}, its marker is on row ${at + 1}${g.attached[n] === true ? ' below its comment' : ''}`);
      }
    }
  }), { numRuns: RUNS });
}

test('tree-sitter rows equal 0x0A-split rows in every form', { timeout: 600_000 }, async () => {
  await rowsProperty('m.py', pyArb, (n) => `f_${n}`);
  await rowsProperty('m.cs', csArb, (n) => `M_${n}`);
});

/** INV-REG-PARTITION over one table: returns nothing, asserts everything. */
function assertPartition(t: RegionTable, blob: Buffer): void {
  const rows = lineArray(blob);
  const owner = new Array<string | null>(rows.length + 1).fill(null);
  const claim = (r: Range, who: string): void => {
    for (let row = r[0]; row <= r[1]; row++) {
      assert.ok(row >= 1 && row <= rows.length, `${who}: row ${row} outside the file`);
      assert.equal(owner[row], null, `row ${row} is in ${owner[row]} and in ${who}`);
      owner[row] = who;
    }
  };
  if (t.imports !== null) claim(t.imports, '<imports>');
  for (const u of t.units) {
    if (!u.leaf) continue;
    const who = `${u.kind}:${u.label.qualname}#${u.unitId}`;
    for (const r of u.ranges) claim(r, who);
    if (u.kind === 'block') for (const r of u.ranges) for (let row = r[0]; row <= r[1]; row++) assert.ok(!isBlankRow(rows[row - 1]!, row), `blank row ${row} in a gap block`);
    if (!u.residue && u.granularity === 'symbol') assert.equal(u.ranges.length, 1, `${who} is one contiguous range`);
  }
  for (let row = 1; row <= rows.length; row++) {
    if (!isBlankRow(rows[row - 1]!, row)) assert.notEqual(owner[row], null, `non-blank row ${row} lies in no leaf unit, <imports> or gap block`);
  }
}

for (const [lang, path] of [['python', 'm.py'], ['javascript', 'm.js'], ['typescript', 'm.ts'], ['c_sharp', 'm.cs']] as const) {
  test(`leaf units, <imports> and gap blocks partition the non-blank rows (${lang})`, { timeout: 600_000 }, async () => {
    await fc.assert(fc.asyncProperty(unitFileArb(lang), async ({ text }) => {
      const blob = Buffer.from(text, 'utf8');
      const t = await testTable(path, blob);
      assert.equal(t.errorCount, 0, 'the generated files are valid');
      assertPartition(t, blob);
    }), { numRuns: RUNS });
  });
}
