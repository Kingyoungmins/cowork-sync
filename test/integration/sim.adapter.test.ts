// The SIM harness and realEngine rules of Plan 2 Task 18 beyond the brief's scenarios: ruling R-SIM-01 (which start
// refusals a later step retries), crash arming at the end of the op budget, the caller's crash handler, the scripted
// wait, and the failure artifacts. Real git against a file:// bare remote for the realEngine cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Engine } from '../../src/engine/loop.js';
import { crashpoint, KilledAt, setCrashHandler } from '../../src/ports/crashpoint.js';
import { seededRandom } from '../../src/ports/random.js';
import { recoverStep, rewindBoardStep, rounds, scripted as simScripted, writeFileStep, type ScriptStep } from '../helpers/simOps.js';
import { removeKeptRoot } from '../helpers/tmp.js';
import { realEngine } from '../sim/engineAdapter.js';
import { seedFilesPlan2 } from '../sim/generators.js';
import { DEFAULT_QUIESCENCE, runSim, schedulerMonoMs, type EngineFactory, type OpGenerator, type OpLogEntry, type Oracle, type SimPhase, type SimResult } from '../sim/harness.js';
import { exitOracles } from '../sim/oracles.js';
import { only, scripted } from '../sim/scripted.js';

function okOrFail(r: SimResult): void {
  assert.ok(r.ok, `run failed: ${JSON.stringify(r.failure)}; artifacts kept in ${String(r.artifactsDir)}; op-log tail ${JSON.stringify(r.opLog.slice(-8))}`);
}

/** The artifacts directory named by a thrown runSim error ("…; artifacts kept in <dir>"). */
function artifactsOf(e: unknown): string {
  const m = /; artifacts kept in (.+)$/.exec(e instanceof Error ? e.message : String(e));
  assert.ok(m !== null, `no artifacts directory in ${String(e)}`);
  return m[1]!;
}

async function readJsonl<T>(file: string): Promise<T[]> {
  return (await readFile(file, 'utf8')).split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as T);
}

/** realEngine for every peer; peer `bad` gets a remote URL that names no repository (reachable never, partitioned never). */
function withBadUrl(bad: string): EngineFactory {
  const real = realEngine();
  return (ctx, peer) => real(peer.name === bad ? { ...ctx, remote: { ...ctx.remote, url: pathToFileURL(join(ctx.root, 'no-such-remote.git')).href } } : ctx, peer);
}

/** Runs `run`, which must throw; returns the thrown runSim error's artifacts directory. */
async function failsWith(run: Promise<SimResult>, message: RegExp): Promise<string> {
  let thrown: unknown = null;
  try {
    await run;
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown !== null, 'the run threw');
  assert.match((thrown as Error).message, message);
  return artifactsOf(thrown);
}

/** "<step> <peer> start <mode>" and "<step> <peer> start_refused <code> <reason>" entries, in op-log order. */
const starts = (log: readonly OpLogEntry[]): string[] => log
  .filter((e) => e.kind === 'start' || e.kind === 'start_refused')
  .map((e) => `${e.step} ${e.peer} ${e.kind} ${e.detail.split(' ').slice(0, e.kind === 'start' ? 1 : 2).join(' ')}`);

test('R-SIM-01: a START_REMOTE refusal while the remote is reachable and no transient rejection is pending throws at the first refusal', async () => {
  const dir = await failsWith(
    runSim({ seed: 'rsim01-bad-url', peers: 2, ops: 2 }, withBadUrl('p1'), [], { generator: scripted([{ iterate: 1 }, { iterate: 1 }]) }),
    /runSim\(rsim01-bad-url\): realEngine p1: start refused START_REMOTE \{"reason":"unreachable"\}/,
  );
  const log = await readJsonl<OpLogEntry>(join(dir, 'op-log.jsonl'));
  assert.deepEqual(log.map((e) => `${e.step} ${e.kind}`), ['0 iterate'], 'the first refusal ended the run: no start_refused entry, no second step');
  assert.equal(await removeKeptRoot(dir), true, `the kept root of ${dir} is a marked makeTempRoot base, removed`);
});

test('R-SIM-01: a start refused while the remote is partitioned is retried, and the peer starts at its first step after the heal', async () => {
  const r = await runSim({ seed: 'rsim01-partition', peers: 2, ops: 6 }, realEngine(), [], {
    generator: scripted([{ gen: only('partition') }, { iterate: 0 }, { iterate: 0 }, { gen: only('heal') }, { iterate: 0 }, { iterate: 1 }]),
  });
  okOrFail(r);
  assert.deepEqual(starts(r.opLog), [
    '1 p0 start_refused START_REMOTE unreachable', '2 p0 start_refused START_REMOTE unreachable', '4 p0 start genesis', '5 p1 start join',
  ]);
});

test('R-SIM-01: a genesis refused by a pending transient rejection is retried and lands once the rejections ran out', async () => {
  const r = await runSim({ seed: 'rsim01-reject', peers: 2, ops: 5 }, realEngine(), [], {
    generator: scripted([{ gen: only('reject_transient') }, { iterate: 0 }, { iterate: 0 }, { iterate: 0 }, { iterate: 1 }]),
  });
  okOrFail(r);
  const n = Number(/\bn=(\d)/.exec(r.opLog.find((e) => e.kind === 'reject_transient')!.detail)![1]);
  const refused = Array.from({ length: n }, (_, k) => `${k + 1} p0 start_refused START_REMOTE genesis_push_failed`);
  assert.deepEqual(starts(r.opLog), [...refused, `${n + 1} p0 start genesis`, '4 p1 start join'], `n=${n}`);
});

test('R-SIM-01: a peer still unstarted 2 steps after the heal fails the run; the kept artifacts hold the op-log and the trace', async () => {
  const dir = await failsWith(
    runSim({ seed: 'rsim01-grace', peers: 2, ops: 5 }, withBadUrl('p0'), [], {
      generator: scripted([{ gen: only('partition') }, { iterate: 0 }, { gen: only('heal') }, { iterate: 0 }, { iterate: 0 }]),
    }),
    /realEngine p0: still not started 2 steps after the partition healed or the transient rejections ran out: start refused START_REMOTE \{"reason":"unreachable"\}/,
  );
  const log = await readJsonl<OpLogEntry>(join(dir, 'op-log.jsonl'));
  assert.deepEqual(starts(log), ['1 p0 start_refused START_REMOTE unreachable', '3 p0 start_refused START_REMOTE unreachable']);
  assert.ok(log.some((e) => e.kind === 'iterate' && e.step === 4), 'the run ended in step 4');
  assert.ok(existsSync(join(dir, 'trace.jsonl')), 'the trace is kept');
  assert.equal(await removeKeptRoot(dir), true, `the kept root of ${dir} is a marked makeTempRoot base, removed`);
});

// ---- the harness alone (engines that only call a crashpoint or emit a trace event) ---------------------------------

const Q = { loopMs: 1_000, k: 2, extraLoops: 2, maxRounds: 10 };

test('an armed crash is disarmed when the op budget ends, and runSim with crash restores the caller\'s crash handler', async () => {
  const kills: Array<{ phase: SimPhase; peer: string }> = [];
  const stub: EngineFactory = (_ctx, peer) => ({
    peer,
    async step(ctx) {
      try {
        crashpoint('stub.point');
      } catch (e) {
        if (!(e instanceof KilledAt)) throw e;
        kills.push({ phase: ctx.phase, peer: peer.name });
      }
    },
  });
  const OPS = 6;
  // Engine steps, then a last step without one: with rate 1 a crash is armed at that step and still armed when the
  // budget ends.
  const gen: OpGenerator = { next: (_ctx, step) => (step === OPS - 1 ? { peer: '*', kind: 'noop', run: async () => '' } : null) };
  const caller: string[] = [];
  setCrashHandler((name) => {
    caller.push(name);
  });
  try {
    const r = await runSim({ seed: 'disarm', peers: 2, ops: OPS }, stub, [], { generator: gen, quiescence: Q, crash: { rate: 1 } });
    okOrFail(r);
    assert.equal(r.quiescence?.reached, true);
    assert.ok(kills.length >= 1, 'crashes fired during the op budget');
    assert.deepEqual(kills.filter((k) => k.phase !== 'ops'), [], 'no KilledAt in a quiescence or extra round');
    assert.deepEqual(r.opLog.filter((e) => e.kind === 'crash_disarmed').map((e) => e.step), [OPS], 'the crash still armed at the end was disarmed');
    assert.deepEqual(caller, [], 'the caller\'s handler is not called while runSim owns crashpoints');
    crashpoint('after.run');
    assert.deepEqual(caller, ['after.run'], 'the caller\'s handler is back');
  } finally {
    setCrashHandler(null);
  }
});

test('the scripted wait moves the scheduler clock with every peer clock', async () => {
  const seen: Array<{ kind: string; sched: number; peers: number[] }> = [];
  const probe: Oracle = {
    name: 'CLOCKS',
    async afterEveryOp(ctx) {
      seen.push({ kind: ctx.opLog[ctx.opLog.length - 1]!.kind, sched: schedulerMonoMs(ctx), peers: ctx.peers.map((p) => ctx.clocks.get(p.name)!.monoMs()) });
      return null;
    },
  };
  const idle: EngineFactory = (_ctx, peer) => ({ peer, async step() {} });
  const r = await runSim({ seed: 'wait-clock', peers: 2, ops: 3 }, idle, [probe], { generator: scripted([{ iterate: 0 }, { wait: 7_000 }, { iterate: 1 }]) });
  okOrFail(r);
  assert.deepEqual(seen.map((s) => s.kind), ['iterate', 'wait', 'iterate']);
  const dt = Number(/^dt=(\d+)/.exec(r.opLog[1]!.detail)![1]);
  assert.equal(seen[1]!.sched - seen[0]!.sched, dt + 7_000, 'the scheduler clock moved by dt + wait');
  for (const s of seen) assert.deepEqual(s.peers, [s.sched, s.sched], 'every peer clock reads the scheduler clock\'s mono');
});

test('a failed run keeps its op-log and its trace in the artifacts', async () => {
  const tracer: EngineFactory = (_ctx, peer) => ({
    peer,
    async step(ctx) {
      ctx.trace.emit({ kind: 'iteration', peer: `id-${peer.name}`, n: ctx.opLog.length, fetched: false, applied: false, pushes: 0 });
    },
  });
  const failAt2: Oracle = { name: 'FAIL', async afterEveryOp(ctx) { return ctx.opLog.length >= 3 ? 'planted failure' : null; } };
  const r = await runSim({ seed: 'artifacts', peers: 2, ops: 5 }, tracer, [failAt2]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.failure, { oracle: 'FAIL', message: 'planted failure', step: 2 });
  const dir = r.artifactsDir!;
  const trace = await readJsonl<{ kind: string; n: number }>(join(dir, 'trace.jsonl'));
  assert.deepEqual(trace.map((e) => [e.kind, e.n]), [['iteration', 1], ['iteration', 2], ['iteration', 3]]);
  assert.deepEqual((await readJsonl<OpLogEntry>(join(dir, 'op-log.jsonl'))).map((e) => e.kind), ['step', 'step', 'step']);
  assert.equal(await removeKeptRoot(dir), true, `the kept root of ${dir} is a marked makeTempRoot base, removed`);
});

test('the human-typed recover is the adapter\'s own hook (RecoverableSimEngine.recover): a rewound board puts both peers in INCIDENT, recoverStep restores it on p0, every exit oracle passes, and nothing patches Engine.prototype', async () => {
  const iterate = Engine.prototype.iterate;
  const recover = recoverStep(0);
  assert.equal(Engine.prototype.iterate, iterate, 'building a recover step patches nothing');
  const script: ScriptStep[] = [
    { iterate: 0 }, { iterate: 1 }, { wait: 10_000 }, { iterate: 1 }, { iterate: 0 },
    writeFileStep(0, 'own/recover.txt', ['recover row 0', 'recover row 1']),
    { iterate: 0 }, { wait: 25_000 }, { iterate: 0 },
    { wait: 10_000 }, { iterate: 1 }, { iterate: 0 },
    rewindBoardStep(1),
    { wait: 3_000 }, { iterate: 0 }, { iterate: 1 },
    { wait: 3_000 }, { iterate: 0 }, { iterate: 1 },
    recover,
    ...rounds(3, 2, 5_000),
  ];
  const r = await runSim({ seed: 'adapter-recover', peers: 2, ops: script.length }, realEngine(), exitOracles(), {
    generator: simScripted(script), quiescence: { ...DEFAULT_QUIESCENCE, extraLoops: 4 }, seedFiles: seedFilesPlan2(seededRandom('adapter-recover/files')),
  });
  okOrFail(r);
  const recovers = r.opLog.filter((e) => e.kind === 'recover').map((e) => e.detail.replace(/^dt=\d+ /, ''));
  assert.deepEqual(recovers, ['preview restore done restore'], JSON.stringify(r.opLog.slice(-12)));
  assert.ok(r.opLog.some((e) => e.kind === 'rewind_board'));
  assert.equal(Engine.prototype.iterate, iterate, 'the run patched nothing');
  // The real adapter takes the verb; an engine without the hook is refused, not patched around.
  const plain: EngineFactory = (_ctx, peer) => ({ peer, async step() {} });
  const dir = await failsWith(
    runSim({ seed: 'adapter-recover-plain', peers: 1, ops: 1 }, plain, [], { generator: simScripted([recoverStep(0)]) }),
    /p0's engine has no recover hook/,
  );
  assert.equal(await removeKeptRoot(dir), true, `the kept root of ${dir} is a marked makeTempRoot base, removed`);
});

test('a killed daemon that leaves daemon.lock behind: the next boot takes the stale lock over (the dead process kept the file, not its memory)', async () => {
  // Genesis killed at its yield point again and again until one kill leaves the lock behind (a drawn 1 in 4), then let
  // through: the boot after the kept lock must take it over and the genesis complete.
  const script: Array<{ iterate: number } | { gen: OpGenerator }> = [{
    gen: {
      next: () => ({
        peer: '*', kind: 'arm_yield_kills',
        run: async (c) => {
          c.scheduler.onYield = (name) => {
            const keptOne = c.opLog.some((e) => e.kind === 'killed' && e.detail.includes('lock=kept'));
            if (name === 'start.beforeGenesisPush' && !keptOne) throw new KilledAt(name);
          };
          return '';
        },
      }),
    },
  }, ...Array.from({ length: 14 }, () => ({ iterate: 0 }))];
  const r = await runSim({ seed: 'adapter-kept-lock', peers: 1, ops: script.length }, realEngine(), [], { generator: scripted(script) });
  okOrFail(r);
  const kept = r.opLog.findIndex((e) => e.kind === 'killed' && e.detail.includes('lock=kept'));
  assert.ok(kept >= 0, `a kill left the lock behind: ${JSON.stringify(r.opLog.filter((e) => e.kind === 'killed'))}`);
  const next = r.opLog.slice(kept + 1).find((e) => e.kind === 'start' || e.kind === 'killed');
  assert.equal(next?.kind, 'start', `the next boot started: ${JSON.stringify(r.opLog.slice(kept))}`);
  assert.match(next!.detail, /^genesis sim-p0-\d+$/);
});
