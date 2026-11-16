// The 'map' job: FoldMapper/1 mapRanges in fold or local mode (04 §3.4; REG-07). Fold mode has no time cap and ignores the job's
// deadline; local mode adapts JobCtx.deadline ({expired()} | null; null never expires) to a 'map' Deadline (ruling PF-11), so an
// expired one returns WHOLE_FILE — the handler itself never answers 'deadline' (the pool abandons a job expired at dispatch).
import { BUDGETS, type Deadline } from '../../budgets.js';
import { mapRangesLines } from '../../mapper.js';
import type { RegionJob } from '../../pool.js';
import type { MapResult } from '../../types.js';
import type { JobCtx } from '../jobs.js';

/** JobCtx.deadline as a Deadline of kind 'map': mapRangesLines' local overload reads only expired() (PF-11). */
function mapDeadline(d: JobCtx['deadline']): Deadline {
  const expired = (): boolean => d !== null && d.expired();
  return Object.freeze({
    kind: 'map',
    budgetMs: BUDGETS.mapLocalMs,
    expired,
    remainingMs: (): number => (expired() ? 0 : BUDGETS.mapLocalMs),
  });
}

export async function handle(job: Extract<RegionJob, { kind: 'map' }>, ctx: JobCtx): Promise<MapResult | 'deadline'> {
  if (job.mode === 'fold') return mapRangesLines(job.from, job.to, job.ranges, 'fold');
  return mapRangesLines(job.from, job.to, job.ranges, 'local', mapDeadline(ctx.deadline));
}
