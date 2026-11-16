// The one tree-sitter row helper (04-regions §3.2 item 2; REG-01, INV-REG-COORD; lint L-OFFSETS). Tree-sitter positions are
// read here and nowhere else: a node becomes 1-based stored-form rows (rowsOf, endRow), a comment row test compares a
// node's columns with the whitespace around it on its own rows (ownsRows), and an incremental re-parse gets its edit
// (inputEdit). web-tree-sitter parses the decoded text, so its indices and columns are UTF-16 code units of that text
// (row 1 of a BOM file starts with U+FEFF, which counts as one unit); rows are split on 0x0A only, exactly like
// lineArray, so tree-sitter rows equal the 0x0A-split rows in every form. No value computed here leaves the worker
// except rows.
import { Edit } from 'web-tree-sitter';
import type { Range } from '../types.js';

/** A tree-sitter point: 0-based row and column (UTF-16 code units of the parsed text). */
export interface RowPoint { readonly row: number; readonly column: number; }
/** Anything with tree-sitter positions (a Node). */
export interface Positioned { readonly startPosition: RowPoint; readonly endPosition: RowPoint; }

/** 1-based end row: row + 1, minus one when column == 0 (endRow({row: 9, column: 0}) === 9, endRow({row: 9, column: 4}) === 10). */
export function endRow(pos: RowPoint): number {
  return pos.column === 0 ? pos.row : pos.row + 1;
}

/** 1-based stored-form rows of a node: [startPosition.row + 1, endRow(endPosition)]; a zero-width node at the start of a row
 *  (a MISSING node) is that one row, so the range is never inverted. */
export function rowsOf(node: Positioned): Range {
  const lo = node.startPosition.row + 1;
  return [lo, Math.max(lo, endRow(node.endPosition))];
}

/** Whitespace allowed before a node on its first row (row 1 may start with the BOM, U+FEFF). */
const LEADING = /^[ \t\f\v\u{feff}]*$/u;
/** Whitespace allowed after a node on its last row (a CRLF row keeps its CR). */
const TRAILING = /^[ \t\f\v\r]*$/u;

/**
 * True when nothing but whitespace shares the node's first row before it and its last row after it, so the node owns
 * its rows (a comment line of extent-convention/1 step 2). rowText(r) is the decoded 1-based row r without its 0x0A.
 */
export function ownsRows(node: Positioned, rowText: (row: number) => string): boolean {
  const s = node.startPosition;
  const e = node.endPosition;
  if (!LEADING.test(rowText(s.row + 1).slice(0, s.column))) return false;
  // A node that ends at column 0 ended with its last row's 0x0A: nothing follows it on that row.
  return e.column === 0 || TRAILING.test(rowText(e.row + 1).slice(e.column));
}

/** Read-only strict decode (04 §3.2 item 3), the BOM kept as U+FEFF exactly as ParserHost.parse decodes. */
const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function decode(b: Buffer): string | null {
  try {
    return DECODER.decode(b);
  } catch {
    return null;
  }
}

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/** The point of a UTF-16 index of text, counting rows from an already known point at index `from`. */
function pointAt(text: string, index: number, from: { index: number; point: RowPoint }): RowPoint {
  let row = from.point.row;
  let lineStart = from.index - from.point.column;
  for (let i = text.indexOf('\n', from.index); i >= 0 && i < index; i = text.indexOf('\n', i + 1)) {
    row++;
    lineStart = i + 1;
  }
  return { row, column: index - lineStart };
}

/**
 * The tree-sitter edit for an incremental re-parse from prevBytes to nextBytes (the ParserHost.parse old.edit value): the
 * common prefix and suffix of the two decoded texts, never splitting a surrogate pair; null when either side is not UTF-8
 * (no tree exists for it, the caller parses cold). Never leaves the worker.
 */
export function inputEdit(prevBytes: Buffer, nextBytes: Buffer): unknown {
  const a = decode(prevBytes);
  const b = decode(nextBytes);
  if (a === null || b === null) return null;
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  if (p > 0 && p < max && isHigh(a.charCodeAt(p - 1))) p--;
  let s = 0;
  while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  if (s > 0 && isLow(a.charCodeAt(a.length - s))) s--;
  const origin = { index: 0, point: { row: 0, column: 0 } };
  const startPosition = pointAt(a, p, origin);
  const start = { index: p, point: startPosition };
  return new Edit({
    startIndex: p,
    oldEndIndex: a.length - s,
    newEndIndex: b.length - s,
    startPosition,
    oldEndPosition: pointAt(a, a.length - s, start),
    newEndPosition: pointAt(b, b.length - s, start),
  });
}
