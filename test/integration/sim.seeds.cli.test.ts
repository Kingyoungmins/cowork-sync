// The seed runner CLI (Task 19; 11-testing §3.11, ruling R-33): tools/sim/run-seeds.ts runs one or more profile groups
// (`--profile edits --seeds 80 --from 0 --profile faults --seeds 20 --from 80`) in contiguous shards, each a
// tools/sim/run-shard.ts child process fed through a seed-list file, with the real engine and the six exit oracles;
// it prints one line per seed and every failure's (quoted) rerun command, rewrites its JSON report after every seed,
// gives a rerun command to every seed a shard crash or the run's deadline lost, and keeps a hung seed's diagnostics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SeedsReport } from '../../tools/sim/seedProtocol.js';
import { removeKeptRoot } from '../helpers/tmp.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const RUN_SEEDS = fileURLToPath(new URL('../../tools/sim/run-seeds.ts', import.meta.url));

function runSeeds(args: string[], env: Record<string, string> = {}): { code: number | null; stdout: string; stderr: string } {
  // cwd = repo root so `--import tsx` resolves from this repo's node_modules (Node >= 20.6).
  const r = spawnSync(process.execPath, ['--import', 'tsx', RUN_SEEDS, ...args], {
    cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const readReport = (file: string): SeedsReport => JSON.parse(readFileSync(file, 'utf8')) as SeedsReport;
const esc = (s: string): string => s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

test('run-seeds validates every flag before starting a child: exit 2 on any bad, missing, repeated or conflicting argument', () => {
  const bad: string[][] = [
    ['--bogus'], ['--seeds', '0'], ['--seeds', 'x'], ['--profile', 'nope'], ['--profile'], ['--parallel', '0'], ['--parallel', '65'],
    ['--from', '-1'], ['--from', '1.5'], ['--seed'], ['--seed', '--peers'], ['--seed', '-x'], ['--seed', 'a"b'], ['--seed', 'a$b'],
    ['--seed', 'a%b'], ['--mutant', 'M99'], ['--mutant', 'M05', '--mutant', 'M05'], ['--peers', '7'], ['--peers', '2', '--peers', '3'],
    ['--steps', 'x'], ['--steps', '-1'], ['--report'], ['--report', '--seeds'], ['--prefix'], ['--prefix', '--seeds'], ['--prefix', 'p!'],
    ['--prefix', 'a', '--prefix', 'b'], ['--seeds', '2', '--seed', 'x'], ['--seed', 'x', '--from', '3'], ['--seeds', '2', '--seeds', '3'],
    ['--profile', 'edits', '--seeds', '2', '--profile', 'edits', '--seeds', '2'], ['--seed', 'x', '--seed', 'x'],
    ['--timeout-min', '0'], ['--timeout-min', 'x'], ['--seed-timeout-min', '-1'],
  ];
  for (const args of bad) {
    const r = runSeeds(args);
    assert.equal(r.code, 2, `${JSON.stringify(args)}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^sim:seeds: /m, JSON.stringify(args));
    assert.doesNotMatch(r.stdout, /^sim:seeds ok /m, `${JSON.stringify(args)}: no seed ran`);
  }
});

test('run-seeds exits 0 for passing seeds, 1 when a mutant seed fails, 2 on bad arguments; shards cover [from, from + N) exactly once; failures print their rerun command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-run-seeds-'));
  try {
    assert.equal(runSeeds(['--bogus']).code, 2);

    // 0: two groups in one call (edits 5-6, faults 7) in two shards over the concatenated list, one line each.
    const report = join(dir, 'ok.json');
    const ok = runSeeds(['--profile', 'edits', '--seeds', '2', '--from', '5', '--profile', 'faults', '--seeds', '1', '--from', '7', '--prefix', 'cli-', '--peers', '2', '--steps', '6', '--parallel', '2', '--report', report]);
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    for (const s of ['cli-edits-5', 'cli-edits-6', 'cli-faults-7']) assert.match(ok.stdout, new RegExp(`^sim:seeds ok ${s} \\d+ms$`, 'm'));
    assert.match(ok.stdout, /^sim:seeds: 2 seeds, 0 failures \(profile edits, peers 2, steps 6, 2 shards\)$/m);
    assert.match(ok.stdout, /^sim:seeds: 1 seeds, 0 failures \(profile faults, peers 2, steps 6, 2 shards\)$/m);
    const rep = readReport(report);
    const want = ['cli-edits-5', 'cli-edits-6', 'cli-faults-7'];
    assert.deepEqual(rep.runs, [{ profile: 'edits', seeds: ['cli-edits-5', 'cli-edits-6'] }, { profile: 'faults', seeds: ['cli-faults-7'] }]);
    assert.deepEqual(rep.shards, [['cli-edits-5', 'cli-edits-6'], ['cli-faults-7']], 'contiguous slices, in order');
    assert.deepEqual(rep.shards.flat(), want, 'the shards cover the seeds exactly once');
    assert.deepEqual(rep.results.map((x) => `${x.profile} ${x.seed}`), ['edits cli-edits-5', 'edits cli-edits-6', 'faults cli-faults-7']);
    assert.ok(rep.results.every((x) => x.ok && Number.isInteger(x.ms)), JSON.stringify(rep.results));
    assert.deepEqual([rep.peers, rep.steps, rep.mutants, rep.failures, rep.lost, rep.problems, rep.complete], [2, 6, [], 0, [], [], true]);

    // 1: a mutant seed fails with its oracle, its rerun command and its kept artifacts.
    const badReport = join(dir, 'bad.json');
    const bad = runSeeds(['--profile', 'edits', '--seed', 'cli-mutant-3', '--peers', '2', '--steps', '12', '--mutant', 'M05', '--report', badReport]);
    const badRep = readReport(badReport);
    try {
      assert.equal(bad.code, 1, bad.stdout + bad.stderr);
      assert.match(bad.stderr, /^sim:seeds FAIL cli-mutant-3 INV-BASE at step \d+: p1: A_set\(.+\) cause join: /m);
      assert.match(bad.stderr, /^ {2}rerun: npm run sim:seeds -- --profile edits --seed cli-mutant-3 --peers 2 --steps 12 --mutant M05$/m);
      assert.match(bad.stdout, /^sim:seeds: 1 seeds, 1 failures \(profile edits, peers 2, steps 12, 1 shards\)$/m);
      const f = badRep.results[0]!;
      assert.deepEqual([f.seed, f.profile, f.ok, f.oracle], ['cli-mutant-3', 'edits', false, 'INV-BASE']);
      assert.ok(f.artifacts !== undefined && existsSync(join(f.artifacts, 'op-log.jsonl')), JSON.stringify(f));
      assert.match(bad.stderr, new RegExp(`^ {2}artifacts: ${esc(f.artifacts!)}$`, 'm'));
    } finally {
      if (badRep.results[0]?.artifacts !== undefined) await removeKeptRoot(badRep.results[0].artifacts);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a red group does not hide another: a hung edits seed times out with its partial op-log and trace kept (and copied to --keep-dir) and its rerun command, while the faults seed of the same call is reported; a shard crash and the run\'s deadline give every lost seed a rerun command and keep the report', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-run-seeds-'));
  const kept: string[] = [];
  try {
    // A seed that hangs at step 2 (test seam; its name holds spaces) under a 3 min seed timeout, next to a passing faults
    // seed in another shard. The timeout leaves the faults seed (well under a minute alone) room under npm test's parallel
    // load: at 1 min it timed out too in a loaded npm run ci.
    const r1 = join(dir, 'hang.json');
    const hang = runSeeds(['--profile', 'edits', '--seed', 'cli hang e', '--profile', 'faults', '--seed', 'cli-hang-f', '--peers', '2', '--steps', '4', '--parallel', '2', '--seed-timeout-min', '3', '--keep-dir', join(dir, 'kept'), '--report', r1],
      { COWORK_SIM_TEST_HANG_SEED: 'cli hang e' });
    const rep1 = readReport(r1);
    for (const x of rep1.results) if (x.artifacts !== undefined) kept.push(x.artifacts);
    assert.equal(hang.code, 1, hang.stdout + hang.stderr);
    assert.match(hang.stderr, /^sim:seeds FAIL cli hang e TIMEOUT at step 2: no result after 3 min/m);
    assert.match(hang.stderr, /^ {2}rerun: npm run sim:seeds -- --profile edits --seed "cli hang e" --peers 2 --steps 4$/m, 'the rerun command quotes the seed');
    assert.match(hang.stdout, /^sim:seeds ok cli-hang-f \d+ms$/m, 'the faults seed is reported');
    assert.match(hang.stdout, /^sim:seeds: 1 seeds, 0 failures \(profile faults/m);
    const t = rep1.results.find((x) => x.seed === 'cli hang e')!;
    assert.equal(t.oracle, 'TIMEOUT');
    assert.ok(t.artifacts !== undefined, JSON.stringify(t));
    const opLog = readFileSync(join(t.artifacts, 'op-log.jsonl'), 'utf8').split('\n').filter((l) => l.length > 0);
    assert.ok(opLog.length >= 2, `the partial op-log is kept: ${opLog.length} entries`);
    assert.ok(existsSync(join(t.artifacts, 'trace.jsonl')), 'the partial trace is kept');
    assert.ok(existsSync(join(dir, 'kept', 'cli_hang_e', 'op-log.jsonl')), '--keep-dir holds a copy of the timed-out seed\'s artifacts');
    assert.match(hang.stderr, new RegExp(`^ {2}kept: ${esc(join(dir, 'kept', 'cli_hang_e'))}$`, 'm'));
    assert.equal(rep1.complete, true);

    // A shard that crashes after its first seed (test seam): its other seeds are lost, each with a rerun command.
    const r2 = join(dir, 'crash.json');
    const crash = runSeeds(['--profile', 'edits', '--seeds', '3', '--from', '0', '--prefix', 'cli-crash-', '--peers', '2', '--steps', '4', '--parallel', '1', '--report', r2],
      { COWORK_SIM_TEST_CRASH_AFTER: '1' });
    const rep2 = readReport(r2);
    assert.equal(crash.code, 2, crash.stdout + crash.stderr);
    assert.match(crash.stdout, /^sim:seeds ok cli-crash-edits-0 \d+ms$/m);
    for (const s of ['cli-crash-edits-1', 'cli-crash-edits-2']) {
      assert.match(crash.stderr, new RegExp(`^sim:seeds LOST ${s} \\(shard 0 ended with exit 70 before its result\\)$`, 'm'));
      assert.match(crash.stderr, new RegExp(`^ {2}rerun: npm run sim:seeds -- --profile edits --seed ${s} --peers 2 --steps 4$`, 'm'));
    }
    assert.deepEqual(rep2.lost.map((l) => l.seed), ['cli-crash-edits-1', 'cli-crash-edits-2']);
    assert.deepEqual([rep2.results.length, rep2.complete], [1, true]);

    // The run's own deadline (1 min: time for the shard to start and reach the hang at step 2 under load) ends a shard
    // whose seed hangs with no seed timeout: lost seeds with rerun commands, the report written with complete: false.
    const r3 = join(dir, 'deadline.json');
    const late = runSeeds(['--profile', 'edits', '--seed', 'cli-late-1', '--seed', 'cli-late-2', '--peers', '2', '--steps', '6', '--parallel', '1', '--timeout-min', '1', '--report', r3],
      { COWORK_SIM_TEST_HANG_SEED: 'cli-late-1' });
    const rep3 = readReport(r3);
    assert.equal(late.code, 2, late.stdout + late.stderr);
    assert.match(late.stderr, /^sim:seeds: the run's deadline \(1 min\) passed: shard 0 stopped while running cli-late-1$/m);
    assert.match(late.stderr, /^sim:seeds LOST cli-late-1 \(running at the deadline\)$/m);
    assert.match(late.stderr, /^sim:seeds LOST cli-late-2 \(not started at the deadline\)$/m);
    assert.deepEqual(rep3.lost.map((l) => [l.seed, l.rerun]), [
      ['cli-late-1', 'npm run sim:seeds -- --profile edits --seed cli-late-1 --peers 2 --steps 6'],
      ['cli-late-2', 'npm run sim:seeds -- --profile edits --seed cli-late-2 --peers 2 --steps 6'],
    ]);
    assert.equal(rep3.complete, false);
    const dumped = rep3.lost[0]?.artifacts;
    assert.ok(dumped !== undefined && existsSync(join(dumped, 'op-log.jsonl')), `the running seed's partial artifacts: ${JSON.stringify(rep3.lost[0])}`);
    kept.push(dumped);
  } finally {
    for (const k of kept) await removeKeptRoot(k);
    rmSync(dir, { recursive: true, force: true });
  }
});
