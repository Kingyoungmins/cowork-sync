// Plan 4's one codes module (04-regions §3.19; 02-protocol §2.1; rulings R4-54, X-117, X-30; verify pass V-17).
// Codes and their params only: ids, oids, paths, hashes, numbers and closed enums (SEC-38) — never a byte, column or
// offset (INV-REG-COORD) and never text. The templates are Plan 6's (en, ko) and Plan 7's (six languages); Plan 7's
// carried.ts imports this module and registers every name below (the log-only ones with surfaces: ['log']).
import type { Language } from './types.js';

/** The seven 04 §3.19 codes. */
export const REGION_CODES: readonly ['REGION_BLOCK_ONLY', 'REGION_CONFLICT_MARKERS', 'REGION_SPEC_MISMATCH', 'REGION_WHOLE_FILE', 'REGION_BUDGET', 'CLAIM_OVERLAP', 'REGION_GRAMMAR_UNAVAILABLE'] =
  Object.freeze([
    'REGION_BLOCK_ONLY', 'REGION_CONFLICT_MARKERS', 'REGION_SPEC_MISMATCH', 'REGION_WHOLE_FILE', 'REGION_BUDGET', 'CLAIM_OVERLAP',
    'REGION_GRAMMAR_UNAVAILABLE',
  ] as const);

/** 02 §2.1: an own claim op folded invalid (PRO-24 bullet 3), raised once per (claim_id, reason). */
export const CLAIM_REJECTED = 'CLAIM_REJECTED';

export type RegionCode = (typeof REGION_CODES)[number] | typeof CLAIM_REJECTED;

export interface RegionCodeParams {
  REGION_BLOCK_ONLY: { path: string; reason: 'no_grammar' | 'not_utf8' | 'grammar_unavailable' };
  REGION_CONFLICT_MARKERS: { path: string };
  REGION_SPEC_MISMATCH: { path: string; claim_id: string; peer: string };   // peer = display name, glossary §19 cap
  REGION_WHOLE_FILE: { path: string; claim_id: string };
  REGION_BUDGET: { path: string; budget: 'parse' | 'map' | 'grep' | 't0' | 'gate' };
  CLAIM_OVERLAP: { cs_id: string; claim_id: string; overlaps: string; path: string };
  REGION_GRAMMAR_UNAVAILABLE: { language: Language };
  CLAIM_REJECTED: { claim_id: string; reason: 'anchor' | 'base_blob' | 'ranges' | 'validator' | 'reservation' };
}

/** X-117: Plan 4's start refusal (Task 16 raises it; its text, registry row and LIF-36 handling are Plan 7's). */
export const START_REGION_RUNTIME = 'START_REGION_RUNTIME';   // params { file: string }

/** X-30: the log-only registry codes Plan 4 writes (surfaces: ['log'] in Plan 7's registry; never in status.json): FOLD_OBJECT_MISSING { oid } (Task 8, R4-76),
 *  EDIT_CHECK_OVERRUN { cs_id } (Task 10, 04 §3.18's perf count), and the five the verify pass named (V-17): REGION_OBJECT_MISSING { oid, path } (Task 4,
 *  RegionService.bytes → 'MISSING', REG-35), EDIT_CHECK_INPUT_MISMATCH { path } (Task 10, R4-41's M[p] contradiction), REGION_WORKER_RESPAWN { name, cause }
 *  (Task 16, threadWorkers' onRespawn), REGION_RUNTIME_MISMATCH { engine, runtime } (Task 16, R4-81's exit-2 line; the two regionSpec hashes) and
 *  CLAIM_BREACH_HIT { claim_id, holder, commit, path, base_move } (Task 15, logBreach's line per hit, R4-51). Params are ids, oids, paths, hashes and enums only
 *  (SEC-38). Plan 7's carried.ts imports this module; no other module declares these names (X-29 scan; CLAIM_BREACH_HIT ≠ Plan 6's CLAIM_BREACH). */
export const REGION_LOG_ONLY_CODES: readonly ['FOLD_OBJECT_MISSING', 'EDIT_CHECK_OVERRUN', 'REGION_OBJECT_MISSING', 'EDIT_CHECK_INPUT_MISMATCH',
  'REGION_WORKER_RESPAWN', 'REGION_RUNTIME_MISMATCH', 'CLAIM_BREACH_HIT'] = Object.freeze([
  'FOLD_OBJECT_MISSING', 'EDIT_CHECK_OVERRUN', 'REGION_OBJECT_MISSING', 'EDIT_CHECK_INPUT_MISMATCH',
  'REGION_WORKER_RESPAWN', 'REGION_RUNTIME_MISMATCH', 'CLAIM_BREACH_HIT',
] as const);
