// The memory-only latest edit-check result per open seat CS (Plan 3 Task 10, rev 2.5; reconciliation X-05; glossary §29.8,
// 05-holds §2 `last_check`, 10-product §3.5.1 `last_check`/`last_pass`/`edit_n`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { clearReady, LastCheckStore } from '../../src/holds/lastCheck.js';

const CS = 'a'.repeat(32) + '/1';
const OTHER = 'b'.repeat(32) + '/1';
const ROOT = join(import.meta.dirname, '..', '..');

test('LastCheckStore: recordFor uses the noted edit_n, an unknown candSeq records nothing, record keeps the newest edit_n and ignores an older one, and clearCs empties the slot', () => {
  const s = new LastCheckStore();
  assert.equal(s.get(CS), null);
  s.noteCandidate(CS, 7, 9);
  s.recordFor(CS, 7, { kind: 'fail', check: 2, path: 'a.py', line: 12, more: 1 });
  assert.deepEqual(s.get(CS), { edit_n: 9, kind: 'fail', check: 2, path: 'a.py', line: 12, more: 1 });
  // An unknown candSeq records nothing.
  s.recordFor(CS, 8, { kind: 'incomplete', more: 0 });
  assert.deepEqual(s.get(CS), { edit_n: 9, kind: 'fail', check: 2, path: 'a.py', line: 12, more: 1 });
  // A first note wins (Plan 5's EditCheckpoints notes before the candidate is built).
  s.noteCandidate(CS, 7, 3);
  s.recordFor(CS, 7, { kind: 'conflict', path: 'b.py', more: 0 });
  assert.deepEqual(s.get(CS), { edit_n: 9, kind: 'fail', check: 2, path: 'a.py', line: 12, more: 1 }, 'the same edit_n keeps its first failed check');
  // An older edit_n is ignored; a newer one replaces.
  s.record(CS, { edit_n: 4, kind: 'incomplete', more: 0 });
  assert.equal(s.get(CS)?.edit_n, 9);
  s.record(CS, { edit_n: 10, kind: 'stale', check: 4, path: 'c.py', more: 0 });
  assert.deepEqual(s.get(CS), { edit_n: 10, kind: 'stale', check: 4, path: 'c.py', more: 0 });
  assert.equal(s.get(OTHER), null, 'one slot per CS');
  // The returned object is a copy: the store is not changed through it.
  const got = s.get(CS)!;
  (got as { more: number }).more = 99;
  assert.equal(s.get(CS)?.more, 0);
  s.clearCs(CS);
  assert.equal(s.get(CS), null);
  assert.deepEqual(s.pass(CS), { ready: null, shared: null });
  // The notes went with the slot: the old candSeq is unknown again.
  s.recordFor(CS, 7, { kind: 'fail', check: 1, path: 'a.py', more: 0 });
  assert.equal(s.get(CS), null);
});

test('passedFor sets last_pass.ready and clears last_check only when its edit_n is lower; sharedFor sets last_pass.shared', () => {
  const s = new LastCheckStore();
  s.noteCandidate(CS, 1, 1);
  s.noteCandidate(CS, 2, 2);
  s.noteCandidate(CS, 3, 3);
  s.recordFor(CS, 2, { kind: 'fail', check: 1, path: 'a.py', line: 3, more: 0 });
  // A pass with a lower edit_n than the failure keeps last_check.
  s.passedFor(CS, 1);
  assert.deepEqual(s.pass(CS), { ready: 1, shared: null });
  assert.equal(s.get(CS)?.edit_n, 2, 'a pass of an older edit keeps the newer failure');
  // A pass with a higher edit_n clears it.
  s.passedFor(CS, 3);
  assert.deepEqual(s.pass(CS), { ready: 3, shared: null });
  assert.equal(s.get(CS), null);
  s.sharedFor(CS, 3);
  assert.deepEqual(s.pass(CS), { ready: 3, shared: 3 });
  // An unknown candSeq changes nothing.
  s.passedFor(CS, 9);
  s.sharedFor(CS, 9);
  assert.deepEqual(s.pass(CS), { ready: 3, shared: 3 });
  // `ready` follows the journal: an HLD-41 withdrawal or a stale drop clears it (the non-member helper).
  clearReady(s, CS);
  assert.deepEqual(s.pass(CS), { ready: null, shared: 3 });
});

test('the store has exactly the eight members of X-05, no serializer, and src/holds/lastCheck.ts imports no Fs, Log, Trace or clock', async () => {
  const members = Object.getOwnPropertyNames(LastCheckStore.prototype).filter((n) => n !== 'constructor').sort();
  assert.deepEqual(members, ['clearCs', 'get', 'noteCandidate', 'pass', 'passedFor', 'record', 'recordFor', 'sharedFor']);
  const s = new LastCheckStore();
  s.noteCandidate(CS, 1, 1);
  s.recordFor(CS, 1, { kind: 'fail', check: 4, path: 'a.py', more: 0 });
  assert.deepEqual(Object.keys(s), [], 'no instance field holds the slots');
  assert.equal(JSON.stringify(s), '{}', 'nothing serializes');
  assert.equal((s as unknown as { toJSON?: unknown }).toJSON, undefined);
  const src = await readFile(join(ROOT, 'src', 'holds', 'lastCheck.ts'), 'utf8');
  const imports = src.split('\n').filter((l) => /^\s*import\b/.test(l));
  assert.deepEqual(imports, [], 'no import at all: no Fs, Log, Trace, clock or persistence');
  assert.doesNotMatch(src, /\b(Fs|Log|Trace|Clock|writeFile|appendFile|emit|log\.write)\b/);
});
