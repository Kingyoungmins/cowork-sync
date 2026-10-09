// The staged read and the stage directory (01-engine §2 "staged read"; glossary §26.1 W1–W3; ENG-27).
// The staged read is the only way the daemon reads a user's working file: lstat, one whole-file read (realFs opens
// share-all and closes at once, W3), lstat; one re-read when the stat changed; never git. The bytes go to a stage copy
// under <gitdir>/cowork/tmp/stage/<p>, and every git command that needs them reads the copy, never p (W1).
import { join } from 'node:path';
import { isDotGitAlias } from '../data/scope.js';
import { sameStat, type Fs, type FsLstat } from '../ports/fs.js';
import { validPathSyntax } from '../sec/validators.js';

export type ReadOutcome =
  | { kind: 'ok'; bytes: Buffer; stat: FsLstat }
  | { kind: 'missing' }
  | { kind: 'unstable' }
  | { kind: 'unreadable'; code: string };

function codeOf(e: unknown): string {
  const code = typeof e === 'object' && e !== null ? (e as NodeJS.ErrnoException).code : undefined;
  return typeof code === 'string' && code.length > 0 ? code : 'EIO';
}

function isGone(code: string): boolean {
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * lstat → readFile → lstat. The result is ok only when the stat after the read equals the stat before it (size,
 * mtime_ns, file id, device, mode: stricter than (size, mtime_ns), so a rename-over with an equal size and mtime is
 * seen too) and the bytes are exactly that stat's size; the returned stat is the one taken after the read, so it
 * always describes the returned bytes (a truncation between the first lstat and the read can never come back as a
 * 0-byte ok carrying the old stat). One re-read on a change (bracketed by the second and a third lstat), then
 * UNSTABLE. An open or read error is UNREADABLE with its code; ENOENT is MISSING. A directory or a symlink is never
 * opened (a read would follow the link): UNREADABLE EISDIR / ELOOP.
 */
export async function stagedRead(fs: Fs, abs: string): Promise<ReadOutcome> {
  let before: FsLstat | null;
  try {
    before = await fs.lstat(abs);
  } catch (e) {
    return { kind: 'unreadable', code: codeOf(e) };
  }
  if (before === null) return { kind: 'missing' };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!before.isFile) return { kind: 'unreadable', code: before.isDirectory ? 'EISDIR' : 'ELOOP' };
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(abs);
    } catch (e) {
      const code = codeOf(e);
      return isGone(code) ? { kind: 'missing' } : { kind: 'unreadable', code };
    }
    let after: FsLstat | null;
    try {
      after = await fs.lstat(abs);
    } catch (e) {
      return { kind: 'unreadable', code: codeOf(e) };
    }
    if (after === null) return { kind: 'missing' };
    if (sameStat(before, after) && bytes.length === after.size) return { kind: 'ok', bytes, stat: after };
    before = after;
  }
  return { kind: 'unstable' };
}

function checkPath(path: string): string[] {
  if (!stageable(path)) throw new Error(`stage: invalid repository path ${JSON.stringify(path)}`);
  return path.split('/');
}

/**
 * Whether the engine may address a repository path on disk at all (rulings P2-CARRY, P2-DOTGIT): it passes
 * validPathSyntax, does not contain U+FFFD (what a git path whose bytes are not UTF-8 decodes to: the decoded string
 * names another file) and has no dotgit-alias component (isDotGitAlias, on every platform: on Windows `GIT~1/config`
 * is `.git/config`). A path that fails is carried through: never looked at, read, hashed, staged or compared.
 */
export function stageable(path: string): boolean {
  return validPathSyntax(path) && !path.includes('\u{fffd}') && !path.split('/').some(isDotGitAlias);
}

/** <coworkDir>/tmp/stage (0o700): one stage copy per repository path. */
export class StageDir {
  readonly root: string;
  private readonly fs: Fs;

  constructor(fs: Fs, root: string) {
    this.fs = fs;
    this.root = root;
  }

  abs(path: string): string {
    return join(this.root, ...checkPath(path));
  }

  /**
   * Writes the stage copy of path and returns its absolute file. validPathSyntax; every existing component under the
   * root is lstat-checked and a symlink (or junction) is refused, so a write never lands outside the root; a stale
   * file where a directory is now needed (or a stale directory where the copy goes) is replaced.
   */
  async write(path: string, bytes: Buffer): Promise<string> {
    const parts = checkPath(path);
    await this.ensureRoot();
    let dir = this.root;
    for (const c of parts.slice(0, -1)) {
      dir = join(dir, c);
      const st = await this.fs.lstat(dir);
      if (st !== null && st.isSymbolicLink) throw new Error(`stage: refusing a symlinked component ${JSON.stringify(dir)}`);
      if (st !== null && !st.isDirectory) await this.fs.unlink(dir);
      if (st === null || !st.isDirectory) await this.fs.mkdirp(dir, 0o700);
    }
    const file = join(dir, parts[parts.length - 1] as string);
    const st = await this.fs.lstat(file);
    if (st !== null && st.isSymbolicLink) throw new Error(`stage: refusing a symlinked stage copy ${JSON.stringify(file)}`);
    if (st !== null && st.isDirectory) await this.fs.rmrf(file);
    await this.fs.writeFile(file, bytes);
    return file;
  }

  /** Deletes the stage copy (absent is fine); a link is removed, never followed. */
  async remove(path: string): Promise<void> {
    const file = this.abs(path);
    const st = await this.fs.lstat(file);
    if (st === null || st.isDirectory) return;
    try {
      await this.fs.unlink(file);
    } catch (e) {
      if (!isGone(codeOf(e))) throw e;
    }
  }

  /** Deletes every stage copy (restart, reseed). */
  async clear(): Promise<void> {
    await this.fs.rmrf(this.root);
    await this.fs.mkdirp(this.root, 0o700);
  }

  private async ensureRoot(): Promise<void> {
    const st = await this.fs.lstat(this.root);
    if (st === null) {
      await this.fs.mkdirp(this.root, 0o700);
      return;
    }
    if (!st.isDirectory || st.isSymbolicLink) throw new Error(`stage: root ${JSON.stringify(this.root)} is not a directory`);
  }
}
