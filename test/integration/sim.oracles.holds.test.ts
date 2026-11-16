// Task 14's oracles on whole SIM runs (Plan 3 Task 14; 11-testing §3.4 rows INV-MASK, INV-GROUP, O-READY, O-AND, O-OFFDISK,
// O-LIVE-RECORD, O-ATOMIC-PUB, INV-NOSILENT; TST-07; rulings R3-49, R3-55). Every run is real git against file:// bare remotes. Fix round
// 1 (R3-55) split the file by area so run-tests.mjs runs the parts in parallel: the plants and scenarios are in sim.oracles.holds.mask,
// .group, .receive, .rows, .offdisk and .nosilent.test.ts; the helpers are in test/helpers/holdsOracleScript.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seededRandom } from '../../src/ports/random.js';
import { SIM_TIMEOUT, okOrFail } from '../helpers/holdsScript.js';
import { FULL } from '../helpers/holdsOracleScript.js';
import { editGenerator, holdsSetup, PROFILES, seedFilesPlan2 } from '../sim/generators.js';
import { DEFAULT_QUIESCENCE, runSim, type SimResult } from '../sim/harness.js';
import { realEngine } from '../sim/engineAdapter.js';
import { exitOracles } from '../sim/oracles.js';
import { holdsOracles } from '../sim/oraclesHolds.js';

/** One seed with Plan 2's six exit oracles followed by the eight oracles of this task. */
async function seedRun(seed: string): Promise<SimResult> {
  const oracles = [...exitOracles(), ...holdsOracles()];
  if (seed.startsWith('holds-')) {
    const s = holdsSetup(seed);
    return runSim(s.tuple, s.factory, oracles, s.options);
  }
  const profile = seed.startsWith('faults-') ? 'faults' : 'edits';
  return runSim({ seed, peers: 3, ops: PROFILES[profile].steps }, realEngine(), oracles, {
    generator: editGenerator(PROFILES[profile]),
    quiescence: DEFAULT_QUIESCENCE,
    seedFiles: seedFilesPlan2(seededRandom(`${seed}/files`)),
    ...(profile === 'faults' ? { crash: { rate: 0.02 } } : {}),
  });
}

const SEEDS = ['holds-o-0', 'holds-o-1', 'holds-o-2', 'edits-o-0', 'faults-o-0'];

test('every oracle of this task passes after every op on holds seeds holds-o-0, holds-o-1, holds-o-2 and on edits seed edits-o-0 and faults seed faults-o-0 (each run with Plan 2\'s six exit oracles followed by the eight oracles of this task)', { timeout: (FULL ? 5 : 1) * SIM_TIMEOUT }, async (t) => {
  for (const seed of FULL ? SEEDS : SEEDS.slice(0, 1)) {
    const started = performance.now();
    const r = await seedRun(seed);
    t.diagnostic(`${seed}: ${r.ok ? 'ok' : 'FAILED'} in ${Math.round(performance.now() - started)} ms (${r.opLog.length} op-log entries)`);
    okOrFail(r);
    assert.ok(r.quiescence?.reached, `${seed}: T* reached`);
  }
});
