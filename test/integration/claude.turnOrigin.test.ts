// test/integration/claude.turnOrigin.test.ts — the turn origin end to end over real hooks and the real ring path
// (06 test 30's daemon half; O-TURN-ORIGIN, TC-CCI-20 signals half, BL2-15). The mid-turn doorbell: rung while the
// seat is idle (the real Ringer refuses a MID_TURN seat, A6-7), it arrives mid-turn with the running prompt_id (06
// §3.12.2 MEASURED) and releases nothing, emits no prompt, keeps the CS open, refreshes nothing and confirms its
// events once; under M44 the same doorbell refreshes the attended window and emits prompt (A6-11). A CS opened in a
// wake turn publishes `Cowork-CS … origin=wake`, a human turn's `origin=prompt` (CCI-37, R1-124).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seatHarness, type SeatHarness } from '../helpers/seatHarness.js';
import { GatedClock } from '../helpers/gatedClock.js';
import { writeWork } from '../helpers/coreFixture.js';
import { TraceRecorder } from '../sim/traceRecorder.js';
import { scriptedRing } from '../../src/claude/daemon/ring.js';
import { runTicker } from '../../src/claude/daemon/pipeline.js';
import { LeaseTable } from '../../src/claude/daemon/leases.js';
import { parseCsTrailers } from '../../src/board/boardCommit.js';
import type { SeatEvent } from '../../src/claude/daemon/events.js';
import type { CsSignal } from '../../src/holds/signals.js';
import type { TraceEvent } from '../../src/ports/trace.js';
import type { Oid } from '../../src/git/oid.js';

const settle = (ms: number): Promise<void> => new Promise<void>((r) => { setTimeout(r, ms).unref(); });

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await settle(20);
  assert.ok(cond(), `timed out waiting for ${what}`);
}

/** The EventStore double (A5-12): pending answers this test's rows; doorbellSent and nonceSeen record (nonceSeen as the
 *  real store: an id only after doorbellSent named it, each once); onDelivered answers an unsubscribe. */
class EventsDouble {
  readonly doorbell: Array<{ nonce: string; ids: string[] }> = [];
  readonly seen: Array<{ nonce: string; ids: readonly string[] }> = [];
  private readonly delivered = new Set<string>();
  private batches = 0;
  constructor(private readonly rows: SeatEvent[]) {}
  pending(seatId: string): readonly SeatEvent[] { return this.rows.filter((r) => r.seatId === seatId && r.state === 'pending'); }
  doorbellSent(nonce: string, ids: readonly string[]): void { this.doorbell.push({ nonce, ids: [...ids] }); }
  nonceSeen(n: string): readonly string[] {
    const out = this.doorbell.filter((d) => d.nonce === n).flatMap((d) => d.ids).filter((id) => !this.delivered.has(id));
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

const doorbellText = (ids: readonly string[], nonce: string): string => `doorbell for ${ids.join(',')}\nref ${nonce}`;
const ringPolicy = scriptedRing((_s, ids, nonce) => ({ text: doorbellText(ids, nonce) }));

const turnEvents = (h: SeatHarness): Array<Extract<TraceEvent, { kind: 'turn' }>> =>
  h.trace.events.filter((e): e is Extract<TraceEvent, { kind: 'turn' }> => e.kind === 'turn');

/** A seat rung while idle (nonce N for its events), then running the human turn p1 (UPS, PreToolUse) with an open CS,
 *  then the mid-turn doorbell UPS with the same prompt_id carrying N. `beforeDoorbell` runs just before that UPS. */
async function midTurnDoorbell(h: SeatHarness, events: EventsDouble, rows: SeatEvent[], socket: string, releases: () => number,
  sends: CsSignal[], beforeDoorbell?: () => void): Promise<{ seatId: string; nonce: string; lastAfterP1: number | null; releasesAround: number; promptsAround: number; doorbellTurn: { promptId: string | null; origin: string | null }; lastAfterDoorbell: number | null; csOpen: boolean; lastTurnEvent: Extract<TraceEvent, { kind: 'turn' }> | undefined }> {
  const daemon = h.daemons[0]!;
  const core = h.engines.peers[0]!.core;
  const seat = h.fakeSeat(0, { socketValue: socket });
  seat.mcpScript(['sent']);
  await seat.hello();
  await settle(100);
  const seatId = seat.seatId()!;
  const daemonSeat = daemon.ctx.seats.bySeatId(seatId)!;
  rows.push(row(seatId, `${socket}-e1`), row(seatId, `${socket}-e2`));
  const doorbellsBefore = events.doorbell.length;
  void runTicker('ring', daemon.ctx);                            // the real Ringer, while the seat is IDLE
  await until(() => events.doorbell.length > doorbellsBefore, "the doorbell's 'sent'");
  const nonce = events.doorbell.at(-1)!.nonce;
  await seat.hook('UserPromptSubmit', { prompt: 'refactor the parser', prompt_id: 'p1' });   // the human turn p1
  await seat.hook('PreToolUse', { prompt_id: 'p1', tool_name: 'Edit', tool_use_id: `${socket}-tu1` });
  await writeWork(h.engines.peers[0]!, 'src/a.ts', 'a = 1\n');
  await daemon.ctx.signals.send({ kind: 'effect', seat: seatId, agent: null, toolUseId: `${socket}-tu1`, paths: ['src/a.ts'], turnOrigin: daemon.ctx.turns.originOf(seatId) });
  await until(() => core.cs.table().cs.some((r) => r.seat === seatId && r.state === 'open'), "the seat's CS");
  const lastAfterP1 = daemonSeat.turn.lastHumanPromptMono;
  await h.advance(2_000);                                        // the doorbell arrives later in the running turn
  const rel = releases();
  const prompts = sends.filter((s) => s.kind === 'prompt' && s.seat === seatId).length;
  beforeDoorbell?.();
  await seat.hook('UserPromptSubmit', { prompt: doorbellText([`${socket}-e1`, `${socket}-e2`], nonce), prompt_id: 'p1' });
  return {
    seatId, nonce, lastAfterP1,
    releasesAround: releases() - rel,
    promptsAround: sends.filter((s) => s.kind === 'prompt' && s.seat === seatId).length - prompts,
    doorbellTurn: { promptId: daemonSeat.turn.promptId, origin: daemonSeat.turn.origin },
    lastAfterDoorbell: daemonSeat.turn.lastHumanPromptMono,
    csOpen: core.cs.table().cs.some((r) => r.seat === seatId && r.state === 'open'),
    lastTurnEvent: turnEvents(h).filter((e) => e.seat === seatId).at(-1),
  };
}

/** The A5-12 doubles of plan 2800: a LeaseTable that holds one INFLIGHT lease and one TXN for every seat and records
 *  releaseSeat, and the EventStore double. The pump's sends are recorded on the daemon's own SignalPump. */
async function doorbellHarness(): Promise<{ h: SeatHarness; events: EventsDouble; rows: SeatEvent[]; releases: () => number; sends: CsSignal[] }> {
  const clock = new GatedClock({ startMono: 1_000_000 });
  const leases = new LeaseTable(clock, new TraceRecorder(), {} as never);
  let releaseSeat = 0;
  const realRelease = leases.releaseSeat.bind(leases);
  (leases as unknown as { releaseSeat: typeof leases.releaseSeat }).releaseSeat = (...a) => { releaseSeat += 1; return realRelease(...a); };
  (leases as unknown as { openFor: typeof leases.openFor }).openFor = () => ({ inflight: 1, txns: 1 });
  const rows: SeatEvent[] = [];
  const events = new EventsDouble(rows);
  const h = await seatHarness({ peers: 1, humanLeaseMin: 0, clock, bindings: { wakePolicy: ringPolicy }, ctx: { leases: leases as never, events: events as never } });
  await h.engines.startAll();
  const pump = h.daemons[0]!.ctx.signals as unknown as { send(s: CsSignal): Promise<void> };
  const send = pump.send.bind(pump);
  const sends: CsSignal[] = [];
  pump.send = (s: CsSignal): Promise<void> => { sends.push(s); return send(s); };
  return { h, events, rows, releases: () => releaseSeat, sends };
}

test('a nonce-carrying UserPromptSubmit mid-turn releases no lease, closes no TXN, emits no prompt signal, keeps the CS open, does not refresh the attended window, and marks its doorbell\'s events delivered (06 test 30 mid-turn, TC-CCI-20, R1-902)', async () => {
  const { h, events, rows, releases, sends } = await doorbellHarness();
  try {
    const r = await midTurnDoorbell(h, events, rows, 'c1c0-turnorigin-mid', releases, sends);
    assert.deepEqual(r.doorbellTurn, { promptId: 'p1', origin: 'human' });   // the running turn stays
    assert.equal(r.releasesAround, 0);                                       // no releaseSeat between its send and its reply
    assert.equal(r.promptsAround, 0);                                        // the SignalPump saw no prompt signal for it
    assert.equal(r.csOpen, true);                                            // Plan 3's table keeps the seat's CS open
    assert.ok(r.lastAfterP1 !== null);
    assert.equal(r.lastAfterDoorbell, r.lastAfterP1);                        // the attended window is not refreshed
    assert.deepEqual(events.seen.filter((x) => x.nonce === r.nonce).map((x) => x.nonce), [r.nonce]);   // nonceSeen(N) once
    const ev = r.lastTurnEvent!;
    assert.deepEqual({ op: ev.op, humanPromptRefreshed: ev.humanPromptRefreshed, csReset: ev.csReset, released: ev.released },
      { op: 'doorbell', humanPromptRefreshed: false, csReset: false, released: 0 });
  } finally {
    await h.cleanup();
  }
});

test('M44 is caught: under the mutant the same mid-turn doorbell refreshes the attended window and emits prompt; the clean run does neither (A6-11, plan 2801)', async () => {
  const { h, events, rows, releases, sends } = await doorbellHarness();
  const prev = process.env['COWORK_TEST_MUTANT'];
  try {
    const clean = await midTurnDoorbell(h, events, rows, 'c1c0-turnorigin-clean', releases, sends);
    await h.advance(1_000);                                                   // the M44 doorbell arrives at a later instant
    let mutant: Awaited<ReturnType<typeof midTurnDoorbell>>;
    try {
      mutant = await midTurnDoorbell(h, events, rows, 'c1c0-turnorigin-m44', releases, sends, () => { process.env['COWORK_TEST_MUTANT'] = 'M44'; });
    } finally {
      if (prev === undefined) delete process.env['COWORK_TEST_MUTANT'];
      else process.env['COWORK_TEST_MUTANT'] = prev;
    }
    assert.equal(clean.lastAfterDoorbell, clean.lastAfterP1);
    assert.equal(clean.promptsAround, 0);
    assert.notEqual(mutant.lastAfterDoorbell, mutant.lastAfterP1);            // M44: the attended window is refreshed
    assert.equal(mutant.promptsAround, 1);                                    // M44: one prompt signal
    assert.notDeepEqual([clean.lastAfterDoorbell === clean.lastAfterP1, clean.promptsAround], [mutant.lastAfterDoorbell === mutant.lastAfterP1, mutant.promptsAround]);
  } finally {
    await h.cleanup();
  }
});

/** The landed commit carrying a Cowork-CS trailer of `seatId`'s CS on `path`, walking back from the remote board tip. The
 * board commit carries the same Cowork-CS/Cowork-CS-Paths trailers the code commit does (ENG-42, R3-43; buildBoardCommit
 * writes `cs`/`csPaths`) in the very push that lands it, while the code mirror may lag one publish: ENG-43's code refspec
 * pushes TIP (the leased tip), so a publish's own C rides the next publish's spec — and INV-ENG-AUTH keeps the mirror
 * non-authoritative and lag-tolerant. C-14 re-gate (2026-11-12, PC 2): the helper walked the code mirror and missed a
 * just-landed CS; evidence t6-regate-diag-specs-3.log. */
async function liveTrailerOf(h: SeatHarness, seatId: string, path: string): Promise<{ origin: string; csId: string } | null> {
  const core = h.engines.peers[0]!.core;
  let oid = (await h.engines.remote.refs())[core.refs.remoteBoard] as Oid | undefined;
  for (let i = 0; i < 12 && oid !== undefined; i++) {
    const commit = await core.repo.readCommit(oid);
    const parsed = parseCsTrailers(commit.trailers);
    const mine = parsed.cs.filter((t) => t.csId.startsWith(`${seatId}/`));
    const hit = mine.find((t) => (parsed.paths.get(t.csId) ?? []).includes(path));
    if (hit !== undefined) return { origin: hit.origin, csId: hit.csId };
    oid = commit.parents[0];
  }
  return null;
}

test('a CS opened in a wake turn publishes with Cowork-CS … origin=wake, a human turn\'s with origin=prompt (BL2-15, R1-905, R1-124)', async () => {
  const h = await seatHarness({ peers: 2, humanLeaseMin: 0, bindings: { wakePolicy: ringPolicy } });
  try {
    await h.engines.startAll();
    const daemon = h.daemons[0]!;
    const ctx = daemon.ctx;
    const peer = h.engines.peers[0]!;
    const seat = h.fakeSeat(0, { socketValue: 'c1c0-turnorigin-trailer' });
    seat.mcpScript(['sent']);
    await seat.hello();
    await settle(100);
    const S = seat.seatId()!;
    const daemonSeat = ctx.seats.bySeatId(S)!;
    ctx.events.add(S, { code: 'SOME_EVENT', params: {}, family: 'fam', mandatory: false, slot: 'context' });   // one event queued, the seat idle
    void runTicker('ring', ctx);
    await until(() => seat.frames().some((f) => f.t === 'ring'), 'the ring frame');
    const ring = seat.frames().find((f) => f.t === 'ring') as { nonce: string; text: string };
    await until(() => daemonSeat.turn.pending.length === 1 && (daemonSeat.turn.pending[0] as { inFlight?: boolean }).inFlight !== true, "the ring's 'sent'");
    await seat.hook('UserPromptSubmit', { prompt: ring.text, prompt_id: 'p2' });   // the injected doorbell: a wake turn
    assert.equal(daemonSeat.turn.origin, 'wake');
    await writeWork(peer, 'src/a.ts', 'a = 1\n');
    await ctx.signals.send({ kind: 'effect', seat: S, agent: null, toolUseId: 'tu-w', paths: ['src/a.ts'], turnOrigin: ctx.turns.originOf(S) });
    await seat.hook('Stop', { prompt_id: 'p2' });
    let wake: { origin: string; csId: string } | null = null;
    for (let i = 0; i < 12 && wake === null; i++) {
      await h.engines.rounds(1);
      wake = await liveTrailerOf(h, S, 'src/a.ts');
    }
    assert.ok(wake !== null, 'the wake turn\'s CS reached the live tip');
    assert.equal(wake.origin, 'wake');
    await seat.hook('UserPromptSubmit', { prompt: 'now my own change', prompt_id: 'p3' });   // a human turn
    await writeWork(peer, 'src/b.ts', 'b = 1\n');
    await ctx.signals.send({ kind: 'effect', seat: S, agent: null, toolUseId: 'tu-h', paths: ['src/b.ts'], turnOrigin: ctx.turns.originOf(S) });
    await seat.hook('Stop', { prompt_id: 'p3' });
    let human: { origin: string; csId: string } | null = null;
    for (let i = 0; i < 12 && (human === null || human.csId === wake.csId); i++) {
      await h.engines.rounds(1);
      human = await liveTrailerOf(h, S, 'src/b.ts');
    }
    assert.ok(human !== null && human.csId !== wake.csId, 'the human turn\'s CS reached the live tip');
    assert.equal(human.origin, 'prompt');
    assert.equal(ctx.turns.recordOrigin(S, null), ctx.seats.peerId());
  } finally {
    await h.cleanup();
  }
});

// ---- I-2b (the LAST COMMIT, F2 #31 #60): the seat routing now passes the hook's prompt_id to onOtherHook for
// exactly the events otherHookEvent admits (all but UserPromptSubmit and UserPromptExpansion) — the two cells
// PC 2's implementer left waiting for the t5-server merge (report §1), over the real hook frames.

test('through real hook frames a hook carrying the recorded prompt_id is never wake, a new one after a sent post is (fallback (b), R5-36, F2 #31)', async () => {
  const { h, events, rows } = await doorbellHarness();
  try {
    const daemon = h.daemons[0]!;
    const seat = h.fakeSeat(0, { socketValue: 'c1c0-turnorigin-i2b-rec' });
    seat.mcpScript(['sent']);
    await seat.hello();
    await settle(100);
    const seatId = seat.seatId()!;
    const daemonSeat = daemon.ctx.seats.bySeatId(seatId)!;
    rows.push(row(seatId, 'c1c0-turnorigin-i2b-rec-e1'), row(seatId, 'c1c0-turnorigin-i2b-rec-e2'));
    void runTicker('ring', daemon.ctx);                            // the real Ringer, while the seat is IDLE
    await until(() => events.doorbell.length > 0, "the doorbell's post");
    await until(() => daemonSeat.turn.pending.length === 1 && (daemonSeat.turn.pending[0] as { inFlight?: boolean }).inFlight !== true, "the ring's 'sent'");
    assert.equal(daemonSeat.turn.pending[0]!.fallbackEligible, true);   // the sent post is (b)-eligible (no hook in the quiet window)
    // A real PreToolUse with a NEW prompt_id after the sent post is the (b) wake turn — the routing passes the id.
    await seat.hook('PreToolUse', { prompt_id: 'p1', tool_name: 'Edit', tool_use_id: 'c1c0-turnorigin-i2b-rec-tu1' });
    assert.equal(daemonSeat.turn.origin, 'wake');
    assert.equal(daemonSeat.turn.promptId, 'p1');                  // the old line passed null: this stayed null (RED)
    assert.equal(daemonSeat.turn.pending[0]!.fallbackEligible, false);  // the (b) spent that post (F2 #68)
    // A hook carrying the recorded prompt_id is a continuation of the recorded turn: no spend, no origin change.
    await seat.hook('PostToolUse', { prompt_id: 'p1', tool_name: 'Bash', tool_use_id: 'c1c0-turnorigin-i2b-rec-tu2' });
    assert.equal(daemonSeat.turn.origin, 'wake');
    assert.equal(daemonSeat.turn.recordedPromptId, 'p1');          // the old line passed null: this stayed null (RED)
    assert.equal(daemonSeat.turn.pending.length, 1);
    assert.equal(daemonSeat.turn.pending[0]!.fallbackEligible, false);
    // After the turn's Stop the recorded prompt_id still never wakes, and a new prompt_id does not either (the post was spent).
    await seat.hook('Stop', { prompt_id: 'p1' });
    assert.equal(daemonSeat.turn.origin, null);
    await seat.hook('PostToolUse', { prompt_id: 'p1', tool_name: 'Bash', tool_use_id: 'c1c0-turnorigin-i2b-rec-tu3' });
    assert.equal(daemonSeat.turn.origin, null);
    await seat.hook('PreToolUse', { prompt_id: 'p9', tool_name: 'Edit', tool_use_id: 'c1c0-turnorigin-i2b-rec-tu4' });
    assert.equal(daemonSeat.turn.origin, null);                    // no second (b): the sent post was spent
    assert.equal(daemonSeat.turn.recordedPromptId, 'p9');
  } finally {
    await h.cleanup();
  }
});

test('a human /cowork turn after a sent post (UserPromptExpansion then UserPromptSubmit with the same prompt_id) is human-origin; a later expansion is not refused once the pending wake has ended (F2 #60)', async () => {
  const { h, events, rows } = await doorbellHarness();
  try {
    const daemon = h.daemons[0]!;
    const seat = h.fakeSeat(0, { socketValue: 'c1c0-turnorigin-i2b-exp' });
    seat.mcpScript(['sent']);
    await seat.hello();
    await settle(100);
    const seatId = seat.seatId()!;
    const daemonSeat = daemon.ctx.seats.bySeatId(seatId)!;
    rows.push(row(seatId, 'c1c0-turnorigin-i2b-exp-e1'), row(seatId, 'c1c0-turnorigin-i2b-exp-e2'));
    void runTicker('ring', daemon.ctx);
    await until(() => events.doorbell.length > 0, "the doorbell's post");
    await until(() => daemonSeat.turn.pending.length === 1 && (daemonSeat.turn.pending[0] as { inFlight?: boolean }).inFlight !== true, "the ring's 'sent'");
    // While the wake is pending, the expansion (no nonce) is refused — 'wake' (Task 15 would not mint on it);
    // on the old null-passing line the (b) already fired at the expansion and the origin is 'wake' (RED here too).
    await seat.hook('UserPromptExpansion', { prompt_id: 'p1', verb: 'status' });
    assert.equal(daemonSeat.turn.origin, null);
    assert.equal(daemon.ctx.turns.classifyExpansion(daemonSeat, 'p1', []), 'wake');
    // The expansion's own nonce-less UserPromptSubmit with the same prompt_id is that turn's human start (F2 #60).
    await seat.hook('UserPromptSubmit', { prompt: '/cowork status', prompt_id: 'p1' });
    assert.equal(daemonSeat.turn.origin, 'human');
    assert.equal(daemonSeat.turn.promptId, 'p1');
    assert.equal(daemonSeat.turn.pending[0]!.humanPromptSincePost, true);   // A6-2: the nonce-less UPS marks the post ineligible
    assert.equal(daemon.ctx.turns.classifyExpansion(daemonSeat, 'p1', []), 'wake');   // still pending, so still refused
    // The pending wake ends (60 s); a later expansion is no longer refused.
    await h.advance(61_000);
    void runTicker('turns', daemon.ctx);                           // the expires ticker: pending wakes drop at 60 s
    await until(() => daemonSeat.turn.pending.length === 0, 'the pending wake expiry');
    assert.equal(daemon.ctx.turns.classifyExpansion(daemonSeat, 'p1', []), 'human');
  } finally {
    await h.cleanup();
  }
});
