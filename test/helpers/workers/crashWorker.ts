// Test-only region worker entry (Plan 4 Task 1): the real runWorkerLoop with its own handler table. In generation 0 the
// thread exits with code 3 on its first job (a worker that dies mid-job); every later generation answers every job
// {kind: 'ok', value: []}.
import { parentPort, workerData } from 'node:worker_threads';
import { runWorkerLoop } from '../../../src/regions/worker/main.js';
import type { WorkerInit } from '../../../src/regions/worker/protocol.js';
import { okHandlers } from './handlers.js';

const init = workerData as WorkerInit;
if (parentPort !== null) {
  const end = (): never => process.exit(1);
  runWorkerLoop(parentPort, init, okHandlers(() => {
    if (init.generation === 0) process.exit(3);
  })).then(end, end);
}
