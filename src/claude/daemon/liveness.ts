// src/claude/daemon/liveness.ts — daemon liveness and removal (CCI-50…CCI-53, SEC-23, LIF-36, R5-18, R5-51). Phase 1:
// the shapes; Task 9 implements (Liveness and the diedWithHost data shapes).
import type { Fs } from '../../ports/fs.js';
import type { StatusJson } from '../../engine/status.js';
import type { Engine } from '../../engine/loop.js';
import type { DaemonCtx } from './ctx.js';

export class Liveness {
  /** Every 30 s: cowork-sync enabled in enabledPlugins across the settings layers, ipc.key present with the start-time
   *  hash, the runtime copy present; any failure → shutdown (LIF-36). */
  /** Phase 3a-1: constructible (Task 9 owns the bodies). */
  constructor(_ctx: DaemonCtx, _d: { pluginEnabled: () => Promise<boolean>; keyHash: () => Promise<string | null>; runtimeExists: () => Promise<boolean>; shutdown: () => Promise<void> }) { void _ctx; void _d; }
  check(): Promise<'ok' | 'shutdown'> { throw new Error('Plan 5 Task 9'); }
}

/** A9-1, the production pluginEnabled binding: the highest-precedence of managed, local, project and user settings that
 *  names pluginId in enabledPlugins decides; unnamed → enabled; reads only the enabledPlugins key of those files
 *  (SEC-23 capability limits). */
export function pluginEnabledFromSettings(_fs: Fs, _files: readonly string[], _pluginId: string): Promise<boolean> {
  throw new Error('Plan 5 Task 9');
}

export class MarkerBackstop {
  /** Production watch = realWatch (A9-2). */
  /** Phase 3a-1: constructible (Task 9 owns the bodies). */
  constructor(_ctx: DaemonCtx, _watch: (p: string, cb: () => void) => () => void, _shutdown: () => Promise<void>) { void _ctx; void _watch; void _shutdown; }
  start(): void { throw new Error('Plan 5 Task 9'); }
  stop(): void { throw new Error('Plan 5 Task 9'); }
  expectRemoval(_on: boolean): void { throw new Error('Plan 5 Task 9'); }
}

/** LIF-36 stopgap (R5-51; X-69: Plan 7 owns LIF-36, its Task 11 replaces this body). */
export function removalShutdown(_engine: Engine, _ctx: DaemonCtx): Promise<void> {
  throw new Error('Plan 5 Task 9');
}

/** CCI-51: the previous daemon ended without its final status write and its last heartbeat lies ≤ 5 s after the last
 *  SessionEnd its log recorded, with no seat hook logged after that SessionEnd (its own monotonic clock) →
 *  DAEMON_DIED_WITH_HOST (status once; doctor WARN in Plan 7). */
export function diedWithHost(_prevLog: ReadonlyArray<{ code: string; mono: number }>, _prevStatus: StatusJson | null): boolean {
  throw new Error('Plan 5 Task 9');
}
