// The per-iteration hold steps (Plan 3 Task 12a; 01-engine §3.5 rows D, M, R, T, ENG-14, ENG-28; 05-holds HLD-08 placement,
// HLD-20…HLD-24, HLD-31, HLD-43; rulings R3-19, R3-20, R3-46, R3-53, R3-56, R3-57, R3-61, R3-62; contract additions 4, 6–8):
//
//   detectStep        step D: the transient clocks of the tick's publish-side exclusions, breakerTick, then repairStep,
//                     portabilityStep and churnStep on every iteration with a tick (Task 7's calling rule); on a materialization:
//                     massResumeStep, then revertStep, then R-07's eol-bom creation on a canon refusal (its one site, moved here
//                     from Plan 2's loop) — all before maskStep, captureStep and any merge (ENG-14, contract addition 6)
//   maskStep          step M, materializing iterations only: S_pub := maskEntries(S_disk) kept in EngineCore.sPub, assertSPub
//                     (R3-20; a failure sets EngineCore.maskInvalid until the next passing assertSPub, R3-57), the held ranges
//                     (HLD-21), one `mask` trace per materialization with the registry head maskEntries read; its `conflicted` ids
//                     go to recordStep's evaluateRecords (HLD-15) — S_pub is never recomputed between materializations (R3-62)
//   recordStep        step R after the writes, the only R1 call site in the loop (HLD-08): evaluateRecords, then the PREDICATE
//                     guards — the R-07 eol-bom release (moved here), markers, claim (PublishGatePort.claimStillBlocks), the
//                     dependency guards (releaseDependencyGuards, its one call site) — and incomingStep for the transient and
//                     receive-side guards (contract addition 7); then (Task 17) the revert shrink marks of CSs no longer pending end
//   timerStep         timers T: the recovered CS's 20 s quiet timer (ChangeSets' own clock, read by captureDue at the next
//                     prepareIteration), CS_UNPUBLISHED_NUDGE and CS_GROUP_WAITING to status and the daemon log (R-27); Task 12b adds
//                     escalationStep and s6Step (contract addition 8)
//   holdStatusInputs  HLD-24 status inputs (R3-46): the counts, not_converged = Plan 2's entries extended by Plan 3's, diverged, and
//                     the newest hold code
//
// Per-core memory (the iteration's MaskResult, the failing assertSPub clause, the nudge and group-waiting episodes) lives in
// module-level WeakMaps, so no EngineCore member beyond the contract's (sPub, ranges, maskInvalid) is added; it restarts with every
// core (a daemon start), as every Plan 3 timer does (R3-30).
import type { Json } from '../board/canonicalJson.js';
import { hasRestoreMarkerRow } from '../data/rows.js';
import type { PortRule } from '../data/scope.js';
import { ABSENT, type OidOrAbsent } from '../git/oid.js';
import { heldPins, humanCsN, seatOfCs } from '../holds/changesets.js';
import { incomingCsOf, incomingStep, seeTransient, TRANSIENT_RECORD_MS, transientAges, type IncomingInputs, type NotApplicableReason } from '../holds/incoming.js';
import { assertSPub, heldRanges, maskEntries, type MaskResult } from '../holds/mask.js';
import { HoldOperatorError } from '../holds/rebase.js';
import { guardName, isTerminal, isUnknownGuard, type HoldRecord } from '../holds/record.js';
import { endRevertMarks } from '../holds/revertCs.js';
import type { ApplyReport } from './apply.js';
import {
  caseFoldingDisk, currentA, ensureAttrs, markBatchFormed, materializedFor, NOT_APPLICABLE_REASONS, notApplicableBlocked, notApplicableRuleOf, raiseHoldCodes, type EngineCore,
  type IterationCtx,
} from './core.js';
import { breakerTick, revertStep } from './detect.js';
import { churnStep, portabilityStep, repairStep } from './dataRecords.js';
import { escalationStep, s6Step } from './escalation.js';
import { evaluateRecords, withdrawMarkerPairs } from './holdOps.js';
import { boardFullOpen, maskInputsOf, maskOptions, raiseMaskInvalid, releaseDependencyGuards } from './publish.js';
import { massResumeStep } from './resume.js';
import type { Materialized } from './snapshot.js';
import type { NotConvergedWhy, StatusInputs } from './status.js';
import { diffPaths, sameTreeEntry } from './treeDiff.js';

/** HLD-43: an open seat CS's oldest uncovered file effect is nudged once after this long (glossary §20). */
export const CS_NUDGE_AFTER_MS = 300_000;
/** HLD-43: a group with a ready member unpublished this long gets CS_GROUP_WAITING once per episode (glossary §20). */
export const CS_GROUP_WAITING_MS = 600_000;

/** meta.pending reasons of not-applicable paths (R-05): not_applicable in not_converged, with the guard of 01-engine §2. */
const NOT_APPLICABLE_GUARD: Readonly<Record<string, string>> = { collision: 'collision', unmaterializable: 'unmaterializable', quarantine: 'quarantine-review' };
/** INCOMING guards of a not-applicable path (HLD-53): listed as not_applicable; the closure guards as deferred. */
const NOT_APPLICABLE_GUARDS: ReadonlySet<string> = new Set(['collision', 'unmaterializable', 'quarantine-review']);

interface Memory {
  /** The MaskResult maskStep computed in an iteration (recordStep reads that iteration's conflicted ids only). */
  readonly masked: WeakMap<IterationCtx, MaskResult>;
  /** The failing assertSPub clause while EngineCore.maskInvalid holds (its path is listed in not_converged as publish_assert). */
  maskFailure: { clause: string; path: string } | null;
  /** HLD-43: open seat CS id → Δmono of its oldest uncovered file effect; and the CSs already nudged (once per CS). */
  readonly uncovered: Map<string, number>;
  readonly nudged: Set<string>;
  /** HLD-43: group key → the episode (first Δmono with a ready member unpublished; told once). */
  readonly groups: Map<string, { since: number; told: boolean }>;
  /** Task 12b fix round 1: the full not_converged causes of the last status write (settleHoldCode); null before the first. */
  settled: ReadonlyMap<string, NotConvergedWhy> | null;
}

const memories = new WeakMap<EngineCore, Memory>();

function memoryOf(core: EngineCore): Memory {
  let m = memories.get(core);
  if (m === undefined) {
    m = { masked: new WeakMap(), maskFailure: null, uncovered: new Map(), nudged: new Set(), groups: new Map(), settled: null };
    memories.set(core, m);
  }
  return m;
}

/**
 * HLD-32's publish-side exclusions of a tick as IncomingInputs.transient: `unreadable` (an open or read error), and `unstable` for every
 * stability predicate that keeps the bytes unsettled (unstable, the quiet period, the shrink guard, a pending deletion); a filter
 * failure is not transient (its record is the `filter-failure` DECISION, Plan 7). The one definition (Task 6's test helper uses it).
 */
export function transientOf(excluded: ReadonlyMap<string, string>): Map<string, 'unreadable' | 'unstable'> {
  const out = new Map<string, 'unreadable' | 'unstable'>();
  for (const [p, e] of excluded) {
    if (e === 'filter_failure') continue;
    out.set(p, e === 'unreadable' ? 'unreadable' : 'unstable');
  }
  return out;
}

// ---- D --------------------------------------------------------------------------------------------------------------

/**
 * Step 3 D (contract addition 6): on every iteration with a detection tick — the transient clocks of its publish-side exclusions
 * (seeTransient), breakerTick on its dirty set (a trip enters FREEZE(MASS) in the same call), repairStep, portabilityStep and
 * churnStep (Task 7's calling rule); on a materialization (it.mat non-null) — massResumeStep (the post-resume MASS batch, HLD-31),
 * then revertStep (the revert detector on the newly materialized S_disk, before any merge or capture, ENG-14), then R-07's eol-bom
 * creation. `records` = every record this step created or attached to; `mass` = the breaker tripped now.
 */
export async function detectStep(core: EngineCore, it: IterationCtx): Promise<{ records: string[]; mass: boolean }> {
  const records: string[] = [];
  let mass = false;
  const tick = it.tick;
  if (tick !== null) {
    seeTransient(core.transient, transientOf(tick.excluded));
    mass = (await breakerTick(core, it)) !== null;
    await repairStep(core, it);
    records.push(...(await portabilityStep(core, it)).created);
    records.push(...(await churnStep(core, it)).created);
  }
  const mat = it.mat;
  if (mat !== null) {
    const residue = await massResumeStep(core, it);
    if (residue !== null) {
      // HLD-31: nothing publishes code in the iteration that formed the post-resume batch (codeWithheldWhy).
      markBatchFormed(it);
      records.push(...residue);
    }
    records.push(...(await revertStep(core, it)));
    records.push(...(await eolBomCreate(core, it, mat)));
  }
  return { records: [...new Set(records)], mass };
}

/**
 * R-07, creation half (moved here from Plan 2's loop, its one site): a canon REFUSE(eol-bom) on a LIVE path of the materialized
 * snapshot holds it in one ON_DISK PATCH with the whole-path guard `eol-bom` (masked, DAT-06); a newer refused version updates its h1.
 * The release half is recordStep's. Returns the ids created or updated.
 */
export async function eolBomCreate(core: EngineCore, it: IterationCtx, mat: Materialized): Promise<string[]> {
  const out: string[] = [];
  const records = eolBomRecords(core);
  const refused = [...mat.canonRefused];
  if (refused.length === 0) return out;
  await ensureAttrs(core, it.epochBase, refused);
  for (const p of refused) {
    if (it.scope(p).cls !== 'LIVE') continue;
    const blobs = { h0: { [p]: it.A.get(p)?.oid ?? ABSENT }, h1: { [p]: mat.sRawMap.get(p)?.oid ?? ABSENT } };
    const existing = records.find((r) => r.paths[0] === p);
    if (existing === undefined) {
      const id = await core.holds.hold({ kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: [p], blobs, guard: 'eol-bom', origin: 'daemon', cs_ids: [], displaced_by: null, local_only: false });
      core.deps.log.write('warn', 'EOL_BOM_HELD', { path: p, hold_id: id });
      out.push(id);
    } else if ('h1' in existing.blobs && existing.blobs.h1[p] !== blobs.h1[p]) {
      await core.holds.transition(existing.id, { blobs });
      out.push(existing.id);
    }
  }
  return out;
}

/** The non-terminal single-path PATCHes carrying `eol-bom` (R-07's records). */
function eolBomRecords(core: EngineCore): HoldRecord[] {
  return core.holds.nonTerminal().filter((r) => r.kind === 'PATCH' && r.paths.length === 1 && r.guards.some((g) => guardName(g) === 'eol-bom'));
}

// ---- M --------------------------------------------------------------------------------------------------------------

/**
 * Step 4 M, materializing iterations only (it.mat null: nothing runs and S_pub stays the MASK of the last materialized S_disk, 05 §3.4,
 * R3-19): S_pub := maskEntries(S_disk) over the registry's masking records, kept in EngineCore.sPub with its held ranges in
 * EngineCore.ranges (HLD-21); assertSPub (HLD-19, R3-20); one `mask` trace (registry = the registry head maskEntries read). The
 * conflicted ids stay with this iteration for recordStep's evaluateRecords (HLD-15). A MASK that cannot run (a corrupt or missing record
 * blob, 05 F1) or a failing assertSPub raises HOLD_MASK_INVALID and sets EngineCore.maskInvalid, which only the next passing
 * assertSPub clears (R3-57): no code publish meanwhile, S_disk never the fallback. Returns whether S_pub is valid.
 */
export async function maskStep(core: EngineCore, it: IterationCtx): Promise<boolean> {
  const mat = it.mat;
  if (mat === null) return !core.maskInvalid;
  const mem = memoryOf(core);
  const records = core.holds.maskingRecords();
  await ensureAttrs(core, it.epochBase, [...diffPaths(it.A, mat.sDiskMap), ...records.flatMap((r) => r.paths)]);
  const inp = maskInputsOf(core, it, records);
  const registry = core.holds.head();
  const fail = (failure: { clause: string; path: string }, params: Record<string, string>): boolean => {
    core.maskInvalid = true;
    mem.maskFailure = failure;
    raiseMaskInvalid(core, params);
    return false;
  };
  let m: MaskResult;
  try {
    m = await maskEntries(core.repo, mat.sDiskMap, inp, core.rebase, maskOptions(core));
  } catch (e) {
    if (!(e instanceof HoldOperatorError)) throw e;
    return fail({ clause: e.op, path: e.path }, { op: e.op, path: e.path, hold_id: e.holdId });
  }
  core.sPub = m;
  mem.masked.set(it, m);
  const { aTree } = await currentA(core);
  core.deps.trace.emit({
    kind: 'mask', peer: core.peerId, sDisk: mat.sDisk, aTree, registry,
    partial: [...m.partial].sort(), withheld: [...m.withheld].sort(), conflicted: [...m.conflicted],
  });
  let ok = true;
  try {
    core.ranges = await heldRanges(core.repo, mat.sDiskMap, m);
    const a = await assertSPub(core.repo, mat.sDiskMap, m, inp, core.rebase);
    if (!a.ok) ok = fail({ clause: a.clause, path: a.path }, { clause: a.clause, path: a.path });
  } catch (e) {
    if (!(e instanceof HoldOperatorError)) throw e;
    ok = fail({ clause: e.op, path: e.path }, { op: e.op, path: e.path, hold_id: e.holdId });
  }
  if (ok) {
    core.maskInvalid = false;
    mem.maskFailure = null;
  }
  return ok;
}

/** The MaskResult this iteration's maskStep computed (null when it did not run, or MASK could not run). */
export function maskOf(core: EngineCore, it: IterationCtx): MaskResult | null {
  return memoryOf(core).masked.get(it) ?? null;
}

// ---- R --------------------------------------------------------------------------------------------------------------

/**
 * Step 5 R after the writes, the loop's only R1 call site (HLD-08 placement): evaluateRecords(apply.changedA, the `conflicted` ids of
 * this iteration's maskStep), then the PREDICATE guards in order (contract addition 7):
 *  - eol-bom (R-07's release half, moved here): on a materialized snapshot in which the path passes canon and is no exclusion, the guard
 *    is dropped and the record ends GONE (the refused bytes left the disk);
 *  - markers: released when no path's S_disk blob of this materialization has a restore-marker row (DAT-46 rows of cowork: labels);
 *  - claim: released when EngineDeps.gate.claimStillBlocks(r) answers false (openGate answers true: never released before Plan 4);
 *  - dependency:<id>: releaseDependencyGuards (Task 10), its one call site (publishStep no longer calls it);
 *  - lock, eol-form, local-only-conflict, unmaterializable, collision, quarantine-review, unreadable, unstable: incomingStep (Task 6)
 *    over this apply's closures and not-applicable paths and the tick's transient exclusions, its codes raised to status and the log.
 * Last (Plan 3 Task 17, decision D2): the revert shrink mark of a revert CS no longer pending ends (endRevertMarks: its naming record
 * turned terminal, or its pair left journal/ready/ with no record naming it).
 * t0 stays with publishStep's T0 slot. No re-MASK: S_pub, EngineCore.ranges and the `mask` event change only at the next maskStep
 * (R3-62).
 */
export async function recordStep(core: EngineCore, it: IterationCtx, apply: ApplyReport): Promise<void> {
  const mem = memoryOf(core);
  await evaluateRecords(core, it, new Set(apply.changedA), mem.masked.get(it)?.conflicted ?? []);
  const mat = it.mat;
  if (mat !== null) {
    await eolBomRelease(core, it, mat);
    await markersRelease(core, it, mat);
  }
  await claimRelease(core);
  await releaseDependencyGuards(core, it);
  const r = await incomingStep(core.holds, core.transient, await incomingInputsOf(core, it, apply));
  raiseHoldCodes(core, r.codes);
  // Task 17 (rev 2.5, decision D2): the shrink mark of a revert CS whose naming record turned terminal (R1 above, a --discard since) or
  // whose pair this apply cancelled with no record naming it ends (05 Algorithm REV step 8, glossary §29.1).
  endRevertMarks(core);
}

/** R-07's release half: a materialized snapshot in which p passes canon (and is no exclusion) ends the eol-bom record GONE, guard dropped. */
async function eolBomRelease(core: EngineCore, it: IterationCtx, mat: Materialized): Promise<void> {
  const unsettled = new Set([...(it.tick?.excluded.keys() ?? []), ...mat.excluded.keys()]);
  for (const r of eolBomRecords(core)) {
    const p = r.paths[0]!;
    if (mat.canonRefused.has(p) || unsettled.has(p) || !materializedFor(it, [p])) continue;
    await core.holds.transition(r.id, { guards: [], state: 'GONE', residence: null });
    core.deps.log.write('info', 'EOL_BOM_RELEASED', { path: p, hold_id: r.id, state: 'GONE' });
  }
}

/**
 * The `markers` PREDICATE: no path's last materialized S_disk blob has a restore-marker row (the human removed the rows). EF4 round 2
 * I2-3 (ruling R3-EF4-20): before the release, every ready pair whose R holds a restore-marker row at the record's paths is withdrawn
 * silently with its group and re-captured from the disk (withdrawMarkerPairs) — it can never pass ENG-41 (k); under a kept push intent
 * both wait for a materializing iteration after the intent's resolution (this predicate runs only on a materialization).
 */
async function markersRelease(core: EngineCore, it: IterationCtx, mat: Materialized): Promise<void> {
  for (const r of core.holds.nonTerminal()) {
    if (r.residence !== 'ON_DISK' || r.guards.some(isUnknownGuard) || !r.guards.some((g) => guardName(g) === 'markers')) continue;
    if (!materializedFor(it, r.paths)) continue;
    let rows = false;
    for (const p of r.paths) {
      const e = mat.sDiskMap.get(p);
      if (e !== undefined && (e.mode === '100644' || e.mode === '100755') && hasRestoreMarkerRow(await core.repo.readBlob(e.oid))) {
        rows = true;
        break;
      }
    }
    if (rows) continue;
    if ((await withdrawMarkerPairs(core, r.paths)) === 'postponed') continue;
    for (const g of r.guards) if (guardName(g) === 'markers') await core.holds.releaseGuard(r.id, g.name);
  }
}

/** The `claim` PREDICATE: each claim guard whose record PublishGatePort.claimStillBlocks answers false for is released (HLD-52). */
async function claimRelease(core: EngineCore): Promise<void> {
  for (const r of core.holds.nonTerminal()) {
    if (r.guards.some(isUnknownGuard)) continue;
    const claims = r.guards.filter((g) => guardName(g) === 'claim');
    if (claims.length === 0 || (await core.deps.gate.claimStillBlocks(r))) continue;
    for (const g of claims) await core.holds.releaseGuard(r.id, g.name);
  }
}

/**
 * IncomingInputs of this iteration (Task 6's shape): A after the apply, TIP, the apply's closures, not-applicable paths, their D7
 * rules and incoming CSs, the tick's transient exclusions and, only when there is one, the private index's blob of each path.
 */
async function incomingInputsOf(core: EngineCore, it: IterationCtx, apply: ApplyReport): Promise<IncomingInputs> {
  const transient = transientOf(it.tick?.excluded ?? new Map());
  let privateBlob: (path: string) => OidOrAbsent = () => ABSENT;
  if (transient.size > 0) {
    const index = await core.repo.listIndex(core.path(`${core.refs.e}.index`));
    privateBlob = (p) => index.get(p)?.oid ?? ABSENT;
  }
  const { notApplicable, rules } = await notApplicableOf(core, it, apply);
  return {
    A: it.A, tipMap: it.tipMap, differs: (p) => !sameTreeEntry(it.A.get(p), it.tipMap.get(p)),
    closures: apply.closures, notApplicable, rules, csOf: incomingCsOf(apply.incoming),
    transient, privateBlob,
  };
}

/**
 * EF2 D5 (HLD-01, HLD-53/HLD-54, ENG-31; R3-30: meta.pending carries the obligation). The not-applicable paths of this iteration: the
 * apply report's, plus every pending not-applicable path whose re-check still held at prepareIteration (notApplicableBlocked: no
 * apply reports it again) with its journaled reason. The obligation to create a not-applicable path's own INCOMING record is
 * journaled with the apply's state commit (the meta.pending row); reading it back here means a kill between that commit and the
 * record's registry CAS (apply.state, registry.cas) leaves the record to the first regular iteration after the restart instead of to
 * the next apply that happens to re-report the path. incomingStep skips a path an existing non-terminal INCOMING record with its
 * guard already covers, so the union creates nothing in the ordinary case. A stageable 'unmaterializable' deferral (FB-6) and a
 * collision whose DISK_EQ re-check cleared (R3-33) are not in the blocked set: they rejoin the apply trigger instead.
 */
async function notApplicableOf(core: EngineCore, it: IterationCtx, apply: ApplyReport): Promise<{ notApplicable: ReadonlyMap<string, NotApplicableReason>; rules: ReadonlyMap<string, PortRule> }> {
  const pending = core.view?.meta.pending ?? {};
  const more = [...notApplicableBlocked(core)].filter((p) => !apply.notApplicable.has(p) && Object.hasOwn(pending, p) && NOT_APPLICABLE_REASONS.has(pending[p]!)).sort();
  if (more.length === 0) return { notApplicable: apply.notApplicable, rules: apply.notApplicableRules };
  const notApplicable = new Map<string, NotApplicableReason>(apply.notApplicable);
  const rules = new Map(apply.notApplicableRules);
  let foldsCase: boolean | null = null;
  for (const p of more) {
    const why = pending[p] as NotApplicableReason;
    notApplicable.set(p, why);
    if (why !== 'unmaterializable') continue;
    foldsCase ??= await caseFoldingDisk(core);
    const rule = notApplicableRuleOf(core, it, p, foldsCase);
    if (rule !== null) rules.set(p, rule);
  }
  return { notApplicable, rules };
}

// ---- T --------------------------------------------------------------------------------------------------------------

/**
 * Engine.signal's note of a file effect (HLD-43): the open seat CS the effect went to starts its "oldest uncovered effect" clock now
 * when none runs (an effect after a passing capture starts a new one). timerStep starts it at first sight for a CS no signal noted.
 */
export function noteEffect(core: EngineCore, seat: string): void {
  const mem = memoryOf(core);
  const now = core.deps.ports.clock.monoMs();
  for (const e of core.cs.table().cs) {
    if (e.kind === 'seat' && e.seat === seat && e.state === 'open' && !e.covered && !mem.uncovered.has(e.cs_id)) mem.uncovered.set(e.cs_id, now);
  }
}

/**
 * Timers T (contract addition 8): the recovered CS's 20 s quiet timer is ChangeSets' own clock (HLD-36), read by captureDue at every
 * prepareIteration, so nothing is due here for it; CS_UNPUBLISHED_NUDGE {cs, n} once per open seat CS whose oldest uncovered file
 * effect (no passing capture covers it: CsTableEntry.covered false) is 300 s old; CS_GROUP_WAITING {paths, seats} once per group
 * episode — from the first timer tick at which a publication group has a member with an unpublished ready pair until no member has one
 * — after 10 min, `seats` the group's open seat CSs' seats. Both to status (core.holdCode) and the daemon log only (R-27, R3-08);
 * neither publishes anything. Task 12b: then escalationStep (HLD-60: HOLD_CREATED / HOLD_CONFLICTED, the +10 min revert event) and
 * s6Step (HLD-61: the 24 h auto-park), in that order, so a park's HOLD_AUTO_PARKED is the newest status line of its loop.
 */
export async function timerStep(core: EngineCore, it: IterationCtx): Promise<void> {
  await csTimers(core);
  await escalationStep(core, it);
  await s6Step(core, it);
}

/** HLD-43's two nudges (Task 12a's timerStep body). */
async function csTimers(core: EngineCore): Promise<void> {
  const mem = memoryOf(core);
  const now = core.deps.ports.clock.monoMs();
  const table = core.cs.table();
  const raises: Array<{ code: string; params: Record<string, Json> }> = [];
  // HLD-43: the unpublished-CS nudge.
  const open = new Map(table.cs.filter((e) => e.kind === 'seat' && e.state === 'open').map((e) => [e.cs_id, e] as const));
  for (const id of [...mem.uncovered.keys()]) {
    const e = open.get(id);
    if (e === undefined || e.covered) mem.uncovered.delete(id);
  }
  for (const e of open.values()) {
    if (e.covered) continue;
    const since = mem.uncovered.get(e.cs_id) ?? now;
    mem.uncovered.set(e.cs_id, since);
    if (!mem.nudged.has(e.cs_id) && now - since >= CS_NUDGE_AFTER_MS) {
      mem.nudged.add(e.cs_id);
      raises.push({ code: 'CS_UNPUBLISHED_NUDGE', params: { cs: e.cs_id, n: e.paths.length } });
    }
  }
  // HLD-43: the group-waiting nudge, once per group episode.
  const journaled = new Set(core.cs.ready().map((p) => p.csId));
  const seen = new Set<string>();
  for (const g of core.cs.groups(heldPins(core.holds))) {
    if (!g.csIds.some((id) => journaled.has(id))) continue;
    seen.add(g.key);
    const ep = mem.groups.get(g.key) ?? { since: now, told: false };
    mem.groups.set(g.key, ep);
    if (!ep.told && now - ep.since >= CS_GROUP_WAITING_MS) {
      ep.told = true;
      const seats = [...new Set(g.csIds.filter((id) => open.has(id)).map(seatOfCs))].sort();
      raises.push({ code: 'CS_GROUP_WAITING', params: { paths: [...g.paths], seats } });
    }
  }
  for (const key of [...mem.groups.keys()]) if (!seen.has(key)) mem.groups.delete(key);
  if (raises.length > 0) raiseHoldCodes(core, raises);
}

// ---- status (HLD-24) ------------------------------------------------------------------------------------------------

/** What holdStatusInputs returns beyond the contract's Pick: each not_converged path's cause (StatusInputs.notConvergedCauses). */
export type HoldStatusInputs = Pick<StatusInputs, 'counts' | 'notConverged' | 'diverged' | 'lastEvent'> & { notConvergedCauses: Map<string, NotConvergedWhy> };

/**
 * HLD-24 status inputs (R3-46, contract addition 4). `base` = Plan 2's not_converged entries with their causes (the Engine's: P2-CARRY
 * carried paths, push_unresolved, phantom, quarantine review, round-trip exclusions, the pause/FREEZE blocked_publish paths, …), kept
 * as they are — the Plan 3 entries extend them, a path keeping its first cause:
 *  - every path of every non-terminal ON_DISK record of every kind and guard class (blocked_publish with its first guard; an INCOMING
 *    record's not-applicable guard as not_applicable, its closure guard as deferred) — never an OFF_DISK record's. A released
 *    (guard-less) record, which publishes until R1 ends it (R3-17), is listed too (EF3, HLD-24), after every other cause: blocked_publish
 *    with its kind as the guard unless FREEZE, a pause or R3-53's gate keeps the path back;
 *  - every deferred or not-applicable meta.pending path (deferred with its reason; not_applicable with its guard);
 *  - every path of a ready group kept back by FREEZE or a publish pause (`blockReason` non-null; blocked_publish with that reason);
 *  - every R3-53 blocked path (not_applicable, guard portability) and every path of a group its gate keeps back (blocked_publish,
 *    guard portability): a group holding a human-class CS while the gate holds (ChangeSets.gated(): blocked() is non-empty, or the
 *    latch a fix sets still holds — EF3) and the group is not ready;
 *  - R3-56: a transient exclusion of the tick older than 60 s whose path no non-terminal record holds (deferred with its reason);
 *  - the path of a failing assertSPub while EngineCore.maskInvalid holds (publish_assert, check = its clause).
 * counts: holds_active = non-terminal non-INCOMING records, holds_local_only = those with local_only, incoming = the paths of the
 * non-terminal INCOMING records ∪ the meta.pending rows (deferred or not applicable) younger than 60 s, each path once (HLD-24, R3-30,
 * R3-EF4-6) — a row's age is `o.pendingAgeMs` (the Engine's pendingSince anchor, the one inspect().pendingAgeMs reports; absent: every
 * row counts as young, the two-argument form). A row older than 60 s is counted only through a record: meta.pending is rebuilt only by
 * an apply (R-05), so under FREEZE a row outlives the record HLD-54 released (TIP no longer changes the path) and is no incoming path
 * (EF4 E3-2); it stays in not_converged. cs_open / cs_ready from ChangeSets. diverged: n = non-terminal ON_DISK records with
 * a non-empty guard set, oldestAgeS = the largest ageMs among them ÷ 1,000 rounded down; null when n = 0. lastEvent = core.holdCode while
 * it is current against these causes (holdCodeCurrent), else null (the Engine feeds it to StatusInputs.holdCode, the degraded rung's
 * hold-code slot, R3-61, fix round 1). A read only: it never changes the slot (Task 12b fix round 1; settleHoldCode clears it).
 * Signature vs the contract's holdStatusInputs(core, it): Pick<…> (fix round 1, kept): it is call-compatible — a two-argument call compiles
 * and its result is assignable to the Pick — but the contract form cannot return Plan 2's entries by itself: they live in Engine-private
 * state (the INV-MASK violation, the aborting publish check, the carried and filter-failure paths of the last tick, the owed fetch, the
 * kept intent's age, the deferral counts), so R3-46's "extend, never replace" needs the Engine to hand them in as `base` (and the
 * FREEZE/pause reason as `blockReason`); `it` is null before the first prepared iteration (the status a start writes); the per-path causes
 * come back too (StatusInputs.notConvergedCauses). Called without `o` it returns the Plan 3 entries alone.
 */
export function holdStatusInputs(
  core: EngineCore, it: IterationCtx | null,
  o: { base?: ReadonlyMap<string, NotConvergedWhy>; blockReason?: string | null; pendingAgeMs?: ReadonlyMap<string, number> } = {},
): HoldStatusInputs {
  const out = new Map<string, NotConvergedWhy>(o.base ?? []);
  const add = (p: string, w: NotConvergedWhy): void => {
    if (!out.has(p)) out.set(p, w);
  };
  const view = core.view;
  const nonTerminal = core.holds.nonTerminal();
  const recordWhy = (r: HoldRecord): NotConvergedWhy => {
    const first = r.guards[0] === undefined ? null : guardName(r.guards[0]);
    if (r.kind !== 'INCOMING') return { cause: 'blocked_publish', guard: first ?? r.kind.toLowerCase() };
    const g = first ?? 'incoming';
    return NOT_APPLICABLE_GUARDS.has(g) ? { cause: 'not_applicable', guard: g } : { cause: 'deferred', reason: g };
  };
  // ON_DISK records (every kind, every guard class; R3-46, R3-37) with a guard. A released (guard-less) one is listed last, below.
  for (const r of nonTerminal) {
    if (r.residence !== 'ON_DISK' || r.guards.length === 0) continue;
    for (const p of r.paths) add(p, recordWhy(r));
  }
  // Deferred and not-applicable paths (meta.pending).
  const pending = view?.meta.pending ?? {};
  for (const [p, reason] of Object.entries(pending)) {
    const guard = NOT_APPLICABLE_GUARD[reason];
    add(p, guard !== undefined ? { cause: 'not_applicable', guard } : { cause: 'deferred', reason });
  }
  // Ready groups kept back by FREEZE or a publish pause; R3-53's blocked paths and the groups its gate keeps back.
  const groups = core.cs.groups(heldPins(core.holds));
  const journaled = new Set(core.cs.ready().map((p) => p.csId));
  const blockReason = o.blockReason ?? null;
  if (blockReason !== null) {
    for (const g of groups) if (g.ready && g.csIds.some((id) => journaled.has(id))) for (const p of g.paths) add(p, { cause: 'blocked_publish', reason: blockReason });
  }
  const blocked = core.cs.blocked();
  for (const p of [...blocked].sort()) add(p, { cause: 'not_applicable', guard: 'portability' });
  // EF3: the gate keeps the human side back while blocked() is non-empty and, after a fix, while its latch holds (ChangeSets.gated(),
  // readyOf's own condition) — the latch's windows withheld the groups with no status entry (INV-NOSILENT; R3-53 "every path of a group
  // the gate keeps back").
  if (core.cs.gated()) {
    // A group the gate keeps back holds a human or recovered CS: one with a human-class cs_id, or the open human CS before its first
    // capture, which has none (the group's key is then the id that capture gives it, or its paths are open paths no open seat CS holds).
    const seatOpen = new Set(core.cs.table().cs.filter((e) => e.kind === 'seat' && e.state === 'open').flatMap((e) => e.paths));
    const humanOpen = new Set([...core.cs.openPaths()].filter((p) => !seatOpen.has(p)));
    for (const g of groups) {
      if (g.ready) continue;
      const human = humanCsN(g.key) !== null || g.csIds.some((id) => humanCsN(id) !== null) || g.paths.some((p) => humanOpen.has(p));
      if (human) for (const p of g.paths) add(p, { cause: 'blocked_publish', guard: 'portability' });
    }
  }
  // R3-56: record-less transient exclusions older than 60 s.
  const excluded = it?.tick?.excluded ?? new Map<string, string>();
  const heldPaths = new Set(nonTerminal.flatMap((r) => r.paths));
  for (const [p, age] of transientAges(core.transient)) {
    const why = excluded.get(p);
    if (age >= TRANSIENT_RECORD_MS && why !== undefined && !heldPaths.has(p)) add(p, { cause: 'deferred', reason: why === 'unreadable' ? 'unreadable' : 'unstable' });
  }
  // A failing assertSPub (R3-57): its path while S_pub stays invalid.
  const failure = memoryOf(core).maskFailure;
  if (core.maskInvalid && failure !== null) add(failure.path, { cause: 'publish_assert', check: failure.clause });
  // EF3 (HLD-24, R3-46: "every path of every ON_DISK record", OFF_DISK the only exclusion): a released ON_DISK record — no guard left
  // (R3-17: ACTIVE, publishing, until R1 ends it SUBSUMED or RESOLVED_PUBLISH), or a guard-less CONFLICTED one MASK withholds whole — is
  // listed too until R1 ends it: the status of the iteration its publish lands in still lists it (that iteration's R1 ran first), and
  // the next iteration's R1 ends it SUBSUMED (loop.test FC-5). Last, so a path FREEZE, a pause or R3-53's gate keeps back carries that
  // cause; otherwise blocked_publish with the record's kind as its guard ('pin', 'patch'). Before EF3 it was skipped, and a released
  // dependency PIN whose pair R3-53's latch held back was withheld with no status entry (INV-NOSILENT, O-LIVE-RECORD's run).
  for (const r of nonTerminal) {
    if (r.residence !== 'ON_DISK' || r.guards.length > 0) continue;
    for (const p of r.paths) add(p, recordWhy(r));
  }
  // Task 12b (carry 1): the slot's code is reported only while it names something still holding (holdCodeCurrent): a stale or terminal
  // one (HOLD_GONE, HOLD_RESTORED of a released record, FROZEN {MASS} after the breaker's resume, …) never stays the degraded rung's
  // message (R3-61). Fix round 1 (minor b): reading it changes nothing — the Engine clears the slot itself, with the full inputs, at
  // each status write (settleHoldCode).
  const lastEvent = core.holdCode !== null && holdCodeCurrent(core, core.holdCode, out) ? core.holdCode : null;

  // Counts (HLD-24, R3-46, R3-30): incoming = non-terminal INCOMING records' paths ∪ meta.pending rows younger than 60 s (R3-EF4-6).
  const local = nonTerminal.filter((r) => r.kind !== 'INCOMING');
  const incomingPaths = new Set<string>(nonTerminal.filter((r) => r.kind === 'INCOMING').flatMap((r) => r.paths));
  for (const p of Object.keys(pending)) if ((o.pendingAgeMs?.get(p) ?? 0) < TRANSIENT_RECORD_MS) incomingPaths.add(p);
  const cs = core.cs.counts();
  // diverged (contract addition 4).
  const onDisk = nonTerminal.filter((r) => r.residence === 'ON_DISK' && r.guards.length > 0);
  const diverged = onDisk.length === 0 ? null : { n: onDisk.length, oldestAgeS: Math.floor(Math.max(...onDisk.map((r) => core.holds.ageMs(r))) / 1_000) };
  return {
    counts: {
      csReady: cs.ready, csOpen: cs.open,
      holdsActive: local.length, holdsLocalOnly: local.filter((r) => r.local_only).length,
      incoming: incomingPaths.size,
    },
    notConverged: [...out.keys()],
    notConvergedCauses: out,
    diverged,
    lastEvent,
  };
}

/**
 * Task 12b fix round 1 (minor b): the hold-code slot's clearing step, separate from every status read. The Engine calls it at each
 * status write with that status's full not_converged causes (Plan 2's `base` extended by Plan 3's, holdStatusInputs): a code that no
 * longer names anything holding (holdCodeCurrent) leaves EngineCore.holdCode; the causes are kept for the announcements between two
 * status writes (holdCodeHolds). Returns the slot after the step.
 */
export function settleHoldCode(core: EngineCore, notConverged: ReadonlyMap<string, NotConvergedWhy>): EngineCore['holdCode'] {
  memoryOf(core).settled = new Map(notConverged);
  if (core.holdCode !== null && !holdCodeCurrent(core, core.holdCode, notConverged)) core.holdCode = null;
  return core.holdCode;
}

/**
 * Whether the hold-code slot holds a code that still names something holding, judged in iteration `it` against Plan 3's entries of
 * this moment extended by the full causes of the last status write (settleHoldCode: Plan 2's not_converged, which only the Engine
 * computes) — escalation.ts's announcement rule. Reads only.
 */
export function holdCodeHolds(core: EngineCore, it: IterationCtx | null): boolean {
  const slot = core.holdCode;
  if (slot === null) return false;
  const settled = memoryOf(core).settled;
  return holdCodeCurrent(core, slot, holdStatusInputs(core, it, settled === null ? {} : { base: settled }).notConvergedCauses);
}

/** Code params that name a hold record (05 §2, 03-data §2: `hid`, `hold_id`, `id`). */
const RECORD_PARAMS: readonly string[] = ['hid', 'hold_id', 'id'];

/**
 * Task 12b (carry 1, R3-61): whether the hold code `c` still names something that keeps this peer degraded — the clearing rule of
 * EngineCore.holdCode's degraded-rung slot, applied at every status write (settleHoldCode) and read by holdStatusInputs and holdCodeHolds:
 *  - HOLD_MASK_INVALID: while EngineCore.maskInvalid holds (R3-57; an assertP failure blocks one window only); its `op: 'mirror'`
 *    form (an unreadable record blob, 05 F1) by the record rule;
 *  - FROZEN {reasons}: while one of its reasons is still in freeze_reasons (the MASS resume lifts MASS without an UNFROZEN raise);
 *    UNFROZEN never (an all-clear is no degraded reason); BOARD_FULL while its episode is open (publish.ts boardFullOpen);
 *  - a code naming a record this registry holds (hid / hold_id / id): while that record is non-terminal and one of its paths is in
 *    `notConverged` (a pathless record while non-terminal), never while it is a released ON_DISK record (no guard, not CONFLICTED; EF3)
 *    — so HOLD_GONE, HOLD_SUBSUMED, HOLD_PARKED / HOLD_AUTO_PARKED (OFF_DISK) and HOLD_RESTORED of a released record clear at once, and
 *    HOLD_CREATED or HOLD_CONFLICTED last while the record holds;
 *  - else a code naming paths (path / paths): while one of them is in `notConverged`; a code naming a change-set (cs): while it is open;
 *  - any other code: kept (it is replaced by the next raise).
 */
export function holdCodeCurrent(core: EngineCore, c: { code: string; params: Record<string, Json> }, notConverged: ReadonlyMap<string, NotConvergedWhy>): boolean {
  const p = c.params;
  if (c.code === 'HOLD_MASK_INVALID' && p['op'] !== 'mirror') return core.maskInvalid;
  if (c.code === 'FROZEN') {
    const reasons = Array.isArray(p['reasons']) ? p['reasons'] : [p['reasons']];
    const now: readonly string[] = core.view?.meta.freeze_reasons ?? [];
    return reasons.some((r) => typeof r === 'string' && now.includes(r));
  }
  if (c.code === 'UNFROZEN') return false;
  if (c.code === 'BOARD_FULL') return boardFullOpen(core);
  for (const k of RECORD_PARAMS) {
    const id = p[k];
    const r = typeof id === 'string' ? core.holds.get(id) : undefined;
    if (r === undefined) continue;
    if (isTerminal(r)) return false;
    // EF3: a released ON_DISK record (no guard left and not CONFLICTED: it withholds nothing, R3-17, HLD-42) names nothing holding,
    // though HLD-24 now keeps its paths in not_converged until R1 ends it — its codes clear at once, as before.
    if (r.residence === 'ON_DISK' && r.guards.length === 0 && r.state !== 'CONFLICTED') return false;
    return r.paths.length === 0 || r.paths.some((x) => notConverged.has(x));
  }
  const paths = [...(typeof p['path'] === 'string' ? [p['path']] : []), ...(Array.isArray(p['paths']) ? p['paths'].filter((x): x is string => typeof x === 'string') : [])];
  if (paths.length > 0) return paths.some((x) => notConverged.has(x));
  const cs = p['cs'];
  if (typeof cs === 'string') return core.cs.table().cs.some((e) => e.cs_id === cs && e.state === 'open');
  return true;
}

/** The age of every non-terminal record (HoldRegistry.ageMs), by id: EngineInspection.holdAgeMs (Task 13's holdTimersSettled input). */
export function holdAges(core: EngineCore): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of core.holds.nonTerminal()) out[r.id] = core.holds.ageMs(r);
  return out;
}

