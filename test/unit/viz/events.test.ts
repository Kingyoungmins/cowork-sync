// Plan 8a Task 4: the closed scene-event set and the model types of 12 §3.3.7 (events.ts, scene.ts, cards.ts) and the
// two BoardDraft builders of frame.ts (R-V02, R-V19). Type-level checks are `const` assignments the typecheck verifies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BoardDraft } from '../../../src/board/boardCommit.js';
import { foldCommit, initialFoldState } from '../../../src/board/fold.js';
import { genesisProtocol } from '../../../src/board/protocol.js';
import { CARD_GROUP } from '../../../src/viz/model/cards.js';
import {
  actorKey,
  SCENE_EVENT_KINDS,
  SUB_CODE,
  SUB_DERIVED,
  SUB_ROOM,
  type SceneEvent,
  type SceneEventKind,
} from '../../../src/viz/model/events.js';
import { noopDraft, toDraft, ZERO_PEER } from '../../../src/viz/model/frame.js';
import { comparePos, DIM_HEIGHTS, emptyScene, RELAX_HEIGHTS, SIGN_HEIGHTS } from '../../../src/viz/model/scene.js';
import { DRAFT_LIVE_CODE, DRAFT_PROTOCOL, draft, ev } from '../../helpers/vizEvents.js';

/** true exactly when A and B are the same type (mutual assignability, no distribution). */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

const PEER = 'a1'.repeat(16);
const EPOCH = 'e1'.repeat(16);
const SEAT = `${PEER}/${EPOCH}/${'5e'.repeat(16)}`;

/**
 * The closed set in §3.4 order: the "Scene event" column read top to bottom, each kind at its first mention
 * (secondary events of a row, such as the pet_poof and claim_release of a respawn, at that row).
 */
const EXPECTED_KINDS = [
  'room_open', 'person_enter', 'person_respawn', 'pet_poof', 'claim_release', 'person_badge', 'person_exit', 'pet_spawn',
  'publish', 'room_sign', 'person_freeze', 'person_thaw', 'person_slowed', 'room_badge', 'person_bang', 'conflict', 'box',
  'claim_take', 'claim_move', 'claim_stale', 'claim_reserve', 'grant_start', 'grant_end', 'request_open', 'request_status',
  'answer', 'note', 'person_absent', 'save', 'person_ghost', 'person_unghost', 'pose_relaxed',
] as const;

// Type level: every kind of the SceneEvent union is in the list and every listed kind is a union member.
const kindsExhaustive: Equals<(typeof EXPECTED_KINDS)[number], SceneEventKind> = true;
// R-V47: pet_spawn and pet_poof carry a required owner.
type PetEvent = Extract<SceneEvent, { kind: 'pet_spawn' | 'pet_poof' }>;
const petOwnerTyped: Equals<PetEvent['owner'], string> = true;
const petOwnerRequired: Record<string, never> extends Pick<PetEvent, 'owner'> ? false : true = true;

test('SCENE_EVENT_KINDS is exactly the closed set of 12 §3.4', () => {
  assert.equal(kindsExhaustive && petOwnerTyped && petOwnerRequired, true);
  assert.deepEqual([...SCENE_EVENT_KINDS], [...EXPECTED_KINDS]);
  assert.equal(SCENE_EVENT_KINDS.length, 32);
  assert.equal(new Set(SCENE_EVENT_KINDS).size, 32);
  assert.ok(Object.isFrozen(SCENE_EVENT_KINDS));
  // Positions: sub 0 room events, 1 + line index op events, 1,001 code events, 1,002 derived events (12 §3.3.5).
  assert.deepEqual([SUB_ROOM, SUB_CODE, SUB_DERIVED], [0, 1_001, 1_002]);
  // pet_spawn and pet_poof carry their owner (R-V47): the reducer never parses a seat id.
  const spawn = ev('pet_spawn', [3, SUB_CODE, 0], { seat: SEAT, owner: PEER });
  const poof = ev('pet_poof', [4, 2, 1], { seat: SEAT, owner: PEER });
  assert.deepEqual(spawn, { height: 3, sub: SUB_CODE, k: 0, seed: 0, kind: 'pet_spawn', seat: SEAT, owner: PEER });
  assert.deepEqual(poof, { height: 4, sub: 2, k: 1, seed: 0, kind: 'pet_poof', seat: SEAT, owner: PEER });
  // @ts-expect-error owner is required on pet_poof (R-V47)
  ev('pet_poof', [4, 2, 1], { seat: SEAT });
  // A grouped kind takes its member's fields (person_enter | person_respawn | … share { peer }).
  assert.deepEqual(ev('person_ghost', [9, SUB_DERIVED, 0], { peer: PEER }), { height: 9, sub: SUB_DERIVED, k: 0, seed: 0, kind: 'person_ghost', peer: PEER });
});

test('actorKey: p:<peer> for a character and s:<seat> for a pet', () => {
  assert.equal(actorKey({ peer: PEER }), `p:${PEER}`);
  assert.equal(actorKey({ seat: SEAT }), `s:${SEAT}`);
  // A peer id can never read as a seat key and back: the prefixes keep the two kinds apart.
  assert.notEqual(actorKey({ peer: SEAT }), actorKey({ seat: SEAT }));
});

test('comparePos orders positions lexicographically by (height, sub, k); emptyScene holds nothing', () => {
  const ps = [
    { height: 2, sub: 0, k: 0 },
    { height: 1, sub: SUB_DERIVED, k: 3 },
    { height: 1, sub: SUB_CODE, k: 10 },
    { height: 1, sub: 2, k: 1 },
    { height: 1, sub: 2, k: 0 },
    { height: 0, sub: SUB_ROOM, k: 0 },
  ];
  const sorted = [...ps].sort(comparePos);
  assert.deepEqual(sorted, [ps[5], ps[4], ps[3], ps[2], ps[1], ps[0]]);
  assert.equal(comparePos({ height: 7, sub: 1, k: 2 }, { height: 7, sub: 1, k: 2 }), 0);
  assert.ok(comparePos({ height: 7, sub: 1, k: 2 }, { height: 7, sub: 1, k: 3 }) < 0);
  assert.ok(comparePos({ height: 8, sub: 0, k: 0 }, { height: 7, sub: 1_002, k: 99 }) > 0);
  assert.deepEqual([SIGN_HEIGHTS, RELAX_HEIGHTS, DIM_HEIGHTS], [64, 64, 256]);

  const at = { height: 5, sub: SUB_CODE, k: 1 };
  const s = emptyScene(at);
  assert.deepEqual(s.at, at);
  assert.notEqual(s.at, at, 'the scene keeps its own copy of the position');
  assert.equal(s.badge, 'none');
  assert.equal(s.branchMovedAt, null);
  for (const m of [s.characters, s.pets, s.desks, s.claims, s.requests, s.boxes, s.bangs]) {
    assert.ok(m instanceof Map);
    assert.equal(m.size, 0);
  }
  assert.deepEqual(s.beat, []);
  assert.notEqual(emptyScene(at).characters, s.characters, 'every call builds new Maps');
});

test('CARD_GROUP maps every UI_VIZ_CARD_* code of 12 §3.11 to its §3.8 group', () => {
  const expected: Record<string, string> = {
    UI_VIZ_CARD_REQUEST: 'conversation', UI_VIZ_CARD_ANSWER: 'conversation', UI_VIZ_CARD_NOTE: 'conversation',
    UI_VIZ_CARD_JOIN: 'conversation', UI_VIZ_CARD_REJOIN: 'conversation', UI_VIZ_CARD_LEAVE: 'conversation',
    UI_VIZ_CARD_SEAT_START: 'conversation', UI_VIZ_CARD_SEAT_END: 'conversation', UI_VIZ_CARD_ABSENT: 'conversation',
    UI_VIZ_CARD_K4: 'conflict', UI_VIZ_CARD_CONFLICT: 'conflict', UI_VIZ_CARD_BREACH: 'conflict',
    UI_VIZ_CARD_PUBLISH: 'activity',
    UI_VIZ_CARD_ROOM_OPEN: 'system', UI_VIZ_CARD_VERSION: 'system', UI_VIZ_CARD_RULES: 'system', UI_VIZ_CARD_HEALTH: 'system',
    UI_VIZ_CARD_FREEZE: 'system', UI_VIZ_CARD_THAW: 'system', UI_VIZ_CARD_SLOWED: 'system', UI_VIZ_CARD_NONRETRYABLE: 'system',
    UI_VIZ_CARD_SAVE: 'system', UI_VIZ_CARD_BASE_MOVE: 'system', UI_VIZ_CARD_BOARD_FULL: 'system',
  };
  assert.deepEqual(Object.keys(CARD_GROUP).sort(), Object.keys(expected).sort());
  for (const [code, group] of Object.entries(expected)) assert.equal(CARD_GROUP[code], group, code);
  assert.equal(Object.keys(CARD_GROUP).length, 24);
  assert.ok(Object.isFrozen(CARD_GROUP));
  assert.equal(Object.getPrototypeOf(CARD_GROUP), null, 'a code lookup can never reach Object.prototype');
  assert.equal(CARD_GROUP['__proto__'], undefined);
  assert.equal(CARD_GROUP['toString'], undefined);
});

// Type level: BoardDraft has exactly the seven fields 8a fills (a Plan 2 change to BoardDraft fails here and in toDraft),
// and both builders return exactly BoardDraft.
const draftFields: Equals<keyof BoardDraft, 'liveCode' | 'writer' | 'cs' | 'protocol' | 'opsLines' | 'checkpoint' | 'heldIds'> = true;
const toDraftReturns: Equals<ReturnType<typeof toDraft>, BoardDraft> = true;
const noopDraftReturns: Equals<ReturnType<typeof noopDraft>, BoardDraft> = true;

test("toDraft and noopDraft build exactly Plan 2's BoardDraft fields", () => {
  assert.equal(draftFields && toDraftReturns && noopDraftReturns, true);
  const writer = { peer: PEER, epoch: EPOCH, seq: 4 };
  const cs = [{ csId: `${PEER}/human/1`, state: 'closed' as const, seq: 4, origin: 'human' as const, checks: 'pass' as const, paths: 2 }];
  const opsLines = ['{"id":"x"}', ''];
  const heldIds = ['01ARZ3NDEKTSV4RRFFQ69G5FAV'];
  const checkpoint = Buffer.from('{}');
  const input = { liveCode: 'ab'.repeat(20), writer, cs, protocol: DRAFT_PROTOCOL, opsLines, checkpoint, heldIds };
  const d = toDraft(input);
  assert.deepEqual(Object.keys(d).sort(), ['checkpoint', 'cs', 'heldIds', 'liveCode', 'opsLines', 'protocol', 'writer']);
  assert.deepEqual(d, { liveCode: 'ab'.repeat(20), writer, cs, protocol: DRAFT_PROTOCOL, opsLines, checkpoint, heldIds });
  // The draft owns its arrays: a later change to the caller's arrays does not reach it.
  opsLines.push('late');
  cs.pop();
  heldIds.length = 0;
  assert.deepEqual(d.opsLines, ['{"id":"x"}', '']);
  assert.equal(d.cs.length, 1);
  assert.deepEqual(d.heldIds, ['01ARZ3NDEKTSV4RRFFQ69G5FAV']);
  // liveCode must be an object id (BoardDraft.liveCode is an Oid).
  assert.throws(() => toDraft({ ...input, liveCode: 'not-an-oid' }));

  // R-V19: the no-op draft of an unreadable board commit keeps only protocol and liveCode.
  const n = noopDraft(d);
  assert.deepEqual(Object.keys(n).sort(), ['checkpoint', 'cs', 'heldIds', 'liveCode', 'opsLines', 'protocol', 'writer']);
  assert.deepEqual(n, { liveCode: d.liveCode, writer: null, cs: [], protocol: DRAFT_PROTOCOL, opsLines: [], checkpoint: null, heldIds: [] });
  assert.notEqual(n.protocol, d.protocol, 'a copy, so the no-op draft never aliases the previous one');

  // Both fold through Plan 2's own foldCommit; the no-op draft changes nothing but the height.
  const s0 = foldCommit(initialFoldState(genesisProtocol(12, 'rs-1')), draft({ writer: null }), ZERO_PEER).state;
  const s1 = foldCommit(s0, noopDraft(draft({ writer: null })), ZERO_PEER).state;
  assert.deepEqual({ ...s1, height: s0.height }, s0);
  assert.equal(s1.height, s0.height + 1);
  assert.equal(ZERO_PEER, '0'.repeat(32));
  assert.equal(draft({ writer: null }).liveCode, DRAFT_LIVE_CODE);
});
