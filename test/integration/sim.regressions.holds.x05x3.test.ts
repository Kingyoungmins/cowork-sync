// X-05 holdcat/X3 with every Task 14 oracle on (Plan 3 Task 14; 11-testing X-05). A scripted holds run (holdsSetup's composition, crash
// rate 0) on real git against file:// bare remotes, the eight oracles of Task 14 judging every step. Fix round 1 (R3-55) gave each X-05
// scenario its own file (.x05f, this one and .x05x8b) so run-tests.mjs runs them in parallel; the helpers are in
// test/helpers/holdsOracleScript.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIM_TIMEOUT, okOrFail, type Step, scriptRun, has, holdsOf, live, liveFile, disk, opMarker } from '../helpers/holdsScript.js';
import { X05 } from '../helpers/holdsOracleScript.js';
import { holdsOp } from '../sim/generators.js';
import type { Oracle, SimContext } from '../sim/harness.js';
import type { MarkerModel } from '../sim/markers.js';
import { holdsOracles, saveAs } from '../sim/oraclesHolds.js';

/** An afterEveryOp watch that fails once `armed()` and `bad(ctx)` names something. */
const watchFor = (name: string, armed: () => boolean, bad: (ctx: SimContext) => Promise<string | null>): Oracle => ({ name, afterEveryOp: async (ctx) => (armed() ? bad(ctx) : null) });

const NL = String.fromCharCode(10);

test(`${X05} [holdcat/X3]`, { timeout: SIM_TIMEOUT }, async () => {
  let y: string | null = null;
  let deleted = false;
  let checked = false;
  const neverLive = watchFor('X3_NEVER_LIVE', () => deleted, async (ctx) => ((await liveFile(ctx, 'shared.txt'))!.includes(y!) ? `p1's deleted row ${y} is back in live_code` : null));
  const steps = (markers: MarkerModel): Step[] => [
    { rounds: 1 },
    { kind: 'edit_band', peer: 1, params: { path: 'shared.txt', insert: true, row: 30, n: 1, text: 'p1-line' } },
    { rounds: 12 },
    // a catalogue op that finds nothing to do still refreshes every peer's buffer ring: p0's content with p1's row is now in it
    { kind: 'unlock', peer: 0 },
    {
      probe: 'p1 deletes its row', run: async (ctx) => {
        y = opMarker(ctx, 'edit_band', 'p1', 'shared.txt');
        const b = (await disk(ctx, 1, 'shared.txt'))!.toString('latin1').split(NL);
        b.splice(b.findIndex((r) => r.includes(y!)), 1);
        await saveAs(ctx, 1, 'shared.txt', Buffer.from(b.join(NL), 'latin1'));
      },
    },
    { rounds: 12 },
    {
      probe: 'deleted', run: async (ctx) => {
        assert.ok(!(await liveFile(ctx, 'shared.txt'))!.includes(y!), 'the deletion published');
        assert.ok(!(await disk(ctx, 0, 'shared.txt'))!.includes(y!), 'p0 applied the deletion');
        deleted = true;
      },
    },
    // p0's stale buffer: the oldest ring entry holding p1's row (its disk before it applied the deletion), plus one own row
    { probe: 'stale re-add', run: async (ctx) => holdsOp({ kind: 'stale_save', peer: 0, params: { path: 'shared.txt', buffer: `after:${y!}` } }, markers).run(ctx) },
    { rounds: 12 },
    {
      probe: 'held', run: async (ctx) => {
        const recs = live(await holdsOf(ctx, 0)).filter((r) => has(r, 'revert') && r.paths.includes('shared.txt'));
        assert.equal(recs.length, 1, 'the stale re-add on p0 became one revert PATCH');
        assert.ok((await disk(ctx, 0, 'shared.txt'))!.includes(y!), 'the disk of p0 has the re-added row');
        checked = true;
      },
    },
    { rounds: 6 },
  ];
  okOrFail((await scriptRun('holds-x05-x3', steps, { oracles: [...holdsOracles(), neverLive] })).r);
  assert.ok(checked);
});
