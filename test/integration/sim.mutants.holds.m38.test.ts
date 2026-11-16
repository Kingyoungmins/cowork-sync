// TC-TST-02, the M38 scenario (Plan 3 Task 14; 11-testing §3.9 M38, TC-TST-02, TC-ENG-06; R3-50). Fix round 1 split TC-TST-02 into one
// file per mutant so run-tests.mjs runs them in parallel (R3-55); the runner (tcTst02) and the shared helpers are in
// test/helpers/holdsOracleScript.ts. A scripted holds run (holdsSetup's composition with RealEngineOptions.mutants, crash rate 0) on real
// git against file:// bare remotes.
import { test } from 'node:test';
import { SIM_TIMEOUT, type Step } from '../helpers/holdsScript.js';
import { G3, indexOf, TC_TST_02, tcTst02, type Scenario } from '../helpers/holdsOracleScript.js';
import { peerIdOf } from '../sim/oraclesHolds.js';

/** M38: p1's one CS over g/a.txt, g/b.txt, g/c.txt while p0 holds a share-read lock on g/b.txt: p0 writes g/a.txt and g/c.txt. */
const M38: Scenario = {
  mutant: 'M38', expected: 'INV-GROUP', seed: 'holds-mut-m38',
  steps: (mark): Step[] => [
    { rounds: 1 },
    // the three files arrive as three single-path CSs, so p0's first multi-path closure is p1's later CS over all three
    ...G3.flatMap((path): Step[] => [{ kind: 'new_file', peer: 1, params: { path, rows: 4 } }, { rounds: 12 }]),
    { kind: 'lock_share_read', peer: 0, params: { path: 'g/b.txt' } },
    { probe: 'mark', run: async (ctx) => { mark(ctx); } },
    ...G3.map((path): Step => ({ kind: 'edit_own', peer: 1, params: { path, row: 1, text: `p1 changed ${path}` } })),
    { rounds: 14 },
    ...Array.from({ length: 24 }, (): Step => ({ rounds: 1 })),
    { kind: 'unlock', peer: 0 },
    { rounds: 8 },
  ],
  // p0's first apply event after p1's edits that names a g/ path
  predicted: (ctx, from) => from >= 0 && indexOf(ctx, from, (e) => e.kind === 'apply' && e.peer === peerIdOf(ctx, 0) && e.groups.some((g) => g.paths.some((p) => G3.includes(p)))) >= 0,
};

test(`${TC_TST_02} [M38 scenario]`, { timeout: 2 * SIM_TIMEOUT }, async (t) => {
  await tcTst02(t, M38);
});
