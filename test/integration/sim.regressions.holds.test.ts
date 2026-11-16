// TC-HLD-02's mask half with every Task 14 oracle on (Plan 3 Task 14; 05-holds HLD-21; 11-testing TC-HLD-02). A scripted holds run
// (holdsSetup's composition, crash rate 0) on real git against file:// bare remotes, the eight oracles of Task 14 judging every step.
// Fix round 1 (R3-55) split the file by scenario so run-tests.mjs runs them in parallel: the X-05 regressions are in
// sim.regressions.holds.x05f/.x05x3/.x05x8b.test.ts and 05 B1 in sim.regressions.holds.budget.test.ts; the X-05 rows with no Plan 3
// assertion are placed elsewhere (hold/exp_a Plan 4, hold/exp_more h Task 8 U3, hold/exp_more i Plan 6, resolve_local/exp_r_rebase
// Task 1, e14 Task 6, e4/e9 Tasks 6–7, ed/e3 Task 13 with Task 15's INV-NOLOSS).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIM_TIMEOUT, okOrFail, type Step, scriptRun, engineAt, has, live, liveFile } from '../helpers/holdsScript.js';
import { tick } from '../helpers/holdsOracleScript.js';
import { holdsOracles, peerIdOf } from '../sim/oraclesHolds.js';

const rowsOf = (b: Buffer): string[] => b.toString('latin1').split('\n').map((r) => r.replace(/\r$/, ''));

test('TC-HLD-02 mask half: with p0\'s revert PATCH holding shared.txt row 14, p0\'s edit of row 17 publishes within 2 loops after its human CS closes (20 s quiet) while row 14 stays at p1\'s line in live_code, heldRanges(\'shared.txt\') = [[14, 14]], and oracleMask passes every loop', { timeout: SIM_TIMEOUT }, async () => {
  let checked = false;
  let p1Row = '';
  const steps: Step[] = [
    { rounds: 1 },
    { kind: 'edit_band', peer: 1, params: { path: 'shared.txt', insert: false, row: 13, text: 'p1 line 14' } },
    { rounds: 12 },
    { kind: 'stale_save', peer: 0, params: { path: 'shared.txt', buffer: 'genesis', row: 60 } },   // row 14 back to genesis + an own last row
    { rounds: 12 },
    {
      probe: 'held', run: async (ctx) => {
        const ins = await engineAt(ctx, 0).inspect();
        assert.equal(live(ins.holds).filter((r) => has(r, 'revert') && r.paths.includes('shared.txt')).length, 1, 'p0\'s revert PATCH holds shared.txt');
        assert.deepEqual(ins.ranges['shared.txt'], [[14, 14]], 'heldRanges(shared.txt) = [[14, 14]]');
        p1Row = rowsOf((await liveFile(ctx, 'shared.txt'))!)[13]!;
        assert.ok(p1Row.startsWith('p1 line 14'));
      },
    },
    { kind: 'edit_band', peer: 0, params: { path: 'shared.txt', insert: false, row: 16, text: 'p0 row 17' } },
    {
      probe: 'row 17', run: async (ctx) => {
        const id0 = peerIdOf(ctx, 0);
        const from = ctx.trace.events.length;
        await tick(ctx, 0);   // observed: the human CS opens
        const observed = ctx.clocks.get('p0')!.monoMs();
        let at: number | null = null;
        for (let n = 0; n < 14 && at === null; n++) {
          await tick(ctx, 0);
          const pub = ctx.trace.since(from).find((e) => e.kind === 'push' && e.peer === id0 && e.outcome === 'landed' && e.purpose === 'publish');
          if (pub !== undefined && rowsOf((await liveFile(ctx, 'shared.txt'))!)[16]!.startsWith('p0 row 17')) at = ctx.clocks.get('p0')!.monoMs();
        }
        assert.ok(at !== null, 'row 17 published');
        assert.ok(at - observed <= 20_000 + 2 * 2_500, `within 2 loops after the CS closed (${at - observed} virtual ms)`);
        assert.equal(rowsOf((await liveFile(ctx, 'shared.txt'))!)[13], p1Row, 'row 14 stays at p1\'s line in live_code');
        assert.deepEqual((await engineAt(ctx, 0).inspect()).ranges['shared.txt'], [[14, 14]], 'still [[14, 14]]');
        checked = true;
      },
    },
    { rounds: 4 },
  ];
  okOrFail((await scriptRun('holds-tchld02', () => steps, { oracles: holdsOracles() })).r);
  assert.ok(checked);
});
