// test/helpers/fakeDaemon.ts — Plan 5 Task 4 (contract §"Test helpers"): an authenticated scripted server on a temp endpoint — the real Ipc port and
// the real server handshake (realClock, P5-EC-3; 3,000 ms like the daemon's) — standing in for the daemon in the loader and core tests (Task 5's
// ClaudeServer is never used here). Every session frame a client sends is recorded with its connection number and the machine-wide monotonic time
// (machineMonoMs, the clock runLoader's exitMono uses); each `hook` frame gets the scripted answer. Timers are unref'd, so a long stall never keeps a
// test process alive.
//   reply(frame)          the reply every later hook frame gets (default {decision: 'none'}; batch_id defaults to b<n>); null = never reply
//   stall(ms)             later hook frames get their reply only after ms
//   extend(deadlineMs, atMs)  an extend{deadline_ms} frame atMs after each later hook frame (call it twice for two)
//   close()               stops listening and ends every connection
//   frames(conn?)         the recorded session frames (of one connection)
//   connections()         accepted connections (whether or not they authenticated)
//   printed()             the batch_ids of the printed frames received
//   replies()             machineMonoMs() at each reply write
//   sent()                every session frame written, with machineMonoMs() at the write
//   bytes()               every byte received and written on every connection (handshake included; test/helpers/ipcCapture.ts)
//   reset()               back to the defaults: reply {decision: 'none'} at once, no extend
import { encodeFrame, LineReader } from '../../src/claude/wire/ndjson.js';
import { validateFrame } from '../../src/claude/wire/schema.js';
import type { ReplyFrame } from '../../src/claude/wire/frames.js';
import { machineMonoMs, realClock } from '../../src/ports/clock.js';
import { realIpc, type IpcConn, type IpcServer } from '../../src/ports/ipc.js';
import { ipcCapture } from './ipcCapture.js';
import { realRandom } from '../../src/ports/random.js';
import { serverHandshake, type FrameCodec, type SecureConn } from '../../src/sec/handshake.js';

const codec: FrameCodec = { reader: () => new LineReader(), encode: encodeFrame, validate: (d, v) => validateFrame('session', d, v) };

export interface RecordedFrame { conn: number; at: number; frame: Record<string, unknown> }

export interface FakeDaemon {
  readonly endpoint: string;
  reply(f: Partial<ReplyFrame> | null): void;
  stall(ms: number): void;
  extend(deadlineMs: number, atMs: number): void;
  close(): Promise<void>;
  frames(conn?: number): RecordedFrame[];
  connections(): number;
  printed(): string[];
  replies(): number[];
  sent(): RecordedFrame[];
  bytes(): Buffer;
  reset(): void;
  handshakeFailures(): string[];
}

const later = (ms: number, f: () => void): void => {
  setTimeout(f, ms).unref();
};

export async function fakeDaemon(endpoint: string, key: Buffer): Promise<FakeDaemon> {
  let answer: Partial<ReplyFrame> | null = { decision: 'none' };
  let stallMs = 0;
  const extends_: Array<{ deadline_ms: number; at: number }> = [];
  const recorded: RecordedFrame[] = [];
  const printed: string[] = [];
  const replyTimes: number[] = [];
  const fails: string[] = [];
  const written: RecordedFrame[] = [];
  const open = new Set<SecureConn>();
  const ipc = ipcCapture(realIpc);
  let accepted = 0;
  let batch = 0;

  const onHook = (sc: SecureConn, conn: number): void => {
    const send = (frame: Record<string, unknown>): void => {
      written.push({ conn, at: machineMonoMs(), frame });
      sc.send(frame);
    };
    for (const e of [...extends_]) later(e.at, () => send({ t: 'extend', deadline_ms: e.deadline_ms }));
    if (answer === null) return;
    const a = answer;
    const reply = (): void => {
      batch += 1;
      replyTimes.push(machineMonoMs());
      send({ t: 'reply', batch_id: `b${batch}`, decision: 'none', text: '', system: null, events: [], cursor: 0, ...a });
    };
    if (stallMs > 0) later(stallMs, reply);
    else reply();
  };

  const server: IpcServer = await ipc.listen(endpoint, (c: IpcConn) => {
    accepted += 1;
    const n = accepted;
    serverHandshake(c, key, endpoint, realRandom, (why) => fails.push(why), codec, { clock: realClock, timeoutMs: 3_000 }).then((sc) => {
      open.add(sc);
      sc.onClose(() => open.delete(sc));
      sc.onFrame((f) => {
        const frame = f as Record<string, unknown>;
        recorded.push({ conn: n, at: machineMonoMs(), frame });
        if (frame['t'] === 'printed') printed.push(String(frame['batch_id']));
        if (frame['t'] === 'hook') onHook(sc, n);
      });
    }, () => {});
  });

  return {
    endpoint,
    reply: (f) => { answer = f; },
    stall: (ms) => { stallMs = ms; },
    extend: (deadlineMs, atMs) => { extends_.push({ deadline_ms: deadlineMs, at: atMs }); },
    close: async () => {
      for (const sc of open) sc.close();
      await server.close();
    },
    frames: (conn) => recorded.filter((r) => conn === undefined || r.conn === conn),
    connections: () => accepted,
    printed: () => [...printed],
    replies: () => [...replyTimes],
    sent: () => [...written],
    bytes: () => Buffer.concat(ipc.accepted.flatMap((c) => [c.in(), c.out()])),
    reset: () => {
      answer = { decision: 'none' };
      stallMs = 0;
      extends_.length = 0;
    },
    handshakeFailures: () => [...fails],
  };
}
