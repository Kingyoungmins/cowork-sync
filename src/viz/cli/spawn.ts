// Starting the viewer process and its ready handshake (12-visualizer section 3.2 items 2-3, VIZ-02; R-V12, R-V13).
// The CLI spawns `process.execPath --max-old-space-size=<150 + 16 per room beyond 8> <plugin root>/dist/viz.js serve …` without a
// shell, detached and hidden, with cwd = the data directory, the builder environment and <data dir>/log/viz-stderr.txt as its stderr,
// reads at most 512 bytes within 5 s (15 s on Windows), and accepts exactly one schema-valid line; anything else kills the child's
// whole process tree. No bare executable name is ever spawned. One of the three viz files allowed child_process (R-V34); the one viz
// file whose POSIX process-group kill `process.kill(-pgid, …)` (VIZ-02) L-PID-KILL allows, and it signals no bare pid; and, besides
// ownerProbe.ts and boundedRead.ts, the viz file allowed node:fs, only to open that stderr file (Task 15 fix round 2 ruling).
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { closeSync, constants, lstatSync, mkdirSync, openSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import type { Lang } from '../../i18n/render.js';
import { isUncOrDevice } from './paths.js';

export interface ViewerArgs {
  execPath: string; vizJs: string; dataDir: string; lang: Lang; sha256: string; repos: readonly string[];
  demo: true | string | null; git: string | null;   // git: the resolved absolute git, set exactly when repos is non-empty (R-V13)
  env: Record<string, string>; platform: NodeJS.Platform; systemRoot: string | null;
}
export type ReadyLine = { port: number; launch: string } | { refuse: string; line?: number };
export const READY_TIMEOUT_MS = 5_000, READY_MAX_BYTES = 512;
/**
 * The ready window on Windows (ruling 2026-10-10, hosted-CI round): the viewer repeats the SEC-20 owner and ACL check inside the window,
 * and on Windows that check starts Windows PowerShell (ownerProbe.ts), whose cold start took 6-10 s on a hosted runner.
 */
export const READY_TIMEOUT_WIN32_MS = 15_000;
/** How long the CLI waits for the ready line: READY_TIMEOUT_WIN32_MS on win32, READY_TIMEOUT_MS elsewhere. */
export const readyTimeoutMs = (platform: NodeJS.Platform): number => (platform === 'win32' ? READY_TIMEOUT_WIN32_MS : READY_TIMEOUT_MS);
export const READY_REFUSE_CODES: ReadonlySet<string> = new Set([
  'RF_VIZ_START_FAILED', 'RF_VIZ_BIND_FAILED', 'RF_VIZ_NO_ROOMS', 'RF_VIZ_REPO_NOT_LIVE', 'RF_VIZ_DEMO_INVALID', 'START_TOOL_VERSION',
]);

const START_FAILED: ReadyLine = Object.freeze({ refuse: 'RF_VIZ_START_FAILED' });
const LAUNCH_RE = /^[0-9a-f]{64}$/;
const TASKKILL_TIMEOUT_MS = 10_000;

const isPort = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= 65_535;
const sameKeys = (o: object, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => own.includes(k));
};

/**
 * One LF-terminated JSON object by schema: {"v":1,"port":<1-65535>,"launch":"<64 lowercase hex>"} or {"v":1,"refuse":"<code>"} with
 * code ∈ READY_REFUSE_CODES, plus "line":<integer ≥ 0> only with RF_VIZ_DEMO_INVALID; no other key, nothing after the LF; else null.
 */
export function parseReadyLine(buf: Buffer): ReadyLine | null {
  if (buf.length === 0 || buf.length > READY_MAX_BYTES || buf.indexOf(0x0a) !== buf.length - 1) return null;
  let text: string;
  let o: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf.subarray(0, buf.length - 1));
    if (text.trim() !== text) return null;   // the object alone: no CR before the LF, no padding, no BOM
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  if (r.v !== 1) return null;
  if (sameKeys(r, ['v', 'port', 'launch'])) {
    return isPort(r.port) && typeof r.launch === 'string' && LAUNCH_RE.test(r.launch) ? { port: r.port, launch: r.launch } : null;
  }
  if (typeof r.refuse !== 'string' || !READY_REFUSE_CODES.has(r.refuse)) return null;
  if (sameKeys(r, ['v', 'refuse'])) return { refuse: r.refuse };
  if (sameKeys(r, ['v', 'refuse', 'line']) && r.refuse === 'RF_VIZ_DEMO_INVALID' && Number.isSafeInteger(r.line) && (r.line as number) >= 0) {
    return { refuse: r.refuse, line: r.line as number };
  }
  return null;
}

/**
 * The viewer's V8 old-space cap in MB for up to 8 rooms (12 §3.12 "viewer RSS ≤ 200 MB with 8 rooms", measured as the settled RSS after
 * the folds; Task 15 fix round 1 ruling): without it V8 sizes the heap lazily and kept 263–288 MB resident after the T-VIZ-perf live
 * extension, under it the same run settled at 161–194.5 MB with every height folded.
 *
 * The rule (Task 15 fix round 2 ruling): cap = VIEWER_MAX_OLD_SPACE_MB + VIEWER_OLD_SPACE_ROOM_MB × max(0, rooms − 8) MB, so 32 rooms
 * get 534 MB (viewerOldSpaceMb). A V8 heap that reaches its cap ends the process (a fatal "heap out of memory", which goes to the
 * stderr file, openViewerStderr), so the cap grows with the rooms the viewer may fold. V8 fixes the old space when the process starts,
 * so `rooms` is what the CLI knows at spawn (viewerArgv): the --repo count, at most VIEWER_ROOMS_MAX (each --repo admits at most one
 * room, source/rooms.ts); VIEWER_ROOMS_MAX for a --demo=<file> (its header names 1–32 rooms, and only the viewer reads it); none beyond
 * the base for the bundled demo (one room in ≤ 64 KiB). The viewer builds at most 4 first windows at once (main.ts ROOM_INITS_MAX).
 */
export const VIEWER_MAX_OLD_SPACE_MB = 150;
/** The MB per room beyond VIEWER_OLD_SPACE_BASE_ROOMS (see VIEWER_MAX_OLD_SPACE_MB's rule). */
export const VIEWER_OLD_SPACE_ROOM_MB = 16, VIEWER_OLD_SPACE_BASE_ROOMS = 8;
/** source/rooms.ts ROOMS_MAX, copied: cli.js bundles only src/viz/cli/** (a test pins the parity). */
export const VIEWER_ROOMS_MAX = 32;

/** VIEWER_MAX_OLD_SPACE_MB's rule: 150 MB up to 8 rooms, 16 MB more per room beyond 8, rooms counted up to VIEWER_ROOMS_MAX. */
export function viewerOldSpaceMb(rooms: number): number {
  const n = Math.min(Math.max(0, Math.floor(rooms)), VIEWER_ROOMS_MAX);
  return VIEWER_MAX_OLD_SPACE_MB + VIEWER_OLD_SPACE_ROOM_MB * Math.max(0, n - VIEWER_OLD_SPACE_BASE_ROOMS);
}

/** The most rooms the viewer may fold, as the CLI knows it at spawn (VIEWER_MAX_OLD_SPACE_MB's rule). */
function roomsAtSpawn(a: ViewerArgs): number {
  if (a.repos.length > 0) return a.repos.length;
  return typeof a.demo === 'string' ? VIEWER_ROOMS_MAX : 0;
}

/**
 * ['--max-old-space-size=<viewerOldSpaceMb(rooms)>', vizJs, 'serve', '--data-dir', dataDir, '--lang', lang, '--sha256', sha256,
 * ('--git', git, ('--repo', p)…) | '--demo' | '--demo=<abs>']: the node flag precedes the script (it is not in the viewer's process.argv).
 * --git is present exactly when --repo is (R-V13): repos without a git throw (the viewer would refuse such an argv, so spawnViewer refuses
 * RF_VIZ_START_FAILED and starts nothing), and a git without repos is not passed (a demo resolves and calls no git, VIZ-06).
 */
export function viewerArgv(a: ViewerArgs): string[] {
  const argv = [`--max-old-space-size=${viewerOldSpaceMb(roomsAtSpawn(a))}`, a.vizJs, 'serve', '--data-dir', a.dataDir, '--lang', a.lang, '--sha256', a.sha256];
  if (a.repos.length > 0) {
    if (a.git === null || a.git === '') throw new Error('viewerArgv: --repo needs the resolved --git (R-V13)');
    argv.push('--git', a.git);
    for (const p of a.repos) argv.push('--repo', p);
  } else if (a.demo === true) {
    argv.push('--demo');
  } else if (typeof a.demo === 'string') {
    argv.push(`--demo=${a.demo}`);
  }
  return argv;
}

/**
 * The viewer's stderr, <data dir>/log/viz-stderr.txt (Task 15 fix round 2 ruling: an abort is never silent). The viewer writes nothing
 * there itself; what lands in it is what Node and V8 print when the process dies outside the viewer's own code, above all V8's fatal
 * "heap out of memory" at the old-space cap, which no handler in the process can log. Raw text, so it is not a viewer log file: no
 * viz-*.jsonl name (the 14-day cleanup and the log readers skip it), and it may hold what such a message holds (a stack with paths).
 * Every viewer of this data directory appends to the one file; a spawn that finds it past VIEWER_STDERR_MAX_BYTES starts it over.
 */
export const VIEWER_STDERR_FILE = 'viz-stderr.txt', VIEWER_STDERR_MAX_BYTES = 1_048_576;

/** An open descriptor for the child's stderr; close() drops the CLI's own copy once the child holds its own. */
export interface StderrFile { fd: number; close(): void; }

const STDERR_DIR = 'log';

/**
 * Opens <dataDir>/log/viz-stderr.txt for the viewer's stderr: log/ made user-only (0700) when absent (the data directory itself must
 * exist; the CLI has verified it, SEC-20), the file write-only, created 0600, appended to, truncated when it is past 1 MiB, and never
 * through a symlink (lstat must find a regular file or nothing; O_NOFOLLOW where the OS defines it). Any failure → null: the viewer
 * then starts without a stderr ('ignore'), as before this ruling. Never throws.
 */
export function openViewerStderr(dataDir: string, platform: NodeJS.Platform): StderrFile | null {
  const p = platform === 'win32' ? win32 : posix;
  const dir = p.join(dataDir, STDERR_DIR);
  const file = p.join(dir, VIEWER_STDERR_FILE);
  try {
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return null;
    }
    const l = lstatSync(file, { throwIfNoEntry: false });
    if (l !== undefined && !l.isFile()) return null;   // a symlink, a directory, a FIFO (an open for writing would block)
    const big = l !== undefined && l.size > VIEWER_STDERR_MAX_BYTES;
    const nofollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | (big ? constants.O_TRUNC : constants.O_APPEND) | nofollow, 0o600);
    return {
      fd,
      close: (): void => {
        try {
          closeSync(fd);
        } catch {
          // already closed
        }
      },
    };
  } catch {
    return null;
  }
}

/** What spawnViewerWith takes from the OS; spawnViewer passes node's spawn, killTree and openViewerStderr, tests pass spies over them. */
export interface SpawnDeps {
  /** The child's stderr file (spawnViewer: openViewerStderr); absent or null → 'ignore'. */
  stderr?(dataDir: string, platform: NodeJS.Platform): StderrFile | null;
  spawn(exe: string, argv: readonly string[], options: SpawnOptions): ChildProcess;
  /** Called with the held child in the tick that judged it (see killTreeWith); its synchronous part runs before it returns. */
  killTree(child: ChildProcess, platform: NodeJS.Platform, systemRoot: string | null): Promise<void>;
}

/**
 * spawn(execPath, viewerArgv(a), { shell: false, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', <stderr>], env: a.env, cwd: a.dataDir }),
 * <stderr> = the descriptor of <data dir>/log/viz-stderr.txt (openViewerStderr; the CLI closes its own copy right after the spawn), or
 * 'ignore' when that file cannot be opened;
 * ≤ 512 bytes within readyTimeoutMs(a.platform) (5 s; 15 s on win32); then destroy the pipe and unref(); a timeout, a bad line or an
 * early exit → killTree and { refuse: 'RF_VIZ_START_FAILED' }.
 * The line is judged at its LF (bytes after it make it invalid), or once the pipe has ended and the child has exited. After a refusal the
 * tree is killed, also once the child has exited on POSIX: the child leads its own process group (detached), a group id is not reused
 * while any member lives, and a grandchild the child left behind keeps that group (killTree ignores ESRCH and never signals the bare
 * pid). On Windows a child that has exited is never killed by its pid: Node has reaped it, so the pid may belong to another process
 * already (taskkill /T on a reused pid would end an unrelated tree).
 */
export function spawnViewer(a: ViewerArgs): Promise<ReadyLine> {
  return spawnViewerWith(a, { spawn, killTree, stderr: openViewerStderr });
}

/** spawnViewer over the given spawn, killTree and stderr file. */
export function spawnViewerWith(a: ViewerArgs, d: SpawnDeps): Promise<ReadyLine> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    let argv: string[];
    try {
      argv = viewerArgv(a);   // repos without a git: refused before anything is opened or spawned
    } catch {
      resolve(START_FAILED);
      return;
    }
    const err = d.stderr?.(a.dataDir, a.platform) ?? null;
    try {
      child = d.spawn(a.execPath, argv, {
        shell: false, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', err === null ? 'ignore' : err.fd], env: a.env, cwd: a.dataDir,
      });
    } catch {
      resolve(START_FAILED);
      return;
    } finally {
      err?.close();   // the child holds its own descriptor (or none was started)
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let exited = false;
    let ended = false;
    const finish = (line: ReadyLine | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeAllListeners('data');
      child.stdout?.destroy();
      child.unref();
      if (line !== null) {
        resolve(line);
        return;
      }
      const pid = child.pid;
      const running = !exited && child.exitCode === null && child.signalCode === null;
      const kill = pid !== undefined && (a.platform !== 'win32' || running);   // POSIX: the group, even after the leader exited
      // Same tick as the check above: a Windows kill runs to its end before Node can reap the child (killTreeWith).
      void (kill ? d.killTree(child, a.platform, a.systemRoot) : Promise.resolve()).then(() => resolve(START_FAILED));
    };
    const judge = (): void => finish(parseReadyLine(Buffer.concat(chunks)));
    const timer = setTimeout(() => finish(null), readyTimeoutMs(a.platform));
    child.on('error', () => finish(null));
    child.on('exit', () => {
      exited = true;
      if (ended) judge();
    });
    child.stdout?.on('data', (d: Buffer) => {
      chunks.push(d);
      size += d.length;
      if (size > READY_MAX_BYTES) {
        finish(null);
        return;
      }
      const buf = Buffer.concat(chunks);
      if (buf.includes(0x0a)) finish(parseReadyLine(buf));
    });
    // The pipe ended without a LF: judged once the child has exited too (then it is not killed); a child that closed its stdout and
    // stays is killed at the timeout.
    child.stdout?.on('end', () => {
      ended = true;
      if (exited) judge();
    });
  });
}

/** POSIX: how long the viewer gets after SIGTERM to end its own children before the group gets SIGKILL, and the poll step. */
const KILL_GRACE_MS = 2_000;
const KILL_POLL_MS = 50;

/** What killTreeWith takes from the OS: a process-group signal (killTree passes process.kill(-pgid, …); a test passes a fake group). */
export interface KillDeps { killGroup(pgid: number, signal: NodeJS.Signals | 0): void; }

/** The held child killTreeWith kills: its pid, whether Node has seen it exit, and its handle's kill. */
export type KillTarget = Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'kill'>;

/**
 * Kills the detached child's whole tree. POSIX: SIGTERM to its process group (it leads one), so the viewer can kill its git children,
 * which run in process groups of their own and no group signal reaches; then, once the group still exists after the grace period,
 * SIGKILL to the group. The group is signalled even when its leader has exited (its members keep it); no group (ESRCH: the leader and
 * every member are gone) or a group no signal reaches ends it there: the bare pid is never signalled, it may belong to another process
 * by now. win32 (only for a child Node still holds and has not seen exit; spawnViewerWith checks it in the same tick):
 * <SystemRoot>\System32\taskkill.exe /PID <pid> /T /F by that absolute path, without a shell, cwd = SystemRoot (the signature carries no
 * data directory; nothing is resolved from the cwd either way), run synchronously (spawnSync, at most 10 s), so Node cannot reap the
 * child and free its pid while taskkill runs: an asynchronous taskkill (~0.7 s) let a child that ended meanwhile hand its pid to another
 * process, whose tree `/T /F` would end (the runner's rule, Plan 2 final review). Without an absolute SystemRoot, or when taskkill cannot
 * run, times out or exits non-zero, only the child itself is killed, through its handle (no tree kill). Never throws.
 */
export function killTree(child: KillTarget, platform: NodeJS.Platform, systemRoot: string | null): Promise<void> {
  return killTreeWith(child, platform, systemRoot, { killGroup: (pgid, signal) => { process.kill(-pgid, signal); } });
}

/** killTree over the given process-group signal. */
export async function killTreeWith(child: KillTarget, platform: NodeJS.Platform, systemRoot: string | null, d: KillDeps): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return;
  /** Sends `signal` to the process group `pid` leads; false when there is no such group (or it cannot be signalled). */
  const signalGroup = (signal: NodeJS.Signals | 0): boolean => {
    try {
      d.killGroup(pid, signal);
      return true;
    } catch (e) {
      return signal === 0 && (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  };
  if (platform !== 'win32') {
    if (!signalGroup('SIGTERM')) return;   // ESRCH (nothing left) or EPERM: never the bare pid
    for (let waited = 0; waited < KILL_GRACE_MS; waited += KILL_POLL_MS) {
      await new Promise<void>((r) => { setTimeout(r, KILL_POLL_MS); });
      if (!signalGroup(0)) return;
    }
    signalGroup('SIGKILL');
    return;
  }
  // Node has seen the exit (and closed the handle): the pid may already name another process.
  if (child.exitCode !== null || child.signalCode !== null) return;
  const killOne = (): void => {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  };
  if (systemRoot === null || !/^[A-Za-z]:[\\/]/.test(systemRoot) || isUncOrDevice(systemRoot)) {
    killOne();
    return;
  }
  const exe = win32.join(systemRoot, 'System32', 'taskkill.exe');
  let ok = false;
  try {
    const r = spawnSync(exe, ['/PID', String(pid), '/T', '/F'], {
      shell: false, windowsHide: true, stdio: 'ignore', cwd: systemRoot, env: { SystemRoot: systemRoot }, timeout: TASKKILL_TIMEOUT_MS,
    });
    ok = r.error === undefined && r.status === 0;
  } catch {
    ok = false;
  }
  if (!ok) killOne();
}
