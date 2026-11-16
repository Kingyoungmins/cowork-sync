// Region fixture corpus (Plan 4 Task 2; R4-21, OQ-24, 2Q-07, 3Q-15): loaders for the checked-in fixtures under
// test/fixtures/regions/ and the seeded generators for the large or derived ones (the 5,960-row hot-zone file, its LF form,
// Plan 1's 26,436-row file, the rc_touch and fwd posts, the S9 block file). The provenance of every name is in
// test/fixtures/regions/README.md and manifest.json. Runs in Wave A beside Task 1: imports nothing from src/regions.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import type { Json } from '../../src/board/canonicalJson.js';
import { randomInt, seededRandom, type Random } from '../../src/ports/random.js';
import { generateBigBomCrlf } from '../sim/fixtures/bigBomCrlf.js';

/** A name listed in test/fixtures/regions/README.md: a path under test/fixtures/regions/ or a generated name. */
export type RegionFixtureName = string;

/** The eight TouchReason values of Task 1, spelled out here (Task 6 checks the two unions are mutually assignable). */
export type FixtureTouchReason = 'base-overlap' | 'insert-inside' | 'boundary-in-extent' | 'boundary-in-error' | 'boundary-no-table' | 'group-name' | 'degraded-whole-file' | 'none';

/** File content in a fixture JSON: a UTF-8 string, or { b64 } for bytes a JSON string cannot round-trip (non-UTF-8, cp949, an undecodable splice output, BOM/CRLF forms);
 *  every { b64 } entry and every CRLF/BOM file is listed in the manifest with form: true. */
export type FixtureBytes = string | { readonly b64: string };

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'regions');
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function readChecked(name: string): Buffer {
  return readFileSync(join(FIX_DIR, ...name.split('/')));
}

export function fixtureBytes(f: FixtureBytes): Buffer {
  return typeof f === 'string' ? Buffer.from(f, 'utf8') : Buffer.from(f.b64, 'base64');
}

/** The parsed test/fixtures/regions/manifest.json. */
export const FIXTURE_MANIFEST: Json = JSON.parse(readChecked('manifest.json').toString('utf8')) as Json;

/** Adds the UTF-8 BOM and/or turns every LF into CRLF; { bom: false, crlf: false } is the identity. */
export function formVariant(lf: Buffer, f: { bom: boolean; crlf: boolean }): Buffer {
  const body = f.crlf ? Buffer.from(lf.toString('latin1').split('\n').join('\r\n'), 'latin1') : Buffer.from(lf);
  return f.bom ? Buffer.concat([BOM, body]) : body;
}

// ---------------------------------------------------------------------------------------------------------------------------
// bigBomCrlf(5_960): a purpose-built generator with the 04 hot zone at rows 5300–5346 and exactly 432 leaf units by construction.
// The schedule is a data table (one entry per template: rows, leaf units, instances before and after the hot zone) so that Task 4
// can adjust it outside rows 5300–5346 as a local edit (R4-21); the README lists each template's contribution.

type TemplateName = 'scale' | 'lookup' | 'normalise' | 'report' | 'Record' | 'Gauge' | 'LIMIT' | 'gap';

interface Template { readonly rows: number; readonly units: number; make(id: string, k: number): string[]; }

const fill = (rowsIn: readonly string[], id: string, k: number): string[] =>
  rowsIn.map((r) =>
    r.split('@ID@').join(id).split('@K@').join(String(k)).split('@K2@').join(String(k % 9 + 2)).split('@K7@').join(String(k % 7))
      .split('@KMAX@').join(String(100 + k)).split('@KC@').join(String(16 * (k % 4 + 1))).split('@KR@').join(String(k % 90 + 10)));

/** Every template ends with two blank rows (the PEP 8 separator), so each instance starts at column 0 after a blank pair. */
const TEMPLATES: Readonly<Record<TemplateName, Template>> = {
  // A plain 8-row function (1 leaf unit).
  scale: {
    rows: 10, units: 1,
    make: (id, k) => fill([
      'def scale_@ID@(value, factor=@K2@):',
      '    """Scale a value for section @ID@."""',
      '    # \u{ac12} @ID@ \u{c744} \u{c870}\u{c815}\u{d569}\u{b2c8}\u{b2e4}',
      '    result = value * factor',
      '    if result > @KMAX@:',
      '        result = @KMAX@',
      '    result += @K7@',
      '    return result',
      '', '',
    ], id, k),
  },
  // A decorated 12-row function (1 leaf unit; the decorator starts its extent).
  lookup: {
    rows: 14, units: 1,
    make: (id, k) => fill([
      '@functools.lru_cache(maxsize=@KC@)',
      'def lookup_@ID@(key):',
      '    """Look up entry @ID@ by key."""',
      '    table = {"a": @K@, "b": @K2@, "c": @KMAX@}',
      '    value = table.get(key, 0)',
      '    if value < 0:',
      '        raise ValueError("negative entry @ID@")',
      '    for step in range(3):',
      '        value += step',
      '    value -= @K7@',
      '    value *= 2',
      '    return value',
      '', '',
    ], id, k),
  },
  // A 16-row function with a two-row attached comment (1 leaf unit; the comment is inside its extent).
  normalise: {
    rows: 18, units: 1,
    make: (id, k) => fill([
      '# Section @ID@: normalise the records before export.',
      '# The order of the steps matters for the totals.',
      'def normalise_@ID@(records):',
      '    """Normalise the records of section @ID@."""',
      '    out = []',
      '    for record in records:',
      '        name = record.get("name", "").strip()',
      '        if not name:',
      '            continue',
      '        amount = float(record.get("amount", 0))',
      '        if amount < 0:',
      '            amount = 0.0',
      '        out.append({"name": name, "amount": round(amount, 2), "section": @K@})',
      '    out.sort(key=lambda r: r["name"])',
      '    total = sum(r["amount"] for r in out)',
      '    return out, total',
      '', '',
    ], id, k),
  },
  // A 24-row function with one blank row inside its body (1 leaf unit, one contiguous range, R4-18).
  report: {
    rows: 26, units: 1,
    make: (id, k) => fill([
      'def report_@ID@(rows, *, currency="EUR"):',
      '    """Build report @ID@ from (label, amount) rows."""',
      '    lines = []',
      '    count = 0',
      '    total = 0.0',
      '    for row in rows:',
      '        label = str(row[0])',
      '        amount = float(row[1])',
      '        if amount == 0:',
      '            continue',
      '        count += 1',
      '        total += amount',
      '        lines.append(f"{label}: {amount:.2f} {currency}")',
      '',
      '    total = round(total, @K7@)',
      '    if count == 0:',
      '        return "report @ID@: empty"',
      '    average = total / count',
      '    header = f"report @ID@: {count} rows"',
      '    footer = f"total {total:.2f}, average {average:.2f}"',
      '    lines.insert(0, header)',
      '    lines.append(footer)',
      '    text = "; ".join(lines)',
      '    return text',
      '', '',
    ], id, k),
  },
  // A class with a class-level assignment and two methods (3 leaf units: the residue and two methods).
  Record: {
    rows: 13, units: 3,
    make: (id, k) => fill([
      'class Record_@ID@:',
      '    """Plain record type @ID@."""',
      '',
      '    kind = "record-@ID@"',
      '',
      '    def __init__(self, name, amount=@K@):',
      '        self.name = name',
      '        self.amount = amount',
      '',
      '    def describe(self):',
      '        return f"{self.kind}: {self.name} = {self.amount}"',
      '', '',
    ], id, k),
  },
  // A class with a property getter and setter (4 leaf units: the residue, __init__, the getter and the setter).
  Gauge: {
    rows: 15, units: 4,
    make: (id, k) => fill([
      'class Gauge_@ID@:',
      '    """Gauge @ID@ with a validated level."""',
      '',
      '    def __init__(self, level=@K@):',
      '        self._level = level',
      '',
      '    @property',
      '    def level(self):',
      '        return self._level',
      '',
      '    @level.setter',
      '    def level(self, value):',
      '        self._level = max(0, value)',
      '', '',
    ], id, k),
  },
  // Three module-level single-name assignments (3 leaf const units).
  LIMIT: {
    rows: 5, units: 3,
    make: (id, k) => fill([
      'LIMIT_@ID@ = @K@',
      'RATE_@ID@: float = 0.@KR@',
      'NAMES_@ID@ = ("alpha-@ID@", "beta-@ID@")',
      '', '',
    ], id, k),
  },
  // Two top-level statements outside every unit (1 gap block).
  gap: {
    rows: 4, units: 1,
    make: (id) => fill([
      'os.environ.setdefault("COWORK_FIXTURE_SECTION", "gap_@ID@")',
      'sys.path.append(os.path.join("vendor", "gap_@ID@"))',
      '', '',
    ], id, 0),
  },
};

/**
 * The template schedule (R4-21): instances before rows 5300–5346 and after them. Sums: 5,289 rows before, 614 after; 336 + 88 leaf units.
 * The table order is the interleaving tie-break: the first eight instances fill rows 11–100 so that rows 99–100 are a blank pair before a
 * top-level unit (fwd/far_above inserts after row 100); a schedule change must keep that (the fwd test checks it).
 */
const BIG_SCHEDULE: ReadonlyArray<{ readonly template: TemplateName; readonly before: number; readonly after: number }> = [
  { template: 'report', before: 120, after: 6 },
  { template: 'normalise', before: 50, after: 5 },
  { template: 'scale', before: 27, after: 6 },
  { template: 'lookup', before: 50, after: 5 },
  { template: 'Record', before: 7, after: 8 },
  { template: 'gap', before: 12, after: 6 },
  { template: 'LIMIT', before: 8, after: 4 },
  { template: 'Gauge', before: 8, after: 6 },
];

/** Rows 1–10: a module docstring (1 gap block), blank, <imports> at rows 3–8, two blank rows. */
const BIG_HEADER: readonly string[] = [
  '"""Generated region fixture (cowork-sync Plan 4 Task 2): templates around the 04 hot zone at rows 5300-5346."""',
  '',
  'from __future__ import annotations',
  '',
  'import functools',
  'import os',
  'import sys',
  'from typing import Any',
  '',
  '',
];
const BIG_HEADER_UNITS = 1;

/** Rows 5300–5346 (04 §3.6, HOT_ZONE): Account (residue, __init__, getter, setter), parse, compute_total, compute_tax: 7 leaf units. */
const HOT_ZONE_ROWS: readonly string[] = [
  'class Account:',
  '    """Bank account whose balance is validated."""',
  '',
  '    def __init__(self, balance=0):',
  '        self._balance = balance',
  '',
  '    @property',
  '    def balance(self):',
  '        return self._balance',
  '',
  '    @balance.setter',
  '    def balance(self, value):',
  '        if value < 0:',
  '            raise ValueError("negative balance")',
  '        self._balance = value',
  '',
  '',
  '@functools.lru_cache(maxsize=None)',
  'def parse(text):',
  '    """Split one order line into its fields."""',
  '    fields = {}',
  '    for part in text.split(";"):',
  '        if "=" not in part:',
  '            continue',
  '        key, _, value = part.partition("=")',
  '        key = key.strip()',
  '        if key:',
  '            fields[key] = value.strip()',
  '    return fields',
  '',
  '',
  '# Sum the line items of an order, rounded to cents.',
  'def compute_total(items):',
  '    total = 0',
  '    for item in items:',
  '        price = item.price * item.quantity',
  '        if item.discount:',
  '            price -= item.discount',
  '        total += price',
  '    return round(total, 2)',
  '',
  '',
  'def compute_tax(total, rate):',
  '    total = total * rate',
  '    return round(total, 2)',
  '',
  '',
];
const HOT_ZONE_UNITS = 7;
const HOT_ZONE_FIRST_ROW = 5300;

export const HOT_ZONE = {
  account: [5300, 5314],
  getter: [5306, 5308],
  setter: [5310, 5314],
  parse: [5317, 5328],
  computeTotal: [5331, 5339],
  computeTax: [5342, 5344],
} as const;

/** The generator's own leaf-unit count of bigBomCrlf(5_960) (members, functions, consts, class residues and gap blocks). */
export const BIG_UNITS = 432;

/** Interleaves the templates evenly (largest remaining share first, ties by table order); instance ids count up across the file. */
function emitSchedule(part: 'before' | 'after', firstId: number): { lines: string[]; units: number; nextId: number } {
  const left = BIG_SCHEDULE.map((e) => ({ template: e.template, total: e[part], left: e[part] }));
  const lines: string[] = [];
  let units = 0;
  let id = firstId;
  for (;;) {
    let best = -1;
    for (let i = 0; i < left.length; i++) {
      const c = left[i]!;
      if (c.left === 0) continue;
      if (best < 0) {
        best = i;
        continue;
      }
      const b = left[best]!;
      if (c.left * b.total > b.left * c.total) best = i;
    }
    if (best < 0) break;
    const c = left[best]!;
    c.left--;
    const t = TEMPLATES[c.template];
    const rowsOut = t.make(String(id).padStart(4, '0'), (id * 37) % 1000);
    if (rowsOut.length !== t.rows) throw new Error(`template ${c.template}: ${rowsOut.length} rows, declared ${t.rows}`);
    lines.push(...rowsOut);
    units += t.units;
    id++;
  }
  return { lines, units, nextId: id };
}

let big5960: { lf: Buffer; units: number } | undefined;

function build5960(): { lf: Buffer; units: number } {
  if (big5960 !== undefined) return big5960;
  const before = emitSchedule('before', 1);
  const after = emitSchedule('after', before.nextId);
  const lines = [...BIG_HEADER, ...before.lines];
  if (lines.length !== HOT_ZONE_FIRST_ROW - 1) throw new Error(`bigBomCrlf(5_960): the hot zone would start at row ${lines.length + 1}, not ${HOT_ZONE_FIRST_ROW}`);
  lines.push(...HOT_ZONE_ROWS, ...after.lines);
  if (lines.length !== 5_960) throw new Error(`bigBomCrlf(5_960): ${lines.length} rows`);
  const units = BIG_HEADER_UNITS + before.units + HOT_ZONE_UNITS + after.units;
  if (units !== BIG_UNITS) throw new Error(`bigBomCrlf(5_960): the schedule gives ${units} leaf units, not ${BIG_UNITS}`);
  big5960 = { lf: Buffer.from(`${lines.join('\n')}\n`, 'utf8'), units };
  return big5960;
}

let big26436: Buffer | undefined;

/** 5,960: the purpose-built hot-zone file (BOM + CRLF); 26,436: Plan 1 generateBigBomCrlf(26_436, seededRandom('regions-26436')). */
export function bigBomCrlf(lines: 5_960 | 26_436): Buffer {
  if (lines === 26_436) {
    big26436 ??= generateBigBomCrlf(26_436, seededRandom('regions-26436'));
    return Buffer.from(big26436);
  }
  if (lines !== 5_960) throw new RangeError(`bigBomCrlf: 5_960 or 26_436, got ${String(lines)}`);
  return formVariant(build5960().lf, { bom: true, crlf: true });
}

/** bigBomCrlf(5_960) without the BOM and with every CRLF turned into LF. */
export function bigLf(lines: 5_960): Buffer {
  if (lines !== 5_960) throw new RangeError(`bigLf: 5_960 only, got ${String(lines)}`);
  return Buffer.from(build5960().lf);
}

/** The 1.3 MB file of T-REG-15/T-REG-29: the same bytes as bigBomCrlf(26_436). */
export function oneDotThreeMb(): Buffer {
  return bigBomCrlf(26_436);
}

// ---------------------------------------------------------------------------------------------------------------------------
// rc_touch R2 (04 §3.6 VERIFIED, T-REG-02, TC-REG-02): 15 rows; the Python posts are big_lf.py with the listed edit.

interface RowEdit { readonly after?: number; readonly insert?: readonly string[]; readonly replace?: readonly [number, string]; }

const R2_PY_EDITS: Readonly<Record<string, RowEdit>> = {
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
      'def compute_discount(items):',
      '    total = 0',
      '    for item in items:',
      '        if item.discount:',
      '            total += item.discount',
      '    total = min(total, 100)',
      '    return round(total, 2)',
      '',
      '',
    ],
  },
  py_overload_stubs_above: { after: 5330, insert: ['@overload', 'def compute_total(items: list) -> float: ...', ''] },
  py_sibling_edit: { replace: [5320, '    fields = dict()'] },
  py_new_method_after_setter: { after: 5315, insert: ['    def reset(self):', '        self._balance = 0', ''] },
};

const py = (name: string): string => `rc_touch/${name}.post.py`;

export const RC_TOUCH_R2: ReadonlyArray<{ readonly name: string; readonly base: string; readonly post: string; readonly claimUnit: string; readonly expect: FixtureTouchReason }> = [
  { name: 'py_body_edit', base: 'big_lf.py', post: py('py_body_edit'), claimUnit: 'compute_total', expect: 'base-overlap' },
  { name: 'py_append_after_last_line', base: 'big_lf.py', post: py('py_append_after_last_line'), claimUnit: 'compute_total', expect: 'boundary-in-extent' },
  { name: 'py_decorator_under_attached_comment', base: 'big_lf.py', post: py('py_decorator_under_attached_comment'), claimUnit: 'compute_total', expect: 'insert-inside' },
  { name: 'py_attached_comment_above', base: 'big_lf.py', post: py('py_attached_comment_above'), claimUnit: 'compute_total', expect: 'boundary-in-extent' },
  { name: 'py_boundary_insert_half_typed', base: 'big_lf.py', post: py('py_boundary_insert_half_typed'), claimUnit: 'compute_total', expect: 'boundary-in-error' },
  { name: 'py_decorator_only_edit', base: 'big_lf.py', post: py('py_decorator_only_edit'), claimUnit: 'parse', expect: 'base-overlap' },
  { name: 'py_append_setter_body', base: 'big_lf.py', post: py('py_append_setter_body'), claimUnit: 'Account.balance#setter', expect: 'boundary-in-extent' },
  { name: 'js_append_setter_body', base: 'rc_touch/account.js', post: 'rc_touch/js_append_setter_body.post.js', claimUnit: 'Account.balance#set', expect: 'insert-inside' },
  { name: 'cs_new_overload_not_adjacent_to_held', base: 'csharp/Svc.cs', post: 'csharp/Svc.new_overload.cs', claimUnit: 'N.Svc.Calc#(int)', expect: 'group-name' },
  { name: 'py_new_def_after', base: 'big_lf.py', post: py('py_new_def_after'), claimUnit: 'compute_total', expect: 'none' },
  { name: 'py_same_tail_def_after', base: 'big_lf.py', post: py('py_same_tail_def_after'), claimUnit: 'compute_total', expect: 'none' },
  { name: 'py_overload_stubs_above', base: 'big_lf.py', post: py('py_overload_stubs_above'), claimUnit: 'compute_total', expect: 'none' },
  { name: 'py_sibling_edit', base: 'big_lf.py', post: py('py_sibling_edit'), claimUnit: 'compute_total', expect: 'none' },
  { name: 'py_new_method_after_setter', base: 'big_lf.py', post: py('py_new_method_after_setter'), claimUnit: 'Account.balance#setter', expect: 'none' },
  { name: 'js_getter_above_setter', base: 'rc_touch/account.js', post: 'rc_touch/js_getter_above_setter.post.js', claimUnit: 'Account.balance#set', expect: 'none' },
];

/** LF rows (without their LF) of an LF buffer that ends with LF. */
function lfRows(b: Buffer): string[] {
  const s = b.toString('utf8');
  if (!s.endsWith('\n')) throw new Error('lfRows: the buffer does not end with LF');
  return s.slice(0, -1).split('\n');
}

function applyRowEdit(base: Buffer, e: RowEdit): Buffer {
  const rowsIn = lfRows(base);
  if (e.replace !== undefined) rowsIn[e.replace[0] - 1] = e.replace[1];
  else rowsIn.splice(e.after as number, 0, ...(e.insert as string[]));
  return Buffer.from(`${rowsIn.join('\n')}\n`, 'utf8');
}

// ---------------------------------------------------------------------------------------------------------------------------
// fwd (04 §3.4 "exact mapping in 4/4 insertion variants"): 22 rows inserted into big_lf.py after rows 100, 5330, 5341, 5341.

const FWD_AFTER: Readonly<Record<string, number>> = { far_above: 100, directly_above: 5330, directly_after: 5341, same_tail: 5341 };

// ---------------------------------------------------------------------------------------------------------------------------
// S9 (T-REG-21, TC-REG-04): an 800-block grammarless text file (path class 6 under a name without a grammar, e.g. s9.txt) with one
// claimed block between the marker rows S9-CLAIM-BEGIN and S9-CLAIM-END; every step applies an optional holder edit inside the
// block (holder) and then the peer's churn above, inside and below it (peer); oracle = the block's rows in peer.

const S9_BLOCKS = 800;
const S9_CLAIMED_BLOCK = 400;
const S9_BEGIN = '    # S9-CLAIM-BEGIN';
const S9_END = '    # S9-CLAIM-END';
const S9_CHURN = '    # s9 churn ';

function s9Initial(r: Random): string[] {
  const out: string[] = [];
  for (let b = 0; b < S9_BLOCKS; b++) {
    if (b > 0) out.push('');
    const id = String(b).padStart(4, '0');
    const n = 1 + randomInt(r, 4);
    if (b === S9_CLAIMED_BLOCK) out.push(S9_BEGIN);
    for (let i = 0; i < n; i++) out.push(`    s9_${id}_${i} = s9_step(${id}, ${i}, ${randomInt(r, 1000)})`);
    if (b === S9_CLAIMED_BLOCK) out.push(S9_END);
  }
  return out;
}

function s9Markers(lines: readonly string[]): [number, number] {
  return [lines.indexOf(S9_BEGIN) + 1, lines.indexOf(S9_END) + 1];
}

const s9Buf = (lines: readonly string[]): Buffer => Buffer.from(`${lines.join('\n')}\n`, 'utf8');

export function s9Generator(seed: string): Iterable<{ readonly step: number; readonly holder: Buffer; readonly peer: Buffer; readonly oracle: ReadonlyArray<readonly [number, number]> }> {
  return {
    *[Symbol.iterator]() {
      const r = seededRandom(`s9:${seed}`);
      const live = s9Initial(r);
      const first = s9Buf(live);
      yield { step: 0, holder: first, peer: Buffer.from(first), oracle: [s9Markers(live)] };
      for (let step = 1; ; step++) {
        // Holder edit inside the claimed block (about one step in three): change one content row or insert one.
        if (randomInt(r, 3) === 0) {
          const [lo, hi] = s9Markers(live);
          // 0-based: the BEGIN row is lo - 1, the END row is hi - 1, the block's inside rows are lo .. hi - 2.
          const content: number[] = [];
          for (let i = lo; i < hi - 1; i++) if (live[i] !== '') content.push(i);
          if (content.length > 0 && randomInt(r, 2) === 0) {
            const at = content[randomInt(r, content.length)]!;
            live[at] = `${live[at]}  # holder ${step}`;
          } else {
            const at = content.length > 0 ? content[randomInt(r, content.length)]! + 1 : lo;
            live.splice(at, 0, `    s9_holder_${step} = s9_step(${step})`);
          }
        }
        const holder = s9Buf(live);
        // Peer churn: 1–3 operations, each inserting 1–16 unique churn rows (`    # s9 churn <step>.<op>.<i>`) at one point or
        // deleting up to 16 blank or churn rows, above, inside or below the claimed block (0-based half-open ranges that never
        // include a marker row). No blank row is ever inserted and no churn row text recurs, so every row a later peer shares with
        // an earlier peer is the same row: every minimal diff matches both marker rows and the oracle is exact (T-REG-21; blank-row
        // churn let runs of identical blank rows migrate across the markers, which no minimal diff follows).
        const ops = 1 + randomInt(r, 3);
        for (let o = 0; o < ops; o++) {
          const [lo, hi] = s9Markers(live);
          const where = randomInt(r, 3);
          const range: [number, number] = where === 0 ? [0, lo - 1] : where === 1 ? [lo, hi - 1] : [hi, live.length];
          const k = 1 + randomInt(r, 16);
          if (randomInt(r, 2) === 0) {
            const at = range[0] + randomInt(r, range[1] - range[0] + 1);
            live.splice(at, 0, ...Array.from({ length: k }, (_, i) => `${S9_CHURN}${step}.${o}.${i}`));
          } else {
            const removable: number[] = [];
            for (let i = range[0]; i < range[1]; i++) if (live[i] === '' || live[i]!.startsWith(S9_CHURN)) removable.push(i);
            const drop = new Set<number>();
            while (drop.size < Math.min(k, removable.length)) drop.add(removable[randomInt(r, removable.length)]!);
            for (const i of [...drop].sort((x, y) => y - x)) live.splice(i, 1);
          }
        }
        yield { step, holder, peer: s9Buf(live), oracle: [s9Markers(live)] };
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// fixture(): checked-in files and generated names.

const generated = new Map<string, () => Buffer>([
  ['big_wt.py', () => bigBomCrlf(5_960)],
  ['big_lf.py', () => bigLf(5_960)],
  ['big26k_bomcrlf.py', () => bigBomCrlf(26_436)],
  ['s9/step0.txt', () => {
    for (const s of s9Generator('s9-0')) return s.holder;
    throw new Error('s9Generator yielded nothing');
  }],
]);
for (const [name, edit] of Object.entries(R2_PY_EDITS)) generated.set(py(name), () => applyRowEdit(bigLf(5_960), edit));
// The git-vs-FoldMapper/1 same-tail variant: big_lf.py with the rc_touch edits its checked-in JSON lists, applied in order.
generated.set('same_tail/git_vs_foldmapper.post.py', () => {
  const d = JSON.parse(readChecked('same_tail/git_vs_foldmapper.json').toString('utf8')) as { edits: string[] };
  return d.edits.reduce((b, n) => {
    const e = R2_PY_EDITS[n];
    if (e === undefined) throw new Error(`same_tail/git_vs_foldmapper.json: unknown rc_touch edit ${n}`);
    return applyRowEdit(b, e);
  }, bigLf(5_960));
});
for (const [v, after] of Object.entries(FWD_AFTER)) {
  generated.set(`fwd/${v}.post.py`, () => applyRowEdit(bigLf(5_960), { after, insert: lfRows(readChecked(`fwd/${v}.block.py`)) }));
}
/** fast-check seeds are numbers: the first 4 bytes of seededRandom(name) as a little-endian int32. */
const arbSeed = (name: string): number => Buffer.from(seededRandom(name).bytes(4)).readInt32LE(0);
for (const [ext, lang] of [['py', 'python'], ['js', 'javascript'], ['ts', 'typescript'], ['cs', 'c_sharp']] as const) {
  generated.set(`arb/sample.${ext}`, () => Buffer.from(fc.sample(unitFileArb(lang), { seed: arbSeed('arb'), numRuns: 1 })[0]!.text, 'utf8'));
}

export function fixture(name: RegionFixtureName): Buffer {
  const g = generated.get(name);
  return g !== undefined ? g() : readChecked(name);
}

// ---------------------------------------------------------------------------------------------------------------------------
// Scenario loaders.

export interface SweepScenario {
  name: string;
  files: Record<string, { base: FixtureBytes | null; ours?: FixtureBytes | null; theirs?: FixtureBytes | null }>;
  claims: Array<{ holderSeat: string; path: string; claimUnit?: string; ranges?: Array<[number, number]> }>;
  expect: 'byte_identical' | 'held' | 'conflict_hold';
  oracle?: Record<string, FixtureBytes | null>;
  corrupting: boolean;
  corruptOut?: Record<string, FixtureBytes | null>;
  hazard?: { path: string; pattern: string; count: number };
  /** R4-80: for a corrupting scenario, the mechanism that catches its regenerated hazard (Task 7 asserts the tripwire ones, Task 15 every one); absent when not corrupting. */
  caughtBy?: 'tripwire_b' | 'tripwire_c' | 'b1' | 'placement' | 't0';
  duplicatedKey?: string;   // tripwire_b only: the label key (kind \0 qualname \0 disc) the splice duplicates in one file
}

export function sweepScenario(name: string): SweepScenario {
  return JSON.parse(readChecked(`sweep/${name}/scenario.json`).toString('utf8')) as SweepScenario;
}

export interface HoldScenario { name: string; files: Record<string, FixtureBytes>; steps: Array<{ peer: number; kind: 'edit' | 'stale_save' | 'claim' | 'publish'; path: string; bytes?: FixtureBytes }>; claimSteps: number[]; }

export function holdScenario(name: string): HoldScenario {
  return JSON.parse(readChecked(`holds/${name}.json`).toString('utf8')) as HoldScenario;
}

export interface HookPayload { pre: Json; post: Json; before: Buffer; after: Buffer; }

export function hookPayload(name: string): HookPayload {
  const dir = `hooks/${name}`;
  const names = readdirSync(join(FIX_DIR, 'hooks', name));
  const one = (prefix: string): Buffer => {
    const hit = names.filter((n) => n.startsWith(`${prefix}.`));
    if (hit.length !== 1) throw new Error(`hookPayload(${name}): ${hit.length} ${prefix}.* files`);
    return readChecked(`${dir}/${hit[0]}`);
  };
  return {
    pre: JSON.parse(readChecked(`${dir}/pre.json`).toString('utf8')) as Json,
    post: JSON.parse(readChecked(`${dir}/post.json`).toString('utf8')) as Json,
    before: one('before'),
    after: one('after'),
  };
}

/** check = the one REG-36 check number a fail case reports (its `failed` deep-equals [check], R4-70); null for a pass or a no-check reason. */
export interface EditCheckCase {
  name: string; check: 1 | 2 | 3 | 4 | null; lang: 'python' | 'typescript' | 'javascript' | 'c_sharp' | 'markdown' | 'notebook'; expect: 'pass' | 'fail'; reason?: string; line?: number;
  tipEqualsA: boolean; A: Record<string, FixtureBytes | null>; R: Record<string, FixtureBytes | null>; TIP: Record<string, FixtureBytes | null>;
}

/** Every editcheck/**\/*.json case except burst.json, by name; a case with tipEqualsA stores no TIP (TIP = A). */
export function editCheckCases(): EditCheckCase[] {
  const out: EditCheckCase[] = [];
  const walk = (rel: string): void => {
    for (const n of readdirSync(join(FIX_DIR, ...rel.split('/'))).sort()) {
      const p = `${rel}/${n}`;
      if (!n.includes('.')) walk(p);
      else if (n.endsWith('.json') && p !== 'editcheck/burst.json') {
        const c = JSON.parse(readChecked(p).toString('utf8')) as Omit<EditCheckCase, 'TIP'> & { TIP?: EditCheckCase['TIP'] };
        if (`editcheck/${c.name}.json` !== p) throw new Error(`editCheckCases: ${p} holds case ${c.name}`);
        out.push({ ...c, TIP: c.tipEqualsA ? { ...c.A } : (c.TIP as EditCheckCase['TIP']) });
      }
    }
  };
  walk('editcheck');
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------------------------------------
// unitFileArb (T-REG-23, INV-REG-PARTITION): random files built from templates. Every non-blank template carries exactly one
// `CW-T` marker and ends with one blank row; a blank-run template is exactly two blank rows; `units` = the number of templates.

type Lang = 'python' | 'javascript' | 'typescript' | 'c_sharp';
type Tpl = { kind: string; a: number; b: number; c: boolean };

const tplArb = (kinds: readonly string[]): fc.Arbitrary<Tpl> =>
  fc.record({ kind: fc.constantFrom(...kinds), a: fc.integer({ min: 1, max: 4 }), b: fc.integer({ min: 0, max: 99 }), c: fc.boolean() });

function pyTemplate(t: Tpl, i: number): string[] {
  const body = Array.from({ length: t.a }, (_, j) => `    v${j} = a + ${t.b + j}`);
  switch (t.kind) {
    case 'imports': return [`import os  # CW-T ${i}`, 'from typing import Any', ''];
    case 'function': return [...(t.c ? [`# Attached comment ${i}.`] : []), `def f_${i}(a, b=${t.b}):  # CW-T`, ...body.slice(0, 1), ...(t.a > 2 ? ['', ...body.slice(1)] : body.slice(1)), '    return a', ''];
    case 'decorated': return [`@staticmethod  # CW-T ${i}`, `def d_${i}(a):`, ...body, '    return a', ''];
    case 'class': {
      const members: string[] = [];
      for (let m = 0; m < t.a; m++) members.push(...(m > 0 || t.c ? [''] : []), `    def m${m}(self, a):`, `        return a + ${m}`);
      return [`class C_${i}:  # CW-T`, ...(t.c ? [`    kind = ${t.b}`] : []), ...members, ''];
    }
    case 'const': return [`NAME_${i} = ${t.b}  # CW-T`, ''];
    case 'comment': return [`# CW-T comment ${i}`, ''];
    case 'statement': return [`print("CW-T ${i}")`, ''];
    default: return ['', ''];
  }
}

function jsTemplate(t: Tpl, i: number, ts: boolean): string[] {
  const ty = (s: string): string => (ts ? s : '');
  const body = Array.from({ length: t.a }, (_, j) => `  const v${j} = a + ${t.b + j};`);
  switch (t.kind) {
    case 'imports': return [`import { x${i} } from './m${i}.js'; // CW-T`, `export { y${i} } from './n${i}.js';`, ''];
    case 'function': return [`${t.c ? 'export ' : ''}function f_${i}(a${ty(': number')}, b${ty(': number')} = ${t.b})${ty(': number')} { // CW-T`, ...body, '  return a + b;', '}', ''];
    case 'generator': return [`function* g_${i}() { // CW-T`, `  yield ${t.b};`, '}', ''];
    case 'class': return [
      `class K_${i} { // CW-T`, `  n = ${t.b};`, '  constructor() {', '    this._v = 0;', '  }', `  get v()${ty(': number')} {`, '    return this._v;', '  }',
      `  set v(x${ty(': number')}) {`, '    this._v = x;', '  }', ...(t.c ? [`  m${i}()${ty(': number')} {`, '    return this.n;', '  }'] : []), '}', '',
    ];
    case 'arrow': return [`const h_${i} = (a${ty(': number')}) => { // CW-T`, ...body, '  return a;', '};', ''];
    case 'object': return [`const api_${i} = { // CW-T`, '  get() {', `    return ${t.b};`, '  },', `  put: function (x${ty(': number')}) {`, '    return x;', '  },', '};', ''];
    case 'iife': return ['(function () { // CW-T', `  function inner_${i}() {`, `    return ${t.b};`, '  }', `  inner_${i}();`, '})();', ''];
    case 'interface': return [`${t.c ? 'export ' : ''}interface I_${i} { // CW-T`, '  id: number;', '}', ''];
    case 'type': return [`type T_${i} = { a: number }; // CW-T`, ''];
    case 'enum': return [`enum E_${i} { A, B } // CW-T`, ''];
    case 'overloads': return [`function o_${i}(x: number): number; // CW-T`, `function o_${i}(x: string): string;`, `function o_${i}(x: any): any {`, '  return x;', '}', ''];
    case 'comment': return [`// CW-T comment ${i}`, ''];
    case 'statement': return [`console.log('CW-T ${i}');`, ''];
    default: return ['', ''];
  }
}

function csInner(t: Tpl, i: number): string[] {
  switch (t.kind) {
    case 'class': {
      const members: string[] = [];
      for (let m = 0; m < t.a; m++) members.push(...(m > 0 ? [''] : []), `    public int M${m}(int x)`, '    {', `        return x + ${m};`, '    }');
      return [`public class C${i} // CW-T`, '{', `    private int _f = ${t.b};`, '', `    public C${i}() { }`, '', '    public int P { get; set; }', '', ...members, '}', ''];
    }
    case 'struct': return [`public struct S${i} // CW-T`, '{', '    public int X;', '}', ''];
    case 'interface': return [`public interface I${i} // CW-T`, '{', '    int Get();', '}', ''];
    case 'enum': return [`public enum E${i} // CW-T`, '{', '    A,', '    B', '}', ''];
    case 'record': return [`public record R${i}(int A, string B); // CW-T`, ''];
    default: return [`// CW-T comment ${i}`, ''];
  }
}

const PY_KINDS = ['imports', 'function', 'decorated', 'class', 'const', 'comment', 'statement', 'blank'] as const;
const JS_KINDS = ['imports', 'function', 'generator', 'class', 'arrow', 'object', 'iife', 'comment', 'statement', 'blank'] as const;
const TS_KINDS = ['imports', 'function', 'class', 'arrow', 'interface', 'type', 'enum', 'overloads', 'comment', 'statement', 'blank'] as const;
const CS_INNER = ['class', 'struct', 'interface', 'enum', 'record', 'comment'] as const;

export function unitFileArb(lang: Lang): fc.Arbitrary<{ text: string; units: number }> {
  const finish = (lines: string[], units: number): { text: string; units: number } => ({ text: `${lines.join('\n')}\n`, units });
  if (lang === 'python' || lang === 'javascript' || lang === 'typescript') {
    const kinds = lang === 'python' ? PY_KINDS : lang === 'javascript' ? JS_KINDS : TS_KINDS;
    return fc.array(tplArb(kinds), { minLength: 1, maxLength: 10 }).map((ts) => {
      const lines: string[] = [];
      ts.forEach((t, i) => lines.push(...(lang === 'python' ? pyTemplate(t, i) : jsTemplate(t, i, lang === 'typescript'))));
      return finish(lines, ts.length);
    });
  }
  // C#: [blank runs] [usings] one namespace (block-scoped or file-scoped) holding 1–6 inner templates; each piece is a template.
  return fc.record({
    leadBlank: fc.integer({ min: 0, max: 1 }),
    usings: fc.boolean(),
    fileScoped: fc.boolean(),
    inner: fc.array(tplArb(CS_INNER), { minLength: 1, maxLength: 6 }),
  }).map(({ leadBlank, usings, fileScoped, inner }) => {
    const lines: string[] = [];
    let units = 0;
    for (let i = 0; i < leadBlank; i++, units++) lines.push('', '');
    if (usings) {
      lines.push('using System; // CW-T', 'using System.Collections.Generic;', '');
      units++;
    }
    units++;
    if (fileScoped) {
      lines.push('namespace N.Gen; // CW-T', '');
      inner.forEach((t, i) => lines.push(...csInner(t, i)));
    } else {
      lines.push('namespace N.Gen // CW-T', '{');
      inner.forEach((t, i) => lines.push(...csInner(t, i).map((l) => (l === '' ? '' : `    ${l}`))));
      while (lines[lines.length - 1] === '') lines.pop();
      lines.push('}', '');
    }
    return finish(lines, units + inner.length);
  });
}
