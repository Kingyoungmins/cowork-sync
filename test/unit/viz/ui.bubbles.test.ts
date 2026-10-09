// Plan 8a Task 13: speech bubbles (12 §3.8 "Bubbles"; VIZ-23): reading-speed durations clamped to 1.5–6 s, divided by the
// replay speed but never below 1.0 s; 2 lines × 42 Latin or 16 full-width characters, then an ellipsis; one per actor, three
// per room.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BubbleSet, bubbleMs, wrapBubble } from '../../../src/viz/ui/bubbles.js';

const HANGUL = '\u{D55C}', HAN = '\u{6F22}', HIRA = '\u{3042}', KATA = '\u{30AB}';
const close = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;
/** Display width in Latin units: a full-width character counts 42/16. */
const width = (s: string): number => [...s].reduce((n, c) => n + (/[\u{3000}-\u{9FFF}\u{AC00}-\u{D7AF}\u{FF01}-\u{FF60}]/u.test(c) ? 42 / 16 : 1), 0);

test('T-VIZ-bubbles: Latin, Hangul, Han and kana durations; the 1.5 s and 6 s clamps; 2 lines × 42 Latin or 16 full-width then an ellipsis; one per actor, three per room with the oldest fading early; at 8× never below 1.0 s', () => {
  // 0.5 s + Σ 1/cps: Latin and other scripts 20 cps, Hangul 12, Han 9, and 4 for every character of a text that contains kana.
  assert.ok(close(bubbleMs('a'.repeat(40), 1), 500 + 40 * 50));                          // 2.5 s
  assert.ok(close(bubbleMs(HANGUL.repeat(24), 1), 500 + 24 * 1_000 / 12));               // 2.5 s
  assert.ok(close(bubbleMs(HAN.repeat(18), 1), 500 + 18 * 1_000 / 9));                    // 2.5 s
  assert.ok(close(bubbleMs(HIRA.repeat(5), 1), 500 + 5 * 250));                           // 1.75 s
  // One kana makes every character of the text 4 cps, Latin and Han included.
  assert.ok(close(bubbleMs(`ab${HAN}${KATA}`, 1), 500 + 4 * 250));
  // A mixed text without kana: each character at its own speed.
  assert.ok(close(bubbleMs(`${'x'.repeat(20)}${HANGUL.repeat(12)}${HAN.repeat(9)}`, 1), 500 + 1_000 + 1_000 + 1_000));
  // A combining sequence or an emoji ZWJ sequence is one character.
  assert.ok(close(bubbleMs('e\u{301}'.repeat(40), 1), bubbleMs('e'.repeat(40), 1)));
  // The clamps: never under 1.5 s, never over 6 s.
  assert.equal(bubbleMs('', 1), 1_500);
  assert.equal(bubbleMs('ok', 1), 1_500);
  assert.equal(bubbleMs('a'.repeat(400), 1), 6_000);
  assert.equal(bubbleMs(HIRA.repeat(100), 1), 6_000);
  // In replay at k× divided by k, never below 1.0 s.
  assert.ok(close(bubbleMs('a'.repeat(40), 2), 1_250));
  assert.equal(bubbleMs('a'.repeat(400), 4), 1_500);
  assert.equal(bubbleMs('a'.repeat(400), 8), 1_000);
  assert.equal(bubbleMs('ok', 8), 1_000);
  assert.equal(bubbleMs('ok', 0.5), 3_000);

  // 2 lines × 42 Latin or 16 full-width characters, then an ellipsis.
  assert.deepEqual(wrapBubble('short note'), ['short note']);
  assert.deepEqual(wrapBubble('a'.repeat(42)), ['a'.repeat(42)]);
  assert.deepEqual(wrapBubble('a'.repeat(84)), ['a'.repeat(42), 'a'.repeat(42)]);
  assert.deepEqual(wrapBubble('a'.repeat(85)), ['a'.repeat(42), `${'a'.repeat(41)}\u{2026}`]);
  assert.deepEqual(wrapBubble(HAN.repeat(16)), [HAN.repeat(16)]);
  assert.deepEqual(wrapBubble(HAN.repeat(32)), [HAN.repeat(16), HAN.repeat(16)]);
  assert.deepEqual(wrapBubble(HAN.repeat(40)), [HAN.repeat(16), `${HAN.repeat(15)}\u{2026}`]);
  assert.deepEqual(wrapBubble(HANGUL.repeat(17)), [HANGUL.repeat(16), HANGUL]);
  // Latin text breaks at the last space that fits; no line starts or ends with a space.
  const words = 'the quick brown fox jumps over the lazy dog and keeps running far away from here today and tomorrow';
  const w = wrapBubble(words);
  assert.equal(w.length, 2);
  assert.equal(w[0], 'the quick brown fox jumps over the lazy');
  assert.ok(w[1]!.endsWith('\u{2026}'));
  for (const line of w) {
    assert.ok(width(line) <= 42, line);
    assert.equal(line, line.trim());
  }
  // Mixed widths never exceed a line.
  for (const t of [`${'ab'.repeat(10)}${HAN.repeat(20)}`, `${HANGUL}a`.repeat(30), `${HAN} `.repeat(30)]) {
    const lines = wrapBubble(t);
    assert.ok(lines.length <= 2);
    for (const line of lines) assert.ok(width(line) <= 42 + 1e-9, `${line} ${width(line)}`);
  }
  // A grapheme is never split.
  for (const line of wrapBubble('e\u{301}'.repeat(60))) assert.ok(!line.startsWith('\u{301}'));
  assert.deepEqual(wrapBubble(''), []);

  // One bubble per actor: a newer one replaces it.
  const set = new BubbleSet();
  set.show('a1a1a1', 'r1', 'first', 0, 1);
  set.show('a1a1a1', 'r1', 'second', 100, 1);
  assert.deepEqual(set.active(200).map((b) => [b.actor, b.lines]), [['a1a1a1', ['second']]]);
  assert.equal(set.active(200)[0]!.untilMs, 100 + 1_500);
  // Expired bubbles are gone.
  assert.deepEqual(set.active(1_600), []);
  // Three per room: the fourth makes the oldest fade early (gone at once); another room is not counted.
  const r = new BubbleSet();
  r.show('a', 'r1', 'one', 0, 1);
  r.show('b', 'r1', 'two', 10, 1);
  r.show('c', 'r1', 'three', 20, 1);
  r.show('x', 'r2', 'other room', 25, 1);
  assert.equal(r.active(30).length, 4);
  r.show('d', 'r1', 'four', 30, 1);
  assert.deepEqual(r.active(30).map((b) => b.actor).sort(), ['b', 'c', 'd', 'x']);
  // The same actor in two rooms keeps one bubble in each.
  r.show('b', 'r2', 'b elsewhere', 40, 1);
  assert.deepEqual(r.active(40).filter((b) => b.actor === 'b').map((b) => b.lines[0]).sort(), ['b elsewhere', 'two']);
  // At 8× the duration is 1.0 s; the lines are the wrapped text.
  const fast = new BubbleSet();
  fast.show('a', 'r1', 'a'.repeat(100), 0, 8);
  const [only] = fast.active(0);
  assert.equal(only!.untilMs, 1_000);
  assert.deepEqual(only!.lines, wrapBubble('a'.repeat(100)));
});
