// Region fixture corpus (Plan 4 Task 2; R4-21): the manifest and provenance README, the 5,960-row hot-zone file, the rc_touch R2
// table, the sweep scenarios S1–S10, the S9 generator, fwd/errors/dupes/interface/C# fixtures, forms, special paths, unitFileArb,
// hook payloads, the edit-check corpus and the hold scenarios. Test-side checks only; nothing here imports src/regions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { rows } from '../../src/data/rows.js';
import { seededRandom } from '../../src/ports/random.js';
import { generateBigBomCrlf } from '../sim/fixtures/bigBomCrlf.js';
import {
  BIG_UNITS,
  FIXTURE_MANIFEST,
  HOT_ZONE,
  RC_TOUCH_R2,
  bigBomCrlf,
  bigLf,
  editCheckCases,
  fixture,
  fixtureBytes,
  formVariant,
  holdScenario,
  hookPayload,
  oneDotThreeMb,
  s9Generator,
  sweepScenario,
  unitFileArb,
  type EditCheckCase,
  type FixtureBytes,
  type SweepScenario,
} from '../helpers/regionFixtures.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIX = join(REPO, 'test', 'fixtures', 'regions');
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

interface Entry {
  built: 'checked-in' | 'generated';
  source: string;
  spec: string;
  feeds: string[];
  form?: boolean;
  how?: string;
  bytes?: Array<{ at: string; hex: string; note: string }>;
  corrupting?: boolean;
  caughtBy?: string;
  duplicatedKey?: string;
  definitions?: Record<string, number>;
}
const MANIFEST = FIXTURE_MANIFEST as unknown as { fixtures: Record<string, Entry> };

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(FIX, p).split(sep).join('/'));
    }
  };
  walk(dir);
  return out;
}

const fatal = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function decodes(b: Buffer): boolean {
  try {
    fatal.decode(b);
    return true;
  } catch {
    return false;
  }
}
/** Rows as strings without their LF and one trailing CR (row 1's BOM removed). */
function strip(b: Buffer): string[] {
  return rows(b).map((r, i) => {
    let s = r.toString('utf8');
    if (i === 0 && s.startsWith('\u{feff}')) s = s.slice(1);
    if (s.endsWith('\n')) s = s.slice(0, -1);
    if (s.endsWith('\r')) s = s.slice(0, -1);
    return s;
  });
}
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;
const text = (f: FixtureBytes | null | undefined): string => (f === null || f === undefined ? '' : fixtureBytes(f).toString('utf8'));
const lines = (s: string): string[] => (s.endsWith('\n') ? s.slice(0, -1) : s).split('\n');

const SWEEP = ['S1', 'S2a', 'S2b', 'S3a', 'S3b', 'S3c', 'S4', 'S5a', 'S5b', 'S6a', 'S6b', 'S6c', 'S7', 'S8', 'S10a', 'S10b'];
const CORRUPTING = new Set(['S2a', 'S2b', 'S3a', 'S3b', 'S3c', 'S4', 'S5a', 'S5b', 'S6a', 'S6b', 'S8']);
const TRIPWIRE_B = new Set(['S2a', 'S3a', 'S3b', 'S3c', 'S6b']);
const S9_NAME = 's9/step0.txt';

// ---------------------------------------------------------------------------------------------------------------------------
// Manifest and provenance (R4-21)

test('manifest.json and README.md list the same fixtures and every listed file exists', () => {
  const names = Object.keys(MANIFEST.fixtures).sort();
  const readme = readFileSync(join(FIX, 'README.md'), 'utf8');
  const readmeNames = [...readme.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1] as string).sort();
  assert.deepEqual(readmeNames, names, 'the README table and manifest.json name the same fixtures');
  const checkedIn: string[] = [];
  for (const name of names) {
    const e = MANIFEST.fixtures[name] as Entry;
    assert.ok(e.built === 'checked-in' || e.built === 'generated', `${name}: built`);
    const onDisk = join(FIX, ...name.split('/'));
    if (e.built === 'checked-in') {
      assert.ok(existsSync(onDisk) && statSync(onDisk).isFile(), `${name} exists under test/fixtures/regions/`);
      checkedIn.push(name);
    } else {
      assert.ok(!existsSync(onDisk), `${name} is generated, not checked in`);
      assert.ok(fixture(name).length > 0, `${name} resolves through fixture()`);
    }
  }
  for (const g of ['big_wt.py', 'big_lf.py', 'big26k_bomcrlf.py', S9_NAME]) assert.equal(MANIFEST.fixtures[g]?.built, 'generated', g);
  for (const r of RC_TOUCH_R2) {
    assert.ok(MANIFEST.fixtures[r.post] !== undefined, `${r.post} is listed`);
    assert.ok(MANIFEST.fixtures[r.base] !== undefined, `${r.base} is listed`);
  }
  // No unlisted file, except .gitattributes (PF-4) and golden/ (the goldens belong to the tests that pin them).
  const unlisted = filesUnder(FIX).filter((p) => p !== '.gitattributes' && !p.startsWith('golden/') && MANIFEST.fixtures[p] === undefined);
  assert.deepEqual(unlisted, []);
  assert.deepEqual(filesUnder(FIX).filter((p) => p !== '.gitattributes' && !p.startsWith('golden/')).sort(), checkedIn.sort());
  assert.equal(readFileSync(join(FIX, '.gitattributes'), 'utf8'), '* -text\n');
});

test('every test id this task feeds has at least one fixture with its spec sentence', () => {
  const feeds = new Set<string>();
  const specText: Record<string, string> = {
    '04': readFileSync(join(REPO, 'docs', 'spec', '04-regions.md'), 'utf8'),
    '05': readFileSync(join(REPO, 'docs', 'spec', '05-holds.md'), 'utf8'),
    '11': readFileSync(join(REPO, 'docs', 'spec', '11-testing.md'), 'utf8'),
  };
  for (const [name, e] of Object.entries(MANIFEST.fixtures)) {
    assert.ok(Array.isArray(e.feeds), `${name}: feeds`);
    for (const f of e.feeds) feeds.add(f);
    const chapter = /^(04|05|11)\b/.exec(e.source)?.[1];
    assert.ok(chapter !== undefined, `${name}: source cites 04, 05 or 11 (${e.source})`);
    assert.ok(typeof e.spec === 'string' && e.spec.length >= 20, `${name}: a spec sentence`);
    assert.ok(specText[chapter]!.includes(e.spec), `${name}: the spec sentence is quoted verbatim from ${chapter}: ${e.spec}`);
    assert.ok(e.built === 'checked-in' || e.built === 'generated', `${name}: built`);
  }
  const wanted = [
    'T-REG-01', 'T-REG-02', 'T-REG-03', 'T-REG-06', 'T-REG-07', 'T-REG-08', 'T-REG-09', 'T-REG-10', 'T-REG-11', 'T-REG-14', 'T-REG-15',
    'T-REG-20', 'T-REG-21', 'T-REG-23', 'T-REG-28', 'T-REG-29',
    'TC-REG-01', 'TC-REG-02', 'TC-REG-03', 'TC-REG-04', 'TC-REG-05', 'TC-REG-06', 'TC-REG-07', 'TC-REG-08', 'TC-REG-09', 'TC-REG-10',
    '05-P5',
  ];
  assert.deepEqual(wanted.filter((id) => !feeds.has(id)), []);
  const readme = readFileSync(join(FIX, 'README.md'), 'utf8');
  assert.match(readme, /3\u{2013}4 peers/u, 'the README names the harness peer count');
  assert.match(readme, /bigBomCrlf\(5_960\)/, 'the BOM+CRLF file of at least 5k lines');
  assert.match(readme, /makeRepoFixture\([^)]*\{ ?filter: true ?\}\)/, 'the clean/smudge filter fixture');
});

test('fixture files are LF UTF-8 without BOM except the declared form fixtures', () => {
  const formPatterns = [
    /^forms\/[^/]*\.crlf\.[^/]*$/, /^forms\/[^/]*\.bom\.[^/]*$/, /^forms\/[^/]*\.utf16le\.[^/]*$/,
    /^special\/legacy_cp949\.cs$/, /^special\/legacy_cp949\.crlf\.cs$/, /^hooks\/lf_old_string_on_bomcrlf\/(before|after)\.[^/]*$/,
    /^sweep\/S8\/scenario\.json$/,
  ];
  const nonUtf8Cases = new Set(
    editCheckCases()
      .filter((c) => [c.A, c.R, c.TIP].some((side) => Object.values(side).some((v) => v !== null && typeof v !== 'string' && !decodes(fixtureBytes(v)))))
      .map((c) => `editcheck/${c.name}.json`),
  );
  assert.ok(nonUtf8Cases.size >= 5, 'the undecodable R and the cp949/UTF-16LE triples');
  const forms = Object.entries(MANIFEST.fixtures).filter(([, e]) => e.form === true).map(([n]) => n).sort();
  const expected = Object.keys(MANIFEST.fixtures).filter((n) => formPatterns.some((re) => re.test(n)) || nonUtf8Cases.has(n)).sort();
  assert.deepEqual(forms, expected, 'form: true is set on exactly the declared form fixtures');
  const loneSurrogate = /[\u{d800}-\u{dbff}](?![\u{dc00}-\u{dfff}])|(?<![\u{d800}-\u{dbff}])[\u{dc00}-\u{dfff}]/u;
  for (const name of filesUnder(FIX)) {
    const bytes = readFileSync(join(FIX, ...name.split('/')));
    const e = MANIFEST.fixtures[name];
    if (e?.form === true && !name.endsWith('.json')) continue;
    assert.ok(decodes(bytes), `${name} decodes as UTF-8`);
    assert.ok(!bytes.includes(0x0d), `${name} has no CR`);
    assert.ok(!bytes.subarray(0, 3).equals(BOM), `${name} has no BOM`);
    if (!name.endsWith('.json')) continue;
    // JSON fixtures: string contents are LF without BOM; {b64} only in form: true fixtures, each declared with its bytes.
    const b64s: Array<{ at: string; b64: string }> = [];
    const walk = (v: unknown, at: string): void => {
      if (typeof v === 'string') {
        assert.ok(!loneSurrogate.test(v), `${name} ${at}: no lone surrogate`);
        return;
      }
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
      else if (v !== null && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if (Object.keys(o).length === 1 && typeof o.b64 === 'string') b64s.push({ at, b64: o.b64 });
        else for (const [k, x] of Object.entries(o)) walk(x, at === '' ? k : `${at}.${k}`);
      }
    };
    walk(JSON.parse(bytes.toString('utf8')), '');
    if (e?.form !== true) {
      assert.deepEqual(b64s.map((b) => b.at), [], `${name}: no {b64} outside the form fixtures`);
      continue;
    }
    assert.ok(b64s.length > 0, `${name}: a form fixture holds {b64} content`);
    const declared = new Map((e.bytes ?? []).map((d) => [d.at, d]));
    for (const { at, b64 } of b64s) {
      const raw = fixtureBytes({ b64 });
      assert.equal(raw.toString('base64'), b64, `${name} ${at}: canonical base64`);
      assert.ok(!decodes(raw) || raw.includes(0x0d) || raw.subarray(0, 3).equals(BOM), `${name} ${at}: {b64} only for bytes a JSON string would not round-trip`);
      const d = declared.get(at);
      assert.ok(d !== undefined, `${name} ${at}: its bytes are declared in the manifest`);
      assert.ok(raw.includes(Buffer.from(d.hex, 'hex')), `${name} ${at}: holds ${d.hex} (${d.note})`);
    }
  }
  // Byte form fixtures: exactly the documented forms.
  for (const lang of ['py', 'js', 'ts', 'tsx', 'cs']) {
    const lf = fixture(`forms/sample.${lang}`);
    assert.deepEqual(fixture(`forms/sample.bom.crlf.${lang}`), formVariant(lf, { bom: true, crlf: true }), lang);
  }
  const u16 = fixture('forms/sample.utf16le.txt');
  assert.deepEqual([...u16.subarray(0, 2)], [0xff, 0xfe]);
  assert.ok(u16.subarray(0, 8_000).includes(0));
  const cp = fixture('special/legacy_cp949.cs');
  assert.ok(!decodes(cp) && cp.includes(Buffer.from([0xb0, 0xa1])) && !cp.includes(0x0d));
  assert.deepEqual(fixture('special/legacy_cp949.crlf.cs'), formVariant(cp, { bom: false, crlf: true }));
});

// ---------------------------------------------------------------------------------------------------------------------------
// The 5,960-row file and the hot zone (T-REG-02, T-REG-03, T-REG-20)

/**
 * Test-side leaf-unit count of the generated Python subset under Task 4's unit model: module-level functions (decorators and
 * directly attached comments included), class residues plus their methods, module-level single-name assignments (consts) and
 * gap blocks (maximal non-blank runs outside every unit extent and outside <imports>); the class's own non-leaf unit is not counted.
 */
function countPythonLeafUnits(src: string[]): { units: number; imports: [number, number] | null } {
  const n = src.length;
  const blank = (i: number): boolean => /^[ \t]*$/.test(src[i] ?? '');
  const col0 = (i: number): boolean => !blank(i) && !/^[ \t]/.test(src[i] as string);
  // Top-level statements: start rows are column-0 rows that are not comments or decorators; decorators and comments directly above
  // (no blank row) belong to the statement below them.
  const covered = new Array<boolean>(n).fill(false);
  let units = 0;
  let imports: [number, number] | null = null;
  let i = 0;
  while (i < n) {
    if (!col0(i)) {
      i++;
      continue;
    }
    let start = i;
    let head = i;
    while (head < n && /^(#|@)/.test(src[head] as string)) head++;
    if (head >= n || !col0(head)) {
      i = head + 1;
      continue;
    }
    // End: the last non-blank row before the next column-0 row.
    let end = head;
    for (let j = head + 1; j < n; j++) {
      if (col0(j)) break;
      if (!blank(j)) end = j;
    }
    const line = src[head] as string;
    if (/^(import |from \S+ import )/.test(line)) {
      imports = imports === null ? [start, end] : [imports[0], end];
    } else if (/^(async def |def )/.test(line)) {
      units += 1;
    } else if (/^class /.test(line)) {
      units += 1; // residue
      for (let j = head + 1; j <= end; j++) if (/^    (async def |def )/.test(src[j] as string)) units += 1;
    } else if (/^[A-Za-z_][A-Za-z0-9_]*(: [^=]+)? = /.test(line)) {
      units += 1;
    } else {
      start = -1; // a plain statement: gap territory
    }
    if (start >= 0) for (let j = start; j <= end; j++) covered[j] = true;
    i = end + 1;
  }
  if (imports !== null) for (let j = imports[0]; j <= imports[1]; j++) covered[j] = true;
  for (let j = 0; j < n; j++) {
    if (blank(j) || covered[j]) continue;
    units += 1; // a gap block: a maximal run of uncovered non-blank rows
    while (j + 1 < n && !blank(j + 1) && !covered[j + 1]) j++;
  }
  return { units, imports };
}

/** The README's template schedule table: | `template` | rows | units | before | after |. */
function readmeSchedule(): Array<{ template: string; rows: number; units: number; before: number; after: number }> {
  const readme = readFileSync(join(FIX, 'README.md'), 'utf8');
  return [...readme.matchAll(/^\| tpl `([A-Za-z0-9_]+)` \| (\d+) \| (\d+) \| (\d+) \| (\d+) \|/gm)].map((m) => ({
    template: m[1] as string, rows: Number(m[2]), units: Number(m[3]), before: Number(m[4]), after: Number(m[5]),
  }));
}

test('bigBomCrlf(5_960) is 5,960 BOM+CRLF rows with the hot zone at its rows', () => {
  const b = bigBomCrlf(5_960);
  const r = rows(b);
  assert.equal(r.length, 5_960);
  assert.ok(b.subarray(0, 3).equals(BOM));
  assert.ok(r.every((row) => row.length >= 2 && row[row.length - 2] === 0x0d && row[row.length - 1] === 0x0a), 'every row ends CRLF');
  assert.equal(count(b.toString('latin1'), '\n'), count(b.toString('latin1'), '\r\n'), 'no bare LF');
  const s = strip(b);
  const at = (row: number): string => s[row - 1] as string;
  const want: Array<[number, string]> = [
    [5300, 'class Account:'], [5306, '    @property'], [5307, '    def balance(self):'], [5310, '    @balance.setter'],
    [5311, '    def balance(self, value):'], [5314, '        self._balance = value'], [5315, ''], [5316, ''],
    [5317, '@functools.lru_cache(maxsize=None)'], [5318, 'def parse(text):'], [5328, '    return fields'], [5329, ''], [5330, ''],
    [5331, '# Sum the line items of an order, rounded to cents.'], [5332, 'def compute_total(items):'], [5339, '    return round(total, 2)'],
    [5340, ''], [5341, ''], [5342, 'def compute_tax(total, rate):'], [5344, '    return round(total, 2)'],
  ];
  for (const [row, line] of want) assert.equal(at(row), line, `row ${row}`);
  assert.deepEqual(HOT_ZONE, {
    account: [5300, 5314], getter: [5306, 5308], setter: [5310, 5314], parse: [5317, 5328], computeTotal: [5331, 5339], computeTax: [5342, 5344],
  });
  // BIG_UNITS is the generator's own count by construction: recount the leaf units of the generated text test-side.
  assert.equal(BIG_UNITS, 432);
  const counted = countPythonLeafUnits(s);
  assert.equal(counted.units, BIG_UNITS);
  assert.ok(counted.imports !== null && counted.imports[0] < 20, 'the header carries <imports>');
  // The README lists each template's contribution; the schedule sums to the rows and units outside the header and hot zone.
  const sched = readmeSchedule();
  assert.ok(sched.length >= 6, 'the README schedule table');
  const readme = readFileSync(join(FIX, 'README.md'), 'utf8');
  const fixed = /^\| fixed `header` \| (\d+) \| (\d+) \|$/m.exec(readme);
  const hot = /^\| fixed `hot_zone` \| (\d+) \| (\d+) \|$/m.exec(readme);
  assert.ok(fixed !== null && hot !== null, 'the README lists the header and the hot zone');
  const rowsSum = Number(fixed[1]) + Number(hot[1]) + sched.reduce((a, t) => a + t.rows * (t.before + t.after), 0);
  const unitsSum = Number(fixed[2]) + Number(hot[2]) + sched.reduce((a, t) => a + t.units * (t.before + t.after), 0);
  assert.equal(rowsSum, 5_960);
  assert.equal(unitsSum, BIG_UNITS);
  assert.equal(Number(hot[1]), 47);
  // Each template instance carries the id <template>_<4 digits> on its column-0 code rows, so the README counts can be checked on
  // the text before and after the hot zone (distinct ids per template).
  for (const t of sched) {
    const ids = (part: string[]): number => {
      const re = new RegExp(`\\b${t.template}_\\d{4}\\b`, 'g');
      return new Set(part.filter((l) => /^[^#\s]/.test(l)).flatMap((l) => l.match(re) ?? [])).size;
    };
    assert.deepEqual([ids(s.slice(0, 5299)), ids(s.slice(5346))], [t.before, t.after], `template ${t.template}`);
  }
  assert.deepEqual(s.slice(98, 100), ['', ''], 'rows 99–100 are a blank pair (fwd/far_above inserts after row 100)');
  assert.match(s[100] as string, /^[^#\s]/, 'row 101 starts a top-level unit');
});

test('bigLf(5_960) is the same content in LF without BOM, and both are deterministic', () => {
  const crlf = bigBomCrlf(5_960);
  const lf = bigLf(5_960);
  assert.deepEqual(lf, Buffer.from(crlf.subarray(3).toString('latin1').split('\r\n').join('\n'), 'latin1'));
  assert.ok(!lf.includes(0x0d) && !lf.subarray(0, 3).equals(BOM));
  assert.deepEqual(bigBomCrlf(5_960), crlf);
  assert.deepEqual(bigLf(5_960), lf);
  assert.deepEqual(fixture('big_wt.py'), crlf);
  assert.deepEqual(fixture('big_lf.py'), lf);
});

/** The listed edit of each rc_touch R2 row: rows inserted after `after`, or one row replaced. */
const R2_EDITS: Record<string, { after?: number; insert?: string[]; replace?: [number, string] }> = {
  py_body_edit: { replace: [5335, '        price = item.price * item.quantity * item.weight'] },
  py_append_after_last_line: { after: 5339, insert: ['    audit(total)'] },
  py_decorator_under_attached_comment: { after: 5331, insert: ['@traced'] },
  py_attached_comment_above: { after: 5330, insert: ['# Totals are in the order currency.'] },
  py_boundary_insert_half_typed: { after: 5339, insert: ['def half('] },
  py_decorator_only_edit: { replace: [5317, '@functools.lru_cache(maxsize=128)'] },
  py_append_setter_body: { after: 5314, insert: ['        self._audit.append(value)'] },
  py_new_def_after: { after: 5341, insert: ['def compute_shipping(items):', '    weight = sum(item.weight for item in items)', '    return round(weight * 0.5, 2)', ''] },
  py_same_tail_def_after: {
    after: 5341,
    insert: [
      'def compute_discount(items):', '    total = 0', '    for item in items:', '        if item.discount:', '            total += item.discount',
      '    total = min(total, 100)', '    return round(total, 2)', '', '',
    ],
  },
  py_overload_stubs_above: { after: 5330, insert: ['@overload', 'def compute_total(items: list) -> float: ...', ''] },
  py_sibling_edit: { replace: [5320, '    fields = dict()'] },
  py_new_method_after_setter: { after: 5315, insert: ['    def reset(self):', '        self._balance = 0', ''] },
};

function applyEdit(base: string[], e: { after?: number; insert?: string[]; replace?: [number, string] }): string[] {
  if (e.replace !== undefined) {
    const out = [...base];
    out[e.replace[0] - 1] = e.replace[1];
    return out;
  }
  return [...base.slice(0, e.after), ...(e.insert as string[]), ...base.slice(e.after)];
}

test('RC_TOUCH_R2 is the 15 rc_touch R2 rows with their expected reasons', () => {
  const got = RC_TOUCH_R2.map((r) => [r.name, r.claimUnit, r.expect]);
  assert.deepEqual(got, [
    ['py_body_edit', 'compute_total', 'base-overlap'],
    ['py_append_after_last_line', 'compute_total', 'boundary-in-extent'],
    ['py_decorator_under_attached_comment', 'compute_total', 'insert-inside'],
    ['py_attached_comment_above', 'compute_total', 'boundary-in-extent'],
    ['py_boundary_insert_half_typed', 'compute_total', 'boundary-in-error'],
    ['py_decorator_only_edit', 'parse', 'base-overlap'],
    ['py_append_setter_body', 'Account.balance#setter', 'boundary-in-extent'],
    ['js_append_setter_body', 'Account.balance#set', 'insert-inside'],
    ['cs_new_overload_not_adjacent_to_held', 'N.Svc.Calc#(int)', 'group-name'],
    ['py_new_def_after', 'compute_total', 'none'],
    ['py_same_tail_def_after', 'compute_total', 'none'],
    ['py_overload_stubs_above', 'compute_total', 'none'],
    ['py_sibling_edit', 'compute_total', 'none'],
    ['py_new_method_after_setter', 'Account.balance#setter', 'none'],
    ['js_getter_above_setter', 'Account.balance#set', 'none'],
  ]);
  for (const r of RC_TOUCH_R2) assert.match(r.claimUnit, /^[A-Za-z_][\w.]*(#[^#\s]+)?$/, `${r.name}: qualname plus an optional #disc`);
  const base = strip(fixture('big_lf.py'));
  for (const r of RC_TOUCH_R2.filter((x) => x.name.startsWith('py_'))) {
    assert.equal(r.base, 'big_lf.py', r.name);
    const edit = R2_EDITS[r.name];
    assert.ok(edit !== undefined, r.name);
    assert.deepEqual(strip(fixture(r.post)), applyEdit(base, edit), `${r.name}: the post is big_lf.py with the listed edit`);
    assert.ok(!fixture(r.post).includes(0x0d), `${r.name}: LF`);
  }
  // The half-typed row: `def half(` at column 0 right after compute_total's last row (outside its extent; Task 4 checks the ERROR span).
  const half = strip(fixture('rc_touch/py_boundary_insert_half_typed.post.py'));
  assert.equal(half[5339], 'def half(');
  assert.equal(half[5338], '    return round(total, 2)');
  // JS rows: account.js has the setter at rows 6–9; the posts insert after row 8 (inside) and a 3-row getter after row 5.
  const js = strip(fixture('rc_touch/account.js'));
  assert.match(js[5] as string, /^ {2}set balance\(value\) \{$/);
  assert.equal(js[8], '  }');
  const jsSet = RC_TOUCH_R2.find((x) => x.name === 'js_append_setter_body')!;
  const jsGet = RC_TOUCH_R2.find((x) => x.name === 'js_getter_above_setter')!;
  assert.equal(jsSet.base, 'rc_touch/account.js');
  assert.equal(jsGet.base, 'rc_touch/account.js');
  assert.deepEqual(strip(fixture(jsSet.post)), applyEdit(js, { after: 8, insert: ['    this._audit.push(value);'] }));
  assert.deepEqual(strip(fixture(jsGet.post)), applyEdit(js, { after: 5, insert: ['  get balance() {', '    return this._balance;', '  }'] }));
  const cs = RC_TOUCH_R2.find((x) => x.name === 'cs_new_overload_not_adjacent_to_held')!;
  assert.deepEqual([cs.base, cs.post], ['csharp/Svc.cs', 'csharp/Svc.new_overload.cs']);
});

test('the R2 append post puts compute_total\'s last row at 5340', () => {
  const s = strip(fixture('rc_touch/py_append_after_last_line.post.py'));
  const at = (row: number): string => s[row - 1] as string;
  assert.equal(at(5331), '# Sum the line items of an order, rounded to cents.');
  assert.equal(at(5339), '    return round(total, 2)');
  assert.equal(at(5340), '    audit(total)');
  assert.equal(at(5341), '');
  assert.equal(at(5342), '');
  assert.equal(at(5343), 'def compute_tax(total, rate):');
});

// ---------------------------------------------------------------------------------------------------------------------------
// Same-tail: the git-vs-FoldMapper/1 divergence, and the premerge geometries (T-REG-06, T-REG-20; R4-21 rulings of fix round 1)

interface SameTailDivergence {
  base: string;
  post: string;
  edits: string[];
  git: string[];
  foldMapper1: { hunks: Array<{ aLo: number; aHi: number; bLo: number; bHi: number }>; images: Record<string, Array<[number, number]>> };
}

test('same-tail variant: after a sibling edit above it, FoldMapper/1 places the same-tail insertion after base row 5338', () => {
  const d = JSON.parse(fixture('same_tail/git_vs_foldmapper.json').toString('utf8')) as SameTailDivergence;
  assert.deepEqual([d.base, d.post], ['big_lf.py', 'same_tail/git_vs_foldmapper.post.py']);
  assert.deepEqual(d.edits, ['py_sibling_edit', 'py_same_tail_def_after']);
  const base = strip(fixture('big_lf.py'));
  const post = strip(fixture(d.post));
  assert.deepEqual(post, d.edits.reduce((acc, n) => applyEdit(acc, R2_EDITS[n]!), base), 'the post is big_lf.py with both rc_touch edits');
  assert.ok(!fixture(d.post).includes(0x0d), 'LF');
  // 04 §3.4 step 2 by hand: common prefix and suffix trimming (step 1 equality: LF rows, no BOM here), then a minimal edit script
  // of the remaining rows. The suffix trimming consumes the block's last three rows (they equal base rows 5339–5341).
  let p = 0;
  while (p < base.length && p < post.length && base[p] === post[p]) p++;
  let s = 0;
  while (s < base.length - p && s < post.length - p && base[base.length - 1 - s] === post[post.length - 1 - s]) s++;
  assert.deepEqual([p, s], [5319, 622], 'common prefix and suffix');
  const a = base.slice(p, base.length - s);
  const b = post.slice(p, post.length - s);
  assert.deepEqual([a.length, b.length], [19, 28], 'base rows 5320–5338 against post rows 5320–5347');
  assert.deepEqual(b.slice(1, 19), a.slice(1, 19), 'base rows 5321–5338 are unchanged at the same rows');
  // The minimal script is unique, so no tie-break can move it: row 5320 has no partner on either side, and base row 5338 has exactly
  // one partner (post row 5338). A longest common subsequence (18 rows) then matches base rows 5321–5338 to post rows 5321–5338.
  assert.ok(!b.includes(a[0] as string) && !a.includes(b[0] as string), 'the changed row 5320 has no partner');
  assert.deepEqual(b.flatMap((r, i) => (r === a[18] ? [i] : [])), [18], 'base row 5338 has one partner');
  assert.deepEqual(b.slice(19), [
    '    return round(total, 2)', '', '', 'def compute_discount(items):', '    total = 0', '    for item in items:', '        if item.discount:',
    '            total += item.discount', '    total = min(total, 100)',
  ], 'the inserted rows start with compute_total\'s own last row and its blank pair');
  assert.deepEqual(d.foldMapper1.hunks, [
    { aLo: 5320, aHi: 5320, bLo: 5320, bHi: 5320 },
    { aLo: 5339, aHi: 5338, bLo: 5339, bHi: 5347 },
  ], 'FoldMapper/1: row 5320 changed, 9 rows inserted after base row 5338');
  // 04 §3.4 step 3 for compute_total [5331, 5339]: unchanged rows 5331–5338 stay, rule (c) adds the insertion after k = 5338
  // (5331 ≤ k < 5339) as post rows 5339–5347, unchanged row 5339 moves to 5348.
  assert.deepEqual(d.foldMapper1.images, { compute_total: [[5331, 5348]] });
  assert.equal(post[5347], '    return round(total, 2)', 'post row 5348 is compute_total\'s last row in FoldMapper/1\'s alignment');
  // git's placement (measured by the integration test on real git): after 5341, where the block alone also lands in both.
  assert.deepEqual(d.git, ['@@ -5320 +5320 @@', '@@ -5341,0 +5342,9 @@']);
});

/** 0-based index of the last row of the unit that starts at `start` (the row before its blank-row pair). */
function lastRowOf(src: readonly string[], start: number): number {
  let j = start;
  while (j + 1 < src.length && src[j + 1] !== '') j++;
  return j;
}

test('premerge: the same-tail append fixture has its geometry', () => {
  const R = '    return round(total, 2)';
  const [base, ours, theirs] = ['base', 'ours', 'theirs'].map((s) => strip(fixture(`premerge/${s}.py`))) as [string[], string[], string[]];
  const totalAt = base.indexOf('def compute_total(items):');
  const taxAt = base.indexOf('def compute_tax(total, rate):');
  assert.ok(totalAt >= 0 && taxAt > totalAt, 'compute_total, then compute_tax');
  const totalLast = lastRowOf(base, totalAt);
  const taxLast = lastRowOf(base, taxAt);
  assert.deepEqual([base[totalLast], base[taxLast]], [R, R], 'both functions end with the same row');
  assert.deepEqual(base.slice(totalLast + 1, taxAt), ['', ''], 'adjacent functions, one blank-row pair between them');
  // ours = base plus one row directly after compute_total's last row; theirs = base plus one row directly after compute_tax's.
  assert.deepEqual(ours, applyEdit(base, { after: totalLast + 1, insert: ['    audit("order", total)'] }), 'ours appends to compute_total');
  assert.deepEqual(theirs, applyEdit(base, { after: taxLast + 1, insert: ['    audit("tax", total)'] }), 'theirs appends to compute_tax');
  assert.ok(taxLast - totalLast >= 3, 'the two insertion points are separated by unchanged rows');
  for (const [n, f] of [['base', base], ['ours', ours], ['theirs', theirs]] as const) {
    assert.ok(!fixture(`premerge/${n}.py`).includes(0x0d), `${n}: LF`);
    assert.equal(f.filter((r) => r === R).length, 2, `${n}: two functions end with ${R.trim()}`);
  }
});

test('premerge same-head: the requester\'s new function repeats the two decorator rows of the function below it', () => {
  const D1 = '@functools.lru_cache(maxsize=None)';
  const D2 = '@traced';
  const [base, ours, theirs] = ['base', 'ours', 'theirs'].map((s) => strip(fixture(`premerge/same_head/${s}.py`))) as [string[], string[], string[]];
  const taxAt = base.indexOf('def compute_tax(total, rate):');
  assert.ok(taxAt >= 4, 'compute_tax');
  assert.deepEqual(base.slice(taxAt - 4, taxAt), ['', '', D1, D2], 'compute_tax carries two decorator rows after a blank-row pair');
  assert.equal(base[lastRowOf(base, taxAt)], '    return round(total, 2)');
  const d1 = taxAt - 2; // 0-based row of compute_tax's first decorator
  const block = [D1, D2, 'def compute_vat(total):', '    total = total * 0.2', '    return round(total, 2)', '', ''];
  // ours: a new decorated function directly above compute_tax, starting with the same two decorator rows (a same-head insertion).
  assert.deepEqual(ours, applyEdit(base, { after: d1, insert: block }), 'ours inserts compute_vat above compute_tax');
  // The same bytes are the block rotated by two rows and inserted after compute_tax's second decorator: git's merge slides each
  // side's insertion to the bottom of that range, so it attaches the requester's block below the owner's decorator rows.
  assert.deepEqual(ours, applyEdit(base, { after: d1 + 2, insert: [...block.slice(2), D1, D2] }), 'the insertion slides down by two rows');
  assert.notEqual(block[2], base[d1 + 2], 'and no further');
  // theirs: compute_tax's owner edits its first decorator row (the rc_touch decorator-only edit).
  assert.deepEqual(theirs, applyEdit(base, { replace: [d1 + 1, '@functools.lru_cache(maxsize=128)'] }), 'theirs edits compute_tax\'s first decorator');
  for (const n of ['base', 'ours', 'theirs']) assert.ok(!fixture(`premerge/same_head/${n}.py`).includes(0x0d), `${n}: LF`);
});

// ---------------------------------------------------------------------------------------------------------------------------
// Sweep scenarios S1–S10 (T-REG-01, TC-REG-01, TC-REG-06, TC-REG-08)

function definesUnit(src: string, claimUnit: string): boolean {
  const [qual] = claimUnit.split('#');
  const simple = (qual as string).split('.').pop() as string;
  return new RegExp(`\\b(def|class|function|get|set)\\s+${simple}\\b|\\b${simple}\\s*\\(|^${simple}\\s*=`, 'm').test(src);
}

test('each sweep scenario validates against SweepScenario', () => {
  for (const name of SWEEP) {
    const s: SweepScenario = sweepScenario(name);
    assert.equal(s.name, name);
    assert.ok(Object.keys(s.files).length >= 1, `${name}: files`);
    for (const [p, f] of Object.entries(s.files)) {
      assert.ok('base' in f, `${name} ${p}: base`);
      assert.ok(f.ours !== undefined || f.theirs !== undefined, `${name} ${p}: a side`);
    }
    assert.ok(Array.isArray(s.claims) && s.claims.length >= 1, `${name}: claims`);
    for (const c of s.claims) {
      assert.match(c.holderSeat, /^p\d+\/[a-z0-9-]+$/, `${name}: holderSeat`);
      assert.ok(s.files[c.path] !== undefined, `${name}: claim path ${c.path} is one of its files`);
      assert.ok((c.claimUnit === undefined) !== (c.ranges === undefined), `${name}: claimUnit or ranges`);
      const base = text(s.files[c.path]!.base);
      if (c.claimUnit !== undefined) assert.ok(definesUnit(base, c.claimUnit), `${name}: ${c.claimUnit} is a unit of base ${c.path}`);
      for (const [lo, hi] of c.ranges ?? []) assert.ok(lo >= 1 && lo <= hi && hi <= lines(base).length, `${name}: range in base`);
    }
    assert.ok(['byte_identical', 'held', 'conflict_hold'].includes(s.expect), `${name}: expect`);
    assert.ok(s.oracle !== undefined, `${name}: oracle (the correct live tree)`);
    assert.equal(s.corrupting, CORRUPTING.has(name), `${name}: corrupting`);
    const e = MANIFEST.fixtures[`sweep/${name}/scenario.json`];
    assert.ok(e !== undefined, `${name}: manifest row`);
    assert.equal(e.corrupting, s.corrupting, `${name}: manifest corrupting`);
    if (s.corrupting) {
      assert.ok(s.corruptOut !== undefined && s.hazard !== undefined && s.caughtBy !== undefined, `${name}: corruptOut, hazard and caughtBy`);
      assert.equal(e.caughtBy, s.caughtBy, `${name}: manifest caughtBy`);
      assert.equal(e.duplicatedKey, s.duplicatedKey, `${name}: manifest duplicatedKey`);
      if (TRIPWIRE_B.has(name)) {
        assert.equal(s.caughtBy, 'tripwire_b', name);
        assert.match(s.duplicatedKey ?? '', /^[a-z]+\0[^\0]+\0[^\0]*$/, `${name}: duplicatedKey is kind \\0 qualname \\0 disc`);
      } else if (name === 'S8') assert.equal(s.caughtBy, 'tripwire_c');
      else assert.ok(['b1', 'placement', 't0'].includes(s.caughtBy as string), `${name}: caughtBy`);
      if (!TRIPWIRE_B.has(name)) assert.equal(s.duplicatedKey, undefined, `${name}: duplicatedKey only for tripwire_b`);
    } else {
      assert.equal(s.corruptOut, undefined, name);
      assert.equal(s.caughtBy, undefined, name);
    }
  }
  const s9 = MANIFEST.fixtures[S9_NAME];
  assert.ok(s9 !== undefined && s9.corrupting === true && ['b1', 'placement', 't0'].includes(s9.caughtBy as string), 'S9 is a corrupting generator');
});

function hazardCount(out: Record<string, FixtureBytes | null>, h: { path: string; pattern: string }): number {
  if (h.path === '*') return Object.values(out).reduce((a, v) => a + count(text(v), h.pattern), 0);
  return count(text(out[h.path]), h.pattern);
}

test('every corrupting scenario\'s corruptOut shows its hazard and its oracle does not', () => {
  for (const name of SWEEP.filter((n) => CORRUPTING.has(n))) {
    const s = sweepScenario(name);
    const h = s.hazard!;
    if (name === 'S8') {
      const out = fixtureBytes(s.corruptOut![h.path]!);
      assert.ok(!decodes(out), 'S8 corruptOut does not decode');
      assert.ok(decodes(fixtureBytes(s.files[h.path]!.theirs!)), 'S8 theirs decodes');
      assert.ok(decodes(fixtureBytes(s.oracle![h.path]!)), 'S8 oracle decodes');
      continue;
    }
    assert.equal(hazardCount(s.corruptOut!, h), h.count, `${name}: the hazard holds on corruptOut`);
    assert.notEqual(hazardCount(s.oracle!, h), h.count, `${name}: the hazard fails on the correct result`);
  }
  const s3b = sweepScenario('S3b');
  assert.deepEqual([s3b.hazard!.pattern, s3b.hazard!.count, hazardCount(s3b.oracle!, s3b.hazard!)], ['set balance(', 2, 1]);
  const s6b = sweepScenario('S6b');
  assert.deepEqual([s6b.hazard!.pattern, s6b.hazard!.count], ['public double Calc(double x)', 2]);
  const s2b = sweepScenario('S2b');
  assert.deepEqual([s2b.hazard!.path, s2b.hazard!.pattern, s2b.hazard!.count], ['*', 'def compute_total(', 2]);
  for (const n of ['S5a', 'S5b']) {
    const s = sweepScenario(n);
    const out = lines(text(s.corruptOut![s.hazard!.path]));
    const idx = out.findIndex((l, i) => l === s.hazard!.pattern && out.indexOf(l) !== i);
    assert.ok(idx > 0, `${n}: the decorator row twice`);
    let j = idx;
    while (j < out.length && /^(@|#)/.test(out[j] as string)) j++;
    assert.match(out[j] as string, /^def /, `${n}: both decorator rows sit above one def`);
    assert.equal(out.slice(0, j).filter((l) => l === s.hazard!.pattern).length, 2, n);
  }
  const s4 = sweepScenario('S4');
  const claim = s4.claims[0]!;
  const baseRows = lines(text(s4.files[claim.path]!.base));
  const outText = text(s4.corruptOut![claim.path]);
  const oracleText = text(s4.oracle![claim.path]);
  for (const [lo, hi] of claim.ranges!) {
    for (let r = lo; r <= hi; r++) {
      if ((baseRows[r - 1] as string).trim() === '') continue;
      assert.ok(!outText.includes(baseRows[r - 1] as string), `S4: claimed base row ${r} absent from corruptOut`);
      assert.ok(oracleText.includes(baseRows[r - 1] as string), `S4: claimed base row ${r} kept by the correct result`);
    }
  }
});

test('s9Generator is deterministic and tracks the claimed block', () => {
  const take = (seed: string, n: number): Array<{ step: number; holder: Buffer; peer: Buffer; oracle: ReadonlyArray<readonly [number, number]> }> => {
    const out = [];
    for (const s of s9Generator(seed)) {
      out.push(s);
      if (out.length === n) break;
    }
    return out;
  };
  const a = take('s9-0', 50);
  const b = take('s9-0', 50);
  assert.deepEqual(a, b);
  const c = take('s9-1', 6);
  assert.ok(c.some((s, i) => !s.peer.equals(a[i]!.peer) || !s.holder.equals(a[i]!.holder)), "'s9-1' differs at some step <= 5");
  // Step 0: 800 maximal non-blank row runs, > 300 rows (path class 6 with a grammarless path).
  const s0 = strip(a[0]!.holder);
  let runs = 0;
  s0.forEach((l, i) => {
    if (l.trim() !== '' && (i === 0 || (s0[i - 1] as string).trim() === '')) runs++;
  });
  assert.equal(runs, 800);
  assert.ok(s0.length > 300);
  assert.deepEqual(fixture(S9_NAME), a[0]!.holder);
  const markerRows = (b0: Buffer): [number, number] => {
    const s = strip(b0);
    const begin = s.flatMap((l, i) => (l.includes('S9-CLAIM-BEGIN') ? [i + 1] : []));
    const end = s.flatMap((l, i) => (l.includes('S9-CLAIM-END') ? [i + 1] : []));
    assert.equal(begin.length, 1);
    assert.equal(end.length, 1);
    return [begin[0]!, end[0]!];
  };
  let churn = 0;
  let prev = rows(a[0]!.peer).length;
  let prevBlanks = strip(a[0]!.peer).filter((l) => l === '').length;
  const many = take('s9-0', 401);
  for (const s of many) {
    assert.deepEqual(s.oracle, [markerRows(s.peer)], `step ${s.step}: oracle = the claimed block in peer`);
    markerRows(s.holder);
    assert.ok(!s.peer.includes(0x0d) && !s.holder.includes(0x0d));
    if (s.step > 0) churn += Math.abs(rows(s.peer).length - prev);
    prev = rows(s.peer).length;
    // The churn inserts unique rows only (T-REG-21: blank-row churn could migrate across the marker rows): no non-blank row repeats,
    // and the peer's blank rows never grow in number.
    const nonBlank = strip(s.peer).filter((l) => l !== '');
    assert.equal(new Set(nonBlank).size, nonBlank.length, `step ${s.step}: every non-blank peer row is unique`);
    const blanks = strip(s.peer).length - nonBlank.length;
    assert.ok(blanks <= prevBlanks, `step ${s.step}: no blank row inserted (${blanks} > ${prevBlanks})`);
    prevBlanks = blanks;
  }
  assert.deepEqual(many.map((s) => s.step), Array.from({ length: 401 }, (_, i) => i));
  assert.ok(churn >= 3_000, `summed row-count change ${churn}`);
});

// ---------------------------------------------------------------------------------------------------------------------------
// fwd, errors, dupes, interface, C# (T-REG-07…T-REG-10, T-REG-20)

test('fwd: four 22-row insertion variants', () => {
  const base = strip(fixture('big_lf.py'));
  const at: Record<string, number> = { far_above: 100, directly_above: 5330, directly_after: 5341, same_tail: 5341 };
  for (const [v, after] of Object.entries(at)) {
    const block = strip(fixture(`fwd/${v}.block.py`));
    assert.equal(block.length, 22, v);
    assert.deepEqual(strip(fixture(`fwd/${v}.post.py`)), [...base.slice(0, after), ...block, ...base.slice(after)], v);
  }
  assert.deepEqual(strip(fixture('fwd/same_tail.block.py')).slice(-3), ['    return round(total, 2)', '', '']);
  assert.notDeepEqual(strip(fixture('fwd/directly_after.block.py')).slice(-3), ['    return round(total, 2)', '', '']);
});

test('S7 error-tree pairs differ from their clean files by one documented edit', () => {
  const pairs: Array<[string, string, (row: string) => boolean]> = [
    ['py_triple_quote', 'py', (r) => count(r, '"""') % 2 === 1],
    ['py_paren', 'py', (r) => count(r, '(') > count(r, ')')],
    ['js_brace', 'js', (r) => count(r, '{') > count(r, '}')],
    ['cs_brace', 'cs', (r) => count(r, '{') > count(r, '}')],
  ];
  for (const [dir, ext, broken] of pairs) {
    const c = strip(fixture(`errors/S7/${dir}/clean.${ext}`));
    const b = strip(fixture(`errors/S7/${dir}/broken.${ext}`));
    assert.ok(c.length >= 20, `${dir}: a file with several units`);
    let i = 0;
    while (i < c.length && c[i] === b[i]) i++;
    if (b.length === c.length) {
      assert.deepEqual(b.slice(i + 1), c.slice(i + 1), `${dir}: exactly one changed row`);
    } else {
      assert.equal(b.length, c.length + 1, `${dir}: one changed or inserted row`);
      assert.deepEqual(b.slice(i + 1), c.slice(i), `${dir}: exactly one inserted row`);
    }
    assert.ok(broken(b[i] as string), `${dir}: row ${i + 1} is the documented break (${b[i]})`);
    assert.ok(!broken(c[i] ?? ''), `${dir}: the clean row is balanced`);
    const m = MANIFEST.fixtures[`errors/S7/${dir}/broken.${ext}`];
    assert.ok(m?.definitions?.brokenRow === i + 1, `${dir}: the manifest documents row ${i + 1}`);
  }
});

function defRows(src: string[], re: RegExp): number[] {
  return src.flatMap((l, i) => (re.test(l) ? [i + 1] : []));
}

test('rc_valid_errors and rc_dupes hold the duplicate-label shapes', () => {
  const readme = readFileSync(join(FIX, 'README.md'), 'utf8');
  const check = (name: string, found: Record<string, number[]>): void => {
    const e = MANIFEST.fixtures[name]!;
    const flat: Record<string, number> = {};
    for (const [k, rs] of Object.entries(found)) rs.forEach((r, i) => (flat[rs.length > 1 ? `${k}#${i}` : k] = r));
    assert.deepEqual(e.definitions, flat, `${name}: the manifest lists the definition rows`);
    for (const [k, r] of Object.entries(flat)) assert.ok(readme.includes(`\`${k}\` row ${r}`), `${name}: the README lists ${k} row ${r}`);
  };
  const cs = strip(fixture('errors/rc_valid_errors.cs'));
  const ifRow = cs.findIndex((l) => l.trim() === '#if DEBUG');
  const elseRow = cs.findIndex((l) => l.trim() === '#else');
  const endRow = cs.findIndex((l) => l.trim() === '#endif');
  assert.ok(ifRow >= 0 && ifRow < elseRow && elseRow < endRow);
  const describe = defRows(cs, /\bDescribe\(\)/);
  assert.equal(describe.length, 2);
  assert.ok(describe[0]! > ifRow + 1 && describe[0]! < elseRow + 1 && describe[1]! > elseRow + 1 && describe[1]! < endRow + 1);
  check('errors/rc_valid_errors.cs', { Describe: describe });
  for (const name of ['errors/rc_valid_errors.py', 'dupes/rc_dupes.py']) {
    const py = strip(fixture(name));
    const value = defRows(py, /^ {4}def value\(/);
    const open = defRows(py, /^ {4}def open_console\(/);
    assert.equal(value.length, 2, `${name}: value getter and setter`);
    assert.equal(py[value[0]! - 2], '    @property');
    assert.match(py[value[1]! - 2] as string, /^ {4}@value\.setter$/);
    const branch = py.findIndex((l) => l === 'if sys.platform == "win32":');
    const elseB = py.findIndex((l) => l === 'else:');
    assert.equal(open.length, 2, `${name}: open_console in both platform branches`);
    assert.ok(branch >= 0 && open[0]! > branch + 1 && open[0]! < elseB + 1 && open[1]! > elseB + 1);
    if (name.startsWith('dupes/')) assert.ok(py.some((l) => l === 'class Account:'), 'Account.value');
    check(name, { value, open_console: open });
  }
});

test('C# and TS group-name fixtures', () => {
  const svc = strip(fixture('csharp/Svc.cs'));
  const at = (s: string[], r: number): string => s[r - 1] as string;
  assert.equal(at(svc, 1), 'namespace N');
  assert.equal(at(svc, 3).trim(), 'public partial class Svc');
  assert.match(at(svc, 5), /public void Reset\(\)$/);
  assert.equal(at(svc, 8).trim(), '}');
  assert.match(at(svc, 12), /public int Calc\(int x\)$/);
  assert.equal(at(svc, 15).trim(), '}');
  assert.match(at(svc, 17), /public double Calc\(double x\)$/);
  assert.equal(at(svc, 20).trim(), '}');
  assert.ok(svc.slice(20, 27).some((l) => /Describe\(\)/.test(l)));
  assert.equal(at(svc, 28).trim(), '}');
  assert.equal(at(svc, 29), '');
  const post = strip(fixture('csharp/Svc.new_overload.cs'));
  assert.match(at(post, 30), /public decimal Calc\(decimal x\)$/);
  assert.equal(at(post, 33).trim(), '}');
  assert.deepEqual([...post.slice(0, 29), ...post.slice(34)], svc, 'Svc.new_overload.cs inserts rows 30–34 (Calc(decimal) and an empty row)');
  assert.equal(at(post, 34), '');
  const p2 = strip(fixture('csharp/Svc.Part2.cs')).join('\n');
  assert.match(p2, /public partial class Svc\b/);
  assert.match(p2, /\bName\(\)/);
  assert.doesNotMatch(p2, /Calc\(/);
  const p2l = strip(fixture('csharp/Svc.Part2.long.cs')).join('\n');
  assert.match(p2l, /public long Calc\(long x\)/);
  assert.equal(p2l.replace(/\n[^\n]*public long Calc\(long x\)\n[^\n]*\n[^\n]*\n[^\n]*\n\n/, '\n'), p2, 'Svc.Part2.long.cs adds exactly Calc(long)');
  const ts = strip(fixture('csharp/overloads.ts'));
  const tsPost = strip(fixture('csharp/overloads.post.ts'));
  assert.ok(ts.includes('function f(x: number): number;') && ts.includes('function f(x: string): string;'));
  assert.ok(ts.some((l) => /^function f\(x: [^)]*\): [^;]+ \{$/.test(l)), 'the implementation');
  assert.ok(!ts.includes('function f(x: boolean): boolean;') && tsPost.includes('function f(x: boolean): boolean;'));
  assert.deepEqual(tsPost.filter((l) => l !== 'function f(x: boolean): boolean;'), ts, 'the post adds one signature');
});

// ---------------------------------------------------------------------------------------------------------------------------
// Forms, special paths and properties (TC-REG-03, TC-REG-10, T-REG-23)

test('formVariant and the form fixtures', () => {
  const lf = Buffer.from('a\nb\n\u{d55c}\n', 'utf8');
  assert.deepEqual(formVariant(lf, { bom: true, crlf: true }), Buffer.concat([BOM, Buffer.from('a\r\nb\r\n\u{d55c}\r\n', 'utf8')]));
  assert.deepEqual(formVariant(lf, { bom: false, crlf: false }), lf);
  assert.deepEqual(formVariant(lf, { bom: true, crlf: false }), Buffer.concat([BOM, lf]));
  assert.deepEqual(formVariant(lf, { bom: false, crlf: true }), Buffer.from('a\r\nb\r\n\u{d55c}\r\n', 'utf8'));
  for (const ext of ['py', 'js', 'ts', 'tsx', 'cs']) {
    const b = fixture(`forms/sample.${ext}`);
    const s = b.toString('utf8');
    assert.ok(/[\u{ac00}-\u{d7a3}]/u.test(s), `${ext}: Hangul`);
    assert.ok(s.includes('\u{1f600}'), `${ext}: U+1F600`);
    for (const q of ['\u{2018}', '\u{2019}', '\u{201c}', '\u{201d}']) assert.ok(s.includes(q), `${ext}: curly quote ${q}`);
    const u2028 = s.split('\n').find((l) => l.includes('\u{2028}'));
    assert.ok(u2028 !== undefined && /["'`]/.test(u2028), `${ext}: U+2028 inside a string literal`);
    const crlf = fixture(`forms/sample.bom.crlf.${ext}`);
    assert.ok(crlf.subarray(0, 3).equals(BOM));
    assert.equal(rows(crlf).length, rows(b).length);
  }
  const u16 = fixture('forms/sample.utf16le.txt');
  assert.deepEqual([...u16.subarray(0, 2)], [0xff, 0xfe]);
  assert.ok(u16.subarray(0, 8_000).includes(0x00));
  assert.match(new TextDecoder('utf-16le').decode(u16.subarray(2)), /[\u{ac00}-\u{d7a3}]/u);
  const cp = fixture('special/legacy_cp949.cs');
  assert.equal(rows(cp).length, 320);
  assert.ok(!decodes(cp));
  assert.ok(cp.includes(Buffer.from([0xb0, 0xa1])));
  assert.match(new TextDecoder('euc-kr').decode(cp), /\u{ac00}/u);
  const cpCrlf = fixture('special/legacy_cp949.crlf.cs');
  assert.equal(rows(cpCrlf).length, 320);
  assert.deepEqual(cpCrlf, formVariant(cp, { bom: false, crlf: true }));
});

test('special-path fixtures', () => {
  const blocks = (b: Buffer): number => {
    const s = strip(b);
    return s.filter((l, i) => l.trim() !== '' && (i === 0 || (s[i - 1] as string).trim() === '')).length;
  };
  const small = fixture('special/small.md');
  const big = fixture('special/big.md');
  assert.equal(rows(small).length, 250);
  assert.equal(rows(big).length, 900);
  assert.ok(blocks(small) >= 20 && blocks(big) >= 60, 'blank-line-separated blocks');
  const nb = JSON.parse(fixture('special/nb.ipynb').toString('utf8')) as { cells: unknown[]; nbformat: number };
  assert.equal(nb.cells.length, 2);
  assert.equal(nb.nbformat, 4);
  const attrs = strip(fixture('special/attributes'));
  assert.ok(attrs.includes('secret.env filter=secret'));
  assert.ok(attrs.includes('utf16.txt working-tree-encoding=UTF-16LE'));
});

/** fast-check seeds are numbers: the first 4 bytes of seededRandom(name). */
function fcSeed(name: string): number {
  return Buffer.from(seededRandom(name).bytes(4)).readInt32LE(0);
}

/** The template count of a unitFileArb text: one CW-T marker per non-blank template, plus the 2-row blank-run templates. */
function recountTemplates(t: string): number {
  const markers = (t.match(/CW-T\b/g) ?? []).length;
  const s = t.split('\n');
  if (s[s.length - 1] === '') s.pop();
  let blankTemplates = 0;
  let i = 0;
  while (i < s.length) {
    if ((s[i] as string) !== '') {
      i++;
      continue;
    }
    let j = i;
    while (j < s.length && s[j] === '') j++;
    const run = j - i;
    blankTemplates += (i === 0 ? run : run - 1) / 2;
    i = j;
  }
  return markers + blankTemplates;
}

test('unitFileArb generates valid files per language', () => {
  for (const lang of ['python', 'javascript', 'typescript', 'c_sharp'] as const) {
    const a = fc.sample(unitFileArb(lang), { seed: fcSeed('arb'), numRuns: 200 });
    const b = fc.sample(unitFileArb(lang), { seed: fcSeed('arb'), numRuns: 200 });
    assert.deepEqual(a, b, `${lang}: deterministic under seed 'arb'`);
    assert.equal(a.length, 200);
    const ext = { python: 'py', javascript: 'js', typescript: 'ts', c_sharp: 'cs' }[lang];
    assert.equal(fixture(`arb/sample.${ext}`).toString('utf8'), a[0]!.text, `arb/sample.${ext} is the first sample`);
    for (const { text: t, units } of a) {
      assert.ok(t.length > 0 && rows(Buffer.from(t, 'utf8')).length >= 1, `${lang}: >= 1 row`);
      assert.ok(!t.includes('\r'), `${lang}: LF only`);
      assert.ok(t.endsWith('\n'), `${lang}: ends with LF`);
      assert.ok(units >= 1, `${lang}: >= 1 template`);
      assert.equal(recountTemplates(t), units, `${lang}: units = the templates it contains\n${t}`);
    }
    const kinds = a.map((x) => x.text).join('\n');
    if (lang === 'python') assert.match(kinds, /^class /m);
    if (lang === 'javascript') assert.match(kinds, /^\(function \(\) \{/m);
    if (lang === 'c_sharp') assert.match(kinds, /^namespace /m);
    if (lang === 'typescript') assert.match(kinds, /^(export )?interface /m);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// Hook payloads, edit-check corpus, hold scenarios, the big files

const normalizeView = (s: string): string =>
  s.replace(/^\u{feff}/u, '').split('\r\n').join('\n').replace(/[\u{2018}\u{2019}]/gu, "'").replace(/[\u{201c}\u{201d}]/gu, '"');

test('T-REG-11 payloads carry the fields predict reads', () => {
  const cases = ['lf_old_string_on_bomcrlf', 'curly_quotes', 'replace_all_5_functions', 'old_string_two_units', 'multiedit_two_edits', 'write_whole_file', 'notebook_edit'];
  const tools: Record<string, string> = {
    lf_old_string_on_bomcrlf: 'Edit', curly_quotes: 'Edit', replace_all_5_functions: 'Edit', old_string_two_units: 'Edit',
    multiedit_two_edits: 'MultiEdit', write_whole_file: 'Write', notebook_edit: 'NotebookEdit',
  };
  for (const name of cases) {
    const h = hookPayload(name);
    const pre = h.pre as Record<string, unknown>;
    const post = h.post as Record<string, unknown>;
    assert.equal(pre.hook_event_name, 'PreToolUse', name);
    assert.equal(post.hook_event_name, 'PostToolUse', name);
    assert.equal(pre.tool_name, tools[name], name);
    assert.equal(post.tool_name, pre.tool_name, name);
    const input = pre.tool_input as Record<string, unknown>;
    assert.deepEqual(post.tool_input, input, `${name}: the PostToolUse carries the same tool_input`);
    assert.ok(post.tool_response !== undefined, `${name}: tool_response`);
    for (const k of ['session_id', 'transcript_path', 'cwd']) assert.equal(typeof pre[k], 'string', `${name}: ${k}`);
    const view = normalizeView(h.before.toString('utf8'));
    if (pre.tool_name === 'NotebookEdit') {
      assert.equal(typeof input.notebook_path, 'string');
      for (const k of ['cell_id', 'new_source', 'edit_mode']) assert.equal(typeof input[k], 'string', `${name}: ${k}`);
      const nb = JSON.parse(h.before.toString('utf8')) as { cells: Array<{ id: string }> };
      assert.ok(nb.cells.some((c) => c.id === input.cell_id), 'the cell exists in before');
      continue;
    }
    assert.equal(typeof input.file_path, 'string', name);
    if (pre.tool_name === 'Write') {
      assert.equal(typeof input.content, 'string');
      assert.equal(h.after.toString('utf8'), input.content, 'after = the written content');
      continue;
    }
    const edits = pre.tool_name === 'MultiEdit'
      ? (input.edits as Array<Record<string, unknown>>)
      : [{ old_string: input.old_string, new_string: input.new_string, replace_all: input.replace_all }];
    if (pre.tool_name === 'MultiEdit') assert.equal(edits.length, 2);
    let v = view;
    for (const e of edits) {
      assert.equal(typeof e.old_string, 'string');
      assert.equal(typeof e.new_string, 'string');
      assert.equal(typeof e.replace_all, 'boolean');
      const old = e.old_string as string;
      assert.equal(count(v, old), name === 'replace_all_5_functions' ? 5 : 1, `${name}: old_string occurrences in the normalized view`);
      v = e.replace_all === true ? v.split(old).join(e.new_string as string) : v.replace(old, () => e.new_string as string);
    }
    assert.equal(normalizeView(h.after.toString('utf8')), v, `${name}: after is before with the edits applied (normalized view)`);
    if (name === 'lf_old_string_on_bomcrlf' || name === 'curly_quotes') {
      assert.equal(count(h.before.toString('utf8'), edits[0]!.old_string as string), 0, `${name}: the raw before holds old_string 0 times`);
    }
  }
  const bom = hookPayload('lf_old_string_on_bomcrlf');
  assert.ok(bom.before.subarray(0, 3).equals(BOM) && bom.before.includes(Buffer.from('\r\n')));
  assert.ok(bom.after.subarray(0, 3).equals(BOM) && !/[^\r]\n/.test(bom.after.toString('latin1')));
  assert.ok(((hookPayload('old_string_two_units').pre as { tool_input: { old_string: string } }).tool_input.old_string.match(/^def /gm) ?? []).length >= 1);
});

const T_REG_28 = [
  // passes
  'pass/body_only', 'pass/appended_default_param', 'pass/callers_updated', 'pass/new_function', 'pass/preexisting_error_in_tip',
  'pass/grammarless_250', 'pass/notebook', 'pass/shrink_49', 'pass/note_possible_caller', 'pass/note_stoplist_get', 'pass/note_json_key_rename',
  // fails
  '1/new_error_node', '1/undecodable', '1/conflict_markers', '2/incompatible_caller', '2/orphan_call', '3/removed_name_called',
  '3/unresolved_import', '4/label_count', '4/shrink', '4/emptied',
];

test('the edit-check corpus has every T-REG-28 row and one pass and one fail case per check and language', () => {
  const cases = editCheckCases();
  const byName = new Map(cases.map((c) => [c.name, c]));
  assert.equal(byName.size, cases.length, 'unique names');
  for (const n of T_REG_28) assert.ok(byName.has(n), `T-REG-28 row ${n}`);
  for (const c of cases) {
    assert.ok([1, 2, 3, 4, null].includes(c.check), `${c.name}: check`);
    assert.ok(['pass', 'fail'].includes(c.expect), `${c.name}: expect`);
    assert.ok(['python', 'typescript', 'javascript', 'c_sharp', 'markdown', 'notebook'].includes(c.lang), `${c.name}: lang`);
    if (c.expect === 'pass') assert.equal(c.check, null, `${c.name}: a pass reports no check`);
    if (c.expect === 'fail' && c.check !== null) {
      assert.ok(c.reason !== undefined, `${c.name}: reason`);
      const byCheck: Record<number, string[]> = {
        1: ['new_error_node', 'undecodable', 'conflict_markers'], 2: ['incompatible_caller', 'orphan_call'],
        3: ['unresolved_import', 'removed_name_called'], 4: ['label_count', 'shrink', 'emptied', 'deleted'],
      };
      assert.ok(byCheck[c.check]!.includes(c.reason as string), `${c.name}: reason ${c.reason} belongs to check ${c.check}`);
    }
    if (c.check === null && c.expect === 'fail') assert.ok(['no_snapshot', 'merge_conflict', 'no_merge'].includes(c.reason as string), `${c.name}: a no-check reason`);
    if (c.line !== undefined) assert.ok(c.expect === 'fail' && c.check !== null && c.check <= 3, `${c.name}: line only on a check 1–3 failure`);
    if (c.tipEqualsA) assert.deepEqual(c.TIP, c.A, `${c.name}: TIP = A`);
    else assert.notDeepEqual(c.TIP, c.A, `${c.name}: TIP != A`);
    const changed = Object.keys({ ...c.A, ...c.R }).filter((p) => JSON.stringify(c.A[p] ?? null) !== JSON.stringify(c.R[p] ?? null));
    assert.ok(changed.length >= 1, `${c.name}: R changes a path`);
  }
  // TC-REG-09: one pass and one fail per check 1–4 and language group.
  const groups: Record<string, string[]> = { py: ['python'], tsjs: ['typescript', 'javascript'], cs: ['c_sharp'] };
  for (const [g, langs] of Object.entries(groups)) {
    for (const k of [1, 2, 3, 4]) {
      for (const ex of ['pass', 'fail']) {
        const c = byName.get(`tc09/${g}/${k}_${ex}`);
        assert.ok(c !== undefined, `tc09/${g}/${k}_${ex}`);
        assert.ok(langs.includes(c.lang), `${c.name}: lang`);
        assert.equal(c.expect, ex);
        assert.equal(c.check, ex === 'fail' ? k : null);
      }
    }
  }
  assert.equal(cases.filter((c) => c.name.startsWith('tc09/')).length, 24);
  // R4-70: check-2 fails are non-removal breaking changes; check-3 fails are removals and unresolved imports.
  const reasons = (k: number): Set<string> => new Set(cases.filter((c) => c.check === k && c.expect === 'fail').map((c) => c.reason as string));
  assert.deepEqual([...reasons(2)].sort(), ['incompatible_caller', 'orphan_call']);
  assert.deepEqual([...reasons(3)].sort(), ['removed_name_called', 'unresolved_import']);
  const kinds = new Set(cases.flatMap((c) => (c.check === 2 && c.expect === 'fail' ? [MANIFEST.fixtures[`editcheck/${c.name}.json`]?.how ?? ''] : [])).join(' ').match(/\b(param_removed|param_reordered|param_renamed|required_added|varargs_removed|overload_gone)\b/g) ?? []);
  assert.deepEqual([...kinds].sort(), ['overload_gone', 'param_removed', 'param_renamed', 'param_reordered', 'required_added', 'varargs_removed']);
  assert.ok(cases.some((c) => c.check === 2 && !c.tipEqualsA && c.name.includes('tip_caller')), 'the TIP-side caller not updated');
  // T-REG-28's named lines.
  assert.equal(byName.get('1/conflict_markers')!.line, 4);
  assert.ok(byName.get('1/undecodable')!.line === undefined);
  const inc = byName.get('2/incompatible_caller')!;
  assert.ok(inc.line !== undefined && !Object.keys(inc.R).some((p) => JSON.stringify(inc.R[p]) !== JSON.stringify(inc.A[p]) && p === 'orders.py'), 'the caller sits in a file outside the CS');
  for (const n of ['1/new_error_node', '2/incompatible_caller', '3/unresolved_import']) {
    assert.equal(byName.get(n)!.tipEqualsA, true, `${n}: the TIP = A row`);
    assert.ok(byName.has(`${n}@tip`), `${n}: the TIP != A variant`);
    assert.equal(byName.get(`${n}@tip`)!.tipEqualsA, false);
  }
  // A duplicated def via the merge and an orphan call exist only with TIP != A.
  for (const n of ['4/label_count', '2/orphan_call']) assert.equal(byName.get(n)!.tipEqualsA, false, n);
  // TC-REG-10 (a) form triples (R4-22): cp949 vs cp949 CRLF and UTF-16LE vs UTF-16LE with BOM, same verdict within a pair; the BOM+CRLF
  // partner of the LF Python case is formVariant of each side (a {b64} BOM/CRLF case would be a form fixture the brief does not list).
  const pyLf = byName.get('forms/py_lf');
  assert.ok(pyLf !== undefined && pyLf.lang === 'python' && Object.values(pyLf.R).every((v) => typeof v === 'string'), 'the LF member of the BOM+CRLF pair');
  const pairs = [['forms/cp949_lf', 'forms/cp949_crlf'], ['forms/utf16le', 'forms/utf16le_bom']];
  for (const [x, y] of pairs) {
    const a = byName.get(x as string);
    const b = byName.get(y as string);
    assert.ok(a !== undefined && b !== undefined, `${x} / ${y}`);
    assert.deepEqual([a.expect, a.check], [b.expect, b.check], `${x} and ${y} share a verdict`);
  }
  const cp = byName.get('forms/cp949_lf')!;
  const cpR = Object.values(cp.R).find((v) => v !== null) as FixtureBytes;
  assert.ok(!decodes(fixtureBytes(cpR)) && fixtureBytes(cpR).includes(Buffer.from([0xb0, 0xa1])), 'the cp949 triple is cp949');
  const u16 = byName.get('forms/utf16le_bom')!;
  assert.deepEqual([...fixtureBytes(Object.values(u16.R).find((v) => v !== null) as FixtureBytes).subarray(0, 2)], [0xff, 0xfe]);
  const und = byName.get('1/undecodable')!;
  assert.ok(Object.values(und.R).some((v) => v !== null && !decodes(fixtureBytes(v))), 'the undecodable R');
  // T-REG-29: 20 edits of one function within 2 s.
  const burst = JSON.parse(fixture('editcheck/burst.json').toString('utf8')) as { path: string; function: string; edits: Array<{ atMs: number; bytes: string }> };
  assert.equal(burst.edits.length, 20);
  assert.ok(burst.edits.every((e, i) => e.atMs >= 0 && e.atMs < 2_000 && (i === 0 || e.atMs > burst.edits[i - 1]!.atMs)));
  assert.equal(new Set(burst.edits.map((e) => e.bytes)).size, 20);
  const shrink = (c: EditCheckCase): number => {
    const p = Object.keys(c.TIP).find((k) => c.TIP[k] !== null)!;
    return 1 - fixtureBytes(c.R[p] as FixtureBytes).length / fixtureBytes(c.TIP[p] as FixtureBytes).length;
  };
  assert.ok(shrink(byName.get('4/shrink')!) > 0.5 && shrink(byName.get('4/shrink')!) < 0.7, '60 % shrink');
  // TC-REG-09 "a 49 % shrink → pass": exactly 49 % in bytes and in rows (100 equal-length rows keep 51), so a check-4 threshold
  // anywhere in (49 %, 50 %] still passes it and one at 49 % or below fails it (Task 10's M46_4).
  const s49 = byName.get('pass/shrink_49')!;
  const s49Path = Object.keys(s49.TIP).find((k) => s49.TIP[k] !== null)!;
  const s49Tip = fixtureBytes(s49.TIP[s49Path] as FixtureBytes);
  const s49R = fixtureBytes(s49.R[s49Path] as FixtureBytes);
  assert.deepEqual([rows(s49Tip).length, rows(s49R).length], [100, 51], '49 % shrink: 100 rows keep 51');
  assert.equal(new Set(rows(s49Tip).map((r) => r.length)).size, 1, '49 % shrink: equal-length rows');
  assert.equal(s49R.length * 100, s49Tip.length * 51, `49 % shrink: ${s49R.length} of ${s49Tip.length} bytes`);
  const emptied = byName.get('4/emptied')!;
  assert.ok(Object.values(emptied.R).some((v) => v !== null && fixtureBytes(v).length === 0), 'an emptied file');
  assert.equal(rows(fixtureBytes(Object.values(byName.get('pass/grammarless_250')!.R).find((v) => v !== null) as FixtureBytes)).length, 250);
});

test('exp_a and exp_bc validate against HoldScenario', () => {
  for (const name of ['exp_a', 'exp_bc_b1', 'exp_bc_b2', 'exp_bc_c1']) {
    const h = holdScenario(name);
    assert.equal(h.name, name);
    assert.ok(Object.keys(h.files).length >= 1);
    assert.ok(h.steps.length >= 4);
    for (const st of h.steps) {
      assert.ok(Number.isInteger(st.peer) && st.peer >= 0 && st.peer <= 3, `${name}: peer`);
      assert.ok(['edit', 'stale_save', 'claim', 'publish'].includes(st.kind), `${name}: kind`);
      assert.ok(h.files[st.path] !== undefined, `${name}: step path`);
      assert.equal(st.bytes !== undefined, st.kind === 'edit' || st.kind === 'stale_save', `${name}: bytes on edit and stale_save only`);
    }
    assert.deepEqual(h.claimSteps, h.steps.flatMap((st, i) => (st.kind === 'claim' ? [i] : [])), `${name}: claimSteps mark the claim steps`);
    assert.ok(h.claimSteps.length >= 1);
    const stale = h.steps.find((st) => st.kind === 'stale_save');
    assert.ok(stale !== undefined, `${name}: a stale editor save`);
    const fixRow = 'y = x + 2  # B fix';
    const edits = h.steps.filter((st) => st.kind === 'edit' && st.peer !== stale.peer);
    assert.ok(edits.some((st) => text(st.bytes).includes('# B')), `${name}: a teammate's landed change`);
    if (name !== 'exp_bc_b2') assert.ok(!text(stale.bytes).includes(fixRow) && edits.some((st) => text(st.bytes).includes(fixRow)), `${name}: the stale save reverts the fix`);
  }
  const c1 = holdScenario('exp_bc_c1');
  assert.ok(text(c1.steps.find((st) => st.kind === 'stale_save')!.bytes).includes('w = z - 5'), 'c1: a new own edit in the same save');
});

test('bigBomCrlf(26_436) and oneDotThreeMb() are Plan 1\'s 26,436-row file', () => {
  const b = bigBomCrlf(26_436);
  assert.deepEqual(b, generateBigBomCrlf(26_436, seededRandom('regions-26436')));
  assert.equal(rows(b).length, 26_436);
  assert.ok(b.subarray(0, 3).equals(BOM));
  assert.equal(count(b.toString('latin1'), '\n'), count(b.toString('latin1'), '\r\n'));
  assert.deepEqual(oneDotThreeMb(), b);
  assert.deepEqual(fixture('big26k_bomcrlf.py'), b);
  assert.ok(b.length >= 1_200_000 && b.length <= 1_400_000, `size ${b.length}`);
});
