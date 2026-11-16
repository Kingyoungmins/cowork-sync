// EF4 D2-2 (class noloss-restart-after-kill, seed meas-holds-29; ruling R3-EF4-10, with R3-EF4-9 for the lock): INV-NOLOSS's restart
// window against R-01's handover as EF2 fix round 1 F2 ratified it. A restart re-forms the open human CS; a ready pair's own path whose
// state:snap entry differs from A's and from the pair's R is handed to the first tick, which observes it only when it reads it clean
// (core.ts reformedAtTick). A path that tick did not read — a per-loop exclusion of 01-engine §3.8 step 2 (a future mtime: the stat must
// stay unchanged >= 300 ms Δmono) or step 4 (UNREADABLE under a share-none holder) — stays handed over until a tick reads it
// (restart.test.ts 'locked-at-first-tick' pins the engine side). Meanwhile the marker is "an undisplaced edit still on its author's disk"
// (glossary §21), but in no open CS yet, so INV-NOLOSS must keep the author's disk counted until a tick since the restart read the path —
// decided test-side (the file's mtime against p1's virtual wall clock and p1's iteration events; the FaultFs lock), never from the
// engine's flowInputs. The test itself asserts the engine facts as premises. Real git against file:// bare remotes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { RELEASE_NAMESPACE } from '../../src/engine/refs.js';
import { KilledAt, setCrashHandler } from '../../src/ports/crashpoint.js';
import { alone, disk, engineAt, liveFile, okOrFail, opMarker, play, SIM_TIMEOUT, until, type Step } from '../helpers/holdsScript.js';
import { faultFsOf } from '../sim/engineAdapter.js';
import { holdsSetup } from '../sim/generators.js';
import { runSim } from '../sim/harness.js';
import { locateMarker, oracleNoloss, type NolossFound } from '../sim/oracleNoloss.js';

const NS = RELEASE_NAMESPACE;
const P0_ROW = 'shared band 0 row 4 (04) p0';
const P1_ROW = 'shared band 1 row 6 (16) p1';

/** What the run's INV-NOLOSS saw at its check after the first post-restart iteration, per variant (the window that keeps p1's disk). */
const FIRST_TICK = {
  'future-mtime': /^author_disk p1:shared\.txt \(restarted, future mtime unread at every tick since \(R-01 handover\)\)$/,
  'locked-at-first-tick': /^author_disk p1:shared\.txt \(share-none lock, unreadable to its engine\)$/,
} as const;

for (const variant of ['future-mtime', 'locked-at-first-tick'] as const) {
  test(`D2-2 (${variant}): p1 edits shared.txt under a MASS freeze, applies p0's row after the resume (snap takes the edit, the join pair's R does not), is killed at its capture (snapshot.index_written) and restarts; its first tick cannot read shared.txt, so the edit is in no CS for one iteration — INV-NOLOSS keeps p1's disk counted (R3-EF4-10 / R3-EF4-9, test-side), the next tick re-forms it and it publishes`, { timeout: SIM_TIMEOUT }, async () => {
    let killed = 0;
    let restore: ((name: string) => void) | null = null;
    let release: (() => void) | null = null;
    let mk = '';
    const seen: Record<string, NolossFound | null | undefined> = {};
    let done = false;
    const s = holdsSetup(`holds-d22-${variant}`, { script: [] });
    const noloss = oracleNoloss(s.markers, NS);
    const steps = (): Step[] => [
      { iterate: 0 }, ...alone(0, 2),   // p0: genesis
      { iterate: 1 },                   // p1: join (its start step only)
      {
        probe: 'premise', run: async (ctx) => {
          // The handover needs an unpublished ready pair naming shared.txt at the restart. Seed 29's shape: the joiner's start capture
          // (in SIM its clone's files are quiet at the join tick, so M is every LIVE path: a no-op pair over all of them), kept unpublished
          // by a MASS freeze at its first iteration and the post-resume batch at its second. Asserted, so the scenario cannot pass vacuously.
          const ready = (await engineAt(ctx, 1).inspect()).ready;
          assert.ok(ready.some((r) => r.paths.includes('shared.txt')), `p1 holds a ready pair naming shared.txt: ${JSON.stringify(ready.map((r) => [r.csId, r.paths.length]))}`);
        },
      },
      { kind: 'edit_band', peer: 1, params: { insert: false, row: 16, text: P1_ROW } },   // the obligation under test
      { kind: 'formatter', peer: 1, params: {} },                                          // fmt/*.py: MASS at p1's first iteration
      { kind: 'edit_band', peer: 0, params: { insert: false, row: 4, text: P0_ROW } },
      ...alone(0, 12),
      { probe: 'p0 live', run: async (ctx) => assert.ok((await liveFile(ctx, 'shared.txt'))?.toString('latin1').includes(P0_ROW), 'p0 row is live') },
      ...alone(1, 1),                     // p1's first iteration: FREEZE(MASS), nothing applied or published
      { kind: 'resume', peer: 1, params: {} },
      ...alone(1, 1),   // observes the edit (open human CS) and applies p0's row: the writer rewrites shared.txt, ENG-36 takes the edit into snap
      {
        probe: 'applied, then arm', run: async (ctx) => {
          mk = opMarker(ctx, 'edit_band', 'p1', 'shared.txt');
          const d = (await disk(ctx, 1, 'shared.txt'))?.toString('latin1') ?? '';
          assert.ok(d.includes(P0_ROW) && d.includes(mk), 'p1\'s disk holds p0\'s applied row and its own uncaptured edit');
          const e = engineAt(ctx, 1);
          assert.ok(e.core.cs.openPaths().has('shared.txt'), 'the edit is in p1\'s open CS');
          const ready = (await e.inspect()).ready;
          assert.ok(ready.some((r) => r.paths.includes('shared.txt')), `the pair naming shared.txt is still unpublished: ${JSON.stringify(ready.map((r) => r.csId))}`);
          restore = setCrashHandler((name) => {
            if (name !== 'snapshot.index_written' || killed > 0) return;
            killed++;
            throw new KilledAt(name);
          });
        },
      },
      // The human CS's quiet period passes with no iteration of p1 (as in seed 29, where p0 next iterated 21 s later): its next iteration
      // is the capture, killed at its materialization — before any publish window could drop the no-op pair.
      { advance: 20_000 },
      until(1, 'p1 killed at its capture', async (ctx) => ctx.opLog.some((x) => x.kind === 'killed' && x.peer === 'p1'), 1),
      {
        probe: 'disarm and trigger', run: async (ctx) => {
          setCrashHandler(restore);
          restore = null;
          assert.equal(killed, 1);
          if (variant === 'future-mtime') {
            // An mtime ahead of p1's clock (01-engine §3.8 step 2): the first tick after the restart records it, the next one reads it.
            const t = new Date(ctx.clocks.get('p1')!.wallMs() + 3_600_000);
            await utimes(join(ctx.peers[1]!.dir, 'shared.txt'), t, t);
          } else {
            // EF4 r2 I2-6: an mtime well behind p1's virtual wall first, so §3.8 step 2 (a future mtime: in SIM the writer's real mtime is
            // ahead of SIM_WALL_EPOCH_MS) does not exclude the path before step 4 — the share-none lock must be what refuses the staged read.
            const past = new Date(ctx.clocks.get('p1')!.wallMs() - 3_600_000);
            await utimes(join(ctx.peers[1]!.dir, 'shared.txt'), past, past);
            // The spelling opLock locks: host separators under the engine's own work-tree root.
            release = faultFsOf(ctx.engines[1]!).holdLock(join(realpathSync.native(ctx.peers[1]!.dir), 'shared.txt'), 'share-none');
          }
        },
      },
      { advance: 2_500 }, { iterate: 1 },   // restart
      { probe: 'restarted', run: async (ctx) => assert.ok(ctx.opLog.some((x) => x.kind === 'start' && x.peer === 'p1' && x.detail.startsWith('restart')), 'p1 restarted') },
      { advance: 2_500 }, { iterate: 1 },   // the first iteration after the restart: shared.txt is excluded, the handover keeps it
      {
        probe: 'first tick', run: async (ctx) => {
          const e = engineAt(ctx, 1);
          // The engine facts the oracle must allow (premises, read here by the test, never by the oracle).
          assert.ok(!e.core.cs.openPaths().has('shared.txt'), 'not in an open CS yet');
          const ex = e.flowInputs().exclusions.find((x) => x.path === 'shared.txt');
          assert.ok(ex !== undefined, `the first tick excluded shared.txt: ${JSON.stringify(e.flowInputs().exclusions)}`);
          // EF4 r2 I2-6: each variant's own engine path — §3.8 step 2 (future mtime: 'quiet') or step 4 (the staged read refused: 'unreadable').
          assert.equal(ex.reason, variant === 'future-mtime' ? 'quiet' : 'unreadable', `the first tick's exclusion reason: ${JSON.stringify(ex)}`);
          seen.firstRun = noloss.locations(ctx).get(mk);
          seen.firstCold = await locateMarker(ctx, NS, mk, { peer: 'p1', path: 'shared.txt' }, {});
          if (release !== null) {
            release();
            release = null;
          }
        },
      },
      { advance: 2_500 }, { iterate: 1 },   // the first tick that reads shared.txt: clean (disk == snap), re-formed into the open CS
      {
        probe: 'second tick', run: async (ctx) => {
          assert.ok(engineAt(ctx, 1).core.cs.openPaths().has('shared.txt'), 'the next tick re-formed the edit into the open CS');
          seen.secondRun = noloss.locations(ctx).get(mk);
        },
      },
      ...alone(1, 16),
      {
        probe: 'published', run: async (ctx) => {
          assert.ok((await liveFile(ctx, 'shared.txt'))?.toString('latin1').includes(mk), 'p1\'s edit is live');
          done = true;
        },
      },
    ];
    try {
      const script = steps();
      const options = { ...s.options, generator: play(script, s.markers) };
      delete options.quiescence;
      okOrFail(await runSim({ ...s.tuple, ops: script.length }, s.factory, [noloss], options));
    } finally {
      if (restore !== null) setCrashHandler(restore);
      if (release !== null) (release as () => void)();
    }
    assert.ok(done);
    assert.match(seen.firstRun?.detail ?? '', FIRST_TICK[variant], JSON.stringify(seen.firstRun));
    assert.match(seen.secondRun?.detail ?? '', /^author_disk p1:shared\.txt \(open CS\)$/, JSON.stringify(seen.secondRun));
    if (variant === 'future-mtime') {
      // A cold locateMarker knows no restart: it answers from the engine's state alone (no open CS, no pair carries the bytes).
      assert.equal(seen.firstCold, null, `a cold search at the first tick finds the marker nowhere: ${JSON.stringify(seen.firstCold)}`);
    } else {
      // The lock is the harness's state now: a cold search counts the locked file too (R3-EF4-9 needs no history while the lock holds).
      assert.match(seen.firstCold?.detail ?? '', FIRST_TICK[variant], JSON.stringify(seen.firstCold));
    }
  });
}
