// The 'hunks' job: FoldMapper/1 hunks of two line arrays (04 §3.4; REG-07). The rows arrive as Buffer views (main.ts revives posted
// Uint8Arrays); the result is the direct function's.
import { hunks } from '../../mapper.js';
import type { RegionJob } from '../../pool.js';
import type { Hunk } from '../../types.js';
import type { JobCtx } from '../jobs.js';

export async function handle(job: Extract<RegionJob, { kind: 'hunks' }>, _ctx: JobCtx): Promise<Hunk[] | 'deadline'> {
  return hunks(job.from, job.to);
}
