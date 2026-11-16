// X-05 hold/exp_f and hold/exp_k_stash with every Task 14 oracle on (Plan 3 Task 14; 05-holds HLD-13, HLD-21; 11-testing X-05). A
// scripted holds run (holdsSetup's composition, crash rate 0) on real git against file:// bare remotes, the eight oracles of Task 14
// judging every step. Fix round 1 (R3-55) gave each X-05 scenario its own file (this one, .x05x3 and .x05x8b) so run-tests.mjs runs them
// in parallel; the helpers are in test/helpers/holdsOracleScript.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIM_TIMEOUT, okOrFail, type Step, scriptRun, engineAt, has, live, liveFile, disk } from '../helpers/holdsScript.js';
import { tick, X05 } from '../helpers/holdsOracleScript.js';
import { testRunner } from '../helpers/tmp.js';
import type { SimContext } from '../sim/harness.js';
import { readBlob, treeEntries } from '../sim/holdsView.js';
import type { MarkerModel } from '../sim/markers.js';
import { holdsOracles, peerIdOf, testMask } from '../sim/oraclesHolds.js';

/** The user's own git (never ctx.git, whose calls INV-OID judges as the engines'). */
const userGit = testRunner();
async function userRun(ctx: SimContext, i: number, args: string[]): Promise<string> {
  const r = await userGit.run(args, { class: 'local', cwd: ctx.peers[i]!.dir, identity: { name: 'Sim User', email: 'user@cowork.invalid' } });
  assert.equal(r.code, 0, `git ${args.join(' ')}: ${r.stderr.toString('utf8')}`);
  return r.stdout.toString('utf8');
}

const rowsOf = (b: Buffer): string[] => b.toString('latin1').split('\n').map((r) => r.replace(/\r$/, ''));

test(`${X05} [hold/exp_f and hold/exp_k_stash]`, { timeout: SIM_TIMEOUT }, async () => {
  let rid = '';
  let rev = 0;
  let checked = false;
  const steps = (markers: MarkerModel): Step[] => [
    { rounds: 1 },
    { kind: 'edit_band', peer: 1, params: { path: 'shared.txt', insert: true, row: 30, n: 1, text: 'p1-line' } },
    { rounds: 12 },
    { kind: 'stale_save', peer: 0, params: { path: 'shared.txt', buffer: 'genesis', row: 60 } },   // the revert of p1's row + an own row at the end
    { rounds: 12 },
    { kind: 'edit_band', peer: 1, params: { path: 'shared.txt', insert: true, row: 10, n: 5, text: 'p1-five' } },   // 5 rows above the held one
    { rounds: 12 },
    { kind: 'new_file', peer: 0, params: { path: 'own/p0-later.txt', rows: 3 } },   // a later materialization of p0 (A has the 5 rows)
    { rounds: 12 },
    {
      probe: 'exp_f', run: async (ctx) => {
        const p0 = engineAt(ctx, 0);
        const ins = await p0.inspect();
        const r = live(ins.holds).filter((x) => has(x, 'revert') && x.paths.includes('shared.txt'));
        assert.equal(r.length, 1, 'the revert record survives p1\'s insertion');
        assert.equal(r[0]!.state, 'ACTIVE');
        rid = r[0]!.id;
        rev = r[0]!.rev;
        const A = await treeEntries(ctx.git, ctx.peers[0]!.dir, ins.aTree);
        const sPubRows = rowsOf(await readBlob(ctx.git, ctx.peers[0]!.dir, ins.sPub!.get('shared.txt')!.oid));
        const live1 = rowsOf((await liveFile(ctx, 'shared.txt'))!);
        const at = live1.findIndex((x) => x.startsWith('p1-line'));
        assert.ok(at > 14 && sPubRows[at]!.startsWith('p1-line'), `S_pub keeps p1's held-against row at its shifted position (${at})`);
        assert.ok(!rowsOf((await disk(ctx, 0, 'shared.txt'))!).some((x) => x.startsWith('p1-line')), 'p0\'s disk still lacks it (the held change)');
        // sPub equals testMask of the last mask event (oracleMask checks it at every step; once more here, explicitly)
        const id0 = peerIdOf(ctx, 0);
        const me = ctx.trace.ofKind('mask').filter((e) => e.peer === id0).pop()!;
        const sDisk = await treeEntries(ctx.git, ctx.peers[0]!.dir, me.sDisk);
        const want = await testMask(testRunner(), `${ctx.root}/x05`, ctx.peers[0]!.dir, sDisk, A, ins.holds, () => 'LIVE', (p) => p === 'bin.dat');
        assert.equal(ins.sPub!.get('shared.txt')!.oid, want.entries.get('shared.txt')?.oid, 'S_pub[shared.txt] equals testMask');
      },
    },
    // hold/exp_k_stash
    { probe: 'stash', run: async (ctx) => { await userRun(ctx, 0, ['stash', 'push', '--include-untracked']); } },
    {
      probe: 'frozen', run: async (ctx) => {
        const id0 = peerIdOf(ctx, 0);
        const from = ctx.trace.events.length;
        await tick(ctx, 0);
        assert.ok((await engineAt(ctx, 0).inspect()).freeze.includes('EPOCH'), 'FREEZE(EPOCH) within one iteration');
        for (let n = 0; n < 6; n++) await tick(ctx, 0);
        const since = ctx.trace.since(from);
        assert.ok(!since.some((e) => e.kind === 'hold' && e.peer === id0), 'no record transition while frozen');
        // board-only pushes continue under FREEZE (PRO-45: the freeze event, hold ops); no code publish does
        assert.ok(!since.some((e) => e.kind === 'publish' && e.peer === id0 && e.c !== null), 'no publish while frozen');
        await userRun(ctx, 0, ['stash', 'pop']);
        await tick(ctx, 0);
        const ins = await engineAt(ctx, 0).inspect();
        assert.ok(!ins.freeze.includes('EPOCH'), 'stash pop returns E1');
        const r = ins.holds.find((x) => x.id === rid);
        assert.ok(r !== undefined && r.rev === rev && r.state === 'ACTIVE' && r.residence === 'ON_DISK', `the record keeps its id and rev (${JSON.stringify(r && [r.rev, r.state, r.residence])})`);
        checked = true;
        void markers;
      },
    },
    { rounds: 4 },
  ];
  okOrFail((await scriptRun('holds-x05-f-stash', steps, { oracles: holdsOracles() })).r);
  assert.ok(checked);
});
