// The viewer spawn and the ready handshake (Task 11): argv, environment, cwd, the 512-byte / 5 s ready line, and the process-tree kill
// (12 §3.2 items 2–3, VIZ-02; R-V12, R-V13, R-V15; 09-security §3.4). The probe viewer and its grandchild end on their own once the
// test removes their data directory (test/fixtures/viz/probeViewer.mjs): no pid is ever signalled after its process may have died
// (L-PID-KILL); `alive` is a signal-0 probe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Fs } from '../../../src/ports/fs.js';
import { realOwnerProbe } from '../../../src/viz/cli/ownerProbe.js';
import {
  killTree, killTreeWith, parseReadyLine, READY_MAX_BYTES, READY_REFUSE_CODES, READY_TIMEOUT_MS, spawnViewer, spawnViewerWith, viewerArgv,
  viewerOldSpaceMb, VIEWER_MAX_OLD_SPACE_MB, VIEWER_OLD_SPACE_BASE_ROOMS, VIEWER_OLD_SPACE_ROOM_MB, VIEWER_ROOMS_MAX,
  openViewerStderr, VIEWER_STDERR_FILE, VIEWER_STDERR_MAX_BYTES, type KillDeps, type KillTarget, type SpawnDeps, type ViewerArgs,
} from '../../../src/viz/cli/spawn.js';
import { ROOMS_MAX } from '../../../src/viz/source/rooms.js';
import { langOf, runView } from '../../../src/viz/cli/view.js';
import { makeTempRoot } from '../../helpers/tmp.js';
import { assertAllRendered, fakePluginRoot, findSystemGit, hostFs, PROBE_LAUNCH, PROBE_PORT, PROBE_VIEWER, recordingEnv } from '../../helpers/vizCli.js';

const SYSTEM_ROOT = process.platform === 'win32' ? (process.env.SystemRoot ?? 'C:\\Windows') : null;
const SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const TOKEN = 'tok-messaging-secret-7f3a91';
const MESSAGING = ['CLAUDE', 'CODE', 'MESSAGING', 'TOKEN'].join('_');

interface ProbeReport { env: Record<string, string>; cwd: string; argv: string[]; pid: number; grandchild: number | null; }
const report = (dataDir: string): ProbeReport => JSON.parse(readFileSync(join(dataDir, 'probe.json'), 'utf8')) as ProbeReport;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function gone(pid: number, ms = 5_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (!alive(pid)) return true;
  return !alive(pid);
}

function args(dataDir: string, env: Record<string, string>, o: Partial<ViewerArgs> = {}): ViewerArgs {
  return {
    execPath: process.execPath, vizJs: PROBE_VIEWER, dataDir, lang: 'en', sha256: SHA, repos: [], demo: true, git: null,
    env: { ...(SYSTEM_ROOT === null ? {} : { SystemRoot: SYSTEM_ROOT }), ...env }, platform: process.platform, systemRoot: SYSTEM_ROOT, ...o,
  };
}

test('parseReadyLine: one LF-terminated JSON object by schema; "line" only with RF_VIZ_DEMO_INVALID; viewerArgv', () => {
  assert.equal(READY_TIMEOUT_MS, 5_000);
  assert.equal(READY_MAX_BYTES, 512);
  assert.deepEqual([...READY_REFUSE_CODES].sort(), [
    'RF_VIZ_BIND_FAILED', 'RF_VIZ_DEMO_INVALID', 'RF_VIZ_NO_ROOMS', 'RF_VIZ_REPO_NOT_LIVE', 'RF_VIZ_START_FAILED', 'START_TOOL_VERSION',
  ]);
  const hex = 'ab'.repeat(32);
  const b = (s: string): Buffer => Buffer.from(s, 'utf8');
  assert.deepEqual(parseReadyLine(b(`{"v":1,"port":8080,"launch":"${hex}"}\n`)), { port: 8080, launch: hex });
  assert.deepEqual(parseReadyLine(b(`{"launch":"${hex}","port":65535,"v":1}\n`)), { port: 65535, launch: hex });
  assert.deepEqual(parseReadyLine(b('{"v":1,"refuse":"RF_VIZ_NO_ROOMS"}\n')), { refuse: 'RF_VIZ_NO_ROOMS' });
  assert.deepEqual(parseReadyLine(b('{"v":1,"refuse":"RF_VIZ_DEMO_INVALID","line":7}\n')), { refuse: 'RF_VIZ_DEMO_INVALID', line: 7 });
  assert.deepEqual(parseReadyLine(b('{"v":1,"refuse":"RF_VIZ_DEMO_INVALID"}\n')), { refuse: 'RF_VIZ_DEMO_INVALID' });
  for (const s of [
    `{"v":1,"port":8080,"launch":"${hex}"}`, `{"v":1,"port":8080,"launch":"${hex}"}\r\n`, `{"v":1,"port":8080,"launch":"${hex}"}\n\n`,
    `{"v":1,"port":8080,"launch":"${hex}"}\nx`, `\n{"v":1,"port":8080,"launch":"${hex}"}\n`, `{"v":2,"port":8080,"launch":"${hex}"}\n`,
    `{"v":1,"port":0,"launch":"${hex}"}\n`, `{"v":1,"port":65536,"launch":"${hex}"}\n`, `{"v":1,"port":80.5,"launch":"${hex}"}\n`,
    `{"v":1,"port":"8080","launch":"${hex}"}\n`, `{"v":1,"port":8080,"launch":"${hex.toUpperCase()}"}\n`, `{"v":1,"port":8080,"launch":"${hex}0"}\n`,
    `{"v":1,"port":8080,"launch":"${hex}","x":1}\n`, `{"v":1,"port":8080}\n`, `{"v":1,"port":8080,"launch":"${hex}","refuse":"RF_VIZ_NO_ROOMS"}\n`,
    '{"v":1,"refuse":"UI_VIZ_LINK_REUSED"}\n', '{"v":1,"refuse":"RF_UNKNOWN_FLAG"}\n', '{"v":1,"refuse":"RF_VIZ_NO_ROOMS","line":3}\n',
    '{"v":1,"refuse":"RF_VIZ_DEMO_INVALID","line":-1}\n', '{"v":1,"refuse":"RF_VIZ_DEMO_INVALID","line":1.5}\n',
    '{"v":1,"refuse":"RF_VIZ_DEMO_INVALID","line":"3"}\n', '{"v":1,"refuse":"RF_VIZ_NO_ROOMS","__proto__":{"x":1}}\n', '[1]\n', 'null\n',
    '"x"\n', '{}\n', '\n', '', 'ready!\n', `{"v":1,"port":8080,"launch":"${hex}","pad":"${'x'.repeat(512)}"}\n`, '\u{FEFF}{"v":1,"refuse":"RF_VIZ_NO_ROOMS"}\n',
  ]) {
    assert.equal(parseReadyLine(b(s)), null, JSON.stringify(s));
  }
  assert.equal(parseReadyLine(Buffer.from([0xff, 0x0a])), null);

  const base = args('/data dir', {}, { vizJs: '/p/dist/viz.js', lang: 'ko' });
  // The viewer's V8 old space is capped (the Task 15 fix round 1 ruling on 12 §3.12's "viewer RSS ≤ 200 MB with 8 rooms"; its rule
  // by the room count is pinned in the next test): a node flag, so it precedes the script.
  assert.deepEqual(viewerArgv({ ...base, demo: true }), ['--max-old-space-size=150', '/p/dist/viz.js', 'serve', '--data-dir', '/data dir', '--lang', 'ko', '--sha256', SHA, '--demo']);
  assert.deepEqual(viewerArgv({ ...base, demo: '/d/x y.jsonl' }).slice(9), ['--demo=/d/x y.jsonl']);
  assert.deepEqual(viewerArgv({ ...base, demo: null, repos: ['/r/a', '/r/b'], git: '/usr/bin/git' }).slice(9),
    ['--git', '/usr/bin/git', '--repo', '/r/a', '--repo', '/r/b']);
  assert.deepEqual(viewerArgv({ ...base, demo: null }).slice(9), []);
  for (const demo of [true, '/d/x y.jsonl', null] as const) {
    assert.equal(viewerArgv({ ...base, demo, repos: demo === null ? ['/r/a'] : [], git: demo === null ? '/usr/bin/git' : null })[1], '/p/dist/viz.js', String(demo));
  }
  // --git is set exactly when --repo is (R-V13): repos without a git refuse (the viewer would refuse a --repo without --git, so the
  // CLI starts nothing), and a git with a demo is not passed (VIZ-06: a demo resolves and calls no git).
  for (const git of [null, '']) {
    assert.throws(() => viewerArgv({ ...base, demo: null, repos: ['/r/a'], git }), /--git/, String(git));
  }
  assert.deepEqual(viewerArgv({ ...base, demo: true, git: '/usr/bin/git' }).slice(9), ['--demo']);
});

test('VIEWER_MAX_OLD_SPACE_MB\'s rule (Task 15 fix round 2 ruling): the viewer\'s V8 old space is 150 MB up to 8 rooms and 16 MB more per room beyond 8 (32 rooms → 534 MB), by the room count the CLI knows at spawn: the --repo count (each admits at most one room, at most 32 rooms), 32 for a --demo=<file>, the base for the bundled demo', () => {
  assert.equal(VIEWER_MAX_OLD_SPACE_MB, 150);
  assert.equal(VIEWER_OLD_SPACE_ROOM_MB, 16);
  assert.equal(VIEWER_OLD_SPACE_BASE_ROOMS, 8);
  // The CLI's copy of the viewer's room limit (cli.js bundles only src/viz/cli/**) equals the source layer's ROOMS_MAX (a demo
  // header names 1–32 rooms too, demo.ts).
  assert.equal(VIEWER_ROOMS_MAX, ROOMS_MAX);
  assert.equal(VIEWER_ROOMS_MAX, 32);
  const mb: Array<[number, number]> = [[0, 150], [1, 150], [8, 150], [9, 166], [16, 278], [31, 518], [32, 534], [33, 534], [100, 534]];
  for (const [rooms, cap] of mb) assert.equal(viewerOldSpaceMb(rooms), cap, `${rooms} rooms`);

  const base = args('/data dir', {}, { vizJs: '/p/dist/viz.js', demo: null, git: '/usr/bin/git' });
  const repos = (n: number): string[] => Array.from({ length: n }, (_, i) => `/r/${i}`);
  const flag = (a: ViewerArgs): string | undefined => viewerArgv(a)[0];
  for (const [n, cap] of [[1, 150], [8, 150], [9, 166], [32, 534], [40, 534]] as const) {
    assert.equal(flag({ ...base, repos: repos(n) }), `--max-old-space-size=${cap}`, `${n} --repo`);
  }
  assert.equal(flag({ ...base, git: null, demo: true }), '--max-old-space-size=150', 'the bundled demo (one room, ≤ 64 KiB)');
  assert.equal(flag({ ...base, git: null, demo: '/d/x y.jsonl' }), '--max-old-space-size=534', 'a demo file: up to 32 rooms, read only by the viewer');
  assert.equal(flag({ ...base, git: null }), '--max-old-space-size=150', 'no room (the viewer refuses RF_VIZ_NO_ROOMS)');
});

test('spawnViewer refuses repos without a git before spawning anything', async () => {
  const t = await makeTempRoot('viz-nogit');
  try {
    const spawned: string[] = [];
    const deps: SpawnDeps = {
      spawn: (exe, argv, options) => { spawned.push(exe); return spawn(exe, argv, options); },
      killTree,
    };
    for (const git of [null, '']) {
      assert.deepEqual(await spawnViewerWith(args(t.root, {}, { demo: null, repos: [join(t.root, 'repo')], git }), deps), { refuse: 'RF_VIZ_START_FAILED' });
    }
    assert.deepEqual(spawned, []);
    assert.equal(existsSync(join(t.root, 'probe.json')), false);
  } finally {
    await t.cleanup();
  }
});

test('T-VIZ-handshake: a child that sleeps 6 s or prints a malformed or oversized line → RF_VIZ_START_FAILED and its whole process tree is gone', async () => {
  const t = await makeTempRoot('viz-handshake');
  try {
    const run = async (mode: string): Promise<void> => {
      const dataDir = join(t.root, mode);
      mkdirSync(dataDir);
      const started = Date.now();
      const r = await spawnViewer(args(dataDir, { COWORK_PROBE_MODE: mode }));
      assert.deepEqual(r, { refuse: 'RF_VIZ_START_FAILED' }, mode);
      if (mode === 'sleep') assert.ok(Date.now() - started >= READY_TIMEOUT_MS - 100, 'waited for the 5 s handshake');
      const { pid, grandchild } = report(dataDir);
      assert.ok(grandchild !== null, `${mode}: the probe started a grandchild`);
      assert.ok(await gone(pid), `${mode}: the child ${pid} is gone`);
      assert.ok(await gone(grandchild), `${mode}: the grandchild ${grandchild} is gone`);
    };
    await Promise.all(['sleep', 'malformed', 'oversized', 'garbage'].map(run));

    // A valid line, a refusal and an early exit through the same spawn path.
    const ready = join(t.root, 'ready');
    mkdirSync(ready);
    assert.deepEqual(await spawnViewer(args(ready, {})), { port: PROBE_PORT, launch: PROBE_LAUNCH });
    const refuse = join(t.root, 'refuse');
    mkdirSync(refuse);
    assert.deepEqual(await spawnViewer(args(refuse, { COWORK_PROBE_MODE: 'refuse:RF_VIZ_DEMO_INVALID:12' })), { refuse: 'RF_VIZ_DEMO_INVALID', line: 12 });
    const exit = join(t.root, 'exit');
    mkdirSync(exit);
    assert.deepEqual(await spawnViewer(args(exit, { COWORK_PROBE_MODE: 'exit' })), { refuse: 'RF_VIZ_START_FAILED' });
    assert.deepEqual(await spawnViewer(args(exit, {}, { execPath: join(t.root, 'no such node') })), { refuse: 'RF_VIZ_START_FAILED' });
  } finally {
    await t.cleanup();
  }
});

/** Puts `first` at the head of this process's PATH (under its own key spelling); returns the restore function. */
function setProcessPath(first: string): () => void {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const saved = process.env[key];
  process.env[key] = saved === undefined ? first : `${first}${delimiter}${saved}`;
  return () => {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  };
}

test('T-VIZ-handshake: a taskkill.exe planted in the CLI\'s cwd is never executed', { skip: process.platform !== 'win32' ? 'Windows legs only' : false }, async () => {
  const t = await makeTempRoot('viz-taskkill');
  const before = process.cwd();
  let restorePath = (): void => {};
  try {
    // Not a program: if it were run instead of <SystemRoot>\System32\taskkill.exe, the kill would fail, only the child would be
    // killed (the fallback) and the grandchild would survive. It sits in the CLI's cwd and first on this process's PATH, which a spawn
    // of the bare name searches when the child's environment has no PATH (killTree passes { SystemRoot } only).
    const cwd = join(t.root, 'repo');
    mkdirSync(join(cwd, '.git'), { recursive: true });
    writeFileSync(join(cwd, 'taskkill.exe'), Buffer.from('MZ planted, never a program'));
    process.chdir(cwd);
    const dataDir = join(t.root, 'data');
    mkdirSync(dataDir);
    restorePath = setProcessPath(cwd);
    const r = await spawnViewer(args(dataDir, { COWORK_PROBE_MODE: 'malformed', Path: `;${cwd}` }));
    restorePath();
    assert.deepEqual(r, { refuse: 'RF_VIZ_START_FAILED' });
    const { pid, grandchild } = report(dataDir);
    assert.ok(grandchild !== null);
    assert.ok(await gone(pid));
    assert.ok(await gone(grandchild), 'the tree was killed by the absolute taskkill.exe');
  } finally {
    restorePath();
    process.chdir(before);
    await t.cleanup();
  }
});

test('T-VIZ-handshake: the spawn is execPath with an argv array, no shell, detached and hidden, cwd = the data directory; a child that already exited is tree-killed on POSIX only (its process group), never on Windows (its pid may be reused); one still running is', async () => {
  const t = await makeTempRoot('viz-exited');
  try {
    const calls: Array<{ exe: string; argv: readonly string[]; options: SpawnOptions; pid: number | undefined }> = [];
    const kills: Array<number | undefined> = [];
    const deps: SpawnDeps = {
      spawn: (exe, argv, options) => { const c = spawn(exe, argv, options); calls.push({ exe, argv, options, pid: c.pid }); return c; },
      killTree: async (child, platform, systemRoot) => { kills.push(child.pid); await killTree(child, platform, systemRoot); },
    };
    // Exits 3 without a line: refused; after the exit, Windows kills nothing by the pid, POSIX signals the (now leaderless) group.
    const exited = join(t.root, 'exited');
    mkdirSync(exited);
    const a = args(exited, { COWORK_PROBE_MODE: 'exit' });
    assert.deepEqual(await spawnViewerWith(a, deps), { refuse: 'RF_VIZ_START_FAILED' });
    assert.deepEqual(kills, process.platform === 'win32' ? [] : [calls[0]?.pid], 'killTree after the child exited: POSIX only');
    kills.length = 0;
    assert.equal(calls.length, 1);
    const c = calls[0]!;
    assert.equal(c.exe, process.execPath);
    assert.deepEqual(c.argv, viewerArgv(a));
    assert.deepEqual({ ...c.options, env: undefined }, {
      shell: false, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], cwd: exited, env: undefined,
    });
    assert.equal(c.options.env, a.env);
    // Still running after a bad line: killed by its pid.
    const running = join(t.root, 'running');
    mkdirSync(running);
    assert.deepEqual(await spawnViewerWith(args(running, { COWORK_PROBE_MODE: 'malformed' }), deps), { refuse: 'RF_VIZ_START_FAILED' });
    const { pid } = report(running);
    assert.deepEqual(kills, [pid]);
    assert.ok(await gone(pid));
  } finally {
    await t.cleanup();
  }
});

/** A child for a spy spawn: pid 4242; its stdout ends and it exits with code 3 (no ready line), or it stays (call `exit()` later). */
function fakeViewer(o: { exits: boolean }): { child: ChildProcess; exit(): void } {
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    pid: 4242, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, stdout, unref: () => {}, kill: () => true,
  });
  const exit = (): void => {
    child.exitCode = 3;
    child.emit('exit', 3, null);
    stdout.end();
  };
  if (o.exits) setImmediate(exit);
  else setImmediate(() => { stdout.write('{"v":1,"port":"x"}\n'); });
  return { child: child as unknown as ChildProcess, exit };
}

test('T-VIZ-handshake: after the child exited, POSIX still kills its process group and Windows skips taskkill /T (both legs, through a spy spawn on every host)', async () => {
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    const kills: Array<[number | undefined, NodeJS.Platform, string | null]> = [];
    const deps = (o: { exits: boolean }): SpawnDeps => ({
      spawn: () => fakeViewer(o).child,
      killTree: async (child, p, systemRoot) => { kills.push([child.pid, p, systemRoot]); },
    });
    const systemRoot = platform === 'win32' ? 'C:\\Windows' : null;
    const a = args('/data', {}, { platform, systemRoot });
    // Exited without a line.
    assert.deepEqual(await spawnViewerWith(a, deps({ exits: true })), { refuse: 'RF_VIZ_START_FAILED' }, platform);
    assert.deepEqual(kills, platform === 'win32' ? [] : [[4242, platform, null]], `${platform}: after the exit`);
    kills.length = 0;
    // Still running after a bad line: killed on every OS.
    assert.deepEqual(await spawnViewerWith(a, deps({ exits: false })), { refuse: 'RF_VIZ_START_FAILED' }, platform);
    assert.deepEqual(kills, [[4242, platform, systemRoot]], `${platform}: running`);
  }
});

test('killTree (POSIX): the process-group kill is sent even when the leader has exited, ESRCH is ignored, and the pid alone is never signalled', async () => {
  const PID = 4242;
  // The leader has exited (Node saw it): its handle is never used on POSIX.
  const LEADER: KillTarget = { pid: PID, exitCode: 3, signalCode: null, kill: () => assert.fail('the leader is never signalled through its handle') };
  type Sent = [number, NodeJS.Signals | 0];
  /** process.kill over a fake group: `alive` says whether the group (members other than the exited leader) still exists. */
  const fakeKill = (sent: Sent[], state: { alive: boolean; dropsOnTerm: boolean; error?: string }): KillDeps => ({ killGroup: (pgid: number, signal: NodeJS.Signals | 0): void => {
    const pid = -pgid;   // what process.kill(-pgid, …) is given
    sent.push([pid, signal]);
    if (pid !== -PID) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });   // the leader itself is gone (its pid may be reused)
    if (state.error !== undefined) throw Object.assign(new Error(state.error), { code: state.error });
    if (!state.alive) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    if ((signal === 'SIGTERM' && state.dropsOnTerm) || signal === 'SIGKILL') state.alive = false;
  } });
  // A grandchild still in the group: SIGTERM to the group, a probe finds it gone, done.
  let sent: Sent[] = [];
  await killTreeWith(LEADER, 'linux', null, fakeKill(sent, { alive: true, dropsOnTerm: true }));
  assert.deepEqual(sent, [[-PID, 'SIGTERM'], [-PID, 0]]);
  // No group left (ESRCH), or a group no signal reaches (EPERM): nothing else is signalled, the bare pid never.
  for (const state of [{ alive: false, dropsOnTerm: true }, { alive: true, dropsOnTerm: true, error: 'EPERM' }]) {
    sent = [];
    await killTreeWith(LEADER, 'darwin', null, fakeKill(sent, state));
    assert.deepEqual(sent, [[-PID, 'SIGTERM']], JSON.stringify(state));
  }
  // A group that ignores SIGTERM: SIGKILL to the group after the grace period.
  sent = [];
  await killTreeWith(LEADER, 'linux', null, fakeKill(sent, { alive: true, dropsOnTerm: false }));
  assert.deepEqual(sent[0], [-PID, 'SIGTERM']);
  assert.deepEqual(sent[sent.length - 1], [-PID, 'SIGKILL']);
  assert.ok(sent.every(([pid]) => pid === -PID), JSON.stringify(sent));
});

test('killTree (win32): a child Node has seen exit is never killed; without an absolute SystemRoot only the held child is, through its handle (every host)', async () => {
  const handleKills: Array<NodeJS.Signals | number | undefined> = [];
  const child = (exitCode: number | null): KillTarget => ({ pid: 4242, exitCode, signalCode: null, kill: (s) => { handleKills.push(s); return true; } });
  const noGroup: KillDeps = { killGroup: () => assert.fail('no process-group signal on Windows') };
  // Exited: its pid may name another process by now; taskkill never runs (nothing is spawned for it either).
  await killTreeWith(child(3), 'win32', 'C:\\Windows', noGroup);
  assert.deepEqual(handleKills, []);
  // Running, no absolute SystemRoot (none, a relative one, a UNC one): only the child itself, through the held handle.
  for (const root of [null, 'Windows', '\\\\server\\share\\Windows']) await killTreeWith(child(null), 'win32', root, noGroup);
  assert.deepEqual(handleKills, ['SIGKILL', 'SIGKILL', 'SIGKILL']);
});

test('T-VIZ-handshake (POSIX): a child that exits without a line, leaving a grandchild in its process group, is refused and the grandchild is killed through the group',
  { skip: process.platform === 'win32' ? 'POSIX legs only' : false }, async () => {
    const t = await makeTempRoot('viz-orphan');
    try {
      assert.deepEqual(await spawnViewer(args(t.root, { COWORK_PROBE_MODE: 'orphan' })), { refuse: 'RF_VIZ_START_FAILED' });
      const { pid, grandchild } = report(t.root);
      assert.ok(grandchild !== null);
      assert.ok(await gone(pid));
      assert.ok(await gone(grandchild), `the grandchild ${grandchild} is gone`);
    } finally {
      await t.cleanup();
    }
  });

test('an abort is never silent (Task 15 fix round 2 ruling): spawnViewer gives the viewer <data dir>/log/viz-stderr.txt as its stderr, so a viewer that V8 ends with "heap out of memory" under its old-space cap leaves that line there; the file is appended to, starts over past 1 MiB, is never a symlink, and without a data directory the child gets no stderr', { timeout: 90_000 }, async () => {
  const t = await makeTempRoot('viz-stderr');
  try {
    // The real spawnViewer: the probe answers its ready line, then fills its JS heap until V8 ends it.
    const dataDir = join(t.root, 'data dir');
    mkdirSync(dataDir);
    assert.deepEqual(await spawnViewer(args(dataDir, { COWORK_PROBE_MODE: 'oom' })), { port: PROBE_PORT, launch: PROBE_LAUNCH });
    const logDir = join(dataDir, 'log');
    const file = join(logDir, 'viz-stderr.txt');
    let text = '';
    for (const end = Date.now() + 60_000; Date.now() < end; await sleep(100)) {
      text = existsSync(file) ? readFileSync(file, 'utf8') : '';
      if (/heap out of memory/.test(text)) break;
    }
    assert.match(text, /heap out of memory/, 'V8\'s fatal line reached the stderr file');
    assert.ok(await gone(report(dataDir).pid, 30_000), 'V8 ended the viewer');
    assert.equal(VIEWER_STDERR_FILE, 'viz-stderr.txt');
    assert.equal(VIEWER_STDERR_MAX_BYTES, 1_048_576);
    assert.ok(!/^viz-.*\.jsonl$/.test(VIEWER_STDERR_FILE), 'not a viewer log file (cleanup and log readers skip it)');
    if (process.platform !== 'win32') assert.equal(statSync(logDir).mode & 0o077, 0, 'log/ is created user-only');

    // Appended to; started over once it is past 1 MiB.
    writeFileSync(file, 'abc');
    let f = openViewerStderr(dataDir, process.platform);
    assert.ok(f !== null);
    writeSync(f.fd, 'x');
    f.close();
    assert.equal(readFileSync(file, 'utf8'), 'abcx');
    writeFileSync(file, Buffer.alloc(VIEWER_STDERR_MAX_BYTES + 1, 0x61));
    f = openViewerStderr(dataDir, process.platform);
    assert.ok(f !== null);
    writeSync(f.fd, 'y');
    f.close();
    assert.equal(readFileSync(file, 'utf8'), 'y');

    // A symlink in its place is not followed (where this host lets the test make one).
    const outside = join(t.root, 'outside.txt');
    writeFileSync(outside, 'keep');
    unlinkSync(file);
    let linked = true;
    try {
      symlinkSync(outside, file);
    } catch {
      linked = false;
    }
    if (linked) {
      assert.equal(openViewerStderr(dataDir, process.platform), null, 'a symlink');
      assert.equal(readFileSync(outside, 'utf8'), 'keep');
      unlinkSync(file);
    }

    // No data directory: no file, nothing created, and the spawn uses 'ignore'.
    const absent = join(t.root, 'absent');
    assert.equal(openViewerStderr(absent, process.platform), null);
    assert.equal(existsSync(absent), false);
    const seen: SpawnOptions[] = [];
    const spy = (stderr: SpawnDeps['stderr']): SpawnDeps => ({
      spawn: (exe, argv, options) => { seen.push(options); return spawn(exe, argv, options); }, killTree, stderr,
    });
    const ready = join(t.root, 'ready');
    mkdirSync(ready);
    assert.deepEqual(await spawnViewerWith(args(ready, {}), spy(openViewerStderr)), { port: PROBE_PORT, launch: PROBE_LAUNCH });
    assert.equal(typeof (seen[0]?.stdio as unknown[])[2], 'number', 'the stderr file\'s descriptor');
    assert.ok(existsSync(join(ready, 'log', VIEWER_STDERR_FILE)));
    assert.deepEqual(await spawnViewerWith(args(absent, {}), spy(() => null)), { refuse: 'RF_VIZ_START_FAILED' });
    assert.deepEqual((seen[1]?.stdio as unknown[])[2], 'ignore');
  } finally {
    await t.cleanup();
  }
});

test('T-VIZ-handshake: the 512-byte cap applies while the line streams in: more than 512 bytes without a LF refuse at once, not at the 5 s timeout', async () => {
  const t = await makeTempRoot('viz-trickle');
  try {
    const started = Date.now();
    assert.deepEqual(await spawnViewer(args(t.root, { COWORK_PROBE_MODE: 'trickle' })), { refuse: 'RF_VIZ_START_FAILED' });
    const elapsed = Date.now() - started;
    const { pid, grandchild } = report(t.root);
    assert.ok(elapsed < READY_TIMEOUT_MS - 2_000, `refused after ${elapsed} ms`);
    assert.ok(await gone(pid));
    assert.ok(grandchild !== null && await gone(grandchild));
  } finally {
    await t.cleanup();
  }
});

test('T-VIZ-handshake (POSIX): killTree sends SIGTERM to the group first, so the viewer kills its git children (each in its own process group), then SIGKILL after the grace period',
  { skip: process.platform === 'win32' ? 'POSIX legs only' : false }, async () => {
    const t = await makeTempRoot('viz-grace');
    try {
      for (const mode of ['group-children', 'stubborn']) {
        const dataDir = join(t.root, mode);
        mkdirSync(dataDir);
        assert.deepEqual(await spawnViewer(args(dataDir, { COWORK_PROBE_MODE: mode })), { refuse: 'RF_VIZ_START_FAILED' }, mode);
        const { pid, grandchild } = report(dataDir);
        assert.ok(grandchild !== null, mode);
        assert.ok(await gone(pid), `${mode}: the child ${pid} is gone`);
        assert.ok(await gone(grandchild), `${mode}: the grandchild ${grandchild} is gone`);
      }
    } finally {
      await t.cleanup();
    }
  });

/** Fs over hostFs that records the paths given to realpath and lstat. */
function spyFs(seen: string[]): Fs {
  return {
    ...hostFs,
    realpath: (p: string) => { seen.push(p); return hostFs.realpath(p); },
    lstat: (p: string) => { seen.push(p); return hostFs.lstat(p); },
  };
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

test('T-VIZ-env: the probe child\'s environment has none of CLAUDE_CODE_MESSAGING_TOKEN, CLAUDE_PLUGIN_DATA, NODE_OPTIONS, GIT_DIR, has LC_ALL=C, its cwd is the data directory, its PATH is the filtered list, and its argv carries --data-dir, --lang, --sha256 and, with --repo, --git', async () => {
  const t = await makeTempRoot('viz-env');
  try {
    const git = findSystemGit();
    assert.ok(git !== null, 'a git on PATH');
    const { pluginRoot, vizJs } = fakePluginRoot(t.root);
    const sha = createHash('sha256').update(readFileSync(vizJs)).digest('hex');
    // The CLI runs from inside a repository whose bin/ holds a git; PATH also has an empty entry, '.', a relative and a missing entry.
    const cwd = join(t.root, 'cwd repo');
    mkdirSync(join(cwd, '.git'), { recursive: true });
    mkdirSync(join(cwd, 'bin'));
    writeFileSync(join(cwd, 'bin', process.platform === 'win32' ? 'git.exe' : 'git'), 'planted');
    const good = join(t.root, 'good bin');
    mkdirSync(good);
    const gitDir = dirname(git);
    const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
    const dataDir = join(t.root, 'plugin data');
    const env: Record<string, string> = {
      [pathKey]: ['', join(cwd, 'bin'), '.', 'relative', good, join(t.root, 'missing'), gitDir].join(delimiter),
      [MESSAGING]: TOKEN, CLAUDE_PLUGIN_DATA: dataDir, CLAUDE_PROJECT_DIR: cwd, NODE_OPTIONS: `--require "${join(t.root, 'missing.cjs').split('\\').join('/')}"`,
      GIT_DIR: join(cwd, '.git'), LC_ALL: 'fr_FR.UTF-8', HOME: t.root,
    };
    if (SYSTEM_ROOT !== null) env.SystemRoot = SYSTEM_ROOT;
    const repo = join(t.root, 'the repo');
    const seen: string[] = [];
    const rec = recordingEnv({
      pluginRoot, cwd, home: t.root, env, locale: 'ko-KR', fs: spyFs(seen), ownerProbe: realOwnerProbe, uid: process.geteuid?.() ?? null,
      spawnViewer,
    });
    assert.equal(await runView(['--no-open', '--repo', repo], rec.env), 0, rec.errs.join('\n'));
    assert.deepEqual(assertAllRendered(rec, { channel: 'terminal', lang: 'ko', cmd: null }), ['UI_VIZ_URL']);

    const r = report(dataDir);
    const keys = Object.keys(r.env).map((k) => k.toUpperCase());
    for (const k of [MESSAGING, 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PROJECT_DIR', 'NODE_OPTIONS', 'GIT_DIR']) assert.ok(!keys.includes(k), k);
    assert.equal(r.env.LC_ALL, 'C');
    assert.equal(realpathSync(r.cwd), realpathSync(dataDir));
    assert.deepEqual(Object.keys(r.env).filter((k) => k.toUpperCase() === 'PATH'), [pathKey]);
    assert.equal(r.env[pathKey], [good, gitDir].join(delimiter));
    assert.deepEqual(r.argv, ['serve', '--data-dir', dataDir, '--lang', 'ko', '--sha256', sha, '--git', git, '--repo', repo]);
    for (const f of filesUnder(dataDir)) assert.ok(!readFileSync(f, 'utf8').includes(TOKEN), `the token is in ${f}`);
    // The git candidate of the kept git directory was examined, and the planted one in <cwd repo>/bin never was (a bare `endsWith('git')`
    // matched every `.git` lookup and could not fail).
    const gitName = process.platform === 'win32' ? 'git.exe' : 'git';
    assert.ok(seen.includes(join(gitDir, gitName)), 'git was resolved for --repo');
    assert.ok(!seen.includes(join(cwd, 'bin', gitName)), 'the planted git was never a candidate');

    // --demo: no --git and no git resolved.
    seen.length = 0;
    const demo = recordingEnv({
      pluginRoot, cwd, home: t.root, env, locale: 'ko-KR', fs: spyFs(seen), ownerProbe: realOwnerProbe, uid: process.geteuid?.() ?? null, spawnViewer,
    });
    assert.equal(await runView(['--no-open', '--demo'], demo.env), 0, demo.errs.join('\n'));
    assert.deepEqual(assertAllRendered(demo, { channel: 'terminal', lang: 'ko', cmd: null }), ['UI_VIZ_URL']);
    assert.deepEqual(report(dataDir).argv, ['serve', '--data-dir', dataDir, '--lang', 'ko', '--sha256', sha, '--demo']);
    assert.deepEqual(seen.filter((p) => /[\\/]git(\.exe)?$/i.test(p)), []);
    assert.ok(statSync(dataDir).isDirectory());
  } finally {
    await t.cleanup();
  }
});

test('langOf maps OS locales to the six codes, else en, and --lang reaches the probe child under LC_ALL=C', async () => {
  const table: Array<[string, string]> = [
    ['ko-KR', 'ko'], ['ko', 'ko'], ['ja-JP', 'ja'], ['fr-CA', 'fr'], ['fr', 'fr'], ['es-MX', 'es'], ['es-419', 'es'], ['en-GB', 'en'],
    ['zh-CN', 'zh-CN'], ['zh-SG', 'zh-CN'], ['zh-Hans', 'zh-CN'], ['zh-Hans-HK', 'zh-CN'], ['zh-TW', 'en'], ['zh-HK', 'en'], ['zh-Hant-TW', 'en'],
    ['zh', 'en'], ['kok-IN', 'en'], ['jam', 'en'], ['de-DE', 'en'], ['', 'en'], ['und', 'en'], ['KO-kr', 'ko'], ['zh-cn', 'zh-CN'],
  ];
  for (const [locale, lang] of table) assert.equal(langOf(locale), lang, locale);

  const t = await makeTempRoot('viz-lang');
  try {
    const { pluginRoot } = fakePluginRoot(t.root);
    const dataDir = join(t.root, 'data');
    const env: Record<string, string> = { CLAUDE_PLUGIN_DATA: dataDir, LC_ALL: 'de_DE.UTF-8', LANG: 'de_DE.UTF-8', LANGUAGE: 'de' };
    if (SYSTEM_ROOT !== null) env.SystemRoot = SYSTEM_ROOT;
    const rec = recordingEnv({ pluginRoot, cwd: t.root, home: t.root, env, locale: 'ja-JP', ownerProbe: realOwnerProbe, uid: process.geteuid?.() ?? null, spawnViewer });
    assert.equal(await runView(['--no-open', '--demo'], rec.env), 0, rec.errs.join('\n'));
    assert.deepEqual(assertAllRendered(rec, { channel: 'terminal', lang: 'ja', cmd: null }), ['UI_VIZ_URL']);
    const r = report(dataDir);
    assert.equal(r.argv[r.argv.indexOf('--lang') + 1], 'ja');
    assert.equal(r.env.LC_ALL, 'C');
    assert.equal(r.env.LANGUAGE, '');
  } finally {
    await t.cleanup();
  }
});

test('the sha256 of dist/viz.js is passed as --sha256', async () => {
  const t = await makeTempRoot('viz-sha');
  try {
    const { pluginRoot, vizJs } = fakePluginRoot(t.root);
    const dataDir = join(t.root, 'data');
    const env: Record<string, string> = { CLAUDE_PLUGIN_DATA: dataDir };
    if (SYSTEM_ROOT !== null) env.SystemRoot = SYSTEM_ROOT;
    const sha = (): string => createHash('sha256').update(readFileSync(vizJs)).digest('hex');
    const shaArg = (): string => { const a = report(dataDir).argv; return a[a.indexOf('--sha256') + 1] as string; };
    const rec = recordingEnv({ pluginRoot, cwd: t.root, home: t.root, env, ownerProbe: realOwnerProbe, uid: process.geteuid?.() ?? null, spawnViewer });
    assert.equal(await runView(['--no-open', '--demo'], rec.env), 0, rec.errs.join('\n'));
    assert.equal(shaArg(), sha());
    writeFileSync(vizJs, `${readFileSync(vizJs, 'utf8')}// changed\n`);
    assert.equal(await runView(['--no-open', '--demo'], rec.env), 0, rec.errs.join('\n'));
    assert.equal(shaArg(), sha());
    assert.match(shaArg(), /^[0-9a-f]{64}$/);
    assert.deepEqual(assertAllRendered(rec, { channel: 'terminal', lang: 'en', cmd: null }), ['UI_VIZ_URL', 'UI_VIZ_URL']);
  } finally {
    await t.cleanup();
  }
});
