// GatedClock — Ruling P5-T3-1 (Plan 5 Task 3 fix r1): a harness-gated clock, "sleep waits for the harness to advance". Code that arms a
// deadline with Clock.sleep and settles on I/O first (src/sec/handshake.ts: clientHandshake/serverHandshake, the 3,000 ms SessionStart
// deadline) needs this in SIM and unit tests: the stock VirtualClock (test/sim/vclock.ts) resolves sleep(ms) at once and advances its own
// time by ms, so such a deadline fires before the peer's first byte is read and every handshake fails 'timeout' while the peer clock moves
// 3 s per side (pinned by test/unit/sec.handshake.test.ts, "the handshake deadline needs a gated clock"). The same pattern as Plan 4's
// harness-gated clock for RegionServiceDeps.clock. Carry: the seats SIM binding of R5-16 (Task 5's seatHarness, Task 18's seats profile)
// passes a clock with these sleep semantics to the real handshake.
//
// Time reads exactly as VirtualClock's (monoMs, wallMs, advance, suspend, the constructor options); only sleep differs: it never moves time,
// and resolves when advance() has brought monoMs() to the deadline (a sleep of 0 or less is already due and resolves on a microtask).
import { VirtualClock } from '../sim/vclock.js';

export class GatedClock extends VirtualClock {
  private waiters: Array<{ at: number; resolve: () => void }> = [];

  override sleep(ms: number): Promise<void> {
    const now = this.monoMs();
    const at = now + Math.max(0, ms);
    if (at <= now) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiters.push({ at, resolve });
    });
  }

  /** Advances like VirtualClock, then releases every sleep whose deadline is reached, earliest first. */
  override advance(ms: number): void {
    super.advance(ms);
    const now = this.monoMs();
    const due = this.waiters.filter((w) => w.at <= now).sort((a, b) => a.at - b.at);
    this.waiters = this.waiters.filter((w) => w.at > now);
    for (const w of due) w.resolve();
  }

  /** Sleeps not yet released (a harness can drive time to them or assert none is left). */
  pending(): number {
    return this.waiters.length;
  }
}
