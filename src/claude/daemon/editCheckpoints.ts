// src/claude/daemon/editCheckpoints.ts — the edit-checkpoint coordinator (CCI-56, 06 §3.8.4, glossary §27.1, §29.8,
// R5-20…R5-22). Phase 1: the shapes and the R5-55 neutrals; Task 13 implements.
import type { SkipReason } from '../../holds/lastCheck.js';   // declared in src/holds/lastCheck.ts; re-exported here
import type { DiskSnapshot } from './hookRead.js';
import type { Engine } from '../../engine/loop.js';
import type { DaemonCtx } from './ctx.js';

export type { SkipReason } from '../../holds/lastCheck.js';

export interface EditTrigger { seatId: string; agentId: string | null; csId: string; source: 'edit_post' | 'txn_close'; toolUseId: string; paths: readonly string[]; known: ReadonlyMap<string, DiskSnapshot>; }

export class EditCheckpoints {
  /** A13-11: built with the rest of DaemonCtx before the Engine exists; the Engine arrives through attachEngine. */
  /** Phase 3a-1: constructible (Task 13 owns the bodies). */
  constructor(_ctx: DaemonCtx) { void _ctx; }
  onTrigger(_t: EditTrigger, _budgetMs: number): Promise<'queued' | { skipped: SkipReason | 'pinned' | 'shadow' | 'paused' }> {
    throw new Error('Plan 5 Task 13');
  }
  settled(_csId: string, _candSeq: number, _outcome: 'pass' | 'fail' | 'incomplete' | 'dropped', _why: 'expect' | 'base_moved' | null): void {
    throw new Error('Plan 5 Task 13');
  }
  queueState(_csId: string): { editN: number; inFlight: number | null; waiting: number | null } { throw new Error('Plan 5 Task 13'); }
  /** A13-11 (R5-55 neutral): called by ClaudeDaemon.attach (pre-wired by Task 5); Task 13 subscribes
   *  engine.onCandidateSettled → settled and engine.onCaptureTaken → the awaitCapture waiters here. */
  attachEngine(_engine: Engine): void { return undefined; }
  /** A13-11 (R5-55 neutral): resolves 'late' — no Engine subscription exists before Task 13, so no capture can be
   *  reported on time. */
  awaitCapture(_csId: string, _candSeq: number, _waitMs: number): Promise<true | 'late'> { return Promise.resolve('late'); }
}
