// The merge-side region hooks (D8 steps 0a and 4, D9; Task 15's real checks), the placement and the breach steps —
// Task 5's stubs; Task 15 fills them.
import type { ConflictCtx } from '../data/conflict.js';
import type { Oid } from '../git/oid.js';
import type { EngineCore, IterationCtx } from './core.js';
import type { BreachHit } from '../claims/types.js';
import type { PlacementFailure } from '../claims/types.js';
import type { PlacementInput } from '../claims/placement.js';

/**
 * The four ConflictCtx hooks with Plan 2's answers (no grammar, no separator rows, the tripwire passes, the
 * tie-break is K4): installed nowhere until Task 15 wires them; the stub's shape pins the Required Pick.
 */
export function regionConflictHooks(_core: EngineCore, _it: IterationCtx): Required<Pick<ConflictCtx, 'hasGrammar' | 'need' | 'tripwire' | 'tieBreak'>> {
  return {
    hasGrammar: (_path: string): boolean => false,
    need: (_path: string, _s2: unknown, _firstNonBlankRow: number): Promise<0 | 1 | 2> => Promise.resolve(0),
    tripwire: (_path: string, _s3: unknown, _s2: unknown, _out: Buffer): Promise<boolean> => Promise.resolve(true),
    tieBreak: (_path: string, _s1: unknown, _s2: unknown, _s3: unknown): Promise<'k4' | 'breach'> => Promise.resolve('k4'),
  };
}

/** Placement (04 §3.8) over one merge's trees: [] until Task 15. */
export async function placementStep(_core: EngineCore, _it: IterationCtx, _use: 'apply' | 'publish', _inp: PlacementInput): Promise<PlacementFailure[]> {
  return [];
}

/** The breach walk over (LA_C, TIP] first-parent live commits: [] until Task 15. */
export async function breachStep(_core: EngineCore, _it: IterationCtx, _laC: Oid): Promise<BreachHit[]> {
  return [];
}
