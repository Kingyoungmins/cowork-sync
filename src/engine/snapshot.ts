// The snapshot (01-engine §3.8; ENG-23…ENG-27; glossary §26.1 W1–W3, W6; rulings R-06, R-07, R-10, R-25, R-38).
// A detection tick (steps 1–6) finds stat-changed paths by metadata, stage-reads them, and computes ids without
// writing any object; materialize (steps 7–9) writes the dirty stage copies into the private index and the object
// store and produces S_raw and S_disk = canon(S_raw). No git process ever reads a working file: every content command
// names a stage copy (route (b), `--`) or runs with --work-tree=<tmp/stage>.
//
// Idle cost (01-engine §8 question 8): the private index is cached in memory and reloaded only when the index file's
// lstat changes, and the untracked listing (`ls-files -o`) reruns only when the lstat of a directory holding a known
// path changes, or UNTRACKED_RESCAN_MS after the last listing (a file created in a directory the snapshot did not know,
// such as a new empty directory, is found by then). A tick on an unchanged tree therefore reads no file and spawns
// no git.
//
// Carry-through (rulings P2-CARRY, P2-DOTGIT): a tracked path the staged read cannot address (validPathSyntax fails,
// or its non-UTF-8 bytes decode with U+FFFD), one with a dotgit-alias component on every platform (`GIT~1/config` is
// `.git/config` on Windows), one this OS cannot create (D7 rules 1–2 on Windows: `aux.c`, `trail.`; rule 3, the length,
// binds new paths only), and two tracked paths sharing one disk entry under different spellings on a case-insensitive
// volume (core.ignorecase: README.md + readme.md) are never looked at, read, hashed or staged as a removal; S_raw keeps
// A's entry (by raw path bytes for a U+FFFD name) and TickResult.carried lists them for not_converged. Exec bit (ruling
// P2-EXECBIT): with core.fileMode true (never on Windows), the owner-exec bit of the stat that describes the staged
// bytes decides 100755 / 100644, for new and tracked paths; a mode-only change is a change.
import { join } from 'node:path';
import type { PeerId } from '../board/ids.js';
import { AttrCache, type AttrSnapshot, type PathAttrs } from '../data/attrs.js';
import { hashNewPath, hashRouteB, hashRouteC, isFilterFailure } from '../data/blobRoutes.js';
import { canon } from '../data/canon.js';
import type { FilterSet } from '../data/filters.js';
import { admitNew, portable, scopeOfTracked, type NotSharedReason, type ScopeInputs } from '../data/scope.js';
import { isOid, parseOid, type Oid } from '../git/oid.js';
import { GitCommandError, type FileMode, type GitRepo, type IndexEdit, type TreeEntry, type TreeMap } from '../git/repo.js';
import type { Clock } from '../ports/clock.js';
import { crashpoint } from '../ports/crashpoint.js';
import { sameStat, type Fs, type FsLstat } from '../ports/fs.js';
import type { Trace } from '../ports/trace.js';
import type { AttributionPort } from './deps.js';
import { resetScratchIndex, STAGE_TREE_CONFIG } from './diskEq.js';
import { stageable, stagedRead, type StageDir } from './stagedRead.js';
import type { StatCache, StatEntry } from './statCache.js';
import { readTreeIndexOnly, verifyIndexEdits } from './treeEdit.js';

export const QUIET_MS = 300;
export const DELETE_CONFIRM_MS = 1_000;
export const SHRINK_RATIO = 0.5;
/** Ruling R-25: a shrink publishes once two ticks this far apart (Δmono) saw the same shrunken stat. */
export const SHRINK_STABLE_MS = 1_000;
/**
 * Backstop of the directory-stat gate on the untracked listing (see the file comment): below K = 20 loops of 2.5 s
 * (INV-CONVERGE), so a file the gate misses is still found before quiescence is judged.
 */
export const UNTRACKED_RESCAN_MS = 30_000;

export type Exclusion = 'unreadable' | 'unstable' | 'filter_failure' | 'shrink' | 'deletion_pending' | 'quiet';
export interface DirtyEntry { kind: 'modify' | 'new' | 'remove'; mode: FileMode; id: Oid | null; }
export interface SnapshotDeps {
  repo: GitRepo; fs: Fs; clock: Clock; trace: Trace; peer: PeerId;
  privateIndex: string;                          // <coworkDir>/<e>.index
  scratch: { detect: string; canon: string };    // absolute scratch indexes under tmp/
  stage: StageDir; statCache: StatCache; attribution: AttributionPort;
  filters: FilterSet;                            // ruling P2-SNAPFILTERS: required (discovered once at start; R-08 never changes EPOCH_BASE); overCap or an unknown driver → filter_failure exclusion (fail closed)
  /** Task 9 addition (P2-CARRY): the OS whose D7 rules decide which tracked paths cannot be created here; EngineDeps.platform, default process.platform. */
  platform?: NodeJS.Platform;
}
/**
 * aTree = A's tree oid (required, ruling P2-ATREE). A TreeMap decodes path bytes as UTF-8, so the raw spelling of a
 * non-UTF-8 path exists only in the tree object: materialize gives every carried U+FFFD path A's raw entry from it, so
 * such a path matches A byte for byte (an A-only one would otherwise be absent from S_raw and read as a deletion).
 */
export interface TickInput { A: TreeMap; aTree: Oid; epochBase: Oid; scope: ScopeInputs; skip: ReadonlySet<string>; }   // skip: Plan 5 fences (empty in Plan 2)
export interface TickResult {
  dirty: ReadonlyMap<string, DirtyEntry>;        // differs from S_raw, cumulative since the last materialization
  changed: ReadonlySet<string>;                  // dirty-set changes at this tick (ChangeSets.observe)
  excluded: ReadonlyMap<string, Exclusion>;      // per-loop exclusions: S_pub[p] := A[p], apply defers p
  notAdmitted: ReadonlyMap<string, NotSharedReason>;
  failed: boolean;                               // refresh rc ∉ {0,1} or diff-files failure: no capture/apply/publish this loop
  publishBlocked: boolean;                       // a filter failure this loop (ENG-24), including a P2-DRIVERCAP refusal
  /** Task 9 addition (P2-CARRY): tracked paths (A ∪ the private index) carried through this tick; listed in not_converged. */
  carried: ReadonlySet<string>;
}
export interface Materialized { sRaw: Oid; sDisk: Oid; sRawMap: TreeMap; sDiskMap: TreeMap; canonRefused: ReadonlySet<string>;
  excluded: ReadonlyMap<string, Exclusion>;      // materialize-time per-path exclusions (e.g. a route (b) -w rc 128): the path keeps its S_raw entry and stays dirty
  publishBlocked: boolean;                       // a filtered path failed at materialize (ENG-24): nothing publishes this loop
}

interface Candidate { path: string; entry: TreeEntry | null; st: FsLstat; }
/** A directory of the work tree as one tick saw it (FB-7): a real directory, absent, or a link/file/unreadable (never followed). */
type DirState = 'dir' | 'missing' | 'link';
/** mode: the mode the staged bytes are recorded with (P2-EXECBIT). */
interface Staged extends Candidate { bytes: Buffer; stat: FsLstat; filtered: boolean; mode: FileMode; }
interface FsInfo { fileMode: boolean; ignoreCase: boolean; }

const SPECIAL: ReadonlySet<string> = new Set(['160000', '120000']);
const FILE_MODES: ReadonlySet<string> = new Set(['100644', '100755', '120000', '160000']);
const NO_OTHERS: ReadonlySet<string> = new Set();
/** Ruling R-38: every git call on the private index (here: the untracked listing and route (a)). */
const PRIVATE_INDEX_CONFIG: Readonly<Record<string, string>> = Object.freeze({ 'core.untrackedCache': 'false' });
/**
 * The index-only calls on the private and canon indexes (read-tree, update-index --index-info, write-tree, ls-files
 * -s): R-38, plus core.protectNTFS=false, without which git for Windows refuses a tracked `aux.c`, `trail.`, `con` or
 * `dir/a:b` that a teammate's commit can hold (VERIFIED git 2.55.0.windows.3: read-tree rc 128 "invalid path",
 * update-index "Ignoring path"), so the private index could not hold A at all. No git process here writes a working
 * file (the engine never checks out), and such paths are carried through. Final review FB-6: protectNTFS=false does NOT
 * cover a ROOT name with a drive prefix (`a:b.txt`, `x:`; has_dos_drive_prefix runs whatever protectNTFS says): no index
 * can hold one on Windows, so reading such a tree and every index edit are checked (treeEdit.ts readTreeIndexOnly,
 * verifyIndexEdits) and fail as a typed IndexRefusedPathError, never a silent divergence of S_raw from A.
 */
const INDEX_ONLY_CONFIG: Readonly<Record<string, string>> = Object.freeze({ 'core.untrackedCache': 'false', 'core.protectNTFS': 'false' });

function tryGet(a: AttrSnapshot, p: string): PathAttrs | undefined {
  try {
    return a.get(p);
  } catch {
    return undefined;
  }
}

function sameDirty(a: DirtyEntry | undefined, b: DirtyEntry | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.kind === b.kind && a.mode === b.mode && a.id === b.id;
}

/** '' (the root) and every directory prefix of the path. */
function parentDirs(path: string, out: Set<string>): void {
  out.add('');
  const bare = path.endsWith('/') ? path.slice(0, -1) : path;
  let slash = bare.indexOf('/');
  while (slash >= 0) {
    out.add(bare.slice(0, slash));
    slash = bare.indexOf('/', slash + 1);
  }
}

function sameOrBothNull(a: FsLstat | null, b: FsLstat | null): boolean {
  return a === null || b === null ? a === b : sameStat(a, b);
}

/** P2-EXECBIT: with core.fileMode in force the owner-exec bit decides; otherwise a tracked path keeps its mode. */
function diskMode(st: FsLstat, entry: TreeEntry | null, fileMode: boolean): FileMode {
  if (!fileMode) return entry?.mode ?? '100644';
  return (st.mode & 0o100) !== 0 ? '100755' : '100644';
}

/** A git boolean config value (`git config --type=bool` rules); `dflt` when unset or unparsable. */
function gitBool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined) return dflt;
  const s = v.trim().toLowerCase();
  if (s === '' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === 'no' || s === 'off') return false;
  return /^-?\d+$/.test(s) ? Number(s) !== 0 : dflt;
}

/**
 * DAT-29 on a case-insensitive volume (D7 rule 4's comparison, spelling-aware): tracked paths that share one disk
 * entry with another tracked path under a different spelling. p is marked when another FILE spelling folds equal to it
 * (README.md + readme.md read one disk file), when a directory prefix folds equal to p with a spelling other than p
 * (NOTES + notes/x.md), or when one of p's own prefixes folds equal to a file spelled otherwise than that prefix. The
 * same spelling as a file in A and as a directory in the private index (`config` replaced by `config/app.json`) is one
 * change over time, not a collision; two directory spellings (Docs/a + docs/b) share a directory but no file.
 */
export function caseCollisions(paths: ReadonlySet<string>): Set<string> {
  const fold = (x: string): string => x.normalize('NFC').toUpperCase().toLowerCase();
  const add = (m: Map<string, Set<string>>, spelling: string): void => {
    const k = fold(spelling);
    let s = m.get(k);
    if (s === undefined) m.set(k, (s = new Set()));
    s.add(spelling);
  };
  const otherSpelling = (m: Map<string, Set<string>>, spelling: string): boolean => {
    for (const s of m.get(fold(spelling)) ?? []) if (s !== spelling) return true;
    return false;
  };
  const files = new Map<string, Set<string>>();
  const dirs = new Map<string, Set<string>>();
  for (const p of paths) {
    add(files, p);
    for (let i = p.indexOf('/'); i >= 0; i = p.indexOf('/', i + 1)) add(dirs, p.slice(0, i));
  }
  const out = new Set<string>();
  for (const p of paths) {
    let hit = otherSpelling(files, p) || otherSpelling(dirs, p);
    for (let i = p.indexOf('/'); !hit && i >= 0; i = p.indexOf('/', i + 1)) hit = otherSpelling(files, p.slice(0, i));
    if (hit) out.add(p);
  }
  return out;
}

/**
 * The P2-CARRY causes one path has on its own: not stageable (invalid syntax, U+FFFD, a dotgit-alias component, on
 * every platform) or, on Windows, not creatable by D7 rules 1–2. Rule 3 (over 200 code units) binds new paths only:
 * glossary §18 forces core.longpaths=true, so a long tracked path is creatable and synced.
 */
function carriedAlone(path: string, windows: boolean): boolean {
  if (!stageable(path)) return true;
  if (!windows) return false;
  const r = portable(path, NO_OTHERS);
  return !r.ok && r.rule !== 3;
}

/**
 * Ruling P2-ATREE: an input without A's tree oid (a cast, plain JS) is refused (OidError) before anything is read or
 * written; there is no fallback that could leave an A-only non-UTF-8 path out of S_raw.
 */
function requireATree(inp: TickInput): void {
  parseOid(inp.aTree);
}

/** One `update-index -z --index-info` line: `<mode> SP <oid> TAB <path bytes> NUL`. */
function rawIndexLine(mode: string, oid: string, path: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${mode} ${oid}\t`, 'utf8'), path, Buffer.from([0])]);
}

/** A raw index or tree entry: the path bytes as git stores them, and their UTF-8 decoding (the TreeMap key). */
interface RawEntry { key: string; raw: Buffer; mode: FileMode; oid: Oid; }

/**
 * Records of `ls-files -s -z` (`<mode> <oid> <stage>\t<path>`, stage 0 kept) or `ls-tree -r -z`
 * (`<mode> <type> <oid>\t<path>`) whose decoded path is in `keys`, split on NUL bytes before any decoding so that
 * path bytes that are not UTF-8 survive.
 */
function rawEntries(out: Buffer, form: 'index' | 'tree', keys: ReadonlySet<string>): RawEntry[] {
  const res: RawEntry[] = [];
  for (let pos = 0; pos < out.length;) {
    const end = out.indexOf(0, pos);
    const rec = out.subarray(pos, end < 0 ? out.length : end);
    pos = end < 0 ? out.length : end + 1;
    if (rec.length === 0) continue;
    const tab = rec.indexOf(0x09);
    const meta = (tab < 0 ? '' : rec.toString('latin1', 0, tab)).split(' ');
    const mode = meta[0] ?? '';
    const oid = form === 'index' ? meta[1] : meta[2];
    if (tab < 0 || meta.length !== 3 || !FILE_MODES.has(mode) || !isOid(oid)) throw new Error(`${form === 'index' ? 'ls-files' : 'ls-tree'}: unexpected record`);
    if (form === 'index' && meta[2] !== '0') continue;
    const raw = Buffer.from(rec.subarray(tab + 1));
    const key = raw.toString('utf8');
    if (keys.has(key)) res.push({ key, raw, mode: mode as FileMode, oid });
  }
  return res;
}

export class Snapshotter {
  private readonly d: SnapshotDeps;
  private readonly attrs: AttrCache;
  private readonly dirty = new Map<string, DirtyEntry>();
  /** Future-mtime paths waiting for QUIET_MS of unchanged stat (Δmono). */
  private readonly future = new Map<string, { stat: FsLstat; firstMono: number }>();
  private index: { stat: FsLstat | null; map: Map<string, TreeEntry> } | null = null;
  private listing: { entries: string[]; dirs: Map<string, FsLstat | null>; mono: number } | null = null;
  private detectKey: string | null = null;
  private lastMat: Materialized | null = null;
  /** core.fileMode (never on Windows) and core.ignorecase, read once. */
  private info: FsInfo | null = null;
  /** The P2-CARRY set, recomputed when the private index map or A is a new object. */
  private carry: { index: ReadonlyMap<string, TreeEntry>; A: TreeMap; set: ReadonlySet<string> } | null = null;
  /** tipCollisions' last answer, per TIP map object. */
  private tipColl: { tip: TreeMap; set: ReadonlySet<string> } | null = null;

  constructor(d: SnapshotDeps) {
    this.d = d;
    this.attrs = new AttrCache(d.repo, d.fs);
  }

  last(): Materialized | null {
    return this.lastMat;
  }

  /**
   * Task 9 addition (P2-CARRY for DiskEqDeps.isCarried): p is in the carry set of the last tick or materialize, or
   * carried by its name alone (not stageable, a dotgit alias, not creatable on this OS). Before the first tick only
   * the name causes are known: a case collision needs A ∪ the private index.
   */
  isCarried(path: string): boolean {
    return (this.carry?.set.has(path) ?? false) || carriedAlone(path, this.windows());
  }

  /**
   * Final review (ledger Task 13:234): on a case-insensitive volume (core.ignorecase), the paths of `tip` that share one
   * disk entry with another spelling inside `tip` itself (Foo + foo from a teammate on a case-sensitive OS, or an NFC
   * pair): no write can give each its own file (the second create fails EEXIST), so the apply treats them as not
   * applicable 'unmaterializable' instead of deferring their whole change-set race forever. TIP-internal only: A ∪ TIP
   * would wedge every case-only rename (README.md → readme.md). Memoized per map object.
   */
  async tipCollisions(tip: TreeMap): Promise<ReadonlySet<string>> {
    if (this.tipColl !== null && this.tipColl.tip === tip) return this.tipColl.set;
    const set: ReadonlySet<string> = (await this.fsInfo()).ignoreCase ? caseCollisions(new Set(tip.keys())) : NO_OTHERS;
    this.tipColl = { tip, set };
    return set;
  }

  /** After a verified write (round trip): p's disk bytes are `id`, and its stat is `stat`. */
  markClean(path: string, stat: FsLstat, id: Oid): void {
    this.d.statCache.set(path, { stat, id, state: 'clean' });
    this.dirty.delete(path);
    this.future.delete(path);
  }

  /** read-tree into the private index; stat cache and stage dir emptied. */
  async reseed(tree: Oid): Promise<void> {
    await this.readTreeInto(this.d.privateIndex, tree);
    this.d.statCache.clear();
    await this.d.stage.clear();
    this.dirty.clear();
    this.future.clear();
    this.index = null;
    this.listing = null;
    this.detectKey = null;
    this.lastMat = null;
    this.carry = null;
  }

  /** Steps 1–6: a detection tick; writes no object (route (a) does not run; routes (b)/(c) without -w). */
  async tick(inp: TickInput): Promise<TickResult> {
    requireATree(inp);
    const { fs, statCache } = this.d;
    const now = this.d.clock.monoMs();
    const wall = this.d.clock.wallMs();
    const before = new Map(this.dirty);
    const excluded = new Map<string, Exclusion>();
    const notAdmitted = new Map<string, NotSharedReason>();
    let failed = false;
    let publishBlocked = false;

    // 1. Candidates from metadata only: tracked paths whose lstat differs from the stat cache, plus admitted new files.
    const index = await this.loadIndex();
    const info = await this.fsInfo();
    const carried = this.carriedPaths(index, inp.A, info);
    for (const p of carried) if (this.dirty.has(p) || statCache.get(p) !== undefined) await this.forget(p);
    const listed = await this.untracked(index, now, carried);
    if (listed === null) failed = true;
    const untracked = (listed ?? this.listing?.entries ?? []).filter((p) => !index.has(p));
    const untrackedSet = new Set(untracked);

    // Final review FB-7 (the read side of P2-NOFOLLOW): a path beneath a symlink, a junction or a file is never read or
    // staged as a removal — lstat and readFile would resolve the link and read bytes from outside the work tree. Checked
    // for every candidate (an unchanged stat reads nothing), one lstat per directory per tick.
    const dirs = new Map<string, DirState>();
    const trackedCands: Array<{ path: string; entry: TreeEntry; st: FsLstat | null }> = [];
    for (const [p, entry] of index) {
      if (inp.skip.has(p) || carried.has(p)) continue; // P2-CARRY: never looked at, read, hashed or staged as a removal
      let st: FsLstat | null;
      try {
        st = await fs.lstat(this.workFile(p));
      } catch {
        this.endAbsence(p); // an lstat error is not an absence: the deletion confirmation starts over
        excluded.set(p, 'unreadable');
        continue;
      }
      if (st !== null && st.isDirectory) st = null; // a directory where the file was: the file is gone
      if (st !== null) this.endAbsence(p);
      if (this.unchanged(p, st)) continue;
      if (await this.beneathLink(p, dirs)) {
        this.endAbsence(p); // not an absence either: the file is unreachable, not gone
        excluded.set(p, 'unreadable');
        continue;
      }
      trackedCands.push({ path: p, entry, st });
    }
    const newCands: Array<{ path: string; st: FsLstat | null }> = [];
    for (const p of untracked) {
      if (inp.skip.has(p) || carried.has(p)) continue; // an A-only carried path found on disk is not a new file either
      if (p.endsWith('/')) {
        newCands.push({ path: p, st: null });
        continue;
      }
      if (!stageable(p)) {
        // P2-DOTGIT (GIT~1/x is .git/x on Windows), U+FFFD, invalid syntax: never admitted (D7) and never looked at.
        notAdmitted.set(p, 'portability');
        if (this.dirty.has(p)) await this.forget(p);
        continue;
      }
      if (await this.beneathLink(p, dirs)) {
        // FB-7: a listed path beneath a link is never read either (git lists none; a junction it may not know).
        if (this.dirty.get(p)?.kind === 'new') await this.drop(p);
        excluded.set(p, 'unreadable');
        continue;
      }
      let st: FsLstat | null;
      try {
        st = await fs.lstat(this.workFile(p));
      } catch {
        excluded.set(p, 'unreadable');
        continue;
      }
      if (st === null) {
        // Gone, decided by the lstat: the listing may be stale (it reruns only on a directory change or the backstop).
        if (this.dirty.get(p)?.kind === 'new') await this.drop(p);
        continue;
      }
      newCands.push({ path: p, st });
    }
    // A dirty new path that is neither tracked nor listed any more simply leaves the dirty set.
    for (const [p, de] of [...this.dirty]) {
      if (de.kind === 'new' && !index.has(p) && !untrackedSet.has(p)) await this.drop(p);
    }

    const attrOf = await this.attrLookup(inp, [...trackedCands.map((c) => c.path), ...newCands.filter((c) => !c.path.endsWith('/')).map((c) => c.path)]);
    const scope: ScopeInputs = { ...inp.scope, attrs: { epochBase: inp.epochBase, get: attrOf } };
    const removed = new Set([...this.dirty].filter(([, de]) => de.kind === 'remove').map(([p]) => p));
    const others = new Set<string>([...[...index.keys()].filter((p) => !removed.has(p)), ...untracked]);

    const toRead: Candidate[] = [];
    for (const c of trackedCands) {
      const sc = scopeOfTracked(c.path, c.entry.mode, c.st?.size ?? 0, scope);
      if (sc.cls === 'UNMANAGED') continue; // carry-through: never read, hashed or staged as a removal (DAT-26)
      if (this.filterRefused(attrOf(c.path))) {
        // P2-SNAPFILTERS, before any removal logic: a deleted filtered file is not staged as a removal either.
        excluded.set(c.path, 'filter_failure');
        publishBlocked = true;
        continue;
      }
      if (c.st === null) {
        await this.missing(c.path, c.entry, now, excluded);
        continue;
      }
      if (this.quiet(c.path, c.st, now, wall)) {
        excluded.set(c.path, 'quiet');
        continue;
      }
      toRead.push({ path: c.path, entry: c.entry, st: c.st });
    }
    for (const c of newCands) {
      const sc = admitNew(c.path, c.st?.size ?? 0, c.st?.isSymbolicLink ?? false, others, scope);
      if (sc.cls !== 'LIVE') {
        notAdmitted.set(c.path, sc.reason ?? 'quarantine');
        if (this.dirty.get(c.path)?.kind === 'new') await this.drop(c.path);
        continue;
      }
      const st = c.st as FsLstat;
      if (this.unchanged(c.path, st)) continue;
      if (this.quiet(c.path, st, now, wall)) {
        excluded.set(c.path, 'quiet');
        continue;
      }
      if (this.filterRefused(attrOf(c.path))) {
        excluded.set(c.path, 'filter_failure');
        publishBlocked = true;
        continue;
      }
      toRead.push({ path: c.path, entry: null, st });
    }

    // 4. Staged reads, all before the first content git call (an unreadable path is refused at its open).
    const ok: Staged[] = [];
    for (const c of toRead) {
      const r = await stagedRead(fs, this.workFile(c.path));
      if (r.kind === 'ok') {
        ok.push({ ...c, bytes: r.bytes, stat: r.stat, filtered: attrOf(c.path).filter !== null, mode: diskMode(r.stat, c.entry, info.fileMode) });
      } else if (r.kind === 'missing') {
        if (c.entry !== null) await this.missing(c.path, c.entry, now, excluded);
      } else {
        excluded.set(c.path, r.kind);
      }
    }

    // 6. Shrink guard on the staged size (glossary §26.1 W2, ruling R-25), before any hashing.
    const refSizes = await this.referenceSizes(ok);
    const staged: Staged[] = [];
    for (const c of ok) {
      if (this.shrinkHeld(c, refSizes.get(c.path) ?? null, now)) {
        excluded.set(c.path, 'shrink');
        continue;
      }
      await this.d.stage.write(c.path, c.bytes);
      staged.push(c);
    }

    // 5. Detect: ids only, no object written.
    const U = staged.filter((c) => c.entry !== null && !c.filtered);
    const F = staged.filter((c) => c.entry !== null && c.filtered);
    const N = staged.filter((c) => c.entry === null);
    if (U.length > 0) {
      const differ = await this.differing(U.map((c) => c.entry as TreeEntry), inp);
      if (differ === null) {
        failed = true;
      } else {
        for (const c of U) {
          const e = c.entry as TreeEntry;
          if (!differ.has(c.path)) {
            // Same content as S_raw: clean, unless only the exec bit changed (P2-EXECBIT; the id is S_raw's blob).
            if (c.mode === e.mode) await this.clean(c);
            else this.markDirty(c, { kind: 'modify', mode: c.mode, id: e.oid });
            continue;
          }
          const id = await hashRouteB(this.d.repo, c.path, this.d.stage.abs(c.path), false);
          if (isFilterFailure(id)) {
            // Ruling (Task 3): an rc 128 on an unfiltered path is a per-path exclusion for this tick, never a block.
            excluded.set(c.path, 'unreadable');
            await this.discardCopy(c.path);
            continue;
          }
          this.markDirty(c, { kind: 'modify', mode: c.mode, id });
        }
      }
    }
    for (const c of F) {
      const id = await hashRouteB(this.d.repo, c.path, this.d.stage.abs(c.path), false);
      if (isFilterFailure(id)) {
        excluded.set(c.path, 'filter_failure');
        publishBlocked = true;
        await this.discardCopy(c.path);
        continue;
      }
      const e = c.entry as TreeEntry;
      if (id === e.oid && c.mode === e.mode) await this.clean(c);
      else this.markDirty(c, { kind: 'modify', mode: c.mode, id });
    }
    for (const c of N) {
      const id = await hashNewPath(this.d.repo, c.path, this.d.stage.abs(c.path), false);
      if (isFilterFailure(id)) {
        excluded.set(c.path, c.filtered ? 'filter_failure' : 'unreadable');
        if (c.filtered) publishBlocked = true;
        await this.discardCopy(c.path);
        continue;
      }
      this.markDirty(c, { kind: 'new', mode: c.mode, id });
    }

    // Stat-cache entries of paths that are neither tracked nor listed (removals already materialized) are dropped.
    for (const [p] of [...statCache.entries()]) {
      if (!index.has(p) && !untrackedSet.has(p) && !this.dirty.has(p)) statCache.delete(p);
    }
    for (const p of [...this.future.keys()]) if (!index.has(p) && !untrackedSet.has(p)) this.future.delete(p);

    const changed = new Set<string>();
    for (const p of new Set([...before.keys(), ...this.dirty.keys()])) {
      if (!sameDirty(before.get(p), this.dirty.get(p))) changed.add(p);
    }
    return { dirty: new Map(this.dirty), changed, excluded, notAdmitted, failed, publishBlocked, carried: new Set(carried) };
  }

  /** Steps 7–9: route (a) add --ignore-errors --pathspec-from-file=- --pathspec-file-nul of dirty unfiltered copies (--work-tree=<tmp/stage>, literal pathspecs), route (b) -w + --cacheinfo for filtered ones, removals, 160000/120000 forced to A, crashpoint('snapshot.index_written'), write-tree → S_raw, canon in tmp/canon.index → S_disk. `only` = a record's paths (occasion (c)). */
  async materialize(inp: TickInput, only?: ReadonlySet<string>): Promise<Materialized> {
    requireATree(inp);
    const { repo, stage, privateIndex } = this.d;
    const index = await this.loadIndex();
    const carried = this.carriedPaths(index, inp.A, await this.fsInfo());
    const targets = [...this.dirty].filter(([p]) => (only === undefined || only.has(p)) && !carried.has(p));
    const attrOf = await this.attrLookup(inp, targets.filter(([, de]) => de.kind !== 'remove').map(([p]) => p));
    const failedPaths = new Map<string, Exclusion>();
    let publishBlocked = false;
    const edits: IndexEdit[] = [];
    const done = new Map<string, Oid | null>();
    const routeA: string[] = [];

    for (const [p, de] of targets) {
      if (de.kind === 'remove') {
        edits.push({ path: p, remove: true });
        done.set(p, null);
        continue;
      }
      if ((await this.d.fs.lstat(stage.abs(p))) === null) {
        // The stage copy is gone (an AV quarantine, a cleaned tmp/): unreadable now, and p leaves the dirty set and the
        // stat cache so the next tick reads it again (final review minor, ledger Task 9:155: kept dirty with its stat,
        // p looked unchanged to every later tick and was excluded at every materialize, never captured).
        failedPaths.set(p, 'unreadable');
        await this.drop(p);
        continue;
      }
      const filtered = attrOf(p).filter !== null;
      if (de.kind === 'modify' && !filtered) {
        routeA.push(p);
        continue;
      }
      const h = de.kind === 'new' ? await hashNewPath(repo, p, stage.abs(p), true) : await hashRouteB(repo, p, stage.abs(p), true);
      if (isFilterFailure(h)) {
        failedPaths.set(p, filtered ? 'filter_failure' : 'unreadable');
        if (filtered) publishBlocked = true;
        continue;
      }
      edits.push({ path: p, mode: de.mode, oid: h });
      done.set(p, h);
    }

    if (routeA.length > 0) {
      const r = await repo.run(['add', '--ignore-errors', '--pathspec-from-file=-', '--pathspec-file-nul'], {
        class: 'refupdate', indexFile: privateIndex, workTree: stage.root, literalPathspecs: true, attrTree: inp.epochBase,
        config: { ...STAGE_TREE_CONFIG, ...PRIVATE_INDEX_CONFIG },
        stdin: Buffer.from(routeA.map((p) => `${p}\0`).join(''), 'utf8'),
        okCodes: [0, 1],
      });
      const after = await this.lsIndex(privateIndex);
      // rc 1: a path git could not index is found by structure (still differing from its copy), never by text.
      const stuck = r.code === 1 ? await this.differing(routeA.flatMap((p) => { const e = after.get(p); return e === undefined ? [] : [e]; }), inp) : new Set<string>();
      for (const p of routeA) {
        const e = after.get(p);
        if (e === undefined || stuck === null || stuck.has(p)) {
          failedPaths.set(p, 'unreadable');
          continue;
        }
        done.set(p, e.oid);
        // add keeps the index entry's mode (core.fileMode=false on the stage tree): the recorded mode is the tick's (P2-EXECBIT).
        const mode = this.dirty.get(p)?.mode ?? e.mode;
        if (mode !== e.mode) edits.push({ path: p, mode, oid: e.oid });
      }
    }

    // DAT-36/37: every 160000 entry := A's value; every 120000 entry keeps A's mode and target. P2-CARRY: every carried
    // path keeps A's entry too, the same rule for every cause. A name holding U+FFFD is edited by its raw bytes
    // (rawCarryEdits): its decoded string, written back as UTF-8, would name another path.
    const forced = new Set<string>();
    for (const [p, e] of inp.A) if (SPECIAL.has(e.mode)) forced.add(p);
    for (const [p, e] of index) if (SPECIAL.has(e.mode)) forced.add(p);
    for (const p of carried) forced.add(p);
    const fffd = new Set<string>();
    for (const p of forced) {
      if (p.includes('\u{fffd}')) {
        fffd.add(p);
        continue;
      }
      const a = inp.A.get(p);
      const cur = index.get(p);
      if (a === undefined) {
        if (cur !== undefined) edits.push({ path: p, remove: true });
      } else if (cur === undefined || cur.oid !== a.oid || cur.mode !== a.mode) {
        edits.push({ path: p, mode: a.mode, oid: a.oid });
      }
    }
    const rawEdits = fffd.size > 0 ? await this.rawCarryEdits(fffd, inp) : [];
    await this.editIndexFile(privateIndex, edits, inp.epochBase.length, rawEdits);
    this.index = null; // the private index changed: reload (and relist) next time
    crashpoint('snapshot.index_written');

    const sRaw = await this.writeTreeOf(privateIndex);
    const sRawMap = await repo.readTreeMap(sRaw);
    const { sDisk, sDiskMap, canonRefused } = await this.canonTree(inp, sRaw, sRawMap, carried);

    for (const [p, oid] of done) {
      this.dirty.delete(p);
      if (oid === null) {
        this.d.statCache.delete(p);
        continue;
      }
      const ce = this.d.statCache.get(p);
      this.d.statCache.set(p, { stat: ce?.stat ?? null, id: sRawMap.get(p)?.oid ?? oid, state: 'clean' });
      await stage.remove(p);
    }
    const m: Materialized = { sRaw, sDisk, sRawMap, sDiskMap, canonRefused, excluded: failedPaths, publishBlocked };
    this.lastMat = m;
    return m;
  }

  // ---- internals -------------------------------------------------------------------------------

  /**
   * Final review FB-7: true when an existing ancestor of p below the work-tree root is a symlink, a junction or not a
   * directory, or cannot be lstat'd (fail closed); a missing ancestor ends the walk (p is simply absent). `dirs` memoizes
   * each directory's state for one tick.
   */
  private async beneathLink(path: string, dirs: Map<string, DirState>): Promise<boolean> {
    const parts = path.split('/');
    let rel = '';
    for (const c of parts.slice(0, -1)) {
      rel = rel === '' ? c : `${rel}/${c}`;
      let state = dirs.get(rel);
      if (state === undefined) {
        try {
          const st = await this.d.fs.lstat(this.workFile(rel));
          state = st === null ? 'missing' : st.isSymbolicLink || !st.isDirectory ? 'link' : 'dir';
        } catch {
          state = 'link';
        }
        dirs.set(rel, state);
      }
      if (state === 'link') return true;
      if (state === 'missing') return false;
    }
    return false;
  }

  private workFile(path: string): string {
    return join(this.d.repo.paths.workTree, ...path.split('/'));
  }

  /** The private index (S_raw entries), reloaded only when the index file's lstat changed. */
  private async loadIndex(): Promise<Map<string, TreeEntry>> {
    let st: FsLstat | null;
    try {
      st = await this.d.fs.lstat(this.d.privateIndex);
    } catch {
      st = null;
    }
    if (this.index !== null && sameOrBothNull(this.index.stat, st)) return this.index.map;
    const map = await this.lsIndex(this.d.privateIndex);
    this.index = { stat: st, map };
    this.listing = null; // paths may have moved between tracked and untracked
    return map;
  }

  // Index-only plumbing with INDEX_ONLY_CONFIG (R-38; protectNTFS, see its comment). GitRepo's listIndex, editIndex,
  // writeTree and readTreeIntoIndex take no per-call config, so the snapshot runs the same commands itself.

  /** ls-files -s -z, stage 0 only. */
  private async lsIndex(indexFile: string): Promise<Map<string, TreeEntry>> {
    const r = await this.d.repo.run(['ls-files', '-s', '-z'], { indexFile, config: INDEX_ONLY_CONFIG });
    const out = new Map<string, TreeEntry>();
    for (const rec of r.stdout.toString('utf8').split('\0')) {
      if (rec.length === 0) continue;
      const tab = rec.indexOf('\t');
      const [mode, oid, stage, extra] = tab < 0 ? [] : rec.slice(0, tab).split(' ');
      if (mode === undefined || !FILE_MODES.has(mode) || !isOid(oid) || stage === undefined || extra !== undefined) {
        throw new Error(`ls-files: unexpected record ${JSON.stringify(rec.slice(0, 120))}`);
      }
      if (stage !== '0') continue;
      const path = rec.slice(tab + 1);
      out.set(path, { path, mode: mode as FileMode, oid });
    }
    return out;
  }

  /**
   * update-index --add --replace -z --index-info: whole-path replacement; a removal is mode 0 with a zero oid of
   * `oidLength` hex digits. `raw`: further lines already encoded (rawIndexLine), for path bytes that are not UTF-8.
   * Final review FB-6: every `edits` entry is read back (an "ignored" path exits 0): IndexRefusedPathError otherwise.
   */
  private async editIndexFile(indexFile: string, edits: readonly IndexEdit[], oidLength: number, raw: readonly Buffer[] = []): Promise<void> {
    if (edits.length === 0 && raw.length === 0) return;
    const zero = '0'.repeat(oidLength);
    const lines = edits.map((e) => ('remove' in e ? rawIndexLine('0', zero, Buffer.from(e.path, 'utf8')) : rawIndexLine(e.mode, parseOid(e.oid), Buffer.from(e.path, 'utf8'))));
    const argv = ['update-index', '--add', '--replace', '-z', '--index-info'];
    await this.d.repo.run(argv, { class: 'refupdate', indexFile, config: INDEX_ONLY_CONFIG, stdin: Buffer.concat([...lines, ...raw]) });
    await verifyIndexEdits(this.d.repo, indexFile, edits, INDEX_ONLY_CONFIG, argv);
  }

  /**
   * P2-CARRY for names holding U+FFFD: index lines, by raw path bytes, that give each such key exactly A's raw entries,
   * read from A's tree object (`ls-tree -r -z <inp.aTree>`, ruling P2-ATREE).
   */
  private async rawCarryEdits(keys: ReadonlySet<string>, inp: TickInput): Promise<Buffer[]> {
    const { repo, privateIndex } = this.d;
    const cur = rawEntries((await repo.run(['ls-files', '-s', '-z'], { indexFile: privateIndex, config: INDEX_ONLY_CONFIG })).stdout, 'index', keys);
    const want = rawEntries((await repo.run(['ls-tree', '-r', '-z', '--full-tree', parseOid(inp.aTree)])).stdout, 'tree', keys);
    const id = (e: RawEntry): string => e.raw.toString('latin1');
    const wanted = new Set(want.map(id));
    const have = new Map(cur.map((e) => [id(e), e]));
    const zero = '0'.repeat(inp.epochBase.length);
    const out: Buffer[] = [];
    for (const e of cur) if (!wanted.has(id(e))) out.push(rawIndexLine('0', zero, e.raw));
    for (const e of want) {
      const h = have.get(id(e));
      if (h === undefined || h.mode !== e.mode || h.oid !== e.oid) out.push(rawIndexLine(e.mode, e.oid, e.raw));
    }
    return out;
  }

  private async writeTreeOf(indexFile: string): Promise<Oid> {
    const r = await this.d.repo.run(['write-tree'], { indexFile, config: INDEX_ONLY_CONFIG });
    return parseOid(r.stdout.toString('utf8'));
  }

  /** Final review FB-6: a tree whose root holds a name git refuses in any index is an IndexRefusedPathError naming it. */
  private async readTreeInto(indexFile: string, tree: Oid): Promise<void> {
    await readTreeIndexOnly(this.d.repo, tree, indexFile, INDEX_ONLY_CONFIG);
  }

  /** core.fileMode (git's default true; never trusted on Windows, whose lstat has no exec bit) and core.ignorecase. */
  private async fsInfo(): Promise<FsInfo> {
    if (this.info !== null) return this.info;
    const rows = await this.d.repo.configGetRegexp('^core\\.(filemode|ignorecase)$');
    const last = (key: string): string | undefined => {
      let v: string | undefined;
      for (const r of rows) if (r.key === key) v = r.value; // the last value wins, as in git
      return v;
    };
    this.info = { fileMode: !this.windows() && gitBool(last('core.filemode'), true), ignoreCase: gitBool(last('core.ignorecase'), false) };
    return this.info;
  }

  private windows(): boolean {
    return (this.d.platform ?? process.platform) === 'win32';
  }

  /** P2-CARRY over A ∪ the private index; recomputed only when either map is a new object. */
  private carriedPaths(index: ReadonlyMap<string, TreeEntry>, A: TreeMap, info: FsInfo): ReadonlySet<string> {
    const c = this.carry;
    if (c !== null && c.index === index && c.A === A) return c.set;
    const all = new Set<string>([...index.keys(), ...A.keys()]);
    const windows = this.windows();
    const set = new Set<string>();
    for (const p of all) if (carriedAlone(p, windows)) set.add(p);
    if (info.ignoreCase) for (const p of caseCollisions(all)) set.add(p);
    this.carry = { index, A, set };
    return set;
  }

  /** A path that became carried leaves the dirty set and the stat cache; a stage copy exists only if it was dirty. */
  private async forget(path: string): Promise<void> {
    const hadCopy = this.dirty.has(path);
    this.dirty.delete(path);
    this.future.delete(path);
    this.d.statCache.delete(path);
    if (hadCopy && stageable(path)) await this.d.stage.remove(path);
  }

  /**
   * Glossary §20: a removal confirms on two consecutive absences. Any observation that is not "absent" (the path is
   * present, or its lstat failed) ends the streak. An entry with no stat exists only to hold the streak (the first
   * absence after a start or reseed, when nothing was cached): it goes with it. Kept as `{stat: null, clean}`, it
   * would read as "unchanged" at every later absence and the deletion would never be staged.
   */
  private endAbsence(path: string): void {
    const ce = this.d.statCache.get(path);
    if (ce === undefined || ce.missingSinceMono === undefined) return;
    if (ce.stat === null) {
      this.d.statCache.delete(path);
      return;
    }
    this.d.statCache.set(path, { stat: ce.stat, id: ce.id, state: ce.state, ...(ce.shrink !== undefined ? { shrink: ce.shrink } : {}) });
  }

  /**
   * ls-files -o --exclude-standard -z on the private index (DAT-24), rerun only when a watched directory's lstat
   * changed or after UNTRACKED_RESCAN_MS; null when the listing failed (the snapshot fails). The directories of
   * carried paths and of listed paths that are not stageable are never watched (never looked at: `GIT~1` is `.git` on
   * Windows, `con/` a device); a file created in a directory holding only such paths is found by the backstop.
   */
  private async untracked(index: Map<string, TreeEntry>, now: number, carried: ReadonlySet<string>): Promise<string[] | null> {
    const L = this.listing;
    if (L !== null && now - L.mono < UNTRACKED_RESCAN_MS && (await this.dirsUnchanged(L.dirs))) return L.entries;
    const watch = new Set<string>(['']);
    for (const p of index.keys()) if (!carried.has(p)) parentDirs(p, watch);
    for (const p of L?.entries ?? []) if (stageable(p.endsWith('/') ? p.slice(0, -1) : p)) parentDirs(p, watch);
    const dirs = new Map<string, FsLstat | null>();
    for (const d of watch) dirs.set(d, await this.dirStat(d)); // before the listing: a change during it is seen next tick
    let out: string;
    try {
      const r = await this.d.repo.run(['ls-files', '-o', '--exclude-standard', '-z'], {
        indexFile: this.d.privateIndex, config: PRIVATE_INDEX_CONFIG,
      });
      out = r.stdout.toString('utf8');
    } catch (e) {
      if (e instanceof GitCommandError) return null;
      throw e;
    }
    const entries = out.split('\0').filter((s) => s.length > 0);
    const more = new Set<string>();
    for (const p of entries) if (stageable(p.endsWith('/') ? p.slice(0, -1) : p)) parentDirs(p, more);
    for (const d of more) if (!dirs.has(d)) dirs.set(d, await this.dirStat(d));
    this.listing = { entries, dirs, mono: now };
    return entries;
  }

  private async dirStat(dir: string): Promise<FsLstat | null> {
    try {
      return await this.d.fs.lstat(dir === '' ? this.d.repo.paths.workTree : this.workFile(dir));
    } catch {
      return null;
    }
  }

  private async dirsUnchanged(dirs: ReadonlyMap<string, FsLstat | null>): Promise<boolean> {
    for (const [d, st] of dirs) {
      if (!sameOrBothNull(st, await this.dirStat(d))) return false;
    }
    return true;
  }

  /** The caller's attributes where it has them (EPOCH_BASE), the snapshot's own cache for the rest (new paths). */
  private async attrLookup(inp: TickInput, paths: readonly string[]): Promise<(p: string) => PathAttrs> {
    const caller = inp.scope.attrs.epochBase === inp.epochBase ? inp.scope.attrs : null;
    const miss = paths.filter((p) => caller === null || tryGet(caller, p) === undefined);
    const own = miss.length > 0 ? await this.attrs.snapshot(inp.epochBase, miss) : null;
    return (p: string): PathAttrs => {
      const hit = caller === null ? undefined : tryGet(caller, p);
      if (hit !== undefined) return hit;
      if (own !== null) return own.get(p);
      return inp.scope.attrs.get(p);
    };
  }

  /**
   * Ruling P2-DRIVERCAP / P2-SNAPFILTERS (fail closed): a path under a filter attribute while the driver set is over
   * its cap, or naming a driver outside it (git would run it without required=true), is never read or hashed.
   */
  private filterRefused(a: PathAttrs): boolean {
    if (a.filter === null) return false;
    const f = this.d.filters;
    return f.overCap !== null || !f.drivers.includes(a.filter);
  }

  /** The stat equals the cached one and no deletion or shrink confirmation is pending: not a candidate. */
  private unchanged(path: string, st: FsLstat | null): boolean {
    const ce = this.d.statCache.get(path);
    if (ce === undefined || ce.missingSinceMono !== undefined || ce.shrink !== undefined) return false;
    return sameOrBothNull(ce.stat, st);
  }

  /** Step 2: mtime < QUIET_MS old (this PC's wall clock), or a future mtime whose stat has not been stable for QUIET_MS Δmono. */
  private quiet(path: string, st: FsLstat, now: number, wall: number): boolean {
    const mtimeMs = Number(st.mtimeNs / 1_000_000n);
    if (mtimeMs > wall) {
      const f = this.future.get(path);
      if (f === undefined || !sameStat(f.stat, st)) {
        this.future.set(path, { stat: st, firstMono: now });
        return true;
      }
      if (now - f.firstMono < QUIET_MS) return true;
      this.future.delete(path);
      return false;
    }
    this.future.delete(path);
    return wall - mtimeMs < QUIET_MS;
  }

  /** Step 3: a removal only when also missing ≥ DELETE_CONFIRM_MS earlier (Δmono) or hook-attributed. */
  private async missing(path: string, entry: TreeEntry, now: number, excluded: Map<string, Exclusion>): Promise<void> {
    const ce = this.d.statCache.get(path);
    const since = ce?.missingSinceMono;
    const attributed = this.d.attribution.removalAttributed(path);
    if (!attributed && (since === undefined || now - since < DELETE_CONFIRM_MS)) {
      if (since === undefined) {
        const base: StatEntry = ce ?? { stat: null, id: entry.oid, state: 'clean' };
        this.d.statCache.set(path, { stat: base.stat, id: base.id, state: base.state, missingSinceMono: now });
      }
      excluded.set(path, 'deletion_pending');
      return;
    }
    this.d.statCache.set(path, { stat: null, id: null, state: 'dirty' });
    this.dirty.set(path, { kind: 'remove', mode: entry.mode, id: null });
    await this.d.stage.remove(path);
  }

  /** The size a shrink is measured against: the last staged stat, else (first read after a start) S_raw[p]'s blob size. */
  private async referenceSizes(ok: readonly Staged[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const need: Staged[] = [];
    for (const c of ok) {
      const st = this.d.statCache.get(c.path)?.stat ?? null;
      if (st !== null) out.set(c.path, st.size);
      else if (c.entry !== null) need.push(c);
    }
    if (need.length > 0) {
      const sizes = await this.d.repo.blobSizes(need.map((c) => (c.entry as TreeEntry).oid));
      need.forEach((c, i) => out.set(c.path, sizes[i] as number));
    }
    return out;
  }

  /** Step 6 (ruling R-25): true while a > 50 % or to-0 shrink is not yet confirmed by a second tick ≥ 1 s later with the same stat and attribution. */
  private shrinkHeld(c: Staged, refSize: number | null, now: number): boolean {
    const size = c.bytes.length;
    if (refSize === null || refSize === 0 || (size !== 0 && size >= refSize * SHRINK_RATIO)) return false;
    const ce = this.d.statCache.get(c.path);
    const sh = ce?.shrink;
    if (sh !== undefined && sameStat(sh.stat, c.stat)) {
      if (now - sh.firstMono >= SHRINK_STABLE_MS && this.d.attribution.shrinkAttributed(c.path)) return false;
      this.d.statCache.set(c.path, { ...(ce as StatEntry), shrink: { stat: sh.stat, firstMono: sh.firstMono, ticks: sh.ticks + 1 } });
      return true;
    }
    const base: StatEntry = ce ?? { stat: null, id: c.entry?.oid ?? null, state: 'clean' };
    this.d.statCache.set(c.path, { stat: base.stat, id: base.id, state: base.state, shrink: { stat: c.stat, firstMono: now, ticks: 1 } });
    return true;
  }

  /**
   * The U comparison of step 5 (and the rc-1 check of step 7): a scratch index tmp/detect.index holding the given
   * entries, a stage-tree `update-index --refresh` (no -q; rc 0 or 1 both normal, never read as the result), then
   * `diff-files -z --name-only` on the same index: a listed path differs. null on any other failure.
   */
  private async differing(entries: readonly TreeEntry[], inp: TickInput): Promise<Set<string> | null> {
    const indexFile = this.d.scratch.detect;
    // The scratch index is rebuilt only when its entries (or EPOCH_BASE) change; a reused one is refreshed again from scratch-copy stats.
    const key = JSON.stringify([inp.epochBase, ...entries.map((e) => [e.path, e.mode, e.oid])]);
    try {
      if (key !== this.detectKey || (await this.d.fs.lstat(indexFile)) === null) {
        this.detectKey = null;
        await resetScratchIndex(this.d.fs, indexFile);
        await this.d.repo.editIndex(indexFile, entries.map((e) => ({ path: e.path, mode: e.mode, oid: e.oid })));
        this.detectKey = key;
      }
      const opts = { indexFile, workTree: this.d.stage.root, attrTree: inp.epochBase, config: STAGE_TREE_CONFIG };
      await this.d.repo.run(['update-index', '--refresh'], { ...opts, okCodes: [0, 1] });
      const diff = await this.d.repo.run(['diff-files', '-z', '--name-only'], opts);
      return new Set(diff.stdout.toString('utf8').split('\0').filter((s) => s.length > 0));
    } catch (e) {
      if (e instanceof GitCommandError) {
        this.detectKey = null;
        return null;
      }
      throw e;
    }
  }

  private async clean(c: Staged): Promise<void> {
    this.d.statCache.set(c.path, { stat: c.stat, id: (c.entry as TreeEntry).oid, state: 'clean' });
    this.dirty.delete(c.path);
    await this.d.stage.remove(c.path);
  }

  private markDirty(c: Staged, de: DirtyEntry): void {
    this.d.statCache.set(c.path, { stat: c.stat, id: de.id, state: 'dirty' });
    this.dirty.set(c.path, de);
  }

  /**
   * A read whose bytes cannot be hashed this tick: its stage copy goes. A path that was dirty had its earlier copy
   * overwritten by this read, so it leaves the dirty set and the stat cache (the next tick reads it from scratch); it
   * is excluded this loop either way.
   */
  private async discardCopy(path: string): Promise<void> {
    if (this.dirty.has(path)) {
      await this.drop(path);
      return;
    }
    await this.d.stage.remove(path);
  }

  private async drop(path: string): Promise<void> {
    this.dirty.delete(path);
    this.d.statCache.delete(path);
    await this.d.stage.remove(path);
  }

  /**
   * Step 9: S_disk = canon(S_raw) for p ∈ diff(A, S_raw) with ref(p) = A[p], else EPOCH_BASE[p], else none; built in
   * tmp/canon.index. A carried path is never canon'd: S_raw already holds A's entry for it, and a U+FFFD name written
   * back by its decoded string would name another path.
   */
  private async canonTree(inp: TickInput, sRaw: Oid, sRawMap: TreeMap, carried: ReadonlySet<string>): Promise<{ sDisk: Oid; sDiskMap: TreeMap; canonRefused: Set<string> }> {
    const { repo } = this.d;
    const canonRefused = new Set<string>();
    const regular = (e: TreeEntry | undefined): e is TreeEntry => e !== undefined && (e.mode === '100644' || e.mode === '100755');
    const diff = [...sRawMap.values()].filter((e) => regular(e) && !carried.has(e.path) && inp.A.get(e.path)?.oid !== e.oid);
    let epochMap: TreeMap | null = null;
    const pairs: Array<{ e: TreeEntry; ref: TreeEntry }> = [];
    for (const e of diff) {
      let ref = inp.A.get(e.path);
      if (ref === undefined) {
        epochMap ??= await repo.readTreeMap(inp.epochBase);
        ref = epochMap.get(e.path);
      }
      if (regular(ref)) pairs.push({ e, ref });
    }
    const attrOf = await this.attrLookup(inp, pairs.map((x) => x.e.path));
    const todo = pairs.filter(({ e }) => {
      const a = attrOf(e.path);
      return a.filter === null && !a.binary && a.text !== 'unset'; // filtered and attribute-binary paths get no canon
    });
    const edits: IndexEdit[] = [];
    if (todo.length > 0) {
      const blobs = await repo.readBlobs(todo.flatMap(({ e, ref }) => [e.oid, ref.oid]));
      for (let i = 0; i < todo.length; i++) {
        const { e } = todo[i] as { e: TreeEntry };
        const next = blobs[2 * i] as Buffer;
        const res = canon(next, blobs[2 * i + 1] as Buffer, false);
        if (!res.ok) {
          canonRefused.add(e.path); // S_disk keeps S_raw[p]; R-07: the caller holds the path (eol-bom)
          continue;
        }
        if (!res.out.equals(next)) edits.push({ path: e.path, mode: e.mode, oid: await hashRouteC(repo, res.out, true) });
      }
    }
    if (edits.length === 0) return { sDisk: sRaw, sDiskMap: sRawMap, canonRefused };
    // Whole-path replacement in the canon scratch index (ENG-10), with the index-only config: S_raw may hold a carried path.
    const canonIndex = this.d.scratch.canon;
    await resetScratchIndex(this.d.fs, canonIndex);
    await this.readTreeInto(canonIndex, sRaw);
    await this.editIndexFile(canonIndex, edits, sRaw.length);
    const sDisk = await this.writeTreeOf(canonIndex);
    return { sDisk, sDiskMap: await repo.readTreeMap(sDisk), canonRefused };
  }
}
