// Escalation, S6 and the stop primitives (Plan 3 Task 12b; 05-holds HLD-60…HLD-63, §2 age anchor, §5 INV-HLD-DURABLE, INV-CLOCK;
// glossary §20 "Hold escalation" and "ON_DISK hold auto-park", §25.2 items 1 and 9; 02-protocol INV-ONE-EVENT, T-PRO-16; 01-engine
// §3.11 (writeLocal records the caller's origin), ENG-37; rulings R3-36, R3-45, R3-60, R3-70):
//
//   escalationStep     timers T, on the owner's PC only (every record of this registry is this peer's): HOLD_CREATED {path, hid,
//                      REASON} — HOLD_CONFLICTED {path, author, hid} for a record born CONFLICTED — once for every record created
//                      since the previous call, then HOLD_BINARY_WHOLE_FILE {hid, path} again for a binary-path revert PIN so status
//                      ends on it (R3-70; revertStep logged it once, so this raise is status only); and, per revert record at age
//                      ≥ REVERT_EVENT_AFTER_MS, exactly one event{kind: health, reason_code: HOLD_REVERT_HELD, refs: [hold_id]}
//                      (INV-ONE-EVENT: never while the fold or the outbox already holds one) with HOLD_REVERT_HELD to status and log
//   s6Step             HLD-61 S6: an ON_DISK PATCH or PIN (ACTIVE or CONFLICTED) with local_only false, not INCOMING, aged ≥
//                      S6_AFTER_MS, durable on the fetched board tip (isDurable, R3-26), with no path in an open CS or — for a
//                      guard-less record — in another CS's unpublished ready pair (EF2 r1 F6), outside every
//                      FREEZE reason, with no kept push intent or stranded restore (R3-23) and an S_disk current for its paths is
//                      parked — the markers park for a record carrying `markers`, else PARK with humanEvidence false, displaced_by
//                      null and refreshMustBeDurable (a refresh rev first, the park in a later loop once it is durable, R3-45);
//                      REFRESHED, LOCKED, MISMATCH and POSTPONED retry at a later loop; HOLD_AUTO_PARKED {path, hid, next}
//   durabilityReport   HLD-62 / HLD-63 step 2 input for Plan 7's stop: every non-terminal record, local_only ones only in localOnly
//   parkAllForStop     HLD-63 step 3: PARK (or the markers park) every ON_DISK PATCH/PIN with local_only false, humanEvidence true,
//                      displaced_by = the `leave` op id, refreshMustBeDurable; a refresh not yet durable is `failed`
//   discardHolds       HLD-63 --discard-holds: each id through Table 4 `--discard` (resolve.ts), RESOLVED_DISCARD, mirrored
//
// The park family reaches park/markersPark (holdOps.ts), which record every written path in ObservedWrites, set its private-index
// entry and commit the snap-only state transition (R3-36, R3-60); `--discard` does the same in resolve.ts — so no detector counts these
// writes as unobserved deltas, in this run or after the restart that follows a stop. Nothing here parks from Engine.drain (HLD-63: a
// daemon exiting on lease loss or IDLE_NO_SESSION never parks). Ages come only from HoldRegistry.ageMs (the age_anchor, INV-CLOCK).
import type { Json } from '../board/canonicalJson.js';
import type { FoldedHold, FoldState } from '../board/fold.js';
import type { HeldBlob } from '../board/boardCommit.js';
import type { EventOp, OpDraft } from '../board/ops.js';
import { ABSENT, type Oid } from '../git/oid.js';
import { isDurable } from '../holds/mirror.js';
import { blobAt, heldSide, isTerminal, isUnknownGuard, reasonKey, type HoldRecord } from '../holds/record.js';
import { foldPatch, materializedFor, type EngineCore, type IterationCtx } from './core.js';
import { carries, frozen, park, postponedBy, raise, takeConflictedTold } from './holdOps.js';
import { holdCodeHolds } from './holdSteps.js';
import { heldOfTip } from './publish.js';
import type { LogParam } from '../ports/log.js';
import { resolve } from './resolve.js';

/** HLD-60: a revert record's board event at +10 min (glossary §20 "Hold escalation"). */
export const REVERT_EVENT_AFTER_MS = 600_000;
/** HLD-61: S6 auto-parks an ON_DISK record with local_only false after 24 h (glossary §20). */
export const S6_AFTER_MS = 86_400_000;
/** The restore command HOLD_AUTO_PARKED and the start's HOLD_PARKED line name (05 §2; texts are Plan 7's). */
export const RESTORE_NEXT = '/cowork resolve <id> --restore';

const REVERT_HELD = 'HOLD_REVERT_HELD';

interface Memory {
  /** Record ids already told (HOLD_CREATED / HOLD_CONFLICTED, or skipped); null until seeded. */
  announced: Set<string> | null;
  /** Revert records whose HOLD_REVERT_HELD event this run drafted or found posted. */
  readonly revertPosted: Set<string>;
}

const memories = new WeakMap<EngineCore, Memory>();

function memoryOf(core: EngineCore): Memory {
  let m = memories.get(core);
  if (m === undefined) {
    m = { announced: null, revertPosted: new Set() };
    memories.set(core, m);
  }
  return m;
}

/**
 * The records the registry holds when the Engine is built (re-attached from earlier runs, HLD-01) are no new creations: they are
 * never announced again. Engine's constructor calls it; a core whose first escalationStep finds no seed seeds itself there (every
 * record then present counts as already told).
 */
export function seedEscalation(core: EngineCore): void {
  memoryOf(core).announced = new Set(core.holds.all().map((r) => r.id));
}

/**
 * Whether a new record gets HOLD_CREATED / HOLD_CONFLICTED: non-terminal, not INCOMING (its status lines are incomingStep's,
 * HLD-54), at least one guard (a guard-less birth is OFF_DISK PARKED: a marker companion, a late write, a take capture — told by its
 * operator), and not a record whose creator raises its own 03-data code (`portability`: PATH_NOT_PORTABLE, `generated?`:
 * GENERATED_SUSPECT), with a {REASON} key.
 */
function announceable(core: EngineCore, r: HoldRecord): boolean {
  if (isTerminal(r) || r.kind === 'INCOMING' || r.guards.length === 0) return false;
  if (carries(r, 'portability') || carries(r, 'generated?')) return false;
  return reasonKey(r, (id) => core.holds.get(id)) !== null;
}

/** A binary-path revert PIN: one path, a held blob (a deletion PIN holds ABSENT) — revertDetector's whole-file PIN (detect.ts). */
function binaryRevertPin(r: HoldRecord): boolean {
  if (r.kind !== 'PIN' || r.paths.length !== 1 || !carries(r, 'revert')) return false;
  const h = blobAt(heldSide(r), r.paths[0]!);
  return h !== undefined && h !== ABSENT;
}

/** The ids a HOLD_REVERT_HELD health event already names: folded on the board, or queued (allocated or not) in the outbox. */
function revertEventsHeld(core: EngineCore, fold: FoldState): Set<string> {
  const out = new Set<string>();
  for (const e of Object.values(fold.events)) if (e.kind === 'health' && e.reason_code === REVERT_HELD) for (const id of e.refs) out.add(id);
  for (const d of core.outbox.drafts()) for (const id of revertEventRefs(d)) out.add(id);
  return out;
}

/** The refs of a queued HOLD_REVERT_HELD health event draft; [] for any other draft. */
function revertEventRefs(d: OpDraft): readonly string[] {
  if (d.type !== 'event') return [];
  const e = d as Omit<EventOp, 'id'>;
  return e.kind === 'health' && e.reason_code === REVERT_HELD ? e.refs : [];
}

/**
 * HLD-60 on the owner's PC (contract: HOLD_CREATED/HOLD_CONFLICTED for every record created since its last call, then
 * HOLD_BINARY_WHOLE_FILE {hid, path} again for a binary-path revert PIN so status ends on it, R3-70; one event{kind: health,
 * reason_code: HOLD_REVERT_HELD, refs: [hold_id]} per revert record at age ≥ 10 min unless the fold or the outbox already holds it,
 * INV-ONE-EVENT; none for a restart's safety copy, isSettleCopy — its parent's event covers it, Ruling R3-FF4-A2). The event is drafted into the outbox (the next window carries it; a record whose draft died with the process is
 * drafted again after the restart, since neither the fold nor the persisted outbox holds it) and HOLD_REVERT_HELD {path, author, hid}
 * goes to the log. HOLD_CREATED and HOLD_REVERT_HELD are announcements: they take the status slot only when it is free (announce);
 * HOLD_CONFLICTED always does (as evaluateRecords raises it), and the binary re-raise follows a HOLD_CREATED that took the slot.
 */
export async function escalationStep(core: EngineCore, it: IterationCtx): Promise<void> {
  const mem = memoryOf(core);
  const all = core.holds.all();
  if (mem.announced === null) mem.announced = new Set(all.map((r) => r.id));
  // Fix round 1 (minor d): a record that step 5R's evaluateRecords already told HOLD_CONFLICTED is not told again here.
  const toldConflicted = takeConflictedTold(core);
  for (const r of all) {
    if (mem.announced.has(r.id)) continue;
    mem.announced.add(r.id);
    if (!announceable(core, r)) continue;
    const path = r.paths[0] ?? '';
    if (r.state === 'CONFLICTED') {
      if (!toldConflicted.has(r.id)) raise(core, 'HOLD_CONFLICTED', { path, author: r.peer_authors[0] ?? null, hid: r.id }, 'warn');
    } else if (announce(core, it, 'HOLD_CREATED', { path, hid: r.id, REASON: reasonKey(r, (id) => core.holds.get(id)) }) && binaryRevertPin(r)) {
      // R3-70: status ends on the binary code; revertStep wrote its one log line (detect.ts), so this raise is status only.
      core.holdCode = { code: 'HOLD_BINARY_WHOLE_FILE', params: { hid: r.id, path } };
    }
  }
  // HLD-60's revert row: +10 min, one board event per record — never for a restart's safety copy (local.json settleCopies; Ruling
  // R3-FF4-A2, integration I-7): the copy duplicates its parent's change, whose own event already told the team.
  const due = core.holds.nonTerminal().filter((r) => r.kind !== 'INCOMING' && carries(r, 'revert') && !mem.revertPosted.has(r.id)
    && !core.holds.isSettleCopy(r.id) && core.holds.ageMs(r) >= REVERT_EVENT_AFTER_MS);
  if (due.length === 0) return;
  const held = revertEventsHeld(core, it.fold);
  for (const r of due) {
    mem.revertPosted.add(r.id);
    if (held.has(r.id)) continue;
    core.outbox.add({ type: 'event', cid: '', kind: 'health', refs: [r.id], reason_code: REVERT_HELD });
    announce(core, it, REVERT_HELD, { path: r.paths[0] ?? '', author: r.peer_authors[0] ?? null, hid: r.id });
  }
}

/** HLD-60's announcements: a record's creation line and the +10 min revert line. */
const ANNOUNCEMENTS: ReadonlySet<string> = new Set(['HOLD_CREATED', REVERT_HELD]);

/**
 * An announcement goes to the daemon log always, and into the status slot (EngineCore.holdCode, R3-61) only when that slot holds
 * nothing that still holds (holdCodeCurrent) or another announcement: it never displaces an ongoing condition or newer news about a
 * held record (HOLD_MASK_INVALID while S_pub is invalid, FROZEN, HOLD_CONFLICTED of a record still conflicted, …). True when it took
 * the slot.
 */
function announce(core: EngineCore, it: IterationCtx, code: string, params: Record<string, Json>): boolean {
  const slot = core.holdCode;
  // Fix round 1 (minor b): judged with Plan 2's not_converged of the last status write too (holdCodeHolds), and without changing the slot.
  if (slot === null || ANNOUNCEMENTS.has(slot.code) || !holdCodeHolds(core, it)) {
    raise(core, code, params);
    return true;
  }
  const flat: Record<string, LogParam> = {};
  for (const [k, v] of Object.entries(params)) flat[k] = Array.isArray(v) ? v.map(String).join(',') : (v as LogParam);
  core.deps.log.write('info', code, flat);
  return false;
}

// ---- S6 (HLD-61) --------------------------------------------------------------------------------------------------------

/** An ON_DISK PATCH or PIN with local_only false, paths, and only Table 3 guards: what S6 and the stop park (HLD-61, HLD-63). */
function parkCandidate(r: HoldRecord): boolean {
  return !isTerminal(r) && r.residence === 'ON_DISK' && (r.kind === 'PATCH' || r.kind === 'PIN') && !r.local_only && r.paths.length > 0
    && !r.guards.some(isUnknownGuard);
}

/** The records S6 may park by age (durability and the other gates are s6Step's). */
function s6Aged(core: EngineCore): HoldRecord[] {
  return core.holds.nonTerminal().filter((r) => parkCandidate(r) && core.holds.ageMs(r) >= S6_AFTER_MS);
}

const foldedOf = (fold: FoldState, id: string): FoldedHold | undefined => (Object.hasOwn(fold.holds, id) ? fold.holds[id] : undefined);

/**
 * The paths of the S6 candidates due this loop (iterate() puts them into PrepareOptions.holdPaths, so the loop that parks has a
 * current S_disk for them — a hold-record occasion, W6 (c)): the records old enough that are durable on the last folded board
 * (foldPatch, else the state's fold; heldOfTip is cached by board oid), not HOLD_MIRROR_REJECTED and in no other CS; none under any
 * FREEZE reason, a kept push intent or a stranded restore. A record that cannot be parked — offline, rejected, oversized, frozen —
 * therefore never makes a loop materialize (no MASK or object work every idle loop); s6Step decides again on the iteration's fold.
 */
export async function s6Due(core: EngineCore): Promise<Set<string>> {
  const aged = s6Aged(core);
  const view = core.view;
  if (aged.length === 0 || view === null || view.meta.freeze_reasons.length > 0 || postponedBy(core) !== null) return new Set();
  const fp = foldPatch(core);
  const fold = fp?.fold ?? view.fold;
  const board = fp?.meta.fold_board ?? view.meta.fold_board;
  if (fold === null || board === null) return new Set();
  const tipHeld = await heldOfTip(core, board);
  const rejected = core.holds.local().rejected;
  const due = aged.filter((r) => !Object.hasOwn(rejected, r.id) && isDurable(r, foldedOf(fold, r.id), tipHeld.get(r.id) ?? null) && !inAnotherCs(core, r));
  return new Set(due.flatMap((r) => r.paths));
}

/**
 * HLD-61's change-set gate: a path of r is a local delta of a change-set with no ready pair (ChangeSets.openPaths: an open CS, the
 * open human CS before its first capture, a closed one whose capture is due, a path waiting for a recapture) — except a closed CS
 * that joined r itself as a bundle (HLD-49, R3-44: its cs_id is in r.cs_ids; it waits for r's guards, and r's held side carries its
 * bytes), which never blocks r: else S6 could never park a held PIN that a CS closed against.
 *
 * EF2 fix round 1, F6 (controller ruling): S6 also waits while an unpublished ready pair of another CS covers a path of r. A guard-less
 * record released by `--publish` (it waits for RESOLVED_PUBLISH; its bytes became an observed change of the human CS, Table 4) has its
 * hunks in that CS's captured pair until it lands; parking it then took the hunks off the disk while the pair still published them,
 * and the record ended PARKED with nothing of it left to restore. The wait applies while r carries no guard, and then on every covering
 * pair, r's own cs_ids included: a guard-less PIN is no held PIN (heldPins), so its own CS's pair publishes too (HLD-52's release).
 * A guarded record does not wait: waiting there would never end when the pair is r's own masked content (a RESTORE's marker rows, which
 * the human CS captured, under guard `markers`: the pair cannot publish while r holds, and r would wait for the pair — I-DAT-12's markers
 * park). Its park loses nothing either, but not because MASK keeps withholding its hunks — an OFF_DISK record masks nothing (05 §3.4
 * item 2, INV-HLD-OFFDISK), so a parked PIN no longer holds its group (EF2 F6's premise, "withheld whatever the residence", was false
 * for PINs). Plan 3 final review F6: every park withdraws each publication group whose unpublished ready pair covers a parked path
 * (holdOps.withdrawWritten, ChangeSets.withdrawPaths), and the group is re-captured from the post-park disk, so no pair publishes the
 * parked bytes. A guard-less record still waits, so a record released by `--publish` lands (RESOLVED_PUBLISH) instead of being parked.
 */
function inAnotherCs(core: EngineCore, r: HoldRecord): boolean {
  const open = core.cs.openPaths();
  const mine = new Set(r.cs_ids);
  const listed = core.cs.table().cs;
  for (const p of r.paths) {
    if (!open.has(p)) continue;
    const holders = listed.filter((e) => e.paths.includes(p));
    // No listed holder: the open human CS before its first capture (no cs_id yet) or a recapture — another CS.
    if (holders.length === 0 || holders.some((e) => !mine.has(e.cs_id))) return true;
  }
  return r.guards.length === 0 && core.cs.ready().some((pair) => pair.paths.some((p) => r.paths.includes(p)));
}

/**
 * HLD-61 S6 per R3-45 (see the file comment): the parked ids. Postponed as a whole — nothing written, retried at a later loop — under
 * any FREEZE reason, a kept push intent or a stranded restore; per record while it is not durable on the fetched board tip (a record offline since its creation, HOLD_MIRROR_REJECTED or with an
 * oversized op is never durable, glossary §25.2 item 1), a path is in an open CS, or this iteration has no current S_disk for its
 * paths. HOLD_AUTO_PARKED {path, hid, next: '/cowork resolve <id> --restore'} to status and the log after each park.
 */
export async function s6Step(core: EngineCore, it: IterationCtx): Promise<string[]> {
  const parked: string[] = [];
  const aged = s6Aged(core);
  if (aged.length === 0 || it.T === ABSENT) return parked;
  if (frozen(core, it) || postponedBy(core) !== null) return parked;
  const tipHeld = await heldOfTip(core, it.T);
  for (const r of aged) {
    if (!isDurable(r, foldedOf(it.fold, r.id), tipHeld.get(r.id) ?? null)) continue;
    if (inAnotherCs(core, r) || !materializedFor(it, r.paths)) continue;
    if (postponedBy(core) !== null) break;
    // park() takes the markers park for a record carrying `markers` (05 §3.4 item 3; glossary §9: S6 applies to marker records).
    const out = await park(core, it, r.id, { humanEvidence: false, displacedBy: null, refreshMustBeDurable: true });
    if (out.kind !== 'PARKED') continue;   // REFRESHED (durable in a later loop), LOCKED, MISMATCH, POSTPONED, FROZEN: a later loop
    parked.push(r.id);
    raise(core, 'HOLD_AUTO_PARKED', { path: r.paths[0]!, hid: r.id, next: RESTORE_NEXT });
  }
  return parked;
}

// ---- durability and the stop primitives (HLD-62, HLD-63) -----------------------------------------------------------------

export interface DurabilityReport { notDurable: string[]; localOnly: string[]; onDisk: string[]; offDisk: string[]; }

/**
 * HLD-62 against the fold `fold` of board tip `board` (null: no board; nothing is durable): every non-terminal record — a local_only one
 * only in `localOnly` (never durable, never blocking a plain stop), every other one in `onDisk` or `offDisk` by residence and, when the
 * fold does not show its current mirror key with its held/ blobs, in `notDurable` (Plan 7's STOP_HOLDS_NOT_DURABLE list). ULID order.
 */
export async function durabilityOn(core: EngineCore, fold: FoldState | null, board: Oid | null): Promise<DurabilityReport> {
  const out: DurabilityReport = { notDurable: [], localOnly: [], onDisk: [], offDisk: [] };
  const tipHeld: ReadonlyMap<string, readonly HeldBlob[]> = board === null ? new Map() : await heldOfTip(core, board);
  for (const r of core.holds.nonTerminal()) {
    if (r.local_only) {
      out.localOnly.push(r.id);
      continue;
    }
    if (r.residence === 'ON_DISK') out.onDisk.push(r.id);
    else if (r.residence === 'OFF_DISK') out.offDisk.push(r.id);
    if (fold === null || !isDurable(r, foldedOf(fold, r.id), tipHeld.get(r.id) ?? null)) out.notDurable.push(r.id);
  }
  return out;
}

/** HLD-62 against the iteration's fetched board tip (Plan 7's stop step 2, after the outbox push of step 1). */
export async function durabilityReport(core: EngineCore, it: IterationCtx): Promise<DurabilityReport> {
  return durabilityOn(core, it.fold, it.T === ABSENT ? null : it.T);
}

/** The records the stop parks (HLD-63 step 3): ON_DISK PATCH/PIN, local_only false, with paths. */
export function stopCandidates(core: EngineCore): HoldRecord[] {
  return core.holds.nonTerminal().filter((r) => r.residence === 'ON_DISK' && (r.kind === 'PATCH' || r.kind === 'PIN') && !r.local_only && r.paths.length > 0);
}

/**
 * HLD-63 step 3 for Plan 7's stop (never called by drain): PARK every ON_DISK PATCH/PIN with local_only false, displaced_by =
 * leaveOpId (the `leave` op Plan 7 allocated, Table 2), humanEvidence true, refreshMustBeDurable (a PIN, CONFLICTED or whole-path record
 * whose held side the disk changed first commits that rev and is `failed` until it is durable, R3-45); a record carrying `markers` by
 * the markers park, its companion listed in `companions`. A record this iteration has no current S_disk for, one carrying a guard
 * outside Table 3 (never transitioned, HLD-05) or any other park outcome is `failed`; local_only records are left ON_DISK (not listed).
 * The pathless host-reject PIN has nothing to write and is skipped (R3-11).
 * Ruling R3-FF2-C2: a park rewrites its paths, so the S_disk `it` holds for them is no longer the disk. A later candidate on one of
 * those paths (two records on one path: a revert record the stop's step D made shares its candidate's path) parks on a fresh S_disk —
 * `rematerialize` (Engine.parkAllForStop's: another prepared iteration over the remaining candidates' paths, with step D) — never on
 * the stale one (its expected bytes fail the writer's DISK_EQ, and a whole-path refresh would hold bytes no longer on the disk). The
 * candidates are read again after every park, so a record that iteration's step D makes is parked too. Without a fresh iteration (none
 * given, or it cannot be prepared) such a record is `failed`.
 */
export async function parkAllForStop(
  core: EngineCore, it: IterationCtx, leaveOpId: string, rematerialize?: (paths: readonly string[]) => Promise<IterationCtx | null>,
): Promise<{ parked: string[]; companions: string[]; failed: string[] }> {
  const out = { parked: [] as string[], companions: [] as string[], failed: [] as string[] };
  const seen = new Set<string>();
  const rewritten = new Set<string>();   // paths a park of this stop wrote since `cur` materialized them
  let cur = it;
  let noFresh = false;   // a fresh iteration could not be had: a later candidate on a rewritten path is `failed` too
  for (;;) {
    const left = stopCandidates(core).filter((x) => !seen.has(x.id));
    const r = left[0];
    if (r === undefined) break;
    seen.add(r.id);
    if (r.paths.some((p) => rewritten.has(p))) {
      const fresh = noFresh || rematerialize === undefined ? null : await rematerialize([...new Set(left.flatMap((x) => x.paths))]);
      if (fresh === null) {
        noFresh = true;
        out.failed.push(r.id);
        continue;
      }
      cur = fresh;
      rewritten.clear();
    }
    if (r.guards.some(isUnknownGuard) || !materializedFor(cur, r.paths)) {
      out.failed.push(r.id);
      continue;
    }
    const res = await park(core, cur, r.id, { humanEvidence: true, displacedBy: leaveOpId, refreshMustBeDurable: true });
    if (res.kind !== 'PARKED') {
      out.failed.push(r.id);
      continue;
    }
    out.parked.push(r.id);
    if (res.companion !== null) out.companions.push(res.companion);
    for (const p of r.paths) rewritten.add(p);
  }
  return out;
}

/**
 * HLD-63 `--discard-holds=<ids>` (confirmed by Plan 7's preview/confirm): each id through Table 4 `--discard` (resolve.ts, a human
 * verb: humanEvidence true) — RESOLVED_DISCARD, the mirrored op drafted by resolve's mirrorSync, an ON_DISK record's write with origin
 * discard:<id>, recorded in ObservedWrites with its private-index entry and R3-60's snap transition. The ids that ended
 * RESOLVED_DISCARD (a refusal, a lock or a `--discard` that records an answer instead — `generated?`, `collision` — is not listed).
 * The caller prepares `it` with the ON_DISK records' paths as PrepareOptions.holdPaths.
 */
export async function discardHolds(core: EngineCore, it: IterationCtx, ids: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids) {
    const r = await resolve(core, it, id, 'discard', { humanEvidence: true, actor: 'human' });
    if (r.kind === 'done' && r.code === 'RESOLVED_DISCARD') out.push(id);
  }
  return out;
}
