// Rewrite incidents and /cowork recover (01-engine §3.7; ENG-21, ENG-22, ENG-59 recover.displaced / recover.reanchor;
// glossary §4 displaced, incident-<n>, incident-<n>-own, §8 INCIDENT, §15 preview/confirm; PRO-25; INV-FF's recover
// exception, INV-OID; rulings R-21, R-27 and the Task 16 fix-round rulings). The incident CHECK itself is incident.ts
// (ENG-20); prepareIteration runs it and hands a failure here.
//
//   enterIncident   one state update: FREEZE(INCIDENT), meta.incident {n, observed oids}, incident_next + 1; T stored at
//                   refs/cowork-local/<e>/incident-<n> whatever its object type (nothing for an ABSENT or missing T);
//                   one listing of the displaced refs; the INCIDENT event (trace and daemon log, old and new oids, and the
//                   copy's ref name or kept_local). Then, in an ORDINARY window (R-21: the ENG-21 copy is governed and
//                   counted and waits like any attempt), one push of LA_B to displaced/<oid12(LA_B)> with an ABSENT
//                   lease, unless 3 displaced refs exist without it (the copy stays local: 'kept_local'). Re-entrant: the
//                   loop calls it every iteration of the incident branch; a later call writes no state and retries only
//                   a copy still pending. A landed copy is recorded in meta.displaced (one state update).
//   clearIncident…  the check passes again on a fetch of THIS iteration that succeeded: one state update clearing INCIDENT
//                   and carrying the iteration's fold, which Folder.foldTo already rebuilt from the checkpoint when the
//                   persisted fold was off the restored chain (PRO-25); UNFROZEN; the local copies of the displaced refs
//                   are deleted, best effort (a failure is logged, and every later clear tries again).
//   recover         1 INCIDENT, a fetch that succeeds NOW (Fetcher.fetchNow: no spacing, no backoff; V = its board tip);
//                     a confirm resolves a kept push intent by observation first (P2-PUSHINTENT-FIRST; unresolved:
//                     RECOVER_OFFLINE{push_intent_unresolved}, state unchanged), then re-plans; a preview changes nothing
//                     and reports the kept intent
//                   2 candidates = LA_B ∪ the displaced refs (lsRemotePrefix; names validated, at most 12 fetched by
//                     explicit name) minus recover's own copies displaced/<peer>/v-<n>, commits only; a displaced value
//                     equal to V stays a candidate (Task 16 round-2 ruling)
//                   2a team already recovered ((i) V on the chain of no candidate other than V itself — the V-equal
//                     exclusion applies here only; (ii) D = the newest common first-parent ancestor of V and LA_B is a
//                     displaced candidate ≠ V; (iii) the full CHECK passes from D to V; a failing walk refuses
//                     RECOVER_OFFLINE{walk}) → re-anchor, which needs the symbolic branch HEAD (RECOVER_HEAD_STATE{op}):
//                     LA_B at incident-<n>-own before any state change, crashpoint('recover.reanchor'), then ONE state
//                     update: lostStateRebuild(V, 're_anchor') with INCIDENT cleared and the unlanded outbox ops rebuilt
//                     as drafts under the new epoch (PRO-25), led by that epoch's join op (final review FC-7); no push of
//                     any kind
//                   3 X = the candidate whose first-parent chain holds every other (else RECOVER_AMBIGUOUS{candidates,
//                     displaced ref names}); X must pass the incident CHECK from LA_B (its chain board- and live-shaped),
//                     else RECOVER_AMBIGUOUS{reason: 'x_check', ref, why} — in the plan, so before any push or crashpoint
//                   4 V on X's chain, or held by a displaced ref already, or copied to displaced/<peer>/v-<k> with an
//                     ABSENT lease (no slot: RECOVER_DISPLACED_FULL); crashpoint('recover.displaced')
//                   5 X over V and live_code(X) over the fetched mirror, both --force-with-lease, in one push
//                   6 on board ok: one update clearing INCIDENT
//                   Every recover push is governed, counted and exempt from the window (R-21). A preview id is the first
//                   6 hex of sha256 over (mode, LA_B, V, X, A, candidates, restart paths); a confirm whose id no longer
//                   matches is refused RECOVER_PREVIEW_STALE with the fresh preview (glossary §15). A push that does not
//                   land refuses RECOVER_OFFLINE with reason lease_lost, rejected (a host rejection), denied (the
//                   governor still denies it after the cap wait) or fetch (no answer).
//
// Nothing here throws for remote content or the network: a refusal (RecoverRefusal) or a pending copy instead. Remote
// content is what its source typed (BoardMalformedError, RemoteContentError: isRemoteContentError), never a plain Error.
import { createHash } from 'node:crypto';
import type { Json } from '../board/canonicalJson.js';
import { governorRank } from '../board/fold.js';
import type { OpDraft } from '../board/ops.js';
import { Outbox } from '../board/outbox.js';
import { portable } from '../data/scope.js';
import { fetchRefs, lsRemote, lsRemotePrefix, type FetchSpec } from '../git/fetch.js';
import { ABSENT, oid12, OidError, parseOid, type Oid, type OidOrAbsent } from '../git/oid.js';
import { pushSpec, type PushOutcomeRaw } from '../git/push.js';
import { checkRefName, GitCommandError } from '../git/repo.js';
import { anchorNow } from '../ports/clock.js';
import { crashpoint } from '../ports/crashpoint.js';
import type { PushPurpose, TraceOutcome } from '../ports/trace.js';
import { validPathSyntax } from '../sec/validators.js';
import { currentA, foldPatch, joinDraft, liveCodeOf, observeFetch, observeOwnLanding, pushStatesOf, type EngineCore, type IterationCtx } from './core.js';
import { isRemoteContentError } from './errors.js';
import type { FetchView } from './fetcher.js';
import { fpOk, incidentCheck, liveBase, type IncidentVerdict, type IncidentWhy } from './incident.js';
import type { Meta } from './meta.js';
import { governedPush, resolvePushIntent, type AttemptClass, type GovernedBody } from './publish.js';
import { headCheck, lostStateRebuild, scopeInputsFor, scopeOfEntry, tickOutside } from './restart.js';
import { StateCasLostError, type Intent } from './state.js';
import { diffPaths, sameTreeEntry } from './treeDiff.js';

/** At most 3 displaced refs per branch (glossary §20). */
export const DISPLACED_CAP = 3;
/** PREVIEW_STALE: the confirm's id no longer matches (LA_B, V, X, A), e.g. after a kept push intent resolved as landed. HEAD_STATE{op}: a re-anchor needs the symbolic branch HEAD. */
export type RecoverRefusal = 'RECOVER_NOT_IN_INCIDENT' | 'RECOVER_OFFLINE' | 'RECOVER_AMBIGUOUS' | 'RECOVER_DISPLACED_FULL' | 'RECOVER_PREVIEW_STALE' | 'RECOVER_HEAD_STATE';
/** RECOVER_OFFLINE's params.reason: no fetch or listing answered (or a push got no answer), a first-parent walk failed, a recover push lost its lease, was rejected by the host or was still denied by the governor after the cap wait, a kept push intent could not be resolved. */
export type RecoverOfflineReason = 'fetch' | 'walk' | 'lease_lost' | 'rejected' | 'denied' | 'push_intent_unresolved';
/** pushIntent: the push intent this peer still keeps (the confirm resolves it first; P2-PUSHINTENT-FIRST), else null. Not part of the id. */
export interface RecoverPreview {
  mode: 'restore' | 'reanchor'; V: OidOrAbsent; X: Oid | null; candidates: Oid[]; restartPaths: string[]; id: string;
  pushIntent: { bnew: Oid; lease_board: OidOrAbsent } | null;
}
export type RecoverResult = { ok: true; preview: RecoverPreview; done: boolean } | { ok: false; code: RecoverRefusal; params: Record<string, Json> };

/** Where this incident's ENG-21 copy of LA_B stands: waiting for a window, on the remote, or kept local (cap reached). */
export type DisplacedCopy = 'pending' | 'pushed' | 'kept_local';
/** The INCIDENT condition as status.json shows it (R-27; Task 17 reads it): n, the verdict (null after a restart), the copy and its ref name. */
export interface IncidentStatus { n: number; why: IncidentWhy | null; displaced: DisplacedCopy; ref: string; }

/** Rulings R-21 / genesis: an exempt push denied by the per-peer cap or the team guard is retried after this Δ on the Clock port. */
const CAP_WAIT_MS = 1_000;
const CAP_WAIT_MAX = 70;
/** First-parent walks of 2a (board chains): far beyond any chain a team builds. */
const FP_WALK_MAX = 1_000_000;
/** Displaced refs fetched by one recover at most (a remote with more is odd; the rest are skipped and logged). */
const DISPLACED_FETCH_MAX = DISPLACED_CAP * 4;
/**
 * DISPLACED_REF_SKIPPED lines one listing writes at most (final review FC minor: the remote decides how many names it
 * holds, so the daemon log must not grow with them); the rest are counted in one DISPLACED_REF_SKIPPED{reason: 'more',
 * omitted} line.
 */
export const DISPLACED_SKIP_LOG_MAX = 16;
/** The two names a displaced ref of this engine has: an ENG-21 detection copy, and recover's own copy of V (step 4). */
const DETECTION_TAIL = /^[0-9a-f]{12}$/;
const VCOPY_TAIL = /^([0-9a-f]{32})\/v-([1-9][0-9]{0,8})$/;

/** This run's view of the current incident (the verdict and the copy's state are not persisted; meta.displaced is), with the LA_B the incident entered with: the copy's value, under the name `ref` the INCIDENT event gave. */
interface IncidentMemory extends IncidentStatus { laB: Oid; }
const memory = new WeakMap<EngineCore, IncidentMemory>();

const refuse = (code: RecoverRefusal, params: Record<string, Json> = {}): RecoverResult => ({ ok: false, code, params });
const offline = (reason: RecoverOfflineReason, more: Record<string, Json> = {}): RecoverResult => refuse('RECOVER_OFFLINE', { reason, ...more });
const isIncident = (m: Meta): boolean => m.freeze_reasons.includes('INCIDENT');

/** The INCIDENT condition for status.json (R-27), or null when the peer is not in INCIDENT. */
export function incidentStatus(core: EngineCore): IncidentStatus | null {
  const view = core.view;
  if (view === null || !isIncident(view.meta)) return null;
  const n = view.meta.incident?.n ?? view.meta.incident_next;
  const m = memory.get(core);
  if (m !== undefined && m.n === n) return { n: m.n, why: m.why, displaced: m.displaced, ref: m.ref };
  return { n, why: null, displaced: view.meta.displaced.includes(oid12(view.laB)) ? 'pushed' : 'pending', ref: core.refs.displaced(view.laB) };
}

// ---- small helpers ------------------------------------------------------------------------------------------------

/** One state update of meta fields, carrying the fold of this run (R-14, P2-FOLDPERSIST). */
async function commitMeta(core: EngineCore, patch: Partial<Meta>): Promise<void> {
  const view = core.view!;
  const fp = foldPatch(core);
  await core.commit({ meta: { ...view.meta, ...(fp !== null ? fp.meta : {}), ...patch }, ...(fp !== null ? { fold: fp.fold } : {}) });
}

/**
 * A local cowork ref (incident-<n>, incident-<n>-own) set to `to` with --create-reflog, whatever the object's type (an
 * observed board value may be a tree or a blob: it is stored as it is; casRef's gate takes commits only); false (logged
 * INCIDENT_REF_SKIPPED) when the object is not in the local store. Another value appearing under it is a second writer.
 */
async function keepLocalRef(core: EngineCore, ref: string, to: Oid, reason: string): Promise<boolean> {
  const repo = core.repo;
  checkRefName('keepLocalRef', ref);
  const exists = await repo.run(['cat-file', '-e', parseOid(to)], { okCodes: [0, 1, 128] });
  if (exists.code !== 0) {
    core.deps.log.write('warn', 'INCIDENT_REF_SKIPPED', { ref, oid: to });
    return false;
  }
  const cur = await repo.readRef(ref);
  if (cur === to) return true;
  const args = ['update-ref', '--create-reflog', '-m', reason, ref, to, cur ?? '0'.repeat(to.length)];
  const r = await repo.run(args, { class: 'refupdate', identity: core.identity(), okCodes: [0, 1, 128] });
  if (r.code === 0) return true;
  if ((await repo.readRef(ref)) !== cur) throw new StateCasLostError(`${ref} changed under this daemon: a second writer`);
  throw new GitCommandError(args, r.code, r.stderr);
}

/** A first-parent walk that failed (a local git failure on objects this peer holds): step 2a and the plan fail closed. */
class WalkError extends Error {
  constructor(what: string, cause: unknown) {
    super(`recover: the first-parent walk ${what} failed`, { cause });
    this.name = 'WalkError';
  }
}

/** FP_OK(old, next) on commits: old is next or on next's first-parent chain; a git failure throws WalkError. */
async function onChain(core: EngineCore, old: Oid, next: Oid): Promise<boolean> {
  try {
    return await fpOk(core.repo, old, next);
  } catch (e) {
    if (e instanceof GitCommandError || e instanceof OidError) throw new WalkError(`${old}..${next}`, e);
    throw e;
  }
}

/** The first-parent chain of the commit `tip`, newest first; a git failure throws WalkError. */
async function chainOf(core: EngineCore, tip: Oid): Promise<Oid[]> {
  try {
    return await core.repo.firstParents(tip, null, FP_WALK_MAX);
  } catch (e) {
    if (e instanceof GitCommandError || e instanceof OidError) throw new WalkError(tip, e);
    throw e;
  }
}

/** The local copy of a displaced ref (refs/cowork-remote/<e>/displaced/<tail>). */
function localDisplacedRef(core: EngineCore, tail: string): string {
  return `refs/cowork-remote/${core.refs.e}/displaced/${tail}`;
}

/** A ref-name check that reports instead of throwing (checkRefName throws a plain Error for an invalid name). */
function refNameOk(ref: string): boolean {
  try {
    checkRefName('displaced', ref);
    return true;
  } catch (e) {
    if (e instanceof Error) return false;
    throw e;
  }
}

/**
 * Why a displaced ref name of the remote is not used (null: it is): its remote or local ref name is invalid ('ref'), its
 * tail fails the path syntax ('path') or D7 portability against the names already accepted — reserved or forbidden
 * characters, case collisions — ('portable', so no file system ever has to hold its local copy), or it is neither name
 * this engine writes ('shape').
 */
function nameProblem(core: EngineCore, ref: string, tail: string, accepted: ReadonlySet<string>): 'ref' | 'path' | 'portable' | 'shape' | null {
  if (!refNameOk(ref) || !refNameOk(localDisplacedRef(core, tail))) return 'ref';
  if (!validPathSyntax(tail)) return 'path';
  if (!portable(tail, accepted).ok) return 'portable';
  if (!DETECTION_TAIL.test(tail) && !VCOPY_TAIL.test(tail)) return 'shape';
  return null;
}

/** The remote's displaced refs: `all` as listed (the cap counts every one), `accepted` the validated names (≤ 12, in name order). */
interface Listing { all: ReadonlyMap<string, Oid>; accepted: ReadonlyMap<string, Oid>; }

/** lsRemotePrefix of the displaced prefix, names validated (skips logged DISPLACED_REF_SKIPPED when `logSkips`); null when the remote did not answer. */
async function listDisplaced(core: EngineCore, logSkips: boolean): Promise<Listing | null> {
  const prefix = core.refs.displacedPrefix;
  const r = await lsRemotePrefix(core.repo, core.deps.url, prefix);
  if (!r.ok) return null;
  const accepted = new Map<string, Oid>();
  const tails = new Set<string>();
  let skipped = 0;
  for (const [ref, oid] of [...r.values].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const tail = ref.slice(prefix.length);
    const problem = nameProblem(core, ref, tail, tails);
    const reason = problem ?? (accepted.size >= DISPLACED_FETCH_MAX ? 'cap' : null);
    if (reason !== null) {
      if (logSkips && skipped < DISPLACED_SKIP_LOG_MAX) core.deps.log.write('warn', 'DISPLACED_REF_SKIPPED', { reason, ref: problem === 'ref' || problem === 'path' ? null : ref });
      skipped += 1;
      continue;
    }
    accepted.set(ref, oid);
    tails.add(tail);
  }
  if (logSkips && skipped > DISPLACED_SKIP_LOG_MAX) {
    core.deps.log.write('warn', 'DISPLACED_REF_SKIPPED', { reason: 'more', ref: null, omitted: skipped - DISPLACED_SKIP_LOG_MAX });
  }
  return { all: r.values, accepted };
}

/** The accepted displaced refs fetched by explicit name into refs/cowork-remote/<e>/displaced/ (objects local); their values, or null when the fetch failed. */
async function fetchDisplaced(core: EngineCore, accepted: ReadonlyMap<string, Oid>): Promise<Map<string, Oid> | null> {
  const out = new Map<string, Oid>();
  if (accepted.size === 0) return out;
  const prefix = core.refs.displacedPrefix;
  const specs: FetchSpec[] = [...accepted.keys()].map((remote) => ({ remote, local: localDisplacedRef(core, remote.slice(prefix.length)) }));
  const f = await fetchRefs(core.repo, core.deps.url, specs);
  if (!f.ok) return null;
  for (const s of specs) {
    const v = f.values.get(s.remote);
    if (v !== undefined && v !== ABSENT) out.set(s.remote, v);
  }
  return out;
}

/**
 * Every local copy of a displaced ref is deleted (they are fetched again by the next recover; the remote keeps the refs).
 * Best effort: it runs after the clearing state update, so a git failure is logged (DISPLACED_LOCAL_DROP_FAILED) and the
 * copy kept; every later clear tries again. Anything but a GitCommandError (a crash, a second writer) still propagates.
 */
async function dropLocalDisplaced(core: EngineCore): Promise<void> {
  let refs: Array<{ ref: string; oid: Oid }>;
  try {
    refs = await core.repo.listRefs(localDisplacedRef(core, ''));
  } catch (e) {
    if (!(e instanceof GitCommandError)) throw e;
    core.deps.log.write('warn', 'DISPLACED_LOCAL_DROP_FAILED', { ref: null, rc: e.code });
    return;
  }
  for (const { ref, oid } of refs) {
    try {
      await core.repo.deleteLocalRef(ref, oid);
    } catch (e) {
      if (!(e instanceof GitCommandError)) throw e;
      core.deps.log.write('warn', 'DISPLACED_LOCAL_DROP_FAILED', { ref, rc: e.code });
    }
  }
}

/**
 * The outcome of a displaced-ref push, read from that ref (PRO-54: the ref the push leases, never text): `ok` → landed;
 * else ls-remote of the ref: it holds `want` → done (an existing ref with the same value counts as done, also for a push
 * that printed no status line); another value → lease lost; absent → transient after a rejection line, else network.
 */
async function classifyCopy(core: EngineCore, raw: PushOutcomeRaw, ref: string, want: Oid): Promise<AttemptClass> {
  const status = raw.statuses.get(ref) ?? 'none';
  if (status === 'ok') return { outcome: 'landed', transient: false, landed: true };
  const ls = await lsRemote(core.repo, core.deps.url, [ref]);
  if (!ls.ok) return { outcome: 'network', transient: false, landed: false };
  const now = ls.values.get(ref);
  if (now === want) return { outcome: 'ok', transient: false, landed: true };
  if (now !== undefined) return { outcome: 'lease_lost', transient: false, landed: false };
  return status === 'rejected' ? { outcome: 'transient', transient: true, landed: false } : { outcome: 'network', transient: false, landed: false };
}

/** R-21: a recover push, governed and counted, exempt from the window; a denial by the cap or the team guard is waited out. null: still denied. */
async function exemptPush(core: EngineCore, purpose: PushPurpose, body: GovernedBody, classify: (raw: PushOutcomeRaw) => Promise<AttemptClass>): Promise<{ raw: PushOutcomeRaw; cls: AttemptClass } | null> {
  for (let i = 0; ; i++) {
    const r = await governedPush(core, purpose, body, true, 1, classify);
    if (r !== 'denied') return r;
    if (i >= CAP_WAIT_MAX) return null;
    await core.deps.ports.clock.sleep(CAP_WAIT_MS);
  }
}

/** RECOVER_OFFLINE's reason for a recover push that did not land: its own for a lost lease, a host rejection and a governor denial that outlived the cap wait, else no answer ('fetch'). */
function pushFailure(push: 'displaced' | 'recover', outcome: TraceOutcome): RecoverResult {
  const reason: RecoverOfflineReason = outcome === 'denied' ? 'denied'
    : outcome === 'lease_lost' ? 'lease_lost'
      : outcome === 'transient' || outcome === 'nonretryable' ? 'rejected' : 'fetch';
  return offline(reason, { push, outcome });
}

// ---- incident entry (ENG-21) ----------------------------------------------------------------------------------------

/** No copy can be created: 3 displaced refs exist without the target, or the target holds another value. */
function keptLocal(listing: Listing, ref: string, laB: Oid): boolean {
  const existing = listing.all.get(ref);
  return (existing === undefined && listing.all.size >= DISPLACED_CAP) || (existing !== undefined && existing !== laB);
}

/** FREEZE(INCIDENT), incident-<n>, one governed ABSENT-leased displaced copy of LA_B (< 3); re-entrant (see the file comment). */
export async function enterIncident(core: EngineCore, v: Extract<IncidentVerdict, { ok: false }>, T: OidOrAbsent): Promise<void> {
  const view = core.view;
  if (view === null) throw new Error('enterIncident: no state');
  const laB = view.laB;
  const ref = core.refs.displaced(laB);
  let mem = memory.get(core);
  if (!isIncident(view.meta) || view.meta.incident === null) {
    const n = view.meta.incident_next;
    if (T !== ABSENT) await keepLocalRef(core, core.refs.incident(n), T, 'cowork: incident');
    await commitMeta(core, {
      freeze_reasons: [...view.meta.freeze_reasons.filter((r) => r !== 'INCIDENT'), 'INCIDENT'],
      incident: { n, observed_board: v.observedBoard, observed_code: v.observedCode },
      incident_next: n + 1,
      displaced: [],
    });
    // One listing (a network call, no push): the event names where the copy goes, or says it stays local.
    // Note: this network call lies between the state commit that set INCIDENT and the INCIDENT event below. A crash or a
    // hang in it leaves INCIDENT persisted with no event logged; the re-entrant call after a restart sees meta.incident
    // set and logs none either (status.json still shows INCIDENT from the state, R-27). Kept on purpose: the event names
    // the copy's ref or kept_local, which only the listing knows.
    const listing = await listDisplaced(core, false);
    mem = { n, why: v.why, displaced: listing !== null && keptLocal(listing, ref, laB) ? 'kept_local' : 'pending', ref, laB };
    memory.set(core, mem);
    core.deps.trace.emit({ kind: 'incident', peer: core.peerId, n, why: v.why, observedBoard: v.observedBoard });
    core.deps.log.write('warn', 'INCIDENT', {
      n, why: v.why, old_board: view.laB, old_code: view.laC, new_board: v.observedBoard, new_code: v.observedCode,
      displaced: mem.displaced === 'kept_local' ? 'kept_local' : ref,
    });
    if (mem.displaced === 'kept_local') core.deps.log.write('warn', 'INCIDENT_DISPLACED', { n, ref, state: 'kept_local', displaced_refs: listing?.all.size ?? null });
  } else if (mem === undefined || mem.n !== view.meta.incident.n) {
    mem = { n: view.meta.incident.n, why: v.why, displaced: view.meta.displaced.includes(oid12(laB)) ? 'pushed' : 'pending', ref, laB };
    memory.set(core, mem);
  }
  if (mem.displaced === 'pending') await displacedCopy(core, mem);
}

/**
 * ENG-21's copy of LA_B, in an ordinary window (R-21); the cap is checked against the remote's listing. The value and the
 * name are the cached pair (mem.laB under mem.ref, as the INCIDENT event named it), never the current LA_B: a kept push
 * intent that recover resolves as landed moves LA_B during INCIDENT, and the copy must still hold the value its name says.
 */
async function displacedCopy(core: EngineCore, mem: IncidentMemory): Promise<void> {
  const view = core.view!;
  const { laB, ref } = mem;
  const fold = foldPatch(core)?.fold ?? view.fold;
  const rank = fold === null ? 1 : governorRank(fold, core.peerId);
  // The window first: while it is closed the copy costs no network call.
  if (!core.governor.mayAttempt(rank, true, true)) return;
  const listing = await listDisplaced(core, false);
  if (listing === null) return;   // the remote did not answer: a later iteration tries again
  if (keptLocal(listing, ref, laB)) {
    mem.displaced = 'kept_local';
    core.deps.log.write('warn', 'INCIDENT_DISPLACED', { n: mem.n, ref, state: 'kept_local', displaced_refs: listing.all.size });
    return;
  }
  const r = await governedPush(core, 'displaced', { specs: [pushSpec(laB, ref, ABSENT)] }, false, rank, (raw) => classifyCopy(core, raw, ref, laB));
  if (r === 'denied') return;
  if (!r.cls.landed) {
    core.deps.log.write('warn', 'INCIDENT_DISPLACED', { n: mem.n, ref, state: 'retry', outcome: r.cls.outcome });
    return;
  }
  const key = oid12(laB);
  await commitMeta(core, { displaced: [...core.view!.meta.displaced.filter((d) => d !== key), key].slice(-DISPLACED_CAP) });
  mem.displaced = 'pushed';
  core.deps.log.write('info', 'INCIDENT_DISPLACED', { n: mem.n, ref, state: 'pushed' });
}

// ---- clearing (glossary §8 "Lifted by"; PRO-25) ---------------------------------------------------------------------

/** After INCIDENT was cleared (by the caller's one state update): memory, UNFROZEN, the local displaced copies deleted. */
async function afterClear(core: EngineCore, n: number | null, by: 'healed' | 'recover' | 'reanchor'): Promise<void> {
  memory.delete(core);
  core.deps.log.write('info', 'UNFROZEN', { reason: 'INCIDENT', n, by });
  await dropLocalDisplaced(core);
}

/** The meta fields one state update sets to clear INCIDENT (meta.incident, meta.displaced reset). */
function clearedMeta(meta: Meta): Partial<Meta> {
  return { freeze_reasons: meta.freeze_reasons.filter((r) => r !== 'INCIDENT'), incident: null, displaced: [] };
}

/** One state update: INCIDENT cleared, the fold of this run carried; UNFROZEN. */
async function clearIncident(core: EngineCore, by: 'healed' | 'recover'): Promise<void> {
  const meta = core.view!.meta;
  await commitMeta(core, clearedMeta(meta));
  await afterClear(core, meta.incident?.n ?? null, by);
}

/**
 * Called with an iteration prepareIteration returned: when INCIDENT is set and THIS iteration's fetch succeeded (a failed
 * or deferred fetch checked only the last checked board, which says nothing about the remote), its check passed, so one
 * state update clears it, carrying the iteration's fold (PRO-25: Folder.foldTo rebuilt it from the checkpoint when the
 * persisted fold was off the restored chain), and the iteration's freeze and push states follow, so its apply and publish
 * run as in any ok iteration; UNFROZEN. false when nothing was cleared.
 */
export async function clearIncidentIfHealed(core: EngineCore, it: IterationCtx): Promise<boolean> {
  if (it.fetched === null || !it.fetched.ok || it.fetched.deferred) return false;
  const view = core.view;
  if (view === null || (!isIncident(view.meta) && view.meta.incident === null)) return false;
  await clearIncident(core, 'healed');
  it.freeze = [...core.view!.meta.freeze_reasons];
  it.pushStates = pushStatesOf(core, it.version);
  return true;
}

// ---- recover (ENG-22) -------------------------------------------------------------------------------------------------

type PushIntent = Extract<Intent, { kind: 'push' }>;

/** The preview with its id: 6 hex of sha256 over the mode, LA_B, V, X, A (tree), the candidates and the restart paths. */
function previewOf(mode: RecoverPreview['mode'], laB: Oid, V: OidOrAbsent, X: Oid | null, aTree: Oid, candidates: Oid[], restartPaths: string[], intent: PushIntent | null): RecoverPreview {
  const shown = JSON.stringify({ mode, laB, V, X, A: aTree, candidates, restartPaths });
  const id = createHash('sha256').update(shown, 'utf8').digest('hex').slice(0, 6);
  return { mode, V, X, candidates, restartPaths, id, pushIntent: intent === null ? null : { bnew: intent.bnew, lease_board: intent.lease_board } };
}

function previewJson(p: RecoverPreview): Json {
  return {
    mode: p.mode, V: p.V, X: p.X, candidates: [...p.candidates], restartPaths: [...p.restartPaths], id: p.id,
    pushIntent: p.pushIntent === null ? null : { bnew: p.pushIntent.bnew, lease_board: p.pushIntent.lease_board },
  };
}

/**
 * Step 2a: D when the team already recovered and continued on V — (i) V is a commit on the first-parent chain of no
 * candidate other than V itself (a displaced value equal to V is left out of this test only: Task 16 round-2 ruling),
 * (ii) D = the first commit of LA_B's first-parent chain that is on V's (never merge-base) is a displaced candidate and
 * not V, (iii) the full CHECK passes from D to V (FP_OK of both, the board and live shapes). Else null. A walk or a check
 * whose git fails throws WalkError: no proof either way, so recover refuses instead of falling through to a force push.
 * Remote content on D..V that its source typed (isRemoteContentError: a board commit readBoardCommit refuses, a live
 * code chain that is none, e.g. live_code(D) of a parentless D) is a CHECK that does not pass (null), as prepareIteration
 * reads it; a plain Error is a local failure and is thrown as it is (Task 15 ruling: no prototype heuristic).
 */
async function teamRecoveredAt(core: EngineCore, V: OidOrAbsent, vCommit: boolean, laB: Oid, candidates: readonly Oid[], displaced: ReadonlySet<Oid>): Promise<Oid | null> {
  if (V === ABSENT || !vCommit) return null;
  for (const c of candidates) if (c !== V && (await onChain(core, V, c))) return null;
  const onV = new Set(await chainOf(core, V));
  const D = (await chainOf(core, laB)).find((o) => onV.has(o));
  if (D === undefined || D === V || !displaced.has(D)) return null;
  let verdict: IncidentVerdict;
  try {
    verdict = await incidentCheck(core.repo, D, (await liveCodeOf(core, D)).tip, V, core.deps.testMutants);
  } catch (e) {
    if (isRemoteContentError(e)) return null;
    if (e instanceof GitCommandError || e instanceof OidError) throw new WalkError(`${D}..${V}`, e);
    throw e;
  }
  return verdict.ok ? D : null;
}

/**
 * Step 3's X check (Task 16 round-2 ruling, spec-edits.md): restore never force-pushes an X whose own chain fails the
 * incident CHECK or that is not board-shaped. X holds LA_B on its first-parent chain (step 3), so this is the CHECK the
 * loop runs, incidentCheck(LA_B, LA_C, X): FP_OK of the board and the code, the board shape and the live step of every
 * commit of LA_B..X (X == LA_B passes as it is). null when it passes, else the verdict's why; remote content its source
 * typed is a failing check ('board_shape'); a git failure throws WalkError.
 */
async function xCheckFails(core: EngineCore, X: Oid): Promise<IncidentWhy | null> {
  const view = core.view!;
  try {
    const verdict = await incidentCheck(core.repo, view.laB, view.laC, X, core.deps.testMutants);
    return verdict.ok ? null : verdict.why;
  } catch (e) {
    if (isRemoteContentError(e)) return 'board_shape';
    if (e instanceof GitCommandError || e instanceof OidError) throw new WalkError(`${view.laB}..${X}`, e);
    throw e;
  }
}

/** Step 3: the candidate whose first-parent chain holds every other one, else null. */
async function containingAll(core: EngineCore, candidates: readonly Oid[]): Promise<Oid | null> {
  for (const c of candidates) {
    let all = true;
    for (const o of candidates) {
      if (o !== c && !(await onChain(core, o, c))) {
        all = false;
        break;
      }
    }
    if (all) return c;
  }
  return null;
}

/**
 * The re-anchor preview's paths: the LIVE paths whose own bytes are not V's — what this peer's own chain changed since
 * the fork D (tree(live_code(D)) → tree(live_code(LA_B))) and what a detection tick (no object written) finds changed on
 * disk, where V's entry differs. The rebuild decides each path against every version on V's chain, so a path listed here
 * whose bytes match an older version of V's chain gets no record (an over-approximation, never an omission of a chain path).
 */
async function reanchorPaths(core: EngineCore, V: Oid, D: Oid): Promise<string[]> {
  const repo = core.repo;
  const view = core.view!;
  const [v, d, b] = [await liveCodeOf(core, V), await liveCodeOf(core, D), await liveCodeOf(core, view.laB)];
  const VT = await repo.readTreeMap(v.tree);
  const DT = await repo.readTreeMap(d.tree);
  const BT = await repo.readTreeMap(b.tree);
  const out = new Set<string>();
  for (const p of diffPaths(DT, BT)) if (!sameTreeEntry(BT.get(p), VT.get(p))) out.add(p);
  const { aTree, A } = await currentA(core);
  const { tick } = await tickOutside(core, A, aTree, view.meta.EPOCH_BASE);
  if (!tick.failed) {
    for (const [p, e] of tick.dirty) {
      const t = VT.get(p);
      if (e.kind === 'remove' ? t !== undefined : t?.oid !== e.id) out.add(p);
    }
  }
  const paths = [...out].filter((p) => validPathSyntax(p)).sort();
  if (paths.length === 0) return paths;
  // The rebuild's EPOCH_BASE is live_base(TIP of V); paths are scoped through ensureAttrs (scopeInputsFor), which asks
  // the attributes of exactly these paths, so scopeOfEntry answers for each.
  const inp = await scopeInputsFor(core, (await liveBase(repo, v.tip)).base, paths);
  return paths.filter((p) => scopeOfEntry(core, inp, p, (BT.get(p) ?? VT.get(p) ?? A.get(p))?.mode ?? '100644').cls === 'LIVE');
}

interface Plan { preview: RecoverPreview; mirror: OidOrAbsent; vCopy: string | null; }

/** recover's own copy of V: the next displaced/<peer>/v-<k> of this peer (k above every one listed). */
function nextVCopy(core: EngineCore, all: ReadonlyMap<string, Oid>): string {
  const own = `${core.refs.displacedPrefix}${core.peerId}/v-`;
  let k = 0;
  for (const ref of all.keys()) {
    const m = ref.startsWith(own) ? VCOPY_TAIL.exec(ref.slice(core.refs.displacedPrefix.length)) : null;
    if (m !== null) k = Math.max(k, Number(m[2]));
  }
  return `${own}${k + 1}`;
}

/** Steps 2–4 against the fetched V: the preview, or a refusal. No state change, no push (WalkError: a walk failed). */
async function planRecover(core: EngineCore, fetched: FetchView, intent: PushIntent | null): Promise<Plan | RecoverResult> {
  const repo = core.repo;
  const V = fetched.board;
  const listing = await listDisplaced(core, true);
  if (listing === null) return offline('fetch');
  const values = await fetchDisplaced(core, listing.accepted);
  if (values === null) return offline('fetch');
  const prefix = core.refs.displacedPrefix;
  const view = core.view!;
  // Step 3's candidates: every displaced commit but recover's own copies of an observed V (displaced/<peer>/v-<n>). A
  // displaced value equal to V (a teammate's detection copy of the chain it restored) stays a candidate: leaving it out
  // would let a stale chain forked from it be force-pushed over that completed recover (Task 16 round-2 ruling; 2a(i)
  // alone leaves it out).
  const displacedRefs = new Map<string, Oid>();
  for (const [ref, v] of values) {
    if (VCOPY_TAIL.test(ref.slice(prefix.length))) continue;
    if (!(await repo.hasObject(v, 'commit'))) {
      core.deps.log.write('warn', 'DISPLACED_REF_SKIPPED', { reason: 'not_commit', ref });
      continue;
    }
    displacedRefs.set(ref, v);
  }
  const displaced = new Set(displacedRefs.values());
  const candidates = [...new Set([view.laB, ...displaced])].sort();
  const vCommit = V !== ABSENT && (await repo.hasObject(V, 'commit'));
  const { aTree } = await currentA(core);

  const D = await teamRecoveredAt(core, V, vCommit, view.laB, candidates, displaced);
  if (D !== null) {
    // The re-anchor pins nothing new from HEAD but rebuilds per path like the lost-state rebuild: same HEAD rule.
    const h = await headCheck(core);
    if (!h.ok) return refuse('RECOVER_HEAD_STATE', { op: h.op });
    return { preview: previewOf('reanchor', view.laB, V, null, aTree, candidates, await reanchorPaths(core, V as Oid, D), intent), mirror: fetched.code, vCopy: null };
  }

  const X = await containingAll(core, candidates);
  const displacedNames = [...displacedRefs.keys()].sort();
  if (X === null) return refuse('RECOVER_AMBIGUOUS', { candidates, displaced: displacedNames });
  // The X check runs here, in the plan: before V's copy, any crashpoint and the recover push (a preview refuses too).
  const why = await xCheckFails(core, X);
  if (why !== null) {
    const ref = displacedNames.find((r) => displacedRefs.get(r) === X) ?? null;
    return refuse('RECOVER_AMBIGUOUS', { reason: 'x_check', ref, why, X, candidates, displaced: displacedNames });
  }
  let vCopy: string | null = null;
  if (V !== ABSENT && !(vCommit && (await onChain(core, V, X)))) {
    // V needs a displaced ref: none if one already holds it (a re-run after a kill or a failed recover push), else a
    // free slot for recover's own next copy.
    if (![...listing.all.values()].includes(V)) {
      if (listing.all.size >= DISPLACED_CAP) return refuse('RECOVER_DISPLACED_FULL', { displaced: [...listing.accepted.keys()], count: listing.all.size, cap: DISPLACED_CAP });
      vCopy = nextVCopy(core, listing.all);
    }
  }
  return { preview: previewOf('restore', view.laB, V, X, aTree, candidates, [], intent), mirror: fetched.code, vCopy };
}

/** Steps 4–6: V copied to recover's own displaced ref when it needs one, crashpoint('recover.displaced'), X and live_code(X) pushed, INCIDENT cleared. */
async function restore(core: EngineCore, p: Plan): Promise<RecoverResult> {
  const { preview, mirror, vCopy } = p;
  const V = preview.V;
  const X = preview.X!;
  if (vCopy !== null && V !== ABSENT) {
    const r = await exemptPush(core, 'displaced', { specs: [pushSpec(V, vCopy, ABSENT)] }, (raw) => classifyCopy(core, raw, vCopy, V));
    if (r === null || !r.cls.landed) return pushFailure('displaced', r?.cls.outcome ?? 'denied');
  }
  crashpoint('recover.displaced');
  const board = core.refs.remoteBoard;
  const live = (await liveCodeOf(core, X)).tip;
  const specs = [pushSpec(X, board, V), pushSpec(live, core.refs.remoteCode, mirror)];
  const r = await exemptPush(core, 'recover', { specs }, async (raw) => {
    const status = raw.statuses.get(board) ?? 'none';
    if (status === 'ok') return { outcome: 'landed', transient: false, landed: true };
    // The board is read by outcome after a fresh fetch (the governor observes it); a mirror line is never read (ENG-44).
    const view = await core.fetcher.fetchNow();
    await observeFetch(core, view, false);
    if (!view.ok) return { outcome: 'network', transient: false, landed: false };
    if (view.board === X) return { outcome: 'landed', transient: false, landed: true };
    if (view.board !== V) return { outcome: 'lease_lost', transient: false, landed: false };
    return status === 'rejected' ? { outcome: 'transient', transient: true, landed: false } : { outcome: 'network', transient: false, landed: false };
  });
  if (r === null || !r.cls.landed) return pushFailure('recover', r?.cls.outcome ?? 'denied');
  observeOwnLanding(core, X, V);
  await clearIncident(core, 'recover');
  return { ok: true, preview, done: true };
}

/**
 * Step 2a's re-anchor: incident-<n>-own, crashpoint('recover.reanchor'), then ONE state update — the lost-state rebuild
 * against V with INCIDENT cleared and the unlanded outbox ops rebuilt as drafts with no seq (their seqs were the old
 * epoch's; the next publish allocates them under the new one, PRO-25) — so a crash leaves the whole re-anchor or none.
 */
async function reanchor(core: EngineCore, p: Plan): Promise<RecoverResult> {
  const view = core.view!;
  const n = view.meta.incident?.n ?? view.meta.incident_next;
  // Before any state change: the pre-incident chain stays reachable even when the ENG-21 copy stayed local.
  await keepLocalRef(core, core.refs.incidentOwn(n), view.laB, 'cowork: incident own');
  crashpoint('recover.reanchor');
  // Final review FC-7: the new epoch's join op leads the rebuilt drafts (a fold rejects a non-join op of an unrecorded
  // epoch, also one placed ahead of the join in the same commit); a join draft already pending is not repeated.
  const outbox = new Outbox([
    { draft: (await joinDraft(core)) as OpDraft, op: null },
    ...core.outbox.drafts().filter((d) => d.type !== 'join').map((draft) => ({ draft, op: null })),
  ]);
  const report = await lostStateRebuild(core, p.preview.V as Oid, 're_anchor', undefined, { ...clearedMeta(view.meta), outbox: outbox.toJson() });
  await afterClear(core, n, 'reanchor');
  core.deps.log.write('warn', 'RECOVER_REANCHOR', { n, own: view.laB, board: p.preview.V, records: report.records.length });
  return { ok: true, preview: p.preview, done: true };
}

/**
 * An IterationCtx for resolving a kept push intent during INCIDENT (P2-PUSHINTENT-FIRST), when no iteration exists: the
 * fetch just made (T = its board tip V), and everything else at the last verified board LA_B — its fold (foldTo from the
 * run's or the persisted fold), live code and TIP tree, the current A, the scope at EPOCH_BASE, the freeze and push states.
 */
async function incidentIteration(core: EngineCore, fetched: FetchView): Promise<IterationCtx> {
  const view = core.view!;
  const fp = foldPatch(core);
  const from = fp !== null && fp.meta.fold_board !== null ? { board: fp.meta.fold_board, state: fp.fold }
    : view.fold !== null && view.meta.fold_board !== null ? { board: view.meta.fold_board, state: view.fold } : null;
  const folded = await core.folder.foldTo(view.laB, from, core.deps.regionSpec);
  const { tip, tree } = await liveCodeOf(core, view.laB);
  const tipMap = await core.repo.readTreeMap(tree);
  const { A } = await currentA(core);
  const epochBase = view.meta.EPOCH_BASE;
  const scopeInputs = await scopeInputsFor(core, epochBase, [...A.keys(), ...tipMap.keys()]);
  return {
    n: 0, start: anchorNow(core.deps.ports.clock), fetched, T: fetched.board, tip, tipMap, A,
    fold: folded.state, version: folded.version, epochBase, scopeInputs,
    scope: (path) => scopeOfEntry(core, scopeInputs, path, (A.get(path) ?? tipMap.get(path))?.mode ?? '100644'),
    tick: null, mat: null,
    freeze: [...view.meta.freeze_reasons], pushStates: pushStatesOf(core, folded.version),
    leaseIdleMs: core.deps.lease.idleMs(),
  };
}

/**
 * The human-typed /cowork recover (01-engine §3.7 Recover): `confirm` null previews (nothing changes; a kept push intent
 * is reported); a confirm resolves a kept push intent first, then re-plans, and runs only when the plan's id is the
 * confirm (else RECOVER_PREVIEW_STALE with the fresh preview). Crashpoints recover.displaced and recover.reanchor.
 */
export async function recover(core: EngineCore, confirm: string | null): Promise<RecoverResult> {
  const view0 = core.view;
  if (view0 === null || !isIncident(view0.meta)) return refuse('RECOVER_NOT_IN_INCIDENT');
  // 1 a fetch that succeeds now (no spacing, no backoff); V is its board tip (ABSENT when the board is gone).
  const fetched = await core.fetcher.fetchNow();
  await observeFetch(core, fetched, false);
  if (!fetched.ok) return offline('fetch');
  try {
    let intent: PushIntent | null = view0.intent.kind === 'push' ? view0.intent : null;
    if (confirm !== null && intent !== null) {
      // P2-PUSHINTENT-FIRST: resolved by observation against V before recover changes anything.
      await resolvePushIntent(core, await incidentIteration(core, fetched));
      if (core.view!.intent.kind === 'push') return offline('push_intent_unresolved');
      intent = null;
    }
    const p = await planRecover(core, fetched, intent);
    if (!('vCopy' in p)) return p;
    if (confirm === null) return { ok: true, preview: p.preview, done: false };
    if (confirm !== p.preview.id) return refuse('RECOVER_PREVIEW_STALE', { preview: previewJson(p.preview) });
    return await (p.preview.mode === 'reanchor' ? reanchor(core, p) : restore(core, p));
  } catch (e) {
    if (e instanceof WalkError) return offline('walk');
    // A backstop for every other recover read of remote content (the fold of LA_B, the re-anchor's live code and base
    // of V): each such chain already passed a CHECK (the loop's, 2a's or the X check), so this is not expected; a
    // malformed one is still a refusal, never a throw, and nothing past it has been pushed.
    if (isRemoteContentError(e)) return refuse('RECOVER_AMBIGUOUS', { reason: 'remote_content', error: e.name });
    throw e;
  }
}
