// Request admission (12 §3.10.3; VIZ-30, VIZ-32, INV-VIZ-LOOPBACK, Review Focus 2) over real loopback sockets, exact bytes.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { StreamPayload } from '../../../src/viz/server/viewModel.js';
import {
  assertSecurityHeaders, openStream, pairs, rawRequest, RecordingLog, request, startTestServer, type OpenStream, type RawResponse, type TestServer,
} from '../../helpers/vizHttp.js';

const servers: TestServer[] = [];
after(async () => { for (const s of servers) await s.close(); });

async function server(): Promise<TestServer & { rec: RecordingLog }> {
  const rec = new RecordingLog();
  const s = await startTestServer({ log: rec });
  servers.push(s);
  return { ...s, rec };
}

const MARK = 'Q7MARKERZ';
const text = (r: RawResponse): string => `${r.headers.map(([k, v]) => `${k}: ${v}`).join('\n')}\n${r.body.toString('latin1')}`;

test('T-VIZ-admission: Host must be byte-equal to 127.0.0.1:<port>', async () => {
  const s = await server();
  const p = s.port;
  const get = (host: string | null, path = '/'): string => `GET ${path} HTTP/1.1\r\n${host === null ? '' : `Host: ${host}\r\n`}X-Mark: ${MARK}\r\nConnection: close\r\n\r\n`;
  const good = await rawRequest(p, get(`127.0.0.1:${p}`));
  assert.equal(good.status, 200);
  const bad: Array<[string, string]> = [
    ['absent (HTTP/1.1)', get(null)],
    ['absent (HTTP/1.0)', `GET / HTTP/1.0\r\nX-Mark: ${MARK}\r\n\r\n`],
    ['localhost:p', get(`localhost:${p}`)],
    ['127.0.0.1', get('127.0.0.1')],
    ['127.0.0.1:p.', get(`127.0.0.1:${p}.`)],
    ['127.0.0.1.:p', get(`127.0.0.1.:${p}`)],
    ['[::1]:p', get(`[::1]:${p}`)],
    ['0.0.0.0:p', get(`0.0.0.0:${p}`)],
    ['evil.test:p', get(`evil.test:${p}`)],
    ['userinfo', get(`${MARK}@127.0.0.1:${p}`)],
    ['another port', get(`127.0.0.1:${p + 1}`)],
    ['empty', get('')],
    ['on /api/v1/world', get(`evil.test:${p}`, '/api/v1/world')],
    ['on the session POST', `POST /api/v1/session HTTP/1.1\r\nHost: evil.test:${p}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`],
    ['two Host headers (counted in rawHeaders)', `GET / HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nHost: 127.0.0.1:${p}\r\nConnection: close\r\n\r\n`],
    ['two Host headers, the second foreign', `GET / HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nhost: evil.test:${p}\r\nConnection: close\r\n\r\n`],
  ];
  for (const [what, bytes] of bad) {
    const r = await rawRequest(p, bytes);
    assert.equal(r.status, 421, what);
    assert.deepEqual(JSON.parse(r.body.toString('utf8')), { code: 'UI_VIZ_BAD_HOST' }, what);
    assertSecurityHeaders(r.headers, what);
    assert.ok(!text(r).includes(MARK) && !text(r).includes('evil'), `${what}: nothing of the request is echoed`);
  }
  assert.equal(s.rec.count('SEC_VIZ_BAD_HOST'), bad.length);
  assert.equal(s.tokens.redeemed(), false);
});

test('T-VIZ-admission: Origin, Sec-Fetch-Site and methods', async () => {
  const s = await server();
  const p = s.port;
  const session = await s.session();
  const api = (h: Record<string, string>): ReturnType<typeof request> => request(p, { path: '/api/v1/world', headers: { 'x-cowork-session': session, ...h } });
  const root = (h: Record<string, string>, path = '/'): ReturnType<typeof request> => request(p, { path, headers: h });
  assert.equal((await api({})).status, 200);
  assert.equal((await api({ origin: s.origin })).status, 200);
  assert.equal((await root({})).status, 200);
  assert.equal((await root({ origin: s.origin })).status, 200);

  const foreign = ['http://evil.test', `http://127.0.0.1:${p + 1}`, 'null', `http://localhost:${p}`, `https://127.0.0.1:${p}`, `http://127.0.0.1:${p}/`,
    `HTTP://127.0.0.1:${p}`, `http://[::1]:${p}`, ''];
  for (const origin of foreign) {
    for (const r of [await api({ origin }), await root({ origin }), await root({ origin }, '/app.js')]) {
      assert.equal(r.status, 403, `Origin ${JSON.stringify(origin)}`);
      assertSecurityHeaders(pairs(r.rawHeaders), `Origin ${origin}`);
    }
  }
  const twoOrigins = await rawRequest(p, `GET / HTTP/1.1\r\nHost: ${s.host}\r\nOrigin: ${s.origin}\r\nOrigin: ${s.origin}\r\nConnection: close\r\n\r\n`);
  assert.equal(twoOrigins.status, 403, 'two Origin headers');
  const badOrigins = s.rec.count('SEC_VIZ_BAD_ORIGIN');
  assert.equal(badOrigins, foreign.length * 3 + 1);

  // Sec-Fetch-Site: same-origin for /api/*; none or same-origin for / and the static assets (other 127.0.0.1 ports are same-site, S12).
  for (const site of ['cross-site', 'same-site']) {
    assert.equal((await api({ 'sec-fetch-site': site })).status, 403, `${site} on /api/*`);
    assert.equal((await root({ 'sec-fetch-site': site })).status, 403, `${site} on /`);
    assert.equal((await root({ 'sec-fetch-site': site }, '/app.css')).status, 403, `${site} on /app.css`);
  }
  assert.equal((await api({ 'sec-fetch-site': 'none' })).status, 403, 'none on /api/*');
  assert.equal((await api({ 'sec-fetch-site': 'bogus' })).status, 403);
  assert.equal((await root({ 'sec-fetch-site': 'none' })).status, 200, 'none on / passes');
  assert.equal((await root({ 'sec-fetch-site': 'none' }, '/app.js')).status, 200);
  assert.equal((await root({ 'sec-fetch-site': 'same-origin' })).status, 200);
  assert.equal((await api({ 'sec-fetch-site': 'same-origin', origin: s.origin })).status, 200);
  assert.equal(s.rec.count('SEC_VIZ_BAD_ORIGIN'), badOrigins + 8);

  // Methods: GET and HEAD; POST only on /api/v1/session; everything else 405 without any Access-Control-* header.
  const methods: Array<[string, string, Record<string, string>]> = [
    ['PUT', '/', {}], ['DELETE', '/', {}], ['PATCH', '/', {}], ['POST', '/', { origin: s.origin }], ['TRACE', '/', {}],
    ['OPTIONS', '/', { origin: s.origin, 'access-control-request-method': 'GET', 'access-control-request-private-network': 'true' }],
    ['OPTIONS', '/api/v1/world', { origin: s.origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-cowork-session', 'access-control-request-private-network': 'true' }],
    ['PUT', '/api/v1/world', { 'x-cowork-session': session }], ['DELETE', '/api/v1/session', { origin: s.origin }],
    ['POST', '/api/v1/world', { origin: s.origin, 'x-cowork-session': session }],
  ];
  for (const [method, path, headers] of methods) {
    const r = await request(p, { method, path, headers });
    assert.equal(r.status, 405, `${method} ${path}`);
    assertSecurityHeaders(pairs(r.rawHeaders), `${method} ${path}`);
  }
  assert.equal(s.rec.count('SEC_VIZ_METHOD'), methods.length);
  assert.equal((await request(p, { method: 'HEAD', path: '/' })).status, 200, 'HEAD on the shell');
  // §3.10.3 item 4 admits GET and HEAD on every path; the §3.10.5 table has no GET or HEAD row for the session route and only GET rows
  // for the session-authenticated routes, so those requests are "anything else": 404, not a method refusal.
  const notRoutes: Array<[string, string, Record<string, string>]> = [
    ['GET', '/api/v1/session', {}], ['HEAD', '/api/v1/session', {}], ['GET', '/api/v1/session', { 'x-cowork-session': session }],
    ['HEAD', '/api/v1/world', { 'x-cowork-session': session }], ['HEAD', '/api/v1/strings?lang=en', { 'x-cowork-session': session }],
    ['HEAD', '/api/v1/stream', { 'x-cowork-session': session, 'last-event-id': '0' }],
  ];
  for (const [method, path, headers] of notRoutes) {
    const r = await request(p, { method, path, headers });
    assert.equal(r.status, 404, `${method} ${path}`);
    assertSecurityHeaders(pairs(r.rawHeaders), `${method} ${path}`);
    if (method === 'GET') assert.deepEqual(JSON.parse(r.body.toString('utf8')), { code: 'UI_VIZ_NOT_FOUND' });
  }
  assert.equal(s.rec.count('SEC_VIZ_METHOD'), methods.length, 'no method refusal for them');
  assert.equal(s.hub.open(), 0, 'HEAD /api/v1/stream attaches no stream');
  assert.equal(s.tokens.redeemed(), true);
  // A HEAD without a session matches no route either: route matching comes before the session check (§3.10.5), so 404, not 401.
  assert.equal((await request(p, { method: 'HEAD', path: '/api/v1/world' })).status, 404);
});

/** A raw stream request that never reads its response: the client socket is paused, so the server's buffer for it only grows. */
async function stalledStream(port: number, host: string, session: string): Promise<{ sock: net.Socket; closed: Promise<void> }> {
  const sock = net.connect({ host: '127.0.0.1', port });
  await new Promise<void>((resolve, reject) => { sock.once('connect', () => resolve()); sock.once('error', reject); });
  sock.pause();
  const closed = new Promise<void>((resolve) => { sock.once('close', () => resolve()); });
  sock.on('error', () => {});
  sock.write(`GET /api/v1/stream HTTP/1.1\r\nHost: ${host}\r\nX-Cowork-Session: ${session}\r\nLast-Event-ID: 0\r\n\r\n`);
  return { sock, closed };
}

/** A raw stream request that reads everything as it arrives (flowing) and records each SSE message's id and event name, incrementally
 *  (the stream carries megabytes): ids only grow on one stream, so a header seen again in the carried tail is not counted twice.
 *  pause() stops reading (the server's backlog for it grows), resume() reads again. */
interface ReadingStream {
  lastId(): number; events(): Array<[number, string]>; waitForId(n: number): Promise<void>; closed: Promise<void>; close(): void;
  pause(): void; resume(): void;
}
async function readingStream(port: number, host: string, session: string, lastEventId = '0'): Promise<ReadingStream> {
  const sock = net.connect({ host: '127.0.0.1', port });
  await new Promise<void>((resolve, reject) => { sock.once('connect', () => resolve()); sock.once('error', reject); });
  let tail = '';
  let last = -1;
  const seen: Array<[number, string]> = [];
  const waiters: Array<() => void> = [];
  const closed = new Promise<void>((resolve) => { sock.once('close', () => { resolve(); for (const w of waiters.splice(0)) w(); }); });
  sock.on('data', (d: Buffer) => {
    const text = tail + d.toString('latin1');
    for (const m of text.matchAll(/\nid: (\d+)\nevent: ([a-z_]+)\n/g)) {
      const id = Number(m[1]);
      if (id > last) {
        last = id;
        seen.push([id, m[2] as string]);
      }
    }
    tail = text.slice(-64);
    for (const w of waiters.splice(0)) w();
  });
  sock.on('error', () => {});
  sock.write(`GET /api/v1/stream HTTP/1.1\r\nHost: ${host}\r\nX-Cowork-Session: ${session}\r\nLast-Event-ID: ${lastEventId}\r\n\r\n`);
  return {
    lastId: () => last,
    events: () => [...seen],
    closed,
    waitForId: (n) => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`readingStream: id ${n} not received (last ${last})`)), 10_000);
      const check = (): void => {
        if (last >= n) {
          clearTimeout(t);
          resolve();
        } else waiters.push(check);
      };
      check();
    }),
    close: () => sock.destroy(),
    pause: () => { sock.pause(); },
    resume: () => { sock.resume(); },
  };
}

test('T-VIZ-admission: limits', async () => {
  const s = await server();
  const p = s.port;
  const H = `Host: ${s.host}\r\nX-Mark: ${MARK}\r\n`;
  const expect = async (what: string, bytes: string, status: number): Promise<void> => {
    const r = await rawRequest(p, bytes);
    assert.equal(r.status, status, what);
    if (status !== 0) assertSecurityHeaders(r.headers, what);
    assert.ok(!text(r).includes(MARK), `${what}: nothing of the request is echoed`);
  };
  // Request line and headers ≤ 8 KiB: over → 431 (Node's parser limit, answered by the clientError listener).
  await expect('headers over 8 KiB', `GET / HTTP/1.1\r\n${H}X-Big: ${'a'.repeat(8_400)}\r\nConnection: close\r\n\r\n`, 431);
  // URL ≤ 2 KiB → else 400 (431 when the 8 KiB header limit trips first), never 414.
  await expect('URL of 2,048 bytes is admitted', `GET /${'u'.repeat(2_047)} HTTP/1.1\r\n${H}Connection: close\r\n\r\n`, 404);
  await expect('URL of 2,049 bytes', `GET /${'u'.repeat(2_048)}${MARK} HTTP/1.1\r\n${H}Connection: close\r\n\r\n`, 400);
  await expect('URL of 3 KiB on /api', `GET /api/v1/world?${'u'.repeat(3_000)} HTTP/1.1\r\n${H}Connection: close\r\n\r\n`, 400);
  await expect('URL of 9 KiB', `GET /${'u'.repeat(9_000)}${MARK} HTTP/1.1\r\n${H}Connection: close\r\n\r\n`, 431);
  // A body only on the session POST.
  await expect('a body on GET', `GET / HTTP/1.1\r\n${H}Content-Length: 3\r\nConnection: close\r\n\r\nabc`, 400);
  await expect('a chunked body on GET', `GET / HTTP/1.1\r\n${H}Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n3\r\nabc\r\n0\r\n\r\n`, 400);
  await expect('a chunked empty body on GET', `GET /api/v1/world HTTP/1.1\r\n${H}Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n`, 400);
  await expect('Content-Length: 0 on GET is no body', `GET / HTTP/1.1\r\n${H}Content-Length: 0\r\nConnection: close\r\n\r\n`, 200);
  // The session body is at most 256 bytes.
  const sessionPost = (extra: string, body: string): string =>
    `POST /api/v1/session HTTP/1.1\r\n${H}Origin: ${s.origin}\r\nX-Cowork-Launch: ${s.tokens.launch}\r\n${extra}Connection: close\r\n\r\n${body}`;
  await expect('a session body of 257 bytes', sessionPost('Content-Length: 257\r\n', 'b'.repeat(257)), 413);
  await expect('a session body of 300 bytes, announced only', sessionPost('Content-Length: 300\r\n', ''), 413);
  const chunk = (n: number): string => `${n.toString(16)}\r\n${'c'.repeat(n)}\r\n`;
  await expect('a chunked session body of 300 bytes', sessionPost('Transfer-Encoding: chunked\r\n', `${chunk(200)}${chunk(100)}0\r\n\r\n`), 413);
  assert.equal(s.tokens.redeemed(), false, 'an oversize body redeems nothing');
  // Request targets: origin-form only.
  await expect('an absolute-form target', `GET http://127.0.0.1:${p}/ HTTP/1.1\r\n${H}Connection: close\r\n\r\n`, 400);
  await expect('an asterisk-form target', `GET * HTTP/1.1\r\n${H}Connection: close\r\n\r\n`, 400);
  // One SEC_VIZ_LIMIT per refused request above, each exactly once: 2 × 431, 2 URLs over 2 KiB, 3 bodies on GET, 3 session bodies over
  // 256 bytes, 2 request targets that are not origin-form.
  assert.equal(s.rec.count('SEC_VIZ_LIMIT'), 12);
  // Upgrade and CONNECT: the socket is destroyed, nothing is answered.
  await expect('Upgrade: websocket', `GET / HTTP/1.1\r\n${H}Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`, 0);
  await expect('Upgrade without Connection: upgrade', `GET / HTTP/1.1\r\n${H}Upgrade: websocket\r\n\r\n`, 0);
  await expect('CONNECT', `CONNECT 127.0.0.1:${p} HTTP/1.1\r\n${H}\r\n`, 0);
  // A session body within the cap is accepted (and redeems).
  await expect('a session body of 256 bytes', sessionPost('Content-Length: 256\r\n', 'd'.repeat(256)), 200);

  assert.equal(s.rec.count('SEC_VIZ_LIMIT'), 12, 'an upgrade or CONNECT counts SEC_VIZ_METHOD, not a limit');
  assert.equal(s.rec.count('SEC_VIZ_METHOD'), 3);

  // At most 32 connections: the 33rd is refused while 32 are held. They are held by open streams — an in-flight response, which
  // neither the 5 s keepAliveTimeout nor the header and request timeouts end, however long opening them takes.
  const fresh = await server();
  const freshSession = await fresh.session();
  const held: OpenStream[] = [];
  try {
    for (let i = 0; i < 32; i++) held.push(await openStream(fresh.port, { 'x-cowork-session': freshSession, 'last-event-id': '0' }));
    assert.equal(fresh.hub.open(), 32);
    const r = await rawRequest(fresh.port, `GET /favicon.ico HTTP/1.1\r\nHost: ${fresh.host}\r\nConnection: close\r\n\r\n`);
    assert.equal(r.status, 0, 'the 33rd connection is refused');
    held.pop()?.close();
    let again: RawResponse = { status: 0, headers: [], body: Buffer.alloc(0) };
    for (let i = 0; i < 50 && again.status === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      again = await rawRequest(fresh.port, `GET /favicon.ico HTTP/1.1\r\nHost: ${fresh.host}\r\nConnection: close\r\n\r\n`);
    }
    assert.equal(again.status, 204, 'a freed slot is usable');
  } finally {
    for (const h of held) h.close();
  }
});

test('T-VIZ-admission: limits — a stream that never reads is closed once more than 1 MiB waits in its buffer, counted SEC_VIZ_LIMIT once; a stream that reads stays open', async () => {
  const s = await server();
  const session = await s.session();
  const reader = await readingStream(s.port, s.host, session);
  const stalled = await stalledStream(s.port, s.host, session);
  for (let i = 0; i < 100 && s.hub.open() < 2; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.hub.open(), 2);
  // ~64 KiB per event; the reader takes each one before the next is published, the stalled client none.
  const big: StreamPayload = { type: 'room', room_id: 'rABCDEFGH', change: 'state', label: 'x'.repeat(65_000), branch: 'main', gone: false, badges: [], unknown: 0 };
  let published = 0;
  try {
    while (s.hub.open() === 2 && published < 1_000) {
      s.hub.publish(big);
      published++;
      await reader.waitForId(s.hub.seq());
    }
    assert.equal(s.hub.open(), 1, `the stalled stream is closed (after ${published} events of 64 KiB)`);
    // The client now reads what the kernel still held, then sees the server's end of the connection.
    stalled.sock.resume();
    await stalled.closed;
    assert.ok(published > 16, 'not before 1 MiB was buffered');
    assert.equal(s.rec.count('SEC_VIZ_LIMIT'), 1, 'counted once');
    s.hub.publish({ type: 'reset' });
    await reader.waitForId(s.hub.seq());
    assert.equal(s.hub.open(), 1, 'the reading stream stays open');
  } finally {
    reader.close();
    stalled.sock.destroy();
  }
});

/** ~64 KiB per event; BURST_EVENTS of them are ~4 MiB. */
const BIG: StreamPayload = { type: 'room', room_id: 'rABCDEFGH', change: 'state', label: 'x'.repeat(65_000), branch: 'main', gone: false, badges: [], unknown: 0 };
const BURST_EVENTS = 64;

/** Publishes `n` events of ~64 KiB within one turn of the event loop, so ONE deferred check follows them all, each event in its own
 *  send. Writes within one tick are corked into a single send, and the Windows kernel takes one send of any size whole while its buffer
 *  has room (measured: a corked 26 MiB burst to a paused reader left a backlog of 0 at the check), so a corked burst never tests the
 *  cap there. A process.nextTick between events uncorks each one, and the backlog the check sees is real (measured on Windows: 2.9 MiB
 *  of a 3 MiB burst at the check, with a paused or a flowing reader). */
async function burst(s: TestServer, n = BURST_EVENTS): Promise<void> {
  for (let i = 0; i < n; i++) {
    s.hub.publish(BIG);
    await new Promise<void>((resolve) => { process.nextTick(resolve); });
  }
}

/** Real time for the deferred check (setImmediate) after a burst to have run. */
const settle = (ms = 100): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function attached(s: TestServer, n: number): Promise<void> {
  for (let i = 0; i < 100 && s.hub.open() < n; i++) await settle(10);
  assert.equal(s.hub.open(), n);
}

test('T-VIZ-admission: limits — the 1 MiB stream cap measures the backlog left after a flush, across two checks (R-V65): a reading stream survives a burst of ~4 MiB published in one turn of the event loop, and a resume behind more than 1 MiB gets one reset, then live events; neither is counted', async () => {
  const s = await server();
  const session = await s.session();
  const small: StreamPayload = { type: 'room', room_id: 'rABCDEFGH', change: 'state', label: 'live', branch: 'main', gone: false, badges: [], unknown: 0 };

  // A burst to an attached reader that reads as data arrives: the one deferred check after it finds the backlog over the cap (the
  // reader runs in the same process, so it has not yet taken the burst), and one such check cuts nothing.
  const reader = await readingStream(s.port, s.host, session);
  try {
    await attached(s, 1);
    await burst(s);
    await reader.waitForId(BURST_EVENTS);
    assert.deepEqual(reader.events().map(([id]) => id), Array.from({ length: BURST_EVENTS }, (_, i) => i + 1), 'every event of the burst arrives');
    s.hub.publish(small);
    await reader.waitForId(BURST_EVENTS + 1);
    assert.equal(s.hub.open(), 1, 'the reader is still attached after the burst');
  } finally {
    reader.close();
  }

  // A resume: 48 events of ~64 KiB (3 MiB) wait in the ring behind the presented Last-Event-ID.
  const presented = String(s.hub.seq());
  for (let i = 0; i < 48; i++) s.hub.publish(BIG);
  const seq = s.hub.seq();
  const resumed = await readingStream(s.port, s.host, session, presented);
  try {
    await resumed.waitForId(seq);
    s.hub.publish(small);
    await resumed.waitForId(seq + 1);
    assert.deepEqual(resumed.events(), [[seq, 'reset'], [seq + 1, 'room']], 'exactly one reset (the page reloads the world), then live events');
  } finally {
    resumed.close();
  }
  assert.equal(s.rec.count('SEC_VIZ_LIMIT'), 0, 'a reader that reads is never counted');
});

test('T-VIZ-admission: limits — R-V65(c): two bursts over 1 MiB separated by a full drain, with no write between, leave a reading stream open: one deferred check over the cap cuts nothing, and the drain (res \'drain\') clears it, so the second burst\'s check is a first check again', async () => {
  const s = await server();
  const reader = await readingStream(s.port, s.host, await s.session());
  try {
    await attached(s, 1);
    // The first burst while the reader is paused (a busy page): the deferred check finds the backlog over the cap. One such check cuts
    // nothing.
    reader.pause();
    await burst(s);
    await settle();
    assert.equal(s.hub.open(), 1, 'one deferred check over the cap cuts nothing (the two-check rule)');
    // The reader takes everything: a full drain, and nothing is written after it.
    reader.resume();
    await reader.waitForId(s.hub.seq());
    await settle();
    // The second burst, the same way. Its check must be a first check again, not the second check of the first burst.
    reader.pause();
    await burst(s);
    await settle();
    assert.equal(s.hub.open(), 1, 'the second burst after a full drain is a first check again, not a second');
    reader.resume();
    await reader.waitForId(s.hub.seq());
    await settle();
    assert.equal(s.hub.open(), 1, 'the reader stays attached');
    assert.deepEqual(reader.events().map(([id]) => id), Array.from({ length: 2 * BURST_EVENTS }, (_, i) => i + 1), 'every event of both bursts arrives');
  } finally {
    reader.close();
  }
  assert.equal(s.rec.count('SEC_VIZ_LIMIT'), 0, 'a reader that reads is never counted');
});
