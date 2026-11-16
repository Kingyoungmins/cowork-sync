// Detection (01-engine §3.5 step 4 "D"; 05-holds HLD-27, HLD-28, HLD-30; ENG-14; rulings R3-36…R3-38, R3-50):
//
//   breakerTick   every detection tick: the mass-change breaker on the tick's dirty-set changes (paths only; a deletion's peer
//                 lines are read from the private index's blob); a trip enters FREEZE(MASS). Silent under mutant M33 (its one
//                 site), while MASS is set and while the post-resume batch is pending (massResumePending), so a formatter's
//                 paths never re-trip MASS after resume.
//   revertStep    every newly materialized S_disk, before any merge or capture: one delta per LIVE path the materialization
//                 re-added or removed (Materialized.prevMap → sDiskMap), observed ones dropped (ObservedWrites.take, the
//                 attribution port's Claude edits; HLD-26); a delta past an observed write is judged from the written blob
//                 (R3-EF4-13); revertDetector, holdReverts. A tick that materializes nothing has no
//                 new S_disk and runs none (glossary §26.1 W6). A binary revert PIN is HOLD_BINARY_WHOLE_FILE {hid, path} in
//                 the daemon log once per record and in status (05 §1 binary row; R3-70).
//   enterMass     HLD-30 entry: FREEZE(MASS), journal/keep/snap_pre_freeze = the last materialized S_disk before the tick, one
//                 event{kind: freeze, reason_code: MASS}, FROZEN, trace 'mass' — one state update.
//
// Nothing here reads claim state (HLD-06).
import { hasRestoreMarkerRow, isBinaryBytes, rows, stripEnding } from '../data/rows.js';
import { ABSENT, type Oid, type OidOrAbsent } from '../git/oid.js';
import type { TreeEntry, TreeMap } from '../git/repo.js';
import type { BreakerInput } from '../holds/breaker.js';
import { blobHash, isNonTrivial, lineHash } from '../holds/provenance.js';
import { blobAt, heldSide } from '../holds/record.js';
import { holdReverts, revertDetector, type DetectorDelta } from '../holds/revert.js';
import {
  ensureAttrs, foldPatch, massResumePending, pathIsFiltered, pathIsText, pushStatesOf, raiseHoldCodes, SNAP_PRE_FREEZE, type EngineCore, type IterationCtx,
} from './core.js';
import { diffPaths } from './treeDiff.js';

// journal/keep/snap_pre_freeze (glossary §4, HLD-30, R3-38) and massResumePending, R3-38's "post-resume batch pending" flag: Task 8's
// names, defined in core.ts since Task 12a (the governor's allowedPending reads the predicate) and re-exported here and by resume.ts,
// the contract's home of the name. breakerTick's silence while it is true is Task 8's; iterate() materializing while it is true and
// publishStep skipping its code part until massResumeStep has run are Task 12a's.
export { massResumePending, SNAP_PRE_FREEZE } from './core.js';

/** A binary path by EPOCH_BASE attributes (not text and not filtered); revertDetector also sniffs the bytes (DAT-04). */
function binaryPath(core: EngineCore, p: string): boolean {
  return !pathIsText(core, p) && !pathIsFiltered(core, p);
}

/** Records whose HOLD_BINARY_WHOLE_FILE was logged, per core (once per record). */
const binaryLogged = new WeakMap<EngineCore, Set<string>>();

/**
 * The revert detector over `deltas` (the caller dropped observed ones), then holdReverts (HLD-07 attaches a repeat); a binary revert
 * PIN raises HOLD_BINARY_WHOLE_FILE once per record. Shared by revertStep and resume.ts's massResumeStep. The record ids.
 */
export async function revertRecords(core: EngineCore, it: IterationCtx, deltas: readonly DetectorDelta[], sDisk: TreeMap): Promise<string[]> {
  if (deltas.length === 0) return [];
  const resolved = core.holds.all().filter((r) => r.state === 'RESOLVED_PUBLISH');
  const tainted = await revertDetector(core.repo, deltas, core.prov, core.peerId, resolved, core.rebase, it.A);
  if (tainted.length === 0) return [];
  await ensureAttrs(core, it.epochBase, tainted.map((t) => t.path));
  const ids = await holdReverts(core.holds, core.repo, tainted, it.A, sDisk, core.prov, core.peerId);
  let logged = binaryLogged.get(core);
  if (logged === undefined) binaryLogged.set(core, (logged = new Set()));
  for (const id of ids) {
    const r = core.holds.get(id);
    if (r === undefined || r.kind !== 'PIN' || r.paths.length !== 1 || logged.has(id)) continue;
    const path = r.paths[0]!;
    if (blobAt(heldSide(r), path) === ABSENT) continue;   // a deletion PIN, not a binary one
    logged.add(id);
    raiseHoldCodes(core, [{ code: 'HOLD_BINARY_WHOLE_FILE', params: { hid: id, path } }]);
  }
  return ids;
}

/**
 * Every newly materialized S_disk, before any merge or capture: deltas from the private-index entries, observed ones dropped
 * (ObservedWrites, AttributionPort.observedEdit), revertDetector, holdReverts. EF4 round 2 R-2 (ruling R3-EF4-13, 05 §3.6 D2 step 1):
 * when an observed write (HLD-26 (b)) of p happened since its private-index entry and the delta does not land on it (the human edited
 * the written result before this materialization), the delta judged is diff(written blob, S_disk[p]): the write itself is observed,
 * only the change after it is judged — a conflicted restore's own marker rows are never a revert.
 * G2 #7 (DAT-46; 05 §3.4 item 3 "no record other than a marker companion ever takes a marker-bearing blob"; R3-EF4-24): a delta whose
 * new S_disk blob holds a restore-marker row — a resolution in progress inside a conflicted restore's rows, saved before the rows are
 * gone — is not judged yet. Judged now, a teammate row the human dropped inside the marker block made a `revert` record whose H1
 * carried the whole -U0 hunk with its marker rows (taintOnlyH1): local_only by R3-EF4-24, so p turned LOCAL_ONLY ('secret-like' in
 * status), MASK withheld it whole and PARK refused it for good, and no REBASE or reverse merge could ever end it. Its base (the written
 * blob, else the private-index entry) is kept for the next materialization instead (ObservedWrites.record), so the delta that removes
 * the rows is judged from that same base and the dropped teammate row is still a revert (INV-HLD-NOREVERT), with a marker-free H1.
 * Nothing of p publishes meanwhile: the `markers` record withholds it whole, and ENG-41 (k) refuses any blob with such a row.
 */
export async function revertStep(core: EngineCore, it: IterationCtx): Promise<string[]> {
  const mat = it.mat;
  if (mat === null) return [];
  // The paths this materialization re-added or removed: where its private-index edit changed the entry (prevMap → S_raw).
  const domain = diffPaths(mat.prevMap, mat.sRawMap);
  if (domain.length === 0) return [];
  await ensureAttrs(core, it.epochBase, domain);
  const deltas: DetectorDelta[] = [];
  for (const p of domain) {
    if (it.scope(p).cls !== 'LIVE') continue;
    const indexed: OidOrAbsent = mat.prevMap.get(p)?.oid ?? ABSENT;
    const next: OidOrAbsent = mat.sDiskMap.get(p)?.oid ?? ABSENT;
    if (indexed === next) continue;
    // HLD-26: a delta landing exactly on an attributed local write (taken: it is observed once), or a Claude edit (Plan 5).
    const written = core.observed.take(p);
    if (written === next || core.deps.attribution.observedEdit(p)) continue;
    // R3-EF4-13: judged from the written blob when one was taken. It is an object a ref keeps: a restore's target is under the
    // registry's blobs/ (its inflight entry, an append-only chain), a collision take's is TIP's. It is never older than the private-index
    // entry: an apply that moved the entry forgot it (R3-EF4-21, applyStep and the restart's decision).
    const base = written ?? indexed;
    // G2 #7: restore-marker rows on the disk — judged once they are gone, from this same base.
    if (await restoreMarkerRowsIn(core, next)) {
      core.observed.record(p, base);
      continue;
    }
    deltas.push({ path: p, prev: base, next, binary: binaryPath(core, p) });
  }
  return revertRecords(core, it, deltas, mat.sDiskMap);
}

/** The blob `o` holds a restore-marker row (DAT-46: hasRestoreMarkerRow, no binary gate); ABSENT holds none. One object read. */
async function restoreMarkerRowsIn(core: EngineCore, o: OidOrAbsent): Promise<boolean> {
  return o !== ABSENT && hasRestoreMarkerRow(await core.repo.readBlob(o));
}

/**
 * HLD-30 (b): the deleted file's last private-index blob (else A's) holds a non-trivial row another writer added within retention,
 * or is a whole version another writer wrote (the journal's whole-blob summary of a binary or over-cap path, provenance.ts).
 */
async function peerLinesIn(core: EngineCore, it: IterationCtx, p: string, index: () => Promise<ReadonlyMap<string, TreeEntry>>): Promise<boolean> {
  const e = (await index()).get(p) ?? it.A.get(p);
  if (e === undefined || (e.mode !== '100644' && e.mode !== '100755')) return false;
  const bytes = await core.repo.readBlob(e.oid);
  if (core.prov.addedBy(blobHash(bytes)).some((w) => w !== core.peerId)) return true;
  if (isBinaryBytes(bytes)) return false;   // the journal keeps no rows of a binary blob
  for (const r of rows(bytes)) {
    const line = stripEnding(r);
    if (isNonTrivial(line) && core.prov.addedBy(lineHash(line)).some((w) => w !== core.peerId)) return true;
  }
  return false;
}

/** Every detection tick: the breaker on the tick's dirty set (paths only); a trip enters MASS. */
export async function breakerTick(core: EngineCore, it: IterationCtx): Promise<'window' | 'peer_lines' | null> {
  // Mutant M33 (R3-50): no mass-change breaker — its one site.
  if (core.deps.testMutants.has('M33')) return null;
  const view = core.view;
  const tick = it.tick;
  if (view === null || tick === null || view.meta.freeze_reasons.includes('MASS') || massResumePending(core)) return null;
  const inputs: BreakerInput[] = [];
  for (const p of [...tick.changed].sort()) {
    const de = tick.dirty.get(p);
    if (de === undefined) continue;
    const id: OidOrAbsent = de.id ?? ABSENT;
    inputs.push({ path: p, deletion: de.kind === 'remove', observed: core.observed.peek(p, id) || core.deps.attribution.observedEdit(p) });
  }
  if (inputs.length === 0) return null;
  let indexMap: ReadonlyMap<string, TreeEntry> | null = null;
  const index = async (): Promise<ReadonlyMap<string, TreeEntry>> => (indexMap ??= await core.repo.listIndex(core.path(`${core.refs.e}.index`)));
  const why = await core.breaker.observe(inputs, it.A.size, (p) => peerLinesIn(core, it, p, index));
  if (why !== null) await enterMass(core, it, why);
  return why;
}

/**
 * HLD-30 entry: FREEZE(MASS), journal/keep/snap_pre_freeze = the last materialized S_disk tree, one event{kind: freeze,
 * reason_code: MASS}, FROZEN; trace 'mass'. One state update whose keep is view.keep plus snap_pre_freeze (a transition replaces
 * the whole keep set). "Before the tick": Snapshotter.last() unless this very iteration materialized it, else view.snap. The
 * iteration's freeze and push states follow, so nothing of it applies or publishes code afterwards. `o.paths` (the trace's count)
 * defaults to the paths of the breaker's last trip. A no-op while MASS is set.
 */
export async function enterMass(core: EngineCore, it: IterationCtx, why: 'window' | 'peer_lines', o: { paths?: number } = {}): Promise<void> {
  const view = core.view;
  if (view === null) throw new Error('enterMass: no state');
  if (view.meta.freeze_reasons.includes('MASS')) return;
  const last = core.snapshot.last();
  const pre: Oid = last !== null && last !== it.mat ? last.sDisk : view.snap;
  const keep = new Map(view.keep);
  keep.set(SNAP_PRE_FREEZE, pre);
  core.outbox.add({ type: 'event', cid: '', kind: 'freeze', refs: [], reason_code: 'MASS' });
  const fp = foldPatch(core);
  await core.commit({
    meta: { ...view.meta, ...(fp?.meta ?? {}), freeze_reasons: [...view.meta.freeze_reasons, 'MASS'], outbox: core.outbox.toJson() },
    keep, ...(fp !== null ? { fold: fp.fold } : {}),
  });
  it.freeze = [...core.view!.meta.freeze_reasons];
  it.pushStates = pushStatesOf(core, it.version);
  const paths = o.paths ?? core.breaker.lastTripPaths();
  // 01-engine §2's FROZEN with the reason (status and the daemon log, R-27); the human notice of HLD-30 is the status line.
  core.deps.log.write('warn', 'FROZEN', { reasons: 'MASS', why, paths });
  core.holdCode = { code: 'FROZEN', params: { reasons: ['MASS'], why, paths } };
  core.deps.trace.emit({ kind: 'mass', peer: core.peerId, entered: true, paths });
}
