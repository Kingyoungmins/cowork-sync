// Plan 8a Task 13: the page's connection state machine (12 §3.2 items 5 and 11, §3.10.2, §3.10.5 "Stream ids and resume";
// VIZ-42; R-V49; V8, F23): redemption, the stored session, world then stream, reconnects, reloads, and the stopped signs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StreamPayload, World } from '../../../src/viz/server/viewModel.js';
import { Connection, firstRoom, RETRY_MAX_MS, RETRY_START_MS, STREAM_STABLE_MS, type ApiRoute, type ConnIo, type ConnState } from '../../../src/viz/ui/conn.js';
import { consumeLaunchToken } from '../../../src/viz/ui/fragment.js';

const LAUNCH = 'ab'.repeat(32);
const SESSION = 'cd'.repeat(32);
const ROOM = 'r0123ABCD', ROOM2 = 'rZZZZ0000';

/** The minimal world the connection reads: rooms (ids, layout versions) and the cursor. */
function world(cursor: number, rooms: Array<[string, number]> = [[ROOM, 3]]): World {
  return { v: 1, cursor, demo: false, captions: [], rooms: rooms.map(([room_id, version]) => ({ room_id, layout: { version, zones: [], desks: [], homeOrder: [] } })) } as unknown as World;
}
const frame = (id: number, p: StreamPayload): string => `id: ${id}\nevent: ${p.type}\ndata: ${JSON.stringify(p)}\n\n`;
const overlay = (): StreamPayload => ({ type: 'overlay', room_id: ROOM, overlay: { state: 'ok', freeze_reasons: [], publish_pause: null, down: false, unreadable: false, offline_min: null, holds: 0, incoming: 0, ready: 0, you: null } });
const layout = (from: number, to: number, room = ROOM): StreamPayload => ({ type: 'layout', room_id: room, layout: { from_version: from, version: to, zones: [], desks: [], homeOrder: [] } });

/** A stream body the test feeds chunk by chunk; null ends it. */
class Body {
  private queue: Array<string | null> = [];
  private waiting: ((v: string | null) => void) | null = null;
  cancelled = false;
  push(c: string | null): void {
    if (this.waiting !== null) {
      const w = this.waiting;
      this.waiting = null;
      w(c);
    } else this.queue.push(c);
  }
  read(): Promise<string | null> {
    if (this.cancelled) return Promise.resolve(null);
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    return new Promise((r) => { this.waiting = r; });
  }
}

type Answer = { status: number; json: unknown } | 'throw';
interface Fake {
  io: ConnIo;
  calls: Array<{ route: ApiRoute; method: string; headers: Record<string, string> }>;
  streams: Array<{ headers: Record<string, string>; body: Body | null }>;
  timers: Array<{ ms: number; f: () => void; cancelled: boolean }>;
  stored: { session: string | null; room: string | null };
  clears: number;
  answers: Answer[];                                        // request answers, in order
  streamAnswers: Array<number | 'throw'>;                   // stream statuses, in order (200 → a Body)
  onFirstRequest: (() => void) | null;
}
function fake(stored: { session: string | null; room: string | null } = { session: null, room: null }): Fake {
  const f: Fake = {
    calls: [], streams: [], timers: [], stored: { ...stored }, clears: 0, answers: [], streamAnswers: [], onFirstRequest: null,
    io: {
      async request(route, init) {
        if (f.calls.length === 0) f.onFirstRequest?.();
        f.calls.push({ route, method: init.method, headers: { ...init.headers } });
        const a = f.answers.shift();
        if (a === undefined || a === 'throw') throw new Error('network');
        return a;
      },
      async stream(headers) {
        const a = f.streamAnswers.shift() ?? 'throw';
        if (a === 'throw') {
          f.streams.push({ headers: { ...headers }, body: null });
          throw new Error('network');
        }
        const body = new Body();
        f.streams.push({ headers: { ...headers }, body: a === 200 ? body : null });
        return { status: a, read: () => body.read(), cancel: () => { body.cancelled = true; body.push(null); } };
      },
      timer(ms, fn) {
        const t = { ms, f: fn, cancelled: false };
        f.timers.push(t);
        return () => { t.cancelled = true; };
      },
      storage: {
        get: () => ({ ...f.stored }),
        set: (v) => { f.stored = { session: v.session ?? f.stored.session, room: v.room ?? f.stored.room }; },
        clear: () => { f.clears++; f.stored = { session: null, room: null }; },
      },
    },
  };
  return f;
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};
/** Fires the only pending timer and checks its delay. */
async function fire(f: Fake, ms: number): Promise<void> {
  const live = f.timers.filter((t) => !t.cancelled);
  assert.equal(live.length, 1, `one pending timer, found ${live.length}`);
  assert.equal(live[0]!.ms, ms);
  live[0]!.cancelled = true;
  live[0]!.f();
  await flush();
}
function connect(f: Fake): { conn: Connection; states: ConnState[]; worlds: World[]; payloads: Array<[string, number]> } {
  const states: ConnState[] = [], worlds: World[] = [], payloads: Array<[string, number]> = [];
  const conn = new Connection(f.io, { state: (s) => states.push(s), world: (w) => worlds.push(w), payload: (p, id) => payloads.push([p.type, id]) });
  return { conn, states, worlds, payloads };
}
const routes = (f: Fake): string[] => f.calls.map((c) => `${c.method} ${c.route.r}`);

test('T-VIZ-failure-signs (page): the launch token is removed before the first request; one POST /api/v1/session; the stored session after a reload; a broken stream → reconnecting, retry 1 s doubling to 30 s, then a world reload, then stopped; bye → stopped; 401 UI_VIZ_LINK_REUSED → link_reused; a layout gap or a room \'added\' → world reload', async () => {
  assert.deepEqual([RETRY_START_MS, RETRY_MAX_MS, STREAM_STABLE_MS], [1_000, 30_000, 30_000]);
  // Redemption: the fragment is cleared before the first request, one POST with the launch header, the session stored.
  const f = fake();
  const loc = { hash: `#k=${LAUNCH}`, clear(): void { this.hash = ''; } };
  let hashAtFirstRequest: string | null = null;
  f.onFirstRequest = () => { hashAtFirstRequest = loc.hash; };
  f.answers.push({ status: 200, json: { session: SESSION, instance: 'ABCDEFGH' } }, { status: 200, json: world(7) });
  f.streamAnswers.push(200);
  const { conn, states, worlds, payloads } = connect(f);
  await conn.start(consumeLaunchToken(loc));
  await flush();
  assert.equal(hashAtFirstRequest, '');
  assert.deepEqual(routes(f), ['POST session', 'GET world']);
  assert.deepEqual(f.calls[0]!.headers, { 'X-Cowork-Launch': LAUNCH });
  assert.deepEqual(f.calls[1]!.headers, { 'X-Cowork-Session': SESSION });
  assert.equal(f.stored.session, SESSION);
  assert.equal(worlds.length, 1);
  assert.deepEqual(f.streams[0]!.headers, { 'X-Cowork-Session': SESSION, 'Last-Event-ID': '7' });
  assert.deepEqual(states, ['live']);
  // Payloads with their ids; a comment line and a chunk split anywhere are fine.
  const body = f.streams[0]!.body!;
  const text = frame(8, overlay()) + ': keep-alive\n\n' + frame(9, layout(3, 4));
  body.push(text.slice(0, 13));
  body.push(text.slice(13));
  await flush();
  assert.deepEqual(payloads, [['overlay', 8], ['layout', 9]]);

  // A broken stream: reconnecting, retry after 1 s with the last id, then 2, 4, 8, 16, 30 s; the retry at 30 s fails → a world
  // reload; that fails too → stopped (the stored session and room cleared).
  body.push(null);
  await flush();
  assert.deepEqual(states, ['live', 'reconnecting']);
  f.streamAnswers.push('throw', 503, 'throw', 'throw', 'throw', 'throw');
  for (const ms of [1_000, 2_000, 4_000, 8_000, 16_000]) await fire(f, ms);
  for (const s of f.streams.slice(1)) assert.deepEqual(s.headers, { 'X-Cowork-Session': SESSION, 'Last-Event-ID': '9' });
  assert.equal(f.streams.length, 6);
  f.answers.push('throw');
  await fire(f, 30_000);
  assert.equal(f.streams.length, 7);
  assert.deepEqual(routes(f), ['POST session', 'GET world', 'GET world']);
  assert.deepEqual(states, ['live', 'reconnecting', 'stopped']);
  assert.equal(f.clears, 1);
  assert.deepEqual(f.stored, { session: null, room: null });
  assert.equal(f.timers.filter((t) => !t.cancelled).length, 0);

  // A reload of the tab: no launch, the stored session; a retry whose stream works (a well-formed message arrives) goes live
  // again and restarts the backoff at 1 s.
  const g = fake({ session: SESSION, room: ROOM });
  g.answers.push({ status: 200, json: world(20) });
  g.streamAnswers.push(200);
  const r = connect(g);
  await r.conn.start(null);
  await flush();
  assert.deepEqual(routes(g), ['GET world']);
  assert.deepEqual(g.calls[0]!.headers, { 'X-Cowork-Session': SESSION });
  assert.deepEqual(g.streams[0]!.headers, { 'X-Cowork-Session': SESSION, 'Last-Event-ID': '20' });
  g.streams[0]!.body!.push(frame(21, overlay()));
  g.streams[0]!.body!.push(null);
  await flush();
  g.streamAnswers.push('throw', 200);
  await fire(g, 1_000);
  await fire(g, 2_000);
  assert.deepEqual(g.streams[2]!.headers, { 'X-Cowork-Session': SESSION, 'Last-Event-ID': '21' });
  assert.deepEqual(r.states, ['live', 'reconnecting', 'live']);
  g.streams[2]!.body!.push(frame(22, overlay()));
  g.streams[2]!.body!.push(null);
  await flush();
  g.streamAnswers.push('throw');
  await fire(g, 1_000);                                   // the backoff restarted
  // A world reload after the 30 s retry that succeeds opens the stream at the new cursor.
  g.streamAnswers.push('throw', 'throw', 'throw', 'throw', 'throw', 200);
  for (const ms of [2_000, 4_000, 8_000, 16_000]) await fire(g, ms);
  g.answers.push({ status: 200, json: world(40) });
  await fire(g, 30_000);
  assert.deepEqual(routes(g), ['GET world', 'GET world']);
  assert.deepEqual(g.streams.at(-1)!.headers, { 'X-Cowork-Session': SESSION, 'Last-Event-ID': '40' });
  assert.equal(r.worlds.length, 2);
  assert.equal(r.states.at(-1), 'live');

  // bye → stopped, the storage cleared, no reconnect.
  g.streams.at(-1)!.body!.push(frame(41, { type: 'bye' }));
  await flush();
  assert.equal(r.states.at(-1), 'stopped');
  assert.deepEqual(g.stored, { session: null, room: null });
  assert.equal(g.timers.filter((t) => !t.cancelled).length, 0);
  assert.equal(g.streams.at(-1)!.body!.cancelled, true);

  // 401 UI_VIZ_LINK_REUSED on the redemption → link_reused (storage cleared); UI_VIZ_LINK_EXPIRED → link_expired; no world request.
  const h = fake({ session: null, room: ROOM });
  h.answers.push({ status: 401, json: { code: 'UI_VIZ_LINK_REUSED' } });
  const hr = connect(h);
  await hr.conn.start(LAUNCH);
  assert.deepEqual(hr.states, ['link_reused']);
  assert.deepEqual(routes(h), ['POST session']);
  assert.equal(h.clears, 1);
  const e = fake();
  e.answers.push({ status: 401, json: { code: 'UI_VIZ_LINK_EXPIRED' } });
  const er = connect(e);
  await er.conn.start(LAUNCH);
  assert.deepEqual(er.states, ['link_expired']);
  // No launch and no stored session → need_link, nothing requested.
  const n = fake();
  const nr = connect(n);
  await nr.conn.start(null);
  assert.deepEqual(nr.states, ['need_link']);
  assert.deepEqual(n.calls, []);

  // A layout gap, a room 'added' and a reset each reload the world and resume at its cursor; a layout already applied (version ≤
  // the room's) is passed on, and an in-order delta advances the room's version.
  const w = fake({ session: SESSION, room: null });
  w.answers.push({ status: 200, json: world(5, [[ROOM, 3], [ROOM2, 1]]) });
  w.streamAnswers.push(200);
  const wr = connect(w);
  await wr.conn.start(null);
  await flush();
  w.streams[0]!.body!.push(frame(6, layout(3, 4)) + frame(7, layout(2, 3)) + frame(8, layout(4, 6)));
  await flush();
  assert.deepEqual(wr.payloads, [['layout', 6], ['layout', 7], ['layout', 8]]);
  w.answers.push({ status: 200, json: world(9, [[ROOM, 6], [ROOM2, 1]]) });
  w.streamAnswers.push(200);
  w.streams[0]!.body!.push(frame(9, layout(7, 8)) + frame(10, overlay()));      // a gap: 7 is not the room's version 6
  await flush();
  assert.deepEqual(routes(w), ['GET world', 'GET world']);
  assert.equal(wr.worlds.length, 2);
  assert.deepEqual(wr.payloads.map(([, id]) => id), [6, 7, 8], 'nothing after the gap is passed on');
  assert.equal(w.streams[0]!.body!.cancelled, true);
  assert.deepEqual(w.streams[1]!.headers, { 'X-Cowork-Session': SESSION, 'Last-Event-ID': '9' });
  w.answers.push({ status: 200, json: world(12, [[ROOM, 6], [ROOM2, 1], ['rNEW00000', 0]]) });
  w.streamAnswers.push(200);
  w.streams[1]!.body!.push(frame(11, { type: 'room', room_id: 'rNEW00000', change: 'added', label: 'new', branch: 'main', gone: false, badges: [], unknown: 0 }));
  await flush();
  assert.deepEqual(routes(w), ['GET world', 'GET world', 'GET world']);
  assert.deepEqual(w.streams[2]!.headers, { 'X-Cowork-Session': SESSION, 'Last-Event-ID': '12' });
  // A room changing state is passed on without a reload; a reset reloads.
  w.streams[2]!.body!.push(frame(13, { type: 'room', room_id: ROOM2, change: 'state', label: 'x', branch: 'main', gone: false, badges: [], unknown: 0 }));
  await flush();
  assert.deepEqual(wr.payloads.at(-1), ['room', 13]);
  w.answers.push({ status: 200, json: world(30) });
  w.streamAnswers.push(200);
  w.streams[2]!.body!.push(frame(14, { type: 'reset' }));
  await flush();
  assert.deepEqual(routes(w).length, 4);
  assert.deepEqual(w.streams[3]!.headers, { 'X-Cowork-Session': SESSION, 'Last-Event-ID': '30' });
  // A layout for a room the world does not have is a gap too.
  w.answers.push({ status: 200, json: world(31) });
  w.streamAnswers.push(200);
  w.streams[3]!.body!.push(frame(31, layout(0, 1, 'rUNKNOWN0')));
  await flush();
  assert.deepEqual(routes(w).length, 5);
  // A malformed message (no id, bad JSON, a type that differs from the event name) is a broken stream: reconnect from the last id.
  w.streams[4]!.body!.push('event: overlay\ndata: {not json\nid: 32\n\n');
  await flush();
  assert.equal(wr.states.at(-1), 'reconnecting');
  w.streamAnswers.push(200);
  await fire(w, 1_000);
  assert.deepEqual(w.streams[5]!.headers, { 'X-Cowork-Session': SESSION, 'Last-Event-ID': '31' });
  w.streams[5]!.body!.push(frame(32, { type: 'bye' }).replace('event: bye', 'event: reset'));
  await flush();
  assert.equal(wr.states.at(-1), 'reconnecting');
  // That stream broke before any message worked, so the 1 s retry failed: the next one waits 2 s.
  assert.deepEqual(w.timers.filter((t) => !t.cancelled).map((t) => t.ms), [2_000]);
  wr.conn.stop();
  assert.equal(wr.states.at(-1), 'stopped');
  assert.equal(w.timers.filter((t) => !t.cancelled).length, 0);

  // A stream that opens (200) but breaks on its first message — here one frame the page rejects, which the resume ring replays
  // on every retry — is a failed retry like a failed open: retries after 1, 2, 4, 8, 16 and 30 s, then the world reload, whose
  // stream breaks the same way → stopped (12 §3.10.5, §6; VIZ-42). A 200 alone never restarts the backoff.
  const b = fake({ session: SESSION, room: ROOM });
  b.answers.push({ status: 200, json: world(50) });
  b.streamAnswers.push(200);
  const br = connect(b);
  await br.conn.start(null);
  await flush();
  const rejected = (id: number): string => frame(id, overlay()).replace('event: overlay', 'event: timeline');   // type ≠ event name
  b.streams[0]!.body!.push(rejected(51));
  await flush();
  assert.equal(br.states.at(-1), 'reconnecting');
  for (const ms of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]) {
    b.streamAnswers.push(200);
    await fire(b, ms);
    assert.equal(br.states.at(-1), 'live', `the retry after ${ms} ms opened`);
    assert.deepEqual(b.streams.at(-1)!.headers, { 'X-Cowork-Session': SESSION, 'Last-Event-ID': '50' });
    if (ms === RETRY_MAX_MS) {
      b.answers.push({ status: 200, json: world(60) });
      b.streamAnswers.push(200);
    }
    b.streams.at(-1)!.body!.push(rejected(51));
    await flush();
  }
  assert.deepEqual(routes(b), ['GET world', 'GET world'], 'the retry at 30 s failed: the world is reloaded');
  assert.equal(b.streams.length, 8);
  assert.deepEqual(b.streams[7]!.headers, { 'X-Cowork-Session': SESSION, 'Last-Event-ID': '60' });
  assert.equal(br.states.at(-1), 'live');
  b.streams[7]!.body!.push(rejected(61));
  await flush();
  assert.equal(br.states.at(-1), 'stopped', "the reload's stream failed too");
  assert.equal(b.clears, 1);
  assert.deepEqual(b.stored, { session: null, room: null });
  assert.equal(b.timers.filter((t) => !t.cancelled).length, 0);
  assert.deepEqual(br.payloads, []);

  // A quiet stream (no message; the server's 15 s comment lines are dropped by the parser) works once it has stayed open
  // STREAM_STABLE_MS: its break starts the backoff again at 1 s. A quiet stream that breaks sooner is a failed retry.
  const q = fake({ session: SESSION, room: ROOM });
  q.answers.push({ status: 200, json: world(70) });
  q.streamAnswers.push(200);
  const qr = connect(q);
  await qr.conn.start(null);
  await flush();
  q.streams[0]!.body!.push(': keep-alive\n\n');
  q.streams[0]!.body!.push(null);                          // a stream after a world load: the backoff starts at 1 s
  await flush();
  q.streamAnswers.push(200);
  await fire(q, 1_000);
  q.streams[1]!.body!.push(': keep-alive\n\n');
  q.streams[1]!.body!.push(null);                          // quiet and short-lived: the 1 s retry failed
  await flush();
  q.streamAnswers.push(200);
  await fire(q, 2_000);
  await fire(q, STREAM_STABLE_MS);                         // the only pending timer while the stream is open
  assert.equal(qr.states.at(-1), 'live');
  q.streams[2]!.body!.push(null);                          // it worked: a new break
  await flush();
  q.streamAnswers.push('throw');
  await fire(q, 1_000);
  await fire(q, 2_000);
  qr.conn.stop();
  assert.equal(q.timers.filter((t) => !t.cancelled).length, 0);
});

test('conn: every request names an ApiRoute, never a path string; the first room is the kept room when it is still in the world, else the first in server order; stopped and link_reused clear the stored session and room', async () => {
  const f = fake({ session: null, room: ROOM2 });
  f.answers.push({ status: 200, json: { session: SESSION, instance: 'ABCDEFGH' } }, { status: 200, json: world(1) });
  f.streamAnswers.push(200);
  const c = connect(f);
  await c.conn.start(LAUNCH);
  await flush();
  const KINDS = new Set(['session', 'world', 'strings', 'timeline']);
  for (const call of f.calls) {
    assert.equal(typeof call.route, 'object');
    assert.ok(KINDS.has(call.route.r), call.route.r);
    assert.ok(!JSON.stringify(call.route).includes('/'), 'no path in a route');
  }
  // The session survives; the kept room stays until the viewer stops.
  assert.deepEqual(f.stored, { session: SESSION, room: ROOM2 });
  assert.equal(f.clears, 0);
  c.conn.stop();
  assert.deepEqual(c.states, ['live', 'stopped']);
  assert.deepEqual(f.stored, { session: null, room: null });
  assert.equal(f.clears, 1);
  // stop() twice is one stop.
  c.conn.stop();
  assert.deepEqual(c.states, ['live', 'stopped']);
  // link_reused clears; link_expired and need_link keep the tab's storage (nothing to clear but a dead session).
  const r = fake({ session: SESSION, room: ROOM });
  r.answers.push({ status: 401, json: { code: 'UI_VIZ_LINK_REUSED' } });
  await connect(r).conn.start(LAUNCH);
  assert.deepEqual(r.stored, { session: null, room: null });
  const x = fake({ session: null, room: ROOM });
  x.answers.push({ status: 401, json: { code: 'UI_VIZ_LINK_EXPIRED' } });
  await connect(x).conn.start(LAUNCH);
  assert.deepEqual(x.stored, { session: null, room: ROOM });
  assert.equal(x.clears, 0);
  // A malformed session answer is not stored.
  const m = fake();
  m.answers.push({ status: 200, json: { session: 'not hex', instance: 'ABCDEFGH' } });
  const mr = connect(m);
  await mr.conn.start(LAUNCH);
  assert.equal(m.stored.session, null);
  assert.deepEqual(mr.states, ['need_link']);
  // A world the viewer cannot answer at boot → stopped.
  const s = fake({ session: SESSION, room: null });
  s.answers.push({ status: 500, json: { code: 'UI_INTERNAL_ERROR' } });
  const sr = connect(s);
  await sr.conn.start(null);
  assert.deepEqual(sr.states, ['stopped']);
  // A 401 on the world (a session the viewer does not know) → need_link.
  const u = fake({ session: SESSION, room: null });
  u.answers.push({ status: 401, json: { code: 'UI_VIZ_NEED_LINK' } });
  const ur = connect(u);
  await ur.conn.start(null);
  assert.deepEqual(ur.states, ['need_link']);

  // firstRoom: the kept room when it is still in the world (gone or not), else the first room in server order, null without rooms.
  const w = world(1, [[ROOM2, 1], [ROOM, 1]]);
  assert.equal(firstRoom(w, ROOM), ROOM);
  assert.equal(firstRoom(w, ROOM2), ROOM2);
  assert.equal(firstRoom(w, 'rGONE0000'), ROOM2);
  assert.equal(firstRoom(w, null), ROOM2);
  assert.equal(firstRoom(w, '__proto__'), ROOM2);
  assert.equal(firstRoom(world(1, []), ROOM), null);
});
