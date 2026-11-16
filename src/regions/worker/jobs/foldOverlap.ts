// The 'fold_overlap' job: foldOverlap answers for one board commit's claim pairs (04 §3.9; REG-23). A Task 1 stub; Task 8 fills it.
import type { RegionJob } from '../../pool.js';
import type { JobCtx } from '../jobs.js';

export async function handle(_job: Extract<RegionJob, { kind: 'fold_overlap' }>, _ctx: JobCtx): Promise<boolean[] | 'deadline'> {
  throw new Error('job fold_overlap: Task 8');
}
