// Plan 8a Task 15: the stream end to end (12 §3.9.2, §3.10.5 "Stream ids and resume"; VIZ-34, VIZ-42). Two rooms whose boards
// reach the viewer's clones by a daemon fixture's fetch: the commits arrive as timeline events equal to the window's timeline
// extended (extendTimeline: a fresh build of the same window gives the same events); 65 commits in one tick are one
// room_snapshot; a stream resumed with Last-Event-ID gets every later message of both rooms and every kind; SIGTERM → bye.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { machineMonoMs } from '../../../src/ports/clock.js';
import { createHandleTable, projectEvent, projectScene } from '../../../src/viz/server/project.js';
import { SSE_MAX_BYTES } from '../../../src/viz/server/stream.js';
import type { EventVM, StreamPayload } from '../../../src/viz/server/viewModel.js';
import { VirtualClock } from '../../sim/vclock.js';
import { openStream, type OpenStream, type SseMessage } from '../../helpers/vizHttp.js';
import { pubs, reference, writeStatus } from '../../helpers/vizStore.js';
import { datesIn, fetchedRoomsFixture, startTestViewer, worldOf, type FetchedRoom } from '../../helpers/vizViewer.js';

let f: Awaited<ReturnType<typeof fetchedRoomsFixture>>;
before(async () => {
  f = await fetchedRoomsFixture('viz-stream', ['main', 'dev']);
  await f.rooms[0]!.writer.commitMany(pubs(30, 'app'));
  await f.rooms[1]!.writer.commitMany(pubs(10, 'docs'));
  for (const r of f.rooms) {
    await r.fetch();
    writeStatus(r.fx.paths.gitDir, { branch: r.branch, heartbeat_mono_ms: machineMonoMs() });
  }
});
after(async () => { await f.cleanup(); });

type Sig = 'SIGTERM' | 'SIGINT' | 'SIGHUP';
const room = (m: SseMessage): string | undefined => (m.data as { room_id?: string } | null)?.room_id;

/** Advances the clock a poll period at a time (the loop's wake-up comes within 2.5 s of real time) until `pred` holds. */
async function until(clock: VirtualClock, pred: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 16 && !pred(); i++) {
    clock.advance(2_500);
    for (let j = 0; j < 30 && !pred(); j++) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(pred(), what);
}

/** The events of heights (from, to] of the room's board as a fresh build of the window [h0, …] gives them, projected. */
async function expected(r: FetchedRoom, h0: number, from: number, to: number): Promise<EventVM[]> {
  const ref = await reference(r.fx, r.writer.ref, h0);
  const h = createHandleTable();
  return ref.timeline.events.filter((e) => e.height > from && e.height <= to).map((e) => projectEvent(e, h));
}

test('T-VIZ-stream (end to end): two rooms; commits fetched into the viewer\'s clone by a daemon fixture arrive as stream events equal to extendTimeline; 65 commits in one tick → one room_snapshot; a resumed stream with Last-Event-ID loses nothing of either room or any kind; SIGTERM → bye', { timeout: 120_000 }, async () => {
  const clock = new VirtualClock();
  const signals: { cb?: (sig: Sig) => void } = {};
  const v = await startTestViewer({ repos: f.rooms.map((r) => r.dir) }, { clock, signals: (cb) => { signals.cb = cb; } });
  const streams: OpenStream[] = [];
  try {
    const s = await v.session();
    const world = await worldOf(v.port, s);
    const ids = new Map(world.rooms.map((r) => [r.branch, r.room_id]));
    const [idA, idB] = [ids.get('main')!, ids.get('dev')!];
    assert.deepEqual(world.rooms.map((r) => r.window.h1).sort((a, b) => a - b), [11, 31]);
    const keep = await openStream(v.port, { 'x-cowork-session': s });   // sees everything, for the resume check
    streams.push(keep);

    // A daemon fetches 3 commits into each room: one timeline each, equal to the window's timeline extended.
    await f.rooms[0]!.writer.commitMany(pubs(3, 'app2'));
    await f.rooms[1]!.writer.commitMany(pubs(3, 'docs2'));
    for (const r of f.rooms) await r.fetch();
    const timelines = (id: string): Array<Extract<StreamPayload, { type: 'timeline' }>> =>
      keep.messages().filter((m) => m.event === 'timeline' && room(m) === id).map((m) => m.data as Extract<StreamPayload, { type: 'timeline' }>);
    await until(clock, () => timelines(idA).length > 0 && timelines(idB).length > 0, 'both rooms\' timelines');
    assert.deepEqual(timelines(idA).flatMap((t) => t.events), await expected(f.rooms[0]!, 0, 31, 34));
    assert.deepEqual(timelines(idB).flatMap((t) => t.events), await expected(f.rooms[1]!, 0, 11, 14));
    assert.deepEqual([timelines(idA).at(-1)!.h1, timelines(idB).at(-1)!.h1], [34, 14]);

    // A stream that reads up to here, then drops.
    const first = await openStream(v.port, { 'x-cowork-session': s });
    streams.push(first);
    const lastSeen = Math.max(...keep.messages().filter((m) => m.id !== null).map((m) => m.id!));
    first.close();

    // Then every kind, in both rooms: 65 commits in room A (one room_snapshot), 2 in room B with new paths (layout + timeline),
    // room A's status.json changed (overlay), room B's version skew (room).
    await f.rooms[0]!.writer.commitMany(pubs(65, 'bulk'));
    await f.rooms[1]!.writer.commitMany(pubs(2, 'fresh'));
    for (const r of f.rooms) await r.fetch();
    writeStatus(f.rooms[0]!.fx.paths.gitDir, { branch: 'main', state: 'degraded', heartbeat_mono_ms: machineMonoMs() });
    writeStatus(f.rooms[1]!.fx.paths.gitDir, { branch: 'dev', plugin_version: 'skewed-9.9.9', heartbeat_mono_ms: machineMonoMs() });
    const kindsOf = (st: OpenStream, id: string): Set<string> => new Set(st.messages().filter((m) => room(m) === id).map((m) => m.event!));
    await until(clock, () => {
      const a = kindsOf(keep, idA), b = kindsOf(keep, idB);
      return a.has('room_snapshot') && a.has('overlay') && b.has('room') && b.has('layout') && timelines(idB).length > 1;
    }, 'every kind in both rooms');
    const snapshots = keep.messages().filter((m) => m.event === 'room_snapshot' && room(m) === idA);
    assert.equal(snapshots.length, 1, '65 commits in one tick: one room_snapshot');
    assert.equal(timelines(idA).length, 1, 'and no timeline for them');
    const snap = snapshots[0]!.data as Extract<StreamPayload, { type: 'room_snapshot' }>;
    assert.equal(snap.window.h1, 99);
    const refA = await reference(f.rooms[0]!.fx, f.rooms[0]!.writer.ref, 0);
    assert.deepEqual(snap.scene, projectScene(refA.carry.scene, createHandleTable()), 'the scene at the new tip');
    assert.ok(snap.cards.length > 0 && snap.cards.length <= 200);

    // The resumed stream: exactly the messages after lastSeen, of both rooms and every kind.
    const resumed = await openStream(v.port, { 'x-cowork-session': s, 'last-event-id': String(lastSeen) });
    streams.push(resumed);
    const later = keep.messages().filter((m) => !m.comment && m.id !== null && m.id > lastSeen);
    await resumed.waitFor((m) => m.id === later.at(-1)!.id, 10_000);
    const got = resumed.messages().filter((m) => !m.comment);
    assert.deepEqual(got.slice(0, later.length), later);
    assert.deepEqual(new Set(got.map((m) => m.event)), new Set(['room_snapshot', 'overlay', 'room', 'layout', 'timeline']));
    assert.ok(new Set(got.map(room)).size === 2, 'both rooms');
    for (const m of keep.messages()) assert.ok(Buffer.byteLength(JSON.stringify(m.data)) < SSE_MAX_BYTES);
    for (const m of keep.messages()) assert.deepEqual(datesIn(JSON.stringify(m.data), Date.now()), []);

    // SIGTERM: bye on both open streams, then the exit.
    assert.equal(typeof signals.cb, 'function');
    signals.cb!('SIGTERM');
    for (const st of [keep, resumed]) {
      await st.waitFor((m) => m.event === 'bye', 10_000);
      await st.ended;
    }
    assert.equal(await v.exited, 'VIZ_EXIT_SIGNAL');
  } finally {
    for (const st of streams) st.close();
    await v.stop('VIZ_EXIT_SIGNAL');
  }
});
