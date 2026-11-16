// The holds catalogue's ops against the real engine, Review Focus 1 and F-ED-4 (Plan 3 Task 13; 11-testing §3.5 F-ED-2, F-ED-4, F-ED-5,
// F-HLD-1; HLD-07, HLD-27…HLD-29, ENG-35, R3-10, R3-47; Review Focus 1). Each test is a scripted holds run (holdsSetup's composition, crash
// rate 0) on real git against file:// bare remotes; git is never mocked. Fix round 1 split the catalogue's tests by area so the files run
// in parallel (R3-55): sim.holds.ops.paths (F-PATH-1, DAT-29, the non-conforming writer), sim.holds.ops.locks (F-FS-1, S6) and
// sim.holds.ops.resolve (the mass-change breaker, generated?, Table 4, F-FS-4, F-FS-5); the shared helpers are test/helpers/holdsScript.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIM_TIMEOUT, okOrFail, type Step, scriptRun, engineAt, alone, has, holdsOf, live, liveTree, liveFile, rowsOf, disk, blobOf, opMarker, watch } from '../helpers/holdsScript.js';
import type { SimContext } from '../sim/harness.js';
import { readBlob, readRegistry } from '../sim/holdsView.js';
import { findMarkers, type MarkerModel } from '../sim/markers.js';

// ---- Review Focus 1 ------------------------------------------------------------------------------------------------------

test('Review Focus 1, four shapes on files where p0 also made untainted edits: edit_peer_line on fmt/m01.py, stale_save on shared.txt, stale_save hot_exit on fmt/m02.py and rewind on fmt/m03.py each give exactly one revert PATCH on p0 whose h1 is A with only the tainted hunk (computed test-side by row replacement), p0\'s untainted rows publish in the same window, and the teammate\'s rows are in live_code at every later step', { timeout: SIM_TIMEOUT }, async () => {
  const P1_ROW: Record<string, number> = { 'fmt/m01.py': 6, 'shared.txt': 30, 'fmt/m02.py': 6, 'fmt/m03.py': 6 };
  const teammate = new Map<string, string>();   // path → p1's marker, once landed
  let checked = false;
  const steps: Step[] = [
    { rounds: 1 },
    { kind: 'edit_own', peer: 0, params: { path: 'fmt/m03.py', row: 2, text: '    v3 = 3 p0 own' } },   // (rewind) p0's own row, published first
    { rounds: 12 },
    ...Object.entries(P1_ROW).map(([path, row]): Step => ({ kind: 'edit_band', peer: 1, params: { path, insert: true, row, n: 1, text: 'p1-line' } })),
    { rounds: 12 },
    {
      probe: 'landed', run: async (ctx) => {
        for (const [path, row] of Object.entries(P1_ROW)) {
          const rows = rowsOf((await liveFile(ctx, path))!);
          assert.ok(rows[row]!.startsWith('p1-line CWM_'), `${path}: p1's line landed at row ${row}`);
          teammate.set(path, findMarkers(Buffer.from(rows[row]!, 'latin1'))[0]!);
        }
      },
    },
    { kind: 'edit_peer_line', peer: 0, params: { path: 'fmt/m01.py' } },
    { kind: 'edit_own', peer: 0, params: { path: 'fmt/m01.py', row: 9, text: '    v9 = 9 p0 untainted' } },   // 3 rows from p1's line
    { kind: 'stale_save', peer: 0, params: { path: 'shared.txt', buffer: 'genesis' } },
    { kind: 'stale_save', peer: 0, params: { path: 'fmt/m02.py', buffer: 'genesis', variant: 'hot_exit' } },
    { kind: 'rewind', peer: 0, params: { path: 'fmt/m03.py', buffer: 12 } },   // step 13: the content of step 1 (p0's own row, before p1's line)
    { rounds: 12 },
    {
      probe: 'held', run: async (ctx) => {
        const recs = live(await holdsOf(ctx, 0));
        const lt = await liveTree(ctx);
        for (const path of Object.keys(P1_ROW)) {
          const rs = recs.filter((r) => has(r, 'revert') && r.paths.includes(path));
          assert.equal(rs.length, 1, `${path}: exactly one revert record on p0 (${JSON.stringify(recs.map((r) => [r.kind, r.guards.map((g) => g.name), r.paths]))})`);
          const r = rs[0]!;
          assert.equal(r.kind, 'PATCH');
          assert.equal(r.residence, 'ON_DISK');
          const blobs = r.blobs as { h0: Record<string, string>; h1: Record<string, string> };
          const h0 = rowsOf((await blobOf(ctx, 0, blobs.h0[path]))!);
          const h1 = rowsOf((await blobOf(ctx, 0, blobs.h1[path]))!);
          const row = P1_ROW[path]!;
          assert.ok(h0[row]!.includes(teammate.get(path)!), `${path}: h0 (A) holds p1's line`);
          const want = [...h0];
          if (path === 'fmt/m01.py') want[row] = rowsOf((await disk(ctx, 0, path))!)[row]!;   // the modified teammate line
          else want.splice(row, 1);                                                            // the removed teammate line
          assert.deepEqual(h1, want, `${path}: h1 = A with only the tainted hunk`);
          // p0's untainted rows are in the live code (published in the window that held the tainted hunk)
          const lc = rowsOf(await readBlob(ctx.git, ctx.remote.dir, lt.files.get(path)!.oid));
          assert.ok(lc.some((x) => x.includes(teammate.get(path)!)), `${path}: the teammate's line is live`);
          if (path === 'fmt/m01.py') assert.ok(lc[9]!.startsWith('    v9 = 9 p0 untainted CWM_'), `${path}: p0's own row 9 published (${lc[9]})`);
          else {
            const own = opMarker(ctx, path === 'fmt/m03.py' ? 'rewind' : 'stale_save', 'p0', path);
            assert.ok(lc.some((x) => x.includes(own)), `${path}: p0's own new row (${own}) published`);
            assert.ok(!h1.some((x) => x.includes(own)), `${path}: and it is not in h1`);
          }
        }
        checked = true;
      },
    },
  ];
  const teammateLive = watch('TEAMMATE_LIVE', () => teammate.size === 4, async (ctx) => {
    const lt = await liveTree(ctx);
    for (const [path, m] of teammate) {
      const e = lt.files.get(path);
      if (e === undefined || !(await readBlob(ctx.git, ctx.remote.dir, e.oid)).includes(m)) return `${path}: p1's ${m} left live_code`;
    }
    return null;
  });
  const { r } = await scriptRun('holds-rf1-shapes', () => steps, { oracles: [teammateLive] });
  okOrFail(r);
  assert.ok(checked);
});

test('Review Focus 1, attach and release: a second stale_save of shared.txt whose buffer is the first save\'s content (still without p1\'s rows) plus another untainted row creates no second record (no second \'hold\' creation event, same id), resolve --publish then ends the record RESOLVED_PUBLISH after the next landed push, live_code lacks p1\'s reverted rows (the reference model retired them as an informed removal), and five more materializing iterations of p0 (each after an untainted p0 edit) create no record over those rows', { timeout: SIM_TIMEOUT }, async () => {
  let rid: string | null = null;
  let p1m: string | null = null;
  let creationsAfterRelease = -1;
  const creations = (ctx: SimContext): Array<{ id: string }> => {
    const peer = engineAt(ctx, 0).peerId;
    return ctx.trace.ofKind('hold').filter((e) => e.peer === peer && e.rev === 1 && e.guards.includes('revert') && e.paths.includes('shared.txt'));
  };
  const make = (markers: MarkerModel): Step[] => [
    { rounds: 1 },
    { kind: 'edit_band', peer: 1, params: { path: 'shared.txt', insert: true, row: 30, n: 1, text: 'p1-line' } },
    { rounds: 12 },
    { kind: 'stale_save', peer: 0, params: { path: 'shared.txt', buffer: 'genesis' } },   // step 3
    { rounds: 12 },
    {
      probe: 'first', run: async (ctx) => {
        const c = creations(ctx);
        assert.equal(c.length, 1, 'one revert record');
        rid = c[0]!.id;
        p1m = findMarkers((await liveFile(ctx, 'shared.txt'))!).find((m) => m.endsWith('_p1')) ?? null;
        assert.ok(p1m !== null);
        return rid;
      },
    },
    { kind: 'stale_save', peer: 0, params: { path: 'shared.txt', buffer: 3 } },   // step 6: the first save's content (step 3) + another row
    { rounds: 12 },
    {
      probe: 'attached', run: async (ctx) => {
        assert.deepEqual(creations(ctx).map((e) => e.id), [rid], 'no second creation event: HLD-07 attached the change to the same id');
        const rs = live(await holdsOf(ctx, 0)).filter((r) => has(r, 'revert'));
        assert.deepEqual(rs.map((r) => r.id), [rid]);
      },
    },
    { kind: 'resolve', peer: 0, params: { verb: 'publish' } },
    { rounds: 12 },
    {
      probe: 'released', run: async (ctx) => {
        const r = (await holdsOf(ctx, 0)).find((x) => x.id === rid)!;
        assert.equal(r.state, 'RESOLVED_PUBLISH');
        assert.ok(!(await liveFile(ctx, 'shared.txt'))!.includes(p1m!), 'live_code lacks p1\'s reverted row');
        assert.ok(markers.retired().has(p1m!), 'the reference model retired p1\'s marker (an informed removal)');
        assert.ok(!markers.live().has(p1m!));
        creationsAfterRelease = creations(ctx).length;
      },
    },
    ...Array.from({ length: 5 }, (): Step[] => [{ kind: 'edit_band', peer: 0, params: { insert: false } }, { rounds: 6 }]).flat(),
    {
      probe: 'quiet', run: async (ctx) => {
        assert.equal(creations(ctx).length, creationsAfterRelease, 'no new record over p1\'s rows');
        const peer = engineAt(ctx, 0).peerId;
        assert.deepEqual(ctx.trace.ofKind('hold').filter((e) => e.peer === peer && e.rev === 1 && e.guards.includes('revert')).map((e) => e.id), [rid]);
        assert.ok(ctx.trace.ofKind('publish').filter((e) => e.peer === peer).length >= 5, 'the five untainted edits published');
      },
    },
  ];
  const { r } = await scriptRun('holds-rf1-attach', make);
  okOrFail(r);
  assert.ok(rid !== null && creationsAfterRelease === 1);
});

// ---- F-ED-4 ----------------------------------------------------------------------------------------------------------------

test('write_during_apply \'target\' between P1 and P2 of p0\'s apply of p1\'s shared.txt edit leaves p0\'s marker row in shared.txt at the end of the step and on p0\'s disk or in a p0 record at every later step; \'old_handle\' gives one OFF_DISK PARKED PATCH with no guard whose h1 holds the late marker by the next step', { timeout: SIM_TIMEOUT }, async () => {
  let target: string | null = null;
  let late: string | null = null;
  let checked = false;
  const steps: Step[] = [
    { rounds: 1 },
    { kind: 'edit_band', peer: 1, params: { insert: false } },
    ...alone(1, 12),
    { kind: 'write_during_apply', peer: 0, params: { path: 'shared.txt', variant: 'target' } },
    {
      probe: 'target', run: async (ctx) => {
        target = opMarker(ctx, 'write_during_apply', 'p0', 'shared.txt');
        assert.ok((await disk(ctx, 0, 'shared.txt'))!.includes(target), 'the marker row is in shared.txt at the end of the step');
      },
    },
    { rounds: 6 },
    { kind: 'edit_band', peer: 1, params: { insert: false } },
    ...alone(1, 12),
    { kind: 'write_during_apply', peer: 0, params: { path: 'shared.txt', variant: 'old_handle' } },
    { advance: 2_500 },
    { iterate: 0 },
    {
      probe: 'old_handle', run: async (ctx) => {
        late = opMarker(ctx, 'write_during_apply', 'p0', 'shared.txt');
        const parked = live(await holdsOf(ctx, 0)).filter((r) => r.kind === 'PATCH' && r.residence === 'OFF_DISK' && r.state === 'PARKED' && r.guards.length === 0);
        const holding: string[] = [];
        for (const r of parked) {
          const h1 = (r.blobs as { h1: Record<string, string> }).h1['shared.txt'];
          if ((await blobOf(ctx, 0, h1))?.includes(late)) holding.push(r.id);
        }
        assert.equal(holding.length, 1, `one guard-less OFF_DISK PARKED PATCH holds ${late}: ${JSON.stringify(parked.map((r) => r.id))}`);
        checked = true;
      },
    },
  ];
  const kept = watch('TARGET_KEPT', () => target !== null, async (ctx) => {
    if ((await disk(ctx, 0, 'shared.txt'))?.includes(target!)) return null;
    const reg = await readRegistry(ctx.git, ctx.peers[0]!.dir, 'main');
    for (const r of reg.records.values()) {
      for (const side of Object.values(r.blobs) as Array<Record<string, string>>) {
        for (const oid of Object.values(side)) if ((await blobOf(ctx, 0, oid))?.includes(target!)) return null;
      }
    }
    return `p0's ${target} is neither on its disk nor in a record`;
  });
  const { r } = await scriptRun('holds-write-during-apply', () => steps, { oracles: [kept] });
  okOrFail(r);
  assert.ok(checked && late !== null);
});
