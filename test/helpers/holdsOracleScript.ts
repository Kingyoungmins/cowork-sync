// Shared helpers of Task 14's SIM test files (Plan 3 Task 14). Fix round 1 split sim.oracles.holds, sim.mutants.holds and
// sim.regressions.holds by scenario so run-tests.mjs runs them as parallel test processes (R3-55, controller ruling on finding 6); the
// scenario helpers they shared live here. Every run is real git against file:// bare remotes (holdsSetup's composition).
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { MutantId } from '../../src/engine/deps.js';
import { seededRandom } from '../../src/ports/random.js';
import type { TraceEvent } from '../../src/ports/trace.js';
import { holdsSetup, seedFilesPlan3, hangul304 } from '../sim/generators.js';
import { advanceClocks, runSim, type Oracle, type SimContext, type SimResult } from '../sim/harness.js';
import type { MarkerModel } from '../sim/markers.js';
import { exitOracles } from '../sim/oracles.js';
import { emitAs, holdsOracles, peerIdOf } from '../sim/oraclesHolds.js';
import { SIM_TIMEOUT, okOrFail, play, type Step } from './holdsScript.js';

/** R3-55: a multi-seed SIM test runs all its seeds, and a long leg its full length, only under `npm run test:sim` (TEST_SIM_FULL=1). */
export const FULL = process.env['TEST_SIM_FULL'] === '1';

/**
 * Every oracle but INV-CONVERGE, whose atQuiescence needs the quiescence phase a short scenario leaves out. EF2 D1: Plan 2's
 * INV-PUSHED-IS-MERGE accepts MASK step 5's P (R minus the held hunks), so a scripted step-5 scenario runs it too (Task 14's plan2Exit,
 * which left it out, is gone).
 */
export const allButConverge = (): Oracle[] => [...exitOracles().filter((o) => o.name !== 'INV-CONVERGE'), ...holdsOracles()];

/** A fresh oracle's verdict on the context as it is now (its cursor starts at the first event). */
export const fresh = async (make: () => Oracle, ctx: SimContext): Promise<string | null> => make().afterEveryOp!(ctx);

/** The run's own eight oracles, judging every step until a probe starts planting (plants are judged by fresh instances only). */
export function untilPlanting(): { oracles: Oracle[]; plant(): void } {
  let planting = false;
  const oracles = holdsOracles().map((o): Oracle => ({ name: o.name, afterEveryOp: (ctx) => (planting ? Promise.resolve(null) : o.afterEveryOp!(ctx)) }));
  return { oracles, plant: () => { planting = true; } };
}

export const CI = '.github/workflows/ci.yml';
export const lf = (rows: readonly string[]): Buffer => Buffer.from(rows.map((r) => `${r}\n`).join(''), 'utf8');
/** seedFilesPlan3 plus a QUARANTINED workflow file. */
export const withCi = (seed: string): Record<string, Buffer> => ({ ...seedFilesPlan3(seededRandom(`${seed}/files`)), [CI]: Buffer.from('name: ci\non: push\n', 'utf8') });
export const lastOf = <K extends TraceEvent['kind']>(ctx: SimContext, kind: K, peer: string): Extract<TraceEvent, { kind: K }> => {
  const e = ctx.trace.ofKind(kind).filter((x) => (x as { peer: string }).peer === peer).pop();
  assert.ok(e !== undefined, `no ${kind} event of ${peer}`);
  return e;
};

export const G3 = ['g/a.txt', 'g/b.txt', 'g/c.txt'];
/** Three seeded (pre-genesis) files of seedFilesPlan3: a peer's edit of their rows is no teammate-line revert (R3-37). */
export const FMT3 = ['fmt/m01.py', 'fmt/m02.py', 'fmt/m03.py'];
/** p1 creates g/a.txt, g/b.txt and g/c.txt in one human CS, which every peer applies. */
export const g3Steps = (): Step[] => [
  { rounds: 1 },
  ...G3.map((path): Step => ({ kind: 'new_file', peer: 1, params: { path, rows: 4 } })),
  { rounds: 14 },
];

/** The stageable host-table non-portable name (R3-35): con.py on Linux and macOS, HANGUL304 on Windows. */
export const STAGEABLE_NP = process.platform === 'win32' ? hangul304(1) : 'con.py';

/** Inside a probe: `ms` of virtual time pass (every clock), then peer i runs one engine step and the scheduler drains. */
export async function tick(ctx: SimContext, i: number, ms = 2_500): Promise<void> {
  advanceClocks(ctx, ms);
  await ctx.engines[i]!.step(ctx);
  await ctx.scheduler.runUntilIdle(10_000);
}

/** p's loops from trace index `from` to the first event matching `pred`: its iteration events before that event, plus one (null: none). */
export function loopsUntil(ctx: SimContext, peerId: string, from: number, pred: (e: TraceEvent) => boolean): number | null {
  let loops = 1;
  const ev = ctx.trace.events;
  for (let k = from; k < ev.length; k++) {
    const e = ev[k]!;
    if (pred(e)) return loops;
    if (e.kind === 'iteration' && e.peer === peerId) loops++;
  }
  return null;
}

/** The index of the landed push of the publish of peer `peerId` whose live commit changes `path` against its parent (first after `from`). */
export async function landedChange(ctx: SimContext, i: number, path: string, from = 0): Promise<{ push: number; c: string } | null> {
  const id = peerIdOf(ctx, i);
  const dir = ctx.peers[i]!.dir;
  const ev = ctx.trace.events;
  for (let k = from; k < ev.length; k++) {
    const e = ev[k]!;
    if (e.kind !== 'publish' || e.peer !== id || e.c === null) continue;
    const push = ev.findIndex((x, j) => j > k && x.kind === 'push' && x.peer === id && x.bnew === e.bnew && x.outcome === 'landed');
    if (push < 0) continue;
    const r = await ctx.git.run(['diff-tree', '--no-commit-id', '-r', '--name-only', '-z', `${e.c}^`, e.c], { class: 'local', cwd: dir });
    if (r.stdout.toString('utf8').split('\0').includes(path)) return { push, c: e.c };
  }
  return null;
}

export const f40 = (prefix: string, n = 20): Buffer => Buffer.from(Array.from({ length: n }, (_, k) => `${prefix} row ${k + 1}\n`).join(''), 'utf8');

const FAKE_BNEW = 'f'.repeat(40);

/** Plants a landed ordinary live commit of peer i: a copy of compose event `ce`, then publish and push events naming commit `c`. */
export function plantLanded(ctx: SimContext, i: number, ce: Extract<TraceEvent, { kind: 'compose' }>, c: string, outTree: string, conflicted: readonly string[] = []): void {
  const peer = peerIdOf(ctx, i);
  emitAs(ctx, i, ce);
  emitAs(ctx, i, { kind: 'publish', peer, t: ce.tip, tip: ce.tip, aTree: ce.aTree, pTree: ce.pTree, outTree, c, bnew: FAKE_BNEW, conflicted, replaced: [] });
  emitAs(ctx, i, { kind: 'push', peer, purpose: 'publish', argv: [], bnew: FAKE_BNEW, outcome: 'landed' });
}

/** A recorder (first in the list, never failing) noting the op-log step at which `predicate` first holds over the trace so far. */
export function recorder(predicate: (ctx: SimContext) => boolean): Oracle & { step: number | null } {
  const r: Oracle & { step: number | null } = {
    name: 'PREDICTED', step: null,
    async afterEveryOp(ctx) {
      if (r.step === null && predicate(ctx)) r.step = ctx.opLog[ctx.opLog.length - 1]!.step;
      return null;
    },
  };
  return r;
}

/** Plan 2's six exit oracles and the eight of Task 14, `expected` moved last, behind `head`. */
export function withLast(expected: string, head: Oracle): Oracle[] {
  const all = [...exitOracles(), ...holdsOracles()];
  return [head, ...all.filter((x) => x.name !== expected), ...all.filter((x) => x.name === expected)];
}

/** The index of the first trace event at or after `from` matching `pred`, or -1. */
export function indexOf(ctx: SimContext, from: number, pred: (e: TraceEvent) => boolean): number {
  const ev = ctx.trace.events;
  for (let k = Math.max(0, from); k < ev.length; k++) if (pred(ev[k]!)) return k;
  return -1;
}

/** One scripted holds run: `mutants` on, the oracles in the given order, the R-32 quiescence only when asked. */
export async function scenarioRun(seed: string, make: (m: MarkerModel) => Step[], o: { mutants?: ReadonlySet<MutantId>; oracles: Oracle[]; quiescence: boolean; seedFiles?: Record<string, Buffer> }): Promise<SimResult> {
  const s = holdsSetup(seed, { script: [], ...(o.mutants === undefined ? {} : { mutants: o.mutants }), seedFiles: o.seedFiles ?? seedFilesPlan3(seededRandom(`${seed}/files`)) });
  const steps = make(s.markers);
  const options = { ...s.options, generator: play(steps, s.markers) };
  if (!o.quiescence) delete (options as { quiescence?: unknown }).quiescence;
  return runSim({ ...s.tuple, ops: steps.length }, s.factory, o.oracles, options);
}

/** One TC-TST-02 scenario (11-testing §3.9; R3-50). */
export interface Scenario {
  mutant: MutantId;
  expected: 'INV-MASK' | 'INV-GROUP';
  seed: string;
  seedFiles?: Record<string, Buffer>;
  /** The steps; `mark` is called by a probe at the scenario's trigger op (the trace index from which the prediction is searched). */
  steps(mark: (ctx: SimContext) => void): Step[];
  /** The predicted event: true once it is in the trace (searched from the marked index; `from` is -1 before the mark). */
  predicted(ctx: SimContext, from: number): boolean;
  /** A probe appended to the mutant-off leg's steps (before its quiescence, when it has one). */
  offProbe?: Step;
}

/** The X-05 regressions title (Task 14 brief); each of its three scenarios has its own file (fix round 1 split, R3-55). */
export const X05 = 'X-05 regressions with every Task 14 oracle on: hold/exp_f (rebased mask) — a held row survives p1\'s 5-row insertion above it and sPub equals testMask; hold/exp_k_stash — git stash on p0 holding an ON_DISK revert PATCH freezes EPOCH within one iteration, no record transition and no publish while frozen, stash pop returns E1 and the record keeps its id and rev; holdcat/X3 — p0\'s stale re-add of a row p1 deleted becomes a revert PATCH and never reaches live_code; atom/x8b — 6 single-file `nonconforming_push` `plain` commits, each followed by `{advance: 1_500}` and `{iterate: 0}` (p0 iterates once; all six land within 7.5 virtual s, before p0\'s second permitted apply under Plan 2\'s 10 s `APPLY_COALESCE_MS`), then `{rounds: 1}` steps: exactly 2 applies on p0 (the first at p0\'s first iteration, the second ≥ 10 s later covering the rest), no two written applies < 10 s apart by `monoAt`, and all six CSs applied within 10 s plus one loop after the last commit';

/** The TC-TST-02 title (11-testing §3.9); each mutant's file runs it for its own scenario (fix round 1 split, R3-55). */
export const TC_TST_02 = 'TC-TST-02 form: run with the expected oracle last in the list, M19 fails INV-MASK, M25 fails INV-MASK, M38 fails INV-GROUP and M39 fails INV-GROUP, each first at the step its scenario predicts and with no earlier oracle firing; with the mutant off every scenario passes all oracles';

/**
 * TC-TST-02 for one scenario: the mutant run (killed first at the predicted step by the expected oracle, listed last) and the mutant-off
 * run (every oracle passes, Plan 2's INV-PUSHED-IS-MERGE included since EF2 D1; the scenario's offProbe, if any, ends its steps). R3-55:
 * the off run's R-32 quiescence leg (and so INV-CONVERGE) only under TEST_SIM_FULL; under `npm test` it is the same script judged by every
 * other oracle after every step.
 */
export async function tcTst02(t: TestContext, sc: Scenario): Promise<void> {
  await t.test(`${sc.mutant} fails ${sc.expected}`, { timeout: SIM_TIMEOUT }, async () => {
    let from = -1;
    const rec = recorder((ctx) => sc.predicted(ctx, from));
    const r = await scenarioRun(sc.seed, () => sc.steps((ctx) => { from = ctx.trace.events.length; }), {
      mutants: new Set([sc.mutant]), oracles: withLast(sc.expected, rec), quiescence: false, ...(sc.seedFiles === undefined ? {} : { seedFiles: sc.seedFiles }),
    });
    assert.equal(r.ok, false, `${sc.mutant} is killed`);
    assert.equal(r.failure!.oracle, sc.expected, `${sc.mutant}: the first oracle to fire is ${sc.expected}: ${JSON.stringify(r.failure)}`);
    assert.ok(rec.step !== null, `${sc.mutant}: the predicted event happened`);
    assert.equal(r.failure!.step, rec.step, `${sc.mutant}: it fires first at the predicted step (${rec.step}): ${r.failure!.message}`);
    t.diagnostic(`${sc.mutant}: ${sc.expected} at step ${r.failure!.step}: ${r.failure!.message.slice(0, 300)}`);
  });
  await t.test(`${sc.mutant} off: every oracle passes${FULL ? ' (with the R-32 quiescence)' : ' (npm test form: no quiescence leg, INV-CONVERGE left out)'}`, { timeout: SIM_TIMEOUT }, async () => {
    const r = await scenarioRun(sc.seed, () => [...sc.steps(() => undefined), ...(sc.offProbe === undefined ? [] : [sc.offProbe])], {
      oracles: FULL ? [...exitOracles(), ...holdsOracles()] : allButConverge(), quiescence: FULL, ...(sc.seedFiles === undefined ? {} : { seedFiles: sc.seedFiles }),
    });
    okOrFail(r);
  });
}
