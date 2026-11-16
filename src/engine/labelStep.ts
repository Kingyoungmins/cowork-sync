// The claim-view and label steps (R4-53, F04, F05, F12; REG-34) — Task 5's stubs; Task 13 fills them. Task 13's
// src/claims/labels.ts owns LabelVerifier, RegionNote, claimLabelText and the rest; these stubs delegate to it then.
import type { FoldState } from '../board/fold.js';
import type { PeerId } from '../board/ids.js';
import type { ClaimLabel } from '../board/ops.js';
import type { Oid } from '../git/oid.js';
import type { BlobRef } from '../regions/types.js';
import type { ClaimView, SeatKey, ViewClaim } from '../claims/types.js';
import type { EngineCore } from './core.js';

/** claimView over the fold at the leased tip: null until Task 13. */
export function claimViewStep(_core: EngineCore): ClaimView | null {
  return null;
}

/** The F05 reader-seat form: [] until Task 13. */
export function claimViewOfStep(_core: EngineCore, _reader: SeatKey): readonly ViewClaim[] {
  return [];
}

/** The verified label (REG-34's cache read, never a parse): null until Task 13. */
export function verifiedLabelStep(_core: EngineCore, _claimId: string, _anchor: Oid): ClaimLabel | null {
  return null;
}

/** R4-53: the HELD claims this peer holds in the state fold, by holder seat; null → 0. Task 13 fills the real count. */
export function claimsHeld(_state: FoldState | null, _self: PeerId): number {
  return 0;
}

/** The verdict data of /cowork show <claim> (04 §3.19): [] until Task 13. */
export async function claimNotesStep(_core: EngineCore, _claimId: string, _against?: BlobRef | 'ABSENT'): Promise<Array<{ readonly code: string; readonly params: Record<string, unknown> }>> {
  return [];
}

/** Schedules the re-derivations of newly folded claim ops (Task 13); Task 5's stub is the prepareIteration call site. */
export function labelStep(_core: EngineCore, _outcome: unknown): void {
  // no-op until Task 13
}
