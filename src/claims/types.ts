// Claim types (glossary §3 claim view; 04 §2, §3.1, §3.7, §3.11) — Task 5. Types only until the store and the
// steps of Tasks 11–14 land: this module imports nothing but types, and src/claims sits after src/holds and
// before src/engine in X-110's one order.
import type { Json } from '../board/canonicalJson.js';
import type { ClaimGrant } from '../board/fold.js';
import type { PeerId } from '../board/ids.js';
import type { ClaimLabel } from '../board/ops.js';
import type { Oid } from '../git/oid.js';
import type { BlobRef, DiskSnapshotId, Granularity, Hunk, Label, Ranges, TouchReason } from '../regions/types.js';

/** A holder seat: seat = a seat_id (32 hex) or 'human'. */
export interface SeatKey { readonly peer: PeerId; readonly seat: string; }

export type ClaimSource =
  | { readonly kind: 'folded'; readonly anchor: Oid; readonly anchorBlob: Oid | null; readonly ranges: Ranges; readonly tombstones: ReadonlyArray<{ readonly anchor: Oid; readonly anchorBlob: Oid; readonly ranges: Ranges }> }
  | { readonly kind: 'tentative'; readonly srcBlob: BlobRef; readonly srcRanges: Ranges };

export interface ViewClaim {
  readonly claimId: string; readonly path: string; readonly holder: SeatKey & { readonly epoch: string; readonly agent: string };
  readonly granularity: Granularity; readonly label: ClaimLabel; readonly regionSpec: string; readonly csId: string; readonly source: ClaimSource;
  readonly order: { readonly tier: 0 | 1; readonly a: number; readonly b: number };   // claim order: tier 0 folded (height, line), tier 1 TENTATIVE (local seq, 0) (R4-29)
  readonly grant: ClaimGrant | null; readonly reservedForReq: string | null;
}

/** HELD non-STALE folded claims + this daemon's confirmed TENTATIVE claims in local order + active go-first grants (on the records). */
export interface ClaimView { readonly tip: Oid; readonly claims: readonly ViewClaim[]; }

export interface Draft { readonly claimId: string; readonly seat: SeatKey; readonly agent: string; readonly csId: string; readonly path: string; readonly srcBlob: BlobRef; readonly srcRanges: Ranges; readonly granularity: Granularity; readonly label: ClaimLabel; readonly confirmSeq: number; }
export interface TurnContext { readonly origin: 'prompt' | 'wake'; readonly firstConfirmedInTurn: ReadonlySet<string>; }

/** One confirmed tool effect (CONFIRM input): pre = the fence/TXN pre-image; post = one stable read; secondRead = the confirming read CONFIRM step 1 needs for an empty or > 50 % shorter post-image. */
export interface SeatEffect { readonly seat: string; readonly agent: string; readonly csId: string; readonly path: string; readonly pre: BlobRef | 'ABSENT'; readonly post: DiskSnapshotId | 'unstable' | 'ABSENT'; readonly secondRead?: DiskSnapshotId; readonly turn: TurnContext; readonly viewAtOpen?: ClaimView; }

export interface ConfirmResult { readonly status: 'confirmed' | 'deferred'; readonly hunksInBase: readonly Hunk[]; readonly touches: ReadonlyArray<{ readonly claimId: string; readonly holder: SeatKey; readonly reason: TouchReason }>; readonly drafts: readonly Draft[]; readonly notOwnContained: readonly Hunk[]; }

export type PredictTool = 'Edit' | 'MultiEdit' | 'Write' | 'NotebookEdit';
export interface PredictQuery { readonly seat: string; readonly agent: string; readonly tool: PredictTool; readonly input: Json; readonly path: string; readonly disk: DiskSnapshotId | 'unstable'; readonly viewBlob: BlobRef | null; readonly turn: TurnContext; }
export interface PredictResult {
  readonly status: 'located' | 'locate_failed' | 'undecided'; readonly diskLines: Ranges; readonly hunksInBase: readonly Hunk[];
  readonly touches: ReadonlyArray<{ readonly claimId: string; readonly reason: TouchReason }>;
  readonly moved: { readonly fromLabel: Label; readonly toLabel: Label | 'TOMBSTONE' } | null; readonly fallbackUsed: boolean;
  readonly ownTouches: ReadonlyArray<{ readonly claimId: string; readonly suspect: boolean; readonly granted: boolean }>; readonly ownContained: boolean;
}

/** reason 'claim_overlap': a CS that store.blockedBy names (an own claim op folded invalid by overlap, R4-28), reported by regionGate with no touching hunk. */
export interface GateBlocked { readonly csId: string; readonly claimId: string; readonly holder: SeatKey; readonly path: string; readonly reason: TouchReason | 'claim_overlap'; }
export interface GateAdmitted { readonly csId: string; readonly claimId: string; readonly path: string; }
export interface GateResult { readonly blocked: readonly GateBlocked[]; readonly admitted: readonly GateAdmitted[]; }

/** holdId (X-28; Task 15 fills it): the id of the K4 record this apply gave guard 'claim-breach' on path (D8 step 4's tie-break on the same rows), else null. */
export interface BreachHit { readonly claimId: string; readonly holder: SeatKey; readonly commit: Oid; readonly path: string; readonly baseMove: boolean; readonly holdId: string | null; }
export interface PlacementFailure { readonly path: string; readonly sub: 'a' | 'b'; readonly reason: 'label_mismatch' | 'tombstone' | 'whole_file' | 'fence'; readonly claimId: string | null; }
