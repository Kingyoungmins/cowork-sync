// The browser opener (Task 11): an absolute executable per OS, the URL re-checked before the spawn, the Linux PATH filter with the
// owner/mode checks, and the opener child's cwd and environment (12 §3.10.8, VIZ-05, R-V39, INV-NOEXEC).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import type { Fs } from '../../../src/ports/fs.js';
import { openUrl, openUrlWith, planOpener, type OpenerCtx, type OpenerSpawn } from '../../../src/viz/cli/opener.js';
import { realOwnerProbe, type OwnerProbe } from '../../../src/viz/cli/ownerProbe.js';
import { makeTempRoot } from '../../helpers/tmp.js';
import { hostFs, programsStartedBy } from '../../helpers/vizCli.js';

const HEX = 'c0ffee00'.repeat(8);
const URL_OK = `http://127.0.0.1:43210/#k=${HEX}`;
const FUZZ = [
  `http://127.0.0.1:43210/#k=${HEX} x`, `http://127.0.0.1:43210/#k=${HEX}"`, `http://127.0.0.1:43210/#k=${HEX}'`, `http://127.0.0.1:43210/#k=${HEX}&calc`,
  `http://127.0.0.1:43210/#k=${HEX}%20`, `http://127.0.0.1:43210/#k=${HEX}^`, `http://127.0.0.1:43210/#k=${HEX}\n`, `\nhttp://127.0.0.1:43210/#k=${HEX}`,
  '--flag', `--user-data-dir=x http://127.0.0.1:43210/#k=${HEX}`, `file:///C:/x#k=${HEX}`, 'file:///etc/passwd', `http://evil.test:43210/#k=${HEX}`,
  `http://127.0.0.2:43210/#k=${HEX}`, `http://127.0.0.1:43210/#k=${HEX.slice(1)}`, `http://127.0.0.1:43210/#k=${HEX.toUpperCase()}`,
  `http://127.0.0.1:0/#k=${HEX}`, `"http://127.0.0.1:43210/#k=${HEX}"`, `http://127.0.0.1:43210/x/../#k=${HEX}`, '',
];
const FIXED = ['/usr/bin/xdg-open', '/usr/local/bin/xdg-open', '/bin/xdg-open', '/usr/bin/gio'];

/** Real Fs whose realpath and lstat fail for the given paths (the fixed Linux candidates of this host stay out of the test). */
function hidingFs(hidden: readonly string[]): Fs {
  const enoent = (): never => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  return {
    ...hostFs,
    realpath: (p: string) => (hidden.includes(p) ? Promise.resolve().then(enoent) : hostFs.realpath(p)),
    lstat: (p: string) => (hidden.includes(p) ? Promise.resolve(null) : hostFs.lstat(p)),
    stat: (p: string) => (hidden.includes(p) ? Promise.resolve(null) : hostFs.stat(p)),
  };
}

interface Harness { ctx: OpenerCtx; record: string; markers: string[]; cleanup(): Promise<void>; }

/**
 * Windows: a fake SystemRoot whose explorer.exe is a copy of node.exe that records (cwd, argv, env) through a --require preload and exits 1.
 * The CLI's cwd is a repository holding a teammate-synced explorer.exe (no program), also on Path after an empty entry.
 */
async function windowsHarness(): Promise<Harness> {
  const t = await makeTempRoot('viz-opener-win');
  const sysRoot = join(t.root, 'sys root');
  mkdirSync(sysRoot, { recursive: true });
  copyFileSync(process.execPath, join(sysRoot, 'explorer.exe'));
  const recorder = join(t.root, 'recorder.cjs');
  writeFileSync(recorder, [
    "const fs = require('fs');",
    'fs.writeFileSync(process.env.COWORK_OPENER_RECORD, JSON.stringify({ cwd: process.cwd(), argv: process.argv, execPath: process.execPath, env: process.env }));',
    'process.exit(1);',
    '',
  ].join('\n'));
  const dataDir = join(t.root, 'data dir');
  mkdirSync(dataDir);
  // The CLI's cwd is a repository of its own, so no repository an ancestor of the temp folder may be decides the test.
  const cwd = join(t.root, 'cwd');
  mkdirSync(join(cwd, '.git'), { recursive: true });
  writeFileSync(join(cwd, 'explorer.exe'), Buffer.from('MZ planted, never a program'));
  const record = join(t.root, 'record.json');
  const realSysRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const ctx: OpenerCtx = {
    platform: 'win32', env: { SystemRoot: sysRoot, Path: `;${cwd}` }, dataDir, cwd, repos: [], fs: hostFs, uid: null, ownerProbe: realOwnerProbe,
    builderEnv: { SystemRoot: realSysRoot, NODE_OPTIONS: `--require "${recorder.split('\\').join('/')}"`, COWORK_OPENER_RECORD: record },
  };
  return { ctx, record, markers: [], cleanup: t.cleanup };
}

/** POSIX (as platform 'linux'): the fixed candidates hidden, PATH = '' + a planted <repo>/bin + a group-writable dir + a good dir. */
async function linuxHarness(display = true): Promise<Harness & { repo: string; gw: string; good: string }> {
  const t = await makeTempRoot('viz-opener-linux');
  const repo = join(t.root, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  const script = (dir: string, marker: string, mode: number): void => {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'xdg-open');
    writeFileSync(p, `#!/bin/sh\n{ printf 'cwd=%s\\n' "$(pwd -P)"; for a in "$@"; do printf 'arg=%s\\n' "$a"; done; printf 'PATH=%s\\n' "$PATH"; } > "${marker}"\n`);
    chmodSync(p, mode);
  };
  const planted = join(t.root, 'planted.txt');
  const gwMarker = join(t.root, 'gw.txt');
  const record = join(t.root, 'record.txt');
  const gw = join(t.root, 'gw bin');
  const good = join(t.root, 'good bin');
  script(join(repo, 'bin'), planted, 0o755);
  script(gw, gwMarker, 0o775);
  script(good, record, 0o755);
  const dataDir = join(t.root, 'data dir');
  mkdirSync(dataDir);
  const env: Record<string, string> = { PATH: ['', join(repo, 'bin'), gw, good, '.', 'relative/bin'].join(':') };
  if (display) { env.DISPLAY = ':0'; env.XAUTHORITY = join(t.root, 'xauth'); }
  const ctx: OpenerCtx = {
    platform: 'linux', env, builderEnv: { HOME: t.root, LC_ALL: 'C', PATH: '/should/be/replaced' }, dataDir, cwd: repo, repos: [],
    fs: hidingFs(FIXED), uid: process.geteuid?.() ?? null, ownerProbe: realOwnerProbe,
  };
  return { ctx, record, markers: [planted, gwMarker], cleanup: t.cleanup, repo, gw, good };
}

const harness = (): Promise<Harness> => (process.platform === 'win32' ? windowsHarness() : linuxHarness());

test('T-VIZ-opener: URL fuzz (spaces, quotes, &, %, ^, newline, --flag, file:, another host, a 63-hex token) is never spawned; a valid URL spawns an absolute executable with an argv array, shell false and cwd = the data directory', async () => {
  const h = await harness();
  try {
    const plan = await planOpener(URL_OK, h.ctx);
    assert.ok(plan !== null);
    assert.ok(process.platform === 'win32' ? win32.isAbsolute(plan.exe) : posix.isAbsolute(plan.exe), plan.exe);
    assert.deepEqual(plan.argv, [URL_OK]);
    // Every program this process starts while the fuzz is refused and the valid URL is opened: exactly the planned one, once (never a
    // program planted in the cwd's repository, which a marker would show on POSIX only).
    const { started } = await programsStartedBy(async () => {
      for (const bad of FUZZ) {
        assert.equal(await planOpener(bad, h.ctx), null, JSON.stringify(bad));
        assert.equal(await openUrl(bad, h.ctx), false, JSON.stringify(bad));
        assert.equal(existsSync(h.record), false, `spawned for ${JSON.stringify(bad)}`);
      }
      assert.equal(await openUrl(URL_OK, h.ctx), true);
    });
    assert.deepEqual(started, [plan.exe]);
    if (process.platform === 'win32') {
      const r = JSON.parse(readFileSync(h.record, 'utf8')) as { cwd: string; argv: string[]; execPath: string; env: Record<string, string> };
      assert.equal(r.execPath, plan.exe);
      assert.equal(realpathSync(r.cwd), realpathSync(h.ctx.dataDir));
      // node resolves its first argument against its cwd: the single argument was the URL, unsplit and unquoted (no shell).
      assert.deepEqual(r.argv.slice(1), [win32.resolve(h.ctx.dataDir, URL_OK)]);
    } else {
      const lines = readFileSync(h.record, 'utf8').split('\n');
      assert.equal(lines[0], `cwd=${realpathSync(h.ctx.dataDir)}`);
      assert.deepEqual(lines.filter((l) => l.startsWith('arg=')), [`arg=${URL_OK}`]);
      for (const m of h.markers) assert.equal(existsSync(m), false, m);
    }
  } finally {
    await h.cleanup();
  }
});

test('T-VIZ-opener (Windows): explorer.exe from an absolute SystemRoot; a planted explorer.exe in a repository directory never runs; exit 1 is success',
  { skip: process.platform !== 'win32' ? 'Windows legs only' : false }, async () => {
    // The real SystemRoot: <SystemRoot>\explorer.exe by absolute path (planned, not spawned: no browser opens during the test).
    const realSysRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const real = await planOpener(URL_OK, {
      platform: 'win32', env: { SystemRoot: realSysRoot }, builderEnv: {}, dataDir: realSysRoot, cwd: realSysRoot, repos: [], fs: hostFs, uid: null,
      ownerProbe: realOwnerProbe,
    });
    assert.ok(real !== null);
    assert.equal(real.exe.toLowerCase(), win32.join(realSysRoot, 'explorer.exe').toLowerCase());
    assert.deepEqual(real.argv, [URL_OK]);

    const h = await windowsHarness();
    const before = process.cwd();
    try {
      // A teammate-synced explorer.exe (not a program at all) in the repository the CLI runs from, and as the SystemRoot.
      const repo = join(h.ctx.cwd, 'repo');
      mkdirSync(join(repo, '.git'), { recursive: true });
      writeFileSync(join(repo, 'explorer.exe'), Buffer.from('MZ planted, never a program'));
      process.chdir(repo);
      const ctx: OpenerCtx = { ...h.ctx, cwd: repo, env: { ...h.ctx.env, Path: `;${repo}` } };
      for (const sr of ['', 'relative\\root', '\\\\server\\share', 'C:', join(h.ctx.cwd, 'missing'), repo]) {
        assert.equal(await planOpener(URL_OK, { ...ctx, env: { SystemRoot: sr } }), null, sr);
      }
      assert.equal(await planOpener(URL_OK, { ...ctx, env: {} }), null);
      // The fake SystemRoot's explorer.exe exits 1 after recording: still success, and it is the one that ran.
      assert.equal(await openUrl(URL_OK, ctx), true);
      const r = JSON.parse(readFileSync(h.record, 'utf8')) as { execPath: string; env: Record<string, string> };
      assert.equal(r.execPath, win32.join(h.ctx.env.SystemRoot as string, 'explorer.exe'));
    } finally {
      process.chdir(before);
      await h.cleanup();
    }
  });

test('T-VIZ-opener (Linux): an executable xdg-open planted in <cwd repo>/bin first on PATH with an empty entry is never executed; a group-writable candidate is skipped; the child\'s PATH holds only filtered entries; without DISPLAY and WAYLAND_DISPLAY the open fails',
  { skip: process.platform === 'win32' ? 'POSIX legs only' : false }, async () => {
    const h = await linuxHarness();
    const before = process.cwd();
    try {
      process.chdir(h.repo);
      const plan = await planOpener(URL_OK, h.ctx);
      assert.ok(plan !== null);
      assert.equal(plan.exe, realpathSync(join(h.good, 'xdg-open')));
      assert.deepEqual(plan.argv, [URL_OK]);
      assert.equal(plan.env.PATH, `${h.gw}:${h.good}`);
      assert.equal(plan.env.DISPLAY, ':0');
      assert.equal(plan.env.XAUTHORITY, h.ctx.env.XAUTHORITY);
      assert.equal(plan.env.HOME, h.ctx.builderEnv.HOME);
      // The program started is exactly the planned one, with the planned argv (the script records it), never a plant.
      const opened = await programsStartedBy(() => openUrl(URL_OK, h.ctx));
      assert.equal(opened.result, true);
      assert.deepEqual(opened.started, [plan.exe]);
      const lines = readFileSync(h.record, 'utf8').split('\n');
      assert.deepEqual(lines.filter((l) => l.startsWith('arg=')), plan.argv.map((a) => `arg=${a}`));
      assert.ok(lines.includes(`PATH=${h.gw}:${h.good}`), lines.join('\n'));
      for (const m of h.markers) assert.equal(existsSync(m), false, m);

      // Without a display: no opener, nothing spawned; WAYLAND_DISPLAY alone is a display.
      const noDisplay = { ...h.ctx, env: { PATH: h.ctx.env.PATH } };
      assert.equal(await planOpener(URL_OK, noDisplay), null);
      writeFileSync(h.record, '');
      const blank = await programsStartedBy(() => openUrl(URL_OK, { ...noDisplay, env: { ...noDisplay.env, DISPLAY: '' } }));
      assert.equal(blank.result, false);
      assert.deepEqual(blank.started, []);
      assert.equal(readFileSync(h.record, 'utf8'), '');
      assert.ok(await planOpener(URL_OK, { ...noDisplay, env: { ...noDisplay.env, WAYLAND_DISPLAY: 'wayland-0' } }) !== null);
      // Only the planted and the group-writable candidates on PATH: no opener at all, and no program started.
      const onlyBad = { ...h.ctx, env: { ...h.ctx.env, PATH: ['', join(h.repo, 'bin'), h.gw].join(':') } };
      assert.equal(await planOpener(URL_OK, onlyBad), null);
      const refused = await programsStartedBy(() => openUrl(URL_OK, onlyBad));
      assert.equal(refused.result, false);
      assert.deepEqual(refused.started, []);
      for (const m of h.markers) assert.equal(existsSync(m), false, m);
    } finally {
      process.chdir(before);
      await h.cleanup();
    }
  });

/**
 * A table Fs: `files` maps a path to the realpath of a regular file (a path whose realpath differs is a symlink: lstat says so);
 * realpath and lstat also see the directories in `dirs`; stat sees those directories.
 */
function tableFs(files: Record<string, string>, dirs: readonly string[] = []): Fs {
  const enoent = (): never => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  const lst = { size: 1, mtimeNs: 0n, ino: 0n, dev: 0n, mode: 0o100755 };
  return {
    ...hostFs,
    realpath: async (p: string) => (p in files ? files[p] as string : dirs.includes(p) ? p : enoent()),
    lstat: async (p: string) => (Object.values(files).includes(p) ? { ...lst, isFile: true, isDirectory: false, isSymbolicLink: false }
      : p in files ? { ...lst, isFile: false, isDirectory: false, isSymbolicLink: true }
        : dirs.includes(p) ? { ...lst, isFile: false, isDirectory: true, isSymbolicLink: false } : null),
    stat: async (p: string) => (dirs.includes(p) ? { size: 0, mtimeMs: 0, isFile: false, isDirectory: true } : null),
  };
}

test('planOpener takes the first existing fixed Linux candidate (gio as gio open) through trustedExe, an untrusted one refuses, PATH only when none exists; macOS uses /usr/bin/open', async () => {
  const rootOwned: OwnerProbe = { posix: async () => ({ uid: 0, mode: 0o100755, isDir: false, isSymlink: false }), euid: () => 501, windows: async () => null };
  const REPO_DIRS = ['/usr/bin', '/opt/bin', '/home/me/repo', '/home/me/repo/.git'];
  const base = { builderEnv: {}, dataDir: '/home/me/data', cwd: '/home/me/repo', repos: [], uid: 501, ownerProbe: rootOwned };
  const linux = (files: Record<string, string>, probe: OwnerProbe = rootOwned, PATH = '/usr/bin'): OpenerCtx =>
    ({ ...base, platform: 'linux', env: { DISPLAY: ':1', PATH }, fs: tableFs(files, REPO_DIRS), ownerProbe: probe });
  const gio = await planOpener(URL_OK, linux({ '/usr/bin/gio': '/usr/bin/gio' }));
  assert.deepEqual(gio && { exe: gio.exe, argv: gio.argv, PATH: gio.env.PATH }, { exe: '/usr/bin/gio', argv: ['open', URL_OK], PATH: '/usr/bin' });
  // The first existing one decides: a symlinked /bin/xdg-open before gio (its realpath is the plan's executable).
  const symlinked = await planOpener(URL_OK, linux({ '/bin/xdg-open': '/usr/lib/xdg/xdg-open', '/usr/bin/gio': '/usr/bin/gio' }));
  assert.deepEqual(symlinked?.exe, '/usr/lib/xdg/xdg-open');
  // A group- or world-writable or foreign-owned first existing candidate refuses the open (12 §3.10.8: it MUST be trusted): never gio
  // instead, and never a PATH xdg-open.
  for (const st of [{ uid: 0, mode: 0o100775 }, { uid: 0, mode: 0o100757 }, { uid: 777, mode: 0o100755 }]) {
    const probe: OwnerProbe = { ...rootOwned, posix: async (p) => (p === '/usr/bin/xdg-open' ? { ...st, isDir: false, isSymlink: false } : { uid: 0, mode: 0o100755, isDir: false, isSymlink: false }) };
    const files = { '/usr/bin/xdg-open': '/usr/bin/xdg-open', '/usr/bin/gio': '/usr/bin/gio', '/opt/bin/xdg-open': '/opt/bin/xdg-open' };
    assert.equal(await planOpener(URL_OK, linux(files, probe, '/opt/bin')), null, JSON.stringify(st));
  }
  // A fixed candidate whose realpath lies in the repository refuses too.
  assert.equal(await planOpener(URL_OK, linux({ '/usr/bin/xdg-open': '/home/me/repo/bin/xdg-open', '/usr/bin/gio': '/usr/bin/gio' })), null);
  // No fixed candidate exists: xdg-open from the filtered PATH (an untrusted one there is skipped for the next).
  const fromPath = await planOpener(URL_OK, linux({ '/opt/bin/xdg-open': '/opt/bin/xdg-open' }, rootOwned, '/home/me/repo:/opt/bin'));
  assert.deepEqual(fromPath && { exe: fromPath.exe, argv: fromPath.argv, PATH: fromPath.env.PATH }, { exe: '/opt/bin/xdg-open', argv: [URL_OK], PATH: '/opt/bin' });
  const mac = await planOpener(URL_OK, { ...base, platform: 'darwin', env: {}, fs: tableFs({ '/usr/bin/open': '/usr/bin/open' }, REPO_DIRS) });
  assert.deepEqual(mac && { exe: mac.exe, argv: mac.argv }, { exe: '/usr/bin/open', argv: [URL_OK] });
});

test('T-VIZ-opener (Linux, planned on every host): an xdg-open planted in <cwd repo>/bin first on PATH after an empty entry, and a group-writable one, are never planned; the plan is the trusted xdg-open with argv [url] and PATH = the filtered list, and the spawn gets exactly that', async () => {
  const repo = '/home/me/repo';
  const gw = '/opt/gw bin';
  const good = '/opt/good bin';
  const probe: OwnerProbe = {
    posix: async (p) => ({ uid: 0, mode: p === `${gw}/xdg-open` ? 0o100775 : 0o100755, isDir: false, isSymlink: false }), euid: () => 501, windows: async () => null,
  };
  const files = { [`${repo}/bin/xdg-open`]: `${repo}/bin/xdg-open`, [`${gw}/xdg-open`]: `${gw}/xdg-open`, [`${good}/xdg-open`]: `${good}/xdg-open` };
  const ctx: OpenerCtx = {
    platform: 'linux', env: { DISPLAY: ':0', XAUTHORITY: '/home/me/.Xauthority', PATH: ['', `${repo}/bin`, gw, good, '.', 'relative/bin'].join(':') },
    builderEnv: { HOME: '/home/me', LC_ALL: 'C', PATH: '/should/be/replaced' }, dataDir: '/home/me/data', cwd: repo, repos: [], uid: 501, ownerProbe: probe,
    fs: tableFs(files, [repo, `${repo}/.git`, `${repo}/bin`, gw, good]), home: '/home/me',
  };
  const plan = await planOpener(URL_OK, ctx);
  assert.deepEqual(plan, {
    exe: `${good}/xdg-open`, argv: [URL_OK], env: { HOME: '/home/me', LC_ALL: 'C', PATH: `${gw}:${good}`, DISPLAY: ':0', XAUTHORITY: '/home/me/.Xauthority' },
  });
  const calls: Array<{ exe: string; argv: readonly string[] }> = [];
  const spy: OpenerSpawn = (exe, argv) => { calls.push({ exe, argv: [...argv] }); return fakeChild(0); };
  assert.equal(await openUrlWith(URL_OK, ctx, spy), true);
  assert.deepEqual(calls, [{ exe: `${good}/xdg-open`, argv: [URL_OK] }]);
  // Only the planted and the group-writable candidates on PATH, or no display: no plan and no spawn.
  for (const env of [{ ...ctx.env, PATH: ['', `${repo}/bin`, gw].join(':') }, { PATH: ctx.env.PATH }, { PATH: ctx.env.PATH, DISPLAY: '', WAYLAND_DISPLAY: '' }]) {
    assert.equal(await planOpener(URL_OK, { ...ctx, env }), null, JSON.stringify(env));
    assert.equal(await openUrlWith(URL_OK, { ...ctx, env }, spy), false, JSON.stringify(env));
  }
  assert.equal(calls.length, 1);
});

test('R-V68 in the opener: planOpener walks the repositories with ~ (ctx.home), so a dotfiles checkout at ~ keeps an xdg-open under ~/.local/bin trusted from a cwd under ~; without ctx.home, or with --repo ~, ~ is excluded and nothing is planned', async () => {
  const home = '/home/me';
  const local = `${home}/.local/bin`;
  const rootOwned: OwnerProbe = { posix: async () => ({ uid: 0, mode: 0o100755, isDir: false, isSymlink: false }), euid: () => 501, windows: async () => null };
  // ~ holds .git (a dotfiles checkout); the cwd ~/notes holds none, so the walk reaches ~ and stops there.
  const ctx: OpenerCtx = {
    platform: 'linux', env: { DISPLAY: ':0', PATH: local }, builderEnv: { HOME: home }, dataDir: `${home}/data`, cwd: `${home}/notes`, repos: [], uid: 501,
    ownerProbe: rootOwned, fs: tableFs({ [`${local}/xdg-open`]: `${local}/xdg-open` }, [home, `${home}/.git`, `${home}/notes`, local]), home,
  };
  const plan = await planOpener(URL_OK, ctx);
  assert.deepEqual(plan && { exe: plan.exe, argv: plan.argv, PATH: plan.env.PATH }, { exe: `${local}/xdg-open`, argv: [URL_OK], PATH: local });
  const calls: string[] = [];
  const spy: OpenerSpawn = (exe) => { calls.push(exe); return fakeChild(0); };
  assert.equal(await openUrlWith(URL_OK, ctx, spy), true);
  assert.deepEqual(calls, [`${local}/xdg-open`]);
  // Without ctx.home every ancestor is walked: ~ is then the cwd's repository, ~/.local/bin lies inside it, and nothing is planned.
  const noHome: OpenerCtx = { ...ctx };
  delete noHome.home;
  assert.equal(await planOpener(URL_OK, noHome), null);
  // An explicit --repo ~ is excluded with the home too.
  assert.equal(await planOpener(URL_OK, { ...ctx, repos: [home] }), null);
  assert.equal(await openUrlWith(URL_OK, noHome, spy), false);
  assert.equal(calls.length, 1);
});

/** A child for a spy spawn: exits with `code` on the next turn. */
function fakeChild(code: number): ReturnType<OpenerSpawn> {
  const child = new EventEmitter() as EventEmitter & { unref(): void };
  child.unref = () => {};
  setImmediate(() => child.emit('exit', code, null));
  return child as unknown as ReturnType<OpenerSpawn>;
}

test('T-VIZ-opener: a spawn spy sees an absolute executable, an argv array, shell: false, detached and hidden, stdio ignored, cwd = the data directory and the plan\'s environment; a fuzzed URL never reaches it', async () => {
  const h = await harness();
  try {
    const calls: Array<{ exe: string; argv: readonly string[]; options: SpawnOptions }> = [];
    const spy: OpenerSpawn = (exe, argv, options) => { calls.push({ exe, argv, options }); return fakeChild(0); };
    for (const bad of FUZZ) assert.equal(await openUrlWith(bad, h.ctx, spy), false, JSON.stringify(bad));
    assert.equal(calls.length, 0, 'a fuzzed URL reached the spawn');
    const plan = await planOpener(URL_OK, h.ctx);
    assert.ok(plan !== null);
    assert.equal(await openUrlWith(URL_OK, h.ctx, spy), true);
    assert.equal(calls.length, 1);
    const c = calls[0]!;
    assert.equal(c.exe, plan.exe);
    assert.ok(process.platform === 'win32' ? win32.isAbsolute(c.exe) : posix.isAbsolute(c.exe), c.exe);
    assert.ok(Array.isArray(c.argv));
    assert.deepEqual(c.argv, plan.argv);
    assert.equal(c.options.shell, false);
    assert.deepEqual({ ...c.options, env: undefined }, { shell: false, detached: true, windowsHide: true, stdio: 'ignore', cwd: h.ctx.dataDir, env: undefined });
    assert.deepEqual(c.options.env, plan.env);
  } finally {
    await h.cleanup();
  }
});
