// One-shot timers measured on the injected Clock (INV-CLOCK: Δmono from a local anchor), for the viewer server's own timers: the 15 s
// comment line, the 60 s security-log windows and the reap of a socket after a raw answer. The Clock decides when a timer is due; a
// Node timer only wakes the check and re-arms for the remainder until the clock has reached the due time (the re-arm pattern of
// src/ports/scheduler.ts realScheduler, plus cancel and unref). The wake-up is unref'd, so a pending timer never keeps the viewer
// process alive, and under a VirtualClock nothing fires until virtual time has passed the due point. A loop over Clock.sleep is not
// used: VirtualClock.sleep advances virtual time itself, so a repeating sleep would spin and burn the clock (the launch TTL with it).
import type { Clock } from '../../ports/clock.js';

export interface ClockTimer {
  /** Stops the timer; a wake-up already queued runs nothing. Idempotent. */
  cancel(): void;
}

// setTimeout's ceiling; a larger delay makes Node fire after 1 ms instead.
const MAX_TIMER_MS = 2_147_483_647;

/** Runs `fn` once, `ms` after now by the clock's monoMs(). */
export function clockTimer(clock: Clock, ms: number, fn: () => void): ClockTimer {
  const due = clock.monoMs() + ms;
  let live = true;
  let handle: ReturnType<typeof setTimeout> | null = null;
  const wake = (): void => {
    handle = null;
    if (!live) return;
    const left = due - clock.monoMs();
    if (left > 0) {
      handle = setTimeout(() => { wake(); }, Math.min(Math.ceil(left), MAX_TIMER_MS));
      handle.unref();
      return;
    }
    live = false;
    fn();
  };
  handle = setTimeout(() => { wake(); }, Math.min(Math.max(1, Math.ceil(ms)), MAX_TIMER_MS));
  handle.unref();
  return {
    cancel: (): void => {
      live = false;
      if (handle !== null) clearTimeout(handle);
      handle = null;
    },
  };
}
