// Plan 5 Task 5 phase 3b — the server cells (contract 2749…2755, A5-6; BL2-12, R5-19, SEC-21, SEC-23, O-IPC daemon half).
// The squatter halves and the endpoint-spelling cells live in claude.daemonRun.test.ts (the POSIX stale-socket
// restart half at the ipc layer: ipc.posix.test.ts); the Task 14/18 halves are theirs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { seatHarness, type SeatHarness, type SessionConn } from '../helpers/seatHarness.js';
import type { GatedClock } from '../helpers/gatedClock.js';
import { realIpc } from '../../src/ports/ipc.js';
import { PLUGIN_VERSION } from '../../src/version.js';
import { HOOK_PROTO } from '../../src/claude/wire/frames.js';
import { C } from '../../src/claude/wire/constants.js';
import type { McpHelloFrame, ReplyFrame, SessionClientFrame, SessionServerFrame } from '../../src/claude/wire/frames.js';
import type { Seat } from '../../src/claude/daemon/seats.js';
import { registerStep } from '../../src/claude/daemon/pipeline.js';
import type { Log, LogLevel, LogParam } from '../../src/ports/log.js';

const settle = (ms: number): Promise<void> => new Promise<void>((r) => { setTimeout(r, ms).unref(); });

// A test-process-only probe step under the `version.check` slot (second on SessionStart and PreToolUse,
// pipeline.ts STEP_ORDER). Ruling R-F2-7 keeps that id unregistered in src for good, so this registration never
// collides with a real step; it does nothing unless a cell arms it, and every cell that arms it resets it in
// `finally` (F2 #39, #46, #101).
let probe: 'off' | 'done' | 'throw' = 'off';
registerStep('version.check', async (_r, d) => {
  if (probe === 'done') d.done = true;
  else if (probe === 'throw') throw new Error('t5-server probe');
});

/** A session-hook frame the schema accepts (HEADER + the closed per-event payload shape). The defaults are the
 *  harness daemon's own version and proto (serving, never a drain — the version cells pass their own). */
function hookFrame(event: 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse', payload: Record<string, unknown>,
  o?: { pluginVersion?: string; hookProto?: number; seatKey?: string; sessionId?: string }): SessionClientFrame {
  return {
    t: 'hook', event,
    h: {
      seat_key: o?.seatKey ?? 'a'.repeat(64), claude_pid: 50_001, session_id: o?.sessionId ?? 's-server',
      prompt_id: null, agent_id: null, agent_type: null, permission_mode: 'default',
      repo_root: 'irrelevant-to-the-server', plugin_version: o?.pluginVersion ?? PLUGIN_VERSION, hook_proto: o?.hookProto ?? HOOK_PROTO,
    },
    payload: { ...payload, event } as never,
  };
}

const REPLY = (frames: SessionServerFrame[]): SessionServerFrame[] => frames.filter((f) => f.t === 'reply');
const SS_PAYLOAD = { source: 'startup', transcript_path: null, messaging_present: true, static_policy_hits: [] } as const;

/** Waits (real time, the daemon clock untouched) until `cond` holds or 10 s pass. */
async function until(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!cond() && Date.now() < deadline) await settle(5);
}

/** Records every Engine.drain argument on peer 0 (an instance property over loop.ts's `drain(downCode)`) and calls
 *  through once `release()` has run (R-F2-7, F2 #39: the server suite asserts close('version') once). */
function spyDrain(h: SeatHarness): { drains: unknown[]; release: () => void } {
  const engine = h.engines.peers[0]!.engine;
  const real = engine.drain.bind(engine);
  const drains: unknown[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  (engine as unknown as { drain: (c: 'IDLE_NO_SESSION' | null) => Promise<void> }).drain = async (c) => {
    drains.push(c);
    await held;
    return real(c);
  };
  return { drains, release };
}

async function withHarness<T>(o: Parameters<typeof seatHarness>[0], fn: (h: SeatHarness) => Promise<T>): Promise<T> {
  const h = await seatHarness(o);
  try {
    return await fn(h);
  } finally {
    await h.cleanup();
  }
}

test('no hook is answered before attach; the flush answers it after attach resolves; every frame kind routes (A5-6, 7-15)', async () => {
  await withHarness({ peers: 1, humanLeaseMin: 0, noAttach: true }, async (h) => {
    const ctx = h.daemons[0]!.ctx;
    // Route-observation spies: the instance patch shadows the prototype method (the registry objects are not frozen).
    const printedIds: string[] = [];
    (ctx.events as unknown as { printed: (id: string) => void }).printed = (id) => printedIds.push(id);
    const heartbeats: number[] = [];
    (ctx.seats as unknown as { onHeartbeat: (s: Seat) => void }).onHeartbeat = () => { heartbeats.push(1); };
    const seatEnds: string[] = [];
    (ctx.seats as unknown as { end: (s: Seat, why: string) => Promise<void> }).end = (_s, why) => { seatEnds.push(why); return Promise.resolve(); };
    const ringResults: Array<[string, string]> = [];
    (ctx.ring as unknown as { onResult: (n: string, r: 'sent' | 'refused' | 'error') => void }).onResult = (n, r) => { ringResults.push([n, r]); };

    // Held, not routed: the hook frame arrives between listen and attach.
    const pre = await h.session(0);
    pre.send(hookFrame('SessionStart', { source: 'startup', transcript_path: null, messaging_present: true, static_policy_hits: [] }));
    await settle(300);
    assert.equal(REPLY(pre.frames()).length, 0);                        // nothing before attach
    assert.equal(ctx.seats.seats().length, 0);                          // and no registration either
    assert.equal(h.trace.events.some((e) => (e as { kind?: string }).kind === 'seat'), false);

    await h.attachAll();
    // A5-2 (F2 #30, #92): the flushed SessionStart has no hello, so its seat.register waits for the pairing until
    // its arrival + 2,500 on the daemon clock, which moves only when advanced: advance it 100 ms per turn, never past
    // 2,600 in all (below the 5 s pid check, which would end the pre-attach seat: pid 50_001 joins the harness's
    // alive set only with the fakeSeat below), and stop at the reply.
    const gated = ctx.ports.clock as GatedClock;
    let advanced = 0;
    const deadline = Date.now() + 10_000;
    while (REPLY(pre.frames()).length === 0 && Date.now() < deadline) {
      if (advanced < 2_600) { gated.advance(100); advanced += 100; }
      await settle(20);
    }
    assert.equal(REPLY(pre.frames()).length, 1);                        // the flush answered the held hook
    const preSeat = ctx.seats.byKey('a'.repeat(64));
    assert.ok(preSeat !== null);
    assert.match(preSeat.seatId ?? '', /^[0-9a-f]{32}$/);                // minted by the pairing wait, before the reply
    assert.equal(preSeat.wiring, 'NO_MCP');
    assert.equal(h.trace.events.some((e) => (e as { kind?: string; op?: string }).kind === 'seat' && (e as { op?: string }).op === 'register'), true);
    pre.close();

    // printed → events.printed.
    const pr = await h.session(0);
    pr.send({ t: 'printed', batch_id: 'batch-1' });
    await settle(100);
    assert.deepEqual(printedIds, ['batch-1']);
    pr.close();

    // hello → the seat is bound (sendToSeat finds its MCP connection); heartbeat → seats.onHeartbeat;
    // ring_result → ring.onResult; sendToSeat writes on the MCP connection and is false for an unknown seat.
    const seat = h.fakeSeat(0);
    await seat.hello();
    await seat.heartbeat();
    await seat.sendSession({ t: 'ring_result', nonce: 'cws-0123456789abcdef', result: 'sent' });
    await settle(100);
    assert.equal(heartbeats.length, 1);
    assert.deepEqual(ringResults, [['cws-0123456789abcdef', 'sent']]);
    const ring: SessionServerFrame = { t: 'ring', event_ids: [], text: 'x', nonce: 'cws-0000000000000001' };
    assert.equal(h.daemons[0]!.server!.sendToSeat(seat.seatId()!, ring), true);
    await settle(100);                                                  // the pipe delivers asynchronously
    assert.equal(seat.frames().some((f) => f.t === 'ring' && f.nonce === 'cws-0000000000000001'), true);
    assert.equal(h.daemons[0]!.server!.sendToSeat('f'.repeat(32), ring), false);

    // seat_end → seats.end('mcp_eof') once.
    await seat.mcpEof();
    await settle(100);
    assert.deepEqual(seatEnds, ['mcp_eof']);

    // A valid acting frame with no registered handler closes the connection, echoing nothing (SEC-23's key-like string included).
    const act = await h.session(0);
    act.send({ t: 'acting', params: { blob: 'k'.repeat(64) }, mode: 'tty', tty: true, ancestry_has_claude: false, verb: 'start', args_sha256: 'a'.repeat(64) } as SessionClientFrame);
    await settle(200);
    assert.equal(act.frames().length, 0);
    act.close();

    // The ipc trace: accept and auth_ok with bytesToUnauthenticated 0 (O-IPC daemon half).
    const ipc = h.trace.events.filter((e) => (e as { kind?: string }).kind === 'ipc') as Array<{ op: string; bytesToUnauthenticated: number }>;
    assert.ok(ipc.some((e) => e.op === 'accept'));
    assert.ok(ipc.some((e) => e.op === 'auth_ok' && e.bytesToUnauthenticated === 0));
  });
});

test('the server source executes no command, reads no environment and names no key path (SEC-23 handler half)', async () => {
  const src = readFileSync(fileURLToPath(new URL('../../src/claude/daemon/server.ts', import.meta.url)), 'utf8');
  assert.ok(!src.includes('child_process'));
  assert.ok(!src.includes('process.env'));
  assert.ok(!src.includes('ipc.key'));
});

test('a newer caller is served then the daemon drains and the endpoint stops accepting; older callers keep being served (CCI-52, 06 test 44)', async () => {
  // (a) own 0.6.0/proto 3; a 0.6.1 hook caller gets its reply, then Engine.drain(null) runs once and the drain
  // closes the endpoint (plan 2729; R-F2-7: judged inline after the reply, no version.check step; F2 #39).
  await withHarness({ peers: 1, humanLeaseMin: 0, pluginVersion: '0.6.0', hookProto: 3 }, async (h) => {
    const spy = spyDrain(h);   // held: while the drain waits the endpoint still accepts, so a second verdict can arrive
    try {
      const seat = h.fakeSeat(0, { pluginVersion: '0.6.1', mode: 'direct' });   // the header carries the caller's version
      const r = await seat.hook('SessionStart', { source: 'startup' });
      assert.ok(r.reply !== null && r.reply.decision === 'context');    // served first (Task 7: the RULES code line rides SessionStart)
      await until(() => spy.drains.length > 0);
      assert.deepEqual(spy.drains, [null]);                             // close('version') → Engine.drain(null)
      // A second serve_then_drain verdict while the drain is held — the same newer caller's hello — drains nothing
      // more (decision 7-18: the trigger fires once).
      await seat.hello();
      await settle(200);
      assert.deepEqual(spy.drains, [null]);
    } finally {
      spy.release();
    }
    const deadline = Date.now() + 5_000;
    let refused = false;
    while (Date.now() < deadline) {
      try {
        const c = await realIpc.connect(h.endpoint(0), 200);
        c.destroy();                                                    // still accepting: try again after a beat
        await settle(50);
      } catch {
        refused = true;
        break;
      }
    }
    assert.equal(refused, true);                                        // drained: a new connect is refused
    assert.deepEqual(spy.drains, [null]);
    await settle(200);
    assert.deepEqual(spy.drains, [null], 'Engine.drain(null) exactly once');
  });

  // (b) own 0.6.1/proto 3; a 0.6.0/proto-3 caller keeps being served, no drain (same proto, older version → serve).
  await withHarness({ peers: 1, humanLeaseMin: 0, pluginVersion: '0.6.1', hookProto: 3 }, async (h) => {
    const spy = spyDrain(h);
    spy.release();
    const seat = h.fakeSeat(0, { pluginVersion: '0.6.0', mode: 'direct' });
    const r1 = await seat.hook('SessionStart', { source: 'startup' });
    assert.ok(r1.reply !== null && r1.reply.decision === 'context');   // served first (Task 7: the RULES code line rides SessionStart)
    const r2 = await seat.hook('UserPromptSubmit', { nonces: [] });
    assert.ok(r2.reply !== null && r2.reply.decision === 'none');       // still serving
    await settle(200);
    assert.deepEqual(spy.drains, [], 'never drains');                   // (cleanup's close('removal') never drains)
  });

  // (c) a 0.5.0/proto-1 caller (two behind): ordinary replies on the four caller kinds, no deny (G1 is Task 10's).
  // Pinned exactly (F2 #25: Task 7 changed only SessionStart, which rides the RULES code line).
  await withHarness({ peers: 1, humanLeaseMin: 0, pluginVersion: '0.6.0', hookProto: 3 }, async (h) => {
    const seat = h.fakeSeat(0, { pluginVersion: '0.5.0', hookProto: 1, mode: 'direct' });
    for (const [event, payload, want] of [
      ['SessionStart', { source: 'startup', transcript_path: null, messaging_present: true, static_policy_hits: [] }, 'context'],
      ['UserPromptSubmit', { nonces: [] }, 'none'],
      ['PostToolUse', { tool_name: 'Bash', tool_use_id: 't1', path: null, read: null, exit_status: 0, command: 'ls' }, 'none'],
    ] as const) {
      const r = await seat.hook(event, { ...payload });
      assert.ok(r.reply !== null, event);
      assert.equal(r.reply.decision, want, `${event}: ${JSON.stringify(r.reply.text)}`);
    }
    const bash = await seat.hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 't2' });
    assert.ok(bash.reply !== null && bash.reply.decision === 'none');
  });

  // (d) the same version with a newer hook_proto serves (A5-10).
  await withHarness({ peers: 1, humanLeaseMin: 0, pluginVersion: '0.6.0', hookProto: 3 }, async (h) => {
    const seat = h.fakeSeat(0, { hookProto: 4, mode: 'direct' });
    const r = await seat.hook('SessionStart', { source: 'startup' });
    assert.ok(r.reply !== null && r.reply.decision === 'context');     // served (A5-10; the RULES code line rides SessionStart)
  });
});

test('a throwing step or hello fails closed: DAEMON_INTERNAL_ERROR logged, closed with no reply, no unhandled rejection, the next hook served (R-F2-14; F2 #46, #101)', async () => {
  const rejections: unknown[] = [];
  const onRejection = (e: unknown): void => { rejections.push(e); };
  process.on('unhandledRejection', onRejection);
  try {
    await withHarness({ peers: 1, humanLeaseMin: 0 }, async (h) => {
      const ctx = h.daemons[0]!.ctx;
      // The ctx is a plain object and the server reads this.ctx.log at call time: a recording log swaps in.
      const lines: Array<{ level: LogLevel; code: string; params: Readonly<Record<string, LogParam>> | undefined }> = [];
      (ctx as unknown as { log: Log }).log = { write: (level, code, params) => { lines.push({ level, code, params }); } };

      // Hook half: a throwing step on a gating event gets no reply at all (never an allow); the loader applies G4.
      const seat = h.fakeSeat(0, { mode: 'direct' });
      await seat.hello();
      await settle(50);
      probe = 'throw';
      try {
        await assert.rejects(seat.hook('PreToolUse', { tool_name: 'Edit', tool_use_id: 'tx' }), /closed before the reply/);
      } finally {
        probe = 'off';
      }
      await settle(50);
      assert.deepEqual(lines, [{ level: 'error', code: 'DAEMON_INTERNAL_ERROR', params: { t: 'hook', event: 'PreToolUse', error: 'Error' } }]);
      assert.deepEqual(rejections, []);
      const next = await seat.hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'ty' });   // the daemon still serves
      assert.ok(next.reply !== null && next.reply.decision === 'none', JSON.stringify(next.reply));   // null: no reply within the harness deadline

      // Hello half: a hello whose handling throws is logged and its connection closed; a reconnect binds.
      const seats = ctx.seats as unknown as { fromHello: (f: McpHelloFrame) => Seat };
      const realFromHello = seats.fromHello.bind(ctx.seats);
      let thrown = false;
      seats.fromHello = (f) => {
        if (!thrown) { thrown = true; throw new Error('t5-server probe'); }
        return realFromHello(f);
      };
      try {
        const s2 = h.fakeSeat(0, { mode: 'direct' });
        await s2.hello();
        await settle(150);
        assert.equal(thrown, true);
        assert.deepEqual(lines[1], { level: 'error', code: 'DAEMON_INTERNAL_ERROR', params: { t: 'hello', event: null, error: 'Error' } });
        assert.equal(lines.length, 2);
        assert.deepEqual(rejections, []);
        assert.equal(ctx.seats.bySeatId(s2.seatId()!), null);
        s2.closeSession();
        await s2.hello();
        await settle(150);
        assert.notEqual(ctx.seats.bySeatId(s2.seatId()!), null);
      } finally {
        delete (seats as { fromHello?: unknown }).fromHello;   // the prototype method again
      }

      // Behaviour pin (not RED): through the loader path a throwing step on an edit-class PreToolUse is G4 (exit 2).
      const core = h.fakeSeat(0);
      await core.hello();
      await settle(50);
      probe = 'throw';
      try {
        const g4 = await core.hook('PreToolUse', { tool_name: 'Edit', tool_use_id: 'tz' });
        assert.equal(g4.exit, 2);
      } finally {
        probe = 'off';
      }
      assert.deepEqual(rejections, []);
    });
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('a hook before any hello waits for the pairing and runs with the bound id: NO_MCP, RULES at SessionStart, no seat-"" signal (A5-2, CCI-31, 06 §3.11.2; F2 #30, #92)', async () => {
  await withHarness({ peers: 1, humanLeaseMin: 0 }, async (h) => {
    const ctx = h.daemons[0]!.ctx;
    const clock = ctx.ports.clock;
    // The CS signals, recorded and passed through (the instance property shadows SignalPump.send).
    const signals: Array<{ kind: string; seat?: string; activity?: string }> = [];
    const pump = ctx.signals as unknown as { send: (s: { kind: string; seat?: string }) => unknown };
    const realSend = pump.send.bind(ctx.signals);
    pump.send = (s) => { signals.push(s); return realSend(s); };
    try {
      // (i) SessionStart with no hello: the step waits until arrival + 2,500 and the daemon mints NO_MCP, so the
      // reply carries the RULES line within the loader's 3 s deadline (direct hook() moves the clock 10 ms a turn).
      const KB = 'b'.repeat(64);
      const s1 = h.fakeSeat(0, { seatKey: KB, mode: 'direct' });
      const t0 = clock.monoMs();
      const r1 = await s1.hook('SessionStart', { source: 'startup' });
      const e1 = clock.monoMs() - t0;
      assert.ok(r1.reply !== null && r1.reply.decision === 'context');
      assert.ok(r1.reply.text.includes('STANDING_RULES'), JSON.stringify(r1.reply.text));
      const b1 = ctx.seats.byKey(KB);
      assert.ok(b1 !== null);
      assert.match(b1.seatId ?? '', /^[0-9a-f]{32}$/);
      assert.equal(b1.wiring, 'NO_MCP');
      assert.ok(e1 >= 2_500 && e1 < C.LOADER_DEADLINE_SESSION_START_MS, `SessionStart waited ${e1} ms`);

      // (ii) UserPromptSubmit with no hello: arrival + 1,000; its activity signal names the minted id.
      const KD = 'd'.repeat(64);
      const s2 = h.fakeSeat(0, { seatKey: KD, mode: 'direct' });
      const t1 = clock.monoMs();
      const r2 = await s2.hook('UserPromptSubmit', { nonces: [] });
      const e2 = clock.monoMs() - t1;
      assert.ok(r2.reply !== null);
      const b2 = ctx.seats.byKey(KD);
      assert.ok(b2 !== null);
      assert.match(b2.seatId ?? '', /^[0-9a-f]{32}$/);
      assert.equal(b2.wiring, 'NO_MCP');
      assert.ok(e2 >= 1_000 && e2 < C.LOADER_DEADLINE_MS, `UserPromptSubmit waited ${e2} ms`);
      assert.ok(signals.some((s) => s.kind === 'activity' && s.seat === b2.seatId && s.activity === 'MID_TURN'), JSON.stringify(signals));

      // (iii) The hello arrives during the wait: the hook runs under the hello's id (no mint), wiring FULL. A raw
      // session carries the hook so the daemon clock stands still: only the hello can release the wait.
      const KE = 'e'.repeat(64);
      const s3 = h.fakeSeat(0, { seatKey: KE, mode: 'direct' });
      const raw = await h.session(0);
      raw.send(hookFrame('SessionStart', SS_PAYLOAD, { seatKey: KE }));
      await until(() => ctx.seats.byKey(KE) !== null);
      const b3 = ctx.seats.byKey(KE);
      assert.ok(b3 !== null);
      assert.equal(b3.seatId, null, 'the hook is waiting for the pairing');
      await settle(50);
      assert.equal(REPLY(raw.frames()).length, 0, 'no reply before the binding');
      await s3.hello();
      await until(() => REPLY(raw.frames()).length > 0);
      const r3 = REPLY(raw.frames())[0] as ReplyFrame | undefined;
      assert.ok(r3 !== undefined && r3.decision === 'context');
      assert.ok(r3.text.includes('STANDING_RULES'), JSON.stringify(r3.text));
      assert.equal(b3.seatId, s3.seatId(), "the hello's id, not a mint");
      assert.equal(b3.wiring, 'FULL');
      raw.close();

      assert.deepEqual(signals.filter((s) => s.seat === ''), [], 'no signal under seat ""');
    } finally {
      delete (pump as { send?: unknown }).send;
    }
  });
});

test('sendToSeat writes only on the seat\'s MCP connection: false for a seat with only a hook connection open; the MCP connection wins over an earlier hook connection (A5-6; F2 #99, #71, #96, #59)', async () => {
  await withHarness({ peers: 1, humanLeaseMin: 0 }, async (h) => {
    const ctx = h.daemons[0]!.ctx;
    const server = h.daemons[0]!.server!;
    const ring = (nonce: string): SessionServerFrame => ({ t: 'ring', event_ids: [], text: 'x', nonce });
    const rings = (frames: SessionServerFrame[], nonce: string): number => frames.filter((f) => f.t === 'ring' && f.nonce === nonce).length;
    const replied = async (c: SessionConn): Promise<void> => {
      await until(() => REPLY(c.frames()).length > 0);
      assert.equal(REPLY(c.frames()).length, 1);
    };

    // (i) S is bound by its hello, then its MCP connection drops; a hook connection of S stays open: no MCP
    // connection → false, and nothing is written on the hook connection (the hook client drops ring frames).
    const K = 'c'.repeat(64);
    const seat = h.fakeSeat(0, { seatKey: K, pid: 50_001, mode: 'direct' });
    await seat.hello();
    await until(() => ctx.seats.bySeatId(seat.seatId()!) !== null);
    const S = seat.seatId()!;
    seat.closeSession();
    await settle(150);
    const hookConn = await h.session(0);
    hookConn.send(hookFrame('UserPromptSubmit', { nonces: [] }, { seatKey: K }));
    await replied(hookConn);
    assert.equal(server.sendToSeat(S, ring('cws-0000000000000011')), false);
    await settle(150);
    assert.equal(rings(hookConn.frames(), 'cws-0000000000000011'), 0);

    // (ii) K': a hook connection opens first (with A5-2 it waits for the binding), then the hello: the ring rides
    // the MCP connection, not the earlier hook connection.
    const K2 = '9'.repeat(64);
    const seat2 = h.fakeSeat(0, { seatKey: K2, mode: 'direct' });
    const early = await h.session(0);
    early.send(hookFrame('UserPromptSubmit', { nonces: [] }, { seatKey: K2 }));
    await until(() => ctx.seats.byKey(K2) !== null);
    await seat2.hello();
    await replied(early);
    const S2 = seat2.seatId()!;
    assert.equal(ctx.seats.byKey(K2)!.seatId, S2);
    assert.equal(server.sendToSeat(S2, ring('cws-0000000000000022')), true);
    await settle(150);
    assert.equal(rings(seat2.frames(), 'cws-0000000000000022'), 1);
    assert.equal(rings(early.frames(), 'cws-0000000000000022'), 0);
    assert.equal(server.sendToSeat('f'.repeat(32), ring('cws-0000000000000033')), false);   // an unknown seat
    hookConn.close();
    early.close();
  });
});

test('a step that sets d.done stops the later steps and the reply is still written (A5-6 runner; F2 #39)', async () => {
  await withHarness({ peers: 1, humanLeaseMin: 0 }, async (h) => {
    const ctx = h.daemons[0]!.ctx;
    const seat = h.fakeSeat(0, { mode: 'direct' });
    await seat.hello();
    await until(() => ctx.seats.bySeatId(seat.seatId()!) !== null);
    // Call counters on the two steps' module calls (event.deliver → events.nextHook, transition.deliver →
    // transitions.forSeat), passing through.
    const counts = { nextHook: 0, forSeat: 0 };
    const events = ctx.events as unknown as { nextHook: (...a: unknown[]) => unknown };
    const transitions = ctx.transitions as unknown as { forSeat: (...a: unknown[]) => unknown };
    const realNextHook = events.nextHook.bind(ctx.events);
    const realForSeat = transitions.forSeat.bind(ctx.transitions);
    events.nextHook = (...a) => { counts.nextHook++; return realNextHook(...a); };
    transitions.forSeat = (...a) => { counts.forSeat++; return realForSeat(...a); };
    try {
      // Control: every step runs — the RULES line (carrier.context) and both deliver steps.
      const r0 = await seat.hook('SessionStart', { source: 'startup' });
      assert.ok(r0.reply !== null && r0.reply.decision === 'context');
      assert.ok(r0.reply.text.includes('STANDING_RULES'), JSON.stringify(r0.reply.text));
      assert.ok(counts.nextHook > 0 && counts.forSeat > 0, JSON.stringify(counts));
      // d.done at the second step (version.check): no later step runs, the reply is still written.
      const before = { ...counts };
      probe = 'done';
      let r1: Awaited<ReturnType<typeof seat.hook>>;
      try {
        r1 = await seat.hook('SessionStart', { source: 'startup' });
      } finally {
        probe = 'off';
      }
      assert.ok(r1.reply !== null && r1.reply.decision === 'context');
      assert.ok(!r1.reply.text.includes('STANDING_RULES'), JSON.stringify(r1.reply.text));
      assert.deepEqual(counts, before, 'neither deliver step ran');
    } finally {
      delete (events as { nextHook?: unknown }).nextHook;
      delete (transitions as { forSeat?: unknown }).forSeat;
    }
  });
});

test('no handler path echoes the key or resolves a frame path outside the repo (SEC-23 handler half; F2 #82)', async () => {
  await withHarness({ peers: 1, humanLeaseMin: 0 }, async (h) => {
    const ctx = h.daemons[0]!.ctx;
    const server = h.daemons[0]!.server!;
    const keyHex = h.keys(0).toString('hex');
    const keyB64 = h.keys(0).toString('base64');
    assert.equal(keyHex.length, 64);
    // Echo stubs: each returns a schema-valid s2c frame built from the request (the client validates incoming frames).
    server.onRequest('tool', async (f) => {
      const t = f as Extract<SessionClientFrame, { t: 'tool' }>;
      return { t: 'tool_result', call_id: t.call_id, text: 'stub', structured: t.args } as SessionServerFrame;
    });
    server.onRequest('acting', async (f) => {
      const a = f as Extract<SessionClientFrame, { t: 'acting' }>;
      return { t: 'acting_result', ok: true, code: 'STUB', params: {}, data: a.params } as SessionServerFrame;
    });
    server.onRequest('flow', async () => ({ t: 'refused', code: 'STUB' }) as SessionServerFrame);
    const fs = ctx.ports.fs as unknown as { calls: string[] };
    const callsFrom = fs.calls.length;
    const X = 'x'.repeat(64);
    const conns: SessionConn[] = [];
    const one = async (f: SessionClientFrame, kind: SessionServerFrame['t']): Promise<SessionServerFrame> => {
      const c = await h.session(0);
      conns.push(c);
      c.send(f);
      await until(() => c.frames().some((g) => g.t === kind));
      const got = c.frames().find((g) => g.t === kind);
      assert.ok(got !== undefined, `a ${kind} reply`);
      return got;
    };
    assert.deepEqual(await one({ t: 'tool', call_id: 'c1', name: 'cowork_show', args: { k: X } } as SessionClientFrame, 'tool_result'),
      { t: 'tool_result', call_id: 'c1', text: 'stub', structured: { k: X } });
    assert.deepEqual(await one({ t: 'acting', params: { k: X }, mode: 'tty', tty: true, ancestry_has_claude: false, verb: 'start', args_sha256: 'a'.repeat(64) } as SessionClientFrame, 'acting_result'),
      { t: 'acting_result', ok: true, code: 'STUB', params: {}, data: { k: X } });
    assert.deepEqual(await one({ t: 'flow', selector: { path: '../../outside/x' } } as SessionClientFrame, 'refused'),
      { t: 'refused', code: 'STUB' });
    // A hook whose session_id is key-like: its reply does not carry it (a bound seat, so no pairing wait).
    const seat = h.fakeSeat(0, { seatKey: '7'.repeat(64), mode: 'direct' });
    await seat.hello();
    await until(() => ctx.seats.bySeatId(seat.seatId()!) !== null);
    const hookReply = await one(hookFrame('UserPromptSubmit', { nonces: [] }, { seatKey: '7'.repeat(64), sessionId: X }), 'reply') as ReplyFrame;
    assert.ok(!JSON.stringify(hookReply).includes(X), JSON.stringify(hookReply));
    const seen = [...conns.flatMap((c) => c.frames()), ...seat.frames()].map((f) => JSON.stringify(f));
    assert.ok(seen.length >= 4);
    for (const s of seen) {
      assert.ok(!s.includes(keyHex), 'no frame carries the key (hex)');
      assert.ok(!s.includes(keyB64), 'no frame carries the key (base64)');
    }
    // Every Fs call made while these frames were handled stays under the repo, its gitdir or the data dir.
    const norm = (p: string): string => (process.platform === 'win32' ? p.replace(/\\/g, '/').toLowerCase() : p);
    const roots = [ctx.repo.root, ctx.repo.gitdir, ctx.repo.dataDir].map(norm);
    for (const call of fs.calls.slice(callsFrom)) {
      // FaultFs records "<op> <path>" (a two-path op: "<op> <path> -> <dest>").
      for (const p of call.slice(call.indexOf(' ') + 1).split(' -> ')) {
        const path = norm(p);
        assert.ok(!path.includes('outside'), call);
        assert.ok(roots.some((r) => path === r || path.startsWith(`${r}/`)), call);
      }
    }
    for (const c of conns) c.close();
  });
});
