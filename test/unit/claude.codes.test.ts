// Plan 5 Task 1: the code lists Plan 5 selects (R2-E5, R5-60), each pinned against the spec text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CCI_CODES, LOG_ONLY_CODES, MANDATORY_FAMILIES, NEW_CODES, PULL_MODE_SUPPRESSED, ROUTED_CODES } from '../../src/claude/wire/codes.js';
import { REASON_CODE_RE } from '../../src/board/ops.js';
import { HOLD_CODES } from '../../src/holds/codes.js';

const SPEC = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'docs', 'spec');
const spec = (name: string): string => readFileSync(join(SPEC, name), 'utf8');
const inBackticks = (text: string, code: string): boolean => text.includes('`' + code + '`');

/** (a) 06 §3.14.4 Claude-facing codes, the MCP refusal codes, and 07's SINCE_POINTER. */
const CLAUDE_FACING = [
  'G4_DOWN', 'HOOK_LOAD_FAIL', 'PAUSED_LINE', 'DAEMON_DOWN', 'VERSION_RESTART', 'CC_TOO_OLD', 'WAKE_TURN', 'STATE_FILE', 'NOT_SHARED',
  'PORTABILITY', 'SYMLINK', 'PATH_BUSY', 'MOVED', 'HELDREG', 'SUSPECT_LOST', 'GRANT_PAUSE', 'CLAIM_HELD_DENY', 'HELD_CS', 'SHELL_GIT',
  'SHELL_FORMATTER', 'SHELL_INPLACE', 'SHELL_COWORK_CLI', 'WORKTREE_DENY', 'WT_NOTE', 'WT_SUBMODULE', 'ATTRIBUTION', 'CLAIM_AHEAD',
  'CLAIM_AHEAD_ENDED', 'HOLD_IN_FILE', 'OWN_CHANGE_HELD', 'HOLD_MIRROR_REJECTED', 'READ_REPLACED', 'HUMAN_EDIT_OWN_CLAIM',
  'CS_UNPUBLISHED_NUDGE', 'STOP_SUMMARY', 'DIGEST_SUPERSEDES', 'DEGRADED', 'HOOK_ONLY', 'NOHOOKS', 'STATUS_NO_CHANGE', 'SHOW_NO_CHANGE',
  'NOT_OWN_RECORD', 'TERMINAL_RECORD', 'QUARANTINE_HUMAN_ONLY', 'UNKNOWN_ID', 'NOT_OWN_CLAIM', 'AMBIGUOUS_ID', 'MULTI_HOLDER',
  'NOT_ADDRESSED_TO_SEAT', 'RELEASE_UNLANDED', 'GOFIRST_OPEN', 'GOFIRST_RECENT', 'DECLINED_SAME', 'NOTE_SECRET_HIT',
  'RESTORE_BINARY_HUMAN_ONLY', 'RESTORE_MARKERS', 'SINCE_POINTER',
];
/** (b) 06 §3.14.4 human-facing codes and §1.2. */
const HUMAN_FACING = [
  'REFUSE_PROJECT_SCOPE', 'REFUSE_CC_VERSION', 'REFUSE_NODE_VERSION', 'REFUSE_WORKTREE', 'REFUSE_SECOND_CHECKOUT', 'NO_NODE_ON_CLAUDE_PATH',
  'WRITE_UNREADABLE_FILE', 'CC_VERSION_UNKNOWN', 'LIVE_MARKER_RESTORED', 'DAEMON_REMOVED', 'IDLE_NO_SESSION', 'DAEMON_DIED_WITH_HOST', 'UI_SINCE_RECAP',
];
/** (c) 09 §3.11, §3.13, §3.14 SEC_ codes. */
const SEC = [
  'SEC_REFUSE_IPC_ACL', 'SEC_REFUSE_IPC_SQUATTER', 'SEC_REFUSE_SOCKET_PATH', 'SEC_IPC_HANDSHAKE_FAILED', 'SEC_EVIDENCE_TAG_INVALID',
  'SEC_REFUSE_NOT_HUMAN', 'SEC_NOHOOKS',
];
/** 06 §3.14.4 codes Plan 3's src/holds/codes.ts declares (X-117, R3-65 for QUARANTINE_HUMAN_ONLY): routed, never in CCI_CODES (R-F2-4). */
const HOLDS_DECLARED = ['CS_UNPUBLISHED_NUDGE', 'HOLD_MIRROR_REJECTED', 'QUARANTINE_HUMAN_ONLY', 'RESTORE_BINARY_HUMAN_ONLY', 'RESTORE_MARKERS'];

test('CCI_CODES and ROUTED_CODES split the 06 §3.14.4, §1.2 and 09 SEC_ code lists plus NEW_CODES and PAUSED: each code in exactly one list, the five Plan 3-declared codes routed, each pinned against the spec text (R-F2-4)', () => {
  // Decision point 5-4: the health code PAUSED (plan line 203's list) is declared here — beside NEW_CODES,
  // whose members get registry entries — and its mapping lands in CODE_OF; 00 §2 lists PAUSED as a seat flag.
  const TABLE = [...CLAUDE_FACING, ...HUMAN_FACING, ...SEC, ...NEW_CODES, 'PAUSED'];
  assert.deepEqual([...CCI_CODES].sort(), TABLE.filter((c) => !HOLDS_DECLARED.includes(c)).sort());
  // Every table code is in exactly one of the two lists (X-117: declared once; the five are Plan 3's, referenced here).
  for (const c of TABLE) assert.equal(Number(CCI_CODES.includes(c)) + Number((ROUTED_CODES as readonly string[]).includes(c)), 1, c);
  for (const c of HOLDS_DECLARED) assert.ok(HOLD_CODES.includes(c), c);
  assert.equal(new Set(CCI_CODES).size, CCI_CODES.length, 'no duplicate');
  // Each spec code appears in backticks in 06, 07 or 09.
  const text = ['06-claude.md', '07-coordination.md', '09-security.md'].map(spec).join('\n');
  for (const code of [...CLAUDE_FACING, ...HUMAN_FACING, ...SEC]) assert.ok(inBackticks(text, code), `${code} in backticks in 06/07/09`);
  // NEW_CODES (SE5-08) appear in no spec file yet; FLOW_PATH_INVALID is the last one (R5-60).
  assert.deepEqual(NEW_CODES, ['SEAT_FULL', 'SEAT_NO_MCP', 'SEAT_PULL_MODE', 'PEER_IDLE', 'RESTORE_NOT_ALLOWED', 'NOTE_SCAN_UNAVAILABLE', 'FLOW_PATH_INVALID']);
  const all = readdirSync(SPEC).filter((n) => n.endsWith('.md')).map(spec).join('\n');
  for (const code of NEW_CODES) assert.ok(!new RegExp(`\\b${code}\\b`).test(all), `${code} is not in the spec yet`);
  for (const code of CCI_CODES) assert.match(code, REASON_CODE_RE);
  for (const gone of ['CS_NUDGE', 'SEC_QUARANTINE_HUMAN_ONLY', 'SEC_NOTE_REFUSED_SECRET']) {
    assert.ok(!CCI_CODES.includes(gone), gone);
    assert.ok(!(ROUTED_CODES as readonly string[]).includes(gone), gone);
  }
  assert.ok(!CCI_CODES.some((c) => c.includes('VIOLATION')));
});

test('ROUTED_CODES are other chapters\' registry codes, each pinned against its chapter', () => {
  assert.deepEqual(ROUTED_CODES, ['HOLD_PIN_CONTEXT', 'INCOMING_WAITING', 'CS_GROUP_WAITING', 'CS_READY_CANCELLED', 'CS_UNPUBLISHED_NUDGE',
    'HOLD_MIRROR_REJECTED', 'QUARANTINE_HUMAN_ONLY', 'RESTORE_BINARY_HUMAN_ONLY', 'RESTORE_MARKERS', 'FROZEN', 'UNFROZEN', 'OFFLINE', 'ONLINE',
    'NONRETRYABLE', 'VERSION_PAUSED', 'INCIDENT', 'STANDING_RULES', 'RF_UNKNOWN_VERB']);
  // X-117: a reference's code must exist in its owner's module; the nine holds-layer codes are Plan 3's HOLD_CODES.
  for (const c of ROUTED_CODES.slice(0, 9)) assert.ok(HOLD_CODES.includes(c), `${c} is declared in src/holds/codes.ts`);
  const holds = spec('05-holds.md');
  for (const c of ['HOLD_PIN_CONTEXT', 'INCOMING_WAITING', 'CS_GROUP_WAITING', 'CS_READY_CANCELLED']) assert.ok(inBackticks(holds, c), c);
  const holdsDataSec = holds + spec('03-data.md') + spec('09-security.md');
  for (const c of HOLDS_DECLARED) assert.ok(inBackticks(holdsDataSec, c), `${c} in backticks in 05/03/09`);
  const engine = spec('00-glossary.md') + spec('01-engine.md');
  for (const c of ['FROZEN', 'UNFROZEN', 'OFFLINE', 'ONLINE', 'NONRETRYABLE', 'VERSION_PAUSED', 'INCIDENT']) assert.ok(inBackticks(engine, c), c);
  const coord = spec('07-coordination.md');
  const s3164 = coord.slice(coord.indexOf('#### 3.16.4'));
  assert.ok(coord.includes('#### 3.16.4') && inBackticks(s3164, 'STANDING_RULES'), 'STANDING_RULES in 07 §3.16.4');
  const product = spec('10-product.md');
  const s12 = product.slice(product.indexOf('### 1.2'), product.indexOf('### 1.3'));
  assert.ok(inBackticks(s12, 'RF_UNKNOWN_VERB'), 'RF_UNKNOWN_VERB in 10 §1.2');
  for (const c of ROUTED_CODES) {
    assert.match(c, REASON_CODE_RE);
    assert.ok(!CCI_CODES.includes(c), `${c} is not a CCI code`);
  }
  for (const c of ['MORE', 'RULES']) assert.ok(!ROUTED_CODES.includes(c as never) && !CCI_CODES.includes(c), c);
});

test('CCI_CODES, ROUTED_CODES and LOG_ONLY_CODES are pairwise disjoint, and LOG_ONLY_CODES is the A6-9 / X-30 log-only list (F2 #88 #143)', () => {
  // The X-29 scan keeps one Set per module, so an overlap inside src/claude/wire/codes.ts is caught only here.
  const lists: ReadonlyArray<readonly [string, readonly string[]]> = [['CCI_CODES', CCI_CODES], ['ROUTED_CODES', ROUTED_CODES], ['LOG_ONLY_CODES', LOG_ONLY_CODES]];
  for (const [i, [a, xs]] of lists.entries()) {
    for (const [b, ys] of lists.slice(i + 1)) assert.deepEqual(xs.filter((c) => ys.includes(c)), [], `${a} and ${b} share no code`);
  }
  for (const c of LOG_ONLY_CODES) assert.match(c, REASON_CODE_RE);
  // DAEMON_INTERNAL_ERROR (R-F2-14: a throwing hook step, hello or ticker is logged, never answered) is declared here once, by the F2
  // controller's ruling C-2; the X-29 scan reads LOG_ONLY_CODES as a declaration list, so a second declaration elsewhere fails there.
  assert.deepEqual(LOG_ONLY_CODES, ['CS_SIGNAL_REJECTED', 'SESSION_END', 'SEAT_HOOK', 'DAEMON_INTERNAL_ERROR']);
  assert.ok(Object.isFrozen(LOG_ONLY_CODES));
});

test('MANDATORY_FAMILIES and PULL_MODE_SUPPRESSED are the 06 §3.16.1 lists', () => {
  assert.deepEqual(MANDATORY_FAMILIES, ['g1', 'k2', 'own_change_held_wake', 'stop_truth']);
  assert.deepEqual(PULL_MODE_SUPPRESSED, ['ATTRIBUTION', 'CLAIM_AHEAD', 'CLAIM_AHEAD_ENDED', 'SINCE_POINTER', 'CS_UNPUBLISHED_NUDGE', 'bystander']);
  for (const f of MANDATORY_FAMILIES) assert.ok(!(PULL_MODE_SUPPRESSED as readonly string[]).includes(f), f);
  assert.ok(Object.isFrozen(CCI_CODES) && Object.isFrozen(NEW_CODES) && Object.isFrozen(ROUTED_CODES));
  assert.ok(Object.isFrozen(MANDATORY_FAMILIES) && Object.isFrozen(PULL_MODE_SUPPRESSED));
});
