// Audit #1 #2 sweep (fix wave F1, group G1; rule R-A6 git matrix): git 2.53.0.windows.2 aborts `merge-file --object-id` in BUG()
// whenever the git dir is explicit (exit 3 on Windows, empty stdout). Every engine git call carries --git-dir (flags.ts), so this file
// runs each subcommand form the engine and the viewer build — through the real runner, with the repo's own options; merge-file as
// runMergeFile runs it (ruling G1-FILEFORM) — on the git of the machine and checks that none ends in a BUG()/abort and each exits as
// the code expects. A git that adds this class of crash to another subcommand fails here, by name, before any data path reads its exit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mergeTree, runMergeFile } from '../../src/git/merge.js';
import type { Oid } from '../../src/git/oid.js';
import type { RunOpts } from '../../src/git/repo.js';
import { makeRepoFixture } from '../helpers/repoFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };
const ABORT_LINE = /^(?:BUG: |fatal: .*(?:abort|assert)|Assertion failed)/m;

interface Form { args: string[]; opts?: RunOpts; codes?: readonly number[]; }

test('every git subcommand form the engine builds runs on this git (with the runner --git-dir) without a BUG()/abort', T10, async (t) => {
  const f = await makeRepoFixture('g1-git-forms');
  try {
    const { repo, paths, root } = f;
    const head = (await repo.resolve('HEAD')) as Oid;
    const info = await repo.readCommit(head);
    const tree = info.tree;
    const a = await repo.hashBytes(Buffer.from('1\n2\n3\n', 'utf8'), true);
    const b = await repo.hashBytes(Buffer.from('1\nTWO\n3\n', 'utf8'), true);
    const c = await repo.hashBytes(Buffer.from('1\ntwo\n3\n', 'utf8'), true);
    const index = join(paths.coworkDir, 'tmp', 'sweep.index');
    const stage = join(root, 'stage');
    await mkdir(join(paths.coworkDir, 'tmp'), { recursive: true });
    await mkdir(join(stage, 'src'), { recursive: true });
    await writeFile(join(stage, 'src', 'a.txt'), 'one\ntwo\nthree\n');
    await writeFile(join(stage, 'stagefile'), 'stage\n');
    const ent = `100644 ${a}\tswept.txt\0`;
    const commitMsg = Buffer.from('sweep\n', 'utf8');
    const identity = { name: 'Sweep', email: 'sweep@cowork.invalid' };
    const stageOpts: RunOpts = { indexFile: index, workTree: stage, config: { 'core.fileMode': 'false' } };
    const U0 = ['-U0', '--inter-hunk-context=0', '--diff-algorithm=myers', '--no-indent-heuristic', '--no-color', '--no-ext-diff', '--no-textconv', '--text'];
    const forms: Form[] = [
      { args: ['version'] },
      { args: ['rev-parse', '--verify', '--quiet', 'HEAD'] },
      { args: ['rev-parse', '--verify', '--quiet', 'refs/nope'], codes: [1] },
      { args: ['rev-parse', '--verify', '-q', 'refs/heads/main'] },
      { args: ['symbolic-ref', '-q', 'HEAD'] },
      { args: ['symbolic-ref', '--quiet', 'HEAD'] },
      { args: ['show-ref', '--exists', 'refs/heads/main'], codes: [0, 2] },
      { args: ['cat-file', '-t', head] },
      { args: ['cat-file', '-s', a] },
      { args: ['cat-file', '-e', head] },
      { args: ['cat-file', 'blob', a] },
      { args: ['cat-file', 'commit', head] },
      { args: ['cat-file', '--batch'], opts: { stdin: Buffer.from(`${a}\n${head}\n`) } },
      { args: ['cat-file', '--batch-check'], opts: { stdin: Buffer.from(`${a}\n`) } },
      { args: ['cat-file', '--batch-check=%(objecttype) %(objectsize)'], opts: { stdin: Buffer.from(`${a}\n`) } },
      { args: ['cat-file', '--batch', '--filters'], opts: { class: 'attr', stdin: Buffer.from(`${a} src/a.txt\n`) } },
      { args: ['cat-file', '--filters', '--path=src/a.txt', a], opts: { class: 'attr' } },
      { args: ['hash-object', '-t', 'tree', '--stdin', '--no-filters'], opts: { stdin: Buffer.alloc(0) } },
      { args: ['hash-object', '-w', '--stdin', '--no-filters'], opts: { stdin: Buffer.from('route c\n') } },
      { args: ['hash-object', '--path=stagefile', '--', join(stage, 'stagefile')], opts: { class: 'attr' } },
      { args: ['ls-tree', '-r', '-z', '--full-tree', tree] },
      { args: ['ls-tree', '-z', tree] },
      { args: ['ls-tree', '-z', head, '--', 'src/a.txt'] },
      { args: ['read-tree', '--empty'], opts: { class: 'refupdate', indexFile: index } },
      { args: ['update-index', '--add', '--replace', '-z', '--index-info'], opts: { class: 'refupdate', indexFile: index, stdin: Buffer.from(ent) } },
      { args: ['write-tree'], opts: { indexFile: index } },
      { args: ['read-tree', tree], opts: { class: 'refupdate', indexFile: index } },
      { args: ['ls-files', '-s', '-z'], opts: { indexFile: index } },
      { args: ['ls-files', '-s', '-z', '--', 'src/a.txt'], opts: { indexFile: index, literalPathspecs: true, config: { 'core.fileMode': 'false' } } },
      { args: ['ls-files', '-o', '--exclude-standard', '-z'] },
      { args: ['add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], opts: { ...stageOpts, class: 'refupdate', literalPathspecs: true, stdin: Buffer.from('src/a.txt\0') } },
      { args: ['add', '--ignore-errors', '--pathspec-from-file=-', '--pathspec-file-nul'], opts: { ...stageOpts, class: 'refupdate', literalPathspecs: true, stdin: Buffer.from('src/a.txt\0') } },
      { args: ['update-index', '--refresh'], opts: stageOpts, codes: [0, 1] },
      { args: ['diff-files', '-z', '--name-only'], opts: stageOpts },
      { args: ['check-attr', '-z', '--stdin', 'filter'], opts: { class: 'attr', stdin: Buffer.from('src/a.txt\0') } },
      { args: ['check-attr', '-z', '--stdin', 'text', 'eol', 'binary', 'merge'], opts: { class: 'attr', stdin: Buffer.from('src/a.txt\0') } },
      { args: ['var', 'GIT_ATTR_GLOBAL'], codes: [0, 1] },
      { args: ['mktree', '-z'], opts: { stdin: Buffer.from(`100644 blob ${a}\tx\0`) } },
      { args: ['mktree', '-z', '--batch'], opts: { stdin: Buffer.from(`100644 blob ${a}\tx\0\0`) } },
      { args: ['commit-tree', tree, '-p', head], opts: { class: 'refupdate', identity, stdin: commitMsg } },
      { args: ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads/main'] },
      { args: ['rev-list', '--first-parent', '--max-count=5', head] },
      { args: ['rev-list', '--first-parent', '--count', head] },
      { args: ['rev-list', '--max-count=1', `${head}..${head}`] },
      { args: ['rev-list', '--first-parent', '--max-count=1', '--grep=^Cowork-X: ', head] },
      { args: ['rev-list', '--first-parent', '--max-count=1', '-F', '--grep=sweep', head] },
      { args: ['rev-list', '--first-parent', '--no-commit-header', '--max-count=5', '--format=%x00%H%n%P%n%B', head] },
      { args: ['rev-list', '--first-parent', '--max-count=1', head, '--', 'src/a.txt'] },
      { args: ['rev-list', '--first-parent', '--skip=0', '--max-count=1', head] },
      { args: ['rev-list', '--max-parents=0', head] },
      { args: ['rev-list', '--objects', '--no-object-names', '--filter=blob:none', '--missing=allow-any', head] },
      { args: ['log', '-g', '-z', '--no-show-signature', '--format=%H %P %ct', 'refs/heads/main', '--'], codes: [0, 128] },
      { args: ['diff-tree', '-r', '-z', '--no-renames', '--no-commit-id', head, head] },
      { args: ['diff-tree', '-r', '-z', '-M', '--no-ext-diff', '--no-textconv', '--no-commit-id', head, head] },
      { args: ['diff', ...U0, a, b], codes: [0, 1] },
      { args: ['config', '--get', 'core.bare'] },
      { args: ['config', '-z', '--get-regexp', '^core\\.'] },
      { args: ['config', '-z', '--show-scope', '--get-all', 'core.bare'] },
      { args: ['config', '-z', '--show-scope', '--type=path', '--get-all', 'core.hooksPath'], codes: [0, 1] },
      { args: ['config', '--show-origin', '-z', '--get-regexp', '^url\\..*\\.(insteadof|pushinsteadof)$'], codes: [0, 1] },
      { args: ['config', '-z', '--show-scope', '--get-regexp', '^filter\\.'], codes: [0, 1] },
      { args: ['config', '--type=bool', '--get', 'core.filemode'], codes: [0, 1] },
      { args: ['remote', 'get-url', 'origin'] },
      { args: ['remote', 'get-url', '--push', 'origin'] },
      { args: ['merge-base', '--is-ancestor', head, head] },
      { args: ['update-ref', '--create-reflog', '-m', 'sweep', 'refs/cowork-local/sweep/state', head, '0'.repeat(head.length)], opts: { class: 'refupdate', identity } },
      { args: ['update-ref', '-d', 'refs/cowork-local/sweep/state', head], opts: { class: 'refupdate', identity } },
      { args: ['ls-remote', f.remote.url, 'refs/heads/main'], opts: { class: 'network' } },
      { args: ['fetch', '--porcelain', f.remote.url, '+refs/heads/main:refs/cowork-remote/sweep/main'], opts: { class: 'network' } },
      { args: ['push', '--porcelain', '--no-verify', `--force-with-lease=refs/heads/sweep:`, f.remote.url, `${head}:refs/heads/sweep`], opts: { class: 'network' } },
    ];
    // merge-file in every option form the engine writes (mergeFile, conflict.ts, restore, REBASE/MASK, revertInverse), run as the engine
    // runs it: runMergeFile's file form (ruling G1-FILEFORM). The raw --object-id form through the runner (with --git-dir) is only
    // recorded: it is the form git 2.53.0.windows.2 aborts in BUG() (exit 3), the reason the engine no longer runs it.
    const mergeForms: Form[] = [
      { args: ['merge-file', '-p', '--object-id', b, a, c], codes: [1] },
      { args: ['merge-file', '-p', '--object-id', a, a, a], codes: [0] },
      { args: ['merge-file', '-p', '--object-id', '--diff3', '--marker-size=9', b, a, c], codes: [1] },
      { args: ['merge-file', '-p', '--object-id', '--diff3', '-L', 'cowork:disk', '-L', 'cowork:base', '-L', 'cowork:held', b, a, c], codes: [1] },
      { args: ['merge-file', '-p', '--object-id', '--marker-size=8', b, a, c], codes: [1] },
      { args: ['merge-file', '-p', '--object-id', '--ours', b, a, c], codes: [0] },
    ];
    const bad: string[] = [];
    for (const [i, form] of forms.entries()) {
      const r = await repo.run(form.args, { ...form.opts, okCodes: Array.from({ length: 256 }, (_, k) => k).concat(-1) });
      const err = r.stderr.toString('utf8');
      const want = form.codes ?? [0];
      const line = `#${i} ${form.args.slice(0, 5).join(' ').slice(0, 100)} → exit ${r.code}${err.length > 0 ? ` (${err.split('\n')[0]!.slice(0, 120)})` : ''}`;
      t.diagnostic(line);
      if (ABORT_LINE.test(err) || !want.includes(r.code)) bad.push(line);
    }
    for (const [i, form] of mergeForms.entries()) {
      const raw = await repo.run(form.args, { okCodes: Array.from({ length: 256 }, (_, k) => k).concat(-1) });
      const rawErr = raw.stderr.toString('utf8').split('\n')[0]!.slice(0, 120);
      t.diagnostic(`merge #${i} raw --object-id form via --git-dir → exit ${raw.code}${rawErr.length > 0 ? ` (${rawErr})` : ''} (recorded only)`);
      const r = await runMergeFile(repo, form.args);
      const line = `merge #${i} ${form.args.slice(3, 6).join(' ').slice(0, 80)} → runMergeFile rc ${r.rc}`;
      t.diagnostic(line);
      if (!(form.codes ?? [0]).includes(r.rc)) bad.push(line);
    }
    // merge-tree goes through its own wrapper (parentless commits, rc 0/1).
    const mt = await mergeTree(repo, tree, tree, tree);
    t.diagnostic(`merge-tree (mergeTree) → rc ${mt.rc}`);
    if (mt.rc !== 0) bad.push(`merge-tree rc ${mt.rc}`);
    assert.deepEqual(bad, [], 'every form exits as expected and none aborts');
  } finally {
    await f.cleanup();
  }
});
