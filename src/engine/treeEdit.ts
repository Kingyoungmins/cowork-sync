// Whole-path edits of code trees in an engine scratch index (ENG-10 operation 3, ruling R-15), shared by apply and publish.
//
// Index-only calls (P2-NTFS): A, TIP and the merge results may hold names this OS refuses in a working tree (aux.c on
// Windows); such paths are carried, never written (P2-DOTGIT), so the scratch-index calls run with core.protectNTFS=false
// and core.untrackedCache=false.
//
// Final review FB-6: core.protectNTFS=false does not make every name indexable. git for Windows refuses a ROOT name with a
// drive prefix (`a:b.txt`, `x:`, `1:x`, `é:x`; verify_path's has_dos_drive_prefix runs whatever protectNTFS says) in ANY
// index — read-tree of a tree holding one exits 128, update-index --index-info "ignores" one and exits 0 (measured on git
// 2.55.0.windows.3; `ab:c`, `:x`, `dir/a:b`, `aux.c`, `trail.` and `con` round-trip). fetch.fsckObjects accepts such a
// name, so a teammate's TIP can hold one. Neither failure may stay silent or untyped: a read-tree refusal of a tree whose
// root holds such a name, and every edit that did not land, is a typed IndexRefusedPathError naming the paths (read back
// with ls-files -s -z, literal pathspecs: an outcome from -z output, never from git's text). It extends GitCommandError,
// so every caller that already treats a git failure as such (publish: build_failed) keeps doing so; apply defers the paths
// it cannot build (apply.ts), start refuses (start.ts). A or S_raw never diverges silently.
//
// Ruling P2-SCRATCHLOCK: the engine owns its tmp/*.index scratch indexes and uses them only under its state lock, so every
// read-tree into one first removes the index and a stale <index>.lock (resetScratchIndex): a git child killed mid-write
// (write-tree under the watchdog, a power loss) must never wedge every later publish or apply. The user's .git/index(.lock)
// and the private index are never reset here (editIndexOnly on the private index reads no tree).
import { parseOid, type Oid } from '../git/oid.js';
import { GitCommandError, type GitRepo, type IndexEdit, type TreeMap } from '../git/repo.js';
import type { Fs } from '../ports/fs.js';
import { resetScratchIndex } from './diskEq.js';
import { diffPaths } from './treeDiff.js';

/** The config of every index-only call on a scratch index or the private index (P2-NTFS). */
export const INDEX_ONLY: Readonly<Record<string, string>> = Object.freeze({ 'core.protectNTFS': 'false', 'core.untrackedCache': 'false' });

/** Above this many pathspec bytes the read-back lists the whole index instead (one bounded command line on Windows). */
const PATHSPEC_BYTES_MAX = 16_384;

/**
 * Final review FB-6: git refused to index `paths` (a read-tree of a tree holding them exited 128, or an index edit of them
 * did not land). A GitCommandError, so generic git-failure handling still applies; `paths` sorted.
 */
export class IndexRefusedPathError extends GitCommandError {
  readonly paths: readonly string[];
  constructor(argv: readonly string[], code: number, stderr: Buffer, paths: readonly string[]) {
    super(argv, code, stderr);
    this.name = 'IndexRefusedPathError';
    this.paths = [...paths].sort();
    this.message = `git refused to index ${this.paths.length} path(s): ${this.paths.slice(0, 5).map((p) => JSON.stringify(p)).join(', ')}`;
  }
}

/**
 * git for Windows' has_dos_drive_prefix (compat/mingw.h) on a path's UTF-8 bytes: an ASCII first byte followed by ':', or
 * a run of 1–4 bytes with the high bit set (one non-ASCII character, by git's own count) followed by ':'. Only a root name
 * can match. Used to name the culprit after a read-tree refusal; the read-back of an edit decides by itself.
 */
export function hasDrivePrefix(path: string): boolean {
  const b = Buffer.from(path, 'utf8');
  if (b.length < 2 || b[0] === 0) return false;
  if ((b[0]! & 0x80) === 0) return b[1] === 0x3a;
  let i = 1;
  while (i < 4 && i < b.length && (b[i]! & 0x80) !== 0) i++;
  return b[i] === 0x3a;
}

/** Whole-path edits turning `from` into `to` (a path `to` lacks is removed). */
export function editsBetween(from: TreeMap, to: TreeMap): IndexEdit[] {
  return diffPaths(from, to).map((p) => {
    const e = to.get(p);
    return e === undefined ? { path: p, remove: true } : { path: p, mode: e.mode, oid: e.oid };
  });
}

/**
 * Final review FB-6: every edit landed in `index` (the last edit of a path wins, as in update-index): an entry at stage 0
 * with the edit's mode and oid, none for a removal. Read back with ls-files -s -z over literal pathspecs; the whole index
 * when they are long, when one has a drive prefix (git for Windows reads `b:c.txt` as a path outside the repository) or
 * when git refuses the pathspecs. Else IndexRefusedPathError naming the paths that did not land.
 */
export async function verifyIndexEdits(repo: GitRepo, index: string, edits: readonly IndexEdit[], config: Readonly<Record<string, string>>, argv: readonly string[]): Promise<void> {
  if (edits.length === 0) return;
  const want = new Map<string, IndexEdit>();
  for (const e of edits) want.set(e.path, e);
  const paths = [...want.keys()];
  const specBytes = paths.reduce((n, p) => n + Buffer.byteLength(p, 'utf8') + 1, 0);
  const whole = ['ls-files', '-s', '-z'];
  let r;
  if (specBytes <= PATHSPEC_BYTES_MAX && !paths.some(hasDrivePrefix)) {
    r = await repo.run([...whole, '--', ...paths], { indexFile: index, config, literalPathspecs: true, okCodes: [0, 128] });
    if (r.code !== 0) r = null;
  }
  r ??= await repo.run(whole, { indexFile: index, config });
  const have = new Map<string, { mode: string; oid: string }>();
  for (const rec of r.stdout.toString('utf8').split('\0')) {
    if (rec.length === 0) continue;
    const tab = rec.indexOf('\t');
    const meta = tab < 0 ? [] : rec.slice(0, tab).split(' ');
    if (meta.length !== 3) throw new Error(`ls-files: unexpected record ${JSON.stringify(rec.slice(0, 120))}`);
    if (meta[2] !== '0') continue;
    const p = rec.slice(tab + 1);
    if (want.has(p)) have.set(p, { mode: meta[0]!, oid: meta[1]! });
  }
  const missed: string[] = [];
  for (const [p, e] of want) {
    const h = have.get(p);
    if ('remove' in e ? h !== undefined : h === undefined || h.mode !== e.mode || h.oid !== e.oid) missed.push(p);
  }
  if (missed.length > 0) throw new IndexRefusedPathError(argv, 0, Buffer.alloc(0), missed);
}

/**
 * read-tree <tree> into `index` (index-only config); final review FB-6: a refusal (rc 128) of a tree whose root holds a
 * name git refuses in an index (hasDrivePrefix) is an IndexRefusedPathError naming those root entries; any other failure
 * is thrown as it is.
 */
export async function readTreeIndexOnly(repo: GitRepo, tree: Oid, index: string, config: Readonly<Record<string, string>> = INDEX_ONLY): Promise<void> {
  try {
    await repo.run(['read-tree', parseOid(tree)], { class: 'refupdate', indexFile: index, config });
  } catch (e) {
    if (!(e instanceof GitCommandError) || e instanceof IndexRefusedPathError) throw e;
    const refused = await refusedRootNames(repo, tree).catch(() => []);
    if (refused.length === 0) throw e;
    throw new IndexRefusedPathError(e.argv, e.code, Buffer.from(e.stderrText, 'utf8'), refused);
  }
}

/** The root entries of `tree` (ls-tree -z, not recursive) whose name git refuses in an index (hasDrivePrefix). */
async function refusedRootNames(repo: GitRepo, tree: Oid): Promise<string[]> {
  const r = await repo.run(['ls-tree', '-z', parseOid(tree)]);
  const out: string[] = [];
  for (const rec of r.stdout.toString('utf8').split('\0')) {
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const name = rec.slice(tab + 1);
    if (hasDrivePrefix(name)) out.push(name);
  }
  return out;
}

/** update-index --add --replace -z --index-info with index-only config; a removal is mode 0 with a zero oid; every edit is verified to have landed (FB-6). */
export async function editIndexOnly(repo: GitRepo, index: string, edits: readonly IndexEdit[], oidLength: number): Promise<void> {
  if (edits.length === 0) return;
  const zero = '0'.repeat(oidLength);
  const lines = edits.map((e) => ('remove' in e ? `0 ${zero}\t${e.path}\0` : `${e.mode} ${parseOid(e.oid)}\t${e.path}\0`)).join('');
  const argv = ['update-index', '--add', '--replace', '-z', '--index-info'];
  await repo.run(argv, { class: 'refupdate', indexFile: index, config: INDEX_ONLY, stdin: Buffer.from(lines, 'utf8') });
  await verifyIndexEdits(repo, index, edits, INDEX_ONLY, argv);
}

/**
 * tree = base with whole-path edits in the scratch index `index` (reset first, P2-SCRATCHLOCK); `base` itself when there
 * is no edit. IndexRefusedPathError (FB-6) when git cannot index the base or an edit.
 */
export async function editTreeIndexOnly(repo: GitRepo, fs: Fs, base: Oid, edits: readonly IndexEdit[], index: string): Promise<Oid> {
  if (edits.length === 0) return base;
  await resetScratchIndex(fs, index);
  await readTreeIndexOnly(repo, base, index);
  await editIndexOnly(repo, index, edits, base.length);
  const r = await repo.run(['write-tree'], { indexFile: index, config: INDEX_ONLY });
  return parseOid(r.stdout.toString('utf8'));
}
