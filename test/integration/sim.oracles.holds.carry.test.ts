// oracleGroup's carry of still-deferred closures across applies (EF4 T-3, ruling R3-EF4-4 oracle half; the Task 6 ruling's closure
// range: (LA_C, TIP] plus the commits that changed a still-deferred path since the commit that gave it its A blob; HLD-37, HLD-53,
// INV-HLD-RECEIVE; class group-iii-one-write-group, E16-A). Real git against file:// bare remotes (holdsSetup's composition); the plants
// are synthetic trace events naming crafted commits in p0's repo, judged by a fresh oracleGroup on a fork of the run's trace
// (sim.oracles.holds.group.test.ts's method).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeCsPaths } from '../../src/board/boardCommit.js';
import type { TraceEvent } from '../../src/ports/trace.js';
import { SIM_TIMEOUT, okOrFail, type Step, scriptRun, engineAt } from '../helpers/holdsScript.js';
import { fresh, g3Steps, untilPlanting } from '../helpers/holdsOracleScript.js';
import type { SimContext } from '../sim/harness.js';
import { treeEntries } from '../sim/holdsView.js';
import { emitAs, forkTrace, oracleGroup, peerIdOf, plantBlob, plantCommit, plantTree } from '../sim/oraclesHolds.js';

type ApplyEvent = Extract<TraceEvent, { kind: 'apply' }>;
type MergeEvent = Extract<TraceEvent, { kind: 'merge' }>;
type StateEvent = Extract<TraceEvent, { kind: 'state' }>;

const last = <K extends TraceEvent['kind']>(ctx: SimContext, kind: K, peer: string): Extract<TraceEvent, { kind: K }> => {
  const e = ctx.trace.ofKind(kind).filter((x) => (x as { peer: string }).peer === peer).pop();
  assert.ok(e !== undefined, `p0 has a ${kind} event`);
  return e;
};

/** One closed human change-set's trailers (HLD-37: Cowork-CS and its Cowork-CS-Paths list). */
const csTrailers = (csId: string, paths: readonly string[]): Array<{ key: string; value: string }> => [
  { key: 'Cowork-CS', value: `${csId} state=closed seq=1 origin=human checks=skipped paths=${paths.length}` },
  { key: 'Cowork-CS-Paths', value: `${csId} ${encodeCsPaths(paths)}` },
];

test('oracleGroup carries an earlier range\'s change-set to the next apply only when its commit changed a still-deferred path (ruling R3-EF4-4): a CS that declared the deferred X without changing it (the receiver\'s own publish, which changed only Y) does not link X with a later incoming change of Y — groups [[X],[Y]] pass and [[X,Y]] fail (iii)', { timeout: SIM_TIMEOUT }, async (t) => {
  const run = untilPlanting();
  const verdicts: Record<string, string | null> = {};
  const X = 'g/a.txt';
  const Y = 'g/b.txt';
  const steps: Step[] = [
    ...g3Steps(),
    {
      probe: 'plants', run: async (ctx) => {
        const id0 = peerIdOf(ctx, 0);
        const realApply = last(ctx, 'apply', id0) as ApplyEvent;
        const realMerge = last(ctx, 'merge', id0) as MergeEvent;
        const realState = last(ctx, 'state', id0) as StateEvent;
        verdicts['the run as it is'] = await fresh(oracleGroup, ctx);
        run.plant();
        const now = ctx.clocks.get('p0')!.monoMs();
        const ins = await engineAt(ctx, 0).inspect();
        const dir = ctx.peers[0]!.dir;
        const A0 = await treeEntries(ctx.git, dir, ins.aTree);
        assert.ok(A0.has(X) && A0.has(Y), 'p0 has X and Y in A');
        const L0 = realApply.tip;
        const tree0 = (await ctx.git.run(['rev-parse', `${L0}^{tree}`], { class: 'local', cwd: dir })).stdout.toString('utf8').trim();
        const blob = (s: string): ReturnType<typeof plantBlob> => plantBlob(ctx, 0, Buffer.from(s, 'utf8'));
        const [x1, yJ, yK] = await Promise.all([blob('x teammate change\n'), blob('y own publish\n'), blob('y teammate change\n')]);
        const hex = 'c'.repeat(32);
        // (L0, TIP1]: CX changes X (a teammate's CS); J — the receiver's own publish, its A already holds it — changes only Y but declares
        // {X, Y} (as a start/join capture CS declares R ∪ A). TIP2 = K: a teammate's CS changing Y.
        const cx = await plantCommit(ctx, 0, await plantTree(ctx, 0, tree0, { [X]: x1 }), [L0 as never], 'cx', csTrailers(`${hex}/human/1`, [X]));
        const j = await plantCommit(ctx, 0, await plantTree(ctx, 0, tree0, { [X]: x1, [Y]: yJ }), [cx], 'j', csTrailers(`${hex}/human/2`, [X, Y]));
        const k = await plantCommit(ctx, 0, await plantTree(ctx, 0, tree0, { [X]: x1, [Y]: yK }), [j], 'k', csTrailers(`${hex}/human/3`, [Y]));
        const aBefore = await plantTree(ctx, 0, ins.aTree, { [Y]: yJ });   // A_before of both applies: J's Y (own publish), X at A0
        const aAfter2 = await plantTree(ctx, 0, ins.aTree, { [Y]: yK });   // the second apply wrote Y only
        const merge = (laC: string, tip: string): MergeEvent => ({ ...realMerge, use: 'apply', laC, tip, aTree: aBefore, ours: aBefore });
        const deferX = { paths: [X], outcome: 'deferred' as const, reason: 'locked' };
        /** Apply 1 at TIP1 = J (LA_C L0): X deferred (locked), Y already at TIP in A. Then apply 2 at K with LA_C = J. */
        const plant = (p: SimContext, second: { groups: ApplyEvent['groups']; written: string[] }): void => {
          emitAs(p, 0, merge(L0, j), now);
          emitAs(p, 0, { ...realApply, tip: j, written: [], deferred: [X], groups: [deferX], notApplicable: [], mDisk: null }, now);
          emitAs(p, 0, merge(j, k), now + 100_000);
          if (second.written.length > 0) emitAs(p, 0, { ...realState, prev: realState.next, laC: k, laB: realState.laB, base: aAfter2 }, now + 100_000);
          emitAs(p, 0, { ...realApply, tip: k, written: second.written, deferred: second.written.includes(Y) ? [X] : [X, Y], groups: second.groups, notApplicable: [], mDisk: null }, now + 100_000);
          emitAs(p, 0, realState, now + 100_000);   // the peer's latest state transition is still the real one (inspect().aTree)
        };
        let p = forkTrace(ctx);
        plant(p, { groups: [deferX, { paths: [Y], outcome: 'written', reason: null }], written: [Y] });
        verdicts['[[X],[Y]]: Y written, X deferred'] = await fresh(oracleGroup, p);
        p = forkTrace(ctx);
        plant(p, { groups: [{ paths: [X, Y], outcome: 'deferred', reason: 'locked' }], written: [] });
        verdicts['[[X,Y]]: Y held behind X\'s deferral'] = await fresh(oracleGroup, p);
      },
    },
  ];
  okOrFail((await scriptRun('holds-plant-group-carry', () => steps, { oracles: run.oracles })).r);
  t.diagnostic(JSON.stringify(verdicts, null, 1));
  assert.equal(verdicts['the run as it is'], null, 'a fresh oracleGroup passes on the run as it is');
  assert.equal(verdicts['[[X],[Y]]: Y written, X deferred'], null, 'J changed no still-deferred path: it is not carried, so X and Y are separate closures (HLD-53, INV-HLD-RECEIVE)');
  const v = verdicts['[[X,Y]]: Y held behind X\'s deferral'];
  assert.ok(v !== undefined && v !== null && v.includes('INV-GROUP (iii) p0 apply ') && v.includes('!= closures [["g/a.txt"],["g/b.txt"]]'), `one write group over two closures fails (iii): ${v}`);
});
