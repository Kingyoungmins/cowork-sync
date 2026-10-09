// Plan 8a Task 4: properties of the append-only desk allocation (12 §3.5.3, VIZ-16, INV-VIZ-DET, R-V51, R-V57) over random
// sequences of path touches and home entries that reach the overflow zone, folder desks, annex cells and shelves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { canonicalJson, type Json } from '../../../src/board/canonicalJson.js';
import {
  BIG_TABLE_KEY,
  CELLS_PER_ZONE,
  emptyLayout,
  FILE_DESKS_PER_ZONE,
  LayoutBuilder,
  OVERFLOW_ZONE,
  SLOTS_PER_CELL,
  ZONES_MAX,
  type Desk,
  type Layout,
} from '../../../src/viz/model/layout.js';

const RUNS = 100;
/** The reserved glyphs '…', '·' and '⌂' as teammate folder and file names (they must never alias a reserved key). */
const GLYPHS = ['\u{2026}', '\u{00B7}', '\u{2302}'];
const S1 = Array.from({ length: 20 }, (_, i) => `z${i}`).concat(['__proto__', 'constructor'], GLYPHS);

/** A path: a root file, a two-segment path, a three- or four-segment path, or one of a hot zone that reaches its shelf. */
const pathArb: fc.Arbitrary<string> = fc.oneof(
  { arbitrary: fc.nat(30).map((n) => `f${n}.ts`), weight: 1 },
  { arbitrary: fc.constantFrom(...GLYPHS), weight: 1 },
  { arbitrary: fc.tuple(fc.constantFrom(...S1, 'hot'), fc.constantFrom('', 'a/')).map(([s, a]) => `${s}/${a}\u{2026}`), weight: 1 },
  { arbitrary: fc.tuple(fc.constantFrom(...S1), fc.nat(5)).map(([s, n]) => `${s}/f${n}.ts`), weight: 3 },
  { arbitrary: fc.tuple(fc.constantFrom(...S1), fc.constantFrom('a', 'b', '__proto__'), fc.nat(5)).map(([s, t, n]) => `${s}/${t}/f${n}.ts`), weight: 3 },
  { arbitrary: fc.tuple(fc.constantFrom(...S1), fc.nat(3)).map(([s, n]) => `${s}/a/b/f${n}.ts`), weight: 1 },
  { arbitrary: fc.nat(40).map((n) => `hot/f${n}.ts`), weight: 3 },
);
/** Twelve peers, so home entries repeat. */
const PEERS = Array.from({ length: 12 }, (_, i) => i.toString(16).padStart(2, '0').repeat(16));

/** A path touch [path, height], or a home entry (a peer's appearance, §3.6). */
type Touch = readonly [path: string, h: number] | { readonly home: string };

/** Touches in frame order: path touches with non-decreasing heights (a frame names several paths at one height) and home entries. */
const touchesArb: fc.Arbitrary<Touch[]> = fc
  .array(
    fc.oneof(
      { arbitrary: fc.tuple(pathArb, fc.nat(3)), weight: 8 },
      { arbitrary: fc.constantFrom(...PEERS).map((home) => ({ home })), weight: 1 },
    ),
    { maxLength: 160, size: 'max' },
  )
  .map((xs) => {
    let h = 1;
    return xs.map((x): Touch => ('home' in x ? x : [x[0], (h += x[1])]));
  });

/** The path touches of a sequence, in order. */
function pathTouches(touches: readonly Touch[]): Array<readonly [string, number]> {
  return touches.filter((t): t is readonly [string, number] => !('home' in t));
}

function cellCount(l: Layout): number {
  return l.zones.reduce((n, z) => n + z.cells.length, 0);
}

/** canonicalJson of a layout with deskOf as ascending [key, value] pairs (UTF-16 code units), as serializeTimeline writes it. */
function serializeLayout(l: Layout): string {
  const deskOf = [...l.deskOf].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return canonicalJson({
    version: l.version,
    zones: l.zones.map((z) => ({ index: z.index, key: z.key, cells: [...z.cells] })),
    desks: l.desks.map((d) => ({ ...d })),
    homeOrder: [...l.homeOrder],
    deskOf,
  } as unknown as Json);
}

function build(touches: readonly Touch[], base: Layout = emptyLayout()): Layout {
  const b = new LayoutBuilder(base);
  for (const t of touches) {
    if ('home' in t) b.home(t.home);
    else b.desk(t[0], t[1]);
  }
  return b.layout();
}

/** A detached deep copy of every desk (a desk's fields are primitives), so a desk changed in place later is caught. */
function copyDesks(desks: readonly Desk[]): Desk[] {
  return desks.map((d) => ({ ...d }));
}

test('T-VIZ-layout: allocation is append-only', () => {
  let sawOverflow = false;
  let sawShelf = false;
  let sawGlyphFolder = false;
  let sawGlyphRoot = false;
  let homeSteps = 0;
  fc.assert(
    fc.property(touchesArb, (touches) => {
      const b = new LayoutBuilder(emptyLayout());
      let prev = b.layout();
      let prevDesks = copyDesks(prev.desks);
      const firstTouch = new Map<string, number>();
      for (const t of touches) {
        const ref = 'home' in t ? null : b.desk(t[0], t[1]);
        if ('home' in t) b.home(t.home);
        else if (!firstTouch.has(t[0])) firstTouch.set(t[0], t[1]);
        const next = b.layout();
        // No existing desk changes: ordinal, key, kind, zone, cell, slot, path, lockbox, first — compared with the copy taken
        // at the previous step (the layouts share desk objects, so comparing prev.desks with next.desks could never differ).
        assert.deepEqual(next.desks.slice(0, prevDesks.length), prevDesks);
        // Every path keeps its desk; home entries only append.
        for (const [q, d] of prev.deskOf) assert.equal(next.deskOf.get(q), d);
        assert.deepEqual(next.homeOrder.slice(0, prev.homeOrder.length), prev.homeOrder);
        // Ordinals are allocation order; the big table is 0 and was first touched at 0.
        next.desks.forEach((d, i) => assert.equal(d.ordinal, i));
        assert.deepEqual(next.desks[0], { ordinal: 0, key: BIG_TABLE_KEY, kind: 'big_table', zone: null, cell: null, slot: null, path: null, lockbox: false, first: 0 });
        // No teammate path aliases a reserved key: desk keys and zone keys are unique, and the overflow zone is exactly the
        // 16th zone (15 regular zones first, a real folder named '…' among them).
        assert.equal(new Set(next.desks.map((d) => d.key)).size, next.desks.length, 'desk keys are unique');
        assert.equal(new Set(next.zones.map((z) => z.key)).size, next.zones.length, 'zone keys are unique');
        next.zones.forEach((z) => assert.equal(z.key === OVERFLOW_ZONE, z.index === ZONES_MAX, `zone ${z.index} ${z.key}`));
        // version +1 per desk, cell or home entry added (R-V57); at most one of each per touch.
        const newDesks = next.desks.length - prev.desks.length;
        const newCells = cellCount(next) - cellCount(prev);
        const newHomes = next.homeOrder.length - prev.homeOrder.length;
        assert.equal(next.version - prev.version, newDesks + newCells + newHomes);
        assert.equal(next.version, next.desks.length - 1 + cellCount(next) + next.homeOrder.length);
        if ('home' in t) {
          // A home entry adds no desk or cell, and one entry exactly when the peer is new.
          assert.equal(newDesks + newCells, 0);
          assert.equal(newHomes, prev.homeOrder.includes(t.home) ? 0 : 1);
          assert.equal(next.homeOrder.filter((p) => p === t.home).length, 1);
          if (newHomes === 1) homeSteps++;
          prev = next;
          continue;
        }
        const [p, h] = t;
        // A path touch adds no home entry; a new desk is first touched now (R-V51).
        assert.equal(newHomes, 0);
        assert.ok(newDesks <= 1 && newCells <= 1 && newCells <= newDesks);
        for (const d of next.desks.slice(prev.desks.length)) assert.equal(d.first, h);
        assert.equal(next.deskOf.get(p), ref);
        assert.ok(ref !== null && ref > 0 && ref < next.desks.length);
        // Zones keep their cells in order and only grow; the caps hold.
        for (let z = 0; z < prev.zones.length; z++) {
          assert.deepEqual(next.zones[z]!.cells.slice(0, prev.zones[z]!.cells.length), prev.zones[z]!.cells);
          assert.equal(next.zones[z]!.key, prev.zones[z]!.key);
        }
        assert.ok(next.zones.length <= ZONES_MAX + 1);
        next.zones.forEach((z, i) => assert.equal(z.index, i));
        for (const z of next.zones) {
          assert.ok(z.cells.length <= CELLS_PER_ZONE);
          // The zone's desks fill its cells row-major in allocation order; only the 24th slot holds the shelf.
          const desks = next.desks.filter((d) => d.zone === z.index);
          assert.ok(desks.length <= FILE_DESKS_PER_ZONE + 1);
          desks.forEach((d, k) => {
            assert.equal(d.cell, z.cells[Math.floor(k / SLOTS_PER_CELL)]);
            assert.equal(d.slot, k % SLOTS_PER_CELL);
            assert.equal(d.kind === 'shelf', k === FILE_DESKS_PER_ZONE);
            assert.equal(d.kind === 'folder', z.key === OVERFLOW_ZONE && k < FILE_DESKS_PER_ZONE);
          });
          assert.equal(z.cells.length, Math.max(1, Math.ceil(desks.length / SLOTS_PER_CELL)), 'an annex cell only when the newest one is full');
        }
        if (next.zones.some((z) => z.key === OVERFLOW_ZONE)) sawOverflow = true;
        if (next.desks.some((d) => d.kind === 'shelf')) sawShelf = true;
        if (next.desks.some((d) => d.kind === 'file' && d.path!.startsWith('\u{2026}/'))) sawGlyphFolder = true;
        if (next.desks.some((d) => d.kind === 'file' && d.path === '\u{2302}')) sawGlyphRoot = true;
        prev = next;
        prevDesks = copyDesks(next.desks);
      }
      // Each desk's first is the height of the first path that touched it.
      for (const [q, ref] of prev.deskOf) {
        const d: Desk = prev.desks[ref]!;
        const touchedBy = [...prev.deskOf].filter(([, r]) => r === ref).map(([x]) => firstTouch.get(x)!);
        assert.equal(d.first, Math.min(...touchedBy), q);
      }
    }),
    { numRuns: RUNS, seed: 0x7a1 },
  );
  assert.ok(sawOverflow, 'the generator reaches the overflow zone');
  assert.ok(sawShelf, 'the generator reaches a shelf');
  assert.ok(homeSteps > 0, 'the generator adds home entries');
  assert.ok(sawGlyphFolder, 'the generator gives a real folder named \u{2026} a regular zone');
  assert.ok(sawGlyphRoot, 'the generator touches a root file named \u{2302}');
});

const pad = (n: number): string => String(n).padStart(2, '0');
const hasOverflow = (l: Layout): boolean => l.zones.some((z) => z.key === OVERFLOW_ZONE);
const hasShelf = (l: Layout): boolean => l.desks.some((d) => d.kind === 'shelf');

test('T-VIZ-layout: the same path sequence twice gives identical layouts', () => {
  // Forced: a snapshot that already holds overflow folder desks, a shelf and a home entry, resumed with an existing and a
  // new overflow folder, a path to the existing shelf, a new file desk, a known path, a known and a new peer (the builder
  // rebuilds its tables from the base).
  const prefix: Touch[] = [{ home: PEERS[0]! }];
  for (let i = 0; i < 14; i++) prefix.push([`w${pad(i)}/f.ts`, 1 + i]);       // 14 zones
  for (let i = 0; i < 24; i++) prefix.push([`hot/f${pad(i)}.ts`, 20]);        // the 15th: 23 file desks, then its shelf
  prefix.push(['ov1/a/x.ts', 30], ['ov2/y.ts', 31]);                          // two overflow folders
  const suffix: Touch[] = [
    ['ov1/a/z.ts', 40], ['ov3/q.ts', 41], ['hot/f30.ts', 42], ['w02/g.ts', 43], ['ov2/y.ts', 44], { home: PEERS[0]! }, { home: PEERS[1]! },
  ];
  const snapshot = build(prefix);
  assert.ok(hasOverflow(snapshot) && hasShelf(snapshot), 'the snapshot holds an overflow zone and a shelf');
  const resumed = build(suffix, snapshot);
  assert.equal(serializeLayout(resumed), serializeLayout(build([...prefix, ...suffix])));
  assert.deepEqual(resumed.desks.slice(snapshot.desks.length).map((d) => d.key), ['ov3/', 'w02/g.ts'], 'the existing folder desk and shelf are reused');
  assert.deepEqual(resumed.homeOrder, [PEERS[0], PEERS[1]]);
  assert.equal(resumed.version, snapshot.version + 2 + 1, 'two desks (no new cell) and one home entry');

  let resumedAfterOverflow = false;
  let resumedAfterShelf = false;
  fc.assert(
    fc.property(touchesArb, fc.nat(160), (touches, cut) => {
      const a = serializeLayout(build(touches));
      assert.equal(serializeLayout(build(touches)), a);
      // Extending a snapshot (live mode, VIZ-10) gives the same bytes as building the longer sequence at once.
      const k = Math.min(cut, touches.length);
      const head = build(touches.slice(0, k));
      assert.equal(serializeLayout(build(touches.slice(k), head)), a);
      if (k < touches.length && hasOverflow(head)) resumedAfterOverflow = true;
      if (k < touches.length && hasShelf(head)) resumedAfterShelf = true;
    }),
    { numRuns: RUNS, seed: 0x7a2 },
  );
  assert.ok(resumedAfterOverflow, 'a random run resumes after an overflow folder');
  assert.ok(resumedAfterShelf, 'a random run resumes after a shelf');
});

test("T-VIZ-layout: appending an earlier page's paths after every existing desk changes no ordinal", () => {
  // Forced: the window (heights ≥ 1,000) holds 15 zones; the earlier page (heights 5–12) fills hot to its shelf, opens an
  // overflow folder and adds a file desk — each appended desk carries the earlier page's height that first touched it.
  const window: Array<[string, number]> = [];
  for (let i = 0; i < 14; i++) window.push([`w${pad(i)}/f.ts`, 1_000 + i]);
  for (let i = 0; i < 20; i++) window.push([`hot/f${pad(i)}.ts`, 1_020]);
  const head = build(window);
  const earlierPage: Array<[string, number]> = [
    ['hot/f20.ts', 5], ['hot/f21.ts', 6], ['hot/f22.ts', 7], ['hot/f23.ts', 8], ['ov1/a/x.ts', 9], ['ov1/a/y.ts', 9], ['hot/f24.ts', 10], ['w03/g.ts', 12],
  ];
  const forced = build(earlierPage, head);
  assert.deepEqual(forced.desks.slice(head.desks.length).map((d) => [d.ordinal, d.key, d.kind, d.first]), [
    [35, 'hot/f20.ts', 'file', 5], [36, 'hot/f21.ts', 'file', 6], [37, 'hot/f22.ts', 'file', 7],
    [38, 'hot/\u{2026}', 'shelf', 8], [39, 'ov1/a/', 'folder', 9], [40, 'w03/g.ts', 'file', 12],
  ]);

  let appendedDesks = 0;
  fc.assert(
    fc.property(touchesArb, touchesArb, (windowRaw, earlier) => {
      // The window lies at heights ≥ 1,001; the earlier page keeps its own heights (1 to 481), all below the window's.
      const head = build(windowRaw.map((t): Touch => ('home' in t ? t : [t[0], t[1] + 1_000])));
      const headDesks = copyDesks(head.desks);
      const extended = build(earlier, head);
      const earlierPaths = pathTouches(earlier);
      assert.deepEqual(extended.desks.slice(0, headDesks.length), headDesks);
      for (const [p, d] of head.deskOf) assert.equal(extended.deskOf.get(p), d);
      for (let z = 0; z < head.zones.length; z++) assert.equal(extended.zones[z]!.key, head.zones[z]!.key);
      assert.deepEqual(extended.homeOrder.slice(0, head.homeOrder.length), head.homeOrder);
      assert.equal(extended.version, extended.desks.length - 1 + cellCount(extended) + extended.homeOrder.length);
      // The appended desks come after every existing one, in the page's first-touch order.
      const appended = extended.desks.slice(head.desks.length);
      appended.forEach((d, i) => assert.equal(d.ordinal, head.desks.length + i));
      const firstNewTouch = earlierPaths.filter(([p]) => !head.deskOf.has(p)).map(([p]) => extended.deskOf.get(p)!);
      const order = firstNewTouch.filter((d, i) => d >= head.desks.length && firstNewTouch.indexOf(d) === i);
      assert.deepEqual(order, appended.map((d) => d.ordinal));
      // Each appended desk's first is the earlier-page height of the first new path that reached it (R-V51).
      for (const d of appended) {
        const heights = earlierPaths.filter(([p]) => !head.deskOf.has(p) && extended.deskOf.get(p) === d.ordinal).map(([, h]) => h);
        assert.equal(d.first, Math.min(...heights), d.key);
        assert.ok(d.first >= 1 && d.first <= 1_000, 'below the window');
        appendedDesks++;
      }
    }),
    { numRuns: RUNS, seed: 0x7a3 },
  );
  assert.ok(appendedDesks > 0, 'the earlier pages append desks');
});
