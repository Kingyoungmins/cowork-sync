// 04-regions §3.9 foldOverlap (REG-23, INV-REG-FOLD, INV-REG-NOVALID-OVERLAP). Task 1 declares OverlapClaim (type
// only, for the RegionJob union); Task 8 adds the pure foldOverlap.
import type { Granularity, Oid, Ranges } from './types.js';

export interface OverlapClaim { readonly granularity: Granularity; readonly anchorBlob: Oid | null; readonly ranges: Ranges; readonly tombstones: ReadonlyArray<{ readonly anchorBlob: Oid; readonly ranges: Ranges }>; }
