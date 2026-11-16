// The `holds` crash matrix (Plan 3 Task 16; 11-testing TST-06 (SIM form), §3.6; TC-ENG-12 (SIM form); F-FS-4; O-REACH; rulings R3-52,
// R3-55, X-116): every crashpoint of the catalogue that src/ places — Plan 2's 14 — killed once per seed (test/sim/crashMatrix.ts,
// holdsCrashRun), registry.cas twice (before and after its CAS), armed one after another, the next only after the previous kill's
// restart; after every second kill the author of a just-applied row deletes it and `git gc --prune=now` runs in every clone and the
// remote. Every oracle (exitOracles(ns, {holds: {markers}}), O-STATE, O-REACH and the deletion oracle) runs after every op; they are
// observed (the run goes on), so the matrix mechanics are asserted on every seed and an oracle that fires fails the test — unless it is
// a named engine defect of KNOWN_DEFECTS, pinned as a `todo` (the oracle stays strict). Then O-REACH's plant, which also reads the
// holds-crash-0 run. The hold operators' crash tests (05 F7, Review Focus 3) are sim.crash.holds.ops.test.ts, the O-STATE and rewind
// plants sim.crash.holds.plants.test.ts: three files, so `npm test` runs them side by side (each file stays inside run-tests' 60 min
// budget per file on Node 20-23).
//
// `npm test` runs holds-crash-0; `npm run test:sim` (TEST_SIM_FULL=1) all three seeds (R3-55). Real git against file:// bare remotes;
// git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HoldRecord } from '../../src/holds/record.js';
import { has, holdsOf, live, play, type Step } from '../helpers/holdsScript.js';
import { PLAN2_CRASHPOINTS } from '../helpers/plan2Crashpoints.js';
import { dropArtifacts, observing, type Fired } from '../helpers/simOps.js';
import { catalogueCrashpoints, expectedSearches, holdsCrashRun, holdsSlots, revertSetup, runCrashMatrix, type HoldsMatrixFacts, type Kill } from '../sim/crashMatrix.js';
import { holdsSetup } from '../sim/generators.js';
import { runSim, type SimResult } from '../sim/harness.js';
import type { MarkerModel } from '../sim/markers.js';
import { oracleReach, reachVerdict } from '../sim/oracles.js';
import { plantBlob, plantRegistry } from '../sim/oraclesHolds.js';

/** R3-55: every seed under `npm run test:sim`, the first under `npm test`. */
const FULL = process.env['TEST_SIM_FULL'] === '1';
/** A rerun aid (as sim.crash.test.ts's): COWORK_SIM_ONLY=holds-crash-1 runs only that seed's subtest. */
const ONLY = process.env['COWORK_SIM_ONLY']?.split(',') ?? null;
const skipUnless = (name: string): { skip: string | false } => ({ skip: ONLY !== null && !ONLY.includes(name) && `COWORK_SIM_ONLY=${ONLY.join(',')}` });
/**
 * Engine defects the matrix seeds reach on this base (the report diagnoses each; the controller dispatches the fixes): an oracle that
 * fires with exactly this message on this seed pins the seed's oracle verdict as a `todo` naming the defect — any other fire fails.
 * None at EF4 round 1: holds-crash-0 and holds-crash-2 (E16-A, INV-GROUP (iii)) pass since E2-1 (R3-EF4-4) and T-3 merged.
 */
const KNOWN_DEFECTS: Readonly<Record<string, ReadonlyArray<{ oracle: string; message: RegExp; defect: string }>>> = Object.freeze({});

/** The holds-crash-0 run, kept for the O-REACH test's "passes after gc_prune ops on holds-crash-0". */
let crash0: { r: SimResult; fired: Map<string, Fired>; facts: HoldsMatrixFacts } | null = null;

const showKills = (kills: readonly Kill[]): string => JSON.stringify(kills.map((k) => `${k.note} ${k.peer ?? '-'}@${k.step}/${k.phase}`));

test('the 14-name crash matrix on holds-crash-0, -1 and -2: each Plan 2 name killed once per seed and registry.cas twice (before and after the CAS); after each restart oracleState, oracleReach, INV-GROUP and INV-NOLOSS hold, the row its author deleted after an even kill lands in live_code and never reappears in any later live_code, and each run reaches quiescence passing every exit oracle', { timeout: (FULL ? 300 : 85) * 60_000 }, async (t) => {
  // X-116: the names come from the catalogue (the ones src/ places), not a list of this test's: at Plan 3's exit, Plan 2's 14.
  // (Fix round 1, review minor: never pinned to Plan 2's list — a later plan appends its names to the catalogue and this matrix kills
  // them too; at Plan 3's exit the placed names are exactly Plan 2's 14.)
  const names = catalogueCrashpoints();
  assert.ok(PLAN2_CRASHPOINTS.every((n) => names.includes(n)), `the catalogue names src/ places include Plan 2's 14: ${names.join(', ')}`);
  const slots = holdsSlots(names);
  assert.equal(slots.length, names.length + 1, 'every name, registry.cas twice');
  const seeds = FULL ? ['holds-crash-0', 'holds-crash-1', 'holds-crash-2'] : ['holds-crash-0'];
  for (const seed of seeds) {
    // Each seed's own timeout: Node 24's --test-timeout (run-tests: 10 min) applies to every subtest, and the parent's does not
    // propagate. 80 min per seed: three seeds stay under the parent's 300 min under TEST_SIM_FULL, one under its 85 min.
    await t.test(seed, { timeout: 80 * 60_000, ...skipUnless(seed) }, async (st) => {
      const got: { facts: HoldsMatrixFacts | null; fired: Map<string, Fired>; markers: MarkerModel | null } = { facts: null, fired: new Map(), markers: null };
      const [res] = await runCrashMatrix((s: { seed: string }) => {
        const run = holdsCrashRun(s.seed);
        const obs = observing(run.oracles);
        got.facts = run.facts;
        got.fired = obs.fired;
        got.markers = run.markers;
        return { ...run, oracles: obs.oracles };
      }, [{ seed }]);
      const r = res!.r;
      const kills = res!.kills;
      const f = got.facts;
      const fired = got.fired;
      const markers = got.markers;
      assert.ok(f !== null && markers !== null);
      if (seed === 'holds-crash-0') crash0 = { r, fired, facts: f };
      await dropArtifacts(r);
      const where = `kills ${showKills(kills)}; outcome ${JSON.stringify([...f.outcome])}; fired ${JSON.stringify(Object.fromEntries(fired))}`;

      // Every slot killed exactly once, in its own peer step; registry.cas before (an odd hit) and after (an even hit) its CAS.
      assert.deepEqual(slots.map((s) => [s.name, s.cas ?? null, 'killed' in (f.outcome.get(s.cas === undefined ? s.name : `${s.name}#${s.cas}`) ?? {})]), slots.map((s) => [s.name, s.cas ?? null, true]), `${seed}: every slot killed: ${where}`);
      assert.deepEqual(kills.map((k) => k.name).sort(), [...names, 'registry.cas'].sort(), `${seed}: each name once, registry.cas twice: ${where}`);
      const cas = kills.filter((k) => k.name === 'registry.cas').map((k) => k.note);
      assert.equal(cas.length, 2);
      assert.match(cas[0]!, /^registry\.cas#before hit=1$/, `${seed}: before the CAS (an odd hit): ${cas[0]}`);
      assert.match(cas[1]!, /^registry\.cas#after hit=2$/, `${seed}: after the CAS (the even hit of the same commit): ${cas[1]}`);
      assert.ok(kills.every((k) => k.peer !== null), 'each kill ended a peer\'s own engine call');
      // Each kill was followed by that peer's restart before the next slot was armed (the next kill comes after it).
      const killedRows = r.opLog.filter((e) => e.kind === 'killed');
      assert.equal(killedRows.length, kills.length, 'one killed row per kill');
      for (const [k, row] of killedRows.entries()) {
        const at = r.opLog.indexOf(row);
        const restart = r.opLog.findIndex((e, x) => x > at && e.peer === row.peer && e.kind === 'start');
        assert.ok(restart > at, `${row.peer} restarted after ${row.detail}`);
        assert.match(r.opLog[restart]!.detail, /^(restart|genesis|join) /, `${row.peer}'s start after ${row.detail}`);
        const nextKill = killedRows[k + 1];
        if (nextKill !== undefined) assert.ok(r.opLog.indexOf(nextKill) > restart, `the next kill (${nextKill.detail}) only after ${row.peer}'s restart`);
      }
      // Half the kills are followed by a deleted just-applied row (its author's, never the killed peer's or the team writer's) and a gc —
      // R3-52's rule as the brief states it: after the second of every two counted kills a row search; "the kill counts toward the half
      // only when such a row exists", so a search that deletes nothing un-counts its kill and the next kill searches again. Every search
      // the rule asks for ran (the last kill's only if an op was left), each found row was deleted by its author, and a search without a
      // row names why each candidate was passed over (fix round 1: holds-crash-1's rows are all its R3-53-latched p2's).
      const searches = `searches ${JSON.stringify(f.attempts.map((a) => ({ k: a.afterKill, row: a.row, outcome: a.outcome, rejected: a.rejected })))}`;
      const expected = expectedSearches(kills.length, f.attempts);
      const searched = f.attempts.map((a) => a.afterKill);
      const lastLeft = expected.length === searched.length + 1 && expected[expected.length - 1] === kills.length - 1;
      assert.deepEqual(searched, lastLeft ? expected.slice(0, -1) : expected, `${seed}: a row search after each even counted kill: ${searches}`);
      for (const a of f.attempts) {
        if (a.row === null) assert.ok(a.outcome === 'no row' && a.rejected.length > 0, `${seed}: a search without a row says why: ${JSON.stringify(a)}`);
        else assert.equal(a.outcome, 'deleted', `${seed}: ${a.row.author}'s informed delete of ${a.row.marker} (${a.row.path}) wrote the deletion: ${JSON.stringify(a)}`);
      }
      assert.equal(f.deletions.length, f.attempts.filter((a) => a.outcome === 'deleted').length, 'one tracked deletion per deleting search');
      // npm test's seed shows the whole mechanism — a row found, deleted by its author, landed, gc'd; a FULL seed may meet no eligible row.
      if (seed === 'holds-crash-0') assert.ok(f.deletions.length >= 1, `${seed}: at least one row deletion after an even kill: ${searches}; ${where}`);
      for (const d of f.deletions) {
        assert.notEqual(d.author, d.killed, 'the author is not the killed peer');
        assert.ok(d.landedIn !== null, `${d.author}'s deletion of ${d.marker} landed in live_code: ${JSON.stringify(d)}; ${where}`);
        assert.ok(markers.retired().has(d.marker), `${d.marker}: an informed removal the model retired (R3-64 then checks it never comes back)`);
      }
      assert.equal(f.gcs.length, f.deletions.length, 'one gc of every clone and the remote per deletion');
      assert.equal(r.quiescence?.reached, true, `${seed}: quiescence: ${JSON.stringify(r.quiescence)}`);
      assert.equal(r.quiescence?.pushAttemptsInExtra, 0);

      // The oracles (observed): none fired — or only a named engine defect of this seed (a todo; the oracle stays strict).
      const known = KNOWN_DEFECTS[seed] ?? [];
      const unexplained = [...fired].filter(([name, x]) => !known.some((k) => k.oracle === name && k.message.test(x.message)));
      if (fired.size > 0 && unexplained.length === 0) st.todo(known.filter((k) => fired.has(k.oracle)).map((k) => k.defect).join('; '));
      assert.deepEqual([...fired.keys()], [], `${seed}: every oracle holds — O-STATE, O-REACH, INV-GROUP, INV-NOLOSS after each restart, every exit oracle at quiescence: ${where}`);
    });
  }
});

// ---- O-REACH's plant ---------------------------------------------------------------------------------------------------------------

test('oracleReach fails on a planted registry commit naming a blob that gc --prune=now removed, and passes after gc_prune ops on holds-crash-0', { timeout: 60 * 60_000 }, async (t) => {
  const s = holdsSetup('holds-oreach', { script: [] });
  const facts = new Map<string, string | null>();
  const steps: Step[] = [
    ...revertSetup('own/or-p0.txt'),
    { rounds: 12 },
    {
      probe: 'plant', run: async (ctx) => {
        facts.set('clean', await reachVerdict(ctx, ctx.peers[1]!));
        const rec = live(await holdsOf(ctx, 1)).find((x) => has(x, 'revert'))!;
        // A blob only the planted record names (not under the registry's blobs/): unreachable, so gc --prune=now removes it.
        const lost = await plantBlob(ctx, 1, Buffer.from('a held side gc will remove\n', 'utf8'));
        const path = rec.paths[0]!;
        await plantRegistry(ctx, 1, rec.id, (x) => ({ ...x, blobs: { ...x.blobs, h1: { ...(x.blobs as { h1: Record<string, string> }).h1, [path]: lost } } } as HoldRecord));
        facts.set('before-gc', await reachVerdict(ctx, ctx.peers[1]!));
        const step = ctx.opLog[ctx.opLog.length - 1]?.step ?? -1;
        await ctx.git.run(['gc', '--prune=now', '--quiet'], { class: 'local', cwd: ctx.peers[1]!.dir });
        ctx.opLog.push({ step, peer: 'p1', kind: 'gc_prune', detail: 'planted' });
        facts.set('after-gc', await oracleReach().afterEveryOp!(ctx));
        facts.set('lost', lost);
        facts.set('id', rec.id);
        facts.set('path', path);
      },
    },
  ];
  const r = await runSim({ ...s.tuple, ops: steps.length }, s.factory, [], { ...s.options, generator: play(steps, s.markers), quiescence: undefined });
  assert.ok(r.ok, JSON.stringify(r.failure));
  await dropArtifacts(r);
  assert.equal(facts.get('clean'), null, 'every named object exists before the plant');
  assert.equal(facts.get('before-gc'), null, 'the planted blob exists until the gc');
  assert.equal(facts.get('after-gc'), `O-REACH p1: 1 named object(s) missing: ${facts.get('lost')} (record ${facts.get('id')} h1[${facts.get('path')}])`);
  // holds-crash-0 (the matrix test above): its gc --prune=now of every clone and the remote, O-REACH after each and at quiescence.
  const c0 = crash0 as { r: SimResult; fired: Map<string, Fired>; facts: HoldsMatrixFacts } | null;
  if (c0 === null) {
    // The matrix test runs first in this file and keeps holds-crash-0 for this half; a run that filtered it out (COWORK_SIM_ONLY, a
    // --test-name-pattern) or in which it threw before its result (that test then fails itself) leaves nothing to judge here.
    t.skip('holds-crash-0 did not run in this process: the plant half passed, the gc_prune half is judged where the matrix runs');
  } else {
    assert.ok(c0.facts.gcs.length >= 1, `holds-crash-0 ran gc --prune=now (${c0.facts.gcs.length})`);
    assert.equal(c0.fired.get('O-REACH'), undefined, `oracleReach passes after the gc_prune ops of holds-crash-0: ${JSON.stringify(c0.fired.get('O-REACH'))}`);
  }
});
