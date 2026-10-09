import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateBigBomCrlf } from '../sim/fixtures/bigBomCrlf.js';
import { seededRandom } from '../../src/ports/random.js';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function body(buf: Buffer): string {
  assert.ok(buf.subarray(0, 3).equals(BOM), 'starts with the UTF-8 BOM');
  return buf.subarray(3).toString('utf8');
}

test('BOM, exactly N CRLF-terminated lines, no bare LF or CR', () => {
  for (const n of [1, 7, 8, 9, 50, 5_000]) {
    const text = body(generateBigBomCrlf(n, seededRandom(`lines-${n}`)));
    assert.equal(text.split('\r\n').length - 1, n, `line count for ${n}`);
    assert.ok(text.endsWith('\r\n'));
    const stripped = text.replace(/\r\n/g, '');
    assert.equal(stripped.includes('\n'), false, 'bare LF');
    assert.equal(stripped.includes('\r'), false, 'bare CR');
  }
});

test('zero lines is the BOM alone', () => {
  assert.ok(generateBigBomCrlf(0, seededRandom('zero')).equals(BOM));
});

test('same seed gives identical bytes; another seed gives different bytes', () => {
  const a = generateBigBomCrlf(2_000, seededRandom('fixture-seed'));
  const b = generateBigBomCrlf(2_000, seededRandom('fixture-seed'));
  const c = generateBigBomCrlf(2_000, seededRandom('other-seed'));
  assert.ok(a.equals(b));
  assert.equal(a.equals(c), false);
});

test('content has the §3.7 features: classes, decorators, setters, overloads, platform branches, Hangul', () => {
  const text = body(generateBigBomCrlf(5_000, seededRandom('features')));
  for (const needle of ['class Widget', '@property', '.setter', '@staticmethod', '@overload', 'sys.platform == "win32"', '한글 주석']) {
    assert.ok(text.includes(needle), needle);
  }
  assert.equal(Buffer.from(text, 'utf8').toString('utf8'), text, 'valid UTF-8');
});

test('26,436 lines is about 1.3 MB (the team-file stand-in, big26k.py)', () => {
  const buf = generateBigBomCrlf(26_436, seededRandom('big26k'));
  assert.ok(buf.length >= 1_100_000 && buf.length <= 1_600_000, `size ${buf.length}`);
});
