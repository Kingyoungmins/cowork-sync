// Plan 5 Task 5 phase 3b — the lease cells on the real binding (plan 2744; R2-I1 binding, BL2-01, CCI-50, ENG-56,
// contract 2765). The engine's lease IS its daemon's SeatLeasePort (seatHarness's engineDeps), so Plan 2's lease loop
// cells re-run inside the seat harness's own fixture: the seat ends and the lease stops the sync, then drains.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readBoardCommit } from '../../src/board/boardCommit.js';
import { LEASE_EXIT_MS, LEASE_STOP_SYNC_MS } from '../../src/ports/lease.js';
import { runLoop } from '../../src/engine/loop.js';
import type { StatusJson } from '../../src/engine/status.js';
import type { Oid } from '../../src/git/oid.js';
import type { OpDraft } from '../../src/board/ops.js';
import { VirtualScheduler } from '../sim/vscheduler.js';
import { seededRandom } from '../../src/ports/random.js';
import { readWork, writeWork, type PeerFixture } from '../helpers/coreFixture.js';
import { remoteBoardTip, type EngineFixture } from '../helpers/engineFixture.js';
import { liveOf } from '../helpers/incidentFixture.js';
import { buf, captureReady, prep } from '../helpers/publishHelpers.js';
import { seatHarness, type SeatHarness } from '../helpers/seatHarness.js';
import { runTicker } from '../../src/claude/daemon/pipeline.js';
import { C } from '../../src/claude/wire/constants.js';

const sleepReal = (ms: number): Promise<void> => new Promise<void>((r) => { setTimeout(r, ms).unref(); });

async function statusOf(p: PeerFixture): Promise<StatusJson> {
  return JSON.parse((await readFile(join(p.deps.paths.coworkDir, 'status.json'))).toString('utf8')) as StatusJson;
}

/** The op types landed on the remote board tip so far (seat_end is what the ended seat queues). */
async function remoteBoardOps(fx: EngineFixture): Promise<Set<string>> {
  const p0 = fx.peers[0]!;
  const tip = await remoteBoardTip(fx) as Oid;
  await p0.core.fetcher.fetch(true);
  const data = await readBoardCommit(p0.core.repo, tip);
  return new Set(data.opsLines.map((l) => (JSON.parse(l) as { type: string }).type));
}

/** The live code tree of the remote board tip, as path → text (loop.test.ts's local helper, in place). */
async function remoteLiveFiles(fx: EngineFixture, p: PeerFixture): Promise<Map<string, string>> {
  const T = (await remoteBoardTip(fx)) as Oid;
  const repo = p.core.repo;
  await p.core.fetcher.fetch(true);
  const live = await liveOf(p, T);
  const out = new Map<string, string>();
  for (const [path, e] of await repo.readTreeMap((await repo.readCommit(live)).tree)) out.set(path, (await repo.readBlob(e.oid)).toString('utf8'));
  return out;
}

test('with a real SeatLeasePort, 2 min after the seat ended no capture, apply or new publish happens but the ready pair still flushes; the seat_end op lands on the board (plan 2744, first half)', async () => {
  const h = await seatHarness({ peers: 2, humanLeaseMin: 0 });   // the seat's end must be what stops the sync
  try {
    const fx = h.engines;
    await fx.startAll();
    await fx.rounds(3);
    const [p1] = fx.peers as [typeof fx.peers[0]];
    // A ready pair captured while the lease was valid (the seat holds it with its heartbeat).
    await writeWork(p1, 'ready.txt', 'captured\n');
    await fx.rounds(1);
    fx.advance(21_000);
    await captureReady(p1, await prep(p1, true));
    assert.equal(p1.core.cs.ready().length, 1);

    const seat = h.fakeSeat(0);
    await seat.hello();
    await seat.mcpEof();                       // seat_end queues; the seat ends
    seat.kill();
    // The ended seat ends the lease: the engine's engineDeps.lease reads the daemon's SeatLeasePort.
    const lease = h.daemons[0]!.engineDeps.lease;
    // Completion-based (fs-slow gate proof): the lease flips in a few fixture rounds locally; the 300-round
    // ceiling is a runaway guard, never a wait (a wall-clock deadline read as a failure twice in the gate).
    let waited = 0;
    while (lease.idleMs() < LEASE_STOP_SYNC_MS && waited < 300) {
      await h.advance(10_000);
      await fx.rounds(1);
      waited++;
    }
    assert.ok(lease.idleMs() >= LEASE_STOP_SYNC_MS, 'the seat end moved the lease past the sync stop');
    assert.equal((await remoteBoardOps(fx)).has('seat_end'), true, 'the seat_end op flushed');

    await writeWork(p1, 'later.txt', 'not captured\n');
    await fx.pushTeamChange({ 'team.txt': buf('t\n') });
    for (let i = 0; i < 12; i++) {
      fx.advance(2_500);
      const r = await p1.engine.iterate();
      assert.equal(r.applied, false, 'no apply without a lease');
    }
    const remote = await remoteLiveFiles(fx, p1);
    assert.equal(remote.get('ready.txt'), 'captured\n', 'the already-captured ready pair flushed');
    assert.equal(remote.get('later.txt'), undefined, 'no new capture or publish');
    assert.equal(p1.core.cs.ready().length, 0);
    assert.equal(await readWork(p1, 'team.txt'), null, 'no apply');
  } finally {
    await h.cleanup();
  }
});

test('10 min after the last seat ended runLoop drains the engine: status down with IDLE_NO_SESSION, a drained engine iterates no more (plan 2744, second half)', async () => {
  const h = await seatHarness({ peers: 1, humanLeaseMin: 0 });   // the drain is the seat lease's, not a human's
  try {
    const fx = h.engines;
    await fx.startAll();
    const [p1] = fx.peers as [typeof fx.peers[0]];
    const lease = h.daemons[0]!.engineDeps.lease;
    // Pre-age the idle clock (the reference cell's idleSince pattern): the seat ends and the daemon clock runs to
    // just under the 10-min exit, so the loop's first iterations already sit at the drain edge.
    const seat = h.fakeSeat(0);
    await seat.hello();
    await seat.mcpEof();
    seat.kill();
    let preAged = 0;
    while (lease.idleMs() < LEASE_EXIT_MS - 20_000 && preAged < 100) { await h.advance(10_000); preAged++; }
    assert.ok(lease.idleMs() >= LEASE_EXIT_MS - 20_000, 'the seat end moved the idle clock to the drain edge');
    const sched = new VirtualScheduler(p1.clock, seededRandom('seats-engine-drain'));
    const handle = runLoop(p1.engine, { scheduler: sched, clock: p1.clock, lease });
    let finished = false;
    void handle.finished.then(() => { finished = true; });
    for (let i = 0; i < 80 && !finished; i++) {
      await h.advance(5_000);                  // the lease's clock (the harness GatedClock) moves too
      await sched.step();                      // the loop's own scheduler fires its next due callback
      await sleepReal(1);
    }
    assert.ok(finished, 'runLoop drained within the step budget');
    await handle.finished;
    assert.equal(p1.engine.drained, true);
    const s = await statusOf(p1);
    assert.deepEqual([s.state, s.message_code], ['down', 'IDLE_NO_SESSION']);
    const r = await p1.engine.iterate();
    assert.equal(r.fetched, false, 'a drained engine iterates no more');
  } finally {
    await h.cleanup();
  }
});

test("composition: an INFLIGHT lease that expires, then the writer writes its path, taints the path — observedEdit false until the seat's next edit Post (INV-CCI-EXPIRY-TAINT, F2 #103)", async () => {
  const h = await seatHarness({ peers: 2 });
  try {
    const fx = h.engines;
    await fx.startAll();
    await fx.rounds(1);
    const dctx = h.daemons[0]!.ctx;
    const S = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';   // the verifying seat (synthetic: acquireInflight needs no hello)
    dctx.leases.acquireInflight({ toolUseId: 'tu-exp', seatId: S, agentId: null, sessionId: 's1', path: 'src/a.txt', foldHeight: 0, pre: null, approximate: false, synthetic: false, preHeld: null, view: null, tentative: null });
    // The writer (peer 0) changes the path and publishes. The fence holds the writer's apply until the expiry
    // (06 test 19), so at the expiry no writer write has landed: the composition must leave a candidate that the
    // writer's apply promotes (the plan's own scenario, Ruling t8a-1's second point).
    await fx.pushTeamChange({ 'src/a.txt': buf('writer\n') });
    await h.advance(C.INFLIGHT_BACKSTOP_MS + 1_000);   // the DAEMON's clock moves (fx.advance moves only the engine fixtures)
    await runTicker('leases', dctx);                   // the 1 s housekeeping tick: the backstop expires the lease before any writer write
    let applied = false;
    for (let i = 0; i < 40 && !applied; i++) {
      await h.advance(2_500);
      applied = (await (fx.peers[0] as typeof fx.peers[0]).engine.iterate()).applied;
    }
    assert.equal(applied, true, 'the writer applied the teammate change after the expiry');
    assert.equal(dctx.windows.tainted('src/a.txt'), true, 'the expiry + the writer write taint the path');
    assert.equal(h.daemons[0]!.engineDeps.attribution.observedEdit('src/a.txt'), false, 'the tainted path is unobserved (R5-27)');
    // The taint survives the expired call's own late Post; another call's Post clears it (Ruling t8a-1).
    dctx.windows.onEditPost(S, 'src/a.txt', 'tu-exp');
    assert.equal(dctx.windows.tainted('src/a.txt'), true, "the stale call's own Post keeps the taint");
    dctx.windows.onEditPost(S, 'src/a.txt', 'tu-other');
    assert.equal(dctx.windows.tainted('src/a.txt'), false, "another call's Post clears the taint");
  } finally {
    await h.cleanup();
  }
});

test('a newer caller\'s SessionStart is answered, then the daemon drains and requests the process stop once (06 §3.17.3, F2 #90)', async () => {
  const stops: number[] = [];
  // The default human lease (480 min) keeps the sync awake, so the only drain that can happen here is the version drain's.
  const h = await seatHarness({ peers: 1, requestStop: (peer) => { stops.push(peer); } });
  try {
    const seat = h.fakeSeat(0, { mode: 'direct', pluginVersion: '9.9.9' });   // newer than the daemon's PLUGIN_VERSION: serve_then_drain
    const r = await seat.hook('SessionStart', { source: 'startup' });
    assert.ok(r.reply !== null, 'the newer caller is served first');
    for (let i = 0; i < 100 && !(stops.length > 0 && h.engines.peers[0]!.engine.drained); i++) {
      await h.advance(50);
      await sleepReal(50);
    }
    assert.deepEqual(stops, [0], 'the stop is requested exactly once, by peer 0\'s daemon');
    assert.equal(h.engines.peers[0]!.engine.drained, true, 'the engine drained before the stop');
    for (let i = 0; i < 10; i++) {                                     // one more bounded interval: still exactly once
      await h.advance(50);
      await sleepReal(50);
    }
    assert.deepEqual(stops, [0], 'no second stop request after the first');
  } finally {
    await h.cleanup();
  }
});

test('an idle seat\'s PULL_MODE flag clears at its seat-hour boundary through the 1 s meter ticker (F2 #7)', async () => {
  const h = await seatHarness({ peers: 1 });
  try {
    const ctx = h.daemons[0]!.ctx;
    const seat = h.fakeSeat(0);
    await seat.hello();                                                 // MCP only, no hooks: the heartbeat-gap rule cannot move it to HOOK_ONLY
    const id = seat.seatId()!;
    for (let i = 0; i < 200 && ctx.seats.bySeatId(id) === null; i++) await sleepReal(10);
    assert.ok(ctx.seats.bySeatId(id) !== null, 'the hello bound the seat');
    ctx.meter.touch(id);
    ctx.meter.charge(id, 'inject', 20_001);
    assert.ok(ctx.seats.seatWiring(id).flags.includes('PULL_MODE'));
    await h.advance(C.SEAT_HOUR_MS + 1);
    // No meter call from here on: only the tickers run (the realScheduler re-arms on real timers, about 1 s each).
    for (let i = 0; i < 40 && ctx.seats.seatWiring(id).flags.includes('PULL_MODE'); i++) {
      await h.advance(1_000);
      await sleepReal(250);
    }
    assert.ok(!ctx.seats.seatWiring(id).flags.includes('PULL_MODE'), 'PULL_MODE cleared at the window boundary');
    const health = h.outboxOf(0).drafts().filter((d): d is Extract<OpDraft, { type: 'event' }> => d.type === 'event' && d.kind === 'health' && (d as { refs: readonly string[] }).refs.includes(id))
      .map((d) => d.reason_code);
    const pull = health.indexOf('SEAT_PULL_MODE');
    assert.ok(pull >= 0, `health drafts: ${health.join(',')}`);
    assert.ok(health.indexOf('SEAT_FULL', pull + 1) > pull, `a SEAT_FULL draft follows the SEAT_PULL_MODE one: ${health.join(',')}`);
  } finally {
    await h.cleanup();
  }
});
