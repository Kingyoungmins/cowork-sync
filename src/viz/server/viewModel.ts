// Every served JSON shape (12 §3.10.6, the allowlist); field names are the wire names. Types only, and imports nothing:
// this file is in the page's client program (R-V35). The Projected forms are written out field by field (R-V26) with
// R-V22 (handles of 6–32 characters), R-V23 (at: Pos), R-V25 (position-typed recency), R-V43 (closed code sets),
// R-V47 (pet owners) and R-V51 (Desk.first) applied. Every named alias becomes a schema `pattern` (R-V27).
//
// Projection rule: an EventVM, SceneVM or CardVM is the 12 §3.3.7 SceneEvent, Scene or Card with every PeerRef replaced by
// its handle, every SeatRef by its seat handle, every hold and claim id by its short id, Position by Pos, Maps by
// [key, value] arrays in ascending key order, and every string through §3.10.7; nothing else is added or renamed.

export type Handle = string;                    // ^[0-9a-f]{6,32}$ — a peer (6 unless extended by R-V22)
export type SeatHandle = string;                // ^[0-9A-HJKMNP-TV-Z]{6,32}$
export type ShortId = string;                   // ^[0-9A-Za-z]{8,32}$ — a hold or claim id prefix (R-V22)
export type RoomId = string;                    // ^r[0-9A-HJKMNP-TV-Z]{8}$
export type Code = string;                      // ^[A-Z][A-Z0-9_]{2,47}$ — a code in its field's closed set (R-V43)
export type ReasonVM = string;                  // ^([A-Z][A-Z0-9_]{2,47}|\?)$ — a closed-set code, or '?' for a non-nullable field out of its set (R-V43)
export type Cid = string;                       // ^[0-9A-HJKMNP-TV-Z]{8}$ — glossary §3 H(…)
export type ReqId = string;                     // ^R[0-9A-HJKMNP-TV-Z]{8}$ — a request display id
export type CardId = string;                    // "<height>.<sub>.<k>"
export type Hex64 = string;                     // ^[0-9a-f]{64}$
export type InstanceId = string;                // ^[0-9A-HJKMNP-TV-Z]{8}$
export type DisplayId = string;                 // ^[0-9A-Za-z]{8,32}$ — a card's display id: R…, C<cid>, or a hold id's short id (12 §3.8)
export type TemplateText = string;              // ^[^<>\p{Cc}]{1,400}$ — a template of the en catalog (R-V58)
export type ParamName = string;                 // ^[a-z][a-z0-9_]{0,31}$ — a template parameter's name
export type ActorVM = { peer: Handle } | { seat: SeatHandle };
export type Pos = [height: number, sub: number, k: number];
export type LineVM = { actor: ActorVM } | { claimId: ShortId };
export type EventVM = { at: Pos; seed: number } & (
  | { kind: 'room_open' } | { kind: 'room_sign'; sign: 'branch_moved' } | { kind: 'room_badge'; level: 'none' | 'near_full' | 'full' }
  | { kind: 'person_enter' | 'person_respawn' | 'person_exit' | 'person_thaw' | 'person_absent' | 'person_ghost' | 'person_unghost'; peer: Handle }
  | { kind: 'person_freeze'; peer: Handle; reasonCode: ReasonVM } | { kind: 'person_slowed'; peer: Handle; until: number }
  | { kind: 'person_bang'; peer: Handle; bang: 'host' }
  | { kind: 'person_badge'; actor: ActorVM; badge: 'version' | 'rules' | 'credit' | 'health'; on: boolean; code: Code | null }
  | { kind: 'pet_spawn' | 'pet_poof'; seat: SeatHandle; owner: Handle } | { kind: 'pose_relaxed'; actor: ActorVM }
  | { kind: 'publish'; actor: ActorVM; target: number; others: number[]; paths: string[]; n: number;     // paths: the R-V50 prefix; n unchanged
      state: 'closed' | 'checkpoint'; checks: 'pass' | 'fail' | 'skipped'; origin: 'prompt' | 'wake' | 'human' }
  | { kind: 'conflict'; conflict: 'k4' | 'claim' | 'k7' | 'breach' | 'generic'; source: 'hold' | 'event'; on: ActorVM; desk: number | null;
      holdId: ShortId | null; cid: Cid | null; eventKind: string | null; line: LineVM | null }
  | { kind: 'box'; holdId: ShortId; owner: ActorVM; holdKind: string; residence: string; state: string; offer: string; desk: number; localOnly: boolean; terminal: boolean }
  | { kind: 'claim_take' | 'claim_move'; claimId: ShortId; seat: SeatHandle; desk: number; order: number;
      label: { simple: string; qualname: string } | null; granularity: 'symbol' | 'block' | 'file'; lines: [number, number] | null; otherRules: boolean }
  | { kind: 'claim_stale'; claimId: ShortId }
  | { kind: 'claim_release'; claimId: ShortId; reason: 'explicit' | 'answer' | 'save' | 'seat_end' | 'stop' | 'reservation_transfer' | 'superseded' }
  | { kind: 'claim_reserve'; claimId: ShortId; request: ReqId; requester: ActorVM }
  | { kind: 'grant_start' | 'grant_end'; claimId: ShortId; grantee: ActorVM }
  | { kind: 'request_open'; request: ReqId; from: ActorVM; holder: ActorVM; desk: number; requestKind: 'handoff' | 'go_first'; estMinutes: number | null; attempt: number; note: string | null }
  | { kind: 'request_status'; request: ReqId; holder: ActorVM; status: 'asked' | 'queued_until_turn_end' | 'awaiting_human' | 'undeliverable' | 'returned' }
  | { kind: 'answer'; request: ReqId; holder: ActorVM; verb: 'accept' | 'grant' | 'decline' | 'later' | 'release'; by: 'claude' | 'human' | 'daemon'; note: string | null }
  | { kind: 'note'; actor: ActorVM; target: { request: ReqId } | { claimId: ShortId } | null; text: string }
  | { kind: 'save'; peer: Handle; desks: number[] }
);
export type PlaceVM = { at: 'home'; spot: number } | { at: 'chair' | 'stool' | 'beside'; desk: number } | { at: 'visitor'; desk: number; tile: number }
  | { at: 'facing'; actor: ActorVM; desk: number } | { at: 'behind'; peer: Handle };
export interface ActorStateVM { place: PlaceVM; pose: 'idle' | 'sit' | 'relaxed'; lastPublish: Pos | null; lastDesk: number | null; lastClaimOp: Pos | null; }
export interface SceneVM {
  at: Pos; badge: 'none' | 'near_full' | 'full'; branchMovedAt: number | null;
  characters: Array<[Handle, ActorStateVM & { ghost: boolean; absent: boolean; frozen: ReasonVM | null; slowedUntil: number | null; rules: boolean; credit: boolean }]>;
  pets: Array<[SeatHandle, ActorStateVM & { owner: Handle; variant: number; live: boolean; ssCode: Code | null }]>;
  desks: Array<[number, { lastEvent: number | null; chair: ActorVM | null; visitors: ActorVM[]; more: number; claims: ShortId[] }]>;
  claims: Array<[ShortId, { seat: SeatHandle; desk: number; order: number; label: { simple: string; qualname: string } | null; granularity: 'symbol' | 'block' | 'file';
                            lines: [number, number] | null; stale: boolean; reservedFor: ReqId | null; grantee: ActorVM | null; otherRules: boolean;
                            at: Pos }]>;   // at: ClaimState.at, the position of the claim's newest claim_take or claim_move (R-V73)
  requests: Array<[ReqId, { from: ActorVM; holder: ActorVM; desk: number; status: string | null }]>;
  boxes: Array<[ShortId, { owner: ActorVM; desk: number; holdKind: string; residence: string; state: string; localOnly: boolean }]>;
  bangs: Array<[ShortId, { on: ActorVM; desk: number | null }]>;
  beat: EventVM[];
}
export interface CardVM { id: CardId; at: Pos; group: 'conversation' | 'activity' | 'conflict' | 'system'; code: Code; actor: ActorVM | null; target: ActorVM | null;
                          paths: string[]; n: number; desks: number[]; displayId: DisplayId | null; parent: ReqId | null; label: string | null; text: string | null;
                          detail: ReasonVM | null; seen_ms: number | null; }
export interface Session { session: Hex64; instance: InstanceId; }                                   // POST /api/v1/session
/** Ruling R-V58: src/i18n/render.ts's CatalogEntry written out (this file imports nothing), so plural forms and parameter types travel
 *  to the page. */
export interface CatalogEntryVM {
  text: TemplateText;
  params?: Record<string, 'name' | 'path' | 'label' | 'id' | 'n' | 'dur' | 'cmd' | 'reason' | 'note' | 'code' | 'text' | 'url'>;
  plural?: ParamName;
  forms?: { zero?: TemplateText; one?: TemplateText; two?: TemplateText; few?: TemplateText; many?: TemplateText; other?: TemplateText };
}
export interface Strings { lang: 'en' | 'ko' | 'zh-CN' | 'ja' | 'fr' | 'es'; templates: Record<string, CatalogEntryVM>; }   // code → its en entry (R-V15, R-V58)
export interface World { v: 1; cursor: number; demo: boolean; rooms: RoomVM[]; captions: CaptionVM[]; }
export interface RoomVM {
  room_id: RoomId; label: string; branch: string; gone: boolean; badges: Code[]; unknown: number;
  window: { h0: number; h1: number }; overlay: OverlayVM | null;          // overlay: null in demo mode
  layout: LayoutVM; looks: Array<[Handle, { hue: number; accessory: number }]>;
  characters: CharacterVM[]; pets: PetVM[]; scene: SceneVM; cards: CardVM[]; ticks: Tick[];   // scene: at the last position of h1; cards: the last ≤ 200, ascending
}
export interface OverlayVM { state: string; freeze_reasons: Code[]; publish_pause: Code | null; down: boolean; unreadable: boolean;
                             offline_min: number | null; holds: number; incoming: number; ready: number; you: Handle | null; }   // state: a STATUS_STATES value (SERVED_STRING_FIELDS 'enum')
export interface CharacterVM { handle: Handle; name: string; hue: number; accessory: number; ph: Code | null; version: string; badges: Code[]; }
export interface PetVM { seat: SeatHandle; owner: Handle; live: boolean; ss: Code | null; variant: number; }
export interface LayoutVM { version: number; zones: Array<{ index: number; sign: string; cells: number[] }>;
                            desks: Array<{ ordinal: number; kind: 'big_table' | 'file' | 'folder' | 'shelf'; zone: number | null; cell: number | null;
                                           slot: number | null; plaque: string | null; path: string | null; lockbox: boolean; first: number }>;   // first: R-V51
                            homeOrder: Handle[]; }
export interface LayoutDeltaVM { from_version: number; version: number; zones: LayoutVM['zones']; desks: LayoutVM['desks']; homeOrder: Handle[]; }   // zones: new or grown; desks, homeOrder: new only
export interface CaptionVM { room_id: RoomId; height: number; code: Code | null; text: string | null; }
export interface Tick { h: number; glyph: 'publish' | 'conflict' | 'request' | 'save' | 'door' | 'freeze'; }
export interface TimelinePage { room_id: RoomId; from: number; to: number; scene: SceneVM; events: EventVM[]; cards: CardVM[]; layout: LayoutDeltaVM | null; }   // to as clipped
export type StreamPayload =                     // the SSE `event:` name is `type`; `data:` is the JSON object
  | { type: 'timeline'; room_id: RoomId; h1: number; events: EventVM[]; cards: CardVM[]; ticks: Tick[]; characters: CharacterVM[]; pets: PetVM[] }   // characters, pets: new or changed only
  | { type: 'room_snapshot'; room_id: RoomId; window: { h0: number; h1: number }; scene: SceneVM; cards: CardVM[]; ticks: Tick[]; characters: CharacterVM[]; pets: PetVM[] }
  | { type: 'layout'; room_id: RoomId; layout: LayoutDeltaVM }
  | { type: 'overlay'; room_id: RoomId; overlay: OverlayVM }
  | { type: 'room'; room_id: RoomId; change: 'added' | 'gone' | 'state'; label: string; branch: string; gone: boolean; badges: Code[]; unknown: number }
  | { type: 'reset' } | { type: 'bye' };
