// ObservedWrites (05-holds HLD-26 (b); 01-engine §3.11, ENG-37; ruling R3-36): every Plan 3 writeLocal/writeLocalGroup write —
// park, the markers park, S6 and the stop park, restore, the collision take, --discard, the DAT-08 repair — is recorded after
// WRITTEN by path and written blob, so the detectors treat a snapshot delta landing exactly on it as observed (the mass-change
// breaker peeks at every detection tick; the revert detector takes the entry at the materialization). In memory: a restart starts
// empty. The park family's writes survive a restart through the private-index entry and the snap transition instead (R3-60), and a
// RESTORE's through local.json's `restored` entry, which the restart re-seeds here after its reseed from state:snap
// (reseedRestoredWrites, E16-E: a lost restore entry made the next materialized delta of p judged from state:snap's entry, and for a
// conflicted restore a `revert` record whose H1 carried the restore's marker rows aborted every publish window on ENG-41 (j) — not
// the "safe direction" R3-36 had accepted). A lost entry of a collision take still makes the next materialized delta of p judged from
// the private-index entry (R3-36's accepted cost; the snapshot skips p while the collision record lives). One entry per path: a newer
// write of the same path replaces the older one.
//
// Plan 3 final review F1: an entry lives only until the write it names can no longer appear as a delta. The park family, --discard
// and the DAT-08 repair set the private-index entry to the written blob (Snapshotter.setEntry), so their write is never a
// materialized delta: they forget the entry right after setEntry (parkWritten, repairStep). And the revert detector's read is one-shot
// per path: the first materialized delta of p ends p's entry whether or not it lands on it (the disk moved past the write). Without
// either, a lingering entry made a later stale save of the same blob — an older team version, after an apply moved A — pass as
// observed, and the revert detector missed the removal of a teammate's later line (HLD-27, HLD-28, INV-HLD-NOREVERT).
// EF4 round 2 I2-2 (ruling R3-EF4-21): an apply that moves p's private-index entry (a verified write's round trip, a verified deletion,
// a DAT-26/R3-33 index-only entry) — and the restart's apply decision — forgets p's entry too. A disk back at the indexed bytes before
// the next materialization (a stale save or an undo after a restore, or a collision take the snapshot skipped) never has its entry
// taken; left past the apply, R3-EF4-13's `take` re-based the next delta on that older blob, and a removal of the row the apply brought
// in made no `revert` record.
//
// EF4 round 2 R-2 (ruling R3-EF4-13, 05 §3.6 D2 step 1): a materialized delta of p that does not land on p's recorded write (the
// human edited a restore's result before the next materialization, glossary §26.1 W6) is judged from the written blob, not from the
// private-index entry: the write itself is observed (HLD-26 (b)), only the change after it is not. `take` hands the revert detector
// the written blob for that; judged from the private-index entry, a conflicted restore's own marker rows became a `revert` record's
// H1 (seed meas-holds-18: a second revert record, HOLD_MASK_INVALID after a K4, ENG-41 (j) on every publish while it lived).
import type { OidOrAbsent } from '../git/oid.js';

export class ObservedWrites {
  private readonly writes = new Map<string, OidOrAbsent>();

  /** p was written with `written` (ABSENT for a deletion) by an attributed local write. */
  record(path: string, written: OidOrAbsent): void {
    this.writes.set(path, written);
  }

  /**
   * The materialized snapshot delta of path moved it to `next`: true when that lands exactly on a recorded write (observed once).
   * One-shot (final review F1): p's entry ends at its first materialized delta either way.
   */
  consume(path: string, next: OidOrAbsent): boolean {
    const hit = this.peek(path, next);
    this.writes.delete(path);
    return hit;
  }

  /**
   * EF4 round 2 R-2 (ruling R3-EF4-13; HLD-26 (b)): p's recorded write (one-shot, like consume: p's entry ends here), or undefined when
   * none is recorded. The revert detector takes it at p's materialized delta: a delta landing on it is observed, any other is judged
   * from the written blob (only the change after the write is unobserved). Additive to the contract's interface (as forget is).
   */
  take(path: string): OidOrAbsent | undefined {
    const w = this.writes.get(path);
    this.writes.delete(path);
    return w;
  }

  /** consume without forgetting: the breaker reads it at detection ticks, the revert detector takes at the materialization (Task 8, R-2). */
  peek(path: string, next: OidOrAbsent): boolean {
    return this.writes.has(path) && this.writes.get(path) === next;
  }

  /** Final review F1: p's write can never be a materialized delta (its private-index entry holds the written blob): its entry ends. */
  forget(path: string): void {
    this.writes.delete(path);
  }
}
