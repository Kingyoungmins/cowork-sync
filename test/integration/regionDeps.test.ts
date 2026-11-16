// The region runtime's two bindings and the daemon pool's lifecycle (B3-05, R4-36, R4-78, X-34; audit findings #14 and #15).
// productionRegionDeps runs over a REAL build (tools/build/build.mjs --outdir <temp>): it loads <out>/grammars and spawns the two
// thread workers on <out>/worker.js, and every grammar reads 'ok' — an answer only live workers that loaded the shipped grammars
// can give (a pool with no worker.js reads all 'unavailable'). The build writes nothing under src/. A distDir without grammars/
// rejects with RegionRuntimeMissingError, and close() ends both threads: a child process that built and closed the pool exits on
// its own (live worker_threads would keep it alive until the timeout). runDaemon, in a child process over the same build, closes
// the pool exactly once after the drain and on a start refused after the pool, spawns none on a refusal before it, and passes
// its one security Log in. testRegionDeps binds the tests' runtime through inline workers with budgets on the caller's clock and
// injector.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { productionRegionDeps } from '../../src/engine/regionDeps.js';
import { realFs } from '../../src/ports/fs.js';
import { BUDGETS, testBudgetInjector } from '../../src/regions/budgets.js';
import { LANGUAGES, RegionRuntimeMissingError } from '../../src/regions/runtime.js';
import { QUIET_MS } from '../../src/engine/snapshot.js';
import { regionTempRoot, testRegionRuntime } from '../helpers/regionRuntime.js';
import { testRegionDeps } from '../helpers/regionDeps.js';
import { makeTempRoot, testRunner } from '../helpers/tmp.js';
import { clonePeer, seedRemote } from '../sim/peers.js';
import { createBareRemote } from '../sim/remote.js';
import { VirtualClock } from '../sim/vclock.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CHILD = join(ROOT, 'test', 'helpers', 'regionPoolChild.ts');
const SRC_GRAMMARS = join(ROOT, 'src', 'grammars');
/** Whether an untracked src/grammars/ existed before this file's build (an older build.mjs wrote one; audit #15). */
const srcGrammarsBefore = existsSync(SRC_GRAMMARS);

let built: Promise<string> | undefined;
/** One real build into this process's temp root (spaces and non-ASCII in the path), shared by the tests of this file. */
function dist(): Promise<string> {
  built ??= (async () => {
    const out = join(await regionTempRoot(), 'plugin', 'dist');
    const b = spawnSync(process.execPath, [join(ROOT, 'tools', 'build', 'build.mjs'), '--outdir', out], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(b.status, 0, `the build failed:\n${b.stdout}\n${b.stderr}`);
    return out;
  })();
  return built;
}

/** node --import tsx <the child> <argv>: returns once the child has exited by itself, or fails at the timeout. */
function child(argv: readonly string[], timeoutMs: number): { out: string; err: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', CHILD, ...argv], { cwd: ROOT, encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  assert.equal(r.error, undefined, `the child did not exit on its own within ${timeoutMs} ms (a live worker thread keeps a process alive): ${String(r.error)}\n${r.stdout}\n${r.stderr}`);
  assert.equal(r.signal, null, `the child was stopped by ${String(r.signal)}:\n${r.stdout}\n${r.stderr}`);
  assert.equal(r.status, 0, `the child failed:\n${r.stdout}\n${r.stderr}`);
  return { out: r.stdout, err: r.stderr };
}

/** Every .ts file under dir, as repository paths with '/'. */
function sources(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

test('productionRegionDeps loads dist/grammars and spawns the two workers', T10, async () => {
  const out = await dist();
  if (!srcGrammarsBefore) assert.equal(existsSync(SRC_GRAMMARS), false, 'the build writes nothing under src/ (no src/grammars/ copy, audit #15)');
  assert.equal(existsSync(join(out, 'worker.js')), true, 'the build emits dist/worker.js');
  const securityLog = { write: (): void => undefined };
  const clock = new VirtualClock({ startMono: 1_000 });
  const deps = await productionRegionDeps({ fs: realFs, clock, distDir: out, securityLog });
  try {
    assert.equal(deps.runtime.dir, join(out, 'grammars'), 'runtime.dir is <out>/grammars');
    assert.deepEqual([...deps.workers.availability()], LANGUAGES.map((l) => [l, 'ok']), 'both thread workers loaded every shipped grammar');
    assert.equal(deps.securityLog, securityLog, 'RegionDeps.securityLog is the Log passed in (X-34)');
    assert.equal(deps.budgets.deadline('map').budgetMs, BUDGETS.mapLocalMs, 'the budgets run on the caller\u2019s clock');
    assert.equal(deps.host.attached, false, 'a fresh RegionHost, attached by the first createEngineCore');
    assert.equal(deps.attribution, undefined);
    assert.equal(deps.breach, undefined);
    assert.equal(deps.suspect, undefined);
  } finally {
    await deps.workers.close();
  }
  // A distDir without grammars/ rejects before any thread is spawned.
  const empty = join(await regionTempRoot(), 'no-grammars');
  mkdirSync(empty, { recursive: true });
  await assert.rejects(productionRegionDeps({ fs: realFs, clock, distDir: empty, securityLog }), RegionRuntimeMissingError);
  // close() ends both threads: the child builds the same pool, closes it and must then exit by itself.
  assert.match(child(['pool', out], 120_000).out, /^pool ok closed$/m);
  // X-34 / R4-52 / R5-46: one writer of <logDir>/security.jsonl per daemon. Across src/ the only fileLog over security.jsonl is
  // src/sec/securityLog.ts's own; run.ts constructs exactly one SecurityLog and names no security.jsonl path of its own (it hands
  // the region binding that SecurityLog as a Log — the behaviour is claude.daemonRun.test.ts's one-security-Log cell); no module
  // under src/engine or src/claims names the file.
  const writers = sources(join(ROOT, 'src')).filter((f) => /fileLog\([^;]*security\.jsonl/su.test(readFileSync(f, 'utf8')))
    .map((f) => relative(ROOT, f).split(sep).join('/'));
  assert.deepEqual(writers, ['src/sec/securityLog.ts'], 'the one fileLog over security.jsonl is the SecurityLog\u2019s own');
  const runTs = readFileSync(join(ROOT, 'src', 'daemon', 'run.ts'), 'utf8');
  assert.equal(runTs.match(/\bsecurityLog\(fs,/gu)?.length ?? 0, 1, 'run.ts constructs exactly one SecurityLog');
  // A second securityLog(...) call anywhere else in src/ would open a second queue on the same file (its fileLog literal
  // sits in securityLog.ts, so the writers check above cannot see it): outside src/sec/securityLog.ts the one call site is run.ts's.
  const constructors = sources(join(ROOT, 'src')).map((f) => [relative(ROOT, f).split(sep).join('/'), readFileSync(f, 'utf8').match(/\bsecurityLog\(/gu)?.length ?? 0] as const)
    .filter(([f, n]) => n > 0 && f !== 'src/sec/securityLog.ts');
  assert.deepEqual(constructors, [['src/daemon/run.ts', 1]], 'outside src/sec/securityLog.ts the one securityLog(...) call is run.ts’s (F2 #52)');
  assert.doesNotMatch(runTs, /'security\.jsonl'/u, 'run.ts names no security.jsonl path of its own');
  for (const f of [...sources(join(ROOT, 'src', 'engine')), ...sources(join(ROOT, 'src', 'claims'))]) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), /security\.jsonl/u, `${f} builds no security log writer`);
  }
});

test('runDaemon closes the worker pool after drain and on an early exit', T10, async () => {
  const out = await dist();
  const { root, cleanup } = await makeTempRoot('region-pool-daemon');
  try {
    const runner = testRunner();
    const remote = await createBareRemote(root, runner);
    await seedRemote(remote, root, runner, { 'README.md': Buffer.from('# pool\n'), 'a.txt': Buffer.from('a\n') });
    const c1 = await clonePeer(remote, root, { name: 'c1', autocrlf: false, withFilter: false }, runner);
    const c2 = await clonePeer(remote, root, { name: 'c2', autocrlf: false, withFilter: false }, runner);
    const det = await runner.run(['checkout', '-q', '--detach'], { class: 'local', cwd: c2.dir });
    assert.equal(det.code, 0, det.stderr.toString('utf8'));
    // A fresh checkout younger than QUIET_MS would read as local work (START_PREVIEW), as daemon.cli.test.ts waits too.
    await new Promise((r) => setTimeout(r, QUIET_MS + 200));
    const r = child(['daemon', out, c1.dir, c2.dir], 8 * 60_000);
    const cases = new Map(r.out.split('\n').filter((l) => l.startsWith('{')).map((l) => {
      const c = JSON.parse(l) as { case: string; code: number; calls: number; closes: number; stoppedBeforeClose?: boolean; security?: string[]; lines: string[] };
      return [c.case, c] as const;
    }));
    const run = cases.get('run');
    assert.ok(run !== undefined, r.out);
    assert.equal(run.code, 0, run.lines.join('\n'));
    assert.equal(run.calls, 1, 'the run built the pool once');
    assert.equal(run.closes, 1, 'close() exactly once');
    assert.equal(run.stoppedBeforeClose, true, `the drain ended ('stopped' printed) before the pool closed:\n${run.lines.join('\n')}`);
    assert.deepEqual(run.security, ['TEST_SECURITY_LINE'], 'the one Log run.ts passed in appends one JSON line to <logDir>/security.jsonl');
    const after = cases.get('refused_after');
    assert.ok(after !== undefined, r.out);
    assert.equal(after.code, 1, after.lines.join('\n'));
    assert.ok(after.lines.some((l) => l.startsWith('START_HEAD_STATE')), after.lines.join('\n'));
    assert.equal(after.calls, 1, 'the refused start had built the pool');
    assert.equal(after.closes, 1, 'a start refused after the pool closes it exactly once');
    for (const name of ['lock_held', 'no_repo'] as const) {
      const c = cases.get(name);
      assert.ok(c !== undefined, r.out);
      assert.equal(c.code, 1, c.lines.join('\n'));
      assert.equal(c.calls, 0, `${name}: a refusal before the pool spawns no thread at all`);
      assert.equal(c.closes, 0, name);
    }
    assert.ok(cases.get('lock_held')!.lines.some((l) => l.startsWith('DAEMON_ALREADY_RUNNING')), cases.get('lock_held')!.lines.join('\n'));
    assert.ok(cases.get('no_repo')!.lines.some((l) => l.startsWith('START_REPO_SHAPE')), cases.get('no_repo')!.lines.join('\n'));
  } finally {
    await cleanup();
  }
});

test('testRegionDeps binds inline workers, the test runtime and virtual budgets', T10, async () => {
  const vclock = new VirtualClock({ startMono: 1_000 });
  const injector = testBudgetInjector();
  const deps = await testRegionDeps({ clock: vclock, injector });
  try {
    assert.deepEqual([...deps.workers.availability()], LANGUAGES.map((l) => [l, 'ok']), 'every pinned grammar is ok in the test binding');
    assert.equal(deps.runtime, await testRegionRuntime(), 'the tests\u2019 runtime (the pinned grammars from node_modules)');
    // Deadlines come from clockBudgets(vclock, injector): the injector's expiry reaches the next deadline of its kind ...
    injector.expire('map', 1);
    assert.equal(deps.budgets.deadline('map').expired(), true, 'the injected expiry reaches the binding\u2019s budgets');
    // ... and the clock is the caller's virtual one: nothing expires until it advances past the budget.
    const d = deps.budgets.deadline('map');
    assert.equal(d.budgetMs, BUDGETS.mapLocalMs);
    assert.equal(d.expired(), false);
    vclock.advance(BUDGETS.mapLocalMs - 1);
    assert.equal(d.expired(), false);
    vclock.advance(1);
    assert.equal(d.expired(), true, 'the deadline runs on the caller\u2019s VirtualClock');
    assert.equal(deps.host.attached, false);
    assert.equal(deps.attribution, undefined, 'Task 12 binds the default attribution');
    assert.equal(deps.breach, undefined, 'Task 15 binds the default breach port');
    assert.equal(deps.suspect, undefined, 'Plan 6 binds the suspect port');
  } finally {
    await deps.workers.close();
  }
});
