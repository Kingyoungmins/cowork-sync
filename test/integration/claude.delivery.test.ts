// Plan 5 Task 7 — delivery end to end (V-10, A7-3; glossary §25.2 item 9; 06 test 25's printed half).
// Pull delivery: an event rides its carrier and is delivered only on printed{batch_id}; an un-printed batch
// re-queues in full at the next hook with the same ids; the shared ('all') system event materializes one copy
// per live seat; onDelivered fires exactly once per event. The direct-mode hook is the hand-built frame whose
// client never sends printed (the killed-hook model — the kill switch's core-path cell drives runCore with
// COWORK_TEST_KILL_BEFORE_PRINTED, whose stop is right after the flush).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seatHarness, type SeatHarness } from '../helpers/seatHarness.js';
import type { CarrierKind } from '../../src/claude/daemon/carriers.js';

type Delivered = { seatId: string; ids: readonly string[]; how: { carrier: CarrierKind | 'doorbell'; batchId: string | null; nonce: string | null } };

async function withHarness<T>(fn: (h: SeatHarness) => Promise<T>): Promise<T> {
  const h = await seatHarness({ peers: 1 });
  try {
    return await fn(h);
  } finally {
    await h.cleanup();
  }
}

test('printed{batch_id} delivers exactly once; nothing is delivered before it and a repeated printed delivers nothing more', async () => {
  await withHarness(async (h) => {
    const ctx = h.daemons[0]!.ctx;
    const seat = h.fakeSeat(0, { mode: 'direct' });
    await seat.hello();
    const S1 = seat.seatId()!;
    const [evId] = ctx.events.queueSeatContext(S1, 'WT_NOTE', { path: 'src/a.ts' });
    const delivered: Delivered[] = [];
    const off = ctx.events.onDelivered((seatId, ids, how) => delivered.push({ seatId, ids, how }));
    // The seat's first PostToolUse is the pull post carrier: the pending row rides the reply, un-printed.
    const r1 = await seat.hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'tu1', path: 'src/a.ts', exit_status: 0 });
    assert.ok(r1.reply !== null && r1.reply.decision === 'context');
    assert.ok(r1.reply.text.includes('[cowork-sync] WT_NOTE'));
    assert.deepEqual(r1.reply.events, [evId]);
    assert.ok(r1.reply.batch_id !== '');
    assert.equal(delivered.length, 0, 'nothing is delivered before printed');
    // The client confirms on the same connection (hookCore step 6): the store marks the row and fires onDelivered.
    ctx.events.printed(r1.reply.batch_id);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]!.seatId, S1);
    assert.deepEqual(delivered[0]!.ids, [evId]);
    assert.equal(delivered[0]!.how.batchId, r1.reply.batch_id);
    assert.equal(delivered[0]!.how.carrier, 'post');
    assert.equal(ctx.events.pending(S1).length, 0);
    // A repeated printed delivers nothing more; the next post carries nothing.
    ctx.events.printed(r1.reply.batch_id);
    const r2 = await seat.hook('PostToolUse', { tool_use_id: 'tu2' });
    assert.equal(r2.reply!.text, '');
    assert.equal(delivered.length, 1, 'exactly once per event');
    off();
  });
});

test('an un-printed batch re-queues in full at the next hook (V-10): the same ids ride again, the cursor grows, delivered still once', async () => {
  await withHarness(async (h) => {
    const ctx = h.daemons[0]!.ctx;
    const seat = h.fakeSeat(0, { mode: 'direct' });
    await seat.hello();
    const S1 = seat.seatId()!;
    const [evId] = ctx.events.queueSeatContext(S1, 'WT_NOTE', { path: 'src/a.ts' });
    const delivered: Delivered[] = [];
    const off = ctx.events.onDelivered((_s, ids) => delivered.push({ seatId: S1, ids, how: { carrier: 'post', batchId: null, nonce: null } }));
    // The reply is flushed (the host saw it) and printed never arrives — the killed-hook shape.
    const r1 = await seat.hook('PostToolUse', { tool_use_id: 'tu1' });
    assert.ok(r1.reply!.text.includes('[cowork-sync] WT_NOTE'));
    assert.deepEqual(r1.reply!.events, [evId]);
    const cursor1 = r1.reply!.cursor;
    // The next hook re-queues the batch in full: the same event id, a fresh batch, the cursor grown by one.
    const r2 = await seat.hook('PostToolUse', { tool_use_id: 'tu2' });
    assert.ok(r2.reply!.text.includes('[cowork-sync] WT_NOTE'), 're-carried in full');
    assert.deepEqual(r2.reply!.events, [evId], 'the same id (re-queued, not re-minted)');
    assert.equal(r2.reply!.cursor, cursor1 + 1);
    // The client confirms the second attempt only: one delivery, the first attempt never delivered.
    ctx.events.printed(r2.reply!.batch_id);
    assert.equal(delivered.length, 1);
    assert.deepEqual(delivered[0]!.ids, [evId]);
    assert.equal(ctx.events.pending(S1).length, 0);
    off();
  });
});

test('the core path with COWORK_TEST_KILL_BEFORE_PRINTED stops after the flush: the reply was seen, the batch stays un-printed and the next hook re-carries it (A4-11)', async () => {
  await withHarness(async (h) => {
    const ctx = h.daemons[0]!.ctx;
    const seat = h.fakeSeat(0, { env: { COWORK_TEST_KILL_BEFORE_PRINTED: '1' } });   // runCore in process, the loader path
    await seat.hello();
    const S1 = seat.seatId()!;
    ctx.events.queueSeatContext(S1, 'WT_NOTE', { path: 'src/a.ts' });
    const delivered: Delivered[] = [];
    const off = ctx.events.onDelivered((_s, _ids) => delivered.push({ seatId: S1, ids: [], how: { carrier: 'post', batchId: null, nonce: null } }));
    const r1 = await seat.hook('PostToolUse', {});   // the answer is out; printed is not sent
    assert.ok(r1.reply!.text.includes('[cowork-sync] WT_NOTE'));
    const r2 = await seat.hook('PostToolUse', { tool_use_id: 'tu2' });
    assert.ok(r2.reply!.text.includes('[cowork-sync] WT_NOTE'), 'the next hook re-carries it');
    assert.equal(delivered.length, 0, 'no printed, no delivery');
    off();
  });
});

test("a shared ('all') system event materializes one copy per live seat, rides the systemMessage once and delivers exactly once (X5-27)", async () => {
  await withHarness(async (h) => {
    const ctx = h.daemons[0]!.ctx;
    const a = h.fakeSeat(0, { mode: 'direct' });
    const b = h.fakeSeat(0, { mode: 'direct' });
    await a.hello();
    await b.hello();
    ctx.events.queueSystemMessage('WT_NOTE', { path: 'src/late.ts' });   // the shared row: no seat id yet
    const delivered: Delivered[] = [];
    const off = ctx.events.onDelivered((seatId, ids) => delivered.push({ seatId, ids, how: { carrier: 'post', batchId: null, nonce: null } }));
    // Each live seat's next hook materializes its own copy: same code, distinct ids.
    const ra = await a.hook('PostToolUse', { tool_use_id: 'tu1' });
    const rb = await b.hook('PostToolUse', { tool_use_id: 'tu1' });
    assert.ok(ra.reply!.system!.includes('[cowork-sync] WT_NOTE'));
    assert.ok(rb.reply!.system!.includes('[cowork-sync] WT_NOTE'));
    assert.equal(ra.reply!.text, '');
    assert.notEqual(ra.reply!.events[0], rb.reply!.events[0], 'one copy per live seat, not one row');
    ctx.events.printed(ra.reply!.batch_id);
    ctx.events.printed(rb.reply!.batch_id);
    assert.deepEqual(delivered.map((d) => d.seatId).sort(), [a.seatId()!, b.seatId()!].sort());
    assert.deepEqual(delivered.find((d) => d.seatId === a.seatId()!)!.ids, ra.reply!.events);
    // Delivered copies never ride again; the shared template does not re-materialize for a seat already seen.
    const ra2 = await a.hook('PostToolUse', { tool_use_id: 'tu2' });
    assert.ok(!ra2.reply!.system, 'the delivered copy never rides again');
    assert.equal(ra2.reply!.events.length, 0);
    assert.equal(delivered.length, 2);
    off();
  });
});

test('06 test 39 carrier half: in every one of the 20 cells the event reaches Claude at the next hook', async () => {
  // plan:2877 (06:1083, CCI-41): permission modes × crossSessionInbound, each cell run with and without a doorbell
  // (40 runs), a fresh seat per run. Task 9 publishes the real mapping from crossSessionInbound to the seat wiring;
  // delivery is asserted under both wirings (FULL with messaging present, HOOK_ONLY without).
  await withHarness(async (h) => {
    const ctx = h.daemons[0]!.ctx;
    const modes = ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan'] as const;
    const inbound = ['unset', 'accept', 'hold', 'refuse'] as const;
    const misses: string[] = [];
    const wirings = new Set<string>();
    let run = 0;
    for (const mode of modes) {
      for (const ib of inbound) {
        for (const doorbell of [false, true]) {
          const seat = h.fakeSeat(0, { mode: 'direct', messaging: ib === 'unset' || ib === 'accept' });
          await seat.hello();
          const S = seat.seatId()!;
          // F2 fix round 1 (review): wait until the daemon knows the seat (its hello processed), not a fixed 10 ms —
          // under PC load a fixed settle could leave the wiring 'unknown' and fail the both-wirings check for no defect.
          for (const t0 = Date.now(); ctx.seats.bySeatId(S) === null;) {
            assert.ok(Date.now() - t0 < 60_000, `the daemon never registered seat ${S}`);
            await new Promise<void>((r) => { setTimeout(r, 5).unref(); });
          }
          const [evId] = ctx.events.queueSeatContext(S, 'WT_NOTE', { path: 'src/a.ts' });
          if (doorbell) ctx.events.doorbellSent('cws-' + run.toString(16).padStart(16, '0'), [evId!]);
          const r = await seat.hook('PostToolUse', { permission_mode: mode, tool_use_id: `tu-39-${run}` });
          const wiring = ctx.seats.bySeatId(S)?.wiring ?? 'unknown';
          wirings.add(wiring);
          if (r.reply === null || !r.reply.events.includes(evId!) || !r.reply.text.includes('[cowork-sync] WT_NOTE')) {
            misses.push(`${mode} × ${ib} (${doorbell ? 'with' : 'without'} doorbell, ${wiring}): events ${JSON.stringify(r.reply?.events ?? null)}`);
          }
          run++;
        }
      }
    }
    assert.equal(run, 40);
    assert.deepEqual([...wirings].sort(), ['FULL', 'HOOK_ONLY'], 'both wirings were exercised');
    assert.deepEqual(misses, []);
  });
});
