// test/integration/claude.ring.test.ts — the doorbell end to end over the real daemon (06 test 38's daemon half):
// the registered ring ticker over the daemon's own ctx composes the ring through the scripted policy (the nonce
// minted before the ask rides the text), the fake seat's MCP answers per its script, and a 'sent' marks the
// pending wake and the doorbell-carried events; the nonce UPS then opens the wake turn; a posted id is never
// offered again. F2 (t6-signals): the nonce UPS that beats ring_result 'sent' (R-F2-17), the housekeeping run that
// never waits for a ring_result (F2 #67), and TC-COO-14's Plan 5 half (plan 2828).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seatHarness, type SeatHarness } from '../helpers/seatHarness.js';
import { scriptedRing } from '../../src/claude/daemon/ring.js';
import { runTicker } from '../../src/claude/daemon/pipeline.js';
import type { SeatEvent } from '../../src/claude/daemon/events.js';

const SOCKET = 'c1c0-ring';

/** The Task 7 stub replaced: pending answers this test's rows; doorbellSent records; nonceSeen mimics the real store
 *  (an id only after doorbellSent named it, each id at most once) and records every call; onDelivered answers an
 *  unsubscribe (the RingDriver subscribes once, F2 #72); the neutral members stay neutral. */
class EventsDouble {
  readonly doorbell: Array<{ nonce: string; ids: string[] }> = [];
  readonly seen: Array<{ nonce: string; ids: readonly string[] }> = [];
  private readonly delivered = new Set<string>();
  private batches = 0;
  constructor(private readonly rows: SeatEvent[]) {}
  pending(seatId: string): readonly SeatEvent[] { return this.rows.filter((r) => r.seatId === seatId && r.state === 'pending'); }
  doorbellSent(nonce: string, ids: readonly string[]): void { this.doorbell.push({ nonce, ids: [...ids] }); }
  nonceSeen(n: string): readonly string[] {
    const named = this.doorbell.filter((d) => d.nonce === n).flatMap((d) => d.ids);
    const out = named.filter((id) => !this.delivered.has(id));
    for (const id of out) this.delivered.add(id);
    this.seen.push({ nonce: n, ids: out });
    return out;
  }
  queueSeatContext(): string[] { return []; }
  printed(_b: string): void {}
  nextHook(_s: string): void {}
  add(): string[] { throw new Error('not in this test'); }
  addFirst(): string { throw new Error('not in this test'); }
  queueSystemMessage(): string[] { throw new Error('not in this test'); }
  batch(_seatId: string, _ids: readonly string[]): string { return `b${this.batches++}`; }
  cursor(_seatId: string): number { return 0; }
  retire(_ids: readonly string[]): void {}
  onDelivered(): () => void { return () => undefined; }
}

const row = (seatId: string, id: string): SeatEvent =>
  ({ id, seatId, code: 'SOME_EVENT', params: {}, family: 'fam', mandatory: false, slot: 'context', createdMono: 0, state: 'pending', viaNonce: null, carriers: null });

const settle = (ms: number): Promise<void> => new Promise<void>((r) => { setTimeout(r, ms).unref(); });

test('the ring ticker rings through the scripted policy, the MCP answers sent, the wake is marked and the nonce UPS opens the wake turn', async () => {
  const rows: SeatEvent[] = [];
  const events = new EventsDouble(rows);
  const h = await seatHarness({
    peers: 1, humanLeaseMin: 0,
    bindings: { wakePolicy: scriptedRing((_s, ids, nonce) => ({ text: `doorbell for ${ids.join(',')}\nref ${nonce}` })) },
    ctx: { events: events as never },
  });
  try {
    const daemon = h.daemons[0]!;
    const seat = h.fakeSeat(0, { socketValue: SOCKET });
    seat.mcpScript(['sent']);
    await seat.hello();
    await settle(100);                                          // the pipe binds the seat id
    const daemonSeat = daemon.ctx.seats.bySeatId(seat.seatId()!);
    assert.ok(daemonSeat !== null);
    rows.push(row(seat.seatId()!, 'e1'));                       // the store holds the bound seat's event
    const t = runTicker('ring', daemon.ctx);
    const deadline = Date.now() + 10_000;
    while (events.doorbell.length === 0 && Date.now() < deadline) await settle(20);   // 'sent' arrived (R-F2-17: the wake is pending from the send)
    assert.equal(daemonSeat.turn.pending.length, 1);          // 'sent' marked the pending wake
    const pending = daemonSeat.turn.pending[0]!;
    assert.match(pending.nonce, /^cws-[0-9a-f]{16}$/);         // the driver's minted nonce (V-10/O-2)
    assert.deepEqual(pending.eventIds, ['e1']);
    assert.equal(pending.fallbackEligible, true);
    assert.deepEqual(events.doorbell, [{ nonce: pending.nonce, ids: ['e1'] }]);
    const frame = seat.frames().find((f) => f.t === 'ring');
    assert.ok(frame !== undefined);
    assert.equal((frame as { nonce: string }).nonce, pending.nonce);
    assert.ok((frame as { text: string }).text.endsWith(`ref ${pending.nonce}`));
    h.advance(6_000);                                          // release the (already answered) 5 s wait
    await settle(50);
    await t;
    await runTicker('ring', daemon.ctx);                       // a posted id is never offered again
    assert.equal(seat.frames().filter((f) => f.t === 'ring').length, 1);
    // The nonce UPS opens the wake turn (rule (a)).
    await seat.hook('UserPromptSubmit', { prompt: `doorbell for e1\nref ${pending.nonce}`, prompt_id: 'p1' });
    assert.equal(daemonSeat.turn.origin, 'wake');
    assert.equal(daemonSeat.turn.pending.length, 0);
    assert.equal(daemonSeat.turn.lastHumanPromptMono, null);
  } finally {
    await h.cleanup();
  }
});

async function ringHarness(events: EventsDouble): Promise<SeatHarness> {
  return seatHarness({
    peers: 1, humanLeaseMin: 0,
    bindings: { wakePolicy: scriptedRing((_s, ids, nonce) => ({ text: `doorbell for ${ids.join(',')}\nref ${nonce}` })) },
    ctx: { events: events as never },
  });
}

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await settle(20);
  assert.ok(cond(), `timed out waiting for ${what}`);
}

test("a nonce UserPromptSubmit that beats ring_result 'sent' opens the wake turn, its events are delivered once and no pending wake is left (F2 #61)", async () => {
  const rows: SeatEvent[] = [];
  const events = new EventsDouble(rows);
  const h = await ringHarness(events);
  try {
    const daemon = h.daemons[0]!;
    const seat = h.fakeSeat(0, { socketValue: `${SOCKET}-race` });
    seat.mcpScript(['silent']);                                // no automatic ring_result: the test sends it late
    await seat.hello();
    await settle(100);
    const S = seat.seatId()!;
    const daemonSeat = daemon.ctx.seats.bySeatId(S);
    assert.ok(daemonSeat !== null);
    rows.push(row(S, 'e1'));
    void runTicker('ring', daemon.ctx);                        // not awaited: the ring waits for its result
    await until(() => seat.frames().some((f) => f.t === 'ring'), 'the ring frame');
    const nonce = (seat.frames().find((f) => f.t === 'ring') as { nonce: string }).nonce;
    // The injected prompt's UserPromptSubmit reaches the daemon before ring_result (06 §3.12.2 MEASURED).
    await seat.hook('UserPromptSubmit', { prompt: `doorbell for e1\nref ${nonce}`, prompt_id: 'p2' });
    assert.equal(daemonSeat.turn.origin, 'wake');
    assert.equal(daemonSeat.turn.promptId, 'p2');
    await seat.sendSession({ t: 'ring_result', nonce, result: 'sent' });
    await until(() => events.doorbell.length > 0, 'doorbellSent');
    assert.equal(daemonSeat.turn.pending.length, 0);          // the late 'sent' left no pending wake
    assert.deepEqual(events.seen.flatMap((x) => x.ids), ['e1']);   // delivered exactly once over all nonceSeen calls
    await seat.hook('Stop', { prompt_id: 'p2' });
    await seat.hook('UserPromptSubmit', { prompt: 'my own turn', prompt_id: 'p3' });
    assert.equal(daemon.ctx.turns.originOf(S), 'prompt');      // the human's next turn is not blocked or woken
    assert.equal(daemonSeat.turn.origin, 'human');
  } finally {
    await h.cleanup();
  }
});

test('the 1 s housekeeping keeps running while a ring waits for its result (F2 #67)', async () => {
  const rows: SeatEvent[] = [];
  const events = new EventsDouble(rows);
  const h = await ringHarness(events);
  try {
    const daemon = h.daemons[0]!;
    const seat = h.fakeSeat(0, { socketValue: `${SOCKET}-housekeeping` });
    seat.mcpScript(['silent']);                                // the ring waits its full 5 s for a result
    await seat.hello();
    await settle(100);
    const S = seat.seatId()!;
    const leases = daemon.ctx.leases as unknown as { expire(): void };
    const expire = leases.expire.bind(leases);
    let calls = 0;
    leases.expire = (): void => { calls += 1; expire(); };    // the `leases` ticker's call (claudeDaemon.ts:262)
    rows.push(row(S, 'e1'));
    for (let i = 0; i < 5 && !seat.frames().some((f) => f.t === 'ring'); i++) {
      await h.advance(1_000);                                 // the armed 1 s loop (realScheduler) runs on real timers
      await settle(1_100);
    }
    assert.ok(seat.frames().some((f) => f.t === 'ring'), 'the loop rang the seat');
    const atRing = calls;
    for (let i = 0; i < 4; i++) {                             // 4 s of virtual time: still inside the 5 s result wait
      await h.advance(1_000);
      await settle(1_100);
    }
    assert.ok(calls - atRing >= 3, `leases.expire ran ${calls - atRing} times while the ring waited`);
    assert.equal(seat.frames().filter((f) => f.t === 'ring').length, 1);   // the in-flight seat is not rung again
  } finally {
    await h.cleanup();
  }
});

test('TC-COO-14 Plan 5 half: a sent doorbell to an idle seat is delivered only by the nonce prompt, which opens a wake turn without refreshing the last human prompt (plan 2828)', async () => {
  const rows: SeatEvent[] = [];
  const events = new EventsDouble(rows);
  const h = await ringHarness(events);
  try {
    const daemon = h.daemons[0]!;
    const seat = h.fakeSeat(0, { socketValue: `${SOCKET}-coo14` });
    seat.mcpScript(['sent']);
    await seat.hello();
    await settle(100);
    const S = seat.seatId()!;
    const daemonSeat = daemon.ctx.seats.bySeatId(S);
    assert.ok(daemonSeat !== null);
    rows.push(row(S, 'e1'));
    void runTicker('ring', daemon.ctx);
    await until(() => events.doorbell.length > 0, "the 'sent' doorbell");
    const nonce = events.doorbell[0]!.nonce;
    assert.deepEqual(events.pending(S).map((e) => e.id), ['e1']);   // 'sent' is not delivery: still in the pull queue
    assert.equal(events.seen.length, 0);                              // no nonceSeen yet
    await seat.hook('UserPromptSubmit', { prompt: `doorbell for e1\nref ${nonce}`, prompt_id: 'p1' });
    assert.deepEqual(events.seen.map((x) => x.nonce), [nonce]);     // nonceSeen(nonce) once
    assert.deepEqual(events.seen.flatMap((x) => x.ids), ['e1']);
    assert.equal(daemonSeat.turn.origin, 'wake');
    assert.equal(daemonSeat.turn.lastHumanPromptMono, null);        // unchanged by the nonce prompt
    await seat.hook('Stop', { prompt_id: 'p1' });
    await seat.hook('UserPromptSubmit', { prompt: 'my own turn', prompt_id: 'p2' });
    assert.equal(daemonSeat.turn.origin, 'human');
    assert.ok(daemonSeat.turn.lastHumanPromptMono !== null);        // the next human prompt refreshes it
  } finally {
    await h.cleanup();
  }
});
