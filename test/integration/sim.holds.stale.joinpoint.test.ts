// EF4 round 2, class noloss-stale-save-published (seeds meas-holds-26 at 65, meas-holds-70 at 67; ruling R3-EF4-19): the holds
// generator's stale_save (and rewind, which shares staleBuffers) must not draw a buffer whose removal of a teammate's row the engine
// leaves unprotected by ruling. R3-59: a joiner's provenance journal starts empty at its join point (the live code of the oldest
// state-reflog entry's laB, TIP at a join), so a row that was already on the live chain when the peer joined — written onto its disk by
// the join's first apply — is not in its journal, and HLD-27 taints nothing when the peer's pre-join editor buffer is saved over it; the
// save publishes as an ordinary human CS and INV-NOLOSS (R3-48: a stale save is never an informed retirement) fails. R3-47 says
// stale_save creates `revert` records, so its eligibility excludes such a buffer. A row the teammate adds after the join stays eligible
// and is held. The product gap stays recorded (carry J-PROV: journal the join apply's (L_b, TIP] range), not hidden: the second test
// pins it as a known-failing todo (F1 audit fix #9).
// Scripted holds run (holdsSetup's composition, crash rate 0) on real git against file:// bare remotes; git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIM_TIMEOUT, okOrFail, type Step, scriptRun, alone, has, holdsOf, live, liveFile, disk, watch } from '../helpers/holdsScript.js';
import type { SimContext } from '../sim/harness.js';
import { findMarkers } from '../sim/markers.js';

const lastOp = (ctx: SimContext, kind: string, peer: string): string => {
  const e = [...ctx.opLog].reverse().find((x) => x.kind === kind && x.peer === peer);
  assert.ok(e !== undefined, `no ${kind} by ${peer}`);
  return e.detail;
};

test('stale_save on a late joiner: a teammate row already live at the join (no journal entry, R3-59) makes the pre-join buffer ineligible; a row added after the join is still drawn and held as a revert record, and both rows stay live', { timeout: SIM_TIMEOUT }, async () => {
  let pre: string | null = null;
  let post: string | null = null;
  const steps: Step[] = [
    ...alone(1, 2),                                                                                   // p1: genesis
    { kind: 'edit_band', peer: 1, params: { path: 'shared.txt', insert: true, row: 14, n: 1, text: 'p1-pre-join' } },   // the rings record p0's seed shared.txt
    ...alone(1, 12),                                                                                  // p1 publishes
    {
      probe: 'pre live', run: async (ctx) => {
        pre = findMarkers((await liveFile(ctx, 'shared.txt'))!).find((m) => m.endsWith('_p1')) ?? null;
        assert.ok(pre !== null, 'p1\'s pre-join row is live before p0 joins');
        return pre;
      },
    },
    ...alone(0, 4),                                                                                   // p0: join (its first apply writes p1's row)
    {
      probe: 'joined', run: async (ctx) => {
        assert.ok((await disk(ctx, 0, 'shared.txt'))!.includes(pre!), 'the join applied p1\'s row onto p0\'s disk');
      },
    },
    { kind: 'stale_save', peer: 0, params: { path: 'shared.txt' } },                                  // eligibility, no explicit buffer
    {
      probe: 'pre-join buffer not drawn', run: async (ctx) => {
        const d = lastOp(ctx, 'stale_save', 'p0');
        assert.match(d, /skipped \(no eligible earlier buffer/, `p0's only buffer without p1's row predates its join point: ${d}`);
      },
    },
    { kind: 'edit_band', peer: 1, params: { path: 'shared.txt', insert: true, row: 40, n: 1, text: 'p1-post-join' } },
    ...alone(1, 12),
    ...alone(0, 4),                                                                                   // p0 applies the post-join row
    {
      probe: 'post applied', run: async (ctx) => {
        post = findMarkers((await liveFile(ctx, 'shared.txt'))!).find((m) => m.endsWith('_p1') && m !== pre) ?? null;
        assert.ok(post !== null && (await disk(ctx, 0, 'shared.txt'))!.includes(post), 'p1\'s post-join row is live and on p0\'s disk');
      },
    },
    { kind: 'stale_save', peer: 0, params: { path: 'shared.txt' } },                                  // draws the post-join-only gap
    ...alone(0, 12),
    {
      probe: 'held', run: async (ctx) => {
        const d = lastOp(ctx, 'stale_save', 'p0');
        assert.doesNotMatch(d, /skipped/, `a buffer lacking only the post-join row is eligible: ${d}`);
        const rs = live(await holdsOf(ctx, 0)).filter((r) => has(r, 'revert') && r.paths.includes('shared.txt'));
        assert.equal(rs.length, 1, 'the post-join row\'s removal is one revert record on p0');
      },
    },
    ...alone(1, 4),
  ];
  const rowsLive = watch('P1_ROWS_LIVE', () => pre !== null, async (ctx) => {
    const lf = await liveFile(ctx, 'shared.txt');
    for (const m of [pre, post]) if (m !== null && (lf === null || !lf.includes(m))) return `p1's ${m} left live_code`;
    return null;
  });
  const { r } = await scriptRun('holds-stale-joinpoint', () => steps, { oracles: [rowsLive] });
  okOrFail(r);
});

// J-PROV pinned as a known-failing todo (F1 audit fix #9; 05-holds HLD-25 "Known gap J-PROV"; 11-testing F-ED-2, F-ED-5): the buffer the
// generator may no longer draw, written by the script on purpose. The late joiner p0 saves its pre-join content of shared.txt (buffer
// 'genesis': what it held before /cowork start — an editor buffer opened before the join, or a Claude /rewind to a checkpoint from
// before it, writes the same bytes back; rewind shares staleBuffers) plus one own row, over p1's row that the join's first apply
// brought in. The test asserts the behaviour INV-NOLOSS needs: the save's own row publishes, p1's row stays live and one `revert` record
// on p0 holds its removal. While the run shows exactly the J-PROV signature — the own row live, p1's row gone from live_code, no revert
// record — the test is a `todo` naming the gap; any other outcome fails. When the journal covers the join apply's (L_b, TIP] range the
// test passes as it stands: then remove the pin and let the generator draw such buffers again (generators.ts staleBuffers, R3-EF4-19).
test('J-PROV (pinned todo until the provenance journal covers the join apply\'s range): a late joiner\'s pre-join buffer saved over a teammate row its join applied is held as one revert record, the teammate row stays live and the save\'s own row publishes', { timeout: SIM_TIMEOUT }, async (t) => {
  let pre: string | null = null;
  const facts = { saved: '', own: '', ownLive: false, preLive: false, reverts: -1 };
  const steps: Step[] = [
    ...alone(1, 2),                                                                                   // p1: genesis
    { kind: 'edit_band', peer: 1, params: { path: 'shared.txt', insert: true, row: 14, n: 1, text: 'p1-pre-join' } },
    ...alone(1, 12),                                                                                  // p1 publishes
    {
      probe: 'pre live', run: async (ctx) => {
        pre = findMarkers((await liveFile(ctx, 'shared.txt'))!).find((m) => m.endsWith('_p1')) ?? null;
        assert.ok(pre !== null, 'p1\'s pre-join row is live before p0 joins');
        return pre;
      },
    },
    ...alone(0, 4),                                                                                   // p0: join (its first apply writes p1's row)
    {
      probe: 'joined', run: async (ctx) => {
        assert.ok((await disk(ctx, 0, 'shared.txt'))!.includes(pre!), 'the join applied p1\'s row onto p0\'s disk');
      },
    },
    { kind: 'stale_save', peer: 0, params: { path: 'shared.txt', buffer: 'genesis' } },               // the pre-join buffer, explicit
    ...alone(0, 12),                                                                                  // p0's human CS goes quiet and publishes
    {
      probe: 'after the save', run: async (ctx) => {
        facts.saved = lastOp(ctx, 'stale_save', 'p0');
        facts.own = findMarkers(Buffer.from(facts.saved, 'latin1')).find((m) => m.endsWith('_p0')) ?? '';
        const lf = await liveFile(ctx, 'shared.txt');
        facts.ownLive = facts.own !== '' && lf !== null && lf.includes(facts.own);
        facts.preLive = lf !== null && lf.includes(pre!);
        facts.reverts = live(await holdsOf(ctx, 0)).filter((r) => has(r, 'revert') && r.paths.includes('shared.txt')).length;
        return JSON.stringify(facts);
      },
    },
  ];
  const { r } = await scriptRun('holds-jprov-pinned', () => steps);
  okOrFail(r);
  assert.doesNotMatch(facts.saved, /skipped/, `the explicit pre-join buffer was written: ${facts.saved}`);
  assert.ok(facts.ownLive, `the save's own row ${facts.own} published (its untainted part): ${JSON.stringify(facts)}`);
  if (!facts.preLive && facts.reverts === 0) {
    t.todo('J-PROV (05-holds HLD-25): a peer\'s provenance journal starts at its join TIP (R3-59), so a pre-join buffer or /rewind saved after the join removes a teammate row the join applied with no revert record and no warning; owed fix: journal the join apply\'s (L_b, TIP] range');
  }
  assert.ok(facts.preLive, `p1's pre-join row ${String(pre)} stays in live_code: ${JSON.stringify(facts)}`);
  assert.equal(facts.reverts, 1, 'one revert record on p0 holds the removed row');
});
