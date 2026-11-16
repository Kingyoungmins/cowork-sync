// Test-only region worker entry (Plan 4 Task 1): generation 0 runs the real runWorkerLoop with its own handler table —
// on fg it exits with code 3 on its first job, on bg it answers every job {kind: 'ok', value: []}; generation 1 exits
// with code 5 before its ready message (a transient respawn failure); generation 2 and later answer every job
// {kind: 'ok', value: []}.
import { parentPort, workerData } from 'node:worker_threads';
import { runWorkerLoop } from '../../../src/regions/worker/main.js';
import type { WorkerInit } from '../../../src/regions/worker/protocol.js';
import { okHandlers } from './handlers.js';

const init = workerData as WorkerInit;
if (parentPort !== null) {
  if (init.generation === 1) process.exit(5);
  const end = (): never => process.exit(1);
  runWorkerLoop(parentPort, init, okHandlers(() => {
    if (init.generation === 0 && init.name === 'fg') process.exit(3);
  })).then(end, end);
}
