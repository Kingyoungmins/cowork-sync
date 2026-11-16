// The hold operators' crash points (Plan 3 Task 16; 05 F7, HLD-01, HLD-16, INV-HLD-DURABLE; Review Focus 3; rulings R3-15, R3-23, R3-52,
// R3-55): 05 F7 (SIM) — a KilledAt at registry.cas before / after the CAS of one registry commit; Review Focus 3 — registry.cas after its
// CAS and the writer's apply.group.phase1/phase2 inside each displacing operator, then `git gc --prune=now` everywhere. The crash matrix
// itself is sim.crash.holds.test.ts.
//
// `npm test` runs the first Review Focus 3 operator at its first kill point (Ruling R3-51/55-A); `npm run test:sim` (TEST_SIM_FULL=1)
// every operator at every point (R3-55).
// Real git against file:// bare remotes; git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RELEASE_NAMESPACE } from '../../src/engine/refs.js';
import type { Oid } from '../../src/git/oid.js';
import type { HoldRecord } from '../../src/holds/record.js';
import { engineAt, has, holdsOf, live, play, type Step } from '../helpers/holdsScript.js';
import { dropArtifacts, observing } from '../helpers/simOps.js';
import { armedKill, revertSetup } from '../sim/crashMatrix.js';
import { killableCall } from '../sim/engineAdapter.js';
import { holdsSetup } from '../sim/generators.js';
import { advanceClocks, runSim, type SimContext, type SimResult } from '../sim/harness.js';
import { readBlob, readRegistry } from '../sim/holdsView.js';
import { findMarkers, type MarkerModel } from '../sim/markers.js';
import { currentRemoteDir, exitOracles, oracleReach, oracleState, reachVerdict } from '../sim/oracles.js';

/** R3-55: every operator and point under `npm run test:sim`, the first of each under `npm test`. */
const FULL = process.env['TEST_SIM_FULL'] === '1';
/** A rerun aid (as sim.crash.test.ts's): COWORK_SIM_ONLY=park@apply.group.phase1 runs only those subtests. */
const ONLY = process.env['COWORK_SIM_ONLY']?.split(',') ?? null;
const skipUnless = (name: string): { skip: string | false } => ({ skip: ONLY !== null && !ONLY.includes(name) && `COWORK_SIM_ONLY=${ONLY.join(',')}` });
const NS = RELEASE_NAMESPACE;

// ---- 05 F7 (SIM) ----------------------------------------------------------------------------------------------------------------------

/** Registry head and record id → rev of peer i now. */
async function registryRevs(ctx: SimContext, i: number): Promise<{ head: string | null; revs: Map<string, number> }> {
  const reg = await readRegistry(ctx.git, ctx.peers[i]!.dir, 'main');
  return { head: reg.head, revs: new Map([...reg.records.values()].map((r) => [r.id, r.rev])) };
}

test('05 F7 (SIM): a KilledAt at registry.cas before the CAS leaves the registry ref at the old commit and after the CAS at the new commit (whose parent is the old); the restarted record set equals the old set plus exactly the ids and revs of the killed commit, with no id twice and none missing', { timeout: 80 * 60_000 }, async (t) => {
  for (const when of ['before', 'after'] as const) {
    // Each subtest's own timeout (Node 24's --test-timeout applies to every subtest; the parent's 80 min does not propagate).
    await t.test(`killed ${when} the CAS`, { timeout: 35 * 60_000 }, async () => {
      const s = holdsSetup(`holds-f7-${when}`, { script: [] });
      const kill = armedKill();
      const facts: { old?: { head: string | null; revs: Map<string, number> }; atKill?: { head: string | null; revs: Map<string, number> }; parent?: string | null; restarted?: { head: string | null; revs: Map<string, number>; engine: string[] }; killed?: boolean } = {};
      const steps: Step[] = [
        ...revertSetup('own/f7-p0.txt'),
        {
          probe: 'kill p1 at registry.cas', run: async (ctx) => {
            facts.old = await registryRevs(ctx, 1);
            kill.arm('registry.cas', when === 'before' ? 1 : 2);
            // p1 alone, 2.5 virtual s apart, until it died (its edit materializes after the quiet period: the revert record's commit).
            for (let n = 0; n < 40; n++) {
              advanceClocks(ctx, 2_500);
              await ctx.engines[1]!.step(ctx);
              await ctx.scheduler.runUntilIdle(10_000);
              if (ctx.opLog.some((e) => e.kind === 'killed' && e.peer === 'p1')) break;
            }
            facts.killed = kill.disarm().killed;
            facts.atKill = await registryRevs(ctx, 1);
            if (facts.atKill.head !== null && facts.atKill.head !== facts.old.head) {
              const parents = (await ctx.git.run(['rev-list', '--parents', '-n', '1', facts.atKill.head], { class: 'local', cwd: ctx.peers[1]!.dir })).stdout.toString('utf8').trim().split(' ').slice(1);
              facts.parent = parents[0] ?? null;
            }
          },
        },
        { iterate: 1 },   // the restart (start() only: the adapter's next step after a kill)
        {
          probe: 'restarted', run: async (ctx) => {
            const ins = await engineAt(ctx, 1).inspect();
            facts.restarted = { ...(await registryRevs(ctx, 1)), engine: ins.holds.map((r) => `${r.id}@${r.rev}`) };
          },
        },
        { rounds: 4 },
      ];
      const restore = kill.install();
      let r: SimResult;
      try {
        // crash: undefined — the harness's own handler (installed for any SimOptions.crash, rate 0 included) would replace this test's.
        r = await runSim({ ...s.tuple, ops: steps.length }, s.factory, [oracleState(), oracleReach()], { ...s.options, crash: undefined, generator: play(steps, s.markers), quiescence: undefined });
      } finally {
        restore();
      }
      assert.ok(r.ok, `${JSON.stringify(r.failure)}; artifacts ${String(r.artifactsDir)}`);
      await dropArtifacts(r);
      assert.equal(facts.killed, true, `p1 died at registry.cas hit ${when === 'before' ? 1 : 2}`);
      const { old, atKill, restarted } = facts as Required<typeof facts>;
      if (when === 'before') {
        assert.equal(atKill.head, old.head, 'before the CAS: the registry ref is still the old commit');
        assert.deepEqual([...atKill.revs], [...old.revs]);
      } else {
        assert.notEqual(atKill.head, old.head, 'after the CAS: the registry ref is the new commit');
        assert.equal(facts.parent ?? null, old.head, 'whose parent is the old commit');
      }
      // The killed commit's ids and revs: what the new head adds or changes over the old one (none before the CAS).
      const delta = [...atKill.revs].filter(([id, rev]) => old.revs.get(id) !== rev);
      if (when === 'after') assert.ok(delta.length >= 1, 'the killed commit wrote a record');
      const expected = new Map([...old.revs, ...delta]);
      assert.deepEqual([...restarted.revs].sort(), [...expected].sort(), 'the restarted record set = the old set + exactly the killed commit\'s ids and revs');
      const ids = restarted.engine.map((x) => x.split('@')[0]!);
      assert.equal(new Set(ids).size, ids.length, 'no id twice');
      assert.deepEqual([...restarted.engine].sort(), [...expected].map(([id, rev]) => `${id}@${rev}`).sort(), 'the restarted engine holds exactly that set, none missing');
    });
  }
});

// ---- Review Focus 3 ---------------------------------------------------------------------------------------------------------------------

type Operator = 'park' | 'restore' | 'discard' | 'markers-park' | 'take' | 'k4';
type Point = 'registry.cas' | 'apply.group.phase1' | 'apply.group.phase2';
const OPERATORS: readonly Operator[] = ['park', 'markers-park', 'restore', 'discard', 'take', 'k4'];
const POINTS: readonly Point[] = ['registry.cas', 'apply.group.phase1', 'apply.group.phase2'];

/**
 * Engine defects these scenarios reach on this base (Task 16's report diagnoses each; the controller dispatches the fixes): a run that
 * fails with exactly this oracle and message is pinned as a `todo` naming the defect — the checks stay strict, any other failure fails.
 */
// EF4 round 1 (merged): markers-park at apply.group.phase2 passes (twice, alone and with the other two); its pin went.
// E16-E fixed (a restore's observed write survives a restart, RegistryLocal.restored; restore.restart.test.ts): markers-park at
// registry.cas and at apply.group.phase1 pass under TEST_SIM_FULL=1; their pins went. No scenario is pinned now.
const KNOWN_DEFECTS: ReadonlyMap<string, { oracle: string; message: RegExp; defect: string }> = new Map();

/** The hold record of peer i the operator acts on. */
const target = async (ctx: SimContext, i: number, pred: (r: HoldRecord) => boolean): Promise<HoldRecord> => {
  const r = live(await holdsOf(ctx, i)).find(pred);
  assert.ok(r !== undefined, `p${i} holds the operator's record`);
  return r;
};

/** `resolve` on peer i's engine as `daemon.js resolve` (its own process: a KilledAt ends it) with opResolve's model bookkeeping. */
async function resolveKillable(ctx: SimContext, markers: MarkerModel, i: number, r: HoldRecord, verb: 'park' | 'restore' | 'discard' | 'publish', facts: Rf3Facts): Promise<string> {
  const reg = (await readRegistry(ctx.git, ctx.peers[i]!.dir, 'main')).records.get(r.id) ?? r;
  const sides = 'h1' in reg.blobs ? { from: reg.blobs.h0, to: reg.blobs.h1 } : { from: reg.blobs.s1, to: reg.blobs.s2 };
  const markersOf = async (oid: string | undefined): Promise<string[]> => (oid === undefined || oid === 'ABSENT' ? [] : findMarkers(await readBlob(ctx.git, ctx.peers[i]!.dir, oid as Oid)));
  const gone: string[] = [];
  if (verb === 'discard') {
    for (const p of reg.paths) {
      const base = new Set(await markersOf(sides.from[p]));
      gone.push(...(await markersOf(sides.to[p])).filter((m) => !base.has(m)));
    }
  }
  const out = await killableCall(ctx.engines[i]!, ctx, (e) => e.resolve(r.id, verb, { humanEvidence: true, actor: 'human' }));
  if (out === null) return 'no engine';
  // The model learns a discard in the op that completes it, as opResolve does — INV-NOLOSS then checks the record is RESOLVED_DISCARD:
  // here, or (an interrupted --discard) in the restart that settleHoldOps completes it in (restartStep).
  if ('killed' in out) {
    if (verb === 'discard') facts.pendingDiscard = { peer: i, id: r.id, gone };
    return 'killed';
  }
  if (verb === 'discard' && 'code' in out.value && out.value.code === 'RESOLVED_DISCARD') markers.noteDiscard(r.id, gone);
  return `${out.value.kind}${'code' in out.value ? ` ${String(out.value.code)}` : ''}`;
}

interface Rf3Facts {
  path: string; peer: number; before: Buffer | null; headBefore: string | null; killed: boolean; result: string;
  /** Hits of the armed point while armed (a diagnostic for the kill assertion). */
  hits?: number;
  afterKill?: { disk: Buffer | null; head: string | null; heldBytes: boolean; chain: string[] };
  reach: Array<string | null>; settled?: { inflight: number; disk: Buffer | null };
  /** An interrupted --discard: the model learns it in the restart that completes it. */
  pendingDiscard?: { peer: number; id: string; gone: string[] };
}

/**
 * Peer i's next engine step — after a kill, its restart (settleHoldOps, the writer's intent rollback) — as one op; when that restart
 * completed an interrupted --discard (the record is RESOLVED_DISCARD), the model learns the discard in the same op.
 */
function restartStep(i: number, markers: MarkerModel, facts: Rf3Facts): Step {
  return {
    probe: `p${i} step`, run: async (ctx) => {
      await ctx.engines[i]!.step(ctx);
      const d = facts.pendingDiscard;
      if (d === undefined || d.peer !== i) return 'step';
      const state = (await readRegistry(ctx.git, ctx.peers[i]!.dir, 'main')).records.get(d.id)?.state;
      if (state !== 'RESOLVED_DISCARD') return `step (${d.id} ${String(state)})`;
      markers.noteDiscard(d.id, d.gone);
      delete facts.pendingDiscard;
      return `step (${d.id} RESOLVED_DISCARD by the restart)`;
    },
  };
}

/** The operator's scenario steps: the setup, then `trigger` (the operator call, kill armed), then gc, the restart and the checks. */
function rf3Steps(op: Operator, point: Point, markers: MarkerModel, kill: ReturnType<typeof armedKill>, facts: Rf3Facts): Step[] {
  const nth = point === 'registry.cas' ? 2 : 1;   // registry.cas: the even hit — after the CAS of the operator's first registry commit
  const P = 'own/rf3-p0.txt';
  const isRevert = (r: HoldRecord): boolean => has(r, 'revert') && r.paths.includes(P);
  /** The operator call on peer i with the kill armed; the facts the checks need. */
  const trigger = (i: number, path: string, call: (ctx: SimContext) => Promise<string>): Step => ({
    probe: `${op} ${point}`, run: async (ctx) => {
      facts.peer = i;
      facts.path = path;
      facts.before = await readFile(join(ctx.peers[i]!.dir, ...path.split('/'))).catch(() => null);
      facts.headBefore = (await readRegistry(ctx.git, ctx.peers[i]!.dir, 'main')).head;
      kill.arm(point, nth);
      try {
        facts.result = await call(ctx);
      } finally {
        const d = kill.disarm();
        facts.killed = d.killed;
        facts.hits = d.hits;
      }
      return facts.result;
    },
  });
  /** Peer i's iterations (2.5 s apart) until it died or `n` ran. */
  const stepUntilKilled = (i: number, n: number) => async (ctx: SimContext): Promise<string> => {
    for (let k = 0; k < n; k++) {
      advanceClocks(ctx, 2_500);
      await ctx.engines[i]!.step(ctx);
      await ctx.scheduler.runUntilIdle(10_000);
      if (ctx.opLog.some((e) => e.kind === 'killed' && e.peer === `p${i}`)) return `killed after ${k + 1} iterations`;
    }
    return `not killed in ${n} iterations`;
  };
  let setup: Step[];
  let call: Step;
  switch (op) {
    case 'park':
    case 'discard':
      // p0 rewrites p1's line: an ON_DISK revert PATCH on p0 (the operator's record); --park / --discard write A over it.
      setup = [{ rounds: 2 }, { kind: 'new_file', peer: 1, params: { path: P, rows: 4 } }, { rounds: 14 }, { kind: 'edit_peer_line', peer: 0, params: { path: P } }, { rounds: 12 }];
      call = trigger(0, P, async (ctx) => resolveKillable(ctx, markers, 0, await target(ctx, 0, isRevert), op, facts));
      break;
    case 'restore':
      setup = [{ rounds: 2 }, { kind: 'new_file', peer: 1, params: { path: P, rows: 4 } }, { rounds: 14 }, { kind: 'edit_peer_line', peer: 0, params: { path: P } }, { rounds: 12 },
        { kind: 'resolve', peer: 0, params: { verb: 'park' } }, { rounds: 4 }];
      call = trigger(0, P, async (ctx) => resolveKillable(ctx, markers, 0, await target(ctx, 0, isRevert), 'restore', facts));
      break;
    case 'markers-park':
      // hold/exp_bc: park, p1 changes its row, a conflicted RESTORE (guards revert + markers, ON_DISK), durable; then 24 h: S6 parks it
      // through the markers park (companion first, then M → A) at p0's next iteration.
      setup = [{ rounds: 2 }, { kind: 'new_file', peer: 1, params: { path: P, rows: 4 } }, { rounds: 14 }, { kind: 'edit_peer_line', peer: 0, params: { path: P } }, { rounds: 12 },
        { kind: 'resolve', peer: 0, params: { verb: 'park' } }, { rounds: 2 },
        { kind: 'edit_own', peer: 1, params: { path: P, row: 4, text: 'p1 row v2' } }, { rounds: 12 },
        { kind: 'resolve', peer: 0, params: { verb: 'restore' } }, { rounds: 8 },
        { probe: 'markers', run: async (ctx) => { const r = await target(ctx, 0, isRevert); assert.ok(has(r, 'markers'), `revert + markers: ${JSON.stringify(r.guards)}`); } },
        { kind: 'age_24h', peer: 0 }];
      call = trigger(0, P, stepUntilKilled(0, 4));
      break;
    case 'take': {
      // p0's locally ignored local/rf3.cfg collides with p1's creation: an INCOMING collision record; --publish takes p1's version
      // inside the resolve call (engine/resolve.ts take: holdOps.collisionTake captures p0's bytes first — its registry commit — then
      // writes TIP[p] through writeLocal), so every kill point of the take is armed around that call.
      const isCollision = (r: HoldRecord): boolean => r.kind === 'INCOMING' && has(r, 'collision');
      const take = async (ctx: SimContext): Promise<string> => resolveKillable(ctx, markers, 0, await target(ctx, 0, isCollision), 'publish', facts);
      setup = [{ rounds: 1 }, { kind: 'collide_ignored', peer: 0, params: { other: 1, name: 'rf3.cfg' } }, { rounds: 12 }];
      call = trigger(0, 'local/rf3.cfg', take);
      break;
    }
    case 'k4':
      // The same line of notes.txt on p0 and p1 (one op edits both); p0 publishes first; p1's apply of p0's version displaces p1's row
      // (K4: the record, then the TIP write).
      setup = [{ rounds: 2 }, { kind: 'edit_same_line', peer: 0, params: { row: 4, other: 1 } }, { iterate: 0 }, { advance: 25_000 }, { iterate: 0 }, { advance: 6_000 }, { iterate: 0 }];
      call = trigger(1, 'notes.txt', stepUntilKilled(1, 8));
      break;
  }
  return [
    ...setup,
    call,
    {
      probe: 'after the kill', run: async (ctx) => {
        const i = facts.peer;
        const reg = await readRegistry(ctx.git, ctx.peers[i]!.dir, 'main');
        const disk = await readFile(join(ctx.peers[i]!.dir, ...facts.path.split('/'))).catch(() => null);
        // The operator's bytes: still on disk, or in a registry record (any state) whose held side or a stage holds them.
        let heldBytes = false;
        if (facts.before !== null) {
          for (const r of reg.records.values()) {
            for (const m of Object.values(r.blobs) as Array<Record<string, string>>) {
              const o = m[facts.path];
              if (o === undefined || o === 'ABSENT') continue;
              const b = await readBlob(ctx.git, ctx.peers[i]!.dir, o as Oid);
              if (b.equals(facts.before) || findMarkers(b).join() === findMarkers(facts.before).join() && findMarkers(b).length > 0) heldBytes = true;
            }
          }
        }
        const chain = reg.head === null ? [] : (await ctx.git.run(['rev-list', '--max-count=4', reg.head], { class: 'local', cwd: ctx.peers[i]!.dir })).stdout.toString('utf8').trim().split('\n');
        facts.afterKill = { disk, head: reg.head, heldBytes, chain };
      },
    },
    {
      probe: 'gc every clone and the remote', run: async (ctx) => {
        const step = ctx.opLog[ctx.opLog.length - 1]?.step ?? -1;
        for (const p of ctx.peers) {
          const r = await ctx.git.run(['gc', '--prune=now', '--quiet'], { class: 'local', cwd: p.dir });
          ctx.opLog.push({ step, peer: p.name, kind: 'gc_prune', detail: `rc=${r.code}` });
        }
        await ctx.git.run(['gc', '--prune=now', '--quiet'], { class: 'local', cwd: await currentRemoteDir(ctx) });
        for (const p of ctx.peers) facts.reach.push(await reachVerdict(ctx, p));
      },
    },
    restartStep(0, markers, facts), restartStep(1, markers, facts),   // the killed peer restarts (settleHoldOps, the writer's intent rollback) before any publish
    {
      probe: 'settled', run: async (ctx) => {
        const i = facts.peer;
        const reg = await readRegistry(ctx.git, ctx.peers[i]!.dir, 'main');
        facts.settled = { inflight: Object.keys(reg.local?.inflight ?? {}).length, disk: await readFile(join(ctx.peers[i]!.dir, ...facts.path.split('/'))).catch(() => null) };
      },
    },
    { rounds: 10 },
  ];
}

test('Review Focus 3: registry.cas killed after the CAS inside a resolve --park, an S6 markers park, a resolve --restore, a resolve --discard of an ON_DISK record, a collision take (resolve --publish on a collision) and an apply-side K4 displacement, and apply.group.phase1 / apply.group.phase2 killed inside the same operators\' writeLocal groups, each followed by git gc --prune=now: the operator\'s bytes are in a registry record before the disk changed, restart completes or undoes it by observation (settleMarkersParks, the writer\'s intent rollback) before the first publish, the registry is the old or the new commit, every record blob exists, and INV-NOLOSS holds at every step', { timeout: (FULL ? 300 : 30) * 60_000 }, async (t) => {
  // R3-55 and Ruling R3-51/55-A (a): npm test runs the first operator at the first kill point (registry.cas after the CAS of a resolve
  // --park; the three park points took 38 min of a loaded npm test), npm run test:sim all six operators at all three points.
  const cases = FULL ? OPERATORS.flatMap((op) => POINTS.map((point) => [op, point] as const)) : [[OPERATORS[0]!, POINTS[0]!] as const];
  for (const [op, point] of cases) {
    // Each subtest's own timeout (Node 24's --test-timeout of 10 min applies to every subtest; the parent's does not propagate).
    // npm test: 25 min, under the parent's 30; TEST_SIM_FULL: 45 min each (the markers park ran past 25 min on the loaded
    // reference PC), its 18 (6–15 min each there) under the parent's 300.
    await t.test(`${op} at ${point}`, { timeout: (FULL ? 45 : 25) * 60_000, ...skipUnless(`${op}@${point}`) }, async (st) => {
      const s = holdsSetup(`holds-rf3-${op}-${point.replace(/\./g, '-')}`, { script: [] });
      const kill = armedKill();
      const facts: Rf3Facts = { path: '', peer: 0, before: null, headBefore: null, killed: false, result: '', reach: [] };
      const steps = rf3Steps(op, point, s.markers, kill, facts);
      const obs = observing([...exitOracles(NS, { holds: { markers: s.markers } }), oracleState(), oracleReach()]);
      const restore = kill.install();
      let r: SimResult;
      try {
        r = await runSim({ ...s.tuple, ops: steps.length }, s.factory, obs.oracles, { ...s.options, crash: undefined, generator: play(steps, s.markers) });
      } finally {
        restore();
      }
      const fired = JSON.stringify(Object.fromEntries(obs.fired));
      await dropArtifacts(r);
      const known = KNOWN_DEFECTS.get(`${op}@${point}`);
      if (!r.ok && known !== undefined && r.failure?.oracle === known.oracle && known.message.test(r.failure.message)) st.todo(known.defect);
      assert.ok(r.ok || r.failure?.oracle === undefined, `${op} ${point}: ${JSON.stringify(r.failure)}`);
      assert.equal(facts.killed, true, `${op}: killed at ${point} (${facts.result}; ${facts.hits} hit(s) of ${point} while armed)`);
      const a = facts.afterKill!;
      // Record before displacement: the disk changed only if the registry already holds the operator's bytes.
      const diskChanged = facts.before !== null && (a.disk === null || !a.disk.equals(facts.before));
      assert.ok(!diskChanged || a.heldBytes, `${op} ${point}: the disk changed while no registry record holds its bytes`);
      // The registry is the old commit or a newer one on top of it (never a lost or rewritten one).
      assert.ok(a.head === facts.headBefore || (facts.headBefore === null ? a.head !== null : a.chain.includes(facts.headBefore)), `${op} ${point}: registry ${a.head} is neither the old ${facts.headBefore} nor on top of it`);
      // After gc --prune=now every object the state and the registry name exists (O-REACH), on every clone.
      assert.deepEqual(facts.reach, facts.reach.map(() => null), `${op} ${point}: ${JSON.stringify(facts.reach)}`);
      // The restart settled the interrupted operator by observation: no in-flight entry is left.
      assert.equal(facts.settled?.inflight, 0, `${op} ${point}: the restart settled every in-flight operator`);
      // INV-NOLOSS (and every other oracle, O-STATE and O-REACH) at every step.
      assert.deepEqual([...obs.fired.keys()], [], `${op} ${point}: ${fired}`);
    });
  }
});
