// Plan 5 Task 4: the one daemon spawn routine, the runtime copy and the branch read (R2-I2, CCI-51, M27, R5-19; 06 §3.17.2, 09 §3.4, SEC-05; A4-4, A4-9,
// P5-EC-6). A recording spawner stands in for child_process.spawn (P5-EC-9: no test here starts a process).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { copyRuntime, createSpawner, headBranch, spawnDaemon, type DaemonSpawner, type SpawnDeps } from '../../src/claude/client/spawn.js';
import { TOKEN_ENV } from '../../src/claude/client/mcp/doorbell.js';
import { buildDaemonEnv } from '../../src/git/env.js';
import { realFs } from '../../src/ports/fs.js';
import { seededRandom } from '../../src/ports/random.js';
import { PLUGIN_VERSION } from '../../src/version.js';
import { FaultFs } from '../sim/faultfs.js';
import { makeTempRoot } from '../helpers/tmp.js';

const V = PLUGIN_VERSION;
let tmp: { root: string; cleanup: () => Promise<void> };
before(async () => {
  tmp = await makeTempRoot('claude-spawn');
});
after(() => tmp?.cleanup());

function recorder(): DaemonSpawner & { calls: Array<{ argv: readonly string[]; env: Record<string, string>; cwd: string }> } {
  const calls: Array<{ argv: readonly string[]; env: Record<string, string>; cwd: string }> = [];
  return { calls, spawn: (argv, env, cwd) => { calls.push({ argv: [...argv], env: { ...env }, cwd }); } };
}

const SOURCE: Record<string, string> = {
  PATH: '/bin', HTTPS_PROXY: 'http://p:3128', ALL_PROXY: 'socks5://p:1080', GIT_SSH_COMMAND: 'ssh -i k', SSH_AUTH_SOCK: '/s', GIT_INDEX_FILE: '/x',
  GIT_DIR: '/y', NODE_OPTIONS: '--inspect', ELECTRON_RUN_AS_NODE: '1', CLAUDE_CODE_MESSAGING_SOCKET: '/sock', CLAUDE_PLUGIN_DATA: '/d',
  [TOKEN_ENV]: 'COWORK_CANARY_TOKEN_1',
};

function spawnDeps(label: string, env: Record<string, string | undefined>, spawner: DaemonSpawner): SpawnDeps {
  return { fs: realFs, spawner, env, pluginRoot: '/p', dataDir: join(tmp.root, label, 'data'), version: V, passthrough: ['HTTPS_PROXY'] };
}

test('spawnDaemon passes exactly buildDaemonEnv; messaging and CLAUDE_* variables never reach the child', async () => {
  const rec = recorder();
  await spawnDaemon({ repoRoot: '/r', branch: 'main' }, spawnDeps('env', SOURCE, rec));
  assert.equal(rec.calls.length, 1);
  const env = rec.calls[0]!.env;
  assert.deepEqual(env, buildDaemonEnv({ ...SOURCE }, ['HTTPS_PROXY']));
  assert.deepEqual(Object.keys(env).filter((k) => k.startsWith('CLAUDE_')), []);
  for (const k of ['GIT_INDEX_FILE', 'GIT_DIR', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) assert.ok(!(k in env), k);
  assert.ok(!Object.values(env).some((v) => v.includes('COWORK_CANARY_TOKEN_1')), 'the token value never reaches the child');
  assert.equal(env['HTTPS_PROXY'], 'http://p:3128', 'the passthrough name');
});

test('M27 is caught: under COWORK_TEST_MUTANT=M27 the canary token reaches the child env', async () => {
  const rec = recorder();
  await spawnDaemon({ repoRoot: '/r', branch: 'main' }, spawnDeps('m27', { ...SOURCE, COWORK_TEST_MUTANT: 'M27' }, rec));
  const env = rec.calls[0]!.env;
  assert.ok(Object.values(env).some((v) => v.includes('COWORK_CANARY_TOKEN_1')), 'the mutant hands the caller\'s environment over');
  assert.notDeepEqual(env, buildDaemonEnv({ ...SOURCE, COWORK_TEST_MUTANT: 'M27' }, ['HTTPS_PROXY']), 'the previous test\'s assertion fails');
});

test('spawnDaemon runs the runtime copy when present, else the plugin\'s dist, with the R5-19 argv', async () => {
  const rec = recorder();
  const d = spawnDeps('argv', { PATH: '/bin' }, rec);
  const runtime = join(d.dataDir, 'runtime', V, 'daemon.js');
  mkdirSync(join(d.dataDir, 'runtime', V), { recursive: true });
  writeFileSync(runtime, '// runtime copy\n');
  await spawnDaemon({ repoRoot: '/r', branch: 'main' }, d);
  assert.deepEqual(rec.calls[0]!.argv, [process.execPath, runtime, 'run', '--repo', '/r', '--branch', 'main', '--data-dir', d.dataDir, '--plugin-root', '/p', '--spawned']);
  assert.equal(rec.calls[0]!.cwd, '/r', 'P5-T4-2: the daemon starts in the repo it serves, never in the hook process cwd');
  const rec2 = recorder();
  await spawnDaemon({ repoRoot: '/r', branch: 'feat/x' }, spawnDeps('argv-absent', { PATH: '/bin' }, rec2));
  assert.equal(rec2.calls[0]!.argv[1], join('/p', 'dist', 'daemon.js'));
  assert.deepEqual(rec2.calls[0]!.argv.slice(2, 6), ['run', '--repo', '/r', '--branch']);
  assert.equal(rec2.calls[0]!.argv[6], 'feat/x');

  // createSpawner: detached, stdio ignored, windowsHide, the env given; unref() once; the hook never waits for the child (it never exits here).
  const seen: Array<{ file: string; args: readonly string[]; options: Record<string, unknown> }> = [];
  let unrefs = 0;
  const spy = ((file: string, args: readonly string[], options: Record<string, unknown>) => {
    seen.push({ file, args, options });
    return { unref: () => { unrefs += 1; }, on: () => undefined, once: () => undefined };
  }) as unknown as typeof nodeSpawn;
  const env = { PATH: '/bin' };
  const t0 = performance.now();
  await spawnDaemon({ repoRoot: '/r', branch: 'main' }, { ...spawnDeps('spy', env, createSpawner(spy)) });
  assert.ok(performance.now() - t0 < 1_000, 'resolves without waiting for the child');
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.file, process.execPath);
  assert.equal(seen[0]!.args[0], join('/p', 'dist', 'daemon.js'));
  assert.deepEqual(seen[0]!.options, { detached: true, stdio: 'ignore', windowsHide: true, env: buildDaemonEnv({ ...env }, ['HTTPS_PROXY']), cwd: '/r' },
    'A4-4 as amended by P5-T4-2: cwd = the repo root (a detached child would pin the hook process cwd folder on Windows for its whole life)');
  assert.equal(unrefs, 1);
});

/** Every file under dir (forward-slash relative paths). */
function files(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n), `${prefix}${n}/`) : [`${prefix}${n}`])).sort();
}

function pluginRoot(label: string, o: { worker?: boolean; grammars?: boolean } = {}): string {
  const root = join(tmp.root, label, 'plugin');
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist', 'daemon.js'), '// daemon\n');
  if (o.worker !== false) writeFileSync(join(root, 'dist', 'worker.js'), '// worker\n');
  if (o.grammars !== false) {
    mkdirSync(join(root, 'dist', 'grammars'), { recursive: true });
    writeFileSync(join(root, 'dist', 'grammars', 'a.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d]));
  }
  writeFileSync(join(root, 'dist', 'core.js'), '// not copied\n');
  return root;
}

test('copyRuntime copies daemon.js, worker.js and the grammars through a temp directory and a rename', async () => {
  const root = pluginRoot('copy');
  const data = join(tmp.root, 'copy', 'data');
  const fs = new FaultFs(realFs);
  assert.equal(await copyRuntime(root, data, V, fs, seededRandom('copy')), 'copied');
  assert.deepEqual(files(join(data, 'runtime', V)), ['daemon.js', 'grammars/a.wasm', 'worker.js']);
  assert.ok(readFileSync(join(data, 'runtime', V, 'grammars', 'a.wasm')).equals(Buffer.from([0, 0x61, 0x73, 0x6d])));
  assert.deepEqual(readdirSync(join(data, 'runtime')), [V], 'the temp directory became runtime/<version>/');
  assert.ok(fs.calls.some((c) => /^rename .*[\\/]\.tmp-/.test(c)), 'through a rename of runtime/.tmp-<version>-<16 hex>');
  assert.ok(fs.calls.some((c) => new RegExp(`\\.tmp-${V.replace(/\./g, '\\.')}-[0-9a-f]{16}`).test(c)), 'A4-9 temp name');

  const again = new FaultFs(realFs);
  assert.equal(await copyRuntime(root, data, V, again, seededRandom('copy-2')), 'present');
  assert.deepEqual(again.calls.filter((c) => /^(?:writeFile|rename|mkdirp|appendFile|writeFileExclusive) /.test(c)), [], 'no write');

  // A plugin root missing worker.js (or the grammars): failed, no runtime/<version>/ and no temp directory left.
  for (const [label, o] of [['no-worker', { worker: false }], ['no-grammars', { grammars: false }]] as const) {
    const d = join(tmp.root, label, 'data');
    assert.equal(await copyRuntime(pluginRoot(label, o), d, V, realFs, seededRandom(label)), 'failed', label);
    assert.ok(!existsSync(join(d, 'runtime', V)), `${label}: no runtime/${V}/`);
    assert.deepEqual(existsSync(join(d, 'runtime')) ? readdirSync(join(d, 'runtime')) : [], [], `${label}: no .tmp-* left`);
  }

  // A leftover runtime/.tmp-<V>-0123456789abcdef/ of an interrupted copy is removed by the next call.
  const left = join(tmp.root, 'leftover', 'data');
  mkdirSync(join(left, 'runtime', `.tmp-${V}-0123456789abcdef`), { recursive: true });
  writeFileSync(join(left, 'runtime', `.tmp-${V}-0123456789abcdef`, 'daemon.js'), 'partial');
  assert.equal(await copyRuntime(pluginRoot('leftover'), left, V, realFs, seededRandom('left')), 'copied');
  assert.deepEqual(readdirSync(join(left, 'runtime')), [V]);
  mkdirSync(join(left, 'runtime', `.tmp-${V}-fedcba9876543210`), { recursive: true });
  assert.equal(await copyRuntime(pluginRoot('leftover'), left, V, realFs, seededRandom('left-2')), 'present');
  assert.deepEqual(readdirSync(join(left, 'runtime')), [V], 'removed before the present check too');

  // A failing rename: failed, runtime/<version>/ absent.
  const faulty = new FaultFs(realFs);
  faulty.addRule({ op: 'rename', pathIncludes: '.tmp-', code: 'EPERM', times: 1 });
  const fd = join(tmp.root, 'rename', 'data');
  assert.equal(await copyRuntime(pluginRoot('rename'), fd, V, faulty, seededRandom('rename')), 'failed');
  assert.equal(faulty.hits.get('rename:EPERM:.tmp-'), 1);
  assert.ok(!existsSync(join(fd, 'runtime', V)));
});

test('headBranch reads <gitdir>/HEAD as a file', async () => {
  const gitdir = join(tmp.root, 'head', '.git');
  mkdirSync(gitdir, { recursive: true });
  const cases: Array<[string | null, string | null]> = [
    ['ref: refs/heads/main\n', 'main'], ['ref: refs/heads/feat/x\n', 'feat/x'], ['0123456789abcdef0123456789abcdef01234567\n', null], [null, null],
  ];
  for (const [content, want] of cases) {
    const head = join(gitdir, 'HEAD');
    if (content === null) {
      if (existsSync(head)) (await import('node:fs')).rmSync(head);
    } else {
      writeFileSync(head, content);
    }
    const fs = new FaultFs(realFs);
    assert.equal(await headBranch(gitdir, fs), want, JSON.stringify(content));
    assert.deepEqual(fs.calls, [`readFile ${join(gitdir, 'HEAD')}`], 'one readFile and nothing else (no git process)');
  }
});
