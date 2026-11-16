// Test-only region worker entry (Plan 4 Task 1): the real runWorkerLoop with its own handler table. A 'hunks' job
// busy-waits from.length ms, then answers one hunk {aLo: 0 on fg | 1 on bg, aHi: this worker's job sequence, bLo: 0,
// bHi: 0}; every other kind answers {kind: 'ok', value: []}.
import { parentPort, workerData } from 'node:worker_threads';
import type { RegionJob } from '../../../src/regions/pool.js';
import { runWorkerLoop } from '../../../src/regions/worker/main.js';
import type { WorkerInit } from '../../../src/regions/worker/protocol.js';
import { busyWait, okHandlers } from './handlers.js';

const init = workerData as WorkerInit;
let sequence = 0;
if (parentPort !== null) {
  const end = (): never => process.exit(1);
  runWorkerLoop(parentPort, init, okHandlers(undefined, {
    hunks: async (job: RegionJob) => {
      busyWait(job.kind === 'hunks' ? job.from.length : 0);
      sequence += 1;
      return [{ aLo: init.name === 'fg' ? 0 : 1, aHi: sequence, bLo: 0, bHi: 0 }];
    },
  })).then(end, end);
}
