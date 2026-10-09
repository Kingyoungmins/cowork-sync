// Clock port (11-testing §3.2) and the single local-anchor helper (INV-CLOCK,
// glossary §21; 02-protocol PRO-10). This is the only file in src/ that may
// read Date.now(), new Date(), performance.now() or process.hrtime (lint L-CLOCK).
//
// Rules the helpers encode:
// - Every timer is a Δ from a local anchor; no wall reading is ever compared
//   with a reading from another machine.
// - Observers (waiting on someone else) use Δmono, which does not count
//   suspend, so they err toward waiting longer.
// - A peer judging its own staleness uses max(Δwall, Δmono), so it errs
//   toward "I may be stale".
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

export interface Clock {
  /** Monotonic milliseconds; never goes backwards within a process. */
  monoMs(): number;
  /** Wall-clock milliseconds since the Unix epoch. */
  wallMs(): number;
  /** Resolves after `ms` milliseconds of this clock's time (negative = 0). */
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  monoMs: () => performance.now(),
  wallMs: () => Date.now(),
  sleep: async (ms: number) => {
    await delay(Math.max(0, ms));
  },
};

/**
 * Machine-wide monotonic ms (process.hrtime.bigint()), comparable between processes
 * on one PC; only for status.json heartbeat_mono_ms (01-engine §3.16). The only
 * reader of process.hrtime in src/. Microsecond-exact: the bigint is divided before
 * it becomes a double.
 */
export function machineMonoMs(): number {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}

let processStart: number | null = null;

/**
 * This process's start on the machine-wide monotonic clock, whole ms, read once per process (machineMonoMs() minus
 * process.uptime()): two processes that share a pid (a pid reused after a crash or a reboot) almost never share it.
 * Used only to tell an own daemon.lock from a stale one naming the same pid (ruling R-26).
 */
export function processStartMonoMs(): number {
  processStart ??= Math.round(machineMonoMs() - process.uptime() * 1000);
  return processStart;
}

export interface Anchor {
  readonly mono: number;
  readonly wall: number;
}

export const SUSPEND_GAP_THRESHOLD_MS = 5000;

export function anchorNow(clock: Clock): Anchor {
  return Object.freeze({ mono: clock.monoMs(), wall: clock.wallMs() });
}

/** Observer-side wait: Δmono since the anchor, never negative. */
export function elapsedMono(clock: Clock, a: Anchor): number {
  return Math.max(0, clock.monoMs() - a.mono);
}

/** Own staleness: max(Δwall, Δmono), so a suspend or a forward wall jump counts. */
export function ownStaleness(clock: Clock, a: Anchor): number {
  return Math.max(clock.wallMs() - a.wall, elapsedMono(clock, a));
}

/** Δwall − Δmono since the anchor; above SUSPEND_GAP_THRESHOLD_MS means the PC slept. Negative when the wall clock was set back. */
export function suspendGapMs(clock: Clock, a: Anchor): number {
  return clock.wallMs() - a.wall - (clock.monoMs() - a.mono);
}
