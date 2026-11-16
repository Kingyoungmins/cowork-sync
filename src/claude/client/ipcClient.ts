// src/claude/client/ipcClient.ts — the client side of the local IPC (06 §3.4.2 steps 2–4, §3.4.4; R1-222, R1-223, R1-311, CCI-10, CCI-17 client half;
// A4-5, P5-EC-3): the loader deadline, opening an authenticated session (a verified key, the SEC-21 endpoint, connect + the SEC-22 handshake, retried
// every 50 ms until the deadline) and one request. Every wait is on the deadline's clock (P5-EC-3), so the handshake and the retry sleeps run on the
// caller's clock — production machineClock, a SIM seat a harness-gated clock (Ruling P5-T3-1: never the stock VirtualClock for a handshake).
import { C } from '../wire/constants.js';
import type { SessionClientFrame, SessionServerFrame } from '../wire/frames.js';
import { encodeFrame, LineReader } from '../wire/ndjson.js';
import { validateFrame } from '../wire/schema.js';
import type { LiveRepo } from '../../data/canonRoot.js';
import type { Clock } from '../../ports/clock.js';
import type { Fs } from '../../ports/fs.js';
import type { Ipc } from '../../ports/ipc.js';
import type { Random } from '../../ports/random.js';
import { endpointName, SOCK_NAME, socketDir } from '../../sec/endpoint.js';
import { clientHandshake, type FrameCodec, type HandshakeFailure, type SecureConn } from '../../sec/handshake.js';
import { readIpcKey } from '../../sec/ipcKey.js';
import type { WinAcl } from '../../sec/winAcl.js';

/** CCI-10: a deadline counted from the loader's start (startMono on the clock's base); extendTo raises it once, to at most 7,000 ms (CCI-17). */
export class Deadline {
  /** P5-EC-3: the constructor clock, on which every wait of a session runs. */
  readonly clock: Clock;
  private readonly start: number;
  private end: number;
  private extended = false;

  constructor(clock: Clock, startMono: number, ms: number) {
    this.clock = clock;
    this.start = startMono;
    this.end = startMono + ms;
  }

  remainingMs(): number {
    return Math.max(0, this.end - this.clock.monoMs());
  }

  expired(): boolean {
    return this.remainingMs() <= 0;
  }

  /** Once per deadline, ms an integer in [1, C.SUSPECT_DEADLINE_MAX_MS]: the deadline becomes start + ms (never lowered); false otherwise. */
  extendTo(ms: number): boolean {
    if (this.extended || !Number.isSafeInteger(ms) || ms < 1 || ms > C.SUSPECT_DEADLINE_MAX_MS) return false;
    this.extended = true;
    this.end = Math.max(this.end, this.start + ms);
    return true;
  }
}

/** A4-5: the one FrameCodec binding (A3-3) — NDJSON lines ≤ 1 MiB, the canonical encoder and the session-phase schema. */
export const wireCodec: FrameCodec = {
  reader: () => new LineReader(),
  encode: encodeFrame,
  validate: (dir, v) => validateFrame('session', dir, v),
};

/** socketDir's probe name lives beside socketDir (src/sec/endpoint.ts SOCK_NAME). */

/** Waits on the deadline's clock until `at` (or the deadline): a sleep that ends early is resumed, so attempts keep their 50 ms spacing. */
async function sleepUntil(deadline: Deadline, at: number): Promise<void> {
  for (let left = at - deadline.clock.monoMs(); left > 0 && !deadline.expired(); left = at - deadline.clock.monoMs()) {
    await deadline.clock.sleep(Math.min(left, deadline.remainingMs()));
  }
}

/** A4-5: the verified key (readIpcKey with {stamp: 'use'}, A3-6), the endpoint (env feeds socketDir on POSIX) and a connect + clientHandshake with
 *  wireCodec. A key refusal, a missing key, no data directory (repo.dataDir '' — resolveDataDir answered null) or no socket directory returns null at
 *  once (no connect; the caller maps it to G4, S3); a connect or handshake failure is retried on a 50 ms grid (C.RETRY_SPACING_MS) until the
 *  deadline, then null. P5SEC #35: a full key check (no matching stamp) runs within the deadline's remaining time. P5SEC #36: each failed
 *  handshake (not a refused connect) is reported through d.onHandshakeFail with its reason — the caller's record of SEC-22's client side. */
export async function openSession(repo: LiveRepo, d: {
  fs: Fs; ipc: Ipc; random: Random; platform: NodeJS.Platform; uid: number | null; acl: WinAcl; env: Readonly<Record<string, string | undefined>>;
  onHandshakeFail?: (why: HandshakeFailure) => void;
}, deadline: Deadline): Promise<SecureConn | null> {
  if (repo.dataDir === '') return null;
  const k = await readIpcKey(repo.dataDir, { fs: d.fs, random: d.random, platform: d.platform, uid: d.uid, acl: d.acl },
    { stamp: 'use', remainingMs: () => deadline.remainingMs() });
  if (!k.ok) return null;
  let dir: string | null = null;
  if (d.platform !== 'win32') {
    if (d.uid === null) return null;
    const s = await socketDir(d.env, d.uid, d.fs, SOCK_NAME);
    if (!s.ok) return null;
    dir = s.dir;
  }
  const endpoint = endpointName(k.key, repo.endpointRoot, d.platform, dir);
  const start = deadline.clock.monoMs();
  for (let attempt = 1; !deadline.expired(); attempt++) {
    try {
      const conn = await d.ipc.connect(endpoint, deadline.remainingMs());
      return await clientHandshake(conn, k.key, endpoint, d.random, deadline.remainingMs(), wireCodec,
        d.onHandshakeFail === undefined ? { clock: deadline.clock } : { clock: deadline.clock, onFail: d.onHandshakeFail });
    } catch {
      // refused, no endpoint yet, or a failed handshake: the next attempt on the grid
    }
    await sleepUntil(deadline, start + attempt * C.RETRY_SPACING_MS);
  }
  return null;
}

/** How long one wait for a frame sleeps on the deadline's clock before it checks the deadline again (an arrived frame ends the wait at once). */
const POLL_MS = 50;

/** Sends f and resolves with the first reply-kind frame (any server frame but extend and ring); an extend frame calls deadline.extendTo and keeps
 *  waiting; 'timeout' at expiry and, at once, when the connection closes (a schema failure closes it, A1-11). Takes over conn's frame callback. */
export function request(conn: SecureConn, f: SessionClientFrame, deadline: Deadline): Promise<SessionServerFrame | 'timeout'> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: SessionServerFrame | 'timeout'): void => {
      if (done) return;
      done = true;
      resolve(v);
    };
    conn.onFrame((g) => {
      const s = g as SessionServerFrame;
      if (s.t === 'extend') deadline.extendTo(s.deadline_ms);
      else if (s.t !== 'ring') finish(s);
    });
    conn.onClose(() => finish('timeout'));
    conn.send(f);
    void (async () => {
      while (!done && !deadline.expired()) await deadline.clock.sleep(Math.min(deadline.remainingMs(), POLL_MS));
      finish('timeout');
    })();
  });
}
