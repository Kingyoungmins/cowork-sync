// Plan 8a Task 5: pets in the scene (12 sec. 3.4 pet rows, sec. 3.6 seat variants; VIZ-21, R-V47): exactly one pet per seat key,
// its owner from the event (never from the seat id), variants in first-footprint order per owner, start-scene pets in
// sorted seat-key order with the owner ownerOfSeatKey gives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { initialFoldState, type FoldState, type PeerRec } from '../../../src/board/fold.js';
import type { PeerRef, SceneEvent, SeatRef } from '../../../src/viz/model/events.js';
import { settlePlaces } from '../../../src/viz/model/placement.js';
import { reduceScene, type Scene } from '../../../src/viz/model/scene.js';
import { ownerOfSeatKey, startScene } from '../../../src/viz/model/start.js';
import { DRAFT_PROTOCOL, ev } from '../../helpers/vizEvents.js';
import {
  A, B, C, D2, K1, K2, K3, K4, KB, OFFICE, SA1, SA2, SA3, SB1, SC1, SEAT,
  idsOf, petLifeSequence, renameScene, renameValue, reversingRename, scenesAfter, variantSequence,
} from '../../helpers/vizScene.js';
import { fixtureFrames, fixtureTimeline, loadRowFixture, peerOf, ROW_FIXTURE_DIR, seatKeyOf } from '../../helpers/vizRows.js';

const liveSeats = (s: Scene): SeatRef[] => [...s.pets].filter(([, p]) => p.live).map(([k]) => k).sort();

test('T-VIZ-pets (reducer): exactly one pet per seat key', () => {
  const events = petLifeSequence();
  const scenes = scenesAfter(events);
  // The model: a seat's pet exists from its first spawn; it is live from a spawn until its poof; its owner is the event's.
  const live = new Set<SeatRef>();
  const known = new Map<SeatRef, PeerRef>();
  events.forEach((e: SceneEvent, i) => {
    if (e.kind === 'pet_spawn') {
      live.add(e.seat);
      known.set(e.seat, e.owner);
    }
    if (e.kind === 'pet_poof') live.delete(e.seat);
    const s = scenes[i]!;
    assert.deepEqual(liveSeats(s), [...live].sort(), `live pets after ${i} ${e.kind}`);
    assert.deepEqual([...s.pets.keys()].sort(), [...known.keys()].sort(), `one entry per seat key after ${i}`);
    for (const [seat, p] of s.pets) assert.equal(p.owner, known.get(seat), `owner of ${seat}`);
  });
  // seat_start, then a repeated spawn of the same seat: still one pet, unchanged.
  assert.deepEqual(scenes[5]!.pets, scenes[4]!.pets);
  // A footprint spawn; an SS_* health label kept on the pet until its poof.
  assert.equal(scenes[7]!.pets.get(SA2)!.ssCode, 'SS_NO_HOOKS');
  assert.equal(scenes[9]!.pets.get(SA2)!.ssCode, 'SS_NO_HOOKS');
  // seat_end and epoch retirement (respawn): poofed, the label gone.
  assert.equal(scenes[8]!.pets.get(SA1)!.live, false);
  assert.equal(scenes[10]!.pets.get(SA2)!.live, false);
  assert.equal(scenes[10]!.pets.get(SA2)!.ssCode, null);
  assert.equal(scenes[11]!.pets.get(SA3)!.variant, 2, 'the third seat of A in the segment');
  // presume_absent and leave. (The owner of a footprint-only seat becoming a ghost: the builder's own pet_poof, in the
  // 'T-VIZ-pets (builder)' test below, never a hand-written one.)
  assert.equal(scenes[15]!.pets.get(SB1)!.live, false);
  assert.equal(scenes[16]!.claims.get('cl-b1')!.stale, true);
  assert.equal(scenes[20]!.pets.get(SC1)!.live, false);
  assert.equal(scenes[21]!.claims.has('cl-c1'), false);
  // The same seat spawned again: one pet, live, its variant kept.
  assert.deepEqual(scenes[22]!.pets.get(SA1), { place: { at: 'behind', peer: A }, pose: 'idle', lastPublish: null, lastDesk: null, lastClaimOp: null, owner: A, variant: 0, live: true, ssCode: null });
  // A poofed pet stands nowhere: no chair, no visitor tile, never counted.
  for (const s of scenes) for (const [, p] of s.pets) if (!p.live) assert.equal(p.place.at, 'behind');

  // Seat ids that are 6-character handles with no '/' (and peers renamed) reduce the same: the owner comes from the event.
  const ids = idsOf(events);
  const r = reversingRename([...ids.peers, ...OFFICE.homeOrder], ids.seats);
  assert.ok(ids.seats.map((s) => r.seat(s)).every((h) => /^[0-9A-HJKMNP-TV-Z]{6}$/.test(h)));
  const renamedScenes = scenesAfter(events.map((e) => renameValue(e, r)), { ...OFFICE, homeOrder: OFFICE.homeOrder.map((p) => r.peer(p)) });
  renamedScenes.forEach((s, i) => assert.deepEqual(s, renameScene(scenes[i]!, r), `after ${i}`));
});

test('T-VIZ-pets (builder): the owner of a footprint-only seat becoming a ghost \u{2192} the timeline builder poofs that pet (VIZ-21; the derived ghost row, sub 1,002, right after person_ghost, in ascending seat key, uncarded); a seat live in the fold keeps its pet; a later footprint spawns it again', () => {
  const fx = loadRowFixture(join(process.cwd(), ROW_FIXTURE_DIR, 'ghost_footprint.json'));
  const { timeline: t, unknown } = fixtureTimeline(fx);
  const PB = peerOf('B');
  const S1 = seatKeyOf('B', 'S1'), S2 = seatKeyOf('B', 'S2'), S3 = seatKeyOf('B', 'S3');
  const alias = new Map<string, string>([[peerOf('A'), 'A'], [PB, 'B'], [S1, 'B/S1'], [S2, 'B/S2'], [S3, 'B/S3']]);
  const brief = (e: SceneEvent): string => {
    const who = 'peer' in e && typeof e.peer === 'string' ? e.peer : 'seat' in e && typeof e.seat === 'string' ? e.seat : null;
    const owner = e.kind === 'pet_spawn' || e.kind === 'pet_poof' ? ` of ${alias.get(e.owner) ?? e.owner}` : '';
    return `${e.height}.${e.sub}.${e.k} ${e.kind}${who === null ? '' : ` ${alias.get(who) ?? who}`}${owner}`;
  };
  // The fixture's fold facts at the ghost height G: B's last board commit is at 3, so B leaves rankedSet at 203; S1 was never
  // folded (a footprint only), S2 is live in the fold (seat_start), S3's folded seat ended (seat_end) before a footprint re-spawned it.
  const G = 203;
  const f = fixtureFrames(fx)[G]!;
  assert.ok(f.before.peers[PB] !== undefined && !Object.hasOwn(f.after.seats, S1));
  assert.equal(f.after.seats[S2]?.status, 'live');
  assert.equal(f.after.seats[S3]?.status, 'ended');
  // The builder's events: the footprint spawns, then at G the ghost and one poof per footprint-only seat, then the respawn at G + 1.
  assert.deepEqual(t.events.filter((e) => e.kind === 'pet_spawn' || e.kind === 'pet_poof' || e.kind === 'person_ghost' || e.kind === 'person_unghost').map(brief), [
    '2.1.0 pet_spawn B/S2 of B', '2.2.0 pet_spawn B/S3 of B', '2.1001.0 pet_spawn B/S1 of B',
    '3.1.0 pet_poof B/S3 of B', '3.1001.0 pet_spawn B/S3 of B',
    '203.1002.0 person_ghost B', '203.1002.1 pet_poof B/S1 of B', '203.1002.2 pet_poof B/S3 of B',
    '204.1001.0 pet_spawn B/S1 of B', '204.1002.0 person_unghost B',
  ]);
  assert.deepEqual(t.events.filter((e) => e.height === G).map(brief), ['203.1002.0 person_ghost B', '203.1002.1 pet_poof B/S1 of B', '203.1002.2 pet_poof B/S3 of B']);
  assert.deepEqual(t.cards.filter((c) => c.at.height === G), [], 'the ghost row is uncarded, its poofs too');
  assert.deepEqual(unknown, []);
  // The scenes: exactly one pet per seat key; at G the footprint-only pets are gone while the ghost walks home, S2 stays.
  const end = (h: number): Scene => reduceScene(t, { height: h, sub: Number.MAX_SAFE_INTEGER, k: 0 });
  const live = (s: Scene): string[] => [...s.pets].filter(([, p]) => p.live).map(([k]) => alias.get(k) ?? k).sort();
  assert.deepEqual(live(end(G - 1)), ['B/S1', 'B/S2', 'B/S3']);
  assert.equal(end(G - 1).characters.get(PB)!.ghost, false);
  assert.deepEqual(live(end(G)), ['B/S2']);
  assert.equal(end(G).characters.get(PB)!.ghost, true);
  assert.deepEqual(live(end(G + 1)), ['B/S1', 'B/S2'], 'a later footprint spawns S1 again');
  assert.equal(end(G + 1).characters.get(PB)!.ghost, false);
  for (const h of [G - 1, G, G + 1]) assert.deepEqual([...end(h).pets.keys()].sort(), [S1, S2, S3].sort(), `one pet per seat key at ${h}`);
});

test('pet_poof puts a pet behind its owner once, idle; settling then reads nothing of a poofed pet but live, so its cost does not grow with the number of poofed pets', () => {
  const extra = Array.from({ length: 40 }, (_, i) => SEAT(A, 0x100 + i));
  const events: SceneEvent[] = [
    ev('person_enter', [1, 1, 0], { peer: A }),
    ev('pet_spawn', [2, 1001, 0], { seat: SA1, owner: A }),
    ev('publish', [3, 1001, 0], { actor: { seat: SA1 }, target: D2, others: [], paths: ['src/b.ts'], n: 1, state: 'closed', checks: 'pass', origin: 'prompt' }),
    ev('pose_relaxed', [70, 1002, 0], { actor: { seat: SA1 } }),
    ev('pet_poof', [71, 1, 0], { seat: SA1, owner: A }),
    ...extra.flatMap((seat, i) => [ev('pet_spawn', [80 + i, 1001, 0], { seat, owner: A }), ev('pet_poof', [80 + i, 1001, 1], { seat, owner: A })]),
  ];
  const scenes = scenesAfter(events);
  assert.deepEqual([scenes[3]!.pets.get(SA1)!.place, scenes[3]!.pets.get(SA1)!.pose], [{ at: 'chair', desk: D2 }, 'relaxed']);
  const poofed = scenes[4]!.pets.get(SA1)!;
  assert.deepEqual([poofed.place, poofed.pose, poofed.live], [{ at: 'behind', peer: A }, 'idle', false]);
  assert.equal(scenes[4]!.desks.get(D2)!.chair, null, 'its chair is free');
  const last = scenes.at(-1)!;
  assert.equal([...last.pets.values()].filter((p) => !p.live).length, 41);
  assert.deepEqual(extra.map((seat) => last.pets.get(seat)!.variant), extra.map((_, i) => i + 1), 'variants still count poofed pets');

  // Every poofed pet behind a proxy that counts reads of anything but `live`, and every write.
  const s = structuredClone(last);
  let touched = 0;
  const places = new Map<SeatRef, object>();
  for (const [seat, p] of s.pets) {
    places.set(seat, p.place);
    s.pets.set(seat, new Proxy(p, {
      get: (t, k, r) => {
        if (k !== 'live') touched++;
        return Reflect.get(t, k, r) as unknown;
      },
      set: (t, k, v, r) => {
        touched++;
        return Reflect.set(t, k, v, r);
      },
    }));
  }
  settlePlaces(s, OFFICE, null, null);
  assert.equal(touched, 0, 'settlePlaces read or wrote a poofed pet');
  for (const [seat, place] of places) assert.equal(s.pets.get(seat)!.place, place, `${seat}: the same place object`);
});

test('T-VIZ-pets: seat variants follow the first footprint per owner within a segment; start-scene pets take sorted seat-key order and the owner ownerOfSeatKey gives', () => {
  const s = scenesAfter(variantSequence());
  const v = (i: number, seat: SeatRef): number => s[i]!.pets.get(seat)!.variant;
  // Spawned K3, K1, K2 (not key order): variants 0, 1, 2; another owner's seats count on their own.
  assert.deepEqual([v(5, K3), v(5, K1), v(5, K2), v(5, KB)], [0, 1, 2, 0]);
  assert.equal(v(7, K4), 3, 'a later seat follows every seat the owner had in the segment, poofed or not');
  assert.equal(v(8, K1), 1, 'a seat spawned again keeps its variant');
  assert.equal(s[8]!.pets.get(K1)!.live, true);

  // The start scene: the live seats whose owner is drawn, in sorted seat-key order per owner.
  const rec = (status: PeerRec['status']): PeerRec => ({
    epoch: 'e1'.padStart(32, '0'), status, retired_epochs: [], display: 'x', plugin_version: '0.2.0', plugin_sha: 'f'.repeat(64), regionSpec: 'rs-1',
    config_fingerprint: { filters: {}, autocrlf: '', eol_attrs: '', git: '2.47.1' }, coauthor_optin: false, last_seq: 1, last_height: 10,
  });
  const st: FoldState = { ...initialFoldState(DRAFT_PROTOCOL), height: 10 };
  st.peers = { [A]: rec('active'), [B]: rec('active'), [C]: rec('left') };
  st.seats = {
    [K3]: { status: 'live', permission_mode: 'default' },
    [K1]: { status: 'live', permission_mode: 'default' },
    [K2]: { status: 'ended', permission_mode: 'default', ended_height: 5 },
    [KB]: { status: 'live', permission_mode: 'plan' },
    [SC1]: { status: 'live', permission_mode: 'default' },          // its owner left: not drawn, so no pet
  };
  const start = startScene(st, 256, OFFICE);
  assert.deepEqual([...start.pets.keys()].sort(), [K1, K3, KB].sort());
  assert.deepEqual([K1, K3, KB].map((k) => start.pets.get(k)!.variant), [0, 1, 0], 'K1 < K3 by key');
  for (const [seat, p] of start.pets) {
    assert.equal(p.owner, ownerOfSeatKey(seat));
    assert.equal(p.live, true);
    assert.deepEqual(p.place, { at: 'behind', peer: p.owner });
  }
  assert.equal(ownerOfSeatKey(K1), A);
  assert.equal(ownerOfSeatKey(`${B}/e/s`), B);
  assert.equal(ownerOfSeatKey('Q7KM2Z'), 'Q7KM2Z', 'no separator: the whole key');
});
