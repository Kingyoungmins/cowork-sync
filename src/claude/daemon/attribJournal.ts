// src/claude/daemon/attribJournal.ts — the apply journal and the ATTRIBUTION note (CCI-43 items 1, 3, 4; R5-09). Phase
// 1: the shapes; Task 12 implements.
import type { CarrierItem } from './carriers.js';
import type { ReadSets } from './post.js';

export interface ApplyRecord { path: string; rows: readonly [number, number]; label: string; name: string; held: boolean; mono: number; }

export class ApplyJournal {
  /** Every apply (from ClaudeEnginePort.applied + the engine's incoming CS writer and display name). */
  record(_r: ApplyRecord): void { throw new Error('Plan 5 Task 12'); }
  /** At most one coalesced ATTRIBUTION per PostToolUse for applies since the seat's previous tool call; ≤ 600 with the
   *  slot. */
  attributionNote(_seatId: string, _sinceMono: number, _reads: ReadSets): CarrierItem | null { throw new Error('Plan 5 Task 12'); }
  /** READ_REPLACED (2 s). */
  replacedWithin(_path: string, _ms: number): boolean { throw new Error('Plan 5 Task 12'); }
}
