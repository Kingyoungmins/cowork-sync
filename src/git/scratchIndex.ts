// The engine's scratch indexes (ruling P2-SCRATCHLOCK, Task 15 ruling: one shared helper). The engine owns its tmp
// scratch indexes (used only under state.lock), so every read-tree into one first removes the index and a stale
// `<index>.lock` (a git child killed mid-write): a leftover lock never wedges every later comparison, capture, rebase or
// tree edit. Never .git/index.lock and never the private index. It lives in src/git so that src/holds (the capture) and
// src/engine (DISK_EQ, the snapshot, publish, apply, restart, the tree edits) share it; src/engine/diskEq.ts re-exports it.
import type { Fs } from '../ports/fs.js';

function isGoneError(e: unknown): boolean {
  const code = typeof e === 'object' && e !== null ? (e as NodeJS.ErrnoException).code : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * A scratch index (or its lock) could not be removed (a Windows holder: EPERM, EACCES, EBUSY). Typed, so publishStep reads
 * it as a build failure of that window (never an exception out of the step) and the ok update keeps its push intent;
 * `code` keeps the errno code for callers that classify by it.
 */
export class ScratchResetError extends Error {
  readonly file: string;
  readonly code: string | undefined;
  constructor(file: string, cause: unknown) {
    const code = typeof cause === 'object' && cause !== null ? (cause as NodeJS.ErrnoException).code : undefined;
    super(`the scratch index ${file} could not be reset (${code ?? 'unknown'})`);
    this.name = 'ScratchResetError';
    this.file = file;
    this.code = typeof code === 'string' ? code : undefined;
  }
}

/** Deletes a scratch index and a stale lock of it, so every use starts from an empty index; ScratchResetError when one cannot be removed (a file already gone is fine). */
export async function resetScratchIndex(fs: Fs, indexFile: string): Promise<void> {
  for (const f of [indexFile, `${indexFile}.lock`]) {
    try {
      await fs.unlink(f);
    } catch (e) {
      if (!isGoneError(e)) throw new ScratchResetError(f, e);
    }
  }
}
