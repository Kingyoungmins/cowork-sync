// Algorithm REV step 8's change-set, openRevertCs (Plan 3 Task 17; 05-holds HLD-68 "a second human-class CS", HLD-26 (the
// `/cowork revert` writeLocal source), HLD-30 (a 40-file revert never trips MASS), HLD-40 human close, HLD-52, §8 Q18; FEAT-F10-09,
// -11; 11-testing TC-F10-01 kernel half): the revert write made the way Plan 7's confirm makes it (revertFixture.confirmRevert), the
// engine's own steps after it. Real clones; git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsTrailers, readBoardCommit } from '../../src/board/boardCommit.js';
import { applyStep } from '../../src/engine/apply.js';
import { captureStep } from '../../src/engine/csStep.js';
import { humanOnlyAttribution } from '../../src/engine/deps.js';
import { detectStep, recordStep } from '../../src/engine/holdSteps.js';
import { publishStep } from '../../src/engine/publish.js';
import type { PublishGatePort } from '../../src/holds/ports.js';
import { guardName } from '../../src/holds/record.js';
import { locateCs, revertInverse, type CsLocation, type RevertResult } from '../../src/holds/revertCs.js';
import { writeWork, type PeerFixture } from '../helpers/coreFixture.js';
import { buf, lines, prep, remoteLiveCode, treeOf, blobText, withCores } from '../helpers/publishHelpers.js';
import { applyNow, confirmRevert, csTrailer, humanCs, publishNow, pushAs, T10 } from '../helpers/revertFixture.js';

const E2 = 'e2'.repeat(16);
const SEAT = '7'.repeat(32);

async function located(p: PeerFixture, csId: string): Promise<CsLocation> {
  const r = await locateCs(p.core, csId, { mode: 'verb' });
  assert.ok(r !== null && 'found' in r, `${csId}: ${JSON.stringify(r)}`);
  return r.found;
}

async function computed(p: PeerFixture, loc: CsLocation): Promise<RevertResult> {
  const r = await revertInverse(p.core, loc, { mode: 'verb' });
  assert.ok(!('tooBig' in r));
  return r;
}

/** The loop's order for one materializing iteration up to its capture (prepareIteration 'auto', detectStep, captureStep). */
async function captureIteration(p: PeerFixture): Promise<string[]> {
  const it = await prep(p, 'auto');
  assert.ok(it.mat !== null, 'the iteration materialized (a capture was due)');
  await detectStep(p.core, it);
  return (await captureStep(p.core, it)).captured;
}

const revertRecords = (p: PeerFixture): number => p.core.holds.all().filter((r) => r.guards.some((g) => guardName(g) === 'revert')).length;

test('openRevertCs after a WRITTEN group records every path in ObservedWrites, opens one human-class CS <peer>/human/<n> with the next n and exactly those paths, closes it at once, and the next materializing iteration captures it; 40 reverted files make no revert record, no MASS and no breaker count', T10, async () => {
  const files = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`m/f${String(i).padStart(2, '0')}.txt`, buf(lines(6, (k) => `f${i} row ${k}`))]));
  await withCores('rev-cs-open', { n: 1, files: { ...files, 'w.txt': buf('w\n') } }, async (fx) => {
    const p = fx.peers[0]!;
    const peer = p.core.peerId;
    // The CS to revert: one row added to each of 40 files (crafted under a retired epoch of this peer, applied: no human delta).
    const cs = `${SEAT}/3`;
    const paths = Object.keys(files).sort();
    await pushAs(fx, p, {
      epoch: E2, seq: 1, cs: [csTrailer(cs, 40)], csPaths: new Map([[cs, paths]]),
      changes: Object.fromEntries(paths.map((f, i) => [f, `${files[f]!.toString('utf8')}added by the CS ${i}\n`])),
    });
    await applyNow(fx, p);
    await prep(p, true);
    const r = await computed(p, await located(p, cs));
    assert.equal(r.results.size, 40);
    const n = p.core.view!.meta.cs_human_next;
    const { cs: rev, written } = await confirmRevert(p, cs, r);
    assert.equal(rev, `${peer}/human/${n}`, 'the next n of the per-peer human counter');
    for (const [path, oid] of written) assert.ok(p.core.observed.peek(path, oid), `${path}: an attributed (observed) write`);
    const entry = p.core.cs.table().cs.find((e) => e.cs_id === rev)!;
    assert.deepEqual({ kind: entry.kind, origin: entry.origin, state: entry.state, paths: entry.paths }, { kind: 'human', origin: 'human', state: 'closed', paths });
    assert.ok(p.core.cs.closeDue(), 'closed at once: its capture is due');
    assert.deepEqual(await p.core.reverts.byCs(rev), [{ cs: rev, of: cs, t_local_ms: Math.floor(p.clock.wallMs()), written: Object.fromEntries(written) }]);
    assert.equal(await p.core.reverts.ofCs(rev), cs, 'the local "revert of" label');

    // The next materializing iteration captures exactly that CS; the 40 observed deltas trip nothing.
    assert.deepEqual(await captureIteration(p), [rev]);
    assert.deepEqual(p.core.cs.ready().find((x) => x.csId === rev)!.paths, paths);
    assert.equal(revertRecords(p), 0, 'no revert record');
    assert.ok(!p.core.view!.meta.freeze_reasons.includes('MASS'), 'no MASS');
    // No breaker count: the window is still empty — 10 unobserved deltas now (the threshold, not above it) trip nothing either.
    for (let i = 0; i < 10; i++) await writeWork(p, `m/f${String(i).padStart(2, '0')}.txt`, `unobserved ${i}\n`);
    const it = await prep(p);
    await detectStep(p.core, it);
    assert.ok(!p.core.view!.meta.freeze_reasons.includes('MASS'), 'the revert counted no path in the 30 s window');
  });
});

test('the revert CS is disjoint from the open human CS and publishes as one ordinary human CS: no new op, op field, trailer key or ref', T10, async () => {
  const FILES = { 'x.txt': buf(lines(6, (i) => `x ${i}`)), 'y.txt': buf(lines(6, (i) => `y ${i}`)), 'z.txt': buf(lines(6, (i) => `z ${i}`)) };
  await withCores('rev-cs-one', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const own = await humanCs(fx, p, { 'x.txt': lines(6, (i) => `x ${i}${i === 2 ? ' CS' : ''}`), 'y.txt': lines(6, (i) => `y ${i}${i === 5 ? ' CS' : ''}`) });
    await prep(p, true);
    // An unrelated human edit: the open human CS holds z.txt.
    await writeWork(p, 'z.txt', lines(6, (i) => `z ${i}${i === 3 ? ' open' : ''}`));
    await prep(p);
    assert.deepEqual([...p.core.cs.openPaths()], ['z.txt']);
    const refsBefore = Object.keys(await fx.remote.refs()).sort();
    const r = await computed(p, await located(p, own.csId));
    assert.deepEqual([...r.results.keys()], ['x.txt', 'y.txt']);
    const { cs: rev } = await confirmRevert(p, own.csId, r);
    assert.deepEqual(await captureIteration(p), [rev]);
    assert.deepEqual([...p.core.cs.openPaths()], ['z.txt'], 'the written paths went to the revert CS, never to the open human CS');
    const pub = await publishNow(fx, p);
    assert.equal(pub.outcome, 'landed', JSON.stringify(pub));
    const live = await p.core.repo.readCommit(pub.c!);
    const { cs: trailers, paths } = parseCsTrailers(live.trailers);
    assert.deepEqual(trailers.map((t) => ({ ...t })), [{ csId: rev, state: 'closed', seq: 1, origin: 'human', checks: 'skipped', paths: 2 }], 'one ordinary human CS');
    assert.deepEqual(paths.get(rev), ['x.txt', 'y.txt']);
    assert.deepEqual([...new Set(live.trailers.map((t) => t.key))].sort(), ['Cowork-CS', 'Cowork-CS-Paths', 'Cowork-Proto', 'Cowork-Seat', 'Cowork-Writer', 'skip-checks'],
      'exactly the glossary §5 keys of an ordinary human CS');
    assert.deepEqual(live.trailers.filter((t) => t.key === 'Cowork-Seat').map((t) => t.value), ['human']);
    const board = await readBoardCommit(p.core.repo, pub.bnew!);
    assert.deepEqual(board.opsLines, [], 'no op rides the revert');
    assert.deepEqual(Object.keys(await fx.remote.refs()).sort(), refsBefore, 'no new ref');
    const tip = await treeOf(p, await remoteLiveCode(fx, p));
    assert.equal(await blobText(p, tip, 'x.txt'), lines(6, (i) => `x ${i}`));
    assert.equal(await blobText(p, tip, 'z.txt'), lines(6, (i) => `z ${i}`), 'the open human CS did not ride along');
  });
});

test('a revert CS held by a K6 PIN keeps its mark while held and publishes on the release without a t0 PIN', T10, async () => {
  let claimed = true;
  const gate: PublishGatePort = {
    gate: async (_repo, _tip, _A, _R, paths) => (claimed && paths.includes('big.txt') ? { block: { claimId: 'abcdefghij234567' } } : { block: null }),
    claimStillBlocks: async () => claimed,
  };
  const BIG = lines(100, (i) => `big row ${i}`);
  await withCores('rev-cs-k6', { n: 1, files: { 'big.txt': buf(BIG) }, ports: { gate } }, async (fx) => {
    const p = fx.peers[0]!;
    claimed = false;
    const own = await humanCs(fx, p, { 'big.txt': `${BIG}${lines(300, (i) => `added row ${i}`)}`, 'n.ts': 'export const n = 1;\n' });
    await prep(p, true);
    // T0's shrink rule applies to this peer's unattributed shrinks (the attribution a hook binding gives a seat): only the mark exempts.
    p.deps.attribution = { ...humanOnlyAttribution, shrinkAttributed: () => false };
    const r = await computed(p, await located(p, own.csId));
    const { cs: rev, written } = await confirmRevert(p, own.csId, r);
    assert.deepEqual(await captureIteration(p), [rev]);
    claimed = true;
    const held = await publishNow(fx, p);
    assert.notEqual(held.outcome, 'landed', 'B1 holds the group');
    const k6 = p.core.holds.nonTerminal().filter((x) => x.kind === 'PIN' && x.guards.some((g) => g.name.startsWith('claim:')));
    assert.equal(k6.length, 1);
    assert.ok(k6[0]!.cs_ids.includes(rev), 'the K6 PIN names the revert CS');
    assert.deepEqual(p.core.cs.revertMarks.current(rev), written, 'held: the mark stays');
    // The claim releases: the next iteration's 5R releases the guard and the group publishes (HLD-52) through T0's shrink rule.
    claimed = false;
    fx.advance(6_000);
    const it = await prep(p);
    await recordStep(p.core, it, await applyStep(p.core, it));
    assert.deepEqual(p.core.cs.revertMarks.current(rev), written, 'the released PIN keeps it pending until the publish');
    const pub = await publishStep(p.core, it);
    assert.equal(pub.outcome, 'landed', JSON.stringify(pub));
    assert.deepEqual(pub.k7 ?? [], [], 'no t0 PIN');
    assert.equal(p.core.holds.nonTerminal().filter((x) => x.guards.some((g) => g.name === 't0')).length, 0);
    const tip = await treeOf(p, await remoteLiveCode(fx, p));
    assert.equal(await blobText(p, tip, 'big.txt'), BIG, 'the 75 % shrink published');
    assert.equal(tip.has('n.ts'), false, 'the deletion published');
    assert.equal(p.core.cs.revertMarks.current(rev), null, 'published: the mark ends');
  });
});
