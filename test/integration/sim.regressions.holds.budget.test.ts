// 05 B1 (INV-HLD-BUDGET) SIM form with every Task 14 oracle on (Plan 3 Task 14; 05-holds §7 B1, HLD-32, HLD-54, INV-HLD-BUDGET). A
// scripted holds run (holdsSetup's composition, crash rate 0) on real git against file:// bare remotes, the eight oracles of Task 14
// judging every step. Fix round 1 (R3-55, controller ruling on finding 6): B1 has its own file so run-tests.mjs runs it in parallel, and
// its 30-virtual-minute leg (720 rounds) runs whole only under `npm run test:sim` (TEST_SIM_FULL=1); `npm test` runs the same script
// with a 5-virtual-minute leg (120 rounds).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REFS, SIM_TIMEOUT, okOrFail, type Step, scriptRun, engineAt, has, holdsOf, live, disk } from '../helpers/holdsScript.js';
import { FULL, STAGEABLE_NP, tick } from '../helpers/holdsOracleScript.js';
import type { Oid } from '../../src/git/oid.js';
import type { SimContext } from '../sim/harness.js';
import { boardHolds } from '../sim/holdsView.js';
import { holdsOracles, peerIdOf } from '../sim/oraclesHolds.js';

/** The quiet leg: 30 virtual minutes (720 rounds of 2.5 s) under TEST_SIM_FULL, 5 virtual minutes (120 rounds) under `npm test`. */
const QUIET_ROUNDS = FULL ? 720 : 120;

test('INV-HLD-BUDGET (05 B1 SIM form): p0\'s new_file of a stageable host-table non-portable name (con.py on Linux and macOS, HANGUL304 on Windows; alone in its CS) gives one permanent portability record whose stub op lands in one push; over the next 30 virtual minutes (720 rounds) p0 makes 0 push attempts, and when p1 publishes a notes.txt edit while p0 holds a share-read lock on notes.txt for 40 virtual s, p0 defers it, applies it after unlock and emits no \'hold\' event and no board op', { timeout: 3 * SIM_TIMEOUT }, async (t) => {
  t.diagnostic(`quiet leg: ${QUIET_ROUNDS} rounds (${(QUIET_ROUNDS * 2.5) / 60} virtual minutes)${FULL ? '' : '; the 720-round leg runs under TEST_SIM_FULL=1'}`);
  let checked = false;
  let rid = '';
  let pushes = 0;
  let mark = 0;
  const pushesOf = (ctx: SimContext): number => ctx.engines[0]!.pushAttempts!();
  const steps: Step[] = [
    { rounds: 1 },
    { kind: 'new_file', peer: 0, params: { path: STAGEABLE_NP, rows: 3 } },
    { rounds: 14 },
    {
      probe: 'record', run: async (ctx) => {
        const recs = live(await holdsOf(ctx, 0));
        assert.equal(recs.length, 1, `one record (${JSON.stringify(recs.map((r) => [r.kind, r.guards.map((g) => g.name), r.paths]))})`);
        assert.ok(has(recs[0]!, 'portability') && recs[0]!.local_only, 'a local_only portability record');
        rid = recs[0]!.id;
        const id0 = peerIdOf(ctx, 0);
        const carrying = ctx.trace.events.map((e, k) => [e, k] as const).filter(([e]) => e.kind === 'mirror' && e.peer === id0 && e.holds.some((h) => h.id === rid));
        const landed = carrying.filter(([e, k]) => ctx.trace.events.some((x, j) => j > k && x.kind === 'push' && x.peer === id0 && x.bnew === (e as { bnew: string }).bnew && x.outcome === 'landed'));
        assert.equal(landed.length, 1, 'its stub op lands in one push');
        const board = (await ctx.git.run(['rev-parse', `${REFS.remoteBoard}^{commit}`], { class: 'local', cwd: ctx.remote.dir })).stdout.toString('utf8').trim();
        const { holds, held } = await boardHolds(ctx.git, ctx.peers[0]!.dir, board as Oid);   // p0 pushed it: its repo holds every object
        assert.ok(holds[rid]?.local_only === true && (held.get(rid) ?? []).length === 0, 'a stub: local_only, no held/');
        pushes = pushesOf(ctx);
      },
    },
    ...Array.from({ length: QUIET_ROUNDS }, (): Step => ({ rounds: 1 })),
    {
      probe: 'quiet leg', run: async (ctx) => {
        assert.equal(pushesOf(ctx) - pushes, 0, `p0 made 0 push attempts over ${QUIET_ROUNDS} rounds`);
        assert.ok(live(await holdsOf(ctx, 0)).some((r) => r.id === rid), 'the record is permanent');
        mark = ctx.trace.events.length;
      },
    },
    { kind: 'lock_share_read', peer: 0, params: { path: 'notes.txt' } },
    { kind: 'edit_band', peer: 1, params: { path: 'notes.txt', insert: false, row: 4, text: 'p1 note 4' } },
    {
      probe: '40 s', run: async (ctx) => {
        const locked = ctx.clocks.get('p0')!.monoMs();
        while (ctx.clocks.get('p0')!.monoMs() - locked < 40_000) for (const i of [0, 1, 2]) await tick(ctx, i, i === 0 ? 2_500 : 0);
        assert.equal((await engineAt(ctx, 0).inspect()).pending['notes.txt'], 'locked', 'p0 defers notes.txt');
      },
    },
    { kind: 'unlock', peer: 0 },
    { rounds: 6 },
    {
      probe: 'quiet', run: async (ctx) => {
        const id0 = peerIdOf(ctx, 0);
        assert.ok((await disk(ctx, 0, 'notes.txt'))!.toString('latin1').includes('p1 note 4'), 'applied after unlock');
        const since = ctx.trace.since(mark);
        assert.ok(!since.some((e) => e.kind === 'hold' && e.peer === id0), 'no \'hold\' event');
        assert.equal(pushesOf(ctx) - pushes, 0, 'no board op (no push attempt)');
        checked = true;
      },
    },
  ];
  okOrFail((await scriptRun('holds-budget', () => steps, { oracles: holdsOracles() })).r);
  assert.ok(checked);
});
