// Plan 5 Task 3: the mutual HMAC handshake and the session framing (SEC-22, R2-K3, R5-45, OQ-15 (r2), INV-IPC, O-IPC input, SEC-23 channel
// half), the handshake failure rate (SEC-22, glossary §20) and the src/sec IPC numbers (parity with C).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto, { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import fc from 'fast-check';
import ts from 'typescript';
import { C } from '../../src/claude/wire/constants.js';
import { encodeFrame, LineReader } from '../../src/claude/wire/ndjson.js';
import { registeredKinds, validateFrame } from '../../src/claude/wire/schema.js';
import type { IpcConn } from '../../src/ports/ipc.js';
import { recordingNotifier } from '../../src/ports/notifier.js';
import { seededRandom, type Random } from '../../src/ports/random.js';
import type { TraceEvent } from '../../src/ports/trace.js';
import { SOCKET_PATH_MAX_BYTES } from '../../src/sec/endpoint.js';
import { clientHandshake, HandshakeFailed, MAX_FRAME_BYTES, NONCE_BYTES, serverHandshake, type FrameCodec, type SecureConn } from '../../src/sec/handshake.js';
import { KEY_BYTES } from '../../src/sec/ipcKey.js';
import { FAIL_NOTIFY_AT, FAIL_WINDOW_MS, HandshakeFailureRate, NOTIFY_SPACING_MS, type SecParams, type SecurityLog } from '../../src/sec/securityLog.js';
import { VirtualClock } from '../sim/vclock.js';
import { GatedClock } from '../helpers/gatedClock.js';
import { captureConn, memoryPair, type CapturedConn } from '../helpers/ipcCapture.js';

/** Task 4's openSession and Task 5's ClaudeServer bind exactly this codec (A3-3). */
const codec: FrameCodec = { reader: () => new LineReader(), encode: encodeFrame, validate: (d, v) => validateFrame('session', d, v) };

// Ruling P5-T3-1: the handshake deadline is a sleep on the injected Clock, so every test here runs on the shared GatedClock (its sleep waits
// for the harness to advance): the 3,000 ms deadline is then observed exactly and a success-path handshake never races it. The stock
// VirtualClock fails every handshake — pinned by "the handshake deadline needs a gated clock" below.

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

const KEY = Buffer.alloc(32, 9);
const EP = '\\\\.\\pipe\\cowork-test';
const mac = (key: Buffer, label: string, a: Buffer, b: Buffer, ep: string): Buffer =>
  createHmac('sha256', key).update(Buffer.from(label, 'utf8')).update(a).update(b).update(Buffer.from(ep, 'utf8')).digest();
const line = (o: unknown): Buffer => Buffer.from(`${JSON.stringify(o)}\n`, 'utf8');
const b64 = (n: number, fill = 1): string => Buffer.alloc(n, fill).toString('base64');

const HOOK = {
  t: 'hook', event: 'Stop',
  h: { seat_key: 'a'.repeat(64), claude_pid: 4242, session_id: 's-1', prompt_id: null, agent_id: null, agent_type: null, permission_mode: 'default',
    repo_root: '/r', plugin_version: '0.1.0', hook_proto: 1 },
  payload: { event: 'Stop', stop_hook_active: false, background_tasks_running: 0, ids_in_last_message: null },
};
const REPLY = { t: 'reply', batch_id: 'b-1', decision: 'none', text: '', system: null, events: [], cursor: 0 };

interface Server {
  promise: Promise<SecureConn>;
  fails: string[];
  events: Array<[string, number]>;
  cap: CapturedConn;
}

function startServer(raw: IpcConn, clock: GatedClock, random: Random = seededRandom('srv'), key = KEY): Server {
  const fails: string[] = [];
  const events: Array<[string, number]> = [];
  const cap = captureConn(raw);
  const promise = serverHandshake(cap, key, EP, random, (why) => fails.push(why), codec, {
    clock, timeoutMs: 3_000, onEvent: (op, n) => events.push([op, n]),
  });
  promise.catch(() => {});
  return { promise, fails, events, cap };
}

/** A completed handshake over a fresh in-memory pair. */
async function authed(o?: { chunk?: number; random?: Random }): Promise<{ client: SecureConn; server: SecureConn; c: IpcConn; s: Server;
  ccap: CapturedConn; clock: GatedClock }> {
  const clock = new GatedClock();
  const [c, sRaw] = memoryPair(o?.chunk === undefined ? undefined : { chunk: o.chunk });
  const s = startServer(sRaw, clock, o?.random ?? seededRandom('srv'));
  const ccap = captureConn(c);
  const client = await clientHandshake(ccap, KEY, EP, o?.random ?? seededRandom('cli'), 3_000, codec, { clock });
  const server = await s.promise;
  return { client, server, c, s, ccap, clock };
}

function closed(conn: { onClose(cb: () => void): void }): { fired: () => boolean } {
  let fired = false;
  conn.onClose(() => { fired = true; });
  return { fired: () => fired };
}

test('an unauthenticated client receives 0 bytes and a client sends 0 session bytes to an unauthenticated server', async () => {
  // (1) A client that connects and sends nothing: the server writes 0 bytes; at 3,000 ms it closes with onFail('timeout').
  {
    const clock = new GatedClock();
    const [c, sRaw] = memoryPair();
    const cClosed = closed(c);
    const s = startServer(sRaw, clock);
    await settle();
    clock.advance(2_999);
    await settle();
    assert.deepEqual(s.fails, []);
    assert.equal(cClosed.fired(), false);
    clock.advance(1);
    await settle();
    assert.deepEqual(s.fails, ['timeout']);
    await assert.rejects(s.promise, (e: unknown) => e instanceof HandshakeFailed && e.code === 'SEC_IPC_HANDSHAKE_FAILED');
    assert.equal(s.cap.out().length, 0, 'the server wrote 0 bytes');
    assert.equal(cClosed.fired(), true);
    assert.deepEqual(s.events, [['accept', 0], ['auth_fail', 0], ['close', 0]]);
  }
  // (2) hello, then a cli with a wrong MAC: exactly one srv line, then a close at once with onFail('mac') and auth_fail with 0 session bytes.
  {
    const clock = new GatedClock();
    const [c, sRaw] = memoryPair();
    const cClosed = closed(c);
    const s = startServer(sRaw, clock);
    const got: Buffer[] = [];
    c.onData((b) => got.push(b));
    c.write(line({ t: 'hello', v: 1, n1: b64(16) }));
    await settle();
    assert.equal(s.cap.outLines().length, 1);
    assert.equal((JSON.parse(s.cap.outLines()[0] as string) as { t: string }).t, 'srv');
    c.write(line({ t: 'cli', p: b64(32, 7) }));
    await settle();
    assert.deepEqual(s.fails, ['mac']);
    assert.equal(cClosed.fired(), true, 'closed at once, without waiting for the deadline');
    assert.deepEqual(s.events, [['accept', 0], ['auth_fail', 0], ['close', 0]]);
    assert.equal(s.cap.outLines().length, 1, 'nothing after the srv line');
    assert.equal(s.cap.sessionBytes(), 0);
    assert.deepEqual(Buffer.concat(got), s.cap.out());
    await assert.rejects(s.promise, HandshakeFailed);
  }
  // (3) A fake server answering hello with a srv whose p is wrong: clientHandshake rejects and the client wrote only its hello line.
  {
    const clock = new GatedClock();
    const [c, sRaw] = memoryPair();
    const ccap = captureConn(c);
    const p = clientHandshake(ccap, KEY, EP, seededRandom('cli'), 3_000, codec, { clock });
    const reader = new LineReader();
    sRaw.onData((b) => {
      for (const l of reader.push(b)) {
        const hello = JSON.parse(l) as { n1: string };
        const n2 = Buffer.alloc(16, 2);
        const wrong = mac(Buffer.alloc(32, 1), 'srv', Buffer.from(hello.n1, 'base64'), n2, EP);   // another key
        sRaw.write(line({ t: 'srv', n2: n2.toString('base64'), p: wrong.toString('base64') }));
      }
    });
    await assert.rejects(p, (e: unknown) => e instanceof HandshakeFailed && e.code === 'SEC_IPC_HANDSHAKE_FAILED' && e.message === 'SEC_IPC_HANDSHAKE_FAILED');
    await settle();
    const out = ccap.outLines();
    assert.equal(out.length, 1);
    assert.deepEqual(Object.keys(JSON.parse(out[0] as string) as object).sort(), ['n1', 't', 'v']);
    assert.equal(ccap.sessionBytes(), 0, 'no cli, no session frame');
  }
});

test("every failed handshake is reported on both sides: a close after srv is the server's 'closed', the client names why it failed (P5SEC #36, SEC-22)", async () => {
  // Server: hello, srv, then the peer closes without cli — it has collected a proof and never authenticated: onFail('closed'), auth_fail.
  {
    const clock = new GatedClock();
    const [c, sRaw] = memoryPair();
    const s = startServer(sRaw, clock);
    c.write(line({ t: 'hello', v: 1, n1: b64(16) }));
    await settle();
    assert.equal(s.cap.outLines().length, 1, 'the srv line');
    c.destroy();
    await settle();
    assert.deepEqual(s.fails, ['closed']);
    assert.deepEqual(s.events, [['accept', 0], ['auth_fail', 0], ['close', 0]]);
    await assert.rejects(s.promise, HandshakeFailed);
    clock.advance(3_000);
    await settle();
    assert.deepEqual(s.fails, ['closed'], 'counted once: the deadline after it adds nothing');
  }
  // Server: a peer that closes before hello received nothing and proved nothing: no failure (no proof was ever sent to it).
  {
    const clock = new GatedClock();
    const [c, sRaw] = memoryPair();
    const s = startServer(sRaw, clock);
    c.destroy();
    await settle();
    assert.deepEqual(s.fails, []);
    await assert.rejects(s.promise, HandshakeFailed);
    assert.deepEqual(s.events, [['accept', 0], ['close', 0]]);
  }
  // Client: o.onFail names each failure once — a wrong proof 'mac', a malformed srv 'shape', a close before srv 'closed', no srv in time 'timeout'.
  const clientFails = async (serve: (sRaw: IpcConn) => void, clock = new GatedClock(), after?: () => void): Promise<string[]> => {
    const [c, sRaw] = memoryPair();
    const whys: string[] = [];
    const p = clientHandshake(c, KEY, EP, seededRandom('cli'), 3_000, codec, { clock, onFail: (why) => whys.push(why) });
    p.catch(() => {});
    serve(sRaw);
    await settle();
    after?.();
    await settle();
    await assert.rejects(p, HandshakeFailed);
    return whys;
  };
  const onHello = (sRaw: IpcConn, answer: (n1: Buffer) => Buffer | null): void => {
    const reader = new LineReader();
    sRaw.onData((b) => {
      for (const l of reader.push(b)) {
        const out = answer(Buffer.from((JSON.parse(l) as { n1: string }).n1, 'base64'));
        if (out === null) sRaw.destroy();
        else sRaw.write(out);
      }
    });
  };
  const n2 = Buffer.alloc(16, 2);
  assert.deepEqual(await clientFails((s) => onHello(s, (n1) => line({ t: 'srv', n2: n2.toString('base64'), p: mac(Buffer.alloc(32, 1), 'srv', n1, n2, EP).toString('base64') }))), ['mac']);
  assert.deepEqual(await clientFails((s) => onHello(s, () => line({ t: 'srv', n2: b64(16), p: b64(33) }))), ['shape']);
  assert.deepEqual(await clientFails((s) => onHello(s, () => null)), ['closed']);
  const clock = new GatedClock();
  assert.deepEqual(await clientFails(() => {}, clock, () => clock.advance(3_000)), ['timeout']);
  // A client that authenticates reports nothing, and its later close is no handshake failure.
  {
    const clock2 = new GatedClock();
    const [c, sRaw] = memoryPair();
    const s = startServer(sRaw, clock2);
    const whys: string[] = [];
    const client = await clientHandshake(c, KEY, EP, seededRandom('cli'), 3_000, codec, { clock: clock2, onFail: (why) => whys.push(why) });
    await s.promise;
    client.close();
    await settle();
    clock2.advance(3_000);
    await settle();
    assert.deepEqual(whys, []);
    assert.deepEqual(s.fails, []);
  }
});

test('a matching handshake yields SecureConns that exchange schema-valid frames both ways', async (t) => {
  const spy = mock.method(crypto, 'timingSafeEqual');
  syncBuiltinESMExports();
  t.after(() => {
    spy.mock.restore();
    syncBuiltinESMExports();
  });
  const random = seededRandom('h');
  const clock = new GatedClock();
  const [c, sRaw] = memoryPair();
  const s = startServer(sRaw, clock, random);
  const ccap = captureConn(c);
  const client = await clientHandshake(ccap, KEY, EP, random, 3_000, codec, { clock });
  const server = await s.promise;

  // The proofs: srv.p = HMAC(key, "srv" ‖ n1 ‖ n2 ‖ endpoint), cli.p = HMAC(key, "cli" ‖ n2 ‖ n1 ‖ endpoint) (raw nonces, UTF-8 endpoint).
  const expect = seededRandom('h');
  const n1 = Buffer.from(expect.bytes(16));
  const n2 = Buffer.from(expect.bytes(16));
  const [hello, cli] = ccap.outLines().map((l) => JSON.parse(l) as Record<string, unknown>);
  const [srv] = s.cap.outLines().map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.deepEqual(hello, { t: 'hello', v: 1, n1: n1.toString('base64') });
  assert.deepEqual(srv, { t: 'srv', n2: n2.toString('base64'), p: mac(KEY, 'srv', n1, n2, EP).toString('base64') });
  assert.deepEqual(cli, { t: 'cli', p: mac(KEY, 'cli', n2, n1, EP).toString('base64') });
  // The fixed shapes handshake.ts writes are the wire schema's handshake phase (schema.ts registers exactly these three kinds, R5-45).
  assert.deepEqual(registeredKinds().filter((k) => k.phase === 'handshake').map((k) => `${k.dir} ${k.t}`).sort(), ['c2s cli', 'c2s hello', 's2c srv']);
  assert.notEqual(validateFrame('handshake', 'c2s', hello), null);
  assert.notEqual(validateFrame('handshake', 'c2s', cli), null);
  assert.notEqual(validateFrame('handshake', 's2c', srv), null);
  // onEvent's ops are the O-IPC trace event's (Task 5 maps one onto the other).
  type IpcTraceOp = Extract<TraceEvent, { kind: 'ipc' }>['op'];
  type OnEventOp = Parameters<NonNullable<Parameters<typeof serverHandshake>[6]['onEvent']>>[0];
  const sameOps: Equal<IpcTraceOp, OnEventOp> = true;
  assert.equal(sameOps, true);
  assert.equal(spy.mock.callCount(), 2, 'each side compared its proof with timingSafeEqual');
  for (const call of spy.mock.calls) assert.equal((call.arguments[0] as Buffer).length, 32);

  // A hook frame client → server and a reply frame server → client arrive intact.
  const atServer: object[] = [];
  const atClient: object[] = [];
  server.onFrame((f) => atServer.push(f));
  client.onFrame((f) => atClient.push(f));
  client.send(HOOK);
  server.send(REPLY);
  await settle();
  assert.deepEqual(atServer, [HOOK]);
  assert.deepEqual(atClient, [REPLY]);
  assert.deepEqual(s.events, [['accept', 0], ['auth_ok', 0]]);

  // A MAC of the wrong length is rejected before any comparison: a 31-byte cli proof (server), a 33-byte srv proof (client).
  const before = spy.mock.callCount();
  {
    const [c2, s2Raw] = memoryPair();
    const s2 = startServer(s2Raw, new GatedClock());
    c2.write(line({ t: 'hello', v: 1, n1: b64(16) }));
    await settle();
    c2.write(line({ t: 'cli', p: b64(31) }));
    await settle();
    assert.deepEqual(s2.fails, ['shape']);
  }
  {
    const [c3, s3Raw] = memoryPair();
    const p = clientHandshake(c3, KEY, EP, seededRandom('x'), 3_000, codec, { clock: new GatedClock() });
    s3Raw.onData(() => s3Raw.write(line({ t: 'srv', n2: b64(16), p: b64(33) })));
    await assert.rejects(p, HandshakeFailed);
  }
  assert.equal(spy.mock.callCount(), before);
});

test('a wrong MAC closes at once with SEC_IPC_HANDSHAKE_FAILED; 5 failures in 60 s give one NT_SECURITY notification, the 6th within 30 min none', async () => {
  const clock = new GatedClock();
  const notifier = recordingNotifier();
  const events: Array<{ code: string; params: SecParams }> = [];
  const security: SecurityLog = { event: (code, params) => { events.push({ code, params }); }, flush: async () => undefined };
  const rate = new HandshakeFailureRate(clock, notifier, security);

  /** One client with a wrong key: it refuses the server's proof and closes (before any deadline); the server's onFail feeds `onFail`. */
  const wrongMac = async (onFail: (why: string) => void): Promise<void> => {
    const [c, sRaw] = memoryPair();
    const cClosed = closed(c);
    const p = serverHandshake(sRaw, KEY, EP, seededRandom('s'), onFail, codec, { clock, timeoutMs: 3_000 });
    p.catch(() => {});
    const bad = clientHandshake(c, Buffer.alloc(32, 1), EP, seededRandom('c'), 3_000, codec, { clock });
    await assert.rejects(bad, HandshakeFailed);   // the client rejects the server's proof (other key) and closes; no cli is sent
    await assert.rejects(p, HandshakeFailed);
    assert.equal(cClosed.fired(), true);
  };
  /** The server's side of a wrong MAC: hello, then a cli computed with another key. */
  const wrongCli = async (): Promise<void> => {
    const [c, sRaw] = memoryPair();
    const p = serverHandshake(sRaw, KEY, EP, seededRandom('s'), (why) => rate.fail(why), codec, { clock, timeoutMs: 3_000 });
    p.catch(() => {});
    const reader = new LineReader();
    const n1 = Buffer.alloc(16, 3);
    c.onData((b) => {
      for (const l of reader.push(b)) {
        const srv = JSON.parse(l) as { n2: string };
        c.write(line({ t: 'cli', p: mac(Buffer.alloc(32, 1), 'cli', Buffer.from(srv.n2, 'base64'), n1, EP).toString('base64') }));
      }
    });
    c.write(line({ t: 'hello', v: 1, n1: n1.toString('base64') }));
    await assert.rejects(p, HandshakeFailed);
  };

  // A client-side refusal closes the connection after srv, before cli: the server counts it as a failed handshake, 'closed' (P5SEC #36, SEC-22
  // "every failed handshake"). It runs on its own rate here so the five wrong cli proofs below start a fresh window.
  {
    const closedEvents: Array<{ code: string; params: SecParams }> = [];
    const r0 = new HandshakeFailureRate(clock, recordingNotifier(), { event: (code, params) => { closedEvents.push({ code, params }); }, flush: async () => undefined });
    await wrongMac((why) => r0.fail(why));
    assert.deepEqual(closedEvents, [{ code: 'SEC_IPC_HANDSHAKE_FAILED', params: { why: 'closed', count: 1 } }]);
  }
  assert.equal(events.length, 0);
  for (let s = 0; s < 5; s++) {
    if (s > 0) clock.advance(1_000);
    await wrongCli();
    assert.equal(notifier.countOf('NT_SECURITY'), s === 4 ? 1 : 0, `after failure ${s + 1}`);
  }
  assert.equal(events.length, 5);
  assert.ok(events.every((e) => e.code === 'SEC_IPC_HANDSHAKE_FAILED' && e.params['why'] === 'mac'));
  assert.deepEqual(events.map((e) => e.params['count']), [1, 2, 3, 4, 5]);
  assert.deepEqual(notifier.calls[0], { cls: 'NT_SECURITY', code: 'SEC_IPC_HANDSHAKE_FAILED', params: { count: 5 }, key: null });
  clock.advance(1_000);   // t = 5 s
  await wrongCli();
  assert.equal(events.length, 6);
  assert.equal(notifier.countOf('NT_SECURITY'), 1, 'the 6th within 30 min: none');
  clock.advance(31 * 60_000 - 5_000);   // t = 31 min
  for (let i = 0; i < 5; i++) await wrongCli();
  assert.equal(events.length, 11);
  assert.equal(notifier.countOf('NT_SECURITY'), 2, 'a second notification after 30 min');

  // Four failures 20 s apart (never 5 within 60 s) → no notification; nor a long run at that pace.
  const quiet = recordingNotifier();
  const r2 = new HandshakeFailureRate(clock, quiet, security);
  for (let i = 0; i < 24; i++) {
    clock.advance(20_000);
    r2.fail('timeout');
  }
  assert.equal(quiet.countOf('NT_SECURITY'), 0);
});

test('frames over 1 MiB and unknown t close the connection', async () => {
  const cases: Array<[string, Buffer]> = [
    ['a 1,048,577-byte session line', (() => {
      const head = '{"t":"printed","batch_id":"';
      const tail = '"}';
      return Buffer.from(`${head}${'x'.repeat(1_048_577 - head.length - tail.length)}${tail}\n`, 'utf8');
    })()],
    ['an unknown t', line({ t: 'frobnicate' })],
    ['a schema-invalid hook (no h)', line({ t: 'hook', event: 'Stop', payload: HOOK.payload })],
    ['a handshake hello after authentication', line({ t: 'hello', v: 1, n1: b64(16) })],
    ['a line that is not JSON', Buffer.from('{"t":\n')],
  ];
  assert.equal((cases[0]?.[1].length ?? 0) - 1, 1_048_577);
  for (const [what, bytes] of cases) {
    const { server, c } = await authed();
    const got: object[] = [];
    server.onFrame((f) => got.push(f));
    const sClosed = closed(server);
    c.write(bytes);
    await settle();
    assert.equal(sClosed.fired(), true, `${what}: closed`);
    assert.deepEqual(got, [], `${what}: never delivered`);
  }
  // A frame exactly at the cap is delivered.
  {
    const { server, c } = await authed();
    const got: object[] = [];
    server.onFrame((f) => got.push(f));
    const head = '{"batch_id":"';
    const tail = '","t":"printed"}';
    c.write(Buffer.from(`${head}${'y'.repeat(1_048_576 - head.length - tail.length)}${tail}\n`, 'utf8'));
    await settle();
    assert.equal(got.length, 1);
  }
  // A session hook frame sent before cli: the server closes with onFail('shape') and never delivers it.
  {
    const clock = new GatedClock();
    const [c, sRaw] = memoryPair();
    const s = startServer(sRaw, clock);
    c.write(line({ t: 'hello', v: 1, n1: b64(16) }));
    await settle();
    c.write(line(HOOK));
    await settle();
    assert.deepEqual(s.fails, ['shape']);
    await assert.rejects(s.promise, HandshakeFailed);
  }
  // Sending an oversize frame is refused by the sender (a frame never leaves over the cap).
  {
    const { client } = await authed();
    assert.throws(() => client.send({ t: 'printed', batch_id: 'z'.repeat(1_048_576) }), RangeError);
  }
});

test('the handshake survives fragmentation and rejects a v2 hello', async () => {
  // Every handshake and session line delivered one byte per onData callback.
  const { client, server } = await authed({ chunk: 1 });
  const atServer: object[] = [];
  const atClient: object[] = [];
  server.onFrame((f) => atServer.push(f));
  client.onFrame((f) => atClient.push(f));
  client.send(HOOK);
  server.send(REPLY);
  for (let i = 0; i < 40 && (atServer.length === 0 || atClient.length === 0); i++) await settle();
  assert.deepEqual(atServer, [HOOK]);
  assert.deepEqual(atClient, [REPLY]);

  for (const bad of [{ t: 'hello', v: 2, n1: b64(16) }, { t: 'hello', v: 1, n1: b64(15) }, { t: 'hello', v: 1, n1: b64(16), extra: 1 },
    { t: 'hello', v: 1, n1: `${b64(16).slice(0, -2)}A=` }]) {
    const [c, sRaw] = memoryPair({ chunk: 1 });
    const s = startServer(sRaw, new GatedClock());
    c.write(line(bad));
    for (let i = 0; i < 20 && s.fails.length === 0; i++) await settle();
    assert.deepEqual(s.fails, ['shape'], JSON.stringify(bad));
    assert.equal(s.cap.out().length, 0, 'no srv to a bad hello');
  }
});

test('the session channel carries no key, nonce or environment value', async () => {
  const { client, server } = await authed();
  for (const conn of [client, server]) {
    assert.deepEqual(Object.keys(conn).sort(), ['close', 'onClose', 'onFrame', 'send']);
    assert.deepEqual(Object.getOwnPropertyNames(conn).sort(), ['close', 'onClose', 'onFrame', 'send']);
    assert.equal(Object.getPrototypeOf(conn), Object.prototype);
  }
  assert.equal(new HandshakeFailed().message, 'SEC_IPC_HANDSHAKE_FAILED');
  assert.deepEqual(Object.keys(new HandshakeFailed()).filter((k) => k !== 'code'), []);

  // 200 random handshakes: the captured bytes, without the base64 nonces and proofs, hold no key (raw, hex, base64) and no environment value.
  const envValues = Object.values(process.env).filter((v): v is string => typeof v === 'string' && v.length >= 8);
  await fc.assert(fc.asyncProperty(fc.uint8Array({ minLength: 32, maxLength: 32 }), fc.string(), async (keyBytes, seed) => {
    const key = Buffer.from(keyBytes);
    const clock = new GatedClock();
    const [c, sRaw] = memoryPair();
    const scap = captureConn(sRaw);
    const ccap = captureConn(c);
    const sp = serverHandshake(scap, key, EP, seededRandom(`s${seed}`), () => {}, codec, { clock, timeoutMs: 3_000 });
    const client = await clientHandshake(ccap, key, EP, seededRandom(`c${seed}`), 3_000, codec, { clock });
    const server = await sp;
    const got: object[] = [];
    server.onFrame((f) => got.push(f));
    client.onFrame((f) => got.push(f));
    client.send(HOOK);
    server.send(REPLY);
    await settle();
    assert.equal(got.length, 2);
    let stream = Buffer.concat([ccap.out(), scap.out()]).toString('latin1');
    for (const l of [...ccap.outLines(), ...scap.outLines()]) {
      const v = JSON.parse(l) as Record<string, unknown>;
      for (const k of ['n1', 'n2', 'p']) if (typeof v[k] === 'string' && (v['t'] === 'hello' || v['t'] === 'srv' || v['t'] === 'cli')) stream = stream.split(v[k] as string).join('');
    }
    const bytes = Buffer.from(stream, 'latin1');
    assert.equal(bytes.indexOf(key), -1);
    assert.ok(!stream.includes(key.toString('hex')));
    assert.ok(!stream.includes(key.toString('base64')));
    for (const v of envValues) assert.ok(!bytes.includes(Buffer.from(v, 'utf8')), 'an environment value on the wire');
  }), { numRuns: 200 });

  // Source scan: these modules read no process.env (the environment reaches socketDir as a parameter) and load no child_process.
  for (const f of ['src/sec/handshake.ts', 'src/sec/endpoint.ts', 'src/sec/ipcKey.ts', 'src/ports/ipc.ts']) {
    const text = readFileSync(path.join(process.cwd(), ...f.split('/')), 'utf8');
    const code = text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/process\s*\.\s*env|process\s*\[\s*['"]env['"]\s*\]/.test(code), `${f} reads process.env`);
    const imports = ts.preProcessFile(text, true, true).importedFiles.map((i) => i.fileName);
    assert.ok(!imports.some((m) => m === 'child_process' || m === 'node:child_process'), `${f} loads child_process`);
  }
});

test("the handshake deadline needs a gated clock: on a stock VirtualClock every handshake fails 'timeout' (Ruling P5-T3-1)", async () => {
  // The deadline is clock.sleep(timeoutMs). The stock VirtualClock's sleep advances its own time and resolves at once, so the deadline fires
  // before the hello is read: a matching pair fails and the peer clock moves 3 s per side. This pins the requirement on every binding (the
  // seats SIM of R5-16, Tasks 5 and 18): pass a clock whose sleep waits for the harness, as GatedClock does.
  {
    const clock = new VirtualClock();
    const [c, sRaw] = memoryPair();
    const fails: string[] = [];
    const sp = serverHandshake(sRaw, KEY, EP, seededRandom('srv'), (why) => fails.push(why), codec, { clock, timeoutMs: 3_000 });
    const cp = clientHandshake(c, KEY, EP, seededRandom('cli'), 3_000, codec, { clock });
    const [s, cl] = await Promise.allSettled([sp, cp]);
    assert.ok(s.status === 'rejected' && s.reason instanceof HandshakeFailed);
    assert.ok(cl.status === 'rejected' && cl.reason instanceof HandshakeFailed);
    assert.deepEqual(fails, ['timeout']);
    assert.equal(clock.monoMs(), 6_000, 'the stock clock moved 3 s per side');
  }
  // The same pair on the shared GatedClock authenticates and leaves time where it was; the deadline, once reached, changes nothing.
  {
    const clock = new GatedClock();
    const [c, sRaw] = memoryPair();
    const fails: string[] = [];
    const sp = serverHandshake(sRaw, KEY, EP, seededRandom('srv'), (why) => fails.push(why), codec, { clock, timeoutMs: 3_000 });
    const client = await clientHandshake(c, KEY, EP, seededRandom('cli'), 3_000, codec, { clock });
    const server = await sp;
    assert.equal(clock.monoMs(), 0);
    assert.equal(clock.pending(), 2, 'both deadlines wait for the harness');
    const sClosed = closed(server);
    clock.advance(3_000);
    await settle();
    assert.equal(clock.pending(), 0);
    assert.deepEqual(fails, []);
    assert.equal(sClosed.fired(), false, 'a settled handshake ignores its deadline');
    const got: object[] = [];
    server.onFrame((f) => got.push(f));
    client.send(HOOK);
    await settle();
    assert.deepEqual(got, [HOOK]);
  }
});

test('the src/sec IPC numbers equal C', () => {
  assert.equal(NONCE_BYTES, C.HANDSHAKE_NONCE_BYTES);
  assert.equal(NONCE_BYTES, 16);
  assert.equal(KEY_BYTES, C.IPC_KEY_BYTES);
  assert.equal(KEY_BYTES, 32);
  assert.equal(FAIL_NOTIFY_AT, C.HANDSHAKE_FAIL_NOTIFY_AT);
  assert.equal(FAIL_NOTIFY_AT, 5);
  assert.equal(FAIL_WINDOW_MS, C.HANDSHAKE_FAIL_WINDOW_MS);
  assert.equal(FAIL_WINDOW_MS, 60_000);
  assert.equal(NOTIFY_SPACING_MS, C.SECURITY_NOTIFY_SPACING_MS);
  assert.equal(NOTIFY_SPACING_MS, 1_800_000);
  assert.equal(SOCKET_PATH_MAX_BYTES, C.SOCKET_PATH_MAX_BYTES);
  assert.equal(SOCKET_PATH_MAX_BYTES, 100);
  assert.equal(MAX_FRAME_BYTES, C.FRAME_MAX_BYTES);
  assert.equal(MAX_FRAME_BYTES, 1_048_576);
});
