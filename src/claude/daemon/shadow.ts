// src/claude/daemon/shadow.ts — the K1 deny pre-records (CCI-18, CCI-19, HLD-47, REG-30, INV-CCI-RECORD-FIRST,
// INV-ONE-EVENT). Phase 1: the shapes; Task 11 implements.
import type { ShortRead } from './hookRead.js';
import type { EditInput, EditTool } from '../wire/frames.js';
import type { Seat } from './seats.js';
import type { DaemonCtx } from './ctx.js';

export class ShadowRecorder {
  /** Phase 3a-1: constructible (Task 11 owns the bodies). */
  constructor(_ctx: DaemonCtx) { void _ctx; }
  prerecord(_seat: Seat, _agentId: string | null, _path: string, _claimId: string, _claimIds: readonly string[], _input: EditInput, _disk: ShortRead): Promise<{ id: string; repeat: number }> {
    throw new Error('Plan 5 Task 11');
  }
  convert(_id: string): Promise<'converted' | 'local_only'> { throw new Error('Plan 5 Task 11'); }
  /** R5-55 neutral: resolves 0 — no deny tmp record exists before Task 11, so nothing to convert. */
  convertLeftovers(): Promise<number> { return Promise.resolve(0); }
}

/** A11-1: the deny tmp record's meta line. */
export interface DenyFileMeta { v: 1; id: string; seq: number; seat_id: string; agent_id: string | null; claim_id: string; claim_ids: string[]; path: string; base_len: number | null; post_len: number; }

/** A11-1: <coworkDir>/tmp/deny-<id>-<seq>.bin */
export function denyRecordPath(coworkDir: string, id: string, seq: number): string {
  throw new Error('Plan 5 Task 11');
}

/** A11-2, pure: the tool input applied on 06 §3.5.3's normalized view of base (BOM, CRLF, quote folding), mapped back to
 *  raw bytes; an old_string that does not match → null. */
export function applyToolInput(_tool: EditTool, _input: EditInput, _base: Buffer): Buffer | null {
  throw new Error('Plan 5 Task 11');
}
