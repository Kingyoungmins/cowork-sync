// status.json fixtures of the viewer's source tests (Plan 8a Task 7; 12 §3.3.2, §3.3.6): a Plan 2 status.json with every
// glossary §14 field, and a two-method in-memory Fs (lstat and readFile) for the pure overlay tests.
import type { Fs, FsLstat } from '../../src/ports/fs.js';

/** A status.json object with every glossary §14 field (Plan 2's StatusJson), `over` merged over the defaults. */
export function statusJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1, state: 'ok', freeze_reasons: [], publish_pause: null, branch: 'main', peer_id: 'a1'.repeat(16), plugin_version: '0.0.0',
    heartbeat_mono_ms: 1_000_000, loop_period_ms: 2_500, last_fetch_age_ms: 1_000, last_push_age_ms: null,
    pending: { cs_ready: 0, cs_open: 0, holds_active: 0, holds_local_only: 0, incoming: 0, not_converged: [] },
    claims_held: 0, requests_in: 0, requests_out: 0, adopt: { state: 'current', reasons: [] },
    message_code: null, message_params: {},
    ...over,
  };
}

export function statusBytes(over: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify(statusJson(over)), 'utf8');
}

/** One in-memory file: its bytes and its mtime (a regular file unless `kind` says otherwise). */
export interface MemFile { data: Buffer; mtimeNs: bigint; kind?: 'file' | 'dir'; }

/** An Fs over a path → file map: lstat and readFile only (every other call throws); a missing path reads as absent. */
export function memFs(files: Map<string, MemFile>, calls: string[] = []): Fs {
  const unused = (op: string) => async (): Promise<never> => {
    throw new Error(`memFs: ${op} is not used by the viewer's status reads`);
  };
  const lstat = async (p: string): Promise<FsLstat | null> => {
    calls.push(`lstat ${p}`);
    const f = files.get(p);
    if (f === undefined) return null;
    const dir = f.kind === 'dir';
    return { size: f.data.length, mtimeNs: f.mtimeNs, ino: 1n, dev: 1n, mode: dir ? 0o40755 : 0o100644, isFile: !dir, isDirectory: dir, isSymbolicLink: false };
  };
  const readFile = async (p: string): Promise<Buffer> => {
    calls.push(`readFile ${p}`);
    const f = files.get(p);
    if (f === undefined) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: 'ENOENT' });
    return Buffer.from(f.data);
  };
  return {
    lstat, readFile,
    writeFile: unused('writeFile'), rename: unused('rename'), link: unused('link'), unlink: unused('unlink'), stat: unused('stat'), mkdirp: unused('mkdirp'),
    readdir: unused('readdir'), rmrf: unused('rmrf'), writeFileExclusive: unused('writeFileExclusive'), rmdir: unused('rmdir'), appendFile: unused('appendFile'),
    realpath: unused('realpath'), freeBytes: unused('freeBytes'), chmod: unused('chmod'),
  };
}

/** Rejects when `p` has not settled within `ms` (a read that blocks on a FIFO or /dev/zero fails the test instead of hanging it). */
export async function within<T>(ms: number, p: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: still pending after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, t]);
  } finally {
    clearTimeout(timer);
  }
}
