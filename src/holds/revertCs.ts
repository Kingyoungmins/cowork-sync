// The F10 revert kernel (Plan 3 Task 17; rev 2.5, F10; 05-holds §3.6 Algorithm REV, HLD-68, HLD-26 (the `/cowork revert` writeLocal
// source), HLD-41 (the mark note), HLD-50 item 3 (decision D2), §8 Q17, Q18; glossary §6 reverts.jsonl, §20 "Revert", §29.1 D2, §29.2
// "clean HLD-41 rebase", §29.3; rulings X-09, X-10). Roadmap row 3: its own module, not src/holds/revert.ts (the HLD-27 detector's).
//
//   locateCs          step 1: a full cs_id, a unique prefix of ≥ 6 characters, <cs_id>@<epoch8> or `last`, within one (peer, epoch)
//                     (HLD-33), over the provenance journal's 14-day window; reasons, never message codes (X-10: Plan 7 maps them)
//   revertInverse     steps 2–5 and 7: the CS's paths (MIXED, rename pairs), the path guards (NOT_LIVE; BUSY in verb mode), the
//                     reverse 3-way per path, newest commit first (4(a) no process, 4(b) whole-path skip, 4(c) merge-file and the one
//                     `--ours` caller), the step-5 TEAMMATE_LINE backstop over the journal; results in memory only — steps 1–7 write
//                     no object and no file (§8 Q17, glossary §26.1 W6)
//   revertView        the undo view (FEAT-F10-10, CCI-68): the same computation in view mode, -U3 diffs computed in-process
//   openRevertCs      step 8 after the verb's WRITTEN: ObservedWrites, the second human-class CS, the revert shrink mark, the
//                     reverts.jsonl line — in that order
//   RevertsJournal    cs/<enc(b)>.reverts.jsonl: one line per confirmed revert and per clean-rebase move of the mark, fsynced
//   RevertMarks       the revert shrink marks (decision D2), held by ChangeSets.revertMarks so ChangeSets.rebase moves them
//   rederiveRevertMarks  §8 Q18 at every attachCsTable: per pending revert CS, per path the newest line matching its journaled content
//
// Engine facts arrive through RevertHost, a structural subset of EngineCore (contract addition 1): this module imports nothing from
// src/engine, and from changesets.ts only types (changesets.ts imports RevertMarks at runtime: no cycle).
//
// Two readings recorded here (Task 17 report): (1) consecutive commits of the CS that are contiguous on a path (no other change of p
// between them: before(newer) == after(older)) revert as one run, merge-file(ours, after(newest), before(oldest)) — the same net
// change, one merge instead of a chain; (2) a path that would need a second step-4(c) merge on top of an earlier merge's output (a
// foreign change of p between two runs of the CS AND after its newest run) has no object to name as `ours` (`merge-file --object-id`
// reads objects, and steps 1–7 write none): it is skipped whole as FILE_CHANGED_LATER, never merged through a written intermediate.
import { dirname } from 'node:path';
import { parseCsTrailers, parseWriter } from '../board/boardCommit.js';
import { canonicalBytes, type Json } from '../board/canonicalJson.js';
import type { PeerId } from '../board/ids.js';
import { matchedRows } from '../data/linediff.js';
import { isBinaryBytes, rows, stripEnding } from '../data/rows.js';
import type { ScopeClass } from '../data/scope.js';
import { runMergeFile } from '../git/merge.js';
import { ABSENT, isOid, parseOid, type Oid } from '../git/oid.js';
import type { FileMode, GitRepo, TreeEntry, TreeMap } from '../git/repo.js';
import type { Clock } from '../ports/clock.js';
import { KilledAt } from '../ports/crashpoint.js';
import { errnoCode, type Fs } from '../ports/fs.js';
import { validId } from '../sec/validators.js';
import type { ChangeSets } from './changesets.js';
import type { ObservedWrites } from './observed.js';
import { blobHash, isNonTrivial, lineHash, PROV_RETENTION_MS, unmatchedRows, type ProvEntry, type ProvenanceJournal } from './provenance.js';
import { blobAt, heldSide, isTerminal } from './record.js';
import type { HoldRegistry } from './registry.js';

/** Glossary §20 "Revert": ≤ 2,000 paths per revert, ≤ 500 merge-file runs per computation, ≤ 30 s (then RF_REVERT_TOO_BIG). */
export const REVERT_MAX_PATHS = 2_000;
export const REVERT_MAX_MERGES = 500;
export const REVERT_MAX_MS = 30_000;
/** cs/<enc(b)>.reverts.jsonl keeps 14 days of local time (glossary §6, §20 "Revert"), pruned at the next append. */
export const REVERTS_RETENTION_MS = PROV_RETENTION_MS;

/** An unqualified id under several (peer, epoch)s, or a prefix of several CSs: at most this many candidates (step 1). */
const AMBIGUOUS_MAX = 5;
/** A prefix names a CS from this many characters on (step 1). */
const PREFIX_MIN = 6;
const QUALIFIED = /^(.+)@([0-9a-f]{8})$/;
const REGULAR: ReadonlySet<string> = new Set(['100644', '100755']);

// ---- the host (contract addition 1) -----------------------------------------------------------------------------------------

/** A (the state's base tree), TIP (the live code of the last checked board) and TIP's commit. */
export interface RevertTrees { A: TreeMap; TIP: TreeMap; tip: Oid; }
/** A path's scope class now (glossary §3) and its EPOCH_BASE attributes (filtered: a filter driver applies; text: DAT-04 text). */
export interface RevertPathInfo { cls: ScopeClass; filtered: boolean; text: boolean; }

/**
 * The structural subset of EngineCore the kernel reads (contract addition 1); EngineCore satisfies it (core.ts adds the members the
 * subset names). Every engine fact is a member function, read when the kernel runs (in a daemon worker, out of cycle).
 */
export interface RevertHost {
  readonly repo: GitRepo; readonly peer: PeerId; readonly clock: Clock; readonly fs: Fs;
  readonly prov: ProvenanceJournal; readonly cs: ChangeSets; readonly holds: HoldRegistry; readonly observed: ObservedWrites;
  /** cs/<enc(b)>.reverts.jsonl of this clone (contract addition 3). */
  readonly reverts: RevertsJournal;
  /** The current epoch of this peer (meta.epoch), null before a state exists: the epoch whose CS table and records are the live ones. */
  revertEpoch(): string | null;
  /** A and TIP now (TIP = the live code of the last checked board, else of LA_B). */
  revertTrees(): Promise<RevertTrees>;
  /** busyPaths' synchronous view: the A and TIP maps as last loaded (by an iteration or revertTrees()), null before. */
  revertTreesNow(): { A: TreeMap; TIP: TreeMap } | null;
  /** The scope class and attributes of each of `paths` now (the attributes at EPOCH_BASE are requested first). */
  revertPaths(paths: readonly string[]): Promise<(path: string) => RevertPathInfo>;
  /** The last materialized S_disk (the state's snap before this run's first materialization). */
  revertSDisk(): Promise<TreeMap>;
  /**
   * DISK_EQ(p, entry) (entry null = ABSENT). read: the staged read (verb mode, ENG-11). Not read: a stat-only test against the
   * snapshot's clean stat of that very blob (view mode: no stage copy, no scratch index, no object; anything else is false).
   */
  revertDiskEq(path: string, entry: TreeEntry | null, read: boolean): Promise<boolean>;
  /** The display name the newest fold holds for a peer id, null when it holds none. */
  displayName(peer: string): string | null;
}

// ---- the results -------------------------------------------------------------------------------------------------------------

/** label = <cs_id>, or <cs_id>@<epoch8> where the id occurs under another epoch too; commits in first-parent order (C(t)). */
export interface CsLocation { csId: string; epoch: string; label: string; commits: readonly Oid[]; }
/** Algorithm REV step 1 (HLD-33 epoch scope; FEAT-F10-02, -13). null = an unknown id (the live-chain grep finds no trailer). No FREEZE test: RF_REVERT_FROZEN is the verb's. */
export type LocateResult = { found: CsLocation } | { ambiguous: string[] } | { notOwn: { name: string } } | { tooOld: true } | { open: true }
  | { notShared: { hid: string | null } } | { noLast: true } | null;
export type RevertSkip = 'NOT_LIVE' | 'BUSY' | 'MIXED' | 'RENAME_PAIR' | 'FILE_CHANGED_LATER' | 'TEAMMATE_LINE' | 'CHANGED_NOW';
export interface RevertResult {
  results: ReadonlyMap<string, Buffer | 'ABSENT'>;                                           // R_rev (X-09): result bytes in stored form, in memory — steps 1–7 write no object or file
  paths: ReadonlyArray<{ path: string; del: number; add: number; disk: Oid | 'ABSENT' }>;    // per result path: rows removed/added, and the disk blob the preview digests
  kept: ReadonlyArray<{ path: string; a: number; b: number; names: string[] }>;             // CHANGED_LATER regions (step 4(c)), with the later writers' display names
  skipped: ReadonlyArray<{ path: string; key: RevertSkip }>;
}
/** View mode (FEAT-F10-10, CCI-68): Plan 5's RevertView shape (Plan 5's undoView.ts imports it). */
export interface RevertView { kind: 'view' | 'notown' | 'summary_only' | 'unknown' | 'ambiguous'; summary: Json;
  paths: ReadonlyArray<{ path: string; diff?: string; human?: string; skip?: 'MIXED' | 'FILE_CHANGED_LATER' | 'RENAME_PAIR' | 'NOT_LIVE' | 'TEAMMATE_LINE' | 'CHANGED_NOW' }>;
  kept: ReadonlyArray<{ path: string; line: number }>; candidates?: readonly string[]; }
export interface RevertLine { cs: string; of: string; t_local_ms: number; written: Record<string, Oid | 'ABSENT'>; }

// ---- RevertsJournal (glossary §6, §29.3) --------------------------------------------------------------------------------------

const LINE_KEYS = 'cs,of,t_local_ms,written';
const WRITE_RETRIES = 3;
const WRITE_RETRY_MS = 50;
const RETRYABLE: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY']);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const writtenValue = (v: unknown): v is Oid | 'ABSENT' => v === ABSENT || isOid(v);

/** A line's fields are a revert line (cs and of change-set ids, t_local_ms a safe integer ≥ 0, written path → oid | ABSENT). */
function validLine(v: unknown): v is RevertLine {
  if (!isObj(v) || Object.keys(v).sort().join(',') !== LINE_KEYS) return false;
  const { cs, of, t_local_ms: t, written } = v;
  if (typeof cs !== 'string' || !validId('cs', cs) || typeof of !== 'string' || !validId('cs', of)) return false;
  if (typeof t !== 'number' || !Number.isSafeInteger(t) || t < 0 || !isObj(written)) return false;
  return Object.entries(written).every(([p, w]) => p.length > 0 && writtenValue(w));
}

/** One canonical JSON line (RFC 8785: members sorted, no whitespace) with its LF. */
function lineText(e: RevertLine): string {
  const written: Record<string, Json> = {};
  for (const [p, w] of Object.entries(e.written)) Object.defineProperty(written, p, { value: w, enumerable: true, writable: true, configurable: true });
  return `${canonicalBytes({ cs: e.cs, of: e.of, t_local_ms: e.t_local_ms, written }).toString('utf8')}\n`;
}

/** path → oid map as the record a line carries (own properties only, so a path named `__proto__` stays a path). */
function writtenRecord(written: Iterable<readonly [string, Oid | 'ABSENT']>): Record<string, Oid | 'ABSENT'> {
  const out: Record<string, Oid | 'ABSENT'> = {};
  for (const [p, w] of [...written].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
    Object.defineProperty(out, p, { value: w, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/**
 * cs/<enc(b)>.reverts.jsonl (glossary §6, §29.3): {cs, of, t_local_ms, written} per confirmed revert, plus one line of the same shape
 * per clean-rebase move of the revert shrink mark (decision D2); never pushed. An append rewrites the file — the lines younger than 14
 * days of local time plus the new one — through a temp file written by Fs.writeFileExclusive (open, write, fsync, close) and a rename,
 * so it resolves only after the line is durable (ENG-36: before the caller's next state update); a crash leaves the old file or the
 * new one. lines() drops a torn last line (and any line that is no revert line). Appends run one at a time.
 */
export class RevertsJournal {
  private readonly fs: Fs;
  private readonly file: string;
  private readonly clock: Clock;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(fs: Fs, file: string, clock: Clock) {
    this.fs = fs;
    this.file = file;
    this.clock = clock;
  }

  /** Appends one line (fsynced) and prunes the lines older than 14 days of local time; an invalid line is a TypeError, nothing written. */
  append(e: RevertLine): Promise<void> {
    return this.serial(async () => {
      if (!validLine(e)) throw new TypeError(`RevertsJournal.append: not a revert line ${JSON.stringify(e)}`);
      const cutoff = Math.floor(this.clock.wallMs()) - REVERTS_RETENTION_MS;
      const kept = (await this.lines()).filter((l) => l.t_local_ms >= cutoff);
      await this.writeAll([...kept, { cs: e.cs, of: e.of, t_local_ms: e.t_local_ms, written: writtenRecord(Object.entries(e.written)) }]);
    });
  }

  /**
   * The line of a clean-rebase move of `cs`'s mark (Algorithm REV step 8): `of` and `t_local_ms` repeat the CS's first line, `written`
   * is the mark's whole current map. False (nothing appended) when no line of `cs` exists: the label and the mark's source are lost
   * (§8 Q18's documented loss).
   */
  async appendMove(cs: string, written: ReadonlyMap<string, Oid | 'ABSENT'>): Promise<boolean> {
    const first = (await this.byCs(cs))[0];
    if (first === undefined) return false;
    await this.append({ cs, of: first.of, t_local_ms: first.t_local_ms, written: writtenRecord(written) });
    return true;
  }

  /** Every complete revert line in file order; a missing file holds none; a torn last line is dropped. */
  async lines(): Promise<RevertLine[]> {
    let text: string;
    try {
      text = (await this.fs.readFile(this.file)).toString('utf8');
    } catch (e) {
      if (errnoCode(e) === 'ENOENT') return [];
      throw e;
    }
    const parts = text.split('\n');
    parts.pop();   // after the last LF: '' for a complete file, a torn line otherwise
    const out: RevertLine[] = [];
    for (const part of parts) {
      let v: unknown;
      try {
        v = JSON.parse(part);
      } catch {
        continue;
      }
      if (validLine(v)) out.push({ cs: v.cs, of: v.of, t_local_ms: v.t_local_ms, written: writtenRecord(Object.entries(v.written)) });
    }
    return out;
  }

  async byCs(cs: string): Promise<RevertLine[]> {
    return (await this.lines()).filter((l) => l.cs === cs);
  }

  /** The "revert of" label: the `of` every line of `cs` carries (its first line's), null when none. */
  async ofCs(cs: string): Promise<string | null> {
    return (await this.byCs(cs))[0]?.of ?? null;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** The whole file by an fsynced temp file and a rename; EPERM/EACCES/EBUSY (a Windows reader) retried 3 × 50 ms on the Clock port. */
  private async writeAll(lines: readonly RevertLine[]): Promise<void> {
    await this.fs.mkdirp(dirname(this.file));
    const tmp = `${this.file}.tmp`;
    const bytes = Buffer.from(lines.map(lineText).join(''), 'utf8');
    for (let attempt = 0; ; attempt++) {
      try {
        await this.fs.unlink(tmp).catch((e: unknown) => {
          if (errnoCode(e) !== 'ENOENT') throw e;
        });
        await this.fs.writeFileExclusive(tmp, bytes);
        await this.fs.rename(tmp, this.file);
        return;
      } catch (e) {
        if (e instanceof KilledAt) throw e;   // a simulated kill leaves what a kill leaves
        if (!RETRYABLE.has(errnoCode(e) ?? '') || attempt >= WRITE_RETRIES) {
          await this.fs.unlink(tmp).catch(() => undefined);
          throw e;
        }
        await this.clock.sleep(WRITE_RETRY_MS);
      }
    }
  }
}

// ---- RevertMarks (glossary §29.1 decision D2) ---------------------------------------------------------------------------------

/**
 * The revert shrink marks (glossary §29.1 decision D2, HLD-50 item 3): per pending revert CS, path → the oid its confirmed write produced
 * (ABSENT for a deletion), carried forward only by a clean HLD-41 rebase whose R[p] before the rebase was the mark's oid; memory, held by
 * ChangeSets.revertMarks (ChangeSets.rebase moves it, published() drops it), re-derived at every attachCsTable (rederiveRevertMarks).
 */
export class RevertMarks {
  private readonly marks = new Map<string, Map<string, Oid | 'ABSENT'>>();

  set(cs: string, written: ReadonlyMap<string, Oid | 'ABSENT'>): void {
    this.marks.set(cs, new Map(written));
  }

  /** A pending mark holds exactly this content for the path (t0Shrink's attributed; ENG-25's lift). */
  covers(path: string, content: Oid | 'ABSENT'): boolean {
    for (const m of this.marks.values()) if (m.has(path) && m.get(path) === content) return true;
    return false;
  }

  /** Moves the mark's oid for `path` to `after` only when it is `before` (a clean HLD-41 rebase of the marked blob); true when it moved. */
  moveOnCleanRebase(cs: string, path: string, before: Oid, after: Oid): boolean {
    const m = this.marks.get(cs);
    if (m === undefined || m.get(path) !== before) return false;
    m.set(path, after);
    return true;
  }

  current(cs: string): ReadonlyMap<string, Oid | 'ABSENT'> | null {
    const m = this.marks.get(cs);
    return m === undefined ? null : new Map(m);
  }

  drop(cs: string): void {
    this.marks.delete(cs);
  }

  /** The revert CSs holding a mark, sorted. */
  pending(): readonly string[] {
    return [...this.marks.keys()].sort();
  }
}

/**
 * The pending condition of a revert CS (05-holds Algorithm REV step 8, §8 Q18, glossary §29.1 D2), one predicate for memory
 * (recordStep's drops) and restart (rederiveRevertMarks): its ready pair in journal/ready/, or its cs_id in the cs_ids of a non-terminal
 * record — never once a record naming it is terminal (RESOLVED_DISCARD, SUBSUMED, … : "the mark ended with the record", TC-F10-17 (c)) —
 * or, between openRevertCs and its first capture, its table entry closed and never captured (cap_seq 0).
 */
export function revertCsPending(core: Pick<RevertHost, 'cs' | 'holds'>, cs: string): boolean {
  const named = core.holds.all().filter((r) => r.cs_ids.includes(cs));
  if (named.some(isTerminal)) return false;
  if (named.length > 0) return true;
  if (core.cs.ready().some((p) => p.csId === cs)) return true;
  return core.cs.table().cs.some((e) => e.cs_id === cs && e.state === 'closed' && e.cap_seq === 0);
}

/**
 * The marks of revert CSs that are no longer pending (revertCsPending) end — the record naming the CS turned terminal, or its pair left
 * journal/ready/ with no record naming it (a cancelled capture). Memory only; returns the CSs whose mark ended. recordStep's sweep (Task
 * 17) and prepareIteration before its tick, so a discarded revert's mark never lifts ENG-25 or T0 again (TC-F10-17 (c)).
 */
export function endRevertMarks(core: Pick<RevertHost, 'cs' | 'holds'>): string[] {
  const out: string[] = [];
  for (const cs of core.cs.revertMarks.pending()) {
    if (revertCsPending(core, cs)) continue;
    core.cs.revertMarks.drop(cs);
    out.push(cs);
  }
  return out;
}

/** The content the state journals for a pending revert CS: its ready pair's R (ABSENT where R lacks a pair path), else the held side of a non-terminal record naming it. */
async function journaledContent(core: RevertHost, cs: string): Promise<Map<string, Oid | 'ABSENT'> | null> {
  const out = new Map<string, Oid | 'ABSENT'>();
  const pair = core.cs.ready().find((p) => p.csId === cs);
  if (pair !== undefined) {
    const R = await core.repo.readTreeMap(pair.R);
    for (const p of pair.paths) out.set(p, R.get(p)?.oid ?? ABSENT);
    return out;
  }
  const r = core.holds.nonTerminal().filter((x) => x.cs_ids.includes(cs)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  if (r === undefined) return null;
  const held = heldSide(r);
  for (const p of r.paths) out.set(p, blobAt(held, p) ?? ABSENT);
  return out;
}

/**
 * §8 Q18 at start and restart (the last step of attachCsTable, contract addition 4): the marks of this run are replaced by those
 * reverts.jsonl gives — for each cs still pending (revertCsPending), per path the newest line of that cs whose oid equals the CS's
 * journaled content (its ready pair's R[p], or the record's blob); a path with no matching line gets no mark. A missing or unreadable
 * file gives none (the documented loss: the ordinary shrink guard applies).
 */
export async function rederiveRevertMarks(core: RevertHost): Promise<void> {
  const marks = core.cs.revertMarks;
  for (const cs of marks.pending()) marks.drop(cs);
  let lines: RevertLine[];
  try {
    lines = await core.reverts.lines();
  } catch (e) {
    if (e instanceof KilledAt) throw e;
    return;
  }
  const byCs = new Map<string, RevertLine[]>();
  for (const l of lines) {
    const ls = byCs.get(l.cs);
    if (ls === undefined) byCs.set(l.cs, [l]);
    else ls.push(l);
  }
  for (const [cs, ls] of byCs) {
    if (!revertCsPending(core, cs)) continue;
    const content = await journaledContent(core, cs);
    if (content === null) continue;
    const mark = new Map<string, Oid | 'ABSENT'>();
    for (const [p, want] of content) {
      for (let i = ls.length - 1; i >= 0; i--) {
        const w = ls[i]!.written;
        if (Object.hasOwn(w, p) && w[p] === want) {
          mark.set(p, want);
          break;
        }
      }
    }
    if (mark.size > 0) marks.set(cs, mark);
  }
}

// ---- step 8: the revert CS ------------------------------------------------------------------------------------------------------

/**
 * Algorithm REV step 8 after the verb's writeLocalGroup returned WRITTEN (its writes carry origin `revert:<of>`, `of` = the reverted CS's
 * id, known before the write): ObservedWrites.record(p, written) per path (an observed delta, HLD-26: no revert record, no MASS),
 * cs.addRevertCs(paths), revertMarks.set(cs, written), then RevertsJournal.append({cs, of, t_local_ms, written}) (fsynced); returns the
 * new cs_id. A crash before this call leaves the written paths an ordinary unobserved human delta with no mark (Task 17 brief).
 */
export async function openRevertCs(core: RevertHost, of: string, written: ReadonlyMap<string, Oid | 'ABSENT'>): Promise<string> {
  if (!validId('cs', of)) throw new TypeError(`openRevertCs: not a change-set id ${JSON.stringify(of)}`);
  if (written.size === 0) throw new TypeError('openRevertCs: no written path');
  for (const [p, w] of written) core.observed.record(p, w);
  const cs = core.cs.addRevertCs([...written.keys()]);
  core.cs.revertMarks.set(cs, written);
  await core.reverts.append({ cs, of, t_local_ms: Math.floor(core.clock.wallMs()), written: writtenRecord(written) });
  return cs;
}

// ---- step 1: locate ----------------------------------------------------------------------------------------------------------

/** The journal entries inside the 14-day window (HLD-25), first-parent order. */
function windowEntries(core: RevertHost): ProvEntry[] {
  const cutoff = Math.floor(core.clock.wallMs()) - PROV_RETENTION_MS;
  return core.prov.journalEntries().filter((e) => e.t_local_ms >= cutoff);
}

/** One CS of the window: an id within one (peer, epoch), its journal entries (first-parent order) and their writers. */
interface WindowCs { csId: string; epoch: string; entries: ProvEntry[]; }

/** The epoch of a live commit's Cowork-Writer (null when it has none: a base-move or foreign commit). */
async function epochOf(core: RevertHost, memo: Map<string, string | null>, commit: string): Promise<string | null> {
  if (memo.has(commit)) return memo.get(commit)!;
  const c = await core.repo.readCommit(parseOid(commit));
  const w = c.trailers.find((t) => t.key === 'Cowork-Writer');
  const epoch = w === undefined ? null : (parseWriter(w.value)?.epoch ?? null);
  memo.set(commit, epoch);
  return epoch;
}

/** The (id, epoch) groups of the window entries carrying an id `match` accepts. */
async function groupsOf(core: RevertHost, win: readonly ProvEntry[], match: (id: string) => boolean, memo: Map<string, string | null>): Promise<WindowCs[]> {
  const groups = new Map<string, WindowCs>();
  for (const e of win) {
    const ids = e.cs_ids.filter(match);
    if (ids.length === 0) continue;
    const epoch = await epochOf(core, memo, e.commit);
    if (epoch === null) continue;
    for (const id of ids) {
      const key = `${id}\0${epoch}`;
      const g = groups.get(key);
      if (g === undefined) groups.set(key, { csId: id, epoch, entries: [e] });
      else g.entries.push(e);
    }
  }
  return [...groups.values()].sort((a, b) => (a.csId < b.csId ? -1 : a.csId > b.csId ? 1 : a.epoch < b.epoch ? -1 : a.epoch > b.epoch ? 1 : 0));
}

const qualified = (g: WindowCs): string => `${g.csId}@${g.epoch.slice(0, 8)}`;

/** The label of a group: qualified where its id occurs under another epoch of the window too. */
function labelOf(g: WindowCs, all: readonly WindowCs[], forced: boolean): string {
  return forced || all.some((x) => x.csId === g.csId && x.epoch !== g.epoch) ? qualified(g) : g.csId;
}

/**
 * Step 1's not-shared test (FEAT-F10-13): {hid} of a non-terminal record whose cs_ids contain csId, {hid: null} for a journaled ready
 * pair (or a closed CS still in the table, waiting for its capture), null when shared. A reason, not a code: Plan 7 maps it to its
 * cli-area RF_REVERT_NOT_SHARED; HOLD_CODES stays 38 (X-10).
 */
export function revertNotShared(core: RevertHost, csId: string): { hid: string | null } | null {
  const rec = core.holds.nonTerminal().filter((r) => r.cs_ids.includes(csId)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  if (rec !== undefined) return { hid: rec.id };
  if (core.cs.ready().some((p) => p.csId === csId)) return { hid: null };
  if (core.cs.table().cs.some((e) => e.cs_id === csId && e.state === 'closed')) return { hid: null };
  return null;
}

/** Not open, no journaled ready pair, no non-terminal record naming it, not in the CS table at all (Plan 6's X6-40 input). */
export function isFullyShared(core: RevertHost, csId: string): boolean {
  return !core.cs.table().cs.some((e) => e.cs_id === csId) && revertNotShared(core, csId) === null;
}

/** Steps 1's own-CS tests on one group: NOT_OWN (any writer ≠ this peer), OPEN, NOT_SHARED — the table and records only for this epoch. */
function judge(core: RevertHost, g: WindowCs, label: string): LocateResult {
  const other = g.entries.find((e) => e.writer !== core.peer);
  if (other !== undefined) return { notOwn: { name: core.displayName(other.writer) ?? other.writer } };
  if (g.epoch === core.revertEpoch()) {
    if (core.cs.table().cs.some((e) => e.cs_id === g.csId && e.state === 'open')) return { open: true };
    const ns = revertNotShared(core, g.csId);
    if (ns !== null) return { notShared: ns };
  }
  return { found: { csId: g.csId, epoch: g.epoch, label, commits: g.entries.map((e) => parseOid(e.commit)) } };
}

/** C(t) empty: a CS of this peer still in the table only (open, or closed and not yet in the live chain), else null. */
function localOnly(core: RevertHost, match: (id: string) => boolean): LocateResult {
  const e = core.cs.table().cs.filter((x) => match(x.cs_id)).sort((a, b) => (a.cs_id < b.cs_id ? -1 : a.cs_id > b.cs_id ? 1 : 0))[0];
  if (e === undefined) return null;
  if (e.state === 'open') return { open: true };
  return { notShared: revertNotShared(core, e.cs_id) ?? { hid: null } };
}

/**
 * C(t) empty: one rev-list --first-parent -F --grep='Cowork-CS: <t> ' over the live chain (the trailing space for a full id); for the
 * qualified form also --grep='/<epoch8>' with --all-match (the Cowork-Writer line `<peer>/<epoch>/<seq>` of the same commit).
 */
async function onLiveChain(core: RevertHost, id: string, full: boolean, epoch8: string | null): Promise<boolean> {
  const { tip } = await core.revertTrees();
  const grep = [`--grep=Cowork-CS: ${id}${full ? ' ' : ''}`, ...(epoch8 === null ? [] : ['--all-match', `--grep=/${epoch8}`])];
  const r = await core.repo.run(['rev-list', '--first-parent', '--max-count=1', '-F', ...grep, tip]);
  return r.stdout.toString('utf8').trim().length > 0;
}

/**
 * `last` (step 1, FEAT-F10-13): the newest closed CS of this peer — a closed CS of the table that is not yet in the live chain first (local
 * close order: one still waiting for its first capture, then by capture order), else the CS of this peer's newest commit in the window
 * (its cs_ids newest capture first), open CSs ignored. It is judged as found, never skipped: `last` refuses rather than reach an older CS.
 */
async function locateLast(core: RevertHost, win: readonly ProvEntry[], memo: Map<string, string | null>): Promise<LocateResult> {
  const table = core.cs.table();
  const live = new Set(win.flatMap((e) => e.cs_ids));
  const local = table.cs.filter((e) => e.state === 'closed' && !live.has(e.cs_id));
  if (local.length > 0) {
    const rank = (id: string): number => table.orders[id] ?? Number.MAX_SAFE_INTEGER;
    const newest = [...local].sort((a, b) => rank(b.cs_id) - rank(a.cs_id) || (a.cs_id < b.cs_id ? 1 : -1))[0]!;
    return { notShared: revertNotShared(core, newest.cs_id) ?? { hid: null } };
  }
  const current = core.revertEpoch();
  for (let i = win.length - 1; i >= 0; i--) {
    const e = win[i]!;
    if (e.writer !== core.peer) continue;
    const epoch = await epochOf(core, memo, e.commit);
    if (epoch === null) continue;
    for (const id of [...e.cs_ids].reverse()) {
      if (epoch === current && table.cs.some((x) => x.cs_id === id && x.state === 'open')) continue;   // open CSs are ignored
      const all = await groupsOf(core, win, (x) => x === id, memo);
      const g = all.find((x) => x.epoch === epoch)!;
      return judge(core, g, labelOf(g, all, false));
    }
  }
  return { noLast: true };
}

/** Algorithm REV step 1 (HLD-33 epoch scope; FEAT-F10-02, -13); see LocateResult. Writes nothing. */
export async function locateCs(core: RevertHost, t: string, _o: { mode: 'verb' | 'view' }): Promise<LocateResult> {
  const memo = new Map<string, string | null>();
  const win = windowEntries(core);
  if (t === 'last') return locateLast(core, win, memo);
  const q = QUALIFIED.exec(t);
  const id = q === null ? t : q[1]!;
  const epoch8 = q === null ? null : q[2]!;
  const full = validId('cs', id);
  if (!full && (q !== null || id.length < PREFIX_MIN)) return null;   // a qualified form names a full id; a prefix has ≥ 6 characters
  const match = full ? (x: string): boolean => x === id : (x: string): boolean => x.startsWith(id);
  const all = await groupsOf(core, win, match, memo);
  const found = epoch8 === null ? all : all.filter((g) => g.epoch.startsWith(epoch8));
  if (found.length === 0) {
    const local = epoch8 === null ? localOnly(core, match) : null;
    if (local !== null) return local;
    return (await onLiveChain(core, id, full, epoch8)) ? { tooOld: true } : null;
  }
  if (found.length > 1) {
    return { ambiguous: found.slice(0, AMBIGUOUS_MAX).map((g) => (found.some((x) => x.csId === g.csId && x !== g) ? qualified(g) : g.csId)) };
  }
  const g = found[0]!;
  return judge(core, g, labelOf(g, all, epoch8 !== null));
}

// ---- steps 2–7: the reverse 3-way ---------------------------------------------------------------------------------------------

/** Paths in an open or unpublished CS, under a non-terminal record, or with A[p] ≠ TIP[p] (step 3's state part; memory only). */
export function busyPaths(core: RevertHost): ReadonlySet<string> {
  const out = new Set<string>(core.cs.openPaths());
  for (const pair of core.cs.ready()) for (const p of pair.paths) out.add(p);
  for (const r of core.holds.nonTerminal()) for (const p of r.paths) out.add(p);
  const t = core.revertTreesNow();
  if (t !== null) {
    for (const [p, e] of t.A) if (!sameSide(e, t.TIP.get(p) ?? null)) out.add(p);
    for (const p of t.TIP.keys()) if (!t.A.has(p)) out.add(p);
  }
  return out;
}

/** Equal sides: oid and mode, or both absent. (src/holds cannot import src/engine/treeDiff.ts; the same one-line test as changesets.ts.) */
function sameSide(a: TreeEntry | null, b: TreeEntry | null): boolean {
  return a === null ? b === null : b !== null && a.oid === b.oid && a.mode === b.mode;
}

/** One commit's change of a path: the sides of diff(parent(c), c). */
interface PathChange { commit: Oid; before: TreeEntry | null; after: TreeEntry | null; }

/**
 * diff-tree -r -z -M --no-ext-diff --no-textconv (glossary §18) of a commit against its first parent: every changed path with its two
 * sides (a rename's old path deleted, its new path created) and the rename pairs.
 */
async function commitChanges(repo: GitRepo, parent: Oid, commit: Oid): Promise<{ paths: Map<string, PathChange>; renames: Array<[string, string]> }> {
  const r = await repo.run(['diff-tree', '-r', '-z', '-M', '--no-ext-diff', '--no-textconv', '--no-commit-id', parent, commit]);
  const parts = r.stdout.toString('utf8').split('\0');
  const paths = new Map<string, PathChange>();
  const renames: Array<[string, string]> = [];
  const side = (path: string, mode: string, oid: string): TreeEntry | null => (/^0+$/.test(oid) || mode === '000000' ? null : { path, mode: mode as FileMode, oid: parseOid(oid) });
  for (let i = 0; i < parts.length;) {
    const meta = parts[i]!;
    if (meta.length === 0) {
      i += 1;
      continue;
    }
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d*)$/.exec(meta);
    if (m === null) throw new Error(`revertInverse: unexpected diff-tree record ${JSON.stringify(meta.slice(0, 120))}`);
    const [, srcMode, dstMode, srcOid, dstOid, status] = m as unknown as [string, string, string, string, string, string];
    if (status === 'R' || status === 'C') {
      const src = parts[i + 1]!;
      const dst = parts[i + 2]!;
      if (status === 'R') {
        paths.set(src, { commit, before: side(src, srcMode, srcOid), after: null });
        renames.push([src, dst]);
      }
      paths.set(dst, { commit, before: status === 'R' ? null : side(dst, srcMode, srcOid), after: side(dst, dstMode, dstOid) });
      i += 3;
    } else {
      const p = parts[i + 1]!;
      paths.set(p, { commit, before: side(p, srcMode, srcOid), after: side(p, dstMode, dstOid) });
      i += 2;
    }
  }
  return { paths, renames };
}

/** One run of the CS's commits on a path (newest first): the net change after(newest) ← before(oldest) of commits contiguous on p. */
interface Run { after: TreeEntry | null; before: TreeEntry | null; }

/** The CS's changes of p (first-parent order) as runs, newest first: a commit joins the newer run when its after is that run's before. */
function runsOf(changes: readonly PathChange[]): Run[] {
  const runs: Run[] = [];
  for (const ch of [...changes].reverse()) {
    const last = runs[runs.length - 1];
    if (last !== undefined && sameSide(last.before, ch.after)) last.before = ch.before;
    else runs.push({ after: ch.after, before: ch.before });
  }
  return runs;
}

/** The longest run of '<', '=' or '>' starting a row of any blob (row 1's BOM ignored), + 1, at least 7: unambiguous conflict markers. */
function markerSize(...blobs: readonly Buffer[]): number {
  let longest = 6;
  for (const b of blobs) {
    let first = true;
    for (const row of rows(b)) {
      const r = first && row.length >= 3 && row[0] === 0xef && row[1] === 0xbb && row[2] === 0xbf ? row.subarray(3) : row;
      first = false;
      const c = r[0];
      if (c !== 0x3c && c !== 0x3d && c !== 0x3e) continue;
      let n = 0;
      while (n < r.length && r[n] === c) n++;
      if (n > longest) longest = n;
    }
  }
  return longest + 1;
}

/**
 * The conflict regions of a plain merge-file output with markers of size M, as 1-based row ranges [a, b] of the `--ours` output (the
 * same rows with each conflict replaced by its ours side; an empty ours side gives b = a − 1) and the ours rows of each.
 */
function conflictRegions(out: Buffer, M: number): Array<{ a: number; b: number; rows: Buffer[] }> {
  const open = '<'.repeat(M);
  const mid = '='.repeat(M);
  const close = '>'.repeat(M);
  const regions: Array<{ a: number; b: number; rows: Buffer[] }> = [];
  let line = 0;
  let state: 'normal' | 'ours' | 'theirs' = 'normal';
  let cur: { a: number; b: number; rows: Buffer[] } | null = null;
  for (const row of rows(out)) {
    const s = stripEnding(row).toString('latin1');
    const isMarker = (m: string): boolean => s === m || s.startsWith(`${m} `);
    if (state === 'normal' && isMarker(open)) {
      state = 'ours';
      cur = { a: line + 1, b: line, rows: [] };
      continue;
    }
    if (state === 'ours' && s === mid) {
      state = 'theirs';
      continue;
    }
    if (state === 'theirs' && isMarker(close)) {
      state = 'normal';
      regions.push(cur!);
      cur = null;
      continue;
    }
    if (state === 'theirs') continue;
    line += 1;
    if (state === 'ours') {
      cur!.b = line;
      cur!.rows.push(row);
    }
  }
  return regions;
}

/** What the reverse 3-way holds for p: an existing side (an object, or ABSENT), or bytes a merge printed (no object). */
type Ours = { kind: 'entry'; entry: TreeEntry | null } | { kind: 'bytes'; bytes: Buffer; mode: FileMode };

/**
 * Algorithm REV steps 2–7 (FEAT-F10-03…-06). The one `merge-file --ours` caller (step 4(c); L-HOLD-STORES, glossary §29.3); step 5's
 * TEAMMATE_LINE backstop reads core.prov. Past REVERT_MAX_PATHS, REVERT_MAX_MERGES or REVERT_MAX_MS → {tooBig: true} (Plan 7's
 * RF_REVERT_TOO_BIG); empty results → Plan 7's RF_REVERT_NOTHING. Never runs in a hook. Steps 1–7 write no object and no file: the
 * merges print to stdout (--object-id over existing objects), every comparison is in memory or a stat (view mode), and the result bytes
 * stay in memory (§8 Q17; the confirm's `hash-object -w` is Plan 7's step 8).
 */
export async function revertInverse(core: RevertHost, loc: CsLocation, o: { mode: 'verb' | 'view' }): Promise<RevertResult | { tooBig: true }> {
  const start = core.clock.monoMs();
  const repo = core.repo;
  const self = core.peer;
  const tooLong = (): boolean => core.clock.monoMs() - start > REVERT_MAX_MS;

  // Step 2: the CS's paths in each c ∈ C(t) (its Cowork-CS-Paths, or every path of the commit without one), MIXED, rename pairs.
  const perPath = new Map<string, PathChange[]>();
  const mixed = new Set<string>();
  const renames: Array<[string, string]> = [];
  for (const c of loc.commits) {
    const info = await repo.readCommit(c);
    const parent = info.parents[0];
    if (parent === undefined) continue;
    const { cs, paths } = parseCsTrailers(info.trailers);
    if (!cs.some((x) => x.csId === loc.csId)) continue;
    const listed = paths.get(loc.csId);
    const changes = await commitChanges(repo, parent, c);
    for (const [p, ch] of changes.paths) {
      if (listed !== undefined && !listed.includes(p)) continue;
      if (cs.some((x) => x.csId !== loc.csId && (paths.get(x.csId)?.includes(p) ?? true))) mixed.add(p);
      const list = perPath.get(p);
      if (list === undefined) perPath.set(p, [ch]);
      else list.push(ch);
    }
    for (const [a, b] of changes.renames) if (perPath.has(a) && perPath.has(b)) renames.push([a, b]);
    if (perPath.size > REVERT_MAX_PATHS || tooLong()) return { tooBig: true };
  }
  const all = [...perPath.keys()].sort();

  // Step 3: path guards — NOT_LIVE; in verb mode BUSY (an open or unpublished CS, a non-terminal record, A[p] ≠ TIP[p], ¬DISK_EQ(p, A[p])).
  const skipped = new Map<string, RevertSkip>();
  const info = await core.revertPaths(all);
  const trees = o.mode === 'verb' ? await core.revertTrees() : null;
  const busy = o.mode === 'verb' ? busyPaths(core) : new Set<string>();
  const sDisk = o.mode === 'view' ? await core.revertSDisk() : null;
  for (const p of all) {
    if (mixed.has(p)) skipped.set(p, 'MIXED');
    else if (info(p).cls !== 'LIVE') skipped.set(p, 'NOT_LIVE');
    else if (trees !== null) {
      const a = trees.A.get(p) ?? null;
      if (busy.has(p) || !sameSide(a, trees.TIP.get(p) ?? null) || !(await core.revertDiskEq(p, a, true))) skipped.set(p, 'BUSY');
    }
  }

  // Blob bytes, read once per oid (cat-file --batch: no object written).
  const blobs = new Map<string, Buffer>();
  const bytesOf = async (e: TreeEntry): Promise<Buffer> => {
    let b = blobs.get(e.oid);
    if (b === undefined) blobs.set(e.oid, (b = await repo.readBlob(e.oid)));
    return b;
  };
  const bytesOfOurs = async (x: Ours): Promise<Buffer | null> => (x.kind === 'bytes' ? x.bytes : x.entry === null ? null : bytesOf(x.entry));

  // The journal entries of C(t) (step 5's own add/del sets) and the later ones (the kept regions' writers).
  const commits = new Set<string>(loc.commits);
  const entries = core.prov.journalEntries();
  const firstAt = entries.findIndex((e) => commits.has(e.commit));
  const own = entries.filter((e) => commits.has(e.commit));
  const later = firstAt < 0 ? [] : entries.slice(firstAt + 1).filter((e) => !commits.has(e.commit));

  // Step 4: the reverse 3-way per path, newest commit first.
  let merges = 0;
  const initial = new Map<string, TreeEntry | null>();
  const finals = new Map<string, Ours>();
  const keptOf = new Map<string, Array<{ a: number; b: number; names: string[] }>>();
  for (const p of all) {
    if (skipped.has(p)) continue;
    if (tooLong()) return { tooBig: true };
    let ours0: TreeEntry | null;
    if (trees !== null) ours0 = trees.A.get(p) ?? null;   // BUSY guarantees S_disk[p] = A[p] = TIP[p] (an existing object)
    else {
      // View mode (§8 Q17 (a)): the newest materialized blob, only while the disk still holds it (a stat test, no read).
      ours0 = sDisk!.get(p) ?? null;
      if (!(await core.revertDiskEq(p, ours0, false))) {
        skipped.set(p, 'CHANGED_NOW');
        continue;
      }
    }
    initial.set(p, ours0);
    let ours: Ours = { kind: 'entry', entry: ours0 };
    let regions: Array<{ a: number; b: number; rows: Buffer[] }> = [];
    let skip: RevertSkip | null = null;
    for (const run of runsOf(perPath.get(p)!)) {
      // (a) nobody touched p since: ours := before (a created file deleted, a deleted file restored); no process.
      const same = ours.kind === 'entry' ? sameSide(ours.entry, run.after)
        : run.after !== null && run.after.mode === ours.mode && (await bytesOf(run.after)).equals(ours.bytes);
      if (same) {
        ours = { kind: 'entry', entry: run.before };
        regions = [];
        continue;
      }
      // (b) an ABSENT side, a binary or filtered path, or a mode difference: the whole path is skipped.
      const oursMode: FileMode | null = ours.kind === 'entry' ? (ours.entry?.mode ?? null) : ours.mode;
      if (oursMode === null || run.after === null || run.before === null || !REGULAR.has(oursMode)
        || run.after.mode !== oursMode || run.before.mode !== oursMode || info(p).filtered) {
        skip = 'FILE_CHANGED_LATER';
        break;
      }
      const cur = (await bytesOfOurs(ours))!;
      const after = await bytesOf(run.after);
      const before = await bytesOf(run.before);
      if (isBinaryBytes(cur) || isBinaryBytes(after) || isBinaryBytes(before)) {
        skip = 'FILE_CHANGED_LATER';
        break;
      }
      // A second merge on top of an earlier merge's output would need that output as an object (see the file comment).
      if (ours.kind === 'bytes') {
        skip = 'FILE_CHANGED_LATER';
        break;
      }
      // (c) mf(ours, after, before): rc 0 → its output; rc > 0 → the same run with --ours, each conflict a kept hunk. No marker is written.
      if (merges + 1 > REVERT_MAX_MERGES) return { tooBig: true };
      merges += 1;
      const M = markerSize(cur, after, before);
      // Rulings G1-FILEFORM, G1-RC: through the one merge-file executor; an abnormal end (a git BUG()/fatal, a kill, a count without
      // git's marker rows, an unreadable side) is rc -1, never a merge.
      const plain = await runMergeFile(repo, ['merge-file', '-p', '--object-id', `--marker-size=${M}`, ours.entry!.oid, run.after.oid, run.before.oid]);
      if (plain.rc < 0) {
        skip = 'FILE_CHANGED_LATER';
        break;
      }
      if (plain.rc === 0) {
        ours = { kind: 'bytes', bytes: plain.out, mode: oursMode as FileMode };
        continue;
      }
      if (merges + 1 > REVERT_MAX_MERGES) return { tooBig: true };
      merges += 1;
      const kept = await runMergeFile(repo, ['merge-file', '-p', '--object-id', '--ours', ours.entry!.oid, run.after.oid, run.before.oid]);
      if (kept.rc !== 0) {
        skip = 'FILE_CHANGED_LATER';
        break;
      }
      regions = conflictRegions(plain.out, M);
      ours = { kind: 'bytes', bytes: kept.out, mode: oursMode as FileMode };
    }
    if (skip !== null) {
      skipped.set(p, skip);
      continue;
    }
    finals.set(p, ours);
    if (regions.length > 0) {
      keptOf.set(p, regions.map((r) => {
        const hashes = new Set(r.rows.map((x) => stripEnding(x)).filter(isNonTrivial).map((x) => lineHash(x)));
        const writers = new Set(later.filter((e) => e.paths[p]?.add.some((h) => hashes.has(h)) === true).map((e) => e.writer));
        return { a: r.a, b: r.b, names: [...writers].map((w) => core.displayName(w) ?? w).sort() };
      }));
    }
  }

  // Step 7 (first half): R_rev = the paths with ours ≠ S_disk[p]; step 5, the taint backstop, on each of them.
  const results = new Map<string, Buffer | 'ABSENT'>();
  const counts = new Map<string, { del: number; add: number }>();
  for (const [p, ours] of finals) {
    const s0 = initial.get(p) ?? null;
    if (ours.kind === 'entry' && sameSide(ours.entry, s0)) continue;
    const from = s0 === null ? null : await bytesOf(s0);
    const to = await bytesOfOurs(ours);
    if (ours.kind === 'bytes' && from !== null && s0!.mode === ours.mode && from.equals(ours.bytes)) continue;
    if (teammateLine(core, self, p, from, to, own)) {
      skipped.set(p, 'TEAMMATE_LINE');
      continue;
    }
    results.set(p, to === null ? ABSENT : to);
    counts.set(p, rowCounts(from, to));
  }

  // Rename pairs: when either side is skipped for any reason, the other is skipped as RENAME_PAIR (never both files, never neither).
  for (let again = true; again;) {
    again = false;
    for (const [a, b] of renames) {
      for (const [x, y] of [[a, b], [b, a]] as const) {
        if (skipped.has(x) && !skipped.has(y)) {
          skipped.set(y, 'RENAME_PAIR');
          results.delete(y);
          again = true;
        }
      }
    }
  }
  const paths = [...results.keys()].sort().map((p) => ({ path: p, ...counts.get(p)!, disk: (initial.get(p)?.oid ?? ABSENT) as Oid | 'ABSENT' }));
  const kept = [...results.keys()].sort().flatMap((p) => (keptOf.get(p) ?? []).map((k) => ({ path: p, ...k })));
  return {
    results: new Map([...results].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))),
    paths, kept,
    skipped: [...skipped].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([path, key]) => ({ path, key })),
  };
}

/** Rows removed and added from the S_disk side to the result (0/0 for binary bytes). */
function rowCounts(from: Buffer | null, to: Buffer | null): { del: number; add: number } {
  if ((from !== null && isBinaryBytes(from)) || (to !== null && isBinaryBytes(to))) return { del: 0, add: 0 };
  if (from === null) return { del: 0, add: to === null ? 0 : rows(to).length };
  if (to === null) return { del: rows(from).length, add: 0 };
  const u = unmatchedRows(from, to);
  return { del: u.removed.length, add: u.added.length };
}

/**
 * Step 5 (FEAT-F10-06): Algorithm D2's step 3 predicate on diff(S_disk[p], ours), restricted to lines outside the CS's own journaled sets
 * (the union over C(t) of paths[p].add for removed lines and .del for re-added ones): a non-trivial line journaled `add` (removed here) or
 * `del` (re-added here) by a writer ≠ this peer within the window. Binary bytes compare as whole-blob hashes (the journal's summary
 * form). In memory: no process.
 */
function teammateLine(core: RevertHost, self: string, p: string, from: Buffer | null, to: Buffer | null, own: readonly ProvEntry[]): boolean {
  const ownAdd = new Set(own.flatMap((e) => e.paths[p]?.add ?? []));
  const ownDel = new Set(own.flatMap((e) => e.paths[p]?.del ?? []));
  const other = (writers: readonly string[]): boolean => writers.some((w) => w !== self);
  let removed: string[];
  let added: string[];
  if ((from !== null && isBinaryBytes(from)) || (to !== null && isBinaryBytes(to))) {
    removed = from === null ? [] : [blobHash(from)];
    added = to === null ? [] : [blobHash(to)];
  } else {
    const u = from === null ? { removed: [], added: to === null ? [] : rows(to) } : to === null ? { removed: rows(from), added: [] } : unmatchedRows(from, to);
    const hashes = (rs: readonly Buffer[]): string[] => rs.map((r) => stripEnding(r)).filter(isNonTrivial).map((l) => lineHash(l));
    removed = hashes(u.removed);
    added = hashes(u.added);
  }
  return removed.some((h) => !ownAdd.has(h) && other(core.prov.addedBy(h))) || added.some((h) => !ownDel.has(h) && other(core.prov.deletedBy(h)));
}

// ---- view mode -----------------------------------------------------------------------------------------------------------------

const VIEW_SKIPS: ReadonlySet<string> = new Set(['MIXED', 'FILE_CHANGED_LATER', 'RENAME_PAIR', 'NOT_LIVE', 'TEAMMATE_LINE', 'CHANGED_NOW']);
type ViewSkip = NonNullable<RevertView['paths'][number]['skip']>;

/** A unified diff with `ctx` rows of context (in-process over matchedRows; no `git diff`), hunk headers and ' '/'-'/'+' rows, LF-ended. */
function unifiedDiff(a: readonly Buffer[], b: readonly Buffer[], ctx = 3): string {
  const ops: Array<{ t: ' ' | '-' | '+'; row: Buffer; ai: number; bi: number }> = [];
  let i = 0;
  let j = 0;
  for (const [mi, mj] of [...matchedRows(a, b), [a.length, b.length] as [number, number]]) {
    while (i < mi) ops.push({ t: '-', row: a[i]!, ai: i++, bi: j });
    while (j < mj) ops.push({ t: '+', row: b[j]!, ai: i, bi: j++ });
    if (mi < a.length && mj < b.length) ops.push({ t: ' ', row: a[i]!, ai: i++, bi: j++ });
  }
  const changed = ops.flatMap((op, k) => (op.t === ' ' ? [] : [k]));
  const out: string[] = [];
  for (let k = 0; k < changed.length;) {
    let last = changed[k]!;
    let n = k + 1;
    while (n < changed.length && changed[n]! - last <= 2 * ctx) last = changed[n++]!;
    const from = Math.max(0, changed[k]! - ctx);
    const to = Math.min(ops.length, last + ctx + 1);
    const slice = ops.slice(from, to);
    const aLen = slice.filter((x) => x.t !== '+').length;
    const bLen = slice.filter((x) => x.t !== '-').length;
    const aStart = aLen === 0 ? slice[0]!.ai : slice[0]!.ai + 1;
    const bStart = bLen === 0 ? slice[0]!.bi : slice[0]!.bi + 1;
    out.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@\n`);
    for (const x of slice) out.push(`${x.t}${stripEnding(x.row).toString('utf8')}\n`);
    k = n;
  }
  return out.join('');
}

/**
 * View mode (FEAT-F10-10, CCI-68; §8 Q17 (a)): Plan 5's RevertView. A teammate's CS → `notown` with the summary only; an ambiguous id →
 * its candidates; an unknown id → `unknown`; any other refusal → `summary_only`. Otherwise Algorithm REV in view mode: -U3 diffs of the
 * stored forms for in-file text changes only, `human` for a created, deleted, binary, mode-changed or filtered path, the kept regions and
 * skipped paths one row each, CHANGED_NOW for a path changed since the last materialization. Writes no object, no file, no last_check.
 */
export async function revertView(core: RevertHost, csId: string): Promise<RevertView> {
  const none = { paths: [] as RevertView['paths'], kept: [] as RevertView['kept'] };
  const loc = await locateCs(core, csId, { mode: 'view' });
  if (loc === null) return { kind: 'unknown', summary: { cs: csId }, ...none };
  if ('ambiguous' in loc) return { kind: 'ambiguous', summary: { cs: csId }, ...none, candidates: loc.ambiguous };
  if ('notOwn' in loc) return { kind: 'notown', summary: { cs: csId, writer: loc.notOwn.name }, ...none };
  if (!('found' in loc)) {
    const reason = 'tooOld' in loc ? 'too_old' : 'open' in loc ? 'open' : 'noLast' in loc ? 'no_last' : 'not_shared';
    return { kind: 'summary_only', summary: { cs: csId, reason, ...('notShared' in loc ? { hid: loc.notShared.hid } : {}) }, ...none };
  }
  const f = loc.found;
  const r = await revertInverse(core, f, { mode: 'view' });
  if ('tooBig' in r) return { kind: 'summary_only', summary: { cs: f.label, reason: 'too_big' }, ...none };
  const sDisk = await core.revertSDisk();
  const info = await core.revertPaths([...r.results.keys()]);
  const restored = await oldestBefore(core, f);
  const paths: Array<RevertView['paths'][number]> = [];
  for (const [p, res] of r.results) {
    const s0 = sDisk.get(p) ?? null;
    const from = s0 === null ? null : await core.repo.readBlob(s0.oid);
    const to = res === ABSENT ? null : res;
    const mode = restored.get(p)?.mode;
    let human: string | null = null;
    if (to === null) human = 'created';                     // the CS created p: the undo deletes it
    else if (from === null) human = 'deleted';              // the CS deleted p: the undo restores it
    else if (isBinaryBytes(from) || isBinaryBytes(to)) human = 'binary';
    else if (info(p).filtered) human = 'filtered';
    else if (mode !== undefined && mode !== s0!.mode) human = 'mode';
    paths.push(human !== null ? { path: p, human } : { path: p, diff: unifiedDiff(rows(from!), rows(to!)) });
  }
  for (const s of r.skipped) if (VIEW_SKIPS.has(s.key)) paths.push({ path: s.path, skip: s.key as ViewSkip });
  paths.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return {
    kind: 'view',
    summary: { cs: f.label, commits: f.commits.length, paths: r.results.size, kept: r.kept.length, skipped: r.skipped.length },
    paths, kept: r.kept.map((k) => ({ path: k.path, line: k.a })),
  };
}

/** Per path of the CS, its side before the CS's oldest commit that changed it (null = absent): the side a whole-path undo restores. */
async function oldestBefore(core: RevertHost, f: CsLocation): Promise<Map<string, TreeEntry | null>> {
  const out = new Map<string, TreeEntry | null>();
  for (const c of f.commits) {
    const parent = (await core.repo.readCommit(c)).parents[0];
    if (parent === undefined) continue;
    for (const [p, ch] of (await commitChanges(core.repo, parent, c)).paths) if (!out.has(p)) out.set(p, ch.before);
  }
  return out;
}
