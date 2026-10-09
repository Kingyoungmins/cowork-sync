// VirtualScheduler: the SIM binding of the Scheduler port (11-testing §3.2, §3.3).
// One task per step(); time only moves when step() advances the VirtualClock
// to the next task's atMono. Ties are broken by insertion order.
import type { Random } from '../../src/ports/random.js';
import type { Scheduler, Task } from '../../src/ports/scheduler.js';
import type { VirtualClock } from './vclock.js';

interface Entry {
  task: Task;
  atMono: number;
  seq: number;
}

export class VirtualScheduler implements Scheduler {
  onYield: ((name: string) => void | Promise<void>) | null = null;
  // Not used for ordering (ties are insertion-ordered); exposed so onYield
  // handlers and engines draw from the scheduler's seeded stream.
  readonly random: Random;
  private readonly clock: VirtualClock;
  private readonly queue: Entry[] = [];
  private nextSeq = 0;
  private running = false;

  constructor(clock: VirtualClock, random: Random) {
    this.clock = clock;
    this.random = random;
  }

  schedule(task: Task, atMono: number): void {
    if (!Number.isFinite(atMono)) {
      throw new RangeError(`VirtualScheduler: atMono must be finite (got ${atMono})`);
    }
    this.queue.push({ task, atMono, seq: this.nextSeq++ });
  }

  async yieldPoint(name: string): Promise<void> {
    const handler = this.onYield;
    if (handler !== null) await handler(name);
  }

  async step(): Promise<boolean> {
    if (this.running) {
      throw new Error('VirtualScheduler: step() re-entered from inside a running task');
    }
    // The queue is in insertion (seq) order, so a strict "<" keeps the
    // earliest-inserted entry among equal atMono values.
    let best = -1;
    let bestAt = 0;
    for (let i = 0; i < this.queue.length; i++) {
      const e = this.queue[i];
      if (e === undefined) continue;
      if (best < 0 || e.atMono < bestAt) {
        best = i;
        bestAt = e.atMono;
      }
    }
    if (best < 0) return false;
    const [entry] = this.queue.splice(best, 1);
    if (entry === undefined) return false;
    const now = this.clock.monoMs();
    if (entry.atMono > now) this.clock.advance(entry.atMono - now);
    this.running = true;
    try {
      await entry.task();
    } finally {
      this.running = false;
    }
    return true;
  }

  async runUntilIdle(maxSteps: number): Promise<number> {
    let n = 0;
    while (n < maxSteps && (await this.step())) n++;
    return n;
  }

  pending(): number {
    return this.queue.length;
  }
}
