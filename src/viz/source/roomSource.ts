// The room sources' contract (12 §3.3.1–§3.3.4, §3.3.6, §3.9.3): what the git source and the demo source give the store,
// the local overlay of one room and a demo caption record. Types only.
import type { FoldState } from '../../board/fold.js';
import type { PeerId } from '../../board/ids.js';
import type { PeerRef } from '../model/events.js';
import type { Frame } from '../model/frame.js';

export interface TipInfo { height: number; key: string; }                 // key: the board oid (git) or `${room}:${height}` (demo)
export type Advance = { kind: 'none' } | { kind: 'ff'; to: TipInfo } | { kind: 'rewrite'; to: TipInfo } | { kind: 'gone' };
export interface RoomSpec {
  id: string;                                     // ^r[0-9A-HJKMNP-TV-Z]{8}$
  kind: 'git' | 'demo';
  label: string; branch: string;                  // raw; the projection sanitizes and caps them
  gitDir: string | null;                          // absolute realpath, never served
  boardRef: string | null;                        // refs/cowork-remote/<enc(b)>/board
  canonicalRoot: string | null;                   // glossary §24 default 12; dedupe and room id only, never served
}
export interface RoomSource {
  readonly kind: 'git' | 'demo';
  /** The current tip, pinned: later frames()/startAt() calls of this tick read that oid, never the moving ref. null before genesis or when the ref vanished. */
  tip(): Promise<TipInfo | null>;
  /** git: a stat pair of the board ref's storage changed, or 60 s since the last rev-parse; demo: always false. */
  changed(): Promise<boolean>;
  /** Re-resolves and compares with the last folded tip (R-V31); pins the new tip. */
  advance(last: TipInfo): Promise<Advance>;
  /** initialFoldState(protocol of B0) at 0; parseFold(checkpoint at h) for h % 256 === 0 (git), or the demo's own fold state at h. */
  startAt(h: number): Promise<FoldState>;
  /** Frames of heights from…to (inclusive, oldest first) of the pinned tip, folded from `start` (the state at from − 1), batches ≤ 1,280. */
  frames(start: FoldState, from: number, to: number, self: PeerId): AsyncIterable<Frame>;
}
/** The local overlay of one room (12 §3.3.6), produced by status.ts's overlayOf; present only, never part of a timeline (VIZ-13). */
export interface Overlay {
  state: string; freezeReasons: string[]; publishPause: string | null; down: boolean; unreadable: boolean;
  offlineMin: number | null; holds: number; incoming: number; ready: number; you: PeerRef | null; versionSkew: boolean;
}
/** A demo caption record (12 §3.9.3); declared here (types only) so the projection need not import demo.ts; demo.ts re-exports it. */
export interface DemoCaption { room: string; height: number; code: string | null; text: string | null; }
