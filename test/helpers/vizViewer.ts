// The viewer process for tests (Plan 8a Task 15; 12 §3.2, §3.10): startTestViewer runs startViewer in-process with injected ports
// (a SEC-20-passing owner probe, a temp data directory, a fake dist/viz.js whose hash is passed as --sha256, stub page assets and
// the repository's bundled demo), and buildDistOnce builds the real dist/ once per test process for the tests that run
// `node dist/viz.js serve …` as a child. Also: a few HTTP helpers that speak to a running viewer with its session.
// Every temp folder this module makes is removed when the test process exits (a viewer a test forgot to stop dies with it).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDaemonEnv } from '../../src/git/env.js';
import { GitRepo, type RepoPaths } from '../../src/git/repo.js';
import { BoardWriter } from '../../tools/viz/boardWriter.js';
import { clonePeer } from '../sim/peers.js';
import { fixtureContext, FIXTURE_WALL_MS, makeRepoFixture, type RepoFixture } from './repoFixture.js';
import { machineMonoMs, realClock } from '../../src/ports/clock.js';
import { realFs } from '../../src/ports/fs.js';
import { realRandom } from '../../src/ports/random.js';
import { PLUGIN_VERSION } from '../../src/version.js';
import type { VizAssets } from '../../src/viz/assets.js';
import { startViewer, type ServeArgs, type ViewerDeps, type ViewerHandle } from '../../src/viz/main.js';
import { realBoundedReader } from '../../src/viz/source/boundedRead.js';
import type { Session, World } from '../../src/viz/server/viewModel.js';
import { passingProbe } from './vizCli.js';
import { absoluteGit } from './vizSource.js';
import { request, type HttpResponse } from './vizHttp.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const BUILD = join(REPO, 'tools', 'build', 'build.mjs');

/** Temp folders made here, removed at process exit (synchronously: the exit hook allows nothing else). */
const temps: string[] = [];
process.once('exit', () => {
  for (const t of temps.reverse()) {
    try {
      rmSync(t, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // a file still held on Windows: the OS temp folder keeps it
    }
  }
});

/** A fresh temp folder (realpath, with a space and Hangul below it as makeTempRoot does), removed at exit. */
export function viewerTemp(label: string): string {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), `cowork-viz-${label.replace(/[^A-Za-z0-9_-]/g, '_')}-`)));
  temps.push(base);
  const root = join(base, '\u{ACF5} \u{BC31} viewer');
  mkdirSync(root, { recursive: true });
  return root;
}

/** The page assets of an in-process test viewer: a stub page and stylesheet, and the repository's bundled demo log. */
export const TEST_VIEWER_ASSETS: VizAssets = Object.freeze({
  appJs: 'document.title = "viz test";\n',
  appCss: 'main{display:block}\n',
  bundledDemo: readFileSync(join(REPO, 'src', 'viz', 'demo', 'plan2.jsonl'), 'utf8'),
});

/** sha256 hex of a file. */
export function sha256Of(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** The ServeArgs and ViewerDeps startTestViewer would start with, the temp files made (data directory and fake viz.js); nothing started. */
export function testViewerSetup(o: Partial<ServeArgs> & { repos?: string[] } = {}, deps: Partial<ViewerDeps> = {}): { args: ServeArgs; deps: ViewerDeps; root: string } {
  const root = viewerTemp('viewer');
  const dataDir = o.dataDir ?? join(root, 'data dir');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const selfPath = deps.selfPath ?? join(root, 'plugin', 'dist', 'viz.js');
  if (deps.selfPath === undefined) {
    mkdirSync(join(root, 'plugin', 'dist'), { recursive: true });
    writeFileSync(selfPath, `// a test stand-in for dist/viz.js\n${(deps.assets ?? TEST_VIEWER_ASSETS).appJs}`);
  }
  const repos = o.repos ?? [];
  const args: ServeArgs = {
    dataDir, lang: o.lang ?? 'en', sha256: o.sha256 ?? (existsSync(selfPath) ? sha256Of(selfPath) : '0'.repeat(64)), repos, demo: o.demo ?? null,
    git: o.git !== undefined ? o.git : (repos.length > 0 ? absoluteGit() : null),
  };
  const full: ViewerDeps = {
    fs: realFs, reader: realBoundedReader, clock: realClock, random: realRandom, ownerProbe: passingProbe, machineMonoMs,
    env: buildDaemonEnv(process.env as Record<string, string | undefined>, []), platform: process.platform, selfPath,
    assets: TEST_VIEWER_ASSETS, viewerVersion: PLUGIN_VERSION, ...deps,
  };
  return { args, deps: full, root };
}

/** The contract's handle (ViewerHandle, dataDir, session()) and, for the lifetime tests, the fake viz.js it hashes. */
export type TestViewer = ViewerHandle & { dataDir: string; session(): Promise<string>; selfPath: string };

/** Redeems the launch token of a viewer on `port`: POST /api/v1/session with the viewer Origin; the session token (throws on a non-200). */
export async function redeem(port: number, launch: string): Promise<Session> {
  const res = await request(port, { method: 'POST', path: '/api/v1/session', headers: { origin: `http://127.0.0.1:${port}`, 'x-cowork-launch': launch } });
  if (res.status !== 200) throw new Error(`redemption answered ${res.status}`);
  return JSON.parse(res.body.toString('utf8')) as Session;
}

/**
 * startViewer with the setup above (deps.stores replaces discovery and the stores, S20; deps.reader and deps.gitRunner may be spies);
 * throws when the viewer refuses. session() redeems the launch token once and returns the session token on every later call.
 */
export async function startTestViewer(o: Partial<ServeArgs> & { repos?: string[] } = {}, deps: Partial<ViewerDeps> = {}): Promise<TestViewer> {
  const { args, deps: full } = testViewerSetup(o, deps);
  const r = await startViewer(args, full);
  if ('refuse' in r) throw new Error(`startViewer refused: ${r.refuse}${r.line === undefined ? '' : ` (line ${r.line})`}`);
  let session: Promise<string> | null = null;
  return Object.assign(r, {
    dataDir: args.dataDir,
    selfPath: full.selfPath,
    session: (): Promise<string> => (session ??= redeem(r.port, r.launch).then((s) => s.session)),
  });
}

/** GET <path> with the session header. */
export function apiGet(port: number, session: string, path: string): Promise<HttpResponse> {
  return request(port, { path, headers: { 'x-cowork-session': session } });
}

/** GET /api/v1/world, parsed (throws on a non-200). */
export async function worldOf(port: number, session: string): Promise<World> {
  const res = await apiGet(port, session, '/api/v1/world');
  if (res.status !== 200) throw new Error(`world answered ${res.status}`);
  return JSON.parse(res.body.toString('utf8')) as World;
}

/** One clone of a git-rooms fixture: its worktree (a --repo argument), its paths, a GitRepo on it and the BoardWriter of its board. */
export interface RoomClone { dir: string; paths: RepoPaths; repo: GitRepo; writer: BoardWriter; }
export interface RoomsFixture { fx: RepoFixture; clones: RoomClone[]; cleanup(): Promise<void>; }

/**
 * `n` clones of one file:// remote (the first is makeRepoFixture's, named p1; then p2, p3, …), each holding a board of branch main
 * written by its own BoardWriter: genesis by ann and bob's join (height 1). The worktree basenames p1…pn are the room labels.
 */
export async function gitRoomsFixture(label: string, n: number, o: { filter?: boolean; seed?: string } = {}): Promise<RoomsFixture> {
  const fx = await makeRepoFixture(label, o.filter === true ? { filter: true } : {});
  try {
    const clones: RoomClone[] = [];
    for (let i = 0; i < n; i++) {
      let paths: RepoPaths;
      let repo: GitRepo;
      if (i === 0) {
        paths = fx.paths;
        repo = fx.repo;
      } else {
        const peer = await clonePeer(fx.remote, fx.root, { name: `p${i + 1}`, autocrlf: false, withFilter: false }, fx.runner);
        const workTree = realpathSync.native(peer.dir);
        paths = { workTree, gitDir: join(workTree, '.git'), coworkDir: join(workTree, '.git', 'cowork') };
        repo = new GitRepo(fx.runner, paths, fixtureContext);
      }
      const writer = await BoardWriter.create({ runner: fx.runner, paths, branch: 'main', seed: `${o.seed ?? label}-${i}` });
      await writer.genesis('ann');
      await writer.join('bob');
      clones.push({ dir: paths.workTree, paths, repo, writer });
    }
    return { fx, clones, cleanup: () => fx.cleanup() };
  } catch (e) {
    await fx.cleanup();
    throw e;
  }
}

/**
 * A room whose board reaches the viewer's clone the way a daemon's fetch brings it: the board is written by a BoardWriter in the
 * writers' clone (p1), and fetch() pushes it to the remote's refs/cowork/<e>/board and fetches that into the viewer clone's
 * refs/cowork-remote/<e>/board (forced, as the daemon's fetch refspec is). `fx` is a RepoFixture view of the viewer clone.
 */
export interface FetchedRoom { branch: string; writer: BoardWriter; dir: string; fx: RepoFixture; fetch(): Promise<void>; }

/** One writers' clone and, per branch, a viewer clone v<i> of the same remote with that branch's board (genesis + bob's join) fetched. */
export async function fetchedRoomsFixture(label: string, branches: readonly string[]): Promise<{ fx: RepoFixture; rooms: FetchedRoom[]; cleanup(): Promise<void> }> {
  const fx = await makeRepoFixture(label);
  try {
    const main = await fx.repo.resolve('refs/heads/main');
    const rooms: FetchedRoom[] = [];
    for (const [i, branch] of branches.entries()) {
      if (branch !== 'main') await fx.repo.run(['update-ref', `refs/heads/${branch}`, main!]);
      const writer = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch, seed: `${label}-${branch}` });
      await writer.genesis('ann');
      await writer.join('bob');
      const peer = await clonePeer(fx.remote, fx.root, { name: `v${i + 1}`, autocrlf: false, withFilter: false }, fx.runner);
      const workTree = realpathSync.native(peer.dir);
      const paths: RepoPaths = { workTree, gitDir: join(workTree, '.git'), coworkDir: join(workTree, '.git', 'cowork') };
      const e = writer.ref.split('/')[2]!;
      const fetch = async (): Promise<void> => {
        const pushed = await fx.runner.run(['push', '-q', fx.remote.url, `+${writer.ref}:refs/cowork/${e}/board`], { class: 'network', cwd: fx.paths.workTree });
        if (pushed.code !== 0) throw new Error(`push: ${pushed.stderr.toString('utf8')}`);
        const fetched = await fx.runner.run(['fetch', '-q', fx.remote.url, `+refs/cowork/${e}/board:${writer.ref}`], { class: 'network', cwd: workTree });
        if (fetched.code !== 0) throw new Error(`fetch: ${fetched.stderr.toString('utf8')}`);
      };
      await fetch();
      rooms.push({ branch, writer, dir: workTree, fx: { ...fx, paths, repo: new GitRepo(fx.runner, paths, fixtureContext) }, fetch });
    }
    return { fx, rooms, cleanup: () => fx.cleanup() };
  } catch (e) {
    await fx.cleanup();
    throw e;
  }
}

/** The date and wall-clock forms no viewer surface may carry (T-VIZ-clock, F18): ISO 8601, RFC 2822, YYYY-MM-DD, HH:MM, and the Unix
 *  epoch seconds or milliseconds of this test run's wall clock (± 2 days) or of the fixtures' commit dates. */
export function datesIn(text: string, wallMs: number): string[] {
  const found: string[] = [];
  const patterns: RegExp[] = [
    /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/g,
    /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}/g,
    /\b(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b/g,
    /(?<![\d.:])(?:[01]\d|2[0-3]):[0-5]\d(?![\d.])/g,
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) found.push(m[0]);
  const near = (n: number, at: number, span: number): boolean => Math.abs(n - at) <= span;
  const DAY = 86_400_000;
  for (const m of text.matchAll(/\d{9,13}/g)) {
    const n = Number(m[0]);
    if (near(n, wallMs, 2 * DAY) || near(n, wallMs / 1000, 2 * DAY / 1000) || near(n, FIXTURE_WALL_MS, DAY) || near(n, FIXTURE_WALL_MS / 1000, DAY / 1000)) found.push(m[0]);
  }
  return found;
}

/** Every `viz-*.jsonl` line under <dataDir>/log, in file-name order. */
export function logLines(dataDir: string): string[] {
  const dir = join(dataDir, 'log');
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => /^viz-.*\.jsonl$/.test(n)).sort();
  } catch {
    return [];
  }
  return names.flatMap((n) => readFileSync(join(dir, n), 'utf8').split('\n').filter((l) => l.length > 0));
}

let dist: Promise<string> | null = null;

/** tools/build/build.mjs --outdir <temp>/plugin root/dist, once per test process (a package.json of type module beside dist/, as in
 *  the plugin); the dist directory. */
export function buildDistOnce(): Promise<string> {
  dist ??= Promise.resolve().then(() => {
    const pluginRoot = join(viewerTemp('dist'), 'plugin root');
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(join(pluginRoot, 'package.json'), '{"type":"module"}\n');
    const out = join(pluginRoot, 'dist');
    const r = spawnSync(process.execPath, [BUILD, '--outdir', out], { cwd: REPO, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`build failed:\n${r.stdout}\n${r.stderr}`);
    return out;
  });
  return dist;
}
