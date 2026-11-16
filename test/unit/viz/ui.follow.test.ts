// Plan 8a Task 19: following a teammate (F32; 12 §3.8.1, §3.5.3, §3.8; FEAT-F32-02…-08; X-93; R-V22, R-V25, R-V56). The follow
// camera's three steps over the followed actors' tiles, the pan or jump of each scroll, the now card's rows over the drawn scene,
// live and replay agreeing at random positions, and the page-memory follow set that pins the log's person filter per room. Pure
// page logic (ui/follow.ts, R-V33); the client wiring is client/{office,log,a11y,main}.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import ts from 'typescript';
import { renderWith } from '../../../src/i18n/render.js';
import { ALL_VIZ_CODES, REASON_CODES } from '../../../src/viz/i18n/codes.js';
import { EN_VIZ } from '../../../src/viz/i18n/en.js';
import type { ActorRef, PeerRef, Position, SceneEvent, SeatRef } from '../../../src/viz/model/events.js';
import { phOf } from '../../../src/viz/model/labels.js';
import { deskTiles, emptyLayout, LayoutBuilder, OFFICE_W, officeTiles, TILE_PX, type Layout, type Tile } from '../../../src/viz/model/layout.js';
import { emptyScene, reduceScene, SceneReducer, type Scene, type TimelineView } from '../../../src/viz/model/scene.js';
import { placeTile } from '../../../src/viz/render/raster.js';
import { createHandleTable, projectEvent, projectLayout } from '../../../src/viz/server/project.js';
import type { CardVM } from '../../../src/viz/server/viewModel.js';
import { Announcer, ANNOUNCE_GAP_MS, KEYS, keyActionFor, modifiedKey, MotionPreference, type KeyModifiers } from '../../../src/viz/ui/a11y.js';
import {
  beatScroll, cameraFrame, cameraTarget, focusActor, FOLLOW_PAN_MS, FollowCamera, followedActors, followMotion, FollowSet, NOW_ROWS_MAX, nowCard,
  nowRows, type FollowCause, type FollowMove, type FollowNotice, type FollowView, type NowRow,
} from '../../../src/viz/ui/follow.js';
import { LogModel, type LogFilter } from '../../../src/viz/ui/logModel.js';
import { SeekCache } from '../../../src/viz/ui/seek.js';
import { unprojectEvent, unprojectLayout } from '../../../src/viz/ui/unproject.js';
import { FollowRule, ZoomState } from '../../../src/viz/ui/zoom.js';
import { lintVizClientClosure, lintVizClientProgram, lintVizSource } from '../../../tools/lint/vizRules.js';
import { ev } from '../../helpers/vizEvents.js';
import { eventsArb, RANDOM_OFFICE } from '../../helpers/vizScene.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, ...rel.split('/')), 'utf8');

const END = Number.MAX_SAFE_INTEGER;
const at =(height: number, sub = 0, k = 0): Position => ({ height, sub, k });

// Peers and seats: model ids (32 hex peers, seat keys) — follow.ts treats every id as an opaque string.
const A = 'a1'.repeat(16), B = 'b2'.repeat(16);
const seat = (owner: PeerRef, n: number): SeatRef => `${owner}/${'e'.repeat(32)}/${n.toString(16).padStart(32, '0')}`;
const PA = seat(A, 1), PA2 = seat(A, 2), QB = seat(B, 1);

const publish = (actor: ActorRef, target: number, pos: [number, number, number]): SceneEvent =>
  ev('publish', pos, { actor, target, others: [], paths: ['x'], n: 1, state: 'closed', checks: 'pass', origin: 'peer' in actor ? 'human' : 'prompt' });

/** The scenes after each event of `events` (index i: after events[0..i]). */
function scenes(layout: Layout, events: readonly SceneEvent[], start: Scene = emptyScene(at(0))): Scene[] {
  const r = new SceneReducer(start, () => layout);
  return events.map((e) => {
    r.push(e);
    return r.scene();
  });
}

/** The tiles of the followed actors (placeTile, as the client draws them) and the focus actor's tile. */
function followTiles(prev: Scene | null, s: Scene, peer: PeerRef, layout: Layout): { tiles: Tile[]; focus: Tile | null } {
  const placeOf = (a: ActorRef): Tile => placeTile('peer' in a ? s.characters.get(a.peer)!.place : s.pets.get(a.seat)!.place, layout, s);
  const f = focusActor(prev, s, peer);
  return { tiles: followedActors(s, peer).map(placeOf), focus: f === null ? null : placeOf(f) };
}

// ---------------------------------------------------------------------------------------------------------------------------
// An office of 12 cells (12 zones of one desk each, so desk i + 1 sits in slot 0 of cell i): 4 + 10 · 4 = 44 tiles tall.

function office12(): Layout {
  const b = new LayoutBuilder(emptyLayout());
  b.home(A);
  b.home(B);
  for (let i = 0; i < 12; i++) b.desk(`z${i}/f.ts`, 1);
  return b.layout();
}
const CELL = (i: number): number => i + 1;          // the desk in slot 0 of cell i

test('T-VIZ-follow-camera: the three-step camera over the followed actors', () => {
  const layout = office12();
  assert.equal(officeTiles(layout).h, 44);
  assert.deepEqual([0, 1, 3, 4, 5, 10, 11].map((c) => deskTiles(layout, CELL(c)).chair.y), [6, 6, 16, 16, 16, 36, 36]);
  const H = officeTiles(layout).h;
  const camera = (prev: Scene | null, s: Scene, view: { top: number; h: number }, force = false): number | null => {
    const { tiles, focus } = followTiles(prev, s, A, layout);
    return cameraTarget(tiles, focus, view, H, force);
  };
  const events = [
    ev('person_enter', [1, 1, 0], { peer: A }), ev('person_enter', [1, 2, 0], { peer: B }),
    ev('pet_spawn', [1, 1_001, 0], { seat: PA, owner: A }), ev('pet_spawn', [1, 1_001, 1], { seat: QB, owner: B }),
    publish({ peer: A }, CELL(0), [2, 1_001, 0]), publish({ seat: PA }, CELL(1), [2, 1_001, 1]),   // 5: A at cell 0, its pet at cell 1 (y 6)
    publish({ peer: B }, CELL(11), [3, 1_001, 0]),                                                 // 6: B publishes in cell 11
    publish({ seat: PA }, CELL(10), [4, 1_001, 0]),                                                // 7: A's pet walks to cell 10 (y 36)
    publish({ peer: A }, CELL(3), [5, 1_001, 0]), publish({ seat: PA }, CELL(4), [5, 1_001, 1]),   // 9: both to cells 3 and 4 (y 16)
    publish({ peer: A }, CELL(5), [6, 1_001, 0]),                                                  // 10: A to cell 5 (y 16)
    publish({ peer: B }, CELL(11), [7, 1_001, 0]),                                                 // 11: a B beat
    publish({ peer: A }, CELL(5), [8, 1_001, 0]),                                                  // 12: an A beat, no place change
    publish({ peer: A }, CELL(3), [9, 1_001, 0]),                                                  // 13: an A move
  ];
  const s = scenes(layout, events);
  assert.deepEqual(followedActors(s[5]!, A), [{ peer: A }, { seat: PA }]);
  // The followed actors and the focus: the character, then live pets in ascending seat handle whatever order they spawned in (a live
  // page appends pets as they come; a served scene lists them sorted); a poofed pet and another peer's pet are not followed.
  const order = scenes(layout, [
    ev('person_enter', [1, 1, 0], { peer: A }), ev('pet_spawn', [1, 1_001, 0], { seat: PA2, owner: A }), ev('pet_spawn', [1, 1_001, 1], { seat: QB, owner: B }),
    ev('pet_spawn', [1, 1_001, 2], { seat: PA, owner: A }), publish({ seat: PA2 }, CELL(2), [2, 1_001, 0]), ev('person_exit', [3, 1, 0], { peer: A }),
    ev('pet_poof', [4, 1_002, 0], { seat: PA, owner: A }),
  ]);
  assert.deepEqual([...order[3]!.pets.keys()], [PA2, QB, PA], 'spawned out of order');
  assert.deepEqual(followedActors(order[3]!, A), [{ peer: A }, { seat: PA }, { seat: PA2 }]);
  assert.deepEqual(focusActor(null, order[3]!, A), { peer: A }, 'none moved: the character');
  assert.deepEqual(focusActor(order[3]!, order[4]!, A), { seat: PA2 }, 'the pet that moved');
  assert.deepEqual(focusActor(order[4]!, order[5]!, A), { seat: PA }, 'no character: the first pet');
  assert.deepEqual(followedActors(order[6]!, A), [{ seat: PA2 }]);
  assert.deepEqual([followedActors(order[6]!, B), focusActor(null, order[6]!, B)], [[{ seat: QB }], { seat: QB }], 'B never entered: its pet alone');
  assert.equal(focusActor(null, order[6]!, 'c3'.repeat(16)), null, 'nothing followed');
  assert.deepEqual(followTiles(s[4]!, s[5]!, A, layout).tiles.map((t) => t.y), [6, 6]);
  const view = { top: 0, h: 20 };
  // Both visible (frame rows 5–7 inside rows 0–19): nothing scrolls; B's publish in cell 11 scrolls nothing either.
  assert.equal(camera(s[4]!, s[5]!, view), null);
  assert.equal(camera(s[5]!, s[6]!, view), null);
  // The pet walks to cell 10: the frame (rows 5–37, 33 tiles) does not fit 20 → the pet's tile is centred, clamped to the office.
  assert.deepEqual(followTiles(s[6]!, s[7]!, A, layout), { tiles: [{ x: 0, y: 6 }, { x: 7, y: 36 }], focus: { x: 7, y: 36 } });
  assert.equal(camera(s[6]!, s[7]!, view), 24);                        // view rows 24–43
  view.top = 24;
  // Both walk to cells 3 and 4 (y 16, above the view): the frame (rows 15–17) fits and is centred.
  assert.equal(camera(s[7]!, s[9]!, view), 6.5);
  view.top = 6.5;
  // One of them walks to cell 5 (y 16, inside the view): step 1, nothing scrolls; a chip click centres the frame even so.
  assert.equal(camera(s[9]!, s[10]!, view), null);
  assert.equal(camera(s[9]!, s[10]!, view, true), 6.5);
  // The arithmetic alone: a frame clamped at the office's edges, a view taller than the office, no tile, no focus.
  assert.equal(cameraTarget([{ x: 2, y: 0 }], null, { top: 0, h: 20 }, 44, false), null, 'row 0 with its margin clamped to the office');
  assert.equal(cameraTarget([{ x: 2, y: 43 }], null, { top: 0, h: 20 }, 44, false), 24);
  assert.equal(cameraTarget([{ x: 2, y: 30 }], null, { top: 0, h: 60 }, 44, false), null);
  assert.equal(cameraTarget([{ x: 2, y: 30 }], null, { top: 5, h: 60 }, 44, true), 0);
  assert.equal(cameraTarget([], null, { top: 0, h: 20 }, 44, true), null, 'nothing followed: nothing scrolls');
  assert.equal(cameraTarget([{ x: 0, y: 2 }, { x: 0, y: 40 }], null, { top: 10, h: 20 }, 44, false), 0, 'no focus: the first tile');
  // The horizontal axis through the same function (x as y, widths as heights): a panel 10 tiles wide over the 21-tile office.
  assert.equal(cameraTarget([{ x: 14, y: 0 }].map((t) => ({ x: t.y, y: t.x })), null, { top: 0, h: 10 }, 21, false), 9.5);
  // The frame is the bounding box plus a 1-tile margin (step 1), rows [start, end), clamped to the office: the brief's two frames.
  assert.deepEqual(cameraFrame(followTiles(s[6]!, s[7]!, A, layout).tiles, H), { start: 5, end: 38 }, 'rows 5–37, 33 tiles');
  assert.deepEqual(cameraFrame(followTiles(s[7]!, s[9]!, A, layout).tiles, H), { start: 15, end: 18 }, 'rows 15–17');
  assert.deepEqual([cameraFrame([{ x: 2, y: 0 }], H), cameraFrame([{ x: 2, y: 43 }], H), cameraFrame([], H)], [{ start: 0, end: 2 }, { start: 42, end: 44 }, null]);
  // The margin decides (margin 0 or 2 fails one of these): a tile at row 19 of view rows 0–19 is visible but its frame (rows 18–20)
  // is not, so step 2 centres it; a tile at row 18 (frame rows 17–19) is inside. At the view's top edge: row 24 of view rows 24–43
  // scrolls (frame row 23 is above), row 25 does not.
  assert.equal(cameraTarget([{ x: 0, y: 19 }], null, { top: 0, h: 20 }, H, false), 9.5);
  assert.equal(cameraTarget([{ x: 0, y: 18 }], null, { top: 0, h: 20 }, H, false), null);
  assert.equal(cameraTarget([{ x: 0, y: 24 }], null, { top: 24, h: 20 }, H, false), 14.5);
  assert.equal(cameraTarget([{ x: 0, y: 25 }], null, { top: 24, h: 20 }, H, false), null);
  // A 19-row box (rows 10–28) is 21 rows with the margin: it no longer fits 20, so step 3 centres the focus (row 10), not the box; an
  // 18-row box (rows 10–27) is 20 rows with it and still fits, so step 2 centres the box.
  assert.equal(cameraTarget([{ x: 0, y: 10 }, { x: 0, y: 28 }], { x: 0, y: 10 }, { top: 30, h: 20 }, H, false), 0.5);
  assert.equal(cameraTarget([{ x: 0, y: 10 }, { x: 0, y: 27 }], { x: 0, y: 10 }, { top: 30, h: 20 }, H, false), 9);

  // FEAT-F32-04: after a user scroll, a B beat and an A beat with no place change scroll nothing; the next A move does.
  const cam = new FollowCamera();
  assert.equal(cam.due(s[4]!, s[5]!, A), true, 'no user scroll: every beat evaluates the camera');
  cam.userScrolled();
  assert.equal(cam.due(s[10]!, s[11]!, A), false, 'a B beat');
  assert.equal(cam.due(s[11]!, s[12]!, A), false, 'an A beat with no place change');
  assert.equal(cam.due(s[12]!, s[13]!, A), true, 'the next A move');
  assert.equal(cam.due(s[12]!, s[12]!, A), true, 'the user scroll is honoured once only');
  cam.userScrolled();
  assert.equal(cam.due(null, s[12]!, A), true, 'follow start, a chip click or a room switch (no previous scene) evaluate at once');
  assert.equal(cam.due(s[11]!, s[12]!, A), true);

  // The page's choice per room after a live beat (client/main.ts calls beatScroll): in a room with a follow the follow camera alone,
  // whoever's event the beat carries (another actor's event never scrolls the panel there, FEAT-F32-03); in room 2 without a follow,
  // the 30 s rule toward the desk of the beat's first publish; no publish, no follow: nothing.
  const bBeat = [ev('person_enter', [7, 1, 0], { peer: B }), publish({ peer: B }, CELL(11), [7, 1_001, 0]), publish({ peer: A }, CELL(5), [7, 1_001, 1])];
  assert.deepEqual(beatScroll(A, bBeat), { by: 'camera' });
  assert.deepEqual(beatScroll(A, [publish({ peer: B }, CELL(11), [7, 1_001, 0])]), { by: 'camera' }, 'a B beat in a room that follows A');
  assert.deepEqual(beatScroll(A, []), { by: 'camera' });
  assert.deepEqual(beatScroll(null, bBeat), { by: 'rule', desk: CELL(11) });
  assert.equal(beatScroll(null, [ev('person_enter', [7, 1, 0], { peer: B })]), null);
  // Room 2 without a follow: the 30 s rule scrolls to an off-screen event only 30 s after the last user scroll (FollowRule, §3.5.3).
  const rule = new FollowRule();
  rule.scrolled(1_000);
  assert.equal(rule.follow(30_999), false);
  assert.equal(rule.follow(31_000), true);
  const main = read('src/viz/client/main.ts');
  assert.match(main, /const scroll = beatScroll\(followed\(\), b\.events\);/u, 'main.ts asks beatScroll after a live beat');
  assert.doesNotMatch(main, /followed\(\) !== null\) office\.camera\('beat'\)/u, 'and makes no choice of its own');
});

// ---------------------------------------------------------------------------------------------------------------------------

/** The office panel as the follow camera moves it (CSS px): the view it reports, and every move FollowCamera.step returned, applied
 *  (client/office.ts runs a move as a jump, or as a pan over the move's `ms`). */
class FakeScroller {
  top = 0;
  left = 0;
  readonly calls: FollowMove[] = [];
  constructor(readonly w: number, readonly h: number) {}
  view(): FollowView {
    return { top: this.top, left: this.left, w: this.w, h: this.h };
  }
  apply(m: FollowMove | null): FollowMove | null {
    if (m !== null) {
      this.calls.push(m);
      this.top = m.top;
      this.left = m.left;
    }
    return m;
  }
}

test('T-VIZ-follow-motion: pan or jump', () => {
  assert.equal(FOLLOW_PAN_MS, 300);
  const layout = office12();
  const office = officeTiles(layout);
  // Z = 2 at dpr 1 (32 CSS px a tile): a panel 672 × 640 CSS px shows the office's whole width (21 tiles) and 20 of its 44 rows.
  const zoom = new ZoomState(OFFICE_W * TILE_PX);
  zoom.open(672);
  assert.equal(zoom.z, 2);
  /** One camera evaluation as client/office.ts runs it: FollowCamera.step over the scene on screen, the followed actors' tiles where the
   *  office draws them (placeTile), the zoom and the panel; the move it returns goes to the scroller. */
  const step = (cam: FollowCamera, sc: FakeScroller, s: Scene, cause: FollowCause, o: { speed?: number; reduced?: boolean; paused?: boolean; z?: ZoomState } = {}): FollowMove | null =>
    sc.apply(cam.step({
      cause, peer: A, s, office, zoom: o.z ?? zoom, dpr: 1, view: sc.view(), paused: o.paused ?? false, reduced: o.reduced ?? false, speed: o.speed ?? 1,
      tileOf: (a) => placeTile('peer' in a ? s.characters.get(a.peer)!.place : s.pets.get(a.seat)!.place, layout, s),
    }));
  const base = [
    ev('person_enter', [1, 1, 0], { peer: A }), ev('pet_spawn', [1, 1_001, 0], { seat: PA, owner: A }),
    publish({ peer: A }, CELL(0), [2, 1_001, 0]), publish({ seat: PA }, CELL(1), [2, 1_001, 1]),
  ];
  // Beats that alternate the pet between cell 10 (frame too tall: scroll to row 24) and cell 1 (frame rows 5–7: scroll to row 0).
  const alternate = (n: number): SceneEvent[] => Array.from({ length: n }, (_, i) => publish({ seat: PA }, CELL(i % 2 === 0 ? 10 : 1), [3 + i, 1_001, 0]));
  const s = scenes(layout, [...base, ...alternate(100)]);
  const head = s[3]!, away = s[4]!;
  const to = (top: number, motion: 'pan' | 'jump', left = 0): FollowMove => ({ top, left, motion, ms: motion === 'pan' ? 300 : 0 });
  /** A camera that framed `head` (both actors in view: nothing scrolls), then one evaluation of `away` (the pet at cell 10). */
  const run = (cause: FollowCause, o: { speed?: number; reduced?: boolean; paused?: boolean } = {}): FakeScroller => {
    const cam = new FollowCamera(), sc = new FakeScroller(672, 640);
    assert.equal(step(cam, sc, head, 'beat'), null);
    step(cam, sc, away, cause, o);
    return sc;
  };
  assert.deepEqual(run('beat', { speed: 2 }).calls, [to(768, 'pan')], '2× replay: one 300 ms smooth scroll (row 24 = 768 CSS px)');
  assert.deepEqual(run('beat').calls, [to(768, 'pan')], 'a live beat pans');
  assert.deepEqual(run('beat', { speed: 3.99 }).calls, [to(768, 'pan')]);
  assert.deepEqual(run('beat', { speed: 4 }).calls, [to(768, 'jump')], '4×: a jump (the speed threshold of shouldPoof)');
  assert.deepEqual(run('beat', { speed: 8 }).calls, [to(768, 'jump')]);
  // Effective reduced motion through the page's own rule (MotionPreference, which client/a11y.ts holds and the office reads): the OS
  // setting alone, the in-page toggle alone, and the toggle overriding the OS in both directions.
  const os = new MotionPreference(), toggledOn = new MotionPreference(), toggledOff = new MotionPreference();
  toggledOn.toggle(false);
  toggledOff.toggle(true);
  assert.deepEqual([new MotionPreference().reduced(false), os.reduced(true), toggledOn.reduced(false), toggledOff.reduced(true)], [false, true, true, false]);
  assert.deepEqual(run('beat', { reduced: os.reduced(true) }).calls, [to(768, 'jump')], 'emulated prefers-reduced-motion');
  assert.deepEqual(run('beat', { reduced: toggledOn.reduced(false) }).calls, [to(768, 'jump')], 'the in-page toggle');
  assert.deepEqual(run('beat', { reduced: toggledOff.reduced(true) }).calls, [to(768, 'pan')], 'the toggle overrides the OS both ways');
  // A seek, a room_snapshot, "load earlier" and a room switch jump; follow start and a chip click pan. A room switch, follow start and a
  // chip click compare with no previous scene (the focus is the character, row 6: view top 0); the others with the framed one (the pet).
  for (const cause of ['seek', 'snapshot', 'earlier'] as const) assert.deepEqual(run(cause).calls, [to(768, 'jump')], cause);
  assert.deepEqual(run('room').calls, [to(0, 'jump')], 'room');
  for (const cause of ['start', 'chip'] as const) assert.deepEqual(run(cause).calls, [to(0, 'pan')], cause);
  for (const cause of ['seek', 'snapshot', 'earlier', 'room'] as const) assert.equal(followMotion({ reducedMotion: false, speed: 1, cause }), 'jump');
  for (const cause of ['start', 'beat', 'chip'] as const) assert.equal(followMotion({ reducedMotion: false, speed: 1, cause }), 'pan', cause);

  // FEAT-F32-04 through the step: after a user scroll (the panel moved to 100 CSS px), a beat, a seek, a room_snapshot or "load earlier"
  // with no followed place change moves nothing; follow start, a chip click and a room switch — the fresh causes, which compare with no
  // previous scene — move it at once; and the next beat in which a followed actor's place changes ends the honoured scroll.
  for (const cause of ['beat', 'seek', 'snapshot', 'earlier', 'start', 'chip', 'room'] as const) {
    const cam = new FollowCamera(), sc = new FakeScroller(672, 640);
    assert.deepEqual(step(cam, sc, away, 'beat'), to(0, 'pan'), 'framed: away (no previous scene: the character centred)');
    cam.userScrolled();
    sc.top = 100;
    const fresh = cause === 'start' || cause === 'chip' || cause === 'room';
    assert.deepEqual(step(cam, sc, away, cause), fresh ? to(0, cause === 'room' ? 'jump' : 'pan') : null, cause);
  }
  {
    const cam = new FollowCamera(), sc = new FakeScroller(672, 640);
    assert.equal(step(cam, sc, head, 'beat'), null);
    cam.userScrolled();
    sc.top = 100;
    assert.equal(step(cam, sc, head, 'beat'), null, 'no place change: the user scroll is honoured');
    assert.deepEqual(step(cam, sc, away, 'beat'), to(768, 'pan'), 'the pet moved');
  }

  // Paused (WCAG 2.2.2; 12 §3.8.1 "no beats, so no pan"): a beat or a room_snapshot — the scene's own motion — makes no scroll call,
  // and the scene it brings is not taken as framed, so after the pause the next beat compares with what was framed before it (the pet
  // moved: the honoured user scroll ends).
  {
    const cam = new FollowCamera(), sc = new FakeScroller(672, 640);
    assert.equal(step(cam, sc, head, 'beat'), null);
    cam.userScrolled();
    assert.equal(step(cam, sc, away, 'beat', { paused: true }), null);
    assert.equal(step(cam, sc, away, 'snapshot', { paused: true }), null);
    assert.deepEqual(sc.calls, [], 'paused → no scroll call');
    assert.deepEqual(step(cam, sc, away, 'beat'), to(768, 'pan'), 'unpaused: the next beat');
  }
  // A user's own action while paused — follow start, a chip click, a seek, "load earlier", a room switch — still moves the camera
  // (12 §3.8.1 evaluates the camera on each of them; the pause stops beats), by a jump: nothing pans while the page is paused.
  for (const cause of ['start', 'chip', 'seek', 'earlier', 'room'] as const) {
    const fresh = cause === 'start' || cause === 'chip' || cause === 'room';
    assert.deepEqual(run(cause, { paused: true }).calls, [to(fresh ? 0 : 768, 'jump')], `paused, ${cause}`);
  }

  // Both axes: in a panel 10 tiles wide (320 CSS px) the office is wider, so the camera moves it horizontally too. The pet walks to
  // cell 2 (column 14, row 6): the vertical frame stays inside the view, the horizontal one (columns 0–15) does not fit 10, so the pet's
  // column is centred (9.5 tiles = 304 CSS px) and only the left offset moves; in a panel as wide as the office the same beat moves nothing.
  const east = scenes(layout, [...base, publish({ seat: PA }, CELL(2), [3, 1_001, 0])]);
  assert.deepEqual(deskTiles(layout, CELL(2)).chair, { x: 14, y: 6 });
  for (const [w, want] of [[320, [to(0, 'pan', 304)]], [672, []]] as const) {
    const cam = new FollowCamera(), sc = new FakeScroller(w, 640);
    assert.equal(step(cam, sc, east[3]!, 'beat'), null);
    step(cam, sc, east[4]!, 'beat');
    assert.deepEqual(sc.calls, want, `a panel ${w} CSS px wide`);
  }

  // The camera works in the zoom it is given: at Z = 4 (64 CSS px a tile) the same 640 px panel shows 10 rows, so the pet at cell 10 is
  // centred at row 31.5 = 2,016 CSS px.
  const zoom4 = new ZoomState(OFFICE_W * TILE_PX);
  zoom4.open(1_344);
  assert.equal(zoom4.z, 4);
  {
    const cam = new FollowCamera(), sc = new FakeScroller(672, 640);
    assert.equal(step(cam, sc, head, 'beat', { z: zoom4 }), null);
    assert.deepEqual(step(cam, sc, away, 'beat', { z: zoom4 }), to(2_016, 'pan'));
  }

  // 100 beats with a follow: the camera scrolled on every one, and Z and the coarse flag of the zoom it was given never changed
  // (FEAT-F32-03).
  const z = zoom.z, coarse = zoom.coarse;
  const cam = new FollowCamera(), sc = new FakeScroller(672, 640);
  assert.equal(step(cam, sc, s[3]!, 'beat'), null);
  for (let i = 4; i < 104; i++) step(cam, sc, s[i]!, 'beat');
  assert.equal(sc.calls.length, 100);
  assert.deepEqual([...new Set(sc.calls.map((c) => c.top))].sort((x, y) => x - y), [0, 768]);
  assert.deepEqual([zoom.z, zoom.coarse, zoom4.z, zoom4.coarse], [z, coarse, 4, false]);

  // The page runs exactly this: office.ts hands every camera evaluation to FollowCamera.step (no camera decision of its own) with the
  // pause, the effective reduced motion and the speed, and runs the move it returns; client/a11y.ts's reduced() is MotionPreference's.
  const officeTs = read('src/viz/client/office.ts');
  assert.match(officeTs, /camera\.step\(\{/u);
  assert.match(officeTs, /paused: deps\.paused\(\), reduced: deps\.reduced\(\), speed: speedNow/u);
  assert.doesNotMatch(officeTs, /\b(cameraTarget|followMotion|focusActor|followedActors|FOLLOW_PAN_MS)\b/u, 'no camera decision in office.ts');
  const a11yTs = read('src/viz/client/a11y.ts');
  assert.match(a11yTs, /const reduced = \(\): boolean => motion\.reduced\(query\.matches\);/u);
  assert.match(a11yTs, /motion\.toggle\(query\.matches\);/u);
});

// ---------------------------------------------------------------------------------------------------------------------------
// The now card's office: zone src holds src/cart.ts and 22 more file desks, so its 24th path goes to its shelf desk; 14 more zones
// fill the 15 regular ones, so over/x.ts gets a folder desk in the overflow zone.

const SRC = ['src/cart.ts', ...Array.from({ length: 22 }, (_, i) => `src/f${i}.ts`)];
function nowOffice(): { layout: Layout; cart: number; f0: number; f1: number; f3: number; shelf: number; z0: number; folder: number } {
  const b = new LayoutBuilder(emptyLayout());
  b.home(A);
  b.home(B);
  for (const p of SRC) b.desk(p, 1);
  const shelf = b.desk('src/zz.ts', 1);
  for (let i = 0; i < 14; i++) b.desk(`z${i}/a.ts`, 1);
  const folder = b.desk('over/x.ts', 1);
  const layout = b.layout();
  const d = (p: string): number => layout.deskOf.get(p)!;
  return { layout, cart: d('src/cart.ts'), f0: d('src/f0.ts'), f1: d('src/f1.ts'), f3: d('src/f3.ts'), shelf, z0: d('z0/a.ts'), folder };
}
const claim = (claimId: string, seatRef: SeatRef, desk: number, order: number, simple: string, pos: [number, number, number]): SceneEvent =>
  ev('claim_take', pos, { claimId, seat: seatRef, desk, order, label: { simple, qualname: `Mod.${simple}` }, granularity: 'symbol', lines: [order, order + 3], otherRules: false });
const request = (id: string, from: ActorRef, holder: ActorRef, desk: number, pos: [number, number, number]): SceneEvent =>
  ev('request_open', pos, { request: id, from, holder, desk, requestKind: 'handoff', estMinutes: null, attempt: 1, note: null });

/** A has pets P1 (PA) and P2 (PA2), B has Q1 (QB); P1 holds 4 HELD claims and 1 STALE; R1 P1 → Q1 queued, R3 P1 → B, R2 Q1 → P2;
 *  A's character publishes at (38, 1001, 0) and P2 at (40, 1001, 0) at src/cart.ts. */
function nowEvents(o: ReturnType<typeof nowOffice>): SceneEvent[] {
  return [
    ev('person_enter', [1, 1, 0], { peer: A }), ev('person_enter', [1, 2, 0], { peer: B }),
    ev('pet_spawn', [2, 1_001, 0], { seat: PA, owner: A }), ev('pet_spawn', [2, 1_001, 1], { seat: PA2, owner: A }),
    ev('pet_spawn', [2, 1_001, 2], { seat: QB, owner: B }),
    claim('c1', PA, o.f1, 10, 'parse', [3, 1, 0]), claim('c2', PA, o.f0, 20, 'emit', [3, 2, 0]), claim('c3', PA, o.f0, 5, 'parse', [3, 3, 0]),
    claim('c4', PA, o.f3, 1, 'load', [3, 4, 0]), claim('c5', PA, o.f0, 1, 'emit', [3, 5, 0]), ev('claim_stale', [3, 6, 0], { claimId: 'c5' }),
    request('R1', { seat: PA }, { seat: QB }, o.f1, [4, 1, 0]), ev('request_status', [4, 2, 0], { request: 'R1', holder: { seat: QB }, status: 'queued_until_turn_end' }),
    request('R3', { seat: PA }, { peer: B }, o.f0, [4, 3, 0]), request('R2', { seat: QB }, { seat: PA2 }, o.cart, [4, 4, 0]),
    publish({ peer: A }, o.z0, [38, 1_001, 0]), publish({ seat: PA2 }, o.cart, [40, 1_001, 0]),
  ];
}

test('T-VIZ-follow-now: the now card rows', () => {
  assert.equal(NOW_ROWS_MAX, 3);
  const o = nowOffice();
  const s = scenes(o.layout, nowEvents(o)).at(-1)!;
  const card = nowCard(s, o.layout, A);
  assert.deepEqual(card, {
    peer: A, here: true,
    // HELD claims of A's pets by desk ordinal, then order; the stale c5 is no row; c2's simple 'emit' is shared on its desk (by the
    // stale c5), so its tag is the qualname (12 §3.5.4 chair tags).
    holding: [{ path: 'src/f0.ts', label: 'parse' }, { path: 'src/f0.ts', label: 'Mod.emit' }, { path: 'src/f1.ts', label: 'parse' }],
    asks: [{ target: B, id: 'R1' }, { target: B, id: 'R3' }],                 // R1 to Q1 (B's pet: its owner), R3 to B's character
    askedBy: [{ target: B, id: 'R2' }],                                        // R2 from Q1 to P2
    lastShared: { path: 'src/cart.ts', height: 40 },                           // P2's (40, 1001, 0) is newer than the character's (38, …)
    more: { holding: 1, asks: 0, askedBy: 0 },                                 // 4 HELD claims, 3 shown
  });
  assert.equal(s.requests.get('R1')!.status, 'queued_until_turn_end', 'R1 carries its status icon; R3 none');
  assert.equal(s.requests.get('R3')!.status, null);
  // B's side of the same requests.
  assert.deepEqual(nowCard(s, o.layout, B), {
    peer: B, here: true, holding: [], asks: [{ target: A, id: 'R2' }], askedBy: [{ target: A, id: 'R1' }, { target: A, id: 'R3' }],
    lastShared: null, more: { holding: 0, asks: 0, askedBy: 0 },
  });
  // P2 ends (live false): it still made A's newest share.
  const ended = scenes(o.layout, [ev('pet_poof', [41, 1_002, 0], { seat: PA2, owner: A })], s)[0]!;
  assert.equal(ended.pets.get(PA2)!.live, false);
  assert.deepEqual(nowCard(ended, o.layout, A).lastShared, { path: 'src/cart.ts', height: 40 });
  // The newest publish's desk by its kind: a folder desk's plaque, a shelf desk's zone sign + '/…', the big table (path null).
  const at2 = (desk: number): Scene => {
    const v = structuredClone(ended);
    v.pets.get(PA2)!.lastDesk = desk;
    return v;
  };
  assert.deepEqual(nowCard(at2(o.folder), o.layout, A).lastShared, { path: 'over', height: 40 });
  assert.deepEqual(nowCard(at2(o.shelf), o.layout, A).lastShared, { path: 'src/\u{2026}', height: 40 });
  assert.deepEqual(nowCard(at2(0), o.layout, A).lastShared, { path: null, height: 40 });
  // More than three asks, asked-by and holding rows each: three, and the rest counted.
  const many = structuredClone(s);
  for (const id of ['R4', 'R5', 'R6']) many.requests.set(id, { from: { peer: A }, holder: { peer: B }, desk: o.f0, status: null });
  const m = nowCard(many, o.layout, A);
  assert.deepEqual(m.asks.map((x) => x.id), ['R1', 'R3', 'R4']);
  assert.deepEqual(m.more, { holding: 1, asks: 2, askedBy: 0 });

  // The header label: phOf over the drawn scene — frozen with PAUSED → PH_PAUSED; a ghost → none.
  const frozen = scenes(o.layout, [ev('person_freeze', [50, 1, 0], { peer: A, reasonCode: 'PAUSED' })], s)[0]!;
  const fc0 = frozen.characters.get(A)!;
  assert.equal(phOf(fc0, fc0.absent ? 'absent' : 'active', frozen.at), 'PH_PAUSED');
  const ghost = scenes(o.layout, [ev('person_ghost', [50, 1_002, 0], { peer: A })], s)[0]!;
  const gc = ghost.characters.get(A)!;
  assert.equal(phOf(gc, gc.absent ? 'absent' : 'active', ghost.at), null);
  // A at home with nothing: every list empty and no share (the empty row); A removed from the characters: not here.
  const home = scenes(o.layout, [ev('person_enter', [1, 1, 0], { peer: A })])[0]!;
  assert.deepEqual(nowCard(home, o.layout, A), { peer: A, here: true, holding: [], asks: [], askedBy: [], lastShared: null, more: { holding: 0, asks: 0, askedBy: 0 } });
  const gone = scenes(o.layout, [ev('person_exit', [60, 1, 0], { peer: A })], s)[0]!;
  assert.equal(nowCard(gone, o.layout, A).here, false);
  // The card reads the scene and the layout only: three parameters, no overlay (holds 7, incoming 5, "you" = A) can reach it.
  assert.equal(nowCard.length, 3);

  // ----- The rows the page renders (nowRows, rendered with the en catalog in channel viz).
  const names = new Map([[A, 'Ann'], [B, 'Bob']]);
  const nameOf = (p: PeerRef): string => names.get(p) ?? p;
  const text = (r: NowRow): string => renderWith({ en: EN_VIZ }, REASON_CODES, r.code, r.params, 'viz', 'en');
  const rows = nowRows(card, s, nameOf);
  assert.deepEqual(rows.map((r) => [r.row, text(r), r.label, r.link]), [
    ['header', 'Following Ann', 'PH_OK', null],
    ['holding', 'holding parse', 'UI_VIZ_LABEL_UNVERIFIED', 'src/f0.ts'],
    ['holding', 'holding Mod.emit', 'UI_VIZ_LABEL_UNVERIFIED', 'src/f0.ts'],
    ['holding', 'holding parse', 'UI_VIZ_LABEL_UNVERIFIED', 'src/f1.ts'],
    ['more', '+1', null, null],                                              // 4 HELD claims: three rows, then UI_VIZ_MORE n = 1
    ['asks', 'asks Bob (R1)', 'UI_VIZ_ICON_QUEUED', 'R1'],                   // queued_until_turn_end → the queued icon
    ['asks', 'asks Bob (R3)', null, 'R3'],                                   // status null → no icon
    ['asked_by', 'asked by Bob (R2)', null, 'R2'],
    ['last_shared', 'last shared: src/cart.ts (#40)', null, null],
  ]);
  const lastRow = (sc: Scene): string => text(nowRows(nowCard(sc, o.layout, A), sc, nameOf).find((r) => r.row === 'last_shared')!);
  assert.equal(lastRow(ended), 'last shared: src/cart.ts (#40)', 'P2 ended: the same row');
  assert.equal(lastRow(at2(o.folder)), 'last shared: over (#40)');
  assert.equal(lastRow(at2(o.shelf)), 'last shared: src/\u{2026} (#40)');
  assert.equal(lastRow(at2(0)), 'last shared: a change too large to list (#40)');
  assert.deepEqual(nowRows(m, many, nameOf).filter((r) => r.row === 'asks' || r.row === 'more').map(text), ['+1', 'asks Bob (R1)', 'asks Bob (R3)', 'asks Bob (R4)', '+2']);
  // The header's PH label: PH_PAUSED when frozen with PAUSED, none for a ghost.
  assert.equal(nowRows(nowCard(frozen, o.layout, A), frozen, nameOf)[0]!.label, 'PH_PAUSED');
  assert.equal(nowRows(nowCard(ghost, o.layout, A), ghost, nameOf)[0]!.label, null);
  // At home with nothing: the empty row; removed from the characters: the not-here row only.
  assert.deepEqual(nowRows(nowCard(home, o.layout, A), home, nameOf).map(text), ['Following Ann', 'Nothing held, asked or shared yet in this view.']);
  assert.deepEqual(nowRows(nowCard(gone, o.layout, A), gone, nameOf).map((r) => [r.row, text(r), r.label]), [
    ['header', 'Following Ann', null], ['not_here', 'Ann is not in this room at this point.', null],
  ]);
  // The overlay canary (holds 7, incoming 5, A is "you"): neither the card nor its rows take an overlay, so no overlay value and no
  // "you" mark can show; and no row ever says "working on" (VIZ-17) — every row code is one of the now card's own.
  assert.equal(nowRows.length, 3);
  const all = [card, nowCard(ended, o.layout, A), nowCard(home, o.layout, A), nowCard(gone, o.layout, A)].flatMap((x, i) => nowRows(x, [s, ended, home, gone][i]!, nameOf));
  const texts = all.map(text);
  for (const t of texts) {
    assert.doesNotMatch(t, /\b(7|5)\b/u, `no overlay count in ${JSON.stringify(t)}`);
    assert.doesNotMatch(t, /working on|\byou\b|ago|offline|last seen/iu, t);
  }
  const ROW_CODES = new Set(['UI_VIZ_FOLLOWING', 'UI_VIZ_HOLDING', 'UI_VIZ_MORE', 'UI_VIZ_NOW_ASKS', 'UI_VIZ_NOW_ASKED_BY', 'UI_VIZ_NOW_LAST_SHARED',
    'UI_VIZ_NOW_LAST_SHARED_TABLE', 'UI_VIZ_NOW_NOTHING', 'UI_VIZ_NOW_NOT_HERE']);
  assert.ok(all.every((r) => ROW_CODES.has(r.code)), 'only the now card\'s codes');
});

// ---------------------------------------------------------------------------------------------------------------------------

/** A page's view over handles: segments every 256 heights whose start scenes are the reduced scenes at their hs (T-VIZ-seek's form). */
function pageView(events: SceneEvent[], layout: Layout): TimelineView {
  const top = events.at(-1)?.height ?? 0;
  const whole: TimelineView = { segments: [{ hs: 0, start: emptyScene(at(0)) }], events, layout };
  const segments: Array<{ hs: number; start: Scene }> = [{ hs: 0, start: emptyScene(at(0)) }];
  for (let hs = 256; hs <= top; hs += 256) segments.push({ hs, start: reduceScene(whole, at(hs, END, END)) });
  return { segments, events, layout };
}

test('T-VIZ-follow-replay: live and replay agree', () => {
  // T-VIZ-seek's events and positions, projected to the page's ids (handles) and its layout.
  const events = fc.sample(eventsArb({ minLength: 300, maxLength: 300 }), { numRuns: 1, seed: 8_013 })[0]!;
  const h = createHandleTable();
  for (const e of events) projectEvent(e, h);
  projectLayout(RANDOM_OFFICE, h);
  h.takeCollision();
  const page = events.map((e) => unprojectEvent(projectEvent(e, h)));
  const layout = unprojectLayout(projectLayout(RANDOM_OFFICE, h));
  const peers = [...layout.homeOrder];
  assert.equal(peers.length, 3);
  const top = page.at(-1)!.height;
  const positions = fc.sample(fc.record({ h: fc.integer({ min: 0, max: top + 10 }), sub: fc.integer({ min: 0, max: 1_002 }), k: fc.integer({ min: 0, max: 3 }) }), { numRuns: 200, seed: 13 })
    .map((r) => at(r.h, r.sub, r.k));
  const H = officeTiles(layout).h;
  const capture = (prev: Scene, s: Scene): unknown => peers.map((p) => {
    const { tiles, focus } = followTiles(prev, s, p, layout);
    return { card: nowCard(s, layout, p), camera: [0, 7, 30].map((t) => cameraTarget(tiles, focus, { top: t, h: 12 }, H, false)), force: cameraTarget(tiles, focus, { top: 0, h: 12 }, H, true) };
  });

  // Live: the page's reducer over the stream's events in order (LivePlayer), captured at each position and at the end of the height
  // before it (the previous beat).
  const live = new Map<string, unknown>();
  const key = (p: Position): string => `${p.height}.${p.sub}.${p.k}`;
  const sorted = [...positions].sort((x, y) => x.height - y.height || x.sub - y.sub || x.k - y.k);
  const r = new SceneReducer(emptyScene(at(0)), () => layout);
  let i = 0;
  const upTo = (p: Position): Scene => {
    while (i < page.length && (page[i]!.height < p.height || (page[i]!.height === p.height && (page[i]!.sub < p.sub || (page[i]!.sub === p.sub && page[i]!.k <= p.k))))) r.push(page[i++]!);
    return r.scene();
  };
  for (const p of sorted) {
    const prev = upTo(at(p.height - 1, END, END));
    live.set(key(p), capture(prev, upTo(p)));
  }
  // Replay: the page's seek cache over its view at the same positions.
  const view = pageView(page, layout);
  assert.ok(view.segments.length >= 3, `${view.segments.length} segments`);
  const cache = new SeekCache(() => view);
  let nonEmpty = 0, scrolled = 0;
  for (const p of positions) {
    const got = capture(cache.sceneAt(at(p.height - 1, END, END)), cache.sceneAt(p)) as Array<{ card: ReturnType<typeof nowCard>; camera: Array<number | null> }>;
    assert.deepEqual(got, live.get(key(p)), `${key(p)}`);
    nonEmpty += got.filter((x) => x.card.holding.length + x.card.asks.length + x.card.askedBy.length > 0 || x.card.lastShared !== null).length;
    scrolled += got.filter((x) => x.camera.some((c) => c !== null)).length;
  }
  assert.ok(nonEmpty > 50 && scrolled > 50, `the property is not vacuous: ${nonEmpty} non-empty cards, ${scrolled} camera moves`);
});

// ---------------------------------------------------------------------------------------------------------------------------

const card = (id: string, actor: string, desk: number, group: CardVM['group']): CardVM => ({
  id, at: id.split('.').map(Number) as [number, number, number], group, code: group === 'activity' ? 'UI_VIZ_CARD_PUBLISH' : 'UI_VIZ_CARD_JOIN',
  actor: { peer: actor }, target: null, paths: group === 'activity' ? [`p${desk}.ts`] : [], n: 1, desks: group === 'activity' ? [desk] : [],
  displayId: null, parent: null, label: null, text: null, detail: null, seen_ms: null,
});

test('T-VIZ-follow-filter: follow pins the person filter per room', () => {
  const HA = 'a1b2c3', HB = 'b2c3d4', R1 = 'rAAAAAAAA', R2 = 'rBBBBBBBB';
  // FEAT-F32-11 (SHOULD): every start and end of a follow is a notice of the follow set (the page offers the selected room's to the
  // announcer, below); `said()` takes the notices since the last call.
  const notices: string[] = [];
  const follows = new FollowSet((room, n) => notices.push(`${room} ${n.code} ${n.peer}`));
  const said = (): string[] => notices.splice(0);
  // The page's filter state per selected room, as client/main.ts keeps it: the person filter is the log panel's; a room switch sets it
  // to that room's follow (or none) and is not a filter change; a filter change tells the follow set.
  const f: { room: string; filter: LogFilter } = { room: R1, filter: { peer: null, desk: null, groups: new Set(['conversation', 'activity', 'conflict']), system: false } };
  const person = (p: string | null): void => {
    f.filter = { ...f.filter, peer: p };
    follows.filterChanged(f.room, p);
  };
  const toggle = (): void => {
    const p = follows.toggle(f.room, f.filter.peer);
    if (p !== null) f.filter = { ...f.filter, peer: p };
  };
  const select = (room: string): void => {
    f.room = room;
    f.filter = { ...f.filter, peer: follows.get(room), desk: null };
  };

  // Start: the person filter is A (a character was clicked), the toggle follows A; LogFilter.peer = A.
  person(HA);
  toggle();
  assert.equal(follows.get(R1), HA);
  assert.equal(f.filter.peer, HA);
  assert.deepEqual(said(), [`${R1} UI_VIZ_FOLLOWING ${HA}`], 'follow start');
  person(HA);
  assert.equal(follows.get(R1), HA, 'setting the same person filter again ends nothing');
  // File and kind filters AND-combine with the pinned person filter.
  const log = new LogModel();
  log.add([card('1.1.0', HA, 1, 'activity'), card('2.1.0', HA, 2, 'activity'), card('3.1.0', HB, 1, 'activity'), card('4.1.0', HA, 1, 'conversation')], 0);
  const ids = (x: LogFilter): string[] => log.rows(x).flatMap((r) => (r.kind === 'card' ? [r.card.id] : r.cards.map((c) => c.id)));
  assert.deepEqual(ids(f.filter), ['1.1.0', '2.1.0', '4.1.0']);
  assert.deepEqual(ids({ ...f.filter, desk: 1 }), ['1.1.0']);
  assert.deepEqual(ids({ ...f.filter, desk: 1, groups: new Set(['conversation']) }), []);
  assert.deepEqual(ids({ ...f.filter, groups: new Set(['conversation']) }), ['4.1.0']);
  assert.equal(follows.get(R1), HA, 'file and kind filters end nothing');
  assert.deepEqual(said(), [], 'nothing ended');

  // Choosing B, clearing the person filter, or Esc with no export panel open (it clears the filters): the follow ends in that room only.
  select(R2);
  person(HB);
  toggle();
  assert.equal(follows.get(R2), HB);
  select(R1);
  person(HB);
  assert.deepEqual([follows.get(R1), follows.get(R2)], [null, HB], 'choosing B ends room 1\'s follow only');
  assert.deepEqual(said(), [`${R2} UI_VIZ_FOLLOWING ${HB}`, `${R1} UI_VIZ_FOLLOW_ENDED ${HA}`], 'a room switch is no notice; choosing B ends A');
  person(HA);
  toggle();
  person(null);
  assert.deepEqual([follows.get(R1), follows.get(R2)], [null, HB], 'clearing the person filter');
  assert.deepEqual(said(), [`${R1} UI_VIZ_FOLLOWING ${HA}`, `${R1} UI_VIZ_FOLLOW_ENDED ${HA}`]);
  person(HA);
  toggle();
  person(null);                                                     // Esc: every filter cleared
  assert.deepEqual([follows.get(R1), follows.get(R2)], [null, HB], 'Esc');
  assert.deepEqual(said(), [`${R1} UI_VIZ_FOLLOWING ${HA}`, `${R1} UI_VIZ_FOLLOW_ENDED ${HA}`]);
  // The toggle again ends it; the toggle without a person filter starts nothing.
  person(HA);
  toggle();
  toggle();
  assert.equal(follows.get(R1), null);
  assert.deepEqual(said(), [`${R1} UI_VIZ_FOLLOWING ${HA}`, `${R1} UI_VIZ_FOLLOW_ENDED ${HA}`], 'the toggle off');
  person(null);
  toggle();
  assert.equal(follows.get(R1), null);
  assert.deepEqual(said(), [], 'no follow: nothing starts or ends');

  // Follow A in room 1, select room 2 (its own follow, or none: then the 30 s rule), back to room 1: A is followed again and pinned.
  person(HA);
  toggle();
  select(R2);
  assert.equal(f.filter.peer, HB, 'room 2 pins its own follow');
  person(null);
  assert.equal(follows.get(R2), null);
  assert.equal(f.filter.peer, null, 'room 2 without a follow: no person filter, the 30 s rule scrolls');
  select(R1);
  assert.deepEqual([follows.get(R1), f.filter.peer], [HA, HA]);

  // Two rooms each with a "Minji" of different peer ids: following room 1's Minji follows nobody in room 2 (keyed by handle per room).
  const M1 = 'c3d4e5', M2 = 'd4e5f6';
  const minji = new FollowSet();
  minji.toggle(R1, M1);
  assert.equal(minji.get(R2), null);
  minji.filterChanged(R2, M2);
  minji.worldReloaded(R2, new Set([M2]));
  assert.deepEqual([minji.get(R1), minji.get(R2)], [M1, null]);

  // A world reload in which A's handle is extended (R-V22 collision): the reloaded room no longer lists it → the follow ends.
  said();
  follows.worldReloaded(R1, new Set([HA, HB]));
  assert.equal(follows.get(R1), HA, 'a reload that still lists A keeps the follow');
  assert.deepEqual(said(), []);
  follows.worldReloaded(R1, new Set([`${HA}12`, HB]));
  assert.equal(follows.get(R1), null);
  assert.deepEqual(said(), [`${R1} UI_VIZ_FOLLOW_ENDED ${HA}`], 'a reload that ends it');
  follows.worldReloaded('rCCCCCCCC', new Set());
  assert.deepEqual(said(), []);
  // A page reload: a new page memory, no follow; nothing in it was ever written to the fragment, storage or a request.
  assert.equal(new FollowSet().get(R1), null);
  assert.equal(JSON.stringify(follows), '{}', 'the follow set has no serializable state');

  // FEAT-F32-11 (SHOULD): the page offers the selected room's notices to the announcer (≤ 1 per 10 s), rendered in the page language:
  // follow start "Following {name}", follow end "Stopped following {name}"; a follow that ends in a room not on screen is not announced.
  const announcer = new Announcer(ANNOUNCE_GAP_MS);
  const rendered = (n: FollowNotice): string => renderWith({ en: EN_VIZ }, REASON_CODES, n.code, { name: 'Ann' }, 'viz', 'en');
  assert.equal(announcer.offer(rendered({ code: 'UI_VIZ_FOLLOWING', peer: HA }), 0), 'Following Ann');
  assert.equal(announcer.offer(rendered({ code: 'UI_VIZ_FOLLOW_ENDED', peer: HA }), ANNOUNCE_GAP_MS), 'Stopped following Ann');
  const main = read('src/viz/client/main.ts');
  assert.match(main, /const follows = new FollowSet\(\(room, n\) => \{\n[^\n]*\n\s*if \(room === selected\) a11y\.announce\(t\(n\.code, \{ name: /u, 'main.ts announces the selected room\'s notices');
  assert.doesNotMatch(main, /a11y\.announce\(t\('UI_VIZ_FOLLOWING'/u, 'and only through the follow set');
});

// ---------------------------------------------------------------------------------------------------------------------------

test('T-VIZ-follow-keys: F toggles follow only with a person filter', () => {
  assert.deepEqual([KEYS['F'], KEYS['f']], ['follow', 'follow']);
  // The page's key path: keyActionFor(key, focus in a form control), then the follow set's toggle over the person filter; the toggles'
  // aria-pressed is whether the selected room follows (client/log.ts and a11y.ts set it from the same state).
  const R = 'rAAAAAAAA', HA = 'a1b2c3';
  const follows = new FollowSet();
  let filterPeer: string | null = HA;
  const ariaPressed = (): string => String(follows.get(R) !== null);
  /** A keydown's modifier state as the page reads it (structurally a KeyboardEvent): Shift is in the key itself ('F', '+'). */
  const mods = (o: { ctrl?: boolean; meta?: boolean; alt?: boolean; altGraph?: boolean } = {}): KeyModifiers => ({
    ctrlKey: o.ctrl ?? false, metaKey: o.meta ?? false, altKey: o.alt ?? false, getModifierState: (k: string) => k === 'AltGraph' && (o.altGraph ?? false),
  });
  const press = (key: string, inFormControl: boolean, m: KeyModifiers = mods()): void => {
    if (keyActionFor(key, inFormControl, modifiedKey(m)) !== 'follow') return;
    const p = follows.toggle(R, filterPeer);
    if (p !== null) filterPeer = p;
  };
  press('F', false);
  assert.deepEqual([follows.get(R), ariaPressed()], [HA, 'true'], 'F with a person filter follows it');
  // 12 §3.11 "Keyboard", §3.8.1 (FEAT-F32-02): page keys act only without Ctrl, Meta or Alt — Ctrl+F or Cmd+F searches the page and
  // never ends (or starts) a follow.
  for (const m of [mods({ ctrl: true }), mods({ meta: true }), mods({ alt: true })]) {
    for (const k of ['f', 'F']) {
      press(k, false, m);
      assert.deepEqual([follows.get(R), ariaPressed()], [HA, 'true'], `${k} with ${JSON.stringify(m)} leaves the follow as it was`);
    }
  }
  press('f', false);
  assert.deepEqual([follows.get(R), ariaPressed()], [null, 'false'], 'F again stops');
  press('F', false, mods({ ctrl: true }));
  assert.equal(follows.get(R), null, 'Ctrl+F with a person filter and no follow starts none');
  filterPeer = null;
  press('F', false);
  assert.deepEqual([follows.get(R), ariaPressed()], [null, 'false'], 'F without a person filter does nothing');
  filterPeer = HA;
  press('F', true);
  assert.equal(follows.get(R), null, 'F in the language select (a form control) does nothing');
  // The guard keeps the page's other keys as they were: in a form control only Esc acts; null-prototype lookups only.
  assert.equal(keyActionFor('Escape', true, false), 'clear_filters');
  assert.deepEqual(['L', 'ArrowLeft', '+', 'Enter'].map((k) => keyActionFor(k, true, false)), [null, null, null, null]);
  assert.deepEqual(['L', 'ArrowLeft', 'PageUp', '+'].map((k) => keyActionFor(k, false, false)), ['live', 'step_back', 'page_back', 'zoom_in']);
  for (const k of ['__proto__', 'constructor', 'toString', 'x', 'Shift']) assert.equal(keyActionFor(k, false, false), null, k);
  // With Ctrl, Meta or Alt held no page key acts (the browser keeps its own shortcuts): find (Ctrl/Cmd/Alt+F), the address bar (Ctrl+L),
  // browser zoom (Ctrl+'-', Ctrl+'+'), back and forward (Alt+ArrowLeft/Right), Ctrl+Esc, tab switching (Ctrl+PageUp/PageDown).
  const modified: Array<[string, KeyModifiers]> = [
    ['f', mods({ ctrl: true })], ['f', mods({ meta: true })], ['f', mods({ alt: true })], ['F', mods({ ctrl: true })], ['l', mods({ ctrl: true })],
    ['L', mods({ meta: true })], ['-', mods({ ctrl: true })], ['+', mods({ ctrl: true })], ['-', mods({ meta: true })], ['ArrowLeft', mods({ alt: true })],
    ['ArrowRight', mods({ alt: true })], ['PageUp', mods({ ctrl: true })], ['PageDown', mods({ ctrl: true })], ['Escape', mods({ ctrl: true })],
  ];
  for (const [k, m] of modified) assert.equal(keyActionFor(k, false, modifiedKey(m)), null, `${k} with ${JSON.stringify(m)}`);
  // AltGraph (reported as Ctrl+Alt on Windows) types a character on many layouts, so it is no modifier here; Meta with it still is.
  assert.equal(modifiedKey(mods({ ctrl: true, alt: true, altGraph: true })), false);
  assert.equal(keyActionFor('+', false, modifiedKey(mods({ ctrl: true, alt: true, altGraph: true }))), 'zoom_in');
  assert.equal(modifiedKey(mods({ meta: true, altGraph: true })), true);
  assert.equal(modifiedKey(mods()), false, 'Shift alone (F, +) is no modifier');
  // The client takes that path: main.ts's keydown asks keyActionFor with its form-control test and the event's modifiers, and toggles the
  // follow on 'follow'; the rewind slider's own keys take the same guard (no direct KEYS lookup); the toggles carry aria-pressed.
  const main = read('src/viz/client/main.ts');
  assert.match(main, /const typing = target instanceof HTMLInputElement \|\| target instanceof HTMLSelectElement \|\| target instanceof HTMLTextAreaElement;\s*const action = keyActionFor\(e\.key, typing, modifiedKey\(e\)\);/u);
  const rewindTs = read('src/viz/client/rewind.ts');
  assert.match(rewindTs, /slider\.addEventListener\('keydown', \(e\) => \{\s*const action = keyActionFor\(e\.key, false, modifiedKey\(e\)\);/u);
  assert.doesNotMatch(rewindTs, /KEYS\[/u, 'the slider reads no key table directly');
  assert.match(main, /case 'follow':\s*toggleFollow\(\);/u);
  assert.match(read('src/viz/client/log.ts'), /setPressed\(followToggle, /u);
  assert.match(read('src/viz/client/a11y.ts'), /setPressed\(f, r\.on\)/u);
});

test('T-VIZ-lints: the follow wiring is clean', { timeout: 60_000 }, () => {
  // follow.ts imports model/** only — files of the R-V35 client program (events, scene, layout, labels) — and nothing else.
  const follow = read('src/viz/ui/follow.ts');
  const specs = [...follow.matchAll(/^import [^;]*? from '([^']+)';$/gmu)].map((m) => m[1] as string);
  assert.ok(specs.length > 0);
  for (const s of specs) assert.match(s, /^\.\.\/model\/(events|scene|layout|labels|placement)\.js$/u, s);
  // The page reaches it: the client imports ui/follow.ts (so the closure and the typecheck below cover it).
  for (const f of ['main.ts', 'office.ts']) assert.match(read(`src/viz/client/${f}`), /from '\.\.\/ui\/follow\.js';/u, f);
  // L-VIZ-DOM, L-VIZ-IMPORT, L-VIZ-URL, L-VIZ-NET over the real client and page logic: no finding.
  const files = ['src/viz/ui/follow.ts', 'src/viz/ui/a11y.ts', ...['a11y', 'api', 'log', 'main', 'office', 'rewind'].map((n) => `src/viz/client/${n}.ts`)];
  assert.deepEqual(files.flatMap((f) => lintVizSource(f, read(f))), []);
  // L-VIZ-IMPORT (the client closure) and L-VIZ-TYPES (the client typecheck with lib DOM) over the repository: no finding.
  assert.deepEqual(lintVizClientClosure(ROOT), []);
  assert.deepEqual(lintVizClientProgram(ROOT), []);
  // No human text in follow.ts: every string literal with a letter is a code of the §3.11 table, a wire value of the model's or its own
  // string-literal types (event kinds, places, desk kinds, statuses, causes, row kinds) or a field name tested with `in`.
  const wire = new Set<string>(), words: string[] = [];
  const visit = (n: ts.Node, collect: boolean): void => {
    if (ts.isLiteralTypeNode(n) && ts.isStringLiteral(n.literal)) wire.add(n.literal.text);
    else if (collect && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && !ts.isImportDeclaration(n.parent) && /\p{L}/u.test(n.text)) {
      const p = n.parent;
      if (!(ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.InKeyword && p.left === n)) words.push(n.text);
    }
    ts.forEachChild(n, (c) => visit(c, collect));
  };
  for (const f of ['src/viz/model/events.ts', 'src/viz/model/scene.ts', 'src/viz/model/layout.ts', 'src/viz/model/labels.ts']) visit(ts.createSourceFile(f, read(f), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), false);
  visit(ts.createSourceFile('follow.ts', follow, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), true);
  const offenders = words.filter((w) => !ALL_VIZ_CODES.has(w) && !wire.has(w));
  assert.deepEqual(offenders, []);
  assert.ok(words.length >= 10, `${words.length} literals checked`);
});
