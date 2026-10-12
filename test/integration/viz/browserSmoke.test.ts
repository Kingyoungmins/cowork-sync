// Plan 8a Task 17: T-VIZ-browser-smoke (12 §7 items (a)–(g) and (i); §3.12 page budgets; §9.5: no package added; VIZ-05, VIZ-31,
// VIZ-33, VIZ-37, VIZ-40, VIZ-41, VIZ-42; R-V41; Review Focus 1 and 2); Plan 8a Task 19: item (k), T-VIZ-follow-privacy without its
// recording clause, which is Plan 8b's (rev 2.5, F32; FEAT-F32-01). The runner's preinstalled Chrome or Chromium, headless with
// --remote-debugging-port=0, driven over the Chrome DevTools Protocol with Node >= 22's built-in WebSocket (test/helpers/cdp.ts). Every
// test is SKIPPED without Chrome or on Node < 22 (and fails instead under COWORK_VIZ_REQUIRE_BROWSER=1 or a mistyped COWORK_CHROME:
// browserGate); the page budgets also need COWORK_VIZ_SLOW=1 (a 60 s measurement, R-V41). The exit
// sweep (Task 18) finds this file by its name (F19).
//
// The page is the build's own: the bundled demo runs in the real dist/viz.js (buildDistOnce), started as the CLI starts it, and the
// other viewers run in-process (startTestViewer) with the /app.js and /app.css that real process serves. Every viewer tab runs a
// probe installed before its document (Page.addScriptToEvaluateOnNewDocument): each securitypolicyviolation event goes to a CDP
// binding, and where a test reads them, window.__cowork records every text the DOM and the canvases receive, every element and
// attribute name created, Object.prototype's own names at document start, and the office canvas's name tags per drawn frame — a
// name tag drawn off a whole tile is a walk frame (12 §3.7).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { buildDaemonEnv } from '../../../src/git/env.js';
import { realFs } from '../../../src/ports/fs.js';
import type { VizAssets } from '../../../src/viz/assets.js';
import { verifyDataDir } from '../../../src/viz/cli/dataDir.js';
import { realOwnerProbe } from '../../../src/viz/cli/ownerProbe.js';
import { parseReadyLine, viewerArgv } from '../../../src/viz/cli/spawn.js';
import { EN_VIZ } from '../../../src/viz/i18n/en.js';
import { vizText } from '../../../src/viz/server/project.js';
import { parseDemoLog, type DemoLog } from '../../../src/viz/source/demo.js';
import { browserGateHere, evaluate, launchBrowser, type CdpBrowser, type CdpSession } from '../../helpers/cdp.js';
import { demoBuffer, headerLine, storyLines } from '../../helpers/vizDemo.js';
import { request } from '../../helpers/vizHttp.js';
import { apiGet, buildDistOnce, logLines, sha256Of, startTestViewer, TEST_VIEWER_ASSETS, viewerTemp, worldOf } from '../../helpers/vizViewer.js';
import { XSS_CORPUS, XSS_ROOM, xssStores } from '../../fixtures/viz/xssStores.js';

/** SKIPPED without Chrome or on Node < 22; failed instead under COWORK_VIZ_REQUIRE_BROWSER=1 (viz-slow's smoke step) or when a set
 *  COWORK_CHROME names no file (browserGate; Plan 8a final review, fix Group D): the before hook fails, so every test fails with it. */
const GATE = browserGateHere();
const SKIP: string | false = GATE.skip;
const SLOW = process.env['COWORK_VIZ_SLOW'] === '1';
const MB = 1024 * 1024;
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const CANARY_DEMO = join(REPO, 'test', 'fixtures', 'viz', 'xss-canaries.jsonl');
const BINDING = '__coworkProbe';
const HEX64 = /^[0-9a-f]{64}$/;
/** The name-tag separator of a colliding tag (R-V52), as the probe's source text spells it. */
const TAG_SEP_JS = "' ' + String.fromCharCode(183) + ' '";

// ---------------------------------------------------------------------------------------------------------------------------
// Viewers

/** A viewer the tabs open: its port and the launch link `http://127.0.0.1:<port>/#k=<launch>`. */
interface Served { port: number; launch: string; origin: string; link: string; }
const servedOf = (port: number, launch: string): Served => ({ port, launch, origin: `http://127.0.0.1:${port}`, link: `http://127.0.0.1:${port}/#k=${launch}` });

/** The real dist/viz.js serving the bundled demo, started as the CLI starts it (viewerArgv: the V8 heap cap, then serve --demo; cwd =
 *  the data directory, the builder environment). stop() ends it through its held handle. */
interface RealViewer extends Served { child: ChildProcess; stop(): void; }
async function startRealViewer(vizJs: string, dataDir: string): Promise<RealViewer> {
  const env = buildDaemonEnv(process.env as Record<string, string | undefined>, []);
  const argv = viewerArgv({
    execPath: process.execPath, vizJs, dataDir, lang: 'en', sha256: sha256Of(vizJs), repos: [], demo: true, git: null, env, platform: process.platform, systemRoot: null,
  });
  const child = spawn(process.execPath, argv, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], cwd: dataDir, env });
  const stop = (): void => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  };
  try {
    const line = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => reject(new Error('the viewer wrote no ready line within 15 s')), 15_000);
      child.stdout!.on('data', (b: Buffer) => {
        chunks.push(b);
        const all = Buffer.concat(chunks);
        const lf = all.indexOf(0x0a);
        if (lf >= 0) {
          clearTimeout(timer);
          resolve(all.subarray(0, lf + 1));
        }
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('the viewer exited before its ready line'));
      });
    });
    const ready = parseReadyLine(line);
    if (ready === null || !('port' in ready)) throw new Error(`the viewer refused: ${line.toString('utf8')}`);
    return { ...servedOf(ready.port, ready.launch), child, stop };
  } catch (e) {
    stop();
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Tabs and their probe

interface ProbeOptions { reduced?: boolean; record?: { tags: readonly string[] } }

/** The probe's source (see the file header). Office canvas name tags: office.ts draws a tag's plate centred on x = (tile.x·16 + 8)·Z
 *  with its bottom at (tile.y·16 − 9)·Z (device px, rounded to a pixel), so off a whole tile by more than half a pixel is a walk. */
function probeSource(o: ProbeOptions): string {
  const record = o.record === undefined ? '' : `
  const TAGS = ${JSON.stringify(o.record.tags)};
  const SEP = ${TAG_SEP_JS};
  const MAX = 20000;
  const P = { texts: new Set(), elements: new Set(), attributes: new Set(), canvas: new Set(),
    protoNames: Object.getOwnPropertyNames(Object.prototype).sort().join(','), layerDraws: 0, tagDraws: 0, walkDraws: 0, walks: [] };
  Object.defineProperty(window, '__cowork', { value: P });
  const add = (set, v) => { if (typeof v === 'string' && v !== '' && set.size < MAX) set.add(v); };
  const visit = (n) => {
    if (n.nodeType === 3) return add(P.texts, n.data);
    if (n.nodeType !== 1) return;
    P.elements.add(n.localName);
    for (const a of Array.from(n.attributes)) {
      P.attributes.add(a.name);
      if (a.name === 'aria-label' || a.name === 'title') add(P.texts, a.value);
    }
    for (const c of Array.from(n.childNodes)) visit(c);
  };
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'childList') m.addedNodes.forEach(visit);
      else if (m.type === 'characterData') add(P.texts, m.target.data);
      else if (m.type === 'attributes') {
        P.attributes.add(m.attributeName);
        if (m.attributeName === 'aria-label' || m.attributeName === 'title') add(P.texts, m.target.getAttribute(m.attributeName));
      }
    }
  }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  const proto = CanvasRenderingContext2D.prototype;
  const fillText = proto.fillText, drawImage = proto.drawImage;
  const plates = new WeakMap();
  let z = 0;
  proto.fillText = function (text, ...rest) {
    add(P.canvas, String(text));
    plates.set(this.canvas, String(text));
    return fillText.call(this, text, ...rest);
  };
  proto.drawImage = function (img, ...a) {
    try {
      const host = this.canvas.parentElement;
      if (host !== null && host.classList.contains('scroll')) {
        if (a.length === 4 && a[0] === 0 && a[1] === 0 && img.width > 0) {
          z = a[2] / img.width;
          P.layerDraws++;
        } else if (a.length === 2 && z > 0) {
          const text = plates.get(img);
          if (text !== undefined && TAGS.some((t) => text === t || text.startsWith(t + SEP))) {
            P.tagDraws++;
            const tx = ((a[0] + img.width / 2) / z - 8) / 16, ty = ((a[1] + img.height) / z + 9) / 16;
            const eps = 0.5 / (16 * z) + 1e-6;
            if (Math.abs(tx - Math.round(tx)) > eps || Math.abs(ty - Math.round(ty)) > eps) {
              P.walkDraws++;
              if (P.walks.length < 20) P.walks.push([text, tx, ty]);
            }
          }
        }
      }
    } catch (e) {
      // the probe never changes what the page draws
    }
    return drawImage.call(this, img, ...a);
  };`;
  return `(() => {
  const send = (o) => { try { globalThis[${JSON.stringify(BINDING)}](JSON.stringify(o)); } catch (e) {} };
  addEventListener('securitypolicyviolation', (e) => send({ t: 'csp', directive: e.violatedDirective, blocked: String(e.blockedURI), sample: String(e.sample) }), true);${record}
})();`;
}

interface RequestSeen { id: string; url: string; method: string; headers: Record<string, string>; }
/** A request the browser failed (Network.loadingFailed): its resource type, net error, block reason and CORS error. */
interface Failure { type: string; errorText: string; blockedReason: string | null; corsError: string | null; }
/** A tab and what it saw since it opened: CSP reports (the DOM event and the security log), exceptions, requests, their statuses (the
 *  response the browser kept, else the raw one of responseReceivedExtraInfo) and raw response headers, and the requests that failed. */
interface Tab {
  s: CdpSession; csp: string[]; exceptions: string[]; requests: RequestSeen[]; statuses: Map<string, number>;
  rawHeaders: Map<string, Record<string, string>>; failures: Map<string, Failure>; loads: number;
}

let browser: CdpBrowser | null = null;

/** A tab on `url` with the probe (and the reduced-motion emulation) installed before its first document. */
async function openTab(url: string, o: ProbeOptions = {}): Promise<Tab> {
  const s = await browser!.open(url, async (t) => {
    await t.send('Runtime.addBinding', { name: BINDING });
    await t.send('Page.addScriptToEvaluateOnNewDocument', { source: probeSource(o) });
    if (o.reduced === true) await t.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  });
  const tab: Tab = { s, csp: [], exceptions: [], requests: [], statuses: new Map(), rawHeaders: new Map(), failures: new Map(), loads: 0 };
  s.on('Runtime.bindingCalled', (p) => {
    const { name, payload } = p as { name: string; payload: string };
    if (name === BINDING && (JSON.parse(payload) as { t: string }).t === 'csp') tab.csp.push(`event: ${payload}`);
  });
  s.on('Log.entryAdded', (p) => {
    const e = (p as { entry: { source: string; level: string; text: string } }).entry;
    if (e.source === 'security' || /content.security.policy|trusted.type/i.test(e.text)) tab.csp.push(`log: ${e.source} ${e.level} ${e.text}`);
  });
  s.on('Runtime.exceptionThrown', (p) => {
    const d = (p as { exceptionDetails: { text?: string; exception?: { description?: string } } }).exceptionDetails;
    tab.exceptions.push(d.exception?.description ?? d.text ?? 'exception');
  });
  s.on('Network.requestWillBeSent', (p) => {
    const r = p as { requestId: string; request: { url: string; method: string; headers: Record<string, string> } };
    tab.requests.push({ id: r.requestId, url: r.request.url, method: r.request.method, headers: r.request.headers });
  });
  s.on('Network.responseReceived', (p) => {
    const r = p as { requestId: string; response: { status: number } };
    tab.statuses.set(r.requestId, r.response.status);
  });
  s.on('Network.responseReceivedExtraInfo', (p) => {
    const r = p as { requestId: string; statusCode: number; headers: Record<string, string> };
    if (!tab.statuses.has(r.requestId)) tab.statuses.set(r.requestId, r.statusCode);
    tab.rawHeaders.set(r.requestId, r.headers);
  });
  s.on('Network.loadingFailed', (p) => {
    const r = p as { requestId: string; type: string; errorText: string; blockedReason?: string; corsErrorStatus?: { corsError: string } };
    tab.failures.set(r.requestId, { type: r.type, errorText: r.errorText, blockedReason: r.blockedReason ?? null, corsError: r.corsErrorStatus?.corsError ?? null });
  });
  s.on('Page.loadEventFired', () => { tab.loads++; });
  return tab;
}

/** Polls `expression` in the tab every 100 ms until it is truthy; its last value in the failure. */
async function waitFor(tab: Tab, expression: string, ms = 15_000): Promise<unknown> {
  const end = Date.now() + ms;
  let last: unknown;
  for (;;) {
    last = await evaluate(tab.s, expression);
    if (last !== false && last !== null && last !== undefined && last !== 0 && last !== '') return last;
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${expression} (last: ${JSON.stringify(last)})`);
    await delay(100);
  }
}
const stateOf = (tab: Tab): Promise<string | null> => evaluate<string | null>(tab.s, 'document.documentElement.getAttribute("data-state")');
const waitLive = (tab: Tab): Promise<unknown> => waitFor(tab, 'document.documentElement.getAttribute("data-state") === "live" && document.querySelector("section.office canvas[aria-label]") !== null');
/** A demo replay that has played through (client/rewind.ts): the page left live for the replay from h0 and stopped playing at the last
 *  height holding an event (a later board-only height has none). Before the demo starts the page is live; showAt() leaves live and
 *  starts playing in one task, so no evaluation sees that step half done. */
const REPLAY_DONE = `(() => {
  const bar = document.querySelector('footer.rewind');
  const live = bar && bar.querySelector('button.live-pill'), play = bar && bar.querySelector('button.control');
  return live !== null && play !== null && live.getAttribute('aria-pressed') === 'false' && play.getAttribute('aria-pressed') === 'false';
})()`;
/** The tab's stored {session, room} (12 §3.2 item 5: sessionStorage under X-Cowork-Session), or null. */
const storedOf = (tab: Tab): Promise<{ session: string; room: string | null } | null> =>
  evaluate(tab.s, 'sessionStorage.getItem("X-Cowork-Session") === null ? null : JSON.parse(sessionStorage.getItem("X-Cowork-Session"))');
/** What window.__cowork recorded (the record probe). */
interface Recorded { texts: string[]; elements: string[]; attributes: string[]; canvas: string[]; protoNames: string; layerDraws: number; tagDraws: number; walkDraws: number; walks: unknown[]; }
const recordedOf = (tab: Tab): Promise<Recorded> => evaluate(tab.s, `(() => { const P = window.__cowork; return { texts: [...P.texts], elements: [...P.elements],
  attributes: [...P.attributes], canvas: [...P.canvas], protoNames: P.protoNames, layerDraws: P.layerDraws, tagDraws: P.tagDraws, walkDraws: P.walkDraws, walks: P.walks }; })()`);
/** The status line's code and text (ui/conn.ts's terminal states, 12 §6). */
const statusOf = (tab: Tab): Promise<{ code: string | null; text: string | null }> =>
  evaluate(tab.s, '(() => { const s = document.querySelector("[data-code]"); return { code: s && s.getAttribute("data-code"), text: s && s.textContent }; })()');

// ---------------------------------------------------------------------------------------------------------------------------
// The file's fixtures: one Chrome, the real viewer and its page assets, the main tab on the bundled demo

let real: RealViewer | null = null;
let assets: VizAssets = TEST_VIEWER_ASSETS;
let main: Tab | null = null;
let dataDir = '';
const opened: Array<{ stop(reason: 'VIZ_EXIT_SIGNAL'): Promise<void> }> = [];

/** An in-process viewer with the build's page (startTestViewer), stopped after the file. */
async function inProcessViewer(...a: Parameters<typeof startTestViewer>): Promise<Awaited<ReturnType<typeof startTestViewer>>> {
  const v = await startTestViewer(a[0], { assets, ...a[1] });
  opened.push(v);
  return v;
}

before(async () => {
  if (GATE.fail !== null) assert.fail(GATE.fail);
  if (SKIP !== false) return;
  const dist = await buildDistOnce();
  const root = viewerTemp('browser-smoke');
  dataDir = join(root, 'data dir');
  assert.deepEqual(await verifyDataDir(dataDir, { fs: realFs, probe: realOwnerProbe, platform: process.platform, create: true }), { ok: true });
  real = await startRealViewer(join(dist, 'viz.js'), dataDir);
  // The build's page, as the real viewer serves it, for the in-process viewers.
  const js = await request(real.port, { path: '/app.js' });
  const css = await request(real.port, { path: '/app.css' });
  assert.equal(js.status, 200);
  assert.equal(css.status, 200);
  assets = { appJs: js.body.toString('utf8'), appCss: css.body.toString('utf8'), bundledDemo: TEST_VIEWER_ASSETS.bundledDemo };
  assert.ok(assets.appJs.length > 20_000, 'the real page bundle');
  browser = await launchBrowser();
  assert.ok(browser !== null, 'Chrome starts');
  main = await openTab(real.link);
  await waitLive(main);
}, { timeout: 120_000 });

after(async () => {
  for (const v of opened) await v.stop('VIZ_EXIT_SIGNAL').catch(() => undefined);
  await browser?.close();
  real?.stop();
}, { timeout: 60_000 });

// ---------------------------------------------------------------------------------------------------------------------------
// (a) (b) (c): the main tab on the real viewer's bundled demo

test('(a) after load the URL has no fragment and sessionStorage holds the session', { skip: SKIP, timeout: 60_000 }, async () => {
  const tab = main!, v = real!;
  const loc = await evaluate<{ href: string; hash: string }>(tab.s, '({ href: location.href, hash: location.hash })');
  assert.deepEqual(loc, { href: `${v.origin}/`, hash: '' }, 'the launch fragment left the URL');
  const stored = await storedOf(tab);
  assert.ok(stored !== null && HEX64.test(stored.session), `sessionStorage holds the session: ${JSON.stringify(stored)}`);
  // Only memory and sessionStorage (VIZ-31): no cookie, nothing in localStorage carries it.
  assert.equal(await evaluate(tab.s, 'document.cookie'), '');
  assert.equal((await evaluate<string>(tab.s, 'JSON.stringify(Object.entries(localStorage))')).includes(stored.session), false);
  // VIZ-05 (the fragment arrives intact): the page redeemed exactly the launch token of the link, once, and got the session.
  const redemptions = tab.requests.filter((r) => r.method === 'POST' && r.url === `${v.origin}/api/v1/session`);
  assert.equal(redemptions.length, 1, 'one redemption');
  const header = Object.entries(redemptions[0]!.headers).filter(([k]) => k.toLowerCase() === 'x-cowork-launch').map(([, x]) => x);
  assert.deepEqual(header, [v.launch], 'the launch token of the link, in X-Cowork-Launch');
  assert.equal(tab.statuses.get(redemptions[0]!.id), 200);
  assert.ok(tab.requests.every((r) => !r.url.includes(v.launch)), 'the launch token never travels in a URL');
  // The session works: the world it reads is the bundled demo.
  const world = await worldOf(v.port, stored.session);
  assert.equal(world.demo, true);
});

test('(b) zero CSP violation reports', { skip: SKIP, timeout: 60_000 }, async () => {
  const tab = main!;
  await delay(2_000);                                     // a few beats of the demo replay
  assert.deepEqual(tab.csp, [], 'no securitypolicyviolation event and no security log entry');
  assert.deepEqual(tab.exceptions, [], 'no uncaught exception (a Trusted Types violation throws)');
  // The probe sees a violation when there is one: an image from another origin (img-src 'self' data:) in a viewer page.
  const v = await inProcessViewer({ demo: true });
  const control = await openTab(servedOf(v.port, v.launch).link);
  await waitLive(control);
  assert.equal(control.csp.length, 0, 'no report before the control violation');
  await evaluate(control.s, 'document.body.appendChild(Object.assign(document.createElement("img"), { src: "http://127.0.0.2:9/x.png" })) && true');
  const end = Date.now() + 5_000;
  while (control.csp.filter((x) => x.startsWith('event:')).length === 0 && Date.now() < end) await delay(100);
  assert.ok(control.csp.some((x) => x.startsWith('event:') && x.includes('img-src')), `the control violation is reported: ${JSON.stringify(control.csp)}`);
  await control.s.close();
});

test('(c) every request goes to the viewer origin', { skip: SKIP, timeout: 60_000 }, async () => {
  const tab = main!, v = real!;
  const urls = tab.requests.map((r) => r.url);
  for (const u of urls) assert.ok(u.startsWith(`${v.origin}/`), `a request to ${u}`);
  // The whole session so far: the document, its two assets, the redemption, the world, the stream, and the strings of the browser's
  // language (the server answers en for each of the six, R-V15).
  for (const p of ['/', '/app.js', '/app.css', '/api/v1/session', '/api/v1/world', '/api/v1/stream']) {
    assert.ok(urls.includes(`${v.origin}${p}`), `${p} was requested`);
  }
  assert.ok(urls.some((u) => /^\/api\/v1\/strings\?lang=(en|ko|zh-CN|ja|fr|es)$/.test(u.slice(v.origin.length))), 'the strings were requested');
});

// ---------------------------------------------------------------------------------------------------------------------------
// (d) reload, and a second tab with the same link

test('(d) a reload keeps working; a second tab opened with the same link shows UI_VIZ_LINK_REUSED and the first shows UI_VIZ_STOPPED with a grey live pill (live-off, not pressed)', { skip: SKIP, timeout: 60_000 }, async () => {
  const v = await inProcessViewer({ demo: true });
  const served = servedOf(v.port, v.launch);
  const first = await openTab(served.link);
  await waitLive(first);
  const stored = await storedOf(first);
  assert.ok(stored !== null);

  // A reload: no fragment any more, the tab's stored session, the world and the stream again.
  const loads = first.loads;
  const redemptions = (): number => first.requests.filter((r) => r.url === `${served.origin}/api/v1/session`).length;
  await first.s.send('Page.reload', {});
  const end = Date.now() + 15_000;
  while (first.loads === loads && Date.now() < end) await delay(50);
  assert.ok(first.loads > loads, 'the page reloaded');
  await waitLive(first);
  assert.equal(await evaluate(first.s, 'location.hash'), '');
  assert.deepEqual(await storedOf(first), stored, 'the same session, from sessionStorage');
  assert.equal(redemptions(), 1, 'the reload redeemed nothing');
  assert.equal(first.requests.filter((r) => r.url === `${served.origin}/api/v1/world`).length, 2, 'the world was read again');
  assert.deepEqual((await statusOf(first)).code, null, 'no state line while live');

  // The first tab back at the live tip (the bundled demo replays from h0 when it loads): its live pill is the healthy live-on, pressed.
  const PILL = `(() => {
    const p = document.querySelector('footer.rewind button.live-pill');
    return p === null ? null : { on: p.classList.contains('live-on'), off: p.classList.contains('live-off'), pressed: p.getAttribute('aria-pressed') === 'true' };
  })()`;
  await evaluate(first.s, `document.querySelector('footer.rewind button.live-pill').click(), true`);
  await waitFor(first, `(() => { const p = ${PILL}; return p !== null && p.on && !p.off && p.pressed; })()`);

  // A second tab with the same link: UI_VIZ_LINK_REUSED there, UI_VIZ_STOPPED in the first, and the viewer ends.
  const second = await openTab(served.link);
  await waitFor(second, 'document.documentElement.getAttribute("data-state") === "link_reused"');
  await waitFor(first, 'document.documentElement.getAttribute("data-state") === "stopped"');
  assert.deepEqual(await statusOf(second), { code: 'UI_VIZ_LINK_REUSED', text: EN_VIZ['UI_VIZ_LINK_REUSED']!.text });
  assert.deepEqual(await statusOf(first), { code: 'UI_VIZ_STOPPED', text: EN_VIZ['UI_VIZ_STOPPED']!.text });
  // The stopped tab never presents its scene as live (VIZ-42; 12 §3.10.5 and §6: the grey live pill; final review B5): its live pill,
  // the healthy pressed live-on a moment ago, shows live-off, not live-on, and is not announced as pressed.
  await waitFor(first, `(() => { const p = ${PILL}; return p !== null && p.off && !p.on && !p.pressed; })()`, 5_000).catch(() => undefined);
  const pill = await evaluate<{ on: boolean; off: boolean; pressed: boolean } | null>(first.s, PILL);
  assert.deepEqual(pill, { on: false, off: true, pressed: false }, 'the stopped tab\'s live pill is grey (live-off, not live-on) and not pressed');
  assert.equal(await storedOf(first), null, 'a stopped tab forgets its session (12 §3.2 item 5)');
  assert.equal(await storedOf(second), null);
  assert.equal(await v.exited, 'VIZ_EXIT_LAUNCH_REUSED');
  assert.deepEqual([first.csp, second.csp, first.exceptions, second.exceptions], [[], [], [], []]);
  await first.s.close();
  await second.s.close();
});

// ---------------------------------------------------------------------------------------------------------------------------
// (e) XSS canaries

/** The texts a canary must render as: the served (validated, sanitized, capped) form of each canary field. */
interface Canary { field: string; raw: string; served: string; }
/** Every rendered text (DOM text, aria-label and title values, canvas fillText strings) that contains `served`, or none. */
const renders = (r: Recorded, served: string): boolean => r.texts.some((t) => t.includes(served)) || r.canvas.some((t) => t.includes(served));

/** The checks on a tab that received hostile text: nothing ran, nothing became markup, nothing polluted Object.prototype. */
async function assertInert(tab: Tab, r: Recorded, what: string): Promise<void> {
  assert.equal(await evaluate(tab.s, 'typeof window.__pwned'), 'undefined', `${what}: window.__pwned is never set`);
  assert.deepEqual(tab.csp, [], `${what}: no CSP report (an inline handler or script would be one)`);
  assert.deepEqual(tab.exceptions, [], `${what}: no uncaught exception`);
  for (const name of ['img', 'svg', 'iframe', 'frame', 'object', 'embed', 'a', 'form', 'math', 'video', 'audio', 'source', 'base', 'style', 'template']) {
    assert.ok(!r.elements.includes(name), `${what}: no <${name}> element was ever created`);
  }
  assert.ok(!r.attributes.some((a) => a.startsWith('on') || a === 'srcdoc' || a === 'formaction' || a.includes(':')), `${what}: no handler or namespaced attribute: ${r.attributes.join(' ')}`);
  assert.deepEqual(await evaluate(tab.s, '[document.scripts.length, document.querySelectorAll("[src],[href]").length]'), [1, 2], `${what}: only the shell's script and stylesheet`);
  assert.equal(await evaluate(tab.s, 'Object.getOwnPropertyNames(Object.prototype).sort().join(",")'), r.protoNames, `${what}: Object.prototype unchanged`);
  assert.equal(await evaluate(tab.s, '({}).polluted === undefined && Object.keys(Object.prototype).length === 0'), true);
}

/** The demo log's canary fields: room labels and branches, display names (join ops), change-set paths and caption texts. */
function demoCanaries(log: DemoLog): { rooms: Canary[]; paths: Canary[]; captions: Canary[]; displays: string[] } {
  const rooms = log.rooms.flatMap((r) => [
    { field: `room ${r.room} label`, raw: r.name, served: vizText('room', r.name) },
    { field: `room ${r.room} branch`, raw: r.branch, served: vizText('branch', r.branch) },
  ]);
  const commits = [...log.commits.values()].flat();
  const paths = commits.flatMap((c) => [...c.csPaths.values()].flat()).map((p) => ({ field: `path ${p}`, raw: p, served: vizText('path', p) }));
  const captions = log.captions.map((c) => ({ field: `caption at ${c.height}`, raw: c.text!, served: vizText('caption', c.text!) }));
  const displays = commits.flatMap((c) => c.ops.map((o) => JSON.parse(o) as { type: string; display?: string })).filter((o) => o.type === 'join').map((o) => o.display!);
  return { rooms, paths, captions, displays };
}

test('(e) the XSS canary demo never sets window.__pwned and every canary string renders as text', { skip: SKIP, timeout: 90_000 }, async () => {
  // The fixture: a valid demo log whose names, branches, room labels, paths and captions carry the whole corpus.
  const parsed = parseDemoLog(readFileSync(CANARY_DEMO), new Set());
  assert.ok(!('line' in parsed), `the canary demo parses (${JSON.stringify(parsed)})`);
  const c = demoCanaries(parsed);
  const fields = [...c.rooms.map((x) => x.raw), ...c.paths.map((x) => x.raw), ...c.captions.map((x) => x.raw), ...c.displays];
  for (const [k, s] of Object.entries(XSS_CORPUS)) assert.ok(fields.some((f) => f.includes(s)), `the demo carries the corpus entry ${k}`);
  assert.ok(c.paths.length > 0 && c.captions.length > 0 && c.displays.length > 0);

  // The demo replays from h0 at 1× (one beat per height, every caption for its beat), then rests at its last height.
  const v = await inProcessViewer({ demo: CANARY_DEMO });
  const tab = await openTab(servedOf(v.port, v.launch).link, { record: { tags: [] } });
  await waitLive(tab);
  const stored = await storedOf(tab);
  await waitFor(tab, REPLAY_DONE, 60_000);
  const r = await recordedOf(tab);
  await assertInert(tab, r, 'canary demo');
  // Every canary reaches the page as text: room a's label and branch in the header, room b's on its map button, the change-set's
  // paths as file chips, each caption in the caption strip at its beat, and every served name tag of the shown room (a hostile
  // display shows peer-<handle>, validName) in the log or on the canvas.
  for (const x of [...c.rooms, ...c.paths, ...c.captions]) assert.ok(renders(r, x.served), `${x.field} renders as text: ${JSON.stringify(x.served)}`);
  const names = await namesOf(v.port, stored!.session);
  assert.equal(names.length, parsed.commits.get('a')!.flatMap((x) => x.ops).filter((o) => o.includes('"type":"join"')).length, 'a name tag per person');
  for (const n of names) assert.ok(renders(r, n), `the name tag ${JSON.stringify(n)} renders as text`);

  // The same corpus through Plan 2-shaped data (S20): notes, requests, answers, claims and cards from fake stores; the poll delivers
  // a note, an answer and a request live, so their bubbles (canvas) and quoted frames (log) render.
  const x = xssStores();
  const sv = await inProcessViewer({}, { stores: x.stores });
  const st = await openTab(servedOf(sv.port, sv.launch).link, { record: { tags: [] } });
  await waitLive(st);
  x.release();
  const quoted = XSS_ROOM.notes.map((n) => vizText('note', n));
  await waitFor(st, `(() => { const q = [...document.querySelectorAll('blockquote')].map((b) => b.textContent); return ${JSON.stringify(quoted)}.every((n) => q.includes(n)); })()`, 20_000);
  await delay(1_500);                                     // the live beat's bubbles
  const sr = await recordedOf(st);
  await assertInert(st, sr, 'fake stores');
  for (const n of quoted) assert.ok(sr.texts.includes(n), `the quoted frame shows ${JSON.stringify(n)}`);
  // Each live note, answer and request draws a bubble: a canvas line (wrapped, perhaps ellipsized) of its own text — never the room
  // label, which the map plate draws and which the first request's note begins with.
  const label = vizText('room', XSS_ROOM.label);
  for (const n of quoted.slice(1)) {
    const lines = sr.canvas.map((t) => t.replace(/\u{2026}$/u, '').trim()).filter((t) => t.length >= 8 && t !== label && n.includes(t));
    assert.ok(lines.length > 0, `a bubble draws ${JSON.stringify(n)}: ${JSON.stringify(sr.canvas)}`);
  }
  // The claim label shows in the hidden people list (UI_VIZ_HOLDING {label}); the room's label, branch, paths and name tags as text.
  const claim = vizText('label', XSS_ROOM.claimLabel.simple);
  for (const t of [claim, label, vizText('branch', XSS_ROOM.branch), ...XSS_ROOM.paths.map((p) => vizText('path', p))]) {
    assert.ok(renders(sr, t), `${JSON.stringify(t)} renders as text`);
  }
  const sessionS = (await storedOf(st))!.session;
  for (const n of await namesOf(sv.port, sessionS)) assert.ok(renders(sr, n), `the name tag ${JSON.stringify(n)} renders as text`);
  await tab.s.close();
  await st.s.close();
});

/** The name tags the viewer serves for the room a fresh tab shows (the first, 12 §3.2 item 11): CharacterVM.name. */
async function namesOf(port: number, session: string): Promise<string[]> {
  const w = await worldOf(port, session);
  return w.rooms[0]!.characters.map((ch) => ch.name);
}

// ---------------------------------------------------------------------------------------------------------------------------
// (f) another local origin

test('(f) a page served from another local port reads nothing from /api/v1/world with or without a copied session header, and an iframe of the viewer is refused', { skip: SKIP, timeout: 60_000 }, async () => {
  const v = real!;
  const session = (await storedOf(main!))!.session;
  // The copied header is a working credential: the same request without a browser around it reads the world.
  assert.equal((await apiGet(v.port, session, '/api/v1/world')).status, 200);

  const attacker = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>another page</title></head><body></body></html>');
  });
  await new Promise<void>((resolve) => attacker.listen({ host: '127.0.0.1', port: 0 }, resolve));
  try {
    const port = (attacker.address() as AddressInfo).port;
    assert.notEqual(port, v.port);
    const tab = await openTab(`http://127.0.0.1:${port}/`);
    try {
      const target = `${v.origin}/api/v1/world`;
      const reads = await evaluate<Record<string, { ok: boolean; type?: string; status?: number; body?: string; error?: string }>>(tab.s, `(async () => {
        const read = async (init) => {
          try {
            const r = await fetch(${JSON.stringify(target)}, init);
            let body = '';
            try { body = await r.text(); } catch (e) { body = ''; }
            return { ok: true, type: r.type, status: r.status, body };
          } catch (e) {
            return { ok: false, error: String(e) };
          }
        };
        const h = { 'X-Cowork-Session': ${JSON.stringify(session)} };
        return {
          plain: await read({}),
          header: await read({ headers: h }),
          credentials: await read({ headers: h, credentials: 'include' }),
          noCors: await read({ mode: 'no-cors' }),
          noCorsHeader: await read({ mode: 'no-cors', headers: h }),
        };
      })()`);
      // Nothing readable: every read rejects (an opaque response would have no status and no body either).
      for (const [k, r] of Object.entries(reads)) {
        assert.ok(!r.ok || (r.type === 'opaque' && r.status === 0 && r.body === ''), `${k}: nothing readable (${JSON.stringify(r)})`);
        assert.doesNotMatch(JSON.stringify(r), /cursor|rooms|room_id/, `${k}: no world data`);
      }
      // The browser failed each of the five fetches: the CORS ones (no Access-Control-Allow-Origin, on the response or the preflight)
      // and the no-cors ones (Cross-Origin-Resource-Policy: same-origin).
      const fetches = tab.requests.filter((r) => r.url === target && r.method === 'GET');
      assert.equal(fetches.length, 5, 'five fetches were sent');
      for (const r of fetches) {
        const f = tab.failures.get(r.id);
        assert.ok(f !== undefined && (f.corsError !== null || f.blockedReason === 'corp-not-same-origin'), `GET ${r.url} failed in the browser: ${JSON.stringify(f)}`);
      }
      // What reached the viewer it refused (403: another Origin, or a cross-site fetch), with no Access-Control-* header (VIZ-31).
      const answered = tab.requests.filter((r) => r.url.startsWith(`${v.origin}/`) && tab.statuses.has(r.id));
      assert.ok(answered.length > 0, 'the viewer answered some of them');
      for (const r of answered) {
        assert.equal(tab.statuses.get(r.id), 403, `${r.method} ${r.url}`);
        const headers = Object.keys(tab.rawHeaders.get(r.id) ?? {}).map((h) => h.toLowerCase());
        assert.ok(!headers.some((h) => h.startsWith('access-control-')), `${r.method} ${r.url}: ${headers.join(' ')}`);
      }

      // An iframe of the viewer: the framed document is refused (403, and frame-ancestors 'none' / X-Frame-Options DENY) and blocked.
      await evaluate<string>(tab.s, `new Promise((resolve) => {
        const f = document.createElement('iframe');
        f.onload = () => resolve('load');
        setTimeout(() => resolve('timeout'), 5000);
        f.src = ${JSON.stringify(`${v.origin}/`)};
        document.body.appendChild(f);
      })`);
      const doc = tab.requests.filter((r) => r.url === `${v.origin}/`);
      assert.equal(doc.length, 1, 'the frame asked the viewer once');
      const blocked = tab.failures.get(doc[0]!.id);
      assert.ok(blocked !== undefined && blocked.type === 'Document' && blocked.errorText.startsWith('net::ERR_BLOCKED_BY_RESPONSE'), `the framed document is blocked: ${JSON.stringify(blocked)}`);
      assert.ok(tab.csp.some((x) => x.includes("frame-ancestors 'none'")), `the framing is reported: ${JSON.stringify(tab.csp)}`);
      const navigated: string[] = [];
      tab.s.on('Page.frameNavigated', (p) => navigated.push((p as { frame: { url: string } }).frame.url));
      assert.ok(!navigated.includes(`${v.origin}/`), 'no frame ever showed the viewer');
    } finally {
      await tab.s.close();
    }
  } finally {
    attacker.closeAllConnections();
    await new Promise<void>((resolve) => attacker.close(() => resolve()));
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// (g) reduced motion

test('(g) with emulated prefers-reduced-motion the root carries data-motion="reduced" and no walk frame is drawn', { skip: SKIP, timeout: 90_000 }, async () => {
  // The six-height story (12 §3.9.3 shape): Bob enters at height 1 and Ann walks to her desk at height 2, so the replay walks.
  const file = join(viewerTemp('smoke-story'), 'story.jsonl');
  writeFileSync(file, demoBuffer([headerLine([{ room: 'a', name: 'shop-app', branch: 'main' }]), ...storyLines('a')]));
  const reducedV = await inProcessViewer({ demo: file });
  const controlV = await inProcessViewer({ demo: file });
  const tags = { tags: ['Ann', 'Bob'] };
  // Both replays at once: one tab with the OS setting emulated, one without (the control, which must show walk frames).
  const [reduced, control] = await Promise.all([
    openTab(servedOf(reducedV.port, reducedV.launch).link, { reduced: true, record: tags }),
    openTab(servedOf(controlV.port, controlV.launch).link, { record: tags }),
  ]);
  await Promise.all([waitLive(reduced), waitLive(control)]);
  await Promise.all([waitFor(reduced, REPLAY_DONE, 60_000), waitFor(control, REPLAY_DONE, 60_000)]);
  assert.equal(await evaluate(reduced.s, 'document.documentElement.getAttribute("data-motion")'), 'reduced');
  assert.equal(await evaluate(reduced.s, 'matchMedia("(prefers-reduced-motion: reduce)").matches'), true);
  assert.equal(await evaluate(control.s, 'document.documentElement.getAttribute("data-motion")'), null);
  const r = await recordedOf(reduced);
  const k = await recordedOf(control);
  assert.ok(k.walkDraws > 0, `the control draws walk frames (${k.walkDraws} of ${k.tagDraws} name tags)`);
  assert.ok(r.tagDraws > 0, 'the reduced tab draws its characters');
  assert.equal(r.walkDraws, 0, `no walk frame under reduced motion: ${JSON.stringify(r.walks)}`);
  assert.ok(r.layerDraws < k.layerDraws, `fewer frames drawn under reduced motion (${r.layerDraws} vs ${k.layerDraws})`);
  assert.deepEqual([reduced.csp, control.csp, reduced.exceptions, control.exceptions], [[], [], [], []]);
  await reduced.s.close();
  await control.s.close();
});

// ---------------------------------------------------------------------------------------------------------------------------
// (i) accessibility

test('(i) the canvas has the UI_VIZ_SCENE_SUMMARY label and the hidden people list exists', { skip: SKIP, timeout: 60_000 }, async () => {
  const tab = main!;
  const template = EN_VIZ['UI_VIZ_SCENE_SUMMARY']!.text;
  const shape = new RegExp(`^${template.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(people|sessions|open|conflicts)\}/g, '(\\d+)')}$`);
  const a = await evaluate<{ role: string | null; label: string | null; listClass: string | null; rows: string[]; position: string; visible: boolean }>(tab.s, `(() => {
    const c = document.querySelector('section.office canvas');
    const ul = document.querySelector('section.office ul.people');
    const style = ul === null ? null : getComputedStyle(ul);
    return {
      role: c && c.getAttribute('role'), label: c && c.getAttribute('aria-label'), listClass: ul && ul.className,
      rows: ul === null ? [] : [...ul.querySelectorAll('li > button:first-child')].map((b) => b.textContent),
      position: style === null ? '' : style.position, visible: style !== null && style.display !== 'none' && style.visibility !== 'hidden',
    };
  })()`);
  assert.equal(a.role, 'img');
  const m = shape.exec(a.label ?? '');
  assert.ok(m !== null, `the canvas label is UI_VIZ_SCENE_SUMMARY: ${JSON.stringify(a.label)} (template ${JSON.stringify(template)})`);
  // The hidden list: visually hidden (sr-only), still in the accessibility tree, one row per character and live pet (its person button
  // first, then its follow toggle, 12 §3.8.1).
  assert.equal(a.listClass, 'people sr-only');
  assert.equal(a.position, 'absolute');
  assert.equal(a.visible, true, 'hidden visually, not from screen readers');
  const people = Number(m[1]), sessions = Number(m[2]);
  assert.equal(a.rows.length, people + sessions, `one row per character: ${JSON.stringify(a.rows)}`);
  assert.ok(a.rows.length > 0 && a.rows.every((t) => t.length > 0));
});

// ---------------------------------------------------------------------------------------------------------------------------
// (k) following a teammate (12 §3.8.1, rev 2.5, F32): nothing sent, stored or logged

/** A valid two-room cowork-viz-demo/1 log (rooms a and b, the six-height story each; test/fixtures/viz/two-rooms.jsonl). */
const TWO_ROOMS = join(REPO, 'test', 'fixtures', 'viz', 'two-rooms.jsonl');
/** The page's follow toggle on the person-filter chip (UI_VIZ_CTRL_FOLLOW, aria-pressed); null while it is hidden. */
const FOLLOW_TOGGLE = `[...document.querySelectorAll('aside.log .filters button')].find((b) => !b.hidden && b.textContent === ${JSON.stringify(EN_VIZ['UI_VIZ_CTRL_FOLLOW']!.text)}) ?? null`;
/** What a tab keeps in its storage and URL. */
const KEPT = `({ local: JSON.stringify(Object.entries(localStorage)), session: Object.keys(sessionStorage), hash: location.hash })`;

test('(k) T-VIZ-follow-privacy: following sends, stores and logs nothing', { skip: SKIP, timeout: 120_000 }, async () => {
  const log = parseDemoLog(readFileSync(TWO_ROOMS), new Set());
  assert.ok(!('line' in log), `the two-room demo parses (${JSON.stringify(log)})`);
  assert.deepEqual(log.rooms.map((r) => r.room), ['a', 'b']);
  const v = await inProcessViewer({ demo: TWO_ROOMS });
  const tab = await openTab(servedOf(v.port, v.launch).link);
  await waitLive(tab);
  await waitFor(tab, REPLAY_DONE, 60_000);                // room a's demo replay has played through (its pages are loaded)
  const session = (await storedOf(tab))!;
  const w = await worldOf(v.port, session.session);
  const [roomA, roomB] = w.rooms.map((r) => r.room_id) as [string, string];
  const kept = await evaluate<{ local: string; session: string[]; hash: string }>(tab.s, KEPT);
  assert.deepEqual(kept.session, ['X-Cowork-Session'], 'the session is the only sessionStorage entry');
  const logBefore = logLines(v.dataDir);
  const seen = tab.requests.length;
  const hashes: string[] = [];
  const hash = async (): Promise<void> => {
    hashes.push(await evaluate<string>(tab.s, 'location.hash'));
  };
  const pressed = (): Promise<string | null> => evaluate(tab.s, `(() => { const b = ${FOLLOW_TOGGLE}; return b && b.getAttribute('aria-pressed'); })()`);
  const nowCard = (): Promise<string | null> => evaluate(tab.s, '(() => { const n = document.querySelector("aside.log section.now"); return n === null || n.hidden ? null : n.getAttribute("aria-label"); })()');

  // A person filter from the hidden people list (its first row's person button): the follow toggle shows, not pressed.
  assert.equal(await pressed(), null, 'no toggle without a person filter');
  await evaluate(tab.s, 'document.querySelector("section.office ul.people li > button").click(), true');
  assert.equal(await pressed(), 'false');
  // The followed person's name tag: the first people-list row's text starts with it.
  const row = await evaluate<string>(tab.s, 'document.querySelector("section.office ul.people li > button").textContent');
  const followed = row.split(' \u{00B7} ')[0]!;
  assert.ok(w.rooms[0]!.characters.some((c) => c.name === followed), `${followed} is a character of room a`);
  // Toggling 50 times: each click flips aria-pressed and shows or hides the now card, labelled UI_VIZ_FOLLOWING.
  for (let i = 1; i <= 50; i++) {
    await evaluate(tab.s, `(${FOLLOW_TOGGLE}).click(), true`);
    const on = i % 2 === 1;
    assert.equal(await pressed(), String(on), `toggle ${i}`);
    assert.equal(await nowCard(), on ? `Following ${followed}` : null, `toggle ${i}: the now card`);
    await hash();
  }
  // F (focus not in a form control) follows again; the people list's own follow toggle shows it pressed.
  await evaluate(tab.s, 'document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "F", bubbles: true })), true');
  assert.equal(await pressed(), 'true', 'F follows the person filter');
  assert.equal(await nowCard(), `Following ${followed}`);
  assert.equal(await evaluate(tab.s, '[...document.querySelectorAll("section.office ul.people li > button[aria-pressed=\\"true\\"]")].length'), 1);
  // Switching rooms: room b has no follow (no person filter, no now card); back in room a the follow is back and pins the filter.
  const room = (id: string): Promise<unknown> => evaluate(tab.s, `[...document.querySelectorAll('nav.map ul.rooms button')][${JSON.stringify([roomA, roomB])}.indexOf(${JSON.stringify(id)})].click(), true`);
  await room(roomB);
  assert.deepEqual([await pressed(), await nowCard()], [null, null], 'room b: no follow');
  await hash();
  // Seeking in room b: its first replay position needs timeline pages (the only requests this test allows).
  await evaluate(tab.s, 'document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true })), true');
  await waitFor(tab, `document.querySelector('footer.rewind button.live-pill').getAttribute('aria-pressed') === 'false'`, 15_000);
  await hash();
  await room(roomA);
  assert.deepEqual([await pressed(), await nowCard()], ['true', `Following ${followed}`], 'room a: its follow is back');
  for (const key of ['ArrowLeft', 'ArrowLeft', 'PageUp', 'ArrowRight', 'L']) {
    await evaluate(tab.s, `document.body.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true })), true`);
    await delay(100);
    assert.equal(await nowCard(), `Following ${followed}`, `${key}: the now card follows the drawn scene`);
    await hash();
  }
  await delay(500);

  // Nothing sent: every request since the baseline is a timeline page a seek needed.
  const page = new RegExp(`^http://127\\.0\\.0\\.1:${v.port}/api/v1/rooms/r[0-9A-HJKMNP-TV-Z]{8}/timeline\\?from=\\d+&to=\\d+$`);
  const sent = tab.requests.slice(seen);
  assert.ok(sent.length > 0, 'the seek in room b needed timeline pages');
  for (const r of sent) assert.match(r.url, page, `${r.method} ${r.url}`);
  // Nothing stored: localStorage unchanged; sessionStorage holds the session with the selected room id only (12 §3.2 item 11).
  const after = await evaluate<{ local: string; session: string[]; hash: string }>(tab.s, KEPT);
  assert.equal(after.local, kept.local, 'localStorage unchanged');
  assert.deepEqual(after.session, ['X-Cowork-Session']);
  assert.deepEqual(await storedOf(tab), { session: session.session, room: roomA }, 'the session and the selected room id, nothing else');
  // Never in the URL, never logged.
  assert.deepEqual([...new Set(hashes)], [''], 'location.hash never held follow state');
  assert.deepEqual(logLines(v.dataDir), logBefore, 'the viewer log gained no line');
  assert.deepEqual([tab.csp, tab.exceptions], [[], []]);
  await tab.s.close();
});

// ---------------------------------------------------------------------------------------------------------------------------
// Page budgets (12 §3.12, R-V41, F6)

test('page budgets: JS heap ≤ 150 MB and CPU while animating ≤ 20 % of one core (2×, R-V41) over 60 s of the bundled demo replaying at 1×', {
  skip: SKIP !== false ? SKIP : !SLOW ? 'slow suite: set COWORK_VIZ_SLOW=1 (a 60 s measurement)' : false,
  timeout: 180_000,
}, async (t) => {
  // A fresh real viewer and tab: the bundled demo replays from its first height at 1× while the page is measured.
  const v = await startRealViewer(join(await buildDistOnce(), 'viz.js'), dataDir);
  try {
    const tab = await openTab(v.link);
    await waitLive(tab);
    // The page animates while it is measured (Plan 8a final review, fix Group D; ledger L151): the demo replay has started (Play
    // pressed) at the first sample, and the rewind position has moved on by at least 50 heights at the last (60 s at 1× are 75 beats
    // of 800 ms; the replay steps from event to event, so it may end early, never below 50 heights of a ≈ 100-height demo).
    const rewindOf = (): Promise<{ playing: boolean; at: number }> => evaluate(tab.s, `(() => {
      const bar = document.querySelector('footer.rewind');
      return { playing: bar.querySelector('button.control').getAttribute('aria-pressed') === 'true', at: Number(bar.querySelector('input.slider').value) };
    })()`);
    await waitFor(tab, `document.querySelector('footer.rewind button.control').getAttribute('aria-pressed') === 'true'`);
    await tab.s.send('Performance.enable', { timeDomain: 'timeTicks' });
    const metrics = async (): Promise<Map<string, number>> => {
      const r = (await tab.s.send('Performance.getMetrics')) as { metrics: Array<{ name: string; value: number }> };
      return new Map(r.metrics.map((x) => [x.name, x.value]));
    };
    const first = await metrics();
    const from = await rewindOf();
    assert.equal(from.playing, true, 'Play is pressed at the first sample');
    let heap = first.get('JSHeapUsedSize')!;
    const end = Date.now() + 60_000;
    let last = first;
    while (Date.now() < end) {
      await delay(Math.min(5_000, Math.max(0, end - Date.now())));
      last = await metrics();
      heap = Math.max(heap, last.get('JSHeapUsedSize')!);
    }
    const to = await rewindOf();
    const wall = last.get('Timestamp')! - first.get('Timestamp')!;
    const cpu = (last.get('TaskDuration')! - first.get('TaskDuration')!) / wall;
    t.diagnostic(`page over ${wall.toFixed(1)} s: JS heap ${(heap / MB).toFixed(1)} MB at most; main-thread tasks ${(cpu * 100).toFixed(2)} % of one core; the replay went from #${from.at} to #${to.at} (playing at the end: ${to.playing})`);
    assert.ok(to.at - from.at >= 50, `the replay moved on by ${to.at - from.at} heights (#${from.at} → #${to.at}): the page animated while measured`);
    assert.ok(wall >= 59, `measured over ${wall} s`);
    assert.ok(heap <= 150 * MB, `JS heap ${(heap / MB).toFixed(1)} MB`);
    assert.ok(cpu <= 0.2, `CPU ${(cpu * 100).toFixed(2)} % of one core`);
    assert.deepEqual([tab.csp, tab.exceptions], [[], []]);
    await tab.s.close();
  } finally {
    v.stop();
  }
});
