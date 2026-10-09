// The page's I/O for the connection (12 §3.10.2, §3.10.5; VIZ-34, VIZ-37, VIZ-42; V8, S11): one literal fetch per ApiRoute —
// a literal '/api/v1/…' path or a template with that literal head, after re-checking the room id, the heights and the language,
// so a value failing its check makes no request — every fetch with credentials 'omit', cache 'no-store' and redirect 'error';
// the stream read with fetch and a ReadableStream reader (never EventSource, which cannot send the session header); timers;
// and the tab's session in sessionStorage (never localStorage, a cookie or a URL), every access inside try/catch.
// Browser only; nothing here touches the DOM at module load (the static test bundles and imports this module).
import { LANGS } from '../../i18n/render.js';
import type { ApiRoute, ConnIo } from '../ui/conn.js';

const ROOM_RE = /^r[0-9A-HJKMNP-TV-Z]{8}$/;
const HEIGHT_RE = /^(0|[1-9][0-9]{0,9})$/;
/** The one sessionStorage key: the header the session travels in. Its value is JSON {session, room}. */
const STORE_KEY = 'X-Cowork-Session';

type Init = { method: 'GET' | 'POST'; headers: Record<string, string> };

/** A height as its decimal path form, or null when it is not a non-negative integer of at most 10 digits. */
function heightOf(h: unknown): string | null {
  if (typeof h !== 'number' || !Number.isSafeInteger(h)) return null;
  const s = String(h);
  return HEIGHT_RE.test(s) ? s : null;
}

/** The one request of a route; a route whose values fail their checks is refused before any request. */
function send(route: ApiRoute, init: Init): Promise<Response> {
  switch (route.r) {
    case 'session':
      return fetch('/api/v1/session', { method: init.method, headers: init.headers, credentials: 'omit', cache: 'no-store', redirect: 'error' });
    case 'world':
      return fetch('/api/v1/world', { method: init.method, headers: init.headers, credentials: 'omit', cache: 'no-store', redirect: 'error' });
    case 'strings': {
      const lang: unknown = route.lang;
      if (typeof lang !== 'string' || !(LANGS as readonly string[]).includes(lang)) return Promise.reject(new TypeError());
      return fetch(`/api/v1/strings?lang=${lang}`, { method: init.method, headers: init.headers, credentials: 'omit', cache: 'no-store', redirect: 'error' });
    }
    case 'timeline': {
      const room: unknown = route.room;
      const from = heightOf(route.from), to = heightOf(route.to);
      if (typeof room !== 'string' || !ROOM_RE.test(room) || from === null || to === null) return Promise.reject(new TypeError());
      return fetch(`/api/v1/rooms/${room}/timeline?from=${from}&to=${to}`, { method: init.method, headers: init.headers, credentials: 'omit', cache: 'no-store', redirect: 'error' });
    }
    default:
      return Promise.reject(new TypeError());
  }
}

type Stored = { session: string | null; room: string | null };

/** The stored {session, room} (sessionStorage, per tab); null when absent, malformed or unreadable. */
function readStore(): Stored | null {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (raw === null) return null;
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return null;
    const o = v as { session?: unknown; room?: unknown };
    return { session: typeof o.session === 'string' ? o.session : null, room: typeof o.room === 'string' ? o.room : null };
  } catch {
    return null;
  }
}

/** The page's ConnIo (ui/conn.ts): requests by route, the stream, timers and the tab's storage. The storage keeps an in-memory copy,
 *  so the page's own requests still carry the session when sessionStorage is unavailable (a reload then needs a new link). */
export function createConnIo(): ConnIo {
  let memory: Stored = { session: null, room: null };
  return {
    async request(route, init) {
      const res = await send(route, init);
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      return { status: res.status, json };
    },
    async stream(headers) {
      const res = await fetch('/api/v1/stream', { method: 'GET', headers, credentials: 'omit', cache: 'no-store', redirect: 'error' });
      const body = res.body;
      if (body === null) return { status: res.status, read: () => Promise.resolve(null), cancel: () => undefined };
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let done = false;
      return {
        status: res.status,
        async read(): Promise<string | null> {
          if (done) return null;
          const r = await reader.read();
          if (r.done) {
            done = true;
            const tail = decoder.decode();
            return tail === '' ? null : tail;
          }
          return decoder.decode(r.value, { stream: true });
        },
        cancel(): void {
          done = true;
          reader.cancel().catch(() => undefined);
        },
      };
    },
    timer(ms, f) {
      const id = setTimeout(() => f(), ms);
      return () => clearTimeout(id);
    },
    storage: {
      get(): Stored {
        const stored = readStore();
        return stored === null ? { ...memory } : { session: stored.session ?? memory.session, room: stored.room ?? memory.room };
      },
      set(v): void {
        const cur = readStore() ?? memory;
        memory = { session: v.session ?? cur.session ?? memory.session, room: v.room ?? cur.room ?? memory.room };
        try {
          sessionStorage.setItem(STORE_KEY, JSON.stringify(memory));
        } catch {
          // storage unavailable (a private window, a sandbox): the session lives in memory only
        }
      },
      clear(): void {
        memory = { session: null, room: null };
        try {
          sessionStorage.removeItem(STORE_KEY);
        } catch {
          // nothing stored
        }
      },
    },
  };
}
