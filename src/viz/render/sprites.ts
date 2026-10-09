// The art of 12 §3.6–§3.7 as string maps embedded in the bundle (VIZ-20: no image file, no font, no third-party art; VIZ-19:
// every icon is a sprite, never an emoji or a font glyph). The 16×16 base map and the beanie, headphones, sunglasses and scarf
// overlays are the brainstorm's option A verbatim (docs/design/viz-mockups/character-style.html, chosen by the user); the
// other four overlays, the pet and the seat variants are 12 §3.6's own designs; the digits, icons and tiles are drawn here.
// A map is rows of equal length; '.' is transparent and every other character is a palette key that raster.ts colours:
//   characters, accessories, pets, seat variants: o outline  b body  h highlight  c cheek  w eye white  k pupil  f foot (= o)
//                                                 a A accessory tones  l lens
//   digits: w;  icons: o (pupil tone), w (eye white), l (lens), a A (the icon's own tones, palette.ts ICON_TONES)
//   tiles:  a A floor tones  o wall  b h desk tones  k monitor  l screen
// Pure and import-free: part of the page's client program (R-V35).

export type SpriteMap = readonly string[];

const freeze = (rows: readonly string[]): SpriteMap => Object.freeze([...rows]);
const rep = (s: string, n: number): string[] => Array.from({ length: n }, () => s);

/** 16×16, option A verbatim. Rows 6–7 hold the eyes (w k), row 9 the mouth, rows 13–14 the feet. */
export const BASE: SpriteMap = freeze([
  '................',
  '.....oooooo.....',
  '...oobbbbbboo...',
  '..obbhhbbbbbbo..',
  '..obhhbbbbbbbo..',
  '.obbbbbbbbbbbbo.',
  '.obbwkbbbbwkbbo.',
  '.obbwkbbbbwkbbo.',
  '.obcbbbbbbbbcbo.',
  '.obbbbbkkbbbbbo.',
  '..obbbbbbbbbbo..',
  '..obbbbbbbbbbo..',
  '...oobbbbbboo...',
  '....ofo..ofo....',
  '....ooo..ooo....',
  '................',
]);

export type AccessoryName = 'beanie' | 'headphones' | 'sunglasses' | 'scarf' | 'sprout' | 'cap' | 'bow' | 'glasses';
const overlay = (rows: Record<number, string>): ReadonlyMap<number, string> =>
  new Map(Object.entries(rows).map(([k, v]) => [Number(k), v] as const));
/** Row index of the base map → a 16-character overlay drawn over it, in look-accessory order (palette.ts ACCESSORY_NAMES). */
export const ACCESSORIES: Readonly<Record<AccessoryName, ReadonlyMap<number, string>>> = Object.freeze({
  beanie: overlay({ 0: '......aaaa......', 1: '....aaaaaaaa....', 2: '...AAAAAAAAAA...' }),
  headphones: overlay({ 1: '.....AAAAAA.....', 5: 'aa............aa', 6: 'aA............Aa', 7: 'aA............Aa', 8: 'aa............aa' }),
  sunglasses: overlay({ 6: '...AllAAAAllA...', 7: '....ll....ll....' }),
  scarf: overlay({ 10: '..aaaaaaaaaaaa..', 11: '..........aa....', 12: '..........aA....' }),
  sprout: overlay({ 0: '......aaAaa.....' }),
  cap: overlay({ 1: '.....AAAAAA.....', 2: '...aaaaaaaaaa...', 3: '..........aaaaa.' }),
  bow: overlay({ 1: '..aAa...........', 2: '...a............' }),
  glasses: overlay({ 5: '...AAAA..AAAA...', 6: '...A..AAAA..A...', 7: '...A..A..A..A...', 8: '...AAAA..AAAA...' }),
});

/** 8×8 (12 §3.6): body = its owner's highlight, outline = its owner's outline, no accessory. */
export const PET: SpriteMap = freeze(['..oooo..', '.obhhbo.', 'obhbbbbo', 'obkbbkbo', 'obcbbcbo', 'obbbbbbo', '.oobboo.', '..o..o..']);

/** Drawn above the pet's row 0, in its owner's accessory tones: 0 none, 1 sprout, 2 antenna, 3 star; 4 and above a DIGITS number. */
export const SEAT_VARIANTS: ReadonlyArray<SpriteMap | null> = Object.freeze([null, freeze(['aa']), freeze(['A']), freeze(['.a.', 'aAa', '.a.'])]);

/** 3×5, 0–9. */
export const DIGITS: readonly SpriteMap[] = Object.freeze([
  ['www', 'w.w', 'w.w', 'w.w', 'www'], ['.w.', 'ww.', '.w.', '.w.', 'www'], ['www', '..w', 'www', 'w..', 'www'], ['www', '..w', '.ww', '..w', 'www'],
  ['w.w', 'w.w', 'www', '..w', '..w'], ['www', 'w..', 'www', '..w', 'www'], ['www', 'w..', 'www', 'w.w', 'www'], ['www', '..w', '.w.', '.w.', '.w.'],
  ['www', 'w.w', 'www', 'w.w', 'www'], ['www', 'w.w', 'www', '..w', 'www'],
].map(freeze));

export type IconName = 'queued' | 'asked' | 'awaiting_human' | 'undeliverable' | 'accepted' | 'declined' | 'later' | 'daemon' | 'wake'
  | 'flag' | 'tick' | 'star' | 'snowflake' | 'door' | 'speech' | 'bang' | 'snail' | 'ice' | 'paused' | 'zzz' | 'parcel' | 'cart' | 'lockbox'
  | 'bin' | 'lock' | 'keyboard' | 'clipboard' | 'bolt' | 'version' | 'rules' | 'credit' | 'health' | 'plane' | 'sparkle' | 'confetti'
  | 'stamp' | 'sign' | 'cabinet' | 'more' | 'caught_up' | 'you' | 'think';
/** 8×8 (clipboard and bolt 3×3, the pet's permission-mode badges); palette keys only, never a font glyph or emoji (VIZ-19). */
export const ICONS: Readonly<Record<IconName, SpriteMap>> = Object.freeze({
  queued: freeze(['AAAAAAAA', '.waaaaw.', '..waaw..', '...ww...', '...ww...', '..w..w..', '.waaaaw.', 'AAAAAAAA']),            // hourglass
  asked: freeze(['..wwww..', '.ww..ww.', '.....ww.', '....ww..', '...ww...', '...ww...', '........', '...ww...']),             // question mark
  awaiting_human: freeze(['.a.a.a..', '.a.a.a.a', '.a.a.a.a', '.aaaaaaa', '.aaaaaa.', '..aaaaa.', '..aaaa..', '..aaaa..']),     // raised hand
  undeliverable: freeze(['........', '.aaaaa..', 'aoooooa.', 'aaaaaaaA', 'aaaaaaaA', 'aaaaaaa.', '...a....', '...a....']),      // empty mailbox
  accepted: freeze(['....a...', '...aa...', '...aa...', 'AAaaaaa.', 'AAaaaaaa', 'AAaaaaa.', 'AAaaaaa.', 'AA.aaa..']),          // thumbs up
  declined: freeze(['aa....aa', 'aaa..aaa', '.aaaaaa.', '..aaaa..', '..aaaa..', '.aaaaaa.', 'aaa..aaa', 'aa....aa']),          // cross
  later: freeze(['..AAAA..', '.AwwwwA.', 'AwwwowwA', 'AwwwowwA', 'AwwwoowA', 'AwwwwwwA', '.AwwwwA.', '..AAAA..']),             // clock
  daemon: freeze(['...aa...', '.a.aa.a.', '..aaaa..', 'aaaooaaa', 'aaaooaaa', '..aaaa..', '.a.aa.a.', '...aa...']),            // gear
  wake: freeze(['aa....aa', 'a.aaaa.a', '.awwwwa.', 'awwowwwa', 'awwooowa', 'awwwwwwa', '.aaaaaa.', '.a....a.']),              // alarm clock
  flag: freeze(['Aawaw...', 'Awawaw..', 'Aawawa..', 'Awawa...', 'A.......', 'A.......', 'A.......', 'AA......']),              // "done" flag
  tick: freeze(['........', '.......a', '......aa', 'a....aa.', 'aa..aa..', '.aaaa...', '..aa....', '........']),
  star: freeze(['...aa...', '...aa...', 'aaaaaaaa', '.aaaaaa.', '..aaaa..', '.aaaaaa.', '.aa..aa.', 'a......a']),
  snowflake: freeze(['...a....', '.a.a.a..', '..aaa...', 'aaaaaaa.', '..aaa...', '.a.a.a..', '...a....', '........']),
  door: freeze(['.aaaaaa.', '.aoaaoa.', '.aoaaoa.', '.aaaaaa.', '.aaaaAa.', '.aoaaoa.', '.aoaaoa.', '.aaaaaa.']),
  speech: freeze(['.wwwwww.', 'wwwwwwww', 'wwwwwwww', 'wwwwwwww', '.wwwwww.', '..ww....', '.w......', '........']),
  bang: freeze(['...aa...', '...aa...', '...aa...', '...aa...', '...aA...', '........', '...aa...', '...aa...']),             // "!"
  snail: freeze(['........', 'A.A.....', 'A.A.aaa.', '.AAaAAaa', '.AAaaAaa', '.AAAaaaa', '.AAAAAAA', '........']),
  ice: freeze(['llllllll', 'lwwaaaal', 'lwaaaaal', 'laaaaaal', 'laaaaaal', 'laaaaawl', 'laaaawwl', 'llllllll']),                // ice block
  paused: freeze(['aaaaaaaa', 'aaoaaoaa', 'aaoaaoaa', 'aaoaaoaa', 'aaaaaaaa', '...AA...', '...AA...', '...AA...']),            // "paused" sign
  zzz: freeze(['....wwww', '......w.', '.....w..', '....wwww', 'www.....', '..w.....', '.w......', 'www.....']),
  parcel: freeze(['........', 'aaaAaaaa', 'aaaAaaaa', 'AAAAAAAA', 'aaaAaaaa', 'aaaAaaaa', 'aaaAaaaa', '........']),
  cart: freeze(['a.......', '.a......', '.aaaaaaa', '.aaaaaaa', '.aaaaaa.', '.a......', '.aaaaaa.', '..A..A..']),              // delivery cart
  lockbox: freeze(['........', '.aaaaaa.', 'aaaaaaaa', 'aaaAAaaa', 'aaaAAaaa', 'aaaaaaaa', '.aaaaaa.', '........']),
  bin: freeze(['...aa...', 'aaaaaaaa', '.aaaaaa.', '.a.aa.a.', '.a.aa.a.', '.a.aa.a.', '.aaaaaa.', '........']),
  lock: freeze(['..AAAA..', '.A....A.', '.A....A.', 'aaaaaaaa', 'aaaooaaa', 'aaaooaaa', 'aaaaaaaa', '........']),
  keyboard: freeze(['........', '........', 'AAAAAAAA', 'AaAaAaAA', 'AAaAaAaA', 'AaaaaaaA', 'AAAAAAAA', '........']),
  clipboard: freeze(['aAa', 'awa', 'aaa']),
  bolt: freeze(['.aa', '.a.', 'aa.']),
  version: freeze(['.AAAAAA.', 'AAAAAAAA', 'AwAAAAwA', 'AwAAAAwA', 'AAwAAwAA', 'AAAwwAAA', 'AAAAAAAA', '.AAAAAA.']),            // "v" badge
  rules: freeze(['.AAAAAA.', 'AAAAAwAA', 'AwwwwwwA', 'AAAAwAAA', 'AwwwwwwA', 'AAwAAAAA', 'AAAAAAAA', '.AAAAAA.']),              // "≠" badge
  credit: freeze(['..aaaa..', '.aaaaaa.', 'aaaAAaaa', 'aaAaaaaa', 'aaAaaaaa', 'aaaAAaaa', '.aaaaaa.', '..aaaa..']),             // coin
  health: freeze(['...aa...', '...aa...', '..aooa..', '..aooa..', '.aaooaa.', '.aaaaaa.', 'aaaooaaa', 'aaaaaaaa']),             // warning
  plane: freeze(['.......w', '.....www', '...wwwAw', 'wwwwwAw.', '..AAAww.', '...Aww..', '...Aw...', '...A....']),            // paper plane
  sparkle: freeze(['...A....', '...A....', '..AwA...', 'AAwwwAA.', '..AwA...', '...A....', '...A....', '........']),
  confetti: freeze(['a...A..w', '..w...a.', '.A..a...', '....w.A.', 'a.A.....', '...w..a.', '.a...A..', 'w..a...A']),
  stamp: freeze(['..aaaa..', '.a....a.', 'a.a..a.a', 'a..aa..a', 'a..aa..a', 'a.a..a.a', '.a....a.', '..aaaa..']),
  sign: freeze(['AAAAAA..', 'AAAAAAA.', 'AAAAAAAA', 'AAAAAAA.', 'AAAAAA..', '...a....', '...a....', '...a....']),            // signpost
  cabinet: freeze(['.aaaaaa.', '.aaooaa.', '.aaaaaa.', '.oooooo.', '.aaaaaa.', '.aaooaa.', '.aaaaaa.', '.a....a.']),          // filing cabinet
  more: freeze(['.AAAAAA.', 'AAAwwAAA', 'AAAwwAAA', 'AwwwwwwA', 'AwwwwwwA', 'AAAwwAAA', 'AAAwwAAA', '.AAAAAA.']),             // "+" chip
  caught_up: freeze(['........', 'a...a...', 'aa..aa..', 'aaa.aaa.', 'aaa.aaa.', 'aa..aa..', 'a...a...', '........']),
  you: freeze(['..aaaa..', '..aaaa..', '..aaaa..', 'aaaaaaaa', '.aaaaaa.', '..aaaa..', '...aa...', '........']),             // arrow
  think: freeze(['........', '........', '........', 'ww.ww.ww', 'ww.ww.ww', '........', '........', '........']),         // "…"
});

/** One tile is 16 art pixels (layout.ts TILE_PX); the desk spans its two tiles, the monitor overhangs its top edge. */
export const TILES: Readonly<{ floorA: SpriteMap; floorB: SpriteMap; wall: SpriteMap; door: SpriteMap; desk: SpriteMap; monitor: SpriteMap;
                               chair: SpriteMap; bigTable: SpriteMap; signPlate: SpriteMap; plaque: SpriteMap; shelf: SpriteMap }> = Object.freeze({
  floorA: freeze(rep('aaaaaaaaaaaaaaaa', 16)),
  floorB: freeze(rep('AAAAAAAAAAAAAAAA', 16)),
  wall: freeze([...rep('oooooooooooooooo', 12), ...rep('kkkkkkkkkkkkkkkk', 2), ...rep('bbbbbbbbbbbbbbbb', 2)]),
  door: freeze([
    'oooooooooooooooo', ...rep('oohhhhhhhhhhhhoo', 1), ...rep('oohbbbbbbbbbbhoo', 6), 'oohbbbbbbbbhbhoo', ...rep('oohbbbbbbbbbbhoo', 5),
    ...rep('oohhhhhhhhhhhhoo', 2),
  ]),
  desk: freeze([...rep('h'.repeat(32), 4), ...rep('b'.repeat(32), 8), ...rep(`.bb${'.'.repeat(26)}bb.`, 4)]),
  monitor: freeze(['kkkkkkkkkkkk', ...rep('kllllllllllk', 5), 'kkkkkkkkkkkk', '.....kk.....', '....kkkk....']),
  chair: freeze([
    ...rep('................', 3), '....oooooooo....', ...rep('....ohhhhhho....', 3), '...oooooooooo...', '...ohhhhhhhho...', '...oooooooooo...',
    ...rep('....o......o....', 2), ...rep('................', 4),
  ]),
  bigTable: freeze([`.${'h'.repeat(62)}.`, ...rep(`b${'h'.repeat(62)}b`, 21), ...rep('b'.repeat(64), 6), ...rep(`.bb${'.'.repeat(58)}bb.`, 4)]),
  // The zone sign's plate keeps clear of its row's bottom five pixels, where the monitors of the slot-0/1 desks overhang.
  signPlate: freeze([...rep('................', 2), 'hhhhhhhhhhhhhhhh', ...rep('kkkkkkkkkkkkkkkk', 7), 'hhhhhhhhhhhhhhhh', ...rep('................', 5)]),
  plaque: freeze(['h'.repeat(20), ...rep(`h${'k'.repeat(18)}h`, 4), 'h'.repeat(20)]),
  shelf: freeze([
    'b'.repeat(32), ...rep('blhkhlhkhlhkhlhkhlhkhlhkhlhkhlhb', 6), 'b'.repeat(32), ...rep('bhklhhklhhklhhklhhklhhklhhklhhkb', 6), 'b'.repeat(32),
    `.b${'.'.repeat(28)}b.`,
  ]),
});

export type FrameName = 'idle0' | 'idle1' | 'squash' | 'rise' | 'peak' | 'land' | 'eyesClosed';

/** The row an overlay drawn for base row `row` lands on in frame f: squash moves rows 0–2 down one and drops row 3; null = dropped. */
export function frameRow(f: FrameName, row: number): number | null {
  if (f !== 'squash' || row > 3) return row;
  return row === 3 ? null : row + 1;
}

const SQUASH: SpriteMap = freeze(BASE.reduce<string[]>((rows, r, i) => {
  const to = frameRow('squash', i);
  if (to !== null) rows[to] = r;
  return rows;
}, ['................']));
const EYES_CLOSED: SpriteMap = freeze(BASE.map((r, i) => (i === 6 ? r.replace(/[wk]/g, 'b') : i === 7 ? r.replace(/[wk]/g, 'o') : r)));
const FRAMES: Readonly<Record<FrameName, { map: SpriteMap; dy: number }>> = Object.freeze({
  idle0: Object.freeze({ map: BASE, dy: 0 }),
  idle1: Object.freeze({ map: BASE, dy: -1 }),             // the idle bob's second frame: one art pixel up
  squash: Object.freeze({ map: SQUASH, dy: 0 }),           // the walk (hop): squash, rise, peak, land at dy 0, −2, −3, −1
  rise: Object.freeze({ map: BASE, dy: -2 }),
  peak: Object.freeze({ map: BASE, dy: -3 }),
  land: Object.freeze({ map: BASE, dy: -1 }),
  eyesClosed: Object.freeze({ map: EYES_CLOSED, dy: 0 }),  // zzz (presumed absent)
});

/**
 * 12 §3.7's edits of the base map: squash drops row 3 and moves rows 0–2 down one; eyes closed turns the w/k of row 6 into b
 * and those of row 7 into o; the walk frames squash, rise, peak and land are vertical offsets 0, −2, −3 and −1 art pixels;
 * idle1 (the bob) is the base one pixel up. dy is added to the sprite's y (negative = up).
 */
export function frameOf(f: FrameName): { map: SpriteMap; dy: number } {
  return FRAMES[f];
}

/** A horizontal flip (facing left); the blob's silhouette is symmetric, so only the eyes, highlight and accessories turn. */
export function flipX(m: SpriteMap): SpriteMap {
  return m.map((r) => [...r].reverse().join(''));
}
