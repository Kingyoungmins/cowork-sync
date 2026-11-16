// The region job dispatcher (04-regions §3.1; REG-31; R4-15): one handler per RegionJob kind, each in its own file
// src/regions/worker/jobs/<kind>.ts exporting handle(job, ctx). Reached from the worker loop (main.ts, behind the worker
// entry's kind table, X-37) and from inlineWorkers; Task 1's handlers are stubs that throw (Tasks 3, 3, 4, 8, 7, 13 fill them).
import type { JobOutput, RegionJob } from '../pool.js';
import { handle as foldOverlap } from './jobs/foldOverlap.js';
import { handle as hunks } from './jobs/hunks.js';
import { handle as labelAt } from './jobs/labelAt.js';
import { handle as map } from './jobs/map.js';
import { handle as sites } from './jobs/sites.js';
import { handle as table } from './jobs/table.js';
import type { ParserHost } from './parser.js';

export interface JobCtx { parser: ParserHost; deadline: { expired(): boolean } | null; }
/** One handler per RegionJob kind (the default table imports src/regions/worker/jobs/<kind>.ts). */
export type JobHandlers = { [K in RegionJob['kind']]: (job: Extract<RegionJob, { kind: K }>, ctx: JobCtx) => Promise<JobOutput<Extract<RegionJob, { kind: K }>> | 'deadline'> };

const DEFAULT_HANDLERS: JobHandlers = Object.freeze({
  table,
  hunks,
  map,
  fold_overlap: foldOverlap,
  sites,
  label_at: labelAt,
});

type AnyHandler = (job: RegionJob, ctx: JobCtx) => Promise<unknown>;

/** A throw becomes {kind: 'crashed'}, after which a thread worker exits and the pool respawns it (a wasm trap may leave the module unusable). handlers overrides the default table (tests only).
 *  A job of a kind no table registers throws (crashed) without running any handler. */
export async function runJob<J extends RegionJob>(job: J, ctx: JobCtx, handlers?: Partial<JobHandlers>): Promise<JobOutput<J> | 'deadline'> {
  const kind: string = job.kind;
  const own = handlers !== undefined && Object.hasOwn(handlers, kind) ? (handlers as Record<string, AnyHandler | undefined>)[kind] : undefined;
  const handler = own ?? (Object.hasOwn(DEFAULT_HANDLERS, kind) ? (DEFAULT_HANDLERS as unknown as Record<string, AnyHandler>)[kind] : undefined);
  if (handler === undefined) throw new Error(`job ${kind}: no handler`);
  return (await handler(job, ctx)) as JobOutput<J> | 'deadline';
}
