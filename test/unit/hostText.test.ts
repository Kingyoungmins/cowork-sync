// ENG-45: the host's rejection text is kept for the doctor log only, sanitised: C0 controls (but TAB), DEL, C1 controls
// and the bidi controls never reach the log, line breaks become one space, and the text is capped by code points without
// ever splitting a surrogate pair.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOST_TEXT_MAX, hostText } from '../../src/engine/publish.js';

const b = (s: string): Buffer => Buffer.from(s, 'utf8');
/** No lone surrogate anywhere in s. */
function wellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

test('hostText strips C0 (but TAB), DEL, C1 and bidi controls; line breaks become one space', () => {
  const c0 = Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(i)).filter((ch) => ch !== '\t' && ch !== '\n' && ch !== '\r');
  for (const ch of c0) assert.equal(hostText(b(`a${ch}b`)), 'ab', `C0 U+${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
  assert.equal(hostText(b('a\tb')), 'a\tb', 'TAB is kept');
  assert.equal(hostText(b('a\x7fb')), 'ab', 'DEL');
  for (let cp = 0x80; cp <= 0x9f; cp++) assert.equal(hostText(b(`a${String.fromCodePoint(cp)}b`)), 'ab', `C1 U+${cp.toString(16)}`);
  const bidi = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
  for (const cp of bidi) assert.equal(hostText(b(`a${String.fromCodePoint(cp)}b`)), 'ab', `bidi U+${cp.toString(16)}`);
  // The invisible separators and format characters a host could use to hide or reflow text (Task 14 carry):
  // LINE SEPARATOR, PARAGRAPH SEPARATOR, ZERO WIDTH SPACE and the BOM / ZERO WIDTH NO-BREAK SPACE.
  for (const cp of [0x2028, 0x2029, 0x200b, 0xfeff]) assert.equal(hostText(b(`a${String.fromCodePoint(cp)}b`)), 'ab', `invisible U+${cp.toString(16)}`);
  assert.equal(hostText(b('remote: one\nremote: two\r\nremote: three\r')), 'remote: one remote: two remote: three ');
  assert.equal(hostText(b('é 한 \u{1F600}  ')), 'é 한 \u{1F600}  ', 'printable text and NBSP pass');
});

test('hostText caps by code points and never splits a surrogate pair', () => {
  const head = 'a'.repeat(HOST_TEXT_MAX - 1);
  const capped = hostText(b(`${head}\u{1F600}\u{1F600}tail`));
  assert.equal(capped, `${head}\u{1F600}`, 'the emoji at the boundary is the last code point kept, whole');
  assert.equal([...capped].length, HOST_TEXT_MAX);
  assert.ok(wellFormed(capped), 'no lone surrogate');
  // Stripped characters do not count toward the cap.
  const noisy = hostText(b(`${String.fromCodePoint(0x202e).repeat(10)}${'b'.repeat(HOST_TEXT_MAX)}`));
  assert.equal(noisy, 'b'.repeat(HOST_TEXT_MAX));
  assert.equal(hostText(b('short')), 'short');
});
