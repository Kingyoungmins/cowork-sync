// What the CLI verbs read about the clone they run in: its top folder, current branch and remotes (read-only git through the git
// runner), and the files of <gitdir>/cowork (daemon.lock, status.json) and the fold of the local state for the peer names.
import { join, resolve } from 'node:path';
import { liveSet, parseFold } from '../board/fold.js';
import { DAEMON_LOCK_FILE, parseLockHolder, STATUS_FILE, type DaemonLockHolder } from '../engine/daemonFiles.js';
import { RELEASE_NAMESPACE, refNames } from '../engine/refs.js';
import type { Fs } from '../ports/fs.js';
import type { GitRunner } from '../git/runner.js';
import { parseStatusJson, type StatusView } from './statusText.js';

export interface Clone { top: string; coworkDir: string; }

async function gitText(git: GitRunner, cwd: string, args: string[]): Promise<string | null> {
  const r = await git.run(args, { class: 'local', cwd });
  return r.code === 0 ? r.stdout.toString('utf8').trim() : null;
}

/** The work tree `cwd` is inside (`git rev-parse --show-toplevel`), or null outside one (or in a bare repository). */
export async function findClone(git: GitRunner, cwd: string): Promise<Clone | null> {
  const top = await gitText(git, cwd, ['rev-parse', '--show-toplevel']);
  if (top === null || top.length === 0) return null;
  const abs = resolve(top);
  return { top: abs, coworkDir: join(abs, '.git', 'cowork') };
}

/** The branch HEAD is on, or null when HEAD is detached. */
export function currentBranch(git: GitRunner, top: string): Promise<string | null> {
  return gitText(git, top, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
}

/** The names of the clone's remotes. */
export async function remoteNames(git: GitRunner, top: string): Promise<string[]> {
  const out = await gitText(git, top, ['remote']);
  return out === null ? [] : out.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

/** daemon.lock's holder, or null without a lock file or one that names none. */
export async function readLockHolder(fs: Fs, coworkDir: string): Promise<DaemonLockHolder | null> {
  try {
    return parseLockHolder(await fs.readFile(join(coworkDir, DAEMON_LOCK_FILE)));
  } catch {
    return null;
  }
}

/** status.json parsed; null when absent; 'unreadable' when present but not a status this CLI reads. */
export async function readStatusFile(fs: Fs, coworkDir: string): Promise<StatusView | null | 'unreadable'> {
  let buf: Buffer;
  try {
    buf = await fs.readFile(join(coworkDir, STATUS_FILE));
  } catch (e) {
    return typeof e === 'object' && e !== null && (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unreadable';
  }
  return parseStatusJson(buf) ?? 'unreadable';
}

/**
 * The display names of the active peers in the fold the local state keeps (journal/keep/fold/state.json of
 * refs/cowork-local/<enc(b)>/state), this clone's marked; null when there is no such state or it cannot be read.
 */
export async function activePeers(git: GitRunner, top: string, branch: string, self: string): Promise<string[] | null> {
  let state: string;
  try {
    state = refNames(branch, RELEASE_NAMESPACE).state;
  } catch {
    return null;
  }
  const r = await git.run(['cat-file', 'blob', `${state}:journal/keep/fold/state.json`], { class: 'local', cwd: top });
  if (r.code !== 0) return null;
  const fold = parseFold(r.stdout);
  if (fold === null) return null;
  return liveSet(fold).map((p) => `${fold.peers[p]!.display}${p === self ? ' (this clone)' : ''}`);
}
