// X-05 atom/x8b with every Task 14 oracle on (Plan 3 Task 14; 11-testing X-05; glossary §20 (≤ 1 apply per 10 s per worktree)). A
// scripted holds run (holdsSetup's composition, crash rate 0) on real git against file:// bare remotes, the eight oracles of Task 14
// judging every step. Fix round 1 (R3-55) gave each X-05 scenario its own file (.x05f, .x05x3 and this one) so run-tests.mjs runs them in
// parallel; the helpers are in test/helpers/holdsOracleScript.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIM_TIMEOUT, okOrFail, type Step, scriptRun } from '../helpers/holdsScript.js';
import { X05 } from '../helpers/holdsOracleScript.js';
import { holdsOp } from '../sim/generators.js';
import { advanceClocks } from '../sim/harness.js';
import type { MarkerModel } from '../sim/markers.js';
import { APPLY_GAP_MS, holdsOracles, peerIdOf } from '../sim/oraclesHolds.js';

test(`${X05} [atom/x8b]`, { timeout: SIM_TIMEOUT }, async () => {
  let checked = false;
  let lastCommitMono = 0;
  const PATHS = Array.from({ length: 6 }, (_, k) => `x8/f${k + 1}.txt`);
  const steps = (markers: MarkerModel): Step[] => [
    { rounds: 1 },
    {
      probe: 'six commits', run: async (ctx) => {
        // inside one probe, so no harness step time falls between them: commit k, 1.5 s, one p0 iteration
        for (const path of PATHS) {
          await holdsOp({ kind: 'nonconforming_push', peer: 0, params: { variant: 'plain', paths: [path] } }, markers).run(ctx);
          lastCommitMono = ctx.clocks.get('p0')!.monoMs();
          advanceClocks(ctx, 1_500);
          await ctx.engines[0]!.step(ctx);
          await ctx.scheduler.runUntilIdle(10_000);
        }
      },
    },
    ...Array.from({ length: 6 }, (): Step => ({ rounds: 1 })),
    {
      probe: 'two applies', run: async (ctx) => {
        const id0 = peerIdOf(ctx, 0);
        const idx = ctx.trace.events.map((e, k) => [e, k] as const).filter(([e]) => e.kind === 'apply' && e.peer === id0 && e.written.some((p) => p.startsWith('x8/')));
        assert.equal(idx.length, 2, `exactly 2 applies on p0 (${idx.length})`);
        const [[a1, k1], [a2, k2]] = idx as Array<readonly [Extract<(typeof ctx.trace.events)[number], { kind: 'apply' }>, number]>;
        assert.deepEqual(a1.written.filter((p) => p.startsWith('x8/')), [PATHS[0]], 'the first at p0\'s first iteration');
        assert.deepEqual(a2.written.filter((p) => p.startsWith('x8/')).sort(), PATHS.slice(1), 'the second covering the rest');
        const m1 = ctx.trace.monoAt(k1)!;
        const m2 = ctx.trace.monoAt(k2)!;
        assert.ok(m2 - m1 >= APPLY_GAP_MS, `the second ≥ 10 s later (${m2 - m1} ms)`);
        assert.ok(m2 - lastCommitMono <= APPLY_GAP_MS + 2_500, `all six applied within 10 s plus one loop after the last commit (${m2 - lastCommitMono} ms)`);
        const written = ctx.trace.events.map((e, k) => [e, k] as const).filter(([e]) => e.kind === 'apply' && e.peer === id0 && e.written.length > 0).map(([, k]) => ctx.trace.monoAt(k)!);
        for (let n = 1; n < written.length; n++) assert.ok(written[n]! - written[n - 1]! >= APPLY_GAP_MS, 'no two written applies < 10 s apart');
        checked = true;
      },
    },
  ];
  okOrFail((await scriptRun('holds-x05-x8b', steps, { oracles: holdsOracles() })).r);
  assert.ok(checked);
});
