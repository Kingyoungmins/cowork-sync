// Index-only tree edits (src/engine/treeEdit.ts; ENG-10 operation 3, ruling R-15, P2-NTFS, P2-SCRATCHLOCK) and the final
// review FB-6 refusals: git for Windows refuses a root name with a drive prefix (`a:b.txt`, `x:`) in ANY index, whatever
// core.protectNTFS says (verify_path's has_dos_drive_prefix: read-tree exits 128, update-index --index-info prints
// "Ignoring path" and exits 0). The edits must never diverge silently: a refused path is a typed IndexRefusedPathError.
// Real git on a file:// clone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { editIndexOnly, editTreeIndexOnly, hasDrivePrefix, IndexRefusedPathError } from '../../src/engine/treeEdit.js';
import { parseOid } from '../../src/git/oid.js';
import { GitCommandError, type MktreeEntry } from '../../src/git/repo.js';
import { realFs } from '../../src/ports/fs.js';
import { makeRepoFixture } from '../helpers/repoFixture.js';

const WIN = process.platform === 'win32';

test('final review FB-6: hasDrivePrefix mirrors git for Windows\' has_dos_drive_prefix (one ASCII byte, or one run of 1-4 high-bit bytes, then \':\')', () => {
  for (const p of ['a:b.txt', 'x:', '1:x', '.:x', '::x', 'é:x', '\u{1F600}:x', 'éé:x']) assert.equal(hasDrivePrefix(p), true, p);
  for (const p of ['ab:c', ':x', 'dir/a:b', 'aux.c', 'a', '', 'ééé:x', 'a/b:c', '\u{1F600}\u{1F600}:x']) assert.equal(hasDrivePrefix(p), false, p);
});

test('final review FB-6: the read-back of an index edit takes every path literally: names with pathspec magic or glob characters land and verify', async () => {
  const f = await makeRepoFixture('treeedit-fb6-literal');
  try {
    const head = await f.repo.resolve('HEAD');
    assert.ok(head !== null);
    const base = (await f.repo.readCommit(head)).tree;
    const blob = await f.repo.hashBytes(Buffer.from('lit\n'), true);
    const tmp = join(f.paths.coworkDir, 'tmp');
    await fsp.mkdir(tmp, { recursive: true });
    const names = [':lead.txt', 'g[1]*.txt', 'src/?.md', 'ab:c.txt'];
    const out = await editTreeIndexOnly(f.repo, realFs, base, names.map((path) => ({ path, mode: '100644' as const, oid: blob })), join(tmp, 'l.index'));
    const m = await f.repo.readTreeMap(out);
    for (const n of names) assert.equal(m.get(n)?.oid, blob, n);
    const back = await editTreeIndexOnly(f.repo, realFs, out, names.map((path) => ({ path, remove: true as const })), join(tmp, 'l.index'));
    assert.equal(back, base, 'the removals land too');
  } finally {
    await f.cleanup();
  }
});

test('final review FB-6: editTreeIndexOnly over a base holding a root drive-prefix name: a typed IndexRefusedPathError naming it on Windows (never a bare GitCommandError), the plain edit elsewhere', async () => {
  const f = await makeRepoFixture('treeedit-fb6-base');
  try {
    const head = await f.repo.resolve('HEAD');
    assert.ok(head !== null);
    const base = (await f.repo.readCommit(head)).tree;
    const blob = await f.repo.hashBytes(Buffer.from('ab\n'), true);
    const entries: MktreeEntry[] = [...await f.repo.readTreeMap(base)].filter(([p]) => !p.includes('/')).map(([p, e]) => ({ name: p, mode: e.mode, type: 'blob', oid: e.oid }));
    const sub = parseOid((await f.repo.run(['rev-parse', `${base}:src`])).stdout.toString('utf8'));
    const tree = await f.repo.mktree([...entries, { name: 'src', mode: '040000', type: 'tree', oid: sub }, { name: 'a:b.txt', mode: '100644', type: 'blob', oid: blob }]);
    const tmp = join(f.paths.coworkDir, 'tmp');
    await fsp.mkdir(tmp, { recursive: true });
    const edit = [{ path: 'README.md', mode: '100644' as const, oid: blob }];
    if (WIN) {
      await assert.rejects(editTreeIndexOnly(f.repo, realFs, tree, edit, join(tmp, 'x.index')), (e: unknown) => {
        assert.ok(e instanceof IndexRefusedPathError, `a typed refusal, not ${e instanceof GitCommandError ? 'a GitCommandError' : String(e)}`);
        assert.deepEqual(e.paths, ['a:b.txt']);
        return true;
      });
    } else {
      const out = await editTreeIndexOnly(f.repo, realFs, tree, edit, join(tmp, 'x.index'));
      assert.equal((await f.repo.readTreeMap(out)).get('a:b.txt')?.oid, blob, 'git outside Windows keeps the name');
    }
  } finally {
    await f.cleanup();
  }
});

test('final review FB-6: an index edit git drops silently (a root drive-prefix name on Windows) is a typed IndexRefusedPathError, in editIndexOnly and in editTreeIndexOnly; every other edit lands', async () => {
  const f = await makeRepoFixture('treeedit-fb6-edit');
  try {
    const head = await f.repo.resolve('HEAD');
    assert.ok(head !== null);
    const base = (await f.repo.readCommit(head)).tree;
    const blob = await f.repo.hashBytes(Buffer.from('bc\n'), true);
    const tmp = join(f.paths.coworkDir, 'tmp');
    await fsp.mkdir(tmp, { recursive: true });
    const edits = [{ path: 'b:c.txt', mode: '100644' as const, oid: blob }, { path: 'src/new.txt', mode: '100644' as const, oid: blob }];
    const index = join(tmp, 'y.index');
    await f.repo.run(['read-tree', base], { class: 'refupdate', indexFile: index });
    if (WIN) {
      await assert.rejects(editIndexOnly(f.repo, index, edits, base.length), (e: unknown) => e instanceof IndexRefusedPathError && e.paths.join() === 'b:c.txt');
      await assert.rejects(editTreeIndexOnly(f.repo, realFs, base, edits, join(tmp, 'z.index')), (e: unknown) => e instanceof IndexRefusedPathError && e.paths.join() === 'b:c.txt');
    } else {
      await editIndexOnly(f.repo, index, edits, base.length);
      const out = await editTreeIndexOnly(f.repo, realFs, base, edits, join(tmp, 'z.index'));
      assert.equal((await f.repo.readTreeMap(out)).get('b:c.txt')?.oid, blob);
    }
    // Edits git accepts land as before.
    const ok = await editTreeIndexOnly(f.repo, realFs, base, [edits[1]!, { path: 'README.md', remove: true }], join(tmp, 'w.index'));
    const m = await f.repo.readTreeMap(ok);
    assert.equal(m.get('src/new.txt')?.oid, blob);
    assert.equal(m.has('README.md'), false);
  } finally {
    await f.cleanup();
  }
});
