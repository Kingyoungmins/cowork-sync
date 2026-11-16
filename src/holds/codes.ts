// The message codes Plan 3 raises (05-holds §1, §2; 03-data §2; glossary §19). Codes are registry names verbatim
// (`^[A-Z][A-Z0-9_]{2,47}$`); texts are Plan 7's (L-CODES, L-TEMPLATES). Plan 3 writes them to status.json and the daemon
// log only (R-27 carried). `HOLD_NOT_DURABLE` (removed in rev 2) never appears.

/**
 * Every new code Plan 3 raises into status.json or the log (L-CODES input for Plan 7), plus HOLD_NOT_SHARED, HOLD_RETURNED,
 * HOLD_PIN_CONTEXT and QUARANTINE_HUMAN_ONLY, declared for Plans 5–7 with no Plan 3 raise site (R3-65).
 * RESTORE_BINARY_HUMAN_ONLY is restore()'s operator-level outcome (03-data §2), never a ResolveRefusal (R3-54).
 */
export const HOLD_CODES: readonly string[] = Object.freeze([
  'HOLD_CREATED', 'HOLD_NOT_SHARED', 'HOLD_CONFLICTED', 'HOLD_SUBSUMED', 'HOLD_GONE', 'HOLD_PARKED', 'HOLD_AUTO_PARKED', 'HOLD_RESTORED',
  'HOLD_RETURNED', 'HOLD_REVERT_HELD', 'HOLD_PIN_CONTEXT', 'HOLD_RESTORE_CONFLICT', 'HOLD_MASK_INVALID', 'HOLD_DIVERGED_REGIONS',
  'HOLD_BINARY_WHOLE_FILE', 'HOLD_NOT_OWNER', 'HOLD_ALREADY_RESOLVED', 'HOLD_DISK_CHANGED', 'HOLD_FROZEN', 'HOLD_GUARDS_REMAIN',
  'HOLD_NOT_OFFERABLE', 'HOLD_NOT_PARKABLE', 'HOLD_MIRROR_REJECTED',
  'CS_UNPUBLISHED_NUDGE', 'CS_GROUP_WAITING', 'CS_READY_CANCELLED', 'CS_NO_CHECKS_CONFIGURED',
  'INCOMING_WAITING', 'INCOMING_COLLISION', 'INCOMING_UNMATERIALIZABLE',
  'RESTORE_MARKERS', 'RESTORE_BINARY_HUMAN_ONLY', 'QUARANTINE_HUMAN_ONLY',
  'EOL_MIXED_HELD', 'EOL_REPAIRED', 'PATH_NOT_PORTABLE', 'GENERATED_SUSPECT', 'BOARD_FULL',
]);

/**
 * Daemon-log-only codes Plan 3 writes (never status.json, never the board, no Claude- or human-facing template): the provenance
 * journal's rebuild and a failed advance (Task 8; HLD-25, R3-36, R3-59), and R3-28's line for a record a `--discard` ended
 * RESOLVED_DISCARD (Task 11; Task 5 ruling (d) carried it here), and RECORD_SCOPE_FAILED {at, error}: a resume or no-iteration drain
 * whose scope read for its records failed (loop.ts; ruling R3-FF2-C1, registered by integration I-4), and HOOKS_PATH_INVALID {exit}:
 * a valueless or invalid user core.hooksPath git cannot read as a path, read as no hooks directory (core.ts userHooksPathDir; ruling
 * R3-EF4-27), and APPLY_COMPANION_SETTLE_FAILED {code}: a redundant K4 marker companion an apply could not settle after a confirmed
 * rollback (apply.ts; integration I2-5, registered by the EF5 minors ruling). Registered here, outside HOLD_CODES, which stays at 38
 * (Codes constraint; Task 8 fix round 1 controller ruling).
 */
export const HOLD_LOG_CODES: readonly string[] = Object.freeze([
  'PROV_REBUILT', 'PROV_ADVANCE_FAILED', 'HOLD_DISCARDED', 'RECORD_SCOPE_FAILED', 'HOOKS_PATH_INVALID', 'APPLY_COMPANION_SETTLE_FAILED',
]);

/** The 05 §1 refusals resolve() returns; a seat actor gets `claude_refused` instead of RESTORE_BINARY_HUMAN_ONLY or QUARANTINE_HUMAN_ONLY (R3-54, R3-65). */
export type ResolveRefusal = 'HOLD_NOT_OWNER' | 'HOLD_GUARDS_REMAIN' | 'HOLD_NOT_OFFERABLE' | 'HOLD_NOT_PARKABLE' | 'HOLD_RESTORE_CONFLICT'
  | 'HOLD_DISK_CHANGED' | 'HOLD_FROZEN';

/** 05 §1 next command per refusal (texts are Plan 7's); 03-data §2 for RESTORE_BINARY_HUMAN_ONLY, SEC-33 for QUARANTINE_HUMAN_ONLY. */
export const NEXT_COMMAND: Readonly<Record<ResolveRefusal | 'RESTORE_BINARY_HUMAN_ONLY' | 'QUARANTINE_HUMAN_ONLY' | 'STOP_HOLDS_NOT_DURABLE' | 'UNINSTALL_HOLDS' | 'HOLD_MASK_INVALID', string>> = Object.freeze({
  HOLD_NOT_OWNER: '/cowork show <id>',
  HOLD_GUARDS_REMAIN: 'wait, cowork_request go-first, or --handoff',
  HOLD_NOT_OFFERABLE: '/cowork resolve <id> --publish|--discard',
  HOLD_NOT_PARKABLE: '—',
  HOLD_RESTORE_CONFLICT: '/cowork show <id>',
  HOLD_DISK_CHANGED: 'repeat the command',
  HOLD_FROZEN: '/cowork status',
  STOP_HOLDS_NOT_DURABLE: '--discard-holds=<ids> --confirm=<id>',
  UNINSTALL_HOLDS: '--discard-holds=<ids> --confirm=<id>',
  HOLD_MASK_INVALID: '/cowork doctor',
  RESTORE_BINARY_HUMAN_ONLY: '/cowork resolve <id> --restore',
  QUARANTINE_HUMAN_ONLY: '/cowork review <id> --accept',
});
