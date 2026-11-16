// TC-DAT-04's mask half with M25 (Plan 3 Task 14; 11-testing §3.9 M25, TC-DAT-04; R3-21). A scripted holds run (holdsSetup's
// composition with RealEngineOptions.mutants, crash rate 0) on real git against file:// bare remotes. Fix round 1 (R3-55) moved it out of
// sim.mutants.holds.test.ts into its own file so run-tests.mjs runs it in parallel; the helpers are in test/helpers/holdsOracleScript.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seededRandom } from '../../src/ports/random.js';
import { SIM_TIMEOUT, okOrFail, type Step, engineAt, has, liveFile, liveTree } from '../helpers/holdsScript.js';
import { allButConverge, CI, indexOf, lf, recorder, scenarioRun } from '../helpers/holdsOracleScript.js';
import { hangul304, seedFilesPlan3 } from '../sim/generators.js';
import type { Oracle, SimContext } from '../sim/harness.js';
import { treeEntries } from '../sim/holdsView.js';
import { oracleMask, peerIdOf } from '../sim/oraclesHolds.js';

test('TC-DAT-04 mask half: seedFiles plus .github/workflows/ci.yml, .cowork/config.json {"sync":{"exclude":["cfg/skip.txt"]}} and cfg/skip.txt; p0 edits .gitignore, ci.yml and cfg/skip.txt, creates .env and a stageable host-table non-portable file (con.py, or HANGUL304 on Windows; LOCAL_ONLY by its local_only record), plus a shared.txt edit; none of the five reaches any live code commit, S_pub and every P keep them at A, oracleMask passes every loop; with M25 on, oracleMask fails at p0\'s first materialization after the ci.yml edit', { timeout: 2 * SIM_TIMEOUT }, async () => {
  const seedFiles = {
    ...seedFilesPlan3(seededRandom('holds-tcdat04/files')), [CI]: lf(['name: ci', 'on: push']),
    '.cowork/config.json': Buffer.from('{"sync":{"exclude":["cfg/skip.txt"]}}\n', 'utf8'), 'cfg/skip.txt': lf(['skip 1', 'skip 2']),
  };
  const np = process.platform === 'win32' ? hangul304(1) : 'con.py';
  const FIVE = ['.gitignore', CI, 'cfg/skip.txt', '.env', np];
  let checked = false;
  let from = -1;
  const steps = (probe: boolean): Step[] => [
    { rounds: 1 },
    { kind: 'edit_own', peer: 0, params: { path: '.gitignore', row: 0, text: '*.tmp' } },
    { probe: 'mark', run: async (ctx) => { from = ctx.trace.events.length; } },
    { kind: 'edit_own', peer: 0, params: { path: CI, row: 0, text: 'name: changed by p0' } },
    { kind: 'edit_own', peer: 0, params: { path: 'cfg/skip.txt', row: 0, text: 'skip changed' } },
    { kind: 'new_file', peer: 0, params: { path: '.env', rows: 2 } },
    { kind: 'nonportable_name', peer: 0, params: { name: np } },
    { kind: 'edit_band', peer: 0, params: { path: 'shared.txt', insert: false, row: 5, text: 'p0 row 5' } },
    ...Array.from({ length: 16 }, (): Step => ({ rounds: 1 })),
    ...(probe ? [{
      probe: 'five', run: async (ctx: SimContext) => {
        const p0 = engineAt(ctx, 0);
        const ins = await p0.inspect();
        assert.ok(ins.holds.some((r) => r.paths.includes(np) && r.local_only && has(r, 'portability')), `${np} is held by its local_only portability record`);
        const A = await treeEntries(ctx.git, ctx.peers[0]!.dir, ins.aTree);
        for (const p of FIVE) assert.equal(ins.sPub?.get(p)?.oid, A.get(p)?.oid, `S_pub keeps ${p} at A`);
        // no live code commit carries any of the five: every commit of the live chain keeps the genesis blob (or no entry)
        const remote = ctx.remote.dir;
        const tip = (await liveTree(ctx)).commit;
        const chain = (await ctx.git.run(['rev-list', '--first-parent', tip], { class: 'local', cwd: remote })).stdout.toString('utf8').trim().split('\n');
        const genesis = await treeEntries(ctx.git, remote, chain[chain.length - 1]!);
        for (const c of chain) {
          const tr = await treeEntries(ctx.git, remote, c);
          for (const p of FIVE) assert.equal(tr.get(p)?.oid, genesis.get(p)?.oid, `live commit ${c} keeps ${p} as genesis has it`);
        }
        // DAT-32: the shared.txt edit is in the human CS of the non-portable file, so it publishes only with it (the CS is pinned whole)
        const pinned = ins.holds.some((r) => r.kind === 'PIN' && r.residence === 'ON_DISK' && r.guards.some((g) => g.name.startsWith('dependency:')) && r.paths.includes('shared.txt'));
        const published = (await liveFile(ctx, 'shared.txt'))!.toString('latin1').includes('p0 row 5');
        assert.ok(pinned || published, 'the shared.txt edit is held by its CS\'s dependency PIN or published');
        checked = true;
      },
    } as Step] : []),
  ];
  okOrFail(await scenarioRun('holds-tcdat04', () => steps(true), { oracles: allButConverge(), quiescence: false, seedFiles }));
  assert.ok(checked);
  // M25: a recording oracleMask (it never ends the run) collects every verdict; the recorder notes p0's first mask event after the ci.yml
  // edit. Clause (ii) fires from p0's first materialization on (the mutant leaves the QUARANTINED ci.yml out of the withheld set); the
  // S_pub entry of the edited ci.yml (clause (i)) first differs at p0's first materialization after the edit.
  const rec = recorder((ctx) => from >= 0 && indexOf(ctx, from, (e) => e.kind === 'mask' && e.peer === peerIdOf(ctx, 0)) >= 0);
  const verdicts: Array<{ step: number; message: string }> = [];
  const inner = oracleMask();
  const recording: Oracle = {
    name: 'INV-MASK (recording)',
    async afterEveryOp(ctx) {
      const m = await inner.afterEveryOp!(ctx);
      if (m !== null) verdicts.push({ step: ctx.opLog[ctx.opLog.length - 1]!.step, message: m });
      return null;
    },
  };
  const r = await scenarioRun('holds-tcdat04', () => { from = -1; return steps(false); }, { mutants: new Set(['M25']), oracles: [rec, recording], quiescence: false, seedFiles });
  okOrFail(r);
  assert.ok(rec.step !== null, 'p0 materialized after the ci.yml edit');
  assert.ok(verdicts.length > 0 && verdicts[0]!.message.includes(`INV-MASK (ii) p0 withheld`), `M25 fails oracleMask: ${JSON.stringify(verdicts[0])}`);
  const entry = verdicts.find((v) => v.message.includes(`INV-MASK (i) p0 ${CI}:`));
  assert.ok(entry !== undefined, 'the edited ci.yml differs in S_pub');
  assert.equal(entry.step, rec.step, `the S_pub entry of ci.yml first differs at p0's first materialization after the ci.yml edit (step ${rec.step})`);
});
