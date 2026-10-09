// Plan 8a Task 4: the office layout of 12 §3.5.2–§3.5.3 — zones, append-only desk allocation, overflow and shelves, tile
// coordinates, blocked tiles, the page's delta form and R-V51's dashed desks (VIZ-16, VIZ-37 keys).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Position } from '../../../src/viz/model/events.js';
import {
  applyLayoutDelta,
  BIG_TABLE,
  BIG_TABLE_KEY,
  CELL_H,
  CELL_W,
  CELLS_PER_ZONE,
  cellOrigin,
  deskTiles,
  DOOR,
  emptyLayout,
  FILE_DESKS_PER_ZONE,
  GRID_COLS,
  HOME_SPOTS,
  homeTile,
  isBlocked,
  isDashed,
  LayoutBuilder,
  LayoutFrozenError,
  LOBBY_H,
  OFFICE_W,
  officeTiles,
  OVERFLOW_ZONE,
  plaqueOf,
  ROOT_ZONE,
  SLOTS_PER_CELL,
  slotOrigin,
  TILE_PX,
  VISITOR_TILES,
  ZONES_MAX,
  zoneOf,
  type Desk,
  type Layout,
  type LayoutDelta,
  type Tile,
} from '../../../src/viz/model/layout.js';

const ELLIPSIS = '\u{2026}';
const MIDDLE_DOT = '\u{00B7}';
const HOUSE = '\u{2302}';
const t = (x: number, y: number): Tile => ({ x, y });
const pad = (n: number): string => String(n).padStart(2, '0');

/** Builds a layout from [path, height] touches, in order. */
function build(touches: ReadonlyArray<readonly [string, number]>, base: Layout = emptyLayout()): { b: LayoutBuilder; layout: Layout } {
  const b = new LayoutBuilder(base);
  for (const [p, h] of touches) b.desk(p, h);
  return { b, layout: b.layout() };
}

function deskByKey(l: Layout, key: string): Desk {
  const found = l.desks.filter((d) => d.key === key);
  assert.equal(found.length, 1, `exactly one desk with key ${key}`);
  return found[0]!;
}

test('the layout constants and the empty layout of 12 §3.5', () => {
  assert.deepEqual(
    [TILE_PX, GRID_COLS, CELL_W, CELL_H, LOBBY_H, OFFICE_W, HOME_SPOTS, ZONES_MAX, CELLS_PER_ZONE, SLOTS_PER_CELL, FILE_DESKS_PER_ZONE, VISITOR_TILES],
    [16, 3, 7, 10, 4, 21, 16, 15, 4, 6, 23, 4],
  );
  assert.deepEqual([OVERFLOW_ZONE, ROOT_ZONE, BIG_TABLE_KEY, BIG_TABLE], [ELLIPSIS, MIDDLE_DOT, HOUSE, 0]);
  assert.deepEqual(DOOR, t(1, 0));
  const l = emptyLayout();
  assert.equal(l.version, 0);
  assert.deepEqual(l.zones, []);
  assert.deepEqual(l.homeOrder, []);
  assert.ok(l.deskOf instanceof Map);
  assert.equal(l.deskOf.size, 0);
  assert.deepEqual(l.desks, [{ ordinal: 0, key: HOUSE, kind: 'big_table', zone: null, cell: null, slot: null, path: null, lockbox: false, first: 0 }]);
});

test('zoneOf: s1/s2 for three or more segments, s1 for two, · for a root-level file', () => {
  assert.equal(zoneOf('src/engine/state.ts'), 'src/engine');
  assert.equal(zoneOf('src/engine/deep/er/x.ts'), 'src/engine');
  assert.equal(zoneOf('test/a.ts'), 'test');
  assert.equal(zoneOf('README.md'), MIDDLE_DOT);
  assert.equal(zoneOf(`${ELLIPSIS}/x.ts`), ELLIPSIS, 'a folder named like the overflow zone is still its own s1');
});

test('LayoutBuilder: one desk per path, the version counts desks, cells and home entries, takeDelta reports additions, freeze stops allocation', () => {
  const b = new LayoutBuilder(emptyLayout());
  assert.equal(b.takeDelta(), null, 'nothing added yet');
  const a = b.desk('src/a.ts', 3);
  assert.equal(a, 1);
  assert.equal(b.desk('src/a.ts', 9), 1, 'a second touch returns the same desk');
  assert.ok(b.has('src/a.ts'));
  assert.ok(!b.has('src/b.ts'));
  let l = b.layout();
  assert.equal(l.version, 2, 'one cell and one desk');
  assert.deepEqual(l.zones, [{ index: 0, key: 'src', cells: [0] }]);
  assert.deepEqual(l.desks[1], { ordinal: 1, key: 'src/a.ts', kind: 'file', zone: 0, cell: 0, slot: 0, path: 'src/a.ts', lockbox: false, first: 3 });
  assert.equal(l.deskOf.get('src/a.ts'), 1);
  b.home('ab'.repeat(16));
  const d1 = b.takeDelta();
  assert.deepEqual(d1, {
    fromVersion: 0, version: 3, zones: [{ index: 0, key: 'src', cells: [0] }], desks: [l.desks[1]], homeOrder: ['ab'.repeat(16)],
  }, 'one cell, one desk and one home entry (R-V57)');
  assert.equal(b.takeDelta(), null, 'a second take has nothing new');
  b.desk('src/b.ts', 10);
  const d2 = b.takeDelta();
  assert.equal(d2?.fromVersion, 3);
  assert.equal(d2?.version, 4);
  assert.deepEqual(d2?.zones, [], 'the zone did not grow a cell');
  assert.deepEqual(d2?.desks.map((d) => d.key), ['src/b.ts']);
  // A snapshot is detached: later allocation does not reach it.
  l = b.layout();
  b.desk('lib/c.ts', 11);
  assert.equal(l.desks.length, 3);
  assert.equal(l.deskOf.size, 2);
  assert.equal(l.zones.length, 1);
  // freeze: known paths still resolve, a new desk or home entry throws.
  b.freeze();
  assert.equal(b.desk('src/a.ts', 99), 1);
  b.home('ab'.repeat(16));
  assert.throws(() => b.desk('new/x.ts', 12), LayoutFrozenError);
  assert.throws(() => b.home('cd'.repeat(16)), LayoutFrozenError);
  // plaques: a file's basename, a folder desk's folder, nothing for the shelf and the big table.
  assert.equal(plaqueOf(b.layout().desks[1]!), 'a.ts');
  assert.equal(plaqueOf(b.layout().desks[0]!), null);
});

test('LayoutBuilder: a delta that adds only a home entry is one version step and applies after the previous delta (R-V57, R-V49)', () => {
  // The page's rule (R-V49): a delta whose version is ≤ the page's own was already applied and is a no-op.
  const pageApply = (l: Layout, d: LayoutDelta): Layout => (d.version <= l.version ? l : applyLayoutDelta(l, d));
  const peer = 'cd'.repeat(16);
  const b = new LayoutBuilder(emptyLayout());
  b.desk('src/a.ts', 1);
  const d1 = b.takeDelta()!;
  const page1 = pageApply(emptyLayout(), d1);
  b.home(peer);
  b.home(peer);                                                   // a repeat adds nothing
  const d2 = b.takeDelta()!;
  assert.deepEqual(d2, { fromVersion: d1.version, version: d1.version + 1, zones: [], desks: [], homeOrder: [peer] });
  const page2 = pageApply(page1, d2);
  assert.notEqual(page2, page1, 'not a no-op: the new teammate reaches the page');
  assert.equal(page2.version, page1.version + 1);
  assert.deepEqual(page2.homeOrder, [peer]);
  assert.deepEqual(page2, b.layout());
  assert.equal(pageApply(page2, d2), page2, 'the same delta again (stream and TimelinePage) is the no-op');
  b.home(peer);
  assert.equal(b.takeDelta(), null, 'a known peer is no delta');
});

test('T-VIZ-layout: the 16th zone goes to …, with one folder desk per overflow folder', () => {
  const touches: Array<[string, number]> = [];
  for (let i = 0; i < 14; i++) touches.push([`d${pad(i)}/f.ts`, i]);
  touches.push(['root.md', 14]);                                   // '·' is the 15th regular zone
  touches.push(['over1/a/x.ts', 20], ['over1/a/y.ts', 21], ['over2/b.ts', 22], ['d03/g.ts', 23]);
  const { b, layout: l } = build(touches);
  assert.equal(l.zones.length, 16);
  assert.deepEqual(l.zones[14], { index: 14, key: MIDDLE_DOT, cells: [14] });
  assert.deepEqual(l.zones[15], { index: 15, key: ELLIPSIS, cells: [15] });
  const f1 = deskByKey(l, 'over1/a/');
  assert.deepEqual(f1, { ordinal: 16, key: 'over1/a/', kind: 'folder', zone: 15, cell: 15, slot: 0, path: null, lockbox: false, first: 20 });
  assert.equal(l.deskOf.get('over1/a/x.ts'), 16);
  assert.equal(l.deskOf.get('over1/a/y.ts'), 16, 'every path of an overflow folder shares its folder desk');
  assert.deepEqual(deskByKey(l, 'over2/'), { ordinal: 17, key: 'over2/', kind: 'folder', zone: 15, cell: 15, slot: 1, path: null, lockbox: false, first: 22 });
  assert.deepEqual(deskByKey(l, 'd03/g.ts'), { ordinal: 18, key: 'd03/g.ts', kind: 'file', zone: 3, cell: 3, slot: 1, path: 'd03/g.ts', lockbox: false, first: 23 },
    'a zone that already has a cell keeps taking file desks');
  assert.equal(plaqueOf(f1), 'over1/a');
  assert.equal(l.version, 15 * 2 + 2 + 1 + 1);

  // The … zone's 24th folder goes to its shelf: 23 folder desks fill its four cells but the last slot.
  for (let i = 0; i < 21; i++) b.desk(`of${pad(i)}/q.ts`, 30 + i);
  let m = b.layout();
  const folders = m.desks.filter((d) => d.zone === 15);
  assert.equal(folders.length, 23);
  assert.ok(folders.every((d) => d.kind === 'folder'));
  assert.deepEqual(m.zones[15]!.cells, [15, 16, 17, 18], 'annex cells at the next free grid cells');
  const shelfRef = b.desk('of21/q.ts', 60);
  m = b.layout();
  assert.deepEqual(m.desks[shelfRef], {
    ordinal: shelfRef, key: `${ELLIPSIS}/${ELLIPSIS}`, kind: 'shelf', zone: 15, cell: 18, slot: 5, path: null, lockbox: false, first: 60,
  });
  assert.equal(b.desk('of21/r.ts', 61), shelfRef, 'the 24th folder maps wholly to the shelf');
  assert.equal(b.desk('of22/s.ts', 62), shelfRef, 'and so does every later folder');
  assert.equal(b.desk('over1/a/z.ts', 63), 16, 'an existing folder keeps its desk');
  assert.equal(plaqueOf(m.desks[shelfRef]!), null);
  assert.equal(b.layout().desks.length, shelfRef + 1, 'no desk beyond the shelf');
});

test('T-VIZ-layout: the 24th file of a zone goes to its shelf desk in the 24th slot; a zone grows annex cells up to 4', () => {
  const b = new LayoutBuilder(emptyLayout());
  for (let i = 0; i < 6; i++) b.desk(`src/engine/f${pad(i)}.ts`, 1);
  b.desk('lib/a.ts', 2);                                          // takes grid cell 1 between src/engine's cells
  for (let i = 6; i < 23; i++) b.desk(`src/engine/f${pad(i)}.ts`, 3);
  let l = b.layout();
  const zone = l.zones[0]!;
  assert.deepEqual(zone, { index: 0, key: 'src/engine', cells: [0, 2, 3, 4] });
  const files = l.desks.filter((d) => d.zone === 0);
  assert.equal(files.length, 23);
  files.forEach((d, i) => {
    assert.equal(d.kind, 'file');
    assert.equal(d.cell, zone.cells[Math.floor(i / 6)]);
    assert.equal(d.slot, i % 6);
  });
  const shelf = b.desk('src/engine/f23.ts', 4);
  l = b.layout();
  assert.deepEqual(l.desks[shelf], { ordinal: shelf, key: 'src/engine/\u{2026}', kind: 'shelf', zone: 0, cell: 4, slot: 5, path: null, lockbox: false, first: 4 });
  assert.equal(b.desk('src/engine/f24.ts', 5), shelf);
  assert.equal(b.desk('src/engine/sub/deeper.ts', 5), shelf, 'a deeper path of the zone also goes to the shelf');
  assert.deepEqual(b.layout().zones[0]!.cells, [0, 2, 3, 4], 'never a fifth cell');
  assert.equal(b.layout().zones.length, 2);
  assert.equal(l.version, 5 + 25, 'five cells (four src/engine, one lib), 25 desks (23 files, lib/a.ts, the shelf)');
});

test('T-VIZ-layout: isDashed keeps the head layout and dashes exactly the desks first touched after the position', () => {
  // Three segments: the window at hs 512, then two "load earlier" pages (hs 256, then hs 0) appended after every desk.
  const head = build([['a/1.ts', 520], ['a/2.ts', 520], ['b/3.ts', 600], ['c/4.ts', 700]]).layout;
  const mid = build([['d/5.ts', 300], ['a/1.ts', 310], ['d/6.ts', 400]], head).layout;
  const layout = build([['e/7.ts', 10], ['e/8.ts', 100], ['d/6.ts', 120]], mid).layout;
  const expectedFirst: Record<string, number> = {
    [HOUSE]: 0, 'a/1.ts': 520, 'a/2.ts': 520, 'b/3.ts': 600, 'c/4.ts': 700, 'd/5.ts': 300, 'd/6.ts': 400, 'e/7.ts': 10, 'e/8.ts': 100,
  };
  assert.deepEqual(layout.desks.map((d) => [d.key, d.first]), Object.entries(expectedFirst));
  const frozen = JSON.stringify([...layout.desks]);
  for (let h = 0; h <= 767; h++) {
    for (const at of [{ height: h, sub: 0, k: 0 }, { height: h, sub: 1_002, k: 9 }] satisfies Position[]) {
      const dashed = layout.desks.filter((d) => isDashed(d, at)).map((d) => d.key);
      const expected = Object.keys(expectedFirst).filter((k) => expectedFirst[k]! > h);
      assert.deepEqual(dashed, expected, `at height ${h}`);
    }
  }
  // Ordinals are not monotone in first: at 450 the window's desks are dashed and the earlier pages' are not.
  assert.deepEqual(layout.desks.filter((d) => isDashed(d, { height: 450, sub: 1, k: 0 })).map((d) => d.ordinal), [1, 2, 3, 4]);
  assert.deepEqual(layout.desks.filter((d) => isDashed(d, null)), [], 'live: nothing dashed');
  assert.equal(JSON.stringify([...layout.desks]), frozen, 'rewinding never changes the head layout');
});

test('T-VIZ-layout: coordinates follow 12 §3.5.2', () => {
  // Home spots: two rows of 8, two tiles apart; beyond 16 the door cluster, round-robin.
  for (let i = 0; i < 16; i++) assert.deepEqual(homeTile(i), t(2 + 2 * (i % 8), 1 + Math.floor(i / 8)), `spot ${i}`);
  assert.deepEqual([homeTile(0), homeTile(7), homeTile(8), homeTile(15)], [t(2, 1), t(16, 1), t(2, 2), t(16, 2)]);
  const cluster = [t(0, 1), t(0, 2), t(0, 3), t(1, 2), t(1, 3)];
  for (let i = 16; i < 31; i++) assert.deepEqual(homeTile(i), cluster[(i - 16) % 5], `spot ${i}`);
  // Grid cells: C = 3 columns of 7 tiles under the 4-tile lobby, 10 tiles tall.
  assert.deepEqual([0, 1, 2, 3, 5, 7].map(cellOrigin), [t(0, 4), t(7, 4), t(14, 4), t(0, 14), t(14, 14), t(7, 24)]);
  for (let g = 0; g < 12; g++) assert.deepEqual(cellOrigin(g), t(7 * (g % 3), 4 + 10 * Math.floor(g / 3)));
  // Slots: two columns of three, row-major, one row under the sign.
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((s) => slotOrigin(0, s)), [t(0, 5), t(3, 5), t(0, 8), t(3, 8), t(0, 11), t(3, 11)]);
  assert.deepEqual(slotOrigin(4, 3), t(10, 18));
  // A desk at cell 4, slot 3: desk (x, y) and (x + 1, y); chair (x, y + 1); visitors (x + 1, y + 1), (x + 2, y + 1), (x, y + 2), (x + 1, y + 2).
  const b = new LayoutBuilder(emptyLayout());
  for (let z = 0; z < 4; z++) b.desk(`z${z}/a.ts`, 1);           // cells 0–3
  for (let i = 0; i < 4; i++) b.desk(`z4/f${i}.ts`, 1);          // cell 4, slots 0–3
  const l = b.layout();
  const d = l.deskOf.get('z4/f3.ts')!;
  assert.deepEqual([l.desks[d]!.cell, l.desks[d]!.slot], [4, 3]);
  assert.deepEqual(deskTiles(l, d), {
    desk: [t(10, 18), t(11, 18)], chair: t(10, 19), visitors: [t(11, 19), t(12, 19), t(10, 20), t(11, 20)],
  });
  // The big table covers (17–20, 1–2), its chair (18, 3), its visitors (16, 3), (17, 3), (19, 3), (20, 3).
  const big = deskTiles(l, BIG_TABLE);
  assert.deepEqual(big.desk, [t(17, 1), t(18, 1), t(19, 1), t(20, 1), t(17, 2), t(18, 2), t(19, 2), t(20, 2)]);
  assert.deepEqual(big.chair, t(18, 3));
  assert.deepEqual(big.visitors, [t(16, 3), t(17, 3), t(19, 3), t(20, 3)]);
  assert.throws(() => deskTiles(l, l.desks.length), RangeError);
  // The office: 21 tiles wide, 4 + 10·⌈cells / 3⌉ tall.
  assert.deepEqual(officeTiles(emptyLayout()), { w: 21, h: 4 });
  assert.deepEqual(officeTiles(l), { w: 21, h: 4 + 10 * 2 });
  assert.deepEqual(officeTiles(build([['a/x.ts', 1]]).layout), { w: 21, h: 14 });
  assert.deepEqual(officeTiles(build([['a/x.ts', 1], ['b/x.ts', 1], ['c/x.ts', 1]]).layout), { w: 21, h: 14 });
  assert.deepEqual(officeTiles(build([['a/x.ts', 1], ['b/x.ts', 1], ['c/x.ts', 1], ['d/x.ts', 1]]).layout), { w: 21, h: 24 });
  assert.equal(OFFICE_W * TILE_PX, 336);
});

test('blocked tiles are exactly the lobby wall, desk tiles and big-table tiles', () => {
  // Zone a: 7 files (cell 0 full, annex cell 2 slot 0); zone b: 1 file (cell 1); four cells → an office 24 tiles tall.
  const touches: Array<[string, number]> = [];
  for (let i = 0; i < 6; i++) touches.push([`a/f${i}.ts`, 1]);
  touches.push(['b/x.ts', 2], ['a/f6.ts', 3], ['c/y.ts', 4]);
  const l = build(touches).layout;
  const { w, h } = officeTiles(l);
  assert.deepEqual({ w, h }, { w: 21, h: 24 });
  const deskTileSet = new Set<string>();
  for (const d of l.desks) {
    if (d.cell === null || d.slot === null) continue;
    const o = slotOrigin(d.cell, d.slot);
    deskTileSet.add(`${o.x},${o.y}`).add(`${o.x + 1},${o.y}`);
  }
  assert.equal(deskTileSet.size, 2 * 9);
  let blocked = 0;
  for (let y = -1; y <= h; y++) {
    for (let x = -1; x <= w; x++) {
      const outside = x < 0 || y < 0 || x >= w || y >= h;
      const wall = y === 0 && x !== 1;
      const bigTable = x >= 17 && x <= 20 && y >= 1 && y <= 2;
      const expected = outside || wall || bigTable || deskTileSet.has(`${x},${y}`);
      assert.equal(isBlocked(l, t(x, y)), expected, `tile (${x}, ${y})`);
      if (expected && !outside) blocked++;
    }
  }
  assert.equal(blocked, 20 + 8 + 18);
  // Signs, chairs, visitor tiles, home spots, the door and empty slots are floor.
  assert.ok(!isBlocked(l, DOOR));
  for (let i = 0; i < 16; i++) assert.ok(!isBlocked(l, homeTile(i)));
  for (const d of l.desks) {
    const tiles = deskTiles(l, d.ordinal);
    assert.ok(!isBlocked(l, tiles.chair));
    for (const v of tiles.visitors) assert.ok(!isBlocked(l, v));
  }
  assert.ok(!isBlocked(l, cellOrigin(0)), 'the sign row');
  assert.ok(!isBlocked(l, slotOrigin(1, 1)), 'an empty slot of zone b');
});

test('T-VIZ-text (layout): paths __proto__/a.ts, constructor/b.ts, prototype/c.ts and a root __proto__ lay out as ordinary desks and change no prototype', () => {
  const protoNames = Object.getOwnPropertyNames(Object.prototype).sort();
  const paths = ['__proto__/a.ts', 'constructor/b.ts', 'prototype/c.ts', '__proto__', 'hasOwnProperty/toString/d.ts', 'x/__proto__/e.ts'];
  const b = new LayoutBuilder(emptyLayout());
  paths.forEach((p, i) => b.desk(p, i + 1));
  const l = b.layout();
  assert.ok(l.deskOf instanceof Map);
  assert.deepEqual(l.zones.map((z) => z.key), ['__proto__', 'constructor', 'prototype', MIDDLE_DOT, 'hasOwnProperty/toString', 'x/__proto__']);
  paths.forEach((p, i) => {
    assert.equal(l.deskOf.get(p), i + 1);
    assert.deepEqual(l.desks[i + 1], { ordinal: i + 1, key: p, kind: 'file', zone: i, cell: i, slot: 0, path: p, lockbox: false, first: i + 1 });
  });
  assert.equal(zoneOf('__proto__'), MIDDLE_DOT);
  assert.equal(plaqueOf(l.desks[4]!), '__proto__');
  // The page's delta form takes the same keys.
  const d = b.takeDelta()!;
  const page = applyLayoutDelta(emptyLayout(), d);
  assert.equal(page.deskOf.get('__proto__/a.ts'), 1);
  assert.equal(page.deskOf.get('constructor/b.ts'), 2);
  // Nothing reached a prototype.
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), protoNames);
  const probe: Record<string, unknown> = {};
  assert.equal(probe['a.ts'], undefined);
  assert.equal(Object.getPrototypeOf(probe), Object.prototype);
  assert.equal(typeof probe.constructor, 'function');
  assert.equal(({} as Record<string, unknown>)['b.ts'], undefined);
});

test('T-VIZ-text (layout): a real folder named \u{2026} or \u{00B7}, a root file \u{2302} and files named \u{2026} never share a key with the overflow zone, the root zone, the big table or a shelf', () => {
  const E = ELLIPSIS;
  const keysUnique = (l: Layout): void => {
    assert.equal(new Set(l.desks.map((d) => d.key)).size, l.desks.length, 'desk keys are unique');
    assert.equal(new Set(l.zones.map((z) => z.key)).size, l.zones.length, 'zone keys are unique');
  };

  // A real folder '…' among the first zones counts as one of the 15 regular zones and never becomes the overflow zone.
  const b = new LayoutBuilder(emptyLayout());
  b.desk(`${E}/a.ts`, 1);                                         // zone 0: the real folder '…'
  b.desk(`${MIDDLE_DOT}/b.ts`, 2);                                // zone 1: a real folder '·', not the root zone
  b.desk('top.md', 3);                                            // zone 2: the root zone
  b.desk(HOUSE, 4);                                               // a root file named '⌂', in the root zone
  for (let i = 0; i < 12; i++) b.desk(`d${pad(i)}/f.ts`, 10 + i); // zones 3–14: 15 regular zones in all
  b.desk('over/x.ts', 30);                                        // the 16th zone → the overflow zone, index 15
  b.desk(`${E}/c.ts`, 31);                                        // the real '…' keeps its own zone
  b.desk(`over2/${E}/y.ts`, 32);                                  // an overflow folder whose name holds the glyph
  let l = b.layout();
  keysUnique(l);
  assert.equal(l.zones.length, 16);
  assert.deepEqual(l.zones.map((z) => z.key).slice(0, 3), [`:${E}`, `:${MIDDLE_DOT}`, MIDDLE_DOT], 'a reserved glyph segment is written with a ":" prefix');
  assert.deepEqual(l.zones.filter((z) => z.key === OVERFLOW_ZONE).map((z) => z.index), [15], 'exactly one overflow zone, the 16th');
  assert.deepEqual(l.desks.filter((d) => d.zone === 0).map((d) => [d.kind, d.key, d.path]), [['file', `:${E}/a.ts`, `${E}/a.ts`], ['file', `:${E}/c.ts`, `${E}/c.ts`]]);
  assert.deepEqual(l.desks.filter((d) => d.zone === 15).map((d) => [d.kind, d.key]), [['folder', 'over/'], ['folder', `over2/:${E}/`]]);
  const house = l.desks[l.deskOf.get(HOUSE)!]!;
  assert.deepEqual(house, { ordinal: 4, key: `:${HOUSE}`, kind: 'file', zone: 2, cell: 2, slot: 1, path: HOUSE, lockbox: false, first: 4 }, 'not the big table');
  assert.equal(l.deskOf.get(`${MIDDLE_DOT}/b.ts`), 2);
  assert.equal(l.desks[2]!.zone, 1);
  // Plaques and paths show the real names.
  assert.equal(plaqueOf(house), HOUSE);
  assert.equal(plaqueOf(l.desks[l.deskOf.get(`over2/${E}/y.ts`)!]!), `over2/${E}`);
  assert.equal(plaqueOf(l.desks[1]!), 'a.ts');

  // Both '…' zones reach their shelves: the real folder's ':…/…' and the overflow zone's '…/…'.
  for (let i = 0; i < 21; i++) b.desk(`${E}/f${pad(i)}.ts`, 40 + i);   // the real '…' zone: 23 file desks
  const realShelf = b.desk(`${E}/g.ts`, 70);
  for (let i = 0; i < 21; i++) b.desk(`of${pad(i)}/q.ts`, 80 + i);     // the overflow zone: 23 folder desks
  const overflowShelf = b.desk('of21/q.ts', 110);
  l = b.layout();
  keysUnique(l);
  assert.deepEqual([l.desks[realShelf]!.key, l.desks[realShelf]!.zone], [`:${E}/${E}`, 0]);
  assert.deepEqual([l.desks[overflowShelf]!.key, l.desks[overflowShelf]!.zone], [`${E}/${E}`, 15]);

  // A real '…' folder first touched after the overflow zone exists is an overflow folder, not a file desk of that zone.
  const c = new LayoutBuilder(emptyLayout());
  for (let i = 0; i < 16; i++) c.desk(`d${pad(i)}/f.ts`, i);
  const late = c.desk(`${E}/late.ts`, 20);
  assert.equal(c.desk(`${E}/late2.ts`, 21), late, 'one folder desk for the folder');
  const m = c.layout();
  keysUnique(m);
  assert.deepEqual(m.desks[late], { ordinal: late, key: `:${E}/`, kind: 'folder', zone: 15, cell: 15, slot: 1, path: null, lockbox: false, first: 20 });
  assert.equal(plaqueOf(m.desks[late]!), E);
  // Resuming from that snapshot keeps the distinction.
  const resumed = new LayoutBuilder(m);
  assert.equal(resumed.desk(`${E}/late3.ts`, 22), late);
  assert.equal(resumed.desk('d16/f.ts', 23), late + 1);
  assert.equal(resumed.layout().desks[late + 1]!.key, 'd16/');

  // Files named '…' never take a shelf's key: 'test/…' is a file desk, the zone's shelf is 'test/…' written unescaped.
  const s = new LayoutBuilder(emptyLayout());
  const dots = s.desk(`test/${E}`, 1);
  const deep = s.desk(`src/x/${E}`, 1);
  for (let i = 0; i < 22; i++) s.desk(`test/f${pad(i)}.ts`, 2);
  const shelf = s.desk('test/g.ts', 3);
  const n = s.layout();
  keysUnique(n);
  assert.deepEqual([n.desks[dots]!.key, n.desks[dots]!.kind, n.desks[deep]!.key, n.desks[shelf]!.key], [`test/:${E}`, 'file', `src/x/:${E}`, `test/${E}`]);
  assert.equal(plaqueOf(n.desks[dots]!), E);
  // Even paths the validators refuse (':' never occurs in a valid path) keep the keys apart.
  const v = new LayoutBuilder(emptyLayout());
  v.desk(`:${E}/x.ts`, 1);
  v.desk(`${E}/x.ts`, 1);
  keysUnique(v.layout());
});

test('applyLayoutDelta reproduces the builder\'s layout and refuses a delta from another version', () => {
  const b = new LayoutBuilder(emptyLayout());
  const deltas: LayoutDelta[] = [];
  const take = (): void => {
    const d = b.takeDelta();
    if (d !== null) deltas.push(d);
  };
  b.home('aa'.repeat(16));
  b.desk('src/a.ts', 1);
  take();
  for (let i = 0; i < 8; i++) b.desk(`src/f${i}.ts`, 2);         // src grows an annex cell
  b.desk('README.md', 2);
  take();
  b.home('bb'.repeat(16));
  for (let i = 0; i < 20; i++) b.desk(`src/g${i}.ts`, 3);        // src reaches its shelf
  take();
  b.desk('lib/x.ts', 4);
  take();
  assert.ok(deltas.length === 4);
  assert.deepEqual(deltas[1]!.zones.map((z) => [z.key, z.cells]), [['src', [0, 1]], [MIDDLE_DOT, [2]]], 'grown and new zones, whole');
  let page = emptyLayout();
  for (const d of deltas) page = applyLayoutDelta(page, d);
  const server = b.layout();
  assert.equal(page.version, server.version);
  assert.deepEqual(page.zones, server.zones);
  assert.deepEqual(page.desks, server.desks);
  assert.deepEqual(page.homeOrder, server.homeOrder);
  // The page knows the file desks' paths only (a shelf's paths are server-side, LayoutVM has no deskOf).
  const fileOnly = new Map([...server.deskOf].filter(([, ref]) => server.desks[ref]!.kind === 'file'));
  assert.deepEqual(page.deskOf, fileOnly);
  assert.ok([...server.deskOf.values()].some((ref) => server.desks[ref]!.kind === 'shelf'));
  // A delta from another version is refused, and the input layout is untouched.
  const before = JSON.stringify(page.desks);
  assert.throws(() => applyLayoutDelta(page, deltas[2]!), /version/);
  assert.throws(() => applyLayoutDelta(emptyLayout(), deltas[1]!), /version/);
  assert.equal(JSON.stringify(page.desks), before);
  // Applying returns a new layout and never edits its input.
  const start = emptyLayout();
  const next = applyLayoutDelta(start, deltas[0]!);
  assert.notEqual(next, start);
  assert.equal(start.desks.length, 1);
  assert.equal(start.deskOf.size, 0);
});
