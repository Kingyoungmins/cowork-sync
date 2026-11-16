// test/integration/claude.signals.engine.test.ts — the CS signal half end to end (06 test 27's daemon half): the
// prompt signal opens nothing; SignalPump.send (A6-4 as amended by R-F2-5 and narrowed by C-8) resolves once the
// signal is in Plan 3's exclusive queue and never waits for that queue, so the effect is in the live table at the
// queue's next turn — at once on an idle engine, after an iteration that holds the queue; the Stop boundary captured
// through the engine closes it. The reply path never waits for Engine.signal (R5-24); captureIdentity reads the
// clone's files (F2 #70); idle_10min carries the seat's real activity and Plan 3 decides HLD-34 (A6-10). (PostToolUse
// sends no effect — 06 §3.12.1's effect is Task 12's; these cells drive the pump directly as the plan's A6-4 cell does.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seatHarness, type FakeSeat, type SeatHarness } from '../helpers/seatHarness.js';
import { writeWork } from '../helpers/coreFixture.js';
import { gitIn } from '../helpers/startFixture.js';
import { SignalPump, captureIdentity } from '../../src/claude/daemon/signals.js';
import { C } from '../../src/claude/wire/constants.js';
import type { Engine } from '../../src/engine/loop.js';
import type { CsSignal } from '../../src/holds/signals.js';
import type { FaultOp } from '../sim/faultfs.js';
import { nullLog, type Log } from '../../src/ports/log.js';

const SOCKET = 'c1c0-signals';

const settle = (ms: number): Promise<void> => new Promise<void>((r) => { setTimeout(r, ms).unref(); });

async function withHarness<T>(fn: (h: SeatHarness) => Promise<T>, o?: Parameters<typeof seatHarness>[0]): Promise<T> {
  const h = await seatHarness(o ?? { peers: 1, humanLeaseMin: 0 });
  try {
    return await fn(h);
  } finally {
    await h.cleanup();
  }
}

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await settle(20);
  assert.ok(cond(), `timed out waiting for ${what}`);
}

test('a prompt opens nothing, the awaited pump effect is in the table once send resolves on an idle engine (A6-4 as amended by R-F2-5, C-8), the Stop closes it', async () => {
  await withHarness(async (h) => {
    await h.engines.startAll();                                     // the engine's flow loop runs the iterations
    const seat = h.fakeSeat(0, { socketValue: SOCKET });
    await seat.hello();
    await settle(100);                                              // the pipe binds the seat id
    const core = h.engines.peers[0]!.core;
    const seatId = seat.seatId()!;                                  // the engine's seat id (ChangeSets hex128)
    // A prompt with no writes opens no change-set.
    await seat.hook('UserPromptSubmit', { prompt: 'hi', prompt_id: 'p1' });
    assert.equal(core.cs.table().cs.length, 0);
    // The effect through the daemon's own pump. No iteration holds the engine's queue here, so its next turn is the
    // next microtask: the awaited send finds the open seat entry in the live table with no further wait (the plan's
    // A6-4 pin; the held-iteration case is the next cell).
    await writeWork(h.engines.peers[0]!, 'src/a.ts', 'a = 1\n');
    await h.daemons[0]!.ctx.signals.send({ kind: 'effect', seat: seatId, agent: null, toolUseId: 'tu1', paths: ['src/a.ts'], turnOrigin: 'prompt' });
    const rows = core.cs.table().cs;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, 'seat');
    assert.equal(rows[0]!.seat, seatId);
    assert.equal(rows[0]!.state, 'open');
    // The Stop boundary closes it: the boundary's out-of-cycle iteration captures the close (no publish in it);
    // a later loop iteration may fold the published CS out of the table, so the close is asserted without rounds.
    await seat.hook('Stop', { prompt_id: 'p1' });
    let closed: string | undefined;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      closed = core.cs.table().cs.find((r) => r.seat === seatId)?.state;
      if (closed === 'closed') break;
      await settle(100);
    }
    assert.equal(closed, 'closed');
  });
});

test("an effect sent while an iteration holds the engine's queue: the awaited send resolves without waiting for that iteration, and the effect lands in the table when it ends (A6-4, R-F2-5 as narrowed by C-8)", async () => {
  await withHarness(async (h) => {
    await h.engines.startAll();
    const seat = h.fakeSeat(0, { socketValue: `${SOCKET}-held` });
    await seat.hello();
    await settle(100);
    const peer = h.engines.peers[0]!;
    const core = peer.core;
    const seatId = seat.seatId()!;
    await seat.hook('UserPromptSubmit', { prompt: 'hi', prompt_id: 'p1' });
    await writeWork(peer, 'src/a.ts', 'a = 1\n');
    // An Fs write every iteration makes (its status write), found from one real round.
    const before = peer.fs.calls.length;
    await h.engines.rounds(1);
    const round = peer.fs.calls.slice(before);
    const statusCall = round.find((c) => c.includes('status.json') && /^(writeFile|rename|writeFileExclusive) /.test(c));
    assert.ok(statusCall !== undefined, `the iteration's status write: ${round.slice(0, 30).join(' | ')}`);
    const op = statusCall.split(' ')[0] as FaultOp;
    let entered = false;
    let open: (() => void) | null = null;
    const gate = new Promise<void>((r) => { open = r; });
    peer.fs.interpose(op, 'status.json', async () => { entered = true; await gate; });
    const it = peer.engine.iterate();                              // holds the exclusive queue until the gate opens
    await until(() => entered, 'the iteration to reach its status write');
    const sent = h.daemons[0]!.ctx.signals.send({ kind: 'effect', seat: seatId, agent: null, toolUseId: 'tu1', paths: ['src/a.ts'], turnOrigin: 'prompt' }) as unknown;
    assert.ok(sent instanceof Promise, 'send returns a promise');
    let resolved = false;
    void sent.then(() => { resolved = true; });
    await settle(50);
    assert.equal(resolved, true);                                  // C-8: no reply that awaits it waits for the held iteration
    assert.equal(core.cs.table().cs.filter((r) => r.seat === seatId).length, 0);   // the effect is queued behind the iteration
    assert.ok(open !== null);
    (open as () => void)();
    await it;
    await until(() => core.cs.table().cs.some((r) => r.seat === seatId), 'the effect at the queue\'s next turn', 5_000);
    const row = core.cs.table().cs.find((r) => r.seat === seatId)!;
    assert.equal(row.state, 'open');
    assert.ok(row.paths.includes('src/a.ts'));
  });
});

test('Engine.signal is never awaited on the reply path: UPS, Stop and a checkpoint-command PostToolUse each get their reply over a pump whose engine never settles, and over one whose engine rejects (one CS_SIGNAL_REJECTED per send) (R5-24, A6-9)', async () => {
  const kinds: string[] = [];
  const neverEngine = { signal: (s: CsSignal): Promise<void> => { kinds.push(s.kind); return new Promise<void>(() => {}); } } as unknown as Engine;
  const rejected: string[] = [];
  const rejectEngine = { signal: (s: CsSignal): Promise<void> => { rejected.push(s.kind); return Promise.reject(new Error('t6 cell: the engine refuses')); } } as unknown as Engine;
  const logged: Array<{ code: string; params: Readonly<Record<string, unknown>> }> = [];
  const recLog: Log = { write: (_level, code, params) => { logged.push({ code, params: params ?? {} }); } };
  // One turn's UPS, checkpoint-command PostToolUse and Stop; each hook's reply (direct frames carry the closed wire
  // payloads: schema.ts A1-11, an unknown or missing key closes the connection).
  const turn = async (seat: FakeSeat, p: string): Promise<{ ups: unknown; ptu: unknown; stop: unknown }> => {
    const ups = (await seat.hook('UserPromptSubmit', { prompt_id: p, nonces: [] })).reply;
    const ptu = (await seat.hook('PostToolUse', { prompt_id: p, tool_name: 'Bash', tool_use_id: `tu-${p}`, path: null, read: null, exit_status: 0, command: 'npm test' })).reply;
    const stop = (await seat.hook('Stop', { prompt_id: p, stop_hook_active: false, background_tasks_running: 0, ids_in_last_message: null })).reply;
    return { ups, ptu, stop };
  };
  await withHarness(async (h) => {
    const view = h.daemons[0]!.ctx.engine as unknown as { checkpointCommands: () => readonly string[] };
    view.checkpointCommands = () => ['npm test'];                   // the team's checks.checkpoint for this cell
    const seat = h.fakeSeat(0, { socketValue: `${SOCKET}-never`, mode: 'direct' });   // direct: a missing reply is null
    await seat.hello();
    await settle(100);
    const never = await turn(seat, 'p1');
    assert.ok(never.ups !== null, 'the UserPromptSubmit got its reply');
    assert.ok(never.ptu !== null, 'the checkpoint-command PostToolUse got its reply');
    assert.ok(never.stop !== null, 'the Stop got its reply');
    const order = kinds.filter((k) => k === 'prompt' || k === 'checks_run' || k === 'stop');
    assert.deepEqual(order, ['prompt', 'checks_run', 'stop']);     // each recorded, in order, none awaited
    // The same turn shape over a pump whose engine rejects every signal: the replies arrive as before, and each send
    // logs exactly one CS_SIGNAL_REJECTED {kind, error} (A6-9) and nothing else reaches the reply.
    (h.daemons[0]!.ctx as unknown as { signals: SignalPump }).signals = new SignalPump(rejectEngine, recLog);
    const rej = await turn(seat, 'p2');
    assert.ok(rej.ups !== null, 'the UserPromptSubmit got its reply over the rejecting engine');
    assert.ok(rej.ptu !== null, 'the checkpoint-command PostToolUse got its reply over the rejecting engine');
    assert.ok(rej.stop !== null, 'the Stop got its reply over the rejecting engine');
    assert.deepEqual(Object.keys(rej.ups as object).sort(), Object.keys(never.ups as object).sort());
    assert.deepEqual(Object.keys(rej.ptu as object).sort(), Object.keys(never.ptu as object).sort());
    assert.deepEqual(Object.keys(rej.stop as object).sort(), Object.keys(never.stop as object).sort());
    assert.deepEqual(rejected.filter((k) => k === 'prompt' || k === 'checks_run' || k === 'stop'), ['prompt', 'checks_run', 'stop']);
    await settle(50);                                              // the rejections settle after their sends returned
    const lines = logged.filter((l) => l.code === 'CS_SIGNAL_REJECTED');
    assert.deepEqual(lines.map((l) => l.params['kind']), rejected);   // one line per send, in send order
    assert.ok(lines.every((l) => l.params['error'] === 'Error'));   // C-15 (SEC-38): the name, never the message — the landed form the merge carried
  }, { peers: 1, humanLeaseMin: 0, ctx: { signals: new SignalPump(neverEngine, nullLog) } });
});

test("captureIdentity reads the clone's file, not the process cwd's (F2 #70, #81)", async () => {
  await withHarness(async (h) => {
    await h.engines.startAll();
    const peer = h.engines.peers[0]!;
    const daemon = h.daemons[0]!;
    await writeWork(peer, 'probe/t6-cwd.txt', 'x\n');              // a path this repository's own checkout does not have
    assert.notEqual(process.cwd(), daemon.ctx.repo.root);
    const out = await captureIdentity('s'.repeat(32), ['probe/t6-cwd.txt'], new Map(), daemon.ctx, C.CAPTURE_BOUND_MS);
    const oid = await gitIn(peer, ['hash-object', 'probe/t6-cwd.txt']);   // the clone's blob id, computed independently
    assert.ok(out !== null, 'the capture produced an identity');
    assert.equal(out['probe/t6-cwd.txt'], oid);
  });
});

test("idle_10min carries the seat's real activity, and HLD-34 keeps a MID_TURN seat's CS open and closes an IDLE seat's (A6-10, HLD-34)", async () => {
  await withHarness(async (h) => {
    await h.engines.startAll();
    const peer = h.engines.peers[0]!;
    const core = peer.core;
    const daemon = h.daemons[0]!;
    const seat = h.fakeSeat(0, { socketValue: `${SOCKET}-idle` });
    await seat.hello();
    await settle(100);
    const seatId = seat.seatId()!;
    const pump = daemon.ctx.signals as unknown as { send(s: CsSignal): Promise<void> };
    const send = pump.send.bind(pump);
    const idle: CsSignal[] = [];
    pump.send = (s: CsSignal): Promise<void> => { if (s.kind === 'idle_10min' && s.seat === seatId) idle.push(s); return send(s); };
    // A hook-silent stretch of virtual time: steps of at most C.MCP_HEARTBEAT_MS with a heartbeat after each, so
    // the seat stays live and FULL while no hook arrives (lastHookMono stays put).
    const silence = async (ms: number): Promise<void> => {
      for (let done = 0; done < ms; done += C.MCP_HEARTBEAT_MS) {
        await h.advance(Math.min(C.MCP_HEARTBEAT_MS, ms - done));
        await seat.heartbeat();
        await settle(20);
      }
      await settle(1_100);                                         // one run of the 1 s housekeeping after the stretch
    };
    // A queue barrier with no CS effect (ChangeSets.signal 'prompt' changes nothing): its exclusive section runs after
    // every signal and out-of-cycle iteration queued before it (Plan 3's one FIFO queue), so the table is read once the
    // effect of each earlier send has landed — however long an earlier iteration holds the queue, with no timed wait.
    const barrier = (): Promise<void> => peer.engine.signal({ kind: 'prompt', seat: seatId, humanOrigin: true, nonce: false });
    const openOfSeat = (): string[] => core.cs.table().cs.filter((r) => r.seat === seatId && r.state === 'open').map((r) => r.cs_id);
    await seat.hook('UserPromptSubmit', { prompt: 'work', prompt_id: 'p1' });   // MID_TURN
    await writeWork(peer, 'src/a.ts', 'a = 1\n');
    await daemon.ctx.signals.send({ kind: 'effect', seat: seatId, agent: null, toolUseId: 'tu1', paths: ['src/a.ts'], turnOrigin: 'prompt' });
    await barrier();
    assert.equal(openOfSeat().length, 1, 'the first CS');
    const first = openOfSeat()[0]!;
    await silence(C.IDLE_CLOSE_MS);
    await until(() => idle.length >= 1, 'the first idle_10min');
    assert.deepEqual(idle[0], { kind: 'idle_10min', seat: seatId, activity: 'MID_TURN', txnOpen: false });
    await barrier();
    assert.equal(core.cs.table().cs.find((r) => r.cs_id === first)?.state, 'open');   // HLD-34: a running turn keeps it open
    await seat.hook('Stop', { prompt_id: 'p1' });                   // IDLE; the Stop closes the first CS (sent before its reply)
    await barrier();
    assert.notEqual(core.cs.table().cs.find((r) => r.cs_id === first)?.state, 'open', 'the Stop close');
    await writeWork(peer, 'src/b.ts', 'b = 1\n');
    await daemon.ctx.signals.send({ kind: 'effect', seat: seatId, agent: null, toolUseId: 'tu2', paths: ['src/b.ts'], turnOrigin: 'prompt' });
    await barrier();                                               // behind the Stop boundary's out-of-cycle iteration too
    const opened = openOfSeat().filter((id) => id !== first);
    assert.equal(opened.length, 1, 'the second CS');
    const second = opened[0]!;
    const idleBefore = idle.length;
    await silence(C.IDLE_CLOSE_MS);
    await until(() => idle.length > idleBefore, 'the second idle_10min');
    assert.deepEqual(idle.at(-1), { kind: 'idle_10min', seat: seatId, activity: 'IDLE', txnOpen: false });
    await barrier();
    assert.notEqual(core.cs.table().cs.find((r) => r.cs_id === second)?.state, 'open', "the HLD-34 close of the IDLE seat's CS");
  });
});
