// TC-TST-02, the M39 scenario (Plan 3 Task 14; 11-testing §3.9 M39, TC-TST-02; glossary §20 (≤ 1 apply per 10 s per worktree); R3-50).
// Fix round 1 split TC-TST-02 into one file per mutant so run-tests.mjs runs them in parallel (R3-55); the runner (tcTst02) and the
// shared helpers are in test/helpers/holdsOracleScript.ts. A scripted holds run (holdsSetup's composition with RealEngineOptions.mutants,
// crash rate 0) on real git against file:// bare remotes.
import { test } from 'node:test';
import { SIM_TIMEOUT, type Step } from '../helpers/holdsScript.js';
import { indexOf, TC_TST_02, tcTst02, type Scenario } from '../helpers/holdsOracleScript.js';
import { peerIdOf } from '../sim/oraclesHolds.js';

/** M39: three `plain` non-conforming commits on g/a.txt, g/b.txt, g/c.txt land one round apart: p0 writes two of them < 10 s apart. */
const M39: Scenario = {
  mutant: 'M39', expected: 'INV-GROUP', seed: 'holds-mut-m39',
  steps: (mark): Step[] => [
    { rounds: 1 },
    { probe: 'mark', run: async (ctx) => { mark(ctx); } },
    { kind: 'nonconforming_push', peer: 0, params: { variant: 'plain', paths: ['g/a.txt'] } },
    { rounds: 1 },
    { kind: 'nonconforming_push', peer: 0, params: { variant: 'plain', paths: ['g/b.txt'] } },
    { rounds: 1 },
    { kind: 'nonconforming_push', peer: 0, params: { variant: 'plain', paths: ['g/c.txt'] } },
    { rounds: 1 },
    { rounds: 8 },
  ],
  // p0's second written apply after the mark
  predicted: (ctx, from) => {
    if (from < 0) return false;
    const id0 = peerIdOf(ctx, 0);
    const first = indexOf(ctx, from, (e) => e.kind === 'apply' && e.peer === id0 && e.written.length > 0);
    return first >= 0 && indexOf(ctx, first + 1, (e) => e.kind === 'apply' && e.peer === id0 && e.written.length > 0) >= 0;
  },
};

test(`${TC_TST_02} [M39 scenario]`, { timeout: 2 * SIM_TIMEOUT }, async (t) => {
  await tcTst02(t, M39);
});
