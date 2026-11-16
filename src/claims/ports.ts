// src/claims/ports.ts (R4-57; PRO-37) — Task 5 declares SuspectPort and noSuspect; Task 16 adds plan4Ports.

/** Whether a claim id is suspect (REG's SHADOW rule set; PRO-37). Plan 6 binds the real one. */
export interface SuspectPort { isSuspect(claimId: string): boolean; }

/** No claim is ever suspect: the default before Plan 6 (fail-open to the K2/K3 path, PRO-37's stub). */
export const noSuspect: SuspectPort = Object.freeze({
  isSuspect: (_claimId: string): boolean => false,
});
