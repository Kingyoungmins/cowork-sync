import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { selfExitPrologue } from '../helpers/selfExit.js';
import { makeTempRoot, testRunner } from '../helpers/tmp.js';
import { createGitRunner } from '../../src/git/runner.js';
import { buildDaemonEnv } from '../../src/git/env.js';
import { realClock, type Clock } from '../../src/ports/clock.js';
import { realRandom } from '../../src/ports/random.js';
import { realScheduler } from '../../src/ports/scheduler.js';
import { realFs } from '../../src/ports/fs.js';
import type { Ports } from '../../src/ports/index.js';

const ID = { name: 'Test Peer', email: 'peer@cowork.invalid' };
const SSH_BATCH = '-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3';

/** process.env without any GIT_SSH* variable, so a developer's or CI's ssh settings cannot outrank the case under test. */
function envWithoutSsh(): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('GIT_SSH')));
}

/** Single-quote a path for a sh command line; forward slashes work on every OS. */
function shq(p: string): string {
  return `'${p.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`;
}

function pause(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function initRepo(root: string, name: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  const r = await testRunner().run(['init', '-q', '-b', 'main', dir], { class: 'local', cwd: root });
  assert.equal(r.code, 0, r.stderr.toString('utf8'));
  return dir;
}

test('makeTempRoot gives a path with a space and Hangul, and cleanup removes it', async () => {
  const { root, cleanup } = await makeTempRoot('tmp-shape');
  assert.ok(root.includes('공 백 dir'), root);
  assert.ok(existsSync(root));
  await cleanup();
  assert.equal(existsSync(root), false);
});

test('runGit works in a repo under a spaced, non-ASCII path (Review Focus 1)', async () => {
  const { root, cleanup } = await makeTempRoot('runner-path');
  try {
    const repo = await initRepo(root, '저장소 one');
    const r = await testRunner().run(['rev-parse', '--show-toplevel'], { class: 'local', cwd: repo });
    assert.equal(r.code, 0, r.stderr.toString('utf8'));
    assert.equal(r.killedByWatchdog, false);
    assert.equal(resolve(r.stdout.toString('utf8').trim()), resolve(repo));
  } finally {
    await cleanup();
  }
});

test('stdin is piped when given and stdout is returned as bytes', async () => {
  const { root, cleanup } = await makeTempRoot('runner-stdin');
  try {
    const repo = await initRepo(root, 'r');
    const r = await testRunner().run(['hash-object', '--stdin'], { class: 'local', cwd: repo, stdin: Buffer.from('hello\n') });
    assert.equal(r.code, 0, r.stderr.toString('utf8'));
    assert.ok(Buffer.isBuffer(r.stdout));
    assert.equal(r.stdout.toString('utf8').trim(), 'ce013625030ba8dba906f756967f9e9ca394464a');
  } finally {
    await cleanup();
  }
});

test('a failing command returns its exit code and English stderr even with LANG=ko_KR.UTF-8', async () => {
  const { root, cleanup } = await makeTempRoot('runner-fail');
  try {
    const repo = await initRepo(root, 'r');
    const git = createGitRunner({
      clock: realClock,
      hooksPath: join(root, 'empty-hooks'),
      daemonEnv: buildDaemonEnv({ ...process.env, LANG: 'ko_KR.UTF-8', LC_MESSAGES: 'ko_KR.UTF-8' }, []),
      testBuild: true,
    });
    const r = await git.run(['rev-parse', '--verify', 'refs/heads/does-not-exist'], { class: 'local', cwd: repo });
    assert.notEqual(r.code, 0);
    assert.equal(r.killedByWatchdog, false);
    assert.match(r.stderr.toString('utf8'), /fatal: Needed a single revision/);
  } finally {
    await cleanup();
  }
});

test('durationMs is measured with the injected clock', async () => {
  const { root, cleanup } = await makeTempRoot('runner-clock');
  try {
    let t = 0;
    const clock: Clock = { monoMs: () => (t += 1000), wallMs: () => 0, sleep: async () => {} };
    const r = await testRunner(clock).run(['version'], { class: 'local', cwd: root });
    assert.equal(r.code, 0);
    assert.equal(r.durationMs, 1000);
  } finally {
    await cleanup();
  }
});

test('a missing git binary resolves with code -1 and the reason in stderr', async () => {
  const { root, cleanup } = await makeTempRoot('runner-nogit');
  try {
    const git = createGitRunner({
      clock: realClock,
      hooksPath: join(root, 'empty-hooks'),
      daemonEnv: buildDaemonEnv(process.env, []),
      gitPath: join(root, 'no-such-git'),
      testBuild: true,
    });
    const r = await git.run(['version'], { class: 'local', cwd: root });
    assert.equal(r.code, -1);
    assert.equal(r.killedByWatchdog, false);
    assert.match(r.stderr.toString('utf8'), /spawn failed/);
  } finally {
    await cleanup();
  }
});

test('user config core.hooksPath and commit.gpgSign=true break plain git but not runGit (Review Focus 4)', async () => {
  const { root, cleanup } = await makeTempRoot('runner-userconfig');
  try {
    const repo = await initRepo(root, 'r'); // repo = <root>/r
    const userHooks = join(root, 'user hooks');
    await mkdir(userHooks, { recursive: true });
    // githooks(5): pre-commit runs with the work-tree root as cwd, so ../hook-ran.txt is <root>/hook-ran.txt.
    // A relative path keeps the spaced, Hangul temp root out of the sh source. LF-only buffer (Review Focus 3).
    const marker = join(root, 'hook-ran.txt');
    await writeFile(join(userHooks, 'pre-commit'), Buffer.from('#!/bin/sh\necho ran > ../hook-ran.txt\nexit 1\n', 'utf8'), { mode: 0o755 });

    const git = testRunner();
    for (const [k, v] of [
      ['core.hooksPath', userHooks.replace(/\\/g, '/')],
      ['commit.gpgSign', 'true'],
      ['gpg.format', 'openpgp'],
      ['gpg.program', join(root, 'no-such-gpg.exe').replace(/\\/g, '/')],
    ] as const) {
      const c = await git.run(['config', k, v], { class: 'local', cwd: repo });
      assert.equal(c.code, 0, c.stderr.toString('utf8'));
    }
    await writeFile(join(repo, 'a.txt'), Buffer.from('a\n'));
    const add = await git.run(['add', 'a.txt'], { class: 'local', cwd: repo });
    assert.equal(add.code, 0, add.stderr.toString('utf8'));

    const headIsUnborn = async (): Promise<boolean> =>
      (await git.run(['rev-parse', '--verify', '-q', 'HEAD'], { class: 'local', cwd: repo })).code !== 0;
    // Plain git: no cowork -c flags at all; identity through the environment only.
    const plainEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: ID.name, GIT_AUTHOR_EMAIL: ID.email,
      GIT_COMMITTER_NAME: ID.name, GIT_COMMITTER_EMAIL: ID.email,
    };

    // Control 1: the user's hook really runs on this OS and really rejects the commit.
    assert.equal(existsSync(marker), false);
    const control = spawnSync('git', ['commit', '-q', '-m', 'control'], { cwd: repo, env: plainEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(control.error, undefined, String(control.error));
    assert.notEqual(control.status, 0, 'control commit must be rejected by the user pre-commit hook');
    assert.ok(existsSync(marker), `the user hook did not run under plain git: ${control.stderr.toString('utf8')}`);
    assert.ok(await headIsUnborn(), 'the control commit must not have been created');
    await unlink(marker);

    // Control 2: with the hook skipped, commit.gpgSign=true and the missing gpg program really fail a plain commit.
    const control2 = spawnSync('git', ['commit', '--no-verify', '-q', '-m', 'control'], { cwd: repo, env: plainEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.notEqual(control2.status, 0, 'commit.gpgSign=true with a missing gpg must fail a plain commit');
    assert.equal(existsSync(marker), false);
    assert.ok(await headIsUnborn());

    // runGit: cowork's -c core.hooksPath and -c commit.gpgSign=false win over the repository config.
    const commit = await git.run(['commit', '-q', '-m', 'first'], { class: 'local', cwd: repo, identity: ID, wallMsForDates: 1_700_000_000_000 });
    assert.equal(commit.code, 0, commit.stderr.toString('utf8'));
    assert.equal(existsSync(marker), false, 'the user hook must not run under runGit');
    const body = await git.run(['cat-file', 'commit', 'HEAD'], { class: 'local', cwd: repo });
    assert.equal(body.code, 0, body.stderr.toString('utf8'));
    assert.doesNotMatch(body.stdout.toString('utf8'), /gpgsig/);
    assert.match(body.stdout.toString('utf8'), /^author Test Peer <peer@cowork\.invalid> 1700000000 \+0000$/m);
  } finally {
    await cleanup();
  }
});

test('GitRunnerDeps.sshCommand reaches network-class git calls with the 09-security §2 precedence', async () => {
  const { root, cleanup } = await makeTempRoot('runner-ssh');
  try {
    const repo = await initRepo(root, 'r');
    const dump = join(root, 'ssh dump.cjs');
    await writeFile(dump, Buffer.from(`process.stdout.write(process.env.GIT_SSH_COMMAND ?? '<unset>');\n`, 'utf8'));
    const set = await testRunner().run(['config', 'alias.sshdump', `!node ${shq(dump)}`], { class: 'local', cwd: repo });
    assert.equal(set.code, 0, set.stderr.toString('utf8'));

    const noSsh = envWithoutSsh();
    const dumpWith = async (daemonEnv: Record<string, string>, cls: 'network' | 'local', sshCommand?: string): Promise<string> => {
      const git = createGitRunner({
        clock: realClock,
        hooksPath: join(root, 'empty-hooks'),
        daemonEnv,
        testBuild: true,
        ...(sshCommand !== undefined ? { sshCommand } : {}),
      });
      const r = await git.run(['sshdump'], { class: cls, cwd: repo });
      assert.equal(r.code, 0, r.stderr.toString('utf8'));
      return r.stdout.toString('utf8');
    };
    const plain = buildDaemonEnv(noSsh, []);
    const userKey = 'ssh -i "/keys/id work"';
    // No setting anywhere: plain ssh with BatchMode.
    assert.equal(await dumpWith(plain, 'network'), `ssh ${SSH_BATCH}`);
    // The user's core.sshCommand is kept and BatchMode is appended to it.
    assert.equal(await dumpWith(plain, 'network', userKey), `${userKey} ${SSH_BATCH}`);
    // GIT_SSH_COMMAND in the daemon env outranks core.sshCommand.
    assert.equal(await dumpWith(buildDaemonEnv({ ...noSsh, GIT_SSH_COMMAND: 'ssh -4' }, []), 'network', userKey), `ssh -4 ${SSH_BATCH}`);
    // Only network-class calls get an ssh command.
    assert.equal(await dumpWith(plain, 'local', userKey), '<unset>');
  } finally {
    await cleanup();
  }
});

test('the Ports bundle accepts the real ports and the git runner', async () => {
  const { root, cleanup } = await makeTempRoot('runner-ports');
  try {
    const ports: Ports = {
      clock: realClock,
      random: realRandom,
      scheduler: realScheduler(realClock),
      fs: realFs,
      git: testRunner(),
    };
    const r = await ports.git.run(['version'], { class: 'local', cwd: root });
    assert.equal(r.code, 0, r.stderr.toString('utf8'));
    assert.match(r.stdout.toString('utf8'), /^git version \d+\.\d+/);
  } finally {
    await cleanup();
  }
});

test('ref-updating plumbing is never killed, even with a 1 ms override', async () => {
  const { root, cleanup } = await makeTempRoot('runner-neverkill');
  try {
    const repo = await initRepo(root, 'r');
    const blob = await testRunner().run(['hash-object', '-w', '--stdin'], { class: 'local', cwd: repo, stdin: Buffer.from('x\n') });
    const oid = blob.stdout.toString('utf8').trim();
    const git = createGitRunner({
      clock: realClock,
      hooksPath: join(root, 'empty-hooks'),
      daemonEnv: buildDaemonEnv(process.env, []),
      testBuild: true,
      watchdogOverrideMs: 1,
    });
    const r = await git.run(['update-ref', 'refs/cowork-test/blob', oid], { class: 'refupdate', cwd: repo });
    assert.equal(r.killedByWatchdog, false);
    assert.equal(r.code, 0, r.stderr.toString('utf8'));
  } finally {
    await cleanup();
  }
});

// Final review (exit-1 flake): the helpers below are never killed by a pid read back after they may have died (lint
// L-PID-KILL); they end on their own. This pins that they do, through this process's own handles.
test('a helper with selfExitPrologue ends on its own at its time cap and once the temp root is removed', async () => {
  const { root, cleanup } = await makeTempRoot('runner-selfexit');
  let cleaned = false;
  const started: ReturnType<typeof spawn>[] = [];
  // Wrapped in an object: an async function returning a promise would wait for it.
  const start = async (script: string): Promise<{ exit: Promise<number | null> }> => {
    // Started with its cwd inside the root, as git starts an alias.
    const c = spawn(process.execPath, [script], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    started.push(c);
    const exit = new Promise<number | null>((r) => c.on('exit', (code) => r(code)));
    await Promise.race([new Promise<void>((r) => c.stdout!.once('data', () => r())), exit]);
    return { exit };
  };
  const within = async <T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> => {
    let t: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([p, new Promise<'timeout'>((r) => { t = setTimeout(() => r('timeout'), ms); })]);
    } finally {
      clearTimeout(t);
    }
  };
  try {
    const capped = join(root, 'capped.cjs');
    const forever = join(root, 'forever.cjs');
    await writeFile(capped, Buffer.from(selfExitPrologue(root, 300) + `process.stdout.write('up');\nsetInterval(() => {}, 1000);\n`, 'utf8'));
    await writeFile(forever, Buffer.from(selfExitPrologue(root) + `process.stdout.write('up');\nsetInterval(() => {}, 1000);\n`, 'utf8'));
    assert.equal(await within((await start(capped)).exit, 15_000), 0, 'the helper ended at its time cap while the root still exists');
    const { exit: exited } = await start(forever);
    assert.equal(await within(exited, 1_000), 'timeout', 'the helper lives on while the root exists');
    // The helper moved its cwd out of the root, so the removal does not wait for it (Windows), and then it ends.
    await cleanup();
    cleaned = true;
    assert.equal(existsSync(root), false);
    assert.equal(await within(exited, 15_000), 0, 'the helper ended on its own once the root was removed');
  } finally {
    for (const c of started) c.kill(); // this process's own handles: a no-op for a child that has exited
    if (!cleaned) await cleanup();
  }
});

test('a watchdog kill takes down the whole process tree (Review Focus 2)', async () => {
  const { root, cleanup } = await makeTempRoot('runner-treekill');
  try {
    const repo = await initRepo(root, 'r');
    const hb = join(root, 'heart beat.txt');
    const beater = join(root, 'beater.cjs');
    const spawner = join(root, 'spawner.cjs');
    // Both helpers end on their own once the cleanup removes the root (selfExitPrologue): a broken kill fails the
    // heartbeat assertion below and leaves nothing running, and no pid is ever signalled after its process died.
    await writeFile(beater, Buffer.from(
      selfExitPrologue(root) +
      `const fs = require('fs');\n` +
      `setInterval(() => fs.appendFileSync(process.argv[2], 'x'), 20);\n`, 'utf8'));
    await writeFile(spawner, Buffer.from(
      selfExitPrologue(root) +
      `const { spawn } = require('child_process');\n` +
      `spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: 'ignore' });\n` +
      `setInterval(() => {}, 1000);\n`, 'utf8'));
    const git = testRunner();
    const set = await git.run(['config', 'alias.hb', `!node ${shq(spawner)} ${shq(beater)} ${shq(hb)}`], { class: 'local', cwd: repo });
    assert.equal(set.code, 0, set.stderr.toString('utf8'));

    const killer = createGitRunner({
      clock: realClock,
      hooksPath: join(root, 'empty-hooks'),
      daemonEnv: buildDaemonEnv(process.env, []),
      testBuild: true,
      watchdogOverrideMs: 3_000,
    });
    const r = await killer.run(['hb'], { class: 'local', cwd: repo });
    assert.equal(r.killedByWatchdog, true);
    assert.notEqual(r.code, 0);
    assert.ok(existsSync(hb), 'the grandchild ran before the kill');
    await pause(500);
    const s1 = statSync(hb).size;
    await pause(1_000);
    const s2 = statSync(hb).size;
    assert.ok(s1 > 0);
    assert.equal(s2, s1, 'heartbeat file kept growing: a grandchild survived the kill');
  } finally {
    await cleanup();
  }
});

/** A PowerShell single-quoted string literal. */
function psq(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * A PowerShell probe run in place of taskkill (GitRunnerDeps.winKillCommand): it holds a SYNCHRONIZE handle on `pid`,
 * creates `go` (git's alias then exits 7 on its own), waits for the process to end, closes that handle, waits 500 ms
 * and then opens `pid` afresh. Opening it with git's own exit code means the runner still held git's handle (the pid
 * could not be reused); `open-failed err=87` means the pid was free (and could have named an unrelated process).
 */
function pinProbe(pid: number, go: string, out: string): { file: string; args: string[] } {
  const ps = [
    `Add-Type -Name K -Namespace W -MemberDefinition '`,
    `[DllImport("kernel32.dll", SetLastError=true)] public static extern System.IntPtr OpenProcess(uint a, bool i, uint p);`,
    `[DllImport("kernel32.dll")] public static extern bool GetExitCodeProcess(System.IntPtr h, out uint c);`,
    `[DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(System.IntPtr h, uint ms);`,
    `[DllImport("kernel32.dll")] public static extern bool CloseHandle(System.IntPtr h);'`,
    `$h = [W.K]::OpenProcess(0x00101000, $false, ${pid})`,
    `if ($h -eq [System.IntPtr]::Zero) { $w = "wait=open-failed err=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())" } else { $w = 'wait=ok' }`,
    `[System.IO.File]::WriteAllText(${psq(go)}, '1')`,
    `if ($h -ne [System.IntPtr]::Zero) { [void][W.K]::WaitForSingleObject($h, 8000); [void][W.K]::CloseHandle($h) }`,
    `Start-Sleep -Milliseconds 500`,
    `$h2 = [W.K]::OpenProcess(0x1000, $false, ${pid})`,
    `if ($h2 -eq [System.IntPtr]::Zero) { $r = "open-failed err=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }`,
    `else { $c = [uint32]0; [void][W.K]::GetExitCodeProcess($h2, [ref]$c); [void][W.K]::CloseHandle($h2); $r = "opened exitcode=$c" }`,
    `[System.IO.File]::WriteAllText(${psq(`${out}.tmp`)}, "$w; $r")`,
    `[System.IO.File]::Move(${psq(`${out}.tmp`)}, ${psq(out)})`,
  ].join('\n');
  return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')] };
}

// Final review (production, rare): killTree started taskkill asynchronously (median ~0.7 s to finish). When git ended on
// its own inside that window, Node closed git's handle, Windows released the pid, and taskkill /T /F could end whatever
// took the pid next, with its tree. The Windows kill now runs synchronously in the watchdog/abort callback: while the
// event loop is blocked Node cannot close git's handle, so the pid keeps naming that (possibly exited) git.
test('a Windows watchdog or abort kill runs while git\'s pid cannot be reused: the pid still names that git when the kill ends', {
  skip: process.platform === 'win32' ? false : 'Windows only (taskkill; the POSIX group kill runs in the same tick)',
}, async () => {
  const { root, cleanup } = await makeTempRoot('runner-pinnedpid');
  try {
    const repo = await initRepo(root, 'r');
    const cases = ['watchdog', 'abort', 'watchdog', 'abort'] as const;
    for (const [i, how] of cases.entries()) {
      const go = join(root, `go-${i}`);
      const out = join(root, `probe-${i}.txt`);
      const waiter = join(root, `waiter-${i}.cjs`);
      // git's alias ends on its own with exit code 7 once `go` exists; the probe creates it.
      await writeFile(waiter, Buffer.from(
        selfExitPrologue(root) +
        `setInterval(() => { if (require('fs').existsSync(${JSON.stringify(go)})) process.exit(7); }, 10);\n`, 'utf8'));
      const set = await testRunner().run(['config', `alias.waitgo${i}`, `!node ${shq(waiter)}`], { class: 'local', cwd: repo });
      assert.equal(set.code, 0, set.stderr.toString('utf8'));
      const git = createGitRunner({
        clock: realClock,
        hooksPath: join(root, 'empty-hooks'),
        daemonEnv: buildDaemonEnv(process.env, []),
        testBuild: true,
        ...(how === 'watchdog' ? { watchdogOverrideMs: 1_000 } : {}),
        winKillCommand: (pid) => pinProbe(pid, go, out),
      });
      const ctl = new AbortController();
      const running = git.run([`waitgo${i}`], { class: 'local', cwd: repo, abort: ctl.signal });
      if (how === 'abort') {
        await pause(500);
        ctl.abort();
      }
      const r = await running;
      assert.deepEqual({ code: r.code, killed: r.killedByWatchdog, aborted: r.aborted },
        { code: 7, killed: how === 'watchdog', aborted: how === 'abort' }, `${how} #${i}: ${r.stderr.toString('utf8')}`);
      // A synchronous kill has ended before run() resolves; an asynchronous one may still be running: wait for it.
      for (let t = 0; t < 300 && !existsSync(out); t++) await pause(50);
      assert.ok(existsSync(out), `${how} #${i}: the kill command did not run to its end`);
      assert.equal(readFileSync(out, 'utf8'), 'wait=ok; opened exitcode=7',
        `${how} #${i}: once git had ended on its own, its pid no longer named it while the kill was running`);
    }
  } finally {
    await cleanup();
  }
});

// Final review #2: after git exits, a descendant that still holds git's stdout/stderr (a filter,
// a credential helper, a wrapper-started agent) must not keep run() waiting: the close grace is
// armed on every exit, not only after a watchdog kill. Nothing is killed, so NEVER_KILLED holds.
test('run() resolves within the close grace when a grandchild keeps git\'s stdio open after git exits', async () => {
  const { root, cleanup } = await makeTempRoot('runner-heldpipes');
  try {
    const repo = await initRepo(root, 'r');
    const holder = join(root, 'holder.cjs');
    // The grandchild holds git's stdout/stderr for 20 s at most and ends on its own once the cleanup removes the root.
    const sleeper = join(root, 'sleeper.cjs');
    await writeFile(sleeper, Buffer.from(selfExitPrologue(root) + `setTimeout(() => {}, 20000);\n`, 'utf8'));
    await writeFile(holder, Buffer.from(
      `const { spawn } = require('child_process');\n` +
      `const c = spawn(process.execPath, [${JSON.stringify(sleeper)}], { stdio: 'inherit', detached: true });\n` +
      `c.unref();\n` +
      `process.stdout.write('parent done\\n');\n`, 'utf8'));
    const git = testRunner();
    const set = await git.run(['config', 'alias.held', `!node ${shq(holder)}`], { class: 'local', cwd: repo });
    assert.equal(set.code, 0, set.stderr.toString('utf8'));
    const t0 = Date.now();
    const r = await git.run(['held'], { class: 'local', cwd: repo });
    const took = Date.now() - t0;
    assert.equal(r.code, 0, r.stderr.toString('utf8'));
    assert.equal(r.killedByWatchdog, false);
    assert.match(r.stdout.toString('utf8'), /parent done/);
    assert.ok(took < 12_000, `run() took ${took} ms: it waited for the grandchild holding git's pipes`);
  } finally {
    await cleanup();
  }
});

// Final review minor (board): the close grace runs from git's exit, so after an event-loop stall of 5 s or more its
// expired timer ran before the poll phase that reads what was already written to git's stdout pipe: run() resolved
// rc 0 with that output cut off. The stall here starts once git has exited (its parent wrote a marker, then the test
// waits) and lasts past the grace while a grandchild writes into the still-open pipe; the expired timer must first let
// the loop read what is pending.
test('run() keeps output that was pending in the pipe when an event-loop stall outlasted the close grace', async () => {
  const { root, cleanup } = await makeTempRoot('runner-stall');
  const marker = join(root, 'parent-exiting');
  const go = join(root, 'go');
  try {
    const repo = await initRepo(root, 'r');
    const late = join(root, 'late.cjs');
    const holder = join(root, 'holder.cjs');
    // The grandchild ends on its own once the cleanup removes the root (or after its 20 s sleep).
    await writeFile(late, Buffer.from(
      selfExitPrologue(root) +
      `const fs = require('fs');\n` +
      `const t = setInterval(() => {\n` +
      `  if (!fs.existsSync(${JSON.stringify(go)})) return;\n` +
      `  clearInterval(t);\n` +
      `  process.stdout.write('late\\n');\n` +
      `  setTimeout(() => {}, 20000);\n` +
      `}, 20);\n`, 'utf8'));
    await writeFile(holder, Buffer.from(
      `const fs = require('fs');\n` +
      `const { spawn } = require('child_process');\n` +
      `const c = spawn(process.execPath, [${JSON.stringify(late)}], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });\n` +
      `c.unref();\n` +
      `process.stdout.write('early\\n');\n` +
      `fs.writeFileSync(${JSON.stringify(marker)}, '1');\n`, 'utf8'));
    const git = testRunner();
    const set = await git.run(['config', 'alias.stall', `!node ${shq(holder)}`], { class: 'local', cwd: repo });
    assert.equal(set.code, 0, set.stderr.toString('utf8'));

    const running = git.run(['stall'], { class: 'local', cwd: repo });
    const t0 = Date.now();
    while (!existsSync(marker)) {
      assert.ok(Date.now() - t0 < 30_000, 'the alias never ran');
      await pause(20);
    }
    // Let git exit and the runner see it (the close grace is armed), then stall the event loop past the grace while
    // the grandchild writes into git's still-open stdout pipe.
    await pause(1_500);
    await writeFile(go, '1');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6_500);
    const r = await running;
    assert.equal(r.code, 0, r.stderr.toString('utf8'));
    assert.equal(r.stdout.toString('utf8'), 'early\nlate\n', 'the output written before the grace expired is all there');
  } finally {
    await cleanup();
  }
});
