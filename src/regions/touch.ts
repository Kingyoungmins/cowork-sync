// The one touch predicate (04-regions §3.6; REG-13, REG-14, REG-04; T-REG-02, TC-REG-02): whether a hunk of
// diff(base[p], post[p]) lies in a claim. Pure and synchronous: the caller maps the claim into base coordinates (REG-07 local
// mode into A[p], tombstones included), images it into post through hunks(base, post), builds the post-image table and computes
// the step-5 group-name hit from this daemon's own tables (groupName.ts). touch reads no hold registry, no own-claims input and
// no unit name; every consumer (predict, confirm, gate, placementCheck (b), breach, the D8 step-4 tie-break, the HLD dependency
// scan) calls it, and contained.ts reuses its step-4 extent test (imageExtent).
import { normalizeRanges, rangesIntersect } from './lines.js';
import type { Granularity, Hunk, Ranges, TableOrNone, TouchReason } from './types.js';

export type { TouchReason } from './types.js';   // declared in src/regions/types.ts (Task 1)

/** The claim as touch sees it: granularity and regionSpec only; no registry, no own-claims input, labels only through step 5's precomputed hit (REG-13, REG-14). */
export interface TouchClaim { readonly granularity: Granularity; readonly regionSpec: string; }
export interface TouchInput {
  readonly inBase: Ranges | 'WHOLE_FILE';                   // the claim (ranges and tombstones) mapped into base[p] by REG-07 local mode
  readonly inPost: Ranges | 'TOMBSTONE' | 'WHOLE_FILE';      // its image in post[p] through hunks(base, post) (step 4's "leaf unit containing c's image")
  readonly post: TableOrNone;
  readonly groupNameHit: boolean;                           // step 5 (groupName.ts)
}

const verdict = (reason: TouchReason): { touch: boolean; reason: TouchReason } => ({ touch: reason !== 'none', reason });

/**
 * Step 4's extent (04 §3.6 step 4, first bullet; 04 §3.3 extent-convention/1): the rows of the post-image leaf units that contain
 * the claim's image — the union of the ranges of every post leaf unit intersecting the image (for a block claim the blank-line
 * or gap block holding it). null when the post image has no table; [] for a TOMBSTONE image (nothing of the claim is left in
 * post). The caller decides a WHOLE_FILE image (touch: P2 touch; contained: not contained).
 */
export function imageExtent(post: TableOrNone, image: Ranges | 'TOMBSTONE'): Ranges | null {
  if (!('units' in post)) return null;
  if (image === 'TOMBSTONE') return [];
  return normalizeRanges(post.units.filter((u) => u.leaf && rangesIntersect(u.ranges, image)).flatMap((u) => u.ranges));
}

/**
 * Steps 1–6 in order; every consumer calls it: predict, confirm, gate, placementCheck (b), breach, the D8 step-4 tie-break, the HLD dependency scan.
 * Step 4 touches when any inserted post row lies in imageExtent (a hunk that extends the claimed unit touches it even when it also adds rows
 * outside it), an ERROR/MISSING span covers any inserted row, or the post image has no table; a WHOLE_FILE image cannot place the claim in
 * post, so a boundary insertion against it touches with reason degraded-whole-file (P2).
 */
export function touch(h: Hunk, c: TouchClaim, inp: TouchInput, ownRegionSpec: string): { touch: boolean; reason: TouchReason } {
  // 1. a claim written under another regionSpec, a WHOLE_FILE mapping or a file claim touches every hunk (REG-04)
  if (c.regionSpec !== ownRegionSpec || inp.inBase === 'WHOLE_FILE' || c.granularity === 'file') return verdict('degraded-whole-file');
  const claimed = normalizeRanges(inp.inBase);
  if (h.aLo <= h.aHi) {
    // 2. the hunk deletes or modifies a claimed base row
    if (rangesIntersect(claimed, [[h.aLo, h.aHi]])) return verdict('base-overlap');
  } else {
    const k = h.aHi;   // a pure insertion after base row k
    // 3. strictly inside a claimed range
    if (claimed.some(([lo, hi]) => lo <= k && k < hi)) return verdict('insert-inside');
    // 4. at a boundary: k == hi or k == lo − 1
    if (claimed.some(([lo, hi]) => k === hi || k === lo - 1)) {
      const reason = boundary(h, inp);
      if (reason !== null) return verdict(reason);
    }
  }
  // 5. a group-name hit (REG-17)
  if (inp.groupNameHit) return verdict('group-name');
  // 6.
  return verdict('none');
}

/** Step 4's three bullets for a boundary insertion; null when none holds. */
function boundary(h: Hunk, inp: TouchInput): TouchReason | null {
  if (!('units' in inp.post)) return 'boundary-no-table';
  if (h.bLo > h.bHi) return null;   // no inserted row (a hunk is never empty)
  const inserted: Ranges = [[h.bLo, h.bHi]];
  if (inp.inPost === 'WHOLE_FILE') return 'degraded-whole-file';
  const extent = imageExtent(inp.post, inp.inPost) as Ranges;
  if (rangesIntersect(extent, inserted)) return 'boundary-in-extent';
  if (rangesIntersect(inp.post.errorSpans, inserted)) return 'boundary-in-error';
  return null;
}
