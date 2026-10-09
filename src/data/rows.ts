// Stored-form rows and forms (03-data §2, DAT-02, DAT-03), the binary sniff (DAT-04) and the
// conflict-marker / restore-marker row detectors (ENG-41 (e), DAT-46). Bytes only: nothing here
// decodes text except latin1 keys, which map every byte to one code unit.

export type Eol = 'LF' | 'CRLF' | 'MIXED' | 'NONE';
export interface Form { bom: boolean; eol: Eol; }

/** The UTF-8 byte order mark EF BB BF; it belongs to row 1. */
export const BOM: Buffer = Buffer.from([0xef, 0xbb, 0xbf]);

const LF = 0x0a;
const CR = 0x0d;
/** Glossary §20 "Region numbers": binary = a NUL in the first 8,000 bytes (git's own rule). */
const BINARY_SNIFF_BYTES = 8_000;

/**
 * Row k is the byte run after the (k-1)-th LF up to and including the k-th LF; a final run without
 * LF is a row when non-empty. The BOM stays in row 1 and a CR stays in its row. Rows are views
 * into blob (no copy); concatenated they give blob back.
 */
export function rows(blob: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = 0;
  for (;;) {
    const nl = blob.indexOf(LF, start);
    if (nl < 0) break;
    out.push(blob.subarray(start, nl + 1));
    start = nl + 1;
  }
  if (start < blob.length) out.push(blob.subarray(start));
  return out;
}

/** Whether blob starts with the BOM. */
export function hasBom(blob: Buffer): boolean {
  return blob.length >= 3 && blob[0] === 0xef && blob[1] === 0xbb && blob[2] === 0xbf;
}

/** DAT-03: crlf = count of CR LF, lf = count of LF without a CR before it; lone CRs are ignored. */
export function form(blob: Buffer): Form {
  let crlf = 0;
  let lf = 0;
  for (let i = blob.indexOf(LF); i >= 0; i = blob.indexOf(LF, i + 1)) {
    if (i > 0 && blob[i - 1] === CR) crlf++;
    else lf++;
  }
  const eol: Eol = crlf === 0 && lf === 0 ? 'NONE' : crlf > 0 && lf > 0 ? 'MIXED' : crlf > 0 ? 'CRLF' : 'LF';
  return { bom: hasBom(blob), eol };
}

/** A NUL in the first 8,000 bytes. */
export function isBinaryBytes(blob: Buffer): boolean {
  return blob.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/** The row without one trailing CR LF or LF ("ignoring the ending"). */
export function stripEnding(row: Buffer): Buffer {
  const n = row.length;
  if (n > 0 && row[n - 1] === LF) return row.subarray(0, n >= 2 && row[n - 2] === CR ? n - 2 : n - 1);
  return row;
}

/** The row without its LF and then without one trailing CR (the ENG-41 (e) form), row 1's BOM removed. */
function markerForm(row: Buffer, first: boolean): string {
  let r = first && hasBom(row) ? row.subarray(3) : row;
  if (r.length > 0 && r[r.length - 1] === LF) r = r.subarray(0, r.length - 1);
  if (r.length > 0 && r[r.length - 1] === CR) r = r.subarray(0, r.length - 1);
  return r.toString('latin1');
}

const CONFLICT_MARKER = /^(?:<{7} |={7}$|>{7} |\|{7} )/;
const RESTORE_MARKER = /^(?:<{7}|\|{7}|>{7}) cowork:/;

/**
 * ENG-41 (e): the rows of blob matching ^(<{7} |={7}$|>{7} |\|{7} ) after the LF and one trailing CR
 * are removed, as latin1 keys of that stripped form (so the LF and CRLF spellings of one marker are
 * one key). Row 1's BOM is ignored for matching and in the key (a marker row of a BOM file is still found).
 */
export function conflictMarkerRows(blob: Buffer): Set<string> {
  const out = new Set<string>();
  let first = true;
  for (const row of rows(blob)) {
    const s = markerForm(row, first);
    first = false;
    if (CONFLICT_MARKER.test(s)) out.add(s);
  }
  return out;
}

/** DAT-46: a row starting '<<<<<<< cowork:', '||||||| cowork:' or '>>>>>>> cowork:' (row 1's BOM ignored). */
export function hasRestoreMarkerRow(blob: Buffer): boolean {
  let first = true;
  for (const row of rows(blob)) {
    const s = markerForm(row, first);
    first = false;
    if (RESTORE_MARKER.test(s)) return true;
  }
  return false;
}
