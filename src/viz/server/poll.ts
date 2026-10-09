// The poll loop (12 §3.9.2; VIZ-07, VIZ-41; INV-CLOCK): every 2.5 s of Δmono one pass over every room store, one store at a time
// (so the loop itself never runs two ticks at once, and a room's tick never overlaps its pages and "load earlier", which the store
// runs one at a time — at most one git child per room; the routes may meanwhile run another room's page), never re-entrant — the
// next pass is armed only when this one has ended, due 2.5 s after it started (at once when it overran). What a tick reports goes
// to the sink: an overlay, a delta, then 'state' as a room message or 'rebuilt' as a reset (the page reloads the world). Each of
// those calls is guarded on its own, so a failing one skips none of the later ones, and a tick whose report failed anywhere ends
// with a reset, so no page keeps a partial report (a lost room message would never be sent again: the next tick's header compares
// equal). A store whose tick throws never stops the loop (the store logs its own failures; the sink logs its own). stop() cancels
// the next pass and waits for the tick that is running; the stores after it in that pass are not ticked.
import type { Clock } from '../../ports/clock.js';
import { clockTimer, type ClockTimer } from './clockTimer.js';
import type { PollSink, StoreLike } from './models.js';

export const POLL_MS = 2_500;

type TickResult = Awaited<ReturnType<StoreLike['tick']>>;

export function startPoll(stores: readonly StoreLike[], sink: PollSink, clock: Clock): () => Promise<void> {
  let stopped = false;
  let timer: ClockTimer | null = null;
  let running: Promise<void> = Promise.resolve();
  const ids = new Map<StoreLike, string>();
  const idOf = (s: StoreLike): string => {
    let id = ids.get(s);
    if (id === undefined) {
      id = s.snapshot().spec.id;
      ids.set(s, id);
    }
    return id;
  };

  /** One tick's report to the sink, each call guarded on its own; any failure ends with one reset (a rebuild's own reset counts). */
  const report = (s: StoreLike, r: TickResult): void => {
    let failed = false;
    const call = (fn: () => void): boolean => {
      try {
        fn();
        return true;
      } catch {
        failed = true;                                  // the sink has logged it
        return false;
      }
    };
    const { overlay, delta, change } = r;
    if (overlay !== null) call(() => sink.overlay(idOf(s), overlay));
    if (delta !== null) call(() => sink.delta(delta));
    let reset = false;
    if (change === 'rebuilt') reset = call(() => sink.reset());
    else if (change === 'state') call(() => sink.roomChanged(idOf(s)));
    if (failed && !reset) call(() => sink.reset());
  };

  const pass = async (): Promise<void> => {
    for (const s of stores) {
      if (stopped) return;
      let r: TickResult;
      try {
        r = await s.tick();
      } catch {
        continue;                                       // one room's failure never stops the others; the store has logged it
      }
      report(s, r);
    }
  };

  const arm = (ms: number): void => {
    if (stopped) return;
    timer = clockTimer(clock, ms, () => {
      timer = null;
      const started = clock.monoMs();
      running = pass().then(() => arm(Math.max(0, started + POLL_MS - clock.monoMs())));
    });
  };
  arm(POLL_MS);

  return async (): Promise<void> => {
    stopped = true;
    timer?.cancel();
    timer = null;
    await running;
  };
}
