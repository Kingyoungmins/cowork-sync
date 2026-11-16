// Publish (01-engine §3.12; ENG-39…ENG-46; PRO-08, PRO-09, PRO-12, PRO-40…PRO-45, PRO-54, PRO-55; HLD-42; glossary §24
// defaults 1 and 3, §26.2 items 1–2, §27.2; rulings R-02, R-16…R-21, R-30).
//
//   gates     the fetch's HTTP throttle signal (before anything, a 429 is a failed fetch); an unpublished HOST_THROTTLED
//             event dropped once the mode is normal (P2-R18); no publish when the fetch failed, while a push intent is
//             journaled (resolved by observation first), while a restore is stranded (P2-STRANDED), on a failed
//             snapshot or a filter failure (P2-SNAPFILTERS); code only in the ok state, ops per PRO-45 (P2-PUSHSTATES).
//             Without a lease (CCI-50) the loop captures nothing new and this step flushes the pairs captured before.
//             Nothing pending (no ready pair composeP would include, P2-PIN, and no allowed op): nothing to do
//      window governor.mayAttempt(rank) before anything is built (Plan 2 Task 14 decision 4): no MASK merge-file, no object,
//             no registry commit, no HOLD_MASK_INVALID and no intent outside a window
//   1  P      MASK(R) of the newest ready pair per path, A elsewhere (HLD-42, composeP; pairs touching a held PIN skipped,
//             P2-PIN); HLD-19's INV-MASK over P. P == A and no allowed op (known only once MASK ran, so inside the window):
//             nothing is pushed (PRO-42), and composed pairs count as published (R-02: OUT == tree(TIP) with no ops). Plan 3
//             Task 2: MASK is the asynchronous merge-file form (maskEntries); its step-5 conflicts become CONFLICTED in one
//             registry commit (HLD-15, R3-19) and Algorithm P recomposes (final review F9: MASK step 4 then withholds the
//             record's paths whole and HLD-42 pins their groups; no window aborts for them, R3-76); after ENG-41 (i)'s early check,
//             assertP (HLD-19 on P); a MASK that cannot run (HoldOperatorError: a corrupt or missing record blob, 05 F1) or
//             an assertP failure raises HOLD_MASK_INVALID and drops this window's code part only, the allowed board-only ops
//             still go, S_disk is never the fallback (R3-20, R3-57; PublishReport.maskInvalid)
//   3  OUT    merge-tree --merge-base=A P TIP (R-30 wrappers in mergeTree), rename carry (01-engine §3.10), the conflict
//             function on every other conflicted path: CONCAT, or TAKE_TIP with a K4 PATCH record (CONFLICTED, ON_DISK —
//             R-02's publish side) committed before the push; the rest of the change-set still publishes (default 3)
//   5  ENG-41 assertions.ts, on the objects git wrote (parents read back)
//   6  C, Bnew C = commit-tree OUT -p TIP (omitted when OUT == tree(TIP)); Bnew = [T, C | TIP] with this publish's ops (seqs
//             allocated now, writer seq above them, PRO-09) and a checkpoint at heights ≡ 0 mod 256 (PRO-26)
//   7  J      push intent {bnew, c, leases, cs_ids, writer_seq, op_ids} + t/P, seq_next and the outbox persisted (PRO-08);
//             crashpoint('publish.out_built'); yieldPoint('publish.beforePush')
//   8  push   governedPush: board leased on T, the mirror leased on its fetched value when ABSENT or an ancestor of TIP
//             (ENG-43); classify: crashpoint('publish.sent'), the fresh fetch, classifyPublish (never text, ENG-44);
//             landed → crashpoint('publish.landed') + applyPushOk; lease_lost → the next window re-runs everything (PRO-43);
//             transient → meta.rejections, the streak of 2 is a throttle signal; the 3rd → NONRETRYABLE with a host-reject
//             PIN and the host's text in the daemon log only (ENG-45); network → streak unchanged
//
// Mutants (R-29): M06 pushes S_disk as OUT (ENG-41 (b)/(c) stop it); M12 classifies by the rejection text.
//
// Plan 3 Task 4 (hold mirrors; HLD-10, HLD-62, PRO-06, PRO-21 writer side, PRO-24, PRO-27; R3-24…R3-29, R3-56): mirrorSync runs
// first (after the intent gates): it drains the own hold rejections the fold found (R3-27: a prev_rev race needs nothing — the
// rejected op landed and left the outbox, so the record's mirror key no longer matches its folded entry and it is re-drafted
// from the folded rev below; every other reason is recorded in local.rejected and told once) and drafts one `hold` op per
// record whose mirror key differs from both its folded entry with the tip's held/<id>/ and its pending draft. Bnew carries
// held/<id>/ for every non-local_only op it places (heldBlobs of the current registry rev, never an empty put) and removes the
// held/ subtrees of records turned local_only and of the holds compaction drops at its height; ENG-41 (j) checks exactly the
// puts. At the 5,000-record cap the take withholds hold creations (PRO-06) and one BOARD_FULL health event per episode goes out.
// A build whose held/ puts the 5 MB tree cap refuses (02 §3.1, R3-74) is built once more with the put-carrying hold drafts
// withheld (round-1 ruling): code, stubs, ending ops (their held/<id>/ carried, not re-put), removals and events still land.
import {
  BOARD_TREE_MAX_BYTES, buildBoardCommit, CODE_SUBJECT, HELD_LISTING_MAX_BYTES, liveCommitTrailers, readBoardCommit, readHeldAll, BoardMalformedError,
  type BoardBuild, type BoardDraft, type CsTrailer, type HeldBlob, type WriterId,
} from '../board/boardCommit.js';
import { canonicalJson, type Json } from '../board/canonicalJson.js';
import { CHECKPOINT_EVERY, foldCommit, governorRank, holdsCompactedAt, liveSet, serializeFold, type FoldedHold, type FoldState } from '../board/fold.js';
import { SLOW_PUSH_MS, type ThrottleSignal } from '../board/governor.js';
import { parseOpId } from '../board/ids.js';
import { BoardCapError, isHoldCreation, OPS_MAX_BYTES, OPS_MAX_LINES, serializeOps, type HoldOp, type Op, type OpDraft } from '../board/ops.js';
import { Outbox, type PushState, type SeqAllocator } from '../board/outbox.js';
import { conflict, type ConflictCtx, type ConflictVerdict, type UnitKind } from '../data/conflict.js';
import { hasRestoreMarkerRow } from '../data/rows.js';
import { wildmatch } from '../data/scope.js';
import { readHttpThrottle } from '../git/httpStatus.js';
import { MergeFailedError, mergeTree } from '../git/merge.js';
import { ABSENT, OidError, type Oid, type OidOrAbsent } from '../git/oid.js';
import { buildPushArgv, deleteProbeRef, pushSpec, runPush, type PushOutcomeRaw, type PushRefStatus, type PushSpec } from '../git/push.js';
import { GitCommandError, type GitRepo, type IndexEdit, type TreeEntry, type TreeMap } from '../git/repo.js';
import {
  heldPins, pinCs, ReadyBaseMismatchError, seatOfCs, shadowCsIds, type Composition, type HeldPin, type PublicationGroup, type RebaseChange,
} from '../holds/changesets.js';
import { assertP, maskEntries, maskReason, type MaskInputs, type MaskOptions } from '../holds/mask.js';
import { checkMirror, creationDue, heldBlobs, mirrorKey, mirrorShown, projectOp } from '../holds/mirror.js';
import { HoldOperatorError } from '../holds/rebase.js';
import { t0Shrink, type T0Verdict } from '../holds/ports.js';
import { guardArg, guardName, isK4Displacement, isTerminal, isUnknownGuard, setBlob, TERMINAL_STATES, type BlobMap, type HoldRecord } from '../holds/record.js';
import type { MirrorRejectReason } from '../holds/registry.js';
import { anchorNow, elapsedMono } from '../ports/clock.js';
import { crashpoint, KilledAt } from '../ports/crashpoint.js';
import type { PushPurpose, TraceOutcome } from '../ports/trace.js';
import { sanitizeText } from '../sec/redact.js';
import { heldPathInP, prePushAsserts, type AssertLetter } from './assertions.js';
import {
  boardOnlyFirstPublish, codeWithheld, codeWithheldWhy, currentA, editable, ensureAttrs, foldPatch, liveCodeOf, observeFetch, observeOwnLanding, pathIsFiltered,
  pathIsText, publicationGroups, sameEntry, setBoardOnlyFirstPublish, setCurrentA, tickInputOf,
  type EngineCore, type IterationCtx,
} from './core.js';
import { resetScratchIndex, ScratchResetError } from './diskEq.js';
import type { FetchView } from './fetcher.js';
import type { Meta } from './meta.js';
import { classifyPublish, type PublishOutcome } from './pushResult.js';
import { csTableKeep, StateCasLostError, type Intent, type JournalTree, type Transition } from './state.js';
import { diffPaths, isRegularEntry as isRegular } from './treeDiff.js';
import { editsBetween, editTreeIndexOnly, IndexRefusedPathError } from './treeEdit.js';

export interface PublishReport {
  attempted: boolean;
  outcome: PublishOutcome | 'skipped' | 'aborted' | 'nothing';
  why: string | null;                 // e.g. 'window', 'state', 'publish_assert:b', 'snapshot_failed', 'filter_failure', 'path_not_indexable'
  bnew: Oid | null; c: Oid | null; records: string[];
  /**
   * Plan 3 Task 2: HOLD_MASK_INVALID dropped this window's code part (a MASK that could not run, or assertP failed; R3-20, R3-57).
   * Task 12a: also true for every window while EngineCore.maskInvalid holds (an assertSPub failure, R3-57).
   */
  maskInvalid: boolean;
  /**
   * Contract extension (Plan 3 Task 12a; R3-57, HLD-31): why this window composed no code although it may push — 'mask_invalid' while
   * EngineCore.maskInvalid holds, 'mass_resume' while the post-resume MASS batch waits for massResumeStep (massResumePending) and in
   * the iteration whose massResumeStep formed it (markBatchFormed). Absent when the code part was not skipped for either; the
   * allowed board-only ops of the window still go.
   */
  codeSkipped?: 'mask_invalid' | 'mass_resume';
  /** Plan 3 Task 4: the hold ids whose `hold` ops the pushed Bnew carries (in ops order, each once); [] when no Bnew was pushed. */
  mirrored: string[];
  /** Plan 3 Task 10 (HLD-42): the dependency PINs Algorithm P made or attached to in this window. */
  dependencyPins: string[];
  /** Plan 3 Task 10 (HLD-50, R3-04): the K7 PINs the T0 slot made in this window (guard t0, or dependency:<shadow id>, HLD-48). */
  k7: string[];
  /** Plan 3 Task 10 (HLD-67, R3-04): the open CSs whose edit-checkpoint capture the T0 slot dropped in this window. */
  dropped: string[];
  /**
   * Contract extension (final review FC-2): the ENG-41 / ENG-39 / ENG-52 step 8 check that aborted this publish — an
   * assertion letter, 'a_cap' (ReadyBaseMismatchError) or 'join_first_publish' — and its path (null: the check names
   * none); null for every other report. The loop keeps it as NOT_CONVERGED{cause: publish_assert, check} in status.
   */
  assert: { check: string; path: string | null } | null;
}
/** One governed attempt as the caller observed it after the push (never by text). */
export interface AttemptClass { outcome: TraceOutcome; transient: boolean; landed: boolean; }
export type GovernedBody = { specs: readonly PushSpec[] } | { deleteProbe: { ref: string; lease: Oid } };

type PushIntent = Extract<Intent, { kind: 'push' }>;

const HOST_THROTTLED = 'HOST_THROTTLED';
/** The most first-parent board commits read to find an own Bnew after its lease (PRO-12). */
const CHAIN_WALK_MAX = 10_000;
/** ENG-45: the host's text kept in the daemon log (sanitised, display only), at most this many characters. */
export const HOST_TEXT_MAX = 2_000;

// ---- small helpers -----------------------------------------------------------------------------------------------

function report(outcome: PublishReport['outcome'], why: string | null, extra?: Partial<PublishReport>): PublishReport {
  return { attempted: false, outcome, why, bnew: null, c: null, records: [], maskInvalid: false, mirrored: [], dependencyPins: [], k7: [], dropped: [], assert: null, ...extra };
}

/**
 * The first-parent board commits after `stop` up to `tip` (an unknown or unrelated stop lists what rev-list can); null
 * when the walk failed. A failed walk fails closed: it is never read as "Bnew is not on the chain" (that would discard a
 * landed push and publish it twice); the caller keeps the push intent for a later observation.
 */
async function chainAfter(repo: GitRepo, tip: Oid, stop: OidOrAbsent): Promise<Oid[] | null> {
  try {
    return await repo.firstParents(tip, stop === ABSENT ? null : stop, CHAIN_WALK_MAX);
  } catch (e) {
    if (e instanceof GitCommandError || e instanceof OidError) return null;
    throw e;
  }
}

/** PRO-12 (ruling: decided by Bnew's oid): Bnew is the fetched board tip or on its first-parent chain after the lease; null = unknown (the walk failed). */
async function bnewOnChain(repo: GitRepo, tip: OidOrAbsent, lease: OidOrAbsent, bnew: Oid): Promise<boolean | null> {
  if (tip === ABSENT) return false;
  if (tip === bnew) return true;
  if (tip === lease) return false;
  const chain = await chainAfter(repo, tip, lease);
  return chain === null ? null : chain.includes(bnew);
}

// ---- throttle signals and the health event (PRO-55; rulings R-16, R-18) ------------------------------------------

const isThrottleDraft = (d: OpDraft): boolean => {
  const o = d as unknown as Record<string, unknown>;
  return o['type'] === 'event' && o['kind'] === 'health' && o['reason_code'] === HOST_THROTTLED;
};

/** A throttle signal: the governor's fallback restarts, and one HOST_THROTTLED event is queued when it says so. */
function signal(core: EngineCore, s: ThrottleSignal, fromPush: boolean, otherPending: boolean): void {
  const { postEvent } = core.governor.onSignal(s, fromPush, otherPending);
  if (!postEvent) return;
  core.outbox.add({ type: 'event', cid: '', kind: 'health', refs: [], reason_code: HOST_THROTTLED });
  core.governor.onEventQueued();
  core.deps.log.write('warn', HOST_THROTTLED, { signal: s, queued: true });
}

/** An HTTP 429/5xx in a fetch's report (ENG-46): a deferred view ran no fetch and is never a second signal. */
function fetchSignal(core: EngineCore, view: FetchView, otherPending: boolean): void {
  if (view.deferred || view.httpThrottle === null) return;
  signal(core, view.httpThrottle, false, otherPending);
}

/**
 * The iteration fetch's HTTP throttle signal handed to the governor (PRO-55, ENG-46; R-18: a fetch-only signal posts the
 * HOST_THROTTLED event only with other work pending in `states`). publishStep does it first; an iteration that never
 * reaches publishStep (Task 14 carry: the incident branch, index.lock, a fetch owed after a suspend, an INV-MASK abort)
 * calls this, the one hand-over.
 */
export function handOverThrottle(core: EngineCore, view: FetchView | null, states: readonly PushState[], withhold?: (d: OpDraft) => boolean, it?: IterationCtx): void {
  if (view !== null) fetchSignal(core, view, pendingCheap(core, states, withhold, it));
}

/** handOverThrottle for an iteration with a context: PRO-06's withheld hold drafts (withholdOf) do not count as pending (Plan 3 Task 4). */
export function handOverThrottleFor(core: EngineCore, it: IterationCtx, view: FetchView | null): void {
  handOverThrottle(core, view, it.pushStates, withholdOf(core, it), it);
}

/**
 * Allowed pending work without composing P (R-18's otherPending): a ready publication group with an unpublished pair while code
 * may be pushed — allowedPending's predicate (Plan 3 Task 10, HLD-39) — or ops allowed in every active state (PRO-06's withheld
 * hold creations do not count). A group a held PIN, a missing passing capture or R3-53's gate keeps back waits, not for a window.
 */
function pendingCheap(core: EngineCore, states: readonly PushState[], withhold?: (d: OpDraft) => boolean, it?: IterationCtx): boolean {
  if (core.outbox.pendingAllowed(states, withhold)) return true;
  if (states.length !== 0) return false;
  return composable(core, it);
}

/**
 * Some publication group is ready (HLD-39: no held PIN, a passing capture, not gated) with an unpublished pair. Task 12a (R3-57,
 * HLD-31): never while codeWithheld — S_pub is invalid (EngineCore.maskInvalid) or the post-resume MASS batch is pending; with the
 * iteration (Task 12b, carry 5) also in the iteration whose massResumeStep formed that batch (publishStep withholds its code there).
 */
function composable(core: EngineCore, it?: IterationCtx): boolean {
  return core.cs.ready().length > 0 && !codeWithheld(core, it) && publicationGroups(core).some((g) => g.ready);
}

/** Per core, the P of the newest composition (EngineInspection.lastP; Task 12a): what the last composed window would publish. */
const lastPOf = new WeakMap<EngineCore, TreeMap>();

/** EngineInspection.lastP (Plan 3 Task 12a): the P tree map of the newest composeP of this run, null before the first. */
export function lastComposedP(core: EngineCore): TreeMap | null {
  return lastPOf.get(core) ?? null;
}

// ---- state updates ------------------------------------------------------------------------------------------------

/** The meta every publish transition writes: the fold of this run (R-14, P2-FOLDPERSIST), the own fallback (ENG-05) and the outbox. */
function metaNow(core: EngineCore, over: Partial<Meta> = {}): Meta {
  const view = core.view!;
  const fp = foldPatch(core);
  return { ...view.meta, throttle: core.governor.toMeta(), outbox: core.outbox.toJson(), ...(fp !== null ? fp.meta : {}), ...over };
}

/**
 * One state update carrying the fold patch; ChangeSets changed memory first, so a non-fatal failure restores it (Task 11). An
 * update that journals ready pairs (the ok update, an R-02 drop) also writes the CS table once one is journaled (Plan 3 Task 9,
 * R3-40: published() raised publish counts and let fully published closed CSs leave): view.keep with only the 'cs' entry
 * replaced, as captureStep does. While no table is journaled nothing is written for it (R3-68). `ready` comes with the rollback of
 * the ChangeSets.rollbackPoint() its caller took before its first change of memory: a non-fatal failure is a full rollback (Plan 3
 * Task 9 fix round 1, finding 3: no passing flag flips, no publish is counted twice, no published closed CS goes missing).
 */
async function commitWith(core: EngineCore, t: Transition, ready: { pairs: ReturnType<EngineCore['cs']['ready']>; rollback: () => void } | null): Promise<void> {
  const prev = core.view!;
  const fp = foldPatch(core);
  try {
    // readCsTable(repo, prev) is non-null exactly when prev.keep holds 'cs' (StateStore checked the table when it read or wrote it).
    const table = ready !== null && prev.keep.has('cs') ? await csTableKeep(core.repo, core.cs.table()) : null;
    const keep = table === null ? {} : { keep: new Map([...(t.keep ?? prev.keep), table]) };
    await core.commit({ ...t, ...keep, ...(ready !== null ? { ready: ready.pairs } : {}), ...(fp !== null ? { fold: fp.fold } : {}) });
  } catch (e) {
    if (ready !== null && !(e instanceof StateCasLostError) && !(e instanceof KilledAt)) ready.rollback();
    throw e;
  }
}

/** R-02: the composed pairs count as published when nothing is pushed because OUT == tree(TIP) with no ops. */
async function dropPublished(core: EngineCore, csIds: readonly string[]): Promise<void> {
  if (csIds.length === 0) return;
  const rollback = core.cs.rollbackPoint();
  core.cs.published(csIds);
  await commitWith(core, { meta: metaNow(core) }, { pairs: core.cs.ready(), rollback });
}

// ---- P (HLD-42) ---------------------------------------------------------------------------------------------------

/** composeP's Composition (Plan 3 Task 10) plus what publishStep adds to it (renamed from Plan 2's local Composition, TS2440). */
interface PublishComposition extends Composition {
  /**
   * ENG-41 (i)'s `masked` (R3-20: withheld.has(p) && maskReason(p) !== 'path_class', per path, R3-76): p is withheld whole by a
   * record — a steps 2–4 reason of maskReason, a step-5 path that is not mergeable (binary or filtered, R3-18), or a path this
   * composition's own maskEntries runs withheld whole (byte-binary, a step-5 conflict on that path). A conflicted record's other
   * paths are not masked: MASK changed them only partly (R3-76; final review F9: Algorithm P does not publish a composition with
   * conflicts — it recomposes after the CONFLICTED commit, where MASK step 4 withholds them whole). Never a path class (heldPathInP's INV-MASK
   * letter) and never a step-5 partial path (assertP's). The steps 2–4 and R3-18 parts do not depend on the MaskResult a stubbed
   * composeP returns.
   */
  masked: (p: string) => boolean;
  /** The MASK inputs P was composed with (assertP's). */
  inp: MaskInputs;
  /** Record ids whose step-5 merge conflicted in this composition: publishStep transitions them to CONFLICTED (HLD-15, R3-19). */
  conflicted: string[];
}

/** MaskOptions from the engine's test mutants (R3-50; the sites of M19, M25 and M28 are in src/holds/mask.ts). */
export function maskOptions(core: EngineCore): MaskOptions {
  const m = core.deps.testMutants;
  return { m19: m.has('M19'), m25: m.has('M25'), m28: m.has('M28') };
}

/** The MASK inputs over `records` (R3-19): A and the scope of this iteration, mergeable(p) = pathIsText(p) && !pathIsFiltered(p). */
export function maskInputsOf(core: EngineCore, it: IterationCtx, records: MaskInputs['records']): MaskInputs {
  return { A: it.A, scope: (p) => it.scope(p).cls, records, mergeable: (p) => pathIsText(core, p) && !pathIsFiltered(core, p) };
}

/**
 * ENG-41 (i)'s `masked` per path (R3-20, R3-76): p is withheld whole by a record — a steps 2–4 reason of maskReason, a step-5
 * path that is not mergeable (R3-18), or a path the MASK run withheld whole (`withheld`: byte-binary, a step-5 conflict on
 * that path). A step-5 partial path is not masked (its S_pub / P entry differs from A by design); never a path class.
 */
export function maskedOf(inp: MaskInputs, withheld: ReadonlySet<string>): (p: string) => boolean {
  return (p) => {
    const r = maskReason(p, inp);
    if (r === null || r === 'path_class') return false;
    return r !== 'patch' || !inp.mergeable(p) || withheld.has(p);
  };
}

/**
 * P = MASK(R) of the newest ready pair per path of every ready publication group (HLD-38, HLD-39, HLD-42; Plan 3 Task 10: the held
 * PINs heldPins and R3-42's SHADOW-held CSs decide readiness inside composeP), A elsewhere. MASK is the asynchronous merge-file form
 * over the registry's masking records with the engine's REBASE cache (R3-19); a MASK that cannot run throws HoldOperatorError (05
 * F1). withheldWhole names the ready groups' paths a MASK steps 2–4 record withholds whole (HLD-42 → dependency PIN; R3-35: a group
 * path in neither R nor A included). `without` (the T0 slot's trial): records MASK leaves out, as composeP leaves their PINs out of `pins`.
 */
async function compose(core: EngineCore, it: IterationCtx, pins = heldPins(core.holds), without: ReadonlySet<string> = new Set()): Promise<PublishComposition> {
  const records = core.holds.maskingRecords().filter((r) => !without.has(r.id));
  await ensureAttrs(core, it.epochBase, [...core.cs.ready().flatMap((r) => r.paths), ...core.cs.openPaths(), ...records.flatMap((r) => r.paths)]);
  const inp = maskInputsOf(core, it, records);
  const opts = maskOptions(core);
  const conflicted = new Set<string>();
  const withheld = new Set<string>();
  core.cs.shadowed(shadowCsIds(core.holds));
  const c = await core.cs.composeP(core.repo, it.A, async (X) => {
    const m = await maskEntries(core.repo, X, inp, core.rebase, opts);
    for (const id of m.conflicted) conflicted.add(id);
    for (const p of m.withheld) withheld.add(p);
    return m;
  }, pins);
  // HLD-42's withheldWhole is the MASK steps 2 and 4 set over every group path (R3-35: a group path in neither R nor A included),
  // computed here from the records MASK read, so a composeP stand-in (a test seam) cannot change it.
  const journaled = new Set(core.cs.ready().map((pair) => pair.csId));
  const withheldWhole = new Map<string, string[]>();
  // Plan 3 Task 12a: a group's paths also hold the paths of closed member CSs that the loop's group-form captures keep in the CS table
  // (a path a pair dropped, a held PIN's), which neither a ready pair nor an open CS names: their attributes are requested too, since
  // maskReason reads the scope (a SIM seed met an unrequested `own/p2-1.txt` there).
  await ensureAttrs(core, it.epochBase, c.groups.filter((g) => g.csIds.some((id) => journaled.has(id))).flatMap((g) => g.paths));
  for (const g of c.groups) {
    if (!g.csIds.some((id) => journaled.has(id))) continue;
    const whole = g.paths.filter((p) => WHOLE_REASONS.has(maskReason(p, inp) ?? ''));
    if (whole.length > 0) withheldWhole.set(g.key, whole);
  }
  lastPOf.set(core, c.P);
  // Per path (R3-76): a step-5 conflict on q withholds q alone; the conflicted record's other paths keep MASK's partial output.
  return { ...c, withheldWhole, masked: maskedOf(inp, withheld), inp, conflicted: [...conflicted] };
}

/** HOLD_MASK_INVALID (HLD-19, 05 F1; R3-20): status (core.holdCode, R-27) and the daemon log; no code publish this window. */
export function raiseMaskInvalid(core: EngineCore, params: Record<string, string>): void {
  core.holdCode = { code: 'HOLD_MASK_INVALID', params };
  core.deps.log.write('error', 'HOLD_MASK_INVALID', params);
}

/** PRO-42: P ≠ A somewhere, or allowed outbox ops (PRO-06's withheld hold drafts do not count). */
export async function publishPending(core: EngineCore, it: IterationCtx): Promise<boolean> {
  const states = it.pushStates;
  if (core.outbox.pendingAllowed(states, withholdOf(core, it))) return true;
  // Plan 3 Task 10 (HLD-39): code is pending only while a publication group is ready (allowedPending's predicate).
  if (states.length !== 0 || !composable(core, it)) return false;
  try {
    return diffPaths(it.A, (await compose(core, it)).P).length > 0;
  } catch (e) {
    if (e instanceof ReadyBaseMismatchError) return true;   // pending; the publish aborts with ENG-39's report
    if (e instanceof HoldOperatorError) return true;        // pending; the publish raises HOLD_MASK_INVALID (05 F1)
    throw e;
  }
}

// ---- hold mirrors (Plan 3 Task 4; HLD-10, HLD-62, HLD-64, PRO-06, PRO-21 writer side, PRO-24; R3-24…R3-29, R3-56) ---------

/** PRO-06 / glossary §20: the folded record cap at which hold creations are withheld and BOARD_FULL is told. */
export const BOARD_RECORD_CAP = 5_000;

/**
 * A hold draft whose op Bnew would carry with a held/ put (planHeld): not a stub, not terminal, and its record has a held
 * side. A terminal draft is never one: on a cap refusal it is placed without a put (its held/<id>/ carried as the tip has it,
 * which the fold accepts for a terminal op), because ending ops are always allowed (02 §3.1, PRO-06).
 */
function wouldPut(core: EngineCore): (d: OpDraft) => boolean {
  return (d) => {
    if (d.type !== 'hold') return false;
    const h = d as Omit<HoldOp, 'id'>;
    if (h.local_only || TERMINAL_OP_STATES.has(h.state)) return false;
    const r = core.holds.get(h.hold_id);
    return r !== undefined && heldBlobs(r).length > 0;
  };
}

/**
 * PRO-06: what the take withholds. At the record cap, record-creating hold drafts (isHoldCreation). On the board tip at which
 * this run's last build had its held/ puts refused by the 5 MB tree cap (02 §3.1, R3-74; round-1 ruling), the put-carrying
 * hold drafts (wouldPut): the same tip refuses them again, so they neither leave nor count as pending until the tip changes.
 * Undefined when neither applies.
 */
function withholdOf(core: EngineCore, it: IterationCtx): ((d: OpDraft) => boolean) | undefined {
  const records = it.fold.record_count >= BOARD_RECORD_CAP;
  const tree = it.T !== ABSENT && memoryOf(core).boardFull.treeTip === it.T;
  if (!records && !tree) return undefined;
  const put = wouldPut(core);
  return (d) => (records && isHoldCreation(d)) || (tree && put(d));
}

/**
 * What an open withholding episode keeps back, for mirrorSync's chaining (fix round 2): at the record cap the record-creating
 * hold drafts; while the tree-cap episode is open (bf.tree, not tip-keyed: a prev_rev loop moves the tip every window) the
 * put-carrying ones. Undefined when neither applies. The take keeps withholdOf (tip-keyed) so a new tip retries the puts.
 */
function heldBackOf(core: EngineCore, it: IterationCtx): ((d: OpDraft) => boolean) | undefined {
  const records = it.fold.record_count >= BOARD_RECORD_CAP;
  const tree = memoryOf(core).boardFull.tree;
  if (!records && !tree) return undefined;
  const put = wouldPut(core);
  return (d) => (records && isHoldCreation(d)) || (tree && put(d));
}

/**
 * Fix round 2: a record whose outbox hold ops are split by the withholding (a held-back op followed by one that is not, e.g. an
 * allocated update withheld by the tree cap and a terminal op chained on it whose push failed, or a creation allocated before
 * the record cap and an update chained on it) has every hold op dropped: the later op would leave alone and fold as a prev_rev
 * rejection against the folded rev, every window. None of them has landed (push-intent resolution runs before mirrorSync), so
 * the record is re-drafted from the folded state by step (2). Returns the ids dropped.
 */
function dropSplitChains(core: EngineCore, heldBack: (d: OpDraft) => boolean): Set<string> {
  const chains = new Map<string, boolean[]>();
  const idOf = (d: OpDraft): string | null => (d.type === 'hold' ? (d as Omit<HoldOp, 'id'>).hold_id : null);
  for (const d of core.outbox.drafts()) {
    const id = idOf(d);
    if (id === null) continue;
    const c = chains.get(id) ?? [];
    c.push(heldBack(d));
    chains.set(id, c);
  }
  const split = new Set<string>();
  for (const [id, c] of chains) {
    const first = c.indexOf(true);
    if (first >= 0 && c.slice(first + 1).some((held) => !held)) split.add(id);
  }
  if (split.size > 0) core.outbox.drop((d) => split.has(idOf(d) ?? ''));
  return split;
}

/**
 * The newest board tip's held/ subtrees per core (R3-26: one readHeldAll per fetched board oid — the bounded held/ walk of
 * boardCommit.ts, a `rev-list --objects` of its trees and `cat-file --batch-check`/`--batch` of the ones its per-tree cache lacks,
 * never an `ls-tree -r`; final review F13 r2 E-1/E-2/E-3).
 */
const heldCache = new WeakMap<EngineCore, { board: Oid; map: ReadonlyMap<string, readonly HeldBlob[]> }>();

/** The board tip's held/ subtrees, cached by board oid (one readHeldAll per new tip, R3-26). */
export async function heldOfTip(core: EngineCore, board: Oid): Promise<ReadonlyMap<string, readonly HeldBlob[]>> {
  const hit = heldCache.get(core);
  if (hit !== undefined && hit.board === board) return hit.map;
  const map = await readHeldAll(core.repo, board);
  heldCache.set(core, { board, map });
  return map;
}

/** What mirrorSync remembers per core (in memory; a restart starts empty). */
interface MirrorMemory {
  /** Per hold id: the canonical draft mirrorSync last queued and the mirror key it was drafted for (the held side is not in the op). */
  drafts: Map<string, { draft: string; key: string }>;
  /** `<id>@<rev>` whose unreadable held blob was told (HOLD_MASK_INVALID once per record rev). */
  unreadable: Set<string>;
  /**
   * PRO-06 BOARD_FULL episodes. record: the record-cap episode is open (from the first withheld creation until the folded
   * record_count is below the cap). tree: the tree-cap episode is open (from a build whose held/ puts the 5 MB cap refused
   * until a build with puts succeeds or no put-carrying draft waits); treeTip: the board tip of the newest such refusal.
   * lastEnd: the folded height at which the previous episode of this run ended (both closed).
   */
  boardFull: { record: boolean; tree: boolean; treeTip: Oid | null; lastEnd: number | null };
}
const memories = new WeakMap<EngineCore, MirrorMemory>();
function memoryOf(core: EngineCore): MirrorMemory {
  let m = memories.get(core);
  if (m === undefined) {
    m = { drafts: new Map(), unreadable: new Set(), boardFull: { record: false, tree: false, treeTip: null, lastEnd: null } };
    memories.set(core, m);
  }
  return m;
}

/** PRO-06: a BOARD_FULL episode (the record cap or the tree cap) is open on this core (Task 12b: holdCodeCurrent's BOARD_FULL rule). */
export function boardFullOpen(core: EngineCore): boolean {
  const bf = memoryOf(core).boardFull;
  return bf.record || bf.tree;
}

/** The newest hold code to status (core.holdCode, R-27) and the code to the daemon log. */
function raiseHold(core: EngineCore, level: 'warn' | 'error', code: string, params: Record<string, string>): void {
  core.holdCode = { code, params };
  core.deps.log.write(level, code, params);
}

/**
 * BOARD_FULL to status and the log with 02-protocol §2.1's params: records = the folded record count, cap = the cap that
 * withholds (BOARD_RECORD_CAP records, BOARD_TREE_MAX_BYTES for the board tree, or HELD_LISTING_MAX_BYTES for the held/ listing).
 */
function raiseBoardFull(core: EngineCore, it: IterationCtx, cap: number): void {
  raiseHold(core, 'warn', 'BOARD_FULL', { records: String(it.fold.record_count), cap: String(cap) });
}

/**
 * A build on tip T had its held/ puts refused by the 5 MB tree cap (round-1 ruling) or the held/ listing cap (final review F13 r2
 * E-1, same growth rule): T is remembered (withholdOf withholds the put-carrying drafts on it) and, when no tree-cap episode is
 * open, one opens with BOARD_FULL {records, cap} — cap = the cap that tripped (BoardCapError.cap; EF5 minors):
 * HELD_LISTING_MAX_BYTES (33554432) for the listing, else BOARD_TREE_MAX_BYTES (5000000); the next mirrorSync drafts the
 * episode's health event.
 */
function openTreeEpisode(core: EngineCore, it: IterationCtx, T: Oid, tripped: number): void {
  const bf = memoryOf(core).boardFull;
  bf.treeTip = T;
  if (bf.tree) return;
  bf.tree = true;
  raiseBoardFull(core, it, tripped === HELD_LISTING_MAX_BYTES ? HELD_LISTING_MAX_BYTES : BOARD_TREE_MAX_BYTES);
}

/** The tree-cap episode closes (a build with puts succeeded, or no put-carrying draft waits); lastEnd when no episode stays open. */
function endTreeEpisode(core: EngineCore, it: IterationCtx): void {
  const bf = memoryOf(core).boardFull;
  if (!bf.tree) return;
  bf.tree = false;
  bf.treeTip = null;
  if (!bf.record) bf.lastEnd = it.fold.height;
}

const TERMINAL_OP_STATES: ReadonlySet<string> = TERMINAL_STATES;
const foldedOf = (fold: FoldState, id: string): FoldedHold | undefined => (Object.hasOwn(fold.holds, id) ? fold.holds[id] : undefined);
const draftText = (d: Omit<HoldOp, 'id'>): string => canonicalJson(d as unknown as Json);
/** A draft's fields every rev shares (no rev/prev_rev). */
function sansRev(d: Omit<HoldOp, 'id'>): string {
  const { rev: _rev, prev_rev: _prev, ...rest } = d;
  return canonicalJson(rest as unknown as Json);
}

/**
 * The pending draft shows what r's mirror key asks for: the key it was drafted for (this run), else — after a restart, when the
 * held side is unknown — its projection, because the Bnew that carries it puts the current registry's held/ (R3-26).
 */
function pendingShows(mem: MirrorMemory, r: HoldRecord, pending: Omit<HoldOp, 'id'>, key: string): boolean {
  const known = mem.drafts.get(r.id);
  if (known !== undefined && known.draft === draftText(pending)) return known.key === key;
  return sansRev(pending) === sansRev(projectOp(r, null));
}

/**
 * R3-27 / PRO-24 bullet 3 / R3-70: a non-race rejection of r (an own fold rejection other than prev_rev, or the local writer
 * check) is recorded in local.rejected with r's current mirror key and told once — HOLD_MIRROR_REJECTED {hold_id, reason} to
 * status and the log (PRO-38) — only when local.rejected changes. True when it changed.
 */
async function recordRejection(core: EngineCore, r: HoldRecord, reason: MirrorRejectReason): Promise<boolean> {
  const key = mirrorKey(r);
  const local = core.holds.local().rejected;
  const had = Object.hasOwn(local, r.id) ? local[r.id] : undefined;
  if (had !== undefined && had.key === key && had.reason === reason) return false;
  await core.holds.markMirrorRejected(r.id, key, reason);
  raiseHold(core, 'warn', 'HOLD_MIRROR_REJECTED', { hold_id: r.id, reason });
  return true;
}

/** A blob read that failed for the object (a corrupt or missing loose object): git's refusal or the batch parser's. */
const unreadableError = (e: unknown): boolean => e instanceof GitCommandError || e instanceof OidError || (e instanceof Error && Object.getPrototypeOf(e) === Error.prototype);

/**
 * 05 F1 / 05 §6 "Registry blob corrupt" (R3-20): every heldBlobs(r) blob reads (cat-file); a blob that cannot be read leaves r
 * undrafted and raises HOLD_MASK_INVALID {op: 'mirror', path, hold_id} once per record rev. False when one cannot be read.
 */
async function heldReadable(core: EngineCore, mem: MirrorMemory, r: HoldRecord): Promise<boolean> {
  const blobs = heldBlobs(r);
  if (blobs.length === 0) return true;
  try {
    await core.repo.readBlobs(blobs.map((b) => b.oid));
    return true;
  } catch (e) {
    if (!unreadableError(e)) throw e;
  }
  let bad = blobs[0]!;
  for (const b of blobs) {
    try {
      await core.repo.readBlob(b.oid);
    } catch (e) {
      if (!unreadableError(e)) throw e;
      bad = b;
      break;
    }
  }
  const told = `${r.id}@${r.rev}`;
  if (!mem.unreadable.has(told)) {
    mem.unreadable.add(told);
    raiseHold(core, 'error', 'HOLD_MASK_INVALID', { op: 'mirror', path: bad.path, hold_id: r.id });
  }
  return false;
}

/** p is LIVE in this iteration's scope (a path the scope cannot classify is not: PRO-21 fails closed). */
function liveIn(it: IterationCtx): (p: string) => boolean {
  return (p) => {
    try {
      return it.scope(p).cls === 'LIVE';
    } catch {
      return false;
    }
  };
}

/** PRO-06: BOARD_FULL is posted for this episode when the outbox or the fold already holds an own BOARD_FULL health event newer than the previous episode's end. */
function boardFullPosted(core: EngineCore, fold: FoldState, lastEnd: number | null): boolean {
  const isBoardFull = (d: OpDraft): boolean => d.type === 'event' && d.kind === 'health' && d.reason_code === 'BOARD_FULL';
  if (core.outbox.drafts().some(isBoardFull)) return true;
  return Object.values(fold.events).some((e) => e.kind === 'health' && e.reason_code === 'BOARD_FULL' && parseOpId(e.op_id)?.peer === core.peerId && e.height > (lastEnd ?? -1));
}

/**
 * Runs first in publishStep (after its intent gates) and at start and restart (Task 12b). (1) R3-27: drains
 * Folder.takeHoldRejections(); a prev_rev rejection is a race and is re-drafted by (2) from the folded rev (the rejected op landed
 * and left the outbox, so the folded entry no longer shows the record's mirror key), at most once per folded rejection; every
 * other reason is recorded (recordRejection). (2) For every record whose mirrorKey differs from both its folded entry (with the
 * tip's held/<id>/ from heldOfTip) and its pending draft, and that local.rejected does not hold with that key: projectOp(r,
 * prevRev) through Outbox.replaceHold, prevRev = the rev of r's newest allocated pending op, else its folded rev, else null —
 * subject to creationDue (a creation only), checkMirror (a failure is a local non-race rejection, R3-25) and every held blob
 * reading (05 F1). A record that turned local_only first drops its pending non-stub ops, so no Bnew carries one beside the
 * removal of its held/<id>/. Likewise (fix round 2) a record never chains on an op the open withholding keeps back (heldBackOf:
 * a creation at the record cap, a put while the tree-cap episode is open): those never-landed ops are dropped first and the
 * draft chains on the folded rev, and a record whose hold ops that withholding splits (a held-back op followed by one that is
 * not) loses them all before the scan — otherwise the later op leaves alone and folds as a prev_rev rejection every window.
 * A durable record that local.rejected names is cleared there. A terminal record gets an op only while
 * the fold holds a non-terminal entry for its id or the record has a pending or allocated op (R3-26, R3-29). (3) PRO-06: while
 * the fold is at the record cap and a hold creation waits in the outbox, or a tree-cap episode is open (a build whose held/ puts
 * the 5 MB cap refused, while a put-carrying draft waits; round-1 ruling), one event{kind: health, reason_code: BOARD_FULL} per
 * episode (not withheld: no health event is record-creating or puts held/), and BOARD_FULL {records, cap} to status and the
 * log once per episode (02-protocol §2.1).
 */
export async function mirrorSync(core: EngineCore, it: IterationCtx): Promise<{ drafted: string[]; rejected: string[] }> {
  const drafted: string[] = [];
  const rejected: string[] = [];
  if (it.T === ABSENT) return { drafted, rejected };
  const reg = core.holds;
  const mem = memoryOf(core);
  const tipHeld = await heldOfTip(core, it.T);

  // (1) R3-27: own hold rejections.
  for (const x of core.folder.takeHoldRejections()) {
    if (x.holdId === null || x.reason === 'prev_rev') continue;
    const r = reg.get(x.holdId);
    if (r !== undefined && (await recordRejection(core, r, x.reason)) && !rejected.includes(r.id)) rejected.push(r.id);
  }

  // (2) Records whose mirror key the board and the outbox do not show. First (fix round 2) a record whose hold ops the open
  // withholding splits loses them all and is re-drafted from the folded state.
  const heldBack = heldBackOf(core, it);
  if (heldBack !== undefined) for (const id of dropSplitChains(core, heldBack)) mem.drafts.delete(id);
  const todo: Array<{ r: HoldRecord; folded: FoldedHold | undefined; key: string }> = [];
  for (const r of reg.all()) {
    const folded = foldedOf(it.fold, r.id);
    const key = mirrorKey(r);
    const local = reg.local().rejected;
    const rej = Object.hasOwn(local, r.id) ? local[r.id] : undefined;
    if (rej !== undefined && rej.key === key) continue;
    if (mirrorShown(r, folded, tipHeld.get(r.id) ?? null)) {
      if (rej !== undefined) await reg.clearMirrorRejected(r.id);   // durable (or a folded stub) again
      continue;
    }
    const pending = core.outbox.pendingHold(r.id);
    if (isTerminal(r) && (folded === undefined || TERMINAL_OP_STATES.has(folded.state)) && pending === null) continue;
    if (pending !== null && pendingShows(mem, r, pending, key)) continue;
    todo.push({ r, folded, key });
  }
  if (todo.length > 0) await ensureAttrs(core, it.epochBase, todo.flatMap((x) => x.r.paths));
  const live = liveIn(it);
  for (const { r, folded, key } of todo) {
    const allocated = core.outbox.allocatedHold(r.id);
    const prevRev = allocated?.rev ?? folded?.rev ?? null;
    if (prevRev === null && !creationDue(r, reg.ageMs(r))) continue;
    const check = checkMirror(r, live);
    if (!check.ok) {
      if ((await recordRejection(core, r, check.reason)) && !rejected.includes(r.id)) rejected.push(r.id);
      continue;
    }
    if (!(await heldReadable(core, mem, r))) continue;
    // Never chain on an op that cannot leave before this one (fix round 2): r's held-back ops (a withheld creation at the record
    // cap, a withheld put at the tree cap; never landed, push-intent resolution ran first) are dropped like the non-stub ops of
    // a record turned local_only, and the draft chains on what is left, else the folded rev. A terminal record left with no
    // pending op and no non-terminal folded entry then needs no op at all (R3-26).
    let dropped = heldBack === undefined ? 0 : core.outbox.drop((d) => d.type === 'hold' && d.hold_id === r.id && heldBack(d));
    if (r.local_only) dropped += core.outbox.drop((d) => d.type === 'hold' && d.hold_id === r.id && !d.local_only);
    let prev = prevRev;
    if (dropped > 0) {
      if (isTerminal(r) && (folded === undefined || TERMINAL_OP_STATES.has(folded.state)) && core.outbox.pendingHold(r.id) === null) {
        mem.drafts.delete(r.id);
        continue;
      }
      prev = core.outbox.allocatedHold(r.id)?.rev ?? folded?.rev ?? null;
    }
    const draft = projectOp(r, prev);
    core.outbox.replaceHold(draft);
    mem.drafts.set(r.id, { draft: draftText(draft), key });
    drafted.push(r.id);
  }

  // (3) PRO-06: BOARD_FULL once per episode, and one BOARD_FULL health event per episode, while hold drafts are withheld at
  // the record cap (creations) or the tree cap (puts; the episode is opened by buildAndJournal's refused build).
  const bf = mem.boardFull;
  const wasOpen = bf.record || bf.tree;
  if (it.fold.record_count < BOARD_RECORD_CAP) {
    bf.record = false;
  } else if (!bf.record && core.outbox.drafts().some(isHoldCreation)) {
    bf.record = true;
    raiseBoardFull(core, it, BOARD_RECORD_CAP);
  }
  if (bf.tree && !core.outbox.drafts().some(wouldPut(core))) endTreeEpisode(core, it);
  if (wasOpen && !bf.record && !bf.tree) bf.lastEnd = it.fold.height;
  if ((bf.record || bf.tree) && !boardFullPosted(core, it.fold, bf.lastEnd)) {
    core.outbox.add({ type: 'event', cid: '', kind: 'health', refs: [], reason_code: 'BOARD_FULL' });
  }
  return { drafted, rejected };
}

/**
 * PRO-25 / 02 §3.3 "Determinism" (Task 4): the hold mirrors a re-anchor re-issues from the registry against the folded rev on
 * the recovered chain (`fold` at `board`, V): one draft per record that is not durable there — under mirrorSync's rules with
 * no outbox (the old epoch's hold drafts are dropped), so prevRev is the folded rev; a terminal record only while the fold holds
 * a non-terminal entry for it or `hadPending(id)` (it had an unlanded op of the old epoch); creationDue, checkMirror over `live`
 * and the held-blob reads apply (a record failing them gets none here: the next mirrorSync handles it). In ULID order.
 */
export async function reanchorMirrors(core: EngineCore, board: Oid, fold: FoldState, live: (p: string) => boolean, hadPending: (id: string) => boolean): Promise<Array<Omit<HoldOp, 'id'>>> {
  const reg = core.holds;
  const mem = memoryOf(core);
  const tipHeld = await heldOfTip(core, board);
  const out: Array<Omit<HoldOp, 'id'>> = [];
  for (const r of reg.all()) {
    const folded = foldedOf(fold, r.id);
    const key = mirrorKey(r);
    const local = reg.local().rejected;
    if (Object.hasOwn(local, r.id) && local[r.id]!.key === key) continue;
    if (mirrorShown(r, folded, tipHeld.get(r.id) ?? null)) continue;
    if (isTerminal(r) && (folded === undefined || TERMINAL_OP_STATES.has(folded.state)) && !hadPending(r.id)) continue;
    const prevRev = folded?.rev ?? null;
    if (prevRev === null && !creationDue(r, reg.ageMs(r))) continue;
    if (!checkMirror(r, live).ok || !(await heldReadable(core, mem, r))) continue;
    const draft = projectOp(r, prevRev);
    mem.drafts.set(r.id, { draft: draftText(draft), key });
    out.push(draft);
  }
  return out;
}

/** R3-EF4-24: per core, blob oid → it carries a restore-marker row (blobs never change; cleared past MARKER_VERDICTS_MAX entries). */
const markerVerdicts = new WeakMap<EngineCore, Map<string, boolean>>();
const MARKER_VERDICTS_MAX = 65_536;

/**
 * R3-EF4-24 (DAT-46): of `oids`, those whose blob carries a restore-marker row (`marked`: hasRestoreMarkerRow, as ENG-41 (j) reads it)
 * and those that could not be read (`unknown`: never counted marker-free, so never put — and never remembered, so a later window reads
 * them again). One cat-file --batch for the oids not known yet (none when all are); Ruling R3-EF4-31 (EF5 merge M-2): a batch that fails
 * learns nothing about any one object, so each is then read alone (as heldReadable does) and only an oid that cannot be read by itself
 * stays unknown.
 */
async function markerBearing(core: EngineCore, oids: readonly Oid[]): Promise<{ marked: ReadonlySet<string>; unknown: ReadonlySet<string> }> {
  let known = markerVerdicts.get(core);
  if (known === undefined || known.size > MARKER_VERDICTS_MAX) {
    known = new Map();
    markerVerdicts.set(core, known);
  }
  const verdicts = known;
  const want = [...new Set(oids)].filter((o) => !verdicts.has(o));
  if (want.length > 0) {
    try {
      const bufs = await core.repo.readBlobs(want);
      want.forEach((o, i) => verdicts.set(o, hasRestoreMarkerRow(bufs[i]!)));
    } catch (e) {
      if (!unreadableError(e)) throw e;
      for (const o of want) {
        try {
          verdicts.set(o, hasRestoreMarkerRow(await core.repo.readBlob(o)));
        } catch (e1) {
          if (!unreadableError(e1)) throw e1;
        }
      }
    }
  }
  return { marked: new Set(oids.filter((o) => verdicts.get(o) === true)), unknown: new Set(oids.filter((o) => !verdicts.has(o))) };
}

/** Bnew's held/ edit (R3-56, PRO-21, PRO-27) for the ops the take placed, the checkpoint's heldIds, ENG-41 (j)'s puts and the trace. */
interface HeldPlan {
  edit: BoardBuild['held'];
  heldIds: string[];
  added: Array<{ holdId: string; path: string; stage: HeldBlob['stage']; oid: Oid; localOnly: boolean; live: boolean }>;
  mirrored: Array<{ id: string; rev: number; localOnly: boolean; held: number }>;
  /** R3-EF4-31 (M-2): the records whose non-terminal op would lose its put only because a held blob could not be read (and that blob's path). */
  unreadable: Array<{ holdId: string; path: string }>;
}

/**
 * held.put = heldBlobs(r) of the current registry rev for every non-local_only op the take placed whose record has a non-empty
 * held side (never an empty put: buildHeldTree refuses one, R3-56); held.remove = every record turned local_only (and every
 * stub op's record) whose held/<id>/ the tip still has, plus holdsCompactedAt(fold at tip, tip height + 1) (PRO-27 writer side);
 * an id removed is never put. heldIds = the tip's held/ ids minus the removed plus the put (the checkpoint fold's BoardDraft).
 * puts false (the rebuild after a tree-cap refusal, whose take withheld every put-carrying draft): no put at all, so a
 * terminal op carries its held/<id>/ as the tip has it (or none) — the fold requires held/<id>/ of non-terminal ops only.
 * Ruling R3-EF4-24 (DAT-46 defence in depth; E16-E): no put ever carries a blob with a restore-marker row, for any record, terminal
 * included — such a record's whole put is left out (never a partial held/<id>/). The registry makes such a record local_only, so
 * only one an older build wrote reaches this: its terminal op lands without a put; a non-terminal op lands without its held/<id>/
 * and folds as a held_subtree rejection (HOLD_MIRROR_REJECTED, mirrorSync), so no marker byte leaves and no window aborts on (j).
 * Ruling R3-EF4-31 (EF5 merge M-2): only a blob confirmed to carry a marker row gives that putless placement. A record whose put would
 * drop only because a held blob could not be read (markerBearing's `unknown`) is listed in `unreadable` when the take placed a
 * non-terminal op of it (that op would fold as a held_subtree rejection and stay rejected under its unchanged mirror key): the caller
 * holds its ops back this window with HOLD_MASK_INVALID, as heldReadable does at the draft. A terminal op keeps the putless placement
 * (the fold accepts it without held/<id>/, and ending ops always leave, PRO-06).
 */
async function planHeld(core: EngineCore, it: IterationCtx, T: Oid, ops: readonly Op[], puts = true): Promise<HeldPlan> {
  const tipHeld = await heldOfTip(core, T);
  const holdOps = ops.filter((o): o is HoldOp => o.type === 'hold');
  const remove = new Set<string>();
  for (const r of core.holds.all()) if (r.local_only && tipHeld.has(r.id)) remove.add(r.id);
  for (const op of holdOps) if (op.local_only && tipHeld.has(op.hold_id)) remove.add(op.hold_id);
  for (const id of holdsCompactedAt(it.fold, it.fold.height + 1)) if (tipHeld.has(id)) remove.add(id);
  const candidates = new Map<string, HeldBlob[]>();
  for (const op of holdOps) {
    const r = core.holds.get(op.hold_id);
    if (puts && r !== undefined && !op.local_only && !remove.has(op.hold_id) && !candidates.has(op.hold_id)) {
      const blobs = heldBlobs(r);
      if (blobs.length > 0) candidates.set(op.hold_id, blobs);
    }
  }
  const { marked, unknown } = await markerBearing(core, [...candidates.values()].flatMap((bs) => bs.map((b) => b.oid)));
  const put = new Map<string, HeldBlob[]>();
  const unreadable: HeldPlan['unreadable'] = [];
  for (const [id, blobs] of candidates) {
    if (blobs.some((b) => marked.has(b.oid))) continue;   // a marker row: the putless placement above
    const bad = blobs.find((b) => unknown.has(b.oid));
    if (bad === undefined) put.set(id, blobs);
    else if (holdOps.some((op) => op.hold_id === id && !TERMINAL_OP_STATES.has(op.state))) unreadable.push({ holdId: id, path: bad.path });
  }
  const mirrored: HeldPlan['mirrored'] = [];
  for (const op of holdOps) mirrored.push({ id: op.hold_id, rev: op.rev, localOnly: op.local_only, held: put.get(op.hold_id)?.length ?? 0 });
  const added: HeldPlan['added'] = [];
  if (put.size > 0) {
    await ensureAttrs(core, it.epochBase, [...put.values()].flatMap((bs) => bs.map((b) => b.path)));
    const live = liveIn(it);
    for (const [id, blobs] of put) {
      const localOnly = core.holds.get(id)!.local_only;
      for (const b of blobs) added.push({ holdId: id, path: b.path, stage: b.stage, oid: b.oid, localOnly, live: live(b.path) });
    }
  }
  const heldIds = [...new Set([...[...tipHeld.keys()].filter((id) => !remove.has(id)), ...put.keys()])].sort();
  return { edit: put.size + remove.size > 0 ? { put, remove } : undefined, heldIds, added, mirrored, unreadable };
}

/**
 * R3-EF4-31 (EF5 merge M-2): `base` (PRO-06's withholding, withholdOf) widened by the hold drafts of the records planHeld could not
 * read a held blob of this window: they neither leave nor count as pending.
 */
function withUnreadable(base: ((d: OpDraft) => boolean) | undefined, ids: ReadonlySet<string>): ((d: OpDraft) => boolean) | undefined {
  if (ids.size === 0) return base;
  return (d) => (base !== undefined && base(d)) || (d.type === 'hold' && ids.has((d as Omit<HoldOp, 'id'>).hold_id));
}

/** HOLD_MASK_INVALID {op: 'mirror', path, hold_id} for a held blob of r that cannot be read, once per record rev (heldReadable's rule). */
function tellUnreadable(core: EngineCore, id: string, path: string): void {
  const told = `${id}@${core.holds.get(id)?.rev ?? 0}`;
  const mem = memoryOf(core);
  if (mem.unreadable.has(told)) return;
  mem.unreadable.add(told);
  raiseHold(core, 'error', 'HOLD_MASK_INVALID', { op: 'mirror', path, hold_id: id });
}

// ---- OUT (01-engine §3.10, publish side) ---------------------------------------------------------------------------

interface Merged {
  outTree: Oid; out: TreeMap;
  conflicted: string[]; replaced: Array<{ path: string; blob: string | null }>;
  records: string[];
}

/**
 * OUT = merge-tree --merge-base=A P TIP, then the rename carry and the conflict function, each as a whole-path replacement
 * of the merge result; a TAKE_TIP displacement is recorded (K4 PATCH, CONFLICTED, ON_DISK) before anything is pushed.
 */
async function buildOut(core: EngineCore, it: IterationCtx, comp: PublishComposition, aTree: Oid, pTree: Oid, tipTree: Oid, trial = false): Promise<Merged> {
  const { repo, deps } = core;
  const view = core.view!;
  const A = it.A;
  const P = comp.P;
  const TIP = it.tipMap;
  const merged = await mergeTree(repo, aTree, pTree, tipTree);
  // A T0 trial (Plan 3 Task 10) is no publish merge: no merge event, and its TAKE_TIP paths make no K4 record (below).
  if (!trial) {
    deps.trace.emit({
      kind: 'merge', peer: core.peerId, use: 'publish', base: aTree, ours: pTree, theirs: tipTree, aTree, laC: view.laC, laB: view.laB, tip: it.tip,
      t: it.T as Oid, rc: merged.rc,
    });
  }
  const R = await repo.readTreeMap(merged.tree);
  const OUT = new Map<string, TreeEntry>(R);
  const replaced = new Map<string, TreeEntry | null>();
  const replace = (p: string, e: TreeEntry | undefined): void => {
    if (e === undefined) OUT.delete(p);
    else OUT.set(p, { path: p, mode: e.mode, oid: e.oid });
    replaced.set(p, e === undefined ? null : { path: p, mode: e.mode, oid: e.oid });
  };

  // Rename carry: q kept by P (P[q] == A[q]) whose result is not TIP[q] takes TIP[q]; a source p changed by P, absent in
  // TIP and in the result goes to the conflict function as a rename unit (stages A[p], P[p], ABSENT).
  const all = new Set<string>([...A.keys(), ...P.keys(), ...TIP.keys(), ...R.keys()]);
  const carried = new Set<string>();
  const sources: string[] = [];
  for (const p of [...all].sort()) {
    if (!editable(p)) continue;
    const a = A.get(p);
    const o = P.get(p);
    const t = TIP.get(p);
    const res = R.get(p);
    if (sameEntry(o, a) && !sameEntry(res, t)) {
      replace(p, t);
      carried.add(p);
    } else if (o !== undefined && !sameEntry(o, a) && t === undefined && res === undefined) {
      sources.push(p);
    }
  }

  const fold = it.fold;
  let epochMap: TreeMap | null = null;
  const ctx: ConflictCtx = {
    repo,
    isText: (p) => pathIsText(core, p),
    insertionMerge: (p) => core.config.merge.insertionMerge.some((g) => wildmatch(g, p)),
    concatAllowed: liveSet(fold).every((p) => fold.peers[p]?.regionSpec === deps.regionSpec),
    localOnly: () => false,
    ref: async (p) => {
      let e = A.get(p);
      if (e === undefined) {
        epochMap ??= await repo.readTreeMap((await repo.readCommit(it.epochBase)).tree);
        e = epochMap.get(p);
      }
      return e === undefined || !isRegular(e) ? null : repo.readBlob(e.oid);
    },
    write: true,
  };
  const takeTip = new Map<string, { s1: OidOrAbsent; s2: OidOrAbsent; s3: OidOrAbsent }>();
  const route = (p: string, v: ConflictVerdict): void => {
    if (v.kind === 'CONCAT') {
      replace(p, { path: p, mode: P.get(p)?.mode ?? TIP.get(p)?.mode ?? '100644', oid: v.blob });
    } else if (v.kind === 'TAKE_TIP') {
      replace(p, v.entry === ABSENT ? undefined : TIP.get(p));
      takeTip.set(p, v.stages);
    } else {
      replace(p, TIP.get(p));   // DEFER (no Plan 2 source): nothing of p is published
    }
  };
  for (const p of sources) route(p, await conflict(ctx, p, A.get(p)?.oid ?? ABSENT, P.get(p)!.oid, ABSENT, 'other'));
  const handled = new Set<string>([...carried, ...sources]);
  for (const p of merged.conflicted) {
    if (handled.has(p)) continue;
    const a = A.get(p);
    const o = P.get(p);
    const t = TIP.get(p);
    const content = isRegular(a) && isRegular(o) && isRegular(t) && a.mode === o.mode && o.mode === t.mode;
    const unit: UnitKind = content ? 'content' : 'other';
    route(p, await conflict(ctx, p, a?.oid ?? ABSENT, o?.oid ?? ABSENT, t?.oid ?? ABSENT, unit));
  }

  // A path of P under a path that is a file in OUT (a teammate made `d` a file while this peer added `d/x`; the rename
  // carry put TIP's `d` back over merge-tree's `d~<theirs>`): one tree cannot hold both, and editTreeIndexOnly's
  // --replace would drop p without a word (final review FC minor). TIP keeps its file and p is displaced like any
  // TAKE_TIP: a K4 record holds LOCAL (stages A[p], P[p], ABSENT), which stays on disk.
  const underFile: string[] = [];
  for (const p of [...OUT.keys()].sort()) {
    const o = P.get(p);
    if (!editable(p) || takeTip.has(p) || o === undefined || sameEntry(o, A.get(p)) || TIP.has(p)) continue;
    const parts = p.split('/');
    if (!parts.slice(1).some((_, i) => OUT.has(parts.slice(0, i + 1).join('/')))) continue;
    replace(p, undefined);
    takeTip.set(p, { s1: A.get(p)?.oid ?? ABSENT, s2: o.oid, s3: ABSENT });
    underFile.push(p);
  }

  // K4 records before the push (R-02 publish side: born ON_DISK, LOCAL is still on disk; MASK step 4 then resets every later P[p]).
  const records: string[] = [];
  for (const [p, stages] of [...takeTip].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
    if (trial) break;
    records.push(await core.holds.hold({
      kind: 'PATCH', residence: 'ON_DISK', state: 'CONFLICTED', paths: [p],
      blobs: { s1: { [p]: stages.s1 }, s2: { [p]: stages.s2 }, s3: { [p]: stages.s3 } },
      guard: 'conflict', origin: 'daemon', cs_ids: comp.csIds.filter((id) => comp.csPaths.get(id)?.includes(p) === true),
      displaced_by: null, local_only: it.scope(p).cls !== 'LIVE',
    }));
  }

  const outTree = await editTreeIndexOnly(repo, deps.ports.fs, merged.tree, editsBetween(R, OUT), core.scratch('out'));
  return {
    outTree, out: outTree === merged.tree ? R : await repo.readTreeMap(outTree),
    conflicted: [...new Set([...merged.conflicted, ...sources, ...underFile])].sort(),
    replaced: [...replaced].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([path, e]) => ({ path, blob: e === null ? null : e.oid })),
    records,
  };
}

// ---- governedPush (PRO-41) ------------------------------------------------------------------------------------------

/**
 * PRO-41: the one function that spawns a push (runPush, or deleteProbeRef for a deleteProbe body): governor gate (exempt per
 * R-21), attempt counted (onAttemptStart), the push, slow-push and HTTP throttle signals; then `classify(raw)`; only after it
 * returns: onAttemptEnd (its transient/landed come from the AttemptClass) and trace 'push' with the classified outcome (a
 * KilledAt inside classify leaves that attempt untraced). Slowness is Δmono on the core's clock around the spawn.
 */
export async function governedPush(
  core: EngineCore, purpose: PushPurpose, body: GovernedBody, exempt: boolean, rank: number,
  classify: (raw: PushOutcomeRaw) => Promise<AttemptClass>, opts?: { pushOptions?: readonly string[] },
): Promise<{ raw: PushOutcomeRaw; cls: AttemptClass } | 'denied'> {
  const { deps, governor } = core;
  const clock = deps.ports.clock;
  // '-o <opt>' per option: the caller's (the probe's step-4 ci.skip, sent while the caps are still being probed), else
  // ci.skip whenever the folded team caps say the host accepts push options (publishStep's rule).
  const pushOptions: readonly string[] = opts?.pushOptions ?? (core.caps?.push_options === true ? ['ci.skip'] : []);
  const bnew = 'specs' in body ? (body.specs.find((s) => s.ref === core.refs.remoteBoard)?.newOid ?? null) : null;
  // A malformed body throws before the gate counts anything (the only remote deletion is the own probe ref, INV-OID).
  if ('specs' in body) buildPushArgv(deps.url, body.specs, pushOptions);
  else if (body.deleteProbe.ref !== core.refs.probe(core.peerId)) throw new Error(`governedPush: ${JSON.stringify(body.deleteProbe.ref)} is not this peer's probe ref`);
  if (!governor.mayAttempt(rank, true, true, exempt)) {
    deps.trace.emit({ kind: 'push', peer: core.peerId, purpose, argv: [], bnew, outcome: 'denied' });
    return 'denied';
  }
  governor.onAttemptStart();
  core.pushAttempts += 1;
  core.lastPushMono = clock.monoMs();
  const start = anchorNow(clock);
  let raw: PushOutcomeRaw | null = null;
  let cls: AttemptClass | null = null;
  let durationMs = 0;
  try {
    raw = 'specs' in body
      ? await runPush(core.repo, deps.url, body.specs, pushOptions)
      : await deleteProbeRef(core.repo, deps.url, body.deleteProbe.ref, core.refs.probe(core.peerId), body.deleteProbe.lease);
    durationMs = elapsedMono(clock, start);
    // PRO-55 / ENG-46: a slow or killed attempt and an HTTP 429/5xx in git's report are throttle signals; they never classify.
    if (durationMs > SLOW_PUSH_MS || raw.killedByWatchdog) signal(core, 'slow_push', true, true);
    const http = readHttpThrottle(raw.stderr);
    if (http !== null) signal(core, http, true, true);
    cls = await classify(raw);
  } finally {
    const statuses: PushRefStatus[] = raw === null ? [] : [...raw.statuses.values()];
    governor.onAttemptEnd({
      durationMs: raw === null ? elapsedMono(clock, start) : durationMs,
      killed: raw?.killedByWatchdog ?? false,
      hadRefStatus: statuses.some((s) => s !== 'none') || cls?.outcome === 'ok',
      transient: cls?.transient ?? false,
      landed: cls?.landed ?? false,
    });
  }
  deps.trace.emit({ kind: 'push', peer: core.peerId, purpose, argv: raw.argv, bnew, outcome: cls.outcome });
  return { raw, cls };
}

// ---- the ok update (ENG-44) -----------------------------------------------------------------------------------------

/** SCRATCH_RESET_FAILED of the ok update is logged at most this often per core while the holder persists. */
const SCRATCH_RESET_LOG_MS = 600_000;
/** The Δmono of the last SCRATCH_RESET_FAILED per core; dropped by the next reset that succeeds. */
const scratchResetLogged = new WeakMap<EngineCore, number>();

/** The ok update computed before it changes anything in memory or in the state (okUpdatePlan). */
interface OkUpdatePlan { newATree: Oid; newA: TreeMap; changes: RebaseChange[]; }

/**
 * The first half of the ok update, which changes nothing in memory or in the state: its scratch indexes reset
 * (tmp/r.index for HLD-41's rebase, tmp/a.index for the A edit; P2-SCRATCHLOCK), C, the A_cap of the included pairs, the
 * A edit (its own read-tree resets tmp/a.index again) and the HLD-41 changes. A holder that keeps a scratch index (a
 * Windows scanner) throws ScratchResetError here with nothing changed, logged SCRATCH_RESET_FAILED at most once per 10
 * min while it persists: the only failure the callers may read as "the intent stays kept" (Task 15 fix round 3).
 */
async function okUpdatePlan(core: EngineCore, intent: PushIntent, P: TreeMap): Promise<OkUpdatePlan> {
  const { repo, deps } = core;
  try {
    for (const k of ['r', 'a'] as const) await resetScratchIndex(deps.ports.fs, core.scratch(k));
    const { aTree, A } = await currentA(core);
    const C = intent.c === null ? null : await repo.readTreeMap((await repo.readCommit(intent.c)).tree);

    // A_cap of the newest included pair covering each path: "A[p] unchanged since capture".
    const included = new Set(intent.cs_ids);
    const acap = new Map<string, TreeEntry | undefined>();
    for (const pair of core.cs.ready()) {
      if (!included.has(pair.csId)) continue;
      const m = await repo.readTreeMap(pair.A);
      for (const p of pair.paths) acap.set(p, m.get(p));
    }
    const edits: IndexEdit[] = [];
    const changes: RebaseChange[] = [];
    if (C !== null) {
      for (const p of diffPaths(A, P)) {
        const c = C.get(p);
        const a = A.get(p);
        if (!sameEntry(c, P.get(p))) continue;              // K4, concat or the team's entry: A waits for the apply
        if (!acap.has(p) || !sameEntry(acap.get(p), a)) continue;
        edits.push(c === undefined ? { path: p, remove: true } : { path: p, mode: c.mode, oid: c.oid });
        changes.push({ path: p, aOld: a ?? null, aNew: c ?? null, written: 'none', sDiskBefore: null, writtenEntry: null });
      }
    }
    const newATree = await editTreeIndexOnly(repo, deps.ports.fs, aTree, edits, core.scratch('a'));
    const newA = edits.length === 0 ? A : await repo.readTreeMap(newATree);
    scratchResetLogged.delete(core);
    return { newATree, newA, changes };
  } catch (e) {
    if (!(e instanceof ScratchResetError)) throw e;
    const last = scratchResetLogged.get(core);
    const now = deps.ports.clock.monoMs();
    if (last === undefined || now - last >= SCRATCH_RESET_LOG_MS) {
      scratchResetLogged.set(core, now);
      deps.log.write('error', 'SCRATCH_RESET_FAILED', { file: e.file, code: e.code ?? 'unknown', step: 'push_ok' });
    }
    throw e;
  }
}

/**
 * The second half of the ok update, from the first change of memory on: published pairs leave memory, the HLD-41
 * rebase of the pairs left (tmp/r.index, reset by the plan), outbox.landed and the one state update. Any error here
 * (a ScratchResetError included) propagates: memory already changed, so it is never read as "the intent stays kept";
 * the state still holds the push intent and a restart resolves it by observation.
 */
async function okUpdateApply(core: EngineCore, intent: PushIntent, plan: OkUpdatePlan): Promise<void> {
  const view = core.view!;
  const { repo, deps } = core;
  const rollback = core.cs.rollbackPoint();   // the ok update's state commit failing puts published() and rebase() back (Task 9 fix round 1)
  core.cs.published(intent.cs_ids);
  setBoardOnlyFirstPublish(core, false);   // ENG-52 step 8: any landing ends the join's board-only first publish
  const rebase = await core.cs.rebase(repo, plan.changes, core.scratch('r'));   // HLD-41 for the pairs left (P2-PIN-skipped, newer)
  // The renumbering of PRO-09 allocates above meta.seq_next, the landed writer seq and every own seq the outbox holds.
  const self = { peer: core.peerId, epoch: view.meta.epoch };
  let next = Math.max(view.meta.seq_next, intent.writer_seq + 1, core.outbox.maxOwnSeq(self) + 1);
  const alloc: SeqAllocator = { next: () => next++ };
  core.outbox.landed(new Set(intent.op_ids), intent.writer_seq, alloc, self);
  await commitWith(core, {
    laC: intent.c ?? view.laC, laB: intent.bnew, base: plan.newATree,
    meta: metaNow(core, { seq_next: next, rejections: null }),
    intent: { kind: 'none' }, t: new Map(),
  }, { pairs: rebase.ready, rollback });
  for (const ch of plan.changes) deps.trace.emit({ kind: 'A_set', peer: core.peerId, path: ch.path, blob: ch.aNew?.oid ?? null, cause: 'push_confirmed' });
  setCurrentA(core, plan.newATree, plan.newA);
  for (const csId of rebase.cancelled) deps.log.write('info', 'CS_READY_CANCELLED', { cs_id: csId });
}

/**
 * ENG-44 ok update in one state update: LA_C := C (unchanged when board-only), LA_B := Bnew, A[p] := C[p] where C[p] == P[p] and A[p] unchanged since capture, streak reset, outbox.landed, published pairs leave the journal, intent cleared; trace A_set push_confirmed. Restart reuses it.
 * A ScratchResetError from its first half (okUpdatePlan: nothing changed) leaves the push intent journaled; the callers
 * in this file catch exactly that half, so an error after memory changed is never swallowed.
 */
export async function applyPushOk(core: EngineCore, intent: PushIntent, P: TreeMap): Promise<void> {
  if (core.view === null) throw new Error('applyPushOk: no state');
  await okUpdateApply(core, intent, await okUpdatePlan(core, intent, P));
}

/** The ok update for publishStep and resolvePushIntent: false when its first half met a scratch-index holder (nothing changed, the intent stays kept). */
async function okUpdateOrKeep(core: EngineCore, intent: PushIntent, P: TreeMap): Promise<boolean> {
  if (core.view === null) throw new Error('applyPushOk: no state');
  let plan: OkUpdatePlan;
  try {
    plan = await okUpdatePlan(core, intent, P);
  } catch (e) {
    if (e instanceof ScratchResetError) return false;
    throw e;
  }
  await okUpdateApply(core, intent, plan);
  return true;
}

// ---- classification (ENG-44, PRO-54; never by text) -----------------------------------------------------------------

interface Classified { outcome: PublishOutcome; streak: number; observed: boolean; }

/** Mutant M12 (R-29): the rejection text decides. Its only site. */
function classifyByText(stderr: Buffer, previousStreak: number): { outcome: PublishOutcome; streak: number } {
  const text = stderr.toString('utf8');
  if (/cannot lock ref|stale info/.test(text)) return { outcome: 'lease_lost', streak: 0 };
  if (/failed|rejected|declined/.test(text)) {
    const streak = previousStreak + 1;
    return { outcome: streak >= 3 ? 'nonretryable' : 'transient', streak };
  }
  return { outcome: 'network', streak: previousStreak };
}

/** The fresh fetch after a push without a board `ok`, then classifyPublish (PRO-12, PRO-54). An unobservable board is network. */
async function classifyAttempt(core: EngineCore, raw: PushOutcomeRaw, T: Oid, bnew: Oid, previousStreak: number): Promise<Classified> {
  const boardStatus = raw.statuses.get(core.refs.remoteBoard) ?? 'none';
  if (boardStatus === 'ok') return { outcome: 'landed', streak: 0, observed: true };
  const view = await core.fetcher.fetch(true);
  await observeFetch(core, view, true);
  fetchSignal(core, view, true);
  if (view.deferred || !view.ok) return { outcome: 'network', streak: previousStreak, observed: false };
  if (core.deps.testMutants.has('M12')) return { ...classifyByText(raw.stderr, previousStreak), observed: true };
  const onChain = await bnewOnChain(core.repo, view.board, T, bnew);
  // A failed walk is ambiguous: the intent stays journaled (never read as "not landed", which would publish twice).
  if (onChain === null) return { outcome: 'network', streak: previousStreak, observed: false };
  return { ...classifyPublish({ boardStatus, refetchedBoard: view.board, lease: T, ourWriterOnChain: onChain, previousStreak }), observed: true };
}

// ---- a journaled push intent left by a lost classification -----------------------------------------------------------

/**
 * A push intent still journaled (the classify fetch could not observe the board; a restart resolves the crash cases, Task 15):
 * Bnew on the fetched board's first-parent chain after its lease → the ok update, else the intent is discarded.
 */
export async function resolvePushIntent(core: EngineCore, it: IterationCtx): Promise<PublishReport> {
  const view = core.view!;
  if (view.intent.kind !== 'push') throw new Error('resolvePushIntent: no push intent');
  const intent = view.intent;
  // Only a fetch of this iteration observes the board: a deferred view's tip may predate the push (never discard a landing).
  if (it.fetched === null || it.fetched.deferred || !it.fetched.ok) return report('skipped', 'intent_unresolved');
  const onChain = await bnewOnChain(core.repo, it.T, intent.lease_board, intent.bnew);
  if (onChain === null) return report('skipped', 'intent_unresolved');   // a failed walk: still ambiguous, kept
  if (onChain) {
    const pTree = view.t.get('P');
    const P = pTree === undefined ? (await currentA(core)).A : await core.repo.readTreeMap(pTree);
    // A scratch-index holder before anything changed: the intent stays kept, the next resolve applies it.
    if (!(await okUpdateOrKeep(core, intent, P))) return report('skipped', 'intent_unresolved');
    observeOwnLanding(core, intent.bnew, intent.lease_board);
    it.A = (await currentA(core)).A;
    return report('landed', 'resolved', { bnew: intent.bnew, c: intent.c });
  }
  await commitWith(core, { intent: { kind: 'none' }, t: new Map(), meta: metaNow(core) }, null);
  return report('skipped', 'resolved');
}

// ---- publishStep -----------------------------------------------------------------------------------------------------

/**
 * Stripped from the host's text besides C0/DEL/C1 (code points, no raw character in this file): the bidi controls U+061C,
 * U+200E, U+200F, U+202A–U+202E, U+2066–U+2069, and the invisible separators and format characters U+2028 (LINE
 * SEPARATOR), U+2029 (PARAGRAPH SEPARATOR), U+200B (ZERO WIDTH SPACE) and U+FEFF (BOM / ZERO WIDTH NO-BREAK SPACE).
 */
const HOST_INVISIBLE: ReadonlySet<number> = new Set([
  0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
  0x2028, 0x2029, 0x200b, 0xfeff,
]);
/** Stripped from the host's text: C0 controls but TAB, DEL, C1 controls (U+0080–U+009F) and HOST_INVISIBLE. */
const hostControl = (cp: number): boolean => (cp < 0x20 && cp !== 0x09) || (cp >= 0x7f && cp <= 0x9f) || HOST_INVISIBLE.has(cp);

/**
 * The host's text for the doctor log (ENG-45; never status, events or Claude): every line break (CRLF, LF, CR) becomes one
 * space, the control classes above are stripped, and the rest is capped at HOST_TEXT_MAX code points (a surrogate pair is
 * never split).
 */
export function hostText(stderr: Buffer): string {
  let out = '';
  let n = 0;
  for (const ch of stderr.toString('utf8').replace(/\r\n|\n|\r/g, ' ')) {
    if (n === HOST_TEXT_MAX) break;
    if (hostControl(ch.codePointAt(0)!)) continue;
    out += ch;
    n += 1;
  }
  return out;
}

/**
 * Final review FB-6: per core, the names git refused to index when a publish last built OUT — on Windows a TIP holding a
 * root drive-prefix name (`a:b.txt`), with which no OUT needing a whole-path edit over the merged tree can be built — until
 * an OUT builds again (the name left TIP, or the window's merge needed no edit). Kept beside the core like the governor's
 * window: the loop lists the paths of every ready pair it would compose in not_converged while it is set.
 */
const treeRefused = new WeakMap<EngineCore, readonly string[]>();

/** Final review FB-6: the refused names while the publish is paused because OUT cannot be built here; null otherwise. */
export function publishTreeRefused(core: EngineCore): readonly string[] | null {
  return treeRefused.get(core) ?? null;
}

function isBuildFailure(e: unknown): boolean {
  // ScratchResetError: a scratch index a Windows holder keeps (EPERM/EACCES/EBUSY on its reset) fails this window's build only.
  return e instanceof GitCommandError || e instanceof OidError || e instanceof MergeFailedError || e instanceof BoardCapError || e instanceof BoardMalformedError
    || e instanceof ScratchResetError;
}

/**
 * Steps 1–8 of the §3.12 pipeline on the leased tip, re-run from scratch every window (ENG-40). Plan 3 Task 10 makes step 1 Algorithm
 * P over publication groups (algorithmP): the t0 trial, the B1 slot, composeP over the ready groups with the held PINs, HLD-42's
 * dependency PINs, ENG-41 (i) and assertP, OUT, and the T0 slot with K7 or the open-CS drop — every PIN or drop recomposes P without
 * that group — before C, Bnew and the push.
 */
export async function publishStep(core: EngineCore, it: IterationCtx): Promise<PublishReport> {
  const view0 = core.view;
  if (view0 === null) throw new Error('publishStep: no state');
  const { deps, governor } = core;
  const states = it.pushStates;

  // PRO-06 (Plan 3 Task 4): at the record cap, record-creating hold drafts neither leave nor count as pending; on a tip whose
  // held/ puts the tree cap refused, put-carrying hold drafts neither.
  const withhold = withholdOf(core, it);

  // PRO-55 signals of this iteration's fetch (a 429 is a failed fetch: before the fetch gate), then P2-R18's drop.
  handOverThrottle(core, it.fetched, states, withhold, it);
  if (governor.mode() === 'normal') core.outbox.drop(isThrottleDraft);

  if (it.fetched !== null && !it.fetched.ok) return report('skipped', 'fetch_failed');
  if (it.T === ABSENT) return report('skipped', 'no_board');
  const T = it.T;
  if (view0.intent.kind === 'push') return resolvePushIntent(core, it);
  if (view0.intent.kind !== 'none') return report('skipped', 'intent');
  // Plan 3 Task 4: the hold mirrors first (R3-26, R3-27; HLD-10): drafts for this window's records, own rejections handled.
  await mirrorSync(core, it);
  if (core.writer.strandedPaths().length > 0) return report('skipped', 'stranded');   // P2-NARROW: no new intent
  // CCI-50 (Task 17 ruling): without a lease for 2 min the loop takes no new capture (its capture gate), and this step
  // composes only ready pairs captured before — the flush CCI-50 allows — and pending board ops; no lease gate here.
  // A failed snapshot blocks every publish; an iteration that took none (fetch and fold only under FREEZE(EPOCH),
  // ENG-15 / LIF-10) may publish board-only ops at most: no code is allowed in a frozen state.
  if (it.tick?.failed === true || (it.tick === null && states.length === 0)) return report('skipped', 'snapshot_failed');
  if (it.tick?.publishBlocked === true || it.mat?.publishBlocked === true) return report('skipped', 'filter_failure');

  // Plan 3 Task 12a (carry from Task 10): the dependency:<id> PREDICATE runs in the loop's recordStep only (one call site), before
  // this step: a target that ended or no longer withholds lets its PIN's group publish in this window (HLD-42, HLD-52).

  // Code only in the ok state (P2-PUSHSTATES). ENG-52 step 8: the first publish after a join with nothing opted in composes no
  // code (OUT == tree(TIP)); a ready pair captured meanwhile rides the next publish. Nothing pending (no ready publication group,
  // no group held only by a t0 PIN whose T0 may pass now, and no allowed op): nothing is composed, P == A.
  // Plan 3 Task 12a (R3-57, HLD-31): no code part while S_pub is invalid (EngineCore.maskInvalid, until the next passing
  // assertSPub) or the post-resume MASS batch waits for massResumeStep; the allowed board-only ops still go.
  const withheldWhy: PublishReport['codeSkipped'] = codeWithheldWhy(core, it) ?? undefined;
  const codeAllowed = states.length === 0 && !boardOnlyFirstPublish(core) && withheldWhy === undefined;
  const composeDue = codeAllowed && (composable(core, it) || t0Waiting(core));
  // PRO-06 (Plan 3 Task 4): withholdOf read after mirrorSync (episodes it opened or closed), not the `withhold` read above.
  let opsAllowed = core.outbox.pendingAllowed(states, withholdOf(core, it));
  const skippedCode: Partial<PublishReport> = withheldWhy === undefined ? {} : { codeSkipped: withheldWhy, ...(withheldWhy === 'mask_invalid' ? { maskInvalid: true } : {}) };
  if (!composeDue && !opsAllowed) {
    if (withheldWhy !== undefined && states.length === 0) return report('skipped', withheldWhy, skippedCode);
    const blocked = states.length > 0 && (core.cs.ready().length > 0 || core.outbox.size > 0);
    return report(blocked ? 'skipped' : 'nothing', blocked ? 'state' : null);
  }

  // The window (PRO-40) before anything is built (Plan 2 Task 14 decision 4): MASK's merge-file runs and route-(c) objects, the
  // registry commits of Algorithm P and HOLD_MASK_INVALID all wait for a window like the merge, the objects and the intent of 3–7.
  const rank = governorRank(it.fold, core.peerId);
  if (!governor.mayAttempt(rank, true, true)) return report('skipped', 'window');

  // 1 P (Algorithm P).
  let comp: PublishComposition | null = null;
  let built: Built | null = null;
  // HLD-19 / 05 F1 (R3-20, R3-57): set when this window's code part is dropped with HOLD_MASK_INVALID; every later report says so.
  // Task 12a: also from the start of the window while EngineCore.maskInvalid holds (codeSkipped).
  let maskInvalid = core.maskInvalid;
  const pass: PassReport = { dependencyPins: [], k7: [], dropped: [], records: [] };
  const done = (r: PublishReport): PublishReport => ({
    ...r, dependencyPins: [...pass.dependencyPins], k7: [...pass.k7], dropped: [...pass.dropped], ...(maskInvalid ? { maskInvalid: true } : {}),
    ...(withheldWhy !== undefined ? { codeSkipped: withheldWhy } : {}),
  });
  if (composeDue) {
    const ap = await algorithmP(core, it, T, pass);
    if ('report' in ap) return done(ap.report);
    ({ comp, built } = ap);
    maskInvalid = ap.maskInvalid;
  }
  const P: TreeMap = comp?.P ?? it.A;
  const code = comp !== null && built !== null && diffPaths(it.A, P).length > 0;
  // Re-read after compose (Task 2 carry): a CONFLICTED transition above may come to enqueue a board op; withholdOf as above.
  opsAllowed = core.outbox.pendingAllowed(states, withholdOf(core, it));
  if (!code && !opsAllowed) {
    if (comp !== null) await dropPublished(core, comp.csIds);   // P == A: OUT == tree(TIP), nothing to push (R-02)
    if (maskInvalid) return done(report('skipped', 'mask_invalid'));
    return done(report('nothing', null));
  }

  // 3–7: C, Bnew, ENG-41 and the push intent. Until the push intent is committed, every exit (an early return, a build failure, a
  // failed assertion, a failed state update, any throw) restores the outbox from its JSON before Outbox.take(): no op may keep a
  // seq that meta.seq_next never recorded (PRO-08).
  const outboxBefore = core.outbox.toJson();
  let j: Journaled | PublishReport | null = null;
  try {
    j = await buildAndJournal(core, it, comp, code ? built : null, P, T, pass.records);
  } finally {
    if (j === null || !('intent' in j)) core.outbox = Outbox.fromJson(outboxBefore);
  }
  if (!('intent' in j)) return done(j);
  crashpoint('publish.out_built');
  deps.trace.emit({
    kind: 'publish', peer: core.peerId, t: T, tip: it.tip, aTree: j.aTree, pTree: j.pTree, outTree: j.outTree, c: j.c, bnew: j.bnew,
    conflicted: j.conflicted, replaced: j.replaced,
  });
  // Plan 3 Task 4: the hold ops this Bnew carries (R3-25; no duration, no wall time).
  if (j.mirrored.length > 0) deps.trace.emit({ kind: 'mirror', peer: core.peerId, bnew: j.bnew, holds: j.mirrored });
  await deps.ports.scheduler.yieldPoint('publish.beforePush');
  return done(await push(core, it, comp, P, T, rank, j));
}

// ---- Algorithm P (05-holds §3.6, HLD-38…HLD-52, 01-engine §3.12; Plan 3 Task 10) ----------------------------------------------

/** What Algorithm P adds to this window's report (PublishReport.dependencyPins, k7, dropped) and the K4 records OUT made. */
interface PassReport { dependencyPins: string[]; k7: string[]; dropped: string[]; records: string[]; }
/** The P tree of a composition and its OUT. */
interface Built { pTree: Oid; merged: Merged; }

/**
 * MASK steps 2 and 4 (a local_only record — a local_only PIN included —, a whole-path guard, an ON_DISK CONFLICTED or OFF_DISK
 * claim-breach record): HLD-42's whole-path withholding. Step 3 (a held PIN) is not one: such a PIN already holds its whole group.
 */
const WHOLE_REASONS: ReadonlySet<string> = new Set(['local_only', 'whole_path_guard', 'conflicted']);
/** A window-only hold of a group (an incomplete T0, a withholding with nothing LIVE to pin): a HeldPin id no record has. */
const WINDOW_HOLD = 'window:';
const isWindowHold = (id: string): boolean => id.startsWith(WINDOW_HOLD);

/** A K1 SHADOW (HLD-47): a PATCH held OFF_DISK under a `claim` guard (shadowCsIds' records). */
const isShadow = (r: HoldRecord): boolean => r.kind === 'PATCH' && r.residence === 'OFF_DISK' && !isTerminal(r) && r.guards.some((g) => guardName(g) === 'claim');

/** A held PIN whose only guards are t0 (Table 3 `t0`: the T0 slot evaluates its PREDICATE). */
const t0Only = (pin: HeldPin): boolean => pin.guards.length > 0 && pin.guards.every((g) => g === 't0');

/** The Cowork-Seat of a group's key CS, or `human`: the origin of the PINs Algorithm P makes for the group. */
const groupOrigin = (g: PublicationGroup): string => seatOfCs(g.key);

/** The group's R: A with the newest ready pair of each of its CSs over that pair's paths (capture order), never S_disk. */
async function groupR(core: EngineCore, it: IterationCtx, g: PublicationGroup): Promise<Map<string, TreeEntry>> {
  const R = new Map<string, TreeEntry>(it.A);
  for (const pair of core.cs.ready()) {
    if (!g.csIds.includes(pair.csId)) continue;
    const m = await core.repo.readTreeMap(pair.R);
    for (const p of pair.paths) {
      const e = m.get(p);
      if (e !== undefined) R.set(p, e);
      else R.delete(p);
    }
  }
  return R;
}

/** `R` on `paths` as a record side (ABSENT where R lacks a path). */
function sideOf(R: TreeMap, paths: readonly string[]): BlobMap {
  const out: BlobMap = {};
  for (const p of paths) setBlob(out, p, R.get(p)?.oid ?? ABSENT);
  return out;
}

/** The LIVE paths among `paths` (HLD-03): only they enter a record and its held/ mirror; a path the scope cannot classify is not LIVE. */
async function livePaths(core: EngineCore, it: IterationCtx, paths: readonly string[]): Promise<string[]> {
  await ensureAttrs(core, it.epochBase, paths);
  const live = liveIn(it);
  return paths.filter(live).sort();
}

/**
 * The paths a PIN built from R takes (gateSlot's claim PIN, dependencySlot's dependency PIN, t0Slot's K7 PIN): the LIVE paths among
 * `paths` (HLD-03) minus the paths of every non-terminal ON_DISK `local_only` record and minus those of every non-terminal ON_DISK
 * record carrying `markers`.
 * - A `local_only` record's path stays only in that record, so no secret-bearing bytes reach a PIN's held side and the PIN is never
 *   made `local_only` by a path it does not own (HLD-42, INV-SECRET; ruling R3-FF2-B2: the claim and K7 PINs as the dependency
 *   PIN). The iteration's scope alone does not keep such a path out: D5 row 9 (R3-21) classes it LOCAL_ONLY only when the record
 *   existed when the scope was built (a record a step of this iteration made leaves it LIVE until the next one), and never for an
 *   INCOMING record (an INCOMING record is ON_DISK by schema and is in this set).
 * - A `markers` path holds the restore-marker rows of a conflicted RESTORE on disk, so R holds them too, and a PIN's H1 is mirrored
 *   to held/: restore markers never reach a held/ blob (final review F4; 05 §3.4 items 3–4, DAT-46; ENG-41 (j) would refuse every
 *   Bnew of the peer).
 * Either path stays withheld whole by its own record (MASK step 2, or a whole-path guard), its bytes on disk.
 */
async function pinnablePaths(core: EngineCore, it: IterationCtx, paths: readonly string[]): Promise<string[]> {
  const own = new Set(core.holds.nonTerminal().filter(keepsPathsOutOfPins).flatMap((r) => r.paths));
  return (await livePaths(core, it, paths)).filter((p) => !own.has(p));
}

/**
 * pinnablePaths' predicate: a non-terminal ON_DISK record that is `local_only` (an INCOMING one included) or carries `markers` keeps
 * its paths out of every PIN built from R. Exported for csStep.ts joinPin (HLD-49's bundle join; final review r3 B3-2, ruling
 * R3-FF3-B2), which applies it as R3-FF2-B2 does at creation.
 */
export function keepsPathsOutOfPins(r: HoldRecord): boolean {
  return !isTerminal(r) && r.residence === 'ON_DISK' && (r.local_only || r.guards.some((g) => guardName(g) === 'markers'));
}

/** EOL_MIXED_HELD {id, path} to status and the log, the first time an eol-bom record withholds a path of a ready group (DAT-06; once per record id). */
const eolMixedTold = new WeakMap<EngineCore, Set<string>>();

/**
 * Algorithm P steps 1–5 (05-holds §3.6) in one window: the t0 PREDICATE (the t0 trial), then rounds of B1 slot → composeP → dependency PINs → ENG-41 (i) and
 * assertP → P tree, `compose` event, OUT → T0 slot; a round that made a record CONFLICTED (final review F9), pinned, dropped or held back a
 * group recomposes from its start, so each round removes at least one record or group. The report is an exit (an aborting check, a build failure); otherwise the composition (null after
 * HOLD_MASK_INVALID) and its OUT (null when P == A: R-02).
 */
async function algorithmP(core: EngineCore, it: IterationCtx, T: Oid, pass: PassReport): Promise<{ report: PublishReport } | { comp: PublishComposition | null; built: Built | null; maskInvalid: boolean }> {
  const { repo, deps } = core;
  await t0Trial(core, it, T);
  const windowHolds = new Map<string, HeldPin>();
  for (let round = 0; ; round++) {
    if (round > 10_000) throw new Error('publishStep: Algorithm P did not settle');
    const pins = [...heldPins(core.holds), ...windowHolds.values()];
    core.cs.shadowed(shadowCsIds(core.holds));
    // 2 B1 (HLD-45): gate() over every ready group's rebased R at the leased tip; a block is a whole-group claim PIN.
    if (await gateSlot(core, it, core.cs.groups(pins), windowHolds)) continue;
    // 3 P := compose (HLD-42).
    let comp: PublishComposition;
    try {
      comp = await compose(core, it, pins);
    } catch (e) {
      if (e instanceof ReadyBaseMismatchError) {
        deps.log.write('error', 'NOT_CONVERGED', { cause: 'publish_assert', check: 'a_cap', path: e.path });
        return { report: report('aborted', 'ready_base_mismatch', { records: [...pass.records], assert: { check: 'a_cap', path: e.path } }) };
      }
      if (!(e instanceof HoldOperatorError)) throw e;
      // 05 F1: a MASK that cannot run (a corrupt or missing record blob) publishes no code; S_disk is never the fallback.
      raiseMaskInvalid(core, { op: e.op, path: e.path, hold_id: e.holdId });
      return { comp: null, built: null, maskInvalid: true };
    }
    // HLD-15 (R3-19): records whose step-5 merge conflicted become CONFLICTED in one registry commit. Final review F9: then the round
    // recomposes, so a conflict first seen here (its materializing iteration ran no recordStep: an out-of-cycle capture) is treated
    // as the in-cycle path treats it — MASK step 4 withholds the record's paths whole and HLD-42 pins the rest of their groups
    // (dependencySlot), instead of publishing the rest of the group and dropping the pair that holds the untainted edit. The
    // recomposition never sees r at step 5 again, so each round removes a record; other groups still publish in this window.
    if (comp.conflicted.length > 0) {
      await core.holds.commitMany([], comp.conflicted.map((id) => ({ id, patch: { state: 'CONFLICTED' as const } })));
      continue;
    }
    // HLD-42: a whole-path withholding pins the rest of its group (a separate dependency PIN), or holds it back for the window.
    if (await dependencySlot(core, it, comp, windowHolds, pass)) continue;
    // ENG-41 (i) / HLD-19 INV-MASK before anything is built: no held path differs from A in P (prePushAsserts' letters).
    await ensureAttrs(core, it.epochBase, diffPaths(it.A, comp.P));
    const held = heldPathInP(it.A, comp.P, comp.masked, (p) => it.scope(p).cls);
    if (held !== null) return { report: assertFailed(core, held.letter, held.path, [...pass.records]) };
    // HLD-19 on P (R3-20): a failure drops this window's code part only (R3-57); the allowed board-only ops still go.
    let failed: Record<string, string> | null = null;
    try {
      const a = await assertP(repo, comp.P, comp.inp);
      if (!a.ok) failed = { clause: a.clause, path: a.path };
    } catch (e) {
      if (!(e instanceof HoldOperatorError)) throw e;
      failed = { op: e.op, path: e.path, hold_id: e.holdId };
    }
    if (failed !== null) {
      raiseMaskInvalid(core, failed);
      return { comp: null, built: null, maskInvalid: true };
    }
    if (diffPaths(it.A, comp.P).length === 0) return { comp, built: null, maskInvalid: false };   // P == A: no OUT (R-02)
    // 4 P tree, the `compose` event, OUT.
    let built: Built;
    try {
      built = await buildPOut(core, it, comp, T, false);
    } catch (e) {
      if (!isBuildFailure(e)) throw e;
      return { report: buildFailure(core, e, pass.records) };
    }
    for (const id of built.merged.records) if (!pass.records.includes(id)) pass.records.push(id);
    // 5 T0 (HLD-50): K7, the open-CS drop, or an incomplete verdict's window hold; then compose again without the group.
    if (await t0Slot(core, it, comp, built, windowHolds, pass)) continue;
    return { comp, built, maskInvalid: false };
  }
}

/** A build failure before the intent: FB-6's typed pause for a name git refuses to index, else PUBLISH_BUILD_FAILED (no push). */
function buildFailure(core: EngineCore, e: unknown, records: readonly string[]): PublishReport {
  // Final review FB-6: git cannot index a name of the merged tree here (TIP's `a:b.txt` on Windows): no OUT can be built
  // until the name leaves TIP. A typed pause, visible in status through publishTreeRefused (the loop lists the ready
  // pairs' paths), never a silent build_failed; logged once when it starts.
  if (e instanceof IndexRefusedPathError) {
    if (!treeRefused.has(core)) core.deps.log.write('warn', 'PUBLISH_TREE_REFUSED', { refused: e.paths.length });
    treeRefused.set(core, e.paths);
    return report('aborted', 'path_not_indexable', { records: [...records] });
  }
  core.deps.log.write('error', 'PUBLISH_BUILD_FAILED', { code: e instanceof GitCommandError ? e.code : -1, kind: e instanceof Error ? e.name : 'unknown' });
  return report('aborted', 'build_failed', { records: [...records] });
}

/**
 * P's tree and OUT (01-engine §3.10): the `compose` trace event for every P tree of a real composition (R3-63: none for a T0 trial),
 * then merge-tree --merge-base=A P TIP with the rename carry and the conflict function (buildOut; a trial makes no K4 record and no
 * merge event). Mutant M06 (R-29) takes S_disk as OUT; ENG-41 (b)/(c) stop it.
 */
async function buildPOut(core: EngineCore, it: IterationCtx, comp: PublishComposition, T: Oid, trial: boolean): Promise<Built> {
  const { repo, deps } = core;
  const { aTree } = await currentA(core);
  const pTree = await editTreeIndexOnly(repo, deps.ports.fs, aTree, editsBetween(it.A, comp.P), core.scratch('p'));
  if (!trial) emitCompose(core, it, comp, aTree, pTree);
  if (deps.testMutants.has('M06')) {
    it.mat ??= await core.snapshot.materialize(tickInputOf(core, it));
    return { pTree, merged: { outTree: it.mat.sDisk, out: it.mat.sDiskMap, conflicted: [], replaced: [], records: [] } };
  }
  const { tree: tipTree } = await liveCodeOf(core, T);
  const merged = await buildOut(core, it, comp, aTree, pTree, tipTree, trial);
  treeRefused.delete(core);   // FB-6: an OUT was built, the pause (if any) is over
  return { pTree, merged };
}

/**
 * The `compose` trace event (Task 14's INV-MASK and O-ATOMIC-PUB input; R3-63): every journaled ready pair, the groups with their held
 * PINs and the engine's readiness, and the withheldWhole entries composeP used. A window hold is not a record: it is not listed.
 */
function emitCompose(core: EngineCore, it: IterationCtx, comp: PublishComposition, aTree: Oid, pTree: Oid): void {
  core.deps.trace.emit({
    kind: 'compose', peer: core.peerId, tip: it.tip, aTree, registry: core.holds.head(), pTree,
    pairs: core.cs.ready().map((p) => ({ csId: p.csId, R: p.R, A: p.A, order: p.order, paths: [...p.paths] })),
    groups: comp.groups.map((g) => ({ key: g.key, csIds: [...g.csIds], paths: [...g.paths], pins: g.pins.filter((id) => !isWindowHold(id)), ready: g.ready })),
    withheldWhole: [...comp.withheldWhole].map(([key, paths]) => ({ key, paths: [...paths] })),
  });
}

/**
 * HLD-45 (R3-07): EngineDeps.gate over every ready group with its rebased R (A elsewhere) at the leased tip; a block makes one PIN
 * `claim:<claim_id>` over the group's LIVE paths (H0 = A, H1 = R; every group path publishes A[p], the disk untouched), offer
 * pending_leftover while a member CS is open; a blocked group with no LIVE path to hold is held back for the window (fail closed).
 * Final review F4 and r2 B-2 (R3-FF2-B2): a path a `markers` or a `local_only` record withholds stays out of the PIN (pinnablePaths).
 * True when a group was held (the round recomposes).
 */
async function gateSlot(core: EngineCore, it: IterationCtx, groups: readonly PublicationGroup[], windowHolds: Map<string, HeldPin>): Promise<boolean> {
  let pinned = false;
  for (const g of groups) {
    if (!g.ready) continue;
    const R = await groupR(core, it, g);
    const v = await core.deps.gate.gate(core.repo, it.tip, it.A, R, g.paths, g.csIds);
    if (v.block === null) continue;
    pinned = true;
    const live = await pinnablePaths(core, it, g.paths);
    if (live.length === 0) {
      windowHolds.set(g.key, { id: `${WINDOW_HOLD}${g.key}`, paths: g.paths, guards: ['claim'] });
      continue;
    }
    const open = core.cs.table().cs.some((e) => g.csIds.includes(e.cs_id) && e.state === 'open');
    await core.holds.hold(pinCs(`claim:${v.block.claimId}`, g.csIds, live, it.A, sideOf(R, live), groupOrigin(g), open ? 'pending_leftover' : 'none'));
  }
  return pinned;
}

/**
 * HLD-42 (R3-44): for each ready group a MASK steps 2–4 record withholds whole on R (Composition.withheldWhole), one PIN
 * `dependency:<id>` per withholding record over the group's LIVE paths minus every local_only record's paths (H0 = A, H1 = R; a
 * separate non-local_only record, never joined to a local_only one; HLD-07 attaches later rounds and loops to it) and minus every
 * `markers` record's paths (final review F4, pinnablePaths: restore markers never reach held/). A K4 record (stages, DAT-43) never pins
 * its group only while it still is the TAKE_TIP displacement (isK4Displacement: CONFLICTED, guard `conflict`; INV-HLD-ATOMIC-PUB
 * exception (c), glossary §24 default 3); once RESTORE releases `conflict` (HLD-17) it pins like any MASK steps 2–4 record — `markers`
 * after a conflicted restore, MASK step 4 while it stays CONFLICTED (ruling R3-EF4-14, R3-FF2-B0). A group with nothing LIVE left to
 * pin (a CS whose only path is a `portability` or a `markers` record's) gets no PIN: it is held back for this window and waits until
 * the withholding record ends.
 * The first time an eol-bom record withholds a path of a ready group, EOL_MIXED_HELD {id, path} (DAT-06). True when the round must
 * recompose.
 */
async function dependencySlot(core: EngineCore, it: IterationCtx, comp: PublishComposition, windowHolds: Map<string, HeldPin>, pass: PassReport): Promise<boolean> {
  let again = false;
  for (const [key, paths] of comp.withheldWhole) {
    const g = comp.groups.find((x) => x.key === key);
    if (g === undefined || !g.ready) continue;   // a held group is already withheld whole (HLD-38)
    const targets: HoldRecord[] = [];
    for (const p of paths) {
      for (const r of core.holds.byPath(p)) {
        if (isK4Displacement(r) || targets.includes(r)) continue;
        // A `generated?:exclude` record withholds its path but never the rest of the CS (HLD-42: the human chose "exclude", the path is
        // on its way to UNMANAGED; Table 4's "HLD-42 PINs depending on it release at once" — and none is made again; Task 11, U8).
        if (r.guards.some((x) => x.name === 'generated?:exclude')) continue;
        if (WHOLE_REASONS.has(maskReason(p, { ...comp.inp, records: [r] }) ?? '')) targets.push(r);
      }
    }
    if (targets.length === 0) continue;
    for (const t of targets) {
      if (!t.guards.some((x) => guardName(x) === 'eol-bom')) continue;
      const told = eolMixedTold.get(core) ?? new Set<string>();
      eolMixedTold.set(core, told);
      if (told.has(t.id)) continue;
      told.add(t.id);
      raiseHold(core, 'warn', 'EOL_MIXED_HELD', { id: t.id, path: paths.find((p) => t.paths.includes(p)) ?? t.paths[0]! });
    }
    const live = await pinnablePaths(core, it, g.paths);
    again = true;
    if (live.length === 0) {
      windowHolds.set(key, { id: `${WINDOW_HOLD}${key}`, paths: g.paths, guards: ['dependency'] });
      continue;
    }
    const R = await groupR(core, it, g);
    for (const t of [...targets].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      const id = await core.holds.hold(pinCs(`dependency:${t.id}`, g.csIds, live, it.A, sideOf(R, live), groupOrigin(g), 'none'));
      if (!pass.dependencyPins.includes(id)) pass.dependencyPins.push(id);
    }
  }
  return again;
}

/**
 * HLD-50: t0Shrink (item 3, the one attribution expression) and then the T0RegionsPort (items 1–2) on the group's paths of OUT. Task 17
 * (rev 2.5, decision D2, X-09): a path whose OUT content is exactly a pending revert CS's shrink mark (the blob a confirmed revert wrote,
 * or that blob as a clean HLD-41 rebase carried it; ABSENT for a deletion) counts as attributed; any other content keeps the guard.
 */
async function t0Verdict(core: EngineCore, it: IterationCtx, paths: readonly string[], merged: Merged): Promise<T0Verdict> {
  const shrunk = await t0Shrink(core.repo, it.tipMap, merged.out, paths,
    (p) => core.deps.attribution.shrinkAttributed(p) || core.cs.revertMarks.covers(p, merged.out.get(p)?.oid ?? ABSENT));
  if (shrunk.length > 0) return { pass: false, paths: shrunk, item: 3, findings: shrunk.map((p) => ({ check: 4 as const, path: p, reason: 'shrink' as const })) };
  return core.deps.t0Regions.check(core.repo, it.tip, merged.outTree, paths);
}

/**
 * HLD-50 / R3-04, T0 on OUT for every composed group: a pass leaves it; an incomplete verdict holds it back for this window (no
 * record; T0 runs again in the next window); a failure whose capture is an edit-checkpoint capture of a still-open CS drops that
 * capture (HLD-67, §8 Q15: no PIN, no message; rev 2.5, D1: last_check{kind: 'stale'} from the first finding) in one state update;
 * any other failure is K7, one PIN over the group's LIVE paths (H0 = A, H1 = R) with guard `t0` — or, for a group whose CS has a
 * non-terminal SHADOW, `dependency:<shadow id>` (HLD-48); a path a `markers` or a `local_only` record withholds stays out of it
 * (final review F4 and r2 B-2, R3-FF2-B2, pinnablePaths; dependencySlot pins such a group first, except for a `generated?:exclude`
 * target). True when a group was handled (the round recomposes without it).
 */
async function t0Slot(core: EngineCore, it: IterationCtx, comp: PublishComposition, built: Built, windowHolds: Map<string, HeldPin>, pass: PassReport): Promise<boolean> {
  let handled = false;
  for (const g of comp.groups) {
    if (!g.ready || !g.csIds.some((id) => comp.csIds.includes(id))) continue;
    const v = await t0Verdict(core, it, g.paths, built.merged);
    if ('pass' in v && v.pass) continue;
    handled = true;
    if ('incomplete' in v) {
      windowHolds.set(g.key, { id: `${WINDOW_HOLD}${g.key}`, paths: g.paths, guards: ['t0'] });
      continue;
    }
    const findings = 'findings' in v ? (v.findings ?? []) : [];
    const rollback = core.cs.rollbackPoint();
    const drop = core.cs.dropCandidateCapture(g.csIds);
    if (drop !== null) {
      const f = findings[0];
      core.cs.lastCheck.recordFor(drop.csId, drop.candSeq, {
        kind: 'stale', ...(f !== undefined ? { check: f.check, path: f.path, ...(f.line !== undefined ? { line: f.line } : {}) } : {}), more: Math.max(0, findings.length - 1),
      });
      await commitWith(core, { meta: metaNow(core) }, { pairs: core.cs.ready(), rollback });
      if (!pass.dropped.includes(drop.csId)) pass.dropped.push(drop.csId);
      continue;
    }
    const live = await pinnablePaths(core, it, g.paths);
    if (live.length === 0) {
      windowHolds.set(g.key, { id: `${WINDOW_HOLD}${g.key}`, paths: g.paths, guards: ['t0'] });
      continue;
    }
    const shadow = core.holds.nonTerminal().find((r) => isShadow(r) && r.cs_ids.some((id) => g.csIds.includes(id)));
    const guard = shadow !== undefined ? `dependency:${shadow.id}` : 't0';
    const R = await groupR(core, it, g);
    const id = await core.holds.hold(pinCs(guard, g.csIds, live, it.A, sideOf(R, live), groupOrigin(g), 'none'));
    if (!pass.k7.includes(id)) pass.k7.push(id);
  }
  return handled;
}

/**
 * Contract addition 6 (Table 3 `t0`, HLD-52, R3-63): the t0 PREDICATE. Each window, the groups whose only held PINs carry only `t0`
 * are composed into a trial OUT (those PINs left out; no `compose` event, no K4 record); a group whose T0 passes there gets the guard
 * released in a registry commit, so the round that follows composes it and it publishes in this window. A trial that cannot be built
 * decides nothing (the main rounds report).
 */
async function t0Trial(core: EngineCore, it: IterationCtx, T: Oid): Promise<void> {
  const pins = heldPins(core.holds);
  const only = new Set(pins.filter(t0Only).map((p) => p.id));
  if (only.size === 0) return;
  core.cs.shadowed(shadowCsIds(core.holds));
  const held = core.cs.groups(pins).filter((g) => g.pins.length > 0 && g.pins.every((id) => only.has(id)));
  if (held.length === 0) return;
  let comp: PublishComposition;
  let built: Built;
  try {
    comp = await compose(core, it, pins.filter((p) => !only.has(p.id)), only);
    if (diffPaths(it.A, comp.P).length === 0) return;
    built = await buildPOut(core, it, comp, T, true);
  } catch (e) {
    if (e instanceof ReadyBaseMismatchError || e instanceof HoldOperatorError || isBuildFailure(e)) return;
    throw e;
  }
  for (const h of held) {
    const g = comp.groups.find((x) => x.ready && x.csIds.some((id) => h.csIds.includes(id)));
    if (g === undefined) continue;
    const v = await t0Verdict(core, it, g.paths, built.merged);
    if (!('pass' in v) || !v.pass) continue;
    for (const id of h.pins) {
      const r = core.holds.get(id);
      if (r !== undefined && !isTerminal(r) && r.guards.some((x) => x.name === 't0')) await core.holds.releaseGuard(id, 't0');
    }
  }
}

/** A group held only by t0 PINs that would be ready without them: the T0 slot must run its trial this window (composeDue). */
function t0Waiting(core: EngineCore): boolean {
  const pins = heldPins(core.holds);
  const only = new Set(pins.filter(t0Only).map((p) => p.id));
  if (only.size === 0) return false;
  core.cs.shadowed(shadowCsIds(core.holds));
  const held = new Set(core.cs.groups(pins).filter((g) => g.pins.length > 0 && g.pins.every((id) => only.has(id))).flatMap((g) => g.csIds));
  const waiting = held.size > 0 && core.cs.groups(pins.filter((p) => !only.has(p.id))).some((g) => g.ready && g.csIds.some((id) => held.has(id)));
  core.cs.groups(pins);   // closeDue's view of the held PINs is the whole set again
  return waiting;
}

/**
 * R3-SPEC-4: whether a dependency target is a SHADOW (HLD-47), claim released or not — a PATCH carrying `claim`, or a PATCH whose offer
 * left 'none'. Only a SHADOW birth gives a PATCH an offer (HLD-09 `none|returned → pending_leftover`: a SHADOW, or a K2/K3/K6 PIN;
 * glossary SHADOW `offer=pending_leftover`) and an offer never moves back to 'none' (offerNext), so the test outlives the claim. No
 * HLD-42 target (a whole-path PATCH, a CONFLICTED K4 PATCH, a local_only PIN, the claim-breach pin) is a PATCH with an offer.
 */
const shadowTarget = (t: HoldRecord): boolean => t.kind === 'PATCH' && (t.offer !== 'none' || t.guards.some((x) => guardName(x) === 'claim'));

/**
 * The dependency:<id> PREDICATE (HLD-42, HLD-48, HLD-52): releases each such guard whose target record is terminal (or no longer in
 * the registry), no longer withholds a path of the PIN's group (its guard set is empty and it is not CONFLICTED), carries
 * generated?:exclude, or is the TAKE_TIP displacement again (isK4Displacement: an apply-side K4 onto a restored record, ruling
 * R3-EF4-7's transition, makes it CONFLICTED [conflict] and then OFF_DISK; a displaced local side never pins its group — HLD-42,
 * DAT-43, glossary §24 default 3 — so the PIN must not wait for a human resolve; ruling R3-EF4-14; ruling R3-EF4-22 scopes that clause
 * to HLD-42 PINs: a target carrying `claim` — a SHADOW an apply-side K4 attached to through HLD-07 — keeps its HLD-48
 * `dependency:<shadow id>` PIN until the SHADOW is terminal, Table 3); returns the ids it changed. Ruling R3-SPEC-4 (Table 3, before
 * Plan 4): the `released` clause leaves SHADOW targets out too, and both clauses know a SHADOW by its identity (shadowTarget), not by a
 * live `claim` guard — a SHADOW whose claim released (released, STALE, transferred, granted) is guard-less PARKED, or a K4 displacement,
 * while it is not terminal, and its HLD-48 PIN still waits for it to end. A record carrying a guard outside Table 3 is never
 * transitioned (HLD-05). Called by recordStep (Task 12) and by --discard on a generated? record (Task 11). Final review F10: a
 * guard-less ON_DISK local_only target still withholds its paths whole (MASK step 2 needs no guard), so its PIN is not released —
 * dependencySlot would re-attach it in the next window (a registry commit, a hold op and a push every window, nothing published).
 */
export async function releaseDependencyGuards(core: EngineCore, _it: IterationCtx): Promise<string[]> {
  const changed: string[] = [];
  for (const r of core.holds.nonTerminal()) {
    if (r.guards.some(isUnknownGuard)) continue;
    for (const g of r.guards) {
      if (guardName(g) !== 'dependency') continue;
      const arg = guardArg(g);
      const t = arg === null ? undefined : core.holds.get(arg);
      const released = t !== undefined && !shadowTarget(t) && t.guards.length === 0 && t.state !== 'CONFLICTED' && !(t.local_only && t.residence === 'ON_DISK');
      // R3-EF4-22: the displacement clause is HLD-42's only — a SHADOW that absorbed a K4 keeps its HLD-48 PIN until it ends, its claim
      // released or not (R3-SPEC-4).
      const displaced = t !== undefined && !shadowTarget(t) && isK4Displacement(t);
      const ends = t === undefined || isTerminal(t) || released || displaced || t.guards.some((x) => x.name === 'generated?:exclude');
      if (!ends) continue;
      await core.holds.releaseGuard(r.id, g.name);
      if (!changed.includes(r.id)) changed.push(r.id);
    }
  }
  return changed;
}

/** What buildAndJournal committed: the push intent and what the push and the trace need. */
interface Journaled {
  intent: PushIntent; aTree: Oid; pTree: Oid; outTree: Oid; c: Oid | null; bnew: Oid; records: string[];
  conflicted: string[]; replaced: Array<{ path: string; blob: string | null }>; withMirror: boolean; mirror: OidOrAbsent;
  /** The hold ops Bnew carries (trace 'mirror', PublishReport.mirrored; Plan 3 Task 4). */
  mirrored: HeldPlan['mirrored'];
}

/**
 * Steps 3–7 on the leased tip: OUT, C and Bnew (a failing git call or an empty oid aborts before any intent or push,
 * ENG-09), ENG-41 on what git wrote, then the push intent with t/P, seq_next and the allocated outbox (PRO-08). A report
 * is an exit before the intent; the caller restores the outbox on every exit but a committed intent.
 */
async function buildAndJournal(
  core: EngineCore, it: IterationCtx, comp: PublishComposition | null, code: Built | null, P: TreeMap, T: Oid, outRecords: readonly string[],
): Promise<Journaled | PublishReport> {
  const { repo, deps } = core;
  const states = it.pushStates;
  const csIds = comp?.csIds ?? [];
  const records: string[] = [...outRecords];
  let built: {
    aTree: Oid; pTree: Oid; outTree: Oid; out: TreeMap; c: Oid | null; bnew: Oid; writer: WriterId; ops: Op[]; seqNext: number; conflicted: string[];
    replaced: Array<{ path: string; blob: string | null }>; held: HeldPlan;
  };
  try {
    const { aTree } = await currentA(core);
    const { tree: tipTree } = await liveCodeOf(core, T);
    let pTree = aTree;
    let outTree = tipTree;
    let out: TreeMap = it.tipMap;
    let conflicted: string[] = [];
    let replaced: Array<{ path: string; blob: string | null }> = [];
    if (code !== null && comp !== null) {
      // Plan 3 Task 10: P's tree and OUT come from Algorithm P (buildPOut), whose T0 slot passed every composed group on this OUT.
      pTree = code.pTree;
      ({ outTree, out, conflicted, replaced } = code.merged);
    }
    if (boardOnlyFirstPublish(core) && outTree !== tipTree) {
      // ENG-52 step 8's runtime assertion: never true unless the composition above is broken.
      deps.log.write('error', 'NOT_CONVERGED', { cause: 'publish_assert', check: 'join_first_publish' });
      return report('aborted', 'join_first_publish', { records, assert: { check: 'join_first_publish', path: null } });
    }
    // PRO-06 / 02 §3.1 / R3-74 (round-1 ruling): a build whose held/ puts the 5 MB tree cap refuses is built once more from
    // the outbox as it was before the first take, with every put-carrying hold draft withheld (wouldPut) and no put at all:
    // code, stubs, ending ops (their held/<id>/ carried), removals and events still land, and BOARD_FULL opens the tree-cap
    // episode. The refusal is not a build failure; a second refusal (or one without puts) is.
    const outboxBefore = core.outbox.toJson();
    // R3-EF4-31 (EF5 merge M-2): the records whose ops this window holds back because planHeld could not read a held blob of theirs.
    // Like the tree-cap rebuild, the build is taken again from the outbox as it was before the first take, without their drafts; each
    // round withholds at least one more record, so the loop ends.
    const unreadableIds = new Set<string>();
    let withhold = withUnreadable(withholdOf(core, it), unreadableIds);
    let puts = true;
    for (;;) {
      if (outTree === tipTree && !core.outbox.pendingAllowed(states, withhold)) {
        await dropPublished(core, csIds);   // OUT == tree(TIP) with no ops: nothing is pushed, the pairs count as published (R-02)
        return report('nothing', null, { records });
      }

      // Seqs (PRO-08, PRO-09): ops renumbered at or below the folded last_seq of the own epoch, taken, then the writer seq
      // above them. The allocator starts above meta.seq_next, the folded last_seq and every own seq the outbox holds, so an
      // allocation the state never recorded can never put the writer seq at or below an op seq.
      const meta = core.view!.meta;
      const self = { peer: core.peerId, epoch: meta.epoch };
      const rec = it.fold.peers[core.peerId];
      const lastSeq = rec !== undefined && rec.epoch === meta.epoch ? rec.last_seq : 0;
      let next = Math.max(meta.seq_next, lastSeq + 1, core.outbox.maxOwnSeq(self) + 1);
      const alloc: SeqAllocator = { next: () => next++ };
      core.outbox.renumberAtOrBelow(lastSeq, alloc, self);
      const ops = core.outbox.take(states, self, alloc, { maxOps: OPS_MAX_LINES, maxBytes: OPS_MAX_BYTES, ...(withhold !== undefined ? { withhold } : {}) });
      const writer: WriterId = { peer: core.peerId, epoch: meta.epoch, seq: alloc.next() };
      // Plan 3 Task 4: the held/ subtrees of the placed hold ops, the removals (local_only, PRO-27 compaction) and the heldIds.
      const held = await planHeld(core, it, T, ops, puts);
      if (held.unreadable.length > 0) {
        core.outbox = Outbox.fromJson(outboxBefore);
        for (const u of held.unreadable) {
          unreadableIds.add(u.holdId);
          tellUnreadable(core, u.holdId, u.path);
        }
        withhold = withUnreadable(withholdOf(core, it), unreadableIds);
        continue;
      }
      const putting = held.edit !== undefined && held.edit.put.size > 0;

      // C = commit-tree OUT -p TIP, omitted when OUT == tree(TIP). HLD-37 trailers for every composed CS (Plan 3 Task 9, R3-43): the
      // 1-based seq of its publishes, state checkpoint|closed, origin, checks from the CS table; one Cowork-Seat per contributing seat
      // or human.
      let c: Oid | null = null;
      let cs: CsTrailer[] = [];
      let csPaths = new Map<string, string[]>();
      if (outTree !== tipTree) {
        if (comp === null) throw new Error('publishStep: a code tree without a composition');
        cs = csIds.map((csId) => core.cs.trailer(csId, comp!.csPaths.get(csId)?.length ?? 0));
        csPaths = new Map(csIds.map((id) => [id, comp!.csPaths.get(id) ?? []]));
        const seats = csIds.length === 0 ? ['human'] : csIds.map(seatOfCs);
        c = await repo.commitTree({ tree: outTree, parents: [it.tip], subject: CODE_SUBJECT, trailers: liveCommitTrailers(writer, seats, cs, csPaths, null) });
      }
      const liveCode = c ?? it.tip;
      // A board commit at a checkpoint height carries the fold state after it (PRO-26).
      let checkpoint: Buffer | null = null;
      if ((it.fold.height + 1) % CHECKPOINT_EVERY === 0) {
        const draft: BoardDraft = {
          liveCode, writer, cs, protocol: (await readBoardCommit(repo, T)).protocol, checkpoint: null, heldIds: held.heldIds,
          opsLines: serializeOps(ops).toString('utf8').split('\n').filter((l) => l.length > 0),
        };
        checkpoint = serializeFold(foldCommit(it.fold, draft, core.peerId).state);
      }
      let bnew: Oid;
      try {
        bnew = await buildBoardCommit(repo, {
          prevBoard: T, liveCode, writer, ops, cs, csPaths, protocol: null, checkpoint, ...(held.edit !== undefined ? { held: held.edit } : {}),
        });
      } catch (e) {
        if (!(e instanceof BoardCapError) || !putting) throw e;
        core.outbox = Outbox.fromJson(outboxBefore);
        openTreeEpisode(core, it, T, e.cap);
        withhold = withUnreadable(withholdOf(core, it), unreadableIds);
        puts = false;
        continue;
      }
      if (putting) endTreeEpisode(core, it);   // a build with puts fits the cap again
      built = { aTree, pTree, outTree, out, c, bnew, writer, ops, seqNext: next, conflicted, replaced, held };
      break;
    }
  } catch (e) {
    if (!isBuildFailure(e)) throw e;
    return buildFailure(core, e, records);
  }
  const { pTree, outTree, out, c, bnew, writer, ops, seqNext } = built;

  // 5 ENG-41 on what git wrote (ENG-09: both are commits before any refspec names them).
  if (!(await repo.hasObject(bnew, 'commit')) || (c !== null && !(await repo.hasObject(c, 'commit')))) {
    return assertFailed(core, 'd', null, records);
  }
  await ensureAttrs(core, it.epochBase, [...diffPaths(it.tipMap, out), ...diffPaths(it.A, P)]);
  const asserted = await prePushAsserts({
    T, tip: it.tip, tipMap: it.tipMap, A: it.A, P, out, outTree, emptyTree: await repo.emptyTree(),
    bnewParents: (await repo.readCommit(bnew)).parents, liveCode: c ?? it.tip, cParents: c === null ? null : (await repo.readCommit(c)).parents,
    scope: (p) => it.scope(p).cls, masked: comp?.masked ?? (() => false), heldAdded: built.held.added,
    readBlob: (o) => repo.readBlob(o),
  });
  if (!asserted.ok) return assertFailed(core, asserted.letter, asserted.path, records);

  // 7 the push intent with t/P, seq_next and the allocated outbox (PRO-08), before any push.
  const mirror: OidOrAbsent = it.fetched?.code ?? ABSENT;
  let withMirror = mirror === ABSENT;
  if (!withMirror) {
    try {
      withMirror = await repo.isAncestor(mirror as Oid, it.tip);
    } catch (e) {
      if (!(e instanceof GitCommandError)) throw e;
      withMirror = false;
    }
  }
  const intent: PushIntent = {
    kind: 'push', bnew, c, lease_board: T, lease_code: mirror, cs_ids: [...csIds], writer_seq: writer.seq, op_ids: ops.map((o) => o.id),
  };
  await commitWith(core, { intent, t: new Map<JournalTree, Oid>([['P', pTree]]), meta: metaNow(core, { seq_next: seqNext }) }, null);
  return {
    intent, aTree: built.aTree, pTree, outTree, c, bnew, records, conflicted: built.conflicted, replaced: built.replaced, withMirror, mirror,
    mirrored: built.held.mirrored,
  };
}

/** Step 8 (ENG-43): the board leased on T; the mirror set to TIP when its fetched value is ABSENT or an ancestor of TIP; the outcome. */
async function push(core: EngineCore, it: IterationCtx, comp: PublishComposition | null, P: TreeMap, T: Oid, rank: number, j: Journaled): Promise<PublishReport> {
  const { deps } = core;
  const { intent, c, bnew, records, withMirror, mirror } = j;
  const specs: PushSpec[] = [pushSpec(bnew, core.refs.remoteBoard, T)];
  if (withMirror) specs.push(pushSpec(it.tip, core.refs.remoteCode, mirror));
  const previousStreak = core.view!.meta.rejections !== null && core.view!.meta.rejections.lease === T ? core.view!.meta.rejections.n : 0;
  let detail: Classified | null = null;
  const pushed = await governedPush(core, c === null ? 'board_only' : 'publish', { specs }, false, rank, async (raw) => {
    crashpoint('publish.sent');
    detail = await classifyAttempt(core, raw, T, bnew, previousStreak);
    const d: Classified = detail;
    return { outcome: d.outcome, transient: d.outcome === 'transient' || d.outcome === 'nonretryable', landed: d.outcome === 'landed' };
  });
  const base = {
    attempted: pushed !== 'denied', bnew, c, records, maskInvalid: false, mirrored: [...new Set(j.mirrored.map((m) => m.id))], dependencyPins: [], k7: [], dropped: [], assert: null,
  };
  if (pushed === 'denied' || detail === null) {
    await commitWith(core, { intent: { kind: 'none' }, t: new Map(), meta: metaNow(core) }, null);
    return { ...base, mirrored: [], outcome: 'skipped', why: 'window' };   // no Bnew was pushed (PublishReport.mirrored)
  }
  const d: Classified = detail;
  switch (d.outcome) {
    case 'landed': {
      crashpoint('publish.landed');
      if (!(await okUpdateOrKeep(core, intent, P))) {
        // The ok update could not start (a holder on a scratch index, SCRATCH_RESET_FAILED logged): nothing changed, the
        // push intent stays journaled and the next resolvePushIntent (iterate or restart) applies it by observation.
        return { ...base, outcome: 'skipped', why: 'intent_unresolved' };
      }
      observeOwnLanding(core, bnew, T);
      it.A = (await currentA(core)).A;
      return { ...base, outcome: 'landed', why: null };
    }
    case 'lease_lost':
      // PRO-43: re-fetch, re-merge and re-run every guard in the next window (the classify fetch re-anchored the governor).
      await commitWith(core, { intent: { kind: 'none' }, t: new Map(), meta: metaNow(core, { rejections: null }) }, null);
      return { ...base, outcome: 'lease_lost', why: null };
    case 'transient':
      if (d.streak === 2) signal(core, 'rejection_streak', true, true);
      await commitWith(core, { intent: { kind: 'none' }, t: new Map(), meta: metaNow(core, { rejections: { lease: T, n: d.streak } }) }, null);
      deps.log.write('warn', 'PUSH_REJECTED', { lease: T, streak: d.streak });
      return { ...base, outcome: 'transient', why: null };
    case 'nonretryable': {
      const holdId = await enterNonretryable(core, it, intent, comp, P, T, (pushed as { raw: PushOutcomeRaw }).raw.stderr);
      return { ...base, outcome: 'nonretryable', why: null, records: [...records, holdId] };
    }
    case 'network':
      if (d.observed) {
        // T′ == T without a ref status: the push did not land; the streak is unchanged and not counted.
        await commitWith(core, { intent: { kind: 'none' }, t: new Map(), meta: metaNow(core) }, null);
      }
      // Unobserved: the intent stays journaled and the next publishStep (or a restart) resolves it by observation.
      return { ...base, outcome: 'network', why: d.observed ? null : 'unobserved' };
    default:
      throw new Error(`publishStep: unexpected outcome ${String(d.outcome)}`);
  }
}

/** A failed ENG-41 / HLD-19 assertion: no push, a doctor record and NOT_CONVERGED{cause: publish_assert} (never S_disk instead); the report's `assert` carries it to status.json (final review FC-2). */
function assertFailed(core: EngineCore, letter: AssertLetter, path: string | null, records: string[]): PublishReport {
  core.deps.log.write('error', 'NOT_CONVERGED', { cause: 'publish_assert', check: letter, path });
  return report('aborted', `publish_assert:${letter}`, { records, assert: { check: letter, path } });
}

/**
 * ENG-45 at the third consecutive rejection with the board unchanged: the rejected publish's change-sets become one host-reject
 * PIN (ON_DISK, masked, never published until a human resume ends it: Engine.resumeAfterNonretryable), meta.nonretryable,
 * and the host's text in the daemon log only.
 * 05-holds F6 asks for one host-reject PIN also when the publish carried ops only: that PIN has no path and no change-set
 * (ruling; the record schema admits a pathless record for this guard only). Every host-reject record has origin 'daemon':
 * the engine creates it by outcome, like a K4 record.
 */
async function enterNonretryable(core: EngineCore, it: IterationCtx, intent: PushIntent, comp: PublishComposition | null, P: TreeMap, T: Oid, stderr: Buffer): Promise<string> {
  const paths = [...new Set(intent.cs_ids.flatMap((id) => comp?.csPaths.get(id) ?? []))].sort();
  await ensureAttrs(core, it.epochBase, paths);
  // BlobMap entries by setBlob (own properties): a root path named __proto__ is an ordinary key, never the map's prototype
  // (an assignment h0[p] would drop it and the record check would then refuse the PIN; final review FC minor).
  const h0: BlobMap = {};
  const h1: BlobMap = {};
  for (const p of paths) {
    setBlob(h0, p, it.A.get(p)?.oid ?? ABSENT);
    setBlob(h1, p, P.get(p)?.oid ?? ABSENT);
  }
  const holdId = await core.holds.hold({
    kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths, blobs: { h0, h1 }, guard: 'host-reject', origin: 'daemon',
    cs_ids: paths.length > 0 ? [...intent.cs_ids] : [], displaced_by: null, local_only: paths.some((p) => it.scope(p).cls !== 'LIVE'),
  });
  await commitWith(core, {
    intent: { kind: 'none' }, t: new Map(),
    meta: metaNow(core, { rejections: { lease: T, n: 3 }, nonretryable: { lease: T, hold_id: holdId } }),
  }, null);
  // The host's text without URL userinfo (a host may echo the remote URL with its credentials; final review FC minor).
  core.deps.log.write('error', 'NONRETRYABLE', { hold_id: holdId, lease: T, host_said: sanitizeText(hostText(stderr)) });
  return holdId;
}
