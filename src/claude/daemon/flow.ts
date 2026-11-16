// src/claude/daemon/flow.ts — the F14 flow/wrap request kinds (09 §3.11 rev 2.5, FEAT-F14-05/-08/-09, D1; R5-14,
// R5-53). Phase 1: the R5-55 REAL noFlowEntries and noWrap; handleFlow/handleWrap/registerFlowRequests are Task 15.
import type { FlowPort, WrapPort, FlowSelector, ClaudeFlowInputs, FlowEntryWire } from './claudeDaemon.js';
import type { SessionClientFrame } from '../wire/frames.js';
import type { FlowResultFrame, WrapResultFrame } from '../wire/frames.js';
import type { DaemonCtx } from './ctx.js';

export type { FlowPort, WrapPort, FlowSelector, ClaudeFlowInputs, FlowEntryWire };

/** R5-53 (REAL): no flow entries until Plan 7 binds the stage table — every selector answers {entries: [], omitted: 0}. */
export const noFlowEntries: FlowPort = Object.freeze({
  entries: (_claude: ClaudeFlowInputs, _selector: FlowSelector, _max: number): { entries: FlowEntryWire[]; omitted: number } => ({ entries: [], omitted: 0 }),
});

/** R5-53 (REAL): no wrap rows until Plan 7 binds its wrapHandler. */
export const noWrap: WrapPort = Object.freeze({
  rows: async (_caller: { seatKey: string | null }): Promise<import('../../board/canonicalJson.js').Json> => ({}),
});

/** X-01: from the last iteration's memory; one FlowPort.entries call (≤ 2,000 entries + omitted); reply ≤ 1 MiB. */
export function handleFlow(_f: Extract<SessionClientFrame, { t: 'flow' }>, _ctx: DaemonCtx): Promise<FlowResultFrame> {
  throw new Error('Plan 5 Task 15');
}

/** Read-only; needs and consumes no evidence; renews no lease; rows = await WrapPort.rows({seatKey}) (V-7, V-16). */
export function handleWrap(_f: Extract<SessionClientFrame, { t: 'wrap' }>, _ctx: DaemonCtx): Promise<WrapResultFrame> {
  throw new Error('Plan 5 Task 15');
}

/** Binds the `flow`, `wrap` and `slash_shown` request kinds (Task 15; one call in claudeDaemon.ts). */
export function registerFlowRequests(_server: unknown, _ctx: DaemonCtx): void {
  throw new Error('Plan 5 Task 15');
}
