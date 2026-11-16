// Region codes into status and the daemon log (R4-54) — Task 5. A code reaches core.holdCode (Plan 3's status
// input, R3-61) and the daemon log; REGION_BUDGET is deduplicated per path per 30 min Δmono (04 §2 and §3.19: "at most
// once per path per 30 min" — per path, whatever the budget kind), CLAIM_REJECTED once per (claim_id, reason); every other
// code is raised every time. REGION_BLOCK_ONLY logs at info (verdict data for /cowork show, never a degraded state), every
// other region code at warn.
import type { LogParam } from '../ports/log.js';
import type { RegionCode, RegionCodeParams } from '../regions/codes.js';
import { BUDGETS } from '../regions/budgets.js';
import type { EngineCore } from './core.js';

/** The dedupe state per path of REGION_BUDGET (the mono time of its last write) and per (claim_id, reason) of CLAIM_REJECTED, in memory. */
const lastBudget = new WeakMap<EngineCore, Map<string, number>>();
const lastRejected = new WeakMap<EngineCore, Set<string>>();

export function raiseRegionCode<C extends RegionCode>(core: EngineCore, code: C, params: RegionCodeParams[C]): void {
  if (code === 'REGION_BUDGET') {
    const map = lastBudget.get(core) ?? new Map<string, number>();
    lastBudget.set(core, map);
    const now = core.deps.ports.clock.monoMs();
    const p = params as RegionCodeParams['REGION_BUDGET'];
    const seen = map.get(p.path);
    if (seen !== undefined && now - seen < BUDGETS.regionBudgetDedupeMs) return;
    map.set(p.path, now);
  } else if (code === 'CLAIM_REJECTED') {
    const set = lastRejected.get(core) ?? new Set<string>();
    lastRejected.set(core, set);
    const p = params as RegionCodeParams['CLAIM_REJECTED'];
    const key = `${p.claim_id}\n${p.reason}`;
    if (set.has(key)) return;
    set.add(key);
  }
  const flat: Record<string, LogParam> = {};
  for (const [k, v] of Object.entries(params)) {
    flat[k] = Array.isArray(v) ? v.map(String).join(',') : v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
  }
  core.deps.log.write(code === 'REGION_BLOCK_ONLY' ? 'info' : 'warn', code, flat);
  core.holdCode = { code, params };
}
