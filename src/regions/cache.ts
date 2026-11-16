// TableCache (04-regions §3.3 "Cache", "Last-good table"; §3.18 "Table cache", "Pinned draft post-images"; REG-18, REG-35;
// ruling R4-14): the main thread's one cache of line arrays and region tables, an LRU by blobRef with a byte cap (300 MB in
// production). A DiskSnapshotId that a claim draft references is pinned — its line array and tables are never evicted
// while pinned and still count toward the cap, because no object exists to re-read them from (glossary §26 W6). The
// cache also indexes tables by path in put order for REG-18's last-good table; a last-good lookup reads only cached
// tables (a miss never parses an older blob). Parse trees live in the workers, never here.
import { BUDGETS } from './budgets.js';
import { normalizeRanges, rangesIntersect } from './lines.js';
import { isDisk, type BlobRef, type DiskSnapshotId, type Ranges, type RegionTable, type TableOrNone } from './types.js';

/** R4-14's per-unit estimate: an entry's size is its line-array bytes plus UNIT_COST_BYTES per unit. */
export const UNIT_COST_BYTES = 256;

/** One blob: its line array once, and its table under each path it was built for (the path decides the language and class). */
interface Entry {
  readonly ref: BlobRef;
  lines: readonly Buffer[];
  readonly tables: Map<string, TableOrNone>;
  size: number;
}

/** A stored oid is its own key; a DiskSnapshotId is (path, oid), as SnapshotStore keys it. */
function keyOf(ref: BlobRef): string {
  return isDisk(ref) ? `disk\u{0}${ref.path}\u{0}${ref.oid}` : ref;
}

function linesBytes(lines: readonly Buffer[]): number {
  let n = 0;
  for (const r of lines) n += r.length;
  return n;
}

function unitsOf(t: TableOrNone): number {
  return 'units' in t ? t.units.length : 0;
}

export class TableCache {
  private readonly maxBytes: number;
  /** Insertion order is recency: the first entry is the least recently used. */
  private readonly entries = new Map<string, Entry>();
  /** blobRef key → the owners pinning it (a pin may come before the put). */
  private readonly pins = new Map<string, Set<string>>();
  /** owner → the blobRef keys it pins. */
  private readonly owners = new Map<string, Set<string>>();
  /** path → blobRef key → put sequence (the last-good index; larger is newer). */
  private readonly byPath = new Map<string, Map<string, number>>();
  private seq = 0;
  private total = 0;

  /** maxBytes defaults to BUDGETS.cacheBytes (300 MB, glossary §20 "Parse"). */
  constructor(maxBytes: number = BUDGETS.cacheBytes) {
    if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new RangeError(`TableCache: maxBytes must be a finite number >= 0, got ${maxBytes}`);
    this.maxBytes = maxBytes;
  }

  get(ref: BlobRef, path: string): TableOrNone | undefined {
    const e = this.touch(keyOf(ref));
    return e?.tables.get(path);
  }

  /** Caches t as the table of ref under path, with ref's line array; then evicts least-recently-used unpinned entries other than
   *  this one while the cache is over its cap (a put always keeps its own entry; pinned entries are never evicted). */
  put(ref: BlobRef, path: string, t: TableOrNone, lines: readonly Buffer[]): void {
    const key = keyOf(ref);
    let e = this.touch(key);
    if (e === undefined) {
      e = { ref, lines, tables: new Map(), size: 0 };
      this.entries.set(key, e);
    }
    e.lines = lines;
    e.tables.set(path, t);
    this.resize(e);
    let index = this.byPath.get(path);
    if (index === undefined) {
      index = new Map();
      this.byPath.set(path, index);
    }
    index.set(key, ++this.seq);
    this.evict(key);
  }

  lines(ref: BlobRef): readonly Buffer[] | undefined {
    return this.touch(keyOf(ref))?.lines;
  }

  /** REG-18: the newest cached table of path whose top-level unit covering `lines` has no ERROR/MISSING span; null when none.
   *  The top-level units covering the rows are the units without a parent whose ranges intersect them (a class's non-leaf
   *  unit for a member's rows); a table qualifies only when no error span touches those units or the queried rows
   *  themselves (rows no unit covers included). NO_TABLE entries (a conflict-marker blob, a budget overrun) are never
   *  last-good. */
  lastGood(path: string, lines: Ranges): { readonly ref: BlobRef; readonly table: RegionTable } | null {
    const index = this.byPath.get(path);
    if (index === undefined) return null;
    const newestFirst = [...index].sort((a, b) => b[1] - a[1]);
    for (const [key] of newestFirst) {
      const e = this.entries.get(key);
      const t = e?.tables.get(path);
      if (e === undefined || t === undefined || !('units' in t)) continue;
      const covering = t.units.filter((u) => u.parentUnitId === null && rangesIntersect(u.ranges, lines));
      const rows = normalizeRanges([...lines, ...covering.flatMap((u) => u.ranges)]);
      if (!rangesIntersect(rows, t.errorSpans)) return { ref: e.ref, table: t };
    }
    return null;
  }

  /** Never evicted while pinned; counts toward maxBytes. */
  pin(ref: DiskSnapshotId, owner: string): void {
    const key = keyOf(ref);
    let by = this.pins.get(key);
    if (by === undefined) {
      by = new Set();
      this.pins.set(key, by);
    }
    by.add(owner);
    let keys = this.owners.get(owner);
    if (keys === undefined) {
      keys = new Set();
      this.owners.set(owner, keys);
    }
    keys.add(key);
  }

  /** Releases every pin of owner; an entry no owner pins any more becomes evictable at once. */
  unpin(owner: string): void {
    const keys = this.owners.get(owner);
    if (keys === undefined) return;
    this.owners.delete(owner);
    for (const key of keys) {
      const by = this.pins.get(key);
      by?.delete(owner);
      if (by !== undefined && by.size === 0) this.pins.delete(key);
    }
    this.evict(null);
  }

  /** The size of every cached entry, pinned ones included. */
  get bytes(): number {
    return this.total;
  }

  private touch(key: string): Entry | undefined {
    const e = this.entries.get(key);
    if (e !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, e);
    }
    return e;
  }

  private resize(e: Entry): void {
    let units = 0;
    for (const t of e.tables.values()) units += unitsOf(t);
    const size = linesBytes(e.lines) + UNIT_COST_BYTES * units;
    this.total += size - e.size;
    e.size = size;
  }

  private evict(keep: string | null): void {
    if (this.total <= this.maxBytes) return;
    for (const [key, e] of [...this.entries]) {
      if (this.total <= this.maxBytes) return;
      if (key === keep || this.pins.has(key)) continue;
      this.entries.delete(key);
      this.total -= e.size;
      for (const path of e.tables.keys()) {
        const index = this.byPath.get(path);
        index?.delete(key);
        if (index !== undefined && index.size === 0) this.byPath.delete(path);
      }
    }
  }
}
