// A Chrome DevTools Protocol client for the browser smoke (Plan 8a Task 17; 12 §7 T-VIZ-browser-smoke, §9.5: no package added). The
// runner's preinstalled Chrome or Chromium runs headless with --remote-debugging-port=0 and is driven over Node >= 22's built-in
// WebSocket; without either, findChrome/launchChrome answer null and the smoke reports SKIPPED. Test code only (Node 20 floor for
// src/ and dist/ is untouched: nothing under src/ imports this).
//
// Chrome is started by a small keeper process (node -e) that holds Chrome's handle: the keeper ends Chrome (its process tree on
// Windows, by taskkill.exe from SystemRoot, synchronously) and exits when its stdin closes (this test process ended, however it
// ended), when the temp profile directory is gone, or after CHROME_MAX_MS — so a browser never outlives the test that started it,
// and nothing is ever killed by a pid read from a file. Each tab is a flattened CDP session (Target.attachToTarget flatten: true).
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** One tab: its commands, its events (on(): every event of that name since the tab was opened, then each new one), and close(). */
export interface CdpSession {
  send(method: string, params?: object): Promise<unknown>;
  on(event: string, f: (p: unknown) => void): void;
  close(): Promise<void>;
}
/** A running browser: open() attaches a new tab (in a window of its own, so it stays visible and animates), enables Page, Runtime,
 *  Network and Log, runs `setup` (before the first document:
 *  bindings, scripts to evaluate on new documents, emulation), then navigates to `url` and waits for its load event. close() ends the
 *  browser and removes its profile. */
export interface CdpBrowser {
  open(url: string, setup?: (tab: CdpSession) => Promise<void>): Promise<CdpSession>;
  close(): Promise<void>;
}

/** The keeper's hard limit: the longest the smoke may run (its slowest test is a 60 s measurement). */
export const CHROME_MAX_MS = 15 * 60_000;
const START_MS = 30_000, COMMAND_MS = 30_000, LOAD_MS = 30_000, CLOSE_MS = 10_000;
const EVENTS_MAX = 100_000;

/** The built-in WebSocket of Node >= 22 (no DOM lib in this program: the few members used, declared here). */
interface WsMessage { readonly data?: unknown; }
interface Ws {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', f: (e: WsMessage) => void): void;
}
type WsCtor = new (url: string) => Ws;
function webSocket(): WsCtor | null {
  const w = (globalThis as { WebSocket?: unknown }).WebSocket;
  return typeof w === 'function' ? (w as WsCtor) : null;
}

/** A regular file at `p` (after symlinks). */
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** COWORK_CHROME, when set, decides alone: that absolute path if it is a file, else null (and browserGate fails such a pin: a
 *  mistyped pin must not pass as "no Chrome"). Otherwise CHROME_BIN when absolute (GitHub's Linux runners set it), then the install
 *  paths of Chrome and Chromium on the three runner OSes; the first regular file, else null. */
export function findChrome(): string | null {
  const env = process.env;
  const pinned = env['COWORK_CHROME'];
  if (pinned !== undefined && pinned !== '') return isAbsolute(pinned) && isFile(pinned) ? pinned : null;
  const out: string[] = [];
  const bin = env['CHROME_BIN'];
  if (bin !== undefined && isAbsolute(bin)) out.push(bin);
  if (process.platform === 'win32') {
    for (const base of [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']]) {
      if (base !== undefined && isAbsolute(base)) out.push(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
    const local = env['LOCALAPPDATA'];
    if (local !== undefined && isAbsolute(local)) out.push(join(local, 'Chromium', 'Application', 'chrome.exe'));
  } else if (process.platform === 'darwin') {
    for (const apps of ['/Applications', join(homedir(), 'Applications')]) {
      out.push(join(apps, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'), join(apps, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'));
    }
  } else {
    out.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium');
  }
  return out.find(isFile) ?? null;
}

/** Whether a browser suite runs (both false/null), reports SKIPPED (`skip`: the reason) or fails (`fail`: the reason). */
export interface BrowserGate { skip: string | false; fail: string | null; }

/**
 * The gate of the browser suites (browserSmoke.test.ts, demoE2E.test.ts; Plan 8a final review, fix Group D), over the environment,
 * whether Node's built-in WebSocket exists and what findChrome() answered: a set COWORK_CHROME for which findChrome found no file
 * fails (always: a pin is never a reason to skip); otherwise without WebSocket (Node < 22) or without Chrome the suite reports
 * SKIPPED with the reason (12 §7), unless COWORK_VIZ_REQUIRE_BROWSER=1 (viz-slow's smoke step), which makes that reason a failure.
 */
export function browserGate(env: Readonly<Record<string, string | undefined>>, o: { webSocket: boolean; chrome: string | null }): BrowserGate {
  const pinned = env['COWORK_CHROME'];
  if (pinned !== undefined && pinned !== '' && o.chrome === null) {
    return { skip: false, fail: `COWORK_CHROME is set but names no absolute file: ${JSON.stringify(pinned)}` };
  }
  const reason = !o.webSocket ? 'Node < 22: no built-in WebSocket' : o.chrome === null ? 'no Chrome or Chromium on this runner' : null;
  if (reason === null) return { skip: false, fail: null };
  if (env['COWORK_VIZ_REQUIRE_BROWSER'] === '1') return { skip: false, fail: `${reason}, and COWORK_VIZ_REQUIRE_BROWSER=1 requires one` };
  return { skip: reason, fail: null };
}

/** browserGate for this process: process.env, the built-in WebSocket and findChrome(). */
export function browserGateHere(): BrowserGate {
  return browserGate(process.env, { webSocket: webSocket() !== null, chrome: findChrome() });
}

/** The keeper (CommonJS, run by node -e with one JSON argument [exe, profile, maxMs, ...args]): Chrome's stderr goes to its own. */
const KEEPER = `
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const [exe, profile, maxMs, ...args] = JSON.parse(process.argv[1]);
process.chdir(require('os').tmpdir());
const c = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
c.stderr.pipe(process.stderr);
let alive = true;
c.once('exit', () => { alive = false; process.exit(0); });
c.once('error', () => { alive = false; process.exit(1); });
const end = () => {
  if (alive) {
    alive = false;
    const root = process.env.SystemRoot;
    if (process.platform === 'win32' && root) {
      spawnSync(path.join(root, 'System32', 'taskkill.exe'), ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, cwd: root });
    } else {
      c.kill('SIGKILL');
    }
  }
  process.exit(0);
};
process.stdin.on('end', end);
process.stdin.on('error', end);
process.stdin.resume();
const born = Date.now();
setInterval(() => { if (!fs.existsSync(profile) || Date.now() - born > maxMs) end(); }, 250);
`;

/** The flags of a quiet headless browser: no first-run UI, no background network or updates, no sync or extensions. Linux CI runs
 *  Chrome without its sandbox (unprivileged user namespaces are often unavailable there); it opens only the tests' loopback pages. */
function chromeArgs(profile: string): string[] {
  return [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-extensions', '--disable-sync',
    '--mute-audio', '--window-size=1280,900', ...(process.platform === 'linux' ? ['--no-sandbox'] : []), 'about:blank',
  ];
}

/** The browser endpoint from Chrome's stderr line `DevTools listening on ws://…`. */
function devtoolsUrl(keeper: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error(`Chrome printed no DevTools endpoint within ${START_MS} ms: ${text.slice(0, 2_000)}`)), START_MS);
    keeper.stderr!.setEncoding('utf8');
    keeper.stderr!.on('data', (d: string) => {
      text += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(text);
      if (m !== null) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    });
    keeper.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited before its DevTools endpoint: ${text.slice(0, 2_000)}`));
    });
  });
}

type Pending = { resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout };
type Message = { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string }; sessionId?: string };

/** One WebSocket to the browser endpoint: commands by id, events routed to their session. */
class Connection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly sessions = new Map<string, (method: string, params: unknown) => void>();
  private closed = false;

  constructor(private readonly ws: Ws) {
    ws.addEventListener('message', (e) => this.onMessage(String(e.data)));
    ws.addEventListener('close', () => this.fail('the DevTools connection closed'));
    ws.addEventListener('error', () => this.fail('the DevTools connection failed'));
  }

  static open(url: string, Ctor: WsCtor): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const ws = new Ctor(url);
      const timer = setTimeout(() => reject(new Error('the DevTools WebSocket did not open')), START_MS);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new Connection(ws));
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('the DevTools WebSocket failed to open'));
      });
    });
  }

  send(method: string, params: object = {}, sessionId?: string): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(`${method}: the DevTools connection is closed`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no answer within ${COMMAND_MS} ms`));
      }, COMMAND_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }));
    });
  }

  route(sessionId: string, sink: ((method: string, params: unknown) => void) | null): void {
    if (sink === null) this.sessions.delete(sessionId);
    else this.sessions.set(sessionId, sink);
  }

  close(): void {
    this.fail('the DevTools connection was closed');
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }

  private onMessage(text: string): void {
    let m: Message;
    try {
      m = JSON.parse(text) as Message;
    } catch {
      return;
    }
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (p === undefined) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error !== undefined) p.reject(new Error(m.error.message ?? 'CDP error'));
      else p.resolve(m.result ?? {});
      return;
    }
    if (m.method !== undefined && m.sessionId !== undefined) this.sessions.get(m.sessionId)?.(m.method, m.params);
  }

  private fail(why: string): void {
    this.closed = true;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(why));
      this.pending.delete(id);
    }
  }
}

/** A flattened session on one page target; events are kept from its start, so a listener added later sees them all. */
class Tab implements CdpSession {
  private readonly events: Array<{ method: string; params: unknown }> = [];
  private readonly listeners = new Map<string, Array<(p: unknown) => void>>();

  constructor(private readonly conn: Connection, private readonly sessionId: string, private readonly targetId: string) {
    conn.route(sessionId, (method, params) => {
      if (this.events.length < EVENTS_MAX) this.events.push({ method, params });
      for (const f of this.listeners.get(method) ?? []) f(params);
    });
  }

  send = (method: string, params: object = {}): Promise<unknown> => this.conn.send(method, params, this.sessionId);

  on = (event: string, f: (p: unknown) => void): void => {
    for (const e of this.events) if (e.method === event) f(e.params);
    const list = this.listeners.get(event) ?? [];
    list.push(f);
    this.listeners.set(event, list);
  };

  /** The next `event` from now on (not a past one). */
  next(event: string, ms: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        done = true;
        reject(new Error(`no ${event} within ${ms} ms`));
      }, ms);
      const list = this.listeners.get(event) ?? [];
      list.push((p) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(p);
      });
      this.listeners.set(event, list);
    });
  }

  close = async (): Promise<void> => {
    try {
      await this.conn.send('Target.closeTarget', { targetId: this.targetId });
    } catch {
      // the browser is gone already
    }
    this.conn.route(this.sessionId, null);
  };
}

/** Running keepers, so a test process that ends without close() still closes their stdin (the keeper then ends Chrome). */
const keepers = new Set<ChildProcess>();
process.once('exit', () => {
  for (const k of keepers) {
    try {
      k.stdin?.destroy();
    } catch {
      // gone
    }
  }
});

/** Starts headless Chrome (null without Chrome or a built-in WebSocket) and connects to its browser endpoint. */
export async function launchBrowser(): Promise<CdpBrowser | null> {
  const Ctor = webSocket();
  const exe = findChrome();
  if (Ctor === null || exe === null) return null;
  const profile = mkdtempSync(join(tmpdir(), 'cowork-cdp-'));
  const keeper = spawn(process.execPath, ['-e', KEEPER, JSON.stringify([exe, profile, CHROME_MAX_MS, ...chromeArgs(profile)])], {
    stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true,
  });
  keepers.add(keeper);
  keeper.stdin?.on('error', () => undefined);              // a keeper that already exited: ending its stdin is a no-op, not an EPIPE crash
  const exited = new Promise<void>((resolve) => keeper.once('exit', () => resolve()));
  let conn: Connection | null = null;
  const end = async (): Promise<void> => {
    if (conn !== null) {
      await conn.send('Browser.close').catch(() => undefined);
      conn.close();
    }
    keeper.stdin?.end();                                   // the keeper ends Chrome if it is still running, then exits
    let timer: NodeJS.Timeout | undefined;
    const done = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => { timer = setTimeout(() => r(false), CLOSE_MS); })]);
    clearTimeout(timer);
    if (!done && keeper.exitCode === null && keeper.signalCode === null) keeper.kill();
    keepers.delete(keeper);
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  try {
    conn = await Connection.open(await devtoolsUrl(keeper), Ctor);
  } catch (e) {
    await end();
    throw e;
  }
  const c = conn;
  let closing: Promise<void> | null = null;
  return {
    async open(url, setup): Promise<CdpSession> {
      // A window of its own: every tab stays the visible one of its window, so a later tab never pauses an earlier tab's
      // requestAnimationFrame (a background tab draws nothing).
      const { targetId } = (await c.send('Target.createTarget', { url: 'about:blank', newWindow: true })) as { targetId: string };
      const { sessionId } = (await c.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string };
      const tab = new Tab(c, sessionId, targetId);
      for (const domain of ['Page', 'Runtime', 'Network', 'Log']) await tab.send(`${domain}.enable`);
      if (setup !== undefined) await setup(tab);
      const loaded = tab.next('Page.loadEventFired', LOAD_MS);
      const nav = (await tab.send('Page.navigate', { url })) as { errorText?: string };
      if (nav.errorText !== undefined) throw new Error(`navigation to ${url} failed: ${nav.errorText}`);
      await loaded;
      return tab;
    },
    close: () => (closing ??= end()),
  };
}

/** One tab on `url` in a new headless Chrome (null without Chrome or a built-in WebSocket); its close() ends the browser. */
export async function launchChrome(url: string): Promise<{ send(method: string, params?: object): Promise<unknown>; on(event: string, f: (p: unknown) => void): void; close(): Promise<void> } | null> {
  const browser = await launchBrowser();
  if (browser === null) return null;
  try {
    const tab = await browser.open(url);
    return { send: tab.send, on: tab.on, close: () => browser.close() };
  } catch (e) {
    await browser.close();
    throw e;
  }
}

/** Runtime.evaluate by value (promises awaited); a thrown exception rejects. */
export async function evaluate<T = unknown>(s: CdpSession, expression: string): Promise<T> {
  const r = (await s.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })) as {
    result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  if (r.exceptionDetails !== undefined) throw new Error(`evaluate: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'exception'}`);
  return r.result?.value as T;
}
