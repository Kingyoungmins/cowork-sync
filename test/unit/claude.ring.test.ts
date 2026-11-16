// test/unit/claude.ring.test.ts — Task 6's doorbell cells (R5-37, R2-H16 daemon half, Q-8, OQ-02 (r2), CCI-49
// daemon side, V-10/O-2/O-5, A6-7, X-42; 06 test 38's daemon half). A Ringer over a recording send and ctx
// doubles; the registered `ring` ticker drives a RingDriver over the same doubles (runTicker reads the module's
// per-ctx singleton, so each ctx double gets its own driver).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VirtualClock } from '../sim/vclock.js';
import { TraceRecorder } from '../sim/traceRecorder.js';
import { Ringer, RingDriver, mintNonce, neverRing, scriptedRing } from '../../src/claude/daemon/ring.js';
import { runTicker } from '../../src/claude/daemon/pipeline.js';
import { seededRandom, realRandom, randomHex } from '../../src/ports/random.js';
import { NONCE_RE } from '../../src/claude/wire/hookInput.js';
import type { DaemonCtx } from '../../src/claude/daemon/ctx.js';
import type { SessionServerFrame } from '../../src/claude/wire/frames.js';
import type { CsSignal, SeatActivity } from '../../src/holds/signals.js';
import type { Random } from '../../src/ports/random.js';

const S = 's'.repeat(32);
const N1 = 'cws-0123456789abcdef';

function turnState(): Record<string, unknown> {
  return { pending: [], origin: null, promptId: null, recordedPromptId: null, lastHumanPromptMono: null, wakeTurnStartMono: null };
}

interface SeatShape { ended: boolean; activity: SeatActivity; mcpConnected: boolean; turn: Record<string, unknown> }

function ringCtx(o?: { activity?: SeatActivity; mcp?: boolean; pending?: Array<{ id: string; state: string; viaNonce: string | null }>; policy?: never; hangingSleep?: boolean; seenEarly?: boolean }): { ctx: DaemonCtx; clock: VirtualClock; trace: TraceRecorder; frames: SessionServerFrame[]; sends: CsSignal[]; seat: SeatShape; onRingSentCalls: Array<{ nonce: string; ids: readonly string[] }>; doorbellCalls: Array<{ nonce: string; ids: readonly string[] }>; calls: string[] } {
  const clock = new VirtualClock({ startMono: 0 });
  const trace = new TraceRecorder();
  const frames: SessionServerFrame[] = [];
  const sends: CsSignal[] = [];
  const onRingSentCalls: Array<{ nonce: string; ids: readonly string[] }> = [];
  const doorbellCalls: Array<{ nonce: string; ids: readonly string[] }> = [];
  // F2 #61: every TurnOrigin/EventStore member the Ringer calls, in call order (the doubles gain the members the
  // R-F2-17 contract calls: onRingInFlight at send, onRingSent -> the seen-early boolean, onRingFailed, nonceSeen).
  const calls: string[] = [];
  const seat: SeatShape = { ended: false, activity: o?.activity ?? 'IDLE', mcpConnected: o?.mcp ?? true, turn: turnState() };
  const portsClock = o?.hangingSleep === true
    ? ({ monoMs: () => clock.monoMs(), advance: (ms: number) => clock.advance(ms), sleep: (): Promise<void> => new Promise(() => {}) })   // the Ringer's 5 s wait hangs until the test answers
    : clock;
  const ctx = {
    ports: { clock: portsClock, random: seededRandom('ring-seed') },
    trace, seats: { peerId: () => 'peer-1', seats: () => [{ seat_id: S, number: 1, activity: seat.activity, wiring: 'FULL', flags: [], lastHookMono: 0 }], bySeatId: () => seat },
    turns: {
      onRingInFlight: (_s: SeatShape, nonce: string, ids: readonly string[]) => { calls.push(`turns.onRingInFlight ${nonce} ${ids.join(',')}`); },
      onRingSent: (_s: SeatShape, nonce: string, ids: readonly string[]) => { onRingSentCalls.push({ nonce, ids }); calls.push(`turns.onRingSent ${nonce}`); return o?.seenEarly === true; },
      onRingFailed: (_s: SeatShape, nonce: string) => { calls.push(`turns.onRingFailed ${nonce}`); },
    },
    events: {
      pending: () => o?.pending ?? [],
      doorbellSent: (nonce: string, ids: readonly string[]) => { doorbellCalls.push({ nonce, ids }); calls.push(`events.doorbellSent ${nonce} ${ids.join(',')}`); },
      nonceSeen: (nonce: string) => { calls.push(`events.nonceSeen ${nonce}`); return []; },
      onDelivered: () => () => undefined,
    },
    bindings: { wakePolicy: (o?.policy ?? neverRing) as DaemonCtx['bindings']['wakePolicy'] },
    signals: { send: (s: CsSignal) => sends.push(s) },
  } as unknown as DaemonCtx;
  (ctx as { ring: unknown }).ring = new Ringer(ctx, (_seatId, f) => {
    frames.push(f);
    return true;
  });
  return { ctx, clock, trace, frames, sends, seat, onRingSentCalls, doorbellCalls, calls };
}

const flush = (): Promise<void> => new Promise<void>((r) => { setImmediate(r); });
const realDelay = (ms: number): Promise<void> => new Promise<void>((r) => { setTimeout(r, ms).unref(); });

test('mintNonce is cws- plus 16 lowercase hex; NONCE_RE finds it inside a 1,500-char text (07 §3.13, R5-37)', () => {
  const n = mintNonce(seededRandom('n'));
  assert.match(n, /^cws-[0-9a-f]{16}$/);
  assert.equal(n, `cws-${randomHex(seededRandom('n'), 8)}`);
  const drawn = new Set<string>();
  for (let i = 0; i < 10_000; i++) drawn.add(mintNonce(realRandom));
  assert.equal(drawn.size, 10_000);
  const text = 'x'.repeat(1_500 - 21) + ` ${n}`;
  assert.equal(text.length, 1_500);
  assert.deepEqual([...text.matchAll(NONCE_RE)].map((m) => m[0]), [n]);
});

test('ring: no ring to a MID_TURN seat or one without MCP; a slash, oversize or wrong-nonce text is never sent (A6-7)', async () => {
  const a = ringCtx({ activity: 'MID_TURN' });
  assert.equal(await a.ctx.ring.ring(S, ['e1'], `doorbell\nref ${N1}`, N1), 'not_rung');
  assert.equal(a.frames.length, 0);
  const b = ringCtx({ mcp: false });
  assert.equal(await b.ctx.ring.ring(S, ['e1'], `doorbell\nref ${N1}`, N1), 'not_rung');
  const c = ringCtx();
  assert.equal(await c.ctx.ring.ring(S, ['e1'], '/cowork save x', N1), 'error');
  assert.equal(c.frames.length, 0);
  assert.equal(await c.ctx.ring.ring(S, ['e1'], 'y'.repeat(1_501), N1), 'error');
  assert.equal(await c.ctx.ring.ring(S, ['e1'], 'doorbell without the token', N1), 'error');
  assert.equal(await c.ctx.ring.ring(S, ['e1'], `doorbell ${N1} and ${N1}`, N1), 'error');   // twice
  assert.equal(c.frames.length, 0);
});

test('a valid ring sends exactly one frame; a missing ring_result after 5 s is error (A6-7)', async () => {
  const { ctx, clock, frames, trace } = ringCtx();
  const text = `doorbell for e1\nref ${N1}`;
  assert.equal(await ctx.ring.ring(S, ['e1'], text, N1), 'error');   // VirtualClock's sleep advances 5 s at once
  assert.deepEqual(frames, [{ t: 'ring', event_ids: ['e1'], text, nonce: N1 }]);
  assert.deepEqual(trace.events.filter((e) => e.kind === 'ring').map((e) => (e as { result: string }).result), ['error']);
  void clock;
});

test("onResult 'sent' marks the pending wake and doorbell-carried events, each once; refused/error call neither (A6-7)", async () => {
  const { ctx, frames, onRingSentCalls, doorbellCalls, trace } = ringCtx();
  const text = `doorbell\nref ${N1}`;
  const p = ctx.ring.ring(S, ['e1', 'e2'], text, N1);   // not awaited: the clock's 5 s sleep resolves on a microtask
  ctx.ring.onResult(N1, 'sent');
  assert.equal(await p, 'sent');
  assert.equal(frames.length, 1);
  assert.deepEqual(onRingSentCalls, [{ nonce: N1, ids: ['e1', 'e2'] }]);
  assert.deepEqual(doorbellCalls, [{ nonce: N1, ids: ['e1', 'e2'] }]);
  ctx.ring.onResult(N1, 'sent');                        // a second result for a known nonce: ignored
  assert.equal(onRingSentCalls.length, 1);
  const b = ringCtx();
  const pb = b.ctx.ring.ring(S, ['e1'], text, N1);
  b.ctx.ring.onResult(N1, 'refused');
  assert.equal(await pb, 'refused');
  assert.equal(b.onRingSentCalls.length, 0);
  assert.equal(b.doorbellCalls.length, 0);
  const c = ringCtx();
  const pc = c.ctx.ring.ring(S, ['e1'], text, N1);
  c.ctx.ring.onResult('cws-fedcba9876543210', 'sent');  // an unknown nonce is ignored
  assert.equal(c.onRingSentCalls.length, 0);
  c.ctx.ring.onResult(N1, 'error');
  assert.equal(await pc, 'error');
  assert.equal(c.onRingSentCalls.length, 0);
  assert.deepEqual(trace.events.filter((e) => e.kind === 'ring').map((e) => (e as { result: string }).result), ['sent']);
  assert.deepEqual(b.trace.events.filter((e) => e.kind === 'ring').map((e) => (e as { result: string }).result), ['refused']);
  assert.deepEqual(c.trace.events.filter((e) => e.kind === 'ring').map((e) => (e as { result: string }).result), ['error']);
});

test('neverRing never rings; the ticker over 10 virtual minutes sends 0 frames (R5-37)', async () => {
  const { ctx, clock, frames } = ringCtx({ pending: [{ id: 'e1', state: 'pending', viaNonce: null }, { id: 'e2', state: 'pending', viaNonce: null }, { id: 'e3', state: 'pending', viaNonce: null }] });
  for (let i = 0; i < 10; i++) {
    clock.advance(60_000);
    await runTicker('ring', ctx);
  }
  assert.equal(frames.length, 0);
});

test('scriptedRing rings on demand with the nonce the driver minted and passed (V-10/O-2)', async () => {
  let seenNonce: string | null = null;
  const policy = scriptedRing((_s, ids, nonce) => {
    seenNonce = nonce;
    return { text: `doorbell for ${ids.join(',')}\nref ${nonce}` };
  });
  const { ctx, clock, frames } = ringCtx({ pending: [{ id: 'e1', state: 'pending', viaNonce: null }], policy: policy as never });
  clock.advance(1_000);
  await runTicker('ring', ctx);
  assert.ok(seenNonce !== null && /^cws-[0-9a-f]{16}$/.test(seenNonce));
  assert.equal(frames.length, 1);
  assert.equal((frames[0] as { nonce: string }).nonce, seenNonce);   // the frame's nonce is the one the policy saw
  clock.advance(1_000);
  await runTicker('ring', ctx);
  assert.equal(frames.length, 1);                                    // the posted id is never offered again
});

test('coalescing offers the same ids again; a post of any result never repeats; not_rung re-offers (V-10/O-5)', async () => {
  let offers = 0;
  const policy = scriptedRing((_s, _ids, nonce) => {
    offers += 1;
    return offers >= 3 ? { text: `doorbell\nref ${nonce}` } : null;
  });
  const a = ringCtx({ pending: [{ id: 'e1', state: 'pending', viaNonce: null }], policy: policy as never });
  for (let i = 0; i < 3; i++) await runTicker('ring', a.ctx);
  assert.equal(offers, 3);
  assert.equal(a.frames.length, 1);
  // After the post (result 'error' — no ring_result came) the id is never offered again:
  offers = 0;
  await runTicker('ring', a.ctx);
  assert.equal(offers, 0);
  // After 'not_rung' (no MCP) the ids are offered again:
  const b = ringCtx({ mcp: false, pending: [{ id: 'e1', state: 'pending', viaNonce: null }], policy: scriptedRing((_s, _ids, nonce) => ({ text: `doorbell\nref ${nonce}` })) as never });
  await runTicker('ring', b.ctx);
  assert.equal(b.frames.length, 0);
  b.seat.mcpConnected = true;
  await runTicker('ring', b.ctx);
  assert.equal(b.frames.length, 1);
});

test('the driver rings no seat that is MID_TURN, has a pending wake or is in a wake turn (A6-7)', async () => {
  const a = ringCtx({ activity: 'MID_TURN', pending: [{ id: 'e1', state: 'pending', viaNonce: null }], policy: scriptedRing((_s, _ids, nonce) => ({ text: `d\nref ${nonce}` })) as never });
  await runTicker('ring', a.ctx);
  assert.equal(a.frames.length, 0);
  const b = ringCtx({ pending: [{ id: 'e1', state: 'pending', viaNonce: null }], policy: scriptedRing((_s, _ids, nonce) => ({ text: `d\nref ${nonce}` })) as never });
  (b.seat.turn as { pending: unknown[] }).pending = [{ nonce: N1, sentMono: 0, eventIds: ['e1'], fallbackEligible: true, humanPromptSincePost: false }];
  await runTicker('ring', b.ctx);
  assert.equal(b.frames.length, 0);                    // a pending wake → never another doorbell (R1-905 daemon half)
  const c = ringCtx({ pending: [{ id: 'e1', state: 'pending', viaNonce: null }], policy: scriptedRing((_s, _ids, nonce) => ({ text: `d\nref ${nonce}` })) as never });
  (c.seat.turn as { origin: string | null }).origin = 'wake';
  await runTicker('ring', c.ctx);
  assert.equal(c.frames.length, 0);                    // a wake turn never causes another doorbell
});

test('onRingResult receives once per ring, with the offer nonce even for not_rung (X-42, Q-8)', async () => {
  const N = mintNonce(seededRandom('ring-seed'));        // the driver's first mint over the seeded Random
  const got: Array<{ ids: readonly string[]; result: string; nonce: string }> = [];
  const mk = (): never => ({
    shouldRing: (_s: string, _ids: readonly string[], nonce: string) => ({ text: `d\nref ${nonce}` }),
    onRingResult: (_s: string, ids: readonly string[], result: string, nonce: string) => { got.push({ ids, result, nonce }); },
  }) as never;
  const a = ringCtx({ pending: [{ id: 'e1', state: 'pending', viaNonce: null }], policy: mk(), hangingSleep: true });
  const tick = runTicker('ring', a.ctx);                 // hangs at the Ringer's 5 s wait
  a.ctx.ring.onResult(N, 'refused');                     // the scripted ring_result arrives
  await tick;
  await flush();                                         // F2 #67: the tick does not wait for the ring; its settle reports
  assert.deepEqual(got, [{ ids: ['e1'], result: 'refused', nonce: N }]);
  const b = ringCtx({ mcp: false, pending: [{ id: 'e1', state: 'pending', viaNonce: null }], policy: mk() });
  await runTicker('ring', b.ctx);
  await flush();
  assert.deepEqual(got[1], { ids: ['e1'], result: 'not_rung', nonce: N });   // the offer's nonce even for 'not_rung'
  assert.equal(got.length, 2);
  const c = ringCtx({ policy: scriptedRing((_s, _ids, _n) => null) as never });   // no offer → the policy is never asked
  await runTicker('ring', c.ctx);
  assert.equal(got.length, 2);
});

// ---- F2 wave (t6-signals): the in-flight wake (R-F2-17), per-ctx drivers, a ticker that never waits, bounded records

test("the Ringer registers the in-flight wake when the frame is sent; a late 'sent' for a nonce already seen marks the events doorbell-carried, then seen (F2 #61)", async () => {
  const text = `doorbell\nref ${N1}`;
  const a = ringCtx({ seenEarly: true });
  const pa = a.ctx.ring.ring(S, ['e1', 'e2'], text, N1);
  assert.deepEqual(a.calls, [`turns.onRingInFlight ${N1} e1,e2`]);   // at send, before any ring_result
  a.ctx.ring.onResult(N1, 'sent');
  assert.equal(await pa, 'sent');
  assert.deepEqual(a.calls, [`turns.onRingInFlight ${N1} e1,e2`, `turns.onRingSent ${N1}`, `events.doorbellSent ${N1} e1,e2`, `events.nonceSeen ${N1}`]);
  const b = ringCtx({ seenEarly: false });
  const pb = b.ctx.ring.ring(S, ['e1'], text, N1);
  b.ctx.ring.onResult(N1, 'sent');
  assert.equal(await pb, 'sent');
  assert.deepEqual(b.calls, [`turns.onRingInFlight ${N1} e1`, `turns.onRingSent ${N1}`, `events.doorbellSent ${N1} e1`]);   // no nonceSeen
  for (const result of ['refused', 'error'] as const) {
    const c = ringCtx();
    const pc = c.ctx.ring.ring(S, ['e1'], text, N1);
    c.ctx.ring.onResult(N1, result);
    assert.equal(await pc, result);
    assert.deepEqual(c.calls, [`turns.onRingInFlight ${N1} e1`, `turns.onRingFailed ${N1}`], result);   // neither events call
  }
  const d = ringCtx();                                     // the 5 s wait elapses with no ring_result (VirtualClock)
  assert.equal(await d.ctx.ring.ring(S, ['e1'], text, N1), 'error');
  assert.deepEqual(d.calls, [`turns.onRingInFlight ${N1} e1`, `turns.onRingFailed ${N1}`]);
});

test('two daemon ctxs ticking alternately never re-offer a posted id (F2 #63, V-10/O-5)', async () => {
  const asked = [0, 0];
  const mk = (i: number): never => scriptedRing((_s, _ids, nonce) => { asked[i] = (asked[i] ?? 0) + 1; return { text: `d\nref ${nonce}` }; }) as never;
  const a = ringCtx({ pending: [{ id: 'e1', state: 'pending', viaNonce: null }], policy: mk(0) });
  const b = ringCtx({ pending: [{ id: 'e1', state: 'pending', viaNonce: null }], policy: mk(1) });
  for (let i = 0; i < 10; i++) {
    await runTicker('ring', a.ctx);
    await flush();
    await runTicker('ring', b.ctx);
    await flush();
  }
  assert.equal(a.frames.filter((f) => f.t === 'ring').length, 1);
  assert.equal(b.frames.filter((f) => f.t === 'ring').length, 1);
  assert.deepEqual(asked, [1, 1]);
});

test('the ring ticker returns without waiting for the ring_result; the result is reported once when it arrives (F2 #67)', async () => {
  let asked = 0;
  const got: Array<{ result: string; nonce: string }> = [];
  const policy = {
    shouldRing: (_s: string, _ids: readonly string[], nonce: string) => { asked += 1; return { text: `d\nref ${nonce}` }; },
    onRingResult: (_s: string, _ids: readonly string[], result: string, nonce: string) => { got.push({ result, nonce }); },
  };
  const a = ringCtx({ pending: [{ id: 'e1', state: 'pending', viaNonce: null }], policy: policy as never, hangingSleep: true });
  const first = await Promise.race([runTicker('ring', a.ctx).then(() => 'returned'), realDelay(200).then(() => 'blocked')]);
  assert.equal(first, 'returned');                       // the 1 s housekeeping run is not held by the 5 s wait
  assert.equal(a.frames.length, 1);
  const nonce = (a.frames[0] as { nonce: string }).nonce;
  await runTicker('ring', a.ctx);                        // the result is still outstanding
  assert.equal(a.frames.length, 1);
  assert.equal(asked, 1);
  a.ctx.ring.onResult(nonce, 'refused');
  await flush();
  assert.deepEqual(got, [{ result: 'refused', nonce }]);
  await runTicker('ring', a.ctx);                        // a posted id is never offered again
  await flush();
  assert.equal(asked, 1);
  assert.equal(a.frames.length, 1);
  assert.equal(got.length, 1);
});

test('the never-offer-again record goes with its seat (F2 #72)', async () => {
  const clock = new VirtualClock({ startMono: 0 });
  type Row = { seat_id: string; ended: boolean; pending: string[] };
  const rows: Row[] = [];
  const asked: string[] = [];
  const frames: SessionServerFrame[] = [];
  const shape = (r: Row): SeatShape & { seatId: string } => ({ seatId: r.seat_id, ended: r.ended, activity: r.ended ? 'ENDED' : 'IDLE', mcpConnected: true, turn: turnState() });
  const ctx = {
    ports: { clock, random: seededRandom('ring-72') }, trace: new TraceRecorder(),
    seats: {
      peerId: () => 'peer-1',
      seats: () => rows.map((r) => ({ seat_id: r.seat_id, number: 1, activity: r.ended ? 'ENDED' : 'IDLE', wiring: 'FULL', flags: [], lastHookMono: 0 })),
      bySeatId: (id: string) => { const r = rows.find((x) => x.seat_id === id); return r === undefined ? null : shape(r); },
    },
    turns: { onRingInFlight: () => undefined, onRingSent: () => false, onRingFailed: () => undefined },
    events: {
      pending: (id: string) => (rows.find((x) => x.seat_id === id)?.pending ?? []).map((e) => ({ id: e, state: 'pending', viaNonce: null })),
      doorbellSent: () => undefined, nonceSeen: () => [], onDelivered: () => () => undefined,
    },
    bindings: { wakePolicy: neverRing },
  } as unknown as DaemonCtx;
  const policy = scriptedRing((seatId, _ids, nonce) => { asked.push(seatId); return { text: `d\nref ${nonce}` }; });
  const ringer = new Ringer(ctx, (_id, f) => { frames.push(f); return true; });
  const driver = new RingDriver(ctx, policy, ringer);
  const live: Row = { seat_id: 'f'.repeat(32), ended: false, pending: ['live-e'] };
  rows.push(live);
  for (let i = 0; i < 1_000; i++) {
    const r: Row = { seat_id: i.toString(16).padStart(32, '0'), ended: false, pending: [`e${i}`] };
    rows.push(r);
    await driver.tick();                                 // rings r (and the live seat once, at the first tick)
    await flush();
    r.ended = true;                                      // the seat ends after its post ('error': no ring_result)
  }
  await driver.tick();
  await flush();
  const sizes = (driver as unknown as { sizesForTest(): { ids: number } }).sizesForTest();
  assert.ok(sizes.ids <= 1, `remembered ids ${sizes.ids}`);   // only the live seat's posted id is left
  assert.equal(asked.filter((s) => s === live.seat_id).length, 1);   // O-5: the live seat's posted id is never offered again
  assert.equal(frames.length, 1_001);
});

test('a delivered id leaves the never-offer-again record; a posted id never delivered stays never offered again (F2 #72, O-5)', async () => {
  const clock = new VirtualClock({ startMono: 0 });
  const seatId = 'e'.repeat(32);
  let pending: string[] = ['e1', 'e2'];
  const asked: Array<readonly string[]> = [];
  const frames: SessionServerFrame[] = [];
  let delivered: ((seat: string, ids: readonly string[]) => void) | null = null;
  const ctx = {
    ports: { clock, random: seededRandom('ring-72-delivered') }, trace: new TraceRecorder(),
    seats: {
      peerId: () => 'peer-1',
      seats: () => [{ seat_id: seatId, number: 1, activity: 'IDLE', wiring: 'FULL', flags: [], lastHookMono: 0 }],
      bySeatId: () => ({ seatId, ended: false, activity: 'IDLE', mcpConnected: true, turn: turnState() }),
    },
    turns: { onRingInFlight: () => undefined, onRingSent: () => false, onRingFailed: () => undefined },
    events: {
      pending: () => pending.map((e) => ({ id: e, state: 'pending', viaNonce: null })),
      doorbellSent: () => undefined, nonceSeen: () => [],
      onDelivered: (f: (seat: string, ids: readonly string[]) => void) => { delivered = f; return () => undefined; },
    },
    bindings: { wakePolicy: neverRing },
  } as unknown as DaemonCtx;
  const policy = scriptedRing((_s, ids, nonce) => { asked.push([...ids]); return { text: `d\nref ${nonce}` }; });
  const ringer = new Ringer(ctx, (_id, f) => { frames.push(f); return true; });
  const driver = new RingDriver(ctx, policy, ringer);
  const sizes = (): number => (driver as unknown as { sizesForTest(): { ids: number } }).sizesForTest().ids;
  await driver.tick();                                   // rings e1, e2
  assert.equal(frames.length, 1);
  ringer.onResult((frames[0] as { nonce: string }).nonce, 'sent');
  await flush();
  assert.equal(sizes(), 2);                              // both rode the post
  assert.ok(delivered !== null, 'the driver subscribed to EventStore.onDelivered');
  (delivered as (seat: string, ids: readonly string[]) => void)(seatId, ['e1']);   // e1 delivered; e2 only in a batch
  assert.equal(sizes(), 1);                              // the delivered id is pruned
  pending = ['e2', 'e3'];                                // e2 back to pending (its batch never printed), e3 new
  await driver.tick();
  assert.equal(frames.length, 2);
  assert.deepEqual(asked, [['e1', 'e2'], ['e3']]);       // O-5: e2 (posted, never delivered) is never offered again
});
