// The runner's process-tree kill spawns taskkill.exe by absolute path (Plan 8a Task 2; 12 §9.7 item 5; R-V06; contract:
// win32.join(<SystemRoot>, 'System32', 'taskkill.exe'), cwd <SystemRoot>, SystemRoot read case-insensitively from
// deps.daemonEnv and absolute, else child.kill only). On Windows a bare name is looked up in the current directory first
// and then along PATH, so a taskkill.exe a repository plants there must never run. Windows legs only. An integration
// test (real git and process trees; each leg waits for a real watchdog kill, ~17 s in all: over the 10 s unit budget).
// The helpers git starts end on their own once their `alive` directory is removed (selfExitPrologue; the cleanup removes
// it with the root): no pid is ever signalled after its process may have died (L-PID-KILL).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildDaemonEnv } from '../../../src/git/env.js';
import { createGitRunner, type GitResult } from '../../../src/git/runner.js';
import { realClock } from '../../../src/ports/clock.js';
import { selfExitPrologue } from '../../helpers/selfExit.js';
import { makeTempRoot, testRunner } from '../../helpers/tmp.js';

const WINDOWS_ONLY = process.platform === 'win32' ? false : 'taskkill exists on Windows only (POSIX kills the process group)';

function shq(p: string): string {
  return `'${p.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`;
}
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A program named taskkill.exe that records that it ran (a copy of node; NODE_OPTIONS makes it load the marker). */
function plantTaskkill(dir: string, source: string | null): string {
  mkdirSync(dir, { recursive: true });
  const exe = join(dir, 'taskkill.exe');
  if (source === null) copyFileSync(process.execPath, exe);
  else {
    try {
      linkSync(source, exe);
    } catch {
      copyFileSync(source, exe);
    }
  }
  return exe;
}

interface Fixture { root: string; repo: string; hb: string; alive: string; ran: string; base: string; cleanup(): Promise<void>; }

/** A repository whose alias `hb` starts a node child that starts a heartbeat grandchild (the Plan 1 tree-kill fixture). */
async function fixture(label: string): Promise<Fixture> {
  const { root, cleanup } = await makeTempRoot(label);
  const base = dirname(root);   // no space in it: NODE_OPTIONS carries a path from here
  const repo = join(root, 'r');
  mkdirSync(repo, { recursive: true });
  const init = await testRunner().run(['init', '-q', '-b', 'main', repo], { class: 'local', cwd: root });
  assert.equal(init.code, 0, init.stderr.toString('utf8'));
  const hb = join(root, 'heart beat.txt');
  const alive = join(root, 'helpers alive');
  mkdirSync(alive);
  const beater = join(root, 'beater.cjs');
  const spawner = join(root, 'spawner.cjs');
  writeFileSync(beater, `${selfExitPrologue(alive)}const fs = require('fs');\nsetInterval(() => fs.appendFileSync(process.argv[2], 'x'), 20);\n`);
  writeFileSync(spawner, `${selfExitPrologue(alive)}const { spawn } = require('child_process');\n`
    + `spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: 'ignore' });\nsetInterval(() => {}, 1000);\n`);
  const set = await testRunner().run(['config', 'alias.hb', `!node ${shq(spawner)} ${shq(beater)} ${shq(hb)}`], { class: 'local', cwd: repo });
  assert.equal(set.code, 0, set.stderr.toString('utf8'));
  const ran = join(base, 'planted-taskkill-ran.txt');
  writeFileSync(join(base, 'marker.cjs'), `require('fs').appendFileSync(${JSON.stringify(ran)}, process.argv0 + '\\n');\n`);
  return { root, repo, hb, alive, ran, base, cleanup };
}

/**
 * Runs `hb` under a watchdog (1.5 s by default) with taskkill.exe planted in the cwd, on a relative PATH entry and where
 * a relative SystemRoot `Windows` would reach it (libuv joins a relative exe path onto a relative spawn cwd, so
 * `Windows\System32\taskkill.exe` with cwd `Windows` resolves under `<cwd>\Windows\Windows`); restores cwd and env.
 */
async function runPlanted(f: Fixture, daemonEnv: Record<string, string>, watchdogMs = 1_500): Promise<{ result: Promise<GitResult>; restore(): void }> {
  const cwdPlant = join(f.base, 'cwd plant');
  const first = plantTaskkill(cwdPlant, null);
  for (const dir of ['bin', join('Windows', 'System32'), join('Windows', 'Windows', 'System32')]) plantTaskkill(join(cwdPlant, dir), first);
  const saved = { cwd: process.cwd(), path: process.env['PATH'], nodeOptions: process.env['NODE_OPTIONS'] };
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const runner = createGitRunner({ clock: realClock, hooksPath: join(f.base, 'empty-hooks'), daemonEnv, testBuild: true, watchdogOverrideMs: watchdogMs });
  process.chdir(cwdPlant);
  process.env[pathKey] = `bin;${saved.path ?? ''}`;
  // Forward slashes: NODE_OPTIONS treats a backslash inside double quotes as an escape.
  process.env['NODE_OPTIONS'] = `--require "${join(f.base, 'marker.cjs').replace(/\\/g, '/')}"`;
  const restore = (): void => {
    process.chdir(saved.cwd);
    process.env[pathKey] = saved.path;
    if (saved.nodeOptions === undefined) delete process.env['NODE_OPTIONS'];
    else process.env['NODE_OPTIONS'] = saved.nodeOptions;
  };
  return { result: runner.run(['hb'], { class: 'local', cwd: f.repo }), restore };
}

test('killTree spawns taskkill.exe by absolute path', { skip: WINDOWS_ONLY }, async () => {
  const f = await fixture('runner-taskkill-abs');
  let restore = (): void => {};
  try {
    const env = buildDaemonEnv(process.env as Record<string, string | undefined>, []);
    assert.ok(Object.keys(env).some((k) => k.toUpperCase() === 'SYSTEMROOT'), 'the builder env carries SystemRoot');
    const run = await runPlanted(f, env);
    restore = run.restore;
    const r = await Promise.race([run.result, pause(8_000).then(() => null)]);
    restore();
    assert.ok(r !== null, `the watchdog kill did not end git: the tree kill never ran (a planted taskkill.exe ran: ${existsSync(f.ran)})`);
    assert.equal(r.killedByWatchdog, true);
    assert.equal(existsSync(f.ran), false, `a planted taskkill.exe ran: ${existsSync(f.ran) ? readFileSync(f.ran, 'utf8') : ''}`);
    assert.ok(existsSync(f.hb), 'the grandchild ran before the kill');
    await pause(300);
    const s1 = statSync(f.hb).size;
    await pause(700);
    assert.equal(statSync(f.hb).size, s1, 'heartbeat kept growing: the grandchild survived the kill');
  } finally {
    restore();
    await f.cleanup();
  }
});

test('without an absolute SystemRoot in the runner env only child.kill runs', { skip: WINDOWS_ONLY }, async () => {
  const f = await fixture('runner-taskkill-noroot');
  let restore = (): void => {};
  try {
    const all = buildDaemonEnv(process.env as Record<string, string | undefined>, []);
    const without = Object.fromEntries(Object.entries(all).filter(([k]) => k.toUpperCase() !== 'SYSTEMROOT'));

    // No SystemRoot: the watchdog fires at 1.5 s, git dies by child.kill and the grandchild keeps beating.
    let run = await runPlanted(f, without);
    restore = run.restore;
    await pause(2_300);
    restore();
    assert.equal(existsSync(f.ran), false, 'no SystemRoot: a planted taskkill.exe ran');
    assert.ok(existsSync(f.hb), 'the grandchild ran');
    const s1 = statSync(f.hb).size;
    await pause(300);
    assert.ok(statSync(f.hb).size > s1, 'the grandchild was killed: something beyond child.kill ran');
    // The survivors end on their own (they hold git's stdout and keep its shell, whose cwd is the repository, alive).
    rmSync(f.alive, { recursive: true, force: true });
    let r = await Promise.race([run.result, pause(8_000).then(() => null)]);
    assert.ok(r !== null, 'git outlived child.kill');
    assert.equal(r.killedByWatchdog, true);

    // A relative SystemRoot (node cannot start under it, so the alias is a plain 1 s sleep): child.kill only as well,
    // although taskkill.exe is planted where the relative path would resolve (see runPlanted).
    const set = await testRunner().run(['config', 'alias.hb', '!sleep 1'], { class: 'local', cwd: f.repo });
    assert.equal(set.code, 0, set.stderr.toString('utf8'));
    run = await runPlanted(f, { ...without, SystemRoot: 'Windows' }, 600);
    restore = run.restore;
    r = await Promise.race([run.result, pause(8_000).then(() => null)]);
    restore();
    assert.ok(r !== null, 'git outlived child.kill');
    assert.equal(r.killedByWatchdog, true);
    assert.equal(existsSync(f.ran), false, `relative SystemRoot: a planted taskkill.exe ran: ${existsSync(f.ran) ? readFileSync(f.ran, 'utf8') : ''}`);

    // Every case variant counts: an absolute SystemRoot beside a relative SYSTEMROOT is refused (child.kill only), so the
    // taskkill.exe under the absolute one never runs either.
    const fake = join(f.base, 'fakeroot');
    plantTaskkill(join(fake, 'System32'), null);
    run = await runPlanted(f, { ...without, SystemRoot: fake, SYSTEMROOT: 'Windows' }, 600);
    restore = run.restore;
    r = await Promise.race([run.result, pause(8_000).then(() => null)]);
    restore();
    assert.ok(r !== null, 'git outlived child.kill');
    assert.equal(r.killedByWatchdog, true);
    assert.equal(existsSync(f.ran), false, `mixed SystemRoot variants: a planted taskkill.exe ran: ${existsSync(f.ran) ? readFileSync(f.ran, 'utf8') : ''}`);
  } finally {
    restore();
    await f.cleanup();
  }
});

test('killTree falls back to child.kill when taskkill exits non-zero', { skip: WINDOWS_ONLY }, async () => {
  const f = await fixture('runner-taskkill-fails');
  let restore = (): void => {};
  try {
    const all = buildDaemonEnv(process.env as Record<string, string | undefined>, []);
    const without = Object.fromEntries(Object.entries(all).filter(([k]) => k.toUpperCase() !== 'SYSTEMROOT'));
    // An absolute SystemRoot whose System32\taskkill.exe exits 1 (a copy of node given /PID as its script).
    const fake = join(f.base, 'failing root');
    plantTaskkill(join(fake, 'System32'), null);
    const set = await testRunner().run(['config', 'alias.hb', '!sleep 3'], { class: 'local', cwd: f.repo });
    assert.equal(set.code, 0, set.stderr.toString('utf8'));
    const run = await runPlanted(f, { ...without, SYSTEMROOT: fake }, 600);
    restore = run.restore;
    const r = await Promise.race([run.result, pause(8_000).then(() => null)]);
    restore();
    assert.ok(r !== null, 'git never ended');
    assert.equal(r.killedByWatchdog, true);
    assert.ok(existsSync(f.ran), 'the taskkill.exe under the absolute SystemRoot ran (and exited 1)');
    // Killed (no exit code: -1), not ended by its 3 s alias on its own (exit code 0).
    assert.equal(r.code, -1, `git was not killed after taskkill failed: exit code ${r.code}`);
  } finally {
    restore();
    await f.cleanup();
  }
});
