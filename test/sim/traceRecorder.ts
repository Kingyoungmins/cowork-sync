// TraceRecorder: the test-build binding of the Trace port (11-testing §2). Every event is kept in emission order;
// `names` maps a peer_id to the harness peer name, so oracles and failure messages can say which peer did what.
import type { Trace, TraceEvent } from '../../src/ports/trace.js';

export class TraceRecorder implements Trace {
  private readonly log: TraceEvent[] = [];
  readonly names = new Map<string, string>();

  emit(ev: TraceEvent): void {
    this.log.push(Object.freeze({ ...ev }) as TraceEvent);
  }

  get events(): readonly TraceEvent[] {
    return this.log;
  }

  /** The events emitted at or after `index` (an earlier events.length). */
  since(index: number): readonly TraceEvent[] {
    return this.log.slice(index);
  }

  ofKind<K extends TraceEvent['kind']>(kind: K): Array<Extract<TraceEvent, { kind: K }>> {
    return this.log.filter((e): e is Extract<TraceEvent, { kind: K }> => e.kind === kind);
  }
}
