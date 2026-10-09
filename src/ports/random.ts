// Random port (11-testing §3.2). This is the only file in src/ that may use
// crypto.randomBytes, randomUUID or Math.random (lint L-RANDOM).
// Release builds bind realRandom; SIM runs bind seededRandom(seed) so that
// peer ids, ULIDs, nonces and preview ids are reproducible (TST-03).
import { createHash, randomBytes } from 'node:crypto';
import type { Clock } from './clock.js';

export interface Random {
  /** n fresh bytes (n: integer >= 0). */
  bytes(n: number): Uint8Array;
}

function checkCount(n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`Random.bytes: n must be an integer >= 0, got ${n}`);
}

export const realRandom: Random = {
  bytes(n: number): Uint8Array {
    checkCount(n);
    return new Uint8Array(randomBytes(n));
  },
};

/**
 * Deterministic PRNG: sfc32 whose 128-bit state is the first 16 bytes of
 * sha256(UTF-8 seed) read as four little-endian uint32, warmed up by 12
 * discarded outputs. Output words are emitted little-endian as one byte
 * stream, so bytes(3) followed by bytes(5) equals bytes(8).
 */
export function seededRandom(seed: string): Random {
  const h = createHash('sha256').update(seed, 'utf8').digest();
  let a = h.readUInt32LE(0);
  let b = h.readUInt32LE(4);
  let c = h.readUInt32LE(8);
  let d = h.readUInt32LE(12);
  const next = (): number => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
  for (let i = 0; i < 12; i++) next();
  let word = 0;
  let left = 0;
  return {
    bytes(n: number): Uint8Array {
      checkCount(n);
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        if (left === 0) {
          word = next();
          left = 4;
        }
        out[i] = word & 0xff;
        word >>>= 8;
        left--;
      }
      return out;
    },
  };
}

export function randomHex(r: Random, nBytes: number): string {
  return Buffer.from(r.bytes(nBytes)).toString('hex');
}

const TWO_POW_32 = 0x1_0000_0000;

/** Uniform integer in [0, maxExclusive), 1 <= maxExclusive <= 2^32, by rejection sampling on uint32 (no modulo bias). */
export function randomInt(r: Random, maxExclusive: number): number {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > TWO_POW_32) {
    throw new RangeError(`randomInt: maxExclusive must be an integer in [1, 2^32], got ${maxExclusive}`);
  }
  const limit = TWO_POW_32 - (TWO_POW_32 % maxExclusive);
  for (;;) {
    const b = r.bytes(4);
    const u = (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0;
    if (u < limit) return u % maxExclusive;
  }
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_TIME_MAX = 2 ** 48 - 1;

/**
 * ULID (26 chars, Crockford base32): 10 chars of the 48-bit wall-clock
 * millisecond timestamp, then 16 chars of 80 random bits. Ids are unique by
 * their random part; the time part is informational only (INV-CLOCK: no
 * decision may order ULIDs from different machines).
 */
export function ulid(r: Random, clock: Clock): string {
  const ms = Math.floor(clock.wallMs());
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > ULID_TIME_MAX) throw new RangeError(`ulid: wall time out of range: ${ms}`);
  let time = '';
  let t = ms;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  const bytes = r.bytes(10);
  let rand = '';
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      rand += CROCKFORD[(acc >>> bits) & 31]!;
    }
    acc &= (1 << bits) - 1;
  }
  return time + rand;
}
