// Plan 8a Task 13: pathfinding (12 §3.5.4 "Pathfinding", §3.5.2 "Blocked tiles"; VIZ-16, VIZ-17): 4-way A* with a Manhattan
// heuristic, neighbour order N, E, S, W, a turn penalty of 1; actors pass through each other; poof rules; the path cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOOR, deskTiles, emptyLayout, homeTile, isBlocked, LayoutBuilder, officeTiles, type Layout, type Tile } from '../../../src/viz/model/layout.js';
import { findPath, PathCache, shouldPoof } from '../../../src/viz/ui/path.js';

/** The 15 regular zones and the overflow zone '…', each with its 4 cells: 64 cells, every slot taken (23 desks and a shelf). */
function bigOffice(): Layout {
  const b = new LayoutBuilder(emptyLayout());
  for (let z = 0; z < 16; z++) for (let i = 0; i < 24; i++) b.desk(`z${z}/f${i}.ts`, 1);
  // The overflow zone: one folder desk per further folder, then its shelf.
  for (let z = 16; z < 16 + 24; z++) b.desk(`z${z}/x.ts`, 1);
  return b.layout();
}

/** blocked() over a precomputed grid (isBlocked recounts cells on every call). */
function blockedOf(l: Layout): (t: Tile) => boolean {
  const { w, h } = officeTiles(l);
  const grid = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) grid[y * w + x] = isBlocked(l, { x, y }) ? 1 : 0;
  return (t) => t.x < 0 || t.y < 0 || t.x >= w || t.y >= h || grid[t.y * w + t.x] === 1;
}

/** steps + one per change of direction. */
function cost(p: readonly Tile[]): number {
  let turns = 0;
  for (let i = 2; i < p.length; i++) {
    const a = [p[i - 1]!.x - p[i - 2]!.x, p[i - 1]!.y - p[i - 2]!.y], b = [p[i]!.x - p[i - 1]!.x, p[i]!.y - p[i - 1]!.y];
    if (a[0] !== b[0] || a[1] !== b[1]) turns++;
  }
  return p.length - 1 + turns;
}
const moves = (p: readonly Tile[]): string =>
  p.slice(1).map((t, i) => (t.y < p[i]!.y ? 'N' : t.x > p[i]!.x ? 'E' : t.y > p[i]!.y ? 'S' : 'W')).join('');

test('T-VIZ-layout (path): A* reaches every chair, visitor tile and home spot from the door in a 64-cell office; ties break N, E, S, W with a turn penalty of 1; actors pass through each other; no path or ≥ 4× over > 12 tiles → poof; paths are cached per (layout version, from, to)', () => {
  const l = bigOffice();
  assert.equal(l.zones.reduce((n, z) => n + z.cells.length, 0), 64);
  const size = officeTiles(l);
  assert.deepEqual(size, { w: 21, h: 4 + 10 * 22 });
  const blocked = blockedOf(l);

  // Every chair, visitor tile and home spot (and the door cluster) is reached from the door by a 4-connected path over floor.
  const targets: Tile[] = [];
  for (const d of l.desks) {
    const t = deskTiles(l, d.ordinal);
    targets.push(t.chair, ...t.visitors);
  }
  for (let i = 0; i < 21; i++) targets.push(homeTile(i));
  assert.ok(targets.length > 1_900);
  for (const to of targets) {
    const p = findPath(DOOR, to, blocked, size);
    assert.ok(p !== null, `no path to ${to.x},${to.y}`);
    assert.deepEqual(p[0], DOOR);
    assert.deepEqual(p.at(-1), to);
    for (let i = 1; i < p.length; i++) assert.equal(Math.abs(p[i]!.x - p[i - 1]!.x) + Math.abs(p[i]!.y - p[i - 1]!.y), 1);
    for (const t of p) assert.equal(blocked(t), false);
  }

  // Ties: an open 5 × 5 room. (0,0) → (2,2) costs 4 steps + 1 turn either way; N, E, S, W order picks E first.
  const open = (): boolean => false;
  const room = { w: 5, h: 5 };
  assert.equal(moves(findPath({ x: 0, y: 0 }, { x: 2, y: 2 }, open, room)!), 'EESS');
  assert.equal(moves(findPath({ x: 2, y: 2 }, { x: 0, y: 0 }, open, room)!), 'NNWW');
  assert.equal(moves(findPath({ x: 0, y: 2 }, { x: 2, y: 0 }, open, room)!), 'NNEE');
  assert.equal(moves(findPath({ x: 2, y: 0 }, { x: 0, y: 2 }, open, room)!), 'SSWW');
  assert.equal(moves(findPath({ x: 0, y: 0 }, { x: 4, y: 0 }, open, room)!), 'EEEE');
  assert.deepEqual(findPath({ x: 1, y: 1 }, { x: 1, y: 1 }, open, room), [{ x: 1, y: 1 }]);
  // The turn penalty: a staircase (4 turns) loses to an L (1 turn) of the same length.
  for (const [from, to] of [[{ x: 0, y: 0 }, { x: 3, y: 4 }], [{ x: 4, y: 1 }, { x: 0, y: 3 }]] as const) {
    const p = findPath(from, to, open, room)!;
    assert.equal(p.length - 1, Math.abs(to.x - from.x) + Math.abs(to.y - from.y));
    assert.equal(cost(p), p.length - 1 + 1, moves(p));
  }
  // Around a wall: the shortest path with the fewest turns.
  const wall = (t: Tile): boolean => t.x === 2 && t.y < 4;
  const around = findPath({ x: 0, y: 0 }, { x: 4, y: 0 }, wall, room)!;
  assert.equal(moves(around), 'SSSSEEEENNNN');
  assert.equal(cost(around), 12 + 2);

  // Actors pass through each other: nothing but furniture blocks, so the straight path crosses a standing actor's tile.
  const actorAt = { x: 2, y: 1 };
  const straight = findPath({ x: 0, y: 1 }, { x: 4, y: 1 }, open, room)!;
  assert.ok(straight.some((t) => t.x === actorAt.x && t.y === actorAt.y));

  // No path: a blocked target, an unreachable target, a target outside the office.
  assert.equal(findPath({ x: 0, y: 0 }, { x: 2, y: 2 }, (t) => t.x === 2 && t.y === 2, room), null);
  assert.equal(findPath({ x: 0, y: 0 }, { x: 4, y: 4 }, (t) => t.x === 3, room), null);
  assert.equal(findPath({ x: 0, y: 0 }, { x: 5, y: 0 }, open, room), null);

  // Poof: no path, or at a replay speed of 4× or more over more than 12 tiles.
  const line = (n: number): Tile[] => Array.from({ length: n + 1 }, (_, x) => ({ x, y: 0 }));
  assert.equal(shouldPoof(null, 1), true);
  assert.equal(shouldPoof(line(30), 1), false);
  assert.equal(shouldPoof(line(30), 2), false);
  assert.equal(shouldPoof(line(12), 4), false);
  assert.equal(shouldPoof(line(13), 4), true);
  assert.equal(shouldPoof(line(13), 8), true);
  assert.equal(shouldPoof(line(13), 0.5), false);

  // The cache: keyed by (layout version, from, to); computed once per key; a new layout version computes again.
  const cache = new PathCache(3);
  let computed = 0;
  const compute = (): Tile[] | null => {
    computed++;
    return line(2);
  };
  const a = { x: 0, y: 0 }, b2 = { x: 2, y: 0 };
  assert.deepEqual(cache.get(7, a, b2, compute), line(2));
  assert.deepEqual(cache.get(7, { ...a }, { ...b2 }, compute), line(2));
  assert.equal(computed, 1);
  cache.get(8, a, b2, compute);
  assert.equal(computed, 2);
  cache.get(7, b2, a, compute);
  assert.equal(computed, 3);
  // A cached "no path" is a hit too.
  let nulls = 0;
  assert.equal(cache.get(9, a, a, () => (nulls++, null)), null);
  assert.equal(cache.get(9, a, a, () => (nulls++, null)), null);
  assert.equal(nulls, 1);
  // Bounded: beyond max entries the oldest is dropped and computed again.
  cache.get(7, a, b2, compute);
  assert.equal(computed, 4);
  // Results are copies: a caller changing a returned path does not change the cache.
  const got = cache.get(10, a, b2, () => line(2))!;
  got.push({ x: 99, y: 99 });
  assert.deepEqual(cache.get(10, a, b2, () => null), line(2));
});
