// RegionService (04-regions §3.1, the main-thread side; REG-02, REG-05, REG-06, REG-31, REG-35, INV-REG-READ): blob and table
// reads for the region module. Stored blobs are read only through the cat-file --batch reader (oids the engine wrote) and a
// DiskSnapshotId only from SnapshotStore (its oid is never read through git); a missing object degrades by P2 (NO_TABLE{budget},
// one REGION_OBJECT_MISSING log line). Tables are built in the worker pool (class 4: a parse within BUDGETS.parseMs; class 6:
// the block table) and cached by blobRef in TableCache; classes 1, 2, 3 and 5 are NO_TABLE{reason} without a job. The service
// runs only git's read commands (cat-file, ls-tree, check-attr through the attribute snapshot) and writes nothing.
// Task 5 adds hunks and mapRanges over Task 3's job handlers.
import type { AttrSnapshot } from '../data/attrs.js';
import type { GitRepo } from '../git/repo.js';
import type { Clock } from '../ports/clock.js';
import type { Log } from '../ports/log.js';
import type { RegionBudgets } from './budgets.js';
import type { TableCache } from './cache.js';
import type { REGION_LOG_ONLY_CODES } from './codes.js';
import { lineArray } from './lines.js';
import { D_CAP, editDistance } from './mapper.js';
import { pathClassOf, type PathFacts } from './pathClass.js';
import type { RegionWorkers, WorkerPriority } from './pool.js';
import { SnapshotGoneError, type SnapshotStore } from './snapshots.js';
import { isDisk, type BlobRef, type FileMode, type Hunk, type Language, type MapMode, type MapResult, type NoTable, type NoTableReason, type Oid, type Ranges, type TableOrNone, type TreeView } from './types.js';

export interface RegionServiceDeps {
  repo: GitRepo; workers: RegionWorkers; budgets: RegionBudgets; cache: TableCache; snapshots: SnapshotStore;
  regionSpec: string; log: Log; clock: Clock;
  attrs(epochBase: Oid, paths: readonly string[]): Promise<AttrSnapshot>;   // Plan 2 AttrCache at EPOCH_BASE
  privateIndex: string;                                                      // GIT_INDEX_FILE of the partial-type grep (R4-45)
  onBudget(path: string, budget: 'parse' | 'map' | 'grep' | 't0' | 'gate'): void;   // → raiseRegionCode('REGION_BUDGET'), deduplicated there
}

/** 04 §6 "Region read of an oid missing from the object store": the log-only registry code (V-17). */
const OBJECT_MISSING: (typeof REGION_LOG_ONLY_CODES)[number] = 'REGION_OBJECT_MISSING';

const noTable = (reason: NoTableReason, lineCount: number | null): NoTable => Object.freeze({ kind: 'NO_TABLE', reason, lineCount });

/** True when no attribute, mode or the notebook extension can put the path in class 2 or 3: then the path's table depends on
 *  its bytes and extension only, and a cached table of (blobRef, path) stays right whatever EPOCH_BASE is asked. */
function plainFacts(path: string, f: PathFacts): boolean {
  const a = f.attrs;
  return f.mode !== '120000' && f.mode !== '160000' && !a.binary && a.text !== 'unset' && a.filter === null && a.workingTreeEncoding === null
    && !/\.ipynb$/iu.test(path);
}

export class RegionService {
  readonly deps: RegionServiceDeps;

  constructor(d: RegionServiceDeps) {
    this.deps = d;
  }

  /** A stored blob by the cat-file --batch reader (only oids in the object store), a DiskSnapshotId from SnapshotStore; a missing
   *  object → 'MISSING' and one daemon-log line REGION_OBJECT_MISSING {oid, path} (log-only, V-17; {oid} without a path); a
   *  released DiskSnapshotId is 'MISSING' too, unless its pinned line array is still cached (REG-35: callers degrade like
   *  NO_TABLE{budget}, mapping WHOLE_FILE). */
  async bytes(ref: BlobRef, path?: string): Promise<Buffer | 'MISSING'> {
    if (isDisk(ref)) {
      try {
        return this.deps.snapshots.bytes(ref);
      } catch (e) {
        if (!(e instanceof SnapshotGoneError)) throw e;
        const cached = this.deps.cache.lines(ref);
        return cached === undefined ? 'MISSING' : Buffer.concat(cached);
      }
    }
    try {
      return (await this.deps.repo.readBlobs([ref]))[0] as Buffer;
    } catch (e) {
      // classified by git's exit status (cat-file -t), never by the text of the failure
      if (await this.deps.repo.hasObject(ref, 'blob')) throw e;
      this.deps.log.write('warn', OBJECT_MISSING, path === undefined ? { oid: ref } : { oid: ref, path });
      return 'MISSING';
    }
  }

  async lines(ref: BlobRef, path?: string): Promise<readonly Buffer[] | 'MISSING'> {
    const cached = this.deps.cache.lines(ref);
    if (cached !== undefined) return cached;
    const b = await this.bytes(ref, path);
    return b === 'MISSING' ? b : lineArray(b);
  }

  /** REG-05/REG-06: path class, then the worker parse (class 4) or the block table (class 6); NO_TABLE{reason} for classes 1–3 and 5;
   *  an overrun, a crash or a missing object → NO_TABLE{budget} (an overrun or a crash also calls onBudget(path, 'parse'), a
   *  missing object writes its log line); cached by blobRef (never a NO_TABLE{budget}). The mode defaults to 100644. */
  async table(ref: BlobRef, path: string, o: { epochBase: Oid; mode?: FileMode; priority?: WorkerPriority; prevRef?: BlobRef }): Promise<TableOrNone> {
    const facts: PathFacts = { mode: o.mode ?? '100644', attrs: (await this.deps.attrs(o.epochBase, [path])).get(path) };
    const cacheable = plainFacts(path, facts);
    if (cacheable) {
      const hit = this.deps.cache.get(ref, path);
      if (hit !== undefined) return hit;
    }
    const cachedLines = this.deps.cache.lines(ref);
    const bytes = cachedLines !== undefined ? Buffer.concat(cachedLines) : await this.bytes(ref, path);
    if (bytes === 'MISSING') return noTable('budget', null);
    const lines = cachedLines ?? lineArray(bytes);
    const available = this.availability();
    const v = pathClassOf(path, bytes, facts, (l: Language) => available.get(l) === 'ok');
    let t: TableOrNone;
    if (v.cls === 4 || v.cls === 6) {
      const r = await this.deps.workers.run(
        { kind: 'table', lang: v.lang, cls: v.cls, ref, bytes, regionSpec: this.deps.regionSpec, prevRef: o.prevRef ?? null },
        o.priority ?? 'fg', this.deps.budgets.deadline('parse'));
      if (r.kind !== 'ok' || ('kind' in r.value && r.value.reason === 'budget')) {
        this.deps.onBudget(path, 'parse');
        return noTable('budget', lines.length);
      }
      t = r.value;
    } else {
      t = noTable(v.cls === 1 ? 'conflict_markers' : v.cls === 2 ? 'binary' : v.cls === 3 ? 'special' : 'grammarless_small', lines.length);
    }
    if (cacheable) this.deps.cache.put(ref, path, t, lines);
    return t;
  }

  /** A stored tree (read by ls-tree) with in-memory entries on top: an overlay entry wins, 'ABSENT' removes the path; an overlay
   *  blob keeps the stored entry's mode (100644 for a path the tree lacks). */
  view(tree: Oid | null, overlay: ReadonlyMap<string, BlobRef | 'ABSENT'> = new Map()): TreeView {
    const repo = this.deps.repo;
    const stored = async (path: string): Promise<{ readonly blob: BlobRef; readonly mode: FileMode } | 'ABSENT'> => {
      if (tree === null) return 'ABSENT';
      const e = (await repo.readTreeMap(tree)).get(path);
      return e === undefined ? 'ABSENT' : { blob: e.oid, mode: e.mode };
    };
    return Object.freeze({
      tree,
      overlay,
      async entry(path: string): Promise<{ readonly blob: BlobRef; readonly mode: FileMode } | 'ABSENT'> {
        const o = overlay.get(path);
        if (o === undefined) return stored(path);
        if (o === 'ABSENT') return 'ABSENT';
        const s = await stored(path);
        return { blob: o, mode: s === 'ABSENT' ? '100644' : s.mode };
      },
    });
  }

  availability(): ReadonlyMap<Language, 'ok' | 'unavailable'> {
    return this.deps.workers.availability();
  }

  // ---- Plan 4 Task 5 (R4-17, Tasks 9–15 consume both): FoldMapper/1 over blobRefs, in a worker ----

  /** FoldMapper/1 hunks(from, to) of two blobRefs (an 'ABSENT' side is the empty file), run in a worker at full D.
   *  A missing object → 'WHOLE_FILE' (REG-35: the caller degrades whole). No cache: pairs of large blobs are rarely repeated. */
  async hunks(from: BlobRef | 'ABSENT', to: BlobRef | 'ABSENT'): Promise<Hunk[] | 'WHOLE_FILE'> {
    const fb: readonly Buffer[] | 'MISSING' = from === 'ABSENT' ? [] : await this.lines(from);
    const tb: readonly Buffer[] | 'MISSING' = to === 'ABSENT' ? [] : await this.lines(to);
    if (fb === 'MISSING' || tb === 'MISSING') return 'WHOLE_FILE';
    const r = await this.deps.workers.run({ kind: 'hunks', from: fb, to: tb }, 'fg', this.deps.budgets.deadline('map'));
    if (r.kind !== 'ok') {
      this.deps.onBudget('', 'map');   // no path: a caller without one (the engine passes the path when it has it)
      return 'WHOLE_FILE';
    }
    return r.value;
  }

  /** 04 §3.1 mapRanges(fromBlob, toBlob, ranges, mode) in a worker; local mode carries the BUDGETS.mapLocalMs deadline
   *  (the one 200 ms cap); a missing blob → 'WHOLE_FILE'. path (optional) attributes a local-mode overrun's
   *  REGION_BUDGET {path, budget: 'map'} through onBudget — without it no code is raised. */
  async mapRanges(from: BlobRef, to: BlobRef, ranges: Ranges, mode: 'fold', path?: string): Promise<MapResult>;
  async mapRanges(from: BlobRef, to: BlobRef, ranges: Ranges, mode: 'local', path?: string): Promise<MapResult>;
  async mapRanges(from: BlobRef, to: BlobRef, ranges: Ranges, mode: MapMode, path?: string): Promise<MapResult> {
    const fb = await this.lines(from);
    const tb = await this.lines(to);
    if (fb === 'MISSING' || tb === 'MISSING') return 'WHOLE_FILE';
    const r = await this.deps.workers.run({ kind: 'map', from: fb, to: tb, ranges, mode }, 'fg', mode === 'local' ? this.deps.budgets.deadline('map') : this.deps.budgets.deadline('map'));
    if (r.kind !== 'ok') {
      this.deps.onBudget(path ?? '', 'map');
      return 'WHOLE_FILE';
    }
    return r.value;
  }
}
