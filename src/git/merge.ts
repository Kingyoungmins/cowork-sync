// merge-tree and merge-file with explicit bases (INV-BASE, DAT-40, glossary §18). Never merge-base,
// never -X options; the runner adds MERGE_FLAGS to both subcommands.
import { ABSENT, parseOid, type Oid, type OidOrAbsent } from './oid.js';
import { GitCommandError, type GitRepo } from './repo.js';

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
/** rc: 0 clean, > 0 the number of conflicts, < 0 an error. */
export interface MergeFileResult { rc: number; out: Buffer; }

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

/** merge-file -p --object-id [--diff3] [--marker-size=M] [-L ×3] <current> <base> <other>; an ABSENT side is the empty blob. */
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
  // Exit codes: 0 clean, 1..127 the conflict count, anything else (git's -1 is 255, die is 128) an error.
  const r = await repo.run(args, { okCodes: Array.from({ length: 256 }, (_, i) => i).concat(-1) });
  const rc = r.code >= 0 && r.code <= 127 ? r.code : -1;
  return { rc, out: r.stdout };
}
