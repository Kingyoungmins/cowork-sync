// Apply (01-engine §3.11; ENG-06, ENG-14, ENG-29 apply side, ENG-30…ENG-36; INV-ENG-PROGRESS; HLD-41, HLD-53; DAT-26,
// DAT-27, DAT-29, DAT-33 receive side; rulings R-02, R-05).
//
//   admission     not frozen, a lease, a sound snapshot, ∃ applicable A[p] ≠ TIP[p] (applyNeeded), ≥ 10 s since the last
//                 apply; the iteration materializes S_disk here when the caller has not
//   merge         M_disk = merge-tree --merge-base=A S_disk TIP (ENG-29: S_disk is the only ours, never S_pub)
//   carry         a result that moved local work onto a path the local side did not change takes theirs there, and the
//                 source path goes to the conflict function as a rename unit (01-engine §3.10 "Rename carry")
//   conflicts     every other conflicted path through the one conflict function (D8/D9): CONCAT, TAKE_TIP (+ a K4 record)
//                 or DEFER; every conflicted path gets a whole-path replacement, so no marker blob reaches t/M or the disk.
//                 One exception, RATIFIED (controller ruling, FB fix round 2): when git cannot index the merged tree — a
//                 root drive-prefix name from TIP on Windows (final review FB-6) — t/M is the merged tree itself, marker
//                 blobs included, and every replaced path is deferred unmaterializable, never written. Safe because t/M
//                 is read only for the journaled group entries (the restart's targets, restart.ts resolveWriteIntent) and
//                 a deferred path never enters a group. Cost if wrong: any later reader of t/M must skip the deferred paths
//   under a file  a path the local side changed (S ≠ A) that TIP lacks, beneath a path that is a file in M_disk (a teammate
//                 made `d` a file while this peer added `d/x`; the carry put TIP's `d` back): one tree cannot hold both,
//                 so it is displaced like a TAKE_TIP — removed from M_disk with a K4 record (stages A, S_disk, ABSENT)
//                 committed before the writer moves it away — never dropped from t/M by the index's --replace without one
//                 (the apply-side twin of group FC's publish-side fix)
//   W             diff(S_disk, M_disk) minus UNMANAGED paths (never written: A follows TIP, DAT-26); SAVE_ONLY is written
//                 like LIVE (DAT-27); a QUARANTINED path is never written live (P2-QUARANTINE-IN, S8)
//   not applicable  before grouping (INV-GROUP): a QUARANTINED path (quarantine; also kept out of the conflict function),
//                 carried or not creatable here (unmaterializable, DAT-33), a creation onto an existing local entry
//                 (collision, DAT-29), a path beneath a local symlink, junction or file; listed in meta.pending, they
//                 leave the apply trigger while their per-loop re-check holds (P2-NA-TRIGGER, core.ts)
//   form check    (Plan 3 Task 6) formCheckIncoming before the merge: a violating path keeps the local side, deferred eol_form
//   R3-33         (Task 6) a creation onto a local file spelled exactly p whose bytes DISK_EQ TIP's is applied with no write
//   defer set     the snapshot's per-loop exclusions (unreadable/unstable/filter_failure); HLD-53 groups, closure — the CS range
//                 (LA_C, TIP] plus the CSs of the commits that changed a still-deferred path since the commit that gave it its
//                 A blob (incomingBase, Task 6, R3-EF4-4; an FB-6 deferral counts, R3-EF4-16); one ApplyReport.closures entry per
//                 deferred write group (R3-31)
//   admission     free space ≥ 2 × bytes to write + 256 MB, else the whole apply defers disk_low
//   temp names    Writer.reserve frees every tmp/<n>.<slot>.* name of J before anything is recorded or journaled (final
//                 review FB-1), else the whole apply defers locked
//   records      a K4 PATCH (CONFLICTED, ON_DISK, guard conflict) for every displaced local version, committed before any
//                 disk write (R-02 apply side); onto an ON_DISK record carrying `markers` (EF4 E4-1, R3-EF4-7) a marker
//                 companion keeps S_disk[p] and the record takes marker-free stages, in one registry commit (k4OntoMarkers); any
//                 other displaced marker file (R3-EF4-15: a multi-path, unknown-guard or companion holder, or rows with no holder):
//                 the K4 record takes marker-free stages, then a marker companion of it keeps S_disk[p] (k4OverMarkerFile); in
//                 both the stage pair (s1, s2) is one record's own change (R3-EF4-25, ownStagePair): (A[p], REBASE(r onto A)) or,
//                 when that REBASE conflicts, r's own (base, held side) at p
//   J             the apply intent with t/M, t/S, t/TIP; crashpoint('apply.intent'); Writer.applyGroups
//   C             ONE state update (ENG-36): A per path, LA_C := TIP, LA_B := T, snap := S_disk, pending, the HLD-41 rebased
//                 ready pairs, the fold, intent cleared (kept while a restore is stranded, P2-STRANDED) — before it, each revert
//                 shrink mark a clean HLD-41 rebase moved is a reverts.jsonl line, fsynced (Plan 3 Task 17, decision D2);
//                 crashpoint('apply.state'); then the in-memory A and the provenance journal's advance (Plan 3 Task 8, R3-59)
//
// A[p] := TIP[p] only for a verified write (write_verified), an applicable non-deferred path with M_disk[p] == S_disk[p]
// (disk_equal) and an UNMANAGED path (unmanaged_follow; its private-index entry := TIP[p], never hashed). A PHANTOM keeps
// A[p] (no verified write, ENG-06) and its path leaves the trigger while its PIN holds (ENG-34 is the ping-pong breaker).
import { join } from 'node:path';
import { formatWriter, parseCsTrailers, parseWriter, type WriterId } from '../board/boardCommit.js';
import { liveSet } from '../board/fold.js';
import { conflict, type ConflictCtx, type ConflictVerdict, type UnitKind } from '../data/conflict.js';
import { chainBound, formCheckIncoming, pathChains } from '../data/formCheck.js';
import { hasRestoreMarkerRow } from '../data/rows.js';
import { wildmatch, type PortRule } from '../data/scope.js';
import { mergeFile, MergeFailedError, mergeTree } from '../git/merge.js';
import { ABSENT, parseOid, type Oid } from '../git/oid.js';
import { parseMessage } from '../git/trailers.js';
import type { GitRepo, IndexEdit, TreeEntry, TreeMap } from '../git/repo.js';
import { writeGroups, type DeferReason, type IncomingCs } from '../holds/groups.js';
import { closureReason, type ClosureReason } from '../holds/incoming.js';
import type { ReadyPair, RebaseChange } from '../holds/changesets.js';
import type { HoldPatch, NewRecord } from '../holds/registry.js';
import { blobAt, guardName, heldSide, isTerminal, isUnknownGuard, makeGuard, type HoldRecord } from '../holds/record.js';
import { HoldOperatorError } from '../holds/rebase.js';
import { crashpoint, KilledAt } from '../ports/crashpoint.js';
import { LEASE_STOP_SYNC_MS } from '../ports/lease.js';
import type { ASetCause } from '../ports/trace.js';
import {
  advanceProvenance, applicableDifference, currentA, editable, ensureAttrs, foldPatch, liveCodeOf, localOnlyScope, markApplyIntentKept, pathIsFiltered, pathIsText, phantomPaths,
  caseFoldingDisk, keepIncomingWriters, notApplicableRuleOf, sameEntry, setCurrentA, spelledExactly, tickInputOf, unmaterializableHere, type EngineCore, type IncomingWriter,
  type IterationCtx,
} from './core.js';
import type { AppliedPath } from './deps.js';
import type { Exclusion } from './snapshot.js';
import { resetScratchIndex } from './diskEq.js';
import { StateCasLostError, type Intent, type JournalTree } from './state.js';
import { stageable } from './stagedRead.js';
import { isRegularEntry as isRegular } from './treeDiff.js';
import { editIndexOnly, editTreeIndexOnly, IndexRefusedPathError } from './treeEdit.js';
import { narrowToStranded, type GroupResult, type Remerge, type WriteEntry, type WriteGroup, type WriteKind } from './writer.js';

export const APPLY_COALESCE_MS = 10_000;
export const FREE_SPACE_MARGIN_BYTES = 268_435_456;

export interface ApplyReport {
  ran: boolean;
  skipped: null | 'frozen' | 'coalesced' | 'nothing' | 'disk_low' | 'snapshot_failed' | 'lease' | 'merge_failed'
    | 'stranded'               // contract extension (P2-STRANDED): a rollback restore is stranded, no new intent is journaled
    | 'push_intent_pending'    // contract extension (P2-PUSHINTENT-FIRST): a push intent is kept; resolvePushIntent first
    | 'locked'                 // contract extension (final review FB-1): a writer temp name could not be freed; nothing journaled
    | 'txn';                   // contract extension (F2 #59): a Bash|PowerShell|Monitor TXN is open (06 §3.7.3)
  written: string[]; deleted: string[];
  deferred: Map<string, DeferReason>; notApplicable: Map<string, 'collision' | 'unmaterializable' | 'quarantine'>;
  records: string[]; cancelled: string[];
  changedA: string[];          // Plan 3 Task 5: the paths whose A[p] this apply changed (input of R1's OFF_DISK check, HLD-08)
  // Plan 3 Task 6 (R3-31): one entry per deferred write group: Plan 2's per-(group, reason) WriteGroupsResult.deferred entries of one
  // group regrouped (paths = their union, sorted; reason = closureReason of their reasons), and every group the writer deferred
  // whole; IncomingInputs.closures' source. `path` (controller ruling, additive): the path the group waits for (INCOMING_WAITING,
  // HLD-53) — the writer's GroupResult.path, else the first path whose own reason is the group-level one (blockerOf).
  closures: Array<{ paths: string[]; reason: ClosureReason; path: string }>;
  notApplicableRules: Map<string, PortRule>;   // Task 6: the D7 rule of each `unmaterializable` path that one names (IncomingInputs.rules' source)
  incoming: IncomingCs[];                      // Task 6: this apply's incoming CSs (the trailers it read; IncomingInputs.csOf's source)
}

type NotApplicable = 'collision' | 'unmaterializable' | 'quarantine';
type WriteHow = 'clean' | 'concat' | 'take_tip';

const SPECIAL: ReadonlySet<string> = new Set(['120000', '160000']);
/** The most LA_C..TIP live commits read for the incoming change-sets in one apply (one rev-list call either way). */
const MAX_INCOMING = 100_000;

/** ∃ applicable p: A[p] ≠ TIP[p]; mutant M17: TIP ≠ LA_C. */
export function applyNeeded(core: EngineCore, it: IterationCtx): boolean {
  if (core.deps.testMutants.has('M17')) return core.view !== null && it.tip !== core.view.laC;
  return applicableDifference(core, it);
}

/** Why an iteration's apply is not admitted (ApplyAdmission.skipped); a kept push intent is applyStep's own reason, read live. */
export type AdmissionSkip = 'frozen' | 'lease' | 'txn' | 'snapshot_failed' | 'nothing' | 'stranded' | 'coalesced';

/**
 * Ruling R3-EF4-26 (delta review C2; final review F11's rule at the apply; 01-engine §3.5 step 3 materializes "only when this iteration
 * … applies (step 5 admitted)"): the apply admission of one iteration, decided once — by prepareIteration, which materializes for an
 * admitted apply before detectStep runs — and kept on IterationCtx.admission. `now` is the instant of that decision: the 10 s
 * coalescing is judged at it and never again at a later clock reading, so an iteration judged coalesced at its prepare is coalesced at
 * its applyStep too, and a loop apply never materializes after detectStep (whose revertStep is the only judge of the deltas a
 * materialization moves into the private index, HLD-27/HLD-28). Only a context prepared without a materialization (join's first apply,
 * R3-59) has applyStep materialize.
 */
export interface ApplyAdmission { readonly now: number; readonly skipped: AdmissionSkip | null; }

/** The apply admission of `it` at `now` (ENG-17, ENG-30, CCI-50; glossary §20 apply coalescing): prepareIteration's one decision. */
export function applyAdmission(core: EngineCore, it: IterationCtx, now: number): ApplyAdmission {
  return { now, skipped: admissionSkip(core, it, now) };
}

function admissionSkip(core: EngineCore, it: IterationCtx, now: number): AdmissionSkip | null {
  if (it.freeze.length > 0) return 'frozen';
  if (it.leaseIdleMs >= LEASE_STOP_SYNC_MS) return 'lease';
  // Plan 5 Task 8 (06 §3.7.3) with F2 #59 (ruling R-T8B-1): a TXN open at the prepare or now keeps the apply out, named as such.
  if (it.txnOpen || core.deps.claude.txnOpen()) return 'txn';
  if (it.tick === null || it.tick.failed) return 'snapshot_failed';
  if (!applyNeeded(core, it)) return 'nothing';
  // P2-STRANDED / P2-NARROW: while a rollback restore is stranded no new intent is journaled (its kept intent is the only durable name
  // of the .old); read live, so a writeLocal that just returned LOCKED/DEFERRED counts too. Before the coalesce stamp: a gated apply
  // does not use the 10 s window.
  if (core.writer.strandedPaths().length > 0) return 'stranded';
  // At most 1 apply per 10 s per worktree (glossary §20); mutant M39 (Plan 3 Task 6, R3-50): no apply coalescing.
  if (!core.deps.testMutants.has('M39') && core.lastApplyMono !== null && now - core.lastApplyMono < APPLY_COALESCE_MS) return 'coalesced';
  return null;
}

function emptyReport(skipped: ApplyReport['skipped']): ApplyReport {
  return {
    ran: false, skipped, written: [], deleted: [], deferred: new Map(), notApplicable: new Map(), records: [], cancelled: [], changedA: [],
    closures: [], notApplicableRules: new Map(), incoming: [],
  };
}

/** A per-loop snapshot exclusion as a defer reason (01-engine §3.11 table: unreadable / unstable / filter_failure). */
function deferFor(e: Exclusion): DeferReason {
  switch (e) {
    case 'unreadable':
      return 'unreadable';
    case 'filter_failure':
      return 'filter_failure';
    default:
      return 'unstable';   // unstable, shrink, deletion_pending, quiet: the bytes on disk are not settled
  }
}

function isSpecial(e: TreeEntry | undefined): boolean {
  return e !== undefined && SPECIAL.has(e.mode);
}

/**
 * meta.pending (R-05): every deferred or not-applicable path whose A still differs from TIP, with its reason; stageable
 * keys only (`a:b.txt` cannot be a meta key: such a path is carried and listed in not_converged by the carry set).
 * Built by Object.fromEntries, which defines every key as an own property: an assignment `pending[p] = why` would call
 * the prototype setter for a path named `__proto__` and drop it (group FC's LEFT item). A plain object, like the one
 * parseMeta returns (JSON.parse also makes `__proto__` an own key), so a built and a parsed meta compare alike.
 */
function pendingOf(rows: Iterable<readonly [string, DeferReason]>, A: TreeMap, TIP: TreeMap): Record<string, DeferReason> {
  const pending = new Map<string, DeferReason>();
  for (const [p, why] of rows) {
    if (sameEntry(A.get(p), TIP.get(p))) continue;
    if (stageable(p)) pending.set(p, why);
  }
  return Object.fromEntries(pending);
}

/**
 * The same pending map, whatever the key order (a parsed meta and a freshly built map may order keys differently). Own
 * keys only on both sides (a `__proto__` path is an own key of a parsed meta and of pendingOf's map).
 */
function samePending(a: Readonly<Record<string, DeferReason>>, b: Readonly<Record<string, DeferReason>>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && b[k] === a[k]);
}

/**
 * Final review FB-5: the ids, sorted, of every non-terminal PATCH CONFLICTED ON_DISK record with a `conflict` guard whose
 * paths are exactly [p] (a K4 displacement of p: publish- or apply-side, R-02). Shared with the restart. EF4 round 2 K-2 (ruling
 * R3-EF4-15; HLD-08 "the K4 local side, once ENG- verified the TIP write"): a PIN too — HLD-07 attaches a K4 to an ON_DISK PIN of the
 * same path set (R3-EF4-7's markers PIN included), which is then that displacement; left out, it stayed ON_DISK withholding p whole
 * after the write, and the restart decision counted the write `clean` for HLD-41 instead of `take_tip`.
 */
export function onDiskConflictRecords(core: EngineCore, p: string): string[] {
  return core.holds.nonTerminal()
    .filter((r) => (r.kind === 'PATCH' || r.kind === 'PIN') && r.state === 'CONFLICTED' && r.residence === 'ON_DISK' && !isTerminal(r)
      && r.guards.some((g) => guardName(g) === 'conflict') && r.paths.length === 1 && r.paths[0] === p)
    .map((r) => r.id)
    .sort();
}

/** The same ready pairs (cs_id, R, A_cap), in order. */
function sameReady(a: readonly ReadyPair[], b: readonly ReadyPair[]): boolean {
  return a.length === b.length && a.every((x, i) => x.csId === b[i]!.csId && x.R === b[i]!.R && x.A === b[i]!.A);
}

/**
 * The incoming change-sets of HLD-53's closure range (base, TIP], base from incomingBase: each live commit's Cowork-CS trailers with
 * their Cowork-CS-Paths lists; a change-set without a list (count-only form) and a commit without Cowork-CS are one change-set of
 * paths(diff(first parent, commit)) (HLD-37). One rev-list for the messages; one diff-tree per commit lacking lists. Plan 3 Task 18: the
 * same messages also give each commit's Cowork-Writer (null when missing, repeated or malformed), the flow's `{name}` source.
 *
 * `cs` is the range (R3-EF4-4, the Task 6 ruling): every CS of (LA_C, TIP], and below it — LA_C itself included, its CSs landed at an
 * earlier apply — only the CSs of a commit in `chain` (one that changed a still-deferred path after the commit that gave it its A blob).
 * An older commit that changed no deferred path never links paths (a start/join capture CS declaring every live path would otherwise tie
 * independent closures into one write group). The walk is first-parent and newest first, so "below" starts at the record of LA_C: no
 * second git call. LA_C lies on TIP's first-parent chain (each live commit's first parent is the previous live tip); a walk that never
 * meets it (base == LA_C, or a recover rewrote the chain) filters nothing — the wider range, never a split CS. `all` is the unfiltered
 * list (base, TIP], newest first: keepIncomingWriters' source (the F14 `{name}` is the writer of the newest commit changing p, whatever
 * closure p is in).
 */
async function incomingChangeSets(
  repo: GitRepo, base: Oid, tip: Oid, laC: Oid, chain: ReadonlySet<Oid>,
): Promise<{ cs: IncomingCs[]; all: IncomingCs[]; writers: Map<Oid, WriterId | null> }> {
  const writers = new Map<Oid, WriterId | null>();
  if (base === tip) return { cs: [], all: [], writers };
  const r = await repo.run(['rev-list', '--first-parent', '--no-commit-header', `--max-count=${MAX_INCOMING}`, '--format=%x00%H%n%P%n%B', tip, `^${base}`]);
  const out: IncomingCs[] = [];
  const all: IncomingCs[] = [];
  let below = false;
  for (const record of r.stdout.toString('utf8').split('\0').slice(1)) {
    const nl1 = record.indexOf('\n');
    const nl2 = nl1 < 0 ? -1 : record.indexOf('\n', nl1 + 1);
    if (nl2 < 0) throw new Error(`apply: unexpected rev-list record ${JSON.stringify(record.slice(0, 120))}`);
    const commit = parseOid(record.slice(0, nl1));
    if (commit === laC) below = true;
    const counts = !below || chain.has(commit);
    const parent = record.slice(nl1 + 1, nl2).split(' ').filter((x) => x.length > 0)[0] ?? null;
    const trailers = parseMessage(record.slice(nl2 + 1)).trailers;
    const named = trailers.filter((t) => t.key === 'Cowork-Writer');
    writers.set(commit, named.length === 1 ? parseWriter(named[0]!.value) : null);
    const { cs, paths } = parseCsTrailers(trailers);
    let diff: string[] | null = null;
    const whole = async (): Promise<string[]> => (diff ??= await changedPaths(repo, parent === null ? null : parseOid(parent), commit));
    const push = (c: IncomingCs): void => {
      all.push(c);
      if (counts) out.push(c);
    };
    if (cs.length === 0) {
      push({ commit, csId: `commit:${commit}`, paths: await whole() });
      continue;
    }
    for (const c of cs) push({ commit, csId: c.csId, paths: paths.get(c.csId) ?? (await whole()) });
  }
  return { cs: out, all, writers };
}

/**
 * Plan 3 Task 18 (rev 2.5, F14; 10-product §3.5.1 `{name}`): per path the incoming change-sets name, the writer of the NEWEST commit
 * changing it (`incoming` lists the newest commit first) with that peer's display name in the fold now (the peer id when the fold names
 * none) and TIP[p] — null for a path whose newest commit carries no valid Cowork-Writer (an older commit's writer never stands in, nor
 * a writer kept from an earlier read: keepIncomingWriters drops it, audit #25).
 */
function incomingWritersOf(core: EngineCore, incoming: readonly IncomingCs[], writers: ReadonlyMap<Oid, WriterId | null>, TIP: TreeMap): Map<string, IncomingWriter | null> {
  const out = new Map<string, IncomingWriter | null>();
  for (const c of incoming) {
    const w = writers.get(c.commit) ?? null;
    for (const p of c.paths) {
      if (out.has(p)) continue;
      out.set(p, w === null ? null : { writer: w.peer, name: core.displayName(w.peer) ?? w.peer, blob: TIP.get(p)?.oid ?? ABSENT });
    }
  }
  return out;
}

/**
 * HLD-53 (Plan 3 Task 6): the path a deferred write group waits for — the first (sorted) path whose own reason is the group-level
 * reason, else the first with any own reason but `closure`, else the first path.
 */
function blockerOf(paths: readonly string[], own: (p: string) => DeferReason | undefined, reason: ClosureReason): string {
  const sorted = [...paths].sort();
  return sorted.find((p) => own(p) === reason) ?? sorted.find((p) => (own(p) ?? 'closure') !== 'closure') ?? sorted[0]!;
}

/** The not-applicable reasons of meta.pending (R-05, P2-QUARANTINE-IN): such a path is in no write group. */
const NOT_APPLICABLE_PENDING: ReadonlySet<string> = new Set(['collision', 'unmaterializable', 'quarantine']);

/** Per core: the last incomingBase answer by (tip, LA_C, the window's bound, the pending deferred (path, A blob) set). */
const baseMemo = new WeakMap<EngineCore, { key: string; range: IncomingRange }>();

/** HLD-53's closure range: the exclusive start `base` of the walk, and `chain`, the commits below LA_C whose CSs count (incomingChangeSets). */
interface IncomingRange { base: Oid; chain: ReadonlySet<Oid>; }

/**
 * Plan 3 Task 6, HLD-53 across applies (controller ruling, fix round 1, and R3-EF4-4: the closure range is (LA_C, TIP] plus the CSs of
 * the commits that changed a still-deferred path since the commit that gave it its A blob — its first-parent chain, bounded by
 * CHAIN_WINDOW; the SIM oracle's checkApply carry keeps the same CSs by the paths their commits changed): the exclusive start of the
 * walk whose live commits give the incoming change-sets, and the chain commits whose CSs count below LA_C. An apply moves LA_C to TIP
 * while a deferred path keeps A[p] (ENG-36, R-05), so (LA_C, TIP] no longer holds the CS that ties it to its closure: the next apply
 * would split that CS (INV-GROUP). For every meta.pending path deferred (not a not-applicable one) whose A still differs from TIP, the
 * walk reaches back to the commit that gave p A's blob (its chain's stop, excluded: it set A[p], its CS is not incoming; a chain with no
 * stop inside the window reaches back to its oldest commit's first parent; a path no commit of the window changed adds nothing); the
 * start is the oldest of those, kept when it is an ancestor of LA_C. `chain` is the union of those chains' commits (PathChain.commits):
 * a commit between the start and LA_C that changed no deferred path since its A blob — a CS that landed whole at an earlier apply, this
 * peer's own publish — links nothing (HLD-53 "A closure never blocks other closures"). ONE walk for every path (pathChains, cached by
 * its inputs) and at most one isAncestor, the answer cached per core: a deferral that lasts hours costs no git process per path and
 * per apply. Older CSs link only paths of this apply's universe (writeGroups), so paths applied since add nothing.
 *
 * EF4 round 2 K-4 (ruling R3-EF4-16): an FB-6 deferral (a path whose whole-path edit git could not index, deferred in its write group) is
 * listed in meta.pending under the not-applicable reason string 'unmaterializable', yet it is still deferred: its row joins the walk's
 * wants for `chain` only, never for the base (a CS below LA_C that changed it keeps counting while another deferred path's stop reaches
 * it; with no other deferred row the range is (LA_C, TIP] as before). A row is read as an FB-6 deferral when this apply does not find its
 * path not applicable (`notApplicableNow`, decided before this call): a path not applicable here (DAT-33, guard `unmaterializable`) is
 * in no write group and HLD-53 never lets it hold its CS, as the SIM oracle's carry (group paths only) — the wider reading, every
 * 'unmaterializable' row, would let a start/join capture CS (R ∪ A) that created such a path tie every closure into one.
 */
async function incomingBase(
  core: EngineCore, pending: Readonly<Record<string, DeferReason>>, laC: Oid, A: TreeMap, TIP: TreeMap, tip: Oid, notApplicableNow: ReadonlyMap<string, NotApplicable>,
): Promise<IncomingRange> {
  const wants = new Map<string, Oid | null>();
  const fb6 = new Map<string, Oid | null>();   // K-4: FB-6 deferrals, chain wants only
  for (const [p, why] of Object.entries(pending)) {
    if (sameEntry(A.get(p), TIP.get(p))) continue;
    if (!NOT_APPLICABLE_PENDING.has(why)) wants.set(p, A.get(p)?.oid ?? null);
    else if (why === 'unmaterializable' && !notApplicableNow.has(p)) fb6.set(p, A.get(p)?.oid ?? null);
  }
  if (wants.size === 0) return { base: laC, chain: new Set() };
  const bound = await chainBound(core.repo, laC);
  const all = new Map([...fb6, ...wants]);
  const keyOf = (m: ReadonlyMap<string, Oid | null>): string[] => [...m].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([p, a]) => `${p}\u0000${a ?? ''}`);
  const key = [tip, laC, bound ?? '', ...keyOf(wants), '\u0001', ...keyOf(fb6)].join('\u0000');
  const hit = baseMemo.get(core);
  if (hit !== undefined && hit.key === key) return hit.range;
  const { chains, order } = await pathChains(core.repo, tip, all, bound);
  const changers = new Set<Oid>();
  for (const c of chains.values()) for (const x of c.commits) changers.add(x.commit);
  // The oldest start by listing order: a stop is a listed commit; a no-stop chain's start is just older than its oldest commit. Only the
  // deferred rows' chains (K-4: an FB-6 row's chain widens `chain`, never the base).
  let start: Oid | null = null;
  let rank = -1;
  for (const [p, chain] of chains) {
    if (!wants.has(p)) continue;
    const oldest = chain.commits[chain.commits.length - 1];
    const at = chain.stop !== null ? (order.get(chain.stop) ?? -1) : oldest !== undefined ? (order.get(oldest.commit) ?? -1) + 0.5 : -1;
    const s = chain.stop ?? oldest?.parents[0] ?? null;
    if (s !== null && at > rank) {
      start = s;
      rank = at;
    }
  }
  const base = start !== null && start !== laC && (await core.repo.isAncestor(start, laC)) ? start : laC;
  const range: IncomingRange = { base, chain: changers };
  baseMemo.set(core, { key, range });
  return range;
}

/** paths(diff(parent, commit)) by one diff-tree (no renames; a root commit lists every path). */
async function changedPaths(repo: GitRepo, parent: Oid | null, commit: Oid): Promise<string[]> {
  const args = parent === null
    ? ['diff-tree', '-r', '-z', '--name-only', '--no-renames', '--no-commit-id', '--root', commit]
    : ['diff-tree', '-r', '-z', '--name-only', '--no-renames', '--no-commit-id', parent, commit];
  return (await repo.run(args)).stdout.toString('utf8').split('\0').filter((s) => s.length > 0);
}

/**
 * R3-22 (Plan 3 Task 5): the displacement fields of a K4 record at its ON_DISK → OFF_DISK move after the verified TIP write —
 * displaced_by = the op id `<peer>/<epoch>/<seq>` of the Cowork-Writer trailer of the newest live commit up to `tip` that changed
 * p (first-parent chain, one `rev-list --max-count=1` with a literal pathspec: in (LA_C, TIP] whenever a commit there changed p,
 * otherwise the commit that set TIP[p], e.g. for a publish-side record whose own publish moved LA_C past the teammate's commit),
 * and peer_authors = [that writer's peer]. No field when no such commit exists or its trailer is missing or malformed. The one
 * helper of every K4 OFF_DISK move: the apply's (below), the restart decision's and settleHoldOps's (restart.ts, holdOps.ts).
 */
export async function k4Displacement(core: EngineCore, tip: Oid, path: string): Promise<Pick<HoldPatch, 'displaced_by' | 'peer_authors'>> {
  const r = await core.repo.run(['rev-list', '--first-parent', '--max-count=1', parseOid(tip), '--', path], { literalPathspecs: true });
  const line = r.stdout.toString('utf8').trim();
  if (line.length === 0) return {};
  const writers = (await core.repo.readCommit(parseOid(line))).trailers.filter((t) => t.key === 'Cowork-Writer');
  const w = writers.length === 1 ? parseWriter(writers[0]!.value) : null;
  return w === null ? {} : { displaced_by: formatWriter(w), peer_authors: [w.peer] };
}

/**
 * The patch of a K4 record's ON_DISK → OFF_DISK move after the verified TIP write (R-02, HLD-08): residence OFF_DISK and R3-22's
 * `displaced` fields; EF4 E4-1 (ruling R3-EF4-7): a record that carries `markers` (a K4 onto a markers record, below) also releases it
 * in that rev — the disk now holds bytes with no restore-marker row (DAT-46), the displaced marker file is in its marker companion
 * (05 §3.4 item 3, item 4 of the markers park), and R1 never re-evaluates an OFF_DISK record (HLD-08), so the guard would never release
 * otherwise. Used at every K4 OFF_DISK move: the apply's (below), the restart decision's and settleHoldOps' (restart.ts, holdOps.ts).
 * That premise is each caller's to check: the written bytes keep a row after a clean merge over a stale marker row, or when TIP's blob
 * holds one (R3-FF3-B3), so every caller first checks them and leaves a record carrying `markers` ON_DISK with it — never this patch —
 * while they hold a row (rulings R3-EF4-28, R3-EF4-31, R3-SPEC-3, R3-SPEC-6).
 */
export function k4OffDiskPatch(r: HoldRecord, displaced: Pick<HoldPatch, 'displaced_by' | 'peer_authors'>): HoldPatch {
  const markers = r.guards.some((g) => guardName(g) === 'markers');
  return { residence: 'OFF_DISK', ...displaced, ...(markers ? { guards: r.guards.filter((g) => guardName(g) !== 'markers') } : {}) };
}

/**
 * EF4 E4-1 (ruling R3-EF4-7): the ON_DISK record over exactly [p] that carries `markers` (a conflicted RESTORE's rows are on p's disk),
 * the K4 target of a TAKE_TIP on p in place of HLD-07's first ON_DISK record of that path set: a non-terminal PATCH or PIN, no marker
 * companion (a companion is never an attach target), no guard outside Table 3 (never transitioned here, HLD-05); the first in ULID order.
 */
function markersTargetOf(core: EngineCore, p: string): HoldRecord | undefined {
  return core.holds.nonTerminal()
    .filter((r) => r.residence === 'ON_DISK' && (r.kind === 'PATCH' || r.kind === 'PIN') && r.paths.length === 1 && r.paths[0] === p
      && r.guards.some((g) => guardName(g) === 'markers') && !r.guards.some(isUnknownGuard) && !core.holds.isCompanion(r.id))
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))[0];
}

/**
 * EF4 round 2 K-1 (ruling R3-EF4-15, R3-EF4-7 widened): whether a TAKE_TIP on p displaces a marker file — a non-terminal ON_DISK record
 * over p carries `markers` (any kind, any path count, any guards: a multi-path restored record, one carrying a guard outside Table 3, a
 * restored marker companion), or S_disk[p] holds a restore-marker row (DAT-46; e.g. a stale save of a buffer that held the rows after they
 * were resolved) — so the companion route applies and no record but a marker companion takes S_disk[p].
 */
async function displacesMarkers(core: EngineCore, p: string, sDisk: TreeEntry | undefined): Promise<boolean> {
  if (core.holds.nonTerminal().some((r) => r.residence === 'ON_DISK' && r.paths.includes(p) && r.guards.some((g) => guardName(g) === 'markers'))) return true;
  return sDisk !== undefined && isRegular(sDisk) && hasRestoreMarkerRow(await core.repo.readBlob(sDisk.oid));
}

/** A K4 stage pair at one path: the base side s1 and the local (held) side s2. */
interface StagePair { s1: Oid | typeof ABSENT; s2: Oid | typeof ABSENT }

/**
 * EF5 X2-1 (ruling R3-EF4-25, amending R3-EF4-7/15; delta review C1): the K4 stage pair at p that is record r's OWN change — never A[p]
 * beside a held side over r's older base. HLD-02/HLD-14 keep r's original pair, so once an apply moved A under r (the usual reason its
 * RESTORE conflicted) that mix is r's change plus the reverse of every teammate change between r's base and A, which a later RESTORE of the
 * K4 record (mf(D, s1, s2)) re-applied: the teammate rows left the disk, observed (HLD-26 (b)), so no revert record either. REBASE of r at
 * p onto A (05 §3.4 item 1 through the engine's cache; R3-18's whole-path rule on a binary, filtered or ABSENT side): clean → (A[p],
 * H1'[p]); a conflict → r's own pair at p (its base, its held side), so a RESTORE of the K4 record conflicts where r's change does instead
 * of dropping teammate rows. A merge-file operator error (HoldOperatorError) also takes r's own pair: it is one record's change, and the
 * apply's records come before any write, where a throw would end the apply. Per path (r projected on [p]: a multi-path record's REBASE
 * conflict on another path does not move p's pair; the cache keys per path). A is the engine's current A — the apply's own (it.A) until
 * its state update. Undefined when r holds no base or no held side at p (a filter-failure record).
 */
async function ownStagePair(core: EngineCore, r: HoldRecord, p: string): Promise<StagePair | undefined> {
  const base = blobAt('h0' in r.blobs ? r.blobs.h0 : r.blobs.s1, p);
  const held = blobAt(heldSide(r), p);
  if (base === undefined || held === undefined) return undefined;
  const { A } = await currentA(core);
  const a = A.get(p)?.oid ?? ABSENT;
  if (base === a) return { s1: a, s2: held };   // r's REBASE at its own base is its pair (mf(A, A, H1) = H1; RebaseCache.converges' shortcut)
  try {
    const rb = await core.rebase.rebase({ ...r, paths: [p] }, A);
    if (rb.ok) return { s1: a, s2: blobAt(rb.h1p, p)! };
  } catch (e) {
    if (!(e instanceof HoldOperatorError)) throw e;
  }
  return { s1: base, s2: held };
}

/** A side of a stage pair that holds a restore-marker row (DAT-46); ABSENT holds none. */
async function markerBearing(core: EngineCore, o: Oid | typeof ABSENT): Promise<boolean> {
  return o !== ABSENT && hasRestoreMarkerRow(await core.repo.readBlob(o));
}

/**
 * EF4 round 2 K-1 (ruling R3-EF4-15), EF5 X2-1 (R3-EF4-25): the marker-free stage pair (s1, s2) of a K4 on p whose companion route has no
 * markersTargetOf target — one source record's own change at p (ownStagePair), never A[p] beside another record's held side. The source,
 * in order, is the first record whose held side at p has no restore-marker row (ABSENT, a local deletion, has none) of: the record HLD-07
 * attaches the K4 to (an ON_DISK PATCH or PIN over exactly [p], no marker companion, no guard outside Table 3 — R3-EF4-7's "r"); each
 * non-terminal ON_DISK record over p carrying `markers`, in ULID order — for a marker companion its parent (the companion's own held side
 * is a marker file); a source whose chosen pair carries a restore-marker row on its other side (an older leak in its base) is passed over.
 * None: (A[p], A[p]) — the K4 record then holds no change of its own and its marker companion keeps the whole displaced file. A record's
 * held side is never refreshed from disk while it carries `markers` (05 §3.4 item 3), so it is marker-free unless an older leak put rows in it.
 */
async function markerFreeSide(core: EngineCore, p: string, a: Oid | typeof ABSENT): Promise<StagePair> {
  const recs = core.holds.nonTerminal();
  const sources: HoldRecord[] = [];
  const target = recs.find((r) => r.residence === 'ON_DISK' && (r.kind === 'PATCH' || r.kind === 'PIN') && r.paths.length === 1 && r.paths[0] === p
    && !r.guards.some(isUnknownGuard) && !core.holds.isCompanion(r.id));
  if (target !== undefined) sources.push(target);
  const companions = core.holds.local().companions;
  for (const r of recs) {
    if (r.residence !== 'ON_DISK' || !r.paths.includes(p) || !r.guards.some((g) => guardName(g) === 'markers')) continue;
    const parent = Object.hasOwn(companions, r.id) ? core.holds.get(companions[r.id]!) : r;
    if (parent !== undefined) sources.push(parent);
  }
  for (const r of sources) {
    const o = blobAt(heldSide(r), p);
    if (o === undefined || (await markerBearing(core, o))) continue;
    const pair = await ownStagePair(core, r, p);
    if (pair === undefined) continue;
    if ((pair.s1 !== a && (await markerBearing(core, pair.s1))) || (pair.s2 !== o && (await markerBearing(core, pair.s2)))) continue;
    return pair;
  }
  return { s1: a, s2: a };
}

/**
 * EF4 round 2 K-1 (ruling R3-EF4-15): the K4 of a TAKE_TIP on p that displaces a marker file (displacesMarkers) with no markersTargetOf
 * target. First the K4 record through hold() — HLD-07 decides: the R-02 dedupe, the ON_DISK PATCH/PIN over [p], a converging record, or
 * a new record — with marker-free stages (markerFreeSide's pair — one source record's own change at p, EF5 X2-1 / R3-EF4-25 —, TIP[p]);
 * then, in a second registry commit, the local_only marker companion of that record keeping S_disk[p] over A[p] (markerCompanion). Both
 * before the write. In this order a kill between them leaves a K4 record with marker-free stages and the marker file still on disk (the
 * next apply's K4 dedupes onto it and makes the companion), never a companion whose parent does not mask p. Returns the K4 record's id and
 * the companion's.
 */
async function k4OverMarkerFile(
  core: EngineCore, p: string, stages: { s1: Oid | typeof ABSENT; s2: Oid | typeof ABSENT; s3: Oid | typeof ABSENT }, csIds: readonly string[],
): Promise<{ id: string; companion: string }> {
  const own = await markerFreeSide(core, p, stages.s1);
  const id = await core.holds.hold({
    kind: 'PATCH', residence: 'ON_DISK', state: 'CONFLICTED', paths: [p], blobs: { s1: { [p]: own.s1 }, s2: { [p]: own.s2 }, s3: { [p]: stages.s3 } },
    guard: 'conflict', origin: 'daemon', cs_ids: [...csIds], displaced_by: null,
  });
  const k = core.holds.get(id)!;
  return { id, companion: await markerCompanion(core, k, p, stages.s1, stages.s2) };
}

/**
 * The local_only marker companion of K4 record r over [p] (05 §3.4 item 3's shape: PATCH, h0 = A[p], h1 = the displaced marker file, born
 * OFF_DISK PARKED, no guard, origin r.origin, companionOf r) in one registry commit; K-3: a live companion of r with these blobs already
 * (a retry after a writer rejection whose rollback could not be observed) is reused, never doubled. Its id.
 */
async function markerCompanion(core: EngineCore, r: HoldRecord, p: string, a: Oid | typeof ABSENT, file: Oid | typeof ABSENT): Promise<string> {
  const same = reusableCompanion(core, r.id, p, a, file);
  if (same !== undefined) return same;
  const { created } = await core.holds.commitMany([companionBirth(r, p, a, file)], []);
  return created[0]!;
}

/**
 * EF4 round 2 K-3: a non-terminal OFF_DISK PARKED guard-less marker companion of `parent` over exactly [p] holding pair(a, file), if any.
 * `a` is A[p] — a companion's h0 (05 §3.4 item 3) — never the parent's stage s1, which since EF5 X2-1 (R3-EF4-25) is r's own base when
 * its REBASE onto A conflicts.
 */
function reusableCompanion(core: EngineCore, parent: string, p: string, a: Oid | typeof ABSENT, file: Oid | typeof ABSENT): string | undefined {
  return core.holds.companionsOf(parent).find((c) => !isTerminal(c) && c.residence === 'OFF_DISK' && c.state === 'PARKED' && c.guards.length === 0
    && c.paths.length === 1 && c.paths[0] === p && 'h1' in c.blobs && blobAt(c.blobs.h0, p) === a && blobAt(c.blobs.h1, p) === file)?.id;
}

/**
 * EF4 round 2 K-3 (ruling R3-EF4-15, R3-15's pattern): after an in-process rollback of a rejected applyGroups, each marker companion this
 * apply committed (`companionAt`, p → id) whose h1 the disk DISK_EQ again is a redundant copy of bytes still on disk and ends GONE; one the
 * disk does not hold (a stranded rollback) is kept.
 */
async function endRedundantCompanions(core: EngineCore, companionAt: ReadonlyMap<string, string>, S: TreeMap): Promise<void> {
  for (const [p, id] of [...companionAt].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
    const c = core.holds.get(id);
    if (c === undefined || isTerminal(c) || !('h1' in c.blobs)) continue;
    const h1 = blobAt(c.blobs.h1, p);
    if (h1 === undefined) continue;
    const want = h1 === ABSENT ? ABSENT : { path: p, mode: S.get(p)?.mode ?? '100644', oid: h1 };
    if ((await core.diskEq.eq(p, want, null)).equal) await core.holds.transition(id, { state: 'GONE' });
  }
}

/** The NewRecord of a marker companion of r over [p] (05 §3.4 item 3). */
function companionBirth(r: HoldRecord, p: string, a: Oid | typeof ABSENT, file: Oid | typeof ABSENT): NewRecord {
  return {
    kind: 'PATCH', residence: 'OFF_DISK', state: 'PARKED', paths: [p], blobs: { h0: { [p]: a }, h1: { [p]: file } },
    guard: null, origin: r.origin, cs_ids: [], displaced_by: null, companionOf: r.id,
  };
}

/**
 * EF4 E4-1 (ruling R3-EF4-7; 05-holds §3.4 items 3–4, 03-data line 319, DAT-46; contract "record before displacement"): the K4 of an
 * apply TAKE_TIP on p onto r, an ON_DISK record carrying `markers` (markersTargetOf). r is never refreshed from disk — that would copy
 * restore-marker rows into a held/ blob, which ENG-41 (j) then refuses in every window, so the peer never publishes again. In ONE
 * registry commit (before any write, as every K4 record):
 *   - the local_only marker companion r′ (05 §3.4 item 3's shape: PATCH over [p], h0 = A[p], h1 = S_disk[p] — the marker file the TIP
 *     write removes, byte-exact —, born OFF_DISK PARKED, no guard, origin r.origin, companionOf r): the displaced bytes stay on this PC
 *     and are mirrored only as a content-free stub;
 *   - r goes CONFLICTED with `conflict` added and marker-free stages — r's own change at p (EF5 X2-1, ruling R3-EF4-25, ownStagePair:
 *     (A[p], REBASE(r onto A)) when that REBASE is clean, else r's own (base, held side) at p; the restorable change r already
 *     mirrored, never A[p] beside a held side over r's older base) —, TIP[p] — and the ready CSs over p in its cs_ids; s3 = TIP[p] keeps
 *     the restart's K4 completion (DISK_EQ s3, A[p] = s3) working. r always holds a held side at p (a restored record); were it missing,
 *     the stages would be (A[p], A[p]): no change of r's own, the companion keeping the whole displaced file.
 * After the verified TIP write r goes OFF_DISK and `markers` releases (k4OffDiskPatch), unless the written bytes keep a restore-marker row
 * (TIP's blob holds one, R3-FF3-B3): r then stays ON_DISK with `markers` (never unmasked), at the apply and at every restart (rulings
 * R3-SPEC-3, R3-SPEC-6), and the companion stays live beside it; when the write does not happen the companion is
 * redundant (its bytes are still on r's disk) and ends GONE, in this run (applyStep) or at restart (settleHoldOps, which matches it by
 * its h0 == A[p], not by r's s1), R3-15's pattern. A patch that changes nothing (a repeat after a deferred write: r's stage pair is then
 * its own pair, so ownStagePair returns it unchanged) is left out. Returns the companion's id.
 */
async function k4OntoMarkers(
  core: EngineCore, r: HoldRecord, p: string, stages: { s1: Oid | typeof ABSENT; s2: Oid | typeof ABSENT; s3: Oid | typeof ABSENT }, csIds: readonly string[],
): Promise<string> {
  const own = (await ownStagePair(core, r, p)) ?? { s1: stages.s1, s2: stages.s1 };
  const blobs = { s1: { [p]: own.s1 }, s2: { [p]: own.s2 }, s3: { [p]: stages.s3 } };
  const same = 's1' in r.blobs && blobAt(r.blobs.s1, p) === own.s1 && blobAt(r.blobs.s2, p) === own.s2 && blobAt(r.blobs.s3, p) === stages.s3;
  const patch: HoldPatch = {
    ...(r.state === 'CONFLICTED' ? {} : { state: 'CONFLICTED' as const }),
    ...(same ? {} : { blobs }),
    ...(r.guards.some((g) => guardName(g) === 'conflict') ? {} : { guards: [...r.guards, makeGuard('conflict')] }),
    ...(csIds.every((c) => r.cs_ids.includes(c)) ? {} : { cs_ids: [...new Set([...r.cs_ids, ...csIds])].sort() }),
  };
  // K-3: a live companion of r already holding this marker file over A[p] (a retry after an unobserved rollback) is reused — the
  // companion's pair (A[p] = the conflict function's s1, S_disk[p]), whatever r's stage pair is.
  const reuse = reusableCompanion(core, r.id, p, stages.s1, stages.s2);
  if (reuse !== undefined) {
    if (Object.keys(patch).length > 0) await core.holds.transition(r.id, patch);
    return reuse;
  }
  const { created } = await core.holds.commitMany([companionBirth(r, p, stages.s1, stages.s2)], Object.keys(patch).length > 0 ? [{ id: r.id, patch }] : []);
  return created[0]!;
}

/** Admission, M_disk = merge-tree --merge-base=A S_disk TIP, rename carry, conflict routing (records before any write), not-applicable paths, defer set, write groups, intent J + crashpoint('apply.intent'), Writer.applyGroups, the ENG-36 state update (A, LA_C := TIP, LA_B := T, snap, pending, HLD-41 rebased pairs, intent cleared) + crashpoint('apply.state'), trace A_set. */
export async function applyStep(core: EngineCore, it: IterationCtx): Promise<ApplyReport> {
  const view0 = core.view;
  if (view0 === null) throw new Error('applyStep: no state');
  if (it.T === ABSENT) throw new Error('applyStep: no board tip (the incident branch never applies)');
  const T = it.T;
  const { clock, fs } = core.deps.ports;
  const { repo, deps } = core;
  const peer = core.peerId;

  // ---- admission (ENG-17, ENG-30, CCI-50) ----
  // R3-EF4-26: prepareIteration's decision (applyAdmission) — only such a context reaches an apply.
  const adm = it.admission;
  if (adm === undefined) throw new TypeError('applyStep: the iteration context carries no apply admission (prepareIteration decides it, R3-EF4-26)');
  // Ruling P2-PUSHINTENT-FIRST: a kept push intent is the only record of a push that may have landed; an apply intent
  // journaled over it would lose it. Not admitted (no journal write, the 10 s window unused) until resolvePushIntent ran.
  if (view0.intent.kind === 'push') return emptyReport('push_intent_pending');
  // Plan 5 Task 8 (06 §3.7.5): a TXN open at the prepare, or one that opened after the prepare's tick, keeps the apply
  // out — nothing journaled, the 10 s window unused; the next iteration (a tick of its own) applies. F2 #59 (R-T8B-1):
  // the reason is 'txn'. A group-level race (a TXN opened after this check, between J and a group's P1) is the writer's
  // P1 re-check.
  if (it.txnOpen || deps.claude.txnOpen()) return emptyReport('txn');
  if (it.tick === null || it.tick.failed) return emptyReport('snapshot_failed');
  // The decision binds; the same checks at the decision's instant may only narrow it (a restore that a writeLocal since the prepare
  // stranded, a trigger a resolved push intent or a hold step emptied), never admit what the prepare did not.
  const skipped = admissionSkip(core, it, adm.now) ?? adm.skipped;
  if (skipped !== null) return emptyReport(skipped);
  // The coalescing stamp is the apply's own instant (≥ the decision's): ≤ 1 apply per 10 s by apply time (glossary §20).
  core.lastApplyMono = clock.monoMs();
  // A context prepared without a materialization and admitted (join's first apply, R3-59: its journal is empty at TIP, no detection
  // step ran on it): the apply materializes for itself. A loop iteration's admitted apply always has prepare's ('auto') materialization.
  if (it.mat === null) {
    it.mat = await core.snapshot.materialize(tickInputOf(core, it));
    await ensureAttrs(core, it.epochBase, it.mat.sDiskMap.keys());
  }
  const mat = it.mat;
  const { aTree } = await currentA(core);
  const A = it.A;
  const S = mat.sDiskMap;
  const TIP = it.tipMap;
  const { tree: tipTree } = await liveCodeOf(core, T);

  // ---- the incoming form check (DAT-11, Plan 3 Task 6, R3-32): before the merge, decided on (A, TIP) ----
  const violations = await formCheckIncoming(repo, view0.laC, it.tip, A, TIP, (p) => pathIsText(core, p) && !pathIsFiltered(core, p));
  for (const v of violations) deps.trace.emit({ kind: 'form_violation', peer, path: v.path, commit: v.commit });

  // ---- M_disk (ENG-29, INV-BASE) ----
  let merged;
  try {
    merged = await mergeTree(repo, aTree, mat.sDisk, tipTree);
  } catch (e) {
    if (!(e instanceof MergeFailedError)) throw e;
    deps.log.write('error', 'APPLY_MERGE_FAILED', { code: e.code });
    return emptyReport('merge_failed');
  }
  deps.trace.emit({
    kind: 'merge', peer, use: 'apply', base: aTree, ours: mat.sDisk, theirs: tipTree, aTree, laC: view0.laC, laB: view0.laB, tip: it.tip, t: T, rc: merged.rc,
  });
  const R = await repo.readTreeMap(merged.tree);
  const M = new Map<string, TreeEntry>(R);
  const all = new Set<string>([...A.keys(), ...S.keys(), ...TIP.keys(), ...R.keys()]);
  const how = new Map<string, WriteHow>();
  const takeTip = new Map<string, { s1: Oid | typeof ABSENT; s2: Oid | typeof ABSENT; s3: Oid | typeof ABSENT }>();
  const deferred = new Map<string, DeferReason>();
  const notApplicable = new Map<string, NotApplicable>();
  const replace = (p: string, e: TreeEntry | undefined): void => {
    if (e === undefined) M.delete(p);
    else M.set(p, { path: p, mode: e.mode, oid: e.oid });
  };

  // Rename carry (01-engine §3.10): q kept by ours (ours[q] == A[q]) whose result is not theirs[q] takes theirs[q];
  // a source p changed by ours, absent in theirs and in the result goes to the conflict function as a rename unit.
  const carriedTo = new Set<string>();
  const sources: string[] = [];
  for (const p of all) {
    if (!editable(p)) continue;
    const a = A.get(p);
    const o = S.get(p);
    const t = TIP.get(p);
    const res = R.get(p);
    if (sameEntry(o, a) && !sameEntry(res, t)) {
      replace(p, t);
      carriedTo.add(p);
    } else if (o !== undefined && !sameEntry(o, a) && t === undefined && res === undefined) {
      sources.push(p);
    }
  }

  // The conflict function (D8 steps 0, 0a, 1–3, 5; D9) on the sources and the rc-1 conflicted paths.
  const fold = it.fold;
  const concatAllowed = liveSet(fold).every((p) => fold.peers[p]?.regionSpec === deps.regionSpec);
  let epochMap: TreeMap | null = null;
  const localOnlyPaths = localOnlyScope(core).paths;   // R3-21: non-terminal ON_DISK local_only records only
  const ctx: ConflictCtx = {
    repo,
    isText: (p) => pathIsText(core, p),
    insertionMerge: (p) => core.config.merge.insertionMerge.some((g) => wildmatch(g, p)),
    concatAllowed,
    localOnly: (p) => localOnlyPaths.has(p),
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
  // Plan 5 Task 8 (01 §3.11 defer table, BL2-04; plan note: chosen by the engine, not by DeferSet): a conflict-routed
  // path whose row the defer set holds keeps the seat's local side — the take-TIP displacement is refused as
  // conflicted_leased (row 7), a CONCAT write as the lease's own row-1 reason, another verdict keeps its own (nothing
  // of it is written anyway). After the release the same check re-merges the path (the local side stays). A TXN needs
  // no row here (no iteration runs a tick while one is open).
  const leaseRows = deps.claude.deferred();
  const route = async (p: string, v: ConflictVerdict): Promise<void> => {
    const leased = leaseRows.get(p);
    if (leased !== undefined) {
      replace(p, S.get(p));   // the local side stays; nothing of the seat's is displaced while it holds p
      deferred.set(p, v.kind === 'TAKE_TIP' ? 'conflicted_leased' : v.kind === 'CONCAT' ? leased : v.reason);
      return;
    }
    if (v.kind === 'CONCAT') {
      const mode = S.get(p)?.mode ?? TIP.get(p)?.mode ?? '100644';
      M.set(p, { path: p, mode, oid: v.blob });
      how.set(p, 'concat');
    } else if (v.kind === 'TAKE_TIP') {
      replace(p, v.entry === ABSENT ? undefined : TIP.get(p));
      takeTip.set(p, v.stages);
      how.set(p, 'take_tip');
    } else {
      replace(p, S.get(p));   // the local side stays; nothing is written
      deferred.set(p, v.reason);
    }
  };
  // P2-QUARANTINE-IN: an incoming change to a QUARANTINED path (glossary §16, S8) is never written live, whatever the
  // merge says: not applicable 'quarantine', A keeps its entry, the local side stays (no conflict record either).
  await ensureAttrs(core, it.epochBase, all);
  const quarantined = (p: string): boolean => editable(p) && it.scope(p).cls === 'QUARANTINED';
  const keepLocal = (p: string): void => {
    replace(p, S.get(p));
    notApplicable.set(p, 'quarantine');
  };
  for (const p of sources) {
    if (quarantined(p)) {
      keepLocal(p);
      continue;
    }
    await route(p, await conflict(ctx, p, A.get(p)?.oid ?? ABSENT, S.get(p)!.oid, ABSENT, 'other'));
  }
  const handled = new Set<string>([...carriedTo, ...sources]);
  for (const p of merged.conflicted) {
    if (handled.has(p)) continue;
    if (!editable(p)) {
      notApplicable.set(p, 'unmaterializable');   // never named in a tree edit or on disk (P2-CARRY)
      continue;
    }
    if (quarantined(p)) {
      keepLocal(p);
      continue;
    }
    const a = A.get(p);
    const o = S.get(p);
    const t = TIP.get(p);
    const content = isRegular(a) && isRegular(o) && isRegular(t) && a.mode === o.mode && o.mode === t.mode;
    const unit: UnitKind = content ? 'content' : 'other';
    await route(p, await conflict(ctx, p, a?.oid ?? ABSENT, o?.oid ?? ABSENT, t?.oid ?? ABSENT, unit));
  }
  // DAT-11 (Plan 3 Task 6): a path whose incoming form violates is not applied; the local side stays and its write group defers at
  // once (`eol_form`; HLD-54's record comes at 60 s). A quarantined or UNMANAGED path is never written anyway (no deferral).
  for (const v of violations) {
    const p = v.path;
    if (!editable(p) || quarantined(p) || it.scope(p).cls === 'UNMANAGED') continue;
    replace(p, S.get(p));
    how.delete(p);
    takeTip.delete(p);
    deferred.set(p, 'eol_form');
  }
  // Under a file (group FC's LEFT item, the apply-side twin of its publish-side fix): a path the local side changed, absent
  // in TIP, beneath a path that is a file in M_disk (a teammate made `d` a file while this peer added `d/x`; the carry put
  // TIP's `d` back over merge-tree's `d~<theirs>`). One tree cannot hold both: the index's --replace would drop p from t/M
  // without a word. TIP keeps its file and p is displaced like any TAKE_TIP — a K4 record (stages A[p], S_disk[p], ABSENT)
  // committed before the writer moves the local file away; `d` itself is written once the emptied directory is gone (its
  // collision clears, P2-NA-TRIGGER). A deferred or not-applicable p keeps its local side and is never written. A ready
  // pair carrying p is cancelled with it (HLD-41's take_tip verdict, below in C), as for any TAKE_TIP.
  const underFile = new Set<string>();
  for (const p of [...M.keys()].sort()) {
    const o = S.get(p);
    if (!editable(p) || takeTip.has(p) || deferred.has(p) || notApplicable.has(p) || o === undefined || sameEntry(o, A.get(p)) || TIP.has(p)) continue;
    const parts = p.split('/');
    if (!parts.slice(1).some((_, i) => M.has(parts.slice(0, i + 1).join('/')))) continue;
    replace(p, undefined);
    takeTip.set(p, { s1: A.get(p)?.oid ?? ABSENT, s2: o.oid, s3: ABSENT });
    how.set(p, 'take_tip');
    underFile.add(p);
  }
  const mIndex = core.scratch('a');   // the apply's scratch index; R-15 code tree by whole-path replacement
  const mEdits: IndexEdit[] = [];
  for (const p of new Set([...R.keys(), ...M.keys()])) {
    const before = R.get(p);
    const after = M.get(p);
    if (sameEntry(before, after)) continue;
    mEdits.push(after === undefined ? { path: p, remove: true } : { path: p, mode: after.mode, oid: after.oid });
  }
  // Final review FB-6: git for Windows refuses a root drive-prefix name (`a:b.txt`, from TIP) in any index, so the
  // whole-path edits cannot be made over a merged tree holding one. Then t/M is the merged tree itself and every edited
  // path that would be written is deferred 'unmaterializable' below (never in a group, so no write target and no
  // restart target is ever one of its marker blobs; listed in meta.pending and not_converged); the clean paths of this
  // apply proceed, and the deferred ones are re-merged at every apply until the name leaves TIP. RATIFIED (controller
  // ruling, FB fix round 2) as the one exception to "no marker blob reaches t/M": t/M is read only for journaled group
  // entries (restart.ts resolveWriteIntent; the in-process rollback below takes the groups' own targets). Cost if wrong:
  // a later reader of t/M must skip the deferred paths.
  let mTree: Oid;
  let mRefused: ReadonlySet<string> = new Set();
  try {
    mTree = await editTreeIndexOnly(repo, fs, merged.tree, mEdits, mIndex);
  } catch (e) {
    if (!(e instanceof IndexRefusedPathError)) throw e;
    mTree = merged.tree;
    mRefused = new Set(mEdits.map((x) => x.path));
    deps.log.write('warn', 'APPLY_TREE_REFUSED', { refused: e.paths.length, deferred: mRefused.size });
  }

  // ---- W, UNMANAGED, not applicable, defer set ----
  const unmanaged = new Set<string>();
  // D5 row 1 (quarantine) precedes the special-mode rows: a quarantined symlink or gitlink is not applicable either.
  const isUnmanaged = (p: string): boolean => !quarantined(p)
    && (isSpecial(A.get(p)) || isSpecial(S.get(p)) || isSpecial(TIP.get(p)) || isSpecial(M.get(p)) || it.scope(p).cls === 'UNMANAGED');
  const changed = [...all].filter((p) => !sameEntry(A.get(p), TIP.get(p)));
  const W = [...all].filter((p) => !sameEntry(S.get(p), M.get(p))).sort();
  for (const p of [...changed, ...W]) if (editable(p) && isUnmanaged(p)) unmanaged.add(p);
  const carriedHere = (p: string): boolean => !stageable(p) || it.tick!.carried.has(p) || core.snapshot.isCarried(p);
  // R3-33 (Plan 3 Task 6): a creation whose target already exists here with TIP's bytes (DISK_EQ) is applicable with no write.
  const diskEqual = new Set<string>();
  const listings = new Map<string, readonly string[] | null>();
  for (const p of W) {
    if (unmanaged.has(p) || notApplicable.has(p)) continue;
    if (quarantined(p)) {
      notApplicable.set(p, 'quarantine');
      continue;
    }
    if (await unmaterializableHere(core, it, p)) {
      notApplicable.set(p, 'unmaterializable');
      continue;
    }
    if (S.get(p) === undefined && A.get(p) === undefined) {
      let st;
      try {
        st = await fs.lstat(join(deps.paths.workTree, ...p.split('/')));
      } catch {
        deferred.set(p, 'unreadable');
        continue;
      }
      if (st !== null) {
        // R3-33: A[p] := TIP[p] (disk_equal), the file untouched — only when the entry found is spelled exactly p: on a case-folding
        // volume lstat also finds a case variant (a case-only rename's old spelling, which this apply deletes), never p's own file.
        const t = TIP.get(p);
        if (t !== undefined && isRegular(t) && (await spelledExactly(core, p, listings)) && (await core.diskEq.eq(p, t, null)).equal) {
          diskEqual.add(p);
          continue;
        }
        notApplicable.set(p, 'collision');   // DAT-29: the local bytes are never touched
        continue;
      }
    }
    if (mRefused.has(p)) deferred.set(p, 'unmaterializable');   // FB-6: its whole-path edit could not be built
  }
  // ApplyReport.notApplicableRules (Task 6): the D7 rule of an unmaterializable path, when one names its cause.
  const notApplicableRules = new Map<string, PortRule>();
  const foldsCase = await caseFoldingDisk(core);
  for (const [p, why] of notApplicable) {
    if (why !== 'unmaterializable') continue;
    const rule = notApplicableRuleOf(core, it, p, foldsCase);
    if (rule !== null) notApplicableRules.set(p, rule);
  }
  for (const ex of [it.tick.excluded, mat.excluded]) {
    for (const [p, e] of ex) if (!notApplicable.has(p) && !deferred.has(p)) deferred.set(p, deferFor(e));
  }
  const toWrite = W.filter((p) => !unmanaged.has(p) && !notApplicable.has(p) && !diskEqual.has(p));
  // Plan 5 Task 8 (X5-01, CCI-23, ENG-31; 01 §3.11 defer rows fence/read_lease): the defer set's rows join the defer
  // set before grouping — a write group touching a leased path defers whole (INV-GROUP); a path already deferred (a
  // conflict verdict, an exclusion) or not applicable keeps its more specific row, and one with nothing to write
  // needs no row. t/M keeps the merged entry of a joined path (the FB-6 exception: a deferred path's t/M entry is
  // never a write or restart target).
  {
    const inToWrite = new Set(toWrite);
    for (const [p, why] of leaseRows) {
      if (deferred.has(p) || notApplicable.has(p) || !inToWrite.has(p)) continue;
      deferred.set(p, why);
    }
  }
  const applicable = new Set(toWrite.filter((p) => !deferred.has(p)));
  const relevant = new Set([...toWrite, ...changed]);
  const deferInGroups = new Map([...deferred].filter(([p]) => relevant.has(p) && !diskEqual.has(p)));
  const range = await incomingBase(core, view0.meta.pending, view0.laC, A, TIP, it.tip, notApplicable);
  const { cs: incoming, all: read, writers } = await incomingChangeSets(repo, range.base, it.tip, view0.laC, range.chain);
  // Plan 3 Task 18 (F14, UX-33): the writer of each incoming path, kept from this trailer read for the flow's query (no commit read then);
  // from every CS read, not only the closure range's (R3-EF4-4: the writer of p does not depend on p's closure). Merged into the writers
  // earlier reads kept (audit #25): a not-applicable path's commit lies below every later read's base.
  const pathWriters = incomingWritersOf(core, read, writers, TIP);   // A8-5: the applied fan-out's writer field
  keepIncomingWriters(core, pathWriters, A, TIP);
  // Mutant M38 (Plan 3 Task 6, R3-50): no CS links paths, so every path is its own write group and a locked path no longer
  // defers the available paths of its group (INV-GROUP's oracle kills it).
  const grouping = deps.testMutants.has('M38') ? [] : incoming;
  const wg = writeGroups(grouping, applicable, deferInGroups);
  for (const d of wg.deferred) for (const p of d.paths) deferred.set(p, d.reason);
  // R3-31: the write groups as components (the partition writeGroups computed, recomputed without deferrals), one closure per group.
  const components = writeGroups(grouping, new Set([...applicable, ...deferInGroups.keys()]), new Map()).groups;

  // ---- the write groups and the free-space admission (≥ 2 × bytes + 256 MB, else the whole apply defers) ----
  const sRaw = mat.sRawMap;
  const groups: WriteGroup[] = wg.groups.map((paths, n) => ({
    n,
    entries: paths.map((p, slot): WriteEntry => {
      const s = S.get(p);
      const m = M.get(p);
      const kind: WriteKind = s === undefined ? 'create' : m === undefined ? 'delete' : 'modify';
      return { path: p, kind, slot, target: m ?? null, sRaw: sRaw.get(p) ?? null, sDisk: s ?? null };
    }),
  }));
  const targets = groups.flatMap((g) => g.entries).flatMap((e) => (e.target === null ? [] : [e.target.oid]));
  const bytes = (await repo.blobSizes(targets)).reduce((x, y) => x + y, 0);
  const free = await fs.freeBytes(deps.paths.workTree);
  if (free !== null && free < 2 * bytes + FREE_SPACE_MARGIN_BYTES) {
    const r = emptyReport('disk_low');
    for (const p of [...toWrite, ...deferInGroups.keys()]) r.deferred.set(p, 'disk_low');
    for (const [p, why] of notApplicable) r.notApplicable.set(p, why);
    r.notApplicableRules = notApplicableRules;
    r.incoming = incoming;
    // R3-31: every write group of this apply defers disk_low (a form or local-only deferral keeps its precedence).
    const ownLow = (p: string): DeferReason => deferInGroups.get(p) ?? 'disk_low';
    r.closures = components.filter((g) => g.some((p) => r.deferred.has(p))).map((g) => {
      const reason = closureReason(['disk_low', ...g.map((p) => deferInGroups.get(p) ?? 'closure')]);
      return { paths: g, reason, path: blockerOf(g, ownLow, reason) };
    });
    // Ruling P2-DISKLOW-PENDING (ENG-31, R-05): the deferral is listed in meta.pending (status pending.incoming,
    // not_converged) by a transition that changes meta.pending ONLY — this run's disk_low and not-applicable paths,
    // replacing every earlier reason — while A, LA_C, LA_B, snap, the ready pairs and the intent stay (the apply did not
    // happen); none when pending is already that.
    const pending = pendingOf([...r.deferred, ...r.notApplicable], A, TIP);
    if (!samePending(pending, core.view!.meta.pending)) await core.commit({ meta: { ...core.view!.meta, pending } });
    deps.log.write('warn', 'DEFERRED', { reason: 'disk_low', paths: r.deferred.size });
    return r;
  }

  // ---- the temp names (final review FB-1) ----
  // Every tmp/<n>.<slot>.{new,old,redo} name of J is freed before J is journaled (and before any record), so a restart's
  // rollbackIntent reads a file at one of them as this intent's own .old, never as an earlier group's ring .old. A holder
  // that refuses the move defers the whole apply 'locked': nothing recorded, journaled or written (the next permitted
  // apply retries).
  if (groups.length > 0 && !(await core.writer.reserve(groups))) {
    const r = emptyReport('locked');
    for (const p of toWrite) r.deferred.set(p, 'locked');
    for (const [p, why] of notApplicable) r.notApplicable.set(p, why);
    // Plan 3 (Task 6, R3-31) as for disk_low above: every write group of this apply defers 'locked' (a form or local-only
    // deferral keeps its precedence), one closure per group.
    r.notApplicableRules = notApplicableRules;
    r.incoming = incoming;
    const ownLocked = (p: string): DeferReason => deferInGroups.get(p) ?? 'locked';
    r.closures = components.filter((g) => g.some((p) => r.deferred.has(p))).map((g) => {
      const reason = closureReason(['locked', ...g.map((p) => deferInGroups.get(p) ?? 'closure')]);
      return { paths: g, reason, path: blockerOf(g, ownLocked, reason) };
    });
    deps.log.write('warn', 'DEFERRED', { reason: 'locked', paths: r.deferred.size });
    return r;
  }

  // ---- records before any write (R-02 apply side, ENG-29) ----
  const writing = new Set(groups.flatMap((g) => g.entries.map((e) => e.path)));
  const recordOf = new Map<string, string>();
  const companionAt = new Map<string, string>();   // EF4 E4-1: p → the marker companion of its K4 onto a markers record
  const readyCs = core.cs.ready();
  for (const [p, stages] of [...takeTip].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
    if (!writing.has(p)) continue;
    const csIds = readyCs.filter((r) => r.paths.includes(p)).map((r) => r.csId);
    // EF4 E4-1 (R3-EF4-7): p's ON_DISK record carries `markers` — never refreshed from disk; the companion keeps S_disk[p].
    const marked = markersTargetOf(core, p);
    if (marked !== undefined) {
      companionAt.set(p, await k4OntoMarkers(core, marked, p, stages, csIds));
      recordOf.set(p, marked.id);
      continue;
    }
    // EF4 round 2 K-1 (R3-EF4-15): any other marker file displaced (a multi-path, unknown-guard or companion holder, or rows with no
    // holder): the K4 record takes marker-free stages and its marker companion keeps S_disk[p] — never a record that is mirrored.
    if (await displacesMarkers(core, p, S.get(p))) {
      const { id, companion } = await k4OverMarkerFile(core, p, stages, csIds);
      companionAt.set(p, companion);
      recordOf.set(p, id);
      continue;
    }
    const id = await core.holds.hold({
      kind: 'PATCH', residence: 'ON_DISK', state: 'CONFLICTED', paths: [p],
      blobs: { s1: { [p]: stages.s1 }, s2: { [p]: stages.s2 }, s3: { [p]: stages.s3 } },
      guard: 'conflict', origin: 'daemon', cs_ids: csIds,
      displaced_by: null, local_only: it.scope(p).cls !== 'LIVE',
    });
    recordOf.set(p, id);
  }

  // ---- J, the writer ----
  let intent: Intent = { kind: 'none' };
  let jTrees: ReadonlyMap<JournalTree, Oid> = new Map();
  let results: GroupResult[] = [];
  if (groups.length > 0) {
    intent = { kind: 'apply', tip: it.tip, board: T, groups: groups.map((g) => ({ n: g.n, entries: g.entries.map((e) => ({ path: e.path, kind: e.kind, slot: e.slot })) })) };
    jTrees = new Map<JournalTree, Oid>([['M', mTree], ['S', mat.sDisk], ['TIP', tipTree]]);
    await core.commit({ intent, t: jTrees });
    crashpoint('apply.intent');
    const remerge: Remerge = async (entry, found) => {
      if (entry.sDisk === null || entry.target === null) return null;
      const m = await mergeFile(repo, found.oid, entry.sDisk.oid, entry.target.oid);
      if (m.rc !== 0) return null;
      return { path: entry.path, mode: entry.target.mode, oid: await repo.hashBytes(m.out, true) };
    };
    try {
      results = await core.writer.applyGroups(groups, remerge);
    } catch (e) {
      if (e instanceof KilledAt) throw e;
      // Task 10 caller contract: a rejected applyGroups is rolled back in-process; the intent stays journaled.
      let rolledBack = false;
      try {
        await core.writer.rollbackIntent(intent, new Map(groups.flatMap((g) => g.entries.map((x) => [x.path, x.target] as const))));
        rolledBack = true;
      } catch (e2) {
        if (e2 instanceof KilledAt) throw e2;
        deps.log.write('error', 'APPLY_ROLLBACK_FAILED', { code: e2 instanceof Error ? e2.name : 'unknown' });
      }
      // EF4 round 2 K-3 (ruling R3-EF4-15): a marker companion this apply committed keeps a file the rollback put back on disk — redundant,
      // it ends GONE by observation (R3-15's pattern), so a retry never makes a second one. After a failed rollback it stays (it may then
      // hold the only copy), and a retry reuses it (markerCompanion, k4OntoMarkers). EF4 r2 I2-5: a failure of that settlement (a read,
      // a registry CAS) is logged and never replaces the writer's rejection; the companion then stays live (the safe side).
      if (rolledBack) {
        try {
          await endRedundantCompanions(core, companionAt, S);
        } catch (e3) {
          if (e3 instanceof KilledAt) throw e3;
          deps.log.write('error', 'APPLY_COMPANION_SETTLE_FAILED', { code: e3 instanceof Error ? e3.name : 'unknown' });
        }
      }
      throw e;
    }
  }

  const written = new Map<string, TreeEntry>();
  const deleted = new Set<string>();
  const phantoms = new Set<string>();
  const unwritten = new Set<string>();   // EF4 E4-1: the paths of the groups the writer deferred (nothing of them was written)
  const byN = new Map(groups.map((g) => [g.n, g] as const));
  for (const res of results) {
    if (res.outcome === 'written') {
      for (const e of res.written) written.set(e.path, e);
      for (const p of res.deleted) deleted.add(p);
      for (const p of res.phantoms) phantoms.add(p);
    } else {
      for (const e of byN.get(res.n)?.entries ?? []) {
        deferred.set(e.path, res.reason ?? 'race');
        unwritten.add(e.path);
      }
    }
  }
  // Plan 5 Task 8 (A8-5): after the groups ran — once per written group, with exactly its written paths and their
  // detail: from = the pre-apply A entry, to = the written blob (a re-merged path its merge), writer = the path's
  // incoming writer when the engine has one (X5-06), else null. Before the K4 displacement and the state update:
  // the fan-out reports the writes the disk now holds. F2 #110 (R-T8B-4): a daemon listener that throws never aborts the
  // apply (its groups are on disk; the state update below must run): logged by its error name only (the message may
  // name a path or hold file content), a simulated kill still propagates.
  for (const res of results) {
    if (res.outcome !== 'written') continue;
    const paths: string[] = [];
    const detail: AppliedPath[] = [];
    for (const e of res.written) {
      paths.push(e.path);
      detail.push({ path: e.path, from: A.get(e.path)?.oid ?? ABSENT, to: e.oid, writer: pathWriters.get(e.path)?.writer ?? null });
    }
    for (const p of res.deleted) {
      paths.push(p);
      detail.push({ path: p, from: A.get(p)?.oid ?? ABSENT, to: ABSENT, writer: pathWriters.get(p)?.writer ?? null });
    }
    try {
      deps.claude.applied(paths, detail);
    } catch (e) {
      if (e instanceof KilledAt) throw e;
      deps.log.write('error', 'CLAUDE_LISTENER_FAILED', { at: 'applied', code: e instanceof Error ? e.name : 'unknown' });
    }
  }
  // R-02: after the verified write of TIP at p the record masks nothing (OFF_DISK). Final review FB-5: that holds for
  // EVERY ON_DISK CONFLICTED conflict record of p, not only this apply's own: an earlier one (a publish-side K4 whose
  // LOCAL the user edited again, an apply-side one whose group deferred) has another s2, so hold() made a new record,
  // and the disk now holds TIP[p] — no LOCAL of any of them (INV-HLD-OFFDISK). Left ON_DISK it would mask p for good.
  // R3-22 (Plan 3 Task 5): displaced_by and peer_authors in that same rev, for each of them; EF4 E4-1 (R3-EF4-7): `markers`
  // released in it too (k4OffDiskPatch). A K4 onto a markers record whose group the writer deferred wrote nothing: its marker
  // companion is redundant (the marker file is still on r's disk) and ends GONE in one commit, r unchanged (R3-15's failed park).
  // Ruling R3-EF4-28 (delta review I2; HLD-08): the move runs for EVERY verified written or deleted path, not only this apply's own
  // TAKE_TIP paths, as the restart decision (resolveWriteIntent) does: a K4 whose write group an earlier apply's writer deferred is
  // displaced by any later verified write of p (the disk holds M_disk[p], not its LOCAL); left ON_DISK CONFLICTED, R1 kept it CONFLICTED
  // (UNSEPARABLE) and MASK withheld p whole for good. Such a write counts `take_tip` for HLD-41 (`displacedAt`, below). A record
  // carrying `markers` moves only when the written bytes hold no restore-marker row: k4OffDiskPatch releases `markers` because the disk
  // then holds no such row (DAT-46), which a clean merge that kept the rows does not meet. Ruling R3-SPEC-3 (HLD-08 vs R3-FF3-B3, fail
  // closed): the check runs on this apply's own TAKE_TIP paths too, as the restart decision's does — a TAKE_TIP write is TIP's blob, which
  // keeps a row when a teammate's commit put one there (R3-FF3-B3); such a record then stays ON_DISK with `markers` (never unmasked).
  const displacedAt = new Set<string>();
  for (const p of [...new Set([...recordOf.keys(), ...written.keys(), ...deleted])].sort()) {
    if (!written.has(p) && !deleted.has(p)) {
      const c = companionAt.get(p);
      if (c !== undefined && unwritten.has(p)) await core.holds.transition(c, { state: 'GONE' });
      continue;
    }
    let ids = onDiskConflictRecords(core, p);
    if (ids.length === 0) continue;
    const wrote = written.get(p);
    const marked = (id: string): boolean => core.holds.get(id)!.guards.some((g) => guardName(g) === 'markers');
    if (wrote !== undefined && isRegular(wrote) && ids.some(marked) && hasRestoreMarkerRow(await repo.readBlob(wrote.oid))) {
      ids = ids.filter((id) => !marked(id));
      if (ids.length === 0) continue;
    }
    displacedAt.add(p);
    const displaced = await k4Displacement(core, it.tip, p);
    for (const id of ids) await core.holds.transition(id, k4OffDiskPatch(core.holds.get(id)!, displaced));
  }

  // ---- C: the ENG-36 state update ----
  const phantomHeld = phantomPaths(core);
  const aEdits: IndexEdit[] = [];
  const indexEdits: IndexEdit[] = [];
  const aSet: Array<{ path: string; blob: string | null; cause: ASetCause }> = [];
  const changes: RebaseChange[] = [];
  for (const p of changed.sort()) {
    if (!editable(p)) continue;
    const a = A.get(p);
    const t = TIP.get(p);
    let cause: ASetCause | null = null;
    let w: RebaseChange['written'] = 'none';
    if (unmanaged.has(p)) {
      cause = 'unmanaged_follow';
      indexEdits.push(t === undefined ? { path: p, remove: true } : { path: p, mode: t.mode, oid: t.oid });
    } else if (diskEqual.has(p) && t !== undefined) {
      cause = 'disk_equal';   // R3-33: the private index takes TIP[p] as after a verified write (no object, no write)
      indexEdits.push({ path: p, mode: t.mode, oid: t.oid });
    } else if (notApplicable.has(p) || deferred.has(p) || phantoms.has(p) || phantomHeld.has(p) || carriedHere(p)) {
      cause = null;
    } else if (written.has(p) || deleted.has(p)) {
      cause = 'write_verified';
      // R3-EF4-28: a write that displaced a K4 record of p is a take_tip for HLD-41, whatever the merge (as the restart decision counts it).
      w = displacedAt.has(p) ? 'take_tip' : (how.get(p) ?? 'clean');
    } else if (sameEntry(S.get(p), M.get(p))) {
      cause = 'disk_equal';
    }
    if (cause === null) continue;
    aEdits.push(t === undefined ? { path: p, remove: true } : { path: p, mode: t.mode, oid: t.oid });
    aSet.push({ path: p, blob: t?.oid ?? null, cause });
    changes.push({
      path: p, aOld: a ?? null, aNew: t ?? null, written: w, sDiskBefore: S.get(p) ?? null,
      writtenEntry: w === 'clean' || w === 'concat' ? (written.get(p) ?? null) : null,
    });
  }
  // A local path displaced from beneath a TIP file and removed (verified) leaves A as it was (A[p] == TIP[p], both absent),
  // so no A change reaches HLD-41: the take_tip change is stated explicitly, and the ready pairs carrying p are cancelled
  // (CS_READY_CANCELLED) like those of any TAKE_TIP — never left to publish a file the disk no longer holds.
  for (const p of [...underFile].sort()) {
    if (!deleted.has(p) || changed.includes(p)) continue;
    const a = A.get(p) ?? null;
    changes.push({ path: p, aOld: a, aNew: a, written: 'take_tip', sDiskBefore: S.get(p) ?? null, writtenEntry: null });
  }
  const newATree = await editTreeIndexOnly(repo, fs, aTree, aEdits, core.scratch('a'));
  const privateIndex = join(deps.paths.coworkDir, `${core.refs.e}.index`);
  await editIndexOnly(repo, privateIndex, indexEdits, aTree.length);   // DAT-26: --cacheinfo TIP[p], never hashed
  // EF4 r2 I2-2 (ruling R3-EF4-21, final review F1's rule): this apply moved p's private-index entry — the writer's round trip of each
  // verified write, each verified deletion, each DAT-26/R3-33 index-only entry — so an observed write of p from before it (a restore or
  // a collision take whose entry the revert detector never took: the disk was back at the indexed bytes) can no longer appear as a
  // delta. Its ObservedWrites entry ends here; left, R3-EF4-13 would judge the next human delta from that older blob instead of from
  // the new entry, and a removal of the row this apply brought in would make no `revert` record (INV-HLD-NOREVERT).
  for (const p of new Set([...written.keys(), ...deleted, ...indexEdits.map((e) => e.path)])) core.observed.forget(p);
  // EF2 D4 (05 D2 step 1, HLD-27/HLD-28; the R3-60 precedent): snap is S_disk with the private-index edits of this transition — each
  // verified write's entry (the writer round-trips the private index to it: M_disk[p], or the re-merge), each verified deletion
  // removed and the DAT-26/R3-33 index-only entries — so a restart's unconditional reseed from state:snap reproduces the round trip.
  // With the pre-apply S_disk there, the revert detector's prev[p] after a restart was the bytes before the apply, and a rewind or a
  // stale save to them (removing a teammate's applied row) read as no removal: no revert record, the row gone at the next publish.
  const snapEdits: IndexEdit[] = [
    ...indexEdits,
    ...[...written.values()].map((e): IndexEdit => ({ path: e.path, mode: e.mode, oid: e.oid })),
    ...[...deleted].map((p): IndexEdit => ({ path: p, remove: true })),
  ];
  const newSnap = await editTreeIndexOnly(repo, fs, mat.sDisk, snapEdits, core.scratch('a'));

  const prevView = core.view!;
  await resetScratchIndex(fs, core.scratch('r'));   // P2-SCRATCHLOCK: HLD-41's rebase reads trees into tmp/r.index
  // Mutant M20 (R-29): the ready pairs are not rebased at an apply that changes A[p]; composeP's A_cap assert must stop the stale R.
  const rebase = await core.cs.rebase(repo, deps.testMutants.has('M20') ? [] : changes, core.scratch('r'));
  const newA = await repo.readTreeMap(newATree);
  const reportDeferred = new Map<string, DeferReason>();
  for (const [p, why] of [...deferred, ...notApplicable]) {
    if (!sameEntry(newA.get(p), TIP.get(p))) reportDeferred.set(p, why);
  }
  const pending = pendingOf(reportDeferred, newA, TIP);
  const fp = foldPatch(core);
  const meta = {
    ...prevView.meta, pending, throttle: core.governor.toMeta(), outbox: core.outbox.toJson(),
    ...(fp !== null ? fp.meta : {}),
  };
  const writtenPaths = [...written.keys()].sort();
  const deletedPaths = [...deleted].sort();
  // P2-STRANDED / P2-NARROW: when a group's rollback restore is stranded, ONLY the stranded groups of J stay journaled
  // (with t/M, t/S, t/TIP): a written group kept in J would be rolled back by a restart after A moved. The next
  // prepareIteration whose sweep empties strandedPaths() clears it.
  const kept = narrowToStranded(intent, results);
  // An apply that wrote nothing and changes nothing the state holds (a persisting collision, an excluded path) makes no
  // transition: the state ref changes only for transitions (01-engine §3.2).
  const noop = groups.length === 0 && newATree === prevView.base && it.tip === prevView.laC && T === prevView.laB
    && samePending(pending, prevView.meta.pending) && sameReady(rebase.ready, prevView.ready)
    && (fp === null || fp.meta.fold_board === prevView.meta.fold_board);
  if (!noop) {
    try {
      // Task 17 (rev 2.5, decision D2 with §8 Q18 option (a); ENG-36): each revert shrink mark a clean HLD-41 rebase moved is a
      // reverts.jsonl line (of and t_local_ms repeated, the mark's whole map), appended and fsynced before the state update that stores
      // the rebased pair, so a restart re-derives a mark the journaled pair carries and never one the journal does not hold.
      for (const m of rebase.marksMoved ?? []) await core.reverts.appendMove(m.cs, new Map(Object.entries(m.written)));
      // R3-59: the provenance journal advances after crashpoint('apply.state') below, not inside the commit.
      await core.commit({
        base: newATree, laC: it.tip, laB: T, snap: newSnap, meta,
        intent: kept, t: kept.kind === 'none' ? new Map() : jTrees,
        ready: rebase.ready, ...(fp !== null ? { fold: fp.fold } : {}),
      }, { provenance: 'caller' });
    } catch (e) {
      // ChangeSets changed memory before the journal (Task 11): a failed update that is not fatal restores it.
      if (!(e instanceof StateCasLostError) && !(e instanceof KilledAt)) core.cs.restore(prevView.ready, prevView.meta.cs_human_next);
      throw e;
    }
  }
  // R3-31: one closure per deferred write group: the groups writeGroups deferred before writing (their per-(group, reason) entries
  // regrouped by component) and the groups the writer deferred whole; the trace lists every write group with its group-level reason.
  const compOf = new Map<string, number>();
  components.forEach((g, i) => {
    for (const p of g) compOf.set(p, i);
  });
  const pre = new Map<number, { paths: string[]; reasons: DeferReason[]; own: Map<string, DeferReason> }>();
  for (const d of wg.deferred) {
    const i = compOf.get(d.paths[0]!);
    if (i === undefined) throw new Error(`applyStep: deferred path ${JSON.stringify(d.paths[0])} is in no write group`);
    const c = pre.get(i) ?? { paths: [], reasons: [], own: new Map<string, DeferReason>() };
    c.paths.push(...d.paths);
    c.reasons.push(d.reason);
    for (const p of d.paths) c.own.set(p, d.reason);
    pre.set(i, c);
  }
  // Every write group with its outcome and group-level reason (the trace's `groups`) and, for a deferred one, the path it waits for.
  const traceGroups: Array<{ paths: string[]; outcome: 'written' | 'deferred'; reason: ClosureReason | null; waits: string | null }> = [];
  for (const c of pre.values()) {
    const reason = closureReason(c.reasons);
    traceGroups.push({ paths: [...c.paths].sort(), outcome: 'deferred', reason, waits: blockerOf(c.paths, (p) => c.own.get(p), reason) });
  }
  for (const res of results) {
    const paths = (byN.get(res.n)?.entries ?? []).map((e) => e.path).sort();
    traceGroups.push(res.outcome === 'written'
      ? { paths, outcome: 'written', reason: null, waits: null }
      : { paths, outcome: 'deferred', reason: closureReason([res.reason ?? 'race']), waits: res.path !== undefined && paths.includes(res.path) ? res.path : paths[0]! });
  }
  traceGroups.sort((x, y) => (x.paths[0]! < y.paths[0]! ? -1 : x.paths[0]! > y.paths[0]! ? 1 : 0));
  const closures = traceGroups.filter((g) => g.outcome === 'deferred').map((g) => ({ paths: g.paths, reason: g.reason as ClosureReason, path: g.waits! }));
  deps.trace.emit({
    kind: 'apply', peer, tip: it.tip, written: [...writtenPaths, ...deletedPaths].sort(), deferred: [...reportDeferred.keys()].sort(),
    groups: traceGroups.map(({ paths, outcome, reason }) => ({ paths, outcome, reason })),
    notApplicable: [...notApplicable].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([path, reason]) => ({ path, reason })),
    mDisk: mTree,
  });
  for (const s of aSet) deps.trace.emit({ kind: 'A_set', peer, path: s.path, blob: s.blob, cause: s.cause });
  if (!noop) crashpoint('apply.state');

  if (!noop) markApplyIntentKept(core, kept.kind !== 'none');
  setCurrentA(core, newATree, newA);
  it.A = newA;
  // R3-59 / 11-testing §3.6: the journal is appended after the apply.state anchor ("before … the provenance journal [is]
  // updated"), so a kill there leaves it one commit behind, which the restart's load advances.
  if (!noop) await advanceProvenance(core, prevView.laC);
  // Final review FB-2: a path P1 re-merged (a local edit saved after the tick: GroupResult.written holds the merge, not
  // M_disk[p]) is marked clean by the round trip with the user's edit inside it, so no later tick sees a change there:
  // the human CS takes it now (LIVE paths only, Task 11 ruling), and its capture (R = the merge, A_cap = TIP) publishes it.
  const remerged = [...written].filter(([p, e]) => !sameEntry(e, M.get(p))).map(([p]) => p);
  const liveRemerged = remerged.filter((p) => it.scope(p).cls === 'LIVE');
  if (liveRemerged.length > 0) core.cs.observe(liveRemerged);
  if (reportDeferred.size > 0) deps.log.write('info', 'DEFERRED', { paths: reportDeferred.size });
  for (const csId of rebase.cancelled) deps.log.write('info', 'CS_READY_CANCELLED', { cs_id: csId });
  for (const p of phantoms) deps.log.write('warn', 'PHANTOM', { path: p });
  return {
    ran: true, skipped: null, written: writtenPaths, deleted: deletedPaths,
    deferred: new Map([...reportDeferred].filter(([p]) => !notApplicable.has(p)) as Array<[string, DeferReason]>),
    notApplicable, records: [...recordOf.values()], cancelled: rebase.cancelled, changedA: aSet.map((x) => x.path),
    closures, notApplicableRules, incoming,
  };
}
