// The pre-projection (model-typed) forms of the served payloads (12 §3.13 "(types)") and the api contract. Types only.
// RoomDelta and TimelinePageModel hold no overlay value (VIZ-13).
import type { PeerRec } from '../../board/fold.js';
import type { Card } from '../model/cards.js';
import type { PeerRef, SceneEvent, SeatRef } from '../model/events.js';
import type { Layout, LayoutDelta } from '../model/layout.js';
import type { LookTable } from '../model/looks.js';
import type { Scene } from '../model/scene.js';
import type { Overlay, RoomSpec } from '../source/roomSource.js';
import type { Strings, TimelinePage, World } from './viewModel.js';

export interface Tick { h: number; glyph: 'publish' | 'conflict' | 'request' | 'save' | 'door' | 'freeze'; }   // viewModel.ts declares an identical Tick (it imports nothing)
export type RoomBadge = 'UI_VIZ_VERSION_SKEW' | 'UI_VIZ_NEWER_PROTOCOL' | 'UI_VIZ_CHECKPOINT_MISMATCH' | 'UI_VIZ_INCIDENT_FROZEN' | 'UI_VIZ_NO_BOARD';
export interface PeerInfo { display: string; pluginVersion: string; status: PeerRec['status']; }
export interface CardModel { card: Card; foldedAt: number | null; }   // foldedAt: the seen anchor of its height — tick()'s fast-forward folds only (R-V28)
export interface PetInfo { owner: PeerRef; live: boolean; ssCode: string | null; variant: number; }
export interface RoomDelta {
  roomId: string; kind: 'timeline' | 'snapshot'; window: { h0: number; h1: number };
  events: SceneEvent[]; cards: CardModel[]; ticks: Tick[]; layout: LayoutDelta | null;
  peers: Map<PeerRef, PeerInfo>; pets: Map<SeatRef, PetInfo>;     // new or changed only
  scene: Scene | null;                                              // snapshot only: the scene at the new tip
}
export interface TimelinePageModel { roomId: string; from: number; to: number; scene: Scene; events: SceneEvent[]; cards: CardModel[]; layout: LayoutDelta | null; }
export interface RoomSnapshotModel {
  spec: RoomSpec; window: { h0: number; h1: number }; gone: boolean; badges: RoomBadge[]; unknown: number;
  layout: Layout; looks: LookTable; peers: Map<PeerRef, PeerInfo>; pets: Map<SeatRef, PetInfo>;
  scene: Scene; cards: CardModel[]; ticks: Tick[]; overlay: Overlay | null;
}
/** What the api and the poll loop need of a room store (RoomStore implements it; Tasks 9 and 17 use fakes). */
export interface StoreLike {
  readonly ready: Promise<void>;
  snapshot(): RoomSnapshotModel;
  page(from: number, to: number): Promise<TimelinePageModel | null>;
  earlier(): Promise<TimelinePageModel | null>;
  tick(): Promise<{ delta: RoomDelta | null; overlay: Overlay | null; change: 'state' | 'rebuilt' | null }>;   // a fake returns three nulls
}
export interface PollSink { delta(d: RoomDelta): void; overlay(roomId: string, o: Overlay): void; roomChanged(roomId: string): void; reset(): void; }
/** The routes' data contract: implemented by api.ts (Task 9), consumed by http.ts (Task 10) and main.ts (Task 15). */
export interface WorldApi {
  world(): Promise<World>;                          // waits for every store's ready; recomputed at most once per 2.5 s whatever the number of tabs
  /** null → 404; from < h0 extends one segment (R-V29, the store's earlier()); when the page appended desks, publishes {type: 'layout', room_id, layout}
   *  on the hub before returning (R-V49). */
  page(roomId: string, from: number, to: number): Promise<TimelinePage | null>;
  strings(lang: string): Strings | null;            // the six codes → { lang: 'en', templates } of PAGE_CODES (R-V15); else null → 404
}
