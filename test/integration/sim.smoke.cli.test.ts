import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeKeptRoot } from '../helpers/tmp.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SMOKE = fileURLToPath(new URL('../../tools/sim/smoke.ts', import.meta.url));

function runSmoke(args: string[]): { code: number | null; stdout: string; stderr: string } {
  // cwd = repo root so `--import tsx` resolves from this repo's node_modules (Node >= 20.6).
  const r = spawnSync(process.execPath, ['--import', 'tsx', SMOKE, ...args], { cwd: REPO, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('sim:smoke passes a small NaiveEngine run and prints one line per seed', () => {
  const r = runSmoke(['--seeds', '2', '--peers', '2', '--ops', '3']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^sim:smoke ok smoke-0 peers=2 ops=3 code=[0-9a-f]{40,64} \d+ms$/m);
  assert.match(r.stdout, /^sim:smoke ok smoke-1 peers=2 ops=3 code=[0-9a-f]{40,64} \d+ms$/m);
  assert.match(r.stdout, /^sim:smoke: 2 seeds, 0 failures$/m);
});

test('sim:smoke goes red on the force-push mutant and prints a rerun line and the kept artifacts', async () => {
  // The SeedTuple Task 13's sim.naive.test.ts proves INV-FF kills.
  const r = runSmoke(['--seed', 'naive-mutant', '--peers', '3', '--ops', '12', '--force-push-mutant']);
  // runSim keeps the temp root of a failed run (Task 13); artifacts is <mkdtemp base>/공 백 dir/artifacts.
  const kept = /^ {2}artifacts: (.+)$/m.exec(r.stderr)?.[1];
  try {
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /^sim:smoke FAIL naive-mutant INV-FF at step \d+: .*not a first-parent fast-forward$/m);
    assert.match(r.stderr, /^ {2}rerun: npm run sim:smoke -- --seed naive-mutant --peers 3 --ops 12 --force-push-mutant\n {2}artifacts: .+[\\/]공 백 dir[\\/]artifacts$/m);
    assert.ok(kept !== undefined && existsSync(join(kept, 'op-log.jsonl')), r.stderr);
    assert.match(r.stderr, /^ {2}#\d+ p\d push ok [0-9a-f]{40,64}$/m);
    assert.match(r.stdout, /^sim:smoke: 1 seeds, 1 failures$/m);
  } finally {
    // Remove the kept root through removeKeptRoot: only a marked makeTempRoot base under the temp directory goes.
    if (kept !== undefined) await removeKeptRoot(kept);
  }
});

test('sim:smoke rejects bad arguments with exit 2', () => {
  for (const args of [['--bogus'], ['--seeds', '0'], ['--peers', 'x'], ['--ops'], ['--seed']]) {
    const r = runSmoke(args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^sim:smoke: /m, args.join(' '));
  }
});
