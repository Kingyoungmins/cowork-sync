// src/claude/daemon/seatLease.ts — the seat-lease LeasePort binding (CCI-50, R-11, R5-35; 06 §3.17.1).
// A seat's lease is valid while (a) its last heartbeat is ≤ SEAT_HEARTBEAT_VALID_MS old, (b) a hook from the
// seat arrived within the validity window (any hook refreshes the seat's lease), or (c) it is a live (not
// ended) NO_MCP seat whose claude pid is alive — one pidAlive probe per seat per idleMs() call; an ended seat
// never counts (plan 2743). The human lease (renewHuman 60 min from an accepted acting verb, grantHuman
// clamped 1–480) holds the peer awake on its own. idleMs() is 0 while any lease is valid, else Δmono since
// the newest lease's validity ended. Entering idle fires onIdle(true) once and queues one PEER_IDLE health
// draft through the registry's health-draft path (queuePeerIdle); a lease valid again fires onIdle(false)
// once, no event. X-40 (decision point 5-2): the pinned constructor is (seats, clock, onIdle); the
// lease-lost report to coordHooks.onLeaseLost is added as an optional 4th constructor param — a setter
// would leave a window where a loss is missed before the setter runs. It fires once per loss episode: when a
// seat's own lease stops being valid, and again only after a read saw it valid in between (F2 #54, #102).
import type { Clock } from '../../ports/clock.js';
import type { LeasePort } from '../../ports/lease.js';
import { C } from '../wire/constants.js';

/** The registry surface SeatLeasePort reads (structural; the real SeatRegistry satisfies it). */
export interface SeatLeaseSource {
  /** Per live/ended seat: its lease state — the last heartbeat mono (null = none yet), the last hook mono (for the hook-within-validity clause and its expiry), whether a hook arrived within the validity window, wiring NO_MCP, its pid, its seat_id, its end mono when ended. */
  leaseSeats(): ReadonlyArray<{ seatId: string | null; lastHeartbeatMono: number | null; lastHookMono: number | null; hookWithinValidity: boolean; noMcp: boolean; claudePid: number; endedMono: number | null }>;
  /** The registry's pid liveness dependency (the same one its 5 s ticker uses). */
  pidAlive(pid: number): boolean;
  /** Queues one health draft (kind 'health', refs [seatId], reason_code) through the registry's outbox path. */
  queuePeerIdle(): void;
}

export class SeatLeasePort implements LeasePort {
  private lastValidUntilMono: number | null = null;  // the newest validity end observed while any lease was valid
  private idle = false;
  private humanUntilMono: number | null = null;
  private reportedLost = new Set<string>(); // X-40: the seats whose current loss episode was reported; a valid read clears the entry
  private readonly seats: SeatLeaseSource;
  private readonly clock: Clock;
  private readonly onIdle: (entered: boolean) => void;
  private readonly onLeaseLost: ((seatId: string) => void) | null;

  constructor(seats: SeatLeaseSource, clock: Clock, onIdle: (entered: boolean) => void,
    onLeaseLost?: (seatId: string) => void) {
    this.seats = seats;
    this.clock = clock;
    this.onIdle = onIdle;
    this.onLeaseLost = onLeaseLost ?? null;
    this.constructedMono = clock.monoMs();
  }

  idleMs(): number {
    const now = this.clock.monoMs();
    const valid: number[] = [];
    const list = this.seats.leaseSeats();   // one read per call, shared by the validity and the idle passes
    for (const s of list) {
      const hbValid = s.lastHeartbeatMono !== null && now - s.lastHeartbeatMono <= C.SEAT_HEARTBEAT_VALID_MS;
      // Clause (c): a live NO_MCP seat's pid, probed once per call; an ended seat never counts (plan 2743), so a
      // recycled pid of an ended NO_MCP seat keeps nothing valid and is not probed at all (F2 #54).
      const pidValid = s.noMcp && s.endedMono === null && this.seats.pidAlive(s.claudePid);
      const ok = hbValid || s.hookWithinValidity || pidValid;
      // Each lease's own expiry, valid or not: the heartbeat's clause and the hook's clause (a hook at t
      // keeps the seat valid to t + SEAT_HEARTBEAT_VALID_MS, 06 §3.17.1). A NO_MCP live pid keeps the seat
      // valid for as long as the pid lives, so its expiry is "now" on every read.
      if (hbValid) valid.push(s.lastHeartbeatMono! + C.SEAT_HEARTBEAT_VALID_MS);
      if (s.hookWithinValidity) valid.push((s.lastHookMono ?? now) + C.SEAT_HEARTBEAT_VALID_MS);
      if (pidValid) valid.push(now);
      // X-40: one report per loss episode — a valid lease ends the episode, so a later loss reports again (F2 #102).
      if (s.seatId !== null) {
        if (ok) this.reportedLost.delete(s.seatId);
        else if (!this.reportedLost.has(s.seatId)) {
          this.reportedLost.add(s.seatId);
          this.onLeaseLost?.(s.seatId);
        }
      }
    }
    const humanValid = this.humanUntilMono !== null && now < this.humanUntilMono;
    if (humanValid) valid.push(this.humanUntilMono!);
    if (valid.length > 0) {
      const until = Math.max(...valid);
      if (this.lastValidUntilMono === null || until > this.lastValidUntilMono) this.lastValidUntilMono = until;
      if (this.idle) this.onIdle(false);
      this.idle = false;
      return 0;
    }
    // Idle: Δmono since the newest lease's validity ended. A lease's end is its own expiry even when no
    // read observed it valid (the heartbeat/hook expiry above), or its end instant when it never had one.
    for (const s of list) {
      const expiry = s.lastHeartbeatMono !== null ? s.lastHeartbeatMono + C.SEAT_HEARTBEAT_VALID_MS : null;
      const end = s.endedMono;
      const cand = expiry !== null && end !== null ? Math.max(expiry, end) : (expiry ?? end);
      if (cand !== null && (this.lastValidUntilMono === null || cand > this.lastValidUntilMono)) {
        this.lastValidUntilMono = cand;
      }
    }
    if (!this.idle) {
      this.idle = true;
      this.onIdle(true);
      this.seats.queuePeerIdle();
    }
    // A lease whose end was never observed (never valid) idles from construction: its end instant is the
    // constructor's now (the composition's), so idleMs() grows from the first read (contract 2765: with no
    // human lease the FULL seat idles after 45 s — R5-35).
    if (this.lastValidUntilMono === null) this.lastValidUntilMono = this.constructedMono;
    return Math.max(0, now - this.lastValidUntilMono);
  }

  /** 60 min from an accepted acting verb (SEC-25 step 7). */
  renewHuman(): void {
    this.humanUntilMono = this.clock.monoMs() + C.HUMAN_LEASE_MS;
  }

  /** 1–480 min (LIF-41; Plan 7 calls); outside the clamp → RangeError. */
  grantHuman(minutes: number): void {
    if (!(Number.isInteger(minutes) && minutes >= 1 && minutes <= C.HUMAN_LEASE_MAX_MIN)) {
      throw new RangeError(`grantHuman: expected an integer 1..${C.HUMAN_LEASE_MAX_MIN}, got ${minutes}`);
    }
    this.humanUntilMono = this.clock.monoMs() + minutes * 60_000;
  }

  private readonly constructedMono: number;
}
