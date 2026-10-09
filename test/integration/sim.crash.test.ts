// The SIM crash matrix (Task 19; 01-engine test 26, ENG-59; 11-testing TST-06, §3.6; Review Focus 5). Every crashpoint
// Plan 2 places — the 13 names of ENG-59 and registry.cas (test/helpers/plan2Crashpoints.ts, the set
// test/unit/crashpoints-placed.test.ts pins) — and the genesis yield point start.beforeGenesisPush are killed exactly
// once in each of 3 `faults` seeds: the chosen hit's engine step dies with KilledAt (the process died: engine dropped,
// daemon.lock released) and the peer's next step restarts it from disk through startDispatch. Every run then passes the
// six exit oracles (INV-FF, INV-OID, INV-FIRSTPARENT, INV-BASE, INV-PUSHED-IS-MERGE, INV-CONVERGE) after every op and
// at quiescence.
//
// The three seeds use distinct kill schedules:
//   crash-matrix-0  every point at its first hit (most of them in the scripted prologue);
//   crash-matrix-1  the points of an ordinary iteration (apply.intent, apply.group.phase1/phase2, apply.state, the three
//                   publish points, snapshot.index_written) at their first hit after the prologue — in the `faults` phase,
//                   or, for a point that phase never reaches (a partition can hold every fetch for its 40 steps), at its
//                   first hit once the op budget ended — the rest at their first hit;
//   crash-matrix-2  those points at their first hit while a fault is active — inside a race_push op (two engines
//                   interleaved at publish.beforePush), while the remote is partitioned, or while a transient rejection is
//                   pending — or, for a point no fault meets, at its first hit once the op budget ended.
//
// A scripted prologue makes every point reachable on 3 peers — genesis and two joins; a 2-path change-set and an
// independent one applied together (apply.group.mid, apply.between_groups); a same-line edit on two peers (registry.cas);
// a board rewind and a human recover (recover.displaced); a late peer whose own commits a second rewind and recover left
// off the chain, re-anchored by its recover (recover.reanchor) — then the `faults` generator (partitions, transient
// rejections, lease races, edits) runs on, and the R-32 quiescence ends the run.
//
// Real git against a file:// bare remote; git is never mocked. Long: runs when COWORK_SIM_LONG=1 (sim-long.yml).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KilledAt, setCrashHandler } from '../../src/ports/crashpoint.js';
import { seededRandom } from '../../src/ports/random.js';
import { GENESIS_YIELD, PLAN2_CRASHPOINTS } from '../helpers/plan2Crashpoints.js';
import { dropArtifacts, editRowStep, recoverStep, rewindBoardStep, rounds, scripted, writeFileStep, type ScriptStep } from '../helpers/simOps.js';
import { realEngine } from '../sim/engineAdapter.js';
import { editGenerator, PROFILES, seedFilesPlan2 } from '../sim/generators.js';
import { DEFAULT_QUIESCENCE, runSim, type OpGenerator, type SimContext, type SimResult } from '../sim/harness.js';
import { exitOracles } from '../sim/oracles.js';

const LONG = process.env['COWORK_SIM_LONG'] === '1';
/** A rerun aid: COWORK_SIM_ONLY=crash-matrix-1 runs only that seed's subtest. */
const ONLY = process.env['COWORK_SIM_ONLY']?.split(',') ?? null;

/** R-31's `faults` budget after the prologue. */
const FAULT_STEPS = 40;
const PEERS = 3;
/** The points an ordinary iteration reaches (an apply, a publish, a ready-pair capture): the ones a schedule may defer. */
const ITERATION_POINTS: readonly string[] = Object.freeze([
  'apply.intent', 'apply.group.phase1', 'apply.group.phase2', 'apply.state', 'publish.out_built', 'publish.sent', 'publish.landed', 'snapshot.index_written',
]);
/** The op-log kinds the engine adapter adds inside an op (never the op itself). */
const ADAPTER_KINDS: ReadonlySet<string> = new Set(['start', 'start_refused', 'killed', 'crash_armed', 'crash_disarmed']);

type Schedule = 'first' | 'faults-phase' | 'fault-active';
const SEEDS: ReadonlyArray<{ seed: string; schedule: Schedule }> = Object.freeze([
  { seed: 'crash-matrix-0', schedule: 'first' },
  { seed: 'crash-matrix-1', schedule: 'faults-phase' },
  { seed: 'crash-matrix-2', schedule: 'fault-active' },
]);

const rows = (tag: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${tag} row ${i}`);

/** Every peer at the same board tip: rounds with nothing new to publish. */
const settle = (n: number): ScriptStep[] => rounds(n, PEERS, 5_000);

function prologue(start: (ctx: SimContext) => void): ScriptStep[] {
  return [
    { op: (ctx) => ({ peer: '*', kind: 'arm_kills', run: async (c) => { start(c); return GENESIS_YIELD; } }) },
    // Genesis (killed before its push, then again from scratch) and two joins (the first killed after its first apply).
    { iterate: 0 }, { iterate: 0 }, { iterate: 1 }, { iterate: 1 }, { iterate: 2 },
    ...settle(6),
    // A 2-path change-set on p0 and an independent one on p1; p2 applies both in one apply (two groups).
    writeFileStep(0, 'own/cm-p0-a.txt', rows('p0 a', 4)),
    writeFileStep(0, 'own/cm-p0-b.txt', rows('p0 b', 4)),
    writeFileStep(1, 'own/cm-p1-a.txt', rows('p1 a', 4)),
    { iterate: 0 }, { iterate: 1 }, { wait: 25_000 },
    { iterate: 0 }, { wait: 6_000 }, { iterate: 0 },
    ...Array.from({ length: 8 }, (): ScriptStep[] => [{ wait: 11_000 }, { iterate: 1 }]).flat(),
    { wait: 11_000 }, { iterate: 2 }, { wait: 11_000 }, { iterate: 2 }, { wait: 11_000 }, { iterate: 2 },
    ...settle(6),
    // The same line of notes.txt on p0 and p1: the later one's apply displaces its row (K4, a hold record).
    editRowStep(0, 'notes.txt', 4, 'note row 4 p0 crash-matrix'),
    editRowStep(1, 'notes.txt', 4, 'note row 4 p1 crash-matrix'),
    { iterate: 0 }, { iterate: 1 }, { wait: 25_000 },
    { iterate: 0 }, { wait: 11_000 }, { iterate: 1 }, { wait: 11_000 }, { iterate: 1 },
    ...settle(6),
    // A rewound board: INCIDENT everywhere, a human recover on p0 (dies at recover.displaced, restarts, is re-run).
    rewindBoardStep(1),
    ...rounds(2, PEERS, 6_000),
    recoverStep(0), recoverStep(0),
    ...settle(6),
    // Re-anchor (01-engine test 35): p1 alone publishes twice; the board is rewound below everyone's LA_B; p0 detects,
    // pushes its displaced copy and restores its LA_B; p0 publishes on it; p1 wakes, detects and re-anchors.
    writeFileStep(1, 'own/cm-p1-late-1.txt', rows('p1 late 1', 3)), { iterate: 1 }, { wait: 25_000 }, { iterate: 1 },
    writeFileStep(1, 'own/cm-p1-late-2.txt', rows('p1 late 2', 3)), { iterate: 1 }, { wait: 25_000 }, { iterate: 1 },
    rewindBoardStep(3),
    { wait: 3_000 }, { iterate: 0 }, { wait: 6_000 }, { iterate: 0 }, { wait: 6_000 }, { iterate: 0 },
    recoverStep(0),
    { wait: 6_000 }, { iterate: 0 }, { iterate: 2 },
    writeFileStep(0, 'own/cm-p0-after.txt', rows('p0 after', 3)), { iterate: 0 }, { wait: 25_000 }, { iterate: 0 },
    { wait: 6_000 }, { iterate: 2 }, { iterate: 0 },
    { wait: 3_000 }, { iterate: 1 }, { wait: 6_000 }, { iterate: 1 }, { wait: 6_000 }, { iterate: 1 },
    recoverStep(1), recoverStep(1),
    ...settle(4),
  ];
}

/** `first` for its steps, then `rest`. */
function then(first: OpGenerator, steps: number, rest: OpGenerator): OpGenerator {
  return { next: (ctx, step) => (step < steps ? first.next(ctx, step) : rest.next(ctx, step)) };
}

/** The op the harness is running now (the last op-log entry the adapter did not add) and its step. */
function currentOp(ctx: SimContext): { step: number; kind: string } {
  for (let i = ctx.opLog.length - 1; i >= 0; i--) {
    const e = ctx.opLog[i]!;
    if (!ADAPTER_KINDS.has(e.kind)) return { step: e.step, kind: e.kind };
  }
  return { step: -1, kind: '' };
}

/** A fault is active now: a race_push op is running, the remote is partitioned, or a transient rejection is pending. */
function faultActive(ctx: SimContext): string | null {
  if (currentOp(ctx).kind === 'race_push') return 'race_push';
  for (let i = ctx.opLog.length - 1; i >= 0; i--) {
    const e = ctx.opLog[i]!;
    if (e.kind === 'heal') break;
    if (e.kind === 'partition' && e.detail.includes('remote renamed')) return 'partitioned';
  }
  try {
    const c = JSON.parse(readFileSync(join(ctx.root, 'remote-control.json'), 'utf8')) as { count?: unknown };
    if (typeof c.count === 'number' && c.count > 0) return 'rejection_pending';
  } catch {
    // no control file: no rejection armed
  }
  return null;
}

interface Kill { name: string; step: number; phase: string; op: string; fault: string | null; }

test('each of the 14 crashpoints killed once in each of 3 faults seeds, with restart, passes every exit oracle', { skip: !LONG && 'set COWORK_SIM_LONG=1 (sim-long.yml runs the crash matrix nightly)' }, async (t) => {
  assert.equal(PLAN2_CRASHPOINTS.length, 14);
  for (const { seed, schedule } of SEEDS) {
    await t.test(`${seed} (${schedule})`, { skip: ONLY !== null && !ONLY.includes(seed) && `COWORK_SIM_ONLY=${ONLY.join(',')}` }, async () => {
      const kills: Kill[] = [];
      let run: SimContext | null = null;
      let prologueSteps = 0;
      const kill = (name: string): void => {
        const ctx = run;
        if (ctx === null || kills.some((k) => k.name === name)) return;
        const op = currentOp(ctx);
        const fault = faultActive(ctx);
        if (schedule !== 'first' && ITERATION_POINTS.includes(name)) {
          const inFaults = ctx.phase === 'ops' && op.step >= prologueSteps;
          const due = schedule === 'faults-phase' ? inFaults || ctx.phase !== 'ops' : (inFaults && fault !== null) || ctx.phase !== 'ops';
          if (!due) return;
        }
        kills.push({ name, step: op.step, phase: ctx.phase, op: op.kind, fault });
        throw new KilledAt(name);
      };
      const script = prologue((ctx) => {
        run = ctx;
        ctx.scheduler.onYield = (name) => {
          if (name === GENESIS_YIELD) kill(name);
        };
      });
      prologueSteps = script.length;
      let r: SimResult;
      setCrashHandler((name) => {
        if (PLAN2_CRASHPOINTS.includes(name)) kill(name);
      });
      try {
        r = await runSim({ seed, peers: PEERS, ops: script.length + FAULT_STEPS }, realEngine(), exitOracles(), {
          generator: then(scripted(script), script.length, editGenerator(PROFILES.faults)),
          quiescence: DEFAULT_QUIESCENCE, seedFiles: seedFilesPlan2(seededRandom(`${seed}/files`)),
        });
      } finally {
        setCrashHandler(null);
      }
      const killed = kills.map((k) => k.name);
      const where = JSON.stringify(kills);
      // A failed run keeps its temp root (runSim): the message names it.
      assert.ok(r.ok, `${seed}: ${JSON.stringify(r.failure)} (artifacts kept in ${String(r.artifactsDir)}); kills ${where}; op-log tail ${JSON.stringify(r.opLog.slice(-10))}`);
      await dropArtifacts(r);
      assert.deepEqual([...killed].sort(), [...PLAN2_CRASHPOINTS, GENESIS_YIELD].sort(), `${seed}: every point killed exactly once: ${where}`);
      const deferred = kills.filter((k) => ITERATION_POINTS.includes(k.name));
      if (schedule === 'first') assert.ok(kills.every((k) => k.step < prologueSteps), `${seed}: every kill in the prologue: ${where}`);
      if (schedule === 'faults-phase') {
        assert.ok(deferred.every((k) => k.phase !== 'ops' || k.step >= prologueSteps), `${seed}: the iteration points die after the prologue: ${where}`);
        assert.ok(deferred.some((k) => k.phase === 'ops' && k.step >= prologueSteps), `${seed}: kills in the faults phase: ${where}`);
      }
      if (schedule === 'fault-active') {
        assert.ok(deferred.every((k) => k.fault !== null || k.phase !== 'ops'), `${seed}: each iteration point dies under a fault, or after the op budget: ${where}`);
        assert.ok(deferred.some((k) => k.fault !== null), `${seed}: kills during a faults op: ${where}`);
      }
      // Each kill ended its peer's step; that peer's next engine step booted it again from disk (startDispatch) — or was
      // itself killed while booting (a second point reached during the restart) — until a start succeeded. Once a state
      // existed the start is a RESTART; the genesis yield lies before any state, so the start after it is a genesis, or a
      // restart when that genesis committed its state and was then killed at a later point.
      const killedLog = r.opLog.filter((e) => e.kind === 'killed');
      assert.deepEqual(killedLog.map((e) => e.detail.split(' ')[0]).sort(), [...killed].sort(), 'one killed entry per kill');
      for (const k of killedLog) {
        const after = r.opLog.filter((e) => e.step >= k.step && e !== k && r.opLog.indexOf(e) > r.opLog.indexOf(k) && e.peer === k.peer && (e.kind === 'start' || e.kind === 'start_refused' || e.kind === 'killed'));
        const next = after[0];
        assert.ok(next !== undefined && next.kind !== 'start_refused', `${k.peer} booted again after ${k.detail}: ${JSON.stringify(next)}`);
        const started = after.find((e) => e.kind === 'start');
        assert.ok(started !== undefined, `${k.peer} started again after ${k.detail}`);
        const mode = started.detail.split(' ')[0];
        assert.ok(k.detail.startsWith(`${GENESIS_YIELD} `) ? ['genesis', 'restart'].includes(mode ?? '') : mode === 'restart', `${k.peer} after ${k.detail}: ${started.detail}`);
      }
      const recovers = r.opLog.filter((e) => e.kind === 'recover').map((e) => `${e.peer}: ${e.detail.replace(/^dt=\d+ /, '')}`);
      assert.ok(recovers.some((x) => /^p0: .*done restore/.test(x)), JSON.stringify(recovers));
      assert.ok(recovers.some((x) => /^p1: .*done reanchor/.test(x)), JSON.stringify(recovers));
      assert.equal(r.quiescence?.reached, true);
    });
  }
});
