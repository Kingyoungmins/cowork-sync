import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempRoot, testRunner } from '../helpers/tmp.js';
import { createGitRunner, type GitRunner } from '../../src/git/runner.js';
import { buildDaemonEnv } from '../../src/git/env.js';
import { realClock } from '../../src/ports/clock.js';
import { createBareRemote } from '../sim/remote.js';

const ID = { name: 'Fixture', email: 'fixture@cowork.invalid' };
const ZERO = '0000000000000000000000000000000000000000';

/** A plain work repo with one commit on main; returns its dir and the commit oid. */
async function workRepo(root: string, git: GitRunner, name: string, content: string): Promise<{ dir: string; oid: string }> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  const ok = async (args: string[]) => {
    const r = await git.run(args, { class: 'local', cwd: dir, identity: ID, wallMsForDates: 1_700_000_000_000 });
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr.toString('utf8')}`);
    return r.stdout.toString('utf8').trim();
  };
  await ok(['init', '-q', '-b', 'main']);
  await writeFile(join(dir, 'f.txt'), Buffer.from(content, 'utf8'));
  await ok(['add', 'f.txt']);
  await ok(['commit', '-q', '-m', content.trim()]);
  return { dir, oid: await ok(['rev-parse', 'HEAD']) };
}

async function push(git: GitRunner, cwd: string, url: string, refspec: string) {
  return git.run(['push', '--porcelain', url, refspec], { class: 'network', cwd });
}

test('createBareRemote under a spaced, non-ASCII root accepts a push and logs it', async () => {
  const { root, cleanup } = await makeTempRoot('remote-basic');
  try {
    const git = testRunner();
    const remote = await createBareRemote(root, git);
    // On macOS the repository itself lives at an ASCII path (see the layout test below).
    if (process.platform !== 'darwin') assert.ok(remote.dir.includes('공 백 dir'));
    assert.ok(root.includes('공 백 dir'));
    assert.match(remote.url, /^file:\/\//);
    const { dir, oid } = await workRepo(root, git, 'work', 'one\n');
    const r = await push(git, dir, remote.url, 'HEAD:refs/heads/main');
    assert.equal(r.code, 0, r.stderr.toString('utf8'));
    assert.deepEqual(await remote.refs(), { 'refs/heads/main': oid });
    assert.deepEqual(await remote.readRemoteLog(), [{ ref: 'refs/heads/main', old: ZERO, new: oid }]);
    const tx = await remote.readRefTxLog();
    assert.ok(tx.some((e) => e.state === 'committed' && e.ref === 'refs/heads/main' && e.new === oid), JSON.stringify(tx));
  } finally {
    await cleanup();
  }
});

test('hook files are LF-only and the shim is exactly two lines (Review Focus 3)', async () => {
  const { root, cleanup } = await makeTempRoot('remote-lf');
  try {
    const remote = await createBareRemote(root, testRunner());
    for (const name of ['pre-receive', 'post-receive', 'reference-transaction']) {
      const shim = await readFile(join(remote.dir, 'hooks', name));
      assert.equal(shim.toString('utf8'), '#!/bin/sh\nexec node "$0.js" "$@"\n');
      const js = await readFile(join(remote.dir, 'hooks', `${name}.js`));
      assert.equal(js.includes(0x0d), false, `${name}.js contains CR`);
    }
  } finally {
    await cleanup();
  }
});

test('rejectNext(policy) is enforced by the pre-receive hook, then the next push lands (Review Focus 3)', async () => {
  const { root, cleanup } = await makeTempRoot('remote-policy');
  try {
    const git = testRunner();
    const remote = await createBareRemote(root, git);
    const { dir, oid } = await workRepo(root, git, 'work', 'one\n');
    await remote.rejectNext(1, 'policy');
    const rejected = await push(git, dir, remote.url, 'HEAD:refs/heads/main');
    assert.notEqual(rejected.code, 0);
    const text = rejected.stdout.toString('utf8') + rejected.stderr.toString('utf8');
    assert.match(text, /policy: blocked/);
    assert.match(text, /pre-receive hook declined/);
    assert.deepEqual(await remote.refs(), {});
    assert.deepEqual(await remote.readRemoteLog(), []);
    const control = JSON.parse(await readFile(join(root, 'remote-control.json'), 'utf8')) as { count: number };
    assert.equal(control.count, 0, 'the hook decremented its counter');

    const landed = await push(git, dir, remote.url, 'HEAD:refs/heads/main');
    assert.equal(landed.code, 0, landed.stderr.toString('utf8'));
    assert.deepEqual(await remote.refs(), { 'refs/heads/main': oid });
  } finally {
    await cleanup();
  }
});

test('commit_refs and transient-failed print their texts and leave the ref unchanged', async () => {
  const { root, cleanup } = await makeTempRoot('remote-kinds');
  try {
    const git = testRunner();
    const remote = await createBareRemote(root, git);
    const { dir } = await workRepo(root, git, 'work', 'one\n');

    await remote.rejectNext(1, 'commit_refs');
    const a = await push(git, dir, remote.url, 'HEAD:refs/heads/main');
    const aText = a.stdout.toString('utf8') + a.stderr.toString('utf8');
    assert.notEqual(a.code, 0);
    assert.match(aText, /fatal error in commit_refs/);
    assert.match(aText, /\[remote rejected\] .*\(pre-receive hook declined\)/);

    await remote.rejectNext(2, 'transient-failed');
    for (let i = 0; i < 2; i++) {
      const b = await push(git, dir, remote.url, 'HEAD:refs/heads/main');
      const bText = b.stdout.toString('utf8') + b.stderr.toString('utf8');
      assert.notEqual(b.code, 0);
      assert.match(bText, /pre-receive hook declined/);
      assert.doesNotMatch(bText, /policy: blocked|commit_refs/);
    }
    assert.deepEqual(await remote.refs(), {});
  } finally {
    await cleanup();
  }
});

test('refSubstring limits rejection to matching refs; clearRejects removes the rule', async () => {
  const { root, cleanup } = await makeTempRoot('remote-substring');
  try {
    const git = testRunner();
    const remote = await createBareRemote(root, git);
    const { dir, oid } = await workRepo(root, git, 'work', 'one\n');

    await remote.rejectNext(5, 'policy', 'refs/cowork/');
    const main = await push(git, dir, remote.url, 'HEAD:refs/heads/main');
    assert.equal(main.code, 0, main.stderr.toString('utf8'));
    const board = await push(git, dir, remote.url, 'HEAD:refs/cowork/main/board');
    assert.notEqual(board.code, 0);

    await remote.clearRejects();
    assert.equal(existsSync(join(root, 'remote-control.json')), false);
    const again = await push(git, dir, remote.url, 'HEAD:refs/cowork/main/board');
    assert.equal(again.code, 0, again.stderr.toString('utf8'));
    assert.deepEqual(await remote.refs(), { 'refs/cowork/main/board': oid, 'refs/heads/main': oid });
  } finally {
    await cleanup();
  }
});

test('the remote log records deletions and non-fast-forward updates with old and new oids', async () => {
  const { root, cleanup } = await makeTempRoot('remote-log');
  try {
    const git = testRunner();
    const remote = await createBareRemote(root, git);
    const one = await workRepo(root, git, 'one', 'one\n');
    const two = await workRepo(root, git, 'two', 'two\n');
    assert.equal((await push(git, one.dir, remote.url, 'HEAD:refs/cowork/main/code')).code, 0);
    assert.equal((await push(git, two.dir, remote.url, '+HEAD:refs/cowork/main/code')).code, 0);
    assert.equal((await push(git, two.dir, remote.url, ':refs/cowork/main/code')).code, 0);
    assert.deepEqual(await remote.readRemoteLog(), [
      { ref: 'refs/cowork/main/code', old: ZERO, new: one.oid },
      { ref: 'refs/cowork/main/code', old: one.oid, new: two.oid },
      { ref: 'refs/cowork/main/code', old: two.oid, new: ZERO },
    ]);
    const tx = await remote.readRefTxLog();
    assert.ok(tx.every((e) => e.state === 'committed'));
    assert.ok(tx.some((e) => e.ref === 'refs/cowork/main/code' && e.old === two.oid && e.new === ZERO), JSON.stringify(tx));
  } finally {
    await cleanup();
  }
});

test('a user-global core.hooksPath does not switch off the fixture hooks', async () => {
  const { root, cleanup } = await makeTempRoot('remote-globalhooks');
  try {
    const globalCfg = join(root, 'user global.gitconfig');
    const nowhere = join(root, 'nowhere').replace(/\\/g, '/');
    await writeFile(globalCfg, Buffer.from(`[core]\n\thooksPath = "${nowhere}"\n`, 'utf8'));
    const git = createGitRunner({
      clock: realClock,
      hooksPath: join(root, 'empty-hooks'),
      daemonEnv: buildDaemonEnv({ ...process.env, GIT_CONFIG_GLOBAL: globalCfg }, []),
      testBuild: true,
    });
    const remote = await createBareRemote(root, git);
    const { dir } = await workRepo(root, git, 'work', 'one\n');
    await remote.rejectNext(1, 'policy');
    const r = await push(git, dir, remote.url, 'HEAD:refs/heads/main');
    assert.notEqual(r.code, 0);
    assert.match(r.stdout.toString('utf8') + r.stderr.toString('utf8'), /policy: blocked/);
  } finally {
    await cleanup();
  }
});

// macOS: receive-pack ignores the repository's own config when the pushed-to repository path has
// non-ASCII characters (CI run 37404426420), so there the bare repo lives at an ASCII path and
// <root>/remote.git links to it. Elsewhere the repository is <root>/remote.git itself.
test('the bare repository path is ASCII on macOS and <root>/remote.git elsewhere; the layout path always reaches it', async () => {
  const { root, cleanup } = await makeTempRoot('remote-layout');
  try {
    const remote = await createBareRemote(root, testRunner());
    const layout = join(root, 'remote.git');
    if (process.platform === 'darwin') {
      assert.match(remote.dir, /^[\x20-\x7e]*$/, remote.dir);
      assert.ok(lstatSync(layout).isSymbolicLink(), `${layout} is not a symlink`);
      assert.equal(realpathSync.native(layout), realpathSync.native(remote.dir));
    } else {
      assert.equal(remote.dir, layout);
    }
    assert.ok(existsSync(join(layout, 'hooks', 'pre-receive')));
  } finally {
    await cleanup();
  }
});

test('creating a second remote in the same root is refused', async () => {
  const { root, cleanup } = await makeTempRoot('remote-twice');
  try {
    const git = testRunner();
    await createBareRemote(root, git);
    await assert.rejects(createBareRemote(root, git), /already exists/);
  } finally {
    await cleanup();
  }
});
