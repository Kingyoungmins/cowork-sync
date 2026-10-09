// The listener (12 §3.10.1; VIZ-30) and the launch token over real loopback HTTP (12 §3.10.2; VIZ-31, INV-VIZ-AUTH).
import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { realFs } from '../../../src/ports/fs.js';
import { seededRandom } from '../../../src/ports/random.js';
import { createServer, type VizServer } from '../../../src/viz/server/http.js';
import { StreamHub } from '../../../src/viz/server/stream.js';
import { LAUNCH_TTL_MS, TokenAuthority } from '../../../src/viz/server/tokens.js';
import { openVizLog, type VizLog } from '../../../src/viz/server/vizLog.js';
import { makeTempRoot } from '../../helpers/tmp.js';
import { openStream, RecordingLog, request, startTestServer, stubApi, TEST_ASSETS } from '../../helpers/vizHttp.js';
import { VirtualClock } from '../../sim/vclock.js';

const cleanups: Array<() => Promise<void>> = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

const json = (b: Buffer): unknown => JSON.parse(b.toString('utf8'));

test('the listener binds 127.0.0.1 port 0 exclusively and verifies address(); any other bound address closes and refuses RF_VIZ_BIND_FAILED', async () => {
  const listen = mock.method(http.Server.prototype, 'listen');
  try {
    const s = await startTestServer();
    cleanups.push(() => s.close());
    assert.equal(listen.mock.callCount(), 1);
    assert.deepEqual(listen.mock.calls[0]?.arguments[0], { host: '127.0.0.1', port: 0, exclusive: true });
    assert.ok(Number.isInteger(s.port) && s.port > 0);
    assert.equal((await request(s.port, { path: '/' })).status, 200);
  } finally {
    listen.mock.restore();
  }
  for (const fake of [{ address: '0.0.0.0', family: 'IPv4', port: 40_000 }, { address: '::1', family: 'IPv6', port: 40_000 }]) {
    const address = mock.method(http.Server.prototype, 'address', () => fake);
    const close = mock.method(http.Server.prototype, 'close');
    try {
      const clock = new VirtualClock();
      const hub = new StreamHub(clock);
      const r = await createServer({
        clock, log: new RecordingLog(), hub, tokens: new TokenAuthority(seededRandom('bind'), clock), api: stubApi(hub), assets: TEST_ASSETS,
        onActivity: () => {}, onLaunchReused: () => {},
      });
      assert.deepEqual(r, { refuse: 'RF_VIZ_BIND_FAILED' }, `refused for ${fake.address}`);
      assert.equal(close.mock.callCount(), 1, 'the real listener is closed');
      assert.equal((close.mock.calls[0]?.this as http.Server).listening, false);
    } finally {
      address.mock.restore();
      close.mock.restore();
    }
  }
});

test('T-VIZ-launch: redeem once → 200 {session, instance}; again → 401 UI_VIZ_LINK_REUSED, bye on the first session\'s stream, SEC_VIZ_LAUNCH_REUSED logged at once, onLaunchReused called; at 121 s own staleness → 401 UI_VIZ_LINK_EXPIRED and SEC_VIZ_LAUNCH_EXPIRED; a session POST without Origin → 403', async () => {
  const tmp = await makeTempRoot('viz-launch');
  cleanups.push(tmp.cleanup);
  const clock = new VirtualClock();
  const logDir = join(tmp.root, 'log');
  const fileLog = await openVizLog({ fs: realFs, clock, dir: logDir, instance: 'AAAA0001' });
  // The order of the reuse steps is recorded: the 401 leaving, bye, the log line and main's callback.
  const order: string[] = [];
  let reusedResponse: http.ServerResponse | null = null;
  const log: VizLog = {
    write: (c, p) => fileLog.write(c, p),
    security: (c) => { order.push(c); fileLog.security(c); },
    error: (c, e) => fileLog.error(c, e),
    flush: () => fileLog.flush(),
  };
  const s = await startTestServer({
    clock, log, seed: 'launch',
    onLaunchReused: () => { order.push(`onLaunchReused, the 401 finished: ${String(reusedResponse?.writableFinished)}`); },
  });
  cleanups.push(() => s.close());
  const hubClose = mock.method(s.hub, 'close', function (this: StreamHub): void {
    order.push('bye');
    StreamHub.prototype.close.call(this);
  });
  const originalEnd = http.ServerResponse.prototype.end;
  const end = mock.method(http.ServerResponse.prototype, 'end', function (this: http.ServerResponse, ...args: unknown[]): unknown {
    const out = (originalEnd as (...a: unknown[]) => unknown).apply(this, args);
    if (this.statusCode === 401) {
      reusedResponse = this;
      order.push('401 sent');
    }
    return out;
  });
  const post = (headers: Record<string, string>): ReturnType<typeof request> =>
    request(s.port, { method: 'POST', path: '/api/v1/session', headers });

  // No Origin on the redemption POST: 403, and the token stays unredeemed.
  const noOrigin = await post({ 'x-cowork-launch': s.tokens.launch });
  assert.equal(noOrigin.status, 403);
  assert.equal(s.tokens.redeemed(), false);
  // A wrong or missing launch token: 401 UI_VIZ_NEED_LINK.
  const wrong: Array<Record<string, string>> = [{}, { 'x-cowork-launch': 'f'.repeat(64) }, { 'x-cowork-launch': s.tokens.launch.toUpperCase() }];
  for (const bad of wrong) {
    const r = await post({ origin: s.origin, ...bad });
    assert.equal(r.status, 401);
    assert.deepEqual(json(r.body), { code: 'UI_VIZ_NEED_LINK' });
  }
  assert.equal(s.tokens.redeemed(), false);

  const ok = await post({ origin: s.origin, 'x-cowork-launch': s.tokens.launch });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['content-type'], 'application/json; charset=utf-8');
  const session = json(ok.body) as { session: string; instance: string };
  assert.deepEqual(Object.keys(session).sort(), ['instance', 'session']);
  assert.match(session.session, /^[0-9a-f]{64}$/);
  assert.equal(session.instance, s.tokens.instance);
  assert.match(session.instance, /^[0-9A-HJKMNP-TV-Z]{8}$/);
  const activityAfterRedeem = s.activity();
  assert.ok(activityAfterRedeem >= 1, 'a redemption is activity');

  const stream = await openStream(s.port, { 'x-cowork-session': session.session, 'last-event-id': '0' });
  assert.equal(stream.status, 200);
  assert.equal(s.hub.open(), 1);
  assert.equal(s.reused(), 0);

  order.length = 0;
  const again = await post({ origin: s.origin, 'x-cowork-launch': s.tokens.launch });
  assert.equal(again.status, 401);
  assert.deepEqual(json(again.body), { code: 'UI_VIZ_LINK_REUSED' });
  const bye = await stream.waitFor((m) => m.event === 'bye');
  assert.deepEqual(bye.data, { type: 'bye' });
  await stream.ended;
  assert.equal(s.hub.open(), 0);
  for (let i = 0; i < 50 && s.reused() === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.reused(), 1, 'onLaunchReused once');
  // 12 §3.10.2: the presenting page gets its 401, every stream gets bye, the event is logged, and only then is main told to exit —
  // after the 401 has fully left, so the page sees UI_VIZ_LINK_REUSED and not a dropped connection.
  assert.deepEqual(order, ['401 sent', 'bye', 'SEC_VIZ_LAUNCH_REUSED', 'onLaunchReused, the 401 finished: true']);
  hubClose.mock.restore();
  end.mock.restore();
  // The session minted from the reused token is revoked.
  const revoked = await request(s.port, { path: '/api/v1/world', headers: { 'x-cowork-session': session.session } });
  assert.equal(revoked.status, 401);
  assert.deepEqual(json(revoked.body), { code: 'UI_VIZ_NEED_LINK' });
  // SEC_VIZ_LAUNCH_REUSED is written at once, while the earlier codes still sit in their 60 s windows (no time has passed).
  const logFile = join(logDir, 'viz-AAAA0001-1.jsonl');
  const readLines = (): Array<{ code: string; count?: number }> => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '')
    .split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as { code: string; count?: number });
  for (let i = 0; i < 100 && readLines().length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(readLines(), [{ t: 0, code: 'SEC_VIZ_LAUNCH_REUSED', count: 1 }]);
  await log.flush();
  assert.deepEqual(readLines().slice(1), [
    { t: 0, code: 'SEC_VIZ_BAD_ORIGIN', count: 1 },
    { t: 0, code: 'SEC_VIZ_BAD_TOKEN', count: 4 },
  ], 'the aggregated windows close on flush, one line each with its count');
  const text = readFileSync(logFile, 'utf8');
  assert.ok(!text.includes(s.tokens.launch) && !text.includes(session.session), 'no token in the log');

  // Expiry: a suspend gap (wall advances, mono does not) counts toward the TTL.
  const vclock = new VirtualClock();
  const rec = new RecordingLog();
  const e = await startTestServer({ clock: vclock, log: rec, seed: 'expired' });
  cleanups.push(() => e.close());
  vclock.suspend(LAUNCH_TTL_MS + 1_000);
  const expired = await request(e.port, { method: 'POST', path: '/api/v1/session', headers: { origin: e.origin, 'x-cowork-launch': e.tokens.launch } });
  assert.equal(expired.status, 401);
  assert.deepEqual(json(expired.body), { code: 'UI_VIZ_LINK_EXPIRED' });
  assert.equal(rec.count('SEC_VIZ_LAUNCH_EXPIRED'), 1);
  assert.equal(e.reused(), 0);
  assert.equal(e.tokens.redeemed(), false);
});

test('createServer close() ends open connections and frees the port', async () => {
  const s = await startTestServer();
  const session = await s.session();
  const stream = await openStream(s.port, { 'x-cowork-session': session, 'last-event-id': '0' });
  const server: VizServer = s.server;
  await server.close();
  await stream.ended;
  await assert.rejects(request(s.port, { path: '/' }));
});
