// The foreground daemon (Plan 2 Task 17; `node dist/daemon.js run|recover|resume|--version`; rulings R-23, R-26, R-28;
// LIF-05, SEC-11 subset; Plan 1 ledger minor #4, core.sshCommand). runDaemon runs in-process on the real ports (real
// clock, scheduler, file system and git runner) against file:// bare remotes, and the built bundle is spawned for
// --version. Git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseDaemonArgs, remoteRefusalNext, resolveRemote, RESPAWN_LIMIT, RESPAWN_WINDOW_MS, RespawnBudget, runDaemon, sanitizeUrl, shellQuote, startRefusalNext, STOP_POLL_MS, type DaemonArgs, type DaemonIo,
} from '../../src/daemon/run.js';
import { STOP_REQUEST_FILE } from '../../src/engine/daemonFiles.js';
import { VirtualClock } from '../sim/vclock.js';
import { DaemonLock, Engine } from '../../src/engine/loop.js';
import { machineMonoMs, realClock } from '../../src/ports/clock.js';
import { realFs } from '../../src/ports/fs.js';
import { fileLog } from '../../src/ports/log.js';
import type { StatusJson } from '../../src/engine/status.js';
import type { Json } from '../../src/board/canonicalJson.js';
import { GitRepo, type RepoContext } from '../../src/git/repo.js';
import { sanitizeText, userinfoKind } from '../../src/sec/redact.js';
import { PLUGIN_VERSION } from '../../src/version.js';
import { clonePeer, seedRemote, type PeerClone } from '../sim/peers.js';
import { createBareRemote, type BareRemote } from '../sim/remote.js';
import { lockOf, logOf, withEngines } from '../helpers/engineFixture.js';
import { forceRemote } from '../helpers/incidentFixture.js';
import { gitIn } from '../helpers/startFixture.js';
import { makeTempRoot, testRunner } from '../helpers/tmp.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const runner = testRunner();

/** The daemon's environment: this process's, without proxies and ssh overrides (a localhost URL must fail at once). */
function daemonEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) if (/^(https?_proxy|all_proxy|no_proxy|git_ssh_command|git_ssh|git_ssh_variant)$/i.test(k)) delete env[k];
  return { ...env, ...extra };
}

interface Session { io: DaemonIo; lines: string[]; stop(): void; stopIfRunning(): void; }
function session(): Session {
  const lines: string[] = [];
  let cb: (() => void) | null = null;
  return {
    io: { out: (l) => lines.push(l), err: (l) => lines.push(l), onStop: (f) => { cb = f; } },
    lines,
    stop: () => {
      assert.ok(cb !== null, 'the daemon registered a stop handler');
      cb();
    },
    // finally hooks: a daemon that registered its stop handler is stopped, whatever the test's assertions did.
    stopIfRunning: () => cb?.(),
  };
}

/** The in-process daemons of one test: each one started is stopped and awaited in the test's finally, whatever failed. */
interface Daemons { start(a: DaemonArgs): { s: Session; done: Promise<number> }; stopAll(): Promise<void>; }
function daemons(): Daemons {
  const all: Array<{ s: Session; done: Promise<number> }> = [];
  return {
    start(a) {
      const s = session();
      const done = runDaemon(a, daemonEnv(), s.io);
      all.push({ s, done });
      return { s, done };
    },
    async stopAll() {
      for (const d of all) {
        d.s.stopIfRunning();
        await d.done.catch(() => undefined);
      }
    },
  };
}

function args(dir: string, over: Partial<DaemonArgs> = {}): DaemonArgs {
  return { cmd: 'run', repo: dir, branch: 'main', publish: null, name: 'Tester', remote: null, confirm: null, ...over };
}

async function statusIn(dir: string): Promise<StatusJson | null> {
  try {
    return JSON.parse((await readFile(join(dir, '.git', 'cowork', 'status.json'))).toString('utf8')) as StatusJson;
  } catch {
    return null;
  }
}

async function waitFor<T>(what: string, f: () => Promise<T | null | undefined | false>, ms = 90_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v !== null && v !== undefined && v !== false) return v;
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function remoteWithClones(label: string, n: number): Promise<{ root: string; remote: BareRemote; clones: PeerClone[]; cleanup(): Promise<void> }> {
  const { root, cleanup } = await makeTempRoot(label);
  const remote = await createBareRemote(root, runner);
  await seedRemote(remote, root, runner, { 'README.md': Buffer.from('# daemon\n'), 'a.txt': Buffer.from('a\n') });
  const clones: PeerClone[] = [];
  for (let i = 0; i < n; i++) clones.push(await clonePeer(remote, root, { name: `c${i + 1}`, autocrlf: false, withFilter: false }, runner));
  return { root, remote, clones, cleanup };
}

async function git(dir: string, a: string[]): Promise<string> {
  const r = await runner.run(a, { class: 'local', cwd: dir, identity: { name: 'T', email: 't@cowork.invalid' } });
  assert.equal(r.code, 0, `git ${a.join(' ')}: ${r.stderr.toString('utf8')}`);
  return r.stdout.toString('utf8').trim();
}

test('dist/daemon.js --version prints the version', () => {
  const out = join(tmpdir(), `cowork-daemon-build-${process.pid}`);
  try {
    const b = spawnSync(process.execPath, [join(repoRoot, 'tools', 'build', 'build.mjs'), '--outdir', out], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(b.status, 0, b.stderr);
    const v = spawnSync(process.execPath, [join(out, 'daemon.js'), '--version'], { encoding: 'utf8' });
    assert.equal(v.status, 0, v.stderr);
    assert.equal(v.stdout, `cowork-sync daemon ${PLUGIN_VERSION}\n`);
    // A usage error exits 2 with the usage on stderr; no arguments at all is a no-op (Plan 1's bundle check).
    const bad = spawnSync(process.execPath, [join(out, 'daemon.js'), 'run', '--repo'], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /usage: .*daemon\.js run --repo <path> --branch <b>/);
    const none = spawnSync(process.execPath, [join(out, 'daemon.js')], { encoding: 'utf8' });
    assert.deepEqual([none.status, none.stdout], [0, '']);
    // A refusal through a pipe: exit 1 after both printed lines reached the reader (stdout flushed before the exit).
    const refused = spawnSync(process.execPath, [join(out, 'daemon.js'), 'run', '--repo', join(out, 'no such repo'), '--branch', 'main'], { encoding: 'utf8' });
    assert.equal(refused.status, 1, refused.stderr);
    assert.deepEqual(refused.stdout.trim().split('\n').map((l) => l.split(' ')[0]), ['START_REPO_SHAPE', 'next:'], refused.stdout);
  } finally {
    spawnSync(process.execPath, ['-e', `require('fs').rmSync(${JSON.stringify(out)}, { recursive: true, force: true })`]);
  }
});

test('parseDaemonArgs reads the three commands and refuses anything else', () => {
  assert.deepEqual(parseDaemonArgs(['run', '--repo', 'r', '--branch', 'main', '--publish=all', '--name', 'Ann', '--remote', 'up']),
    { cmd: 'run', repo: 'r', branch: 'main', publish: 'all', name: 'Ann', remote: 'up', confirm: null });
  assert.deepEqual(parseDaemonArgs(['recover', '--repo', 'r', '--branch', 'b', '--confirm=abc123']),
    { cmd: 'recover', repo: 'r', branch: 'b', publish: null, name: null, remote: null, confirm: 'abc123' });
  assert.deepEqual(parseDaemonArgs(['resume', '--branch', 'b', '--repo', 'r']), { cmd: 'resume', repo: 'r', branch: 'b', publish: null, name: null, remote: null, confirm: null });
  for (const bad of [['run'], ['run', '--repo', 'r'], ['run', '--repo', 'r', '--branch', 'b', '--publish=some'], ['stop', '--repo', 'r', '--branch', 'b'], ['run', '--repo', 'r', '--branch', 'b', '--confirm=x'], ['resume', '--repo', 'r', '--branch', 'b', '--publish=all']]) {
    const r = parseDaemonArgs(bad);
    assert.ok('usage' in r && r.exitCode === 2, JSON.stringify(bad));
  }
  const help = parseDaemonArgs(['--help']);
  assert.ok('usage' in help && help.exitCode === 0);
});

test('every start refusal prints one next step of its own: START_REPO_SHAPE{tmp_volume} says how to put tmp/ on the work tree volume', () => {
  const a = args('/repos/a b', { branch: 'main' });
  const tmp = startRefusalNext('START_REPO_SHAPE', { reason: 'tmp_volume' }, a, 'https://example.invalid/r.git');
  assert.match(tmp, /same volume/, tmp);
  assert.ok(!tmp.startsWith('fix the condition above'), tmp);
  assert.match(tmp, /node dist\/daemon\.js run --repo .*a b.* --branch main$/, tmp);
  // START_REMOTE names the remote by its URL without userinfo.
  const remote = startRefusalNext('START_REMOTE', { reason: 'unreachable' }, a, 'https://alice:s3cret@example.invalid/r.git');
  assert.ok(remote.includes('https://example.invalid/r.git') && !remote.includes('s3cret'), remote);
});

test('the respawn budget counts crashes inside a 10 min window: 5 respawns with doubling delays, the 6th crash in the window exits, and crashes spread over time never exhaust it', () => {
  const clock = new VirtualClock({ startMono: 0 });
  const b = new RespawnBudget(clock);
  assert.deepEqual([RESPAWN_LIMIT, RESPAWN_WINDOW_MS], [5, 600_000]);
  // A crash loop: 5 respawns 2 s, 4 s, 8 s, 16 s, 32 s apart, then the budget is spent.
  const delays: Array<number | null> = [];
  for (let i = 0; i < 6; i++) {
    const d = b.crash();
    delays.push(d);
    if (d !== null) clock.advance(d);
  }
  assert.deepEqual(delays, [2_000, 4_000, 8_000, 16_000, 32_000, null]);
  // Once the window has passed since those crashes, a crash is the first of a new window again.
  clock.advance(RESPAWN_WINDOW_MS);
  assert.equal(b.crash(), 2_000);
  // One transient crash every 11 min for a day: every one is respawned at the first delay (no lifetime count).
  const spread = new RespawnBudget(clock);
  for (let i = 0; i < 130; i++) {
    clock.advance(11 * 60_000);
    assert.equal(spread.crash(), 2_000, `crash ${i + 1}`);
  }
  // The delay never exceeds 60 s.
  const capped = new RespawnBudget(clock, 10);
  const ds: Array<number | null> = [];
  for (let i = 0; i < 8; i++) ds.push(capped.crash());
  assert.deepEqual(ds, [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
});

test('printed next commands quote each word for the OS shell', () => {
  // A plain word stays bare on every OS.
  for (const os of ['linux', 'darwin', 'win32'] as const) assert.equal(shellQuote('main', os), 'main');
  // POSIX sh: single quotes, a quote inside closed and escaped; no backslash is doubled.
  assert.equal(shellQuote('/tmp/a b', 'linux'), "'/tmp/a b'");
  assert.equal(shellQuote("it's", 'darwin'), "'it'\\''s'");
  assert.equal(shellQuote('$HOME/x`y', 'linux'), "'$HOME/x`y'");
  // cmd.exe and PowerShell: a Windows path without specials stays bare; with a space, double quotes, backslashes kept as
  // they are except a trailing run, doubled so the closing quote stays a quote for the program's argument parser.
  assert.equal(shellQuote('C:\\Users\\a b\\c1', 'win32'), '"C:\\Users\\a b\\c1"');
  assert.equal(shellQuote('C:\\x\\y', 'win32'), 'C:\\x\\y');
  assert.equal(shellQuote('C:\\a b\\', 'win32'), '"C:\\a b\\\\"');

  // Hostile words (01-engine §2 next commands carry branch names and paths): POSIX single quotes keep each one literal.
  const hostile = ['a&b', 'a|b', '%VAR%', '$x', 'a`b', 'a;b'];
  for (const os of ['linux', 'darwin'] as const) assert.deepEqual(hostile.map((w) => shellQuote(w, os)), ["'a&b'", "'a|b'", "'%VAR%'", "'$x'", "'a`b'", "'a;b'"]);
  // Windows: inside double quotes cmd.exe and PowerShell both keep & | ; literal; but cmd expands %VAR% (and !VAR! under
  // delayed expansion) and PowerShell expands $x and a backtick escape there, and no quoting read alike by both keeps
  // them: such a word is refused (null), as is a double quote or a typographic one PowerShell reads as a quote.
  assert.deepEqual(hostile.map((w) => shellQuote(w, 'win32')), ['"a&b"', '"a|b"', null, null, null, '"a;b"']);
  for (const w of ['a"b', 'a!b', 'a\u201Cb', 'a\u201Db', 'a\u201Eb']) assert.equal(shellQuote(w, 'win32'), null, JSON.stringify(w));
  // PowerShell reads a bare leading @ as splatting, a bare , as an array and a bare leading digit as a number: quoted.
  assert.deepEqual(['@x', 'a,b', '1kb'].map((w) => shellQuote(w, 'win32')), ['"@x"', '"a,b"', '"1kb"']);
  // A control character (a terminal escape, a newline) is refused everywhere.
  for (const os of ['linux', 'win32'] as const) for (const w of ['a\x1bb', 'a\nb', 'a\tb']) assert.equal(shellQuote(w, os), null);
});

/** The program's argv as ASCII JSON (non-ASCII as \u escapes, so no console code page can change it). */
const ARGV_SCRIPT = "process.stdout.write(JSON.stringify(process.argv.slice(2)).replace(/[\\u0080-\\uffff]/g, (c) => '\\\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')));\n";

/** Runs one command line in this OS's shell (sh; cmd.exe on Windows, which keeps the line between /s /c's quotes as typed). */
function shellRun(line: string, cwd: string, env: NodeJS.ProcessEnv = process.env): { status: number | null; stdout: string; stderr: string } {
  const r = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { cwd, env, encoding: 'utf8', windowsVerbatimArguments: true })
    : spawnSync('/bin/sh', ['-c', line], { cwd, env, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('every quoted word reaches the program unchanged through the real shell: sh on POSIX; cmd.exe and Windows PowerShell on Windows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cowork-quote-'));
  try {
    const script = join(dir, 'argv.js');
    await writeFile(script, ARGV_SCRIPT);
    const words = [
      'a&b', 'a|b', '%VAR%', '$x', 'a`b', 'a;b', 'x y', "it's", 'a,b', '@x', '(a)', 'a^b', 'a<b>c', '!x!', '#h', '~u', '{a}',
      '1kb', '--%', 'é ü', 'C:\\a b\\', 'C:\\x\\', 'feat/x-1.2', 'url.git@mirror.invalid:.insteadof', "a'b\"c",
    ];
    // Variables a shell would expand if a word were not quoted safely.
    const env = { ...process.env, VAR: 'EXPANDED', x: 'EXPANDED' };
    const os = process.platform;
    const quoted = words.map((w) => ({ w, q: shellQuote(w, os) })).filter((x): x is { w: string; q: string } => x.q !== null);
    const line = `${shellQuote(process.execPath, os)!} ${shellQuote(script, os)!} ${quoted.map((x) => x.q).join(' ')}`;
    const want = quoted.map((x) => x.w);
    if (os !== 'win32') assert.equal(quoted.length, words.length, 'POSIX quotes every word');
    const sh = shellRun(line, dir, env);
    assert.equal(sh.status, 0, sh.stderr);
    assert.deepEqual(JSON.parse(sh.stdout), want, `${os === 'win32' ? 'cmd.exe' : 'sh'}: ${line}`);
    if (os === 'win32') {
      // Windows PowerShell 5.1: the same line after the call operator.
      const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`& ${line}`, 'utf16le').toString('base64')], { cwd: dir, env, encoding: 'utf8' });
      assert.equal(ps.status, 0, ps.stderr);
      assert.deepEqual(JSON.parse(ps.stdout), want, `powershell: & ${line}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('printed next commands quote hostile branch names per OS, and show a placeholder where no quoting is safe', () => {
  const url = 'https://example.invalid/r.git';
  for (const b of ['a&b', 'a|b', '%VAR%', '$x', 'a`b', 'a;b']) {
    for (const os of ['linux', 'win32'] as const) {
      const a = args('/repos/r', { branch: b });
      const word = shellQuote(b, os) ?? '<branch>';
      const head = startRefusalNext('START_HEAD_STATE', {}, a, url, os);
      assert.ok(head.startsWith(`git switch ${word} `) && head.endsWith(`--branch ${word}`), `${os}: ${head}`);
      const ahead = startRefusalNext('START_HEAD_AHEAD', {}, a, url, os);
      assert.ok(ahead.includes(`to ${word} `), `${os}: ${ahead}`);
      // START_REMOTE: the branch's remote setting is a quoted config key, never the raw name.
      const key = shellQuote(`branch.${b}.remote`, os) ?? '<branch.name.remote>';
      const remote = remoteRefusalNext('START_REMOTE', { reason: 'no_remote' }, a, os);
      assert.ok(remote.includes(`git config ${key} <name>`) && remote.includes(`--branch ${word}`), `${os}: ${remote}`);
      // No unquoted hostile name anywhere: every occurrence of the raw name sits inside one of its quoted words.
      for (const line of [head, ahead, remote]) assert.equal(line.split(key).join('').split(word).join('').includes(b), false, `${os}: ${line}`);
    }
  }
  // Windows: a branch named %VAR% is shown as a placeholder (cmd would expand it inside any quotes).
  assert.match(startRefusalNext('START_HEAD_STATE', {}, args('/r', { branch: '%VAR%' }), url, 'win32'), /^git switch <branch> .*--branch <branch>$/);
});

test('run on a fresh clone performs genesis, run on a second clone joins, a stop signal drains to status down, and running again restarts', async () => {
  const f = await remoteWithClones('daemon-run', 2);
  const ds = daemons();
  try {
    const [c1, c2] = f.clones as [PeerClone, PeerClone];
    const a = ds.start(args(c1.dir, { name: 'Alice' }));
    await waitFor('genesis', async () => (await statusIn(c1.dir))?.state === 'ok');
    assert.ok(a.s.lines.some((l) => /\bgenesis\b/.test(l)), a.s.lines.join('\n'));

    const b = ds.start(args(c2.dir, { name: 'Bob' }));
    await waitFor('join', async () => (await statusIn(c2.dir))?.state === 'ok');
    assert.ok(b.s.lines.some((l) => /\bjoin\b/.test(l)), b.s.lines.join('\n'));

    // A change made on c2 reaches c1 through the two running daemons.
    await writeFile(join(c2.dir, 'a.txt'), 'a by Bob\n');
    await waitFor('the change on c1', async () => {
      try {
        return (await readFile(join(c1.dir, 'a.txt'), 'utf8')).replace(/\r\n/g, '\n') === 'a by Bob\n';
      } catch (e) {
        // The verifying writer's own window: p is at its .old name until the new bytes are linked in (ENG-35).
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw e;
      }
    }, 120_000);

    b.s.stop();
    assert.equal(await b.done, 0);
    const down = await statusIn(c2.dir);
    assert.deepEqual([down?.state, down?.message_code], ['down', null], 'a stop drains to down without a code');
    await assert.rejects(stat(join(c2.dir, '.git', 'cowork', 'daemon.lock')), 'the lock is released');

    const b2 = ds.start(args(c2.dir, { name: 'Bob' }));
    await waitFor('restart', async () => (await statusIn(c2.dir))?.state === 'ok');
    assert.ok(b2.s.lines.some((l) => /\brestart\b/.test(l)), b2.s.lines.join('\n'));
    b2.s.stop();
    assert.equal(await b2.done, 0);
    a.s.stop();
    assert.equal(await a.done, 0);
  } finally {
    await ds.stopAll();
    await f.cleanup();
  }
});

test('cowork stop: a stop-request file drains run to status down and exit 0; a request left from before the run never stops it', async () => {
  const f = await remoteWithClones('daemon-stopfile', 1);
  const ds = daemons();
  try {
    const [c1] = f.clones as [PeerClone];
    const coworkDir = join(c1.dir, '.git', 'cowork');
    const request = join(coworkDir, STOP_REQUEST_FILE);
    // A leftover request (an earlier run ended before it saw it) is removed once the lock is held.
    await mkdir(coworkDir, { recursive: true });
    await writeFile(request, 'leftover\n');
    const a = ds.start(args(c1.dir));
    await waitFor('genesis', async () => (await statusIn(c1.dir))?.state === 'ok');
    let settled = false;
    void a.done.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, STOP_POLL_MS * 4));
    assert.equal(settled, false, `the leftover request stopped the run: ${a.s.lines.join('\n')}`);
    await assert.rejects(stat(request), 'the leftover request was removed');

    await writeFile(request, 'stop\n');
    assert.equal(await a.done, 0, a.s.lines.join('\n'));
    assert.ok(a.s.lines.includes('stopped'), a.s.lines.join('\n'));
    assert.equal((await statusIn(c1.dir))?.state, 'down');
    await assert.rejects(stat(join(coworkDir, 'daemon.lock')), 'the lock is released');
    await assert.rejects(stat(request), 'the request is removed when run ends');
  } finally {
    await ds.stopAll();
    await f.cleanup();
  }
});

test('a second run on the same clone refuses while the first holds daemon.lock; a lock with a dead pid is replaced', async () => {
  const f = await remoteWithClones('daemon-lock', 2);
  const ds = daemons();
  try {
    const [c1, c2] = f.clones as [PeerClone, PeerClone];
    const a = ds.start(args(c1.dir));
    await waitFor('genesis', async () => (await statusIn(c1.dir))?.state === 'ok');
    // An own leftover the restart would delete (ENG-53): the refused second daemon must not touch it.
    const leftover = join(c1.dir, '.git', 'cowork', 'tmp', '1.new');
    await writeFile(leftover, 'leftover');
    const second = ds.start(args(c1.dir));
    assert.equal(await second.done, 1);
    assert.ok(second.s.lines.some((l) => l.includes('DAEMON_ALREADY_RUNNING')), second.s.lines.join('\n'));
    // The next line names the lock file, so a human can remove a stale one.
    assert.ok(second.s.lines.some((l) => l.startsWith('next: ') && l.includes(join('.git', 'cowork', 'daemon.lock'))), second.s.lines.join('\n'));
    assert.equal(await readFile(leftover, 'utf8'), 'leftover', 'nothing touched before the lock refused');
    a.s.stop();
    assert.equal(await a.done, 0);

    // A lock naming this process's own pid under an instance this process does not hold (an earlier run whose pid came
    // back) is stale: replaced, never refused forever.
    const ownLock = join(c1.dir, '.git', 'cowork', 'daemon.lock');
    await writeFile(ownLock, `${JSON.stringify({ pid: process.pid, plugin_version: PLUGIN_VERSION, instance: 'earlier-run', started: 1 })}\n`);
    const own = ds.start(args(c1.dir));
    await waitFor('restart over an own-pid stale lock', async () => own.s.lines.some((l) => /\brestart\b/.test(l)) || own.s.lines.some((l) => l.startsWith('DAEMON_ALREADY_RUNNING')));
    assert.ok(!own.s.lines.some((l) => l.startsWith('DAEMON_ALREADY_RUNNING')), own.s.lines.join('\n'));
    own.s.stop();
    assert.equal(await own.done, 0, own.s.lines.join('\n'));

    // The same instance with another process start time (a reused pid) is stale too; the holder that matches both is not.
    const dir = join(f.root, 'lock-start');
    const first = await DaemonLock.acquire(realFs, dir, { pluginVersion: PLUGIN_VERSION, instance: 'same' });
    assert.ok(first instanceof DaemonLock);
    const file = join(dir, 'daemon.lock');
    const written = JSON.parse(await readFile(file, 'utf8')) as { started: number };
    assert.equal(typeof written.started, 'number', 'the lock records the process start');
    assert.ok(!((await DaemonLock.acquire(realFs, dir, { pluginVersion: PLUGIN_VERSION, instance: 'other' })) instanceof DaemonLock), 'a held lock refuses');
    await writeFile(file, `${JSON.stringify({ pid: process.pid, plugin_version: PLUGIN_VERSION, instance: 'same', started: written.started + 1 })}\n`);
    const again = await DaemonLock.acquire(realFs, dir, { pluginVersion: PLUGIN_VERSION, instance: 'other' });
    assert.ok(again instanceof DaemonLock, 'another start time: stale, replaced');
    await again.release();
    await first.release();

    // abandon(): the holding process died; the file stays, and the next acquire in this process takes the stale lock over.
    const dir2 = join(f.root, 'lock-abandon');
    const dying = await DaemonLock.acquire(realFs, dir2, { pluginVersion: PLUGIN_VERSION, instance: 'dying' });
    assert.ok(dying instanceof DaemonLock);
    dying.abandon();
    assert.match(await readFile(join(dir2, 'daemon.lock'), 'utf8'), /"instance":"dying"/, 'the abandoned file stays');
    const next = await DaemonLock.acquire(realFs, dir2, { pluginVersion: PLUGIN_VERSION, instance: 'next' });
    assert.ok(next instanceof DaemonLock, 'an abandoned lock is stale and taken over');
    await next.release();

    // A lock whose pid is not alive is replaced.
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    const deadPid = Number(dead.stdout);
    const lockFile = join(c2.dir, '.git', 'cowork', 'daemon.lock');
    await mkdir(join(c2.dir, '.git', 'cowork'), { recursive: true });
    await writeFile(lockFile, `${JSON.stringify({ pid: deadPid, plugin_version: PLUGIN_VERSION, instance: 'gone' })}\n`);
    const b = ds.start(args(c2.dir));
    await waitFor('join', async () => (await statusIn(c2.dir))?.state === 'ok');
    const lock = JSON.parse(await readFile(lockFile, 'utf8')) as { pid: number; plugin_version: string; instance: string };
    assert.deepEqual([lock.pid, lock.plugin_version], [process.pid, PLUGIN_VERSION]);
    assert.notEqual(lock.instance, 'gone');
    b.s.stop();
    assert.equal(await b.done, 0);
  } finally {
    await ds.stopAll();
    await f.cleanup();
  }
});

test('the daemon log queue is flushed before the command returns, and a failing daemon.lock release keeps the exit code', async () => {
  // fileLog.flush() resolves once every queued line has landed.
  const { root, cleanup } = await makeTempRoot('daemon-logflush');
  try {
    const file = join(root, 'q.jsonl');
    const log = fileLog(realFs, realClock, file);
    for (let i = 0; i < 20; i++) log.write('info', 'LINE', { i });
    await log.flush();
    assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 20, 'every queued line landed');
  } finally {
    await cleanup();
  }
  const f = await remoteWithClones('daemon-release', 1);
  try {
    const c = f.clones[0]!;
    const s = session();
    const run = runDaemon(args(c.dir), daemonEnv(), s.io);
    try {
      await waitFor('genesis', async () => (await statusIn(c.dir))?.state === 'ok');
      // daemon.lock replaced by a directory: the release at exit fails (EISDIR on reading it back).
      const lockFile = join(c.dir, '.git', 'cowork', 'daemon.lock');
      await rm(lockFile);
      await mkdir(lockFile);
    } finally {
      s.stopIfRunning();
      await run.catch(() => undefined);
    }
    assert.equal(await run, 0, `the command's exit code is kept: ${s.lines.join('\n')}`);
    assert.ok(s.lines.some((l) => l.startsWith('DAEMON_LOCK_RELEASE_FAILED')), s.lines.join('\n'));
    // The log's last lines landed before runDaemon returned: the drain and the release failure.
    const codes = (await readFile(join(c.dir, '.git', 'cowork', 'log', 'daemon-0.jsonl'), 'utf8')).trim().split('\n').map((l) => (JSON.parse(l) as { code: string }).code);
    assert.deepEqual(codes.slice(-2), ['DRAINED', 'DAEMON_LOCK_RELEASE_FAILED'], codes.join(','));
  } finally {
    await f.cleanup();
  }
});

test('remote resolution follows pushRemote, pushDefault, branch remote, --remote, the only remote; a fetch/push URL split refuses SEC_REFUSE_REMOTE_SPLIT and an insteadOf prefix SEC_REFUSE_URL_REWRITE, both with exit 1', async () => {
  const { root, cleanup } = await makeTempRoot('daemon-remote');
  try {
    const dir = join(root, 'r');
    await git(root, ['init', '-q', '-b', 'main', dir]);
    const paths = { workTree: dir, gitDir: join(dir, '.git'), coworkDir: join(dir, '.git', 'cowork') };
    const ctx = (): RepoContext => ({ attrTree: null, filterDrivers: [], identity: { name: 'T', email: 't@cowork.invalid' }, wallMs: () => 0 });
    const repo = new GitRepo(runner, paths, ctx);
    const name = async (explicit: string | null): Promise<string> => {
      const r = await resolveRemote(repo, 'main', explicit);
      assert.ok(!('refuse' in r), JSON.stringify(r));
      return r.name;
    };
    assert.deepEqual(await resolveRemote(repo, 'main', null), { refuse: 'START_REMOTE', params: { reason: 'no_remote' } });
    await git(dir, ['remote', 'add', 'solo', 'https://example.invalid/solo.git']);
    assert.deepEqual(await resolveRemote(repo, 'main', null), { name: 'solo', url: 'https://example.invalid/solo.git' }, 'the only remote');
    await git(dir, ['remote', 'add', 'other', 'https://example.invalid/other.git']);
    assert.deepEqual(await resolveRemote(repo, 'main', null), { refuse: 'START_REMOTE', params: { reason: 'no_remote' } }, 'origin is never assumed');
    assert.equal(await name('other'), 'other', '--remote');
    await git(dir, ['config', 'branch.main.remote', 'solo']);
    assert.equal(await name('other'), 'solo', 'branch.<b>.remote before --remote');
    await git(dir, ['config', 'remote.pushDefault', 'other']);
    assert.equal(await name(null), 'other', 'remote.pushDefault before branch.<b>.remote');
    await git(dir, ['config', 'branch.main.pushRemote', 'solo']);
    assert.equal(await name(null), 'solo', 'branch.<b>.pushRemote first');
    await git(dir, ['config', 'branch.main.pushRemote', 'nope']);
    assert.deepEqual(await resolveRemote(repo, 'main', null), { refuse: 'START_REMOTE', params: { reason: 'no_remote', remote: 'nope' } });
    await git(dir, ['config', '--unset', 'branch.main.pushRemote']);

    // Fetch URL ≠ push URL.
    await git(dir, ['config', 'remote.other.pushurl', 'https://example.invalid/elsewhere.git']);
    const split = await resolveRemote(repo, 'main', null);
    assert.ok('refuse' in split && split.refuse === 'SEC_REFUSE_REMOTE_SPLIT', JSON.stringify(split));
    const s1 = session();
    assert.equal(await runDaemon(args(dir), daemonEnv(), s1.io), 1);
    assert.ok(s1.lines.some((l) => l.startsWith('SEC_REFUSE_REMOTE_SPLIT')), s1.lines.join('\n'));
    await git(dir, ['config', '--unset', 'remote.other.pushurl']);

    // An insteadOf value that prefixes the configured URL (the rewritten fetch and push URLs agree).
    await git(dir, ['config', 'url.https://mirror.invalid/.insteadOf', 'https://example.invalid/']);
    const rewrite = await resolveRemote(repo, 'main', null);
    assert.ok('refuse' in rewrite && rewrite.refuse === 'SEC_REFUSE_URL_REWRITE', JSON.stringify(rewrite));
    // The refusal names the config key and the file that holds it.
    assert.deepEqual([rewrite.params['key'], rewrite.params['file']], ['url.https://mirror.invalid/.insteadof', join(dir, '.git', 'config')], JSON.stringify(rewrite));
    const s2 = session();
    assert.equal(await runDaemon(args(dir), daemonEnv(), s2.io), 1);
    assert.ok(s2.lines.some((l) => l.startsWith('SEC_REFUSE_URL_REWRITE')), s2.lines.join('\n'));
    assert.ok(s2.lines.some((l) => l.startsWith('next: ') && l.includes('url.https://mirror.invalid/.insteadof') && l.includes(join('.git', 'config'))), s2.lines.join('\n'));
    // pushInsteadOf rewrites the push URL only: a split.
    await git(dir, ['config', '--unset', 'url.https://mirror.invalid/.insteadOf']);
    await git(dir, ['config', 'url.https://mirror.invalid/.pushInsteadOf', 'https://example.invalid/']);
    const push = await resolveRemote(repo, 'main', null);
    assert.ok('refuse' in push && (push.refuse === 'SEC_REFUSE_REMOTE_SPLIT' || push.refuse === 'SEC_REFUSE_URL_REWRITE'), JSON.stringify(push));
  } finally {
    await cleanup();
  }
});

test('SEC_REFUSE_URL_REWRITE names the exact url.<base>.insteadOf key that exists, an scp-form base included, and its printed command removes that rule; a base with scheme userinfo is never printed', async () => {
  const { root, cleanup } = await makeTempRoot('daemon-rewrite-key');
  try {
    const dir = join(root, 'r');
    await git(root, ['init', '-q', '-b', 'main', dir]);
    await git(dir, ['remote', 'add', 'origin', 'https://example.invalid/repo.git']);
    const cfg = join(dir, '.git', 'config');
    const exists = async (key: string): Promise<boolean> => (await runner.run(['config', '--file', cfg, '--get-all', key], { class: 'local', cwd: dir })).code === 0;
    const refusalOf = (lines: readonly string[]): { params: Record<string, unknown>; next: string } => {
      const head = lines.find((l) => l.startsWith('SEC_REFUSE_URL_REWRITE '));
      const next = lines.find((l) => l.startsWith('next: '));
      assert.ok(head !== undefined && next !== undefined, lines.join('\n'));
      return { params: JSON.parse(head.slice('SEC_REFUSE_URL_REWRITE '.length)) as Record<string, unknown>, next };
    };

    // (1) An scp-form base (git@mirror.invalid:): the key is named exactly — its user part included, the one place a
    // printed line keeps an scp user — so the printed command, run by this OS's shell, removes the rule.
    await git(dir, ['config', 'url.git@mirror.invalid:.insteadOf', 'https://example.invalid/']);
    const s1 = session();
    assert.equal(await runDaemon(args(dir), daemonEnv(), s1.io), 1);
    const r1 = refusalOf(s1.lines);
    assert.deepEqual([r1.params['key'], r1.params['file'], r1.params['key_redacted']], ['url.git@mirror.invalid:.insteadof', cfg, false], JSON.stringify(r1.params));
    assert.equal(await exists('url.git@mirror.invalid:.insteadof'), true, 'the named key exists');
    const cmd = /(git config --file (?:"[^"]*"|'[^']*'|\S+) --unset-all (?:"[^"]*"|'[^']*'|\S+))/.exec(r1.next)?.[1];
    assert.ok(cmd !== undefined, r1.next);
    const run = shellRun(cmd, dir);
    assert.equal(run.status, 0, `${cmd}: ${run.stderr}`);
    assert.equal(await exists('url.git@mirror.invalid:.insteadof'), false, 'the printed command removed the rule');

    // (2) A base with scheme userinfo (a token): never printed, the key included; the command opens the file instead.
    await git(dir, ['config', 'url.https://tok3n@mirror.invalid/.insteadOf', 'https://example.invalid/']);
    const s2 = session();
    assert.equal(await runDaemon(args(dir), daemonEnv(), s2.io), 1);
    assert.ok(!s2.lines.some((l) => l.includes('tok3n')), s2.lines.join('\n'));
    const r2 = refusalOf(s2.lines);
    assert.deepEqual([r2.params['key'], r2.params['key_redacted']], ['url.https://mirror.invalid/.insteadof', true]);
    assert.ok(r2.next.includes(`git config --file ${shellQuote(cfg)!} --edit`), r2.next);
    assert.ok(!r2.next.includes('--unset-all'), r2.next);
  } finally {
    await cleanup();
  }
});

test('the resolved core.sshCommand reaches the runner', async () => {
  const f = await remoteWithClones('daemon-ssh', 1);
  const plain = await mkdtemp(join(tmpdir(), 'cowork-fakessh-'));
  try {
    const c = f.clones[0]!;
    const marker = join(plain, 'argv.json').replace(/\\/g, '/');
    const script = join(plain, 'fake-ssh.cjs').replace(/\\/g, '/');
    await writeFile(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(255);\n`);
    await git(c.dir, ['remote', 'set-url', 'origin', 'ssh://git@cowork.invalid/repo.git']);
    await git(c.dir, ['config', 'core.sshCommand', `"${process.execPath.replace(/\\/g, '/')}" "${script}"`]);
    const s = session();
    const code = await runDaemon(args(c.dir), daemonEnv({ GIT_SSH_VARIANT: 'ssh' }), s.io);
    assert.equal(code, 1, s.lines.join('\n'));
    assert.ok(s.lines.some((l) => l.startsWith('START_REMOTE')), s.lines.join('\n'));
    const argv = JSON.parse(await readFile(marker, 'utf8')) as string[];
    // The user's command ran, with the glossary §18 BatchMode options the runner appends only to a command it was given.
    assert.ok(argv.includes('BatchMode=yes'), JSON.stringify(argv));
    assert.ok(argv.some((x) => x.includes('cowork.invalid')), JSON.stringify(argv));
  } finally {
    await rm(plain, { recursive: true, force: true });
    await f.cleanup();
  }
});

test('recover without --confirm prints the preview id; resume clears meta.nonretryable while no daemon runs', async () => {
  await withEngines('daemon-recover', { n: 1 }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    await fx.rounds(2);
    await forceRemote(fx, p, p.core.refs.remoteBoard, null);
    await fx.rounds(1);
    assert.ok(p.core.view!.meta.freeze_reasons.includes('INCIDENT'));
    const dir = p.deps.paths.workTree;

    // While a daemon holds the lock (this fixture's), neither verb runs.
    const busy = session();
    assert.equal(await runDaemon(args(dir, { cmd: 'recover', name: null }), daemonEnv(), busy.io), 1);
    assert.ok(busy.lines.some((l) => l.startsWith('DAEMON_ALREADY_RUNNING')), busy.lines.join('\n'));
    const busy2 = session();
    assert.equal(await runDaemon(args(dir, { cmd: 'resume', name: null }), daemonEnv(), busy2.io), 1);

    await lockOf(p).release();
    const rec = session();
    assert.equal(await runDaemon(args(dir, { cmd: 'recover', name: null }), daemonEnv(), rec.io), 0, rec.lines.join('\n'));
    const idLine = rec.lines.find((l) => l.startsWith('RECOVER_PREVIEW'));
    assert.ok(idLine !== undefined, rec.lines.join('\n'));
    const id = /\bid=([0-9a-f]{6})\b/.exec(idLine)?.[1];
    assert.ok(id !== undefined, idLine);
    assert.ok(rec.lines.some((l) => l.includes(`--confirm=${id}`)), 'the next command names the preview id');
    await assert.rejects(stat(join(p.deps.paths.coworkDir, 'daemon.lock')), 'the recover process released the lock');

    // NONRETRYABLE: a host-reject PIN and meta.nonretryable; resume ends the PIN (05-holds: lifted by resume, the publish
    // is retried; final review FC-5) and clears the pause by one state CAS.
    const fresh = await Engine.create(p.deps);
    const view = fresh.core.view!;
    const holdId = await fresh.core.holds.hold({
      kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths: [], blobs: { h0: {}, h1: {} }, guard: 'host-reject', origin: 'daemon',
      cs_ids: [], displaced_by: null, local_only: false,
    });
    await fresh.core.commit({ meta: { ...view.meta, nonretryable: { lease: view.laB, hold_id: holdId }, rejections: { lease: view.laB, n: 3 } } });
    const res = session();
    assert.equal(await runDaemon(args(dir, { cmd: 'resume', name: null }), daemonEnv(), res.io), 0, res.lines.join('\n'));
    const after = await fresh.core.state.read();
    assert.deepEqual([after!.meta.nonretryable, after!.meta.rejections], [null, null]);
    // R-27: the board's `event{kind: nonretryable}` is queued once the pause lifts, in the same state update.
    const queued = JSON.stringify(after!.meta.outbox);
    assert.equal(queued.split('"nonretryable"').length - 1, 1, queued);
    await fresh.core.holds.load();
    assert.equal(fresh.core.holds.get(holdId)?.state, 'RESOLVED_PUBLISH', 'the (pathless) host-reject PIN ended');
    // Nothing left to resume: exit 0, nothing written.
    const again = session();
    assert.equal(await runDaemon(args(dir, { cmd: 'resume', name: null }), daemonEnv(), again.io), 0);
    assert.equal((await fresh.core.state.read())!.commit, after!.commit);
  });
});

test('restart refusals map to a refused status and exit 1, never a crash', async () => {
  const f = await remoteWithClones('daemon-refused', 1);
  const ds = daemons();
  try {
    const c = f.clones[0]!;
    const a = ds.start(args(c.dir));
    await waitFor('genesis', async () => (await statusIn(c.dir))?.state === 'ok');
    a.s.stop();
    assert.equal(await a.done, 0);
    // A broken state ref (lost state) with a detached HEAD: the lost-state rebuild refuses START_HEAD_STATE{op: detached}.
    const stateRef = (await git(c.dir, ['for-each-ref', '--format=%(refname)', 'refs/cowork-local/'])).split('\n').find((r) => r.endsWith('/state'))!;
    await git(c.dir, ['checkout', '-q', '--detach']);
    await writeFile(join(c.dir, '.git', ...stateRef.split('/')), 'not an oid\n');
    const r = ds.start(args(c.dir));
    assert.equal(await r.done, 1, r.s.lines.join('\n'));
    assert.ok(r.s.lines.some((l) => l.startsWith('START_HEAD_STATE')), r.s.lines.join('\n'));
    const s = await statusIn(c.dir);
    assert.deepEqual([s?.state, s?.message_code, s?.message_params], ['refused', 'START_HEAD_STATE', { op: 'detached' }]);
  } finally {
    await ds.stopAll();
    await f.cleanup();
  }
});

test('the line filter keeps only exact whole words without scheme userinfo; userinfoKind tells an scp user name from a secret', () => {
  assert.deepEqual(['https://example.invalid/', 'git@host:o/r', 'https://tok@host/', 'ssh://git@host/r', 'a:pw@host:r', 'C:/x@y'].map(userinfoKind),
    ['none', 'scp_user', 'secret', 'secret', 'secret', 'secret']);
  const key = 'url.git@mirror.invalid:.insteadof';
  // Without keep, the scp user goes (over-redaction is accepted); kept as a whole word, in a shell word or a JSON string.
  assert.equal(sanitizeText(`unset ${key}`), 'unset mirror.invalid:.insteadof');
  assert.equal(sanitizeText(`unset ${key}, then`, [key]), `unset ${key}, then`);
  assert.equal(sanitizeText(`{"key":"${key}","url":"https://a:b@h/r"}`, [key]), `{"key":"${key}","url":"https://h/r"}`);
  assert.equal(sanitizeText(`"${key}" git@other:x`, [key]), `"${key}" other:x`, 'only the kept word survives');
  // Inside a larger word it is not that word: redacted as usual.
  assert.equal(sanitizeText(`x${key}`, [key]), 'mirror.invalid:.insteadof');
  // An entry holding scheme userinfo is never kept.
  assert.equal(sanitizeText('rule url.https://tok@h/.insteadof here', ['url.https://tok@h/.insteadof']), 'rule url.https://h/.insteadof here');
});

test('no printed line contains URL userinfo', async () => {
  assert.equal(sanitizeUrl('https://alice:s3cret@example.invalid/r.git'), 'https://example.invalid/r.git');
  assert.equal(sanitizeUrl('ssh://git@example.invalid:22/r.git'), 'ssh://example.invalid:22/r.git');
  assert.equal(sanitizeUrl('git@github.com:o/r.git'), 'github.com:o/r.git');
  assert.equal(sanitizeUrl('https://example.invalid/r.git'), 'https://example.invalid/r.git');
  assert.equal(sanitizeUrl('file:///C:/x/y.git'), 'file:///C:/x/y.git');
  assert.equal(sanitizeUrl('alice@example.invalid:o/r.git'), 'example.invalid:o/r.git');
  const f = await remoteWithClones('daemon-userinfo', 1);
  try {
    const c = f.clones[0]!;
    // (1) An unreachable remote with userinfo: the refusal names the remote's URL (so a leak would show), without the
    // userinfo; neither the daemon log nor status.json carries it.
    await git(c.dir, ['remote', 'set-url', 'origin', 'https://alice:s3cret@127.0.0.1:9/repo.git']);
    const s = session();
    assert.equal(await runDaemon(args(c.dir), daemonEnv(), s.io), 1, s.lines.join('\n'));
    assert.ok(s.lines.some((l) => l.includes('https://127.0.0.1:9/repo.git')), `the refusal names the remote: ${s.lines.join('\n')}`);
    for (const l of s.lines) assert.ok(!/s3cret|alice/.test(l), `printed: ${l}`);
    const coworkDir = join(c.dir, '.git', 'cowork');
    for (const file of [join(coworkDir, 'log', 'daemon-0.jsonl'), join(coworkDir, 'status.json')]) {
      const text = await readFile(file, 'utf8');
      assert.ok(!/s3cret|alice/.test(text), `${file}: ${text}`);
    }
    // (2) A refusal whose params name both URLs (a split; the push URL in scp form with a user) prints both without it.
    await git(c.dir, ['config', 'remote.origin.pushurl', 'bob@127.0.0.1:other.git']);
    const s2 = session();
    assert.equal(await runDaemon(args(c.dir), daemonEnv(), s2.io), 1);
    assert.ok(s2.lines.some((l) => l.includes('https://127.0.0.1:9/repo.git') && l.includes('127.0.0.1:other.git')), s2.lines.join('\n'));
    for (const l of s2.lines) assert.ok(!/s3cret|alice|bob@/.test(l), `printed: ${l}`);
    // (3) The line filter covers every printed line, whatever produced it: here the --repo word of a refusal's next
    // command, holding a URL of each form.
    const bogus = `${f.root}${sep}missing https://carol:pw1@example.invalid/r.git dave@example.invalid:o/r.git`;
    const s3 = session();
    assert.equal(await runDaemon(args(bogus), daemonEnv(), s3.io), 1);
    assert.ok(s3.lines.some((l) => l.startsWith('next: ') && l.includes('https://example.invalid/r.git') && l.includes(' example.invalid:o/r.git')), s3.lines.join('\n'));
    for (const l of s3.lines) assert.ok(!/pw1|carol|dave@/.test(l), `printed: ${l}`);
  } finally {
    await f.cleanup();
  }
});

test('meta.pinned.url never carries userinfo: genesis, join and a lost-state rebuild pin the URL without it while git still reaches the remote through it', async () => {
  const secret = 'https://alice:s3cret@cowork.invalid/repo.git';
  await withEngines('daemon-pin-userinfo', { n: 2, url: () => secret }, async (fx) => {
    // git reaches the file:// remote through the URL with userinfo (a rewrite in each test clone's own config).
    for (const p of fx.peers) await gitIn(p, ['config', `url.${fx.remote.url}.insteadOf`, secret]);
    await fx.startAll();
    await fx.rounds(2);
    for (const p of fx.peers) assert.equal(p.core.view!.meta.pinned.url, 'https://cowork.invalid/repo.git', `${p.name}: pinned`);
    // A lost state on peer 2: the rebuild pins the URL without userinfo too.
    const p = fx.peers[1]!;
    await writeFile(join(p.deps.paths.gitDir, ...p.core.refs.state.split('/')), 'garbage\n');
    const fresh = await Engine.create(p.deps);
    const r = await fresh.start({ publishLocal: null });
    assert.ok(r.ok && r.restart?.lostState !== null && r.restart?.lostState !== undefined, JSON.stringify(r));
    assert.equal(fresh.core.view!.meta.pinned.url, 'https://cowork.invalid/repo.git', 'rebuilt: pinned');
    for (const q of fx.peers) {
      const text = `${JSON.stringify(logOf(q).lines)}${await readFile(join(q.deps.paths.coworkDir, 'status.json'), 'utf8')}`;
      assert.ok(!/s3cret|alice/.test(text), `${q.name}: log and status`);
    }
  });
});

test('final review FC minors: daemon.lock — a lock that names no holder and was written moments ago is a concurrent creator\'s (refused, left alone), an old one is a crash leftover (replaced); a live pid whose recorded start lies ahead of this boot\'s monotonic clock is a holder from before a reboot (replaced)', async () => {
  const { root, cleanup } = await makeTempRoot('daemon-lock-minors');
  try {
    // (1) A concurrent creator between its exclusive create and its one write: the file is empty.
    const dir = join(root, 'young');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'daemon.lock');
    await writeFile(file, '');
    const young = await DaemonLock.acquire(realFs, dir, { pluginVersion: PLUGIN_VERSION, instance: 'second' });
    assert.ok(!(young instanceof DaemonLock), 'a young lock that names no holder is refused, never stolen');
    assert.deepEqual(young, { held: null });
    assert.equal(await readFile(file, 'utf8'), '', 'and left alone');
    // The same bytes two minutes old: a crash inside the write, replaced.
    const old = new Date(Date.now() - 120_000);
    await utimes(file, old, old);
    const taken = await DaemonLock.acquire(realFs, dir, { pluginVersion: PLUGIN_VERSION, instance: 'third' });
    assert.ok(taken instanceof DaemonLock, 'an old lock that names no holder is replaced');
    await taken.release();
    assert.deepEqual(readdirSync(dir), [], 'no probe file is left behind');

    // (2) A reboot: the recorded holder started later on the machine-wide monotonic clock than this boot has run, so it
    // started before the reboot, whatever process now has its pid.
    const dir2 = join(root, 'reboot');
    await mkdir(dir2, { recursive: true });
    const file2 = join(dir2, 'daemon.lock');
    const alive = (): boolean => true;   // the pid now names another, live process
    await writeFile(file2, `${JSON.stringify({ pid: 4242, plugin_version: PLUGIN_VERSION, instance: 'before-reboot', started: machineMonoMs() + 3_600_000 })}\n`);
    const after = await DaemonLock.acquire(realFs, dir2, { pluginVersion: PLUGIN_VERSION, instance: 'after-reboot' }, alive);
    assert.ok(after instanceof DaemonLock, 'a holder from before the reboot is stale even with its pid alive');
    await after.release();
    // A live holder of this boot still refuses.
    await writeFile(file2, `${JSON.stringify({ pid: 4242, plugin_version: PLUGIN_VERSION, instance: 'this-boot', started: Math.max(0, machineMonoMs() - 1_000) })}\n`);
    const held = await DaemonLock.acquire(realFs, dir2, { pluginVersion: PLUGIN_VERSION, instance: 'another' }, alive);
    assert.ok(!(held instanceof DaemonLock) && held.held?.instance === 'this-boot', 'a live holder of this boot refuses');
  } finally {
    await cleanup();
  }
});

test('final review FC minors: an invalid --branch is a usage error (exit 2 with the usage, never DAEMON_INTERNAL_ERROR); an over-long one refuses START_BRANCH_NAME{reason: too_long} with exit 1 and its own next step', async () => {
  for (const b of ['a..b', 'x~1', '-lead', 'ends/', 'a b', 'topic.lock']) {
    const r = parseDaemonArgs(['run', '--repo', 'r', '--branch', b]);
    assert.ok('usage' in r && r.exitCode === 2 && r.usage.startsWith('--branch'), `${b}: ${JSON.stringify(r)}`);
  }
  assert.ok(!('usage' in parseDaemonArgs(['run', '--repo', 'r', '--branch', 'b'.repeat(151)])), 'too long is no usage error: the start refuses it');
  const f = await remoteWithClones('daemon-branch-name', 1);
  try {
    const s = session();
    assert.equal(await runDaemon(args(f.clones[0]!.dir, { branch: 'b'.repeat(151) }), daemonEnv(), s.io), 1, s.lines.join('\n'));
    assert.ok(s.lines.some((l) => l === 'START_BRANCH_NAME {"reason":"too_long","other":null}'), s.lines.join('\n'));
    assert.ok(s.lines.some((l) => l.startsWith('next: use a different branch name')), s.lines.join('\n'));
  } finally {
    await f.cleanup();
  }
});

test('final review FC minor: every start refusal prints a next step of its own (08-lifecycle Table 2.7-A), never the generic one, and the remote URL without userinfo', () => {
  const a = args('/repos/a', { branch: 'main' });
  const url = 'https://alice:s3cret@example.invalid/r.git';
  const cases: Array<[string, Record<string, Json>, RegExp]> = [
    ['START_REMOTE', { reason: 'unreachable' }, /check the network/],
    ['START_REMOTE', { reason: 'local_ref_update' }, /refs\/cowork-remote/],
    ['START_REMOTE', { reason: 'board_malformed' }, /recover/],
    ['START_REMOTE', { reason: 'genesis_push_failed' }, /push/],
    ['START_BRANCH_NOT_ON_REMOTE', { remote: 'origin', branch: 'main' }, /git push -u origin main/],
    ['GENESIS_BOARD_MISSING', { branch: 'main' }, /recover --repo <their clone> --branch main/],
    ['START_VERSION', {}, /update cowork-sync/],
    ['START_STATE_NEWER', { meta_v: 2, own_v: 1 }, /update cowork-sync/],
    ['START_REPO_IDENTITY', {}, /different repository/],
    ['START_REFUSED_CUSTOM_REFS', {}, /fallbackNamespace/],
    ['START_REFUSED_NO_LEASE', {}, /force-with-lease/],
    ['START_BRANCH_NAME', { reason: 'case_fold', other: 'Main' }, /different branch name/],
    ['START_BRANCH_NAME', { reason: 'too_long', other: null }, /different branch name/],
  ];
  for (const [code, params, re] of cases) {
    const t = startRefusalNext(code, params, a, url);
    assert.ok(!t.startsWith('fix the condition above'), `${code} ${JSON.stringify(params)}: ${t}`);
    assert.match(t, re, `${code} ${JSON.stringify(params)}: ${t}`);
    assert.ok(!t.includes('s3cret') && !t.includes('alice'), t);
  }
  assert.ok(!startRefusalNext('START_REMOTE', { reason: 'local_ref_update' }, a, url).includes('check the network'), 'a local failure is no network advice');
  // A remote the engine could not name prints a placeholder, never an empty word.
  assert.match(startRefusalNext('START_BRANCH_NOT_ON_REMOTE', { remote: null, branch: 'main' }, a, url), /git push -u <remote> main/);
});

test('final review FC minor: a stop during the respawn sleep writes status down before the daemon exits 0', async () => {
  const f = await remoteWithClones('daemon-respawn-stop', 1);
  const ds = daemons();
  try {
    const c = f.clones[0]!;
    const a = ds.start(args(c.dir));
    await waitFor('genesis', async () => (await statusIn(c.dir))?.state === 'ok');
    a.s.stop();
    assert.equal(await a.done, 0);
    // Every start now crashes with a local error (no refusal): the rename probe's temp name is a directory.
    await mkdir(join(c.dir, '.git', 'cowork', 'tmp', 'rename-probe.a'), { recursive: true });
    // The status a daemon that died while running left behind.
    const statusFile = join(c.dir, '.git', 'cowork', 'status.json');
    const before = JSON.parse(await readFile(statusFile, 'utf8')) as StatusJson;
    await writeFile(statusFile, JSON.stringify({ ...before, state: 'ok', message_code: null }));
    const b = ds.start(args(c.dir));
    await waitFor('the first respawn', async () => b.s.lines.some((l) => l.startsWith('DAEMON_RESPAWN')), 30_000);
    b.s.stop();
    assert.equal(await b.done, 0, b.s.lines.join('\n'));
    const s = await statusIn(c.dir);
    assert.equal(s?.state, 'down', JSON.stringify(s));
  } finally {
    await ds.stopAll();
    await f.cleanup();
  }
});
