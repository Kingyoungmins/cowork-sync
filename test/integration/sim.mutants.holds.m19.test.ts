// TC-TST-02, the M19 scenario (Plan 3 Task 14; 11-testing §3.9 M19, TC-TST-02, TC-HLD-01; R3-50). Fix round 1 split TC-TST-02 into one
// file per mutant so run-tests.mjs runs them in parallel (R3-55); the runner (tcTst02) and the shared helpers are in
// test/helpers/holdsOracleScript.ts. A scripted holds run (holdsSetup's composition with RealEngineOptions.mutants, crash rate 0) on real
// git against file:// bare remotes. The mutant-off leg runs Plan 2's INV-PUSHED-IS-MERGE too and ends with EF2 D1's plant of its MASK
// step-5 clause (m19Plant).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seededRandom } from '../../src/ports/random.js';
import type { TraceEvent } from '../../src/ports/trace.js';
import { SIM_TIMEOUT, type Step, has, holdsOf, live, disk } from '../helpers/holdsScript.js';
import { indexOf, lf, TC_TST_02, tcTst02, type Scenario } from '../helpers/holdsOracleScript.js';
import { testRunner } from '../helpers/tmp.js';
import { seedFilesPlan3 } from '../sim/generators.js';
import type { SimContext } from '../sim/harness.js';
import { oraclePushedIsMerge } from '../sim/oracles.js';
import { peerIdOf, saveAs } from '../sim/oraclesHolds.js';

// ---- EF2 D1: INV-PUSHED-IS-MERGE's MASK step-5 clause, planted -----------------------------------------------------------------

const plantGit = testRunner();
async function gitIn(dir: string, args: string[], stdin?: Buffer): Promise<string> {
  const r = await plantGit.run(args, { class: 'local', cwd: dir, identity: { name: 'plant', email: 'plant@cowork.invalid' }, ...(stdin === undefined ? {} : { stdin }) });
  assert.equal(r.code, 0, `git ${args.join(' ')}: ${r.stderr.toString('utf8')}`);
  return r.stdout.toString('utf8');
}
/** `tree` with its direct entry `name` pointing at `oid` (git mktree; mode and type kept). */
async function replaceEntry(dir: string, tree: string, name: string, oid: string): Promise<string> {
  const lines = (await gitIn(dir, ['ls-tree', '-z', tree])).split('\0').filter((l) => l.length > 0);
  let hit = false;
  const out = lines.map((l) => {
    const tab = l.indexOf('\t');
    if (l.slice(tab + 1) !== name) return l;
    hit = true;
    const [mode, type] = l.slice(0, tab).split(' ');
    return `${mode} ${type} ${oid}\t${name}`;
  });
  assert.ok(hit, `${tree} has ${name}`);
  return (await gitIn(dir, ['mktree', '-z'], Buffer.from(out.map((l) => `${l}\0`).join(''), 'utf8'))).trim();
}

/**
 * EF2 D1 (05 §3.4 item 2 step 5, HLD-42; 11-testing INV-PUSHED-IS-MERGE): p0's landed publish of m.txt under its ON_DISK ACTIVE revert
 * PATCH carries P[m.txt] = mf(R, H1', A) (R minus the held rows, p0's own row 20 kept), which is neither the journal's composition X
 * nor A. The oracle now accepts exactly the test-side MASK (testMask over the compose event's registry): a fresh oracle passes the real
 * trace, and fails, on its P clause, the same publish planted with P' = that P[m.txt] less one more row (a state commit whose journal
 * t/P is P', and the compose and publish events naming P').
 */
const m19Plant: Step = {
  probe: 'EF2 D1 plant', run: async (ctx) => {
    const id0 = peerIdOf(ctx, 0);
    const dir = ctx.peers[0]!.dir;
    const events = [...ctx.trace.events];
    // p0's first composition over m.txt that a code publish carried (the publish right after it naming its P).
    let ci = -1;
    let pi = -1;
    for (let k = 0; k < events.length && pi < 0; k++) {
      const e = events[k]!;
      if (e.kind !== 'compose' || e.peer !== id0 || !e.pairs.some((x) => x.paths.includes('m.txt'))) continue;
      const next = events.findIndex((x, j) => j > k && (x.kind === 'compose' || x.kind === 'publish') && x.peer === id0);
      const x = events[next];
      if (x?.kind === 'publish' && x.c !== null && x.pTree === e.pTree) [ci, pi] = [k, next];
    }
    assert.ok(ci >= 0 && pi >= 0, 'p0 published a composition over m.txt');
    const compose = events[ci] as Extract<TraceEvent, { kind: 'compose' }>;
    const publish = events[pi] as Extract<TraceEvent, { kind: 'publish' }>;
    let si = -1;
    for (let k = pi - 1; k >= 0 && si < 0; k--) if (events[k]!.kind === 'state' && events[k]!.peer === id0) si = k;
    assert.ok(si >= 0, 'a state event of p0 before the publish');
    const state = events[si] as Extract<TraceEvent, { kind: 'state' }>;
    const verdict = (evs: TraceEvent[]): Promise<string | null> =>
      oraclePushedIsMerge().afterEveryOp!({ ...ctx, trace: { events: evs, names: ctx.trace.names } as unknown as SimContext['trace'] });
    assert.equal(await verdict(events), null, 'the real trace passes INV-PUSHED-IS-MERGE');
    const regs = live(await holdsOf(ctx, 0)).filter((r) => r.kind === 'PATCH' && has(r, 'revert') && r.paths.includes('m.txt'));
    assert.equal(regs.length, 1, 'p0 holds m.txt in a revert PATCH (MASK step 5)');
    // P' = P with m.txt less its first row: neither X[m.txt], A[m.txt] nor the step-5 chain.
    const pm = (await gitIn(dir, ['rev-parse', `${publish.pTree}:m.txt`])).trim();
    const rows = (await gitIn(dir, ['cat-file', 'blob', pm])).split('\n');
    const blob = (await gitIn(dir, ['hash-object', '-w', '--stdin', '--no-filters'], Buffer.from(rows.slice(1).join('\n'), 'utf8'))).trim();
    const P2 = await replaceEntry(dir, publish.pTree, 'm.txt', blob);
    const root = (await gitIn(dir, ['rev-parse', `${state.next}^{tree}`])).trim();
    const journal = (await gitIn(dir, ['rev-parse', `${root}:journal`])).trim();
    const t = (await gitIn(dir, ['rev-parse', `${root}:journal/t`])).trim();
    const root2 = await replaceEntry(dir, root, 'journal', await replaceEntry(dir, journal, 't', await replaceEntry(dir, t, 'P', P2)));
    const state2 = (await gitIn(dir, ['commit-tree', root2, '-m', 'plant'])).trim();
    const planted = [...events];
    planted[si] = { ...state, next: state2 };
    planted[ci] = { ...compose, pTree: P2 };
    planted[pi] = { ...publish, pTree: P2 };
    const msg = await verdict(planted);
    // The step-5 clause itself (not the strict fallback, whose text ends "and MASK A[m.txt] = …") rejects it.
    assert.ok(msg !== null && /^p0: publish [0-9a-f]+: P\[m\.txt\] = 100644 [0-9a-f]+, but the journal's composition gives 100644 [0-9a-f]+ and MASK step 5 over registry [0-9a-f]+ gives 100644 [0-9a-f]+$/.test(msg), `the planted P fails the step-5 clause: ${msg}`);
    return msg.slice(0, 200);
  },
};

const M_ROWS = 40;
const mFile = (): Buffer => lf(Array.from({ length: M_ROWS }, (_, k) => `m row ${k + 1}`));

/**
 * M19: p1 adds Y (row 10) and Z (row 30); p0 stale-saves genesis + an own row 20 (a revert PATCH over Y and Z); p1 deletes Y; once p0's
 * A has the deletion, its next materialization's step 5 from the unrebased pair re-adds Y in S_pub.
 */
const M19: Scenario = {
  mutant: 'M19', expected: 'INV-MASK', seed: 'holds-mut-m19',
  seedFiles: { ...seedFilesPlan3(seededRandom('holds-mut-m19/files')), 'm.txt': mFile() },
  steps: (mark): Step[] => [
    { rounds: 1 },
    { kind: 'edit_band', peer: 1, params: { path: 'm.txt', insert: true, row: 9, n: 1, text: 'Y' } },
    { kind: 'edit_band', peer: 1, params: { path: 'm.txt', insert: true, row: 30, n: 1, text: 'Z' } },
    { rounds: 12 },
    { kind: 'stale_save', peer: 0, params: { path: 'm.txt', buffer: 'genesis', row: 19 } },
    { rounds: 12 },
    {
      probe: 'p1 deletes Y', run: async (ctx) => {
        const recs = live(await holdsOf(ctx, 0)).filter((r) => has(r, 'revert') && r.paths.includes('m.txt'));
        assert.equal(recs.length, 1, 'p0 holds one revert PATCH over m.txt');
        const b = (await disk(ctx, 1, 'm.txt'))!.toString('latin1').split('\n');
        const at = b.findIndex((r) => r.startsWith('Y CWM_'));
        assert.ok(at >= 0, 'p1 has Y');
        b.splice(at, 1);
        await saveAs(ctx, 1, 'm.txt', Buffer.from(b.join('\n'), 'latin1'));
        mark(ctx);
      },
    },
    { rounds: 12 },
    { kind: 'new_file', peer: 0, params: { path: 'own/p0-later.txt', rows: 3 } },   // a later materialization of p0
    { rounds: 12 },
  ],
  // p0's first mask event after its A took p1's deletion of Y
  predicted: (ctx, from) => {
    if (from < 0) return false;
    const id0 = peerIdOf(ctx, 0);
    const a = indexOf(ctx, from, (e) => e.kind === 'A_set' && e.peer === id0 && e.path === 'm.txt');
    return a >= 0 && indexOf(ctx, a + 1, (e) => e.kind === 'mask' && e.peer === id0) >= 0;
  },
  offProbe: m19Plant,
};

test(`${TC_TST_02} [M19 scenario]`, { timeout: 2 * SIM_TIMEOUT }, async (t) => {
  await tcTst02(t, M19);
});
