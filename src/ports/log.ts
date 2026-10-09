// Log port (ruling R-37): append-only JSON lines of codes, oids, paths and numbers,
// never file content. Rotation is Plan 7.
import type { Clock } from './clock.js';
import type { Fs } from './fs.js';

export type LogLevel = 'info' | 'warn' | 'error' | 'security';
export type LogParam = string | number | boolean | null;

export interface Log {
  write(level: LogLevel, code: string, params?: Readonly<Record<string, LogParam>>): void;
}

export const nullLog: Log = { write: () => {} };

/** A file log whose queue can be awaited: flush() resolves once every line written so far has landed (or was dropped). */
export interface FileLog extends Log {
  flush(): Promise<void>;
}

/**
 * Appends {"t":<wall ms>,"level","code","params"} lines through the Fs port, one
 * write at a time (queued, so lines never interleave and keep call order). A failed
 * append drops that line: logging never throws into the engine. flush() before the
 * process exits keeps the last lines (the daemon's exit path).
 */
export function fileLog(fs: Fs, clock: Clock, file: string): FileLog {
  let tail: Promise<void> = Promise.resolve();
  return {
    flush: () => tail,
    write(level, code, params) {
      const line = Buffer.from(
        JSON.stringify({ t: clock.wallMs(), level, code, params: params ?? {} }) + '\n',
        'utf8',
      );
      tail = tail.then(() => fs.appendFile(file, line)).catch(() => {});
    },
  };
}
