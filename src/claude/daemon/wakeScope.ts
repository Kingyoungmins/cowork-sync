// src/claude/daemon/wakeScope.ts — CCI-38 hook points, R5-05 (Plan 6 binds membership and the PIN). X-41: this is the
// one wake-scope port (Plan 6's WakeTurnPort, checkEdit/checkShell and wakeCheckShell are deleted names; the shell wake
// rule is Plan 5's). Phase 1: plan5WakeScope is REAL (A10-5).
import type { Oid } from '../../git/oid.js';
import type { Hunk } from '../../regions/types.js';
import type { DiskSnapshot } from './hookRead.js';

export interface WakeScopePort {
  /** Gate row 3 for a wake-originated turn (wake.turnEdits from user.json): 'allow' or a deny with the mode. */
  gateEdit(seatId: string, path: string, p: PredictResultShape | null, mode: 'allow' | 'deny'): 'allow' | { deny: 'allow' | 'deny' };
  /** Edit-class PostToolUse, TXN close, cowork_resolve restore write in a wake turn: records first (HLD-66 whole-CS PIN
   *  guard wake-scope, origin wake) and returns its id. X-41: each change carries h1 and localOnly, so Plan 6 needs no
   *  hashing; Plan 6's binding creates the PIN through pinCs('wake-scope', …) (R3-08). */
  backstop(seatId: string, csId: string, changes: ReadonlyArray<{ path: string; hunks: readonly Hunk[]; post: DiskSnapshot; h1: Oid | 'ABSENT'; localOnly: boolean }>,
    at: 'post' | 'txn' | 'restore'): Promise<{ holdId: string } | null>;
}
type PredictResultShape = import('./claudeDaemon.js').PredictResultCopy;

/** A10-5 (REAL): gateEdit → 'allow' in mode allow and { deny: 'deny' } in mode deny (with wake.turnEdits = deny the wake
 *  work set is empty by 06 §3.8.2a, so the deny needs no Plan 6 membership; membership in allow mode stays Plan 6's);
 *  backstop → null (no PIN; X-41: plan5WakeScope creates no PIN). No production wake turn exists before Plan 6
 *  (neverRing). */
export const plan5WakeScope: WakeScopePort = Object.freeze({
  gateEdit: (_seatId: string, _path: string, _p: PredictResultShape | null, mode: 'allow' | 'deny'): 'allow' | { deny: 'allow' | 'deny' } =>
    mode === 'allow' ? 'allow' : { deny: 'deny' },
  backstop: async (): Promise<{ holdId: string } | null> => null,
});
