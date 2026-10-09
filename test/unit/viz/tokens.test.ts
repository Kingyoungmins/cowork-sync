// Tokens of 12 §3.10.2 (VIZ-31): tokenEquals and TokenAuthority over the Random and Clock ports.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { seededRandom } from '../../../src/ports/random.js';
import { VirtualClock } from '../../sim/vclock.js';
import { LAUNCH_TTL_MS, TokenAuthority, tokenEquals } from '../../../src/viz/server/tokens.js';

const HEX64 = /^[0-9a-f]{64}$/;
const INSTANCE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/** `s` with the character at `i` replaced by another lowercase hex digit. */
function flip(s: string, i: number): string {
  const c = s[i] === '0' ? '1' : '0';
  return s.slice(0, i) + c + s.slice(i + 1);
}

test('T-VIZ-token: wrong length, upper case, non-hex and near misses are false without throwing; the right token is true; timingSafeEqual always gets two 32-byte digests', () => {
  const calls: Array<[number, number]> = [];
  const spy = mock.method(crypto, 'timingSafeEqual', (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
    calls.push([a.byteLength, b.byteLength]);
    return Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0;
  });
  try {
    const expected = 'a'.repeat(32) + '0123456789abcdef'.repeat(2);
    assert.match(expected, HEX64);
    const wrong = [
      '', 'a', expected.slice(1), expected + '0', expected.slice(0, 63), `${expected}\n`, ` ${expected}`, `${expected.slice(0, 63)} `,
      expected.toUpperCase(), expected.slice(0, 63) + 'A', expected.slice(0, 63) + 'g', 'z'.repeat(64), '-'.repeat(64),
      // Fullwidth digits and a Unicode digit: not ASCII hex.
      String.fromCharCode(0xff10).repeat(64), String.fromCharCode(0x0660).repeat(64),
      flip(expected, 0), flip(expected, 31), flip(expected, 63), expected.split('').reverse().join(''), '0'.repeat(64), 'f'.repeat(64),
    ];
    for (const w of wrong) {
      let r: boolean | undefined;
      assert.doesNotThrow(() => { r = tokenEquals(w, expected); }, `no throw for ${JSON.stringify(w)}`);
      assert.equal(r, false, `false for ${JSON.stringify(w)}`);
    }
    assert.equal(tokenEquals(expected, expected), true);
    assert.equal(tokenEquals(String(expected), expected.slice(0)), true);
    assert.ok(calls.length >= 1, 'timingSafeEqual is used');
    for (const [a, b] of calls) assert.deepEqual([a, b], [32, 32]);
    // Every well-formed presentation reaches timingSafeEqual (no early exit on a near miss).
    const wellFormed = wrong.filter((w) => HEX64.test(w)).length + 2;
    assert.equal(calls.length, wellFormed);
  } finally {
    spy.mock.restore();
  }
});

test('TokenAuthority: launch and session are 64 lowercase hex from Random, instance is 8 base32c characters; the same seed gives the same tokens', () => {
  const clock = new VirtualClock();
  const a = new TokenAuthority(seededRandom('tokens'), clock);
  const b = new TokenAuthority(seededRandom('tokens'), clock);
  const c = new TokenAuthority(seededRandom('other'), clock);
  assert.match(a.launch, HEX64);
  assert.match(a.instance, INSTANCE);
  assert.equal(a.launch, b.launch);
  assert.equal(a.instance, b.instance);
  assert.notEqual(a.launch, c.launch);
  assert.equal(a.redeemed(), false);
  const r = a.redeem(a.launch);
  assert.ok(r.ok);
  assert.match(r.session, HEX64);
  assert.notEqual(r.session, a.launch);
  assert.equal(r.instance, a.instance);
  assert.equal(a.redeemed(), true);
  assert.equal(a.checkSession(r.session), true);
  assert.equal(a.checkSession(a.launch), false);
  assert.equal(a.checkSession(undefined), false);
  assert.equal(a.checkSession(r.session.toUpperCase()), false);
});

test('TokenAuthority: base32c instance of 5 random bytes (RFC 4648 bit order, Crockford alphabet)', () => {
  // seededRandom is a byte stream: the instance is drawn after the two 32-byte tokens.
  const bytes = seededRandom('instance').bytes(69).subarray(64, 69);
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let want = '';
  for (let i = 0; i < 40; i += 5) want += alphabet[parseInt(bits.slice(i, i + 5), 2)];
  assert.equal(new TokenAuthority(seededRandom('instance'), new VirtualClock()).instance, want);
});

test('TokenAuthority.redeem: shape, mismatch, single use, reuse revokes the session, TTL by own staleness', () => {
  const clock = new VirtualClock();
  const t = new TokenAuthority(seededRandom('redeem'), clock);
  assert.deepEqual(t.redeem(undefined), { ok: false, why: 'shape' });
  assert.deepEqual(t.redeem(t.launch.toUpperCase()), { ok: false, why: 'shape' });
  assert.deepEqual(t.redeem(flip(t.launch, 10)), { ok: false, why: 'mismatch' });
  assert.equal(t.redeemed(), false);
  clock.advance(LAUNCH_TTL_MS);
  assert.equal(t.launchExpired(), false, 'valid for 120 s');
  const ok = t.redeem(t.launch);
  assert.ok(ok.ok);
  assert.equal(t.checkSession(ok.session), true);
  assert.deepEqual(t.redeem(t.launch), { ok: false, why: 'reused' });
  assert.equal(t.checkSession(ok.session), false, 'the session minted from a reused launch token is revoked');
  assert.deepEqual(t.redeem(t.launch), { ok: false, why: 'reused' });
  assert.deepEqual(t.redeem(flip(t.launch, 0)), { ok: false, why: 'mismatch' });
});

test('TokenAuthority: a suspend gap (wall advances, mono does not) counts toward the 120 s TTL', () => {
  assert.equal(LAUNCH_TTL_MS, 120_000);
  const clock = new VirtualClock();
  const t = new TokenAuthority(seededRandom('suspend'), clock);
  clock.suspend(LAUNCH_TTL_MS + 1_000);
  assert.equal(t.launchExpired(), true);
  assert.deepEqual(t.redeem(t.launch), { ok: false, why: 'expired' });
  assert.equal(t.redeemed(), false);
  const mono = new VirtualClock();
  const u = new TokenAuthority(seededRandom('mono'), mono);
  mono.advance(LAUNCH_TTL_MS + 1);
  assert.deepEqual(u.redeem(u.launch), { ok: false, why: 'expired' });
});
