// Pathfinding (12 §3.5.4 "Pathfinding"; VIZ-17): 4-way A* on the tile grid with a Manhattan heuristic, neighbour order N, E,
// S, W and a turn penalty of 1, ties broken by that order. Actors pass through each other (only furniture is blocked); with no
// path, or at a replay speed of 4× or more over more than 12 tiles, the actor poofs. Paths are cached per (layout version,
// from, to). Pure and DOM-free (R-V33).
import type { Tile } from '../model/layout.js';

const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];              // N, E, S, W
const NO_DIR = 4;

/** A binary min-heap of state indices by (f, h, insertion order). */
class Heap {
  private readonly items: Array<{ s: number; f: number; h: number; seq: number }> = [];
  private seq = 0;
  get size(): number { return this.items.length; }
  push(s: number, f: number, h: number): void {
    const it = { s, f, h, seq: this.seq++ };
    const a = this.items;
    a.push(it);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i]!, a[p]!)) break;
      [a[i], a[p]] = [a[p]!, a[i]!];
      i = p;
    }
  }
  pop(): number {
    const a = this.items;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l]!, a[m]!)) m = l;
        if (r < a.length && this.less(a[r]!, a[m]!)) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m]!, a[i]!];
        i = m;
      }
    }
    return top.s;
  }
  private less(x: { f: number; h: number; seq: number }, y: { f: number; h: number; seq: number }): boolean {
    return x.f !== y.f ? x.f < y.f : x.h !== y.h ? x.h < y.h : x.seq < y.seq;
  }
}

/**
 * The cheapest path from `from` to `to` (both included) where a step costs 1 and a change of direction 1 more; a state is a tile
 * and the direction it was entered by, so the turn penalty is exact. Ties: the open state with the lower f, then the lower
 * heuristic, then the one generated first (neighbours are generated N, E, S, W). null when `to` is blocked, outside `size` or
 * unreachable. `from` itself is never checked (an actor may stand on any tile).
 */
export function findPath(from: Tile, to: Tile, blocked: (t: Tile) => boolean, size: { w: number; h: number }): Tile[] | null {
  const { w, h } = size;
  const inside = (x: number, y: number): boolean => Number.isSafeInteger(x) && Number.isSafeInteger(y) && x >= 0 && y >= 0 && x < w && y < h;
  if (!inside(from.x, from.y) || !inside(to.x, to.y) || blocked(to)) return null;
  if (from.x === to.x && from.y === to.y) return [{ x: from.x, y: from.y }];
  const states = w * h * 5;
  const g = new Float64Array(states).fill(Number.POSITIVE_INFINITY);
  const parent = new Int32Array(states).fill(-1);
  const closed = new Uint8Array(states);
  const free = new Int8Array(w * h);                        // 0 unknown, 1 floor, 2 blocked: blocked() asked once per tile
  const isFree = (x: number, y: number): boolean => {
    const i = y * w + x;
    if (free[i] === 0) free[i] = blocked({ x, y }) ? 2 : 1;
    return free[i] === 1;
  };
  const heur = (x: number, y: number): number => Math.abs(to.x - x) + Math.abs(to.y - y);
  const id = (x: number, y: number, d: number): number => (y * w + x) * 5 + d;
  const heap = new Heap();
  const start = id(from.x, from.y, NO_DIR);
  g[start] = 0;
  heap.push(start, heur(from.x, from.y), heur(from.x, from.y));
  while (heap.size > 0) {
    const s = heap.pop();
    if (closed[s] === 1) continue;
    closed[s] = 1;
    const d = s % 5, cell = (s - d) / 5, x = cell % w, y = (cell - x) / w;
    if (x === to.x && y === to.y) {
      const out: Tile[] = [];
      for (let c = s; c !== -1; c = parent[c]!) {
        const cc = (c - (c % 5)) / 5;
        out.push({ x: cc % w, y: (cc - (cc % w)) / w });
      }
      return out.reverse();
    }
    for (let nd = 0; nd < 4; nd++) {
      const nx = x + DX[nd]!, ny = y + DY[nd]!;
      if (!inside(nx, ny) || !isFree(nx, ny)) continue;
      const n = id(nx, ny, nd);
      if (closed[n] === 1) continue;
      const cost = g[s]! + 1 + (d !== NO_DIR && d !== nd ? 1 : 0);
      if (cost < g[n]!) {
        g[n] = cost;
        parent[n] = s;
        const hh = heur(nx, ny);
        heap.push(n, cost + hh, hh);
      }
    }
  }
  return null;
}

/** Bounded by `max` entries, least recently used first out; a cached "no path" is a hit too; results are copies. */
export class PathCache {
  private readonly entries = new Map<string, Tile[] | null>();
  constructor(private readonly max: number) {}
  get(version: number, from: Tile, to: Tile, compute: () => Tile[] | null): Tile[] | null {
    const key = `${version}|${from.x},${from.y}|${to.x},${to.y}`;
    let p: Tile[] | null;
    if (this.entries.has(key)) {
      p = this.entries.get(key)!;
      this.entries.delete(key);
    } else {
      const c = compute();
      p = c === null ? null : c.map((t) => ({ x: t.x, y: t.y }));
      while (this.entries.size >= this.max && this.entries.size > 0) this.entries.delete(this.entries.keys().next().value!);
    }
    this.entries.set(key, p);
    return p === null ? null : p.map((t) => ({ x: t.x, y: t.y }));
  }
}

/** No path, or a replay speed ≥ 4× over more than 12 tiles. */
export function shouldPoof(path: Tile[] | null, speed: number): boolean {
  return path === null || (speed >= 4 && path.length - 1 > 12);
}
