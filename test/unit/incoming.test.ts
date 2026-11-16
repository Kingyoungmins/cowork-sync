// The receive-side pure parts (Plan 3 Task 6; 05-holds HLD-32, HLD-54; rulings R3-30, R3-31): the 60 s transient clocks
// (Δmono since first sight, in memory, restarted with the daemon), the closure-reason → INCOMING guard map and the group-level
// reason of one deferred write group. No git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { DeferReason } from '../../src/holds/groups.js';
import { closureReason, INCOMING_GUARD_OF, TRANSIENT_RECORD_MS, TransientClocks, type ClosureReason } from '../../src/holds/incoming.js';
import { VirtualClock } from '../sim/vclock.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

test('TransientClocks.see returns Δmono since first sight; forget resets; a new instance starts at 0', T10, () => {
  assert.equal(TRANSIENT_RECORD_MS, 60_000);
  const clock = new VirtualClock({ startMono: 5_000 });
  const c = new TransientClocks(clock);
  assert.equal(c.see('path:a.txt'), 0, 'first sight');
  clock.advance(40_000);
  assert.equal(c.see('path:a.txt'), 40_000, 'Δmono since first sight');
  assert.equal(c.see('closure:b.txt'), 0, 'another key starts at its own first sight');
  clock.advance(1_500);
  assert.deepEqual([...c.ages()].sort(), [['closure:b.txt', 1_500], ['path:a.txt', 41_500]]);
  c.forget('path:a.txt');
  assert.equal(c.ages().has('path:a.txt'), false, 'forgotten');
  assert.equal(c.see('path:a.txt'), 0, 'after forget the next see is a first sight');
  clock.advance(2_000);
  assert.equal(c.see('path:a.txt'), 2_000);
  // A restart: a fresh instance (in memory only, R3-30) knows no key.
  const restarted = new TransientClocks(clock);
  assert.equal(restarted.ages().size, 0);
  assert.equal(restarted.see('path:a.txt'), 0);
  assert.equal(restarted.see('closure:b.txt'), 0);
  // Wall time alone (a suspend) does not age a key: the clocks are Δmono.
  clock.suspend(120_000);
  assert.equal(restarted.see('path:a.txt'), 0);
});

test('INCOMING_GUARD_OF maps eol_form, local_only_conflict and every other apply-side reason', T10, () => {
  assert.equal(INCOMING_GUARD_OF.eol_form, 'eol-form');
  assert.equal(INCOMING_GUARD_OF.local_only_conflict, 'local-only-conflict');
  const lockLike: ClosureReason[] = ['locked', 'disk_low', 'unreadable', 'unstable', 'fence', 'read_lease', 'txn', 'conflicted_leased', 'mismatch', 'race', 'filter_failure'];
  for (const r of lockLike) assert.equal(INCOMING_GUARD_OF[r], 'lock', r);
  // Exactly the ClosureReason members: never 'closure', and never a not-applicable reason.
  assert.deepEqual(Object.keys(INCOMING_GUARD_OF).sort(), [...lockLike, 'eol_form', 'local_only_conflict'].sort());
  for (const k of ['closure', 'collision', 'unmaterializable', 'quarantine']) assert.equal(Object.hasOwn(INCOMING_GUARD_OF, k), false, k);
  // A closure's guard is the guard of its group-level reason, never `closure`.
  assert.equal(INCOMING_GUARD_OF[closureReason(['closure', 'locked'])], 'lock');
  assert.equal(INCOMING_GUARD_OF[closureReason(['closure', 'eol_form', 'unstable'])], 'eol-form');
  assert.ok(Object.isFrozen(INCOMING_GUARD_OF));
});

test('closureReason picks eol_form, then local_only_conflict, then any other reason, and ignores closure', T10, () => {
  const cases: Array<[DeferReason[], ClosureReason]> = [
    [['closure', 'locked'], 'locked'],
    [['locked', 'eol_form', 'closure'], 'eol_form'],
    [['local_only_conflict', 'disk_low'], 'local_only_conflict'],
    [['eol_form', 'local_only_conflict'], 'eol_form'],
    [['disk_low', 'closure', 'local_only_conflict'], 'local_only_conflict'],
    [['unreadable'], 'unreadable'],
    [['closure', 'unstable', 'locked'], 'unstable'],   // any other: the first in the given order
  ];
  for (const [reasons, want] of cases) assert.equal(closureReason(reasons), want, JSON.stringify(reasons));
  // The writer refusing a group (DeferGroup 'unmaterializable': a path beneath a symlink found at write time) is apply-side
  // like a lock: its closure is a `lock` closure, never a not-applicable reason.
  assert.equal(closureReason(['unmaterializable']), 'locked');
  // A deferred group always carries a reason other than `closure` (writeGroups): anything else is a caller bug.
  assert.throws(() => closureReason([]), TypeError);
  assert.throws(() => closureReason(['closure', 'closure']), TypeError);
});

test("Task 6's modules keep no private copy of the shared tree and case helpers", T10, async () => {
  // Global Constraints "Shared helpers, never copied": the entry comparison is treeDiff's sameTreeEntry (src/holds takes it from the
  // caller as IncomingInputs.differs), the regular-entry test is one definition (git/repo.ts, re-exported by treeDiff.ts for
  // src/engine), and D7 rule 4's key is scope.ts's collisionKey.
  const copies: Array<[string, RegExp]> = [
    ['an entry comparison (sameTreeEntry)', /\.oid === \w+\.oid && \w+\.mode === \w+\.mode/],
    ['a regular-entry test (isRegularEntry)', /mode === '100644' \|\| \w+\.mode === '100755'/],
    ['a case-fold key (collisionKey)', /normalize\('NFC'\)\.toUpperCase\(\)\.toLowerCase\(\)/],
  ];
  const found: string[] = [];
  for (const file of ['src/holds/incoming.ts', 'src/data/formCheck.ts', 'src/engine/core.ts', 'src/engine/apply.ts']) {
    const text = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
    for (const [what, re] of copies) if (re.test(text)) found.push(`${file}: ${what}`);
  }
  assert.deepEqual(found, [], 'no private copy');
  const treeDiff = await import('../../src/engine/treeDiff.js');
  const repo = await import('../../src/git/repo.js');
  assert.equal(typeof repo.isRegularEntry, 'function');
  assert.equal(treeDiff.isRegularEntry, repo.isRegularEntry, 'one isRegularEntry, re-exported');
});
