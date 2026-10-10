// The foreground daemon behind `node dist/daemon.js` (rulings R-23, R-26, R-28, R-37; LIF-05, LIF-06 respawn column,
// SEC-11 subset; Plan 1 ledger minor #4: the resolved core.sshCommand reaches the runner).
//
//   run      the git floor (START_TOOL_VERSION), the remote by LIF-05's order with the split and rewrite refusals
//            (SEC-11), daemon.lock (nothing in <coworkDir> is touched before it is held), the runner (hooksPath
//            <coworkDir>/empty-hooks, DAEMON_ENV, the resolved core.sshCommand), the Engine on the real ports, start
//            (Table 3.3-A with the respawn column: genesis, join or restart; a refusal prints its code and one next command,
//            exit 1), then runLoop until a stop signal (drain: status down) or the lease exit (IDLE_NO_SESSION). An
//            iteration error rebuilds the Engine from disk and starts again (RESTART) within the RespawnBudget (5 per
//            10 min); a lost state CAS (a second writer, ENG-03) exits at once after a security log line
//   recover  under daemon.lock (so no daemon runs): the restart, then the human recover (a preview without --confirm)
//   resume   under daemon.lock: the host-reject PIN ended (05-holds: lifted by resume; final review FC-5), then R-28's one
//            state CAS clearing meta.nonretryable and the rejection streak, so the next run retries the rejected publish
// Every printed line passes through the URL-userinfo filter (https and scp form; the one word it keeps is an exact
// url.<base>.insteadOf key without scheme userinfo, so SEC_REFUSE_URL_REWRITE's command names the rule that exists); the
// pinned URL carries no userinfo either (src/sec/redact.ts). Every word of a printed command is quoted for the OS shell
// (shellQuote), or shown as a <placeholder> where no quoting is safe. Exit 0 success, 1 refusal, 2 internal error; a
// failing daemon.lock release is reported and keeps the command's code; the daemon log is flushed before the command
// returns.
import { createHash } from 'node:crypto';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Json } from '../board/canonicalJson.js';
import { humanOnlyAttribution, PLAN2_REGION_SPEC, type EngineDeps } from '../engine/deps.js';
import { STOP_REQUEST_FILE } from '../engine/daemonFiles.js';
import { DAEMON_LOCK_FILE, DaemonLock, Engine, runLoop } from '../engine/loop.js';
import { RELEASE_NAMESPACE, refNames } from '../engine/refs.js';
import { StateCasLostError } from '../engine/state.js';
import { EncTooLongError } from '../git/enc.js';
import { buildDaemonEnv } from '../git/env.js';
import { ABSENT } from '../git/oid.js';
import { GitRepo, type RepoContext, type RepoPaths } from '../git/repo.js';
import { createGitRunner, type GitRunner } from '../git/runner.js';
import { GIT_FLOOR, meetsFloor, parseGitVersion } from '../git/version.js';
import { RegistryCasLostError } from '../holds/registry.js';
import { machineMonoMs, realClock, type Clock } from '../ports/clock.js';
import { KilledAt } from '../ports/crashpoint.js';
import { errnoCode, realFs } from '../ports/fs.js';
import { alwaysLeased } from '../ports/lease.js';
import { fileLog, type FileLog, type Log } from '../ports/log.js';
import { randomHex, realRandom } from '../ports/random.js';
import { realScheduler } from '../ports/scheduler.js';
import { noTrace } from '../ports/trace.js';
import { sanitizeText, sanitizeUrl as redactUrl, userinfoKind } from '../sec/redact.js';
import { validName } from '../sec/validators.js';
import { PLUGIN_VERSION } from '../version.js';

export type DaemonCommand = 'run' | 'recover' | 'resume';
export interface DaemonArgs { cmd: DaemonCommand; repo: string; branch: string; publish: 'all' | 'none' | null; name: string | null; remote: string | null; confirm: string | null; }
export interface ResolvedRemote { name: string; url: string; }
export type RemoteRefusal = 'START_REMOTE' | 'SEC_REFUSE_REMOTE_SPLIT' | 'SEC_REFUSE_URL_REWRITE';
export interface DaemonIo { out(line: string): void; err(line: string): void; onStop(cb: () => void): void; }

export const DAEMON_USAGE = [
  'usage: node dist/daemon.js run --repo <path> --branch <b> [--publish=all|none] [--name <display>] [--remote <name>]',
  '       node dist/daemon.js recover --repo <path> --branch <b> [--confirm=<id>] [--remote <name>]',
  '       node dist/daemon.js resume --repo <path> --branch <b> [--remote <name>]',
  '       node dist/daemon.js --version',
].join('\n');

/** The options each command accepts. */
const ALLOWED: Readonly<Record<DaemonCommand, ReadonlySet<string>>> = {
  run: new Set(['repo', 'branch', 'publish', 'name', 'remote']),
  recover: new Set(['repo', 'branch', 'confirm', 'remote', 'name']),
  resume: new Set(['repo', 'branch', 'remote', 'name']),
};
const COMMANDS: ReadonlySet<string> = new Set<DaemonCommand>(['run', 'recover', 'resume']);

/** The branch name passes refNames' checks (an over-long enc(b) is a start refusal, not a usage error). */
function branchNameOk(branch: string): boolean {
  try {
    refNames(branch, RELEASE_NAMESPACE);
    return true;
  } catch (e) {
    return e instanceof EncTooLongError;
  }
}

export function parseDaemonArgs(argv: readonly string[]): DaemonArgs | { usage: string; exitCode: 0 | 2 } {
  const bad = (why: string): { usage: string; exitCode: 2 } => ({ usage: `${why}\n${DAEMON_USAGE}`, exitCode: 2 });
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) return { usage: DAEMON_USAGE, exitCode: 0 };
  const cmd = argv[0]!;
  if (!COMMANDS.has(cmd)) return bad(`unknown command ${JSON.stringify(cmd)}`);
  const opts = new Map<string, string>();
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    const m = /^--([a-z]+)(?:=(.*))?$/s.exec(a);
    if (m === null) return bad(`unexpected argument ${JSON.stringify(a)}`);
    const key = m[1]!;
    let value = m[2];
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) return bad(`--${key} needs a value`);
      value = next;
      i++;
    }
    if (!ALLOWED[cmd as DaemonCommand].has(key)) return bad(`--${key} is not an option of ${cmd}`);
    if (opts.has(key)) return bad(`--${key} given twice`);
    if (value.length === 0 || /[\0\r\n]/.test(value)) return bad(`--${key} needs a value`);
    opts.set(key, value);
  }
  const repo = opts.get('repo');
  const branch = opts.get('branch');
  if (repo === undefined || branch === undefined) return bad('--repo and --branch are required');
  // A name git cannot carry under refs/heads/ is a usage error (final review FC minor: never DAEMON_INTERNAL_ERROR); an
  // over-long enc(b) is a start refusal (START_BRANCH_NAME{too_long}, daemonMain).
  if (!branchNameOk(branch)) return bad('--branch: not a branch name git accepts');
  const publish = opts.get('publish') ?? null;
  if (publish !== null && publish !== 'all' && publish !== 'none') return bad('--publish is all or none');
  const name = opts.get('name') ?? null;
  if (name !== null && !validName(name)) return bad('--name: letters, digits, spaces and _ . \' - only, at most 64');
  const confirm = opts.get('confirm') ?? null;
  if (confirm !== null && !/^[0-9a-f]{6}$/.test(confirm)) return bad('--confirm takes the 6-hex preview id');
  return { cmd: cmd as DaemonCommand, repo, branch, publish, name, remote: opts.get('remote') ?? null, confirm };
}

/** Drops userinfo from a URL (the contract's name for src/sec/redact.ts's sanitizeUrl). */
export const sanitizeUrl: (url: string) => string = redactUrl;

/**
 * LIF-05 / SEC-11 steps 1–3: branch.<b>.pushRemote → remote.pushDefault → branch.<b>.remote → --remote → the only remote
 * (origin is never assumed); fetch URL == push URL (both after rewrites), else SEC_REFUSE_REMOTE_SPLIT; no insteadOf /
 * pushInsteadOf value prefixing the push URL or the literal configured URL, else SEC_REFUSE_URL_REWRITE{remote, key,
 * key_redacted, file, prefix, url} (key: ruleKey). Params carry URLs without userinfo.
 */
export async function resolveRemote(repo: GitRepo, branch: string, explicit: string | null): Promise<ResolvedRemote | { refuse: RemoteRefusal; params: Record<string, Json> }> {
  const remotes = new Set<string>();
  for (const { key } of await repo.configGetRegexp('^remote\\..+\\.url$')) remotes.add(key.slice('remote.'.length, key.length - '.url'.length));
  const setting = async (key: string): Promise<string | null> => {
    const v = await repo.configGet(key);
    return v === null || v.trim().length === 0 ? null : v.trim();
  };
  const name = (await setting(`branch.${branch}.pushRemote`)) ?? (await setting('remote.pushDefault')) ?? (await setting(`branch.${branch}.remote`))
    ?? explicit ?? (remotes.size === 1 ? [...remotes][0]! : null);
  if (name === null) return { refuse: 'START_REMOTE', params: { reason: 'no_remote' } };
  if (!remotes.has(name) || name.startsWith('-')) return { refuse: 'START_REMOTE', params: { reason: 'no_remote', remote: name } };
  const getUrl = async (push: boolean): Promise<string | null> => {
    const r = await repo.run(['remote', 'get-url', ...(push ? ['--push'] : []), name], { okCodes: [0, 1, 2, 128] });
    const u = r.stdout.toString('utf8').trim();
    return r.code === 0 && u.length > 0 ? u : null;
  };
  const urlF = await getUrl(false);
  const urlP = await getUrl(true);
  if (urlF === null || urlP === null) return { refuse: 'START_REMOTE', params: { reason: 'no_remote', remote: name } };
  if (urlF !== urlP) return { refuse: 'SEC_REFUSE_REMOTE_SPLIT', params: { remote: name, fetch_url: sanitizeUrl(urlF), push_url: sanitizeUrl(urlP) } };
  const literal = (await repo.configGet(`remote.${name}.url`)) ?? urlP;
  for (const { origin, key, value } of await rewriteRules(repo)) {
    if (value.length > 0 && (urlP.startsWith(value) || literal.startsWith(value))) {
      const shown = ruleKey(key);
      return {
        refuse: 'SEC_REFUSE_URL_REWRITE',
        params: { remote: name, key: shown.key, key_redacted: shown.redacted, file: origin, prefix: sanitizeUrl(value), url: sanitizeUrl(literal) },
      };
    }
  }
  return { name, url: urlP };
}

/**
 * Every url.<base>.insteadOf / pushInsteadOf rule with the file that holds it (`git config --show-origin`; a relative
 * file is the repository's own config, resolved against the work tree; a non-file origin, such as the command line, is
 * shown as git names it).
 */
async function rewriteRules(repo: GitRepo): Promise<Array<{ origin: string; key: string; value: string }>> {
  const r = await repo.run(['config', '--show-origin', '-z', '--get-regexp', '^url\\..*\\.(insteadof|pushinsteadof)$'], { okCodes: [0, 1] });
  if (r.code !== 0) return [];
  const parts = r.stdout.toString('utf8').split('\0');
  const out: Array<{ origin: string; key: string; value: string }> = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const origin = parts[i]!;
    const rec = parts[i + 1]!;
    const nl = rec.indexOf('\n');
    const file = origin.startsWith('file:') ? resolvePath(repo.paths.workTree, origin.slice('file:'.length)) : origin;
    out.push(nl < 0 ? { origin: file, key: rec, value: '' } : { origin: file, key: rec.slice(0, nl), value: rec.slice(nl + 1) });
  }
  return out;
}

/**
 * The rewrite rule's key as shown: exactly as git names it (`url.<base>.insteadof`, so a printed `git config --unset-all`
 * finds it) when its base holds no userinfo or only an scp-form user name (`git@host:`); otherwise — scheme userinfo, a
 * password or token — the base without it, marked redacted (that key cannot be printed exactly).
 */
function ruleKey(key: string): { key: string; redacted: boolean } {
  const m = /^url\.(.*)\.(insteadof|pushinsteadof)$/is.exec(key);
  if (m === null) return { key: sanitizeText(key), redacted: true };
  const base = m[1]!;
  const kind = userinfoKind(base);
  if (kind !== 'secret') return { key, redacted: false };
  const clean = sanitizeUrl(base);
  return { key: `url.${clean.includes('@') ? clean.slice(clean.lastIndexOf('@') + 1) : clean}.${m[2]!}`, redacted: true };
}

/** Respawns of the Engine after an iteration error within one `run` (each a RESTART from disk), and their spacing. */
export const RESPAWN_LIMIT = 5;
export const RESPAWN_WINDOW_MS = 600_000;
const RESPAWN_BASE_MS = 2_000;
const RESPAWN_MAX_MS = 60_000;

/**
 * LIF-06's respawn column inside one `run` (the hook-side respawn of CCI-51 is Plan 5): an iteration error (a crash)
 * rebuilds the Engine from disk and starts it again (RESTART). Only crashes count — a stop, a lease drain and a start
 * refusal end the command, a lost state CAS exits at once — and only those of the last RESPAWN_WINDOW_MS (Δmono): up to
 * RESPAWN_LIMIT respawns per window, each after a delay doubling with the crashes still in the window (2 s … ≤ 60 s);
 * one more crash inside the window is a crash loop and ends the daemon (exit 2). A transient crash now and then never
 * adds up to an exit.
 */
export class RespawnBudget {
  private readonly clock: Clock;
  private readonly limit: number;
  private crashes: number[] = [];

  constructor(clock: Clock, limit = RESPAWN_LIMIT) {
    this.clock = clock;
    this.limit = limit;
  }

  /** Records a crash now: the delay before its respawn, or null when the window holds the limit already (exit). */
  crash(): number | null {
    const now = this.clock.monoMs();
    this.crashes = this.crashes.filter((t) => now - t < RESPAWN_WINDOW_MS);
    if (this.crashes.length >= this.limit) return null;
    this.crashes.push(now);
    return Math.min(RESPAWN_MAX_MS, RESPAWN_BASE_MS * 2 ** (this.crashes.length - 1));
  }

  /** Crashes inside the window (the respawn about to run included). */
  inWindow(): number {
    return this.crashes.length;
  }
}

/** POSIX sh: a word of these characters needs no quotes. */
const POSIX_BARE = /^[A-Za-z0-9_./:@+=,-]+$/;
/**
 * cmd.exe and PowerShell: a word of these characters, starting with a letter, needs no quotes in either (PowerShell reads
 * a bare leading @ as splatting, a bare , as an array operator and a bare leading digit as a number, e.g. 1kb).
 */
const WIN_BARE = /^[A-Za-z][A-Za-z0-9_./:\\=+-]*$/;
/**
 * Characters no Windows quoting keeps literal in both shells: inside double quotes cmd.exe expands %VAR% (and !VAR!
 * under delayed expansion), PowerShell expands $… and reads ` as its escape, and " — or a typographic double quote,
 * which PowerShell also reads as one — ends the quotes.
 */
const WIN_UNQUOTABLE = /["%!$`“”„]/;
/** A control character (a newline, a terminal escape) is never printed inside a command. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * One word of a printed next command, quoted for the OS shell, or null when it cannot be quoted safely there (the caller
 * prints a placeholder instead). POSIX sh: single quotes (a quote inside is closed, escaped and reopened; nothing else is
 * special). Windows (cmd.exe and PowerShell alike): double quotes, with a trailing run of backslashes doubled so the
 * program's argument parser still reads the closing quote as one; a word holding a character either shell expands or
 * reads as a quote inside double quotes (WIN_UNQUOTABLE) is refused. A word of plain characters stays bare; a control
 * character is refused everywhere.
 */
export function shellQuote(s: string, platform: NodeJS.Platform = process.platform): string | null {
  if (s.length === 0 || CONTROL.test(s)) return null;
  if (platform === 'win32') {
    if (WIN_BARE.test(s)) return s;
    if (WIN_UNQUOTABLE.test(s)) return null;
    return `"${s.replace(/\\+$/, (run) => run + run)}"`;
  }
  if (POSIX_BARE.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A word of a printed command: quoted for the OS shell, or `<what>` where no quoting is safe (the human fills it in). */
function word(s: string, what: string, platform: NodeJS.Platform = process.platform): string {
  return shellQuote(s, platform) ?? `<${what}>`;
}

/** sha256 of the running bundle (plugin_sha of the join op); of the version when the file cannot be read. */
async function pluginSha(): Promise<string> {
  try {
    return createHash('sha256').update(await realFs.readFile(fileURLToPath(import.meta.url))).digest('hex');
  } catch {
    return createHash('sha256').update(`cowork-sync ${PLUGIN_VERSION}`, 'utf8').digest('hex');
  }
}

/** Every line passes the userinfo filter; `keep` names exact words it leaves alone (sanitizeText: never scheme userinfo). */
interface Printer { out(line: string, keep?: readonly string[]): void; err(line: string): void; }

/** Exit 0 success, 1 refusal (code + one next command), 2 internal error. */
export async function runDaemon(args: DaemonArgs, env: Readonly<Record<string, string | undefined>>, io: DaemonIo): Promise<number> {
  const p: Printer = { out: (l, keep) => io.out(sanitizeText(l, keep)), err: (l) => io.err(sanitizeText(l)) };
  try {
    return await daemonMain(args, env, io, p);
  } catch (e) {
    p.err(`DAEMON_INTERNAL_ERROR ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    return 2;
  }
}

function refusal(p: Printer, code: string, params: Record<string, Json>, next: string, keep: readonly string[] = []): number {
  p.out(`${code} ${JSON.stringify(params)}`, keep);
  p.out(`next: ${next}`, keep);
  return 1;
}

async function daemonMain(args: DaemonArgs, env: Readonly<Record<string, string | undefined>>, io: DaemonIo, p: Printer): Promise<number> {
  const fs = realFs;
  const self = selfCommand(args);
  const again = `fix the condition above, then: ${self(args.cmd)}`;

  // The repository: a main worktree whose .git is a directory (linked worktrees and submodules are refused).
  let workTree: string;
  try {
    workTree = await fs.realpath(args.repo);
  } catch (e) {
    if (errnoCode(e) === 'ENOENT' || errnoCode(e) === 'ENOTDIR') return refusal(p, 'START_REPO_SHAPE', { reason: 'no_repo' }, again);
    throw e;
  }
  const gitDir = join(workTree, '.git');
  if ((await fs.lstat(gitDir))?.isDirectory !== true) return refusal(p, 'START_REPO_SHAPE', { reason: 'not_a_main_worktree' }, again);
  const paths: RepoPaths = { workTree, gitDir, coworkDir: join(gitDir, 'cowork') };
  try {
    refNames(args.branch, RELEASE_NAMESPACE);
  } catch (e) {
    // 08-lifecycle §1.2: enc(b) > 150 bytes refuses START_BRANCH_NAME{reason: too_long} (final review FC minor); a name
    // git cannot carry is the usage error parseDaemonArgs reports (here too, for a caller that skipped it).
    if (e instanceof EncTooLongError) {
      const params = { reason: 'too_long', other: null };
      return refusal(p, 'START_BRANCH_NAME', params, startRefusalNext('START_BRANCH_NAME', params, args, ''));
    }
    p.err(`--branch: not a branch name git accepts\n${DAEMON_USAGE}`);
    return 2;
  }
  const daemonEnv = buildDaemonEnv({ ...env }, []);
  const hooksPath = join(paths.coworkDir, 'empty-hooks');
  const probe = createGitRunner({ clock: realClock, hooksPath, daemonEnv });

  // The git floor (glossary §18).
  const v = await probe.run(['version'], { class: 'local', cwd: workTree });
  const version = v.code === 0 ? parseGitVersion(v.stdout.toString('utf8')) : null;
  if (version === null || !meetsFloor(version)) {
    return refusal(p, 'START_TOOL_VERSION', { git: version?.raw ?? null, floor: GIT_FLOOR.raw }, `install git ${GIT_FLOOR.raw} or newer, then: ${self(args.cmd)}`);
  }
  const userRepo = (runner: GitRunner): GitRepo => {
    const ctx = (): RepoContext => ({ attrTree: null, filterDrivers: [], identity: { name: 'cowork', email: 'daemon@cowork.invalid' }, wallMs: () => realClock.wallMs() });
    return new GitRepo(runner, paths, ctx);
  };
  const config = userRepo(probe);

  // The remote (LIF-05, SEC-11).
  const remote = await resolveRemote(config, args.branch, args.remote);
  if ('refuse' in remote) {
    // An exact rewrite-rule key (key_redacted false: its base holds no scheme userinfo) is printed as it is, an scp-form
    // user part included, so the printed command names the rule that exists.
    const key = remote.params['key'];
    const keep = remote.refuse === 'SEC_REFUSE_URL_REWRITE' && remote.params['key_redacted'] === false && typeof key === 'string' ? [key] : [];
    return refusal(p, remote.refuse, remote.params, remoteRefusalNext(remote.refuse, remote.params, args), keep);
  }
  const sshCommand = await config.configGet('core.sshCommand');
  const userName = await config.configGet('user.name');
  const display = args.name ?? (userName !== null && validName(userName.trim()) ? userName.trim() : 'cowork peer');

  // daemon.lock before anything in <coworkDir> is touched (R-26; restart and every own-leftover deletion run under it).
  const lock = await DaemonLock.acquire(fs, paths.coworkDir, { pluginVersion: PLUGIN_VERSION, instance: randomHex(realRandom, 16) });
  if (!(lock instanceof DaemonLock)) {
    const pid = lock.held?.pid ?? null;
    const file = join(paths.coworkDir, DAEMON_LOCK_FILE);
    return refusal(p, 'DAEMON_ALREADY_RUNNING', { pid }, `stop the daemon running on this clone${pid === null ? '' : ` (pid ${pid})`} — or, if none runs, delete ${word(file, 'lock file')} — then: ${self(args.cmd)}`);
  }
  let log: FileLog | null = null;
  try {
    await fs.mkdirp(join(paths.coworkDir, 'log'));
    log = fileLog(fs, realClock, join(paths.coworkDir, 'log', 'daemon-0.jsonl'));
    const runner = createGitRunner({ clock: realClock, hooksPath, daemonEnv, ...(sshCommand !== null ? { sshCommand } : {}), testBuild: false });
    const deps: EngineDeps = {
      ports: { clock: realClock, random: realRandom, scheduler: realScheduler(realClock), fs, git: runner },
      trace: noTrace, log, lease: alwaysLeased, attribution: humanOnlyAttribution, heartbeatMs: machineMonoMs,
      paths, branch: args.branch, namespace: RELEASE_NAMESPACE, url: remote.url, display,
      pluginVersion: PLUGIN_VERSION, pluginSha: await pluginSha(), regionSpec: PLAN2_REGION_SPEC,
      platform: process.platform, testBuild: false, testMutants: new Set(),
    };
    log.write('info', 'DAEMON_START', { cmd: args.cmd, pid: process.pid, git: version.raw });
    switch (args.cmd) {
      case 'run':
        return await runCommand(args, deps, log, io, p, self);
      case 'recover':
        return await recoverCommand(args, deps, p, self);
      case 'resume':
        return await resumeCommand(deps, p, self);
    }
    throw new Error(`daemonMain: unknown command ${JSON.stringify(args.cmd)}`);
  } finally {
    // The lock is released whatever the command did; a failing release is reported and never replaces the command's
    // exit code (the next run replaces a lock this process left behind). The log queue is flushed last.
    try {
      await lock.release();
    } catch (e) {
      const code = errnoCode(e) ?? (e instanceof Error ? e.name : 'unknown');
      log?.write('error', 'DAEMON_LOCK_RELEASE_FAILED', { code });
      p.err(`DAEMON_LOCK_RELEASE_FAILED ${code} (the next run replaces ${word(lock.file, 'lock file')})`);
    }
    await log?.flush();
  }
}

type SelfCommand = (cmd: DaemonCommand, extra?: string) => string;

/** This daemon's own command line for a printed next step, every word quoted for the OS shell (or a placeholder). */
function selfCommand(args: DaemonArgs, platform: NodeJS.Platform = process.platform): SelfCommand {
  return (cmd, extra = '') => `node dist/daemon.js ${cmd} --repo ${word(args.repo, 'repo path', platform)} --branch ${word(args.branch, 'branch', platform)}${extra}`;
}

/**
 * The one next command of a remote refusal (LIF-05, SEC-11), every word quoted for the OS shell. SEC_REFUSE_URL_REWRITE:
 * `git config --file <file> --unset-all <key>` names the exact rule (resolveRemote's key, key_redacted false); a key
 * whose base holds scheme userinfo is never printed, so the command opens the file for the human instead (--edit). A command the human
 * copies is followed by " — then: ", never by a comma: a bare POSIX word keeps a comma glued to it (POSIX_BARE admits one).
 */
export function remoteRefusalNext(refuse: RemoteRefusal, params: Readonly<Record<string, Json>>, args: DaemonArgs, platform: NodeJS.Platform = process.platform): string {
  const self = selfCommand(args, platform);
  if (refuse === 'START_REMOTE') {
    return `${self(args.cmd, ' --remote <name>')}, or name the branch's remote first: git config ${word(`branch.${args.branch}.remote`, 'branch.name.remote', platform)} <name>`;
  }
  if (refuse === 'SEC_REFUSE_REMOTE_SPLIT') {
    return `make the fetch and push URLs of the remote ${word(String(params['remote']), 'remote', platform)} equal (git remote -v shows both), then: ${self(args.cmd)}`;
  }
  const file = word(String(params['file']), 'config file', platform);
  const key = params['key_redacted'] === false ? shellQuote(String(params['key']), platform) : null;
  if (key !== null) return `remove the rewrite rule: git config --file ${file} --unset-all ${key} — then: ${self(args.cmd)}`;
  return `remove the rewrite rule ${String(params['key'])} (its URL's userinfo is not shown) from the file: git config --file ${file} --edit — then: ${self(args.cmd)}`;
}

/**
 * The one next command of a start refusal (08-lifecycle Table 2.7-A, final review FC minor: every code its own; the
 * remote named by its URL without userinfo). A git command the human copies is followed by " — then: ", never by a comma (as above).
 */
export function startRefusalNext(code: string, params: Readonly<Record<string, Json>>, args: DaemonArgs, url: string, platform: NodeJS.Platform = process.platform): string {
  const self = selfCommand(args, platform);
  const branch = word(args.branch, 'branch', platform);
  const remote = sanitizeUrl(url);
  switch (code) {
    case 'START_PREVIEW': return `${self('run', ' --publish=all')} to share the local work, or ${self('run', ' --publish=none')} to hold it`;
    case 'START_HEAD_STATE': return `git switch ${branch} and finish or abort any operation in progress, then: ${self(args.cmd)}`;
    case 'START_HEAD_BEHIND': return `git pull --ff-only — then: ${self(args.cmd)}`;
    case 'START_HEAD_AHEAD': return `git push your commits to ${branch} first (base moves arrive in a later plan), then: ${self(args.cmd)}`;
    case 'START_REMOTE':
      switch (params['reason']) {
        case 'local_ref_update':
          return `the remote answered, but a ref under .git/refs/cowork-remote could not be updated (another git process, or a stale .lock file there): check git for-each-ref refs/cowork-remote/ — then: ${self(args.cmd)}`;
        case 'board_malformed':
          return `the cowork board of ${branch} on ${remote} is not one this plugin can read; a teammate whose cowork runs on ${branch} can run: node dist/daemon.js recover --repo <their clone> --branch ${branch}; then: ${self(args.cmd)}`;
        case 'genesis_push_failed':
          return `the remote ${remote} refused cowork's first push (the refs/cowork/ board and code refs): check that you may push there, then: ${self(args.cmd)}`;
        default:
          return `check the network and the remote ${remote}, then: ${self(args.cmd)}`;
      }
    case 'START_BRANCH_NOT_ON_REMOTE': {
      const name = typeof params['remote'] === 'string' ? word(params['remote'], 'remote', platform) : '<remote>';
      return `git push -u ${name} ${branch} — then: ${self(args.cmd)}`;
    }
    case 'GENESIS_BOARD_MISSING':
      return `the cowork board of ${branch} is gone while its code is still there: a teammate whose cowork has state for ${branch} runs: node dist/daemon.js recover --repo <their clone> --branch ${branch}; then: ${self(args.cmd)}`;
    case 'START_VERSION':
    case 'START_STATE_NEWER':
      return `update cowork-sync (the ${code === 'START_VERSION' ? 'board' : 'state'} was written by a newer plugin), then: ${self(args.cmd)}`;
    case 'START_REPO_IDENTITY':
      return `this clone now points at a different repository; fix the remote (git remote -v shows it), then: ${self(args.cmd)}`;
    case 'START_REFUSED_CUSTOM_REFS':
      return `the host refuses cowork's refs/cowork/ refs: allow them on the host, or set host.fallbackNamespace: true in .cowork/config.json (it creates refs/heads/cowork/* branches visible to CI), then: ${self(args.cmd)}`;
    case 'START_REFUSED_NO_LEASE':
      return `the host does not enforce git push --force-with-lease, so cowork cannot publish there safely; use a host that does, then: ${self(args.cmd)}`;
    case 'START_BRANCH_NAME': {
      const why = params['reason'] === 'case_fold' && typeof params['other'] === 'string'
        ? `the branch ${word(params['other'], 'other branch', platform)} of this clone has cowork refs under the same name but for case`
        : 'its encoded name is longer than 150 bytes';
      return `use a different branch name (${why}): git branch -m <new name> — then: node dist/daemon.js ${args.cmd} --repo ${word(args.repo, 'repo path', platform)} --branch <new name>`;
    }
    case 'START_REPO_SHAPE':
      if (params['reason'] === 'tmp_volume') {
        return `keep this clone's .git directory on the same volume as its work tree (no .git link or mount to another drive: cowork renames files between .git/cowork/tmp and the work tree), then: ${self(args.cmd)}`;
      }
      return `fix the condition above, then: ${self(args.cmd)}`;
    default: return `fix the condition above, then: ${self(args.cmd)}`;
  }
}

/** How often `run` looks for <coworkDir>/stop-request (`cowork stop`). */
export const STOP_POLL_MS = 500;

/**
 * `cowork stop` (src/cli): while `run` runs, <coworkDir>/stop-request is looked for every STOP_POLL_MS; once it is there, the
 * daemon stops as on a stop signal (drain: status down, exit 0). A request left behind by an earlier run is removed once
 * daemon.lock is held (nothing in <coworkDir> is touched before it), and the request is removed again when `run` ends. The
 * poller's timer is cleared when `run` ends.
 */
function watchStopRequest(deps: EngineDeps, onRequest: () => void): { stop(): Promise<void> } {
  const fs = deps.ports.fs;
  const file = join(deps.paths.coworkDir, STOP_REQUEST_FILE);
  let active = true;
  let busy = false;
  const timer = setInterval(() => {
    if (!active || busy) return;
    busy = true;
    fs.lstat(file).then((st) => {
      if (active && st !== null) onRequest();
    }, () => undefined).finally(() => {
      busy = false;
    });
  }, STOP_POLL_MS);
  timer.unref();
  return {
    async stop() {
      active = false;
      clearInterval(timer);
      await fs.unlink(file).catch(() => undefined);
    },
  };
}

async function runCommand(args: DaemonArgs, deps: EngineDeps, log: Log, io: DaemonIo, p: Printer, self: SelfCommand): Promise<number> {
  let stopRequested = false;
  let stopNow: (() => void) | null = null;
  let wakeSleep: (() => void) | null = null;
  const requestStop = (): void => {
    stopRequested = true;
    stopNow?.();
    wakeSleep?.();
  };
  io.onStop(requestStop);
  // A stop request an earlier run left behind (it ended before it saw the request) never stops this one.
  await deps.ports.fs.unlink(join(deps.paths.coworkDir, STOP_REQUEST_FILE)).catch(() => undefined);
  const watcher = watchStopRequest(deps, requestStop);
  try {
    return await runIterations(args, deps, log, p, () => stopRequested, {
      setStopNow: (f) => { stopNow = f; },
      setWakeSleep: (f) => { wakeSleep = f; },
    });
  } finally {
    await watcher.stop();
  }
}

interface StopHooks { setStopNow(f: (() => void) | null): void; setWakeSleep(f: (() => void) | null): void; }

async function runIterations(args: DaemonArgs, deps: EngineDeps, log: Log, p: Printer, stopRequestedNow: () => boolean, hooks: StopHooks): Promise<number> {
  const budget = new RespawnBudget(deps.ports.clock);
  // The last Engine built: a stop during the respawn sleep drains it, so status.json says `down` (final review FC minor).
  let last: Engine | null = null;
  for (;;) {
    try {
      const engine = await Engine.create(deps);
      last = engine;
      const r = await engine.start({ publishLocal: args.publish });
      if (!r.ok) return refusal(p, r.code, r.params, startRefusalNext(r.code, r.params, args, deps.url));
      p.out(`started ${r.mode} on ${args.branch} as peer ${engine.peerId}`);
      const handle = runLoop(engine, { scheduler: deps.ports.scheduler, clock: deps.ports.clock, lease: deps.lease });
      const stopNow = (): void => void handle.stop().catch(() => undefined);
      hooks.setStopNow(stopNow);
      if (stopRequestedNow()) stopNow();
      await handle.finished;
      hooks.setStopNow(null);
      p.out(engine.lastStatusJson()?.message_code === 'IDLE_NO_SESSION' ? 'stopped: no session for 10 min (IDLE_NO_SESSION)' : 'stopped');
      return 0;
    } catch (e) {
      hooks.setStopNow(null);
      if (e instanceof StateCasLostError || e instanceof RegistryCasLostError) {
        log.write('security', 'STATE_CAS_LOST', { error: e.name });
        p.err(`STATE_CAS_LOST another writer moved this clone's cowork state; this daemon exits`);
        return 2;
      }
      if (e instanceof KilledAt || stopRequestedNow()) throw e;
      const delay = budget.crash();
      if (delay === null) throw e;   // a crash loop: the 6th crash inside the window (exit 2)
      log.write('error', 'DAEMON_RESPAWN', { error: e instanceof Error ? e.name : 'unknown', in_window: budget.inWindow(), delay_ms: delay });
      p.err(`DAEMON_RESPAWN ${e instanceof Error ? e.name : 'error'} (restart ${budget.inWindow()} of ${RESPAWN_LIMIT} within ${RESPAWN_WINDOW_MS / 60_000} min)`);
      await new Promise<void>((resolve) => {
        hooks.setWakeSleep(resolve);
        void deps.ports.clock.sleep(delay).then(resolve);
      });
      hooks.setWakeSleep(null);
      if (stopRequestedNow()) {
        await drainAfterCrash(last, log);
        return 0;
      }
    }
  }
}

/**
 * A stop during the respawn sleep: the crashed Engine (the last one built, its in-memory view as it was) drains, which
 * writes status.json `down` as any stop does; a failing drain is logged and never changes the exit. Without an Engine
 * (the first Engine.create crashed) nothing is written.
 */
async function drainAfterCrash(engine: Engine | null, log: Log): Promise<void> {
  if (engine === null) return;
  try {
    await engine.drain(null);
  } catch (e) {
    log.write('error', 'DAEMON_DRAIN_FAILED', { error: e instanceof Error ? e.name : 'unknown' });
  }
}

async function recoverCommand(args: DaemonArgs, deps: EngineDeps, p: Printer, self: SelfCommand): Promise<number> {
  const engine = await Engine.create(deps);
  try {
    if (engine.core.view === null) return refusal(p, 'RECOVER_NOT_IN_INCIDENT', {}, `nothing to recover: ${self('run')}`);
    const r = await engine.start({ publishLocal: null });
    if (!r.ok) return refusal(p, r.code, r.params, startRefusalNext(r.code, r.params, args, deps.url));
    const rec = await engine.recover(args.confirm);
    if (!rec.ok) return refusal(p, rec.code, rec.params, `fix the condition above, then: ${self('recover')}`);
    const pv = rec.preview;
    const v = pv.V === ABSENT ? 'ABSENT' : pv.V;
    if (!rec.done) {
      p.out(`RECOVER_PREVIEW mode=${pv.mode} id=${pv.id} board=${v} target=${pv.X ?? 'none'} candidates=${pv.candidates.length} restart_records=${pv.restartPaths.length}`);
      for (const path of pv.restartPaths.slice(0, 50)) p.out(`  restart record: ${path}`);
      if (args.confirm !== null) p.out('the preview changed since the id was shown: review it again');
      p.out(`next: ${self('recover', ` --confirm=${pv.id}`)}`);
      return 0;
    }
    p.out(`RECOVERED mode=${pv.mode} board=${v} target=${pv.X ?? 'none'}`);
    p.out(`next: ${self('run')}`);
    return 0;
  } finally {
    await engine.drain(null);
  }
}

async function resumeCommand(deps: EngineDeps, p: Printer, self: SelfCommand): Promise<number> {
  const engine = await Engine.create(deps);
  try {
    const changed = await engine.resumeAfterNonretryable();
    p.out(changed ? 'RESUMED the next run retries the rejected publish once' : 'RESUME_NOTHING no NONRETRYABLE pause on this branch');
    p.out(`next: ${self('run')}`);
    return 0;
  } finally {
    await engine.drain(null);
  }
}
