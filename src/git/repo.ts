// GitRepo: typed plumbing over the single git runner (ENG-08, ENG-09, ENG-10, ENG-12).
// Engine code calls git only through GitRepo.run and the typed methods below; every oid is an Oid,
// every path is absolute, every code tree comes from write-tree / merge-tree / update-index
// --index-info / commit-tree, and metadata trees come from mktree (ruling R-15).
import type { GitCallOptions, GitIdentity } from './flags.js';
import { isOid, parseOid, OidError, type Oid } from './oid.js';
import type { GitResult, GitRunner } from './runner.js';
import { formatMessage, parseMessage, type Trailer } from './trailers.js';

export interface RepoPaths {
  /** Main-worktree root (realpath.native, absolute). */
  workTree: string;
  /** Absolute git dir (== common dir; linked worktrees are refused). */
  gitDir: string;
  /** `<gitDir>/cowork`. */
  coworkDir: string;
}

export interface RepoContext {
  /** EPOCH_BASE commit for `-c attr.tree` (null until known). */
  attrTree: Oid | null;
  /** Algorithm D3 drivers (the runner always adds lfs). */
  filterDrivers: readonly string[];
  /** `{ name: display, email: `${peer_id}@cowork.invalid` }` (glossary §5, SEC-03). */
  identity: GitIdentity;
  /** Commit dates (honoured only in test builds). */
  wallMs: () => number;
}

export class GitCommandError extends Error {
  readonly argv: readonly string[];
  readonly code: number;
  readonly stderrText: string;
  constructor(argv: readonly string[], code: number, stderr: Buffer) {
    const text = stderr.toString('utf8').trim();
    super(`git ${argv.slice(0, 3).join(' ')} failed with exit code ${code}${text.length > 0 ? `: ${text.slice(0, 300)}` : ''}`);
    this.name = 'GitCommandError';
    this.argv = [...argv];
    this.code = code;
    this.stderrText = text;
  }
}

export type FileMode = '100644' | '100755' | '120000' | '160000';
/** A leaf of a recursive tree, with its full repo-relative path. */
export interface TreeEntry { path: string; mode: FileMode; oid: Oid; }
export type TreeMap = ReadonlyMap<string, TreeEntry>;
export interface MktreeEntry { name: string; mode: FileMode | '040000'; type: 'blob' | 'tree' | 'commit'; oid: Oid; }
export type IndexEdit = { path: string; mode: FileMode; oid: Oid } | { path: string; remove: true };
export interface CommitSpec { tree: Oid; parents: readonly Oid[]; subject: string; trailers: readonly Trailer[]; }
export interface CommitInfo { oid: Oid; tree: Oid; parents: Oid[]; subject: string; trailers: Trailer[]; }
export interface RunOpts extends Partial<GitCallOptions> { okCodes?: readonly number[]; }

const TREE_CACHE_SIZE = 64;
const FILE_MODES: ReadonlySet<string> = new Set(['100644', '100755', '120000', '160000']);
const LOCAL_REF_PREFIXES: readonly string[] = ['refs/cowork-local/', 'refs/cowork-remote/'];

/**
 * A plain git refname under refs/, by git check-ref-format's rules: no control character or space, none of
 * `~ ^ : ? * [ \`, no `..`, `@{` or `//`, no trailing `/` or `.`, and no component that starts with `.` or ends
 * with `.lock` (anywhere in the path: `refs/heads/a.lock/b` is refused). An inner component may end with `.`
 * (`refs/heads/a./b` is valid to git). A '+' inside a name is legal (a branch `feat+x`); only pushSpec forbids it,
 * because a push refspec could spell a force with it. The one refname check: GitRepo's ref methods (readRef, casRef,
 * deleteLocalRef) and every network argv (fetchRefs, lsRemote, pushSpec, through netcall.ts) call it.
 */
export function checkRefName(what: string, ref: string): void {
  if (
    typeof ref !== 'string' || !ref.startsWith('refs/') || ref.length <= 'refs/'.length
    || ref.endsWith('/') || ref.endsWith('.') || ref.includes('..') || ref.includes('//') || ref.includes('@{')
    || /[\0-\x20\x7f~^:?*[\\]/.test(ref)
    || ref.split('/').some((c) => c.startsWith('.') || c.endsWith('.lock'))
  ) {
    throw new Error(`${what}: invalid ref ${JSON.stringify(ref)}`);
  }
}

function checkTreePath(p: string): void {
  if (p.length === 0 || p.includes('\0') || p.startsWith('/') || p.endsWith('/')) throw new Error(`invalid tree path ${JSON.stringify(p)}`);
}

/** Parses `<oid> <type> <size>\n<size bytes>\n` records of cat-file --batch; `<oid> missing` is an error. */
function parseBatch(out: Buffer, expected: number): Buffer[] {
  const items: Buffer[] = [];
  let pos = 0;
  while (items.length < expected) {
    const nl = out.indexOf(0x0a, pos);
    if (nl < 0) throw new Error('cat-file --batch: truncated output');
    const header = out.toString('utf8', pos, nl);
    const parts = header.split(' ');
    if (parts[1] === 'missing' || parts.length !== 3) throw new Error(`cat-file --batch: object missing or malformed header ${JSON.stringify(header)}`);
    const size = Number(parts[2]);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`cat-file --batch: bad size in ${JSON.stringify(header)}`);
    const start = nl + 1;
    if (start + size > out.length) throw new Error('cat-file --batch: truncated content');
    items.push(out.subarray(start, start + size));
    pos = start + size + 1;
  }
  return items;
}

/**
 * The records of `cat-file --batch --filters`, whose `<oid> blob <size>` headers carry the size BEFORE filtering while
 * the content after them is filtered (MEASURED, git 2.55.0.windows.3: a growing smudge filter and core.autocrlf=true
 * both), so a record's end is found at the next requested object's header, never by the size: record i is
 * `<oid_i> blob <n>\n<content>\n` and its content ends at the `\n` before `<oid_{i+1}> blob <n>\n`; the last ends at the
 * final `\n`. null when the split is not certain: any line shaped like a requested header beyond the n − 1 record
 * boundaries (content mimicking one), a header in the wrong place or a missing object.
 */
function splitFilteredBatch(out: Buffer, oids: readonly Oid[]): Buffer[] | null {
  const text = out.toString('latin1'); // one char per byte: indices are byte offsets
  const wanted = new Set<string>(oids);
  const bounds: number[] = [];
  for (const m of text.matchAll(/\n([0-9a-f]{40}|[0-9a-f]{64}) blob [0-9]+(?=\n)/g)) {
    if (wanted.has(m[1] as string)) bounds.push(m.index as number);
  }
  if (bounds.length !== oids.length - 1 || text.length === 0 || text[text.length - 1] !== '\n') return null;
  const items: Buffer[] = [];
  let pos = 0;
  for (let i = 0; i < oids.length; i++) {
    const nl = text.indexOf('\n', pos);
    if (nl < 0 || !new RegExp(`^${oids[i] as string} blob [0-9]+$`).test(text.slice(pos, nl))) return null;
    const end = i < oids.length - 1 ? (bounds[i] as number) : text.length - 1;
    if (end < nl + 1) return null;
    items.push(out.subarray(nl + 1, end));
    pos = end + 1;
  }
  return items;
}

/**
 * The object id of a commit header line's value, as git's get_oid_hex reads it: exactly `hexLength` hex digits of
 * either case (the repository's hash length, the commit's own oid length), returned lower-case in a string of its own
 * (never a slice of the commit text, which would keep the whole commit object alive with it); anything else throws.
 */
function headerOid(o: Oid, line: string, prefixLength: number, hexLength: number): Oid {
  const hex = line.slice(prefixLength);
  if (hex.length !== hexLength || !/^[0-9a-fA-F]+$/.test(hex)) throw new OidError(`commit ${o}: malformed header line ${JSON.stringify(line.slice(0, 80))}`);
  return parseOid(Buffer.from(hex.toLowerCase(), 'latin1').toString('latin1'));
}

/**
 * A commit object's content (as `cat-file commit` or one `cat-file --batch` record prints it) as CommitInfo: the tree,
 * the parents in order, and the subject and trailers by parseMessage. Shared by readCommit and the batched readers.
 * The header is read exactly as git's parse_commit_buffer reads it (final review FA-1), so cowork never sees another
 * tree or other parents than git does for a commit git (and fsck) accepts: the first line must be `tree <hex>`, the
 * parents are only the consecutive `parent <hex>` lines right after it, every later header (a second `tree`, a
 * `parent` after `author`/`committer`) is ignored, and hex digits of either case name the same (lower-case) oid.
 */
export function parseCommitObject(o: Oid, raw: string): CommitInfo {
  const split = raw.indexOf('\n\n');
  const header = split < 0 ? raw : raw.slice(0, split);
  const message = split < 0 ? '' : raw.slice(split + 2);
  const lines = header.split('\n');
  const first = lines[0] ?? '';
  if (!first.startsWith('tree ')) throw new Error(`commit ${o} has no tree line`);
  const tree = headerOid(o, first, 'tree '.length, o.length);
  const parents: Oid[] = [];
  for (let i = 1; i < lines.length && lines[i]!.startsWith('parent '); i++) parents.push(headerOid(o, lines[i]!, 'parent '.length, o.length));
  const { subject, trailers } = parseMessage(message);
  return { oid: o, tree, parents, subject, trailers };
}

export class GitRepo {
  readonly paths: RepoPaths;
  private readonly runner: GitRunner;
  private readonly ctx: () => RepoContext;
  private readonly trees = new Map<string, TreeMap>();
  private emptyTreeOid: Oid | undefined;

  constructor(runner: GitRunner, paths: RepoPaths, ctx: () => RepoContext) {
    this.runner = runner;
    this.paths = paths;
    this.ctx = ctx;
  }

  /** The runner call with the repo defaults; never throws on the exit code. */
  private exec(args: string[], opts: Partial<GitCallOptions> = {}): Promise<GitResult> {
    const c = this.ctx();
    const base: GitCallOptions = {
      class: 'local',
      cwd: this.paths.workTree,
      gitDir: this.paths.gitDir,
      filterDrivers: [...c.filterDrivers],
      ...(c.attrTree !== null ? { attrTree: c.attrTree } : {}),
    };
    return this.runner.run(args, { ...base, ...opts });
  }

  /** class 'local' and cwd = workTree unless given; filterDrivers and attrTree from ctx() unless given; rc not in okCodes (default [0]) throws GitCommandError. */
  async run(args: string[], opts: RunOpts = {}): Promise<GitResult> {
    const { okCodes, ...rest } = opts;
    const r = await this.exec(args, rest);
    if (!(okCodes ?? [0]).includes(r.code)) throw new GitCommandError(args, r.code, r.stderr);
    return r;
  }

  /** An oid printed by git: anything else (empty stdout after exit 128, garbage) is an OidError (ENG-09). */
  private oidFrom(r: GitResult, args: readonly string[]): Oid {
    try {
      return parseOid(r.stdout.toString('utf8'));
    } catch {
      throw new OidError(`git ${args.slice(0, 2).join(' ')} printed no object id (exit ${r.code})`);
    }
  }

  async resolve(rev: string): Promise<Oid | null> {
    if (rev.startsWith('-') || /[\0\r\n]/.test(rev)) throw new Error(`invalid revision ${JSON.stringify(rev)}`);
    const r = await this.run(['rev-parse', '--verify', '--quiet', rev], { okCodes: [0, 1] });
    return r.code === 0 ? parseOid(r.stdout.toString('utf8')) : null;
  }

  /** o exists and IS that type (`cat-file -t`, no peeling: a commit is not a 'tree'). */
  async hasObject(o: Oid, type: 'commit' | 'tree' | 'blob'): Promise<boolean> {
    parseOid(o);
    const r = await this.run(['cat-file', '-t', o], { okCodes: [0, 1, 128] });
    return r.code === 0 && r.stdout.toString('utf8').trim() === type;
  }

  async emptyTree(): Promise<Oid> {
    if (this.emptyTreeOid === undefined) {
      // Computed, not written: git knows the empty tree without storing it.
      const r = await this.run(['hash-object', '-t', 'tree', '--stdin', '--no-filters'], { stdin: Buffer.alloc(0) });
      this.emptyTreeOid = this.oidFrom(r, ['hash-object']);
    }
    return this.emptyTreeOid;
  }

  /** Route (c): hash-object [-w] --stdin --no-filters. */
  async hashBytes(bytes: Buffer, write: boolean): Promise<Oid> {
    const args = ['hash-object', ...(write ? ['-w'] : []), '--stdin', '--no-filters'];
    const r = await this.exec(args, { stdin: bytes });
    return this.oidFrom(r, args);
  }

  async readBlob(o: Oid): Promise<Buffer> {
    parseOid(o);
    return (await this.run(['cat-file', 'blob', o])).stdout;
  }

  async readBlobs(oids: readonly Oid[]): Promise<Buffer[]> {
    if (oids.length === 0) return [];
    for (const o of oids) parseOid(o);
    const r = await this.run(['cat-file', '--batch'], { stdin: Buffer.from(`${oids.join('\n')}\n`, 'utf8') });
    return parseBatch(r.stdout, oids.length);
  }

  /**
   * One `cat-file --batch --filters` call for the whole group (ruling R-36); cwd = the repo root, attr.tree and drivers
   * from the context. The batch headers carry the UNFILTERED size while the content is filtered (eol conversion, smudge),
   * so the output is split at the requested objects' headers (splitFilteredBatch); when content mimics such a header the
   * split is ambiguous and each item is smudged by its own exact `cat-file --filters --path=<p> <oid>` instead.
   */
  async smudgeBlobs(items: ReadonlyArray<{ oid: Oid; path: string }>): Promise<Buffer[]> {
    if (items.length === 0) return [];
    const lines = items.map((it) => {
      parseOid(it.oid);
      if (it.path.length === 0 || /[\0\r\n]/.test(it.path)) throw new Error(`invalid path for smudge ${JSON.stringify(it.path)}`);
      return `${it.oid} ${it.path}`;
    });
    const r = await this.run(['cat-file', '--batch', '--filters'], { class: 'attr', stdin: Buffer.from(`${lines.join('\n')}\n`, 'utf8') });
    const split = splitFilteredBatch(r.stdout, items.map((it) => it.oid));
    if (split !== null) return split;
    const out: Buffer[] = [];
    for (const it of items) out.push((await this.run(['cat-file', '--filters', `--path=${it.path}`, it.oid], { class: 'attr' })).stdout);
    return out;
  }

  async blobSizes(oids: readonly Oid[]): Promise<number[]> {
    if (oids.length === 0) return [];
    for (const o of oids) parseOid(o);
    const r = await this.run(['cat-file', '--batch-check'], { stdin: Buffer.from(`${oids.join('\n')}\n`, 'utf8') });
    const lines = r.stdout.toString('utf8').split('\n');
    return oids.map((_, i) => {
      const parts = (lines[i] ?? '').split(' ');
      if (parts.length !== 3 || parts[1] === 'missing') throw new Error(`cat-file --batch-check: object missing (${oids[i]})`);
      return Number(parts[2]);
    });
  }

  /** ls-tree -r -z --full-tree; an LRU cache of 64 trees by oid. */
  async readTreeMap(tree: Oid): Promise<TreeMap> {
    parseOid(tree);
    const hit = this.trees.get(tree);
    if (hit !== undefined) {
      this.trees.delete(tree);
      this.trees.set(tree, hit);
      return hit;
    }
    const r = await this.run(['ls-tree', '-r', '-z', '--full-tree', tree]);
    const map = new Map<string, TreeEntry>();
    for (const rec of r.stdout.toString('utf8').split('\0')) {
      if (rec.length === 0) continue;
      const tab = rec.indexOf('\t');
      const meta = rec.slice(0, tab).split(' ');
      const mode = meta[0] ?? '';
      const type = meta[1] ?? '';
      if (tab < 0 || meta.length !== 3 || !FILE_MODES.has(mode) || (type !== 'blob' && type !== 'commit')) {
        throw new Error(`ls-tree: unexpected record ${JSON.stringify(rec.slice(0, 120))}`);
      }
      const path = rec.slice(tab + 1);
      map.set(path, { path, mode: mode as FileMode, oid: parseOid(meta[2] ?? '') });
    }
    this.trees.set(tree, map);
    if (this.trees.size > TREE_CACHE_SIZE) {
      const oldest = this.trees.keys().next();
      if (oldest.done !== true) this.trees.delete(oldest.value);
    }
    return map;
  }

  /** Code trees: a fresh scratch index, update-index -z --index-info, write-tree (ENG-10 operations 3 and 1). */
  async writeTreeMap(entries: TreeMap, scratchIndex: string): Promise<Oid> {
    await this.run(['read-tree', '--empty'], { class: 'refupdate', indexFile: scratchIndex });
    await this.editIndex(scratchIndex, [...entries.values()].map((e) => ({ path: e.path, mode: e.mode, oid: e.oid })));
    return this.writeTree(scratchIndex);
  }

  /** read-tree of base into the scratch index, the edits, write-tree. */
  async editTree(base: Oid, edits: readonly IndexEdit[], scratchIndex: string): Promise<Oid> {
    await this.readTreeIntoIndex(scratchIndex, base);
    await this.editIndex(scratchIndex, edits);
    return this.writeTree(scratchIndex);
  }

  /** Metadata trees only (ruling R-15). */
  async mktree(entries: readonly MktreeEntry[]): Promise<Oid> {
    const parts = entries.map((e) => {
      parseOid(e.oid);
      if (e.name.length === 0 || /[\0/]/.test(e.name)) throw new Error(`invalid tree entry name ${JSON.stringify(e.name)}`);
      return `${e.mode} ${e.type} ${e.oid}\t${e.name}\0`;
    });
    const args = ['mktree', '-z'];
    const r = await this.exec(args, { stdin: Buffer.from(parts.join(''), 'utf8') });
    return this.oidFrom(r, args);
  }

  /**
   * commit-tree with the context identity (+0000), the context date in test builds, never signed (ENG-12).
   * `identity` replaces the context identity (only mergeTree's parentless wrapper commits, ruling R-30).
   */
  async commitTree(c: CommitSpec, identity?: GitIdentity): Promise<Oid> {
    const message = formatMessage(c.subject, c.trailers);
    const args = ['commit-tree', parseOid(c.tree)];
    for (const p of c.parents) args.push('-p', parseOid(p));
    const ctx = this.ctx();
    const r = await this.exec(args, { class: 'refupdate', identity: identity ?? ctx.identity, wallMsForDates: ctx.wallMs(), stdin: message });
    return this.oidFrom(r, args);
  }

  async readCommit(o: Oid): Promise<CommitInfo> {
    parseOid(o);
    return parseCommitObject(o, (await this.run(['cat-file', 'commit', o])).stdout.toString('utf8'));
  }

  /** The exact ref (never a rev-parse rule match); null when absent. */
  async readRef(ref: string): Promise<Oid | null> {
    if (!ref.startsWith('refs/')) return this.resolve(ref);
    checkRefName('readRef', ref);
    const r = await this.run(['for-each-ref', '--format=%(objectname) %(refname)', ref]);
    for (const line of r.stdout.toString('utf8').split('\n')) {
      const sp = line.indexOf(' ');
      if (sp > 0 && line.slice(sp + 1) === ref) return parseOid(line.slice(0, sp));
    }
    return null;
  }

  /** Every ref under prefix, sorted by ref name. */
  async listRefs(prefix: string): Promise<Array<{ ref: string; oid: Oid }>> {
    if (!prefix.startsWith('refs/')) throw new Error(`invalid ref prefix ${JSON.stringify(prefix)}`);
    const r = await this.run(['for-each-ref', '--format=%(objectname) %(refname)', prefix.replace(/\/+$/, '')]);
    const out: Array<{ ref: string; oid: Oid }> = [];
    for (const line of r.stdout.toString('utf8').split('\n')) {
      const sp = line.indexOf(' ');
      if (sp <= 0) continue;
      const ref = line.slice(sp + 1);
      if (ref.startsWith(prefix)) out.push({ ref, oid: parseOid(line.slice(0, sp)) });
    }
    return out;
  }

  /**
   * update-ref --create-reflog -m <reason> <ref> <next> <prev|zero oid> (class refupdate). Returns false
   * iff a re-read after a failure shows the ref is not at prev: the outcome decides, never git's text.
   */
  async casRef(ref: string, next: Oid, prev: Oid | null, reason: string): Promise<boolean> {
    checkRefName('casRef', ref);
    if (reason.length === 0 || /[\0\r\n]/.test(reason)) throw new Error('casRef: invalid reflog reason');
    parseOid(next);
    if (prev !== null) parseOid(prev);
    if (!(await this.hasObject(next, 'commit'))) throw new Error(`casRef: ${next} is not an existing commit`);
    const old = prev ?? '0'.repeat(next.length);
    const args = ['update-ref', '--create-reflog', '-m', reason, ref, next, old];
    const r = await this.exec(args, { class: 'refupdate', identity: this.ctx().identity });
    if (r.code === 0) return true;
    if ((await this.readRef(ref)) !== prev) return false;
    throw new GitCommandError(args, r.code, r.stderr);
  }

  /** Deletes a refs/cowork-local/* or refs/cowork-remote/* ref iff it still is at prev. */
  async deleteLocalRef(ref: string, prev: Oid): Promise<boolean> {
    checkRefName('deleteLocalRef', ref);
    if (!LOCAL_REF_PREFIXES.some((p) => ref.startsWith(p))) throw new Error(`deleteLocalRef: ${ref} is not a cowork ref`);
    parseOid(prev);
    const args = ['update-ref', '-d', ref, prev];
    const r = await this.exec(args, { class: 'refupdate', identity: this.ctx().identity });
    if (r.code === 0) return true;
    if ((await this.readRef(ref)) !== prev) return false;
    throw new GitCommandError(args, r.code, r.stderr);
  }

  /** rev-list --first-parent <tip> [^stop], newest first, at most max. */
  async firstParents(tip: Oid, stop: Oid | null, max: number): Promise<Oid[]> {
    parseOid(tip);
    if (stop !== null) parseOid(stop);
    if (!(max > 0)) return [];
    const args = ['rev-list', '--first-parent', `--max-count=${Math.floor(max)}`, tip];
    if (stop !== null) args.push(`^${stop}`);
    const r = await this.run(args);
    return r.stdout.toString('utf8').split('\n').filter((l) => l.length > 0).map((l) => parseOid(l));
  }

  async firstParentCount(tip: Oid): Promise<number> {
    parseOid(tip);
    const r = await this.run(['rev-list', '--first-parent', '--count', tip]);
    return Number(r.stdout.toString('utf8').trim());
  }

  /** Plain reachability: a is b or an ancestor of b through any parent. `rev-list b..a` is empty; never merge-base. */
  async isAncestor(a: Oid, b: Oid): Promise<boolean> {
    parseOid(a);
    parseOid(b);
    if (a === b) return true;
    const r = await this.run(['rev-list', '--max-count=1', `${b}..${a}`]);
    return r.stdout.toString('utf8').trim().length === 0;
  }

  /** The newest commit on tip's first-parent chain with a `<key>: ` line: one rev-list call, cost independent of chain length. */
  async newestWithTrailer(tip: Oid, key: string): Promise<Oid | null> {
    parseOid(tip);
    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(key)) throw new Error(`invalid trailer key ${JSON.stringify(key)}`);
    const r = await this.run(['rev-list', '--first-parent', '--max-count=1', `--grep=^${key}: `, tip]);
    const line = r.stdout.toString('utf8').trim();
    return line.length === 0 ? null : parseOid(line);
  }

  /** read-tree <tree> into the index file; never -u or -m (class refupdate). */
  async readTreeIntoIndex(indexFile: string, tree: Oid): Promise<void> {
    parseOid(tree);
    await this.run(['read-tree', tree], { class: 'refupdate', indexFile });
  }

  async writeTree(indexFile: string): Promise<Oid> {
    const args = ['write-tree'];
    const r = await this.exec(args, { indexFile });
    return this.oidFrom(r, args);
  }

  /** update-index --add --replace -z --index-info: whole-path replacement; `remove` writes mode 0. */
  async editIndex(indexFile: string, edits: readonly IndexEdit[]): Promise<void> {
    if (edits.length === 0) return;
    let zero: string | undefined;
    const lines: string[] = [];
    for (const e of edits) {
      checkTreePath(e.path);
      if ('remove' in e) {
        zero ??= '0'.repeat((await this.emptyTree()).length);
        lines.push(`0 ${zero}\t${e.path}\0`);
      } else {
        if (!FILE_MODES.has(e.mode)) throw new Error(`invalid file mode ${String(e.mode)}`);
        lines.push(`${e.mode} ${parseOid(e.oid)}\t${e.path}\0`);
      }
    }
    await this.run(['update-index', '--add', '--replace', '-z', '--index-info'], {
      class: 'refupdate',
      indexFile,
      stdin: Buffer.from(lines.join(''), 'utf8'),
    });
  }

  /** ls-files -s -z, stage 0 only, sorted by path as git lists them. */
  async listIndex(indexFile: string): Promise<Map<string, TreeEntry>> {
    const r = await this.run(['ls-files', '-s', '-z'], { indexFile });
    const out = new Map<string, TreeEntry>();
    for (const rec of r.stdout.toString('utf8').split('\0')) {
      if (rec.length === 0) continue;
      const tab = rec.indexOf('\t');
      const meta = rec.slice(0, tab).split(' ');
      if (tab < 0 || meta.length !== 3) throw new Error(`ls-files: unexpected record ${JSON.stringify(rec.slice(0, 120))}`);
      if (meta[2] !== '0') continue;
      const mode = meta[0] ?? '';
      if (!FILE_MODES.has(mode)) throw new Error(`ls-files: unexpected mode ${mode}`);
      const oid = meta[1] ?? '';
      if (!isOid(oid)) throw new OidError(`ls-files: bad oid ${JSON.stringify(oid)}`);
      const path = rec.slice(tab + 1);
      out.set(path, { path, mode: mode as FileMode, oid });
    }
    return out;
  }

  async configGet(key: string): Promise<string | null> {
    const r = await this.run(['config', '--get', key], { okCodes: [0, 1] });
    return r.code === 0 ? r.stdout.toString('utf8').replace(/\n$/, '') : null;
  }

  async configGetRegexp(regex: string): Promise<Array<{ key: string; value: string }>> {
    const r = await this.run(['config', '-z', '--get-regexp', regex], { okCodes: [0, 1] });
    if (r.code !== 0) return [];
    const out: Array<{ key: string; value: string }> = [];
    for (const rec of r.stdout.toString('utf8').split('\0')) {
      if (rec.length === 0) continue;
      const nl = rec.indexOf('\n');
      out.push(nl < 0 ? { key: rec, value: '' } : { key: rec.slice(0, nl), value: rec.slice(nl + 1) });
    }
    return out;
  }
}
