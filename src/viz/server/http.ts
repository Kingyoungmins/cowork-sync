// The viewer's loopback HTTP server (12-visualizer §3.10.1–§3.10.5; VIZ-30…VIZ-34; INV-VIZ-AUTH, INV-VIZ-LOOPBACK): one listener on
// the literal 127.0.0.1 with port 0, verified after binding; the §3.10.3 admission in order before routing; the §3.10.4 header set on
// every response, including those Node writes before the handler runs (R-V48); the §3.10.5 routes with their parameter forms. No
// failure answer echoes request data, and nothing of a request (URL, header value, token, Last-Event-ID) is logged.
// The only node:http importer in src/, as a server only (L-VIZ-NET).
import http from 'node:http';
import type { Duplex } from 'node:stream';
import type { Clock } from '../../ports/clock.js';
import { LANGS } from '../../i18n/render.js';
import { clockTimer, type ClockTimer } from './clockTimer.js';
import type { WorldApi } from './models.js';
import { staticRoute } from './shell.js';
import { COMMENT_MS, escapeJson, SSE_BUFFER_MAX, type SseSink, type StreamHub } from './stream.js';
import type { TokenAuthority } from './tokens.js';
import type { SecVizCode, VizLog } from './vizLog.js';

export { escapeJson };

export interface ServerAssets { appJs: string; appCss: string; }
export interface ServerDeps {
  clock: Clock; log: VizLog; hub: StreamHub; tokens: TokenAuthority; api: WorldApi; assets: ServerAssets;
  /** An authenticated request or an open stream. */
  onActivity(): void;
  /** After bye: main exits VIZ_EXIT_LAUNCH_REUSED. */
  onLaunchReused(): void;
}

/** The §3.10.4 value as one line, directives in order, '; ' separated, no trailing ';'. */
export const CSP: string = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "connect-src 'self'", "font-src 'none'",
  "media-src 'none'", "worker-src 'none'", "manifest-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
  "frame-ancestors 'none'", "require-trusted-types-for 'script'", "trusted-types 'none'",
].join('; ');

/** The §3.10.4 set minus Content-Type, in the spec's order. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Security-Policy': CSP,
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Origin-Agent-Cluster': '?1',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), clipboard-read=(), payment=()',
  'X-DNS-Prefetch-Control': 'off',
  'Cache-Control': 'no-store',
});

export const HTTP_LIMITS: Readonly<{ maxHeaderSize: 8_192; maxUrl: 2_048; headersTimeout: 5_000; requestTimeout: 10_000; keepAliveTimeout: 5_000;
                                     connectionsCheckingInterval: 1_000; maxConnections: 32; maxSessionBody: 256 }> = Object.freeze({
  maxHeaderSize: 8_192, maxUrl: 2_048, headersTimeout: 5_000, requestTimeout: 10_000, keepAliveTimeout: 5_000,
  connectionsCheckingInterval: 1_000, maxConnections: 32, maxSessionBody: 256,
});

export interface VizServer { port: number; close(): Promise<void>; }

/** After a raw clientError answer (or a 408 on a stalled body) the socket is drained and destroyed this long after, by the injected
 *  Clock: long enough for the client to read the answer (an immediate destroy with unread input could reset it away), short enough
 *  that half-open clients cannot hold the 32 connection slots. A slot is free once its socket is destroyed. */
export const REAP_MS = 1_000;

/** R-V65(c): once a check found a stream's backlog over SSE_BUFFER_MAX, one more check runs this long after it by the injected Clock,
 *  whether or not anything is written: long enough for a reader that reads to take megabytes over loopback, and well short of the 15 s
 *  comment line, so the first finding is re-measured (cut, or cleared) without waiting for a write. */
export const SSE_RECHECK_MS = 1_000;

/** The part of a ServerResponse a stream sink uses (http.ServerResponse is one; the unit tests drive a fake). */
export interface SseResponse {
  readonly writableLength: number;
  write(chunk: string): boolean;
  end(): void;
  destroy(): void;
  on(event: 'drain', listener: () => void): unknown;
  once(event: 'close', listener: () => void): unknown;
}

/** An SseSink over a stream response, with the backlog cap (R-V65, amending the backpressure ruling; spec-edit list 12 §3.10.5).
 *  The cap measures the live backlog (res.writableLength: the bytes the reader has not taken), never the bytes written within one
 *  tick: a write queues one deferred check per tick (setImmediate: Node has had a chance to flush). A stream is closed, counted
 *  SEC_VIZ_LIMIT once, only when its backlog is above SSE_BUFFER_MAX at two consecutive checks. The first such finding is cleared by
 *  a check at or under the cap, or by the response's 'drain' (the reader took everything, with or without a write after it), so two
 *  bursts separated by a full drain are two first findings. While it stands, ONE re-check runs SSE_RECHECK_MS later by the injected
 *  Clock with no write needed (never an immediate re-poll, which would run before a reader could take anything); a write's check
 *  before then is the second check as well. A drain, a clearing check, the cut or the close cancels the re-check. */
export function cappedSink(res: SseResponse, clock: Clock, log: VizLog): SseSink {
  let ended = false;
  let checkQueued = false;
  let overOnce = false;
  let recheck: ClockTimer | null = null;
  const clearOver = (): void => {
    overOnce = false;
    recheck?.cancel();
    recheck = null;
  };
  const measure = (): void => {
    if (ended) return;
    if (res.writableLength <= SSE_BUFFER_MAX) {
      clearOver();
      return;
    }
    if (!overOnce) {
      overOnce = true;
      recheck = clockTimer(clock, SSE_RECHECK_MS, () => {
        recheck = null;
        measure();
      });
      return;
    }
    clearOver();
    ended = true;
    log.security('SEC_VIZ_LIMIT');
    res.destroy();
  };
  const check = (): void => {
    checkQueued = false;
    measure();
  };
  res.on('drain', clearOver);
  res.once('close', () => {
    ended = true;
    clearOver();
  });
  return {
    write: (chunk) => {
      if (ended) return false;
      const ok = res.write(chunk);
      if (!checkQueued) {
        checkQueued = true;
        setImmediate(check);
      }
      return ok;
    },
    end: () => {
      if (ended) return;
      ended = true;
      res.end();
    },
    onClose: (cb) => { res.once('close', cb); },
  };
}

const JSON_TYPE = 'application/json; charset=utf-8';
const TEXT_TYPE = 'text/plain; charset=utf-8';
const SSE_TYPE = 'text/event-stream; charset=utf-8';
const SESSION_PATH = '/api/v1/session';
const TIMELINE_RE = /^\/api\/v1\/rooms\/(r[0-9A-HJKMNP-TV-Z]{8})\/timeline$/;
const HEIGHT_RE = /^(0|[1-9][0-9]{0,9})$/;
const LOOPBACK_RE = /^(::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** One fixed raw response for clientError (R-V48): the whole header set, an empty body, Connection: close; never err.rawPacket. */
function rawResponse(status: number, reason: string): string {
  const lines = [`HTTP/1.1 ${status} ${reason}`];
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) lines.push(`${k}: ${v}`);
  lines.push(`Content-Type: ${TEXT_TYPE}`, 'Content-Length: 0', 'Connection: close', '', '');
  return lines.join('\r\n');
}
const RAW_400 = rawResponse(400, 'Bad Request');
const RAW_408 = rawResponse(408, 'Request Timeout');
const RAW_431 = rawResponse(431, 'Request Header Fields Too Large');

/** The values of one header in rawHeaders (Node keeps only the first Host; duplicates must be counted here). */
function headerValues(req: http.IncomingMessage, name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    if ((req.rawHeaders[i] as string).toLowerCase() === name) out.push(req.rawHeaders[i + 1] as string);
  }
  return out;
}

/** The header's value when it occurs exactly once, else undefined (a duplicated token header is no token). */
function single(req: http.IncomingMessage, name: string): string | undefined {
  const v = headerValues(req, name);
  return v.length === 1 ? v[0] : undefined;
}

/** `k=v&k=v` with exactly the given keys, each once, values undecoded; else null. */
function queryParams(query: string | null, keys: readonly string[]): Map<string, string> | null {
  if (query === null) return null;
  const out = new Map<string, string>();
  for (const part of query.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) return null;
    const k = part.slice(0, eq);
    if (!keys.includes(k) || out.has(k)) return null;
    out.set(k, part.slice(eq + 1));
  }
  return out.size === keys.length ? out : null;
}

/** An admission or route refusal: status, the registry code of its body (an empty body when the status has none), the security code
 *  it counts, and whether the connection closes after it (always for admission failures: an unread body must not become a request).
 *  Error bodies (ruling R-V66; spec-edit list 12 §3.10.4): {"code"} JSON for 401, 404, 421 and 500 on API and shell paths alike, and an
 *  empty text/plain body for the statuses with no registry code (400, 403, 405, 408, 413, 417, 431). §3.10.4's "one rendered sentence
 *  (shell)" conflicts with §3.10.5 ("anything else" → 404 {"code"}), and the server has no language to render one with. */
interface Refusal { status: number; code: string | null; sec: SecVizCode | null; close: boolean; }

const refusal = (status: number, code: string | null, sec: SecVizCode | null, close = true): Refusal => ({ status, code, sec, close });

/** A §3.10.5 row that takes a session: the timeline row carries its room id. */
type ApiRow = { kind: 'world' } | { kind: 'stream' } | { kind: 'strings' } | { kind: 'timeline'; room: string };

/** http.createServer({ requireHostHeader: false, insecureHTTPParser: false, maxHeaderSize, headersTimeout, requestTimeout, keepAliveTimeout,
 *  connectionsCheckingInterval }) (a value Node 20 takes only as a property is set before listen); a clientError listener writes one fixed
 *  raw response (431 HPE_HEADER_OVERFLOW, 408 ERR_HTTP_REQUEST_TIMEOUT, else 400) with the §3.10.4 set and Connection: close, never
 *  err.rawPacket; checkContinue and checkExpectation run the normal admission (bad Host → 421, no 100; another Expect → 417) (R-V48);
 *  listen({ host: '127.0.0.1', port: 0, exclusive: true }); address() must be { address: '127.0.0.1', family: 'IPv4' } else close +
 *  refuse. The Origin check compares with the template `http://127.0.0.1:${port}` (R-V55). Under /api/ the route (method and path) is
 *  matched before the session is checked, so "anything else" is 404 with no auth check (§3.10.5). After a raw answer the socket is
 *  drained and reaped REAP_MS later; a session body stalled past requestTimeout gets 408 through its response (and only that response),
 *  then the same reap. A stream is closed when its backlog stays above SSE_BUFFER_MAX across two deferred checks (R-V65, cappedSink).
 *  The 15 s comment line is driven from here. Every timer (comment, reap, stream re-check) runs on deps.clock (clockTimer.ts). */
export async function createServer(deps: ServerDeps): Promise<VizServer | { refuse: 'RF_VIZ_BIND_FAILED' }> {
  const { clock, log, hub, tokens, api } = deps;
  const server = http.createServer({
    requireHostHeader: false, insecureHTTPParser: false, maxHeaderSize: HTTP_LIMITS.maxHeaderSize, headersTimeout: HTTP_LIMITS.headersTimeout,
    requestTimeout: HTTP_LIMITS.requestTimeout, keepAliveTimeout: HTTP_LIMITS.keepAliveTimeout,
    connectionsCheckingInterval: HTTP_LIMITS.connectionsCheckingInterval,
  });
  server.headersTimeout = HTTP_LIMITS.headersTimeout;
  server.requestTimeout = HTTP_LIMITS.requestTimeout;
  server.keepAliveTimeout = HTTP_LIMITS.keepAliveTimeout;
  server.maxConnections = HTTP_LIMITS.maxConnections;

  let host = '';
  let origin = '';
  /** Sockets with a response in progress, and that response: a parse error there must not write a second response into the first. */
  const inFlight = new WeakMap<Duplex, http.ServerResponse>();
  /** Sockets whose session POST is waiting for its body (redeem), and its response: the one response a request timeout is answered
   *  through (408). A timeout on a socket with any other response in progress — a pipelined request stalled behind it — is never
   *  written into that response. */
  const waitingForBody = new WeakMap<Duplex, http.ServerResponse>();
  /** Every pending reap, so close() cancels them. */
  const reaps = new Set<ClockTimer>();

  /** Drains the socket's input and destroys it REAP_MS after now by the Clock (a no-op when it is already gone). */
  const reap = (socket: Duplex): void => {
    socket.resume();
    const t = clockTimer(clock, REAP_MS, () => {
      reaps.delete(t);
      socket.destroy();
    });
    reaps.add(t);
    socket.once('close', () => {
      t.cancel();
      reaps.delete(t);
    });
  };

  const send = (res: http.ServerResponse, status: number, type: string, body: string, close: boolean): void => {
    const buf = Buffer.from(body, 'utf8');
    // A 204 has no body and so no Content-Length (RFC 9110 §8.6).
    const length = status === 204 ? {} : { 'Content-Length': String(buf.length) };
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, ...length, ...(close ? { Connection: 'close' } : {}) });
    res.end(status === 204 ? undefined : buf);
  };
  const sendJson = (res: http.ServerResponse, status: number, value: unknown, close = false): void => send(res, status, JSON_TYPE, escapeJson(value), close);
  const refuse = (res: http.ServerResponse, r: Refusal): void => {
    if (r.sec !== null) log.security(r.sec);
    if (r.code === null) send(res, r.status, TEXT_TYPE, '', r.close);
    else sendJson(res, r.status, { code: r.code }, r.close);
  };

  /** §3.10.3 items 1–6, in order. `path` is the target before '?', undecoded. */
  const admit = (req: http.IncomingMessage, path: string): Refusal | 'destroy' | null => {
    const hosts = headerValues(req, 'host');
    if (hosts.length !== 1 || hosts[0] !== host) return refusal(421, 'UI_VIZ_BAD_HOST', 'SEC_VIZ_BAD_HOST');
    const isApi = path.startsWith('/api/');
    const isSessionPost = req.method === 'POST' && path === SESSION_PATH;
    const origins = headerValues(req, 'origin');
    if (origins.length > 1 || (origins.length === 1 && origins[0] !== origin) || (isSessionPost && origins.length === 0)) {
      return refusal(403, null, 'SEC_VIZ_BAD_ORIGIN');
    }
    const sites = headerValues(req, 'sec-fetch-site');
    if (sites.length > 1) return refusal(403, null, 'SEC_VIZ_BAD_ORIGIN');
    const site = sites[0];
    if (site !== undefined && site !== 'same-origin' && (isApi || site !== 'none')) return refusal(403, null, 'SEC_VIZ_BAD_ORIGIN');
    // §3.10.3 item 4: GET and HEAD on every path, POST only on the session route. A GET or HEAD that no §3.10.5 row takes (the
    // session route, HEAD on the session-authenticated routes) is admitted and routed as "anything else": 404.
    const methodOk = req.method === 'GET' || req.method === 'HEAD' || isSessionPost;
    if (!methodOk) return refusal(405, null, 'SEC_VIZ_METHOD');
    const url = req.url ?? '';
    if (url.length > HTTP_LIMITS.maxUrl || !url.startsWith('/')) return refusal(400, null, 'SEC_VIZ_LIMIT');
    const te = req.headers['transfer-encoding'];
    const cl = req.headers['content-length'];
    if (isSessionPost) {
      if (cl !== undefined && Number(cl) > HTTP_LIMITS.maxSessionBody) return refusal(413, null, 'SEC_VIZ_LIMIT');
    } else if (te !== undefined || (cl !== undefined && cl !== '0')) {
      return refusal(400, null, 'SEC_VIZ_LIMIT');
    }
    if (!LOOPBACK_RE.test(req.socket.remoteAddress ?? '')) return 'destroy';
    return null;
  };

  /** Reads the session POST body up to the cap (chunked bodies are counted as they arrive). */
  const readBody = (req: http.IncomingMessage): Promise<'ok' | 'too_large' | 'aborted'> => new Promise((resolve) => {
    let size = 0;
    const done = (r: 'ok' | 'too_large' | 'aborted'): void => {
      req.removeAllListeners('data');
      resolve(r);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > HTTP_LIMITS.maxSessionBody) done('too_large');
    });
    req.once('end', () => done('ok'));
    req.once('error', () => done('aborted'));
    req.once('close', () => done('aborted'));
  });

  const redeem = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const socket = req.socket;
    waitingForBody.set(socket, res);
    const body = await readBody(req);
    if (waitingForBody.get(socket) === res) waitingForBody.delete(socket);
    // Aborted, or already answered 408 (a body that stalled past requestTimeout, clientError below): nothing is redeemed.
    if (body === 'aborted' || res.headersSent) return;
    if (body === 'too_large') return refuse(res, refusal(413, null, 'SEC_VIZ_LIMIT'));
    const r = tokens.redeem(single(req, 'x-cowork-launch'));
    if (r.ok) {
      deps.onActivity();
      return sendJson(res, 200, { session: r.session, instance: r.instance });
    }
    if (r.why === 'expired') return refuse(res, refusal(401, 'UI_VIZ_LINK_EXPIRED', 'SEC_VIZ_LAUNCH_EXPIRED', false));
    if (r.why !== 'reused') return refuse(res, refusal(401, 'UI_VIZ_NEED_LINK', 'SEC_VIZ_BAD_TOKEN', false));
    // Reuse ends the viewer (§3.10.2): the presenting page gets UI_VIZ_LINK_REUSED, every stream gets bye, the event is logged at
    // once, and main is told once this response has left.
    let told = false;
    const tell = (): void => {
      if (told) return;
      told = true;
      deps.onLaunchReused();
    };
    res.once('finish', tell);
    res.once('close', tell);
    sendJson(res, 401, { code: 'UI_VIZ_LINK_REUSED' }, true);
    hub.close();
    log.security('SEC_VIZ_LAUNCH_REUSED');
  };

  const stream = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': SSE_TYPE });
    res.flushHeaders();
    hub.attach(cappedSink(res, clock, log), single(req, 'last-event-id'));
  };

  const notFound = (res: http.ServerResponse): void => sendJson(res, 404, { code: 'UI_VIZ_NOT_FOUND' });

  /** The §3.10.5 session-authenticated row a request takes, by method and path alone (the room id's form is part of its path);
   *  null for "anything else". The query is a parameter of the row, checked after the session. */
  const apiRow = (method: string | undefined, path: string): ApiRow | null => {
    // Those rows are GET rows: a HEAD is "anything else" (and never attaches a stream).
    if (method !== 'GET') return null;
    if (path === '/api/v1/world') return { kind: 'world' };
    if (path === '/api/v1/stream') return { kind: 'stream' };
    if (path === '/api/v1/strings') return { kind: 'strings' };
    const m = TIMELINE_RE.exec(path);
    return m === null ? null : { kind: 'timeline', room: m[1] as string };
  };

  const routeApi = async (req: http.IncomingMessage, res: http.ServerResponse, row: ApiRow, query: string | null): Promise<void> => {
    if (!tokens.checkSession(single(req, 'x-cowork-session'))) return refuse(res, refusal(401, 'UI_VIZ_NEED_LINK', 'SEC_VIZ_BAD_TOKEN', false));
    deps.onActivity();
    switch (row.kind) {
      case 'world':
        return query === null ? sendJson(res, 200, await api.world()) : notFound(res);
      case 'stream':
        return query === null ? stream(req, res) : notFound(res);
      case 'strings': {
        const q = queryParams(query, ['lang']);
        if (q === null) return refuse(res, refusal(400, null, null, false));
        const lang = q.get('lang') as string;
        const strings = (LANGS as readonly string[]).includes(lang) ? api.strings(lang) : null;
        return strings === null ? notFound(res) : sendJson(res, 200, strings);
      }
      case 'timeline': {
        const q = queryParams(query, ['from', 'to']);
        const from = q?.get('from');
        const to = q?.get('to');
        if (from === undefined || to === undefined || !HEIGHT_RE.test(from) || !HEIGHT_RE.test(to)) return refuse(res, refusal(400, null, null, false));
        const page = await api.page(row.room, Number(from), Number(to));
        return page === null ? notFound(res) : sendJson(res, 200, page);
      }
    }
  };

  const route = async (req: http.IncomingMessage, res: http.ServerResponse, path: string, query: string | null): Promise<void> => {
    // The session route's only row is POST (its auth is the launch token); a GET or HEAD there is "anything else".
    if (path === SESSION_PATH) return req.method === 'POST' ? redeem(req, res) : notFound(res);
    if (path.startsWith('/api/')) {
      // §3.10.5: route matching comes before the session check, so "anything else" under /api/ is 404 with no auth check.
      const row = apiRow(req.method, path);
      return row === null ? notFound(res) : routeApi(req, res, row, query);
    }
    const s = query === null ? staticRoute(path, deps.assets) : null;
    if (s === null) return notFound(res);
    if (s === 'favicon') return send(res, 204, TEXT_TYPE, '', false);
    return send(res, 200, s.type, s.body, false);
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse, phase: 'request' | 'continue' | 'expectation'): Promise<void> => {
    res.sendDate = false;
    const socket = req.socket;
    inFlight.set(socket, res);
    res.once('close', () => { if (inFlight.get(socket) === res) inFlight.delete(socket); });
    try {
      if (req.headers.upgrade !== undefined) {
        log.security('SEC_VIZ_METHOD');
        req.socket.destroy();
        return;
      }
      const target = req.url ?? '';
      const q = target.indexOf('?');
      const path = q < 0 ? target : target.slice(0, q);
      const query = q < 0 ? null : target.slice(q + 1);
      const verdict = admit(req, path);
      if (verdict === 'destroy') {
        req.socket.destroy();
        return;
      }
      if (verdict !== null) return refuse(res, verdict);
      if (phase === 'expectation') return send(res, 417, TEXT_TYPE, '', true);
      if (phase === 'continue') res.writeContinue();
      await route(req, res, path, query);
    } catch (err) {
      log.error('UI_INTERNAL_ERROR', err);
      if (res.headersSent) res.destroy();
      else sendJson(res, 500, { code: 'UI_INTERNAL_ERROR' }, true);
    }
  };

  server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => { void handle(req, res, 'request'); });
  server.on('checkContinue', (req: http.IncomingMessage, res: http.ServerResponse) => { void handle(req, res, 'continue'); });
  server.on('checkExpectation', (req: http.IncomingMessage, res: http.ServerResponse) => { void handle(req, res, 'expectation'); });
  server.on('clientError', (err: Error & { code?: string }, socket: Duplex) => {
    // A reset or an already closed socket (the parser's EOF echo of our own answer): nothing to answer.
    if (err.code === 'ECONNRESET' || !socket.writable) {
      socket.destroy();
      return;
    }
    const timeout = err.code === 'ERR_HTTP_REQUEST_TIMEOUT';
    // A session body that stalled past requestTimeout (redeem waits for it; its response not started) is answered 408 through that
    // response.
    const waiting = waitingForBody.get(socket);
    if (timeout && waiting !== undefined && !waiting.headersSent) {
      log.security('SEC_VIZ_LIMIT');
      send(waiting, 408, TEXT_TYPE, '', true);
      reap(socket);
      return;
    }
    // Any other response in progress: an error must not write a second response into it, whether its headers are sent or not.
    if (inFlight.has(socket)) {
      socket.destroy();
      return;
    }
    // A socket that never sent a byte and timed out is an idle preconnect (browsers open them speculatively): answered, not counted.
    if (!(timeout && (socket as Duplex & { bytesRead?: number }).bytesRead === 0)) log.security('SEC_VIZ_LIMIT');
    socket.end(err.code === 'HPE_HEADER_OVERFLOW' ? RAW_431 : timeout ? RAW_408 : RAW_400);
    reap(socket);
  });
  // HTTP/1.1 only: an upgrade or a CONNECT destroys the socket.
  const destroy = (_req: http.IncomingMessage, socket: Duplex): void => {
    log.security('SEC_VIZ_METHOD');
    socket.destroy();
  };
  server.on('upgrade', destroy);
  server.on('connect', destroy);

  const closeServer = (): Promise<void> => new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });

  const bound = await new Promise<boolean>((resolve) => {
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => resolve(true));
  });
  const a = bound ? server.address() : null;
  if (a === null || typeof a === 'string' || a.address !== '127.0.0.1' || a.family !== 'IPv4') {
    await closeServer();
    return { refuse: 'RF_VIZ_BIND_FAILED' };
  }
  // A listener error after binding (an accept failure) is logged, never thrown into the process.
  server.on('error', (err) => log.error('UI_INTERNAL_ERROR', err));
  const port = a.port;
  host = `127.0.0.1:${port}`;
  origin = `http://127.0.0.1:${port}`;
  // A comment line to every stream every 15 s of the injected Clock (Δmono); this server owns the only such timer.
  let commentTimer: ClockTimer;
  const comment = (): void => {
    hub.comment();
    commentTimer = clockTimer(clock, COMMENT_MS, comment);
  };
  commentTimer = clockTimer(clock, COMMENT_MS, comment);
  let closing: Promise<void> | null = null;
  return {
    port,
    close: () => {
      if (closing === null) {
        commentTimer.cancel();
        for (const t of reaps) t.cancel();
        reaps.clear();
        closing = closeServer();
      }
      return closing;
    },
  };
}
