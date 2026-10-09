// The closed set of scene events (12 §3.3.7 and §3.4) and their references. Actors are named by board-public ids (peer_id,
// seat key), never by handle or oid; handles exist only in the view model (§3.10.6). Pure and import-free: this file is
// part of the page's client program (R-V35).

export type PeerRef = string;                          // peer_id (32 lowercase hex)
export type SeatRef = string;                          // seat key "<peer>/<epoch>/<seat_id>"
export type ActorRef = { peer: PeerRef } | { seat: SeatRef };
export type DeskRef = number;                          // desk ordinal (§3.5.3); 0 = the big table
export interface Position { height: number; sub: number; k: number; }
export type Line = { actor: ActorRef } | { claimId: string };   // the target of a conflict's dotted or dashed line
export type SceneEvent = Position & { seed: number } & (
  | { kind: 'room_open' }
  | { kind: 'room_sign'; sign: 'branch_moved' }
  | { kind: 'room_badge'; level: 'none' | 'near_full' | 'full' }
  | { kind: 'person_enter' | 'person_respawn' | 'person_exit' | 'person_thaw' | 'person_absent' | 'person_ghost' | 'person_unghost'; peer: PeerRef }
  | { kind: 'person_freeze'; peer: PeerRef; reasonCode: string }
  | { kind: 'person_slowed'; peer: PeerRef; until: number }
  | { kind: 'person_bang'; peer: PeerRef; bang: 'host' }
  // version: one pop; rules, credit: on/off with the PeerRec; health: one pop for a character, an SS_* label kept on a pet
  // until that seat's next health event or pet_poof (event-sourced badges never persist, §3.7 exclaim rule)
  | { kind: 'person_badge'; actor: ActorRef; badge: 'version' | 'rules' | 'credit' | 'health'; on: boolean; code: string | null }
  | { kind: 'pet_spawn' | 'pet_poof'; seat: SeatRef; owner: PeerRef }   // R-V47: the reducer never parses a seat id
  | { kind: 'pose_relaxed'; actor: ActorRef }
  | { kind: 'publish'; actor: ActorRef; target: DeskRef; others: DeskRef[]; paths: string[]; n: number;   // paths: [] at the big table; n = the trailer's paths count
      state: 'closed' | 'checkpoint'; checks: 'pass' | 'fail' | 'skipped'; origin: 'prompt' | 'wake' | 'human' }
  | { kind: 'conflict'; conflict: 'k4' | 'claim' | 'k7' | 'breach' | 'generic'; source: 'hold' | 'event';
      on: ActorRef; desk: DeskRef | null; holdId: string | null; cid: string | null; eventKind: string | null; line: Line | null }
  | { kind: 'box'; holdId: string; owner: ActorRef; holdKind: string; residence: string; state: string; offer: string;
      desk: DeskRef; localOnly: boolean; terminal: boolean }
  | { kind: 'claim_take' | 'claim_move'; claimId: string; seat: SeatRef; desk: DeskRef; order: number;      // order = ranges[0][0]
      label: { simple: string; qualname: string } | null; granularity: 'symbol' | 'block' | 'file'; lines: [number, number] | null; otherRules: boolean }
  | { kind: 'claim_stale'; claimId: string }
  | { kind: 'claim_release'; claimId: string; reason: 'explicit' | 'answer' | 'save' | 'seat_end' | 'stop' | 'reservation_transfer' | 'superseded' }
  | { kind: 'claim_reserve'; claimId: string; request: string; requester: ActorRef }                     // request = display id R…
  | { kind: 'grant_start' | 'grant_end'; claimId: string; grantee: ActorRef }
  | { kind: 'request_open'; request: string; from: ActorRef; holder: ActorRef; desk: DeskRef; requestKind: 'handoff' | 'go_first';
      estMinutes: number | null; attempt: number; note: string | null }
  | { kind: 'request_status'; request: string; holder: ActorRef;
      status: 'asked' | 'queued_until_turn_end' | 'awaiting_human' | 'undeliverable' | 'returned' }
  | { kind: 'answer'; request: string; holder: ActorRef; verb: 'accept' | 'grant' | 'decline' | 'later' | 'release'; by: 'claude' | 'human' | 'daemon'; note: string | null }
  | { kind: 'note'; actor: ActorRef; target: { request: string } | { claimId: string } | null; text: string }   // request: display id R…
  | { kind: 'save'; peer: PeerRef; desks: DeskRef[] }                          // desks published since the previous save
);
export type SceneEventKind = SceneEvent['kind'];

/**
 * The closed set in §3.4 order: the table's "Scene event" column read top to bottom, each kind at its first mention
 * (the secondary events of a row, such as a respawn's pet_poof and claim_release, at that row). Pinned by a test.
 */
const KINDS = [
  'room_open', 'person_enter', 'person_respawn', 'pet_poof', 'claim_release', 'person_badge', 'person_exit', 'pet_spawn',
  'publish', 'room_sign', 'person_freeze', 'person_thaw', 'person_slowed', 'room_badge', 'person_bang', 'conflict', 'box',
  'claim_take', 'claim_move', 'claim_stale', 'claim_reserve', 'grant_start', 'grant_end', 'request_open', 'request_status',
  'answer', 'note', 'person_absent', 'save', 'person_ghost', 'person_unghost', 'pose_relaxed',
] as const satisfies readonly SceneEventKind[];
/** Compile-time: no union member is missing from KINDS. */
type MissingKind = Exclude<SceneEventKind, (typeof KINDS)[number]>;
const kindsComplete: [MissingKind] extends [never] ? true : never = true;
void kindsComplete;

export const SCENE_EVENT_KINDS: readonly SceneEventKind[] = Object.freeze([...KINDS]);

export const SUB_ROOM = 0;                                     // op events use 1 + line index (1–1,000)
export const SUB_CODE = 1_001;
export const SUB_DERIVED = 1_002;

/** 'p:<peer>' | 's:<seat>': the key of every actor-keyed Map. */
export function actorKey(a: ActorRef): string {
  return 'peer' in a ? `p:${a.peer}` : `s:${a.seat}`;
}
