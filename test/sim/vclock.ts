// VirtualClock: per-peer virtual time for SIM runs (11-testing §3.2; F-PEER-4
// wall offset, drift and suspend gaps).
//   mono = startMono + A
//   wall = SIM_WALL_EPOCH_MS + wallOffsetMs + A + round(A * driftPpm / 1e6) + S
// where A is the total passed to advance()/sleep() and S the total passed to
// suspend(). Drift is computed from the running total and rounded once, so it
// is never lost to per-step rounding and wall stays an integer for integer
// steps. Two clocks with the same options fed the same steps read identical
// values, so commit dates derived from wallMs() give reproducible commit oids.
import type { Clock } from '../../src/ports/clock.js';

/** 2026-01-01T00:00:00Z: fixed origin of every virtual wall clock. `wallOffsetMs` is relative to it. */
export const SIM_WALL_EPOCH_MS = 1_767_225_600_000;

const PPM = 1_000_000;

function checkStep(what: string, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`VirtualClock.${what}: expected a finite ms >= 0, got ${ms}`);
}

export class VirtualClock implements Clock {
  private readonly startMono: number;
  /** SIM_WALL_EPOCH_MS + wallOffsetMs. */
  private readonly wallBase: number;
  private readonly driftPpm: number;
  /** A: total advanced (both clocks). */
  private advancedMs = 0;
  /** S: total suspended (wall only, no drift). */
  private suspendedMs = 0;

  /**
   * @param opts.wallOffsetMs OFFSET from SIM_WALL_EPOCH_MS (e.g. ±600_000 for a skewed peer), never an absolute time. Default 0.
   * @param opts.startMono initial monoMs(), >= 0. Default 0.
   * @param opts.driftPpm wall runs fast (+) or slow (−) by this many parts per million of advanced time; |driftPpm| < 1e6. Default 0.
   */
  constructor(opts?: { wallOffsetMs?: number; startMono?: number; driftPpm?: number }) {
    const offset = opts?.wallOffsetMs ?? 0;
    const start = opts?.startMono ?? 0;
    const drift = opts?.driftPpm ?? 0;
    if (!Number.isFinite(offset)) throw new RangeError(`VirtualClock: wallOffsetMs must be finite, got ${offset}`);
    if (!Number.isFinite(start) || start < 0) throw new RangeError(`VirtualClock: startMono must be finite and >= 0, got ${start}`);
    if (!Number.isFinite(drift) || Math.abs(drift) >= PPM) {
      throw new RangeError(`VirtualClock: driftPpm must be finite with |driftPpm| < ${PPM}, got ${drift}`);
    }
    this.startMono = start;
    this.wallBase = SIM_WALL_EPOCH_MS + offset;
    this.driftPpm = drift;
  }

  monoMs(): number {
    return this.startMono + this.advancedMs;
  }

  wallMs(): number {
    const driftMs = Math.round((this.advancedMs * this.driftPpm) / PPM);
    return this.wallBase + this.advancedMs + driftMs + this.suspendedMs;
  }

  /** Advances virtual time by max(0, ms) via advance() (so drift applies) and resolves on a microtask; never waits for real time. */
  async sleep(ms: number): Promise<void> {
    this.advance(Math.max(0, ms));
  }

  /** Mono moves forward by `ms`; wall by `ms * (1 + driftPpm / 1e6)`, accrued on the running total. */
  advance(ms: number): void {
    checkStep('advance', ms);
    this.advancedMs += ms;
  }

  /** The PC sleeps for `ms`: wall moves by exactly `ms` (no drift), mono does not (Δwall − Δmono grows by ms). */
  suspend(ms: number): void {
    checkStep('suspend', ms);
    this.suspendedMs += ms;
  }
}
