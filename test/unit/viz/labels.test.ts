// Plan 8a Task 5: health and place labels (R-V56; 10-product sec. 3.14; 12 sec. 1.5 item 5, sec. 3.5.4; VIZ-17): phOf's precedence,
// never PH_OFFLINE for a teammate; placeLabel's "last shared here" and "holding", never a working-on wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { actorKey, type ActorRef, type Position } from '../../../src/viz/model/events.js';
import { phOf, placeLabel, type PlaceLabel } from '../../../src/viz/model/labels.js';
import type { CharacterState, PetState } from '../../../src/viz/model/scene.js';
import { ev } from '../../helpers/vizEvents.js';
import { A, B, D1, D2, HAND_SEQUENCES, OFFICE, SA1, SB1, SD1, SE1, chairsSequence, scenesAfter } from '../../helpers/vizScene.js';

const pos = (height: number): Position => ({ height, sub: 0, k: 0 });
function character(o: Partial<CharacterState> = {}): CharacterState {
  return { place: { at: 'home', spot: 0 }, pose: 'idle', lastPublish: null, lastDesk: null, lastClaimOp: null, ghost: false, absent: false, frozen: null, slowedUntil: null, rules: false, credit: false, ...o };
}

test('phOf: left, absent, frozen (PAUSED \u{2192} PH_PAUSED, NOHOOKS \u{2192} PH_NOT_COORDINATED, other or \'?\' \u{2192} PH_FROZEN), slowed, ok \u{2014} in that precedence; a ghost has no label; no input gives PH_OFFLINE', () => {
  const at = pos(100);
  const all = character({ ghost: true, absent: true, frozen: 'PAUSED', slowedUntil: 200 });
  assert.equal(phOf(all, 'left', at), 'PH_LEFT', 'left first');
  assert.equal(phOf(undefined, 'left', at), 'PH_LEFT', 'a left peer has no character');
  assert.equal(phOf(all, 'absent', at), 'PH_PRESUMED_ABSENT');
  assert.equal(phOf(character({ absent: true }), 'active', at), 'PH_OK', 'only the status says presumed absent (R-V56), not the scene\'s flag');
  assert.equal(phOf(character({ frozen: 'PAUSED', slowedUntil: 200, ghost: true }), 'active', at), 'PH_PAUSED');
  assert.equal(phOf(character({ frozen: 'NOHOOKS' }), 'active', at), 'PH_NOT_COORDINATED');
  for (const r of ['EPOCH', 'MASS', 'INCIDENT', 'CONFIG', '?']) assert.equal(phOf(character({ frozen: r }), 'active', at), 'PH_FROZEN', r);
  assert.equal(phOf(character({ slowedUntil: 101, ghost: true }), 'active', at), 'PH_SLOWED');
  assert.equal(phOf(character({ slowedUntil: 100 }), 'active', at), 'PH_OK', 'slowed ends at until');
  assert.equal(phOf(character({ ghost: true }), 'active', at), null, 'a ghost has no label');
  assert.equal(phOf(character(), 'active', at), 'PH_OK');
  assert.equal(phOf(undefined, 'active', at), 'PH_OK');
  assert.equal(phOf(undefined, 'absent', at), 'PH_PRESUMED_ABSENT');

  const stateArb = fc.record({
    status: fc.constantFrom('active', 'left', 'absent') as fc.Arbitrary<'active' | 'left' | 'absent'>,
    c: fc.option(fc.record({
      ghost: fc.boolean(), absent: fc.boolean(), frozen: fc.option(fc.constantFrom('PAUSED', 'NOHOOKS', 'EPOCH', 'MASS', '?', 'UI_VIZ_LINK_REUSED'), { nil: null }),
      slowedUntil: fc.option(fc.integer({ min: 0, max: 400 }), { nil: null }),
    }), { nil: undefined }),
    h: fc.integer({ min: 0, max: 400 }),
  });
  fc.assert(
    fc.property(stateArb, ({ status, c, h }) => {
      const ch = c === undefined ? undefined : character(c);
      const got = phOf(ch, status, pos(h));
      const slowed = ch !== undefined && ch.slowedUntil !== null && h < ch.slowedUntil;
      const other = status !== 'active' || (ch?.frozen ?? null) !== null;
      assert.notEqual(got, 'PH_OFFLINE');
      assert.equal(got === 'PH_PRESUMED_ABSENT', status === 'absent', 'PH_PRESUMED_ABSENT exactly for the absent status');
      assert.ok(got === null || ['PH_OK', 'PH_PAUSED', 'PH_FROZEN', 'PH_NOT_COORDINATED', 'PH_PRESUMED_ABSENT', 'PH_LEFT', 'PH_SLOWED'].includes(got));
      // PH_SLOWED exactly when the peer is slowed and no other label applies (10-product sec. 3.14).
      assert.equal(got === 'PH_SLOWED', slowed && !other);
      if (other) assert.notEqual(got, null, 'a ghost loses only to "no label" when nothing else applies');
      if (got === null) assert.ok(ch?.ghost === true && !slowed && !other);
    }),
    { numRuns: 300, seed: 0x9a1 },
  );
});

test('T-VIZ-placement: a seated publisher is labelled UI_VIZ_LAST_SHARED_HERE with its path and height, a HELD claim holder UI_VIZ_HOLDING, never a working-on code', () => {
  const s = scenesAfter(chairsSequence());
  const label = (i: number, a: ActorRef): PlaceLabel | null => placeLabel(s[i]!, a, OFFICE);
  assert.equal(label(5, { peer: A }), null, 'at home: not seated');
  assert.deepEqual(label(8, { peer: A }), { code: 'UI_VIZ_LAST_SHARED_HERE', path: 'src/a.ts', height: 10 });
  assert.equal(s[10]!.characters.get(A)!.place.at, 'visitor');
  assert.equal(label(10, { peer: A }), null, 'standing on a visitor tile of the desk it shared at is not sitting');
  assert.deepEqual(label(11, { seat: SD1 }), { code: 'UI_VIZ_HOLDING', label: 'parse' });
  assert.deepEqual(label(12, { seat: SE1 }), { code: 'UI_VIZ_HOLDING', label: 'lex' });
  assert.equal(label(14, { seat: SE1 }), null, 'a STALE claim is not held; the pet stands behind its character');
  assert.equal(placeLabel(s[14]!, { peer: '9'.repeat(32) }, OFFICE), null, 'no such actor');

  // Two tags on one desk sharing `simple` show `qualname` (12 sec. 3.5.4 chair tags); a label-less claim holds `null`.
  const tags = scenesAfter([
    ev('person_enter', [1, 1, 0], { peer: A }),
    ev('pet_spawn', [2, 1001, 0], { seat: SA1, owner: A }),
    ev('claim_take', [3, 1, 0], { claimId: 'q1', seat: SA1, desk: D2, order: 4, label: { simple: 'run', qualname: 'Job.run' }, granularity: 'symbol', lines: [4, 9], otherRules: false }),
    ev('claim_take', [3, 1, 1], { claimId: 'q2', seat: SA1, desk: D2, order: 20, label: { simple: 'run', qualname: 'Task.run' }, granularity: 'symbol', lines: [20, 29], otherRules: false }),
    ev('claim_take', [4, 1, 0], { claimId: 'q3', seat: SA1, desk: D1, order: 1, label: null, granularity: 'file', lines: null, otherRules: false }),
  ]);
  assert.deepEqual(placeLabel(tags[3]!, { seat: SA1 }, OFFICE), { code: 'UI_VIZ_HOLDING', label: 'Task.run' }, 'its newest HELD claim at the desk');
  assert.deepEqual(placeLabel(tags[4]!, { seat: SA1 }, OFFICE), { code: 'UI_VIZ_HOLDING', label: null });

  // A stool is a seat: a pet sitting on a granted stool at the desk it last shared at.
  const stool = scenesAfter([
    ev('person_enter', [1, 1, 0], { peer: A }),
    ev('person_enter', [1, 2, 0], { peer: B }),
    ev('pet_spawn', [2, 1001, 0], { seat: SA1, owner: A }),
    ev('pet_spawn', [2, 1001, 1], { seat: SB1, owner: B }),
    ev('publish', [3, 1001, 0], { actor: { seat: SA1 }, target: D2, others: [], paths: ['src/b.ts'], n: 1, state: 'closed', checks: 'pass', origin: 'prompt' }),
    ev('claim_take', [4, 1, 0], { claimId: 'g1', seat: SB1, desk: D2, order: 1, label: null, granularity: 'file', lines: null, otherRules: false }),
    ev('grant_start', [5, 1, 0], { claimId: 'g1', grantee: { seat: SA1 } }),
  ]);
  assert.deepEqual(stool[6]!.pets.get(SA1)!.place, { at: 'stool', desk: D2 });
  assert.deepEqual(placeLabel(stool[6]!, { seat: SA1 }, OFFICE), { code: 'UI_VIZ_LAST_SHARED_HERE', path: 'src/b.ts', height: 3 });

  // Over every event of this task's sequences: only the two codes or null, and a label only for an actor at a desk.
  const codes = new Set<string>();
  for (const [, make] of HAND_SEQUENCES) {
    for (const sc of scenesAfter(make())) {
      const actors: Array<[ActorRef, CharacterState | PetState]> = [];
      for (const [peer, c] of sc.characters) actors.push([{ peer }, c]);
      for (const [seat, p] of sc.pets) actors.push([{ seat }, p]);
      for (const [a, st] of actors) {
        const l = placeLabel(sc, a, OFFICE);
        if (l === null) continue;
        codes.add(l.code);
        assert.ok(l.code === 'UI_VIZ_LAST_SHARED_HERE' || l.code === 'UI_VIZ_HOLDING', `${actorKey(a)}: ${String(l.code)}`);
        assert.ok(st.place.at === 'chair' || st.place.at === 'stool', `${actorKey(a)} labelled at ${st.place.at}`);
      }
    }
  }
  assert.deepEqual([...codes].sort(), ['UI_VIZ_HOLDING', 'UI_VIZ_LAST_SHARED_HERE']);
});
