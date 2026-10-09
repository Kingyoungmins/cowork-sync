// Plan 8a Task 8: the poll loop and the git budget of a tick (12 §3.9.2, §3.12 "Git calls per room per 2.5 s tick"; VIZ-07,
// VIZ-41; R-V05's amended count, R-V31): idle rooms cost one rev-parse per 60 s each and no other git process; a fetch of 3
// commits costs rev-parse, rev-list, cat-file --batch-check and cat-file --batch; a room never has two git children at once,
// even with a page and "load earlier" racing its tick; startPoll ticks the stores one at a time every 2.5 s of Δmono, is never
// re-entrant, forwards what a tick reports to the sink and stops after the running tick. Real boards in one clone on a
// file:// remote (one board per branch, one room per board); the loop's clock wake-ups are observed and run by hand (ledger:
// under a VirtualClock, clock.advance() alone fires no clockTimer wake-up).
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Overlay } from '../../../src/viz/source/roomSource.js';
import { DemoRoomSource, parseDemoLog } from '../../../src/viz/source/demo.js';
import type { RoomDelta, StoreLike } from '../../../src/viz/server/models.js';
import { POLL_MS, startPoll } from '../../../src/viz/server/poll.js';
import { RoomStore } from '../../../src/viz/server/store.js';
import { BoardWriter } from '../../../tools/viz/boardWriter.js';
import { VirtualClock } from '../../sim/vclock.js';
import { makeRepoFixture } from '../../helpers/repoFixture.js';
import { CAPTION_CODES, demoBuffer, headerLine, storyLines } from '../../helpers/vizDemo.js';
import { deltaOf, OVERLAY, snapshotOf, SPEC } from '../../helpers/vizModels.js';
import { kinds, vizRunner } from '../../helpers/vizSource.js';
import { gitRoom, pubs, roomIdOf, spySource, storeDeps, type GitRoom } from '../../helpers/vizStore.js';

type TickResult = Awaited<ReturnType<StoreLike['tick']>>;
const NO_TICK: TickResult = { delta: null, overlay: null, change: null };

test('T-VIZ-poll: 8 rooms idle for 60 virtual seconds run at most one rev-parse per room and no other git process; a fetch of 3 commits costs rev-parse, rev-list, cat-file --batch-check and cat-file --batch; never two git children of one room at once', async () => {
  const fx = await makeRepoFixture('viz-poll');
  try {
    const main = (await fx.repo.resolve('refs/heads/main'))!;
    const clock = new VirtualClock();
    const runner = vizRunner(join(fx.root, 'viz data'), clock);
    const rooms: Array<{ w: BoardWriter; r: GitRoom }> = [];
    for (let i = 0; i < 8; i++) {
      await fx.repo.run(['update-ref', `refs/heads/b${i}`, main]);
      const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: `b${i}`, seed: `poll-${i}` });
      await w.genesis('ann');
      await w.join('bob');
      await w.commitMany(pubs(i === 0 ? 1_400 : 20 + i));
      rooms.push({ w, r: gitRoom(fx, w.ref, { clock, n: i, runner }) });
    }
    for (const { r } of rooms) {
      await r.store.init();
      r.git.reset();
    }
    // 60 virtual seconds without a ref change: 24 polls of every room.
    for (let i = 0; i < 24; i++) {
      clock.advance(POLL_MS);
      for (const { r } of rooms) assert.deepEqual(await r.store.tick(), NO_TICK);
    }
    for (const { r } of rooms) assert.deepEqual(kinds(r.git.calls), ['rev-parse --verify'], 'one rev-parse (the 60 s safety net) and no other git process');

    // This PC's daemon fetches 3 board commits into every room.
    for (const { w } of rooms) await w.commitMany(pubs(3, 'fetched'));
    clock.advance(POLL_MS);
    for (const { r } of rooms) {
      r.git.reset();
      const t = await r.store.tick();
      assert.equal(t.delta?.kind, 'timeline');
      assert.deepEqual(kinds(r.git.calls), ['rev-parse --verify', 'rev-list --first-parent', 'cat-file --batch-check', 'cat-file --batch']);
      assert.ok(r.git.calls.every((c) => !c.args.includes('--count')), 'no rev-list --count for a fast-forward of 3');
    }

    // A page, "load earlier" and a tick of one room at once: their git children never overlap.
    const big = rooms[0]!;
    await big.w.commitMany(pubs(2, 'race'));
    clock.advance(POLL_MS);
    big.r.git.reset();
    const [t, e, p] = await Promise.all([big.r.store.tick(), big.r.store.earlier(), big.r.store.page(300, 600), big.r.store.page(10, 20)]);
    assert.ok(t.delta !== null && e !== null && p !== null);
    assert.ok(big.r.git.calls.some((c) => c.args[0] === 'cat-file'), 'they did run git');
    for (const { r } of rooms) assert.equal(r.git.maxInFlight, 1, 'never two git children of one room at once');
  } finally {
    await fx.cleanup();
  }
});

interface Deferred { promise: Promise<void>; resolve(): void; }
function deferred(): Deferred {
  let resolve = (): void => {};
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/** A StoreLike whose tick() logs its start and end, can wait at a gate, and answers `result` (or throws). */
class GateStore implements StoreLike {
  readonly ready = Promise.resolve();
  gate: Deferred | null = null;
  result: TickResult = NO_TICK;
  fails = false;
  constructor(readonly id: string, private readonly log: string[]) {}
  snapshot(): ReturnType<StoreLike['snapshot']> { return snapshotOf({ spec: { ...SPEC, id: this.id } }); }
  page(): ReturnType<StoreLike['page']> { return Promise.resolve(null); }
  earlier(): ReturnType<StoreLike['earlier']> { return Promise.resolve(null); }
  async tick(): Promise<TickResult> {
    this.log.push(`start:${this.id}`);
    if (this.gate !== null) await this.gate.promise;
    this.log.push(`end:${this.id}`);
    if (this.fails) throw new Error('a failing tick');
    return this.result;
  }
}

/** A RoomStore over a demo room, its ticks logged around the store's own tick(). */
function demoStore(room: string, id: string, clock: VirtualClock, log: string[]): { store: StoreLike; ticks: () => number } {
  const parsed = parseDemoLog(demoBuffer([headerLine([{ room, name: room, branch: 'main' }]), ...storyLines(room)]), CAPTION_CODES);
  assert.ok('rooms' in parsed);
  const { source, spy } = spySource(new DemoRoomSource(parsed.rooms[0]!, parsed.commits.get(room)!));
  const s = new RoomStore({ id, kind: 'demo', label: room, branch: 'main', gitDir: null, boardRef: null, canonicalRoot: null }, source, storeDeps(clock));
  const store: StoreLike = {
    ready: s.ready, snapshot: () => s.snapshot(), page: (a, b) => s.page(a, b), earlier: () => s.earlier(),
    tick: async () => {
      log.push(`start:${id}`);
      try {
        return await s.tick();
      } finally {
        log.push(`end:${id}`);
      }
    },
  };
  return { store, ticks: () => spy.changed };
}

/** Lets the loop's pending promise callbacks run (no I/O is involved). */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise<void>((r) => setImmediate(r));
}

test('startPoll runs every 2.5 s of Δmono, one store at a time, never re-entrant, and stop() waits for the running tick', async () => {
  const realSetTimeout = globalThis.setTimeout;
  const wakes: Array<{ ms: number | undefined; fn: () => void; handle: ReturnType<typeof setTimeout> }> = [];
  const st = mock.method(globalThis, 'setTimeout', ((fn: () => void, ms?: number) => {
    const handle = realSetTimeout(fn, ms);
    wakes.push({ ms, fn, handle });
    return handle;
  }) as unknown as typeof setTimeout);
  let stop: (() => Promise<void>) | null = null;
  try {
    const clock = new VirtualClock();
    const log: string[] = [];
    const a = new GateStore(roomIdOf(1), log);
    const b = new GateStore(roomIdOf(2), log);
    const d1 = demoStore('alpha', roomIdOf(3), clock, log);
    const d2 = demoStore('beta', roomIdOf(4), clock, log);
    const sink: string[] = [];
    stop = startPoll([a, d1.store, b, d2.store], {
      delta: (d: RoomDelta) => { sink.push(`delta:${d.roomId}`); },
      overlay: (id: string, o: Overlay) => { sink.push(`overlay:${id}:${o.state}`); },
      roomChanged: (id: string) => { sink.push(`room:${id}`); },
      reset: () => { sink.push('reset'); },
    }, clock);
    const latest = (): (typeof wakes)[number] => {
      const w = wakes.at(-1);
      assert.ok(w !== undefined, 'a wake-up is armed');
      return w;
    };
    assert.deepEqual(wakes.map((w) => w.ms), [POLL_MS], 'one wake-up armed for 2.5 s');
    assert.equal(latest().handle.hasRef(), false, 'unref\'d: it never keeps the viewer alive');

    // A wake-up before 2.5 s of the clock ticks nothing.
    clock.advance(POLL_MS - 1);
    latest().fn();
    await settle();
    assert.deepEqual(log, []);
    assert.equal(latest().ms, 1, 're-armed for the rest of the 2.5 s');

    // At 2.5 s: one pass, the stores one at a time in order; while one runs nothing else starts and nothing is armed.
    clock.advance(1);
    a.gate = deferred();
    const armed = wakes.length;
    latest().fn();
    await settle();
    assert.deepEqual(log, ['start:' + a.id]);
    assert.equal(wakes.length, armed, 'nothing armed while the pass runs');
    for (const w of wakes) w.fn();                        // stale wake-ups run nothing
    await settle();
    assert.deepEqual(log, ['start:' + a.id]);
    a.gate.resolve();
    a.gate = null;
    await settle();
    const pass = (): string[] => [a.id, roomIdOf(3), b.id, roomIdOf(4)].flatMap((id) => [`start:${id}`, `end:${id}`]);
    assert.deepEqual(log, pass(), 'one store at a time, never two ticks at once');
    assert.deepEqual([d1.ticks(), d2.ticks()], [1, 1], 'the RoomStores ticked');
    assert.deepEqual(sink, [], 'idle rooms report nothing');
    // The next pass is due 2.5 s of Δmono after this one started.
    assert.deepEqual(wakes.slice(armed).map((w) => w.ms), [POLL_MS]);
    clock.advance(POLL_MS - 1);
    latest().fn();
    await settle();
    assert.deepEqual(log, pass());
    assert.equal(latest().ms, 1);

    // What a tick reports goes to the sink (an overlay, a delta, a state change; a rebuild resets every page), and a store whose
    // tick throws does not stop the pass.
    a.result = { delta: deltaOf({ roomId: a.id }), overlay: { ...OVERLAY, state: 'offline' }, change: 'state' };
    b.result = { delta: null, overlay: null, change: 'rebuilt' };
    clock.advance(1);
    latest().fn();
    await settle();
    assert.deepEqual(log, [...pass(), ...pass()]);
    assert.deepEqual(sink, [`overlay:${a.id}:offline`, `delta:${a.id}`, `room:${a.id}`, 'reset']);
    a.fails = true;
    clock.advance(POLL_MS);
    latest().fn();
    await settle();
    assert.deepEqual(log, [...pass(), ...pass(), ...pass()], 'the pass goes on after a failing tick');
    assert.deepEqual([d1.ticks(), d2.ticks()], [3, 3]);

    // stop() waits for the running tick; nothing after it is ticked and nothing is armed again.
    a.fails = false;
    b.gate = deferred();
    clock.advance(POLL_MS);
    latest().fn();
    await settle();
    assert.equal(log.at(-1), `start:${b.id}`);
    const count = wakes.length;
    let done = false;
    const stopped = stop().then(() => { done = true; });
    stop = null;
    await settle();
    assert.equal(done, false, 'stop() waits for the running tick');
    b.gate.resolve();
    await stopped;
    assert.equal(log.at(-1), `end:${b.id}`, 'the stores after it are not ticked');
    assert.equal(wakes.length, count, 'nothing armed after stop()');
    clock.advance(10 * POLL_MS);
    for (const w of wakes) w.fn();
    await settle();
    assert.equal(log.at(-1), `end:${b.id}`, 'a stale wake-up after stop() ticks nothing');
  } finally {
    if (stop !== null) await stop();
    st.mock.restore();
  }
});

test('startPoll: a sink call that throws skips none of the later calls of its tick, a tick whose report failed ends with one reset, and the next store is still ticked', async () => {
  const realSetTimeout = globalThis.setTimeout;
  const wakes: Array<() => void> = [];
  const st = mock.method(globalThis, 'setTimeout', ((fn: () => void, ms?: number) => {
    wakes.push(fn);
    return realSetTimeout(fn, ms);
  }) as unknown as typeof setTimeout);
  let stop: (() => Promise<void>) | null = null;
  try {
    const clock = new VirtualClock();
    const log: string[] = [];
    const [a, b, c] = [1, 2, 3].map((n) => new GateStore(roomIdOf(n), log)) as [GateStore, GateStore, GateStore];
    const sink: string[] = [];
    const throwing = new Set<string>();
    const call = (what: string): void => {
      sink.push(what);
      if (throwing.has(what)) throw new Error('a failing projection');
    };
    stop = startPoll([a, b, c], {
      overlay: (id: string) => call(`overlay:${id}`),
      delta: (d: RoomDelta) => call(`delta:${d.roomId}`),
      roomChanged: (id: string) => call(`room:${id}`),
      reset: () => call('reset'),
    }, clock);
    const pass = async (): Promise<void> => {
      sink.length = 0;
      clock.advance(POLL_MS);
      wakes.at(-1)!();
      await settle();
    };
    // a: a rebuild whose overlay fails (its delta and its own reset still go; no second reset); b: a state change whose delta fails
    // (the room message still goes — else the changed header is never reported again — then one reset); c: reported as usual.
    a.result = { delta: deltaOf({ roomId: a.id }), overlay: { ...OVERLAY, state: 'offline' }, change: 'rebuilt' };
    b.result = { delta: deltaOf({ roomId: b.id }), overlay: { ...OVERLAY, state: 'degraded' }, change: 'state' };
    c.result = { delta: deltaOf({ roomId: c.id }), overlay: null, change: 'state' };
    throwing.add(`overlay:${a.id}`).add(`delta:${b.id}`);
    await pass();
    assert.deepEqual(sink, [
      `overlay:${a.id}`, `delta:${a.id}`, 'reset',
      `overlay:${b.id}`, `delta:${b.id}`, `room:${b.id}`, 'reset',
      `delta:${c.id}`, `room:${c.id}`,
    ]);
    assert.deepEqual(log, [a, b, c].flatMap((s) => [`start:${s.id}`, `end:${s.id}`]), 'every store ticked, one at a time');
    // A reset that fails is tried once more and stops nothing; an overlay that fails on an idle tick still ends with a reset.
    throwing.clear();
    throwing.add('reset').add(`overlay:${b.id}`);
    b.result = { delta: null, overlay: { ...OVERLAY, state: 'ok' }, change: null };
    await pass();
    assert.deepEqual(sink, [
      `overlay:${a.id}`, `delta:${a.id}`, 'reset', 'reset',
      `overlay:${b.id}`, 'reset',
      `delta:${c.id}`, `room:${c.id}`,
    ]);
    // Nothing fails: no reset beyond a rebuild's own.
    throwing.clear();
    await pass();
    assert.deepEqual(sink, [`overlay:${a.id}`, `delta:${a.id}`, 'reset', `overlay:${b.id}`, `delta:${c.id}`, `room:${c.id}`]);
  } finally {
    if (stop !== null) await stop();
    st.mock.restore();
  }
});
