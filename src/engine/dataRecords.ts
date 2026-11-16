// The 03-data record creators (03-data §2, §3.2 "Disk repair", §3.7 "Publish side", §3.8 "Churn guard"; DAT-08, DAT-32,
// DAT-33, DAT-39; rulings R3-23, R3-34, R3-35, R3-36, R3-53):
//
//   repairStep         DAT-08 (R3-34): a LIVE text unfiltered path whose materialized S_raw[p] ≠ S_disk[p] (a Write that dropped
//                      the BOM or flipped the endings) is written back to S_disk[p] through writeLocal (origin repair:<p>) at
//                      the first iteration that materializes p after two detection ticks with p's stat and detection id
//                      unchanged; the private-index entry and the stat cache follow; EOL_REPAIRED to the log only
//   repairDue          the paths that wait for that materializing iteration (iterate() hands them over as holdPaths)
//   portabilityStep    DAT-33 / R3-53: a NOT_ADMITTED `portability` new path becomes one local_only ON_DISK PATCH `portability`
//                      (PATH_NOT_PORTABLE {id, path, rule}) when a record can carry it and it is within the new-file cap,
//                      else is reported PATH_NOT_PORTABLE {path, rule} once per episode with no record; the guard is released
//                      when D7 passes for the name, the record ends GONE when the name leaves the disk
//   churnStep          DAT-39: every changed LIVE `modify` path of a detection tick that no `generated?` record holds is one
//                      observation (next = the tick's stage copy, or the materialized S_raw blob when the iteration materialized
//                      p; prev = the previous observation or, first, the private-index blob as it was before this iteration;
//                      hook attribution; binary; a bounded-cost rewritten-rows share); a path whose newest 3 consecutive
//                      observations qualify (churnVerdict) becomes one ON_DISK PATCH `generated?` (GENERATED_SUSPECT); such a
//                      record ends SUBSUMED when its path becomes UNMANAGED
//
// Calling rule: every step runs on every iteration that ran a detection tick (it.tick !== null) — DAT-33 and DAT-39 count
// snapshots (R3-34's reading), and F-DAT-04's generator keeps the human CS open, so no capture would ever materialize the path.
// Each writes an object only at a W6 occasion it owns (glossary §26.1 W6 (c): a record's content is the staged copy hashed by
// route (b) -w); repairStep writes the disk only in an iteration whose it.mat materialized p. The steps' per-core memory
// (quiet-tick counters and repair episodes, churn histories, announced names) lives in a module-level WeakMap<EngineCore, …>,
// so no EngineCore member is added; it restarts empty with every core (a daemon start). Codes reach status through
// core.holdCode (the newest wins) and the daemon log (R-27), through holdOps.ts's shared raise().
import { join } from 'node:path';
import { hashNewPath, hashRouteB, isFilterFailure } from '../data/blobRoutes.js';
import { CHURN_SNAPSHOTS, churnVerdict, rewrittenRatio, type ChurnObservation } from '../data/churn.js';
import { form, isBinaryBytes } from '../data/rows.js';
import { portable } from '../data/scope.js';
import { ABSENT, isOid, type Oid, type OidOrAbsent } from '../git/oid.js';
import type { FileMode, TreeEntry } from '../git/repo.js';
import { guardName, isUnknownGuard, setBlob, type BlobMap } from '../holds/record.js';
import { sameStat, type FsLstat } from '../ports/fs.js';
import { materializedFor, pathIsFiltered, pathIsText, type EngineCore, type IterationCtx } from './core.js';
import { captureDisk, carries, frozen, postponedBy, raise, readStageCopy } from './holdOps.js';
import type { Materialized } from './snapshot.js';
import { stageable } from './stagedRead.js';
import { INDEX_ONLY } from './treeEdit.js';

/** R3-34: the detection ticks with p's stat and detection id unchanged that a repair waits for after its materialization. */
const REPAIR_QUIET_TICKS = 2;

/**
 * One DAT-08 episode (R3-34): keyed by p's lstat and S_raw id at the materialization that showed S_raw[p] ≠ S_disk[p]; `quiet`
 * counts the unchanged detection ticks since; `since` is that materialization's iteration (it does not count as a quiet tick).
 */
interface Episode { stat: FsLstat; sRaw: Oid; sDisk: Oid; mode: FileMode; quiet: number; since: IterationCtx; }

/**
 * One path's churn history: its newest observations (oldest first) and the newest observation's bytes, the next observation's
 * prev, with their binary sniff. prev is kept whatever its size (fix round 2 ruling: rewrittenRatio trims the common rows
 * before its caps, so a one-row autosave in a file beyond them scores its true share); the history, and with it prev, ends at
 * the first tick that does not change the path.
 */
interface ChurnHistory { obs: ChurnObservation[]; prev: Buffer; prevBinary: boolean; }

/** What the steps remember per core between iterations (in memory only). */
interface Memory {
  /** DAT-08: the running repair episodes by path. */
  readonly repair: Map<string, Episode>;
  /** DAT-39: the paths with a running chain of consecutive observations. */
  readonly churn: Map<string, ChurnHistory>;
  /**
   * DAT-39: the snapshot's last materialization as churnStep's previous call saw it. A path this iteration materialized has
   * its private-index entry already set to the new bytes, so a first observation's prev is this materialization's S_raw entry
   * (else A's) — the stand-in, until Task 8's Materialized.prevMap, for the private-index entry before this materialization.
   */
  lastMat: Materialized | null;
  /** R3-53 and the new-file cap: the record-less non-portable paths whose PATH_NOT_PORTABLE this episode already raised. */
  readonly announced: Set<string>;
}

const memory = new WeakMap<EngineCore, Memory>();

function memoryOf(core: EngineCore): Memory {
  let m = memory.get(core);
  if (m === undefined) {
    m = { repair: new Map(), churn: new Map(), lastMat: null, announced: new Set() };
    memory.set(core, m);
  }
  return m;
}

/** A one-path blob map (own property, so `__proto__` is a path like any other). */
function one(path: string, oid: OidOrAbsent): BlobMap {
  const m: BlobMap = {};
  setBlob(m, path, oid);
  return m;
}

/** The scope class of p in this iteration; null when it cannot be had (attributes never requested for p). */
function classOf(it: IterationCtx, p: string): string | null {
  try {
    return it.scope(p).cls;
  } catch {
    return null;
  }
}

/**
 * The private-index blob of p, read at the first observation of a churn chain (DAT-39's "previous snapshot"): one
 * `ls-files -s -z -- <p>` on the private index (`<coworkDir>/<enc(b)>.index`, the snapshot's own; INDEX_ONLY config, literal
 * pathspec) and one blob read; null when the index has no regular entry for p. Writes nothing.
 */
async function privateBlob(core: EngineCore, p: string): Promise<Buffer | null> {
  const r = await core.repo.run(['ls-files', '-s', '-z', '--', p], { indexFile: core.path(`${core.refs.e}.index`), config: INDEX_ONLY, literalPathspecs: true });
  for (const rec of r.stdout.toString('utf8').split('\0')) {
    const tab = rec.indexOf('\t');
    if (tab < 0 || rec.slice(tab + 1) !== p) continue;
    const [mode, oid, stage] = rec.slice(0, tab).split(' ');
    if (stage !== '0' || (mode !== '100644' && mode !== '100755') || !isOid(oid)) continue;
    return core.repo.readBlob(oid as Oid);
  }
  return null;
}

// ---- disk repair (DAT-08; R3-23, R3-34, R3-36) --------------------------------------------------------------------------

/** p's materialized S_raw and S_disk entries when p is a repair candidate of `mat` (R3-34), else null. */
function candidate(core: EngineCore, it: IterationCtx, mat: Materialized, p: string): { raw: Oid; disk: Oid; mode: FileMode } | null {
  const raw = mat.sRawMap.get(p);
  const disk = mat.sDiskMap.get(p);
  if (raw === undefined || disk === undefined || raw.oid === disk.oid) return null;
  if ((disk.mode !== '100644' && disk.mode !== '100755') || raw.mode !== disk.mode) return null;
  if (mat.canonRefused.has(p) || mat.excluded.has(p) || !materializedFor(it, [p])) return null;
  if (classOf(it, p) !== 'LIVE' || !pathIsText(core, p) || pathIsFiltered(core, p)) return null;
  if (core.holds.byPath(p).some((r) => carries(r, 'eol-bom'))) return null;   // DAT-08: never a path held under eol-bom
  return { raw: raw.oid, disk: disk.oid, mode: disk.mode };
}

/**
 * Paths whose DAT-08 repair condition holds — two unchanged detection ticks after the materialization that showed
 * S_raw[p] ≠ S_disk[p] (R3-34) — and whose write waits for an iteration that materializes them; iterate() puts the set into
 * the next iteration's PrepareOptions.holdPaths. A pure read of this module's per-core state.
 */
export function repairDue(core: EngineCore): ReadonlySet<string> {
  const out = new Set<string>();
  for (const [p, e] of memory.get(core)?.repair ?? []) if (e.quiet >= REPAIR_QUIET_TICKS) out.add(p);
  return out;
}

/**
 * DAT-08 per R3-34 at a detection tick. (1) Every running episode counts this tick as quiet when p's stat-cache entry is still
 * the episode's (clean, same lstat, detection id = its S_raw id) and the tick neither changed, dirtied nor excluded p; any
 * other tick ends the episode (a new one can start at a later materialization). (2) A materialization of p starts an episode
 * for every candidate: a LIVE, text, unfiltered path with S_raw[p] ≠ S_disk[p], not canon-refused, not a materialize-time
 * exclusion and not under a non-terminal `eol-bom` record — or keeps the running one when p's key is unchanged; a materialized
 * path that is no candidate any more ends its episode. (3) A due path (REPAIR_QUIET_TICKS quiet ticks) is written only in an
 * iteration that materialized it, never while a FREEZE reason is set, a push intent is kept or a restore is stranded (it stays
 * due, R3-23): writeLocal(p, S_raw[p], S_disk[p], 'repair:<p>'). On WRITTEN: core.observed.record(p, S_disk[p]) (R3-36), the
 * private-index entry := S_disk[p] (Snapshotter.setEntry: writeLocal leaves the private index alone), after which the observed entry
 * is forgotten (final review F1: the write is never a materialized delta, so nothing would consume it) and, when one lstat on
 * each side of a DISK_EQ(p, S_disk[p]) agree, Snapshotter.markClean(p, lstat, S_disk[p]) — so the repaired file is never read or
 * hashed again while it stays idle, and an edit that lands between the writer's round trip and that check is still seen by the
 * next tick; no snap transition (state:snap already holds S_disk[p]); trace `repair {path, from: S_raw, to: S_disk}` and
 * EOL_REPAIRED {path, bom, eol} (the stored form: form(A[p]), else form(S_disk[p])) to the daemon log only, once per episode
 * (R-27; core.holdCode untouched). MISMATCH (the disk is not S_raw[p] any more), COLLISION or PHANTOM end the episode with no
 * trace and no log; LOCKED, FROZEN and DEFERRED keep p due. Returns the repaired paths. A KilledAt (crashpoint) propagates.
 */
export async function repairStep(core: EngineCore, it: IterationCtx): Promise<string[]> {
  const repaired: string[] = [];
  const tick = it.tick;
  if (tick === null) return repaired;
  const mem = memoryOf(core);

  for (const [p, e] of [...mem.repair]) {
    if (e.since === it) continue;
    const ce = core.statCache.get(p);
    const same = ce !== undefined && ce.state === 'clean' && ce.stat !== null && sameStat(ce.stat, e.stat) && ce.id === e.sRaw
      && ce.missingSinceMono === undefined && ce.shrink === undefined;
    if (same && !tick.changed.has(p) && !tick.dirty.has(p) && !tick.excluded.has(p)) e.quiet += 1;
    else mem.repair.delete(p);
  }

  const mat = it.mat;
  if (mat !== null && mat.sRaw !== mat.sDisk) {
    for (const p of mat.sRawMap.keys()) {
      const c = candidate(core, it, mat, p);
      if (c === null) continue;
      const ce = core.statCache.get(p);
      if (ce === undefined || ce.state !== 'clean' || ce.stat === null || ce.id !== c.raw) continue;   // no key: no episode
      const had = mem.repair.get(p);
      if (had !== undefined && had.sRaw === c.raw && sameStat(had.stat, ce.stat)) {
        had.sDisk = c.disk;
        had.mode = c.mode;
        continue;
      }
      mem.repair.set(p, { stat: ce.stat, sRaw: c.raw, sDisk: c.disk, mode: c.mode, quiet: 0, since: it });
    }
  }
  if (mat !== null) {
    for (const p of [...mem.repair.keys()]) if (materializedFor(it, [p]) && candidate(core, it, mat, p) === null) mem.repair.delete(p);
  }

  if (mat === null || frozen(core, it) || postponedBy(core) !== null) return repaired;
  for (const [p, e] of [...mem.repair]) {
    if (e.quiet < REPAIR_QUIET_TICKS || !materializedFor(it, [p])) continue;
    const res = await core.writer.writeLocal(p, e.sRaw, e.sDisk, `repair:${p}`);
    if (res.kind === 'MISMATCH' || res.kind === 'COLLISION' || res.kind === 'PHANTOM') {
      mem.repair.delete(p);
      continue;
    }
    if (res.kind !== 'WRITTEN') continue;
    mem.repair.delete(p);
    core.observed.record(p, e.sDisk);
    const entry = { path: p, mode: e.mode, oid: e.sDisk };
    await core.snapshot.setEntry(p, entry);
    core.observed.forget(p);   // final review F1: the private index holds the write, which is never a materialized delta now
    const abs = join(core.deps.paths.workTree, ...p.split('/'));
    const fs = core.deps.ports.fs;
    const st1 = await fs.lstat(abs);
    const eq = await core.diskEq.eq(p, entry, null);
    const st2 = await fs.lstat(abs);
    if (eq.equal && st1 !== null && st2 !== null && sameStat(st1, st2)) core.snapshot.markClean(p, st2, e.sDisk);
    core.deps.trace.emit({ kind: 'repair', peer: core.peerId, path: p, from: e.sRaw, to: e.sDisk });
    const stored = form(await core.repo.readBlob(it.A.get(p)?.oid ?? e.sDisk));
    core.deps.log.write('info', 'EOL_REPAIRED', { path: p, bom: stored.bom, eol: stored.eol });
    repaired.push(p);
  }
  return repaired;
}

// ---- portability (DAT-32, DAT-33; R3-35, R3-53) -------------------------------------------------------------------------

/** p's lstat size when something other than a directory is at p ('absent' otherwise); 'unknown' when the lstat fails. */
async function sizeOf(core: EngineCore, p: string): Promise<number | 'absent' | 'unknown'> {
  try {
    const st = await core.deps.ports.fs.lstat(join(core.deps.paths.workTree, ...p.split('/')));
    return st !== null && !st.isDirectory ? st.size : 'absent';
  } catch {
    return 'unknown';
  }
}

/**
 * DAT-33 publish side at a detection tick, over the tick's NOT_ADMITTED `portability` paths. D7 is portable(p, others) with
 * others = A's paths and the last materialized S_raw's (the live set as the snapshot knows it) minus this tick's removals,
 * plus the tick's other new paths (dirty `new` entries and the other not-admitted names); a name the snapshot refused that D7
 * passes against these others is a rule-4 collision with a path only the snapshot knew (rule 2 for a name that is not
 * stageable: D7 cannot name its cause).
 *  - A stageable() path with no non-terminal `portability` record and an lstat size within the new-file cap
 *    (config.sync.maxNewFileBytes, 03-data §3.6; D6 checks D7 (2.6) before the cap (2.7), so the snapshot never applied it): the
 *    file is read through stagedRead into StageDir and hashed by route (b) -w in DAT-07's new-path form (holdOps.ts's
 *    captureDisk with hashNewPath; an unstable read creates nothing this tick), and one ON_DISK ACTIVE PATCH `portability` is
 *    born: h0 ABSENT, h1 the staged copy's blob, origin 'human', cs_ids [] — the registry makes it local_only (the name is not
 *    LIVE, R3-12), so its mirror is the content-free stub (R3-24); the path joins the open human CS (cs.observe, R3-35: the one
 *    exception to the LIVE-only observe rule) and PATH_NOT_PORTABLE {id, path, rule} goes to status and the log. The path's
 *    attributes are deliberately not requested first: D5 would class a new path LIVE, and only the registry's fail-closed
 *    reading of an unclassifiable path (R3-71) gives the record the local_only D6 rule 2.6 implies. A path that already has
 *    such a record is not looked at again (one record per path, HLD-07; the later bytes stay on the author's disk).
 *  - A path that is not stageable() (R3-53: invalid SEC-35 syntax, U+FFFD, a dotgit-alias component), or a stageable one over
 *    the new-file cap (Task 7 fix round 1: its bytes are never read or stored, as for any new file over the cap): no read, no
 *    record, no CS membership; PATH_NOT_PORTABLE {path, rule} (no id) once per episode — the episode lasts while the tick keeps
 *    flagging the path — and the path in `unrecorded` (Task 10's readiness gate withholds the human CS, DAT-32).
 * A non-terminal ON_DISK record carrying `portability` (final review r2 A-3: never an OFF_DISK one, whose name is off the disk because
 * it was displaced) whose paths the tick neither flags nor excludes is released when D7 passes for
 * every path — the snapshot admitted it this tick (a dirty `new` entry) or portable(p, others) passes (the colliding path
 * left): its guard is released (R3-17 keeps the guard-less record ACTIVE until SUBSUMED); a name the tick merely stopped
 * listing (ignored, skipped) that D7 still fails keeps its guard. A record whose name left the disk ends GONE (renamed or
 * deleted, I-DAT-09). Both in `released`; an lstat error means no decision this tick. Plan 3 Task EF: a tick that ends such a record
 * latches R3-53's gate (ChangeSets.latchGate) on the human CSs open with paths, so the change-set the record's dependency PIN held
 * back publishes with the fixed name's capture in one commit (DAT-32), as in the not-stageable case.
 */
export async function portabilityStep(core: EngineCore, it: IterationCtx): Promise<{ created: string[]; released: string[]; unrecorded: string[] }> {
  const created: string[] = [];
  const released: string[] = [];
  const unrecorded: string[] = [];
  const tick = it.tick;
  if (tick === null) return { created, released, unrecorded };
  const mem = memoryOf(core);
  const reg = core.holds;
  const flagged = new Set<string>();
  for (const [p, why] of tick.notAdmitted) if (why === 'portability') flagged.add(p);

  // D7 against the live set, built once and only when needed (p itself among the others never collides with p).
  let others: Set<string> | null = null;
  const d7 = (p: string): ReturnType<typeof portable> => {
    if (others === null) {
      const removed = (q: string): boolean => tick.dirty.get(q)?.kind === 'remove';
      others = new Set<string>([...it.A.keys(), ...(core.snapshot.last()?.sRawMap.keys() ?? [])].filter((q) => !removed(q)));
      for (const [q, de] of tick.dirty) if (de.kind === 'new') others.add(q);
      for (const q of tick.notAdmitted.keys()) others.add(q);
    }
    return portable(p, others);
  };
  const ruleOf = (p: string): number => {
    const r = d7(p);
    return r.ok ? (stageable(p) ? 4 : 2) : r.rule;
  };
  /** A record-less non-portable path: listed in `unrecorded`, PATH_NOT_PORTABLE {path, rule} once per episode. */
  const unrecordable = (p: string): void => {
    unrecorded.push(p);
    if (mem.announced.has(p)) return;
    mem.announced.add(p);
    raise(core, 'PATH_NOT_PORTABLE', { path: p, rule: ruleOf(p) }, 'warn');
  };

  for (const r of reg.nonTerminal()) {
    // Final review r2 A-3 (defence in depth): only an ON_DISK record's name tells anything here — an OFF_DISK record's name is off the
    // disk because it was displaced, not renamed or deleted, and its bytes live in the record alone (INV-NOLOSS).
    if (!carries(r, 'portability') || r.residence !== 'ON_DISK' || r.guards.some(isUnknownGuard) || r.paths.length === 0) continue;
    if (r.paths.some((p) => flagged.has(p) || tick.excluded.has(p))) continue;
    const seen = await Promise.all(r.paths.map((p) => sizeOf(core, p)));
    if (seen.includes('unknown')) continue;
    if (seen.every((s) => typeof s === 'number')) {
      if (!r.paths.every((p) => tick.dirty.get(p)?.kind === 'new' || d7(p).ok)) continue;   // D7 still fails: keep the guard
      await reg.releaseGuard(r.id, r.guards.find((g) => guardName(g) === 'portability')!.name);
    } else {
      await reg.transition(r.id, { state: 'GONE' });
    }
    released.push(r.id);
  }

  const cap = core.config.sync.maxNewFileBytes;
  for (const p of [...flagged].sort()) {
    if (!stageable(p)) {
      unrecordable(p);
      continue;
    }
    if (reg.byPath(p).some((r) => carries(r, 'portability'))) continue;
    const size = await sizeOf(core, p);
    if (typeof size !== 'number') continue;   // gone or unknown: nothing this tick
    if (size > cap) {
      unrecordable(p);   // never read or stored: the new-file cap the snapshot would have applied after D7
      continue;
    }
    const cap1 = await captureDisk(core, p, hashNewPath);
    if (cap1.kind !== 'ok') continue;   // missing, unreadable, unstable, or the clean filter refused: nothing this tick
    const id = await reg.hold({
      kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: [p], blobs: { h0: one(p, ABSENT), h1: one(p, cap1.oid) },
      guard: 'portability', origin: 'human', cs_ids: [], displaced_by: null,
    });
    created.push(id);
    mem.announced.delete(p);
    core.cs.observe([p]);
    raise(core, 'PATH_NOT_PORTABLE', { id, path: p, rule: ruleOf(p) }, 'warn');
  }
  for (const p of [...mem.announced]) if (!flagged.has(p)) mem.announced.delete(p);
  // Plan 3 Task EF (DAT-32, R3-53's latch): a record ended now (renamed, deleted or admitted) latches the gate on the human CSs open
  // with paths — the one this tick opened with the fixed name — so the change-set its dependency PIN held back publishes with it.
  if (released.length > 0) core.cs.latchGate();
  // R3-53 (Task 10): the readiness gate — while a not-stageable non-portable name exists, every group holding a human or
  // recovered CS waits (DAT-32). Recomputed from each tick's notAdmitted; a rename or deletion empties it at the next tick.
  core.cs.blockPaths(new Set(unrecorded));
  return { created, released, unrecorded };
}

// ---- churn guard (DAT-39) -----------------------------------------------------------------------------------------------

/**
 * A first observation's prev for a path this iteration materialized (its private-index entry already holds the new bytes):
 * the previous materialization's S_raw entry, else A's; null when neither has p.
 */
async function blobBefore(core: EngineCore, before: Materialized | null, it: IterationCtx, p: string): Promise<Buffer | null> {
  const e: TreeEntry | undefined = before?.sRawMap.get(p) ?? it.A.get(p);
  return e === undefined ? null : core.repo.readBlob(e.oid);
}

/**
 * DAT-39 at a detection tick. Every LIVE path the tick changed with a `modify` dirty entry is one observation, unless a
 * non-terminal record over p already carries `generated?` (any argument, `generated?:exclude` included): such a path is not
 * read or diffed and has no history until the record ends (F-DAT-04 "one record"; the controller's cost ruling) — nor ever again
 * once p is in local().keepSyncing (the human's "keep syncing" answer, `--publish` on the record; Task 11, contract addition 1).
 *  - next = the tick's stage copy; when this iteration materialized p (Snapshotter.materialize removed the copy), the
 *    materialized S_raw blob — so a materialization never resets a chain; a copy that is gone with no materialization of p
 *    leaves the history as it is, like an excluded path.
 *  - prev = the previous observation (kept until the history clears) or, at the first one, the private-index blob — when this
 *    iteration materialized p, the private-index entry it had before (blobBefore: the previous materialization's S_raw entry,
 *    else A's).
 *  - hookAttributed(p) (false for every human delta before Plan 5, R3-35); binary when either side has a NUL in its first
 *    8,000 bytes (its ratio is not computed and recorded as 0: the verdict counts it by its flag); otherwise rewrittenRatio,
 *    whose cost is bounded (src/data/churn.ts: the common rows are trimmed first and the caps bound only the rows between
 *    them, so prev is kept whatever its size).
 * A path the tick did not change, or changed by a `new` or `remove` entry, loses its history (the snapshots must be
 * consecutive); a path the tick excluded (quiet, unstable, …) keeps it unchanged. When churnVerdict says 'generated?', p becomes
 * one ON_DISK ACTIVE PATCH `generated?` (h0 = A[p], h1 = the stage copy by route (b) -w — the only object the guard writes,
 * W6 (c) — or, when this iteration materialized p, its S_raw blob, already written by the materialization; HLD-07 may attach
 * the guard to an existing record), origin 'human', and GENERATED_SUSPECT {id, path, excludeLine} goes to status and the log;
 * `created` lists the record ids. A `generated?` record whose every path this iteration's scope reports UNMANAGED ends
 * SUBSUMED (`released`; reachable once Plan 7 changes EPOCH_BASE, R3-08). Runs only on an iteration with a tick.
 */
export async function churnStep(core: EngineCore, it: IterationCtx): Promise<{ created: string[]; released: string[] }> {
  const created: string[] = [];
  const released: string[] = [];
  const tick = it.tick;
  if (tick === null) return { created, released };
  const mem = memoryOf(core);
  const before = mem.lastMat !== it.mat ? mem.lastMat : null;
  mem.lastMat = core.snapshot.last();

  for (const r of core.holds.nonTerminal()) {
    if (!carries(r, 'generated?') || r.guards.some(isUnknownGuard) || r.paths.length === 0) continue;
    if (!r.paths.every((p) => classOf(it, p) === 'UNMANAGED')) continue;
    await core.holds.transition(r.id, { state: 'SUBSUMED' });
    released.push(r.id);
  }

  // Consecutive snapshots: a history ends at a tick that did not change its path (or changed it into a new path or a removal),
  // and survives a tick that excluded the path (the path was not looked at).
  for (const p of [...mem.churn.keys()]) {
    if (tick.excluded.has(p)) continue;
    if (!tick.changed.has(p) || tick.dirty.get(p)?.kind !== 'modify') mem.churn.delete(p);
  }

  const keepSyncing = new Set(core.holds.local().keepSyncing);
  for (const p of [...tick.changed].sort()) {
    if (tick.dirty.get(p)?.kind !== 'modify' || tick.excluded.has(p)) continue;
    if (classOf(it, p) !== 'LIVE' || keepSyncing.has(p) || core.holds.byPath(p).some((r) => carries(r, 'generated?'))) {
      // not LIVE, a generated? record already holds p (not again while it is non-terminal), or the human answered "keep syncing"
      // for p (--publish, local.keepSyncing: never asked again, Task 11)
      mem.churn.delete(p);
      continue;
    }
    const mat = materializedFor(it, [p]) ? it.mat?.sRawMap.get(p) : undefined;
    const next = mat !== undefined ? await core.repo.readBlob(mat.oid) : await readStageCopy(core, p);
    if (next === null) continue;   // the copy is gone and nothing materialized p: the history stays as it is
    const had = mem.churn.get(p);
    let prev: Buffer;
    let prevBinary: boolean;
    if (had !== undefined) {
      prev = had.prev;
      prevBinary = had.prevBinary;
    } else {
      prev = (mat !== undefined ? await blobBefore(core, before, it, p) : await privateBlob(core, p)) ?? Buffer.alloc(0);
      prevBinary = isBinaryBytes(prev);
    }
    const binary = isBinaryBytes(next) || prevBinary;
    // A binary observation's share is not computed (0): churnVerdict counts it by its flag ("or the path is binary").
    const ratio = binary ? 0 : rewrittenRatio(prev, next);
    const o: ChurnObservation = { attributed: core.deps.attribution.hookAttributed(p), rewrittenRatio: ratio, binary };
    const obs = [...(had?.obs ?? []), o].slice(-CHURN_SNAPSHOTS);
    mem.churn.set(p, { obs, prev: next, prevBinary: isBinaryBytes(next) });
    if (churnVerdict(obs) !== 'generated?') continue;
    let h1: Oid;
    if (mat !== undefined) {
      h1 = mat.oid;
    } else {
      const h = await hashRouteB(core.repo, p, core.stage.abs(p), true);
      if (isFilterFailure(h)) continue;   // the clean filter refused the copy: nothing stored, the next qualifying tick retries
      h1 = h;
    }
    const id = await core.holds.hold({
      kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: [p], blobs: { h0: one(p, it.A.get(p)?.oid ?? ABSENT), h1: one(p, h1) },
      guard: 'generated?', origin: 'human', cs_ids: [], displaced_by: null,
    });
    mem.churn.delete(p);
    created.push(id);
    raise(core, 'GENERATED_SUSPECT', { id, path: p, excludeLine: JSON.stringify(p) }, 'warn');
  }
  return { created, released };
}
