// The region worker's message loop (04-regions §3.1, §3.18; REG-31; R4-12, R4-15). Only src/entry/worker.ts imports
// node:worker_threads on the worker side; it calls runWorkerLoop with its parentPort (behind its job-kind table, X-37)
// and workerData. Jobs run one at a time in arrival order.
import { realClock } from '../../ports/clock.js';
import type { JobResult, RegionJob } from '../pool.js';
import { runJob, type JobHandlers } from './jobs.js';
import { initParser, type ParserHost } from './parser.js';
import type { ToWorker, WorkerInit, WorkerPortLike } from './protocol.js';

function isJobMessage(m: unknown): m is ToWorker {
  if (typeof m !== 'object' || m === null) return false;
  const t = m as { type?: unknown; id?: unknown; job?: unknown; remainingMs?: unknown };
  return t.type === 'job' && typeof t.id === 'number' && typeof t.job === 'object' && t.job !== null
    && (t.remainingMs === null || typeof t.remainingMs === 'number');
}

/** Posted Buffers arrive as plain Uint8Arrays (structured clone); handlers get Buffer views of the same memory. */
function revive(v: unknown): unknown {
  if (v instanceof Uint8Array) return Buffer.isBuffer(v) ? v : Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (Array.isArray(v)) return v.map(revive);
  if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, revive(x)] as const));
  if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)]));
  return v;
}

/** The worker builds its own deadline from realClock and the posted remainingMs and checks it between files, between query captures and in the parser's progress callback.
 *  handlers (test worker entries only, e.g. test/helpers/workers/throwWorker.ts) replaces the named kinds' handlers; src/entry/worker.ts never passes it.
 *  Posts {type: 'ready'} once the parser is initialised, then one {type: 'result'} per job. Resolves when the loop stops: after a handler throw, answered
 *  {kind: 'crashed'} (R4-15: no worker survives a throw — the caller then ends the thread, and the pool replaces it), once its ParserHost is disposed. */
export async function runWorkerLoop(port: WorkerPortLike, init: WorkerInit, handlers?: Partial<JobHandlers>): Promise<void> {
  const inbox: Array<{ readonly msg: ToWorker; readonly receivedMono: number }> = [];
  let parser: ParserHost | null = null;
  let draining = false;
  let stopped = false;
  let stop: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    stop = resolve;
  });

  const serve = async (host: ParserHost, msg: ToWorker, receivedMono: number): Promise<JobResult<RegionJob>> => {
    const limit = msg.remainingMs;
    const deadline = limit === null ? null : { expired: (): boolean => realClock.monoMs() - receivedMono >= limit };
    if (deadline !== null && deadline.expired()) return { kind: 'deadline' };
    try {
      const out = await runJob(revive(msg.job) as RegionJob, { parser: host, deadline }, handlers);
      return out === 'deadline' ? { kind: 'deadline' } : { kind: 'ok', value: out };
    } catch {
      return { kind: 'crashed' };
    }
  };

  const drain = async (): Promise<void> => {
    if (draining || parser === null) return;
    draining = true;
    while (!stopped && inbox.length > 0) {
      const next = inbox.shift() as { readonly msg: ToWorker; readonly receivedMono: number };
      let result = await serve(parser, next.msg, next.receivedMono);
      try {
        port.postMessage({ type: 'result', id: next.msg.id, result });
      } catch {
        // a value that cannot be posted is a defect of its handler: answered like a throw
        result = { kind: 'crashed' };
        port.postMessage({ type: 'result', id: next.msg.id, result });
      }
      if (result.kind === 'crashed') {
        stopped = true;
        stop();
      }
    }
    draining = false;
  };

  port.on('message', (m: unknown) => {
    if (stopped || !isJobMessage(m)) return;
    inbox.push({ msg: m, receivedMono: realClock.monoMs() });
    void drain();
  });
  const host = await initParser(init);
  parser = host;
  port.postMessage({ type: 'ready', availability: [...host.availability()] });
  void drain();
  await done;
  host.dispose();
}
