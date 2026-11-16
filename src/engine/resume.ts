// Resume (R-28 extended; 01-engine ENG-45; 05-holds HLD-31, Table 3 `host-reject`; 08-lifecycle §2.1/§3.6 as R3-38 narrows them;
// rulings R3-11, R3-38, R3-39):
//
//   resume          the human's resume (`node dist/daemon.js resume` under daemon.lock, Engine.resume): clears meta.nonretryable
//                   and the rejection streak, releases the host-reject guard of the record meta.nonretryable.hold_id names (so
//                   the PIN's group publishes by HLD-52, and a new third rejection adds the guard again by HLD-07) — the pathless
//                   PIN of a board-only NONRETRYABLE instead ends SUBSUMED with its guards unchanged (R3-11) — and lifts MASS,
//                   keeping journal/keep/snap_pre_freeze (whose presence while MASS is unset is the post-resume batch pending),
//                   drafting one event{kind: unfreeze, reason_code: MASS}. One registry commit (when a record changes) before
//                   one state CAS, so a crash between them leaves the pause, which the next resume clears.
//   massResumeStep  HLD-31 at the first materializing iteration after it: the revert detector over diff(snap_pre_freeze, S_disk)
//                   as unobserved deltas (tainted → `revert` records, attached by HLD-07), every changed LIVE path observed into
//                   one human CS (publishing under S1), the keep entry dropped in one state update, the residue logged as
//                   UNFROZEN {reason: MASS, residue}. A kill after its registry commit and before that update re-runs it after
//                   the restart (the keep entry is still there) and HLD-07 attaches to the record made before the kill.
// LIF §3.6's REBUILD is not applied for MASS (R3-38). Nothing here reads claim state (HLD-06).
import { ABSENT, type OidOrAbsent } from '../git/oid.js';
import { guardName, isTerminal } from '../holds/record.js';
import type { DetectorDelta } from '../holds/revert.js';
import { ensureAttrs, foldPatch, pathIsFiltered, pathIsText, type EngineCore, type IterationCtx } from './core.js';
import { massResumePending, revertRecords, SNAP_PRE_FREEZE } from './detect.js';
import { diffPaths } from './treeDiff.js';

export { massResumePending } from './detect.js';

export interface ResumeReport { nonretryable: boolean; hostRejectReleased: string | null; massLifted: boolean; }

/**
 * One state CAS while no daemon runs: clears NONRETRYABLE and the streak, releases the host-reject guard of meta.nonretryable.hold_id —
 * or, when that record is the pathless PIN (R3-11), ends it SUBSUMED with its guards unchanged (host-reject kept, no releaseGuard; its
 * terminal op carries the guard), hostRejectReleased naming it either way — and removes MASS (keeping snap_pre_freeze); when it lifts
 * MASS it drafts one event{kind: unfreeze, reason_code: MASS} (Plan 2 R-09's freeze/unfreeze pair; Task 8). When the record
 * meta.nonretryable.hold_id names is already terminal or missing, resume makes no registry change (hostRejectReleased null) and still
 * clears meta.nonretryable and the streak in its one state CAS. Nothing pending: all false, no commit. Transition.keep = view.keep
 * with every entry unchanged (snap_pre_freeze kept).
 */
export async function resume(core: EngineCore): Promise<ResumeReport> {
  const report: ResumeReport = { nonretryable: false, hostRejectReleased: null, massLifted: false };
  const view = core.view;
  if (view === null) return report;
  const meta = view.meta;
  report.nonretryable = meta.nonretryable !== null || meta.rejections !== null;
  report.massLifted = meta.freeze_reasons.includes('MASS');
  if (!report.nonretryable && !report.massLifted) return report;

  const holdId = meta.nonretryable?.hold_id ?? null;
  const pin = holdId === null ? undefined : core.holds.get(holdId);
  if (pin !== undefined && !isTerminal(pin) && pin.guards.some((g) => guardName(g) === 'host-reject')) {
    if (pin.paths.length === 0) await core.holds.transition(pin.id, { state: 'SUBSUMED' });   // R3-11: guards unchanged
    else await core.holds.releaseGuard(pin.id, 'host-reject');
    report.hostRejectReleased = pin.id;
  }
  // R-27: a non-retryable rejection posts `event{kind: nonretryable}` only after the pause lifts (queued in this update).
  if (meta.nonretryable !== null) core.outbox.add({ type: 'event', cid: '', kind: 'nonretryable', refs: [], reason_code: 'NONRETRYABLE' });
  if (report.massLifted) core.outbox.add({ type: 'event', cid: '', kind: 'unfreeze', refs: [], reason_code: 'MASS' });
  const fp = foldPatch(core);
  await core.commit({
    meta: {
      ...meta, ...(fp?.meta ?? {}), nonretryable: null, rejections: null,
      freeze_reasons: meta.freeze_reasons.filter((r) => r !== 'MASS'), outbox: core.outbox.toJson(),
    },
    keep: view.keep,
    ...(fp !== null ? { fold: fp.fold } : {}),
  });
  if (report.massLifted) {
    // The window's first sightings belong to the frozen episode; the post-resume batch takes its paths (breakerTick is silent until it ran).
    core.breaker.reset();
    core.deps.trace.emit({ kind: 'mass', peer: core.peerId, entered: false, paths: 0 });
  }
  core.deps.log.write('info', 'RESUMED', { hold_id: holdId, host_reject_released: report.hostRejectReleased, mass: report.massLifted });
  return report;
}

/**
 * HLD-31 at the first materializing iteration with snap_pre_freeze kept and MASS unset: revertDetector over diff(snap_pre_freeze, S_disk)
 * as unobserved deltas, the untainted remainder into one human CS, the keep entry dropped in the same update; returns the residue ids, or
 * null when nothing was pending (or the iteration did not materialize). Logs the residue as UNFROZEN {reason: 'MASS', residue: [<ids>]}
 * (Plan 2's code for a lifted freeze, log only; Task 8).
 */
export async function massResumeStep(core: EngineCore, it: IterationCtx): Promise<string[] | null> {
  const view = core.view;
  const mat = it.mat;
  if (view === null || mat === null || !massResumePending(core)) return null;
  const pre = view.keep.get(SNAP_PRE_FREEZE)!;
  const preMap = await core.repo.readTreeMap(pre);
  const changed = diffPaths(preMap, mat.sDiskMap);
  await ensureAttrs(core, it.epochBase, changed);
  const live = changed.filter((p) => it.scope(p).cls === 'LIVE');
  const deltas: DetectorDelta[] = [];
  for (const p of live) {
    const prev: OidOrAbsent = preMap.get(p)?.oid ?? ABSENT;
    const next: OidOrAbsent = mat.sDiskMap.get(p)?.oid ?? ABSENT;
    if (prev !== next) deltas.push({ path: p, prev, next, binary: !pathIsText(core, p) && !pathIsFiltered(core, p) });
  }
  // Unobserved by definition (HLD-31): no ObservedWrites entry and no attribution drops a delta of the batch.
  const ids = [...new Set(await revertRecords(core, it, deltas, mat.sDiskMap))];
  const keep = new Map(view.keep);
  keep.delete(SNAP_PRE_FREEZE);
  await core.commit({ keep });
  // The batch is one human CS: its paths publish under S1 (the records above mask their tainted hunks).
  core.cs.observe(live);
  core.deps.log.write('info', 'UNFROZEN', { reason: 'MASS', residue: ids.join(',') });
  return ids;
}
