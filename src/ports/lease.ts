// Lease port (CCI-50; ruling R-11). The engine stops syncing after LEASE_STOP_SYNC_MS
// without a valid seat or human lease and drains and exits after LEASE_EXIT_MS.
export interface LeasePort {
  /** Δmono since the last valid seat or human lease ended; 0 while one is valid. */
  idleMs(): number;
}

/** The foreground daemon is its human's lease; SIM binds it too. */
export const alwaysLeased: LeasePort = { idleMs: () => 0 };

/** No capture, apply or new publish. */
export const LEASE_STOP_SYNC_MS = 120_000;
/** Drain and exit, last status IDLE_NO_SESSION. */
export const LEASE_EXIT_MS = 600_000;
