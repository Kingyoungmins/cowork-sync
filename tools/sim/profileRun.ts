// What one seed of a profile runs (Plan 2 Task 19, Plan 3 Task 16; 11-testing §3.3, §3.11; rulings R-31, R-32, R3-47, R3-49, R3-51):
// the seed tuple, the engine factory, the SimOptions and the exit oracles of run-shard.ts — the one composition every seed runner uses,
// so a test can read it without running a seed.
//   edits   R-31: human edits only (editGenerator, PROFILES.edits), seedFilesPlan2, the R-32 quiescence, no crash injection;
//   faults  the same plus partitions, transient rejections and lease races, and crash injection p = 0.02 per step;
//   holds   R3-47: holdsSetup — 3 peers by default, PROFILES.holds.steps (60) steps, seedFilesPlan3, crash rate 0.02, the MASS resume
//           before each quiescence round (EF2 D2).
// Every profile (R3-49, R3-37) runs with one MarkerModel noted by its generator, SimOptions.settled = holdTimersSettled (a revert
// record's +10 min event or a 60 s INCOMING creation keeps T* back until it pushed) and exitOracles(ns, {holds: {markers}}): Plan 2's
// six exit oracles followed by Plan 3's ten.
// tools/ is outside src/, so the L-CLOCK and L-PORTS lints do not apply here.
import type { MutantId } from '../../src/engine/deps.js';
import { RELEASE_NAMESPACE } from '../../src/engine/refs.js';
import { seededRandom } from '../../src/ports/random.js';
import { realEngine } from '../../test/sim/engineAdapter.js';
import { editGenerator, holdsSetup, PROFILES, seedFilesPlan2 } from '../../test/sim/generators.js';
import { DEFAULT_QUIESCENCE, holdTimersSettled, type EngineFactory, type Oracle, type SeedTuple, type SimOptions } from '../../test/sim/harness.js';
import { MarkerModel, markerRun } from '../../test/sim/markers.js';
import { exitOracles } from '../../test/sim/oracles.js';
import type { Profile } from './seedProtocol.js';

/** R-31 / R3-47: crash injection of the `faults` and `holds` profiles, per step. */
export const CRASH_RATE = 0.02;

export interface ProfileRun { tuple: SeedTuple; factory: EngineFactory; options: SimOptions; oracles: Oracle[]; markers: MarkerModel; }

/**
 * One seed of `profile`: `steps` defaults to PROFILES[profile].steps (edits 40, faults 40, holds 60), `peers` to 3; `mutants` switches
 * test-build mutants on (R-29, R3-50).
 */
export function profileRun(seed: string, profile: Profile, o: { steps?: number; peers?: number; mutants?: readonly MutantId[] } = {}): ProfileRun {
  const steps = o.steps ?? PROFILES[profile].steps;
  const peers = o.peers ?? 3;
  const mutants = new Set(o.mutants ?? []);
  if (profile === 'holds') {
    const h = holdsSetup(seed, { mutants, steps, peers, crashRate: CRASH_RATE });
    return { tuple: h.tuple, factory: h.factory, options: h.options, markers: h.markers, oracles: exitOracles(RELEASE_NAMESPACE, { holds: { markers: h.markers } }) };
  }
  const markers = new MarkerModel(markerRun(seed));
  return {
    tuple: { seed, peers, ops: steps },
    factory: realEngine({ mutants }),
    markers,
    oracles: exitOracles(RELEASE_NAMESPACE, { holds: { markers } }),
    options: {
      generator: editGenerator(PROFILES[profile], markers),
      quiescence: DEFAULT_QUIESCENCE,
      seedFiles: seedFilesPlan2(seededRandom(`${seed}/files`)),
      settled: holdTimersSettled,
      ...(profile === 'faults' ? { crash: { rate: CRASH_RATE } } : {}),
    },
  };
}
