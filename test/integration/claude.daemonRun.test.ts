// Plan 5 Task 5 phase 3b — `daemon.js run`'s A5-1 cells (plan 2750–2753; A5-1, R5-19, SEC-21, OQ-22 (r3), TC-CCI-16 core half).
// runDaemon runs in-process on the real ports against file:// bare remotes, exactly like daemon.cli.test.ts; git is never mocked.
// A spawned run prints nothing, so the assertions read exit codes, the security log, the daemon log and daemon.lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { DAEMON_USAGE, lockGatedLog, parseDaemonArgs, runDaemon, type DaemonArgs, type DaemonIo, type DaemonOptions } from '../../src/daemon/run.js';
import { IN_TREE_DAEMON } from '../helpers/regionDeps.js';
import type { ClaudeDaemon } from '../../src/claude/daemon/claudeDaemon.js';
import { DaemonLock, LOOP_IDLE_MS } from '../../src/engine/loop.js';
import { enc } from '../../src/git/enc.js';
import { realFs } from '../../src/ports/fs.js';
import type { Log } from '../../src/ports/log.js';
import { securityLogAsLog } from '../../src/sec/securityLog.js';
import { PLUGIN_VERSION } from '../../src/version.js';
import { QUIET_MS } from '../../src/engine/snapshot.js';
import { realIpc } from '../../src/ports/ipc.js';
import { realRandom } from '../../src/ports/random.js';
import { clientHandshake, type FrameCodec } from '../../src/sec/handshake.js';
import type { SecureConn } from '../../src/sec/handshake.js';
import { HOOK_PROTO } from '../../src/claude/wire/frames.js';
import type { SessionClientFrame, SessionServerFrame } from '../../src/claude/wire/frames.js';
import type { GitCallOptions } from '../../src/git/flags.js';
import type { GitRunner } from '../../src/git/runner.js';
import { encodeFrame, LineReader } from '../../src/claude/wire/ndjson.js';
import { validateFrame } from '../../src/claude/wire/schema.js';
import { endpointOf } from '../helpers/loaderRun.js';
import { setupLiveRepo } from '../helpers/liveRepo.js';
import { clonePeer, seedRemote, type PeerClone } from '../sim/peers.js';
import { createBareRemote, type BareRemote } from '../sim/remote.js';
import { makeTempRoot, testRunner } from '../helpers/tmp.js';
import { shortRead } from '../../src/claude/daemon/hookRead.js';
import { ABSENT } from '../../src/git/oid.js';
import type { StatusJson } from '../../src/engine/status.js';

const runner = testRunner();
const codec: FrameCodec = { reader: () => new LineReader(), encode: encodeFrame, validate: (d, v) => validateFrame('session', d, v) };
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** The shipped entry point (dist/daemon.js's source): it calls process.exit as soon as runDaemon resolves. */
const ENTRY = join(ROOT, 'src', 'entry', 'daemon.ts');
/**
 * A slow-fs fault for a child process (--import): every append to a file named security.jsonl waits 1,000 ms, then performs the
 * real append (realFs calls fs.promises.appendFile at call time, src/ports/fs.ts). The natural race between the security log's
 * queue and the entry's process.exit loses lines only sometimes (16 of 200 runs in the audit's probe), so a RED that usually
 * passes would prove nothing; with the delay, an exit path that does not await the security log's own queue always loses it.
 */
const SLOW_SECURITY_APPEND = 'data:text/javascript,' + encodeURIComponent([
  "import fs from 'node:fs';",
  'const real = fs.promises.appendFile;',
  'fs.promises.appendFile = async function (p, ...rest) {',
  "  if (String(p).endsWith('security.jsonl')) await new Promise((r) => setTimeout(r, 1000));",
  '  return real.call(this, p, ...rest);',
  '};',
].join('\n'));

function args(dir: string, over: Partial<DaemonArgs> = {}): DaemonArgs {
  return { cmd: 'run', repo: dir, branch: 'main', publish: null, name: 'Tester', remote: null, confirm: null, id: null, verb: null, dataDir: null, pluginRoot: null, spawned: false, ...over };
}
function resumeArgs(dir: string): DaemonArgs {
  return { cmd: 'resume', repo: dir, branch: 'main', publish: null, name: null, remote: null, confirm: null, id: null, verb: null, dataDir: null, pluginRoot: null, spawned: false };
}
function daemonEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) if (/^(https?_proxy|all_proxy|no_proxy|git_ssh_command|git_ssh|git_ssh_variant)$/i.test(k)) delete env[k];
  return env;
}
function ioOf(lines: string[]): DaemonIo {
  return { out: (l) => lines.push(l), err: (l) => lines.push(l), onStop: () => undefined };
}

/** Runs cmd.exe with one verbatim command line (fixed argv; the child exits on its own); /u makes its output UTF-16LE
 *  (claude.canonRoot.fs.test.ts's helper). */
function cmdLine(line: string): { status: number | null; out: string } {
  const r = spawnSync('cmd.exe', ['/u', '/d', '/s', '/c', `"${line}"`], { windowsVerbatimArguments: true, windowsHide: true });
  return { status: r.status, out: r.stdout.toString('utf16le').trim() };
}

/** The parsed lines of a JSON-lines file, read once (a missing file reads as no lines). */
function jsonl(path: string): Array<{ level: string; code: string; params: Record<string, unknown> }> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as { level: string; code: string; params: Record<string, unknown> });
}

/** node --import tsx [--import extra] <entry> <argv>, awaited asynchronously (this process keeps serving its own listeners). */
function runEntry(argv: readonly string[], imports: readonly string[], env: Record<string, string | undefined>, capMs: number): Promise<{ code: number | null; signal: string | null; out: string; err: string; killed: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', ...imports.flatMap((i) => ['--import', i]), ENTRY, ...argv],
      { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    let killed = false;
    child.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { err += d; });
    const cap = setTimeout(() => { killed = true; child.kill(); }, capMs);   // a runaway guard only
    child.on('error', (e) => { clearTimeout(cap); reject(e); });
    child.on('close', (code, signal) => { clearTimeout(cap); resolve({ code, signal, out, err, killed }); });
  });
}

async function statusIn(dir: string): Promise<StatusJson | null> {
  try {
    return JSON.parse(await readFile(join(dir, '.git', 'cowork', 'status.json'), 'utf8')) as StatusJson;
  } catch {
    return null;
  }
}

async function remoteWithClones(label: string, n: number): Promise<{ remote: BareRemote; clones: PeerClone[]; cleanup(): Promise<void> }> {
  const { root, cleanup } = await makeTempRoot(label);
  const remote = await createBareRemote(root, runner);
  await seedRemote(remote, root, runner, { 'README.md': Buffer.from('# daemonrun\n'), 'a.txt': Buffer.from('a\n') });
  const clones: PeerClone[] = [];
  for (let i = 0; i < n; i++) clones.push(await clonePeer(remote, root, { name: `c${i + 1}`, autocrlf: false, withFilter: false }, runner));
  await new Promise((r) => setTimeout(r, QUIET_MS + 200));   // the checkouts settle (START_PREVIEW would refuse a fresh one)
  return { remote, clones, cleanup };
}

/** A live repo with an IPC key, the plugin-root argument value, and the endpoint the loader-side derivation lands on. */
async function withRepo(c: PeerClone): Promise<{ dataDir: string; pluginRoot: string; key: Buffer; endpoint: string; coworkDir: string }> {
  const repo = await setupLiveRepo(c.dir);
  return { dataDir: repo.dataDir, pluginRoot: join(repo.dataDir, 'plugin-root'), key: repo.key!, endpoint: await endpointOf(repo.key!, repo.gitdir), coworkDir: repo.coworkDir };
}

/** Completion-based wait: polls cond (at most 250 ms apart) until it holds; fails naming `what` at the cap, and at once when the
 *  run has ended first (as waitOk does); `detail` (the run's printed lines, say) is appended to either failure. */
async function waitFor(what: string, cond: () => boolean | Promise<boolean>, ms: number, ended?: { why: string | null }, detail: () => string = () => ''): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    if (await cond()) return;
    if (ended !== undefined && ended.why !== null) assert.fail(`the daemon run ended (${ended.why}) before ${what}${detail()}`);
    if (Date.now() > until) assert.fail(`timed out after ${ms} ms waiting for ${what}${detail()}`);
    await delay(250);
  }
}

/** What a silent (spawned) run left behind, for a failure message: status.json's state and code, and the daemon log's codes. */
async function leftBehind(dir: string): Promise<string> {
  const s = await statusIn(dir);
  const codes = jsonl(join(dir, '.git', 'cowork', 'log', 'daemon-0.jsonl')).map((l) => l.code);
  return `status.json ${JSON.stringify(s === null ? null : { state: s.state, message_code: s.message_code, message_params: s.message_params })}; daemon log codes ${JSON.stringify(codes)}`;
}

/** Waits for status.json's `ok`; fails at once when the run ended first (its silence makes a bare timeout useless). */
async function waitOk(what: string, dir: string, ended: { why: string | null }, ms = 180_000): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    if ((await statusIn(dir))?.state === 'ok') return;
    if (ended.why !== null) assert.fail(`the daemon run ended (${ended.why}) before ${what} — ${await leftBehind(dir)}`);
    if (Date.now() > until) assert.fail(`timed out waiting for ${what} — ${await leftBehind(dir)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Starts the IPC daemon for one clone (usually spawned: true — the plugin's invocation); `ended` names the outcome once it
 *  finishes. `opts` defaults to the in-tree region binding; a cell that observes the ClaudeDaemon passes
 *  `{ ...IN_TREE_DAEMON, onClaudeDaemon }`. */
function startIpc(a: DaemonArgs, io: DaemonIo, opts: DaemonOptions = IN_TREE_DAEMON): { done: Promise<number>; ended: { why: string | null } } {
  const ended: { why: string | null } = { why: null };
  const done = runDaemon(a, daemonEnv(), io, opts);
  void done.then((code) => { ended.why = `exit ${code}`; }, (e: unknown) => { ended.why = `threw ${e instanceof Error ? e.message : String(e)}`; });
  return { done, ended };
}

/** One git command through the slot runner (seedRemote's `must`, verbatim), with the caller's extra GitCallOptions —
 *  the C6 verifier's attr.tree / stdin calls run through the same runner the seeds use. */
async function runGit(git: GitRunner, gitArgs: string[], cwd: string, extra: Partial<GitCallOptions> = {}): Promise<string> {
  const r = await git.run(gitArgs, { class: 'local', cwd, ...extra });
  if (r.code !== 0) throw new Error(`git ${gitArgs.join(' ')} failed (${r.code}): ${r.stderr.toString('utf8')}`);
  return r.stdout.toString('utf8');
}

/** The client hook frame C1 sends over the authenticated connection; `repoRoot` is the clone dir. */
function sessionStartHook(repoRoot: string, over: Partial<{ pluginVersion: string }> = {}): SessionClientFrame {
  return {
    t: 'hook', event: 'SessionStart',
    h: {
      seat_key: 'b'.repeat(64), claude_pid: 4242, session_id: 's-run', prompt_id: null, agent_id: null, agent_type: null,
      permission_mode: 'default', repo_root: repoRoot, plugin_version: over.pluginVersion ?? PLUGIN_VERSION, hook_proto: HOOK_PROTO,
    },
    payload: { event: 'SessionStart', source: 'startup', transcript_path: null, messaging_present: true, static_policy_hits: [] } as never,
  };
}

/** The client's side of an authenticated session: it sends client frames and receives server frames (SecureConn's one
 *  type parameter cannot say both directions, so the send half is retyped). */
type ClientConn = Omit<SecureConn<SessionServerFrame>, 'send'> & { send(f: SessionClientFrame): void };

/** Sends one client frame over an authenticated connection and resolves with the server frames that arrive within `ms`
 *  (the reply at the head); returns whatever arrived, so the caller's assertion names the miss. */
async function hookOnce(conn: ClientConn, frame: SessionClientFrame, ms: number): Promise<SessionServerFrame[]> {
  const frames: SessionServerFrame[] = [];
  conn.onFrame((f) => frames.push(f));
  conn.send(frame);
  const until = Date.now() + ms;
  for (;;) {
    if (frames.some((fr) => fr.t === 'reply') || Date.now() > until) return frames;
    await delay(100);
  }
}

test('the A5-1 flags parse with their usage rule; the usage text lists all three (X5-05, R5-19)', () => {
  const r = parseDaemonArgs(['run', '--repo', 'r', '--branch', 'main', '--data-dir', 'd', '--plugin-root', 'p', '--spawned']);
  assert.ok(!('usage' in r));
  assert.deepEqual(r, { cmd: 'run', repo: 'r', branch: 'main', publish: null, name: null, remote: null, confirm: null, id: null, verb: null, dataDir: 'd', pluginRoot: 'p', spawned: true });
  const plain = parseDaemonArgs(['run', '--repo', 'r', '--branch', 'main']);
  assert.ok(!('usage' in plain));
  assert.deepEqual([plain.dataDir, plain.pluginRoot, plain.spawned], [null, null, false]);
  const eq = parseDaemonArgs(['run', '--repo=r', '--branch=main', '--data-dir=dd', '--plugin-root=pp', '--spawned']);
  assert.ok(!('usage' in eq));
  assert.deepEqual([eq.dataDir, eq.pluginRoot, eq.spawned], ['dd', 'pp', true]);
  for (const argv of [['run', '--repo', 'r', '--branch', 'main', '--spawned'], ['run', '--repo', 'r', '--branch', 'main', '--plugin-root', 'p']]) {
    const u = parseDaemonArgs(argv);
    assert.ok('usage' in u);
    assert.equal(u.exitCode, 2);
    assert.match(u.usage, /--spawned and --plugin-root need --data-dir/);
  }
  const valued = parseDaemonArgs(['run', '--repo', 'r', '--branch', 'main', '--data-dir', 'd', '--spawned=1']);
  assert.ok('usage' in valued);
  assert.equal(valued.exitCode, 2);
  assert.match(valued.usage, /--spawned takes no value/);
  assert.match(DAEMON_USAGE, /--data-dir <p>\] \[--plugin-root <p>\] \[--spawned\]/);
});

test('run.ts gives the ClaudeDaemon a real Log, and the shipped entry passes no in-tree options (source pins)', () => {
  // A6-9: the ClaudeDaemon's codes reach the daemon log — run.ts hands it no nullLog (its log is lockGatedLog(daemon log)).
  assert.doesNotMatch(readFileSync(join(ROOT, 'src', 'daemon', 'run.ts'), 'utf8'), /\bnullLog\b/u, 'src/daemon/run.ts gives the ClaudeDaemon a real Log');
  // The shipped entry passes no DaemonOptions (no regionDeps, no onClaudeDaemon): exactly three arguments.
  assert.match(readFileSync(ENTRY, 'utf8'), /runDaemon\(parsed, process\.env, io\)/u, 'src/entry/daemon.ts calls runDaemon(parsed, process.env, io)');
});

test('lockGatedLog: lines written before open() land in the target only at open(), in order; after open() a write goes straight through; the 65th pre-open line is dropped (A6-9, R-26; F2 #94)', () => {
  const got: Array<[string, string, unknown]> = [];
  const target: Log = { write: (level, code, params) => { got.push([level, code, params ?? null]); } };
  const g = lockGatedLog(target);
  g.write('info', 'TEST_FIRST', { n: 1 });
  g.write('error', 'TEST_SECOND', { n: 2 });
  assert.deepEqual(got, [], 'nothing reaches the target before open()');
  g.open();
  assert.deepEqual(got, [['info', 'TEST_FIRST', { n: 1 }], ['error', 'TEST_SECOND', { n: 2 }]]);
  g.write('warn', 'TEST_THIRD', { n: 3 });
  assert.deepEqual(got.at(-1), ['warn', 'TEST_THIRD', { n: 3 }], 'after open() a write goes straight through');
  assert.equal(got.length, 3);
  const many: number[] = [];
  const capped = lockGatedLog({ write: (_l, _c, params) => { many.push(params?.['i'] as number); } });
  for (let i = 1; i <= 65; i++) capped.write('info', 'TEST_MANY', { i });
  capped.open();
  assert.deepEqual(many, Array.from({ length: 64 }, (_, k) => k + 1), 'at most 64 pre-open lines wait; the 65th is dropped');
  const never: string[] = [];
  lockGatedLog({ write: (_l, code) => { never.push(code); } }).write('info', 'TEST_NEVER', {});
  assert.deepEqual(never, [], 'a gate that never opens writes nothing');
});

test('a squatter pipe first: exit 1 SEC_REFUSE_IPC_SQUATTER, one notification on the daemon log, the security line, and no daemon.lock ever created (bind before lock, plan 2750–2751)', async () => {
  const f = await remoteWithClones('daemonrun-squatter', 1);
  let squatter: { close(): Promise<void> } | null = null;
  try {
    const c = f.clones[0]!;
    const r = await withRepo(c);
    squatter = await realIpc.listen(r.endpoint, (conn) => {
      void (async () => {
        try {
          const sc = await clientHandshake(conn, r.key, r.endpoint, realRandom, 2_000, codec);
          sc.send({ t: 'srv', n2: 'AA==', p: 'AA==' });            // the bogus holder (a shape failure for the daemon)
        } catch { /* the daemon hung up */ }
      })();
    });
    // The real entry in a child (process.exit right after runDaemon resolves, R5-19), with the slow security append above;
    // the squatter listener lives in this process, so the child is awaited asynchronously (never spawnSync).
    const env = daemonEnv();
    delete env['NODE_TEST_CONTEXT'];
    const res = await runEntry(['run', '--repo', c.dir, '--branch', 'main', '--data-dir', r.dataDir, '--plugin-root', r.pluginRoot, '--spawned'],
      [SLOW_SECURITY_APPEND], env, 300_000);
    assert.equal(res.killed, false, `the entry did not exit within 300 s:\n${res.out}\n${res.err}`);
    assert.equal(res.code, 1, `exit ${String(res.code)} signal ${String(res.signal)}:\n${res.out}\n${res.err}`);
    assert.equal(res.out, '');                                     // spawned: silent even in refusal
    assert.equal(res.err, '');
    assert.equal(existsSync(join(r.coworkDir, 'daemon.lock')), false);
    // Read once, right after the exit (no timer, no poll): every mirrored security line landed in security.jsonl too.
    const sec = jsonl(join(r.coworkDir, 'log', 'security.jsonl'));
    const dlog = jsonl(join(r.coworkDir, 'log', 'daemon-0.jsonl'));
    const mirrored = dlog.filter((l) => l.level === 'security').map((l) => l.code);
    assert.ok(mirrored.includes('SEC_REFUSE_IPC_SQUATTER'), JSON.stringify(dlog));
    assert.deepEqual(sec.map((l) => l.code), mirrored, 'security.jsonl holds every security line the daemon log mirrors, in order');
    assert.equal(sec.filter((l) => l.code === 'SEC_REFUSE_IPC_SQUATTER').length, 1);
    // Plan 2750's recordingNotifier().countOf('NT_SECURITY') === 1, in production's logNotifier form (run.ts binds it).
    assert.equal(dlog.filter((l) => l.params['cls'] === 'NT_SECURITY').length, 1, JSON.stringify(dlog));
  } finally {
    await squatter?.close();
    await f.cleanup();
  }
});

test('the IPC daemon serves, a second run reuses it (exit 0, the first lock byte for byte), resume refuses DAEMON_ALREADY_RUNNING, and a stop drains to down — all silent (plan 2750, 2753)', async () => {
  const f = await remoteWithClones('daemonrun-happy', 1);
  const stops: Array<() => void> = [];
  try {
    const c = f.clones[0]!;
    const r = await withRepo(c);
    const io: DaemonIo = { out: () => undefined, err: () => undefined, onStop: (cb) => stops.push(cb) };
    const run = startIpc(args(c.dir, { dataDir: r.dataDir, pluginRoot: r.pluginRoot, spawned: true }), io);
    const ended = run.ended;
    await waitOk('ok', c.dir, ended);
    const lockBefore = readFileSync(join(r.coworkDir, 'daemon.lock'), 'utf8');
    const second = await runDaemon(args(c.dir, { dataDir: r.dataDir, pluginRoot: r.pluginRoot, spawned: true }), daemonEnv(), ioOf([]), IN_TREE_DAEMON);
    assert.equal(second, 0);                                       // reuse: it answered our handshake as its client
    assert.equal(readFileSync(join(r.coworkDir, 'daemon.lock'), 'utf8'), lockBefore);   // byte for byte
    const resumeLines: string[] = [];
    const resumeCode = await runDaemon(resumeArgs(c.dir), daemonEnv(), ioOf(resumeLines), IN_TREE_DAEMON);
    assert.equal(resumeCode, 1);
    assert.match(resumeLines.join('\n'), /DAEMON_ALREADY_RUNNING/);
    for (const cb of stops) cb();
    assert.equal(await run.done, 0);
    assert.equal((await statusIn(c.dir))?.state, 'down');
  } finally {
    for (const cb of stops) cb();
    await f.cleanup();
  }
});

// TC-CCI-16 (plan 2752): clients deriving the endpoint from another spelling of the repo path — lower-cased (win32), the 8.3
// name, an NFD spelling, a junction (win32) or a symlinked parent (POSIX) — each through realRootProbe → endpointRoot →
// endpointName complete the handshake on the one endpoint, and a second run from a spelling that exists on disk reuses the
// daemon (exit 0, daemon.lock byte for byte): no second daemon binds. The spellings are built as claude.canonRoot.fs.test.ts
// builds them; the 64-byte echo half of plan 2755 is claude.server.test.ts's.
test('the endpoint is reachable from a differently-spelled repo path, and a client completes the handshake on it (TC-CCI-16 core half)', async (t) => {
  const f = await remoteWithClones('daemonrun-spelling', 1);
  const stops: Array<() => void> = [];
  let run: { done: Promise<number>; ended: { why: string | null } } | null = null;
  try {
    const c = f.clones[0]!;
    const r = await withRepo(c);
    const io: DaemonIo = { out: () => undefined, err: () => undefined, onStop: (cb) => stops.push(cb) };
    run = startIpc(args(c.dir, { dataDir: r.dataDir, pluginRoot: r.pluginRoot, spawned: true }), io);
    await waitOk('ok', c.dir, run.ended);
    const spellings: Array<[string, string]> = [];
    if (process.platform === 'win32') {
      spellings.push(['lower-case', c.dir.toLowerCase()]);
      const short = cmdLine(`for %I in ("${c.dir}") do @echo %~sI`);
      if (short.status === 0 && short.out.includes('~')) spellings.push(['8.3 short name', short.out]);
      else t.diagnostic(`8.3 spelling skipped: 8.3 name generation is off on this volume (cmd printed ${JSON.stringify(short.out)})`);
      const link = join(dirname(c.dir), 'junction to clone');
      const mk = cmdLine(`mklink /J "${link}" "${c.dir}"`);
      assert.equal(mk.status, 0, `mklink /J: ${mk.out}`);
      spellings.push(['junction', link]);
    } else {
      const link = join(dirname(dirname(c.dir)), 'symlinked parent');
      symlinkSync(dirname(c.dir), link, 'dir');
      spellings.push(['symlinked parent', join(link, basename(c.dir))]);
    }
    const nfd = c.dir.normalize('NFD');
    assert.notEqual(nfd, c.dir, 'the temp root holds characters that decompose (makeTempRoot\'s segment)');
    spellings.push(['NFD', nfd]);
    const lockBefore = readFileSync(join(r.coworkDir, 'daemon.lock'), 'utf8');
    for (const [name, spelled] of spellings) {
      const e2 = await endpointOf(r.key, join(spelled, '.git'));
      assert.equal(e2, r.endpoint, `${name}: the same endpoint`);
      const conn = await realIpc.connect(e2, 2_000);
      const sc = await clientHandshake(conn, r.key, e2, realRandom, 3_000, codec);
      sc.close();
      if (!existsSync(spelled)) {
        t.diagnostic(`${name}: the spelling does not exist on disk on this platform, so no second run starts from it`);
        continue;
      }
      const second = await runDaemon(args(spelled, { dataDir: r.dataDir, pluginRoot: r.pluginRoot, spawned: true }), daemonEnv(), ioOf([]), IN_TREE_DAEMON);
      assert.equal(second, 0, `${name}: a second run reuses the daemon`);
      assert.equal(readFileSync(join(r.coworkDir, 'daemon.lock'), 'utf8'), lockBefore, `${name}: daemon.lock unchanged byte for byte`);
    }
    for (const cb of stops) cb();
    assert.equal(await run.done, 0);
  } finally {
    for (const cb of stops) cb();
    if (run !== null) await Promise.race([run.done.catch(() => undefined), delay(60_000)]);
    await f.cleanup();
  }
});

test('one security Log per daemon: the region Log is the daemon\'s SecurityLog (checkLine, the daemon-log mirror), and the ClaudeDaemon logs to daemon-0.jsonl once daemon.lock is held (X-34, R4-52, R5-46, A6-9)', async (t) => {
  const f = await remoteWithClones('daemonrun-onelog', 1);
  const stops: Array<() => void> = [];
  let run: { done: Promise<number>; ended: { why: string | null } } | null = null;
  let obstruction: string | null = null;
  try {
    const c = f.clones[0]!;
    const r = await withRepo(c);
    const seen: { regionLog: Log | null; badThrew: unknown; cd: ClaudeDaemon | null } = { regionLog: null, badThrew: 'not called', cd: null };
    const io: DaemonIo = { out: () => undefined, err: () => undefined, onStop: (cb) => stops.push(cb) };
    run = startIpc(args(c.dir, { dataDir: r.dataDir, pluginRoot: r.pluginRoot, spawned: true }), io, {
      // The region binding receives the daemon's security Log: one good line, and one whose code is text (refused).
      regionDeps: async (o) => {
        seen.regionLog = o.securityLog;
        o.securityLog.write('security', 'TEST_REGION_LINE', { n: 1 });
        try {
          o.securityLog.write('security', 'bad code', {});
          seen.badThrew = null;
        } catch (e) {
          seen.badThrew = e;
        }
        return IN_TREE_DAEMON.regionDeps!(o);
      },
      onClaudeDaemon: (d) => {
        seen.cd = d;
        d.ctx.log.write('info', 'TEST_PRELOCK_LINE', { n: 1 });   // before listen(), so before daemon.lock (A6-9 / R-26: held, then replayed)
      },
    });
    await waitOk('ok', c.dir, run.ended);
    await waitFor('the attach', () => seen.cd?.ctx.engine !== undefined, 60_000, run.ended);
    const cd = seen.cd!;
    // A real signal through the production SignalPump that the engine rejects: a new seat's CS changes membership, so
    // Engine.signal awaits writeCsCache, and the cache's temp path is a directory (EISDIR, rethrown by writeCsCacheNow).
    obstruction = join(r.coworkDir, 'tmp', `cs-${enc('main')}.json.tmp`);
    mkdirSync(obstruction, { recursive: true });
    cd.ctx.signals.send({ kind: 'effect', seat: 'a'.repeat(32), agent: null, toolUseId: 'tu-c4', paths: ['a.txt'], turnOrigin: 'prompt' });
    // A bounded settle, never an assertion: the rejection lands on the engine's one queue; the directory goes as soon as its
    // line is in the daemon log (or at the cap), so no later loop iteration trips over it. The assertions read once after the exit.
    const dlogPath = join(r.coworkDir, 'log', 'daemon-0.jsonl');
    for (const until = Date.now() + 60_000; Date.now() < until && !jsonl(dlogPath).some((l) => l.code === 'CS_SIGNAL_REJECTED');) await delay(100);
    rmSync(obstruction, { recursive: true, force: true });
    obstruction = null;
    for (const cb of stops) cb();
    assert.equal(await run.done, 0);
    // Read once after the exit (runDaemon flushed both logs on its way out): no poll.
    const sec = jsonl(join(r.coworkDir, 'log', 'security.jsonl'));
    const dlog = jsonl(dlogPath);
    assert.equal(dlog.filter((l) => l.code === 'TEST_PRELOCK_LINE').length, 1, `the pre-lock ClaudeDaemon line is replayed once after the lock: ${JSON.stringify(dlog)}`);
    assert.ok(dlog.some((l) => l.code === 'CS_SIGNAL_REJECTED' && l.params['kind'] === 'effect'), `the rejected signal logs CS_SIGNAL_REJECTED (A6-4, A6-9): ${JSON.stringify(dlog)}`);
    assert.equal(dlog.filter((l) => l.level === 'security' && l.code === 'TEST_REGION_LINE').length, 1, `the region line is mirrored to the daemon log once: ${JSON.stringify(dlog)}`);
    assert.deepEqual(sec.filter((l) => l.code === 'TEST_REGION_LINE').map((l) => [l.level, l.params]), [['security', { n: 1 }]], JSON.stringify(sec));
    assert.equal(sec.some((l) => JSON.stringify(l).includes('bad code')), false, `checkLine refused the text code: ${JSON.stringify(sec)}`);
    assert.ok(seen.badThrew instanceof TypeError, `the text code threw TypeError (got ${String(seen.badThrew)})`);
    assert.ok(seen.cd !== null);
    assert.equal(seen.regionLog, securityLogAsLog(seen.cd.ctx.security), 'the region Log is the daemon\'s one SecurityLog');
    // SEC-38 (09-security.md:532): a daemon-log line holds only codes, ids, oids, repo-relative paths, line numbers, durations and
    // counts. Now that the ClaudeDaemon's lines reach daemon-0.jsonl (lockGatedLog), the rejection carries no free-text error
    // message: the EISDIR message names the temp file's absolute path (the OS user name in it), a GitCommandError's message git's
    // stderr. Last in the cell, so the halves above always run. It is the F2 #94 merge gate, landed: signals.ts's
    // logRejected and claudeDaemon.ts's errText write the errno code or the error's name (the two Code-edit requests);
    // Ruling r2-1's commit (the change's first commit on the branch) drops the `todo`.
    await t.test('SEC-38: a CS_SIGNAL_REJECTED line carries a code or a name, never a message (no absolute or clone path, no stderr)', () => {
      for (const l of dlog.filter((x) => x.code === 'CS_SIGNAL_REJECTED')) {
        for (const v of Object.values(l.params)) {
          if (typeof v !== 'string') continue;
          assert.doesNotMatch(v, /(?:^|[\s'"(])(?:[A-Za-z]:[\\/]|\/[^\s'"])/u, `SEC-38: no absolute path in a CS_SIGNAL_REJECTED param: ${JSON.stringify(l)}`);
          assert.equal(v.toLowerCase().includes(r.coworkDir.toLowerCase()) || v.toLowerCase().includes(c.dir.toLowerCase()), false, `SEC-38: no clone path in a CS_SIGNAL_REJECTED param: ${JSON.stringify(l)}`);
        }
        if ('error' in l.params) assert.match(String(l.params['error']), /^(?:[A-Z][A-Za-z0-9_]*|unknown)$/u, `SEC-38: the error param is an errno code or an Error name, no free text: ${JSON.stringify(l)}`);
      }
    });
  } finally {
    if (obstruction !== null) rmSync(obstruction, { recursive: true, force: true });
    for (const cb of stops) cb();
    if (run !== null) await Promise.race([run.done.catch(() => undefined), delay(60_000)]);
    await f.cleanup();
  }
});

test('a ClaudeDaemon log line written before daemon.lock never lands when the lock is refused (R-26)', async () => {
  const f = await remoteWithClones('daemonrun-prelock', 1);
  let planted: DaemonLock | null = null;
  try {
    const c = f.clones[0]!;
    const r = await withRepo(c);
    const held = await DaemonLock.acquire(realFs, r.coworkDir, { pluginVersion: PLUGIN_VERSION, instance: 'planted-second-daemon' });
    if (!(held instanceof DaemonLock)) assert.fail('the planted daemon.lock could not be taken');
    planted = held;
    const lines: string[] = [];
    const code = await runDaemon(args(c.dir, { dataDir: r.dataDir, pluginRoot: r.pluginRoot }), daemonEnv(), ioOf(lines),
      { ...IN_TREE_DAEMON, onClaudeDaemon: (d) => { d.ctx.log.write('info', 'TEST_PRELOCK_LINE', { n: 1 }); } });
    assert.equal(code, 1, lines.join('\n'));
    assert.match(lines.join('\n'), /DAEMON_ALREADY_RUNNING/);
    // Read at once (runDaemon flushed both logs before it returned).
    const dlog = jsonl(join(r.coworkDir, 'log', 'daemon-0.jsonl'));
    assert.equal(dlog.some((l) => l.code === 'TEST_PRELOCK_LINE'), false, `a refused lock drops the held ClaudeDaemon lines: ${JSON.stringify(dlog)}`);
  } finally {
    await planted?.release();
    await f.cleanup();
  }
});

test('after an in-process respawn the IPC daemon is attached to the new engine: its EngineView follows the live status and no false DAEMON_DOWN (A5-12, CCI-44)', { timeout: 25 * 60_000 }, async () => {
  // The cell's own cap sits above the sum of its bounded waits (600 + 60 + 180 + 180 + 60 + 150 s ≈ 1,230 s, plus the stop),
  // so a stall fails at the wait that stalled and names it, not at the runner's timeout (F2 #29; Ruling in the t5-run report).
  const f = await remoteWithClones('daemonrun-respawn', 1);
  const stops: Array<() => void> = [];
  let run: { done: Promise<number>; ended: { why: string | null } } | null = null;
  let obstruction: string | null = null;
  try {
    const c = f.clones[0]!;
    const r = await withRepo(c);
    const lines: string[] = [];
    const seen: { cd: ClaudeDaemon | null } = { cd: null };
    const io: DaemonIo = { out: (l) => lines.push(l), err: (l) => lines.push(l), onStop: (cb) => stops.push(cb) };
    // spawned: false, so the `started …` and `DAEMON_RESPAWN …` lines reach io.
    run = startIpc(args(c.dir, { dataDir: r.dataDir, pluginRoot: r.pluginRoot }), io, { ...IN_TREE_DAEMON, onClaudeDaemon: (d) => { seen.cd = d; } });
    const started = (): number => lines.filter((l) => l.startsWith('started ')).length;
    const printed = (): string => ` — the run printed:\n${lines.join('\n')}`;
    await waitFor('the first `started` line', () => started() >= 1, 600_000, run.ended, printed);
    await waitFor('the first attach', () => seen.cd?.ctx.engine !== undefined, 60_000, run.ended, printed);
    const cd = seen.cd!;
    // The crash: the CS cache's temp path is a directory, so the cache write after an iteration that committed state fails
    // with EISDIR, which writeCsCacheNow rethrows (an iteration-level obstruction of the real fs, not a mocked engine).
    obstruction = join(r.coworkDir, 'tmp', `cs-${enc('main')}.json.tmp`);
    mkdirSync(obstruction, { recursive: true });
    writeFileSync(join(c.dir, 'a.txt'), 'a\nchanged by the respawn cell\n');
    await waitFor('a DAEMON_RESPAWN line', () => lines.some((l) => l.startsWith('DAEMON_RESPAWN')), 180_000, run.ended, printed);
    rmSync(obstruction, { recursive: true, force: true });   // the respawn budget's sleep (2 s first) absorbs a late removal
    obstruction = null;
    await waitFor('the second `started` line', () => started() >= 2, 180_000, run.ended, printed);
    // The new engine's start wrote status.json; the dead engine writes nothing more.
    const h1 = (await statusIn(c.dir))?.heartbeat_mono_ms ?? Number.POSITIVE_INFINITY;
    await waitFor('the EngineView follows the new engine\'s status', () => (cd.ctx.engine.lastStatus()?.heartbeat_mono_ms ?? -1) >= h1, 60_000, run.ended, printed);
    // Three loop periods past the respawn: a seat never seen before is not told DAEMON_DOWN (the live engine's status reaches
    // Transitions). Completion-based (F2 t5-run r1): wait for a status the live engine wrote after the three-period mark, then
    // ask at once — on the dead engine's binding Transitions' current status stays the crash-time one, more than three periods
    // old by then, so a fresh seat is told DAEMON_DOWN; a live engine slowed by load only delays this wait.
    await waitFor('a status the live engine wrote three loop periods past the respawn', () => (cd.ctx.engine.lastStatus()?.heartbeat_mono_ms ?? -1) > h1 + 3 * LOOP_IDLE_MS, 3 * LOOP_IDLE_MS + 120_000, run.ended, printed);
    const items = cd.ctx.transitions.forSeat('d'.repeat(32));
    assert.equal(items.some((i) => JSON.stringify(i).includes('DAEMON_DOWN')), false, JSON.stringify(items));
    for (const cb of stops) cb();
    assert.equal(await run.done, 0, lines.join('\n'));
    assert.equal((await statusIn(c.dir))?.state, 'down');
  } finally {
    if (obstruction !== null) rmSync(obstruction, { recursive: true, force: true });
    for (const cb of stops) cb();
    if (run !== null) await Promise.race([run.done.catch(() => undefined), delay(60_000)]);
    await f.cleanup();
  }
});

test('run without --data-dir keeps Plan 2/3 behaviour: no data dir, no endpoint, resume refuses under the lock (OQ-22 r3, plan 2753)', async () => {
  const f = await remoteWithClones('daemonrun-plain', 1);
  const stops: Array<() => void> = [];
  try {
    const c = f.clones[0]!;
    const io: DaemonIo = { out: () => undefined, err: () => undefined, onStop: (cb) => stops.push(cb) };
    const ended: { why: string | null } = { why: null };
    const done = runDaemon(args(c.dir), daemonEnv(), io, IN_TREE_DAEMON);
    void done.then((code) => { ended.why = `exit ${code}`; }, (e: unknown) => { ended.why = `threw ${e instanceof Error ? e.message : String(e)}`; });
    await waitOk('ok', c.dir, ended);
    assert.equal(existsSync(`${c.dir}-data`), false);              // no data dir → no key → no endpoint was bound
    const resumeLines: string[] = [];
    const resumeCode = await runDaemon(resumeArgs(c.dir), daemonEnv(), ioOf(resumeLines), IN_TREE_DAEMON);
    assert.equal(resumeCode, 1);
    assert.match(resumeLines.join('\n'), /DAEMON_ALREADY_RUNNING/);
    for (const cb of stops) cb();
    assert.equal(await done, 0);
    assert.equal((await statusIn(c.dir))?.state, 'down');
  } finally {
    for (const cb of stops) cb();
    await f.cleanup();
  }
});

// CCI-52 / 06 §3.17.3 (plan 2729): a hook whose plugin_version is newer than the daemon's is served (one reply), then
// the daemon drains and the run ends — exit 0, daemon.lock released — and the next run binds again and serves the
// current version. The F2 #90 process half: run.ts's versionStop reaches io.onStop's requestStop (the t5-compose
// ClaudeDaemonDeps.requestStop field).
test('a newer caller\'s hook drains the IPC daemon and the run ends: daemon.lock released, the next run serves (CCI-52, 06 §3.17.3)', { timeout: 590_000 }, async () => {
  const f = await remoteWithClones('daemonrun-version', 1);
  const stops: Array<() => void> = [];
  try {
    const c = f.clones[0]!;
    const r = await withRepo(c);
    const io: DaemonIo = { out: () => undefined, err: () => undefined, onStop: (cb) => stops.push(cb) };
    const run = startIpc(args(c.dir, { dataDir: r.dataDir, pluginRoot: r.pluginRoot, spawned: true }), io);
    await waitOk('ok', c.dir, run.ended);
    const e2 = await endpointOf(r.key, join(c.dir, '.git'));
    const conn = await realIpc.connect(e2, 2_000);
    const sc = (await clientHandshake(conn, r.key, e2, realRandom, 3_000, codec)) as unknown as ClientConn;
    const frames = await hookOnce(sc, sessionStartHook(c.dir, { pluginVersion: '9.9.9' }), 120_000);
    assert.ok(frames.some((fr) => fr.t === 'reply'), `the newer caller's hook is served: ${JSON.stringify(frames)}`);
    sc.close();
    const code = await Promise.race([run.done, delay(180_000).then(() => null as number | null)]);
    assert.notEqual(code, null, `the version drain did not end the run within 180 s (daemon.lock still held) — status.json ${JSON.stringify(await statusIn(c.dir))}`);
    assert.equal(code, 0);
    assert.equal(existsSync(join(r.coworkDir, 'daemon.lock')), false, 'daemon.lock is released');
    assert.equal((await statusIn(c.dir))?.state, 'down');
    const second = startIpc(args(c.dir, { dataDir: r.dataDir, pluginRoot: r.pluginRoot, spawned: true }), io);
    await waitOk('ok after the version drain', c.dir, second.ended);
    const conn2 = await realIpc.connect(e2, 2_000);
    const sc2 = (await clientHandshake(conn2, r.key, e2, realRandom, 3_000, codec)) as unknown as ClientConn;
    const frames2 = await hookOnce(sc2, sessionStartHook(c.dir), 120_000);
    assert.ok(frames2.some((fr) => fr.t === 'reply'), `the current-version hook is served by the replacement daemon: ${JSON.stringify(frames2)}`);
    sc2.close();
    for (const cb of stops) cb();
    assert.equal(await second.done, 0);
  } finally {
    for (const cb of stops) cb();
    await f.cleanup();
  }
});

// F2 #50/#73 (DAT-13, plan 2955): the production hook-read hashes go through run.ts's own wiring — the daemon's GitRepo
// (attr.tree = EPOCH_BASE, the engine's discovered filters) — not the test harness's peer.core.repo. The code fix is
// t5-compose's binding at attach; this cell asserts the behaviour in production wiring, never argv (no spy runner, and
// DAEMON_ENV drops GIT_TRACE). Ruling (F2 #50): the cell asserts oid parity with attr.tree=<EPOCH_BASE> and the
// required filter's fail-closed, both through cd.ctx.reads.take.
test('the production hook-read hashes use the engine\'s attribute tree and required filters (run.ts wiring; DAT-13, plan 2955)', { timeout: 590_000 }, async () => {
  const f = await remoteWithClones('daemonrun-hookread', 1);
  const stops: Array<() => void> = [];
  let run: { done: Promise<number>; ended: { why: string | null } } | null = null;
  try {
    const c = f.clones[0]!;
    const r = await withRepo(c);
    const git = testRunner();
    // The committed .gitattributes names a filter the engine discovers (it reads EPOCH_BASE's .gitattributes blob) and
    // arms as required; the verifier configures the clean command but never filter.crypt.required.
    writeFileSync(join(c.dir, '.gitattributes'), '*.sec filter=crypt\n');
    await runGit(git, ['add', '.gitattributes'], c.dir);
    await runGit(git, ['commit', '-q', '-m', 'attrs', '--allow-empty'], c.dir, { identity: { name: 'T', email: 't@cowork.invalid' } });
    await runGit(git, ['push', '-q', 'origin', 'main'], c.dir);   // the run refuses START_HEAD_AHEAD when the clone is ahead
    const epochBase = (await runGit(git, ['rev-parse', 'HEAD'], c.dir)).trim();
    const seen: { cd: ClaudeDaemon | null } = { cd: null };
    const io: DaemonIo = { out: () => undefined, err: () => undefined, onStop: (cb) => stops.push(cb) };
    run = startIpc(args(c.dir, { dataDir: r.dataDir, pluginRoot: r.pluginRoot, spawned: true }), io, { ...IN_TREE_DAEMON, onClaudeDaemon: (d) => { seen.cd = d; } });
    await waitOk('ok', c.dir, run.ended);
    await waitFor('the attach', () => seen.cd?.ctx.engine !== undefined, 60_000, run.ended);
    const cd = seen.cd!;
    // Half 1 (F2 #50): an UNCOMMITTED worktree .gitattributes (the seeded EPOCH_BASE has none) — under the attr.tree
    // pin git reads the seeded tree, so CRLF is not normalized through the worktree attributes; without the pin
    // (pre-merge) git reads the worktree attributes and the oid differs.
    writeFileSync(join(c.dir, '.gitattributes'), '*.txt text eol=crlf\n');
    const bytes = Buffer.from('a\r\nb\r\n', 'utf8');
    writeFileSync(join(c.dir, 'x.txt'), bytes);
    const snap = await cd.ctx.reads.take('x.txt', await shortRead(realFs, join(c.dir, 'x.txt')));
    const expected = (await runGit(git, ['hash-object', '--stdin', '--path=x.txt'], c.dir, { attrTree: epochBase, stdin: bytes })).trim();
    assert.equal(snap.oid, expected, 'the hook-read oid matches hash-object under attr.tree=<EPOCH_BASE>');
    await cd.ctx.reads.release(snap);
    // Half 2 (F2 #73): the engine armed the committed filter as required — a failing clean fails closed (the snapshot
    // oid is ABSENT); the verifier's own hash-object is not required, so this pin is the daemon's alone.
    await runGit(git, ['config', 'filter.crypt.clean', 'node -e "process.exit(1)"'], c.dir);
    writeFileSync(join(c.dir, 's.sec'), 'k=REAL\n');
    const snap2 = await cd.ctx.reads.take('s.sec', await shortRead(realFs, join(c.dir, 's.sec')));
    assert.equal(snap2.oid, ABSENT, 'the required filter\'s failing clean fails closed: the snapshot oid is ABSENT');
    await cd.ctx.reads.release(snap2);
    for (const cb of stops) cb();
    assert.equal(await run.done, 0);
  } finally {
    for (const cb of stops) cb();
    if (run !== null) await Promise.race([run.done.catch(() => undefined), delay(60_000)]);
    await f.cleanup();
  }
});
