// SnapshotStore (Plan 4 Task 4; REG-35, R1-035, OQ-17, INV-REG-READ, INV-SECRET): working bytes live only in memory under
// owner tokens; a DiskSnapshotId crosses every boundary as (path, oid) only. testSnapshot computes git's blob id in memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOid } from '../../src/git/oid.js';
import { SnapshotGoneError, SnapshotStore } from '../../src/regions/snapshots.js';
import { looseObjectCount } from '../helpers/regionAsserts.js';
import { testSnapshot } from '../helpers/regionRuntime.js';
import { makeRepoFixture } from '../helpers/repoFixture.js';

const OID_A = parseOid('a'.repeat(40));
const OID_B = parseOid('b'.repeat(40));

test('SnapshotStore keeps working bytes only in memory under owner tokens', () => {
  const store = new SnapshotStore();
  assert.equal(store.size, 0);
  const bytes = Buffer.from('def f():\n    return 1\n', 'utf8');
  const id = store.register('a.py', OID_A, bytes, 'o1');
  assert.deepEqual(id, { kind: 'disk', path: 'a.py', oid: OID_A });
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(id)) as object).sort(), ['kind', 'oid', 'path'], 'the handle carries no bytes');
  assert.equal(store.register('a.py', OID_A, bytes, 'o3'), id, 'the same (path, oid) returns the same handle');
  assert.equal(store.size, 1);
  assert.equal(store.bytes(id), bytes);
  assert.equal(store.has(OID_A), true);

  // another path with the same content is another handle
  const other = store.register('b.py', OID_A, bytes, 'o1');
  assert.notEqual(other, id);
  assert.equal(store.size, 2);

  store.retain(id, 'o2');
  store.release('o1');
  store.release('o3');
  assert.equal(store.bytes(id), bytes, 'o2 still retains it');
  assert.equal(store.size, 1, 'b.py had only o1');
  assert.throws(() => store.bytes(other), SnapshotGoneError);
  store.release('o2');
  assert.equal(store.size, 0);
  assert.throws(() => store.bytes(id), SnapshotGoneError);
  assert.equal(store.has(OID_A), false);
  assert.throws(() => store.retain(id, 'o4'), SnapshotGoneError, 'a released handle cannot be revived by retain');
  // releasing an unknown owner is a no-op
  store.release('nobody');
  assert.equal(store.has(OID_B), false);
});

test('SnapshotGoneError has the contract\'s shape: Error\'s own constructor', () => {
  // contract: `export class SnapshotGoneError extends Error {}` — constructed like Error (message?, options?)
  const e = new SnapshotGoneError('gone');
  assert.ok(e instanceof Error && e instanceof SnapshotGoneError);
  assert.equal(e.message, 'gone');
  assert.equal(e.name, 'SnapshotGoneError');
  assert.equal(new SnapshotGoneError().message, '');
  const cause = new Error('why');
  assert.equal(new SnapshotGoneError('m', { cause }).cause, cause);
  // the store's own throw names the handle (path and oid only)
  const store = new SnapshotStore();
  const id = store.register('a.py', OID_A, Buffer.from('x\n'), 'o');
  store.release('o');
  assert.throws(() => store.bytes(id), (err: unknown) => err instanceof SnapshotGoneError && err.message === `disk snapshot released: a.py ${OID_A}`);
});

test('testSnapshot computes git\'s blob id in memory', async () => {
  const f = await makeRepoFixture('test-snapshot');
  try {
    const store = new SnapshotStore();
    const before = await looseObjectCount(f.paths.gitDir);
    for (const bytes of [Buffer.alloc(0), Buffer.from('x\r\n\u{ac00}\n', 'utf8'), Buffer.from([0xef, 0xbb, 0xbf, 0x00, 0xff, 0x0a])]) {
      const id = testSnapshot(store, 'a.py', bytes);
      assert.equal(id.oid, await f.repo.hashBytes(bytes, false), 'the oid of `git hash-object --stdin` (route c, no write)');
      assert.equal(store.bytes(id), bytes);
    }
    assert.equal(await looseObjectCount(f.paths.gitDir), before, 'no object is written');
    // the default owner is 'test'
    store.release('test');
    assert.equal(store.size, 0);
  } finally {
    await f.cleanup();
  }
});
