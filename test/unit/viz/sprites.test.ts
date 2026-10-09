// Plan 8a Task 12: the string sprite maps of 12 §3.6–§3.7 (VIZ-19, VIZ-20). The base map and the first four accessory
// overlays are the user-approved option A of docs/design/viz-mockups/character-style.html, read from that file here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import {
  ACCESSORIES, BASE, DIGITS, ICONS, PET, SEAT_VARIANTS, TILES, flipX, frameOf, frameRow, type AccessoryName, type FrameName, type IconName, type SpriteMap,
} from '../../../src/viz/render/sprites.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The option-A maps of the brainstorm page: `var A = [...]` and `var ACC = {...}` evaluated in an empty context. */
function optionA(): { base: string[]; acc: Record<string, string[] | Record<string, string>> } {
  const html = readFileSync(path.join(ROOT, 'docs', 'design', 'viz-mockups', 'character-style.html'), 'utf8');
  const a = /var A = (\[[\s\S]*?\]);/.exec(html);
  const acc = /var ACC = (\{[\s\S]*?\n {2}\});/.exec(html);
  assert.ok(a !== null && acc !== null, 'the mockup still declares var A and var ACC');
  // A JSON round trip moves the values into this realm (deepStrictEqual compares prototypes).
  const local = (src: string): unknown => JSON.parse(JSON.stringify(runInNewContext(`(${src})`)));
  return { base: local(a[1]!) as string[], acc: local(acc[1]!) as Record<string, string[] | Record<string, string>> };
}
/** An overlay as row index → row, from the mockup's array (rows 0…) or object form. */
function overlay(o: string[] | Record<string, string>): Map<number, string> {
  return new Map(Object.entries(o).map(([k, v]) => [Number(k), v]));
}

function dims(m: SpriteMap): { w: number; h: number } {
  const w = m[0]?.length ?? 0;
  for (const r of m) assert.equal(r.length, w, `ragged map row ${JSON.stringify(r)}`);
  return { w, h: m.length };
}
function assertMap(m: SpriteMap, w: number, h: number, keys: string, what: string): void {
  assert.deepEqual(dims(m), { w, h }, `${what}: size`);
  const allowed = new Set(['.', ...keys]);
  for (const r of m) for (const ch of r) assert.ok(allowed.has(ch), `${what}: key ${JSON.stringify(ch)} outside ${keys}`);
  assert.ok(m.some((r) => /[^.]/.test(r)), `${what}: an empty map`);
}

const ICON_NAMES: readonly IconName[] = [
  'queued', 'asked', 'awaiting_human', 'undeliverable', 'accepted', 'declined', 'later', 'daemon', 'wake', 'flag', 'tick', 'star', 'snowflake',
  'door', 'speech', 'bang', 'snail', 'ice', 'paused', 'zzz', 'parcel', 'cart', 'lockbox', 'bin', 'lock', 'keyboard', 'clipboard', 'bolt',
  'version', 'rules', 'credit', 'health', 'plane', 'sparkle', 'confetti', 'stamp', 'sign', 'cabinet', 'more', 'caught_up', 'you', 'think',
];

test('sprite maps: the base map and the beanie, headphones, sunglasses and scarf overlays equal option A; every map has its size and only its keys; every icon is an 8\u{d7}8 (or 3\u{d7}3) map', () => {
  const a = optionA();
  assert.deepEqual([...BASE], a.base);
  assert.deepEqual(ACCESSORIES.beanie, overlay(a.acc['beanie']!));
  assert.deepEqual(ACCESSORIES.headphones, overlay(a.acc['phones']!));
  assert.deepEqual(ACCESSORIES.sunglasses, overlay(a.acc['shades']!));
  assert.deepEqual(ACCESSORIES.scarf, overlay(a.acc['scarf']!));
  // The other four overlays, the pet and the seat variants as 12 \u{a7}3.6 draws them.
  assert.deepEqual(ACCESSORIES.sprout, new Map([[0, '......aaAaa.....']]));
  assert.deepEqual(ACCESSORIES.cap, new Map([[1, '.....AAAAAA.....'], [2, '...aaaaaaaaaa...'], [3, '..........aaaaa.']]));
  assert.deepEqual(ACCESSORIES.bow, new Map([[1, '..aAa...........'], [2, '...a............']]));
  assert.deepEqual(ACCESSORIES.glasses, new Map([[5, '...AAAA..AAAA...'], [6, '...A..AAAA..A...'], [7, '...A..A..A..A...'], [8, '...AAAA..AAAA...']]));
  assert.deepEqual([...PET], ['..oooo..', '.obhhbo.', 'obhbbbbo', 'obkbbkbo', 'obcbbcbo', 'obbbbbbo', '.oobboo.', '..o..o..']);
  assert.deepEqual(SEAT_VARIANTS.map((v) => (v === null ? null : [...v])), [null, ['aa'], ['A'], ['.a.', 'aAa', '.a.']]);

  assertMap(BASE, 16, 16, 'obhcwkf', 'BASE');
  const names: AccessoryName[] = ['beanie', 'headphones', 'sunglasses', 'scarf', 'sprout', 'cap', 'bow', 'glasses'];
  assert.deepEqual(Object.keys(ACCESSORIES).sort(), [...names].sort());
  for (const n of names) {
    assert.ok(ACCESSORIES[n].size > 0, n);
    for (const [row, s] of ACCESSORIES[n]) {
      assert.ok(Number.isInteger(row) && row >= 0 && row < 16, `${n}: row ${row}`);
      assertMap([s], 16, 1, n === 'sunglasses' ? 'aAl' : 'aA', `${n} row ${row}`);
    }
  }
  assertMap(PET, 8, 8, 'obhck', 'PET');
  for (const [i, v] of SEAT_VARIANTS.entries()) {
    if (v === null) continue;
    const { w, h } = dims(v);
    assert.ok(w >= 1 && w <= 3 && h >= 1 && h <= 3, `variant ${i}`);
    assertMap(v, w, h, 'aA', `variant ${i}`);
  }
  assert.equal(DIGITS.length, 10);
  for (const [i, d] of DIGITS.entries()) assertMap(d, 3, 5, 'w', `digit ${i}`);
  assert.equal(new Set(DIGITS.map((d) => d.join('/'))).size, 10, 'ten different digits');

  assert.deepEqual(Object.keys(ICONS).sort(), [...ICON_NAMES].sort());
  for (const n of ICON_NAMES) {
    const size = n === 'clipboard' || n === 'bolt' ? 3 : 8;
    assertMap(ICONS[n], size, size, 'owlaA', `icon ${n}`);
    // Pixels only: every character is one of the ASCII map keys, so no icon is a font glyph or emoji.
    for (const r of ICONS[n]) assert.match(r, /^[.owlaA]+$/, `icon ${n}`);
  }
  assert.equal(new Set(ICON_NAMES.map((n) => ICONS[n].join('/'))).size, ICON_NAMES.length, 'every icon is its own shape');

  const tileSizes: Record<keyof typeof TILES, [number, number]> = {
    floorA: [16, 16], floorB: [16, 16], wall: [16, 16], door: [16, 16], desk: [32, 16], monitor: [12, 9], chair: [16, 16], bigTable: [64, 32],
    signPlate: [16, 16], plaque: [20, 6], shelf: [32, 16],
  };
  assert.deepEqual(Object.keys(TILES).sort(), Object.keys(tileSizes).sort());
  for (const [n, [w, h]] of Object.entries(tileSizes)) assertMap(TILES[n as keyof typeof TILES], w, h, 'obhklaA', `tile ${n}`);
  assert.ok(TILES.monitor.some((r) => r.includes('l')), 'the monitor has screen pixels');
});

test('frame edits: squash, eyes closed, walk offsets 0, \u{2212}2, \u{2212}3, \u{2212}1, and a horizontal flip that keeps the symmetric blob', () => {
  assert.deepEqual(frameOf('idle0'), { map: BASE, dy: 0 });
  assert.deepEqual(frameOf('idle1'), { map: BASE, dy: -1 });                        // the bob: one art pixel up
  // squash drops row 3 and moves rows 0\u{2013}2 down one.
  const squash = frameOf('squash');
  assert.deepEqual([...squash.map], ['................', BASE[0], BASE[1], BASE[2], ...BASE.slice(4)]);
  assert.equal(squash.map.length, 16);
  // Accessory overlay rows follow the same edit (a beanie squashes with the head; the cap's brim row 3 drops).
  assert.deepEqual([0, 1, 2, 3, 4, 15].map((r) => frameRow('squash', r)), [1, 2, 3, null, 4, 15]);
  for (const f of ['idle0', 'idle1', 'rise', 'peak', 'land', 'eyesClosed'] as const) assert.deepEqual([0, 3, 15].map((r) => frameRow(f, r)), [0, 3, 15]);
  // eyes closed: row 6's w/k become b, row 7's become o (a closed-eye line); nothing else changes.
  const closed = frameOf('eyesClosed');
  assert.equal(closed.dy, 0);
  closed.map.forEach((r, i) => {
    if (i === 6) assert.equal(r, BASE[6]!.replace(/[wk]/g, 'b'));
    else if (i === 7) assert.equal(r, BASE[7]!.replace(/[wk]/g, 'o'));
    else assert.equal(r, BASE[i]);
  });
  assert.ok(!/[wk]/.test(closed.map[6]! + closed.map[7]!));
  // The walk (hop): squash, rise, peak, land at 0, −2, −3, −1 art pixels.
  const walk: FrameName[] = ['squash', 'rise', 'peak', 'land'];
  assert.deepEqual(walk.map((f) => frameOf(f).dy), [0, -2, -3, -1]);
  for (const f of ['rise', 'peak', 'land'] as const) assert.deepEqual(frameOf(f).map, BASE);
  // Facing left is a horizontal flip: the blob's silhouette and outline are mirror-symmetric, the eyes look the other way.
  const mask = (m: SpriteMap, re: RegExp): string[] => m.map((r) => [...r].map((ch) => (re.test(ch) ? '#' : '.')).join(''));
  const flipped = flipX(BASE);
  assert.deepEqual(mask(flipped, /[^.]/), mask(BASE, /[^.]/));
  assert.deepEqual(mask(flipped, /[of]/), mask(BASE, /[of]/));
  assert.deepEqual(flipX(flipped), BASE);
  assert.deepEqual(flipX(PET), [...PET].map((r) => [...r].reverse().join('')));
  for (const row of [6, 7]) {
    assert.deepEqual([...BASE[row]!].flatMap((ch, x) => (ch === 'k' ? [x] : [])), [5, 11]);
    assert.deepEqual([...flipped[row]!].flatMap((ch, x) => (ch === 'k' ? [x] : [])), [4, 10]);
  }
});
