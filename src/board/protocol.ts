// protocol.json: written once by the genesis writer, carried as the same blob by every later board commit
// (02-protocol §3.1; PRO-04, PRO-07; glossary §27.2; ruling R-19 — genesisBudget in src/data/config.ts picks
// the budget, 12 unless host.pushBudgetPerMin is an integer in 6–24).
import { canonicalBytes } from './canonicalJson.js';

export interface ProtocolJson { proto: number; regionSpec: string; budget: number; G_s: number; S_s: number; }

export const PROTO = 1;

/** The stricter-side values a missing or malformed field reads as (02-protocol §3.1). */
const FALLBACK = { budget: 6, G_s: 10, S_s: 3 } as const;

/**
 * G_s = ⌈60,000/budget⌉/1,000, S_s = ⌈18,000/budget⌉/1,000 (12 → 5, 1.5; 6 → 10, 3; 24 → 2.5, 0.75; 7 → 8.572, 2.572).
 * A budget that is not a positive safe integer throws (the formula has no meaning for it).
 */
export function genesisProtocol(budget: number, regionSpec: string): ProtocolJson {
  if (!Number.isSafeInteger(budget) || budget < 1) throw new RangeError(`genesisProtocol: budget must be a positive integer, got ${String(budget)}`);
  return { proto: PROTO, regionSpec, budget, G_s: Math.ceil(60_000 / budget) / 1_000, S_s: Math.ceil(18_000 / budget) / 1_000 };
}

/** RFC 8785 canonical JSON of exactly the five fields: byte-identical on every OS, no trailing newline. */
export function serializeProtocol(p: ProtocolJson): Buffer {
  return canonicalBytes({ proto: p.proto, regionSpec: p.regionSpec, budget: p.budget, G_s: p.G_s, S_s: p.S_s });
}

const positive = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);

/**
 * A missing or malformed budget/G_s/S_s (not a positive finite number) reads as 6/10/3; a missing proto, or
 * one that is not a non-negative integer, reads as 0 (≠ 1 → VERSION); a non-string regionSpec reads as ''.
 * No file, unparsable bytes (a BOM included) or a non-object read as all of these. Never throws.
 */
export function readProtocol(buf: Buffer | null): ProtocolJson {
  let v: unknown = null;
  if (buf !== null) {
    try {
      v = JSON.parse(buf.toString('utf8'));
    } catch {
      v = null;
    }
  }
  const o: Record<string, unknown> = typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const proto = o['proto'];
  return {
    proto: typeof proto === 'number' && Number.isSafeInteger(proto) && proto >= 0 ? proto : 0,
    regionSpec: typeof o['regionSpec'] === 'string' ? o['regionSpec'] : '',
    budget: positive(o['budget'], FALLBACK.budget),
    G_s: positive(o['G_s'], FALLBACK.G_s),
    S_s: positive(o['S_s'], FALLBACK.S_s),
  };
}
