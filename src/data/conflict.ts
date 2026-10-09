// The one conflict function: Algorithm D8 steps 0, 0a, 1–3 and 5 with D9 insertion-concat (03-data §3.9;
// DAT-40…DAT-43; glossary §24 defaults 1 (as widened by §25.2 item 8), 2 and 3; ruling R-39). The caller
// (apply or publish) records TAKE_TIP's stages in a K4 PATCH record before any disk write; a CONCAT or a
// DEFER carries no record. Plan 2 has no grammars (Plan 4), so D9 qualifies through merge.insertionMerge
// globs only, its separator needs no blank row and tripwire leg (ii) does not run.
import { mergeFile } from '../git/merge.js';
import { ABSENT, type Oid, type OidOrAbsent } from '../git/oid.js';
import type { GitRepo } from '../git/repo.js';
import { hashRouteC } from './blobRoutes.js';
import { canon } from './canon.js';
import { conflictMarkerRows, form, hasBom, isBinaryBytes, rows, stripEnding } from './rows.js';

export type Stage = OidOrAbsent;
/** 'other' = binary, filtered, mode, add/add, modify/delete, rename, directory/file. */
export type UnitKind = 'content' | 'other';

export interface ConflictCtx {
  repo: GitRepo;
  /** Not binary (content or EPOCH_BASE `binary`/`merge=binary`, D9 (a)) and not filtered at EPOCH_BASE (DAT-04). */
  isText(path: string): boolean;
  /** Matches merge.insertionMerge. */
  insertionMerge(path: string): boolean;
  /** D9 (c): no peer of the folded live set announced a regionSpec other than this peer's. */
  concatAllowed: boolean;
  /** Covered by a non-terminal local_only record (always false in Plan 2). */
  localOnly(path: string): boolean;
  /** ref(p) bytes for canon of a concat output. */
  ref(path: string): Promise<Buffer | null>;
  /** Objects may be written (apply/publish). */
  write: boolean;
}

export type ConflictVerdict =
  | { kind: 'CONCAT'; blob: Oid }
  | { kind: 'TAKE_TIP'; entry: Stage; stages: { s1: Stage; s2: Stage; s3: Stage } }
  | { kind: 'DEFER'; reason: 'local_only_conflict' };

const LF = 0x0a;
const CR = 0x0d;
/** Glossary §20 "Data numbers": concat marker size max(32, longest run + 1). */
const MIN_MARKER_SIZE = 32;
const MARKER_CHARS: ReadonlySet<number> = new Set([0x3c, 0x7c, 0x3d, 0x3e]); // < | = >
/** Plan 2 has no grammar, so no L block starts a definition unit (D9 step 3 `need`). */
const SEPARATOR_NEED = 0;

/**
 * max(32, 1 + the longest run of one repeated marker character (<, |, =, >) at a row start in any stage).
 * Row 1's BOM is skipped, so a run right after it also counts (a larger size is always safe).
 */
export function concatMarkerSize(stages: readonly Buffer[]): number {
  let longest = 0;
  for (const s of stages) {
    let first = true;
    for (const row of rows(s)) {
      const r = first && hasBom(row) ? row.subarray(3) : row;
      first = false;
      const c = r[0];
      if (c === undefined || !MARKER_CHARS.has(c)) continue;
      let n = 1;
      while (n < r.length && r[n] === c) n++;
      if (n > longest) longest = n;
    }
  }
  return Math.max(MIN_MARKER_SIZE, longest + 1);
}

/** One conflict unit: s1 = A[p], s2 = LOCAL, s3 = TIP[p]. Never returns a marker-bearing blob. */
export async function conflict(ctx: ConflictCtx, path: string, s1: Stage, s2: Stage, s3: Stage, unit: UnitKind): Promise<ConflictVerdict> {
  // Step 0: a local_only record is never displaced; nothing else runs.
  if (ctx.localOnly(path)) return { kind: 'DEFER', reason: 'local_only_conflict' };
  const takeTip = (): ConflictVerdict => ({ kind: 'TAKE_TIP', entry: s3, stages: { s1, s2, s3 } });
  // Step 5: binary, filtered, mode, add/add, modify/delete, rename and directory/file units are whole-file.
  if (unit !== 'content' || s1 === ABSENT || s2 === ABSENT || s3 === ABSENT || !ctx.isText(path)) return takeTip();
  const [base, local, tip] = (await ctx.repo.readBlobs([s1, s2, s3])) as [Buffer, Buffer, Buffer];
  // A NUL in the first 8,000 bytes of a stage makes the path binary (DAT-04); merge-file would refuse it anyway.
  if (isBinaryBytes(base) || isBinaryBytes(local) || isBinaryBytes(tip)) return takeTip();

  // D9 construction step 1, shared by step 0a: current = TIP, base, other = LOCAL, marker size M.
  const m = concatMarkerSize([base, local, tip]);
  const merged = await mergeFile(ctx.repo, s3, s1, s2, { diff3: true, markerSize: m });
  if (merged.rc <= 0) return takeTip();
  const parsed = parseMerge(merged.out, m, local, tip);
  if (parsed === null || parsed.regions.length === 0) return takeTip();
  const stages = [base, local, tip];

  // Step 0a: already concatenated — every region inserts at one base position and LOCAL's block is a
  // contiguous run inside TIP's block. TIP's entry, plus LOCAL's cleanly merged rows outside the regions.
  if (parsed.regions.every((r) => r.b.length === 0 && containsRun(keys(r.t, r.atStart), keys(r.l, r.atStart)))) {
    const out = assemble(parsed, (r) => Buffer.concat(r.t));
    if (out.equals(tip)) return { kind: 'CONCAT', blob: s3 };
    return (await finish(ctx, path, out, stages)) ?? takeTip();
  }

  // Step 1: D9 insertion-concat, T + sep + L per region, TIP's block first.
  if (ctx.insertionMerge(path) && ctx.concatAllowed && parsed.regions.every(concatQualifies)) {
    const out = assemble(parsed, (r) => concatBlock(r, base));
    const done = await finish(ctx, path, out, stages);
    if (done !== null) return done;
  }
  // Steps 2–3: TIP's entry; the caller keeps LOCAL whole in a record.
  return takeTip();
}

interface Region {
  t: Buffer[];
  b: Buffer[];
  l: Buffer[];
  /** The region starts the output, so its first rows are the stages' row 1 (which may carry the BOM). */
  atStart: boolean;
  /** The output row before the region (its ending is "the base's line ending"), null at the start. */
  before: Buffer | null;
}
interface Parsed { pieces: Array<Buffer | Region>; regions: Region[]; }

type MarkerKind = 'open' | 'base' | 'sep' | 'close';

/** The row without its LF and one trailing CR (git writes CRLF markers into CRLF files). */
function bare(row: Buffer): string {
  let r = row;
  if (r.length > 0 && r[r.length - 1] === LF) r = r.subarray(0, r.length - 1);
  if (r.length > 0 && r[r.length - 1] === CR) r = r.subarray(0, r.length - 1);
  return r.toString('latin1');
}

function markerKind(row: Buffer, m: number): MarkerKind | null {
  const c = row[0];
  if (c === undefined || !MARKER_CHARS.has(c)) return null;
  const s = bare(row);
  const labelled = (ch: string): boolean => {
    const run = ch.repeat(m);
    return s === run || s.startsWith(`${run} `);
  };
  if (labelled('<')) return 'open';
  if (labelled('|')) return 'base';
  if (s === '='.repeat(m)) return 'sep';
  if (labelled('>')) return 'close';
  return null;
}

/**
 * Parses merge-file --diff3 output written with marker size m (no stage row can start with m marker
 * characters, so every marker row is git's). A side whose last row had no terminator gets one from git
 * when its block ends the file; that terminator is removed again so each block is the side's own bytes.
 * Malformed output → null.
 */
function parseMerge(out: Buffer, m: number, local: Buffer, tip: Buffer): Parsed | null {
  const pieces: Array<Buffer | Region> = [];
  const regions: Region[] = [];
  let state: 'out' | 't' | 'b' | 'l' = 'out';
  let cur: Region | null = null;
  let before: Buffer | null = null;
  for (const row of rows(out)) {
    const kind = markerKind(row, m);
    if (state === 'out') {
      if (kind === 'open') {
        cur = { t: [], b: [], l: [], atStart: pieces.length === 0, before };
        state = 't';
      } else if (kind !== null) {
        return null;
      } else {
        pieces.push(row);
        before = row;
      }
    } else if (state === 't') {
      if (kind === 'base') state = 'b';
      else if (kind === null) cur!.t.push(row);
      else return null;
    } else if (state === 'b') {
      if (kind === 'sep') state = 'l';
      else if (kind === null) cur!.b.push(row);
      else return null;
    } else {
      if (kind === 'close') {
        pieces.push(cur!);
        regions.push(cur!);
        cur = null;
        state = 'out';
      } else if (kind === null) {
        cur!.l.push(row);
      } else {
        return null;
      }
    }
  }
  if (state !== 'out') return null;
  const last = pieces[pieces.length - 1];
  if (last !== undefined && !Buffer.isBuffer(last)) {
    if (!endsWithLf(tip)) unterminateLast(last.t);
    if (!endsWithLf(local)) unterminateLast(last.l);
  }
  return { pieces, regions };
}

function endsWithLf(b: Buffer): boolean {
  return b.length > 0 && b[b.length - 1] === LF;
}

function unterminateLast(block: Buffer[]): void {
  const i = block.length - 1;
  if (i >= 0) block[i] = stripEnding(block[i] as Buffer);
}

/** Row contents, endings ignored; the first row's BOM is ignored when the block starts the file. */
function keys(block: readonly Buffer[], atStart: boolean): string[] {
  return block.map((r, i) => stripEnding(i === 0 && atStart && hasBom(r) ? r.subarray(3) : r).toString('latin1'));
}

function containsRun(hay: readonly string[], needle: readonly string[]): boolean {
  if (needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let j = 0;
    while (j < needle.length && hay[i + j] === needle[j]) j++;
    if (j === needle.length) return true;
  }
  return false;
}

const BLANK = /^[\t\n\v\f\r ]*$/;

/** D9 step 2: B empty, T and L non-empty, no non-blank row (ending ignored) in both T and L. */
function concatQualifies(r: Region): boolean {
  if (r.b.length !== 0 || r.t.length === 0 || r.l.length === 0) return false;
  const inT = new Set(keys(r.t, r.atStart).filter((k) => !BLANK.test(k)));
  return !keys(r.l, r.atStart).some((k) => !BLANK.test(k) && inT.has(k));
}

function endingOf(row: Buffer | null): Buffer | null {
  if (row === null || !endsWithLf(row)) return null;
  return row.length >= 2 && row[row.length - 2] === CR ? Buffer.from([CR, LF]) : Buffer.from([LF]);
}

/** D9 step 3: T, the base's line ending when T's last row has none, `sep` blank rows, L — both blocks byte for byte. */
function concatBlock(r: Region, base: Buffer): Buffer {
  const eol = endingOf(r.before) ?? (form(base).eol === 'CRLF' ? Buffer.from([CR, LF]) : Buffer.from([LF]));
  const parts: Buffer[] = [...r.t];
  const lastT = r.t[r.t.length - 1] as Buffer;
  if (!endsWithLf(lastT)) parts.push(eol);
  const trailing = countBlank([...r.t].reverse());
  const leading = countBlank(r.l);
  for (let i = Math.max(0, SEPARATOR_NEED - (trailing + leading)); i > 0; i--) parts.push(eol);
  parts.push(...r.l);
  return Buffer.concat(parts);
}

function countBlank(block: readonly Buffer[]): number {
  let n = 0;
  while (n < block.length && BLANK.test(stripEnding(block[n] as Buffer).toString('latin1'))) n++;
  return n;
}

function assemble(p: Parsed, replace: (r: Region) => Buffer): Buffer {
  return Buffer.concat(p.pieces.map((x) => (Buffer.isBuffer(x) ? x : replace(x))));
}

/**
 * D9 steps 4–5 (also step 0a's acceptance): canon(out, ref(p)); tripwire leg (i) (UTF-8 inputs give a
 * UTF-8 output) and leg (iii) (every non-blank output row occurs in s1, s2 or s3); no git conflict-marker
 * row absent from both LOCAL and TIP (ENG-41 (e)); then route (c). Any failure → null (not qualified).
 */
async function finish(ctx: ConflictCtx, path: string, out: Buffer, stages: readonly Buffer[]): Promise<ConflictVerdict | null> {
  const c = canon(out, await ctx.ref(path), false);
  if (!c.ok) return null;
  const result = c.out;
  if (stages.every(isUtf8) && !isUtf8(result)) return null;
  const known = new Set(stages.flatMap((s) => keys(rows(s), true)));
  if (keys(rows(result), true).some((k) => !BLANK.test(k) && !known.has(k))) return null;
  const sides = new Set([...conflictMarkerRows(stages[1] as Buffer), ...conflictMarkerRows(stages[2] as Buffer)]);
  for (const mk of conflictMarkerRows(result)) if (!sides.has(mk)) return null;
  return { kind: 'CONCAT', blob: await hashRouteC(ctx.repo, result, ctx.write) };
}

function isUtf8(b: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b);
    return true;
  } catch {
    return false;
  }
}
