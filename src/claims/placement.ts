// Placement (04 §3.8; REG-24, ENG-29; R4-48) — Task 5 declares PlacementInput (type only); Task 15 adds placementCheck.
import type { TreeView } from '../regions/types.js';
import type { GateResult, SeatKey, ClaimView } from './types.js';

/** The trees of one merge and the fence data of a publish (null in apply). */
export interface PlacementInput { readonly base: TreeView; readonly ours: TreeView; readonly theirs: TreeView; readonly out: TreeView; readonly paths: readonly string[]; readonly fence: { readonly gate: GateResult; readonly view: ClaimView; readonly publishingSeats: readonly SeatKey[] } | null; }
