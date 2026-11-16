// Test-only region worker entry (Plan 4 Task 1): the real runWorkerLoop with a handler table whose 'hunks' handler
// throws (every other kind answers {kind: 'ok', value: []}); the thread ends the way src/entry/worker.ts ends it.
import { parentPort, workerData } from 'node:worker_threads';
import { runWorkerLoop } from '../../../src/regions/worker/main.js';
import type { WorkerInit } from '../../../src/regions/worker/protocol.js';
import { okHandlers } from './handlers.js';

if (parentPort !== null) {
  const end = (): never => process.exit(1);
  runWorkerLoop(parentPort, workerData as WorkerInit, okHandlers(undefined, {
    hunks: async () => {
      throw new Error('throwWorker: hunks');
    },
  })).then(end, end);
}
