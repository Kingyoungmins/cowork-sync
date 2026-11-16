// src/claude/daemon/ring.ts — the doorbell daemon half (06 §3.16.5, CCI-49 daemon side, R5-37, R2-H16, Q-8; Task 6).
// Plan 5 posts (Ringer, RingDriver, mintNonce, NONCE_RE — the only ones; X-42) and Plan 6 decides (WakePolicy).
// V-10 (Plan 6's O-2/O-5): the RingDriver mints the nonce BEFORE it asks and passes it, so Plan 6's text ends with
// its DB.foot `ref <nonce>`; a null answer (coalescing) and 'not_rung' leave the ids offerable at the next tick, an
// id that rode a post of any result is never offered again (it stays for the pull carriers); the optional
// policy.onRingResult is called once per shouldRing answer, with the offer's nonce even for 'not_rung'. With
// neverRing (production, R5-37) no ring is ever composed. Task 7's EventStore has landed: pending() and
// doorbellSent() do not throw, so neither call is guarded here (F2 #59).
// L-TOKEN: this file imports nothing of src/ports/inbox.ts (the daemon has no code path that opens an inbox socket).
import { randomHex, type Random } from '../../ports/random.js';
import { NONCE_RE } from '../wire/hookInput.js';
import type { SessionServerFrame } from '../wire/frames.js';
import { C } from '../wire/constants.js';
import type { DaemonCtx } from './ctx.js';
import { registerTicker } from './pipeline.js';

/** Plan 6 deletes its post.ts postDoorbell/RingResult (X-42); a post's outcome kinds ('sent' | 'refused' | 'error')
 *  and 'not_rung' (the seat could not be rung). The poster itself is Task 6's Ringer/RingDriver (INV-TOKEN). */
export type PostResult = 'sent' | 'refused' | 'error';

export interface WakePolicy {
  shouldRing(seatId: string, eventIds: readonly string[], nonce: string): { text: string } | null;
  onRingResult?(seatId: string, eventIds: readonly string[], result: PostResult | 'not_rung', nonce: string): void;
}

/** R5-37, production and REAL now: the policy never rings, so no production wake turn exists before Plan 6. */
export const neverRing: WakePolicy = Object.freeze({
  shouldRing: (): null => null,
});

/** SIM and FakeHost only (R5-37): plan5Bindings({testBuild: true}) overrides bind it. */
export function scriptedRing(script: (seatId: string, eventIds: readonly string[], nonce: string) => { text: string } | null): WakePolicy {
  return { shouldRing: (seatId, eventIds, nonce) => script(seatId, eventIds, nonce) };
}

/** 'cws-' + 16 lowercase hex (seeded in SIM, CSPRNG binding in production; 07 §3.13). */
export function mintNonce(random: Random): string {
  return `cws-${randomHex(random, 8)}`;
}

type RingOutcome = 'sent' | 'refused' | 'error' | 'not_rung';

export class Ringer {
  private readonly waits = new Map<string, { resolve: (r: PostResult) => void; seatId: string; eventIds: readonly string[] }>();
  /** Phase 3a-1: constructible (Task 6 owns the bodies); `send` is ClaudeServer.sendToSeat (composition). */
  constructor(private readonly ctx: DaemonCtx, private readonly send: (seatId: string, f: Extract<SessionServerFrame, { t: 'ring' }>) => boolean) {}

  /** A6-7: no ring to a MID_TURN seat or one without an MCP connection → 'not_rung', nothing sent; a text over
   *  C.CAPS.DOORBELL, starting with '/', or not carrying the passed nonce exactly once → 'error', nothing sent;
   *  a valid ring sends exactly that nonce and waits ≤ C.RING_RESULT_WAIT_MS for its ring_result (missing →
   *  'error'). R-F2-17 (F2 #61): right after the frame is sent the pending wake is registered in flight
   *  (TurnOrigin.onRingInFlight), so a nonce UserPromptSubmit that beats ring_result is the doorbell. On 'sent'
   *  TurnOrigin.onRingSent marks it sent and the events are marked doorbell-carried (EventStore.doorbellSent) — each
   *  exactly once; when the nonce was already seen, EventStore.nonceSeen follows, delivering the events the early
   *  UserPromptSubmit could not (nonceSeen never delivers twice). 'refused' and 'error' clear the in-flight wake
   *  (TurnOrigin.onRingFailed), call neither EventStore member and leave the events untouched; events stay in the
   *  pull queue until a nonce UPS (Task 7). */
  async ring(seatId: string, eventIds: readonly string[], text: string, nonce: string): Promise<RingOutcome> {
    const seat = this.ctx.seats.bySeatId(seatId);
    if (seat === null || seat.activity === 'MID_TURN' || !seat.mcpConnected) return this.traceRing(seatId, nonce, 'not_rung');
    if (text.length > C.CAPS.DOORBELL || text.startsWith('/') || text.split(nonce).length - 1 !== 1) return this.traceRing(seatId, nonce, 'error');
    const ok = this.send(seatId, { t: 'ring', event_ids: [...eventIds], text, nonce });
    if (!ok) return this.traceRing(seatId, nonce, 'not_rung');
    this.ctx.turns.onRingInFlight(seat, nonce, eventIds);   // R-F2-17: in flight from the send
    const result = await new Promise<PostResult>((resolve) => {
      this.waits.set(nonce, { resolve, seatId, eventIds });
      void this.ctx.ports.clock.sleep(C.RING_RESULT_WAIT_MS).then(() => {
        const w = this.waits.get(nonce);
        if (w !== undefined && w.resolve === resolve) {
          this.waits.delete(nonce);
          resolve('error');                              // no ring_result within 5 s (the await's trace covers it)
        }
      });
    });
    if (result === 'sent') {
      const seenEarly = this.ctx.turns.onRingSent(seat, nonce, eventIds);
      this.ctx.events.doorbellSent(nonce, [...eventIds]);
      if (seenEarly) this.ctx.events.nonceSeen(nonce);    // the nonce UPS came first: deliver now, once
    } else {
      this.ctx.turns.onRingFailed(seat, nonce);
    }
    this.traceRing(seatId, nonce, result);               // every outcome exactly once (the early returns traced above)
    return result;
  }

  /** The daemon's ring_result dispatch (server.ts); a ring_result for an unknown nonce is ignored. */
  onResult(nonce: string, result: 'sent' | 'refused' | 'error'): void {
    const w = this.waits.get(nonce);
    if (w === undefined) return;
    this.waits.delete(nonce);
    w.resolve(result);
  }

  private traceRing(seatId: string, nonce: string, result: RingOutcome): RingOutcome {
    this.ctx.trace.emit({ kind: 'ring', peer: this.ctx.seats.peerId(), seat: seatId, nonce, result });
    return result;
  }
}

/** A6-7 ringing glue, the `ring` ticker (the eligibility filter of 06 §3.16.5). V-10 (O-5): an id that rode a post
 *  of any result (sent, refused, error) is never offered again — the driver's own record (the EventStore's
 *  doorbellSent is delivery state, marked on 'sent' only); after 'not_rung' the ids are offered again. F2 #67 (A5-7:
 *  one housekeeping run per second, never held for an I/O wait): tick() starts each ring and returns without waiting
 *  for its ring_result (up to C.RING_RESULT_WAIT_MS); a seat whose ring is still in flight is skipped, and when the
 *  ring settles the driver records it exactly once — policy.onRingResult with the result (X-42), and the ids into the
 *  never-offer-again record unless 'not_rung'. A rejected ring counts as 'error' for both. */
export class RingDriver {
  /** V-10/O-5 per seat (F2 #72): the ids that rode a post. A seat's set goes when the seat ends or is no longer
   *  listed; an id goes when the EventStore reports it delivered. Never because an id is momentarily missing from
   *  pending(): an in_batch row returns to pending and must stay never-offered-again. Retired rows fire no delivery
   *  event and stay until their seat ends (bounded by the seat's lifetime). */
  private readonly posted = new Map<string, Set<string>>();
  /** onDelivered is subscribed once, lazily, at the first tick that can ring (production's neverRing subscribes
   *  nothing). */
  private subscribed = false;
  /** The seats whose ring waits for its result (the driver's own record: it does not rely on TurnOrigin's pending). */
  private readonly inFlight = new Set<string>();
  /** A throw of policy.onRingResult inside a settle (off the ticker run): rethrown at the end of the next tick so the
   *  ticker loop reports it as it did when the tick awaited the ring, and never an unhandled rejection. */
  private settleError: { err: unknown } | null = null;
  constructor(private readonly ctx: DaemonCtx, private readonly policy: WakePolicy, private readonly ringer: Ringer) {}

  /** Test-only (F2 #72): the never-offer-again record's size (ids over every seat). */
  sizesForTest(): { ids: number } {
    let ids = 0;
    for (const set of this.posted.values()) ids += set.size;
    return { ids };
  }

  async tick(): Promise<void> {
    if (this.policy.shouldRing === neverRing.shouldRing) return;   // production (R5-37): never composes a ring
    if (!this.subscribed) {
      this.subscribed = true;
      this.ctx.events.onDelivered((_seatId, ids) => {
        for (const set of this.posted.values()) for (const id of ids) set.delete(id);
      });
    }
    const listed = this.ctx.seats.seats();
    const live = new Set<string>();
    for (const s of listed) {
      const seat = this.ctx.seats.bySeatId(s.seat_id);
      if (seat !== null && !seat.ended) live.add(s.seat_id);
    }
    for (const id of [...this.posted.keys()]) if (!live.has(id)) this.posted.delete(id);   // the record goes with its seat
    for (const s of listed) {
      const seat = this.ctx.seats.bySeatId(s.seat_id);
      if (seat === null || seat.ended) continue;
      if (this.inFlight.has(s.seat_id)) continue;      // its ring still waits for its ring_result (F2 #67)
      if (s.activity !== 'IDLE' || s.wiring !== 'FULL') continue;
      if (s.flags.includes('PAUSED') || s.flags.includes('PULL_MODE')) continue;
      if (seat.turn.pending.length > 0) continue;        // a pending wake, or a wake-originated current turn
      if (seat.turn.origin === 'wake') continue;
      const ids = this.ctx.events.pending(s.seat_id).filter((e) => e.state === 'pending' && e.viaNonce === null).map((e) => e.id);
      const mine = this.posted.get(s.seat_id);
      const offerable = mine === undefined ? ids : ids.filter((id) => !mine.has(id));
      if (offerable.length === 0) continue;
      const nonce = mintNonce(this.ctx.ports.random);    // V-10 (O-2): minted before the ask, passed in
      const answer = this.policy.shouldRing(s.seat_id, offerable, nonce);
      if (answer === null) continue;                     // the offer repeats at the next tick (O-5)
      this.start(s.seat_id, offerable, answer.text, nonce);
    }
    const failed = this.settleError;
    if (failed !== null) {
      this.settleError = null;
      throw failed.err;
    }
  }

  /** One ring, not awaited by the tick (F2 #67); its settle runs once, whatever the outcome. */
  private start(seatId: string, ids: readonly string[], text: string, nonce: string): void {
    this.inFlight.add(seatId);
    const settle = (result: 'sent' | 'refused' | 'error' | 'not_rung'): void => {
      this.inFlight.delete(seatId);
      if (result !== 'not_rung') {                         // never offered again (O-5)
        let set = this.posted.get(seatId);
        if (set === undefined) {
          set = new Set<string>();
          this.posted.set(seatId, set);
        }
        for (const id of ids) set.add(id);
      }
      try {
        this.policy.onRingResult?.(seatId, ids, result, nonce);   // X-42, once per shouldRing answer
      } catch (err) {
        this.settleError ??= { err };
      }
    };
    let ring: Promise<'sent' | 'refused' | 'error' | 'not_rung'>;
    try {
      ring = this.ringer.ring(seatId, ids, text, nonce);
    } catch {
      ring = Promise.resolve('error');
    }
    ring.then(settle, () => settle('error'));
  }
}

/** One RingDriver per daemon ctx (F2 #63): the registered ticker is daemon-agnostic (claudeDaemon.ts A5-7), so each
 *  daemon in a process keeps its own never-offer-again record (V-10/O-5) for its whole life. */
const ringDrivers = new WeakMap<DaemonCtx, RingDriver>();
/** The `ring` ticker: the composition's policy (neverRing in production) and Ringer. */
registerTicker('ring', (ctx: DaemonCtx): Promise<void> => {
  let driver = ringDrivers.get(ctx);
  if (driver === undefined) {
    driver = new RingDriver(ctx, ctx.bindings.wakePolicy, ctx.ring as Ringer);
    ringDrivers.set(ctx, driver);
  }
  return driver.tick();
});
