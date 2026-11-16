// The engine entry point of `/cowork resolve` (05-holds §L HLD-57…HLD-59, HLD-64's copy-restore, Table 4, the §1 refusal table;
// 03-data DAT-29, DAT-33, DAT-39, DAT-45; glossary §15 `/cowork resolve`, §24 defaults 4–5, §25.2 items 2–3; rulings R3-02, R3-06,
// R3-09, R3-10, R3-23, R3-28, R3-54, R3-60, R3-65; Plan 3 Task 11, contract additions 1–4).
//
// resolve(core, it, id, verb, o) applies HLD-57 in order:
//   (a) owner     the record is in this peer's registry; else, for `--restore` of a record the fold names whose owner has a folded
//                 `leave` op, HLD-64's copy-restore (a NEW local record copying the board's held/<id>/ blobs, then RESTOREd; the
//                 foreign record is never transitioned); else HOLD_NOT_OWNER
//   (b) the fold  of the fresh fetch first: a record terminal there (or here), or whose folded offer is `accepted`, is a no-op
//                 HOLD_ALREADY_RESOLVED (nothing written: registry, disk and outbox unchanged)
//   then the verb's applicability and refusals (Table 4, §1), the writes through the hold operators and writeLocal(Group) with
//   humanEvidence = o.humanEvidence (an ON_DISK `--discard` is an operator write with origin discard:<id>, its inflight entry,
//   ObservedWrites.record, Snapshotter.setEntry and R3-60's snap transition), then the registry transition, whose mirror draft
//   mirrorSync makes at once (c: prev_rev = the rev of r's newest allocated pending op, else the folded rev; an unallocated
//   draft of r is replaced). A `--restore` output stays an observed change of the human CS (e: restore() records the write in
//   ObservedWrites and sets no private-index entry, so the next tick sees it and the revert detector skips it).
// A seat actor (Claude, `cowork_resolve(id, "restore")`, Plan 5) may only restore: HLD-59's admissibility is
// claudeRestoreRefusal, answered as {kind: 'claude_refused', reason} (a reason, never a message code, R3-54), and under any
// FREEZE reason the restore is refused HOLD_FROZEN (HLD-57's frozen rule). Every other verb from a seat is a TypeError (no MCP
// tool reaches it, SEC-27).
// The loop's gates (Task 11 fix round 1 ruling): a verb answers first whatever writes nothing (HLD-57 (a)/(b), R3-09, the Table 4
// refusals decided on the record alone, `--park` of an OFF_DISK record, `--restore` of an ON_DISK one); a verb about to write
// anything (registry, outbox or disk) then meets writeGate — an iteration under FREEZE(EPOCH) (a human git operation: R-09,
// glossary §8, 01-engine §3.5 step 0c) refuses HOLD_FROZEN, one that only fetched and folded without it (.git/index.lock at its
// start, ENG-15, step 0b) returns {kind: 'locked', paths: ['.git/index.lock']}. Any other FREEZE reason (MASS, PAUSED, INCIDENT,
// CONFIG, NOHOOKS) keeps HLD-57's allowance of a human-typed resolve. Engine.resolve observes both before it prepares (and refuses
// FETCH_OWED when its forced fetch fails: HLD-57 (b) is never answered from a stale fold).
//
// Done codes (ResolveResult.code) are the CLI's result words, printed by `daemon.js resolve` and never written to status.json or
// the log by this module (the operators raise their own codes: HOLD_PARKED, HOLD_RESTORED, RESTORE_MARKERS): RESOLVED_PUBLISH
// (released; the record ends so once its content is in A), RESOLVED_DISCARD (ended), HOLD_PARKED, HOLD_RESTORED, RESTORE_MARKERS,
// HOLD_SUBSUMED (the collision take: the collision record ends SUBSUMED at the next apply, R3-33), HOLD_ANSWERED (a `--discard`
// that records the human's answer — `generated?:exclude`, `collision:keep` — and leaves the record non-terminal), HOLD_OFFERED
// (`--handoff`: offer → offered) and HOLD_ALREADY_RESOLVED. R3-28's daemon log line of a `--discard` that ends a record is
// HOLD_DISCARDED (a registered log-only code, HOLD_LOG_CODES), written with the `discard` trace by holdOps.ts's discardEnded.
import type { Json } from '../board/canonicalJson.js';
import { readHeld, type HeldBlob } from '../board/boardCommit.js';
import type { FoldedHold, FoldState } from '../board/fold.js';
import { hasRestoreMarkerRow } from '../data/rows.js';
import { isSecretLike } from '../data/scope.js';
import { ABSENT, type Oid } from '../git/oid.js';
import { isRegularEntry, type TreeMap } from '../git/repo.js';
import type { ResolveRefusal } from '../holds/codes.js';
import { blobMapOf } from '../holds/evaluate.js';
import { offerNext } from '../holds/offers.js';
import {
  GUARD_TABLE, TERMINAL_STATES, blobAt, guardName, guardRow, heldSide, isTerminal, isUnknownGuard, makeGuard, setBlob,
  type BlobMap, type Guard, type HoldBlobs, type HoldRecord,
} from '../holds/record.js';
import type { HoldPatch, InflightOp } from '../holds/registry.js';
import { ensureAttrs, materializedFor, NOT_APPLICABLE_REASONS, type EngineCore, type IterationCtx } from './core.js';
import {
  carries, collisionTake, discardEnded, discardFromPairs, frozen, keptK4, keptK4OffDisk, maskAloneTarget, modeOf, park, parkWritten, postponedBy,
  recordWrites, refreshed, restore, wholeRestorePaths, withdrawWritten, writeEntries, type Entry, type ParkOutcome, type RestoreOutcome,
} from './holdOps.js';
import { mirrorSync, releaseDependencyGuards } from './publish.js';
import type { WriteLocalResult } from './writer.js';

export type ResolveVerb = 'publish' | 'discard' | 'park' | 'restore' | 'handoff';
export interface ResolveOptions { humanEvidence: boolean; actor: 'human' | { seat: string; agent: string | null }; }
/** R3-54: reasons, never message codes; Plan 5 maps them to 06-claude §3.16.3's MCP codes (X-14). */
export type ClaudeRestoreReason = 'not_owner' | 'binary' | 'quarantine' | 'state';
/**
 * Engine.resolve's refusal when its forced fetch did not succeed (a network failure, a backoff, or a local ref-update failure: params
 * {hid, local}, P2-FETCHLOCAL): the loop's own code for a failed forced fetch (loop.ts FETCH_OWED). Not a 05 §1 refusal, so outside
 * ResolveRefusal (Task 1's list); its next command is FETCH_OWED_NEXT (texts are Plan 7's). Task 11 fix round 1 ruling.
 */
export type ResolveFetchRefusal = 'FETCH_OWED';
export const FETCH_OWED_NEXT = 'reconnect (git fetch), then repeat the command';
/** The `locked` path of the 0b gate: git's own lock on the index, held while a git command runs (ENG-15). */
export const INDEX_LOCK_PATH = '.git/index.lock';
export type ResolveResult =
  | { kind: 'done'; code: string; id: string; created: string | null }   // code e.g. HOLD_PARKED, HOLD_RESTORED, RESTORE_MARKERS, HOLD_ALREADY_RESOLVED; created = a copy-restore or collision-capture record
  | { kind: 'refused'; code: ResolveRefusal | ResolveFetchRefusal; params: Record<string, Json> }
  | { kind: 'claude_refused'; reason: ClaudeRestoreReason }              // a seat actor's restore that HLD-59 does not admit (R3-54); nothing changed, nothing written to status or log as a code
  | { kind: 'locked'; paths: string[]; reason?: 'txn' };                  // the writer met a holder without delete sharing, or ['.git/index.lock'] (the 0b gate), or an open TXN (reason 'txn', F2 #108): nothing changed

const VERBS: ReadonlySet<string> = new Set<ResolveVerb>(['publish', 'discard', 'park', 'restore', 'handoff']);
/** The guards a RESTORE releases (HLD-17: the displacement; PARKED is the other one, a state). */
const DISPLACEMENT: ReadonlySet<string> = new Set(['conflict', 'claim-breach', 'base-move']);
/**
 * Table 4 `--publish`: every DECISION guard Table 3 lists for a human release, except `filter-failure` and `secret-scan` (their
 * D1/D2/D3 classification and per-path filter re-run are Plan 7's: refused HOLD_GUARDS_REMAIN, fail closed, contract addition 3) and
 * `collision` (the take, DAT-29) — revert, conflict, claim-breach, join, restart, phantom, generated? and wake-scope.
 */
const PUBLISH_RELEASES: ReadonlySet<string> = new Set(
  GUARD_TABLE.filter((g) => g.humanRelease && g.name !== 'filter-failure' && g.name !== 'secret-scan' && g.name !== 'collision').map((g) => g.name),
);
/** `--handoff` (Table 4 "Refused when"): records carrying these are never offered. */
const NOT_OFFERABLE_GUARDS: ReadonlySet<string> = new Set(['revert', 'conflict', 'claim-breach', 'base-move', 'wake-scope']);
/** HLD-59: the guards a Claude restore admits on an OFF_DISK PARKED/CONFLICTED record (or none). */
const CLAUDE_RESTORE_GUARDS: ReadonlySet<string> = new Set(['conflict', 'claim-breach']);

const foldedOf = (fold: FoldState, id: string): FoldedHold | undefined => (Object.hasOwn(fold.holds, id) ? fold.holds[id] : undefined);
const oidAt = (m: TreeMap, p: string): Entry['target'] => m.get(p)?.oid ?? ABSENT;

const done = (code: string, id: string, created: string | null = null): ResolveResult => ({ kind: 'done', code, id, created });
const refused = (code: ResolveRefusal, params: Record<string, Json>): ResolveResult => ({ kind: 'refused', code, params });
const locked = (paths: readonly string[]): ResolveResult => ({ kind: 'locked', paths: [...paths] });

/** A SHADOW (K1, HLD-47): a PATCH held under a `claim` guard (shadowRecord). */
const isShadow = (r: HoldRecord): boolean => r.kind === 'PATCH' && carries(r, 'claim');

/**
 * COO-10's "allows a `ckind: dependency` request" (Table 4 `--handoff` of a K7 PIN): Plan 3 answers false (R3-06; Plan 6 amends the
 * handoff branch), so a K7 PIN — guard `t0`, or `dependency:<shadow id>` (HLD-48) — is never offered.
 */
function cooAllowsDependencyRequest(_r: HoldRecord): boolean {
  return false;
}

/**
 * HLD-59 admissibility of `cowork_resolve(id, "restore")` for a seat; null = allowed (Plan 5 binds the tool and maps the reason,
 * R3-54, X-14). In order: 'not_owner' unless the record's origin is the calling seat (`<seat>` or `<seat>/<agent>`, any agent of
 * it); 'quarantine' for a record carrying `quarantine-review` (Plan 7's review, SEC-33); 'state' unless the record is OFF_DISK
 * PARKED or CONFLICTED with no guard but `conflict` or `claim-breach` (none included), or a returned SHADOW (a terminal, ON_DISK or
 * INCOMING record included); 'binary' when any path is binary (a binary restore is human-only, DAT-45; `binary` answers R3-18's
 * whole-path rule: binary or filtered).
 */
export function claudeRestoreRefusal(r: HoldRecord, seat: string, binary: (path: string) => boolean): ClaudeRestoreReason | null {
  if (r.origin !== seat && !r.origin.startsWith(`${seat}/`)) return 'not_owner';
  if (carries(r, 'quarantine-review')) return 'quarantine';
  const offDisk = !isTerminal(r) && r.residence === 'OFF_DISK' && (r.state === 'PARKED' || r.state === 'CONFLICTED');
  const guardsOk = r.guards.every((g) => CLAUDE_RESTORE_GUARDS.has(guardName(g)));
  const returnedShadow = isShadow(r) && r.offer === 'returned';
  if (!offDisk || (!guardsOk && !returnedShadow)) return 'state';
  if (r.paths.some((p) => binary(p))) return 'binary';
  return null;
}

/**
 * Table 4 with HLD-57 (a)–(e) in order (see the file comment); the combinations Table 4 and 05 §1 leave open (contract addition 2):
 * `--restore` of an ON_DISK record → done HOLD_RESTORED, no write (except a kept K4, G2 #29: restoreVerb); `--park` of an OFF_DISK
 * record → done HOLD_PARKED, no write; an id
 * neither the registry nor the fold names → HOLD_NOT_OWNER; `--discard` of an ON_DISK CONFLICTED record writes A[p] (MASK step 4, as
 * PARK). A record carrying a guard outside Table 3 is refused HOLD_GUARDS_REMAIN {guards: <those names>} for every human verb (R3-09).
 * The caller prepares `it` with PrepareOptions.holdPaths = the record's paths (the fold's for a copy-restore): PARK, RESTORE, the
 * collision take and an ON_DISK `--discard` read the materialized S_disk (a TypeError otherwise, a caller bug).
 */
export async function resolve(core: EngineCore, it: IterationCtx, id: string, verb: ResolveVerb, o: ResolveOptions): Promise<ResolveResult> {
  if (!VERBS.has(verb)) throw new TypeError(`resolve: ${JSON.stringify(verb)} is not a resolve verb`);
  const seat = o.actor === 'human' ? null : o.actor.seat;
  if (seat !== null && verb !== 'restore') throw new TypeError(`resolve: a seat may only restore (SEC-27), not ${verb}`);
  const r = core.holds.get(id);
  const folded = foldedOf(it.fold, id);

  // (a) the owner: this peer's registry, or HLD-64's copy-restore of a record whose owner left.
  if (r === undefined) {
    if (seat !== null) return { kind: 'claude_refused', reason: 'not_owner' };
    if (verb === 'restore' && folded !== undefined && folded.owner !== core.peerId && it.fold.peers[folded.owner]?.status === 'left') {
      return copyRestore(core, it, id, folded, o);
    }
    return refused('HOLD_NOT_OWNER', { hid: id });
  }
  if (r.owner !== core.peerId) return refused('HOLD_NOT_OWNER', { hid: id });

  // (b) the fold first (and this registry): terminal, or an accepted offer, is a no-op.
  if (isTerminal(r) || (folded !== undefined && (TERMINAL_STATES.has(folded.state) || folded.offer === 'accepted'))) return done('HOLD_ALREADY_RESOLVED', id);

  if (seat !== null) {
    const whole = await wholeRestorePaths(core, it, r, materializedFor(it, r.paths) ? it.mat!.sRawMap : null);
    const why = claudeRestoreRefusal(r, seat, (p) => whole.has(p));
    if (why !== null) return { kind: 'claude_refused', reason: why };
    if (frozen(core, it)) return refused('HOLD_FROZEN', { hid: id });
    return restoreVerb(core, it, r, o, true);
  }

  // R3-09: a guard outside Table 3 is a DECISION this daemon never releases or transitions.
  const unknown = r.guards.filter(isUnknownGuard);
  if (unknown.length > 0) return refused('HOLD_GUARDS_REMAIN', { hid: id, guards: unknown.map((g) => g.name) });

  switch (verb) {
    case 'publish':
      return publishVerb(core, it, r, o);
    case 'discard':
      return discardVerb(core, it, r, o);
    case 'park':
      return parkVerb(core, it, r, o);
    case 'restore':
      return restoreVerb(core, it, r, o, false);
    case 'handoff':
      return handoffVerb(core, it, r);
  }
}

// ---- the writer outcomes (HLD-57 (d), R3-23) ---------------------------------------------------------------------------

/** A park outcome other than PARKED as a resolve result: a holder → locked; MISMATCH and POSTPONED → HOLD_DISK_CHANGED (R3-23). */
function parkResult(r: HoldRecord, out: Exclude<ParkOutcome, { kind: 'PARKED' }>): ResolveResult {
  switch (out.kind) {
    case 'LOCKED':
      return locked(r.paths);
    case 'FROZEN':
      return refused('HOLD_FROZEN', { hid: r.id });
    case 'NOT_PARKABLE':
      return refused('HOLD_NOT_PARKABLE', { hid: r.id });
    case 'REFRESHED':
      throw new Error(`resolve: park of ${r.id} returned REFRESHED without refreshMustBeDurable`);
    default:
      return refused('HOLD_DISK_CHANGED', { hid: r.id });   // MISMATCH, POSTPONED
  }
}

/** A restore outcome other than RESTORED as a resolve result. */
function restoreResult(id: string, paths: readonly string[], out: Exclude<RestoreOutcome, { kind: 'RESTORED' }>): ResolveResult {
  switch (out.kind) {
    case 'LOCKED':
      return locked(paths);
    case 'POSTPONED':
      return refused('HOLD_DISK_CHANGED', { hid: id });   // R3-23: a kept push intent, a stranded restore, a pending TIP write
    case 'REFUSED':
      // RESTORE_BINARY_HUMAN_ONLY is restore()'s operator-level outcome only (R3-54, R3-65): never surfaced as a code.
      if (out.code === 'RESTORE_BINARY_HUMAN_ONLY') return { kind: 'claude_refused', reason: 'binary' };
      return refused(out.code, { hid: id });
  }
}

/** A writer result other than WRITTEN of an operator write resolve makes itself (`--discard`). */
function writerResult(r: HoldRecord, res: WriteLocalResult): ResolveResult {
  switch (res.kind) {
    case 'LOCKED':
      return locked(r.paths);
    case 'FROZEN':
      return refused('HOLD_FROZEN', { hid: r.id });
    case 'DEFERRED':
      if (res.reason === 'unreadable' || res.reason === 'locked') return locked(r.paths);
      return refused('HOLD_DISK_CHANGED', { hid: r.id });
    default:
      return refused('HOLD_DISK_CHANGED', { hid: r.id });   // MISMATCH, COLLISION, PHANTOM: the disk is not what the verb read
  }
}

/** The iteration's materialization, which must cover r's paths (PrepareOptions.holdPaths); a TypeError otherwise (a caller bug). */
function matFor(it: IterationCtx, paths: readonly string[], what: string): NonNullable<IterationCtx['mat']> {
  if (!materializedFor(it, paths)) throw new TypeError(`resolve ${what}: the iteration has not materialized ${JSON.stringify(paths)} (prepareIteration with holdPaths)`);
  return it.mat!;
}

/**
 * A path this iteration's detection tick did not read (still in its quiet period, an mtime ahead of this PC's clock, unstable, a
 * shrink waiting for its second snapshot): the materialization kept its last S_disk entry, which may not be the disk now. A verb
 * that would decide on it refuses HOLD_DISK_CHANGED ("repeat the command") before anything is written — never a PARK or RESTORE whose
 * target was computed from bytes the disk no longer holds.
 */
function unsettled(it: IterationCtx, paths: readonly string[]): boolean {
  return paths.some((p) => it.tick?.excluded.has(p) === true);
}

/**
 * The loop's 0b/0c gates for a verb about to write anything (registry, outbox or disk; Task 11 fix round 1 ruling), checked after
 * every answer that writes nothing: FREEZE(EPOCH) — a human git operation, whose work tree no daemon write touches (R-09, glossary
 * §8) — refuses HOLD_FROZEN; an open TXN (06 §3.7.3; F2 #108, ruling R-T8B-6) returns locked [] with reason 'txn' — a Claude shell
 * command is running, its TXN is the truer reason and its own git operations may hold .git/index.lock as well; an iteration that only
 * fetched and folded (fetchFoldOnly: no detection tick) without EPOCH had .git/index.lock at its start (ENG-15) and returns locked
 * ['.git/index.lock']: "repeat the command" once the git command ends.
 */
function writeGate(core: EngineCore, it: IterationCtx, id: string): ResolveResult | null {
  if (it.freeze.includes('EPOCH') || core.view?.meta.freeze_reasons.includes('EPOCH') === true) return refused('HOLD_FROZEN', { hid: id });
  if (it.txnOpen) return { kind: 'locked', paths: [], reason: 'txn' };
  if (it.tick === null) return locked([INDEX_LOCK_PATH]);
  return null;
}

/** The guards as named (an argument kept). */
const names = (gs: readonly Guard[]): string[] => gs.map((g) => g.name);

/** The scope of p in this iteration, or null when it cannot be classified (a throw: R3-71, never fails open). */
function scopeOr(it: IterationCtx, p: string): ReturnType<IterationCtx['scope']> | null {
  try {
    return it.scope(p);
  } catch {
    return null;
  }
}

/** Another non-terminal ON_DISK local_only PATCH/PIN than `id` covers p (the records core.ts localOnlyScope makes p LOCAL_ONLY by). */
function otherLocalOnly(core: EngineCore, id: string, p: string): boolean {
  return core.holds.nonTerminal().some((x) => x.id !== id && x.residence === 'ON_DISK' && x.local_only && x.kind !== 'INCOMING' && x.paths.includes(p));
}

/**
 * Whether p publishes once record `id` is released: LIVE in this iteration's scope, or LOCAL_ONLY by `id`'s own effect alone (D5 row 9:
 * the iteration scoped p while `id` was local_only) when `id` is local_only no more and no other ON_DISK local_only record covers p.
 */
function liveAfter(core: EngineCore, it: IterationCtx, id: string, p: string): boolean {
  const s = scopeOr(it, p);
  if (s === null) return false;
  if (s.cls === 'LIVE') return true;
  return s.cls === 'LOCAL_ONLY' && core.holds.get(id)?.local_only === false && !otherLocalOnly(core, id, p);
}

/**
 * G2 #7 (HLD-03, R3-12; 05 §1's not-LIVE refusal shape): the paths on which record r stays local_only once --publish releases it, so its
 * content never publishes — a U10 secret-like name, a scope class other than LIVE that r itself does not cause (another ON_DISK
 * local_only record's LOCAL_ONLY, QUARANTINED, SAVE_ONLY, UNMANAGED), or a path the scope cannot classify (R3-71). Not the marker clause
 * (R3-EF4-24): --publish re-bases such a record on a disk without restore-marker rows, which ends it. [] when every path can publish.
 */
async function staysLocalOnly(core: EngineCore, it: IterationCtx, r: HoldRecord): Promise<Array<{ path: string; cls: string | null; reason: string | null }>> {
  await ensureAttrs(core, it.epochBase, r.paths);
  const out: Array<{ path: string; cls: string | null; reason: string | null }> = [];
  for (const p of r.paths) {
    const s = scopeOr(it, p);
    const own = s !== null && s.cls === 'LOCAL_ONLY' && !otherLocalOnly(core, r.id, p);
    if (isSecretLike(p)) out.push({ path: p, cls: s?.cls ?? null, reason: 'secret-like' });
    else if (s === null || (s.cls !== 'LIVE' && !own)) out.push({ path: p, cls: s?.cls ?? null, reason: s?.reason ?? null });
  }
  return out;
}

/** r's held side (h1, or s2) holds a restore-marker row at one of its paths (DAT-46; R3-EF4-24 made r local_only for it). Object reads only. */
async function heldMarkerRows(core: EngineCore, r: HoldRecord): Promise<boolean> {
  const held = heldSide(r);
  for (const p of r.paths) {
    const o = blobAt(held, p);
    if (o !== undefined && o !== ABSENT && hasRestoreMarkerRow(await core.repo.readBlob(o))) return true;
  }
  return false;
}

/**
 * G2 #5 / #7: r's blobs re-based on the disk — base := A[p] and held side := S_disk[p] on every path (a stage record keeps its s3) — the
 * pair --publish makes r's content when r's own pair cannot publish as it stands: REBASE is then H1' = S_disk at this A, MASK step 5
 * never runs for the released (guard-less) record, and R1 ends it RESOLVED_PUBLISH once that content is in A (HLD-29). PARK's whole
 * refresh (HLD-16) keeps the original base for a later RESTORE; a released record is never restored, so its base is A, as for a birth.
 */
function rebasedOnDisk(r: HoldRecord, A: TreeMap, sDisk: TreeMap): HoldBlobs {
  const base = blobMapOf(r.paths, A);
  const held = blobMapOf(r.paths, sDisk);
  if ('h1' in r.blobs) return { h0: base, h1: held };
  const s3: BlobMap = {};
  for (const [p, oid] of Object.entries(r.blobs.s3)) setBlob(s3, p, oid);
  return { s1: base, s2: held, s3 };
}

/**
 * F2 #151: a twin (HoldRegistry.holdersOf: another non-terminal record holding the change --publish re-bases r onto) that the release rev
 * may end GONE: ON_DISK (its bytes are the disk's, which r now holds), an h0/h1 pair (not a stage record), only guards --publish releases
 * (PUBLISH_RELEASES: none outside Table 3, none another verb or Plan 7 owns), no interrupted operator (local.json inflight) and no offer
 * under way. Any other twin refuses the verb (fail closed): ending it would drop a decision or bytes the human did not name.
 */
function absorbable(core: EngineCore, t: HoldRecord): boolean {
  return t.residence === 'ON_DISK' && 'h1' in t.blobs && t.guards.every((g) => PUBLISH_RELEASES.has(guardName(g)))
    && !Object.hasOwn(core.holds.local().inflight, t.id) && t.offer === 'none';
}

/**
 * G2 #29: a kept K4 (keptK4) without `markers` takes HLD-08's deferred OFF_DISK move (holdOps.keptK4OffDisk, one registry commit, no disk
 * write) before --restore / --publish restores it as any OFF_DISK K4 record; null when moved. Under a kept push intent or a stranded
 * restore (R3-23), or FREEZE without human evidence, nothing moves and the verb is refused as restore() would refuse it.
 */
async function moveKeptK4(core: EngineCore, it: IterationCtx, r: HoldRecord, o: ResolveOptions): Promise<ResolveResult | null> {
  if (postponedBy(core) !== null) return refused('HOLD_DISK_CHANGED', { hid: r.id });
  if (frozen(core, it) && !o.humanEvidence) return refused('HOLD_FROZEN', { hid: r.id });
  await keptK4OffDisk(core, r);
  return null;
}

// ---- --publish (Table 4, DAT-29 take, DAT-33 / DAT-39 / contract addition 3) -----------------------------------------------

async function publishVerb(core: EngineCore, it: IterationCtx, r: HoldRecord, o: ResolveOptions): Promise<ResolveResult> {
  const id = r.id;
  if (r.kind === 'INCOMING') {
    // "any non-terminal record of this peer except INCOMING records other than collision": an INCOMING `collision` is the take.
    if (carries(r, 'collision')) return writeGate(core, it, id) ?? take(core, it, r, o);
    return refused('HOLD_GUARDS_REMAIN', { hid: id, guards: names(r.guards) });
  }
  // RESTORE first releases the displacement of an OFF_DISK record — and of a kept K4 (G2 #29, keptK4: its TIP write landed, so none of
  // its bytes are on the disk; HLD-08's deferred OFF_DISK move first, once `markers` is gone: a PREDICATE, it blocks below until then);
  // every other guard must be one --publish releases.
  const kept4 = keptK4(r, it.A);
  const restored = r.residence === 'OFF_DISK' || kept4;
  const blocking = r.guards.filter((g) => !PUBLISH_RELEASES.has(guardName(g)) && !(restored && DISPLACEMENT.has(guardName(g))));
  if (blocking.length > 0) return refused('HOLD_GUARDS_REMAIN', { hid: id, guards: names(blocking) });
  if (r.paths.length === 0) return refused('HOLD_GUARDS_REMAIN', { hid: id, guards: names(r.guards) });   // the pathless host-reject PIN: resume's
  const gate = writeGate(core, it, id);
  if (gate !== null) return gate;
  // G2 #7 (after the gate: it reads attributes): an ON_DISK record that stays local_only once released never publishes (MASK step 2
  // withholds its paths whole, HLD-03): the verb answers so, as HLD-64's copy-restore of a path this PC does not sync does (05 §1),
  // instead of a RESOLVED_PUBLISH it never reaches. Nothing is written.
  // G2 #5 / #7: an ON_DISK record whose own pair cannot publish as it stands — CONFLICTED (MASK step 4 withholds the path whole whatever
  // its guards; not a displacement still pending on the disk, `conflict`/`claim-breach`/`base-move`, which only the apply or RESTORE
  // settles) or a held side with a restore-marker row (DAT-46, R3-EF4-24: local_only, never mirrored or published) — is re-based on the
  // disk (rebasedOnDisk) in the rev that releases it, so "the content becomes an observed change of the human CS" (Table 4) holds.
  let rebase = false;
  if (!restored) {
    const notLive = await staysLocalOnly(core, it, r);
    if (notLive.length > 0) return refused('HOLD_GUARDS_REMAIN', { hid: id, guards: [], not_live: notLive });
    rebase = (r.state === 'CONFLICTED' && !r.guards.some((g) => DISPLACEMENT.has(guardName(g)))) || (await heldMarkerRows(core, r));
  }
  let markers = false;
  let reBlobs: HoldBlobs | null = null;
  let twins: HoldRecord[] = [];
  if (restored) {
    if (unsettled(it, r.paths)) return refused('HOLD_DISK_CHANGED', { hid: id });
    matFor(it, r.paths, '--publish (restore first)');
    if (kept4) {
      const no = await moveKeptK4(core, it, r, o);
      if (no !== null) return no;
    }
    const out = await restore(core, it, id, { humanEvidence: o.humanEvidence, actor: 'human' });
    if (out.kind !== 'RESTORED') return restoreResult(id, r.paths, out);
    markers = out.markers;
  } else if (rebase) {
    if (unsettled(it, r.paths)) return refused('HOLD_DISK_CHANGED', { hid: id });
    const mat = matFor(it, r.paths, '--publish (re-based on the disk)');
    // DAT-46: no record takes a disk blob with a restore-marker row; the rows go first (the `markers` guard's release, Table 3).
    if (await markerRowsOnDisk(core, r.paths, mat.sDiskMap)) return refused('HOLD_GUARDS_REMAIN', { hid: id, guards: ['markers'] });
    reBlobs = rebasedOnDisk(r, it.A, mat.sDiskMap);
    // F2 #151 (HLD-07 "one change MUST have one id", INV-HLD-SINGLE): the re-based pair may already be another non-terminal record's
    // change (the human's marker resolution re-reverted a teammate's row, so the detector holds S_disk in a second revert record).
    // That twin ends GONE in the release rev — its bytes are on the disk and are r's held side now — and r, the record the human
    // named, takes its cs_ids. A twin this verb may not end refuses it first, nothing written (fail closed).
    twins = await core.holds.holdersOf(id, r.kind, r.paths, reBlobs);
    const stuck = twins.find((t) => !absorbable(core, t));
    if (stuck !== undefined) return refused('HOLD_GUARDS_REMAIN', { hid: stuck.id, guards: names(stuck.guards) });
  }
  const now = core.holds.get(id)!;
  // DAT-39 "keep syncing" (contract addition 1): the answer is recorded before the guard releases.
  if (carries(now, 'generated?')) await core.holds.markKeepSyncing(id);
  const kept = now.guards.filter((g) => !PUBLISH_RELEASES.has(guardName(g)));
  const explicit = core.holds.local().explicit.includes(id);
  const csIds = [...new Set([...now.cs_ids, ...twins.flatMap((t) => t.cs_ids)])].sort();
  const patch: HoldPatch = reBlobs !== null
    ? { guards: kept, state: 'ACTIVE', blobs: reBlobs, ...(csIds.length > now.cs_ids.length ? { cs_ids: csIds } : {}) }
    : kept.length !== now.guards.length ? { guards: kept } : {};
  const ends: Array<{ id: string; patch: HoldPatch }> = twins.map((t) => ({ id: t.id, patch: { state: 'GONE' } }));
  if (Object.keys(patch).length > 0 || !explicit) {
    const copies = twins.filter((t) => Object.hasOwn(core.holds.local().copies, t.id)).map((t) => t.id);
    await core.holds.commitMany([], [...(Object.keys(patch).length > 0 ? [{ id, patch }] : []), ...ends], {
      explicit: [id], ...(copies.length > 0 ? { clearCopies: copies } : {}),
    });
  }
  // The content becomes an observed change of the human CS (Table 4). A record that names change-sets already rides with them (a
  // wake-scope or dependency PIN, a bundle: HLD-52 publishes its CS when the last guard goes); one that names none joins the open
  // human CS on its paths that publish now (liveAfter: LIVE, or LOCAL_ONLY only by this record's own effect, which its release ended).
  // F2 #151: decided on r as the release rev left it — a twin's cs_ids it took carry the content as they carried the twin's (HLD-52).
  const rel = core.holds.get(id)!;
  if (rel.cs_ids.length === 0) {
    await ensureAttrs(core, it.epochBase, rel.paths);
    core.cs.observe(rel.paths.filter((p) => liveAfter(core, it, id, p)));
  }
  await releaseDependencyGuards(core, it);   // a dependency PIN on r releases once r withholds nothing (HLD-42)
  await mirrorSync(core, it);   // HLD-57 (c)
  return done(markers ? 'RESTORE_MARKERS' : 'RESOLVED_PUBLISH', id);
}

/**
 * DAT-29 take-team on an INCOMING `collision` record (`collision:keep` included): holdOps.collisionTake captures the local file first
 * (a guard-less OFF_DISK PARKED PATCH, h0 ABSENT, local_only by HLD-03), then writes TIP[p] through writeLocal; the collision record
 * is left to the next apply (A[p] := TIP[p], cause disk_equal, R3-33), which ends it SUBSUMED. A writer CAS failure keeps it and
 * refuses HOLD_DISK_CHANGED (the capture ends GONE, R3-67). `created` names the capture record.
 */
async function take(core: EngineCore, it: IterationCtx, c: HoldRecord, o: ResolveOptions): Promise<ResolveResult> {
  const p = c.paths[0]!;
  const before = new Set(core.holds.all().map((x) => x.id));
  const out = await collisionTake(core, it, c.id, { humanEvidence: o.humanEvidence });
  if (out === 'LOCKED') return locked(c.paths);
  if (out !== 'WRITTEN') return refused('HOLD_DISK_CHANGED', { hid: c.id });
  // The capture: the new record, or (HLD-07 attached it to an equal earlier capture) the newest capture-shaped record of p.
  const captures = core.holds.all().filter((x) => x.id !== c.id && !isTerminal(x) && x.paths.length === 1 && x.paths[0] === p
    && x.residence === 'OFF_DISK' && x.guards.length === 0 && 'h0' in x.blobs && blobAt(x.blobs.h0, p) === ABSENT);
  const created = captures.find((x) => !before.has(x.id)) ?? captures[captures.length - 1];
  await mirrorSync(core, it);   // HLD-57 (c)
  return done('HOLD_SUBSUMED', c.id, created?.id ?? null);
}

// ---- --discard (Table 4, R3-28, R3-60, contract addition 2) ----------------------------------------------------------------

/** One rev replacing the guard named `name` (any argument) by `full` (a human answer, 05 §2 grammar). */
async function answer(core: EngineCore, r: HoldRecord, name: string, full: string): Promise<ResolveResult> {
  if (!r.guards.some((g) => g.name === full)) {
    const guards = r.guards.map((g) => (guardName(g) === name ? makeGuard(full) : g));
    await core.holds.transition(r.id, { guards });
  }
  return done('HOLD_ANSWERED', r.id);
}

/**
 * EF2 fix round 1, F5 (Table 4 `--discard` of an INCOMING record: "the record ends and the next apply writes TIP as usual"; ruling: the
 * discard clears that path's meta.pending row). A not-applicable row (NOT_APPLICABLE_REASONS: an unmaterializable, quarantine or
 * collision deferral) keeps the path out of the apply trigger while its re-check holds, and recordStep re-derives the path's INCOMING
 * record from it (EF2 D5) — so the record the human just discarded came back at the next iteration. One meta-only transition before
 * the record ends (P2-DISKLOW-PENDING's form): the path rejoins the apply trigger, and the record is re-created only when a later apply
 * re-evaluates the path and it still cannot apply. A kill between the two leaves the record non-terminal (repeat the command).
 */
async function clearNotApplicablePending(core: EngineCore, paths: readonly string[]): Promise<void> {
  const view = core.view!;
  const rows = paths.filter((p) => Object.hasOwn(view.meta.pending, p) && NOT_APPLICABLE_REASONS.has(view.meta.pending[p]!));
  if (rows.length === 0) return;
  const pending = new Map(Object.entries(view.meta.pending));
  for (const p of rows) pending.delete(p);
  await core.commit({ meta: { ...view.meta, pending: Object.fromEntries(pending) } });
}

/** Some unpublished ready pair is one of the change-sets r names (r.cs_ids) and covers one of r's paths (EF2 r1 F3). */
function namesReadyPair(core: EngineCore, r: HoldRecord): boolean {
  const mine = new Set(r.cs_ids);
  return core.cs.ready().some((p) => mine.has(p.csId) && p.paths.some((x) => r.paths.includes(x)));
}

/** discardVerb's refresh check: S_disk holds a restore-marker row (DAT-46) at one of `paths` (object reads only). */
async function markerRowsOnDisk(core: EngineCore, paths: readonly string[], sDisk: TreeMap): Promise<boolean> {
  for (const p of paths) {
    const e = sDisk.get(p);
    if (isRegularEntry(e) && hasRestoreMarkerRow(await core.repo.readBlob(e.oid))) return true;
  }
  return false;
}

async function discardVerb(core: EngineCore, it: IterationCtx, r: HoldRecord, o: ResolveOptions): Promise<ResolveResult> {
  const id = r.id;
  const gate = writeGate(core, it, id);   // every --discard writes (an answer, a state, or the disk)
  if (gate !== null) return gate;
  // Special case (2): INCOMING `collision` = "keep local" (DAT-29): `collision:keep` in a new rev, the record stays non-terminal.
  if (r.kind === 'INCOMING' && carries(r, 'collision')) {
    const res = await answer(core, r, 'collision', 'collision:keep');
    await mirrorSync(core, it);   // HLD-57 (c)
    return res;
  }
  // Special case (1): a `generated?` record = "exclude" (DAT-39): no disk write, `generated?:exclude` in a new rev, the record keeps p
  // masked; HLD-42 PINs depending on it release at once (releaseDependencyGuards: a target carrying generated?:exclude ends them).
  if (carries(r, 'generated?')) {
    const res = await answer(core, r, 'generated?', 'generated?:exclude');
    await releaseDependencyGuards(core, it);
    await mirrorSync(core, it);   // HLD-57 (c)
    return res;
  }
  // OFF_DISK: state only. INCOMING: the record ends and the next apply writes TIP as usual.
  if (r.kind === 'INCOMING' || r.residence === 'OFF_DISK' || r.paths.length === 0) {
    // EF2 r1 F3: an OFF_DISK record's held content also leaves the unpublished ready pairs it names (a parked K6 PIN's CS) before it
    // ends — never while a kept push intent may carry them (R3-23: repeat the command once it resolved).
    if (r.kind !== 'INCOMING' && namesReadyPair(core, r)) {
      if (postponedBy(core) !== null) return refused('HOLD_DISK_CHANGED', { hid: id });
      await discardFromPairs(core, r);
    }
    if (r.kind === 'INCOMING') await clearNotApplicablePending(core, r.paths);
    const ended = await core.holds.transition(id, { state: 'RESOLVED_DISCARD' });
    discardEnded(core, ended);
    await mirrorSync(core, it);   // HLD-57 (c)
    return done('RESOLVED_DISCARD', id);
  }
  // ON_DISK: write r's step-5 MASK result (an ACTIVE PATCH) or A[p] (a PIN, a local_only, whole-path-guard or CONFLICTED record, a
  // binary or filtered PATCH, a MASK conflict) through writeLocalGroup — an operator write like PARK (record before displacement:
  // inflight[r] first; settleHoldOps completes it after a crash).
  if (postponedBy(core) !== null || unsettled(it, r.paths)) return refused('HOLD_DISK_CHANGED', { hid: id });   // R3-23
  const mat = matFor(it, r.paths, '--discard');
  if (frozen(core, it) && !o.humanEvidence) return refused('HOLD_FROZEN', { hid: id });
  const sDisk = mat.sDiskMap;
  const { x } = await maskAloneTarget(core, it, r, sDisk);
  const entries: Entry[] = r.paths.map((p) => ({ path: p, expected: oidAt(sDisk, p), target: x === null ? oidAt(it.A, p) : (blobAt(x, p) ?? ABSENT) }));
  const final: HoldPatch = { state: 'RESOLVED_DISCARD' };
  const op: InflightOp = { op: 'discard', entries, final, explicit: false };
  // Ruling R3-EF4-28 (delta review I2): a CONFLICTED record's held side := S_disk first (PARK's whole refresh, HLD-16), in the commit
  // that sets inflight[r], so the ended record holds the bytes this discard takes off the disk (a K4 whose LOCAL the human edited again
  // held a stale s2, and the edit was then in no record). Never for a record carrying `markers` (05 §3.4 item 3: never refreshed from
  // disk; PARK sends it to the markers park first) nor from disk bytes with a restore-marker row (DAT-46: such bytes enter no held side).
  const refresh = r.state === 'CONFLICTED' && !carries(r, 'markers') && !(await markerRowsOnDisk(core, r.paths, sDisk)) ? refreshed(r, sDisk) : null;
  await core.holds.commitMany([], refresh === null ? [] : [{ id, patch: { blobs: refresh } }], { setInflight: { [id]: op } });
  const res = await writeEntries(core, entries, `discard:${id}`, o.humanEvidence);
  if (res.kind !== 'WRITTEN') {
    await core.holds.commitMany([], [], { clearInflight: [id] });
    return writerResult(r, res);
  }
  recordWrites(core, entries);
  await parkWritten(core, entries, (p) => modeOf(p, mat.sRawMap, it.A));
  // Final review F6: every group with an unpublished ready pair over r's paths is withdrawn and re-captured from the written disk — a
  // pair need not name r (a revert PATCH has no cs_ids, yet the human CS's pair carries its teammate-line removal) — then EF2 r1 F3's
  // drop from the pairs r names.
  await withdrawWritten(core, r.paths);
  await discardFromPairs(core, r);   // EF2 r1 F3: the discarded content leaves the ready pairs r holds before r ends
  const { records } = await core.holds.commitMany([], [{ id, patch: final }], { clearInflight: [id] });
  discardEnded(core, records[0]!);
  await mirrorSync(core, it);   // HLD-57 (c)
  return done('RESOLVED_DISCARD', id);
}

// ---- --park, --restore, --handoff -----------------------------------------------------------------------------------------

async function parkVerb(core: EngineCore, it: IterationCtx, r: HoldRecord, o: ResolveOptions): Promise<ResolveResult> {
  if (r.residence === 'OFF_DISK') return done('HOLD_PARKED', r.id);   // already off the disk: no write
  // INCOMING and local_only records are never parked (Table 4); the pathless host-reject PIN has nothing to write (R3-11).
  if (r.kind === 'INCOMING' || r.local_only || r.paths.length === 0) return refused('HOLD_NOT_PARKABLE', { hid: r.id });
  const gate = writeGate(core, it, r.id);
  if (gate !== null) return gate;
  if (unsettled(it, r.paths)) return refused('HOLD_DISK_CHANGED', { hid: r.id });
  matFor(it, r.paths, '--park');
  const out = await park(core, it, r.id, { humanEvidence: o.humanEvidence, displacedBy: null, refreshMustBeDurable: false });
  if (out.kind !== 'PARKED') return parkResult(r, out);
  await mirrorSync(core, it);   // HLD-57 (c)
  return done('HOLD_PARKED', r.id);
}

/**
 * G2 #29: an ON_DISK record answers --restore with HOLD_RESTORED and no write ("its bytes are on the disk") — except a kept K4 (keptK4:
 * R3-SPEC-3/6 kept it ON_DISK after its verified TIP write because TIP's blob holds a restore-marker row), whose own change is not on the
 * disk. While it carries `markers` (the row is still there) it is refused HOLD_GUARDS_REMAIN {guards: ['markers']}: the row goes first, so
 * no restore merges over it and no OFF_DISK move unmasks it; once the row is gone it takes HLD-08's deferred OFF_DISK move (moveKeptK4)
 * and is restored as any OFF_DISK K4 record.
 */
async function restoreVerb(core: EngineCore, it: IterationCtx, r: HoldRecord, o: ResolveOptions, claude: boolean): Promise<ResolveResult> {
  const kept4 = keptK4(r, it.A);
  if (r.residence === 'ON_DISK' && !kept4) return done('HOLD_RESTORED', r.id);   // its bytes are on the disk: no write
  if (kept4 && carries(r, 'markers')) return refused('HOLD_GUARDS_REMAIN', { hid: r.id, guards: ['markers'] });
  const gate = writeGate(core, it, r.id);
  if (gate !== null) return gate;
  if (unsettled(it, r.paths)) return refused('HOLD_DISK_CHANGED', { hid: r.id });
  matFor(it, r.paths, '--restore');
  if (kept4) {
    const no = await moveKeptK4(core, it, r, o);
    if (no !== null) return no;
  }
  const out = await restore(core, it, r.id, { humanEvidence: o.humanEvidence, actor: claude ? 'claude' : 'human' });
  if (out.kind !== 'RESTORED') return restoreResult(r.id, r.paths, out);
  await mirrorSync(core, it);   // HLD-57 (c)
  return done(out.markers ? 'RESTORE_MARKERS' : 'HOLD_RESTORED', r.id);
}

/**
 * Table 4 `--handoff`: a SHADOW or a PIN carrying `claim` moves offer → offered (HLD-09 `handoff`, legal only from
 * pending_leftover), one mirrored op from the owner; Plan 6 publishes the request (R3-06). A K7 PIN only when COO-10 allows a
 * `ckind: dependency` request (false in Plan 3). Refused HOLD_NOT_OFFERABLE: revert, INCOMING, local_only, conflict, claim-breach,
 * base-move and wake-scope records, and every other record.
 */
async function handoffVerb(core: EngineCore, it: IterationCtx, r: HoldRecord): Promise<ResolveResult> {
  const no = refused('HOLD_NOT_OFFERABLE', { hid: r.id });
  if (r.kind === 'INCOMING' || r.local_only || r.guards.some((g) => NOT_OFFERABLE_GUARDS.has(guardName(g)))) return no;
  const k7 = r.kind === 'PIN' && r.guards.some((g) => guardName(g) === 't0' || guardName(g) === 'dependency');
  const offerable = isShadow(r) || (r.kind === 'PIN' && carries(r, 'claim')) || (k7 && cooAllowsDependencyRequest(r));
  if (!offerable || offerNext(r, 'handoff') === null) return no;   // HLD-09: `handoff` is legal only from pending_leftover
  const gate = writeGate(core, it, r.id);
  if (gate !== null) return gate;
  const next = await core.holds.offerEvent(r.id, 'handoff');
  if (next === null) return no;
  await mirrorSync(core, it);   // HLD-57 (c)
  return done('HOLD_OFFERED', r.id);
}

// ---- HLD-64 copy-restore (contract addition 4) -----------------------------------------------------------------------------

/** The held/<id>/ entries as the record's blob maps over `paths` (a missing entry is an ABSENT side, PRO-21). */
function blobsOf(held: readonly HeldBlob[], paths: readonly string[]): HoldBlobs {
  const map = (stage: HeldBlob['stage']): BlobMap => {
    const m: BlobMap = {};
    for (const p of paths) setBlob(m, p, ABSENT);
    for (const b of held) if (b.stage === stage) setBlob(m, b.path, b.oid as Oid);
    return m;
  };
  return held.some((b) => b.stage === 's1' || b.stage === 's2' || b.stage === 's3') ? { s1: map('s1'), s2: map('s2'), s3: map('s3') } : { h0: map('h0'), h1: map('h1') };
}

/**
 * HLD-64 (H1 (a)'s exception): a record of a peer with a folded `leave` op, absent from this registry, restored by a human. (b) first:
 * a folded terminal record or an accepted offer is HOLD_ALREADY_RESOLVED. A NEW local record copies it — its kind, paths and guards
 * (the first through hold(), the rest through addGuard; none: a guard-less OFF_DISK PARKED copy, R3-10's fourth guard-less birth),
 * born OFF_DISK in the foreign record's state (CONFLICTED stays CONFLICTED, anything else PARKED), origin 'human', displaced_by null,
 * cs_ids [], blobs from the fetched board's held/<id>/ (readHeld) — then RESTOREd. The foreign record is never transitioned. A
 * record with nothing on the board to copy (a local_only stub, an INCOMING record) or carrying a guard outside Table 3 is refused.
 */
async function copyRestore(core: EngineCore, it: IterationCtx, id: string, f: FoldedHold, o: ResolveOptions): Promise<ResolveResult> {
  if (TERMINAL_STATES.has(f.state) || f.offer === 'accepted') return done('HOLD_ALREADY_RESOLVED', id);
  const unknown = f.guards.filter((g) => guardRow(g.name) === null);
  if (unknown.length > 0) return refused('HOLD_GUARDS_REMAIN', { hid: id, guards: unknown.map((g) => g.name) });
  if (f.kind === 'INCOMING' || f.local_only || f.paths.length === 0 || it.T === ABSENT) return refused('HOLD_NOT_OWNER', { hid: id });
  const held = await readHeld(core.repo, it.T, id);
  if (held === null || held.length === 0) return refused('HOLD_NOT_OWNER', { hid: id });
  const gate = writeGate(core, it, id);
  if (gate !== null) return gate;
  if (unsettled(it, f.paths)) return refused('HOLD_DISK_CHANGED', { hid: id });
  matFor(it, f.paths, '--restore (copy)');
  await ensureAttrs(core, it.epochBase, f.paths);   // R3-71: the registry scopes the copy's paths
  // Final review F14 (SEC-31, SEC-33, glossary §16, INV-SANITIZE): copy-restore takes its paths and bytes from the board's
  // fold and held/<id>/, which a teammate forges without a scope check (LIVE-ness is writer-side only, PRO-21). It must write
  // only paths this PC would sync live, so a forged (or honestly divergent) record over a quarantined path — an execution
  // surface like .claude/settings.json or the hooksPath — never lands on disk without SEC-33's /cowork review. Fail closed:
  // a path whose scope cannot be classified (a throw) is treated as not LIVE, and nothing is written. The check sits after
  // matFor so the scope reads this iteration's materialized sizes (the 'huge' rule); writeGate before it only changes the
  // refusal code under FREEZE (HOLD_FROZEN, then this on retry) — never allows a write for a non-LIVE path.
  // Final review F13 r2 (E-4): the refusal names, per path, the scope class and not-shared reason that keep it off this PC
  // (`not_live`, a failed classification as cls/reason null); only a QUARANTINED path carries the `quarantine-review` guard
  // (SEC-33's /cowork review). Waiting or a handoff never clears it: the next command per class is Plan 7's text (spec edit
  // 05 §1), on the same registered code, since Plan 3 adds no code (R3-65, contract "Codes").
  const notLive: Array<{ path: string; cls: string | null; reason: string | null }> = [];
  for (const p of f.paths) {
    let s: ReturnType<IterationCtx['scope']> | null = null;
    try {
      s = it.scope(p);
    } catch {
      s = null;
    }
    if (s === null || s.cls !== 'LIVE') notLive.push({ path: p, cls: s?.cls ?? null, reason: s?.reason ?? null });
  }
  if (notLive.length > 0) {
    const guards = notLive.some((n) => n.cls === 'QUARANTINED') ? ['quarantine-review'] : [];
    return refused('HOLD_GUARDS_REMAIN', { hid: id, guards, not_live: notLive });
  }
  const guards = f.guards.map((g) => g.name);
  // Task 12b (carry 3): the copy is born marked as one (local.json `copies`, in its creation commit), so a crash before its RESTORE
  // completes leaves a record restart recognises and ends GONE (settleHoldOps) — never a live OFF_DISK copy nobody asked to keep.
  const k = await core.holds.holdOutcome({
    kind: f.kind, residence: 'OFF_DISK', state: guards.length > 0 && f.state === 'CONFLICTED' ? 'CONFLICTED' : 'PARKED', paths: [...f.paths],
    blobs: blobsOf(held, f.paths), guard: guards[0] ?? null, origin: 'human', cs_ids: [], displaced_by: null, copyOf: id,
  });
  // Ruling R3-EF4-30 (EF5 merge Z-4): HLD-07 may attach the copy to an ON_DISK record of this peer (the same change, its bytes already on
  // the disk); restore() restores OFF_DISK records only (a TypeError otherwise), so that record is answered here as restoreVerb answers
  // --restore of an ON_DISK record: HOLD_RESTORED, no write. G2 #8: the registry attaches a copy to an ON_DISK record only as that same
  // change (never the K4 branch's takeover, never CONFLICTED with the foreign stages: registry.ts attachOf), and the record then gains
  // what the copy's RESTORE would leave on it — its other guards but no displacement guard (HLD-17 releases them).
  const onDisk = !k.created && core.holds.get(k.id)?.residence === 'ON_DISK';
  for (const g of guards.slice(1)) if (!onDisk || !DISPLACEMENT.has(guardName(makeGuard(g)))) await core.holds.addGuard(k.id, g);
  if (onDisk) {
    await mirrorSync(core, it);   // HLD-57 (c): a guard or cs_ids the attach added
    return done('HOLD_RESTORED', id, k.id);
  }
  const out = await restore(core, it, k.id, { humanEvidence: o.humanEvidence, actor: 'human' });
  const marked = Object.hasOwn(core.holds.local().copies, k.id);
  if (out.kind !== 'RESTORED') {
    // Nothing was restored: the copy made for this command ends GONE (as collisionTake's failed capture, R3-67) — never a live
    // record the refusal does not name; never mirrored (mirrorSync skips a terminal record the board never saw). A record HLD-07
    // attached the copy to is this peer's own and stays. The human's repeat makes a fresh copy.
    if (k.created) await core.holds.commitMany([], [{ id: k.id, patch: { state: 'GONE' } }], marked ? { clearCopies: [k.id] } : undefined);
    return restoreResult(id, f.paths, out);
  }
  if (marked) await core.holds.commitMany([], [], { clearCopies: [k.id] });   // restored: an ordinary record of this peer from now on
  await mirrorSync(core, it);   // HLD-57 (c)
  return done(out.markers ? 'RESTORE_MARKERS' : 'HOLD_RESTORED', id, k.id);
}
