// src/claude/daemon/post.ts — PostToolUse handling (06 §3.8.1–§3.8.2a, §3.13, CCI-21, CCI-25, CCI-26, CCI-43, F05
// prerequisites; R5-08, R5-31, R5-50). Phase 1: the shapes and the R5-55 neutrals the brief lists; Task 12 implements.
import type { DiskSnapshot } from './hookRead.js';
import type { CarrierItem } from './carriers.js';
import type { SlotExtraPort } from './claudeDaemon.js';
import type { EditTrigger } from './editCheckpoints.js';
import type { HookRequest } from './ctx.js';
import type { DaemonCtx } from './ctx.js';
import type { OidOrAbsent } from '../../git/oid.js';
import type { Params } from './claudeDaemon.js';

export class ViewBlobs {   // 06 §2 view blob: per (seat, path); never leaves the daemon
  set(_seatId: string, _path: string, _s: DiskSnapshot): void { throw new Error('Plan 5 Task 12'); }
  /** R5-55 neutral: null — no view blob exists before Task 12. */
  get(_seatId: string, _path: string): DiskSnapshot | null { return null; }
  clearSeat(_seatId: string): void { throw new Error('Plan 5 Task 12'); }
}

export class ReadSets {    // CCI-21, CCI-43 item 1: full reads and ranged reads with their ranges (± 20 lines overlap); memory only
  recordFull(_seatId: string, _path: string): void { throw new Error('Plan 5 Task 12'); }
  recordRange(_seatId: string, _path: string, _rows: readonly [number, number]): void { throw new Error('Plan 5 Task 12'); }
  /** R5-55 neutral: an empty Set — no read set exists before Task 12. */
  fullReadSet(_seatId: string, _sinceMono?: number): ReadonlySet<string> { return new Set(); }
  /** R5-55 neutral: false — no recorded range exists before Task 12. */
  overlaps(_seatId: string, _path: string, _rows: readonly [number, number]): boolean { return false; }
  /** R5-55 neutral: null — no apply instant exists before Task 12. */
  lastApplyInto(_seatId: string): number | null { return null; }
  noteApplied(_paths: readonly string[]): void { throw new Error('Plan 5 Task 12'); }
}

export interface PostOutcome { block: { code: 'HELD_CS'; params: Params } | null; items: CarrierItem[]; trigger: EditTrigger | null; effects: ReadonlyArray<{ path: string }>; }

export function handleEditPost(_r: HookRequest, _ctx: DaemonCtx): Promise<PostOutcome> {
  throw new Error('Plan 5 Task 12');
}

export function handleReadPost(_r: HookRequest, _ctx: DaemonCtx, _host?: { rows: number | null; offsetBase: 0 | 1 | null }): Promise<PostOutcome> {
  throw new Error('Plan 5 Task 12');
}

/** A12-3 (R5-31): held ranges refreshed after every PostToolUse on a path; get returns null when base ≠ materialized;
 *  memory only. */
export class HeldRangeOverlay {
  set(_path: string, _ranges: ReadonlyArray<readonly [number, number]>, _base: OidOrAbsent): void { throw new Error('Plan 5 Task 12'); }
  get(_path: string, _materialized: OidOrAbsent | null): ReadonlyArray<readonly [number, number]> | null { throw new Error('Plan 5 Task 12'); }
  clear(_path: string): void { throw new Error('Plan 5 Task 12'); }
}

/** A12-9 (K2, CCI-26, record first). */
export class K2Detector {
  constructor(_ctx: DaemonCtx) { throw new Error('Plan 5 Task 12'); }
  check(_seat: import('./seats.js').Seat, _agentId: string | null, _csId: string, _view: import('./claudeDaemon.js').ClaimViewCopy | null,
    _hits: ReadonlyArray<{ path: string; claimId: string; holder: string; label: string }>,
    _posts: ReadonlyMap<string, DiskSnapshot>): Promise<{ holdId: string; joined: boolean; localOnly: boolean } | null> {
    throw new Error('Plan 5 Task 12');
  }
}

/** A12-10 (HLD-22, HLD-23). */
export class RecordsTold { first(_holdId: string): boolean { throw new Error('Plan 5 Task 12'); } firstPinContext(_seatId: string, _path: string, _turnKey: string): boolean { throw new Error('Plan 5 Task 12'); } }
export function scanRecords(_ctx: DaemonCtx, _told: RecordsTold): void {
  throw new Error('Plan 5 Task 12');
}

/** A12-11 (R2-D4). */
export class HumanEdits { constructor(_ctx: DaemonCtx) { throw new Error('Plan 5 Task 12'); } observe(): Promise<void> { throw new Error('Plan 5 Task 12'); } }

/** A12-5 (F05-08): late SlotExtraPort results ride the seat's next PostToolUse of the same turn; dropped at that turn's
 *  Stop. Plan 6's claim-ahead mapping pushes here. */
export class LateSlotQueue {
  push(_seatId: string, _agentId: string | null, _item: CarrierItem): void { throw new Error('Plan 5 Task 12'); }
  take(_seatId: string, _agentId: string | null, _charsLeft: number): CarrierItem | null { throw new Error('Plan 5 Task 12'); }
  dropTurn(_seatId: string): void { throw new Error('Plan 5 Task 12'); }
}

export function withLateQueue(_port: SlotExtraPort | null, _q: LateSlotQueue): SlotExtraPort {
  throw new Error('Plan 5 Task 12');
}
