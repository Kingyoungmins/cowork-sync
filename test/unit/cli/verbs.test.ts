// cli.js verbs (v0.1.0-preview) over a fake environment: output modes and exit codes, the command prefix, the daemon lines
// relayed with this CLI's commands, and start's outcomes. start → status → stop on a real clone is test/integration/cli.verbs.test.ts.
import { resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DaemonLaunch, LaunchOutcome } from '../../../src/cli/launch.js';
import { commandPrefix, relayDaemonLine, runCowork, type CoworkEnv } from '../../../src/cli/verbs.js';
import type { GitResult, GitRunner } from '../../../src/git/runner.js';
import type { Fs } from '../../../src/ports/fs.js';
import { realClock } from '../../../src/ports/clock.js';

const ROOT = '/plug';
/** The clone's top folder as findClone resolves it on this OS. */
const TOP = resolve('/repo');

function gitResult(code: number, stdout = ''): GitResult {
  return { code, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), killedByWatchdog: false, aborted: false, durationMs: 1 };
}

interface Fake { env: CoworkEnv; out: string[]; err: string[]; launches: DaemonLaunch[]; }
function fake(o: { slash?: boolean; repo?: boolean; remotes?: string; branch?: string | null; outcome?: LaunchOutcome; files?: Record<string, string> } = {}): Fake {
  const out: string[] = [];
  const err: string[] = [];
  const launches: DaemonLaunch[] = [];
  const git: GitRunner = {
    run: async (args) => {
      const a = args.join(' ');
      if (a === 'rev-parse --show-toplevel') return o.repo === false ? gitResult(128) : gitResult(0, `${TOP}\n`);
      if (a === 'remote') return gitResult(0, o.remotes ?? 'origin\n');
      if (a === 'symbolic-ref --quiet --short HEAD') return o.branch === null ? gitResult(1) : gitResult(0, `${o.branch ?? 'main'}\n`);
      return gitResult(128);
    },
  };
  const files = o.files ?? {};
  const fs = {
    readFile: async (p: string) => {
      const hit = Object.entries(files).find(([k]) => p.replace(/\\/g, '/').endsWith(k));
      if (hit === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return Buffer.from(hit[1]);
    },
  } as unknown as Fs;
  const env: CoworkEnv = {
    pluginRoot: ROOT, cwd: TOP, env: o.slash === true ? { CLAUDECODE: '1' } : {}, platform: 'linux', isTTY: false, execPath: '/node',
    out: (s) => out.push(s), err: (s) => err.push(s), fs, clock: realClock, git,
    launchDaemon: async (l) => {
      launches.push(l);
      return o.outcome ?? { kind: 'started', mode: 'genesis', lines: ['started genesis on main as peer ab'] };
    },
    alive: () => true, machineMono: () => 1_000, startTimeoutMs: 90_000, stopTimeoutMs: 1_000, stopPollMs: 10,
  };
  return { env, out, err, launches };
}

test('commandPrefix: /cowork-sync:cowork in a slash command, else node with the absolute cli.js quoted for the terminal', () => {
  assert.equal(commandPrefix(true, '/p', 'linux'), '/cowork-sync:cowork');
  assert.equal(commandPrefix(false, '/home/a b/p', 'linux'), 'node "/home/a b/p/dist/cli.js"');
  assert.equal(commandPrefix(false, 'C:\\Users\\a\\p\\', 'win32'), 'node "C:\\Users\\a\\p\\dist\\cli.js"');
});

test('relayDaemonLine: the daemon\'s own run command becomes `start`, other daemon commands get its absolute path', () => {
  const daemon = 'node "/plug/dist/daemon.js"';
  const preview = 'next: node dist/daemon.js run --repo /repo --branch main --publish=all to share the local work, or node dist/daemon.js run --repo /repo --branch main --publish=none to hold it';
  assert.equal(relayDaemonLine(preview, '/cowork', null, daemon),
    'next: /cowork start --publish=all to share the local work, or /cowork start --publish=none to hold it');
  assert.equal(relayDaemonLine("next: git pull --ff-only, then: node dist/daemon.js run --repo '/a b' --branch 'x y'", '/cowork', "'x y'", daemon),
    "next: git pull --ff-only, then: /cowork start --branch 'x y'");
  assert.equal(relayDaemonLine('next: node dist/daemon.js recover --repo <their clone> --branch main; then: node dist/daemon.js run --repo "C:\\r" --branch main', '/cowork', null, daemon),
    'next: node "/plug/dist/daemon.js" recover --repo <their clone> --branch main; then: /cowork start');
  assert.equal(relayDaemonLine('A\u001b[31mB\u202eC', '/cowork', null, daemon), 'A[31mBC', 'control and format characters are dropped');
});

test('help: bare cli.js prints it on stderr and nothing on stdout (nothing at all in pipe mode); `help` prints it on stdout', async () => {
  const piped = fake();
  assert.equal(await runCowork([], piped.env), 0);
  assert.deepEqual([piped.out, piped.err], [[], []], 'pipe mode: the Plan 1 no-op');
  const bare = fake();
  bare.env.isTTY = true;
  assert.equal(await runCowork([], bare.env), 0);
  assert.deepEqual(bare.out, []);
  assert.match(bare.err.join('\n'), /node "\/plug\/dist\/cli\.js" start \[--branch <b>\]/);
  const bareSlash = fake({ slash: true });
  assert.equal(await runCowork([], bareSlash.env), 0);
  assert.deepEqual(bareSlash.out, [], 'bare cli.js keeps stdout empty in a slash command too');
  assert.match(bareSlash.err.join('\n'), /\/cowork-sync:cowork start/);
  const help = fake({ slash: true });
  assert.equal(await runCowork(['help'], help.env), 0);
  assert.match(help.out.join('\n'), /cowork-sync 0\.1\.0-preview: .*\n {2}\/cowork-sync:cowork start/);
});

test('usage errors: exit 2 on stderr in a terminal; exit 0 on stdout in a slash command', async () => {
  const t = fake();
  assert.equal(await runCowork(['start', '--publish=maybe'], t.env), 2);
  assert.deepEqual(t.out, []);
  assert.equal(t.err.join('\n'), 'cowork-sync: --publish is all or none [RF_COWORK_USAGE]\nnext: node "/plug/dist/cli.js" help');
  const s = fake({ slash: true });
  assert.equal(await runCowork(['frobnicate'], s.env), 0);
  assert.deepEqual(s.err, []);
  assert.equal(s.out.join('\n'), 'cowork-sync: unknown command "frobnicate" [RF_COWORK_USAGE]\nnext: /cowork-sync:cowork help');
});

test('outside a work tree, without a remote, or with HEAD off a branch: refused before anything starts', async () => {
  const outside = fake({ repo: false });
  assert.equal(await runCowork(['status'], outside.env), 1);
  assert.match(outside.err.join('\n'), /not inside a git work tree \[RF_COWORK_NOT_A_REPO\]\nnext: .* status$/);
  const noRemote = fake({ remotes: '' });
  assert.equal(await runCowork(['start'], noRemote.env), 1);
  assert.match(noRemote.err.join('\n'), /\[RF_COWORK_NO_REMOTE\]/);
  const detached = fake({ branch: null });
  assert.equal(await runCowork(['start'], detached.env), 1);
  assert.match(detached.err.join('\n'), /\[RF_COWORK_NO_BRANCH\]/);
  assert.deepEqual([...outside.launches, ...noRemote.launches, ...detached.launches], []);
});

test('start: launches dist/daemon.js run in the clone\'s top folder and reports each outcome', async () => {
  const ok = fake();
  assert.equal(await runCowork(['start', '--publish=all', '--name', 'Ann'], ok.env), 0);
  assert.equal(ok.launches.length, 1);
  const l = ok.launches[0]!;
  assert.deepEqual([l.execPath, l.daemonJs, l.cwd, l.timeoutMs], ['/node', '/plug/dist/daemon.js', TOP, 90_000]);
  assert.deepEqual(l.argv, ['run', '--repo', TOP, '--branch', 'main', '--publish=all', '--name', 'Ann']);
  assert.equal(ok.out.join('\n'), 'cowork-sync: sync started on main (genesis); the daemon keeps running in the background.\nnext: node "/plug/dist/cli.js" status');

  const refused = fake({ outcome: { kind: 'exited', code: 1, lines: ['START_HEAD_BEHIND {}', 'next: git pull --ff-only, then: node dist/daemon.js run --repo /repo --branch dev'] } });
  assert.equal(await runCowork(['start', '--branch', 'dev'], refused.env), 1);
  assert.deepEqual(refused.err, [
    'cowork-sync: the daemon did not start; it said:', 'START_HEAD_BEHIND {}', 'next: git pull --ff-only, then: node "/plug/dist/cli.js" start --branch "dev"',
  ]);

  const crashed = fake({ outcome: { kind: 'exited', code: 2, lines: [] } });
  assert.equal(await runCowork(['start'], crashed.env), 1);
  assert.match(crashed.err.join('\n'), /exited with code 2 and printed nothing\) \[RF_COWORK_START_FAILED\]/);

  const slow = fake({ outcome: { kind: 'timeout', lines: [] } });
  assert.equal(await runCowork(['start'], slow.env), 0);
  assert.match(slow.out.join('\n'), /has not reported its start after 90 s/);

  const noNode = fake({ outcome: { kind: 'spawn_failed', why: 'spawn ENOENT' } });
  assert.equal(await runCowork(['start'], noNode.env), 1);
  assert.match(noNode.err.join('\n'), /\(spawn ENOENT\) \[RF_COWORK_START_FAILED\]/);
});

test('start with a live daemon already holding the lock reports it and launches nothing', async () => {
  const lock = JSON.stringify({ pid: 4242, plugin_version: '0.1.0-preview', instance: 'f'.repeat(32), started: 10 });
  const f = fake({ files: { '/repo/.git/cowork/daemon.lock': lock } });
  assert.equal(await runCowork(['start'], f.env), 0);
  assert.deepEqual(f.launches, []);
  assert.equal(f.out[0], 'cowork-sync: sync already runs in this clone.');
});
