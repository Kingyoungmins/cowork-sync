// src/claude/client/spawn.ts — 06 §3.17.2 "one spawn routine" (CCI-51, R2-I2, R5-19; A4-4, A4-9, P5-EC-6): spawnDaemon() is the only daemon spawn
// (L-SPAWN; L-PORTS allow-lists child_process here), never called from the MCP tier; the SessionStart runtime copy into
// CLAUDE_PLUGIN_DATA/runtime/<version>/; the branch read from <gitdir>/HEAD as a file. The child's environment is exactly DAEMON_ENV (09 §3.4,
// SEC-05: buildDaemonEnv of Plan 1's src/git/env.ts, the client tier's one src/git import, R5-03) — never a CLAUDE_* value; the M27 site (A4-11,
// P5-EC-4): in a test build only, COWORK_TEST_MUTANT=M27 hands the caller's whole environment over instead. The SEC-36 checksum check of the
// runtime copy is Plan 7's (X5-35).
import { spawn as childSpawn } from 'node:child_process';
import { join } from 'node:path';
import type { ClientMutantId } from '../wire/frames.js';
import { buildDaemonEnv } from '../../git/env.js';
import { errnoCode, type Fs } from '../../ports/fs.js';
import { randomHex, type Random } from '../../ports/random.js';

declare const __COWORK_TEST_BUILD__: boolean | undefined;
// P5-EC-4's guard, written at the seam: esbuild 0.24.2 folds `typeof __COWORK_TEST_BUILD__ === 'undefined' || __COWORK_TEST_BUILD__` to false under
// --release and drops the branch only where the expression itself stands (a module-level const of a module with imports stays a var, its seam kept).

/** process.execPath, detached, stdio 'ignore', windowsHide, unref(); `cwd` is the repo the daemon serves (P5-T4-2, amending A4-4). */
export interface DaemonSpawner { spawn(argv: readonly string[], env: Record<string, string>, cwd: string): void; }

/** A4-4 as amended by P5-T4-2: argv[0] with argv[1..] and {detached: true, stdio: 'ignore', windowsHide: true, env, cwd}, then child.unref(); never
 *  waits for the child and never attaches the hook's stdio (an orphan holding a hook's stdout keeps that hook running, 06 §3.4.2). The cwd is the repo
 *  the daemon serves, as the preview launcher does (src/cli/verbs.ts → src/cli/launch.ts): a detached child that inherited the hook's cwd would keep
 *  that folder from being renamed or deleted on Windows for its whole life. A spawn error event is swallowed: the hook then finds the daemon still
 *  down (G4 for a gating event). */
export function createSpawner(spawn: typeof import('node:child_process').spawn): DaemonSpawner {
  return {
    spawn(argv: readonly string[], env: Record<string, string>, cwd: string): void {
      const child = spawn(argv[0] as string, argv.slice(1), { detached: true, stdio: 'ignore', windowsHide: true, env, cwd });
      child.on('error', () => {});
      child.unref();
    },
  };
}

export const realSpawner: DaemonSpawner = createSpawner(childSpawn);

export interface SpawnDeps {
  fs: Fs; spawner: DaemonSpawner; env: Readonly<Record<string, string | undefined>>; pluginRoot: string; dataDir: string; version: string;
  /** user.json env.passthrough (A1-10). */
  passthrough: readonly string[];
}

/** The caller's environment as strings (the M27 mutant's child environment). */
function wholeEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

/** Runs <dataDir>/runtime/<version>/daemon.js when that copy exists, else <pluginRoot>/dist/daemon.js, as `run --repo <root> --branch <b> --data-dir
 *  <dataDir> --plugin-root <pluginRoot> --spawned` (R5-19) under process.execPath, with exactly buildDaemonEnv(env, passthrough), in the working
 *  directory o.repoRoot (P5-T4-2). Resolves once the child is started (never waits for it). (P7 A5-4 name; Plan 7 calls it with these two arguments,
 *  X-66.) */
export async function spawnDaemon(o: { repoRoot: string; branch: string }, d: SpawnDeps): Promise<void> {
  const runtime = join(d.dataDir, 'runtime', d.version, 'daemon.js');
  const copy = await d.fs.stat(runtime).catch(() => null);
  const script = copy !== null && copy.isFile ? runtime : join(d.pluginRoot, 'dist', 'daemon.js');
  const env = (typeof __COWORK_TEST_BUILD__ === 'undefined' || __COWORK_TEST_BUILD__) && d.env['COWORK_TEST_MUTANT'] === ('M27' satisfies ClientMutantId) ? wholeEnv(d.env) : buildDaemonEnv({ ...d.env }, [...d.passthrough]);
  d.spawner.spawn([process.execPath, script, 'run', '--repo', o.repoRoot, '--branch', o.branch, '--data-dir', d.dataDir, '--plugin-root', d.pluginRoot, '--spawned'], env, o.repoRoot);
}

/** The bundles a runtime copy holds (glossary §6 runtime/<version>/: daemon.js, worker.js and the grammars). */
const COPIED = ['daemon.js', 'worker.js'] as const;

/** Copies <pluginRoot>/dist/{daemon.js, worker.js, grammars/*.wasm} into <dataDir>/runtime/<version>/ (SessionStart, within its deadline): first every
 *  runtime/.tmp-* an interrupted copy left is removed; an existing runtime/<version>/ is 'present' (nothing written); else the files go into
 *  runtime/.tmp-<version>-<16 hex of random.bytes(8)>/ (A4-9, P5-EC-6), which one rename makes runtime/<version>/ — a copy cut short leaves only a
 *  .tmp-* directory, never a partial runtime/<version>/. A missing daemon.js, worker.js or grammars/ directory, or any failed step, is 'failed' (the
 *  temp directory removed); a rename that loses to a concurrent copier is 'present'. */
export async function copyRuntime(pluginRoot: string, dataDir: string, version: string, fs: Fs, random: Random): Promise<'copied' | 'present' | 'failed'> {
  const runtime = join(dataDir, 'runtime');
  const target = join(runtime, version);
  const present = async (): Promise<boolean> => (await fs.stat(target).catch(() => null))?.isDirectory === true;
  let tmp: string | null = null;
  try {
    const names = await fs.readdir(runtime).catch((e: unknown) => {
      if (errnoCode(e) === 'ENOENT') return [] as string[];
      throw e;
    });
    for (const name of names) if (name.startsWith('.tmp-')) await fs.rmrf(join(runtime, name));
    if (await present()) return 'present';
    const dist = join(pluginRoot, 'dist');
    const wasm = (await fs.readdir(join(dist, 'grammars'))).filter((n) => n.endsWith('.wasm'));
    tmp = join(runtime, `.tmp-${version}-${randomHex(random, 8)}`);
    await fs.mkdirp(join(tmp, 'grammars'), 0o700);
    for (const name of COPIED) await fs.writeFile(join(tmp, name), await fs.readFile(join(dist, name)));
    for (const name of wasm) await fs.writeFile(join(tmp, 'grammars', name), await fs.readFile(join(dist, 'grammars', name)));
    try {
      await fs.rename(tmp, target);
    } catch (e) {
      if (await present()) return 'present';
      throw e;
    }
    tmp = null;
    return 'copied';
  } catch {
    return 'failed';
  } finally {
    if (tmp !== null) await fs.rmrf(tmp).catch(() => {});
  }
}

/** <gitdir>/HEAD read as a file (no git process, R5-19): `ref: refs/heads/<b>` → b; a detached HEAD, another ref or no file → null (the caller then
 *  spawns nothing; gating events take G4 until Plan 7's HEAD table decides). */
export async function headBranch(gitdir: string, fs: Fs): Promise<string | null> {
  try {
    const first = (await fs.readFile(join(gitdir, 'HEAD'))).toString('utf8').split(/\r?\n/)[0] ?? '';
    const m = /^ref: refs\/heads\/(.+)$/.exec(first.trimEnd());
    return m === null ? null : (m[1] as string);
  } catch {
    return null;
  }
}
