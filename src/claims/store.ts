// The claim store (04 §3.3 pins, §3.5 drafts; REG-21, REG-35; R4-24, R4-28, R4-31) — Task 5 (skeleton: claim ids,
// drafts bookkeeping, CS blocks and rejection memory), Task 11 (drafts, deferrals), Task 14 (emission).
import type { Random } from '../ports/random.js';
import type { TableCache } from '../regions/cache.js';
import type { SnapshotStore } from '../regions/snapshots.js';
import type { Draft, SeatKey } from './types.js';

/** RFC 4648 base32, lowercase, of `bytes` (R4-24's 10-byte ids: 16 characters of [a-z2-7]). */
export function base32Of(bytes: Uint8Array): string {
  const A = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += A[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += A[(value << (5 - bits)) & 31];
  return out;
}

/** A new claim id: RFC 4648 base32 lowercase of 10 random bytes (R4-24). No clock. */
export function newClaimId(r: Random): string {
  return base32Of(r.bytes(10));
}

/**
 * The claim store of one engine run (in memory): the confirmed TENTATIVE drafts, the CSs an own claim_overlap
 * blocked (R4-28), and the (claim_id, reason) rejections already reported (PRO-38). The blob pinning of drafts
 * (putDraft's srcBlob pin under the owner claim) is Task 11's — the skeleton keeps the bookkeeping only.
 */
export class ClaimStore {
  private readonly held = new Map<string, Draft>();
  private readonly blocks = new Map<string, string>();
  private readonly rejected = new Set<string>();
  private seq = 0;   // consumed by putDraft of Task 11 (the local confirmation order, R4-29)

  constructor(_snapshots: SnapshotStore, _cache: TableCache, readonly random: Random) {}

  newClaimId(): string {
    return newClaimId(this.random);
  }

  /** Confirmed TENTATIVE drafts, local confirmation order, all seats or one's. */
  drafts(seat?: SeatKey): readonly Draft[] {
    const all = [...this.held.values()].sort((a, b) => a.confirmSeq - b.confirmSeq);
    return seat === undefined ? all : all.filter((d) => d.seat.peer === seat.peer && d.seat.seat === seat.seat);
  }

  /** Records a draft with the next sequence number; replaces a draft with the same claimId keeping its confirmSeq
   *  (claim order follows the first confirmation, R4-29). The srcBlob pin is Task 11's. */
  putDraft(_d: Omit<Draft, 'confirmSeq'>): Draft {
    throw new Error('ClaimStore.putDraft not bound before Task 11');
  }

  /** Unpins a draft (discard; Task 11 records the discard in the registry). */
  discard(_claimId: string): void {
    throw new Error('ClaimStore.discard not bound before Task 11');
  }

  /** A draft's op landed: the folded record takes over; unpins (Task 14). */
  emitted(_claimId: string): void {
    throw new Error('ClaimStore.emitted not bound before Task 14');
  }

  /** R4-28: an own claim_overlap names the CS it blocks, with the overlapping claim ids. */
  blockCs(csId: string, overlaps: string): void {
    this.blocks.set(csId, overlaps);
  }

  blockedBy(csId: string): string | null {
    return this.blocks.get(csId) ?? null;
  }

  /** Every CS block as [csId, overlaps] pairs (EngineInspection.claims.blocked; Task 14 clears them). */
  blockedAll(): Array<readonly [string, string]> {
    return [...this.blocks];
  }

  /** EMIT step 5: clears the CSs a now-published or released CS no longer blocks. */
  unblockWhere(pred: (overlaps: string) => boolean): void {
    for (const [csId, overlaps] of [...this.blocks]) if (pred(overlaps)) this.blocks.delete(csId);
  }

  /** CONFIRM step 1 (Task 11). */
  deferConfirm(_e: unknown): void {
    throw new Error('ClaimStore.deferConfirm not bound before Task 11');
  }

  deferred(_csId: string): readonly never[] {
    throw new Error('ClaimStore.deferred not bound before Task 11');
  }

  clearDeferred(_csId: string, _path: string): void {
    throw new Error('ClaimStore.clearDeferred not bound before Task 11');
  }

  /** PRO-38: true the first time per (claim_id, reason), false on a repeat. */
  markRejected(claimId: string, reason: string): boolean {
    const key = `${claimId}\n${reason}`;
    if (this.rejected.has(key)) return false;
    this.rejected.add(key);
    return true;
  }
}
