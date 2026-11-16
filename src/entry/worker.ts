// Entry point for dist/worker.js (glossary §6). As a process it keeps Plan 1's stub contract: `--version` prints the
// version, anything else is a no-op that exits at once (it waits for no message). As a worker thread it is the region
// worker (04-regions §3.1, REG-31): it serves runWorkerLoop(parentPort, workerData) behind the entry's one job-kind
// table (X-37) — a job of a kind the table does not register is answered {kind: 'crashed'} (marked unregistered),
// reaches no handler and stops nothing: the loop goes on and the pool keeps the worker (no exit, no respawn).
// Plan 7 Task 4 appends its own kind ('secret_scan') to WORKER_JOB_KINDS for its separate pool instance; the region
// pool's terminate/respawn (R4-15) never touches it.
import { isMainThread, parentPort, workerData, type MessagePort } from 'node:worker_threads';
import type { RegionJob } from '../regions/pool.js';
import { runWorkerLoop } from '../regions/worker/main.js';
import type { FromWorker, WorkerInit, WorkerPortLike } from '../regions/worker/protocol.js';
import { PLUGIN_VERSION } from '../version.js';

/** X-37: the entry's one job-kind table — each registered kind and the loop that serves it. src/regions/worker/jobs.ts is reached only through it. */
export const WORKER_JOB_KINDS: Readonly<Record<string, 'region'>> = Object.freeze({
  table: 'region',
  hunks: 'region',
  map: 'region',
  fold_overlap: 'region',
  sites: 'region',
  label_at: 'region',
} satisfies Record<RegionJob['kind'], 'region'>);

/** The job kind of a {type: 'job'} message, else undefined. */
function jobKind(m: unknown): { id: unknown; kind: unknown } | undefined {
  if (typeof m !== 'object' || m === null || (m as { type?: unknown }).type !== 'job') return undefined;
  const job = (m as { job?: unknown }).job;
  return { id: (m as { id?: unknown }).id, kind: typeof job === 'object' && job !== null ? (job as { kind?: unknown }).kind : undefined };
}

/** The region loop's view of the port: job messages of a registered region kind pass; any other job is answered crashed here, marked unregistered, and the loop never sees it. */
function regionPort(port: MessagePort): WorkerPortLike {
  return {
    on(_ev: 'message', cb: (m: unknown) => void): void {
      port.on('message', (m: unknown) => {
        const job = jobKind(m);
        if (job === undefined) return;
        const serving = typeof job.kind === 'string' && Object.hasOwn(WORKER_JOB_KINDS, job.kind) ? WORKER_JOB_KINDS[job.kind] : undefined;
        if (serving === 'region') {
          cb(m);
          return;
        }
        if (typeof job.id === 'number') port.postMessage({ type: 'result', id: job.id, result: { kind: 'crashed' }, unregistered: true } satisfies FromWorker);
      });
    },
    postMessage(m: FromWorker): void {
      port.postMessage(m);
    },
  };
}

if (isMainThread) {
  if (process.argv.slice(2).includes('--version')) {
    process.stdout.write(`cowork-sync worker ${PLUGIN_VERSION}\n`);
  }
} else if (parentPort !== null) {
  // The loop resolves only after a handler throw (an unregistered kind never reaches it): the thread ends and the pool
  // replaces it (R4-15).
  const end = (): never => process.exit(1);
  runWorkerLoop(regionPort(parentPort), workerData as WorkerInit).then(end, end);
}
