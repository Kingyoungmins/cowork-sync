// The change-set id grammar's two actors (glossary §2, 12 §9.7 item 4; Plan 8a ruling R-V07): a human change-set
// `<peer_id>/human/<n>` and a seat turn `<seat_id>/<turn-seq>`. Built on SEC-35's validId('cs'), so the engine and the
// viewer share one grammar (Plans 3/5 import it from here) without reopening src/sec/validators.ts.
import { validId } from '../sec/validators.js';
import type { PeerId } from './ids.js';

export type CsActor = { kind: 'human'; peer: PeerId; n: number } | { kind: 'seat'; seat: string; turnSeq: number };

/** A positive decimal counter that is a safe integer (validId has already refused 0, signs and leading zeros). */
function counter(s: string): number | null {
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= 1 && String(n) === s ? n : null;
}

/** validId('cs'); counters are safe integers >= 1; anything else null. */
export function parseCsActor(csId: string): CsActor | null {
  if (typeof csId !== 'string' || !validId('cs', csId)) return null;
  const parts = csId.split('/');
  if (parts.length === 3) {
    const n = counter(parts[2]!);
    return n === null ? null : { kind: 'human', peer: parts[0]!, n };
  }
  const turnSeq = counter(parts[1]!);
  return turnSeq === null ? null : { kind: 'seat', seat: parts[0]!, turnSeq };
}
