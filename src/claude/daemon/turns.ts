// src/claude/daemon/turns.ts — the turn origin (CCI-37, glossary §25 F2, O-TURN-ORIGIN, R5-36, R5-39; Task 6).
// The origin state lives on the seat's TurnState (Task 5's fields) plus this module's per-seat posted-nonce registry:
// A6-2 — each pending wake keeps fallbackEligible and humanPromptSincePost; the seat's POSTED nonces (the newest 16)
// and the prompt_id recorded at each post outlive the 60 s pending-wake expiry, so rule (a) still classifies a later
// nonce-carrying turn as wake; only the pending state (fallback (b), slash-expansion classification) expires.
// R-F2-17 (F2 #61): a post is recorded when its ring frame is SENT (onRingInFlight: the pending wake in flight, the
// nonce posted, the prompt_id recorded, fallbackEligible computed then), because the injected prompt's
// UserPromptSubmit usually reaches the daemon before ring_result 'sent' (06 §3.12.2 MEASURED, §3.16.5's 100 ms close
// test). A nonce UPS resolves against posts in flight or sent; 'sent' marks the entry sent (or reports the nonce as
// already seen, leaving no pending wake); 'refused'/'error'/the 5 s timeout drop the in-flight entry and, for an
// unseen nonce, its posted record. Fallback (b) needs a SENT post; classifyExpansion and the RingDriver count an
// in-flight entry as pending (the conservative side R-F2-17 accepts).
// Rule (a): a prompt carrying a posted nonce is a doorbell — it confirms those nonces' events delivered, clears their
// pending wakes, refreshes nothing, opens nothing, releases nothing; it opens a wake turn exactly when its prompt_id
// differs from the one recorded at that post and from the seat's current one. Fallback (b): the first
// non-UserPromptSubmit hook after a `sent` post with no hook in C.WAKE_QUIET_BEFORE_POST_MS before it, no Stop-less
// turn open and the post not expired → a wake turn (never a human one), and never for a hook carrying the recorded
// prompt_id (a continuation of the recorded turn, not a new one). F2 #60: fallback (b) sees every hook event but
// UserPromptSubmit and UserPromptExpansion (otherHookEvent; a /cowork expansion is classified at its own arrival by
// classifyExpansion, 06 §3.12.2 slash expansions, and a doorbell text never starts with '/', 06 §3.16.5, so no wake
// turn begins with an expansion); and a nonce-less UserPromptSubmit carrying the prompt_id of the turn (b)
// classified is that turn's human start (06: "no UserPromptSubmit without the nonce has arrived since the post"),
// so the turn becomes human. The (b)-classified turn is this module's per-seat record (bTurns), never a TurnState
// field. The `turn` trace events are O-TURN-ORIGIN's;
// `released` is the new human turn's lease count (ctx.leases.openFor — the composition wires the LeaseTable; absent
// in unit tests → 0). A6-11: under the M44 mutant a nonce-carrying prompt is treated as a new human prompt (refreshes the
// attended window, opens a human turn, so signal.emit sends prompt) — also mid-turn with the running prompt_id, the
// doorbell of plan 2800/2801.
import type { Clock } from '../../ports/clock.js';
import type { Trace } from '../../ports/trace.js';
import type { MutantId } from '../../engine/deps.js';
import { C } from '../wire/constants.js';
import type { HookEvent, HookPayload } from '../wire/frames.js';
import { NONCE_RE } from '../wire/hookInput.js';
import type { DaemonCtx, HookRequest } from './ctx.js';
import { registerStep, registerTicker } from './pipeline.js';
import type { Seat, SeatRegistry } from './seats.js';

/** The leases view the new human turn's `released` reads (Task 8's LeaseTable.openFor); absent in unit tests. */
interface LeasesView { openFor(seatId: string): { inflight: number; txns: number } }

/** A structural superset of TurnState.pending's element (seats.ts): `inFlight` is true from the ring frame's send
 *  until its ring_result 'sent' (R-F2-17); an entry without it (a legacy onRingSent) is a sent post. */
type TurnPending = { nonce: string; sentMono: number; eventIds: readonly string[]; fallbackEligible: boolean; humanPromptSincePost: boolean; inFlight?: boolean };
/** `seen`: a UserPromptSubmit carrying the nonce arrived (the doorbell is delivered, 06 §3.16.5). */
type PostedNonce = { nonce: string; sentMono: number; promptId: string | null; seen: boolean };

/** A6-11: the daemon-tier mutant read (one site; test builds only, R-29). */
declare const __COWORK_TEST_BUILD__: boolean | undefined;
function mutantActive(m: MutantId, injected: ReadonlySet<MutantId> | null): boolean {
  if (injected !== null && injected.has(m)) return true;
  return (typeof __COWORK_TEST_BUILD__ === 'undefined' || __COWORK_TEST_BUILD__) && process.env['COWORK_TEST_MUTANT'] === m;
}

const pendingOf = (seat: Seat): TurnPending[] => seat.turn.pending as TurnPending[];

/** F2 #60 (06 §3.12.2): the hook events fallback (b) sees — every event but UserPromptSubmit (classified by
 *  onPromptSubmit) and UserPromptExpansion (a /cowork expansion is classified at its own arrival by
 *  classifyExpansion and never opens the turn's origin; a doorbell text never starts with '/', 06 §3.16.5). The
 *  daemon's seat routing passes h.prompt_id to onOtherHook for exactly these events. */
export function otherHookEvent(event: HookEvent): boolean {
  return event !== 'UserPromptSubmit' && event !== 'UserPromptExpansion';
}

/** The seat has a Stop-less turn open: a classified origin (a Stop clears it; the leftover prompt_id is A6-2's
 *  continuity record, not an open turn). */
function turnOpen(seat: Seat): boolean {
  return seat.turn.origin !== null;
}

export class TurnOrigin {
  private readonly leases: LeasesView | null;
  private readonly testMutants: ReadonlySet<MutantId> | null;
  /** The posted nonces per seat_key (newest 16; A6-2 — they outlive the pending-wake expiry). */
  private readonly posted = new Map<string, PostedNonce[]>();
  /** F2 #60: the prompt_id of the seat's current turn when fallback (b) classified it (cleared at its Stop and when a
   *  UserPromptSubmit opens or converts a turn). */
  private readonly bTurns = new WeakMap<Seat, string | null>();

  /** Task 5's pinned three arguments; the composition adds the leases view and the injected mutants. */
  constructor(private readonly seats: SeatRegistry, private readonly clock: Clock, private readonly trace: Trace,
    leases?: LeasesView | null, testMutants?: ReadonlySet<MutantId>) {
    this.leases = leases ?? null;
    this.testMutants = testMutants ?? null;
    // F2 #72: a seat's posted nonces go at its end (the 16-per-seat cap of A6-2 bounds a live seat).
    seats.onEnd(async (seat) => {
      this.posted.delete(seat.seatKey);
      this.bTurns.delete(seat);
    });
  }

  /** R-F2-17: the ring frame was sent (Ringer, before it waits for ring_result). The post is recorded now: the seat's
   *  last seen prompt_id, the pending wake marked in flight (A6-2: fallbackEligible = no hook in the 60 s before the
   *  post and no Stop-less turn open) and the nonce posted, not yet seen. */
  onRingInFlight(seat: Seat, nonce: string, eventIds: readonly string[]): void {
    this.recordPost(seat, nonce, eventIds, true);
  }

  /** ring_result 'sent'. Returns true when the nonce was already seen (its UserPromptSubmit won the race, R-F2-17):
   *  no pending wake is created and the caller marks the events doorbell-carried, then seen. Otherwise the in-flight
   *  entry becomes a sent post and false is returned. With no prior in-flight record (a caller that never announced
   *  the send) it records the post now, as before R-F2-17, and returns false. */
  onRingSent(seat: Seat, nonce: string, eventIds: readonly string[]): boolean {
    const post = (this.posted.get(seat.seatKey) ?? []).find((p) => p.nonce === nonce);
    if (post === undefined) {
      this.recordPost(seat, nonce, eventIds, false);
      return false;
    }
    if (post.seen) {
      seat.turn.pending = pendingOf(seat).filter((p) => p.nonce !== nonce);
      return true;
    }
    const entry = pendingOf(seat).find((p) => p.nonce === nonce);
    if (entry !== undefined) entry.inFlight = false;     // (an entry the 60 s expiry already dropped stays dropped)
    return false;
  }

  /** ring_result 'refused' or 'error', or no ring_result within 5 s: the in-flight pending wake goes; an unseen
   *  nonce's posted record goes too (that post never reached the host); a seen nonce keeps its record and the turn
   *  it opened (R-F2-17's cost-if-wrong case). */
  onRingFailed(seat: Seat, nonce: string): void {
    const pending = pendingOf(seat);
    if (pending.some((p) => p.nonce === nonce)) seat.turn.pending = pending.filter((p) => p.nonce !== nonce);
    const posted = this.posted.get(seat.seatKey);
    if (posted === undefined) return;
    const kept = posted.filter((p) => p.nonce !== nonce || p.seen);
    if (kept.length !== posted.length) this.posted.set(seat.seatKey, kept);
  }

  private recordPost(seat: Seat, nonce: string, eventIds: readonly string[], inFlight: boolean): void {
    const now = this.clock.monoMs();
    const recorded = seat.turn.promptId ?? seat.turn.recordedPromptId;
    seat.turn.recordedPromptId = recorded;
    const fallbackEligible = (seat.lastHookMono === null || now - seat.lastHookMono >= C.WAKE_QUIET_BEFORE_POST_MS) && !turnOpen(seat);
    const pending = pendingOf(seat).filter((p) => p.nonce !== nonce);
    pending.push({ nonce, sentMono: now, eventIds: [...eventIds], fallbackEligible, humanPromptSincePost: false, inFlight });
    seat.turn.pending = pending;
    const posted = (this.posted.get(seat.seatKey) ?? []).filter((p) => p.nonce !== nonce);
    posted.push({ nonce, sentMono: now, promptId: recorded, seen: false });
    if (posted.length > 16) posted.splice(0, posted.length - 16);   // the newest 16 (A6-2)
    this.posted.set(seat.seatKey, posted);
  }

  /** UserPromptSubmit (CCI-37): non-empty nonces → a doorbell; else a new human turn. */
  onPromptSubmit(seat: Seat, promptId: string | null, nonces: readonly string[]):
    { kind: 'doorbell'; delivered: readonly string[]; wake: boolean } | { kind: 'turn'; origin: 'human' | 'wake'; newTurn: boolean } {
    const noncePrompt = nonces.length > 0;
    if (noncePrompt && !mutantActive('M44', this.testMutants)) {
      const posted = this.posted.get(seat.seatKey) ?? [];
      const delivered = [...new Set(nonces)].filter((n) => posted.some((p) => p.nonce === n));   // posts in flight or sent
      for (const p of posted) if (delivered.includes(p.nonce)) p.seen = true;
      const pending = pendingOf(seat).filter((p) => !delivered.includes(p.nonce));   // clears their pending wakes
      seat.turn.pending = pending;
      // Rule (a): a wake turn when the prompt_id differs from the one recorded at that post and from the current one.
      const wake = delivered.length > 0 && promptId !== null && promptId !== seat.turn.promptId
        && !posted.some((p) => delivered.includes(p.nonce) && p.promptId === promptId);
      if (wake && promptId !== null) {
        seat.turn.promptId = promptId;
        seat.turn.origin = 'wake';
        seat.turn.wakeTurnStartMono = this.clock.monoMs();
        this.bTurns.delete(seat);
      }
      this.traceTurn(seat, 'doorbell', promptId, delivered[0] ?? null, false, false, 0);
      return { kind: 'doorbell', delivered, wake };
    }
    // F2 #60: the nonce-less UserPromptSubmit of the turn (b) classified (same prompt_id, e.g. after its /cowork
    // expansion) is that turn's human start — a new human turn like any other (a rule-(a) wake turn is not converted).
    const bStart = seat.turn.origin === 'wake' && this.bTurns.has(seat) && this.bTurns.get(seat) === promptId;
    // A6-11 (11 §3.9 M44: "a UserPromptSubmit carrying a cowork nonce refreshes 'last human prompt' or opens a
    // human-origin turn"): under the mutant a nonce prompt is a new human turn even mid-turn with the running prompt_id.
    const newTurn = seat.turn.promptId !== promptId || bStart || noncePrompt;
    if (newTurn) {
      seat.turn.promptId = promptId;
      seat.turn.origin = 'human';
      seat.turn.lastHumanPromptMono = this.clock.monoMs();
      seat.turn.wakeTurnStartMono = null;
      this.bTurns.delete(seat);
    }
    if (seat.turn.pending.length > 0) {
      // A6-2: any nonce-less UserPromptSubmit after a post marks that post's fallback ineligible.
      for (const p of seat.turn.pending as TurnPending[]) p.humanPromptSincePost = true;
    }
    const released = newTurn && this.leases !== null && seat.seatId !== null ? this.leases.openFor(seat.seatId).inflight + this.leases.openFor(seat.seatId).txns : 0;
    this.traceTurn(seat, 'human', promptId, null, newTurn, newTurn, released);
    return { kind: 'turn', origin: 'human', newTurn };
  }

  /** Fallback (b) (R5-36): classify a wake turn after a post, never a human one; called for every event
   *  otherHookEvent admits, with the hook's prompt_id (F2 #60). R5-55: a seat double without a turn state (the pinned
   *  composition cell) is a no-op. 06 §3.12.2 "its first hook after the post": a (b) decision spends that post's
   *  fallback (F2 #68), while the pending wake itself stays until its nonce is seen or it expires (classifyExpansion
   *  and the RingDriver still see it); a hook carrying the recorded prompt_id spends nothing. The classified turn's
   *  prompt_id is kept so its own nonce-less UserPromptSubmit makes it human (onPromptSubmit). */
  onOtherHook(seat: Seat, promptId: string | null): void {
    if ((seat as Partial<Seat>).turn === undefined) return;
    if (promptId !== null && promptId === seat.turn.recordedPromptId) return;   // a continuation of the recorded turn
    if (promptId !== null) seat.turn.recordedPromptId = promptId;
    if (seat.turn.origin !== null) return;
    const now = this.clock.monoMs();
    const due = pendingOf(seat).find((p) => p.inFlight !== true && p.fallbackEligible && !p.humanPromptSincePost && now - p.sentMono < C.PENDING_WAKE_EXPIRY_MS);   // (b) needs a `sent` post (R-F2-17)
    if (due === undefined) return;
    due.fallbackEligible = false;                       // F2 #68: one sent post wakes at most one turn by (b)
    if (promptId !== null) seat.turn.promptId = promptId;
    seat.turn.origin = 'wake';
    seat.turn.wakeTurnStartMono = now;
    this.bTurns.set(seat, promptId);
    this.traceTurn(seat, 'wake', seat.turn.promptId, due.nonce, false, true, 0);
  }

  /** 06 §3.12.2 slash expansions, SEC-25 step 2. */
  classifyExpansion(seat: Seat, promptId: string | null, nonces: readonly string[]): 'human' | 'wake' {
    if (nonces.length > 0) return 'wake';
    if (seat.turn.origin === 'wake') return 'wake';
    const pending = pendingOf(seat);
    if (pending.length > 0 && promptId !== null && promptId !== seat.turn.recordedPromptId) return 'wake';
    return 'human';
  }

  /** The turn's Stop/StopFailure clears the origin (R5-39); posted nonces and prompt_ids are kept (A6-2). */
  onStop(seat: Seat): void {
    if (seat.turn.origin !== null) this.traceTurn(seat, 'stop', seat.turn.promptId, null, false, false, 0);
    seat.turn.origin = null;
    seat.turn.wakeTurnStartMono = null;
    this.bTurns.delete(seat);
  }

  /** 06 §2 per-field turn-origin values (R1-124, A6-3). */
  originOf(seatId: string): 'prompt' | 'wake' {
    const seat = this.seats.bySeatId(seatId);
    return seat !== null && seat.turn.origin === 'wake' ? 'wake' : 'prompt';
  }

  requestOrigin(seatId: string): 'claude' | 'wake' {
    return this.originOf(seatId) === 'wake' ? 'wake' : 'claude';
  }

  /** `<peer_id>[/<agent_id>]` (Tasks 11, 12). */
  recordOrigin(seatId: string, agentId: string | null): string {
    void seatId;
    const peer = this.seats.peerId();
    return agentId === null ? peer : `${peer}/${agentId}`;
  }

  /** Test-only (F2 #72): the registry sizes. */
  sizesForTest(): { posted: number } { return { posted: this.posted.size }; }

  /** A6-2: pending wakes expire 60 s after the post; the posted nonces and their recorded prompt_ids stay. */
  expire(): void {
    const now = this.clock.monoMs();
    for (const s of this.seats.seats()) {
      const seat = this.seats.bySeatId(s.seat_id);
      if (seat === null) continue;
      const pending = pendingOf(seat).filter((p) => now - p.sentMono < C.PENDING_WAKE_EXPIRY_MS);
      if (pending.length !== seat.turn.pending.length) seat.turn.pending = pending;
    }
  }

  private traceTurn(seat: Seat, op: 'human' | 'wake' | 'doorbell' | 'stop', promptId: string | null, nonce: string | null,
    humanPromptRefreshed: boolean, csReset: boolean, released: number): void {
    this.trace.emit({ kind: 'turn', peer: this.seats.peerId(), seat: seat.seatId ?? '', promptId, op, nonce, humanPromptRefreshed, csReset, released });
  }
}

// ---- the steps and the ticker (the plan's Step behaviour note) ------------------------------------------------------

/** The nonces in one text (a fresh regex per call: NONCE_RE is the shared /g pattern). */
function noncesIn(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(NONCE_RE), (m) => m[0]))];
}

/** The prompt's nonces: NONCE_RE matches over the string fields the payload carries. */
export function promptNonces(payload: HookPayload): readonly string[] {
  const texts: string[] = [];
  for (const v of Object.values(payload as Record<string, unknown>)) {
    if (typeof v === 'string') texts.push(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') texts.push(x);
  }
  return noncesIn(texts.join('\n'));
}

/** `turn.prompt` (UserPromptSubmit): classify, set r.turn, nonceSeen per delivered nonce, onUserPromptSubmit (X-40). */
registerStep('turn.prompt', (r: HookRequest, _d, ctx: DaemonCtx): Promise<void> => {
  const promptId = r.frame.h.prompt_id;
  const nonces = promptNonces(r.frame.payload);
  const hadTurn = turnOpen(r.seat);
  const res = ctx.turns.onPromptSubmit(r.seat, promptId, nonces);
  if (res.kind === 'doorbell') {
    r.turn = { doorbell: true, newTurn: res.wake, origin: res.wake ? 'wake' : 'human' };
    for (const n of res.delivered) ctx.events.nonceSeen(n);
  } else {
    r.turn = { doorbell: false, newTurn: res.newTurn, origin: res.origin };
  }
  const midTurn = hadTurn && !r.turn.newTurn;
  ctx.bindings.coordHooks.onUserPromptSubmit(r.seat.seatId ?? '', { promptId: promptId ?? '', nonces, midTurn });
  return Promise.resolve();
});

/** `turn.expansion` (UserPromptExpansion): classification only, no output (Task 15 refuses to mint on 'wake'). */
registerStep('turn.expansion', (r: HookRequest, _d, ctx: DaemonCtx): Promise<void> => {
  r.turn = { doorbell: false, newTurn: false, origin: ctx.turns.classifyExpansion(r.seat, r.frame.h.prompt_id, promptNonces(r.frame.payload)) };
  return Promise.resolve();
});

/** `turn.stop` (Stop, StopFailure): after stop.decide — the origin clears. */
registerStep('turn.stop', (r: HookRequest, _d, ctx: DaemonCtx): Promise<void> => {
  ctx.turns.onStop(r.seat);
  return Promise.resolve();
});

/** The `turns` ticker: pending wakes expire 60 s after their post (A6-2). */
registerTicker('turns', (ctx: DaemonCtx): void => {
  ctx.turns.expire();
});
