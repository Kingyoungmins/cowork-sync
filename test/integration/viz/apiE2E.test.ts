// Plan 8a Task 15: the served API end to end (12 §3.10.5, §3.10.6, §7 T-VIZ-api; VIZ-34, VIZ-35; R-V22, R-V27, R-V29, R-V49). A
// viewer over two real clones: every JSON response of every route and every stream payload validates against the schemas
// generated from viewModel.ts (no additional property anywhere), error bodies are {code}; a card served again carries the same
// fields (its age, seen_ms, grows with the clock; a world re-sent after a reset that HandleTable.takeCollision caused is exempt,
// R-V22); a timeline page holds one segment; and a "load earlier" page's new desks reach a second tab's stream as one layout
// delta that follows its version, so both tabs end with equal layouts (R-V49).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLayoutDeltaVM } from '../../../src/viz/ui/unproject.js';
import type { CardVM, LayoutVM, StreamPayload, TimelinePage, World } from '../../../src/viz/server/viewModel.js';
import { VirtualClock } from '../../sim/vclock.js';
import { openStream, request, type SseMessage } from '../../helpers/vizHttp.js';
import { viewModelSchemas, validate } from '../../helpers/vizSchema.js';
import { pubs, writeStatus } from '../../helpers/vizStore.js';
import { apiGet, datesIn, gitRoomsFixture, startTestViewer, worldOf, type RoomsFixture, type TestViewer } from '../../helpers/vizViewer.js';
import { machineMonoMs } from '../../../src/ports/clock.js';

const SCHEMAS = viewModelSchemas();
const CODE_BODY = /^[A-Z][A-Z0-9_]{2,47}$/;

let f: RoomsFixture;
before(async () => {
  // p1: 1,401 heights, the first 200 publishes under old/ (below the window's h0 = 256 only), the rest under new/; p2: 41 heights.
  f = await gitRoomsFixture('viz-api', 2);
  await f.clones[0]!.writer.commitMany([...pubs(200, 'old'), ...pubs(1_200, 'new')]);
  await f.clones[1]!.writer.commitMany(pubs(40, 'docs'));
  for (const c of f.clones) writeStatus(c.paths.gitDir, { heartbeat_mono_ms: machineMonoMs() });
});
after(async () => { await f.cleanup(); });

/** Segment of a height (glossary: a segment that starts at hs holds hs + 1 … hs + 256; the genesis segment 0 … 256). */
const segment = (h: number): number => (h <= 256 ? 0 : Math.ceil(h / 256) - 1);

const json = (b: Buffer): unknown => JSON.parse(b.toString('utf8'));

function valid(root: keyof typeof SCHEMAS, v: unknown, what: string): void {
  assert.deepEqual(validate(SCHEMAS[root], v), [], what);
}

/** A card without its age: what must not change when it is served again. */
const fixed = (c: CardVM): Omit<CardVM, 'seen_ms'> & { seen: boolean } => {
  const { seen_ms, ...rest } = c;
  return { ...rest, seen: seen_ms !== null };
};

async function waitTick(clock: VirtualClock, st: { messages(): SseMessage[] }, pred: (m: SseMessage) => boolean): Promise<SseMessage> {
  for (let i = 0; i < 12; i++) {
    const hit = st.messages().find(pred);
    if (hit !== undefined) return hit;
    clock.advance(2_500);
    await new Promise((r) => setTimeout(r, 1_000));
  }
  const hit = st.messages().find(pred);
  assert.ok(hit !== undefined, `the stream message arrived; seen: ${st.messages().map((m) => `${m.event} ${JSON.stringify(m.data).slice(0, 80)}`).join(' | ')}`);
  return hit;
}

test('T-VIZ-api (end to end): every response of every route and every stream payload validates against the generated schemas with no additional property; a served card is never re-sent with changed fields, except cards of a world re-sent after a reset caused by HandleTable.takeCollision (R-V22); a timeline page never spans a segment start', { timeout: 120_000 }, async () => {
  const clock = new VirtualClock();
  const v: TestViewer = await startTestViewer({ repos: f.clones.map((c) => c.dir) }, { clock });
  const bodies: string[] = [];
  try {
    // The shell routes.
    for (const [path, status] of [['/', 200], ['/app.js', 200], ['/app.css', 200], ['/favicon.ico', 204]] as const) {
      const r = await request(v.port, { path });
      assert.equal(r.status, status, path);
      bodies.push(r.body.toString('utf8'));
    }
    // The session, then the session routes.
    const sres = await request(v.port, { method: 'POST', path: '/api/v1/session', headers: { origin: `http://127.0.0.1:${v.port}`, 'x-cowork-launch': v.launch } });
    assert.equal(sres.status, 200);
    valid('Session', json(sres.body), 'session');
    const s = (json(sres.body) as { session: string }).session;
    const served = new Map<string, ReturnType<typeof fixed>>();
    let afterReset = false;
    const record = (roomId: string, cards: readonly CardVM[], what: string): void => {
      for (const c of cards) {
        const key = `${roomId} ${c.id}`;
        const prev = served.get(key);
        if (prev !== undefined && !afterReset) assert.deepEqual(fixed(c), prev, `${what}: card ${key} re-sent unchanged`);
        served.set(key, fixed(c));
      }
    };
    const getWorld = async (): Promise<World> => {
      const r = await apiGet(v.port, s, '/api/v1/world');
      assert.equal(r.status, 200);
      bodies.push(r.body.toString('utf8'));
      const w = json(r.body) as World;
      valid('World', w, 'world');
      for (const room of w.rooms) record(room.room_id, room.cards, 'world');
      return w;
    };
    const world = await getWorld();
    assert.deepEqual(world.rooms.map((r) => [r.label, r.window]), [['p1', { h0: 256, h1: 1_401 }], ['p2', { h0: 0, h1: 41 }]]);
    const st = await openStream(v.port, { 'x-cowork-session': s });
    for (const lang of ['en', 'ko', 'zh-CN', 'ja', 'fr', 'es']) {
      const r = await apiGet(v.port, s, `/api/v1/strings?lang=${lang}`);
      assert.equal(r.status, 200);
      valid('Strings', json(r.body), `strings ${lang}`);
    }

    // Pages of every segment of both windows, each asked across a segment start: clipped at it.
    const pages: TimelinePage[] = [];
    for (const room of world.rooms) {
      const first = room.window.h0 === 0 ? 0 : room.window.h0 + 1;
      for (let from = first; from <= room.window.h1; ) {
        const r = await apiGet(v.port, s, `/api/v1/rooms/${room.room_id}/timeline?from=${from}&to=${from + 300}`);
        assert.equal(r.status, 200);
        bodies.push(r.body.toString('utf8'));
        const p = json(r.body) as TimelinePage;
        valid('TimelinePage', p, `page ${from}`);
        assert.equal(p.from, from);
        assert.equal(segment(p.from), segment(p.to), `page ${p.from}…${p.to} holds one segment`);
        record(room.room_id, p.cards, 'page');
        pages.push(p);
        from = p.to + 1;
      }
    }
    // "Load earlier": a page below h0 extends the window by one segment.
    const p1 = world.rooms[0]!;
    const earlier = await apiGet(v.port, s, `/api/v1/rooms/${p1.room_id}/timeline?from=0&to=400`);
    assert.equal(earlier.status, 200);
    const ep = json(earlier.body) as TimelinePage;
    valid('TimelinePage', ep, 'earlier');
    assert.ok(ep.layout !== null && ep.layout.desks.length > 0, 'old/ desks appended');
    assert.equal(segment(ep.from), segment(ep.to));
    record(p1.room_id, ep.cards, 'earlier');
    // Error bodies: {code} only.
    for (const [path, headers, status] of [
      ['/api/v1/world', {}, 401], [`/api/v1/rooms/r00000000/timeline?from=0&to=1`, { 'x-cowork-session': s }, 404],
      ['/nothing', {}, 404], ['/api/v1/strings?lang=xx', { 'x-cowork-session': s }, 404],
    ] as const) {
      const r = await request(v.port, { path, headers });
      assert.equal(r.status, status, path);
      const b = json(r.body) as Record<string, unknown>;
      assert.deepEqual(Object.keys(b), ['code']);
      assert.match(String(b['code']), CODE_BODY);
    }

    // Live: three commits in p1 (a timeline), 65 in p2 (one room_snapshot: a small window, so the snapshot fits one message; a
    // window's snapshot carries all its ticks), p2's status.json changed (overlay, version skew: a room).
    await f.clones[0]!.writer.commitMany(pubs(3, 'live'));
    await f.clones[1]!.writer.commitMany(pubs(65, 'snap'));
    writeStatus(f.clones[1]!.paths.gitDir, { plugin_version: 'skewed-9.9.9', state: 'degraded', heartbeat_mono_ms: machineMonoMs() });
    const ids = world.rooms.map((r) => r.room_id);
    const of = (type: string, id: string) => (m: SseMessage): boolean => m.event === type && (m.data as { room_id: string }).room_id === id;
    await waitTick(clock, st, of('timeline', ids[0]!));
    await waitTick(clock, st, of('room_snapshot', ids[1]!));
    await waitTick(clock, st, of('overlay', ids[1]!));
    await waitTick(clock, st, of('room', ids[1]!));
    const msgs = st.messages().filter((m) => !m.comment);
    assert.ok(msgs.length > 0);
    for (const m of msgs) {
      valid('StreamPayload', m.data, `stream ${m.event}`);
      const p = m.data as StreamPayload;
      assert.equal(p.type, m.event);
      bodies.push(JSON.stringify(p));
      if (p.type === 'reset') afterReset = true;
      if (p.type === 'timeline' || p.type === 'room_snapshot') record(p.room_id, p.cards, `stream ${p.type}`);
    }
    // The world again: every card it re-sends is unchanged.
    const again = await getWorld();
    assert.deepEqual(again.rooms.map((r) => r.window), [{ h0: 0, h1: 1_404 }, { h0: 0, h1: 106 }]);
    assert.ok(again.rooms[1]!.badges.includes('UI_VIZ_VERSION_SKEW'));
    st.close();
    // T-VIZ-clock (F18) over everything served here.
    for (const b of bodies) assert.deepEqual(datesIn(b, Date.now()), [], b.slice(0, 200));
  } finally {
    await v.stop('VIZ_EXIT_SIGNAL');
  }
});

test('T-VIZ-api: a second tab\'s stream receives the layout delta a first tab\'s load earlier appended', { timeout: 60_000 }, async () => {
  const clock = new VirtualClock();
  const v = await startTestViewer({ repos: [f.clones[0]!.dir] }, { clock });
  try {
    const s = await v.session();
    const world = await worldOf(v.port, s);
    const room = world.rooms[0]!;
    const layout0: LayoutVM = room.layout;
    const tab1 = await openStream(v.port, { 'x-cowork-session': s });
    const tab2 = await openStream(v.port, { 'x-cowork-session': s });
    // Tab 1 asks for a page below h0.
    const r = await apiGet(v.port, s, `/api/v1/rooms/${room.room_id}/timeline?from=0&to=50`);
    assert.equal(r.status, 200);
    const page = json(r.body) as TimelinePage;
    assert.ok(page.layout !== null);
    assert.equal(page.layout.from_version, layout0.version);
    // Tab 2's stream: one layout payload for the room, following tab 2's version.
    const m = await tab2.waitFor((x) => x.event === 'layout', 10_000);
    const delta = (m.data as Extract<StreamPayload, { type: 'layout' }>).layout;
    assert.equal(delta.from_version, layout0.version);
    assert.deepEqual(delta, page.layout, 'the same delta on the stream and in the page');
    assert.equal(tab2.messages().filter((x) => x.event === 'layout').length, 1);
    await tab1.waitFor((x) => x.event === 'layout', 10_000);
    // Both tabs' layouts: tab 1 applies its page's delta (and its stream's copy as a no-op), tab 2 its stream's.
    const t1a = applyLayoutDeltaVM(layout0, page.layout);
    assert.notEqual(t1a, 'reload');
    const t1 = applyLayoutDeltaVM(t1a as LayoutVM, delta);
    const t2 = applyLayoutDeltaVM(layout0, delta);
    assert.deepEqual(t1, t2);
    clock.advance(2_500);   // the world is recomputed at most once per 2.5 s of the clock
    assert.deepEqual(t2, (await worldOf(v.port, s)).rooms[0]!.layout, 'and both equal the server\'s');
    tab1.close();
    tab2.close();
  } finally {
    await v.stop('VIZ_EXIT_SIGNAL');
  }
});
