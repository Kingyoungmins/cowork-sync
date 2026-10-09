// The single git runner (glossary §18). This is the only file in src/ that may
// import node:child_process (lints L-PORTS, L-GIT-SPAWN).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { win32 } from 'node:path';
import type { Clock } from '../ports/clock.js';
import { buildGitInvocation, type GitBase, type GitCallOptions, type GitClass } from './flags.js';

/**
 * aborted (ruling P2-ABORT): GitCallOptions.abort fired before git exited, so the process tree was killed exactly like a
 * watchdog kill (or, when it fired before the spawn, nothing was started: code -1). Never set for a call that finished
 * on its own, nor for the never-killed ref-updating plumbing, which ignores the signal.
 */
export interface GitResult { code: number; stdout: Buffer; stderr: Buffer; killedByWatchdog: boolean; aborted: boolean; durationMs: number; }
export interface GitRunner { run(args: string[], opts: GitCallOptions): Promise<GitResult>; }
export interface GitRunnerDeps {
  clock: Clock;
  hooksPath: string;
  daemonEnv: Record<string, string>;
  gitPath?: string;
  platform?: NodeJS.Platform;
  testBuild?: boolean;
  watchdogOverrideMs?: number;
  /**
   * The user's `core.sshCommand`, resolved once by the caller (start path) with
   * `git config --get core.sshCommand`. Passed to GitBase unchanged; Task 8 applies the
   * 09-security §2 precedence (daemonEnv GIT_SSH_COMMAND > this > GIT_SSH > ssh) and appends BatchMode.
   */
  sshCommand?: string;
  /** Tests only: on Windows, the command run in place of `taskkill /pid <pid> /T /F` by a watchdog or abort kill. */
  winKillCommand?: (pid: number) => { file: string; args: string[] };
}

export const WATCHDOG = { fetch: 45_000, push: 90_000, readHash: 120_000 } as const;

/** Ref-updating plumbing: never killed, whatever the deps say (glossary §18). */
const NEVER_KILLED: ReadonlySet<string> = new Set(['update-ref', 'update-index', 'commit-tree', 'read-tree']);

/** Grace period for stdio to close after git exits (killed or not) before the streams are destroyed. */
const CLOSE_GRACE_MS = 5_000;
/**
 * Loop turns an expired close grace waits while output still arrives (final review minor, board). Each turn has a
 * poll phase, which reads what is already in git's pipes; a timer that expired during an event-loop stall runs before
 * that phase, so destroying the streams at once would cut off output written before the grace ran out and resolve
 * rc 0 with it. Bounded, so a descendant that keeps writing cannot hold the call open.
 */
const DRAIN_TURNS_MAX = 64;

/** The git subcommand: the first argument that is not a global option (-c/-C take a value). */
function subcommandOf(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-c' || a === '-C') { i++; continue; }
    if (a.startsWith('-')) continue;
    return a;
  }
  return undefined;
}

export function watchdogMs(args: string[], cls: GitClass): number | null {
  const sub = subcommandOf(args);
  if (sub === undefined || NEVER_KILLED.has(sub)) return null;
  if (sub === 'push') return WATCHDOG.push;
  if (sub === 'fetch') return WATCHDOG.fetch;
  if (cls === 'network') return WATCHDOG.fetch;
  if (sub === 'add' || sub === 'hash-object') return WATCHDOG.readHash;
  if (sub === 'cat-file' && args.includes('--filters')) return WATCHDOG.readHash;
  return null;
}

/**
 * The SystemRoot of the git environment (12 §9.7 item 5) when every case variant of the name (Windows spells it
 * SystemRoot, SYSTEMROOT, ...) holds the same drive-absolute path (`C:\…`; a root-relative `\Windows`, a drive-relative
 * `C:Windows`, a relative or a UNC path is refused), else null.
 */
function systemRootOf(env: Record<string, string>): string | null {
  let root: string | null = null;
  for (const [k, v] of Object.entries(env)) {
    if (k.toUpperCase() !== 'SYSTEMROOT') continue;
    if (!/^[A-Za-z]:[\\/]/.test(v) || !win32.isAbsolute(v) || (root !== null && v !== root)) return null;
    root = v;
  }
  return root;
}

/** How long a Windows tree kill may block the event loop (taskkill takes about 0.1-0.7 s). */
const TASKKILL_TIMEOUT_MS = 10_000;

/**
 * Kills git and every descendant. Uses the host OS, not deps.platform (which only shapes argv).
 *
 * The pid must still name this git while the kill runs (final review, production): Node holds git's process handle,
 * and so keeps the pid reserved, until its exit callback runs on the event loop. The callers check `exited` in the same
 * tick and every kill here is synchronous, so that callback cannot run in between. On Windows taskkill runs with
 * spawnSync: started with spawn, it took ~0.7 s while the loop went on, and a git that ended on its own in that window
 * had its handle closed and its pid released, so `/T /F` could end whatever process took the pid next, with its tree.
 * On POSIX the group kill is a single synchronous call.
 *
 * On Windows it runs <SystemRoot>\System32\taskkill.exe by absolute path with cwd <SystemRoot> (a bare name is looked
 * up in the current directory first, then along PATH, where a repository may have planted one; 12 §9.7 item 5);
 * without an absolute SystemRoot, or when taskkill cannot start, times out or exits non-zero, it kills git alone
 * through its handle (still held: the kill is synchronous). No bare executable name is ever spawned.
 */
function killTree(child: ChildProcess, deps: GitRunnerDeps, systemRoot: string | null): void {
  const pid = child.pid;
  // Node has seen the exit (and closed the handle): the pid may already name another process.
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const killGit = (): void => {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  };
  if (process.platform === 'win32') {
    const testCmd = deps.winKillCommand?.(pid);
    if (testCmd === undefined && systemRoot === null) {
      killGit();
      return;
    }
    const cmd = testCmd ?? { file: win32.join(systemRoot!, 'System32', 'taskkill.exe'), args: ['/PID', String(pid), '/T', '/F'] };
    const r = spawnSync(cmd.file, cmd.args, {
      ...(systemRoot !== null ? { cwd: systemRoot } : {}), shell: false, stdio: 'ignore', windowsHide: true, timeout: TASKKILL_TIMEOUT_MS,
    });
    if (r.error !== undefined || r.status !== 0) killGit();
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

export function createGitRunner(deps: GitRunnerDeps): GitRunner {
  const platform = deps.platform ?? process.platform;
  const gitPath = deps.gitPath ?? 'git';
  const systemRoot = systemRootOf(deps.daemonEnv);
  const base: GitBase = {
    hooksPath: deps.hooksPath,
    platform,
    daemonEnv: deps.daemonEnv,
    testBuild: deps.testBuild ?? false,
    ...(deps.sshCommand !== undefined ? { sshCommand: deps.sshCommand } : {}),
  };

  return {
    run(args: string[], opts: GitCallOptions): Promise<GitResult> {
      const inv = buildGitInvocation(args, opts, base);
      const sub = subcommandOf(args);
      const neverKilled = sub !== undefined && NEVER_KILLED.has(sub);
      const limit = neverKilled ? null : (deps.watchdogOverrideMs ?? watchdogMs(args, opts.class));
      // Ruling P2-ABORT: an abort kills like the watchdog, so the plumbing the watchdog never kills ignores it too.
      const signal = neverKilled ? undefined : opts.abort;
      const started = deps.clock.monoMs();

      return new Promise<GitResult>((resolve) => {
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        let killed = false;
        let aborted = false;
        let settled = false;
        let exited = false;
        let child: ChildProcess | undefined;
        let timer: NodeJS.Timeout | undefined;
        let grace: NodeJS.Timeout | undefined;

        const onAbort = (): void => {
          if (settled || exited || child === undefined) return; // git finished on its own; only stdio is still draining
          aborted = true;
          killTree(child, deps, systemRoot);
        };
        const finish = (code: number, extraErr?: string): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (grace) clearTimeout(grace);
          signal?.removeEventListener('abort', onAbort);
          if (extraErr !== undefined) err.push(Buffer.from(extraErr, 'utf8'));
          resolve({
            code,
            stdout: Buffer.concat(out),
            stderr: Buffer.concat(err),
            killedByWatchdog: killed,
            aborted,
            durationMs: deps.clock.monoMs() - started,
          });
        };

        if (signal?.aborted === true) {
          // Aborted before the spawn: nothing is started.
          aborted = true;
          finish(-1);
          return;
        }

        let proc: ChildProcess;
        try {
          proc = spawn(gitPath, inv.argv, {
            cwd: opts.cwd,
            env: inv.env,
            stdio: [opts.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
            windowsHide: true,
            // POSIX: own process group, so kill(-pid) reaches grandchildren.
            detached: process.platform !== 'win32',
          });
        } catch (e) {
          finish(-1, `spawn failed: ${(e as Error).message}`);
          return;
        }
        child = proc;

        let chunks = 0;
        proc.stdout!.on('data', (b: Buffer) => { chunks++; out.push(b); });
        proc.stderr!.on('data', (b: Buffer) => { chunks++; err.push(b); });
        proc.on('error', (e) => finish(-1, `spawn failed: ${e.message}`));
        let exitCode: number | null = null;
        // After the grace: one more loop turn (its poll phase reads what is pending in the pipes), and another while
        // that turn read something, up to DRAIN_TURNS_MAX; then the streams are destroyed.
        const drain = (seen: number, turns: number): void => {
          setImmediate(() => {
            if (settled) return;
            if (chunks !== seen && turns < DRAIN_TURNS_MAX) {
              drain(chunks, turns + 1);
              return;
            }
            proc.stdout?.destroy();
            proc.stderr?.destroy();
            finish(exitCode ?? -1);
          });
        };
        // Armed on every exit, not only after a watchdog kill or an abort: a descendant that outlives git and
        // still holds its stdout/stderr (a filter, a credential helper) must not hold the call open.
        proc.on('exit', (code) => {
          exited = true;
          exitCode = code;
          grace = setTimeout(() => drain(chunks, 0), CLOSE_GRACE_MS);
        });
        proc.on('close', (code) => finish(code ?? exitCode ?? -1));

        if (opts.stdin && proc.stdin) {
          proc.stdin.on('error', () => { /* git may exit before reading all of stdin */ });
          proc.stdin.end(opts.stdin);
        }

        if (limit !== null) {
          timer = setTimeout(() => {
            if (exited) return; // git finished on its own; only stdio is still draining
            killed = true;
            killTree(proc, deps, systemRoot);
          }, limit);
        }
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
}
