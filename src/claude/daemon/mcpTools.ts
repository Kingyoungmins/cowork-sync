// src/claude/daemon/mcpTools.ts — the cowork MCP tools (CCI-47, CCI-48, CCI-67, CCI-68, 06 §3.16.3, SEC-27, R5-08,
// R5-10, R5-41, R5-42). Phase 1: McpToolResult, the REAL unavailableScan/canaryScan (X-51) and the shapes; Task 14
// implements the rest.
import type { Json } from '../../board/canonicalJson.js';
import type { ToolCtx, ToolResult, CoordToolsPort, NoteScanPort } from './claudeDaemon.js';
import type { Seat } from './seats.js';
import type { DaemonCtx } from './ctx.js';
import type { SessionServerFrame, SessionClientFrame } from '../wire/frames.js';

export type { ToolCtx, ToolResult, CoordToolsPort, NoteScanPort };

/** X-39: the frame-level result of one MCP tool call; never isError; refusals {ok:false, code, text}; ≤ 400 chars except
 *  cowork_show ≤ 8,000 (count line on truncation). */
export interface McpToolResult { text: string; structured: Json; }

/** The ToolName set of glossary §15's eight MCP tools (L-HUMAN-ONLY). */
export type ToolName = 'cowork_status' | 'cowork_show' | 'cowork_request' | 'cowork_respond' | 'cowork_note' | 'cowork_release' | 'cowork_checkpoint' | 'cowork_resolve';

export function handleTool(_seat: Seat, _name: ToolName, _args: Json, _ctx: DaemonCtx): Promise<McpToolResult> {
  throw new Error('Plan 5 Task 14');
}

/** Binds the `tool` and `ring_result` request kinds on the server (Task 14; one call in claudeDaemon.ts). */
export function registerMcpRequests(_server: unknown, _ctx: DaemonCtx): void {
  throw new Error('Plan 5 Task 14');
}

/** R5-10 (X-39): Plan 5's default binding until Plan 6's bindClaude replaces it — a port whose every call throws
 *  'Plan 5 Task 14' (Phase 1 stub; the composition binds it, the MCP tool dispatch that would call it is Task 14). */
export const outboxCoord: (ctx: DaemonCtx) => CoordToolsPort = (_ctx: DaemonCtx) => {
  const refuse = (): never => { throw new Error('Plan 5 Task 14'); };
  return { request: refuse, respond: refuse, note: refuse, release: refuse, show: refuse, status: refuse } as unknown as CoordToolsPort;
};

/** X-51 (REAL, R5-42): the scanner is Plan 7's alone — until then notes are unavailable. available false → notes
 *  NOTE_SCAN_UNAVAILABLE, undo view without diff lines; notes are refused until Plan 7 lands (pre-release only, D4). */
export const unavailableScan: NoteScanPort = Object.freeze({
  scan: async (_text: string, _kind: 'note' | 'status'): Promise<{ available: boolean; hit: boolean }> => ({ available: false, hit: false }),
});

/** Test builds (X-51, REAL): hit iff COWORK_CANARY_[A-Za-z0-9_]+. */
export const canaryScan: NoteScanPort = Object.freeze({
  scan: async (text: string, _kind: 'note' | 'status'): Promise<{ available: boolean; hit: boolean }> => ({ available: true, hit: /COWORK_CANARY_[A-Za-z0-9_]+/.test(text) }),
});
