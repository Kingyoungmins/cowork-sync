import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { realFs } from '../../src/ports/fs.js';
import { removeKeptRoot, testRunner } from '../helpers/tmp.js';
import type { EngineFactory, Oracle, SimContext, SimResult } from '../sim/harness.js';
import { runSim } from '../sim/harness.js';
import { SIM_WALL_EPOCH_MS } from '../sim/vclock.js';

/** A failed run keeps its temp root (artifactsDir is <mkdtemp base>/공 백 dir/artifacts): removeKeptRoot deletes that base only. */
async function dropArtifacts(dir: string | undefined): Promise<void> {
  if (dir === undefined) return;
  await removeKeptRoot(dir);
}

/** An engine that only records which peer ran and that peer's virtual wall clock. */
const recorder: EngineFactory = (_ctx, peer) => ({
  peer,
  async step(ctx: SimContext): Promise<void> {
    const step = ctx.opLog[ctx.opLog.length - 1]?.step ?? -1;
    ctx.opLog.push({ step, peer: peer.name, kind: 'noop', detail: `wall=${ctx.clocks.get(peer.name)?.wallMs()}` });
  },
});

test('runSim builds the remote and N peers, seeds main and runs exactly ops steps', async () => {
  const seen: SimContext[] = [];
  const probe: Oracle = {
    name: 'probe',
    async afterEveryOp(ctx) { seen.push(ctx); return null; },
  };
  const r = await runSim({ seed: 'harness-basic', peers: 3, ops: 6 }, recorder, [probe]);
  assert.equal(r.ok, true);
  assert.equal(r.failure, undefined);
  assert.equal(r.artifactsDir, undefined);
  assert.equal(seen.length, 6);
  const ctx = seen[0] as SimContext;
  assert.deepEqual(ctx.peers.map((p) => p.name), ['p0', 'p1', 'p2']);
  assert.deepEqual(ctx.peers.map((p) => p.opts.autocrlf), [false, true, false]);
  assert.deepEqual([...ctx.clocks.keys()], ['p0', 'p1', 'p2']);
  assert.match(ctx.root, /공 백 dir/);
  assert.equal(existsSync(ctx.root), false, 'a passing run removes its temp root');
  assert.deepEqual(r.opLog.filter((e) => e.kind === 'step').map((e) => e.step), [0, 1, 2, 3, 4, 5]);
  assert.equal(r.opLog.filter((e) => e.kind === 'noop').length, 6);
  assert.match(r.remoteRefs['refs/heads/main'] ?? '', /^[0-9a-f]{40,64}$/);
});

test('peer clocks read SIM_WALL_EPOCH_MS + skew (|skew| <= 600 s) + elapsed virtual time ± drift (<= 100 ppm)', async () => {
  const r = await runSim({ seed: 'harness-clock', peers: 4, ops: 8 }, recorder, []);
  assert.equal(r.ok, true);
  let elapsed = 0;
  for (const e of r.opLog) {
    if (e.kind === 'step') elapsed += Number(e.detail.slice('dt='.length));
    if (e.kind !== 'noop') continue;
    // A wallOffsetMs of SIM_WALL_EPOCH_MS + skew would add the epoch twice (year 2082) and fail here.
    const residual = Number(e.detail.slice('wall='.length)) - SIM_WALL_EPOCH_MS - elapsed;
    assert.ok(Math.abs(residual) <= 600_000 + Math.ceil((elapsed * 100) / 1e6), `${e.peer} residual ${residual}`);
  }
});

test('runSim stops at the first afterEveryOp violation, reports its step and keeps the artifacts', async () => {
  let quiescenceCalls = 0;
  const failAtStep2: Oracle = {
    name: 'PLANTED',
    async afterEveryOp(ctx) {
      const last = ctx.opLog[ctx.opLog.length - 1];
      return last !== undefined && last.step === 2 ? 'planted violation' : null;
    },
    async atQuiescence() { quiescenceCalls++; return null; },
  };
  const r = await runSim({ seed: 'harness-stop', peers: 2, ops: 10 }, recorder, [failAtStep2]);
  try {
    assert.equal(r.ok, false);
    assert.deepEqual(r.failure, { oracle: 'PLANTED', message: 'planted violation', step: 2 });
    assert.equal(Math.max(...r.opLog.map((e) => e.step)), 2);
    assert.equal(quiescenceCalls, 0);

    // 11-testing §3.3 Failure: op-log, remote log and a bundle of the remote survive the run.
    const dir = r.artifactsDir ?? assert.fail('no artifactsDir on a failed run');
    assert.match(dir, /공 백 dir[\\/]artifacts$/);
    const lines = (await readFile(join(dir, 'op-log.jsonl'), 'utf8')).split('\n').filter((l) => l !== '');
    assert.deepEqual(lines.map((l) => JSON.parse(l) as unknown), r.opLog);
    assert.ok(existsSync(join(dir, 'remote-log.jsonl')));
    assert.ok(existsSync(join(dir, 'reftx-log.jsonl')));
    const heads = await testRunner().run(['bundle', 'list-heads', join(dir, 'remote.bundle')], { class: 'local', cwd: dir });
    assert.equal(heads.code, 0, heads.stderr.toString('utf8'));
    assert.match(heads.stdout.toString('utf8'), new RegExp(`^${r.remoteRefs['refs/heads/main']} refs/heads/main$`, 'm'));
  } finally {
    await dropArtifacts(r.artifactsDir);
  }
});

test('runSim runs atQuiescence once after the budget, with step = ops', async () => {
  let calls = 0;
  const atEnd: Oracle = {
    name: 'END',
    async atQuiescence(ctx) { calls++; return ctx.opLog.length === 8 ? 'quiescence reached' : null; },
  };
  const r = await runSim({ seed: 'harness-quiet', peers: 2, ops: 4 }, recorder, [atEnd]);
  try {
    assert.equal(calls, 1);
    assert.deepEqual(r.failure, { oracle: 'END', message: 'quiescence reached', step: 4 });
    assert.ok(r.artifactsDir !== undefined && existsSync(join(r.artifactsDir, 'op-log.jsonl')));
  } finally {
    await dropArtifacts(r.artifactsDir);
  }
});

test('an engine that throws rejects runSim and the message names the kept artifacts', async () => {
  const thrower: EngineFactory = (_ctx, peer) => ({
    peer,
    async step(ctx) { if (ctx.opLog.length >= 3) throw new Error('engine exploded'); },
  });
  let dir: string | undefined;
  await assert.rejects(runSim({ seed: 'harness-throw', peers: 1, ops: 5 }, thrower, []), (e: Error) => {
    assert.match(e.message, /^runSim\(harness-throw\): engine exploded; artifacts kept in /);
    dir = e.message.slice(e.message.indexOf('artifacts kept in ') + 'artifacts kept in '.length);
    return true;
  });
  try {
    assert.ok(dir !== undefined && existsSync(join(dir, 'op-log.jsonl')) && existsSync(join(dir, 'remote.bundle')));
  } finally {
    await dropArtifacts(dir);
  }
});

test('runSim peer picks, clock skews and virtual time come only from the seed', async () => {
  const a = await runSim({ seed: 'harness-det', peers: 4, ops: 12 }, recorder, []);
  const b = await runSim({ seed: 'harness-det', peers: 4, ops: 12 }, recorder, []);
  const c = await runSim({ seed: 'harness-det-other', peers: 4, ops: 12 }, recorder, []);
  assert.deepEqual(a.opLog, b.opLog);
  assert.deepEqual(a.remoteRefs, b.remoteRefs);
  assert.notDeepEqual(a.opLog, c.opLog);
});

// Determinism pin (Review Focus 5): file-creation order must not reach the op-log. Engines list
// directories through the Fs port, whose readdir is sorted by code unit (Task 4).
test('directory listings in a run come from the sorted Fs readdir, not from creation order', async () => {
  const NAMES = ['b.txt', '한.txt', 'a.txt', 'C.txt', 'a b.txt'];
  const lister = (order: 'forward' | 'reverse'): EngineFactory => (_ctx, peer) => ({
    peer,
    async step(ctx) {
      const step = ctx.opLog[ctx.opLog.length - 1]?.step ?? -1;
      const dir = join(ctx.root, 'listing', `${peer.name}-${step}`);
      await realFs.mkdirp(dir);
      for (const n of order === 'forward' ? NAMES : [...NAMES].reverse()) await realFs.writeFile(join(dir, n), Buffer.from(n, 'utf8'));
      ctx.opLog.push({ step, peer: peer.name, kind: 'list', detail: (await realFs.readdir(dir)).join('|') });
    },
  });
  const t = { seed: 'harness-readdir', peers: 2, ops: 4 };
  const a: SimResult = await runSim(t, lister('forward'), []);
  const b: SimResult = await runSim(t, lister('reverse'), []);
  assert.deepEqual(a.opLog, b.opLog);
  const listed = a.opLog.filter((e) => e.kind === 'list').map((e) => e.detail);
  assert.equal(listed.length, 4);
  assert.ok(listed.every((d) => d === 'C.txt|a b.txt|a.txt|b.txt|한.txt'), listed.join(' / '));
});
