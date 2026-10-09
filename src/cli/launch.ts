// `cowork start`: starting `node <plugin root>/dist/daemon.js run …` in the background (v0.1.0-preview). The daemon is spawned without
// a shell, detached and hidden, by the absolute node path; its stdout and stderr are read until it prints its start line
// (`started <mode> on <branch> as peer <id>`), exits (a refusal: its code line and `next:` line), or the time runs out. Then the
// pipes are closed and the child unreferenced, so this process can exit while the daemon runs on (the daemon ignores the write errors
// a closed pipe gives it later). The daemon is never killed from here, by pid or otherwise: after a timeout it keeps starting, and
// `cowork status` shows how that went. The one file of src/cli allowed child_process (L-PORTS).
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export interface DaemonLaunch {
  execPath: string; daemonJs: string; argv: readonly string[];
  cwd: string; env: Readonly<Record<string, string | undefined>>; timeoutMs: number;
}
export type LaunchOutcome =
  | { kind: 'started'; mode: string; lines: string[] }
  | { kind: 'exited'; code: number | null; lines: string[] }
  | { kind: 'timeout'; lines: string[] }
  | { kind: 'spawn_failed'; why: string };

/** The daemon's start line (src/daemon/run.ts runIterations). */
export const STARTED_RE = /^started (genesis|join|restart) on .+ as peer [0-9a-f]+$/;
/** Output kept from the daemon before its start line: more than this is cut (a start never prints that much). */
const MAX_OUTPUT_BYTES = 64 * 1024;

export type SpawnFn = (exe: string, argv: readonly string[], options: SpawnOptions) => ChildProcess;

export function launchDaemon(l: DaemonLaunch): Promise<LaunchOutcome> {
  return launchDaemonWith(l, spawn);
}

/** launchDaemon over the given spawn (tests pass a spy). */
export function launchDaemonWith(l: DaemonLaunch, spawnFn: SpawnFn): Promise<LaunchOutcome> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnFn(l.execPath, [l.daemonJs, ...l.argv], {
        shell: false, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: l.cwd, env: { ...l.env },
      });
    } catch (e) {
      resolve({ kind: 'spawn_failed', why: e instanceof Error ? e.message : String(e) });
      return;
    }
    const lines: string[] = [];
    const partial = { out: '', err: '' };
    let size = 0;
    let settled = false;
    const finish = (o: LaunchOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeAllListeners('data');
      child.stderr?.removeAllListeners('data');
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      resolve(o);
    };
    const flush = (): void => {
      for (const k of ['out', 'err'] as const) {
        if (partial[k].length > 0) lines.push(partial[k].replace(/\r$/, ''));
        partial[k] = '';
      }
    };
    const onData = (k: 'out' | 'err') => (d: Buffer): void => {
      size += d.length;
      if (size > MAX_OUTPUT_BYTES) return;
      partial[k] += d.toString('utf8');
      let nl = partial[k].indexOf('\n');
      while (nl >= 0) {
        const line = partial[k].slice(0, nl).replace(/\r$/, '');
        partial[k] = partial[k].slice(nl + 1);
        lines.push(line);
        const m = k === 'out' ? STARTED_RE.exec(line) : null;
        if (m !== null) {
          finish({ kind: 'started', mode: m[1]!, lines: [...lines] });
          return;
        }
        nl = partial[k].indexOf('\n');
      }
    };
    const timer = setTimeout(() => {
      flush();
      finish({ kind: 'timeout', lines: [...lines] });
    }, l.timeoutMs);
    child.on('error', (e) => finish({ kind: 'spawn_failed', why: e.message }));
    child.stdout?.on('data', onData('out'));
    child.stderr?.on('data', onData('err'));
    // 'close': the daemon exited and both pipes are drained (a refusal's two lines are all in).
    child.on('close', (code) => {
      flush();
      finish({ kind: 'exited', code, lines: [...lines] });
    });
  });
}
