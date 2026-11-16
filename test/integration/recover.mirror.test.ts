// PRO-25 re-anchor of hold mirrors (Plan 3 Task 4; 02-protocol PRO-25, §3.3 "Determinism"; 05-holds F8; rulings R3-26,
// R3-27): /cowork recover in re-anchor mode drops every `hold` draft of the old epoch from the outbox it rebuilds and re-drafts,
// per record not durable on the recovered chain, one hold op against the folded rev there, in the rebuild's single state update
// (lostStateRebuild(…, metaOverrides).outbox); the next publish mints it under the new epoch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOpId } from '../../src/board/ids.js';
import type { OpDraft } from '../../src/board/ops.js';
import { recover, type RecoverResult } from '../../src/engine/recover.js';
import { projectOp } from '../../src/holds/mirror.js';
import type { CoreFixture, PeerFixture } from '../helpers/coreFixture.js';
import { catchUp, forceRemote, inIncident, poll } from '../helpers/incidentFixture.js';
import { durableNow, holdOpsSince, holdPatch, win } from '../helpers/mirrorFixture.js';
import { buf, prep, withCores } from '../helpers/publishHelpers.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const FILES: Record<string, Buffer> = {
  'README.md': buf('# recover mirror fixture\n'),
  'x.txt': buf('x v0\n'),
  'w.txt': buf('w1\nw2\nw3\n'),
  'z.txt': buf('z1\nz2\nz3\n'),
};
const PAST_WINDOW_MS = 11_000;

function okPreview(r: RecoverResult): asserts r is Extract<RecoverResult, { ok: true }> {
  assert.ok(r.ok, `recover refused: ${JSON.stringify(r)}`);
}

/** The peer enters INCIDENT on its next poll and pushes its displaced copy in a later window. */
async function detect(fx: CoreFixture, p: PeerFixture): Promise<void> {
  assert.equal((await poll(p)).incident, true, `${p.name}: INCIDENT`);
  fx.advance(PAST_WINDOW_MS);
  assert.equal((await poll(p)).incident, true);
}

test('PRO-25: recover re-anchor re-drafts hold mirrors against the folded rev under the new epoch', T10, async () => {
  await withCores('recover-mirror', { n: 2, files: FILES }, async (fx) => {
    // Y is the bootstrap's member (a writer the fold accepts hold ops from: the second clone never joined the board); X only
    // restores the rewound board, which writes no op.
    const [py, px] = [fx.peers[0]!, fx.peers[1]!];
    const refs = py.core.refs;
    // Y's records r1 and r2 are mirrored on the common chain (rev 1 each).
    await prep(py);
    const { id: r1 } = await holdPatch(py, 'z.txt', 'z1\nz2 held\nz3\n');
    const { id: r2 } = await holdPatch(py, 'w.txt', 'w1\nw2 held\nw3\n');
    assert.equal((await win(fx, py)).r.outcome, 'landed');
    const { board: Ba } = await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
    await fx.pushTeamChange({ 'x.txt': buf('x v2\n') });
    for (const p of fx.peers) await catchUp(fx, p);
    // r1's rev 2 lands only on Y's chain (X never sees it).
    await py.core.holds.addGuard(r1, 'join');
    assert.equal((await win(fx, py, PAST_WINDOW_MS)).r.outcome, 'landed');
    // The board is rewound; X recovers its tip and the team continues on it.
    await forceRemote(fx, px, refs.remoteBoard, Ba);
    await detect(fx, px);
    const px1 = await recover(px.core, null);
    okPreview(px1);
    okPreview(await recover(px.core, px1.preview.id));
    await fx.pushTeamChange({ 't.txt': buf('t on the new chain\n') });
    const { board: Bn } = await fx.pushTeamChange({ 'x.txt': buf('x v3 on the new chain\n') });
    await catchUp(fx, px);

    // Y: r1 changes again, and its op is allocated under the old epoch (an unlanded hold op), beside a non-hold draft.
    await py.core.holds.addGuard(r1, 'phantom');
    const epoch0 = py.core.view!.meta.epoch;
    let seq = py.core.view!.meta.seq_next;
    py.core.outbox.replaceHold(projectOp(py.core.holds.get(r1)!, 2));
    const FREEZE: OpDraft = { type: 'event', cid: '', kind: 'freeze', refs: [], reason_code: 'EPOCH' };
    py.core.outbox.add(FREEZE);
    assert.equal(py.core.outbox.take([], { peer: py.core.peerId, epoch: epoch0 }, { next: () => seq++ }, { maxOps: 1_000, maxBytes: 65_536 }).length, 2);
    await py.core.commit({ meta: { ...py.core.view!.meta, seq_next: seq, outbox: py.core.outbox.toJson() } });
    assert.equal(py.core.outbox.allocatedHold(r1)?.prev_rev, 2, 'an unlanded hold op of the old epoch');

    await detect(fx, py);
    const prev = await recover(py.core, null);
    okPreview(prev);
    assert.deepEqual([prev.preview.mode, prev.preview.V], ['reanchor', Bn]);
    okPreview(await recover(py.core, prev.preview.id));
    assert.ok(!inIncident(py));
    const view = py.core.view!;
    assert.notEqual(view.meta.epoch, epoch0, 'a new epoch');
    assert.equal(view.fold?.holds[r1]?.rev, 1, 'the recovered chain folds r1 at rev 1');
    // The outbox the rebuild's single state update wrote: no op id of the old epoch, the non-hold draft kept, and one hold draft
    // per record not durable on the recovered chain (r1), chained on the folded rev there; none for r2 (durable there).
    const entries = (view.meta.outbox as unknown as { entries: Array<{ draft: Record<string, unknown>; op: unknown }> }).entries;
    assert.ok(entries.every((e) => e.op === null), 'no op allocated under the old epoch remains');
    // Plan 2 final review FC-7: the new epoch's join op leads the rebuilt drafts; the non-hold draft follows it.
    assert.equal(entries[0]?.draft['type'], 'join', 'the join op of the new epoch first (FC-7)');
    assert.deepEqual(entries.filter((e) => e.draft['type'] !== 'hold').map((e) => e.draft['kind'] ?? e.draft['type']), ['join', 'freeze']);
    assert.deepEqual(
      entries.filter((e) => e.draft['type'] === 'hold').map((e) => [e.draft['hold_id'], e.draft['rev'], e.draft['prev_rev'], (e.draft['guards'] as Array<{ name: string }>).map((g) => g.name)]),
      [[r1, 3, 1, ['revert', 'join', 'phantom']]],
    );
    // The next publish mints it under the new epoch.
    const epoch1 = view.meta.epoch;
    for (let i = 0; i < 5 && py.core.outbox.size > 0; i++) {
      fx.advance(PAST_WINDOW_MS);
      assert.equal((await poll(py)).incident, false);
    }
    assert.equal(py.core.outbox.size, 0, 'the rebuilt ops landed');
    const sent = (await holdOpsSince(py, Bn, py.core.view!.laB)).map((x) => x.op);
    assert.deepEqual(sent.map((o) => [o.hold_id, o.prev_rev]), [[r1, 1]]);
    assert.ok(sent.every((o) => parseOpId(o.id)?.epoch === epoch1), `sent under the new epoch: ${JSON.stringify(sent)}`);
    // The re-anchor queues the new epoch's `join` ahead of them (Plan 2 final review FC-7), so the fold accepts the new epoch's
    // ops: r1 is durable again once its re-drafted op landed. r2 stayed durable on the recovered chain without any op.
    assert.equal(await durableNow(py, r1), true, 'r1 durable once its re-drafted op landed after the join');
    assert.equal(await durableNow(py, r2), true);
  });
});
