// src/claude/daemon/acting.ts — the human-only acting verbs (SEC-25 steps 3–7, R5-13). Phase 1: the shapes; Task 15
// implements.
import type { Json } from '../../board/canonicalJson.js';
import type { WireJson } from '../../claude/wire/frames.js';
import type { Params } from './claudeDaemon.js';
import type { ActingVerb, SessionClientFrame, SessionServerFrame } from '../wire/frames.js';
import type { Engine } from '../../engine/loop.js';
import type { DaemonCtx } from './ctx.js';

/** X-58: the result widens additively with data; Plan 5's handlers leave data absent. */
export type ActingHandler = (params: Json, o: { seatId: string | null }) => Promise<{ ok: boolean; code: string; params: Params; data?: WireJson }>;

export class ActingVerbRegistry {
  /** Phase 3a-1: constructible (Task 15 owns the bodies). */
  constructor(_ctx: DaemonCtx) { void _ctx; }
  register(_verb: ActingVerb, _h: ActingHandler): void { throw new Error('Plan 5 Task 15'); }   // throws on a duplicate verb
  handle(_f: Extract<SessionClientFrame, { t: 'acting' }>): Promise<Extract<SessionServerFrame, { t: 'acting_result' }>> {
    throw new Error('Plan 5 Task 15');
  }
}

/** Binds the `acting` request kind (Task 15; one call in claudeDaemon.ts). */
export function registerActingRequests(_server: unknown, _ctx: DaemonCtx): void {
  throw new Error('Plan 5 Task 15');
}

/** done → Engine.done(); resolve <id> --publish|--discard|--park|--restore → Engine.resolve(id, verb, …). X-59: Plan 7
 *  Task 11 deletes these two r.register lines. */
export function registerPlan5Verbs(_r: ActingVerbRegistry, _engine: Engine): void {
  throw new Error('Plan 5 Task 15');
}
