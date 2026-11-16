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
// The driver and the prologue's segments live in test/sim/crashMatrix.ts (Plan 3 Task 16 extracted them, unchanged, so the `holds`
// crash matrix shares them); this file supplies the faults setup and its schedules.
//
// Real git against a file:// bare remote; git is never mocked. Long: runs when COWORK_SIM_LONG=1 (sim-long.yml).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { seededRandom } from '../../src/ports/random.js';
import { GENESIS_YIELD, PLAN2_CRASHPOINTS } from '../helpers/plan2Crashpoints.js';
import { dropArtifacts, scripted, type ScriptStep } from '../helpers/simOps.js';
import { currentOp, groupsLeadIn, joinLeadIn, k4LeadIn, reanchorLeadIn, rewindLeadIn, runCrashMatrix, then, type MatrixView } from '../sim/crashMatrix.js';
import { realEngine } from '../sim/engineAdapter.js';
import { editGenerator, PROFILES, seedFilesPlan2 } from '../sim/generators.js';
import { DEFAULT_QUIESCENCE, type SimContext } from '../sim/harness.js';
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

type Schedule = 'first' | 'faults-phase' | 'fault-active';
const SEEDS: ReadonlyArray<{ seed: string; schedule: Schedule }> = Object.freeze([
  { seed: 'crash-matrix-0', schedule: 'first' },
  { seed: 'crash-matrix-1', schedule: 'faults-phase' },
  { seed: 'crash-matrix-2', schedule: 'fault-active' },
]);

/**
 * Plan 2's prologue (the lead-in segments of test/sim/crashMatrix.ts in their Plan 2 order): the kill-arming op (step 0 — the driver
 * arms the crash handler and the yield hook itself, so the op only names the yield point), genesis and two joins, the two change-sets
 * one apply takes in two groups, the K4 same-line edit, the board rewind and recover, the re-anchor.
 */
function prologue(): ScriptStep[] {
  return [
    { op: () => ({ peer: '*', kind: 'arm_kills', run: async () => GENESIS_YIELD }) },
    ...joinLeadIn(PEERS),
    ...groupsLeadIn(PEERS),
    ...k4LeadIn(PEERS),
    ...rewindLeadIn(PEERS),
    ...reanchorLeadIn(PEERS),
  ];
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

/**
 * The faults setup of the driver (Plan 2's schedules, unchanged): the prologue, then the `faults` generator; every Plan 2 crashpoint
 * and the genesis yield die once — at their first hit, or (crash-matrix-1, -2) an iteration point only once its schedule is due.
 */
function faultsRun(s: { seed: string; schedule: Schedule }, prologueSteps: number, script: readonly ScriptStep[]) {
  return {
    tuple: { seed: s.seed, peers: PEERS, ops: script.length + FAULT_STEPS },
    factory: realEngine(),
    oracles: exitOracles(),
    options: {
      generator: then(scripted(script), script.length, editGenerator(PROFILES.faults)),
      quiescence: DEFAULT_QUIESCENCE, seedFiles: seedFilesPlan2(seededRandom(`${s.seed}/files`)),
    },
    kill(name: string, v: MatrixView): string | null {
      if (name !== GENESIS_YIELD && !PLAN2_CRASHPOINTS.includes(name)) return null;
      if (v.kills.some((k) => k.name === name)) return null;
      const op = currentOp(v.ctx);
      const fault = faultActive(v.ctx);
      if (s.schedule !== 'first' && ITERATION_POINTS.includes(name)) {
        const inFaults = v.ctx.phase === 'ops' && op.step >= prologueSteps;
        const due = s.schedule === 'faults-phase' ? inFaults || v.ctx.phase !== 'ops' : (inFaults && fault !== null) || v.ctx.phase !== 'ops';
        if (!due) return null;
      }
      return fault ?? '';
    },
  };
}

test('each of the 14 crashpoints killed once in each of 3 faults seeds, with restart, passes every exit oracle', { skip: !LONG && 'set COWORK_SIM_LONG=1 (sim-long.yml runs the crash matrix nightly)' }, async (t) => {
  assert.equal(PLAN2_CRASHPOINTS.length, 14);
  for (const { seed, schedule } of SEEDS) {
    await t.test(`${seed} (${schedule})`, { skip: ONLY !== null && !ONLY.includes(seed) && `COWORK_SIM_ONLY=${ONLY.join(',')}` }, async () => {
      const script = prologue();
      const prologueSteps = script.length;
      // crashMatrix.ts drives the run (Plan 3 Task 16: the driver extracted from this test, parameterised by this setup).
      const [res] = await runCrashMatrix((s) => faultsRun(s, prologueSteps, script), [{ seed, schedule }]);
      const r = res!.r;
      const kills: Kill[] = res!.kills.map((k) => ({ name: k.name, step: k.step, phase: k.phase, op: k.op, fault: k.note === '' ? null : k.note }));
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

/**
 * crash-matrix-0's whole prologue (204 steps) under the pre-extraction driver: recorded from f17c589's sim.crash.test.ts (a scratch copy of
 * that commit whose test ran the prologue with its own crash handler, yield hook and runSim, five exit oracles, no quiescence; Plan 3
 * Task 16 fix round 1, 296 s). Each kill [point, op-log step, op, killed peer]; each restart [step, peer, start mode]; each recover
 * [step, peer, outcome]. The prologue kills 13 of the 15 points (apply.between_groups and recover.reanchor are not reached in it on this
 * engine: the full test meets them later or fails there, as before the extraction).
 */
const PROLOGUE_F17C589 = Object.freeze({
  steps: 204,
  kills: [
    [GENESIS_YIELD, 1, 'iterate', 'p0'], ['snapshot.index_written', 2, 'iterate', 'p0'], ['join.first_apply', 3, 'iterate', 'p1'],
    ['publish.out_built', 9, 'iterate', 'p2'], ['publish.sent', 12, 'iterate', 'p1'], ['publish.landed', 17, 'iterate', 'p2'],
    ['apply.intent', 40, 'iterate', 'p1'], ['apply.group.phase1', 44, 'iterate', 'p1'], ['apply.group.mid', 48, 'iterate', 'p1'],
    ['apply.group.phase2', 52, 'iterate', 'p1'], ['apply.state', 56, 'iterate', 'p2'], ['registry.cas', 92, 'iterate', 'p1'],
    ['recover.displaced', 169, 'recover', 'p0'],
  ],
  starts: [
    [4, 'p1', 'restart'], [5, 'p2', 'join'], [7, 'p0', 'restart'], [13, 'p2', 'restart'], [16, 'p1', 'restart'], [21, 'p2', 'restart'],
    [42, 'p1', 'restart'], [46, 'p1', 'restart'], [50, 'p1', 'restart'], [54, 'p1', 'restart'], [58, 'p2', 'restart'], [94, 'p1', 'restart'],
    [171, 'p0', 'restart'],
  ],
  recovers: [
    [128, 'p0', 'refused RECOVER_NOT_IN_INCIDENT'], [129, 'p0', 'refused RECOVER_NOT_IN_INCIDENT'], [169, 'p0', 'preview restore'],
    [186, 'p1', 'preview restore done restore'], [187, 'p1', 'refused RECOVER_NOT_IN_INCIDENT'],
  ],
});

// Plan 3 Task 16 (fix round 1: the whole prologue): the extraction kept the runs — the same seed through runCrashMatrix with this file's
// faults setup kills the same points, at the same steps, in the same peers' engine calls, restarts and recovers them the same way as the
// pre-extraction test did (PROLOGUE_F17C589), with five exit oracles after every op. The full three-seed test (each point once per seed,
// the schedules, quiescence) is the COWORK_SIM_LONG run above (sim-long.yml).
test('crashMatrix.ts drives Plan 2\'s sim.crash runs unchanged', { timeout: 40 * 60_000 }, async () => {
  const src = readFileSync(new URL('./sim.crash.test.ts', import.meta.url), 'utf8');
  assert.match(src, /import \{[^}]*runCrashMatrix[^}]*\} from '\.\.\/sim\/crashMatrix\.js';/, 'the matrix runs through the shared driver');
  assert.doesNotMatch(src, /setCrashHandler\(|await runSim\(/, 'no crash handler and no runSim of its own');
  const script = prologue();
  assert.equal(script.length, PROLOGUE_F17C589.steps, 'Plan 2\'s prologue, unchanged');
  const [res] = await runCrashMatrix((s) => {
    const run = faultsRun(s, script.length, script);
    return { ...run, tuple: { ...run.tuple, ops: script.length }, oracles: exitOracles().filter((o) => o.name !== 'INV-CONVERGE'), options: { ...run.options, quiescence: undefined } };
  }, [{ seed: 'crash-matrix-0', schedule: 'first' as const }]);
  const r = res!.r;
  assert.ok(r.ok, JSON.stringify(r.failure));
  await dropArtifacts(r);
  assert.deepEqual(res!.kills.map((k) => [k.name, k.step, k.op, k.peer]), PROLOGUE_F17C589.kills, 'every kill: point, step, op and peer');
  assert.deepEqual(r.opLog.filter((e) => e.kind === 'killed').map((e) => [e.step, e.peer, e.detail.split(' ')[0]]), PROLOGUE_F17C589.kills.map(([n, step, , peer]) => [step, peer, n]), 'one killed row per kill, in that peer');
  assert.deepEqual(r.opLog.filter((e) => e.kind === 'start').map((e) => [e.step, e.peer, e.detail.split(' ')[0]]), PROLOGUE_F17C589.starts, 'every restart (and the join) at the same step');
  assert.deepEqual(r.opLog.filter((e) => e.kind === 'recover').map((e) => [e.step, e.peer, e.detail.replace(/^dt=\d+ /, '')]), PROLOGUE_F17C589.recovers, 'every recover with the same outcome');
});
