import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import * as fc from 'fast-check';
import { enc, EncTooLongError, ENC_MAX_BYTES } from '../../src/git/enc.js';

test('ENC_MAX_BYTES is 150 (glossary §4)', () => {
  assert.equal(ENC_MAX_BYTES, 150);
});

test('enc keeps [A-Za-z0-9_-] and percent-encodes every other byte with uppercase hex', () => {
  const cases: Array<[string, string]> = [
    ['main', 'main'],
    ['my_branch-2', 'my_branch-2'],
    ['Feat/ABC', 'Feat%2FABC'],
    ['feature/login', 'feature%2Flogin'],
    ['release-1.2', 'release-1%2E2'],
    ['a b', 'a%20b'],
    ['100%', '100%25'],
    ['x~y', 'x%7Ey'],
    ['tab\there', 'tab%09here'],
    ['line\nbreak', 'line%0Abreak'],
    ['é', '%C3%A9'],
    ['한글', '%ED%95%9C%EA%B8%80'],
    ['😀', '%F0%9F%98%80'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(enc(input), expected, `enc(${JSON.stringify(input)})`);
  }
});

test('enc is injective on names that differ only by an escape sequence', () => {
  assert.notEqual(enc('a/b'), enc('a%2Fb'));
  assert.equal(enc('a%2Fb'), 'a%252Fb');
});

test('enc accepts exactly ENC_MAX_BYTES encoded bytes and refuses one more', () => {
  assert.equal(enc('a'.repeat(150)), 'a'.repeat(150));
  assert.throws(() => enc('a'.repeat(151)), EncTooLongError);
  assert.equal(enc('a'.repeat(147) + '/'), 'a'.repeat(147) + '%2F');
  assert.throws(() => enc('a'.repeat(148) + '/'), EncTooLongError);
  // '한' is 3 UTF-8 bytes -> 9 encoded bytes: 16 x 9 = 144 fits, 17 x 9 = 153 does not.
  assert.equal(enc('한'.repeat(16)).length, 144);
  assert.throws(() => enc('한'.repeat(17)), EncTooLongError);
});

test('EncTooLongError is an Error with its own name', () => {
  try {
    enc('x'.repeat(400));
    assert.fail('expected a throw');
  } catch (e) {
    assert.ok(e instanceof EncTooLongError);
    assert.ok(e instanceof Error);
    assert.equal(e.name, 'EncTooLongError');
  }
});

test('enc refuses an empty name and lone surrogates with a plain Error', () => {
  for (const bad of ['', '\uD800', 'a\uDC00b', 'x\uD83D']) {
    assert.throws(
      () => enc(bad),
      (e: unknown) => e instanceof Error && !(e instanceof EncTooLongError),
      `enc(${JSON.stringify(bad)})`,
    );
  }
});

function isUnreservedByte(b: number): boolean {
  return (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x5f || b === 0x2d;
}

function expectedEncodedLength(s: string): number {
  let n = 0;
  for (const b of Buffer.from(s, 'utf8')) n += isUnreservedByte(b) ? 1 : 3;
  return n;
}

function checkProperty(s: string): void {
  const expectedLen = expectedEncodedLength(s);
  if (expectedLen > ENC_MAX_BYTES) {
    assert.throws(() => enc(s), EncTooLongError);
    return;
  }
  const e = enc(s);
  assert.equal(e.length, expectedLen);
  assert.match(e, /^(?:[A-Za-z0-9_-]|%[0-9A-F]{2})*$/);
  assert.equal(decodeURIComponent(e), s);
}

// Strings are built from code points so the test works with every fast-check major version.
const anyCodePoint = fc.integer({ min: 0, max: 0x10ffff }).filter((c) => c < 0xd800 || c > 0xdfff);
const printableAscii = fc.integer({ min: 0x20, max: 0x7e });

test('property: enc output is canonical, round-trips through decodeURIComponent, and respects the cap', () => {
  fc.assert(
    fc.property(
      fc.array(anyCodePoint, { minLength: 1, maxLength: 40 }).map((cps) => String.fromCodePoint(...cps)),
      checkProperty,
    ),
    { numRuns: 500 },
  );
  fc.assert(
    fc.property(
      fc.array(printableAscii, { minLength: 1, maxLength: 200 }).map((cps) => String.fromCodePoint(...cps)),
      checkProperty,
    ),
    { numRuns: 500 },
  );
});
