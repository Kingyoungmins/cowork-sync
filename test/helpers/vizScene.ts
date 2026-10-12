// Fixtures for the scene reducer and placement tests (Plan 8a Task 5; 12 sec. 3.3.5, sec. 3.4, sec. 3.5.4): a small office layout,
// the hand-written event sequences every Task 5 test walks (Plan 2 rows and the Plan 4/6 rows 8a can only meet as
// hand-written events), a fast-check generator of scene events of every kind, and the id renaming the page applies
// (peer and seat ids -> handles) for the "ids are opaque" checks (VIZ-26).
import fc from 'fast-check';
import { SCENE_EVENT_KINDS, type ActorRef, type DeskRef, type PeerRef, type Position, type SceneEvent, type SceneEventKind, type SeatRef } from '../../src/viz/model/events.js';
import { emptyLayout, LayoutBuilder, type Layout } from '../../src/viz/model/layout.js';
import { emptyScene, SceneReducer, type Scene } from '../../src/viz/model/scene.js';
import { ev } from './vizEvents.js';

/** A peer id (32 lowercase hex) and a board seat key "<peer>/<epoch>/<seat_id>". */
export const P = (n: number): PeerRef => n.toString(16).padStart(32, '0');
export const SEAT = (owner: PeerRef, n: number, epoch = 'e1'): SeatRef => `${owner}/${epoch.padStart(32, '0')}/${n.toString(16).padStart(32, '0')}`;

export const A = P(0xa1), B = P(0xb2), C = P(0xc3), D = P(0xd4), E = P(0xe5), F = P(0xf6);
export const PEERS: readonly PeerRef[] = [A, B, C, D, E, F];
/** Desk ordinals of OFFICE: the big table 0, then one file desk per path in this order. */
export const PATHS: readonly string[] = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'test/e.ts'];
export const D1 = 1, D2 = 2, D3 = 3, D4 = 4, D5 = 5;

/** A layout with every peer of `peers` in homeOrder (spots 0, 1, ...) and one desk per path (ordinals 1, 2, ...). */
export function officeOf(paths: readonly string[] = PATHS, peers: readonly PeerRef[] = PEERS): Layout {
  const b = new LayoutBuilder(emptyLayout());
  for (const p of peers) b.home(p);
  for (const p of paths) b.desk(p, 1);
  return b.layout();
}
export const OFFICE: Layout = officeOf();
export const START: Scene = emptyScene({ height: 0, sub: 0, k: 0 });

/** The scene after each event (index i: after events[0..i]), reduced with one SceneReducer. */
export function scenesAfter(events: readonly SceneEvent[], layout: Layout = OFFICE, start: Scene = START): Scene[] {
  const r = new SceneReducer(start, () => layout);
  return events.map((e) => {
    r.push(e);
    return r.scene();
  });
}

const human = (actor: ActorRef, target: DeskRef, at: [number, number, number], path: string): SceneEvent =>
  ev('publish', at, { actor, target, others: [], paths: [path], n: 1, state: 'closed', checks: 'pass', origin: 'peer' in actor ? 'human' : 'prompt' });
const claim = (kind: 'claim_take' | 'claim_move', claimId: string, seat: SeatRef, desk: DeskRef, at: [number, number, number], simple = 'parse', order = 10): SceneEvent =>
  ev(kind, at, { claimId, seat, desk, order, label: { simple, qualname: `Mod.${simple}` }, granularity: 'symbol', lines: [order, order + 5], otherRules: false });
const enter = (peers: readonly PeerRef[], h = 1): SceneEvent[] => peers.map((peer, i) => ev('person_enter', [h, 1 + i, 0], { peer }));

export const SA1 = SEAT(A, 1), SA2 = SEAT(A, 2), SB1 = SEAT(B, 1), SC1 = SEAT(C, 1), SD1 = SEAT(D, 1), SE1 = SEAT(E, 1);

/** Chairs (sec. 3.5.4): three publishers, two claim holders, a fifth visitor, a STALE claim. */
export function chairsSequence(): SceneEvent[] {
  return [
    ...enter([A, B, C, D, E, F]),
    ev('pet_spawn', [2, 1001, 0], { seat: SD1, owner: D }),
    ev('pet_spawn', [2, 1001, 1], { seat: SE1, owner: E }),
    human({ peer: A }, D1, [10, 1001, 0], 'src/a.ts'),
    human({ peer: B }, D1, [11, 1001, 0], 'src/a.ts'),
    human({ peer: C }, D1, [12, 1001, 0], 'src/a.ts'),
    claim('claim_take', 'cl-d', SD1, D1, [13, 1, 0]),
    claim('claim_take', 'cl-e', SE1, D1, [14, 1, 0], 'lex'),
    human({ peer: F }, D1, [15, 1001, 0], 'src/a.ts'),
    ev('claim_stale', [16, 1, 0], { claimId: 'cl-e' }),
  ];
}

/** Character precedence (sec. 3.5.4): supervising, own publish, a newer pet claim op, own human request, home. */
export function characterSequence(): SceneEvent[] {
  return [
    ...enter([A, B]),
    ev('pet_spawn', [2, 1001, 0], { seat: SA1, owner: A }),
    ev('pet_spawn', [2, 1001, 1], { seat: SB1, owner: B }),
    claim('claim_take', 'cl-a1', SA1, D2, [3, 1, 0]),                        // 4: A supervises beside desk 2
    human({ peer: A }, D1, [4, 1001, 0], 'src/a.ts'),                       // 5: a publish newer than every claim op -> desk 1
    claim('claim_move', 'cl-a1', SA1, D2, [5, 1, 0], 'parse', 12),         // 6: a newer claim op -> beside desk 2 again
    claim('claim_take', 'cl-b1', SB1, D3, [5, 2, 0], 'emit'),               // 7
    ev('request_open', [6, 1, 0], { request: 'R0000000A', from: { peer: A }, holder: { seat: SB1 }, desk: D3, requestKind: 'handoff', estMinutes: null, attempt: 1, note: null }),
    human({ peer: A }, D1, [7, 1001, 0], 'src/a.ts'),                       // 9: still facing (precedence 1)
    ev('answer', [8, 1, 0], { request: 'R0000000A', holder: { seat: SB1 }, verb: 'accept', by: 'claude', note: null }),   // 10: -> desk 1
    claim('claim_take', 'cl-a2', SA1, D4, [10, 1, 0], 'scan'),              // 11: beside desk 4, where its pet now sits
    ev('claim_release', [11, 1, 0], { claimId: 'cl-a2', reason: 'explicit' }),   // 12: beside desk 2
    ev('claim_release', [12, 1, 0], { claimId: 'cl-a1', reason: 'explicit' }),   // 13: publish older than a claim op, no claim -> home
  ];
}

/** Recency is a board position (F13): a publish and a claim op at one height, two publishes at one height. */
export function recencySequence(): SceneEvent[] {
  return [
    ...enter([A, B, C]),
    ev('pet_spawn', [2, 1001, 0], { seat: SA1, owner: A }),
    claim('claim_take', 'cl-a1', SA1, D2, [20, 1, 0]),
    human({ peer: A }, D1, [20, 1001, 0], 'src/a.ts'),
    human({ peer: B }, D3, [30, 1001, 0], 'src/c.ts'),
    human({ peer: C }, D3, [30, 1001, 1], 'src/c.ts'),
    claim('claim_move', 'cl-a1', SA1, D2, [41, 1, 0]),
  ];
}

/** Pet precedence (sec. 3.5.4): behind, change-set target, granted stool, claim chairs (newest first), own request. */
export function petSequence(): SceneEvent[] {
  return [
    ...enter([A, B]),
    ev('pet_spawn', [2, 1001, 0], { seat: SA1, owner: A }),                // 2: behind A
    ev('pet_spawn', [2, 1001, 1], { seat: SB1, owner: B }),
    human({ seat: SA1 }, D1, [3, 1001, 0], 'src/a.ts'),                     // 4: change-set target desk 1 (indices after each event)
    claim('claim_take', 'cl-b1', SB1, D2, [4, 1, 0], 'emit'),              // 5
    ev('grant_start', [5, 1, 0], { claimId: 'cl-b1', grantee: { seat: SA1 } }),   // 6: stool at desk 2
    claim('claim_take', 'cl-a1', SA1, D3, [6, 1, 0]),                      // 7: chair at desk 3
    claim('claim_take', 'cl-a2', SA1, D4, [7, 1, 0], 'scan'),              // 8: its newest HELD claim: desk 4
    ev('request_open', [8, 1, 0], { request: 'R0000000B', from: { seat: SA1 }, holder: { seat: SB1 }, desk: D2, requestKind: 'go_first', estMinutes: 5, attempt: 1, note: null }),
    ev('request_status', [8, 2, 0], { request: 'R0000000B', holder: { seat: SB1 }, status: 'asked' }),   // 10: still facing
    ev('save', [8, 3, 0], { peer: B, desks: [D3] }),                       // 11: desk 3 (its older claim's desk) has the latest event
    ev('answer', [9, 1, 0], { request: 'R0000000B', holder: { seat: SB1 }, verb: 'decline', by: 'human', note: null }),   // 12: back to desk 4
    ev('claim_release', [10, 1, 0], { claimId: 'cl-a2', reason: 'explicit' }),   // 13: desk 3
    ev('claim_release', [11, 1, 0], { claimId: 'cl-a1', reason: 'explicit' }),   // 14: the stool at desk 2
    ev('grant_end', [12, 1, 0], { claimId: 'cl-b1', grantee: { seat: SA1 } }),   // 15: change-set target desk 1
    ev('request_open', [13, 1, 0], { request: 'R0000000C', from: { seat: SA1 }, holder: { seat: SB1 }, desk: D2, requestKind: 'handoff', estMinutes: null, attempt: 2, note: 'please' }),
    ev('request_status', [14, 1, 0], { request: 'R0000000C', holder: { seat: SB1 }, status: 'returned' }),   // 17: walks back to desk 1
  ];
}

/** Persistence (sec. 3.5.4): unrelated events never move an actor; ghost, poof, absent and exit do. */
export function persistenceSequence(): SceneEvent[] {
  return [
    ...enter([A, B, C]),
    ev('pet_spawn', [2, 1001, 0], { seat: SA1, owner: A }),
    ev('pet_spawn', [2, 1001, 1], { seat: SC1, owner: C }),
    human({ peer: A }, D1, [3, 1001, 0], 'src/a.ts'),                       // 5
    human({ seat: SA1 }, D2, [4, 1001, 0], 'src/b.ts'),                     // 6
    human({ seat: SC1 }, D3, [5, 1001, 0], 'src/c.ts'),                     // 7
    human({ peer: B }, D4, [6, 1001, 0], 'src/d.ts'),                       // 8; the unrelated events are 9-19
    ev('room_sign', [7, 1001, 0], { sign: 'branch_moved' }),
    ev('room_badge', [8, 1002, 0], { level: 'near_full' }),
    ev('person_freeze', [9, 1, 0], { peer: B, reasonCode: 'EPOCH' }),
    ev('person_badge', [10, 1, 0], { actor: { peer: A }, badge: 'credit', on: true, code: null }),
    ev('person_slowed', [11, 1, 0], { peer: B, until: 191 }),
    ev('note', [12, 1, 0], { actor: { peer: A }, target: null, text: 'hello' }),
    ev('person_bang', [13, 1, 0], { peer: B, bang: 'host' }),
    ev('conflict', [14, 1, 0], { conflict: 'generic', source: 'event', on: { peer: B }, desk: null, holdId: null, cid: 'ABCDEFGH', eventKind: 'K1', line: null }),
    ev('save', [15, 1, 0], { peer: B, desks: [D4] }),
    ev('person_thaw', [16, 1, 0], { peer: B }),
    ev('pose_relaxed', [80, 1002, 0], { actor: { peer: A } }),             // 19: a pose, not a move
    ev('person_ghost', [300, 1002, 0], { peer: A }),                       // 20: A goes home, its pet stays
    ev('pet_poof', [301, 1002, 0], { seat: SA1, owner: A }),               // 21
    ev('person_absent', [302, 1, 0], { peer: B }),                         // 22: B goes home
    ev('person_exit', [303, 1, 0], { peer: C }),                           // 23: C leaves, its pet stays until its poof
    ev('pet_poof', [303, 1, 1], { seat: SC1, owner: C }),                  // 24
  ];
}

/** Persistent "!" from hold records versus one-beat "!" from events (sec. 3.7 exclaim). */
export function bangSequence(): SceneEvent[] {
  return [
    ...enter([A, B]),
    ev('pet_spawn', [2, 1001, 0], { seat: SA1, owner: A }),
    ev('conflict', [5, 1, 0], { conflict: 'k4', source: 'hold', on: { seat: SA1 }, desk: D1, holdId: 'H0000001', cid: null, eventKind: null, line: null }),
    ev('box', [5, 1, 1], { holdId: 'H0000001', owner: { seat: SA1 }, holdKind: 'PIN', residence: 'ON_DISK', state: 'CONFLICTED', offer: 'none', desk: D1, localOnly: false, terminal: false }),
    ev('conflict', [6, 1, 0], { conflict: 'k7', source: 'hold', on: { peer: B }, desk: D2, holdId: 'H0000002', cid: null, eventKind: null, line: { claimId: 'cl-x' } }),
    ev('box', [6, 1, 1], { holdId: 'H0000002', owner: { peer: B }, holdKind: 'PIN', residence: 'ON_DISK', state: 'PENDING_CHECKS', offer: 'none', desk: D2, localOnly: false, terminal: false }),
    ev('box', [7, 1, 0], { holdId: 'H0000001', owner: { seat: SA1 }, holdKind: 'PIN', residence: 'ON_DISK', state: 'RESOLVED_PUBLISH', offer: 'none', desk: D1, localOnly: false, terminal: true }),
    ev('conflict', [8, 1, 0], { conflict: 'breach', source: 'event', on: { peer: B }, desk: null, holdId: null, cid: 'BCDEFGHJ', eventKind: 'breach', line: null }),
    ev('person_bang', [8, 2, 0], { peer: A, bang: 'host' }),
    ev('room_badge', [9, 1002, 0], { level: 'none' }),
    ev('box', [400, 1, 0], { holdId: 'H0000002', owner: { peer: B }, holdKind: 'PIN', residence: 'ON_DISK', state: 'GONE', offer: 'none', desk: D2, localOnly: false, terminal: true }),
  ];
}

export const SA3 = SEAT(A, 1, 'e2');
/** VIZ-21: spawn by seat_start and by footprint, a repeated spawn, seat_end, respawn, presume_absent, leave. (The owner of a
 *  footprint-only seat becoming a ghost is the timeline builder's own pet_poof: pets.test.ts drives it through the
 *  ghost_footprint row fixture, never a hand-written poof.) */
export function petLifeSequence(): SceneEvent[] {
  return [
    ...enter([A, B, C, D]),
    ev('pet_spawn', [2, 1, 0], { seat: SA1, owner: A }),                   // 4: seat_start
    ev('pet_spawn', [3, 1001, 0], { seat: SA1, owner: A }),                // 5: a repeated spawn is no second pet
    ev('pet_spawn', [3, 1001, 1], { seat: SA2, owner: A }),                // 6: a footprint
    ev('person_badge', [4, 1, 0], { actor: { seat: SA2 }, badge: 'health', on: true, code: 'SS_NO_HOOKS' }),
    ev('pet_poof', [5, 1, 0], { seat: SA1, owner: A }),                    // 8: seat_end
    ev('person_respawn', [6, 1, 0], { peer: A }),                          // 9: a new epoch retires SA2
    ev('pet_poof', [6, 1, 1], { seat: SA2, owner: A }),
    ev('pet_spawn', [7, 1, 0], { seat: SA3, owner: A }),                   // 11: a seat of the new epoch
    ev('pet_spawn', [8, 1, 0], { seat: SB1, owner: B }),
    claim('claim_take', 'cl-b1', SB1, D1, [8, 1, 1]),
    ev('person_absent', [9, 1, 0], { peer: B }),                           // 14: presume_absent
    ev('pet_poof', [9, 1, 1], { seat: SB1, owner: B }),
    ev('claim_stale', [9, 1, 2], { claimId: 'cl-b1' }),
    ev('pet_spawn', [10, 1, 0], { seat: SC1, owner: C }),
    claim('claim_take', 'cl-c1', SC1, D2, [10, 1, 1]),
    ev('person_exit', [11, 1, 0], { peer: C }),                            // 19: leave
    ev('pet_poof', [11, 1, 1], { seat: SC1, owner: C }),
    ev('claim_release', [11, 1, 2], { claimId: 'cl-c1', reason: 'stop' }),
    ev('pet_spawn', [14, 1, 0], { seat: SA1, owner: A }),                  // 22: SA1 again
  ];
}

/** Seat variants follow each owner's first footprints in the segment, not seat-key order. */
export const K1 = SEAT(A, 0x11), K2 = SEAT(A, 0x22), K3 = SEAT(A, 0x33), K4 = SEAT(A, 0x44), KB = SEAT(B, 0x22);
export function variantSequence(): SceneEvent[] {
  return [
    ...enter([A, B]),
    ev('pet_spawn', [2, 1001, 0], { seat: K3, owner: A }),
    ev('pet_spawn', [2, 1001, 1], { seat: K1, owner: A }),
    ev('pet_spawn', [2, 1001, 2], { seat: K2, owner: A }),
    ev('pet_spawn', [2, 1001, 3], { seat: KB, owner: B }),
    ev('pet_poof', [3, 1, 0], { seat: K1, owner: A }),
    ev('pet_spawn', [4, 1001, 0], { seat: K4, owner: A }),
    ev('pet_spawn', [5, 1001, 0], { seat: K1, owner: A }),
  ];
}

/**
 * Open requests whose requester is not standing at them: one filed for a seat before its pet spawns, one whose requester
 * becomes a ghost and comes back, then presumed absent and back. Nobody walks to the holder then (VIZ-17: only
 * request_open does), and the requester stays where precedence 2-4 puts it.
 */
export function requestEdgeSequence(): SceneEvent[] {
  return [
    ...enter([A, B]),
    ev('request_open', [2, 1, 0], { request: 'R0000000D', from: { seat: SA1 }, holder: { peer: B }, desk: D1, requestKind: 'handoff', estMinutes: null, attempt: 1, note: null }),
    ev('pet_spawn', [2, 1001, 0], { seat: SA1, owner: A }),                // 3: behind A, not facing B
    ev('request_open', [3, 1, 0], { request: 'R0000000E', from: { peer: A }, holder: { peer: B }, desk: D2, requestKind: 'go_first', estMinutes: 2, attempt: 1, note: null }),
    ev('person_ghost', [250, 1002, 0], { peer: A }),                       // 5: home
    ev('person_unghost', [251, 1002, 0], { peer: A }),                     // 6: stays home
    ev('person_absent', [252, 1, 0], { peer: A }),
    ev('person_enter', [253, 1, 0], { peer: A }),                          // 8: back through the door, home
  ];
}

/** Every hand-written sequence of this task, by name. */
export const HAND_SEQUENCES: ReadonlyArray<readonly [string, () => SceneEvent[]]> = [
  ['chairs', chairsSequence], ['character', characterSequence], ['recency', recencySequence], ['pet', petSequence],
  ['persistence', persistenceSequence], ['bang', bangSequence], ['petLife', petLifeSequence], ['variant', variantSequence],
  ['requestEdge', requestEdgeSequence],
];

// ---------------------------------------------------------------------------------------------------------------
// Random scene events of every kind (fast-check).

const RP: readonly PeerRef[] = [P(1), P(2), P(3)];
const RS: readonly SeatRef[] = RP.flatMap((p) => [SEAT(p, 1), SEAT(p, 2)]);
const RD: readonly DeskRef[] = [0, 1, 2, 3, 4, 5];
const RC = ['cl-1', 'cl-2', 'cl-3', 'cl-4'];
const RR = ['R00000001', 'R00000002', 'R00000003'];
const RH = ['H0000001', 'H0000002', 'H0000003'];
/** The layout the random events name: homeOrder RP, desks 0-5. */
export const RANDOM_OFFICE: Layout = officeOf(PATHS, RP);

const peerArb = fc.constantFrom(...RP);
const seatArb = fc.constantFrom(...RS);
const actorArb: fc.Arbitrary<ActorRef> = fc.oneof(peerArb.map((peer) => ({ peer })), seatArb.map((seat) => ({ seat })));
const deskArb = fc.constantFrom(...RD);
const claimArb = fc.constantFrom(...RC);
const reqArb = fc.constantFrom(...RR);
const holdArb = fc.constantFrom(...RH);
const textArb = fc.constantFrom('hi', 'a note', '');
const nullable = <T>(a: fc.Arbitrary<T>): fc.Arbitrary<T | null> => fc.option(a, { nil: null });

/** The fields of one event of kind k (positions and seed are added by eventsArb). */
function fieldsArb(k: SceneEventKind): fc.Arbitrary<Record<string, unknown>> {
  switch (k) {
    case 'room_open': return fc.constant({});
    case 'room_sign': return fc.constant({ sign: 'branch_moved' });
    case 'room_badge': return fc.record({ level: fc.constantFrom('none', 'near_full', 'full') });
    case 'person_enter': case 'person_respawn': case 'person_exit': case 'person_thaw': case 'person_absent': case 'person_ghost': case 'person_unghost':
      return fc.record({ peer: peerArb });
    case 'person_freeze': return fc.record({ peer: peerArb, reasonCode: fc.constantFrom('EPOCH', 'PAUSED', 'NOHOOKS', 'MASS') });
    case 'person_slowed': return fc.record({ peer: peerArb, until: fc.integer({ min: 0, max: 2_000 }) });
    case 'person_bang': return fc.record({ peer: peerArb, bang: fc.constant('host') });
    case 'person_badge': return fc.record({ actor: actorArb, badge: fc.constantFrom('version', 'rules', 'credit', 'health'), on: fc.boolean(), code: nullable(fc.constantFrom('SS_NO_HOOKS', 'HOLD_REVERT_HELD')) });
    case 'pet_spawn': case 'pet_poof':
      return seatArb.chain((seat) => fc.record({ seat: fc.constant(seat), owner: fc.oneof({ arbitrary: fc.constant(seat.slice(0, 32)), weight: 4 }, { arbitrary: peerArb, weight: 1 }) }));
    case 'pose_relaxed': return fc.record({ actor: actorArb });
    case 'publish':
      return fc.record({
        actor: actorArb, target: deskArb, others: fc.uniqueArray(deskArb, { maxLength: 3 }), paths: fc.constant(['src/a.ts']), n: fc.integer({ min: 0, max: 300 }),
        state: fc.constantFrom('closed', 'checkpoint'), checks: fc.constantFrom('pass', 'fail', 'skipped'), origin: fc.constantFrom('prompt', 'wake', 'human'),
      });
    case 'conflict':
      return fc.record({
        conflict: fc.constantFrom('k4', 'claim', 'k7', 'breach', 'generic'), source: fc.constantFrom('hold', 'event'), on: actorArb, desk: nullable(deskArb),
        holdId: nullable(holdArb), cid: nullable(fc.constant('ABCDEFGH')), eventKind: nullable(fc.constantFrom('breach', 'K4')),
        line: nullable(fc.oneof(actorArb.map((actor) => ({ actor })), claimArb.map((claimId) => ({ claimId })))),
      });
    case 'box':
      return fc.record({
        holdId: holdArb, owner: actorArb, holdKind: fc.constantFrom('PIN', 'BUNDLE'), residence: fc.constantFrom('ON_DISK', 'OFF_DISK', 'PARKED', 'INCOMING'),
        state: fc.constantFrom('CONFLICTED', 'PENDING_CHECKS', 'RESOLVED_PUBLISH', 'GONE'), offer: fc.constant('none'), desk: deskArb, localOnly: fc.boolean(), terminal: fc.boolean(),
      });
    case 'claim_take': case 'claim_move':
      return fc.record({
        claimId: claimArb, seat: seatArb, desk: deskArb, order: fc.integer({ min: 1, max: 50 }),
        label: nullable(fc.record({ simple: fc.constantFrom('parse', 'emit'), qualname: fc.constantFrom('A.parse', 'B.parse', 'A.emit') })),
        granularity: fc.constantFrom('symbol', 'block', 'file'), lines: nullable(fc.constant([3, 9] as [number, number])), otherRules: fc.boolean(),
      });
    case 'claim_stale': return fc.record({ claimId: claimArb });
    case 'claim_release': return fc.record({ claimId: claimArb, reason: fc.constantFrom('explicit', 'answer', 'save', 'seat_end', 'stop', 'reservation_transfer', 'superseded') });
    case 'claim_reserve': return fc.record({ claimId: claimArb, request: reqArb, requester: actorArb });
    case 'grant_start': case 'grant_end': return fc.record({ claimId: claimArb, grantee: actorArb });
    case 'request_open':
      return fc.record({
        request: reqArb, from: actorArb, holder: actorArb, desk: deskArb, requestKind: fc.constantFrom('handoff', 'go_first'),
        estMinutes: nullable(fc.integer({ min: 1, max: 30 })), attempt: fc.integer({ min: 1, max: 3 }), note: nullable(textArb),
      });
    case 'request_status':
      return fc.record({ request: reqArb, holder: actorArb, status: fc.constantFrom('asked', 'queued_until_turn_end', 'awaiting_human', 'undeliverable', 'returned') });
    case 'answer':
      return fc.record({ request: reqArb, holder: actorArb, verb: fc.constantFrom('accept', 'grant', 'decline', 'later', 'release'), by: fc.constantFrom('claude', 'human', 'daemon'), note: nullable(textArb) });
    case 'note':
      return fc.record({ actor: actorArb, target: nullable(fc.oneof(reqArb.map((request) => ({ request })), claimArb.map((claimId) => ({ claimId })))), text: textArb });
    case 'save': return fc.record({ peer: peerArb, desks: fc.uniqueArray(deskArb, { maxLength: 3 }) });
  }
}

/** One step between consecutive events: the same height (a later sub or k) or a jump of a few or of many heights. */
const stepArb = fc.record({
  dh: fc.oneof({ arbitrary: fc.constant(0), weight: 3 }, { arbitrary: fc.integer({ min: 1, max: 3 }), weight: 3 }, { arbitrary: fc.integer({ min: 60, max: 300 }), weight: 1 }),
  sub: fc.integer({ min: 0, max: 1_002 }),
});

/** A sequence of events of every kind in strictly increasing positions, the first at height `from` or later. */
export function eventsArb(o: { from?: number; minLength?: number; maxLength?: number } = {}): fc.Arbitrary<SceneEvent[]> {
  const kindArb = fc.constantFrom(...SCENE_EVENT_KINDS);
  const one = fc.tuple(kindArb.chain((k) => fieldsArb(k).map((f) => [k, f] as const)), stepArb, fc.nat());
  return fc.array(one, { minLength: o.minLength ?? 0, maxLength: o.maxLength ?? 60 }).map((items) => {
    let pos: Position = { height: o.from ?? 0, sub: 0, k: 0 };
    let first = true;
    return items.map(([[kind, fields], step, seed]) => {
      if (first) pos = { height: pos.height + step.dh, sub: step.sub, k: 0 };
      else if (step.dh > 0) pos = { height: pos.height + step.dh, sub: step.sub, k: 0 };
      else if (step.sub > pos.sub) pos = { height: pos.height, sub: step.sub, k: 0 };
      else pos = { height: pos.height, sub: pos.sub, k: pos.k + 1 };
      first = false;
      return { ...pos, seed, kind, ...fields } as unknown as SceneEvent;
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Renaming peer and seat ids (the page's handles, VIZ-26).

export interface Rename { peer(p: PeerRef): PeerRef; seat(s: SeatRef): SeatRef; }

/** Every 'peer', 'seat' and string 'owner' field renamed, at any depth; everything else copied. */
export function renameValue<T>(v: T, r: Rename): T {
  if (Array.isArray(v)) return v.map((x) => renameValue(x, r)) as T;
  if (v instanceof Map) throw new TypeError('renameValue: a Map inside a value');
  if (typeof v !== 'object' || v === null) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if ((k === 'peer' || k === 'owner') && typeof x === 'string') out[k] = r.peer(x);
    else if (k === 'seat' && typeof x === 'string') out[k] = r.seat(x);
    else out[k] = renameValue(x, r);
  }
  return out as T;
}

const byKey = <K, V>(entries: Array<[K, V]>): Map<K, V> =>
  new Map(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** A scene with its ids renamed; every Map rebuilt in ascending (renamed) key order, as the page's unprojection builds it. */
export function renameScene(s: Scene, r: Rename): Scene {
  const values = <K, V>(m: Map<K, V>, key: (k: K) => K): Map<K, V> => byKey([...m].map(([k, v]) => [key(k), renameValue(v, r)]));
  const same = <K>(k: K): K => k;
  return {
    at: { ...s.at }, badge: s.badge, branchMovedAt: s.branchMovedAt,
    characters: values(s.characters, (p) => r.peer(p)),
    pets: values(s.pets, (k) => r.seat(k)),
    desks: values(s.desks, same), claims: values(s.claims, same), requests: values(s.requests, same), boxes: values(s.boxes, same), bangs: values(s.bangs, same),
    beat: s.beat.map((e) => renameValue(e, r)),
  };
}

export function renameLayout(l: Layout, r: Rename): Layout {
  return { ...l, homeOrder: l.homeOrder.map((p) => r.peer(p)) };
}

const HANDLE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Peers -> other hex ids in reverse order; seats -> 6-character handles (no '/') in reverse order. */
export function reversingRename(peers: readonly PeerRef[], seats: readonly SeatRef[]): Rename {
  const ps = [...new Set(peers)].sort();
  const ss = [...new Set(seats)].sort();
  const pm = new Map(ps.map((p, i) => [p, (0xfff0 - i).toString(16).padStart(32, 'f')]));
  const sm = new Map(ss.map((s, i) => [s, 'Z' + [...(ss.length - i).toString(32).toUpperCase().padStart(5, '0')].map((c) => HANDLE_ALPHABET[parseInt(c, 32)]).join('')]));
  return {
    peer: (p) => pm.get(p) ?? `unmapped-${p}`,
    seat: (s) => sm.get(s) ?? `unmapped-${s}`,
  };
}

/** Every peer and seat id a list of events names. */
export function idsOf(events: readonly SceneEvent[]): { peers: PeerRef[]; seats: SeatRef[] } {
  const peers = new Set<PeerRef>(), seats = new Set<SeatRef>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === 'object' && v !== null) {
      for (const [k, x] of Object.entries(v)) {
        if ((k === 'peer' || k === 'owner') && typeof x === 'string') peers.add(x);
        else if (k === 'seat' && typeof x === 'string') seats.add(x);
        else walk(x);
      }
    }
  };
  walk(events);
  return { peers: [...peers], seats: [...seats] };
}
