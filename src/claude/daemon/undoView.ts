// src/claude/daemon/undoView.ts — the undo view (CCI-68, FEAT-F10-10, 05 Algorithm REV view mode, glossary §29.7 Revert
// row). Phase 1: the port and the plan3RevertView binding shape; undoView is Task 14.
import type { RevertView } from '../../holds/revertCs.js';
import type { EngineCore } from '../../engine/core.js';
import type { DaemonCtx } from './ctx.js';

/** X-09: RevertView is declared by Plan 3 Task 17 in src/holds/revertCs.ts (X-09) and imported here — undoView.ts
 *  declares no local copy. */
export type { RevertView };

/** Plan 3's revertView (X5-14, X-09); no object, no file; Plan 6's CoordHost.undo is this port (X-55). */
export interface RevertViewPort { view(csId: string): Promise<RevertView>; }

/** A14-2 (X-09): delegates in one line to Plan 3 Task 17's revertView(core, csId) — a port whose view() throws
 *  'Plan 5 Task 14' until Task 14 binds the real one (the composition binds this factory at attach; nothing calls
 *  view() before Task 14). */
export const plan3RevertView: (core: EngineCore) => RevertViewPort = (_core: EngineCore) => {
  const refuse = async (): Promise<never> => { throw new Error('Plan 5 Task 14'); };
  return { view: refuse } as unknown as RevertViewPort;
};

/** T-SHOW_UNDO.head, per path a -U3 stored-form diff current → reverted; > 8,000 → whole paths dropped from the end with
 *  .trunc; another peer's CS → .notown. */
export function undoView(_seatId: string, _csId: string, _ctx: DaemonCtx): Promise<string> {
  throw new Error('Plan 5 Task 14');
}
