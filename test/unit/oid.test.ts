import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ABSENT, isOid, oid12, OidError, parseOid } from '../../src/git/oid.js';

const SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const SHA256 = '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321';

test('parseOid accepts 40 and 64 lowercase hex and rejects empty, short, uppercase and whitespace input', () => {
  assert.equal(parseOid(SHA1), SHA1);
  assert.equal(parseOid(SHA256), SHA256);
  // One trailing LF (git's stdout) is stripped, nothing else.
  assert.equal(parseOid(`${SHA1}\n`), SHA1);
  assert.equal(parseOid(`${SHA256}\n`), SHA256);
  const bad = [
    '',
    '\n',
    SHA1.slice(0, 39),
    SHA1.slice(0, 12),
    `${SHA1}0`,
    SHA1.toUpperCase(),
    `${SHA1.slice(0, 39)}G`,
    ` ${SHA1}`,
    `${SHA1} `,
    `${SHA1}\n\n`,
    `${SHA1}\r\n`,
    `${SHA1}\t`,
    `${SHA1}\n${SHA1}`,
    'HEAD',
    '0'.repeat(41),
    '0'.repeat(63),
    'a'.repeat(65),
  ];
  for (const s of bad) assert.throws(() => parseOid(s), OidError, JSON.stringify(s));
  assert.throws(() => parseOid(undefined as unknown as string), OidError);
});

test('isOid is the boolean form of parseOid without the newline strip', () => {
  assert.equal(isOid(SHA1), true);
  assert.equal(isOid(SHA256), true);
  assert.equal(isOid(`${SHA1}\n`), false);
  assert.equal(isOid(SHA1.toUpperCase()), false);
  assert.equal(isOid(''), false);
  assert.equal(isOid(null), false);
  assert.equal(isOid(42), false);
  assert.equal(isOid(undefined), false);
});

test('oid12 is the first 12 hex chars; ABSENT is the JSON form of an absent side', () => {
  assert.equal(oid12(parseOid(SHA1)), '4b825dc642cb');
  assert.equal(oid12(parseOid(SHA256)), '6ef19b41225c');
  assert.equal(ABSENT, 'ABSENT');
});
