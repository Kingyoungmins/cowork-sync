// src/claude/daemon/gate.ts — the edit gate (06 §3.5–§3.6, CCI-12…CCI-19, glossary §11; Task 10 frame, rows 1–8 and 14;
// Task 11 rows 9–13b). Phase 1: the shapes; Task 10 implements.
import type { CarrierItem } from './carriers.js';
import type { InflightLease } from './leases.js';
import type { PredictResultCopy } from './claudeDaemon.js';
import type { Seat } from './seats.js';
import type { DaemonCtx } from './ctx.js';
import type { EditInput, EditTool } from '../wire/frames.js';

export type GateOutcome =
  | { g: 'G1'; code: string; params: import('./claudeDaemon.js').Params; form: 'T1' | 'T1R' | 'other'; record: string | null }   // record: the SHADOW (tmp) id of a row-13 deny
  | { g: 'G2' | 'G3'; note: CarrierItem | null; lease: InflightLease };   // ≤ 1 note, ≤ 800

export interface EditGateRequest { seat: Seat; agentId: string | null; sessionId: string; toolName: EditTool; toolUseId: string; path: string; input: EditInput; hookProto: number; pluginVersion: string; }

/** 06 §3.5.2 rows 1–14 and 13b, first match wins. */
export const GATE_ROWS: readonly ['VERSION_RESTART', 'CC_TOO_OLD', 'WAKE_TURN', 'STATE_FILE', 'NOT_SHARED', 'PORTABILITY', 'SYMLINK', 'PATH_BUSY',
  'LOCATE', 'MOVED', 'HELDREG', 'SUSPECT', 'FOREIGN_CLAIM', 'GRANT_PAUSE', 'PASS']
  = Object.freeze(['VERSION_RESTART', 'CC_TOO_OLD', 'WAKE_TURN', 'STATE_FILE', 'NOT_SHARED', 'PORTABILITY', 'SYMLINK', 'PATH_BUSY',
    'LOCATE', 'MOVED', 'HELDREG', 'SUSPECT', 'FOREIGN_CLAIM', 'GRANT_PAUSE', 'PASS'] as const);

export function evaluateEdit(_req: EditGateRequest, _ctx: DaemonCtx, _extend: (ms: number) => boolean): Promise<GateOutcome> {
  throw new Error('Plan 5 Task 10');
}

/** A10-4: rows 10 MOVED, 11 HELDREG, 12 SUSPECT, 13 FOREIGN CLAIM (K1), 13b GRANT PAUSE on row 9's prediction; null = no
 *  region outcome (Task 10 ships it returning null, Task 11 implements it). */
export function regionRows(_req: EditGateRequest, _p: PredictResultCopy | null, _ctx: DaemonCtx, _extend: (ms: number) => boolean): Promise<GateOutcome | null> {
  throw new Error('Plan 5 Task 10');
}

/** Doctor's gate canary (Plan 7 X7-21; Task 11 produces it). */
export function canaryArm(_ctx: DaemonCtx, _nonce: string): void {
  throw new Error('Plan 5 Task 11');
}
export function canaryDisarm(_ctx: DaemonCtx, _nonce: string): { hit: boolean } {
  throw new Error('Plan 5 Task 11');
}
