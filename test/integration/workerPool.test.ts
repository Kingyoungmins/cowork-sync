// threadWorkers over bundled worker entries (REG-31, R1-040, R1-070, B2-11; rulings R4-12…R4-15, X-37). The pool
// tests drive crashes, stalls and ordering through test-only worker entries (test/helpers/workers/*Worker.ts) with
// their own handler tables, so they stay green while Tasks 3–13 fill the production handlers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { rm, truncate } from 'node:fs/promises';
import { join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import ts from 'typescript';
import { WORKER_JOB_KINDS } from '../../src/entry/worker.js';
import type { Oid } from '../../src/git/oid.js';
import { realClock, type Clock } from '../../src/ports/clock.js';
import { realFs } from '../../src/ports/fs.js';
import { seededRandom } from '../../src/ports/random.js';
import { BUDGETS, clockBudgets } from '../../src/regions/budgets.js';
import { threadWorkers, type RegionJob, type RegionWorkers } from '../../src/regions/pool.js';
import { loadRegionRuntime } from '../../src/regions/runtime.js';
import { inlineWorkers } from '../../src/regions/worker/inline.js';
import { PLUGIN_VERSION } from '../../src/version.js';
import {
  bundleForTest, copyGrammarsTo, recordingWorkerPath, testRegionRuntime, testWorkerInit, testWorkerPath,
} from '../helpers/regionRuntime.js';
import { makeTempRoot } from '../helpers/tmp.js';
import { generateBigBomCrlf } from '../sim/fixtures/bigBomCrlf.js';
import { VirtualClock } from '../sim/vclock.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const ALL_OK = { python: 'ok', javascript: 'ok', typescript: 'ok', tsx: 'ok', c_sharp: 'ok' };
const ALL_UNAVAILABLE = { python: 'unavailable', javascript: 'unavailable', typescript: 'unavailable', tsx: 'unavailable', c_sharp: 'unavailable' };
const OID = '0'.repeat(40) as Oid;
const HUNKS: RegionJob = { kind: 'hunks', from: [], to: [] };
const MAP: RegionJob = { kind: 'map', from: [Buffer.from('a\n')], to: [Buffer.from('b\n')], ranges: [[1, 1]], mode: 'local' };

/** A hunks job the order worker busy-waits `ms` on. */
const busy = (ms: number): RegionJob => ({ kind: 'hunks', from: Array.from({ length: ms }, () => Buffer.alloc(0)), to: [] });

const worker = (name: string): Promise<string> => bundleForTest(`test/helpers/workers/${name}.ts`);

async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  const until = realClock.monoMs() + ms;
  while (!cond()) {
    if (realClock.monoMs() > until) assert.fail(`timed out waiting for ${what}`);
    await realClock.sleep(10);
  }
}

/** Resource types that keep a process alive, minus the timers and requests a test runner always has. */
function liveHandles(): string[] {
  return process.getActiveResourcesInfo().filter((t) => !/Req|^Timeout$|^Immediate$|^TTYWrap$|^PipeWrap$|^ProcessWrap$|^TCPWrap$/.test(t)).sort();
}

async function withPool<T>(pool: RegionWorkers, body: (pool: RegionWorkers) => Promise<T>): Promise<T> {
  try {
    return await body(pool);
  } finally {
    await pool.close();
  }
}

test('threadWorkers spawns fg and bg from the built worker and reports availability', async () => {
  const runtime = await testRegionRuntime();
  const workerPath = await testWorkerPath();
  const before = liveHandles();
  const pool = await threadWorkers(runtime, { threads: 2, workerPath, clock: realClock });
  assert.deepEqual(Object.fromEntries(pool.availability()), ALL_OK);
  assert.ok(liveHandles().length > before.length, 'two worker threads are alive');
  await pool.close();
  assert.deepEqual(liveHandles(), before, 'close() terminates both threads and leaves no open handle');
  assert.deepEqual(await pool.run(HUNKS, 'fg', null), { kind: 'crashed' }, 'a closed pool runs nothing');
});

test('workers load the grammars only from posted bytes', async () => {
  const { root, cleanup } = await makeTempRoot('pool-bytes');
  try {
    const dir = join(root, 'grammars');
    await copyGrammarsTo(dir);
    const runtime = await loadRegionRuntime(realFs, dir);
    await rm(dir, { recursive: true, force: true });
    await withPool(await threadWorkers(runtime, { threads: 2, workerPath: await testWorkerPath(), clock: realClock }), async (pool) => {
      assert.deepEqual(Object.fromEntries(pool.availability()), ALL_OK, 'the workers never open a file (R4-12)');
    });
  } finally {
    await cleanup();
  }
});

test('a corrupt tree-sitter-c_sharp.wasm makes only c_sharp unavailable and the pool keeps serving', async () => {
  const { root, cleanup } = await makeTempRoot('pool-corrupt');
  try {
    const dir = join(root, 'grammars');
    await copyGrammarsTo(dir);
    await truncate(join(dir, 'tree-sitter-c_sharp.wasm'), 1_000);
    const runtime = await loadRegionRuntime(realFs, dir);
    const handlers = { hunks: async () => [] };
    await withPool(await threadWorkers(runtime, { threads: 2, workerPath: await testWorkerPath(), clock: realClock }), async (pool) => {
      assert.deepEqual(Object.fromEntries(pool.availability()), { ...ALL_OK, c_sharp: 'unavailable' });
      const r = await pool.run(HUNKS, 'fg', null);
      assert.ok(['ok', 'deadline', 'crashed'].includes(r.kind), 'a following run resolves');
    });
    await withPool(await inlineWorkers(runtime, { handlers }), async (pool) => {
      assert.deepEqual(Object.fromEntries(pool.availability()), { ...ALL_OK, c_sharp: 'unavailable' });
      assert.deepEqual(await pool.run(HUNKS, 'fg', null), { kind: 'ok', value: [] });
    });

    // A corrupt runtime makes all five unavailable, and run still resolves.
    await copyGrammarsTo(dir);
    await truncate(join(dir, 'tree-sitter.wasm'), 1_000);
    const broken = await loadRegionRuntime(realFs, dir);
    await withPool(await threadWorkers(broken, { threads: 2, workerPath: await testWorkerPath(), clock: realClock }), async (pool) => {
      assert.deepEqual(Object.fromEntries(pool.availability()), ALL_UNAVAILABLE);
      const r = await pool.run(HUNKS, 'fg', null);
      assert.ok(['ok', 'deadline', 'crashed'].includes(r.kind), 'run still resolves');
    });
    await withPool(await inlineWorkers(broken, { handlers }), async (pool) => {
      assert.deepEqual(Object.fromEntries(pool.availability()), ALL_UNAVAILABLE);
      assert.deepEqual(await pool.run(HUNKS, 'fg', null), { kind: 'ok', value: [] });
    });
  } finally {
    await cleanup();
  }
});

test('a worker that exits mid-job yields crashed and is respawned', async () => {
  const runtime = await testRegionRuntime();
  const respawns: Array<[string, string]> = [];
  const pool = await threadWorkers(runtime, {
    threads: 2, workerPath: await worker('crashWorker'), clock: realClock, onRespawn: (name, cause) => respawns.push([name, cause]),
  });
  await withPool(pool, async () => {
    assert.deepEqual(await pool.run(HUNKS, 'fg', null), { kind: 'crashed' });
    assert.deepEqual(await pool.run(HUNKS, 'fg', null), { kind: 'ok', value: [] }, 'answered by generation 1');
    assert.deepEqual(respawns, [['fg', 'crash']]);
    assert.deepEqual(Object.fromEntries(pool.availability()), ALL_OK);
  });
});

test('a job past its deadline yields deadline; a worker silent 1 s later is terminated and respawned', async () => {
  const runtime = await testRegionRuntime();
  const respawns: Array<{ name: string; cause: string; at: number }> = [];
  const pool = await threadWorkers(runtime, {
    threads: 2, workerPath: await worker('stallWorker'), clock: realClock,
    onRespawn: (name, cause) => respawns.push({ name, cause, at: realClock.monoMs() }),
  });
  await withPool(pool, async () => {
    const created = realClock.monoMs();
    const stalled = pool.run(MAP, 'fg', clockBudgets(realClock).deadline('map'));
    // The bg worker answers a bg job while fg is stalled.
    assert.deepEqual(await pool.run(HUNKS, 'bg', null), { kind: 'ok', value: [] });
    assert.equal(respawns.length, 0, 'no respawn while fg is stalled');
    assert.deepEqual(await stalled, { kind: 'deadline' });
    const elapsed = realClock.monoMs() - created;
    assert.ok(elapsed >= 200 && elapsed < 1_000, `deadline after ${elapsed} ms (the main thread abandons the job at its deadline)`);
    // The next fg job waits for generation 1: generation 0 never answers again.
    const next = pool.run(HUNKS, 'fg', null);
    await waitFor(() => respawns.length > 0, 5_000, 'the stall respawn');
    assert.deepEqual(respawns.map((r) => [r.name, r.cause]), [['fg', 'stall']]);
    const graceAfterDeadline = (respawns[0]?.at ?? 0) - (created + BUDGETS.mapLocalMs);
    assert.ok(graceAfterDeadline >= BUDGETS.workerGraceMs, `respawned ${graceAfterDeadline} ms after the deadline`);
    assert.deepEqual(await next, { kind: 'ok', value: [] });
    assert.equal(respawns.length, 1);
  });
});

test('a handler that throws answers crashed and the worker is replaced', async () => {
  const runtime = await testRegionRuntime();
  const respawns: Array<[string, string]> = [];
  const pool = await threadWorkers(runtime, {
    threads: 2, workerPath: await worker('throwWorker'), clock: realClock, onRespawn: (name, cause) => respawns.push([name, cause]),
  });
  await withPool(pool, async () => {
    const availability = Object.fromEntries(pool.availability());
    assert.deepEqual(await pool.run({ kind: 'hunks', from: [], to: [] }, 'fg', null), { kind: 'crashed' });
    await waitFor(() => respawns.length > 0, 5_000, 'the crash respawn');
    // The replacement serves the next job (a kind whose handler does not throw).
    assert.deepEqual(await pool.run(MAP, 'fg', null), { kind: 'ok', value: [] });
    assert.deepEqual(respawns, [['fg', 'crash']]);
    assert.deepEqual(Object.fromEntries(pool.availability()), availability);
  });
});

test('fg jobs run only on the fg thread; save and bg jobs use fg only when it is idle', async () => {
  const runtime = await testRegionRuntime();
  await withPool(await threadWorkers(runtime, { threads: 2, workerPath: await worker('orderWorker'), clock: realClock }), async (pool) => {
    const on = async (job: RegionJob, priority: 'fg' | 'save' | 'bg'): Promise<number> => {
      const r = await pool.run(job, priority, null);
      assert.equal(r.kind, 'ok');
      const hunks = (r as { value: Array<{ aLo: number }> }).value;
      return hunks[0]?.aLo ?? -1;
    };
    // Three fg jobs while bg is idle: all on fg (worker 0).
    assert.deepEqual(await Promise.all([on(busy(5), 'fg'), on(busy(5), 'fg'), on(busy(5), 'fg')]), [0, 0, 0]);
    // fg busy on a 300 ms job: two bg jobs run on bg (worker 1).
    const longFg = on(busy(300), 'fg');
    assert.deepEqual(await Promise.all([on(busy(1), 'bg'), on(busy(1), 'bg')]), [1, 1]);
    assert.equal(await longFg, 0);
    // bg busy on a 300 ms job and fg idle: a save job runs on fg.
    const longBg = on(busy(300), 'bg');
    assert.equal(await on(busy(1), 'save'), 0);
    assert.equal(await longBg, 1);
  });
});

test('a worker that exits before its ready message is not respawned: its jobs resolve crashed', async () => {
  const { root, cleanup } = await makeTempRoot('pool-never-ready');
  try {
    const runtime = await testRegionRuntime();
    const respawns: string[] = [];
    const slotFailed: string[] = [];
    const missing = join(root, 'no-such-worker.mjs');
    const pool = await threadWorkers(runtime, {
      threads: 2, workerPath: missing, clock: realClock, onRespawn: (n, c) => respawns.push(`${n}:${c}`), onSlotFailed: (n) => slotFailed.push(n),
    });
    await withPool(pool, async () => {
      assert.deepEqual(Object.fromEntries(pool.availability()), ALL_UNAVAILABLE);
      assert.deepEqual(await pool.run(HUNKS, 'fg', null), { kind: 'crashed' });
      assert.deepEqual(await pool.run(HUNKS, 'bg', null), { kind: 'crashed' });
      await realClock.sleep(200);
      assert.deepEqual(respawns, [], 'no respawn loop');
      assert.deepEqual([...slotFailed].sort(), ['bg', 'fg'], 'each failed slot is reported once');
    });
  } finally {
    await cleanup();
  }
});

/** A Clock whose sleeps wait until the test releases them (monotonic and wall time are real). */
function gatedClock(): { clock: Clock; sleeps: Array<{ readonly ms: number; release(): void }> } {
  const sleeps: Array<{ readonly ms: number; release(): void }> = [];
  const clock: Clock = {
    monoMs: () => realClock.monoMs(),
    wallMs: () => realClock.wallMs(),
    sleep: (ms: number) => new Promise<void>((resolve) => {
      sleeps.push({ ms, release: resolve });
    }),
  };
  return { clock, sleeps };
}

test('a respawned worker that exits before its ready message is retried after workerGraceMs and the slot recovers', async () => {
  const runtime = await testRegionRuntime();
  const gate = gatedClock();
  const respawns: string[] = [];
  const slotFailed: string[] = [];
  const pool = await threadWorkers(runtime, {
    threads: 2, workerPath: await worker('flakyRespawnWorker'), clock: gate.clock,
    onRespawn: (n, c) => respawns.push(`${n}:${c}`), onSlotFailed: (n) => slotFailed.push(n),
  });
  await withPool(pool, async () => {
    // Generation 0 dies mid-job and is respawned at once; generation 1 exits before its ready message.
    assert.deepEqual(await pool.run(HUNKS, 'fg', null), { kind: 'crashed' });
    const next = pool.run(HUNKS, 'fg', null);
    await waitFor(() => gate.sleeps.length > 0, 30_000, 'the retry wait');
    assert.deepEqual(gate.sleeps.map((s) => s.ms), [BUDGETS.workerGraceMs], 'the retry waits workerGraceMs on the injected clock');
    assert.deepEqual(respawns, ['fg:crash'], 'no retry before the wait ends');
    gate.sleeps[0]?.release();
    assert.deepEqual(await next, { kind: 'ok', value: [] }, 'answered by generation 2');
    assert.deepEqual(respawns, ['fg:crash', 'fg:crash'], 'the retry is reported like any respawn');
    assert.deepEqual(slotFailed, []);
    assert.deepEqual(Object.fromEntries(pool.availability()), ALL_OK);
  });
});

test('a respawned worker that keeps failing before its ready message fails its slot after three retries and reports it', async () => {
  const runtime = await testRegionRuntime();
  const virtual = new VirtualClock();
  const sleeps: number[] = [];
  const clock: Clock = {
    monoMs: () => virtual.monoMs(),
    wallMs: () => virtual.wallMs(),
    sleep: async (ms: number) => {
      sleeps.push(ms);
      await virtual.sleep(ms);
    },
  };
  const respawns: Array<[string, string, number]> = [];
  const slotFailed: Array<[string, number]> = [];
  const pool = await threadWorkers(runtime, {
    threads: 2, workerPath: await worker('preReadyFailWorker'), clock,
    onRespawn: (n, c) => respawns.push([n, c, virtual.monoMs()]), onSlotFailed: (n) => slotFailed.push([n, virtual.monoMs()]),
  });
  await withPool(pool, async () => {
    assert.deepEqual(await pool.run(HUNKS, 'fg', null), { kind: 'crashed' });
    const queued = pool.run(HUNKS, 'fg', null);
    await waitFor(() => slotFailed.length > 0, 30_000, 'the slot failure');
    assert.deepEqual(await queued, { kind: 'crashed' }, 'a job only fg can serve resolves crashed once fg has failed');
    // The crash respawn at once, then three retries each workerGraceMs after the previous pre-ready exit; the third
    // retry's pre-ready exit fails the slot.
    const grace = BUDGETS.workerGraceMs;
    assert.deepEqual(respawns, [['fg', 'crash', 0], ['fg', 'crash', grace], ['fg', 'crash', 2 * grace], ['fg', 'crash', 3 * grace]]);
    assert.deepEqual(sleeps, [grace, grace, grace]);
    assert.deepEqual(slotFailed, [['fg', 3 * grace]]);
    assert.deepEqual(await pool.run(HUNKS, 'fg', null), { kind: 'crashed' });
    assert.deepEqual(await pool.run(HUNKS, 'bg', null), { kind: 'ok', value: [] }, 'bg keeps serving');
    assert.deepEqual(await pool.run(HUNKS, 'save', null), { kind: 'ok', value: [] }, 'save work goes to bg');
    await realClock.sleep(200);
    assert.equal(respawns.length, 4, 'a failed slot is never respawned again');
    assert.equal(slotFailed.length, 1);
  });
});

test('closing the pool during a retry wait spawns nothing afterwards', async () => {
  const runtime = await testRegionRuntime();
  const gate = gatedClock();
  const respawns: string[] = [];
  const slotFailed: string[] = [];
  const before = liveHandles();
  const pool = await threadWorkers(runtime, {
    threads: 2, workerPath: await worker('preReadyFailWorker'), clock: gate.clock,
    onRespawn: (n, c) => respawns.push(`${n}:${c}`), onSlotFailed: (n) => slotFailed.push(n),
  });
  try {
    assert.deepEqual(await pool.run(HUNKS, 'fg', null), { kind: 'crashed' });
    await waitFor(() => gate.sleeps.length > 0, 30_000, 'the retry wait');
  } finally {
    await pool.close();
  }
  gate.sleeps[0]?.release();
  await realClock.sleep(200);
  assert.deepEqual(respawns, ['fg:crash'], 'no spawn after close');
  assert.deepEqual(slotFailed, []);
  assert.deepEqual(liveHandles(), before, 'no thread is left running');
});

test('a worker parses the 26,436-line BOM+CRLF file off the main thread', async () => {
  const runtime = await testRegionRuntime();
  const bytes = generateBigBomCrlf(26_436, seededRandom('regions-26436'));
  const w = new Worker(await worker('parseProbeWorker'), { workerData: testWorkerInit(runtime) });
  try {
    const reply = await new Promise<{ endRow: number | null; hasError: boolean | null; outcome: string }>((resolve, reject) => {
      w.once('message', resolve);
      w.once('error', reject);
      w.postMessage({ lang: 'python', bytes });
    });
    assert.equal(reply.outcome, 'tree');
    assert.equal(reply.endRow, 26_436);
    assert.equal(reply.hasError, false);
  } finally {
    await w.terminate();
  }
});

test('the region worker entry keeps the stub contract as a process', async () => {
  const entry = await testWorkerPath();
  const v = spawnSync(process.execPath, [entry, '--version'], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(v.status, 0, v.stderr);
  assert.equal(v.stdout, `cowork-sync worker ${PLUGIN_VERSION}\n`);
  const noop = spawnSync(process.execPath, [entry], { encoding: 'utf8', input: '', timeout: 60_000 });
  assert.equal(noop.status, 0, `the entry waited for messages or failed: ${noop.stderr}`);
  assert.equal(noop.stdout, '');
});

/** The handler file each region kind's job must reach (src/regions/worker/jobs/<file>.ts). */
const HANDLER_FILE: Readonly<Record<RegionJob['kind'], string>> = {
  table: 'table', hunks: 'hunks', map: 'map', fold_overlap: 'foldOverlap', sites: 'sites', label_at: 'labelAt',
};

/** The src/ files that load `target` (repo-relative, no extension) at run time; `import type` declarations are erased and do not count. */
function srcImporters(target: string): string[] {
  const out = new Set<string>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (!e.name.endsWith('.ts')) continue;
      const rel = relative(REPO, full).split('\\').join('/');
      const sf = ts.createSourceFile(rel, readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const visit = (node: ts.Node): void => {
        let spec: string | null = null;
        if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly !== true && ts.isStringLiteral(node.moduleSpecifier)) spec = node.moduleSpecifier.text;
        if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) spec = node.moduleSpecifier.text;
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] !== undefined
          && ts.isStringLiteralLike(node.arguments[0])) spec = node.arguments[0].text;
        if (spec !== null && spec.startsWith('.') && posix.normalize(posix.join(posix.dirname(rel), spec)).replace(/\.js$/, '') === target) out.add(rel);
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  };
  walk(join(REPO, 'src'));
  return [...out].sort();
}

test('the worker entry dispatches by job kind and rejects an unknown kind', async () => {
  const runtime = await testRegionRuntime();
  const bytes = Buffer.from('x = 1\n', 'utf8');
  const jobs: Readonly<Record<RegionJob['kind'], RegionJob>> = {
    table: { kind: 'table', lang: 'python', cls: 4, ref: OID, bytes, regionSpec: runtime.regionSpec, prevRef: null },
    hunks: HUNKS,
    map: MAP,
    fold_overlap: { kind: 'fold_overlap', pairs: [], lines: new Map() },
    sites: { kind: 'sites', lang: 'python', ref: OID, bytes, names: ['x'] },
    label_at: { kind: 'label_at', lang: 'python', ref: OID, bytes, line: 1, regionSpec: runtime.regionSpec },
  };
  const respawns: string[] = [];
  const pool = await threadWorkers(runtime, {
    threads: 2, workerPath: await recordingWorkerPath(), clock: realClock, onRespawn: (name, cause) => respawns.push(`${name}:${cause}`),
  });
  await withPool(pool, async () => {
    for (const kind of Object.keys(jobs) as RegionJob['kind'][]) {
      assert.deepEqual(await pool.run(jobs[kind], 'fg', null), { kind: 'ok', value: { handler: HANDLER_FILE[kind], job: kind } }, kind);
    }
    // A kind no table registers (Plan 7 Task 4 has not appended secret_scan) reaches no handler.
    const unknown = { kind: 'secret_scan', path: 'a.py', bytes } as unknown as RegionJob;
    assert.deepEqual(await pool.run(unknown, 'fg', null), { kind: 'crashed' });
    assert.deepEqual(await pool.run(HUNKS, 'fg', null), { kind: 'ok', value: { handler: 'hunks', job: 'hunks' } }, 'the pool answers the next region job');
    // The gate's answer stops no loop: the same worker keeps serving, so nothing is respawned.
    assert.deepEqual(respawns, [], 'an unregistered kind costs no respawn');
  });

  // Source check: the entry holds the one kind table, and the job dispatcher is reached only through it for region kinds.
  assert.deepEqual(Object.keys(WORKER_JOB_KINDS).sort(), Object.keys(jobs).sort());
  assert.ok(Object.values(WORKER_JOB_KINDS).every((v) => v === 'region'));
  assert.deepEqual(srcImporters('src/regions/worker/main'), ['src/entry/worker.ts']);
  assert.deepEqual(srcImporters('src/regions/worker/jobs'), ['src/regions/worker/inline.ts', 'src/regions/worker/main.ts']);
  assert.match(readFileSync(join(REPO, 'src', 'entry', 'worker.ts'), 'utf8'), /export const WORKER_JOB_KINDS\b/);
});

test("the entry's job-kind gate answers an unregistered kind and the same thread serves the next region job", async () => {
  // One raw thread of the entry (X-37): without the gate the unregistered job would reach runJob's missing-handler throw,
  // the loop would stop and the thread exit before the next job.
  const runtime = await testRegionRuntime();
  const bytes = Buffer.from('x = 1\n', 'utf8');
  const replies: unknown[] = [];
  let exitCode: number | null = null;
  const raw = new Worker(await recordingWorkerPath(), { workerData: testWorkerInit(runtime) });
  raw.on('message', (m: unknown) => replies.push(m));
  raw.on('exit', (code: number) => {
    exitCode = code;
  });
  try {
    const reply = async (n: number, what: string): Promise<unknown> => {
      await waitFor(() => replies.length >= n || exitCode !== null, 60_000, what);
      assert.equal(exitCode, null, `the thread exited (code ${String(exitCode)}) before ${what}: the unregistered kind stopped its loop`);
      return replies[n - 1];
    };
    assert.equal((await reply(1, 'its ready message') as { type?: unknown }).type, 'ready');
    raw.postMessage({ type: 'job', id: 1, job: { kind: 'secret_scan', path: 'a.py', bytes }, remainingMs: null });
    const rejected = await reply(2, 'the answer to the unregistered kind');
    raw.postMessage({ type: 'job', id: 2, job: HUNKS, remainingMs: null });
    assert.deepEqual(await reply(3, 'the answer to the next region job'), { type: 'result', id: 2, result: { kind: 'ok', value: { handler: 'hunks', job: 'hunks' } } });
    assert.deepEqual(rejected, { type: 'result', id: 1, result: { kind: 'crashed' }, unregistered: true }, 'answered crashed at the gate, marked so the pool keeps the worker');
  } finally {
    await raw.terminate();
  }
});
