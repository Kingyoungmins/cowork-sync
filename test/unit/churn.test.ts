// The churn guard's pure parts (03-data §3.8, §3.10, DAT-39; glossary §20 data numbers; Plan 3 Task 7, D-20): the rewritten-rows
// ratio over Myers matched rows with endings ignored, and churnVerdict over the newest 3 observations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  CHURN_DIFF_MAX_BYTES, CHURN_DIFF_MAX_ROWS, CHURN_DIFF_MAX_WORK, CHURN_REWRITE_RATIO, CHURN_SNAPSHOTS, churnVerdict, rewrittenRatio,
  type ChurnObservation,
} from '../../src/data/churn.js';
import { commonRowEnds, matchedRows } from '../../src/data/linediff.js';
import { rows, stripEnding } from '../../src/data/rows.js';
import { seededRandom } from '../../src/ports/random.js';
import { generateBigBomCrlf } from '../sim/fixtures/bigBomCrlf.js';

const buf = (s: string): Buffer => Buffer.from(s, 'utf8');
/** n rows `row <i>` (1-based), `f` replacing the rows it names, each ended by `eol`. */
function text(n: number, eol: '\n' | '\r\n' = '\n', f: (i: number) => string | null = () => null): Buffer {
  return buf(Array.from({ length: n }, (_, k) => `${f(k + 1) ?? `row ${k + 1}`}${eol}`).join(''));
}
/** An unattributed text observation with ratio r; `attributed` / `binary` as given. */
const obs = (r: number, o: Partial<ChurnObservation> = {}): ChurnObservation => ({ attributed: false, rewrittenRatio: r, binary: false, ...o });

test('rewrittenRatio: identical rows give 0; a 10-row text with rows 3 and 7 replaced gives 0.2; every row replaced gives 1; the same rows with LF and with CRLF endings give 0', () => {
  const ten = text(10);
  assert.equal(rewrittenRatio(ten, text(10)), 0);
  assert.equal(rewrittenRatio(ten, text(10, '\n', (i) => (i === 3 || i === 7 ? `fresh ${i}` : null))), 0.2);
  assert.equal(rewrittenRatio(ten, text(10, '\n', (i) => `fresh ${i}`)), 1);
  assert.equal(rewrittenRatio(ten, text(10, '\r\n')), 0, 'LF → CRLF: endings are ignored');
  assert.equal(rewrittenRatio(text(10, '\r\n'), ten), 0, 'CRLF → LF: endings are ignored');
  // A final row without an ending matches the same row with one.
  assert.equal(rewrittenRatio(buf('a\nb\n'), buf('a\nb')), 0);
  // The share is of prev's rows: two rows appended to an unchanged text rewrite nothing.
  assert.equal(rewrittenRatio(ten, Buffer.concat([ten, buf('x\ny\n')])), 0);
});

test('rewrittenRatio of an empty prev is 1 when next has a row and 0 when both are empty', () => {
  assert.equal(rewrittenRatio(Buffer.alloc(0), buf('one row\n')), 1);
  assert.equal(rewrittenRatio(Buffer.alloc(0), buf('x')), 1, 'a final run without LF is a row');
  assert.equal(rewrittenRatio(Buffer.alloc(0), Buffer.alloc(0)), 0);
  assert.equal(rewrittenRatio(text(4), Buffer.alloc(0)), 1, 'every row of prev is gone');
});

test('churnVerdict needs the newest 3 observations all unattributed and each at least 20 %', () => {
  assert.equal(CHURN_SNAPSHOTS, 3);
  assert.equal(CHURN_REWRITE_RATIO, 0.2);
  assert.equal(churnVerdict([obs(0.2), obs(0.2), obs(0.2)]), 'generated?');
  assert.equal(churnVerdict([obs(0.19), obs(0.5), obs(0.5)]), 'none');
  assert.equal(churnVerdict([obs(0.5), obs(0.5)]), 'none', 'two observations are not three');
  assert.equal(churnVerdict([obs(0.5), obs(0.5, { attributed: true }), obs(0.5)]), 'none', 'a hook-attributed change breaks the chain');
  assert.equal(churnVerdict([obs(0.9, { attributed: true }), obs(0.3), obs(0.3), obs(0.3)]), 'generated?', 'only the newest 3 count');
  assert.equal(churnVerdict([obs(0.3), obs(0.3), obs(0.3), obs(0.1)]), 'none', 'the newest observation is below the ratio');
  assert.equal(churnVerdict([]), 'none');
});

/** n rows `<tag> <i> = <i * 7>;` (1-based), LF. */
const big = (n: number, tag: string): string[] => Array.from({ length: n }, (_, k) => `${tag} ${k + 1} = ${(k + 1) * 7};\n`);
const join = (r: readonly string[]): Buffer => buf(r.join(''));
/** Wall time of fn in ms (test-side timing; the engine has no clock here). */
function timed<T>(fn: () => T): { v: T; ms: number } {
  const t0 = performance.now();
  const v = fn();
  return { v, ms: performance.now() - t0 };
}
/**
 * The bound a churn observation must stay under: the unbounded Myers took 12.8 s for a 40k-row wholesale rewrite on this PC
 * (review finding 6); a 2.5 s loop period and a 3-period stall rule (Global Constraints "Time") leave room for many paths per tick.
 */
const OBSERVE_MS = 1_000;

test('rewrittenRatio of a 40,000-row wholesale rewrite and of a 40,000-row reversal finishes well under the loop period and qualifies', () => {
  const prev = big(40_000, 'const a');
  const whole = timed(() => rewrittenRatio(join(prev), join(big(40_000, 'const b'))));
  assert.equal(whole.v, 1, 'every row rewritten');
  assert.ok(whole.ms < OBSERVE_MS, `wholesale rewrite took ${whole.ms.toFixed(0)} ms`);
  // A reversal keeps every row (as a multiset) but matches one: the ambiguous, quadratic case for Myers.
  const reversed = timed(() => rewrittenRatio(join(prev), join([...prev].reverse())));
  assert.ok(reversed.v >= CHURN_REWRITE_RATIO, `reversal ratio ${reversed.v}`);
  assert.ok(reversed.ms < OBSERVE_MS, `reversal took ${reversed.ms.toFixed(0)} ms`);
});

test('rewrittenRatio of small edits in a large file stays exact or below the ratio, quickly', () => {
  const prev = big(40_000, 'const a');
  // The first and the last row edited: the common prefix/suffix cannot shrink the middle, the edit distance is 4.
  const ends = [...prev];
  ends[0] = 'edited first\n';
  ends[ends.length - 1] = 'edited last\n';
  const e = timed(() => rewrittenRatio(join(prev), join(ends)));
  assert.equal(e.v, 2 / 40_000);
  assert.ok(e.ms < OBSERVE_MS, `first+last edit took ${e.ms.toFixed(0)} ms`);
  // 300 rows pasted in three places (an insert-only change, every prev row kept): below the ratio.
  const pasted = [...prev.slice(0, 1_000), ...big(100, 'pasted x'), ...prev.slice(1_000, 20_000), ...big(100, 'pasted y'),
    ...prev.slice(20_000, 39_000), ...big(100, 'pasted z'), ...prev.slice(39_000)];
  const p = timed(() => rewrittenRatio(join(prev), join(pasted)));
  assert.ok(p.v < CHURN_REWRITE_RATIO, `insert-only ratio ${p.v}`);
  assert.ok(p.ms < OBSERVE_MS, `insert-only change took ${p.ms.toFixed(0)} ms`);
});

/** The exact share (the unbounded definition) with Plan 2's Myers matchedRows: the oracle of the bounded rewrittenRatio. */
function exactRatio(prev: Buffer, next: Buffer): number {
  const a = rows(prev).map(stripEnding);
  const b = rows(next).map(stripEnding);
  if (a.length === 0) return b.length === 0 ? 0 : 1;
  return (a.length - matchedRows(a, b).length) / a.length;
}

test('within the Myers work budget (every input of at most 80 rows is) rewrittenRatio is exact below CHURN_REWRITE_RATIO and between the ratio and the exact share at or above it (fast-check against matchedRows)', () => {
  // Two 80-row middles make n + m ≤ 160, so the work budget's distance cap is never below n + m: Myers always decides here.
  assert.ok(Math.floor(CHURN_DIFF_MAX_WORK / 160) >= 160);
  const rowOf = (k: number): string => (k % 7 === 0 ? `r${k}\r\n` : `r${k}\n`);
  const edit = fc.tuple(fc.integer({ min: 0, max: 2 }), fc.nat(), fc.integer({ min: 0, max: 40 }));
  fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 40 }), { maxLength: 80 }), fc.array(edit, { maxLength: 30 }), (prevIds, edits) => {
    const next = [...prevIds];
    for (const [op, at, id] of edits) {
      const i = next.length === 0 ? 0 : at % next.length;
      if (op === 0 && next.length > 0) next.splice(i, 1);
      else if (op === 1) next.splice(i, 0, id);
      else if (next.length > 0) next[i] = id;
    }
    const P = buf(prevIds.map(rowOf).join(''));
    const N = buf(next.map(rowOf).join(''));
    const r = rewrittenRatio(P, N);
    const x = exactRatio(P, N);
    if (x < CHURN_REWRITE_RATIO) assert.equal(r, x, 'exact below the ratio');
    else assert.ok(r >= CHURN_REWRITE_RATIO && r <= x, `${r} within [ratio, ${x}]`);
  }), { seed: 7, numRuns: 500 });
});

test('the caps bound the rows between the common leading and trailing rows: a middle beyond CHURN_DIFF_MAX_ROWS or CHURN_DIFF_MAX_BYTES counts as a whole rewrite without a diff; a middle at the caps is exact', () => {
  // The first and the last row edited: nothing is common at either end, so the middle is the whole text.
  const ends = (r: readonly string[], last = 'edited last\n'): Buffer => join(['edited first\n', ...r.slice(1, -1), last]);
  const atRows = big(CHURN_DIFF_MAX_ROWS, 'v');
  assert.equal(rewrittenRatio(join(atRows), ends(atRows)), 2 / CHURN_DIFF_MAX_ROWS, 'a middle at the row cap: exact');
  const overRows = [...atRows, 'one more\n'];
  assert.equal(rewrittenRatio(join(overRows), ends(overRows)), 1, 'a middle one row over the cap: a whole rewrite');
  const row = 'x'.repeat(1_023);
  const atBytes = Array.from({ length: CHURN_DIFF_MAX_BYTES / 1_024 }, () => `${row}\n`);
  assert.equal(join(atBytes).length, CHURN_DIFF_MAX_BYTES);
  assert.equal(rewrittenRatio(join(atBytes), ends(atBytes)), 2 / atBytes.length, 'a middle at the byte cap: exact');
  const overBytes = [...atBytes, 'y'];
  assert.equal(rewrittenRatio(join(overBytes), ends(overBytes, 'z')), 1, 'a middle one byte over the cap: a whole rewrite');
});

/** A 120,000-row CSV (about 9.8 MB): beyond both CHURN_DIFF_MAX_ROWS and CHURN_DIFF_MAX_BYTES as a whole. */
function csvRows(n: number): string[] {
  return Array.from({ length: n }, (_, k) => `${k},customer-${k},${k * 7},2026-10-09,region-${k % 17},status-ok,notes for row ${k}\n`);
}

test('the common leading and trailing rows are trimmed before the caps: a one-row autosave in a 120,000-row CSV scores its true share, and a LF to CRLF rewrite of it scores 0', () => {
  const csv = csvRows(120_000);
  const prev = join(csv);
  assert.ok(csv.length > CHURN_DIFF_MAX_ROWS && prev.length > CHURN_DIFF_MAX_BYTES, `the file is beyond both caps (${prev.length} bytes)`);
  const saved = [...csv];
  saved[60_000] = '60000,customer-60000,420000,2026-10-09,region-7,status-ok,notes for row 60000 (edited)\n';
  const one = timed(() => rewrittenRatio(prev, join(saved)));
  assert.equal(one.v, 1 / 120_000, 'one row of 120,000');
  assert.ok(one.ms < OBSERVE_MS, `one-row autosave took ${one.ms.toFixed(0)} ms`);
  const crlf = timed(() => rewrittenRatio(prev, buf(csv.map((r) => r.replace('\n', '\r\n')).join(''))));
  assert.equal(crlf.v, 0, 'endings are ignored, also by the trim');
  assert.ok(crlf.ms < OBSERVE_MS, `ending rewrite took ${crlf.ms.toFixed(0)} ms`);
});

test('beyond the Myers work budget a block move stays below the ratio and exact: rows 100-299 of the 26,436-row BOM+CRLF fixture moved to the end', () => {
  const fixture = generateBigBomCrlf(26_436, seededRandom('t7-churn-move'));
  const r = rows(fixture);
  const moved = [...r.slice(0, 100), ...r.slice(300), ...r.slice(100, 300)];
  const prev = fixture;
  const next = Buffer.concat(moved);
  const x = exactRatio(prev, next);
  assert.ok(x > 0 && x < CHURN_REWRITE_RATIO, `exact share ${x}`);
  // The edit distance over the middles exceeds the budget's distance cap: Myers cannot decide it within CHURN_DIFF_MAX_WORK.
  const e = commonRowEnds(prev, next);
  const n = rows(prev.subarray(e.aStart, e.aEnd)).length;
  const m = rows(next.subarray(e.bStart, e.bEnd)).length;
  const d = n + m - 2 * (n - Math.round(x * r.length));   // the middles' LCS is n minus prev's unmatched rows
  assert.ok(d > Math.floor(CHURN_DIFF_MAX_WORK / (n + m)), `edit distance ${d} within the budget ${Math.floor(CHURN_DIFF_MAX_WORK / (n + m))}`);
  const t = timed(() => rewrittenRatio(prev, next));
  assert.ok(t.v < CHURN_REWRITE_RATIO, `block move ratio ${t.v}`);
  assert.equal(t.v, x, 'the unique-row anchors keep the block move exact');
  assert.ok(t.ms < OBSERVE_MS, `block move took ${t.ms.toFixed(0)} ms`);
});

test('beyond the Myers work budget a change no bound decides counts below the ratio: 200 rows of a 30,000-row text whose every row occurs twice moved to the end', () => {
  // No row occurs once, so no row anchors the match; the edit distance (400) is beyond the budget's cap for 60,000 rows.
  const pairs = Array.from({ length: 15_000 }, (_, k) => `pair ${k}\npair ${k}\n`);
  const prev = buf(pairs.join(''));
  const next = buf([...pairs.slice(100), ...pairs.slice(0, 100)].join(''));
  const x = exactRatio(prev, next);
  assert.equal(x, 200 / 30_000);
  assert.ok(400 > Math.floor(CHURN_DIFF_MAX_WORK / 60_000));
  const t = timed(() => rewrittenRatio(prev, next));
  assert.ok(t.v < CHURN_REWRITE_RATIO, `undecided ratio ${t.v}: counted below the ratio`);
  assert.ok(t.v <= x, `${t.v} is a lower bound of the exact share ${x}`);
  assert.ok(t.ms < OBSERVE_MS, `undecided change took ${t.ms.toFixed(0)} ms`);
});

test('beyond the Myers work budget rewrittenRatio never reaches the ratio when the exact share is below it, and never exceeds the exact share at or above it (fast-check, 6,000-row texts with block moves)', () => {
  // 6,000 rows, one in five drawn from 40 repeated rows: the budget's distance cap (≈ 833) binds for a move of ≥ 417 rows.
  const base = Array.from({ length: 6_000 }, (_, k) => (k % 5 === 0 ? `dup ${k % 40}\n` : `row ${k}\n`));
  const op = fc.oneof(
    fc.tuple(fc.constant('move' as const), fc.nat(), fc.integer({ min: 1, max: 1_500 }), fc.nat()),
    fc.tuple(fc.constant('edit' as const), fc.nat(), fc.integer({ min: 1, max: 40 }), fc.nat()),
  );
  fc.assert(fc.property(fc.array(op, { minLength: 1, maxLength: 3 }), (ops) => {
    let next = [...base];
    for (const [kind, at, len, to] of ops) {
      const from = at % next.length;
      if (kind === 'move') {
        const block = next.splice(from, Math.min(len, next.length - from));
        next.splice(to % (next.length + 1), 0, ...block);
      } else {
        for (let k = from; k < Math.min(next.length, from + len); k++) next[k] = `edited ${k} ${to}\n`;
      }
    }
    const P = join(base);
    const N = join(next);
    const r = rewrittenRatio(P, N);
    const x = exactRatio(P, N);
    if (x < CHURN_REWRITE_RATIO) assert.ok(r < CHURN_REWRITE_RATIO, `${r} reached the ratio; exact ${x}`);
    if (r >= CHURN_REWRITE_RATIO) assert.ok(r <= x, `${r} above the exact share ${x}`);
  }), { seed: 9, numRuns: 25 });
});

test('churnVerdict counts a binary observation whatever its ratio', () => {
  const bin = obs(0, { binary: true });
  assert.equal(churnVerdict([bin, bin, bin]), 'generated?');
  assert.equal(churnVerdict([bin, obs(0.1), bin]), 'none', 'a small text change between binary ones breaks the chain');
  assert.equal(churnVerdict([bin, { ...bin, attributed: true }, bin]), 'none', 'a hook-attributed binary change breaks it too');
});
