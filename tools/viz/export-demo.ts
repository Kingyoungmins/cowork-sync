// tools/viz/export-demo.ts (Plan 8a Task 16; 12 §3.9.3 "Producing a demo log", VIZ-27, INV-VIZ-DET; R-V19, R-V69; the owner's
// choice of 2026-10-08 for `live`): a board chain → one `cowork-viz-demo/1` log, read only through the viewer's own git facade
// (VizGit: rev-parse, rev-list and the batched cat-file readers, every argv on the viewer allowlist; the CLI's createExportGit
// adds one export-only form, rev-parse of a refs/cowork-ci/<run_id>/<enc(branch)>/board ref, 12 §3.9.3). A dev tool, never shipped.
//
//   node --import tsx tools/viz/export-demo.ts --git-dir <abs> --ref <board ref> [--captions <file>] [--oplog <file>] --out <file>
//   (<board ref>: refs/cowork-remote/<enc(branch)>/board of a peer's clone, or refs/cowork-ci/<run_id>/<enc(branch)>/board)
//
// One commit record per board commit from height 0: writer, protocol (height 0), cs and csPaths of the board commit, its ops.jsonl
// lines, held = its held/ names, and code = the named live commit's Cowork-Seat and Cowork-Base values (a board-only commit carries
// the previous ones), with `live` (the named live commit's oid) on every record whose code.changed is true. R-V19 keeps the demo's
// timeline byte-identical to the board's: a live read without a live step (not_commit, commit_too_large, unreadable, or a live
// commit liveShape refuses) is written `code {changed: false, seats: [], base: null}`, and a malformed board commit `writer null,
// ops [], cs [], csPaths {}, held []` with that code; a missing object throws (the CLI exits 1 and writes no file). Captions come
// only from --captions (hand-written caption records); --oplog only prints a SIM op-log beside the heights of each entry's peer's
// board commits (12 §1.5 item 8) and never adds a record. The written log is parsed back with parseDemoLog before it is returned.
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBoardReadFailure, readBoardCommits, READ_BATCH_MAX, type BoardRead, type BoardReadFailure } from '../../src/board/batchRead.js';
import { formatWriter, liveShape, parseWriter, type CsTrailer } from '../../src/board/boardCommit.js';
import { parseOpLine } from '../../src/board/ops.js';
import { readProtocol } from '../../src/board/protocol.js';
import { buildDaemonEnv } from '../../src/git/env.js';
import { parseOid, type Oid } from '../../src/git/oid.js';
import { GitCommandError } from '../../src/git/repo.js';
import type { GitRunner } from '../../src/git/runner.js';
import { realClock } from '../../src/ports/clock.js';
import { realFs } from '../../src/ports/fs.js';
import { sanitize } from '../../src/text/sanitize.js';
import { realOwnerProbe } from '../../src/viz/cli/ownerProbe.js';
import { excludedRoots, resolveGitPath } from '../../src/viz/cli/pathTrust.js';
import { DEMO_CAPTION_CODES } from '../../src/viz/i18n/codes.js';
import { parseDemoLog, serializeDemoLog, type DemoCaption, type DemoCommit, type DemoLog, type DemoRoomHeader } from '../../src/viz/source/demo.js';
import { BoardObjectMissingError } from '../../src/viz/source/git.js';
import { decodeEnc } from '../../src/viz/source/rooms.js';
import { createVizGit, VIZ_GIT_CONFIG, vizGitRunner, VizGitRefused, type VizGit } from '../../src/viz/source/vizGit.js';
import { vizGitArgvOk } from '../../src/viz/source/vizGitArgv.js';

const CAPTION_CODES: ReadonlySet<string> = new Set(DEMO_CAPTION_CODES);
const UNCHANGED = (): DemoCommit['code'] => ({ changed: false, seats: [], base: null });

/** A Cowork-CS trailer value in the form Plan 2 writes it (boardCommit.ts formatCs; parseCsTrailers reads it back). */
const csValue = (c: CsTrailer): string => `${c.csId} state=${c.state} seq=${c.seq} origin=${c.origin} checks=${c.checks} paths=${c.paths}`;

/** Thrown when the board cannot be exported (a ref that does not resolve, a chain that is not a board, a log that does not parse back). */
export class ExportDemoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportDemoError';
  }
}

// ---- the export's git: the viewer's VizGit plus one export-only ref form ---------------------------------------------------

/** A fetched board ref of a peer's clone (the viewer allowlist's <ref>), its <enc(branch)> captured. */
const REMOTE_BOARD_REF = /^refs\/cowork-remote\/([^/\s]+)\/board$/;
/**
 * A board ref of the test namespace, its <enc(branch)> captured (glossary §4: `refs/cowork-ci/<run_id>/` in place of
 * `refs/cowork/`; the run id as src/engine/refs.ts testNamespace takes it). 12 §3.9.3 lets export-demo read a SIM or CI run's
 * bare remote there. Export-only (Task 16 fix round 1 ruling): the viewer's allowlist (vizGitArgv.ts, L-VIZ-GIT) is unchanged,
 * and the string stays out of src/viz/** (a release bundle never contains refs/cowork-ci: 11-testing L-REFS, TC-TST-06).
 */
const CI_BOARD_REF = /^refs\/cowork-ci\/[0-9A-Za-z_-]{1,40}\/([^/\s]+)\/board$/;

/** The viewer allowlist (vizGitArgvOk) plus exactly one export-only form: `rev-parse --verify -q <a cowork-ci board ref>`. */
export function exportGitArgvOk(args: readonly string[]): boolean {
  if (vizGitArgvOk(args)) return true;
  return args.length === 4 && args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === '-q' && typeof args[3] === 'string' && CI_BOARD_REF.test(args[3]);
}

/**
 * The export CLI's git: createVizGit (every call checked by the viewer's vizGitArgvOk before it spawns), except revParse of a
 * cowork-ci board ref, which runs `rev-parse --verify -q <ref>` with VizGit's own call options (class local, cwd = the data
 * directory, the absolute git dir, VIZ_GIT_CONFIG) once exportGitArgvOk passes, exit 1 = no such ref. Every later call names
 * oids only, so the rest of the read is VizGit's unchanged.
 */
export function createExportGit(o: { runner: GitRunner; gitDir: string; dataDir: string }): VizGit {
  const viz = createVizGit(o);
  return {
    ...viz,
    async revParse(ref) {
      if (!CI_BOARD_REF.test(ref)) return viz.revParse(ref);
      const args = ['rev-parse', '--verify', '-q', ref];
      if (!exportGitArgvOk(args)) throw new VizGitRefused(args);
      const r = await o.runner.run(args, { class: 'local', cwd: o.dataDir, gitDir: o.gitDir, config: VIZ_GIT_CONFIG });
      if (r.code !== 0 && r.code !== 1) throw new GitCommandError(args, r.code, r.stderr);
      return r.code === 0 ? parseOid(r.stdout.toString('utf8')) : null;
    },
  };
}

/** Every board commit of the chain from height 0 with its live commit, read call after call (R-V69: prevLive carried across calls). */
async function readChain(git: VizGit, ref: string): Promise<Array<BoardRead | BoardReadFailure>> {
  const tip = await git.revParse(ref);
  if (tip === null) throw new ExportDemoError(`export-demo: ${ref} does not resolve`);
  // The first-parent chain of a board tip ends at the genesis live commit L0 (B0's only parent): height = count − 2.
  const height = (await git.chainCount(tip)) - 2;
  if (height < 0) throw new ExportDemoError(`export-demo: ${ref} names no board commit`);
  const listed = await git.chain(tip, 0, height + 1);
  if (listed.length !== height + 1) throw new ExportDemoError('export-demo: the first-parent chain is shorter than its count');
  const items = listed.reverse().map((oid, h) => ({ oid, height: h }));
  const reads: Array<BoardRead | BoardReadFailure> = [];
  let prevLive: Oid | null = null;
  while (reads.length < items.length) {
    const { reads: got, next } = await readBoardCommits(git, items.slice(reads.length, reads.length + READ_BATCH_MAX), { withLive: true, prevLive });
    if (next === 0) throw new ExportDemoError('export-demo: a batched read made no progress');
    for (const r of got) {
      reads.push(r);
      if (!isBoardReadFailure(r)) prevLive = r.liveCode;
    }
  }
  return reads;
}

/**
 * The commit records of the reads (R-V19), as the git room source folds them (source/git.ts stepOf): code.changed = the board
 * commit names another live commit than the last readable one; a live step's seats and base are carried by later board-only
 * commits; a live read failure carries none.
 */
function records(room: string, reads: ReadonlyArray<BoardRead | BoardReadFailure>): DemoCommit[] {
  const out: DemoCommit[] = [];
  let prevLive: Oid | null = null;
  let carried: { seats: string[]; base: string | null } = { seats: [], base: null };
  for (const r of reads) {
    const at = { room, height: r.height, line: r.height + 2, claims: null };
    if (isBoardReadFailure(r)) {
      if (r.malformed === 'missing') throw new BoardObjectMissingError(r.height, r.oid);
      out.push({ ...at, writer: null, protocol: r.height === 0 ? readProtocol(null) : null, code: UNCHANGED(), cs: [], csPaths: new Map(), ops: [], held: [], live: null });
      continue;
    }
    const changed = r.height > 0 && r.liveCode !== prevLive;
    let code: DemoCommit['code'];
    if (r.live === 'same' || r.live === null) {
      code = { changed: false, ...carried };
    } else if ('malformed' in r.live) {
      if (r.live.malformed === 'missing') throw new BoardObjectMissingError(r.height, r.live.oid ?? r.liveCode);
      carried = { seats: [], base: null };
      code = UNCHANGED();
    } else {
      carried = { seats: [...r.live.seats], base: r.live.base };
      const shape = r.height === 0 ? liveShape(r.live.info, null) : changed ? liveShape(r.live.info, prevLive) : null;
      code = changed && shape === null ? UNCHANGED() : { changed, ...carried };
    }
    prevLive = r.liveCode;
    out.push({
      ...at, writer: r.writer === null ? null : formatWriter(r.writer), protocol: r.height === 0 ? r.protocol : null, code,
      cs: r.cs.map(csValue), csPaths: new Map([...r.csPaths].map(([k, v]) => [k, [...v]])), ops: [...r.opsLines], held: [...r.heldIds],
      live: code.changed ? r.liveCode : null,
    });
  }
  return out;
}

/**
 * One commit record per board commit of `o.ref` from height 0 (R-V19 encodings: a shape-null live read → code {changed: false,
 * seats: [], base: null}; a malformed board commit → writer null, ops [], cs [], csPaths {}, held [] with that code; a missing
 * object → throws BoardObjectMissingError, the CLI exits 1), `live` on every changed record, then `o.captions` in order. The
 * bytes are LF, UTF-8 without BOM, and parse back with parseDemoLog (else ExportDemoError naming the refused line).
 */
export async function exportDemo(o: { gitDir: string; ref: string; room: DemoRoomHeader; captions: readonly DemoCaption[] }, deps: { git: VizGit }): Promise<Buffer> {
  if (deps.git.gitDir !== o.gitDir) throw new ExportDemoError('export-demo: deps.git reads another git directory than o.gitDir');
  const commits = records(o.room.room, await readChain(deps.git, o.ref));
  const log: DemoLog = { rooms: [{ ...o.room }], commits: new Map([[o.room.room, commits]]), captions: o.captions.map((c) => ({ ...c })) };
  const bytes = serializeDemoLog(log);
  const back = parseDemoLog(bytes, CAPTION_CODES);
  if ('line' in back) {
    const caption = back.line - 1 - commits.length;
    throw new ExportDemoError(caption >= 1
      ? `export-demo: caption ${caption} is not a valid caption of this board (room ${o.room.room}, heights 0…${commits.length - 1})`
      : `export-demo: the board does not fit cowork-viz-demo/1 (line ${back.line} of the log refused)`);
  }
  return bytes;
}

// ---- the CLI -------------------------------------------------------------------------------------------------------------

const USAGE = 'usage: node --import tsx tools/viz/export-demo.ts --git-dir <abs> --ref <board ref> [--captions <file>] [--oplog <file>] --out <file>';
const FLAGS = new Set(['--git-dir', '--ref', '--captions', '--oplog', '--out']);
const NAME_MAX = 40;
const BRANCH_MAX = 80;

/** One SIM op-log entry (test/sim/harness.ts OpLogEntry). */
export interface OpLogEntry { step: number; peer: string; kind: string; detail: string; }
/** The records of an input file, or the 1-based line of the first bad one (`notUtf8` when its bytes are not UTF-8). */
type Lines<T> = T[] | { line: number; notUtf8?: true };

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * The non-empty lines of a hand-written JSONL input (--captions, --oplog) as objects. Lines end in LF or CRLF, and one UTF-8 BOM
 * at offset 0 is skipped (Notepad and VS Code on Windows save that way; the written log is LF without a BOM regardless). A BOM
 * anywhere else is text: a line it opens is not JSON. Each line must be strict UTF-8 and one JSON object; else the line number.
 */
function jsonLines(buf: Buffer): Array<{ line: number; value: Record<string, unknown> }> | { line: number; notUtf8?: true } {
  const body = buf.subarray(0, UTF8_BOM.length).equals(UTF8_BOM) ? buf.subarray(UTF8_BOM.length) : buf;
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const out: Array<{ line: number; value: Record<string, unknown> }> = [];
  for (let start = 0, line = 1; start <= body.length; line++) {
    const lf = body.indexOf(0x0a, start);
    const end = lf === -1 ? body.length : lf;
    const raw = body.subarray(start, end > start && body[end - 1] === 0x0d ? end - 1 : end);
    start = end + 1;
    if (raw.length === 0) continue;
    let text: string;
    try {
      text = utf8.decode(raw);
    } catch {
      return { line, notUtf8: true };
    }
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      return { line };
    }
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return { line };
    out.push({ line, value: v as Record<string, unknown> });
  }
  return out;
}

/**
 * A --captions file: `caption` records (12 §3.9.3) with exactly t, room, height and one of code or text, by type; the code, text,
 * room and height rules are checked when the written log is parsed back (exportDemo).
 */
export function parseCaptionsFile(buf: Buffer): Lines<DemoCaption> {
  const lines = jsonLines(buf);
  if (!Array.isArray(lines)) return lines;
  const out: DemoCaption[] = [];
  for (const { line, value: r } of lines) {
    const keys = Object.keys(r).sort();
    const code = keys.join(',') === 'code,height,room,t';
    const text = keys.join(',') === 'height,room,t,text';
    if (r['t'] !== 'caption' || !(code || text) || typeof r['room'] !== 'string' || typeof r['height'] !== 'number') return { line };
    const v = code ? r['code'] : r['text'];
    if (typeof v !== 'string') return { line };
    out.push({ room: r['room'], height: r['height'], code: code ? v : null, text: code ? null : v });
  }
  return out;
}

/** A SIM op-log (one {step, peer, kind, detail} object per line). */
export function parseOpLog(buf: Buffer): Lines<OpLogEntry> {
  const lines = jsonLines(buf);
  if (!Array.isArray(lines)) return lines;
  const out: OpLogEntry[] = [];
  for (const { line, value: r } of lines) {
    const { step, peer, kind, detail } = r;
    if (typeof step !== 'number' || !Number.isSafeInteger(step) || typeof peer !== 'string' || typeof kind !== 'string' || typeof detail !== 'string') return { line };
    out.push({ step, peer, kind, detail });
  }
  return out;
}

/**
 * The op-log listing: one line per entry, `step peer kind detail`, then the heights of the board commits written by the peer
 * the entry names, or '-'. A board peer is the entry's peer when one of its join ops (an op id of that peer_id) carries the
 * display `<peer>` or `Peer <peer>` (the SIM engine adapter's display); the exporter learns nothing else from the op-log.
 */
export function opLogListing(entries: readonly OpLogEntry[], demo: Buffer): string[] {
  const log = parseDemoLog(demo, CAPTION_CODES);
  if ('line' in log) throw new ExportDemoError(`export-demo: the demo log refuses at line ${log.line}`);
  const commits = [...log.commits.values()].flat();
  const displays = new Map<string, Set<string>>();   // display → peer ids
  const heights = new Map<string, number[]>();        // peer id → heights written
  for (const c of commits) {
    const w = c.writer === null ? null : parseWriter(c.writer);
    if (w !== null) heights.set(w.peer, [...(heights.get(w.peer) ?? []), c.height]);
    for (const line of c.ops) {
      const op = parseOpLine(line);
      if (op === null || op.type !== 'join') continue;
      const peer = op.id.split('/')[0]!;
      displays.set(op.display, (displays.get(op.display) ?? new Set()).add(peer));
    }
  }
  const clean = (s: string): string => sanitize(s, 'terminal');
  return entries.map((e) => {
    const peers = new Set([...(displays.get(e.peer) ?? []), ...(displays.get(`Peer ${e.peer}`) ?? [])]);
    const hs = [...peers].flatMap((p) => heights.get(p) ?? []).sort((a, b) => a - b);
    return `${e.step} ${clean(e.peer)} ${clean(e.kind)} ${clean(e.detail)}  heights ${hs.length === 0 ? '-' : hs.join(',')}`;
  });
}

/** The room header of the CLI: room `a`, the repository's folder name (≤ 40 characters), the branch the ref encodes (≤ 80). */
function headerOf(gitDir: string, branch: string): DemoRoomHeader {
  const repo = basename(gitDir) === '.git' ? basename(dirname(gitDir)) : basename(gitDir).replace(/\.git$/, '');
  const cut = (s: string, n: number): string => [...s].slice(0, n).join('');
  return { room: 'a', name: cut(repo.length > 0 ? repo : 'repo', NAME_MAX), branch: cut(branch, BRANCH_MAX) };
}

interface Io { out(line: string): void; err(line: string): void; }

/** argv → 0 (written), 1 (the board, a file or git failed: nothing written), 2 (usage). */
export async function exportDemoCli(argv: readonly string[], io: Io, env: Readonly<Record<string, string | undefined>> = process.env): Promise<number> {
  const opts = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (!FLAGS.has(flag) || opts.has(flag) || value === undefined || value.startsWith('--')) {
      io.err(USAGE);
      return 2;
    }
    opts.set(flag, value);
  }
  const gitDirArg = opts.get('--git-dir');
  const ref = opts.get('--ref');
  const out = opts.get('--out');
  const m = ref === undefined ? null : (REMOTE_BOARD_REF.exec(ref) ?? CI_BOARD_REF.exec(ref));
  const branch = m === null ? null : decodeEnc(m[1]!);
  if (gitDirArg === undefined || !isAbsolute(gitDirArg) || ref === undefined || branch === null || out === undefined) {
    io.err(USAGE);
    if (ref !== undefined && branch === null) {
      io.err('export-demo: --ref must be a board ref refs/cowork-remote/<enc(branch)>/board or refs/cowork-ci/<run_id>/<enc(branch)>/board');
    }
    return 2;
  }
  const fail = (msg: string): number => {
    io.err(`export-demo: ${msg}`);
    return 1;
  };
  let captions: DemoCaption[] = [];
  let opLog: OpLogEntry[] | null = null;
  try {
    const c = opts.get('--captions');
    if (c !== undefined) {
      const parsed = parseCaptionsFile(readFileSync(c));
      if (!Array.isArray(parsed)) return fail(`--captions line ${parsed.line} ${parsed.notUtf8 === true ? 'is not UTF-8' : 'is not a caption record'}`);
      captions = parsed;
    }
    const l = opts.get('--oplog');
    if (l !== undefined) {
      const parsed = parseOpLog(readFileSync(l));
      if (!Array.isArray(parsed)) return fail(`--oplog line ${parsed.line} ${parsed.notUtf8 === true ? 'is not UTF-8' : 'is not an op-log entry'}`);
      opLog = parsed;
    }
  } catch (e) {
    return fail(`cannot read an input file (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  let gitDir: string;
  try {
    gitDir = realpathSync.native(gitDirArg);
  } catch {
    return fail('--git-dir does not exist');
  }
  // R-V13: an absolute git outside every repository this run touches (the cwd's and the exported one's), never a bare name.
  const worktree = basename(gitDir) === '.git' ? dirname(gitDir) : gitDir;
  const excluded = await excludedRoots(process.cwd(), [worktree], realFs, process.platform, homedir());
  const gitPath = await resolveGitPath(env, excluded, { fs: realFs, probe: realOwnerProbe, platform: process.platform, euid: typeof process.geteuid === 'function' ? process.geteuid() : null });
  if (gitPath === null) return fail('no trusted git on PATH');
  const dataDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cowork-export-demo-')));
  let bytes: Buffer;
  try {
    const runner = vizGitRunner({ clock: realClock, dataDir, env: buildDaemonEnv(env as Record<string, string | undefined>, []), gitPath });
    const git = createExportGit({ runner, gitDir, dataDir });
    bytes = await exportDemo({ gitDir, ref, room: headerOf(gitDir, branch), captions }, { git });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
  try {
    writeFileSync(out, bytes);
  } catch (e) {
    return fail(`cannot write --out (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  if (opLog !== null) for (const line of opLogListing(opLog, bytes)) io.out(line);
  const log = parseDemoLog(bytes, CAPTION_CODES) as DemoLog;
  io.out(`export-demo: wrote ${log.commits.get('a')!.length} commit records and ${log.captions.length} captions`);
  return 0;
}

/** This module is the process entry (node --import tsx tools/viz/export-demo.ts), not an import. */
function isMain(url: string): boolean {
  const arg = process.argv[1];
  if (arg === undefined) return false;
  const canon = (p: string): string => {
    let r = resolve(p);
    try {
      r = realpathSync.native(r);
    } catch {
      // not a file on disk: compare as given
    }
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return canon(arg) === canon(fileURLToPath(url));
}

if (isMain(import.meta.url)) {
  exportDemoCli(process.argv.slice(2), { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) }).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`export-demo: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
