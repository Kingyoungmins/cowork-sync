// Plan 8a Task 13: animation states (12 §3.7 "States"; VIZ-22): every scene event kind maps to its table states, each state
// has its reduced-motion form, no state is entered without an event, and an exclaim from an event lasts one beat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENE_EVENT_KINDS, type SceneEvent, type SceneEventKind } from '../../../src/viz/model/events.js';
import { emptyScene, SceneReducer } from '../../../src/viz/model/scene.js';
import {
  ANIM, BACKLOG_SNAP_MS, exclaimPersists, LIVE_BEAT_MS, liveSnap, REPLAY_BEAT_MS, replayBeatMs, SPEEDS, statesFor, TRIP_MAX_MS, WALK_TILES_PER_S,
  type AnimState,
} from '../../../src/viz/ui/anim.js';
import { ev } from '../../helpers/vizEvents.js';
import { OFFICE, A, B } from '../../helpers/vizScene.js';

const SEAT = 'K7Q2ZP';
const publish = (state: 'closed' | 'checkpoint', others: number[]): SceneEvent =>
  ev('publish', [5, 1_001, 0], { actor: { peer: A }, target: 1, others, paths: ['src/a.ts'], n: 1, state, checks: 'pass', origin: 'human' });
const claim = (kind: 'claim_take' | 'claim_move'): SceneEvent =>
  ev(kind, [5, 1, 0], { claimId: 'c1', seat: SEAT, desk: 1, order: 1, label: null, granularity: 'file', lines: null, otherRules: false });

/** One representative event per kind, and the states the §3.7 "Entered by" column gives it. */
const CASES: ReadonlyArray<[SceneEventKind, SceneEvent, AnimState[]]> = [
  ['room_open', ev('room_open', [0, 0, 0], {}), []],
  ['room_sign', ev('room_sign', [5, 1_001, 0], { sign: 'branch_moved' }), []],
  ['room_badge', ev('room_badge', [5, 1, 0], { level: 'full' }), []],
  ['person_enter', ev('person_enter', [5, 1, 0], { peer: A }), ['enter']],
  ['person_respawn', ev('person_respawn', [5, 1, 0], { peer: A }), ['enter']],
  ['person_exit', ev('person_exit', [5, 1, 0], { peer: A }), ['exit']],
  ['person_thaw', ev('person_thaw', [5, 1, 0], { peer: A }), []],
  ['person_absent', ev('person_absent', [5, 1, 0], { peer: A }), ['zzz']],
  ['person_ghost', ev('person_ghost', [5, 1_002, 0], { peer: A }), ['ghost']],
  ['person_unghost', ev('person_unghost', [5, 1_002, 0], { peer: A }), []],
  ['person_freeze', ev('person_freeze', [5, 1, 0], { peer: A, reasonCode: 'PAUSED' }), ['frozen']],
  ['person_slowed', ev('person_slowed', [5, 1, 0], { peer: A, until: 185 }), ['slowed']],
  ['person_bang', ev('person_bang', [5, 1, 0], { peer: A, bang: 'host' }), ['exclaim']],
  ['person_badge', ev('person_badge', [5, 1, 0], { actor: { peer: A }, badge: 'version', on: true, code: null }), []],
  ['pet_spawn', ev('pet_spawn', [5, 1_001, 0], { seat: SEAT, owner: A }), ['spawn', 'think']],
  ['pet_poof', ev('pet_poof', [5, 1, 0], { seat: SEAT, owner: A }), ['poof']],
  ['pose_relaxed', ev('pose_relaxed', [5, 1_002, 0], { actor: { peer: A } }), ['relaxed']],
  ['publish', publish('closed', []), ['walk', 'sit', 'sparkle_big']],
  ['conflict', ev('conflict', [5, 1, 0], { conflict: 'breach', source: 'event', on: { peer: A }, desk: null, holdId: null, cid: 'ABCDEFGH', eventKind: 'breach', line: null }), ['exclaim']],
  ['box', ev('box', [5, 1, 0], { holdId: 'H0000001', owner: { peer: A }, holdKind: 'PIN', residence: 'ON_DISK', state: 'CONFLICTED', offer: 'none', desk: 1, localOnly: false, terminal: false }), ['parcel']],
  ['claim_take', claim('claim_take'), ['walk', 'sit']],
  ['claim_move', claim('claim_move'), ['walk', 'sit']],
  ['claim_stale', ev('claim_stale', [5, 1, 0], { claimId: 'c1' }), []],
  ['claim_reserve', ev('claim_reserve', [5, 1, 0], { claimId: 'c1', request: 'R00000001', requester: { peer: B } }), []],
  ['claim_release', ev('claim_release', [5, 1, 0], { claimId: 'c1', reason: 'explicit' }), ['walk']],
  ['grant_start', ev('grant_start', [5, 1, 0], { claimId: 'c1', grantee: { peer: B } }), ['walk', 'sit']],
  ['grant_end', ev('grant_end', [5, 1, 0], { claimId: 'c1', grantee: { peer: B } }), ['walk']],
  ['request_open', ev('request_open', [5, 1, 0], { request: 'R00000001', from: { peer: B }, holder: { peer: A }, desk: 1, requestKind: 'handoff', estMinutes: null, attempt: 1, note: 'hi' }), ['walk', 'bubble']],
  ['request_status', ev('request_status', [5, 1, 0], { request: 'R00000001', holder: { peer: A }, status: 'queued_until_turn_end' }), ['bubble']],
  ['answer', ev('answer', [5, 1, 0], { request: 'R00000001', holder: { peer: A }, verb: 'decline', by: 'human', note: null }), ['bubble', 'walk']],
  ['note', ev('note', [5, 1, 0], { actor: { peer: A }, target: null, text: 'hello' }), ['bubble']],
  ['save', ev('save', [5, 1, 0], { peer: A, desks: [1] }), ['celebrate']],
];

test('T-VIZ-anim: every kind of SCENE_EVENT_KINDS maps to its 12 §3.7 states and reduced forms; no state without an event; event-sourced exclaims last one beat', () => {
  // Total over the closed kind set, each kind exactly as the "Entered by" column says.
  assert.deepEqual([...new Set(CASES.map(([k]) => k))].sort(), [...SCENE_EVENT_KINDS].sort());
  for (const [kind, e, want] of CASES) assert.deepEqual(statesFor(e), want, kind);
  // The variants within a kind: checkpoint → the small sparkle; other desks → paper planes; asked → think; returned and every
  // answer but later → walking back.
  assert.deepEqual(statesFor(publish('checkpoint', [2, 3])), ['walk', 'sit', 'sparkle_small', 'planes']);
  assert.deepEqual(statesFor(ev('request_status', [5, 1, 0], { request: 'R00000001', holder: { peer: A }, status: 'asked' })), ['bubble', 'think']);
  assert.deepEqual(statesFor(ev('request_status', [5, 1, 0], { request: 'R00000001', holder: { peer: A }, status: 'returned' })), ['bubble', 'walk']);
  assert.deepEqual(statesFor(ev('answer', [5, 1, 0], { request: 'R00000001', holder: { peer: A }, verb: 'later', by: 'claude', note: null })), ['bubble']);

  // The §3.7 table: frames × duration and the reduced-motion form of every state.
  const table: Record<AnimState, [number, number, number | null, string]> = {
    idle: [2, 600, null, 'off'], walk: [4, 100, null, 'crossfade'], sit: [2, 140, null, 'icon'],
    sparkle_small: [4, 100, 400, 'icon'], sparkle_big: [6, 100, 600, 'icon'], planes: [6, 100, 600, 'icon'],
    exclaim: [2, 350, 700, 'static'], think: [3, 350, null, 'static'], bubble: [1, 200, null, 'static'],
    zzz: [3, 600, null, 'static'], relaxed: [2, 900, null, 'static'], ghost: [1, 0, null, 'same'], frozen: [1, 0, null, 'same'],
    slowed: [1, 0, null, 'same'], enter: [4, 100, 400, 'crossfade'], exit: [4, 100, 400, 'crossfade'], spawn: [3, 100, 300, 'crossfade'],
    poof: [3, 100, 300, 'crossfade'], celebrate: [3, 400, 1_200, 'icon'], parcel: [1, 0, null, 'icon'],
  };
  assert.deepEqual(Object.keys(ANIM).sort(), Object.keys(table).sort());
  for (const [s, [frames, frameMs, durationMs, reduced]] of Object.entries(table)) {
    assert.deepEqual(ANIM[s as AnimState], { frames, frameMs, durationMs, reduced }, s);
  }
  assert.ok(Object.isFrozen(ANIM));

  // No state without an event: every state but idle (present with nothing pending) is entered by some event kind, and idle by none.
  const entered = new Set(CASES.flatMap(([, e]) => statesFor(e)).concat(statesFor(publish('checkpoint', [2])), statesFor(ev('request_status', [5, 1, 0], { request: 'R00000001', holder: { peer: A }, status: 'asked' }))));
  assert.deepEqual([...Object.keys(ANIM)].filter((s) => !entered.has(s as AnimState)), ['idle']);

  // A persistent "!" comes only from a non-terminal hold record (VIZ-22); an exclaim from an event lasts one beat: the reducer
  // keeps no bang for it, and the next height's beat no longer holds it.
  const fromHold = ev('conflict', [6, 2, 0], { conflict: 'k4', source: 'hold', on: { peer: A }, desk: 1, holdId: 'H0000001', cid: null, eventKind: null, line: null });
  const fromEvent = CASES.find(([k]) => k === 'conflict')![1];
  const bang = CASES.find(([k]) => k === 'person_bang')![1];
  assert.equal(exclaimPersists(fromHold), true);
  for (const e of [fromEvent, bang, ...CASES.map(([, x]) => x).filter((x) => x.kind !== 'conflict')]) assert.equal(exclaimPersists(e), false, e.kind);
  const r = new SceneReducer(emptyScene({ height: 0, sub: 0, k: 0 }), () => OFFICE);
  r.push(ev('person_enter', [1, 1, 0], { peer: A }));
  r.push(fromEvent);
  assert.equal(r.scene().bangs.size, 0);
  assert.equal(r.scene().beat.filter((e) => statesFor(e).includes('exclaim')).length, 1);
  r.push(ev('note', [6, 1, 0], { actor: { peer: A }, target: null, text: 'x' }));
  assert.equal(r.scene().beat.filter((e) => statesFor(e).includes('exclaim')).length, 0);
  r.push(fromHold);
  r.push(ev('note', [7, 1, 0], { actor: { peer: A }, target: null, text: 'y' }));
  assert.equal(r.scene().bangs.size, 1);

  // Beats and speeds (12 §3.7 "Beats").
  assert.deepEqual([LIVE_BEAT_MS, REPLAY_BEAT_MS, BACKLOG_SNAP_MS, WALK_TILES_PER_S, TRIP_MAX_MS], [300, 800, 5_000, 4, 3_000]);
  assert.deepEqual(SPEEDS, [0.5, 1, 2, 4, 8]);
  assert.deepEqual(SPEEDS.map(replayBeatMs), [1_600, 800, 400, 200, 100]);
  assert.equal(liveSnap(16), false);           // 4.8 s of queued beats
  assert.equal(liveSnap(17), true);            // 5.1 s: crossfade to the newest scene
});
