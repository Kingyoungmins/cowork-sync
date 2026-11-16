// Plan 5 Task 7 — the seat-hour budget end to end (CCI-46, CCI-61, 06 §3.16.1): the injected-chars cap trips
// PULL_MODE once (the flag rides the seat's display as SEAT_PULL_MODE with one health event), a suppressed
// family retires as delivered (dropped, not late, never carried) and the seat-hour boundary clears the mode
// (counters reset, one onPullMode(false), suppression lifted). The charge itself is driven by seeded store rows
// (the WHY rider of 06 §3.16.3 is Task 13's); the deny cell pins the T1→T1R shortening and the reason-only
// charge on the composition's real ctx (the gate steps themselves are Task 10's).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finishReply } from '../../src/claude/daemon/carriers.js';
import type { HookRequest, ReplyDraft } from '../../src/claude/daemon/ctx.js';
import { C } from '../../src/claude/wire/constants.js';
import type { FakeSeat } from '../helpers/seatHarness.js';
import { seatHarness, type SeatHarness } from '../helpers/seatHarness.js';

const settle = (ms = 10): Promise<void> => new Promise<void>((r) => { setTimeout(r, ms).unref(); });
const PATH = 'a'.repeat(50);   // one WT_NOTE row renders ≈ 70+ chars; 12 ride a post inside the 1,000 cap

function healthReasons(h: SeatHarness, peer: number): string[] {
  return h.outboxOf(peer).drafts()
    .filter((d) => (d as { type?: string }).type === 'event' && (d as { kind?: string }).kind === 'health')
    .map((d) => String((d as { reason_code?: string }).reason_code));
}

const flagWhys = (h: SeatHarness): string[] =>
  h.trace.events
    .filter((e) => (e as { kind?: string; op?: string }).kind === 'seat' && (e as { op?: string }).op === 'flag')
    .map((e) => String((e as unknown as { why: string }).why));

/** Runs posts (12 seeded rows each, inside the per-reply caps) until PULL_MODE trips; returns the post count. */
async function tripPullMode(h: SeatHarness, fake: FakeSeat, seatId: string): Promise<number> {
  const ctx = h.daemons[0]!.ctx;
  let posts = 0;
  while (!ctx.meter.inPullMode(seatId) && posts < 60) {
    for (let i = 0; i < 12; i++) ctx.events.queueSeatContext(seatId, 'WT_NOTE', { path: PATH });
    await fake.hook('PostToolUse', { tool_use_id: `tu-${posts}` });
    posts++;
  }
  assert.ok(ctx.meter.inPullMode(seatId), `tripped after ${posts} posts`);
  return posts;
}

test('the injected-chars cap trips PULL_MODE once: the display shows SEAT_PULL_MODE with one health event, suppressed rows retire and never ride again', async () => {
  const h = await seatHarness({ peers: 1 });
  try {
    const ctx = h.daemons[0]!.ctx;
    const fake = h.fakeSeat(0);
    await fake.hello();
    await settle();
    const S1 = fake.seatId()!;
    assert.equal(ctx.seats.seatWiring(S1).display, 'FULL');
    await tripPullMode(h, fake, S1);
    assert.ok(ctx.meter.usage(S1).injected > C.INJECTED_CHARS_PER_SEAT_HOUR, `charged: ${ctx.meter.usage(S1).injected}`);
    assert.equal(ctx.seats.seatWiring(S1).display, 'PULL_MODE');
    assert.equal(healthReasons(h, 0).filter((c) => c === 'SEAT_PULL_MODE').length, 1);
    // A suppressed family seeded in PULL_MODE: dropped at compose, retired as delivered (never late, never delivered).
    const [sinceId] = ctx.events.queueSeatContext(S1, 'SINCE_POINTER', { k: 3 });
    const delivered: Array<{ seatId: string; ids: readonly string[] }> = [];
    const off = ctx.events.onDelivered((seatId, ids) => delivered.push({ seatId, ids }));
    const r = await fake.hook('PostToolUse', { tool_use_id: 'tu-x' });
    assert.ok(!r.reply!.text.includes('SINCE_POINTER'), 'suppressed, not carried');
    assert.equal(ctx.events.pending(S1).length, 0, 'retired as delivered, not queued');
    await settle(20);   // the earlier posts' printed frames land on the daemon asynchronously
    assert.ok(!delivered.some((d) => d.ids.includes(sinceId)), 'a retired row is never delivered');
    await fake.hook('PostToolUse', { tool_use_id: 'tu-y' });
    await settle(20);
    assert.ok(!delivered.some((d) => d.ids.includes(sinceId)), 'dropped, never delivered late');
    off();
  } finally {
    await h.cleanup();
  }
});

test('crossing the seat-hour boundary clears PULL_MODE: the counters reset, one onPullMode(false), suppression lifted', async () => {
  const h = await seatHarness({ peers: 1 });
  try {
    const ctx = h.daemons[0]!.ctx;
    const fake = h.fakeSeat(0);
    await fake.hello();
    await settle();
    const S1 = fake.seatId()!;
    await tripPullMode(h, fake, S1);
    assert.deepEqual(flagWhys(h), ['PULL_MODE']);
    await h.advance(C.SEAT_HOUR_MS + 5);
    const u = ctx.meter.usage(S1);   // the first meter call past the boundary rolls the window
    assert.equal(u.injected, 0);
    assert.equal(u.pullMode, false);
    assert.equal(u.windowLeftMs, C.SEAT_HOUR_MS);
    assert.equal(ctx.seats.seatWiring(S1).display, 'FULL');
    assert.deepEqual(flagWhys(h), ['PULL_MODE', 'PULL_MODE'], 'the clear is one flag event');
    const delivered: Array<{ ids: readonly string[] }> = [];
    const off = ctx.events.onDelivered((_s, ids) => delivered.push({ ids }));
    const [evId] = ctx.events.queueSeatContext(S1, 'SINCE_POINTER', { k: 1 });
    const r = await fake.hook('PostToolUse', { tool_use_id: 'tu-z' });
    assert.ok(r.reply!.text.includes('SINCE_POINTER'), 'suppression lifted at the boundary');
    await settle(20);
    assert.deepEqual(delivered.find((d) => d.ids.includes(evId))?.ids ?? [], [evId], 'the carried row is its batch, printed once');   // the core reply's events list is not observable (the stdout reconstruction); the batch is
    off();
  } finally {
    await h.cleanup();
  }
});

test('a deny in PULL_MODE renders the T1R form (≤ 300) and charges only the reason line, on the composition\u2019s real ctx', async () => {
  const h = await seatHarness({ peers: 1 });
  try {
    const ctx = h.daemons[0]!.ctx;
    const fake = h.fakeSeat(0);
    await fake.hello();
    await settle();
    const S1 = fake.seatId()!;
    await tripPullMode(h, fake, S1);
    const before = ctx.meter.usage(S1).injected;
    const r = { frame: { event: 'PreToolUse', h: { agent_id: null }, payload: { event: 'PreToolUse' } }, seat: { seatId: S1 }, startedMono: 0 } as unknown as HookRequest;
    const d: ReplyDraft = { carrier: 'none', items: [], deny: { code: 'HELDREG', params: { path: 'src/a.ts', rid: 'r-1' }, form: 'T1' }, block: null, done: false };
    const rep = finishReply(r, d, ctx);
    assert.equal(rep.decision, 'deny');
    assert.ok(rep.text.startsWith('[cowork-sync] HELDREG'), `the reason's code line: ${JSON.stringify(rep.text)}`);
    assert.ok(rep.text.length <= C.CAPS.T1R, `the T1R form: ${rep.text.length}`);
    assert.equal(rep.events.length, 0, 'a deny carries no store events');
    assert.equal(ctx.meter.usage(S1).injected - before, rep.text.length, 'the reason line is the charged text');
    // The deny queued nothing: a row seeded afterwards rides the seat's next exit-0 reply.
    ctx.events.queueSeatContext(S1, 'WT_NOTE', { path: 'src/b.ts' });
    const r2 = await fake.hook('PostToolUse', { tool_use_id: 'tu-next' });
    assert.ok(r2.reply!.text.includes('WT_NOTE'), 'the rows ride the next exit-0 reply');
  } finally {
    await h.cleanup();
  }
});

test('a status-flap backlog charges only what the first prompt prints: 150 OFFLINE/ONLINE flaps do not trip PULL_MODE', async () => {
  // F2 #6 (06:723, R5-43): a quiet seat's transition backlog is offered whole to its next UserPromptSubmit; the meter
  // counts what that reply prints (the packed lines under the 1,500 / 1,050 caps), not every offered item.
  const h = await seatHarness({ peers: 1 });
  try {
    await h.engines.startAll();
    await h.engines.rounds(2);                                                // the engine has written its status
    const ctx = h.daemons[0]!.ctx;
    const fake = h.fakeSeat(0);
    await fake.hello();
    await settle();
    const S1 = fake.seatId()!;
    await fake.hook('PostToolUse', { tool_use_id: 'tu-0' });                 // Transitions learns the seat
    const base = ctx.engine.lastStatus();
    assert.ok(base !== null, 'the engine has a status to flap from');
    for (let i = 0; i < 150; i++) {
      ctx.transitions.observe({ ...base, publish_pause: 'OFFLINE', message_params: { offline_for_s: 42 } }, 0);
      ctx.transitions.observe({ ...base, publish_pause: null, message_params: {} }, 0);
    }
    const before = ctx.meter.usage(S1).injected;
    const r = await fake.hook('UserPromptSubmit', {});
    assert.equal(ctx.meter.inPullMode(S1), false, `charged ${ctx.meter.usage(S1).injected - before} for a ${r.reply!.text.length + (r.reply!.system?.length ?? 0)}-char reply`);
    assert.equal(ctx.meter.usage(S1).injected - before, r.reply!.text.length + (r.reply!.system?.length ?? 0), 'the charge is the printed reply');
  } finally {
    await h.cleanup();
  }
});
