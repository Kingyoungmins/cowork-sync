// Plan 5 Task 7 — the nudge end to end: the engine half raises CS_UNPUBLISHED_NUDGE once per open seat CS 300 s
// after its oldest uncovered file effect (the reference cell's recipe; every code reaches the daemon log, R-27)
// and the daemon half routes it by the CS id's seat segment (32 hex) to the store, the seat's next post carries
// it once, a double raise is a no-op, and under PULL_MODE the row retires as delivered (dropped, never late).
// The degraded-rung status display of the code is Plan 3 Task 12a's (holdStatusInputs). Task 8's pipe is live: the
// engine's raise reaches routeHoldCode through core.onHoldCode (the daemon's attach wiring), so test 1 drives the
// wired end to end while test 2 drives routeHoldCode directly on a fresh CS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeHoldCode } from '../../src/claude/daemon/events.js';
import { logOf } from '../helpers/engineFixture.js';
import { writeWork } from '../helpers/coreFixture.js';
import { seatHarness, type SeatHarness } from '../helpers/seatHarness.js';
import type { DaemonCtx } from '../../src/claude/daemon/ctx.js';

/** Waits for a condition with only a generous cap (F2 #27): a slow PC waits longer, it never fails early. */
async function waitFor(cond: () => boolean, what: string, capMs = 30_000): Promise<void> {
  const end = Date.now() + capMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`waitFor timed out after ${capMs} ms: ${what}`);
    await new Promise<void>((r) => { setTimeout(r, 5).unref(); });
  }
}
/** The previous reply's printed has landed (server.ts handles printed fire-and-forget on the hook connection). */
const untilPrinted = (ctx: DaemonCtx): Promise<void> => waitFor(() => ctx.events.sizes().unprinted === 0, 'the reply batch was printed');
const PATH = 'a'.repeat(50);   // one WT_NOTE row renders ≈ 70+ chars; 12 ride a post inside the 1,000 cap

/** Runs posts (12 seeded rows each) until PULL_MODE trips. */
async function tripPullMode(h: SeatHarness, fake: ReturnType<SeatHarness['fakeSeat']>, seatId: string, firstId: string): Promise<void> {
  const ctx = h.daemons[0]!.ctx;
  let posts = 0;
  while (!ctx.meter.inPullMode(seatId) && posts < 60) {
    for (let i = 0; i < 12; i++) ctx.events.queueSeatContext(seatId, 'WT_NOTE', { path: PATH });
    await fake.hook('PostToolUse', { tool_use_id: `${firstId}-${posts}` });
    posts++;
  }
  assert.equal(ctx.meter.inPullMode(seatId), true, `tripped after ${posts} posts`);
}

test('timerStep raises CS_UNPUBLISHED_NUDGE once per open seat CS 300 s after its oldest uncovered effect, and routeHoldCode posts it to the seat segment once', async () => {
  const h = await seatHarness({ peers: 1, humanLeaseMin: 0 });
  try {
    await h.engines.startAll();
    const p = h.engines.peers[0]!;
    const log = logOf(p);
    const seat = h.fakeSeat(0);
    await seat.hello();
    await waitFor(() => seat.seatId() !== null && h.daemons[0]!.ctx.seats.bySeatId(seat.seatId()!) !== null, 'hello bound the seat');
    const S1 = seat.seatId()!;
    // The uncovered effect: the daemon's own pump (A6-4) opens the seat CS live; it stays open (no Stop).
    await writeWork(p, 'src/a.ts', 'a = 1\n');
    h.daemons[0]!.ctx.signals.send({ kind: 'effect', seat: S1, agent: null, toolUseId: 'tu1', paths: ['src/a.ts'], turnOrigin: 'prompt' });
    await waitFor(() => p.core.cs.table().cs.some((e) => e.seat === S1 && e.state === 'open'), 'the seat CS is open');
    const csId = p.core.cs.table().cs.find((e) => e.seat === S1 && e.state === 'open')!.cs_id;
    const nudges = (): Array<Record<string, unknown>> =>
      log.lines.filter((l) => l.code === 'CS_UNPUBLISHED_NUDGE').map((l) => l.params);
    // 290 s: nothing; past 300 s: exactly one raise — the engine's own mem.nudged keeps the double silent.
    await h.engines.rounds(29, 10_000);
    assert.deepEqual(nudges(), [], 'not before 300 s');
    await h.engines.rounds(2, 10_000);
    const seen = nudges();
    assert.equal(seen.length, 1, 'one raise');
    assert.equal(String(seen[0]!['cs']), csId, 'the raise names the CS');
    await h.engines.rounds(4, 10_000);
    assert.equal(nudges().length, 1, 'the double raises nothing');
    // The daemon half on the composition's real ctx, through Task 8's own wiring: the engine's raise was routed at
    // raise time by core.onHoldCode → routeHoldCode, so the nudge row is already in the seat's store and the next
    // post carries it once; re-driving the raise routes nothing (once per CS).
    const ctx = h.daemons[0]!.ctx;
    const r = await seat.hook('PostToolUse', { tool_use_id: 'tu2' });
    assert.ok(r.reply!.text.includes('CS_UNPUBLISHED_NUDGE'), `the nudge line: ${JSON.stringify(r.reply!.text)}`);
    assert.deepEqual(ctx.events.pending(S1), [], 'posted, not queued');
    const second = routeHoldCode({ code: 'CS_UNPUBLISHED_NUDGE', params: { cs: csId, n: 1 } }, ctx);
    assert.deepEqual(second, [], 'once per CS');
  } finally {
    await h.cleanup();
  }
});

test('under PULL_MODE the nudge row retires as delivered: dropped at compose, never queued, never carried late', async () => {
  const h = await seatHarness({ peers: 1, humanLeaseMin: 0 });
  try {
    const ctx = h.daemons[0]!.ctx;
    const seat = h.fakeSeat(0);
    await seat.hello();
    await waitFor(() => seat.seatId() !== null && ctx.seats.bySeatId(seat.seatId()!) !== null, 'hello bound the seat');
    const S1 = seat.seatId()!;
    await tripPullMode(h, seat, S1, 'wt');
    const [nudgeId] = routeHoldCode({ code: 'CS_UNPUBLISHED_NUDGE', params: { cs: `${S1}/x1`, n: 1 } }, ctx);
    assert.ok(nudgeId !== undefined, 'a fresh CS still posts into the store');
    const r = await seat.hook('PostToolUse', { tool_use_id: 'wt-last' });
    assert.ok(!r.reply!.text.includes('CS_UNPUBLISHED_NUDGE'), 'the nudge row is suppressed, not carried');
    assert.deepEqual(ctx.events.pending(S1), [], 'retired as delivered, not queued');
    await untilPrinted(ctx);
    const r2 = await seat.hook('PostToolUse', { tool_use_id: 'wt-after' });
    assert.ok(!r2.reply!.text.includes('CS_UNPUBLISHED_NUDGE'), 'dropped, never delivered late');
  } finally {
    await h.cleanup();
  }
});
