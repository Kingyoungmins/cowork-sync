// Plan 5 Task 4: deadlines and G4 (R1-311, R1-407, CCI-10, CCI-16, CCI-17 client half, C13, Q-12, R5-40, SE5-07, INV-CCI-FAILCLOSED, A4-7; 06 test 8
// stall part, 06 test 13 bound, 06 test 15 loader half, TC-CCI-03 stall half). Timing-sensitive: the windows are spawn-to-exit of `node dist/hook.js`,
// whose deadline counts from the loader's own start (A4-3). Run this file alone for its green evidence.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOADER_TEXTS } from '../../src/claude/text/claudeText.js';
import { fakeDaemon, type FakeDaemon } from '../helpers/fakeDaemon.js';
import { buildDist, copyDist, hookJson, loaderRepo, preToolJson, runLoader, type LoaderRepo, type LoaderResult } from '../helpers/loaderRun.js';

/** Glossary §11's G4 sentence, read from the spec. */
function glossaryG4(): string {
  const text = readFileSync(fileURLToPath(new URL('../../docs/spec/00-glossary.md', import.meta.url)), 'utf8');
  const row = text.split('\n').find((l) => l.startsWith('| **G4 deny, daemon down**'));
  const m = row === undefined ? null : /exit 2: "([^"]+)"/.exec(row);
  assert.ok(m !== null, 'glossary §11 G4 row');
  return m[1] as string;
}

let r: LoaderRepo;
let daemon: FakeDaemon;
let dist = '';
let faultB = '';
before(async () => {
  r = await loaderRepo({ label: 'loader-deadlines', live: true });
  daemon = await fakeDaemon(r.endpoint as string, r.key as Buffer);
  dist = buildDist(join(r.base, 'build'));
  faultB = copyDist(dist, join(r.base, 'fault-b'));
  writeFileSync(join(faultB, 'core.js'), "export function main() { throw new Error('x'); }\n");
});
after(async () => {
  await daemon?.close();
  await r?.cleanup();
});

const inWindow = (res: LoaderResult, lo: number, hi: number, what: string): void => {
  assert.ok(res.elapsedMs >= lo && res.elapsedMs <= hi, `${what}: ${Math.round(res.elapsedMs)} ms not in [${lo}, ${hi}]`);
};

test('a 30 s stall → G4 within 1.5 s; SessionStart waits 3 s; one extend raises the deadline to 7 s, a second is ignored', { timeout: 120_000 }, async () => {
  daemon.reset();
  daemon.stall(30_000);
  for (const tool of ['Edit', 'Bash']) {
    const res = await runLoader('PreToolUse', preToolJson(tool, r.dir), { dist, cwd: r.dir, env: r.env });
    assert.equal(res.exit, 2, tool);
    assert.equal(res.stderr, LOADER_TEXTS.G4.en, tool);
    assert.equal(res.stdout, '', tool);
    inWindow(res, 1_450, 2_200, `PreToolUse ${tool}`);
  }
  const start = await runLoader('SessionStart', hookJson('SessionStart', r.dir), { dist, cwd: r.dir, env: r.env });
  assert.equal(start.exit, 0);
  assert.equal(start.stdout, '', 'the daemon answered the handshake: no unreachable-daemon notice (A4-6)');
  assert.equal(start.stderr, '');
  inWindow(start, 2_950, 3_700, 'SessionStart');
  const ups = await runLoader('UserPromptSubmit', hookJson('UserPromptSubmit', r.dir), { dist, cwd: r.dir, env: r.env });
  assert.deepEqual([ups.exit, ups.stdout, ups.stderr], [0, '', '']);
  inWindow(ups, 1_450, 2_200, 'UserPromptSubmit');

  // extend{7000} 200 ms after the hook frame, then the stall: G4 at ≈ 7 s.
  daemon.reset();
  daemon.stall(30_000);
  daemon.extend(7_000, 200);
  const ext = await runLoader('PreToolUse', preToolJson('Edit', r.dir), { dist, cwd: r.dir, env: r.env });
  assert.equal(ext.exit, 2);
  assert.equal(ext.stderr, LOADER_TEXTS.G4.en);
  inWindow(ext, 6_950, 7_700, 'extend{7000}');

  // A second extend{7000} at 6,000 ms changes nothing (still ≈ 7,000).
  daemon.extend(7_000, 6_000);
  const twice = await runLoader('PreToolUse', preToolJson('Edit', r.dir), { dist, cwd: r.dir, env: r.env });
  assert.equal(twice.exit, 2);
  inWindow(twice, 6_950, 7_700, 'a second extend');

  // extend{9000} fails the schema: the client closes and G4 follows at once.
  daemon.reset();
  daemon.stall(30_000);
  daemon.extend(9_000, 200);
  const bad = await runLoader('PreToolUse', preToolJson('Edit', r.dir), { dist, cwd: r.dir, env: r.env });
  assert.equal(bad.exit, 2);
  assert.equal(bad.stderr, LOADER_TEXTS.G4.en);
  const sentAt = daemon.sent().filter((f) => f.frame['t'] === 'extend' && f.frame['deadline_ms'] === 9_000).at(-1)?.at as number;
  assert.ok(bad.exitMono - sentAt <= 800, `exit ${Math.round(bad.exitMono - sentAt)} ms after the frame`);
  assert.ok(bad.elapsedMs < 1_450, 'well before the 1.5 s deadline');
  daemon.reset();
});

test('daemon binary removed: every edit-class and shell PreToolUse exits 2 with the glossary text within 1.5 s; Agent without isolation still passes', { timeout: 120_000 }, async () => {
  const g4 = glossaryG4();
  assert.equal(g4, LOADER_TEXTS.G4.en);
  const noDaemon = copyDist(dist, join(r.base, 'no-daemon'));
  rmSync(join(noDaemon, 'daemon.js'));
  // P5-EC-9: and no runtime copy (the first test's SessionStart makes one once dist/grammars/ exists), so the stale runs can only spawn the missing
  // daemon.js, a child that fails to load and exits on its own.
  rmSync(join(r.dataDir, 'runtime'), { recursive: true, force: true });
  await daemon.close();
  r.setStatus({ heartbeat_mono_ms: 1_000, loop_period_ms: 2_500, state: 'ok' });
  try {
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell', 'Monitor']) {
      const res = await runLoader('PreToolUse', preToolJson(tool, r.dir), { dist: noDaemon, cwd: r.dir, env: r.env });
      assert.equal(res.exit, 2, `${tool}: ${res.stderr}`);
      assert.equal(res.stderr, g4, `${tool}: byte-equal to glossary §11`);
      assert.equal(res.stdout, '');
      assert.ok(res.elapsedMs <= 2_200, `${tool}: ${Math.round(res.elapsedMs)} ms`);
    }
    const agent = await runLoader('PreToolUse', preToolJson('Agent', r.dir, { input: { subagent_type: 'reviewer', prompt: 'review' } }), { dist: noDaemon, cwd: r.dir, env: r.env });
    assert.deepEqual([agent.exit, agent.stdout, agent.stderr], [0, '', ''], 'Agent without isolation and without a definition passes');
    const wt = await runLoader('PreToolUse', preToolJson('EnterWorktree', r.dir), { dist: noDaemon, cwd: r.dir, env: r.env });
    assert.equal(wt.exit, 2);
    assert.equal(wt.stderr, '[cowork-sync] WORKTREE_DENY');
    // The Agent call opens no connection, whether or not anything listens (A4-7).
    daemon = await fakeDaemon(r.endpoint as string, r.key as Buffer);
    const again = await runLoader('PreToolUse', preToolJson('Agent', r.dir, { input: { subagent_type: 'reviewer' } }), { dist: noDaemon, cwd: r.dir, env: r.env });
    assert.deepEqual([again.exit, again.stdout, again.stderr], [0, '', '']);
    assert.equal(daemon.connections(), 0);
  } finally {
    r.setStatus('fresh');
  }
});

test('the G4 text has no cause slot: an internal failure and an unreachable daemon print the same bytes', { timeout: 120_000 }, async () => {
  daemon.reset();
  daemon.stall(30_000);
  for (const lang of ['en', 'ko'] as const) {
    r.setLanguage(lang);
    const internal = await runLoader('PreToolUse', preToolJson('Edit', r.dir), { dist: faultB, cwd: r.dir, env: r.env });
    const stalled = await runLoader('PreToolUse', preToolJson('Edit', r.dir), { dist, cwd: r.dir, env: r.env });
    assert.equal(internal.exit, 2);
    assert.equal(stalled.exit, 2);
    assert.ok(Buffer.from(internal.stderr).equals(Buffer.from(stalled.stderr)), `${lang}: the same bytes`);
    assert.equal(internal.stderr, LOADER_TEXTS.G4[lang]);
  }
  r.setLanguage('en');
  daemon.reset();
});
