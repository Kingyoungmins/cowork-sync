// O-OFFDISK and O-LIVE-RECORD on runs and plants (Plan 3 Task 14; 11-testing §3.4 rows O-OFFDISK, O-LIVE-RECORD; X-05 holdcat/X2;
// INV-HLD-OFFDISK, INV-HLD-SINGLE; HLD-08, PRO-21; rulings R3-15, R3-67). Every run is real git against file:// bare remotes
// (holdsSetup's composition; git is never mocked). A plant is applied after a run's last real step inside a final probe (synthetic trace
// events, inspect() wrappers, scratch registry commits) and a fresh oracle's afterEveryOp is then invoked directly on that context, so a
// plant never disturbs a running engine. The runs themselves carry the eight oracles too. Fix round 1 (R3-55) split sim.oracles.holds by
// area; helpers in holdsOracleScript.ts.
//
// O-OFFDISK's third clause of the brief (testMask with and without the OFF_DISK records gives equal results) is dropped until claim-breach
// exists — controller ruling, Task 14 fix round 1 (finding 4): no Plan 3 OFF_DISK record masks anything in testMask, so the clause compared
// a test-side function with itself and could not fail; Plan 4 adds claim-breach and carries the clause. The (explain) and (gone) clauses
// are pinned below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Oid } from '../../src/git/oid.js';
import { REFS, SIM_TIMEOUT, okOrFail, type Step, scriptRun, engineAt, has, holdsOf, live } from '../helpers/holdsScript.js';
import { fresh, landedChange, STAGEABLE_NP, tick, untilPlanting } from '../helpers/holdsOracleScript.js';
import { holdsOp } from '../sim/generators.js';
import { advanceClocks } from '../sim/harness.js';
import { boardHolds, readStatus } from '../sim/holdsView.js';
import type { MarkerModel } from '../sim/markers.js';
import { emitAs, oracleLiveRecord, oracleOffDisk, peerIdOf, plantRegistry } from '../sim/oraclesHolds.js';

test('O-OFFDISK with holdcat X2 (conflict record residence): a K4 record born OFF_DISK on the publisher masks nothing, a later p0 edit of that path publishes within 2 loops after its human CS closes (20 s quiet), and a planted \'mask\' event that withholds a path covered only by an OFF_DISK record fails oracleOffDisk', { timeout: SIM_TIMEOUT }, async () => {
  const run = untilPlanting();
  let checked = false;
  let k4 = '';
  const steps = (markers: MarkerModel): Step[] => [
    { rounds: 1 },
    { kind: 'edit_same_line', peer: 0, params: { other: 1, row: 4 } },
    {
      probe: 'race', run: async (ctx) => {
        await tick(ctx, 0);
        await tick(ctx, 1);
        advanceClocks(ctx, 21_000);   // both human CSs quiet, neither captured yet
        // p1's push lands first; p0's, leased on the same tip, is lost and re-merged against p1's: TAKE_TIP on notes.txt (K4, publish side)
        await holdsOp({ kind: 'race_push', peer: 1, params: { other: 0 } }, markers).run(ctx);
        for (let n = 0; n < 4; n++) await tick(ctx, 0);
        const id0 = peerIdOf(ctx, 0);
        const births = ctx.trace.ofKind('hold').filter((e) => e.peer === id0 && e.rev === 1 && e.guards.includes('conflict') && e.paths.includes('notes.txt'));
        assert.equal(births.length, 1, `one K4 record on the publisher p0 (${JSON.stringify(births)})`);
        k4 = births[0]!.id;
        // HLD-08: the K4 local side is born OFF_DISK "once ENG- verified the TIP write (until then it is ON_DISK CONFLICTED)" — p0's next
        // permitted apply writes TIP over its local side
        for (let n = 0; n < 6 && (await holdsOf(ctx, 0)).find((r) => r.id === k4)!.residence !== 'OFF_DISK'; n++) await tick(ctx, 0);
        const k = (await holdsOf(ctx, 0)).find((r) => r.id === k4)!;
        assert.equal(k.residence, 'OFF_DISK', `the K4 record is OFF_DISK once p0 verified the TIP write (${k.state})`);
        const evs = ctx.trace.ofKind('hold').filter((e) => e.peer === id0 && e.id === k4);
        assert.ok(evs.every((e) => e.residence === 'OFF_DISK' || (e.residence === 'ON_DISK' && e.state === 'CONFLICTED')), 'ON_DISK only as CONFLICTED before the verified write');
      },
    },
    { kind: 'edit_band', peer: 0, params: { path: 'notes.txt', insert: false, row: 7, text: 'p0 note 7 later' } },
    {
      probe: 'later edit', run: async (ctx) => {
        const from = ctx.trace.events.length;
        await tick(ctx, 0);   // observed: the human CS opens
        const observed = ctx.clocks.get('p0')!.monoMs();
        let landed: { push: number; c: string } | null = null;
        for (let n = 0; n < 14 && landed === null; n++) {
          await tick(ctx, 0);
          landed = await landedChange(ctx, 0, 'notes.txt', from);
        }
        assert.ok(landed !== null, 'p0\'s later notes.txt edit published');
        const at = ctx.trace.monoAt(landed.push)!;
        assert.ok(at - observed <= 20_000 + 2 * 2_500, `within 2 loops after its CS closed (${at - observed} virtual ms after the edit was observed)`);
        const k = (await holdsOf(ctx, 0)).find((r) => r.id === k4)!;
        assert.ok(k.residence === 'OFF_DISK' || k.residence === null, 'the K4 record stayed OFF_DISK: it masked nothing');
      },
    },
    { rounds: 2 },
    {
      probe: 'plant', run: async (ctx) => {
        assert.equal(await fresh(oracleOffDisk, ctx), null, 'a fresh oracleOffDisk passes on the run as it is');
        run.plant();
        const id0 = peerIdOf(ctx, 0);
        const me = ctx.trace.ofKind('mask').filter((e) => e.peer === id0).pop()!;
        const ins = await engineAt(ctx, 0).inspect();
        assert.ok(ins.holds.some((r) => r.id === k4 && r.residence === 'OFF_DISK'), 'notes.txt is covered by the OFF_DISK K4 record');
        assert.ok(!ins.holds.some((r) => r.residence === 'ON_DISK' && r.paths.includes('notes.txt')), 'and by no ON_DISK record');
        emitAs(ctx, 0, { ...me, registry: ins.registryHead, withheld: [...me.withheld, 'notes.txt'].sort() });
        const msg = await fresh(oracleOffDisk, ctx);
        assert.ok(msg !== null && msg.includes('O-OFFDISK (explain) p0 notes.txt is withheld with no ON_DISK record'), `the planted mask event fails oracleOffDisk: ${msg}`);
        checked = true;
      },
    },
  ];
  okOrFail((await scriptRun('holds-offdisk-x2', steps, { oracles: run.oracles })).r);
  assert.ok(checked);
});

test('oracleOffDisk exempts a failed collision-take capture ending GONE and nothing else', { timeout: SIM_TIMEOUT }, async () => {
  const run = untilPlanting();
  let checked = false;
  let parked = '';
  const steps = (markers: MarkerModel): Step[] => [
    { rounds: 1 },
    // an ordinary OFF_DISK PARKED revert PATCH (the plant's subject)
    { kind: 'edit_band', peer: 1, params: { path: 'shared.txt', insert: true, row: 14, n: 1, text: 'p1-line' } },
    { rounds: 12 },
    { kind: 'stale_save', peer: 0, params: { path: 'shared.txt', buffer: 'genesis' } },
    { rounds: 12 },
    { kind: 'resolve', peer: 0, params: { verb: 'park' } },
    { rounds: 2 },
    {
      probe: 'parked', run: async (ctx) => {
        const r = (await holdsOf(ctx, 0)).find((x) => has(x, 'revert') && x.state === 'PARKED' && x.residence === 'OFF_DISK');
        assert.ok(r !== undefined, 'p0 holds an OFF_DISK PARKED revert PATCH');
        parked = r.id;
      },
    },
    // the collision take under a lock: its capture ends GONE (R3-67). A share-none holder refuses the take's staged read (no capture is made,
    // resolve answers locked); a share-read holder lets the capture read the file and refuses the write over it, so the capture ends GONE
    { kind: 'collide_ignored', peer: 0, params: { other: 1, name: 'c1.cfg' } },
    { rounds: 12 },
    { kind: 'lock_share_read', peer: 0, params: { path: 'local/c1.cfg' } },
    {
      probe: 'take', run: async (ctx) => {
        const col = live(await holdsOf(ctx, 0)).find((r) => has(r, 'collision') && r.paths.includes('local/c1.cfg'));
        assert.ok(col !== undefined, 'p0 holds the INCOMING collision record');
        return holdsOp({ kind: 'resolve', peer: 0, params: { id: col.id, verb: 'publish' } }, markers).run(ctx);
      },
    },
    { rounds: 6 },
    {
      probe: 'gone', run: async (ctx) => {
        const caps = (await holdsOf(ctx, 0)).filter((r) => r.kind === 'PATCH' && r.guards.length === 0 && r.paths.includes('local/c1.cfg'));
        assert.equal(caps.length, 1, `one collision-take capture (${JSON.stringify(caps.map((r) => [r.id, r.state]))})`);
        assert.equal(caps[0]!.state, 'GONE', 'the failed take\'s capture ended GONE');
        const id0 = peerIdOf(ctx, 0);
        const evs = ctx.trace.ofKind('hold').filter((e) => e.peer === id0 && e.id === caps[0]!.id);
        assert.ok(evs.some((e) => e.residence === 'OFF_DISK') && evs[evs.length - 1]!.state === 'GONE', 'it went GONE from OFF_DISK');
      },
    },
    { kind: 'unlock', peer: 0 },
    { rounds: 2 },
    {
      probe: 'plant', run: async (ctx) => {
        assert.equal(await fresh(oracleOffDisk, ctx), null, 'oracleOffDisk exempts the failed capture');
        run.plant();
        const rec = (await holdsOf(ctx, 0)).find((r) => r.id === parked)!;
        await plantRegistry(ctx, 0, parked, (r) => ({ ...r, rev: r.rev + 1, state: 'GONE', residence: null }));
        emitAs(ctx, 0, { kind: 'hold', peer: peerIdOf(ctx, 0), id: parked, holdKind: 'PATCH', guard: 'revert', guards: rec.guards.map((g) => g.name), paths: rec.paths, residence: null, state: 'GONE', rev: rec.rev + 1, localOnly: rec.local_only });
        const msg = await fresh(oracleOffDisk, ctx);
        assert.ok(msg !== null && msg.includes(`O-OFFDISK (gone) p0 record ${parked} [revert] went GONE from OFF_DISK PARKED`), `an ordinary parked record ending GONE fails it: ${msg}`);
        checked = true;
      },
    },
  ];
  okOrFail((await scriptRun('holds-offdisk-take', steps, { oracles: run.oracles })).r);
  assert.ok(checked);
});

test('O-LIVE-RECORD: p0\'s portability record mirrors as a stub without held/ and no oid, its dependency PIN names only LIVE paths; an inspect() wrapper reporting mirror[id].rejected = \'validator\' while status.json never shows HOLD_MIRROR_REJECTED fails oracleLiveRecord after p0\'s second iteration; a planted registry edit (a scratch registry commit flipping state) that disagrees with the landed fold fails the INV-HLD-SINGLE clause', { timeout: SIM_TIMEOUT }, async () => {
  const run = untilPlanting();
  let checked = false;
  let portId = '';
  let pinId = '';
  const steps: Step[] = [
    { rounds: 1 },
    { kind: 'nonportable_name', peer: 0, params: { name: STAGEABLE_NP } },
    { rounds: 14 },
    {
      probe: 'mirrored', run: async (ctx) => {
        const recs = live(await holdsOf(ctx, 0));
        const port = recs.find((r) => has(r, 'portability') && r.paths.includes(STAGEABLE_NP));
        const pin = recs.find((r) => r.kind === 'PIN' && r.guards.some((g) => g.name.startsWith('dependency:')));
        assert.ok(port !== undefined && port.local_only, 'p0 holds the local_only portability record');
        assert.ok(pin !== undefined, `p0 holds the dependency PIN (${JSON.stringify(recs.map((r) => [r.kind, r.guards.map((g) => g.name), r.paths]))})`);
        portId = port.id;
        pinId = pin.id;
        const board = (await ctx.git.run(['rev-parse', `${REFS.remoteBoard}^{commit}`], { class: 'local', cwd: ctx.remote.dir })).stdout.toString('utf8').trim();
        const { holds, held } = await boardHolds(ctx.git, ctx.peers[0]!.dir, board as Oid);   // p0 pushed it: its repo holds every object
        assert.equal(holds[portId]?.local_only, true, 'the portability op folded as a local_only stub');
        assert.deepEqual(held.get(portId) ?? [], [], 'with no held/ subtree (no oid)');
        assert.deepEqual(holds[pinId]?.paths, pin.paths, 'the PIN folded with its paths');
        assert.ok(pin.paths.every((p) => !p.includes(STAGEABLE_NP)), `the PIN names only LIVE paths (${JSON.stringify(pin.paths)})`);
        assert.ok((held.get(pinId) ?? []).every((e) => pin.paths.includes(e.path)), 'its held/ subtree names only those paths');
      },
    },
    { kind: 'nonportable_name', peer: 0, params: { fix: true } },
    ...Array.from({ length: 20 }, (): Step => ({ rounds: 1 })),
    {
      probe: 'plants', run: async (ctx) => {
        assert.equal(await fresh(oracleLiveRecord, ctx), null, 'a fresh oracleLiveRecord passes on the run as it is');
        run.plant();
        const p0 = engineAt(ctx, 0);
        const status = await readStatus(ctx.peers[0]!.dir);
        assert.equal(status?.state, 'ok', `p0 converged after the fix (status ${JSON.stringify(status?.pending)})`);
        // an inspect() wrapper: mirror[portId].rejected = 'validator', while status.json never shows HOLD_MIRROR_REJECTED
        const real = p0.inspect.bind(p0);
        p0.inspect = async () => {
          const x = await real();
          return { ...x, mirror: { ...x.mirror, [portId]: { durable: false, rejected: 'validator' } } };
        };
        const o = oracleLiveRecord();
        let msg: string | null;
        try {
          assert.equal(await o.afterEveryOp!(ctx), null, 'observed, not yet due');
          await tick(ctx, 0);
          assert.equal(await o.afterEveryOp!(ctx), null, 'one iteration: not yet due');
          await tick(ctx, 0);
          msg = await o.afterEveryOp!(ctx);
        } finally {
          delete (p0 as { inspect?: unknown }).inspect;
        }
        assert.ok(msg !== null && msg.includes(`O-LIVE-RECORD (rejected) p0 mirror of ${portId} rejected (validator)`), `fails after p0's second iteration: ${msg}`);
        // INV-HLD-SINGLE: a scratch registry commit flipping the PIN's state at its landed rev
        const pin = (await holdsOf(ctx, 0)).find((r) => r.id === pinId)!;
        const flipped = pin.state === 'GONE' ? 'SUBSUMED' : 'GONE';
        await plantRegistry(ctx, 0, pinId, (r) => ({ ...r, state: flipped, residence: null }));
        msg = await fresh(oracleLiveRecord, ctx);
        assert.ok(msg !== null && msg.includes(`O-LIVE-RECORD (single) p0 record ${pinId} rev ${pin.rev}: registry`), `the flipped registry disagrees with the landed fold: ${msg}`);
        checked = true;
      },
    },
  ];
  okOrFail((await scriptRun('holds-live-record', () => steps, { oracles: run.oracles })).r);
  assert.ok(checked);
});
