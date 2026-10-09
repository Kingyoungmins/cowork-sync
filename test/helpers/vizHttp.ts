// HTTP helpers for the viewer server tests (12 §3.10): rawRequest writes exact bytes over node:net (admission and Node's own
// responses), request/openStream use the node:http client for ordinary requests, and startTestServer runs createServer over a
// VirtualClock, a seeded Random, a stub WorldApi and a recording log.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGS } from '../../src/i18n/render.js';
import { seededRandom } from '../../src/ports/random.js';
import { createServer, type ServerAssets, type VizServer } from '../../src/viz/server/http.js';
import type { WorldApi } from '../../src/viz/server/models.js';
import { StreamHub } from '../../src/viz/server/stream.js';
import { TokenAuthority } from '../../src/viz/server/tokens.js';
import type { SceneVM, World } from '../../src/viz/server/viewModel.js';
import { nullVizLog, type SecVizCode, type VizLog, type VizLogParam } from '../../src/viz/server/vizLog.js';
import { VirtualClock } from '../sim/vclock.js';

const RAW_TIMEOUT_MS = 15_000;

/** One response read from a raw socket. status 0: the server closed the connection without a response. */
export interface RawResponse { status: number; headers: Array<[string, string]>; body: Buffer; }

/**
 * Sends exactly `bytes` (a string is written as latin1, one byte per character) to 127.0.0.1:<port> over a fresh node:net socket
 * and reads the first response: status line, headers in order (duplicates kept), body by Content-Length (none for HEAD, 1xx, 204
 * and 304), else until close. A 100 Continue is returned as such. The socket is destroyed afterwards.
 */
export function rawRequest(port: number, bytes: string | Buffer): Promise<RawResponse> {
  const out = typeof bytes === 'string' ? Buffer.from(bytes, 'latin1') : bytes;
  const isHead = out.subarray(0, 5).toString('latin1') === 'HEAD ';
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (r: RawResponse): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      sock.destroy();
      reject(new Error(`rawRequest: no complete response within ${RAW_TIMEOUT_MS} ms`));
    }, RAW_TIMEOUT_MS);
    const parse = (closed: boolean): void => {
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) {
        if (closed) finish({ status: 0, headers: [], body: buf });
        return;
      }
      const head = buf.subarray(0, end).toString('latin1').split('\r\n');
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(head[0] ?? '');
      const status = m === null ? 0 : Number(m[1]);
      const headers = head.slice(1).map((l): [string, string] => {
        const i = l.indexOf(':');
        return [l.slice(0, i), l.slice(i + 1).trim()];
      });
      const rest = buf.subarray(end + 4);
      if (isHead || status < 200 || status === 204 || status === 304) {
        finish({ status, headers, body: Buffer.alloc(0) });
        return;
      }
      const cl = headers.find(([k]) => k.toLowerCase() === 'content-length');
      if (cl !== undefined && rest.length >= Number(cl[1])) finish({ status, headers, body: rest.subarray(0, Number(cl[1])) });
      else if (closed) finish({ status, headers, body: rest });
    };
    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      parse(false);
    });
    sock.on('end', () => parse(true));
    sock.on('close', () => parse(true));
    sock.on('error', () => parse(true));
    sock.write(out);
  });
}

export interface HttpResponse { status: number; headers: http.IncomingHttpHeaders; rawHeaders: string[]; body: Buffer; }

/** One request with the node:http client (Host is 127.0.0.1:<port>; no agent, so the connection closes after it). */
export function request(port: number, o: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer }): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.path, headers: o.headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(o.body);
  });
}

export interface SseMessage { id: number | null; event: string | null; data: unknown; comment: boolean; }

/** An open GET /api/v1/stream: every SSE message received so far, a wait for one matching, and the end of the stream. */
export interface OpenStream {
  status: number;
  headers: http.IncomingHttpHeaders;
  messages(): SseMessage[];
  waitFor(pred: (m: SseMessage) => boolean, timeoutMs?: number): Promise<SseMessage>;
  ended: Promise<void>;
  close(): void;
}

export function openStream(port: number, headers: Record<string, string>): Promise<OpenStream> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/api/v1/stream', headers, agent: false }, (res) => {
      let text = '';
      const waiters: Array<() => void> = [];
      let endedResolve: () => void = () => {};
      const ended = new Promise<void>((r) => { endedResolve = r; });
      const parse = (): SseMessage[] => text.split('\n\n').slice(0, -1).map((block): SseMessage => {
        if (block === ': ') return { id: null, event: null, data: null, comment: true };
        const m: SseMessage = { id: null, event: null, data: null, comment: false };
        for (const line of block.split('\n')) {
          if (line.startsWith('id: ')) m.id = Number(line.slice(4));
          else if (line.startsWith('event: ')) m.event = line.slice(7);
          else if (line.startsWith('data: ')) m.data = JSON.parse(line.slice(6)) as unknown;
        }
        return m;
      });
      res.setEncoding('utf8');
      res.on('data', (d: string) => {
        text += d;
        for (const w of waiters.splice(0)) w();
      });
      res.on('end', () => { endedResolve(); for (const w of waiters.splice(0)) w(); });
      res.on('close', () => { endedResolve(); for (const w of waiters.splice(0)) w(); });
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        messages: parse,
        ended,
        close: () => req.destroy(),
        waitFor: (pred, timeoutMs = 5_000) => new Promise((ok, fail) => {
          const t = setTimeout(() => fail(new Error('openStream: no matching message in time')), timeoutMs);
          const check = (): void => {
            const hit = parse().find(pred);
            if (hit !== undefined) {
              clearTimeout(t);
              ok(hit);
            } else waiters.push(check);
          };
          check();
        }),
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** A VizLog that records every call and refuses what a file log refuses (it checks through nullVizLog). */
export class RecordingLog implements VizLog {
  readonly writes: Array<{ code: string; params: Readonly<Record<string, VizLogParam>> | undefined }> = [];
  readonly securities: SecVizCode[] = [];
  readonly errors: Array<{ code: string; err: unknown }> = [];
  security(code: SecVizCode): void {
    this.securities.push(code);
  }
  write(code: string, params?: Readonly<Record<string, VizLogParam>>): void {
    nullVizLog.write(code, params);
    this.writes.push({ code, params });
  }
  error(code: string, err: unknown): void {
    nullVizLog.error(code, err);
    this.errors.push({ code, err });
  }
  async flush(): Promise<void> {}
  count(code: SecVizCode): number {
    return this.securities.filter((c) => c === code).length;
  }
}

/** A valid room id of the stub world. */
export const TEST_ROOM = 'rABCDEFGH';

export function emptySceneVM(h: number): SceneVM {
  return { at: [h, 0, 0], badge: 'none', branchMovedAt: null, characters: [], pets: [], desks: [], claims: [], requests: [], boxes: [], bangs: [], beat: [] };
}

/** world(): an empty world at the hub's cursor; page(): TEST_ROOM with from ≤ to; strings(): the six codes → { lang: 'en' }. */
export function stubApi(hub: StreamHub, over: Partial<WorldApi> = {}): WorldApi {
  return {
    world: async (): Promise<World> => ({ v: 1, cursor: hub.seq(), demo: false, rooms: [], captions: [] }),
    page: async (roomId, from, to) => (roomId === TEST_ROOM && from <= to
      ? { room_id: TEST_ROOM, from, to, scene: emptySceneVM(from), events: [], cards: [], layout: null } : null),
    strings: (lang) => ((LANGS as readonly string[]).includes(lang) ? { lang: 'en', templates: {} } : null),
    ...over,
  };
}

export const TEST_ASSETS: ServerAssets = { appJs: 'console.log(1);\n', appCss: 'main{display:block}\n' };

export interface TestServer {
  server: VizServer; port: number; host: string; origin: string;
  hub: StreamHub; tokens: TokenAuthority; clock: VirtualClock; log: VizLog;
  activity(): number; reused(): number;
  /** Redeems the launch token (POST /api/v1/session with the viewer Origin) and returns the session token. */
  session(): Promise<string>;
  close(): Promise<void>;
}

export async function startTestServer(o: {
  api?: (hub: StreamHub) => WorldApi; log?: VizLog; clock?: VirtualClock; seed?: string; assets?: ServerAssets; onLaunchReused?: () => void;
} = {}): Promise<TestServer> {
  const clock = o.clock ?? new VirtualClock();
  const hub = new StreamHub(clock);
  const tokens = new TokenAuthority(seededRandom(o.seed ?? 'viz-http'), clock);
  const log = o.log ?? new RecordingLog();
  let activity = 0;
  let reused = 0;
  const r = await createServer({
    clock, log, hub, tokens, api: (o.api ?? stubApi)(hub), assets: o.assets ?? TEST_ASSETS,
    onActivity: () => { activity++; }, onLaunchReused: () => { reused++; o.onLaunchReused?.(); },
  });
  if ('refuse' in r) throw new Error(`createServer refused: ${r.refuse}`);
  const port = r.port;
  const origin = `http://127.0.0.1:${port}`;
  return {
    server: r, port, host: `127.0.0.1:${port}`, origin, hub, tokens, clock, log,
    activity: () => activity, reused: () => reused,
    session: async () => {
      const res = await request(port, { method: 'POST', path: '/api/v1/session', headers: { origin, 'x-cowork-launch': tokens.launch } });
      if (res.status !== 200) throw new Error(`redemption answered ${res.status}`);
      return (JSON.parse(res.body.toString('utf8')) as { session: string }).session;
    },
    close: () => r.close(),
  };
}


const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * The 12 §3.10.4 header set as the spec writes it (its code block; a line that starts with white space continues the previous one,
 * joined with one space), Content-Type excepted: [name, value] pairs.
 */
export function specHeaderSet(): Array<[string, string]> {
  const text = readFileSync(join(ROOT, 'docs', 'spec', '12-visualizer.md'), 'utf8').split('\r\n').join('\n');
  const at = text.indexOf('#### 3.10.4');
  const open = text.indexOf('```\n', at) + 4;
  const block = text.slice(open, text.indexOf('```', open));
  const joined: string[] = [];
  for (const line of block.split('\n')) {
    if (line === '') continue;
    if (/^\s/.test(line)) joined[joined.length - 1] = `${joined[joined.length - 1] ?? ''} ${line.trim()}`;
    else joined.push(line);
  }
  return joined.map((l): [string, string] => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()])
    .filter(([k]) => k !== 'Content-Type');
}

const FORBIDDEN_HEADERS = ['set-cookie', 'www-authenticate', 'server', 'etag', 'last-modified', 'x-powered-by'];

/** Every §3.10.4 header exactly once with the spec's value (the CSP byte-equal to its one-line form), one Content-Type ending in
 *  "; charset=utf-8", and none of Set-Cookie, WWW-Authenticate, Access-Control-*, Server, ETag, Last-Modified, X-Powered-By. */
export function assertSecurityHeaders(headers: Array<[string, string]>, what: string): void {
  const lower = headers.map(([k, v]): [string, string] => [k.toLowerCase(), v]);
  for (const [name, value] of specHeaderSet()) {
    const got = lower.filter(([k]) => k === name.toLowerCase());
    assert.equal(got.length, 1, `${what}: one ${name}`);
    assert.equal(got[0]?.[1], value, `${what}: ${name}`);
  }
  const types = lower.filter(([k]) => k === 'content-type');
  assert.equal(types.length, 1, `${what}: one Content-Type`);
  assert.match(types[0]?.[1] ?? '', /^[a-z]+\/[a-z-]+; charset=utf-8$/, `${what}: Content-Type`);
  for (const [k] of lower) {
    assert.ok(!FORBIDDEN_HEADERS.includes(k) && !k.startsWith('access-control-'), `${what}: no ${k}`);
  }
}

/** rawHeaders (name, value, name, value, …) as pairs. */
export function pairs(rawHeaders: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) out.push([rawHeaders[i] as string, rawHeaders[i + 1] as string]);
  return out;
}
