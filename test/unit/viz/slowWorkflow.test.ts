// Plan 8a Task 15 (fix round 1): the viewer's slow-suite workflow, .github/workflows/viz-slow.yml (contract Global Constraints, "CI wall
// time"; 12 §7). T-VIZ-contention has a floor of 2 phases × 3,000 writes × 100 ms = 10 min of writer sleep before any fetch is counted
// (1,476 s measured on a loaded PC), so it runs in a windows-latest-only job of its own (40 min) that outlasts the test's own timeout,
// and never shares a runner or a budget with T-VIZ-perf's time and CPU measurements; perf and golden board keep the three OS legs.
// Task 18 step B1: T-VIZ-golden-sim (six SIM runs of the real engine, ≈ 7 min on a Windows PC) runs on the three OS legs in a job
// of its own, so it neither loads a runner while T-VIZ-perf measures nor shares the perf job's 30 min. Its fix round 1: the
// golden-sim legs upload the timelines the test computed (test-results/viz-golden-sim/, also when it fails), and the
// dispatch-only .github/workflows/viz-golden-linux.yml runs that test alone on ubuntu-latest, so the Linux SIM goldens (12 §7)
// come from one cheap run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = new URL('../../../', import.meta.url);
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, REPO)), 'utf8');
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
/** The test files a job runs. */
const testFiles = (job: string): string[] => [...job.matchAll(/test\/integration\/viz\/[\w.-]+\.test\.ts/g)].map((m) => m[0]);
/** The workflow's `on:` block (from `on:` up to the next line that starts at column 0), without trailing blank lines. */
function onBlock(y: string): string {
  const rest = y.slice(y.search(/^on:$/m));
  const first = rest.indexOf('\n') + 1;
  const end = rest.slice(first).search(/^\S/m);
  return (end < 0 ? rest : rest.slice(0, first + end)).trimEnd();
}
/** A job's core.autocrlf=true step (TST-13): present, guarded to Windows, and before checkout. */
function autocrlfBeforeCheckout(job: string): boolean {
  const step = job.search(/^ {6}- name: core\.autocrlf=true \(Windows\)\n {8}if: runner\.os == 'Windows'\n {8}run: git config --global core\.autocrlf true\n/m);
  const checkout = job.indexOf('      - uses: actions/checkout@');
  return step >= 0 && checkout >= 0 && step < checkout;
}
/** The upload of the timelines the golden SIM test computed (tools/viz/golden.ts SIM_RESULTS_DIR), also when the test fails. */
const upload = (name: string): string => [
  '      - name: Upload the computed SIM timelines',
  '        if: always()',
  '        uses: actions/upload-artifact@v4',
  '        with:',
  `          name: ${name}`,
  '          path: test-results/viz-golden-sim/',
  '',
].join('\n');
/** The golden SIM test's own timeout in seconds (exactly one `timeout:` option in its file). */
function goldenSimTimeoutS(): number {
  const timeouts = [...read('test/integration/viz/golden.sim.test.ts').matchAll(/^\s+timeout: ([\d_]+),$/gm)].map((m) => Number(m[1]!.replace(/_/g, '')));
  assert.equal(timeouts.length, 1, 'one test timeout in golden.sim.test.ts');
  return timeouts[0]! / 1_000;
}

test('viz-slow.yml: T-VIZ-contention runs alone in a windows-latest-only job (40 min) that outlasts its own test timeout; perf, golden board and the every-height git source run on the three OS legs in a job without it, the browser smoke and the demo end to end on the Linux leg (also after a failed perf step, a missing browser failing them); every pull request touching what the suites run triggers it; golden SIM runs on the three OS legs in a job of its own whose test timeout fits it and which uploads the computed timelines; every job with a Windows leg sets core.autocrlf first; no step builds an unused dist', () => {
  const y = read('.github/workflows/viz-slow.yml');
  assert.equal(y.includes('\r') || y.includes('\t'), false, 'LF-only and tab-free');
  const header = y.slice(0, y.search(/^on:$/m));
  assert.doesNotMatch(header, /both jobs/, 'the header comment counts no jobs');
  assert.match(header, /\(every job, every leg\)/);
  // The trigger: every pull request that touches what the slow suites run — the viewer and the board, and also what they build on
  // (the engine the SIM runs and BoardWriter's refs, git, text, i18n, the data directory, the ports, the SDDL check, the version
  // string), the tools and test helpers they import, the dependencies and this file (Plan 8a final review, fix Group D).
  const TRIGGER = [
    'src/viz/**', 'src/board/**', 'src/engine/**', 'src/git/**', 'src/text/**', 'src/i18n/**', 'src/data/**', 'src/ports/**', 'src/sec/**',
    'src/version.ts', 'tools/viz/**', 'tools/sim/**', 'tools/build/**', 'test/**/viz/**', 'test/sim/**', 'test/helpers/**',
    'package.json', 'package-lock.json', '.github/workflows/viz-slow.yml',
  ];
  assert.equal(onBlock(y), ['on:', '  pull_request:', '    paths:', ...TRIGGER.map((p) => `      - '${p}'`), '  workflow_dispatch:'].join('\n'));
  for (const p of TRIGGER) {
    const at = p.replace(/\/\*\*$/, '').replace('test/**/viz', 'test/integration/viz');
    assert.ok(existsSync(fileURLToPath(new URL(at, REPO))), `${p} names something in the repository`);
  }
  const jobs = jobsOf(y);
  assert.deepEqual([...jobs.keys()], ['slow', 'golden-sim', 'contention']);
  const slow = jobs.get('slow')!;
  const goldenSim = jobs.get('golden-sim')!;
  const contention = jobs.get('contention')!;
  for (const j of [slow, goldenSim, contention]) {
    assert.ok(j.includes("node-version: '24.x'") && j.includes('run: npm ci'), 'Node 24 and npm ci');
    assert.match(j, /^ {10}COWORK_VIZ_SLOW: '1'$/m);
  }

  // Every job with a Windows leg uses the Git for Windows checkout profile (11-testing TST-13): the step exists and precedes
  // checkout. The check fails a job without the step (it is not satisfied by indexOf's -1).
  const windowsJobs = [...jobs].filter(([, j]) => j.includes('windows-latest'));
  assert.deepEqual(windowsJobs.map(([id]) => id), ['slow', 'golden-sim', 'contention']);
  for (const [id, j] of windowsJobs) assert.ok(autocrlfBeforeCheckout(j), `${id}: core.autocrlf=true on Windows before checkout`);
  const withoutStep = contention.replace(/^ {6}- name: core\.autocrlf=true \(Windows\)\n(?: {8}.*\n)+/m, '');
  assert.notEqual(withoutStep, contention, 'the control removed the step');
  assert.equal(autocrlfBeforeCheckout(withoutStep), false, 'a job without the step fails the check');

  // perf, golden board and the every-height git source: three legs, 30 min, one file at a time, never the contention suite.
  // gitSource.test.ts checks every height of its board against the per-oid reference only with COWORK_VIZ_SLOW=1 (its sampled
  // heights otherwise), so this job is where that mode runs (Plan 8a final review, fix Group D).
  assert.deepEqual(intsAt(slow, 4, 'timeout-minutes'), [30]);
  assert.match(slow, /^ {4}runs-on: \$\{\{ matrix\.os \}\}$/m);
  assert.match(slow, /^ {8}os: \[windows-latest, macos-latest, ubuntu-latest\]$/m);
  assert.ok(slow.includes('        run: npx tsx --test --test-concurrency=1 test/integration/viz/perf.test.ts test/integration/viz/golden.board.test.ts test/integration/viz/gitSource.test.ts\n'));
  assert.deepEqual(testFiles(slow), [
    'test/integration/viz/perf.test.ts', 'test/integration/viz/golden.board.test.ts', 'test/integration/viz/gitSource.test.ts',
    'test/integration/viz/browserSmoke.test.ts', 'test/integration/viz/demoE2E.test.ts',
  ]);

  // The browser smoke with the page budgets (R-V41: "the browser smoke on one" leg asserts page JS heap and page CPU while
  // animating; Task 17 review ruling) and the demo end to end in Chrome: their own step on the Linux leg, after the perf suites,
  // with COWORK_VIZ_SLOW=1. It runs also when the perf step failed (!cancelled(), not the implicit success()), so a red perf
  // never hides the page budgets; and with COWORK_VIZ_REQUIRE_BROWSER=1 a leg without Chrome fails those files instead of
  // skipping them (Plan 8a final review, fix Group D).
  const smokeAt = slow.indexOf('      - name: Viewer browser smoke');
  const smoke = slow.slice(smokeAt);
  assert.ok(smokeAt > slow.indexOf('perf.test.ts'), 'after the perf suites');
  assert.match(smoke, /^ {8}if: \$\{\{ !cancelled\(\) && runner\.os == 'Linux' \}\}$/m);
  assert.doesNotMatch(smoke, /^ {8}if: runner\.os == 'Linux'$/m, 'not skipped after a failed perf step');
  assert.match(smoke, /^ {10}COWORK_VIZ_SLOW: '1'$/m);
  assert.match(smoke, /^ {10}COWORK_VIZ_REQUIRE_BROWSER: '1'$/m);
  assert.ok(smoke.includes('        run: npx tsx --test --test-concurrency=1 test/integration/viz/browserSmoke.test.ts test/integration/viz/demoE2E.test.ts\n'));
  assert.deepEqual(testFiles(smoke), ['test/integration/viz/browserSmoke.test.ts', 'test/integration/viz/demoE2E.test.ts']);
  // The perf step itself never requires a browser (only the smoke step sets the switch).
  assert.equal([...y.matchAll(/^\s+COWORK_VIZ_REQUIRE_BROWSER:/gm)].length, 1, 'the switch is set in the smoke step only');

  // golden SIM: three legs, 30 min, the suite alone, beside the perf legs (never behind them); the test's own timeout leaves
  // 5 min of the job for checkout and npm ci; every leg uploads what the test computed, also when it fails.
  assert.deepEqual(intsAt(goldenSim, 4, 'timeout-minutes'), [30]);
  assert.match(goldenSim, /^ {4}runs-on: \$\{\{ matrix\.os \}\}$/m);
  assert.match(goldenSim, /^ {8}os: \[windows-latest, macos-latest, ubuntu-latest\]$/m);
  assert.match(goldenSim, /^ {6}fail-fast: false$/m);
  assert.doesNotMatch(goldenSim, /^ {4}needs:/m);
  assert.ok(goldenSim.includes('run: npx tsx --test test/integration/viz/golden.sim.test.ts'));
  assert.deepEqual(testFiles(goldenSim), ['test/integration/viz/golden.sim.test.ts']);
  const simS = goldenSimTimeoutS();
  assert.ok(simS >= 1_200, `the golden SIM test's timeout ${simS} s: room above the ≈ 7 min measured on an idle Windows PC`);
  assert.ok(simS / 60 + 5 <= 30, `the test's ${simS / 60} min timeout under the 30 min job`);
  const up = upload('viz-golden-sim-${{ matrix.os }}');
  assert.ok(goldenSim.includes(up), 'the upload step');
  assert.ok(goldenSim.indexOf(up) > goldenSim.indexOf('golden.sim.test.ts'), 'after the test');

  // contention: windows-latest only, a job of its own, 40 min, the suite alone.
  assert.match(contention, /^ {4}runs-on: windows-latest$/m);
  assert.doesNotMatch(contention, /matrix/, 'no OS matrix');
  assert.doesNotMatch(contention, /^ {4}needs:/m, 'beside the perf legs, never behind them');
  const [jobMin] = intsAt(contention, 4, 'timeout-minutes');
  assert.equal(jobMin, 40);
  assert.deepEqual(testFiles(contention), ['test/integration/viz/contention.test.ts']);

  // The test's own timeout: room above the 1,476 s measured, and at least 5 min of the job left for checkout and npm ci.
  const timeouts = [...read('test/integration/viz/contention.test.ts').matchAll(/^\s+timeout: ([\d_]+),$/gm)].map((m) => Number(m[1]!.replace(/_/g, '')));
  assert.equal(timeouts.length, 1, 'one test timeout');
  const testS = timeouts[0]! / 1_000;
  assert.ok(testS >= 2_100, `the contention test's timeout ${testS} s`);
  assert.ok(testS / 60 + 5 <= jobMin!, `the test's ${testS / 60} min timeout under the ${jobMin} min job`);

  // The suites build their own dist (buildDistOnce, perf) or none, so the workflow builds nothing.
  assert.doesNotMatch(y, /npm run build/);
});

test('viz-golden-linux.yml: dispatch-only, one ubuntu-latest job (45 min) that runs the golden SIM test with COWORK_VIZ_SLOW=1 and uploads test-results/viz-golden-sim/ also when it fails — the Linux SIM goldens (12 §7) without macOS or Windows minutes', () => {
  const l = read('.github/workflows/viz-golden-linux.yml');
  assert.equal(l.includes('\r') || l.includes('\t'), false, 'LF-only and tab-free');
  assert.equal(onBlock(l), 'on:\n  workflow_dispatch:', 'dispatch only: no pull_request, push or schedule trigger');
  assert.match(l, /^permissions:\n {2}contents: read$/m);
  const jobs = jobsOf(l);
  assert.equal(jobs.size, 1, 'one job');
  const job = [...jobs.values()][0]!;
  assert.match(job, /^ {4}runs-on: ubuntu-latest$/m);
  assert.doesNotMatch(job, /matrix|windows|macos/i, 'no OS matrix and no other leg');
  assert.deepEqual(intsAt(job, 4, 'timeout-minutes'), [45]);
  assert.ok(job.includes("node-version: '24.x'") && job.includes('run: npm ci'), 'Node 24 and npm ci');
  assert.match(job, /^ {10}COWORK_VIZ_SLOW: '1'$/m);
  assert.ok(job.includes('        run: npx tsx --test test/integration/viz/golden.sim.test.ts\n'));
  assert.deepEqual(testFiles(job), ['test/integration/viz/golden.sim.test.ts']);
  const up = upload('viz-golden-sim-ubuntu-latest');
  assert.ok(job.includes(up), 'the upload step');
  assert.ok(job.indexOf(up) > job.indexOf('golden.sim.test.ts'), 'after the test');
  const simS = goldenSimTimeoutS();
  assert.ok(simS / 60 + 5 <= 45, `the test's ${simS / 60} min timeout under the 45 min job`);
  assert.doesNotMatch(l, /npm run build/);
});
