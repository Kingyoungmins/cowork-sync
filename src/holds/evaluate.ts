// Algorithm R1 and the OFF_DISK A-change check (05-holds §3.6, HLD-08, HLD-29, INV-HLD-OFFDISK; rulings R3-17, R3-18, R3-19).
//
// R1 (an ON_DISK record, after each apply step; first match wins):
//   0. a record carrying `markers` skips R1 while the guard holds (HELD_BY_MARKERS); a marker companion whose `markers` released
//      ends GONE at once (§3.4 item 3); a record carrying `portability` (a name the snapshot does not admit, DAT-33) skips R1
//      and keeps its state while the guard holds; so does a PIN carrying a transient guard (`unreadable`, `unstable`, HLD-32:
//      incomingStep releases it when the condition clears — Plan 3 Task EF); a guard-less PIN whose S_disk == A on every path ends
//      here, SUBSUMED when its REBASE gives H1' == A (RESOLVED_PUBLISH when explicit), else GONE (integration I-6, Ruling R3-FF5-B1)
//   1. CONFLICTED: REBASE(r) conflicts on a path (for a PIN, REBASE(H1) conflicting is CONFLICTED too); a MASK conflict is
//      MASK's own verdict, which the caller passes in (maskStep's conflicted ids, R3-62)
//   2. SUBSUMED: H1'[p] == A[p] for every p — RESOLVED_PUBLISH instead for a record released by an explicit --publish/--restore
//      (local.explicit, HLD-29)
//   3. GONE: PATCH — mf(S_disk[p], H1'[p], H0'[p]) == S_disk[p] for every p, for r alone whatever its guard set (R3-17; a
//      whole-path-guarded PATCH included: a record whose RESTORE released its last guard stays ACTIVE until SUBSUMED); PIN —
//      S_disk[p] == A[p] for every p
//   4. ACTIVE — a CONFLICTED PATCH whose reverse merge for r alone runs cleanly again (the adjacent edit that made MASK conflict
//      is gone) and a CONFLICTED PIN whose REBASE(H1) is clean again return to ACTIVE; a reverse merge that cannot separate the
//      held change (a text conflict, or R3-18's whole-path rule on a binary path) keeps the record's state (an ACTIVE PATCH's text
//      conflict there is MASK's verdict, which the caller passes in; a CONFLICTED one stays CONFLICTED, so R1 and MASK never flip
//      a record back and forth over r alone).
//   A record whose displacement is pending — ON_DISK CONFLICTED carrying `conflict` or `claim-breach` (a K4 or claim-breach record
//   before its verified TIP write; it REBASEs cleanly, and step 4 would unmask its LOCAL bytes) — or a base-move conflict on bytes
//   still on disk (`base-move`, released only by --restore/--discard, ENG-48) is not separable by any merge (Table 1): it stays
//   CONFLICTED until SUBSUMED or GONE, GONE meaning S_disk[p] == A[p] for every p.
// The reverse merge is REBASE's own operator on the swapped pair (mf(S_disk, H1', H0') is the REBASE of (H1', H0') onto S_disk),
// so it runs through the shared RebaseCache: no merge-file runs on a binary or filtered path or with an ABSENT side (R3-18's
// whole-path rule decides), outputs are route (c) -w (R1 runs after an apply, a W6 occasion, R3-19), and a merge-file error is a
// HoldOperatorError (never a verdict). S_disk is the last materialized S_disk (05 §3.4). Nothing here reads claim state (HLD-06).
//
// OFF_DISK records are checked only when A[p] changed on one of their paths (the caller decides): one REBASE from the original
// pair; H1' == A everywhere → SUBSUMED (RESOLVED_PUBLISH when explicit), else nothing. They are never GONE-evaluated.
import { ABSENT, type OidOrAbsent } from '../git/oid.js';
import type { TreeMap } from '../git/repo.js';
import type { RebaseCache } from './rebase.js';
import { blobAt, guardName, setBlob, type BlobMap, type HoldRecord } from './record.js';

export type R1Verdict = 'CONFLICTED' | 'SUBSUMED' | 'RESOLVED_PUBLISH' | 'GONE' | 'ACTIVE' | 'HELD_BY_MARKERS';

const entryOf = (m: TreeMap, p: string): OidOrAbsent => m.get(p)?.oid ?? ABSENT;

/** H1'[p] == A[p] for every path of r. */
function subsumed(r: HoldRecord, h1p: BlobMap, A: TreeMap): boolean {
  return r.paths.every((p) => blobAt(h1p, p) === entryOf(A, p));
}

/**
 * The step-5 reverse merge of r alone, x[p] := mf(S_disk[p], H1'[p], H0'[p]) for every path of r: REBASE of the swapped pair
 * (H1', H0') onto S_disk through the shared cache (the same whole-path rule, route (c) -w outputs, HoldOperatorError). null on a
 * conflict. Also PARK's target for an ACTIVE PATCH (05 §3.4 item 3).
 */
export async function reverseAlone(r: HoldRecord, h0p: BlobMap, h1p: BlobMap, sDisk: TreeMap, cache: RebaseCache): Promise<BlobMap | null> {
  const swapped: HoldRecord = { ...r, blobs: { h0: h1p, h1: h0p } };
  const out = await cache.rebase(swapped, sDisk);
  return out.ok ? out.h1p : null;
}

/** HLD-32's publish-side transient guards: released by incomingStep when the path leaves the tick's exclusions, never by R1. */
const TRANSIENT: ReadonlySet<string> = new Set(['unreadable', 'unstable']);

/** The guards of a displacement that is not separable by a merge: a pending K4 / claim-breach TIP write, a base-move conflict (Table 1). */
const UNSEPARABLE: ReadonlySet<string> = new Set(['conflict', 'claim-breach', 'base-move']);

/**
 * R1 for an ON_DISK record: CONFLICTED (REBASE conflicts; a PIN's REBASE(H1); MASK's conflicts come from the caller) > SUBSUMED (H1' == A
 * ∀p; RESOLVED_PUBLISH when explicit) > GONE (PATCH: mf(S_disk, H1', H0') == S_disk ∀p for r alone, whatever its guard set, R3-17;
 * PIN: S_disk == A ∀p) > ACTIVE (a CONFLICTED PATCH whose reverse merge runs cleanly again, or a CONFLICTED PIN whose REBASE(H1) is
 * clean again, too; a reverse merge that cannot separate the held change keeps the record's state); a CONFLICTED record carrying
 * `conflict`, `claim-breach` or `base-move` stays CONFLICTED until SUBSUMED or GONE (S_disk == A ∀p); while `markers` holds →
 * HELD_BY_MARKERS; a marker companion → GONE once its markers released. A record with no path is ACTIVE (nothing to evaluate).
 * A guard-less PIN with S_disk == A ∀p ends before CONFLICTED: SUBSUMED (RESOLVED_PUBLISH) when H1' == A, else GONE (R3-FF5-B1).
 */
export async function evaluateOnDisk(r: HoldRecord, A: TreeMap, sDisk: TreeMap, cache: RebaseCache, explicit: boolean, companion: boolean): Promise<R1Verdict> {
  if (r.guards.some((g) => guardName(g) === 'markers')) return 'HELD_BY_MARKERS';
  // DAT-33 (Task 7 fix round 1): a record carrying `portability` holds a name the snapshot does not admit, so no S_disk has it
  // and R1 would read the held file as gone; the guard leaves exactly when D7 passes for the name (portabilityStep), and R1
  // runs from then on. Until then R1 keeps the record's state.
  if (r.guards.some((g) => guardName(g) === 'portability')) return r.state === 'CONFLICTED' ? 'CONFLICTED' : 'ACTIVE';
  // HLD-32 (Plan 3 Task EF): a publish-side transient PIN (`unreadable`, `unstable`) records an exclusion, not a held change — its
  // h1 is whatever blob the private index kept (A[p] itself for an edit no tick could stage, so step 2 would end it at once and the
  // next incomingStep would create it again, one PIN per loop for as long as the lock lasts). Its release is the condition clearing
  // (Table 3, `unreadable`: "path readable"), which incomingStep applies; until then R1 keeps its state: one op at creation, one at
  // release.
  if (r.guards.some((g) => TRANSIENT.has(guardName(g)))) return r.state === 'CONFLICTED' ? 'CONFLICTED' : 'ACTIVE';
  if (companion) return 'GONE';
  if (r.paths.length === 0) return 'ACTIVE';
  const diskIsA = (): boolean => r.paths.every((p) => entryOf(sDisk, p) === entryOf(A, p));
  const rb = await cache.rebase(r, A);
  // Integration I-6 (Ruling R3-FF5-B1, 05 §3.6 R1 amended): a guard-less PIN (a dependency, K6 claim or K7 t0 PIN whose guards all released)
  // whose disk is at A on every path ends before step 1 — SUBSUMED when its REBASE gives H1' == A (RESOLVED_PUBLISH when explicit),
  // else GONE. A PIN's held change is whole, and its R1 end is S_disk == A: with nothing of it left on disk there is nothing for a human
  // to resolve, so a REBASE conflict (an H1 that is not what landed — a join kept it while another record withheld the path, B3-2/F4,
  // or a same-line re-edit landed after the PIN's release) no longer leaves it CONFLICTED, withholding the path and pinning every later
  // group over it (R3-FF2-B0). The only verdict this changes: a guard-less PIN, REBASE conflicting, S_disk == A → GONE (was CONFLICTED).
  // A PIN carrying any guard is untouched. Precondition (verified for the ruling): no engine write sets an ON_DISK PIN's path to A while
  // the PIN stays ON_DISK without keeping its bytes — an apply defers or displaces it with a K4 record first (HLD-07 attaches a K4 to a
  // one-path PIN, which then carries `conflict`), --discard ends the record, PARK moves it OFF_DISK.
  if (r.kind === 'PIN' && r.guards.length === 0 && diskIsA()) return rb.ok && subsumed(r, rb.h1p, A) ? (explicit ? 'RESOLVED_PUBLISH' : 'SUBSUMED') : 'GONE';
  if (!rb.ok) return 'CONFLICTED';
  if (subsumed(r, rb.h1p, A)) return explicit ? 'RESOLVED_PUBLISH' : 'SUBSUMED';
  if (r.state === 'CONFLICTED' && r.guards.some((g) => UNSEPARABLE.has(guardName(g)))) return diskIsA() ? 'GONE' : 'CONFLICTED';
  if (r.kind === 'PIN') return diskIsA() ? 'GONE' : 'ACTIVE';
  // The reverse merge of r alone that cannot separate the held change is not GONE and changes nothing: on a text path a step-5
  // conflict of an ACTIVE PATCH is MASK's verdict (the caller passes MASK's conflicted ids, R3-62), a CONFLICTED PATCH stays
  // CONFLICTED, and on a binary or filtered path the whole-path rule withholds the path, never a conflict (R3-18).
  const x = await reverseAlone(r, rb.h0p, rb.h1p, sDisk, cache);
  if (x === null) return r.state === 'CONFLICTED' ? 'CONFLICTED' : 'ACTIVE';
  return r.paths.every((p) => blobAt(x, p) === entryOf(sDisk, p)) ? 'GONE' : 'ACTIVE';
}

/** OFF_DISK records only when A[p] changed on one of their paths: one REBASE from the original pair; H1' == A everywhere → SUBSUMED (RESOLVED_PUBLISH when explicit); else null (never GONE-evaluated, INV-HLD-OFFDISK). */
export async function evaluateOffDisk(r: HoldRecord, A: TreeMap, cache: RebaseCache, explicit: boolean): Promise<'SUBSUMED' | 'RESOLVED_PUBLISH' | null> {
  if (r.paths.length === 0) return null;
  const rb = await cache.rebase(r, A);
  if (!rb.ok || !subsumed(r, rb.h1p, A)) return null;
  return explicit ? 'RESOLVED_PUBLISH' : 'SUBSUMED';
}

/** A one-entry-per-path blob map of `paths` from a tree map (ABSENT where the tree lacks the path). */
export function blobMapOf(paths: readonly string[], m: TreeMap): BlobMap {
  const out: BlobMap = {};
  for (const p of paths) setBlob(out, p, entryOf(m, p));
  return out;
}
