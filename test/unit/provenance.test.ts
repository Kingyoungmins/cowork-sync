// The provenance journal's line helpers (Plan 3 Task 8; 05-holds §2 "non-trivial line", HLD-25): which stored-form lines are
// recorded, and the SHA-1 line hash that ignores the row's ending.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rows, stripEnding } from '../../src/data/rows.js';
import { HOLD_CODES, HOLD_LOG_CODES } from '../../src/holds/codes.js';
import { isNonTrivial, lineHash, PROV_RETENTION_MS } from '../../src/holds/provenance.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const b = (s: string): Buffer => Buffer.from(s, 'utf8');

test("isNonTrivial: '', '   \\t', '});', '++' and '© ®' are trivial; 'x = 1', '  // ok' and '가' are not", T10, () => {
  for (const s of ['', '   \t', '});', '++', '\u{a9} \u{ae}']) assert.equal(isNonTrivial(b(s)), false, JSON.stringify(s));
  for (const s of ['x = 1', '  // ok', '\u{ac00}']) assert.equal(isNonTrivial(b(s)), true, JSON.stringify(s));
  assert.equal(PROV_RETENTION_MS, 1_209_600_000, '14 days');
});

test("lineHash is the SHA-1 hex of a row without its EOL: the rows 'a\\r\\n' and 'a\\n' both hash as 'a'", T10, () => {
  const sha1a = createHash('sha1').update(b('a')).digest('hex');
  const crlf = stripEnding(rows(b('a\r\nz\n'))[0]!);
  const lf = stripEnding(rows(b('a\nz\n'))[0]!);
  assert.equal(lineHash(crlf), sha1a);
  assert.equal(lineHash(lf), sha1a);
  assert.equal(lineHash(b('a')), sha1a);
  assert.match(lineHash(b('TEAM = 1')), /^[0-9a-f]{40}$/);
  assert.notEqual(lineHash(b('a ')), sha1a, 'whitespace inside the row counts');
});

test('PROV_REBUILT and PROV_ADVANCE_FAILED are registered daemon-log codes (HOLD_LOG_CODES), outside HOLD_CODES, which stays at 38', T10, () => {
  // Task 8 fix round 1, finding 5 (controller ruling): the journal's two log lines carry registered codes; they go to the daemon log
  // only (never status.json or the board), so HOLD_CODES keeps Task 1's 38 (Codes constraint).
  // Task 11 adds R3-28's --discard log line, HOLD_DISCARDED (Task 5 ruling (d): a registered code, never in HOLD_CODES).
  // Integration I-4 (r2 fix C concern 2, Ruling R3-FF3-I) adds R3-FF2-C1's failed scope read, RECORD_SCOPE_FAILED.
  // EF5 X3-1 (Ruling R3-EF4-27) adds a valueless or invalid user core.hooksPath, HOOKS_PATH_INVALID; the EF5 minors ruling adds
  // integration I2-5's failed settle of a redundant K4 companion after a rollback, APPLY_COMPANION_SETTLE_FAILED.
  assert.deepEqual([...HOLD_LOG_CODES], ['PROV_REBUILT', 'PROV_ADVANCE_FAILED', 'HOLD_DISCARDED', 'RECORD_SCOPE_FAILED', 'HOOKS_PATH_INVALID', 'APPLY_COMPANION_SETTLE_FAILED']);
  assert.ok(Object.isFrozen(HOLD_LOG_CODES));
  for (const c of HOLD_LOG_CODES) {
    assert.match(c, /^[A-Z][A-Z0-9_]{2,47}$/);
    assert.ok(!HOLD_CODES.includes(c), c);
  }
  assert.equal(HOLD_CODES.length, 38);
});
