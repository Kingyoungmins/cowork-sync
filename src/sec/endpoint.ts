// src/sec/endpoint.ts — SEC-21 (09 §3.11 "Endpoint name"): the IPC endpoint of one clone and, on POSIX, the directory its socket lives in.
// The name is k = HMAC-SHA256(key, "endpoint:" ‖ root), root = the canonical repo root form of the common gitdir (src/data/canonRoot.ts
// endpointRoot, which the caller passes in), so two spellings of one clone reach one endpoint and the name cannot be guessed without the key.
// src/sec comes before src/claude in the import order: the socket-path limit is a local copy, pinned equal to C.SOCKET_PATH_MAX_BYTES.
// No process.env read here (the environment reaches socketDir as a parameter); no child_process.
import { createHmac } from 'node:crypto';
import { posix } from 'node:path';
import type { Fs } from '../ports/fs.js';

/** 09 §3.11: a full Unix socket path is at most 100 bytes (the shortest sun_path limit, macOS 104, minus room). = C.SOCKET_PATH_MAX_BYTES. */
export const SOCKET_PATH_MAX_BYTES = 100;

/** socketDir's probe name: a socket file name of the endpoint's length (24 hex + .sock), so the ≤ 100-byte check sees the real path length. */
export const SOCK_NAME = `${'0'.repeat(24)}.sock`;

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;

/**
 * k = HMAC-SHA256(key, "endpoint:" ‖ endpointRoot) (UTF-8); win32 `\\.\pipe\cowork-<hex(k[0..16])>`; POSIX `<socketDir>/<hex(k[0..12])>.sock`
 * (socketDir required there: a TypeError when null).
 */
export function endpointName(key: Buffer, endpointRoot: string, platform: NodeJS.Platform, socketDir: string | null): string {
  const k = createHmac('sha256', key).update(Buffer.from(`endpoint:${endpointRoot}`, 'utf8')).digest();
  if (platform === 'win32') return `\\\\.\\pipe\\cowork-${k.subarray(0, 16).toString('hex')}`;
  if (socketDir === null) throw new TypeError('endpointName: a POSIX endpoint needs its socket directory');
  return posix.join(socketDir, `${k.subarray(0, 12).toString('hex')}.sock`);
}

/**
 * The first of `$XDG_RUNTIME_DIR/cowork-sync` (XDG_RUNTIME_DIR set, non-empty and absolute) and `/tmp/cws-<uid>` whose full socket path
 * `<dir>/<sockName>` is ≤ 100 UTF-8 bytes. Only the final component is created (mkdirp(dir, 0o700), and only when its parent exists as a
 * directory — a candidate whose parent is missing is skipped); then lstat must show a directory (not a symlink), owned by uid, permission
 * bits exactly 0o700 (a setgid bit inherited from the parent is not a permission).
 * A candidate that fits but fails that check refuses (SEC_REFUSE_SOCKET_PATH) — it is never changed and never replaced by the next one;
 * no candidate that fits refuses too.
 */
export async function socketDir(env: Readonly<Record<string, string | undefined>>, uid: number, fs: Fs, sockName: string):
Promise<{ ok: true; dir: string } | { ok: false; code: 'SEC_REFUSE_SOCKET_PATH' }> {
  const refuse = { ok: false, code: 'SEC_REFUSE_SOCKET_PATH' } as const;
  const xdg = env['XDG_RUNTIME_DIR'];
  const candidates: Array<[parent: string, dir: string]> = [];
  if (xdg !== undefined && xdg !== '' && xdg.startsWith('/')) candidates.push([xdg, posix.join(xdg, 'cowork-sync')]);
  candidates.push(['/tmp', `/tmp/cws-${uid}`]);

  for (const [parent, dir] of candidates) {
    if (Buffer.byteLength(posix.join(dir, sockName), 'utf8') > SOCKET_PATH_MAX_BYTES) continue;
    const up = await fs.stat(parent).catch(() => null);
    if (up === null || !up.isDirectory) continue;
    try {
      await fs.mkdirp(dir, 0o700);   // a no-op on an existing directory: its mode is checked below, never changed
    } catch {
      // whatever is there is judged by the lstat below
    }
    const s = await fs.lstat(dir).catch(() => null);
    const ok = s !== null && s.isDirectory && !s.isSymbolicLink && s.uid === uid && (s.mode & S_IFMT) === S_IFDIR && (s.mode & 0o777) === 0o700;
    return ok ? { ok: true, dir } : refuse;
  }
  return refuse;
}
