// Breach (04 §3.16; REG-25; R4-51) — Task 5 declares BreachPort (type only); Task 15 adds breach and logBreach.
import type { BreachHit } from './types.js';

/** The caller's handler of one breach report (Plan 6 binds a log-only port by default). */
export interface BreachPort { onBreach(hits: readonly BreachHit[]): void; }
