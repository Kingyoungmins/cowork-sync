// Plan 8a Task 18 step A: `node dist/cli.js view --demo` end to end (12 §3.9.3, §3.2, §3.10; the 8a exit criterion "the Plan 2
// storyboard renders in en through node dist/cli.js view --demo", roadmap row 8). runView in tty mode against the built dist/ (the
// real dist/viz.js, spawned as the CLI spawns it, its handle held so the test never signals a bare pid), its URL redeemed, the world
// read, and — where Chrome exists — the build's own page opened on a second run's URL (launchChrome): it draws the office and shows
// the demo banner and a caption. The viewer ends on SIGTERM with bye on its open stream (POSIX: on Windows Node's kill() is
// TerminateProcess, which runs no handler, so there the leg checks only that the process ends; the in-process signal path is
// T-VIZ-lifetime's and T-VIZ-stream's).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { realOwnerProbe } from '../../../src/viz/cli/ownerProbe.js';
import { killTree, openViewerStderr, spawnViewerWith, type ViewerArgs } from '../../../src/viz/cli/spawn.js';
import { runView, URL_RE } from '../../../src/viz/cli/view.js';
import { DEMO_CAPTION_CODES } from '../../../src/viz/i18n/codes.js';
import { EN_VIZ } from '../../../src/viz/i18n/en.js';
import { parseDemoLog } from '../../../src/viz/source/demo.js';
import { browserGateHere, launchChrome } from '../../helpers/cdp.js';
import { assertAllRendered, recordingEnv } from '../../helpers/vizCli.js';
import { openStream } from '../../helpers/vizHttp.js';
import { buildDistOnce, logLines, redeem, viewerTemp, worldOf } from '../../helpers/vizViewer.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const BUNDLED = join(REPO, 'src', 'viz', 'demo', 'plan2.jsonl');
const URL_IN = /http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/#k=[0-9a-f]{64}/;
/** The Chrome leg: SKIPPED without Chrome or on Node < 22; failed instead under COWORK_VIZ_REQUIRE_BROWSER=1 (viz-slow's smoke step)
 *  or when a set COWORK_CHROME names no file (browserGate; Plan 8a final review, fix Group D). */
const GATE = browserGateHere();
const CHROME: string | false = GATE.skip;

/** One `view --demo --no-open` in tty mode over the real spawn (its child held), the real owner probe and the built plugin. */
interface CliRun { url: string; port: number; launch: string; child: ChildProcess; dataDir: string; codes: string[]; }
async function viewDemo(label: string): Promise<CliRun> {
  const dist = await buildDistOnce();
  const root = viewerTemp(label);
  const dataDir = join(root, 'plugin data');
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir };
  let child: ChildProcess | null = null;
  const spawnViewer = (a: ViewerArgs): ReturnType<typeof spawnViewerWith> => spawnViewerWith(a, {
    spawn: (exe, argv, o) => (child = spawn(exe, argv, o)),
    killTree, stderr: openViewerStderr,
  });
  const rec = recordingEnv({ pluginRoot: dirname(dist), cwd: root, home: root, env, spawnViewer, ownerProbe: realOwnerProbe, uid: process.geteuid?.() ?? null });
  assert.equal(rec.env.isTTY, true, 'tty mode');
  const code = await runView(['--demo', '--no-open'], rec.env);
  assert.equal(code, 0, rec.errs.join('\n'));
  assert.ok(child !== null, 'the viewer was spawned');
  const codes = assertAllRendered(rec, { channel: 'terminal', lang: 'en', cmd: null });
  const m = URL_IN.exec(rec.outs.join('\n'));
  assert.ok(m !== null, rec.outs.join('\n'));
  const url = m[0];
  const u = /:([0-9]+)\/#k=([0-9a-f]{64})$/.exec(url)!;
  return { url, port: Number(u[1]), launch: u[2]!, child, dataDir, codes };
}

/** The child's exit, at most `ms` (then null). */
async function exitOf(child: ChildProcess, ms: number): Promise<number | null | 'timeout'> {
  if (child.exitCode !== null) return child.exitCode;
  let timer: NodeJS.Timeout | undefined;
  const r = await Promise.race([
    new Promise<number | null>((resolve) => child.once('exit', (c) => resolve(c))),
    new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), ms); }),
  ]);
  clearTimeout(timer);
  return r;
}
/** Ends a viewer the test still holds, through its handle. */
const endViewer = (child: ChildProcess): void => {
  if (child.exitCode === null && child.signalCode === null) child.kill();
};

test('node dist/cli.js view --demo works end to end', { timeout: 180_000 }, async () => {
  const log = parseDemoLog(readFileSync(BUNDLED), new Set(DEMO_CAPTION_CODES));
  assert.ok(!('line' in log));
  const tip = log.commits.get('a')!.length - 1;

  // The CLI prints UI_VIZ_URL with the launch URL (tty, --no-open), and nothing else.
  const v = await viewDemo('demo-e2e');
  try {
    assert.deepEqual(v.codes, ['UI_VIZ_URL']);
    assert.match(v.url, URL_RE);

    // Redeeming the URL gives a session; the world is the bundled demo: one room, its captions, its scene at h1.
    const session = (await redeem(v.port, v.launch)).session;
    assert.match(session, /^[0-9a-f]{64}$/);
    const world = await worldOf(v.port, session);
    assert.equal(world.demo, true);
    assert.equal(world.rooms.length, 1);
    const room = world.rooms[0]!;
    assert.deepEqual([room.label, room.branch, room.overlay, room.gone], ['shop-app', 'main', null, false]);
    assert.deepEqual(room.window, { h0: 0, h1: tip });
    assert.equal(room.scene.at[0], room.window.h1, 'the scene at h1');
    assert.deepEqual(room.characters.map((c) => c.name).sort(), ['Jun', 'Mina', 'Theo']);
    assert.deepEqual(world.captions, log.captions.map((c) => ({ room_id: room.room_id, height: c.height, code: c.code, text: null })));
    assert.ok(world.captions.length >= 3 && world.captions.every((c) => c.code !== null && EN_VIZ[c.code] !== undefined));

    // SIGTERM through the held handle: bye on the open stream, then the process ends (POSIX; see the file header for Windows).
    const st = await openStream(v.port, { 'x-cowork-session': session });
    try {
      assert.equal(st.status, 200);
      v.child.kill('SIGTERM');
      if (process.platform !== 'win32') {
        await st.waitFor((m) => m.event === 'bye', 15_000);
        await st.ended;
        assert.equal(await exitOf(v.child, 15_000), 0, 'a VizExit ends the viewer with 0');
        assert.ok(logLines(v.dataDir).some((l) => (JSON.parse(l) as { code: string }).code === 'VIZ_EXIT_SIGNAL'), 'the exit is logged');
      } else {
        await st.ended;
        assert.notEqual(await exitOf(v.child, 15_000), 'timeout', 'the viewer ends');
      }
    } finally {
      st.close();
    }
  } finally {
    endViewer(v.child);
  }
});

test('node dist/cli.js view --demo works end to end: with Chrome, the page renders the office and shows UI_VIZ_DEMO_BANNER', { skip: CHROME, timeout: 180_000 }, async () => {
  if (GATE.fail !== null) assert.fail(GATE.fail);
  const v = await viewDemo('demo-e2e-chrome');
  const chrome = await launchChrome(v.url);
  try {
    assert.ok(chrome !== null, 'Chrome starts');
    const evaluate = async <T>(expression: string): Promise<T> => {
      const r = (await chrome.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
      assert.equal(r.exceptionDetails, undefined, expression);
      return r.result?.value as T;
    };
    const waitFor = async <T>(expression: string, ok: (x: T) => boolean, ms = 30_000): Promise<T> => {
      const end = Date.now() + ms;
      let last: T;
      for (;;) {
        last = await evaluate<T>(expression);
        if (ok(last)) return last;
        if (Date.now() > end) assert.fail(`timed out waiting for ${expression} (last: ${JSON.stringify(last)})`);
        await delay(100);
      }
    };
    // The office: the scene canvas with its UI_VIZ_SCENE_SUMMARY label, drawn at a size.
    const office = await waitFor<{ label: string | null; w: number; h: number } | null>(
      '(() => { const c = document.querySelector("section.office canvas[aria-label]"); return c && { label: c.getAttribute("aria-label"), w: c.width, h: c.height }; })()',
      (x) => x !== null && x.w > 0 && x.h > 0 && x.label !== null && x.label.length > 0);
    assert.ok(office !== null);
    // The demo banner, in en.
    const banner = await waitFor<{ hidden: boolean; text: string } | null>(
      '(() => { const b = document.querySelector("div.banner"); return b && { hidden: b.hidden, text: b.textContent }; })()',
      (x) => x !== null && !x.hidden && x.text.length > 0);
    assert.deepEqual(banner, { hidden: false, text: EN_VIZ['UI_VIZ_DEMO_BANNER']!.text });
    // A caption of the storyboard in the caption strip (the replay plays from h0; captions at heights 0, 1 and 3 come first).
    const captions = DEMO_CAPTION_CODES.map((c) => EN_VIZ[c]!.text);
    const shown = await waitFor<string>('(() => { const c = document.querySelector("section.office .caption"); return c === null ? "" : c.textContent; })()', (x) => captions.includes(x));
    assert.ok(captions.includes(shown));
  } finally {
    await chrome?.close();
    endViewer(v.child);
    await exitOf(v.child, 15_000);
  }
});
