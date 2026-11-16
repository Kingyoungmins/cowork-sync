// src/claude/daemon/health.ts — seat health and NO_HOOKS (CCI-33…CCI-35, SEC-28, SEC-29, R2-B8…R2-B11). Phase 1: the
// class shape; Task 9 implements.
import type { DaemonCtx } from './ctx.js';
import type { Seat, SeatRegistry } from './seats.js';
import type { PolicyHit } from '../wire/frames.js';

export class SeatHealth {
  /** Phase 3a-1: constructible; the composition passes a pre-attach setFreezeReason no-op (decision 7-8 — Task 9 binds the engine's). */
  constructor(_ctx: DaemonCtx, _engine: { setFreezeReason(r: 'NOHOOKS', on: boolean, cause: string): Promise<void> }) { void _ctx; void _engine; }
  onPre(_seatId: string, _toolUseId: string): void { throw new Error('Plan 5 Task 9'); }
  onPost(_seatId: string, _toolUseId: string): void { throw new Error('Plan 5 Task 9'); }
  /** R5-55 neutral: a no-op — no seat exists before Task 9, so a hook carries no pairing to observe. */
  onHook(_seatId: string): void { return undefined; }
  /** R5-55 neutral (stub preamble): a no-op — no pairing exists before Task 9, so a tick observes nothing. */
  async tick(): Promise<void> { return undefined; }
  markGateBypassed(_seatId: string): void { throw new Error('Plan 5 Task 9'); }   // X5-26 (COO-02 K3)
  hookLatencyP95Ms(): number | null { throw new Error('Plan 5 Task 9'); }         // X-64
  leaseExpiriesPerHour(): number { throw new Error('Plan 5 Task 9'); }            // V-7 (Plan 7 X7-13)
  /** R5-55 neutral: an empty Map — no DEGRADED seat exists before Task 9. */
  degradedPaths(): ReadonlyMap<string, string> { return new Map(); }
  onMcpToolCall(_seatId: string): void { throw new Error('Plan 5 Task 9'); }
  onStaticHits(_seatId: string, _hits: readonly PolicyHit[]): void { throw new Error('Plan 5 Task 9'); }
  policyWiring(_seat: Seat, _hits: readonly PolicyHit[]): void { throw new Error('Plan 5 Task 9'); }
}

export type { SeatRegistry };
