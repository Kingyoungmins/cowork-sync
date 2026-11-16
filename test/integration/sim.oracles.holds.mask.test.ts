// oracleMask's plants and the R3-53 / t0 scenario (Plan 3 Task 14; 11-testing §3.4 rows INV-MASK, O-ATOMIC-PUB; HLD-15, HLD-19, HLD-42;
// rulings R3-53, R3-63). Every run is real git against file:// bare remotes (holdsSetup's composition; git is never mocked). A plant is
// applied after a run's last real step inside a final probe (synthetic trace events naming crafted objects in a peer repo, inspect()
// wrappers) and a fresh oracle's afterEveryOp is then invoked directly on that context, so a plant never disturbs a running engine. The
// runs themselves carry the eight oracles too. Fix round 1 (R3-55) split sim.oracles.holds by area; helpers in holdsOracleScript.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TraceEvent } from '../../src/ports/trace.js';
import { SIM_TIMEOUT, okOrFail, type Step, scriptRun, engineAt, has, liveFile } from '../helpers/holdsScript.js';
import { CI, fresh, landedChange, lastOf, untilPlanting, withCi } from '../helpers/holdsOracleScript.js';
import { nfdName } from '../sim/generators.js';
import { readBlob, treeEntries } from '../sim/holdsView.js';
import { emitAs, oracleAtomicPub, oracleMask, peerIdOf, plantBlob, plantTree } from '../sim/oraclesHolds.js';

test('oracleMask fails on three plants and names the clause: an inspect() wrapper that swaps one sPub entry (peer, path, both oids), a synthetic \'compose\' event whose pTree changes .github/workflows/ci.yml against A, and a synthetic \'mask\' event whose sDisk differs from the re-application of an ON_DISK PATCH on a partial path', { timeout: SIM_TIMEOUT }, async () => {
  const run = untilPlanting();
  let checked = false;
  const steps: Step[] = [
    { rounds: 1 },
    { kind: 'edit_band', peer: 1, params: { path: 'shared.txt', insert: true, row: 14, n: 1, text: 'p1-line' } },
    { rounds: 12 },
    { kind: 'stale_save', peer: 0, params: { path: 'shared.txt', buffer: 'genesis' } },   // a revert PATCH over p1's row + an own row
    { rounds: 12 },
    {
      probe: 'plants', run: async (ctx) => {
        const p0 = engineAt(ctx, 0);
        const id0 = peerIdOf(ctx, 0);
        assert.equal(await fresh(oracleMask, ctx), null, 'a fresh oracleMask passes on the run as it is');
        run.plant();
        // (i) an inspect() wrapper that swaps one sPub entry of a path no record covers
        const ins = await p0.inspect();
        const was = ins.sPub!.get('fmt/m10.py')!;
        const swapped = await plantBlob(ctx, 0, Buffer.from('    planted = 1\n', 'utf8'));
        const real = p0.inspect.bind(p0);
        p0.inspect = async () => {
          const x = await real();
          const m = new Map(x.sPub!);
          m.set('fmt/m10.py', { ...was, oid: swapped });
          return { ...x, sPub: m };
        };
        let msg: string | null;
        try {
          msg = await fresh(oracleMask, ctx);
        } finally {
          delete (p0 as { inspect?: unknown }).inspect;
        }
        assert.ok(msg !== null && msg.includes(`INV-MASK (i) p0 fmt/m10.py: engine ${swapped} test ${was.oid}`), `clause (i) names peer, path and both oids: ${msg}`);
        // (compose-held) a synthetic compose event whose P changes the QUARANTINED ci.yml against A
        const ce = lastOf(ctx, 'compose', id0);
        const evil = await plantBlob(ctx, 0, Buffer.from('name: evil\n', 'utf8'));
        emitAs(ctx, 0, { ...ce, pTree: await plantTree(ctx, 0, ce.pTree, { [CI]: evil }) });
        msg = await fresh(oracleMask, ctx);
        assert.ok(msg !== null && msg.includes(`INV-MASK (compose-held) p0 ${CI} (QUARANTINED)`), `the class clause names ci.yml: ${msg}`);
        // (iv) a synthetic mask event whose S_disk carries one more row on the partial shared.txt than re-applying the PATCH to S_pub gives
        const me = lastOf(ctx, 'mask', id0);
        assert.ok(me.partial.includes('shared.txt'), `shared.txt is a step-5 path of p0's last mask event (${JSON.stringify(me.partial)})`);
        const sd = (await treeEntries(ctx.git, ctx.peers[0]!.dir, me.sDisk)).get('shared.txt')!;
        const more = await plantBlob(ctx, 0, Buffer.concat([await readBlob(ctx.git, ctx.peers[0]!.dir, sd.oid), Buffer.from('planted row\n', 'utf8')]));
        emitAs(ctx, 0, { ...me, sDisk: await plantTree(ctx, 0, me.sDisk, { 'shared.txt': more }) });
        msg = await fresh(oracleMask, ctx);
        assert.ok(msg !== null && msg.includes('INV-MASK (iv) p0 shared.txt: re-applying'), `the re-application clause names shared.txt: ${msg}`);
        checked = true;
      },
    },
  ];
  okOrFail((await scriptRun('holds-plant-mask', () => steps, { oracles: run.oracles, seedFiles: withCi('holds-plant-mask') })).r);
  assert.ok(checked);
});

/** p2's not-stageable host-table non-portable name (R3-53): the NFD spelling (Linux, Windows), a:b.txt on macOS (git precomposes there). */
const UNSTAGEABLE_NP = process.platform === 'darwin' ? 'a:b.txt' : nfdName(1);

test('oracleMask and oracleAtomicPub pass every step while p2\'s nonportable_name file waits and while a t0 PIN is released, and after the fix the group publishes', { timeout: SIM_TIMEOUT }, async () => {
  const run = untilPlanting();
  let checked = false;
  let failT0 = false;
  let pinId = '';
  let heldRegistry: string | null = null;
  const ok = 'np/ok-p2-1.txt';
  const steps: Step[] = [
    { rounds: 1 },
    { kind: 'nonportable_name', peer: 2, params: { name: UNSTAGEABLE_NP } },
    { rounds: 14 },
    {
      probe: 'waits', run: async (ctx) => {
        const id2 = peerIdOf(ctx, 2);
        const composes = ctx.trace.ofKind('compose').filter((e) => e.peer === id2);
        for (const ce of composes) {
          for (const g of ce.groups) if (g.paths.includes(ok)) assert.equal(g.ready, false, `the human group of ${ok} is not ready while the name waits`);
          assert.ok(!(await treeEntries(ctx.git, ctx.peers[2]!.dir, ce.pTree)).has(ok), 'P keeps A for it');
        }
        assert.equal(await liveFile(ctx, ok), null, `${ok} unpublished`);
      },
    },
    { kind: 'nonportable_name', peer: 2, params: { fix: true } },
    { rounds: 16 },
    {
      probe: 'fixed', run: async (ctx) => {
        assert.ok((await liveFile(ctx, ok)) !== null && (await liveFile(ctx, 'np/fixed-1.txt')) !== null, 'after the fix the group published');
        // K7: T0's region items fail for p0's next group until released (a scripted T0RegionsPort on p0's running engine)
        const deps = engineAt(ctx, 0).core.deps as { t0Regions: { check(...a: unknown[]): Promise<unknown> } };
        deps.t0Regions = { check: async (_r: unknown, _t: unknown, _o: unknown, paths: unknown) => (failT0 ? { pass: false, paths: [...(paths as string[])], item: 1 } : { pass: true }) };
        failT0 = true;
      },
    },
    { kind: 'edit_band', peer: 0, params: { path: 'shared.txt', insert: false, row: 5, text: 'p0 row 5 under t0' } },
    { rounds: 12 },
    {
      probe: 't0 PIN', run: async (ctx) => {
        const ins = await engineAt(ctx, 0).inspect();
        const pin = ins.holds.find((r) => r.kind === 'PIN' && has(r, 't0') && r.state === 'ACTIVE');
        assert.ok(pin !== undefined, `a t0 PIN holds p0's group (${JSON.stringify(ins.holds.map((r) => [r.kind, r.guards.map((g) => g.name), r.state]))})`);
        pinId = pin.id;
        heldRegistry = ins.registryHead;
        assert.ok(!(await liveFile(ctx, 'shared.txt'))!.toString('latin1').includes('p0 row 5 under t0'), 'not published while T0 fails');
        failT0 = false;   // T0 passes from now on
      },
    },
    { rounds: 8 },
    {
      probe: 'released', run: async (ctx) => {
        const id0 = peerIdOf(ctx, 0);
        assert.ok((await liveFile(ctx, 'shared.txt'))!.toString('latin1').includes('p0 row 5 under t0'), 'published after T0 passed');
        const l = await landedChange(ctx, 0, 'shared.txt');
        assert.ok(l !== null);
        const pubAt = ctx.trace.events.findIndex((e, k) => k < l.push && e.kind === 'publish' && e.peer === id0 && e.c === l.c);
        const ce = ctx.trace.events.slice(0, pubAt).filter((e): e is Extract<TraceEvent, { kind: 'compose' }> => e.kind === 'compose' && e.peer === id0).pop()!;
        assert.ok(ce.groups.every((g) => !g.pins.includes(pinId)), 'the recomposition\'s event shows no t0 PIN');
      },
    },
    {
      probe: 'plant', run: async (ctx) => {
        assert.equal(await fresh(oracleMask, ctx), null, 'a fresh oracleMask passes on the run as it is');
        assert.equal(await fresh(oracleAtomicPub, ctx), null, 'a fresh oracleAtomicPub passes on the run as it is');
        run.plant();
        // a synthetic compose event marking ready a group the registry (then) held under the guarded ON_DISK t0 PIN
        const id0 = peerIdOf(ctx, 0);
        const ce = ctx.trace.ofKind('compose').filter((e) => e.peer === id0 && e.groups.some((g) => g.paths.includes('shared.txt'))).pop()!;
        emitAs(ctx, 0, { ...ce, registry: heldRegistry, groups: ce.groups.map((g) => (g.paths.includes('shared.txt') ? { ...g, pins: [], ready: true } : g)) });
        const msg = await fresh(oracleMask, ctx);
        assert.ok(msg !== null && msg.includes('INV-MASK (compose-ready) p0 group') && msg.includes('a held PIN shares its closure'), `a ready group under a held PIN fails oracleMask: ${msg}`);
        checked = true;
      },
    },
  ];
  okOrFail((await scriptRun('holds-np-t0', () => steps, { oracles: run.oracles })).r);
  assert.ok(checked);
});
