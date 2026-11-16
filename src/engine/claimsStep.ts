// The claim steps (CONFIRM + CLAIM; drafts to the store; R4-28) — Task 5 creates the stubs; Task 11 fills the
// bodies, Task 12 predictRevertStep. No stub step is called from the Plan 2/3 pipeline until its owning task
// wires it; claimRejectionStep is the one exception (the call site sits in prepareIteration over this no-op stub).
import type { Oid } from '../git/oid.js';
import type { TreeMap } from '../git/repo.js';
import type { EngineCore } from './core.js';
import type { RevertPrediction } from '../claims/revertPredict.js';
import type { ConfirmResult, PredictQuery, PredictResult, SeatEffect } from '../claims/types.js';

/** CONFIRM (04 §3.11): stable or deferred; Task 11 fills it. */
export async function seatEffectStep(_core: EngineCore, _e: SeatEffect): Promise<ConfirmResult> {
  throw new Error('seatEffectStep not bound before Task 11');
}

/** PREDICT (04 §3.11): the locate and the touch decision; Task 11 fills it. */
export async function predictStep(_core: EngineCore, _q: PredictQuery): Promise<PredictResult> {
  throw new Error('predictStep not bound before Task 11');
}

/**
 * Once per iteration after the fold (R4-28): own claim-op rejections → store blocks and CLAIM_REJECTED raises.
 * Task 5 places the prepareIteration call site over this no-op stub; Task 11 fills the body.
 */
export function claimRejectionStep(_core: EngineCore): void {
  // no-op until Task 11
}

/** CONFIRM step 1: a deferred confirm runs at the CS boundary with R[p] as post-image (Task 11). */
export async function settleDeferredConfirms(_core: EngineCore, _csId: string, _R: TreeMap): Promise<void> {
  // resolves until Task 11
}

/** REV step 6's prediction (Task 12). */
export async function predictRevertStep(_core: EngineCore, _results: ReadonlyMap<string, Buffer | 'ABSENT'>, _tip: Oid): Promise<RevertPrediction> {
  throw new Error('predictRevertStep not bound before Task 12');
}
