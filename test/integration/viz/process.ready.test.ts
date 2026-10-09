// Plan 8a Task 15: the viewer process's start (12 §3.2 items 2–3, §3.10.10; VIZ-02, VIZ-03, VIZ-06; R-V13, R-V16). The real
// dist/viz.js writes exactly one ready line and closes stdout; each refusal is one refuse line; startViewer runs its checks in
// R-V16's order (argv, SEC-20, self-hash, then the demo log or the git floor and room admission, then bind) and folds rooms only
// after the ready values are out; parseServeArgv takes exactly the CLI's argv (R-V13); the SEC-20 re-check comes before log/ and
// the 14-day log cleanup runs at start; on Linux the real viewer's environment is the CLI's builder environment (T-VIZ-env).
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildDaemonEnv } from '../../../src/git/env.js';
import type { GitResult, GitRunner } from '../../../src/git/runner.js';
import { realFs, type Fs } from '../../../src/ports/fs.js';
import { verifyDataDir } from '../../../src/viz/cli/dataDir.js';
import { realOwnerProbe, type OwnerProbe } from '../../../src/viz/cli/ownerProbe.js';
import { excludedRoots, filterPath } from '../../../src/viz/cli/pathTrust.js';
import { parseReadyLine, spawnViewer } from '../../../src/viz/cli/spawn.js';
import { runView } from '../../../src/viz/cli/view.js';
import { IDLE_MS, LIFETIME_MS, parseServeArgv, PLUGIN_CHECK_MS, ROOM_INITS_MAX, startViewer } from '../../../src/viz/main.js';
import type { StoreLike } from '../../../src/viz/server/models.js';
import type { BoundedReader } from '../../../src/viz/source/boundedRead.js';
import { realBoundedReader } from '../../../src/viz/source/boundedRead.js';
import { vizGitRunner } from '../../../src/viz/source/vizGit.js';
import { spyFs, type FsCall } from '../../helpers/vizFs.js';
import { request } from '../../helpers/vizHttp.js';
import { hostFs, passingProbe, recordingEnv } from '../../helpers/vizCli.js';
import { pubs } from '../../helpers/vizStore.js';
import { kinds } from '../../helpers/vizSource.js';
import { buildDistOnce, gitRoomsFixture, logLines, redeem, sha256Of, startTestViewer, testViewerSetup, viewerTemp, worldOf } from '../../helpers/vizViewer.js';

const ok = (stdout: string, code = 0): GitResult => ({ code, stdout: Buffer.from(stdout, 'utf8'), stderr: Buffer.alloc(0), killedByWatchdog: false, aborted: false, durationMs: 0 });
const ABS = join(tmpdir(), 'an absolute dir');
const HEX = 'ab'.repeat(32);

/** A data directory that passes the real SEC-20 check (created as the CLI creates it). */
async function realDataDir(root: string): Promise<string> {
  const dir = join(root, 'data dir');
  assert.deepEqual(await verifyDataDir(dir, { fs: realFs, probe: realOwnerProbe, platform: process.platform, create: true }), { ok: true });
  return dir;
}

interface Served { child: ChildProcess; line: Promise<Buffer>; stdout: Promise<Buffer>; exit: Promise<number | null>; }

/**
 * `node <viz.js> serve …argv` as the CLI starts it (cwd = the data directory, the builder environment). `line`: stdout up to its
 * first LF, as the CLI judges it; `stdout`: everything the process ever wrote there, once the pipe has ended. (On Windows the pipe
 * ends only with the process: its handle is duplicated into the child, so ending stdout in the viewer delivers no EOF earlier.)
 */
function serve(vizJs: string, argv: readonly string[], cwd: string): Served {
  const child = spawn(process.execPath, [vizJs, 'serve', ...argv], {
    shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], cwd, env: buildDaemonEnv(process.env as Record<string, string | undefined>, []),
  });
  const chunks: Buffer[] = [];
  let lineDone: (b: Buffer) => void = () => {};
  const line = new Promise<Buffer>((resolve) => { lineDone = resolve; });
  child.stdout!.on('data', (b: Buffer) => {
    chunks.push(b);
    const all = Buffer.concat(chunks);
    const lf = all.indexOf(0x0a);
    if (lf >= 0) lineDone(all.subarray(0, lf + 1));
  });
  const exit = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  const stdout = new Promise<Buffer>((resolve) => child.stdout!.once('close', () => { const all = Buffer.concat(chunks); lineDone(all); resolve(all); }));
  return { child, line, stdout, exit };
}

/** Waits for the child's exit, at most `ms`; a child still running then is killed through its held handle (never by a bare pid). */
async function exitOf(s: Served, ms: number): Promise<number | null | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const r = await Promise.race([s.exit, new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), ms); })]);
  clearTimeout(timer);
  if (r === 'timeout' && s.child.exitCode === null && s.child.signalCode === null) s.child.kill();
  return r;
}

test('the ready line is exactly one {v:1, port, launch} line and stdout closes; refusals RF_VIZ_START_FAILED (SEC-20, self-hash), START_TOOL_VERSION (a --git that prints git version 2.42), RF_VIZ_NO_ROOMS, RF_VIZ_REPO_NOT_LIVE, RF_VIZ_DEMO_INVALID with its line and RF_VIZ_BIND_FAILED each produce one refuse line', { timeout: 120_000 }, async () => {
  const dist = await buildDistOnce();
  const vizJs = join(dist, 'viz.js');
  const sha = sha256Of(vizJs);
  const root = viewerTemp('ready');
  const dataDir = await realDataDir(root);

  // The real process: one ready line, then nothing more on stdout, and the viewer ends on its own (a reused link).
  const ready = serve(vizJs, ['--data-dir', dataDir, '--lang', 'en', '--sha256', sha, '--demo'], dataDir);
  try {
    const line = await ready.line;
    assert.match(line.toString('utf8'), /^\{"v":1,"port":[1-9][0-9]{0,4},"launch":"[0-9a-f]{64}"\}\n$/);
    const parsed = parseReadyLine(line);
    assert.ok(parsed !== null && 'port' in parsed, 'the CLI accepts the line');
    assert.equal((await request(parsed.port, { path: '/' })).status, 200);
    await redeem(parsed.port, parsed.launch);
    const again = await request(parsed.port, { method: 'POST', path: '/api/v1/session', headers: { origin: `http://127.0.0.1:${parsed.port}`, 'x-cowork-launch': parsed.launch } });
    assert.deepEqual([again.status, JSON.parse(again.body.toString('utf8'))], [401, { code: 'UI_VIZ_LINK_REUSED' }]);
    assert.equal(await exitOf(ready, 15_000), 0, 'a VizExit ends the process with 0');
    assert.deepEqual(await ready.stdout, line, 'stdout carried exactly the one ready line, and ended');
    const lines = logLines(dataDir).map((l) => JSON.parse(l) as { code: string });
    assert.ok(lines.some((l) => l.code === 'SEC_VIZ_LAUNCH_REUSED') && lines.some((l) => l.code === 'VIZ_EXIT_LAUNCH_REUSED'), 'the exit is logged');
  } finally {
    await exitOf(ready, 1);
  }

  // Refusals of the real process: one refuse line, exit 1. A malformed argv refuses before anything is read.
  const refusals: Array<{ argv: string[]; line: string }> = [
    { argv: [], line: '{"v":1,"refuse":"RF_VIZ_START_FAILED"}\n' },
    { argv: ['--data-dir', dataDir, '--lang', 'en', '--sha256', HEX, '--demo'], line: '{"v":1,"refuse":"RF_VIZ_START_FAILED"}\n' },
    { argv: ['--data-dir', dataDir, '--lang', 'en', '--sha256', sha], line: '{"v":1,"refuse":"RF_VIZ_NO_ROOMS"}\n' },
  ];
  const bad = join(root, 'bad demo.jsonl');
  writeFileSync(bad, '{"t":"header","format":"cowork-viz-demo/1","rooms":[{"room":"a","name":"shop","branch":"main"}]}\n{"t":"nope"}\n');
  refusals.push({ argv: ['--data-dir', dataDir, '--lang', 'en', '--sha256', sha, `--demo=${bad}`], line: '{"v":1,"refuse":"RF_VIZ_DEMO_INVALID","line":2}\n' });
  refusals.push({ argv: ['--data-dir', dataDir, '--lang', 'en', '--sha256', sha, '--git', join(root, 'no git here'), '--repo', root], line: '{"v":1,"refuse":"START_TOOL_VERSION"}\n' });
  if (process.platform !== 'win32') {
    // A --git that runs and prints git version 2.42 (below the 2.43 floor). Windows spawns no script without a shell; there the
    // in-process check below covers the same answer through a runner that prints it.
    const oldGit = join(root, 'old git');
    writeFileSync(oldGit, '#!/bin/sh\necho "git version 2.42.0"\n', { mode: 0o755 });
    refusals.push({ argv: ['--data-dir', dataDir, '--lang', 'en', '--sha256', sha, '--git', oldGit, '--repo', root], line: '{"v":1,"refuse":"START_TOOL_VERSION"}\n' });
  }
  for (const r of refusals) {
    const s = serve(vizJs, r.argv, dataDir);
    try {
      const out = await s.stdout;
      assert.equal(out.toString('utf8'), r.line, `serve ${r.argv.join(' ')}`);
      assert.ok(parseReadyLine(out) !== null, 'the CLI accepts the refusal line');
      assert.equal(await exitOf(s, 15_000), 1);
    } finally {
      await exitOf(s, 1);
    }
  }

  // In process, each refusal of startViewer, in R-V16's order: a check never runs before the one ahead of it has passed.
  const spied = (): { fs: Fs; calls: FsCall[]; reader: BoundedReader; reads: string[] } => {
    const calls: FsCall[] = [];
    const reads: string[] = [];
    return { fs: spyFs(calls), calls, reads, reader: { read: (p, max) => { reads.push(p); return realBoundedReader.read(p, max); } } };
  };
  const failing: OwnerProbe = { posix: async () => null, euid: () => null, windows: async () => null };
  {
    // SEC-20 first: nothing else read (not even the viewer's own file), no log/.
    const s = spied();
    const { args, deps } = testViewerSetup({ demo: bad, sha256: HEX }, { fs: s.fs, reader: s.reader, ownerProbe: failing });
    assert.deepEqual(await startViewer(args, deps), { refuse: 'RF_VIZ_START_FAILED' });
    assert.ok(!s.calls.some((c) => c.paths.includes(deps.selfPath)), 'viz.js is not read');
    assert.deepEqual(s.reads, []);
    assert.equal(existsSync(join(args.dataDir, 'log')), false);
  }
  {
    // The self-hash next: the demo file is not read.
    const s = spied();
    const { args, deps } = testViewerSetup({ demo: bad, sha256: HEX }, { fs: s.fs, reader: s.reader });
    assert.deepEqual(await startViewer(args, deps), { refuse: 'RF_VIZ_START_FAILED' });
    assert.ok(s.calls.some((c) => c.op === 'readFile' && c.paths.includes(deps.selfPath)), 'viz.js is hashed');
    assert.deepEqual(s.reads, []);
    // A viz.js that is gone refuses the same way.
    const gone = testViewerSetup({ demo: true }, { selfPath: join(ABS, 'no viz.js') });
    assert.deepEqual(await startViewer(gone.args, gone.deps), { refuse: 'RF_VIZ_START_FAILED' });
  }
  {
    // The demo log: its line, 0 for a file that cannot be read, a directory or a missing file.
    const s = spied();
    const { args, deps } = testViewerSetup({ demo: bad }, { reader: s.reader });
    assert.deepEqual(await startViewer(args, deps), { refuse: 'RF_VIZ_DEMO_INVALID', line: 2 });
    assert.deepEqual(s.reads, [bad]);
    for (const p of [root, join(root, 'missing.jsonl')]) {
      const x = testViewerSetup({ demo: p });
      assert.deepEqual(await startViewer(x.args, x.deps), { refuse: 'RF_VIZ_DEMO_INVALID', line: 0 });
    }
  }
  {
    // The git floor before room admission: git 2.42 refuses with START_TOOL_VERSION and nothing else runs.
    const calls: string[][] = [];
    const old: GitRunner = { run: async (a) => { calls.push([...a]); return ok('git version 2.42.0.windows.1\n'); } };
    const { args, deps } = testViewerSetup({ repos: [root] }, { gitRunner: () => old });
    assert.deepEqual(await startViewer(args, deps), { refuse: 'START_TOOL_VERSION' });
    assert.deepEqual(calls, [['version']]);
    // A git that does not run is no git.
    const broken: GitRunner = { run: async () => ok('', -1) };
    const b = testViewerSetup({ repos: [root] }, { gitRunner: () => broken });
    assert.deepEqual(await startViewer(b.args, b.deps), { refuse: 'START_TOOL_VERSION' });
  }
  {
    // Rooms: none at all, and a --repo that is no live clone.
    const none = testViewerSetup({});
    assert.deepEqual(await startViewer(none.args, none.deps), { refuse: 'RF_VIZ_NO_ROOMS' });
    const notLive = testViewerSetup({ repos: [root] });
    assert.deepEqual(await startViewer(notLive.args, notLive.deps), { refuse: 'RF_VIZ_REPO_NOT_LIVE' });
    assert.ok(logLines(notLive.args.dataDir).some((l) => (JSON.parse(l) as { code: string }).code === 'RF_VIZ_REPO_NOT_LIVE'), 'a refusal after SEC-20 is logged');
  }
  {
    // Bind last: a listener that is not 127.0.0.1 refuses RF_VIZ_BIND_FAILED.
    const address = mock.method(http.Server.prototype, 'address', () => ({ address: '0.0.0.0', family: 'IPv4', port: 40_000 }));
    try {
      const { args, deps } = testViewerSetup({ demo: true });
      assert.deepEqual(await startViewer(args, deps), { refuse: 'RF_VIZ_BIND_FAILED' });
    } finally {
      address.mock.restore();
    }
  }
});

test('rooms fold only after the ready line: startViewer has run the git floor and room admission and nothing else when it returns', async () => {
  const f = await gitRoomsFixture('viz-ready-fold', 1);
  try {
    await f.clones[0]!.writer.commitMany(pubs(20));
    const calls: string[][] = [];
    const { args, deps } = testViewerSetup({ repos: [f.clones[0]!.dir] }, {
      gitRunner: (o) => {
        const inner = vizGitRunner(o);
        return { run: (a, opts) => { calls.push([...a]); return inner.run(a, opts); } };
      },
    });
    const v = await startViewer(args, deps);
    assert.ok(!('refuse' in v));
    try {
      assert.deepEqual(kinds(calls.map((args) => ({ args, stdin: '' }))), ['version', 'for-each-ref --format=%(objectname) %(refname)'], 'no fold before the ready values are out');
      const world = await worldOf(v.port, (await redeem(v.port, v.launch)).session);
      assert.deepEqual(world.rooms.map((r) => r.window), [{ h0: 0, h1: 21 }]);
      assert.ok(calls.some((c) => c[0] === 'cat-file'), 'the room folds after it');
    } finally {
      await v.stop('VIZ_EXIT_SIGNAL');
    }
  } finally {
    await f.cleanup();
  }
});

test('rooms build their first windows at most ROOM_INITS_MAX = 4 at a time (Task 15 fix round 2 ruling): 32 rooms start 4, each finished one starts the next, the poll loop\'s ticks start none of their own, and a stopping viewer starts no more', { timeout: 60_000 }, async () => {
  assert.equal(ROOM_INITS_MAX, 4);
  const N = 32;
  /** 32 stores whose first window waits for the test; tick() starts the store's own init first, as RoomStore.tick does. */
  const rooms = (): { stores: StoreLike[]; started: number[]; ticks(): number; inFlight(): number; max(): number; release(i: number): void } => {
    const started: number[] = [];
    let ticks = 0;
    const gates = new Map<number, () => void>();
    let inFlight = 0;
    let max = 0;
    const stores = Array.from({ length: N }, (_, i): StoreLike & { init(): Promise<void> } => {
      let begun: Promise<void> | null = null;
      let markReady: () => void = () => {};
      const ready = new Promise<void>((resolve) => { markReady = resolve; });
      const init = (): Promise<void> => (begun ??= (async () => {
        started.push(i);
        inFlight += 1;
        max = Math.max(max, inFlight);
        await new Promise<void>((resolve) => { gates.set(i, resolve); });
        inFlight -= 1;
        markReady();
      })());
      return {
        ready, init,
        tick: async () => { ticks += 1; await init(); return { delta: null, overlay: null, change: null }; },
        snapshot: () => { throw new Error('not reached: no world is asked for'); },
        page: async () => null, earlier: async () => null,
      };
    });
    return { stores, started, ticks: () => ticks, inFlight: () => inFlight, max: () => max, release: (i) => { gates.get(i)?.(); } };
  };
  const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => { setImmediate(resolve); }); };

  const r = rooms();
  const v = await startTestViewer({ demo: true }, { stores: r.stores });
  try {
    assert.deepEqual(r.started, [], 'nothing folds before the ready values are out');
    await settle();
    assert.deepEqual(r.started, [0, 1, 2, 3]);
    // The poll loop's first pass (2.5 s) comes while the first four are still building: its tick of room 0 waits for that init and
    // starts none of the others.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    assert.ok(r.ticks() >= 1, 'the poll loop has ticked');
    assert.deepEqual(r.started, [0, 1, 2, 3]);
    // Each finished first window starts the next one (released out of order: the third running one when there is one, else the first).
    const done = new Set<number>();
    while (done.size < N) {
      const open = r.started.filter((i) => !done.has(i));
      assert.ok(open.length > 0, `room ${r.started.length} started after ${done.size} finished`);
      const pick = open.length >= 3 ? open[2]! : open[0]!;
      done.add(pick);
      r.release(pick);
      await settle();
      assert.ok(r.inFlight() <= ROOM_INITS_MAX, `${r.inFlight()} at once`);
    }
    assert.equal(r.started.length, N, 'every room was built');
    assert.deepEqual([...r.started].sort((a, b) => a - b), Array.from({ length: N }, (_, i) => i));
    assert.equal(r.max(), ROOM_INITS_MAX);
    assert.equal(r.inFlight(), 0);
  } finally {
    await v.stop('VIZ_EXIT_SIGNAL');
  }

  // A viewer stopped while rooms wait starts none of them, also when the running ones finish afterwards.
  const s = rooms();
  const w = await startTestViewer({ demo: true }, { stores: s.stores });
  await settle();
  assert.deepEqual(s.started, [0, 1, 2, 3]);
  const stopped = w.stop('VIZ_EXIT_SIGNAL');
  for (const i of [0, 1, 2, 3]) s.release(i);
  await stopped;
  await settle();
  assert.deepEqual(s.started, [0, 1, 2, 3]);
});

test('parseServeArgv takes `serve` and exactly the CLI\'s flags: absolute paths, a 64-hex sha256, one of the six languages, --git exactly with --repo (refused with --demo, R-V13)', () => {
  const base = ['serve', '--data-dir', ABS, '--lang', 'en', '--sha256', HEX];
  assert.deepEqual(parseServeArgv([...base, '--demo']), { dataDir: ABS, lang: 'en', sha256: HEX, repos: [], demo: true, git: null });
  assert.deepEqual(parseServeArgv([...base, `--demo=${join(ABS, 'd.jsonl')}`]), { dataDir: ABS, lang: 'en', sha256: HEX, repos: [], demo: join(ABS, 'd.jsonl'), git: null });
  assert.deepEqual(parseServeArgv([...base, '--git', join(ABS, 'git'), '--repo', join(ABS, 'a'), '--repo', join(ABS, 'b')]),
    { dataDir: ABS, lang: 'en', sha256: HEX, repos: [join(ABS, 'a'), join(ABS, 'b')], demo: null, git: join(ABS, 'git') });
  assert.deepEqual(parseServeArgv(base), { dataDir: ABS, lang: 'en', sha256: HEX, repos: [], demo: null, git: null }, 'no room: RF_VIZ_NO_ROOMS later');
  for (const bad of [
    [...base.slice(1), '--demo'],                                                   // no serve
    [...base, '--git', 'git', '--repo', join(ABS, 'a')],                            // a relative --git
    [...base, '--repo', join(ABS, 'a')],                                            // --repo without --git
    [...base, '--git', join(ABS, 'git'), '--demo'],                                 // --git with --demo
    [...base, '--git', join(ABS, 'git')],                                           // --git without --repo
    [...base, '--git', join(ABS, 'git'), '--repo', join(ABS, 'a'), '--demo'],       // --demo with --repo
    [...base, '--git', join(ABS, 'git'), '--repo', 'rel/a'],                        // a relative --repo
    [...base, '--demo=rel.jsonl'], [...base, '--demo='], [...base, '--demo', '--demo'],
    ['serve', '--data-dir', 'rel', '--lang', 'en', '--sha256', HEX, '--demo'],
    ['serve', '--data-dir', ABS, '--lang', 'xx', '--sha256', HEX, '--demo'],
    ['serve', '--data-dir', ABS, '--lang', 'en', '--sha256', HEX.toUpperCase(), '--demo'],
    ['serve', '--data-dir', ABS, '--data-dir', ABS, '--lang', 'en', '--sha256', HEX, '--demo'],
    [...base, '--demo', '--json'], [...base, '--demo', '--lang'],
    ['serve', '--lang', 'en', '--sha256', HEX, '--demo'],
  ]) assert.equal(parseServeArgv(bad), null, bad.join(' '));
  if (process.platform === 'win32') {
    assert.equal(parseServeArgv(['serve', '--data-dir', '\\\\server\\share\\d', '--lang', 'en', '--sha256', HEX, '--demo']), null, 'a UNC data directory');
    assert.equal(parseServeArgv(['serve', '--data-dir', '\\Users\\d', '--lang', 'en', '--sha256', HEX, '--demo']), null, 'a root-relative path');
  }
  assert.deepEqual([IDLE_MS, LIFETIME_MS, PLUGIN_CHECK_MS], [600_000, 86_400_000, 30_000]);
});

test('the viewer re-runs the SEC-20 check before creating log/ and deletes viz-*.jsonl older than 14 days at start', async () => {
  // A data directory that fails SEC-20: nothing is created in it.
  {
    const calls: FsCall[] = [];
    const { args, deps } = testViewerSetup({ demo: true }, { fs: spyFs(calls), ownerProbe: { ...passingProbe, posix: async () => null, windows: async () => null } });
    assert.deepEqual(await startViewer(args, deps), { refuse: 'RF_VIZ_START_FAILED' });
    assert.equal(existsSync(join(args.dataDir, 'log')), false);
    assert.ok(!calls.some((c) => ['mkdirp', 'readdir', 'appendFile', 'unlink'].includes(c.op)), JSON.stringify(calls));
  }
  // A passing one: the probe ran before log/ was touched.
  {
    const events: string[] = [];
    const calls: FsCall[] = [];
    const fs = spyFs(calls);
    const logged: Fs = Object.fromEntries(Object.entries(fs).map(([k, f]) => [k, (...a: unknown[]) => {
      events.push(`fs ${k} ${a.filter((x): x is string => typeof x === 'string').join(' ')}`);
      return (f as (...x: unknown[]) => unknown)(...a);
    }])) as unknown as Fs;
    const probe: OwnerProbe = {
      posix: async (p) => { events.push('probe'); return passingProbe.posix(p); },
      euid: () => passingProbe.euid(),
      windows: async (d) => { events.push('probe'); return passingProbe.windows(d); },
    };
    const { args, deps } = testViewerSetup({ demo: true }, { fs: logged, ownerProbe: probe });
    const logDir = join(args.dataDir, 'log');
    const v = await startViewer(args, deps);
    assert.ok(!('refuse' in v));
    try {
      const firstLog = events.findIndex((e) => e.includes(logDir));
      assert.ok(events.indexOf('probe') >= 0 && events.indexOf('probe') < firstLog, events.join('\n'));
      assert.ok(existsSync(logDir));
    } finally {
      await v.stop('VIZ_EXIT_SIGNAL');
    }
  }
  // Old files of earlier viewers: deleted at start when older than 14 days; younger ones and other names stay.
  {
    const { args, deps } = testViewerSetup({ demo: true });
    const logDir = join(args.dataDir, 'log');
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const now = Date.now() / 1000;
    const plant = (name: string, ageDays: number): void => {
      writeFileSync(join(logDir, name), '{"t":1,"code":"VIZ_EXIT_IDLE"}\n');
      utimesSync(join(logDir, name), now - ageDays * 86_400, now - ageDays * 86_400);
    };
    plant('viz-AAAA0001-1.jsonl', 15);
    plant('viz-AAAA0001-2.jsonl', 30);
    plant('viz-BBBB0002-1.jsonl', 13);
    plant('notes.txt', 30);
    const v = await startViewer(args, deps);
    assert.ok(!('refuse' in v));
    try {
      const names = readdirSync(logDir).sort();
      assert.ok(!names.includes('viz-AAAA0001-1.jsonl') && !names.includes('viz-AAAA0001-2.jsonl'), names.join(', '));
      assert.ok(names.includes('viz-BBBB0002-1.jsonl') && names.includes('notes.txt'));
    } finally {
      await v.stop('VIZ_EXIT_SIGNAL');
    }
    assert.ok(readdirSync(logDir).includes(`viz-${v.instance}-1.jsonl`), 'the viewer\'s own log (its exit line)');
  }
});

test('T-VIZ-env (Linux): the real viewer\'s /proc/<pid>/environ has no CLAUDE_* value, NODE_OPTIONS, NODE_PATH, GIT_DIR or GIT_INDEX_FILE, has LC_ALL=C and the CLI\'s filtered PATH', { skip: process.platform === 'linux' ? false : 'Linux only (/proc)' }, async () => {
  const dist = await buildDistOnce();
  const pluginRoot = dirname(dist);
  const root = viewerTemp('env');
  const dataDir = join(root, 'plugin data');
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CLAUDE_PLUGIN_DATA: dataDir, CLAUDE_CODE_MESSAGING_TOKEN: 'viz-env-messaging-canary', CLAUDE_CONFIG_DIR: join(home, '.claude'),
    NODE_OPTIONS: '--no-warnings', NODE_PATH: join(root, 'node path'), GIT_DIR: join(root, 'git dir'), GIT_INDEX_FILE: join(root, 'index'),
  };
  const rec = recordingEnv({ pluginRoot, cwd: root, home, env, spawnViewer, ownerProbe: realOwnerProbe, uid: process.geteuid?.() ?? null });
  assert.equal(await runView(['--no-open', '--demo'], rec.env), 0, rec.errs.join('\n'));
  const url = /http:\/\/127\.0\.0\.1:([0-9]+)\/#k=([0-9a-f]{64})/.exec(rec.outs.join('\n'));
  assert.ok(url !== null, rec.outs.join('\n'));
  const port = Number(url[1]);
  const launch = url[2]!;
  // The viewer's pid: the process whose argv is this dist/viz.js serve with this data directory.
  const vizJs = join(dist, 'viz.js');
  const pid = readdirSync('/proc').filter((d) => /^[0-9]+$/.test(d)).find((d) => {
    try {
      const argv = readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0');
      return argv.includes(vizJs) && argv.includes(dataDir);
    } catch {
      return false;
    }
  });
  try {
    assert.ok(pid !== undefined, 'the viewer runs');
    const environ = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter((e) => e.length > 0);
    const keys = environ.map((e) => e.slice(0, e.indexOf('=')));
    for (const k of keys) assert.ok(!k.startsWith('CLAUDE'), k);
    for (const k of ['NODE_OPTIONS', 'NODE_PATH', 'GIT_DIR', 'GIT_INDEX_FILE']) assert.ok(!keys.includes(k), k);
    assert.ok(environ.includes('LC_ALL=C'));
    const want = await filterPath(env, await excludedRoots(root, [], hostFs, 'linux', home), 'linux', hostFs);
    assert.ok(environ.includes(`PATH=${want.join(':')}`), environ.filter((e) => e.startsWith('PATH=')).join(''));
    assert.equal(readlinkSync(`/proc/${pid}/cwd`), dataDir, 'cwd = the data directory');
  } finally {
    // The viewer ends on its own: a reused link.
    await redeem(port, launch).catch(() => undefined);
    await request(port, { method: 'POST', path: '/api/v1/session', headers: { origin: `http://127.0.0.1:${port}`, 'x-cowork-launch': launch } }).catch(() => undefined);
  }
});
