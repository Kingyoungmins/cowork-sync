// Snapshotter.setEntry (Plan 3 Task 5; R3-34, R3-36, glossary §26.1 W6): one private-index entry is set by treeEdit.ts's
// editIndexOnly (one `update-index --add --replace -z --index-info` on the private index, INDEX_ONLY config; the stdin form of
// --cacheinfo), so the next tick reads the written file as clean. No object is written. Real git on a file:// clone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { AttrCache } from '../../src/data/attrs.js';
import { DEFAULT_TEAM_CONFIG } from '../../src/data/config.js';
import { humanOnlyAttribution } from '../../src/engine/deps.js';
import { Snapshotter, type TickInput } from '../../src/engine/snapshot.js';
import type { TreeEntry } from '../../src/git/repo.js';
import { noTrace } from '../../src/ports/trace.js';
import { makeSnapFixture, type SnapFixture } from '../helpers/snapFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const PRIVATE = (s: SnapFixture): string => join(s.f.paths.coworkDir, 'main.index');

async function setup(s: SnapFixture): Promise<{ snap: Snapshotter; inp: TickInput }> {
  const snap = new Snapshotter({
    repo: s.repo, fs: s.fs, clock: s.clock, trace: noTrace, peer: '0123456789abcdef0123456789abcdef',
    privateIndex: PRIVATE(s), scratch: { detect: join(s.tmp, 'detect.index'), canon: join(s.tmp, 'canon.index') },
    stage: s.stage, statCache: s.statCache, attribution: humanOnlyAttribution, filters: { drivers: [], fingerprint: {}, overCap: null },
  });
  const tree = (await s.repo.readCommit(s.head)).tree;
  await snap.reseed(tree);
  const inp: TickInput = {
    A: s.A, aTree: tree, epochBase: s.head, skip: new Set(),
    scope: { attrs: await new AttrCache(s.repo, s.fs).snapshot(s.head, s.A.keys()), config: DEFAULT_TEAM_CONFIG, mergeDrivers: new Set(), localOnlyPaths: new Set(), hooksPathDir: null },
  };
  return { snap, inp };
}

async function privateEntries(s: SnapFixture): Promise<Map<string, TreeEntry>> {
  return s.f.repo.listIndex(PRIVATE(s));
}

test('Snapshotter.setEntry sets one private-index entry with update-index --cacheinfo and writes no object', T10, async () => {
  const s = await makeSnapFixture('set-entry');
  try {
    const { snap, inp } = await setup(s);
    await snap.tick(inp);
    const blob = s.A.get('src/b.txt')!.oid;   // an existing blob (the body of another file)
    const before = await privateEntries(s);
    const loose = await s.loose();
    const from = s.calls.length;
    await snap.setEntry('src/a.txt', { path: 'src/a.txt', mode: '100644', oid: blob });
    const calls = s.calls.slice(from);
    // Plan 2 final review FB-6 (merge): editIndexOnly verifies its edits (treeEdit.ts verifyIndexEdits), so the update-index is
    // followed by one read-back of the edited path from the same index — a read, never an object write.
    assert.equal(calls.length, 2, `the edit and its read-back: ${JSON.stringify(calls.map((c) => c.args))}`);
    const call = calls[0]!;
    assert.equal(call.args[0], 'update-index');
    assert.ok(call.args.includes('--index-info'), 'editIndexOnly: the stdin form of --cacheinfo');
    assert.equal(call.opts.indexFile, PRIVATE(s), 'the private GIT_INDEX_FILE');
    const verify = calls[1]!;
    assert.deepEqual(verify.args, ['ls-files', '-s', '-z', '--', 'src/a.txt'], 'the read-back of the one edited path');
    assert.equal(verify.opts.indexFile, PRIVATE(s), 'read back from the private GIT_INDEX_FILE');
    assert.equal(calls.filter((c) => c.args[0] === 'hash-object' || c.args[0] === 'add').length, 0, 'no hash-object, no add');
    const after = await privateEntries(s);
    assert.equal(after.get('src/a.txt')?.oid, blob, 'the entry of src/a.txt is the given blob');
    assert.equal(after.get('src/a.txt')?.mode, '100644');
    for (const [p, e] of before) {
      if (p === 'src/a.txt') continue;
      assert.deepEqual(after.get(p), e, `${p} unchanged`);
    }
    assert.equal(after.size, before.size);
    assert.deepEqual(await s.loose(), loose, 'the loose-object count is unchanged');
  } finally {
    await s.cleanup();
  }
});

test('after setEntry the next tick reads a file holding the entry\'s blob as clean; a null entry removes the path from the private index', T10, async () => {
  const s = await makeSnapFixture('set-entry-tick');
  try {
    const { snap, inp } = await setup(s);
    await snap.tick(inp);
    // A local write puts src/b.txt's body at src/a.txt (as writeLocal would): the private index is told the same blob.
    await s.write('src/a.txt', 'alpha\nbeta\n');
    await snap.setEntry('src/a.txt', { path: 'src/a.txt', mode: '100644', oid: s.A.get('src/b.txt')!.oid });
    const t = await snap.tick(inp);
    assert.equal(t.dirty.has('src/a.txt'), false, 'not dirty');
    assert.equal(t.changed.has('src/a.txt'), false, 'not changed');
    // A removal: the path leaves the private index; the deleted file is then no deletion delta.
    await s.fs.unlink(s.abs('src/b.txt'));
    await snap.setEntry('src/b.txt', null);
    assert.equal((await privateEntries(s)).has('src/b.txt'), false);
    s.clock.advance(1_500);
    const t2 = await snap.tick(inp);
    s.clock.advance(1_500);
    const t3 = await snap.tick(inp);
    for (const x of [t2, t3]) {
      assert.equal(x.dirty.has('src/b.txt'), false, 'no removal is staged');
      assert.equal(x.changed.has('src/b.txt'), false);
    }
  } finally {
    await s.cleanup();
  }
});
