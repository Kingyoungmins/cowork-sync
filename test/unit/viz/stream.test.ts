// The stream hub (12 §3.10.5 "Stream ids and resume"; VIZ-34, VIZ-42): sequence ids, the resume ring, the 64 KiB message cap, reset,
// bye and comment lines, over in-memory sinks.
import { EventEmitter } from 'node:events';
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { VirtualClock } from '../../sim/vclock.js';
import { seededRandom } from '../../../src/ports/random.js';
import {
  COMMENT_MS, frameSse, LAST_EVENT_ID_RE, RING_EVENTS, RING_MAX_BYTES, RING_MS, SSE_BUFFER_MAX, SSE_MAX_BYTES, StreamHub, type SseSink,
} from '../../../src/viz/server/stream.js';
import { cappedSink, createServer, escapeJson, SSE_RECHECK_MS, type SseResponse, type VizServer } from '../../../src/viz/server/http.js';
import { TokenAuthority } from '../../../src/viz/server/tokens.js';
import { nullVizLog } from '../../../src/viz/server/vizLog.js';
import type { WorldApi } from '../../../src/viz/server/models.js';
import type { CardVM, CharacterVM, EventVM, LayoutDeltaVM, SceneVM, StreamPayload, Tick } from '../../../src/viz/server/viewModel.js';
import { openStream, RecordingLog, startTestServer } from '../../helpers/vizHttp.js';

interface Msg { id: number | null; event: string | null; data: unknown; bytes: number; comment: boolean; }

class MemSink implements SseSink {
  readonly chunks: string[] = [];
  ended = false;
  private readonly closers: Array<() => void> = [];
  write(chunk: string): boolean { assert.ok(!this.ended, 'no write after end'); this.chunks.push(chunk); return true; }
  end(): void { this.ended = true; }
  onClose(cb: () => void): void { this.closers.push(cb); }
  close(): void { for (const c of this.closers) c(); }
  text(): string { return this.chunks.join(''); }
  /** Every SSE message written, in order (a chunk may hold several). */
  messages(): Msg[] {
    const out: Msg[] = [];
    for (const block of this.text().split('\n\n')) {
      if (block === '') continue;
      const bytes = Buffer.byteLength(`${block}\n\n`, 'utf8');
      if (block === ': ') { out.push({ id: null, event: null, data: null, bytes, comment: true }); continue; }
      const m: Msg = { id: null, event: null, data: null, bytes, comment: false };
      for (const line of block.split('\n')) {
        if (line.startsWith('id: ')) m.id = Number(line.slice(4));
        else if (line.startsWith('event: ')) m.event = line.slice(7);
        else if (line.startsWith('data: ')) m.data = JSON.parse(line.slice(6));
        else assert.fail(`unexpected SSE line ${JSON.stringify(line.slice(0, 40))}`);
      }
      out.push(m);
    }
    return out;
  }
  ids(): number[] { return this.messages().filter((m) => !m.comment).map((m) => m.id as number); }
}

const ROOM_A = 'rAAAAAAAA';
const ROOM_B = 'rBBBBBBBB';
const overlay = (room: string): StreamPayload => ({
  type: 'overlay', room_id: room,
  overlay: { state: 'ok', freeze_reasons: [], publish_pause: null, down: false, unreadable: false, offline_min: null, holds: 0, incoming: 0, ready: 0, you: null },
});
const roomMsg = (room: string): StreamPayload => ({ type: 'room', room_id: room, change: 'state', label: 'repo', branch: 'main', gone: false, badges: [], unknown: 0 });
const pathOf = (h: number, i: number, len: number): string => `src/${String(h).padStart(4, '0')}/${String(i).padStart(3, '0')}/${'p'.repeat(len)}.ts`;
const publishAt = (h: number, paths: string[]): EventVM => ({
  at: [h, 1001, 0], seed: h, kind: 'publish', actor: { peer: 'a1b2c3' }, target: 1, others: [], paths, n: paths.length,
  state: 'closed', checks: 'pass', origin: 'prompt',
});
const cardAt = (h: number, paths: string[]): CardVM => ({
  id: `${h}.1001.0`, at: [h, 1001, 0], group: 'activity', code: 'UI_VIZ_CARD_PUBLISH', actor: { peer: 'a1b2c3' }, target: null, paths, n: paths.length,
  desks: [1], displayId: null, parent: null, label: null, text: null, detail: null, seen_ms: null,
});
const character = (i: number): CharacterVM => ({ handle: `c0ffee${String(i).padStart(2, '0')}`, name: `n${i}`, hue: i % 7, accessory: i % 8, ph: 'PH_OK', version: '0.1.0', badges: [] });
const emptyScene = (h: number): SceneVM => ({
  at: [h, 1002, 0], badge: 'none', branchMovedAt: null, characters: [], pets: [], desks: [], claims: [], requests: [], boxes: [], bangs: [], beat: [],
});
const timeline = (room: string, h1: number, events: EventVM[], cards: CardVM[], ticks: Tick[], characters: CharacterVM[] = []): StreamPayload => ({
  type: 'timeline', room_id: room, h1, events, cards, ticks, characters, pets: [],
});

test('T-VIZ-stream (hub): ids from 1 shared by all rooms and kinds; Last-Event-ID in the ring replays every later event then goes live; malformed, larger than the sequence, or older than the ring → one reset; the header is never echoed or logged', async () => {
  assert.equal(LAST_EVENT_ID_RE.source, '^(0|[1-9][0-9]{0,15})$');
  const clock = new VirtualClock();
  const hub = new StreamHub(clock);
  assert.equal(hub.seq(), 0);
  // No event yet: "0" resumes (nothing to replay), then live.
  const early = new MemSink();
  hub.attach(early, '0');
  assert.deepEqual(early.messages(), []);
  hub.publish(overlay(ROOM_A));
  hub.publish(roomMsg(ROOM_B));
  hub.publish(timeline(ROOM_A, 3, [publishAt(3, ['a.ts'])], [cardAt(3, ['a.ts'])], [{ h: 3, glyph: 'publish' }]));
  hub.publish({ type: 'layout', room_id: ROOM_B, layout: { from_version: 0, version: 1, zones: [], desks: [], homeOrder: [] } });
  hub.publish({ type: 'reset' });
  assert.equal(hub.seq(), 5);
  assert.deepEqual(early.ids(), [1, 2, 3, 4, 5], 'ids from 1, one sequence for every room and kind');
  assert.deepEqual(early.messages().map((m) => m.event), ['overlay', 'room', 'timeline', 'layout', 'reset']);

  const from0 = new MemSink();
  hub.attach(from0, '0');
  const from3 = new MemSink();
  hub.attach(from3, '3');
  const atSeq = new MemSink();
  hub.attach(atSeq, '5');
  assert.deepEqual(from0.ids(), [1, 2, 3, 4, 5], 'replays every later event of every kind');
  assert.deepEqual(from3.ids(), [4, 5]);
  assert.deepEqual(atSeq.ids(), []);
  hub.publish(overlay(ROOM_B));
  for (const s of [early, from0, from3, atSeq]) assert.equal(s.ids().at(-1), 6, 'then live');
  assert.deepEqual(from0.messages()[0]?.data, overlay(ROOM_A), 'the replayed event is the published one');

  // Malformed, larger than the sequence, absent: one reset carrying the current sequence, never the presented value.
  const hostile = 'evil<script>';
  const NEXT = 'one more than the sequence';
  for (const bad of [undefined, '', '01', '-1', '1.0', ' 3', '3 ', 'abc', '0x1', '1e3', NEXT, '99999999999999999', '9999999999999999', hostile]) {
    const seq = hub.seq();
    const presented = bad === NEXT ? String(seq + 1) : bad;
    const s = new MemSink();
    hub.attach(s, presented);
    const msgs = s.messages();
    assert.equal(msgs.length, 1, `one message for ${JSON.stringify(presented)}`);
    assert.equal(msgs[0]?.event, 'reset');
    assert.deepEqual(msgs[0]?.data, { type: 'reset' });
    assert.equal(msgs[0]?.id, seq, 'the reset carries the current sequence');
    assert.equal(hub.seq(), seq, 'and takes no new id');
    assert.ok(!s.text().includes('evil') && !s.text().includes('script'), 'never echoed');
    hub.publish(roomMsg(ROOM_A));
    assert.equal(s.ids().at(-1), hub.seq(), 'and the stream goes live after the reset');
  }
  // The per-stream reset is not in the ring: resuming just before the sequence replays the last published event only.
  const after = new MemSink();
  hub.attach(after, String(hub.seq() - 1));
  assert.deepEqual(after.messages().map((m) => [m.id, m.event]), [[hub.seq(), 'room']]);

  // Older than the ring by count: 4,096 events kept.
  const big = new StreamHub(new VirtualClock());
  for (let i = 0; i < RING_EVENTS + 10; i++) big.publish(roomMsg(ROOM_A));
  const tooOld = new MemSink();
  big.attach(tooOld, String(big.seq() - RING_EVENTS - 1));
  assert.deepEqual(tooOld.messages().map((m) => m.event), ['reset']);
  const oldest = new MemSink();
  big.attach(oldest, String(big.seq() - RING_EVENTS));
  assert.equal(oldest.ids().length, RING_EVENTS);
  assert.equal(oldest.ids()[0], big.seq() - RING_EVENTS + 1);

  // Older than the ring by time: events older than 10 min (Δmono) leave it.
  const tclock = new VirtualClock();
  const timed = new StreamHub(tclock);
  timed.publish(roomMsg(ROOM_A));
  tclock.advance(RING_MS / 2);
  timed.publish(roomMsg(ROOM_A));
  tclock.advance(RING_MS / 2 + 1);
  const lost = new MemSink();
  timed.attach(lost, '0');
  assert.deepEqual(lost.messages().map((m) => m.event), ['reset'], 'event 1 is older than 10 min');
  const kept = new MemSink();
  timed.attach(kept, '1');
  assert.deepEqual(kept.ids(), [2]);
  tclock.advance(RING_MS);
  const none = new MemSink();
  timed.attach(none, '2');
  assert.deepEqual(none.ids(), [], 'at the sequence: nothing missed even with an empty ring');

  // Through the server: a hostile Last-Event-ID gets one reset and reaches neither the viewer log nor the console.
  const rec = new RecordingLog();
  const srv = await startTestServer({ log: rec });
  const consoleCalls: unknown[][] = [];
  const spies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const)
    .map((m) => mock.method(console, m, (...args: unknown[]) => { consoleCalls.push(args); }));
  try {
    const session = await srv.session();
    const stream = await openStream(srv.port, { 'x-cowork-session': session, 'last-event-id': `${hostile}LEIDMARK` });
    assert.equal(stream.status, 200);
    const reset = await stream.waitFor((m) => !m.comment);
    assert.deepEqual([reset.event, reset.data], ['reset', { type: 'reset' }]);
    stream.close();
    await srv.close();
    assert.deepEqual({ writes: rec.writes, securities: rec.securities, errors: rec.errors }, { writes: [], securities: [], errors: [] },
      'nothing of the stream request is logged');
    assert.deepEqual(consoleCalls, [], 'nor printed');
  } finally {
    for (const s of spies) s.mock.restore();
    await srv.close();
  }
});

test('T-VIZ-stream (ring): besides its count and age limits the resume ring holds at most SSE_BUFFER_MAX (1 MiB) of messages, the most a resume may replay (R-V72), evicting the oldest (64 KiB events)', () => {
  const hub = new StreamHub(new VirtualClock());
  const payload: StreamPayload = { type: 'room', room_id: ROOM_A, change: 'state', label: 'x'.repeat(65_000), branch: 'main', gone: false, badges: [], unknown: 0 };
  const sizes: number[] = [0];
  const N = 40;
  for (let id = 1; id <= N; id++) {
    sizes.push(Buffer.byteLength(frameSse(id, payload), 'utf8'));
    hub.publish(payload);
  }
  assert.ok((sizes[1] ?? 0) <= SSE_MAX_BYTES && (sizes[1] ?? 0) > SSE_MAX_BYTES - 1_024, 'each event is one message of almost 64 KiB');
  assert.equal(hub.seq(), N);
  // The newest k events whose messages fit in 1 MiB stay: 16 messages of almost 64 KiB.
  let k = 0;
  let total = 0;
  while (k < N && total + (sizes[N - k] ?? 0) <= 1_048_576) total += sizes[N - k++] ?? 0;
  assert.equal(k, 16, `the ring keeps ${k} of ${N}`);
  // The ring itself, white-box.
  const ring = (hub as unknown as { ring: Array<{ id: number; bytes: number; frame: string }> }).ring;
  assert.deepEqual(ring.map((e) => e.id), Array.from({ length: k }, (_, i) => N - k + 1 + i), 'the newest k events stay, the oldest left');
  assert.equal(ring.reduce((s, e) => s + e.bytes, 0), total, 'at most 1 MiB of messages');
  assert.ok(ring.every((e) => e.bytes === Buffer.byteLength(e.frame, 'utf8')), 'each entry counts its own frame');
  // Through attach: the whole ring still replays (it is never more than a resume may replay); a resume behind it is one reset.
  const whole = new MemSink();
  hub.attach(whole, String(N - k));
  assert.deepEqual(whole.ids(), Array.from({ length: k }, (_, i) => N - k + 1 + i), 'a resume at the ring\'s start replays all of it');
  const evicted = new MemSink();
  hub.attach(evicted, String(N - k - 1));
  const got = evicted.messages();
  assert.deepEqual([got.length, got[0]?.event, got[0]?.id], [1, 'reset', N], 'the oldest event left the ring: one reset');
  assert.equal(RING_MAX_BYTES, SSE_BUFFER_MAX, 'R-V72: the ring holds at most what a resume may replay');
});

test('T-VIZ-stream (resume): when the events after Last-Event-ID add up to more than SSE_BUFFER_MAX bytes the stream gets one reset instead of the replay, as for a resume older than the ring (R-V65)', () => {
  assert.equal(SSE_BUFFER_MAX, 1_048_576);
  const big = (n: number): StreamPayload => ({ type: 'room', room_id: ROOM_A, change: 'state', label: 'x'.repeat(n), branch: 'main', gone: false, badges: [], unknown: 0 });
  const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');
  /** Event 1 is small; events 2… after it add up to exactly SSE_BUFFER_MAX + extra bytes. */
  const build = (extra: number): StreamHub => {
    const hub = new StreamHub(new VirtualClock());
    hub.publish(roomMsg(ROOM_A));
    let total = 0;
    for (let i = 0; i < 16; i++) {
      total += bytes(frameSse(hub.seq() + 1, big(65_000)));
      hub.publish(big(65_000));
    }
    const filler = SSE_BUFFER_MAX + extra - total - bytes(frameSse(hub.seq() + 1, big(0)));
    assert.ok(filler > 0 && filler < 65_000);
    hub.publish(big(filler));
    return hub;
  };
  const exact = build(0);
  const replayed = new MemSink();
  exact.attach(replayed, '1');
  assert.deepEqual(replayed.ids(), Array.from({ length: 17 }, (_, i) => i + 2), 'exactly SSE_BUFFER_MAX bytes: replayed');
  assert.equal(replayed.messages().reduce((s, m) => s + m.bytes, 0), SSE_BUFFER_MAX);
  const fromStart = new MemSink();
  exact.attach(fromStart, '0');
  assert.deepEqual(fromStart.messages().map((m) => [m.id, m.event, m.data]), [[exact.seq(), 'reset', { type: 'reset' }]], 'one event more: one reset');

  const over = build(1);
  const cut = new MemSink();
  over.attach(cut, '1');
  assert.deepEqual(cut.messages().map((m) => [m.id, m.event]), [[over.seq(), 'reset']], 'one byte over SSE_BUFFER_MAX: one reset, carrying the current sequence');
  assert.equal(over.seq(), 18, 'the reset takes no id');
  over.publish(roomMsg(ROOM_B));
  assert.deepEqual(cut.messages().map((m) => [m.id, m.event]), [[18, 'reset'], [19, 'room']], 'then live');
  // A resume close to the sequence still replays.
  const near = new MemSink();
  over.attach(near, '17');
  assert.deepEqual(near.ids(), [18, 19]);
});

/** A stream response whose backlog the test sets: writableLength stands for the bytes the reader has not taken. */
class FakeResponse extends EventEmitter implements SseResponse {
  writableLength = 0;
  readonly writes: string[] = [];
  destroyed = false;
  ended = false;
  write(chunk: string): boolean { this.writes.push(chunk); return this.writableLength <= 16_384; }
  end(): void { this.ended = true; this.emit('close'); }
  destroy(): void { this.destroyed = true; this.emit('close'); }
}

/** One turn of the event loop: a check the sink deferred with setImmediate has run. */
const turn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });
const OVER = SSE_BUFFER_MAX + 1;

test('T-VIZ-stream (cap): R-V65 — a stream is cut, counted SEC_VIZ_LIMIT once, only when its backlog is above SSE_BUFFER_MAX at two deferred checks; a check at or under the cap, or a full drain (res \'drain\'), clears the first, so two bursts over the cap separated by a drain with no write between leave it open', async () => {
  const clock = new VirtualClock();
  // Two checks over the cap: cut at the second, counted once.
  const rec = new RecordingLog();
  const res = new FakeResponse();
  const sink = cappedSink(res, clock, rec);
  res.writableLength = OVER;
  sink.write('a');
  sink.write('b');
  assert.equal(res.destroyed, false, 'never measured synchronously after a write');
  await turn();
  assert.equal(res.destroyed, false, 'one deferred check over the cap cuts nothing (the two-check rule)');
  await turn();
  await turn();
  assert.equal(res.destroyed, false, 'no immediate re-poll: nothing re-checks without a write or the clock');
  sink.write('c');
  await turn();
  assert.equal(res.destroyed, true, 'the second deferred check over the cap cuts the stream');
  assert.deepEqual(rec.securities, ['SEC_VIZ_LIMIT'], 'counted once');
  assert.equal(sink.write('d'), false, 'nothing is written after the cut');
  assert.deepEqual(res.writes, ['a', 'b', 'c']);

  // A check at or under the cap clears the first.
  const rec2 = new RecordingLog();
  const res2 = new FakeResponse();
  const sink2 = cappedSink(res2, clock, rec2);
  res2.writableLength = OVER;
  sink2.write('a');
  await turn();
  res2.writableLength = SSE_BUFFER_MAX;
  sink2.write('b');
  await turn();
  res2.writableLength = OVER;
  sink2.write('c');
  await turn();
  assert.equal(res2.destroyed, false, 'after a check at the cap, a check over it is a first check again');
  sink2.write('d');
  await turn();
  assert.equal(res2.destroyed, true);
  assert.deepEqual(rec2.securities, ['SEC_VIZ_LIMIT']);

  // Two bursts over the cap separated by a full drain, with no write between: the drain clears the first check.
  const rec3 = new RecordingLog();
  const res3 = new FakeResponse();
  const sink3 = cappedSink(res3, clock, rec3);
  res3.writableLength = 2 * SSE_BUFFER_MAX;
  sink3.write('burst 1');
  await turn();
  assert.equal(res3.destroyed, false);
  res3.writableLength = 0;
  res3.emit('drain');
  res3.writableLength = 2 * SSE_BUFFER_MAX;
  sink3.write('burst 2');
  await turn();
  assert.equal(res3.destroyed, false, 'the second burst after a full drain is a first check again, not a second');
  res3.writableLength = 0;
  res3.emit('drain');
  sink3.write('live');
  await turn();
  assert.equal(res3.destroyed, false, 'the stream stays open');
  assert.deepEqual(rec3.securities, [], 'a reader that reads is never counted');
});

test('T-VIZ-stream (cap): R-V65(c) — once a check found the backlog over the cap, ONE re-check runs SSE_RECHECK_MS later by the injected Clock with no write (an unref\'d wake-up; a wake-up before the clock is due checks nothing): still over → cut, counted once; at or under → cleared; a drain or the close cancels it', async () => {
  assert.equal(SSE_RECHECK_MS, 1_000);
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const wakes: Array<{ ms: number | undefined; fn: () => void; handle: ReturnType<typeof setTimeout> }> = [];
  const cleared: unknown[] = [];
  const st = mock.method(globalThis, 'setTimeout', ((fn: () => void, ms?: number) => {
    const handle = realSetTimeout(fn, ms);
    wakes.push({ ms, fn, handle });
    return handle;
  }) as unknown as typeof setTimeout);
  const ct = mock.method(globalThis, 'clearTimeout', ((h: ReturnType<typeof setTimeout>) => {
    cleared.push(h);
    realClearTimeout(h);
  }) as unknown as typeof clearTimeout);
  const latest = (): (typeof wakes)[number] => {
    const w = wakes.at(-1);
    assert.ok(w !== undefined, 'a wake-up is armed');
    return w;
  };
  try {
    // Still over the cap at the re-check: cut, with no write after the first check.
    const clock = new VirtualClock();
    const rec = new RecordingLog();
    const res = new FakeResponse();
    const sink = cappedSink(res, clock, rec);
    res.writableLength = OVER;
    sink.write('a');
    assert.equal(wakes.length, 0, 'no re-check is armed before a check found the backlog over the cap');
    await turn();
    assert.deepEqual(wakes.map((w) => w.ms), [SSE_RECHECK_MS], 'one re-check armed, on the clock');
    assert.equal(latest().handle.hasRef(), false, 'unref\'d: it never keeps the process alive');
    latest().fn();
    assert.equal(res.destroyed, false, 'a wake-up before the clock reached SSE_RECHECK_MS checks nothing');
    assert.deepEqual(wakes.map((w) => w.ms), [SSE_RECHECK_MS, SSE_RECHECK_MS], 'and re-arms for the rest');
    clock.advance(SSE_RECHECK_MS);
    latest().fn();
    assert.equal(res.destroyed, true, 'the re-check, with no write, cuts a stream still over the cap');
    assert.deepEqual(rec.securities, ['SEC_VIZ_LIMIT'], 'counted once');
    assert.deepEqual(res.writes, ['a'], 'nothing was written between the two checks');
    assert.equal(wakes.length, 2, 'nothing more is armed');

    // At or under the cap at the re-check (the reader took most of the backlog, not all of it, so no drain): cleared, so the next
    // check over the cap is a first check again.
    wakes.length = 0;
    const rec2 = new RecordingLog();
    const res2 = new FakeResponse();
    const sink2 = cappedSink(res2, clock, rec2);
    res2.writableLength = OVER;
    sink2.write('a');
    await turn();
    res2.writableLength = SSE_BUFFER_MAX;
    clock.advance(SSE_RECHECK_MS);
    latest().fn();
    assert.equal(res2.destroyed, false);
    assert.equal(wakes.length, 1, 'the re-check under the cap arms nothing');
    res2.writableLength = OVER;
    sink2.write('b');
    await turn();
    assert.equal(res2.destroyed, false, 'after the re-check cleared it, a check over the cap is a first check again');
    assert.equal(wakes.length, 2, 'and arms its own re-check');
    sink2.write('c');
    await turn();
    assert.equal(res2.destroyed, true, 'a second check over the cap, from a write before the re-check, cuts');
    assert.ok(cleared.includes(latest().handle), 'the cut cancels the pending re-check');
    assert.deepEqual(rec2.securities, ['SEC_VIZ_LIMIT']);

    // A full drain cancels the re-check: once the clock is past its due time, a later burst's check is still a first check.
    wakes.length = 0;
    const rec3 = new RecordingLog();
    const res3 = new FakeResponse();
    const sink3 = cappedSink(res3, clock, rec3);
    res3.writableLength = OVER;
    sink3.write('burst 1');
    await turn();
    const armed = latest();
    res3.writableLength = 0;
    res3.emit('drain');
    assert.ok(cleared.includes(armed.handle), 'the drain clears the armed wake-up');
    res3.writableLength = OVER;
    clock.advance(SSE_RECHECK_MS);
    armed.fn();
    assert.equal(wakes.length, 1, 'a cancelled re-check arms nothing');
    sink3.write('burst 2');
    await turn();
    assert.equal(res3.destroyed, false, 'the cancelled re-check did not count as a check');
    assert.deepEqual(rec3.securities, []);

    // The close (and so end()) cancels it too.
    for (const how of ['close', 'end'] as const) {
      wakes.length = 0;
      const res4 = new FakeResponse();
      const sink4 = cappedSink(res4, clock, new RecordingLog());
      res4.writableLength = OVER;
      sink4.write('a');
      await turn();
      const pending = latest();
      if (how === 'close') res4.emit('close');
      else sink4.end();
      assert.ok(cleared.includes(pending.handle), `${how} clears the armed wake-up`);
    }
  } finally {
    st.mock.restore();
    ct.mock.restore();
  }
});

test('T-VIZ-stream: no SSE message exceeds 64 KiB', async (t) => {
  assert.equal(SSE_MAX_BYTES, 65_536);
  const check = (s: MemSink): Msg[] => {
    const msgs = s.messages();
    for (const m of msgs) assert.ok(m.bytes <= SSE_MAX_BYTES, `message of ${m.bytes} bytes`);
    return msgs;
  };

  await t.test('a large timeline payload splits between events, each part its own id, an event and its card never apart', () => {
    const hub = new StreamHub(new VirtualClock());
    const sink = new MemSink();
    hub.attach(sink, '0');
    const events: EventVM[] = [];
    const cards: CardVM[] = [];
    const ticks: Tick[] = [];
    // 256 paths of emoji per change-set at some heights (R-V50's worst case is cut by the projection; the hub still splits).
    const emoji = String.fromCodePoint(0x1f600).repeat(20);
    for (let h = 10; h < 74; h++) {
      const paths = Array.from({ length: 24 }, (_, i) => `${pathOf(h, i, 20)}${emoji}`);
      events.push(publishAt(h, paths));
      cards.push(cardAt(h, paths));
      ticks.push({ h, glyph: 'publish' });
    }
    const characters = Array.from({ length: 30 }, (_, i) => character(i));
    const p = timeline(ROOM_A, 80, events, cards, ticks, characters);
    assert.ok(Buffer.byteLength(frameSse(1, p), 'utf8') > 4 * SSE_MAX_BYTES, 'the payload is well over 64 KiB');
    hub.publish(p);
    const msgs = check(sink);
    assert.ok(msgs.length > 4, `split into ${msgs.length} messages`);
    assert.deepEqual(msgs.map((m) => m.id), msgs.map((_, i) => i + 1), 'consecutive ids');
    const parts = msgs.map((m) => m.data as Extract<StreamPayload, { type: 'timeline' }>);
    for (const part of parts) {
      assert.equal(part.type, 'timeline');
      assert.equal(part.room_id, ROOM_A);
      const keys = new Set(part.events.map((e) => e.at.join('.')));
      for (const c of part.cards) assert.ok(keys.has(c.id), `card ${c.id} travels with its event`);
    }
    assert.deepEqual(parts.flatMap((x) => x.events), events, 'every event once, in order');
    assert.deepEqual(parts.flatMap((x) => x.cards), cards);
    assert.deepEqual(parts.flatMap((x) => x.ticks), ticks);
    assert.deepEqual(parts[0]?.characters, characters, 'characters and pets come first');
    for (const part of parts.slice(1)) assert.deepEqual([part.characters, part.pets], [[], []]);
    assert.equal(parts.at(-1)?.h1, 80, 'the last part carries the payload h1');
    for (const part of parts.slice(0, -1)) assert.equal(part.h1, part.events.at(-1)?.at[0], 'an earlier part ends at its last event height');
    for (let i = 1; i < parts.length; i++) assert.ok((parts[i]?.h1 ?? -1) >= (parts[i - 1]?.h1 ?? Infinity), 'h1 never decreases');
    // A small timeline is one message, unchanged.
    const small = timeline(ROOM_B, 5, [publishAt(5, ['x.ts'])], [cardAt(5, ['x.ts'])], [{ h: 5, glyph: 'publish' }]);
    hub.publish(small);
    assert.deepEqual(check(sink).at(-1)?.data, small);
  });

  await t.test('characters that fill the first part travel alone ahead of the events; ticks above the last event join the last part', () => {
    const hub = new StreamHub(new VirtualClock());
    const sink = new MemSink();
    hub.attach(sink, '0');
    const characters = Array.from({ length: 400 }, (_, i) => ({ ...character(i), name: `${'n'.repeat(60)}${i}` }));
    const paths = Array.from({ length: 120 }, (_, i) => pathOf(3, i, 60));
    const events = [publishAt(3, paths), publishAt(4, paths)];
    const cards = [cardAt(3, paths), cardAt(4, paths)];
    const ticks: Tick[] = [{ h: 3, glyph: 'publish' }, { h: 4, glyph: 'publish' }, { h: 9, glyph: 'save' }];
    const p = timeline(ROOM_A, 9, events, cards, ticks, characters);
    hub.publish(p);
    const msgs = check(sink);
    const parts = msgs.map((m) => m.data as Extract<StreamPayload, { type: 'timeline' }>);
    assert.ok(parts.length >= 2);
    assert.deepEqual(parts[0]?.characters, characters);
    assert.deepEqual(parts[0]?.events, [], 'the first part holds only the characters');
    assert.deepEqual(parts.flatMap((x) => x.events), events);
    assert.deepEqual(parts.flatMap((x) => x.cards), cards);
    assert.deepEqual(parts.flatMap((x) => x.ticks), ticks);
    assert.deepEqual(parts.at(-1)?.ticks.at(-1), { h: 9, glyph: 'save' });
    assert.equal(parts.at(-1)?.h1, 9);
    // h1 never decreases across the parts: the characters-only part reaches just below the first event.
    assert.equal(parts[0]?.h1, 2, 'the characters-only part ends below the first event height');
    for (let i = 1; i < parts.length; i++) {
      assert.ok((parts[i]?.h1 ?? -1) >= (parts[i - 1]?.h1 ?? Infinity), `h1 never decreases: ${parts.map((x) => x.h1).join(', ')}`);
    }
  });

  await t.test('an oversize layout delta or snapshot scene becomes one reset', () => {
    const hub = new StreamHub(new VirtualClock());
    const sink = new MemSink();
    hub.attach(sink, '0');
    const desks: LayoutDeltaVM['desks'] = Array.from({ length: 900 }, (_, i) => ({
      ordinal: i + 1, kind: 'file', zone: 0, cell: 0, slot: i % 23, plaque: 'plaque', path: pathOf(i, 0, 40), lockbox: false, first: i,
    }));
    hub.publish({ type: 'layout', room_id: ROOM_A, layout: { from_version: 0, version: 1, zones: [], desks, homeOrder: [] } });
    const scene = emptyScene(9);
    scene.beat = Array.from({ length: 400 }, (_, i) => publishAt(9, [pathOf(9, i, 120)]));
    hub.publish({ type: 'room_snapshot', room_id: ROOM_A, window: { h0: 0, h1: 9 }, scene, cards: [], ticks: [], characters: [], pets: [] });
    const msgs = check(sink);
    assert.deepEqual(msgs.map((m) => [m.id, m.event, m.data]), [[1, 'reset', { type: 'reset' }], [2, 'reset', { type: 'reset' }]]);
  });

  await t.test('a snapshot keeps the newest cards that fit', () => {
    const hub = new StreamHub(new VirtualClock());
    const sink = new MemSink();
    hub.attach(sink, '0');
    const cards = Array.from({ length: 200 }, (_, i) => cardAt(i, Array.from({ length: 6 }, (_, j) => pathOf(i, j, 60))));
    const snap: StreamPayload = {
      type: 'room_snapshot', room_id: ROOM_A, window: { h0: 0, h1: 199 }, scene: emptyScene(199), cards,
      ticks: [{ h: 199, glyph: 'publish' }], characters: [character(1)], pets: [],
    };
    assert.ok(Buffer.byteLength(frameSse(1, snap), 'utf8') > SSE_MAX_BYTES);
    hub.publish(snap);
    const msgs = check(sink);
    assert.equal(msgs.length, 1);
    const got = msgs[0]?.data as Extract<StreamPayload, { type: 'room_snapshot' }>;
    assert.ok(got.cards.length > 0 && got.cards.length < cards.length);
    assert.deepEqual(got.cards, cards.slice(cards.length - got.cards.length), 'a suffix: the newest cards');
    assert.deepEqual({ ...got, cards: [] }, { ...snap, cards: [] }, 'everything else unchanged');
    const oneMore = { ...snap, cards: cards.slice(cards.length - got.cards.length - 1) };
    assert.ok(Buffer.byteLength(frameSse(1, oneMore), 'utf8') > SSE_MAX_BYTES, 'as many as fit');
  });

  await t.test('a single event whose framed message with its card exceeds 64 KiB becomes one reset', () => {
    const hub = new StreamHub(new VirtualClock());
    const sink = new MemSink();
    hub.attach(sink, '0');
    // Built past R-V50's 16 KiB path budget by hand: 40 KB of paths on the event and on its card.
    const paths = Array.from({ length: 200 }, (_, i) => pathOf(7, i, 180));
    const p = timeline(ROOM_A, 8, [publishAt(6, ['ok.ts']), publishAt(7, paths)], [cardAt(6, ['ok.ts']), cardAt(7, paths)], [{ h: 7, glyph: 'publish' }]);
    hub.publish(p);
    const msgs = check(sink);
    assert.deepEqual(msgs.map((m) => [m.id, m.event]), [[1, 'reset']], 'the whole payload is replaced, nothing partial is sent');
    assert.equal(hub.seq(), 1);
  });
});

test('a comment line every 15 s; close() sends bye to every stream; open() counts streams for the idle exit', async () => {
  assert.equal(COMMENT_MS, 15_000);
  const hub = new StreamHub(new VirtualClock());
  const a = new MemSink();
  const b = new MemSink();
  assert.equal(hub.open(), 0);
  hub.attach(a, '0');
  hub.attach(b, '0');
  assert.equal(hub.open(), 2);
  hub.comment();
  assert.equal(a.text(), ': \n\n');
  assert.equal(b.text(), ': \n\n');
  b.close();
  assert.equal(hub.open(), 1, 'a closed stream no longer counts');
  hub.publish(roomMsg(ROOM_A));
  assert.equal(b.ids().length, 0, 'nothing is written to a closed stream');

  // createServer drives hub.comment() every COMMENT_MS of the injected Clock (Δmono, ServerDeps.clock): an unref'd Node timer only
  // wakes the check, so a wake-up before the clock reached the due time writes nothing, and close() stops it. The wake-ups are
  // observed and run by hand.
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const wakes: Array<{ ms: number | undefined; fn: () => void; handle: ReturnType<typeof setTimeout> }> = [];
  const cleared: unknown[] = [];
  const st = mock.method(globalThis, 'setTimeout', ((fn: () => void, ms?: number) => {
    const handle = realSetTimeout(fn, ms);
    wakes.push({ ms, fn, handle });
    return handle;
  }) as unknown as typeof setTimeout);
  const ct = mock.method(globalThis, 'clearTimeout', ((h: ReturnType<typeof setTimeout>) => {
    cleared.push(h);
    realClearTimeout(h);
  }) as unknown as typeof clearTimeout);
  let server: VizServer | null = null;
  try {
    const clock = new VirtualClock();
    const served = new StreamHub(clock);
    const api: WorldApi = { world: async () => assert.fail('unused'), page: async () => null, strings: () => null };
    const r = await createServer({
      clock, log: nullVizLog, hub: served, tokens: new TokenAuthority(seededRandom('comment'), clock), api,
      assets: { appJs: '', appCss: '' }, onActivity: () => {}, onLaunchReused: () => {},
    });
    assert.ok(!('refuse' in r));
    server = r;
    const latest = (): (typeof wakes)[number] => {
      const w = wakes.at(-1);
      assert.ok(w !== undefined, 'a wake-up timer is armed');
      return w;
    };
    assert.deepEqual(wakes.map((w) => w.ms), [COMMENT_MS], 'one wake-up armed for 15 s');
    assert.equal(latest().handle.hasRef(), false, 'unref\'d: it never keeps the process alive');
    const s = new MemSink();
    served.attach(s, '0');
    latest().fn();
    assert.equal(s.text(), '', 'a wake-up before 15 s of the clock writes nothing');
    assert.deepEqual(wakes.map((w) => w.ms), [COMMENT_MS, COMMENT_MS], 're-armed for the rest of the 15 s');
    assert.equal(latest().handle.hasRef(), false);
    clock.advance(COMMENT_MS);
    latest().fn();
    assert.equal(s.text(), ': \n\n', 'at 15 s of the clock: one comment line to every stream');
    clock.advance(COMMENT_MS - 1);
    latest().fn();
    assert.equal(s.text(), ': \n\n', 'the next one is due 15 s after the first');
    clock.advance(1);
    latest().fn();
    assert.equal(s.text(), ': \n\n: \n\n');
    assert.ok(wakes.every((w) => !w.handle.hasRef()), 'every wake-up is unref\'d');
    const armed = latest();
    await server.close();
    server = null;
    assert.ok(cleared.includes(armed.handle), 'close() clears the armed wake-up');
    const count = wakes.length;
    clock.advance(COMMENT_MS);
    armed.fn();
    assert.equal(s.text(), ': \n\n: \n\n', 'a stale wake-up after close() writes nothing');
    assert.equal(wakes.length, count, 'and arms nothing');
  } finally {
    st.mock.restore();
    ct.mock.restore();
    if (server !== null) await server.close();
  }

  hub.close();
  assert.ok(a.ended);
  assert.deepEqual(a.messages().filter((m) => !m.comment).map((m) => [m.event, m.data]), [['room', roomMsg(ROOM_A)], ['bye', { type: 'bye' }]]);
  assert.equal(hub.open(), 0);
  const late = new MemSink();
  hub.attach(late, String(hub.seq()));
  assert.deepEqual(late.messages().map((m) => m.event), ['bye'], 'a stream opened after close() gets bye at once');
  assert.ok(late.ended);
  assert.equal(hub.open(), 0);
});

test('frameSse and escapeJson: id, event and one data line; <, >, &, U+2028 and U+2029 as \\u escapes', () => {
  const p: StreamPayload = { type: 'room', room_id: ROOM_A, change: 'state', label: '<b>&\u{2028}\u{2029}</b>\n', branch: 'x', gone: false, badges: [], unknown: 0 };
  const f = frameSse(42, p);
  assert.equal(f, `id: 42\nevent: room\ndata: ${escapeJson(p)}\n\n`);
  assert.equal(f.split('\n').length, 5, 'no raw line break inside data');
  assert.ok(!/[<>&\u{2028}\u{2029}]/u.test(f));
  assert.ok(f.includes('\\u003cb\\u003e\\u0026\\u2028\\u2029\\u003c/b\\u003e\\n'));
  assert.deepEqual(JSON.parse(escapeJson(p)), p);
});
