// File-access spies for the viewer server tests: spyFs records every call on one Fs port object (the log's own files), and
// spyNodeFs records every file call that reaches node:fs from anywhere in the process — the Fs port's realFs, a stray
// node:fs import and the fs/promises module alike — so a test can show that no URL causes a file access.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mock } from 'node:test';
import { realFs, type Fs } from '../../src/ports/fs.js';

export interface FsCall { op: string; paths: string[]; }

/** `inner` (realFs by default) with every call recorded: the op and its string arguments. */
export function spyFs(calls: FsCall[], inner: Fs = realFs): Fs {
  const out: Partial<Record<keyof Fs, unknown>> = {};
  for (const op of Object.keys(inner) as Array<keyof Fs>) {
    out[op] = (...args: unknown[]): unknown => {
      calls.push({ op, paths: args.filter((a): a is string => typeof a === 'string') });
      return (inner[op] as (...a: unknown[]) => unknown)(...args);
    };
  }
  return out as Fs;
}

/** The node:fs entry points that name a file: callback, sync and promise forms (realpath is left out: realpathSync.native). */
const FILE_OPS = [
  'access', 'appendFile', 'copyFile', 'cp', 'link', 'lstat', 'mkdir', 'open', 'opendir', 'readFile', 'readdir', 'readlink', 'rename', 'rm',
  'rmdir', 'stat', 'statfs', 'symlink', 'truncate', 'unlink', 'utimes', 'writeFile',
] as const;
const SYNC_ONLY = ['existsSync', 'createReadStream', 'createWriteStream', 'exists'] as const;

const TWO_PATHS: ReadonlySet<string> = new Set(['copyFile', 'cp', 'link', 'rename', 'symlink']);

/** The path arguments of a call: the first, and the second for the ops that take two (data and options are not paths). */
function pathArgs(op: string, args: unknown[]): string[] {
  const out: string[] = [];
  for (const a of args.slice(0, TWO_PATHS.has(op) ? 2 : 1)) {
    if (typeof a === 'string') out.push(a);
    else if (Buffer.isBuffer(a)) out.push(a.toString('utf8'));
    else if (a instanceof URL) out.push(a.href);
    else if (typeof a === 'number') out.push(`fd ${a}`);
  }
  return out;
}

/** Records every call of the node:fs file entry points until the returned restore() runs. The ESM named exports of node:fs and
 *  node:fs/promises are re-synced both ways, so `import { readFile } from 'node:fs/promises'` is seen too. */
export function spyNodeFs(calls: FsCall[]): () => void {
  const mocks: Array<{ mock: { restore(): void } }> = [];
  const wrap = (obj: object, name: string, label: string): void => {
    const original = (obj as Record<string, unknown>)[name];
    if (typeof original !== 'function') return;
    const op = name.replace(/Sync$/, '');
    mocks.push(mock.method(obj as Record<string, (...a: unknown[]) => unknown>, name, function (this: unknown, ...args: unknown[]): unknown {
      calls.push({ op: label, paths: pathArgs(op, args) });
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    }));
  };
  for (const op of FILE_OPS) {
    wrap(fs, op, op);
    wrap(fs, `${op}Sync`, `${op}Sync`);
    wrap(fs.promises, op, `promises.${op}`);
  }
  for (const op of SYNC_ONLY) wrap(fs, op, op);
  syncBuiltinESMExports();
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const m of mocks) m.mock.restore();
    syncBuiltinESMExports();
  };
}
