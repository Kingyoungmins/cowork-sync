// Plan 8a Task 5: the scene reducer (12 sec. 3.3.5 reduceScene, sec. 3.3.7, sec. 3.4 Visual column, sec. 3.5.4 persistence, sec. 3.7 exclaim;
// VIZ-10, VIZ-12, VIZ-22, VIZ-26): segments, applyEvent versus SceneReducer, persistence, the height-relative states
// (slowed, branch sign, dimmed desks), persistent versus one-beat "!", and ids treated as opaque strings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import ts from 'typescript';
import { SCENE_EVENT_KINDS, actorKey, type Position, type SceneEvent } from '../../../src/viz/model/events.js';
import type { Layout } from '../../../src/viz/model/layout.js';
import {
  applyEvent,
  comparePos,
  deskDimmed,
  emptyScene,
  isSlowed,
  reduceScene,
  SceneReducer,
  signVisible,
  type Place,
  type Scene,
  type TimelineView,
} from '../../../src/viz/model/scene.js';
import { ev } from '../../helpers/vizEvents.js';
import {
  A, B, C, D1, D2, D3, D4, OFFICE, RANDOM_OFFICE, SA1, SB1, SC1, START,
  bangSequence, eventsArb, idsOf, persistenceSequence, renameLayout, renameScene, renameValue, reversingRename, scenesAfter,
} from '../../helpers/vizScene.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RUNS = 60;
const home = (spot: number): Place => ({ at: 'home', spot });
const chair = (desk: number): Place => ({ at: 'chair', desk });
const pos = (height: number, sub = 0, k = 0): Position => ({ height, sub, k });

/** Reduce `events` from `start` with applyEvent alone. */
function foldApply(start: Scene, events: readonly SceneEvent[], layout: Layout): Scene {
  return events.reduce((s, e) => applyEvent(s, e, layout), start);
}

test('reduceScene starts from the segment with the greatest hs < at.height, or the first, and applies that segment\'s events up to at', () => {
  // Three segments; each start scene is told apart by its badge and its characters.
  const s256 = { ...emptyScene(pos(256)), badge: 'near_full' as const };
  s256.characters.set(A, { place: home(0), pose: 'idle', lastPublish: null, lastDesk: null, lastClaimOp: null, ghost: false, absent: false, frozen: null, slowedUntil: null, rules: false, credit: false });
  const s512 = { ...emptyScene(pos(512)), badge: 'full' as const };
  const events: SceneEvent[] = [
    ev('room_open', [0, 0, 0], {}),
    ev('person_enter', [10, 1, 0], { peer: A }),
    ev('publish', [256, 1001, 0], { actor: { peer: A }, target: D1, others: [], paths: ['src/a.ts'], n: 1, state: 'closed', checks: 'pass', origin: 'human' }),
    ev('person_enter', [257, 1, 0], { peer: B }),
    ev('room_sign', [512, 1001, 0], { sign: 'branch_moved' }),
    ev('person_freeze', [513, 1, 0], { peer: B, reasonCode: 'EPOCH' }),
  ];
  const t: TimelineView = { segments: [{ hs: 0, start: START }, { hs: 256, start: s256 }, { hs: 512, start: s512 }], events, layout: OFFICE };

  // at.height = 0: no hs < 0, so the first segment; room_open is at (0, 0, 0) <= at.
  const at0 = reduceScene(t, pos(0));
  assert.deepEqual(at0.at, pos(0));
  assert.deepEqual(at0.beat.map((e) => e.kind), ['room_open']);
  assert.equal(at0.characters.size, 0);
  assert.equal(at0.badge, 'none');

  // At height 256 the segment is still the first (256 is not < 256): its events up to the position, including height 256's.
  const before = reduceScene(t, pos(256));
  assert.deepEqual(before.characters.get(A)?.place, home(0));
  assert.deepEqual(before.at, pos(256));
  assert.deepEqual(before.beat, [], 'a later height without events clears the beat');
  const atPublish = reduceScene(t, pos(256, 1001, 0));
  assert.deepEqual(atPublish.characters.get(A)?.place, chair(D1));
  assert.equal(atPublish.badge, 'none', 'the first segment\'s start, not the 256 start');
  assert.deepEqual(atPublish.beat.map((e) => e.kind), ['publish']);

  // Just above 256: the 256 segment's start scene, then its own events only.
  const after = reduceScene(t, pos(257));
  assert.equal(after.badge, 'near_full');
  assert.deepEqual(after.characters.get(A)?.place, home(0), 'the start scene of 256, not the reduced first segment');
  assert.equal(after.characters.has(B), false);
  assert.deepEqual(after.at, pos(257));
  const afterEnter = reduceScene(t, pos(257, 1, 0));
  assert.equal(afterEnter.characters.has(B), true);
  assert.deepEqual(reduceScene(t, pos(512, 1001, 0)).branchMovedAt, 512);
  assert.equal(reduceScene(t, pos(512, 1001, 0)).badge, 'near_full');

  // Above 512: the 512 start scene and the events after 512.
  const last = reduceScene(t, pos(600));
  assert.equal(last.badge, 'full');
  assert.equal(last.characters.size, 0, 'B entered in the 256 segment, which the 512 start scene does not hold');
  assert.equal(last.branchMovedAt, null);
  assert.deepEqual(last.at, pos(600));

  // A window whose first segment starts above at: the first segment's start scene, nothing applied, never rewound.
  const late: TimelineView = { segments: [{ hs: 512, start: s512 }], events: events.slice(5), layout: OFFICE };
  assert.deepEqual(reduceScene(late, pos(0)), s512);
  assert.deepEqual(reduceScene(late, pos(512)), s512);

  // reduceScene never mutates the timeline.
  const copy = structuredClone(t);
  reduceScene(t, pos(700));
  assert.deepEqual(t, copy);
});

test('SceneReducer and applyEvent agree on every prefix', () => {
  const seen = new Set<string>();
  fc.assert(
    fc.property(eventsArb({ minLength: 1 }), (events) => {
      const r = new SceneReducer(START, () => RANDOM_OFFICE);
      let s = START;
      for (const e of events) {
        seen.add(e.kind);
        const input = structuredClone(s);
        const next = applyEvent(s, e, RANDOM_OFFICE);
        assert.deepEqual(s, input, 'applyEvent does not mutate its scene');
        r.push(e);
        const got = r.scene();
        assert.deepEqual(got, next);
        got.characters.clear();                            // scene() is a copy: mutating it changes nothing
        got.beat.length = 0;
        assert.deepEqual(r.scene(), next);
        assert.deepEqual(next.at, { height: e.height, sub: e.sub, k: e.k });
        assert.deepEqual(next.beat.at(-1), e);
        assert.ok(next.beat.every((b) => b.height === e.height && comparePos(b, e) <= 0), 'the beat holds the events of at.height up to at');
        s = next;
      }
      // An event at or before the last pushed position throws; the reducer is unchanged.
      const lastEvent = events.at(-1)!;
      assert.throws(() => r.push({ ...lastEvent }), RangeError);
      if (lastEvent.height > 0) assert.throws(() => r.push({ ...lastEvent, height: lastEvent.height - 1 }), RangeError);
      assert.deepEqual(r.scene(), s);
    }),
    { numRuns: RUNS, seed: 0x5ce4e },
  );
  assert.deepEqual([...seen].sort(), [...SCENE_EVENT_KINDS].sort(), 'the generator covers every kind');
});

test('an actor stays where its last event put it until its next event, person_exit, person_absent, pet_poof or person_ghost', () => {
  const events = persistenceSequence();
  const scenes = scenesAfter(events);
  const placeOf = (s: Scene, who: 'A' | 'B' | 'C' | 'SA1' | 'SC1'): Place | undefined =>
    who === 'A' ? s.characters.get(A)?.place : who === 'B' ? s.characters.get(B)?.place : who === 'C' ? s.characters.get(C)?.place
      : who === 'SA1' ? s.pets.get(SA1)?.place : s.pets.get(SC1)?.place;
  const seated = scenes[8]!;                               // every publish done: A, SA1, SC1 and B at their desks
  assert.deepEqual(placeOf(seated, 'A'), chair(D1));
  assert.deepEqual(placeOf(seated, 'SA1'), chair(D2));
  assert.deepEqual(placeOf(seated, 'SC1'), chair(D3));
  assert.deepEqual(placeOf(seated, 'B'), chair(D4));
  // Room events, another actor's events and an actor's own non-placement events (badge, note, freeze, slowed, pose)
  // move nobody.
  for (let i = 9; i <= 19; i++) {
    for (const who of ['A', 'B', 'C', 'SA1', 'SC1'] as const) assert.deepEqual(placeOf(scenes[i]!, who), placeOf(seated, who), `${who} after ${events[i]!.kind}`);
  }
  // ... while each of them records its own fact (12 sec. 3.4 Visual column).
  assert.equal(scenes[9]!.branchMovedAt, 7);
  assert.equal(scenes[10]!.badge, 'near_full');
  assert.equal(scenes[11]!.characters.get(B)!.frozen, 'EPOCH');
  assert.equal(scenes[12]!.characters.get(A)!.credit, true);
  assert.equal(scenes[13]!.characters.get(B)!.slowedUntil, 191);
  assert.equal(scenes[17]!.desks.get(D4)!.lastEvent, 15, 'the save names desk 4');
  assert.equal(scenes[17]!.characters.get(B)!.frozen, 'EPOCH');
  assert.equal(scenes[18]!.characters.get(B)!.frozen, null, 'person_thaw');
  // Heights passing without an event move nobody either.
  const t: TimelineView = { segments: [{ hs: 0, start: START }], events: events.slice(0, 20), layout: OFFICE };
  const later = reduceScene(t, pos(299, 1002, 0));
  for (const who of ['A', 'B', 'C', 'SA1', 'SC1'] as const) assert.deepEqual(placeOf(later, who), placeOf(seated, who), `${who} 220 heights later`);
  assert.equal(later.characters.get(A)?.pose, 'relaxed');
  // person_ghost sends A home; its pet stays at its own desk.
  assert.deepEqual(placeOf(scenes[20]!, 'A'), home(0));
  assert.deepEqual(placeOf(scenes[20]!, 'SA1'), chair(D2));
  // pet_poof: the pet is gone from the room (no longer live), A stays home.
  assert.equal(scenes[21]!.pets.get(SA1)?.live, false);
  assert.deepEqual(placeOf(scenes[21]!, 'A'), home(0));
  // person_absent sends B home.
  assert.deepEqual(placeOf(scenes[22]!, 'B'), home(1));
  assert.equal(scenes[22]!.characters.get(B)?.absent, true);
  // person_exit removes C; its pet keeps its place until its own poof.
  assert.equal(scenes[23]!.characters.has(C), false);
  assert.deepEqual(placeOf(scenes[23]!, 'SC1'), chair(D3));
  assert.equal(scenes[24]!.pets.get(SC1)?.live, false);
  // The chairs freed by the ghost, the poofs, the absence and the exit are empty.
  for (const d of [D1, D2, D3, D4]) assert.equal(scenes[24]!.desks.get(d)?.chair ?? null, null, `desk ${d}`);
});

test('slowed ends at until without an event; the branch sign shows for 64 heights; a desk dims after 256 heights without an event', () => {
  const events: SceneEvent[] = [
    ev('person_enter', [1, 1, 0], { peer: A }),
    ev('person_slowed', [1, 1, 1], { peer: A, until: 181 }),
    ev('room_sign', [10, 1001, 0], { sign: 'branch_moved' }),
    ev('publish', [20, 1001, 0], { actor: { peer: A }, target: D1, others: [D2], paths: ['src/a.ts', 'src/b.ts'], n: 2, state: 'closed', checks: 'pass', origin: 'human' }),
  ];
  const t: TimelineView = { segments: [{ hs: 0, start: START }], events, layout: OFFICE };
  const at = (h: number): Scene => reduceScene(t, pos(h, 1002, 0));
  const a = (h: number): boolean => isSlowed(at(h).characters.get(A)!, at(h).at);
  assert.equal(a(1), true);
  assert.equal(a(180), true);
  assert.equal(a(181), false, 'ends at until, with no event at 181');
  assert.equal(a(5_000), false);
  assert.equal(at(181).characters.get(A)!.slowedUntil, 181, 'the reducer keeps the field; the end is read relative to at');
  assert.equal(isSlowed({ ...at(1).characters.get(A)!, slowedUntil: null }, pos(1)), false);

  assert.equal(signVisible(at(9)), false);
  assert.equal(signVisible(at(10)), true);
  assert.equal(signVisible(at(73)), true);
  assert.equal(signVisible(at(74)), false, '64 heights after the sign');

  assert.equal(deskDimmed(at(20), D1), false);
  assert.equal(deskDimmed(at(275), D1), false);
  assert.equal(deskDimmed(at(276), D1), true, '256 heights without an event');
  assert.equal(deskDimmed(at(275), D2), false, 'a paper plane is an event on the other desk');
  assert.equal(deskDimmed(at(276), D2), true);
  assert.equal(deskDimmed(at(20), D3), false, 'a desk with no entry (no event since the segment start) is not dimmed');
  assert.equal(deskDimmed(at(300), D3), false);
  assert.equal(deskDimmed(at(19), D1), false, 'before its first event: no entry yet');
  assert.equal(deskDimmed(START, D1), false, 'a start scene dims nothing');
});

test('T-VIZ-anim (scene): a persistent bang exists only while its hold record is non-terminal; an event-sourced conflict and person_bang live in the beat only', () => {
  const events = bangSequence();
  const scenes = scenesAfter(events);
  const bangs = (i: number): string[] => [...scenes[i]!.bangs.keys()].sort();
  const boxes = (i: number): string[] => [...scenes[i]!.boxes.keys()].sort();
  assert.deepEqual(bangs(3), ['H0000001'], 'the K4 record: a persistent "!" on its owner');
  assert.deepEqual(scenes[3]!.bangs.get('H0000001'), { on: { seat: SA1 }, desk: D1 });
  assert.deepEqual(bangs(6), ['H0000001', 'H0000002']);
  assert.deepEqual(boxes(6), ['H0000001', 'H0000002']);
  assert.deepEqual(bangs(7), ['H0000002'], 'the record went terminal: its "!" and its parcel are gone');
  assert.deepEqual(boxes(7), ['H0000002']);
  // Event-sourced: in the beat of their height, never persistent.
  assert.deepEqual(bangs(9), ['H0000002']);
  assert.deepEqual(scenes[9]!.beat.map((e) => e.kind), ['conflict', 'person_bang']);
  assert.deepEqual(scenes[10]!.beat.map((e) => e.kind), ['room_badge'], 'the next height clears the beat');
  // The remaining record keeps its "!" across hundreds of heights, until it is terminal.
  const t: TimelineView = { segments: [{ hs: 0, start: START }], events, layout: OFFICE };
  assert.deepEqual([...reduceScene(t, pos(399)).bangs.keys()], ['H0000002']);
  assert.deepEqual(reduceScene(t, pos(399)).beat, []);
  assert.equal(reduceScene(t, pos(400, 1, 0)).bangs.size, 0);
  assert.equal(reduceScene(t, pos(400, 1, 0)).boxes.size, 0);
  // At every prefix: every "!" belongs to a hold record that is not terminal (a conflict and its box share a row).
  scenes.forEach((s, i) => {
    for (const id of s.bangs.keys()) {
      const terminalBefore = events.slice(0, i + 1).some((e) => e.kind === 'box' && e.holdId === id && e.terminal);
      assert.equal(terminalBefore, false, `a "!" for ${id} after its record went terminal`);
    }
  });
});

// 12 sec. 3.4 Visual column rows the hand-written sequences pass without asserting: claim_reserve, claim_move (grantee and
// reservation kept), save, answer{later}.
const claimTake = (id: string, seat: string, desk: number, h: number): SceneEvent =>
  ev('claim_take', [h, 1, 0], { claimId: id, seat, desk, order: 10, label: { simple: 'parse', qualname: 'Mod.parse' }, granularity: 'symbol', lines: [10, 15], otherRules: false });
const visualBase = (): SceneEvent[] => [
  ev('person_enter', [1, 1, 0], { peer: A }),
  ev('person_enter', [1, 2, 0], { peer: B }),
  ev('pet_spawn', [2, 1001, 0], { seat: SA1, owner: A }),
  ev('pet_spawn', [2, 1001, 1], { seat: SB1, owner: B }),
];
const VISUAL_ROWS: ReadonlyArray<readonly [string, SceneEvent[], (s: Scene[]) => void]> = [
  ['claim_reserve marks the claim reserved for the request and gives its desk the event height', [
    ...visualBase(),
    claimTake('r1', SB1, D2, 3),
    ev('request_open', [4, 1, 0], { request: 'R00000001', from: { seat: SA1 }, holder: { seat: SB1 }, desk: D2, requestKind: 'handoff', estMinutes: null, attempt: 1, note: null }),
    ev('claim_reserve', [6, 1, 0], { claimId: 'r1', request: 'R00000001', requester: { seat: SA1 } }),
  ], (s) => {
    assert.equal(s[5]!.claims.get('r1')!.reservedFor, null);
    assert.equal(s[6]!.claims.get('r1')!.reservedFor, 'R00000001');
    assert.equal(s[6]!.claims.get('r1')!.stale, false);
    assert.equal(s[6]!.desks.get(D2)!.lastEvent, 6);
  }],
  ['claim_move keeps the grantee and the reservation and moves the claim from one desk\'s list to the other\'s', [
    ...visualBase(),
    claimTake('r1', SB1, D2, 3),
    ev('claim_reserve', [4, 1, 0], { claimId: 'r1', request: 'R00000001', requester: { seat: SA1 } }),
    ev('grant_start', [5, 1, 0], { claimId: 'r1', grantee: { seat: SA1 } }),
    ev('claim_move', [6, 1, 0], { claimId: 'r1', seat: SB1, desk: D3, order: 7, label: null, granularity: 'block', lines: [7, 9], otherRules: true }),
  ], (s) => {
    const c = s[7]!.claims.get('r1')!;
    assert.deepEqual([c.desk, c.order, c.label, c.granularity, c.lines, c.otherRules], [D3, 7, null, 'block', [7, 9], true]);
    assert.equal(c.reservedFor, 'R00000001');
    assert.deepEqual(c.grantee, { seat: SA1 });
    assert.deepEqual([s[7]!.desks.get(D2)!.claims, s[7]!.desks.get(D3)!.claims], [[], ['r1']]);
    assert.deepEqual([s[7]!.desks.get(D2)!.lastEvent, s[7]!.desks.get(D3)!.lastEvent], [6, 6]);
    assert.deepEqual(s[7]!.pets.get(SB1)!.place, { at: 'chair', desk: D3 });
    assert.deepEqual(s[7]!.pets.get(SA1)!.place, { at: 'stool', desk: D3 }, 'the grantee\'s stool follows the claim');
  }],
  ['save gives every desk it names the event height, and no other desk', [
    ...visualBase(),
    ev('save', [9, 1, 0], { peer: A, desks: [D1, D4] }),
  ], (s) => {
    assert.deepEqual([...s[4]!.desks].map(([d, ds]) => [d, ds.lastEvent]).sort(), [[D1, 9], [D4, 9]]);
  }],
  ['answer{later} keeps the request open and its requester facing the holder; another verb closes it', [
    ...visualBase(),
    claimTake('r1', SB1, D2, 3),
    ev('request_open', [4, 1, 0], { request: 'R00000002', from: { peer: A }, holder: { seat: SB1 }, desk: D2, requestKind: 'go_first', estMinutes: 3, attempt: 1, note: null }),
    ev('answer', [5, 1, 0], { request: 'R00000002', holder: { seat: SB1 }, verb: 'later', by: 'claude', note: 'after this turn' }),
    ev('answer', [6, 1, 0], { request: 'R00000002', holder: { seat: SB1 }, verb: 'decline', by: 'human', note: null }),
  ], (s) => {
    const facing: Place = { at: 'facing', actor: { seat: SB1 }, desk: D2 };
    assert.deepEqual(s[6]!.requests.get('R00000002'), { from: { peer: A }, holder: { seat: SB1 }, desk: D2, status: null });
    assert.deepEqual(s[6]!.characters.get(A)!.place, facing);
    assert.equal(s[7]!.requests.size, 0);
    assert.deepEqual(s[7]!.characters.get(A)!.place, home(0));
  }],
];
for (const [name, events, check] of VISUAL_ROWS) test(`12 \u{a7}3.4 Visual column: ${name}`, () => check(scenesAfter(events)));

test('SceneReducer.push refuses an event before its start scene', () => {
  const start = emptyScene(pos(256));
  start.characters.set(A, { place: home(0), pose: 'idle', lastPublish: null, lastDesk: null, lastClaimOp: null, ghost: false, absent: false, frozen: null, slowedUntil: null, rules: false, credit: false });
  const r = new SceneReducer(start, () => OFFICE);
  assert.throws(() => r.push(ev('person_enter', [255, 1, 0], { peer: B })), RangeError);
  assert.throws(() => r.push(ev('room_open', [0, 0, 0], {})), RangeError);
  assert.deepEqual(r.scene(), start, 'refused events change nothing');
  r.push(ev('person_enter', [257, 1, 0], { peer: B }));
  assert.equal(r.scene().characters.has(B), true);
});

test('SceneReducer.push is atomic: an event that throws part-way leaves the reducer as it was', () => {
  const r = new SceneReducer(START, () => OFFICE);
  r.push(ev('person_enter', [1, 1, 0], { peer: A }));
  const before = r.scene();
  // A malformed publish: the reducer records the beat, the position and A's publish before it reaches `others`.
  const publish = (others: number[]): SceneEvent =>
    ev('publish', [2, 1001, 0], { actor: { peer: A }, target: D1, others, paths: ['src/a.ts'], n: 1, state: 'closed', checks: 'pass', origin: 'human' });
  assert.throws(() => r.push(publish(null as unknown as number[])), TypeError);
  assert.deepEqual(r.scene(), before);
  r.push(publish([]));
  assert.deepEqual(r.scene().characters.get(A)!.place, chair(D1), 'the same position is still free');
});

test('reduceScene treats ids as opaque', () => {
  // Two segments: the second starts from the scene the first reduced to, so the start scenes hold actors, claims and
  // requests. Renaming every peer and seat id (to reverse-ordered ids and 6-character handles with no '/') commutes
  // with reduceScene at random positions, and Maps rebuilt in another order change nothing.
  const arb = fc.tuple(eventsArb({ maxLength: 40 }), eventsArb({ minLength: 1, maxLength: 40 }), fc.array(fc.tuple(fc.nat(3_000), fc.nat(1_002), fc.nat(3)), { minLength: 1, maxLength: 8 }));
  fc.assert(
    fc.property(arb, ([first, later, ats]) => {
      const hs = first.at(-1)?.height ?? 0;
      const second = later.map((e) => ({ ...e, height: e.height + hs + 1 }));
      const start2 = { ...foldApply(START, first, RANDOM_OFFICE), at: pos(hs), beat: [] };
      const events = [...first, ...second];
      const t: TimelineView = { segments: [{ hs: 0, start: START }, { hs, start: start2 }], events, layout: RANDOM_OFFICE };
      const ids = idsOf(events);
      const r = reversingRename([...ids.peers, ...RANDOM_OFFICE.homeOrder], ids.seats);
      const renamed: TimelineView = {
        segments: t.segments.map((g) => ({ hs: g.hs, start: renameScene(g.start, r) })),
        events: events.map((e) => renameValue(e, r)),
        layout: renameLayout(RANDOM_OFFICE, r),
      };
      for (const [h, sub, k] of [...ats, ...events.map((e) => [e.height, e.sub, e.k] as const)]) {
        const at = pos(h, sub, k);
        assert.deepEqual(reduceScene(renamed, at), renameScene(reduceScene(t, at), r), `at ${h}.${sub}.${k}`);
      }
    }),
    { numRuns: RUNS, seed: 0x0bac },
  );

  // No function of the shared model files splits a seat id: no split call and no '/' in any string, template or regex
  // literal (module specifiers aside). The scan itself is checked on a file that does split one.
  const seatSplits = (rel: string, text: string): string[] => {
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const found: string[] = [];
    const visit = (n: ts.Node): void => {
      if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier !== undefined) return;
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'split') found.push('split()');
      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) && n.text.includes('/')) found.push(`'${n.text}'`);
      if (ts.isRegularExpressionLiteral(n) && n.text.slice(1, n.text.lastIndexOf('/')).includes('/')) found.push(n.text);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return found;
  };
  const SLASH = String.fromCharCode(0x2f);
  const canary = `import { x } from './x.js';\nexport const owner = (s: string) => s.split('${SLASH}')[0];\nconst i = (s: string) => s.indexOf(\`${SLASH}\${s}\`);\nconst r = /a\\${SLASH}b/;\n`;
  assert.deepEqual(seatSplits('canary.ts', canary), ['split()', `'${SLASH}'`, `'${SLASH}'`, `/a\\${SLASH}b/`]);
  for (const rel of ['src/viz/model/scene.ts', 'src/viz/model/placement.ts', 'src/viz/model/labels.ts', 'src/viz/model/cards.ts']) {
    assert.deepEqual(seatSplits(rel, readFileSync(path.join(ROOT, rel), 'utf8')), [], rel);
  }
  // A seat id with no '/' (the page's seat handles) reduces like any other: owner and variant come from the event.
  const handle = 'Q7KM2Z';
  const s = scenesAfter([ev('person_enter', [1, 1, 0], { peer: A }), ev('pet_spawn', [2, 1001, 0], { seat: handle, owner: A })]).at(-1)!;
  assert.deepEqual(s.pets.get(handle), { place: { at: 'behind', peer: A }, pose: 'idle', lastPublish: null, lastDesk: null, lastClaimOp: null, owner: A, variant: 0, live: true, ssCode: null });
  assert.equal(actorKey({ seat: handle }), `s:${handle}`);
});

test('the shared model modules import each other without a runtime cycle: placement.ts reads scene.ts for types only', () => {
  // The model files of the client program (R-V35). A value import (anything but `import type`, `export type` or an
  // all-`type` specifier list) is an edge of the runtime graph; type-only imports are erased and are no edge.
  const MODEL = ['events', 'scene', 'layout', 'placement', 'cards', 'labels'];
  const valueImports = (rel: string, text: string): string[] => {
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const out: string[] = [];
    for (const st of sf.statements) {
      let spec: ts.Expression | undefined, value = false;
      if (ts.isImportDeclaration(st)) {
        spec = st.moduleSpecifier;
        const cl = st.importClause;
        value = cl === undefined || (!cl.isTypeOnly && (cl.name !== undefined || cl.namedBindings === undefined
          || ts.isNamespaceImport(cl.namedBindings) || cl.namedBindings.elements.some((e) => !e.isTypeOnly)));
      } else if (ts.isExportDeclaration(st) && st.moduleSpecifier !== undefined) {
        spec = st.moduleSpecifier;
        const xc = st.exportClause;
        value = !st.isTypeOnly && (xc === undefined || ts.isNamespaceExport(xc) || xc.elements.some((e) => !e.isTypeOnly));
      }
      if (spec !== undefined && value && ts.isStringLiteral(spec) && spec.text.startsWith('.')) out.push(path.posix.basename(spec.text, '.js'));
    }
    return out;
  };
  /** Every cycle of the graph, each as the path from its first module back to it (one per entry module found). */
  const cycles = (graph: ReadonlyMap<string, readonly string[]>): string[] => {
    const found: string[] = [];
    const walk = (from: string, at: string, trail: string[]): void => {
      for (const next of graph.get(at) ?? []) {
        if (next === from) found.push([...trail, next].join(' -> '));
        else if (!trail.includes(next) && graph.has(next)) walk(from, next, [...trail, next]);
      }
    };
    for (const m of graph.keys()) walk(m, m, [m]);
    return found;
  };
  // The scan, checked on canaries: a value cycle is found; type-only imports and exports are no edges.
  const canary = new Map([
    ['a', valueImports('a.ts', `import { b, type B } from './b.js';\nimport type { C } from './c.js';\nexport type { D } from './d.js';\n`)],
    ['b', valueImports('b.ts', `import { type A } from './a.js';\nexport { a } from './a.js';\n`)],
    ['c', valueImports('c.ts', `import { type A } from './a.js';\nimport * as d from './d.js';\n`)],
    ['d', valueImports('d.ts', `export * from './a.js';\n`)],
  ]);
  assert.deepEqual([...canary], [['a', ['b']], ['b', ['a']], ['c', ['d']], ['d', ['a']]]);
  assert.deepEqual(cycles(canary), ['a -> b -> a', 'b -> a -> b']);
  const graph = new Map(MODEL.map((m) => {
    const rel = `src/viz/model/${m}.ts`;
    return [m, valueImports(rel, readFileSync(path.join(ROOT, rel), 'utf8'))] as const;
  }));
  assert.ok(graph.get('scene')!.includes('placement'), 'the reducer calls placement at run time');
  assert.deepEqual(graph.get('placement')!.filter((m) => m === 'scene'), [], 'placement.ts imports scene.ts for types only');
  assert.deepEqual(cycles(graph), []);
});

test('the scene\'s desk table stays sparse: an entry exists only for a desk with an event, a chair, a visitor or a claim', () => {
  fc.assert(
    fc.property(eventsArb({ minLength: 1 }), (events) => {
      for (const s of scenesAfter(events, RANDOM_OFFICE)) {
        for (const [d, ds] of s.desks) {
          assert.ok(ds.lastEvent !== null || ds.chair !== null || ds.visitors.length > 0 || ds.claims.length > 0, `desk ${d} is all defaults`);
          assert.ok(ds.visitors.length <= 4 && ds.more >= 0);
        }
      }
    }),
    { numRuns: RUNS, seed: 0xde5c },
  );
  // A start scene with no publish history has no desk entries at all (sec. 3.3.5 independence of later desks).
  assert.equal(scenesAfter([ev('person_enter', [1, 1, 0], { peer: A })]).at(-1)!.desks.size, 0);
});
