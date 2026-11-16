// E16-E (Plan 3 exit carry; 05-holds HLD-17, HLD-26 (b), §3.4 item 4; contract "every Plan 3 disk write … no unobserved delta, in
// this run or after a restart"): a daemon restart between a conflicted --restore and the record's park or `markers` release.
// The restore's write is an observed change (HLD-17, HLD-26 (b), HLD-29) and makes no snap transition (HLD-57 (e)); ObservedWrites is in
// memory, so without the restore's own bookkeeping in local.json the restart's reseed from state:snap made the first materialization of p
// judge diff(snap[p], disk) as an unobserved delta: D2 made a second `revert` record whose H1 carried the restore's `cowork:` marker
// rows, not local_only, and ENG-41 (j) then aborted every publish window of the peer (NOT_CONVERGED publish_assert:j) — its outbox
// (HOLD_REVERT_HELD among it) never drained. No kill inside an operator is needed: any process exit in that window did it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Oid } from '../../src/git/oid.js';
import { hasRestoreMarkerRow } from '../../src/data/rows.js';
import { KilledAt } from '../../src/ports/crashpoint.js';
import { has, logCodes, play, type Step } from '../helpers/holdsScript.js';
import { dropArtifacts } from '../helpers/simOps.js';
import { killableCall, realEngineOf } from '../sim/engineAdapter.js';
import { holdsSetup } from '../sim/generators.js';
import { advanceClocks, runSim, type SimContext } from '../sim/harness.js';
import { readBlob, readRegistry } from '../sim/holdsView.js';

const P = 'own/e16e-p0.txt';

/** Every record of peer i (any state) that is not local_only and has a held-side blob carrying a restore-marker row. */
async function markerHeldRecords(ctx: SimContext, i: number): Promise<string[]> {
  const reg = await readRegistry(ctx.git, ctx.peers[i]!.dir, 'main');
  const out: string[] = [];
  for (const r of reg.records.values()) {
    if (r.local_only) continue;
    for (const [stage, m] of Object.entries(r.blobs) as Array<[string, Record<string, string>]>) {
      for (const [p, o] of Object.entries(m)) {
        if (o === 'ABSENT') continue;
        if (hasRestoreMarkerRow(await readBlob(ctx.git, ctx.peers[i]!.dir, o as Oid))) out.push(`${r.id} rev ${r.rev} ${r.state} ${stage}:${p}`);
      }
    }
  }
  return out;
}

/** p0 alone, n iterations 2.5 s apart. */
async function p0Iterations(ctx: SimContext, n: number): Promise<void> {
  for (let k = 0; k < n; k++) {
    advanceClocks(ctx, 2_500);
    await ctx.engines[0]!.step(ctx);
    await ctx.scheduler.runUntilIdle(10_000);
  }
}

for (const after of ['rounds', 's6'] as const) {
  test(`E16-E: a restart after a conflicted --restore (markers on disk), then ${after === 's6' ? '24 h (S6\'s markers park)' : 'ordinary rounds'}: no non-local_only record holds a restore-marker row, no publish window aborts on ENG-41 (j), and p0's outbox drains`, { timeout: 20 * 60_000 }, async () => {
    const s = holdsSetup(`e16e-restart-${after}`, { script: [] });
    const facts: { killed?: boolean; restartMode?: string; held: string[]; j: number; outbox: number; drafts: string } = { held: [], j: 0, outbox: -1, drafts: '' };
    const isRevert = (r: { guards: Array<{ name: string }>; paths: string[] }): boolean => r.guards.some((g) => g.name === 'revert') && r.paths.includes(P);
    const steps: Step[] = [
      // hold/exp_bc (as Review Focus 3's markers-park): park, p1 changes its row, a conflicted RESTORE (guards revert + markers, ON_DISK).
      { rounds: 2 }, { kind: 'new_file', peer: 1, params: { path: P, rows: 4 } }, { rounds: 14 }, { kind: 'edit_peer_line', peer: 0, params: { path: P } }, { rounds: 12 },
      { kind: 'resolve', peer: 0, params: { verb: 'park' } }, { rounds: 2 },
      { kind: 'edit_own', peer: 1, params: { path: P, row: 4, text: 'p1 row v2' } }, { rounds: 12 },
      { kind: 'resolve', peer: 0, params: { verb: 'restore' } }, { rounds: 8 },
      {
        probe: 'markers', run: async (ctx) => {
          const e = realEngineOf(ctx.engines[0]!)!;
          const r = (await e.inspect()).holds.find((x) => isRevert(x) && x.residence === 'ON_DISK');
          assert.ok(r !== undefined && has(r, 'markers'), `revert + markers ON_DISK: ${JSON.stringify(r?.guards)}`);
        },
      },
      {
        // The daemon process exits between two iterations (no operator in flight): the next step is its restart.
        probe: 'p0 exits', run: async (ctx) => {
          const out = await killableCall(ctx.engines[0]!, ctx, async () => { throw new KilledAt('test.exit_after_restore'); });
          facts.killed = out !== null && 'killed' in out;
          return String(facts.killed);
        },
      },
      { iterate: 0 },   // the restart
      ...(after === 's6' ? [{ kind: 'age_24h', peer: 0 } as Step] : []),
      { probe: 'p0 iterations', run: async (ctx) => { await p0Iterations(ctx, 6); } },
      { rounds: 12 },
      {
        probe: 'check', run: async (ctx) => {
          facts.restartMode = ctx.opLog.filter((x) => x.kind === 'start' && x.peer === 'p0').map((x) => x.detail).join('; ');
          facts.held = await markerHeldRecords(ctx, 0);
          facts.j = (await logCodes(ctx, 0)).filter((l) => l.code === 'NOT_CONVERGED' && l.params['cause'] === 'publish_assert' && l.params['check'] === 'j').length;
          const core = realEngineOf(ctx.engines[0]!)!.core;
          facts.outbox = core.outbox.size;
          facts.drafts = JSON.stringify(core.outbox.drafts().map((d) => ('hold_id' in d ? `hold ${String(d.hold_id)} ${String(d.state)}` : `${d.type} ${'reason_code' in d ? String(d.reason_code) : ''}`)));
        },
      },
    ];
    const r = await runSim({ ...s.tuple, ops: steps.length }, s.factory, [], { ...s.options, generator: play(steps, s.markers), quiescence: undefined });
    const failure = JSON.stringify(r.failure);
    if (r.ok) await dropArtifacts(r);
    assert.ok(r.ok, `${failure}; artifacts ${String(r.artifactsDir)}`);
    assert.equal(facts.killed, true, 'p0 exited between iterations');
    assert.match(facts.restartMode ?? '', /restart/, 'p0 restarted');
    assert.deepEqual(facts.held, [], `no non-local_only record holds a restore-marker row (05 §3.4 item 4, INV-SECRET): ${JSON.stringify(facts)}`);
    assert.equal(facts.j, 0, `no publish window aborted on ENG-41 (j): ${JSON.stringify(facts)}`);
    assert.equal(facts.outbox, 0, `p0's outbox drained: ${facts.drafts}`);
  });
}
