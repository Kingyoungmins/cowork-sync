// Plan 8a Task 14: the page's side of VIZ-26 and T-VIZ-api over every Task 6 row fixture (12 §3.9.1, §3.10.6, §3.13; R-V23,
// R-V43, R-V47, R-V73; V4, F2). The server's timeline of each fixture is projected by Task 9's projection (projectEvent,
// projectScene, projectLayout, projectPage, projectWorld, projectDelta) and read back by the page's own inverse (Task 13's
// src/viz/ui/unproject.ts) and reduced with the model's reducer over handles, as the page does: replay on the page equals live on
// the server at every tested position; a pet that first appears inside a TimelinePage below h0 keeps its served owner and
// variant (the page never parses a seat handle); every projection validates against the generated schemas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Position, SceneEvent } from '../../../src/viz/model/events.js';
import { lookTable } from '../../../src/viz/model/looks.js';
import { reduceScene, type Scene, type TimelineView } from '../../../src/viz/model/scene.js';
import type { CardModel, PeerInfo, PetInfo, RoomSnapshotModel, Tick, TimelinePageModel } from '../../../src/viz/server/models.js';
import {
  createHandleTable, projectDelta, projectEvent, projectLayout, projectPage, projectScene, projectWorld, type HandleTable,
} from '../../../src/viz/server/project.js';
import type { TimelinePage } from '../../../src/viz/server/viewModel.js';
import { SeekCache } from '../../../src/viz/ui/seek.js';
import { unprojectEvent, unprojectLayout, unprojectScene } from '../../../src/viz/ui/unproject.js';
import { deltaOf, OVERLAY, SPEC } from '../../helpers/vizModels.js';
import { fixtureTimeline, loadRowFixture, peerOf, ROW_FIXTURE_DIR, rowFixtureNames, type RowTimeline } from '../../helpers/vizRows.js';
import { validate, viewModelSchemas } from '../../helpers/vizSchema.js';

const ROOT = process.cwd();
const NAMES = rowFixtureNames(ROOT).map((n) => n.replace(/\.json$/, ''));
const END = Number.MAX_SAFE_INTEGER;
const TIMELINES = new Map<string, RowTimeline>();
function timelineOf(name: string): RowTimeline {
  let t = TIMELINES.get(name);
  if (t === undefined) TIMELINES.set(name, (t = fixtureTimeline(loadRowFixture(join(ROOT, ROW_FIXTURE_DIR, `${name}.json`)))));
  return t;
}
const wire = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
const posOf = (e: SceneEvent): Position => ({ height: e.height, sub: e.sub, k: e.k });

/** Every event's position and the end of every height an event names: the positions a replay can stop at. */
function testedPositions(events: readonly SceneEvent[]): Position[] {
  const out: Position[] = events.map(posOf);
  for (const h of new Set(events.map((e) => e.height))) out.push({ height: h, sub: END, k: END });
  return out;
}

/** Every id of the server's events and scenes registered before anything is projected, so no handle changes afterwards (R-V22). */
function stableHandles(events: readonly SceneEvent[], scenes: readonly Scene[], layoutOf: () => Parameters<typeof projectLayout>[0]): HandleTable {
  const h = createHandleTable();
  for (const e of events) projectEvent(e, h);
  for (const s of scenes) projectScene(s, h);
  projectLayout(layoutOf(), h);
  h.takeCollision();
  return h;
}

/** The page's view of a projected timeline: one segment per served start scene (as the page keeps them), events unprojected. */
function pageView(segments: ReadonlyArray<{ hs: number; scene: ReturnType<typeof projectScene> }>, events: ReturnType<typeof projectEvent>[], layout: ReturnType<typeof projectLayout>): TimelineView {
  return { segments: segments.map((s) => ({ hs: s.hs, start: unprojectScene(s.scene) })), events: events.map(unprojectEvent), layout: unprojectLayout(layout) };
}

test('T-VIZ-seek (projection half): the page\'s reduceScene over unprojected events equals the projection of the server\'s reduceScene at every tested position', () => {
  assert.ok(NAMES.length >= 40, `${NAMES.length} row fixtures`);
  let compared = 0;
  for (const name of NAMES) {
    const { timeline } = timelineOf(name);
    const positions = testedPositions(timeline.events);
    const server = positions.map((p) => reduceScene(timeline, p));
    const h = stableHandles(timeline.events, [...server, ...timeline.segments.map((s) => s.start)], () => timeline.layout);
    const layoutVM = projectLayout(timeline.layout, h);
    const view = pageView(timeline.segments.map((s) => ({ hs: s.hs, scene: projectScene(s.start, h) })), timeline.events.map((e) => projectEvent(e, h)), layoutVM);
    const seek = new SeekCache(() => view);
    positions.forEach((p, i) => {
      const expected = unprojectScene(projectScene(server[i]!, h));
      const at = `${name} at ${p.height}.${p.sub === END ? 'end' : p.sub}.${p.k === END ? 'end' : p.k}`;
      assert.deepEqual(reduceScene(view, p), expected, `${at}: reduceScene on the page`);
      assert.deepEqual(seek.sceneAt(p), expected, `${at}: the page's seek cache`);
      compared++;
    });
  }
  assert.ok(compared > 200, `${compared} positions compared`);
});

test('T-VIZ-seek: a pet spawned only inside a TimelinePage below h0 reduces with its owner and variant equal to the server\'s', () => {
  // seat_footprint: two footprint pets of A at height 1 (sub 1,001); join_epoch: two seat_start pets of A at height 1, poofed by
  // the respawn at height 2. The window starts above them (h0 = 2): they exist on the page only through the page [1, 1].
  for (const name of ['seat_footprint', 'join_epoch']) {
    const { timeline } = timelineOf(name);
    const from = 1, to = 1;
    const below = { height: from - 1, sub: END, k: END };
    const pageEvents = timeline.events.filter((e) => e.height >= from && e.height <= to);
    assert.ok(pageEvents.filter((e) => e.kind === 'pet_spawn').length === 2, `${name}: two pets spawn in the page`);
    const positions = testedPositions(pageEvents);
    const server = positions.map((p) => reduceScene(timeline, p));
    const start = reduceScene(timeline, below);
    assert.equal(start.pets.size, 0, `${name}: no pet before the page`);
    const h = stableHandles(timeline.events, [start, ...server], () => timeline.layout);
    const model: TimelinePageModel = { roomId: SPEC.id, from, to, scene: start, events: pageEvents, cards: [], layout: null };
    const page = wire(projectPage(model, 0, h)) as TimelinePage;
    assert.deepEqual(validate(viewModelSchemas().TimelinePage, page), []);
    // The page: the served start scene at from − 1, the served events, the head layout — and never a seat handle parsed.
    const view = pageView([{ hs: from - 1, scene: page.scene }], page.events, projectLayout(timeline.layout, h));
    const seek = new SeekCache(() => view);
    const owner = h.peer(peerOf('A'));
    positions.forEach((p, i) => {
      const expected = unprojectScene(projectScene(server[i]!, h));
      const got = seek.sceneAt(p);
      assert.deepEqual(got, expected, `${name} at ${p.height}.${p.sub}.${p.k}`);
      for (const [seat, pet] of expected.pets) {
        assert.equal(got.pets.get(seat)?.owner, owner, `${name}: the pet ${seat} keeps its served owner`);
        assert.equal(got.pets.get(seat)?.variant, pet.variant, `${name}: the pet ${seat} keeps its served variant`);
      }
    });
    const last = seek.sceneAt({ height: to, sub: END, k: END });
    const variants = [...last.pets.values()].map((p) => p.variant).sort();
    assert.equal(new Set(variants).size, 2, `${name}: the two pets of one owner have different variants (${variants})`);

  }
});

/** Server-side room models of one fixture timeline, as a store would serve them (peers and pets from the head scene). */
function roomModel(t: RowTimeline): RoomSnapshotModel {
  const { timeline } = t;
  const scene = reduceScene(timeline, { height: timeline.h1, sub: END, k: END });
  const peers = new Map<string, PeerInfo>();
  for (const p of [...timeline.layout.homeOrder, ...scene.characters.keys()]) {
    peers.set(p, { display: `peer ${p.slice(0, 4)} <b>`, pluginVersion: '0.2.0', status: scene.characters.get(p)?.absent === true ? 'absent' : 'active' });
  }
  const pets = new Map<string, PetInfo>();
  for (const [seat, p] of scene.pets) pets.set(seat, { owner: p.owner, live: p.live, ssCode: p.ssCode, variant: p.variant });
  const cards: CardModel[] = timeline.cards.map((card, i) => ({ card, foldedAt: i % 2 === 0 ? null : i * 1_000 }));
  const ticks: Tick[] = timeline.events.filter((e) => e.kind === 'publish').map((e) => ({ h: e.height, glyph: 'publish' }));
  return {
    spec: SPEC, window: { h0: timeline.h0, h1: timeline.h1 }, gone: false, badges: [], unknown: t.unknown.reduce((n, [, u]) => n + u, 0),
    layout: timeline.layout, looks: lookTable(peers.keys()), peers, pets, scene, cards: cards.slice(-200), ticks, overlay: OVERLAY,
  };
}

test('T-VIZ-api (fixtures): every projection of every Task 6 fixture validates against the generated schemas', () => {
  const s = viewModelSchemas();
  let checked = 0;
  for (const name of NAMES) {
    const t = timelineOf(name);
    const { timeline } = t;
    const h = createHandleTable();
    const m = roomModel(t);
    // The world (live and demo) and its room.
    const world = wire(projectWorld([m], 7, false, [], 60_000, h));
    assert.deepEqual(validate(s.World, world), [], `${name}: world`);
    const demo = wire(projectWorld([m], 7, true, [{ room: SPEC.id, height: 0, code: 'UI_VIZ_DEMO_CAPTION_1', text: null }], 60_000, h));
    assert.deepEqual(validate(s.World, demo), [], `${name}: demo world`);
    // A timeline page per height, its start scene the server's at the end of the height before.
    for (let from = 0; from <= timeline.h1; from++) {
      const events = timeline.events.filter((e) => e.height === from);
      if (events.length === 0 && from !== timeline.h1) continue;
      const scene = from === 0 ? timeline.segments[0]!.start : reduceScene(timeline, { height: from - 1, sub: END, k: END });
      const cards = timeline.cards.filter((c) => c.at.height === from).map((card) => ({ card, foldedAt: 5 }));
      const page = wire(projectPage({ roomId: SPEC.id, from, to: from, scene, events, cards, layout: null }, 9_000, h));
      assert.deepEqual(validate(s.TimelinePage, page), [], `${name}: page ${from}`);
      checked++;
    }
    // Every scene of the replay, inside a page; the whole timeline as one stream delta and as a snapshot.
    for (const p of testedPositions(timeline.events)) {
      const page = wire(projectPage({ roomId: SPEC.id, from: p.height, to: p.height, scene: reduceScene(timeline, p), events: [], cards: [], layout: null }, 0, h));
      assert.deepEqual(validate(s.TimelinePage, page), [], `${name}: scene at ${p.height}.${p.sub}.${p.k}`);
      checked++;
    }
    const cards = m.cards;
    const payloads = [
      ...projectDelta(deltaOf({ window: m.window, events: timeline.events, cards, ticks: m.ticks, peers: m.peers, pets: m.pets }), 1_000, h),
      ...projectDelta(deltaOf({ kind: 'snapshot', window: m.window, scene: m.scene, cards, ticks: m.ticks, peers: m.peers, pets: m.pets }), 1_000, h),
    ];
    for (const p of payloads) assert.deepEqual(validate(s.StreamPayload, wire(p)), [], `${name}: ${p.type}`);
    checked += payloads.length;
  }
  assert.ok(checked > 100, `${checked} projections validated`);
});
