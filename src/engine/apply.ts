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
//   defer set     the snapshot's per-loop exclusions (unreadable/unstable/filter_failure); HLD-53 groups, closure
//   admission     free space ≥ 2 × bytes to write + 256 MB, else the whole apply defers disk_low
//   temp names    Writer.reserve frees every tmp/<n>.<slot>.* name of J before anything is recorded or journaled (final
//                 review FB-1), else the whole apply defers locked
//   records      a K4 PATCH (CONFLICTED, ON_DISK, guard conflict) for every displaced local version, committed before any
//                 disk write (R-02 apply side)
//   J             the apply intent with t/M, t/S, t/TIP; crashpoint('apply.intent'); Writer.applyGroups
//   C             ONE state update (ENG-36): A per path, LA_C := TIP, LA_B := T, snap := S_disk, pending, the HLD-41 rebased
//                 ready pairs, the fold, intent cleared (kept while a restore is stranded, P2-STRANDED);
//                 crashpoint('apply.state'); then the in-memory A
//
// A[p] := TIP[p] only for a verified write (write_verified), an applicable non-deferred path with M_disk[p] == S_disk[p]
// (disk_equal) and an UNMANAGED path (unmanaged_follow; its private-index entry := TIP[p], never hashed). A PHANTOM keeps
// A[p] (no verified write, ENG-06) and its path leaves the trigger while its PIN holds (ENG-34 is the ping-pong breaker).
import { join } from 'node:path';
import { parseCsTrailers } from '../board/boardCommit.js';
import { liveSet } from '../board/fold.js';
import { conflict, type ConflictCtx, type ConflictVerdict, type UnitKind } from '../data/conflict.js';
import { wildmatch } from '../data/scope.js';
import { mergeFile, MergeFailedError, mergeTree } from '../git/merge.js';
import { ABSENT, parseOid, type Oid } from '../git/oid.js';
import { parseMessage } from '../git/trailers.js';
import type { GitRepo, IndexEdit, TreeEntry, TreeMap } from '../git/repo.js';
import { writeGroups, type DeferReason, type IncomingCs } from '../holds/groups.js';
import type { ReadyPair, RebaseChange } from '../holds/changesets.js';
import { guardName, isTerminal } from '../holds/record.js';
import { crashpoint, KilledAt } from '../ports/crashpoint.js';
import { LEASE_STOP_SYNC_MS } from '../ports/lease.js';
import type { ASetCause } from '../ports/trace.js';
import {
  applicableDifference, currentA, editable, ensureAttrs, foldPatch, liveCodeOf, markApplyIntentKept, pathIsText, phantomPaths, sameEntry,
  setCurrentA, tickInputOf, unmaterializableHere, type EngineCore, type IterationCtx,
} from './core.js';
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
    | 'locked';                // contract extension (final review FB-1): a writer temp name could not be freed; nothing journaled
  written: string[]; deleted: string[];
  deferred: Map<string, DeferReason>; notApplicable: Map<string, 'collision' | 'unmaterializable' | 'quarantine'>;
  records: string[]; cancelled: string[];
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

function emptyReport(skipped: ApplyReport['skipped']): ApplyReport {
  return { ran: false, skipped, written: [], deleted: [], deferred: new Map(), notApplicable: new Map(), records: [], cancelled: [] };
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
 * paths are exactly [p] (a K4 displacement of p: publish- or apply-side, R-02). Shared with the restart.
 */
export function onDiskConflictRecords(core: EngineCore, p: string): string[] {
  return core.holds.nonTerminal()
    .filter((r) => r.kind === 'PATCH' && r.state === 'CONFLICTED' && r.residence === 'ON_DISK' && !isTerminal(r)
      && r.guards.some((g) => guardName(g) === 'conflict') && r.paths.length === 1 && r.paths[0] === p)
    .map((r) => r.id)
    .sort();
}

/** The same ready pairs (cs_id, R, A_cap), in order. */
function sameReady(a: readonly ReadyPair[], b: readonly ReadyPair[]): boolean {
  return a.length === b.length && a.every((x, i) => x.csId === b[i]!.csId && x.R === b[i]!.R && x.A === b[i]!.A);
}

/**
 * The incoming change-sets of LA_C..TIP (HLD-53): each live commit's Cowork-CS trailers with their Cowork-CS-Paths
 * lists; a change-set without a list (count-only form) and a commit without Cowork-CS are one change-set of
 * paths(diff(first parent, commit)) (HLD-37). One rev-list for the messages; one diff-tree per commit lacking lists.
 */
async function incomingChangeSets(repo: GitRepo, laC: Oid, tip: Oid): Promise<IncomingCs[]> {
  if (laC === tip) return [];
  const r = await repo.run(['rev-list', '--first-parent', '--no-commit-header', `--max-count=${MAX_INCOMING}`, '--format=%x00%H%n%P%n%B', tip, `^${laC}`]);
  const out: IncomingCs[] = [];
  for (const record of r.stdout.toString('utf8').split('\0').slice(1)) {
    const nl1 = record.indexOf('\n');
    const nl2 = nl1 < 0 ? -1 : record.indexOf('\n', nl1 + 1);
    if (nl2 < 0) throw new Error(`apply: unexpected rev-list record ${JSON.stringify(record.slice(0, 120))}`);
    const commit = parseOid(record.slice(0, nl1));
    const parent = record.slice(nl1 + 1, nl2).split(' ').filter((x) => x.length > 0)[0] ?? null;
    const { cs, paths } = parseCsTrailers(parseMessage(record.slice(nl2 + 1)).trailers);
    let diff: string[] | null = null;
    const whole = async (): Promise<string[]> => (diff ??= await changedPaths(repo, parent === null ? null : parseOid(parent), commit));
    if (cs.length === 0) {
      out.push({ commit, csId: `commit:${commit}`, paths: await whole() });
      continue;
    }
    for (const c of cs) out.push({ commit, csId: c.csId, paths: paths.get(c.csId) ?? (await whole()) });
  }
  return out;
}

/** paths(diff(parent, commit)) by one diff-tree (no renames; a root commit lists every path). */
async function changedPaths(repo: GitRepo, parent: Oid | null, commit: Oid): Promise<string[]> {
  const args = parent === null
    ? ['diff-tree', '-r', '-z', '--name-only', '--no-renames', '--no-commit-id', '--root', commit]
    : ['diff-tree', '-r', '-z', '--name-only', '--no-renames', '--no-commit-id', parent, commit];
  return (await repo.run(args)).stdout.toString('utf8').split('\0').filter((s) => s.length > 0);
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
  // Ruling P2-PUSHINTENT-FIRST: a kept push intent is the only record of a push that may have landed; an apply intent
  // journaled over it would lose it. Not admitted (no journal write, the 10 s window unused) until resolvePushIntent ran.
  if (view0.intent.kind === 'push') return emptyReport('push_intent_pending');
  if (it.freeze.length > 0) return emptyReport('frozen');
  if (it.leaseIdleMs >= LEASE_STOP_SYNC_MS) return emptyReport('lease');
  if (it.tick === null || it.tick.failed) return emptyReport('snapshot_failed');
  if (!applyNeeded(core, it)) return emptyReport('nothing');
  // P2-STRANDED / P2-NARROW: while a rollback restore is stranded no new intent is journaled (its kept intent is the
  // only durable name of the .old); read live, so a writeLocal that just returned LOCKED/DEFERRED counts too. Before
  // the coalesce stamp: a gated apply does not use the 10 s window.
  if (core.writer.strandedPaths().length > 0) return emptyReport('stranded');
  const now = clock.monoMs();
  if (core.lastApplyMono !== null && now - core.lastApplyMono < APPLY_COALESCE_MS) return emptyReport('coalesced');
  core.lastApplyMono = now;
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
  const ctx: ConflictCtx = {
    repo,
    isText: (p) => pathIsText(core, p),
    insertionMerge: (p) => core.config.merge.insertionMerge.some((g) => wildmatch(g, p)),
    concatAllowed,
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
  const route = async (p: string, v: ConflictVerdict): Promise<void> => {
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
  // Ledger Task 13:234: two spellings of one file inside TIP on a case-insensitive volume are not materializable here.
  const tipCollide = await core.snapshot.tipCollisions(TIP);
  for (const p of W) {
    if (unmanaged.has(p) || notApplicable.has(p)) continue;
    if (quarantined(p)) {
      notApplicable.set(p, 'quarantine');
      continue;
    }
    if (tipCollide.has(p) || (await unmaterializableHere(core, it, p))) {
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
        notApplicable.set(p, 'collision');   // DAT-29: the local bytes are never touched
        continue;
      }
    }
    if (mRefused.has(p)) deferred.set(p, 'unmaterializable');   // FB-6: its whole-path edit could not be built
  }
  for (const ex of [it.tick.excluded, mat.excluded]) {
    for (const [p, e] of ex) if (!notApplicable.has(p) && !deferred.has(p)) deferred.set(p, deferFor(e));
  }
  const toWrite = W.filter((p) => !unmanaged.has(p) && !notApplicable.has(p));
  const applicable = new Set(toWrite.filter((p) => !deferred.has(p)));
  const relevant = new Set([...toWrite, ...changed]);
  const deferInGroups = new Map([...deferred].filter(([p]) => relevant.has(p)));
  const incoming = await incomingChangeSets(repo, view0.laC, it.tip);
  const wg = writeGroups(incoming, applicable, deferInGroups);
  for (const d of wg.deferred) for (const p of d.paths) deferred.set(p, d.reason);

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
    deps.log.write('warn', 'DEFERRED', { reason: 'locked', paths: r.deferred.size });
    return r;
  }

  // ---- records before any write (R-02 apply side, ENG-29) ----
  const writing = new Set(groups.flatMap((g) => g.entries.map((e) => e.path)));
  const recordOf = new Map<string, string>();
  const readyCs = core.cs.ready();
  for (const [p, stages] of [...takeTip].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
    if (!writing.has(p)) continue;
    const id = await core.holds.hold({
      kind: 'PATCH', residence: 'ON_DISK', state: 'CONFLICTED', paths: [p],
      blobs: { s1: { [p]: stages.s1 }, s2: { [p]: stages.s2 }, s3: { [p]: stages.s3 } },
      guard: 'conflict', origin: 'daemon', cs_ids: readyCs.filter((r) => r.paths.includes(p)).map((r) => r.csId),
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
      try {
        await core.writer.rollbackIntent(intent, new Map(groups.flatMap((g) => g.entries.map((x) => [x.path, x.target] as const))));
      } catch (e2) {
        if (e2 instanceof KilledAt) throw e2;
        deps.log.write('error', 'APPLY_ROLLBACK_FAILED', { code: e2 instanceof Error ? e2.name : 'unknown' });
      }
      throw e;
    }
  }

  const written = new Map<string, TreeEntry>();
  const deleted = new Set<string>();
  const phantoms = new Set<string>();
  const byN = new Map(groups.map((g) => [g.n, g] as const));
  for (const res of results) {
    if (res.outcome === 'written') {
      for (const e of res.written) written.set(e.path, e);
      for (const p of res.deleted) deleted.add(p);
      for (const p of res.phantoms) phantoms.add(p);
    } else {
      for (const e of byN.get(res.n)?.entries ?? []) deferred.set(e.path, res.reason ?? 'race');
    }
  }
  // R-02: after the verified write of TIP at p the record masks nothing (OFF_DISK). Final review FB-5: that holds for
  // EVERY ON_DISK CONFLICTED conflict record of p, not only this apply's own: an earlier one (a publish-side K4 whose
  // LOCAL the user edited again, an apply-side one whose group deferred) has another s2, so hold() made a new record,
  // and the disk now holds TIP[p] — no LOCAL of any of them (INV-HLD-OFFDISK). Left ON_DISK it would mask p for good.
  for (const p of [...recordOf.keys()].sort()) {
    if (!written.has(p) && !deleted.has(p)) continue;
    for (const id of onDiskConflictRecords(core, p)) await core.holds.transition(id, { residence: 'OFF_DISK' });
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
    } else if (notApplicable.has(p) || deferred.has(p) || phantoms.has(p) || phantomHeld.has(p) || carriedHere(p)) {
      cause = null;
    } else if (written.has(p) || deleted.has(p)) {
      cause = 'write_verified';
      w = how.get(p) ?? 'clean';
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
      await core.commit({
        base: newATree, laC: it.tip, laB: T, snap: mat.sDisk, meta,
        intent: kept, t: kept.kind === 'none' ? new Map() : jTrees,
        ready: rebase.ready, ...(fp !== null ? { fold: fp.fold } : {}),
      });
    } catch (e) {
      // ChangeSets changed memory before the journal (Task 11): a failed update that is not fatal restores it.
      if (!(e instanceof StateCasLostError) && !(e instanceof KilledAt)) core.cs.restore(prevView.ready, prevView.meta.cs_human_next);
      throw e;
    }
  }
  deps.trace.emit({ kind: 'apply', peer, tip: it.tip, written: [...writtenPaths, ...deletedPaths].sort(), deferred: [...reportDeferred.keys()].sort() });
  for (const s of aSet) deps.trace.emit({ kind: 'A_set', peer, path: s.path, blob: s.blob, cause: s.cause });
  if (!noop) crashpoint('apply.state');

  if (!noop) markApplyIntentKept(core, kept.kind !== 'none');
  setCurrentA(core, newATree, newA);
  it.A = newA;
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
    notApplicable, records: [...recordOf.values()], cancelled: rebase.cancelled,
  };
}
