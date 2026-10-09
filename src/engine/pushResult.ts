// Publish outcome by observation (ENG-44, PRO-12, PRO-54; glossary §26.2 item 2). The inputs are the board ref's
// porcelain status and what the fresh fetch after the push showed; no field carries git's or the host's text, and
// lint L-CLASSIFY-TEXT keeps every text identifier out of this file.
import { classifyPush } from '../git/classify.js';
import { ABSENT, isOid, type OidOrAbsent } from '../git/oid.js';
import type { PushRefStatus } from '../git/push.js';

export type PublishOutcome = 'landed' | 'lease_lost' | 'transient' | 'network' | 'nonretryable';
/**
 * boardStatus: the porcelain status of the board ref; refetchedBoard: T′, the board tip of the fetch after the push;
 * lease: T, the board lease of the push; ourWriterOnChain: this publish's Cowork-Writer or one of its op ids is on T′'s
 * first-parent chain after the lease (PRO-12); previousStreak: consecutive transient rejections of this publish.
 */
export interface PublishObservation { boardStatus: PushRefStatus; refetchedBoard: OidOrAbsent; lease: OidOrAbsent; ourWriterOnChain: boolean; previousStreak: number; }

const STATUSES: ReadonlySet<string> = new Set<PushRefStatus>(['ok', 'rejected', 'none']);

function checkBoard(what: string, v: unknown): void {
  if (v !== ABSENT && !isOid(v)) throw new TypeError(`classifyPublish: ${what} must be an oid or ABSENT, got ${JSON.stringify(v)}`);
}

/**
 * landed (a porcelain 'ok' for the board ref, or our writer / an op id on T′'s chain after the lease) > lease_lost (T′ ≠ T,
 * ABSENT compared as a value) > status 'rejected' with T′ == T → transient (streak + 1; nonretryable at 3) > status 'none'
 * with T′ == T → network (streak unchanged, not counted). Landed and lease_lost reset the streak. Built on classifyPush.
 */
export function classifyPublish(o: PublishObservation): { outcome: PublishOutcome; streak: number } {
  if (!STATUSES.has(o.boardStatus)) throw new TypeError(`classifyPublish: unknown board status ${JSON.stringify(o.boardStatus)}`);
  checkBoard('refetchedBoard', o.refetchedBoard);
  checkBoard('lease', o.lease);
  if (typeof o.ourWriterOnChain !== 'boolean') throw new TypeError('classifyPublish: ourWriterOnChain must be a boolean');
  if (!Number.isSafeInteger(o.previousStreak) || o.previousStreak < 0) {
    throw new RangeError(`classifyPublish: previousStreak must be a non-negative integer, got ${String(o.previousStreak)}`);
  }
  const moved = o.refetchedBoard !== o.lease;
  const landed = o.boardStatus === 'ok' || o.ourWriterOnChain;
  if (!landed && !moved && o.boardStatus === 'none') return { outcome: 'network', streak: o.previousStreak };
  return classifyPush({ refMovedSinceLease: moved, ourOpIdsPresent: landed, previousStreak: o.previousStreak });
}
