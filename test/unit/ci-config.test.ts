import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = new URL('../../', import.meta.url);
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, REPO)), 'utf8');
const scripts = (): Record<string, string> =>
  (JSON.parse(read('package.json')) as { scripts?: Record<string, string> }).scripts ?? {};

// Plan 1's gates, then (Plan 2 Task 19) a 5-seed real-engine run with the exit oracles.
const CI_GATES = 'npm run lint && npm run typecheck && npm run build && npm test && npm run sim:smoke && npm run sim:seeds -- --profile edits --seeds 5';

/** The `npm …` command of every `run:` line, with its arguments. */
const npmSteps = (y: string): string[] => [...y.matchAll(/^\s+(?:- )?run: (npm (?:test|run [\w:-]+)(?: .*)?)$/gm)].map((m) => m[1] as string);
/** `npm test` / `npm run <script>`: the gate a command runs, without its arguments. */
const gate = (cmd: string): string => /^npm (?:test|run [\w:-]+)/.exec(cmd)?.[0] ?? cmd;
/** The value of `<key>: <int>` at exactly `indent` spaces, every occurrence in order. */
const intsAt = (y: string, indent: number, key: string): number[] => [...y.matchAll(new RegExp(`^ {${indent}}${key}: (\\d+)$`, 'gm'))].map((m) => Number(m[1]));
/** The jobs of a workflow (`jobs:` then `  <id>:` blocks), by id, each with its text. */
function jobsOf(y: string): Map<string, string> {
  const body = y.slice(y.indexOf('\njobs:\n') + 1);
  const out = new Map<string, string>();
  const heads = [...body.matchAll(/^ {2}([a-z][a-z0-9_-]*):$/gm)];
  heads.forEach((h, i) => out.set(h[1]!, body.slice(h.index!, heads[i + 1]?.index ?? body.length)));
  return out;
}

test('ci.yml runs the os x node matrix', () => {
  const y = read('.github/workflows/ci.yml');
  assert.match(y, /^\s+os: \[windows-latest, macos-latest, ubuntu-latest\]$/m);
  assert.match(y, /^\s+node: \['20\.x', '24\.x'\]$/m);
  assert.match(y, /^\s+fail-fast: false$/m);
  assert.match(y, /^\s+node-version: \$\{\{ matrix\.node \}\}$/m);
});

test('ci.yml sets core.autocrlf=true on Windows before checkout, then npm ci, lint, typecheck, build, test, sim:smoke, sim:seeds in order', () => {
  const y = read('.github/workflows/ci.yml');
  const order = [
    "if: runner.os == 'Windows'",
    'run: git config --global core.autocrlf true',
    'uses: actions/checkout@',
    'uses: actions/setup-node@',
    'run: npm ci',
    'run: npm run lint',
    'run: npm run typecheck',
    'run: npm run build',
    'run: npm test',
    'run: npm run sim:smoke',
    'run: npm run sim:seeds -- --profile edits',
  ].map((s) => {
    const i = y.indexOf(s);
    assert.notEqual(i, -1, `missing: ${s}`);
    return i;
  });
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test('ci.yml is LF-only and tab-free', () => {
  const y = read('.github/workflows/ci.yml');
  assert.equal(y.includes('\r'), false);
  assert.equal(y.includes('\t'), false);
});

test('npm run ci includes typecheck and sim:smoke; lint and sim:smoke run their CLIs', () => {
  const s = scripts();
  assert.equal(s['ci'], CI_GATES);
  assert.equal(s['typecheck'], 'tsc -p tsconfig.json');
  assert.equal(s['lint'], 'tsx tools/lint/lint.ts');
  assert.equal(s['sim:smoke'], 'tsx tools/sim/smoke.ts');
});

test('ci.yml runs exactly the gates of npm run ci, in the same order', () => {
  // Gate names and order, every step counted: nothing collapsed (ci.yml's one sim:seeds step runs both profiles).
  const steps = npmSteps(read('.github/workflows/ci.yml')).map(gate);
  assert.deepEqual(steps, (scripts()['ci'] ?? '').split(' && ').map(gate));
});

test('npm run ci ends with sim:smoke and a 5-seed real-engine run (sim:seeds --profile edits --seeds 5)', () => {
  const s = scripts();
  const gates = (s['ci'] ?? '').split(' && ');
  assert.deepEqual(gates.slice(-2), ['npm run sim:smoke', 'npm run sim:seeds -- --profile edits --seeds 5']);
  assert.equal(s['sim:seeds'], 'tsx tools/sim/run-seeds.ts');
  assert.equal(s['sim:exit'], 'tsx tools/sim/run-seeds.ts --profile edits --seeds 1000 --parallel 8');
});

/** tools/test/testFlags.mjs (plain JS for the launcher; imported by a computed specifier, so tsc reads it as `any` and this type says what it is). */
interface TestFlags {
  testTimeout(version: string, env: Record<string, string | undefined>): { ms: number | null; scope: 'test' | 'file' };
  hasForceExit(version: string): boolean;
  needsBlockingStdio(version: string, platform: NodeJS.Platform): boolean;
}
async function testFlags(): Promise<TestFlags> {
  const href = new URL('tools/test/testFlags.mjs', REPO).href;
  return (await import(href)) as TestFlags;
}

test('run-tests --test-timeout: on Node 24+ a 10 min limit per test; on Node 20-23, where the runner also cancels a whole test file at that time (its later tests then go unreported), a 60 min budget per file; COWORK_TEST_TIMEOUT_MS overrides either; none before 20.11', async () => {
  const f = await testFlags();
  for (const v of ['24.0.0', '24.21.0', '25.1.0']) assert.deepEqual(f.testTimeout(v, {}), { ms: 600_000, scope: 'test' }, v);
  for (const v of ['20.11.0', '20.20.2', '21.2.0', '22.22.0', '23.11.1']) assert.deepEqual(f.testTimeout(v, {}), { ms: 3_600_000, scope: 'file' }, v);
  assert.deepEqual(f.testTimeout('20.20.2', { COWORK_TEST_TIMEOUT_MS: '900000' }), { ms: 900_000, scope: 'file' });
  assert.deepEqual(f.testTimeout('24.21.0', { COWORK_TEST_TIMEOUT_MS: '120000' }), { ms: 120_000, scope: 'test' });
  for (const bad of ['0', '-1', 'x', '1.5']) assert.equal(f.testTimeout('24.21.0', { COWORK_TEST_TIMEOUT_MS: bad }).ms, null, bad);
  for (const v of ['20.6.0', '20.10.0', '21.1.0']) assert.equal(f.testTimeout(v, {}).ms, null, `${v} has no --test-timeout`);
  // --test-force-exit from 20.14 and 22.
  assert.deepEqual(['20.13.1', '20.14.0', '21.7.3', '22.0.0', '24.21.0'].map((v) => f.hasForceExit(v)), [false, true, false, true, true]);
  // The launcher builds its flags from these.
  const runTests = read('tools/test/run-tests.mjs');
  assert.match(runTests, /import \{ hasForceExit, testTimeout \} from '\.\/testFlags\.mjs';/);
  assert.match(runTests, /testTimeout\(process\.versions\.node, process\.env\)/);
});

test('open-handles.mjs makes a test file\'s stdout and stderr blocking on POSIX before Node 22.10 (where --test-force-exit could end the file before its last results reached the runner), and reports output still unwritten at exit', () => {
  return testFlags().then((f) => {
    const cases: Array<[string, NodeJS.Platform, boolean]> = [
      ['20.20.2', 'darwin', true], ['20.20.2', 'linux', true], ['22.9.0', 'darwin', true], ['21.7.3', 'linux', true],
      ['22.10.0', 'darwin', false], ['22.22.0', 'linux', false], ['24.21.0', 'darwin', false], ['20.20.2', 'win32', false], ['24.21.0', 'win32', false],
    ];
    for (const [v, os, want] of cases) assert.equal(f.needsBlockingStdio(v, os), want, `${v} ${os}`);
    const hook = read('tools/test/open-handles.mjs');
    assert.match(hook, /import \{ needsBlockingStdio \} from '\.\/testFlags\.mjs';/);
    assert.match(hook, /if \(needsBlockingStdio\(process\.versions\.node, process\.platform\)\) \{\n\s+for \(const s of \[process\.stdout, process\.stderr\]\) s\._handle\?\.setBlocking\?\.\(true\);/);
    assert.match(hook, /writableLength/, 'output still queued at exit is reported');
    const runTests = read('tools/test/run-tests.mjs');
    assert.match(runTests, /exited with \$\{rep\.unflushed\} bytes of test output not yet written/);
  });
});

/** Every `{ timeout: … }` a test file sets, in minutes (`<n>` ms or `<n> * 60_000`). */
function testTimeoutsMin(): Array<{ file: string; min: number }> {
  const out: Array<{ file: string; min: number }> = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.test.ts')) {
        for (const m of readFileSync(full, 'utf8').matchAll(/\{ timeout: ([\d_]+)(?: \* ([\d_]+))? \}/g)) {
          const ms = Number(m[1]!.replace(/_/g, '')) * (m[2] === undefined ? 1 : Number(m[2].replace(/_/g, '')));
          out.push({ file: e.name, min: ms / 60_000 });
        }
      }
    }
  };
  walk(fileURLToPath(new URL('test/', REPO)));
  return out;
}

test('each ci.yml leg runs 80 edits and 20 faults seeds with a per-Node seed offset in one sim:seeds step of its own job, under timeouts measured on the reference PC, and the job running npm test outlasts every per-test timeout; sim-exit.yml runs 1,000 edits seeds per OS in 10 shards', async () => {
  // R-33: Node 20 legs take seeds 0–99 (edits 0–79, faults 80–99), Node 24 legs 100–199; 4 child processes. The
  // timeouts (R-33 amendment, Task 19 fix round 1) come from the per-push ranges and npm test measured on the reference
  // PC (the Task 19 report records them) with a 1.5x margin; the job is split in two, so the gates run on two runners
  // side by side: `test` (lint … sim:smoke) and `sim` (the seeds).
  const y = read('.github/workflows/ci.yml');
  const jobs = jobsOf(y);
  assert.deepEqual([...jobs.keys()], ['test', 'sim']);
  const testJob = jobs.get('test')!;
  const simJob = jobs.get('sim')!;
  const [tJob] = intsAt(testJob, 4, 'timeout-minutes');
  const [sJob] = intsAt(simJob, 4, 'timeout-minutes');
  assert.ok(tJob !== undefined && sJob !== undefined, 'each job has a timeout');
  assert.deepEqual(npmSteps(testJob).map(gate), ['npm run lint', 'npm run typecheck', 'npm run build', 'npm test', 'npm run sim:smoke']);
  assert.deepEqual(npmSteps(simJob).map(gate), ['npm run sim:seeds']);
  for (const j of [testJob, simJob]) {
    assert.match(j, /^ {8}os: \[windows-latest, macos-latest, ubuntu-latest\]\n {8}node: \['20\.x', '24\.x'\]$/m, 'both jobs run the os x node matrix');
    assert.ok(j.indexOf('run: git config --global core.autocrlf true') < j.indexOf('uses: actions/checkout@'), 'core.autocrlf=true on Windows before checkout');
    assert.ok(j.includes('node-version: ${{ matrix.node }}') && j.includes('run: npm ci'));
  }
  assert.doesNotMatch(simJob, /^ {4}needs:/m, 'the seeds run beside the tests, never hidden behind them');
  assert.match(simJob, /^ {10}- node: '20\.x'\n {12}edits_from: 0\n {12}faults_from: 80$/m);
  assert.match(simJob, /^ {10}- node: '24\.x'\n {12}edits_from: 100\n {12}faults_from: 180$/m);
  const seeds = npmSteps(y).filter((c) => gate(c) === 'npm run sim:seeds');
  assert.equal(seeds.length, 1, 'one sim:seeds step: a red edits group never hides the faults results');
  const m = /^npm run sim:seeds -- --profile edits --seeds 80 --from \$\{\{ matrix\.edits_from \}\} --profile faults --seeds 20 --from \$\{\{ matrix\.faults_from \}\} --parallel 4 --timeout-min (\d+) --seed-timeout-min (\d+) --keep-dir sim-kept --report sim-seeds\.json$/.exec(seeds[0]!);
  assert.ok(m !== null, seeds[0]);
  const runMin = Number(m[1]);
  const seedMin = Number(m[2]);
  const [step] = intsAt(simJob, 8, 'timeout-minutes');
  assert.ok(step !== undefined, 'the sim:seeds step has its own timeout');
  // The runner's deadline ends it first (its report and lost seeds' rerun commands survive), then the step's, then the job's.
  assert.ok(seedMin < runMin && runMin < step && step < sJob, `seed ${seedMin} < run ${runMin} < step ${step} < job ${sJob}`);
  // Every timeout npm test sets is shorter than the test job's: run-tests' defaults (10 min per test on Node 24+, a 60 min budget per
  // file on Node 20-23) and every `{ timeout }` a test sets.
  const flags = await testFlags();
  const defaults = [
    { file: 'run-tests per-test default (Node 24+)', min: (flags.testTimeout('24.0.0', {}).ms ?? 0) / 60_000 },
    { file: 'run-tests per-file budget (Node 20-23)', min: (flags.testTimeout('20.20.2', {}).ms ?? 0) / 60_000 },
  ];
  assert.deepEqual(defaults.map((d) => d.min), [10, 60]);
  for (const t of [...defaults, ...testTimeoutsMin()]) assert.ok(t.min < tJob, `${t.file}: a ${t.min} min test timeout under a ${tJob} min job`);
  assert.match(simJob, /^ {6}- name: SIM report\n {8}if: \$\{\{ !cancelled\(\) \}\}\n {8}uses: actions\/upload-artifact@v4$/m);
  assert.match(y, /path: \|\n {12}sim-seeds\.json\n {12}sim-kept\/$/m);
  assert.doesNotMatch(y, /--seeds 1000|COWORK_SIM_LONG/, 'the exit run and the long tests are never per-push');

  const x = read('.github/workflows/sim-exit.yml');
  assert.equal(x.includes('\r') || x.includes('\t'), false, 'sim-exit.yml is LF-only and tab-free');
  assert.match(x, /^ {2}workflow_dispatch:$/m);
  assert.match(x, /^ {2}schedule:\n {4}- cron: '[0-9 *]+'$/m);
  assert.doesNotMatch(x, /^ {2}(push|pull_request):/m, 'never on push or pull request');
  assert.match(x, /^ {8}os: \[windows-latest, macos-latest, ubuntu-latest\]$/m);
  assert.match(x, /^ {8}shard: \[0, 1, 2, 3, 4, 5, 6, 7, 8, 9\]$/m);
  assert.ok(x.includes('run: npm run sim:seeds -- --profile edits --seeds 100 --from $(( ${{ matrix.shard }} * 100 )) --parallel 4 --timeout-min 140 --seed-timeout-min 30 --keep-dir sim-kept --report sim-exit-${{ matrix.os }}-${{ matrix.shard }}.json'), 'each shard runs its 100 edits seeds');
  assert.equal([...x.matchAll(/npm run sim:seeds/g)].length, 1, 'one seed run per shard job');
  const [shardJob, , ] = intsAt(x, 4, 'timeout-minutes');
  const [shardStep] = intsAt(x, 8, 'timeout-minutes');
  assert.ok(140 < (shardStep ?? 0) && (shardStep ?? 0) < (shardJob ?? 0), `deadline 140 < step ${shardStep} < job ${shardJob}`);
  // The per-OS verdict: the exact seed set (edits-0 … edits-999, each once, all passed), by the tested script.
  assert.match(x, /^ {2}summary:$/m);
  assert.ok(x.includes('pattern: sim-exit-${{ matrix.os }}-*'));
  assert.ok(x.includes('run: npx tsx tools/sim/exit-verdict.ts --reports reports --profile edits --from 0 --seeds 1000 --label ${{ matrix.os }}'));
  // The exit artifact is coupled to nothing else: the long tests and the rehearsal live in sim-long.yml.
  assert.deepEqual([...x.matchAll(/^ {2}([a-z-]+):$/gm)].map((j) => j[1]).filter((j) => !['workflow_dispatch', 'schedule'].includes(j!)), ['shard', 'summary']);
  assert.doesNotMatch(x, /COWORK_SIM_LONG|COWORK_REAL_REHEARSAL|real\.twoclone/);

  // Task 20 and Task 18 carries, and the M18 ruling: the long SIM tests (with Task 9's diskEq test, M18's catcher) and
  // the real-remote rehearsal, which runs even when the long SIM tests fail.
  const l = read('.github/workflows/sim-long.yml');
  assert.equal(l.includes('\r') || l.includes('\t'), false, 'sim-long.yml is LF-only and tab-free');
  assert.match(l, /^ {2}workflow_dispatch:$/m);
  assert.doesNotMatch(l, /^ {2}(push|pull_request):/m, 'never on push or pull request');
  assert.match(l, /COWORK_SIM_LONG: '1'\n {8}run: npx tsx --test test\/integration\/sim\.engine\.test\.ts test\/integration\/sim\.oracles\.plan2\.test\.ts test\/integration\/sim\.crash\.test\.ts test\/integration\/diskEq\.test\.ts$/m);
  assert.match(l, /- name: Real-remote rehearsal\n {8}if: \$\{\{ !cancelled\(\) \}\}\n(?: {8}.*\n)*? {8}run: npx tsx --test test\/integration\/real\.twoclone\.test\.ts$/m);
});
