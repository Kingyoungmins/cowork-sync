// The Plan 2 op generator (Task 18; 11-testing §3.3 run step 1, §3.5 F-ED-2, F-ED-6, F-ED-8, F-ED-9, F-NET-2, F-NET-5,
// F-NET-10; ruling R-31): human edits only in profile `edits`, plus network faults and lease races in `faults`.
//
// next() draws everything from ctx.random and resolves every parameter (peer, file, row, new text, durations) before
// the operation runs; run() draws nothing, reads the file as it is on that peer's disk, and writes Buffers (node:fs:
// this is test code, the human's editor) in the file's dominant ending — except eol_rewrite, which writes the other
// one — then sets the written file's mtime to the peer's virtual wall clock with utimes, so the engine's quiet-period
// rule compares one clock (creations and deletions set their directory's mtime the same way, so every mtime the
// generator leaves is on the virtual clock).
//
// The generator models what its operations do to the disk (each peer's own files, the partition) per SimContext, so
// every kind it draws can run: edit_own/delete_own need an own file, heal a partition, race_push and edit_same_line
// two peers. The model lives in one WeakMap shared by every generator, so scripted runs may mix generators.
//
// Kinds (seedFilesPlan2 lays out the files they touch):
//   new_file       own/<peer>-<k>.txt, 3–8 rows, in the peer's checkout ending (CRLF on core.autocrlf=true peers)
//   edit_own       one row of one of the peer's own files
//   edit_band      one of rows 3–7 of the peer's band of shared.txt (band i = rows 10i…10i+9; rows 0–2 and 8–9 never
//                  edited, so two peers' edits are ≥ 5 unchanged rows apart: no adjacent-row conflict)
//   edit_same_line one of rows 1, 4, 7 of notes.txt on two peers at once, each with its own text (a replacement, so
//                  never an insertion-concat): K4 on the later publisher
//   append_md      a row appended at the end of notes.md (insertion-concat when two peers append before publishing)
//   eol_rewrite    crlf.txt (row 3i+1), shared.txt (band row), big.py (row 100+20i), the non-ASCII seed file (row 3i+1)
//                  or an own file, rewritten with every ending flipped and one row changed: canon must map it back to
//                  the stored form (R-07)
//   delete_own     one of the peer's own files
//   temp_file      an editor temp name (`*~`, `.#*`, `*.swp`) under own/: NOT_ADMITTED
//   secret_name    a secret-like name (`*.pem`, `.env.*`, `id_rsa*`) under own/: NOT_ADMITTED
//   partition      the bare remote renamed away, drawn for 30 s – 10 min of virtual time (`planned_ms`); it ends at a
//                  drawn heal, at the generator's heal once that time passed, or at the harness's heal when the op
//                  budget ends, and every heal logs the outage it ended (`for_ms`)
//   heal           the bare remote renamed back
//   reject_transient  the next 1–2 pushes to a board ref rejected by pre-receive with the ref unchanged (F-NET-10), with
//                  either host text (`[remote rejected] … (failed)` or `fatal error in commit_refs`); nothing while
//                  earlier ones are pending, and never a third in one publish's streak (R-31: 1–2, never NONRETRYABLE)
//   race_push      two engines stepped together and interleaved at yieldPoint('publish.beforePush'): the first one
//                  runs until it holds there, then the second; the first is released and finishes its step, then the
//                  second pushes with a lease on the old tip (lease_lost, F-NET-2). Serialized, so the order of every
//                  git call and trace event is fixed.
//
// Plan 3 (Task 13; 11-testing §3.3, §3.5 F-HLD-1, F-ED-2…F-ED-5, F-FS-1, F-FS-4, F-FS-5, F-PATH-1, F-PATH-2; rulings R3-47,
// R3-48): editGenerator(profile, markers) adds one fresh marker per written file to every Plan 2 edit kind and notes each write
// in the MarkerModel (the draws are the same as without markers: a marker is a counter, never a draw); the `holds` profile is
// its own generator (holdsGenerator, the second half of this file), composed only by holdsSetup.
import { realpathSync } from 'node:fs';
import { appendFile, lstat, mkdir, readdir, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isSecretLike, portable, TEMP_PATTERNS, wildmatch } from '../../src/data/scope.js';
import type { MutantId } from '../../src/engine/deps.js';
import { refNames, RELEASE_NAMESPACE } from '../../src/engine/refs.js';
import type { Oid } from '../../src/git/oid.js';
import { stageable } from '../../src/engine/stagedRead.js';
import type { Json } from '../../src/board/canonicalJson.js';
import { isTerminal, type HoldRecord } from '../../src/holds/record.js';
import { randomHex, randomInt, seededRandom, type Random } from '../../src/ports/random.js';
import { faultFsOf, realEngine, realEngineOf } from './engineAdapter.js';
import type { LockMode } from './faultfs.js';
import { generateBigBomCrlf } from './fixtures/bigBomCrlf.js';
import {
  advanceClocks, DEFAULT_QUIESCENCE, healDetail, healRemote, holdTimersSettled, partitionPlan, partitionRemote, rejectsPending, remotePartitioned, retryTransientHolder,
  type EngineFactory, type OpGenerator, type OpLogEntry, type SeedTuple, type SimContext, type SimEngine, type SimOp, type SimOptions,
} from './harness.js';
import { readBlob, readRegistry, treeEntries } from './holdsView.js';
import { findMarkers, MarkerModel, markerRun } from './markers.js';
import type { PeerClone } from './peers.js';
import type { RejectKind } from './remote.js';
import { createTeamWriter, teamPush, type TeamWriter } from './teamWriter.js';

export type EditKind = 'new_file' | 'edit_own' | 'edit_band' | 'edit_same_line' | 'append_md' | 'eol_rewrite' | 'delete_own' | 'temp_file' | 'secret_name';
export type FaultKind = 'partition' | 'heal' | 'reject_transient' | 'race_push';
/** Plan 3 (R3-47): the human edit kinds of the `holds` profile beyond Plan 2's. */
export type HoldsEditKind = EditKind | 'edit_peer_line' | 'stale_save' | 'rewind' | 'formatter' | 'collide_ignored' | 'nonportable_name'
  | 'write_during_apply';             // F-ED-4 (concurrent write during an apply, at the apply.beforePhase2 yield point)
/** Plan 3 (R3-47): the fault and verb kinds of the `holds` profile beyond Plan 2's. */
export type HoldsFaultKind = FaultKind | 'lock_share_read' | 'lock_share_none' | 'unlock' | 'age_24h' | 'resolve' | 'resume' | 'gc_prune' | 'nonconforming_push';
/**
 * A generator profile. Plan 3 widens `name` and the weights' key and adds `steps`, the op budget run-seeds uses without --steps (edits
 * 40, faults 40, holds 60; every PROFILES entry has it). `steps` is optional in this type only so that profile literals written
 * against Plan 2 (`{name, engineWeight, weights}`) keep compiling; editGenerator ignores it.
 */
export interface GeneratorProfile {
  readonly name: 'edits' | 'faults' | 'holds';
  readonly engineWeight: number;
  readonly steps?: number;
  readonly weights: Readonly<Partial<Record<HoldsEditKind | HoldsFaultKind, number>>>;
}

export const EDIT_KINDS: readonly EditKind[] = Object.freeze(['new_file', 'edit_own', 'edit_band', 'edit_same_line', 'append_md', 'eol_rewrite', 'delete_own', 'temp_file', 'secret_name']);
export const FAULT_KINDS: readonly FaultKind[] = Object.freeze(['partition', 'heal', 'reject_transient', 'race_push']);
const ALL_KINDS: ReadonlyArray<EditKind | FaultKind> = [...EDIT_KINDS, ...FAULT_KINDS];
/** Every kind of the holds catalogue (R3-47), in the draw order of holdsGenerator. */
export const HOLDS_EDIT_KINDS: readonly HoldsEditKind[] = Object.freeze([
  ...EDIT_KINDS, 'edit_peer_line', 'stale_save', 'rewind', 'formatter', 'collide_ignored', 'nonportable_name', 'write_during_apply',
] as HoldsEditKind[]);
export const HOLDS_FAULT_KINDS: readonly HoldsFaultKind[] = Object.freeze([
  ...FAULT_KINDS, 'lock_share_read', 'lock_share_none', 'unlock', 'age_24h', 'resolve', 'resume', 'gc_prune', 'nonconforming_push',
] as HoldsFaultKind[]);
const HOLDS_KINDS: ReadonlyArray<HoldsEditKind | HoldsFaultKind> = [...HOLDS_EDIT_KINDS, ...HOLDS_FAULT_KINDS];

const EDIT_WEIGHTS: Readonly<Record<EditKind, number>> = Object.freeze({
  new_file: 4, edit_own: 3, edit_band: 4, edit_same_line: 1, append_md: 2, eol_rewrite: 1, delete_own: 1, temp_file: 1, secret_name: 1,
});
/** Task 13's weight table (R3-47): partition, heal, reject_transient, race_push, formatter and resume at 0 (the last two are scheduled). */
const HOLDS_WEIGHTS: Readonly<Record<HoldsEditKind | HoldsFaultKind, number>> = Object.freeze({
  new_file: 3, edit_own: 6, edit_band: 6, edit_same_line: 3, append_md: 2, eol_rewrite: 1, delete_own: 1, temp_file: 1, secret_name: 1,
  edit_peer_line: 5, stale_save: 4, rewind: 2, collide_ignored: 2, nonportable_name: 2, write_during_apply: 2,
  lock_share_read: 2, lock_share_none: 1, unlock: 3, age_24h: 1, resolve: 6, gc_prune: 1, nonconforming_push: 2,
  partition: 0, heal: 0, reject_transient: 0, race_push: 0, formatter: 0, resume: 0,
});
/**
 * R-31: `edits` = human edits only (about half the steps are engine steps); `faults` adds partitions, transient rejections and lease races.
 * R3-47: `holds` = 60 steps of the Task 13 catalogue (engineWeight 45); edits and faults gain steps 40 and are otherwise unchanged.
 */
export const PROFILES: Readonly<Record<'edits' | 'faults' | 'holds', GeneratorProfile & { readonly steps: number }>> = Object.freeze({
  edits: Object.freeze({ name: 'edits', engineWeight: 18, steps: 40, weights: EDIT_WEIGHTS }),
  faults: Object.freeze({ name: 'faults', engineWeight: 22, steps: 40, weights: Object.freeze({ ...EDIT_WEIGHTS, partition: 1, heal: 1, reject_transient: 1, race_push: 2 }) }),
  holds: Object.freeze({ name: 'holds', engineWeight: 45, steps: 60, weights: HOLDS_WEIGHTS }),
});

// ---- the seed files ------------------------------------------------------------------------------------------------

export const SHARED_FILE = 'shared.txt';
export const BANDS = 6;
export const BAND_ROWS = 10;
/** The rows of its band a peer edits (rows 0–2 and 8–9 of every band are never edited). */
export const BAND_EDIT_FIRST = 3;
export const BAND_EDIT_LAST = 7;
export const CRLF_FILE = 'crlf.txt';
export const BIG_FILE = 'big.py';
export const SAME_LINE_FILE = 'notes.txt';
/** notes.txt rows edit_same_line replaces (two unchanged rows between any two of them). */
export const SAME_LINE_ROWS: readonly number[] = Object.freeze([1, 4, 7]);
export const APPEND_FILE = 'notes.md';
export const OWN_DIR = 'own';
/** A seed path with non-ASCII characters and spaces (in a directory), LF-stored: eol_rewrite edits row 3i+1 of it. */
export const UNICODE_FILE = 'docs/caf\u{e9} \u{d55c}\u{ae00} notes.txt';
const SAME_LINE_FILE_ROWS = 9;
const CRLF_FILE_ROWS = 3 * BANDS;
const BIG_FILE_ROWS = 400;
/** eol_rewrite's row of big.py, and of crlf.txt and the non-ASCII file, for peer i (two unchanged rows between peers). */
const bigRow = (i: number): number => 100 + 20 * i;
const crlfRow = (i: number): number => 3 * i + 1;

const pad = (n: number): string => String(n).padStart(2, '0');

/** shared.txt (60 numbered LF rows, 6 bands of 10; peer i edits rows 3–7 of band i, rows 0–2 and 8–9 never edited), crlf.txt (CRLF-stored), notes.md, big.py (generateBigBomCrlf(400, r)), README.md, notes.txt, and UNICODE_FILE (a non-ASCII path with spaces). */
export function seedFilesPlan2(random: Random): Record<string, Buffer> {
  const rows = (n: number, row: (i: number) => string, eol: string): Buffer => Buffer.from(Array.from({ length: n }, (_, i) => `${row(i)}${eol}`).join(''), 'utf8');
  return {
    'README.md': Buffer.from('# cowork-sync SIM fixture (Plan 2)\n', 'utf8'),
    [APPEND_FILE]: Buffer.from('# Notes\n\nRows appended by the SIM peers:\n', 'utf8'),
    [SAME_LINE_FILE]: rows(SAME_LINE_FILE_ROWS, (i) => `note row ${i}`, '\n'),
    [SHARED_FILE]: rows(BANDS * BAND_ROWS, (g) => `shared band ${Math.floor(g / BAND_ROWS)} row ${g % BAND_ROWS} (${pad(g)})`, '\n'),
    [CRLF_FILE]: rows(CRLF_FILE_ROWS, (i) => `crlf row ${pad(i)}`, '\r\n'),
    [BIG_FILE]: generateBigBomCrlf(BIG_FILE_ROWS, random),
    [UNICODE_FILE]: rows(CRLF_FILE_ROWS, (i) => `caf\u{e9} row ${pad(i)}`, '\n'),
  };
}

// ---- text rows -------------------------------------------------------------------------------------------------------

type Eol = '\n' | '\r\n';
interface TextFile { bom: boolean; rows: string[]; final: boolean; eol: Eol; }
const BOM = String.fromCharCode(0xfeff);
const eolName = (e: Eol): string => (e === '\r\n' ? 'crlf' : 'lf');

/** The file's rows and its dominant ending (CRLF when more rows end in CRLF than in a bare LF; `fallback` without any). */
function parseText(b: Buffer, fallback: Eol): TextFile {
  let s = b.toString('utf8');
  const bom = s.startsWith(BOM);
  if (bom) s = s.slice(1);
  const crlf = s.split('\r\n').length - 1;
  const lf = s.split('\n').length - 1 - crlf;
  const eol: Eol = crlf + lf === 0 ? fallback : crlf > lf ? '\r\n' : '\n';
  const rows = s.split(/\r?\n/);
  const final = rows[rows.length - 1] === '';
  if (final) rows.pop();
  return { bom, rows, final, eol };
}

function renderText(t: TextFile, eol: Eol): Buffer {
  return Buffer.from(`${t.bom ? BOM : ''}${t.rows.join(eol)}${t.final ? eol : ''}`, 'utf8');
}

const checkoutEol = (p: PeerClone): Eol => (p.opts.autocrlf ? '\r\n' : '\n');
const absPath = (p: PeerClone, path: string): string => join(p.dir, ...path.split('/'));

function clockOf(ctx: SimContext, p: PeerClone): { wallMs(): number } {
  const c = ctx.clocks.get(p.name);
  if (c === undefined) throw new Error(`editGenerator: no clock for ${p.name}`);
  return c;
}

// Every disk call below is retried while a transient Windows holder (EBUSY/EPERM/EACCES: an indexer, antivirus, a
// just-exited git) has the file, as the harness's remote rename is; a human's editor retries the same way.

/** Writes the file and sets its mtime to the peer's virtual wall clock; `dirToo` (creations) sets its directory's mtime the same way. */
async function writeAt(ctx: SimContext, p: PeerClone, path: string, bytes: Buffer, dirToo: boolean): Promise<void> {
  const abs = absPath(p, path);
  await retryTransientHolder(() => mkdir(dirname(abs), { recursive: true }));
  await retryTransientHolder(() => writeFile(abs, bytes));
  const t = clockOf(ctx, p).wallMs() / 1_000;
  await retryTransientHolder(() => utimes(abs, t, t));
  if (dirToo) await retryTransientHolder(() => utimes(dirname(abs), t, t));
}

/** Replaces row `row` and writes the file in `eol` (null = its dominant ending); `before`/`after` are the file's bytes around the write. */
async function rewriteRow(
  ctx: SimContext, p: PeerClone, path: string, row: number | ((n: number) => number), text: string, eol: 'keep' | 'flip',
): Promise<{ row: number; eol: Eol; before: Buffer; after: Buffer }> {
  const before = await retryTransientHolder(() => readFile(absPath(p, path)));
  const t = parseText(before, checkoutEol(p));
  const r = typeof row === 'number' ? row : row(t.rows.length);
  if (r < 0 || r >= t.rows.length) throw new Error(`editGenerator: ${p.name}:${path} has ${t.rows.length} rows, no row ${r}`);
  t.rows[r] = text;
  const out: Eol = eol === 'keep' ? t.eol : t.eol === '\r\n' ? '\n' : '\r\n';
  const after = renderText(t, out);
  await writeAt(ctx, p, path, after, false);
  return { row: r, eol: out, before, after };
}

// ---- markers for Plan 2's kinds (Plan 3 Task 13; TST-08, R3-48) ----------------------------------------------------

/** ` <marker>` when markers are on, else nothing (so a run without a MarkerModel writes Plan 2's bytes exactly). */
const suffix = (m: string | null): string => (m === null ? '' : ` ${m}`);

/** The regular blob `path` has in tree `tree` of the clone at `dir`, cached per (dir, tree): ls-tree once per tree. */
const treeCache = new Map<string, Map<string, { mode: string; oid: Oid }>>();
async function entriesOf(ctx: SimContext, dir: string, tree: string): Promise<Map<string, { mode: string; oid: Oid }>> {
  const key = `${dir}\0${tree}`;
  let m = treeCache.get(key);
  if (m === undefined) {
    m = await treeEntries(ctx.git, dir, tree);
    if (treeCache.size > 256) treeCache.clear();
    treeCache.set(key, m);
  }
  return m;
}

/** Peer i's A blob of `path` (its engine's inspect().aTree), or null: no running engine, no state yet, or no regular blob there. */
async function aBytesOf(ctx: SimContext, i: number, path: string): Promise<Buffer | null> {
  const e = ctx.engines[i];
  const p = ctx.peers[i];
  if (e?.inspect === undefined || p === undefined) return null;
  let aTree: string;
  try {
    aTree = (await e.inspect()).aTree;
  } catch {
    return null;   // not started, killed and not restarted yet
  }
  const ent = (await entriesOf(ctx, p.dir, aTree)).get(path);
  if (ent === undefined || (ent.mode !== '100644' && ent.mode !== '100755')) return null;
  return readBlob(ctx.git, p.dir, ent.oid);
}

/** set difference over marker lists (order of `a` kept). */
const minus = (a: readonly string[], b: readonly string[]): string[] => {
  const bs = new Set(b);
  return a.filter((m) => !bs.has(m));
};

/**
 * TST-08's per-write note: added = findMarkers(after) − findMarkers(before), removed = the reverse, peerHad(m) = m in peer i's A blob
 * of the path or in its disk bytes before the write (R3-48).
 */
async function noteWrite(
  ctx: SimContext, markers: MarkerModel, i: number, path: string, before: Buffer | null, after: Buffer | null, informed: boolean, synced = true,
): Promise<void> {
  const b = before === null ? [] : findMarkers(before);
  const a = after === null ? [] : findMarkers(after);
  const added = minus(a, b);
  const removed = minus(b, a);
  if (added.length === 0 && removed.length === 0) return;
  const p = ctx.peers[i] as PeerClone;
  const had = new Set(b);
  if (removed.length > 0) {
    const aBytes = await aBytesOf(ctx, i, path);
    if (aBytes !== null) for (const m of findMarkers(aBytes)) had.add(m);
  }
  markers.noteEdit(p.name, path, added, removed, informed, (m) => had.has(m), synced);
}

/** D6 step 2.2's temp names (case-insensitive; a pattern with '/' also at any depth). */
function isTempName(path: string): boolean {
  return TEMP_PATTERNS.some((g) => wildmatch(g, path, true) || (g.includes('/') && wildmatch(`**/${g}`, path, true)));
}

/**
 * Whether a marker written to a new file at `path` is an obligation (R3-48): not for a temp or secret-like name (NOT_ADMITTED, no
 * record) or a name no record can carry (not stageable(), R3-53); a stageable non-portable name gets a `portability` record (DAT-33),
 * so its marker counts (local_only_disk).
 */
function syncedNewPath(path: string): boolean {
  return !isTempName(path) && !isSecretLike(path) && stageable(path);
}

// ---- the model ------------------------------------------------------------------------------------------------------

interface GenState {
  /** Each peer's own files on its disk (created by new_file, removed by delete_own; nobody else edits them). */
  own: Map<string, string[]>;
  /** Per peer: the last own-file number used (names are never reused). */
  made: Map<string, number>;
  partition: { untilMono: number } | null;
}
const states = new WeakMap<SimContext, GenState>();

function stateOf(ctx: SimContext): GenState {
  let s = states.get(ctx);
  if (s === undefined) {
    s = { own: new Map(), made: new Map(), partition: null };
    states.set(ctx, s);
  }
  return s;
}

const ownOf = (st: GenState, peer: string): string[] => {
  let l = st.own.get(peer);
  if (l === undefined) {
    l = [];
    st.own.set(peer, l);
  }
  return l;
};
const nextNumber = (st: GenState, peer: string): number => {
  const n = (st.made.get(peer) ?? 0) + 1;
  st.made.set(peer, n);
  return n;
};

/** Virtual monotonic time (every peer clock advances together in the harness). */
function nowMono(ctx: SimContext): number {
  const first = ctx.peers[0];
  return first === undefined ? 0 : (ctx.clocks.get(first.name)?.monoMs() ?? 0);
}

/** 30 s – 10 min (R-31: partitions of up to 10 virtual minutes). */
const PARTITION_MIN_MS = 30_000;
const PARTITION_MAX_MS = 600_000;
/** A board ref: the publish, board-only and genesis pushes, never the probe or a displaced copy. */
const REJECT_REF = '/board';
/** The host texts of F-NET-10: `[remote rejected] … (failed)` and `remote: fatal error in commit_refs`. */
const REJECT_KINDS: readonly RejectKind[] = Object.freeze(['transient-failed', 'commit_refs']);
/** R-31: 1–2 transient rejections of one publish; the third would be NONRETRYABLE. */
const MAX_TRANSIENT_STREAK = 2;

function applicable(ctx: SimContext, st: GenState, k: EditKind | FaultKind): boolean {
  switch (k) {
    case 'edit_own':
    case 'delete_own':
      return ctx.peers.some((p) => (st.own.get(p.name)?.length ?? 0) > 0);
    case 'edit_same_line':
    case 'race_push':
      return ctx.peers.length >= 2;
    case 'partition':
      return st.partition === null;
    case 'heal':
      return st.partition !== null;
    default:
      return true;
  }
}

function twoPeers(ctx: SimContext): [number, number] {
  const n = ctx.peers.length;
  const a = randomInt(ctx.random, n);
  const b = (a + 1 + randomInt(ctx.random, n - 1)) % n;
  return [a, b];
}

function peerAt(ctx: SimContext, i: number): PeerClone {
  const p = ctx.peers[i];
  if (p === undefined) throw new Error(`editGenerator: no peer ${i}`);
  return p;
}

function engineOf(ctx: SimContext, i: number): SimEngine {
  const e = ctx.engines[i];
  if (e === undefined) throw new Error(`editGenerator: no engine for peer ${i}`);
  return e;
}

/** A token for new row text: 8 hex characters from ctx.random. */
const token = (ctx: SimContext): string => randomHex(ctx.random, 4);

/**
 * One Plan 2 operation, every parameter drawn here. With `mk` (Plan 3, TST-08) every written file also gets one fresh marker — its
 * own last row for new_file, temp_file, secret_name and append_md, a suffix of the edited row otherwise — and each write is noted in
 * the model (temp and secret-like files as not synced); without it the bytes are Plan 2's exactly. The draws do not depend on `mk`.
 */
function build(ctx: SimContext, st: GenState, k: EditKind | FaultKind, mk?: MarkerModel): SimOp {
  const random = ctx.random;
  const mint = (p: PeerClone): string | null => (mk === undefined ? null : mk.mint(p.name));
  const idx = (p: PeerClone): number => ctx.peers.indexOf(p);
  switch (k) {
    case 'new_file': {
      const i = randomInt(random, ctx.peers.length);
      const p = peerAt(ctx, i);
      const n = nextNumber(st, p.name);
      const path = `${OWN_DIR}/${p.name}-${n}.txt`;
      const count = 3 + randomInt(random, 6);
      const tok = token(ctx);
      ownOf(st, p.name).push(path);
      const eol = checkoutEol(p);
      const bytes = Buffer.from(Array.from({ length: count }, (_, j) => `${p.name} file ${n} row ${j} ${tok}${eol}`).join(''), 'utf8');
      return {
        peer: p.name, kind: k,
        run: async (c) => {
          const m = mint(p);
          const out = m === null ? bytes : Buffer.concat([bytes, Buffer.from(`${m}${eol}`, 'utf8')]);
          await writeAt(c, p, path, out, true);
          if (mk !== undefined) await noteWrite(c, mk, i, path, null, out, true);
          return `${path} rows=${count} eol=${eolName(eol)}${suffix(m)}`;
        },
      };
    }
    case 'edit_own': {
      const owners = ctx.peers.filter((p) => (st.own.get(p.name)?.length ?? 0) > 0);
      const p = owners[randomInt(random, owners.length)] as PeerClone;
      const files = ownOf(st, p.name);
      const path = files[randomInt(random, files.length)] as string;
      const pick = randomInt(random, 1_000);
      const tok = token(ctx);
      return {
        peer: p.name, kind: k,
        run: async (c) => {
          const m = mint(p);
          const r = await rewriteRow(c, p, path, (n) => pick % n, `${p.name} edited ${tok}${suffix(m)}`, 'keep');
          if (mk !== undefined) await noteWrite(c, mk, idx(p), path, r.before, r.after, true);
          return `${path} row=${r.row}${suffix(m)}`;
        },
      };
    }
    case 'edit_band': {
      const i = randomInt(random, ctx.peers.length);
      const p = peerAt(ctx, i);
      const g = i * BAND_ROWS + BAND_EDIT_FIRST + randomInt(random, BAND_EDIT_LAST - BAND_EDIT_FIRST + 1);
      const tok = token(ctx);
      return {
        peer: p.name, kind: k,
        run: async (c) => {
          const m = mint(p);
          const r = await rewriteRow(c, p, SHARED_FILE, g, `shared band ${i} row ${g % BAND_ROWS} (${pad(g)}) ${p.name} ${tok}${suffix(m)}`, 'keep');
          if (mk !== undefined) await noteWrite(c, mk, i, SHARED_FILE, r.before, r.after, true);
          return `${SHARED_FILE} row=${g}${suffix(m)}`;
        },
      };
    }
    case 'edit_same_line': {
      const [a, b] = twoPeers(ctx);
      const pa = peerAt(ctx, a);
      const pb = peerAt(ctx, b);
      const row = SAME_LINE_ROWS[randomInt(random, SAME_LINE_ROWS.length)] as number;
      const ta = token(ctx);
      const tb = token(ctx);
      return {
        peer: pa.name, kind: k,
        run: async (c) => {
          const ma = mint(pa);
          const ra = await rewriteRow(c, pa, SAME_LINE_FILE, row, `note row ${row} ${pa.name} ${ta}${suffix(ma)}`, 'keep');
          const mb = mint(pb);
          const rb = await rewriteRow(c, pb, SAME_LINE_FILE, row, `note row ${row} ${pb.name} ${tb}${suffix(mb)}`, 'keep');
          if (mk !== undefined) {
            await noteWrite(c, mk, a, SAME_LINE_FILE, ra.before, ra.after, true);
            await noteWrite(c, mk, b, SAME_LINE_FILE, rb.before, rb.after, true);
          }
          return `${SAME_LINE_FILE} row=${row} peers=${pa.name},${pb.name}${suffix(ma)}${suffix(mb)}`;
        },
      };
    }
    case 'append_md': {
      const p = peerAt(ctx, randomInt(random, ctx.peers.length));
      const tok = token(ctx);
      return {
        peer: p.name, kind: k,
        run: async (c) => {
          const before = await retryTransientHolder(() => readFile(absPath(p, APPEND_FILE)));
          const t = parseText(before, checkoutEol(p));
          t.rows.push(`- ${p.name} ${tok}`);
          const m = mint(p);
          if (m !== null) t.rows.push(m);
          t.final = true;
          const after = renderText(t, t.eol);
          await writeAt(c, p, APPEND_FILE, after, false);
          if (mk !== undefined) await noteWrite(c, mk, idx(p), APPEND_FILE, before, after, true);
          return `${APPEND_FILE}${suffix(m)}`;
        },
      };
    }
    case 'eol_rewrite': {
      const i = randomInt(random, ctx.peers.length);
      const p = peerAt(ctx, i);
      const targets = [CRLF_FILE, SHARED_FILE, BIG_FILE, UNICODE_FILE, ...ownOf(st, p.name)];
      const path = targets[randomInt(random, targets.length)] as string;
      const band = i * BAND_ROWS + BAND_EDIT_FIRST + randomInt(random, BAND_EDIT_LAST - BAND_EDIT_FIRST + 1);
      const pick = randomInt(random, 1_000);
      const tok = token(ctx);
      const row: number | ((n: number) => number) = path === CRLF_FILE || path === UNICODE_FILE ? crlfRow(i)
        : path === SHARED_FILE ? band : path === BIG_FILE ? bigRow(i) : (n: number) => pick % n;
      const text = path === SHARED_FILE ? `shared band ${i} row ${band % BAND_ROWS} (${pad(band)}) ${p.name} ${tok}` : path === BIG_FILE ? `# ${p.name} ${tok}` : `${p.name} rewrote ${tok}`;
      return {
        peer: p.name, kind: k,
        run: async (c) => {
          const m = mint(p);
          const r = await rewriteRow(c, p, path, row, `${text}${suffix(m)}`, 'flip');
          if (mk !== undefined) await noteWrite(c, mk, i, path, r.before, r.after, true);
          return `${path} row=${r.row} eol=${eolName(r.eol)}${suffix(m)}`;
        },
      };
    }
    case 'delete_own': {
      const owners = ctx.peers.filter((p) => (st.own.get(p.name)?.length ?? 0) > 0);
      const p = owners[randomInt(random, owners.length)] as PeerClone;
      const files = ownOf(st, p.name);
      const [path] = files.splice(randomInt(random, files.length), 1) as [string];
      return {
        peer: p.name, kind: k,
        run: async (c) => {
          const abs = absPath(p, path);
          const before = mk === undefined ? null : await readFile(abs).catch(() => null);
          await retryTransientHolder(() => rm(abs, { force: true }));
          const t = clockOf(c, p).wallMs() / 1_000;
          await retryTransientHolder(() => utimes(dirname(abs), t, t));
          if (mk !== undefined) await noteWrite(c, mk, idx(p), path, before, null, true);
          return path;
        },
      };
    }
    case 'temp_file':
    case 'secret_name': {
      const p = peerAt(ctx, randomInt(random, ctx.peers.length));
      const n = nextNumber(st, p.name);
      const names = k === 'temp_file'
        ? [`${p.name}-${n}.txt~`, `.#${p.name}-${n}.txt`, `${p.name}-${n}.txt.swp`]
        : [`${p.name}-${n}.pem`, `.env.${p.name}-${n}`, `id_rsa_${p.name}_${n}`];
      const path = `${OWN_DIR}/${names[randomInt(random, names.length)] as string}`;
      const tok = token(ctx);
      const eol = checkoutEol(p);
      const bytes = Buffer.from(`${k === 'temp_file' ? 'scratch' : 'not a real key'} ${tok}${eol}`, 'utf8');
      return {
        peer: p.name, kind: k,
        run: async (c) => {
          const m = mint(p);
          const out = m === null ? bytes : Buffer.concat([bytes, Buffer.from(`${m}${eol}`, 'utf8')]);
          await writeAt(c, p, path, out, true);
          // NOT_ADMITTED without a record (temp, secret-like): the marker is exempt, no obligation (R3-48)
          if (mk !== undefined) await noteWrite(c, mk, idx(p), path, null, out, true, false);
          return `${path}${suffix(m)}`;
        },
      };
    }
    case 'partition': {
      const ms = PARTITION_MIN_MS + randomInt(random, PARTITION_MAX_MS - PARTITION_MIN_MS + 1);
      const sinceMono = nowMono(ctx);
      st.partition = { untilMono: sinceMono + ms };
      return {
        peer: '*', kind: k,
        run: async (c) => `${(await partitionRemote(c, { sinceMono, plannedMs: ms })) ? 'remote renamed' : 'already partitioned'} planned_ms=${ms}`,
      };
    }
    case 'heal':
      st.partition = null;
      return healOp();
    case 'reject_transient': {
      const n = 1 + randomInt(random, 2);
      const kind = REJECT_KINDS[randomInt(random, REJECT_KINDS.length)] as RejectKind;
      return { peer: '*', kind: k, run: (c) => armRejections(c, n, kind) };
    }
    case 'race_push': {
      const [a, b] = twoPeers(ctx);
      return { peer: peerAt(ctx, a).name, kind: k, run: (c) => raceStep(c, engineOf(c, a), engineOf(c, b)) };
    }
  }
}

/** A heal: drawn (the outage ends early) or the generator's once the drawn outage has passed; for_ms is the real outage. */
function healOp(): SimOp {
  return {
    peer: '*', kind: 'heal',
    run: async (c) => {
      const plan = partitionPlan(c);
      return (await healRemote(c)) ? `remote restored ${healDetail(plan, nowMono(c))}`.trimEnd() : 'not partitioned';
    },
  };
}

/**
 * The trailing run of transient rejections of each peer's publish (and board-only) pushes in the trace: transient adds
 * one, landed and lease_lost end the run, network and denied leave it as it is (the engine's streak, PRO-54, never
 * exceeds it). The largest over all peers.
 */
function transientStreak(ctx: SimContext): number {
  const runs = new Map<string, number>();
  for (const e of ctx.trace.ofKind('push')) {
    if (e.purpose !== 'publish' && e.purpose !== 'board_only') continue;
    if (e.outcome === 'transient' || e.outcome === 'nonretryable') runs.set(e.peer, (runs.get(e.peer) ?? 0) + 1);
    else if (e.outcome === 'landed' || e.outcome === 'lease_lost') runs.set(e.peer, 0);
  }
  return Math.max(0, ...runs.values());
}

/**
 * F-NET-10 within R-31's "1–2 transient rejections": `n` more rejections of a board push, unless earlier ones are still
 * pending, and never so many that one publish could meet a third in a row (NONRETRYABLE is no fault this profile
 * injects): the drawn n is cut to MAX_TRANSIENT_STREAK minus the longest streak in the trace.
 */
async function armRejections(ctx: SimContext, n: number, kind: RejectKind): Promise<string> {
  const pending = await rejectsPending(ctx);
  if (pending > 0) return `skipped pending=${pending}`;
  const streak = transientStreak(ctx);
  const m = Math.min(n, MAX_TRANSIENT_STREAK - streak);
  if (m <= 0) return `skipped streak=${streak}`;
  await ctx.remote.rejectNext(m, kind, REJECT_REF);
  return `n=${m} kind=${kind} ref=${REJECT_REF}${m < n ? ` drawn=${n} streak=${streak}` : ''}`;
}

interface Gate { arrived: Promise<void>; arrive(): void; released: Promise<void>; release(): void; }

function gate(): Gate {
  let arrive!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>((r) => { arrive = r; });
  const released = new Promise<void>((r) => { release = r; });
  return { arrived, arrive, released, release };
}

/**
 * F-NET-2 by yield interleaving (11-testing §3.3 run step 2): `a` steps until it holds at publish.beforePush (or its
 * step ends), then `b` likewise; `a` is released and finishes its step (its push lands), then `b` (its push carries a
 * lease on the tip both fetched: lease_lost). Never two engines running at once. Detail: `<a>@gate|done <b>@gate|done`.
 */
async function raceStep(ctx: SimContext, a: SimEngine, b: SimEngine): Promise<string> {
  const sched = ctx.scheduler;
  const prev = sched.onYield;
  let holding: Gate | null = null;
  sched.onYield = async (name: string): Promise<void> => {
    if (name === 'publish.beforePush' && holding !== null) {
      const g = holding;
      holding = null;
      g.arrive();
      await g.released;
    }
    if (prev !== null) await prev(name);
  };
  try {
    const ga = gate();
    holding = ga;
    const pa = a.step(ctx);
    const aAt = await Promise.race([pa.then(() => false), ga.arrived.then(() => true)]);
    holding = null;
    if (!aAt) {
      await b.step(ctx);
      return `${a.peer.name}@done ${b.peer.name}@done`;
    }
    const gb = gate();
    holding = gb;
    const pb = b.step(ctx);
    let bAt: boolean;
    try {
      bAt = await Promise.race([pb.then(() => false), gb.arrived.then(() => true)]);
    } catch (e) {
      holding = null;
      ga.release();
      await pa.catch(() => undefined);
      throw e;
    }
    holding = null;
    ga.release();
    try {
      await pa;
    } catch (e) {
      gb.release();
      await pb.catch(() => undefined);
      throw e;
    }
    gb.release();
    await pb;
    return `${a.peer.name}@gate ${b.peer.name}@${bAt ? 'gate' : 'done'}`;
  } finally {
    sched.onYield = prev;
  }
}

function checkProfile(profile: GeneratorProfile): void {
  const bad = (v: number): boolean => !Number.isSafeInteger(v) || v < 0;
  if (bad(profile.engineWeight)) throw new RangeError(`editGenerator: engineWeight must be an integer >= 0, got ${profile.engineWeight}`);
  for (const [k, v] of Object.entries(profile.weights)) {
    if (!(ALL_KINDS as readonly string[]).includes(k)) throw new RangeError(`editGenerator: unknown kind ${k}`);
    if (v !== undefined && bad(v)) throw new RangeError(`editGenerator: weight of ${k} must be an integer >= 0, got ${v}`);
  }
}

/**
 * Draws only from ctx.random; writes Buffers (node:fs, test code) in the file's dominant ending except eol_rewrite; sets every written
 * file's mtime to the peer's virtual wall clock (utimes). With `markers` (Plan 3, R3-49: INV-NOLOSS on every profile) every written
 * file carries one fresh marker and each write is noted in the model; the draws are the same with or without it.
 */
export function editGenerator(profile: GeneratorProfile, markers?: MarkerModel): OpGenerator {
  checkProfile(profile);
  return {
    next(ctx: SimContext, _step: number): SimOp | null {
      if (ctx.peers.length > BANDS) throw new Error(`editGenerator: at most ${BANDS} peers (one band of shared.txt each), got ${ctx.peers.length}`);
      const st = stateOf(ctx);
      // A partition ends once its drawn duration passed (R-31: up to 10 virtual minutes).
      if (st.partition !== null && nowMono(ctx) >= st.partition.untilMono) {
        st.partition = null;
        return healOp();
      }
      const kinds = ALL_KINDS.filter((k) => (profile.weights[k] ?? 0) > 0 && applicable(ctx, st, k));
      const total = kinds.reduce((s, k) => s + (profile.weights[k] ?? 0), profile.engineWeight);
      if (total === 0) return null;
      let r = randomInt(ctx.random, total);
      if (r < profile.engineWeight) return null;
      r -= profile.engineWeight;
      for (const k of kinds) {
        const w = profile.weights[k] ?? 0;
        if (r < w) return build(ctx, st, k, markers);
        r -= w;
      }
      throw new Error('editGenerator: weighted draw out of range');
    },
  };
}

// =====================================================================================================================
// Plan 3 (Task 13): the `holds` profile (11-testing §3.3, §3.5 F-HLD-1, F-ED-2…F-ED-5, F-ED-9, F-FS-1, F-FS-4, F-FS-5, F-PATH-1,
// F-PATH-2; rulings R3-47, R3-48). holdsGenerator.next(ctx, step) is synchronous and draws only from ctx.random: the kind (a
// scheduled op first, else weighted, else null = one engine step) and the peer index, plus the scheduling offsets of the ops it
// schedules; it reads ctx.peers (their count) and the peers' virtual mono clocks (the 60 s unlock and the 70 s form_fix rules) and
// nothing else. Every op's run(ctx) resolves its targets from the peer's disk, its engine's inspect() and holdsView (sorted
// candidate lists, first eligible from a start drawn from the run's own seededRandom(`${seed}/holds-run`), never ctx.random), writes
// Buffers with node:fs (the human's editor) and sets every written file's mtime to the peer's virtual wall clock; an op whose
// target does not exist writes nothing and returns `<kind> p<i> skipped (<why>)`. Each written file gets one fresh marker and each
// write is noted in the MarkerModel (TST-08, R3-48). holdsOp builds the same ops with fixed parameters for scripts.
// =====================================================================================================================

/** The Plan 3 seed files (11-testing §3.7). */
export const KO_FILE = 'ko.txt';
export const BIN_FILE = 'bin.dat';
export const BIG_BOMCRLF_FILE = 'big_bomcrlf.py';
export const GITIGNORE_FILE = '.gitignore';
export const FORM_FILE = 'form/flip.txt';
export const FMT_GLOB = 'fmt/*.py';
const FMT_FILES = 24;
const FMT_ROWS = 12;
const KO_ROWS = 40;
const FORM_ROWS = 12;
const BIG_BOMCRLF_ROWS = 26_436;
/** "한글" in cp949 (EUC-KR): C7 D1 B1 DB. */
const HANGUL_CP949 = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]);

/**
 * seedFilesPlan2(random) plus: ko.txt (40 LF rows `row <k> ` + cp949 "한글"), bin.dat (4,096 bytes of `random`, byte 0 = 0x00: binary
 * by DAT-04), big_bomcrlf.py (generateBigBomCrlf(26,436, random) with every CRLF stored as LF: UTF-8 BOM, stored LF, CRLF on an
 * autocrlf peer's disk — the 1.3 MB fixture), .gitignore (`*.log`, `build/`: SAVE_ONLY), form/flip.txt (12 LF rows `flip <k>`, touched
 * only by nonconforming_push) and fmt/m00.py…fmt/m23.py (12 LF rows `    v<k> = <k>` each: the formatter's 24 files).
 */
export function seedFilesPlan3(random: Random): Record<string, Buffer> {
  const files = seedFilesPlan2(random);
  const lf = (n: number, row: (k: number) => string): Buffer => Buffer.from(Array.from({ length: n }, (_, j) => `${row(j + 1)}\n`).join(''), 'utf8');
  files[KO_FILE] = Buffer.concat(Array.from({ length: KO_ROWS }, (_, j) => Buffer.concat([Buffer.from(`row ${j + 1} `, 'latin1'), HANGUL_CP949, Buffer.from('\n', 'latin1')])));
  const bin = Buffer.from(random.bytes(4_096));
  bin[0] = 0x00;
  files[BIN_FILE] = bin;
  // CRLF → LF on the raw bytes (a UTF-8 multi-byte sequence never holds 0x0D or 0x0A, so latin1 is exact).
  files[BIG_BOMCRLF_FILE] = Buffer.from(generateBigBomCrlf(BIG_BOMCRLF_ROWS, random).toString('latin1').split('\r\n').join('\n'), 'latin1');
  files[GITIGNORE_FILE] = Buffer.from('*.log\nbuild/\n', 'utf8');
  files[FORM_FILE] = lf(FORM_ROWS, (k) => `flip ${k}`);
  for (let f = 0; f < FMT_FILES; f++) files[`fmt/m${pad(f)}.py`] = lf(FMT_ROWS, (k) => `    v${k} = ${k}`);
  return files;
}

// ---- host names (F-PATH-1, F-ED-9; DAT-32, DAT-33, R3-53) ---------------------------------------------------------------

/** One component of 300+ UTF-8 bytes (D7 rule 2; Linux and macOS cap a component at 255 bytes; Task 7's win32 name). */
export const hangul304 = (k: number): string => `np/${'\u{d55c}'.repeat(100)}-${k}.txt`;
/** The decomposed spelling of the syllable U+D55C (D7 rule 1; not stageable: not NFC). */
export const nfdName = (k: number): string => `nfd/\u{1112}\u{1161}\u{11ab}-${k}.txt`;

/**
 * The non-portable names a peer can create on its host: linux `[con.py, trail., a:b.txt, NFD]`, darwin `[con.py, trail., a:b.txt]` (git
 * there precomposes names), a real win32 host `[HANGUL304, NFD]` (Windows cannot create the other three), an emulated win32 peer
 * (PeerOptions.platform 'win32' on another host) `[NFD]` on Linux and nothing on darwin (the op is then skipped, `no host name`).
 */
export function hostNames(peerPlatform: NodeJS.Platform | undefined, hostPlatform: NodeJS.Platform, k: number): string[] {
  if (peerPlatform === 'win32' && hostPlatform !== 'win32') return hostPlatform === 'darwin' ? [] : [nfdName(k)];
  if (hostPlatform === 'win32') return [hangul304(k), nfdName(k)];
  if (hostPlatform === 'darwin') return ['con.py', 'trail.', 'a:b.txt'];
  return ['con.py', 'trail.', 'a:b.txt', nfdName(k)];
}

/** R3-47: p0 plain, p1 core.autocrlf=true, p2 EngineDeps.platform 'win32' on every host (Windows-receiver emulation, data OQ-26); no filter (R-31). */
export const HOLDS_PEER_PROFILE = (index: number): { autocrlf: boolean; withFilter: boolean; platform?: NodeJS.Platform } =>
  (index === 2 ? { autocrlf: false, withFilter: false, platform: 'win32' } : { autocrlf: index % 2 === 1, withFilter: false });

// ---- ops: the shared run state ------------------------------------------------------------------------------------------

/** One holds op with fixed parameters (params per kind: Task 13 Notes, "Ops"). */
export interface HoldsOpSpec { kind: HoldsEditKind | HoldsFaultKind; peer: number; params?: Readonly<Record<string, Json>>; }
/** A script step: one op, one engine step of peer i, `n` rounds (every clock + 2,500 ms, every peer steps in name order), or a wait. */
export type ScriptStep = HoldsOpSpec | { iterate: number } | { rounds: number } | { advance: number };

/** Kinds whose op belongs to no peer. */
const PEERLESS: ReadonlySet<string> = new Set(['age_24h', 'partition', 'heal', 'reject_transient']);
/** The ring of earlier disk contents per (peer, path) (stale_save, rewind): the last 10, files ≤ 64 KiB (big_bomcrlf.py once a holds op wrote it). */
const RING_SIZE = 10;
const RING_MAX_BYTES = 65_536;
/** 05-holds HLD-32 / HLD-54: a lock is released by `unlock` only after it was held this long (holder's virtual mono). */
const LOCK_MIN_MS = 60_000;
/** form_fix is due once p0's virtual mono is this far past form_flip (the INCOMING eol-form record comes at 60 s). */
const FORM_FIX_AFTER_MS = 70_000;
/** age_24h: every clock advances 24 h + 1 s (S6, HLD-61). */
const AGE_24H_MS = 86_401_000;
/** A round of a script's {rounds: n} (the quiescence loop period). */
const ROUND_MS = 2_500;
/** At most one lock per peer and two in all per seed; lock ops only before this step; age_24h at most twice, from step 20. */
const LOCK_STEPS = 40;
const MAX_LOCKS = 2;
const AGE_FROM_STEP = 20;
const MAX_AGE_JUMPS = 2;

interface RingEntry { step: number; bytes: Buffer; }
interface NpFile { peer: number; k: number; bad: string; ok: string; stageable: boolean; done: boolean; }
interface HeldLock { path: string; mode: LockMode; sinceMono: number; release: () => void; }
interface HoldsRunState {
  /** run()-side choices (start offsets, variants, counts): seededRandom(`${seed}/holds-run`), never ctx.random. */
  readonly params: Random;
  /** The op counter: `h<k>` row tags and `x<k>` rows. */
  k: number;
  readonly own: Map<string, string[]>;
  readonly made: Map<string, number>;
  readonly rings: Map<string, RingEntry[]>;
  /** Peers whose big_bomcrlf.py a holds op wrote (its ring is kept from then on). */
  readonly wroteBig: Set<string>;
  /** Per peer: paths it excluded locally (.git/info/exclude, collide_ignored). */
  readonly excluded: Map<string, Set<string>>;
  readonly locks: Map<number, HeldLock>;
  readonly np: NpFile[];
  npK: number;
  team: TeamWriter | null;
  teamK: number;
  teamBad: { k: number; path: string; fixed: string; bytes: Buffer } | null;
}
const runStates = new WeakMap<SimContext, HoldsRunState>();

function runStateOf(ctx: SimContext): HoldsRunState {
  let h = runStates.get(ctx);
  if (h === undefined) {
    h = {
      params: seededRandom(`${ctx.seed}/holds-run`), k: 0, own: new Map(), made: new Map(), rings: new Map(), wroteBig: new Set(),
      excluded: new Map(), locks: new Map(), np: [], npK: 0, team: null, teamK: 0, teamBad: null,
    };
    runStates.set(ctx, h);
  }
  return h;
}

const listOf = <T>(m: Map<string, T[]>, key: string): T[] => {
  let l = m.get(key);
  if (l === undefined) {
    l = [];
    m.set(key, l);
  }
  return l;
};
const excludedOf = (h: HoldsRunState, peer: string): Set<string> => {
  let s = h.excluded.get(peer);
  if (s === undefined) {
    s = new Set();
    h.excluded.set(peer, s);
  }
  return s;
};
const ringKey = (peer: string, path: string): string => `${peer}\0${path}`;

/** The list rotated to start at an index drawn from the run's params stream (the first eligible from there). */
function rotate<T>(h: HoldsRunState, list: readonly T[]): T[] {
  if (list.length <= 1) return [...list];
  const at = randomInt(h.params, list.length);
  return [...list.slice(at), ...list.slice(0, at)];
}

/** The current harness step (the op's own op-log entry is pushed before it runs). */
const currentStep = (ctx: SimContext): number => ctx.opLog[ctx.opLog.length - 1]?.step ?? 0;

/** A marker's author (the last `_` field). */
const authorOf = (m: string): string => m.slice(m.lastIndexOf('_') + 1);

const holdsPeer = (ctx: SimContext, i: number): PeerClone => {
  const p = ctx.peers[i];
  if (p === undefined) throw new Error(`holdsOp: no peer ${i}`);
  return p;
};
const holdsEngine = (ctx: SimContext, i: number): SimEngine => {
  const e = ctx.engines[i];
  if (e === undefined) throw new Error(`holdsOp: no engine for peer ${i}`);
  return e;
};
const vclockOf = (ctx: SimContext, p: PeerClone): { monoMs(): number; wallMs(): number; advance(ms: number): void } => {
  const c = ctx.clocks.get(p.name);
  if (c === undefined) throw new Error(`holdsOp: no clock for ${p.name}`);
  return c;
};

async function readOrNull(p: PeerClone, path: string): Promise<Buffer | null> {
  try {
    return await retryTransientHolder(() => readFile(absPath(p, path)));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
    throw e;
  }
}

const isBinary = (b: Buffer): boolean => b.subarray(0, 8_000).includes(0);
const latin1 = (s: string): string => Buffer.from(s, 'utf8').toString('latin1');

/** Every file of the peer's work tree outside .git, repo-relative POSIX, sorted by code unit (readdir order never matters). */
async function listFiles(p: PeerClone): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let names: string[];
    try {
      names = (await readdir(dir)).sort();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;   // no work tree (yet): nothing to list
      throw e;
    }
    for (const name of names) {
      if (prefix === '' && name === '.git') continue;
      const st = await lstat(join(dir, name)).catch(() => null);
      if (st === null) continue;
      if (st.isDirectory()) await walk(join(dir, name), `${prefix}${name}/`);
      else if (st.isFile()) out.push(`${prefix}${name}`);
    }
  };
  await walk(p.dir, '');
  return out.sort();
}

/**
 * The rings: every file ≤ 64 KiB of every peer (big_bomcrlf.py only once a holds op wrote it) whose bytes differ from its ring's newest
 * entry gets a new entry tagged `step` (the content as of that harness step); 10 entries per (peer, path).
 */
async function refreshRings(ctx: SimContext, h: HoldsRunState, step: number): Promise<void> {
  for (const p of ctx.peers) {
    for (const path of await listFiles(p)) {
      const big = path === BIG_BOMCRLF_FILE;
      if (big && !h.wroteBig.has(p.name)) continue;
      const st = await lstat(absPath(p, path)).catch(() => null);
      if (st === null || (!big && st.size > RING_MAX_BYTES)) continue;
      const bytes = await readOrNull(p, path);
      if (bytes === null) continue;
      const ring = listOf(h.rings, ringKey(p.name, path));
      const last = ring[ring.length - 1];
      if (last !== undefined && last.bytes.equals(bytes)) continue;
      ring.push({ step, bytes });
      if (ring.length > RING_SIZE) ring.shift();
    }
  }
}

/**
 * The target exclusions (Task 13 Notes): no drawn target is form/flip.txt, np/team-*, a path that fails portable() (rules 1–3), a
 * .gitignore, a path under this peer's active lock, or a path this peer excluded locally.
 */
function excludedTarget(h: HoldsRunState, i: number, peer: string, path: string): boolean {
  if (path === FORM_FILE || path.startsWith('np/team-') || path === GITIGNORE_FILE || path.endsWith(`/${GITIGNORE_FILE}`)) return true;
  if (!portable(path, new Set()).ok) return true;
  if (lockedOn(h, i, path)) return true;
  return excludedOf(h, peer).has(path);
}

/**
 * Whether `path` on peer i's disk is under that peer's active lock (a lock_* op: another program holds the file, so no editor can write
 * it). Every op checks it for each path it would write — drawn, fixed (edit_band's shared.txt, append_md's notes.md, edit_same_line's
 * notes.txt on both peers, eol_rewrite's list) and explicit script paths alike — before it mints a marker, and skips with `locked`
 * (fix round 1, finding 2); holdsWrite refuses such a write outright, so an op that misses the check fails loudly.
 */
const lockedOn = (h: HoldsRunState, i: number, path: string): boolean => h.locks.get(i)?.path === path;

// ---- ops: byte-level rows -------------------------------------------------------------------------------------------------

/**
 * A file as latin1 rows (cp949 and UTF-8 bytes are kept: only ASCII is ever spliced in, at a row start or before a row's EOL), with
 * its leading UTF-8 BOM and dominant ending; edits splice one row and keep every other byte.
 */
class Doc {
  readonly bom: string;
  readonly body: string;
  readonly rows: ReadonlyArray<{ start: number; end: number; eol: '' | '\n' | '\r\n' }>;
  readonly eol: Eol;

  constructor(bytes: Buffer, fallback: Eol) {
    const s = bytes.toString('latin1');
    this.bom = s.startsWith('ï»¿') ? 'ï»¿' : '';
    this.body = s.slice(this.bom.length);
    const rows: Array<{ start: number; end: number; eol: '' | '\n' | '\r\n' }> = [];
    let start = 0;
    let crlf = 0;
    let lf = 0;
    while (start < this.body.length) {
      const nl = this.body.indexOf('\n', start);
      if (nl < 0) {
        rows.push({ start, end: this.body.length, eol: '' });
        break;
      }
      const cr = nl > start && this.body.charCodeAt(nl - 1) === 0x0d;
      if (cr) crlf++;
      else lf++;
      rows.push({ start, end: cr ? nl - 1 : nl, eol: cr ? '\r\n' : '\n' });
      start = nl + 1;
    }
    this.rows = rows;
    this.eol = crlf + lf === 0 ? fallback : crlf > lf ? '\r\n' : '\n';
  }

  text(i: number): string {
    const r = this.rows[i];
    if (r === undefined) throw new RangeError(`Doc: no row ${i} of ${this.rows.length}`);
    return this.body.slice(r.start, r.end);
  }

  texts(): string[] {
    return this.rows.map((_, i) => this.text(i));
  }

  /** The first row equal to `prefix` or starting with `prefix` + ' ' (latin1), or -1. */
  findRow(prefix: string): number {
    return this.rows.findIndex((_, i) => {
      const t = this.text(i);
      return t === prefix || t.startsWith(`${prefix} `);
    });
  }

  private out(body: string): Buffer {
    return Buffer.from(`${this.bom}${body}`, 'latin1');
  }

  /** Row i's text replaced (its EOL kept). */
  replace(i: number, text: string): Buffer {
    const r = this.rows[i];
    if (r === undefined) throw new RangeError(`Doc: no row ${i} of ${this.rows.length}`);
    return this.out(`${this.body.slice(0, r.start)}${text}${this.body.slice(r.end)}`);
  }

  /** Row i removed with its EOL (Plan 3 Task 16: the crash matrix's row deletion). */
  remove(i: number): Buffer {
    const r = this.rows[i];
    if (r === undefined) throw new RangeError(`Doc: no row ${i} of ${this.rows.length}`);
    return this.out(`${this.body.slice(0, r.start)}${this.body.slice(r.end + r.eol.length)}`);
  }

  /** `lines` inserted before row `at` (at ≥ the row count: appended, after an EOL the last row lacked), each with the dominant EOL. */
  insert(at: number, lines: readonly string[]): Buffer {
    const block = lines.map((l) => `${l}${this.eol}`).join('');
    if (at < this.rows.length) {
      const r = this.rows[at] as { start: number };
      return this.out(`${this.body.slice(0, r.start)}${block}${this.body.slice(r.start)}`);
    }
    const last = this.rows[this.rows.length - 1];
    return this.out(`${this.body}${last !== undefined && last.eol === '' ? this.eol : ''}${block}`);
  }

  /** Every row rewritten by `map` and all rendered with `eol` (a final EOL only when the file had one). */
  render(map: (text: string, i: number) => string, eol: Eol): Buffer {
    const last = this.rows[this.rows.length - 1];
    const final = last === undefined || last.eol !== '';
    return this.out(`${this.rows.map((_, i) => map(this.text(i), i)).join(eol)}${final && this.rows.length > 0 ? eol : ''}`);
  }
}

const rowMarkers = (text: string): string[] => findMarkers(Buffer.from(text, 'latin1'));
/** A row the peer may edit as an ordinary edit (R3-47: its own lines or pre-genesis lines): every marker on it is the peer's. */
const ownRow = (text: string, peer: string): boolean => rowMarkers(text).every((m) => authorOf(m) === peer);

/**
 * Writes the file (creating its directory) with the peer's virtual wall clock as mtime; `dirToo` stamps the directory as well. A path
 * under the peer's active lock is refused (an op must have skipped it: lockedOn).
 */
async function holdsWrite(ctx: SimContext, h: HoldsRunState, p: PeerClone, path: string, bytes: Buffer, dirToo: boolean): Promise<void> {
  if (lockedOn(h, ctx.peers.indexOf(p), path)) throw new Error(`holdsOp: ${p.name}'s ${path} is under an active lock (the op missed its lock check)`);
  await writeAt(ctx, p, path, bytes, dirToo);
  if (path === BIG_BOMCRLF_FILE) h.wroteBig.add(p.name);
}

// ---- ops: parameters ------------------------------------------------------------------------------------------------------

const str = (o: Readonly<Record<string, Json>>, k: string): string | undefined => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
const num = (o: Readonly<Record<string, Json>>, k: string): number | undefined => (typeof o[k] === 'number' ? (o[k] as number) : undefined);
const bool = (o: Readonly<Record<string, Json>>, k: string): boolean | undefined => (typeof o[k] === 'boolean' ? (o[k] as boolean) : undefined);
const strs = (o: Readonly<Record<string, Json>>, k: string): string[] | undefined => {
  const v = o[k];
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;
};

/** The peer's A tree entries (its running engine's inspect().aTree), or null without a running engine. */
async function aEntries(ctx: SimContext, i: number): Promise<Map<string, { mode: string; oid: Oid }> | null> {
  const engine = realEngineOf(holdsEngine(ctx, i));
  if (engine === null) return null;
  let aTree: string;
  try {
    aTree = (await engine.inspect()).aTree;
  } catch {
    return null;
  }
  return entriesOf(ctx, holdsPeer(ctx, i).dir, aTree);
}

/** The bytes of `path` at the peer's checkout of the seed (its HEAD, which the engine never moves) in the peer's checkout form. */
async function genesisBytes(ctx: SimContext, i: number, path: string): Promise<Buffer | null> {
  const p = holdsPeer(ctx, i);
  const head = (await ctx.git.run(['rev-parse', 'HEAD^{tree}'], { class: 'local', cwd: p.dir })).stdout.toString('utf8').trim();
  const ent = (await entriesOf(ctx, p.dir, head)).get(path);
  if (ent === undefined) return null;
  const stored = await readBlob(ctx.git, p.dir, ent.oid);
  // core.autocrlf=true checks a text file out with CRLF (git's own rule: only a stored file without CR is converted).
  if (!p.opts.autocrlf || isBinary(stored) || stored.includes(0x0d)) return stored;
  return Buffer.from(stored.toString('latin1').split('\n').join('\r\n'), 'latin1');
}

/** The live code tree of the remote board tip, read in the bare remote (null while partitioned or before genesis). */
async function remoteTipTree(ctx: SimContext): Promise<Map<string, { mode: string; oid: Oid }> | null> {
  if (await remotePartitioned(ctx)) return null;
  const refs = refNames('main', RELEASE_NAMESPACE);
  const board = (await ctx.git.run(['rev-parse', '--verify', '--quiet', `${refs.remoteBoard}^{commit}`], { class: 'local', cwd: ctx.remote.dir })).stdout.toString('utf8').trim();
  if (board === '') return null;
  const parents = (await ctx.git.run(['log', '-1', '--format=%P', board], { class: 'local', cwd: ctx.remote.dir })).stdout.toString('utf8').trim().split(' ');
  const live = parents[parents.length - 1];
  if (live === undefined || live === '') return null;
  return treeEntries(ctx.git, ctx.remote.dir, `${live}^{tree}`);
}

/** The row stale_save inserts its own row at: ≥ 2 rows from every row that differs between B and the current content (end first). */
function insertionRow(b: Doc, current: Doc): number | null {
  const bs = b.texts();
  const cs = current.texts();
  let pre = 0;
  while (pre < bs.length && pre < cs.length && bs[pre] === cs[pre]) pre++;
  let suf = 0;
  while (suf < bs.length - pre && suf < cs.length - pre && bs[bs.length - 1 - suf] === cs[cs.length - 1 - suf]) suf++;
  if (suf >= 2) return bs.length;
  if (pre >= 2) return 0;
  return null;
}

/**
 * The markers of `path` at peer i's provenance join point, re-derived test-side (R3-59: the live code of the laB of the oldest entry
 * of the peer's state-ref reflog — L0 at genesis, TIP at a join; src/engine/core.ts stateJoinPoint is not called): read in the peer's
 * clone with the harness's own git. A row already live there was never journaled by this peer (its journal starts empty at that
 * point), so HLD-27 cannot taint its removal on this peer. Empty without a state reflog (no engine has started).
 */
async function joinPointMarkers(ctx: SimContext, i: number, path: string): Promise<Set<string>> {
  const p = holdsPeer(ctx, i);
  const state = refNames('main', RELEASE_NAMESPACE).state;
  const r = await ctx.git.run(['log', '-g', '-z', '--format=%P', state, '--'], { class: 'local', cwd: p.dir });   // 128: no reflog yet
  if (r.code !== 0) return new Set();
  const recs = r.stdout.toString('utf8').split('\0').map((x) => x.trim()).filter((x) => x.length > 0);
  const laB = recs[recs.length - 1]?.split(' ')[1];
  if (laB === undefined) return new Set();
  const parents = (await ctx.git.run(['log', '-1', '--format=%P', laB], { class: 'local', cwd: p.dir })).stdout.toString('utf8').trim().split(' ');
  const live = parents[parents.length - 1];
  if (live === undefined || live === '') return new Set();
  const ent = (await entriesOf(ctx, p.dir, `${live}^{tree}`)).get(path);
  if (ent === undefined || (ent.mode !== '100644' && ent.mode !== '100755')) return new Set();
  return new Set(findMarkers(await readBlob(ctx.git, p.dir, ent.oid)));
}

/**
 * stale_save's and rewind's buffer B on peer i for `path`: an explicit `buffer` param ('genesis', n harness steps back, or
 * 'after:<marker>' = the oldest ring entry holding that marker) bypasses eligibility (the script owns its consequences); else the
 * newest ring entry (other than the current content) eligible by the rule: findMarkers(current) − findMarkers(B) holds ≥ 1 marker of
 * another author that is in the peer's A blob, none of the peer's own, and (EF4 r2, noloss-stale-save-published; ruling R3-EF4-19) no
 * marker of another author that was already at `path` in the peer's join point (joinPointMarkers): R3-59 leaves that row out of the
 * peer's journal, so the save would publish its removal with no `revert` record, and R3-47's stale_save is an op that creates `revert`
 * records. "None", not "at least one": a buffer removing a pre-join and a post-join row would get the post-join hunk held and the
 * pre-join hunk published — still a loss.
 */
async function staleBuffers(ctx: SimContext, h: HoldsRunState, i: number, path: string, current: Buffer, buffer: Json | undefined): Promise<{ b: Buffer; explicit: boolean }[]> {
  const p = holdsPeer(ctx, i);
  const ring = h.rings.get(ringKey(p.name, path)) ?? [];
  if (buffer === 'genesis') {
    const g = await genesisBytes(ctx, i, path);
    return g === null ? [] : [{ b: g, explicit: true }];
  }
  if (typeof buffer === 'number') {
    const target = currentStep(ctx) - buffer;
    const e = [...ring].reverse().find((x) => x.step <= target);
    return e === undefined ? [] : [{ b: e.bytes, explicit: true }];
  }
  if (typeof buffer === 'string' && buffer.startsWith('after:')) {
    const m = buffer.slice('after:'.length);
    const e = ring.find((x) => findMarkers(x.bytes).includes(m));
    return e === undefined ? [] : [{ b: e.bytes, explicit: true }];
  }
  const aBytes = await aBytesOf(ctx, i, path);
  const inA = new Set(aBytes === null ? [] : findMarkers(aBytes));
  const cur = findMarkers(current);
  const preJoin = await joinPointMarkers(ctx, i, path);
  const out: { b: Buffer; explicit: boolean }[] = [];
  for (const e of [...ring].reverse()) {
    if (e.bytes.equals(current) || isBinary(e.bytes)) continue;
    const gone = minus(cur, findMarkers(e.bytes));
    if (gone.some((m) => authorOf(m) === p.name)) continue;
    if (!gone.some((m) => authorOf(m) !== p.name && inA.has(m))) continue;
    if (gone.some((m) => authorOf(m) !== p.name && preJoin.has(m))) continue;   // R3-59: a pre-join row is unprotected on this peer
    out.push({ b: e.bytes, explicit: false });
  }
  return out;
}

/** The candidate paths of a peer's ring (stale_save, rewind): sorted, drawn targets only (exclusions applied). */
function ringPaths(h: HoldsRunState, i: number, peer: string): string[] {
  const prefix = `${peer}\0`;
  return [...h.rings.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)).filter((path) => !excludedTarget(h, i, peer, path)).sort();
}

// ---- ops ----------------------------------------------------------------------------------------------------------------

type Params = Readonly<Record<string, Json>>;
interface OpCtx { ctx: SimContext; h: HoldsRunState; markers: MarkerModel; i: number; k: number; params: Params; skip(why: string): string; }

async function opNewFile(o: OpCtx): Promise<string> {
  const { ctx, h, markers, i, k, params } = o;
  const p = holdsPeer(ctx, i);
  const explicit = str(params, 'path');
  if (explicit !== undefined && lockedOn(h, i, explicit)) return o.skip('locked');
  const n = (h.made.get(p.name) ?? 0) + 1;
  h.made.set(p.name, n);
  const path = explicit ?? `${OWN_DIR}/${p.name}-h${n}.txt`;
  if ((await readOrNull(p, path)) !== null) return o.skip(`${path} exists`);
  const count = num(params, 'rows') ?? 3 + randomInt(h.params, 6);
  const eol = checkoutEol(p);
  const m = markers.mint(p.name);
  const rows = [...Array.from({ length: count }, (_, j) => `${p.name} file ${n} row ${j} h${k}`), m];
  const bytes = Buffer.from(rows.map((r) => `${r}${eol}`).join(''), 'utf8');
  await holdsWrite(ctx, h, p, path, bytes, true);
  if (explicit === undefined || explicit.startsWith(`${OWN_DIR}/`)) listOf(h.own, p.name).push(path);
  await noteWrite(ctx, markers, i, path, null, bytes, true, syncedNewPath(path));
  return `${path} rows=${count} eol=${eolName(eol)} ${m}`;
}

async function opEditOwn(o: OpCtx): Promise<string> {
  const { ctx, h, markers, i, k, params } = o;
  const p = holdsPeer(ctx, i);
  const explicit = str(params, 'path');
  if (explicit !== undefined && lockedOn(h, i, explicit)) return o.skip('locked');
  // Plan 3 Task 16 (R3-52, TST-06): `marker` with `delete: true` — the author removes the row of its own line that carries the marker
  // (an informed write of its own line: untainted, HLD-27), the crash matrix's "a peer deleting the just-applied line".
  const target = str(params, 'marker');
  if (explicit !== undefined && target !== undefined && bool(params, 'delete') === true) {
    const before = await readOrNull(p, explicit);
    if (before === null || isBinary(before)) return o.skip(`no ${explicit}`);
    const d = new Doc(before, checkoutEol(p));
    const r = d.rows.findIndex((_, x) => rowMarkers(d.text(x)).includes(target));
    if (r < 0) return o.skip(`no row of ${explicit} carries ${target}`);
    if (!ownRow(d.text(r), p.name)) return o.skip(`row ${r} of ${explicit} is not ${p.name}'s own line`);
    const after = d.remove(r);
    await holdsWrite(ctx, h, p, explicit, after, false);
    await noteWrite(ctx, markers, i, explicit, before, after, true);
    return `${explicit} row=${r} deleted ${target}`;
  }
  const files = explicit !== undefined ? [explicit] : rotate(h, listOf(h.own, p.name).filter((f) => !excludedTarget(h, i, p.name, f)).sort());
  for (const path of files) {
    const before = await readOrNull(p, path);
    if (before === null || isBinary(before)) continue;
    const d = new Doc(before, checkoutEol(p));
    if (d.rows.length === 0) continue;
    const r = num(params, 'row') ?? randomInt(h.params, d.rows.length);
    if (r < 0 || r >= d.rows.length) return o.skip(`${path} has no row ${r}`);
    if (explicit === undefined && !ownRow(d.text(r), p.name)) continue;
    const m = markers.mint(p.name);
    const after = d.replace(r, latin1(`${str(params, 'text') ?? `${p.name} edited h${k}`} ${m}`));
    await holdsWrite(ctx, h, p, path, after, false);
    await noteWrite(ctx, markers, i, path, before, after, true);
    return `${path} row=${r} ${m}`;
  }
  return o.skip('no own file');
}

async function opEditBand(o: OpCtx): Promise<string> {
  const { ctx, h, markers, i, k, params } = o;
  const p = holdsPeer(ctx, i);
  const path = str(params, 'path') ?? SHARED_FILE;
  if (lockedOn(h, i, path)) return o.skip('locked');
  const before = await readOrNull(p, path);
  if (before === null || isBinary(before)) return o.skip(`no ${path}`);
  const d = new Doc(before, checkoutEol(p));
  const insert = bool(params, 'insert') ?? randomInt(h.params, 3) === 0;
  let m = '';
  let after: Buffer;
  let detail: string;
  if (insert) {
    // 05 P7: the peer inserts 1–40 own rows after row 7 of its band, the marker on the first one.
    const at = num(params, 'row') ?? d.findRow(latin1(`shared band ${i} row ${BAND_EDIT_LAST} (${pad(i * BAND_ROWS + BAND_EDIT_LAST)})`)) + 1;
    if (at <= 0 && num(params, 'row') === undefined) return o.skip(`no row ${BAND_EDIT_LAST} of band ${i}`);
    const n = num(params, 'n') ?? 1 + randomInt(h.params, 40);
    const text = str(params, 'text');
    m = markers.mint(p.name);
    // `text` (scripts): the inserted rows' text (`<text>`, then `<text> <t>`), e.g. a teammate's `p1-line <marker>`
    after = d.insert(at, Array.from({ length: n }, (_, t) => `${text === undefined ? `shared band ${i} ins h${k}.${t + 1} ${p.name}` : latin1(t === 0 ? text : `${text} ${t + 1}`)}${t === 0 ? ` ${m}` : ''}`));
    detail = `${path} insert at=${at} n=${n}`;
  } else {
    let row = num(params, 'row');
    let text = str(params, 'text');
    if (row === undefined) {
      for (const j of rotate(h, Array.from({ length: BAND_EDIT_LAST - BAND_EDIT_FIRST + 1 }, (_, x) => BAND_EDIT_FIRST + x))) {
        const g = i * BAND_ROWS + j;
        const at = d.findRow(latin1(`shared band ${i} row ${j} (${pad(g)})`));
        if (at < 0 || !ownRow(d.text(at), p.name)) continue;
        row = at;
        text ??= `shared band ${i} row ${j} (${pad(g)}) ${p.name} h${k}`;
        break;
      }
    }
    if (row === undefined) return o.skip(`no editable row of band ${i}`);
    if (row < 0 || row >= d.rows.length) return o.skip(`${path} has no row ${row}`);
    m = markers.mint(p.name);
    after = d.replace(row, latin1(`${text ?? `${p.name} band edit h${k}`} ${m}`));
    detail = `${path} row=${row}`;
  }
  await holdsWrite(ctx, h, p, path, after, false);
  await noteWrite(ctx, markers, i, path, before, after, true);
  return `${detail} ${m}`;
}

/** notes.txt row `note row <r>` (exact or followed by a space). */
const noteRowPrefix = (r: number): string => `note row ${r}`;

async function opEditSameLine(o: OpCtx): Promise<string> {
  const { ctx, h, markers, i, k, params } = o;
  if (ctx.peers.length < 2) return o.skip('one peer');
  const b = num(params, 'other') ?? (i + 1) % ctx.peers.length;
  const pa = holdsPeer(ctx, i);
  const pb = holdsPeer(ctx, b);
  if (lockedOn(h, i, SAME_LINE_FILE) || lockedOn(h, b, SAME_LINE_FILE)) return o.skip('locked');   // each peer's lock is on its own disk
  const rows = num(params, 'row') !== undefined ? [num(params, 'row') as number] : rotate(h, SAME_LINE_ROWS);
  for (const r of rows) {
    const ba = await readOrNull(pa, SAME_LINE_FILE);
    const bb = await readOrNull(pb, SAME_LINE_FILE);
    if (ba === null || bb === null) return o.skip(`no ${SAME_LINE_FILE}`);
    const da = new Doc(ba, checkoutEol(pa));
    const db = new Doc(bb, checkoutEol(pb));
    const ia = da.findRow(noteRowPrefix(r));
    const ib = db.findRow(noteRowPrefix(r));
    if (ia < 0 || ib < 0 || !ownRow(da.text(ia), pa.name) || !ownRow(db.text(ib), pb.name)) continue;
    const ma = markers.mint(pa.name);
    const aa = da.replace(ia, `${noteRowPrefix(r)} ${pa.name} h${k} ${ma}`);
    await holdsWrite(ctx, h, pa, SAME_LINE_FILE, aa, false);
    const mb = markers.mint(pb.name);
    const ab = db.replace(ib, `${noteRowPrefix(r)} ${pb.name} h${k} ${mb}`);
    await holdsWrite(ctx, h, pb, SAME_LINE_FILE, ab, false);
    await noteWrite(ctx, markers, i, SAME_LINE_FILE, ba, aa, true);
    await noteWrite(ctx, markers, b, SAME_LINE_FILE, bb, ab, true);
    return `${SAME_LINE_FILE} row=${r} peers=${pa.name},${pb.name} ${ma} ${mb}`;
  }
  return o.skip('no row both peers may edit');
}

async function opAppendMd(o: OpCtx): Promise<string> {
  const { ctx, h, markers, i, k } = o;
  const p = holdsPeer(ctx, i);
  if (lockedOn(h, i, APPEND_FILE)) return o.skip('locked');
  const before = await readOrNull(p, APPEND_FILE);
  if (before === null) return o.skip(`no ${APPEND_FILE}`);
  const d = new Doc(before, checkoutEol(p));
  const m = markers.mint(p.name);
  const after = d.insert(d.rows.length, [`- ${p.name} h${k}`, m]);
  await holdsWrite(ctx, h, p, APPEND_FILE, after, false);
  await noteWrite(ctx, markers, i, APPEND_FILE, before, after, true);
  return `${APPEND_FILE} ${m}`;
}

async function opEolRewrite(o: OpCtx): Promise<string> {
  const { ctx, h, markers, i, k, params } = o;
  const p = holdsPeer(ctx, i);
  const explicit = str(params, 'path');
  if (explicit !== undefined && lockedOn(h, i, explicit)) return o.skip('locked');
  const targets = explicit !== undefined ? [explicit]
    : rotate(h, [CRLF_FILE, SHARED_FILE, BIG_FILE, UNICODE_FILE, KO_FILE, ...listOf(h.own, p.name).filter((f) => !excludedTarget(h, i, p.name, f))]).filter((f) => !lockedOn(h, i, f));
  for (const path of targets) {
    const before = await readOrNull(p, path);
    if (before === null || isBinary(before)) continue;
    const d = new Doc(before, checkoutEol(p));
    let row = num(params, 'row') ?? -1;
    let base = `${p.name} rewrote`;
    if (row < 0) {
      if (path === CRLF_FILE || path === UNICODE_FILE) {
        base = latin1(`${path === CRLF_FILE ? 'crlf' : 'caf\u{e9}'} row ${pad(crlfRow(i))}`);
        row = d.findRow(base);
      } else if (path === KO_FILE) {
        base = `row ${crlfRow(i) + 1} ${HANGUL_CP949.toString('latin1')}`;
        row = d.findRow(`row ${crlfRow(i) + 1}`);
      } else if (path === SHARED_FILE) {
        const j = BAND_EDIT_FIRST + randomInt(h.params, BAND_EDIT_LAST - BAND_EDIT_FIRST + 1);
        base = `shared band ${i} row ${j} (${pad(i * BAND_ROWS + j)})`;
        row = d.findRow(base);
      } else if (path === BIG_FILE) {
        base = `# big ${i}`;
        row = d.findRow(base);
        if (row < 0 && bigRow(i) < d.rows.length && rowMarkers(d.text(bigRow(i))).length === 0) row = bigRow(i);
      } else {
        row = d.rows.length === 0 ? -1 : randomInt(h.params, d.rows.length);
      }
    }
    if (row < 0 || row >= d.rows.length || (explicit === undefined && !ownRow(d.text(row), p.name))) continue;
    const m = markers.mint(p.name);
    const flipped: Eol = d.eol === '\r\n' ? '\n' : '\r\n';
    const newText = `${base} ${p.name} h${k} ${m}`;
    const after = d.render((t, x) => (x === row ? newText : t), flipped);
    await holdsWrite(ctx, h, p, path, after, false);
    await noteWrite(ctx, markers, i, path, before, after, true);
    return `${path} row=${row} eol=${eolName(flipped)} ${m}`;
  }
  return o.skip('no eol target');
}

async function opDeleteOwn(o: OpCtx): Promise<string> {
  const { ctx, h, markers, i, params } = o;
  const p = holdsPeer(ctx, i);
  const explicit = str(params, 'path');
  if (explicit !== undefined && lockedOn(h, i, explicit)) return o.skip('locked');
  const own = listOf(h.own, p.name);
  const files = explicit !== undefined ? [explicit] : rotate(h, own.filter((f) => !excludedTarget(h, i, p.name, f)).sort());
  for (const path of files) {
    const before = await readOrNull(p, path);
    if (before === null) continue;
    // Only a file all of whose markers this peer authored (no peer-provenance line is deleted by accident, HLD-30 (b)).
    if (explicit === undefined && !findMarkers(before).every((m) => authorOf(m) === p.name)) continue;
    const abs = absPath(p, path);
    await retryTransientHolder(() => rm(abs, { force: true }));
    const t = vclockOf(ctx, p).wallMs() / 1_000;
    await retryTransientHolder(() => utimes(dirname(abs), t, t));
    const at = own.indexOf(path);
    if (at >= 0) own.splice(at, 1);
    await noteWrite(ctx, markers, i, path, before, null, true);
    return path;
  }
  return o.skip('no own file of this peer only');
}

async function opTempOrSecret(o: OpCtx, kind: 'temp_file' | 'secret_name'): Promise<string> {
  const { ctx, h, markers, i, k } = o;
  const p = holdsPeer(ctx, i);
  const n = (h.made.get(p.name) ?? 0) + 1;
  h.made.set(p.name, n);
  const names = kind === 'temp_file'
    ? [`${p.name}-${n}.txt~`, `.#${p.name}-${n}.txt`, `${p.name}-${n}.txt.swp`]
    : [`${p.name}-${n}.pem`, `.env.${p.name}-${n}`, `id_rsa_${p.name}_${n}`];
  const path = `${OWN_DIR}/${names[randomInt(h.params, names.length)] as string}`;
  const eol = checkoutEol(p);
  const m = markers.mint(p.name);
  const bytes = Buffer.from(`${kind === 'temp_file' ? 'scratch' : 'not a real key'} h${k}${eol}${m}${eol}`, 'utf8');
  await holdsWrite(ctx, h, p, path, bytes, true);
  await noteWrite(ctx, markers, i, path, null, bytes, true, false);   // NOT_ADMITTED, no record: exempt (R3-48)
  return `${path} ${m}`;
}

async function opEditPeerLine(o: OpCtx): Promise<string> {
  const { ctx, h, markers, i, k, params } = o;
  const p = holdsPeer(ctx, i);
  const explicit = str(params, 'path');
  if (explicit !== undefined && lockedOn(h, i, explicit)) return o.skip('locked');
  const a = await aEntries(ctx, i);
  if (a === null) return o.skip('no engine');
  const want = str(params, 'marker');
  const paths = explicit !== undefined ? [explicit]
    : rotate(h, [...a.entries()].filter(([path, e]) => (e.mode === '100644' || e.mode === '100755') && !excludedTarget(h, i, p.name, path)).map(([path]) => path).sort());
  for (const path of paths) {
    const ent = a.get(path);
    if (ent === undefined) continue;
    const disk = await readOrNull(p, path);
    if (disk === null || disk.length > RING_MAX_BYTES || isBinary(disk)) continue;
    const inA = new Set(findMarkers(await readBlob(ctx.git, p.dir, ent.oid)));
    const d = new Doc(disk, checkoutEol(p));
    for (let r = 0; r < d.rows.length; r++) {
      const ms = rowMarkers(d.text(r));
      const target = want !== undefined ? (ms.includes(want) ? want : undefined) : ms.find((x) => authorOf(x) !== p.name && inA.has(x));
      if (target === undefined) continue;
      const text = d.text(r);
      const first = text.indexOf(ms[0] as string);
      const m = markers.mint(p.name);
      // HLD-27: the text before the row's first marker gets `-x<k>`, its markers stay, a fresh marker is suffixed (informed).
      const after = d.replace(r, `${text.slice(0, first).replace(/ +$/, '')}-x${k} ${text.slice(first)} ${m}`);
      await holdsWrite(ctx, h, p, path, after, false);
      await noteWrite(ctx, markers, i, path, disk, after, true);
      return `${path} row=${r} of=${target} ${m}`;
    }
  }
  return o.skip('no teammate line in A');
}

async function opStale(o: OpCtx, kind: 'stale_save' | 'rewind'): Promise<string> {
  const { ctx, h, markers, i, k, params } = o;
  const p = holdsPeer(ctx, i);
  const explicit = str(params, 'path');
  if (explicit !== undefined && lockedOn(h, i, explicit)) return o.skip('locked');
  const paths = explicit !== undefined ? [explicit] : rotate(h, ringPaths(h, i, p.name));
  let withBuffer = 0;
  for (const path of paths) {
    const current = await readOrNull(p, path);
    if (current === null || isBinary(current)) continue;
    const buffers = await staleBuffers(ctx, h, i, path, current, params['buffer']);
    if (buffers.length > 0) withBuffer++;
    for (const { b } of buffers) {
      const bd = new Doc(b, checkoutEol(p));
      const at = kind === 'rewind' ? bd.rows.length : (num(params, 'row') ?? insertionRow(bd, new Doc(current, checkoutEol(p))));
      if (at === null) continue;   // no row ≥ 2 rows from every row that differs
      const m = markers.mint(p.name);
      // rewind (F-ED-5): B exactly, plus one row at its end; stale_save: B plus one own row
      const after = bd.insert(at, [kind === 'rewind' ? `# rewind ${m}` : `x${k} ${m}`]);
      const variant = str(params, 'variant') ?? 'plain';
      if (kind === 'stale_save' && variant === 'hot_exit') {
        // F-ED-2's VS Code hot-exit restore: B first, then B plus the row one virtual second later.
        await holdsWrite(ctx, h, p, path, b, false);
        vclockOf(ctx, p).advance(1_000);
      }
      await holdsWrite(ctx, h, p, path, after, false);
      await noteWrite(ctx, markers, i, path, current, after, false);   // stale: never informed
      return `${path} at=${at}${kind === 'stale_save' ? ` variant=${variant}` : ''} ${m}`;
    }
  }
  return o.skip(`no eligible earlier buffer (paths=${paths.length} with_buffer=${withBuffer})`);
}

async function opFormatter(o: OpCtx): Promise<string> {
  const { ctx, h, markers, i, params } = o;
  const p = holdsPeer(ctx, i);
  const glob = str(params, 'glob') ?? FMT_GLOB;
  const files = (await listFiles(p)).filter((path) => wildmatch(glob, path) && !excludedTarget(h, i, p.name, path));
  if (files.length === 0) return o.skip(`nothing matches ${glob}`);
  for (const path of files) {
    const before = await readOrNull(p, path);
    if (before === null || isBinary(before)) continue;
    const d = new Doc(before, checkoutEol(p));
    const m = markers.mint(p.name);
    const reindented = new Doc(d.render((t) => (t.startsWith('    ') ? `  ${t.slice(4)}` : t), d.eol), d.eol);
    const after = reindented.insert(reindented.rows.length, [`# formatted ${m}`]);
    await holdsWrite(ctx, h, p, path, after, false);
    await noteWrite(ctx, markers, i, path, before, after, true);
  }
  return `${files.length} files glob=${glob}`;
}

async function opCollideIgnored(o: OpCtx): Promise<string> {
  const { ctx, h, markers, i, k, params } = o;
  if (ctx.peers.length < 2) return o.skip('one peer');
  const x = holdsPeer(ctx, i);
  const yi = num(params, 'other') ?? (i + 1) % ctx.peers.length;
  const y = holdsPeer(ctx, yi);
  const name = str(params, 'name') ?? `c${k}.cfg`;
  const path = `local/${name}`;
  if (lockedOn(h, i, path) || lockedOn(h, yi, path)) return o.skip('locked');
  if ((await readOrNull(x, path)) !== null || (await readOrNull(y, path)) !== null) return o.skip(`${path} exists`);
  const exclude = join(x.dir, '.git', 'info', 'exclude');
  await mkdir(dirname(exclude), { recursive: true });
  await appendFile(exclude, `${path}\n`);
  excludedOf(h, x.name).add(path);
  const mx = markers.mint(x.name);
  const ex = checkoutEol(x);
  const bx = Buffer.from([`${x.name} local 1 h${k}`, `${x.name} local 2 h${k}`, `${x.name} local 3 h${k}`, mx].map((r) => `${r}${ex}`).join(''), 'utf8');
  await holdsWrite(ctx, h, x, path, bx, true);
  await noteWrite(ctx, markers, i, path, null, bx, true, false);   // locally excluded: exempt (R3-48)
  const my = markers.mint(y.name);
  const ey = checkoutEol(y);
  const by = Buffer.from([`${y.name} other 1 h${k}`, `${y.name} other 2 h${k}`, `${y.name} other 3 h${k}`, my].map((r) => `${r}${ey}`).join(''), 'utf8');
  await holdsWrite(ctx, h, y, path, by, true);
  await noteWrite(ctx, markers, yi, path, null, by, true);
  return `${path} excluded_by=${x.name} other=${y.name} ${mx} ${my}`;
}

async function opNonportable(o: OpCtx): Promise<string> {
  const { ctx, h, markers, i, params } = o;
  const p = holdsPeer(ctx, i);
  if (bool(params, 'fix') === true) return opNonportableFix(o);
  const k = ++h.npK;
  // `host` (test-only) names the host platform the op assumes; default process.platform.
  const names = hostNames(p.opts.platform, (str(params, 'host') as NodeJS.Platform | undefined) ?? process.platform, k);
  const given = str(params, 'name');
  if (given === undefined && names.length === 0) return o.skip('no host name');
  const bad = given ?? (rotate(h, names)[0] as string);
  const ok = `np/ok-p${i}-${k}.txt`;
  if (lockedOn(h, i, bad) || lockedOn(h, i, ok)) return o.skip('locked');
  if ((await readOrNull(p, bad)) !== null) return o.skip(`${bad} exists`);
  const eol = checkoutEol(p);
  const write = async (path: string, label: string): Promise<string> => {
    const m = markers.mint(p.name);
    const bytes = Buffer.from([`${label} 1 k${k}`, `${label} 2 k${k}`, `${label} 3 k${k}`, m].map((r) => `${r}${eol}`).join(''), 'utf8');
    await holdsWrite(ctx, h, p, path, bytes, true);
    // A name no record can carry (not stageable(), R3-53) is no synced path: its marker is exempt until the fix moves it (R3-48).
    await noteWrite(ctx, markers, i, path, null, bytes, true, stageable(path));
    return m;
  };
  const mb = await write(bad, 'bad');
  const mo = await write(ok, 'ok');
  h.np.push({ peer: i, k, bad, ok, stageable: stageable(bad), done: false });
  return `${JSON.stringify(bad)} ${ok} stageable=${stageable(bad)} rule=${(portable(bad, new Set()) as { rule?: number }).rule ?? '-'} ${mb} ${mo}`;
}

async function opNonportableFix(o: OpCtx): Promise<string> {
  const { ctx, h, markers, i, params } = o;
  const p = holdsPeer(ctx, i);
  const name = str(params, 'name');
  const entry = h.np.find((e) => e.peer === i && !e.done && (name === undefined || e.bad === name));
  if (entry === undefined) return o.skip('no non-portable file to fix');
  if (lockedOn(h, i, entry.bad) || lockedOn(h, i, `np/fixed-${entry.k}.txt`)) return o.skip('locked');
  entry.done = true;
  const before = await readOrNull(p, entry.bad);
  if (before === null) return o.skip(`${JSON.stringify(entry.bad)} is gone`);
  if (entry.stageable) {
    // "unless the record ended": a recorded name whose portability record already ended (a --discard) is left as it is.
    const engine = realEngineOf(holdsEngine(ctx, i));
    const holds = engine === null ? [] : (await engine.inspect()).holds;
    if (!holds.some((r) => !isTerminal(r) && r.paths.includes(entry.bad) && r.guards.some((g) => g.name === 'portability'))) return o.skip('record ended');
  }
  const fixed = `np/fixed-${entry.k}.txt`;
  const from = absPath(p, entry.bad);
  const to = absPath(p, fixed);
  await mkdir(dirname(to), { recursive: true });
  await retryTransientHolder(() => rename(from, to));
  const t = vclockOf(ctx, p).wallMs() / 1_000;
  for (const f of [to, dirname(to), dirname(from)]) await retryTransientHolder(() => utimes(f, t, t)).catch(() => undefined);
  // The reference model moves the marker (it does not retire it): on the synced name it is an obligation again.
  const ms = findMarkers(before);
  markers.noteEdit(p.name, fixed, ms, [], true, () => true);
  markers.noteEdit(p.name, entry.bad, [], ms, true, () => true, entry.stageable);
  return `${JSON.stringify(entry.bad)} -> ${fixed}`;
}

async function opWriteDuringApply(o: OpCtx): Promise<string> {
  const { ctx, h, markers, i, k, params } = o;
  const p = holdsPeer(ctx, i);
  const sim = holdsEngine(ctx, i);
  const explicit = str(params, 'path');
  if (explicit !== undefined && lockedOn(h, i, explicit)) return o.skip('locked');
  const a = await aEntries(ctx, i);
  if (a === null) return o.skip('no engine');
  const tip = await remoteTipTree(ctx);
  if (tip === null) return o.skip('no remote tip');
  const candidates = explicit !== undefined ? [explicit]
    : [...a.entries()].filter(([path, e]) => (e.mode === '100644' || e.mode === '100755') && tip.has(path) && tip.get(path)?.oid !== e.oid && !excludedTarget(h, i, p.name, path)).map(([path]) => path).sort();
  let path: string | undefined;
  let pre: Buffer | null = null;
  for (const c of candidates) {
    const b = await readOrNull(p, c);
    if (b === null || isBinary(b)) continue;
    path = c;
    pre = b;
    break;
  }
  if (path === undefined || pre === null) return o.skip('no modified text path');
  const variant = str(params, 'variant') ?? 'target';
  const target = absPath(p, path);
  const m = markers.mint(p.name);
  const sched = ctx.scheduler;
  const prev = sched.onYield;
  let fired: string | null = null;
  const before = pre;
  sched.onYield = async (name: string): Promise<void> => {
    if (fired === null && name === 'apply.beforePhase2' && (await lstat(target).catch(() => null)) === null) {
      if (variant === 'old_handle') {
        // The editor wrote through its old handle: the newest tmp/*.old holding the pre-step bytes gets the row (ENG-35).
        const tmp = join(p.dir, '.git', 'cowork', 'tmp');
        const olds = (await readdir(tmp).catch(() => [] as string[])).filter((f) => f.endsWith('.old'));
        const stamped = await Promise.all(olds.map(async (f) => ({ f, st: await lstat(join(tmp, f)).catch(() => null) })));
        stamped.sort((x, y) => (Number(y.st?.mtimeMs ?? 0) - Number(x.st?.mtimeMs ?? 0)) || (x.f < y.f ? 1 : -1));
        for (const { f } of stamped) {
          const bytes = await readFile(join(tmp, f)).catch(() => null);
          if (bytes === null || !bytes.equals(before)) continue;
          await appendFile(join(tmp, f), Buffer.from(new Doc(bytes, checkoutEol(p)).insert(Number.MAX_SAFE_INTEGER, [`x-late-${k} ${m}`]).subarray(bytes.length)));
          fired = `old=${f}`;
          break;
        }
      } else {
        await writeFile(target, new Doc(before, checkoutEol(p)).insert(Number.MAX_SAFE_INTEGER, [`x-dur-${k} ${m}`]));
        const t = vclockOf(ctx, p).wallMs() / 1_000;
        await utimes(target, t, t);
        fired = 'target';
      }
    }
    if (prev !== null) await prev(name);
  };
  try {
    await sim.step(ctx);
  } finally {
    sched.onYield = prev;
  }
  if (fired === null) return `${o.skip('no apply')} ${path}`;   // the minted marker was never written
  markers.noteEdit(p.name, path, [m], [], true, () => false);
  if (variant === 'old_handle') markers.noteLateWrite(m);
  return `${path} variant=${variant} ${fired} ${m}`;
}

async function opLock(o: OpCtx, mode: LockMode): Promise<string> {
  const { ctx, h, i, params } = o;
  const p = holdsPeer(ctx, i);
  if (h.locks.has(i)) return o.skip('already holds a lock');
  const explicit = str(params, 'path');
  let path = explicit;
  if (path === undefined) {
    const a = await aEntries(ctx, i);
    if (a === null) return o.skip('no engine');
    for (const c of rotate(h, [...a.entries()].filter(([q, e]) => (e.mode === '100644' || e.mode === '100755') && !excludedTarget(h, i, p.name, q)).map(([q]) => q).sort())) {
      const b = await readOrNull(p, c);
      if (b !== null && !isBinary(b)) {
        path = c;
        break;
      }
    }
  }
  if (path === undefined) return o.skip('no tracked text path');
  // Host separators under the engine's own work-tree root, so the stage copy <gitdir>/cowork/tmp/stage/<p> never matches.
  const abs = join(realpathSync.native(p.dir), ...path.split('/'));
  const release = faultFsOf(holdsEngine(ctx, i)).holdLock(abs, mode);
  h.locks.set(i, { path, mode, sinceMono: vclockOf(ctx, p).monoMs(), release });
  return `${path} mode=${mode}`;
}

async function opUnlock(o: OpCtx): Promise<string> {
  const { ctx, h, i, params } = o;
  if (bool(params, 'all') === true) {
    const out: string[] = [];
    for (const j of [...h.locks.keys()].sort((x, y) => x - y)) {
      const l = h.locks.get(j) as HeldLock;
      l.release();
      h.locks.delete(j);
      out.push(`p${j}:${l.path}`);
    }
    return out.length === 0 ? 'no lock held' : `released ${out.join(' ')}`;
  }
  const l = h.locks.get(i);
  const want = str(params, 'path');
  if (l === undefined || (want !== undefined && l.path !== want)) return o.skip('no lock held');
  l.release();
  h.locks.delete(i);
  return `${l.path} held_ms=${vclockOf(ctx, holdsPeer(ctx, i)).monoMs() - l.sinceMono}`;
}

/** resolve's record priority: revert, collision, generated?, portability, OFF_DISK PARKED or CONFLICTED, any other; oldest ULID first. */
function resolveRank(r: HoldRecord): number {
  const has = (g: string): boolean => r.guards.some((x) => x.name === g || x.name.startsWith(`${g}:`));
  if (has('revert')) return 0;
  if (has('collision')) return 1;
  if (has('generated?')) return 2;
  if (has('portability')) return 3;
  if (r.residence === 'OFF_DISK' && (r.state === 'PARKED' || r.state === 'CONFLICTED')) return 4;
  return 5;
}

/** Draws a verb by weights from the params stream. */
function pickVerb(h: HoldsRunState, table: ReadonlyArray<readonly [ResolveVerbName, number]>): ResolveVerbName {
  const total = table.reduce((s, [, w]) => s + w, 0);
  let x = randomInt(h.params, total);
  for (const [v, w] of table) {
    if (x < w) return v;
    x -= w;
  }
  return table[0]![0];
}
type ResolveVerbName = 'publish' | 'discard' | 'park' | 'restore';

/** The verb for record r (Task 13 Notes, `resolve`). */
function verbFor(h: HoldsRunState, r: HoldRecord): ResolveVerbName {
  const has = (g: string): boolean => r.guards.some((x) => x.name === g || x.name.startsWith(`${g}:`));
  if (has('collision')) return pickVerb(h, [['publish', 1], ['discard', 1]]);
  if (has('generated?')) return 'discard';
  if (r.residence === 'ON_DISK' && has('revert')) return pickVerb(h, [['publish', 4], ['discard', 3], ['park', 3]]);
  if (has('markers')) return 'park';
  if (r.residence === 'OFF_DISK') return pickVerb(h, [['restore', 3], ['discard', 2]]);
  if (has('portability')) return pickVerb(h, [['discard', 9], ['publish', 1]]);
  return 'publish';
}

async function opResolve(o: OpCtx): Promise<string> {
  const { ctx, h, markers, i, params } = o;
  const p = holdsPeer(ctx, i);
  const engine = realEngineOf(holdsEngine(ctx, i));
  if (engine === null) return o.skip('no engine');
  const records = (await engine.inspect()).holds.filter((r) => !isTerminal(r));
  const id = str(params, 'id');
  const r = id !== undefined ? records.find((x) => x.id === id) : [...records].sort((x, y) => resolveRank(x) - resolveRank(y) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))[0];
  if (r === undefined) return o.skip(id === undefined ? 'no own record' : `no non-terminal record ${id}`);
  const verb = (str(params, 'verb') as ResolveVerbName | undefined) ?? verbFor(h, r);
  // The record at its current rev, as the registry holds it (its held side for the model).
  const rec = (await readRegistry(ctx.git, p.dir, 'main')).records.get(r.id) ?? r;
  const res = await engine.resolve(r.id, verb, { humanEvidence: true, actor: 'human' });
  const head = `resolve ${r.id} --${verb} →`;
  if (res.kind === 'refused') return `${head} refused ${res.code}`;
  if (res.kind === 'locked') return `${head} locked ${res.paths.join(',')}`;
  if (res.kind === 'claude_refused') return `${head} claude_refused ${res.reason}`;
  // G2 #5/#7: a --publish that re-based an ON_DISK record on the disk (CONFLICTED, or a marker-bearing held side) published (A, S_disk),
  // its new pair: the model takes the sides the record holds after the verb when they changed (an ordinary release keeps them).
  const after = verb === 'publish' && res.code === 'RESOLVED_PUBLISH' ? (await readRegistry(ctx.git, p.dir, 'main')).records.get(r.id) : undefined;
  const now = after !== undefined && after.rev > rec.rev && JSON.stringify(after.blobs) !== JSON.stringify(rec.blobs) ? after : rec;
  const sides = 'h1' in now.blobs ? { from: now.blobs.h0, to: now.blobs.h1 } : { from: now.blobs.s1, to: now.blobs.s2 };
  const markersOf = async (oid: string | undefined): Promise<string[]> => (oid === undefined || oid === 'ABSENT' ? [] : findMarkers(await readBlob(ctx.git, p.dir, oid as Oid)));
  if (verb === 'publish' && res.code !== 'HOLD_ALREADY_RESOLVED') {
    // The human published the held change: its re-adds and its removals become informed edits.
    for (const path of rec.paths) {
      const held = await markersOf(sides.to[path]);
      const base = await markersOf(sides.from[path]);
      markers.noteEdit(p.name, path, minus(held, base), minus(base, held), true, () => true);
    }
  } else if (verb === 'discard' && res.code === 'RESOLVED_DISCARD') {
    const gone: string[] = [];
    for (const path of rec.paths) gone.push(...minus(await markersOf(sides.to[path]), await markersOf(sides.from[path])));
    markers.noteDiscard(r.id, gone);
  }
  return `${head} done ${res.code}`;
}

async function opResume(o: OpCtx): Promise<string> {
  const { ctx, i, params } = o;
  if (bool(params, 'mass') === true) {
    // Step 58's forced cleanup: every peer whose engine is frozen MASS.
    const out: string[] = [];
    for (let j = 0; j < ctx.peers.length; j++) {
      const engine = realEngineOf(holdsEngine(ctx, j));
      if (engine === null || !(await engine.inspect()).freeze.includes('MASS')) continue;
      out.push(`p${j} ${JSON.stringify(await engine.resume())}`);
    }
    return out.length === 0 ? 'no MASS' : out.join('; ');
  }
  const engine = realEngineOf(holdsEngine(ctx, i));
  if (engine === null) return o.skip('no engine');
  return JSON.stringify(await engine.resume());
}

async function opGcPrune(o: OpCtx): Promise<string> {
  const p = holdsPeer(o.ctx, o.i);
  const r = await o.ctx.git.run(['gc', '--prune=now', '--quiet'], { class: 'local', cwd: p.dir });
  return `rc=${r.code}`;
}

async function teamOf(ctx: SimContext, h: HoldsRunState): Promise<TeamWriter> {
  h.team ??= await createTeamWriter(ctx, seededRandom(`${ctx.seed}/team`));
  return h.team;
}

/** form/flip.txt as the remote TIP holds it (stored form). */
async function tipBytes(ctx: SimContext, path: string): Promise<Buffer | null> {
  const tip = await remoteTipTree(ctx);
  const e = tip?.get(path);
  return e === undefined ? null : readBlob(ctx.git, ctx.remote.dir, e.oid);
}

async function opNonconforming(o: OpCtx): Promise<string> {
  const { ctx, h, markers, params } = o;
  if (await remotePartitioned(ctx)) return o.skip('remote partitioned');
  // The writer pushes onto the board only (teamPush): a draw before genesis landed — no peer started yet, or its first push killed — is
  // skipped (Plan 3 Task 16: meas-holds-54 threw at step 1).
  const board = await ctx.git.run(['rev-parse', '--verify', '--quiet', `${refNames('main', RELEASE_NAMESPACE).remoteBoard}^{commit}`], { class: 'local', cwd: ctx.remote.dir });
  if (board.code !== 0) return o.skip('no board on the remote yet');
  const variant = str(params, 'variant') ?? 'plain';
  const p0 = ctx.peers[0];
  const wallMs = p0 === undefined ? 0 : vclockOf(ctx, p0).wallMs();
  const lf = (rows: readonly string[]): Buffer => Buffer.from(rows.map((r) => `${r}\n`).join(''), 'utf8');
  const changes: Record<string, Buffer | null> = {};
  const notes: Array<{ path: string; added: string[]; removed: string[] }> = [];
  let detail: string;
  if (variant === 'bad_name') {
    const k = ++h.teamK;
    const name = str(params, 'name') ?? (['con.py', 'a:b.txt', 'trail.'][randomInt(h.params, 3)] as string);
    const bad = `np/team-${k}/${name}`;
    const ok = `np/team-${k}/ok.txt`;
    const mb = markers.mint('team');
    const mo = markers.mint('team');
    changes[bad] = lf([`team bad 1 k${k}`, `team bad 2 k${k}`, `team bad 3 k${k}`, mb]);
    changes[ok] = lf([`team ok 1 k${k}`, `team ok 2 k${k}`, `team ok 3 k${k}`, mo]);
    h.teamBad = { k, path: bad, fixed: `np/team-${k}/fixed.txt`, bytes: changes[bad] as Buffer };
    notes.push({ path: bad, added: [mb], removed: [] }, { path: ok, added: [mo], removed: [] });
    detail = `${JSON.stringify(bad)} ${ok} ${mb} ${mo}`;
  } else if (variant === 'bad_name_fix') {
    const bad = h.teamBad;
    if (bad === null) return o.skip('no bad name to fix');
    h.teamBad = null;
    changes[bad.path] = null;
    changes[bad.fixed] = bad.bytes;
    const ms = findMarkers(bad.bytes);
    notes.push({ path: bad.fixed, added: ms, removed: [] }, { path: bad.path, added: [], removed: ms });
    detail = `${JSON.stringify(bad.path)} -> ${bad.fixed}`;
  } else if (variant === 'form_flip' || variant === 'form_fix') {
    const cur = await tipBytes(ctx, FORM_FILE);
    if (cur === null) return o.skip(`no ${FORM_FILE} in TIP`);
    const m = markers.mint('team');
    const rows = new Doc(cur, '\n').texts();
    // form_flip: CRLF endings plus one marker row (a stored-form violation, I-DAT-13); form_fix: LF endings plus a second marker row.
    const eol = variant === 'form_flip' ? '\r\n' : '\n';
    changes[FORM_FILE] = Buffer.from([...rows, m].map((r) => `${r}${eol}`).join(''), 'latin1');
    notes.push({ path: FORM_FILE, added: [m], removed: [] });
    detail = `${FORM_FILE} eol=${eolName(eol)} ${m}`;
  } else if (variant === 'plain') {
    const paths = strs(params, 'paths') ?? [];
    if (paths.length === 0) return o.skip('no paths');
    const ms: string[] = [];
    for (const path of paths) {
      const m = markers.mint('team');
      ms.push(m);
      changes[path] = lf([`team ${path} 1`, `team ${path} 2`, `team ${path} 3`, m]);
      notes.push({ path, added: [m], removed: [] });
    }
    detail = `${paths.join(' ')} ${ms.join(' ')}`;
  } else {
    throw new Error(`nonconforming_push: unknown variant ${variant}`);
  }
  const team = await teamOf(ctx, h);
  const csId = str(params, 'csId');
  const out = await teamPush(ctx.git, ctx.remote.url, refNames('main', RELEASE_NAMESPACE), team, changes, { ...(csId === undefined ? {} : { csId }), wallMs });
  for (const n of notes) markers.noteEdit('team', n.path, n.added, n.removed, true, () => true);
  return `${variant} ${detail} live=${out.live}`;
}

/**
 * A catalogue op as holdsOp and holdsGenerator build it: the SimOp plus the spec(s) it runs — one, or the several of step S−3's forced
 * fixes (fix round 1, finding 3: the generator's schedule is checkable from its draws without running them; the harness reads only
 * peer, kind and run).
 */
export interface HoldsSimOp extends SimOp { readonly specs: readonly HoldsOpSpec[]; }

/** One op of the catalogue with fixed parameters (holdsGenerator draws the same ops; params per kind: Task 13 Notes, "Ops"). */
export function holdsOp(spec: HoldsOpSpec, markers: MarkerModel): HoldsSimOp {
  const { kind } = spec;
  if (!(HOLDS_KINDS as readonly string[]).includes(kind)) throw new Error(`holdsOp: unknown kind ${String(kind)}`);
  const params: Params = spec.params ?? {};
  const all = bool(params, 'all') === true || bool(params, 'mass') === true;
  const peer = PEERLESS.has(kind) || all ? '*' : kind === 'nonconforming_push' ? 'team' : `p${spec.peer}`;
  return {
    peer, kind, specs: [spec],
    run: async (ctx: SimContext): Promise<string> => {
      const h = runStateOf(ctx);
      h.k += 1;
      const step = currentStep(ctx);
      await refreshRings(ctx, h, step - 1);
      const o: OpCtx = { ctx, h, markers, i: spec.peer, k: h.k, params, skip: (why) => `${kind} p${spec.peer} skipped (${why})` };
      const detail = await runOp(o, kind);
      await refreshRings(ctx, h, step);
      return detail;
    },
  };
}

async function runOp(o: OpCtx, kind: HoldsEditKind | HoldsFaultKind): Promise<string> {
  const { ctx, params, i } = o;
  switch (kind) {
    case 'new_file': return opNewFile(o);
    case 'edit_own': return opEditOwn(o);
    case 'edit_band': return opEditBand(o);
    case 'edit_same_line': return opEditSameLine(o);
    case 'append_md': return opAppendMd(o);
    case 'eol_rewrite': return opEolRewrite(o);
    case 'delete_own': return opDeleteOwn(o);
    case 'temp_file':
    case 'secret_name': return opTempOrSecret(o, kind);
    case 'edit_peer_line': return opEditPeerLine(o);
    case 'stale_save':
    case 'rewind': return opStale(o, kind);
    case 'formatter': return opFormatter(o);
    case 'collide_ignored': return opCollideIgnored(o);
    case 'nonportable_name': return opNonportable(o);
    case 'write_during_apply': return opWriteDuringApply(o);
    case 'lock_share_read': return opLock(o, 'share-read');
    case 'lock_share_none': return opLock(o, 'share-none');
    case 'unlock': return opUnlock(o);
    case 'age_24h':
      advanceClocks(ctx, AGE_24H_MS);
      return `ms=${AGE_24H_MS}`;
    case 'resolve': return opResolve(o);
    case 'resume': return opResume(o);
    case 'gc_prune': return opGcPrune(o);
    case 'nonconforming_push': return opNonconforming(o);
    // Plan 2's faults, built by the code editGenerator uses (weight 0 in `holds`; scripts reach them here).
    case 'partition': {
      const ms = num(params, 'ms') ?? PARTITION_MIN_MS;
      const sinceMono = nowMono(ctx);
      return `${(await partitionRemote(ctx, { sinceMono, plannedMs: ms })) ? 'remote renamed' : 'already partitioned'} planned_ms=${ms}`;
    }
    case 'heal': return healOp().run(ctx);
    case 'reject_transient': return armRejections(ctx, num(params, 'n') ?? 1, (str(params, 'kind') as RejectKind | undefined) ?? 'transient-failed');
    case 'race_push': return raceStep(ctx, holdsEngine(ctx, i), holdsEngine(ctx, num(params, 'other') ?? (i + 1) % ctx.peers.length));
  }
}

// ---- the generator ------------------------------------------------------------------------------------------------------

interface HoldsSched {
  init: boolean;
  formatter: { step: number; peer: number } | null;
  resumes: Array<{ step: number; peer: number }>;
  /** Peer index → the holder's virtual mono when its lock op was drawn (the locks still held). */
  readonly locks: Map<number, number>;
  /** Every peer that drew a lock op this seed (one lock per peer, two in all). */
  readonly locked: Set<number>;
  ageJumps: number;
  badName: boolean;
  formFlip: boolean;
  badNameFixAt: number | null;
  formFlipMono: number | null;
  npFixes: Array<{ step: number; peer: number }>;
}

function checkHoldsProfile(profile: GeneratorProfile): void {
  const bad = (v: number): boolean => !Number.isSafeInteger(v) || v < 0;
  if (bad(profile.engineWeight)) throw new RangeError(`holdsGenerator: engineWeight must be an integer >= 0, got ${profile.engineWeight}`);
  if (profile.steps !== undefined && (!Number.isSafeInteger(profile.steps) || profile.steps < 4)) throw new RangeError(`holdsGenerator: steps must be an integer >= 4, got ${profile.steps}`);
  for (const [k, v] of Object.entries(profile.weights)) {
    if (!(HOLDS_KINDS as readonly string[]).includes(k)) throw new RangeError(`holdsGenerator: unknown kind ${k}`);
    if (v !== undefined && bad(v)) throw new RangeError(`holdsGenerator: weight of ${k} must be an integer >= 0, got ${v}`);
  }
}

const monoOfPeer = (ctx: SimContext, i: number): number => {
  const p = ctx.peers[i];
  return p === undefined ? 0 : (ctx.clocks.get(p.name)?.monoMs() ?? 0);
};

/** A step that runs several scheduled ops (step S−3's forced fixes): the first one's kind, every detail in order. */
function composite(specs: readonly HoldsOpSpec[], markers: MarkerModel): HoldsSimOp {
  const ops = specs.map((s) => holdsOp(s, markers));
  const first = ops[0] as HoldsSimOp;
  if (ops.length === 1) return first;
  return {
    peer: first.peer, kind: first.kind, specs: [...specs],
    run: async (ctx) => {
      const out: string[] = [];
      for (const [x, op] of ops.entries()) out.push(`${(specs[x] as HoldsOpSpec).kind}: ${await op.run(ctx)}`);
      return out.join('; ');
    },
  };
}

/**
 * The `holds` generator (R3-47). next(ctx, step) is synchronous and draws only from ctx.random (it reads ctx.peers and the peers'
 * virtual mono clocks). Scheduled ops come first: one `formatter` at a step drawn uniformly in [10, 30] on a drawn peer and the
 * `resume` of that peer 3–8 steps later; `nonconforming_push` draws `bad_name` or `form_flip`, each at most once per seed, scheduling
 * `bad_name_fix` 5–15 steps after `bad_name` and `form_fix` at the first step at which p0's mono is ≥ 70,000 ms past `form_flip`;
 * `nonportable_name` schedules its fix 5–15 steps later. Then the weighted draw (engineWeight = an engine step): `lock_*` only at
 * steps < 40, at most one lock per peer and two in all per seed; `unlock` only for a lock held ≥ 60,000 ms of its holder's mono; `age_24h` at
 * most twice, from step 20; no nonconforming_push or nonportable_name from step S−3. Forced cleanup over the last three steps of the
 * profile's `steps` S (57–59 for 60): S−3 every pending fix, S−2 a `resume` of every peer frozen MASS, S−1 one `unlock` of every lock.
 */
export function holdsGenerator(profile: GeneratorProfile, markers: MarkerModel): OpGenerator {
  checkHoldsProfile(profile);
  const S = profile.steps ?? PROFILES.holds.steps;
  const scheds = new WeakMap<SimContext, HoldsSched>();
  const op = (kind: HoldsEditKind | HoldsFaultKind, peer: number, params?: Params): HoldsSimOp => holdsOp(params === undefined ? { kind, peer } : { kind, peer, params }, markers);
  return {
    next(ctx: SimContext, step: number): SimOp | null {
      if (ctx.peers.length > BANDS) throw new Error(`holdsGenerator: at most ${BANDS} peers (one band of shared.txt each), got ${ctx.peers.length}`);
      const r = ctx.random;
      const n = ctx.peers.length;
      let s = scheds.get(ctx);
      if (s === undefined) {
        s = { init: false, formatter: null, resumes: [], locks: new Map(), locked: new Set(), ageJumps: 0, badName: false, formFlip: false, badNameFixAt: null, formFlipMono: null, npFixes: [] };
        scheds.set(ctx, s);
      }
      if (!s.init) {
        s.init = true;
        const at = 10 + randomInt(r, 21);
        const peer = randomInt(r, n);
        const later = 3 + randomInt(r, 6);
        if (at < S - 3) {
          s.formatter = { step: at, peer };
          s.resumes.push({ step: at + later, peer });
        }
      }
      // ---- forced cleanup: the last three steps ----
      if (step === S - 3) {
        const fixes: HoldsOpSpec[] = [];
        if (s.badNameFixAt !== null) fixes.push({ kind: 'nonconforming_push', peer: 0, params: { variant: 'bad_name_fix' } });
        if (s.formFlipMono !== null) fixes.push({ kind: 'nonconforming_push', peer: 0, params: { variant: 'form_fix' } });
        for (const f of s.npFixes) fixes.push({ kind: 'nonportable_name', peer: f.peer, params: { fix: true } });
        s.badNameFixAt = null;
        s.formFlipMono = null;
        s.npFixes = [];
        if (fixes.length > 0) return composite(fixes, markers);
      }
      if (step === S - 2) {
        s.resumes = [];
        return op('resume', 0, { mass: true });
      }
      if (step === S - 1 && s.locks.size > 0) {
        s.locks.clear();
        return op('unlock', 0, { all: true });
      }
      // ---- scheduled ----
      if (step < S - 3) {
        if (s.formatter !== null && s.formatter.step === step) {
          const f = s.formatter;
          s.formatter = null;
          return op('formatter', f.peer);
        }
        const due = s.resumes.findIndex((x) => x.step <= step);
        if (due >= 0) {
          const [x] = s.resumes.splice(due, 1) as [{ step: number; peer: number }];
          return op('resume', x.peer);
        }
        if (s.badNameFixAt !== null && step >= s.badNameFixAt) {
          s.badNameFixAt = null;
          return op('nonconforming_push', 0, { variant: 'bad_name_fix' });
        }
        if (s.formFlipMono !== null && monoOfPeer(ctx, 0) >= s.formFlipMono + FORM_FIX_AFTER_MS) {
          s.formFlipMono = null;
          return op('nonconforming_push', 0, { variant: 'form_fix' });
        }
        const fix = s.npFixes.findIndex((x) => x.step <= step);
        if (fix >= 0) {
          const [x] = s.npFixes.splice(fix, 1) as [{ step: number; peer: number }];
          return op('nonportable_name', x.peer, { fix: true });
        }
      }
      // ---- weighted ----
      const st = s;
      const lockFree = Array.from({ length: n }, (_, x) => x).filter((x) => !st.locked.has(x));
      const unlockable = [...st.locks.entries()].filter(([x, since]) => monoOfPeer(ctx, x) - since >= LOCK_MIN_MS).map(([x]) => x).sort((a, b) => a - b);
      const eligible = (k: HoldsEditKind | HoldsFaultKind): boolean => {
        switch (k) {
          case 'lock_share_read':
          case 'lock_share_none': return step < LOCK_STEPS && st.locked.size < MAX_LOCKS && lockFree.length > 0;
          case 'unlock': return unlockable.length > 0;
          case 'age_24h': return step >= AGE_FROM_STEP && st.ageJumps < MAX_AGE_JUMPS;
          case 'nonconforming_push': return step < S - 3 && (!st.badName || !st.formFlip);
          case 'nonportable_name': return step < S - 3;
          case 'edit_same_line':
          case 'collide_ignored':
          case 'race_push': return n >= 2;
          default: return true;
        }
      };
      const kinds = HOLDS_KINDS.filter((k) => (profile.weights[k] ?? 0) > 0 && eligible(k));
      const total = kinds.reduce((sum, k) => sum + (profile.weights[k] ?? 0), profile.engineWeight);
      if (total === 0) return null;
      let x = randomInt(r, total);
      if (x < profile.engineWeight) return null;
      x -= profile.engineWeight;
      let kind: HoldsEditKind | HoldsFaultKind | null = null;
      for (const k of kinds) {
        const w = profile.weights[k] ?? 0;
        if (x < w) {
          kind = k;
          break;
        }
        x -= w;
      }
      if (kind === null) throw new Error('holdsGenerator: weighted draw out of range');
      switch (kind) {
        case 'age_24h':
          st.ageJumps++;
          return op(kind, 0);
        case 'nonconforming_push': {
          const avail = [...(st.badName ? [] : ['bad_name']), ...(st.formFlip ? [] : ['form_flip'])];
          const variant = avail[randomInt(r, avail.length)] as string;
          if (variant === 'bad_name') {
            st.badName = true;
            st.badNameFixAt = step + 5 + randomInt(r, 11);
          } else {
            st.formFlip = true;
            st.formFlipMono = monoOfPeer(ctx, 0);
          }
          return op(kind, 0, { variant });
        }
        case 'lock_share_read':
        case 'lock_share_none': {
          const peer = lockFree[randomInt(r, lockFree.length)] as number;
          st.locks.set(peer, monoOfPeer(ctx, peer));
          st.locked.add(peer);
          return op(kind, peer);
        }
        case 'unlock': {
          const peer = unlockable[randomInt(r, unlockable.length)] as number;
          st.locks.delete(peer);
          return op(kind, peer);
        }
        case 'nonportable_name': {
          const peer = randomInt(r, n);
          st.npFixes.push({ step: step + 5 + randomInt(r, 11), peer });
          return op(kind, peer);
        }
        default:
          return op(kind, randomInt(r, n));
      }
    },
  };
}

/** A generator that plays `steps` (one ScriptStep per harness step, then null = an engine step of a random peer). */
export function scriptedGenerator(steps: readonly ScriptStep[], markers: MarkerModel): OpGenerator {
  return {
    next(ctx: SimContext, step: number): SimOp | null {
      const s = steps[step];
      if (s === undefined) return null;
      if ('iterate' in s) {
        const i = s.iterate;
        return { peer: holdsPeer(ctx, i).name, kind: 'iterate', run: async (c) => { await holdsEngine(c, i).step(c); return 'step'; } };
      }
      if ('rounds' in s) {
        return {
          peer: '*', kind: 'rounds',
          run: async (c) => {
            const byName = [...c.engines].sort((a, b) => (a.peer.name < b.peer.name ? -1 : a.peer.name > b.peer.name ? 1 : 0));
            for (let x = 0; x < s.rounds; x++) {
              advanceClocks(c, ROUND_MS);
              for (const e of byName) await e.step(c);
              await c.scheduler.runUntilIdle(10_000);
            }
            return `n=${s.rounds}`;
          },
        };
      }
      if ('advance' in s) return { peer: '*', kind: 'advance', run: async (c) => { advanceClocks(c, s.advance); return `ms=${s.advance}`; } };
      return holdsOp(s, markers);
    },
  };
}

// ---- composition --------------------------------------------------------------------------------------------------------

export interface HoldsSetup { tuple: SeedTuple; factory: EngineFactory; options: SimOptions; markers: MarkerModel; }

/** A ResumeReport's JSON in an op-log detail lifted MASS (anything unreadable did not). */
function liftedMass(json: string): boolean {
  try {
    return (JSON.parse(json) as { massLifted?: unknown }).massLifted === true;
  } catch {
    return false;
  }
}

/**
 * EF2 fix round 1, F4: R3-47's budget of MASS resumes for `peer` in an op-log. credits: its `formatter` ops that ran (a skipped one
 * changed nothing) plus its kills after its first one (a peer killed after the formatter re-reads the batch after its restart and may
 * trip again); used: the `resume` rows that lifted MASS on it — its own scheduled resumes (detail `dt=… <ResumeReport>`), the quiescence
 * resumes (`quiescence <ResumeReport>`) and its entry of step S−2's forced cleanup (one row naming every peer, `pN <ResumeReport>; …`).
 * A resume that lifted nothing (the peer was not frozen yet) or was skipped (no engine) consumes no credit.
 */
export function massResumeAllowance(opLog: readonly OpLogEntry[], peer: string): { credits: number; used: number } {
  let credits = 0;
  let used = 0;
  let formatted = false;
  for (const e of opLog) {
    if (e.kind === 'formatter' && e.peer === peer && !e.detail.includes('skipped')) {
      formatted = true;
      credits++;
    } else if (e.kind === 'killed' && e.peer === peer && formatted) {
      credits++;
    } else if (e.kind === 'resume' && !e.detail.includes('skipped')) {
      const named = [...e.detail.matchAll(/(?:^|[ ;])(p\d+) (\{[^{}]*\})/g)];
      if (named.length > 0) used += named.filter((m) => m[1] === peer && liftedMass(m[2]!)).length;
      else if (e.peer === peer && liftedMass(/\{[^{}]*\}/.exec(e.detail)?.[0] ?? '')) used++;
    }
  }
  return { credits, used };
}

/**
 * EF2 D2 (R3-47's "one `formatter` op … followed by a scripted `resume`"; HLD-30/HLD-31: nothing auto-releases MASS, only a human
 * `/cowork resume`): SimOptions.beforeQuiescenceRound of the holds profile. A realEngine peer frozen MASS is resumed before the
 * quiescence round's engine steps, one op-log row `resume` per peer (detail `quiescence <ResumeReport>`). The generator's scheduled
 * resume and its step S−2 cleanup only reach a trip that already happened: a peer killed right after the formatter (the breaker never
 * ran) or restarted with the batch unobserved trips MASS in quiescence, and nothing in the run would ever lift it.
 * EF2 fix round 1, F4: only that resume — at most one per formatter op of the peer (or kill of it after one) that no resume has
 * consumed yet (massResumeAllowance). Any other MASS freeze at a quiescence round (an unattributed write tripping the breaker) is never
 * lifted silently: the run fails there with the returned text. The count of quiescence resumes is QuiescenceInfo.resumes.
 */
export async function resumeMassFrozen(ctx: SimContext, step: number): Promise<string | null> {
  for (let j = 0; j < ctx.peers.length; j++) {
    const engine = realEngineOf(holdsEngine(ctx, j));
    if (engine === null || !(await engine.inspect()).freeze.includes('MASS')) continue;
    const name = ctx.peers[j]!.name;
    const { credits, used } = massResumeAllowance(ctx.opLog, name);
    if (used >= credits) {
      return `${name} is frozen MASS at quiescence round ${step} and no formatter op is left to attribute the trip to (formatter ops of ${name} and kills of it after one: ${credits}; resumes that lifted MASS on it: ${used})`;
    }
    ctx.opLog.push({ step, peer: name, kind: 'resume', detail: `quiescence ${JSON.stringify(await engine.resume())}` });
  }
  return null;
}

/**
 * The only composer of the `holds` profile (run-seeds, run-shard and every holds SIM test call it; R3-47): 3 peers (p1
 * core.autocrlf=true, p2 EngineDeps.platform 'win32'), PROFILES.holds.steps steps (o.steps overrides; the generator's forced cleanup
 * runs over the last three of them), seedFilesPlan3, realEngine, the R-32 quiescence, a crash rate of 0.02 per step (0 for a
 * script), settled = holdTimersSettled, beforeQuiescenceRound = resumeMassFrozen (EF2 D2), and one MarkerModel for the run
 * (markerRun(seed)).
 */
export function holdsSetup(seed: string, o: {
  mutants?: ReadonlySet<MutantId>; weights?: GeneratorProfile['weights']; crashRate?: number; steps?: number; peers?: number;
  seedFiles?: Record<string, Buffer>; script?: readonly ScriptStep[];
} = {}): HoldsSetup {
  const markers = new MarkerModel(markerRun(seed));
  const steps = o.steps ?? PROFILES.holds.steps;
  const generator = o.script !== undefined
    ? scriptedGenerator(o.script, markers)
    : holdsGenerator({ ...PROFILES.holds, steps, weights: { ...PROFILES.holds.weights, ...o.weights } }, markers);
  const factory = realEngine(o.mutants === undefined ? {} : { mutants: o.mutants });
  return {
    tuple: { seed, peers: o.peers ?? 3, ops: steps },
    factory,
    markers,
    options: {
      generator,
      quiescence: DEFAULT_QUIESCENCE,
      seedFiles: o.seedFiles ?? seedFilesPlan3(seededRandom(`${seed}/files`)),
      peerProfile: HOLDS_PEER_PROFILE,
      crash: { rate: o.crashRate ?? (o.script !== undefined ? 0 : 0.02) },
      settled: holdTimersSettled,
      beforeQuiescenceRound: resumeMassFrozen,
    },
  };
}
