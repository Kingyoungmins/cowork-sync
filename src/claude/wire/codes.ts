// src/claude/wire/codes.ts — 06 §3.14.4 and §1.2 (selection only; templates are 07's/10's). Every entry matches ^[A-Z][A-Z0-9_]{2,47}$.
// X-117: CCI_CODES, NEW_CODES and LOG_ONLY_CODES are declarations (each code declared in exactly one plan's codes module; HELD_CS, OWN_CHANGE_HELD,
// STOP_SUMMARY and DIGEST_SUPERSEDES are declared here and nowhere else, X-48); ROUTED_CODES is a reference list whose codes must exist in their
// owners' modules (RF_UNKNOWN_VERB is declared in Plan 7's registry, X-79). The five 06 §3.14.4 codes Plan 3's src/holds/codes.ts declares
// (CS_UNPUBLISHED_NUDGE, HOLD_MIRROR_REJECTED, QUARANTINE_HUMAN_ONLY by R3-65, RESTORE_BINARY_HUMAN_ONLY, RESTORE_MARKERS) are routed, R-F2-4.
// Plan 7's carried.ts imports these lists instead of retyping them.

const frozen = <T extends readonly string[]>(xs: T): T => Object.freeze(xs);

/** R5-34, R5-41, R5-42, R5-60 (SE5-08): the codes Plan 5 introduces, flagged for registry entries; none is in the spec yet.
 *  Decision point 5-4 (PAUSED): the plan line 203 lists PAUSED among the health codes but codes.ts did not declare it —
 *  added here (not in NEW_CODES, whose members get registry entries) so CODE_OF's PAUSED mapping is in CCI_CODES. */
export const NEW_CODES = frozen(['SEAT_FULL', 'SEAT_NO_MCP', 'SEAT_PULL_MODE', 'PEER_IDLE', 'RESTORE_NOT_ALLOWED', 'NOTE_SCAN_UNAVAILABLE', 'FLOW_PATH_INVALID'] as const);

/** Exactly the codes of 06 §3.14.4's table, §1.2's refusal table and 09 §3.11/§3.13's SEC_ codes (the test pins each name against the spec text), plus NEW_CODES,
 *  minus the five Plan 3 declares, which ROUTED_CODES lists (R-F2-4). */
export const CCI_CODES: readonly string[] = frozen([
  // 06 §3.14.4 Claude-facing (templated by 07 in en/ko)
  'G4_DOWN', 'HOOK_LOAD_FAIL', 'PAUSED_LINE', 'DAEMON_DOWN', 'VERSION_RESTART', 'CC_TOO_OLD', 'WAKE_TURN', 'STATE_FILE', 'NOT_SHARED',
  'PORTABILITY', 'SYMLINK', 'PATH_BUSY', 'MOVED', 'HELDREG', 'SUSPECT_LOST', 'GRANT_PAUSE', 'CLAIM_HELD_DENY', 'HELD_CS',
  'SHELL_GIT', 'SHELL_FORMATTER', 'SHELL_INPLACE', 'SHELL_COWORK_CLI', 'WORKTREE_DENY', 'WT_NOTE', 'WT_SUBMODULE', 'ATTRIBUTION',
  'CLAIM_AHEAD', 'CLAIM_AHEAD_ENDED', 'HOLD_IN_FILE', 'OWN_CHANGE_HELD', 'READ_REPLACED', 'HUMAN_EDIT_OWN_CLAIM',
  'STOP_SUMMARY', 'DIGEST_SUPERSEDES', 'DEGRADED', 'HOOK_ONLY', 'NOHOOKS', 'STATUS_NO_CHANGE', 'SHOW_NO_CHANGE',
  // 06 §3.14.4 MCP refusal codes (used here; QUARANTINE_HUMAN_ONLY, RESTORE_BINARY_HUMAN_ONLY and RESTORE_MARKERS are Plan 3's, in ROUTED_CODES)
  'NOT_OWN_RECORD', 'TERMINAL_RECORD', 'UNKNOWN_ID', 'NOT_OWN_CLAIM', 'AMBIGUOUS_ID', 'MULTI_HOLDER',
  'NOT_ADDRESSED_TO_SEAT', 'RELEASE_UNLANDED', 'GOFIRST_OPEN', 'GOFIRST_RECENT', 'DECLINED_SAME', 'NOTE_SECRET_HIT',
  // 07 T-SINCE (F04)
  'SINCE_POINTER',
  // 06 §3.14.4 human-facing and §1.2
  'REFUSE_PROJECT_SCOPE', 'REFUSE_CC_VERSION', 'REFUSE_NODE_VERSION', 'REFUSE_WORKTREE', 'REFUSE_SECOND_CHECKOUT', 'NO_NODE_ON_CLAUDE_PATH',
  'WRITE_UNREADABLE_FILE', 'CC_VERSION_UNKNOWN', 'LIVE_MARKER_RESTORED', 'DAEMON_REMOVED', 'IDLE_NO_SESSION', 'DAEMON_DIED_WITH_HOST',
  'UI_SINCE_RECAP',
  // 09 §3.11, §3.13, §3.14
  'SEC_REFUSE_IPC_ACL', 'SEC_REFUSE_IPC_SQUATTER', 'SEC_REFUSE_SOCKET_PATH', 'SEC_IPC_HANDSHAKE_FAILED', 'SEC_EVIDENCE_TAG_INVALID',
  'SEC_REFUSE_NOT_HUMAN', 'SEC_NOHOOKS',
  'PAUSED',   // decision point 5-4 (see NEW_CODES comment above)
  ...NEW_CODES,
]);

/** R5-60: other chapters' registry codes Plan 5 selects or delivers, each pinned by a test against its chapter's text (05, 03-data DAT-45, 09 SEC-33,
 *  glossary §8 / 01 / 02, 07, 10); a status message_code passed through by a transition line is Plan 2/3's and is not listed. */
export const ROUTED_CODES = frozen(['HOLD_PIN_CONTEXT', 'INCOMING_WAITING', 'CS_GROUP_WAITING', 'CS_READY_CANCELLED', 'CS_UNPUBLISHED_NUDGE',
  'HOLD_MIRROR_REJECTED', 'QUARANTINE_HUMAN_ONLY', 'RESTORE_BINARY_HUMAN_ONLY', 'RESTORE_MARKERS', 'FROZEN', 'UNFROZEN', 'OFFLINE', 'ONLINE',
  'NONRETRYABLE', 'VERSION_PAUSED', 'INCIDENT', 'STANDING_RULES', 'RF_UNKNOWN_VERB'] as const);

/** 06 §3.16.1: shortened (T1R) but never suppressed in PULL_MODE: every G1 reason, the K2 block, OWN_CHANGE_HELD for a wake-scope PIN, Stop truthfulness. */
export const MANDATORY_FAMILIES = frozen(['g1', 'k2', 'own_change_held_wake', 'stop_truth'] as const);

/** A6-9 (Task 6): codes written only to the daemon log — never a carrier, the board or status.json; each matches
 *  REASON_CODE_RE. X-30: every Log.write code is a registry code with surfaces ['log'], so SESSION_END and SEAT_HOOK
 *  (written by Plan 5's daemon log) are declared here too. DAEMON_INTERNAL_ERROR (R-F2-14: a throwing hook step, hello or ticker is
 *  logged and never answered) is declared here once, by the F2 controller's ruling C-2; other modules write the literal. */
export const LOG_ONLY_CODES = frozen(['CS_SIGNAL_REJECTED', 'SESSION_END', 'SEAT_HOOK', 'DAEMON_INTERNAL_ERROR'] as const);

/** 06 §3.16.1, F05/F04 additions: suppressed in PULL_MODE. Plan 6 tags its bystander lines with family 'bystander'. */
export const PULL_MODE_SUPPRESSED = frozen(['ATTRIBUTION', 'CLAIM_AHEAD', 'CLAIM_AHEAD_ENDED', 'SINCE_POINTER', 'CS_UNPUBLISHED_NUDGE', 'bystander'] as const);
