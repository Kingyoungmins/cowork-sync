// Algorithm REV step 1, locateCs, on real clones (Plan 3 Task 17; 05-holds §3.6 step 1, HLD-33, HLD-68 FEAT-F10-02, -13; 11-testing
// TC-F10-05, -07, -13 kernel halves; X-10): this peer's change-sets published by its own captures, peer 1 as the teammate, and live
// commits of this peer crafted under a retired epoch (revertFixture.pushAs). The results are reasons, never status or log codes.
// Git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queueSignal } from '../../src/engine/csStep.js';
import { pinCs } from '../../src/holds/changesets.js';
import { isFullyShared, locateCs, revertNotShared, type LocateResult } from '../../src/holds/revertCs.js';
import { buf, lines, prep, withCores } from '../helpers/publishHelpers.js';
import { announce, applyNow, csTrailer, humanCapture, humanCs, publishNow, pushAs, T10 } from '../helpers/revertFixture.js';
import type { PeerFixture } from '../helpers/coreFixture.js';

const DAY = 86_400_000;
const FILES: Record<string, Buffer> = Object.fromEntries(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'q.txt', 'x.txt'].map((f) => [f, buf(lines(12, (i) => `${f} row ${i}`))]));
const edit = (f: string, tag: string): string => lines(12, (i) => `${f} row ${i}${i === 6 ? ` ${tag}` : ''}`);
const E2 = 'e2'.repeat(16);   // a retired epoch of this peer (crafted commits)

const locate = (p: PeerFixture, t: string): Promise<LocateResult> => locateCs(p.core, t, { mode: 'verb' });
const epochOf = (p: PeerFixture): string => p.core.view!.meta.epoch;

test('locateCs resolves a full cs_id, a unique prefix of at least 6 characters, <cs_id>@<epoch8> and last (the newest closed CS by board order, or local close order before it is live) within one (peer, epoch)', T10, async () => {
  await withCores('rev-locate', { n: 2, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const peer = p.core.peerId;
    const e1 = epochOf(p);
    const one = await humanCs(fx, p, { 'a.txt': edit('a.txt', 'ONE') });
    assert.equal(one.csId, `${peer}/human/1`);
    const found1 = { found: { csId: one.csId, epoch: e1, label: one.csId, commits: [one.live] } };
    assert.deepEqual(await locate(p, one.csId), found1, 'a full cs_id');
    assert.deepEqual(await locate(p, peer.slice(0, 6)), found1, 'a prefix of 6 characters naming one CS');
    assert.deepEqual(await locateCs(p.core, one.csId, { mode: 'view' }), found1, 'view mode locates alike');
    assert.deepEqual(await locate(p, `${one.csId}@${e1.slice(0, 8)}`), { found: { ...found1.found, label: `${one.csId}@${e1.slice(0, 8)}` } }, 'the qualified form');
    assert.equal(await locate(p, peer.slice(0, 5)), null, 'a prefix shorter than 6 characters names nothing');
    assert.equal(await locate(p, `${one.csId}@${'0'.repeat(8)}`), null, 'an epoch with no such CS');

    // Another epoch of this peer (retired): its own CS ids, resolved within that (peer, epoch) only.
    const old = await pushAs(fx, p, { epoch: E2, seq: 1, cs: [csTrailer(`${peer}/human/7`, 1)], csPaths: new Map([[`${peer}/human/7`, ['x.txt']]]), changes: { 'x.txt': edit('x.txt', 'OLD') } });
    await applyNow(fx, p);
    assert.deepEqual(await locate(p, `${peer}/human/7`), { found: { csId: `${peer}/human/7`, epoch: E2, label: `${peer}/human/7`, commits: [old.live] } });
    assert.deepEqual(await locate(p, one.csId), found1, 'the epoch-E1 CS keeps only its own commits');

    // `last`: the newest closed CS by board order of its newest commit — the epoch-E2 commit is the newest own commit now.
    assert.deepEqual(await locate(p, 'last'), { found: { csId: `${peer}/human/7`, epoch: E2, label: `${peer}/human/7`, commits: [old.live] } });
    const two = await humanCs(fx, p, { 'b.txt': edit('b.txt', 'TWO') });
    assert.deepEqual(await locate(p, 'last'), { found: { csId: two.csId, epoch: e1, label: two.csId, commits: [two.live] } }, 'last: the newest by board order');
    // A CS published in two commits (a recapture's second publish of the same id is not possible for a human CS; a seat CS's checkpoints
    // are): its C(t) is every commit, first-parent order — exercised in revertCs.inverse (TC-F10-03). Before it is live, local close order:
    const [three] = await humanCapture(fx, p, { 'c.txt': edit('c.txt', 'THREE') });
    assert.deepEqual(await locate(p, 'last'), { notShared: { hid: null } }, `last is the closed, captured, unpublished ${three}: refused, never skipped`);
    assert.deepEqual(await locate(p, three!), { notShared: { hid: null } }, 'by id too (C(t) is empty: the CS table decides)');
  });
});

test('an id under two epochs or a prefix matching several CSs → ambiguous (≤ 5 qualified candidates); outside the 14-day window → tooOld; unknown → null; a teammate\'s CS → notOwn; an open CS → open; a ready or held CS → notShared {hid}; last with no closed CS → noLast; last never skips to an older CS', T10, async () => {
  await withCores('rev-locate-refuse', { n: 2, files: FILES }, async (fx) => {
    const [p, q] = [fx.peers[0]!, fx.peers[1]!];
    const peer = p.core.peerId;
    const e1 = epochOf(p);
    assert.deepEqual(await locate(p, 'last'), { noLast: true }, 'no closed CS of this peer yet');

    // The teammate's CS: notOwn, named by the fold's display name (its join op rode its first publish).
    await announce(q);
    const team = await humanCs(fx, q, { 'q.txt': edit('q.txt', 'TEAM') });
    await applyNow(fx, p);
    assert.deepEqual(await locate(p, team.csId), { notOwn: { name: 'Peer p2' } });
    assert.deepEqual(await locate(p, 'last'), { noLast: true }, 'a teammate\'s CS is never this peer\'s last');

    // One id under two epochs: an unqualified id is ambiguous, each qualified candidate listed.
    const one = await humanCs(fx, p, { 'a.txt': edit('a.txt', 'ONE') });
    await pushAs(fx, p, { epoch: E2, seq: 1, cs: [csTrailer(one.csId, 1)], csPaths: new Map([[one.csId, ['x.txt']]]), changes: { 'x.txt': edit('x.txt', 'E2') } });
    await applyNow(fx, p);
    const both = [`${one.csId}@${e1.slice(0, 8)}`, `${one.csId}@${E2.slice(0, 8)}`].sort();
    const amb = await locate(p, one.csId);
    assert.ok(amb !== null && 'ambiguous' in amb, JSON.stringify(amb));
    assert.deepEqual([...amb.ambiguous].sort(), both);
    for (const label of both) {
      const r = await locate(p, label);
      assert.ok(r !== null && 'found' in r && r.found.label === label && r.found.commits.length === 1, `${label}: ${JSON.stringify(r)}`);
    }
    // A prefix matching several CSs: at most 5 candidates, qualified where an id repeats under another epoch.
    const more = [2, 3, 4, 5, 6].map((n) => `${peer}/human/${10 + n}`);
    await pushAs(fx, p, {
      epoch: E2, seq: 2, cs: more.map((id) => csTrailer(id, 1)), csPaths: new Map(more.map((id, i) => [id, [`m${i}.txt`]])),
      changes: Object.fromEntries(more.map((_, i) => [`m${i}.txt`, `m${i}\n`])),
    });
    await applyNow(fx, p);
    const pre = await locate(p, peer.slice(0, 8));
    assert.ok(pre !== null && 'ambiguous' in pre, JSON.stringify(pre));
    assert.equal(pre.ambiguous.length, 5, 'at most 5 candidates');
    assert.ok(pre.ambiguous.every((c) => c.startsWith(peer)), JSON.stringify(pre.ambiguous));
    assert.ok(pre.ambiguous.includes(`${one.csId}@${e1.slice(0, 8)}`), 'a repeated id is qualified');

    // An open CS (a seat CS after its first effect): open.
    const seat = 'c'.repeat(32);
    queueSignal(p.core, { kind: 'effect', seat, agent: null, toolUseId: 'toolu_1', paths: ['d.txt'], turnOrigin: 'prompt' });
    assert.deepEqual(await locate(p, `${seat}/1`), { open: true });

    // A ready CS (captured, not yet published): notShared {hid: null}; held by a non-terminal record naming it: notShared {hid}.
    const [ready] = await humanCapture(fx, p, { 'b.txt': edit('b.txt', 'READY') });
    assert.deepEqual(await locate(p, ready!), { notShared: { hid: null } });
    // last never skips to an older CS: the ready one is newer than every published one.
    assert.deepEqual(await locate(p, 'last'), { notShared: { hid: null } }, 'last refuses on the unpublished CS, never resolves to an older one');
    const it = await prep(p);
    const hid = await p.core.holds.hold(pinCs('t0', [ready!], ['b.txt'], it.A, { 'b.txt': it.A.get('b.txt')!.oid }, 'human', 'none'));
    assert.deepEqual(await locate(p, ready!), { notShared: { hid } });
    assert.deepEqual(await locate(p, 'last'), { notShared: { hid } });

    // Unknown: nothing in the window, nothing on the live chain.
    assert.equal(await locate(p, `${peer}/human/99`), null);
    assert.equal(await locate(p, 'f'.repeat(32)), null);
    // Outside the 14-day window (the journal's local append time): the live-chain grep finds the trailer → tooOld.
    fx.advance(15 * DAY);
    assert.deepEqual(await locate(p, `${one.csId}@${e1.slice(0, 8)}`), { tooOld: true });
    assert.deepEqual(await locate(p, team.csId), { tooOld: true }, 'tooOld is decided before ownership: C(t) is empty');
    assert.equal(await locate(p, `${peer}/human/99`), null, 'still unknown');
  });
});

test('revertNotShared and isFullyShared agree: a K7 PIN that a later CS joined as a bundle names the record ({hid}); a journaled ready pair gives {hid: null}; after the publish both report shared', T10, async () => {
  await withCores('rev-locate-shared', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const agree = (csId: string): void => {
      const ns = revertNotShared(p.core, csId);
      const open = p.core.cs.table().cs.some((e) => e.cs_id === csId && e.state === 'open');
      assert.equal(isFullyShared(p.core, csId), ns === null && !open, `${csId}: ${JSON.stringify(ns)}`);
    };
    // The target CS on a.txt is held as a K7 PIN (guard t0) over its group; a later CS touching a.txt joins it as a bundle (HLD-49).
    const [target] = await humanCapture(fx, p, { 'a.txt': edit('a.txt', 'TARGET') });
    const it = await prep(p);
    const R = await p.core.repo.readTreeMap(p.core.cs.ready().find((x) => x.csId === target)!.R);
    const hid = await p.core.holds.hold(pinCs('t0', [target!], ['a.txt'], it.A, { 'a.txt': R.get('a.txt')!.oid }, 'human', 'none'));
    const [later] = await humanCapture(fx, p, { 'a.txt': `${edit('a.txt', 'TARGET')}LATER\n` });
    assert.equal(later, undefined, 'the later CS journals no pair: it joined the PIN');
    const pin = p.core.holds.get(hid)!;
    assert.equal(pin.cs_ids.length, 2, `the bundle joined the record: ${JSON.stringify(pin.cs_ids)}`);
    const joined = pin.cs_ids.find((id) => id !== target)!;
    for (const id of [target!, joined]) {
      assert.deepEqual(revertNotShared(p.core, id), { hid }, `${id} names the record`);
      assert.equal(isFullyShared(p.core, id), false);
      agree(id);
    }
    // A journaled ready pair of another group: {hid: null}, not fully shared.
    const [pair] = await humanCapture(fx, p, { 'c.txt': edit('c.txt', 'PAIR') });
    assert.deepEqual(revertNotShared(p.core, pair!), { hid: null });
    assert.equal(isFullyShared(p.core, pair!), false);
    agree(pair!);
    // After its publish: shared on both.
    const r = await publishNow(fx, p);
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    assert.equal(revertNotShared(p.core, pair!), null);
    assert.equal(isFullyShared(p.core, pair!), true);
    agree(pair!);
    // The held one stays held (the PIN still has its guard): the publish carried none of a.txt.
    assert.deepEqual(revertNotShared(p.core, target!), { hid });
  });
});
