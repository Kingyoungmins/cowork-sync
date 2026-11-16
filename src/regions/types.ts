// Shared region types (04-regions §2, §3.1; REG-01, REG-35). Coordinates are 1-based inclusive stored-form
// rows; no type here carries a byte, character or UTF-16 offset (INV-REG-COORD).
// Worker modules take Oid and FileMode from here (ruling PF-12), never from src/git.
import type { Oid } from '../git/oid.js';
import type { FileMode } from '../git/repo.js';

export type { Oid } from '../git/oid.js';
export type { FileMode } from '../git/repo.js';

/** 04 §2: working bytes the daemon holds in memory; crosses IPC, a board op, a log line and status.json only as (path, oid); its bytes live only in SnapshotStore (INV-SECRET, REG-35). */
export interface DiskSnapshotId { readonly kind: 'disk'; readonly path: string; readonly oid: Oid; }
/** 04 §3.1 "stored blob oid | diskSnapshotId"; a DiskSnapshotId's oid is never read through cat-file (INV-REG-READ). */
export type BlobRef = Oid | DiskSnapshotId;

export function isDisk(r: BlobRef): r is DiskSnapshotId {
  return typeof r === 'object' && r !== null && r.kind === 'disk';
}

export function blobOid(r: BlobRef): Oid {
  return isDisk(r) ? r.oid : r;
}

/** 1-based inclusive stored-form rows (REG-01). */
export type Range = readonly [lo: number, hi: number];
/** Sorted, merged, closed intervals (04 §3.4 step 3's normal form). */
export type Ranges = readonly Range[];
/** 04 §3.1: a pure insertion after base line k has aLo = k+1, aHi = k; a pure deletion has bHi = bLo−1. */
export interface Hunk { readonly aLo: number; readonly aHi: number; readonly bLo: number; readonly bHi: number; }
export type MapResult = Ranges | 'TOMBSTONE' | 'WHOLE_FILE';   // REG-07
export type MapMode = 'fold' | 'local';
export type Language = 'python' | 'javascript' | 'typescript' | 'tsx' | 'c_sharp';
export type Granularity = 'symbol' | 'block' | 'file';
export type RegionUnitKind = 'function' | 'class' | 'method' | 'const' | 'type' | 'ctor' | 'dtor' | 'property' | 'indexer' | 'event' | 'field' | 'operator' | 'block' | 'file';
/** label-convention/1 (04 §3.3; REG-14): display, label counts, the group-name rule, the moved-code check and the identity sub-check only — never identity. */
export interface Label { readonly kind: string; readonly qualname: string; readonly simple: string; readonly type: string; readonly disc: string; }
export type LabelKey = string;   // kind + '\0' + qualname + '\0' + disc (R4-19)

export function labelKey(l: Label): LabelKey {
  return `${l.kind}\u{0}${l.qualname}\u{0}${l.disc}`;
}

/** 04 §3.10 "Signature slices" (REG-26).
 *  default (Task 7 contract addition): the default value's source text without whitespace, present only when the source gives one
 *  (a TS optional `x?` has hasDefault and no default); 04 §3.10 makes a default-value change a note, which hasDefault cannot show. */
export interface ParamSlice { readonly name: string; readonly kind: 'posonly' | 'pos' | 'kwonly' | 'varargs' | 'varkw' | 'rest' | 'plain' | 'ref' | 'out' | 'in' | 'params'; readonly hasDefault: boolean; readonly destructured: readonly string[] | null; readonly type: string | null; readonly default?: string; }
export type SigSlice =
  | { readonly lang: 'python'; readonly unit: 'function'; readonly params: readonly ParamSlice[]; readonly decorators: readonly string[]; readonly returns: string | null }
  | { readonly lang: 'python'; readonly unit: 'class'; readonly bases: readonly string[]; readonly methods: readonly string[]; readonly assignments: readonly string[] }
  | { readonly lang: 'python'; readonly unit: 'module'; readonly all: readonly string[] | null; readonly upperNames: readonly string[] }
  | { readonly lang: 'javascript' | 'typescript' | 'tsx'; readonly params: readonly ParamSlice[] | null; readonly exported: boolean; readonly exportName: string | null; readonly members: readonly string[] }
  | { readonly lang: 'c_sharp'; readonly isPrivate: boolean; readonly modifiers: readonly string[]; readonly returns: string | null; readonly params: readonly ParamSlice[]; readonly memberType: string | null; readonly overloadKey: string };
/** 04 §3.1 Unit; leaf units of one table are pairwise line-disjoint (INV-REG-PARTITION).
 *  Unit model (Task 4): a class/type/record/interface/enum contributes one non-leaf unit (its whole extent, leaf: false, residue: false) and one residue leaf unit
 *  (residue: true, parentUnitId = the non-leaf unit); members, functions, consts and gap blocks are leaf units whose parentUnitId is the enclosing class unit or null;
 *  C# namespaces and JS IIFE wrappers contribute no unit. Leaf units are the claimable ones and the ones INV-REG-PARTITION and BIG_UNITS count; the last-good
 *  lookup's "top-level unit" is the outermost unit (leaf or not) covering the rows. A Python module's __all__ / UPPER_CASE slice (SigSlice unit 'module') is carried
 *  by the const unit whose qualname is __all__ when the file has one; every UPPER_CASE module name is a const unit of its own (R4-19), so its removal is a unit removal. */
export interface Unit { readonly unitId: number; readonly kind: RegionUnitKind; readonly label: Label; readonly ranges: Ranges; readonly parentUnitId: number | null; readonly leaf: boolean; readonly residue: boolean; readonly sigSlice: SigSlice | null; readonly granularity: Granularity; }
/** 04 §3.1 RegionTable; a class-6 block table has grammar null and block units only. */
export interface RegionTable {
  readonly grammar: Language | null; readonly regionSpec: string; readonly decodable: boolean; readonly lineCount: number;
  readonly units: readonly Unit[]; readonly imports: Range | null;   // <imports> (04 §3.13), never claimed
  readonly errorSpans: Ranges; readonly errorCount: number; readonly labelCounts: Readonly<Record<LabelKey, number>>;
}
export type NoTableReason = 'conflict_markers' | 'binary' | 'special' | 'grammarless_small' | 'budget';
export interface NoTable { readonly kind: 'NO_TABLE'; readonly reason: NoTableReason; readonly lineCount: number | null; }
export type TableOrNone = RegionTable | NoTable;
export type PathClass = 1 | 2 | 3 | 4 | 5 | 6;
/** 04 §3.6: the reason touch reports. Declared here (Task 1) because the RegionJob union and Task 5's claim types need it before Task 6; src/regions/touch.ts re-exports it. */
export type TouchReason = 'base-overlap' | 'insert-inside' | 'boundary-in-extent' | 'boundary-in-error' | 'boundary-no-table' | 'group-name' | 'degraded-whole-file' | 'none';
/** 04 §3.1 "tree oids or in-memory tree views": a stored tree plus an in-memory overlay (M' = TIP with M[p] on the checked paths; an F10 result). */
export interface TreeView {
  readonly tree: Oid | null; readonly overlay: ReadonlyMap<string, BlobRef | 'ABSENT'>;
  entry(path: string): Promise<{ readonly blob: BlobRef; readonly mode: FileMode } | 'ABSENT'>;
}
