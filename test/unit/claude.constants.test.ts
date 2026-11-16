// Plan 5 Task 1: the local numbers of 06 §2 and the glossary §19/§20/§29 rows, one frozen table (R1-125).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { C } from '../../src/claude/wire/constants.js';

/** Every member of C, each row with its source. */
const EXPECTED = {
  LOADER_DEADLINE_MS: 1_500, LOADER_DEADLINE_SESSION_START_MS: 3_000, SUSPECT_DEADLINE_MAX_MS: 7_000,   // glossary §20 loader deadlines; 06 §3.4.4, CCI-10
  SUSPECT_EXTEND_WITHIN_MS: 100, SUSPECT_FETCH_WAIT_MS: 5_000,                                            // 06 §2 SUSPECT `extend` row; glossary §20 holder self-guard (5 s); CCI-17
  HOOK_TIMEOUT_S: 10, SESSION_END_TIMEOUT_S: 2, RETRY_SPACING_MS: 50,                                     // glossary §13, §20 hook timeouts; 06 §3.4.2 step 2 (50 ms spacing)
  GATE_DAEMON_P95_MS: 15, GATE_E2E_P95_MS: 100, NONLIVE_E2E_P95_MS: 80, EVENT_LOOP_BLOCK_MS: 20, WRITER_GATE_WAIT_MS: 250,   // glossary §20 gate latency, writer row; §26.2 item 4
  CONFIRM_P95_MS: 250, CAPTURE_BOUND_MS: 150, CANDIDATE_BOUND_MS: 150, EDIT_CHECK_MAX_MS: 500,            // 06 §2 local numbers (confirmation, capture-at-trigger, candidate capture); glossary §27.1 (≤ 0.5 s)
  INFLIGHT_BACKSTOP_MS: 120_000, READ_LEASE_MS: 120_000, READ_LEASE_RENEWALS: 3, READ_LEASE_HARD_CAP_MS: 300_000,   // glossary §20 fences / leases
  TXN_CAP_MS: 120_000, FORMATTER_GRACE_MS: 3_000, TXN_DIRTY_STAT_BOUND_MS: 20,                            // glossary §20 fences / leases; 06 §3.8.3
  PREIMAGE_CAP_BYTES: 67_108_864, DENY_PRERECORD_FSYNC_MS: 5, SHRINK_SECOND_READ_MS: 300,                 // glossary §20 seat numbers (64 MB, ≤ 5 ms); §26.1 W2 / snapshot quiet period 300 ms
  ATTRIB_RANGE_SLACK_LINES: 20, READ_REPLACED_WINDOW_MS: 2_000, REPEAT_DENY_ESCALATE_AT: 3,                // 06 §2 local numbers (± 20 lines, 2 s, 3rd G1)
  OFFLINE_NOTICE_AGAIN_MS: 600_000, EXPIRED_LEASES_DOCTOR_PER_SEAT_HOUR: 5,                               // 06 §2 local numbers (10 min, > 5 per seat-hour)
  DEGRADED_SET_WINDOW_MS: 1_800_000, DEGRADED_SILENCE_MS: 60_000, DEGRADED_RECOVERY_PAIRS: 3,             // 06 §2 (30 min); glossary §20 seat numbers (60 s, 3 pairs); CCI-34
  NOHOOKS_WINDOW_MS: 10_000, NOHOOKS_UNMATCHED: 3, NOHOOKS_UNMATCHED_WINDOW_MS: 600_000,                   // glossary §20 seat numbers (10 s; ≥ 3 in 10 min); CCI-35
  MCP_PAIRING_MS: 3_000, MCP_HEARTBEAT_MS: 15_000, SEAT_HEARTBEAT_VALID_MS: 45_000, CLAUDE_PID_CHECK_MS: 5_000, MCP_EXIT_AFTER_EOF_MS: 1_000,   // glossary §20 seat numbers; R5-35 (3 × 15 s)
  PLUGIN_CHECK_MS: 30_000, DIED_WITH_HOST_WINDOW_MS: 5_000, HUMAN_LEASE_MS: 3_600_000, HUMAN_LEASE_MAX_MIN: 480,   // glossary §20 plugin/key check; 06 §2 DAEMON_DIED_WITH_HOST; glossary §15 (60 min, --human 1–480)
  PENDING_WAKE_EXPIRY_MS: 60_000, WAKE_QUIET_BEFORE_POST_MS: 60_000, RING_RESULT_WAIT_MS: 5_000, DOORBELL_OBSERVE_MS: 100,   // 06 §2 pending-wake expiry; §3.12.2; glossary §20 doorbell post timeout 5 s; §25 F1 (100 ms)
  EVIDENCE_MAX_AGE_MS: 60_000, CLI_EVIDENCE_WAIT_MS: 3_000, GRANT_MAX_AGE_MS: 60_000,                     // 09 §3.13 step 4 (≤ 60 s, ≤ 3 s); SEC-25; R5-14
  READSET_APPLY_SPACING_MS: 120_000, MID_TURN_TRAFFIC_MS: 60_000, IDLE_CLOSE_MS: 600_000, NUDGE_AFTER_MS: 300_000,   // glossary §20 apply coalescing (2 min), seat CS fallback close (10 min), unpublished-CS nudge (300 s)
  SEAT_HOUR_MS: 3_600_000, INJECTED_CHARS_PER_SEAT_HOUR: 20_000, REMINDERS_PER_SEAT_HOUR: 15, REMINDER_CHARS_PER_SEAT_HOUR: 20_000,   // glossary §20 per seat-hour budget, seat numbers
  CLAIM_AHEAD_SHARE_CHARS: 5_000, CLAIMS_AHEAD_MAIN_THREAD_MS: 5,                                         // glossary §20 claims ahead (F05); 06 §2 (≤ 5 ms); CCI-46, CCI-61, CCI-62
  STATUS_THROTTLE_MS: 30_000, SHOW_THROTTLE_MS: 30_000, RETURN_GAP_MS: 1_800_000, RECAP_RANGE_CAP_HEIGHTS: 5_000,   // glossary §20 digest reminders (30 s), claims ahead (30 s); §29.7 catch-up (30 min, 5,000 heights)
  FRAME_MAX_BYTES: 1_048_576, FLOW_MAX_ENTRIES: 2_000, HANDSHAKE_NONCE_BYTES: 16, IPC_KEY_BYTES: 32,      // 09 §3.11 (≤ 1 MiB, 2,000 flow entries, 16-byte nonces, 32-byte key)
  HANDSHAKE_FAIL_NOTIFY_AT: 5, HANDSHAKE_FAIL_WINDOW_MS: 60_000, SECURITY_NOTIFY_SPACING_MS: 1_800_000, SOCKET_PATH_MAX_BYTES: 100,   // 09 §3.19 (≥ 5 in 60 s); glossary §20 OS notifications (≤ 1 per 30 min); 09 §3.11 (≤ 100 bytes)
  LOADER_MAX_LINES: 150, ANCESTRY_MAX_LEVELS: 16, CC_FLOOR: '2.1.270', NODE_FLOOR_MAJOR: 20,              // 06 §3.2 (≤ 150 lines); 09 §2 claude ancestor (≤ 16 levels); glossary §18 floors
  CAPS: {   // 06 §3.14.1, glossary §19, §29.6
    START: 2_500, RULES: 1_000, DIGEST: 1_500, UPS_DELTA: 1_500, UPS_SYSTEM: 1_050,                       // SessionStart/SubagentStart (rules + digest); UserPromptSubmit delta; systemMessage
    T1: 1_050, DENY: 800, T1R: 300, G2G3: 800, POST_EVENT: 1_000, POST_SLOT: 600, K2: 1_000,              // T1 first deny; other deny; T1R; G2/G3 notes; PostToolUse event + attribution slot; K2 block reason
    STOP: 1_200, DOORBELL: 1_500, TOOL: 400, SHOW: 8_000, NOTE: 280, T_SINCE: 300, PREVIEW: 2_000,        // Stop block; doorbell; MCP tool result; cowork_show; teammate note; §29.6 T-SINCE; host preview
    SCHEMA_LIVE: 3_000, SCHEMA_NONLIVE: 400, F05_CLAUSE_RESERVE: 80, STATUS_NOT_SHARED: 50, SHOW_IDS: 20,   // glossary §15 schema caps; R5-08 (80-char reserve); §15 cowork_show ≤ 20 ids
  },
} as const;

test('C is the spec values', () => {
  assert.deepEqual(C, EXPECTED);
  // Spot rows, by name.
  assert.equal(C.LOADER_DEADLINE_MS, 1_500);
  assert.equal(C.LOADER_DEADLINE_SESSION_START_MS, 3_000);
  assert.equal(C.SUSPECT_DEADLINE_MAX_MS, 7_000);
  assert.equal(C.INFLIGHT_BACKSTOP_MS, 120_000);
  assert.equal(C.READ_LEASE_HARD_CAP_MS, 300_000);
  assert.equal(C.READ_LEASE_RENEWALS, 3);
  assert.equal(C.TXN_CAP_MS, 120_000);
  assert.equal(C.FORMATTER_GRACE_MS, 3_000);
  assert.equal(C.PREIMAGE_CAP_BYTES, 67_108_864);
  assert.equal(C.MCP_PAIRING_MS, 3_000);
  assert.equal(C.SEAT_HEARTBEAT_VALID_MS, 45_000);
  assert.equal(C.CLAUDE_PID_CHECK_MS, 5_000);
  assert.equal(C.PENDING_WAKE_EXPIRY_MS, 60_000);
  assert.equal(C.RING_RESULT_WAIT_MS, 5_000);
  assert.equal(C.EVIDENCE_MAX_AGE_MS, 60_000);
  assert.equal(C.CLI_EVIDENCE_WAIT_MS, 3_000);
  assert.equal(C.FRAME_MAX_BYTES, 1_048_576);
  assert.equal(C.FLOW_MAX_ENTRIES, 2_000);
  assert.equal(C.SOCKET_PATH_MAX_BYTES, 100);
  assert.equal(C.LOADER_MAX_LINES, 150);
  assert.equal(C.CC_FLOOR, '2.1.270');
  assert.equal(C.CAPS.T1, 1_050);
  assert.equal(C.CAPS.T1R, 300);
  assert.equal(C.CAPS.POST_SLOT, 600);
  assert.equal(C.CAPS.STOP, 1_200);
  assert.equal(C.CAPS.SCHEMA_LIVE, 3_000);
  assert.equal(C.CAPS.F05_CLAUSE_RESERVE, 80);
  assert.equal(C.CAPS.T_SINCE, 300);
  // Frozen at every depth.
  assert.ok(Object.isFrozen(C));
  assert.ok(Object.isFrozen(C.CAPS));
  assert.throws(() => { (C as { LOADER_DEADLINE_MS: number }).LOADER_DEADLINE_MS = 1; }, TypeError);
  assert.throws(() => { (C.CAPS as { T1: number }).T1 = 1; }, TypeError);
});
