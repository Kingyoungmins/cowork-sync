// merge-tree and merge-file with explicit bases (INV-BASE, DAT-40, glossary §18). Never merge-base,
// never -X options; the runner adds MERGE_FLAGS to both subcommands.
import { join } from 'node:path';
import { KilledAt } from '../ports/crashpoint.js';
import { realFs } from '../ports/fs.js';
import { ABSENT, parseOid, type Oid, type OidOrAbsent } from './oid.js';
import { GitCommandError, type GitRepo } from './repo.js';
import type { GitResult } from './runner.js';

export interface MergeTreeResult { rc: 0 | 1; tree: Oid; conflicted: string[]; }

export class MergeFailedError extends Error {
  readonly code: number;
  constructor(code: number, detail: string) {
    super(`git merge-tree failed with exit code ${code}${detail.length > 0 ? `: ${detail.slice(0, 300)}` : ''}`);
    this.name = 'MergeFailedError';
    this.code = code;
  }
}

/** Ruling R-30: the fixed identity of the parentless wrapper commits; the date is the ordinary commit-date rule. */
const WRAP_IDENTITY = { name: 'cowork', email: 'merge@cowork.invalid' } as const;

async function wrap(repo: GitRepo, tree: Oid): Promise<Oid> {
  return repo.commitTree({ tree, parents: [], subject: 'cowork-merge', trailers: [] }, WRAP_IDENTITY);
}

/**
 * merge-tree --write-tree -z --name-only --no-messages --merge-base=<base> <ours> <theirs>, with base, ours and
 * theirs wrapped in parentless commits (R-30: one path that works on every git at or above the floor). The
 * wrapper commits are unreferenced scratch objects. rc 0 clean, rc 1 conflicts (tree holds the markers);
 * anything above 1 throws MergeFailedError.
 */
export async function mergeTree(repo: GitRepo, base: Oid, ours: Oid, theirs: Oid): Promise<MergeTreeResult> {
  parseOid(base);
  parseOid(ours);
  parseOid(theirs);
  const baseCommit = await wrap(repo, base);
  const oursCommit = await wrap(repo, ours);
  const theirsCommit = await wrap(repo, theirs);
  let stdout: Buffer;
  let code: number;
  try {
    const r = await repo.run(
      ['merge-tree', '--write-tree', '-z', '--name-only', '--no-messages', `--merge-base=${baseCommit}`, oursCommit, theirsCommit],
      { class: 'attr', okCodes: [0, 1] },
    );
    stdout = r.stdout;
    code = r.code;
  } catch (e) {
    if (e instanceof GitCommandError) throw new MergeFailedError(e.code, e.stderrText);
    throw e;
  }
  // <tree> NUL (<conflicted path> NUL)* [NUL <messages>]; --no-messages leaves no messages part.
  const tokens = stdout.toString('utf8').split('\0');
  const tree = parseOid(tokens[0] ?? '');
  const conflicted = new Set<string>();
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i] as string;
    if (t.length === 0) break;
    conflicted.add(t);
  }
  return { rc: code === 0 ? 0 : 1, tree, conflicted: [...conflicted].sort() };
}

export interface MergeFileOpts { diff3?: boolean; markerSize?: number; labels?: readonly [string, string, string]; }
/**
 * rc: 0 clean, > 0 the number of conflicts (out then holds at least that many conflict-opening marker rows, mergeFileRc), < 0 an
 * error (out is not a merge: a caller writes nothing from it).
 */
export interface MergeFileResult { rc: number; out: Buffer; }

/** git's default conflict-marker size (merge-file without --marker-size). */
export const DEFAULT_MARKER_SIZE = 7;

/** Every exit code repo.run accepts from merge-file (mergeFileRc classifies them): 0…255 and the runner's −1. */
export const MERGE_FILE_EXITS: readonly number[] = Object.freeze(Array.from({ length: 256 }, (_, i) => i).concat(-1));

/**
 * A git BUG(), die() or error() line (D1 diagnosis: fail closed on any of them). Only the file form runs (runMergeFile), which prints
 * none of them on a normal merge. MEASURED (this PC's git 2.53.0.windows.2; the git-matrix leg owns other versions): the `--object-id` form printed "error: Could not stat /dev/null"
 * once per empty-blob side even when it merged; the file form reads no /dev/null.
 */
const ERROR_LINE = /^(?:BUG|fatal|error): /m;

/**
 * Rows of out equal to `<M> <label>` — git's conflict-opening marker row — once its LF and one CR are removed (row 1's BOM ignored,
 * as every marker detector of this code base reads a row).
 */
function openingRows(out: Buffer, markerSize: number, label: string): number {
  const want = Buffer.from(`${'<'.repeat(markerSize)} ${label}`, 'utf8');
  let n = 0;
  let start = 0;
  while (start < out.length) {
    const nl = out.indexOf(0x0a, start);
    let end = nl < 0 ? out.length : nl;
    if (end > start && out[end - 1] === 0x0d) end--;
    let s = start;
    if (start === 0 && end - s >= 3 && out[0] === 0xef && out[1] === 0xbb && out[2] === 0xbf) s += 3;
    if (end - s === want.length && out.compare(want, 0, want.length, s, end) === 0) n++;
    if (nl < 0) break;
    start = nl + 1;
  }
  return n;
}

/**
 * Ruling G1-RC (audit #1 #2; glossary §18: message text only ever makes handling stricter): the rc of one finished `merge-file -p`
 * run. Exit 0 is clean and exit 1…127 is that many conflicts ONLY when git ended normally: a watchdog kill or an abort, a stderr line
 * starting `BUG: `, `fatal: ` or `error: `, or an exit 1…127 whose output holds fewer conflict-opening rows `<M> <label>` than the
 * count (git writes one per conflict, so no output can carry an impossible count) is an error (−1), and so is every other exit.
 * MEASURED (this PC's git 2.53.0.windows.2; the git-matrix leg owns other versions): `merge-file --object-id` with an explicit git dir dies in BUG() ("repository.c:171: cannot
 * reinitialize an already-initialized object directory"), which Windows reports as exit 3 with an empty stdout — even for a clean
 * merge — so the exit alone read "3 conflicts" and --restore wrote an empty file. `label` is the current side's label: -L's first,
 * else the current side's argument as given (git's default).
 */
export function mergeFileRc(r: GitResult, markerSize: number, label: string): number {
  if (r.killedByWatchdog || r.aborted) return -1;
  if (r.code < 0 || r.code > 127) return -1;
  if (ERROR_LINE.test(r.stderr.toString('utf8'))) return -1;
  if (r.code > 0 && openingRows(r.stdout, markerSize, label) < r.code) return -1;
  return r.code;
}

const emptyBlobs = new WeakMap<GitRepo, Promise<Oid>>();

/** The empty blob, written once per repo: the stand-in for an ABSENT side. */
function emptyBlob(repo: GitRepo): Promise<Oid> {
  let p = emptyBlobs.get(repo);
  if (p === undefined) {
    p = repo.hashBytes(Buffer.alloc(0), true);
    emptyBlobs.set(repo, p);
    p.catch(() => emptyBlobs.delete(repo));
  }
  return p;
}

/** One merge-file call as its caller wrote it (the `--object-id` form, HLD-13): options, the three labels if given, the three sides. */
interface MergeFileCall { options: string[]; labels: [string, string, string] | null; sides: [Oid, Oid, Oid]; markerSize: number; }

const MARKER_SIZE_ARG = /^--marker-size=([1-9][0-9]{0,5})$/;
/**
 * A flag word of the caller's (--diff3, and revertInverse's own one, L-HOLD-STORES): passed through unnamed. Every flag reaches this file
 * from a literal written at a lint-checked call site (L-MERGE-OPTS, L-HOLD-STORES refuse -X, --union, --theirs and a stray --ours there).
 */
const FLAG_ARG = /^--[a-z]+[0-9]?$/;

/** Parses `merge-file -p --object-id [flags] [--marker-size=M] [-L l ×3] <cur> <base> <other>`; anything else throws. */
function parseMergeFileArgv(argv: readonly string[]): MergeFileCall {
  const fail = (why: string): never => {
    throw new Error(`runMergeFile: ${why} in ${JSON.stringify(argv.slice(0, 12))}`);
  };
  if (argv[0] !== 'merge-file' || argv.length < 6) fail('not a merge-file argv with three sides');
  const sides = argv.slice(-3).map((o) => parseOid(o)) as [Oid, Oid, Oid];
  const options: string[] = [];
  const labels: string[] = [];
  let p = false;
  let objectId = false;
  let markerSize = DEFAULT_MARKER_SIZE;
  for (let i = 1; i < argv.length - 3; i++) {
    const a = argv[i] as string;
    const m = MARKER_SIZE_ARG.exec(a);
    if (a === '-p') p = true;
    else if (a === '--object-id') objectId = true;
    else if (FLAG_ARG.test(a)) options.push(a);
    else if (m !== null) {
      options.push(a);
      markerSize = Number(m[1]);
    } else if (a === '-L' && i + 1 < argv.length - 3) {
      const l = argv[++i] as string;
      if (/[\0\r\n]/.test(l)) fail('invalid label');
      labels.push(l);
    } else fail(`unsupported argument ${JSON.stringify(a)}`);
  }
  if (!p || !objectId) fail('-p and --object-id are required');
  if (labels.length !== 0 && labels.length !== 3) fail('-L must be given three times or not at all');
  return { options, labels: labels.length === 3 ? (labels as [string, string, string]) : null, sides, markerSize };
}

/** A merge-file call that could not run (a side unreadable, the scratch directory unwritable): an error, nothing to write. */
const NOT_RUN: MergeFileResult = Object.freeze({ rc: -1, out: Buffer.alloc(0) });

let scratchSeq = 0;

/**
 * Ruling G1-FILEFORM (audit #1 #2; controller note after the D1 diagnosis): the one place that runs `git merge-file`. `argv` is the call
 * as every caller writes it — `merge-file -p --object-id [--diff3] [--marker-size=M] [-L l1 -L l2 -L l3] <cur> <base> <other>`
 * (HLD-13, DAT-47: the inputs are blob objects, never a working file) — and it runs as `merge-file -p [options] -L l1 -L l2 -L l3
 * <f1> <f2> <f3>` over the three objects' stored-form bytes: one `cat-file --batch` read (no filters), written to a fresh private
 * directory <coworkDir>/tmp/merge-<pid>-<n> (0o700, removed afterwards). A label the caller does not give is that side's oid — the
 * label `--object-id` prints — so the output is byte-identical to the `--object-id` form (D1: checked plain and --diff3
 * --marker-size=9). MEASURED (this PC's git 2.53.0.windows.2; the git-matrix leg owns other versions): `merge-file --object-id` dies in BUG() ("repository.c:171: cannot reinitialize an
 * already-initialized object directory", exit 3 on Windows, empty stdout, a clean merge too) whenever the git dir is explicit
 * (--git-dir, GIT_DIR, -C <gitdir>, -C <linked worktree>); the file form merges with the runner's usual --git-dir. Every caller's
 * merge goes through here (MASK step 5, REBASE, RESTORE, D9 concat in conflict.ts, the writer's remerge, HLD-41's rebase,
 * revertInverse). An unreadable side or an unwritable scratch directory is rc −1 with no output; otherwise the rc is mergeFileRc's.
 * The scratch bytes are copies of objects already in the same .git: a directory a crash leaves behind exposes nothing new.
 */
export async function runMergeFile(repo: GitRepo, argv: readonly string[]): Promise<MergeFileResult> {
  const call = parseMergeFileArgv(argv);
  const labels = call.labels ?? call.sides;
  const unique = [...new Set(call.sides)];
  let bytes: Buffer[];
  try {
    const read = await repo.readBlobs(unique);
    const by = new Map(unique.map((o, i) => [o, read[i] as Buffer] as const));
    bytes = call.sides.map((o) => by.get(o) as Buffer);
  } catch (e) {
    if (e instanceof KilledAt) throw e;
    return NOT_RUN;
  }
  const dir = join(repo.paths.coworkDir, 'tmp', `merge-${process.pid}-${++scratchSeq}`);
  // <k>.<oid>: the sides stay recognisable in the argv (k keeps two equal sides apart).
  const files = call.sides.map((o, k) => join(dir, `${k}.${o}`));
  try {
    try {
      await realFs.rmrf(dir);   // a directory an earlier process with this pid left behind
      await realFs.mkdirp(dir, 0o700);
      for (const [k, f] of files.entries()) await realFs.writeFileExclusive(f, bytes[k] as Buffer);
    } catch (e) {
      if (e instanceof KilledAt) throw e;
      return NOT_RUN;
    }
    const r = await repo.run(['merge-file', '-p', ...call.options, '-L', labels[0], '-L', labels[1], '-L', labels[2], ...files], { okCodes: MERGE_FILE_EXITS });
    return { rc: mergeFileRc(r, call.markerSize, labels[0]), out: r.stdout };
  } finally {
    await realFs.rmrf(dir).catch(() => { /* best effort: the bytes are objects of this .git already */ });
  }
}

/**
 * merge-file -p --object-id [--diff3] [--marker-size=M] [-L ×3] <current> <base> <other>, run by runMergeFile (the file form, ruling
 * G1-FILEFORM); an ABSENT side is the empty blob (its oid is its default label); the rc is mergeFileRc's.
 */
export async function mergeFile(
  repo: GitRepo,
  current: OidOrAbsent,
  base: OidOrAbsent,
  other: OidOrAbsent,
  opts: MergeFileOpts = {},
): Promise<MergeFileResult> {
  const sides: string[] = [];
  for (const s of [current, base, other]) sides.push(s === ABSENT ? await emptyBlob(repo) : parseOid(s));
  const args = ['merge-file', '-p', '--object-id'];
  if (opts.diff3 === true) args.push('--diff3');
  if (opts.markerSize !== undefined) {
    if (!Number.isInteger(opts.markerSize) || opts.markerSize < 1) throw new RangeError(`invalid marker size ${String(opts.markerSize)}`);
    args.push(`--marker-size=${opts.markerSize}`);
  }
  if (opts.labels !== undefined) {
    for (const l of opts.labels) {
      if (/[\0\r\n]/.test(l)) throw new Error('invalid merge-file label');
      args.push('-L', l);
    }
  }
  args.push(...sides);
  return runMergeFile(repo, args);
}
