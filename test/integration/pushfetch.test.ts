import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchRefs, lsRemote } from '../../src/git/fetch.js';
import { checkRefName } from '../../src/git/netcall.js';
import { ABSENT, parseOid, type Oid, type OidOrAbsent } from '../../src/git/oid.js';
import { buildPushArgv, deleteProbeRef, pushSpec, runPush, type PushOutcomeRaw, type PushSpec } from '../../src/git/push.js';
import { GitRepo } from '../../src/git/repo.js';
import type { GitRunner } from '../../src/git/runner.js';
import { noTrace } from '../../src/ports/trace.js';
import { NET_BACKOFF_MIN_MS } from '../../src/board/governor.js';
import { FETCH_SPACING_MS, Fetcher, OFFLINE_AFTER_MS } from '../../src/engine/fetcher.js';
import { RELEASE_NAMESPACE, refNames } from '../../src/engine/refs.js';
import { commitFiles } from '../helpers/commitFiles.js';
import { REF_NAME_TABLE } from '../helpers/refNameTable.js';
import { FIXTURE_IDENTITY, fixtureContext, makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import { retryGit } from '../helpers/retryGit.js';
import { VirtualClock } from '../sim/vclock.js';

const PEER = '0123456789abcdef0123456789abcdef';
const OTHER = 'fedcba9876543210fedcba9876543210';
const refs = refNames('main', RELEASE_NAMESPACE);

/** A GitRepo on the fixture clone whose runner records every argv (as GitRepo passes it to the runner). */
function recording(f: RepoFixture): { repo: GitRepo; calls: string[][] } {
  const calls: string[][] = [];
  const runner: GitRunner = {
    run(args, opts) {
      calls.push([...args]);
      return f.runner.run(args, opts);
    },
  };
  return { repo: new GitRepo(runner, f.paths, fixtureContext), calls };
}

/** Setup pushes that must land: retried only while the remote shows nothing landed (Windows load, see retryGit). */
async function land(f: RepoFixture, specs: PushSpec[]): Promise<PushOutcomeRaw> {
  const before = await f.remote.refs();
  return retryGit(() => runPush(f.repo, f.remote.url, specs, []), {
    attempts: 3,
    label: 'land',
    nothingLanded: async () => JSON.stringify(await f.remote.refs()) === JSON.stringify(before),
  });
}

/** rename, retried briefly: on Windows a just-exited git can hold the directory for a moment. */
async function renameRetrying(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      if (i >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

async function three(f: RepoFixture): Promise<{ c1: Oid; c2: Oid; c3: Oid }> {
  const c1 = await commitFiles(f, { 'a.txt': 'one\n' });
  const c2 = await commitFiles(f, { 'a.txt': 'two\n' }, c1);
  const c3 = await commitFiles(f, { 'b.txt': 'x\n' });
  return { c1, c2, c3 };
}

test('runPush to a file:// remote reports ok, a stale-lease rejection and a pre-receive rejection per ref', async () => {
  const f = await makeRepoFixture('push-run');
  try {
    const { c1, c2, c3 } = await three(f);
    const url = f.remote.url;
    // Two new refs with ABSENT leases: one push, both ok.
    const both = [pushSpec(c1, refs.remoteBoard, ABSENT), pushSpec(c3, refs.remoteCode, ABSENT)];
    const r1 = await land(f, both);
    assert.equal(r1.code, 0);
    assert.deepEqual(r1.statuses, new Map([[refs.remoteBoard, 'ok'], [refs.remoteCode, 'ok']]));
    assert.deepEqual(r1.argv, buildPushArgv(url, both, []));
    assert.equal(r1.killedByWatchdog, false);
    let remote = await f.remote.refs();
    assert.equal(remote[refs.remoteBoard], c1);
    assert.equal(remote[refs.remoteCode], c3);

    // A stale lease on the board, a right one on the mirror: no --atomic, so the mirror moves alone (glossary §26.2 item 1).
    const tx0 = (await f.remote.readRefTxLog()).length;
    const r2 = await runPush(f.repo, url, [pushSpec(c2, refs.remoteBoard, c3), pushSpec(c1, refs.remoteCode, c3)], []);
    assert.notEqual(r2.code, 0);
    assert.deepEqual(r2.statuses, new Map([[refs.remoteBoard, 'rejected'], [refs.remoteCode, 'ok']]));
    remote = await f.remote.refs();
    assert.equal(remote[refs.remoteBoard], c1, 'the stale lease kept the board');
    assert.equal(remote[refs.remoteCode], c1);
    assert.deepEqual((await f.remote.readRefTxLog()).slice(tx0).map((e) => e.ref), [refs.remoteCode]);

    // A pre-receive rejection (a host's `[remote rejected] … (failed)`, glossary §25 F11) declines every ref of its push:
    // one ref per push, and the next identical push lands.
    await f.remote.rejectNext(1, 'transient-failed', '/board');
    const tx1 = (await f.remote.readRefTxLog()).length;
    const r3 = await runPush(f.repo, url, [pushSpec(c2, refs.remoteBoard, c1)], []);
    assert.notEqual(r3.code, 0);
    assert.deepEqual(r3.statuses, new Map([[refs.remoteBoard, 'rejected']]));
    assert.equal((await f.remote.refs())[refs.remoteBoard], c1);
    assert.equal((await f.remote.readRefTxLog()).length, tx1, 'nothing committed');
    const r4 = await land(f, [pushSpec(c2, refs.remoteBoard, c1)]);
    assert.deepEqual(r4.statuses, new Map([[refs.remoteBoard, 'ok']]));
    assert.equal((await f.remote.refs())[refs.remoteBoard], c2);

    // No porcelain line at all (an unreachable remote): 'none', never 'rejected'.
    const nowhere = pathToFileURL(join(f.root, 'nowhere.git')).href;
    const r5 = await runPush(f.repo, nowhere, [pushSpec(c2, refs.remoteBoard, c1)], []);
    assert.notEqual(r5.code, 0);
    assert.deepEqual(r5.statuses, new Map([[refs.remoteBoard, 'none']]));
    assert.ok(r5.stderr.length > 0);
  } finally {
    await f.cleanup();
  }
});

test('deleteProbeRef deletes only the allowed probe ref and throws before spawning for any other', async () => {
  const f = await makeRepoFixture('push-probe');
  try {
    const { c1, c2 } = await three(f);
    const url = f.remote.url;
    const probe = refs.probe(PEER);
    await land(f, [pushSpec(c1, probe, ABSENT), pushSpec(c1, refs.remoteBoard, ABSENT)]);
    const rec = recording(f);
    const refused: Array<[string, string, string, string]> = [
      [refs.remoteBoard, probe, c1, url],                       // a ref other than the allowed one
      [refs.remoteBoard, refs.remoteBoard, c1, url],            // allowed is not a probe ref
      [refs.remoteCode, refs.remoteCode, c1, url],
      ['refs/heads/main', 'refs/heads/main', c1, url],
      [refs.probe(OTHER), probe, c1, url],                      // another peer's probe
      ['refs/cowork/probe-', 'refs/cowork/probe-', c1, url],    // no peer after the prefix
      ['refs/cowork/main/probe-x/board', 'refs/cowork/main/probe-x/board', c1, url],
      [`+${probe}`, `+${probe}`, c1, url],
      [`:${probe}`, `:${probe}`, c1, url],
      [probe, probe, '', url],                                   // an empty lease
      [probe, probe, 'abc', url],
      [probe, probe, c1, '--upload-pack=x'],
    ];
    for (const [ref, allowed, lease, u] of refused) {
      await assert.rejects(async () => deleteProbeRef(rec.repo, u, ref, allowed, lease as Oid), JSON.stringify([ref, allowed, lease, u]));
    }
    assert.deepEqual(rec.calls, [], 'no git process for a refused deletion');

    // A stale lease does not delete it; the right one does, and nothing else moves (INV-OID).
    const stale = await deleteProbeRef(rec.repo, url, probe, probe, c2);
    assert.deepEqual(stale.statuses, new Map([[probe, 'rejected']]));
    assert.equal((await f.remote.refs())[probe], c1);
    const before = await f.remote.refs();
    const del = await deleteProbeRef(rec.repo, url, probe, probe, c1);
    assert.equal(del.code, 0);
    assert.deepEqual(del.statuses, new Map([[probe, 'ok']]));
    assert.deepEqual(del.argv, ['push', '--porcelain', '--no-verify', `--force-with-lease=${probe}:${c1}`, url, `:${probe}`]);
    const after = await f.remote.refs();
    const expected = { ...before };
    delete expected[probe];
    assert.deepEqual(after, expected);
    assert.deepEqual(rec.calls.map((a) => a[0]), ['push', 'push']);
  } finally {
    await f.cleanup();
  }
});

test('fetchRefs with the mirror missing falls back to ls-remote, fetches the board and reports code ABSENT', async () => {
  const f = await makeRepoFixture('fetch-nomirror');
  try {
    const { c1 } = await three(f);
    await land(f, [pushSpec(c1, refs.remoteBoard, ABSENT)]);
    const main = parseOid((await f.remote.refs())['refs/heads/main']!);
    const rec = recording(f);
    const res = await fetchRefs(rec.repo, f.remote.url, refs.fetchSpecs);
    assert.equal(res.ok, true);
    assert.deepEqual(res.values, new Map<string, OidOrAbsent>([[refs.remoteBoard, c1], [refs.remoteCode, ABSENT], [refs.remoteBranch, main]]));
    assert.equal(await f.repo.readRef(refs.localBoard), c1);
    assert.equal(await f.repo.readRef(refs.localCode), null);
    assert.equal(await f.repo.readRef(refs.localBranch), main);
    // One whole fetch (it fails on the missing source), one ls-remote of the same refs, a re-fetch of the present ones only.
    const network = rec.calls.filter((a) => a[0] === 'fetch' || a[0] === 'ls-remote');
    assert.deepEqual(network, [
      ['fetch', '--porcelain', f.remote.url, `+${refs.remoteBoard}:${refs.localBoard}`, `+${refs.remoteCode}:${refs.localCode}`, `+${refs.remoteBranch}:${refs.localBranch}`],
      ['ls-remote', f.remote.url, refs.remoteBoard, refs.remoteCode, refs.remoteBranch],
      ['fetch', '--porcelain', f.remote.url, `+${refs.remoteBoard}:${refs.localBoard}`, `+${refs.remoteBranch}:${refs.localBranch}`],
    ]);
    assert.notEqual(res.code, 0, 'the first fetch failed');
    // lsRemote reports exact names only (ls-remote patterns tail-match).
    await land(f, [pushSpec(c1, `refs/cowork/x/${refs.remoteBoard}`, ABSENT)]);
    const ls = await lsRemote(f.repo, f.remote.url, [refs.remoteBoard, refs.remoteCode]);
    assert.deepEqual(ls, { ok: true, values: new Map([[refs.remoteBoard, c1]]) });
    // An unreachable remote: ok false, ls-remote did not answer, and the values are the local refs as they stand.
    const nowhere = pathToFileURL(join(f.root, 'nowhere.git')).href;
    assert.deepEqual(await lsRemote(f.repo, nowhere, [refs.remoteBoard]), { ok: false, values: new Map() });
    const down = await fetchRefs(f.repo, nowhere, refs.fetchSpecs);
    assert.equal(down.ok, false);
    assert.deepEqual(down.values, new Map<string, OidOrAbsent>([[refs.remoteBoard, c1], [refs.remoteCode, ABSENT], [refs.remoteBranch, main]]));
    assert.ok(down.stderr.length > 0);
  } finally {
    await f.cleanup();
  }
});

test('fetchRefs with the board missing reports board ABSENT and fetches the branch', async () => {
  const f = await makeRepoFixture('fetch-noboard');
  try {
    const { c3 } = await three(f);
    await land(f, [pushSpec(c3, refs.remoteCode, ABSENT)]);
    const main = parseOid((await f.remote.refs())['refs/heads/main']!);
    const res = await fetchRefs(f.repo, f.remote.url, refs.fetchSpecs);
    assert.equal(res.ok, true);
    assert.deepEqual(res.values, new Map<string, OidOrAbsent>([[refs.remoteBoard, ABSENT], [refs.remoteCode, c3], [refs.remoteBranch, main]]));
    assert.equal(await f.repo.readRef(refs.localBoard), null);
    assert.equal(await f.repo.readRef(refs.localBranch), main);
    assert.equal(await f.repo.readRef(refs.localCode), c3);
    // Every ref missing: the remote answered, nothing to re-fetch.
    const g = await makeRepoFixture('fetch-none');
    try {
      const none = await fetchRefs(g.repo, g.remote.url, [{ remote: refs.remoteBoard, local: refs.localBoard }]);
      assert.deepEqual({ ok: none.ok, values: none.values }, { ok: true, values: new Map([[refs.remoteBoard, ABSENT]]) });
    } finally {
      await g.cleanup();
    }
    // Destinations outside refs/cowork-remote/ are refused before any git call (INV-ENG-USER: never refs/heads or refs/remotes).
    for (const local of ['refs/heads/main', 'refs/remotes/origin/main', 'FETCH_HEAD', 'refs/cowork/main/board']) {
      await assert.rejects(async () => fetchRefs(f.repo, f.remote.url, [{ remote: refs.remoteBoard, local }]), /fetchRefs/, local);
    }
    await assert.rejects(async () => fetchRefs(f.repo, f.remote.url, []), /fetchRefs/);
    await assert.rejects(async () => fetchRefs(f.repo, f.remote.url, [{ remote: 'refs/cowork/*', local: refs.localBoard }]), /fetchRefs/);
  } finally {
    await f.cleanup();
  }
});

test('fetch writes no FETCH_HEAD and no refs/remotes/*, and the fetched local refs get reflog entries', async () => {
  const f = await makeRepoFixture('fetch-clean');
  try {
    const { c1, c2, c3 } = await three(f);
    await land(f, [pushSpec(c1, refs.remoteBoard, ABSENT), pushSpec(c3, refs.remoteCode, ABSENT)]);
    // A remote-tracking refspec for the cowork namespace: a fetch through the remote's NAME would write
    // refs/remotes/origin/cowork/* (git's opportunistic remote-tracking update, checked live at the end); the
    // engine's fetch names the URL, so it must write none.
    await f.repo.run(['config', '--add', 'remote.origin.fetch', '+refs/cowork/*:refs/remotes/origin/cowork/*']);
    const user = async (): Promise<{ fetchHead: string | null; origHead: string | null; refs: string }> => {
      const file = async (name: string): Promise<string | null> => readFile(join(f.paths.gitDir, name), 'latin1').catch(() => null);
      const list = await f.repo.run(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/remotes', 'refs/heads', 'refs/tags']);
      return { fetchHead: await file('FETCH_HEAD'), origHead: await file('ORIG_HEAD'), refs: list.stdout.toString('utf8') };
    };
    const before = await user();
    assert.ok(before.refs.includes('refs/remotes/origin/main'), 'the clone has a remote-tracking ref that must not move');
    const res = await fetchRefs(f.repo, f.remote.url, refs.fetchSpecs);
    assert.equal(res.ok, true);
    assert.equal(res.code, 0);
    await land(f, [pushSpec(c2, refs.remoteBoard, c1)]);
    const res2 = await fetchRefs(f.repo, f.remote.url, refs.fetchSpecs);
    assert.equal(res2.values.get(refs.remoteBoard), c2);
    assert.deepEqual(await user(), before, 'FETCH_HEAD, ORIG_HEAD, refs/heads, refs/remotes and refs/tags untouched (ENG-18, mutant M35)');
    // ENG-02: every fetched local ref has a reflog, and the board's shows both updates.
    for (const local of [refs.localBoard, refs.localCode, refs.localBranch]) {
      const r = await f.repo.run(['reflog', 'exists', local], { okCodes: [0, 1] });
      assert.equal(r.code, 0, `${local} has a reflog`);
    }
    const log = await f.repo.run(['reflog', 'show', '--format=%H', refs.localBoard]);
    assert.deepEqual(log.stdout.toString('utf8').split('\n').filter((l) => l.length > 0), [c2, c1]);
    // The planted refspec is live: the same source fetched through the remote's name does write refs/remotes/*,
    // so the assertion above can fail.
    assert.equal(await f.repo.readRef('refs/remotes/origin/cowork/main/board'), null);
    await f.repo.run(['fetch', 'origin', `+${refs.remoteBoard}:refs/cowork-remote/control/board`], { class: 'network' });
    assert.equal(await f.repo.readRef('refs/remotes/origin/cowork/main/board'), c2, 'a fetch by remote name writes refs/remotes/*');
  } finally {
    await f.cleanup();
  }
});

test("fetchRefs and lsRemote take a branch whose name contains '+' (feat+x)", async () => {
  const f = await makeRepoFixture('fetch-plus');
  try {
    const plus = refNames('feat+x', RELEASE_NAMESPACE);
    assert.equal(plus.remoteBranch, 'refs/heads/feat+x');
    const main = parseOid((await f.remote.refs())['refs/heads/main']!);
    // pushSpec refuses '+' (board refs are enc(b)-encoded and never contain one), so the branch is made on the remote directly.
    const made = await f.runner.run(['update-ref', 'refs/heads/feat+x', main], { class: 'refupdate', cwd: f.remote.dir });
    assert.equal(made.code, 0, made.stderr.toString('utf8'));
    assert.deepEqual(await lsRemote(f.repo, f.remote.url, [plus.remoteBranch, plus.remoteBoard]), { ok: true, values: new Map([[plus.remoteBranch, main]]) });
    const res = await fetchRefs(f.repo, f.remote.url, plus.fetchSpecs);
    assert.deepEqual({ ok: res.ok, remoteAnswered: res.remoteAnswered }, { ok: true, remoteAnswered: true });
    assert.deepEqual(res.values, new Map<string, OidOrAbsent>([[plus.remoteBoard, ABSENT], [plus.remoteCode, ABSENT], [plus.remoteBranch, main]]));
    assert.equal(await f.repo.readRef(plus.localBranch), main);
    // Still refused before any git call: what is not a plain refname, and a destination outside refs/cowork-remote/.
    for (const bad of ['+refs/heads/main', 'refs/heads/a:b', 'refs/heads/x..y', 'refs/heads/x.lock', 'refs/heads/sp ace', 'refs/heads/x@{1}', 'refs/heads/*', 'refs/heads/x/',
      'refs/heads/.x', 'refs/heads/a.lock/b', 'refs/heads/x.']) {
      await assert.rejects(async () => fetchRefs(f.repo, f.remote.url, [{ remote: bad, local: plus.localBranch }]), /fetchRefs/, bad);
      await assert.rejects(async () => lsRemote(f.repo, f.remote.url, [bad]), /lsRemote/, bad);
    }
    await assert.rejects(async () => fetchRefs(f.repo, f.remote.url, [{ remote: plus.remoteBranch, local: 'refs/heads/feat+x' }]), /fetchRefs/);
  } finally {
    await f.cleanup();
  }
});

test('checkRefName agrees with git check-ref-format on every row of its table', async () => {
  const f = await makeRepoFixture('refname-oracle');
  try {
    const disagree: string[] = [];
    for (const [ref, valid] of REF_NAME_TABLE) {
      if (ref.includes('\t') || ref.includes('\u007f')) continue;   // control characters: not carried through an argv
      const r = await f.repo.run(['check-ref-format', ref], { okCodes: [0, 1] });
      if ((r.code === 0) !== valid) disagree.push(`${JSON.stringify(ref)}: the table says ${valid ? 'valid' : 'invalid'}, git rc ${r.code}`);
      let ours = true;
      try {
        checkRefName('oracle', ref);
      } catch {
        ours = false;
      }
      if (ours !== (r.code === 0)) disagree.push(`${JSON.stringify(ref)}: checkRefName says ${ours ? 'valid' : 'invalid'}, git rc ${r.code}`);
    }
    assert.deepEqual(disagree, []);
  } finally {
    await f.cleanup();
  }
});

/**
 * A commit with a gitlink `sub` to a submodule commit that no remote of the submodule has: a nested repository at
 * <workTree>/sub holding s1 (its refs/remotes/origin/main, as if pushed) and s2 (never pushed), and a clone commit
 * whose tree is the gitlink sub → s2. push.recurseSubmodules=check refuses to push such a commit; on-demand first
 * tries to push the submodule, which has no remote to push to. (git checks only a submodule that has remote refs.)
 */
async function gitlinkCommit(f: RepoFixture, parent: Oid): Promise<Oid> {
  const subDir = join(f.paths.workTree, 'sub');
  await f.runner.run(['init', '--quiet', subDir], { class: 'local', cwd: f.paths.workTree });
  const sub = new GitRepo(f.runner, { workTree: subDir, gitDir: join(subDir, '.git'), coworkDir: join(subDir, '.git', 'cowork') }, fixtureContext);
  const empty = await sub.emptyTree();
  const s1 = await sub.commitTree({ tree: empty, parents: [], subject: 's1', trailers: [] });
  const s2 = await sub.commitTree({ tree: empty, parents: [s1], subject: 's2', trailers: [] });
  await sub.run(['update-ref', 'refs/remotes/origin/main', s1], { class: 'refupdate' });
  await sub.run(['update-ref', 'HEAD', s2], { class: 'refupdate' });
  const tree = await f.repo.mktree([{ name: 'sub', mode: '160000', type: 'commit', oid: s2 }]);
  return f.repo.commitTree({ tree, parents: [parent], subject: 'with a submodule', trailers: [] });
}

test("a user's push.pushOption, push.gpgSign=true, push.followTags=true and push.recurseSubmodules=check|on-demand reach no cowork push: it lands, sends no push option and carries no tag (ruling P2-PUSHCFG)", async () => {
  const f = await makeRepoFixture('push-usercfg');
  try {
    const { c1, c2 } = await three(f);
    // An annotated tag on c1, which every push below carries (c2's parent): push.followTags would send it.
    await f.repo.run(['tag', '-a', '-m', 'release', 'v1', c1], { identity: { ...FIXTURE_IDENTITY } });
    const cs = await gitlinkCommit(f, c2);
    const cases: Array<[key: string, value: string, ref: string, commit: Oid]> = [
      // The fixture remote advertises no push options: a configured option that reached the push would fail it whole.
      ['push.pushOption', 'ci.skip', refs.remoteBoard, c2],
      // No signing key and no push-cert support on the remote: a signed push would fail whole.
      ['push.gpgSign', 'true', refs.remoteCode, c2],
      ['push.followTags', 'true', refs.probe(PEER), c2],
      // The live tree carries a gitlink whose commit no remote of the submodule has.
      ['push.recurseSubmodules', 'check', 'refs/cowork/main/sub-check', cs],
      ['push.recurseSubmodules', 'on-demand', 'refs/cowork/main/sub-on-demand', cs],
    ];
    // Every key is tried (one at a time) and every failure reported, so one leaking key does not hide another.
    const problems: string[] = [];
    for (const [key, value, ref, commit] of cases) {
      await f.repo.run(['config', key, value]);
      try {
        const r = await land(f, [pushSpec(commit, ref, ABSENT)]);
        assert.deepEqual(r.statuses, new Map([[ref, 'ok']]), key);
        const remote = await f.remote.refs();
        assert.equal(remote[ref], commit, `${key}: the push landed`);
        assert.deepEqual(Object.keys(remote).filter((k) => k.startsWith('refs/tags/')), [], `${key}: no tag reached the remote`);
      } catch (e) {
        problems.push(`${key}=${value}: ${(e as Error).message.replace(/\s+/g, ' ').slice(0, 240)}`);
      }
      await f.repo.run(['config', '--unset-all', key]);
    }
    assert.deepEqual(problems, []);
    // The submodule fixture is live: a push that does check submodules (the command-line option beats every config)
    // refuses the gitlink commit, so the two recurseSubmodules cases above can fail.
    const control = await f.repo.run(['push', '--porcelain', '--recurse-submodules=check', f.remote.url, `${cs}:refs/cowork/main/sub-control`], { class: 'network', okCodes: [0, 1, 128] });
    assert.notEqual(control.code, 0, 'a submodule-checking push of the gitlink commit fails');
    assert.match(control.stderr.toString('utf8'), /submodule/, 'refused by the submodule check');
    assert.equal((await f.remote.refs())['refs/cowork/main/sub-control'], undefined);
  } finally {
    await f.cleanup();
  }
});

test('a stale refs/cowork-remote lock is a local failure: the remote answered, never OFFLINE and no network backoff (ruling P2-FETCHLOCAL)', async () => {
  const f = await makeRepoFixture('fetch-stalelock');
  try {
    const { c1 } = await three(f);
    await land(f, [pushSpec(c1, refs.remoteBoard, ABSENT)]);
    // A power loss inside a fetch's ref update leaves the lock file behind (Task 15's ENG-53 cleanup removes it at start).
    const lockDir = join(f.paths.gitDir, 'refs', 'cowork-remote', 'main');
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, 'board.lock'), '');
    const res = await fetchRefs(f.repo, f.remote.url, refs.fetchSpecs);
    assert.deepEqual({ ok: res.ok, remoteAnswered: res.remoteAnswered, killed: res.killedByWatchdog }, { ok: false, remoteAnswered: true, killed: false });
    assert.equal(await f.repo.readRef(refs.localBoard), null, 'the locked ref did not move');
    // The Fetcher on a virtual clock: more than 30 s after start with only local failures, it is not OFFLINE and backs off nothing.
    const clock = new VirtualClock();
    const fetcher = new Fetcher({ repo: f.repo, url: f.remote.url, refs, clock, trace: noTrace, peer: PEER });
    clock.advance(OFFLINE_AFTER_MS + 1_000);
    const v1 = await fetcher.fetch();
    assert.deepEqual({ ok: v1.ok, deferred: v1.deferred, localFailure: v1.localFailure }, { ok: false, deferred: false, localFailure: true });
    assert.deepEqual(fetcher.offline(), { offline: false, offlineForMs: 0 });
    assert.equal(fetcher.lastSuccessMono(), null);
    assert.equal(fetcher.nextAllowedMono(), clock.monoMs() + FETCH_SPACING_MS, 'plain spacing, no 30 s network backoff');
    clock.advance(FETCH_SPACING_MS);
    const v2 = await fetcher.fetch();
    assert.deepEqual({ ok: v2.ok, deferred: v2.deferred, localFailure: v2.localFailure }, { ok: false, deferred: false, localFailure: true });
    assert.equal(fetcher.offline().offline, false);
    // The lock removed: the next fetch succeeds.
    await rm(join(lockDir, 'board.lock'));
    clock.advance(FETCH_SPACING_MS);
    const v3 = await fetcher.fetch();
    assert.deepEqual({ ok: v3.ok, localFailure: v3.localFailure, board: v3.board }, { ok: true, localFailure: false, board: c1 });
  } finally {
    await f.cleanup();
  }
});

test('a re-fetch that fails on the network after ls-remote answered is a network failure: remoteAnswered false, OFFLINE and the backoff, never a local failure (ruling P2-FETCHLOCAL)', async () => {
  const f = await makeRepoFixture('fetch-goneafterls');
  const gone = `${f.remote.dir}.gone`;
  let moved = false;
  try {
    const { c1 } = await three(f);
    // The mirror is missing: the first fetch fails on the missing source, ls-remote answers, then the present refs are
    // re-fetched. The runner moves the bare repository away right before that re-fetch (the remote became unreachable).
    const calls: string[] = [];
    const runner: GitRunner = {
      async run(args, opts) {
        if (args[0] === 'fetch' && calls[calls.length - 1] === 'ls-remote') {
          await renameRetrying(f.remote.dir, gone);
          moved = true;
        }
        calls.push(args[0]!);
        return f.runner.run(args, opts);
      },
    };
    const repo = new GitRepo(runner, f.paths, fixtureContext);
    const back = async (): Promise<void> => {
      if (moved) await renameRetrying(gone, f.remote.dir);
      moved = false;
    };
    await land(f, [pushSpec(c1, refs.remoteBoard, ABSENT)]);
    const res = await fetchRefs(repo, f.remote.url, refs.fetchSpecs);
    assert.deepEqual(calls, ['fetch', 'ls-remote', 'fetch', 'for-each-ref']);
    assert.equal(moved, true, 'the re-fetch ran against the moved remote');
    assert.deepEqual({ ok: res.ok, remoteAnswered: res.remoteAnswered, killed: res.killedByWatchdog }, { ok: false, remoteAnswered: false, killed: false });
    await back();
    // The Fetcher on a virtual clock, through its impl seam: not a local failure, OFFLINE after 30 s, the 30 s backoff.
    calls.length = 0;
    const clock = new VirtualClock();
    const fetcher = new Fetcher({ repo: f.repo, url: f.remote.url, refs, clock, trace: noTrace, peer: PEER, impl: (_r, url, specs, abort) => fetchRefs(repo, url, specs, abort) });
    clock.advance(OFFLINE_AFTER_MS + 1_000);
    const v = await fetcher.fetch();
    await back();
    assert.deepEqual(calls, ['fetch', 'ls-remote', 'fetch', 'for-each-ref']);
    assert.deepEqual({ ok: v.ok, deferred: v.deferred, localFailure: v.localFailure }, { ok: false, deferred: false, localFailure: false });
    assert.deepEqual(fetcher.offline(), { offline: true, offlineForMs: OFFLINE_AFTER_MS + 1_000 });
    assert.equal(fetcher.nextAllowedMono(), clock.monoMs() + NET_BACKOFF_MIN_MS, 'the network backoff, not the plain spacing');
    // A local failure on the same path (a stale lock on the re-fetched board ref) stays local: git reached the ref update.
    const lockDir = join(f.paths.gitDir, 'refs', 'cowork-remote', 'main');
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, 'board.lock'), '');
    const local = await fetchRefs(f.repo, f.remote.url, refs.fetchSpecs);
    assert.deepEqual({ ok: local.ok, remoteAnswered: local.remoteAnswered }, { ok: false, remoteAnswered: true });
    await rm(join(lockDir, 'board.lock'));
  } finally {
    if (moved) await renameRetrying(gone, f.remote.dir).catch(() => undefined);
    await f.cleanup();
  }
});

test('a watchdog-killed fetch is a network failure at once: no ls-remote follows it', async () => {
  const f = await makeRepoFixture('fetch-killed');
  try {
    // Only the kill is simulated (a blackholed remote takes the 45 s watchdog); every other call is real git.
    const calls: string[][] = [];
    const runner: GitRunner = {
      run(args, opts) {
        calls.push([...args]);
        if (args[0] === 'fetch') {
          return Promise.resolve({ code: -1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), killedByWatchdog: true, aborted: false, durationMs: 45_000 });
        }
        return f.runner.run(args, opts);
      },
    };
    const res = await fetchRefs(new GitRepo(runner, f.paths, fixtureContext), f.remote.url, refs.fetchSpecs);
    assert.deepEqual(calls.map((a) => a[0]), ['fetch', 'for-each-ref'], 'no ls-remote after a watchdog kill (another 45 s against a blackholed remote)');
    assert.deepEqual({ ok: res.ok, remoteAnswered: res.remoteAnswered, killed: res.killedByWatchdog, code: res.code }, { ok: false, remoteAnswered: false, killed: true, code: -1 });
  } finally {
    await f.cleanup();
  }
});

test('fetchRefs passes its abort signal to every network call and stops at once once aborted (ruling P2-ABORT)', async () => {
  const f = await makeRepoFixture('fetch-abort');
  try {
    const { c1 } = await three(f);
    await land(f, [pushSpec(c1, refs.remoteBoard, ABSENT)]);
    const seen: Array<[string, boolean]> = [];
    const ctl = new AbortController();
    const runner: GitRunner = {
      run(args, opts) {
        seen.push([args[0]!, opts.abort === ctl.signal]);
        return f.runner.run(args, opts);
      },
    };
    const repo = new GitRepo(runner, f.paths, fixtureContext);
    // The mirror is missing: the whole fetch fails, ls-remote answers, the present refs are re-fetched; the local read takes no signal.
    const res = await fetchRefs(repo, f.remote.url, refs.fetchSpecs, ctl.signal);
    assert.equal(res.ok, true);
    assert.deepEqual(seen, [['fetch', true], ['ls-remote', true], ['fetch', true], ['for-each-ref', false]]);
    // Aborted (abandon() on a suspend gap): the runner spawns nothing, no ls-remote follows, nothing was answered.
    seen.length = 0;
    ctl.abort();
    const gone = await fetchRefs(repo, f.remote.url, refs.fetchSpecs, ctl.signal);
    assert.deepEqual({ ok: gone.ok, remoteAnswered: gone.remoteAnswered }, { ok: false, remoteAnswered: false });
    assert.deepEqual(seen, [['fetch', true], ['for-each-ref', false]]);
  } finally {
    await f.cleanup();
  }
});
