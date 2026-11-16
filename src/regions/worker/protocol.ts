// The pool ↔ worker protocol (04-regions §3.1; REG-31; R4-12): types only, imported by pool.ts, main.ts and inline.ts.
import type { JobResult, RegionJob } from '../pool.js';
import type { Language } from '../types.js';

/** Posted as workerData; bytes copied, so every spawn and respawn gets them. */
export interface WorkerInit { name: 'fg' | 'bg'; generation: number; runtimeWasm: Uint8Array; grammars: ReadonlyArray<readonly [Language, Uint8Array]>; }
export type ToWorker = { type: 'job'; id: number; job: RegionJob; remainingMs: number | null };
/** unregistered: the worker entry's job-kind table (X-37) does not register the job's kind — the answer is {kind: 'crashed'}, no handler ran and
 *  the worker loop goes on, so the pool keeps the worker (no terminate, no respawn). Every other crashed result replaces its worker (R4-15). */
export type FromWorker =
  | { type: 'ready'; availability: ReadonlyArray<readonly [Language, 'ok' | 'unavailable']> }
  | { type: 'result'; id: number; result: JobResult<RegionJob>; unregistered?: true };
export interface WorkerPortLike { on(ev: 'message', cb: (m: unknown) => void): void; postMessage(m: FromWorker): void; }
