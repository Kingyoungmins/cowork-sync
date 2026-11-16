// src/claude/daemon/txnClose.ts — the TXN close (06 §3.7.3 close, §3.8.2–§3.8.4 trigger (b)). Phase 1: the shapes; Task
// 12 implements.
import type { CarrierItem } from './carriers.js';
import type { Txn, ReleaseWhy } from './leases.js';
import type { DiskSnapshot } from './hookRead.js';
import type { EditTrigger } from './editCheckpoints.js';
import type { PostOutcome } from './post.js';
import type { DaemonCtx } from './ctx.js';
import type { Params } from './claudeDaemon.js';

export interface TxnCloseResult { attributed: ReadonlyArray<{ path: string; post: DiskSnapshot }>; block: PostOutcome['block']; items: CarrierItem[]; trigger: EditTrigger | null; }

export function closeTxn(_t: Txn, _why: ReleaseWhy, _ctx: DaemonCtx): Promise<TxnCloseResult> {
  throw new Error('Plan 5 Task 12');
}

/** A12-1: trigger (b) of a hookless close (cap, background return), delivered to EditCheckpoints.onTrigger; hook-carried
 *  closes set HookRequest.trigger instead. */
export function onCloseTrigger(_cb: (t: EditTrigger) => void): () => void {
  throw new Error('Plan 5 Task 12');
}

export type { Params };
