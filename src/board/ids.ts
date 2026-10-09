// Peer, epoch and op ids, Crockford base32 and the content hash H (glossary §2, §3; 02-protocol §3.2; PRO-11).
// The id grammar is SEC-35's validId (src/sec/validators.ts): every id minted here passes it, and an id
// that passes it parses here unless its seq exceeds Number.MAX_SAFE_INTEGER.
import { createHash } from 'node:crypto';
import { randomHex, type Random } from '../ports/random.js';
import { validId } from '../sec/validators.js';

/** 128-bit random, 32 lowercase hex (glossary §2). */
export type PeerId = string;
/** 128-bit random, 32 lowercase hex, regenerated whenever the peer's local state is (re)initialised. */
export type EpochId = string;
export interface OpId { peer: PeerId; epoch: EpochId; seq: number; }

/** `${peer}/${epoch}/${seq}`; anything validId('op') would refuse (or a seq that is not a safe integer >= 1) throws. */
export function formatOpId(id: OpId): string {
  if (!Number.isSafeInteger(id.seq) || id.seq < 1) throw new RangeError(`formatOpId: seq must be a safe integer >= 1, got ${String(id.seq)}`);
  const s = `${id.peer}/${id.epoch}/${id.seq}`;
  if (!validId('op', s)) throw new RangeError(`formatOpId: not an op id ${JSON.stringify(s)}`);
  return s;
}

/** The inverse of formatOpId; null for anything validId('op') refuses or a seq beyond Number.MAX_SAFE_INTEGER. */
export function parseOpId(s: string): OpId | null {
  if (!validId('op', s)) return null;
  const [peer, epoch, seqText] = s.split('/') as [string, string, string];
  const seq = Number(seqText);
  // The round trip rejects decimals that only round to a safe integer (9007199254740993).
  if (!Number.isSafeInteger(seq) || String(seq) !== seqText) return null;
  return { peer, epoch, seq };
}

export function newPeerId(r: Random): PeerId {
  return randomHex(r, 16);
}

export function newEpoch(r: Random): EpochId {
  return randomHex(r, 16);
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Crockford base32 of a byte string: 5-bit groups taken most significant bit first across the bytes
 * (RFC 4648 bit order), the last group zero-padded on the right, no padding characters, upper case.
 */
export function base32c(bytes: Uint8Array): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(acc >>> bits) & 31]!;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD[(acc << (5 - bits)) & 31]!;
  return out;
}

/** `base32c(sha256(utf8(x) ‖ 0x00 ‖ utf8(y)))[0:8]` (glossary §3, PRO-11). */
export function H(x: string, y: string): string {
  const digest = createHash('sha256').update(Buffer.concat([Buffer.from(x, 'utf8'), Buffer.from([0]), Buffer.from(y, 'utf8')])).digest();
  return base32c(digest).slice(0, 8);
}
