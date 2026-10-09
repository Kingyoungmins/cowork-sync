// Scheduler port (11-testing §3.2). Production: Node timers and the event loop.
// SIM: test/sim/vscheduler.ts (seeded queue, one step at a time).
import type { Clock } from './clock.js';

export type Task = () => void | Promise<void>;

export interface Scheduler {
  schedule(task: Task, atMono: number): void;
  yieldPoint(name: string): Promise<void>;
}

// setTimeout's ceiling; a larger delay makes Node fire after 1 ms instead.
const MAX_TIMER_MS = 2_147_483_647;

export function realScheduler(clock: Clock): Scheduler {
  return {
    schedule(task: Task, atMono: number): void {
      const arm = (): void => {
        const remaining = atMono - clock.monoMs();
        if (remaining <= 0) {
          // A throw or rejection is deliberately left unhandled (loud);
          // daemon code wraps its own tasks.
          void Promise.resolve().then(task);
          return;
        }
        // Re-arm until the clock really reached atMono: timers may fire a
        // fraction of a millisecond early, and long delays are capped.
        setTimeout(arm, Math.min(Math.ceil(remaining), MAX_TIMER_MS));
      };
      setImmediate(arm);
    },

    yieldPoint(): Promise<void> {
      return new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    },
  };
}
