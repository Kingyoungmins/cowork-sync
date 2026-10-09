// Plan 8a Task 5: placement (12 sec. 3.5.4; VIZ-17): chairs and visitors, the character and pet precedence lists, recency by
// board position (R-V25), actor-to-actor walks only by request_open, and the target-desk tie-breaks of targetDesk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import fc from 'fast-check';
import { actorKey, type ActorRef, type DeskRef, type SceneEvent } from '../../../src/viz/model/events.js';
import { BIG_TABLE } from '../../../src/viz/model/layout.js';
import { characterPlace, homeSpot, petPlace, seatDesk, targetDesk } from '../../../src/viz/model/placement.js';
import type { Place, Scene } from '../../../src/viz/model/scene.js';
import { ev } from '../../helpers/vizEvents.js';
import {
  A, B, C, D1, D2, D3, D4, D5, E, F, HAND_SEQUENCES, OFFICE, PEERS, RANDOM_OFFICE, SA1, SA2, SB1, SD1, SE1, SEAT, START,
  chairsSequence, characterSequence, eventsArb, officeOf, petSequence, recencySequence, requestEdgeSequence, scenesAfter,
} from '../../helpers/vizScene.js';

const home = (spot: number): Place => ({ at: 'home', spot });
const chair = (desk: DeskRef): Place => ({ at: 'chair', desk });
const visitor = (desk: DeskRef, tile: number): Place => ({ at: 'visitor', desk, tile });
const P = (peer: string): ActorRef => ({ peer });
const S = (seat: string): ActorRef => ({ seat });

/** The chair, visitors and "+n" of a desk as the scene stores them, checked against seatDesk and every actor's place. */
function seating(s: Scene, d: DeskRef): { chair: ActorRef | null; visitors: ActorRef[]; more: number } {
  const ds = s.desks.get(d);
  const stored = { chair: ds?.chair ?? null, visitors: ds?.visitors ?? [], more: ds?.more ?? 0 };
  assert.deepEqual(seatDesk(s, d), stored, `seatDesk(${d}) equals the scene's desk entry`);
  const placeOf = (a: ActorRef): Place | undefined => ('peer' in a ? s.characters.get(a.peer)?.place : s.pets.get(a.seat)?.place);
  if (stored.chair !== null) assert.deepEqual(placeOf(stored.chair), chair(d));
  stored.visitors.forEach((v, i) => assert.deepEqual(placeOf(v), visitor(d, i)));
  return stored;
}

test('T-VIZ-placement (reducer): publish seats the actor at the target desk, keeps lastPublish and lastDesk, and fills chairs: newest HELD claim holder, else the most recent publisher; claim holders, then publishers by recency on visitor tiles; the fifth visitor makes more = 1', () => {
  const events = chairsSequence();
  const s = scenesAfter(events);
  // 8: A publishes alone at desk 1: the chair, its position and desk recorded, the desk's event height.
  const a = s[8]!.characters.get(A)!;
  assert.deepEqual(a.place, chair(D1));
  assert.equal(a.pose, 'sit');
  assert.deepEqual(a.lastPublish, { height: 10, sub: 1001, k: 0 });
  assert.equal(a.lastDesk, D1);
  assert.deepEqual(seating(s[8]!, D1), { chair: P(A), visitors: [], more: 0 });
  assert.equal(s[8]!.desks.get(D1)!.lastEvent, 10);
  // 9, 10: the most recent publisher takes the chair; the others stand on visitor tiles, newest first.
  assert.deepEqual(seating(s[9]!, D1), { chair: P(B), visitors: [P(A)], more: 0 });
  assert.equal(s[9]!.characters.get(A)!.pose, 'idle', 'standing at a visitor tile');
  assert.deepEqual(seating(s[10]!, D1), { chair: P(C), visitors: [P(B), P(A)], more: 0 });
  // 11: a HELD claim holder takes the chair from every publisher.
  assert.deepEqual(seating(s[11]!, D1), { chair: S(SD1), visitors: [P(C), P(B), P(A)], more: 0 });
  assert.deepEqual(s[11]!.desks.get(D1)!.claims, ['cl-d']);
  // 12: the newest HELD claim holder; the older holder is the first visitor (holders before publishers).
  assert.deepEqual(seating(s[12]!, D1), { chair: S(SE1), visitors: [S(SD1), P(C), P(B), P(A)], more: 0 });
  // 13: a newer publisher still comes after every claim holder; five visitors -> four tiles and "+1".
  assert.deepEqual(seating(s[13]!, D1), { chair: S(SE1), visitors: [S(SD1), P(F), P(C), P(B)], more: 1 });
  assert.deepEqual(s[13]!.characters.get(A)!.place, visitor(D1, 4), 'the fifth visitor is counted in "+n"');
  assert.deepEqual(s[13]!.characters.get(A)!.lastPublish, { height: 10, sub: 1001, k: 0 }, 'standing up keeps lastPublish');
  assert.equal(s[13]!.characters.get(A)!.lastDesk, D1);
  // 14: a STALE claim is not HELD: its pet leaves the desk; the other holder takes the chair; the ghost chair's claim stays listed.
  assert.deepEqual(seating(s[14]!, D1), { chair: S(SD1), visitors: [P(F), P(C), P(B), P(A)], more: 0 });
  assert.deepEqual(s[14]!.pets.get(SE1)!.place, { at: 'behind', peer: E });
  assert.deepEqual(s[14]!.desks.get(D1)!.claims, ['cl-d', 'cl-e']);
  assert.equal(s[14]!.claims.get('cl-e')!.stale, true);

  // The chair goes to the holder of the desk's newest HELD claim, not to the holder whose newest claim op was elsewhere.
  const take = (id: string, seat: string, desk: DeskRef, h: number): SceneEvent =>
    ev('claim_take', [h, 1, 0], { claimId: id, seat, desk, order: 1, label: null, granularity: 'file', lines: null, otherRules: false });
  const back = scenesAfter([
    ...chairsSequence().slice(0, 8),                       // A-F entered, SD1 and SE1 spawned
    take('x1', SD1, D3, 20),                               // SD1 at desk 3
    take('x2', SE1, D3, 21),                               // SE1: the newest claim at desk 3, the chair
    take('x3', SD1, D4, 22),                               // SD1's newest claim op: it moves to desk 4
    ev('claim_release', [23, 1, 0], { claimId: 'x3', reason: 'explicit' }),   // SD1 back at desk 3, its claim there the older one
  ]);
  assert.deepEqual(back[8]!.pets.get(SD1)!.place, chair(D3));
  assert.deepEqual(back[9]!.pets.get(SD1)!.place, visitor(D3, 0));
  assert.deepEqual(back[10]!.pets.get(SD1)!.place, chair(D4));
  assert.deepEqual(seating(back[11]!, D3), { chair: S(SE1), visitors: [S(SD1)], more: 0 });

  // Publishers by recency, which here is neither ascending nor descending id order: B, then A, then C publish.
  const pub = (peer: string, h: number): SceneEvent =>
    ev('publish', [h, 1001, 0], { actor: { peer }, target: D5, others: [], paths: ['test/e.ts'], n: 1, state: 'closed', checks: 'pass', origin: 'human' });
  const recent = scenesAfter([...chairsSequence().slice(0, 6), pub(B, 20), pub(A, 21), pub(C, 22)]);
  assert.deepEqual(seating(recent[8]!, D5), { chair: P(C), visitors: [P(A), P(B)], more: 0 });

  // A desk's claims are listed by ranges[0][0] (ClaimState.order), while its chair goes to the holder of its newest HELD
  // claim (by board position), wherever that claim sits in the list.
  const ranged = (kind: 'claim_take' | 'claim_move', id: string, seat: string, order: number, h: number): SceneEvent =>
    ev(kind, [h, 1, 0], { claimId: id, seat, desk: D4, order, label: null, granularity: 'block', lines: [order, order + 3], otherRules: false });
  const listed = scenesAfter([
    ...chairsSequence().slice(0, 8),
    ranged('claim_take', 'k30', SD1, 30, 20),             // 8
    ranged('claim_take', 'k5', SE1, 5, 21),               // 9
    ranged('claim_take', 'k17', SD1, 17, 22),             // 10
    ranged('claim_move', 'k30', SD1, 1, 23),              // 11: re-anchored to line 1
    ranged('claim_take', 'k9', SE1, 9, 24),               // 12
  ]);
  assert.deepEqual(listed[8]!.desks.get(D4)!.claims, ['k30']);
  assert.deepEqual(listed[10]!.desks.get(D4)!.claims, ['k5', 'k17', 'k30']);
  assert.deepEqual(seating(listed[10]!, D4), { chair: S(SD1), visitors: [S(SE1)], more: 0 }, 'k17 is the newest HELD claim');
  assert.deepEqual(listed[11]!.desks.get(D4)!.claims, ['k30', 'k5', 'k17']);
  assert.deepEqual(seating(listed[11]!, D4), { chair: S(SD1), visitors: [S(SE1)], more: 0 });
  assert.deepEqual(listed[12]!.desks.get(D4)!.claims, ['k30', 'k5', 'k9', 'k17']);
  assert.deepEqual(seating(listed[12]!, D4), { chair: S(SE1), visitors: [S(SD1)], more: 0 }, 'k9 is the newest HELD claim');
  assert.deepEqual(listed[12]!.claims.get('k9')!.at, { height: 24, sub: 1, k: 0 });
});

test('T-VIZ-placement: character precedence: own open human request > newest human change-set newer than every claim op of its pets > supervising beside its pets\' desk > home spot', () => {
  const s = scenesAfter(characterSequence());
  const a = (i: number): Place => s[i]!.characters.get(A)!.place;
  assert.deepEqual(a(3), home(0), 'no publish, no pet claim: home spot');
  assert.deepEqual(a(4), { at: 'beside', desk: D2 }, "its pet holds a claim: supervising beside the pet's desk");
  assert.deepEqual(s[4]!.pets.get(SA1)!.place, chair(D2));
  assert.deepEqual(a(5), chair(D1), 'its human change-set is newer than every claim op of its pets');
  assert.deepEqual(a(6), { at: 'beside', desk: D2 }, 'a newer claim op of its pet');
  assert.deepEqual(a(8), { at: 'facing', actor: S(SB1), desk: D3 }, 'its own open human request');
  assert.deepEqual(a(9), { at: 'facing', actor: S(SB1), desk: D3 }, 'a newer publish does not beat its open request');
  assert.deepEqual(s[9]!.characters.get(A)!.lastDesk, D1);
  assert.deepEqual(a(10), chair(D1), 'the request is answered: back to the desk of its newest change-set');
  assert.equal(s[10]!.requests.size, 0);
  assert.deepEqual(a(11), { at: 'beside', desk: D4 }, 'its pet sits at its newest claim');
  assert.deepEqual(a(12), { at: 'beside', desk: D2 });
  assert.deepEqual(a(13), home(0), 'its publish is older than a claim op of its pet, and no pet holds a claim');
  assert.deepEqual(s[13]!.pets.get(SA1)!.place, { at: 'behind', peer: A });
  // characterPlace answers the same for the scene it is given; an unknown peer stands at its home spot.
  for (const sc of s) for (const peer of sc.characters.keys()) assert.deepEqual(characterPlace(sc, peer, OFFICE), sc.characters.get(peer)!.place);
  assert.deepEqual(characterPlace(s[0]!, F, OFFICE), home(5));

  // Supervising with several claiming pets: beside the desk where most of them sit, not the desk of the newest claim op.
  const SA3 = SEAT(A, 3);
  const take = (id: string, seat: string, desk: DeskRef, h: number): SceneEvent =>
    ev('claim_take', [h, 1, 0], { claimId: id, seat, desk, order: 1, label: null, granularity: 'file', lines: null, otherRules: false });
  const sup = scenesAfter([
    ...characterSequence().slice(0, 2),                  // A, B entered
    ev('pet_spawn', [2, 1001, 0], { seat: SA1, owner: A }),
    ev('pet_spawn', [2, 1001, 1], { seat: SA2, owner: A }),
    ev('pet_spawn', [2, 1001, 2], { seat: SA3, owner: A }),
    take('m1', SA1, D2, 3),                               // 5
    take('m2', SA2, D2, 4),                               // 6
    take('m3', SA3, D3, 5),                               // 7: the newest claim op, at desk 3
    take('m4', SA1, D3, 6),                               // 8: SA1 moves to desk 3: two pets there now
  ]);
  assert.deepEqual(sup[7]!.characters.get(A)!.place, { at: 'beside', desk: D2 }, 'two of its three pets sit at desk 2');
  assert.deepEqual(sup[8]!.characters.get(A)!.place, { at: 'beside', desk: D3 });

  // An actor's own event resets its pose even when its place does not change; another actor's event does not.
  const pose = scenesAfter([
    ...characterSequence().slice(0, 2),
    ev('publish', [2, 1001, 0], { actor: { peer: A }, target: D1, others: [], paths: ['src/a.ts'], n: 1, state: 'closed', checks: 'pass', origin: 'human' }),
    ev('pose_relaxed', [70, 1002, 0], { actor: { peer: A } }),
    ev('publish', [75, 1001, 0], { actor: { peer: B }, target: D2, others: [], paths: ['src/b.ts'], n: 1, state: 'closed', checks: 'pass', origin: 'human' }),
    ev('publish', [80, 1001, 0], { actor: { peer: A }, target: D1, others: [], paths: ['src/a.ts'], n: 1, state: 'closed', checks: 'pass', origin: 'human' }),
  ]);
  assert.deepEqual([pose[2]!.characters.get(A)!.place, pose[2]!.characters.get(A)!.pose], [chair(D1), 'sit']);
  assert.deepEqual([pose[3]!.characters.get(A)!.place, pose[3]!.characters.get(A)!.pose], [chair(D1), 'relaxed']);
  assert.equal(pose[4]!.characters.get(A)!.pose, 'relaxed', 'another actor\'s publish');
  assert.deepEqual([pose[5]!.characters.get(A)!.place, pose[5]!.characters.get(A)!.pose], [chair(D1), 'sit'], 'its own publish at the same chair');
});

test('T-VIZ-placement: recency compares board positions, not heights', () => {
  const events = recencySequence();
  const s = scenesAfter(events);
  // Height 20: the pet's claim op (sub 1) and A's human publish (sub 1,001). The publish is newer: precedence 2.
  assert.equal(events[5]!.height, events[4]!.height);
  assert.deepEqual(s[5]!.characters.get(A)!.place, chair(D1));
  assert.deepEqual(s[5]!.pets.get(SA1)!.lastClaimOp, { height: 20, sub: 1, k: 0 });
  // Height 30: two publishes at one height order by k: C (k = 1) is the most recent publisher.
  assert.deepEqual(seating(s[7]!, D3), { chair: P(C), visitors: [P(B)], more: 0 });
  // A claim op at a later height beats the publish: supervising.
  assert.deepEqual(s[8]!.characters.get(A)!.place, { at: 'beside', desk: D2 });
});

test('T-VIZ-placement: pet precedence: open request > newest HELD claim\'s chair > granted stool > newest change-set target > behind its character', () => {
  const s = scenesAfter(petSequence());
  const p = (i: number): Place => s[i]!.pets.get(SA1)!.place;
  assert.deepEqual(p(2), { at: 'behind', peer: A }, 'no history: behind its character');
  assert.deepEqual(p(4), chair(D1), 'its change-set target');
  assert.deepEqual(p(6), { at: 'stool', desk: D2 }, 'a stool at a claim it was granted');
  assert.equal(s[6]!.pets.get(SA1)!.pose, 'sit');
  assert.deepEqual(seating(s[6]!, D2), { chair: S(SB1), visitors: [], more: 0 }, 'a stool is not a visitor tile');
  assert.deepEqual(p(7), chair(D3), 'its HELD claim\'s chair');
  assert.deepEqual(p(8), chair(D4), 'its newest HELD claim\'s chair');
  assert.deepEqual(p(9), { at: 'facing', actor: S(SB1), desk: D2 }, 'its open request');
  assert.deepEqual(p(10), { at: 'facing', actor: S(SB1), desk: D2 }, 'a status keeps the request open');
  assert.equal(s[10]!.requests.get('R0000000B')!.status, 'asked');
  assert.deepEqual(p(11), { at: 'facing', actor: S(SB1), desk: D2 }, 'an event at another desk moves nobody');
  assert.ok(s[11]!.desks.get(D3)!.lastEvent! > s[11]!.desks.get(D4)!.lastEvent!, 'desk 3 now has the later event');
  assert.deepEqual(p(12), chair(D4), 'declined: back to the desk of its newest HELD claim, not the desk with the latest event');
  assert.deepEqual(p(13), chair(D3));
  assert.deepEqual(p(14), { at: 'stool', desk: D2 });
  assert.deepEqual(p(15), chair(D1), 'the grant ended: its newest change-set target');
  assert.deepEqual(p(16), { at: 'facing', actor: S(SB1), desk: D2 });
  assert.deepEqual(p(17), chair(D1), 'returned: it walks back');
  assert.equal(s[17]!.requests.size, 0);
  for (const sc of s) for (const seat of sc.pets.keys()) assert.deepEqual(petPlace(sc, seat, OFFICE), sc.pets.get(seat)!.place);
  // A seat with no pet in the scene: no owner is known (ids are opaque), so the home spot after every listed peer; never a throw.
  assert.deepEqual(petPlace(s[0]!, 'Q7KM2Z', OFFICE), home(OFFICE.homeOrder.length));
  assert.deepEqual(petPlace(s[17]!, SEAT(F, 9), OFFICE), home(6));
});

test('T-VIZ-placement: only request_open puts an actor facing another actor', () => {
  const placesOf = (s: Scene): Map<string, Place> => new Map([
    ...[...s.characters].map(([peer, c]) => [actorKey({ peer }), c.place] as const),
    ...[...s.pets].map(([seat, p]) => [actorKey({ seat }), p.place] as const),
  ]);
  let facings = 0;
  const check = (name: string, events: readonly SceneEvent[], layout = OFFICE): void => {
    const scenes = scenesAfter(events, layout);
    events.forEach((e, i) => {
      const before = placesOf(i === 0 ? START : scenes[i - 1]!);
      for (const [key, place] of placesOf(scenes[i]!)) {
        if (place.at !== 'facing' || isDeepStrictEqual(before.get(key), place)) continue;
        facings++;
        assert.equal(e.kind, 'request_open', `${name}[${i}] ${e.kind} put ${key} facing another actor`);
        if (e.kind === 'request_open') assert.equal(actorKey(e.from), key);
      }
    });
  };
  for (const [name, make] of HAND_SEQUENCES) check(name, make());
  assert.ok(facings >= 3, 'the sequences do walk actors to other actors');
  // Open requests whose requester is not at them: a pet spawned after its request was filed, a character back from a
  // ghost or an absence. None of them walks to the holder.
  const edge = scenesAfter(requestEdgeSequence());
  assert.deepEqual(edge[3]!.pets.get(SA1)!.place, { at: 'behind', peer: A });
  assert.deepEqual(edge[4]!.characters.get(A)!.place, { at: 'facing', actor: P(B), desk: D2 });
  for (const i of [5, 6, 7, 8]) assert.deepEqual(edge[i]!.characters.get(A)!.place, home(0), `after event ${i}`);
  assert.deepEqual([5, 6, 7, 8].map((i) => [edge[i]!.characters.get(A)!.ghost, edge[i]!.characters.get(A)!.absent]),
    [[true, false], [false, false], [false, true], [false, false]], 'person_ghost, person_unghost, person_absent, person_enter');
  assert.equal(edge[8]!.requests.size, 2, 'both requests are still open');
  // And over random events of every kind: requests opened before their requester exists, ghosts, absences, returns.
  fc.assert(fc.property(eventsArb({ minLength: 1 }), (events) => check('random', events, RANDOM_OFFICE)), { numRuns: 100, seed: 0xface });
});

test('targetDesk: most paths, then the actor\'s last desk, then the first desk key; the other desks ascending', () => {
  const layout = officeOf(['src/z.ts', 'src/a.ts', 'lib/m.ts']);   // 1 src/z.ts, 2 src/a.ts, 3 lib/m.ts
  assert.deepEqual(targetDesk([1, 2, 2, 3], layout, null), { target: 2, others: [1, 3] });
  assert.deepEqual(targetDesk([1, 1, 2, 2, 3], layout, 1), { target: 1, others: [2, 3] }, 'a tie goes to the desk it sat at most recently');
  assert.deepEqual(targetDesk([1, 1, 2, 2, 3], layout, 3), { target: 2, others: [1, 3] }, 'a last desk outside the tie does not count; then the first key');
  assert.deepEqual(targetDesk([3, 2, 1], layout, null), { target: 3, others: [1, 2] }, "'lib/m.ts' is the first key");
  assert.deepEqual(targetDesk([2], layout, 1), { target: 2, others: [] });
  assert.deepEqual(targetDesk([], layout, 1), { target: BIG_TABLE, others: [] });
});

test('homeSpot is the index in homeOrder; a peer the layout does not list stands after every listed one', () => {
  assert.deepEqual(PEERS.map((p) => homeSpot(OFFICE, p)), [0, 1, 2, 3, 4, 5]);
  assert.equal(homeSpot(OFFICE, '9'.repeat(32)), 6);
});
