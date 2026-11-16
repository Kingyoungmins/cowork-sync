// The Plan 3 message codes and the 05 §1 next commands (Plan 3 Task 1; 05-holds §1, §2; 03-data §2; glossary §19; R3-65).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOLD_CODES, NEXT_COMMAND, type ResolveRefusal } from '../../src/holds/codes.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;

const EXPECTED = [
  'HOLD_CREATED', 'HOLD_NOT_SHARED', 'HOLD_CONFLICTED', 'HOLD_SUBSUMED', 'HOLD_GONE', 'HOLD_PARKED', 'HOLD_AUTO_PARKED', 'HOLD_RESTORED',
  'HOLD_RETURNED', 'HOLD_REVERT_HELD', 'HOLD_PIN_CONTEXT', 'HOLD_RESTORE_CONFLICT', 'HOLD_MASK_INVALID', 'HOLD_DIVERGED_REGIONS',
  'HOLD_BINARY_WHOLE_FILE', 'HOLD_NOT_OWNER', 'HOLD_ALREADY_RESOLVED', 'HOLD_DISK_CHANGED', 'HOLD_FROZEN', 'HOLD_GUARDS_REMAIN',
  'HOLD_NOT_OFFERABLE', 'HOLD_NOT_PARKABLE', 'HOLD_MIRROR_REJECTED', 'CS_UNPUBLISHED_NUDGE', 'CS_GROUP_WAITING', 'CS_READY_CANCELLED',
  'CS_NO_CHECKS_CONFIGURED', 'INCOMING_WAITING', 'INCOMING_COLLISION', 'INCOMING_UNMATERIALIZABLE', 'RESTORE_MARKERS',
  'RESTORE_BINARY_HUMAN_ONLY', 'QUARANTINE_HUMAN_ONLY', 'EOL_MIXED_HELD', 'EOL_REPAIRED', 'PATH_NOT_PORTABLE', 'GENERATED_SUSPECT', 'BOARD_FULL',
];

test('HOLD_CODES is the Plan 3 code list', T10, () => {
  assert.deepEqual([...HOLD_CODES], EXPECTED);
  assert.equal(HOLD_CODES.length, 38);
  assert.equal(new Set(HOLD_CODES).size, HOLD_CODES.length, 'no duplicate');
  for (const c of HOLD_CODES) {
    assert.match(c, /^[A-Z][A-Z0-9_]{2,47}$/);
    assert.ok(!c.includes('VIOLATION'), c);
  }
  assert.ok(!HOLD_CODES.includes('HOLD_NOT_DURABLE'));
  for (const c of ['EOL_MIXED_HELD', 'EOL_REPAIRED', 'PATH_NOT_PORTABLE', 'INCOMING_COLLISION', 'INCOMING_UNMATERIALIZABLE', 'RESTORE_MARKERS',
    'RESTORE_BINARY_HUMAN_ONLY', 'GENERATED_SUSPECT', 'QUARANTINE_HUMAN_ONLY']) {
    assert.ok(HOLD_CODES.includes(c), c);
  }
  assert.ok(Object.isFrozen(HOLD_CODES));
});

test('NEXT_COMMAND matches the 05 §1 refusal table', T10, () => {
  assert.deepEqual({ ...NEXT_COMMAND }, {
    HOLD_NOT_OWNER: '/cowork show <id>',
    HOLD_GUARDS_REMAIN: 'wait, cowork_request go-first, or --handoff',
    HOLD_NOT_OFFERABLE: '/cowork resolve <id> --publish|--discard',
    HOLD_NOT_PARKABLE: '\u{2014}',
    HOLD_RESTORE_CONFLICT: '/cowork show <id>',
    HOLD_DISK_CHANGED: 'repeat the command',
    HOLD_FROZEN: '/cowork status',
    STOP_HOLDS_NOT_DURABLE: '--discard-holds=<ids> --confirm=<id>',
    UNINSTALL_HOLDS: '--discard-holds=<ids> --confirm=<id>',
    HOLD_MASK_INVALID: '/cowork doctor',
    RESTORE_BINARY_HUMAN_ONLY: '/cowork resolve <id> --restore',
    QUARANTINE_HUMAN_ONLY: '/cowork review <id> --accept',
  });
  const refusals: ResolveRefusal[] = ['HOLD_NOT_OWNER', 'HOLD_GUARDS_REMAIN', 'HOLD_NOT_OFFERABLE', 'HOLD_NOT_PARKABLE', 'HOLD_RESTORE_CONFLICT', 'HOLD_DISK_CHANGED', 'HOLD_FROZEN'];
  for (const r of refusals) assert.equal(typeof NEXT_COMMAND[r], 'string', r);
  const exact: Equals<ResolveRefusal, 'HOLD_NOT_OWNER' | 'HOLD_GUARDS_REMAIN' | 'HOLD_NOT_OFFERABLE' | 'HOLD_NOT_PARKABLE' | 'HOLD_RESTORE_CONFLICT' | 'HOLD_DISK_CHANGED' | 'HOLD_FROZEN'> = true;
  const noHumanOnly: Equals<Extract<ResolveRefusal, 'RESTORE_BINARY_HUMAN_ONLY' | 'QUARANTINE_HUMAN_ONLY'>, never> = true;
  assert.ok(exact && noHumanOnly);
  for (const r of refusals) assert.ok(HOLD_CODES.includes(r), r);
  assert.ok(Object.isFrozen(NEXT_COMMAND));
});
