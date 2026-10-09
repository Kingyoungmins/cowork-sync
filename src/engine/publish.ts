// Publish (01-engine §3.12; ENG-39…ENG-46; PRO-08, PRO-09, PRO-12, PRO-40…PRO-45, PRO-54, PRO-55; HLD-42; glossary §24
// defaults 1 and 3, §26.2 items 1–2, §27.2; rulings R-02, R-16…R-21, R-30).
//
//   gates     the fetch's HTTP throttle signal (before anything, a 429 is a failed fetch); an unpublished HOST_THROTTLED
//             event dropped once the mode is normal (P2-R18); no publish when the fetch failed, while a push intent is
//             journaled (resolved by observation first), while a restore is stranded (P2-STRANDED), on a failed
//             snapshot or a filter failure (P2-SNAPFILTERS); code only in the ok state, ops per PRO-45 (P2-PUSHSTATES).
//             Without a lease (CCI-50) the loop captures nothing new and this step flushes the pairs captured before
//   1  P     MASK(R) of the newest ready pair per path, A elsewhere (HLD-42, composeP; pairs touching a held PIN skipped,
//             P2-PIN); HLD-19's INV-MASK over P. P == A and no allowed op: nothing is pushed (PRO-42), and composed pairs
//             count as published (R-02: OUT == tree(TIP) with no ops)
//      window governor.mayAttempt(rank) before anything is built (no merge, object or intent outside a window)
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
import { buildBoardCommit, CODE_SUBJECT, liveCommitTrailers, readBoardCommit, BoardMalformedError, type BoardDraft, type CsTrailer, type WriterId } from '../board/boardCommit.js';
import { CHECKPOINT_EVERY, foldCommit, governorRank, liveSet, serializeFold } from '../board/fold.js';
import { SLOW_PUSH_MS, type ThrottleSignal } from '../board/governor.js';
import { BoardCapError, OPS_MAX_BYTES, OPS_MAX_LINES, serializeOps, type Op, type OpDraft } from '../board/ops.js';
import { Outbox, type PushState, type SeqAllocator } from '../board/outbox.js';
import { conflict, type ConflictCtx, type ConflictVerdict, type UnitKind } from '../data/conflict.js';
import { wildmatch } from '../data/scope.js';
import { readHttpThrottle } from '../git/httpStatus.js';
import { MergeFailedError, mergeTree } from '../git/merge.js';
import { ABSENT, OidError, type Oid, type OidOrAbsent } from '../git/oid.js';
import { buildPushArgv, deleteProbeRef, pushSpec, runPush, type PushOutcomeRaw, type PushRefStatus, type PushSpec } from '../git/push.js';
import { GitCommandError, type GitRepo, type IndexEdit, type TreeEntry, type TreeMap } from '../git/repo.js';
import { ReadyBaseMismatchError, type RebaseChange } from '../holds/changesets.js';
import { maskEntries, maskReason, type MaskInputs } from '../holds/mask.js';
import { anchorNow, elapsedMono } from '../ports/clock.js';
import { crashpoint, KilledAt } from '../ports/crashpoint.js';
import type { PushPurpose, TraceOutcome } from '../ports/trace.js';
import { sanitizeText } from '../sec/redact.js';
import { heldPathInP, prePushAsserts, type AssertLetter } from './assertions.js';
import {
  boardOnlyFirstPublish, currentA, editable, ensureAttrs, foldPatch, liveCodeOf, observeFetch, observeOwnLanding, pathIsText, pinnedPaths, sameEntry,
  setBoardOnlyFirstPublish, setCurrentA, tickInputOf,
  type EngineCore, type IterationCtx,
} from './core.js';
import { resetScratchIndex, ScratchResetError } from './diskEq.js';
import type { FetchView } from './fetcher.js';
import type { Meta } from './meta.js';
import { classifyPublish, type PublishOutcome } from './pushResult.js';
import { StateCasLostError, type Intent, type JournalTree, type Transition } from './state.js';
import { diffPaths, isRegularEntry as isRegular } from './treeDiff.js';
import { editsBetween, editTreeIndexOnly, IndexRefusedPathError } from './treeEdit.js';

export interface PublishReport {
  attempted: boolean;
  outcome: PublishOutcome | 'skipped' | 'aborted' | 'nothing';
  why: string | null;                 // e.g. 'window', 'state', 'publish_assert:b', 'snapshot_failed', 'filter_failure', 'path_not_indexable'
  bnew: Oid | null; c: Oid | null; records: string[];
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
  return { attempted: false, outcome, why, bnew: null, c: null, records: [], assert: null, ...extra };
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
export function handOverThrottle(core: EngineCore, view: FetchView | null, states: readonly PushState[]): void {
  if (view !== null) fetchSignal(core, view, pendingCheap(core, states));
}

/**
 * Allowed pending work without composing P: a ready pair composeP would include (none touching a held PIN, P2-PIN) while
 * code may be pushed, or ops allowed in every active state. A pair skipped by P2-PIN waits for a human, not for a window.
 */
function pendingCheap(core: EngineCore, states: readonly PushState[]): boolean {
  if (core.outbox.pendingAllowed(states)) return true;
  if (states.length !== 0) return false;
  const pinned = pinnedPaths(core);
  return core.cs.ready().some((pair) => !pair.paths.some((p) => pinned.has(p)));
}

// ---- state updates ------------------------------------------------------------------------------------------------

/** The meta every publish transition writes: the fold of this run (R-14, P2-FOLDPERSIST), the own fallback (ENG-05) and the outbox. */
function metaNow(core: EngineCore, over: Partial<Meta> = {}): Meta {
  const view = core.view!;
  const fp = foldPatch(core);
  return { ...view.meta, throttle: core.governor.toMeta(), outbox: core.outbox.toJson(), ...(fp !== null ? fp.meta : {}), ...over };
}

/** One state update carrying the fold patch; ChangeSets changed memory first, so a non-fatal failure restores it (Task 11). */
async function commitWith(core: EngineCore, t: Transition, ready: ReturnType<EngineCore['cs']['ready']> | null): Promise<void> {
  const prev = core.view!;
  const fp = foldPatch(core);
  try {
    await core.commit({ ...t, ...(ready !== null ? { ready } : {}), ...(fp !== null ? { fold: fp.fold } : {}) });
  } catch (e) {
    if (ready !== null && !(e instanceof StateCasLostError) && !(e instanceof KilledAt)) core.cs.restore(prev.ready, prev.meta.cs_human_next);
    throw e;
  }
}

/** R-02: the composed pairs count as published when nothing is pushed because OUT == tree(TIP) with no ops. */
async function dropPublished(core: EngineCore, csIds: readonly string[]): Promise<void> {
  if (csIds.length === 0) return;
  core.cs.published(csIds);
  await commitWith(core, { meta: metaNow(core) }, core.cs.ready());
}

// ---- P (HLD-42) ---------------------------------------------------------------------------------------------------

interface Composition {
  P: Map<string, TreeEntry>; csIds: string[]; csPaths: Map<string, string[]>;
  /** A record (not a path class) masks p: ENG-41 (i). */
  masked: (p: string) => boolean;
}

/** P = MASK(R) of the newest ready pair covering each path, A elsewhere; pairs touching a held PIN are skipped (P2-PIN). */
async function compose(core: EngineCore, it: IterationCtx): Promise<Composition> {
  const records = core.holds.maskingRecords();
  await ensureAttrs(core, it.epochBase, [...core.cs.ready().flatMap((r) => r.paths), ...records.flatMap((r) => r.paths)]);
  const inp: MaskInputs = { A: it.A, scope: (p) => it.scope(p).cls, records };
  const c = await core.cs.composeP(core.repo, it.A, (X) => maskEntries(X, inp), pinnedPaths(core));
  const masked = (p: string): boolean => {
    const r = maskReason(p, inp);
    return r !== null && r !== 'path_class';
  };
  return { ...c, masked };
}

/** PRO-42: P ≠ A somewhere, or allowed outbox ops. */
export async function publishPending(core: EngineCore, it: IterationCtx): Promise<boolean> {
  const states = it.pushStates;
  if (core.outbox.pendingAllowed(states)) return true;
  if (states.length !== 0 || core.cs.ready().length === 0) return false;
  try {
    return diffPaths(it.A, (await compose(core, it)).P).length > 0;
  } catch (e) {
    if (e instanceof ReadyBaseMismatchError) return true;   // pending; the publish aborts with ENG-39's report
    throw e;
  }
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
async function buildOut(core: EngineCore, it: IterationCtx, comp: Composition, aTree: Oid, pTree: Oid, tipTree: Oid): Promise<Merged> {
  const { repo, deps } = core;
  const view = core.view!;
  const A = it.A;
  const P = comp.P;
  const TIP = it.tipMap;
  const merged = await mergeTree(repo, aTree, pTree, tipTree);
  deps.trace.emit({
    kind: 'merge', peer: core.peerId, use: 'publish', base: aTree, ours: pTree, theirs: tipTree, aTree, laC: view.laC, laB: view.laB, tip: it.tip,
    t: it.T as Oid, rc: merged.rc,
  });
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
  }, rebase.ready);
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

/** Steps 1 and 3–8 of the §3.12 pipeline (B1 is Plan 4, T0 Plan 3) on the leased tip, re-run from scratch every window. */
export async function publishStep(core: EngineCore, it: IterationCtx): Promise<PublishReport> {
  const view0 = core.view;
  if (view0 === null) throw new Error('publishStep: no state');
  const { repo, deps, governor } = core;
  const states = it.pushStates;

  // PRO-55 signals of this iteration's fetch (a 429 is a failed fetch: before the fetch gate), then P2-R18's drop.
  handOverThrottle(core, it.fetched, states);
  if (governor.mode() === 'normal') core.outbox.drop(isThrottleDraft);

  if (it.fetched !== null && !it.fetched.ok) return report('skipped', 'fetch_failed');
  if (it.T === ABSENT) return report('skipped', 'no_board');
  const T = it.T;
  if (view0.intent.kind === 'push') return resolvePushIntent(core, it);
  if (view0.intent.kind !== 'none') return report('skipped', 'intent');
  if (core.writer.strandedPaths().length > 0) return report('skipped', 'stranded');   // P2-NARROW: no new intent
  // CCI-50 (Task 17 ruling): without a lease for 2 min the loop takes no new capture (its capture gate), and this step
  // composes only ready pairs captured before — the flush CCI-50 allows — and pending board ops; no lease gate here.
  // A failed snapshot blocks every publish; an iteration that took none (fetch and fold only under FREEZE(EPOCH),
  // ENG-15 / LIF-10) may publish board-only ops at most: no code is allowed in a frozen state.
  if (it.tick?.failed === true || (it.tick === null && states.length === 0)) return report('skipped', 'snapshot_failed');
  if (it.tick?.publishBlocked === true || it.mat?.publishBlocked === true) return report('skipped', 'filter_failure');

  // 1 P (code only in the ok state, P2-PUSHSTATES). ENG-52 step 8: the first publish after a join with nothing opted in
  // composes no code (OUT == tree(TIP)); a ready pair captured meanwhile rides the next publish.
  const codeAllowed = states.length === 0 && !boardOnlyFirstPublish(core);
  let comp: Composition | null = null;
  if (codeAllowed && core.cs.ready().length > 0) {
    try {
      comp = await compose(core, it);
    } catch (e) {
      if (!(e instanceof ReadyBaseMismatchError)) throw e;
      deps.log.write('error', 'NOT_CONVERGED', { cause: 'publish_assert', check: 'a_cap', path: e.path });
      return report('aborted', 'ready_base_mismatch', { assert: { check: 'a_cap', path: e.path } });
    }
    // ENG-41 (i) / HLD-19 INV-MASK before anything is built: no held path differs from A in P (prePushAsserts' letters).
    await ensureAttrs(core, it.epochBase, diffPaths(it.A, comp.P));
    const held = heldPathInP(it.A, comp.P, comp.masked, (p) => it.scope(p).cls);
    if (held !== null) return assertFailed(core, held.letter, held.path, []);
  }
  const P: TreeMap = comp?.P ?? it.A;
  const code = comp !== null && diffPaths(it.A, P).length > 0;
  const opsAllowed = core.outbox.pendingAllowed(states);
  if (!code && !opsAllowed) {
    if (comp !== null) await dropPublished(core, comp.csIds);   // P == A: OUT == tree(TIP), nothing to push (R-02)
    const blocked = states.length > 0 && (core.cs.ready().length > 0 || core.outbox.size > 0);
    return report(blocked ? 'skipped' : 'nothing', blocked ? 'state' : null);
  }

  // The window (PRO-40) before anything is built.
  const rank = governorRank(it.fold, core.peerId);
  if (!governor.mayAttempt(rank, true, true)) return report('skipped', 'window');

  // 3–7: OUT, C, Bnew, ENG-41 and the push intent. Until the push intent is committed, every exit (an early return, a
  // build failure, a failed assertion, a failed state update, any throw) restores the outbox from its JSON before
  // Outbox.take(): no op may keep a seq that meta.seq_next never recorded (PRO-08).
  const outboxBefore = core.outbox.toJson();
  let j: Journaled | PublishReport | null = null;
  try {
    j = await buildAndJournal(core, it, comp, code, P, T);
  } finally {
    if (j === null || !('intent' in j)) core.outbox = Outbox.fromJson(outboxBefore);
  }
  if (!('intent' in j)) return j;
  crashpoint('publish.out_built');
  deps.trace.emit({
    kind: 'publish', peer: core.peerId, t: T, tip: it.tip, aTree: j.aTree, pTree: j.pTree, outTree: j.outTree, c: j.c, bnew: j.bnew,
    conflicted: j.conflicted, replaced: j.replaced,
  });
  await deps.ports.scheduler.yieldPoint('publish.beforePush');
  return push(core, it, comp, P, T, rank, j);
}

/** What buildAndJournal committed: the push intent and what the push and the trace need. */
interface Journaled {
  intent: PushIntent; aTree: Oid; pTree: Oid; outTree: Oid; c: Oid | null; bnew: Oid; records: string[];
  conflicted: string[]; replaced: Array<{ path: string; blob: string | null }>; withMirror: boolean; mirror: OidOrAbsent;
}

/**
 * Steps 3–7 on the leased tip: OUT, C and Bnew (a failing git call or an empty oid aborts before any intent or push,
 * ENG-09), ENG-41 on what git wrote, then the push intent with t/P, seq_next and the allocated outbox (PRO-08). A report
 * is an exit before the intent; the caller restores the outbox on every exit but a committed intent.
 */
async function buildAndJournal(core: EngineCore, it: IterationCtx, comp: Composition | null, code: boolean, P: TreeMap, T: Oid): Promise<Journaled | PublishReport> {
  const { repo, deps } = core;
  const states = it.pushStates;
  const csIds = comp?.csIds ?? [];
  let records: string[] = [];
  let built: { aTree: Oid; pTree: Oid; outTree: Oid; out: TreeMap; c: Oid | null; bnew: Oid; writer: WriterId; ops: Op[]; seqNext: number; conflicted: string[]; replaced: Array<{ path: string; blob: string | null }> };
  try {
    const { aTree } = await currentA(core);
    const { tree: tipTree } = await liveCodeOf(core, T);
    let pTree = aTree;
    let outTree = tipTree;
    let out: TreeMap = it.tipMap;
    let conflicted: string[] = [];
    let replaced: Array<{ path: string; blob: string | null }> = [];
    if (code && comp !== null) {
      pTree = await editTreeIndexOnly(repo, deps.ports.fs, aTree, editsBetween(it.A, P), core.scratch('p'));
      if (deps.testMutants.has('M06')) {
        // Mutant M06 (R-29): S_disk pushed as OUT. ENG-41 (b)/(c) must stop it.
        it.mat ??= await core.snapshot.materialize(tickInputOf(core, it));
        outTree = it.mat.sDisk;
        out = it.mat.sDiskMap;
      } else {
        const m = await buildOut(core, it, comp, aTree, pTree, tipTree);
        ({ outTree, out, conflicted, replaced } = m);
        records = m.records;
        treeRefused.delete(core);   // FB-6: an OUT was built, the pause (if any) is over
      }
    }
    if (boardOnlyFirstPublish(core) && outTree !== tipTree) {
      // ENG-52 step 8's runtime assertion: never true unless the composition above is broken.
      deps.log.write('error', 'NOT_CONVERGED', { cause: 'publish_assert', check: 'join_first_publish' });
      return report('aborted', 'join_first_publish', { records, assert: { check: 'join_first_publish', path: null } });
    }
    if (outTree === tipTree && !core.outbox.pendingAllowed(states)) {
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
    const ops = core.outbox.take(states, self, alloc, { maxOps: OPS_MAX_LINES, maxBytes: OPS_MAX_BYTES });
    const writer: WriterId = { peer: core.peerId, epoch: meta.epoch, seq: alloc.next() };

    // C = commit-tree OUT -p TIP, omitted when OUT == tree(TIP) (HLD-37 trailers for every composed human CS).
    let c: Oid | null = null;
    let cs: CsTrailer[] = [];
    let csPaths = new Map<string, string[]>();
    if (outTree !== tipTree) {
      if (comp === null) throw new Error('publishStep: a code tree without a composition');
      cs = csIds.map((csId) => ({ csId, state: 'closed', seq: 0, origin: 'human', checks: 'skipped', paths: comp!.csPaths.get(csId)?.length ?? 0 }));
      csPaths = new Map(csIds.map((id) => [id, comp!.csPaths.get(id) ?? []]));
      c = await repo.commitTree({ tree: outTree, parents: [it.tip], subject: CODE_SUBJECT, trailers: liveCommitTrailers(writer, ['human'], cs, csPaths, null) });
    }
    const liveCode = c ?? it.tip;
    // A board commit at a checkpoint height carries the fold state after it (PRO-26).
    let checkpoint: Buffer | null = null;
    if ((it.fold.height + 1) % CHECKPOINT_EVERY === 0) {
      const draft: BoardDraft = {
        liveCode, writer, cs, protocol: (await readBoardCommit(repo, T)).protocol, checkpoint: null, heldIds: [],
        opsLines: serializeOps(ops).toString('utf8').split('\n').filter((l) => l.length > 0),
      };
      checkpoint = serializeFold(foldCommit(it.fold, draft, core.peerId).state);
    }
    const bnew = await buildBoardCommit(repo, { prevBoard: T, liveCode, writer, ops, cs, csPaths, protocol: null, checkpoint });
    built = { aTree, pTree, outTree, out, c, bnew, writer, ops, seqNext: next, conflicted, replaced };
  } catch (e) {
    if (!isBuildFailure(e)) throw e;
    // Final review FB-6: git cannot index a name of the merged tree here (TIP's `a:b.txt` on Windows): no OUT can be built
    // until the name leaves TIP. A typed pause, visible in status through publishTreeRefused (the loop lists the ready
    // pairs' paths), never a silent build_failed; logged once when it starts.
    if (e instanceof IndexRefusedPathError) {
      if (!treeRefused.has(core)) deps.log.write('warn', 'PUBLISH_TREE_REFUSED', { refused: e.paths.length });
      treeRefused.set(core, e.paths);
      return report('aborted', 'path_not_indexable', { records });
    }
    deps.log.write('error', 'PUBLISH_BUILD_FAILED', { code: e instanceof GitCommandError ? e.code : -1, kind: e instanceof Error ? e.name : 'unknown' });
    return report('aborted', 'build_failed', { records });
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
    scope: (p) => it.scope(p).cls, masked: comp?.masked ?? (() => false), heldEntriesAdded: 0,
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
  return { intent, aTree: built.aTree, pTree, outTree, c, bnew, records, conflicted: built.conflicted, replaced: built.replaced, withMirror, mirror };
}

/** Step 8 (ENG-43): the board leased on T; the mirror set to TIP when its fetched value is ABSENT or an ancestor of TIP; the outcome. */
async function push(core: EngineCore, it: IterationCtx, comp: Composition | null, P: TreeMap, T: Oid, rank: number, j: Journaled): Promise<PublishReport> {
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
  const base = { attempted: pushed !== 'denied', bnew, c, records, assert: null };
  if (pushed === 'denied' || detail === null) {
    await commitWith(core, { intent: { kind: 'none' }, t: new Map(), meta: metaNow(core) }, null);
    return { ...base, outcome: 'skipped', why: 'window' };
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
async function enterNonretryable(core: EngineCore, it: IterationCtx, intent: PushIntent, comp: Composition | null, P: TreeMap, T: Oid, stderr: Buffer): Promise<string> {
  const paths = [...new Set(intent.cs_ids.flatMap((id) => comp?.csPaths.get(id) ?? []))].sort();
  await ensureAttrs(core, it.epochBase, paths);
  // Path-keyed maps as own properties (Object.fromEntries defines each key): an assignment h0[p] would drop a path named
  // __proto__ (final review FC minor), and the record check would then refuse the PIN.
  const h0: Record<string, OidOrAbsent> = Object.fromEntries(paths.map((p) => [p, it.A.get(p)?.oid ?? ABSENT]));
  const h1: Record<string, OidOrAbsent> = Object.fromEntries(paths.map((p) => [p, P.get(p)?.oid ?? ABSENT]));
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
