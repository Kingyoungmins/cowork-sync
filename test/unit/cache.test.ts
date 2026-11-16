// TableCache (Plan 4 Task 4; R4-14, R1-081, R1-082, OQ-6; 04 §3.3 "Cache", "Last-good table", §3.18 "Table cache" and
// "Pinned draft post-images"; REG-18 index, R2-B03): one LRU by blobRef with pinned DiskSnapshotIds counted in its size,
// and the last-good index by path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOid, type Oid } from '../../src/git/oid.js';
import { BUDGETS } from '../../src/regions/budgets.js';
import { TableCache, UNIT_COST_BYTES } from '../../src/regions/cache.js';
import { lineArray } from '../../src/regions/lines.js';
import type { DiskSnapshotId, Label, NoTable, Ranges, RegionTable, Unit } from '../../src/regions/types.js';

const oid = (c: string): Oid => parseOid(c.repeat(40));
const label = (kind: string, qualname: string): Label => ({ kind, qualname, simple: qualname, type: '', disc: '' });

function unit(unitId: number, qualname: string, ranges: Ranges, parentUnitId: number | null = null, leaf = true): Unit {
  return { unitId, kind: 'function', label: label('function', qualname), ranges, parentUnitId, leaf, residue: false, sigSlice: null, granularity: 'symbol' };
}

function table(units: Unit[], errorSpans: Ranges = [], lineCount = 20): RegionTable {
  return {
    grammar: 'python', regionSpec: 'spec', decodable: true, lineCount, units, imports: null, errorSpans, errorCount: errorSpans.length,
    labelCounts: Object.fromEntries(units.map((u) => [`function\u{0}${u.label.qualname}\u{0}`, 1])),
  };
}

const NO_MARKERS: NoTable = { kind: 'NO_TABLE', reason: 'conflict_markers', lineCount: 3 };
const rowsOf = (n: number, width: number): readonly Buffer[] => lineArray(Buffer.from(`${'x'.repeat(width - 1)}\n`.repeat(n), 'utf8'));

test('TableCache is an LRU by blobRef with pins counted in its size', () => {
  assert.equal(BUDGETS.cacheBytes, 314_572_800, 'cacheBytes default');
  assert.equal(UNIT_COST_BYTES, 256);
  const cache = new TableCache(10_000);
  assert.equal(cache.bytes, 0);

  // put then get; the entry's size is its line-array bytes plus UNIT_COST_BYTES per unit
  const linesA = rowsOf(10, 100);   // 1,000 bytes
  const tA = table([unit(1, 'f', [[1, 4]]), unit(2, 'g', [[6, 9]])]);
  cache.put(oid('a'), 'a.py', tA, linesA);
  assert.equal(cache.get(oid('a'), 'a.py'), tA);
  assert.equal(cache.lines(oid('a')), linesA);
  assert.equal(cache.bytes, 1_000 + 2 * UNIT_COST_BYTES);
  assert.equal(cache.get(oid('a'), 'other.txt'), undefined, 'a table is cached per (blobRef, path)');
  assert.equal(cache.get(oid('9'), 'a.py'), undefined);

  // the same blob under a second path shares the line array: only the units are added
  cache.put(oid('a'), 'copy.py', table([unit(1, 'f', [[1, 9]])]), linesA);
  assert.equal(cache.bytes, 1_000 + 3 * UNIT_COST_BYTES);

  // a pinned DiskSnapshotId survives while the cache is over its cap and still counts in bytes
  const d: DiskSnapshotId = Object.freeze({ kind: 'disk', path: 'd.py', oid: oid('d') });
  cache.pin(d, 'd1');
  const linesD = rowsOf(40, 100);   // 4,000 bytes
  cache.put(d, 'd.py', table([unit(1, 'h', [[1, 40]])], [], 40), linesD);
  assert.equal(cache.bytes, 1_000 + 3 * UNIT_COST_BYTES + 4_000 + UNIT_COST_BYTES);

  // b: 3,000 bytes; c: 3,000 bytes → over 10,000: the least recently used unpinned entry (a) goes first
  cache.get(oid('a'), 'a.py');
  cache.put(oid('b'), 'b.py', NO_MARKERS, rowsOf(30, 100));
  assert.ok(cache.bytes <= 10_000);
  cache.get(oid('a'), 'a.py');   // a is now more recent than b
  cache.put(oid('c'), 'c.py', NO_MARKERS, rowsOf(30, 100));
  assert.equal(cache.get(oid('b'), 'b.py'), undefined, 'b was the least recently used unpinned entry');
  assert.notEqual(cache.get(oid('a'), 'a.py'), undefined);
  assert.notEqual(cache.get(d, 'd.py'), undefined);
  assert.ok(cache.bytes <= 10_000);

  // a big unpinned put evicts every other unpinned entry, never the pinned one nor the entry just put, even when that
  // leaves the cache over its cap
  cache.put(oid('e'), 'e.py', NO_MARKERS, rowsOf(70, 100));   // 7,000 bytes
  assert.equal(cache.get(oid('a'), 'a.py'), undefined);
  assert.equal(cache.get(oid('c'), 'c.py'), undefined);
  assert.equal(cache.get(oid('e'), 'e.py'), NO_MARKERS);
  assert.notEqual(cache.get(d, 'd.py'), undefined, 'pinned: never evicted');
  assert.equal(cache.lines(d), linesD);
  assert.ok(cache.bytes > 10_000, 'the pinned entry counts toward maxBytes');

  // unpin makes it evictable: the cache is brought back under its cap at once (e is now the least recently used entry,
  // the assertions above touched d) and d goes like any entry at the next put
  cache.unpin('d1');
  assert.equal(cache.get(oid('e'), 'e.py'), undefined);
  assert.equal(cache.bytes, 4_000 + UNIT_COST_BYTES);
  cache.put(oid('f'), 'f.py', NO_MARKERS, rowsOf(70, 100));   // 7,000 bytes
  assert.equal(cache.get(d, 'd.py'), undefined);
  assert.equal(cache.lines(d), undefined);
  assert.equal(cache.bytes, 7_000);

  // the default cap is BUDGETS.cacheBytes: a 1 MB entry stays
  const big = new TableCache();
  big.put(oid('f'), 'f.py', NO_MARKERS, rowsOf(1_000, 1_000));
  assert.equal(big.bytes, 1_000_000);
  assert.equal(big.get(oid('f'), 'f.py'), NO_MARKERS);
});

test('a pin taken before the put protects the entry; two owners must both unpin', () => {
  const cache = new TableCache(1_000);
  const d: DiskSnapshotId = { kind: 'disk', path: 'd.py', oid: oid('d') };
  cache.pin(d, 'o1');
  cache.pin({ ...d }, 'o2');   // an equal handle is the same blobRef
  cache.put(d, 'd.py', NO_MARKERS, rowsOf(20, 100));
  cache.put(oid('7'), 'x.py', NO_MARKERS, rowsOf(5, 100));
  assert.notEqual(cache.get(d, 'd.py'), undefined);
  assert.equal(cache.get(oid('7'), 'x.py'), NO_MARKERS, 'a put keeps its own entry');
  cache.unpin('o1');
  assert.notEqual(cache.get(d, 'd.py'), undefined, 'o2 still pins it');
  assert.equal(cache.get(oid('7'), 'x.py'), undefined, 'over the cap at unpin: the unpinned x goes');
  cache.unpin('o2');
  assert.equal(cache.get(d, 'd.py'), undefined);
  assert.equal(cache.bytes, 0);
});

test('lastGood returns the newest cached table whose covering top-level unit has no error span', () => {
  const cache = new TableCache(1_000_000);
  const lines = rowsOf(20, 10);
  // m.py: f at rows 3-8, class K (non-leaf, rows 10-16) with its residue and member m (rows 12-14)
  const units = (): Unit[] => [
    unit(1, 'f', [[3, 8]]),
    { ...unit(2, 'K', [[10, 16]], null, false), kind: 'class' },
    { ...unit(3, 'K', [[10, 11], [15, 16]], 2), kind: 'class', residue: true },
    { ...unit(4, 'K.m', [[12, 14]], 2), kind: 'method' },
  ];
  const clean1 = table(units());
  const broken2 = table(units(), [[5, 6]]);   // an unclosed paren inside f
  cache.put(oid('1'), 'm.py', clean1, lines);
  cache.put(oid('2'), 'm.py', broken2, lines);
  assert.deepEqual(cache.lastGood('m.py', [[5, 5]]), { ref: oid('1'), table: clean1 }, 'ref2 errs inside f: the older clean table');
  assert.deepEqual(cache.lastGood('m.py', [[13, 13]]), { ref: oid('2'), table: broken2 }, 'K has no error in ref2: the newest table');
  assert.deepEqual(cache.lastGood('m.py', [[19, 19]]), { ref: oid('2'), table: broken2 }, 'rows outside every unit: no error span there');

  // a newer clean table wins
  const clean3 = table(units());
  cache.put(oid('3'), 'm.py', clean3, lines);
  assert.deepEqual(cache.lastGood('m.py', [[5, 5]]), { ref: oid('3'), table: clean3 });

  // an error inside a member taints its class: the covering top-level unit is K
  const broken4 = table(units(), [[13, 13]]);
  cache.put(oid('4'), 'm.py', broken4, lines);
  assert.deepEqual(cache.lastGood('m.py', [[10, 10]]), { ref: oid('3'), table: clean3 });

  // no table without errors → null; a conflict-marker blob has no table at all
  cache.put(oid('5'), 'n.py', table([unit(1, 'f', [[3, 8]])], [[4, 4]]), lines);
  assert.equal(cache.lastGood('n.py', [[4, 4]]), null);
  cache.put(oid('6'), 'n.py', NO_MARKERS, lines);
  assert.equal(cache.lastGood('n.py', [[4, 4]]), null);
  assert.equal(cache.lastGood('never.py', [[1, 1]]), null);

  // an error span on the queried rows disqualifies a table even where no top-level unit covers those rows (04 §3.3 "Last-good
  // table": the rows in question must lie in no ERROR/MISSING span): p.py has f at rows 3-8 and an error at row 10, outside
  // every unit
  const pClean = table([unit(1, 'f', [[3, 8]])]);
  const pBroken = table([unit(1, 'f', [[3, 8]])], [[10, 10]]);
  cache.put(oid('7'), 'p.py', pClean, lines);
  cache.put(oid('8'), 'p.py', pBroken, lines);
  assert.deepEqual(cache.lastGood('p.py', [[10, 11]]), { ref: oid('7'), table: pClean }, 'no unit covers rows 10-11: the error span on row 10 still disqualifies');
  assert.deepEqual(cache.lastGood('p.py', [[7, 10]]), { ref: oid('7'), table: pClean }, 'f covers rows 7-8 only: the error on row 10 of the queried rows still disqualifies');
  assert.deepEqual(cache.lastGood('p.py', [[5, 5]]), { ref: oid('8'), table: pBroken }, 'f and the queried rows hold no error span: the newest table');
  assert.deepEqual(cache.lastGood('p.py', [[12, 14]]), { ref: oid('8'), table: pBroken }, 'rows outside every unit and every span');

  // an evicted table leaves the index
  const small = new TableCache(2_000);
  small.put(oid('1'), 'm.py', clean1, rowsOf(5, 10));
  small.put(oid('2'), 'z.py', NO_MARKERS, rowsOf(99, 10));
  assert.equal(small.lastGood('m.py', [[5, 5]]), null);
});
