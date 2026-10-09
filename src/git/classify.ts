export type PushOutcome = 'landed' | 'lease_lost' | 'transient' | 'nonretryable';

/**
 * What the caller observed after a rejected (or unclear) push followed by a fresh fetch.
 * There is deliberately no field for the rejection text: message text never decides
 * (glossary §26.2 item 2, 09-security SEC-04).
 */
export interface PushObservation {
  /** The leased remote ref now points somewhere other than the lease value. */
  refMovedSinceLease: boolean;
  /** The fetched board contains the op ids of the publish we tried to push. */
  ourOpIdsPresent: boolean;
  /** Consecutive transient rejections of this same publish before this one. */
  previousStreak: number;
}

/** The 3rd consecutive transient rejection of the same publish is NONRETRYABLE. */
export const NONRETRYABLE_STREAK = 3;

export function classifyPush(o: PushObservation): { outcome: PushOutcome; streak: number } {
  if (typeof o.refMovedSinceLease !== 'boolean' || typeof o.ourOpIdsPresent !== 'boolean') {
    throw new TypeError('classifyPush: refMovedSinceLease and ourOpIdsPresent must be booleans');
  }
  if (!Number.isSafeInteger(o.previousStreak) || o.previousStreak < 0) {
    throw new RangeError(`classifyPush: previousStreak must be a non-negative integer, got ${String(o.previousStreak)}`);
  }
  if (o.ourOpIdsPresent) {
    return { outcome: 'landed', streak: 0 };
  }
  if (o.refMovedSinceLease) {
    return { outcome: 'lease_lost', streak: 0 };
  }
  const streak = o.previousStreak + 1;
  return { outcome: streak >= NONRETRYABLE_STREAK ? 'nonretryable' : 'transient', streak };
}
