// Fs port (11-testing §3.2). Every read and write of user and cowork files under
// src/ goes through this interface, on Buffers only (lint L-UTF8-WRITE).
// Production binds realFs; SIM binds test/sim/faultfs.ts over realFs.
// Lock emulation lives in test/sim/faultfs.ts (Plan 2 widened this port with lstat, exclusive create, rmdir, append, realpath, freeBytes,
// and chmod for the writer's exec bit, ruling P2-EXECBIT).
// RootProbe/realRootProbe (Plan 5 A1-6, X-63; written by Plan 8a Task 7 at Plan 5's declared signatures, verify pass V-12):
// the synchronous probe of the canonical root form (src/data/canonRoot.ts), declared here because src/ports may not import
// src/data.
import { lstatSync, promises as fsp, readFileSync, realpathSync } from 'node:fs';

export interface FsStat {
  size: number;
  mtimeMs: number;
  isFile: boolean;
  isDirectory: boolean;
}

export interface FsLstat {
  size: number;
  /** lstat({ bigint: true }).mtimeNs */
  mtimeNs: bigint;
  ino: bigint;
  dev: bigint;
  /** st_mode bits */
  mode: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

/** The errno code of a thrown Fs (or Node) error (`ENOENT`, `EPERM`, …), undefined for anything else. */
export function errnoCode(e: unknown): string | undefined {
  const c = typeof e === 'object' && e !== null ? (e as NodeJS.ErrnoException).code : undefined;
  return typeof c === 'string' ? c : undefined;
}

/** Size, mtimeNs, ino, dev and mode all equal. */
export function sameStat(a: FsLstat, b: FsLstat): boolean {
  return (
    a.size === b.size && a.mtimeNs === b.mtimeNs && a.ino === b.ino && a.dev === b.dev && a.mode === b.mode
  );
}

export interface Fs {
  readFile(p: string): Promise<Buffer>;
  writeFile(p: string, data: Buffer): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  link(existing: string, newPath: string): Promise<void>;
  unlink(p: string): Promise<void>;
  stat(p: string): Promise<FsStat | null>; // null on ENOENT
  /** `mode` applies to the directories it creates (0o700 for <gitdir>/cowork/tmp). */
  mkdirp(p: string, mode?: number): Promise<void>;
  readdir(p: string): Promise<string[]>; // sorted by code unit
  rmrf(p: string): Promise<void>;
  /** null on ENOENT or ENOTDIR; never follows a symlink. */
  lstat(p: string): Promise<FsLstat | null>;
  /** open 'wx', one write, fsync, close; EEXIST when p exists. */
  writeFileExclusive(p: string, data: Buffer): Promise<void>;
  /** Non-recursive; ENOTEMPTY and ENOENT propagate. */
  rmdir(p: string): Promise<void>;
  /** Buffer only (TypeError otherwise). */
  appendFile(p: string, data: Buffer): Promise<void>;
  /** realpathSync.native semantics. */
  realpath(p: string): Promise<string>;
  /** statfs bavail x bsize; null where statfs is unavailable. */
  freeBytes(dir: string): Promise<number | null>;
  /** chmod (ruling P2-EXECBIT: the writer sets or clears the owner-exec bit of what it writes); ENOENT propagates. On Windows only the read-only flag follows the mode. */
  chmod(p: string, mode: number): Promise<void>;
}

function hasCode(e: unknown, code: string): boolean {
  return typeof e === 'object' && e !== null && (e as NodeJS.ErrnoException).code === code;
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export const realFs: Fs = {
  // One open + whole-file read + close. On Windows libuv opens with share-all
  // (read|write|delete), so an editor's save is never blocked by a held handle
  // beyond this single call (glossary §26.1 W1, W3).
  async readFile(p: string): Promise<Buffer> {
    return fsp.readFile(p);
  },

  async writeFile(p: string, data: Buffer): Promise<void> {
    if (!Buffer.isBuffer(data)) {
      throw new TypeError(`Fs.writeFile requires a Buffer (got ${typeof data}) for ${p}`);
    }
    await fsp.writeFile(p, data);
  },

  async rename(from: string, to: string): Promise<void> {
    await fsp.rename(from, to);
  },

  async link(existing: string, newPath: string): Promise<void> {
    await fsp.link(existing, newPath);
  },

  async unlink(p: string): Promise<void> {
    await fsp.unlink(p);
  },

  async stat(p: string): Promise<FsStat | null> {
    try {
      const s = await fsp.stat(p);
      return { size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDirectory: s.isDirectory() };
    } catch (e) {
      if (hasCode(e, 'ENOENT')) return null;
      throw e;
    }
  },

  async mkdirp(p: string, mode?: number): Promise<void> {
    await fsp.mkdir(p, mode === undefined ? { recursive: true } : { recursive: true, mode });
  },

  async lstat(p: string): Promise<FsLstat | null> {
    try {
      const s = await fsp.lstat(p, { bigint: true });
      return {
        size: Number(s.size),
        mtimeNs: s.mtimeNs,
        ino: s.ino,
        dev: s.dev,
        mode: Number(s.mode),
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        isSymbolicLink: s.isSymbolicLink(),
      };
    } catch (e) {
      if (hasCode(e, 'ENOENT') || hasCode(e, 'ENOTDIR')) return null;
      throw e;
    }
  },

  async writeFileExclusive(p: string, data: Buffer): Promise<void> {
    if (!Buffer.isBuffer(data)) {
      throw new TypeError(`Fs.writeFileExclusive requires a Buffer (got ${typeof data}) for ${p}`);
    }
    const h = await fsp.open(p, 'wx');
    try {
      await h.writeFile(data);
      await h.sync();
    } finally {
      await h.close();
    }
  },

  async rmdir(p: string): Promise<void> {
    await fsp.rmdir(p);
  },

  async appendFile(p: string, data: Buffer): Promise<void> {
    if (!Buffer.isBuffer(data)) {
      throw new TypeError(`Fs.appendFile requires a Buffer (got ${typeof data}) for ${p}`);
    }
    await fsp.appendFile(p, data);
  },

  async realpath(p: string): Promise<string> {
    return fsp.realpath(p);
  },

  async freeBytes(dir: string): Promise<number | null> {
    try {
      const s = await fsp.statfs(dir);
      return Number(s.bavail) * Number(s.bsize);
    } catch (e) {
      if (typeof e === 'object' && e !== null && (e as NodeJS.ErrnoException).code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') {
        return null;
      }
      throw e;
    }
  },

  async chmod(p: string, mode: number): Promise<void> {
    await fsp.chmod(p, mode);
  },

  async readdir(p: string): Promise<string[]> {
    const names = await fsp.readdir(p);
    return names.sort(byCodeUnit);
  },

  async rmrf(p: string): Promise<void> {
    await fsp.rm(p, { recursive: true, force: true, maxRetries: 3 });
  },
};

/** A1-6 (Plan 5 Task 1; X-63): the canonical-root probe; src/data/canonRoot.ts imports and re-exports it. */
export interface RootProbe { realpathNative(p: string): string; exists(p: string): boolean; readText(p: string): string | null; isDir(p: string): boolean; }

/**
 * realpathNative = fs.realpathSync.native; exists = an lstat that does not follow a final symlink (false on any error);
 * readText = one readFileSync(p, 'utf8') or null on any error; isDir = lstat(p).isDirectory() (false when absent).
 * Synchronous: the hook loader's copy and core's hot path need no promise hop (Plan 5).
 */
export const realRootProbe: RootProbe = {
  realpathNative: (p: string): string => realpathSync.native(p),
  exists: (p: string): boolean => {
    try {
      return lstatSync(p, { throwIfNoEntry: false }) !== undefined;
    } catch {
      return false;
    }
  },
  readText: (p: string): string | null => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
  isDir: (p: string): boolean => {
    try {
      return lstatSync(p, { throwIfNoEntry: false })?.isDirectory() === true;
    } catch {
      return false;
    }
  },
};
