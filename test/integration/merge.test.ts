import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { mergeFile, mergeTree, MergeFailedError } from '../../src/git/merge.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import { GitRepo, type TreeEntry } from '../../src/git/repo.js';
import type { GitResult, GitRunner } from '../../src/git/runner.js';
import { fixtureContext, makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';

async function treeOf(f: RepoFixture, files: Record<string, string>, name = 'merge-idx'): Promise<Oid> {
  const dir = join(f.paths.coworkDir, 'tmp');
  await mkdir(dir, { recursive: true });
  const entries = new Map<string, TreeEntry>();
  for (const [path, text] of Object.entries(files)) {
    entries.set(path, { path, mode: '100644', oid: await f.repo.hashBytes(Buffer.from(text, 'latin1'), true) });
  }
  return f.repo.writeTreeMap(entries, join(dir, name));
}

async function fileOf(f: RepoFixture, tree: Oid, path: string): Promise<string> {
  const e = (await f.repo.readTreeMap(tree)).get(path);
  assert.ok(e, `${path} in ${tree}`);
  return (await f.repo.readBlob(e.oid)).toString('latin1');
}

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

test('mergeTree wraps base, ours and theirs in deterministic parentless commits', async () => {
  const f = await makeRepoFixture('merge-wrap');
  try {
    const seen: string[][] = [];
    const spy: GitRunner = {
      run(args, opts) {
        seen.push([...args]);
        return f.runner.run(args, opts);
      },
    };
    const repo = new GitRepo(spy, f.paths, fixtureContext);
    const base = await treeOf(f, { 'f.txt': lines('1', '2', '3', '4', '5'), 'keep.txt': 'k\n' });
    const ours = await treeOf(f, { 'f.txt': lines('1x', '2', '3', '4', '5'), 'keep.txt': 'k\n' });
    const theirs = await treeOf(f, { 'f.txt': lines('1', '2', '3', '4', '5y'), 'keep.txt': 'k\n', 'new.txt': 'n\n' });
    const refsBefore = (await repo.run(['for-each-ref', '--format=%(refname) %(objectname)'])).stdout.toString('utf8');
    seen.length = 0;

    const r = await mergeTree(repo, base, ours, theirs);
    assert.equal(r.rc, 0);
    assert.deepEqual(r.conflicted, []);
    const expected = await treeOf(f, { 'f.txt': lines('1x', '2', '3', '4', '5y'), 'keep.txt': 'k\n', 'new.txt': 'n\n' }, 'expected-idx');
    assert.equal(r.tree, expected);

    // Exactly three commit-tree calls and one merge-tree call; the merge-tree arguments are the wrapper commits.
    assert.deepEqual(seen.map((a) => a[0]), ['commit-tree', 'commit-tree', 'commit-tree', 'merge-tree']);
    const mt = seen[3] as string[];
    assert.deepEqual(mt.slice(0, 5), ['merge-tree', '--write-tree', '-z', '--name-only', '--no-messages']);
    const baseCommit = (mt[5] as string).replace('--merge-base=', '') as Oid;
    const oursCommit = mt[6] as Oid;
    const theirsCommit = mt[7] as Oid;
    assert.equal(mt.length, 8);
    for (const [commitOid, tree] of [[baseCommit, base], [oursCommit, ours], [theirsCommit, theirs]] as const) {
      const info = await repo.readCommit(commitOid);
      assert.deepEqual(info.parents, [], 'parentless');
      assert.equal(info.tree, tree, 'carries exactly the given tree');
      assert.equal(info.subject, 'cowork-merge');
      assert.deepEqual(info.trailers, []);
      const raw = spawnSync('git', ['cat-file', 'commit', commitOid], { cwd: f.paths.workTree, encoding: 'utf8' }).stdout;
      assert.match(raw, /\nauthor cowork <merge@cowork\.invalid> 1700000000 \+0000\ncommitter cowork <merge@cowork\.invalid> 1700000000 \+0000\n/);
    }
    // Deterministic: the same inputs give the same wrapper commits and the same merge-tree argv.
    seen.length = 0;
    const again = await mergeTree(repo, base, ours, theirs);
    assert.equal(again.tree, r.tree);
    assert.deepEqual(seen[3], mt);
    // No ref is written (the wrapper commits are scratch objects).
    assert.equal((await repo.run(['for-each-ref', '--format=%(refname) %(objectname)'])).stdout.toString('utf8'), refsBefore);

    // A same-line conflict: rc 1 and the path listed; the tree holds the markers.
    const conflictOurs = await treeOf(f, { 'f.txt': lines('1', '2o', '3', '4', '5'), 'keep.txt': 'k\n' }, 'c1-idx');
    const conflictTheirs = await treeOf(f, { 'f.txt': lines('1', '2t', '3', '4', '5'), 'keep.txt': 'k\n' }, 'c2-idx');
    const c = await mergeTree(repo, base, conflictOurs, conflictTheirs);
    assert.equal(c.rc, 1);
    assert.deepEqual(c.conflicted, ['f.txt']);
    assert.match(await fileOf(f, c.tree, 'f.txt'), /<<<<<<< [^\n]*\n2o\n=======\n2t\n>>>>>>> [^\n]*\n/);
  } finally {
    await f.cleanup();
  }
});

test('mergeTree: same-line edits give rc 1 with the path listed; adjacent-line edits conflict; edits separated by one unchanged line merge cleanly', async () => {
  const f = await makeRepoFixture('merge-lines');
  try {
    const base = await treeOf(f, { 'a.txt': lines('1', '2', '3'), 'b.txt': lines('1', '2', '3'), 'c.txt': lines('1', '2', '3'), 'z.txt': 'z\n' });
    const ours = await treeOf(f, {
      'a.txt': lines('A', '2', '3'),     // same line as theirs
      'b.txt': lines('B', '2', '3'),     // adjacent to theirs (lines 1 and 2)
      'c.txt': lines('C', '2', '3'),     // separated from theirs by one unchanged line (lines 1 and 3)
      'z.txt': 'z\n',
    }, 'o-idx');
    const theirs = await treeOf(f, {
      'a.txt': lines('a', '2', '3'),
      'b.txt': lines('1', 'b', '3'),
      'c.txt': lines('1', '2', 'c'),
      'z.txt': 'z2\n',
    }, 't-idx');
    const r = await mergeTree(f.repo, base, ours, theirs);
    assert.equal(r.rc, 1);
    assert.deepEqual(r.conflicted, ['a.txt', 'b.txt'], 'sorted, unique; c.txt and z.txt merged');
    assert.equal(await fileOf(f, r.tree, 'c.txt'), lines('C', '2', 'c'));
    assert.equal(await fileOf(f, r.tree, 'z.txt'), 'z2\n');
    // Path names are kept as bytes: space and Hangul.
    const base2 = await treeOf(f, { '한 글/파일 1.txt': lines('1', '2', '3') }, 'b2-idx');
    const o2 = await treeOf(f, { '한 글/파일 1.txt': lines('x', '2', '3') }, 'o2-idx');
    const t2 = await treeOf(f, { '한 글/파일 1.txt': lines('y', '2', '3') }, 't2-idx');
    const r2 = await mergeTree(f.repo, base2, o2, t2);
    assert.equal(r2.rc, 1);
    assert.deepEqual(r2.conflicted, ['한 글/파일 1.txt']);
  } finally {
    await f.cleanup();
  }
});

test('mergeTree rc > 1 throws MergeFailedError', async () => {
  const f = await makeRepoFixture('merge-fail');
  try {
    const failing: GitRunner = {
      async run(args, opts): Promise<GitResult> {
        if (args[0] === 'merge-tree') return { code: 128, stdout: Buffer.alloc(0), stderr: Buffer.from('fatal: refusing to merge'), killedByWatchdog: false, aborted: false, durationMs: 0 };
        return f.runner.run(args, opts);
      },
    };
    const repo = new GitRepo(failing, f.paths, fixtureContext);
    const t = await treeOf(f, { 'a.txt': 'a\n' });
    await assert.rejects(
      () => mergeTree(repo, t, t, t),
      (e: unknown) => e instanceof MergeFailedError && e.code === 128 && /128/.test(e.message),
    );
    // A tree oid that does not exist cannot be wrapped: the commit-tree failure surfaces, no merge-tree runs.
    await assert.rejects(() => mergeTree(f.repo, t, t, 'f'.repeat(40) as Oid));
  } finally {
    await f.cleanup();
  }
});

test('MERGE_FLAGS hold against a user merge.renormalize=true: an i/crlf blob is not flipped', async () => {
  const f = await makeRepoFixture('merge-renorm', { autocrlf: true });
  try {
    const { repo } = f;
    // The user's configuration asks git to renormalize every merge.
    await repo.run(['config', 'merge.renormalize', 'true']);
    await repo.run(['config', 'core.autocrlf', 'true']);
    const crlf = (...rows: string[]): string => `${rows.join('\r\n')}\r\n`;
    const base = await treeOf(f, { 'w.txt': crlf('a', 'b', 'c', 'd', 'e') });
    const ours = await treeOf(f, { 'w.txt': crlf('A', 'b', 'c', 'd', 'e') }, 'o-idx');
    const theirs = await treeOf(f, { 'w.txt': crlf('a', 'b', 'c', 'd', 'E') }, 't-idx');

    // The control: a plain git with the user's setting does flip the stored endings (so the test is not vacuous).
    const wrapCommit = async (tree: Oid): Promise<string> => (await repo.commitTree({ tree, parents: [], subject: 'w', trailers: [] }));
    const [bc, oc, tc] = [await wrapCommit(base), await wrapCommit(ours), await wrapCommit(theirs)];
    const plain = spawnSync('git', ['merge-tree', '--write-tree', '-z', '--name-only', '--no-messages', `--merge-base=${bc}`, oc, tc], {
      cwd: f.paths.workTree, encoding: 'latin1', env: { ...process.env, LC_ALL: 'C' },
    });
    assert.equal(plain.status, 0, plain.stderr);
    const plainTree = plain.stdout.split('\0')[0] as Oid;
    assert.ok(!(await fileOf(f, plainTree, 'w.txt')).includes('\r'), 'control: a plain renormalizing merge flips CRLF to LF');

    // mergeTree: stored bytes untouched, every line still CRLF.
    const r = await mergeTree(repo, base, ours, theirs);
    assert.equal(r.rc, 0);
    assert.equal(await fileOf(f, r.tree, 'w.txt'), crlf('A', 'b', 'c', 'd', 'E'));
  } finally {
    await f.cleanup();
  }
});

test('mergeFile --object-id with diff3, labels and marker size; an ABSENT side merges as the empty blob', async () => {
  const f = await makeRepoFixture('merge-file');
  try {
    const { repo } = f;
    const blob = (s: string): Promise<Oid> => repo.hashBytes(Buffer.from(s, 'latin1'), true);
    const base = await blob(lines('x', 'BASE', 'y'));
    const cur = await blob(lines('x', 'OURS', 'y'));
    const oth = await blob(lines('x', 'THEIRS', 'y'));

    const conflict = await mergeFile(repo, cur, base, oth, { diff3: true, markerSize: 9, labels: ['ours', 'base', 'theirs'] });
    assert.equal(conflict.rc, 1);
    assert.equal(conflict.out.toString('latin1'), lines('x', '<<<<<<<<< ours', 'OURS', '||||||||| base', 'BASE', '=========', 'THEIRS', '>>>>>>>>> theirs', 'y'));

    const plain = await mergeFile(repo, cur, base, oth);
    assert.equal(plain.rc, 1);
    assert.match(plain.out.toString('latin1'), /^x\n<<<<<<< [^\n]*\nOURS\n=======\nTHEIRS\n>>>>>>> [^\n]*\ny\n$/);
    assert.ok(!plain.out.toString('latin1').includes('|||||||'), 'no base section without diff3');

    const clean = await mergeFile(repo, await blob(lines('X', 'b', 'c', 'd')), await blob(lines('x', 'b', 'c', 'd')), await blob(lines('x', 'b', 'c', 'D')));
    assert.equal(clean.rc, 0);
    assert.equal(clean.out.toString('latin1'), lines('X', 'b', 'c', 'D'));

    // ABSENT sides are the empty blob: an add/add of different content conflicts, an add with an absent base merges.
    const newer = await blob(lines('new'));
    const addOnly = await mergeFile(repo, newer, ABSENT, ABSENT);
    assert.equal(addOnly.rc, 0);
    assert.equal(addOnly.out.toString('latin1'), lines('new'));
    const addAdd = await mergeFile(repo, newer, ABSENT, await blob(lines('other')), { labels: ['L', 'B', 'R'] });
    assert.equal(addAdd.rc, 1);
    assert.equal(addAdd.out.toString('latin1'), lines('<<<<<<< L', 'new', '=======', 'other', '>>>>>>> R'));
    const deleted = await mergeFile(repo, ABSENT, base, base);
    assert.equal(deleted.rc, 0);
    assert.equal(deleted.out.length, 0);
    // The empty blob was written once and reused.
    assert.equal(await repo.hasObject('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391' as Oid, 'blob'), true);
    // Binary content: merge-file refuses it (negative rc), the bytes are not returned as a merge.
    const bin = await mergeFile(repo, await blob('a\0b\n'), await blob('a\0c\n'), await blob('a\0d\n'));
    assert.ok(bin.rc < 0, `binary merge is an error, got rc ${bin.rc}`);
    await assert.rejects(() => mergeFile(repo, cur, base, oth, { markerSize: 0 }), /marker size/);
  } finally {
    await f.cleanup();
  }
});
