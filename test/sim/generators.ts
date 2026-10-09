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
import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomHex, randomInt, type Random } from '../../src/ports/random.js';
import { generateBigBomCrlf } from './fixtures/bigBomCrlf.js';
import {
  healDetail, healRemote, partitionPlan, partitionRemote, rejectsPending, retryTransientHolder, type OpGenerator, type SimContext, type SimEngine, type SimOp,
} from './harness.js';
import type { PeerClone } from './peers.js';
import type { RejectKind } from './remote.js';

export type EditKind = 'new_file' | 'edit_own' | 'edit_band' | 'edit_same_line' | 'append_md' | 'eol_rewrite' | 'delete_own' | 'temp_file' | 'secret_name';
export type FaultKind = 'partition' | 'heal' | 'reject_transient' | 'race_push';
export interface GeneratorProfile { readonly name: 'edits' | 'faults'; readonly engineWeight: number; readonly weights: Readonly<Partial<Record<EditKind | FaultKind, number>>>; }

export const EDIT_KINDS: readonly EditKind[] = Object.freeze(['new_file', 'edit_own', 'edit_band', 'edit_same_line', 'append_md', 'eol_rewrite', 'delete_own', 'temp_file', 'secret_name']);
export const FAULT_KINDS: readonly FaultKind[] = Object.freeze(['partition', 'heal', 'reject_transient', 'race_push']);
const ALL_KINDS: ReadonlyArray<EditKind | FaultKind> = [...EDIT_KINDS, ...FAULT_KINDS];

const EDIT_WEIGHTS: Readonly<Record<EditKind, number>> = Object.freeze({
  new_file: 4, edit_own: 3, edit_band: 4, edit_same_line: 1, append_md: 2, eol_rewrite: 1, delete_own: 1, temp_file: 1, secret_name: 1,
});
/** R-31: `edits` = human edits only (about half the steps are engine steps); `faults` adds partitions, transient rejections and lease races. */
export const PROFILES: Readonly<Record<'edits' | 'faults', GeneratorProfile>> = Object.freeze({
  edits: Object.freeze({ name: 'edits', engineWeight: 18, weights: EDIT_WEIGHTS }),
  faults: Object.freeze({ name: 'faults', engineWeight: 22, weights: Object.freeze({ ...EDIT_WEIGHTS, partition: 1, heal: 1, reject_transient: 1, race_push: 2 }) }),
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

async function readText(p: PeerClone, path: string): Promise<TextFile> {
  return parseText(await retryTransientHolder(() => readFile(absPath(p, path))), checkoutEol(p));
}

/** Replaces row `row` and writes the file in `eol` (null = its dominant ending). */
async function rewriteRow(ctx: SimContext, p: PeerClone, path: string, row: number | ((n: number) => number), text: string, eol: 'keep' | 'flip'): Promise<{ row: number; eol: Eol }> {
  const t = await readText(p, path);
  const r = typeof row === 'number' ? row : row(t.rows.length);
  if (r < 0 || r >= t.rows.length) throw new Error(`editGenerator: ${p.name}:${path} has ${t.rows.length} rows, no row ${r}`);
  t.rows[r] = text;
  const out: Eol = eol === 'keep' ? t.eol : t.eol === '\r\n' ? '\n' : '\r\n';
  await writeAt(ctx, p, path, renderText(t, out), false);
  return { row: r, eol: out };
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

function build(ctx: SimContext, st: GenState, k: EditKind | FaultKind): SimOp {
  const random = ctx.random;
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
      return { peer: p.name, kind: k, run: async (c) => { await writeAt(c, p, path, bytes, true); return `${path} rows=${count} eol=${eolName(eol)}`; } };
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
        run: async (c) => { const r = await rewriteRow(c, p, path, (n) => pick % n, `${p.name} edited ${tok}`, 'keep'); return `${path} row=${r.row}`; },
      };
    }
    case 'edit_band': {
      const i = randomInt(random, ctx.peers.length);
      const p = peerAt(ctx, i);
      const g = i * BAND_ROWS + BAND_EDIT_FIRST + randomInt(random, BAND_EDIT_LAST - BAND_EDIT_FIRST + 1);
      const tok = token(ctx);
      return {
        peer: p.name, kind: k,
        run: async (c) => { await rewriteRow(c, p, SHARED_FILE, g, `shared band ${i} row ${g % BAND_ROWS} (${pad(g)}) ${p.name} ${tok}`, 'keep'); return `${SHARED_FILE} row=${g}`; },
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
          await rewriteRow(c, pa, SAME_LINE_FILE, row, `note row ${row} ${pa.name} ${ta}`, 'keep');
          await rewriteRow(c, pb, SAME_LINE_FILE, row, `note row ${row} ${pb.name} ${tb}`, 'keep');
          return `${SAME_LINE_FILE} row=${row} peers=${pa.name},${pb.name}`;
        },
      };
    }
    case 'append_md': {
      const p = peerAt(ctx, randomInt(random, ctx.peers.length));
      const tok = token(ctx);
      return {
        peer: p.name, kind: k,
        run: async (c) => {
          const t = await readText(p, APPEND_FILE);
          t.rows.push(`- ${p.name} ${tok}`);
          t.final = true;
          await writeAt(c, p, APPEND_FILE, renderText(t, t.eol), false);
          return APPEND_FILE;
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
        run: async (c) => { const r = await rewriteRow(c, p, path, row, text, 'flip'); return `${path} row=${r.row} eol=${eolName(r.eol)}`; },
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
          await retryTransientHolder(() => rm(abs, { force: true }));
          const t = clockOf(c, p).wallMs() / 1_000;
          await retryTransientHolder(() => utimes(dirname(abs), t, t));
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
      const bytes = Buffer.from(`${k === 'temp_file' ? 'scratch' : 'not a real key'} ${tok}${checkoutEol(p)}`, 'utf8');
      return { peer: p.name, kind: k, run: async (c) => { await writeAt(c, p, path, bytes, true); return path; } };
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

/** Draws only from ctx.random; writes Buffers (node:fs, test code) in the file's dominant ending except eol_rewrite; sets every written file's mtime to the peer's virtual wall clock (utimes). */
export function editGenerator(profile: GeneratorProfile): OpGenerator {
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
        if (r < w) return build(ctx, st, k);
        r -= w;
      }
      throw new Error('editGenerator: weighted draw out of range');
    },
  };
}
