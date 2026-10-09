// Plan 8a Task 15: T-VIZ-perf (12 §3.12, §7; VIZ-41; R-V41; Review Focus 3; F6). A slow suite (COWORK_VIZ_SLOW=1, viz-slow.yml; ≈ 3
// min). Eight real clones with 1,024-height boards written by BoardWriter.commitMany, served by one viewer whose stores are the
// test's own RoomStores over spied sources and counted git (S20: deps.stores), so the folds and every git child are seen:
//  - the first /api/v1/world within 6 s of the ready values (2× the 3 s budget on shared runners, R-V41);
//  - git processes per tick and per batch exactly as 12 §3.12 and R-V05/R-V31 count them, never two at once in a room;
//  - 60 s idle, the viewer's CPU plus its git children's run time ≤ 2 % of one core (2×);
//  - one room extended live by 17,280 heights (24 h at B = 12): the real viewer's settled RSS after the folds ≤ 200 MB, started
//    as the CLI starts it (viewerArgv: a 150 MB V8 old space, the fix round 1 ruling), at most 2,048 heights held (pages above the oldest
//    kept checkpoint fold nothing, a page below it re-folds), and a 255-commit seek within 1 s (2× the 500 ms budget).
// RSS, the heights held and the git counts are exact (F6); only the times and CPU carry the 2× slack.
// A second test starts the real viewer over 32 rooms × 1,024 heights under the room-scaled cap (534 MB, cli/spawn.ts
// VIEWER_MAX_OLD_SPACE_MB's rule), its first windows built at most 4 at once (main.ts ROOM_INITS_MAX): no V8 heap OOM, every room
// served, nothing on its stderr; its first world and its peak and settled RSS are reported (Task 15 fix round 2 ruling; 12 §3.12
// sets an RSS budget for 8 rooms only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { buildDaemonEnv } from '../../../src/git/env.js';
import { realFs } from '../../../src/ports/fs.js';
import { verifyDataDir } from '../../../src/viz/cli/dataDir.js';
import { realOwnerProbe } from '../../../src/viz/cli/ownerProbe.js';
import { openViewerStderr, parseReadyLine, viewerArgv, viewerOldSpaceMb, VIEWER_STDERR_FILE } from '../../../src/viz/cli/spawn.js';
import { READ_BATCH_MAX } from '../../../src/board/batchRead.js';
import type { GitResult, GitRunner } from '../../../src/git/runner.js';
import { realClock } from '../../../src/ports/clock.js';
import { RETAIN_HEIGHTS } from '../../../src/viz/server/store.js';
import { openStream } from '../../helpers/vizHttp.js';
import { absoluteGit, kinds, vizRunner } from '../../helpers/vizSource.js';
import { gitRoom, pubs, type GitRoom } from '../../helpers/vizStore.js';
import { apiGet, buildDistOnce, gitRoomsFixture, redeem, sha256Of, startTestViewer, viewerTemp, worldOf } from '../../helpers/vizViewer.js';
import { request } from '../../helpers/vizHttp.js';
import type { RepoFixture } from '../../helpers/repoFixture.js';

const SLOW = process.env['COWORK_VIZ_SLOW'] === '1';
const ROOMS = 8, HEIGHTS = 1_024, LIVE = 17_280, CHUNK = 1_440;
const MB = 1024 * 1024;

/** A runner that sums the wall time of every git child (an upper bound of its CPU time). */
function timedRunner(inner: GitRunner, total: { ms: number }): GitRunner {
  return { run: async (args, opts): Promise<GitResult> => { const r = await inner.run(args, opts); total.ms += r.durationMs; return r; } };
}

/** The resident memory of a running child, in bytes (Linux: VmRSS of /proc/<pid>/status; Windows: the working set). */
function rssOf(child: ChildProcess): number {
  const pid = child.pid!;
  if (process.platform === 'linux') {
    const m = /^VmRSS:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    assert.ok(m !== null);
    return Number(m[1]) * 1024;
  }
  const root = process.env['SystemRoot'] ?? 'C:\\Windows';
  const ps = win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).WorkingSet64`], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  const n = Number(r.stdout.trim());
  assert.ok(Number.isSafeInteger(n) && n > 0, `working set: ${r.stdout} ${r.stderr}`);
  return n;
}

/** The real dist/viz.js over `repos` (RSS is the viewer process's own, never this test process's), started with the CLI's own argv
 *  (viewerArgv: the V8 old-space cap, `capMb` here, then the script) and stderr file (openViewerStderr); it ends on its own when
 *  stop() presents its launch link a second time. */
async function realViewer(repos: readonly string[], capMb: number): Promise<{ port: number; session: string; child: ChildProcess; flag: string; stderr(): string; stop(): Promise<void> }> {
  const dist = await buildDistOnce();
  const vizJs = join(dist, 'viz.js');
  const dataDir = join(viewerTemp('perf-real'), 'data dir');
  assert.deepEqual(await verifyDataDir(dataDir, { fs: realFs, probe: realOwnerProbe, platform: process.platform, create: true }), { ok: true });
  const env = buildDaemonEnv(process.env as Record<string, string | undefined>, []);
  const argv = viewerArgv({
    execPath: process.execPath, vizJs, dataDir, lang: 'en', sha256: sha256Of(vizJs), repos, demo: null, git: absoluteGit(), env,
    platform: process.platform, systemRoot: process.env['SystemRoot'] ?? null,
  });
  assert.equal(argv[0], `--max-old-space-size=${capMb}`, 'the CLI\'s heap cap');
  const err = openViewerStderr(dataDir, process.platform);
  assert.ok(err !== null, 'the stderr file');
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, argv, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', err.fd], cwd: dataDir, env });
  } finally {
    err.close();
  }
  const stderrFile = join(dataDir, 'log', VIEWER_STDERR_FILE);
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const line = await new Promise<Buffer>((resolve, reject) => {
    let buf = Buffer.alloc(0);
    child.stdout!.on('data', (b: Buffer) => {
      buf = Buffer.concat([buf, b]);
      const lf = buf.indexOf(0x0a);
      if (lf >= 0) resolve(buf.subarray(0, lf + 1));
    });
    child.once('exit', () => reject(new Error('the viewer exited before its ready line')));
  });
  const ready = parseReadyLine(line);
  assert.ok(ready !== null && 'port' in ready, line.toString('utf8'));
  const { session } = await redeem(ready.port, ready.launch);
  return {
    port: ready.port, session, child, flag: argv[0]!,
    stderr: () => (existsSync(stderrFile) ? readFileSync(stderrFile, 'utf8') : ''),
    stop: async () => {
      await request(ready.port, { method: 'POST', path: '/api/v1/session', headers: { origin: `http://127.0.0.1:${ready.port}`, 'x-cowork-launch': ready.launch } }).catch(() => undefined);
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([exited, new Promise<void>((r) => { timer = setTimeout(r, 15_000); })]);
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
}

test('T-VIZ-perf (Windows and Linux legs; R-V41): 8 rooms × 1,024 heights → first /api/v1/world ≤ 6 s (2×); git processes per tick and batch exactly as counted; 60 s idle CPU including git children ≤ 2 % of one core (2×); a 255-commit seek ≤ 1 s (2×); RSS after extending one room live by 17,280 heights ≤ 200 MB with ≤ 2,048 heights retained', {
  skip: !SLOW ? 'slow suite: set COWORK_VIZ_SLOW=1 (viz-slow.yml)' : process.platform === 'darwin' ? 'Windows and Linux legs' : false,
  timeout: 900_000,
}, async (t) => {
  const f = await gitRoomsFixture('viz-perf', ROOMS);
  try {
    for (const c of f.clones) await c.writer.commitMany(pubs(HEIGHTS - 2));   // heights 0…1,023
    const gitTime = { ms: 0 };
    const runner = timedRunner(vizRunner(join(f.fx.root, 'viz data'), realClock), gitTime);
    const rooms: GitRoom[] = f.clones.map((c, i) => gitRoom({ ...f.fx, paths: c.paths, repo: c.repo } as RepoFixture, c.writer.ref, { clock: realClock, n: i, runner }));
    const t0 = realClock.monoMs();
    const v = await startTestViewer({}, { stores: rooms.map((r) => r.store) });
    const reals: Array<{ stop(): Promise<void> }> = [];
    try {
      const s = await v.session();
      const world = await worldOf(v.port, s);
      const firstWorld = realClock.monoMs() - t0;
      t.diagnostic(`first /api/v1/world: ${Math.round(firstWorld)} ms`);
      assert.ok(firstWorld <= 6_000, `first world ${firstWorld} ms`);
      assert.deepEqual(world.rooms.map((r) => r.window), Array.from({ length: ROOMS }, () => ({ h0: 0, h1: HEIGHTS - 1 })));
      // The first window of each room, exactly: the tip (rev-parse) and its height (rev-list --count); the start state at h0 = 0
      // (B0's protocol: a listing of height 0 and one --batch-check/--batch pair); the window's frames 0…1,023 (one listing and one
      // pair: one batch of ≤ 1,280 board commits and the live commits they name).
      const INIT = [
        'rev-parse --verify -q', 'rev-list --first-parent --count',
        'rev-list --first-parent --skip=', 'cat-file --batch-check', 'cat-file --batch',
        'rev-list --first-parent --skip=', 'cat-file --batch-check', 'cat-file --batch',
      ];
      const shapes = (r: GitRoom): string[] => r.git.calls.map((c) => c.args.slice(0, c.args[0] === 'rev-list' ? 3 : c.args[0] === 'rev-parse' ? 3 : 2).join(' ').replace(/--skip=\d+/, '--skip='));
      for (const r of rooms) {
        assert.deepEqual(shapes(r), INIT);
        assert.equal(r.git.maxInFlight, 1);
        const items = r.git.calls.filter((c) => c.args[1] === '--batch-check').map((c) => c.stdin.split('\n').filter((l) => l.endsWith('^{tree}')).length);
        assert.deepEqual(items, [1, HEIGHTS], 'B0, then the window\'s 1,024 board commits in one batch');
      }

      // The real viewer process over the same clones, for its own RSS after the live extension below.
      const real = await realViewer(f.clones.map((c) => c.dir), 150);
      reals.push(real);
      assert.equal((await worldOf(real.port, real.session)).rooms.length, ROOMS);

      // 60 s idle: no ref moves; each room runs at most one rev-parse (the 60 s safety net).
      for (const r of rooms) r.git.reset();
      const st = await openStream(v.port, { 'x-cowork-session': s });
      const cpu0 = process.cpuUsage();
      gitTime.ms = 0;
      const w0 = realClock.monoMs();
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      const cpu = process.cpuUsage(cpu0);
      const wall = realClock.monoMs() - w0;
      const share = ((cpu.user + cpu.system) / 1_000 + gitTime.ms) / wall;
      t.diagnostic(`60 s idle: ${(share * 100).toFixed(2)} % of one core (viewer ${((cpu.user + cpu.system) / 1_000).toFixed(0)} ms, git ${gitTime.ms.toFixed(0)} ms)`);
      assert.ok(share <= 0.02, `idle CPU ${(share * 100).toFixed(2)} %`);
      for (const r of rooms) assert.ok(kinds(r.git.calls).every((k) => k === 'rev-parse --verify') && r.git.calls.length <= 2, JSON.stringify(kinds(r.git.calls)));

      // A fetch of 3 commits: rev-parse, one rev-list page (R-V31), --batch-check and --batch.
      const live = rooms[0]!;
      live.git.reset();
      await f.clones[0]!.writer.commitMany(pubs(3, 'three'));
      await until(() => kinds(live.git.calls).includes('cat-file --batch'));
      assert.deepEqual(kinds(live.git.calls), ['rev-parse --verify', 'rev-list --first-parent', 'cat-file --batch-check', 'cat-file --batch']);

      // 17,280 live heights in chunks of 1,440 (a laptop waking up to a backlog): each tick folds its chunk in batches of ≤ 1,280,
      // a catch-up beyond 1,280 costs one rev-list --count and one --skip probe more (R-V31).
      let tip = HEIGHTS - 1 + 3;
      let peak = 0;
      for (let done = 0; done < LIVE; done += CHUNK) {
        live.git.reset();
        await f.clones[0]!.writer.commitMany(pubs(CHUNK, `live${done}`));
        tip += CHUNK;
        await until(() => live.store.snapshot().window.h1 === tip);
        peak = Math.max(peak, rssOf(real.child));
        const k = kinds(live.git.calls);
        const batches = Math.ceil(CHUNK / READ_BATCH_MAX);
        assert.equal(k.filter((x) => x === 'cat-file --batch-check').length, batches);
        assert.equal(k.filter((x) => x === 'cat-file --batch').length, batches);
        assert.equal(k.filter((x) => x === 'rev-parse --verify').length, 1);
        assert.equal(live.git.calls.filter((c) => c.args.includes('--count')).length, 1, 'one rev-list --count for a catch-up beyond 1,280');
        assert.equal(live.git.maxInFlight, 1);
      }
      const h1 = tip;
      // RSS of the real viewer process once it has folded the same 17,280 live heights, exact (F6).
      for (let i = 0; i < 300; i++) {
        const w = await worldOf(real.port, real.session);
        if (w.rooms.some((r) => r.window.h1 === h1)) break;
        await new Promise((r) => setTimeout(r, 1_000));
      }
      assert.ok((await worldOf(real.port, real.session)).rooms.some((r) => r.window.h1 === h1), 'the real viewer folded the live heights');
      // Resident memory once the viewer is quiet again: V8 sizes its heap lazily and gives the pages of a fold's garbage back only
      // through its memory reducer, which starts 8 s after the allocation rate drops; so the viewer is left alone (no request, no
      // stream) for 20 s, then sampled every 2 s until two samples agree within 2 MB (at most 40 s more). The peak seen while it
      // folded is reported beside it.
      await new Promise((r) => setTimeout(r, 20_000));
      const samples: number[] = [rssOf(real.child)];
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 2_000));
        samples.push(rssOf(real.child));
        const [a, b] = samples.slice(-2) as [number, number];
        if (Math.abs(a - b) <= 2 * MB) break;
      }
      const rss = samples.at(-1)!;
      t.diagnostic(`the viewer's RSS after ${LIVE} live heights in one of 8 rooms: ${(rss / MB).toFixed(1)} MB settled; ${(peak / MB).toFixed(1)} MB at most while folding; samples ${samples.map((x) => (x / MB).toFixed(0)).join(' ')}`);
      assert.ok(rss <= 200 * MB, `RSS ${(rss / MB).toFixed(1)} MB`);
      // At most 2,048 heights held: pages above the oldest kept checkpoint at or above h1 − 2,048 fold nothing; the segment below it
      // was dropped and re-folds (a 255-commit seek: ≤ 255 folds before its page, within 1 s).
      const lo = 256 * Math.ceil((h1 - RETAIN_HEIGHTS) / 256);
      assert.ok(h1 - lo <= RETAIN_HEIGHTS);
      const id = world.rooms[0]!.room_id;
      const page = async (from: number, to: number): Promise<{ folds: number; ms: number }> => {
        const f0 = live.spy.folds;
        const m0 = realClock.monoMs();
        assert.equal((await apiGet(v.port, s, `/api/v1/rooms/${id}/timeline?from=${from}&to=${to}`)).status, 200);
        return { folds: live.spy.folds - f0, ms: realClock.monoMs() - m0 };
      };
      assert.equal((await page(lo + 1, lo + 256)).folds, 0, 'held');
      assert.equal((await page(h1 - 100, h1)).folds, 0, 'held');
      const seek = await page(lo - 255, lo);
      t.diagnostic(`a seek into a dropped segment: ${seek.folds} folds, ${Math.round(seek.ms)} ms`);
      assert.ok(seek.folds > 0 && seek.folds <= 256, `${seek.folds} folds`);
      assert.ok(seek.ms <= 1_000, `seek ${seek.ms} ms`);
      st.close();
    } finally {
      await v.stop('VIZ_EXIT_SIGNAL');
      for (const r of reals) await r.stop();
    }
  } finally {
    await f.cleanup();
  }
});

test('T-VIZ-perf (32 rooms; Task 15 fix round 2 ruling): a 32-room start (32 × 1,024 heights) under the room-scaled cap (534 MB) builds every first window without a V8 heap OOM: the real viewer serves all 32 rooms at h1 = 1,023, is still running and has nothing on its stderr; its first world and peak and settled RSS are reported', {
  skip: !SLOW ? 'slow suite: set COWORK_VIZ_SLOW=1 (viz-slow.yml)' : process.platform === 'darwin' ? 'Windows and Linux legs' : false,
  timeout: 1_200_000,
}, async (t) => {
  const N = 32;
  const b0 = realClock.monoMs();
  const f = await gitRoomsFixture('viz-perf32', N);
  try {
    for (const c of f.clones) await c.writer.commitMany(pubs(HEIGHTS - 2));   // heights 0…1,023
    t.diagnostic(`fixture: ${N} clones × ${HEIGHTS} heights in ${Math.round((realClock.monoMs() - b0) / 1_000)} s`);
    const cap = viewerOldSpaceMb(N);
    assert.equal(cap, 534);
    const t0 = realClock.monoMs();
    const real = await realViewer(f.clones.map((c) => c.dir), cap);
    try {
      // RSS sampled while the rooms fold (the world waits for every room's first window).
      let peak = 0;
      let folding = true;
      const sampler = (async () => {
        while (folding && real.child.exitCode === null && real.child.signalCode === null) {
          peak = Math.max(peak, rssOf(real.child));
          await new Promise((r) => setTimeout(r, 500));
        }
      })();
      let world: Awaited<ReturnType<typeof worldOf>>;
      try {
        world = await worldOf(real.port, real.session);
      } finally {
        folding = false;
        await sampler;
      }
      const firstWorld = realClock.monoMs() - t0;
      assert.deepEqual(world.rooms.map((r) => r.window), Array.from({ length: N }, () => ({ h0: 0, h1: HEIGHTS - 1 })));
      // Settled as the 8-room test measures it: 20 s alone, then every 2 s until two samples agree within 2 MB (at most 40 s more).
      await new Promise((r) => setTimeout(r, 20_000));
      const samples: number[] = [rssOf(real.child)];
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 2_000));
        samples.push(rssOf(real.child));
        const [a, b] = samples.slice(-2) as [number, number];
        if (Math.abs(a - b) <= 2 * MB) break;
      }
      const rss = samples.at(-1)!;
      peak = Math.max(peak, ...samples);
      t.diagnostic(`32 rooms × ${HEIGHTS} heights under ${real.flag}: first /api/v1/world ${Math.round(firstWorld)} ms; RSS ${(rss / MB).toFixed(1)} MB settled, ${(peak / MB).toFixed(1)} MB at most while folding; samples ${samples.map((x) => (x / MB).toFixed(0)).join(' ')}`);
      assert.equal(real.child.exitCode, null, 'the viewer is still running');
      assert.equal(real.child.signalCode, null, 'the viewer is still running');
      assert.equal((await worldOf(real.port, real.session)).rooms.length, N);
      assert.equal(real.stderr(), '', 'nothing on its stderr (no fatal error)');
    } finally {
      if (real.stderr() !== '') t.diagnostic(`stderr: ${real.stderr().slice(0, 600)}`);
      await real.stop();
    }
  } finally {
    await f.cleanup();
  }
});

async function until(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 600 && !pred(); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(pred(), 'in time');
}
