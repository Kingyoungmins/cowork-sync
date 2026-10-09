// Algorithm D1 — canon(new, ref) (03-data §3.2, DAT-05, DAT-06; ruling R-07). Pure: stored-form bytes
// in, stored-form bytes out. Hashing the output (route (c), id only at a detection tick) is the caller's.
import { matchedRows } from './linediff.js';
import { BOM, form, hasBom, isBinaryBytes, rows, stripEnding } from './rows.js';

export type CanonResult = { ok: true; out: Buffer } | { ok: false; refuse: 'eol-bom' };

const LF = 0x0a;
const CR = 0x0d;

function refuse(): CanonResult {
  return { ok: false, refuse: 'eol-bom' };
}

/**
 * Pure, deterministic, idempotent. ref null (new path), skip (binary by EPOCH_BASE attributes, or filtered),
 * isBinaryBytes(ref) (DAT-04: the path is binary by its blob) or isBinaryBytes(next) (D1 step 1: `new`
 * binary) → next unchanged. Otherwise the BOM of ref's form (step 2),
 * then its endings (step 3: LF, CRLF, NONE = no change, MIXED = no change unless a matched row's ending
 * changed, which refuses), then the tripwire (step 4): the rows of the output, endings and BOM ignored,
 * must equal those of next, else REFUSE(eol-bom) — this also refuses input no stored form of ref can
 * hold without changing a row (a CR before a CRLF under an LF ref; a doubled BOM under a BOM-less ref).
 */
export function canon(next: Buffer, ref: Buffer | null, skip: boolean): CanonResult {
  if (ref === null || skip || isBinaryBytes(ref) || isBinaryBytes(next)) return { ok: true, out: next };
  const refForm = form(ref);
  let body = next;
  if (refForm.bom && !hasBom(next)) body = Buffer.concat([BOM, next]);
  else if (!refForm.bom && hasBom(next)) body = next.subarray(3);
  let out: Buffer;
  switch (refForm.eol) {
    case 'LF':
      out = toLf(body);
      break;
    case 'CRLF':
      out = toCrlf(body);
      break;
    case 'NONE':
      out = body;
      break;
    case 'MIXED':
      if (!matchedEndingsKept(ref, body)) return refuse();
      out = body;
      break;
  }
  if (!sameRowContents(next, out)) return refuse();
  return { ok: true, out };
}

/** Every CR LF becomes LF (one left-to-right pass). */
function toLf(x: Buffer): Buffer {
  let pairs = 0;
  for (let i = x.indexOf(LF); i >= 0; i = x.indexOf(LF, i + 1)) if (i > 0 && x[i - 1] === CR) pairs++;
  if (pairs === 0) return x;
  const out = Buffer.allocUnsafe(x.length - pairs);
  let o = 0;
  let start = 0;
  for (let i = x.indexOf(LF); i >= 0; i = x.indexOf(LF, i + 1)) {
    if (i > 0 && x[i - 1] === CR) {
      o += x.copy(out, o, start, i - 1);
      out[o++] = LF;
      start = i + 1;
    }
  }
  x.copy(out, o, start);
  return out;
}

/** Every LF without a CR before it becomes CR LF. */
function toCrlf(x: Buffer): Buffer {
  let bare = 0;
  for (let i = x.indexOf(LF); i >= 0; i = x.indexOf(LF, i + 1)) if (i === 0 || x[i - 1] !== CR) bare++;
  if (bare === 0) return x;
  const out = Buffer.allocUnsafe(x.length + bare);
  let o = 0;
  let start = 0;
  for (let i = x.indexOf(LF); i >= 0; i = x.indexOf(LF, i + 1)) {
    if (i === 0 || x[i - 1] !== CR) {
      o += x.copy(out, o, start, i);
      out[o++] = CR;
      out[o++] = LF;
      start = i + 1;
    }
  }
  x.copy(out, o, start);
  return out;
}

type Ending = 'CRLF' | 'LF' | '';

function endingOf(row: Buffer): Ending {
  const n = row.length;
  if (n === 0 || row[n - 1] !== LF) return '';
  return n >= 2 && row[n - 2] === CR ? 'CRLF' : 'LF';
}

/**
 * D1 step 3 MIXED: the rows of ref and body matched by a Myers diff with endings ignored keep their
 * endings. A row without a terminator can only be the last row of its blob, so "one side has no
 * terminator" is exactly the allowed presence-of-a-terminator difference on the last row.
 */
function matchedEndingsKept(ref: Buffer, body: Buffer): boolean {
  const ra = rows(ref);
  const rb = rows(body);
  for (const [i, j] of matchedRows(ra, rb)) {
    const ea = endingOf(ra[i] as Buffer);
    const eb = endingOf(rb[j] as Buffer);
    if (ea !== eb && ea !== '' && eb !== '') return false;
  }
  return true;
}

/** The tripwire comparison: the BOM is removed from each blob before its rows are taken, endings ignored. */
function sameRowContents(x: Buffer, y: Buffer): boolean {
  const rx = rows(hasBom(x) ? x.subarray(3) : x);
  const ry = rows(hasBom(y) ? y.subarray(3) : y);
  if (rx.length !== ry.length) return false;
  for (let i = 0; i < rx.length; i++) {
    if (!stripEnding(rx[i] as Buffer).equals(stripEnding(ry[i] as Buffer))) return false;
  }
  return true;
}
