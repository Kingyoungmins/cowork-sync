// FoldMapper/1 properties (04-regions §3.4; REG-01, REG-07, INV-REG-MAP; T-REG-03 mapper half, T-REG-21 pure half, TC-REG-04 unit,
// O-REG-MAP unit half): Myers is minimal against a test-side O(N·M) LCS reference, mapping is direct, never composed, the result is
// form-invariant over BOM, CRLF, LF and non-ASCII rows, and the S9 runs equal the oracle and re-anchor past D_REANCHOR within the 5,000 cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { lineArray } from '../../src/regions/lines.js';
import { D_CAP, D_REANCHOR, editDistance, hunks, imageOf, mapRangesLines, normalizeRanges } from '../../src/regions/mapper.js';
import type { Hunk, Ranges } from '../../src/regions/types.js';
import { formVariant, s9Generator } from '../helpers/regionFixtures.js';

const RUNS = 1_000;

/** Test-side step 1 key: one LF, then one CR removed, and (index 0 only) a leading EF BB BF. */
function key(row: Buffer, index: number): string {
  let end = row.length;
  if (end > 0 && row[end - 1] === 0x0a) end--;
  if (end > 0 && row[end - 1] === 0x0d) end--;
  const start = index === 0 && end >= 3 && row[0] === 0xef && row[1] === 0xbb && row[2] === 0xbf ? 3 : 0;
  return row.subarray(start, end).toString('latin1');
}

/** n + m − 2·LCS by the O(N·M) dynamic programme. */
function lcsDistance(a: readonly Buffer[], b: readonly Buffer[]): number {
  const ka = a.map(key);
  const kb = b.map(key);
  let prev = new Array<number>(kb.length + 1).fill(0);
  for (let i = 1; i <= ka.length; i++) {
    const cur = new Array<number>(kb.length + 1).fill(0);
    for (let j = 1; j <= kb.length; j++) {
      cur[j] = ka[i - 1] === kb[j - 1] ? (prev[j - 1] as number) + 1 : Math.max(prev[j] as number, cur[j - 1] as number);
    }
    prev = cur;
  }
  return ka.length + kb.length - 2 * (prev[kb.length] as number);
}

const changed = (hs: readonly Hunk[]): number => hs.reduce((n, h) => n + (h.aHi - h.aLo + 1) + (h.bHi - h.bLo + 1), 0);

/** Applies hunks to `from`: unchanged rows are taken from `from` (with their index there), hunk rows from `to`. */
function apply(from: readonly Buffer[], to: readonly Buffer[], hs: readonly Hunk[]): Array<{ row: Buffer; index: number }> {
  const out: Array<{ row: Buffer; index: number }> = [];
  let a = 1;
  for (const h of hs) {
    for (; a < h.aLo; a++) out.push({ row: from[a - 1] as Buffer, index: a - 1 });
    for (let b = h.bLo; b <= h.bHi; b++) out.push({ row: to[b - 1] as Buffer, index: b - 1 });
    a = h.aHi + 1;
  }
  for (; a <= from.length; a++) out.push({ row: from[a - 1] as Buffer, index: a - 1 });
  return out;
}

/** Rows over a 4-symbol alphabet with mixed endings: LF or CRLF, an unterminated last row, and sometimes a BOM on row 1. */
const mixedRows = (maxLength: number): fc.Arbitrary<Buffer[]> =>
  fc.tuple(
    fc.array(fc.tuple(fc.constantFrom('a', 'b', 'c', 'd'), fc.constantFrom('\n', '\r\n')), { maxLength }),
    fc.boolean(),
    fc.boolean(),
  ).map(([rs, bom, open]) =>
    rs.map(([s, eol], i) => {
      const end = open && i === rs.length - 1 ? '' : eol;
      const body = Buffer.from(`${s}${end}`, 'latin1');
      return bom && i === 0 ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
    }));

test('Myers is minimal, deterministic and reproduces the target', () => {
  fc.assert(
    fc.property(mixedRows(40), mixedRows(40), (from, to) => {
      const hs = hunks(from, to);
      const d = lcsDistance(from, to);
      assert.equal(changed(hs), d);
      assert.equal(editDistance(from, to, 10_000), d);
      assert.equal(editDistance(from, to, d), d);
      if (d > 0) assert.equal(editDistance(from, to, d - 1), null);
      // Well formed, sorted and maximal.
      for (const [i, h] of hs.entries()) {
        assert.ok(h.aLo >= 1 && h.bLo >= 1 && h.aHi >= h.aLo - 1 && h.bHi >= h.bLo - 1 && (h.aHi >= h.aLo || h.bHi >= h.bLo), JSON.stringify(h));
        const p = hs[i - 1];
        if (p !== undefined) assert.ok(h.aLo > p.aHi + 1 && h.bLo > p.bHi + 1, JSON.stringify(hs));
      }
      // Applying the hunks to from gives to, up to linesEqual.
      const got = apply(from, to, hs);
      assert.equal(got.length, to.length);
      got.forEach((g, r) => assert.equal(key(g.row, g.index), key(to[r] as Buffer, r)));
      assert.deepEqual(hunks(from, to), hs);
    }),
    { numRuns: RUNS, seed: 3_101 },
  );
});

/** A random row list of 30–80 rows over a small alphabet (many repeats, so diffs have choices). */
const rowList = (r: fc.Arbitrary<string>): fc.Arbitrary<Buffer[]> =>
  fc.array(r, { minLength: 30, maxLength: 80 }).map((xs) => xs.map((x) => Buffer.from(`${x}\n`, 'latin1')));

/** Random closed ranges inside 1..n, normalized. */
const rangesIn = (n: number): fc.Arbitrary<Ranges> =>
  fc.array(fc.tuple(fc.integer({ min: 1, max: n }), fc.integer({ min: 0, max: 8 })), { minLength: 1, maxLength: 3 })
    .map((xs) => normalizeRanges(xs.map(([lo, len]) => [lo, Math.min(n, lo + len)] as [number, number])));

/** A random splice of a row list: delete up to 6 rows at a point and insert up to 6 rows from the alphabet. */
const splice = (sym: fc.Arbitrary<string>) => fc.tuple(fc.nat(), fc.nat({ max: 6 }), fc.array(sym, { maxLength: 6 }));
const spliced = (xs: readonly Buffer[], [at, del, ins]: [number, number, string[]]): Buffer[] => {
  const out = [...xs];
  out.splice(at % (xs.length + 1), del, ...ins.map((x) => Buffer.from(`${x}\n`, 'latin1')));
  return out;
};

test('mapping is direct, never composed', () => {
  const sym = fc.constantFrom('p', 'q', 'r', 's', 't', 'u', '', 'v');
  const triple = rowList(sym).chain((X) =>
    fc.tuple(fc.constant(X), rangesIn(X.length), fc.array(splice(sym), { minLength: 1, maxLength: 4 }), fc.array(splice(sym), { minLength: 1, maxLength: 4 })));
  fc.assert(
    fc.property(triple, ([X, r, toY, toZ]) => {
      const Y = toY.reduce(spliced, X);   // X -> Y -> Z: the path the text took
      const Z = toZ.reduce(spliced, Y);
      const direct = mapRangesLines(X, Z, r, 'fold');
      assert.notEqual(direct, 'WHOLE_FILE');
      // One diff, X against Z; Y is never an input.
      assert.deepEqual(direct, imageOf(hunks(X, Z), r));
    }),
    { numRuns: RUNS, seed: 3_102 },
  );
  // The crafted triple: X = 10 rows with claim [[4, 6]], Y = X without rows 4–6, Z = X.
  const X = Array.from({ length: 10 }, (_, i) => Buffer.from(`row ${i + 1}\n`, 'latin1'));
  const Y = [...X.slice(0, 3), ...X.slice(6)];
  const Z = X.map((b) => Buffer.from(b));
  const claim: Ranges = [[4, 6]];
  assert.deepEqual(mapRangesLines(X, Z, claim, 'fold'), [[4, 6]]);
  // Composing X -> Y -> Z cannot reach it: the first step already tombstones the claim.
  assert.equal(mapRangesLines(X, Y, claim, 'fold'), 'TOMBSTONE');
});

const lf = (xs: readonly string[]): Buffer => Buffer.from(xs.map((x) => `${x}\n`).join(''), 'utf8');
const bomCrlf = (xs: readonly string[]): Buffer => formVariant(lf(xs), { bom: true, crlf: true });

test('mapping is form-invariant over BOM, CRLF, LF, Hangul, astral emoji, curly quotes and U+2028', () => {
  const tokens = fc.constantFrom('\u{D55C}\u{AE00}', '\u{1F600}', '\u{2018}x\u{2019}', '\u{201C}y\u{201D}', 'a\u{2028}b', 'z', ' ', '');
  const row = fc.array(tokens, { maxLength: 3 }).map((ts) => ts.join(''));
  const rowsArb = fc.array(row, { minLength: 1, maxLength: 30 });
  fc.assert(
    fc.property(rowsArb.chain((X) => fc.tuple(fc.constant(X), rangesIn(X.length))), rowsArb, ([X, r], Y) => {
      const lx = lineArray(lf(X));
      const ly = lineArray(lf(Y));
      const wx = lineArray(bomCrlf(X));
      const wy = lineArray(bomCrlf(Y));
      assert.equal(lx.length, X.length);
      assert.equal(wx.length, X.length);
      const base = hunks(lx, ly);
      assert.deepEqual(hunks(wx, wy), base);
      assert.deepEqual(hunks(lx, wy), base);
      assert.deepEqual(hunks(wx, ly), base);
      assert.deepEqual(hunks(lx, wx), []);
      const m = mapRangesLines(lx, ly, r, 'fold');
      assert.deepEqual(mapRangesLines(wx, wy, r, 'fold'), m);
      assert.deepEqual(mapRangesLines(lx, wy, r, 'fold'), m);
      assert.deepEqual(mapRangesLines(wx, lx, r, 'fold'), r);
    }),
    { numRuns: RUNS, seed: 3_103 },
  );
});

// T-REG-21 (pure half): s9Generator's churn inserts unique rows only (controller answer 2026-10-09), so every minimal diff matches
// both marker rows and the direct image of the claim is exactly the oracle at every step, in both working forms.
test('S9: mapped ranges equal the oracle at every step; re-anchoring past D_REANCHOR; never the 5,000 cap', () => {
  const STEPS = 400;
  for (const seed of ['s9-0', 's9-1', 's9-2']) {
    for (const form of ['LF', 'BOM+CRLF'] as const) {
      const shape = (b: Buffer): readonly Buffer[] => lineArray(form === 'LF' ? b : formVariant(b, { bom: true, crlf: true }));
      let anchor: readonly Buffer[] | null = null;
      let ranges: Ranges = [];
      let reanchors = 0;
      let maxD = 0;
      for (const s of s9Generator(seed)) {
        if (s.step >= STEPS) break;
        const peer = shape(s.peer);
        if (anchor === null) {
          anchor = shape(s.holder);
          ranges = s.oracle;
        }
        assert.deepEqual(mapRangesLines(anchor, peer, ranges, 'fold'), s.oracle, `${seed} ${form} step ${s.step}`);
        const d = editDistance(anchor, peer, D_CAP);
        assert.notEqual(d, null, `${seed} ${form} step ${s.step}: D within the 5,000 cap`);
        maxD = Math.max(maxD, d as number);
        if ((d as number) > D_REANCHOR) {
          anchor = peer;   // EMIT's case (b): re-anchor to the peer's blob with the oracle ranges
          ranges = s.oracle;
          reanchors++;
        }
      }
      assert.ok(reanchors >= 1, `${seed} ${form}: at least one re-anchor (max D ${maxD})`);
    }
  }
});
