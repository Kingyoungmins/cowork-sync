// Plan 8a Task 6: the 12 §3.4 card column and the §3.8 groups (cardFor; R-V42, R-V44, R-V45).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CARD_GROUP, cardFor, type Card, type SceneRow } from '../../../src/viz/model/cards.js';
import type { SceneEvent } from '../../../src/viz/model/events.js';
import { ev } from '../../helpers/vizEvents.js';

const P = 'a1'.repeat(16), Q = 'b2'.repeat(16);
const SEAT = `${P}/${'e1'.repeat(16)}/${'51'.repeat(16)}`;
const at: [number, number, number] = [7, 3, 2];
const publish = (paths: string[], target: number, others: number[], n: number): SceneEvent =>
  ev('publish', at, { actor: { peer: P }, target, others, paths, n, state: 'closed', checks: 'pass', origin: 'human' });

/** [row, event, the expected code (null: no card)] — every §3.4 row, including the rows 8a meets only as hand-written events. */
const ROWS: ReadonlyArray<[SceneRow, SceneEvent, string | null]> = [
  ['genesis', ev('room_open', [0, 0, 0], {}), 'UI_VIZ_CARD_ROOM_OPEN'],
  ['join_new', ev('person_enter', at, { peer: P }), 'UI_VIZ_CARD_JOIN'],
  ['join_back', ev('person_enter', at, { peer: P }), 'UI_VIZ_CARD_JOIN'],
  ['join_epoch', ev('person_respawn', at, { peer: P }), 'UI_VIZ_CARD_REJOIN'],
  ['join_epoch', ev('pet_poof', at, { seat: SEAT, owner: P }), null],
  ['join_epoch', ev('claim_release', at, { claimId: 'c1', reason: 'superseded' }), null],
  ['join_version', ev('person_badge', at, { actor: { peer: P }, badge: 'version', on: true, code: null }), 'UI_VIZ_CARD_VERSION'],
  ['join_rules', ev('person_badge', at, { actor: { peer: P }, badge: 'rules', on: true, code: null }), 'UI_VIZ_CARD_RULES'],
  ['join_rules', ev('person_badge', at, { actor: { peer: P }, badge: 'rules', on: false, code: null }), null],
  ['rules_change', ev('person_badge', at, { actor: { peer: P }, badge: 'rules', on: true, code: null }), 'UI_VIZ_CARD_RULES'],
  ['rules_change', ev('person_badge', at, { actor: { peer: P }, badge: 'rules', on: false, code: null }), null],
  ['join_credit', ev('person_badge', at, { actor: { peer: P }, badge: 'credit', on: true, code: null }), null],
  ['leave', ev('person_exit', at, { peer: P }), 'UI_VIZ_CARD_LEAVE'],
  ['leave', ev('pet_poof', at, { seat: SEAT, owner: P }), null],
  ['leave', ev('claim_release', at, { claimId: 'c1', reason: 'stop' }), null],
  ['seat_start', ev('pet_spawn', at, { seat: SEAT, owner: P }), 'UI_VIZ_CARD_SEAT_START'],
  ['seat_footprint', ev('pet_spawn', at, { seat: SEAT, owner: P }), null],
  ['seat_end', ev('pet_poof', at, { seat: SEAT, owner: P }), 'UI_VIZ_CARD_SEAT_END'],
  ['publish_cs', publish(['src/a.ts', 'src/b.ts'], 3, [5], 2), 'UI_VIZ_CARD_PUBLISH'],
  ['publish_big', publish([], 0, [], 300), 'UI_VIZ_CARD_PUBLISH'],
  ['publish_nocs', publish([], 0, [], 0), 'UI_VIZ_CARD_PUBLISH'],
  ['base_move', ev('room_sign', at, { sign: 'branch_moved' }), 'UI_VIZ_CARD_BASE_MOVE'],
  ['freeze', ev('person_freeze', at, { peer: P, reasonCode: 'EPOCH' }), 'UI_VIZ_CARD_FREEZE'],
  ['unfreeze', ev('person_thaw', at, { peer: P }), 'UI_VIZ_CARD_THAW'],
  ['slowed', ev('person_slowed', at, { peer: P, until: 187 }), 'UI_VIZ_CARD_SLOWED'],
  ['board_full', ev('room_badge', at, { level: 'full' }), 'UI_VIZ_CARD_BOARD_FULL'],
  ['board_full', ev('room_badge', at, { level: 'near_full' }), null],
  ['board_full', ev('room_badge', at, { level: 'none' }), null],
  ['health_other', ev('person_badge', at, { actor: { peer: P }, badge: 'health', on: true, code: 'BRANCH_ESCAPE' }), 'UI_VIZ_CARD_HEALTH'],
  ['nonretryable', ev('person_bang', at, { peer: P, bang: 'host' }), 'UI_VIZ_CARD_NONRETRYABLE'],
  ['hold_k4', ev('conflict', at, { conflict: 'k4', source: 'hold', on: { peer: P }, desk: 2, holdId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', cid: null, eventKind: null, line: null }), 'UI_VIZ_CARD_K4'],
  ['hold_k4', ev('box', at, { holdId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', owner: { peer: P }, holdKind: 'PIN', residence: 'ON_DISK', state: 'CONFLICTED', offer: 'none', desk: 2, localOnly: false, terminal: false }), null],
  ['hold_claim', ev('conflict', at, { conflict: 'claim', source: 'hold', on: { peer: P }, desk: 2, holdId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', cid: null, eventKind: null, line: { claimId: 'c1' } }), 'UI_VIZ_CARD_CONFLICT'],
  ['hold_t0', ev('conflict', at, { conflict: 'k7', source: 'hold', on: { peer: P }, desk: 2, holdId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', cid: null, eventKind: null, line: null }), 'UI_VIZ_CARD_CONFLICT'],
  ['hold_breach', ev('conflict', at, { conflict: 'breach', source: 'hold', on: { peer: P }, desk: 2, holdId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', cid: null, eventKind: null, line: null }), 'UI_VIZ_CARD_BREACH'],
  ['hold_other', ev('box', at, { holdId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', owner: { peer: P }, holdKind: 'PIN', residence: 'OFF_DISK', state: 'PARKED', offer: 'none', desk: 2, localOnly: false, terminal: false }), null],
  ['event_breach', ev('conflict', at, { conflict: 'breach', source: 'event', on: { peer: P }, desk: null, holdId: null, cid: 'ABCDEFGH', eventKind: 'breach', line: null }), 'UI_VIZ_CARD_BREACH'],
  ['event_k', ev('conflict', at, { conflict: 'generic', source: 'event', on: { peer: P }, desk: null, holdId: null, cid: 'ABCDEFGH', eventKind: 'K4', line: null }), 'UI_VIZ_CARD_CONFLICT'],
  ['claim_new', ev('claim_take', at, { claimId: 'c1', seat: SEAT, desk: 2, order: 1, label: null, granularity: 'file', lines: null, otherRules: false }), null],
  ['claim_reanchor', ev('claim_move', at, { claimId: 'c1', seat: SEAT, desk: 2, order: 1, label: null, granularity: 'file', lines: null, otherRules: false }), null],
  ['claim_stale', ev('claim_stale', at, { claimId: 'c1' }), null],
  ['release', ev('claim_release', at, { claimId: 'c1', reason: 'explicit' }), null],
  ['reserve', ev('claim_reserve', at, { claimId: 'c1', request: 'R0123ABCD', requester: { peer: Q } }), null],
  ['grant', ev('grant_start', at, { claimId: 'c1', grantee: { peer: Q } }), null],
  ['request', ev('request_open', at, { request: 'R0123ABCD', from: { peer: Q }, holder: { seat: SEAT }, desk: 2, requestKind: 'go_first', estMinutes: 5, attempt: 1, note: 'may I?' }), 'UI_VIZ_CARD_REQUEST'],
  ['request_status', ev('request_status', at, { request: 'R0123ABCD', holder: { seat: SEAT }, status: 'asked' }), null],
  ['answer', ev('answer', at, { request: 'R0123ABCD', holder: { seat: SEAT }, verb: 'accept', by: 'claude', note: 'sure' }), 'UI_VIZ_CARD_ANSWER'],
  ['note', ev('note', at, { actor: { peer: P }, target: { request: 'R0123ABCD' }, text: 'thanks' }), 'UI_VIZ_CARD_NOTE'],
  ['presume_absent', ev('person_absent', at, { peer: P }), 'UI_VIZ_CARD_ABSENT'],
  ['presume_absent', ev('pet_poof', at, { seat: SEAT, owner: P }), null],
  ['presume_absent', ev('claim_stale', at, { claimId: 'c1' }), null],
  ['save', ev('save', at, { peer: P, desks: [3, 5] }), 'UI_VIZ_CARD_SAVE'],
  ['ghost', ev('person_ghost', at, { peer: P }), null],
  ['ghost', ev('person_unghost', at, { peer: P }), null],
  ['relaxed', ev('pose_relaxed', at, { actor: { peer: P } }), null],
];

test('T-VIZ-log (cards): cardFor gives the §3.4 code and group per row and none for uncarded rows', () => {
  const groups = new Set<Card['group']>();
  for (const [row, e, code] of ROWS) {
    const c = cardFor(e, row);
    if (code === null) {
      assert.equal(c, null, `${row} ${e.kind}`);
      continue;
    }
    assert.ok(c !== null, `${row} ${e.kind}`);
    assert.equal(c.code, code, row);
    assert.equal(c.group, CARD_GROUP[code], row);
    groups.add(c.group);
    assert.equal(c.id, `${e.height}.${e.sub}.${e.k}`);
    assert.deepEqual(c.at, { height: e.height, sub: e.sub, k: e.k });
    // Card.text only for teammate free text: a request's, answer's or note's.
    assert.equal(c.text !== null, ['request', 'answer', 'note'].includes(row), `${row} text`);
  }
  assert.deepEqual([...groups].sort(), ['activity', 'conflict', 'conversation', 'system']);
  // Every row of the closed SceneRow list is exercised above.
  const all: Record<SceneRow, true> = {
    genesis: true, join_new: true, join_back: true, join_epoch: true, join_version: true, join_rules: true, rules_change: true, join_credit: true, leave: true,
    seat_start: true, seat_footprint: true, seat_end: true, publish_cs: true, publish_big: true, publish_nocs: true, base_move: true, freeze: true, unfreeze: true,
    slowed: true, board_full: true, health_other: true, nonretryable: true, hold_k4: true, hold_claim: true, hold_t0: true, hold_breach: true, hold_other: true,
    event_breach: true, event_k: true, claim_new: true, claim_reanchor: true, claim_stale: true, release: true, reserve: true, grant: true, request: true,
    request_status: true, answer: true, note: true, presume_absent: true, save: true, ghost: true, relaxed: true,
  };
  assert.deepEqual(new Set(ROWS.map(([r]) => r)), new Set(Object.keys(all)));

  // Publish cards carry the paths, n and the desks (target first, then the others).
  const pub = cardFor(publish(['src/a.ts', 'src/b.ts'], 3, [5, 1], 2), 'publish_cs')!;
  assert.deepEqual([pub.actor, pub.paths, pub.n, pub.desks], [{ peer: P }, ['src/a.ts', 'src/b.ts'], 2, [3, 5, 1]]);
  assert.deepEqual([pub.target, pub.text, pub.detail, pub.displayId], [null, null, null, null]);
  const big = cardFor(publish([], 0, [], 300), 'publish_big')!;
  assert.deepEqual([big.paths, big.n, big.desks], [[], 300, [0]]);
  // The code-typed facts go only to the detail tooltip; display ids name the record a user can /cowork show.
  assert.deepEqual(cardFor(ev('person_freeze', at, { peer: P, reasonCode: 'EPOCH' }), 'freeze')!.detail, 'EPOCH');
  assert.deepEqual(cardFor(ev('person_badge', at, { actor: { peer: P }, badge: 'health', on: true, code: 'BRANCH_ESCAPE' }), 'health_other')!.detail, 'BRANCH_ESCAPE');
  const breach = cardFor(ev('conflict', at, { conflict: 'breach', source: 'event', on: { peer: P }, desk: null, holdId: null, cid: 'ABCDEFGH', eventKind: 'breach', line: null }), 'event_breach')!;
  assert.deepEqual([breach.actor, breach.displayId, breach.desks], [{ peer: P }, 'CABCDEFGH', []]);
  const k4 = cardFor(ROWS.find(([r]) => r === 'hold_k4')![1], 'hold_k4')!;
  assert.deepEqual([k4.displayId, k4.desks], ['01ARZ3ND', [2]]);
  const req = cardFor(ROWS.find(([r]) => r === 'request')![1], 'request')!;
  assert.deepEqual([req.actor, req.target, req.displayId, req.text, req.desks], [{ peer: Q }, { seat: SEAT }, 'R0123ABCD', 'may I?', [2]]);
  const ans = cardFor(ROWS.find(([r]) => r === 'answer')![1], 'answer')!;
  assert.deepEqual([ans.actor, ans.parent, ans.text, ans.detail], [{ seat: SEAT }, 'R0123ABCD', 'sure', 'accept']);
  const note = cardFor(ROWS.find(([r]) => r === 'note')![1], 'note')!;
  assert.deepEqual([note.actor, note.parent, note.text], [{ peer: P }, 'R0123ABCD', 'thanks']);
  const save = cardFor(ev('save', at, { peer: P, desks: [3, 5] }), 'save')!;
  assert.deepEqual([save.actor, save.desks, save.text], [{ peer: P }, [3, 5], null]);
  assert.deepEqual(cardFor(ev('pet_spawn', at, { seat: SEAT, owner: P }), 'seat_start')!.actor, { seat: SEAT });
  // A card never aliases its event's arrays.
  const e = publish(['src/a.ts'], 3, [5], 1);
  const c = cardFor(e, 'publish_cs')!;
  c.paths.push('x');
  assert.deepEqual((e as Extract<SceneEvent, { kind: 'publish' }>).paths, ['src/a.ts']);
  // An event whose kind is not one of its row's events gets no card.
  assert.equal(cardFor(ev('person_exit', at, { peer: P }), 'join_new'), null);
});
