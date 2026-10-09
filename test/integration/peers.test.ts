import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempRoot, testRunner } from '../helpers/tmp.js';
import { createBareRemote } from '../sim/remote.js';
import { canary, clonePeer, seedRemote } from '../sim/peers.js';
import type { GitRunner } from '../../src/git/runner.js';

const ID = { name: 'Peer', email: 'peer@cowork.invalid' };
const CANARY_SHAPE = /^COWORK_CANARY_[0-9a-f]{12}$/;

/** Seed files: the secret attribute is committed in .gitattributes; the stored secret is the placeholder. */
function seedFiles(): Record<string, Buffer> {
  return {
    '.gitattributes': Buffer.from('secret.txt filter=secret\n', 'utf8'),
    'secret.txt': Buffer.from('token=@@SECRET@@\n', 'utf8'),
    'a.txt': Buffer.from('x\ny\n', 'utf8'),
    'src/한글 dir/b.py': Buffer.from('print("b")\n', 'utf8'),
  };
}

async function out(git: GitRunner, args: string[], cwd: string, filterDrivers?: string[]): Promise<string> {
  const r = await git.run(args, { class: 'local', cwd, identity: ID, wallMsForDates: 1_700_000_100_000, ...(filterDrivers ? { filterDrivers } : {}) });
  assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr.toString('utf8')}`);
  return r.stdout.toString('utf8');
}

test('seedRemote pushes main and gives the same oid for the same files in another root', async () => {
  const a = await makeTempRoot('peers-seed-a');
  const b = await makeTempRoot('peers-seed-b');
  try {
    const git = testRunner();
    const ra = await createBareRemote(a.root, git);
    const rb = await createBareRemote(b.root, git);
    const oidA = await seedRemote(ra, a.root, git, seedFiles());
    const oidB = await seedRemote(rb, b.root, git, seedFiles());
    assert.match(oidA, /^[0-9a-f]{40}$/);
    assert.equal(oidA, oidB);
    assert.deepEqual(await ra.refs(), { 'refs/heads/main': oidA });
    assert.equal(existsSync(join(a.root, 'seed')), false, 'the seed work repo is removed');
    const stored = await out(git, ['cat-file', 'blob', 'refs/heads/main:a.txt'], ra.dir);
    assert.equal(stored, 'x\ny\n');
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

// Under heavy parallel load a push to the local remote can fail while nothing lands, so seedRemote
// pushes through retryGit. The remote's pre-receive hook (rejectNext, Task 11) stands in for that.
test('seedRemote retries a push that landed nothing and lists every attempt when all three fail', async () => {
  const a = await makeTempRoot('peers-retry-a');
  const b = await makeTempRoot('peers-retry-b');
  try {
    const git = testRunner();
    const ra = await createBareRemote(a.root, git);
    await ra.rejectNext(2, 'transient-failed');
    const oid = await seedRemote(ra, a.root, git, seedFiles());
    assert.deepEqual(await ra.refs(), { 'refs/heads/main': oid });

    const rb = await createBareRemote(b.root, git);
    await rb.rejectNext(3, 'transient-failed');
    await assert.rejects(seedRemote(rb, b.root, git, seedFiles()), (e: Error) => {
      const lines = e.message.split('\n');
      assert.match(lines[0] ?? '', /^seedRemote: git push .+ HEAD:refs\/heads\/main: failed 3 of 3 attempts$/);
      assert.deepEqual(lines.slice(1).map((l) => /^ {2}attempt (\d): code=[1-9][0-9]* stderr: /.exec(l)?.[1]), ['1', '2', '3']);
      return true;
    });
    assert.deepEqual(await rb.refs(), {});
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

test('autocrlf=true peers get CRLF work files, autocrlf=false peers get LF', async () => {
  const { root, cleanup } = await makeTempRoot('peers-eol');
  try {
    const git = testRunner();
    const remote = await createBareRemote(root, git);
    await seedRemote(remote, root, git, seedFiles());
    const win = await clonePeer(remote, root, { name: 'win', autocrlf: true, withFilter: false }, git);
    const nix = await clonePeer(remote, root, { name: 'nix', autocrlf: false, withFilter: false }, git);
    assert.equal((await readFile(join(win.dir, 'a.txt'))).toString('utf8'), 'x\r\ny\r\n');
    assert.equal((await readFile(join(nix.dir, 'a.txt'))).toString('utf8'), 'x\ny\n');
    assert.ok(existsSync(join(nix.dir, 'src', '한글 dir', 'b.py')));
    assert.equal((await out(git, ['config', 'core.autocrlf'], win.dir)).trim(), 'true');
    assert.equal((await out(git, ['config', 'core.autocrlf'], nix.dir)).trim(), 'false');
    assert.equal((await out(git, ['status', '--porcelain'], win.dir)), '');
    assert.equal((await out(git, ['status', '--porcelain'], nix.dir)), '');
    // One root = one run = one canary, for every peer, filter or not.
    assert.match(win.canary, CANARY_SHAPE);
    assert.equal(win.canary, nix.canary);
  } finally {
    await cleanup();
  }
});

test('peers in another temp root (another run) get another canary', async () => {
  const a = await makeTempRoot('peers-run-a');
  const b = await makeTempRoot('peers-run-b');
  try {
    const git = testRunner();
    const ra = await createBareRemote(a.root, git);
    const rb = await createBareRemote(b.root, git);
    await seedRemote(ra, a.root, git, seedFiles());
    await seedRemote(rb, b.root, git, seedFiles());
    const pa = await clonePeer(ra, a.root, { name: 'p0', autocrlf: false, withFilter: false }, git);
    const pb = await clonePeer(rb, b.root, { name: 'p0', autocrlf: false, withFilter: false }, git);
    assert.match(pa.canary, CANARY_SHAPE);
    assert.match(pb.canary, CANARY_SHAPE);
    assert.notEqual(pa.canary, pb.canary);
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

test('the counting secret filter smudges the canary in and cleans exactly that string out before it reaches the remote', async () => {
  const { root, cleanup } = await makeTempRoot('peers-filter');
  try {
    const git = testRunner();
    const remote = await createBareRemote(root, git);
    await seedRemote(remote, root, git, seedFiles());
    const peer = await clonePeer(remote, root, { name: 'alice', autocrlf: true, withFilter: true }, git);
    const C = peer.canary;
    assert.match(C, CANARY_SHAPE);

    // Checkout ran the smudge filter once, with the path, and wrote this run's canary.
    assert.equal((await readFile(join(peer.dir, 'secret.txt'))).toString('utf8'), `token=${C}\r\n`);
    const afterCheckout = (await readFile(peer.filterCountFile, 'utf8')).split('\n').filter((l) => l.length > 0);
    assert.deepEqual(afterCheckout, ['smudge secret.txt']);

    // An edit is cleaned on add: more count lines, the canary becomes the placeholder,
    // and near misses (another run's canary, the dashed spelling, a truncated canary) pass through.
    const otherRun = canary('otherrun');
    const dashed = 'COWORK-CANARY-7f3a9c';
    const truncated = C.slice(0, -1);
    await appendFile(
      join(peer.dir, 'secret.txt'),
      Buffer.from(`second=${C}\r\nother=${otherRun}\r\ndashed=${dashed}\r\ntruncated=${truncated}\r\n`, 'utf8'),
    );
    await out(git, ['add', 'secret.txt'], peer.dir, ['secret']);
    const afterAdd = (await readFile(peer.filterCountFile, 'utf8')).split('\n').filter((l) => l.length > 0);
    assert.ok(afterAdd.length > afterCheckout.length);
    assert.ok(afterAdd.slice(afterCheckout.length).every((l) => l === 'clean secret.txt'), afterAdd.join('|'));
    const expectedStored = `token=@@SECRET@@\nsecond=@@SECRET@@\nother=${otherRun}\ndashed=${dashed}\ntruncated=${truncated}\n`;
    const staged = await out(git, ['cat-file', 'blob', ':secret.txt'], peer.dir);
    assert.equal(staged, expectedStored);

    await out(git, ['commit', '-q', '-m', 'edit secret'], peer.dir, ['secret']);
    const pushed = await git.run(['push', '-q', remote.url, 'HEAD:refs/cowork/main/code'], { class: 'network', cwd: peer.dir });
    assert.equal(pushed.code, 0, pushed.stderr.toString('utf8'));
    const atRemote = await out(git, ['cat-file', 'blob', 'refs/cowork/main/code:secret.txt'], remote.dir);
    assert.equal(atRemote.includes(C), false);
    assert.equal(atRemote, expectedStored);
  } finally {
    await cleanup();
  }
});

test('a peer without the filter sees the placeholder and has no count file', async () => {
  const { root, cleanup } = await makeTempRoot('peers-nofilter');
  try {
    const git = testRunner();
    const remote = await createBareRemote(root, git);
    await seedRemote(remote, root, git, seedFiles());
    const bob = await clonePeer(remote, root, { name: 'bob', autocrlf: false, withFilter: false }, git);
    assert.equal((await readFile(join(bob.dir, 'secret.txt'))).toString('utf8'), 'token=@@SECRET@@\n');
    assert.equal(existsSync(bob.filterCountFile), false);
    assert.deepEqual(bob.opts, { name: 'bob', autocrlf: false, withFilter: false });
    assert.equal(bob.name, 'bob');
    assert.match(bob.canary, CANARY_SHAPE);
  } finally {
    await cleanup();
  }
});

test('clonePeer refuses an existing peer directory and a bad name', async () => {
  const { root, cleanup } = await makeTempRoot('peers-twice');
  try {
    const git = testRunner();
    const remote = await createBareRemote(root, git);
    await seedRemote(remote, root, git, seedFiles());
    await clonePeer(remote, root, { name: 'p1', autocrlf: false, withFilter: false }, git);
    await assert.rejects(clonePeer(remote, root, { name: 'p1', autocrlf: false, withFilter: false }, git), /already exists/);
    await assert.rejects(clonePeer(remote, root, { name: '../x', autocrlf: false, withFilter: false }, git), /bad peer name/);
  } finally {
    await cleanup();
  }
});

// Final review: a fixture whose server-side hooks silently do not run (the macOS non-ASCII path case,
// CI run 37404426420) would let every SIM oracle pass on an empty remote log. The seed push is the
// first push of every run, so seedRemote checks that the post-receive hook logged it.
test('seedRemote fails loudly when the bare remote\'s hooks are not running', async () => {
  const { root, cleanup } = await makeTempRoot('peers-nohooks');
  try {
    const git = testRunner();
    const remote = await createBareRemote(root, git);
    const off = await git.run(['config', 'core.hooksPath', join(root, 'no hooks here').replace(/\\/g, '/')], { class: 'local', cwd: remote.dir });
    assert.equal(off.code, 0, off.stderr.toString('utf8'));
    await assert.rejects(seedRemote(remote, root, git, seedFiles()), /hooks are not running/);
  } finally {
    await cleanup();
  }
});
