// Responses Node writes before the request handler runs (R-V48, S4): clientError, the request timeouts and Expect handling still
// carry the whole 12 §3.10.4 header set and never echo the raw packet. Real timers (the 5 s headersTimeout).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { REAP_MS } from '../../../src/viz/server/http.js';
import type { World } from '../../../src/viz/server/viewModel.js';
import {
  assertSecurityHeaders, openStream, rawRequest, RecordingLog, startTestServer, stubApi, type OpenStream, type RawResponse, type TestServer,
} from '../../helpers/vizHttp.js';
import { VirtualClock } from '../../sim/vclock.js';

const servers: TestServer[] = [];
after(async () => { for (const s of servers) await s.close(); });

const MARK = 'RAWPACKETMARKER';
const echoes = (r: RawResponse): boolean => `${r.headers.map(([k, v]) => `${k}: ${v}`).join('\n')}\n${r.body.toString('latin1')}`.includes(MARK);
const header = (r: RawResponse, name: string): string | undefined => r.headers.find(([k]) => k.toLowerCase() === name)?.[1];

test('T-VIZ-admission: responses Node writes itself carry the header set (real timers)', async () => {
  const rec = new RecordingLog();
  const s = await startTestServer({ log: rec });
  servers.push(s);
  const p = s.port;
  const H = `Host: ${s.host}\r\n`;

  // 9 KiB of headers: Node's parser stops at 8 KiB (HPE_HEADER_OVERFLOW) → 431 with the set and Connection: close.
  const big = await rawRequest(p, `GET / HTTP/1.1\r\n${H}X-Big: ${MARK}${'a'.repeat(9 * 1024)}\r\n\r\n`);
  assert.equal(big.status, 431);
  assertSecurityHeaders(big.headers, '431');
  assert.equal(header(big, 'connection'), 'close');
  assert.ok(!echoes(big));

  // Headers stalled mid-line: the 5 s headersTimeout, checked every 1 s → 408 with the set within 7 s.
  const t0 = performance.now();
  const stalled = await rawRequest(p, `GET / HTTP/1.1\r\n${H}X-Stall: ${MARK}`);
  const waited = performance.now() - t0;
  assert.equal(stalled.status, 408);
  assert.ok(waited >= 4_000 && waited < 7_000, `408 after ${Math.round(waited)} ms`);
  assertSecurityHeaders(stalled.headers, '408');
  assert.equal(header(stalled, 'connection'), 'close');
  assert.ok(!echoes(stalled));

  // A malformed request line → 400 with the set.
  for (const bytes of [`GARBAGE ${MARK}\r\n\r\n`, `GET / HTTP/9.9\r\n${H}X: ${MARK}\r\n\r\n`, `GET / HTTP/1.1\r\n${H}Content-Length: ${MARK}\r\n\r\n`,
    `GET / HTTP/1.1\r\n${H}Bad Header: ${MARK}\r\n\r\n`]) {
    const r = await rawRequest(p, bytes);
    assert.equal(r.status, 400, JSON.stringify(bytes.slice(0, 30)));
    assertSecurityHeaders(r.headers, '400');
    assert.equal(header(r, 'connection'), 'close');
    assert.ok(!echoes(r));
  }

  // Expect: 100-continue runs the normal admission first: a bad Host → 421 and no 100 Continue.
  const cont = await rawRequest(p, `POST /api/v1/session HTTP/1.1\r\nHost: evil.test:${p}\r\nOrigin: ${s.origin}\r\nExpect: 100-continue\r\nContent-Length: 4\r\n\r\n`);
  assert.equal(cont.status, 421, 'the first response is the 421, not a 100');
  assertSecurityHeaders(cont.headers, '421 on Expect');
  const contNoHost = await rawRequest(p, `GET / HTTP/1.1\r\nExpect: 100-continue\r\n\r\n`);
  assert.equal(contNoHost.status, 421);
  // An admitted request with Expect: 100-continue gets its 100 first.
  const contOk = await rawRequest(p, `POST /api/v1/session HTTP/1.1\r\n${H}Origin: ${s.origin}\r\nExpect: 100-continue\r\nContent-Length: 4\r\n\r\n`);
  assert.equal(contOk.status, 100);
  assert.equal(s.tokens.redeemed(), false);
  // Another expectation → 417 with the set (after admission: a bad Host still answers 421).
  const weird = await rawRequest(p, `GET / HTTP/1.1\r\n${H}Expect: weird-${MARK}\r\nConnection: close\r\n\r\n`);
  assert.equal(weird.status, 417);
  assertSecurityHeaders(weird.headers, '417');
  assert.ok(!echoes(weird));
  const weirdHost = await rawRequest(p, `GET / HTTP/1.1\r\nHost: evil.test:${p}\r\nExpect: weird\r\nConnection: close\r\n\r\n`);
  assert.equal(weirdHost.status, 421);

  // One each: the 431, the 408 and the four 400s (the 417 and the 421s are not limits).
  assert.equal(rec.count('SEC_VIZ_LIMIT'), 6);
  assert.equal(rec.count('SEC_VIZ_BAD_HOST'), 3);
  // The server is still serving after all of it.
  const ok = await rawRequest(p, `GET / HTTP/1.1\r\n${H}Connection: close\r\n\r\n`);
  assert.equal(ok.status, 200);
});

/** A client that never closes its side (allowHalfOpen): sends `bytes` (or nothing) and reports the status of the first response and
 *  the server's FIN; the test destroys it at the end. */
interface HalfOpen { sock: net.Socket; status: Promise<number>; ended: Promise<void>; }
function halfOpen(port: number, bytes: string | null): Promise<HalfOpen> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port, allowHalfOpen: true });
    let head = '';
    let statusOk: (n: number) => void = () => {};
    let endedOk: () => void = () => {};
    const status = new Promise<number>((r) => { statusOk = r; });
    const ended = new Promise<void>((r) => { endedOk = r; });
    sock.on('data', (d: Buffer) => {
      head += d.toString('latin1');
      const m = /^HTTP\/1\.1 (\d{3}) /.exec(head);
      if (m !== null) statusOk(Number(m[1]));
    });
    sock.on('end', () => { statusOk(0); endedOk(); });
    sock.on('close', () => { statusOk(0); endedOk(); });
    sock.on('error', () => {});
    sock.once('connect', () => {
      if (bytes !== null) sock.write(bytes);
      resolve({ sock, status, ended });
    });
    sock.once('error', reject);
  });
}

/** Polls a normal request until it is answered 200 or `ms` pass; returns the ms it took, or null. */
async function answeredWithin(port: number, host: string, ms: number): Promise<number | null> {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    const r = await rawRequest(port, `GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`).catch(() => null);
    if (r?.status === 200) return performance.now() - t0;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

test('T-VIZ-admission: after a raw 400, 431 or 408 the socket is drained and reaped by the Clock, so 32 half-open clients that never close cannot hold the 32 connection slots; idle preconnects are not counted (real timers)', async () => {
  const variants: Array<[string, string | null, number, number]> = [
    ['400 (malformed request line)', `GARBAGE ${MARK}\r\n\r\n`, 400, 32],
    ['431 (9 KiB of headers)', null, 431, 32],
    ['408 (idle 5 s, nothing sent: a preconnect)', '', 408, 0],
  ];
  const results = await Promise.allSettled(variants.map(async ([what, bytes0, status, limits]) => {
    const rec = new RecordingLog();
    const clock = new VirtualClock();
    const s = await startTestServer({ log: rec, clock });
    servers.push(s);
    const bytes = bytes0 ?? `GET / HTTP/1.1\r\nHost: ${s.host}\r\nX-Big: ${MARK}${'a'.repeat(9 * 1024)}\r\n\r\n`;
    const clients: HalfOpen[] = [];
    try {
      for (let i = 0; i < 32; i++) clients.push(await halfOpen(s.port, bytes === '' ? null : bytes));
      assert.deepEqual([...new Set(await Promise.all(clients.map((c) => c.status)))], [status], `${what}: every client gets ${status}`);
      await Promise.all(clients.map((c) => c.ended));
      // The clients never close their side; until the reap every slot stays taken.
      const before = await rawRequest(s.port, `GET / HTTP/1.1\r\nHost: ${s.host}\r\nConnection: close\r\n\r\n`);
      assert.equal(before.status, 0, `${what}: the 32 half-open sockets hold every slot before the reap`);
      // The reap waits for the injected clock, not for real time: well past REAP_MS of real time, with the clock untouched, every
      // slot is still taken (a reap on a real timer would have freed them by now).
      await new Promise((resolve) => setTimeout(resolve, REAP_MS + 500));
      const still = await rawRequest(s.port, `GET / HTTP/1.1\r\nHost: ${s.host}\r\nConnection: close\r\n\r\n`);
      assert.equal(still.status, 0, `${what}: no reap before the injected clock reached REAP_MS`);
      // The reap is due REAP_MS after the answer by the injected clock; its unref'd wake-up runs within 1 s of real time.
      clock.advance(REAP_MS);
      const took = await answeredWithin(s.port, s.host, 1_000 + 2_000);
      assert.ok(took !== null, `${what}: a normal request is answered within 2 s of the reap`);
      assert.equal(rec.count('SEC_VIZ_LIMIT'), limits, `${what}: SEC_VIZ_LIMIT ${limits}`);
    } finally {
      for (const c of clients) c.sock.destroy();
    }
  }));
  assert.deepEqual(results.map((r) => (r.status === 'fulfilled' ? 'ok' : (r.reason as Error).message.split('\n')[0])), ['ok', 'ok', 'ok']);
});

test('T-VIZ-admission: a session body that stalls past requestTimeout gets 408 with the header set and Connection: close, counted SEC_VIZ_LIMIT; nothing is redeemed and the slot is freed (real timers)', async () => {
  // The answer: a fresh launch token on the stalled POST, which is never redeemed.
  const answer = async (): Promise<void> => {
    const rec = new RecordingLog();
    const s = await startTestServer({ log: rec });
    servers.push(s);
    const t0 = performance.now();
    const r = await rawRequest(s.port, `POST /api/v1/session HTTP/1.1\r\nHost: ${s.host}\r\nOrigin: ${s.origin}\r\nX-Cowork-Launch: ${s.tokens.launch}\r\nContent-Length: 10\r\n\r\nab${MARK.slice(0, 1)}`);
    const waited = performance.now() - t0;
    assert.equal(r.status, 408);
    assert.ok(waited >= 9_000 && waited < 12_500, `408 after ${Math.round(waited)} ms (requestTimeout 10 s, checked every 1 s)`);
    assertSecurityHeaders(r.headers, '408 on a stalled body');
    assert.equal(header(r, 'connection'), 'close');
    assert.ok(!echoes(r));
    assert.equal(rec.count('SEC_VIZ_LIMIT'), 1);
    assert.equal(s.tokens.redeemed(), false, 'nothing is redeemed');
  };
  // The slot: 31 open streams and the stalled POST hold all 32 connections. The POST's client never closes its side, so only the
  // server can free that slot after the 408 (Node's Connection: close handling, or the reap on the injected clock); then one more
  // connection must be answered.
  const slot = async (): Promise<void> => {
    const rec = new RecordingLog();
    const clock = new VirtualClock();
    const s = await startTestServer({ log: rec, clock });
    servers.push(s);
    const session = await s.session();
    const held: OpenStream[] = [];
    let post: HalfOpen | null = null;
    try {
      for (let i = 0; i < 31; i++) held.push(await openStream(s.port, { 'x-cowork-session': session, 'last-event-id': '0' }));
      post = await halfOpen(s.port, `POST /api/v1/session HTTP/1.1\r\nHost: ${s.host}\r\nOrigin: ${s.origin}\r\nContent-Length: 10\r\n\r\nab${MARK.slice(0, 1)}`);
      const refused = await rawRequest(s.port, `GET / HTTP/1.1\r\nHost: ${s.host}\r\nConnection: close\r\n\r\n`);
      assert.equal(refused.status, 0, 'the 31 streams and the stalled POST hold every slot');
      assert.equal(await post.status, 408, 'the stalled POST is answered 408');
      clock.advance(REAP_MS);
      const took = await answeredWithin(s.port, s.host, 1_000 + 2_000);
      assert.ok(took !== null, 'one more connection is answered: the stalled POST\'s slot was freed');
      assert.equal(s.hub.open(), 31, 'the streams keep theirs');
      assert.equal(rec.count('SEC_VIZ_LIMIT'), 1);
    } finally {
      post?.sock.destroy();
      for (const h of held) h.close();
    }
  };
  const results = await Promise.allSettled([answer(), slot()]);
  assert.deepEqual(results.map((r) => (r.status === 'fulfilled' ? 'ok' : (r.reason as Error).message.split('\n')[0])), ['ok', 'ok']);
});

test('T-VIZ-admission: a request timeout is answered 408 only through a session POST waiting for its body, never through another response still in progress (real timers)', async () => {
  // Request 1 is a GET /api/v1/world whose answer the test holds back (its headers are not sent); request 2, pipelined behind it on the
  // same connection, stalls mid-header until the 5 s headersTimeout fires on that connection.
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let worldAsked = 0;
  const rec = new RecordingLog();
  const s = await startTestServer({
    log: rec,
    api: (hub) => stubApi(hub, {
      world: async (): Promise<World> => {
        worldAsked++;
        await gate;
        return { v: 1, cursor: hub.seq(), demo: false, rooms: [], captions: [] };
      },
    }),
  });
  servers.push(s);
  const session = await s.session();
  try {
    const r = await rawRequest(s.port, `GET /api/v1/world HTTP/1.1\r\nHost: ${s.host}\r\nX-Cowork-Session: ${session}\r\n\r\n`
      + `GET / HTTP/1.1\r\nHost: ${s.host}\r\nX-Stall: ${MARK}`);
    assert.equal(worldAsked, 1, 'request 1 was in progress');
    assert.notEqual(r.status, 408, 'no 408 is written into the world response');
    assert.equal(r.status, 0, 'the connection is closed without an answer');
    assert.ok(!echoes(r));
  } finally {
    release();
  }
  // The held-back answer then meets a closed connection: nothing is thrown or logged as an internal error, and the server serves on.
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(rec.errors, []);
  const ok = await rawRequest(s.port, `GET / HTTP/1.1\r\nHost: ${s.host}\r\nConnection: close\r\n\r\n`);
  assert.equal(ok.status, 200);
});
