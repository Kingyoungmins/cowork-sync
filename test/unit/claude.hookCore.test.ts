// Plan 5 Task 4: core in process (06 §3.4.2 steps 1–5; R1-223, R1-301 sender half, R2-B12; A4-3) — runCore over a live loaderRepo with a recording CoreIo,
// the real Ipc and the real handshake on machineClock (Ruling P5-T3-1, P5-EC-3) against test/helpers/fakeDaemon.ts. A settled handshake leaves its
// 1.5 s deadline sleep referenced (P5-EC-3 (c)): run-tests may print an open-handles note for that Timeout.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { machineClock, runCore, type CoreDeps, type CoreEnv, type CoreIo } from '../../src/claude/client/hookCore.js';
import { encodeOutput } from '../../src/claude/client/output.js';
import { staticPolicyCheck } from '../../src/claude/client/policy.js';
import type { DaemonSpawner } from '../../src/claude/client/spawn.js';
import { HOOK_PROTO, type ReplyFrame } from '../../src/claude/wire/frames.js';
import { buildPayload, parseHookInput } from '../../src/claude/wire/hookInput.js';
import { canonicalJsonLine } from '../../src/claude/wire/ndjson.js';
import { canonRoot } from '../../src/data/canonRoot.js';
import { realFs, realRootProbe } from '../../src/ports/fs.js';
import { realIpc } from '../../src/ports/ipc.js';
import { realRandom } from '../../src/ports/random.js';
import { realWinAcl } from '../../src/sec/winAcl.js';
import { PLUGIN_VERSION } from '../../src/version.js';
import { fakeDaemon, type FakeDaemon } from '../helpers/fakeDaemon.js';
import { endpointOf, hookJson, liveRepoOf, loaderRepo, preToolJson, type LoaderRepo } from '../helpers/loaderRun.js';

const SETTINGS = fileURLToPath(new URL('../fixtures/settings/', import.meta.url));
let r: LoaderRepo;
let daemon: FakeDaemon;
const spawns: Array<readonly string[]> = [];
const spawner: DaemonSpawner = { spawn: (argv) => { spawns.push(argv); } };

before(async () => {
  r = await loaderRepo({ label: 'hook-core', live: true });
  daemon = await fakeDaemon(r.endpoint as string, r.key as Buffer);
});
after(async () => {
  await daemon?.close();
  await r?.cleanup();
});

const deps = (): CoreDeps => ({
  fs: realFs, ipc: realIpc, clock: machineClock, random: realRandom, spawner, acl: realWinAcl, uid: process.getuid?.() ?? null, probe: realRootProbe,
});
const coreEnv = (env: Record<string, string | undefined> = {}): CoreEnv => ({
  env, ppid: 4242, pluginRoot: join(r.base, 'plugin'), startNs: process.hrtime.bigint(), platform: process.platform, home: r.home, osLocale: null,
});

/** An in-memory CoreIo; flush resolves when `hold` does (default at once) and logs its start and end. */
function recordingIo(hold: Promise<void> = Promise.resolve()): CoreIo & { out: string; err: string; log: string[] } {
  const io = {
    out: '', err: '', log: [] as string[],
    stdout: (s: string) => { io.out += s; io.log.push('stdout'); },
    stderr: (s: string) => { io.err += s; io.log.push('stderr'); },
    flush: async () => { io.log.push('flush'); await hold; io.log.push('flushed'); },
  };
  return io;
}

test('runCore sends exactly one hook frame built by buildPayload and maps the reply through encodeOutput', async () => {
  const reply: Partial<ReplyFrame> = { batch_id: 'b-core', decision: 'context', text: 'T', system: 'S', events: ['e1'], cursor: 3 };
  daemon.reply(reply);
  const json = preToolJson('Edit', r.dir, { filePath: join(r.dir, 'src', 'a.ts') });
  const input = parseHookInput('PreToolUse', json);
  const repo = liveRepoOf(r);
  let release: () => void = () => {};
  const io = recordingIo(new Promise((res) => { release = res; }));
  const before = daemon.frames().length;
  const env = coreEnv();
  const running = runCore('PreToolUse', input, repo, null, env, io, deps());
  // While stdout and stderr are not flushed, no printed frame has gone out.
  for (let i = 0; i < 100 && !io.log.includes('flush'); i++) await new Promise((res) => setTimeout(res, 10));
  assert.ok(io.log.includes('flush'), 'the output was written and flushed');
  await new Promise((res) => setTimeout(res, 150));
  assert.deepEqual(daemon.printed().filter((b) => b === 'b-core'), [], 'printed waits for io.flush');
  release();
  const outcome = await running;
  for (let i = 0; i < 100 && !daemon.printed().includes('b-core'); i++) await new Promise((res) => setTimeout(res, 10));

  const frames = daemon.frames().slice(before);
  assert.deepEqual(frames.map((f) => f.frame['t']), ['hook', 'printed'], 'one hook frame, then printed on the same connection');
  assert.equal(frames[0]!.conn, frames[1]!.conn);
  assert.deepEqual(frames[1]!.frame, { t: 'printed', batch_id: 'b-core' });
  const hook = frames[0]!.frame as { event: string; h: Record<string, unknown>; payload: unknown };
  assert.equal(hook.event, 'PreToolUse');
  assert.deepEqual(hook.h, {
    seat_key: '4242', claude_pid: 4242, session_id: 'sess-1', prompt_id: 'p1', agent_id: null, agent_type: null, permission_mode: 'default',
    repo_root: repo.root, plugin_version: PLUGIN_VERSION, hook_proto: HOOK_PROTO,
  });
  const target = canonRoot(resolve(r.dir, 'src', 'a.ts'), realRootProbe, process.platform);
  assert.deepEqual(hook.payload, buildPayload(input, repo, { messaging_present: false, static_policy_hits: [], evidence: null, target }));
  const full: ReplyFrame = { t: 'reply', batch_id: 'b-core', decision: 'context', text: 'T', system: 'S', events: ['e1'], cursor: 3 };
  const want = encodeOutput('PreToolUse', full);
  assert.equal(io.out, want.stdout);
  assert.equal(io.err, want.stderr);
  assert.deepEqual(outcome, { exit: want.exit, evidenceDelivered: false });
  assert.deepEqual(io.log.slice(-2), ['flush', 'flushed']);
  assert.deepEqual(spawns, [], 'a fresh status.json: no spawn');
  daemon.reply({ decision: 'none' });
});

test('SessionStart carries static_policy_hits and messaging_present', async () => {
  mkdirSync(join(r.home, '.claude'), { recursive: true });
  mkdirSync(join(r.dir, '.claude'), { recursive: true });
  cpSync(join(SETTINGS, 'user', 'settings.json'), join(r.home, '.claude', 'settings.json'));
  cpSync(join(SETTINGS, 'project', 'settings.json'), join(r.dir, '.claude', 'settings.json'));
  cpSync(join(SETTINGS, 'project', 'settings.local.json'), join(r.dir, '.claude', 'settings.local.json'));
  const expected = await staticPolicyCheck(r.root, { fs: realFs, platform: process.platform, home: r.home, env: {} });
  assert.ok(expected.some((h) => h.scope === 'user') && expected.some((h) => h.scope === 'project') && expected.some((h) => h.scope === 'local'), 'the fixture\'s hits');
  for (const socket of [undefined, '/tmp/claude-sock-1']) {
    const before = daemon.frames().length;
    const env = coreEnv(socket === undefined ? {} : { CLAUDE_CODE_MESSAGING_SOCKET: socket });
    const io = recordingIo();
    const outcome = await runCore('SessionStart', parseHookInput('SessionStart', hookJson('SessionStart', r.dir)), liveRepoOf(r), null, env, io, deps());
    assert.equal(outcome.exit, 0);
    const hook = daemon.frames().slice(before).find((f) => f.frame['t'] === 'hook');
    const payload = hook?.frame['payload'] as { static_policy_hits: unknown; messaging_present: boolean };
    assert.deepEqual(payload.static_policy_hits, expected);
    assert.equal(payload.messaging_present, socket !== undefined);
  }
  // P5-T4-3: with CLAUDE_CONFIG_DIR set, the user layer is <CLAUDE_CONFIG_DIR>/settings.json (the host's user settings), not <home>/.claude's.
  const cfg = join(r.base, 'claude-config');
  mkdirSync(cfg, { recursive: true });
  cpSync(join(SETTINGS, 'user', 'settings.json'), join(cfg, 'settings.json'));
  const before = daemon.frames().length;
  const outcome = await runCore('SessionStart', parseHookInput('SessionStart', hookJson('SessionStart', r.dir)), liveRepoOf(r), null, coreEnv({ CLAUDE_CONFIG_DIR: cfg }), recordingIo(), deps());
  assert.equal(outcome.exit, 0);
  const payload = daemon.frames().slice(before).find((f) => f.frame['t'] === 'hook')?.frame['payload'] as { static_policy_hits: Array<{ scope: string; file: string }> };
  assert.deepEqual([...new Set(payload.static_policy_hits.filter((h) => h.scope === 'user').map((h) => h.file))], [join(cfg, 'settings.json')]);
});

test('a hook whose handshakes fail records SEC_IPC_HANDSHAKE_FAILED in <cowork>/tmp/handshake.jsonl for the daemon (P5SEC #36, SEC-22 client side)', async () => {
  const record = join(r.gitdir, 'cowork', 'tmp', 'handshake.jsonl');
  const lines = (): string[] => (existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter((l) => l !== '') : []);
  rmSync(record, { force: true });
  // A squatter on the hook's endpoint without the key (every connect is sent to it): each attempt fails the client's check of srv ('mac'); the
  // gating hook answers G4 at the deadline and leaves one line for the daemon's security log.
  const squatterKey = Buffer.alloc(32, 0x5a);
  const squatter = await fakeDaemon(await endpointOf(squatterKey, r.gitdir), squatterKey);   // another key: another endpoint name
  try {
    const toSquatter = { ...realIpc, connect: (_ep: string, ms: number) => realIpc.connect(squatter.endpoint, ms) };
    const json = preToolJson('Edit', r.dir, { filePath: join(r.dir, 'src', 'b.ts') });
    const io = recordingIo();
    const t0 = machineClock.monoMs();
    const outcome = await runCore('PreToolUse', parseHookInput('PreToolUse', json), liveRepoOf(r), null, coreEnv(), io, { ...deps(), ipc: toSquatter });
    assert.equal(outcome.exit, encodeOutput('PreToolUse', { g4: true, lang: 'en' }).exit, 'G4');
    const got = lines();
    assert.equal(got.length, 1, got.join('\n'));
    const rec = JSON.parse(got[0] as string) as Record<string, string | number>;
    assert.deepEqual(Object.keys(rec), ['code', 'count', 'mono_ms', 'side', 'why'], 'canonical key order');
    assert.equal(rec['code'], 'SEC_IPC_HANDSHAKE_FAILED');
    assert.equal(rec['side'], 'hook');
    assert.equal(rec['why'], 'mac');
    assert.ok(typeof rec['count'] === 'number' && rec['count'] >= 5 && rec['count'] <= squatter.connections(), `count ${String(rec['count'])} of ${squatter.connections()}`);
    assert.ok(typeof rec['mono_ms'] === 'number' && rec['mono_ms'] >= t0, 'on the machine clock (status.json\'s base)');
    assert.equal(got[0], canonicalJsonLine(rec), 'one canonical line');
  } finally {
    await squatter.close();
  }
  // A hook that authenticates, and one whose connects are refused (no daemon), add nothing: neither is a failed handshake.
  const n = lines().length;
  await runCore('Stop', parseHookInput('Stop', hookJson('Stop', r.dir)), liveRepoOf(r), null, coreEnv(), recordingIo(), deps());
  const refused = { ...realIpc, connect: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } };
  await runCore('PreToolUse', parseHookInput('PreToolUse', preToolJson('Edit', r.dir, { filePath: join(r.dir, 'src', 'c.ts') })), liveRepoOf(r), null, coreEnv(), recordingIo(),
    { ...deps(), ipc: refused });
  assert.equal(lines().length, n);
});
