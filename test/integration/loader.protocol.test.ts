// Plan 5 Task 4: the hook ↔ daemon protocol (R1-209, R1-223, R1-225, CCI-09, CCI-54 loader half, SEC-26, L-TOKEN's runtime counterpart; 06 test 5,
// 06 §3.4.2 steps 3–5, 06 test 38 hook half, TC-CCI-10 hook half). The bundled loader against test/helpers/fakeDaemon.ts. Timing-sensitive (≤ 300 ms
// exit after the reply): run this file alone for its green evidence.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { TOKEN_ENV } from '../../src/claude/client/mcp/doorbell.js';
import { fakeDaemon, type FakeDaemon } from '../helpers/fakeDaemon.js';
import { buildDist, hookJson, loaderRepo, preToolJson, runLoader, type LoaderRepo } from '../helpers/loaderRun.js';

const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
let r: LoaderRepo;
let daemon: FakeDaemon;
let dist = '';
before(async () => {
  r = await loaderRepo({ label: 'loader-protocol', live: true });
  daemon = await fakeDaemon(r.endpoint as string, r.key as Buffer);
  dist = buildDist(join(r.base, 'build'));
});
after(async () => {
  await daemon?.close();
  await r?.cleanup();
});

/** The session frames of the newest connection, after its printed frame (if any) had time to arrive. */
async function lastConnFrames(wantPrinted: boolean): Promise<Array<Record<string, unknown>>> {
  for (let i = 0; i < 50; i++) {
    const conn = daemon.connections();
    const frames = daemon.frames(conn).map((f) => f.frame);
    if (!wantPrinted || frames.some((f) => f['t'] === 'printed')) return frames;
    await new Promise((res) => setTimeout(res, 20));
  }
  return daemon.frames(daemon.connections()).map((f) => f.frame);
}

test('reply then printed{batch_id} on the same connection; killing the loader after the stdout flush and before printed leaves the batch undelivered until the next hook', async () => {
  daemon.reset();
  daemon.reply({ batch_id: 'b1', decision: 'context', text: 'T', system: 'S', events: ['e1'], cursor: 1 });
  const want = '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"T"},"systemMessage":"S"}';
  const res = await runLoader('SessionStart', hookJson('SessionStart', r.dir), { dist, cwd: r.dir, env: r.env });
  assert.equal(res.exit, 0, res.stderr);
  assert.equal(res.stdout, want);
  assert.equal(res.stderr, '');
  const frames = await lastConnFrames(true);
  assert.deepEqual(frames.map((f) => f['t']), ['hook', 'printed'], 'exactly [hook, printed] on that connection, no other session frame');
  assert.deepEqual(frames[1], { t: 'printed', batch_id: 'b1' });

  const killed = await runLoader('SessionStart', hookJson('SessionStart', r.dir), { dist, cwd: r.dir, env: { ...r.env, COWORK_TEST_KILL_BEFORE_PRINTED: '1' } });
  assert.equal(killed.exit, 0);
  assert.equal(killed.stdout, want, 'the same stdout');
  await new Promise((res) => setTimeout(res, 300));
  assert.deepEqual((await lastConnFrames(false)).map((f) => f['t']), ['hook'], 'no printed: the batch stays undelivered (re-sent at the next hook: Task 7)');
  daemon.reset();
});

test('the loader never waits for the pipe\'s end event and sends exactly one request', { timeout: 300_000 }, async () => {
  daemon.reset();
  const runs: Array<[string, Record<string, unknown>]> = [];
  const kinds: Array<() => [string, Record<string, unknown>]> = [
    () => ['SessionStart', hookJson('SessionStart', r.dir)], () => ['UserPromptSubmit', hookJson('UserPromptSubmit', r.dir)],
    () => ['PreToolUse', preToolJson('Edit', r.dir)], () => ['PreToolUse', preToolJson('Bash', r.dir)], () => ['PostToolUse', hookJson('PostToolUse', r.dir)],
    () => ['Stop', hookJson('Stop', r.dir)], () => ['SubagentStart', hookJson('SubagentStart', r.dir)], () => ['Notification', hookJson('Notification', r.dir)],
    () => ['UserPromptExpansion', hookJson('UserPromptExpansion', r.dir)], () => ['SessionEnd', hookJson('SessionEnd', r.dir)],
  ];
  for (let i = 0; i < 50; i++) runs.push(kinds[i % kinds.length]!());
  const firstConn = daemon.connections() + 1;
  for (const [event, json] of runs) {
    const replyCount = daemon.replies().length;
    const res = await runLoader(event, json, { dist, cwd: r.dir, env: r.env });
    assert.equal(res.exit, 0, `${event}: ${res.stderr}`);
    const replyAt = daemon.replies()[replyCount];
    assert.ok(replyAt !== undefined, `${event}: a reply was written`);
    assert.ok(res.exitMono - replyAt <= 300, `${event}: exit ${Math.round(res.exitMono - replyAt)} ms after the reply (the daemon keeps the connection open)`);
    assert.ok(res.closeAfterExitMs < 200, `${event}: stdout closed ${Math.round(res.closeAfterExitMs)} ms after exit — a child held the hook's stdio`);
  }
  for (let c = firstConn; c <= daemon.connections(); c++) {
    assert.equal(daemon.frames(c).filter((f) => f.frame['t'] === 'hook').length, 1, `connection ${c}: exactly one hook frame`);
  }
  assert.equal(daemon.connections() - firstConn + 1, runs.length, 'one connection per hook process');
});

test('UserPromptSubmit sends only nonces[] and nothing waits on it', async () => {
  daemon.reset();
  const json = hookJson('UserPromptSubmit', r.dir, { prompt: 'please COWORK_CANARY_UPS cws-0123456789abcdef' });
  const res = await runLoader('UserPromptSubmit', json, { dist, cwd: r.dir, env: r.env });
  assert.equal(res.exit, 0);
  const hook = daemon.frames(daemon.connections()).find((f) => f.frame['t'] === 'hook')!.frame;
  assert.deepEqual(hook['payload'], { event: 'UserPromptSubmit', nonces: ['cws-0123456789abcdef'] });
  assert.equal(daemon.bytes().includes('COWORK_CANARY_UPS'), false, 'the canary occurs in 0 captured bytes');
  assert.ok(!res.stdout.includes('COWORK_CANARY_UPS') && !res.stderr.includes('COWORK_CANARY_UPS'));

  daemon.stall(30_000);
  const stalled = await runLoader('UserPromptSubmit', json, { dist, cwd: r.dir, env: r.env });
  assert.deepEqual([stalled.exit, stalled.stdout, stalled.stderr], [0, '', '']);
  assert.ok(stalled.elapsedMs >= 1_450 && stalled.elapsedMs <= 2_200, `${Math.round(stalled.elapsedMs)} ms`);
  daemon.reset();
});

/** Every file's bytes under dir. */
function allBytes(dir: string): Buffer {
  if (!existsSync(dir)) return Buffer.alloc(0);
  return Buffer.concat(readdirSync(dir).map((n) => (statSync(join(dir, n)).isDirectory() ? allBytes(join(dir, n)) : readFileSync(join(dir, n)))));
}

test('seat_key hashes the socket name; the token variable is never read', async () => {
  daemon.reset();
  const socket = '\\\\.\\pipe\\claude-x';
  const env = { ...r.env, CLAUDE_CODE_MESSAGING_SOCKET: socket, [TOKEN_ENV]: 'COWORK_CANARY_TOKEN_2' };
  const calls: Array<[string, Record<string, unknown>]> = [
    ['SessionStart', hookJson('SessionStart', r.dir)], ['PreToolUse', preToolJson('Edit', r.dir)],
    ['UserPromptExpansion', hookJson('UserPromptExpansion', r.dir, { prompt: '/cowork save "x"', command_args: 'save "x"' })], ['PostToolUse', hookJson('PostToolUse', r.dir)],
  ];
  const outputs: string[] = [];
  for (const [event, json] of calls) {
    const res = await runLoader(event, json, { dist, cwd: r.dir, env });
    assert.ok(res.exit === 0 || res.exit === 2, `${event}: exit ${String(res.exit)}`);
    outputs.push(res.stdout, res.stderr);
    const hook = daemon.frames(daemon.connections()).find((f) => f.frame['t'] === 'hook')!.frame;
    assert.equal((hook['h'] as { seat_key: string }).seat_key, sha256hex(socket), event);
    if (event === 'SessionStart') assert.equal((hook['payload'] as { messaging_present: boolean }).messaging_present, true);
    if (event === 'UserPromptExpansion') assert.equal(((hook['payload'] as { evidence: { seat_key: string } }).evidence).seat_key, sha256hex(socket), 'the loader\'s copy too');
  }
  for (const [where, bytes] of [['IPC', daemon.bytes()], ['stdout/stderr', Buffer.from(outputs.join(''))], ['<gitdir>/cowork', allBytes(join(r.gitdir, 'cowork'))],
    ['plugin data', allBytes(r.dataDir)]] as const) {
    assert.equal(bytes.includes('COWORK_CANARY_TOKEN_2'), false, `the token's canary in ${where}`);
  }
  const plain = await runLoader('SessionStart', hookJson('SessionStart', r.dir), { dist, cwd: r.dir, env: r.env });
  assert.equal(plain.exit, 0);
  const hook = daemon.frames(daemon.connections()).find((f) => f.frame['t'] === 'hook')!.frame;
  assert.equal((hook['h'] as { seat_key: string }).seat_key, String(process.pid), 'without the socket: the hook\'s parent pid (this process)');
  assert.equal((hook['payload'] as { messaging_present: boolean }).messaging_present, false);
});
