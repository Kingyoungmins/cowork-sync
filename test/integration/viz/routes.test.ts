// Routes and their parameters (12 §3.10.5; VIZ-34, INV-VIZ-AUTH), internal errors (12 §3.10.4) and the static shell.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { realFs } from '../../../src/ports/fs.js';
import { SHELL_HTML, staticRoute } from '../../../src/viz/server/shell.js';
import { openVizLog } from '../../../src/viz/server/vizLog.js';
import { makeTempRoot } from '../../helpers/tmp.js';
import { spyNodeFs, type FsCall } from '../../helpers/vizFs.js';
import {
  emptySceneVM, openStream, rawRequest, RecordingLog, request, startTestServer, stubApi, TEST_ASSETS, TEST_ROOM, type TestServer,
} from '../../helpers/vizHttp.js';
import { VirtualClock } from '../../sim/vclock.js';

const cleanups: Array<() => Promise<void>> = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });
const keep = (s: TestServer): TestServer => { cleanups.push(() => s.close()); return s; };
const code = (b: Buffer): unknown => (JSON.parse(b.toString('utf8')) as { code?: unknown }).code;

test('T-VIZ-routes: unknown paths → 404 UI_VIZ_NOT_FOUND; room ids in lower case, with I, L, O or U, of 7 or 9 characters, .., encoded slashes and path-like parameters → 404 or 400; a valid upper-case room id → 200; lang outside the six → 404; heights outside ^(0|[1-9][0-9]{0,9})$ → 400; an Fs spy sees no file access caused by any URL', async () => {
  const tmp = await makeTempRoot('viz-routes');
  cleanups.push(tmp.cleanup);
  const logDir = join(tmp.root, 'log');
  const log = await openVizLog({ fs: realFs, clock: new VirtualClock(), dir: logDir, instance: 'BBBB0002' });
  const pages: Array<[string, number, number]> = [];
  const s = keep(await startTestServer({
    log,
    api: (hub) => stubApi(hub, {
      page: async (roomId, from, to) => {
        pages.push([roomId, from, to]);
        return roomId === TEST_ROOM ? { room_id: TEST_ROOM, from, to, scene: emptySceneVM(from), events: [], cards: [], layout: null } : null;
      },
    }),
  }));
  const session = await s.session();
  // From here on every file call that reaches node:fs — through the Fs port's realFs or any direct import — is recorded.
  const calls: FsCall[] = [];
  const restore = spyNodeFs(calls);
  cleanups.push(async () => restore());
  const get = (path: string): Promise<{ status: number; body: Buffer }> =>
    rawRequest(s.port, `GET ${path} HTTP/1.1\r\nHost: ${s.host}\r\nX-Cowork-Session: ${session}\r\nConnection: close\r\n\r\n`);
  const tl = (room: string, q = 'from=1&to=2'): string => `/api/v1/rooms/${room}/timeline?${q}`;

  const notFound = [
    '/nope', '/index.html', '/app.js/', '/APP.JS', '//app.js', '/./app.js', '/../app.js', '/%2e%2e/app.js', '/app%2Ejs', '/app.js?v=1', '/?path=C:/x',
    '/favicon.ico/x', '/api', '/api/', '/api/v1', '/api/v1/', '/api/v2/world', '/api/v1/world/', '/api/v1/World', '/api/v1/world?file=/etc/passwd',
    '/api/v1/stream/', '/api/v1/rooms', `/api/v1/rooms/${TEST_ROOM}`, `/api/v1/rooms/${TEST_ROOM}/timeline/?from=1&to=2`,
    tl('rabcdefgh'), tl('Rabcdefgh'), tl('rABCDEFGI'), tl('rABCDEFGL'), tl('rABCDEFGO'), tl('rABCDEFGU'), tl('rABCDEFG'), tl('rABCDEFGHJ'),
    tl('..'), '/api/v1/rooms/../world', `/api/v1/rooms/${TEST_ROOM}%2Ftimeline?from=1&to=2`, `/api/v1/rooms/${TEST_ROOM}%2ftimeline?from=1&to=2`,
    `/api/v1/rooms/..%2F..%2Fetc/timeline?from=1&to=2`, `/api/v1/rooms/${TEST_ROOM}/../${TEST_ROOM}/timeline?from=1&to=2`, tl('rZZZZZZZZ'),
    '/api/v1/strings?lang=../../etc/passwd', '/api/v1/strings?lang=de', '/api/v1/strings?lang=EN', '/api/v1/strings?lang=en-US',
    '/api/v1/strings?lang=zh-cn', '/api/v1/strings?lang=', '/api/v1/strings?lang=%65n', '/api/v1/strings?lang=__proto__',
  ];
  for (const path of notFound) {
    const r = await get(path);
    assert.equal(r.status, 404, path);
    assert.equal(code(r.body), 'UI_VIZ_NOT_FOUND', path);
  }
  const badRequest = [
    tl(TEST_ROOM, 'from=01&to=2'), tl(TEST_ROOM, 'from=-1&to=2'), tl(TEST_ROOM, 'from=1.0&to=2'), tl(TEST_ROOM, 'from=10000000000&to=2'),
    tl(TEST_ROOM, 'from=&to=2'), tl(TEST_ROOM, 'from=a&to=2'), tl(TEST_ROOM, 'from=%31&to=2'), tl(TEST_ROOM, 'from=0x1&to=2'), tl(TEST_ROOM, 'from=1e3&to=2'),
    tl(TEST_ROOM, 'from=1&to=+2'), tl(TEST_ROOM, 'from=1'), tl(TEST_ROOM, 'to=2'), tl(TEST_ROOM, 'from=1&to=2&path=src/a.ts'),
    tl(TEST_ROOM, 'from=1&from=1&to=2'), tl(TEST_ROOM, 'from=1&to=2&'), tl(TEST_ROOM, 'from=1;to=2'), tl(TEST_ROOM, ''),
    `/api/v1/rooms/${TEST_ROOM}/timeline`, '/api/v1/strings', '/api/v1/strings?lang=en&x=1', '/api/v1/strings?gitdir=/x', '/api/v1/strings?lang=en&lang=ko',
  ];
  for (const path of badRequest) {
    const r = await get(path);
    assert.equal(r.status, 400, path);
  }
  assert.deepEqual(pages.map(([room]) => room), ['rZZZZZZZZ'], 'only a well-formed room id reaches the api');

  // The valid forms.
  const ok = await get(tl(TEST_ROOM));
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body.toString('utf8')), { room_id: TEST_ROOM, from: 1, to: 2, scene: emptySceneVM(1), events: [], cards: [], layout: null });
  assert.equal((await get(tl(TEST_ROOM, 'to=9999999999&from=0'))).status, 200, 'the largest height; parameters in any order');
  assert.deepEqual(pages.at(-1), [TEST_ROOM, 0, 9_999_999_999]);
  for (const lang of ['en', 'ko', 'zh-CN', 'ja', 'fr', 'es']) {
    const r = await get(`/api/v1/strings?lang=${lang}`);
    assert.equal(r.status, 200, lang);
    assert.deepEqual(JSON.parse(r.body.toString('utf8')), { lang: 'en', templates: {} });
  }
  for (const path of ['/', '/app.js', '/app.css']) assert.equal((await get(path)).status, 200, path);
  assert.equal((await get('/favicon.ico')).status, 204);
  assert.equal((await get('/api/v1/world')).status, 200);
  // One refused session, so the log writes a line while the spy watches (the spy is live).
  assert.equal((await rawRequest(s.port, `GET /api/v1/world HTTP/1.1\r\nHost: ${s.host}\r\nConnection: close\r\n\r\n`)).status, 401);

  // No URL caused a file access: the log's own appends are the only calls, all inside its directory.
  await log.flush();
  restore();
  assert.ok(calls.some((c) => c.op === 'promises.appendFile'), 'the spy saw the log\'s own append');
  for (const c of calls) {
    assert.equal(c.op, 'promises.appendFile', `no ${c.op} caused by a URL (${c.paths.join(', ')})`);
    for (const p of c.paths) assert.ok(p.startsWith(logDir), p);
  }
});

test('T-VIZ-routes: a missing or bad session → 401 UI_VIZ_NEED_LINK and SEC_VIZ_BAD_TOKEN, no lockout; an EventSource-style query token is refused', async () => {
  const rec = new RecordingLog();
  const s = keep(await startTestServer({ log: rec }));
  const before = await request(s.port, { path: '/api/v1/world', headers: { 'x-cowork-session': 'f'.repeat(64) } });
  assert.equal(before.status, 401, 'no session exists before the redemption');
  const session = await s.session();
  const bad: Array<Record<string, string>> = [
    {}, { 'x-cowork-session': '' }, { 'x-cowork-session': s.tokens.launch }, { 'x-cowork-session': session.toUpperCase() },
    { 'x-cowork-session': `${session.slice(0, 63)}0` === session ? `${session.slice(0, 63)}1` : `${session.slice(0, 63)}0` },
    { 'x-cowork-session': `${session} ` + 'x' }, { 'x-cowork-session': session.slice(1) }, { 'x-cowork-launch': s.tokens.launch },
    { authorization: `Bearer ${session}` }, { cookie: `session=${session}` },
  ];
  const routes = ['/api/v1/world', '/api/v1/strings?lang=en', '/api/v1/stream', `/api/v1/rooms/${TEST_ROOM}/timeline?from=1&to=2`];
  for (let round = 0; round < 3; round++) {
    for (const headers of bad) {
      for (const path of routes) {
        const r = await request(s.port, { path, headers });
        assert.equal(r.status, 401, `${path} ${JSON.stringify(Object.keys(headers))}`);
        assert.equal(code(r.body), 'UI_VIZ_NEED_LINK');
      }
    }
  }
  // Two X-Cowork-Session headers (the right one among them) are not a session.
  const dup = await rawRequest(s.port, `GET /api/v1/world HTTP/1.1\r\nHost: ${s.host}\r\nX-Cowork-Session: ${session}\r\nX-Cowork-Session: ${session}\r\nConnection: close\r\n\r\n`);
  assert.equal(dup.status, 401);
  assert.equal(rec.count('SEC_VIZ_BAD_TOKEN'), 1 + 3 * bad.length * routes.length + 1);
  // No lockout: the right session still works after all of it.
  assert.equal((await request(s.port, { path: '/api/v1/world', headers: { 'x-cowork-session': session } })).status, 200);
  // EventSource cannot send a header, so its token would ride in the URL: refused, and no stream is attached.
  const query = await request(s.port, { path: `/api/v1/stream?session=${session}` });
  assert.equal(query.status, 401);
  const both = await request(s.port, { path: `/api/v1/stream?x-cowork-session=${session}`, headers: { 'x-cowork-session': session } });
  assert.equal(both.status, 404, 'the stream route takes no parameter');
  assert.equal(s.hub.open(), 0);
  const stream = await openStream(s.port, { 'x-cowork-session': session, 'last-event-id': '0' });
  assert.equal(stream.status, 200);
  assert.equal(s.hub.open(), 1);
  stream.close();
});

test('T-VIZ-routes: under /api/ a method and path that no §3.10.5 row takes answer 404 UI_VIZ_NOT_FOUND before any session check (route matching comes first)', async () => {
  const rec = new RecordingLog();
  const s = keep(await startTestServer({ log: rec }));
  const misses: Array<[string, string]> = [
    ['GET', '/api/v2/x'], ['HEAD', '/api/v1/world'], ['HEAD', '/api/v1/stream'], ['HEAD', '/api/v1/strings?lang=en'], ['GET', '/api/v1/nope'],
    ['GET', '/api/'], ['GET', '/api/v1/world/'], ['GET', '/api/v1/rooms/rabcdefgh/timeline?from=1&to=2'], ['HEAD', `/api/v1/rooms/${TEST_ROOM}/timeline?from=1&to=2`],
  ];
  for (const [method, path] of misses) {
    for (const headers of [{}, { 'x-cowork-session': 'f'.repeat(64) }] as Array<Record<string, string>>) {
      const r = await request(s.port, { method, path, headers });
      assert.equal(r.status, 404, `${method} ${path} ${JSON.stringify(Object.keys(headers))}`);
      if (method === 'GET') assert.equal(code(r.body), 'UI_VIZ_NOT_FOUND', `${method} ${path}`);
    }
  }
  assert.equal(rec.count('SEC_VIZ_BAD_TOKEN'), 0, 'no session check ran for them');
  assert.equal(s.activity(), 0, 'nor counted as activity');
  assert.equal(s.hub.open(), 0, 'no stream attached');
  // A request that matches a route still needs the session.
  assert.equal((await request(s.port, { path: '/api/v1/world' })).status, 401);
  assert.equal(rec.count('SEC_VIZ_BAD_TOKEN'), 1);
});

test('an internal error answers 500 UI_INTERNAL_ERROR and logs stack frames only', async () => {
  const tmp = await makeTempRoot('viz-500');
  cleanups.push(tmp.cleanup);
  const logDir = join(tmp.root, 'log');
  const log = await openVizLog({ fs: realFs, clock: new VirtualClock(), dir: logDir, instance: 'CCCC0003' });
  const secret = join(tmp.root, 'repo', 'secret-file.ts');
  const s = keep(await startTestServer({
    log,
    api: (hub) => stubApi(hub, { world: async () => { const e = new Error(`cannot read ${secret}`) as Error & { code: string }; e.code = 'EACCES'; throw e; } }),
  }));
  const session = await s.session();
  const r = await request(s.port, { path: '/api/v1/world', headers: { 'x-cowork-session': session } });
  assert.equal(r.status, 500);
  assert.deepEqual(JSON.parse(r.body.toString('utf8')), { code: 'UI_INTERNAL_ERROR' });
  assert.ok(!r.body.toString('utf8').includes('secret'));
  await log.flush();
  const text = readFileSync(join(logDir, 'viz-CCCC0003-1.jsonl'), 'utf8');
  const lines = text.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as { code: string; err?: string; frames?: Array<{ fn: string }> });
  const line = lines.find((l) => l.code === 'UI_INTERNAL_ERROR');
  assert.ok(line !== undefined);
  assert.equal(line.err, 'EACCES');
  assert.ok((line.frames ?? []).length > 0, 'stack frames are logged');
  assert.ok((line.frames ?? []).some((f) => f.fn.includes('routes.test.ts')), 'the throwing function by basename');
  for (const s2 of ['secret', 'cannot read', tmp.root, ':\\\\', '/Users/', '/home/']) assert.ok(!text.includes(s2), `no ${s2} in the log`);
  // The server keeps serving.
  assert.equal((await request(s.port, { path: '/' })).status, 200);
});

test('the shell holds no data and no human text, links /app.js and /app.css, and has no inline script or style', async () => {
  assert.ok(SHELL_HTML.startsWith('<!doctype html>'));
  assert.match(SHELL_HTML, /<meta charset="utf-8">/);
  assert.match(SHELL_HTML, /<title><\/title>/);
  assert.match(SHELL_HTML, /<link rel="stylesheet" href="\/app\.css">/);
  assert.match(SHELL_HTML, /<script src="\/app\.js" defer><\/script>/);
  assert.match(SHELL_HTML, /<main id="app"><\/main>/);
  // No text between tags: no data, no human text.
  assert.equal(SHELL_HTML.replace(/<!doctype html>/, '').replace(/<[^>]*>/g, '').trim(), '');
  // Every script has a src and an empty body; no <style>, no style= or on* attribute, no javascript: URL.
  for (const m of SHELL_HTML.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    assert.match(m[1] ?? '', /\bsrc="\/app\.js"/);
    assert.equal(m[2], '');
  }
  assert.equal([...SHELL_HTML.matchAll(/<script\b/g)].length, 1);
  assert.ok(!/<style\b|\sstyle=|\son[a-z]+=|javascript:|<base\b|<iframe\b|<object\b|<embed\b|<form\b/i.test(SHELL_HTML));
  assert.ok(/^[\x20-\x7e\n]*$/.test(SHELL_HTML), 'ASCII only');

  assert.deepEqual(staticRoute('/', TEST_ASSETS), { type: 'text/html; charset=utf-8', body: SHELL_HTML });
  assert.deepEqual(staticRoute('/app.js', TEST_ASSETS), { type: 'text/javascript; charset=utf-8', body: TEST_ASSETS.appJs });
  assert.deepEqual(staticRoute('/app.css', TEST_ASSETS), { type: 'text/css; charset=utf-8', body: TEST_ASSETS.appCss });
  assert.equal(staticRoute('/favicon.ico', TEST_ASSETS), 'favicon');
  for (const p of ['', '/index.html', '/APP.JS', '/app.js?x', '__proto__', '/__proto__', 'constructor', '/constructor', 'toString', '/app.css/', '/../app.js']) {
    assert.equal(staticRoute(p, TEST_ASSETS), null, p);
  }
  // Served as it is.
  const s = keep(await startTestServer());
  const r = await request(s.port, { path: '/' });
  assert.equal(r.status, 200);
  assert.equal(r.body.toString('utf8'), SHELL_HTML);
  const js = await request(s.port, { path: '/app.js' });
  assert.equal(js.body.toString('utf8'), TEST_ASSETS.appJs);
});
