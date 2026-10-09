// Plan 8a Task 4: look assignment and the home-spot order of 12 §3.6 (VIZ-18, R-V20).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLayoutDelta, emptyLayout, LayoutBuilder } from '../../../src/viz/model/layout.js';
import { ACCESSORY_COUNT, HUE_COUNT, LOOK_COUNT, lookOf, lookTable } from '../../../src/viz/model/looks.js';

/** Golden vectors computed outside the code under test: n = uint32 big-endian of sha256(peer ‖ 0x00 ‖ "viz-look")[0..3]. */
const GOLDEN: ReadonlyArray<{ peer: string; n: number; L: number; hue: number; accessory: number }> = [
  { peer: '0'.repeat(32), n: 217_973_415, L: 23, hue: 2, accessory: 3 },
  { peer: 'f'.repeat(32), n: 2_952_717_694, L: 38, hue: 3, accessory: 5 },   // n ≥ 2^31: read unsigned
  { peer: '0123456789abcdef0123456789abcdef', n: 3_409_438_819, L: 3, hue: 3, accessory: 0 },
  { peer: 'a1'.repeat(16), n: 1_408_832_542, L: 54, hue: 5, accessory: 7 },
  { peer: '5e1f'.repeat(8), n: 4_250_065_377, L: 33, hue: 5, accessory: 4 },
];

test('T-VIZ-looks (model): lookOf follows the 12 §3.6 formula with a big-endian uint32', () => {
  assert.deepEqual([HUE_COUNT, ACCESSORY_COUNT, LOOK_COUNT], [7, 8, 56]);
  for (const g of GOLDEN) {
    // The vector is self-consistent with L = n mod 56, hue = L mod 7, accessory = ⌊L / 7⌋.
    assert.deepEqual([g.n % 56, g.L % 7, Math.floor(g.L / 7)], [g.L, g.hue, g.accessory]);
    assert.deepEqual(lookOf(g.peer), { hue: g.hue, accessory: g.accessory }, g.peer);
  }
  // The same peer gets the same look in every call, every table, any table order.
  const peers = GOLDEN.map((g) => g.peer);
  const t1 = lookTable(peers);
  const t2 = lookTable([...peers].reverse());
  assert.ok(t1 instanceof Map);
  for (const p of peers) {
    assert.deepEqual(lookOf(p), lookOf(p));
    assert.deepEqual(t1.get(p), lookOf(p));
    assert.deepEqual(t2.get(p), lookOf(p));
  }
  assert.equal(lookTable([peers[0]!, peers[0]!]).size, 1);
  // 56 distinct peers can cover all 56 looks (the map is onto the 7 × 8 grid).
  const byLook = new Map<number, string>();
  for (let i = 0; byLook.size < LOOK_COUNT && i < 5_000; i++) {
    const peer = i.toString(16).padStart(32, '0');
    const { hue, accessory } = lookOf(peer);
    assert.ok(Number.isInteger(hue) && hue >= 0 && hue < HUE_COUNT);
    assert.ok(Number.isInteger(accessory) && accessory >= 0 && accessory < ACCESSORY_COUNT);
    if (!byLook.has(accessory * HUE_COUNT + hue)) byLook.set(accessory * HUE_COUNT + hue, peer);
  }
  assert.equal(byLook.size, LOOK_COUNT);
  const cover = lookTable(byLook.values());
  assert.equal(cover.size, 56);
  assert.equal(new Set([...cover.values()].map((l) => `${l.hue}.${l.accessory}`)).size, 56);
});

test('homeOrder: start-state peers sorted by peer_id, then first appearance, never reordered', () => {
  const start = ['c3'.repeat(16), 'a1'.repeat(16), 'b2'.repeat(16)];
  const b = new LayoutBuilder(emptyLayout());
  for (const p of [...start].sort()) b.home(p);                  // the timeline builder passes the start peers sorted
  b.home('ff'.repeat(16));                                        // new peers at their first appearance in the frames
  b.home('0a'.repeat(16));
  b.home('a1'.repeat(16));                                        // a repeat moves nobody
  b.home('ff'.repeat(16));
  const expected = ['a1'.repeat(16), 'b2'.repeat(16), 'c3'.repeat(16), 'ff'.repeat(16), '0a'.repeat(16)];
  assert.deepEqual(b.layout().homeOrder, expected);
  // Allocation in between never reorders, and a builder resumed from the snapshot keeps the order and appends.
  b.desk('src/a.ts', 3);
  const resumed = new LayoutBuilder(b.layout());
  resumed.home('c3'.repeat(16));
  resumed.home('99'.repeat(16));
  assert.deepEqual(resumed.layout().homeOrder, [...expected, '99'.repeat(16)]);
  // The page's delta form appends only the new entries.
  const page = applyLayoutDelta(emptyLayout(), b.takeDelta()!);
  assert.deepEqual(page.homeOrder, expected);
  // Each new home entry is one version step (R-V57); a repeat is none.
  const c = new LayoutBuilder(emptyLayout());
  c.home('a1'.repeat(16));
  c.home('a1'.repeat(16));
  assert.equal(c.layout().version, 1);
});
