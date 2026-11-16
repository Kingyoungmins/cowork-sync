// EMIT (04 §3.5): claim fills, the precheck and the local-only and drift decisions of Algorithm P — Task 5's stub;
// Task 14 fills it.
import type { Oid } from '../git/oid.js';
import type { TreeMap } from '../git/repo.js';
import type { EngineCore, IterationCtx } from './core.js';

export async function emitStep(_core: EngineCore, _it: IterationCtx, _b: { liveCode: Oid; liveTree: TreeMap; changedPaths: ReadonlySet<string> }): Promise<{ blocked: Array<{ csId: string; overlaps: string; claimId: string; path: string }>; filled: string[] }> {
  return { blocked: [], filled: [] };   // no-op until Task 14
}
