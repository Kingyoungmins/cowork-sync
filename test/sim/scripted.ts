// Scripted SIM runs (Plan 2 Task 18 tests): a fixed list of steps instead of a random op generator.
import { editGenerator, FAULT_KINDS, type EditKind, type FaultKind } from './generators.js';
import { advanceClocks, type OpGenerator, type SimContext, type SimOp } from './harness.js';

/** A generator that draws only `kinds` (weight 1 each) and never an engine step. */
export function only(...kinds: Array<EditKind | FaultKind>): OpGenerator {
  const faults = kinds.some((k) => (FAULT_KINDS as readonly string[]).includes(k));
  return editGenerator({ name: faults ? 'faults' : 'edits', engineWeight: 0, weights: Object.fromEntries(kinds.map((k) => [k, 1])) });
}

/** One step: an engine step of peer i, one op of a generator, or `wait` (virtual time passes, as between harness steps). */
export type Script = Array<{ iterate: number } | { gen: OpGenerator } | { wait: number }>;

/** A generator that plays `script` (step k runs script[k]; past its end every step is an engine step of a random peer). */
export function scripted(script: Script): OpGenerator {
  return {
    next(ctx: SimContext, step: number): SimOp | null {
      const s = script[step];
      if (s === undefined) return null;
      if ('iterate' in s) {
        const i = s.iterate;
        const engine = ctx.engines[i];
        if (engine === undefined) throw new Error(`script step ${step}: no engine ${i}`);
        return { peer: engine.peer.name, kind: 'iterate', run: async (c) => { await engine.step(c); return 'step'; } };
      }
      if ('wait' in s) {
        // Every peer clock and the scheduler clock, the way the harness moves time between steps.
        return { peer: '*', kind: 'wait', run: async (c) => { advanceClocks(c, s.wait); return `ms=${s.wait}`; } };
      }
      const op = s.gen.next(ctx, step);
      if (op === null) throw new Error(`script step ${step}: the generator drew an engine step`);
      return op;
    },
  };
}

/** Each peer's first step, in peer order: peer 0 runs genesis, the others join. */
export const startAll = (n: number): Script => Array.from({ length: n }, (_, i) => ({ iterate: i }));
