// TC-TST-02, the M25 scenario (Plan 3 Task 14; 11-testing §3.9 M25, TC-TST-02; R3-21, R3-50). Fix round 1 split TC-TST-02 into one file
// per mutant so run-tests.mjs runs them in parallel (R3-55); the runner (tcTst02) and the shared helpers are in
// test/helpers/holdsOracleScript.ts. A scripted holds run (holdsSetup's composition with RealEngineOptions.mutants, crash rate 0) on real
// git against file:// bare remotes.
import { test } from 'node:test';
import { seededRandom } from '../../src/ports/random.js';
import { SIM_TIMEOUT, type Step } from '../helpers/holdsScript.js';
import { CI, indexOf, lf, TC_TST_02, tcTst02, type Scenario } from '../helpers/holdsOracleScript.js';
import { seedFilesPlan3 } from '../sim/generators.js';
import { peerIdOf } from '../sim/oraclesHolds.js';

/** M25: p0 edits the QUARANTINED ci.yml and shared.txt row 5 (a capture occasion): S_pub carries the quarantined edit. */
const M25: Scenario = {
  mutant: 'M25', expected: 'INV-MASK', seed: 'holds-mut-m25',
  seedFiles: { ...seedFilesPlan3(seededRandom('holds-mut-m25/files')), [CI]: lf(['name: ci', 'on: push']) },
  steps: (mark): Step[] => [
    { rounds: 1 },
    { probe: 'mark', run: async (ctx) => { mark(ctx); } },
    { kind: 'edit_own', peer: 0, params: { path: CI, row: 0, text: 'name: changed by p0' } },
    { kind: 'edit_band', peer: 0, params: { path: 'shared.txt', insert: false, row: 5, text: 'p0 row 5' } },
    { rounds: 12 },
  ],
  // p0's first mask event of the run: under M25 every S_pub computation leaves the QUARANTINED ci.yml out of the withheld set (clause
  // (ii)), from the first materialization on; its edited entry (clause (i)) is TC-DAT-04's (sim.mutants.holds.test.ts)
  predicted: (ctx) => indexOf(ctx, 0, (e) => e.kind === 'mask' && e.peer === peerIdOf(ctx, 0)) >= 0,
};

test(`${TC_TST_02} [M25 scenario]`, { timeout: 2 * SIM_TIMEOUT }, async (t) => {
  await tcTst02(t, M25);
});
