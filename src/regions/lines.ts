// Region line arrays and coordinates (04-regions §3.2, §3.4 step 3; REG-01, INV-REG-COORD; ruling R4-18): lines are split
// on byte 0x0A only (Plan 2's rows, re-exported, never copied), text is decoded read-only and never encoded (L-UTF8-WRITE),
// blank rows are a byte test, and line ranges are closed 1-based integer intervals. mapper.ts re-exports the two range helpers.
import type { Ranges } from './types.js';

/** Rows split on 0x0A only — Plan 2's rows() itself (one helper, never copied): BOM in row 1, CR kept in its row, a non-empty unterminated last row. */
export { rows as lineArray } from '../data/rows.js';

const LF = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
const TAB = 0x09;

/** 04 §3.2 item 3: fatal (a non-UTF-8 blob is reported, never repaired) and ignoreBOM (a leading U+FEFF stays in the text). */
const STRICT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** TextDecoder('utf-8', {fatal: true, ignoreBOM: true}); null = not UTF-8 (decodable: false). Read-only: nothing is ever encoded (L-UTF8-WRITE). */
export function decodeStrict(blob: Buffer): string | null {
  try {
    return STRICT.decode(blob);
  } catch {
    return null;
  }
}

/** R4-18: empty or only 0x20/0x09 after one trailing \r (and, on row 1, a BOM) is removed; a byte test.
 *  The row is a lineArray row: its one trailing LF is removed first, then one CR, then (rowNumber 1 only) a leading EF BB BF. */
export function isBlankRow(row: Buffer, rowNumber: number): boolean {
  let end = row.length;
  if (end > 0 && row[end - 1] === LF) end--;
  if (end > 0 && row[end - 1] === CR) end--;
  let start = 0;
  if (rowNumber === 1 && end >= 3 && row[0] === 0xef && row[1] === 0xbb && row[2] === 0xbf) start = 3;
  for (let i = start; i < end; i++) {
    const b = row[i];
    if (b !== SPACE && b !== TAB) return false;
  }
  return true;
}

/** 04 §3.4 step 3's normal form: sorted, merged (adjacent intervals merge), zero-length intervals dropped. In lines.ts (Task 3's first commit) because Task 4's residue
 *  units and TableCache.lastGood need it in parallel with the rest of Task 3; mapper.ts re-exports both. */
export function normalizeRanges(rs: readonly (readonly [number, number])[]): Ranges {
  const live = rs.filter(([lo, hi]) => lo <= hi).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: Array<[number, number]> = [];
  for (const [lo, hi] of live) {
    const last = out[out.length - 1];
    if (last !== undefined && lo <= last[1] + 1) {
      if (hi > last[1]) last[1] = hi;
    } else {
      out.push([lo, hi]);
    }
  }
  return out;
}

/** Closed intervals (04 §3.9 step 4): true when some row lies in both. Any order is accepted. */
export function rangesIntersect(a: Ranges, b: Ranges): boolean {
  for (const [alo, ahi] of a) {
    if (alo > ahi) continue;
    for (const [blo, bhi] of b) {
      if (blo <= bhi && alo <= bhi && blo <= ahi) return true;
    }
  }
  return false;
}
