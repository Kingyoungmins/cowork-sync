// Plan 5 Task 3: IPC byte capture for the INV-IPC tests (O-IPC input; 09 tests 20, TC-SEC-03). ipcCapture wraps an Ipc (realIpc in the
// integration tests) and records, per connection, every byte written and every byte received, in order; captureConn wraps one IpcConn
// (the in-memory pair of the unit tests). The handshake/session boundary is marked by line: a written line that is one of the three
// handshake frames (hello{v,n1}, srv, cli) is handshake; the first written line that is not starts the session bytes (sessionStart()).
import type { Ipc, IpcConn, IpcServer } from '../../src/ports/ipc.js';

export interface CaptureEvent { dir: 'in' | 'out'; bytes: Buffer; }

function isHandshakeLine(line: string): boolean {
  try {
    const v = JSON.parse(line) as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
    const t = (v as Record<string, unknown>)['t'];
    return t === 'srv' || t === 'cli' || (t === 'hello' && 'v' in v && 'n1' in v);
  } catch {
    return false;
  }
}

/** Complete lines of a byte stream (a trailing partial line is left out). */
function linesOf(b: Buffer): string[] {
  const out: string[] = [];
  let start = 0;
  for (let nl = b.indexOf(0x0a); nl >= 0; nl = b.indexOf(0x0a, start)) {
    out.push(b.subarray(start, nl).toString('utf8'));
    start = nl + 1;
  }
  return out;
}

export class CapturedConn implements IpcConn {
  readonly events: CaptureEvent[] = [];
  private readonly listeners: Array<(b: Buffer) => void> = [];
  private hooked = false;
  constructor(private readonly inner: IpcConn) {}

  write(b: Buffer): void {
    this.events.push({ dir: 'out', bytes: Buffer.from(b) });
    this.inner.write(b);
  }
  onData(cb: (b: Buffer) => void): void {
    this.listeners.push(cb);
    if (this.hooked) return;
    this.hooked = true;   // subscribe once, on first use: an unsubscribed stream stays paused (nothing is read before someone listens)
    this.inner.onData((b) => {
      this.events.push({ dir: 'in', bytes: Buffer.from(b) });
      for (const l of [...this.listeners]) l(b);
    });
  }
  onClose(cb: () => void): void { this.inner.onClose(cb); }
  end(): void { this.inner.end(); }
  destroy(): void { this.inner.destroy(); }

  /** Every byte written to the peer. */
  out(): Buffer { return Buffer.concat(this.events.filter((e) => e.dir === 'out').map((e) => e.bytes)); }
  /** Every byte received from the peer. */
  in(): Buffer { return Buffer.concat(this.events.filter((e) => e.dir === 'in').map((e) => e.bytes)); }
  outLines(): string[] { return linesOf(this.out()); }
  inLines(): string[] { return linesOf(this.in()); }
  /** The boundary: the byte offset in out() where the first written line that is not a handshake frame starts; null while there is none. */
  sessionStart(): number | null {
    let offset = 0;
    for (const line of this.outLines()) {
      if (!isHandshakeLine(line)) return offset;
      offset += Buffer.byteLength(line, 'utf8') + 1;
    }
    const out = this.out();
    return offset < out.length ? offset : null;   // an unterminated tail is session bytes too
  }
  /** Bytes written after the boundary (0 when there is none). */
  sessionBytes(): number {
    const s = this.sessionStart();
    return s === null ? 0 : this.out().length - s;
  }
  /** Bytes written before the first received line whose t is `t` was complete; all bytes written when it never arrived. */
  outBeforeReceived(t: string): number {
    let written = 0;
    let received = Buffer.alloc(0);
    for (const e of this.events) {
      if (e.dir === 'out') {
        written += e.bytes.length;
        continue;
      }
      received = Buffer.concat([received, e.bytes]);
      const hit = linesOf(received).some((l) => {
        try {
          return (JSON.parse(l) as { t?: unknown }).t === t;
        } catch {
          return false;
        }
      });
      if (hit) return written;
    }
    return written;
  }
}

export function captureConn(c: IpcConn): CapturedConn {
  return new CapturedConn(c);
}

/** inner with every accepted and every connected connection captured, in order. */
export function ipcCapture(inner: Ipc): Ipc & { readonly accepted: CapturedConn[]; readonly connected: CapturedConn[] } {
  const accepted: CapturedConn[] = [];
  const connected: CapturedConn[] = [];
  return {
    accepted,
    connected,
    listen: (endpoint: string, onConn: (c: IpcConn) => void): Promise<IpcServer> => inner.listen(endpoint, (c) => {
      const cc = new CapturedConn(c);
      accepted.push(cc);
      onConn(cc);
    }),
    connect: async (endpoint: string, timeoutMs: number): Promise<IpcConn> => {
      const cc = new CapturedConn(await inner.connect(endpoint, timeoutMs));
      connected.push(cc);
      return cc;
    },
    removeStale: (endpoint: string): Promise<boolean> => inner.removeStale(endpoint),
  };
}

/** One end of an in-memory connection: writes reach the peer on later microtasks (in order, split into `chunk`-byte pieces when given);
 *  bytes that arrive before anyone listens wait; end() closes both ends after the writes before it, destroy() at once (dropping them). */
class MemoryEnd implements IpcConn {
  peer!: MemoryEnd;
  private closed = false;
  private readonly dataCbs: Array<(b: Buffer) => void> = [];
  private readonly closeCbs: Array<() => void> = [];
  private pending: Buffer[] = [];
  constructor(private readonly chunk: number) {}

  write(b: Buffer): void {
    if (this.closed) return;
    const copy = Buffer.from(b);
    for (let i = 0; i < copy.length; i += this.chunk) {
      const piece = copy.subarray(i, Math.min(copy.length, i + this.chunk));
      queueMicrotask(() => this.peer.receive(piece));
    }
  }
  private receive(b: Buffer): void {
    if (this.closed) return;
    if (this.dataCbs.length === 0) this.pending.push(b);
    else for (const cb of [...this.dataCbs]) cb(b);
  }
  onData(cb: (b: Buffer) => void): void {
    this.dataCbs.push(cb);
    const waiting = this.pending;
    this.pending = [];
    for (const b of waiting) cb(b);
  }
  onClose(cb: () => void): void {
    if (this.closed) queueMicrotask(cb);
    else this.closeCbs.push(cb);
  }
  end(): void {
    queueMicrotask(() => this.closeBoth());
  }
  destroy(): void {
    this.closeBoth();
  }
  private closeBoth(): void {
    this.closeSelf();
    this.peer.closeSelf();
  }
  private closeSelf(): void {
    if (this.closed) return;
    this.closed = true;
    const cbs = this.closeCbs.splice(0);
    queueMicrotask(() => { for (const cb of cbs) cb(); });
  }
}

/** Two connected in-memory ends [client, server]. */
export function memoryPair(o?: { chunk?: number }): [IpcConn, IpcConn] {
  const chunk = o?.chunk ?? Number.MAX_SAFE_INTEGER;
  const a = new MemoryEnd(chunk);
  const b = new MemoryEnd(chunk);
  a.peer = b;
  b.peer = a;
  return [a, b];
}
