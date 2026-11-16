// Shared by the test-only worker entries: handler tables that never reach a production handler, so the pool tests stay
// green while Tasks 3–13 fill src/regions/worker/jobs/*.ts.
import type { RegionJob } from '../../../src/regions/pool.js';
import type { JobHandlers } from '../../../src/regions/worker/jobs.js';

export const JOB_KINDS: readonly RegionJob['kind'][] = ['table', 'hunks', 'map', 'fold_overlap', 'sites', 'label_at'];

type Handler = (job: RegionJob) => Promise<unknown>;

/** Every kind answers {kind: 'ok', value: []} after `before(job)` ran; `own` replaces single kinds. */
export function okHandlers(before?: (job: RegionJob) => void, own: Partial<Record<RegionJob['kind'], Handler>> = {}): Partial<JobHandlers> {
  const answer: Handler = async (job) => {
    before?.(job);
    return [];
  };
  return Object.fromEntries(JOB_KINDS.map((k) => [k, own[k] ?? answer])) as unknown as Partial<JobHandlers>;
}

/** Busy-waits ms on this thread (a worker that is busy, not asleep). */
export function busyWait(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // spin
  }
}
