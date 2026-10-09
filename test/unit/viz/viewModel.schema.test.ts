// Plan 8a Task 9: T-VIZ-api, projection half (R-V27; 12 §3.10.6): JSON Schemas generated from viewModel.ts at test time
// (additionalProperties false, each alias as its pattern), every projection of this task's hand-written models validates
// against them, and the generator refuses what it does not support. Task 14 validates every Task 6 fixture (V4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandleTable, projectDelta, projectOverlay, projectPage, projectWorld } from '../../../src/viz/server/project.js';
import { createWorldApi, pollSinkFor } from '../../../src/viz/server/api.js';
import { StreamHub } from '../../../src/viz/server/stream.js';
import type { CatalogEntry } from '../../../src/i18n/render.js';
import type { CatalogEntryVM, StreamPayload } from '../../../src/viz/server/viewModel.js';
import { ALIAS_PATTERNS, schemasFromSource, validate, viewModelSchemas } from '../../helpers/vizSchema.js';
import { VirtualClock } from '../../sim/vclock.js';
import {
  allKindsEvents, cardOf, deltaOf, FakeStore, layoutOf, OVERLAY, PA, PATHS4, PEERS4, peerInfo, ROOM_ID, SA, SB, sceneAfter, snapshotOf,
} from '../../helpers/vizModels.js';
import { emptyLayout, LayoutBuilder } from '../../../src/viz/model/layout.js';

// R-V58: a CatalogEntry of render.ts is a CatalogEntryVM (the served form is written out in viewModel.ts, which imports nothing).
const entryServes = (e: CatalogEntry): CatalogEntryVM => ({ ...e, params: e.params === undefined ? undefined : { ...e.params }, forms: e.forms === undefined ? undefined : { ...e.forms } });
void entryServes;

const wire = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

test('T-VIZ-api (projection half): viewModelSchemas() is generated from viewModel.ts with additionalProperties false and each alias as its pattern; every projection of this task\'s hand-written models validates; the generator refuses a construct it does not support', async () => {
  const s = viewModelSchemas();
  assert.deepEqual(Object.keys(s).sort(), ['RoomVM', 'Session', 'StreamPayload', 'Strings', 'TimelinePage', 'World']);
  // additionalProperties false on every object but the one Record (Strings.templates); every alias as its pattern.
  const objects: Array<Record<string, unknown>> = [];
  const patterns = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v === null || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (o['type'] === 'object') objects.push(o);
    if (typeof o['pattern'] === 'string') patterns.add(o['pattern']);
    Object.values(o).forEach(walk);
  };
  walk(s);
  assert.ok(objects.length > 40);
  for (const o of objects) assert.ok(o['additionalProperties'] === false || (o['properties'] === undefined && typeof o['additionalProperties'] === 'object'), JSON.stringify(o).slice(0, 120));
  assert.equal(objects.filter((o) => o['additionalProperties'] !== false).length, 2, 'Strings.templates and CatalogEntryVM.params');
  for (const p of Object.values(ALIAS_PATTERNS)) assert.ok(patterns.has(p), `pattern ${p} used`);
  assert.deepEqual(validate(s.Session, { session: 'a'.repeat(64), instance: 'ABCDEFGH' }), []);
  assert.notDeepEqual(validate(s.Session, { session: 'a'.repeat(64), instance: 'ABCDEFGH', extra: 1 }), []);

  // Every projection of the hand-written models validates.
  const h = createHandleTable();
  const events = allKindsEvents();
  const layout = layoutOf();
  const m = snapshotOf({ cards: [{ card: cardOf([3, 1001, 0], { displayId: 'R0000000A', parent: 'R0000000A', label: 'Mod.parse', text: 'hi', detail: 'EPOCH', group: 'system', code: 'UI_VIZ_CARD_FREEZE' }), foldedAt: 7 }] });
  const world = projectWorld([m], 3, false, [], 10, h);
  assert.deepEqual(validate(s.World, wire(world)), []);
  assert.deepEqual(validate(s.RoomVM, wire(world.rooms[0])), []);
  const demo = projectWorld([snapshotOf({ overlay: null })], 0, true, [{ room: ROOM_ID, height: 1, code: 'UI_VIZ_DEMO_CAPTION_1', text: null }, { room: ROOM_ID, height: 2, code: null, text: 'Hi' }], 0, h);
  assert.deepEqual(validate(s.World, wire(demo)), []);
  // Every intermediate scene (each kind in the beat) inside a page.
  for (let i = 1; i <= events.length; i++) {
    const page = projectPage({ roomId: ROOM_ID, from: 0, to: 30, scene: sceneAfter(events.slice(0, i), layout), events: events.slice(0, i), cards: [], layout: null }, 0, h);
    assert.deepEqual(validate(s.TimelinePage, wire(page)), [], `page after ${events[i - 1]!.kind}`);
  }
  const b = new LayoutBuilder(emptyLayout());
  for (const p of PEERS4) b.home(p);
  b.takeDelta();
  for (const p of PATHS4) b.desk(p, 9);
  const delta = b.takeDelta();
  assert.ok(delta !== null);
  const payloads: StreamPayload[] = [
    ...projectDelta(deltaOf({ events, cards: m.cards, layout: delta, peers: new Map([[PA, peerInfo('Ann')]]), pets: new Map([[SA, { owner: PA, live: true, ssCode: 'SS_FULL', variant: 0 }]]) }), 9, h),
    ...projectDelta(deltaOf({ kind: 'snapshot', scene: sceneAfter(events, layout), cards: m.cards, pets: new Map([[SB, { owner: PA, live: false, ssCode: 'BAD', variant: 1 }]]) }), 9, h),
    { type: 'overlay', room_id: ROOM_ID, overlay: projectOverlay(OVERLAY, h)! },
    { type: 'reset' }, { type: 'bye' },
  ];
  // The room payload of the poll sink, and the api's strings.
  const hub = new StreamHub(new VirtualClock());
  const published: StreamPayload[] = [];
  const pub = hub.publish.bind(hub);
  hub.publish = (p: StreamPayload): void => { published.push(p); pub(p); };
  const api = createWorldApi({ stores: [new FakeStore(m)], handles: h, hub, clock: new VirtualClock(), demo: false, captions: [] });
  assert.deepEqual(validate(s.World, wire(await api.world())), []);
  pollSinkFor(api, hub, h, new VirtualClock()).roomChanged(ROOM_ID);
  payloads.push(...published);
  assert.ok(payloads.some((p) => p.type === 'room') && payloads.some((p) => p.type === 'layout') && payloads.some((p) => p.type === 'room_snapshot'));
  for (const p of payloads) assert.deepEqual(validate(s.StreamPayload, wire(p)), [], p.type);
  assert.deepEqual(validate(s.Strings, wire(api.strings('ko'))), []);

  // An id field fed a raw seat key, an oid or a path fails its alias pattern.
  const room = wire(world.rooms[0]) as { pets: Array<{ seat: string }>; characters: Array<{ handle: string }>; room_id: string; scene: { claims: Array<[string, unknown]> } };
  const bad = (mutate: (r: typeof room) => void): string[] => {
    const r = structuredClone(room);
    mutate(r);
    return validate(s.RoomVM, r);
  };
  assert.notDeepEqual(bad((r) => { r.pets[0]!.seat = SA; }), [], 'a raw seat key');
  assert.notDeepEqual(bad((r) => { r.characters[0]!.handle = 'a'.repeat(40); }), [], 'an oid as a handle');
  assert.notDeepEqual(bad((r) => { r.scene.claims[0]![0] = 'b'.repeat(40); }), [], 'an oid as a short id');
  assert.notDeepEqual(bad((r) => { r.room_id = 'src/a.ts'; }), [], 'a path as a room id');
  assert.notDeepEqual(bad((r) => { r.characters[0]!.handle = 'src/a.ts'; }), [], 'a path as a handle');

  // The generator refuses what it does not support.
  const refuse = (src: string): void => assert.throws(() => schemasFromSource(src, ['X']), /vizSchema: unsupported/, src);
  refuse('export interface X { a: Map<string, number>; }');
  refuse('export type Foo = string; export interface X { a: Foo; }');
  refuse('export interface X { a: any; }');
  refuse('export interface X { a: unknown; }');
  refuse('export interface X { a: () => void; }');
  refuse('export interface X { [k: string]: number; }');
  refuse('export interface X<T> { a: T; }');
  refuse('export interface Y { b: number; } export interface X extends Y { a: number; }');
  refuse('export interface X { a: Date; }');
  refuse('export interface X { a: [number, ...number[]]; }');
  refuse('export interface X { a: number | undefined; }');
  assert.deepEqual(wire(schemasFromSource('export interface X { a: 1; b?: "p" | "q"; }', ['X'])['X']), {
    type: 'object', properties: { a: { const: 1 }, b: { type: 'string', enum: ['p', 'q'] } }, required: ['a'], additionalProperties: false,
  });
});
