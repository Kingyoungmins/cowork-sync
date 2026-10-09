import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { removeKeptRoot } from '../helpers/tmp.js';
import { randomInt } from '../../src/ports/random.js';
import type { EngineFactory, Oracle, SeedTuple, SimEngine } from '../sim/harness.js';
import { runSim } from '../sim/harness.js';
import { naiveEngine } from '../sim/naiveEngine.js';
import { oracleFF, oracleOID } from '../sim/oracles.js';
import { SIM_WALL_EPOCH_MS } from '../sim/vclock.js';

const ORACLES = (): Oracle[] => [
  oracleFF('refs/cowork/'),
  oracleFF('refs/heads/cowork/'),
  oracleOID(['refs/cowork/probe-', 'refs/heads/cowork/probe-']),
];

/** A failed run keeps its temp root (artifactsDir is <mkdtemp base>/공 백 dir/artifacts): removeKeptRoot deletes that base only. */
async function dropArtifacts(dir: string | undefined): Promise<void> {
  if (dir === undefined) return;
  await removeKeptRoot(dir);
}

/**
 * Determinism pin: every landed commit's committer date is the virtual wall clock its engine
 * logged (`commit <oid> wall=<ms>`), and lies in the SIM window (epoch ± 600 s skew + run time),
 * so neither real time nor a doubled epoch can reach an oid.
 */
const commitDatesAreVirtual: Oracle = {
  name: 'VIRTUAL-DATES',
  async atQuiescence(ctx) {
    const wallOf = new Map<string, number>();
    for (const e of ctx.opLog) {
      if (e.kind !== 'commit') continue;
      const [oid, wall] = e.detail.split(' wall=');
      wallOf.set(oid ?? '', Number(wall));
    }
    const r = await ctx.git.run(['log', '--format=%H %ct', 'refs/cowork/main/code'], { class: 'local', cwd: ctx.remote.dir });
    if (r.code !== 0) return `git log failed: ${r.stderr.toString('utf8')}`;
    let checked = 0;
    for (const line of r.stdout.toString('utf8').split('\n').filter((l) => l !== '')) {
      const [oid = '', ct = ''] = line.split(' ');
      const wall = wallOf.get(oid);
      if (wall === undefined) continue; // the seed commit (Task 12's fixed date)
      if (Number(ct) !== Math.floor(wall / 1000)) return `${oid}: committer date ${ct} is not the virtual wall ${wall}`;
      if (Math.abs(wall - SIM_WALL_EPOCH_MS) > 600_000 + 3_600_000) return `${oid}: virtual wall ${wall} is outside the SIM window`;
      checked++;
    }
    return checked > 0 ? null : 'no engine commit reached refs/cowork/main/code';
  },
};

test('NaiveEngine: every step lands as a leased fast-forward and INV-FF/INV-OID hold', async () => {
  const r = await runSim({ seed: 'naive-pass', peers: 3, ops: 9 }, naiveEngine(), [...ORACLES(), commitDatesAreVirtual]);
  await dropArtifacts(r.artifactsDir);
  assert.equal(r.ok, true, r.failure?.message);
  const pushes = r.opLog.filter((e) => e.kind === 'push');
  assertEveryStepLanded(r.opLog, 9);
  const last = pushes[pushes.length - 1];
  assert.equal(r.remoteRefs['refs/cowork/main/code'], last?.detail.slice(3));
});

/**
 * Task 15's liveness rule: a step has landed when its last push attempt is `ok `, and any earlier
 * attempt of that step is a `rejected ` one the engine retried. Under heavy parallel load a push to
 * the local file:// remote is occasionally rejected with nothing landed (Task 12); the engine's
 * retry then adds a `rejected` entry, so totals are not pinned, only per-step outcomes.
 */
function assertEveryStepLanded(opLog: { step: number; kind: string; detail: string }[], ops: number): void {
  const pushes = opLog.filter((e) => e.kind === 'push');
  for (let s = 0; s < ops; s++) {
    const mine = pushes.filter((e) => e.step === s);
    assert.ok(mine.length >= 1 && mine[mine.length - 1]!.detail.startsWith('ok '), `step ${s}: ${JSON.stringify(mine)}`);
    assert.ok(mine.slice(0, -1).every((e) => e.detail.startsWith('rejected ')), `step ${s}: ${JSON.stringify(mine)}`);
  }
}

/** The op-log without retried push attempts: what a run without any transient rejection logs. */
function withoutRejected<T extends { kind: string; detail: string }>(opLog: T[]): T[] {
  return opLog.filter((e) => !(e.kind === 'push' && e.detail.startsWith('rejected ')));
}

// 11-testing §3.3 Run 2: at a yieldPoint the scheduler may run a concurrent operation. Here the
// handler runs another peer's whole naive step at 'naive.beforePush' on every even step, so the
// yielding peer pushes with a lease the teammate has just moved. The push loses, the engine sees
// the moved tip and rebuilds its commit once on top of the teammate's.
test('a teammate step interleaved at naive.beforePush makes the leased push lose, the commit is rebuilt once; INV-FF holds', async () => {
  const inner = naiveEngine();
  const engines = new Map<string, SimEngine>();
  const factory: EngineFactory = (ctx, peer) => {
    const engine = inner(ctx, peer);
    engines.set(peer.name, engine);
    if (ctx.scheduler.onYield === null) {
      let busy = false;
      ctx.scheduler.onYield = async (name) => {
        const last = ctx.opLog[ctx.opLog.length - 1];
        if (name !== 'naive.beforePush' || busy || last === undefined || last.step % 2 !== 0) return;
        const others = [...engines.values()].filter((e) => e.peer.name !== last.peer);
        const other = others[randomInt(ctx.scheduler.random, others.length)] as SimEngine;
        busy = true;
        try {
          ctx.opLog.push({ step: last.step, peer: other.peer.name, kind: 'interleave', detail: `at ${name} of ${last.peer}` });
          await other.step(ctx);
        } finally {
          busy = false;
        }
      };
    }
    return engine;
  };

  const r = await runSim({ seed: 'naive-interleave', peers: 3, ops: 6 }, factory, ORACLES());
  await dropArtifacts(r.artifactsDir);
  assert.equal(r.ok, true, r.failure?.message);
  for (const step of [0, 2, 4]) {
    const entries = r.opLog.filter((e) => e.step === step);
    assert.deepEqual(entries.map((e) => e.kind), ['step', 'commit', 'interleave', 'commit', 'push', 'push', 'commit', 'push'], `step ${step}`);
    // Commits in order: the yielding peer's, the teammate's, and the yielding peer's rebuilt one.
    const [own, teammate, rebuilt] = entries.filter((e) => e.kind === 'commit').map((e) => e.detail.split(' ')[0]);
    const pushes = entries.filter((e) => e.kind === 'push');
    assert.deepEqual(pushes.map((e) => e.detail.split(' ').slice(0, 2).join(' ')), [`ok ${teammate}`, `rejected ${own}`, `ok ${rebuilt}`], `step ${step}`);
    assert.match(pushes[1]?.detail ?? '', /^rejected [0-9a-f]{40,64} code=[1-9][0-9]* /);
    assert.notEqual(rebuilt, own, `step ${step}: a lost lease rebuilds the commit, it does not resend it`);
  }
  for (const step of [1, 3, 5]) {
    assert.ok(r.opLog.some((e) => e.step === step && e.kind === 'push' && e.detail.startsWith('ok ')), `step ${step}`);
  }
  const lastOk = r.opLog.filter((e) => e.kind === 'push' && e.detail.startsWith('ok ')).pop();
  assert.equal(r.remoteRefs['refs/cowork/main/code'], lastOk?.detail.slice(3));
});

// A rejection that lands nothing (here the remote's pre-receive hook, armed with rejectNext from
// Task 11) leaves the remote tip on the lease, so the engine resends the same commit after
// 'naive.retry'. Two such retries are allowed; a third rejection ends the step with a final
// `rejected`, and the next step builds on the unchanged tip.
test('a transient rejection is retried with the same commit; a third rejection in a row ends the step', async () => {
  const yields: string[] = [];
  const factory: EngineFactory = (ctx, peer) => {
    if (ctx.scheduler.onYield === null) {
      ctx.scheduler.onYield = async (name) => {
        const step = ctx.opLog[ctx.opLog.length - 1]?.step ?? -1;
        yields.push(`${step}:${name}`);
        if (name !== 'naive.beforePush') return;
        if (step === 1) await ctx.remote.rejectNext(1, 'transient-failed', 'refs/cowork/main/code');
        if (step === 3) await ctx.remote.rejectNext(3, 'transient-failed', 'refs/cowork/main/code');
      };
    }
    return naiveEngine()(ctx, peer);
  };

  const r = await runSim({ seed: 'naive-transient', peers: 2, ops: 5 }, factory, [...ORACLES(), commitDatesAreVirtual]);
  await dropArtifacts(r.artifactsDir);
  assert.equal(r.ok, true, r.failure?.message);
  /** One step without its 'step' entry, as "commit <oid>" and "<ok|rejected> <oid>". */
  const summary = (step: number): string[] => r.opLog
    .filter((e) => e.step === step && e.kind !== 'step')
    .map((e) => (e.kind === 'commit' ? `commit ${e.detail.split(' ')[0]}` : e.detail.split(' ').slice(0, 2).join(' ')));
  const c1 = summary(1)[0]?.slice('commit '.length);
  assert.deepEqual(summary(1), [`commit ${c1}`, `rejected ${c1}`, `ok ${c1}`]);
  const c3 = summary(3)[0]?.slice('commit '.length);
  assert.deepEqual(summary(3), [`commit ${c3}`, `rejected ${c3}`, `rejected ${c3}`, `rejected ${c3}`]);
  for (const step of [0, 2, 4]) assert.match(summary(step).join(' | '), /^commit ([0-9a-f]+) \| ok \1$/, `step ${step}`);
  assert.deepEqual(yields.filter((y) => y.endsWith(':naive.retry')), ['1:naive.retry', '3:naive.retry', '3:naive.retry']);
  for (const e of r.opLog.filter((x) => x.kind === 'push' && x.detail.startsWith('rejected '))) {
    assert.match(e.detail, /^rejected [0-9a-f]{40,64} code=[1-9][0-9]* /);
  }
  assert.equal(`ok ${r.remoteRefs['refs/cowork/main/code']}`, summary(4)[1]);
});

// Review Focus 5. Pinned: seeded Randoms, explicit identities, commit dates from VirtualClocks,
// sorted readdir. Two different temp roots and a real-time gap of more than one second (git
// dates have 1 s resolution) between the runs: a date taken from the real clock would change
// every oid of the second run.
test('determinism: the same SeedTuple twice gives the identical op-log and remote refs', async () => {
  const t: SeedTuple = { seed: 'determinism-7', peers: 3, ops: 8 };
  const a = await runSim(t, naiveEngine(), [...ORACLES(), commitDatesAreVirtual]);
  await delay(1_100);
  const b = await runSim(t, naiveEngine(), [...ORACLES(), commitDatesAreVirtual]);
  await dropArtifacts(a.artifactsDir);
  await dropArtifacts(b.artifactsDir);
  assert.equal(a.ok, true, a.failure?.message);
  assert.equal(b.ok, true, b.failure?.message);
  // A transient rejection retried in only one of the runs adds `rejected` entries there (Task 12);
  // without those, the op-logs must be identical, and the landed commits (refs) always are.
  assertEveryStepLanded(a.opLog, t.ops);
  assertEveryStepLanded(b.opLog, t.ops);
  assert.deepEqual(withoutRejected(a.opLog), withoutRejected(b.opLog));
  assert.deepEqual(a.remoteRefs, b.remoteRefs);
  assert.ok(a.remoteRefs['refs/cowork/main/code'] !== undefined);
});

// Seed 'naive-mutant' verified on Windows 11 / Git 2.55 / Node 24. The picks depend only on
// seededRandom and the harness draw order (per peer: skew, drift; per step: pick, dt), not on the
// OS: steps 0-5 pick p2, p1, p1, p1, p0, p2. p2 publishes at step 0, p1 and p0 publish on top of
// it, and at step 5 p2 builds on its stale view (its own step-0 commit) and its '+' push rewrites
// p0's commit.
test('mutant forcePush (stale view + "+" refspec) is killed by INV-FF', async () => {
  const r = await runSim({ seed: 'naive-mutant', peers: 3, ops: 12 }, naiveEngine({ forcePush: true }), ORACLES());
  await dropArtifacts(r.artifactsDir);
  assert.deepEqual(r.opLog.filter((e) => e.kind === 'step').map((e) => e.peer), ['p2', 'p1', 'p1', 'p1', 'p0', 'p2']);
  assert.equal(r.ok, false);
  assert.equal(r.failure?.oracle, 'INV-FF');
  assert.equal(r.failure?.step, 5);
  assert.match(r.failure?.message ?? '', /^refs\/cowork\/main\/code moved [0-9a-f]+ -> [0-9a-f]+, not a first-parent fast-forward$/);
});
