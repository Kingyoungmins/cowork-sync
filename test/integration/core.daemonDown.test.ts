// Plan 5 Task 4: daemon down, spawn and DAEMON_DOWN (R1-221, R1-224, C15, CCI-51 hook path; A4-6, A4-8, R5-19; 06 §6 row "Daemon not running / crashed /
// hung"). In-process runCore over a live loaderRepo with nothing listening, a recording spawner (P5-EC-9: no process starts) and an in-memory CoreIo.
// The clock is a VirtualClock started at machineMonoMs() (status.json heartbeats are machine-wide ms): its sleep walks the 50 ms retry grid to the
// deadline at once, and no handshake ever starts (nothing listens), so the stock VirtualClock is admissible here (P5-EC-3). Seats S1…S4 are the
// CLAUDE_CODE_MESSAGING_SOCKET values s1…s4: seat key sha256hex('sN'), seen file seen-<sha256hex('sN')[0:8]>.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCore, type CoreDeps, type CoreEnv, type CoreIo } from '../../src/claude/client/hookCore.js';
import type { DaemonSpawner } from '../../src/claude/client/spawn.js';
import { LOADER_TEXTS } from '../../src/claude/text/claudeText.js';
import type { HookEvent } from '../../src/claude/wire/frames.js';
import { parseHookInput } from '../../src/claude/wire/hookInput.js';
import { machineMonoMs } from '../../src/ports/clock.js';
import { realFs, realRootProbe } from '../../src/ports/fs.js';
import { realIpc, type Ipc } from '../../src/ports/ipc.js';
import { realRandom } from '../../src/ports/random.js';
import { realWinAcl } from '../../src/sec/winAcl.js';
import { VirtualClock } from '../sim/vclock.js';
import { hookJson, liveRepoOf, loaderRepo, preToolJson, type LoaderRepo } from '../helpers/loaderRun.js';

const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const G4 = LOADER_TEXTS.G4.en;
let r: LoaderRepo;
before(async () => {
  r = await loaderRepo({ label: 'core-down', live: true, status: 'missing' });
});
after(() => r?.cleanup());

interface Run { exit: number; out: string; err: string; log: string[]; cwds: string[] }

/** One runCore of `event` for the seat whose socket variable is `socket` (undefined: the pid seat 4242). */
async function hook(event: HookEvent, json: Record<string, unknown>, socket: string | undefined): Promise<Run> {
  const log: string[] = [];
  const cwds: string[] = [];
  const spawner: DaemonSpawner = { spawn: (_argv, _env, cwd) => { log.push('spawn'); cwds.push(cwd); } };
  const ipc: Ipc = { ...realIpc, connect: (ep, ms) => { log.push('connect'); return realIpc.connect(ep, ms); } };
  const clock = new VirtualClock({ startMono: machineMonoMs() });
  const io: CoreIo & { out: string; err: string } = { out: '', err: '', stdout(s) { io.out += s; }, stderr(s) { io.err += s; }, flush: async () => {} };
  const deps: CoreDeps = { fs: realFs, ipc, clock, random: realRandom, spawner, acl: realWinAcl, uid: process.getuid?.() ?? null, probe: realRootProbe };
  const env: CoreEnv = {
    env: socket === undefined ? {} : { CLAUDE_CODE_MESSAGING_SOCKET: socket }, ppid: 4242, pluginRoot: join(r.base, 'plugin'),
    startNs: BigInt(Math.round(clock.monoMs() * 1e6)), platform: process.platform, home: r.home, osLocale: null,
  };
  const outcome = await runCore(event, parseHookInput(event, json), liveRepoOf(r), null, env, io, deps);
  return { exit: outcome.exit, out: io.out, err: io.err, log, cwds };
}

const status = (heartbeat: number, loop = 2_500): void => r.setStatus({ heartbeat_mono_ms: heartbeat, loop_period_ms: loop, state: 'ok' });
const seenFile = (seatKey: string): string => join(r.gitdir, 'cowork', 'tmp', `seen-${(/^[0-9a-f]{64}$/.test(seatKey) ? seatKey : sha256hex(seatKey)).slice(0, 8)}`);
const notice = (event: string, system: boolean): string =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: G4 }, ...(system ? { systemMessage: G4 } : {}) });

test('status.json liveness: a heartbeat older than 3 loop periods or a missing file spawns the daemon once', async () => {
  const edit = preToolJson('Edit', r.dir);
  r.setStatus('missing');
  const absent = await hook('PreToolUse', edit, 's0');
  assert.equal(absent.log.filter((l) => l === 'spawn').length, 1, 'status.json absent: one spawn');
  assert.equal(absent.log[0], 'spawn', 'the spawn comes before the first connect attempt');
  assert.ok(absent.log.filter((l) => l === 'connect').length >= 10, 'retries continue (50 ms grid to the deadline) with no second spawn');
  assert.equal(absent.exit, 2);
  assert.equal(absent.err, G4);

  status(machineMonoMs() - 1_000);
  const fresh = await hook('PreToolUse', edit, 's0');
  assert.equal(fresh.log.filter((l) => l === 'spawn').length, 0, 'a heartbeat 1 s old (< 3 × 2.5 s): no spawn');
  assert.ok(fresh.log.includes('connect'));

  status(machineMonoMs() - 7_501);
  const stale = await hook('PreToolUse', edit, 's0');
  assert.equal(stale.log.filter((l) => l === 'spawn').length, 1, '7.501 s old: one spawn');
  assert.equal(stale.log[0], 'spawn');
});

test('the spawned daemon starts in the repo it serves: an Edit in this repo from a session whose cwd is elsewhere spawns with cwd = its root (P5-T4-2)', async () => {
  r.setStatus('missing');
  const elsewhere = join(r.base, 'elsewhere');
  const fromElsewhere = await hook('PreToolUse', preToolJson('Edit', elsewhere, { filePath: join(r.dir, 'src', 'a.ts') }), 's0');
  assert.deepEqual(fromElsewhere.cwds, [r.root], 'cwd = the served repo\'s root, not the session\'s cwd');
  const session = await hook('SessionStart', hookJson('SessionStart', elsewhere), 's9');
  assert.deepEqual(session.cwds, [r.root], 'the same for a non-gating event');
});

test('a detached HEAD spawns nothing and gating events take G4', async () => {
  const headPath = join(r.gitdir, 'HEAD');
  const head = readFileSync(headPath, 'utf8');
  writeFileSync(headPath, `${'0123456789abcdef0123456789abcdef01234567'}\n`);
  try {
    status(12_345);
    rmSync(join(r.gitdir, 'cowork', 'tmp'), { recursive: true, force: true });
    const edit = await hook('PreToolUse', preToolJson('Edit', r.dir), 'd1');
    assert.deepEqual(edit.log, [], '0 spawns and no connect attempt: G4 at once');
    assert.equal(edit.exit, 2);
    assert.equal(edit.err, G4);
    const start = await hook('SessionStart', hookJson('SessionStart', r.dir), 'd1');
    assert.deepEqual(start.log, []);
    assert.equal(start.exit, 0);
    assert.equal(start.out, notice('SessionStart', true), 'A4-6\'s notice');
  } finally {
    writeFileSync(headPath, head);
  }
});

test('DAEMON_DOWN once per seat after the daemon became unreachable (seen-<8 hex> file)', async () => {
  rmSync(join(r.gitdir, 'cowork', 'tmp'), { recursive: true, force: true });
  status(12_345);
  const s1 = await hook('SessionStart', hookJson('SessionStart', r.dir), 's1');
  assert.equal(s1.exit, 0);
  assert.equal(s1.out, notice('SessionStart', true));
  assert.equal(s1.err, '');
  assert.equal(readFileSync(seenFile(sha256hex('s1')), 'utf8'), '12345', 'the seen file holds the outage episode id');
  const again = await hook('UserPromptSubmit', hookJson('UserPromptSubmit', r.dir), 's1');
  assert.deepEqual([again.exit, again.out, again.err], [0, '', ''], 'S1\'s next hook: nothing');

  const s2 = await hook('SessionStart', hookJson('SessionStart', r.dir), 's2');
  assert.equal(s2.out, notice('SessionStart', true), 'seat S2 gets it once');
  assert.equal((await hook('UserPromptSubmit', hookJson('UserPromptSubmit', r.dir), 's2')).out, '');

  const n3 = await hook('Notification', hookJson('Notification', r.dir), 's3');
  assert.deepEqual([n3.exit, n3.out, n3.err], [0, '', ''], 'Notification cannot carry text');
  assert.ok(!existsSync(seenFile(sha256hex('s3'))), 'the notice stays pending: no seen file');
  const p3 = await hook('PostToolUse', hookJson('PostToolUse', r.dir), 's3');
  assert.equal(p3.out, notice('PostToolUse', true), 'S3\'s PostToolUse carries it');

  const f4 = await hook('PostToolUseFailure', hookJson('PostToolUseFailure', r.dir), 's4');
  assert.equal(f4.out, notice('PostToolUseFailure', false), 'additionalContext only, no systemMessage');

  const g = await hook('PreToolUse', preToolJson('Bash', r.dir), 's1');
  assert.equal(g.exit, 2, 'a gating event takes G4, never the notice');
  assert.equal(g.out, '');

  status(99_999);
  const back = await hook('UserPromptSubmit', hookJson('UserPromptSubmit', r.dir), 's1');
  assert.equal(back.out, notice('UserPromptSubmit', true), 'a new outage episode: S1 gets it once more');
  assert.equal(readFileSync(seenFile(sha256hex('s1')), 'utf8'), '99999');
  assert.equal((await hook('SubagentStart', hookJson('SubagentStart', r.dir), 's1')).out, '');

  const pid = await hook('SessionStart', hookJson('SessionStart', r.dir), undefined);
  assert.equal(pid.out, notice('SessionStart', true));
  assert.equal(readFileSync(seenFile('4242'), 'utf8'), '99999', 'a pid seat key: seen-<sha256hex(\'4242\')[0:8]>');
  assert.ok(existsSync(join(r.gitdir, 'cowork', 'tmp', `seen-${sha256hex('4242').slice(0, 8)}`)));
});
