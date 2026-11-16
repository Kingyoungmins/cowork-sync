// test/helpers/loaderRun.ts — Plan 5 Task 4 (contract §"Test helpers"): the bundled loader in a child process and the temp repos it runs against.
//   buildDist(dir): the test form of dist/ (node tools/build/build.mjs --outdir <dir>/dist) with <dir>/package.json {"type": "module"} beside it
//     (the plugin root's module type, A2-4), so <dist>/.. is a plugin root as the loader derives it;
//   runLoader(event, json, {cwd, env, dist}): `node <dist>/hook.js <Event>` with the JSON on stdin → {exit, stdout, stderr, elapsedMs}; it resolves on
//     the child's 'close' (every stdio pipe closed), so a loader that left a child holding its stdout would show as a late close;
//   loaderRepo(o): a `git init` repo under makeTempRoot() with an optional live/paused marker in canonical form, a plugin data directory with createIpcKey
//     (and, on win32, the A3-6 ACL stamp, so a hook never waits for whoami/Get-Acl), a temp home, and the endpoint a fakeDaemon listens on. P5-EC-9:
//     a live repo gets a fresh status.json (heartbeat now, loop period 10 min), so no hook in these tests spawns a real daemon.
// The child's environment is this process's minus every CLAUDE_* / COWORK_* variable and the messaging token (this machine's tests may run inside a
// Claude Code session), plus the repo's variables, plus the call's.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOKEN_ENV } from '../../src/claude/client/mcp/doorbell.js';
import { canonRoot, endpointRoot, type LiveRepo } from '../../src/data/canonRoot.js';
import { machineMonoMs } from '../../src/ports/clock.js';
import { realFs, realRootProbe } from '../../src/ports/fs.js';
import { realRandom } from '../../src/ports/random.js';
import { endpointName, socketDir } from '../../src/sec/endpoint.js';
import { createIpcKey, type KeyDeps } from '../../src/sec/ipcKey.js';
import { realWinAcl } from '../../src/sec/winAcl.js';
import { makeTempRoot, testRunner } from './tmp.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const PLATFORM = process.platform;

export type Env = Record<string, string | undefined>;

/** The test form of dist/ in <dir>/dist, with <dir>/package.json {"type": "module"}; returns <dir>/dist. */
export function buildDist(dir: string): string {
  const dist = join(dir, 'dist');
  mkdirSync(dir, { recursive: true });
  const r = spawnSync(process.execPath, [join(REPO, 'tools', 'build', 'build.mjs'), '--outdir', dist], { cwd: REPO, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`build failed (${String(r.status)}):\n${r.stdout}\n${r.stderr}`);
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  return dist;
}

/** A copy of a built plugin root (<dir>/dist and <dir>/package.json) under `to`; returns <to>/dist. Fault cells change files of the copy. */
export function copyDist(dist: string, to: string): string {
  cpSync(join(dist, '..'), to, { recursive: true });
  return join(to, 'dist');
}

/** This process's environment without CLAUDE_* / COWORK_* variables and the messaging token, then `extra` (undefined deletes). */
export function childEnv(extra: Env = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(?:CLAUDE|COWORK_)/i.test(k) || k.toUpperCase() === TOKEN_ENV) continue;
    out[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}

export interface LoaderResult {
  exit: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string;
  /** Spawn to the child's 'exit'. */
  elapsedMs: number;
  /** machineMonoMs() at the child's 'exit' (fakeDaemon timestamps use the same clock). */
  exitMono: number;
  /** 'exit' to 'close' (all stdio pipes closed). */
  closeAfterExitMs: number;
}

/** `node <dist>/hook.js <event>` with `json` (or the raw `stdin` text) on stdin. */
export function runLoader(event: string, json: unknown, o: { dist: string; cwd?: string; env?: Env; stdin?: string; args?: readonly string[] }): Promise<LoaderResult> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, [join(o.dist, 'hook.js'), ...(o.args ?? [event])], {
      cwd: o.cwd ?? o.dist, env: childEnv(o.env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.stdin.on('error', () => {});
    let exitAt = 0;
    let exitMono = 0;
    child.once('exit', () => {
      exitAt = performance.now();
      exitMono = machineMonoMs();
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      const closeAt = performance.now();
      resolve({
        exit: code, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'),
        elapsedMs: (exitAt || closeAt) - t0, exitMono: exitMono || machineMonoMs(), closeAfterExitMs: closeAt - (exitAt || closeAt),
      });
    });
    child.stdin.end(o.stdin ?? JSON.stringify(json));
  });
}

/** Runs `f` over `items` with at most `n` at once, keeping the order of the results. */
export async function pooled<T, R>(items: readonly T[], n: number, f: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) results[i] = await f(items[i] as T, i);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return results;
}

export interface StatusFile { heartbeat_mono_ms: number; loop_period_ms: number; state: string }

export interface LoaderRepo {
  /** The makeTempRoot root holding everything below (a space and Hangul in its path). */
  base: string;
  /** The work tree (realpath, native separators). */
  dir: string;
  /** canonRoot(dir): what the live marker names and what h.repo_root carries. */
  root: string;
  /** <dir>/.git (native separators). */
  gitdir: string;
  dataDir: string;
  home: string;
  key: Buffer | null;
  /** The endpoint a fakeDaemon for this repo listens on (null without a key). */
  endpoint: string | null;
  /** CLAUDE_PLUGIN_DATA, USERPROFILE and HOME for runLoader. */
  env: Record<string, string>;
  keyDeps: KeyDeps;
  setLive(on: boolean): void;
  setPaused(on: boolean): void;
  setLanguage(lang: string | null): void;
  /** 'fresh': heartbeat now, loop period 10 min; 'missing': no file; or the exact fields. */
  setStatus(s: 'fresh' | 'missing' | StatusFile): void;
  cleanup(): Promise<void>;
}

const SOCK_NAME = `${'0'.repeat(24)}.sock`;

export const FRESH_LOOP_PERIOD_MS = 600_000;

/** The endpoint of the clone whose common gitdir is `gitdir`, under `key`, on this OS (POSIX: in the verified socket directory). */
export async function endpointOf(key: Buffer, gitdir: string, env: Env = process.env): Promise<string> {
  const root = endpointRoot(gitdir, realRootProbe, PLATFORM);
  if (PLATFORM === 'win32') return endpointName(key, root, PLATFORM, null);
  const dir = await socketDir(env, process.getuid?.() ?? -1, realFs, SOCK_NAME);
  if (!dir.ok) throw new Error('no socket directory');
  return endpointName(key, root, PLATFORM, dir.dir);
}

export async function loaderRepo(o: {
  label: string; live?: boolean; paused?: boolean; language?: string | null; key?: boolean; status?: 'fresh' | 'missing' | StatusFile;
  /** A folder (relative to the temp root) the work tree is created in: <root>/<under>/repo instead of <root>/repo. */
  under?: string;
}): Promise<LoaderRepo> {
  const tmp = await makeTempRoot(o.label);
  const dir = o.under === undefined ? join(tmp.root, 'repo') : join(tmp.root, o.under, 'repo');
  mkdirSync(dir, { recursive: true });
  const init = await testRunner().run(['init', '-q', '-b', 'main', dir], { class: 'local', cwd: tmp.root });
  if (init.code !== 0) throw new Error(`git init failed: ${init.stderr.toString('utf8')}`);
  const real = realpathSync.native(dir);
  const gitdir = join(real, '.git');
  const dataDir = join(tmp.root, 'plugin-data');
  const home = join(tmp.root, 'home');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(gitdir, 'cowork'), { recursive: true });
  const keyDeps: KeyDeps = { fs: realFs, random: realRandom, platform: PLATFORM, uid: process.getuid?.() ?? null, acl: realWinAcl };
  let key: Buffer | null = null;
  if (o.key !== false) {
    key = await createIpcKey(dataDir, keyDeps);   // win32: it also writes the stamp the hooks' {stamp: 'use'} read accepts (P5SEC #35)
  } else {
    mkdirSync(dataDir, { recursive: true });
  }
  const root = canonRoot(real, realRootProbe, PLATFORM);
  const r: LoaderRepo = {
    base: tmp.root, dir: real, root, gitdir, dataDir, home, key,
    endpoint: key === null ? null : await endpointOf(key, gitdir),
    env: { CLAUDE_PLUGIN_DATA: dataDir, USERPROFILE: home, HOME: home },
    keyDeps,
    setLive(on) {
      const p = join(gitdir, 'cowork', 'live');
      if (on) writeFileSync(p, `${root}\n`);
      else rmSync(p, { force: true });
    },
    setPaused(on) {
      const p = join(gitdir, 'cowork', 'paused');
      if (on) writeFileSync(p, '');
      else rmSync(p, { force: true });
    },
    setLanguage(lang) {
      mkdirSync(dataDir, { recursive: true });
      const p = join(dataDir, 'user.json');
      if (lang === null) rmSync(p, { force: true });
      else writeFileSync(p, `${JSON.stringify({ language: lang })}\n`);
    },
    setStatus(s) {
      const p = join(gitdir, 'cowork', 'status.json');
      if (s === 'missing') {
        rmSync(p, { force: true });
        return;
      }
      const v: StatusFile = s === 'fresh' ? { heartbeat_mono_ms: machineMonoMs(), loop_period_ms: FRESH_LOOP_PERIOD_MS, state: 'ok' } : s;
      writeFileSync(p, `${JSON.stringify(v)}\n`);
    },
    cleanup: tmp.cleanup,
  };
  // Every test pins the loader's language: without user.json the OS locale decides (this PC's is ko-KR).
  r.setLanguage(o.language === undefined ? 'en' : o.language);
  if (o.live === true) r.setLive(true);
  if (o.paused === true) r.setPaused(true);
  r.setStatus(o.status ?? (o.live === true ? 'fresh' : 'missing'));
  return r;
}

/** A hook input for `event` in `cwd` (06 §3.4.3 fields, the shapes of test/fixtures/hooks/*.json); `extra` overrides. */
export function hookJson(event: string, cwd: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = { session_id: 'sess-1', transcript_path: join(cwd, 't.jsonl'), cwd, hook_event_name: event, permission_mode: 'default', prompt_id: 'p1' };
  const byEvent: Record<string, Record<string, unknown>> = {
    SessionStart: { source: 'startup' },
    UserPromptSubmit: { prompt: 'please fix the failing test' },
    UserPromptExpansion: { prompt: '/cowork status', expansion_type: 'slash_command', command_name: 'cowork', command_args: 'status', command_source: 'plugin' },
    PostToolUse: { tool_name: 'Bash', tool_use_id: 'toolu_post', tool_input: { command: 'ls' }, tool_response: { stdout: '' } },
    PostToolUseFailure: { tool_name: 'Bash', tool_use_id: 'toolu_fail', tool_input: { command: 'false' }, error: 'exit 1' },
    PostToolBatch: { tool_use_ids: ['toolu_post'] },
    PermissionDenied: { tool_name: 'Write', tool_use_id: 'toolu_denied', tool_input: { file_path: join(cwd, 'x.ts'), content: 'x' } },
    Stop: { stop_hook_active: false, last_assistant_message: 'Done.', background_tasks_running: 0 },
    StopFailure: { reason: 'api_error' },
    SubagentStart: { agent_id: 'agent-1', agent_type: 'Explore' },
    SubagentStop: { agent_id: 'agent-1', agent_type: 'Explore', stop_hook_active: false, last_assistant_message: 'Found it.' },
    SessionEnd: { reason: 'clear' },
    Notification: { message: 'Claude needs your permission', notification_type: 'permission_prompt' },
  };
  return { ...base, ...(byEvent[event] ?? {}), ...extra };
}

/** A PreToolUse input for `tool` (an edit-class tool edits <cwd>/src/a.ts unless `filePath` is given). */
export function preToolJson(tool: string, cwd: string, o: { filePath?: string; input?: Record<string, unknown> } = {}): Record<string, unknown> {
  const file = o.filePath ?? join(cwd, 'src', 'a.ts');
  const inputs: Record<string, Record<string, unknown>> = {
    Edit: { file_path: file, old_string: 'a', new_string: 'b' },
    Write: { file_path: file, content: 'x' },
    MultiEdit: { file_path: file, edits: [{ old_string: 'a', new_string: 'b' }] },
    NotebookEdit: { notebook_path: file, new_source: 'x' },
    Bash: { command: 'npm test', run_in_background: false },
    PowerShell: { command: 'Get-ChildItem' },
    Monitor: { command: 'tail -f log' },
    Agent: { subagent_type: 'reviewer', prompt: 'review' },
    EnterWorktree: {},
  };
  return hookJson('PreToolUse', cwd, { tool_name: tool, tool_use_id: `toolu_${tool}`, tool_input: o.input ?? inputs[tool] ?? {} });
}

/** The 14 events (glossary §13 order) and the 9 PreToolUse tools of the three matchers. */
export const EVENTS = ['SessionStart', 'UserPromptSubmit', 'UserPromptExpansion', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch', 'Stop',
  'StopFailure', 'SubagentStart', 'SubagentStop', 'SessionEnd', 'PermissionDenied', 'Notification'] as const;
export const GATING_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell', 'Monitor', 'Agent', 'EnterWorktree'] as const;

/** The LiveRepo core's main builds for this repo (06 §3.4.2; A4-3): canonical root and gitdir, <gitdir>/cowork, the data directory, the endpoint root. */
export function liveRepoOf(r: LoaderRepo): LiveRepo {
  const gitdir = canonRoot(r.gitdir, realRootProbe, PLATFORM);
  return { root: r.root, gitdir, coworkDir: join(gitdir, 'cowork'), dataDir: r.dataDir, endpointRoot: endpointRoot(gitdir, realRootProbe, PLATFORM) };
}
