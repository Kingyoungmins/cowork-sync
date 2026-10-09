// Review Focus 4: two peers pushing within the same second (PRO-43, PRO-54, ENG-40, ENG-44; glossary §24 default 3).
// Both build their Bnew on the same T and meet at yieldPoint('publish.beforePush'); git's lease picks the winner; the
// loser classifies lease_lost by outcome, waits for its newly computed window (never an immediate retry), re-merges
// against the new tip and lands; with one line edited on both sides the loser's version becomes one K4 record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishStep, type PublishReport } from '../../src/engine/publish.js';
import type { IterationCtx } from '../../src/engine/core.js';
import { writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { blobText, buf, captureReady, lines, prep, pushCalls, remoteBoard, treeOf, withCores } from '../helpers/publishHelpers.js';

const ts = (name: string): string => lines(12, (i) => `export const ${name}${i} = ${i};`);
function withRow(text: string, i: number, row: string): string {
  const rs = text.split('\n');
  rs[i - 1] = row;
  return rs.join('\n');
}
const FILES: Record<string, Buffer> = {
  'README.md': buf('# race fixture\n'),
  'src/a.ts': buf(ts('a')),
  'src/b.ts': buf(ts('b')),
  'src/c.ts': buf(ts('c')),
};

/** Both peers edit, close their human CS after 20 s quiet and capture one ready pair each, on the same board tip. */
async function bothReady(fx: CoreFixture, edits: [Record<string, string>, Record<string, string>]): Promise<[IterationCtx, IterationCtx]> {
  const [p1, p2] = fx.peers as [PeerFixture, PeerFixture];
  for (const [i, p] of [p1, p2].entries()) {
    for (const [path, text] of Object.entries(edits[i]!)) await writeWork(p, path, text);
    await prep(p);
  }
  fx.advance(20_000);
  const its: IterationCtx[] = [];
  for (const p of [p1, p2]) {
    const it = await prep(p, true);
    await captureReady(p, it);
    its.push(it);
  }
  assert.equal(its[0]!.T, its[1]!.T, 'both prepared on the same board tip');
  return [its[0]!, its[1]!];
}

/** Both publishSteps meet at publish.beforePush (each has journaled its intent on T) before either push is spawned. */
async function race(fx: CoreFixture, its: [IterationCtx, IterationCtx]): Promise<[PublishReport, PublishReport]> {
  const [p1, p2] = fx.peers as [PeerFixture, PeerFixture];
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  fx.scheduler.onYield = async (name) => {
    if (name !== 'publish.beforePush') return;
    arrived += 1;
    if (arrived === 2) open();
    await gate;
  };
  try {
    const rs = await Promise.all([publishStep(p1.core, its[0]), publishStep(p2.core, its[1])]);
    assert.equal(arrived, 2);
    return rs;
  } finally {
    fx.scheduler.onYield = null;
  }
}

function sides(fx: CoreFixture, rs: [PublishReport, PublishReport]): { winner: PeerFixture; loser: PeerFixture; won: PublishReport } {
  const outcomes = rs.map((r) => r.outcome).sort();
  assert.deepEqual(outcomes, ['landed', 'lease_lost'], `exactly one lands: ${JSON.stringify(rs)}`);
  const w = rs[0].outcome === 'landed' ? 0 : 1;
  return { winner: fx.peers[w]!, loser: fx.peers[1 - w]!, won: rs[w]! };
}

/** The loser right after its lease loss: no window yet; after G_eff it re-merges against the new tip and lands. */
async function loserLands(fx: CoreFixture, loser: PeerFixture): Promise<PublishReport> {
  const attempts = loser.core.pushAttempts;
  const now = await publishStep(loser.core, await prep(loser));
  assert.deepEqual([now.outcome, now.why], ['skipped', 'window'], 'a CAS loser never retries immediately (PRO-43)');
  assert.equal(loser.core.pushAttempts, attempts);
  assert.ok(loser.core.governor.msUntilWindow(1) > 0);
  fx.advance(6_000);
  const next = await publishStep(loser.core, await prep(loser));
  assert.equal(next.outcome, 'landed', JSON.stringify(next));
  return next;
}

test('two peers interleaved at publish.beforePush: one lands, the other classifies lease_lost, re-merges in its next window and lands', async () => {
  await withCores('race-two', { n: 2, files: FILES }, async (fx) => {
    const A1 = withRow(ts('a'), 3, 'export const a3 = 33; // p1');
    const B2 = withRow(ts('b'), 3, 'export const b3 = 33; // p2');
    const its = await bothReady(fx, [{ 'src/a.ts': A1 }, { 'src/b.ts': B2 }]);
    const { winner, loser, won } = sides(fx, await race(fx, its));
    assert.equal(await remoteBoard(fx, winner), won.bnew);
    assert.equal(loser.core.view!.intent.kind, 'none', 'the lost intent is cleared');
    assert.equal(loser.core.view!.meta.rejections, null, 'a lease loss resets the streak');
    assert.equal(pushCalls(loser), 1);
    const next = await loserLands(fx, loser);
    const C2 = await loser.core.repo.readCommit(next.c!);
    assert.deepEqual(C2.parents, [won.c], 're-merged against the new tip');
    const tree = await treeOf(loser, next.c!);
    assert.equal(await blobText(loser, tree, 'src/a.ts'), A1);
    assert.equal(await blobText(loser, tree, 'src/b.ts'), B2);
    assert.equal(await remoteBoard(fx, loser), next.bnew);
  });
});

test('the same race with one line edited on both sides leaves one K4 record on the loser and publishes its other paths', async () => {
  await withCores('race-k4', { n: 2, files: FILES }, async (fx) => {
    const A1 = withRow(ts('a'), 3, 'export const a3 = 100; // p1');
    const A2 = withRow(ts('a'), 3, 'export const a3 = 200; // p2');
    const B1 = withRow(ts('b'), 8, 'export const b8 = 81; // p1');
    const C2 = withRow(ts('c'), 8, 'export const c8 = 82; // p2');
    const its = await bothReady(fx, [{ 'src/a.ts': A1, 'src/b.ts': B1 }, { 'src/a.ts': A2, 'src/c.ts': C2 }]);
    const { winner, loser, won } = sides(fx, await race(fx, its));
    assert.deepEqual(won.records, [], 'the winner made no record');
    const winnerA = winner === fx.peers[0] ? A1 : A2;
    const loserOther = loser === fx.peers[0] ? ['src/b.ts', B1] : ['src/c.ts', C2];
    const next = await loserLands(fx, loser);
    assert.equal(next.records.length, 1, 'one K4 record on the loser');
    const rec = loser.core.holds.get(next.records[0]!)!;
    assert.deepEqual([rec.paths, rec.state, rec.residence], [['src/a.ts'], 'CONFLICTED', 'ON_DISK']);
    assert.equal(loser.core.holds.nonTerminal().length, 1);
    const tree = await treeOf(loser, next.c!);
    assert.equal(await blobText(loser, tree, 'src/a.ts'), winnerA, 'the unit takes TIP');
    assert.equal(await blobText(loser, tree, loserOther[0]!), loserOther[1], 'the loser\'s other paths publish');
  });
});
