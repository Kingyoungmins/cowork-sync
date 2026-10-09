import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import type { Clock } from '../../src/ports/clock.js';
import { type Random, realRandom, seededRandom, randomHex, randomInt, ulid } from '../../src/ports/random.js';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function fixedClock(wall: number): Clock {
  return { monoMs: () => 0, wallMs: () => wall, sleep: async () => {} };
}

/** A Random that replays the given bytes, then throws. */
function scripted(bytes: number[]): Random {
  let i = 0;
  return {
    bytes(n: number): Uint8Array {
      if (i + n > bytes.length) throw new Error('scripted Random exhausted');
      const out = Uint8Array.from(bytes.slice(i, i + n));
      i += n;
      return out;
    },
  };
}

/** Independent reference sfc32 (public-domain formulation). */
function referenceSfc32(seed: string, nBytes: number): string {
  const h = createHash('sha256').update(seed, 'utf8').digest();
  let a = h.readUInt32LE(0), b = h.readUInt32LE(4), c = h.readUInt32LE(8), d = h.readUInt32LE(12);
  const next = (): number => {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
  for (let i = 0; i < 12; i++) next();
  const out = Buffer.alloc(Math.ceil(nBytes / 4) * 4);
  for (let i = 0; i < out.length; i += 4) out.writeUInt32LE(next(), i);
  return out.subarray(0, nBytes).toString('hex');
}

function decodeUlidRandom(s: string): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const ch of s) {
    acc = (acc << 5) | CROCKFORD.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
      acc &= (1 << bits) - 1;
    }
  }
  return out;
}

test('realRandom returns n fresh bytes', () => {
  const a = realRandom.bytes(32);
  const b = realRandom.bytes(32);
  assert.ok(a instanceof Uint8Array);
  assert.equal(a.length, 32);
  assert.notDeepEqual(a, b);
  assert.equal(realRandom.bytes(0).length, 0);
  assert.throws(() => realRandom.bytes(-1), RangeError);
  assert.throws(() => realRandom.bytes(1.5), RangeError);
});

test('seededRandom: golden vectors (sfc32 seeded from sha256, 12 warm-up rounds)', () => {
  assert.equal(randomHex(seededRandom('cowork'), 16), '9cd5ba725424fadd4621fed4bd155f99');
  assert.equal(randomHex(seededRandom(''), 8), '3ce97530734d55cb');
  assert.equal(randomHex(seededRandom('홍길동'), 8), 'c28a951704848970');
  for (const seed of ['cowork', '', 'seed-1', '홍길동']) {
    assert.equal(randomHex(seededRandom(seed), 37), referenceSfc32(seed, 37), `seed ${JSON.stringify(seed)}`);
  }
});

test('seededRandom: same seed same stream, different seed different stream', () => {
  assert.deepEqual(seededRandom('a').bytes(64), seededRandom('a').bytes(64));
  assert.notDeepEqual(seededRandom('a').bytes(64), seededRandom('b').bytes(64));
  assert.throws(() => seededRandom('a').bytes(-1), RangeError);
});

test('seededRandom: the byte stream does not depend on how it is split into calls', () => {
  fc.assert(
    fc.property(fc.string(), fc.array(fc.integer({ min: 0, max: 17 }), { maxLength: 20 }), (seed, sizes) => {
      const total = sizes.reduce((s, n) => s + n, 0);
      const r = seededRandom(seed);
      const parts = Buffer.concat(sizes.map((n) => r.bytes(n)));
      assert.deepEqual(parts, Buffer.from(seededRandom(seed).bytes(total)));
    }),
    { seed: 20261002, numRuns: 200 },
  );
});

test('randomHex: lowercase hex, 2*nBytes chars', () => {
  const r = seededRandom('hex');
  assert.match(randomHex(r, 8), /^[0-9a-f]{16}$/);
  assert.equal(randomHex(r, 0), '');
  assert.equal(randomHex(scripted([0xab, 0x01, 0xff]), 3), 'ab01ff');
});

test('randomInt: argument checks', () => {
  const r = seededRandom('int');
  for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 32 + 1]) {
    assert.throws(() => randomInt(r, bad), RangeError, `maxExclusive ${bad}`);
  }
  assert.equal(randomInt(r, 1), 0);
  const big = randomInt(r, 2 ** 32);
  assert.ok(Number.isInteger(big) && big >= 0 && big < 2 ** 32);
});

test('randomInt: rejects the biased tail instead of taking a modulo', () => {
  // 2^32 mod 3 = 1, so 0xFFFFFFFF is the only rejected value for max 3.
  const r = scripted([0xff, 0xff, 0xff, 0xff, 0x05, 0x00, 0x00, 0x00]);
  assert.equal(randomInt(r, 3), 2);
});

test('randomInt: every value in range, roughly uniform', () => {
  const r = seededRandom('uniform');
  const counts = new Array<number>(6).fill(0);
  for (let i = 0; i < 60_000; i++) {
    const v = randomInt(r, 6);
    assert.ok(v >= 0 && v < 6);
    counts[v]!++;
  }
  for (const c of counts) assert.ok(c > 9_400 && c < 10_600, `bucket count ${c}`);
});

test('ulid: time part follows the ULID spec example', () => {
  const zeros: Random = { bytes: (n) => new Uint8Array(n) };
  const ones: Random = { bytes: (n) => new Uint8Array(n).fill(0xff) };
  assert.equal(ulid(zeros, fixedClock(1469918176385)), '01ARYZ6S410000000000000000');
  assert.equal(ulid(ones, fixedClock(0)), '0000000000ZZZZZZZZZZZZZZZZ');
  assert.equal(ulid(zeros, fixedClock(2 ** 48 - 1)), '7ZZZZZZZZZ0000000000000000');
  assert.throws(() => ulid(zeros, fixedClock(2 ** 48)), RangeError);
  assert.throws(() => ulid(zeros, fixedClock(-1)), RangeError);
});

test('ulid: golden value from a seeded Random and a fixed wall time', () => {
  assert.equal(ulid(seededRandom('cowork'), fixedClock(1_767_225_600_000)), '01KDVDNA00KKAVMWJM4KXDTHH1');
});

test('ulid: 26 Crockford chars whose random part round-trips the 10 random bytes', () => {
  fc.assert(
    fc.property(fc.uint8Array({ minLength: 10, maxLength: 10 }), fc.integer({ min: 0, max: 2 ** 48 - 1 }), (bytes, wall) => {
      const id = ulid(scripted([...bytes]), fixedClock(wall));
      assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
      assert.deepEqual(decodeUlidRandom(id.slice(10)), [...bytes]);
      let t = 0;
      for (const ch of id.slice(0, 10)) t = t * 32 + CROCKFORD.indexOf(ch);
      assert.equal(t, wall);
    }),
    { seed: 20261002, numRuns: 300 },
  );
});
