// The start, stop, status and help verbs of cli.js (v0.1.0-preview), over an injectable environment.
//
//   start   in the git work tree of the cwd (refused outside one, or without any remote, or with HEAD off a branch), unless a live
//           daemon already holds daemon.lock: spawns `node <plugin root>/dist/daemon.js run --repo <top> --branch <b> …` in the
//           background (launch.ts) and prints its outcome: started (exit 0), the daemon's own refusal with its next command written
//           for this CLI (exit 1; 2 for a usage or internal error of the daemon), or still starting after the time limit (exit 0)
//   stop    writes <gitdir>/cowork/stop-request (the daemon drains to status down and releases daemon.lock) and waits for the lock to
//           be released, writing the request again if it is gone while the same daemon still holds the lock (a daemon removes a
//           request it finds when it starts); never signals a pid. Not running: says so (exit 0); still draining at the time limit:
//           says so (exit 1)
//   status  the summary of statusText.ts; exit 0 when the daemon runs with a fresh status in state ok, else 1
//   help    the verbs; also printed, on stderr, when cli.js runs without arguments in a terminal or a slash command (in pipe mode
//           a bare cli.js prints nothing)
//
// Output mode (src/viz/cli/view.ts outputMode): in a Claude Code slash command (stdout not a TTY, CLAUDECODE set) every line goes to
// stdout and the exit code is 0, because a non-zero exit of a slash command's shell line hides its output; in a terminal or a pipe,
// refusals go to stderr and the exit codes above apply.
import { join } from 'node:path';
import { holderLive, DAEMON_LOG_FILE, STATUS_FILE, STOP_REQUEST_FILE } from '../engine/daemonFiles.js';
import type { GitRunner } from '../git/runner.js';
import { registerCatalog, render, type Params, type RenderChannel } from '../i18n/render.js';
import type { Clock } from '../ports/clock.js';
import type { Fs } from '../ports/fs.js';
import { PLUGIN_VERSION } from '../version.js';
import { outputMode, shellWord, terminalShell } from '../viz/cli/view.js';
import { daemonRunArgv, parseCoworkArgs, type StartOptions } from './args.js';
import { activePeers, currentBranch, findClone, readLockHolder, readStatusFile, remoteNames, type Clone } from './clone.js';
import type { DaemonLaunch, LaunchOutcome } from './launch.js';
import { statusSummary } from './statusText.js';
import { EN_COWORK_CLI } from './strings.js';

export interface CoworkEnv {
  pluginRoot: string; cwd: string; env: Readonly<Record<string, string | undefined>>; platform: NodeJS.Platform; isTTY: boolean;
  execPath: string;
  out(s: string): void; err(s: string): void;
  fs: Fs; clock: Clock; git: GitRunner;
  launchDaemon(l: DaemonLaunch): Promise<LaunchOutcome>;
  alive(pid: number): boolean;
  machineMono(): number;
  startTimeoutMs: number; stopTimeoutMs: number; stopPollMs: number;
}

export const START_TIMEOUT_MS = 90_000;
export const STOP_TIMEOUT_MS = 100_000;
export const STOP_POLL_MS = 250;

interface Out {
  c: string;
  channel: RenderChannel;
  say(code: string, p?: Params): void;
  refuse(code: string, p?: Params): number;
  raw(line: string, toErr: boolean): void;
}

/** A control or format character never reaches the terminal from a relayed daemon line. */
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/gu;

/**
 * The slash command of the plugin's commands/cowork.md: Claude Code names a plugin command `/<plugin>:<file>` (Claude Code 2.1.270
 * does not resolve the bare `/cowork`), so the full name is the one that always works.
 */
export const SLASH_COMMAND = '/cowork-sync:cowork';

/** The command prefix a person types: SLASH_COMMAND in a slash command, else `node "<plugin root>/dist/cli.js"` quoted for the terminal. */
export function commandPrefix(slash: boolean, pluginRoot: string, platform: NodeJS.Platform): string {
  if (slash) return SLASH_COMMAND;
  const sep = platform === 'win32' ? '\\' : '/';
  const root = pluginRoot.endsWith(sep) ? pluginRoot.slice(0, -1) : pluginRoot;
  return `node ${shellWord(`${root}${sep}dist${sep}cli.js`, terminalShell(platform))}`;
}

/**
 * A daemon line written for this CLI: the daemon's own command `node dist/daemon.js run --repo <r> --branch <b>` becomes
 * `<c> start` (with --branch when the user named one); any other `node dist/daemon.js` (recover, resume) gets the daemon's absolute
 * path, quoted for the terminal.
 */
export function relayDaemonLine(line: string, c: string, branchArg: string | null, daemonCmd: string): string {
  const word = String.raw`(?:"[^"]*"|'(?:[^']|'\\'')*'|<[^>]*>|\S+)`;
  const run = new RegExp(String.raw`node dist/daemon\.js run --repo ${word} --branch ${word}`, 'g');
  return line
    .replace(CONTROL_OR_FORMAT, '')
    .replace(run, `${c} start${branchArg === null ? '' : ` --branch ${branchArg}`}`)
    .replace(/node dist\/daemon\.js\b/g, daemonCmd);
}

export async function runCowork(argv: readonly string[], env: CoworkEnv): Promise<number> {
  let channel: RenderChannel = 'terminal';
  let slash = false;
  try {
    registerCatalog('en', EN_COWORK_CLI);
    const mode = outputMode(env.isTTY, env.env);
    // Without arguments in pipe mode cli.js stays the silent no-op Plan 1 made it (the every-entry bundle check and the viewer's
    // cli.js check run it so, and expect no output at all).
    if (argv.length === 0 && mode === 'pipe') return 0;
    slash = mode === 'slash';
    channel = slash ? 'slash' : 'terminal';
    const ch = channel;
    const o: Out = {
      c: commandPrefix(slash, env.pluginRoot, env.platform),
      channel: ch,
      say: (code, p = {}) => env.out(render(code, p, ch, 'en')),
      refuse: (code, p = {}) => {
        (slash ? env.out : env.err)(render(code, p, ch, 'en'));
        return 1;
      },
      raw: (line, toErr) => (toErr && !slash ? env.err : env.out)(line),
    };
    const code = await dispatch(argv, env, o);
    return slash ? 0 : code;
  } catch (e) {
    try {
      (slash ? env.out : env.err)(render('UI_COWORK_INTERNAL_ERROR', { what: e instanceof Error ? e.name : 'unknown' }, channel, 'en'));
    } catch {
      // the error stream itself failed: the exit code still says it
    }
    return slash ? 0 : 2;
  }
}

async function dispatch(argv: readonly string[], env: CoworkEnv, o: Out): Promise<number> {
  const cmd = parseCoworkArgs(argv);
  if ('usage' in cmd) {
    o.refuse('RF_COWORK_USAGE', { why: cmd.usage, c: o.c });
    return 2;
  }
  switch (cmd.verb) {
    case 'help': {
      const text = render('UI_COWORK_HELP', { version: PLUGIN_VERSION, c: o.c }, 'terminal', 'en');
      // Without arguments (a terminal, or a slash command) the help goes to stderr: cli.js run bare prints nothing on stdout (Plan 1's
      // bundle check). The slash command's shell line merges stderr into its output (2>&1), so `/cowork-sync:cowork` alone shows it.
      if (argv.length === 0) env.err(text);
      else env.out(text);
      return 0;
    }
    case 'start': return start(cmd, env, o);
    case 'stop': return stop(env, o);
    case 'status': return status(env, o);
  }
}

async function clone(env: CoworkEnv, o: Out, verb: string): Promise<Clone | number> {
  const c = await findClone(env.git, env.cwd);
  return c ?? o.refuse('RF_COWORK_NOT_A_REPO', { c: o.c, verb });
}

async function start(opts: StartOptions, env: CoworkEnv, o: Out): Promise<number> {
  const cl = await clone(env, o, 'start');
  if (typeof cl === 'number') return cl;
  if ((await remoteNames(env.git, cl.top)).length === 0) return o.refuse('RF_COWORK_NO_REMOTE', { c: o.c });
  const branch = opts.branch ?? (await currentBranch(env.git, cl.top));
  if (branch === null) return o.refuse('RF_COWORK_NO_BRANCH', { c: o.c });

  const holder = await readLockHolder(env.fs, cl.coworkDir);
  if (holder !== null && holderLive(holder, env.alive, env.machineMono())) {
    o.say('UI_COWORK_ALREADY_RUNNING');
    await printStatus(env, o, cl, true);
    return 0;
  }

  const sep = env.platform === 'win32' ? '\\' : '/';
  const daemonJs = `${env.pluginRoot}${sep}dist${sep}daemon.js`;
  const shell = terminalShell(env.platform);
  const outcome = await env.launchDaemon({
    execPath: env.execPath, daemonJs, argv: daemonRunArgv(cl.top, branch, opts), cwd: cl.top, env: env.env, timeoutMs: env.startTimeoutMs,
  });
  switch (outcome.kind) {
    case 'started':
      o.say('UI_COWORK_STARTED', { branch, mode: outcome.mode, c: o.c });
      return 0;
    case 'timeout':
      o.say('UI_COWORK_STARTING', { secs: Math.round(env.startTimeoutMs / 1_000), c: o.c });
      return 0;
    case 'spawn_failed':
      return o.refuse('RF_COWORK_START_FAILED', { why: outcome.why, daemon: daemonJs, c: o.c });
    case 'exited': {
      if (outcome.lines.length === 0) {
        return o.refuse('RF_COWORK_START_FAILED', { why: `the daemon exited with code ${String(outcome.code)} and printed nothing`, daemon: daemonJs, c: o.c });
      }
      const branchArg = opts.branch === null ? null : shellWord(opts.branch, shell);
      const daemonCmd = `node ${shellWord(daemonJs, shell)}`;
      o.raw(render('UI_COWORK_DAEMON_REFUSED', {}, o.channel, 'en'), true);
      for (const line of outcome.lines) o.raw(relayDaemonLine(line, o.c, branchArg, daemonCmd), true);
      return outcome.code === 1 ? 1 : 2;
    }
  }
}

async function stop(env: CoworkEnv, o: Out): Promise<number> {
  const cl = await clone(env, o, 'stop');
  if (typeof cl === 'number') return cl;
  const holder = await readLockHolder(env.fs, cl.coworkDir);
  if (holder === null || !holderLive(holder, env.alive, env.machineMono())) {
    o.say('UI_COWORK_NOT_RUNNING', { c: o.c });
    return 0;
  }
  const request = join(cl.coworkDir, STOP_REQUEST_FILE);
  const body = Buffer.from(`${holder.instance}\n`, 'utf8');
  const until = env.clock.monoMs() + env.stopTimeoutMs;
  await env.fs.writeFile(request, body);
  for (;;) {
    await env.clock.sleep(env.stopPollMs);
    const now = await readLockHolder(env.fs, cl.coworkDir);
    if (now === null || now.instance !== holder.instance || !holderLive(now, env.alive, env.machineMono())) {
      o.say('UI_COWORK_STOPPED', { c: o.c });
      return 0;
    }
    if (env.clock.monoMs() >= until) {
      o.say('UI_COWORK_STOP_PENDING', { secs: Math.round(env.stopTimeoutMs / 1_000), c: o.c });
      return 1;
    }
    // A daemon removes a request it finds as it starts: the same daemon still holding the lock gets it again.
    if ((await env.fs.lstat(request)) === null) await env.fs.writeFile(request, body);
  }
}

async function status(env: CoworkEnv, o: Out): Promise<number> {
  const cl = await clone(env, o, 'status');
  if (typeof cl === 'number') return cl;
  const holder = await readLockHolder(env.fs, cl.coworkDir);
  const live = holder !== null && holderLive(holder, env.alive, env.machineMono());
  return (await printStatus(env, o, cl, live)) ? 0 : 1;
}

/** Prints the summary; true when it is healthy. */
async function printStatus(env: CoworkEnv, o: Out, cl: Clone, live: boolean): Promise<boolean> {
  const st = await readStatusFile(env.fs, cl.coworkDir);
  const peers = st !== null && st !== 'unreadable' ? await activePeers(env.git, cl.top, st.branch, st.peer_id).catch(() => null) : null;
  const sum = statusSummary({
    live, status: st, nowMachineMono: env.machineMono(), peers,
    files: { status: join(cl.coworkDir, STATUS_FILE), log: join(cl.coworkDir, DAEMON_LOG_FILE) }, c: o.c,
  });
  for (const l of sum.lines) o.say(l.code, l.params);
  return sum.healthy;
}
