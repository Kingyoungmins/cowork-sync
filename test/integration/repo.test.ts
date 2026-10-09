import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GitCommandError, GitRepo, type RepoContext, type TreeEntry } from '../../src/git/repo.js';
import { mergeTree } from '../../src/git/merge.js';
import { ABSENT, OidError, type Oid } from '../../src/git/oid.js';
import type { GitResult, GitRunner } from '../../src/git/runner.js';
import { FIXTURE_WALL_MS, fixtureContext, makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';

/** Wraps a runner and records every git argument list (after the class/cwd options). */
function counting(inner: GitRunner): { runner: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runner: {
      run(args, opts) {
        calls.push([...args]);
        return inner.run(args, opts);
      },
    },
  };
}

async function scratch(f: RepoFixture, name: string): Promise<string> {
  const dir = join(f.paths.coworkDir, 'tmp');
  await mkdir(dir, { recursive: true });
  return join(dir, name);
}

function rawGit(f: RepoFixture, args: string[], input?: string): string {
  // A plain git, without --no-replace-objects: what a user's own tools would see.
  const r = spawnSync('git', args, { cwd: f.paths.workTree, input, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

async function commit(repo: GitRepo, tree: Oid, parents: Oid[], subject: string, trailers: Array<{ key: string; value: string }> = []): Promise<Oid> {
  return repo.commitTree({ tree, parents, subject, trailers });
}

test('a refs/replace/* object changes nothing GitRepo reads', async () => {
  const f = await makeRepoFixture('repo-replace');
  try {
    const { repo } = f;
    const orig = await repo.hashBytes(Buffer.from('orig\n'), true);
    const other = await repo.hashBytes(Buffer.from('replaced\n'), true);
    const idx = await scratch(f, 'replace-idx');
    const tree = await repo.writeTreeMap(new Map<string, TreeEntry>([['f.txt', { path: 'f.txt', mode: '100644', oid: orig }]]), idx);
    const otherTree = await repo.writeTreeMap(new Map<string, TreeEntry>([['g.txt', { path: 'g.txt', mode: '100644', oid: other }]]), idx);
    const c1 = await commit(repo, tree, [], 'one');
    const c2 = await commit(repo, tree, [c1], 'two');
    const c3 = await commit(repo, tree, [c2], 'three');
    const decoy = await commit(repo, otherTree, [], 'decoy');
    // Plant the replace refs (update-ref itself is unaffected by --no-replace-objects).
    for (const [from, to] of [[orig, other], [tree, otherTree], [c2, decoy]] as const) {
      await repo.run(['update-ref', `refs/replace/${from}`, to]);
    }
    // The plant is effective for a plain git ...
    assert.equal(rawGit(f, ['cat-file', 'blob', orig]), 'replaced\n');
    assert.match(rawGit(f, ['ls-tree', '-r', '--name-only', tree]), /^g\.txt/);
    // (rev-list prints the original oid but follows the replacement's parents: the decoy is parentless, so c1 is gone.)
    assert.deepEqual(rawGit(f, ['rev-list', '--first-parent', c3]).trim().split('\n'), [c3, c2]);
    // ... and invisible to every GitRepo read.
    assert.equal((await repo.readBlob(orig)).toString('utf8'), 'orig\n');
    assert.equal((await repo.readBlobs([orig]))[0]?.toString('utf8'), 'orig\n');
    assert.deepEqual([...(await repo.readTreeMap(tree)).keys()], ['f.txt']);
    const idx2 = await scratch(f, 'replace-idx2');
    await repo.readTreeIntoIndex(idx2, tree);
    assert.deepEqual([...(await repo.listIndex(idx2)).keys()], ['f.txt']);
    assert.equal(await repo.writeTree(idx2), tree);
    assert.deepEqual(await repo.firstParents(c3, null, 10), [c3, c2, c1]);
    assert.equal(await repo.firstParentCount(c3), 3);
    // mergeTree: a real three-way merge of f.txt. The base blob is replaced by a decoy; a replace-aware
    // merge would see different base content and conflict (rc 1), the unreplaced merge is clean.
    const five = (...rows: string[]): Buffer => Buffer.from(`${rows.join('\n')}\n`);
    const mk = async (b: Buffer): Promise<Oid> => repo.hashBytes(b, true);
    const tOf = async (b: Oid): Promise<Oid> => repo.writeTreeMap(new Map([['f.txt', { path: 'f.txt', mode: '100644' as const, oid: b }]]), idx);
    const baseBlob = await mk(five('1', '2', '3', '4', '5'));
    const base = await tOf(baseBlob);
    const ours = await tOf(await mk(five('1x', '2', '3', '4', '5')));
    const theirs = await tOf(await mk(five('1', '2', '3', '4', '5y')));
    const expectedBlob = await mk(five('1x', '2', '3', '4', '5y'));
    const decoyBlob = await mk(five('A', 'B', 'C', 'D', 'E'));
    await repo.run(['update-ref', `refs/replace/${baseBlob}`, decoyBlob]);
    assert.equal(rawGit(f, ['cat-file', 'blob', baseBlob]), 'A\nB\nC\nD\nE\n', 'control: the plant is active for a plain git');
    const merged = await mergeTree(repo, base, ours, theirs);
    assert.equal(merged.rc, 0);
    assert.deepEqual(merged.conflicted, []);
    assert.equal((await repo.readTreeMap(merged.tree)).get('f.txt')?.oid, expectedBlob);
  } finally {
    await f.cleanup();
  }
});

test('a .git/info/grafts file changes nothing GitRepo reads (ruling P2-GRAFTS)', async () => {
  const f = await makeRepoFixture('repo-grafts');
  try {
    const { repo } = f;
    const tree = await repo.emptyTree();
    const c1 = await commit(repo, tree, [], 'one', [{ key: 'Cowork-Base', value: 'b'.repeat(40) }]);
    const c2 = await commit(repo, tree, [c1], 'two');
    const c3 = await commit(repo, tree, [c2], 'three');
    const c4 = await commit(repo, tree, [c3], 'four');
    const side = await commit(repo, tree, [], 'side');
    // Grafts: c3 loses its parents (the chain is cut below it) and c4 gains a second parent.
    await mkdir(join(f.paths.gitDir, 'info'), { recursive: true });
    await writeFile(join(f.paths.gitDir, 'info', 'grafts'), Buffer.from(`${c3}\n${c4} ${c3} ${side}\n`, 'utf8'));
    // The graft is effective for a plain git, even under --no-replace-objects ...
    assert.deepEqual(rawGit(f, ['rev-list', '--first-parent', c4]).trim().split('\n'), [c4, c3]);
    assert.equal(rawGit(f, ['--no-replace-objects', 'rev-list', '--first-parent', '--count', c4]).trim(), '2');
    assert.equal(rawGit(f, ['rev-list', '--max-count=1', `${c4}..${side}`]).trim(), '', 'control: side reads as an ancestor of c4');
    // ... and invisible to every GitRepo read.
    assert.deepEqual(await repo.firstParents(c4, null, 10), [c4, c3, c2, c1]);
    assert.equal(await repo.firstParentCount(c4), 4);
    assert.equal(await repo.isAncestor(c1, c4), true);
    assert.equal(await repo.isAncestor(side, c4), false);
    assert.equal(await repo.newestWithTrailer(c4, 'Cowork-Base'), c1);
    assert.deepEqual((await repo.readCommit(c4)).parents, [c3]);
  } finally {
    await f.cleanup();
  }
});

test('writeTreeMap and editTree give the same tree oid as git add of the same bytes', async () => {
  const f = await makeRepoFixture('repo-trees');
  try {
    const { repo } = f;
    const files: Record<string, Buffer> = {
      'a.txt': Buffer.from('a\n'),
      'dir/b.txt': Buffer.from('b\r\nwith crlf\r\n'),
      'dir/sub/c bin.dat': Buffer.from([0, 1, 2, 255, 10]),
      '한글/파일.txt': Buffer.from('한글\n', 'utf8'),
      'empty': Buffer.alloc(0),
    };
    // Reference: a separate index filled by git add of work-tree copies (core.autocrlf off, no attributes).
    const ref = join(f.root, 'ref-work');
    rawGit(f, ['init', '-q', ref]);
    for (const [rel, bytes] of Object.entries(files)) {
      const abs = join(ref, ...rel.split('/'));
      await mkdir(join(abs, '..'), { recursive: true });
      await writeFile(abs, bytes);
    }
    const r = (args: string[]): string => {
      const out = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.quotepath=off', ...args], { cwd: ref, encoding: 'utf8' });
      assert.equal(out.status, 0, out.stderr);
      return out.stdout.trim();
    };
    r(['add', '-A']);
    const expected = r(['write-tree']);

    const entries = new Map<string, TreeEntry>();
    for (const [rel, bytes] of Object.entries(files)) {
      entries.set(rel, { path: rel, mode: '100644', oid: await repo.hashBytes(bytes, true) });
    }
    const idx = await scratch(f, 'wtm-idx');
    const tree = await repo.writeTreeMap(entries, idx);
    assert.equal(tree, expected);
    // The scratch index is fresh each time: a second, smaller map does not inherit the first.
    const small = await repo.writeTreeMap(new Map([['a.txt', entries.get('a.txt') as TreeEntry]]), idx);
    assert.deepEqual([...(await repo.readTreeMap(small)).keys()], ['a.txt']);
    // editTree: start from `small`, add everything else, change one, remove one; must equal the full map again.
    const edits = [...entries.values()].filter((e) => e.path !== 'a.txt').map((e) => ({ path: e.path, mode: e.mode, oid: e.oid }));
    const viaEdit = await repo.editTree(small, edits, idx);
    assert.equal(viaEdit, expected);
    const removed = await repo.editTree(viaEdit, [{ path: 'dir/b.txt', remove: true }, { path: 'a.txt', remove: true }], idx);
    const withoutTwo = new Map(entries);
    withoutTwo.delete('dir/b.txt');
    withoutTwo.delete('a.txt');
    assert.equal(removed, await repo.writeTreeMap(withoutTwo, idx));
    // File replaced by a directory of the same name (whole-path replacement).
    const fileToDir = await repo.editTree(small, [
      { path: 'a.txt', remove: true },
      { path: 'a.txt/inner.txt', mode: '100644', oid: entries.get('a.txt')!.oid },
    ], idx);
    assert.deepEqual([...(await repo.readTreeMap(fileToDir)).keys()], ['a.txt/inner.txt']);
    assert.equal(await repo.editTree(small, [], idx), small);
  } finally {
    await f.cleanup();
  }
});

test('casRef moves the ref with a reflog entry; a moved ref returns false; a wrong prev never moves it', async () => {
  const f = await makeRepoFixture('repo-cas');
  try {
    const { repo } = f;
    const empty = await repo.emptyTree();
    const c1 = await commit(repo, empty, [], 'c1');
    const c2 = await commit(repo, empty, [c1], 'c2');
    const c3 = await commit(repo, empty, [c2], 'c3');
    const ref = 'refs/cowork-local/main/state';
    assert.equal(await repo.readRef(ref), null);
    // Create: prev null.
    assert.equal(await repo.casRef(ref, c1, null, 'create state'), true);
    assert.equal(await repo.readRef(ref), c1);
    // The reflog entry exists although the ref lives outside refs/heads (--create-reflog).
    assert.deepEqual(rawGit(f, ['log', '-g', '--format=%gs', ref]).trim().split('\n'), ['create state']);
    // Move with the right prev.
    assert.equal(await repo.casRef(ref, c2, c1, 'advance'), true);
    assert.equal(await repo.readRef(ref), c2);
    assert.deepEqual(rawGit(f, ['log', '-g', '--format=%gs', ref]).trim().split('\n'), ['advance', 'create state']);
    // A moved ref (prev is stale): false, ref untouched.
    assert.equal(await repo.casRef(ref, c3, c1, 'stale'), false);
    assert.equal(await repo.readRef(ref), c2);
    // A wrong prev never moves it, whatever it is; creating over an existing ref is also a failed CAS.
    assert.equal(await repo.casRef(ref, c3, c3, 'wrong prev'), false);
    assert.equal(await repo.casRef(ref, c3, null, 'create over existing'), false);
    assert.equal(await repo.readRef(ref), c2);
    // Moving an absent ref with a non-null prev fails too.
    assert.equal(await repo.casRef('refs/cowork-local/main/other', c3, c2, 'absent'), false);
    assert.equal(await repo.readRef('refs/cowork-local/main/other'), null);
    assert.equal(rawGit(f, ['log', '-g', '--format=%gs', ref]).trim().split('\n').length, 2, 'no reflog entry for a failed CAS');
    // Inputs are validated before any git call.
    await assert.rejects(() => repo.casRef('heads/x', c3, null, 'r'), /ref/);
    await assert.rejects(() => repo.casRef(ref, c3, c2, 'multi\nline'), /reason/);
    await assert.rejects(() => repo.casRef(ref, 'nope' as Oid, c2, 'r'), OidError);
    // An object that does not exist is refused (cat-file -e before update-ref, ENG-09).
    await assert.rejects(() => repo.casRef(ref, 'f'.repeat(40) as Oid, c2, 'ghost'), /commit/);
    await assert.rejects(() => repo.casRef(ref, empty, c2, 'a tree is not a commit'), /commit/);
    assert.equal(await repo.readRef(ref), c2);
    // deleteLocalRef: cowork namespaces only, CAS on the old value.
    assert.equal(await repo.deleteLocalRef(ref, c1), false);
    assert.equal(await repo.readRef(ref), c2);
    assert.equal(await repo.deleteLocalRef(ref, c2), true);
    assert.equal(await repo.readRef(ref), null);
    await repo.run(['update-ref', 'refs/heads/side', c1]);
    await assert.rejects(() => repo.deleteLocalRef('refs/heads/side', c1), /cowork/);
    assert.equal(await repo.readRef('refs/heads/side'), c1);
  } finally {
    await f.cleanup();
  }
});

test('commitTree uses the context identity at +0000 and the virtual date in test builds, and is unsigned under a user commit.gpgSign=true', async () => {
  const f = await makeRepoFixture('repo-commit');
  try {
    const { repo } = f;
    // A user config that would sign every commit with a program that does not exist.
    await repo.run(['config', 'commit.gpgSign', 'true']);
    await repo.run(['config', 'gpg.program', join(f.root, 'no-such-gpg')]);
    await repo.run(['config', 'user.name', 'Somebody Else']);
    await repo.run(['config', 'user.email', 'else@example.com']);
    const empty = await repo.emptyTree();
    const trailers = [{ key: 'skip-checks', value: 'true' }, { key: 'Cowork-Writer', value: 'p1/e1/3' }];
    const c = await repo.commitTree({ tree: empty, parents: [], subject: '[skip ci] ***NO_CI*** x', trailers });
    const raw = rawGit(f, ['cat-file', 'commit', c]);
    const header = raw.split('\n\n')[0] ?? '';
    assert.deepEqual(header.split('\n'), [
      `tree ${empty}`,
      `author Fixture Peer <peer1@cowork.invalid> ${FIXTURE_WALL_MS / 1000} +0000`,
      `committer Fixture Peer <peer1@cowork.invalid> ${FIXTURE_WALL_MS / 1000} +0000`,
    ]);
    assert.ok(!raw.includes('gpgsig'));
    const info = await repo.readCommit(c);
    assert.deepEqual(info, { oid: c, tree: empty, parents: [], subject: '[skip ci] ***NO_CI*** x', trailers });
    // Parents are kept in order; identical inputs give the identical commit (deterministic in SIM).
    const c2 = await repo.commitTree({ tree: empty, parents: [c], subject: 's', trailers: [] });
    const c3 = await repo.commitTree({ tree: empty, parents: [c, c2], subject: 's2', trailers: [] });
    assert.deepEqual((await repo.readCommit(c3)).parents, [c, c2]);
    assert.equal(await repo.commitTree({ tree: empty, parents: [c], subject: 's', trailers: [] }), c2);
    // A different virtual date changes the commit; the offset stays +0000.
    let now = FIXTURE_WALL_MS + 86_400_000;
    const ctx: RepoContext = { ...fixtureContext(), wallMs: () => now };
    const later = new GitRepo(f.runner, f.paths, () => ctx);
    const c4 = await later.commitTree({ tree: empty, parents: [], subject: '[skip ci] ***NO_CI*** x', trailers });
    assert.notEqual(c4, c);
    assert.match(rawGit(f, ['cat-file', 'commit', c4]), new RegExp(`> ${now / 1000} \\+0000\\n`));
    now += 1000;
    // Bad input: a missing tree fails (no silent success), and the subject cannot carry a newline.
    await assert.rejects(() => repo.commitTree({ tree: 'e'.repeat(40) as Oid, parents: [], subject: 's', trailers: [] }));
    await assert.rejects(() => repo.commitTree({ tree: empty, parents: [], subject: 'a\nb', trailers: [] }), /subject/);
  } finally {
    await f.cleanup();
  }
});

test('firstParents and firstParentCount follow first parents only; isAncestor is plain reachability (a second-parent ancestor counts); none runs merge-base', async () => {
  const f = await makeRepoFixture('repo-firstparent');
  try {
    const count = counting(f.runner);
    const repo = new GitRepo(count.runner, f.paths, fixtureContext);
    const empty = await repo.emptyTree();
    const c1 = await commit(repo, empty, [], 'c1');
    const c2 = await commit(repo, empty, [c1], 'c2');
    const side = await commit(repo, empty, [c1], 'side');
    const m = await commit(repo, empty, [c2, side], 'merge');
    const c3 = await commit(repo, empty, [m], 'c3');
    count.calls.length = 0;

    assert.deepEqual(await repo.firstParents(c3, null, 100), [c3, m, c2, c1]);
    assert.deepEqual(await repo.firstParents(c3, c1, 100), [c3, m, c2]);
    assert.deepEqual(await repo.firstParents(c3, c3, 100), []);
    assert.deepEqual(await repo.firstParents(c3, null, 2), [c3, m]);
    assert.deepEqual(await repo.firstParents(c3, null, 0), []);
    assert.equal(await repo.firstParentCount(c3), 4);
    assert.equal(await repo.firstParentCount(side), 2);
    assert.equal(await repo.firstParentCount(c1), 1);

    assert.equal(await repo.isAncestor(c1, c3), true);
    assert.equal(await repo.isAncestor(c2, c3), true);
    assert.equal(await repo.isAncestor(m, c3), true);
    assert.equal(await repo.isAncestor(c3, c3), true);
    assert.equal(await repo.isAncestor(c3, c1), false);
    assert.equal(await repo.isAncestor(c2, side), false);
    // The second-parent side branch is reachable from c3 although not on its first-parent chain.
    assert.equal(await repo.isAncestor(side, c3), true);
    assert.equal(await repo.isAncestor(side, m), true);
    assert.ok(!(await repo.firstParents(c3, null, 100)).includes(side));
    assert.equal(await repo.isAncestor(c3, side), false);

    assert.ok(count.calls.every((a) => !a.includes('merge-base') && a[0] !== 'merge-base'), 'merge-base is never run');
    assert.ok(count.calls.every((a) => a[0] === 'rev-list'), `only rev-list: ${count.calls.map((a) => a[0]).join(',')}`);
  } finally {
    await f.cleanup();
  }
});

/** A commit object written as given (`hash-object -t commit -w --literally`): headers git accepts but commit-tree never writes. */
async function literalCommit(repo: GitRepo, text: string): Promise<Oid> {
  const r = await repo.run(['hash-object', '-t', 'commit', '-w', '--literally', '--stdin'], { stdin: Buffer.from(text, 'utf8') });
  return r.stdout.toString('utf8').trim() as Oid;
}

/** git's own reading of a commit's tree and parents (parse_commit_buffer, through `log --format=%T %P`). */
async function gitHeader(repo: GitRepo, c: Oid): Promise<{ tree: string; parents: string[] }> {
  const line = (await repo.run(['log', '-1', '--format=%T %P', c])).stdout.toString('utf8').trim();
  const [tree = '', ...parents] = line.split(' ').filter((w) => w.length > 0);
  return { tree, parents };
}

// Final review FA-1: every remote commit is read through parseCommitObject (readCommit, readCommitsChecked,
// readBoardCommit). git reads a commit's header as parse_commit_buffer does: the first line is the tree, the parents are
// the consecutive `parent` lines right after it, later tree/parent headers are ignored, and hex is case-insensitive.
// All of these commits pass git fsck --strict and receive.fsckObjects (measured on git 2.55 by the final review).
test('readCommit reads a commit header as git does: upper-case hex, and tree/parent headers after the committer line', async () => {
  const f = await makeRepoFixture('repo-header-parity');
  try {
    const { repo } = f;
    const empty = await repo.emptyTree();
    const idx = await scratch(f, 'parity-idx');
    const tree = await repo.writeTreeMap(new Map<string, TreeEntry>([['a.txt', { path: 'a.txt', mode: '100644', oid: await repo.hashBytes(Buffer.from('a\n'), true) }]]), idx);
    const p1 = await commit(repo, empty, [], 'p1');
    const p2 = await commit(repo, empty, [p1], 'p2');
    const ident = 'author A <a@cowork.invalid> 1700000000 +0000\ncommitter A <a@cowork.invalid> 1700000000 +0000\n';
    const missing = '0123456789abcdef'.repeat(4).slice(0, tree.length);
    const cases: Array<[string, string, { tree: Oid; parents: Oid[] }]> = [
      ['upper-case hex in the tree and parent lines', `tree ${tree.toUpperCase()}\nparent ${p2.toUpperCase()}\nparent ${p1.toUpperCase()}\n${ident}\nupper\n`, { tree, parents: [p2, p1] }],
      ['a parent header after the committer line (an existing commit)', `tree ${tree}\nparent ${p2}\n${ident}parent ${p1}\n\nlate parent\n`, { tree, parents: [p2] }],
      ['a parent header after the committer line (a missing object)', `tree ${tree}\nparent ${p2}\n${ident}parent ${missing}\n\nlate missing parent\n`, { tree, parents: [p2] }],
      ['a tree header after the committer line (a missing object)', `tree ${tree}\nparent ${p2}\n${ident}tree ${missing}\n\nlate tree\n`, { tree, parents: [p2] }],
      ['a tree header after the committer line (an existing tree)', `tree ${tree}\nparent ${p2}\n${ident}tree ${empty}\n\nlate old tree\n`, { tree, parents: [p2] }],
      ['both after the committer line', `tree ${tree}\nparent ${p2}\n${ident}parent ${p1}\ntree ${missing}\n\nboth\n`, { tree, parents: [p2] }],
      ['no parent line, then a late parent', `tree ${tree}\n${ident}parent ${p1}\n\nroot\n`, { tree, parents: [] }],
    ];
    for (const [what, text, want] of cases) {
      const c = await literalCommit(repo, text);
      assert.deepEqual(await gitHeader(repo, c), { tree: want.tree, parents: [...want.parents] }, `${what}: git's own reading`);
      const info = await repo.readCommit(c);
      assert.equal(info.tree, want.tree, `${what}: the tree is the first line's, lower-case`);
      assert.deepEqual(info.parents, want.parents, `${what}: the parents are the consecutive parent lines after the tree`);
    }
  } finally {
    await f.cleanup();
  }
});

test('newestWithTrailer finds the newest commit carrying the trailer in one git call', async () => {
  const f = await makeRepoFixture('repo-trailer');
  try {
    const count = counting(f.runner);
    const repo = new GitRepo(count.runner, f.paths, fixtureContext);
    const empty = await repo.emptyTree();
    let tip = await commit(repo, empty, [], 'root');
    const withBase: Oid[] = [];
    for (let i = 0; i < 12; i++) {
      const trailers = i === 3 || i === 7 ? [{ key: 'Cowork-Base', value: `X${i}` }] : [{ key: 'Cowork-Proto', value: '1' }];
      tip = await commit(repo, empty, [tip], `c${i}`, trailers);
      if (i === 3 || i === 7) withBase.push(tip);
    }
    // A later commit whose body merely mentions the key mid-line does not match.
    tip = await commit(repo, empty, [tip], 'mentions Cowork-Base: here');
    count.calls.length = 0;
    assert.equal(await repo.newestWithTrailer(tip, 'Cowork-Base'), withBase[1]);
    assert.equal(count.calls.length, 1, 'one git call');
    assert.equal(count.calls[0]?.[0], 'rev-list');
    assert.equal(await repo.newestWithTrailer(withBase[0] as Oid, 'Cowork-Base'), withBase[0]);
    assert.equal(await repo.newestWithTrailer(tip, 'Cowork-Missing'), null);
    await assert.rejects(() => repo.newestWithTrailer(tip, 'a.*b'), /trailer key/);
  } finally {
    await f.cleanup();
  }
});

test('smudgeBlobs runs a repo-relative filter driver with cwd = the repo root in one call', async () => {
  const f = await makeRepoFixture('repo-smudge');
  try {
    const root = f.paths.workTree;
    // The team's form: a repo-relative script path, run by git in its cwd (glossary §25 F12, ruling R-36).
    await writeFile(join(root, 'smudge-rel.js'), Buffer.from([
      "const chunks = [];",
      "process.stdin.on('data', (c) => chunks.push(c));",
      "process.stdin.on('end', () => process.stdout.write(Buffer.from(Buffer.concat(chunks).toString('latin1').split('hello').join('HELLO'), 'latin1')));",
      '',
    ].join('\n')));
    const base = new GitRepo(f.runner, f.paths, fixtureContext);
    await base.run(['config', 'filter.rel.smudge', 'node smudge-rel.js']);
    await base.run(['config', 'filter.rel.clean', 'cat']);
    // The attribute lives in the tree named by attr.tree (EPOCH_BASE), not in the work tree.
    const attrBlob = await base.hashBytes(Buffer.from('*.txt filter=rel\n'), true);
    const head = (await base.resolve('HEAD')) as Oid;
    const headTree = (await base.readCommit(head)).tree;
    const idx = await scratch(f, 'smudge-idx');
    const epochTree = await base.editTree(headTree, [{ path: '.gitattributes', mode: '100644', oid: attrBlob }], idx);
    const epoch = await commit(base, epochTree, [head], 'epoch');
    const count = counting(f.runner);
    const repo = new GitRepo(count.runner, f.paths, () => ({ ...fixtureContext(), attrTree: epoch, filterDrivers: ['rel'] }));
    const hello = await repo.hashBytes(Buffer.from('hello world\nhello\n'), true);
    const binary = await repo.hashBytes(Buffer.from([104, 101, 108, 108, 111, 0, 255, 10]), true);
    count.calls.length = 0;
    const out = await repo.smudgeBlobs([
      { oid: hello, path: 'x/a.txt' },
      { oid: hello, path: 'README.md' },
      { oid: binary, path: 'b.txt' },
      { oid: hello, path: 'x/a.txt' },
    ]);
    assert.equal(count.calls.length, 1, 'one git call for the whole group');
    assert.deepEqual(count.calls[0]?.slice(0, 3), ['cat-file', '--batch', '--filters']);
    assert.equal(out[0]?.toString('latin1'), 'HELLO world\nHELLO\n');
    assert.equal(out[1]?.toString('latin1'), 'hello world\nhello\n', 'no attribute for README.md: bytes unchanged');
    assert.deepEqual([...(out[2] ?? Buffer.alloc(0))], [72, 69, 76, 76, 79, 0, 255, 10]);
    assert.equal(out[3]?.toString('latin1'), 'HELLO world\nHELLO\n');
    assert.deepEqual(await repo.smudgeBlobs([]), []);
    assert.equal(count.calls.length, 1, 'no call for an empty group');
  } finally {
    await f.cleanup();
  }
});

test('smudgeBlobs stays exact when the smudge changes sizes (a growing filter, core.autocrlf=true) and smudges item by item when content mimics a batch header', async () => {
  // cat-file --batch --filters prints the UNFILTERED size in each header but the filtered content (MEASURED, git
  // 2.55.0.windows.3), so records are split at the next requested object's header, never by the header's size.
  const f = await makeRepoFixture('repo-smudge-size');
  try {
    const root = f.paths.workTree;
    await writeFile(join(root, 'grow.js'), Buffer.from([
      "const chunks = [];",
      "process.stdin.on('data', (c) => chunks.push(c));",
      "process.stdin.on('end', () => process.stdout.write(Buffer.from(Buffer.concat(chunks).toString('latin1').split('x').join('XXX'), 'latin1')));",
      '',
    ].join('\n')));
    const base = new GitRepo(f.runner, f.paths, fixtureContext);
    await base.run(['config', 'filter.grow.smudge', 'node grow.js']);
    await base.run(['config', 'filter.grow.clean', 'cat']);
    await base.run(['config', 'core.autocrlf', 'true']);
    const attrBlob = await base.hashBytes(Buffer.from('*.g filter=grow\n*.bin -text\n'), true);
    const head = (await base.resolve('HEAD')) as Oid;
    const headTree = (await base.readCommit(head)).tree;
    const idx = await scratch(f, 'smudge-size-idx');
    const epochTree = await base.editTree(headTree, [{ path: '.gitattributes', mode: '100644', oid: attrBlob }], idx);
    const epoch = await commit(base, epochTree, [head], 'epoch');
    const count = counting(f.runner);
    const repo = new GitRepo(count.runner, f.paths, () => ({ ...fixtureContext(), attrTree: epoch, filterDrivers: ['grow'] }));
    const xs = await repo.hashBytes(Buffer.from('x\nax\n'), true);
    const text = await repo.hashBytes(Buffer.from('one\ntwo\nthree\n'), true);
    const plain = await repo.hashBytes(Buffer.from('y'), true);
    count.calls.length = 0;
    const out = await repo.smudgeBlobs([
      { oid: xs, path: 'a.g' },
      { oid: text, path: 'b.txt' },
      { oid: xs, path: 'd/e.g' },
      { oid: plain, path: 'p.txt' },
    ]);
    assert.equal(count.calls.length, 1, 'one git call for the whole group');
    assert.deepEqual(out.map((b) => b.toString('latin1')), ['XXX\r\naXXX\r\n', 'one\r\ntwo\r\nthree\r\n', 'XXX\r\naXXX\r\n', 'y'],
      'eol conversion, then the growing smudge filter, each item exact');
    // A blob whose (unconverted, -text) content holds a line shaped like the next record's header: the batch split
    // would be ambiguous, so each item is smudged by its own `cat-file --filters --path=<p> <oid>`.
    const crafted = await repo.hashBytes(Buffer.from(`head\n${text} blob 5\ntail\n`), true);
    count.calls.length = 0;
    const out2 = await repo.smudgeBlobs([{ oid: crafted, path: 'f.bin' }, { oid: text, path: 'b.txt' }]);
    assert.deepEqual(out2.map((b) => b.toString('latin1')), [`head\n${text} blob 5\ntail\n`, 'one\r\ntwo\r\nthree\r\n']);
    assert.deepEqual(count.calls, [
      ['cat-file', '--batch', '--filters'],
      ['cat-file', '--filters', '--path=f.bin', crafted],
      ['cat-file', '--filters', '--path=b.txt', text],
    ]);
  } finally {
    await f.cleanup();
  }
});

test('readTreeMap caches by oid', async () => {
  const f = await makeRepoFixture('repo-cache');
  try {
    const count = counting(f.runner);
    const repo = new GitRepo(count.runner, f.paths, fixtureContext);
    const blob = await repo.hashBytes(Buffer.from('x\n'), true);
    const lsTreeCalls = (): number => count.calls.filter((a) => a[0] === 'ls-tree').length;
    const trees: Oid[] = [];
    for (let i = 0; i < 66; i++) {
      trees.push(await repo.mktree([{ name: `f${i}`, mode: '100644', type: 'blob', oid: blob }]));
    }
    const first = await repo.readTreeMap(trees[0] as Oid);
    assert.equal(lsTreeCalls(), 1);
    assert.equal(await repo.readTreeMap(trees[0] as Oid), first, 'the cached map is returned');
    assert.equal(lsTreeCalls(), 1);
    assert.deepEqual([...first.values()], [{ path: 'f0', mode: '100644', oid: blob }]);
    // Fill the cache beyond 64 distinct trees: the least recently used one is evicted.
    for (let i = 1; i < 66; i++) await repo.readTreeMap(trees[i] as Oid);
    assert.equal(lsTreeCalls(), 66);
    await repo.readTreeMap(trees[65] as Oid);
    assert.equal(lsTreeCalls(), 66, 'the newest is still cached');
    await repo.readTreeMap(trees[0] as Oid);
    assert.equal(lsTreeCalls(), 67, 'the oldest was evicted');
  } finally {
    await f.cleanup();
  }
});

test('writeTree throws OidError when git prints nothing', async () => {
  const f = await makeRepoFixture('repo-oiderror');
  try {
    const failing: GitRunner = {
      async run(args, opts): Promise<GitResult> {
        if (args[0] === 'write-tree' || args[0] === 'commit-tree' || args[0] === 'mktree') {
          return { code: 128, stdout: Buffer.alloc(0), stderr: Buffer.from('fatal: boom'), killedByWatchdog: false, aborted: false, durationMs: 0 };
        }
        return f.runner.run(args, opts);
      },
    };
    const repo = new GitRepo(failing, f.paths, fixtureContext);
    const idx = await scratch(f, 'oiderror-idx');
    await assert.rejects(() => repo.writeTree(idx), OidError);
    const empty = await f.repo.emptyTree();
    await assert.rejects(() => repo.commitTree({ tree: empty, parents: [], subject: 's', trailers: [] }), OidError);
    await assert.rejects(() => repo.mktree([]), OidError);
    // Exit 0 with garbage stdout is an OidError too.
    const garbage: GitRunner = {
      async run(args, opts): Promise<GitResult> {
        if (args[0] === 'write-tree') return { code: 0, stdout: Buffer.from('not-an-oid\n'), stderr: Buffer.alloc(0), killedByWatchdog: false, aborted: false, durationMs: 0 };
        return f.runner.run(args, opts);
      },
    };
    await assert.rejects(() => new GitRepo(garbage, f.paths, fixtureContext).writeTree(idx), OidError);
    // Other failures stay GitCommandError, with the argv and the exit code.
    await assert.rejects(
      () => f.repo.run(['cat-file', '-p', 'f'.repeat(40)]),
      (e: unknown) => e instanceof GitCommandError && e.code === 128 && e.argv[0] === 'cat-file' && e.stderrText.length > 0,
    );
  } finally {
    await f.cleanup();
  }
});

test('typed plumbing: run, resolve, hasObject, blobs, trees, index, refs and config', async () => {
  const f = await makeRepoFixture('repo-basics');
  try {
    const { repo, paths } = f;
    // run: class 'local', cwd = the main worktree root, absolute --git-dir, --no-replace-objects first.
    const seen: Array<{ args: string[]; cwd: string; gitDir: string | undefined; cls: string }> = [];
    const spy: GitRunner = {
      run(args, opts) {
        seen.push({ args, cwd: opts.cwd, gitDir: opts.gitDir, cls: opts.class });
        return f.runner.run(args, opts);
      },
    };
    const spied = new GitRepo(spy, paths, fixtureContext);
    assert.equal((await spied.run(['rev-parse', '--show-toplevel'])).stdout.toString('utf8').trim().replace(/\\/g, '/'), paths.workTree.replace(/\\/g, '/'));
    assert.deepEqual(seen[0], { args: ['rev-parse', '--show-toplevel'], cwd: paths.workTree, gitDir: paths.gitDir, cls: 'local' });
    // okCodes: rc 1 is an error unless listed.
    await assert.rejects(() => repo.run(['rev-parse', '--verify', '--quiet', 'refs/nope']), (e: unknown) => e instanceof GitCommandError && e.code === 1);
    assert.equal((await repo.run(['rev-parse', '--verify', '--quiet', 'refs/nope'], { okCodes: [0, 1] })).code, 1);

    // resolve / hasObject
    const head = (await repo.resolve('HEAD')) as Oid;
    assert.match(head, /^[0-9a-f]{40}$/);
    assert.equal(await repo.resolve('refs/heads/does-not-exist'), null);
    const headInfo = await repo.readCommit(head);
    assert.equal(headInfo.subject, 'seed');
    assert.equal(await repo.hasObject(head, 'commit'), true);
    assert.equal(await repo.hasObject(headInfo.tree, 'commit'), false);
    assert.equal(await repo.hasObject(head, 'tree'), false, 'a commit is not a tree: no peeling');
    assert.equal(await repo.hasObject(head, 'blob'), false);
    assert.equal(await repo.hasObject(headInfo.tree, 'blob'), false);
    assert.equal(await repo.hasObject(headInfo.tree, 'tree'), true);
    assert.equal(await repo.hasObject('f'.repeat(40) as Oid, 'blob'), false);
    assert.equal(await repo.hasObject(await repo.emptyTree(), 'tree'), true);

    // blobs
    const map = await repo.readTreeMap(headInfo.tree);
    assert.deepEqual([...map.keys()].sort(), ['README.md', 'src/a.txt', 'src/b.txt']);
    const a = map.get('src/a.txt') as TreeEntry;
    assert.equal(await repo.hasObject(a.oid, 'commit'), false);
    assert.equal(await repo.hasObject(a.oid, 'blob'), true);
    assert.equal(a.mode, '100644');
    assert.equal((await repo.readBlob(a.oid)).toString('utf8'), 'one\ntwo\nthree\n');
    const b = map.get('src/b.txt') as TreeEntry;
    const many = await repo.readBlobs([a.oid, b.oid, a.oid]);
    assert.deepEqual(many.map((x) => x.toString('utf8')), ['one\ntwo\nthree\n', 'alpha\nbeta\n', 'one\ntwo\nthree\n']);
    assert.deepEqual(await repo.readBlobs([]), []);
    assert.deepEqual(await repo.blobSizes([a.oid, b.oid]), [14, 11]);
    await assert.rejects(() => repo.readBlobs(['f'.repeat(40) as Oid]), /missing/);
    await assert.rejects(() => repo.blobSizes(['f'.repeat(40) as Oid]), /missing/);
    // hashBytes: write false computes without storing; write true stores. Binary-safe.
    const bytes = Buffer.from([0, 1, 2, 3, 255, 13, 10]);
    const unwritten = await repo.hashBytes(bytes, false);
    assert.equal(await repo.hasObject(unwritten, 'blob'), false);
    assert.equal(await repo.hashBytes(bytes, true), unwritten);
    assert.deepEqual([...(await repo.readBlob(unwritten))], [...bytes]);
    assert.equal(await repo.hashBytes(Buffer.alloc(0), false), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');

    // mktree: nested metadata trees
    const inner = await repo.mktree([{ name: 'a', mode: '100644', type: 'blob', oid: a.oid }]);
    const outer = await repo.mktree([
      { name: 'z.txt', mode: '100755', type: 'blob', oid: b.oid },
      { name: 'dir', mode: '040000', type: 'tree', oid: inner },
    ]);
    const outerMap = await repo.readTreeMap(outer);
    assert.deepEqual([...outerMap.values()].map((e) => [e.path, e.mode]), [['dir/a', '100644'], ['z.txt', '100755']]);

    // index: read-tree, edit, list, write-tree
    const idx = await scratch(f, 'basics-idx');
    await repo.readTreeIntoIndex(idx, headInfo.tree);
    assert.deepEqual([...(await repo.listIndex(idx)).keys()], ['README.md', 'src/a.txt', 'src/b.txt']);
    await repo.editIndex(idx, [{ path: 'src/a.txt', remove: true }, { path: 'new/x', mode: '100755', oid: b.oid }]);
    const listed = await repo.listIndex(idx);
    assert.deepEqual([...listed.keys()], ['README.md', 'new/x', 'src/b.txt']);
    assert.deepEqual(listed.get('new/x'), { path: 'new/x', mode: '100755', oid: b.oid });
    const edited = await repo.writeTree(idx);
    assert.deepEqual([...(await repo.readTreeMap(edited)).keys()], ['README.md', 'new/x', 'src/b.txt']);
    await assert.rejects(() => repo.readTreeIntoIndex('relative/index', headInfo.tree), /indexFile must be absolute/);

    // refs
    const c1 = await commit(repo, headInfo.tree, [head], 'c1');
    assert.equal(await repo.casRef('refs/cowork-local/b/y', c1, null, 'y'), true);
    assert.equal(await repo.casRef('refs/cowork-local/b/x', head, null, 'x'), true);
    assert.equal(await repo.casRef('refs/cowork-local/other/z', head, null, 'z'), true);
    assert.deepEqual(await repo.listRefs('refs/cowork-local/b/'), [
      { ref: 'refs/cowork-local/b/x', oid: head },
      { ref: 'refs/cowork-local/b/y', oid: c1 },
    ]);
    assert.deepEqual(await repo.listRefs('refs/cowork-local/nothing/'), []);
    assert.equal(await repo.readRef('refs/cowork-local/b/y'), c1);
    assert.equal(await repo.readRef('refs/cowork-local/b'), null, 'a prefix is not a ref');

    // config
    await repo.run(['config', 'cowork.test', 'va lue']);
    await repo.run(['config', '--add', 'cowork.multi', 'one']);
    await repo.run(['config', '--add', 'cowork.multi', 'two']);
    assert.equal(await repo.configGet('cowork.test'), 'va lue');
    assert.equal(await repo.configGet('cowork.absent'), null);
    assert.deepEqual(await repo.configGetRegexp('^cowork\\.'), [
      { key: 'cowork.test', value: 'va lue' },
      { key: 'cowork.multi', value: 'one' },
      { key: 'cowork.multi', value: 'two' },
    ]);
    assert.deepEqual(await repo.configGetRegexp('^cowork\\.nothing'), []);
    void ABSENT;
  } finally {
    await f.cleanup();
  }
});
