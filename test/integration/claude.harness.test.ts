// Plan 5 Task 5 phase 3a-2 — the harness cells (contract 2763…2765; A5-9, A5-12, A5-14, R5-62).
// The status-write → transitions.observe cell and the meter→setFlag cell ride Task 7 (decisions 7-7 and
// the stub policy: BudgetMeter's members are Task 7's), not faked here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seatHarness, type SeatHarness } from '../helpers/seatHarness.js';
import { LeaseTable } from '../../src/claude/daemon/leases.js';
import { TraceRecorder } from '../sim/traceRecorder.js';
import { PLUGIN_VERSION } from '../../src/version.js';
import { HOOK_PROTO } from '../../src/claude/wire/frames.js';

const MIN = 60_000;

async function withHarness<T>(fn: (h: SeatHarness) => Promise<T>, o?: Parameters<typeof seatHarness>[0]): Promise<T> {
  const h = await seatHarness(o);
  try {
    return await fn(h);
  } finally {
    await h.cleanup();
  }
}

test('seatHarness grants a 480-min human lease by default and none with humanLeaseMin: 0 (R5-62)', async () => {
  await withHarness(async (h) => {
    await h.advance(31 * MIN);
    assert.equal(h.daemons[0]!.ctx.seatLease.idleMs(), 0);      // no seat, the 480-min human lease still valid
  }, { peers: 1 });
  await withHarness(async (h) => {
    await h.advance(1_000);
    assert.ok(h.daemons[0]!.ctx.seatLease.idleMs() > 0);        // idle from the start (contract 2765): no lease ever held it
  }, { peers: 1, humanLeaseMin: 0 });
});

test('pluginVersion and hookProto reach VersionPolicy (A5-14)', async () => {
  await withHarness(async (h) => {
    assert.equal(h.daemons[0]!.ctx.versions.judge('0.6.0', 3), 'serve');
    assert.equal(PLUGIN_VERSION !== undefined && HOOK_PROTO !== undefined, true);
  }, { peers: 1, pluginVersion: '0.6.0', hookProto: 3 });
});

test('seatHarness({ctx}) passes the doubles through to every peer daemon (A5-12)', async () => {
  await withHarness(async (h) => {
    const L = new LeaseTable(h.daemons[0]!.ctx.ports.clock, new TraceRecorder(), h.daemons[0]!.ctx.reads);
    const h2 = await seatHarness({ peers: 2, ctx: { leases: L } });
    try {
      assert.equal(h2.daemons[0]!.ctx.leases, L);
      assert.equal(h2.daemons[1]!.ctx.leases, L);
    } finally {
      await h2.cleanup();
    }
  }, { peers: 2 });
});

test('the harness wires the engine lease to its daemon and answers a hook end to end', async () => {
  await withHarness(async (h) => {
    const seat = h.fakeSeat(0);
    await seat.hello();                                          // bind the seat id (seats() lists bound seats only)
    const r = await seat.hook('SessionStart', { source: 'startup' });
    assert.equal(r.exit, 0);                                     // exit 0, the hook answered
    // Task 7: the carrier.context step rides the bound seat's STANDING_RULES line (decision 'context'), not
    // Task 5's minimal 'none' reply any more.
    assert.ok(r.reply !== null && r.reply.decision === 'context');
    assert.ok(r.reply.text.includes('STANDING_RULES'), `the rules line: ${JSON.stringify(r.reply.text)}`);
    assert.equal(h.daemons[0]!.ctx.seats.seats().length, 1);     // the hello registered and bound the seat
  }, { peers: 1, humanLeaseMin: 0 });
});
