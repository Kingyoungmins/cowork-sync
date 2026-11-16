// The revert prediction (05 REV step 6; REG-35 and REG-36 F10 clauses; R4-46) — Task 5 declares RevertPrediction
// (type only); Task 12 adds predictRevert.
import type { EditCheckEntry } from '../regions/editCheck.js';
import type { GateBlocked } from './types.js';

export interface RevertPrediction { readonly wouldHold: readonly GateBlocked[]; readonly wouldBreak: readonly EditCheckEntry[]; }
