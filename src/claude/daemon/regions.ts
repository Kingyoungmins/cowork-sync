// src/claude/daemon/regions.ts — the Plan 4 port (04 §3.1, REG-19, REG-28…REG-35). X-20: Plan 4's API is the contract;
// the types are structural copies (declared in claudeDaemon.ts) so Plan 5 compiles before Plan 4 merges; Task 18's
// type-level test pins Plan 4's exports assignable to them. src/claude/daemon/regions.ts is the only Plan 5 file
// importing src/regions/** or src/claims/** (Task 18). Phase 1: claimLabelText, foreignHeldOnPath and the REAL noRegions
// (X-22 shape); the plan4Regions binding is Task 18.
import { claimLabelText, type RegionsPort, type SeatKeyCopy, type ClaimLabelCopy, type PredictResultCopy, type SeatEffectCopy, type ConfirmResultCopy, type DraftCopy, type ClaimViewCopy, type ViewClaimCopy, type ReleaseReasonCopy } from './claudeDaemon.js';
import type { Ranges } from '../../regions/types.js';

export { claimLabelText };
export type { RegionsPort, SeatKeyCopy, ClaimLabelCopy };

/** X-20's noRegions (REAL, X-22 shape): no claims exist before Plan 4; every value is Plan 4-shaped. predict →
 *  {status: 'undecided', diskLines: [], hunksInBase: [], touches: [], moved: null, fallbackUsed: false, ownTouches: [],
 *  ownContained: false}; seatEffect → {status: 'confirmed', hunksInBase: the pre→post hunks, touches: [], drafts: [],
 *  notOwnContained: every hunk}; claimView → null; claimViewOf → []; mapRanges(from, to, ranges, 'local') → ranges
 *  unchanged (A12-7: nothing to re-anchor, the last maskStep ranges stay, R5-31); verifiedLabel → null; claimNotes → [];
 *  releaseClaims → {drafts: [], refused: every named id with why 'not_own'} ('all' → nothing to release). */
export const noRegions: RegionsPort = Object.freeze({
  predict: async (_q: import('./claudeDaemon.js').PredictQueryCopy): Promise<PredictResultCopy> =>
    ({ status: 'undecided', diskLines: [], hunksInBase: [], touches: [], moved: null, fallbackUsed: false, ownTouches: [], ownContained: false }),
  seatEffect: async (e: SeatEffectCopy): Promise<ConfirmResultCopy> => {
    const preRows = e.pre === 'ABSENT' ? [] : rangeOf(e.pre);
    const hunks: import('../../regions/types.js').Hunk[] = preRows.length === 0 ? [] : [{ aLo: preRows[0]![0], aHi: preRows[0]![1], bLo: preRows[0]![0], bHi: preRows[0]![1] }];
    return { status: 'confirmed', hunksInBase: hunks, touches: [], drafts: [], notOwnContained: hunks };
  },
  claimView: (): ClaimViewCopy | null => null,
  claimViewOf: (_reader: SeatKeyCopy): readonly ViewClaimCopy[] => [],
  mapRanges: async (_from: unknown, _to: unknown, ranges: Ranges, _mode: 'local'): Promise<Ranges | 'TOMBSTONE' | 'WHOLE_FILE'> => ranges,
  verifiedLabel: (_claimId: string, _anchor: never): ClaimLabelCopy | null => null,
  claimNotes: async (_claimId: string, _against?: never): Promise<ReadonlyArray<{ code: string; params: import('./claudeDaemon.js').Params }>> => [],
  releaseClaims: (_holder: SeatKeyCopy, _reason: ReleaseReasonCopy, target: readonly string[] | 'all'): { drafts: readonly DraftCopy[]; refused: ReadonlyArray<{ claimId: string; why: 'not_own' | 'unlanded' }> } =>
    ({ drafts: [], refused: target === 'all' ? [] : target.map((claimId) => ({ claimId, why: 'not_own' as const })) }),
});

/** A BlobRef names no row range (only content); noRegions' seatEffect has no hunks to derive. */
function rangeOf(_ref: unknown): ReadonlyArray<readonly [number, number]> {
  return [];
}


/** Plan 5-local, off the port (X-20; Plan 4 C-5): shell class (c)'s "a literal target holds a foreign HELD claim",
 *  computed from claimViewOf(reader). */
export function foreignHeldOnPath(_regions: RegionsPort, _reader: SeatKeyCopy, _path: string): boolean {
  throw new Error('Plan 5 Task 10');
}
