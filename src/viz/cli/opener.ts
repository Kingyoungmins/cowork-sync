// Opening the browser on the launch URL (12-visualizer section 3.10.8; VIZ-05; R-V39; INV-NOEXEC). The URL is re-validated immediately
// before the spawn; the opener is an absolute executable that lies outside every repository the CLI knows (compared by realpath), run
// with an argv array, no shell, cwd = the data directory and the builder environment plus the opener display set, with PATH = the
// filtered list (xdg-open is itself a script that resolves gio and the browser from its own PATH). Never cmd.exe, a .cmd/.bat file or
// PowerShell. One of the three viz files allowed child_process (R-V34).
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { posix, win32 } from 'node:path';
import type { Fs } from '../../ports/fs.js';
import type { OwnerProbe } from './ownerProbe.js';
import { isUncOrDevice } from './paths.js';
import { excludedRoots, filterPath, trustedExe, withPath } from './pathTrust.js';

export interface OpenerCtx {
  platform: NodeJS.Platform; env: Readonly<Record<string, string | undefined>>; builderEnv: Record<string, string>;
  dataDir: string; cwd: string; repos: readonly string[]; fs: Fs; uid: number | null; ownerProbe: OwnerProbe;
  /** The user's home directory, where the excluded-roots walk stops (R-V68); runView sets it. Absent: every ancestor is walked. */
  home?: string;
}
export interface OpenerPlan { exe: string; argv: string[]; env: Record<string, string>; }

/** URL_RE of view.ts (12 section 3.2 item 4), repeated here so the opener re-checks the URL itself, immediately before the spawn. */
const LAUNCH_URL_RE = /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/#k=[0-9a-f]{64}$/;
const OPEN_TIMEOUT_MS = 5_000;
/** The fixed Linux, BSD and WSL candidates, in order (gio as `gio open <url>`). */
const LINUX_OPENERS: ReadonlyArray<{ exe: string; argv: readonly string[] }> = [
  { exe: '/usr/bin/xdg-open', argv: [] }, { exe: '/usr/local/bin/xdg-open', argv: [] }, { exe: '/bin/xdg-open', argv: [] }, { exe: '/usr/bin/gio', argv: ['open'] },
];
/** The opener display set (09-security section 3.4 as amended by 12 section 9.3): only the opener receives it, never the viewer. */
const DISPLAY_SET = ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY'];

/** An environment value; on win32 the name is matched in any case. */
function envValue(env: Readonly<Record<string, string | undefined>>, name: string, platform: NodeJS.Platform): string | undefined {
  if (env[name] !== undefined || platform !== 'win32') return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/** The builder environment plus the opener display set, with PATH (under the key's existing spelling) replaced by the filtered list. */
function openerEnv(ctx: OpenerCtx, filtered: readonly string[]): Record<string, string> {
  const env: Record<string, string> = { ...ctx.builderEnv };
  for (const name of DISPLAY_SET) {
    const v = ctx.env[name];
    if (v !== undefined && v !== '') env[name] = v;
  }
  return withPath(env, ctx.env, filtered, ctx.platform);
}

/**
 * URL_RE re-check first; win32: <SystemRoot>\explorer.exe (SystemRoot absolute and existing); darwin: /usr/bin/open; else the first
 * existing (lstat: any entry, a dangling symlink included) of /usr/bin/xdg-open, /usr/local/bin/xdg-open, /bin/xdg-open, /usr/bin/gio
 * (argv ['open', url]), and only when none exists xdg-open from filterPath (12 §3.10.8). Every candidate goes through trustedExe (outside
 * the excluded roots by realpath, a regular file; on POSIX owned by uid 0 or the user, not group- or world-writable) and the plan names
 * its realpath: the first existing fixed candidate that fails it refuses the open (never the next one, never PATH); on PATH an untrusted
 * xdg-open is skipped for the next entry. Linux needs DISPLAY or WAYLAND_DISPLAY. null → no usable opener.
 */
export async function planOpener(url: string, ctx: OpenerCtx): Promise<OpenerPlan | null> {
  if (!LAUNCH_URL_RE.test(url)) return null;
  const excluded = await excludedRoots(ctx.cwd, ctx.repos, ctx.fs, ctx.platform, ctx.home ?? null);
  const trust = { fs: ctx.fs, probe: ctx.ownerProbe, platform: ctx.platform, euid: ctx.uid };
  const filtered = await filterPath(ctx.env, excluded, ctx.platform, ctx.fs);
  const plan = (exe: string, pre: readonly string[]): OpenerPlan => ({ exe, argv: [...pre, url], env: openerEnv(ctx, filtered) });

  if (ctx.platform === 'win32') {
    const root = envValue(ctx.env, 'SYSTEMROOT', 'win32');
    if (root === undefined || !/^[A-Za-z]:[\\/]/.test(root) || isUncOrDevice(root)) return null;
    const dir = await ctx.fs.stat(root).catch(() => null);
    if (dir === null || !dir.isDirectory) return null;
    const exe = await trustedExe(win32.join(root, 'explorer.exe'), excluded, trust);
    return exe === null ? null : plan(exe, []);
  }
  if (ctx.platform === 'darwin') {
    const exe = await trustedExe('/usr/bin/open', excluded, trust);
    return exe === null ? null : plan(exe, []);
  }
  if ((ctx.env.DISPLAY ?? '') === '' && (ctx.env.WAYLAND_DISPLAY ?? '') === '') return null;
  for (const c of LINUX_OPENERS) {
    if ((await ctx.fs.lstat(c.exe).catch(() => 'unreadable' as const)) === null) continue;   // absent: the next one
    const exe = await trustedExe(c.exe, excluded, trust);
    return exe === null ? null : plan(exe, c.argv);
  }
  for (const dir of filtered) {
    const exe = await trustedExe(posix.join(dir, 'xdg-open'), excluded, trust);
    if (exe !== null) return plan(exe, []);
  }
  return null;
}

/**
 * spawn(plan.exe, plan.argv, { shell: false, detached: true, windowsHide: true, stdio: 'ignore', cwd: dataDir, env }); 5 s.
 * Waits for the opener's exit, at most 5 s. win32: only a spawn error fails (explorer exits 1 even on success). Elsewhere exit 0 is
 * success and another exit or a spawn error a failure. An opener still running after 5 s counts as success (it is left running,
 * unreferenced): it started, and the URL is not printed for a browser that may already be open.
 */
export function openUrl(url: string, ctx: OpenerCtx): Promise<boolean> {
  return openUrlWith(url, ctx, spawn);
}

/** The spawn openUrlWith uses: node's spawn, or a test's spy (12 §7 T-VIZ-opener: "a spawn spy shows … shell: false"). */
export type OpenerSpawn = (exe: string, argv: readonly string[], options: SpawnOptions) => ChildProcess;

/** openUrl over the given spawn. */
export async function openUrlWith(url: string, ctx: OpenerCtx, spawnFn: OpenerSpawn): Promise<boolean> {
  const p = await planOpener(url, ctx);
  if (p === null || !LAUNCH_URL_RE.test(url) || p.argv[p.argv.length - 1] !== url) return false;
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => done(true), OPEN_TIMEOUT_MS);
    try {
      const child = spawnFn(p.exe, p.argv, { shell: false, detached: true, windowsHide: true, stdio: 'ignore', cwd: ctx.dataDir, env: p.env });
      child.unref();
      child.on('error', () => done(false));
      child.on('exit', (code) => done(ctx.platform === 'win32' || code === 0));
    } catch {
      done(false);
    }
  });
}
