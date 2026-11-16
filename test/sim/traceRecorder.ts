// TraceRecorder: the test-build binding of the Trace port (11-testing §2). Every event is kept in emission order;
// `names` maps a peer_id to the harness peer name, so oracles and failure messages can say which peer did what.
// Plan 3 (Task 13): a test-side table monoAt(index) — the emitting peer's VirtualClock.monoMs() when the event was emitted, filled
// by realEngine's per-peer Trace wrapper (emitAt); the events themselves still carry no time (TST-03). oracleGroup reads it for
// INV-GROUP's "≤ 1 apply per 10 s per worktree" clause.
import type { Trace, TraceEvent } from '../../src/ports/trace.js';

export class TraceRecorder implements Trace {
  private readonly log: TraceEvent[] = [];
  /** monos[i] = the emitting peer's virtual mono time of event i, or null when it came through emit() (no peer clock known). */
  private readonly monos: Array<number | null> = [];
  readonly names = new Map<string, string>();

  emit(ev: TraceEvent): void {
    this.emitAt(ev, null);
  }

  /** emit() for a peer whose virtual mono clock reads `monoMs` now (the per-peer wrapper's call). */
  emitAt(ev: TraceEvent, monoMs: number | null): void {
    this.log.push(Object.freeze({ ...ev }) as TraceEvent);
    this.monos.push(monoMs);
  }

  get events(): readonly TraceEvent[] {
    return this.log;
  }

  /** The emitting peer's virtual mono time at event `index` (test-side only; null for an event emitted without a peer clock). */
  monoAt(index: number): number | null {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.log.length) throw new RangeError(`TraceRecorder.monoAt: no event ${index} (${this.log.length} events)`);
    return this.monos[index] ?? null;
  }

  /** The events emitted at or after `index` (an earlier events.length). */
  since(index: number): readonly TraceEvent[] {
    return this.log.slice(index);
  }

  ofKind<K extends TraceEvent['kind']>(kind: K): Array<Extract<TraceEvent, { kind: K }>> {
    return this.log.filter((e): e is Extract<TraceEvent, { kind: K }> => e.kind === kind);
  }
}
