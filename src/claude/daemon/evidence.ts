// src/claude/daemon/evidence.ts — the acting-verb evidence store (SEC-25, SEC-26, CCI-54, INV-HUMANONLY, R5-13, R5-14,
// R5-38). Phase 1: the shapes; Task 15 implements.
import type { EvidenceRecord, ActingVerb } from '../wire/frames.js';
import type { Seat } from './seats.js';
import type { DaemonCtx } from './ctx.js';

export class EvidenceStore {
  /** Phase 3a-1: constructible (Task 15 owns the bodies). */
  constructor(_ctx: DaemonCtx, _key: Buffer | null) { void _ctx; void _key; }
  /** From a human-classified /cowork UserPromptExpansion only; one per prompt_id. */
  mint(_seat: Seat, _r: EvidenceRecord): 'minted' | 'duplicate' | 'refused_wake' | 'refused_nonce' { throw new Error('Plan 5 Task 15'); }
  ingestFile(): Promise<void> { throw new Error('Plan 5 Task 15'); }
  await(_e: { verb: ActingVerb; argsSha256: string }, _o: { maxAgeMs: number; waitMs: number }): Promise<{ ok: true; seatId: string | null } | { ok: false }> {
    throw new Error('Plan 5 Task 15');
  }
  /** X-02: the one read-only grant API of every plan; renews no lease. */
  grant(_seat: Seat, _verb: 'since', _argsSha256: string, _promptId: string): void { throw new Error('Plan 5 Task 15'); }
  awaitGrant(_verb: 'since', _argsSha256: string, _o: { maxAgeMs: number; waitMs: number }): Promise<boolean> { throw new Error('Plan 5 Task 15'); }
  /** V-7 (Plan 7 X7-11). */
  mintedWithin(_verb: ActingVerb, _atMonoMs: number, _windowMs: number): boolean { throw new Error('Plan 5 Task 15'); }
}
