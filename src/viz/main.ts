// The viewer process, dist/viz.js (12-visualizer §3.2 items 2–9, §3.3.1, §3.9.2, §3.9.3, §3.10, §3.12; VIZ-01…VIZ-03, VIZ-06,
// VIZ-07, VIZ-30, VIZ-38, VIZ-41, VIZ-42; INV-CLOCK, INV-VIZ-READONLY, INV-VIZ-LOOPBACK, INV-VIZ-AUTH; rulings R-V13, R-V16).
//
// Start, in R-V16's order: the `serve` argv; the SEC-20 owner/ACL re-check of --data-dir (nothing read, created or logged before it
// passes); the 14-day cleanup of <data dir>/log and this instance's log; the SHA-256 of the viewer's own viz.js against --sha256;
// then either the demo log (bundled or --demo=<file>, one bounded read; no git, VIZ-06) or the git floor through --git (the CLI
// resolved it, R-V13; nothing is resolved here) and room admission (--repo, no folding); then the bind. The ready values go out
// before any room folds: the stores' first windows (init, at most ROOM_INITS_MAX at once) and the 2.5 s poll loop start on a later
// turn of the event loop. A refusal is { refuse, line? } for the ready line.
//
// Lifetime (VIZ-03, INV-CLOCK): the launch token's 120 s, the idle exit (no open stream and no authenticated request for 10 min,
// counted from the last such request or the close of the last stream) and the 24 h lifetime are own staleness, max(Δwall, Δmono),
// from local anchors, checked by a timer on the injected Clock every second, so a suspend gap is seen on the first wake-up after it;
// the 30 s check of viz.js uses Δmono. stop() logs the exit code, sends bye on every stream, aborts the running git children (a
// SIGTERM must not leave a cat-file running in a process group of its own), stops the poll loop, closes every socket and flushes
// the log. The viewer writes nothing but its own log (12 §3.2 item 7).
import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GitRunner } from '../git/runner.js';
import { meetsFloor } from '../git/version.js';
import { LANGS, registerCatalog, registerReasonCodes, type Lang } from '../i18n/render.js';
import { anchorNow, elapsedMono, machineMonoMs, ownStaleness, realClock, type Anchor, type Clock } from '../ports/clock.js';
import { realFs, realRootProbe, type Fs } from '../ports/fs.js';
import { realRandom, type Random } from '../ports/random.js';
import { PLUGIN_VERSION } from '../version.js';
import { verifyDataDir } from './cli/dataDir.js';
import { realOwnerProbe, type OwnerProbe } from './cli/ownerProbe.js';
import { isUncOrDevice } from './cli/paths.js';
import { DEMO_CAPTION_CODES, REASON_CODES } from './i18n/codes.js';
import { EN_VIZ } from './i18n/en.js';
import { createWorldApi, pollSinkFor } from './server/api.js';
import { clockTimer, type ClockTimer } from './server/clockTimer.js';
import { createServer, type VizServer } from './server/http.js';
import type { StoreLike } from './server/models.js';
import { startPoll } from './server/poll.js';
import { createHandleTable } from './server/project.js';
import { RoomStore, type StoreDeps } from './server/store.js';
import { StreamHub, type SseSink } from './server/stream.js';
import { TokenAuthority } from './server/tokens.js';
import { cleanupVizLogs, openVizLog, type VizLog } from './server/vizLog.js';
import { realBoundedReader, type BoundedReader } from './source/boundedRead.js';
import { BUNDLED_DEMO_MAX_BYTES, DemoRoomSource, demoRoomId, parseDemoLog, readDemoFile } from './source/demo.js';
import { GitRoomSource } from './source/git.js';
import type { DemoCaption, RoomSpec } from './source/roomSource.js';
import { discoverRooms } from './source/rooms.js';
import { abortingRunner, createVizGit, vizGitRunner } from './source/vizGit.js';

/** The viewer's embedded assets (structurally src/viz/assets.ts's VizAssets: only src/entry/viz.ts imports that module, R-V36). */
interface VizAssets { appJs: string; appCss: string; bundledDemo: string; }

export type VizExit = 'VIZ_EXIT_IDLE' | 'VIZ_EXIT_LIFETIME' | 'VIZ_EXIT_LAUNCH_UNUSED' | 'VIZ_EXIT_LAUNCH_REUSED' | 'VIZ_EXIT_PLUGIN_REMOVED' | 'VIZ_EXIT_SIGNAL';
export interface ServeArgs { dataDir: string; lang: Lang; sha256: string; repos: string[]; demo: true | string | null; git: string | null; }
export interface ViewerDeps {
  fs: Fs; reader: BoundedReader; clock: Clock; random: Random; ownerProbe: OwnerProbe; machineMonoMs(): number;
  env: Record<string, string>; platform: NodeJS.Platform; selfPath: string; assets: VizAssets; viewerVersion: string;
  gitRunner?(o: { clock: Clock; dataDir: string; env: Record<string, string>; gitPath: string }): GitRunner;   // tests: a spying runner
  stores?: readonly StoreLike[];                    // tests only: replaces room discovery and the stores (S20); never set by main()
  signals?(cb: (sig: 'SIGTERM' | 'SIGINT' | 'SIGHUP') => void): void;
}
export interface ViewerHandle { port: number; launch: string; instance: string; exited: Promise<VizExit>; stop(reason: VizExit): Promise<void>; }
export const IDLE_MS = 600_000, LIFETIME_MS = 86_400_000, PLUGIN_CHECK_MS = 30_000;
/**
 * At most this many rooms build their first window at once (Task 15 fix round 2 ruling): each holds a --batch read of up to 32 MiB
 * and its parse while it folds, so a 32-room start does not hold 32 of them at once under the V8 old-space cap the CLI set
 * (cli/spawn.ts VIEWER_MAX_OLD_SPACE_MB's rule). Each finished one starts the next, in room order.
 */
export const ROOM_INITS_MAX = 4;

/** How often the lifetime checks wake up (Δmono): a suspend gap is seen at most this long after the PC wakes. */
const LIFE_CHECK_MS = 1_000;
/** The per-viewer salt of room ids (12 §3.3.1: opaque, salted per viewer). */
const SALT_BYTES = 32;
const LOG_DIR = 'log';
const HEX64 = /^[0-9a-f]{64}$/;
const START_FAILED = Object.freeze({ refuse: 'RF_VIZ_START_FAILED' });
type Refusal = { refuse: string; line?: number };

/** An absolute path that depends on no current drive or directory, and no UNC or device path (the CLI refuses those, 12 §3.2 item 2). */
function absolutePath(p: string): boolean {
  if (p.length === 0 || isUncOrDevice(p)) return false;
  return process.platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(p) : p.startsWith('/');
}

/**
 * `serve` then exactly these flags, each once (--repo repeatable): --data-dir <abs>, --lang <one of the six>, --sha256 <64 hex>,
 * --git <abs> with one or more --repo <abs>, or --demo / --demo=<abs>; --git is present exactly when --repo is, and refused with
 * --demo (R-V13); no flag at all names rooms (RF_VIZ_NO_ROOMS later). Anything else → null.
 */
export function parseServeArgv(argv: readonly string[]): ServeArgs | null {
  if (argv[0] !== 'serve') return null;
  let dataDir: string | null = null;
  let lang: Lang | null = null;
  let sha256: string | null = null;
  let git: string | null = null;
  let demo: true | string | null = null;
  const repos: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--demo' || flag.startsWith('--demo=')) {
      if (demo !== null) return null;
      if (flag === '--demo') {
        demo = true;
      } else {
        const p = flag.slice('--demo='.length);
        if (!absolutePath(p)) return null;
        demo = p;
      }
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) return null;
    i++;
    switch (flag) {
      case '--data-dir':
        if (dataDir !== null || !absolutePath(value)) return null;
        dataDir = value;
        break;
      case '--lang':
        if (lang !== null || !(LANGS as readonly string[]).includes(value)) return null;
        lang = value as Lang;
        break;
      case '--sha256':
        if (sha256 !== null || !HEX64.test(value)) return null;
        sha256 = value;
        break;
      case '--git':
        if (git !== null || !absolutePath(value)) return null;
        git = value;
        break;
      case '--repo':
        if (!absolutePath(value)) return null;
        repos.push(value);
        break;
      default:
        return null;
    }
  }
  if (dataDir === null || lang === null || sha256 === null) return null;
  if ((git !== null) !== (repos.length > 0)) return null;
  if (demo !== null && repos.length > 0) return null;
  return { dataDir, lang, sha256, repos, demo, git };
}

/** sha256 hex of a file through the Fs port; null when it cannot be read (gone, replaced mid-read, unreadable). */
async function fileHash(fs: Fs, path: string): Promise<string | null> {
  try {
    return createHash('sha256').update(await fs.readFile(path)).digest('hex');
  } catch {
    return null;
  }
}

/** A StreamHub that reports every stream's close (the idle time counts from the close of the last one). */
class ViewerHub extends StreamHub {
  constructor(clock: Clock, private readonly closed: () => void) {
    super(clock);
  }

  override attach(out: SseSink, lastEventId: string | undefined): void {
    super.attach(out, lastEventId);
    out.onClose(() => this.closed());
  }
}

/** The rooms and what they need, built after the start checks (no fold yet). */
interface Rooms { stores: readonly StoreLike[]; inits: Array<() => Promise<void>>; captions: DemoCaption[]; demo: boolean; }

/** The demo rooms of a parsed demo log (12 §3.9.3), in header order; captions keyed by their served room id. */
function demoRooms(buf: Buffer, salt: Uint8Array, storeDeps: StoreDeps): Rooms | Refusal {
  const captionCodes = new Set(DEMO_CAPTION_CODES.filter((c) => EN_VIZ[c] !== undefined));
  const parsed = parseDemoLog(buf, captionCodes);
  if ('line' in parsed) return { refuse: 'RF_VIZ_DEMO_INVALID', line: parsed.line };
  const ids = new Map(parsed.rooms.map((r) => [r.room, demoRoomId(salt, r.room)]));
  const stores = parsed.rooms.map((r) => {
    const spec: RoomSpec = { id: ids.get(r.room)!, kind: 'demo', label: r.name, branch: r.branch, gitDir: null, boardRef: null, canonicalRoot: null };
    return new RoomStore(spec, new DemoRoomSource(r, parsed.commits.get(r.room) ?? []), storeDeps);
  });
  const captions = parsed.captions.flatMap((c) => {
    const id = ids.get(c.room);
    return id === undefined ? [] : [{ ...c, room: id }];
  });
  return { stores, inits: stores.map((s) => () => s.init()), captions, demo: true };
}

/**
 * R-V16 order; a demo run makes no git call and reads no repository file (VIZ-06); returns the ready values or the refusal for the
 * ready line; rooms fold after it; exits per VIZ-03 (own staleness for the launch TTL, idle and lifetime, counting authenticated
 * requests and open streams only; Δmono for the 30 s check); stop() sends bye, closes every socket, flushes the log.
 */
export async function startViewer(a: ServeArgs, d: ViewerDeps): Promise<ViewerHandle | { refuse: string; line?: number }> {
  const { clock, fs } = d;
  const path = d.platform === 'win32' ? win32 : posix;

  // SEC-20 first: a data directory that fails it is never read, created or logged into (12 §6).
  const verdict = await verifyDataDir(a.dataDir, { fs, probe: d.ownerProbe, platform: d.platform, create: false });
  if (!verdict.ok) return START_FAILED;

  // The instance id names the log; the launch TTL counts from here.
  const tokens = new TokenAuthority(d.random, clock);
  const logDir = path.join(a.dataDir, LOG_DIR);
  let log: VizLog;
  try {
    await cleanupVizLogs(fs, clock, logDir);
    log = await openVizLog({ fs, clock, dir: logDir, instance: tokens.instance });
  } catch {
    return START_FAILED;
  }
  /** A refusal after SEC-20: logged (its code and line number only), then returned for the ready line. */
  const refuse = async (r: Refusal): Promise<Refusal> => {
    try {
      log.write(r.refuse, r.line === undefined ? undefined : { line: r.line });
    } catch {
      // the log refused the line
    }
    await log.flush();
    return r;
  };

  // The self-hash: the start hash of the 30 s check must be this file's.
  if ((await fileHash(fs, d.selfPath)) !== a.sha256) return refuse(START_FAILED);

  const storeDeps: StoreDeps = { clock, fs, reader: d.reader, log, viewerVersion: d.viewerVersion, machineMonoMs: () => d.machineMonoMs() };
  const salt = d.random.bytes(SALT_BYTES);
  // Every viewer git child gets this signal: stop() kills the running ones (a SIGTERM must not leave a cat-file behind).
  const abort = new AbortController();
  let rooms: Rooms;
  if (d.stores !== undefined) {
    const stores = [...d.stores];
    rooms = {
      stores, captions: [], demo: a.demo !== null,
      inits: stores.map((s) => () => (typeof (s as Partial<RoomStore>).init === 'function' ? (s as RoomStore).init() : s.ready)),
    };
  } else if (a.demo !== null) {
    let buf: Buffer | { line: 0 };
    if (a.demo === true) {
      const bundled = Buffer.from(d.assets.bundledDemo, 'utf8');
      buf = bundled.length <= BUNDLED_DEMO_MAX_BYTES ? bundled : { line: 0 };
    } else {
      buf = await readDemoFile(a.demo, d.reader);
    }
    if (!Buffer.isBuffer(buf)) return refuse({ refuse: 'RF_VIZ_DEMO_INVALID', line: 0 });
    const r = demoRooms(buf, salt, storeDeps);
    if ('refuse' in r) return refuse(r);
    rooms = r;
  } else {
    if (a.repos.length === 0 || a.git === null) return refuse({ refuse: 'RF_VIZ_NO_ROOMS' });
    const o = { clock, dataDir: a.dataDir, env: d.env, gitPath: a.git };
    let runner: GitRunner;
    try {
      runner = abortingRunner(d.gitRunner !== undefined ? d.gitRunner(o) : vizGitRunner(o), abort.signal);
    } catch {
      return refuse({ refuse: 'START_TOOL_VERSION' });
    }
    // The git floor (glossary §18), through the git the CLI resolved; a git that does not run is no git.
    try {
      if (!meetsFloor(await createVizGit({ runner, gitDir: a.dataDir, dataDir: a.dataDir }).version())) return refuse({ refuse: 'START_TOOL_VERSION' });
    } catch {
      return refuse({ refuse: 'START_TOOL_VERSION' });
    }
    // Room admission: one for-each-ref per --repo, no fold.
    let found: Awaited<ReturnType<typeof discoverRooms>>;
    try {
      found = await discoverRooms(a.repos, {
        fs, reader: d.reader, git: (gitDir) => createVizGit({ runner, gitDir, dataDir: a.dataDir }), salt, platform: d.platform, probe: realRootProbe,
      });
    } catch {
      return refuse({ refuse: 'RF_VIZ_REPO_NOT_LIVE' });
    }
    if ('refuse' in found) return refuse({ refuse: found.refuse });
    const stores = found.rooms.map((spec) => new RoomStore(spec, new GitRoomSource(spec, createVizGit({ runner, gitDir: spec.gitDir!, dataDir: a.dataDir }), { fs, clock }), storeDeps));
    rooms = { stores, inits: stores.map((s) => () => s.init()), captions: [], demo: false };
  }

  // The listener.
  const start: Anchor = anchorNow(clock);
  let idle: Anchor = start;
  const activity = (): void => { idle = anchorNow(clock); };
  const hub = new ViewerHub(clock, activity);
  const handles = createHandleTable();
  const api = createWorldApi({ stores: rooms.stores, handles, hub, clock, demo: rooms.demo, captions: rooms.captions });
  let stop: (reason: VizExit) => Promise<void> = async () => {};
  const bound = await createServer({
    clock, log, hub, tokens, api, assets: { appJs: d.assets.appJs, appCss: d.assets.appCss },
    onActivity: activity,
    onLaunchReused: () => { void stop('VIZ_EXIT_LAUNCH_REUSED'); },
  });
  if ('refuse' in bound) {
    abort.abort();
    return refuse({ refuse: bound.refuse });
  }
  const server: VizServer = bound;

  let stopping: Promise<void> | null = null;
  let stopPoll: (() => Promise<void>) | null = null;
  let lifeTimer: ClockTimer | null = null;
  let markExited: (r: VizExit) => void = () => {};
  const exited = new Promise<VizExit>((resolve) => { markExited = resolve; });
  stop = (reason: VizExit): Promise<void> => {
    stopping ??= (async () => {
      lifeTimer?.cancel();
      lifeTimer = null;
      try {
        log.write(reason);
      } catch {
        // the log refused the line
      }
      hub.close();
      abort.abort();
      await stopPoll?.();
      await server.close();
      await log.flush();
      markExited(reason);
    })();
    return stopping;
  };

  // The rooms fold, and the poll loop starts, only after the ready values are out (R-V16): on a later turn of the event loop. At most
  // ROOM_INITS_MAX first windows are built at once, in room order (each store runs its own git children one at a time, so up to four
  // rooms' git reads overlap); a stopping viewer starts no more. The poll loop's ticks start no first window of their own: a tick
  // waits for its room's init (RoomStore.tick), the loop ticks the rooms one at a time in the same order, and by the time it reaches
  // room k rooms 0…k−1 have finished, so the pool has started room k already.
  setImmediate(() => {
    if (stopping !== null) return;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (stopping === null && next < rooms.inits.length) {
        const init = rooms.inits[next]!;
        next += 1;
        try {
          await init();
        } catch {
          // RoomStore.init never rejects; the store has logged its own failure
        }
      }
    };
    for (let i = 0; i < Math.min(ROOM_INITS_MAX, rooms.inits.length); i++) void worker();
    stopPoll = startPoll(rooms.stores, pollSinkFor(api, hub, handles, clock, log), clock);
  });

  // The lifetime checks (VIZ-03).
  let pluginAt: Anchor = start;
  /** The exit that is due now, if any. */
  const due = async (): Promise<VizExit | null> => {
    if (hub.open() > 0) activity();   // an open stream keeps the viewer alive
    if (!tokens.redeemed() && tokens.launchExpired()) return 'VIZ_EXIT_LAUNCH_UNUSED';
    if (ownStaleness(clock, start) > LIFETIME_MS) return 'VIZ_EXIT_LIFETIME';
    if (ownStaleness(clock, idle) > IDLE_MS) return 'VIZ_EXIT_IDLE';
    if (elapsedMono(clock, pluginAt) >= PLUGIN_CHECK_MS) {
      pluginAt = anchorNow(clock);
      if ((await fileHash(fs, d.selfPath)) !== a.sha256) return 'VIZ_EXIT_PLUGIN_REMOVED';
    }
    return null;
  };
  const check = async (): Promise<void> => {
    lifeTimer = null;
    if (stopping !== null) return;
    const reason = await due();
    if (reason !== null) await stop(reason);
    else if (stopping === null) lifeTimer = clockTimer(clock, LIFE_CHECK_MS, () => { void check(); });
  };
  lifeTimer = clockTimer(clock, LIFE_CHECK_MS, () => { void check(); });
  d.signals?.(() => { void stop('VIZ_EXIT_SIGNAL'); });

  return { port: server.port, launch: tokens.launch, instance: tokens.instance, exited, stop };
}

/** The one ready line, then stdout ended (the CLI reads it at the LF; nothing else is ever written to stdout). */
function writeReady(value: object): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    try {
      process.stdout.once('error', finish);
      process.stdout.write(`${JSON.stringify(value)}\n`, () => {
        try {
          process.stdout.end(finish);
        } catch {
          finish();
        }
      });
    } catch {
      finish();
    }
  });
}

/** The process's own deps: the real ports, the builder environment the CLI gave this process, this file as viz.js. */
function realDeps(assets: VizAssets): ViewerDeps {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  return {
    fs: realFs, reader: realBoundedReader, clock: realClock, random: realRandom, ownerProbe: realOwnerProbe, machineMonoMs,
    env, platform: process.platform, selfPath: fileURLToPath(import.meta.url), assets, viewerVersion: PLUGIN_VERSION,
    signals: (cb) => {
      for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => cb(sig));
    },
  };
}

/** dist/viz.js: registerCatalog('en', EN_VIZ) and registerReasonCodes(REASON_CODES); writes exactly one ready line, closes stdout, exits
 *  0 on a VizExit, 1 after a refusal. */
export async function main(argv: readonly string[], assets: VizAssets): Promise<never> {
  let code = 1;
  let written = false;
  const ready = (value: object): Promise<void> => {
    written = true;
    return writeReady(value);
  };
  try {
    registerCatalog('en', EN_VIZ);
    registerReasonCodes(REASON_CODES);
    const a = parseServeArgv(argv);
    let r: ViewerHandle | Refusal = START_FAILED;
    if (a !== null) {
      try {
        r = await startViewer(a, realDeps(assets));
      } catch {
        r = START_FAILED;
      }
    }
    if ('refuse' in r) {
      await ready(r.line === undefined ? { v: 1, refuse: r.refuse } : { v: 1, refuse: r.refuse, line: r.line });
    } else {
      await ready({ v: 1, port: r.port, launch: r.launch });
      await r.exited;
      code = 0;
    }
  } catch {
    if (!written) await writeReady({ v: 1, refuse: START_FAILED.refuse });
    code = 1;
  }
  process.exit(code);
}
