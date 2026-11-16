// src/claude/daemon/shellGate.ts — the shell gate (CCI-28, CCI-29 class e, 06 §3.9, R5-05). Phase 1: the shape; Task 10
// implements.
import type { GateOutcome } from './gate.js';
import type { Txn } from './leases.js';
import type { ShellTool } from '../wire/frames.js';
import type { DaemonCtx } from './ctx.js';

/** Advisory: (a) SHELL_GIT, (b) SHELL_FORMATTER, (c) SHELL_INPLACE when a literal target holds a foreign HELD claim
 *  (foreignHeldOnPath over RegionsPort.claimViewOf, X-20), (d) SHELL_COWORK_CLI, (e) WORKTREE_DENY (claude -w/--worktree)
 *  → G1 {class, hint}; in a wake-originated turn writesFiles() → G1 WAKE_TURN {mode} in both modes; otherwise the TXN
 *  opens (G2). */
export function evaluateShell(_req: { seat: import('./seats.js').Seat; agentId: string | null; sessionId: string; tool: ShellTool; toolUseId: string; command: string; background: boolean },
  _ctx: DaemonCtx): Promise<GateOutcome | { g: 'G2' | 'G3'; note: import('./carriers.js').CarrierItem | null; txn: Txn }> {
  throw new Error('Plan 5 Task 10');
}
