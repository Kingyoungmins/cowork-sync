// inlineWorkers (04-regions §3.1; R4-13, TST-03): the region job handlers on the calling thread — unit tests and SIM
// only; never imported by src/daemon or src/engine (L-REGION-DEPS: no src/** module imports this file).
import type { Deadline } from '../budgets.js';
import { workerInitOf, type JobResult, type RegionJob, type RegionWorkers, type WorkerPriority } from '../pool.js';
import type { RegionRuntime } from '../runtime.js';
import { runJob, type JobHandlers } from './jobs.js';
import { initParser } from './parser.js';

/** The same handlers on the calling thread, FIFO, deterministic; the caller's Deadline object is passed into the handler, so under a VirtualClock only an injected overrun expires.
 *  A job whose deadline is already expired at dispatch resolves {kind: 'deadline'} without running its handler (as threadWorkers abandons it); a handler that throws resolves
 *  {kind: 'crashed'}. o.handlers (tests only) replaces the named kinds' handlers, so Task 1's pool tests never depend on what a production handler returns. */
export async function inlineWorkers(runtime: RegionRuntime, o?: { handlers?: Partial<JobHandlers> }): Promise<RegionWorkers> {
  const parser = await initParser(workerInitOf(runtime, 'fg', 0), runtime.querySources);
  let tail: Promise<unknown> = Promise.resolve();
  let closed = false;

  const runOne = async <J extends RegionJob>(job: J, deadline: Deadline | null): Promise<JobResult<J>> => {
    if (closed) return { kind: 'crashed' };
    if (deadline !== null && deadline.expired()) return { kind: 'deadline' };
    try {
      const out = await runJob(job, { parser, deadline }, o?.handlers);
      return out === 'deadline' ? { kind: 'deadline' } : { kind: 'ok', value: out };
    } catch {
      return { kind: 'crashed' };
    }
  };

  return {
    run<J extends RegionJob>(job: J, _priority: WorkerPriority, deadline: Deadline | null): Promise<JobResult<J>> {
      const result = tail.then(() => runOne(job, deadline));
      tail = result;
      return result;
    },
    availability: () => parser.availability(),
    /** Runs nothing more, waits for the queued jobs, then disposes the parser host (its Parsers, Queries and live Trees live in the realm's one wasm heap). */
    async close(): Promise<void> {
      closed = true;
      await tail;
      parser.dispose();
    },
  };
}
