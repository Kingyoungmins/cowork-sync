// src/claude/daemon/meter.ts — the seat-hour budget meter (CCI-46, CCI-61, 06 §3.16.1, R5-43). Task 7 (X-46: the one
// meter of every plan). One window per seat, anchored at the seat's first hook (touch) and rolled lazily on every
// meter call: crossing the boundary resets the counters, clears PULL_MODE (onPullMode(seat, false) once) and
// re-anchors. injected > 20,000 or a reminder estimate over 15/20,000 → PULL_MODE until the window boundary;
// claim_ahead saturates at its 5,000 share and never trips; slash is shown, never counted.
import { C } from '../wire/constants.js';
import type { Clock } from '../../ports/clock.js';

export type MeterKind = 'inject' | 'system' | 'doorbell' | 'reminder_estimate' | 'claim_ahead' | 'recap' | 'slash';

export interface BudgetUsage { injected: number; reminders: number; reminderChars: number; claimAhead: number; doorbells: number; slashShown: number; pullMode: boolean; windowLeftMs: number; }

interface SeatWindow { anchor: number | null; injected: number; reminders: number; reminderChars: number; claimAhead: number; doorbells: number; slashShown: number; pullMode: boolean; }

const fresh = (): SeatWindow => ({ anchor: null, injected: 0, reminders: 0, reminderChars: 0, claimAhead: 0, doorbells: 0, slashShown: 0, pullMode: false });

export class BudgetMeter {
  private readonly windows = new Map<string, SeatWindow>();

  constructor(private readonly clock: Clock, private readonly onPullMode: (seatId: string, on: boolean) => void) { }

  private w(seatId: string): SeatWindow {
    let s = this.windows.get(seatId);
    if (s === undefined) { s = fresh(); this.windows.set(seatId, s); }
    return s;
  }

  /** The lazy window rollover: a window past its seat-hour boundary resets its counters, clears PULL_MODE (one
   *  onPullMode(seatId, false)) and re-anchors at now. */
  private roll(seatId: string, s: SeatWindow): void {
    const now = this.clock.monoMs();
    if (s.anchor !== null && now >= s.anchor + C.SEAT_HOUR_MS) {
      const was = s.pullMode;
      s.anchor = now; s.injected = 0; s.reminders = 0; s.reminderChars = 0; s.claimAhead = 0; s.doorbells = 0; s.slashShown = 0; s.pullMode = false;
      if (was) this.onPullMode(seatId, false);
    }
  }

  private trip(seatId: string, s: SeatWindow): void {
    if (s.pullMode) return;
    if (s.injected > C.INJECTED_CHARS_PER_SEAT_HOUR || s.reminders > C.REMINDERS_PER_SEAT_HOUR || s.reminderChars > C.REMINDER_CHARS_PER_SEAT_HOUR) {
      s.pullMode = true;
      this.onPullMode(seatId, true);
    }
  }

  /** A7-7: anchors the seat-hour window at the seat's first hook (called by event.deliver); later touches never
   *  re-anchor a live window (the lazy rollover does). */
  touch(seatId: string): void {
    const s = this.w(seatId);
    this.roll(seatId, s);
    if (s.anchor === null) s.anchor = this.clock.monoMs();
  }

  /** X5-27 (Plan 6 charges doorbells and claim-ahead text). claim_ahead counts into injected but saturates at
   *  CLAIM_AHEAD_SHARE_CHARS and never trips PULL_MODE by itself; slash is recorded, never counted. */
  charge(seatId: string, kind: MeterKind, chars: number): void {
    const s = this.w(seatId);
    this.roll(seatId, s);
    if (kind === 'slash') { s.slashShown += chars; return; }
    if (kind === 'reminder_estimate') { s.reminders += 1; s.reminderChars += chars; this.trip(seatId, s); return; }
    if (kind === 'claim_ahead') {
      const add = Math.max(0, Math.min(chars, C.CLAIM_AHEAD_SHARE_CHARS - s.claimAhead));
      s.claimAhead += add;
      s.injected += add;
      return;   // saturated share never trips PULL_MODE (CCI-61)
    }
    s.injected += chars;
    if (kind === 'doorbell') s.doorbells += 1;
    this.trip(seatId, s);
  }

  /** Host-reminder estimate: one reminder per applied path into the seat's full-read set (R2-D5). */
  reminder(seatId: string, appliedChars: number): void {
    this.charge(seatId, 'reminder_estimate', appliedChars);
  }

  inPullMode(seatId: string): boolean {
    const s = this.w(seatId);
    this.roll(seatId, s);
    return s.pullMode;
  }

  shareLeft(seatId: string, kind: 'claim_ahead'): number {
    void kind;
    const s = this.w(seatId);
    this.roll(seatId, s);
    return Math.max(0, C.CLAIM_AHEAD_SHARE_CHARS - s.claimAhead);
  }

  usage(seatId: string): BudgetUsage {
    const s = this.w(seatId);
    this.roll(seatId, s);
    const now = this.clock.monoMs();
    return {
      injected: s.injected, reminders: s.reminders, reminderChars: s.reminderChars, claimAhead: s.claimAhead,
      doorbells: s.doorbells, slashShown: s.slashShown, pullMode: s.pullMode,
      windowLeftMs: s.anchor === null ? C.SEAT_HOUR_MS : Math.max(0, s.anchor + C.SEAT_HOUR_MS - now),
    };
  }

  /** X-46: Δmono until the seat-hour window that set PULL_MODE ends; 0 when not in PULL_MODE. */
  pullModeLeftMs(seatId: string): number {
    const s = this.w(seatId);
    this.roll(seatId, s);
    if (!s.pullMode || s.anchor === null) return 0;
    return Math.max(0, s.anchor + C.SEAT_HOUR_MS - this.clock.monoMs());
  }

  /** F2 #57: the seat's end drops its window (the composition's seats.onEnd calls it), so the meter keeps no
   *  window per seat ever seen. No onPullMode follows: the seat is gone. */
  drop(seatId: string): void {
    this.windows.delete(seatId);
  }

  /** Test-only introspection (F2 #57): the number of seat windows held. */
  sizeForTest(): number {
    return this.windows.size;
  }

  /** X-46: 07 §2's cache-window input to the cost estimate (Plan 6's former MeterPort.cacheCold); never gates
   *  delivery. Plan 6 binds the real cache-window reading; Plan 5's answer is the neutral false. */
  cacheCold(_seatId: string): boolean {
    return false;
  }
}
