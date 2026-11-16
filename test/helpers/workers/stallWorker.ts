// Test-only region worker entry (Plan 4 Task 1): the real runWorkerLoop with its own handler table. A 'map' job
// busy-waits forever (a worker that never answers, so only the pool's terminate ends it); every other kind answers
// {kind: 'ok', value: []}.
import { parentPort, workerData } from 'node:worker_threads';
import { runWorkerLoop } from '../../../src/regions/worker/main.js';
import type { WorkerInit } from '../../../src/regions/worker/protocol.js';
import { okHandlers } from './handlers.js';

if (parentPort !== null) {
  const end = (): never => process.exit(1);
  runWorkerLoop(parentPort, workerData as WorkerInit, okHandlers(undefined, {
    map: async () => {
      for (;;) {
        // stalled: never yields
      }
    },
  })).then(end, end);
}
