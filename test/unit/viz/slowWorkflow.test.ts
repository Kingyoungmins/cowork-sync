// Plan 8a Task 15 (fix round 1): the viewer's slow-suite workflow, .github/workflows/viz-slow.yml (contract Global Constraints, "CI wall
// time"; 12 §7). T-VIZ-contention has a floor of 2 phases × 3,000 writes × 100 ms = 10 min of writer sleep before any fetch is counted
// (1,476 s measured on a loaded PC), so it runs in a windows-latest-only job of its own (40 min) that outlasts the test's own timeout,
// and never shares a runner or a budget with T-VIZ-perf's time and CPU measurements; perf and golden board keep the three OS legs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('viz-slow.yml: T-VIZ-contention runs alone in a windows-latest-only job (40 min) that outlasts its own test timeout; perf and golden board run on the three OS legs in a job without it; no step builds an unused dist', () => {
  const y = read('.github/workflows/viz-slow.yml');
  assert.equal(y.includes('\r') || y.includes('\t'), false, 'LF-only and tab-free');
  const jobs = jobsOf(y);
  assert.deepEqual([...jobs.keys()], ['slow', 'contention']);
  const slow = jobs.get('slow')!;
  const contention = jobs.get('contention')!;
  for (const j of [slow, contention]) {
    assert.ok(j.indexOf('run: git config --global core.autocrlf true') < j.indexOf('uses: actions/checkout@'), 'core.autocrlf=true on Windows before checkout');
    assert.ok(j.includes("node-version: '24.x'") && j.includes('run: npm ci'), 'Node 24 and npm ci');
    assert.match(j, /^ {10}COWORK_VIZ_SLOW: '1'$/m);
  }

  // perf and golden board: three legs, 30 min, one file at a time, never the contention suite.
  assert.deepEqual(intsAt(slow, 4, 'timeout-minutes'), [30]);
  assert.match(slow, /^ {4}runs-on: \$\{\{ matrix\.os \}\}$/m);
  assert.match(slow, /^ {8}os: \[windows-latest, macos-latest, ubuntu-latest\]$/m);
  assert.ok(slow.includes('run: npx tsx --test --test-concurrency=1 test/integration/viz/perf.test.ts test/integration/viz/golden.board.test.ts'));
  assert.deepEqual(testFiles(slow), ['test/integration/viz/perf.test.ts', 'test/integration/viz/golden.board.test.ts']);

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
