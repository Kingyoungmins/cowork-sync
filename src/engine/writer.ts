// The two-phase verifying writer (01-engine §3.11 writer protocol, ROLLBACK, round trip, ring, writeLocal and gate
// queries; ENG-31…ENG-35, ENG-37, ENG-38; glossary §26.1 W4, §26.2 item 7; rulings R-36, P2-EXECBIT, P2-CARRY,
// P2-DOTGIT, P2-INTENTREACH, P2-RINGNAMES, P2-ORPHANS, P2-BESTEFFORT-ROLLBACK, P2-NOFOLLOW, P2-COPYSTAT, P2-STRANDED,
// P2-NARROW, P2-NARROW-DELETE). It is the only code that writes a user's working file, and no git process ever does.
//
// One write group, all or none:
//   P0  the bytes of every create/modify path from ONE `cat-file --batch --filters` call (R-36: the runner pipes one
//       stdin per call) into tmp/<n>.<slot>.new by an exclusive create (one write and an fsync before it is ever
//       linked into place); ENOSPC defers the group disk_low
//   P1  per path: modify/delete — lstat, DISK_EQ(p, S_raw[p]), lstat; both lstats equal and DISK_EQ true, else the
//       current bytes are re-snapshotted and re-merged (≤ MAX_REMERGE) or the group defers; then rename
//       p → tmp/<n>.<slot>.old and lstat(.old) must equal st0 (in copy mode by size and mtime only, P2-COPYSTAT: a
//       FAT32/exFAT rename can change the file id). create — lstat(p) must be ENOENT (race otherwise; the local bytes
//       are never touched). crashpoint('apply.group.phase1'), yieldPoint('apply.beforePhase2')
//   P2  mkdir -p (recorded), link .new → p (the copy fallback on a volume without hard links: an exclusive create of
//       p and one write), the exec bit from the target's mode (P2-EXECBIT), crashpoint('apply.group.mid') between
//       two paths; deletes keep only their .old and their emptied parent directories are removed
//   RT  the round trip per written path (ENG-34); crashpoint('apply.group.phase2')
// and any failure before RT rolls the whole group back (ROLLBACK), best effort per path (P2-BESTEFFORT-ROLLBACK):
// the group is reported deferred, never thrown, and earlier groups keep their results. Every rename targets one of
// the writer's own tmp names, which it checks is free first: nothing is ever renamed over an existing file (W4).
// The .old files of a written group enter the ring as soon as P2 is done and stay ≥ RING_KEEP_MS; a late write into
// one becomes onLateWrite (ENG-35).
//
// Before P0 a group is refused whole ('unmaterializable', nothing looked at or touched) when a path is carried
// (P2-CARRY) or a dotgit alias (P2-DOTGIT), when an entry is a symlink or gitlink (120000/160000: symlink live sync is
// v2), or when an existing ancestor of a path below the work-tree root is a symlink, a junction or not a directory
// (P2-NOFOLLOW: nothing is ever created, moved or removed through a link out of the work tree). DISK_EQ refusals map
// to defer reasons: carried → unmaterializable, filter_failure → filter_failure, unstable → unstable, unreadable and
// error → unreadable.
//
// Temp names: an apply group's path is tmp/<n>.<slot>.{new,old,redo}; a local write's is tmp/L.<slot>.* with the slot
// from a per-Writer counter (P2-RINGNAMES). Both are derivable from the journaled intent alone, which is how
// rollbackIntent finds them after a restart; every one is freed before the intent naming it is journaled (Writer.reserve
// for an apply, runLocal for a local write: final review FB-1), so a file found there was put there by that intent. A
// writer name is never deleted or written through while something holds
// it: a ring .old there is renamed to tmp/ring-<k>.old and tracked there (its 2 s window intact; the name lives in
// memory only); anything else gets a never-reused name tmp/orphan-<ulid>.<ext> from the Random port and a
// WRITE_TMP_ORPHAN{file, path|null} line (P2-ORPHANS, P2-ORPHANNAMES): an orphan .new or .redo is ringed, an orphan .old
// is kept as it is and never deleted (P2-STRANDED: it may be the only copy of a file whose restore never completed; the
// restart's many-candidates step or a human resolves it). A stranded .old moved aside keeps its stranded entry (the
// sweep still retries its restore) and its line names its known path, never a ring name: after a crash the restart's
// known-path step decides it, where a ring name would age out.
//
// Stranded restores (P2-STRANDED, P2-NARROW): a .old the rollback cannot put back (p absent) stays at its intent name,
// is retried by every later writer operation and is named durably only by the journaled intent, so the stranded part
// of that intent stays journaled until the restore succeeds — and only that part: the group reports `stranded` and the
// caller keeps ONLY narrowToStranded(intent, results) (the stranded groups), writeLocal keeps its local intent
// narrowed to the stranded entries (cleared by the sweep that restores p; a stranded delete kept as a restore,
// target := expected, P2-NARROW-DELETE, so a restart relinks it instead of reading "p absent" as the delete done),
// and no new intent is journaled meanwhile. A written group never stays in a kept intent: a restart's rollbackIntent
// would roll it back after A moved.
import { dirname, join } from 'node:path';
import type { PeerId } from '../board/ids.js';
import { canon } from '../data/canon.js';
import { ABSENT, type Absent, type Oid, type OidOrAbsent } from '../git/oid.js';
import { GitCommandError, type FileMode, type GitRepo, type MktreeEntry, type TreeEntry } from '../git/repo.js';
import type { DeferReason } from '../holds/groups.js';
import type { Clock } from '../ports/clock.js';
import { crashpoint, KilledAt } from '../ports/crashpoint.js';
import { sameStat, type Fs, type FsLstat } from '../ports/fs.js';
import type { Log } from '../ports/log.js';
import { realRandom, ulid, type Random } from '../ports/random.js';
import type { Scheduler } from '../ports/scheduler.js';
import type { Trace } from '../ports/trace.js';
import type { DiskEq } from './diskEq.js';
import type { Snapshotter } from './snapshot.js';
import type { Intent } from './state.js';
import { stageable, stagedRead, type StageDir } from './stagedRead.js';
import type { StatCache } from './statCache.js';

export const RING_KEEP_MS = 2_000;
export const MAX_REMERGE = 3;
export const PATH_BUSY_WAIT_MS = 250;
export type WriteKind = 'create' | 'modify' | 'delete';
export interface WriteEntry { path: string; kind: WriteKind; slot: number; target: TreeEntry | null; sRaw: TreeEntry | null; sDisk: TreeEntry | null; }
export interface WriteGroup { n: number; entries: WriteEntry[]; }
/** merge-file(base S_disk[p], ours found, theirs target); null = conflict. Always called with the caller's entry (M_disk[p] as target). */
export type Remerge = (entry: WriteEntry, found: TreeEntry) => Promise<TreeEntry | null>;
/**
 * written: the entries actually put on disk whose round trip passed or could not run (not readable back at that
 * moment, or an fs/git error: such a path is not marked clean), a re-merged path with its merge; deleted: the deleted
 * paths; phantoms: paths written whose round trip failed (onPhantom was called; not in `written`).
 * stranded (P2-STRANDED): this deferred group's rollback could not put a .old back (p absent, the .old kept at its
 * intent name); false for every other group. When any result is stranded, the caller keeps ONLY the narrowed intent
 * narrowToStranded(intent, results) (P2-NARROW: the stranded groups, never the whole multi-group intent, whose
 * written groups a restart's rollbackIntent would roll back after A moved) — it is the only durable name of that
 * .old, which a restart's rollbackIntent restores — until `strandedPaths()` is empty after a `sweepRing()`, then
 * clears it; meanwhile it journals no new intent (no apply, no push).
 */
export interface GroupResult { n: number; outcome: 'written' | 'deferred'; reason: DeferReason | null; written: TreeEntry[]; deleted: string[]; phantoms: string[]; stranded: boolean; }
export type WriteLocalResult =                                   // ENG-37, verbatim
  | { kind: 'WRITTEN' } | { kind: 'MISMATCH'; found: OidOrAbsent } | { kind: 'LOCKED' } | { kind: 'COLLISION' }
  | { kind: 'FROZEN' } | { kind: 'DEFERRED'; reason: DeferReason } | { kind: 'PHANTOM' };
export interface WriterDeps {
  repo: GitRepo; fs: Fs; clock: Clock; scheduler: Scheduler; trace: Trace; log: Log; peer: PeerId;
  workTree: string; tmpDir: string; privateIndex: string;
  stage: StageDir; statCache: StatCache; diskEq: DiskEq; snapshot: Snapshotter;
  /** D1 step 1, from the AttrCache at EPOCH_BASE (the same predicates DiskEq has): a re-merge's `found` is canon only for a text, unfiltered path. */
  isFiltered: (path: string) => boolean;
  isText: (path: string) => boolean;
  mode: 'link' | 'copy';                                          // Writer.probeMode at start (glossary §26.2 item 7)
  /** P2-ORPHANNAMES: the Random port of the tmp/orphan-<ulid>.<ext> names (the engine core passes ports.random; absent: realRandom). */
  random?: Random;
  /**
   * One state update. Ruling P2-INTENTREACH: the binding keeps every blob a local intent names reachable by the same
   * state commit, under journal/keep/LOCAL_INTENT_KEEP built from localIntentKeep(intent) (the writer has no state
   * store; the oids it needs are all in the intent), and drops that keep entry with the intent.
   */
  journal: (intent: Intent) => Promise<void>;
  frozen: () => boolean;
  onPhantom: (path: string, target: TreeEntry) => Promise<void>;  // PHANTOM PIN, guard 'phantom' (ENG-34)
  onLateWrite: (path: string, stageCopy: string) => Promise<void>;// ring late write → PATCH (ENG-35)
}
export interface RollbackReport { complete: number[]; rolledBack: number[]; leftoverOld: Array<{ path: string; file: string }>; }

/**
 * Ruling P2-ORPHANNAMES: a free, never-reused orphan name tmp/orphan-<ulid>.<ext> (the ULID's 80 random bits from the
 * Random port), shared by every producer (the writer's move aside, the restart's kept leftovers): a name once logged
 * with WRITE_TMP_ORPHAN never names another file, so a later line cannot leave a stale path on it. A drawn name that
 * exists already (W4: nothing is ever renamed over a file) is drawn again.
 */
export async function orphanAside(fs: Fs, random: Random, clock: Clock, tmpDir: string, ext: string): Promise<string> {
  for (;;) {
    const name = join(tmpDir, `orphan-${ulid(random, clock)}.${ext}`);
    if ((await fs.lstat(name)) === null) return name;
  }
}

/** The journal/keep/<name> entry that keeps a local intent's blobs reachable (ruling P2-INTENTREACH). */
export const LOCAL_INTENT_KEEP = 'local-intent';

/** P2-INTENTREACH: the tree entries (one blob per distinct expected/target oid, named by its oid, sorted) of the keep tree for a local intent; [] for any other intent. */
export function localIntentKeep(intent: Intent): MktreeEntry[] {
  if (intent.kind !== 'local') return [];
  const oids = new Set<Oid>();
  for (const e of intent.entries) {
    if (e.expected !== ABSENT) oids.add(e.expected);
    if (e.target !== 'DELETE') oids.add(e.target);
  }
  return [...oids].sort().map((oid) => ({ name: oid, mode: '100644', type: 'blob', oid }));
}

type LocalIntent = Extract<Intent, { kind: 'local' }>;

/**
 * Ruling P2-NARROW: the only part of a journaled intent the caller keeps after applyGroups reported a stranded
 * restore — the groups whose GroupResult is stranded (matched by n), each with all its entries; {kind: 'none'} when
 * no group is stranded. Keeping a written group would let a restart's rollbackIntent roll it back after A moved and
 * the user edited it (it would remove its linked create, and the next snapshot would publish that deletion). A local
 * intent is one group (n = 0): kept whole when that result is stranded, else none (the writer narrows a local intent
 * it keeps to its stranded entries itself: a GroupResult names no paths). Any other intent is returned as it is.
 */
export function narrowToStranded(intent: Intent, results: readonly GroupResult[]): Intent {
  const stranded = new Set(results.filter((r) => r.stranded).map((r) => r.n));
  if (intent.kind === 'apply') {
    const groups = intent.groups.filter((g) => stranded.has(g.n));
    return groups.length === 0 ? { kind: 'none' } : { ...intent, groups };
  }
  if (intent.kind === 'local') return stranded.has(0) ? intent : { kind: 'none' };
  return intent;
}

/**
 * A local intent narrowed to the entries whose paths are stranded (P2-NARROW); {kind: 'none'} when none is; the
 * intent itself (same object) when it keeps every entry unchanged, so the caller re-journals only a changed intent.
 * Ruling P2-NARROW-DELETE: a stranded DELETE is kept as a restore, `target := expected` (never ABSENT: only a delete
 * whose file existed renamed it to a .old). rollbackIntent reads a delete as linked when p is absent and its .old
 * exists — the very disk state of a stranded delete — so a narrowed intent left with only such entries would read as
 * COMPLETE at a restart, which would confirm "p absent" as the DELETE target and publish the deletion although
 * writeLocal rolled the group back. As a restore, p absent is an unlinked modify: the group is rolled back and the
 * .old relinked; the restart's many-candidates step still matches {expected}.
 */
function narrowLocal(intent: LocalIntent, paths: ReadonlySet<string>): Intent {
  let changed = false;
  const entries: LocalIntent['entries'] = [];
  for (const e of intent.entries) {
    if (!paths.has(e.path)) {
      changed = true;
    } else if (e.target === 'DELETE' && e.expected !== ABSENT) {
      entries.push({ ...e, target: e.expected });
      changed = true;
    } else {
      entries.push(e);
    }
  }
  if (entries.length === 0) return { kind: 'none' };
  return changed ? { ...intent, entries } : intent;
}

/** The writeLocal free-space admission (01-engine §3.11): ≥ 2 × bytes to write + 256 MB. */
const FREE_SPACE_MARGIN_BYTES = 268_435_456;
const LOCKED_CODES: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'EACCES']);
/** EEXIST: something new at the target; the rest: the name cannot exist here (re-classified unmaterializable). */
const UNMATERIALIZABLE_CODES: ReadonlySet<string> = new Set(['ENAMETOOLONG', 'EINVAL', 'ENOTDIR']);
const NO_LINK_CODES: ReadonlySet<string> = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK']);
const LOCAL_PREFIX = 'L';
/** probeMode's work-tree name: `~*.tmp` is a D6 temp name (TEMP_PATTERNS), so a probe a crash leaves is never admitted. */
const PROBE_BASE = '~cowork-link-probe';
const PROBE_NAMES = 16;

function codeOf(e: unknown): string | undefined {
  const code = typeof e === 'object' && e !== null ? (e as NodeJS.ErrnoException).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

function syscallOf(e: unknown): string | undefined {
  const s = typeof e === 'object' && e !== null ? (e as NodeJS.ErrnoException).syscall : undefined;
  return typeof s === 'string' ? s : undefined;
}

function isGone(e: unknown): boolean {
  const c = codeOf(e);
  return c === 'ENOENT' || c === 'ENOTDIR';
}

/** An fs condition (an errno code) or a failed git process: never a programming error, which is rethrown. */
function operational(e: unknown): boolean {
  return codeOf(e) !== undefined || e instanceof GitCommandError;
}

/** A log parameter for an error: its errno code, `git:<rc>`, or its name. */
function errorCode(e: unknown): string {
  if (e instanceof GitCommandError) return `git:${e.code}`;
  return codeOf(e) ?? (e instanceof Error ? e.name : 'unknown');
}

/** A regular file entry (or none): a symlink (120000) or gitlink (160000) is never written as a file. */
function isRegular(t: TreeEntry | Absent | null): boolean {
  return t === null || t === ABSENT || t.mode === '100644' || t.mode === '100755';
}

/** A group-level deferral raised inside P0–P2; the group is rolled back, then reported. */
class DeferGroup extends Error {
  readonly reason: DeferReason;
  /** writeLocal: the disk blob a failed pre-image check found (MISMATCH). */
  readonly found: OidOrAbsent | undefined;
  /** writeLocal: a P2 name error (ENAMETOOLONG, EINVAL) is DEFERRED(unmaterializable), not a COLLISION. */
  readonly unmaterializable: boolean;
  constructor(reason: DeferReason, o: { found?: OidOrAbsent; unmaterializable?: boolean } = {}) {
    super(`write group deferred: ${reason}`);
    this.name = 'DeferGroup';
    this.reason = reason;
    this.found = o.found;
    this.unmaterializable = o.unmaterializable ?? false;
  }
}

interface Files { readonly new: string; readonly old: string; readonly redo: string; }

/** One path of a running group. */
interface PathRun {
  readonly e: WriteEntry;
  readonly abs: string;
  readonly files: Files;
  /** The pre-image P1 checks: S_raw[p] (apply) or expectedCleanBlob (local); null for a create. */
  readonly pre: TreeEntry | Absent | null;
  /** What P2 puts at p: M_disk[p] or newBlob, or a re-merge of it; null for a delete. */
  target: TreeEntry | null;
  bytes: Buffer | null;
  /** This run created .new (and it is still there). */
  newWritten: boolean;
  renamed: boolean;
  /** Post-rename stat of the .old (P1). */
  oldStat: FsLstat | null;
  /** The blob entry the .old holds (the pre-image P1 matched, a re-snapshot after a re-merge): a stranded restore's fallback when the .old vanishes (FB-3). */
  oldEntry: TreeEntry | null;
  linked: boolean;
  /** Stat of p right after its link or exclusive create (P2). */
  linkStat: FsLstat | null;
  createdDirs: string[];
}

interface GroupRun { readonly n: number; readonly paths: PathRun[]; readonly local: boolean; }

type RunOutcome =
  | { ok: true; written: TreeEntry[]; deleted: string[]; phantoms: string[] }
  | { ok: false; defer: DeferGroup; stranded: boolean };

/** relink's outcome; a failure carries the deferral it stands for (ENOSPC disk_low, beneath a link unmaterializable, else locked). */
type Relink = { kind: 'ok' } | { kind: 'exists' } | { kind: 'failed'; reason: DeferReason };

/**
 * A ringed file: a .old (or a holder moved aside, whose `file` follows it). path null: an orphan of an earlier run
 * whose path nobody knows. stat: the baseline the sweep compares with; null when none could be taken (the sweep
 * reads the file as changed).
 */
interface RingEntry { readonly path: string | null; file: string; readonly stat: FsLstat | null; readonly sinceMono: number; }

/**
 * A .old the rollback could not put back at p (p absent): retried by every later writer operation, never deleted; reason:
 * its last failure; pre: the blob entry the .old holds (final review FB-3: p is restored from it when the .old vanished).
 */
interface Stranded { readonly path: string; readonly abs: string; old: string; reason: DeferReason; readonly pre: TreeEntry | null; }

/**
 * A stranded restore as the lost-state rebuild reads it (final review FD): its path, the file that holds its bytes now
 * (the .old at its intent name, or the orphan name it was moved aside to) and the blob entry that .old holds (null when
 * unknown).
 */
export interface StrandedRestore { readonly path: string; readonly old: string; readonly pre: TreeEntry | null; }

/** A group of the current applyGroups/writeLocal call: `window` from P1 to the end of RT (ENG-38). */
interface Flight { window: boolean; readonly done: Promise<void>; finish(): void; }

function flight(): Flight {
  let finish!: () => void;
  const done = new Promise<void>((r) => {
    finish = r;
  });
  return { window: false, done, finish };
}

function checkEntry(e: WriteEntry): void {
  const ok = Number.isSafeInteger(e.slot) && e.slot >= 0 && (
    (e.kind === 'create' && e.target !== null)
    || (e.kind === 'modify' && e.target !== null && e.sRaw !== null)
    || (e.kind === 'delete' && e.target === null && e.sRaw !== null));
  if (!ok) throw new TypeError(`writer: inconsistent write entry ${JSON.stringify({ path: e.path, kind: e.kind, slot: e.slot })}`);
}

export class Writer {
  private readonly d: WriterDeps;
  private ring: RingEntry[] = [];
  private stranded: Stranded[] = [];
  /** .old files rollbackIntent left for the restart, with their paths: a later move aside of that name logs its path (it is kept, never ringed). */
  private readonly leftover = new Map<string, string>();
  private readonly inflight = new Map<string, Flight>();
  /** Paths of the last deferred apply groups not written since (pathState 'pending'). */
  private readonly pendingPaths = new Set<string>();
  private tail: Promise<void> = Promise.resolve();
  private execBitsP: Promise<boolean> | null = null;
  /** P2-RINGNAMES: local writes take their tmp/L.<slot>.* slots from this counter (journaled in the local intent). */
  private localSlotNext = 0;
  /** Suffixes of ring names (tmp/ring-<k>.<ext>, in memory only); orphan names are ULIDs (orphanAside). */
  private asideNext = 0;
  private readonly random: Random;
  /**
   * P2-STRANDED: the last local intent this writer journaled is still journaled, narrowed to its stranded entries
   * (P2-NARROW), because its group left a stranded restore; the sweep (or local write) that empties the stranded list
   * journals {kind: 'none'}. A later applyGroups
   * or rollbackIntent call means the caller owns the journal slot again: the flag drops, so the writer never clears
   * an intent it did not journal.
   */
  private localHeld = false;

  constructor(d: WriterDeps) {
    this.d = d;
    this.random = d.random ?? realRandom;
  }

  /** Ruling P2-NARROW: the module function narrowToStranded (the contract names it Writer.narrowToStranded). */
  static narrowToStranded(intent: Intent, results: readonly GroupResult[]): Intent {
    return narrowToStranded(intent, results);
  }

  /** Whether the volume tracks the exec bit (core.fileMode true, never on Windows), read once (P2-EXECBIT). */
  private execBits(): Promise<boolean> {
    this.execBitsP ??= (async () => {
      if (process.platform === 'win32') return false;
      const r = await this.d.repo.run(['config', '--type=bool', '--get', 'core.filemode'], { okCodes: [0, 1] });
      return r.code !== 0 || r.stdout.toString('utf8').trim() !== 'false';
    })();
    return this.execBitsP;
  }

  /**
   * P2-EXECBIT under the user's umask (final review minor, ledger Task 10:207): a file the writer just created exclusively
   * has 0o666 & ~umask; its exec bits become its read bits (umask 022 → 0o755, 077 → 0o700, 002 → 0o775), as git's
   * checkout of a 100755 entry (0o777 & ~umask) gives — never a fixed 0o755 that would widen a private umask.
   */
  private async setExec(file: string): Promise<void> {
    const st = await this.d.fs.lstat(file);
    if (st === null) return;
    const perm = st.mode & 0o777;
    await this.d.fs.chmod(file, perm | ((perm & 0o444) >> 2));
  }

  /** One writer operation at a time (an apply, a local write, a sweep, a rollback); pathState never waits for it. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private workFile(path: string): string {
    return join(this.d.workTree, ...path.split('/'));
  }

  private names(prefix: string, slot: number): Files {
    const base = join(this.d.tmpDir, `${prefix}.${slot}`);
    return { new: `${base}.new`, old: `${base}.old`, redo: `${base}.redo` };
  }

  private carried(path: string): boolean {
    return !stageable(path) || this.d.snapshot.isCarried(path);
  }

  private async lstatQuiet(p: string): Promise<FsLstat | null> {
    try {
      return await this.d.fs.lstat(p);
    } catch {
      return null;
    }
  }

  private async unlinkQuiet(p: string): Promise<void> {
    try {
      await this.d.fs.unlink(p);
    } catch (e) {
      if (!isGone(e)) throw e;
    }
  }

  /** A .old compared with its baseline: every lstat field, but in copy mode (size, mtime_ns) only (P2-COPYSTAT). */
  private oldStatEq(a: FsLstat, b: FsLstat): boolean {
    return this.d.mode === 'copy' ? a.size === b.size && a.mtimeNs === b.mtimeNs : sameStat(a, b);
  }

  /**
   * P2-NOFOLLOW: every existing ancestor of p below the work-tree root is a real directory (not a symlink, a junction
   * or a file). A missing ancestor ends the walk: mkdir -p creates real directories from there.
   */
  private async ancestorsSafe(path: string): Promise<boolean> {
    const parts = path.split('/');
    let dir = this.d.workTree;
    for (const c of parts.slice(0, -1)) {
      dir = join(dir, c);
      let st: FsLstat | null;
      try {
        st = await this.d.fs.lstat(dir);
      } catch {
        return false;
      }
      if (st === null) return true;
      if (st.isSymbolicLink || !st.isDirectory) return false;
    }
    return true;
  }

  /**
   * A group the writer must not touch at all (deferred 'unmaterializable' before P0): a carried or dotgit-alias path
   * (never looked at), a symlink or gitlink entry, or a path beneath a symlink, a junction or a file (P2-NOFOLLOW).
   */
  private async refused(run: GroupRun): Promise<boolean> {
    if (run.paths.some((p) => this.carried(p.e.path))) return true;
    if (run.paths.some((p) => !isRegular(p.e.target) || !isRegular(p.e.sRaw) || !isRegular(p.e.sDisk) || !isRegular(p.pre))) return true;
    for (const p of run.paths) if (!(await this.ancestorsSafe(p.e.path))) return true;
    return false;
  }

  /**
   * Groups of one journaled apply intent (the caller journaled J and called crashpoint('apply.intent')), in order.
   * A deferred group never blocks the others, and a group's failure never discards the results of the groups before
   * it (P2-BESTEFFORT-ROLLBACK): only a programming error or a callback's error is thrown. Neither A nor the state is
   * the writer's: the caller's ENG-36 update follows. A KilledAt from a crashpoint propagates with the disk as it is
   * (rollbackIntent after the restart).
   */
  async applyGroups(groups: readonly WriteGroup[], remerge: Remerge): Promise<GroupResult[]> {
    const seen = new Set<string>();
    const names = new Set<string>();
    for (const g of groups) {
      for (const e of g.entries) {
        checkEntry(e);
        if (seen.has(e.path)) throw new TypeError(`writer: ${JSON.stringify(e.path)} is in two write entries`);
        seen.add(e.path);
        const k = `${g.n}.${e.slot}`;
        if (names.has(k)) throw new TypeError(`writer: two entries share the temp name ${k}`);
        names.add(k);
      }
    }
    return this.serial(async () => {
      // The caller journaled this apply's intent: a local intent this writer kept is replaced, never cleared later.
      this.localHeld = false;
      await this.restoreStranded(false);
      // P2-STRANDED: the caller journals no new intent while a restore is stranded (it keeps only the narrowed intent,
      // P2-NARROW); one that did replaced the only durable name of that .old (still retried here; after a restart it
      // is a kept orphan).
      if (this.stranded.length > 0) this.d.log.write('error', 'WRITE_APPLY_WHILE_STRANDED', { stranded: this.stranded.length });
      const flights = groups.map(() => flight());
      groups.forEach((g, i) => {
        for (const e of g.entries) this.inflight.set(e.path, flights[i] as Flight);
      });
      const results: GroupResult[] = [];
      try {
        for (const [i, g] of groups.entries()) {
          if (i > 0) crashpoint('apply.between_groups');
          const run: GroupRun = {
            n: g.n, local: false,
            paths: g.entries.map((e) => this.pathRun(e, this.names(String(g.n), e.slot), e.kind === 'create' ? null : e.sRaw, e.target)),
          };
          const out = await this.runGroup(run, remerge, flights[i] as Flight);
          if (out.ok) {
            for (const e of g.entries) this.pendingPaths.delete(e.path);
            results.push({ n: g.n, outcome: 'written', reason: null, written: out.written, deleted: out.deleted, phantoms: out.phantoms, stranded: false });
          } else {
            for (const e of g.entries) this.pendingPaths.add(e.path);
            this.d.log.write('info', 'WRITE_GROUP_DEFERRED', { n: g.n, reason: out.defer.reason, paths: g.entries.length, stranded: out.stranded });
            results.push({ n: g.n, outcome: 'deferred', reason: out.defer.reason, written: [], deleted: [], phantoms: [], stranded: out.stranded });
          }
        }
      } finally {
        groups.forEach((g, i) => this.land(g.entries.map((e) => e.path), flights[i] as Flight));
      }
      return results;
    });
  }

  /**
   * Final review FB-1: every temp name (.new, .old, .redo) of the groups is freed BEFORE the caller journals their
   * intent, so rollbackIntent's precondition holds — a file at an intent's .old name after a restart was renamed there
   * by that intent, never a ring .old of an earlier group whose unlink failed or a leftover of an earlier run (whose
   * bytes would otherwise be recorded against, or relinked at, another path). A holder is moved as freeName moves it
   * (a ring entry to tmp/ring-<k>, anything else to a never-reused orphan name, an orphan .old kept); false, with
   * nothing journaled by the caller, when a holder refuses the move (locked) or the move fails.
   */
  reserve(groups: readonly WriteGroup[]): Promise<boolean> {
    return this.serial(() => this.freeNames(groups.flatMap((g) => g.entries.map((e) => this.names(String(g.n), e.slot)))));
  }

  /** freeName for every name of `files`; false (logged WRITE_RESERVE_FAILED) when a holder cannot be moved. */
  private async freeNames(files: readonly Files[]): Promise<boolean> {
    try {
      for (const f of files) for (const name of [f.new, f.old, f.redo]) await this.freeName(name);
      return true;
    } catch (e) {
      if (e instanceof KilledAt || !(e instanceof DeferGroup || operational(e))) throw e;
      this.d.log.write('warn', 'WRITE_RESERVE_FAILED', { code: e instanceof DeferGroup ? e.reason : errorCode(e) });
      return false;
    }
  }

  private pathRun(e: WriteEntry, files: Files, pre: TreeEntry | Absent | null, target: TreeEntry | null): PathRun {
    return {
      e, abs: this.workFile(e.path), files, pre, target, bytes: null, newWritten: false, renamed: false, oldStat: null,
      oldEntry: null, linked: false, linkStat: null, createdDirs: [],
    };
  }

  /** The group's flight ends: waiting gate queries get their answer. */
  private land(paths: readonly string[], f: Flight): void {
    for (const p of paths) if (this.inflight.get(p) === f) this.inflight.delete(p);
    f.finish();
  }

  /**
   * P0–P2 with a best-effort ROLLBACK on any failure (reported as a deferral: an fs condition or a failed git process
   * never throws), then the ring, then RT. A KilledAt is never rolled back here (a kill leaves the disk as it is).
   */
  private async runGroup(run: GroupRun, remerge: Remerge | null, f: Flight): Promise<RunOutcome> {
    try {
      if (await this.refused(run)) return { ok: false, defer: new DeferGroup('unmaterializable'), stranded: false };
      let failed = false;
      let failure: unknown;
      try {
        await this.prepare(run);
        f.window = true;
        await this.phase1(run, remerge);
        crashpoint('apply.group.phase1');
        await this.d.scheduler.yieldPoint('apply.beforePhase2');
        await this.phase2(run);
      } catch (e) {
        if (e instanceof KilledAt) throw e;
        failed = true;
        failure = e;
      }
      if (failed) {
        const defer = failure instanceof DeferGroup ? failure : asDefer(failure);
        const rb = await this.rollback(run);
        if (rb.failed > 0) this.d.log.write('error', 'WRITE_ROLLBACK_PARTIAL', { n: run.n, failed: rb.failed, stranded: rb.stranded });
        if (defer === null) throw failure;
        if (!(failure instanceof DeferGroup)) this.d.log.write('error', 'WRITE_GROUP_ERROR', { n: run.n, code: errorCode(failure), reason: defer.reason });
        return { ok: false, defer, stranded: rb.stranded > 0 };
      }
      // P2 is done: every .old enters the ring now, so nothing that happens in RT can leave one outside it (ENG-35).
      for (const p of run.paths) if (p.renamed) await this.toRing(p);
      await this.dropNews(run);
      const rt = await this.roundTrip(run);
      crashpoint('apply.group.phase2');
      return { ok: true, ...rt };
    } finally {
      f.window = false;
      this.land(run.paths.map((p) => p.e.path), f);
    }
  }

  // ---- P0 ----

  private async prepare(run: GroupRun): Promise<void> {
    const writes = run.paths.filter((p) => p.target !== null);
    if (writes.length === 0) return;
    const bufs = await this.smudge(writes.map((p) => ({ oid: (p.target as TreeEntry).oid, path: p.e.path })));
    for (const [i, p] of writes.entries()) await this.writeNew(p, bufs[i] as Buffer);
  }

  /** One `cat-file --batch --filters` call (R-36); a refusing smudge filter (required=true) defers filter_failure. */
  private async smudge(items: ReadonlyArray<{ oid: Oid; path: string }>): Promise<Buffer[]> {
    try {
      return await this.d.repo.smudgeBlobs(items);
    } catch (e) {
      if (e instanceof GitCommandError) throw new DeferGroup('filter_failure');
      throw e;
    }
  }

  /**
   * tmp/…new by an exclusive create — one write and an fsync before it can be linked into place — then the exec bit
   * from the target's mode (a fresh file never has it: 100644 needs nothing). This run's own earlier .new (a
   * re-merge retarget) is replaced; a holder from an earlier run is moved aside (freeName), never written through.
   */
  private async writeNew(p: PathRun, bytes: Buffer): Promise<void> {
    p.bytes = bytes;
    try {
      if (p.newWritten) {
        await this.unlinkQuiet(p.files.new);
        p.newWritten = false;
      } else {
        await this.freeName(p.files.new);
      }
      try {
        await this.d.fs.writeFileExclusive(p.files.new, bytes);
      } catch (e) {
        // Failed after the exclusive open (a write, fsync or close error): the partial file is ours to remove.
        if (codeOf(e) !== 'EEXIST' && syscallOf(e) !== 'open') p.newWritten = true;
        throw e;
      }
      p.newWritten = true;
      if (p.target?.mode === '100755' && (await this.execBits())) await this.setExec(p.files.new);
    } catch (e) {
      if (codeOf(e) === 'ENOSPC') throw new DeferGroup('disk_low');
      throw e;
    }
  }

  // ---- P1 ----

  private async phase1(run: GroupRun, remerge: Remerge | null): Promise<void> {
    for (const p of run.paths) {
      if (p.pre === null) await this.checkCreate(p);
      else await this.checkPreimage(run, p, remerge);
    }
  }

  /**
   * Creations only into ENOENT: anything at p (untracked, ignored, a directory, a case variant) defers race, untouched.
   * First DISK_EQ's refusals, as for a modify (final review minor): a filtered path whose driver is over the cap or
   * undiscovered (P2-DRIVERCAP / P2-SNAPFILTERS) defers filter_failure — its P0 smudge ran without required=true and
   * may be the stored form — and a carried path unmaterializable.
   */
  private async checkCreate(p: PathRun): Promise<void> {
    const refused = await this.d.diskEq.refusal(p.e.path);
    if (refused !== null) throw new DeferGroup(deferFor(refused));
    let st: FsLstat | null;
    try {
      st = await this.d.fs.lstat(p.abs);
    } catch {
      throw new DeferGroup('unreadable');
    }
    if (st !== null) throw new DeferGroup('race');
  }

  /**
   * DISK_EQ(p, pre) bracketed by two equal lstats (st0 is the stat the comparison validated), then the rename to .old.
   * Not equal: the current bytes are re-snapshotted (raw blob r, a stage copy only) — still the pre-image under canon →
   * check again against r; else (apply) found := canon(r, S_disk[p]) and the caller's re-merge of M_disk[p] becomes
   * the target, ≤ MAX_REMERGE times; (local) MISMATCH(r).
   */
  private async checkPreimage(run: GroupRun, p: PathRun, remerge: Remerge | null): Promise<void> {
    let pre = p.pre as TreeEntry | Absent;
    let fast: TreeEntry | null = run.local ? null : p.e.sRaw;
    for (let failures = 0; ; failures++) {
      if (pre === ABSENT) {
        // writeLocal of a delete whose expectedCleanBlob is ABSENT: nothing may be there, nothing to move.
        if ((await this.lstatQuiet(p.abs)) === null) return;
      } else {
        const st1 = await this.lstatQuiet(p.abs);
        const r = await this.d.diskEq.eq(p.e.path, pre, fast);
        const st0 = await this.lstatQuiet(p.abs);
        if (r.equal && st1 !== null && st0 !== null && sameStat(st1, st0)) {
          p.oldEntry = pre;
          await this.renameToOld(p, st0);
          return;
        }
        if (!r.equal && r.reason !== 'differs') throw new DeferGroup(deferFor(r.reason));
      }
      fast = null;
      const m = await this.d.diskEq.manyCandidates(p.e.path, pre === ABSENT ? [] : [pre]);
      if (m.read === 'missing') throw new DeferGroup('mismatch', { found: ABSENT });
      if (m.read !== 'ok') throw new DeferGroup(deferFor(m.read));
      if (m.raw === null) throw new DeferGroup('filter_failure');
      const rawEntry: TreeEntry = { path: p.e.path, mode: pre === ABSENT ? '100644' : pre.mode, oid: m.raw };
      if (m.match === null) {
        if (run.local || remerge === null) throw new DeferGroup('mismatch', { found: m.raw });
        if (failures >= MAX_REMERGE || p.e.kind === 'delete' || p.e.sDisk === null) throw new DeferGroup('mismatch');
        const merged = await remerge(p.e, await this.found(p.e, m.raw));
        if (merged === null) throw new DeferGroup('mismatch');
        await this.retarget(p, merged);
      } else if (failures >= MAX_REMERGE) {
        throw new DeferGroup('mismatch');
      }
      pre = rawEntry;
    }
  }

  /**
   * found := canon(r, ref = S_disk[p]) in stored form (route (c) -w); r itself when canon refuses, and r as it is for a
   * filtered or non-text path (D1 step 1: canon applies only to text, unfiltered paths).
   */
  private async found(e: WriteEntry, raw: Oid): Promise<TreeEntry> {
    const sDisk = e.sDisk as TreeEntry;
    if (this.d.isFiltered(e.path) || !this.d.isText(e.path)) return { path: e.path, mode: sDisk.mode, oid: raw };
    const [rBytes, refBytes] = await this.d.repo.readBlobs([raw, sDisk.oid]);
    const c = canon(rBytes as Buffer, refBytes as Buffer, false);
    const oid = c.ok && !c.out.equals(rBytes as Buffer) ? await this.d.repo.hashBytes(c.out, true) : raw;
    return { path: e.path, mode: sDisk.mode, oid };
  }

  /** The re-merge becomes what P2 writes: its bytes by one more smudge call (this path only). */
  private async retarget(p: PathRun, merged: TreeEntry): Promise<void> {
    const target: TreeEntry = { path: p.e.path, mode: merged.mode, oid: merged.oid };
    const [bytes] = await this.smudge([{ oid: target.oid, path: p.e.path }]);
    p.target = target;
    await this.writeNew(p, bytes as Buffer);
  }

  /** rename p → .old (a free name), then lstat(.old) must be st0 (size, mtime_ns, file id, mode; copy mode: size and mtime_ns). */
  private async renameToOld(p: PathRun, st0: FsLstat): Promise<void> {
    await this.freeName(p.files.old);
    try {
      await this.d.fs.rename(p.abs, p.files.old);
    } catch (e) {
      const c = codeOf(e);
      if (c !== undefined && LOCKED_CODES.has(c)) throw new DeferGroup('locked');
      if (isGone(e)) throw new DeferGroup('mismatch');
      throw e;
    }
    p.renamed = true;
    const so = await this.lstatQuiet(p.files.old);
    p.oldStat = so;
    if (so === null || !this.oldStatEq(so, st0)) throw new DeferGroup('mismatch');
  }

  /**
   * A writer name must be free before a rename or an exclusive create targets it. A holder is never deleted or
   * written through: it is renamed to a free moved-aside name in tmp/ and tracked there — a ring entry keeps its
   * path, baseline and 2 s window under a ring name (P2-RINGNAMES); a stranded .old keeps its restore under a
   * never-reused orphan name with a WRITE_TMP_ORPHAN{file, path} line naming its known path (never a ring name: after
   * a crash a ring name ages out, and this is the only copy of a file whose restore never completed); anything else is
   * an orphan of an earlier run under an orphan name (P2-ORPHANS, P2-ORPHANNAMES): a .new or .redo is ringed from now
   * (deleted once unchanged for 2 s), a .old is only moved and logged — never ringed or deleted (P2-STRANDED: whether
   * or not rollbackIntent reported its path, it can be the only copy of a file whose restore never completed; the
   * restart's many-candidates step or a human resolves it). A holder that refuses the move defers the group locked.
   */
  private async freeName(file: string): Promise<void> {
    if ((await this.d.fs.lstat(file)) === null) return;
    const ring = this.ring.find((r) => r.file === file);
    const stranded = this.stranded.find((s) => s.old === file);
    const ext = file.slice(file.lastIndexOf('.') + 1);
    const aside = ring !== undefined ? await this.ringName(ext) : await orphanAside(this.d.fs, this.random, this.d.clock, this.d.tmpDir, ext);
    try {
      await this.d.fs.rename(file, aside);
    } catch (e) {
      if (isGone(e)) return;
      const c = codeOf(e);
      if (c !== undefined && LOCKED_CODES.has(c)) throw new DeferGroup('locked');
      throw e;
    }
    if (ring !== undefined) {
      ring.file = aside;
    } else if (stranded !== undefined) {
      stranded.old = aside;
      this.d.log.write('warn', 'WRITE_TMP_ORPHAN', { file: aside, path: stranded.path, kept: true });
    } else {
      const path = this.leftover.get(file) ?? null;
      this.leftover.delete(file);
      const kept = ext === 'old';
      if (!kept) this.ring.push({ path: null, file: aside, stat: await this.baseline(aside), sinceMono: this.d.clock.monoMs() });
      this.d.log.write('warn', 'WRITE_TMP_ORPHAN', { file: aside, path, kept });
    }
  }

  /** A free tmp/ring-<k>.<ext> name (a ring entry's, tracked in memory). */
  private async ringName(ext: string): Promise<string> {
    for (;;) {
      const name = join(this.d.tmpDir, `ring-${this.asideNext++}.${ext}`);
      if ((await this.d.fs.lstat(name)) === null) return name;
    }
  }

  /** A ring baseline: the file's lstat, or null (no baseline: the sweep reads it as changed) when lstat fails. */
  private async baseline(file: string): Promise<FsLstat | null> {
    try {
      return await this.d.fs.lstat(file);
    } catch {
      return null;
    }
  }

  // ---- P2 ----

  private async phase2(run: GroupRun): Promise<void> {
    const writes = run.paths.filter((p) => p.target !== null);
    for (const [i, p] of writes.entries()) {
      if (i > 0) crashpoint('apply.group.mid');
      await this.place(p);
    }
    for (const p of run.paths) if (p.target === null && p.renamed) await this.removeEmptyParents(p.abs);
  }

  /**
   * link .new → p (or the copy fallback's exclusive create); p's stat is taken at once, so a failure after it still
   * finds p as the writer's own. The .new is then dropped; a failing unlink is not fatal (the bytes are at p) and is
   * retried after the group.
   */
  private async place(p: PathRun): Promise<void> {
    const target = p.target as TreeEntry;
    try {
      await this.mkdirParents(p);
      if (this.d.mode === 'link') {
        await this.d.fs.link(p.files.new, p.abs);
        p.linked = true;
        p.linkStat = await this.lstatQuiet(p.abs);
      } else {
        try {
          await this.d.fs.writeFileExclusive(p.abs, p.bytes as Buffer);
        } catch (e) {
          // A failure after the exclusive open (a write, fsync or close error) leaves a file that is ours: the
          // rollback removes it. A failed open created nothing.
          if (codeOf(e) !== 'EEXIST' && syscallOf(e) !== 'open') {
            const st = await this.lstatQuiet(p.abs);
            if (st !== null) {
              p.linked = true;
              p.linkStat = st;
            }
          }
          throw e;
        }
        p.linked = true;
        p.linkStat = await this.lstatQuiet(p.abs);
        if (target.mode === '100755' && (await this.execBits())) {
          await this.setExec(p.abs);
          p.linkStat = await this.lstatQuiet(p.abs);
        }
      }
    } catch (e) {
      throw p2Defer(e);
    }
    await this.dropNew(p);
  }

  private async dropNew(p: PathRun): Promise<void> {
    if (!p.newWritten) return;
    try {
      await this.unlinkQuiet(p.files.new);
      p.newWritten = false;
    } catch (e) {
      this.d.log.write('warn', 'WRITE_NEW_LEFT', { path: p.e.path, code: errorCode(e) });
    }
  }

  /** After a written group: a .new whose unlink failed in P2 is tried once more (a later freeName moves it aside). */
  private async dropNews(run: GroupRun): Promise<void> {
    for (const p of run.paths) await this.dropNew(p);
  }

  /** mkdir -p of p's parent, recording every directory it creates (the rollback removes them again). */
  private async mkdirParents(p: PathRun): Promise<void> {
    const missing: string[] = [];
    for (let dir = dirname(p.abs); dir.length > this.d.workTree.length && dir.startsWith(this.d.workTree); dir = dirname(dir)) {
      if ((await this.d.fs.lstat(dir)) !== null) break;
      missing.push(dir);
    }
    if (missing.length === 0) return;
    await this.d.fs.mkdirp(dirname(p.abs));
    p.createdDirs.push(...missing);   // deepest first
  }

  /** Non-recursive rmdir of p's emptied parents up to (never including) the work-tree root. */
  private async removeEmptyParents(abs: string): Promise<void> {
    for (let dir = dirname(abs); dir.length > this.d.workTree.length && dir.startsWith(this.d.workTree); dir = dirname(dir)) {
      if (!(await this.rmdirReal(dir))) return;
    }
  }

  /** Non-recursive rmdir of a real directory only (P2-NOFOLLOW: never a symlink or a junction); false when nothing was removed. */
  private async rmdirReal(dir: string): Promise<boolean> {
    try {
      const st = await this.d.fs.lstat(dir);
      if (st === null || st.isSymbolicLink || !st.isDirectory) return false;
      await this.d.fs.rmdir(dir);
      return true;
    } catch {
      return false;
    }
  }

  // ---- RT ----

  /**
   * ENG-34 per path. Apply: the private-index entry := the written target (`--index-info`), then DISK_EQ(p, target)
   * through a staged read; equal → the stat cache takes the post-write lstat as clean; not equal → MANY CANDIDATES:
   * a canon match puts the raw blob in the private index, no match is a PHANTOM. A deletion is force-removed from the
   * private index. A local write (ENG-37) is a local edit the next snapshot must pick up: the private index and the
   * stat cache are left alone, only the phantom check runs. A path that cannot be read back right now (unstable,
   * unreadable) or whose round trip meets an fs or git error gets no verdict and is not marked clean.
   */
  private async roundTrip(run: GroupRun): Promise<{ written: TreeEntry[]; deleted: string[]; phantoms: string[] }> {
    const written: TreeEntry[] = [];
    const deleted: string[] = [];
    const phantoms: string[] = [];
    for (const p of run.paths) {
      const path = p.e.path;
      if (p.target === null) {
        if (!run.local) {
          try {
            await this.d.repo.editIndex(this.d.privateIndex, [{ path, remove: true }]);
            if ((await this.lstatQuiet(p.abs)) === null) this.d.statCache.delete(path);
          } catch (e) {
            this.rtError(path, e);
          }
        }
        deleted.push(path);
        continue;
      }
      const target = p.target;
      let phantom = false;
      try {
        phantom = await this.isPhantom(run, p, target);
      } catch (e) {
        this.rtError(path, e);
      }
      if (phantom) {
        phantoms.push(path);
        this.d.log.write('warn', 'PHANTOM', { path });
        await this.d.onPhantom(path, target);
      } else {
        written.push(target);
      }
    }
    return { written, deleted, phantoms };
  }

  /** RT of one written path: true only when its bytes were read back and match no candidate (a PHANTOM). */
  private async isPhantom(run: GroupRun, p: PathRun, target: TreeEntry): Promise<boolean> {
    const path = p.e.path;
    if (!run.local) await this.d.repo.editIndex(this.d.privateIndex, [{ path, mode: target.mode, oid: target.oid }]);
    const st1 = await this.lstatQuiet(p.abs);
    const r = await this.d.diskEq.eq(path, target, null);
    const st2 = await this.lstatQuiet(p.abs);
    if (r.equal) {
      if (!run.local && st1 !== null && st2 !== null && sameStat(st1, st2)) this.d.snapshot.markClean(path, st2, target.oid);
      return false;
    }
    if (r.reason !== 'differs') return false;
    const st3 = await this.lstatQuiet(p.abs);
    const m = await this.d.diskEq.manyCandidates(path, [target]);
    const st4 = await this.lstatQuiet(p.abs);
    if (m.read === 'ok' && m.match !== null && m.raw !== null) {
      if (!run.local) {
        await this.d.repo.editIndex(this.d.privateIndex, [{ path, mode: target.mode, oid: m.raw }]);
        if (st3 !== null && st4 !== null && sameStat(st3, st4)) this.d.snapshot.markClean(path, st4, m.raw);
      }
      return false;
    }
    return m.read === 'ok';
  }

  /** An RT step's fs or git error: logged, the path stays unverified. Anything else (a programming error) is thrown. */
  private rtError(path: string, e: unknown): void {
    if (e instanceof KilledAt || !operational(e)) throw e;
    this.d.log.write('error', 'WRITE_RT_ERROR', { path, code: errorCode(e) });
  }

  // ---- ROLLBACK ----

  /**
   * ROLLBACK(g), best effort per path (P2-BESTEFFORT-ROLLBACK): a failing step never stops the others and nothing is
   * thrown; the count of failed steps is returned. Every .new goes first (in copy mode its space comes back before
   * the restores). A linked path whose stat is still the post-link stat goes to .redo and its .old comes back
   * (link-no-replace, or an exclusive create from the .old bytes in copy mode); when a holder refuses the move to
   * .redo, p stays as written and its .old (S_raw bytes, already in git) goes to the ring; a linked path someone wrote
   * since stays as written and its .old goes to the ring; every path renamed but not linked gets its .old back; a
   * created path is removed if still ours; every .redo and every directory the group created goes (never a symlink or
   * a junction). A .old that cannot be put back (p absent) stays at its intent name, is retried by every later writer
   * operation and is counted in `stranded` (the group reports it: P2-STRANDED).
   */
  private async rollback(run: GroupRun): Promise<{ failed: number; stranded: number }> {
    let failed = 0;
    let stranded = 0;
    const step = async (what: string, path: string, fn: () => Promise<void>): Promise<boolean> => {
      try {
        await fn();
        return true;
      } catch (e) {
        if (e instanceof KilledAt) throw e;
        failed++;
        this.d.log.write('error', 'WRITE_ROLLBACK_STEP', { step: what, path, code: errorCode(e) });
        return false;
      }
    };
    for (const p of run.paths) {
      if (p.newWritten && (await step('unlink_new', p.e.path, () => this.unlinkQuiet(p.files.new)))) p.newWritten = false;
    }
    for (const p of run.paths) {
      const path = p.e.path;
      if (p.linked) {
        const now = await this.lstatQuiet(p.abs);
        const ours = now !== null && p.linkStat !== null && sameStat(now, p.linkStat);
        if (!p.renamed) {
          if (ours) await step('remove_created', path, () => this.unlinkQuiet(p.abs));
        } else if (!ours) {
          await this.toRing(p);
        } else {
          const moved = await step('to_redo', path, async () => {
            await this.freeName(p.files.redo);
            await this.d.fs.rename(p.abs, p.files.redo);
          });
          if (!moved) {
            await this.toRing(p);
          } else if (!(await this.restoreOld(p))) {
            failed++;
            stranded++;
          }
          await step('unlink_redo', path, () => this.unlinkQuiet(p.files.redo));
        }
      } else if (p.renamed) {
        if (!(await this.restoreOld(p))) {
          failed++;
          stranded++;
        }
      }
      for (const dir of p.createdDirs) if (!(await this.rmdirReal(dir))) break;
    }
    return { failed, stranded };
  }

  /** The .old back at p; someone created p meanwhile → the .old goes to the ring; a failed restore → stranded (retried). false only for a failure. */
  private async restoreOld(p: PathRun): Promise<boolean> {
    const r = await this.relink(p.e.path, p.files.old, p.abs);
    if (r.kind === 'exists') {
      await this.toRing(p);
    } else if (r.kind === 'failed') {
      this.stranded.push({ path: p.e.path, abs: p.abs, old: p.files.old, reason: r.reason, pre: p.oldEntry });
      this.d.log.write('error', 'WRITE_OLD_STRANDED', { path: p.e.path, reason: r.reason });
    }
    return r.kind !== 'failed';
  }

  /**
   * Puts `old` back at abs without replacing anything (a hard link, or in copy mode an exclusive create from its
   * bytes), then drops `old`: 'ok'. 'exists': something is at abs (nothing changed). 'failed': abs is beneath a
   * symlink or junction (P2-NOFOLLOW: unmaterializable), or the restore failed (ENOSPC: disk_low, else locked); the
   * partial file of a failed exclusive create is removed and `old` stays.
   */
  private async relink(path: string, old: string, abs: string): Promise<Relink> {
    try {
      if (!(await this.ancestorsSafe(path))) return { kind: 'failed', reason: 'unmaterializable' };
      if ((await this.d.fs.lstat(dirname(abs))) === null) await this.d.fs.mkdirp(dirname(abs));
      if (this.d.mode === 'link') {
        await this.d.fs.link(old, abs);
      } else {
        const st = await this.d.fs.lstat(old);
        const bytes = await this.d.fs.readFile(old);
        try {
          await this.d.fs.writeFileExclusive(abs, bytes);
        } catch (e) {
          if (codeOf(e) !== 'EEXIST' && syscallOf(e) !== 'open') await this.unlinkQuiet(abs);
          throw e;
        }
        // The .old's own permission bits (the user's file as it was), never a fixed 0o755 (final review minor, umask).
        if (st !== null && (st.mode & 0o100) !== 0 && (await this.execBits())) await this.d.fs.chmod(abs, st.mode & 0o777);
      }
    } catch (e) {
      if (e instanceof KilledAt) throw e;
      if (codeOf(e) === 'EEXIST') return { kind: 'exists' };
      this.d.log.write('error', 'WRITE_RELINK_FAILED', { path, code: errorCode(e) });
      return { kind: 'failed', reason: codeOf(e) === 'ENOSPC' ? 'disk_low' : 'locked' };
    }
    try {
      await this.unlinkQuiet(old);
    } catch (e) {
      this.d.log.write('warn', 'WRITE_OLD_LEFT', { path, code: errorCode(e) });
    }
    return { kind: 'ok' };
  }

  /**
   * Final review FB-3: a stranded p whose .old vanished, back from the blob the .old held (one smudge, an exclusive create
   * of p, the exec bit from its mode): 'ok' (WRITE_OLD_RESTORED_FROM_BLOB); 'exists' when something is at p by now (it
   * is left as it is; p is not absent any more); 'failed' — no blob is known, p is beneath a symlink or junction
   * (unmaterializable), the smudge failed (filter_failure), ENOSPC (disk_low) or any other fs error (locked) — keeps the
   * entry stranded.
   */
  private async restoreFromBlob(s: Stranded): Promise<Relink> {
    if (s.pre === null) return { kind: 'failed', reason: s.reason };
    try {
      if (!(await this.ancestorsSafe(s.path))) return { kind: 'failed', reason: 'unmaterializable' };
      const [bytes] = await this.d.repo.smudgeBlobs([{ oid: s.pre.oid, path: s.path }]);
      if ((await this.d.fs.lstat(dirname(s.abs))) === null) await this.d.fs.mkdirp(dirname(s.abs));
      try {
        await this.d.fs.writeFileExclusive(s.abs, bytes as Buffer);
      } catch (e) {
        if (codeOf(e) !== 'EEXIST' && syscallOf(e) !== 'open') await this.unlinkQuiet(s.abs);
        throw e;
      }
      if (s.pre.mode === '100755' && (await this.execBits())) await this.setExec(s.abs);
    } catch (e) {
      if (e instanceof KilledAt || !operational(e)) throw e;
      if (codeOf(e) === 'EEXIST') return { kind: 'exists' };
      this.d.log.write('error', 'WRITE_OLD_BLOB_RESTORE_FAILED', { path: s.path, code: errorCode(e) });
      return { kind: 'failed', reason: e instanceof GitCommandError ? 'filter_failure' : codeOf(e) === 'ENOSPC' ? 'disk_low' : 'locked' };
    }
    this.d.log.write('warn', 'WRITE_OLD_RESTORED_FROM_BLOB', { path: s.path });
    return { kind: 'ok' };
  }

  /** The path's .old into the ring, with its post-rename stat, else a fresh lstat (none if it is gone; no baseline if lstat fails). */
  private async toRing(p: PathRun): Promise<void> {
    let stat = p.oldStat;
    if (stat === null) {
      try {
        stat = await this.d.fs.lstat(p.files.old);
        if (stat === null) return;
      } catch {
        stat = null;
      }
    }
    this.ring.push({ path: p.e.path, file: p.files.old, stat, sinceMono: this.d.clock.monoMs() });
  }

  /**
   * Every stranded .old: back at p when possible; when something is at p by now, the .old goes to the ring. `clear`
   * (sweepRing and writeLocal, where the journal slot is still the writer's): once the list is empty, a local intent
   * kept for it is cleared by journaling {kind: 'none'} (P2-STRANDED). applyGroups never clears: the caller's apply
   * intent is journaled by then.
   */
  private async restoreStranded(clear: boolean): Promise<void> {
    if (this.stranded.length > 0) {
      const left: Stranded[] = [];
      for (const s of this.stranded) {
        let st: FsLstat | null;
        try {
          st = await this.d.fs.lstat(s.old);
        } catch {
          left.push(s);
          continue;
        }
        if (st === null) {
          // Final review FB-3: the .old vanished (AV quarantine, a cleaned tmp/): p is restored from the blob it held.
          // Dropping the entry would end tickSkip's cover, and p's absence would be confirmed and published as a deletion.
          const r = await this.restoreFromBlob(s);
          if (r.kind === 'failed') {
            s.reason = r.reason;
            left.push(s);
          }
          continue;
        }
        const r = await this.relink(s.path, s.old, s.abs);
        if (r.kind === 'exists') {
          this.ring.push({ path: s.path, file: s.old, stat: st, sinceMono: this.d.clock.monoMs() });
        } else if (r.kind === 'failed') {
          s.reason = r.reason;
          left.push(s);
        } else {
          this.d.log.write('info', 'WRITE_OLD_RESTORED', { path: s.path });
        }
      }
      this.stranded = left;
    }
    if (clear && this.localHeld && this.stranded.length === 0) {
      await this.d.journal({ kind: 'none' });
      this.localHeld = false;
      this.d.log.write('info', 'WRITE_LOCAL_INTENT_CLEARED', {});
    }
  }

  /**
   * P2-STRANDED: the paths whose rollback restore is still stranded (p absent, its .old kept at its intent name). While
   * this is non-empty the caller journals no new intent (no apply, no push, no other local write); once it is empty
   * after a sweepRing(), the caller clears the narrowed apply intent it kept for GroupResult.stranded
   * (narrowToStranded, P2-NARROW; a kept local intent is narrowed and cleared by the writer itself).
   */
  strandedPaths(): string[] {
    return this.stranded.map((s) => s.path);
  }

  /**
   * Final review FD: the stranded restores with the file holding each one's bytes now (copies). p stays absent until a
   * sweep relinks that file (or, when it vanished, restores `pre`: FB-3), so a lost-state rebuild or a recover re-anchor
   * reads p's bytes there (01-engine §3.3 DISK_EQ form (3)) instead of leaving p undecided (ENG-54).
   */
  strandedRestores(): StrandedRestore[] {
    return this.stranded.map((s) => ({ path: s.path, old: s.old, pre: s.pre }));
  }

  // ---- ring ----

  /** .old ≥ RING_KEEP_MS Δmono: stat-compare with its baseline; a late write → onLateWrite (staged read, stage copy); delete. Stranded restores are retried first (P2-STRANDED: see strandedPaths). */
  sweepRing(): Promise<void> {
    return this.serial(async () => {
      await this.restoreStranded(true);
      const now = this.d.clock.monoMs();
      const keep: RingEntry[] = [];
      for (const r of this.ring) {
        if (now - r.sinceMono < RING_KEEP_MS || !(await this.resolveRing(r))) keep.push(r);
      }
      this.ring = keep;
    });
  }

  /**
   * true when the entry is done: the file deleted (after onLateWrite for a late write), gone, or — an orphan .new or
   * .redo (path null; an orphan .old is never ringed) that changed — kept on disk as it is (no record could name its
   * bytes); false to retry later.
   */
  private async resolveRing(r: RingEntry): Promise<boolean> {
    let st: FsLstat | null;
    try {
      st = await this.d.fs.lstat(r.file);
    } catch {
      return false;
    }
    if (st === null) return true;
    if (r.stat === null || !this.oldStatEq(st, r.stat)) {
      if (r.path === null) {
        this.d.log.write('warn', 'RING_ORPHAN_CHANGED', { file: r.file });
        return true;
      }
      // A late write through a handle held over the rename (ENG-35): its bytes become a record before the delete.
      const read = await stagedRead(this.d.fs, r.file);
      if (read.kind === 'missing') return true;
      if (read.kind !== 'ok') return false;
      const path = r.path;
      await this.withStageCopy(path, read.bytes, (copy) => this.d.onLateWrite(path, copy));
      this.d.log.write('warn', 'RING_LATE_WRITE', { path });
    }
    try {
      await this.d.fs.unlink(r.file);
    } catch (e) {
      return isGone(e);
    }
    return true;
  }

  /** The stage copy of path for one call; a dirty copy the snapshot keeps for p is put back as it was. */
  private async withStageCopy(path: string, bytes: Buffer, fn: (copy: string) => Promise<void>): Promise<void> {
    let saved: Buffer | null = null;
    if (this.d.statCache.get(path)?.state === 'dirty') {
      try {
        saved = await this.d.fs.readFile(this.d.stage.abs(path));
      } catch (e) {
        if (!isGone(e)) throw e;
      }
    }
    const copy = await this.d.stage.write(path, bytes);
    try {
      await fn(copy);
    } finally {
      if (saved !== null) await this.d.stage.write(path, saved);
      else await this.d.stage.remove(path);
    }
  }

  // ---- writeLocal ----

  writeLocal(path: string, expected: OidOrAbsent, target: Oid | 'DELETE', origin: string, humanEvidence?: boolean): Promise<WriteLocalResult> {
    return this.writeLocalGroup([{ path, expected, target }], origin, humanEvidence);
  }

  /**
   * ENG-37: the same writer for a local-origin write, all or none. FROZEN while a FREEZE reason is set unless the
   * request carries human evidence; a carried path is DEFERRED(unmaterializable) before anything is looked at; free
   * space ≥ 2 × bytes + 256 MB else DEFERRED(disk_low). Then a local intent is journaled, the group runs with the
   * pre-image DISK_EQ(path, expected) (ABSENT: ENOENT; something there → COLLISION) and no re-merge (MISMATCH(found)),
   * and the intent is cleared. Never changes A, LA_C or LA_B (or the private index: the next snapshot sees the edit).
   * P2-STRANDED: when the group's rollback strands a restore, the local intent stays journaled (the only durable name
   * of that .old), narrowed to its stranded entries (P2-NARROW: a restart never rolls back an entry this rollback
   * already undid; a stranded delete is kept as a restore, target := expected, P2-NARROW-DELETE), and the sweep that
   * restores p clears it; while any restore is stranded a local write journals nothing and is DEFERRED with the
   * stranded restore's reason.
   */
  async writeLocalGroup(entries: ReadonlyArray<{ path: string; expected: OidOrAbsent; target: Oid | 'DELETE' }>, origin: string, humanEvidence = false): Promise<WriteLocalResult> {
    if (entries.length === 0) throw new TypeError('writer: writeLocalGroup needs at least one entry');
    if (new Set(entries.map((e) => e.path)).size !== entries.length) throw new TypeError('writer: a path appears twice in one local group');
    if (this.d.frozen() && !humanEvidence) return { kind: 'FROZEN' };
    if (entries.some((e) => this.carried(e.path))) return { kind: 'DEFERRED', reason: 'unmaterializable' };
    const targets = entries.flatMap((e) => (e.target === 'DELETE' ? [] : [e.target]));
    for (const t of targets) {
      if (!(await this.d.repo.hasObject(t, 'blob'))) throw new Error(`writer: writeLocal target ${t} is not a blob (ENG-09)`);
    }
    const bytes = (await this.d.repo.blobSizes(targets)).reduce((a, b) => a + b, 0);
    const free = await this.d.fs.freeBytes(this.d.workTree);
    if (free !== null && free < 2 * bytes + FREE_SPACE_MARGIN_BYTES) return { kind: 'DEFERRED', reason: 'disk_low' };
    return this.serial(() => this.runLocal(entries, origin));
  }

  private async runLocal(entries: ReadonlyArray<{ path: string; expected: OidOrAbsent; target: Oid | 'DELETE' }>, origin: string): Promise<WriteLocalResult> {
    await this.restoreStranded(true);
    const waiting = this.stranded[0];
    if (waiting !== undefined) {
      // A new local intent would replace the journaled intent that names the stranded .old (P2-STRANDED).
      this.d.log.write('warn', 'WRITE_LOCAL_STRANDED_WAIT', { stranded: this.stranded.length, reason: waiting.reason });
      return { kind: 'DEFERRED', reason: waiting.reason };
    }
    const index = await this.d.repo.listIndex(this.d.privateIndex);
    // A symlink or gitlink the private index holds is never written as a file (symlink live sync is v2).
    if (entries.some((x) => !isRegular(index.get(x.path) ?? null))) return { kind: 'DEFERRED', reason: 'unmaterializable' };
    const slots = entries.map(() => this.localSlotNext++);
    const paths = entries.map((x, i): PathRun => {
      const slot = slots[i] as number;
      const cur = index.get(x.path)?.mode;
      const mode: FileMode = cur === '100755' ? '100755' : '100644';
      const kind: WriteKind = x.target === 'DELETE' ? 'delete' : x.expected === ABSENT ? 'create' : 'modify';
      const target: TreeEntry | null = x.target === 'DELETE' ? null : { path: x.path, mode, oid: x.target };
      const pre: TreeEntry | Absent | null = kind === 'create' ? null : x.expected === ABSENT ? ABSENT : { path: x.path, mode, oid: x.expected };
      const e: WriteEntry = { path: x.path, kind, slot, target, sRaw: null, sDisk: null };
      return this.pathRun(e, this.names(LOCAL_PREFIX, slot), pre, target);
    });
    const intent: LocalIntent = { kind: 'local', origin, entries: entries.map((x, i) => ({ path: x.path, expected: x.expected, target: x.target, slot: slots[i] as number })) };
    // Final review FB-1: the temp names are freed before the intent names them (localSlotNext restarts at 0 in every
    // Writer, so tmp/L.<slot>.* may hold an earlier daemon's ring .old); a refusing holder: LOCKED, nothing journaled.
    if (!(await this.freeNames(paths.map((p) => p.files)))) return { kind: 'LOCKED' };
    await this.d.journal(intent);
    const f = flight();
    for (const p of paths) this.inflight.set(p.e.path, f);
    const out = await this.runGroup({ n: 0, paths, local: true }, null, f);
    if (this.stranded.length > 0) {
      // P2-STRANDED: the journaled local intent is the only durable name of the stranded .old: kept until restored.
      // P2-NARROW: kept narrowed to the stranded entries (every stranded restore is this group's: a local write runs
      // only while nothing is stranded), so a restart never rolls back an entry this rollback already undid — e.g. it
      // never removes a file the user created since at a rolled-back create. P2-NARROW-DELETE: a stranded delete is
      // kept as a restore (target := expected), so the narrowed intent is journaled whenever it differs from the
      // journaled one — also for a lone delete, whose entry count is unchanged.
      const kept = narrowLocal(intent, new Set(this.stranded.map((s) => s.path)));
      if (kept.kind === 'local' && kept !== intent) await this.d.journal(kept);
      this.localHeld = true;
      this.d.log.write('error', 'WRITE_LOCAL_INTENT_KEPT', { origin, stranded: this.stranded.length, entries: kept.kind === 'local' ? kept.entries.length : 0 });
    } else {
      await this.d.journal({ kind: 'none' });
    }
    if (out.ok) return out.phantoms.length > 0 ? { kind: 'PHANTOM' } : { kind: 'WRITTEN' };
    const d = out.defer;
    if (d.reason === 'locked') return { kind: 'LOCKED' };
    if (d.reason === 'race') return d.unmaterializable ? { kind: 'DEFERRED', reason: 'unmaterializable' } : { kind: 'COLLISION' };
    if (d.reason === 'mismatch' && d.found !== undefined) return { kind: 'MISMATCH', found: d.found };
    return { kind: 'DEFERRED', reason: d.reason };
  }

  // ---- restart ----

  /**
   * ENG-53 step 4 (writer rollback of a journaled apply or local intent), best effort per path: a failing step is
   * logged and its .old reported, nothing is thrown. Per path, "linked" is DISK_EQ(p, target) (targets: M_disk[p] or
   * newBlob; null = a deletion, linked when p is absent while its .old exists). A group whose paths are all linked is
   * complete; any other group is rolled back completely: a linked modify goes to .redo and its .old is linked back,
   * an absent p gets its .old back, a linked create is removed, anything else at p stays. Every .new and .redo of the
   * intent is deleted; the .old files that remain (complete groups, beside a path that stayed, or a restore that
   * failed) are reported for the restart's many-candidates step and leave the ring. Carried paths are never looked at;
   * a path beneath a symlink or junction (P2-NOFOLLOW) is never touched. The intent is the caller's from here: a local
   * intent this writer kept (P2-STRANDED) is never cleared by the writer afterwards. A kept local intent holds a
   * stranded delete as a restore (target := expected, P2-NARROW-DELETE): with p absent it is an unlinked modify, so
   * its group is rolled back and the .old relinked; with p back at expected it is linked; anything else at p stays
   * and the .old is reported.
   */
  rollbackIntent(intent: Intent, targets: ReadonlyMap<string, TreeEntry | null>): Promise<RollbackReport> {
    return this.serial(async () => {
      this.localHeld = false;
      const report: RollbackReport = { complete: [], rolledBack: [], leftoverOld: [] };
      type Item = { path: string; kind: WriteKind; noop: boolean; files: Files };
      const groups: Array<{ n: number; items: Item[] }> =
        intent.kind === 'apply'
          ? intent.groups.map((g) => ({ n: g.n, items: g.entries.map((e) => ({ path: e.path, kind: e.kind, noop: false, files: this.names(String(g.n), e.slot) })) }))
          : intent.kind === 'local'
            ? [{ n: 0, items: intent.entries.map((e) => ({
              path: e.path,
              kind: (e.target === 'DELETE' ? 'delete' : e.expected === ABSENT ? 'create' : 'modify') as WriteKind,
              noop: e.target === 'DELETE' && e.expected === ABSENT,
              files: this.names(LOCAL_PREFIX, e.slot),
            })) }]
            : [];
      const leave = (it: Item): void => {
        report.leftoverOld.push({ path: it.path, file: it.files.old });
      };
      const fail = (what: string, path: string, e: unknown): void => {
        if (e instanceof KilledAt) throw e;
        this.d.log.write('error', 'ROLLBACK_INTENT_STEP', { step: what, path, code: errorCode(e) });
      };
      for (const g of groups) {
        const state: Array<{ it: Item; abs: string; linked: boolean; old: boolean; skip: boolean }> = [];
        for (const it of g.items) {
          const abs = this.workFile(it.path);
          if (this.carried(it.path)) {
            state.push({ it, abs, linked: false, old: false, skip: true });
            continue;
          }
          const old = (await this.lstatQuiet(it.files.old)) !== null;
          if (!(await this.ancestorsSafe(it.path))) {
            state.push({ it, abs, linked: false, old, skip: true });
            continue;
          }
          let linked = false;
          try {
            if (it.kind === 'delete') {
              linked = (await this.lstatQuiet(abs)) === null && (old || it.noop);
            } else {
              const t = targets.get(it.path) ?? null;
              linked = t !== null && (await this.d.diskEq.eq(it.path, t, null)).equal;
            }
          } catch (e) {
            fail('look', it.path, e);
          }
          state.push({ it, abs, linked, old, skip: false });
        }
        if (state.every((s) => s.linked)) {
          report.complete.push(g.n);
          for (const s of state) if (s.old) leave(s.it);
        } else {
          report.rolledBack.push(g.n);
          for (const s of state) {
            if (s.skip) {
              if (s.old) leave(s.it);
              continue;
            }
            try {
              if (s.it.kind === 'create') {
                if (s.linked) await this.unlinkQuiet(s.abs);
                continue;
              }
              if (!s.old) continue;   // never renamed: p was not touched
              let back = false;
              if ((await this.lstatQuiet(s.abs)) === null) {
                back = (await this.relink(s.it.path, s.it.files.old, s.abs)).kind === 'ok';
              } else if (s.linked && s.it.kind === 'modify') {
                await this.unlinkQuiet(s.it.files.redo);
                let moved = false;
                try {
                  await this.d.fs.rename(s.abs, s.it.files.redo);
                  moved = true;
                } catch (e) {
                  fail('to_redo', s.it.path, e);   // a holder refuses: p stays as written
                }
                if (moved) back = (await this.relink(s.it.path, s.it.files.old, s.abs)).kind === 'ok';
              }
              if (!back) leave(s.it);
            } catch (e) {
              fail('restore', s.it.path, e);
              if ((await this.lstatQuiet(s.it.files.old)) !== null) leave(s.it);
            }
          }
        }
        for (const s of state) {
          for (const f of [s.it.files.new, s.it.files.redo]) {
            try {
              await this.unlinkQuiet(f);
            } catch (e) {
              fail('unlink_tmp', s.it.path, e);
            }
          }
        }
      }
      // The reported .old files are the restart's now: they leave the ring and the stranded list. A later group that
      // needs such a name moves the holder to tmp/orphan-<ulid>.old and keeps it there, never ringed or deleted (its
      // path is logged with WRITE_TMP_ORPHAN; P2-STRANDED, P2-ORPHANNAMES).
      const handed = new Set(report.leftoverOld.map((l) => l.file));
      for (const l of report.leftoverOld) this.leftover.set(l.file, l.path);
      this.ring = this.ring.filter((r) => !handed.has(r.file));
      this.stranded = this.stranded.filter((s) => !handed.has(s.old));
      return report;
    });
  }

  // ---- gate query ----

  /**
   * ENG-38, from memory: 'applying' while p's group of the running call has not reached P1 (nothing of it moved);
   * from P1 to the end of RT the answer waits for the group, at most PATH_BUSY_WAIT_MS, then 'busy' (G1 PATH_BUSY);
   * 'pending' for a path of a deferred apply group not written since; otherwise 'idle'.
   */
  async pathState(path: string): Promise<'idle' | 'applying' | 'pending' | 'busy'> {
    const f = this.inflight.get(path);
    if (f !== undefined) {
      if (!f.window) return 'applying';
      const busy = await Promise.race([f.done.then(() => false), this.d.clock.sleep(PATH_BUSY_WAIT_MS).then(() => true)]);
      if (busy) return 'busy';
    }
    return this.pendingPaths.has(path) ? 'pending' : 'idle';
  }

  /**
   * Whether a hard link works from tmpDir into the work tree (glossary §26.2 item 7): 'link', else the copy fallback —
   * also for a gitdir on another volume than the work tree (EXDEV). The probe links tmp/link-probe.a to a free name at
   * the work-tree root that D6 never admits (`~cowork-link-probe[-<k>].tmp`) and removes both. A name held by anything
   * but this probe's own crash leftover (a second link of tmp/link-probe.a) is never touched.
   */
  static async probeMode(fs: Fs, tmpDir: string, workTree: string): Promise<'link' | 'copy'> {
    const a = join(tmpDir, 'link-probe.a');
    const quiet = async (p: string): Promise<void> => {
      try {
        await fs.unlink(p);
      } catch {
        // best effort: a leftover probe name is a temp name, never admitted
      }
    };
    const names = Array.from({ length: PROBE_NAMES }, (_, k) => join(workTree, k === 0 ? `${PROBE_BASE}.tmp` : `${PROBE_BASE}-${k}.tmp`));
    const sa = await fs.lstat(a);
    if (sa !== null && sa.isFile && sa.ino !== 0n) {
      for (const n of names) {
        const sn = await fs.lstat(n);
        if (sn !== null && sn.isFile && sn.ino === sa.ino && sn.dev === sa.dev) await quiet(n);
      }
    }
    try {
      await fs.unlink(a);
    } catch (e) {
      if (!isGone(e)) throw e;
    }
    let b: string | null = null;
    for (const n of names) {
      if ((await fs.lstat(n)) === null) {
        b = n;
        break;
      }
    }
    if (b === null) throw new Error(`writer: no free link-probe name in ${workTree}`);
    await fs.writeFile(a, Buffer.from('cowork link probe\n', 'utf8'));
    let linked = false;
    try {
      await fs.link(a, b);
      linked = true;
      return 'link';
    } catch (e) {
      const c = codeOf(e);
      if (c !== undefined && NO_LINK_CODES.has(c)) return 'copy';
      throw e;
    } finally {
      if (linked) await quiet(b);
      await quiet(a);
    }
  }
}

function deferFor(reason: 'unstable' | 'unreadable' | 'error' | 'carried' | 'filter_failure'): DeferReason {
  switch (reason) {
    case 'unstable':
      return 'unstable';
    case 'carried':
      return 'unmaterializable';
    case 'filter_failure':
      return 'filter_failure';
    default:
      return 'unreadable';
  }
}

/** A P2 failure as a group deferral: EEXIST race; a name this volume cannot hold race (unmaterializable next time); a holder locked; ENOSPC disk_low. */
function p2Defer(e: unknown): unknown {
  if (e instanceof KilledAt || e instanceof DeferGroup) return e;
  const c = codeOf(e);
  if (c === 'EEXIST') return new DeferGroup('race');
  if (c !== undefined && UNMATERIALIZABLE_CODES.has(c)) return new DeferGroup('race', { unmaterializable: true });
  if (c !== undefined && LOCKED_CODES.has(c)) return new DeferGroup('locked');
  if (c === 'ENOSPC') return new DeferGroup('disk_low');
  return e;
}

/**
 * A failure inside P0–P2 that is not a deferral, as one after the rollback (P2-BESTEFFORT-ROLLBACK): ENOSPC disk_low,
 * a failed git process (re-snapshot, re-merge) unreadable, any other fs condition locked; null for a programming
 * error, which is rethrown after the rollback.
 */
function asDefer(e: unknown): DeferGroup | null {
  const c = codeOf(e);
  if (c === 'ENOSPC') return new DeferGroup('disk_low');
  if (e instanceof GitCommandError) return new DeferGroup('unreadable');
  if (c !== undefined) return new DeferGroup('locked');
  return null;
}
