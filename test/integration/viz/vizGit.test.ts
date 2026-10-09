// VizGit: the viewer's read-only git facade (Plan 8a Task 2; VIZ-07; rulings R-V06, R-V09, R-V10, R-V13; S5, S22).
// Real git against file:// remotes; the only spies are GitRunner wrappers that record what VizGit hands the runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildDaemonEnv } from '../../../src/git/env.js';
import { buildGitInvocation, type GitCallOptions } from '../../../src/git/flags.js';
import type { Oid } from '../../../src/git/oid.js';
import { createGitRunner, type GitResult, type GitRunner } from '../../../src/git/runner.js';
import { meetsFloor, parseGitVersion } from '../../../src/git/version.js';
import { realClock } from '../../../src/ports/clock.js';
import {
  createVizGit, VIZ_GIT_CONFIG, VIZ_GIT_ENV, VIZ_GIT_WATCHDOG_MS, VizGitRefused, vizGitRunner, type VizGit,
} from '../../../src/viz/source/vizGit.js';
import { makeTempRoot, testRunner } from '../../helpers/tmp.js';

interface Call { args: string[]; opts: GitCallOptions; }

/** A runner that records every call and hands it to `inner` (or answers with `fake`). */
function spyRunner(inner: GitRunner | null, fake?: (args: string[]) => GitResult): GitRunner & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    run(args: string[], opts: GitCallOptions): Promise<GitResult> {
      calls.push({ args: [...args], opts: { ...opts } });
      if (inner === null) return Promise.resolve(fake!(args));
      return inner.run(args, opts);
    },
  };
}

const ok = (stdout: string): GitResult => ({ code: 0, stdout: Buffer.from(stdout, 'utf8'), stderr: Buffer.alloc(0), killedByWatchdog: false, aborted: false, durationMs: 0 });

/** The absolute git the CLI would resolve (R-V13): the first git on PATH, by realpath. */
function absoluteGit(): string {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const name = process.platform === 'win32' ? 'git.exe' : 'git';
  for (const dir of (process.env[key] ?? '').split(delimiter)) {
    if (dir.length === 0) continue;
    const p = join(dir, name);
    if (existsSync(p)) return realpathSync.native(p);
  }
  throw new Error('no git on PATH');
}

async function must(args: string[], cwd: string, opts: Partial<GitCallOptions> = {}): Promise<string> {
  const r = await testRunner().run(args, { class: 'local', cwd, ...opts });
  assert.equal(r.code, 0, `git ${args.join(' ')}: ${r.stderr.toString('utf8')}`);
  return r.stdout.toString('utf8').trim();
}

const ID = { identity: { name: 'Fixture', email: 'fixture@cowork.invalid' }, wallMsForDates: 1_700_000_000_000 } as const;

/** A repository with two commits and refs under refs/cowork-remote/ and elsewhere; returns its gitdir and commit oids. */
async function repoWithRefs(root: string): Promise<{ gitDir: string; c1: Oid; c2: Oid }> {
  const dir = join(root, 'repo');
  await must(['init', '-q', '-b', 'main', dir], root);
  const tree = await must(['hash-object', '-w', '-t', 'tree', '--stdin'], dir, { stdin: Buffer.alloc(0) });
  const c1 = await must(['commit-tree', tree], dir, { ...ID, stdin: Buffer.from('one\n') }) as Oid;
  const c2 = await must(['commit-tree', tree, '-p', c1], dir, { ...ID, stdin: Buffer.from('two\n') }) as Oid;
  await must(['update-ref', 'refs/cowork-remote/main/board', c2], dir);
  await must(['update-ref', 'refs/cowork-remote/feat/x/board', c1], dir);
  await must(['update-ref', 'refs/cowork-remote/main/code', c1], dir);
  await must(['update-ref', 'refs/cowork-local/main/board', c1], dir);
  await must(['update-ref', 'refs/heads/other', c1], dir);
  return { gitDir: realpathSync.native(join(dir, '.git')), c1, c2 };
}

test('every VizGit call carries --no-replace-objects, an absolute --git-dir, cwd = the data directory, protocol.allow=never and protocol.{file,git,http,https,ssh}.allow=never, the runner\'s protocol.ext.allow=never, GIT_OPTIONAL_LOCKS=0 and GIT_NO_LAZY_FETCH=1, and an absolute git path', async () => {
  const { root, cleanup } = await makeTempRoot('vizgit-flags');
  try {
    const { gitDir, c2 } = await repoWithRefs(root);
    const dataDir = join(root, 'data dir');
    mkdirSync(dataDir);
    const env = buildDaemonEnv(process.env as Record<string, string | undefined>, []);
    const real = vizGitRunner({ clock: realClock, dataDir, env, gitPath: absoluteGit() });
    const spy = spyRunner(real);
    const vg = createVizGit({ runner: spy, gitDir, dataDir });
    assert.equal(vg.gitDir, gitDir);
    assert.ok(meetsFloor(await vg.version()));
    assert.equal(await vg.revParse('refs/cowork-remote/main/board'), c2);
    assert.equal((await vg.remoteRefs()).length, 3);
    assert.equal(await vg.chainCount(c2), 2);
    assert.deepEqual((await vg.chain(c2, 0, 5)).length, 2);
    await vg.run(['cat-file', '--batch-check'], { stdin: Buffer.from(`${c2}\n`) });
    await vg.run(['cat-file', '--batch'], { stdin: Buffer.from(`${c2}\n`) });
    assert.equal(spy.calls.length, 7);

    // What the runner turns each call into (the same base vizGitRunner configures).
    const base = { hooksPath: join(dataDir, 'viz-no-hooks'), platform: process.platform, daemonEnv: { ...env, ...VIZ_GIT_ENV }, testBuild: false };
    for (const c of spy.calls) {
      assert.equal(c.opts.class, 'local');
      assert.equal(c.opts.cwd, dataDir);
      assert.equal(c.opts.gitDir, gitDir);
      assert.deepEqual(c.opts.config, VIZ_GIT_CONFIG);
      assert.equal(c.opts.workTree, undefined);
      const inv = buildGitInvocation(c.args, c.opts, base);
      assert.equal(inv.argv[0], '--no-replace-objects');
      assert.equal(inv.argv[1], `--git-dir=${gitDir}`);
      for (const kv of ['protocol.allow=never', 'protocol.file.allow=never', 'protocol.git.allow=never', 'protocol.http.allow=never',
        'protocol.https.allow=never', 'protocol.ssh.allow=never', 'protocol.ext.allow=never']) {
        const i = inv.argv.indexOf(kv);
        assert.ok(i > 0 && inv.argv[i - 1] === '-c', `${c.args[0]}: -c ${kv} missing`);
      }
      assert.ok(!inv.argv.some((a) => /safe\.directory/i.test(a)), 'safe.directory is never overridden');
      assert.equal(inv.env['GIT_OPTIONAL_LOCKS'], '0');
      assert.equal(inv.env['GIT_NO_LAZY_FETCH'], '1');
    }
    assert.deepEqual(VIZ_GIT_ENV, { GIT_NO_LAZY_FETCH: '1' });
    assert.equal(VIZ_GIT_WATCHDOG_MS, 120_000);

    // The git path: relative or bare → throws; the data directory must be absolute too.
    assert.throws(() => vizGitRunner({ clock: realClock, dataDir, env, gitPath: 'git' }));
    assert.throws(() => vizGitRunner({ clock: realClock, dataDir, env, gitPath: join('bin', 'git') }));
    assert.throws(() => vizGitRunner({ clock: realClock, dataDir: 'data', env, gitPath: absoluteGit() }));
    assert.throws(() => createVizGit({ runner: spy, gitDir: 'repo/.git', dataDir }));
    if (process.platform === 'win32') {
      // Windows: absolute means a drive letter or UNC; root-relative and drive-relative paths depend on the current drive
      // or directory and are refused.
      for (const p of ['\\Program Files\\Git\\cmd\\git.exe', '/Program Files/Git/cmd/git.exe', 'C:git.exe']) {
        assert.throws(() => vizGitRunner({ clock: realClock, dataDir, env, gitPath: p }), /absolute/, p);
      }
      assert.throws(() => vizGitRunner({ clock: realClock, dataDir: '\\cowork-data', env, gitPath: absoluteGit() }), /absolute/);
      assert.throws(() => createVizGit({ runner: spy, gitDir: '\\repo\\.git', dataDir }), /absolute/);
      assert.throws(() => createVizGit({ runner: spy, gitDir, dataDir: '\\cowork-data' }), /absolute/);
      vizGitRunner({ clock: realClock, dataDir: 'C:/cowork data', env, gitPath: '\\\\server\\share\\git\\git.exe' });
    }
    // A case variant of GIT_NO_LAZY_FETCH in the given env cannot outvote the forced value.
    const odd = spyRunner(vizGitRunner({ clock: realClock, dataDir, env: { ...env, git_no_lazy_fetch: '0' }, gitPath: absoluteGit() }));
    assert.ok(meetsFloor(await createVizGit({ runner: odd, gitDir, dataDir }).version()));
  } finally {
    await cleanup();
  }
});

test('vizGitRunner spawns the absolute git it was given, with GIT_NO_LAZY_FETCH=1 in git\'s own environment', async () => {
  const { root, cleanup } = await makeTempRoot('vizgit-spawn-env');
  try {
    const dataDir = join(root, 'data');
    mkdirSync(dataDir);
    const env = buildDaemonEnv(process.env as Record<string, string | undefined>, []);
    // git prints its own environment (a shell alias given on the command line; the runner, not VizGit's allowlist).
    const dump = async (o: { env: Record<string, string>; gitPath: string }): Promise<GitResult> =>
      vizGitRunner({ clock: realClock, dataDir, ...o }).run(['vizenv'], { class: 'local', cwd: dataDir, config: { 'alias.vizenv': '!env' } });
    for (const given of [env, { ...env, GIT_NO_LAZY_FETCH: '0' }, { ...env, git_no_lazy_fetch: '0' }]) {
      const r = await dump({ env: given, gitPath: absoluteGit() });
      assert.equal(r.code, 0, r.stderr.toString('utf8'));
      const lines = r.stdout.toString('utf8').split('\n').filter((l) => /^GIT_NO_LAZY_FETCH=/i.test(l));
      assert.deepEqual(lines, ['GIT_NO_LAZY_FETCH=1'], JSON.stringify(Object.keys(given).filter((k) => /lazy/i.test(k))));
    }
    // The given path is the one spawned: an absolute path that names no program fails to start, whatever is on PATH.
    const none = await dump({ env, gitPath: join(root, 'no git here', process.platform === 'win32' ? 'git.exe' : 'git') });
    assert.equal(none.code, -1);
    assert.match(none.stderr.toString('utf8'), /spawn failed/);
  } finally {
    await cleanup();
  }
});

test('VizGit refuses an argv outside the allowlist before spawning', async () => {
  const spy = spyRunner(null, () => ok(''));
  const vg = createVizGit({ runner: spy, gitDir: realpathSync.native(process.cwd()), dataDir: realpathSync.native(process.cwd()) });
  const oid = 'a'.repeat(40);
  const refused: string[][] = [
    ['log'],
    ['log', '--oneline', oid],
    ['cat-file', '-p', oid],
    ['cat-file', '--batch', '--filters'],
    ['rev-list', oid],
    ['rev-list', '--max-count=5', oid],
    ['rev-list', '--first-parent', '--all'],
    ['rev-parse', '--verify', '-q', 'refs/cowork-local/x'],
    ['rev-parse', '--verify', '-q', 'refs/cowork-remote/x'],
    ['for-each-ref', 'refs/heads/'],
    ['for-each-ref', '-z', '--format=%(objectname) %(refname)', 'refs/cowork-remote/'],
    ['fetch'],
    ['fetch', 'origin'],
    ['version', '--build-options'],
  ];
  for (const args of refused) {
    await assert.rejects(vg.run(args, { stdin: Buffer.alloc(0) }), VizGitRefused, JSON.stringify(args));
  }
  await assert.rejects(vg.revParse('refs/cowork-local/x'), VizGitRefused);
  await assert.rejects(vg.revParse('HEAD'), VizGitRefused);
  await assert.rejects(vg.chainCount('HEAD' as Oid), VizGitRefused);
  await assert.rejects(vg.chain(oid as Oid, -1, 5), VizGitRefused);
  await assert.rejects(vg.chain(oid as Oid, 0, 1.5), VizGitRefused);
  await assert.rejects(vg.chain(oid as Oid, 0, 1e21), VizGitRefused);
  assert.equal(spy.calls.length, 0, 'no process was started');
});

test('remoteRefs uses for-each-ref --format=%(objectname) %(refname); for-each-ref -z is never sent', async () => {
  const { root, cleanup } = await makeTempRoot('vizgit-refs');
  try {
    const { gitDir, c1, c2 } = await repoWithRefs(root);
    const dataDir = join(root, 'data');
    mkdirSync(dataDir);
    const spy = spyRunner(vizGitRunner({ clock: realClock, dataDir, env: buildDaemonEnv(process.env as Record<string, string | undefined>, []), gitPath: absoluteGit() }));
    const vg = createVizGit({ runner: spy, gitDir, dataDir });
    assert.deepEqual(await vg.remoteRefs(), [
      { ref: 'refs/cowork-remote/feat/x/board', oid: c1 },
      { ref: 'refs/cowork-remote/main/board', oid: c2 },
      { ref: 'refs/cowork-remote/main/code', oid: c1 },
    ]);
    assert.deepEqual(spy.calls.map((c) => c.args), [['for-each-ref', '--format=%(objectname) %(refname)', 'refs/cowork-remote/']]);
    assert.ok(!spy.calls.some((c) => c.args.includes('-z')));
  } finally {
    await cleanup();
  }
});

test('version() uses the subcommand version and meetsFloor', async () => {
  const old = spyRunner(null, () => ok('git version 2.42.9\n'));
  const v = await createVizGit({ runner: old, gitDir: realpathSync.native(process.cwd()), dataDir: realpathSync.native(process.cwd()) }).version();
  assert.deepEqual(old.calls.map((c) => c.args), [['version']]);
  assert.equal(v.raw, '2.42.9');
  assert.equal(meetsFloor(v), false);
  const floor = spyRunner(null, () => ok('git version 2.43.0.windows.1\n'));
  assert.equal(meetsFloor(await createVizGit({ runner: floor, gitDir: realpathSync.native(process.cwd()), dataDir: realpathSync.native(process.cwd()) }).version()), true);
  // A failing git is an error, never a version.
  const broken = spyRunner(null, () => ({ ...ok(''), code: 1 }));
  await assert.rejects(createVizGit({ runner: broken, gitDir: realpathSync.native(process.cwd()), dataDir: realpathSync.native(process.cwd()) }).version());
});

test('a promisor clone\'s missing live commit is never lazily fetched', async () => {
  const { root, cleanup } = await makeTempRoot('vizgit-promisor');
  try {
    // A remote holding A (main) and its child C (side, the "live commit"); a blob:none clone of main alone lacks C.
    const remote = join(root, 'remote.git');
    await must(['init', '-q', '--bare', remote], root);
    await must(['config', 'uploadpack.allowFilter', 'true'], remote);
    await must(['config', 'uploadpack.allowAnySHA1InWant', 'true'], remote);
    const work = join(root, 'work');
    await must(['init', '-q', '-b', 'main', work], root);
    const tree = await must(['hash-object', '-w', '-t', 'tree', '--stdin'], work, { stdin: Buffer.alloc(0) });
    const a = await must(['commit-tree', tree], work, { ...ID, stdin: Buffer.from('A\n') });
    const c = await must(['commit-tree', tree, '-p', a], work, { ...ID, stdin: Buffer.from('C\n') }) as Oid;
    await must(['update-ref', 'refs/heads/main', a], work);
    await must(['update-ref', 'refs/heads/side', c], work);
    await must(['push', '-q', remote, 'refs/heads/main:refs/heads/main', 'refs/heads/side:refs/heads/side'], work, { class: 'network' });
    const clone = join(root, 'clone');
    await must(['clone', '-q', '--filter=blob:none', '--single-branch', '-b', 'main', pathToFileURL(remote).href, clone], root, { class: 'network' });
    assert.equal(await must(['config', '--get', 'remote.origin.promisor'], clone), 'true');
    const gitDir = realpathSync.native(join(clone, '.git'));
    const absent = async (): Promise<boolean> => {
      const r = await testRunner().run(['cat-file', '-e', c], { class: 'local', cwd: clone, extraEnv: { GIT_NO_LAZY_FETCH: '1' } });
      return r.code !== 0;
    };
    assert.ok(await absent(), 'the clone starts without C');

    const dataDir = join(root, 'data');
    mkdirSync(dataDir);
    const vg: VizGit = createVizGit({
      runner: vizGitRunner({ clock: realClock, dataDir, env: buildDaemonEnv(process.env as Record<string, string | undefined>, []), gitPath: absoluteGit() }),
      gitDir, dataDir,
    });
    const { readLiveCommits } = await import('../../../src/board/batchRead.js');
    assert.deepEqual(await readLiveCommits(vg, [c]), { reads: [{ oid: c, malformed: 'missing' }], next: 1 });
    const check = await vg.run(['cat-file', '--batch-check'], { stdin: Buffer.from(`${c}\n`) });
    assert.equal(check.stdout.toString('utf8'), `${c} missing\n`);
    assert.ok(await absent(), 'the viewer fetched C');

    // Each defence on its own, so that neither half can go unnoticed: createVizGit's command-line config without the
    // environment variable ...
    const plainEnv = Object.fromEntries(Object.entries(buildDaemonEnv(process.env as Record<string, string | undefined>, [])).filter(([k]) => k.toUpperCase() !== 'GIT_NO_LAZY_FETCH'));
    const configOnly = createVizGit({ runner: createGitRunner({ clock: realClock, hooksPath: join(dataDir, 'viz-no-hooks'), daemonEnv: plainEnv, gitPath: absoluteGit() }), gitDir, dataDir });
    assert.deepEqual(await readLiveCommits(configOnly, [c]), { reads: [{ oid: c, malformed: 'missing' }], next: 1 });
    assert.ok(await absent(), 'VIZ_GIT_CONFIG alone: the viewer fetched C');
    // ... and vizGitRunner's environment without the config (git reads GIT_NO_LAZY_FETCH from 2.44 on).
    const v = parseGitVersion((await testRunner().run(['version'], { class: 'local', cwd: root })).stdout.toString('utf8'));
    if (v.major > 2 || (v.major === 2 && v.minor >= 44)) {
      const envOnly = await vizGitRunner({ clock: realClock, dataDir, env: plainEnv, gitPath: absoluteGit() })
        .run(['cat-file', '--batch-check'], { class: 'local', cwd: dataDir, gitDir, stdin: Buffer.from(`${c}\n`) });
      assert.equal(envOnly.stdout.toString('utf8'), `${c} missing\n`);
      assert.ok(await absent(), 'GIT_NO_LAZY_FETCH alone: the viewer fetched C');
    }

    // Negative control: the same --batch-check without VIZ_GIT_CONFIG and VIZ_GIT_ENV lazily fetches C.
    const control = await testRunner().run(['cat-file', '--batch-check'], { class: 'local', cwd: dataDir, gitDir, stdin: Buffer.from(`${c}\n`) });
    assert.equal(control.code, 0, control.stderr.toString('utf8'));
    assert.match(control.stdout.toString('utf8'), new RegExp(`^${c} commit \\d+\\n$`));
    assert.equal(await absent(), false, 'the fixture would really lazy-fetch');
  } finally {
    await cleanup();
  }
});
