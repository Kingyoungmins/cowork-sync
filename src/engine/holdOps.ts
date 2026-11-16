// The hold operators that write the disk or run after the writes (05-holds §3.4 items 3–4, §3.6 R1, HLD-08, HLD-16, HLD-17;
// 03-data §3.9 Restore, DAT-29, DAT-45; rulings R3-15…R3-18, R3-22, R3-23, R3-36, R3-60, R3-67):
//
//   evaluateRecords    R1 on ON_DISK records and the OFF_DISK A-change check after an apply step, MASK conflicts → CONFLICTED,
//                      one commitMany; HOLD_CONFLICTED / HOLD_SUBSUMED / HOLD_GONE to status and the daemon log
//   park               HLD-16: the target per path (r's step-5 MASK alone for an ACTIVE PATCH, else A[p]); a PIN, CONFLICTED or
//                      whole-path record first refreshes its held side := S_disk[p] (REFRESHED when that rev must become durable
//                      first); inflight[r] committed (with the refresh) before writeLocalGroup, all or none; after WRITTEN the
//                      writes are recorded as attributed, the private-index entries set and one snap-only state transition
//                      committed (R3-36, R3-60), every publication group with an unpublished ready pair over r's paths withdrawn
//                      (final review F6, withdrawWritten), then the final patch with the inflight cleared; a record carrying
//                      `markers` is the markers park
//   markersPark        R3-15: the marker companion (h0 = A[p], h1 = M[p] by route (b) -w of a staged copy, OFF_DISK PARKED, no
//                      guard, local_only) and the park's in-flight entry in one commit, writeLocalGroup(M → A), then `markers`
//                      released on r and r OFF_DISK in one commit; any other writer result ends the companion GONE
//   restore            HLD-17 / DAT-45: merge-file --diff3 with the cowork: labels over D = the disk's clean blob now, canon of a
//                      clean result (R3-16), the binary rule (R3-18), §3.9 cases 2–3; inflight[r] before the write; ON_DISK
//                      with the displacement guard released (`markers` added for a marker row), explicit
//   collisionTake      DAT-29: the local file captured first (guard-less OFF_DISK PARKED PATCH, h0 ABSENT), then the team version
//                      written; any other writer result ends the capture GONE (R3-67)
//   settleHoldOps      restart's settlement by observation (DISK_EQ): interrupted markers parks first (settleMarkersParks: only
//                      those whose in-flight entry is still set), then
//                      every inflight operator, the take captures whose write did not happen, and K4 records whose TIP write
//                      completed
//
// Every operator runs only in an iteration whose S_disk covers its paths (PrepareOptions.holdPaths; a TypeError otherwise, a
// caller bug), never over a kept push intent or a stranded restore (POSTPONED, R3-23), and under FREEZE only with human evidence;
// every disk write goes through Writer.writeLocal/writeLocalGroup with the operator's origin (park:, markers_park:, restore:,
// take:; ENG-37) and is recorded in core.observed after WRITTEN (R3-36). No git process names a working file: content is read
// only by the staged read into tmp/stage (glossary §26.1 W1). Codes reach status through core.holdCode (the newest wins) and
// the daemon log (R-27); a log line carries scalars only, so an array parameter is written to the log as its comma-joined text
// and kept as an array in core.holdCode.
import { join } from 'node:path';
import type { Json } from '../board/canonicalJson.js';
import { hashRouteB, hashRouteC, isFilterFailure } from '../data/blobRoutes.js';
import { canon } from '../data/canon.js';
import { hasBom, hasRestoreMarkerRow, isBinaryBytes, rows } from '../data/rows.js';
import { mergeFile } from '../git/merge.js';
import { ABSENT, type Oid, type OidOrAbsent } from '../git/oid.js';
import { isRegularEntry, type FileMode, type IndexEdit, type TreeEntry, type TreeMap } from '../git/repo.js';
import { blobMapOf, evaluateOffDisk, evaluateOnDisk, reverseAlone, type R1Verdict } from '../holds/evaluate.js';
import { HoldOperatorError } from '../holds/rebase.js';
import {
  blobAt, guardName, hasWholePathGuard, heldSide, isK4Displacement, isTerminal, isUnknownGuard, makeGuard, setBlob, type BlobMap, type Guard, type HoldBlobs,
  type HoldRecord,
} from '../holds/record.js';
import type { HoldPatch, InflightOp, RestoredWrite } from '../holds/registry.js';
import { KilledAt } from '../ports/crashpoint.js';
import type { LogLevel, LogParam } from '../ports/log.js';
import { k4Displacement, k4OffDiskPatch } from './apply.js';
import { currentA, ensureAttrs, materializedFor, pathIsFiltered, pathIsText, type EngineCore, type IterationCtx } from './core.js';
import type { Materialized } from './snapshot.js';
import { stagedRead } from './stagedRead.js';
import { csTableKeep, opSnapKeep, readCsTable, readOpSnap, StateCasLostError } from './state.js';
import { editTreeIndexOnly } from './treeEdit.js';
import type { WriteLocalResult } from './writer.js';

export type ParkOutcome = { kind: 'PARKED'; companion: string | null } | { kind: 'REFRESHED'; rev: number } | { kind: 'LOCKED' } | { kind: 'MISMATCH' }
  | { kind: 'FROZEN' } | { kind: 'POSTPONED'; why: 'push_intent' | 'stranded' | 'deferred' } | { kind: 'NOT_PARKABLE' };
export type RestoreOutcome = { kind: 'RESTORED'; markers: boolean } | { kind: 'REFUSED'; code: 'HOLD_RESTORE_CONFLICT' | 'HOLD_DISK_CHANGED' | 'HOLD_FROZEN' | 'RESTORE_BINARY_HUMAN_ONLY' }
  | { kind: 'LOCKED' } | { kind: 'POSTPONED'; why: 'tip_write_pending' | 'push_intent' | 'stranded' };

/** One path of an operator write: the pre-image the writer checks (DISK_EQ) and the blob it writes (ABSENT: a deletion). */
export type Entry = InflightOp['entries'][number];

/** The guards whose displacement a RESTORE undoes (HLD-17; the PARKED state is the other displacement). */
const DISPLACEMENT: ReadonlySet<string> = new Set(['conflict', 'claim-breach', 'base-move']);
/** 05 §3.4 item 4's labels (ruling R3-16). */
const RESTORE_LABELS = ['cowork:disk', 'cowork:base', 'cowork:held'] as const;
/** A marker row of a restore result: the three cowork:-labelled rows and the separator between them (DAT-45's `rows[]`). */
const MARKER_ROW = /^(?:(?:<{7}|\|{7}|>{7}) cowork:|={7}$)/;

// ---- shared helpers (also dataRecords.ts's: Global Constraints "Shared helpers, never copied") -----------------------

/** A hold code to status (core.holdCode, the newest wins) and the daemon log (R-27). */
export function raise(core: EngineCore, code: string, params: Record<string, Json>, level: LogLevel = 'info'): void {
  core.holdCode = { code, params };
  const flat: Record<string, LogParam> = {};
  for (const [k, v] of Object.entries(params)) flat[k] = Array.isArray(v) ? v.map(String).join(',') : (v as LogParam);
  core.deps.log.write(level, code, flat);
}

const oidAt = (m: TreeMap, p: string): OidOrAbsent => m.get(p)?.oid ?? ABSENT;
/** Whether r carries a guard named `name` (any argument). */
export const carries = (r: HoldRecord, name: string): boolean => r.guards.some((g) => guardName(g) === name);

/** The non-terminal record `id`; a TypeError otherwise (a caller bug). */
function existing(core: EngineCore, id: string, what: string): HoldRecord {
  const r = core.holds.get(id);
  if (r === undefined || isTerminal(r)) throw new TypeError(`${what}: ${JSON.stringify(id)} is not a non-terminal hold record`);
  return r;
}

/** The iteration's materialization, which must cover `paths` (PrepareOptions.holdPaths); a TypeError otherwise (a caller bug). */
function requireMat(it: IterationCtx, paths: readonly string[], what: string): Materialized {
  if (!materializedFor(it, paths)) throw new TypeError(`${what}: the iteration has not materialized ${JSON.stringify(paths)} (prepareIteration with holdPaths)`);
  return it.mat as Materialized;
}

/** Any FREEZE reason, as the iteration saw it or as the state holds it now. */
export function frozen(core: EngineCore, it: IterationCtx): boolean {
  return it.freeze.length > 0 || (core.view?.meta.freeze_reasons.length ?? 0) > 0;
}

/** R3-23: no local write over a kept push intent or while a restore is stranded. */
export function postponedBy(core: EngineCore): 'push_intent' | 'stranded' | null {
  if (core.view?.intent.kind === 'push') return 'push_intent';
  if (core.writer.strandedPaths().length > 0) return 'stranded';
  return null;
}

/** HLD-16 / Table 4: an ON_DISK PATCH or PIN, not local_only, with paths and no guard outside Table 3 (which this daemon never transitions). */
function parkable(r: HoldRecord): boolean {
  return r.residence === 'ON_DISK' && (r.kind === 'PATCH' || r.kind === 'PIN') && !r.local_only && r.paths.length > 0 && !r.guards.some(isUnknownGuard);
}

/** Text and unfiltered at EPOCH_BASE (no merge-file runs on any other path, R3-18). */
function mergeable(core: EngineCore, p: string): boolean {
  return pathIsText(core, p) && !pathIsFiltered(core, p);
}

/** DAT-04 on the bytes of every non-ABSENT side (object reads only). */
async function anyBinary(core: EngineCore, sides: readonly OidOrAbsent[]): Promise<boolean> {
  const oids = [...new Set(sides.filter((s): s is Oid => s !== ABSENT))];
  return (await core.repo.readBlobs(oids)).some((b) => isBinaryBytes(b));
}

/** The first regular mode p has in `maps`, else 100644. */
export function modeOf(p: string, ...maps: ReadonlyArray<TreeMap | null>): FileMode {
  for (const m of maps) {
    const e = m?.get(p);
    if (e !== undefined && (e.mode === '100644' || e.mode === '100755')) return e.mode;
  }
  return '100644';
}

/** writeLocalGroup over the entries that change something (none: WRITTEN with no write). Shared with resolve.ts's --discard. */
export function writeEntries(core: EngineCore, entries: readonly Entry[], origin: string, humanEvidence: boolean): Promise<WriteLocalResult> {
  const todo = entries.filter((e) => e.expected !== e.target);
  if (todo.length === 0) return Promise.resolve({ kind: 'WRITTEN' });
  return core.writer.writeLocalGroup(todo.map((e) => ({ path: e.path, expected: e.expected, target: e.target === ABSENT ? 'DELETE' : e.target })), origin, humanEvidence);
}

/** R3-36: every written path is an attributed write (HLD-26 (b)). Shared with resolve.ts's --discard. */
export function recordWrites(core: EngineCore, entries: readonly Entry[]): void {
  for (const e of entries) if (e.expected !== e.target) core.observed.record(e.path, e.target);
}

/**
 * R3-18 / DAT-04 for RESTORE (and HLD-59's text-path test, resolve.ts): the paths of r that take the whole-path rule — not mergeable
 * (binary or filtered at EPOCH_BASE), or binary bytes on any side merge-file would read: b (h0/s1), held (h1/s2), A[p] and the disk's
 * clean blob D (`sRaw`, the iteration's staged-copy materialization; null: not read). Object reads only, no disk read.
 */
export async function wholeRestorePaths(core: EngineCore, it: IterationCtx, r: HoldRecord, sRaw: TreeMap | null): Promise<Set<string>> {
  const base = 'h0' in r.blobs ? r.blobs.h0 : r.blobs.s1;
  const held = heldSide(r);
  const out = new Set<string>();
  for (const p of r.paths) {
    const sides = [blobAt(base, p) ?? ABSENT, blobAt(held, p) ?? ABSENT, oidAt(it.A, p), sRaw === null ? ABSENT : oidAt(sRaw, p)];
    if (!mergeable(core, p) || (await anyBinary(core, sides))) out.add(p);
  }
  return out;
}

/** HLD-16 / §3.4 item 3: a record PARK withholds whole by its kind, state or guards (PIN, CONFLICTED, local_only, a whole-path guard). */
function wholeByRecord(r: HoldRecord): boolean {
  return r.kind === 'PIN' || r.state === 'CONFLICTED' || r.local_only || hasWholePathGuard(r);
}

/**
 * R3-18: a path of r that is not mergeable (binary or filtered at EPOCH_BASE), or binary bytes on a side the step-5 merge would read —
 * S_disk (`sDisk`), A, r's base and its held side. Object reads only.
 */
async function wholeByBytes(core: EngineCore, r: HoldRecord, sDisk: (p: string) => OidOrAbsent, A: TreeMap): Promise<boolean> {
  const sides: OidOrAbsent[] = [];
  for (const p of r.paths) sides.push(sDisk(p), oidAt(A, p), blobAt('h0' in r.blobs ? r.blobs.h0 : r.blobs.s1, p) ?? ABSENT, blobAt(heldSide(r), p) ?? ABSENT);
  return !r.paths.every((p) => mergeable(core, p)) || (await anyBinary(core, sides));
}

/**
 * HLD-16's write target per path, shared by PARK and Table 4's ON_DISK `--discard` (MASK step 4 or 5 for r alone): `x` = r's step-5
 * MASK alone, mf(S_disk[p], H1'[p], H0'[p]) over r's REBASE on A, for an ACTIVE PATCH that is not whole-path (no PIN, CONFLICTED,
 * local_only or whole-path-guard record) and mergeable on every side (R3-18); otherwise `x` null and the target is A[p] (`whole`). An
 * ACTIVE PATCH whose REBASE or step-5 merge for r alone conflicts is a MASK conflict (HLD-15): whole, `conflicts` true.
 */
export async function maskAloneTarget(core: EngineCore, it: IterationCtx, r: HoldRecord, sDisk: TreeMap): Promise<{ x: BlobMap | null; whole: boolean; conflicts: boolean }> {
  if (wholeByRecord(r)) return { x: null, whole: true, conflicts: false };
  const A = it.A;
  if (await wholeByBytes(core, r, (p) => oidAt(sDisk, p), A)) return { x: null, whole: true, conflicts: false };   // R3-18: withheld whole
  const rb = await core.rebase.rebase(r, A);
  const x = rb.ok ? await reverseAlone(r, rb.h0p, rb.h1p, sDisk, core.rebase) : null;
  return x === null ? { x: null, whole: true, conflicts: true } : { x, whole: false, conflicts: false };
}

/**
 * R3-36 / R3-60 for the park family (and --discard): the private-index entry of every path := the written blob
 * (Snapshotter.setEntry), then ONE snap-only state transition snap := editTreeIndexOnly(snap, p → written) — none when state:snap
 * already holds every entry (settleHoldOps replays this step) — so the writes are no unobserved delta in this run or after a
 * restart, whose reseed reads state:snap.
 *
 * EF2 fix round 1, F3: the same transition journals the written entries in journal/keep/op_snap (OP_SNAP_KEEP; the entries an earlier
 * operator journaled stay while state:snap still holds them), so the restart's re-form, which hands a ready pair's path over when its
 * snap entry is neither the pair's R entry nor an operator's write, never re-captures an operator's write as a human change.
 *
 * Final review F1: once the private-index entry holds the written blob, the write can never be a materialized delta, so its
 * ObservedWrites entry (recordWrites, R3-36) is forgotten here — a lingering one would make a later stale save of the same blob pass as
 * observed (HLD-26) after an apply moved A, and the revert detector would miss a teammate-line removal (HLD-27, HLD-28).
 */
export async function parkWritten(core: EngineCore, entries: readonly Entry[], mode: (p: string) => FileMode): Promise<void> {
  const view = core.view;
  if (view === null) throw new Error('park: no state');
  for (const e of entries) {
    await core.snapshot.setEntry(e.path, e.target === ABSENT ? null : { path: e.path, mode: mode(e.path), oid: e.target });
    core.observed.forget(e.path);
  }
  const snap = await core.repo.readTreeMap(view.snap);
  const edits: IndexEdit[] = [];
  for (const e of entries) {
    const cur = snap.get(e.path);
    if (e.target === ABSENT) {
      if (cur !== undefined) edits.push({ path: e.path, remove: true });
    } else if (cur === undefined || cur.oid !== e.target) {
      edits.push({ path: e.path, mode: cur?.mode ?? mode(e.path), oid: e.target });
    }
  }
  // EF2 r1 F3: the op_snap entries — the earlier ones snap still holds, and this operator's writes. A capture's state commit does not
  // move snap, so snap can already hold the target (an operator writing A[p] under a ready pair captured since the last apply): the
  // transition then carries op_snap alone. None when snap and op_snap already hold every entry (settleHoldOps' replay).
  const journaled = await readOpSnap(core.repo, view);
  const ops = new Map([...journaled].filter(([p, o]) => (snap.get(p)?.oid ?? ABSENT) === o));
  for (const e of entries) ops.set(e.path, e.target);
  const opsSame = ops.size === journaled.size && [...ops].every(([p, o]) => journaled.get(p) === o);
  if (edits.length === 0 && opsSame) return;
  const tree = edits.length === 0 ? view.snap : await editTreeIndexOnly(core.repo, core.deps.ports.fs, view.snap, edits, core.scratch('a'));
  if (tree === view.snap && opsSame) return;
  await core.commit({ ...(tree !== view.snap ? { snap: tree } : {}), keep: new Map([...view.keep, await opSnapKeep(core.repo, ops)]) });
}

/** A writer result other than WRITTEN as a park outcome: a holder (LOCKED, or a pre-image read it refused) → LOCKED. */
function parkFailure(core: EngineCore, res: WriteLocalResult): ParkOutcome {
  switch (res.kind) {
    case 'LOCKED':
      return { kind: 'LOCKED' };
    case 'FROZEN':
      return { kind: 'FROZEN' };
    case 'DEFERRED':
      if (res.reason === 'unreadable' || res.reason === 'locked') return { kind: 'LOCKED' };
      return { kind: 'POSTPONED', why: core.writer.strandedPaths().length > 0 ? 'stranded' : 'deferred' };
    default:
      return { kind: 'MISMATCH' };   // MISMATCH, COLLISION, PHANTOM: the disk is not what the park read
  }
}

/** The snapshot's stage copy of p (an Fs read of tmp/stage/<p>, no git); null when there is none. */
export async function readStageCopy(core: EngineCore, p: string): Promise<Buffer | null> {
  try {
    return await core.deps.ports.fs.readFile(core.stage.abs(p));
  } catch (e) {
    const code = typeof e === 'object' && e !== null ? (e as NodeJS.ErrnoException).code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw e;
  }
}

/**
 * The clean blob of p's disk content now: a staged read into tmp/stage and route (b) -w of that copy (HLD-03; `route` is
 * hashRouteB, or dataRecords.ts's DAT-07 new-path form hashNewPath); the snapshot's own copy of p is put back.
 */
export async function captureDisk(core: EngineCore, p: string, route: typeof hashRouteB = hashRouteB): Promise<{ kind: 'ok'; oid: Oid } | { kind: 'missing' | 'unreadable' | 'unstable' | 'filter_failure' }> {
  const fs = core.deps.ports.fs;
  const read = await stagedRead(fs, join(core.deps.paths.workTree, ...p.split('/')));
  if (read.kind !== 'ok') return { kind: read.kind };
  const saved = core.statCache.get(p)?.state === 'dirty' ? await readStageCopy(core, p) : null;
  const copy = await core.stage.write(p, read.bytes);
  try {
    const h = await route(core.repo, p, copy, true);
    return isFilterFailure(h) ? { kind: 'filter_failure' } : { kind: 'ok', oid: h };
  } finally {
    if (saved !== null) await core.stage.write(p, saved);
    else await core.stage.remove(p);
  }
}

/** DISK_EQ(p, x) for every entry (x ABSENT: p absent). */
async function diskEqAll(core: EngineCore, items: ReadonlyArray<{ path: string; x: OidOrAbsent }>, mode: (p: string) => FileMode): Promise<boolean> {
  for (const { path, x } of items) {
    const r = await core.diskEq.eq(path, x === ABSENT ? ABSENT : { path, mode: mode(path), oid: x }, null);
    if (!r.equal) return false;
  }
  return true;
}

// ---- record evaluation (HLD-08) ---------------------------------------------------------------------------------------

/**
 * HLD-08 after every apply step: R1 on every non-terminal ON_DISK record (a record MASK reported conflicted in `maskConflicted`
 * becomes CONFLICTED without R1), and the OFF_DISK check on records with a path in `changedA` (no git command for any other
 * OFF_DISK record); INCOMING records (HLD-54), records carrying a guard outside Table 3 (HLD-05) and the pathless host-reject
 * PIN are not evaluated. Every resulting transition goes into ONE commitMany (a CONFLICTED record R1 finds ACTIVE again — Algorithm R1
 * step 4 — included); HOLD_CONFLICTED {path, author, hid}, HOLD_SUBSUMED {hid, path} (also for RESOLVED_PUBLISH) and HOLD_GONE
 * {hid, path} go to status and the log (a conflict that cleared has no code: HOLD_CODES names none). S_disk is this iteration's
 * materialization, else the snapshot's last one (05 §3.4: R1 reads the last materialized S_disk); with neither, only the
 * OFF_DISK check runs. A record whose REBASE is an operator error is left for the next evaluation. Returns the ids it transitioned.
 *
 * Plan 3 Task EF (Task 12b's materializedFor rule, 05 §3.4): a verdict R1 derives from S_disk — GONE (step 3, a marker companion's
 * aside), and a CONFLICTED PATCH back to ACTIVE by its reverse merge (step 4) — is taken only when S_disk is current for every path of
 * the record (sDiskCurrent); otherwise the record keeps its state until an iteration whose S_disk shows those paths. A record created
 * from disk bytes newer than the last materialization (DAT-39's generated? record from a tick's stage copy) is otherwise ended GONE
 * by the older S_disk in its creating iteration. Steps 1–2 (REBASE onto A) read no S_disk and always run.
 */
export async function evaluateRecords(core: EngineCore, it: IterationCtx, changedA: ReadonlySet<string>, maskConflicted: readonly string[]): Promise<string[]> {
  const sDisk = it.mat?.sDiskMap ?? core.snapshot.last()?.sDiskMap ?? null;
  const explicit = new Set(core.holds.local().explicit);
  const conflicted = new Set(maskConflicted);
  const out: Array<{ r: HoldRecord; verdict: R1Verdict }> = [];
  for (const r of core.holds.nonTerminal()) {
    if (r.kind === 'INCOMING' || r.paths.length === 0 || r.guards.some(isUnknownGuard)) continue;
    let verdict: R1Verdict | null;
    try {
      if (r.residence === 'ON_DISK') {
        if (conflicted.has(r.id)) verdict = 'CONFLICTED';
        else if (sDisk === null) continue;
        else {
          const companion = core.holds.isCompanion(r.id);
          verdict = await evaluateOnDisk(r, it.A, sDisk, core.rebase, explicit.has(r.id), companion);
          const fromSDisk = (verdict === 'GONE' && !companion) || (verdict === 'ACTIVE' && r.kind === 'PATCH' && r.state === 'CONFLICTED');
          if (fromSDisk && !r.paths.every((p) => sDiskCurrent(it, p))) continue;   // S_disk is not the disk for a path: no verdict yet
        }
      } else {
        if (!r.paths.some((p) => changedA.has(p))) continue;
        verdict = await evaluateOffDisk(r, it.A, core.rebase, explicit.has(r.id));
      }
    } catch (e) {
      if (e instanceof HoldOperatorError) continue;   // an operator error is never a verdict (05 F1): the next evaluation retries
      throw e;
    }
    if (verdict === null || verdict === 'HELD_BY_MARKERS' || verdict === r.state) continue;   // no change (ACTIVE stays, CONFLICTED stays)
    out.push({ r, verdict });
  }
  if (out.length === 0) return [];
  await core.holds.commitMany([], out.map(({ r, verdict }) => ({ id: r.id, patch: { state: verdict } as HoldPatch })));
  for (const { r, verdict } of out) {
    const path = r.paths[0] ?? '';
    if (verdict === 'CONFLICTED') {
      raise(core, 'HOLD_CONFLICTED', { path, author: r.peer_authors[0] ?? null, hid: r.id }, 'warn');
      toldConflicted(core).add(r.id);
    } else if (verdict === 'GONE') raise(core, 'HOLD_GONE', { hid: r.id, path });
    else if (verdict !== 'ACTIVE') raise(core, 'HOLD_SUBSUMED', { hid: r.id, path });   // a conflict that cleared (CONFLICTED → ACTIVE) has no code
  }
  return out.map(({ r }) => r.id);
}

/**
 * Plan 3 Task EF: the S_disk R1 reads is current for p — this iteration materialized p and its tick did not exclude it
 * (materializedFor), or nothing materialized and the tick found p neither dirty nor excluded (the dirty set is cumulative since the
 * last materialization, so a clean path's last materialized entry is the disk's). A path the tick changed since the last
 * materialization, or excluded, has no current S_disk entry.
 */
function sDiskCurrent(it: IterationCtx, p: string): boolean {
  if (materializedFor(it, [p])) return true;
  const tick = it.tick;
  return it.mat === null && tick !== null && !tick.dirty.has(p) && !tick.excluded.has(p);
}

/**
 * Task 12b fix round 1 (minor d): per core, the records evaluateRecords told HOLD_CONFLICTED since the last escalationStep. A record
 * created ACTIVE and made CONFLICTED by step 5R in its creation's iteration is then not told a second time by escalationStep's HLD-60
 * line for a record first seen CONFLICTED (timers T run after 5R); escalationStep empties the set at each call (takeConflictedTold).
 */
const conflictedTold = new WeakMap<EngineCore, Set<string>>();

function toldConflicted(core: EngineCore): Set<string> {
  let s = conflictedTold.get(core);
  if (s === undefined) {
    s = new Set();
    conflictedTold.set(core, s);
  }
  return s;
}

/** The ids evaluateRecords told HOLD_CONFLICTED since the previous call, and the set emptied (escalationStep's one reader). */
export function takeConflictedTold(core: EngineCore): ReadonlySet<string> {
  const s = conflictedTold.get(core) ?? new Set<string>();
  conflictedTold.delete(core);
  return s;
}

// ---- PARK (HLD-16) ----------------------------------------------------------------------------------------------------

/** The held side (h1, or s2 for a stage record) := S_disk[p] on every path; null when it already is. PARK's and --discard's (R3-EF4-28). */
export function refreshed(r: HoldRecord, sDisk: TreeMap): HoldBlobs | null {
  const held = heldSide(r);
  if (r.paths.every((p) => blobAt(held, p) === oidAt(sDisk, p))) return null;
  const next = blobMapOf(r.paths, sDisk);
  const copy = (m: BlobMap): BlobMap => {
    const out: BlobMap = {};
    for (const [p, o] of Object.entries(m)) setBlob(out, p, o);
    return out;
  };
  return 'h1' in r.blobs ? { h0: copy(r.blobs.h0), h1: next } : { s1: copy(r.blobs.s1), s2: next, s3: copy(r.blobs.s3) };
}

/**
 * G2 #29 (rulings R3-SPEC-3, R3-SPEC-6, 05 §3.4 item 3, HLD-08): an ON_DISK K4 record that still IS the TAKE_TIP displacement
 * (isK4Displacement) and whose TIP write landed — A[p] = s3[p] on every path. A moves to TIP's blob at p only through the apply's verified
 * write (a publish-side K4's own landing leaves A[p] alone: C[p] = TIP[p] ≠ P[p], ENG-44), and that write moves every such record OFF_DISK
 * except a record carrying `markers` whose written bytes keep a restore-marker row (TIP's own row, R3-FF3-B3), which R3-SPEC-3 keeps ON_DISK
 * with `markers` so the row stays withheld. Such a "kept" record's own change (s2) is not on the disk — the disk holds TIP's bytes and the
 * human's later edits — so it is neither "restored" by its residence nor refreshed from that disk.
 */
export function keptK4(r: HoldRecord, A: TreeMap): boolean {
  if (r.residence !== 'ON_DISK' || !isK4Displacement(r) || !('s3' in r.blobs)) return false;
  const s3 = r.blobs.s3;
  return r.paths.every((p) => blobAt(s3, p) !== undefined && blobAt(s3, p) === oidAt(A, p));
}

/**
 * G2 #29: the OFF_DISK move HLD-08 makes after a verified TIP write, which R3-SPEC-3 deferred for a kept K4 (keptK4) while `markers` held
 * — residence OFF_DISK and R3-22's displaced_by / peer_authors (k4Displacement on LA_C, as settleHoldOps' completion), state CONFLICTED
 * and the guards kept (k4OffDiskPatch drops `markers`; callers move only a record that no longer carries it). One registry commit, no
 * disk write: the disk keeps what it holds (TIP's bytes and the human's edits since), which then publish as the human's own change.
 */
export async function keptK4OffDisk(core: EngineCore, r: HoldRecord): Promise<HoldRecord> {
  const view = core.view;
  if (view === null) throw new Error('keptK4OffDisk: no state');
  return core.holds.transition(r.id, k4OffDiskPatch(r, await k4Displacement(core, view.laC, r.paths[0]!)));
}

/**
 * HLD-16: target per path (r's step-5 MASK alone, else A[p]); the held-side refresh first for PIN/CONFLICTED/whole-path records
 * (REFRESHED when it must become durable first); writeLocalGroup all or none; OFF_DISK, PARKED (CONFLICTED kept), displaced_by;
 * markers → markersPark; local_only/INCOMING → NOT_PARKABLE. After WRITTEN, per path: ObservedWrites.record(p, written) and
 * Snapshotter.setEntry(p, written entry), then one snap-only state transition before the registry's final commit (R3-36, R3-60), and,
 * before that commit too, the withdrawal of every publication group whose unpublished ready pair covers a parked path (final review F6:
 * an OFF_DISK record masks nothing, so such a pair would publish the parked bytes; the group is re-captured from the post-park disk).
 * An ACTIVE PATCH whose step-5 merge for r alone conflicts is a MASK conflict (HLD-15): it parks as a CONFLICTED record (its held
 * side refreshed, the target A[p]); an ACTIVE PATCH on a binary or filtered path parks by the whole-path rule (R3-18).
 * G2 #29: a kept K4 (keptK4: its TIP write landed, R3-SPEC-3 kept it ON_DISK while `markers` held, and the human has removed the row
 * since) holds none of its bytes on the disk: PARK writes nothing and never refreshes s2 from that disk (the whole refresh would replace
 * the record's own change with TIP's bytes and write A[p] over the human's later edits) — it takes HLD-08's deferred OFF_DISK move
 * (keptK4OffDisk, CONFLICTED kept) and answers PARKED.
 */
export async function park(core: EngineCore, it: IterationCtx, id: string, o: { humanEvidence: boolean; displacedBy: string | null; refreshMustBeDurable: boolean }): Promise<ParkOutcome> {
  const r = existing(core, id, 'park');
  if (!parkable(r)) return { kind: 'NOT_PARKABLE' };
  if (carries(r, 'markers')) return markersPark(core, it, id, { humanEvidence: o.humanEvidence, displacedBy: o.displacedBy });
  const mat = requireMat(it, r.paths, 'park');
  const why = postponedBy(core);
  if (why !== null) return { kind: 'POSTPONED', why };
  if (frozen(core, it) && !o.humanEvidence) return { kind: 'FROZEN' };
  if (keptK4(r, it.A)) {
    await keptK4OffDisk(core, r);
    raise(core, 'HOLD_PARKED', { path: r.paths[0]!, hid: id });
    return { kind: 'PARKED', companion: null };
  }
  const sDisk = mat.sDiskMap;
  const A = it.A;
  // HLD-15: a MASK conflict makes the record CONFLICTED and withholds the whole path; R3-18: a binary or filtered PATCH is withheld whole.
  const { x, whole, conflicts: becomesConflicted } = await maskAloneTarget(core, it, r, sDisk);
  const refresh: HoldPatch = {};
  if (whole) {
    const blobs = refreshed(r, sDisk);
    if (blobs !== null) refresh.blobs = blobs;
  }
  if (becomesConflicted) refresh.state = 'CONFLICTED';
  const entries: Entry[] = r.paths.map((p) => ({ path: p, expected: oidAt(sDisk, p), target: x === null ? oidAt(A, p) : (blobAt(x, p) ?? ABSENT) }));
  // Task 12b (carry 4): an entry whose target is its pre-image writes nothing, so the writer's DISK_EQ never checks it. The disk must
  // still hold that blob, else the S_disk read was stale and nothing is refreshed, written or parked (MISMATCH, a later loop retries):
  // never a PARKED record whose held bytes stay on the disk unmasked.
  const unwritten = entries.filter((e) => e.expected === e.target).map((e) => ({ path: e.path, x: e.target }));
  if (unwritten.length > 0 && !(await diskEqAll(core, unwritten, (p) => modeOf(p, mat.sRawMap, A)))) return { kind: 'MISMATCH' };
  if (o.refreshMustBeDurable && refresh.blobs !== undefined) {
    const { records } = await core.holds.commitMany([], [{ id, patch: refresh }]);
    return { kind: 'REFRESHED', rev: records[0]!.rev };
  }
  const final: HoldPatch = { residence: 'OFF_DISK', state: r.state === 'CONFLICTED' || becomesConflicted ? 'CONFLICTED' : 'PARKED', displaced_by: o.displacedBy };
  // Final review r3 A3-3: the in-flight entry carries this park's whole decision, made on the pre-park held side, for the restart.
  const op: InflightOp = { op: 'park', entries, final, explicit: false, whole };
  await core.holds.commitMany([], Object.keys(refresh).length > 0 ? [{ id, patch: refresh }] : [], { setInflight: { [id]: op } });
  const res = await writeEntries(core, entries, `park:${id}`, o.humanEvidence);
  if (res.kind !== 'WRITTEN') {
    await core.holds.commitMany([], [], { clearInflight: [id] });
    return parkFailure(core, res);
  }
  recordWrites(core, entries);
  await parkWritten(core, entries, (p) => modeOf(p, mat.sRawMap, A));
  await withdrawWritten(core, r.paths);   // final review F6: no ready pair publishes the parked bytes
  await core.holds.commitMany([], [{ id, patch: final }], { clearInflight: [id] });
  raise(core, 'HOLD_PARKED', { path: r.paths[0]!, hid: id });
  return { kind: 'PARKED', companion: null };
}

// ---- the markers park (05 §3.4 item 3, R3-15) ---------------------------------------------------------------------------

/** Commit 2 of the markers park: `markers` released, OFF_DISK, PARKED (CONFLICTED kept), displaced_by. */
function markersReleased(r: HoldRecord, displacedBy: string | null): HoldPatch {
  return { guards: r.guards.filter((g) => guardName(g) !== 'markers'), residence: 'OFF_DISK', state: r.state === 'CONFLICTED' ? 'CONFLICTED' : 'PARKED', displaced_by: displacedBy };
}

/**
 * 05 §3.4 item 3 in R3-15's order: (1) one registry commit creates the marker companion r′ (PATCH over r's paths, h0 = A[p],
 * h1 = M[p] = route (b) -w of a staged copy of the disk file, byte-exact, OFF_DISK PARKED, no guard, origin r.origin, local_only,
 * companionOf r) and, in the same commit, the in-flight entry inflight[r] (op 'park', entries M → A, final = commit 3's patch) that
 * marks this markers park as interrupted until commit 3 or the GONE commit clears it (settleMarkersParks settles only parks that
 * carry it, so a completed park is never mistaken for an interrupted one); (2) writeLocalGroup(M → A), all or none, origin
 * markers_park:<id>; (3) on WRITTEN the writes are recorded, the private-index entries and state:snap set (R3-60), and one commit
 * releases `markers` on r and moves it OFF_DISK (PARKED, or CONFLICTED kept; its blobs unchanged — never refreshed from disk) with
 * the in-flight entry cleared; on any other writer result r′ ends GONE in one commit (the entry cleared) and r is unchanged. A disk
 * that cannot be read now (a holder refusing reads) is LOCKED before any commit.
 */
export async function markersPark(core: EngineCore, it: IterationCtx, id: string, o: { humanEvidence: boolean; displacedBy: string | null }): Promise<ParkOutcome> {
  const r = existing(core, id, 'markersPark');
  if (!parkable(r)) return { kind: 'NOT_PARKABLE' };
  if (!carries(r, 'markers')) throw new TypeError(`markersPark: hold record ${id} carries no markers guard`);
  requireMat(it, r.paths, 'markersPark');
  const why = postponedBy(core);
  if (why !== null) return { kind: 'POSTPONED', why };
  if (frozen(core, it) && !o.humanEvidence) return { kind: 'FROZEN' };
  const M: BlobMap = {};
  for (const p of r.paths) {
    const m = await captureDisk(core, p);
    if (m.kind === 'ok') setBlob(M, p, m.oid);
    else if (m.kind === 'missing') setBlob(M, p, ABSENT);
    else if (m.kind === 'unreadable') return { kind: 'LOCKED' };
    else return m.kind === 'unstable' ? { kind: 'MISMATCH' } : { kind: 'POSTPONED', why: 'deferred' };
  }
  await ensureAttrs(core, it.epochBase, r.paths);
  const entries: Entry[] = r.paths.map((p) => ({ path: p, expected: blobAt(M, p) ?? ABSENT, target: oidAt(it.A, p) }));
  const final = markersReleased(r, o.displacedBy);
  const { created } = await core.holds.commitMany([{
    kind: 'PATCH', residence: 'OFF_DISK', state: 'PARKED', paths: [...r.paths], blobs: { h0: blobMapOf(r.paths, it.A), h1: M },
    guard: null, origin: r.origin, cs_ids: [], displaced_by: null, companionOf: id,
  }], [], { setInflight: { [id]: { op: 'park', entries, final, explicit: false } } });
  const companion = created[0]!;
  const res = await writeEntries(core, entries, `markers_park:${id}`, o.humanEvidence);
  if (res.kind !== 'WRITTEN') {
    await core.holds.commitMany([], [{ id: companion, patch: { state: 'GONE' } }], { clearInflight: [id] });   // its bytes are still on r's disk
    return parkFailure(core, res);
  }
  recordWrites(core, entries);
  await parkWritten(core, entries, (p) => modeOf(p, it.mat?.sRawMap ?? null, it.A));
  await withdrawWritten(core, r.paths);   // final review F6: a pair that captured the marker rows never publishes them
  await core.holds.commitMany([], [{ id, patch: final }], { clearInflight: [id] });
  raise(core, 'HOLD_PARKED', { path: r.paths[0]!, hid: id });
  return { kind: 'PARKED', companion };
}

// ---- RESTORE (HLD-17, DAT-45) -------------------------------------------------------------------------------------------

/** The 1-based rows of a restore result that are marker rows (row 1's BOM and a trailing CR ignored). */
function markerRowsOf(out: Buffer): number[] {
  const found: number[] = [];
  rows(out).forEach((row, i) => {
    let r = i === 0 && hasBom(row) ? row.subarray(3) : row;
    if (r.length > 0 && r[r.length - 1] === 0x0a) r = r.subarray(0, r.length - 1);
    if (r.length > 0 && r[r.length - 1] === 0x0d) r = r.subarray(0, r.length - 1);
    if (MARKER_ROW.test(r.toString('latin1'))) found.push(i + 1);
  });
  return found;
}

/** D1's ref(p): A[p]'s bytes, else EPOCH_BASE[p]'s, else null (03-data §3.2). */
async function refBytes(core: EngineCore, it: IterationCtx, p: string): Promise<Buffer | null> {
  let e: TreeEntry | undefined = it.A.get(p);
  if (e === undefined) e = (await core.repo.readTreeMap((await core.repo.readCommit(it.epochBase)).tree)).get(p);
  return e === undefined || (e.mode !== '100644' && e.mode !== '100755') ? null : core.repo.readBlob(e.oid);
}

/** A writer result other than WRITTEN as a restore outcome. */
function restoreFailure(core: EngineCore, res: WriteLocalResult): RestoreOutcome {
  switch (res.kind) {
    case 'LOCKED':
      return { kind: 'LOCKED' };
    case 'FROZEN':
      return { kind: 'REFUSED', code: 'HOLD_FROZEN' };
    case 'DEFERRED':
      if (res.reason === 'unreadable' || res.reason === 'locked') return { kind: 'LOCKED' };
      if (core.writer.strandedPaths().length > 0) return { kind: 'POSTPONED', why: 'stranded' };
      return { kind: 'REFUSED', code: 'HOLD_DISK_CHANGED' };
    default:
      return { kind: 'REFUSED', code: 'HOLD_DISK_CHANGED' };
  }
}

/**
 * HLD-17 / DAT-45 on an OFF_DISK record: per path, D = the clean blob of the disk now (this iteration's staged-copy
 * materialization, S_raw[p]; ABSENT when missing), b = h0 (s1), held = h1 (s2):
 *   - a binary or filtered path (R3-18; binary = DAT-04 on any of b, held, A[p] and D — a working file that became binary counts):
 *     human only (RESTORE_BINARY_HUMAN_ONLY for actor 'claude', before any disk read); held written whole when D == b or
 *     D == A[p], else REFUSED HOLD_RESTORE_CONFLICT with nothing written;
 *   - held ABSENT (the local side deleted p): writeLocal(p, D, DELETE); D ABSENT and held present: writeLocal(p, ABSENT, held)
 *     (03-data §3.9 cases 2–3);
 *   - else merge-file -p --diff3 --object-id -L cowork:disk -L cowork:base -L cowork:held D b held: rc 0 → canon(result, ref(p))
 *     (DAT-45 step 1, R3-16; route (c)); rc > 0 or a restore-marker row → the result as merged and guard `markers`, told with
 *     RESTORE_MARKERS {id, path, rows} (the 1-based marker rows); a merge-file that refuses its inputs or ends abnormally (rc -1,
 *     mergeFileRc: a git BUG()/fatal, a kill, a count without git's marker rows) or an rc > 0 whose output has no restore-marker row
 *     is REFUSED HOLD_RESTORE_CONFLICT with nothing written, never a throw (ruling G1-RC).
 * inflight[r] (expected D, target the write, final ON_DISK ACTIVE with the displacement guard released and `markers` added when
 * written) is committed before writeLocalGroup (origin restore:<id>); after WRITTEN the writes are recorded as observed, and the
 * final patch, explicit (HLD-29), the inflight cleared and local.json's `restored` entry (E16-E: the writes a restart re-seeds into
 * ObservedWrites, reseedRestoredWrites) go into one commit; HOLD_RESTORED {hid, path}. No setEntry and no snap
 * transition: the restored content is a new observed change of the human CS (HLD-57 (e)). An ON_DISK K4 record that still IS the
 * TAKE_TIP displacement (isK4Displacement: its TIP write is pending) is POSTPONED (DAT-45); any other ON_DISK record — a restored K4
 * record that became CONFLICTED again keeps its stages but not `conflict` (EF4 round 2 group P) — is a TypeError (Table 4
 * applicability is resolve's, which answers an ON_DISK --restore itself and never calls this with one).
 * REFUSED RESTORE_BINARY_HUMAN_ONLY is this operator's outcome only (resolve maps it to claude_refused, R3-54, R3-65).
 */
export async function restore(core: EngineCore, it: IterationCtx, id: string, o: { humanEvidence: boolean; actor: 'human' | 'claude' }): Promise<RestoreOutcome> {
  const r = existing(core, id, 'restore');
  if (r.residence === 'ON_DISK') {
    if (isK4Displacement(r)) return { kind: 'POSTPONED', why: 'tip_write_pending' };   // DAT-45: it waits for the writer
    throw new TypeError(`restore: hold record ${id} is ON_DISK (Table 4 restores OFF_DISK records)`);
  }
  if (r.paths.length === 0) throw new TypeError(`restore: hold record ${id} has no path`);
  const mat = requireMat(it, r.paths, 'restore');
  const base = 'h0' in r.blobs ? r.blobs.h0 : r.blobs.s1;
  const held = heldSide(r);
  // R3-18 / DAT-04 on every side merge-file would read, the disk's clean blob D included (object reads of the materialization, no
  // disk read): a text record whose working file became binary (e.g. re-saved as UTF-16LE with no attribute) takes the whole-path rule.
  const binary = await wholeRestorePaths(core, it, r, mat.sRawMap);
  if (o.actor === 'claude' && binary.size > 0) return { kind: 'REFUSED', code: 'RESTORE_BINARY_HUMAN_ONLY' };   // before any disk read
  if (o.actor === 'claude' && frozen(core, it)) return { kind: 'REFUSED', code: 'HOLD_FROZEN' };
  const why = postponedBy(core);
  if (why !== null) return { kind: 'POSTPONED', why };
  if (frozen(core, it) && !o.humanEvidence) return { kind: 'REFUSED', code: 'HOLD_FROZEN' };

  const entries: Entry[] = [];
  const marked = new Map<string, number[]>();
  for (const p of r.paths) {
    const D = oidAt(mat.sRawMap, p);
    const b = blobAt(base, p) ?? ABSENT;
    const h = blobAt(held, p);
    if (h === undefined) return { kind: 'REFUSED', code: 'HOLD_RESTORE_CONFLICT' };   // a filter-failure record holds no h1 for p
    if (binary.has(p)) {
      if (D !== b && D !== oidAt(it.A, p)) return { kind: 'REFUSED', code: 'HOLD_RESTORE_CONFLICT' };
      entries.push({ path: p, expected: D, target: h });
      continue;
    }
    if (h === ABSENT || D === ABSENT) {
      entries.push({ path: p, expected: D, target: h });   // §3.9 case 2 (held ABSENT: DELETE) or case 3 (D ABSENT: create held)
      continue;
    }
    const m = await mergeFile(core.repo, D, b, h, { diff3: true, labels: RESTORE_LABELS });
    if (m.rc < 0) return { kind: 'REFUSED', code: 'HOLD_RESTORE_CONFLICT' };   // merge-file refused its inputs: nothing written, no throw
    let out = m.out;
    const rowsHere = hasRestoreMarkerRow(out);
    // Ruling G1-RC: a conflict count is trusted only with git's own cowork: marker rows in the output (mergeFileRc already demands
    // the opening rows); without them the output is no merge — an abnormal exit read as a count — and nothing is written (03-data:
    // "merge-file error → nothing written").
    if (m.rc > 0 && !rowsHere) return { kind: 'REFUSED', code: 'HOLD_RESTORE_CONFLICT' };
    if (m.rc === 0 && !rowsHere) {
      const c = canon(out, await refBytes(core, it, p), false);
      if (c.ok) out = c.out;
    } else {
      marked.set(p, markerRowsOf(out));
    }
    entries.push({ path: p, expected: D, target: await hashRouteC(core.repo, out, true) });
  }
  const markers = marked.size > 0;
  const guards: Guard[] = r.guards.filter((g) => !DISPLACEMENT.has(guardName(g)) && guardName(g) !== 'markers');
  if (markers || carries(r, 'markers')) guards.push(makeGuard('markers'));
  const final: HoldPatch = { residence: 'ON_DISK', state: 'ACTIVE', guards };
  await core.holds.commitMany([], [], { setInflight: { [id]: { op: 'restore', entries, final, explicit: true } } });
  const res = await writeEntries(core, entries, `restore:${id}`, o.humanEvidence);
  if (res.kind !== 'WRITTEN') {
    await core.holds.commitMany([], [], { clearInflight: [id] });
    return restoreFailure(core, res);
  }
  recordWrites(core, entries);
  await core.holds.commitMany([], [{ id, patch: final }], { clearInflight: [id], explicit: [id], setRestored: { [id]: await restoredWrites(core, entries) } });
  raise(core, 'HOLD_RESTORED', { hid: id, path: r.paths[0]! });
  for (const [path, rowList] of marked) raise(core, 'RESTORE_MARKERS', { id, path, rows: rowList }, 'warn');
  return { kind: 'RESTORED', markers };
}

/**
 * E16-E (HLD-17, HLD-26 (b); contract "no unobserved delta … in this run or after a restart"; R3-36's accepted restart cost superseded):
 * the restore's writes as a restart must re-seed them (RegistryLocal.restored) — every entry that wrote (target ≠ expected), with
 * state:snap's entry at its path now. A restart reseeds the private index from state:snap, and a restore makes no snap transition
 * (HLD-57 (e)), so its first materialized delta of p after a restart is snap[p] → disk: re-seeded, it lands on the write (observed,
 * HLD-26 (b)) or is judged from the written blob (R3-EF4-13), as it would have been without the restart.
 */
async function restoredWrites(core: EngineCore, entries: readonly Entry[]): Promise<RestoredWrite[]> {
  const snap = await core.repo.readTreeMap(core.view!.snap);
  return entries.filter((e) => e.target !== e.expected).map((e) => ({ path: e.path, written: e.target, snap: snap.get(e.path)?.oid ?? ABSENT }));
}

/**
 * E16-E: after the restart's reseed from state:snap, the restore writes still on an ON_DISK record are observed again
 * (ObservedWrites.record) where state:snap's entry is still the one the restore wrote over — an apply or a park family transition that
 * moved snap[p] since (R3-EF4-21's rule for the private index) leaves that entry out. ObservedWrites stays in memory; this re-seeds it.
 */
export async function reseedRestoredWrites(core: EngineCore): Promise<void> {
  const restored = core.holds.local().restored;
  if (restored === undefined || core.view === null) return;
  const snap = await core.repo.readTreeMap(core.view.snap);
  for (const [id, ws] of Object.entries(restored)) {
    const r = core.holds.get(id);
    if (r === undefined || isTerminal(r) || r.residence !== 'ON_DISK') continue;
    for (const w of ws) if ((snap.get(w.path)?.oid ?? ABSENT) === w.snap) core.observed.record(w.path, w.written);
  }
}

// ---- the collision take (DAT-29, R3-67) -----------------------------------------------------------------------------------

/**
 * DAT-29 take-team on an INCOMING `collision` record: the local file by staged copy → route (b) -w → a PATCH with h0 ABSENT and
 * h1 the captured blob, OFF_DISK PARKED, no guard, origin 'human' (local_only by HLD-03, e.g. a secret-like `.env`), committed
 * before writeLocal(p, captured, TIP[p]) (origin take:<capture id>); after WRITTEN the write is recorded as observed (no setEntry:
 * the snapshot skips p while the collision record lives); the collision record itself is left to the next apply (R3-33). On any
 * other writer result the capture ends GONE in one commit (its bytes are still on disk, R3-67). `o.humanEvidence` (an extension:
 * the verb is human) lets the write run under FREEZE; without it a frozen take is POSTPONED before any commit.
 */
export async function collisionTake(core: EngineCore, it: IterationCtx, id: string, o: { humanEvidence?: boolean } = {}): Promise<'WRITTEN' | 'HOLD_DISK_CHANGED' | 'LOCKED' | 'POSTPONED'> {
  const c = existing(core, id, 'collisionTake');
  if (c.kind !== 'INCOMING' || !carries(c, 'collision') || c.paths.length !== 1) throw new TypeError(`collisionTake: hold record ${id} is not an INCOMING collision record`);
  if (it.mat === null) throw new TypeError('collisionTake: the iteration has not materialized (prepareIteration with holdPaths)');
  if (postponedBy(core) !== null) return 'POSTPONED';
  const humanEvidence = o.humanEvidence === true;
  if (frozen(core, it) && !humanEvidence) return 'POSTPONED';
  const p = c.paths[0]!;
  const t = it.tipMap.get(p);
  if (t === undefined) return 'HOLD_DISK_CHANGED';   // TIP no longer has p: the collision ends by itself (HLD-54)
  const cap = await captureDisk(core, p);
  if (cap.kind === 'unreadable') return 'LOCKED';
  if (cap.kind !== 'ok') return 'HOLD_DISK_CHANGED';
  await ensureAttrs(core, it.epochBase, [p]);
  const h0: BlobMap = {};
  const h1: BlobMap = {};
  setBlob(h0, p, ABSENT);
  setBlob(h1, p, cap.oid);
  const k = await core.holds.holdOutcome({ kind: 'PATCH', residence: 'OFF_DISK', state: 'PARKED', paths: [p], blobs: { h0, h1 }, guard: null, origin: 'human', cs_ids: [], displaced_by: null });
  const res = await core.writer.writeLocal(p, cap.oid, t.oid, `take:${k.id}`, humanEvidence);
  if (res.kind === 'WRITTEN') {
    core.observed.record(p, t.oid);
    return 'WRITTEN';
  }
  if (k.created) await core.holds.transition(k.id, { state: 'GONE' });
  if (res.kind === 'LOCKED' || (res.kind === 'DEFERRED' && (res.reason === 'unreadable' || res.reason === 'locked'))) return 'LOCKED';
  if (res.kind === 'FROZEN' || core.writer.strandedPaths().length > 0) return 'POSTPONED';
  return 'HOLD_DISK_CHANGED';
}

// ---- restart settlement (05 F7, R3-15, R3-60, R3-67) ---------------------------------------------------------------------

/** The marker companion an interrupted markers park of `r` created: the newest non-terminal OFF_DISK PARKED companion whose h1 is the park's M. */
function parkCompanion(core: EngineCore, r: HoldRecord, op: InflightOp): HoldRecord | undefined {
  return [...core.holds.companionsOf(r.id)].reverse().find((c) => !isTerminal(c) && c.residence === 'OFF_DISK' && c.state === 'PARKED'
    && op.entries.every((e) => blobAt(heldSide(c), e.path) === e.expected));
}

/**
 * R3-15 at restart, by observation: a markers park is interrupted exactly when its in-flight entry inflight[r] is still set (commit 1
 * sets it with the companion, commit 3 or the GONE commit clears it — a completed park, after which r may well carry `markers`
 * again through a later conflicted --restore, is never settled). Per such entry (r non-terminal, ON_DISK, carrying `markers`):
 *   - the disk DISK_EQ A[p] (the entries' targets) on every path → step (3) completes: the writes are recorded, the private-index
 *     entries and state:snap set (R3-60), then the entry's final patch (`markers` released, r OFF_DISK, displaced_by as the park
 *     was given) with the entry cleared;
 *   - the disk DISK_EQ M[p] (the entries' pre-images: the rows still on disk) on every path → the companion ends GONE (its bytes
 *     are on r's disk) and r is unchanged, the entry cleared;
 *   - neither → nothing is guessed: the companion (holding M) and r are left as they are, the entry cleared, HOLD_DISK_CHANGED {hid}.
 * The first step of settleHoldOps; every other in-flight entry is settleHoldOps' own.
 */
export async function settleMarkersParks(core: EngineCore): Promise<void> {
  const view = core.view;
  if (view === null) throw new Error('settleMarkersParks: no state');
  const { A } = await currentA(core);
  const snap = await core.repo.readTreeMap(view.snap);
  const mode = (p: string): FileMode => modeOf(p, snap, A);
  for (const [id, op] of Object.entries(core.holds.local().inflight)) {
    const r = core.holds.get(id);
    if (r === undefined || isTerminal(r) || op.op !== 'park' || r.residence !== 'ON_DISK' || !carries(r, 'markers')) continue;
    if (await diskEqAll(core, op.entries.map((e) => ({ path: e.path, x: e.target })), mode)) {
      recordWrites(core, op.entries);
      await parkWritten(core, op.entries, mode);
      await withdrawWritten(core, r.paths);   // final review F6
      await core.holds.commitMany([], [{ id, patch: op.final }], { clearInflight: [id] });
    } else if (await diskEqAll(core, op.entries.map((e) => ({ path: e.path, x: e.expected })), mode)) {
      const c = parkCompanion(core, r, op);
      await core.holds.commitMany([], c === undefined ? [] : [{ id: c.id, patch: { state: 'GONE' } }], { clearInflight: [id] });
    } else {
      await core.holds.commitMany([], [], { clearInflight: [id] });
      raise(core, 'HOLD_DISK_CHANGED', { hid: id }, 'warn');
    }
  }
}

/**
 * The disk as it is now over r's paths: a staged read and route (b) -w per path (settling a hold record is W6's hold-record occasion), a
 * missing path left out; null when a path cannot be observed (unreadable, unstable, a filter failure).
 */
async function diskNow(core: EngineCore, r: HoldRecord, A: TreeMap): Promise<TreeMap | null> {
  const disk = new Map<string, TreeEntry>();
  for (const p of r.paths) {
    const d = await captureDisk(core, p);
    if (d.kind === 'ok') disk.set(p, { path: p, mode: modeOf(p, A), oid: d.oid });
    else if (d.kind !== 'missing') return null;
  }
  return disk;
}

/**
 * R1 on the disk as it is now (`disk`, diskNow) says GONE: the held change of r is on the disk nowhere. A disk that cannot be observed
 * (null) or an operator error is never GONE.
 */
async function goneOnDiskNow(core: EngineCore, r: HoldRecord, A: TreeMap, disk: TreeMap | null): Promise<boolean> {
  if (disk === null) return false;
  try {
    return (await evaluateOnDisk(r, A, disk, core.rebase, core.holds.local().explicit.includes(r.id), core.holds.isCompanion(r.id))) === 'GONE';
  } catch (e) {
    if (e instanceof HoldOperatorError) return false;
    throw e;
  }
}

/**
 * Final review r3 A3-2 (Ruling R3-FF3-A2): the reverse merge of r alone, mf(disk, H1'[p], H0'[p]) over r's REBASE on A, conflicts on the
 * disk as it is now (`disk`, diskNow) — r's held change cannot be separated from what is there. A REBASE conflict, an operator error and
 * a disk that cannot be observed (null) count as a conflict: the ruling's direction when unsure is an extra safety copy.
 */
async function reverseAloneConflictsNow(core: EngineCore, r: HoldRecord, A: TreeMap, disk: TreeMap | null): Promise<boolean> {
  if (disk === null) return true;
  try {
    const rb = await core.rebase.rebase(r, A);
    return !rb.ok || (await reverseAlone(r, rb.h0p, rb.h1p, disk, core.rebase)) === null;
  } catch (e) {
    if (e instanceof HoldOperatorError) return true;
    throw e;
  }
}

/**
 * A guard-less OFF_DISK PARKED one-path PATCH with h0 ABSENT that is no marker companion and no restart safety copy (final review r2
 * A-2: settleCopy's copy of a park that deleted a path A lacks has this shape too, and its local.json mark outlives the restart that
 * made it): a collision-take capture's shape.
 */
function takeCaptureShape(core: EngineCore, r: HoldRecord): boolean {
  return r.kind === 'PATCH' && r.residence === 'OFF_DISK' && r.state === 'PARKED' && r.guards.length === 0 && r.paths.length === 1
    && 'h0' in r.blobs && blobAt(r.blobs.h0, r.paths[0]!) === ABSENT && !core.holds.isCompanion(r.id) && !core.holds.isSettleCopy(r.id);
}

/**
 * Final review r2 A-1 (Ruling R3-FF2-A1): the interrupted park `op` of r was a whole park — HLD-16's capture-first refresh made r's held
 * side the park's pre-image (S_disk) on every path and the park wrote A[p]: r withholds whole by its kind, state or guards (wholeByRecord;
 * a PATCH the park's own step-5 merge made CONFLICTED carries that state in the in-flight entry's commit), or it is an ACTIVE PATCH that
 * R3-18 withholds whole on a binary or filtered path, whose held side then equals every pre-image. A park whose target was r's step-5
 * MASK alone is not (its held side stays r's own change; final review r3 A3-2 settles it by reverseAloneConflictsNow instead).
 * Final review r3 A3-3 (Ruling R3-FF3-A3): the park's own decision when its in-flight entry carries it (`whole`, made on the pre-park
 * held side — a park withheld whole only because that side was binary refreshed it to a text Da, which a recomputation here would read
 * as a MASK-alone park); otherwise (an entry written before the field) recomputed from the record as stored. Reads EPOCH_BASE
 * attributes (restart requests every record path's first).
 */
async function parkedWhole(core: EngineCore, r: HoldRecord, op: InflightOp, A: TreeMap): Promise<boolean> {
  if (op.whole !== undefined) return op.whole;
  if (wholeByRecord(r)) return true;
  const held = heldSide(r);
  if (!op.entries.every((e) => (blobAt(held, e.path) ?? ABSENT) === e.expected)) return false;   // a MASK-alone park: nothing refreshed
  const pre = new Map(op.entries.map((e) => [e.path, e.expected] as const));
  return wholeByBytes(core, r, (p) => pre.get(p) ?? ABSENT, A);
}

/**
 * Final review F2 and r2 A-1 (INV-NOLOSS; Task 5 carry "FIX NEEDED, data safety"; Ruling R3-FF2-A1, Task 5 ruling (a) amended): a whole
 * park of r (parkedWhole) settled as 'neither' — its disk is neither the park's pre-image nor its target — that did not land, while r's
 * held side (= the park's pre-image, Da) is not DISK_EQ on every path. Whether the write completed before a human edit (Da is then on
 * no disk) or the edit came first (the writer refused, the kill came before the in-flight entry was cleared) cannot be told: r stays
 * ON_DISK, masking the disk as before, and this copy keeps the bytes the park removed. A later R1 GONE — S_disk == A for a PIN or an
 * UNSEPARABLE record, a clean reverse merge for any other PATCH once the edit that made it conflict is gone — or a bundled capture
 * refreshing r's held side then loses nothing. Final review r3 A3-2 (Ruling R3-FF3-A2): a park that is not whole (its target r's
 * step-5 MASK alone) settled 'neither' and not landed keeps the same copy when r's reverse-alone merge on the current disk conflicts
 * (reverseAloneConflictsNow): the human's edit touched r's own lines, so R1 ends r GONE once those lines return to A. The copy: an
 * OFF_DISK PARKED PATCH over the park's paths, h0 = what the park wrote (its targets: A[p] for a whole park, r's MASK alone
 * otherwise), h1 = what it removed (its pre-images; for a whole park r's refreshed held side), guard-less unless r carries `revert`,
 * which the copy keeps alone (final review r3 A3-4, Ruling R3-FF3-A4, INV-HLD-NOREVERT: a --restore'd guard-less copy masks nothing,
 * its write is observed and skipped by the revert detector, so a teammate-line removal would publish without --publish), origin
 * r.origin, cs_ids []
 * — mirrored like any record that is not local_only (r is not: PARK never runs on one) and restorable with --restore. holdOutcome: a
 * repeat of this settlement after a kill before the in-flight entry was cleared attaches to the copy made the first time (HLD-07's
 * dedupe), and never to r itself or to any other ON_DISK record (NewRecord.settleCopyOf; final review r3 A3-1: a guard-less r whose
 * whole park refreshed h1 := Da is otherwise its own twin, and no copy is made). The copy's creation commit also marks it in local.json
 * `settleCopies` (final review r2 A-2), so a later restart never takes a copy with h0 ABSENT for a collision-take capture
 * (takeCaptureShape). Returns the copy's id.
 */
async function settleCopy(core: EngineCore, r: HoldRecord, op: InflightOp): Promise<string> {
  const h0: BlobMap = {};
  const h1: BlobMap = {};
  for (const e of op.entries) {
    setBlob(h0, e.path, e.target);
    setBlob(h1, e.path, e.expected);
  }
  // Final review r3 A3-4 (Ruling R3-FF3-A4, INV-HLD-NOREVERT): r's `revert` guard, and only that one, stays on the copy.
  const revert = r.guards.find((g) => guardName(g) === 'revert');
  const k = await core.holds.holdOutcome({
    kind: 'PATCH', residence: 'OFF_DISK', state: 'PARKED', paths: op.entries.map((e) => e.path), blobs: { h0, h1 }, guard: revert?.name ?? null,
    origin: r.origin, cs_ids: [], displaced_by: null, settleCopyOf: r.id,
  });
  return k.id;
}

/**
 * Restart's one settlement entry point, run by restart on both of its paths before the first publish (after the intent
 * resolution on the normal path, after lostStateRebuild and attachState on the lost-state path): settleMarkersParks, then every
 * local().inflight entry by DISK_EQ — every entry at its target → a park or discard commits R3-60's snap transition (the
 * private-index entries too), then its final patch with the entry cleared (explicit for a restore; R3-28's `discard` trace and
 * HOLD_DISCARDED log line for a discard, discardEnded); every entry at its pre-image → cleared only; neither → cleared, HOLD_DISK_CHANGED {hid}, and
 * the record left as it is — except a park whose held change is on the disk nowhere now (R1 would end it GONE), which lands its
 * final patch instead (OFF_DISK holding its bytes, no snap transition; finding 6 of Task 5's review, INV-NOLOSS), and a whole park
 * (parkedWhole: PIN, CONFLICTED, whole-path guard, R3-18) that does not land while r's held side is not DISK_EQ on every path, or a
 * park that is not whole and does not land while r's reverse-alone merge on the current disk conflicts (final review r3 A3-2), which
 * keeps the bytes it removed in an OFF_DISK PARKED copy, guard-less or keeping r's `revert` (settleCopy; final review F2, r2 A-1, r3
 * A3-4, Rulings R3-FF2-A1, R3-FF3-A4), told with
 * HOLD_DISK_CHANGED {hid, copy} — then every take capture whose path still has a non-terminal collision record and whose disk still
 * DISK_EQ its h1 (the TIP write did not happen → GONE, R3-67), the marker companion of an apply's K4 onto a markers record (or over any
 * marker file, R3-EF4-15) whose disk still DISK_EQ its h1 (the TIP write did not happen → GONE, EF4 E4-1, R3-EF4-7), and every ON_DISK CONFLICTED stage record whose disk DISK_EQ
 * s3[p] with A[p] = s3[p] (the TIP write completed → OFF_DISK with displaced_by/peer_authors, R3-22; `markers` released — except a
 * record carrying `markers` whose s3 blob holds a restore-marker row, which stays ON_DISK with it, ruling R3-SPEC-6). Without it a crash after a
 * completed PARK write and before its registry commit would leave an ON_DISK record that R1 then ends GONE (INV-NOLOSS).
 */
export async function settleHoldOps(core: EngineCore): Promise<void> {
  await settleMarkersParks(core);
  const view = core.view;
  if (view === null) throw new Error('settleHoldOps: no state');
  const { A } = await currentA(core);
  const snap = await core.repo.readTreeMap(view.snap);
  const mode = (p: string): FileMode => modeOf(p, snap, A);

  for (const [id, op] of Object.entries(core.holds.local().inflight)) {
    const r = core.holds.get(id);
    if (r === undefined || isTerminal(r)) {
      await core.holds.commitMany([], [], { clearInflight: [id] });
      continue;
    }
    if (await diskEqAll(core, op.entries.map((e) => ({ path: e.path, x: e.target })), mode)) {
      recordWrites(core, op.entries);
      if (op.op !== 'restore') {
        await parkWritten(core, op.entries, mode);
        await withdrawWritten(core, op.entries.map((e) => e.path));   // final review F6
      }
      if (op.op === 'discard') await discardFromPairs(core, r);   // EF2 r1 F3: the discarded content leaves its CS's pairs first
      await core.holds.commitMany([], [{ id, patch: op.final }], {
        clearInflight: [id], ...(op.explicit ? { explicit: [id] } : {}),
        ...(op.op === 'restore' ? { setRestored: { [id]: await restoredWrites(core, op.entries) } } : {}),   // E16-E
      });
      if (op.op === 'discard') discardEnded(core, core.holds.get(id) ?? r);
    } else if (await diskEqAll(core, op.entries.map((e) => ({ path: e.path, x: e.expected })), mode)) {
      await core.holds.commitMany([], [], { clearInflight: [id] });
    } else {
      // Neither: nothing is guessed about who changed the disk. A park whose held change is on the disk nowhere now — the record
      // R1 would end GONE at its next evaluation (step 3 on the current disk) — lands its final patch (OFF_DISK, holding its
      // bytes; no snap transition: the disk is not the target), so a park whose write completed before a later edit never loses
      // the held change (INV-NOLOSS). While the held change is still on disk the record is left as it is (masked there).
      // Final review F2 and r2 A-1 (Ruling R3-FF2-A1): a whole park refreshed r's held side := S_disk (the whole pre-image Da) before
      // writing A[p], so the landing above cannot tell — for a PIN or an UNSEPARABLE record R1's GONE is S_disk == A, which an edited
      // disk never is, and for any other PATCH an edit touching one of Da's lines makes the reverse merge conflict until the human's
      // later return to A, where it is clean and ends the record GONE. The record stays ON_DISK (masking, as an edit made before the
      // write may still hold its change) and, while its held side is not DISK_EQ on every path (row 14's predicate; for a whole park
      // the 'neither' disk already says so, since the held side is the pre-image), a safety copy keeps the bytes the park removed.
      // Final review r3 A3-2 (Ruling R3-FF3-A2): a park that is not whole (its target r's step-5 MASK alone, its held side r's own
      // change) has the same hole when the human's edit touches r's own lines — R1's reverse merge conflicts until the line returns to
      // A, where it ends r GONE — so it keeps the same copy exactly when r's reverse-alone merge on the current disk conflicts (a park
      // killed before its write, whose disk still holds r's change beside an edit elsewhere, makes none).
      const disk = op.op === 'park' ? await diskNow(core, r, A) : null;
      const lands = op.op === 'park' && (await goneOnDiskNow(core, r, A, disk));
      const keeps = op.op === 'park' && !lands && ((await parkedWhole(core, r, op, A))
        ? !(await diskEqAll(core, r.paths.map((p) => ({ path: p, x: blobAt(heldSide(r), p) ?? ABSENT })), mode))
        : await reverseAloneConflictsNow(core, r, A, disk));
      const copy = keeps ? await settleCopy(core, r, op) : null;
      if (lands) await withdrawWritten(core, r.paths);   // final review F6: the landed record masks nothing from here on
      await core.holds.commitMany([], lands ? [{ id, patch: op.final }] : [], { clearInflight: [id] });
      // Final review r3 A3-1: `copy` names a record other than r (attachOf never attaches a settle copy to r or to any ON_DISK record);
      // were it r, the message would point the human at --restore of an ON_DISK record, so it is then told without `copy`.
      raise(core, 'HOLD_DISK_CHANGED', copy === null || copy === id ? { hid: id } : { hid: id, copy }, 'warn');
    }
  }

  // Task 12b (carry 3): HLD-64 copies whose RESTORE did not complete (a crash after the copy's creation commit, or inside its RESTORE
  // left at its pre-image or changed by someone else above): a copy still OFF_DISK ends GONE with its mark (the human's repeat makes a
  // fresh copy from the board's held/<id>/, which keeps the bytes); a restored (ON_DISK) or ended one only loses the mark.
  for (const [id, of] of Object.entries(core.holds.local().copies)) {
    const c = core.holds.get(id);
    if (c === undefined || isTerminal(c) || c.residence === 'ON_DISK') {
      await core.holds.commitMany([], [], { clearCopies: [id] });
      continue;
    }
    await core.holds.commitMany([], [{ id, patch: { state: 'GONE' } }], { clearCopies: [id] });
    core.deps.log.write('warn', 'HOLD_DISK_CHANGED', { hid: of, copy: id });
  }

  // Final review r2 A-2: a safety copy restored (ON_DISK: an ordinary record of this peer from now on) or ended loses its mark; one
  // still OFF_DISK keeps it, so the take settlement below never mistakes it for a capture.
  const unmarked = Object.keys(core.holds.local().settleCopies ?? {}).filter((id) => {
    const c = core.holds.get(id);
    return c === undefined || isTerminal(c) || c.residence === 'ON_DISK';
  });
  if (unmarked.length > 0) await core.holds.commitMany([], [], { clearSettleCopies: unmarked });

  for (const k of core.holds.nonTerminal()) {
    if (!takeCaptureShape(core, k)) continue;
    const p = k.paths[0]!;
    if (!core.holds.byPath(p).some((c) => c.kind === 'INCOMING' && carries(c, 'collision'))) continue;
    if (await diskEqAll(core, [{ path: p, x: blobAt(heldSide(k), p) ?? ABSENT }], mode)) await core.holds.transition(k.id, { state: 'GONE' });
  }

  // EF4 E4-1 (ruling R3-EF4-7, R3-15's pattern): an apply's K4 onto a markers record r committed a marker companion (h0 = A[p],
  // h1 = S_disk[p]) with r ON_DISK CONFLICTED carrying `markers` and `conflict`, and was killed before its verified TIP write (no apply
  // intent yet, or one the restart decision rolled back). The newest such companion whose h1 the disk still DISK_EQ on every path is a
  // redundant copy of bytes on r's disk and ends GONE; a disk that is neither is not guessed about (the companion stays). r still ON_DISK
  // CONFLICTED with `conflict` does not prove the write did not happen: after a verified write whose bytes keep a restore-marker row (TIP's
  // blob holds one, R3-FF3-B3) r stays ON_DISK with `markers` (rulings R3-SPEC-3, R3-SPEC-6). The DISK_EQ on h1 is the proof — that
  // disk holds TIP[p], never the displaced marker file — so such a companion stays live.
  // EF4 round 2 K-1 (R3-EF4-15): the same for the companion of a K4 record over a marker file that carries no `markers` itself (a K4 at a
  // path of a multi-path, unknown-guard or companion markers holder, or over rows no record holds; apply.ts k4OverMarkerFile).
  // EF5 X2-1 (ruling R3-EF4-25): the companion is matched by companionsOf(r) and its h0 == A[p] — the A of the K4, unchanged since the TIP
  // write did not happen (after a verified one the decision moved A[p] to TIP[p]) — never by r's s1: a K4 whose REBASE onto A conflicted holds
  // r's own base as s1, while the companion's h0 is A[p] (05 §3.4 item 3).
  // Ruling R3-EF4-31 (EF5 merge M-4): h0 == r.s1 at p matches too — a clean pair, whose s1 IS the K4's A[p] — so a redundant companion
  // still ends GONE when the lost-state rebuild (restart.ts, before this settlement) moved A[p] since the K4. A REBASE-conflict pair's
  // s1 (r's own base) equals the companion's h0 only when that base is the K4's A[p] itself.
  for (const r of core.holds.nonTerminal()) {
    if (r.residence !== 'ON_DISK' || r.state !== 'CONFLICTED' || !('s1' in r.blobs) || !carries(r, 'conflict')) continue;
    const s1 = r.blobs.s1;
    const c = [...core.holds.companionsOf(r.id)].reverse().find((x) => {
      const h0 = 'h0' in x.blobs ? x.blobs.h0 : null;
      return !isTerminal(x) && x.residence === 'OFF_DISK' && x.state === 'PARKED' && x.guards.length === 0 && h0 !== null
        && x.paths.length === r.paths.length
        && r.paths.every((p) => {
          const h = blobAt(h0, p);
          return x.paths.includes(p) && h !== undefined && (h === oidAt(A, p) || h === blobAt(s1, p));
        });
    });
    if (c === undefined) continue;
    if (await diskEqAll(core, c.paths.map((p) => ({ path: p, x: blobAt(heldSide(c), p) ?? ABSENT })), mode)) await core.holds.transition(c.id, { state: 'GONE' });
  }

  for (const r of core.holds.nonTerminal()) {
    if (r.residence !== 'ON_DISK' || r.state !== 'CONFLICTED' || !('s3' in r.blobs) || !carries(r, 'conflict') || r.paths.length === 0) continue;
    const s3 = r.blobs.s3;
    if (!r.paths.every((p) => blobAt(s3, p) === oidAt(A, p))) continue;
    if (!(await diskEqAll(core, r.paths.map((p) => ({ path: p, x: blobAt(s3, p) ?? ABSENT })), mode))) continue;
    // EF4 E4-1: k4OffDiskPatch also releases `markers` (a K4 onto a markers record; the disk holds TIP[p] now). Ruling R3-SPEC-6
    // (R3-SPEC-3 completed): k4OffDiskPatch releases it on the premise that the disk then holds no restore-marker row (DAT-46), so the
    // completion applies the row check of the apply's post-write move and of the restart decision (R3-EF4-28, R3-EF4-31, R3-SPEC-3): a
    // record carrying `markers` whose s3 blob — a regular file, the disk's bytes by the DISK_EQ above (A[p] = s3[p]) — holds a row stays
    // ON_DISK with `markers` (never unmasked). Without it the next restart undid the apply's keep of a TAKE_TIP whose TIP blob holds a
    // row (R3-FF3-B3), and the restart of a crashed one undid its own decision's keep.
    if (carries(r, 'markers') && (await someRestoreMarkerRow(core, r.paths.map((p) => A.get(p))))) continue;
    await core.holds.transition(r.id, k4OffDiskPatch(r, await k4Displacement(core, view.laC, r.paths[0]!)));
  }
}

/** Whether a regular-file entry among `entries` holds a restore-marker row (DAT-46); a missing or non-regular entry holds none. */
async function someRestoreMarkerRow(core: EngineCore, entries: ReadonlyArray<TreeEntry | undefined>): Promise<boolean> {
  for (const e of entries) if (isRegularEntry(e) && hasRestoreMarkerRow(await core.repo.readBlob(e.oid))) return true;
  return false;
}

/**
 * Plan 3 final review F6 (05-holds §3.4 item 3, HLD-16, INV-HLD-OFFDISK; HLD-41's withdrawal): an operator write took a record's bytes
 * off the disk over `paths` — PARK and the markers park (and their restart completions, also a 'neither' park that lands), and the
 * ON_DISK --discard. The record is OFF_DISK (or terminal) from then on and masks nothing, so an unpublished ready pair captured before
 * the write still carried those bytes (a K6 or dependency PIN's whole change-set, a revert PATCH's removal of a teammate's line, a
 * RESTORE's marker rows) and published them once nothing else held its group, while the author's disk kept the write. Every publication
 * group with an unpublished ready pair over one of `paths` is withdrawn whole (ChangeSets.withdrawPaths; no message: HOLD_PARKED,
 * HOLD_AUTO_PARKED or the discard already tell) and re-captured from the post-write disk; ready() (with the CS table when one is
 * journaled) in one state update, before the record's final registry patch, so a kill in between is completed by settleHoldOps' replay.
 * Never under a kept push intent: every caller is postponed or refused then (R3-23), and a restart resolves the intent first. A failed
 * update (not a lost CAS or a crash) rolls ChangeSets back.
 */
export async function withdrawWritten(core: EngineCore, paths: readonly string[]): Promise<void> {
  const view = core.view;
  if (view === null) throw new Error('withdrawWritten: no state');
  const rollback = core.cs.rollbackPoint();
  if (core.cs.withdrawPaths(new Set(paths)).length === 0) return;
  await journalWithdrawal(core, rollback);
}

/**
 * EF4 round 2 I2-3 (ruling R3-EF4-20; 05-holds §3.4 item 3, HLD-40's withdrawal, ENG-41 (k)): when a record's `markers` PREDICATE releases
 * (recordStep's markersRelease: the human removed the restore-marker rows), every unpublished ready pair whose R holds a restore-marker row
 * at one of the record's `paths` is withdrawn silently with its publication group and re-captured from the disk (ChangeSets.withdrawPairs,
 * withdrawWritten's journal step). Such a pair — captured while the rows were on disk, kept journaled because a dependency PIN held its
 * group — can never pass ENG-41 (k): left journaled it aborted every publish window of the peer (NOT_CONVERGED publish_assert:k) once the
 * PIN released, until the group's next capture. Called before the release, so a failed update keeps `markers` and the next iteration
 * retries. Under a kept push intent nothing is journaled ('postponed': the caller keeps `markers` until a materializing iteration after
 * the intent's resolution, which an iteration does first, P2-PUSHINTENT-FIRST). 'none' when no pair carries such a row.
 */
export async function withdrawMarkerPairs(core: EngineCore, paths: readonly string[]): Promise<'none' | 'withdrawn' | 'postponed'> {
  const view = core.view;
  if (view === null) throw new Error('withdrawMarkerPairs: no state');
  const want = new Set(paths);
  const ids = new Set<string>();
  for (const pair of core.cs.ready()) {
    const on = pair.paths.filter((p) => want.has(p));
    if (on.length === 0) continue;
    const R = await core.repo.readTreeMap(pair.R);
    for (const p of on) {
      const e = R.get(p);
      if (e === undefined || (e.mode !== '100644' && e.mode !== '100755')) continue;
      if (hasRestoreMarkerRow(await core.repo.readBlob(e.oid))) {
        ids.add(pair.csId);
        break;
      }
    }
  }
  if (ids.size === 0) return 'none';
  if (view.intent.kind === 'push') return 'postponed';
  const rollback = core.cs.rollbackPoint();
  if (core.cs.withdrawPairs(ids).length === 0) return 'none';
  await journalWithdrawal(core, rollback);
  return 'withdrawn';
}

/** The state update of a withdrawal: ready() (with the CS table when one is journaled); a failed update (no lost CAS, no crash) rolls back. */
async function journalWithdrawal(core: EngineCore, rollback: () => void): Promise<void> {
  const view = core.view!;
  try {
    const table = (await readCsTable(core.repo, view)) !== null ? { keep: new Map([...view.keep, await csTableKeep(core.repo, core.cs.table())]) } : {};
    await core.commit({ ready: core.cs.ready(), ...table });
  } catch (e) {
    if (!(e instanceof StateCasLostError) && !(e instanceof KilledAt)) rollback();
    throw e;
  }
}

/**
 * EF2 fix round 1, F3 (05-holds Table 4 `--discard`; the review's open question, confirmed: a discarded K6 PIN's ready pair stayed
 * journaled and published the discarded bytes once the record ended). Before r ends RESOLVED_DISCARD its paths leave every unpublished
 * ready pair whose cs_id it names (ChangeSets.discardPaths), in one state update (the CS table with it when one is journaled), and each
 * pair left with no path is logged CS_READY_CANCELLED. Called by resolve's `--discard` after the disk write (ON_DISK) or before the
 * state-only transition (OFF_DISK), and by settleHoldOps' completion of an interrupted discard: a kill between the two commits leaves
 * a non-terminal record (repeatable) or, completed at restart, the same end — never a terminal record whose pair still publishes.
 * A failed update (not a lost CAS or a crash) rolls ChangeSets back.
 */
export async function discardFromPairs(core: EngineCore, r: HoldRecord): Promise<void> {
  if (r.cs_ids.length === 0 || r.paths.length === 0) return;
  const view = core.view;
  if (view === null) throw new Error('discardFromPairs: no state');
  const rollback = core.cs.rollbackPoint();
  const left = await core.cs.discardPaths(core.repo, new Set(r.cs_ids), new Set(r.paths), core.scratch('r'));
  if (left === null) return;
  try {
    const table = (await readCsTable(core.repo, view)) !== null ? { keep: new Map([...view.keep, await csTableKeep(core.repo, core.cs.table())]) } : {};
    await core.commit({ ready: core.cs.ready(), ...table });
  } catch (e) {
    if (!(e instanceof StateCasLostError) && !(e instanceof KilledAt)) rollback();
    throw e;
  }
  for (const csId of left) core.deps.log.write('info', 'CS_READY_CANCELLED', { cs_id: csId });
}

/**
 * R3-28 for a record that ended RESOLVED_DISCARD (resolve's `--discard` and settleHoldOps' completion of an interrupted one): the
 * `discard` trace naming the held-side blobs, and the daemon log line HOLD_DISCARDED {hid, rev, paths} — a registered log-only code
 * (HOLD_LOG_CODES; HOLD_CODES stays 38, Task 5 ruling (d), Task 11), never status.json. Its mirrored op is mirrorSync's.
 */
export function discardEnded(core: EngineCore, r: HoldRecord): void {
  const held = heldSide(r);
  core.deps.trace.emit({ kind: 'discard', peer: core.peerId, id: r.id, rev: r.rev, held: r.paths.map((p) => ({ path: p, blob: (blobAt(held, p) ?? ABSENT) === ABSENT ? null : (blobAt(held, p) as string) })) });
  core.deps.log.write('info', 'HOLD_DISCARDED', { hid: r.id, rev: r.rev, paths: r.paths.join(',') });
}
