// The containment form of touch (04-regions §3.6 "Containment form"; glossary §1 S5; REG-33, REG-13): whether a hunk lies
// entirely inside this seat's own claims O, the wake work set's part (b). It reuses touch's inputs — the same REG-07 local-mode
// mapping into A[p], the same post-image table and touch's step-4 extent test (imageExtent) — and never consults the hold
// registry, unit names or the group-name rule. It only narrows: every uncertainty is "not contained". The caller builds O (HELD
// non-STALE and confirmed TENTATIVE claims of the seat on p as of the Pre or TXN open, minus every claim first confirmed during
// the current wake turn, no tombstones) and passes nothing for a path that is not LIVE.
import { normalizeRanges } from './lines.js';
import { imageExtent } from './touch.js';
import type { Granularity, Hunk, Range, Ranges, TableOrNone } from './types.js';

export interface OwnClaimImage { readonly granularity: Granularity; readonly inBase: Ranges | 'WHOLE_FILE'; readonly inPost: Ranges | 'TOMBSTONE' | 'WHOLE_FILE'; }

/** Every row of the closed interval [lo, hi] lies in `within` (normalized, so a run of rows inside the union lies in one interval). */
function inside([lo, hi]: Range, within: Ranges): boolean {
  return within.some(([wlo, whi]) => wlo <= lo && hi <= whi);
}

/** k is a boundary of some range: k == hi or k == lo − 1. */
const boundaryOf = (k: number, rs: Ranges): boolean => rs.some(([lo, hi]) => k === hi || k === lo - 1);

/** Conditions (1)–(4): a WHOLE_FILE own claim adds nothing to U; a boundary insertion decided only by an ERROR span or NO_TABLE, a group-name hit and every uncertainty are not contained. */
export function contained(h: Hunk, own: readonly OwnClaimImage[], post: TableOrNone): boolean {
  // (1) an own file claim contains every hunk on its path
  if (own.some((o) => o.granularity === 'file')) return true;
  const mapped = own.flatMap((o) => (o.inBase === 'WHOLE_FILE' ? [] : [{ inBase: normalizeRanges(o.inBase), inPost: o.inPost }]));
  const U = normalizeRanges(mapped.flatMap((o) => o.inBase));
  if (U.length === 0) return false;
  // (2) a deletion or modification: every base row it removes lies in U
  if (h.aLo <= h.aHi) return inside([h.aLo, h.aHi], U);
  const k = h.aHi;   // a pure insertion after base row k
  // (3) strictly inside a range of U
  if (U.some(([lo, hi]) => lo <= k && k < hi)) return true;
  // (4) at a boundary of U, every inserted row inside the post extent of the leaf unit holding that claim's image
  if (!boundaryOf(k, U) || h.bLo > h.bHi) return false;
  for (const o of mapped) {
    if (!boundaryOf(k, o.inBase) || o.inPost === 'WHOLE_FILE') continue;
    const extent = imageExtent(post, o.inPost);
    if (extent !== null && inside([h.bLo, h.bHi], extent)) return true;
  }
  return false;
}
