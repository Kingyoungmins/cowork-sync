// O-AND and O-ATOMIC-PUB on runs and plants (Plan 3 Task 14; 11-testing §3.4 rows O-AND, O-ATOMIC-PUB; X-05 hold/exp_bc, atom/*;
// TC-DAT-06; INV-HLD-AND, INV-HLD-ATOMIC-PUB). Every run is real git against file:// bare remotes (holdsSetup's composition; git is never
// mocked). A plant is applied after a run's last real step inside a final probe (synthetic trace events naming crafted objects in a peer
// repo) into a fork of the run's trace (forkTrace) or the run's own, and a fresh oracle's afterEveryOp is then invoked directly on it, so a
// plant never disturbs a running engine. The runs themselves carry the eight oracles too. Fix round 1 (R3-55) split sim.oracles.holds by
// area; helpers in holdsOracleScript.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Oid } from '../../src/git/oid.js';
import type { TraceEvent } from '../../src/ports/trace.js';
import { SIM_TIMEOUT, okOrFail, type Step, scriptRun, engineAt, has, holdsOf, live, liveFile, disk, opMarker } from '../helpers/holdsScript.js';
import { FMT3, fresh, G3, g3Steps, landedChange, plantLanded, tick, untilPlanting } from '../helpers/holdsOracleScript.js';
import { holdsOp } from '../sim/generators.js';
import { advanceClocks, type Oracle, type SimContext } from '../sim/harness.js';
import { treeEntries } from '../sim/holdsView.js';
import type { MarkerModel } from '../sim/markers.js';
import { forkTrace, oracleAnd, oracleAtomicPub, peerIdOf, plantCommit, plantTree, saveAs } from '../sim/oraclesHolds.js';

/** The restore-marker block of a conflicted RESTORE (05 §3.4 item 4: -L cowork:disk -L cowork:base -L cowork:held) resolved to its held side. */
function takeHeld(bytes: Buffer): Buffer {
  const out: string[] = [];
  let mode: 'none' | 'disk' | 'base' | 'held' = 'none';
  for (const line of bytes.toString('latin1').split('\n')) {
    const t = line.replace(/\r$/, '');
    if (t.startsWith('<<<<<<< cowork:disk')) mode = 'disk';
    else if (t.startsWith('||||||| cowork:base')) mode = 'base';
    else if (t.startsWith('=======') && mode !== 'none') mode = 'held';
    else if (t.startsWith('>>>>>>> cowork:held')) mode = 'none';
    else if (mode === 'none' || mode === 'held') out.push(line);
  }
  return Buffer.from(out.join('\n'), 'latin1');
}

test('O-AND: synthetic \'compose\'/\'publish\'/\'push\' events naming a crafted commit that adds the held row of p0\'s ACTIVE revert PATCH fail oracleAnd; in SIM (hold/exp_bc guard composition) a record holding guards revert and markers keeps its rows out of every landed commit until both are released, and oracleAnd passes', { timeout: SIM_TIMEOUT }, async () => {
  const run = untilPlanting();
  let held: string | null = null;   // p0's edit_peer_line marker: the held row's
  let released = false;
  let checked = false;
  const keepOut: Oracle = {
    name: 'HELD_ROWS_OUT',
    async afterEveryOp(ctx) {
      if (held === null || released) return null;
      return (await liveFile(ctx, 'shared.txt'))!.includes(held) ? `p0's held row ${held} reached live_code before both guards were released` : null;
    },
  };
  let rid = '';
  let saved: { ce: Extract<TraceEvent, { kind: 'compose' }>; h1: string } | null = null;
  const steps = (markers: MarkerModel): Step[] => [
    { rounds: 1 },
    { kind: 'edit_band', peer: 1, params: { path: 'shared.txt', insert: true, row: 14, n: 1, text: 'p1-line' } },
    { rounds: 12 },
    { kind: 'edit_peer_line', peer: 0, params: { path: 'shared.txt' } },
    { kind: 'edit_band', peer: 0, params: { path: 'shared.txt', insert: false, row: 40, text: 'p0 untainted row' } },
    { rounds: 12 },
    {
      probe: 'revert', run: async (ctx) => {
        const recs = live(await holdsOf(ctx, 0)).filter((r) => has(r, 'revert') && r.paths.includes('shared.txt'));
        assert.equal(recs.length, 1, 'one revert PATCH on p0');
        rid = recs[0]!.id;
        held = opMarker(ctx, 'edit_peer_line', 'p0', 'shared.txt');
        const id0 = peerIdOf(ctx, 0);
        const ins = await engineAt(ctx, 0).inspect();
        saved = { ce: { ...ctx.trace.ofKind('compose').filter((e) => e.peer === id0).pop()!, registry: ins.registryHead }, h1: (recs[0]!.blobs as { h1: Record<string, string> }).h1['shared.txt']! };
      },
    },
    // hold/exp_bc: park, p1 changes its row, a conflicted RESTORE (guards revert + markers), resolve the markers, then --publish
    { kind: 'resolve', peer: 0, params: { verb: 'park' } },
    { rounds: 2 },
    { kind: 'edit_band', peer: 1, params: { path: 'shared.txt', insert: false, row: 14, text: 'p1-line v2' } },
    { rounds: 12 },
    { kind: 'resolve', peer: 0, params: { verb: 'restore' } },
    { rounds: 3 },
    {
      probe: 'both guards', run: async (ctx) => {
        const r = (await holdsOf(ctx, 0)).find((x) => x.id === rid)!;
        assert.deepEqual(r.guards.map((g) => g.name).sort(), ['markers', 'revert'], `the record holds revert and markers (${JSON.stringify(r.guards)})`);
        assert.equal(r.residence, 'ON_DISK');
        await saveAs(ctx, 0, 'shared.txt', takeHeld((await disk(ctx, 0, 'shared.txt'))!));   // the human resolves the markers, keeping the held side
      },
    },
    { rounds: 12 },   // the save materializes at its capture (20 s quiet), where the markers PREDICATE sees no marker row
    {
      probe: 'markers released', run: async (ctx) => {
        const r = (await holdsOf(ctx, 0)).find((x) => x.id === rid)!;
        assert.deepEqual(r.guards.map((g) => g.name), ['revert'], 'markers released, revert still holds');
      },
    },
    // Both guards released: from here the rows may publish. The human's marker resolution re-reverted p1's v2 row, so a second revert
    // record holds the disk's version; --publish re-bases the first record (CONFLICTED) on the disk, (A, S_disk), which is that second
    // record's change, so the same rev ends the second record GONE (one change, one id: HLD-07, INV-HLD-SINGLE) and the rows publish
    // (F2 #151). The oracles judge every landed commit either way.
    { probe: 'publish', run: async (ctx) => { released = true; return holdsOp({ kind: 'resolve', peer: 0, params: { id: rid, verb: 'publish' } }, markers).run(ctx); } },
    { rounds: 12 },
    {
      probe: 'plant', run: async (ctx) => {
        // (plant) a crafted commit adding the held row while the record was ACTIVE: TIP's tree with shared.txt = the record's h1 (A == H0
        // then: H1' = H1), with the compose event of that time (its registry holds the ACTIVE record)
        assert.equal(await fresh(oracleAnd, ctx), null, 'a fresh oracleAnd passes on the run as it is');
        run.plant();
        const { ce, h1 } = saved!;
        const tree = await plantTree(ctx, 0, ce.tip, { 'shared.txt': h1 as Oid });
        const c = await plantCommit(ctx, 0, tree, [ce.tip as Oid], 'planted', []);
        plantLanded(ctx, 0, ce, c, tree);
        const msg = await fresh(oracleAnd, ctx);
        assert.ok(msg !== null && msg.includes(`O-AND (rows) p0 commit ${c} on shared.txt carries ${rid}'s held rows`), `the crafted commit fails oracleAnd: ${msg}`);
        checked = true;
      },
    },
  ];
  okOrFail((await scriptRun('holds-oand', steps, { oracles: [...run.oracles, keepOut] })).r);
  assert.ok(checked);
});

test('O-ATOMIC-PUB on atom x-series shapes: a 3-file human CS publishes in one live commit; a K4 TAKE_TIP on 1 of 3 paths publishes the other 2 in that CS (exception (c), TC-DAT-06); a planted commit carrying 2 of a 3-path composable group fails oracleAtomicPub', { timeout: SIM_TIMEOUT }, async (t) => {
  const run = untilPlanting();
  let checked = false;
  let three: { c: string; push: number } | null = null;
  const verdicts: Record<string, string | null> = {};
  const steps = (markers: MarkerModel): Step[] => [
    ...g3Steps(),
    {
      probe: 'one commit', run: async (ctx) => {
        const l = await landedChange(ctx, 1, 'g/a.txt');
        assert.ok(l !== null, 'p1 published g/*');
        const changed = (await ctx.git.run(['diff-tree', '--no-commit-id', '-r', '--name-only', '-z', `${l.c}^`, l.c], { class: 'local', cwd: ctx.peers[1]!.dir })).stdout.toString('utf8').split('\0').filter((x) => x.length > 0);
        assert.deepEqual(changed.filter((p) => p.startsWith('g/')).sort(), G3, 'the 3-file human CS is one live commit');
        three = l;
      },
    },
    // p0 edits three pre-genesis files in one human CS (pre-genesis rows: no revert, R3-37), p1 the same row of fmt/m02.py; p1's push wins
    // the race. p0's lost push is re-merged against p1's row at its next iteration: the conflict function takes TIP's fmt/m02.py (K4
    // TAKE_TIP, a conflict record on p0) and p0's CS publishes the other two paths in its commit. (A publish-side TAKE_TIP — the publish
    // event's `conflicted`, exception (c) proper — needs the CAS re-merge inside one publish; in scripted runs the engine takes TIP at the
    // next apply first. Exception (c) itself is pinned by the deterministic plant below.)
    ...FMT3.map((path): Step => ({ kind: 'edit_own', peer: 0, params: { path, row: 5, text: `    p0 changed ${path}` } })),
    { kind: 'edit_own', peer: 1, params: { path: 'fmt/m02.py', row: 5, text: '    p1 changed fmt/m02.py' } },
    {
      probe: 'race', run: async (ctx) => {
        const id0 = peerIdOf(ctx, 0);
        await tick(ctx, 0);
        await tick(ctx, 1);
        advanceClocks(ctx, 21_000);
        await holdsOp({ kind: 'race_push', peer: 1, params: { other: 0 } }, markers).run(ctx);
        for (let n = 0; n < 6; n++) await tick(ctx, 0);
        const k4 = ctx.trace.ofKind('hold').filter((e) => e.peer === id0 && e.guards.includes('conflict') && e.paths.includes('fmt/m02.py'));
        assert.ok(k4.length > 0, 'a K4 conflict record on p0 holds fmt/m02.py (TAKE_TIP)');
        const l = await landedChange(ctx, 0, 'fmt/m01.py');
        assert.ok(l !== null, 'p0 published its CS');
        const changed = (await ctx.git.run(['diff-tree', '--no-commit-id', '-r', '--name-only', '-z', `${l.c}^`, l.c], { class: 'local', cwd: ctx.peers[0]!.dir })).stdout.toString('utf8').split('\0').filter((x) => x.length > 0);
        assert.deepEqual(changed.filter((p) => FMT3.includes(p)).sort(), ['fmt/m01.py', 'fmt/m03.py'], 'the other two paths of the CS publish in one commit');
        assert.ok((await liveFile(ctx, 'fmt/m02.py'))!.toString('latin1').includes('p1 changed'), 'fmt/m02.py keeps TIP');
      },
    },
    { rounds: 4 },
    {
      probe: 'plant', run: async (ctx) => {
        verdicts['the run as it is'] = await fresh(oracleAtomicPub, ctx);
        run.plant();
        // A copy of p1's composition of the 3-file CS, and a crafted commit on its parent carrying g/a.txt and g/b.txt of P with g/c.txt
        // left at the parent (R[g/c.txt] != A_cap[g/c.txt]: a new file of the composable group)
        const id1 = peerIdOf(ctx, 1);
        const pubAt = ctx.trace.events.findIndex((e) => e.kind === 'publish' && e.peer === id1 && e.c === three!.c);
        const ce = ctx.trace.events.slice(0, pubAt).filter((e): e is Extract<TraceEvent, { kind: 'compose' }> => e.kind === 'compose' && e.peer === id1).pop()!;
        const info = await ctx.git.run(['log', '-1', '--format=%B', three!.c], { class: 'local', cwd: ctx.peers[1]!.dir });
        const trailers = info.stdout.toString('utf8').split('\n').filter((l) => /^[A-Za-z-]+: /.test(l)).map((l) => ({ key: l.slice(0, l.indexOf(':')), value: l.slice(l.indexOf(':') + 2) }));
        const P = await treeEntries(ctx.git, ctx.peers[1]!.dir, ce.pTree);
        const parent = (await ctx.git.run(['rev-parse', `${three!.c}^`], { class: 'local', cwd: ctx.peers[1]!.dir })).stdout.toString('utf8').trim();
        const tree = await plantTree(ctx, 1, parent, { 'g/a.txt': P.get('g/a.txt')!.oid, 'g/b.txt': P.get('g/b.txt')!.oid });
        const c = await plantCommit(ctx, 1, tree, [parent as Oid], 'planted', trailers);
        // exception (c), TC-DAT-06: the publish event lists g/c.txt in `conflicted` (K4 TAKE_TIP at the publish): the split is allowed
        let p: SimContext = forkTrace(ctx);
        plantLanded(p, 1, ce, c, tree, ['g/c.txt']);
        verdicts['2 of 3, g/c.txt TAKE_TIP'] = await fresh(oracleAtomicPub, p);
        // the same commit without it: a split publication group
        p = forkTrace(ctx);
        plantLanded(p, 1, ce, c, tree);
        verdicts['2 of 3'] = await fresh(oracleAtomicPub, p);
        verdicts['commit'] = c;
        checked = true;
      },
    },
  ];
  okOrFail((await scriptRun('holds-atomic', steps, { oracles: run.oracles })).r);
  assert.ok(checked);
  t.diagnostic(JSON.stringify(verdicts, null, 1));
  assert.equal(verdicts['the run as it is'], null, 'a fresh oracleAtomicPub passes on the run as it is');
  assert.equal(verdicts['2 of 3, g/c.txt TAKE_TIP'], null, 'exception (c): a path in the publish event\'s conflicted list may stay at its parent');
  const v = verdicts['2 of 3'];
  assert.ok(v !== null && v !== undefined && v.includes(`O-ATOMIC-PUB (split) p1 commit ${verdicts['commit']} leaves g/c.txt of composable`), `the planted 2-of-3 commit fails oracleAtomicPub: ${v}`);
});
