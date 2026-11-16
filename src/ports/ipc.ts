// src/ports/ipc.ts — the 11 §3.2 Ipc seam ("the same, real" in SIM): named pipes on win32, Unix sockets elsewhere, raw bytes and no
// authentication (src/sec/handshake.ts authenticates before any session byte). L-NET allows node:net here (A1-9). No process.env read, no
// child_process; the socket file checks of removeStale go through the Fs port (L-FS-PORT).
import net from 'node:net';
import { errnoCode, realFs } from './fs.js';

export interface IpcConn { write(b: Buffer): void; onData(cb: (b: Buffer) => void): void; onClose(cb: () => void): void; end(): void; destroy(): void; }
export interface IpcServer { close(): Promise<void>; }
export interface Ipc {
  /** Binds a named pipe (win32) or Unix socket; rejects with an error whose code is 'EADDRINUSE' when taken (never unlinks a socket file: the squatter check decides). */
  listen(endpoint: string, onConn: (c: IpcConn) => void): Promise<IpcServer>;
  connect(endpoint: string, timeoutMs: number): Promise<IpcConn>;
  /** A3-5, POSIX only: true after unlinking endpoint when a connect to it fails with ECONNREFUSED and lstat shows a socket owned by this uid; false otherwise and always
   *  on win32 (a pipe disappears with its process). ClaudeServer.listen calls it once on EADDRINUSE before the squatter handshake; a live listener is never removed. */
  removeStale(endpoint: string): Promise<boolean>;
}

const S_IFMT = 0o170000;
const S_IFSOCK = 0o140000;
/** How long removeStale's probe waits for a connect to settle; a listener that neither accepts nor refuses in that time is left alone. */
const STALE_PROBE_MS = 1_000;

/** A connected socket as an IpcConn: data is not read until someone listens (the stream stays paused); errors are swallowed because
 *  'close' follows every one of them; onClose after the close calls back on a microtask. */
function wrap(sock: net.Socket): IpcConn {
  let closed = false;
  const closeCbs: Array<() => void> = [];
  sock.on('error', () => {});
  sock.once('close', () => {
    closed = true;
    for (const cb of closeCbs.splice(0)) cb();
  });
  return {
    write: (b) => {
      if (!sock.destroyed && sock.writable) sock.write(b);
    },
    onData: (cb) => {
      sock.on('data', (chunk: Buffer) => cb(chunk));
    },
    onClose: (cb) => {
      if (closed) queueMicrotask(cb);
      else closeCbs.push(cb);
    },
    end: () => {
      sock.end();
    },
    destroy: () => {
      sock.destroy();
    },
  };
}

/** One connect attempt to endpoint, settled as the socket would settle it: 'live' (it accepted), else the error code, 'timeout' past ms. */
function probe(endpoint: string, ms: number): Promise<'live' | 'timeout' | string> {
  return new Promise((resolve) => {
    const s = net.connect(endpoint);
    const timer = setTimeout(() => {
      s.destroy();
      resolve('timeout');
    }, ms);
    s.once('connect', () => {
      clearTimeout(timer);
      s.destroy();
      resolve('live');
    });
    s.once('error', (e) => {
      clearTimeout(timer);
      s.destroy();
      resolve(errnoCode(e) ?? 'error');
    });
  });
}

export const realIpc: Ipc = {
  listen(endpoint: string, onConn: (c: IpcConn) => void): Promise<IpcServer> {
    return new Promise((resolve, reject) => {
      const sockets = new Set<net.Socket>();
      const server = net.createServer((sock) => {
        sockets.add(sock);
        sock.once('close', () => sockets.delete(sock));
        onConn(wrap(sock));
      });
      const failed = (e: Error): void => reject(e);
      server.once('error', failed);
      server.listen(endpoint, () => {
        server.off('error', failed);
        server.on('error', () => {});
        resolve({
          // Stops accepting and ends every accepted connection (their peers see a close), then resolves.
          close: () => new Promise<void>((done) => {
            server.close(() => done());
            for (const s of sockets) s.destroy();
          }),
        });
      });
    });
  },

  connect(endpoint: string, timeoutMs: number): Promise<IpcConn> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(endpoint);
      const timer = setTimeout(() => {
        sock.destroy();
        reject(Object.assign(new Error('IPC connect timed out'), { code: 'ETIMEDOUT' }));
      }, Math.max(0, timeoutMs));
      const failed = (e: Error): void => {
        clearTimeout(timer);
        sock.destroy();
        reject(e);
      };
      sock.once('error', failed);
      sock.once('connect', () => {
        clearTimeout(timer);
        sock.off('error', failed);
        resolve(wrap(sock));
      });
    });
  },

  async removeStale(endpoint: string): Promise<boolean> {
    if (process.platform === 'win32') return false;
    const uid = process.getuid?.();
    const st = await realFs.lstat(endpoint).catch(() => null);
    if (uid === undefined || st === null || st.isSymbolicLink || (st.mode & S_IFMT) !== S_IFSOCK || st.uid !== uid) return false;
    if ((await probe(endpoint, STALE_PROBE_MS)) !== 'ECONNREFUSED') return false;
    // Still the very file that refused (not swapped meanwhile), then unlinked.
    const again = await realFs.lstat(endpoint).catch(() => null);
    if (again === null || again.isSymbolicLink || again.ino !== st.ino || again.dev !== st.dev) return false;
    try {
      await realFs.unlink(endpoint);
      return true;
    } catch {
      return false;
    }
  },
};
