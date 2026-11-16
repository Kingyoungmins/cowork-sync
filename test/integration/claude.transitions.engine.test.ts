// Plan 5 Task 7 — the engine→daemon transition wiring end to end (CCI-44, R5-55/A5-3, 06 §3.6.2). The daemon
// subscribes at attach (Engine.onStatus → Transitions.observe) with the engine's own heartbeat source, so a
// status.json change the engine writes (the remote renamed away: OFFLINE) reaches the seat's next reply as its
// pair — one systemMessage line, one Claude line — and the way back is ONLINE. A drained engine writes no fresh
// status: its frozen heartbeat_mono_ms falls 3 loop periods behind the heartbeat source and the seat's next
// reply announces DAEMON_DOWN once, never re-armed while no fresh status arrives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { LEASE_EXIT_MS } from '../../src/ports/lease.js';
import { runLoop } from '../../src/engine/loop.js';
import type { StatusJson } from '../../src/engine/status.js';
import { VirtualScheduler } from '../sim/vscheduler.js';
import { seededRandom } from '../../src/ports/random.js';
import { readWork, workPath, type PeerFixture } from '../helpers/coreFixture.js';
import { seatHarness, type SeatHarness } from '../helpers/seatHarness.js';
import type { DaemonCtx } from '../../src/claude/daemon/ctx.js';

const sleepReal = (ms: number): Promise<void> => new Promise<void>((r) => { setTimeout(r, ms).unref(); });

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

async function statusOf(p: PeerFixture): Promise<StatusJson> {
  return JSON.parse((await readFile(join(p.deps.paths.coworkDir, 'status.json'))).toString('utf8')) as StatusJson;
}

test('the engine OFFLINE status reaches the seat as one OFFLINE pair (systemMessage + Claude line), and the recovery as ONLINE', async () => {
  const h = await seatHarness({ peers: 1 });
  try {
    const fx = h.engines;
    await fx.startAll();
    await fx.rounds(2);
    const p = fx.peers[0]!;
    const seat = h.fakeSeat(0);
    await seat.hello();
    await seat.hook('SessionStart', { source: 'startup', session_id: 'a1' });   // the seat materializes from its baseline
    // The remote is renamed away: the engine goes offline after 30 s of failed fetches.
    const away = `${fx.remote.dir}.away`;
    await rename(fx.remote.dir, away);
    let s: StatusJson | null = null;
    try {
      for (let i = 0; i < 40; i++) {
        await h.advance(10_000);
        await p.engine.iterate();
        s = await statusOf(p);
        if (s.state === 'offline' && s.publish_pause === 'OFFLINE') break;
      }
      assert.ok(s !== null && s.state === 'offline' && s.publish_pause === 'OFFLINE', 'the engine went offline');
      // The daemon's observer queued the pair (status → Transitions.observe): the seat's next reply carries it.
      const r = await seat.hook('PostToolUse', {});
      assert.ok(r.reply!.system!.includes('OFFLINE'), `systemMessage: ${JSON.stringify(r.reply!.system)}`);
      assert.ok(r.reply!.text.includes('OFFLINE'), `the Claude line: ${JSON.stringify(r.reply!.text)}`);
      // The pair rides once: consumed by that reply, the next hook carries nothing (the episode stays OFFLINE).
      await untilPrinted(h.daemons[0]!.ctx);
      const r2 = await seat.hook('PostToolUse', { tool_use_id: 'tu2' });
      assert.ok(!r2.reply!.text.includes('OFFLINE') && !r2.reply!.system, 'no repeat before 600 s');
    } finally {
      await rename(away, fx.remote.dir);
    }
    // Back online at the next allowed fetch (the backoff is ≤ 5 min): the ONLINE pair is the way back.
    for (let i = 0; i < 80 && (await statusOf(p)).state !== 'ok'; i++) {
      await h.advance(10_000);
      await p.engine.iterate();
    }
    assert.equal((await statusOf(p)).state, 'ok');
    await untilPrinted(h.daemons[0]!.ctx);
    const r3 = await seat.hook('PostToolUse', { tool_use_id: 'tu3' });
    assert.ok(r3.reply!.system!.includes('ONLINE'), `the way back: ${JSON.stringify(r3.reply!.system)}`);
    assert.ok(r3.reply!.text.includes('ONLINE'));
  } finally {
    await h.cleanup();
  }
});

test('a drained engine writes no fresh status: after 3 loop periods the seat announces DAEMON_DOWN once and it is never re-armed', async () => {
  const h = await seatHarness({ peers: 1, humanLeaseMin: 0 });   // the drain is the seat lease's, not a human's
  try {
    const fx = h.engines;
    await fx.startAll();
    const p = fx.peers[0]!;
    const seat = h.fakeSeat(0);
    await seat.hello();
    await seat.hook('SessionStart', { source: 'startup', session_id: 'a1' });   // the seat's last-seen status
    // The seat ends, the lease runs to the drain edge, and runLoop drains the engine (plan 2744's second half,
    // the reference cell's mechanics): the drain is runLoop's, not iterate's.
    const lease = h.daemons[0]!.engineDeps.lease;
    await seat.mcpEof();
    seat.kill();
    let preAged = 0;
    while (lease.idleMs() < LEASE_EXIT_MS - 20_000 && preAged < 100) { await h.advance(10_000); preAged++; }
    assert.ok(lease.idleMs() >= LEASE_EXIT_MS - 20_000, 'the seat end moved the idle clock to the drain edge');
    const sched = new VirtualScheduler(p.clock, seededRandom('transitions-engine-drain'));
    const handle = runLoop(p.engine, { scheduler: sched, clock: p.clock, lease });
    let finished = false;
    void handle.finished.then(() => { finished = true; });
    for (let i = 0; i < 80 && !finished; i++) {
      await h.advance(5_000);                  // the lease's clock (the harness GatedClock) moves too
      await sched.step();                      // the loop's own scheduler fires its next due callback
      await sleepReal(1);
    }
    assert.ok(finished, 'runLoop drained within the step budget');
    await handle.finished;
    assert.ok(p.engine.drained, 'the engine drained');
    const s = await statusOf(p);
    assert.equal(s.state, 'down');
    // The heartbeat source (the engine's own clock, R-35) keeps moving; the drained engine never rewrites the
    // status, so its heartbeat_mono_ms falls behind: the next hook carries the DAEMON_DOWN pair once.
    await h.advance(60_000);
    const r = await seat.hook('PostToolUse', {});
    assert.ok(r.reply!.system!.includes('DAEMON_DOWN'), `systemMessage: ${JSON.stringify(r.reply!.system)}`);
    assert.ok(r.reply!.text.includes('DAEMON_DOWN'), `the Claude line: ${JSON.stringify(r.reply!.text)}`);
    await h.advance(60_000);
    await untilPrinted(h.daemons[0]!.ctx);
    const r2 = await seat.hook('PostToolUse', { tool_use_id: 'tu2' });
    assert.ok(!r2.reply!.text.includes('DAEMON_DOWN'), 'once per seat until a fresh status re-arms it');
    assert.equal((await statusOf(p)).heartbeat_mono_ms, s.heartbeat_mono_ms, 'a drained engine writes no fresh status');
  } finally {
    await h.cleanup();
  }
});

// ---- F2 #11: transition lines are store rows, delivered at least once like every other event ------------------------------

test("F2 #11: a transition line whose reply is never confirmed rides the seat's next hook again; printed ends it", async () => {
  const h = await seatHarness({ peers: 1 });
  try {
    const fx = h.engines;
    await fx.startAll();
    await fx.rounds(2);
    const p = fx.peers[0]!;
    const ctx = h.daemons[0]!.ctx;
    const seat = h.fakeSeat(0, { mode: 'direct' });                 // the direct path never sends printed (the killed-hook model)
    const kill = h.fakeSeat(0, { env: { COWORK_TEST_KILL_BEFORE_PRINTED: '1' } });   // the core path stopped after the flush (A4-11)
    await seat.hello();
    await kill.hello();
    const r0 = await seat.hook('SessionStart', { source: 'startup', session_id: 'a1' });   // both seats see the real status first
    if (r0.reply!.batch_id !== '') ctx.events.printed(r0.reply!.batch_id);
    await kill.hook('SessionStart', { source: 'startup', session_id: 'k1' });
    // A synthetic FROZEN with the current heartbeat (no DAEMON_DOWN noise); the engine is not iterated from here on.
    ctx.transitions.observe({ ...(await statusOf(p)), freeze_reasons: ['EPOCH'] }, 0);
    const r1 = await seat.hook('PostToolUse', { tool_use_id: 'tu1' });
    assert.ok((r1.reply!.system ?? '').includes('FROZEN'), `hook 1 systemMessage: ${JSON.stringify(r1.reply!.system)}`);
    assert.ok(r1.reply!.text.includes('FROZEN'), `hook 1 Claude line: ${JSON.stringify(r1.reply!.text)}`);
    const r2 = await seat.hook('PostToolUse', { tool_use_id: 'tu2' });   // hook 1 was never printed
    assert.ok((r2.reply!.system ?? '').includes('FROZEN'), `hook 2 re-carries the line: ${JSON.stringify(r2.reply!.system)}`);
    assert.ok(r2.reply!.text.includes('FROZEN'), `hook 2 re-carries the Claude line: ${JSON.stringify(r2.reply!.text)}`);
    ctx.events.printed(r2.reply!.batch_id);
    const r3 = await seat.hook('PostToolUse', { tool_use_id: 'tu3' });
    assert.ok(!(r3.reply!.system ?? '').includes('FROZEN') && !r3.reply!.text.includes('FROZEN'), `printed ended it: ${JSON.stringify(r3.reply)}`);
    // The kill-switch leg: the reply was flushed, printed never sent, so the next hook carries the line again.
    const k1 = await kill.hook('PostToolUse', { tool_use_id: 'k-tu1' });
    assert.ok((k1.reply!.system ?? '').includes('FROZEN'), `kill leg hook 1: ${JSON.stringify(k1.reply!.system)}`);
    const k2 = await kill.hook('PostToolUse', { tool_use_id: 'k-tu2' });
    assert.ok((k2.reply!.system ?? '').includes('FROZEN'), `kill leg hook 2 re-carries it: ${JSON.stringify(k2.reply!.system)}`);
  } finally {
    await h.cleanup();
  }
});

test('F2 #11: a transition line the cap drops stays pending and rides the next hook', async () => {
  const h = await seatHarness({ peers: 1 });
  try {
    const fx = h.engines;
    await fx.startAll();
    await fx.rounds(2);
    const p = fx.peers[0]!;
    const ctx = h.daemons[0]!.ctx;
    const seat = h.fakeSeat(0);                                     // core mode: printed is sent
    await seat.hello();
    await waitFor(() => seat.seatId() !== null && ctx.seats.bySeatId(seat.seatId()!) !== null, 'hello bound the seat');
    const S = seat.seatId()!;
    await seat.hook('SessionStart', { source: 'startup', session_id: 'a1' });   // the seat sees the real status first
    await untilPrinted(ctx);
    for (let i = 0; i < 15; i++) ctx.events.queueSeatContext(S, 'WT_NOTE', { path: 'a'.repeat(50) });   // over the post cap of 1,000
    ctx.transitions.observe({ ...(await statusOf(p)), freeze_reasons: ['EPOCH'] }, 0);
    const r1 = await seat.hook('PostToolUse', { tool_use_id: 'tu1' });
    assert.ok(!r1.reply!.text.includes('FROZEN'), `the cap dropped the FROZEN Claude line: ${JSON.stringify(r1.reply!.text)}`);
    assert.ok(r1.reply!.text.includes('T-MORE'), `the overflow line names the drop: ${JSON.stringify(r1.reply!.text)}`);
    assert.ok((r1.reply!.system ?? '').includes('FROZEN'), `the systemMessage carried it: ${JSON.stringify(r1.reply!.system)}`);
    await untilPrinted(ctx);
    const r2 = await seat.hook('PostToolUse', { tool_use_id: 'tu2' });
    assert.ok(r2.reply!.text.includes('FROZEN'), `the dropped line rides the next hook: ${JSON.stringify(r2.reply!.text)}`);
  } finally {
    await h.cleanup();
  }
});

// ---- F2 #38: plan 2881 through a hook, and 06 test 35 (Plan 5 half) -------------------------------------------------------

/** The lines of a reply slot that carry a code (a code line names it once). */
const linesWith = (text: string | null | undefined, code: string): number => (text ?? '').split('\n').filter((l) => l.includes(code)).length;

test('NONRETRYABLE through a hook renders only the host-reject PIN id, never the host text', async () => {
  const h = await seatHarness({ peers: 1 });
  try {
    const fx = h.engines;
    await fx.startAll();
    await fx.rounds(2);
    const p = fx.peers[0]!;
    const ctx = h.daemons[0]!.ctx;
    const seat = h.fakeSeat(0);
    await seat.hello();
    await waitFor(() => seat.seatId() !== null && ctx.seats.bySeatId(seat.seatId()!) !== null, 'hello bound the seat');
    await seat.hook('SessionStart', { source: 'startup', session_id: 'a1' });
    await untilPrinted(ctx);
    ctx.transitions.observe({ ...(await statusOf(p)), publish_pause: 'NONRETRYABLE', message_code: 'NONRETRYABLE',
      message_params: { hold_id: '01JAXZ0000000000000000000A', text: 'remote: rejected by policy' } }, 0);
    const r = await seat.hook('PostToolUse', { tool_use_id: 'tu1' });
    assert.ok((r.reply!.system ?? '').includes('NONRETRYABLE'), `systemMessage: ${JSON.stringify(r.reply!.system)}`);
    assert.ok(r.reply!.text.includes('NONRETRYABLE'), `the Claude line: ${JSON.stringify(r.reply!.text)}`);
    assert.ok(!(r.reply!.system ?? '').includes('remote:') && !r.reply!.text.includes('remote:'), `never the host text: ${JSON.stringify(r.reply)}`);
  } finally {
    await h.cleanup();
  }
});

/** The two engine-driven 06 test 35 legs: on a loaded PC the harness setup alone takes ~6 min of the runner's
 *  default 10 min cap, so these cells carry 20 min of headroom (F2 r1; the cap is time only, no assertion changes). */
const HEAVY = { timeout: 20 * 60_000 };

/** Two seats on one daemon, both bound and both past their SessionStart at the current status. */
async function twoSeats(h: SeatHarness): Promise<[ReturnType<SeatHarness['fakeSeat']>, ReturnType<SeatHarness['fakeSeat']>]> {
  const ctx = h.daemons[0]!.ctx;
  const a = h.fakeSeat(0);
  const b = h.fakeSeat(0);
  for (const [i, s] of [a, b].entries()) {
    await s.hello();
    await waitFor(() => s.seatId() !== null && ctx.seats.bySeatId(s.seatId()!) !== null, 'hello bound the seat');
    await s.hook('SessionStart', { source: 'startup', session_id: `s${i}` });
    await untilPrinted(ctx);
  }
  return [a, b];
}

test('06 test 35 (Plan 5 half): credential loss reaches each seat once, within the offline threshold plus one loop period', HEAVY, async () => {
  const h = await seatHarness({ peers: 1 });
  try {
    const fx = h.engines;
    await fx.startAll();
    await fx.rounds(2);
    const p = fx.peers[0]!;
    const ctx = h.daemons[0]!.ctx;
    const seats = await twoSeats(h);
    await p.engine.iterate();
    const before = await statusOf(p);
    assert.equal(before.publish_pause, null);
    const age = before.last_fetch_age_ms;
    assert.ok(age !== null, `a fetch succeeded: ${JSON.stringify(before)}`);
    const lastFetchMono = before.heartbeat_mono_ms - age;
    const away = `${fx.remote.dir}.away`;
    await rename(fx.remote.dir, away);
    try {
      let s: StatusJson | null = null;
      for (let i = 0; i < 40; i++) {                                // one loop period per step
        await h.advance(2_500);
        await p.engine.iterate();
        s = await statusOf(p);
        if (s.publish_pause === 'OFFLINE') break;
      }
      assert.ok(s !== null && s.publish_pause === 'OFFLINE', `the engine paused publishing: ${JSON.stringify(s)}`);
      assert.ok(s.heartbeat_mono_ms - lastFetchMono <= 30_000 + 2_500,
        `the first OFFLINE status came ${s.heartbeat_mono_ms - lastFetchMono} ms after the last successful fetch (≤ 30,000 + 2,500)`);
      // Every seat's hooks until 600 s offline carry exactly one OFFLINE pair.
      const seen = seats.map(() => ({ system: 0, text: 0 }));
      const hookAll = async (tag: string): Promise<void> => {
        for (const [i, seat] of seats.entries()) {
          const r = await seat.hook('PostToolUse', { tool_use_id: `${tag}-${i}` });
          seen[i]!.system += linesWith(r.reply!.system, 'OFFLINE');
          seen[i]!.text += linesWith(r.reply!.text, 'OFFLINE');
          await untilPrinted(ctx);
        }
      };
      await hookAll('first');
      const ofs = (st: StatusJson): number => Number(st.message_params['offline_for_s'] ?? 0);
      for (const target of [300, 580]) {
        for (let i = 0; i < 40; i++) {                              // big steps, never past the target
          s = await statusOf(p);
          if (ofs(s) >= target) break;
          await h.advance(Math.min(60_000, Math.max(2_500, (target - ofs(s)) * 1_000)));
          await p.engine.iterate();
        }
        assert.ok(ofs(s!) >= target && ofs(s!) < 600, `at ${target} s and still before the 10-minute repeat: ${JSON.stringify(s!.message_params)}`);
        await hookAll(`at-${target}`);
      }
      assert.deepEqual(seen, [{ system: 1, text: 1 }, { system: 1, text: 1 }], 'each seat got exactly one OFFLINE pair');
    } finally {
      await rename(away, fx.remote.dir);
    }
  } finally {
    await h.cleanup();
  }
});

test('06 test 35 (Plan 5 half): a held file lock that defers an incoming change makes the state degraded and reaches each seat once', HEAVY, async () => {
  const h = await seatHarness({ peers: 1 });
  try {
    const fx = h.engines;
    await fx.startAll();
    await fx.rounds(2);
    const p = fx.peers[0]!;
    const ctx = h.daemons[0]!.ctx;
    const F = 'src/locked.txt';
    await fx.pushTeamChange({ [F]: Buffer.from('one\n') });          // the teammate's first version lands on this PC
    const landed = async (): Promise<boolean> => {
      const st = await statusOf(p);
      return st.state === 'ok' && st.pending.incoming === 0 && (await readWork(p, F))?.toString('utf8') === 'one\n';
    };
    for (let i = 0; i < 14 && !(await landed()); i++) await fx.rounds(1);
    const seats = await twoSeats(h);
    assert.ok(await landed(), `the seats start at an ok status with the first version on disk: ${JSON.stringify(await statusOf(p))}`);
    const release = p.fs.holdLock(workPath(p, F), 'share-read');   // an editor holds the file open (the apply.k4deferred recipe)
    let s: StatusJson | null = null;
    try {
      await fx.pushTeamChange({ [F]: Buffer.from('two\n') });        // the second version cannot be written
      // Round by round until the apply defers the path (status pending.incoming counts it while it is younger than
      // 60 s); then one round past loop.ts PENDING_OLD_MS (60 s) ages it past 60 s, which makes the state degraded
      // (pendingOlderThan60s; the status names its own message_code) — a handful of engine rounds instead of ~25 (F2 r1).
      let deferred = false;
      for (let i = 0; i < 12; i++) {
        await fx.rounds(1, deferred ? 61_000 : 2_500);
        s = await statusOf(p);
        if (s.state === 'degraded') break;
        deferred = deferred || s.pending.incoming > 0;
      }
      assert.ok(s !== null && s.state === 'degraded' && s.message_code !== null, `the held lock made the state degraded: ${JSON.stringify(s)}`);
      const code = s.message_code;
      const seen = seats.map(() => ({ system: 0, text: 0 }));
      for (const round of [0, 1]) {
        for (const [i, seat] of seats.entries()) {
          const r = await seat.hook('PostToolUse', { tool_use_id: `lock-${round}-${i}` });
          seen[i]!.system += linesWith(r.reply!.system, code);
          seen[i]!.text += linesWith(r.reply!.text, code);
          await untilPrinted(ctx);
        }
      }
      assert.deepEqual(seen, [{ system: 1, text: 1 }, { system: 1, text: 1 }], `each seat got exactly one ${code} pair (systemMessage and Claude line)`);
    } finally {
      release();
    }
  } finally {
    await h.cleanup();
  }
});

test('06 test 35 (Plan 5 half): a loop stalled past 3 loop periods makes the next hook of each seat carry DAEMON_DOWN once', async () => {
  const h = await seatHarness({ peers: 1 });
  try {
    const fx = h.engines;
    await fx.startAll();
    await fx.rounds(2);
    const p = fx.peers[0]!;
    const ctx = h.daemons[0]!.ctx;
    const seats = await twoSeats(h);
    await p.engine.iterate();                                       // a fresh status at heartbeat H; no iteration after it
    const s = await statusOf(p);
    const lag = p.deps.ports.clock.monoMs() - s.heartbeat_mono_ms;
    await h.advance(3 * s.loop_period_ms - lag);
    for (const [i, seat] of seats.entries()) {
      const r = await seat.hook('PostToolUse', { tool_use_id: `at-3-${i}` });
      assert.equal(linesWith(r.reply!.system, 'DAEMON_DOWN'), 0, `3 loop periods is not stale yet: ${JSON.stringify(r.reply!.system)}`);
      await untilPrinted(ctx);
    }
    await h.advance(1);
    for (const [i, seat] of seats.entries()) {
      const r = await seat.hook('PostToolUse', { tool_use_id: `past-3-${i}` });
      assert.equal(linesWith(r.reply!.system, 'DAEMON_DOWN'), 1, `seat ${i}: one DAEMON_DOWN line: ${JSON.stringify(r.reply!.system)}`);
      assert.equal(linesWith(r.reply!.text, 'DAEMON_DOWN'), 1, `seat ${i}: one DAEMON_DOWN Claude line: ${JSON.stringify(r.reply!.text)}`);
      await untilPrinted(ctx);
    }
    for (const [i, seat] of seats.entries()) {
      const r = await seat.hook('PostToolUse', { tool_use_id: `again-${i}` });
      assert.equal(linesWith(r.reply!.system, 'DAEMON_DOWN') + linesWith(r.reply!.text, 'DAEMON_DOWN'), 0, `once per seat: ${JSON.stringify(r.reply)}`);
      await untilPrinted(ctx);
    }
    assert.equal((await statusOf(p)).heartbeat_mono_ms, s.heartbeat_mono_ms, 'no fresh status was written meanwhile');
  } finally {
    await h.cleanup();
  }
});
