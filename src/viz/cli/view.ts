// The `view` verb of cli.js (12-visualizer sections 3.2 and 3.10.9; VIZ-02, VIZ-04 in its 8a subset; R-V13, R-V14, R-V15, R-V54, R-V55).
// In tty mode it resolves and verifies the data directory, the language, the absolute --repo/--demo paths and, with --repo, the git the
// viewer may run; hashes dist/viz.js; starts the viewer with the builder environment; and opens the launch URL (or prints it after
// --no-open or a failed open). In slash and pipe mode it starts nothing and prints the terminal command (8a: no slash open path and no
// --json, R-V14). Every string it writes is a render() result of the CLI's own catalog (UX-01); cli.js bundles only src/viz/cli/**.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDaemonEnv } from '../../git/env.js';
import { registerCatalog, render, type Lang, type Params, type RenderChannel } from '../../i18n/render.js';
import { realClock, type Clock } from '../../ports/clock.js';
import { realFs, type Fs } from '../../ports/fs.js';
import { resolveDataDir, verifyDataDir } from './dataDir.js';
import { openUrl, type OpenerCtx } from './opener.js';
import { realOwnerProbe, type OwnerProbe } from './ownerProbe.js';
import { absolutize, isUncOrDevice } from './paths.js';
import { excludedRoots, filterPath, resolveGitPath, withPath, withTrustCache } from './pathTrust.js';
import { READY_REFUSE_CODES, spawnViewer, type ReadyLine, type ViewerArgs } from './spawn.js';
import { EN_VIZ_CLI } from './strings.js';

type Env = Readonly<Record<string, string | undefined>>;

export type OutputMode = 'tty' | 'slash' | 'pipe';

/** 10-product section 2: stdout a TTY → tty; else the environment variable CLAUDECODE present → slash (the `!` route); else pipe. */
export function outputMode(isTTY: boolean, env: Env): OutputMode {
  if (isTTY) return 'tty';
  return env.CLAUDECODE !== undefined ? 'slash' : 'pipe';
}

export interface ViewFlags { noOpen: boolean; demo: true | string | null; repos: string[]; }

const UNKNOWN_FLAG = Object.freeze({ refuse: 'RF_UNKNOWN_FLAG' as const });

/**
 * --no-open, --demo, --demo=<file>, --repo <path> (repeatable); anything else, --json, or --demo with --repo → RF_UNKNOWN_FLAG.
 * --no-open and --demo appear at most once; a --repo value is present, non-empty and not itself a --flag.
 */
export function parseViewFlags(argv: readonly string[]): ViewFlags | { refuse: 'RF_UNKNOWN_FLAG' } {
  let noOpen = false;
  let demo: true | string | null = null;
  const repos: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === '--no-open') {
      if (noOpen) return UNKNOWN_FLAG;
      noOpen = true;
    } else if (a === '--demo' || a.startsWith('--demo=')) {
      const file = a === '--demo' ? true : a.slice('--demo='.length);
      if (demo !== null || file === '') return UNKNOWN_FLAG;
      demo = file;
    } else if (a === '--repo') {
      const p = argv[i + 1];
      if (p === undefined || p === '' || p.startsWith('--')) return UNKNOWN_FLAG;
      repos.push(p);
      i += 1;
    } else {
      return UNKNOWN_FLAG;
    }
  }
  if (demo !== null && repos.length > 0) return UNKNOWN_FLAG;
  return { noOpen, demo, repos };
}

/**
 * 10-product section 3.17, by the language subtag: ko → ko, ja → ja, fr → fr, es → es; zh with the Hans script, or zh-CN and zh-SG
 * without a script → zh-CN; anything else (zh-TW, zh-HK, zh-Hant…, kok, und) → en.
 */
export function langOf(locale: string): Lang {
  const [language = '', second = ''] = locale.split(/[-_]/);
  switch (language.toLowerCase()) {
    case 'ko': return 'ko';
    case 'ja': return 'ja';
    case 'fr': return 'fr';
    case 'es': return 'es';
    case 'zh':
      if (/^[A-Za-z]{4}$/.test(second)) return second.toLowerCase() === 'hans' ? 'zh-CN' : 'en';
      return second.toUpperCase() === 'CN' || second.toUpperCase() === 'SG' ? 'zh-CN' : 'en';
    default: return 'en';
  }
}

/** The launch URL (12 section 3.2 item 4); re-checked before every use, and by the opener immediately before its spawn. */
export const URL_RE = /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/#k=[0-9a-f]{64}$/;
const LAUNCH_RE = /^[0-9a-f]{64}$/;

/** From the integer and the hex only, through the one allowed launch template (R-V55), then URL_RE. */
export function launchUrl(port: number, launch: string): string | null {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || typeof launch !== 'string' || !LAUNCH_RE.test(launch)) return null;
  const url = `http://127.0.0.1:${port}/#k=${launch}`;
  return URL_RE.test(url) ? url : null;
}

export interface CliEnv {
  pluginRoot: string;                               // the parent of dist/
  cwd: string; env: Readonly<Record<string, string | undefined>>; platform: NodeJS.Platform; isTTY: boolean; home: string; locale: string;
  execPath: string; uid: number | null;
  out(s: string): void; err(s: string): void;       // every string written is a render() result (UX-01, tested)
  fs: Fs; clock: Clock; ownerProbe: OwnerProbe;
  spawnViewer(a: ViewerArgs): Promise<ReadyLine>; openUrl(url: string, ctx: OpenerCtx): Promise<boolean>;   // injectable for tests
}

const pathOf = (platform: NodeJS.Platform): typeof posix => (platform === 'win32' ? win32 : posix);

/**
 * The shell the printed terminal command is written for: PowerShell on Windows (the default shell of Windows Terminal and of the
 * Windows 11 console; the CLI cannot tell which shell the user will paste into), POSIX sh elsewhere.
 */
export type TerminalShell = 'powershell' | 'sh';
export const terminalShell = (platform: NodeJS.Platform): TerminalShell => (platform === 'win32' ? 'powershell' : 'sh');

/** Characters that act inside double quotes: sh's " $ ` \ (and bash's history !); PowerShell's $ ` and its double-quote characters. */
const SH_DQ_SPECIAL = /["$`\\!]/;
const PS_DQ_SPECIAL = /[$`"“”„]/;
/** PowerShell's single-quote characters: inside single quotes each is written twice. */
const PS_SQ = /['‘’‚‛]/g;

/**
 * One command-line word for `shell`: double quotes (10-product section 3.3's form) when nothing inside acts there (the same word then
 * also reads right in cmd.exe, for a text without '%'), else single quotes, inside which nothing acts: sh closes, escapes and reopens
 * around a ' ('\''), PowerShell writes each of its single-quote characters twice.
 */
export function shellWord(s: string, shell: TerminalShell): string {
  if (shell === 'sh') return SH_DQ_SPECIAL.test(s) ? `'${s.split("'").join("'\\''")}'` : `"${s}"`;
  return PS_DQ_SPECIAL.test(s) ? `'${s.replace(PS_SQ, (q) => q + q)}'` : `"${s}"`;
}

/** `node "<plugin root>/dist/cli.js" view <args>` (10-product section 3.3), with the paths made absolute where they can be, quoted for
 *  the shell the platform's terminal runs (terminalShell). */
function terminalCommand(env: CliEnv, flags: ViewFlags): string {
  const shell = terminalShell(env.platform);
  const q = (s: string): string => shellWord(s, shell);
  const abs = (p: string): string => absolutize(p, env.cwd, env.platform) ?? p;
  const words = ['node', q(pathOf(env.platform).join(env.pluginRoot, 'dist', 'cli.js')), 'view'];
  if (flags.noOpen) words.push('--no-open');
  if (flags.demo === true) words.push('--demo');
  else if (typeof flags.demo === 'string') words.push(`--demo=${q(abs(flags.demo))}`);
  for (const r of flags.repos) words.push('--repo', q(abs(r)));
  return words.join(' ');
}

/** SystemRoot from the CLI's environment (any spelling) when it is an absolute existing local directory (R-V12), else null. */
async function systemRootOf(env: CliEnv): Promise<string | null> {
  if (env.platform !== 'win32') return null;
  const key = Object.keys(env.env).find((k) => k.toUpperCase() === 'SYSTEMROOT');
  const root = key === undefined ? undefined : env.env[key];
  if (root === undefined || !/^[A-Za-z]:[\\/]/.test(root) || isUncOrDevice(root)) return null;
  const st = await env.fs.stat(root).catch(() => null);
  return st !== null && st.isDirectory ? root : null;
}

/** The tty row of 12 section 3.10.9, after the flags parsed. Returns the exit code; refusals go through `refuse`. */
async function viewTty(flags: ViewFlags, env: CliEnv, lang: Lang, say: (code: string, p?: Params) => void, refuse: (code: string, p?: Params) => number): Promise<number> {
  // The data directory: resolved, created user-only, and verified (SEC-20) before anything is read or spawned.
  const dataDir = resolveDataDir(env.env, env.home, env.platform);
  if (dataDir === null) return refuse('RF_VIZ_START_FAILED');
  const verdict = await verifyDataDir(dataDir, { fs: env.fs, probe: env.ownerProbe, platform: env.platform, create: true });
  if (!verdict.ok) return refuse('RF_VIZ_START_FAILED');

  // Absolute paths against the CLI's cwd; UNC and device paths refused.
  const repos: string[] = [];
  for (const r of flags.repos) {
    const abs = absolutize(r, env.cwd, env.platform);
    if (abs === null) return refuse('RF_VIZ_REPO_NOT_LIVE');
    repos.push(abs);
  }
  let demo = flags.demo;
  if (typeof demo === 'string') {
    const abs = absolutize(demo, env.cwd, env.platform);
    if (abs === null) return refuse('RF_VIZ_DEMO_INVALID', { n: 0 });
    demo = abs;
  }

  // With --repo, the git the viewer may run (R-V13); a demo resolves and calls no git (VIZ-06). One reading of the PATH and the
  // repository roots serves the git, the viewer's PATH and the opener's (withTrustCache: per view call).
  const fs = withTrustCache(env.fs);
  const excluded = await excludedRoots(env.cwd, repos, fs, env.platform, env.home);
  let git: string | null = null;
  if (repos.length > 0) {
    git = await resolveGitPath(env.env, excluded, { fs, probe: env.ownerProbe, platform: env.platform, euid: env.uid });
    if (git === null) return refuse('START_TOOL_VERSION');
  }

  const vizJs = pathOf(env.platform).join(env.pluginRoot, 'dist', 'viz.js');
  let sha256: string;
  try {
    sha256 = createHash('sha256').update(await env.fs.readFile(vizJs)).digest('hex');
  } catch {
    return refuse('RF_VIZ_START_FAILED');
  }

  // The 09-security section 3.4 builder environment, PATH replaced by the filtered list (the viewer gets no display set).
  const builderEnv = buildDaemonEnv({ ...env.env }, []);
  const viewerEnv = withPath(builderEnv, env.env, await filterPath(env.env, excluded, env.platform, fs), env.platform);
  const ready = await env.spawnViewer({
    execPath: env.execPath, vizJs, dataDir, lang, sha256, repos, demo, git, env: viewerEnv, platform: env.platform, systemRoot: await systemRootOf(env),
  });
  if ('refuse' in ready) {
    if (!READY_REFUSE_CODES.has(ready.refuse)) return refuse('RF_VIZ_START_FAILED');
    return refuse(ready.refuse, ready.refuse === 'RF_VIZ_DEMO_INVALID' ? { n: ready.line ?? null } : {});
  }
  const url = launchUrl(ready.port, ready.launch);
  if (url === null) return refuse('RF_VIZ_START_FAILED');
  if (!flags.noOpen) {
    const ctx: OpenerCtx = {
      platform: env.platform, env: env.env, builderEnv, dataDir, cwd: env.cwd, repos, fs, uid: env.uid, ownerProbe: env.ownerProbe, home: env.home,
    };
    if (await env.openUrl(url, ctx).catch(() => false)) {
      say('UI_VIZ_OPENED');
      return 0;
    }
  }
  // Only here, in tty mode, after --no-open or a failed open, is the launch URL printed (VIZ-04).
  say('UI_VIZ_URL', { url });
  return 0;
}

/**
 * registerCatalog('en', EN_VIZ_CLI) (R-V54); pipe/slash → UI_VIZ_TERMINAL_ONLY, exit 0, nothing started; tty → resolve and verify the data
 * dir, L_h, absolute paths (cli/paths.ts), with --repo the git path (resolveGitPath over excludedRoots(cwd, repos, …, home): the walk
 * stops below ~, R-V68; none → START_TOOL_VERSION, nothing spawned; R-V13), sha256 of <pluginRoot>/dist/viz.js, the viewer environment (buildDaemonEnv with PATH
 * replaced by the filtered list), spawnViewer, launchUrl, open unless --no-open; prints UI_VIZ_OPENED, or UI_VIZ_URL with the URL (a
 * 'url' param) after --no-open or an open failure; refusals in the 10-product section 3.4 two-line format with the 12 section 1.2 next
 * line; exit 0 / 1 (2 after an internal error, which prints UI_INTERNAL_ERROR and never a message or a path). Everything, the reads of
 * the environment's values included (realCliEnv reads them lazily), runs inside the one try (UX-01: never a raw stack trace); an error
 * before the output mode or the language is known is rendered on the terminal channel in en.
 */
export async function runView(argv: readonly string[], env: CliEnv): Promise<number> {
  let channel: RenderChannel = 'terminal';
  let lang: Lang = 'en';
  try {
    registerCatalog('en', EN_VIZ_CLI);
    const mode = outputMode(env.isTTY, env.env);
    channel = mode === 'slash' ? 'slash' : 'terminal';
    lang = langOf(env.locale);
    const [c, l] = [channel, lang];
    const say = (code: string, p: Params = {}): void => env.out(render(code, p, c, l));
    const refuse = (code: string, p: Params = {}): number => {
      env.err(render(code, p, c, l));
      return 1;
    };
    const flags = parseViewFlags(argv);
    if ('refuse' in flags) return refuse(flags.refuse);
    if (mode !== 'tty') {
      say('UI_VIZ_TERMINAL_ONLY', { cmd: terminalCommand(env, flags) });
      return 0;
    }
    return await viewTty(flags, env, lang, say, refuse);
  } catch {
    try {
      env.err(render('UI_INTERNAL_ERROR', {}, channel, lang));
    } catch {
      // the error stream itself failed: the exit code still says it
    }
    return 2;
  }
}

/** f's value, computed on the first read (and not before). */
function once<T>(f: () => T): () => T {
  let done = false;
  let v: T;
  return () => {
    if (!done) {
      v = f();
      done = true;
    }
    return v;
  };
}

/**
 * The process's own CliEnv: cli.js lives in <plugin root>/dist/. Every value whose read can throw (the cwd of a deleted folder, a home
 * folder the OS cannot report, a broken Intl, the TTY check) is a getter read on first use, so the read happens inside runView's try
 * and cli.ts can never print a raw stack trace (UX-01).
 */
export function realCliEnv(): CliEnv {
  const P = pathOf(process.platform);
  const pluginRoot = once(() => P.dirname(P.dirname(fileURLToPath(import.meta.url))));
  const cwd = once(() => process.cwd());
  const isTTY = once(() => process.stdout.isTTY === true);
  const home = once(() => homedir());
  const locale = once(() => Intl.DateTimeFormat().resolvedOptions().locale);
  const uid = once(() => (typeof process.geteuid === 'function' ? process.geteuid() : null));
  return {
    get pluginRoot() { return pluginRoot(); },
    get cwd() { return cwd(); },
    env: process.env,
    platform: process.platform,
    get isTTY() { return isTTY(); },
    get home() { return home(); },
    get locale() { return locale(); },
    execPath: process.execPath,
    get uid() { return uid(); },
    out: (s: string) => { process.stdout.write(`${s}\n`); },
    err: (s: string) => { process.stderr.write(`${s}\n`); },
    fs: realFs,
    clock: realClock,
    ownerProbe: realOwnerProbe,
    spawnViewer,
    openUrl,
  };
}
