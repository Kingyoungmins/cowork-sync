// Plan 8a Task 15: what the viewer process must never serve or log (12 §3.10.6, §3.10.10, §7 T-VIZ-clock, T-VIZ-view-model,
// T-VIZ-logs, T-VIZ-notes; VIZ-11, VIZ-25, VIZ-35, VIZ-38; INV-CLOCK, INV-VIZ-NOCONTENT; F18). One run over a real clone whose
// board carries a co-author opt-in and a config fingerprint, a hostile demo log (the text corpus), the admission corpus of
// T-VIZ-admission sent as raw bytes, a fake home whose Claude directories hold transcript, prompt and tool-input canaries (the
// data directory lies inside it, as it does by default), and a missing board object so the stores log errors; then every
// response, stream payload and viewer log line of the run is scanned.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { buildDaemonEnv } from '../../../src/git/env.js';
import type { Oid } from '../../../src/git/oid.js';
import { VirtualClock } from '../../sim/vclock.js';
import { captionLine, demoBuffer, headerLine, storyLines } from '../../helpers/vizDemo.js';
import { spyFs, type FsCall } from '../../helpers/vizFs.js';
import { openStream, rawRequest, request } from '../../helpers/vizHttp.js';
import { hideObject, pubs, writeStatus } from '../../helpers/vizStore.js';
import { apiGet, datesIn, gitRoomsFixture, logLines, startTestViewer, viewerTemp, worldOf, type RoomsFixture } from '../../helpers/vizViewer.js';

const C = {
  transcript: 'COWORK_CANARY_TRANSCRIPT_5d1e', prompt: 'COWORK_CANARY_PROMPT_7a2f', tool: 'COWORK_CANARY_TOOLINPUT_93b4',
  settings: 'COWORK_CANARY_SETTINGS_c0de', header: 'headercanary-41f9', url: 'urlcanary-8e2a', path: 'pathcanary',
  name: 'Zelda Quintus', coauthorName: 'Annabel Vale', email: 'annabel.vale@corp.example',
};
const FINGERPRINT_KEYS = ['filters', 'autocrlf', 'eol_attrs'];

/** Everything the run served (bodies and stream payloads) and the viewer log lines, with the run's secrets and paths. */
interface Corpus { responses: string[]; streams: string[]; logs: string[]; tokens: string[]; paths: string[]; fsCalls: FsCall[]; claude: string; dataDirs: string[]; }
let corpus: Corpus;
let f: RoomsFixture;

before(async () => {
  f = await gitRoomsFixture('viz-canaries', 1);
  const p1 = f.clones[0]!;
  await p1.writer.join('carol', { display: C.name, coauthorOptin: `${C.coauthorName} <${C.email}>` });
  await p1.writer.commitMany(pubs(20, 'src'));
  await p1.writer.commit({ writer: 'carol', cs: [{ paths: [`${C.path}/secret-plan.txt`] }] });
  writeStatus(p1.paths.gitDir, {});
  // A repository settings file of Claude Code.
  mkdirSync(join(p1.dir, '.claude'), { recursive: true });
  writeFileSync(join(p1.dir, '.claude', 'settings.local.json'), `{"permissions":"${C.settings}"}\n`);

  // The fake home: Claude's transcripts, prompt history, tool inputs and settings; the data directory inside it.
  const home = viewerTemp('canary-home');
  const claude = join(home, '.claude');
  mkdirSync(join(claude, 'projects', 'p1'), { recursive: true });
  writeFileSync(join(claude, 'projects', 'p1', 'session.jsonl'), `{"type":"user","message":"${C.transcript}"}\n`);
  writeFileSync(join(claude, 'history.jsonl'), `{"display":"${C.prompt}"}\n`);
  mkdirSync(join(claude, 'todos'), { recursive: true });
  writeFileSync(join(claude, 'todos', 'tool.json'), `{"tool_input":"${C.tool}"}\n`);
  writeFileSync(join(claude, 'settings.json'), `{"env":{"X":"${C.settings}"}}\n`);
  const env = { ...buildDaemonEnv(process.env as Record<string, string | undefined>, []), HOME: home, USERPROFILE: home };

  const responses: string[] = [];
  const streams: string[] = [];
  const tokens: string[] = [];
  const fsCalls: FsCall[] = [];
  const dataDirs: string[] = [];
  const body = (b: Buffer): void => { responses.push(b.toString('utf8')); };

  // The git room.
  let restore = (): void => {};
  const clock = new VirtualClock();
  const dataDir = join(claude, 'plugins', 'data', 'cowork-sync');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  dataDirs.push(dataDir);
  const v = await startTestViewer({ repos: [p1.dir], dataDir }, { clock, env, fs: spyFs(fsCalls) });
  try {
    tokens.push(v.launch);
    const sres = await request(v.port, { method: 'POST', path: '/api/v1/session', headers: { origin: `http://127.0.0.1:${v.port}`, 'x-cowork-launch': v.launch } });
    const s = (JSON.parse(sres.body.toString('utf8')) as { session: string }).session;
    tokens.push(s);
    const st = await openStream(v.port, { 'x-cowork-session': s });
    const world = await worldOf(v.port, s);
    responses.push(JSON.stringify(world));
    for (const r of world.rooms) body((await apiGet(v.port, s, `/api/v1/rooms/${r.room_id}/timeline?from=0&to=${r.window.h1}`)).body);
    for (const p of ['/', '/app.js', '/app.css', '/api/v1/strings?lang=en']) body((await apiGet(v.port, s, p)).body);
    // A commit whose live commit the clone lacks arrives: the store logs an error (UI_VIZ_NO_BOARD) and keeps its last scene.
    await p1.writer.commit({ writer: 'ann', cs: [{ paths: ['src/late.txt'] }] });
    restore = hideObject(p1.paths.gitDir, (await p1.repo.readCommit(p1.writer.tip().oid)).parents[1]! as Oid);
    // The admission corpus, each with a header-value canary and some with a URL canary.
    const host = `127.0.0.1:${v.port}`;
    const corpusRequests = [
      `GET /api/v1/world HTTP/1.1\r\nHost: evil.test:${v.port}\r\nX-Canary: ${C.header}\r\n\r\n`,
      `GET /api/v1/world HTTP/1.1\r\nHost: ${host}\r\nOrigin: http://evil.test\r\nX-Canary: ${C.header}\r\n\r\n`,
      `GET /api/v1/world HTTP/1.1\r\nHost: ${host}\r\nSec-Fetch-Site: cross-site\r\nX-Canary: ${C.header}\r\n\r\n`,
      `OPTIONS /api/v1/world HTTP/1.1\r\nHost: ${host}\r\nAccess-Control-Request-Private-Network: true\r\nX-Canary: ${C.header}\r\n\r\n`,
      `GET /api/v1/world HTTP/1.1\r\nHost: ${host}\r\nX-Canary: ${C.header}${'a'.repeat(9_000)}\r\n\r\n`,
      `GET http://evil.test/${C.url} HTTP/1.1\r\nHost: ${host}\r\nX-Canary: ${C.header}\r\n\r\n`,
      `GET /api/v1/stream HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Canary: ${C.header}\r\n\r\n`,
      `CONNECT evil.test:443 HTTP/1.1\r\nHost: ${host}\r\nX-Canary: ${C.header}\r\n\r\n`,
      `GET /api/v1/world HTTP/1.1\r\nHost: ${host}\r\nX-Cowork-Session: ${'c'.repeat(64)}\r\nX-Canary: ${C.header}\r\n\r\n`,
      `GET /api/v1/rooms/${C.url}/../../timeline?from=${C.url} HTTP/1.1\r\nHost: ${host}\r\nX-Cowork-Session: ${s}\r\nX-Canary: ${C.header}\r\n\r\n`,
      `GET /${C.url}%2F..%2F.claude HTTP/1.1\r\nHost: ${host}\r\nX-Canary: ${C.header}\r\n\r\n`,
      `POST /api/v1/session HTTP/1.1\r\nHost: ${host}\r\nOrigin: http://${host}\r\nX-Cowork-Launch: ${'d'.repeat(64)}\r\nContent-Length: 0\r\nX-Canary: ${C.header}\r\n\r\n`,
      `GET /api/v1/world HTTP/1.1\r\nHost: ${host}\r\nX-Cowork-Session: ${s}\r\nContent-Length: 4\r\nX-Canary: ${C.header}\r\n\r\nbody`,
    ];
    for (const raw of corpusRequests) {
      const r = await rawRequest(v.port, raw);
      responses.push(r.headers.map(([k, x]) => `${k}: ${x}`).join('\n'), r.body.toString('utf8'));
    }
    for (let i = 0; i < 6; i++) {
      clock.advance(2_500);
      await new Promise((r) => setTimeout(r, 400));
    }
    clock.advance(61_000);   // closes the security log windows
    await new Promise((r) => setTimeout(r, 1_200));
    streams.push(...st.messages().filter((m) => !m.comment).map((m) => JSON.stringify(m.data)));
    st.close();
  } finally {
    await v.stop('VIZ_EXIT_SIGNAL');
    restore();
  }

  // The text corpus: a hostile demo log (room label, branch and caption text).
  const demoFile = join(home, 'hostile demo.jsonl');
  writeFileSync(demoFile, demoBuffer([
    headerLine([{ room: 'a', name: `<img src=x onerror=alert(1)> \u{202E}evil`, branch: `</script>javascript:alert(1)` }]),
    ...storyLines('a'),
    captionLine('a', 1, { text: `\u{1B}]8;;https://evil.example\u{7}click\u{1B}]8;;\u{7} \u{200B}\u{E0041}${C.url}` }),
  ]));
  const demoData = join(home, 'demo data');
  mkdirSync(demoData, { recursive: true, mode: 0o700 });
  dataDirs.push(demoData);
  const d = await startTestViewer({ demo: demoFile, dataDir: demoData }, { env, fs: spyFs(fsCalls) });
  try {
    tokens.push(d.launch);
    const s = await d.session();
    tokens.push(s);
    const w = await worldOf(d.port, s);
    responses.push(JSON.stringify(w));
    body((await apiGet(d.port, s, `/api/v1/rooms/${w.rooms[0]!.room_id}/timeline?from=0&to=5`)).body);
  } finally {
    await d.stop('VIZ_EXIT_SIGNAL');
  }

  const logs = dataDirs.flatMap(logLines);
  corpus = { responses, streams, logs, tokens, paths: [home, f.fx.root, p1.dir, dataDir], fsCalls, claude, dataDirs };
});
after(async () => { await f.cleanup(); });

/** The text an absolute path of this PC would show in: a drive letter path, a UNC path or a POSIX path under a usual root. */
const ABSOLUTE = /[A-Za-z]:[\\/]|\\\\[^\\]+\\|(?:^|[\s"'(=])\/(?:Users|home|tmp|var|private|etc|root|opt|mnt|Volumes)\//;

function noneOf(texts: readonly string[], needles: readonly string[], what: string): void {
  for (const t of texts) {
    for (const n of needles) assert.ok(!t.includes(n), `${what} holds ${JSON.stringify(n)}: ${t.slice(0, 300)}`);
    for (const n of needles) assert.ok(!t.toLowerCase().includes(n.toLowerCase()) || n.length < 4, `${what} holds ${JSON.stringify(n)} (case folded)`);
  }
}

test('T-VIZ-clock: no viewer surface renders a date', () => {
  const now = Date.now();
  for (const t of [...corpus.responses, ...corpus.streams, ...corpus.logs]) assert.deepEqual(datesIn(t, now), [], t.slice(0, 300));
  assert.ok(corpus.logs.length > 0 && corpus.streams.length > 0, 'the run served and logged');
});

test('T-VIZ-view-model and T-VIZ-logs (process): no response or log line contains an absolute path, the OS user or host name, a token, a name, a note, a path, a header value or err.message, after the admission and text corpora', () => {
  const user = userInfo().username;
  const host = hostname();
  const served = [...corpus.responses, ...corpus.streams];
  // Responses: no absolute path, OS user or host name, the co-author opt-in, a fingerprint key, a header value or URL canary, and no
  // token (the session token travels only in the redemption answer, which is not in this corpus).
  for (const t of served) assert.ok(!ABSOLUTE.test(t), `an absolute path is served: ${t.slice(0, 300)}`);
  // The OS user and host name, when long enough to mean something in a scan (a CI account may be called `ci`).
  const machine = [user, host].filter((x) => x.length >= 4);
  noneOf(served, [...corpus.paths, ...machine, C.email, C.coauthorName, C.header, ...corpus.tokens], 'a response');
  for (const t of served) {
    if (!t.startsWith('{')) continue;
    const keys = new Set<string>();
    JSON.stringify(JSON.parse(t), (k, x: unknown) => { keys.add(k); return x; });
    for (const k of FINGERPRINT_KEYS) assert.ok(!keys.has(k), `a fingerprint key ${k} is served`);
    assert.ok(!keys.has('git') && !keys.has('config_fingerprint') && !keys.has('coauthor_optin'));
  }
  assert.ok(served.some((t) => t.includes(C.name.split(' ')[0]!)), 'names are served (as name tags) — the scan would see them');
  // Log lines: no token, header value, name, note, path, URL, err.message or absolute path; only the allowed fields.
  assert.ok(corpus.logs.some((l) => l.includes('"SEC_VIZ_BAD_HOST"')), 'the admission corpus is logged (aggregated)');
  assert.ok(corpus.logs.some((l) => l.includes('"frames"')), 'an error is logged');
  for (const l of corpus.logs) {
    assert.ok(!ABSOLUTE.test(l), `an absolute path in a log line: ${l}`);
    const o = JSON.parse(l) as Record<string, unknown>;
    for (const k of Object.keys(o)) assert.ok(!['message', 'stack', 'url', 'path', 'name', 'host'].includes(k), `log field ${k}`);
  }
  noneOf(corpus.logs, [...corpus.paths, ...machine, ...corpus.tokens, C.header, C.url, C.path, C.name, 'Zelda', 'Quintus', 'Ann', 'Bob', 'shop-app', 'src/f', 'evil', 'onerror', 'missing'], 'a log line');
  // At most one line per security code per 60 s of the clock.
  const sec = corpus.logs.map((l) => JSON.parse(l) as { code: string; t: number }).filter((x) => x.code.startsWith('SEC_VIZ_'));
  for (const a of sec) for (const b of sec) if (a !== b && a.code === b.code) assert.ok(Math.abs(a.t - b.t) >= 60_000, `${a.code} twice within 60 s`);
});

test('T-VIZ-notes (process): transcript, prompt and tool-input canaries planted in the fixture PC\'s Claude directories appear in no response, log line or stream payload', () => {
  noneOf([...corpus.responses, ...corpus.streams, ...corpus.logs], [C.transcript, C.prompt, C.tool, C.settings], 'the run');
  // Nor did the viewer touch them: under the Claude directory only the data directory (its SEC-20 check and its log).
  for (const c of corpus.fsCalls) {
    for (const p of c.paths) {
      if (!p.startsWith(corpus.claude)) continue;
      assert.ok(corpus.dataDirs.some((d) => p === d || p.startsWith(`${d}/`) || p.startsWith(`${d}\\`)), `${c.op} ${p}`);
    }
  }
});
