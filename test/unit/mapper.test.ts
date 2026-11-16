// FoldMapper/1 (04-regions §3.4; REG-07, INV-REG-MAP, INV-CLOCK; rulings R4-17, R4-23; T-REG-03 mapper half, T-REG-15 mapper rows,
// TC-REG-04 unit): line equality, hunks, D, images, the D cap and the local-mode time cap, the frozen constants, the module's
// boundaries and the hunks/map job handlers. The fast-check properties are in mapper.prop.test.ts, the golden in mapper.golden.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUDGETS, clockBudgets, testBudgetInjector, type BudgetKind } from '../../src/regions/budgets.js';
import { lineArray } from '../../src/regions/lines.js';
import * as linesModule from '../../src/regions/lines.js';
import {
  D_CAP, D_REANCHOR, FOLD_MAPPER, LOCAL_MAP_CAP_MS, editDistance, hunks, imageOf, linesEqual, mapRangesLines, normalizeRanges, rangesIntersect,
} from '../../src/regions/mapper.js';
import { inlineWorkers } from '../../src/regions/worker/inline.js';
import { handle as mapHandle } from '../../src/regions/worker/jobs/map.js';
import type { ParserHost } from '../../src/regions/worker/parser.js';
import type { Hunk } from '../../src/regions/types.js';
import { lintSource } from '../../tools/lint/rules.js';
import { RC_TOUCH_R2, bigBomCrlf, bigLf, fixture } from '../helpers/regionFixtures.js';
import { testRegionRuntime } from '../helpers/regionRuntime.js';
import { VirtualClock } from '../sim/vclock.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const latin = (s: string): Buffer => Buffer.from(s, 'latin1');
const BOM = (s: string): Buffer => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), latin(s)]);
/** One LF row per symbol. */
const L = (...xs: string[]): Buffer[] => xs.map((x) => latin(`${x}\n`));
const h = (aLo: number, aHi: number, bLo: number, bHi: number): Hunk => ({ aLo, aHi, bLo, bHi });
const numbered = (prefix: string, n: number): Buffer[] => Array.from({ length: n }, (_, i) => latin(`${prefix}${i}\n`));
const ALL_KINDS: readonly BudgetKind[] = ['parse', 'map', 'predict_wait', 't0', 'edit_check', 'caller_grep', 'partial_grep', 'gate'];

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(REPO, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...srcFiles(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out.sort();
}
const source = (repoPath: string): string => readFileSync(join(REPO, ...repoPath.split('/')), 'utf8');

// ---- Equality and hunks (steps 1–2) ----

test('linesEqual removes one LF, then one CR, and a BOM only on line 1', () => {
  assert.equal(linesEqual(latin('a\r\n'), latin('a\n'), false), true);
  assert.equal(linesEqual(latin('a'), latin('a\n'), false), true);
  assert.equal(linesEqual(latin('a\r'), latin('a'), false), true);
  assert.equal(linesEqual(BOM('a\n'), latin('a\n'), true), true);
  assert.equal(linesEqual(BOM('a\r\n'), latin('a'), true), true);
  assert.equal(linesEqual(latin('a\r\r\n'), latin('a\n'), false), false);
  assert.equal(linesEqual(BOM('a\n'), latin('a\n'), false), false);
  assert.equal(linesEqual(latin('a \n'), latin('a\n'), false), false);
  assert.equal(linesEqual(latin('A\n'), latin('a\n'), false), false);
  assert.equal(linesEqual(latin('\n'), latin(''), false), true);
});

test('hunks has the 04 §3.1 shape', () => {
  assert.deepEqual(hunks(L('a', 'b', 'c'), L('a', 'x', 'c')), [h(2, 2, 2, 2)]);
  assert.deepEqual(hunks(L('a', 'b'), L('a', 'n', 'b')), [h(2, 1, 2, 2)]);   // an insertion after base line 1
  assert.deepEqual(hunks(L('a'), L('n', 'a')), [h(1, 0, 1, 1)]);
  assert.deepEqual(hunks(L('a'), L('a', 'n')), [h(2, 1, 2, 2)]);
  assert.deepEqual(hunks(L('a', 'b', 'c'), L('a', 'c')), [h(2, 2, 2, 1)]);   // a pure deletion: bHi = bLo − 1
  assert.deepEqual(hunks([], L('a', 'b', 'c')), [h(1, 0, 1, 3)]);
  assert.deepEqual(hunks(L('a', 'b', 'c'), []), [h(1, 3, 1, 0)]);
  assert.deepEqual(hunks(L('a', 'b', 'c'), L('a', 'b', 'c')), []);
  assert.deepEqual(hunks([], []), []);
  // Sorted and maximal: a replacement next to an insertion is one hunk; hunks are separated by at least one equal row on both sides.
  assert.deepEqual(hunks(L('a', 'b', 'c', 'd', 'e'), L('a', 'x', 'y', 'c', 'd', 'z')), [h(2, 2, 2, 3), h(5, 5, 6, 6)]);
  const many = hunks(L('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'), L('x', 'b', 'c', 'y', 'z', 'f', 'g'));
  for (let i = 1; i < many.length; i++) {
    const p = many[i - 1] as Hunk;
    const q = many[i] as Hunk;
    assert.ok(q.aLo > p.aHi + 1 && q.bLo > p.bHi + 1, `hunks ${i - 1} and ${i} are separated by an equal row: ${JSON.stringify(many)}`);
  }
});

test('BOM+CRLF and LF forms give zero hunks', () => {
  const wt = lineArray(bigBomCrlf(5_960));
  const lf = lineArray(bigLf(5_960));
  assert.equal(wt.length, 5_960);
  assert.deepEqual(hunks(wt, lf), []);
  assert.deepEqual(hunks(lf, wt), []);
  assert.equal(editDistance(wt, lf, 0), 0);
  // The BOM moved to row 2 is one changed row.
  const moved = [...lf];
  moved[1] = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), lf[1] as Buffer]);
  assert.deepEqual(hunks(wt, moved), [h(2, 2, 2, 2)]);
});

test('prefix and suffix trimming puts the same-tail insertion after line 5341', () => {
  const row = RC_TOUCH_R2.find((r) => r.name === 'py_same_tail_def_after');
  assert.ok(row !== undefined);
  const base = lineArray(fixture(row.base));
  const post = lineArray(fixture(row.post));
  assert.deepEqual(hunks(base, post), [h(5342, 5341, 5342, 5350)]);
  // The same pair in the BOM+CRLF working form of the base.
  assert.deepEqual(hunks(lineArray(bigBomCrlf(5_960)), post), [h(5342, 5341, 5342, 5350)]);
});

test('editDistance returns null once past its cap', () => {
  const a = numbered('a', 3_000);
  const b = numbered('b', 3_000);
  assert.equal(editDistance(a, b, 5_000), null);
  assert.equal(editDistance(a, b, 7_000), 6_000);
  assert.equal(editDistance(a, b, 6_000), 6_000);
  assert.equal(editDistance(a, a, 0), 0);
  assert.equal(editDistance([], [], 0), 0);
  // The same cap on a pair that shares rows (the Myers rounds, not the disjoint shortcut): every third row changed.
  const c = numbered('c', 300);
  const d = c.map((r, i) => (i % 3 === 1 ? latin(`d${i}\n`) : r));
  assert.equal(editDistance(c, d, 1_000), 200);
  assert.equal(editDistance(c, d, 199), null);
  assert.equal(editDistance(c, d, 200), 200);
});

// ---- Images (step 3) ----

test('imageOf implements step 3 (a), (b) and (c)', () => {
  const claim = [[4, 6]] as const;
  assert.deepEqual(imageOf([h(2, 1, 2, 3)], claim), [[6, 8]]);   // (a): 2 rows inserted after base 1
  assert.deepEqual(imageOf([h(5, 5, 5, 7)], claim), [[4, 8]]);   // (b): row 5 replaced by 3 rows
  assert.deepEqual(imageOf([h(5, 4, 5, 6)], claim), [[4, 8]]);   // (c): 2 rows inserted after base 4, lo ≤ k < hi
  assert.deepEqual(imageOf([h(5, 5, 5, 4)], claim), [[4, 5]]);   // row 5 deleted
  assert.deepEqual(imageOf([h(4, 6, 4, 4)], claim), [[4, 4]]);   // rows 4–6 replaced by one row
  assert.deepEqual(imageOf([h(1, 1, 1, 0)], [[2, 3], [8, 9]]), [[1, 2], [7, 8]]);
  // The same cases through hunks() on a real 10-row base.
  const base = numbered('r', 10);
  const rows1 = (n: number): Buffer => base[n - 1] as Buffer;
  const post = [rows1(1), latin('n1\n'), latin('n2\n'), ...base.slice(1)];
  assert.deepEqual(hunks(base, post), [h(2, 1, 2, 3)]);
  assert.deepEqual(mapRangesLines(base, post, claim, 'fold'), [[6, 8]]);
  const replaced = [...base.slice(0, 4), latin('x\n'), latin('y\n'), latin('z\n'), ...base.slice(5)];
  assert.deepEqual(mapRangesLines(base, replaced, claim, 'fold'), [[4, 8]]);
  assert.deepEqual(imageOf([], claim), [[4, 6]]);
  assert.deepEqual(imageOf([h(2, 1, 2, 3)], []), []);
});

test('boundary insertions are never in an image', () => {
  const claim = [[4, 6]] as const;
  assert.deepEqual(imageOf([h(7, 6, 7, 8)], claim), [[4, 6]]);   // k == hi
  assert.deepEqual(imageOf([h(4, 3, 4, 5)], claim), [[6, 8]]);   // k == lo − 1
  // Through hunks() (touch step 4 decides these, R4-23).
  const base = numbered('r', 10);
  const afterHi = [...base.slice(0, 6), latin('n1\n'), latin('n2\n'), ...base.slice(6)];
  assert.deepEqual(mapRangesLines(base, afterHi, claim, 'fold'), [[4, 6]]);
  const afterLoMinus1 = [...base.slice(0, 3), latin('n1\n'), latin('n2\n'), ...base.slice(3)];
  assert.deepEqual(mapRangesLines(base, afterLoMinus1, claim, 'fold'), [[6, 8]]);
});

test('TOMBSTONE when every claimed line is deleted and nothing replaces it', () => {
  const claim = [[4, 6]] as const;
  assert.equal(imageOf([h(4, 6, 4, 3)], claim), 'TOMBSTONE');
  assert.equal(imageOf([h(3, 7, 3, 2)], claim), 'TOMBSTONE');
  assert.equal(imageOf([h(4, 6, 4, 3), h(8, 7, 5, 6)], claim), 'TOMBSTONE');
  assert.deepEqual(imageOf([h(4, 6, 4, 5)], claim), [[4, 5]]);
  const base = numbered('r', 10);
  assert.equal(mapRangesLines(base, [...base.slice(0, 3), ...base.slice(6)], claim, 'fold'), 'TOMBSTONE');
  assert.equal(mapRangesLines(base, [...base.slice(0, 2), ...base.slice(7)], claim, 'fold'), 'TOMBSTONE');
  assert.equal(mapRangesLines(base, [...base.slice(0, 3), base[6] as Buffer, latin('n1\n'), latin('n2\n'), ...base.slice(7)], claim, 'fold'), 'TOMBSTONE');
  assert.deepEqual(mapRangesLines(base, [...base.slice(0, 3), latin('x\n'), latin('y\n'), ...base.slice(6)], claim, 'fold'), [[4, 5]]);
});

test('normalizeRanges and rangesIntersect are the lines.ts helpers, re-exported', () => {
  assert.equal(normalizeRanges, linesModule.normalizeRanges);
  assert.equal(rangesIntersect, linesModule.rangesIntersect);
});

// ---- Direct mapping, caps and modes (steps 4–5) ----

test('D > 5,000 is WHOLE_FILE in both modes and D = 5,000 is not', () => {
  const claim = [[10, 20]] as const;
  // No injector: under a VirtualClock the 200 ms cap never expires, so only the D cap is under test.
  const budgets = clockBudgets(new VirtualClock());
  const a6 = numbered('a', 3_000);
  const b6 = numbered('b', 3_000);
  assert.equal(mapRangesLines(a6, b6, claim, 'fold'), 'WHOLE_FILE');
  assert.equal(mapRangesLines(a6, b6, claim, 'local', budgets.deadline('map')), 'WHOLE_FILE');
  const a5 = numbered('a', 2_500);
  const b5 = numbered('b', 2_500);
  assert.equal(editDistance(a5, b5, D_CAP), 5_000);
  assert.deepEqual(mapRangesLines(a5, b5, claim, 'fold'), [[1, 2_500]]);
  assert.deepEqual(mapRangesLines(a5, b5, claim, 'local', budgets.deadline('map')), [[1, 2_500]]);
  // The cap also holds on the Myers rounds: 2,501 changed rows of 7,503 sharing rows (D = 5,002) against 2,500 (D = 5,000).
  const c = numbered('c', 7_503);
  const over = c.map((r, i) => (i % 3 === 1 ? latin(`d${i}\n`) : r));
  assert.equal(editDistance(c, over, D_CAP), null);
  assert.equal(mapRangesLines(c, over, claim, 'fold'), 'WHOLE_FILE');
  const at = c.slice(0, 7_500);
  const atPost = at.map((r, i) => (i % 3 === 1 ? latin(`d${i}\n`) : r));
  assert.equal(editDistance(at, atPost, D_CAP), 5_000);
  assert.notEqual(mapRangesLines(at, atPost, claim, 'local', budgets.deadline('map')), 'WHOLE_FILE');
});

test('the 200 ms cap applies only in local mode', () => {
  const base = numbered('r', 400);
  const post = base.map((r, i) => (i % 13 === 0 && i < 390 ? latin(`x${i}\n`) : r));
  assert.equal(editDistance(base, post, D_CAP), 60);
  const claim = [[100, 120]] as const;
  const expected = mapRangesLines(base, post, claim, 'fold');
  assert.notEqual(expected, 'WHOLE_FILE');
  assert.notEqual(expected, 'TOMBSTONE');

  const inject = testBudgetInjector();
  const budgets = clockBudgets(new VirtualClock(), inject);
  inject.stallMs('map', 201);
  assert.equal(mapRangesLines(base, post, claim, 'local', budgets.deadline('map')), 'WHOLE_FILE');
  inject.stallMs('map', 199);
  assert.deepEqual(mapRangesLines(base, post, claim, 'local', budgets.deadline('map')), expected);
  inject.expire('map', 1);
  assert.equal(mapRangesLines(base, post, claim, 'local', budgets.deadline('map')), 'WHOLE_FILE');

  // The fold overload takes no deadline and returns the range result whatever the injector holds.
  inject.expire('map', 5);
  const expiredMap = budgets.deadline('map');
  assert.equal(expiredMap.expired(), true);
  // @ts-expect-error fold mode has no time cap: no deadline parameter
  mapRangesLines(base, post, claim, 'fold', expiredMap);
  assert.deepEqual(mapRangesLines(base, post, claim, 'fold'), expected);
  // A local call without a deadline is refused at runtime too.
  // @ts-expect-error local mode needs its deadline
  assert.throws(() => mapRangesLines(base, post, claim, 'local'), TypeError);
});

test('fold mapping reads no clock', () => {
  const text = source('src/regions/mapper.ts');
  assert.doesNotMatch(text, /from '\.\.\/ports\/clock(\.js)?'/);
  assert.doesNotMatch(text, /\bDate\b|performance|hrtime|monoMs|wallMs/);
  // The only time it reads is a passed Deadline's expired(): fold mode is the same at mono 0, after 10^9 ms and with every budget kind expired.
  const base = numbered('r', 200);
  const post = base.map((r, i) => (i % 17 === 0 ? latin(`x${i}\n`) : r));
  const claim = [[40, 80]] as const;
  const first = mapRangesLines(base, post, claim, 'fold');
  const clock = new VirtualClock();
  const inject = testBudgetInjector();
  const budgets = clockBudgets(clock, inject);
  clock.advance(10 ** 9);
  assert.deepEqual(mapRangesLines(base, post, claim, 'fold'), first);
  for (const kind of ALL_KINDS) {
    inject.expire(kind, 10);
    assert.equal(budgets.deadline(kind).expired(), true);
  }
  assert.deepEqual(mapRangesLines(base, post, claim, 'fold'), first);
  assert.deepEqual(hunks(base, post), hunks(base, post));
});

test('the constants are the frozen ones', () => {
  assert.equal(FOLD_MAPPER, 'FoldMapper/1');
  assert.equal(D_CAP, 5_000);
  assert.equal(LOCAL_MAP_CAP_MS, 200);
  assert.equal(LOCAL_MAP_CAP_MS, BUDGETS.mapLocalMs);
  assert.equal(D_REANCHOR, 1_000);
});

// ---- Boundaries ----

test('the region module never decides disk equality', () => {
  const files = srcFiles('src/regions');
  assert.ok(files.includes('src/regions/mapper.ts') && files.includes('src/regions/lines.ts'));
  for (const f of files) {
    const text = source(f);
    assert.doesNotMatch(text, /engine\/diskEq/, `${f} imports src/engine/diskEq.ts`);
    assert.doesNotMatch(text, /\bDiskEq\b|\bDISK_EQ\b/, `${f} names DiskEq`);
    assert.doesNotMatch(text, /['"]hash-object['"]/, `${f} carries a hash-object argv`);
  }
  // Zero hunks are never compared with a blob id: the mapper has no oid in its vocabulary.
  assert.doesNotMatch(source('src/regions/mapper.ts'), /\bOid\b|\boid\b|blobOid|BlobRef/);
});

test('FoldMapper/1 is the only line mapper here', () => {
  const file = 'src/regions/mapper.ts';
  const text = source(file);
  assert.doesNotMatch(text, /data\/linediff/);
  assert.doesNotMatch(text, /\bmatchedRows\b/);
  assert.deepEqual(lintSource(file, text), [], 'mapper.ts passes every lint rule (no diff/diff-tree/log -p argv)');
  assert.deepEqual(lintSource('src/regions/lines.ts', source('src/regions/lines.ts')), []);
  const planted = `import { matchedRows } from '../data/linediff.js';\n${text}`;
  assert.deepEqual(lintSource(file, planted).map((f) => f.rule), ['L-ONE-MAPPER']);
  const argv = `${text}\nexport const probe = ['diff', '--no-index', 'a', 'b'];\n`;
  assert.deepEqual(lintSource(file, argv).map((f) => f.rule), ['L-ONE-MAPPER']);
  // matchedRows stays 03-data's canon helper.
  assert.match(source('src/data/linediff.ts'), /export function matchedRows\(/);
});

// ---- The job handlers ----

test('the hunks and map job handlers equal the direct functions', async () => {
  const runtime = await testRegionRuntime();
  const pool = await inlineWorkers(runtime);
  try {
    for (const r of RC_TOUCH_R2) {
      const from = lineArray(fixture(r.base));
      const to = lineArray(fixture(r.post));
      assert.deepEqual(await pool.run({ kind: 'hunks', from, to }, 'fg', null), { kind: 'ok', value: hunks(from, to) }, r.name);
    }
    const from = lineArray(bigLf(5_960));
    const to = lineArray(fixture('rc_touch/py_body_edit.post.py'));
    const ranges = [[5331, 5339]] as const;
    assert.deepEqual(await pool.run({ kind: 'map', from, to, ranges, mode: 'fold' }, 'fg', null), { kind: 'ok', value: mapRangesLines(from, to, ranges, 'fold') });
    const inject = testBudgetInjector();
    const budgets = clockBudgets(new VirtualClock(), inject);
    assert.deepEqual(await pool.run({ kind: 'map', from, to, ranges, mode: 'local' }, 'fg', budgets.deadline('map')), { kind: 'ok', value: [[5331, 5339]] });
    inject.expire('map', 1);
    assert.deepEqual(await pool.run({ kind: 'map', from, to, ranges, mode: 'local' }, 'fg', budgets.deadline('map')), { kind: 'deadline' });
  } finally {
    await pool.close();
  }
  // The handler's own local-mode rule (PF-11): ctx.deadline adapted to a 'map' Deadline; null never expires.
  const parser = {} as ParserHost;
  const from = numbered('r', 10);
  const to = [...from.slice(0, 4), latin('x\n'), ...from.slice(5)];
  const job = { kind: 'map', from, to, ranges: [[4, 6]], mode: 'local' } as const;
  assert.equal(await mapHandle(job, { parser, deadline: { expired: () => true } }), 'WHOLE_FILE');
  assert.deepEqual(await mapHandle(job, { parser, deadline: { expired: () => false } }), [[4, 6]]);
  assert.deepEqual(await mapHandle(job, { parser, deadline: null }), [[4, 6]]);
  assert.deepEqual(await mapHandle({ ...job, mode: 'fold' }, { parser, deadline: { expired: () => true } }), [[4, 6]]);
});
