// The files of <gitdir>/cowork/ that the cowork CLI (src/cli) reads or writes next to a running daemon: daemon.lock (R-26),
// status.json (glossary §14), the stop request (`cowork stop`) and the daemon log. A leaf module (node built-ins, the Clock
// helpers and nothing of the engine), so cli.js reads these files without bundling the engine.
import { join } from 'node:path';
import { machineMonoMs } from '../ports/clock.js';

export const DAEMON_LOCK_FILE = 'daemon.lock';
export const STATUS_FILE = 'status.json';
/**
 * `cowork stop`: the running daemon polls for this file and, once it is there, drains as a stop signal does (status down, exit 0);
 * its content is not read (the CLI writes the daemon.lock instance it asks to stop, for the record). A file left from an earlier
 * run is removed when `run` starts. Windows cannot deliver a stop signal to a detached daemon, and no pid is ever signalled
 * (L-PID-KILL), so the request travels as a file.
 */
export const STOP_REQUEST_FILE = 'stop-request';
/** The daemon log, relative to <gitdir>/cowork. */
export const DAEMON_LOG_FILE = join('log', 'daemon-0.jsonl');

/** started: the holder process's start on the machine-wide monotonic clock (processStartMonoMs); null in a lock that names none. */
export interface DaemonLockHolder { pid: number; plugin_version: string; instance: string; started: number | null; }

/** daemon.lock's content, or null when it names no holder (unparsable, or a field missing). */
export function parseLockHolder(buf: Buffer): DaemonLockHolder | null {
  try {
    const v = JSON.parse(buf.toString('utf8')) as Record<string, unknown>;
    const pid = v['pid'];
    const started = v['started'];
    if (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 && typeof v['plugin_version'] === 'string' && typeof v['instance'] === 'string') {
      return { pid, plugin_version: v['plugin_version'], instance: v['instance'], started: typeof started === 'number' && Number.isFinite(started) ? started : null };
    }
  } catch {
    // unparsable: no holder
  }
  return null;
}

/** A process with this pid exists (signal 0: EPERM still means it exists). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return typeof e === 'object' && e !== null && (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Another process's lock holder still holds the lock: it did not start later than this boot has run (a holder from before a
 * reboot, whatever process now has its pid, is stale) and its pid is alive. A pid reused by an unrelated process still reads
 * as alive; the lock's own acquire (staleHolder) tells those apart only for its own pid.
 */
export function holderLive(h: DaemonLockHolder, alive: (pid: number) => boolean = processAlive, nowMachineMono: number = machineMonoMs()): boolean {
  if (h.started !== null && h.started > nowMachineMono) return false;
  return alive(h.pid);
}
