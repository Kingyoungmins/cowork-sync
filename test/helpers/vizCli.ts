// Test helpers for the `view` verb (Task 11): a recording CliEnv, a SEC-20-passing owner probe, a fake plugin root, and the UX-01
// oracle that every string runView writes is a render() result of a code of EN_VIZ_CLI.
import { copyFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { registerCatalog, render, type Lang, type Params, type RenderChannel } from '../../src/i18n/render.js';
import { realClock } from '../../src/ports/clock.js';
import { realFs, type Fs } from '../../src/ports/fs.js';
import type { OpenerCtx } from '../../src/viz/cli/opener.js';
import { realOwnerProbe, type OwnerProbe } from '../../src/viz/cli/ownerProbe.js';
import type { ReadyLine, ViewerArgs } from '../../src/viz/cli/spawn.js';
import { EN_VIZ_CLI } from '../../src/viz/cli/strings.js';
import type { CliEnv } from '../../src/viz/cli/view.js';

registerCatalog('en', EN_VIZ_CLI);   // what runView registers; identical entries are a no-op

export const PROBE_VIEWER = fileURLToPath(new URL('../fixtures/viz/probeViewer.mjs', import.meta.url));

const fold = (p: string): string => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p);
/** The OS temp folder (as a realpath) and its ancestors. */
const TEMP_AND_ANCESTORS: ReadonlySet<string> = (() => {
  const out = new Set<string>();
  for (let d = realpathSync.native(tmpdir()); ; d = dirname(d)) {
    out.add(fold(d));
    if (dirname(d) === d) break;
  }
  return out;
})();

/**
 * realFs, except that a `.git` in the OS temp folder or one of its ancestors reads as absent. excludedRoots walks every ancestor of the
 * cwd (nested checkouts), so a host whose profile folder holds a `.git` (this author's AppData\Local has one) would otherwise exclude every
 * temp fixture; with this Fs the tests see the roots they build, on every host. Nothing under a temp root is hidden.
 */
export const hostFs: Fs = {
  ...realFs,
  lstat: (p: string) => (basename(p) === '.git' && TEMP_AND_ANCESTORS.has(fold(dirname(p))) ? Promise.resolve(null) : realFs.lstat(p)),
};

/** The realpath of the first git on this process's PATH (the system git the tests resolve), or null. */
export function findSystemGit(): string | null {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH');
  const name = process.platform === 'win32' ? 'git.exe' : 'git';
  for (const dir of (key === undefined ? '' : process.env[key] ?? '').split(delimiter)) {
    if (dir === '') continue;
    const p = join(dir, name);
    if (existsSync(p)) return realpathSync.native(p);
  }
  return null;
}
const childProcess = createRequire(import.meta.url)('node:child_process') as Record<string, unknown>;
const STARTERS = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'] as const;

/**
 * Runs `f` and returns, with its result, every program this process started meanwhile: the file each child_process call named (the
 * command line for exec and execSync). The functions are wrapped on the CommonJS object and synced to the ES module bindings
 * (module.syncBuiltinESMExports), so src/**'s named imports call the wrapper; every call still goes through. Restored afterwards, also
 * on a throw. A test that plants a program asserts that none of these lies in its fixture: it fails on every OS when a regression runs
 * the plant, where a marker file only shows it on POSIX (a Windows plant that is no program fails to start and writes nothing).
 * `calls` holds each call's file with its argument array (empty for exec, execSync and a call without one).
 */
export async function programsStartedBy<T>(f: () => Promise<T>): Promise<{ result: T; started: string[]; calls: Array<{ file: string; args: string[] }> }> {
  const saved = new Map<string, unknown>();
  const started: string[] = [];
  const calls: Array<{ file: string; args: string[] }> = [];
  for (const name of STARTERS) {
    const orig = childProcess[name] as (...a: unknown[]) => unknown;
    saved.set(name, orig);
    childProcess[name] = function wrapped(this: unknown, file: unknown, ...rest: unknown[]): unknown {
      started.push(String(file));
      calls.push({ file: String(file), args: Array.isArray(rest[0]) ? rest[0].map(String) : [] });
      return orig.call(this, file, ...rest);
    };
  }
  syncBuiltinESMExports();
  try {
    return { result: await f(), started, calls };
  } finally {
    for (const [name, orig] of saved) childProcess[name] = orig;
    syncBuiltinESMExports();
  }
}

/**
 * Every program in `started` is named by an absolute path (a bare or relative name is searched in the cwd or on PATH, where a plant
 * waits), and none lies in one of `dirs` (compared case-insensitively on win32 and darwin; an exec command line that mentions the
 * directory counts).
 */
export function assertNoneStartedFrom(started: readonly string[], dirs: readonly string[]): void {
  for (const p of started) {
    assert.ok(isAbsolute(p), `a bare or relative program was started: ${p}`);
    for (const d of dirs) assert.ok(!fold(p).includes(fold(d)), `a program in ${d} was started: ${p}`);
  }
}

/** The probe's ready-mode values (test/fixtures/viz/probeViewer.mjs). */
export const PROBE_PORT = 41234;
export const PROBE_LAUNCH = '0123456789abcdef'.repeat(4);

export const USER_SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
export const USER_ONLY_SDDL = `O:${USER_SID}G:${USER_SID}D:(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${USER_SID})`;
export const FAKE_EUID = 1000;

/**
 * Passes SEC-20 for every directory: owned by the (fake) euid with mode 0700 (POSIX), a user-only SDDL (Windows). Anything that lstats as
 * no directory (a git the CLI checks with trustedExe) gets its real lstat answer, so POSIX judges the git that is there: root-owned on
 * Linux, the runner user's own Homebrew git on macOS (judged against CliEnv.uid, which recordingEnv takes from this process).
 */
export const passingProbe: OwnerProbe = {
  posix: async (p: string) => {
    const real = await realOwnerProbe.posix(p);
    return real !== null && !real.isDir ? real : { uid: FAKE_EUID, mode: 0o40700, isDir: true, isSymlink: false };
  },
  euid: () => FAKE_EUID,
  windows: async () => ({ sddl: USER_ONLY_SDDL, userSid: USER_SID }),
};

/** A plugin root whose dist/viz.js is a copy of the probe viewer (with the repository's ESM package.json beside dist/). */
export function fakePluginRoot(root: string): { pluginRoot: string; vizJs: string } {
  const pluginRoot = join(root, 'plugin root');
  mkdirSync(join(pluginRoot, 'dist'), { recursive: true });
  writeFileSync(join(pluginRoot, 'package.json'), '{"type":"module"}\n');
  const vizJs = join(pluginRoot, 'dist', 'viz.js');
  copyFileSync(PROBE_VIEWER, vizJs);
  return { pluginRoot, vizJs };
}

export interface Recording {
  env: CliEnv;
  outs: string[];
  errs: string[];
  spawned: ViewerArgs[];
  opened: Array<{ url: string; ctx: OpenerCtx }>;
}

/** A CliEnv over the real Fs (hostFs) and clock whose out/err, spawnViewer and openUrl record; anything can be overridden. */
export function recordingEnv(o: Partial<CliEnv> & Pick<CliEnv, 'pluginRoot' | 'cwd' | 'home' | 'env'>, ready?: ReadyLine | ((a: ViewerArgs) => Promise<ReadyLine>), opens = true): Recording {
  const rec: Recording = { env: undefined as unknown as CliEnv, outs: [], errs: [], spawned: [], opened: [] };
  rec.env = {
    platform: process.platform,
    isTTY: true,
    locale: 'en-US',
    execPath: process.execPath,
    uid: typeof process.geteuid === 'function' ? process.geteuid() : null,   // what realCliEnv reads
    fs: hostFs,
    clock: realClock,
    ownerProbe: passingProbe,
    out: (s: string) => { rec.outs.push(s); },
    err: (s: string) => { rec.errs.push(s); },
    spawnViewer: async (a: ViewerArgs) => {
      rec.spawned.push(a);
      if (typeof ready === 'function') return ready(a);
      return ready ?? { port: PROBE_PORT, launch: PROBE_LAUNCH };
    },
    openUrl: async (url: string, ctx: OpenerCtx) => {
      rec.opened.push({ url, ctx });
      return opens;
    },
    ...o,
  };
  return rec;
}

const URL_ANY = /http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/#k=[0-9a-f]{64}/;
const LINE_N = /first bad line: ([0-9]+)\)/;

/**
 * UX-01 oracle: the code of EN_VIZ_CLI whose render() equals `s` for the params runView could have passed (none; the launch URL found in
 * `s`; the terminal command `cmd`; the demo line number found in `s`), else null.
 */
export function renderedCode(s: string, o: { channel: RenderChannel; lang: Lang; cmd: string | null }): string | null {
  const candidates: Params[] = [{}];
  const url = URL_ANY.exec(s);
  if (url !== null) candidates.push({ url: url[0] });
  if (o.cmd !== null) candidates.push({ cmd: o.cmd });
  const n = LINE_N.exec(s);
  if (n !== null) candidates.push({ n: Number(n[1]) });
  for (const code of Object.keys(EN_VIZ_CLI)) {
    for (const p of candidates) if (render(code, p, o.channel, o.lang) === s) return code;
  }
  return null;
}

/** Every string the recording's out() and err() received is a render() result; returns the codes in output order. */
export function assertAllRendered(rec: Recording, o: { channel: RenderChannel; lang: Lang; cmd: string | null }): string[] {
  const codes: string[] = [];
  for (const s of [...rec.outs, ...rec.errs]) {
    const code = renderedCode(s, o);
    assert.notEqual(code, null, `not a render() result: ${JSON.stringify(s)}`);
    codes.push(code as string);
  }
  return codes;
}
