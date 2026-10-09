import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  cap, MARKS_PER_GRAPHEME_MAX, NAME_RAW_MAX, sanitize, VIZ_CAPS, VIZ_RAW_UNITS,
  type CapKind, type SanitizeChannel,
} from '../../../src/text/sanitize.js';

const CHANNELS: readonly SanitizeChannel[] = ['claude', 'deny', 'terminal', 'notification', 'log', 'viz'];
const FLAT: ReadonlySet<SanitizeChannel> = new Set<SanitizeChannel>(['notification', 'viz']);
const ESC = '\u001b';
const BEL = '\u0007';
const ELL = '\u{2026}';
const EM = '\u{2014}';
const SEG = new Intl.Segmenter('en', { granularity: 'grapheme' });
const graphemes = (s: string): string[] => Array.from(SEG.segment(s), (x) => x.segment);

const KINDS: Readonly<Record<CapKind, number>> = {
  name: 20, label: 80, path: 80, note: 280, branch: 80, room: 40, card: 400, tooltip: 200, plaque: 16, caption: 120, version: 20,
};
const ALL_KINDS = Object.keys(KINDS) as CapKind[];
const MIDDLE: ReadonlySet<CapKind> = new Set<CapKind>(['path', 'plaque', 'label']);

// The invariants of SEC-34's output, written independently of the implementation.
const BAD_CHAR = /[\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}\u{E0000}-\u{E007F}]/u;
const DASH_RUN = /[-\u{2010}-\u{2015}\u{2212}\u{FE58}\u{FE63}\u{FF0D}]{3,}/u;
const BARE_URL = /(?<![A-Za-z0-9])(?:javascript|vbscript|data|blob|file|mailto):/iu;
function checkOutput(out: string, ch: SanitizeChannel): void {
  const body = ch === 'claude' ? out.split('\n').join('') : out;
  assert.ok(!BAD_CHAR.test(body), `no control, format, tag or lone surrogate: ${JSON.stringify(out)}`);
  if (ch !== 'claude') assert.ok(!out.includes('\n'), 'no line break outside claude');
  assert.ok(!out.includes('<') && !out.includes('>'), 'no < or >');
  assert.equal(out, out.normalize('NFC'), 'NFC');
  assert.ok(!out.includes('://') && !BARE_URL.test(out), `no URL: ${JSON.stringify(out)}`);
  for (const line of out.split('\n')) assert.ok(!/^\s*\//u.test(line), `no leading / token: ${JSON.stringify(line)}`);
  if (FLAT.has(ch)) assert.ok(!DASH_RUN.test(out), 'no run of 3 dash-like characters');
}

test('sanitize strips controls, ANSI CSI, OSC 8, OSC 52, bidi, zero-width, format and tag characters in every channel and keeps \\n only in claude', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    [`a${ESC}[31mred${ESC}[0m b`, 'ared b'],                                        // CSI SGR
    [`a${ESC}[2J${ESC}[1;1Hb`, 'ab'],                                                // CSI erase and cursor
    ['a\u009b31mb', 'ab'],                                                           // 8-bit CSI
    [`x${ESC}]8;;https://evil.example/${ESC}\\link${ESC}]8;;${ESC}\\y`, 'xlinky'],   // OSC 8 hyperlink, ST terminators
    [`x${ESC}]8;;https://evil.example/${BEL}link${ESC}]8;;${BEL}y`, 'xlinky'],      // OSC 8 hyperlink, BEL terminators
    [`c${ESC}]52;c;ZXZpbA==${BEL}d`, 'cd'],                                          // OSC 52 clipboard write
    [`c\u009d52;c;ZXZpbA==\u009cd`, 'cd'],                                           // 8-bit OSC 52
    [`c${ESC}]0;title`, 'c'],                                                        // an unterminated OSC swallows the rest
    [`a${ESC}Pq#0;2;0;0;0${ESC}\\b`, 'ab'],                                          // DCS
    [`a${ESC}cb${ESC}(Bc${ESC}`, 'abc'],                                             // two-byte escapes, a lone ESC
    ['a\u{202E}b\u{202A}c\u{2066}d\u{2069}e\u{61C}f\u{202B}g\u{202C}h\u{202D}i\u{2067}j\u{2068}k', 'abcdefghijk'],   // bidi controls
    ['a\u{200B}b\u{200C}c\u{200D}d\u{200E}e\u{200F}f\u{2060}g\u{2061}h\u{2062}i\u{2063}j\u{2064}k\u{FEFF}l', 'abcdefghijkl'],   // zero-width and format
    ['a\u{AD}b\u{180E}c\u{FFF9}d', 'abcd'],                                              // other format characters
    ['t\u{E0001}a\u{E0041}g\u{E007F}\u{E0000}', 'tag'],                              // tag characters
    ['a\u0000b\u0001c\u0007d\u0008e\u0009f\u000Bg\u000Ch\u001Fi\u007Fj\u0080k\u0099l\u009Cm', 'abcdefghijklm'],   // C0, DEL and C1
    ['a\u009F_apc_payload\u009Cb', 'ab'],                                            // 8-bit APC string
    ['\uD800a\uDC00b\uDBFF', 'ab'],                                                  // lone surrogates
    ['\u{1F600}\u{1F468}\u{200D}\u{1F469}', '\u{1F600}\u{1F468}\u{1F469}'],            // pairs survive; ZWJ is a format character
  ];
  for (const ch of CHANNELS) {
    for (const [input, want] of cases) assert.equal(sanitize(input, ch), want, `${ch}: ${JSON.stringify(input)}`);
  }
  for (const ch of CHANNELS) {
    const out = sanitize('one\ntwo\r\nthree', ch);
    if (ch === 'claude') assert.equal(out, 'one\ntwo\nthree');
    else assert.equal(out, FLAT.has(ch) ? 'one two three' : 'onetwothree');
  }
  assert.equal(sanitize('a\r\nb\rc\u0085d\u{2028}e\u{2029}f', 'claude'), 'a\nb\nc\nd\ne\nf');
  for (const ch of CHANNELS) checkOutput(sanitize(cases.map(([s]) => s).join('\n'), ch), ch);
});

test('sanitize drops every default-ignorable code point (Mn and Lo included) in every channel, and nothing else of a word', () => {
  // Mn: CGJ, Khmer inherent vowels, Mongolian free variation selectors, variation selectors (FE0F too), variation selectors supplement;
  // Lo: the Hangul fillers. Cf (ZWJ, soft hyphen) and unassigned default-ignorables (U+2065, U+FFF0) go with them.
  const marks = ['\u{034F}', '\u{17B4}', '\u{17B5}', '\u{180B}', '\u{180D}', '\u{FE00}', '\u{FE0F}', '\u{E0100}', '\u{E01EF}',
    '\u{115F}', '\u{1160}', '\u{3164}', '\u{FFA0}', '\u{200D}', '\u{AD}', '\u{2065}', '\u{FFF0}'];
  for (const ch of CHANNELS) {
    for (const m of marks) {
      const hex = (m.codePointAt(0) as number).toString(16);
      assert.equal(sanitize(`Ann${m}`, ch), 'Ann', `${ch}: U+${hex} trailing`);
      assert.equal(sanitize(`${m}A${m}nn${m}`, ch), 'Ann', `${ch}: U+${hex} around`);
    }
    const out = sanitize(marks.join('x') + '\u{1F600}\u{AC00}\u{E9}', ch);
    assert.ok(!/\p{Default_Ignorable_Code_Point}/u.test(out), `${ch}: none left ${JSON.stringify(out)}`);
    assert.equal(out, 'x'.repeat(marks.length - 1) + '\u{1F600}\u{AC00}\u{E9}', `${ch}: only the marks are gone`);
    assert.equal(sanitize(out, ch), out, `${ch}: idempotent`);
  }
});

test('sanitize applies NFC, makes < and > full-width, replaces URLs with [link removed] and removes leading / command tokens on every line', () => {
  const urls: ReadonlyArray<readonly [string, string]> = [
    ['see https://evil.example/x?y=1 now', 'see [link removed] now'],
    ['HTTP://A.B/C', '[link removed]'],
    ['x javascript:alert(1)', 'x [link removed]'],
    ['JavaScript:void(0)', '[link removed]'],
    ['file:///etc/passwd', '[link removed]'],
    ['open data:text/html,hi', 'open [link removed]'],
    ['ftp://h/x and ssh://git@h/r', '[link removed] and [link removed]'],
    ['a1https://evil.example', '[link removed]'],
    ['(https://evil.example)', '([link removed]'],
    ['x---javascript:alert(1)', 'x---[link removed]'],
    ['src/www.example.com/a.ts', 'src/www.example.com/a.ts'],   // a path is not a URL
    ['Outer::Inner.m', 'Outer::Inner.m'],                         // a label is not a URL
    ['metadata:x', 'metadata:x'],
  ];
  for (const ch of CHANNELS) {
    assert.equal(sanitize('cafe\u{301} A\u{30A} \u{212A} \u{37E}', ch), 'caf\u{E9} \u{C5} K ;');
    assert.equal(sanitize('a\u{200B}e\u{301}', ch), 'a\u{E9}', 'a stripped character between a base and its mark: NFC after stripping');
    assert.equal(sanitize('<img src=x onerror=alert(1)></script>', ch), '\u{FF1C}img src=x onerror=alert(1)\u{FF1E}\u{FF1C}/script\u{FF1E}');
    for (const [input, want] of urls) {
      assert.equal(sanitize(input, ch), FLAT.has(ch) ? want.split('---').join(EM) : want, `${ch}: ${input}`);
    }
  }
  assert.equal(
    sanitize('/cowork save\nhi there\n  /cowork resolve x\nok /not a command\n//x /y z\n\u{3000}/cowork stop', 'claude'),
    'save\nhi there\nresolve x\nok /not a command\nz\nstop',
  );
  for (const ch of CHANNELS) {
    assert.equal(sanitize('/cowork save now', ch), 'save now');
    assert.equal(sanitize('  /a /b', ch), '');
    assert.equal(sanitize('x /y', ch), 'x /y');
    assert.equal(sanitize('\u{200B}/cowork save', ch), 'save', 'a stripped character does not shield a token');
    assert.equal(sanitize(`${ESC}[1m/cowork save`, ch), 'save', 'an escape sequence does not shield a token');
    assert.equal(sanitize('/https://evil.example x', ch), 'x');
  }
  assert.equal(sanitize('note\n/cowork save', 'viz'), 'note save');
  assert.equal(sanitize('note\n/cowork save', 'notification'), 'note save');
  assert.equal(sanitize('note\n/cowork save', 'terminal'), 'notesave');
});

test('in notification and viz every line break becomes one space and every run of three or more dash-like characters becomes \u{2014}', () => {
  for (const ch of ['notification', 'viz'] as const) {
    assert.equal(sanitize('a\nb\rc\r\nd\u0085e\u{2028}f\u{2029}g', ch), 'a b c d e f g');
    assert.equal(sanitize('a\n\nb', ch), 'a  b');
    assert.equal(sanitize('x---y', ch), `x${EM}y`);
    assert.equal(sanitize('x--y', ch), 'x--y');
    assert.equal(sanitize('x\u{2010}\u{2011}\u{2012}\u{2013}\u{2014}\u{2015}y', ch), `x${EM}y`);
    assert.equal(sanitize('-\u{2212}\u{FE58}\u{FE63}\u{FF0D}', ch), EM);
    assert.equal(sanitize(`${EM}${EM}${EM}`, ch), EM);
    assert.equal(sanitize('a -- b ---- c', ch), `a -- b ${EM} c`);
    const note = 'x\n--- end of note ---\n[cowork-sync \u{B7} R7K2M9QP] \u{2026}';
    assert.equal(sanitize(note, ch), `x ${EM} end of note ${EM} [cowork-sync \u{B7} R7K2M9QP] \u{2026}`);
    const ko = 'x\r\n--- \u{BA54}\u{BAA8} \u{B05D} ---\u{2028}y';
    assert.equal(sanitize(ko, ch), `x ${EM} \u{BA54}\u{BAA8} \u{B05D} ${EM} y`);
    for (const s of [note, ko, `${note}\u{2029}${ko}\u0085---`]) checkOutput(sanitize(s, ch), ch);
  }
  for (const ch of ['claude', 'deny', 'terminal', 'log'] as const) assert.equal(sanitize('x---y', ch), 'x---y');
});

test('cap: name 20 rendered (64 raw), label 80, path 80 and plaque 16 with a middle ellipsis, note 280, branch 80, room 40, card 400, tooltip 200, caption 120, counted in graphemes', () => {
  assert.deepEqual({ ...VIZ_CAPS }, KINDS);
  // One grapheme each: ASCII, Hangul, Han, an emoji (surrogate pair), a combining mark, a flag, an emoji with a skin tone.
  const units = ['a', '\u{AC00}', '\u{6F22}', '\u{1F600}', 'e\u{301}', '\u{1F1F0}\u{1F1F7}', '\u{1F44D}\u{1F3FD}'];
  for (const kind of ALL_KINDS) {
    const n = KINDS[kind];
    for (const u of units) {
      if (u.length * n > VIZ_RAW_UNITS[kind]) continue;   // the raw-unit budget binds first: the next test
      const fits = u.repeat(n);
      assert.equal(cap(fits, kind), fits, `${kind}: ${n} graphemes fit`);
      const g = graphemes(cap(u.repeat(n + 5), kind));
      assert.equal(g.length, n, `${kind}: capped to ${n} graphemes`);
      assert.equal(g.indexOf(ELL), MIDDLE.has(kind) ? Math.floor((n - 1) / 2) : n - 1, `${kind}: ellipsis position`);
      assert.equal(g.filter((x) => x === ELL).length, 1);
      assert.ok(g.every((x) => x === ELL || x === u), `${kind}: whole graphemes only`);
    }
  }
  const halves = 'h'.repeat(100) + 't'.repeat(100);
  for (const kind of ['path', 'label'] as const) assert.equal(cap(halves, kind), `${'h'.repeat(39)}${ELL}${'t'.repeat(40)}`);
  const plaque = 'averyveryverylongname.ts';
  assert.equal(cap(plaque, 'plaque'), `${plaque.slice(0, 7)}${ELL}${plaque.slice(-8)}`);
  for (const kind of ['note', 'branch', 'room', 'card', 'tooltip', 'caption', 'version', 'name'] as const) {
    assert.equal(cap('h'.repeat(1_000), kind), `${'h'.repeat(KINDS[kind] - 1)}${ELL}`);
  }
  // An emoji ZWJ sequence is one character: five 11-unit families are a 5-grapheme, 55-unit name.
  const family = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}';
  assert.equal(cap(family.repeat(5), 'name'), family.repeat(5));
  assert.equal(graphemes(family.repeat(5)).length, 5);
  const hangulName = '\u{AE40}\u{BBFC}\u{C601}'.repeat(7);   // 21 syllables
  assert.equal(cap(hangulName, 'name'), `${hangulName.slice(0, 19)}${ELL}`);
  assert.equal(cap('', 'name'), '');
});

test('cap cuts to VIZ_RAW_UNITS first, at a grapheme boundary, and keeps at most 4 combining marks per grapheme', () => {
  assert.equal(NAME_RAW_MAX, 64);
  assert.equal(MARKS_PER_GRAPHEME_MAX, 4);
  for (const kind of ALL_KINDS) assert.equal(VIZ_RAW_UNITS[kind], kind === 'name' ? 64 : 4 * KINDS[kind], kind);
  const family = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}';
  assert.equal(family.length, 11);
  // R-V50's case: an 80-emoji family-ZWJ path (880 code units for an 80-grapheme cap); and 200 of them for the other kinds.
  for (const [kind, count] of [['path', 80], ['name', 200], ['plaque', 200], ['note', 200], ['label', 200]] as const) {
    const r = cap(family.repeat(count), kind);
    assert.ok(r.length <= VIZ_RAW_UNITS[kind], `${kind}: ${r.length} code units`);
    const g = graphemes(r);
    assert.equal(g.filter((x) => x === ELL).length, 1, `${kind}: one ellipsis`);
    assert.ok(g.every((x) => x === ELL || x === family), `${kind}: never splits a surrogate pair or a ZWJ sequence`);
    assert.ok(!/\p{Cs}/u.test(r));
  }
  const marks = Array.from({ length: 30 }, (_, i) => String.fromCodePoint(0x300 + i)).join('');
  const stacked = `a${marks}`.repeat(80);
  assert.equal(graphemes(stacked).length, 80);
  for (const kind of ['path', 'name', 'label'] as const) {
    const r = cap(stacked, kind);
    assert.ok(r.length <= VIZ_RAW_UNITS[kind], `${kind}: ${r.length} code units`);
    const g = graphemes(r);
    assert.ok(g.length > 1);
    for (const x of g) if (x !== ELL) assert.equal(x, `a${marks.slice(0, MARKS_PER_GRAPHEME_MAX)}`);
  }
  assert.equal(cap('a\u{301}\u{302}\u{303}\u{304}', 'name'), 'a\u{301}\u{302}\u{303}\u{304}');
  assert.equal(cap('a\u{301}\u{302}\u{303}\u{304}\u{305}\u{306}', 'name'), 'a\u{301}\u{302}\u{303}\u{304}');
  assert.equal(cap('x'.repeat(10) + family.repeat(10), 'name'), `${'x'.repeat(10)}${family.repeat(4)}${ELL}`);
  // A single grapheme longer than the budget cannot be cut inside: only the ellipsis remains.
  const longZwj = family + '\u{200D}\u{1F468}'.repeat(30);
  assert.equal(graphemes(longZwj).length, 1);
  assert.equal(cap(longZwj, 'name'), ELL);
  // Totality and both budgets for every kind, over arbitrary UTF-16 (lone surrogates included).
  const unit = fc.integer({ min: 0, max: 0xffff }).map((c) => String.fromCharCode(c));
  const piece = fc.oneof(unit, fc.constantFrom(family, '\u{301}', '\u{308}', 'e', '\u{1F1F0}', '\u{200D}', '\u{AC00}', '\u{1100}', '\u{1161}'));
  fc.assert(
    fc.property(fc.array(piece, { maxLength: 400, size: 'max' }).map((xs) => xs.join('')), fc.constantFrom(...ALL_KINDS), (s, kind) => {
      const r = cap(s, kind);
      assert.ok(r.length <= VIZ_RAW_UNITS[kind]);
      const g = graphemes(r);
      assert.ok(g.length <= VIZ_CAPS[kind]);
      for (const x of g) assert.ok((x.match(/\p{M}/gu) ?? []).length <= MARKS_PER_GRAPHEME_MAX);
      if (s.length <= Math.min(VIZ_CAPS[kind], VIZ_RAW_UNITS[kind]) && !/\p{M}/u.test(s)) assert.equal(r, s);
    }),
    { numRuns: 1500 },
  );
});

// Arbitrary text biased towards the characters each pass treats specially, built from UTF-16 code units so lone
// surrogates occur.
const INTERESTING = [
  ESC, '[', ']', '\\', BEL, '\u009b', '\u009d', '\u009c', 'P', '/', ':', '//', '://', '<', '>', '-', EM, '\u{2212}', '\u{FF0D}',
  '\n', '\r', '\u0085', '\u{2028}', '\u{2029}', ' ', '\t', '\u{3000}', '\u{301}', '\u{338}', '\u{200D}', '\u{200B}', '\u{202E}', '\u{AD}', '\u{FEFF}',
  '\uD800', '\uDC00', '\u{212A}', '\u{17F}', '\u{37E}', 'h', 't', 'p', 's', 'a', '0', '_', '+', '.', 'javascript:', 'data:', 'http://',
  'www.', '[link removed]', '\u{AC00}', '\u{1100}', '\u{1161}', '\u{1F468}', '\u{E0041}', '\u{1F1F0}', '\u0000',
];
const pieceArb = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(...INTERESTING) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 0xffff }).map((c) => String.fromCharCode(c)) },
  { weight: 1, arbitrary: fc.integer({ min: 0x10000, max: 0x10ffff }).map((c) => String.fromCodePoint(c)) },
);

test('sanitize is total and idempotent', () => {
  fc.assert(
    fc.property(fc.array(pieceArb, { maxLength: 60, size: 'max' }).map((xs) => xs.join('')), fc.constantFrom(...CHANNELS), (s, ch) => {
      const once = sanitize(s, ch);
      assert.equal(sanitize(once, ch), once, `idempotent in ${ch}: ${JSON.stringify(s)}`);
      checkOutput(once, ch);
    }),
    { numRuns: 4000 },
  );
  // 10 KB inputs
  fc.assert(
    fc.property(fc.array(pieceArb, { minLength: 4500, maxLength: 5500 }).map((xs) => xs.join('')), fc.constantFrom(...CHANNELS), (s, ch) => {
      assert.ok(s.length >= 4500);
      const once = sanitize(s, ch);
      assert.equal(sanitize(once, ch), once);
      checkOutput(once, ch);
    }),
    { numRuns: 24 },
  );
  for (const ch of CHANNELS) {
    for (const s of ['x'.repeat(10_240), 'a:'.repeat(5_120), '/'.repeat(10_240), `${ESC}]`.repeat(5_120), 'h'.repeat(10_235) + '://x', '-'.repeat(10_240)]) {
      const once = sanitize(s, ch);
      assert.equal(sanitize(once, ch), once);
      checkOutput(once, ch);
    }
  }
  // cap(sanitize(x)) is sanitize-stable too. sanitize keeps a bare scheme an alphanumeric character shields ("xfile:abc"); a middle
  // ellipsis must not cut between the shield and the scheme, or "...file:abc" would be a live URL after it.
  assert.equal(cap(sanitize('averyverylongxfile:abc', 'viz'), 'plaque'), `averyve${ELL}ile:abc`);
  const schemes = ['javascript', 'vbscript', 'data', 'blob', 'file', 'mailto', 'JavaScript', 'DATA', 'java\u{17F}cript'];
  for (const ch of CHANNELS) {
    for (const kind of ALL_KINDS) {
      for (const scheme of schemes) {
        for (let tail = 0; tail <= 48; tail++) {
          const capped = cap(sanitize(`${'a'.repeat(300)}x${scheme}:${'b'.repeat(tail)}`, ch), kind);
          assert.equal(sanitize(capped, ch), capped, `${ch} ${kind}: ${JSON.stringify(capped)}`);
          checkOutput(capped, ch);
        }
      }
      // a long note (or any kind) cut across a URL never shows one
      for (let head = 0; head <= 420; head += 3) {
        const capped = cap(sanitize(`${'n'.repeat(head)} https://e.example/a?b=1 ${'m'.repeat(400)}`, ch), kind);
        assert.equal(sanitize(capped, ch), capped, `${ch} ${kind}: ${JSON.stringify(capped)}`);
        checkOutput(capped, ch);
      }
    }
  }
  const capPiece = fc.oneof(
    { weight: 4, arbitrary: pieceArb },
    { weight: 1, arbitrary: fc.constantFrom(...schemes).map((s) => `x${s}:`) },
    { weight: 1, arbitrary: fc.nat({ max: 60 }).map((n) => 'a'.repeat(n)) },
  );
  fc.assert(
    fc.property(
      fc.array(capPiece, { maxLength: 40 }).map((xs) => xs.join('')), fc.constantFrom(...CHANNELS), fc.constantFrom(...ALL_KINDS),
      (s, ch, kind) => {
        const capped = cap(sanitize(s, ch), kind);
        assert.equal(sanitize(capped, ch), capped, `${ch} ${kind}: ${JSON.stringify(s)}`);
        checkOutput(capped, ch);
      },
    ),
    { numRuns: 3000 },
  );
});
