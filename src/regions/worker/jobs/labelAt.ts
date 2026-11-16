// The 'label_at' job: the label of the unit at one row, for label verification (04 §3.17; REG-34). A Task 1 stub; Task 13 fills it.
import type { RegionJob } from '../../pool.js';
import type { Label } from '../../types.js';
import type { JobCtx } from '../jobs.js';

export async function handle(_job: Extract<RegionJob, { kind: 'label_at' }>, _ctx: JobCtx): Promise<Label | null | 'deadline'> {
  throw new Error('job label_at: Task 13');
}
