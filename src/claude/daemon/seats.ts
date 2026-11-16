// src/claude/daemon/seats.ts — the MCP-pairing and seat registry (06 §3.11, CCI-31…CCI-33, INV-CCI-SEAT, R5-33, R5-34).
// Phase 1 declared the seat types (below, unchanged); Phase 2 (this file) is the real SeatRegistry. seat ids
// are minted by the MCP server (hello) or by the daemon after the 3 s pairing window (NO_MCP, randomHex(random, 16));
// the first id bound to a seat_key is kept for the seat's life (a later hello with another id is an alias); an ended
// seat stays known while it is among the newest ENDED_SEATS_KEPT ended seats (F2 #57), then it is forgotten.
// One health event per wiring/flag change (the display's code, R5-34); the once-per-cause HOOK_ONLY notice, re-armed
// by every hello that re-establishes the connection (F2 #100);
// activity from hooks only with one activity signal per change; the `seats` ticker runs the 3 s pairing mint,
// the 5 s pid checks and the heartbeat-loss check. Seat end queues one seat_end op, releases the seat's claims
// over the optional regions port (X-22, decision point 5-1), sends one seat_end signal, runs every onEnd
// callback once and traces `seat` `end`.
import type { McpHelloFrame, HookEvent } from '../wire/frames.js';
import type { Clock } from '../../ports/clock.js';
import type { Random } from '../../ports/random.js';
import type { Trace } from '../../ports/trace.js';
import type { CsSignal } from '../../holds/signals.js';
import type { OpDraft } from '../../board/ops.js';
import type { Params } from './claudeDaemon.js';
import type { SeatActivity } from './claudeDaemon.js';
import { C } from '../wire/constants.js';
import { randomHex } from '../../ports/random.js';
import { nullLog, type Log } from '../../ports/log.js';

/** A failure's text for DAEMON_INTERNAL_ERROR: name and message only, never a stack or file content (R-37). */
const errText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : 'unknown');

export type Wiring = 'FULL' | 'HOOK_ONLY' | 'NO_MCP' | 'NO_HOOKS';
export type SeatFlag = 'DEGRADED' | 'PAUSED' | 'PULL_MODE';

export const DISPLAY_PRECEDENCE: readonly ['NO_HOOKS', 'PAUSED', 'DEGRADED', 'NO_MCP', 'HOOK_ONLY', 'PULL_MODE', 'FULL']
  = Object.freeze(['NO_HOOKS', 'PAUSED', 'DEGRADED', 'NO_MCP', 'HOOK_ONLY', 'PULL_MODE', 'FULL'] as const);

/** A6-2: each pending wake keeps fallbackEligible and humanPromptSincePost (the `sent` post classification,
 *  Task 6); the seat's posted nonces and prompt_id outlive the 60 s pending-wake expiry. */
export interface TurnState { promptId: string | null; origin: 'human' | 'wake' | null; recordedPromptId: string | null;
  pending: ReadonlyArray<{ nonce: string; sentMono: number; eventIds: readonly string[]; fallbackEligible: boolean; humanPromptSincePost: boolean }>;
  lastHumanPromptMono: number | null; wakeTurnStartMono: number | null; }

export interface Seat {
  readonly seatId: string | null;     // 32 lowercase hex; minted by the MCP server, or by the daemon after the 3 s pairing window (NO_MCP)
  readonly seatKey: string; readonly claudePid: number; readonly number: number;   // "session N" (R5-33)
  readonly aliases: readonly string[]; readonly sessionIds: ReadonlySet<string>;
  readonly createdMono: number;       // A5-2
  wiring: Wiring; flags: Set<SeatFlag>; wiringCause: string | null; activity: SeatActivity;   // A5-2
  lastHookMono: number | null; lastHeartbeatMono: number | null; mcpConnected: boolean; ccVersion: string | null;
  pluginVersion: string; hookProto: number; permissionMode: string; turn: TurnState; ended: boolean;
}

/** The optional regions port of the ctx (decision point 5-1): the pinned constructor ctx has no regions
 *  member; seat end must call regions.releaseClaims({peer, seat}, 'seat_end', 'all') once (X-22). Added as an
 *  optional member so every pinned member is unchanged; Phase 3's composition passes the RegionsPort. */
interface RegionsEndPort {
  releaseClaims(holder: { peer: string; seat: string }, reason: string, target: readonly string[] | 'all'): unknown;
}

/** Trace events: `seat` events with op register | alias | wiring | flag | end (src/ports/trace.ts). */
type SeatTrace = Extract<import('../../ports/trace.js').TraceEvent, { kind: 'seat' }>;

interface RegistrySeat {
  seatId: string | null;
  seatKey: string;
  claudePid: number;
  number: number;
  aliases: string[];
  sessionIds: Set<string>;
  createdMono: number;
  wiring: Wiring;
  flags: Set<SeatFlag>;
  wiringCause: string | null;
  activity: SeatActivity;
  lastHookMono: number | null;
  lastHeartbeatMono: number | null;
  mcpConnected: boolean;
  ccVersion: string | null;
  pluginVersion: string;
  hookProto: number;
  permissionMode: string;
  turn: TurnState;
  ended: boolean;
  endedMono: number | null;
  lastPidCheckMono: number | null;
  noticesByCause: Map<string, boolean>;
  awaitResolvers: Array<() => void>;
  seatStartQueued: boolean;
}

/** One health event per change of the seat's wiring or flags (R5-34): the code of the new display. */
const CODE_OF: Readonly<Record<string, string>> = Object.freeze({
  FULL: 'SEAT_FULL', NO_MCP: 'SEAT_NO_MCP', HOOK_ONLY: 'HOOK_ONLY', NO_HOOKS: 'NOHOOKS',
  DEGRADED: 'DEGRADED', PAUSED: 'PAUSED', PULL_MODE: 'SEAT_PULL_MODE',
});

/** F2 #57: the newest ended seats kept whole (every consumer — the seat lease's ended-seat reads, the late-hello rule,
 *  seats() — behaves as for any recent end); an older ended seat is forgotten, so the registry's memory is bounded by
 *  the live seats plus this many. Seat numbers are never reused (nextNumber is unaffected). */
export const ENDED_SEATS_KEPT = 256;

const emptyTurn = (): TurnState =>
  ({ promptId: null, origin: null, recordedPromptId: null, pending: [], lastHumanPromptMono: null, wakeTurnStartMono: null });

export class SeatRegistry {
  private readonly clock: Clock;  private readonly random: Random;
  private readonly trace: Trace;
  private peer: string;
  private readonly outbox: (draft: Extract<OpDraft, { type: 'seat_start' | 'seat_end' | 'event' }>) => void;
  private readonly pidAliveFn: (pid: number) => boolean;
  private readonly noticeFn: (seatId: string, code: string, params: Params) => void;
  private readonly signals: { send(s: CsSignal): void };
  private readonly regions: RegionsEndPort | null;
  private readonly byKeyMap = new Map<string, RegistrySeat>();
  private readonly byIdMap = new Map<string, RegistrySeat>();
  private readonly order: RegistrySeat[] = [];
  private readonly endedOrder: RegistrySeat[] = [];   // ended seats, oldest end first (F2 #57)
  private nextNumber = 1;
  private readonly endCbs: Array<(seat: Seat) => Promise<void>> = [];
  /** The Log that isolates an onEnd subscriber's throw as DAEMON_INTERNAL_ERROR (F2 #110; nullLog without one). */
  private readonly log: Log;
  /** The registry's pid liveness dependency, also the SeatLeaseSource clause (c) reads. */
  pidAlive(pid: number): boolean { return this.pidAliveFn(pid); }

  /** A5-3 (as amended by R5-55), plus two additive optional members: `regions` (X-22's seat-end claim release,
   *  decision point 5-1) and `onLeaseLost` (X-40's report target, wired by Task 6's signal module). */
  constructor(ctx: { clock: Clock; random: Random; trace: Trace; peer: string; outbox: (draft: Extract<OpDraft, { type: 'seat_start' | 'seat_end' | 'event' }>) => void; pidAlive: (pid: number) => boolean;
    notice: (seatId: string, code: string, params: Params) => void; signals: { send(s: CsSignal): void };
    regions?: RegionsEndPort; onLeaseLost?: (seatId: string) => void; log?: Log }) {
    this.clock = ctx.clock;
    this.random = ctx.random;
    this.trace = ctx.trace;
    this.peer = ctx.peer;
    this.outbox = ctx.outbox;
    this.pidAliveFn = ctx.pidAlive;
    this.noticeFn = ctx.notice;
    this.signals = ctx.signals;
    this.regions = ctx.regions ?? null;
    this.log = ctx.log ?? nullLog;   // F2 #110: the daemon Log isolates an onEnd subscriber's throw (F2 #57's listeners)
    void ctx.onLeaseLost;
  }

  /** CCI-31: the first hook or hello for a seat_key creates the seat (seatId null until bound or minted). */
  fromHook(h: { seat_key: string; claude_pid: number; session_id: string; permission_mode?: string; plugin_version?: string; hook_proto?: number }): Seat {
    const now = this.clock.monoMs();
    let seat = this.byKeyMap.get(h.seat_key);
    if (seat === undefined) {
      seat = this.create(h.seat_key, h.claude_pid, now, h.plugin_version ?? '', h.hook_proto ?? 0, h.permission_mode ?? 'default');
      this.traceSeat(seat, 'register', null, null, h.session_id, null);
    }
    seat.sessionIds.add(h.session_id);
    seat.lastHookMono = now;
    seat.claudePid = h.claude_pid;
    if (h.permission_mode !== undefined) seat.permissionMode = h.permission_mode;
    return seat as unknown as Seat;
  }

  /** A hello binds the first id (FULL with messaging present, HOOK_ONLY without); another id is an alias, never a re-key. */
  fromHello(f: McpHelloFrame): Seat {
    const now = this.clock.monoMs();
    let seat = this.byKeyMap.get(f.seat_key);
    if (seat === undefined) {
      seat = this.create(f.seat_key, f.claude_pid, now, f.plugin_version, f.hook_proto, 'default');
      this.traceSeat(seat, 'register', null, null, null, null);
    }
    if (seat.ended) return seat as unknown as Seat;   // nothing after an end (O-SEAT): a late hello touches nothing
    seat.claudePid = f.claude_pid;
    seat.ccVersion = f.cc_version;
    seat.pluginVersion = f.plugin_version;
    seat.hookProto = f.hook_proto;
    seat.mcpConnected = true;
    seat.lastHeartbeatMono = now;
    if (seat.seatId === null) {
      seat.seatId = f.seat_id;
      this.byIdMap.set(f.seat_id, seat);
      this.setWiringInner(seat, f.messaging_present ? 'FULL' : 'HOOK_ONLY', f.messaging_present ? null : 'no_messaging');
      this.traceSeat(seat, 'wiring', null, seat.wiring, null, seat.wiringCause);   // the bind itself: a first hello's wiring may not change (already FULL)
      this.queueSeatStart(seat);
      this.queueHealth(seat);   // the first bind's health event even when the wiring display did not change
      if (!f.messaging_present) this.noticeOnce(seat as unknown as Seat, 'HOOK_ONLY', { cause: 'no_messaging' });
      for (const r of seat.awaitResolvers.splice(0)) r();
    } else {
      if (f.seat_id !== seat.seatId && !seat.aliases.includes(f.seat_id)) {
        seat.aliases.push(f.seat_id);
        this.byIdMap.set(f.seat_id, seat);
        this.traceSeat(seat, 'alias', f.seat_id, null, null, null);
      }
      this.reestablished(seat, f.messaging_present);
    }
    return seat as unknown as Seat;
  }

  /** F2 #100 (06 §3.11.4, plan:2738): a hello on a bound, live seat (the same id or an alias) re-establishes the MCP
   *  connection: the mcp_lost notice is re-armed (a later loss notices again); with messaging the seat is FULL and the
   *  cause it leaves is re-armed too; without messaging it is HOOK_ONLY 'no_messaging' with its once-per-cause notice. */
  private reestablished(seat: RegistrySeat, messaging: boolean): void {
    seat.noticesByCause.delete('mcp_lost');
    if (messaging) {
      const prev = seat.wiringCause;
      this.setWiringInner(seat, 'FULL', null);
      if (prev !== null) seat.noticesByCause.delete(prev);
    } else {
      this.setWiringInner(seat, 'HOOK_ONLY', 'no_messaging');
      this.noticeOnce(seat as unknown as Seat, 'HOOK_ONLY', { cause: 'no_messaging' });
    }
  }

  /** Resolves the MCP hello's id when one arrives first; else mints at min(createdMono + 3 s, untilMono) with NO_MCP. */
  async awaitBound(seatIn: Seat, untilMono: number): Promise<string> {
    const seat = seatIn as unknown as RegistrySeat;
    if (seat.seatId !== null) return seat.seatId;
    const deadline = Math.min(seat.createdMono + C.MCP_PAIRING_MS, untilMono);
    const wait = Math.max(0, deadline - this.clock.monoMs());
    if (wait > 0) {
      await Promise.race([this.clock.sleep(wait), new Promise<void>((res) => seat.awaitResolvers.push(res))]);
    }
    if (seat.seatId !== null) return seat.seatId;
    const id = randomHex(this.random, 16);
    seat.seatId = id;
    this.byIdMap.set(id, seat);
    this.setWiringInner(seat, 'NO_MCP', null);
    this.queueSeatStart(seat);
    return id;
  }

  onHeartbeat(seatIn: Seat): void {
    const seat = seatIn as unknown as RegistrySeat;
    seat.lastHeartbeatMono = this.clock.monoMs();
    seat.mcpConnected = true;
  }

  /** MCP connection lost while the pid lives (hooks keep arriving): HOOK_ONLY 'mcp_lost'. The once-per-cause
   *  notice resets when the connection is re-established (a reconnect hello, reestablished), so a later loss —
   *  this one or the seats ticker's heartbeat gap — notices again. */
  onMcpClosed(seatIn: Seat): void {
    const seat = seatIn as unknown as RegistrySeat;
    seat.mcpConnected = false;
    if (seat.ended || seat.wiring === 'HOOK_ONLY') return;
    seat.noticesByCause.delete('mcp_lost');
    this.setWiringInner(seat, 'HOOK_ONLY', 'mcp_lost');
    this.noticeOnce(seat as unknown as Seat, 'HOOK_ONLY', { cause: 'mcp_lost' });
  }

  /** F2 #57: null means the seat ended (it may have been forgotten among older ended seats) or never existed; no
   *  consumer may read null as live. seatActivity answers 'ENDED' for such an id. */
  bySeatId(id: string): Seat | null { return (this.byIdMap.get(id) as unknown as Seat) ?? null; }
  byKey(key: string): Seat | null { return (this.byKeyMap.get(key) as unknown as Seat) ?? null; }

  seats(): ReadonlyArray<{ seat_id: string; number: number; activity: SeatActivity; wiring: Wiring; flags: readonly SeatFlag[]; lastHookMono: number | null }> {
    return this.order.filter((s) => s.seatId !== null).map((s) => ({
      seat_id: s.seatId!, number: s.number, activity: s.activity, wiring: s.wiring, flags: [...s.flags], lastHookMono: s.lastHookMono,
    }));
  }

  seatActivity(seatId: string): SeatActivity {
    const s = this.byIdMap.get(seatId);
    return s === undefined ? 'ENDED' : s.activity;
  }

  seatWiring(seatId: string): { wiring: Wiring; flags: readonly SeatFlag[]; display: Wiring | SeatFlag } {
    const s = this.byIdMap.get(seatId);
    if (s === undefined) throw new Error(`seatWiring: no seat ${seatId}`);
    return { wiring: s.wiring, flags: [...s.flags], display: displayOf(s) };
  }

  setWiring(seatIn: Seat, w: Wiring, cause: string | null): void {
    const seat = seatIn as unknown as RegistrySeat;
    const was = { wiring: seat.wiring, cause: seat.wiringCause };
    this.setWiringInner(seat, w, cause);
    // The once-per-cause notice on entering HOOK_ONLY (the caller's cause; Task 9's policyWiring reuses noticeOnce).
    if (w === 'HOOK_ONLY' && (was.wiring !== 'HOOK_ONLY' || was.cause !== cause)) {
      this.noticeOnce(seatIn, 'HOOK_ONLY', { cause: cause ?? '' });
    }
  }

  setFlag(seatIn: Seat, f: SeatFlag, on: boolean): void {
    const seat = seatIn as unknown as RegistrySeat;
    const had = seat.flags.has(f);
    if (on === had) return;
    if (on) seat.flags.add(f); else seat.flags.delete(f);
    this.traceSeat(seat, 'flag', null, null, null, f);
    this.queueHealth(seat);
  }

  /** 06 §3.11.2a: activity from hooks only; one activity signal per change, never on unchanged. */
  observeActivity(seatIn: Seat, ev: HookEvent, p: unknown): void {
    const seat = seatIn as unknown as RegistrySeat;
    seat.lastHookMono = this.clock.monoMs();
    const next = activityOf(ev, p);
    if (next !== null && next !== seat.activity) {
      seat.activity = next;
      this.signals.send({ kind: 'activity', seat: seat.seatId ?? '', activity: next });
    }
  }

  /** Seat end: one seat_end draft, one claim release (X-22), one signal, every onEnd once; a second end is a no-op. */
  async end(seatIn: Seat, why: 'mcp_eof' | 'pid_gone'): Promise<void> {
    const seat = seatIn as unknown as RegistrySeat;
    if (seat.ended) return;
    seat.ended = true;
    seat.endedMono = this.clock.monoMs();
    if (seat.activity !== 'ENDED') {
      seat.activity = 'ENDED';
      this.signals.send({ kind: 'activity', seat: seat.seatId ?? '', activity: 'ENDED' });
    }
    this.signals.send({ kind: 'seat_end', seat: seat.seatId ?? '' });
    if (seat.seatId !== null) {
      this.outbox({ type: 'seat_end', seat_id: seat.seatId, permission_mode: seat.permissionMode });
      this.regions?.releaseClaims({ peer: this.peer, seat: seat.seatId }, 'seat_end', 'all');
    }
    this.traceSeat(seat, 'end', null, null, null, why);
    this.endedOrder.push(seat);
    while (this.endedOrder.length > ENDED_SEATS_KEPT) this.forget(this.endedOrder.shift()!);   // F2 #57
    for (const cb of this.endCbs) {
      try { await cb(seat as unknown as Seat); }
      catch (e) { this.log.write('error', 'DAEMON_INTERNAL_ERROR', { where: 'seat.onEnd', error: errText(e) }); }   // F2 #110
    }
  }

  /** F2 #57: drops an old ended seat from every index (a map entry only where it still names this seat). */
  private forget(seat: RegistrySeat): void {
    const at = this.order.indexOf(seat);
    if (at >= 0) this.order.splice(at, 1);
    if (this.byKeyMap.get(seat.seatKey) === seat) this.byKeyMap.delete(seat.seatKey);
    for (const id of [seat.seatId, ...seat.aliases]) {
      if (id !== null && this.byIdMap.get(id) === seat) this.byIdMap.delete(id);
    }
  }

  /** Test-only introspection (F2 #57's bound): the sizes of the registry's three indexes. */
  sizesForTest(): { order: number; byKey: number; byId: number } {
    return { order: this.order.length, byKey: this.byKeyMap.size, byId: this.byIdMap.size };
  }

  onEnd(cb: (seat: Seat) => Promise<void>): void { this.endCbs.push(cb); }

  /** A5-11's pid-gone checks and the trace peer: the composition's id until attach, then the engine's (bindPeer). */
  peerId(): string { return this.peer; }

  /** F2 #98 (decision 7-3): the attached engine's peer id, set by every attach; the seat-end claim release (X-22),
   *  the seat traces and peerId() carry it from then on. */
  bindPeer(peer: string): void { this.peer = peer; }

  /** The `seats` ticker: the 3 s pairing mint, the 5 s pid checks, the heartbeat-loss → HOOK_ONLY check. */
  async tick(): Promise<void> {
    const now = this.clock.monoMs();
    for (const seat of [...this.order]) {   // a snapshot: an end inside this loop may forget an old ended seat (F2 #57)
      if (seat.ended) continue;
      // Pairing window: a still-unbound seat whose 3 s elapsed mints here too (awaitBound is not the only path).
      if (seat.seatId === null && now - seat.createdMono >= C.MCP_PAIRING_MS) {
        const id = randomHex(this.random, 16);
        seat.seatId = id;
        this.byIdMap.set(id, seat);
        this.setWiringInner(seat, 'NO_MCP', null);
        this.queueSeatStart(seat);
        for (const r of seat.awaitResolvers.splice(0)) r();
        continue;
      }
      // 5 s pid check (C.CLAUDE_PID_CHECK_MS): pid gone → seat end 'pid_gone'.
      if (now - (seat.lastPidCheckMono ?? seat.createdMono) >= C.CLAUDE_PID_CHECK_MS) {
        seat.lastPidCheckMono = now;
        if (!this.pidAliveFn(seat.claudePid)) { await this.end(seat as unknown as Seat, 'pid_gone'); continue; }
      }
      // Heartbeat gap on an open connection with hooks arriving → HOOK_ONLY 'mcp_lost'.
      if (seat.mcpConnected && seat.wiring !== 'HOOK_ONLY' && seat.lastHeartbeatMono !== null && seat.lastHookMono !== null
        && now - seat.lastHeartbeatMono > C.SEAT_HEARTBEAT_VALID_MS && seat.lastHookMono > seat.lastHeartbeatMono) {
        this.setWiringInner(seat, 'HOOK_ONLY', 'mcp_lost');
        this.noticeOnce(seat as unknown as Seat, 'HOOK_ONLY', { cause: 'mcp_lost' });
      }
    }
  }

  /** SeatLeasePort's view (06 §3.17.1): per live seat, its lease state. hookWithinValidity = any hook within SEAT_HEARTBEAT_VALID_MS. */
  leaseSeats(): ReadonlyArray<{ seatId: string | null; lastHeartbeatMono: number | null; lastHookMono: number | null; hookWithinValidity: boolean; noMcp: boolean; claudePid: number; endedMono: number | null }> {
    const now = this.clock.monoMs();
    return this.order.map((s) => ({
      seatId: s.seatId, lastHeartbeatMono: s.ended ? null : s.lastHeartbeatMono, lastHookMono: s.ended ? null : s.lastHookMono,
      hookWithinValidity: !s.ended && s.lastHookMono !== null && now - s.lastHookMono <= C.SEAT_HEARTBEAT_VALID_MS,
      noMcp: s.wiring === 'NO_MCP', claudePid: s.claudePid, endedMono: s.endedMono,
    }));
  }

  /** One PEER_IDLE health draft per idle entry (the lease port calls it once, through the same outbox path). */
  queuePeerIdle(): void {
    this.outbox({ type: 'event', cid: '', kind: 'health', refs: [], reason_code: 'PEER_IDLE' });
  }

  // ---------------------------------------------------------------- internals

  private create(key: string, pid: number, now: number, pluginVersion: string, hookProto: number, permissionMode: string): RegistrySeat {
    const seat: RegistrySeat = {
      seatId: null, seatKey: key, claudePid: pid, number: this.nextNumber++, aliases: [], sessionIds: new Set<string>(),
      createdMono: now, wiring: 'FULL', flags: new Set(), wiringCause: null, activity: 'IDLE',
      lastHookMono: null, lastHeartbeatMono: null, mcpConnected: false, ccVersion: null,
      pluginVersion, hookProto, permissionMode, turn: emptyTurn(), ended: false, endedMono: null,
      lastPidCheckMono: null, noticesByCause: new Map(), awaitResolvers: [], seatStartQueued: false,
    };
    this.byKeyMap.set(key, seat);
    this.order.push(seat);
    this.queueHealth(seat);   // the initial wiring's health event (bullet 10: a registered seat queues its health event)
    return seat;
  }

  private queueSeatStart(seat: RegistrySeat): void {
    if (seat.seatStartQueued || seat.seatId === null) return;
    seat.seatStartQueued = true;
    this.outbox({ type: 'seat_start', seat_id: seat.seatId, permission_mode: seat.permissionMode });
  }

  private traceSeat(seat: RegistrySeat, op: SeatTrace['op'], seatId: string | null, wiring: string | null, sessionId: string | null, why: string | null): void {
    this.trace.emit({ kind: 'seat', peer: this.peer, seat: seatId ?? seat.seatId, op, sessionId, wiring, flags: [...seat.flags], why,
      seat_key: seat.seatKey, seat_number: seat.number } as unknown as SeatTrace);
  }

  private setWiringInner(seat: RegistrySeat, w: Wiring, cause: string | null): void {
    if (seat.wiring === w && seat.wiringCause === cause) return;
    seat.wiring = w;
    seat.wiringCause = cause;
    this.traceSeat(seat, 'wiring', null, w, null, cause);
    this.queueHealth(seat);
  }

  /** Exactly one health draft per display change, with the code of the new display (R5-34). */
  private queueHealth(seat: RegistrySeat): void {
    if (seat.seatId === null) return;   // the draft carries the seat_id; a bound seat always has one
    this.outbox({ type: 'event', cid: '', kind: 'health', refs: [seat.seatId], reason_code: CODE_OF[displayOf(seat)]! });
  }

  /** The once-per-cause HOOK_ONLY notice (06 §3.11.4). */
  noticeOnce(seat: Seat, code: string, params: Params): void {
    const s = seat as unknown as RegistrySeat;
    const cause = String((params as { cause?: string }).cause ?? '');
    if (s.noticesByCause.get(cause) === true) return;
    s.noticesByCause.set(cause, true);
    if (s.seatId !== null) this.noticeFn(s.seatId, code, params);   // F2 #9 Carry: the store drops a '' target, so an unbound seat keeps no notice
  }
}

/** Display per the glossary §3 precedence (the first matching row wins). */
function displayOf(s: RegistrySeat): Wiring | SeatFlag {
  if (s.wiring === 'NO_HOOKS') return 'NO_HOOKS';
  if (s.flags.has('PAUSED')) return 'PAUSED';
  if (s.flags.has('DEGRADED')) return 'DEGRADED';
  if (s.wiring === 'NO_MCP') return 'NO_MCP';
  if (s.wiring === 'HOOK_ONLY') return 'HOOK_ONLY';
  if (s.flags.has('PULL_MODE')) return 'PULL_MODE';
  return 'FULL';
}

/** Activity from hooks only (06 §3.11.2a); null = the event leaves the activity unchanged. */
function activityOf(ev: HookEvent, p: unknown): SeatActivity | null {
  switch (ev) {
    case 'UserPromptSubmit':
    case 'UserPromptExpansion':
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return 'MID_TURN';
    case 'Stop': {
      const bg = (p as { background_tasks_running?: number }).background_tasks_running ?? 0;
      return bg > 0 ? 'MID_TURN' : 'IDLE';
    }
    case 'StopFailure':
      return 'IDLE';
    case 'Notification': {
      const type = (p as { type?: string }).type;
      return type === 'permission_prompt' ? 'AWAITING_PERMISSION' : type === 'idle_prompt' ? 'IDLE' : null;
    }
    default:
      return null;
  }
}
