// O-READY against Plan 2's M20 with holdcat X1 (Plan 3 Task 14; 11-testing §3.4 O-READY, §3.9 M20, TC-HLD-01, X-05 holdcat/X1; HLD-41).
// A scripted holds run (holdsSetup's composition with RealEngineOptions.mutants, crash rate 0) on real git against file:// bare remotes.
// Fix round 1 (R3-55) split the file by scenario so run-tests.mjs runs them in parallel: TC-TST-02 is in sim.mutants.holds.m19/.m25/.m38/
// .m39.test.ts (one file per mutant) and TC-DAT-04's mask half in sim.mutants.holds.tcdat04.test.ts; the helpers are in
// test/helpers/holdsOracleScript.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seededRandom } from '../../src/ports/random.js';
import { SIM_TIMEOUT, okOrFail, type Step, liveFile } from '../helpers/holdsScript.js';
import { allButConverge, lf, scenarioRun, withLast } from '../helpers/holdsOracleScript.js';
import { seedFilesPlan3 } from '../sim/generators.js';
import type { SimContext } from '../sim/harness.js';
import { readBlob, treeEntries } from '../sim/holdsView.js';
import { peerIdOf } from '../sim/oraclesHolds.js';

test('O-READY with holdcat X1 (ready-pair rebase): p0\'s captured ready pair on f.txt (row 5) is rebased by p1\'s applied row-20 change (R[f.txt] = the apply\'s mDisk entry) and publishes both rows; with Plan 2\'s M20 on, oracleReady\'s after-apply clause fires at that apply (R ≠ mDisk) before any publish, whether or not the A_cap assert later stops the push', { timeout: 2 * SIM_TIMEOUT }, async (t) => {
  const seedFiles = { ...seedFilesPlan3(seededRandom('holds-ready-x1/files')), 'f.txt': lf(Array.from({ length: 40 }, (_, k) => `f row ${k + 1}`)) };
  let critical = -1;
  let checked = false;
  const steps = (probeAll: boolean): Step[] => [
    { rounds: 1 },
    { kind: 'edit_band', peer: 0, params: { path: 'f.txt', insert: false, row: 4, text: 'p0 row 5' } },
    { kind: 'edit_band', peer: 1, params: { path: 'f.txt', insert: false, row: 19, text: 'p1 row 20' } },
    { iterate: 0 },
    { iterate: 1 },
    // p1 alone until it published (p0's CS goes quiet meanwhile, uncaptured: p0 does not iterate)
    ...Array.from({ length: 10 }, (): Step[] => [{ advance: 2_500 }, { iterate: 1 }]).flat(),
    { probe: 'critical', run: async (ctx) => { critical = ctx.opLog[ctx.opLog.length - 1]!.step + 2; } },
    { advance: 2_500 },
    { iterate: 0 },   // fetch p1's row 20, capture p0's row 5 (step 4), apply (step 5: HLD-41), publish
    { rounds: 8 },
    ...(probeAll ? [{
      probe: 'both rows', run: async (ctx: SimContext) => {
        const id0 = peerIdOf(ctx, 0);
        const ap = ctx.trace.ofKind('apply').find((e) => e.peer === id0 && e.written.includes('f.txt'));
        assert.ok(ap !== undefined, 'p0 applied p1\'s row 20 over f.txt');
        const rows = (await liveFile(ctx, 'f.txt'))!.toString('latin1').split('\n');
        assert.ok(rows[4]!.startsWith('p0 row 5 CWM_') && rows[19]!.startsWith('p1 row 20 CWM_'), `live f.txt carries both rows: ${rows[4]} / ${rows[19]}`);
        const pubs = ctx.trace.ofKind('publish').filter((e) => e.peer === id0 && e.c !== null);
        assert.ok(pubs.length >= 1, 'p0 published');
        const c = pubs[0]!.c!;
        const f = (await treeEntries(ctx.git, ctx.peers[0]!.dir, c)).get('f.txt')!;
        const pubRows = (await readBlob(ctx.git, ctx.peers[0]!.dir, f.oid)).toString('latin1').split('\n');
        assert.ok(pubRows[4]!.startsWith('p0 row 5') && pubRows[19]!.startsWith('p1 row 20'), 'p0\'s first live commit carries both rows (the rebased R)');
        checked = true;
      },
    } as Step] : []),
  ];
  // Mutant off: O-READY and every other oracle pass, and the rebased pair publishes both rows.
  okOrFail(await scenarioRun('holds-ready-x1', () => steps(true), { oracles: allButConverge(), quiescence: false, seedFiles }));
  assert.ok(checked);
  // M20: the pair is not rebased at the apply; O-READY (last) fires at that very iteration.
  const r = await scenarioRun('holds-ready-x1', () => steps(false), { mutants: new Set(['M20']), oracles: withLast('O-READY', { name: 'NONE' }), quiescence: false, seedFiles });
  assert.equal(r.ok, false, 'M20 is killed');
  assert.equal(r.failure!.oracle, 'O-READY', JSON.stringify(r.failure));
  assert.equal(r.failure!.step, critical, `at the critical iteration (step ${critical})`);
  assert.match(r.failure!.message, /O-READY \(rebase\) p0 pair [^:]+: R\[f\.txt\]/);
  t.diagnostic(r.failure!.message.slice(0, 400));
});
