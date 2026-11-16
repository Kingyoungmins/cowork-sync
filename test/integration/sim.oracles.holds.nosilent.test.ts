// INV-NOSILENT's status half on runs (Plan 3 Task 14; 11-testing §3.4 row INV-NOSILENT, T-06 (oracle); HLD-24; ruling R3-46). Every
// run is real git against file:// bare remotes (holdsSetup's composition; git is never mocked). Fix round 1 (R3-55) split
// sim.oracles.holds by area; helpers in holdsOracleScript.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIM_TIMEOUT, okOrFail, type Step, scriptRun } from '../helpers/holdsScript.js';
import { faultFsOf } from '../sim/engineAdapter.js';
import type { Oracle } from '../sim/harness.js';
import { readStatus } from '../sim/holdsView.js';
import { exitOracles } from '../sim/oracles.js';
import { holdsOracles, peerIdOf } from '../sim/oraclesHolds.js';

test('INV-NOSILENT status half: a revert record, a lock deferral, a not-applicable path and MASS each appear in status.json (counts, not_converged, freeze_reasons) by the peer\'s second iteration; with a FaultFs rule failing every rename of status.json with EPERM, oracleNoSilent fails at that peer\'s second iteration after the new revert record', { timeout: 2 * SIM_TIMEOUT }, async () => {
  let checked = 0;
  const shows = (what: string, check: (s: NonNullable<Awaited<ReturnType<typeof readStatus>>>) => boolean): Step => ({
    probe: what, run: async (ctx) => {
      const s = await readStatus(ctx.peers[0]!.dir);
      assert.ok(s !== null && check(s), `${what} in p0's status.json: ${JSON.stringify(s === null ? null : { state: s.state, pending: s.pending, freeze: s.freeze_reasons })}`);
      checked++;
    },
  });
  const steps: Step[] = [
    { rounds: 1 },
    { kind: 'edit_band', peer: 1, params: { path: 'shared.txt', insert: true, row: 14, n: 1, text: 'p1-line' } },
    { rounds: 12 },
    { kind: 'stale_save', peer: 0, params: { path: 'shared.txt', buffer: 'genesis' } },
    { rounds: 12 },
    shows('the revert record', (s) => s.pending.holds_active >= 1 && s.pending.not_converged.includes('shared.txt')),
    { kind: 'lock_share_read', peer: 0, params: { path: 'notes.txt' } },
    { kind: 'edit_band', peer: 1, params: { path: 'notes.txt', insert: false, row: 4, text: 'p1 note 4' } },
    { rounds: 12 },
    shows('the lock deferral', (s) => s.pending.incoming >= 1 && s.pending.not_converged.includes('notes.txt')),
    { kind: 'unlock', peer: 0 },
    { rounds: 6 },
    { kind: 'collide_ignored', peer: 0, params: { other: 1, name: 'c1.cfg' } },
    { rounds: 16 },
    shows('the not-applicable path', (s) => s.pending.not_converged.includes('local/c1.cfg')),
    { kind: 'formatter', peer: 0 },
    { rounds: 2 },
    shows('MASS', (s) => s.freeze_reasons.includes('MASS')),
    { kind: 'resume', peer: 0 },
    { rounds: 8 },
  ];
  okOrFail((await scriptRun('holds-nosilent', () => steps, { oracles: holdsOracles() })).r);
  assert.equal(checked, 4);
  // The status writer silenced: every rename of status.json fails EPERM (retried, then skipped); the next revert record never shows.
  let created: number | null = null;
  const rec: Oracle & { step: number | null } = {
    name: 'PREDICTED', step: null,
    async afterEveryOp(ctx) {
      if (created === null) {
        const id0 = peerIdOf(ctx, 0);
        if (ctx.trace.ofKind('hold').some((e) => e.peer === id0 && e.rev === 1 && e.guards.includes('revert'))) created = ctx.opLog[ctx.opLog.length - 1]!.step;
      }
      return null;
    },
  };
  const all = [...exitOracles(), ...holdsOracles()];
  const oracles = [rec, ...all.filter((o) => o.name !== 'INV-NOSILENT'), ...all.filter((o) => o.name === 'INV-NOSILENT')];
  const silenced: Step[] = [
    { rounds: 1 },
    { kind: 'edit_band', peer: 1, params: { path: 'shared.txt', insert: true, row: 14, n: 1, text: 'p1-line' } },
    { rounds: 12 },
    { probe: 'EPERM', run: async (ctx) => { faultFsOf(ctx.engines[0]!).addRule({ op: 'rename', pathIncludes: 'status.json', code: 'EPERM', times: 1_000_000 }); } },
    { kind: 'stale_save', peer: 0, params: { path: 'shared.txt', buffer: 'genesis' } },
    ...Array.from({ length: 16 }, (): Step => ({ iterate: 0 })),
  ];
  const r = (await scriptRun('holds-nosilent-eperm', () => silenced, { oracles })).r;
  assert.equal(r.ok, false, 'oracleNoSilent fails');
  assert.equal(r.failure!.oracle, 'INV-NOSILENT', JSON.stringify(r.failure));
  assert.ok(created !== null, 'the new revert record was created');
  assert.equal(r.failure!.step, created + 2, `at p0's second iteration after the record (created at step ${created}): ${r.failure!.message}`);
});
