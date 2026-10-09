import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validId, validName, validPathSyntax } from '../../src/sec/validators.js';

test("validPathSyntax accepts repo-relative NFC paths and rejects '..', a leading '/', 'C:/x', 'a:b', 'a\\b', NUL, NFD and over 4,096 bytes", () => {
  for (const ok of ['a', 'src/a.txt', 'a/b/c.d', '.hidden/x', 'sp ace/f', '한글/파일.md', 'caf\u00e9/x', 'a..b/c', '...']) {
    assert.equal(validPathSyntax(ok), true, ok);
  }
  const bad: Array<[string, string]> = [
    ['', 'empty'],
    ['..', 'dotdot'],
    ['a/../b', 'dotdot segment'],
    ['../a', 'leading dotdot'],
    ['a/..', 'trailing dotdot'],
    ['/a', 'leading slash'],
    ['a//b', 'empty component'],
    ['a/', 'trailing slash'],
    ['C:/x', 'drive letter'],
    ['c:x', 'drive letter no slash'],
    ['a:b', 'colon'],
    ['a\\b', 'backslash'],
    ['a\0b', 'NUL'],
    ['cafe\u0301/x', 'NFD'],
    ['\ud800x', 'lone surrogate'],
  ];
  for (const [p, why] of bad) assert.equal(validPathSyntax(p), false, why);
  // exactly 4,096 bytes passes, 4,097 fails (ASCII components of 100 bytes plus separators)
  const comp = 'a'.repeat(99);
  const parts: string[] = [];
  while (parts.join('/').length + 1 + comp.length < 4096) parts.push(comp);
  let p = parts.join('/');
  p += '/' + 'b'.repeat(4096 - p.length - 1);
  assert.equal(Buffer.byteLength(p, 'utf8'), 4096);
  assert.equal(validPathSyntax(p), true);
  assert.equal(validPathSyntax(`${p}b`), false);
  // multi-byte: the limit is bytes, not code units
  const hangul = '한'.repeat(1366); // 4098 bytes
  assert.equal(validPathSyntax(hangul), false);
  assert.equal(validPathSyntax('한'.repeat(1365)), true); // 4095 bytes
});

test('validId accepts op ids, ULIDs, cs ids and 128-bit hex and rejects near misses', () => {
  const h1 = 'a'.repeat(32);
  const h2 = '0123456789abcdef0123456789abcdef';
  assert.equal(validId('op', `${h1}/${h2}/1`), true);
  assert.equal(validId('op', `${h1}/${h2}/4096`), true);
  for (const bad of [
    `${h1}/${h2}/0`, `${h1}/${h2}/-1`, `${h1}/${h2}/01`, `${h1}/${h2}/1.5`, `${h1}/${h2}/`, `${h1}/${h2}`,
    `${h1.toUpperCase()}/${h2}/1`, `${h1.slice(1)}/${h2}/1`, `${h1}/${h2}/1/1`, ` ${h1}/${h2}/1`, `${h1}/${h2}/1\n`,
  ]) {
    assert.equal(validId('op', bad), false, bad);
  }

  assert.equal(validId('ulid', '01ARZ3NDEKTSV4RRFFQ69G5FAV'), true);
  for (const bad of [
    '01ARZ3NDEKTSV4RRFFQ69G5FA', '01ARZ3NDEKTSV4RRFFQ69G5FAVV', '01ARZ3NDEKTSV4RRFFQ69G5FAI', '01ARZ3NDEKTSV4RRFFQ69G5FAL',
    '01ARZ3NDEKTSV4RRFFQ69G5FAO', '01ARZ3NDEKTSV4RRFFQ69G5FAU', '01arz3ndektsv4rrffq69g5fav', '81ARZ3NDEKTSV4RRFFQ69G5FAV', '',
  ]) {
    assert.equal(validId('ulid', bad), false, bad);
  }

  assert.equal(validId('cs', `${h1}/1`), true);
  assert.equal(validId('cs', `${h1}/human/7`), true);
  for (const bad of [`${h1}/0`, `${h1}/human/0`, `${h1}/human/`, `${h1}/human`, `${h1}/x`, `${h1}/01`, `${h1}/human/01`, `${h1}/1/2`, `${h2}x/1`, `${h1}//1`, '1']) {
    assert.equal(validId('cs', bad), false, bad);
  }

  assert.equal(validId('hex128', h2), true);
  for (const bad of [h2.toUpperCase(), h2.slice(1), `${h2}0`, 'g'.repeat(32), '', `${h2}\n`]) assert.equal(validId('hex128', bad), false, bad);
});

test('validName', () => {
  for (const ok of ['Ann', 'Ann Lee', "O'Brien-Smith", 'user_1.x', '한글 이름', 'José', 'a'.repeat(64), '\u0301'.repeat(1) + 'a']) {
    assert.equal(validName(ok), true, ok);
  }
  for (const bad of ['', 'a'.repeat(65), 'a\nb', 'a<b', 'a/b', 'a\0b', 'a\tb', '<script>', 'a:b', 'a\u202eb', '😀']) {
    assert.equal(validName(bad), false, JSON.stringify(bad));
  }
});
