// src/claude/daemon/transitions.ts — the status-transition deliverer (CCI-44, INV-NOSILENT, R5-09; Task 7).
// Plan 5 delivers every line a change of status.json state, freeze_reasons or publish_pause causes (V-10/O-18):
// FROZEN/UNFROZEN, OFFLINE/NONRETRYABLE/VERSION_PAUSED/ONLINE, the message_code of an entry into degraded or
// incident, DAEMON_DOWN and the 06 §3.6.2 10-minute OFFLINE/AUTH repeat. Every logical line is one pair — one
// slot 'system' item (the human systemMessage) and one slot 'context' item (the Claude line), codes and typed
// params only. Engine events that change none of the three (their EV.* routing) are Plan 6's (R5-09). The step
// writes each item as an EventStore row of family 'transition' (F2 #11), so a transition line is delivered at least
// once like every other event (06 §3.14.3, CCI-41): it rides until printed, an un-printed reply re-sends it at the
// seat's next hook, and a line the cap drops stays pending for the next carrier. DAEMON_DOWN is the one line about
// the present only: the seat's first hook with a fresh status retires its DAEMON_DOWN rows still open (F2 fix round 1).
import type { StatusJson, PublishPause } from '../../engine/status.js';
import type { FreezeReason } from '../../engine/meta.js';
import type { CarrierItem } from './carriers.js';
import type { Params } from './claudeDaemon.js';
import type { DaemonCtx, HookRequest, ReplyDraft } from './ctx.js';
import { registerStep } from './pipeline.js';
import { C } from '../wire/constants.js';

/** A7-9: the per-seat last-seen value; the baseline is {state: 'ok', freeze_reasons: [], publish_pause: null,
 *  offline_for_s: 0, offlineRepeatSent: false}. offline_for_s is the one the seat last saw, so a lower one under the
 *  same OFFLINE/AUTH pause marks a new episode the seat did not see begin (F2 #14, fix round 1). */
export type TransitionTriple = { state: StatusJson['state']; freeze_reasons: readonly FreezeReason[]; publish_pause: PublishPause | null; offline_for_s: number; offlineRepeatSent: boolean };

/** One logical line as its pair: the human systemMessage and the Claude context line, same code and params (the
 *  pure contract; transitionDeliverStep turns each item into a store row). */
const pair = (code: string, params: Params, tier: number): CarrierItem[] => [
  { code, params, eventId: null, family: 'transition', mandatory: false, slot: 'system', tier },
  { code, params, eventId: null, family: 'transition', mandatory: false, slot: 'context', tier },
];

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A7-6, pure: freeze reason added → FROZEN {reason}, removed → UNFROZEN {reason} (in removal order); pause
 *  OFFLINE/AUTH → OFFLINE {offline_for_s, label}, NONRETRYABLE → NONRETRYABLE {hold_id} (the host-reject PIN id
 *  only, never the host's text), VERSION → VERSION_PAUSED {form}, pause cleared → ONLINE; state entering degraded
 *  or incident with no freeze/pause change → message_code with message_params; a return to ok → nothing beyond
 *  the component lines. */
export function transitionItems(prev: TransitionTriple, next: StatusJson): CarrierItem[] {
  const out: CarrierItem[] = [];
  const freeze = next.freeze_reasons ?? [];
  for (const r of freeze) if (!prev.freeze_reasons.includes(r)) out.push(...pair('FROZEN', { reason: r }, 20));
  for (const r of prev.freeze_reasons) if (!freeze.includes(r)) out.push(...pair('UNFROZEN', { reason: r }, 20));
  const pause = next.publish_pause;
  if (pause === 'OFFLINE' || pause === 'AUTH') {
    if (prev.publish_pause !== pause) {
      const label = typeof next.message_params.label === 'string' ? next.message_params.label : pause;
      out.push(...pair('OFFLINE', { offline_for_s: num(next.message_params.offline_for_s) ?? 0, label }, 10));
    }
  } else if (pause === 'NONRETRYABLE') {
    if (prev.publish_pause !== 'NONRETRYABLE') {
      const hold = next.message_params.hold_id;
      out.push(...pair('NONRETRYABLE', { hold_id: typeof hold === 'string' ? hold : null }, 10));
    }
  } else if (pause === 'VERSION') {
    if (prev.publish_pause !== 'VERSION') {
      const form = typeof next.message_params.form === 'string' ? next.message_params.form : null;
      out.push(...pair('VERSION_PAUSED', { form }, 10));
    }
  } else if (pause === null && prev.publish_pause !== null) {
    out.push(...pair('ONLINE', {}, 10));
  }
  const freezeChanged = freeze.some((r) => !prev.freeze_reasons.includes(r)) || prev.freeze_reasons.some((r) => !freeze.includes(r));
  const pauseChanged = pause !== prev.publish_pause;
  if ((next.state === 'degraded' || next.state === 'incident') && !freezeChanged && !pauseChanged && prev.state !== next.state && next.message_code !== null) {
    out.push(...pair(next.message_code, { ...next.message_params } as Params, 15));
  }
  return out;
}

const isOfflineLike = (p: PublishPause | null): boolean => p === 'OFFLINE' || p === 'AUTH';

/** 06 §3.6.2 / CCI-15: the OFFLINE (or AUTH) notice repeats once per seat per episode at 10 min offline. */
const AGAIN_S = C.OFFLINE_NOTICE_AGAIN_MS / 1000;

const BASELINE: TransitionTriple = { state: 'ok', freeze_reasons: [], publish_pause: null, offline_for_s: 0, offlineRepeatSent: false };

/** The per-seat deliverer: observe records the current status.json; forSeat computes, at the seat's hook, the
 *  transition from what that seat last saw (its last-seen triple, the baseline for a seat never seen) to the
 *  current status (06 §3.14.6 "since that seat last saw it"), so a state that comes and goes between two hooks of
 *  a seat is not announced to it, plus the 10-minute OFFLINE/AUTH repeat once per seat per episode and a
 *  DAEMON_DOWN pair when the last heartbeat is older than 3 loop periods, once per seat until a fresh status is
 *  observed (CCI-44). State is per seat only; dropSeat forgets an ended seat (F2 #57). */
export class Transitions {
  private readonly last = new Map<string, TransitionTriple>();
  private readonly stale = new Set<string>();      // seats that announced DAEMON_DOWN for the current heartbeat
  private readonly downIds = new Map<string, string[]>();   // seat → the store ids of its DAEMON_DOWN rows (F2 fix round 1)
  private current: StatusJson | null = null;

  /** A7-6: heartbeatNow is bound to the same source as EngineDeps.heartbeatMs (machineMonoMs in production, the
   *  peer's VirtualClock in SIM, R-35). */
  constructor(private readonly heartbeatNow: () => number) { }

  private triple(s: StatusJson, offlineRepeatSent: boolean): TransitionTriple {
    return { state: s.state, freeze_reasons: s.freeze_reasons, publish_pause: s.publish_pause, offline_for_s: num(s.message_params.offline_for_s) ?? 0, offlineRepeatSent };
  }

  /** CCI-44: the last heartbeat is older than 3 loop periods of the heartbeat source. */
  private isStale(s: StatusJson): boolean {
    return this.heartbeatNow() > s.heartbeat_mono_ms + 3 * s.loop_period_ms;
  }

  /** Called with every status.json the engine writes (the status observer binding, R5-55/A5-3): it records the
   *  current status and re-arms the staleness announcement; nothing is queued here. */
  observe(s: StatusJson, _nowMono: number): void {
    this.current = s;
    this.stale.clear();
  }

  /** Once per seat per transition, computed at the seat's hook: the pairs from the seat's last-seen triple to the
   *  current status, then the seat's triple moves to the current one. Inside one OFFLINE/AUTH episode the seat gets
   *  one repeat pair (params.repeat 'true', labelled by message_params.label, else by the pause) at its first hook
   *  with offline_for_s ≥ 600 s; a seat whose first exposure to the episode comes at ≥ 600 s counts it as the
   *  repeat (one pair only); a new episode resets it — one the seat saw begin (the pause changed) or one that began
   *  between two of its hooks (the same pause with a lower offline_for_s than the seat last saw). The seat's triple
   *  has moved on once this returns, so the caller owns delivery: transition.deliver stores every item as a store
   *  row (F2 #11). */
  forSeat(seatId: string): CarrierItem[] {
    const s = this.current;
    if (s === null) return [];
    const prev = this.last.get(seatId) ?? BASELINE;
    const out = transitionItems(prev, s);
    const ofs = num(s.message_params.offline_for_s) ?? 0;
    let repeatSent: boolean;
    if (isOfflineLike(prev.publish_pause) && prev.publish_pause === s.publish_pause && ofs >= prev.offline_for_s) {
      repeatSent = prev.offlineRepeatSent;
      if (!repeatSent && ofs >= AGAIN_S) {
        const label = typeof s.message_params.label === 'string' ? s.message_params.label : s.publish_pause;
        out.push(...pair('OFFLINE', { offline_for_s: ofs, label, repeat: 'true' }, 10));   // Params carries no boolean; the rendered line reads repeat=true
        repeatSent = true;
      }
    } else {
      repeatSent = isOfflineLike(s.publish_pause) && ofs >= AGAIN_S;
    }
    this.last.set(seatId, this.triple(s, repeatSent));
    if (this.isStale(s) && !this.stale.has(seatId)) {
      this.stale.add(seatId);
      out.push(...pair('DAEMON_DOWN', {}, 30));
    }
    return out;
  }

  /** Additive (F2 fix round 1): records the store ids transition.deliver minted for the seat's DAEMON_DOWN pair. */
  noteDaemonDown(seatId: string, ids: readonly string[]): void {
    if (ids.length === 0) return;
    const l = this.downIds.get(seatId);
    if (l === undefined) this.downIds.set(seatId, [...ids]);
    else l.push(...ids);
  }

  /** Additive (F2 fix round 1): DAEMON_DOWN is true only while the heartbeat is stale, so once a fresh status is
   *  current this hands back (and forgets) the seat's recorded DAEMON_DOWN ids for the caller to retire; while the
   *  status is still stale, or none was observed, it returns [] and the rows keep riding until printed. */
  takeRecovered(seatId: string): string[] {
    const s = this.current;
    if (s === null || this.isStale(s)) return [];
    const ids = this.downIds.get(seatId);
    if (ids === undefined) return [];
    this.downIds.delete(seatId);
    return ids;
  }

  /** The seat's end, additive (F2 #57): forgets its last-seen triple, its staleness mark and its DAEMON_DOWN ids. */
  dropSeat(seatId: string): void {
    this.last.delete(seatId);
    this.stale.delete(seatId);
    this.downIds.delete(seatId);
  }
}

/** The carriers of the four events that run transition.deliver (pipeline.ts STEP_ORDER: SessionStart, UserPromptSubmit,
 *  PreToolUse without a deny, PostToolUse); pre_deny, stop, post_failure and none never carry a transition line. */
export const TRANSITION_CARRIERS = ['session_start', 'ups', 'pre_context', 'post'] as const;

/** The per-seat deliverer's step (A7-7; Task 7 registers it): on every non-deny hook the seat's transition items
 *  become EventStore rows of family 'transition' on TRANSITION_CARRIERS (F2 #11); finishReply then offers them with
 *  the seat's other pending rows, and printed, the un-printed re-queue and the cap-dropped-stays-pending rule apply
 *  to them as to any event. A G1 never carries them: the step adds nothing and Transitions does not advance, so the
 *  next exit-0 reply carries the line (06 §3.5.2). A DAEMON_DOWN row still open (un-printed or cap-dropped) when a
 *  fresh status is current is retired here, never delivered: a recovered daemon does not tell the seat that edits
 *  are paused (F2 fix round 1). */
export async function transitionDeliverStep(r: HookRequest, d: ReplyDraft, ctx: DaemonCtx): Promise<void> {
  const seatId = r.seat.seatId ?? '';
  if (seatId === '' || d.deny !== null) return;
  const t = ctx.transitions;
  const items = t.forSeat(seatId);
  const over = t.takeRecovered(seatId);
  if (over.length > 0) ctx.events.retire(over);
  for (const it of items) {
    const ids = ctx.events.add(seatId, { code: it.code, params: it.params, family: 'transition', mandatory: false, slot: it.slot as 'system' | 'context', carriers: TRANSITION_CARRIERS });
    if (it.code === 'DAEMON_DOWN') t.noteDaemonDown(seatId, ids);
  }
}

registerStep('transition.deliver', transitionDeliverStep);

