// cli.js start → status → stop (v0.1.0-preview) on a real clone of a file:// bare remote, through the built bundles laid out as
// the plugin is (<root>/package.json with "type": "module", <root>/dist/*.js). The CLI runs as a child process in pipe mode (no
// CLAUDECODE), so its exit codes are the terminal ones; the daemon it starts runs detached and is stopped through the CLI's stop
// verb (a stop-request file, never a pid signal). Git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STOP_REQUEST_FILE } from '../../src/engine/daemonFiles.js';
import { PLUGIN_VERSION } from '../../src/version.js';
import { clonePeer, seedRemote } from '../sim/peers.js';
import { createBareRemote } from '../sim/remote.js';
import { makeTempRoot, testRunner } from '../helpers/tmp.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const runner = testRunner();

/** This process's environment without CLAUDECODE (pipe mode: real exit codes) and without proxies or ssh overrides. */
function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k === 'CLAUDECODE' || /^(https?_proxy|all_proxy|no_proxy|git_ssh_command|git_ssh|git_ssh_variant)$/i.test(k)) continue;
    env[k] = v;
  }
  return env;
}

interface Run { code: number | null; out: string; err: string; }
function cli(pluginRoot: string, args: string[], cwd: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(pluginRoot, 'dist', 'cli.js'), ...args], { cwd, env: cliEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out: Buffer.concat(out).toString('utf8'), err: Buffer.concat(err).toString('utf8') }));
  });
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(what: string, f: () => Promise<boolean>, ms = 60_000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('cowork start → status → stop: a refused start relays the daemon\'s refusal with this CLI\'s commands, then the daemon starts in the background, status reports it, a second start finds it, stop drains it to down', async () => {
  const { root, cleanup } = await makeTempRoot('cli-verbs');
  const plugin = join(root, 'plugin');
  let coworkDir: string | null = null;
  try {
    // The plugin layout: dist/ next to a package.json that makes node read the bundles as ES modules.
    await mkdir(plugin, { recursive: true });
    await writeFile(join(plugin, 'package.json'), '{ "type": "module" }\n');
    const b = spawnSync(process.execPath, [join(repoRoot, 'tools', 'build', 'build.mjs'), '--outdir', join(plugin, 'dist')], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(b.status, 0, b.stderr);
    const v = await cli(plugin, ['--version'], root);
    assert.equal(v.out, `cowork-sync cli ${PLUGIN_VERSION}\n`);

    const remote = await createBareRemote(root, runner);
    await seedRemote(remote, root, runner, { 'README.md': Buffer.from('# cli\n'), 'a.txt': Buffer.from('a\n') });
    const c1 = await clonePeer(remote, root, { name: 'c1', autocrlf: false, withFilter: false }, runner);
    coworkDir = join(c1.dir, '.git', 'cowork');
    const sub = join(c1.dir, 'sub');
    await mkdir(sub);
    await writeFile(join(sub, 'local.txt'), 'not shared yet\n');

    // Outside a work tree: refused, nothing started.
    const outside = await cli(plugin, ['status'], root);
    assert.equal(outside.code, 1, outside.err);
    assert.match(outside.err, /\[RF_COWORK_NOT_A_REPO\]/);

    // Never run here yet.
    const never = await cli(plugin, ['status'], sub);
    assert.equal(never.code, 1);
    assert.match(never.out, /sync has not run in this clone yet/);

    // Uncommitted work at the first start: the daemon refuses START_PREVIEW; its next line names this CLI's start.
    const preview = await cli(plugin, ['start'], sub);
    assert.equal(preview.code, 1, `${preview.out}\n${preview.err}`);
    assert.match(preview.err, /^cowork-sync: the daemon did not start; it said:\nSTART_PREVIEW \{/);
    assert.match(preview.err, /next: node ".*cli\.js" start --publish=all to share the local work, or node ".*cli\.js" start --publish=none to hold it/);
    assert.equal(await exists(join(coworkDir, 'daemon.lock')), false, 'the refused daemon released its lock');

    // Started in the background (from a subfolder: the clone's top folder is found).
    const started = await cli(plugin, ['start', '--publish=all', '--name', 'Ann'], sub);
    assert.equal(started.code, 0, `${started.out}\n${started.err}`);
    assert.match(started.out, /^cowork-sync: sync started on main \(genesis\); the daemon keeps running in the background\.\nnext: node ".*cli\.js" status\n$/);
    assert.equal(await exists(join(coworkDir, 'daemon.lock')), true, 'the daemon holds its lock after the CLI exited');

    await waitFor('state ok', async () => /state: ok/.test((await cli(plugin, ['status'], c1.dir)).out));
    const st = await cli(plugin, ['status'], c1.dir);
    assert.equal(st.code, 0, st.out);
    assert.match(st.out, /^cowork-sync: running on main as peer [0-9a-f]{8} \(state: ok\)\n/);
    assert.match(st.out, /\n {2}peers: {9}Ann \(this clone\)\n/);
    assert.match(st.out, /\n {2}waiting: {7}\d+ ready to publish, \d+ open, \d+ incoming, \d+ held\n/);
    assert.match(st.out, /\n {2}files: .*status\.json and .*daemon-0\.jsonl\n$/);

    const again = await cli(plugin, ['start'], c1.dir);
    assert.equal(again.code, 0);
    assert.match(again.out, /^cowork-sync: sync already runs in this clone\.\ncowork-sync: running on main/);

    const stopped = await cli(plugin, ['stop'], c1.dir);
    assert.equal(stopped.code, 0, `${stopped.out}\n${stopped.err}`);
    assert.match(stopped.out, /^cowork-sync: sync stopped; your files stay as they are\.\nnext: node ".*cli\.js" start\n$/);
    assert.equal(await exists(join(coworkDir, 'daemon.lock')), false, 'the lock is released');
    const status = JSON.parse(await readFile(join(coworkDir, 'status.json'), 'utf8')) as { state: string };
    assert.equal(status.state, 'down');
    assert.equal(await exists(join(coworkDir, STOP_REQUEST_FILE)), false, 'the stop request is removed');

    const down = await cli(plugin, ['status'], c1.dir);
    assert.equal(down.code, 1);
    assert.match(down.out, /^cowork-sync: not running in this clone \(last state on main: down\)\nnext: node ".*cli\.js" start\n/);
    const twice = await cli(plugin, ['stop'], c1.dir);
    assert.equal(twice.code, 0);
    assert.match(twice.out, /^cowork-sync: sync is not running in this clone\./);
    assert.match(await readFile(join(coworkDir, 'log', 'daemon-0.jsonl'), 'utf8'), /"DAEMON_START"/);
  } finally {
    // A daemon this test started and did not stop is asked to stop (never killed by its pid) before the folder goes.
    if (coworkDir !== null && (await exists(join(coworkDir, 'daemon.lock')))) {
      const lock = JSON.parse(await readFile(join(coworkDir, 'daemon.lock'), 'utf8')) as { instance: string };
      await writeFile(join(coworkDir, STOP_REQUEST_FILE), `${lock.instance}\n`).catch(() => undefined);
      await waitFor('the daemon to stop', async () => !(await exists(join(coworkDir!, 'daemon.lock'))), 60_000).catch(() => undefined);
    }
    await cleanup();
  }
});
