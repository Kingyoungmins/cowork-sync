// Which programs the CLI may run (Task 11): the git it passes to the viewer and the PATH entries it keeps, compared by realpath against
// the cwd's repository root and every --repo worktree (R-V13, R-V39; 12 §3.10.8; INV-NOEXEC, SEC-30; Review Focus 5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, sep } from 'node:path';
import { realFs, type Fs } from '../../../src/ports/fs.js';
import { realOwnerProbe } from '../../../src/viz/cli/ownerProbe.js';
import { planOpener } from '../../../src/viz/cli/opener.js';
import { excludedRoots, filterPath, resolveGitPath, trustedExe, withTrustCache } from '../../../src/viz/cli/pathTrust.js';
import { runView } from '../../../src/viz/cli/view.js';
import { makeTempRoot } from '../../helpers/tmp.js';
import {
  assertAllRendered, assertNoneStartedFrom, fakePluginRoot, FAKE_EUID, findSystemGit, hostFs, passingProbe, programsStartedBy, recordingEnv,
} from '../../helpers/vizCli.js';

const WIN = process.platform === 'win32';
const GIT = WIN ? 'git.exe' : 'git';
const euid = process.geteuid?.() ?? null;
const opts = { fs: hostFs, probe: realOwnerProbe, platform: process.platform, euid };

/** A teammate-synced program: on POSIX an executable script that leaves a marker when run; on Windows bytes that are no program. */
function plant(dir: string, name: string, marker: string): void {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  if (WIN) {
    writeFileSync(p, Buffer.from('MZ planted, never a program'));
  } else {
    writeFileSync(p, `#!/bin/sh\necho ran > "${marker}"\n`);
    chmodSync(p, 0o755);
  }
}

/** A directory symlink (a junction on Windows, which needs no privilege). */
function linkDir(target: string, link: string): void {
  symlinkSync(target, link, WIN ? 'junction' : 'dir');
}

test('T-VIZ-handshake: resolveGitPath never executes a repository-controlled git', async () => {
  const git = findSystemGit();
  assert.ok(git !== null, 'a git on PATH');
  const t = await makeTempRoot('viz-git');
  const before = process.cwd();
  try {
    const marker = join(t.root, 'ran.txt');
    const cwdRepo = join(t.root, 'cwd repo');
    mkdirSync(join(cwdRepo, '.git'), { recursive: true });
    mkdirSync(join(cwdRepo, 'src', 'deep'), { recursive: true });
    plant(join(cwdRepo, 'bin'), GIT, marker);
    plant(cwdRepo, GIT, marker);
    const worktree = join(t.root, 'worktree');
    mkdirSync(worktree);
    writeFileSync(join(worktree, '.git'), 'gitdir: elsewhere\n');   // a linked worktree's .git file
    plant(join(worktree, 'bin'), GIT, marker);
    process.chdir(cwdRepo);

    const cwd = join(cwdRepo, 'src', 'deep');
    const { started } = await programsStartedBy(async () => {
      const excluded = await excludedRoots(cwd, [worktree, join(t.root, 'missing repo')], hostFs, process.platform);
      assert.deepEqual(excluded, [realpathSync(cwdRepo), realpathSync(worktree)]);
      const PATH = ['', join(cwdRepo, 'bin'), join(worktree, 'bin'), '.', dirname(git)].join(delimiter);
      assert.equal(await resolveGitPath({ PATH }, excluded, opts), git);
      // A Path-only environment (the Windows spelling) resolves too.
      if (WIN) assert.equal(await resolveGitPath({ Path: PATH }, excluded, opts), git);
      // Without an exclusion the planted git would be chosen (user-owned, 0755): the roots are what keeps it out.
      assert.equal(await resolveGitPath({ PATH: join(cwdRepo, 'bin') }, [], opts), realpathSync(join(cwdRepo, 'bin', GIT)));
      assert.equal(await resolveGitPath({ PATH: [join(cwdRepo, 'bin'), join(worktree, 'bin')].join(delimiter) }, excluded, opts), null);

      // A symlinked system git (Homebrew-style /opt/homebrew/bin/git) is accepted and its realpath passed.
      const brew = join(t.root, 'opt', 'homebrew', 'bin');
      mkdirSync(brew, { recursive: true });
      let symlinked = true;
      try {
        symlinkSync(git, join(brew, GIT), 'file');
      } catch (e) {
        if (!WIN || (e as NodeJS.ErrnoException).code !== 'EPERM') throw e;
        symlinked = false;   // Windows without the symlink privilege: a directory junction to git's folder instead
        linkDir(dirname(git), join(t.root, 'opt', 'homebrew', 'gitdir'));
      }
      const brewPath = symlinked ? brew : join(t.root, 'opt', 'homebrew', 'gitdir');
      assert.equal(await resolveGitPath({ PATH: brewPath }, excluded, opts), git);

      // POSIX: a group-writable git first on PATH is skipped.
      if (!WIN) {
        const gw = join(t.root, 'gw bin');
        mkdirSync(gw);
        copyFileSync(git, join(gw, 'git'));
        chmodSync(join(gw, 'git'), 0o775);
        assert.equal(await trustedExe(join(gw, 'git'), excluded, opts), null);
        assert.equal(await resolveGitPath({ PATH: [gw, dirname(git)].join(delimiter) }, excluded, opts), git);
        chmodSync(join(gw, 'git'), 0o757);
        assert.equal(await trustedExe(join(gw, 'git'), excluded, opts), null);
      }

      // Through runView: the viewer gets --git = the system git's realpath; no git anywhere → START_TOOL_VERSION and nothing spawned.
      const { pluginRoot } = fakePluginRoot(t.root);
      const data = join(t.root, 'data');
      const real = { uid: euid, ownerProbe: realOwnerProbe };
      const ok = recordingEnv({ pluginRoot, cwd, home: t.root, env: { CLAUDE_PLUGIN_DATA: data, PATH }, ...real });
      assert.equal(await runView(['--no-open', '--repo', worktree], ok.env), 0, ok.errs.join('\n'));
      assert.equal(ok.spawned[0]?.git, git);
      assert.deepEqual(ok.spawned[0]?.repos, [worktree]);
      assert.deepEqual(assertAllRendered(ok, { channel: 'terminal', lang: 'en', cmd: null }), ['UI_VIZ_URL']);
      const none = recordingEnv({ pluginRoot, cwd, home: t.root, env: { CLAUDE_PLUGIN_DATA: data, PATH: ['', join(cwdRepo, 'bin'), join(worktree, 'bin')].join(delimiter) }, ...real });
      assert.equal(await runView(['--repo', worktree], none.env), 1);
      assert.deepEqual(assertAllRendered(none, { channel: 'terminal', lang: 'en', cmd: null }), ['START_TOOL_VERSION']);
      assert.deepEqual(none.spawned, []);
    });
    // No planted git ran on any code path above (a regression that tried each PATH candidate, `git --version` say, would run one): the
    // spawn spy fails on every OS; on POSIX, where the plants are scripts, the marker says the same.
    assertNoneStartedFrom(started, [t.root]);
    if (!WIN) assert.equal(existsSync(marker), false, 'a planted git ran');
  } finally {
    process.chdir(before);
    await t.cleanup();
  }
});

test('filterPath compares realpaths', async () => {
  const t = await makeTempRoot('viz-filter');
  try {
    const marker = join(t.root, 'ran.txt');
    const repo = join(t.root, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'x'));
    plant(join(repo, 'bin'), WIN ? 'xdg-open.exe' : 'xdg-open', marker);
    plant(join(repo, 'bin'), GIT, marker);
    const alias = join(t.root, 'alias of repo');
    linkDir(repo, alias);
    const good = join(t.root, 'good bin');
    mkdirSync(good);
    plant(good, GIT, marker);
    const excluded = await excludedRoots(repo, [], hostFs, process.platform);
    assert.deepEqual(excluded, [realpathSync(repo)]);

    const entries = [
      `${repo}${sep}${sep}bin`, `${repo}${sep}x${sep}..${sep}bin`, join(alias, 'bin'), `${alias}${sep}`, repo, join(t.root, 'missing'), good,
      WIN ? join(repo.toUpperCase(), 'BIN') : join(repo, 'bin'),
    ];
    const { started } = await programsStartedBy(async () => {
      const kept = await filterPath({ PATH: entries.join(delimiter) }, excluded, process.platform, hostFs);
      assert.deepEqual(kept, [good]);
      for (const e of entries.slice(0, 5)) {
        assert.equal(await trustedExe(join(e, GIT), excluded, opts), null, e);
      }
      // The git that would run is the one in good/: every alias of the repository's bin/ comes first on this PATH and none is chosen.
      assert.equal(await resolveGitPath({ PATH: entries.join(delimiter) }, excluded, opts), realpathSync(join(good, GIT)));
    });
    // Nothing planted ran while the entries and candidates were judged: the spawn spy on every OS, the marker on POSIX.
    assertNoneStartedFrom(started, [t.root]);
    if (!WIN) assert.equal(existsSync(marker), false, 'a planted program ran');
    // An entry whose realpath fails is dropped even with nothing excluded.
    const failing: Fs = { ...hostFs, realpath: (p: string) => (p === good ? Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' })) : hostFs.realpath(p)) };
    assert.deepEqual(await filterPath({ PATH: [good, repo].join(delimiter) }, [], process.platform, failing), [repo]);
    // The first PATH key in any case is read; empty, '.' and relative entries are dropped.
    assert.deepEqual(await filterPath({ pAtH: ['', '.', 'relative', `.${sep}bin`, good].join(delimiter) }, [], process.platform, hostFs), [good]);
    assert.deepEqual(await filterPath({}, [], process.platform, hostFs), []);
  } finally {
    await t.cleanup();
  }
});

test('excludedRoots walks every .git ancestor of the cwd: a checkout nested in another excludes both', async () => {
  const t = await makeTempRoot('viz-nested');
  try {
    // outer/ is a checkout; outer/vendor/inner/ a nested one (a linked worktree's .git file); the CLI runs in outer/vendor/inner/src.
    const outer = join(t.root, 'outer');
    mkdirSync(join(outer, '.git'), { recursive: true });
    const inner = join(outer, 'vendor', 'inner');
    mkdirSync(join(inner, 'src'), { recursive: true });
    writeFileSync(join(inner, '.git'), 'gitdir: elsewhere\n');
    const other = join(t.root, 'other');
    mkdirSync(join(other, '.git'), { recursive: true });
    const excluded = await excludedRoots(join(inner, 'src'), [other], hostFs, process.platform);
    assert.deepEqual(excluded, [realpathSync(inner), realpathSync(outer), realpathSync(other)]);
    // The outer checkout's bin/ is dropped from PATH too.
    mkdirSync(join(outer, 'bin'));
    const good = join(t.root, 'good');
    mkdirSync(good);
    assert.deepEqual(await filterPath({ PATH: [join(outer, 'bin'), good].join(delimiter) }, excluded, process.platform, hostFs), [good]);
  } finally {
    await t.cleanup();
  }
});

test('R-V68: the .git ancestor walk stops below the home directory: a dotfiles checkout at ~ keeps the tools under ~ trusted, while the cwd\'s nested checkout and each --repo root stay excluded', async () => {
  const t = await makeTempRoot('viz-home');
  try {
    // A real-Fs fixture (no hidden .git): ~ is a checkout (dotfiles), and so is an ancestor of ~; git lives in ~/.local/bin; the CLI runs
    // inside a checkout nested below ~, whose bin/ also holds a git.
    mkdirSync(join(t.root, '.git'), { recursive: true });
    const home = join(t.root, 'home');
    mkdirSync(join(home, '.git'), { recursive: true });
    const tools = join(home, '.local', 'bin');
    plant(tools, GIT, join(t.root, 'ran.txt'));
    const nested = join(home, 'work', 'nested');
    mkdirSync(join(nested, '.git'), { recursive: true });
    mkdirSync(join(nested, 'src'), { recursive: true });
    plant(join(nested, 'bin'), GIT, join(t.root, 'ran.txt'));
    const cwd = join(nested, 'src');
    const real = { fs: realFs, probe: realOwnerProbe, platform: process.platform, euid };

    const excluded = await excludedRoots(cwd, [], realFs, process.platform, home);
    assert.deepEqual(excluded, [realpathSync(nested)]);
    const PATH = ['', join(nested, 'bin'), tools].join(delimiter);
    assert.deepEqual(await filterPath({ PATH }, excluded, process.platform, realFs), [tools]);
    assert.equal(await resolveGitPath({ PATH }, excluded, real), realpathSync(join(tools, GIT)));
    // ~ itself, a folder of ~ outside any nested checkout, and an ancestor of ~: nothing excluded by the walk.
    mkdirSync(join(home, 'notes'));
    for (const at of [home, join(home, 'notes'), t.root]) assert.deepEqual(await excludedRoots(at, [], realFs, process.platform, home), [], at);
    // An explicit --repo root is excluded even when it is ~.
    assert.deepEqual(await excludedRoots(cwd, [home], realFs, process.platform, home), [realpathSync(nested), realpathSync(home)]);
    // Without the home directory the walk reaches ~ and its ancestors (the round-1 behaviour that refused every tool under ~).
    assert.ok((await excludedRoots(cwd, [], realFs, process.platform)).includes(realpathSync(home)));
    // A symlinked home (HOME=/home/me, a link to /data/me, while the cwd is the physical path): ~ is also compared by its realpath.
    const links: Record<string, string> = { '/home/me': '/data/me', '/data/me': '/data/me', '/data/me/proj': '/data/me/proj', '/data': '/data', '/': '/' };
    const gits = new Set(['/data/me/proj/.git', '/data/me/.git', '/data/.git', '/.git']);
    const linkFs: Fs = {
      ...realFs,
      realpath: async (p: string) => links[p] ?? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
      lstat: async (p: string) => (gits.has(p) ? { size: 0, mtimeNs: 0n, ino: 0n, dev: 0n, mode: 0o40755, isFile: false, isDirectory: true, isSymbolicLink: false } : null),
    };
    assert.deepEqual(await excludedRoots('/data/me/proj/src', [], linkFs, 'linux', '/home/me'), ['/data/me/proj']);
    assert.deepEqual(await excludedRoots('/data/me/proj/src', [], linkFs, 'linux'), ['/data/me/proj', '/data/me', '/data', '/']);

    // Through runView (home = the fake ~): the viewer gets ~/.local/bin's git; the opener plans over the same exclusions.
    const { pluginRoot } = fakePluginRoot(t.root);
    const wt = join(home, 'work', 'wt');
    mkdirSync(join(wt, '.git'), { recursive: true });
    const env: Record<string, string> = { CLAUDE_PLUGIN_DATA: join(t.root, 'data'), PATH };
    if (WIN) env.SystemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const rec = recordingEnv({ pluginRoot, cwd, home, env, fs: realFs, uid: euid, ownerProbe: realOwnerProbe }, undefined, false);
    assert.equal(await runView(['--repo', wt], rec.env), 0, rec.errs.join('\n'));
    assert.equal(rec.spawned[0]?.git, realpathSync(join(tools, GIT)));
    assert.equal(rec.opened[0]?.ctx.home, home);
    assert.deepEqual(await excludedRoots(cwd, [wt], realFs, process.platform, rec.opened[0]?.ctx.home), [realpathSync(nested), realpathSync(wt)]);
    assert.deepEqual(assertAllRendered(rec, { channel: 'terminal', lang: 'en', cmd: null }), ['UI_VIZ_URL']);
  } finally {
    await t.cleanup();
  }
});

/** An Fs that is a class instance: its methods live on the prototype and use a private field (as a SIM fault Fs or a wrapper may). */
class ClassFs implements Fs {
  readonly #inner: Fs;
  realpathCalls = 0;
  constructor(inner: Fs) { this.#inner = inner; }
  readFile(p: string): Promise<Buffer> { return this.#inner.readFile(p); }
  writeFile(p: string, d: Buffer): Promise<void> { return this.#inner.writeFile(p, d); }
  rename(a: string, b: string): Promise<void> { return this.#inner.rename(a, b); }
  link(a: string, b: string): Promise<void> { return this.#inner.link(a, b); }
  unlink(p: string): Promise<void> { return this.#inner.unlink(p); }
  chmod(p: string, mode: number): Promise<void> { return this.#inner.chmod(p, mode); }
  stat(p: string): ReturnType<Fs['stat']> { return this.#inner.stat(p); }
  mkdirp(p: string, mode?: number): Promise<void> { return this.#inner.mkdirp(p, mode); }
  readdir(p: string): Promise<string[]> { return this.#inner.readdir(p); }
  rmrf(p: string): Promise<void> { return this.#inner.rmrf(p); }
  lstat(p: string): ReturnType<Fs['lstat']> { return this.#inner.lstat(p); }
  writeFileExclusive(p: string, d: Buffer): Promise<void> { return this.#inner.writeFileExclusive(p, d); }
  rmdir(p: string): Promise<void> { return this.#inner.rmdir(p); }
  appendFile(p: string, d: Buffer): Promise<void> { return this.#inner.appendFile(p, d); }
  realpath(p: string): Promise<string> { this.realpathCalls += 1; return this.#inner.realpath(p); }
  freeBytes(p: string): Promise<number | null> { return this.#inner.freeBytes(p); }
}

test('withTrustCache wraps an Fs by delegation: a class instance keeps its prototype methods and private fields, and the cache still applies', async () => {
  const t = await makeTempRoot('viz-classfs');
  try {
    const repo = join(t.root, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const good = join(t.root, 'good');
    mkdirSync(good);
    const inner = new ClassFs(hostFs);
    const fs = withTrustCache(inner);
    const excluded = await excludedRoots(repo, [], fs, process.platform, t.root);
    assert.deepEqual(excluded, [realpathSync(repo)]);
    const PATH = [join(repo, 'bin'), good].join(delimiter);
    assert.deepEqual(await filterPath({ PATH }, excluded, process.platform, fs), [good]);
    const calls = inner.realpathCalls;
    assert.deepEqual(await filterPath({ PATH }, excluded, process.platform, fs), [good]);
    assert.deepEqual(await excludedRoots(repo, [], fs, process.platform, t.root), excluded);
    assert.equal(inner.realpathCalls, calls, 'the second reading came from the cache');
    // Every Fs method reaches the instance.
    assert.equal((await fs.stat(good))?.isDirectory, true);
    assert.deepEqual(await fs.readdir(t.root), await hostFs.readdir(t.root));
  } finally {
    await t.cleanup();
  }
});

/** A table Fs: realpath is the identity for the listed paths (ENOENT otherwise), and lstat says regular file for them. */
function identityFs(paths: readonly string[]): Fs {
  const enoent = (): never => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  const file = { size: 1, mtimeNs: 0n, ino: 0n, dev: 0n, mode: 0o100755, isFile: true, isDirectory: false, isSymbolicLink: false };
  return {
    ...hostFs,
    realpath: async (p: string) => (paths.includes(p) ? p : enoent()),
    lstat: async (p: string) => (paths.includes(p) ? file : null),
  };
}

test('the view helpers answer for files as the OS does: passingProbe reports a file\'s own lstat (so POSIX trustedExe judges the real git: root-owned on Linux, the runner user\'s Homebrew git on macOS) and keeps its owner-only answer for directories; recordingEnv\'s default uid is this process\'s euid', async () => {
  const t = await makeTempRoot('viz-helper-probe');
  try {
    const file = join(t.root, 'tool');
    writeFileSync(file, '#!/bin/sh\n');
    const dir = join(t.root, 'data');
    mkdirSync(dir);
    const real = await realOwnerProbe.posix(file);
    assert.ok(real !== null && !real.isDir, 'the OS lstats the file as a file');
    assert.deepEqual(await passingProbe.posix(file), real);
    assert.deepEqual(await passingProbe.posix(dir), { uid: FAKE_EUID, mode: 0o40700, isDir: true, isSymlink: false });
    assert.deepEqual(await passingProbe.posix(join(t.root, 'missing')), { uid: FAKE_EUID, mode: 0o40700, isDir: true, isSymlink: false });
    assert.equal(passingProbe.euid(), FAKE_EUID, 'the data directory check still compares the fake owner with the fake euid');
    const rec = recordingEnv({ pluginRoot: t.root, cwd: t.root, home: t.root, env: {} });
    assert.equal(rec.env.uid, typeof process.geteuid === 'function' ? process.geteuid() : null);
  } finally {
    await t.cleanup();
  }
});

test('filterPath and trustedExe compare realpaths case-insensitively on win32 and darwin, and exactly on Linux', async () => {
  const win = identityFs(['C:\\Repo\\BIN', 'C:\\other', 'C:\\Repo2\\bin', 'C:\\Repo\\BIN\\git.exe', 'C:\\other\\git.exe']);
  assert.deepEqual(await filterPath({ Path: 'C:\\Repo\\BIN;C:\\other;C:\\Repo2\\bin' }, ['c:\\repo'], 'win32', win), ['C:\\other', 'C:\\Repo2\\bin']);
  const posixPaths = ['/Repo/bin', '/other', '/repo/bin', '/Repo/bin/git', '/other/git'];
  const posixFs = identityFs(posixPaths);
  assert.deepEqual(await filterPath({ PATH: '/Repo/bin:/other:/repo/bin' }, ['/repo'], 'darwin', posixFs), ['/other']);
  assert.deepEqual(await filterPath({ PATH: '/Repo/bin:/other:/repo/bin' }, ['/repo'], 'linux', posixFs), ['/Repo/bin', '/other']);
  // trustedExe: a candidate whose realpath differs from a root only in case lies inside it on win32 and darwin, not on Linux.
  const rootOwned = { posix: async () => ({ uid: 0, mode: 0o100755, isDir: false, isSymlink: false }), euid: () => 0, windows: async () => null };
  const o = (fs: Fs, platform: NodeJS.Platform) => ({ fs, probe: rootOwned, platform, euid: 0 });
  assert.equal(await trustedExe('C:\\Repo\\BIN\\git.exe', ['c:\\repo'], o(win, 'win32')), null);
  assert.equal(await trustedExe('C:\\other\\git.exe', ['c:\\repo'], o(win, 'win32')), 'C:\\other\\git.exe');
  assert.equal(await trustedExe('/Repo/bin/git', ['/repo'], o(posixFs, 'darwin')), null);
  assert.equal(await trustedExe('/Repo/bin/git', ['/repo'], o(posixFs, 'linux')), '/Repo/bin/git');
});

test('one view call reads the PATH and the repository roots once: excludedRoots and filterPath are cached per runView, the opener included', async () => {
  const git = findSystemGit();
  assert.ok(git !== null, 'a git on PATH');
  const t = await makeTempRoot('viz-cache');
  try {
    const cwd = join(t.root, 'cwd repo');
    mkdirSync(join(cwd, '.git'), { recursive: true });
    const worktree = join(t.root, 'worktree');
    mkdirSync(join(worktree, '.git'), { recursive: true });
    const good = join(t.root, 'good bin');
    mkdirSync(good);
    const realpaths = new Map<string, number>();
    const gitLookups = new Map<string, number>();
    const bump = (m: Map<string, number>, p: string): void => { m.set(p, (m.get(p) ?? 0) + 1); };
    const fs: Fs = {
      ...hostFs,
      realpath: (p: string) => { bump(realpaths, p); return hostFs.realpath(p); },
      lstat: (p: string) => { if (/[\\/]\.git$/.test(p)) bump(gitLookups, p); return hostFs.lstat(p); },
    };
    const { pluginRoot } = fakePluginRoot(t.root);
    const env: Record<string, string> = { CLAUDE_PLUGIN_DATA: join(t.root, 'data'), PATH: [good, dirname(git)].join(delimiter), DISPLAY: ':0' };
    if (WIN) env.SystemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    let planned = 0;
    const rec = recordingEnv({
      pluginRoot, cwd, home: t.root, env, fs, uid: euid,
      openUrl: async (url, ctx) => { planned += 1; await planOpener(url, ctx); return false; },
    });
    assert.equal(await runView(['--repo', worktree], rec.env), 0, rec.errs.join('\n'));
    assert.equal(planned, 1, 'the opener planned through the same view call');
    for (const entry of [good, dirname(git)]) assert.equal(realpaths.get(entry), 1, `PATH entry ${entry} realpath'ed ${realpaths.get(entry)} times`);
    for (const [p, n] of realpaths) assert.equal(n, 1, `${p} realpath'ed ${n} times`);
    for (const [p, n] of gitLookups) assert.equal(n, 1, `${p} looked up ${n} times`);
    assert.ok(gitLookups.size > 0);
  } finally {
    await t.cleanup();
  }
});
