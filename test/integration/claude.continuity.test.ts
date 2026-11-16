// Plan 5 Task 5 phase 3a-2 — continuity end to end (06 test 25 seat half, TC-CCI-09; contract 2768).
// One seat keeps its id and number across /clear, /compact, in-process /resume and /fork; a second
// window is session 2; one `seat` register event; seats() lists both. The self-deny half is Task 18's
// and the DIGEST_SUPERSEDES half Task 7's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seatHarness, seatKeyOfSocket, type SeatHarness } from '../helpers/seatHarness.js';

const K1 = seatKeyOfSocket('c1c0-window-1');
const K2 = seatKeyOfSocket('c1c0-window-2');
const S1 = '5ea70000000000000000000000000001';
const S2 = '5ea70000000000000000000000000002';

async function withHarness<T>(fn: (h: SeatHarness) => Promise<T>): Promise<T> {
  const h = await seatHarness({ peers: 1 });
  try {
    return await fn(h);
  } finally {
    await h.cleanup();
  }
}

test('a seat keeps its id and number across /clear, /compact, in-process /resume and /fork; a second window is session 2', async () => {
  await withHarness(async (h) => {
    const ctx = h.daemons[0]!.ctx;
    const s1 = h.fakeSeat(0, { seatKey: K1, seatId: S1, socketValue: 'c1c0-window-1' });
    await s1.hello();
    await s1.hook('SessionStart', { source: 'startup', session_id: 'a1' });
    await s1.hook('PreToolUse', { session_id: 'a1', tool_name: 'Edit', tool_use_id: 'tu1' });
    await s1.hook('PostToolUse', { session_id: 'a1', tool_name: 'Edit', tool_use_id: 'tu1', path: 'src/a.ts', exit_status: 0 });
    for (const [source, sid] of [['clear', 'a2'], ['compact', 'a3'], ['resume', 'a4'], ['fork', 'a5']] as const) {
      await s1.hook('SessionStart', { source, session_id: sid });
    }
    const seat1 = ctx.seats.bySeatId(S1);
    assert.ok(seat1 !== null);
    assert.equal(seat1.number, 1);
    assert.equal(seat1.sessionIds.size, 5);                      // a1…a5 all on one seat
    const registers = h.trace.events.filter((e) => (e as { kind: string; op?: string }).kind === 'seat' && (e as { op?: string }).op === 'register');
    assert.equal(registers.length, 1);                           // one register across the whole lifetime
    const s2 = h.fakeSeat(0, { seatKey: K2, seatId: S2, socketValue: 'c1c0-window-2' });
    await s2.hello();
    await s2.hook('SessionStart', { source: 'startup', session_id: 'b1' });
    const seat2 = ctx.seats.bySeatId(S2);
    assert.ok(seat2 !== null);
    assert.equal(seat2.number, 2);                               // numbers never reused, in order
    const listed = ctx.seats.seats();
    assert.deepEqual(listed.map((s) => s.seat_id).sort(), [S1, S2].sort());
  });
});
