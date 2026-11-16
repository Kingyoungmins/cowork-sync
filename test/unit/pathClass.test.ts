// Path classes (Plan 4 Task 4; 04 §3.3 "Path classes", REG-05, REG-06; R1-073, R1-003, R1-004, R1-015…R1-017, R4-16, R4-20,
// OQ-14; T-REG-13's path rows): first match wins, over LIVE paths only (the scope rows of T-REG-13 are the callers', REG-32).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PathAttrs } from '../../src/data/attrs.js';
import { GRAMMARLESS_WHOLE_FILE_MAX_LINES, pathClassOf, type PathFacts } from '../../src/regions/pathClass.js';
import { parseOid } from '../../src/git/oid.js';
import { labelKey, type Granularity, type Language, type PathClass } from '../../src/regions/types.js';
import type { JobCtx } from '../../src/regions/worker/jobs.js';
import { handle as handleTable } from '../../src/regions/worker/jobs/table.js';
import { fixture } from '../helpers/regionFixtures.js';

const NONE: PathAttrs = { filter: null, merge: null, text: null, binary: false, eol: null, generated: false, coworkOff: false, workingTreeEncoding: null };
const FILE: PathFacts = { mode: '100644', attrs: NONE };
const facts = (attrs: Partial<PathAttrs>, mode: PathFacts['mode'] = '100644'): PathFacts => ({ mode, attrs: { ...NONE, ...attrs } });
const ALL = (): boolean => true;
const u8 = (s: string): Buffer => Buffer.from(s, 'utf8');
const PY = u8('import os\n\n\ndef f(a):\n    return a\n');
const rowsOfText = (n: number): Buffer => u8('text line\n'.repeat(n));
const OID = parseOid('c'.repeat(40));
/** A block table (class 6) is built without a parser: any parser call fails the test. */
const NO_PARSER: JobCtx = {
  deadline: null,
  parser: {
    availability: () => new Map(),
    parse: () => assert.fail('a class-6 table never parses'),
    liveKeys: () => [],
    dispose: () => undefined,
  },
};

/** REG-06: the claim granularity of each path class (the test's own copy of 04 §3.3's table). */
const GRANULARITY: Readonly<Record<PathClass, Granularity>> = { 1: 'file', 2: 'file', 3: 'file', 4: 'symbol', 5: 'file', 6: 'block' };

/** The attributes special/attributes gives a path (its two lines: `secret.env filter=secret`, `utf16.txt working-tree-encoding=UTF-16LE`). */
function specialAttrs(path: string): PathAttrs {
  const out: PathAttrs = { ...NONE };
  for (const line of fixture('special/attributes').toString('utf8').split('\n')) {
    const [pattern, attr] = line.split(' ');
    if (pattern !== path || attr === undefined) continue;
    const [name, value] = attr.split('=');
    if (name === 'filter') out.filter = value ?? null;
    if (name === 'working-tree-encoding') out.workingTreeEncoding = value ?? null;
  }
  return out;
}

test('pathClassOf applies rows 1–6 in order', () => {
  assert.equal(GRAMMARLESS_WHOLE_FILE_MAX_LINES, 300);
  // 1: a conflict-marker row (the ENG-41 (e) detector), before everything else
  assert.deepEqual(pathClassOf('a.py', u8('def f():\n<<<<<<< ours\n    return 1\n'), FILE, ALL), { cls: 1, lang: null, decodable: true, blockReason: null });
  const markerBinary = Buffer.concat([u8('x\n>>>>>>> theirs\n'), Buffer.from([0, 1, 2, 0x0a])]);
  assert.equal(pathClassOf('a.bin', markerBinary, FILE, ALL).cls, 1, 'a conflict-marker binary blob is class 1');
  // 2: binary — a NUL in the first 8,000 bytes, or -text / binary
  const nulAt = (i: number): Buffer => {
    const b = Buffer.alloc(9_000, 0x61);
    for (let r = 79; r < b.length; r += 80) b[r] = 0x0a;
    b[i] = 0;
    return b;
  };
  assert.equal(pathClassOf('a.py', nulAt(10), FILE, ALL).cls, 2);
  assert.equal(pathClassOf('a.py', nulAt(7_999), FILE, ALL).cls, 2);
  const late = pathClassOf('a.py', nulAt(8_000), FILE, ALL);
  assert.deepEqual([late.cls, late.lang], [4, 'python'], 'a NUL at byte 8,000 (the 8,001st byte) is not binary');
  assert.equal(pathClassOf('a.py', PY, facts({ text: 'unset' }), ALL).cls, 2, '-text');
  assert.equal(pathClassOf('a.py', PY, facts({ binary: true }), ALL).cls, 2, 'the binary attribute alone (text unspecified)');
  assert.equal(pathClassOf('nb.ipynb', nulAt(10), FILE, ALL).cls, 2, 'a binary .ipynb is class 2');
  // 3: mode 120000 / 160000, .ipynb, any filter= (lfs included), any working-tree-encoding
  assert.equal(pathClassOf('a.py', PY, facts({}, '120000'), ALL).cls, 3);
  assert.equal(pathClassOf('a.py', PY, facts({}, '160000'), ALL).cls, 3);
  assert.deepEqual(pathClassOf('special/nb.ipynb', fixture('special/nb.ipynb'), FILE, ALL), { cls: 3, lang: null, decodable: true, blockReason: null });
  assert.equal(pathClassOf('a.py', PY, facts({ filter: 'secret' }), ALL).cls, 3);
  assert.equal(pathClassOf('a.py', PY, facts({ filter: 'lfs' }), ALL).cls, 3);
  assert.equal(pathClassOf('a.py', PY, facts({ workingTreeEncoding: 'UTF-16LE' }), ALL).cls, 3);
  // 4: a loaded grammar and decodable
  assert.deepEqual(pathClassOf('a.py', PY, FILE, ALL), { cls: 4, lang: 'python', decodable: true, blockReason: null });
  assert.deepEqual(pathClassOf('src/x.tsx', u8('const A = () => <a />;\n'), FILE, ALL), { cls: 4, lang: 'tsx', decodable: true, blockReason: null });
  // 5 / 6: grammarless, ≤ 300 rows → 5, more → 6
  assert.deepEqual(pathClassOf('a.md', rowsOfText(300), FILE, ALL), { cls: 5, lang: null, decodable: true, blockReason: 'no_grammar' });
  assert.deepEqual(pathClassOf('a.md', rowsOfText(301), FILE, ALL), { cls: 6, lang: null, decodable: true, blockReason: 'no_grammar' });
  // a grammar path that is not UTF-8: the raw 0x0A split
  const cp949 = fixture('special/legacy_cp949.cs');
  assert.deepEqual(pathClassOf('special/legacy_cp949.cs', cp949, FILE, ALL), { cls: 6, lang: null, decodable: false, blockReason: 'not_utf8' });
  const first120 = Buffer.concat(cp949.toString('latin1').split('\n').slice(0, 120).map((r) => Buffer.from(`${r}\n`, 'latin1')));
  assert.deepEqual(pathClassOf('special/legacy_cp949.cs', first120, FILE, ALL), { cls: 5, lang: null, decodable: false, blockReason: 'not_utf8' });
  // a grammar that did not load
  const noCs = (l: Language): boolean => l !== 'c_sharp';
  const cs = u8('class A\n{\n}\n');
  assert.deepEqual(pathClassOf('A.cs', cs, FILE, noCs), { cls: 5, lang: null, decodable: true, blockReason: 'grammar_unavailable' });
  assert.deepEqual(pathClassOf('A.cs', Buffer.concat([cs, u8('// x\n'.repeat(300))]), FILE, noCs), { cls: 6, lang: null, decodable: true, blockReason: 'grammar_unavailable' });
  assert.equal(pathClassOf('a.py', PY, FILE, noCs).cls, 4, 'only the unavailable language is grammarless');
  // R4-16: the byte-exact lowercase extension
  assert.deepEqual(pathClassOf('Foo.PY', PY, FILE, ALL), { cls: 5, lang: null, decodable: true, blockReason: 'no_grammar' });
  assert.equal(pathClassOf('.py', PY, FILE, ALL).blockReason, 'no_grammar', 'a dotfile has no extension');

  // T-REG-13's path rows: claim granularity by class
  const g = (path: string, blob: Buffer): Granularity => GRANULARITY[pathClassOf(path, blob, { mode: '100644', attrs: specialAttrs(path) }, ALL).cls];
  assert.equal(g('secret.env', u8('TOKEN=x\n')), 'file');
  assert.equal(g('utf16.txt', u8('hello\n')), 'file');
  assert.equal(g('special/nb.ipynb', fixture('special/nb.ipynb')), 'file');
  assert.equal(g('special/legacy_cp949.cs', cp949), 'block', 'the raw-split block table of a cp949 file over 300 rows');
  assert.equal(g('special/small.md', fixture('special/small.md')), 'file');
  assert.equal(g('special/big.md', fixture('special/big.md')), 'block');
});

/** The blank-line blocks of a blob, computed here from its 0x0A rows (R4-18: empty or only spaces/tabs after one CR; row 1's BOM ignored). */
function blankLineBlocks(blob: Buffer): Array<[number, number]> {
  const rows = blob.toString('latin1').split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  const out: Array<[number, number]> = [];
  rows.forEach((r, i) => {
    const text = i === 0 && r.startsWith('\u{ef}\u{bb}\u{bf}') ? r.slice(3) : r;
    if (/^[ \t]*\r?$/.test(text)) return;
    const last = out[out.length - 1];
    if (last !== undefined && last[1] === i) last[1] = i + 1;
    else out.push([i + 1, i + 1]);
  });
  return out;
}

test('Markdown follows rows 5/6', async () => {
  assert.deepEqual(pathClassOf('special/small.md', fixture('special/small.md'), FILE, ALL), { cls: 5, lang: null, decodable: true, blockReason: 'no_grammar' });
  const big = fixture('special/big.md');
  assert.deepEqual(pathClassOf('special/big.md', big, FILE, ALL), { cls: 6, lang: null, decodable: true, blockReason: 'no_grammar' });
  // class 6: a block table whose units are the blank-line blocks (the job needs no parser)
  const t = await handleTable({ kind: 'table', lang: null, cls: 6, ref: OID, bytes: big, regionSpec: 'spec', prevRef: null }, NO_PARSER);
  assert.ok(t !== 'deadline' && !('kind' in t));
  const blocks = blankLineBlocks(big);
  assert.ok(blocks.length > 10);
  assert.deepEqual(t.units.map((u) => u.ranges), blocks.map((b) => [b]));
  assert.ok(t.units.every((u) => u.granularity === 'block' && u.kind === 'block' && u.leaf && !u.residue && u.parentUnitId === null && u.sigSlice === null));
  assert.ok(t.units.every((u) => labelKey(u.label) === labelKey({ kind: 'block', qualname: '', simple: '', type: '', disc: '' })));
  assert.deepEqual([t.grammar, t.decodable, t.lineCount, t.imports, t.errorSpans, t.errorCount, t.labelCounts, t.regionSpec], [null, true, 900, null, [], 0, {}, 'spec']);
});
