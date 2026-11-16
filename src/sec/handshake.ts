// src/sec/handshake.ts — SEC-22, INV-IPC, R5-45 (09 §3.11 "Handshake"): the mutual HMAC handshake over an Ipc connection, then the session
// channel. Each nonce is 16 random bytes from the Random port, each proof an HMAC-SHA256 compared with crypto.timingSafeEqual:
//   C → S  {"t":"hello","v":1,"n1":<b64 n1>}
//   S → C  {"t":"srv","n2":<b64 n2>,"p":<b64 HMAC(key, "srv" ‖ n1 ‖ n2 ‖ endpoint)>}
//   C → S  {"t":"cli","p":<b64 HMAC(key, "cli" ‖ n2 ‖ n1 ‖ endpoint)>}
// (raw nonce bytes, the endpoint as UTF-8). The server writes nothing before hello and the client nothing after hello until srv verifies;
// a session byte exists only on a SecureConn, which exists only after authentication. A3-3: src/sec comes before src/claude in the import
// order, so the session codec is injected (FrameCodec); the three handshake frames are fixed shapes checked here (base64 of exactly 16
// bytes for a nonce, 32 for a proof). No process.env read, no child_process; NONCE_BYTES and MAX_FRAME_BYTES are local copies of C's.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { realClock, type Clock } from '../ports/clock.js';
import type { IpcConn } from '../ports/ipc.js';
import type { Random } from '../ports/random.js';

/** 09 §3.11: each handshake nonce is 16 random bytes (= C.HANDSHAKE_NONCE_BYTES). */
export const NONCE_BYTES = 16;
/** SEC-22: a frame is at most 1 MiB, its newline excluded (= C.FRAME_MAX_BYTES). */
export const MAX_FRAME_BYTES = 1_048_576;
const MAC_BYTES = 32;

/** A3-3: the session codec — callers bind {reader: () => new LineReader(), encode: encodeFrame, validate: (d, v) => validateFrame('session', d, v)}.
 *  reader().push throws when a line passes the frame cap; validate answers null for an unknown t or a shape failure. */
export interface FrameCodec { reader(): { push(b: Buffer): string[] }; encode(f: object): Buffer; validate(dir: 'c2s' | 's2c', v: unknown): object | null; }
/** An authenticated channel: send, onFrame (frames that arrived before it are queued for it), onClose, close. Nothing else is reachable on it. */
export interface SecureConn<F extends object = object> { send(f: F): void; onFrame(cb: (f: F) => void): void; onClose(cb: () => void): void; close(): void; }

/** SEC-22, P5SEC #36: why a handshake failed — a wrong proof, a malformed or oversize handshake line, no authentication in time, or the peer
 *  closing after the handshake began (the server: after it sent srv; the client: before srv arrived). */
export type HandshakeFailure = 'mac' | 'shape' | 'timeout' | 'closed';

export class HandshakeFailed extends Error {
  readonly code = 'SEC_IPC_HANDSHAKE_FAILED' as const;
  constructor() {
    super('SEC_IPC_HANDSHAKE_FAILED');
  }
}
Object.defineProperty(HandshakeFailed.prototype, 'name', { value: 'HandshakeFailed' });

function proof(key: Buffer, label: 'srv' | 'cli', a: Buffer, b: Buffer, endpoint: string): Buffer {
  return createHmac('sha256', key).update(Buffer.from(label, 'utf8')).update(a).update(b).update(Buffer.from(endpoint, 'utf8')).digest();
}

/** Strict base64 of exactly n bytes (it must re-encode to itself), else null. */
function exactB64(v: unknown, n: number): Buffer | null {
  if (typeof v !== 'string') return null;
  const b = Buffer.from(v, 'base64');
  return b.length === n && b.toString('base64') === v ? b : null;
}

/** A JSON object line with exactly these keys and t === `t`, else null. */
function shaped(line: string, t: string, keys: readonly string[]): Record<string, unknown> | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const own = Object.keys(o);
  if (own.length !== keys.length || !keys.every((k) => own.includes(k)) || o['t'] !== t) return null;
  return o;
}

const handshakeLine = (o: object): Buffer => Buffer.from(`${JSON.stringify(o)}\n`, 'utf8');

interface Session { conn: SecureConn; line(l: string): void; abort(): void; closed(): void; }

/** The session half: incoming lines are parsed and validated (dir = the direction they travel); anything invalid destroys the connection. */
function session(c: IpcConn, codec: FrameCodec, dir: 'c2s' | 's2c'): Session {
  let frameCb: ((f: object) => void) | null = null;
  const queued: object[] = [];
  const closeCbs: Array<() => void> = [];
  let isClosed = false;
  let dead = false;
  const abort = (): void => {
    if (dead) return;
    dead = true;
    queued.length = 0;
    c.destroy();
  };
  const conn: SecureConn = Object.freeze({
    send(f: object): void {
      if (dead) return;
      const b = codec.encode(f);
      const size = b.length > 0 && b[b.length - 1] === 0x0a ? b.length - 1 : b.length;
      if (size > MAX_FRAME_BYTES) throw new RangeError('SecureConn.send: a frame over 1 MiB');
      c.write(b);
    },
    onFrame(cb: (f: object) => void): void {
      frameCb = cb;
      for (const f of queued.splice(0)) cb(f);
    },
    onClose(cb: () => void): void {
      if (isClosed) queueMicrotask(cb);
      else closeCbs.push(cb);
    },
    close(): void {
      if (dead) return;
      dead = true;
      c.end();
    },
  });
  return {
    conn,
    line(l: string): void {
      if (dead) return;
      let v: unknown;
      try {
        v = JSON.parse(l);
      } catch {
        abort();
        return;
      }
      const f = codec.validate(dir, v);
      if (f === null) {
        abort();
        return;
      }
      if (frameCb === null) queued.push(f);
      else frameCb(f);
    },
    abort,
    closed(): void {
      if (isClosed) return;
      isClosed = true;
      dead = true;
      for (const cb of closeCbs.splice(0)) cb();
    },
  };
}

// The clock requirement (Ruling P5-T3-1, A3-3): the handshake deadline is `clock.sleep(timeoutMs)`, armed when the handshake starts, so the
// clock passed to either handshake MUST NOT resolve a sleep before that much of its own time has passed. Production's realClock (real
// timers) and a harness-gated test clock (test/helpers/gatedClock.ts) do; the stock SIM VirtualClock, whose sleep advances its time and
// resolves at once, fails every handshake with 'timeout' and moves the peer clock forward by timeoutMs per side. A settled handshake ignores
// its deadline; the sleep is not cancelled (Plan 1's Clock has no cancellable sleep), so with realClock its timer stays referenced until
// timeoutMs after the start.

/**
 * Client: sends {t:'hello',v:1,n1}; verifies srv.p = HMAC(key, "srv" ‖ n1 ‖ n2 ‖ endpoint) with timingSafeEqual; sends cli.p = HMAC(key, "cli" ‖
 * n2 ‖ n1 ‖ endpoint); sends no session byte before srv verifies. A malformed or wrong srv, a close, or no srv within timeoutMs (on o.clock,
 * default the real clock; the clock requirement above) destroys the connection and rejects HandshakeFailed, after o.onFail (SEC-22, P5SEC #36:
 * the caller records the client side of every failed handshake) is told why, once: 'shape', 'mac', 'closed' or 'timeout'. Incoming
 * session frames are validated as 's2c'.
 */
export function clientHandshake(c: IpcConn, key: Buffer, endpoint: string, random: Random, timeoutMs: number, codec: FrameCodec,
  o?: {
    /** The deadline's clock (default realClock). Its sleep must not resolve before the clock has advanced (the clock requirement, P5-T3-1). */
    clock?: Clock;
    /** P5SEC #36: called once when this handshake fails, with why (a throwing callback is ignored: the handshake still settles). */
    onFail?: (why: HandshakeFailure) => void;
  }): Promise<SecureConn> {
  const clock = o?.clock ?? realClock;
  return new Promise((resolve, reject) => {
    const reader = codec.reader();
    const n1 = Buffer.from(random.bytes(NONCE_BYTES));
    let phase: 'srv' | 'session' | 'failed' = 'srv';
    let sess: Session | null = null;
    const report = (why: HandshakeFailure): void => {
      try {
        o?.onFail?.(why);
      } catch {
        // the caller's record is best-effort
      }
    };
    const fail = (why: HandshakeFailure): void => {
      if (phase !== 'srv') return;
      phase = 'failed';
      report(why);
      c.destroy();
      reject(new HandshakeFailed());
    };
    c.onClose(() => {
      if (phase === 'srv') {
        phase = 'failed';
        report('closed');
        reject(new HandshakeFailed());
      }
      sess?.closed();
    });
    c.onData((chunk) => {
      if (phase === 'failed') return;
      let lines: string[];
      try {
        lines = reader.push(chunk);
      } catch {
        if (sess !== null) sess.abort();
        else fail('shape');
        return;
      }
      for (const l of lines) {
        if (sess !== null) {
          sess.line(l);
          continue;
        }
        const srv = shaped(l, 'srv', ['t', 'n2', 'p']);
        const n2 = srv === null ? null : exactB64(srv['n2'], NONCE_BYTES);
        const p = n2 === null ? null : exactB64(srv?.['p'], MAC_BYTES);
        if (n2 === null || p === null) {
          fail('shape');
          return;
        }
        if (!timingSafeEqual(p, proof(key, 'srv', n1, n2, endpoint))) {
          fail('mac');
          return;
        }
        c.write(handshakeLine({ t: 'cli', p: proof(key, 'cli', n2, n1, endpoint).toString('base64') }));
        phase = 'session';
        sess = session(c, codec, 's2c');
        resolve(sess.conn);
      }
    });
    c.write(handshakeLine({ t: 'hello', v: 1, n1: n1.toString('base64') }));
    void clock.sleep(timeoutMs).then(() => fail('timeout'));
  });
}

/**
 * Server: sends nothing before hello; answers it with srv; verifies cli with timingSafeEqual; then frames are NDJSON ≤ 1 MiB validated by
 * codec.validate('c2s', …) — an unknown t, a schema failure, a line that is not JSON or an oversize line destroys the connection. A
 * malformed hello or cli (onFail('shape')), a wrong proof (onFail('mac')) or no authentication within o.timeoutMs on o.clock
 * (onFail('timeout'); Task 5 binds 3,000; the clock's sleep must wait for the clock to advance: the clock requirement, Ruling P5-T3-1) closes at
 * once and rejects HandshakeFailed. A peer that closes after it was sent srv, without a cli, is a failed handshake too (P5SEC #36, SEC-22
 * "every failed handshake": it collected a proof and never authenticated): onFail('closed'), auth_fail. A peer that closes before its hello was
 * sent nothing and proved nothing: it only rejects. onEvent (the O-IPC trace input): 'accept', then 'auth_ok' or 'auth_fail',
 * then 'close'; its byte count is the session bytes written to the peer before it authenticated — 0 by construction, since session bytes
 * are written only through the SecureConn that authentication creates.
 */
export function serverHandshake(c: IpcConn, key: Buffer, endpoint: string, random: Random, onFail: (why: HandshakeFailure) => void,
  codec: FrameCodec, o: {
    /** The deadline's clock. Its sleep must not resolve before the clock has advanced (the clock requirement, Ruling P5-T3-1): a stock
     *  VirtualClock fails every handshake with 'timeout'; SIM bindings pass a harness-gated clock. */
    clock: Clock;
    timeoutMs: number;
    onEvent?: (op: 'accept' | 'auth_ok' | 'auth_fail' | 'close', bytesToUnauthenticated: number) => void;
  }):
Promise<SecureConn> {
  const event = (op: 'accept' | 'auth_ok' | 'auth_fail' | 'close'): void => o.onEvent?.(op, 0);
  return new Promise((resolve, reject) => {
    const reader = codec.reader();
    let phase: 'hello' | 'cli' | 'session' | 'failed' = 'hello';
    let n1: Buffer = Buffer.alloc(0);
    let n2: Buffer = Buffer.alloc(0);
    let sess: Session | null = null;
    event('accept');
    const fail = (why: Exclude<HandshakeFailure, 'closed'>): void => {
      if (phase !== 'hello' && phase !== 'cli') return;
      phase = 'failed';
      event('auth_fail');
      onFail(why);
      c.destroy();
      reject(new HandshakeFailed());
    };
    c.onClose(() => {
      if (phase === 'cli') {
        phase = 'failed';
        event('auth_fail');
        onFail('closed');
        reject(new HandshakeFailed());
      } else if (phase === 'hello') {
        phase = 'failed';
        reject(new HandshakeFailed());
      }
      sess?.closed();
      event('close');
    });
    c.onData((chunk) => {
      if (phase === 'failed') return;
      let lines: string[];
      try {
        lines = reader.push(chunk);
      } catch {
        if (sess !== null) sess.abort();
        else fail('shape');
        return;
      }
      for (const l of lines) {
        if (sess !== null) {
          sess.line(l);
          continue;
        }
        if (phase === 'hello') {
          const hello = shaped(l, 'hello', ['t', 'v', 'n1']);
          const nonce = hello === null || hello['v'] !== 1 ? null : exactB64(hello['n1'], NONCE_BYTES);
          if (nonce === null) {
            fail('shape');
            return;
          }
          n1 = nonce;
          n2 = Buffer.from(random.bytes(NONCE_BYTES));
          c.write(handshakeLine({ t: 'srv', n2: n2.toString('base64'), p: proof(key, 'srv', n1, n2, endpoint).toString('base64') }));
          phase = 'cli';
          continue;
        }
        if (phase !== 'cli') return;
        const cli = shaped(l, 'cli', ['t', 'p']);
        const p = cli === null ? null : exactB64(cli['p'], MAC_BYTES);
        if (p === null) {
          fail('shape');
          return;
        }
        if (!timingSafeEqual(p, proof(key, 'cli', n2, n1, endpoint))) {
          fail('mac');
          return;
        }
        phase = 'session';
        sess = session(c, codec, 'c2s');
        event('auth_ok');
        resolve(sess.conn);
      }
    });
    void o.clock.sleep(o.timeoutMs).then(() => fail('timeout'));
  });
}
