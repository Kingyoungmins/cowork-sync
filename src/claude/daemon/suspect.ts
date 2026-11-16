// src/claude/daemon/suspect.ts — the SUSPECT self-guard (PRO-37, CCI-17, R5-06). Phase 1: the shapes; Task 11
// implements.
import type { Engine } from '../../engine/loop.js';
import type { EngineView } from './engineView.js';
import type { Clock } from '../../ports/clock.js';

/** Own last fetch or push older than 60 s by max(Δwall, Δmono), or a suspend gap > 5 s. */
export function suspectNow(_engine: EngineView, _clock: Clock): boolean {
  throw new Error('Plan 5 Task 11');
}

/** Sends extend{7000} within 100 ms, starts or joins a fetch (Engine.freshFetch(), A11-3 / X5-07 as ruled by X-77),
 *  waits ≤ 5 s for a fetch completed after this request and its fold. */
export function refreshForSuspect(_engine: Engine, _extend: (ms: number) => boolean, _clock: Clock): Promise<'fresh' | 'timeout'> {
  throw new Error('Plan 5 Task 11');
}
