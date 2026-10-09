// Response headers on every route and status (12 §3.10.4; VIZ-31, VIZ-33) and the JSON escaping of served bodies.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { CSP, escapeJson, SECURITY_HEADERS } from '../../../src/viz/server/http.js';
import {
  assertSecurityHeaders, openStream, pairs, rawRequest, specHeaderSet, startTestServer, stubApi, TEST_ROOM, type TestServer,
} from '../../helpers/vizHttp.js';

const servers: TestServer[] = [];
after(async () => { for (const s of servers) await s.close(); });

const HOSTILE = '<b>&amp;\u{2028}\u{2029}</b>';

test('T-VIZ-headers: every route and status carries the 12 §3.10.4 set with the CSP byte-equal to the one-line form, and no Set-Cookie, WWW-Authenticate, Access-Control-*, Server, ETag, Last-Modified or X-Powered-By; JSON escapes <, >, &, U+2028 and U+2029', async () => {
  // The constants are the spec's set: the CSP is one line, directives in order, '; ' separated, no trailing ';'.
  const spec = specHeaderSet();
  assert.deepEqual(Object.entries(SECURITY_HEADERS), spec);
  assert.equal(CSP, spec.find(([k]) => k === 'Content-Security-Policy')?.[1]);
  assert.ok(!CSP.includes('\n') && !CSP.endsWith(';') && !CSP.includes(';  ') && !CSP.includes('upgrade-insecure-requests'));
  assert.equal(CSP.split('; ').length, 15);

  const s = await startTestServer({
    api: (hub) => stubApi(hub, {
      world: async () => ({ v: 1, cursor: hub.seq(), demo: true, rooms: [], captions: [{ room_id: TEST_ROOM, height: 1, code: null, text: HOSTILE }] }),
      page: async (roomId) => { if (roomId === 'rZZZZZZZZ') throw new Error('stub failure'); return null; },
    }),
  });
  servers.push(s);
  const p = s.port;
  const session = await s.session();
  const auth = `X-Cowork-Session: ${session}\r\n`;
  const get = (path: string, extra = '', method = 'GET'): string => `${method} ${path} HTTP/1.1\r\nHost: ${s.host}\r\n${extra}Connection: close\r\n\r\n`;
  const cases: Array<[string, string, number, string | null]> = [
    ['shell', get('/'), 200, 'text/html; charset=utf-8'],
    ['shell HEAD', get('/', '', 'HEAD'), 200, 'text/html; charset=utf-8'],
    ['app.js', get('/app.js'), 200, 'text/javascript; charset=utf-8'],
    ['app.css', get('/app.css'), 200, 'text/css; charset=utf-8'],
    ['favicon', get('/favicon.ico'), 204, null],
    ['world', get('/api/v1/world', auth), 200, 'application/json; charset=utf-8'],
    ['strings', get('/api/v1/strings?lang=ko', auth), 200, 'application/json; charset=utf-8'],
    ['timeline 404', get(`/api/v1/rooms/${TEST_ROOM}/timeline?from=1&to=2`, auth), 404, 'application/json; charset=utf-8'],
    ['internal error', get('/api/v1/rooms/rZZZZZZZZ/timeline?from=1&to=2', auth), 500, 'application/json; charset=utf-8'],
    ['not found', get('/nope'), 404, 'application/json; charset=utf-8'],
    ['no session', get('/api/v1/world'), 401, 'application/json; charset=utf-8'],
    ['wrong launch token', `POST /api/v1/session HTTP/1.1\r\nHost: ${s.host}\r\nOrigin: ${s.origin}\r\nX-Cowork-Launch: ${'0'.repeat(64)}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`, 401, 'application/json; charset=utf-8'],
    ['bad host', `GET / HTTP/1.1\r\nHost: localhost:${p}\r\nConnection: close\r\n\r\n`, 421, 'application/json; charset=utf-8'],
    ['bad origin', get('/', 'Origin: http://evil.test\r\n'), 403, null],
    ['method', get('/', '', 'PUT'), 405, null],
    ['bad height', get(`/api/v1/rooms/${TEST_ROOM}/timeline?from=01&to=2`, auth), 400, null],
    ['body on GET', get('/', 'Content-Length: 1\r\n').replace('\r\n\r\n', '\r\n\r\nx'), 400, null],
    ['session body', `POST /api/v1/session HTTP/1.1\r\nHost: ${s.host}\r\nOrigin: ${s.origin}\r\nContent-Length: 999\r\nConnection: close\r\n\r\n`, 413, null],
    ['expectation', get('/', 'Expect: nope\r\n'), 417, null],
    ['header overflow', get('/', `X-Big: ${'a'.repeat(9_000)}\r\n`), 431, null],
    ['malformed', 'NOT A REQUEST\r\n\r\n', 400, null],
  ];
  for (const [what, bytes, status, type] of cases) {
    const r = await rawRequest(p, bytes);
    assert.equal(r.status, status, what);
    assertSecurityHeaders(r.headers, what);
    if (type !== null) assert.equal(r.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1], type, `${what}: Content-Type`);
    // A 204 carries no body and therefore no Content-Length (RFC 9110 §8.6).
    if (status === 204) assert.deepEqual(r.headers.filter(([k]) => /^(content-length|transfer-encoding)$/i.test(k)), [], `${what}: no Content-Length`);
  }
  // The stream response.
  const stream = await openStream(p, { 'x-cowork-session': session, 'last-event-id': '0' });
  assert.equal(stream.status, 200);
  assert.equal(stream.headers['content-type'], 'text/event-stream; charset=utf-8');
  const raw: string[] = [];
  for (const [k, v] of Object.entries(stream.headers)) raw.push(k, String(v));
  assertSecurityHeaders(pairs(raw), 'stream');
  stream.close();

  // JSON escaping on the wire: no raw <, >, &, U+2028 or U+2029 in a JSON body.
  const world = await rawRequest(p, get('/api/v1/world', auth));
  const body = world.body.toString('utf8');
  assert.ok(!/[<>&\u{2028}\u{2029}]/u.test(body), body);
  assert.ok(body.includes('\\u003cb\\u003e\\u0026amp;\\u2028\\u2029\\u003c/b\\u003e'));
  assert.equal((JSON.parse(body) as { captions: Array<{ text: string }> }).captions[0]?.text, HOSTILE);
  assert.equal(escapeJson({ a: HOSTILE }), '{"a":"\\u003cb\\u003e\\u0026amp;\\u2028\\u2029\\u003c/b\\u003e"}');
});
