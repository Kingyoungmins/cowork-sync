// Bounded one-shot reads (12 §3.3.2, §3.9.3, VIZ-27; Plan 8a ruling R-V30; S16): the three files the viewer reads outside
// git — <gitdir>/cowork/status.json (≤ 1 MiB), <gitdir>/cowork/peer (≤ 4 KiB) and a --demo file (≤ 4 MiB) — each one
// open-read-close that never holds a handle past the call (glossary §26.1 W3), never follows a symlink, never blocks on a
// FIFO or a device and never reads more than max + 1 bytes. The second file of src/viz/** allowed node:fs (R-V34).
import { constants, promises as fsp } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import type { Fs } from '../../ports/fs.js';

/** null: the file does not exist (ENOENT, or ENOTDIR on the way). Any other error propagates (EPERM, EACCES, EBUSY: the caller keeps its previous read). */
export interface BoundedReader { read(path: string, max: number): Promise<Buffer | 'not_file' | 'too_large' | null>; }

/** The flags where the platform defines them: O_NOFOLLOW (a final symlink fails the open) and O_NONBLOCK (a FIFO opens without a writer). */
const NOFOLLOW: number | undefined = constants.O_NOFOLLOW;
const NONBLOCK: number | undefined = constants.O_NONBLOCK;
const OPEN_FLAGS = constants.O_RDONLY | (NOFOLLOW ?? 0) | (NONBLOCK ?? 0);

function codeOf(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null ? (e as NodeJS.ErrnoException).code : undefined;
}

function checkMax(max: number): void {
  if (!Number.isSafeInteger(max) || max < 0) throw new RangeError(`BoundedReader: max must be a non-negative integer, got ${String(max)}`);
}

/**
 * open(O_RDONLY | O_NOFOLLOW | O_NONBLOCK where defined; where O_NOFOLLOW is not, as on Windows, an lstat just before the
 * open must not report a symlink or a directory), fstat().isFile() else 'not_file', read ≤ max + 1 bytes ('too_large' when
 * the extra byte arrives), close in finally. ENOENT/ENOTDIR → null; ELOOP/EMLINK (a symlink under O_NOFOLLOW) and EISDIR →
 * 'not_file'; EPERM, EACCES, EBUSY and every other error propagate.
 */
export const realBoundedReader: BoundedReader = {
  async read(path: string, max: number): Promise<Buffer | 'not_file' | 'too_large' | null> {
    checkMax(max);
    if (NOFOLLOW === undefined) {
      let l;
      try {
        l = await fsp.lstat(path);
      } catch (e) {
        if (codeOf(e) === 'ENOENT' || codeOf(e) === 'ENOTDIR') return null;
        throw e;
      }
      if (l.isSymbolicLink() || !l.isFile()) return 'not_file';
    }
    let h: FileHandle;
    try {
      h = await fsp.open(path, OPEN_FLAGS);
    } catch (e) {
      const code = codeOf(e);
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      if (code === 'ELOOP' || code === 'EMLINK' || code === 'EISDIR') return 'not_file';
      throw e;
    }
    try {
      if (!(await h.stat()).isFile()) return 'not_file';
      const buf = Buffer.alloc(max + 1);
      let n = 0;
      while (n < buf.length) {
        const { bytesRead } = await h.read(buf, n, buf.length - n, null);
        if (bytesRead === 0) break;
        n += bytesRead;
      }
      if (n > max) return 'too_large';
      return Buffer.from(buf.subarray(0, n));
    } finally {
      await h.close();
    }
  },
};

/**
 * Over the Fs port, for tests that need FaultFs's rename-over and share-none emulation: lstat (absent → null; not a regular
 * file, a symlink included → 'not_file'; larger than max → 'too_large'), then one readFile (ENOENT → null; a file that grew
 * past max → 'too_large'). Every other error propagates.
 */
export function fsBoundedReader(fs: Fs): BoundedReader {
  return {
    async read(path: string, max: number): Promise<Buffer | 'not_file' | 'too_large' | null> {
      checkMax(max);
      const l = await fs.lstat(path);
      if (l === null) return null;
      if (l.isSymbolicLink || !l.isFile) return 'not_file';
      if (l.size > max) return 'too_large';
      let buf: Buffer;
      try {
        buf = await fs.readFile(path);
      } catch (e) {
        if (codeOf(e) === 'ENOENT' || codeOf(e) === 'ENOTDIR') return null;
        throw e;
      }
      return buf.length > max ? 'too_large' : buf;
    },
  };
}
