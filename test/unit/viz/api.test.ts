// Plan 8a Task 9: the routes' data contract (12 §3.10.5; R-V15, R-V22, R-V29, R-V49): createWorldApi over StoreLike fakes and a
// real StreamHub — the world recomputed at most once per 2.5 s and only after every store is ready, layout deltas from the
// request path announced on the stream before the page returns, the en strings of the page subset, and pollSinkFor's
// projection of poll results (a layout message before its timeline or snapshot; a reset clears the world cache).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANGS } from '../../../src/i18n/render.js';
import { EN_VIZ } from '../../../src/viz/i18n/en.js';
import { PAGE_CODES, REASON_CODES } from '../../../src/viz/i18n/codes.js';
import { emptyLayout, LayoutBuilder, type LayoutDelta } from '../../../src/viz/model/layout.js';
import type { TimelinePageModel } from '../../../src/viz/server/models.js';
import { createWorldApi, pollSinkFor } from '../../../src/viz/server/api.js';
import { createHandleTable, projectDelta, projectLayoutDelta } from '../../../src/viz/server/project.js';
import { StreamHub } from '../../../src/viz/server/stream.js';
import { nullVizLog, type VizLog } from '../../../src/viz/server/vizLog.js';
import type { CharacterVM, StreamPayload } from '../../../src/viz/server/viewModel.js';
import { lookOf } from '../../../src/viz/model/looks.js';
import type { PeerRef } from '../../../src/viz/model/events.js';
import type { PeerInfo } from '../../../src/viz/server/models.js';
import { VirtualClock } from '../../sim/vclock.js';
import { ev } from '../../helpers/vizEvents.js';
import {
  allKindsEvents, cardOf, deltaOf, FakeStore, layoutOf, PA, PATHS4, PB, PC, PEERS4, peerInfo, ROOM_ID, sceneAfter, snapshotOf, SPEC,
} from '../../helpers/vizModels.js';

/** A real hub whose published payloads are recorded in order (with `marks` pushed by the test interleaved). */
function recordingHub(clock = new VirtualClock()): { hub: StreamHub; log: Array<StreamPayload | string> } {
  const hub = new StreamHub(clock);
  const log: Array<StreamPayload | string> = [];
  const pub = hub.publish.bind(hub);
  hub.publish = (p: StreamPayload): void => { log.push(p); pub(p); };
  return { hub, log };
}
const payloads = (log: ReadonlyArray<StreamPayload | string>): StreamPayload[] => log.filter((x): x is StreamPayload => typeof x !== 'string');
const turns = async (n = 5): Promise<void> => { for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r)); };

const ROOM_B = 'rBBBBBBBB';

test('createWorldApi recomputes the world at most once per 2.5 s whatever the number of callers and waits for every store\'s ready', async () => {
  const clock = new VirtualClock();
  const { hub } = recordingHub(clock);
  const a = new FakeStore(snapshotOf());
  const b = new FakeStore(snapshotOf({ spec: { ...SPEC, id: ROOM_B, label: 'b' } }), () => null, true);
  const api = createWorldApi({ stores: [a, b], handles: createHandleTable(), hub, clock, demo: false, captions: [] });

  // Many callers before b is ready: nobody gets a world, and no snapshot is taken.
  const early = [api.world(), api.world(), api.world()];
  let settled = 0;
  for (const p of early) void p.then(() => { settled++; });
  await turns();
  assert.equal(settled, 0, 'world() waits for every store\'s ready');
  assert.equal(a.snapshots + b.snapshots, 0);
  hub.publish({ type: 'reset' });                   // the cursor is the sequence number when the world is computed
  b.open();
  const worlds = await Promise.all(early);
  assert.equal(a.snapshots, 1, 'one recomputation for every early caller');
  assert.equal(b.snapshots, 1);
  for (const w of worlds) assert.equal(w, worlds[0], 'the same world');
  assert.deepEqual(worlds[0]!.rooms.map((r) => r.room_id), [ROOM_ID, ROOM_B]);
  assert.equal(worlds[0]!.cursor, 1);

  // Within 2.5 s (Δmono) every caller gets the cached world; at 2.5 s it is recomputed once.
  clock.advance(2_499);
  const again = await Promise.all([api.world(), api.world()]);
  assert.equal(again[0], worlds[0]);
  assert.equal(again[1], worlds[0]);
  assert.equal(a.snapshots, 1);
  hub.publish({ type: 'reset' });
  clock.advance(1);
  const later = await Promise.all([api.world(), api.world(), api.world()]);
  assert.notEqual(later[0], worlds[0]);
  assert.equal(later[1], later[0]);
  assert.equal(later[2], later[0]);
  assert.equal(a.snapshots, 2, 'recomputed once at 2.5 s');
  assert.equal(b.snapshots, 2);
  assert.equal(later[0]!.cursor, 2);

  // The sink's reset (a rebuilt room) drops the cached world, so the reloading page never gets the pre-reset world back.
  pollSinkFor(api, hub, createHandleTable(), clock).reset();
  const fresh = await api.world();
  assert.notEqual(fresh, later[0]);
  assert.equal(a.snapshots, 3);
  assert.equal(fresh.cursor, hub.seq());
});

test('world() within 2.5 s recomputes when the hub emitted a reset after the cached world\'s cursor (an oversize snapshot through pollSinkFor) or when the ring no longer covers that cursor, so a reloading page never replays the reset it reloads for (8a final review, reset loop)', async () => {
  const clock = new VirtualClock();
  const { hub, log } = recordingHub(clock);
  const store = new FakeStore(snapshotOf());
  const handles = createHandleTable();
  const api = createWorldApi({ stores: [store], handles, hub, clock, demo: false, captions: [] });
  const sink = pollSinkFor(api, hub, handles, clock);
  hub.publish({ type: 'room', room_id: ROOM_ID, change: 'state', label: 'x', branch: 'main', gone: false, badges: [], unknown: 0 });
  const first = await api.world();
  assert.equal(first.cursor, 1);
  assert.equal(store.snapshots, 1);
  clock.advance(1_000);
  assert.equal(await api.world(), first, 'nothing happened: the cached world');

  // A snapshot delta whose scene alone is over 64 KiB (its beat: 400 publishes): the hub sends one reset in its place.
  const layout = layoutOf();
  const base = sceneAfter(allKindsEvents(), layout);
  const beat = Array.from({ length: 400 }, (_, i) => ev('publish', [base.at.height, 1001, i], {
    actor: { peer: PA }, target: 1, others: [], paths: [`src/${'p'.repeat(70)}${i}.ts`], n: 1, state: 'closed', checks: 'pass', origin: 'human',
  }));
  log.length = 0;
  sink.delta(deltaOf({ kind: 'snapshot', scene: { ...base, beat }, window: { h0: 0, h1: base.at.height } }));
  assert.deepEqual(payloads(log).map((p) => p.type), ['room_snapshot'], 'the sink published a snapshot');
  assert.equal(hub.lastReset(), 2, 'the hub replaced it with a reset');
  clock.advance(1_000);
  let n = store.snapshots;                                            // (the sink reads the store's snapshot too)
  const second = await api.world();
  assert.notEqual(second, first, 'recomputed within 2.5 s');
  assert.equal(store.snapshots, n + 1, 'one recomputation');
  assert.ok(second.cursor >= hub.lastReset(), `cursor ${second.cursor} at or above the reset ${hub.lastReset()}`);
  assert.equal(await api.world(), second, 'then cached again');

  // More than 1 MiB of frames after its cursor: the ring no longer covers it, and a resume from it would get a reset.
  for (let i = 0; i < 17; i++) hub.publish({ type: 'room', room_id: ROOM_ID, change: 'state', label: 'x'.repeat(65_000), branch: 'main', gone: false, badges: [], unknown: 0 });
  assert.equal(hub.covers(second.cursor), false);
  clock.advance(1);
  n = store.snapshots;
  const third = await api.world();
  assert.notEqual(third, second, 'recomputed within 2.5 s');
  assert.equal(store.snapshots, n + 1, 'one recomputation');
  assert.equal(third.cursor, hub.seq());
  assert.equal(hub.covers(third.cursor), true, 'a cursor the ring covers');
});

test('a page that appends desks publishes one layout event whose from_version is the version before the call', async () => {
  // A room whose window starts at h0 = 256; a page below h0 extends it by one segment and appends two desks (R-V29, R-V49).
  const base = new LayoutBuilder(emptyLayout());
  for (const p of PEERS4) base.home(p);
  for (const p of PATHS4) base.desk(p, 300);
  base.takeDelta();
  const v0 = base.layout().version;
  base.desk('old/x.ts', 10);
  base.desk('old/y.ts', 12);
  const appended: LayoutDelta | null = base.takeDelta();
  assert.ok(appended !== null && appended.fromVersion === v0 && appended.desks.length === 2);
  const scene = sceneAfter([ev('person_enter', [1, 1, 0], { peer: PA })], layoutOf());
  const pageOf = (from: number, to: number): TimelinePageModel | null => {
    if (from > 400) return null;
    return { roomId: ROOM_ID, from, to: Math.min(to, 255), scene, events: [], cards: [{ card: cardOf([12, 1001, 0]), foldedAt: null }], layout: from < 256 ? appended : null };
  };
  const clock = new VirtualClock();
  const { hub, log } = recordingHub(clock);
  const store = new FakeStore(snapshotOf({ window: { h0: 256, h1: 300 } }), pageOf);
  const handles = createHandleTable();
  const api = createWorldApi({ stores: [store], handles, hub, clock, demo: false, captions: [] });

  const pending = api.page(ROOM_ID, 0, 255);
  void pending.then(() => { log.push('resolved'); });
  const page = await pending;
  await turns(1);
  assert.ok(page !== null);
  assert.deepEqual(log.map((x) => (typeof x === 'string' ? x : x.type)), ['layout', 'resolved'], 'exactly one layout payload, before page() resolved');
  const layoutMsg = log[0] as Extract<StreamPayload, { type: 'layout' }>;
  assert.equal(layoutMsg.room_id, ROOM_ID);
  assert.equal(layoutMsg.layout.from_version, v0, 'from_version is the version before the call');
  assert.equal(layoutMsg.layout.version, appended.version);
  assert.deepEqual(layoutMsg.layout, projectLayoutDelta(appended, handles));
  assert.deepEqual(page.layout, layoutMsg.layout, 'the requesting tab gets the same delta in its page');
  assert.equal(page.room_id, ROOM_ID);
  assert.equal(page.to, 255);

  // A page without new desks publishes nothing; an unknown room or a range out of the store's reach answers null.
  log.length = 0;
  const plain = await api.page(ROOM_ID, 256, 300);
  assert.ok(plain !== null);
  assert.equal(plain.layout, null);
  assert.deepEqual(log, []);
  assert.equal(await api.page(ROOM_ID, 500, 600), null);
  assert.equal(await api.page('rZZZZZZZZ', 0, 10), null);
  assert.deepEqual(log, []);

  // projectDelta (and the poll sink): a layout message before a room_snapshot as before a timeline.
  const h = createHandleTable();
  const snap = projectDelta(deltaOf({ kind: 'snapshot', scene, layout: appended }), 0, h);
  assert.deepEqual(snap.map((p) => p.type), ['layout', 'room_snapshot']);
  const tl = projectDelta(deltaOf({ layout: appended }), 0, h);
  assert.deepEqual(tl.map((p) => p.type), ['layout', 'timeline']);
  assert.deepEqual(projectDelta(deltaOf(), 0, h).map((p) => p.type), ['timeline']);
  log.length = 0;
  const sink = pollSinkFor(api, hub, handles, clock);
  sink.delta(deltaOf({ kind: 'snapshot', scene, layout: appended }));
  sink.delta(deltaOf({ layout: appended }));
  assert.deepEqual(payloads(log).map((p) => p.type), ['layout', 'room_snapshot', 'layout', 'timeline']);
});

test('strings(lang) answers en templates of PAGE_CODES for the six codes and null otherwise', () => {
  const clock = new VirtualClock();
  const api = createWorldApi({ stores: [], handles: createHandleTable(), hub: new StreamHub(clock), clock, demo: false, captions: [] });
  assert.equal(LANGS.length, 6);
  for (const lang of LANGS) {
    const s = api.strings(lang);
    assert.ok(s !== null, lang);
    assert.equal(s.lang, 'en', `${lang}: en strings only in 8a (R-V15)`);
    assert.deepEqual(Object.keys(s.templates).sort(), [...PAGE_CODES].sort(), `${lang}: exactly the page subset`);
    for (const code of PAGE_CODES) assert.deepEqual(s.templates[code], EN_VIZ[code], code);
  }
  for (const code of REASON_CODES) assert.ok(api.strings('en')!.templates[code] !== undefined, `the reason code ${code}'s template is included (R-V43)`);
  for (const code of Object.keys(api.strings('ko')!.templates)) assert.doesNotMatch(code, /^(RF_|SEC_|START_|VIZ_)/, code);
  for (const lang of ['de', 'EN', 'en-US', 'zh', '', '__proto__', 'constructor']) assert.equal(api.strings(lang), null, JSON.stringify(lang));
});

test('pollSinkFor publishes the projected overlay and the room state, and a handle collision re-sends nothing stale: one reset and a fresh world', async () => {
  const clock = new VirtualClock();
  const { hub, log } = recordingHub(clock);
  const handles = createHandleTable();
  const store = new FakeStore(snapshotOf({ spec: { ...SPEC, label: '<b>shop</b>', branch: 'main' }, badges: ['UI_VIZ_NO_BOARD'], unknown: 3, gone: false }));
  const api = createWorldApi({ stores: [store], handles, hub, clock, demo: false, captions: [] });
  const w0 = await api.world();
  const sink = pollSinkFor(api, hub, handles, clock);

  sink.roomChanged(ROOM_ID);
  sink.overlay(ROOM_ID, { ...snapshotOf().overlay!, state: 'frozen', freezeReasons: ['PAUSED', 'UI_VIZ_LINK_REUSED'] });
  const [room, overlay] = payloads(log);
  assert.deepEqual(room, { type: 'room', room_id: ROOM_ID, change: 'state', label: '\u{FF1C}b\u{FF1E}shop\u{FF1C}/b\u{FF1E}', branch: 'main', gone: false, badges: ['UI_VIZ_NO_BOARD'], unknown: 3 });
  assert.equal(overlay!.type, 'overlay');
  assert.deepEqual((overlay as Extract<StreamPayload, { type: 'overlay' }>).overlay.freeze_reasons, ['PAUSED']);

  // A peer whose first 6 hex equal PA's arrives in a delta: every handle of PA served so far is stale (R-V22). The sink publishes one
  // reset instead of the delta, and the world is recomputed with the extended handles at once.
  log.length = 0;
  const twin = PA.slice(0, 6) + 'f'.repeat(26);
  sink.delta(deltaOf({ events: [ev('person_enter', [40, 1, 0], { peer: twin })] }));
  assert.deepEqual(payloads(log).map((p) => p.type), ['reset']);
  assert.equal(handles.takeCollision(), false, 'the collision was taken by the sink');
  const w1 = await api.world();
  assert.notEqual(w1, w0, 'the cached world was dropped');
  assert.ok(w1.rooms[0]!.characters.some((c) => c.handle === handles.peer(PA) && c.handle.length > 6), 'PA is served with its extended handle');
  assert.equal(w1.cursor, hub.seq());
});

test('pollSinkFor logs a failing projection or publish as UI_INTERNAL_ERROR and rethrows it, so the poll loop resets the pages (Task 8 fix round 1)', async () => {
  const clock = new VirtualClock();
  const hub = new StreamHub(clock);
  const handles = createHandleTable();
  const api = createWorldApi({ stores: [new FakeStore(snapshotOf())], handles, hub, clock, demo: false, captions: [] });
  await api.world();
  const logged: string[] = [];
  const log: VizLog = {
    write: (code) => { logged.push(`write:${code}`); },
    security: () => {},
    error: (code, err) => { nullVizLog.error(code, err); logged.push(code); },   // refuses exactly what a file log refuses
    flush: async () => {},
  };
  const sink = pollSinkFor(api, hub, handles, clock, log);
  const boom = new Error('the stream is gone');
  hub.publish = (): void => { throw boom; };
  for (const [name, run] of [
    ['delta', () => sink.delta(deltaOf())],
    ['overlay', () => sink.overlay(ROOM_ID, snapshotOf().overlay!)],
    ['roomChanged', () => sink.roomChanged(ROOM_ID)],
    ['reset', () => sink.reset()],
  ] as const) {
    logged.length = 0;
    assert.throws(run, (e: unknown) => e === boom, `${name}: rethrown`);
    assert.deepEqual(logged, ['UI_INTERNAL_ERROR'], `${name}: logged once`);
  }
});

test('pollSinkFor re-projects a delta\'s characters over the whole room: a newcomer whose name collides re-sends the existing peer with its whole handle, a collision that ends re-sends it plain, and ph comes from the store\'s scene (R-V52, VIZ-18, R-V56)', async () => {
  const clock = new VirtualClock();
  const { hub, log } = recordingHub(clock);
  const handles = createHandleTable();
  // Distinct looks, so only the names can make PA and PB collide (and the collision can end).
  assert.notDeepEqual(lookOf(PA), lookOf(PB));
  const room = (peers: ReadonlyArray<[PeerRef, string]>) =>
    snapshotOf({ peers: new Map<PeerRef, PeerInfo>(peers.map(([p, name]) => [p, peerInfo(name)])), pets: new Map() });
  const store = new FakeStore(room([[PA, 'Ann']]));
  const api = createWorldApi({ stores: [store], handles, hub, clock, demo: false, captions: [] });
  const w = await api.world();
  assert.deepEqual(w.rooms[0]!.characters.map((c) => c.name), ['Ann']);
  const sink = pollSinkFor(api, hub, handles, clock);
  const [hA, hB, hC] = [handles.peer(PA), handles.peer(PB), handles.peer(PC)];
  /** The characters of the one timeline or room_snapshot the sink published since the log was cleared. */
  const sent = (type: 'timeline' | 'room_snapshot'): CharacterVM[] => {
    const ps = payloads(log);
    assert.deepEqual(ps.map((p) => p.type), [type]);
    const p = ps[0]!;
    assert.ok(p.type === 'timeline' || p.type === 'room_snapshot');
    return p.characters;
  };
  const tags = (cs: readonly CharacterVM[]): Array<[string, string]> => cs.map((c) => [c.handle, c.name]);

  // A newcomer 'ann' arrives next to 'Ann'. The delta carries only PB; projected alone it would show a plain 'ann' (and never re-send
  // PA's plain 'Ann'), the impersonation VIZ-18 forbids. The sink sends both, each ending in its whole handle.
  store.model = room([[PA, 'Ann'], [PB, 'ann']]);
  const d1 = deltaOf({ peers: new Map([[PB, peerInfo('ann')]]) });
  const alone = projectDelta(d1, 0, handles)[0]!;
  assert.ok(alone.type === 'timeline');
  assert.deepEqual(tags(alone.characters), [[hB, 'ann']], 'projectDelta alone sees the delta\'s peers only');
  log.length = 0;
  sink.delta(d1);
  assert.deepEqual(tags(sent('timeline')), [[hA, `Ann \u{B7} ${hA}`], [hB, `ann \u{B7} ${hB}`]]);

  // The collision ends (PB is now 'Bo'): PA, whose collision state changed, is re-sent with its plain tag.
  store.model = room([[PA, 'Ann'], [PB, 'Bo']]);
  log.length = 0;
  sink.delta(deltaOf({ peers: new Map([[PB, peerInfo('Bo')]]) }));
  assert.deepEqual(tags(sent('timeline')), [[hA, 'Ann'], [hB, 'Bo']]);

  // A delta that changes no collision sends its own peers only. ph comes from the store's scene: PC is slowed there (until height 188),
  // which a timeline delta (no scene) cannot know — projected alone, PC would be PH_OK.
  store.model = room([[PA, 'Ann'], [PB, 'Bo'], [PC, 'Cy']]);
  const d3 = deltaOf({ peers: new Map([[PC, peerInfo('Cy')]]) });
  const aloneC = projectDelta(d3, 0, handles)[0]!;
  assert.ok(aloneC.type === 'timeline');
  assert.deepEqual(aloneC.characters.map((c) => c.ph), ['PH_OK']);
  log.length = 0;
  sink.delta(d3);
  const c3 = sent('timeline');
  assert.deepEqual(tags(c3), [[hC, 'Cy']]);
  assert.deepEqual(c3.map((c) => c.ph), ['PH_SLOWED']);

  // The same over a room_snapshot: PB renamed 'ANN' collides with 'Ann' again (NFKC + lower case), so PA is re-sent with its handle.
  store.model = room([[PA, 'Ann'], [PB, 'ANN'], [PC, 'Cy']]);
  log.length = 0;
  sink.delta(deltaOf({ kind: 'snapshot', scene: store.model.scene, peers: new Map([[PB, peerInfo('ANN')]]) }));
  assert.deepEqual(tags(sent('room_snapshot')), [[hA, `Ann \u{B7} ${hA}`], [hB, `ANN \u{B7} ${hB}`]]);
});
