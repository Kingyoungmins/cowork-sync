// The page's connection state machine (12 §3.2 items 5 and 11, §3.10.2 "Redemption", §3.10.5 "Stream ids and resume"; VIZ-31,
// VIZ-34, VIZ-42; R-V49): redeem the launch token once (or reuse the tab's stored session), load the world, then read the stream
// from the world's cursor; a broken stream retries with Last-Event-ID after 1 s doubling to 30 s, then reloads the world, then
// stops; a layout gap, a room added and a reset reload the world; bye stops. Every request names an ApiRoute, never a path
// (V8, L-VIZ-DOM: client/api.ts maps each route to one literal fetch). Pure and DOM-free (R-V33): the page passes the I/O.
import type { Lang } from '../../i18n/render.js';
import type { StreamPayload, World } from '../server/viewModel.js';
import { createSseParser, type SseEvent } from './sse.js';

export type ConnState = 'booting' | 'live' | 'reconnecting' | 'stopped' | 'link_reused' | 'link_expired' | 'need_link';
/** V8/S11: one route per literal fetch in client/api.ts (L-VIZ-DOM: a fetch's first argument is a literal or a template with a literal /api/v1/ head). */
export type ApiRoute = { r: 'session' } | { r: 'world' } | { r: 'strings'; lang: Lang } | { r: 'timeline'; room: string; from: number; to: number };
export interface ConnIo {
  request(route: ApiRoute, init: { method: 'GET' | 'POST'; headers: Record<string, string> }): Promise<{ status: number; json: unknown }>;
  stream(headers: Record<string, string>): Promise<{ status: number; read(): Promise<string | null>; cancel(): void }>;
  timer(ms: number, f: () => void): () => void;
  storage: { get(): { session: string | null; room: string | null }; set(v: { session?: string; room?: string }): void; clear(): void };   // sessionStorage, try/catch
}
export const RETRY_START_MS = 1_000, RETRY_MAX_MS = 30_000;
/** A stream works once a well-formed message arrives, or once it has stayed open this long — as long as the longest retry gap —
 *  even in a quiet room (the server's 15 s comment lines are dropped by the parser); only a break after that is a new one. */
export const STREAM_STABLE_MS = 30_000;

type Terminal = 'stopped' | 'link_reused' | 'link_expired' | 'need_link';
type StreamHandle = Awaited<ReturnType<ConnIo['stream']>>;
/** What the failure of an attempt to open the stream (or of a stream that broke before it worked) means: 'fresh' — the attempt
 *  followed a world load, or the stream had worked: a new backoff from 1 s; a number — the retry made after that many ms failed:
 *  double it (up to 30 s), and after the 30 s one reload the world; 'last' — that world reload's stream failed: stopped. */
type Attempt = 'fresh' | 'last' | number;

const HEX64 = /^[0-9a-f]{64}$/;
const EVENT_ID = /^(0|[1-9][0-9]{0,15})$/;                // 12 §3.10.5: the Last-Event-ID shape
const PAYLOAD_TYPES: ReadonlySet<string> = new Set(['timeline', 'room_snapshot', 'layout', 'overlay', 'room', 'reset', 'bye']);
const ROOMLESS: ReadonlySet<string> = new Set(['reset', 'bye']);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const codeOf = (json: unknown): string | null => (isObject(json) && typeof json['code'] === 'string' ? json['code'] : null);

/** The fields the connection itself reads: the cursor and every room's id and layout version. */
function isWorld(v: unknown): v is World {
  if (!isObject(v) || !isCount(v['cursor']) || !Array.isArray(v['rooms'])) return false;
  return v['rooms'].every((r: unknown) => isObject(r) && typeof r['room_id'] === 'string' && isObject(r['layout']) && isCount(r['layout']['version']));
}
/** A stream message's JSON: a known type, a room id where the type has one, and a layout delta's two versions. */
function isPayload(v: unknown): v is StreamPayload {
  if (!isObject(v) || typeof v['type'] !== 'string' || !PAYLOAD_TYPES.has(v['type'])) return false;
  if (ROOMLESS.has(v['type'])) return true;
  if (typeof v['room_id'] !== 'string') return false;
  if (v['type'] === 'layout') return isObject(v['layout']) && isCount(v['layout']['version']) && isCount(v['layout']['from_version']);
  if (v['type'] === 'room') return typeof v['change'] === 'string';
  return true;
}

/** A page callback that throws is reported as an uncaught error and never breaks the connection. */
function deliver(f: () => void): void {
  try {
    f();
  } catch (e) {
    queueMicrotask(() => { throw e; });
  }
}

export class Connection {
  private state: ConnState = 'booting';
  private started = false;
  private session: string | null = null;
  private lastId = 0;                                     // the next Last-Event-ID: the world's cursor, then the last id received
  private versions = new Map<string, number>();           // room id → its layout version (R-V49)
  private gen = 0;                                        // bumped whenever the current step is superseded: its awaits are then ignored
  private stream: StreamHandle | null = null;
  private attempt: Attempt = 'fresh';                     // the current stream's attempt, 'fresh' once it worked
  private cancelTimer: (() => void) | null = null;        // the retry timer
  private cancelStable: (() => void) | null = null;       // the current stream's STREAM_STABLE_MS timer

  constructor(private readonly io: ConnIo, private readonly on: { state(s: ConnState): void; world(w: World): void; payload(p: StreamPayload, id: number): void }) {}

  /** launch from the fragment (already removed by the caller) or null; POST /api/v1/session once; else the stored session; then world, then stream with
   *  Last-Event-ID = world.cursor; broken stream → reconnecting, retry 1 s doubling to 30 s, then a world reload, then stopped; bye → stopped. */
  async start(launch: string | null): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (launch !== null) {
      const g = ++this.gen;
      let res: { status: number; json: unknown } | null = null;
      try {
        res = await this.io.request({ r: 'session' }, { method: 'POST', headers: { 'X-Cowork-Launch': launch } });
      } catch {
        res = null;
      }
      if (g !== this.gen || this.terminal()) return;
      if (res === null) return this.finish('stopped');
      if (res.status === 401) {
        const code = codeOf(res.json);
        return this.finish(code === 'UI_VIZ_LINK_REUSED' ? 'link_reused' : code === 'UI_VIZ_LINK_EXPIRED' ? 'link_expired' : 'need_link');
      }
      if (res.status !== 200) return this.finish('stopped');
      const session = isObject(res.json) ? res.json['session'] : undefined;
      if (typeof session !== 'string' || !HEX64.test(session)) return this.finish('need_link');
      this.session = session;
      this.io.storage.set({ session });
    } else {
      const stored = this.io.storage.get().session;
      if (stored === null || !HEX64.test(stored)) return this.finish('need_link');
      this.session = stored;
    }
    await this.loadWorld(false);
  }

  /** stopped (UI_VIZ_STOPPED) and link_reused clear the storage (12 §3.2 item 5); a stopped connection stays stopped. */
  stop(): void {
    this.finish('stopped');
  }

  private terminal(): boolean {
    return this.state === 'stopped' || this.state === 'link_reused' || this.state === 'link_expired' || this.state === 'need_link';
  }

  private setState(s: ConnState): void {
    if (s === this.state) return;
    this.state = s;
    deliver(() => this.on.state(s));
  }

  private finish(s: Terminal): void {
    if (this.terminal()) return;
    this.abandonStream();
    this.clearTimer();
    if (s === 'stopped' || s === 'link_reused') this.io.storage.clear();
    this.setState(s);
  }

  /** The current stream, if any, is superseded: its reads and the frames it already delivered in this chunk are ignored. */
  private abandonStream(): void {
    this.gen++;
    this.clearStable();
    const s = this.stream;
    this.stream = null;
    s?.cancel();
  }

  private clearTimer(): void {
    const c = this.cancelTimer;
    this.cancelTimer = null;
    c?.();
  }

  private clearStable(): void {
    const c = this.cancelStable;
    this.cancelStable = null;
    c?.();
  }

  /** The current stream works (a well-formed message arrived, or it stayed open STREAM_STABLE_MS): a later break is a new one. */
  private worked(): void {
    this.attempt = 'fresh';
    this.clearStable();
  }

  private schedule(ms: number, f: () => void): void {
    this.clearTimer();
    this.cancelTimer = this.io.timer(ms, () => {
      this.cancelTimer = null;
      f();
    });
  }

  /** GET /api/v1/world, then the stream from its cursor. lastResort: the reload after the 30 s retry, whose stream is the last try. */
  private async loadWorld(lastResort: boolean): Promise<void> {
    const g = ++this.gen;
    let res: { status: number; json: unknown } | null = null;
    try {
      res = await this.io.request({ r: 'world' }, { method: 'GET', headers: { 'X-Cowork-Session': this.session! } });
    } catch {
      res = null;
    }
    if (g !== this.gen || this.terminal()) return;
    if (res === null || res.status !== 200 || !isWorld(res.json)) return this.finish(res?.status === 401 ? 'need_link' : 'stopped');
    const w = res.json;
    this.versions = new Map(w.rooms.map((r) => [r.room_id, r.layout.version]));
    this.lastId = w.cursor;
    deliver(() => this.on.world(w));
    const a: Attempt = lastResort ? 'last' : 'fresh';
    if ((await this.openStream(a)) === 'failed') this.failed(a);
  }

  /** One stream request with the session and Last-Event-ID. 'gone' when stopped or superseded meanwhile. A 200 is not yet a
   *  success: the attempt fails like a failed open when the stream breaks before it works. */
  private async openStream(attempt: Attempt): Promise<'live' | 'failed' | 'gone'> {
    const g = ++this.gen;
    let s: StreamHandle | null = null;
    try {
      s = await this.io.stream({ 'X-Cowork-Session': this.session!, 'Last-Event-ID': String(this.lastId) });
    } catch {
      s = null;
    }
    if (g !== this.gen || this.terminal()) {
      s?.cancel();
      return 'gone';
    }
    if (s === null || s.status !== 200) {
      s?.cancel();
      return 'failed';
    }
    this.stream = s;
    this.attempt = attempt;
    this.cancelStable = this.io.timer(STREAM_STABLE_MS, () => {
      this.cancelStable = null;
      if (g === this.gen) this.worked();
    });
    this.setState('live');
    void this.pump(g, s);
    return 'live';
  }

  /** Reads the stream until it ends, breaks or is superseded; a stream that ends without bye is broken (12 §6). */
  private async pump(g: number, s: StreamHandle): Promise<void> {
    const parser = createSseParser((e) => {
      if (g === this.gen) this.dispatch(e);
    });
    for (;;) {
      let chunk: string | null;
      try {
        chunk = await s.read();
      } catch {
        chunk = null;
      }
      if (g !== this.gen) return;
      if (chunk === null) break;
      parser.push(chunk);
      if (g !== this.gen) return;                         // a frame in this chunk ended, broke or replaced the stream
    }
    parser.end();
    this.broken();
  }

  /** A well-formed message (a decimal id, a JSON object whose type is the event name) is handled; anything else breaks the stream. */
  private dispatch(e: SseEvent): void {
    const id = e.id !== null && EVENT_ID.test(e.id) ? Number(e.id) : null;
    let p: unknown;
    try {
      p = JSON.parse(e.data);
    } catch {
      p = undefined;
    }
    if (id === null || !Number.isSafeInteger(id) || !isPayload(p) || p.type !== e.event) return this.broken();
    this.worked();
    switch (p.type) {
      case 'bye':
        return this.finish('stopped');
      case 'reset':
        return this.reload();
      case 'room':
        if (p.change === 'added') return this.reload();
        break;
      case 'layout': {
        // R-V49: a delta at or below the room's version was already applied (it is passed on, a no-op for the page); the next one
        // advances the version; anything else, or a room the world does not have, is a gap.
        const v = this.versions.get(p.room_id);
        if (v === undefined) return this.reload();
        if (p.layout.version > v) {
          if (p.layout.from_version !== v) return this.reload();
          this.versions.set(p.room_id, p.layout.version);
        }
        break;
      }
      default:
        break;
    }
    this.lastId = id;
    deliver(() => this.on.payload(p, id));
  }

  private reload(): void {
    this.abandonStream();
    void this.loadWorld(false);
  }

  /** The current stream broke (it ended without bye, a read failed, or a message was malformed): its attempt failed. */
  private broken(): void {
    if (this.terminal()) return;
    const a = this.attempt;
    this.abandonStream();
    this.failed(a);
  }

  /** reconnecting; the next retry 1 s after a fresh attempt, else after twice the failed retry's delay (at most 30 s); when the
   *  retry at 30 s fails, the world is reloaded; when that reload's stream fails too → stopped (12 §3.10.5, §6). */
  private failed(a: Attempt): void {
    if (this.terminal()) return;
    if (a === 'last') return this.finish('stopped');
    this.setState('reconnecting');
    if (a !== 'fresh' && a >= RETRY_MAX_MS) return void this.loadWorld(true);
    const ms = a === 'fresh' ? RETRY_START_MS : Math.min(a * 2, RETRY_MAX_MS);
    this.schedule(ms, () => void this.retry(ms));
  }

  private async retry(ms: number): Promise<void> {
    if ((await this.openStream(ms)) === 'failed') this.failed(ms);
  }
}

/** 12 §3.2 item 11: the room kept in sessionStorage when it is still in the world, else the first room in server order; null with no rooms. */
export function firstRoom(w: World, kept: string | null): string | null {
  if (kept !== null && w.rooms.some((r) => r.room_id === kept)) return kept;
  return w.rooms[0]?.room_id ?? null;
}
