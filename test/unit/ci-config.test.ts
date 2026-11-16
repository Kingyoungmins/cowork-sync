import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILES_ALL } from '../../tools/sim/seedProtocol.js';

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

/** Plan 2's tests of this file (Tasks 19 and 20 and their fix rounds), by title; Plan 3 Task 16 replaced only the per-leg seed test. */
const PLAN2_TITLES: readonly string[] = Object.freeze([
  'ci.yml runs the os x node matrix',
  'ci.yml sets core.autocrlf=true on Windows before checkout, then npm ci, lint, typecheck, build, test, sim:smoke, sim:seeds in order',
  'ci.yml is LF-only and tab-free',
  'npm run ci includes typecheck and sim:smoke; lint and sim:smoke run their CLIs',
  'ci.yml runs exactly the gates of npm run ci, in the same order',
  'npm run ci ends with sim:smoke and a 5-seed real-engine run (sim:seeds --profile edits --seeds 5)',
  'run-tests --test-timeout: on Node 24+ a 10 min limit per test; on Node 20-23, where the runner also cancels a whole test file at that time (its later tests then go unreported), a 60 min budget per file; COWORK_TEST_TIMEOUT_MS overrides either; none before 20.11',
  "open-handles.mjs makes a test file's stdout and stderr blocking on POSIX before Node 22.10 (where --test-force-exit could end the file before its last results reached the runner), and reports output still unwritten at exit",
]);

test('npm run ci still ends with sim:smoke and Plan 2\'s 5-seed edits run, and Plan 2\'s ci-config assertions are extended, not dropped', () => {
  assert.equal(scripts()['ci'], CI_GATES, 'npm run ci: Plan 1\'s gates, then sim:smoke and Plan 2\'s 5-seed edits run, unchanged (TST-13)');
  // This file's own tests, by title (unescaped): every Plan 2 test is still here.
  const src = read('test/unit/ci-config.test.ts');
  const titles = [...src.matchAll(/^test\('((?:[^'\\]|\\.)*)'/gm)].map((m) => m[1]!.replace(/\\(.)/g, '$1'));
  for (const t of PLAN2_TITLES) assert.ok(titles.includes(t), `Plan 2's test is kept: ${t}`);
  // Plan 2's per-leg seed test is extended (X-113, R3-51; its seed numbers by Ruling R3-51/55-A), not dropped: the Plan 3 test keeps each
  // of its clauses — one sim:seeds step in a job of its own beside the tests, per-Node offsets, the runner's deadline under the step's
  // under the job's, the report upload, every npm test timeout under the test job's, the exit run and the long tests never per push.
  const legs = titles.find((t) => t.startsWith('ci.yml: each of the six legs runs sim:seeds'));
  assert.ok(legs !== undefined, 'the per-leg seed test');
  // The test's own line (fix round 1: a plain indexOf of the title found this guard's source first, whose clause list holds every
  // clause, so a clause dropped from the per-leg test went unseen).
  const start = /^test\('ci\.yml: each of the six legs/m.exec(src)?.index ?? -1;
  assert.ok(start >= 0, 'the per-leg seed test\'s source');
  const body = src.slice(start, src.indexOf('\n});\n', start));
  for (const clause of [
    "assert.deepEqual([...jobs.keys()], ['test', 'sim'])",
    "assert.doesNotMatch(simJob, /^ {4}needs:/m",
    "assert.equal(seeds.length, 1, 'one sim:seeds step",
    "assert.ok(seedMin < runMin && runMin < step && step < sJob",
    'for (const t of [...defaults, ...testTimeoutsMin()]) assert.ok(t.min < tJob',
    '- name: SIM report',
    'assert.doesNotMatch(y, /--seeds 1000|COWORK_SIM_LONG',
  ]) assert.ok(body.includes(clause), `Plan 2's clause kept: ${clause}`);
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
        const text = readFileSync(full, 'utf8');
        // (Plan 3 Task 16: other options may follow the timeout, `{ timeout: 80 * 60_000, ...skipUnless(seed) }`.)
        for (const m of text.matchAll(/\{ timeout: ([\d_]+)(?: \* ([\d_]+))?(?:, (?:[^{}]|\$\{[^}]*\})*)? \}/g)) {
          const ms = Number(m[1]!.replace(/_/g, '')) * (m[2] === undefined ? 1 : Number(m[2].replace(/_/g, '')));
          out.push({ file: e.name, min: ms / 60_000 });
        }
        // R3-55's two forms (Plan 3 Task 16): `{ timeout: (FULL ? <test:sim> : <npm test>) * <unit> }` — npm test runs the second.
        for (const m of text.matchAll(/\{ timeout: \(FULL \? [\d_]+ : ([\d_]+)\) \* ([\d_]+)(?:,(?:[^{}]|\$\{[^}]*\})*)? \}/g)) {
          out.push({ file: e.name, min: (Number(m[1]!.replace(/_/g, '')) * Number(m[2]!.replace(/_/g, ''))) / 60_000 });
        }
      }
    }
  };
  walk(fileURLToPath(new URL('test/', REPO)));
  return out;
}

/**
 * X-113 (rev 2.5, R3-51): the fixed seed count of every merged non-`edits` profile in the 100-seed set of a leg, one table — a later plan
 * that merges its profile adds nothing here but edits the workflow (its row is already listed); `edits` takes the rest of the 100 seeds.
 * Ruling R3-51/55-A (Plan 3 Task 16 fix round 1): that set runs in sim-exit.yml's `pr-set` job (exit evidence); the PR legs run a sample.
 */
const PR_SEED_TABLE: Readonly<Record<string, number>> = Object.freeze({ faults: 15, holds: 15, claims: 15, seats: 15, coord: 15, lifecycle: 10 });
const LEG_SEEDS = 100;
/** Ruling R3-51/55-A: the PR legs' SIM sample (6 edits + 2 faults + 2 holds per leg) inside R3-51's 45-minute job; npm test's job 90. */
const PR_SAMPLE: ReadonlyArray<[string, number]> = Object.freeze([['edits', 6], ['faults', 2], ['holds', 2]]);
const PR_SIM_JOB_MIN = 45;
const PR_TEST_JOB_MIN = 90;

/** The profile groups of a sim:seeds command: `--profile P --seeds N --from F`, in order. */
const seedGroups = (cmd: string): Array<{ profile: string; seeds: number; from: string }> =>
  [...cmd.matchAll(/--profile (\w+) --seeds (\d+) --from (\$\{\{ [\w.]+ \}\}|\d+)/g)].map((m) => ({ profile: m[1]!, seeds: Number(m[2]), from: m[3]! }));

/** tools/sim/leg-budget.ts as the ci.yml step runs it: its exit code, stdout and what it appended to the job summary file. */
function legBudget(args: string[], dir: string): { code: number | null; out: string; summary: string } {
  const summary = join(dir, `summary-${args.join('_').replace(/[^A-Za-z0-9]/g, '')}.md`);
  writeFileSync(summary, '');
  const r = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('tools/sim/leg-budget.ts', REPO)), ...args], {
    cwd: fileURLToPath(REPO), encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
  });
  return { code: r.status, out: r.stdout, summary: readFileSync(summary, 'utf8') };
}

test('ci.yml: each of the six legs runs sim:seeds --profile edits --seeds 6, --profile faults --seeds 2 and --profile holds --seeds 2 with --from 0 on Node 20 legs and --from 100 on Node 24 legs, --parallel 4, timeout-minutes 45, and a final step that reports the leg\'s SIM minutes against 20 as a warning, never a failure; the seeds per OS per PR total 20 (Ruling R3-51/55-A), and every npm test timeout is under the test job\'s 90 minutes', async () => {
  // R-33 as amended by X-113 (rev 2.5), R3-51 and Ruling R3-51/55-A (Plan 3 Task 16 fix round 1): Node 20 legs take each profile's
  // seeds from 0, Node 24 legs from 100; 4 child processes. The job is split in two (Plan 2 Task 19 fix round 1), so the gates run on two
  // runners side by side: `test` (lint … sim:smoke, 90 min) and `sim` (the SIM sample, R3-51's 45 min); each writes its minutes to its job
  // summary (npm test, and SIM against the 20-minute budget). The 100-seed X-113 set is sim-exit.yml's `pr-set` job (the next test).
  const y = read('.github/workflows/ci.yml');
  const jobs = jobsOf(y);
  assert.deepEqual([...jobs.keys()], ['test', 'sim']);
  const testJob = jobs.get('test')!;
  const simJob = jobs.get('sim')!;
  const [tJob] = intsAt(testJob, 4, 'timeout-minutes');
  const [sJob] = intsAt(simJob, 4, 'timeout-minutes');
  assert.ok(tJob !== undefined && sJob !== undefined, 'each job has a timeout');
  assert.equal(sJob, PR_SIM_JOB_MIN, 'R3-51: the sim job\'s timeout-minutes 45');
  assert.equal(tJob, PR_TEST_JOB_MIN, 'Ruling R3-51/55-A (a): npm test\'s job 90 min');
  assert.deepEqual(npmSteps(testJob).map(gate), ['npm run lint', 'npm run typecheck', 'npm run build', 'npm test', 'npm run sim:smoke']);
  assert.deepEqual(npmSteps(simJob).map(gate), ['npm run sim:seeds']);
  for (const j of [testJob, simJob]) {
    assert.match(j, /^ {8}os: \[windows-latest, macos-latest, ubuntu-latest\]\n {8}node: \['20\.x', '24\.x'\]$/m, 'both jobs run the os x node matrix');
    assert.ok(j.indexOf('run: git config --global core.autocrlf true') < j.indexOf('uses: actions/checkout@'), 'core.autocrlf=true on Windows before checkout');
    assert.ok(j.includes('node-version: ${{ matrix.node }}') && j.includes('run: npm ci'));
  }
  assert.doesNotMatch(simJob, /^ {4}needs:/m, 'the seeds run beside the tests, never hidden behind them');
  // The per-Node offsets: every profile group starts at the leg's `from`.
  assert.match(simJob, /^ {10}- node: '20\.x'\n {12}from: 0$/m);
  assert.match(simJob, /^ {10}- node: '24\.x'\n {12}from: 100$/m);
  const seeds = npmSteps(y).filter((c) => gate(c) === 'npm run sim:seeds');
  assert.equal(seeds.length, 1, 'one sim:seeds step: a red group never hides another');
  const cmd = seeds[0]!;
  const groups = seedGroups(cmd);
  // Ruling R3-51/55-A (b): one group per merged profile, each from the leg's offset, the sample's numbers (a later plan that merges a
  // profile adds its group here and to the pr-set job's X-113 set).
  assert.deepEqual(groups.map((g) => g.profile).sort(), [...PROFILES_ALL].sort(), `one group per merged profile: ${cmd}`);
  for (const g of groups) assert.equal(g.from, '${{ matrix.from }}', `${g.profile} starts at the leg's offset`);
  assert.deepEqual(groups.map((g) => [g.profile, g.seeds]), PR_SAMPLE, 'the sample: 6 edits, 2 faults, 2 holds per leg');
  // Two legs per OS (Node 20: [0, n), Node 24: [100, 100 + n) per profile, disjoint since n ≤ 100): 20 seeds per OS per PR.
  const perOs = [0, 100].flatMap((from) => groups.flatMap((g) => Array.from({ length: g.seeds }, (_, k) => `${g.profile}-${from + k}`)));
  assert.equal(new Set(perOs).size, 20, 'Ruling R3-51/55-A: 20 seeds per OS per PR, each once');
  const m = /--parallel 4 --timeout-min (\d+) --seed-timeout-min (\d+) --keep-dir sim-kept --report sim-seeds\.json$/.exec(cmd);
  assert.ok(m !== null, cmd);
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
  // The scan also reads a subtest's timeout followed by other options, a template literal among them (Plan 3 Task 16: Review Focus 3's
  // `{ timeout: (FULL ? 45 : 25) * 60_000, ...skipUnless(`${op}@${point}`) }`, and the crash matrix seed's `{ timeout: 80 * 60_000, … }`).
  const scanned = testTimeoutsMin();
  assert.ok(scanned.some((t) => t.file === 'sim.crash.holds.ops.test.ts' && t.min === 25), 'Review Focus 3\'s subtest timeout is scanned');
  assert.ok(scanned.some((t) => t.file === 'sim.crash.holds.test.ts' && t.min === 80), 'the crash matrix seed\'s subtest timeout is scanned');
  assert.match(simJob, /^ {6}- name: SIM report\n {8}if: \$\{\{ !cancelled\(\) \}\}\n {8}uses: actions\/upload-artifact@v4$/m);
  assert.match(y, /path: \|\n {12}sim-seeds\.json\n {12}sim-kept\/$/m);
  assert.doesNotMatch(y, /--seeds 1000|COWORK_SIM_LONG|TEST_SIM_FULL|test:sim/, 'the exit run and the long tests are never per-push');
  // R3-51, R3-55: the reports never fail a job: the sim job's last step writes its SIM minutes against the 20-minute budget; the
  // test job writes npm test's minutes right after it (its start recorded right before it).
  const lastStep = (j: string): string => j.slice(j.lastIndexOf('\n      - '));
  assert.match(lastStep(simJob), /^\n {6}- name: SIM minutes against the 20-minute leg budget\n {8}if: \$\{\{ !cancelled\(\) \}\}\n {8}run: npx tsx tools\/sim\/leg-budget\.ts --report sim-seeds\.json\n*$/);
  assert.match(testJob, /- name: npm test start\n {8}shell: bash\n {8}run: echo "NPM_TEST_START=\$\(date \+%s\)" >> "\$GITHUB_ENV"\n {6}- run: npm test\n {6}- name: npm test minutes\n {8}if: \$\{\{ !cancelled\(\) \}\}\n {8}shell: bash\n {8}run: npx tsx tools\/sim\/leg-budget\.ts --npm-test-since "\$NPM_TEST_START"\n/, 'npm test\'s minutes: its start recorded right before it, the minutes step right after it');
  for (const j of [testJob, simJob]) assert.doesNotMatch(j, /continue-on-error/, 'the report steps exit 0 themselves');
  // The report script: over 20 minutes a warning annotation, exit 0 either way; its line goes to the job summary.
  const dir = mkdtempSync(join(tmpdir(), 'cowork-leg-budget-'));
  try {
    const report = (wallMin: number): string => {
      const f = join(dir, `r${wallMin}.json`);
      writeFileSync(f, JSON.stringify({
        runs: [{ profile: 'edits', seeds: ['edits-0', 'edits-1'] }, { profile: 'holds', seeds: ['holds-0'] }], wallMs: wallMin * 60_000,
        results: [{ seed: 'edits-0', profile: 'edits', ok: true, ms: 120_000 }, { seed: 'edits-1', profile: 'edits', ok: true, ms: 60_000 }, { seed: 'holds-0', profile: 'holds', ok: false, ms: 300_000 }],
      }));
      return f;
    };
    const over = legBudget(['--report', report(25)], dir);
    assert.equal(over.code, 0, over.out);
    assert.match(over.out, /^SIM 25\.0 min of the 20-minute leg budget \(11-testing §3\.11\): edits 2 seeds \(3\.0 seed-min\), holds 1 seeds \(5\.0 seed-min\)$/m);
    assert.match(over.out, /^::warning title=SIM leg budget::SIM 25\.0 min is over the 20-minute leg budget/m);
    assert.match(over.summary, /^SIM 25\.0 min of the 20-minute leg budget/m);
    assert.doesNotMatch(over.summary, /::warning/, 'annotations go to the log, not the summary');
    const under = legBudget(['--report', report(12)], dir);
    assert.equal(under.code, 0);
    assert.doesNotMatch(under.out, /::warning/);
    const missing = legBudget(['--report', join(dir, 'none.json')], dir);
    assert.equal(missing.code, 0, 'a missing report is a warning, never a failure');
    assert.match(missing.out, /^::warning title=SIM leg budget::no run-seeds report/m);
    const npmTest = legBudget(['--npm-test-since', String(Math.floor(Date.now() / 1_000) - 15 * 60)], dir);
    assert.equal(npmTest.code, 0);
    assert.match(npmTest.summary, /^npm test 1[45]\.\d min$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sim-exit.yml pr-set: on each OS and Node leg the 100-seed X-113 set — every merged non-edits profile at its fixed count (faults 15, holds 15), edits the remainder (70), --from 0 on Node 20 legs and --from 100 on Node 24 legs, --parallel 4 — so 200 seeds per OS, under measured timeouts, its report uploaded and its SIM minutes reported against the 20-minute leg budget (Ruling R3-51/55-A (c))', () => {
  // R3-51's per-PR set (X-113) moved here by Ruling R3-51/55-A: every seed asserts all sixteen oracles after every op, so 100 seeds per leg
  // never fit a PR leg; they run with the exit run (dispatched on the public repository), the PR legs a sample (the previous test).
  const x = read('.github/workflows/sim-exit.yml');
  const job = jobsOf(x).get('pr-set');
  assert.ok(job !== undefined, 'the pr-set job');
  assert.match(job, /^ {8}os: \[windows-latest, macos-latest, ubuntu-latest\]\n {8}node: \['20\.x', '24\.x'\]$/m, 'the os x node matrix');
  assert.match(job, /^ {10}- node: '20\.x'\n {12}from: 0$/m);
  assert.match(job, /^ {10}- node: '24\.x'\n {12}from: 100$/m);
  assert.ok(job.includes('node-version: ${{ matrix.node }}') && job.includes('run: npm ci'));
  assert.ok(job.indexOf('run: git config --global core.autocrlf true') < job.indexOf('uses: actions/checkout@'), 'core.autocrlf=true on Windows before checkout');
  const runs = npmSteps(job).filter((c) => gate(c) === 'npm run sim:seeds');
  assert.equal(runs.length, 1, 'one sim:seeds step: a red group never hides another');
  const cmd = runs[0]!;
  const groups = seedGroups(cmd);
  // X-113: 100 per leg; every merged non-edits profile (every profile run-seeds runs besides edits) at its table count; edits the rest.
  assert.deepEqual(groups.map((g) => g.profile).sort(), [...PROFILES_ALL].sort(), `one group per merged profile: ${cmd}`);
  for (const g of groups) assert.equal(g.from, '${{ matrix.from }}', `${g.profile} starts at the leg's offset`);
  const others = groups.filter((g) => g.profile !== 'edits');
  for (const g of others) assert.equal(g.seeds, PR_SEED_TABLE[g.profile], `${g.profile}: its X-113 count`);
  const edits = groups.find((g) => g.profile === 'edits')!;
  assert.equal(edits.seeds, LEG_SEEDS - others.reduce((s, g) => s + g.seeds, 0), 'edits takes the remainder');
  assert.equal(groups.reduce((s, g) => s + g.seeds, 0), LEG_SEEDS, 'every leg runs 100 seeds');
  // While Plan 3 is the last merged plan: 70 edits, 15 faults, 15 holds.
  assert.deepEqual(groups.map((g) => [g.profile, g.seeds]), [['edits', 70], ['faults', 15], ['holds', 15]]);
  // Two legs per OS (Node 20: [0, n), Node 24: [100, 100 + n) per profile, disjoint since n ≤ 100): 200 seeds per OS.
  const perOs = [0, 100].flatMap((from) => groups.flatMap((g) => Array.from({ length: g.seeds }, (_, k) => `${g.profile}-${from + k}`)));
  assert.equal(new Set(perOs).size, 200, 'glossary §20 CI row: 200 seeds per OS, each once');
  const m = /--parallel 4 --timeout-min (\d+) --seed-timeout-min (\d+) --keep-dir sim-kept --report sim-seeds\.json$/.exec(cmd);
  assert.ok(m !== null, cmd);
  const [jobMin] = intsAt(job, 4, 'timeout-minutes');
  const [stepMin] = intsAt(job, 8, 'timeout-minutes');
  const runMin = Number(m[1]);
  const seedMin = Number(m[2]);
  assert.ok(seedMin < runMin && runMin < stepMin! && stepMin! < jobMin! && jobMin! <= 360, `seed ${seedMin} < run ${runMin} < step ${stepMin} < job ${jobMin} <= 360`);
  assert.match(job, /- name: SIM report\n {8}if: \$\{\{ !cancelled\(\) \}\}\n {8}uses: actions\/upload-artifact@v4\n {8}with:\n {10}name: sim-pr-set-\$\{\{ matrix\.os \}\}-node\$\{\{ matrix\.node \}\}\n/, 'its report uploaded');
  const lastStep = job.slice(job.lastIndexOf('\n      - '));
  assert.match(lastStep, /^\n {6}- name: SIM minutes against the 20-minute leg budget\n {8}if: \$\{\{ !cancelled\(\) \}\}\n {8}run: npx tsx tools\/sim\/leg-budget\.ts --report sim-seeds\.json\n*$/);
});

/** The holds shards of sim-exit.yml: s (HOLDS_SHARD_SEEDS), the shard list, and the seeds each shard runs (the step's arithmetic). */
function holdsShards(job: string): { s: number; shards: number[]; seeds: Map<number, number[]> } {
  const s = Number(/^ {6}HOLDS_SHARD_SEEDS: (\d+)$/m.exec(job)?.[1] ?? NaN);
  const list = /^ {8}shard: \[([0-9, ]+)\]$/m.exec(job)?.[1] ?? '';
  const shards = list.split(',').map((x) => Number(x.trim()));
  const seeds = new Map<number, number[]>();
  for (const k of shards) {
    // The step: from = k·s, seeds = min(s, 1000 − k·s).
    const from = k * s;
    const n = Math.min(s, 1000 - from);
    seeds.set(k, Array.from({ length: Math.max(0, n) }, (_, i) => from + i));
  }
  return { s, shards, seeds };
}

test('sim-exit.yml keeps workflow_dispatch and its schedule and, per OS, runs npm run test:sim once, 10 edits shards and holds shards covering seeds 0…999 exactly once (run-seeds --profile holds --seeds s --from s·k --prefix exit- --parallel 4, s ≤ 100 sized from the p95 per-seed time this task recorded per OS from the PR legs, R3-58, timeout-minutes 120, report uploaded); the ledger names each OS\'s p50/p95 and the s derived from it; package.json scripts sim:exit:holds (run-seeds --profile holds --seeds 1000 --parallel 8) and test:sim (npm test with TEST_SIM_FULL=1)', () => {
  const x = read('.github/workflows/sim-exit.yml');
  assert.equal(x.includes('\r') || x.includes('\t'), false, 'sim-exit.yml is LF-only and tab-free');
  assert.match(x, /^ {2}workflow_dispatch:$/m);
  assert.match(x, /^ {2}schedule:\n {4}- cron: '[0-9 *]+'$/m);
  assert.doesNotMatch(x, /^ {2}(push|pull_request):/m, 'never on push or pull request');
  const jobs = jobsOf(x);
  assert.deepEqual([...jobs.keys()], ['test-sim', 'pr-set', 'shard', 'holds', 'summary', 'holds-summary']);
  for (const [id, j] of jobs) assert.match(j, /^ {8}os: \[windows-latest, macos-latest, ubuntu-latest\]$/m, `${id}: per OS`);

  // npm run test:sim once per OS (R3-55), under a step timeout that holds its full forms (hosted jobs end at 360 min).
  const ts = jobs.get('test-sim')!;
  assert.equal([...x.matchAll(/run: npm run test:sim$/gm)].length, 1, 'one test:sim run per OS');
  assert.match(ts, /run: npm run test:sim$/m);
  const [tsJob] = intsAt(ts, 4, 'timeout-minutes');
  const [tsStep] = intsAt(ts, 8, 'timeout-minutes');
  assert.equal(tsStep, 330, 'the controller ruling: 330 min (the holds 20-seed TEST_SIM_FULL loop alone measured 8,025 s)');
  assert.ok(tsStep! < tsJob! && tsJob! <= 360, `step ${tsStep} < job ${tsJob} <= 360`);
  assert.ok(ts.indexOf('run: git config --global core.autocrlf true') < ts.indexOf('uses: actions/checkout@'), 'core.autocrlf=true on Windows before checkout');

  // The 10 edits shards of roadmap row 2 (unchanged).
  const shard = jobs.get('shard')!;
  assert.match(shard, /^ {8}shard: \[0, 1, 2, 3, 4, 5, 6, 7, 8, 9\]$/m);
  assert.ok(shard.includes('run: npm run sim:seeds -- --profile edits --seeds 100 --from $(( ${{ matrix.shard }} * 100 )) --parallel 4 --timeout-min 140 --seed-timeout-min 30 --keep-dir sim-kept --report sim-exit-${{ matrix.os }}-${{ matrix.shard }}.json'), 'each shard runs its 100 edits seeds');
  const [shardJob] = intsAt(shard, 4, 'timeout-minutes');
  const [shardStep] = intsAt(shard, 8, 'timeout-minutes');
  assert.ok(140 < (shardStep ?? 0) && (shardStep ?? 0) < (shardJob ?? 0), `deadline 140 < step ${shardStep} < job ${shardJob}`);
  const summary = jobs.get('summary')!;
  assert.ok(summary.includes('pattern: sim-exit-${{ matrix.os }}-*'));
  assert.ok(summary.includes('run: npx tsx tools/sim/exit-verdict.ts --reports reports --profile edits --from 0 --seeds 1000 --label ${{ matrix.os }}'));

  // The holds shards (R3-51, R3-55, R3-58): seeds exit-holds-0 … exit-holds-999, each exactly once, s ≤ 100 per shard.
  const holds = jobs.get('holds')!;
  const { s, shards, seeds } = holdsShards(holds);
  assert.ok(Number.isInteger(s) && s >= 1 && s <= 100, `s = ${s}`);
  assert.deepEqual(shards, Array.from({ length: Math.ceil(1000 / s) }, (_, k) => k), 'shards 0 … ⌈1000 / s⌉ − 1');
  const all = [...seeds.values()].flat();
  assert.equal(all.length, 1000, 'every seed once');
  assert.deepEqual([...new Set(all)].sort((a, b) => a - b), Array.from({ length: 1000 }, (_, i) => i), 'seeds 0 … 999');
  // The step's arithmetic (what holdsShards simulates): from = k·s, n = min(s, 1,000 − from).
  assert.ok(holds.includes([
    '        run: |',
    '          from=$(( ${{ matrix.shard }} * HOLDS_SHARD_SEEDS ))',
    '          n=$(( 1000 - from ))',
    '          if [ "$n" -gt "$HOLDS_SHARD_SEEDS" ]; then n=$HOLDS_SHARD_SEEDS; fi',
    '          npm run sim:seeds -- --profile holds --seeds "$n" --from "$from" --prefix exit- --parallel 4 --timeout-min 100 --seed-timeout-min 30 --keep-dir sim-kept --report sim-exit-holds-${{ matrix.os }}-${{ matrix.shard }}.json',
  ].join('\n')), 'each holds shard runs its seeds');
  assert.equal([...x.matchAll(/npm run sim:seeds -- --profile holds /g)].length, 1, 'one holds seed run per shard job');
  assert.match(holds, /^ {8}shell: bash$/m, 'the shard arithmetic runs in bash on every OS');
  const [holdsJob] = intsAt(holds, 4, 'timeout-minutes');
  const [holdsStep] = intsAt(holds, 8, 'timeout-minutes');
  assert.equal(holdsJob, 120, 'R3-55: timeout-minutes 120 per holds shard');
  assert.ok(100 < (holdsStep ?? 0) && (holdsStep ?? 0) < 120, `deadline 100 < step ${holdsStep} < job 120`);
  assert.match(holds, /- name: Report\n {8}if: \$\{\{ !cancelled\(\) \}\}\n {8}uses: actions\/upload-artifact@v4\n {8}with:\n {10}name: sim-exit-holds-\$\{\{ matrix\.os \}\}-\$\{\{ matrix\.shard \}\}\n/, 'each holds shard uploads its report');
  // GitHub runs at most 256 jobs from one matrix: the holds shards of the three OSes stay under it.
  assert.ok(3 * shards.length <= 256, `${3 * shards.length} holds shard jobs`);
  const hs = jobs.get('holds-summary')!;
  assert.match(hs, /^ {4}needs: holds$/m);
  assert.ok(hs.includes('pattern: sim-exit-holds-${{ matrix.os }}-*'));
  assert.ok(hs.includes('run: npx tsx tools/sim/exit-verdict.ts --reports reports --profile holds --prefix exit- --from 0 --seeds 1000 --label ${{ matrix.os }}'));
  // The ledger line (R3-58): the YAML names the measured p50/p95 per OS and s = min(100, ⌊0.8 × 120 min × 4 ÷ p95⌋); before the
  // measurement (the first commit of Task 16) s is the provisional 20.
  const ledger = [...holds.matchAll(/^ {4}# (windows-latest|macos-latest|ubuntu-latest|every OS): p50 (\d+) s, p95 (\d+) s per holds seed\b.*$/gm)];
  if (ledger.length === 0) {
    assert.equal(s, 20, 'before the measurement: the provisional s = 20 (R3-58)');
    assert.match(holds, /# R3-58: provisional s = 20 until the p95 per-seed time is measured/);
  } else {
    const named = ledger.map((l) => l[1]);
    assert.ok(named.includes('every OS') || ['macos-latest', 'ubuntu-latest', 'windows-latest'].every((o) => named.includes(o)), `every OS has a measured p95: ${named.join(', ')}`);
    const derived = Math.min(...ledger.map((l) => Math.min(100, Math.floor((0.8 * 120 * 60 * 4) / Number(l[3])))));
    assert.equal(s, derived, `s = min over the OSes of min(100, ⌊0.8 × 120 min × 4 ÷ p95⌋) = ${derived}`);
    assert.match(holds, /^ {4}# R3-58 \(provisional\): .*re-derive/m, 'the measurement is named provisional until a hosted run re-derives it');
  }

  // package.json (R3-55): the local rehearsal, and npm test with TEST_SIM_FULL=1 through the launcher's --sim-full.
  const s2 = scripts();
  assert.equal(s2['sim:exit:holds'], 'tsx tools/sim/run-seeds.ts --profile holds --seeds 1000 --parallel 8');
  assert.equal(s2['test:sim'], (s2['test'] ?? '').replace('tools/test/run-tests.mjs ', 'tools/test/run-tests.mjs --sim-full '));
  assert.notEqual(s2['test:sim'], s2['test']);

  // The exit artifact stays coupled to nothing else: the long Plan 2 tests and the rehearsal live in sim-long.yml.
  assert.doesNotMatch(x, /COWORK_SIM_LONG|COWORK_REAL_REHEARSAL|real\.twoclone/);
  // Task 20 and Task 18 carries, and the M18 ruling: the long SIM tests (with Task 9's diskEq test, M18's catcher) and the
  // real-remote rehearsal, which runs even when the long SIM tests fail.
  const l = read('.github/workflows/sim-long.yml');
  assert.equal(l.includes('\r') || l.includes('\t'), false, 'sim-long.yml is LF-only and tab-free');
  assert.match(l, /^ {2}workflow_dispatch:$/m);
  assert.doesNotMatch(l, /^ {2}(push|pull_request):/m, 'never on push or pull request');
  assert.match(l, /COWORK_SIM_LONG: '1'\n {8}run: npx tsx --test test\/integration\/sim\.engine\.test\.ts test\/integration\/sim\.oracles\.plan2\.test\.ts test\/integration\/sim\.crash\.test\.ts test\/integration\/diskEq\.test\.ts$/m);
  assert.match(l, /- name: Real-remote rehearsal\n {8}if: \$\{\{ !cancelled\(\) \}\}\n(?: {8}.*\n)*? {8}run: npx tsx --test test\/integration\/real\.twoclone\.test\.ts$/m);
});

test('npm run test:sim runs npm test\'s files with TEST_SIM_FULL=1 in every test file\'s environment (cross-platform, no dependency); npm test leaves it unset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-test-sim-'));
  try {
    writeFileSync(join(dir, 'env.test.ts'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('env', () => { assert.equal(process.env['TEST_SIM_FULL'], '1'); });\n");
    const launcher = fileURLToPath(new URL('tools/test/run-tests.mjs', REPO));
    const env = { ...process.env };
    delete env['TEST_SIM_FULL'];
    delete env['NODE_TEST_CONTEXT'];   // the launcher's own test runner, not a child of this one
    const full = spawnSync(process.execPath, [launcher, '--sim-full', dir], { cwd: fileURLToPath(REPO), encoding: 'utf8', env });
    assert.equal(full.status, 0, full.stdout + full.stderr);
    const plain = spawnSync(process.execPath, [launcher, dir], { cwd: fileURLToPath(REPO), encoding: 'utf8', env });
    assert.equal(plain.status, 1, 'without --sim-full the variable is not set');
    const runTests = read('tools/test/run-tests.mjs');
    assert.match(runTests, /if \(simFull\) \{\n {2}process\.env\.TEST_SIM_FULL = '1';/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
