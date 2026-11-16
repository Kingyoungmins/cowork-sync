// Bundles, SHADOWs and whole-CS PINs (Plan 3 Task 10; 05-holds HLD-38, HLD-45 slot, HLD-48, HLD-49, HLD-52, HLD-66 shape, 05 I2 path
// bundle; rulings R3-07, R3-42, R3-44; contract addition 5): a scripted PublishGatePort stands in for B1, a CS closing on a pinned path
// joins the PIN at its close, and the claim PREDICATE's release (Task 12a) is stood in by releaseGuard. Real clones; git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsTrailers } from '../../src/board/boardCommit.js';
import { captureDue, publicationGroups, type IterationCtx } from '../../src/engine/core.js';
import { captureStep, queueSignal } from '../../src/engine/csStep.js';
import { publishStep, type PublishReport } from '../../src/engine/publish.js';
import type { Oid } from '../../src/git/oid.js';
import { heldPins, pinCs, shadowRecord } from '../../src/holds/changesets.js';
import type { EditCheckPort, PublishGatePort, T0RegionsPort, T0Verdict } from '../../src/holds/ports.js';
import { guardName, setBlob, type BlobMap, type HoldRecord } from '../../src/holds/record.js';
import type { CsSignal } from '../../src/holds/signals.js';
import { readWork, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { holdOpsSince, remoteTip } from '../helpers/mirrorFixture.js';
import { blobText, buf, lines, prep, remoteLiveCode, treeOf, withCores } from '../helpers/publishHelpers.js';

const T10 = { timeout: 10 * 60_000 };
const CLAIM = 'abcdefghij234567';
const SA = 'a'.repeat(32);
const SB = 'b'.repeat(32);
const py = (name: string, tag = ''): string => lines(12, (i) => `${name}_${i} = ${i}${i === 4 ? tag : ''}`);
const FILES: Record<string, Buffer> = {
  'README.md': buf('# bundle fixture\n'),
  'pricing.py': buf(py('pricing')), 'orders.py': buf(py('orders')), 'reports.py': buf(py('reports')), 'invoice.py': buf(py('invoice')),
  'a.py': buf(py('a')), 'b.py': buf(py('b')), 'w.py': buf(py('w')), 'shadow.py': buf(py('shadow')),
};

let tool = 0;
function effect(seat: string, paths: readonly string[], turnOrigin: 'prompt' | 'wake' = 'prompt'): CsSignal {
  return { kind: 'effect', seat, agent: null, toolUseId: `toolu_${++tool}`, paths, turnOrigin };
}

async function publish(fx: CoreFixture, p: PeerFixture): Promise<PublishReport> {
  fx.advance(6_000);
  return publishStep(p.core, await prep(p));
}

async function capture(p: PeerFixture): Promise<{ it: IterationCtx; captured: string[] }> {
  const it = await prep(p, true);
  return { it, captured: (await captureStep(p.core, it)).captured };
}

/** A human edit closed by its 20 s quiet period and captured. */
async function humanEdit(fx: CoreFixture, p: PeerFixture, files: Record<string, string>): Promise<string[]> {
  for (const [path, text] of Object.entries(files)) await writeWork(p, path, text);
  await prep(p);
  fx.advance(20_000);
  return (await capture(p)).captured;
}

const claimPins = (p: PeerFixture): HoldRecord[] => p.core.holds.nonTerminal().filter((r) => r.kind === 'PIN' && r.guards.some((g) => g.name === `claim:${CLAIM}`));

test('05 I2 path bundle: a scripted gate blocking CS1 (pricing.py, orders.py) on claim abcdefghij234567 pins it; CS2 touching orders.py and reports.py joins the PIN at its close; when the claim releases one commit holds all three files', T10, async () => {
  let claimed = true;
  const seen: string[][] = [];
  const gate: PublishGatePort = {
    gate: async (_repo, _tip, _A, _R, paths) => {
      seen.push([...paths]);
      return claimed && paths.includes('pricing.py') ? { block: { claimId: CLAIM } } : { block: null };
    },
    claimStillBlocks: async () => claimed,
  };
  await withCores('bundle-i2', { n: 1, files: FILES, ports: { gate } }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    const tip0 = await remoteLiveCode(fx, p);
    const cs1 = await humanEdit(fx, p, { 'pricing.py': py('pricing', ' # new price'), 'orders.py': py('orders', ' # uses price') });
    assert.equal(cs1.length, 1);
    const it1 = await prep(p);
    const r1 = await publish(fx, p);
    assert.equal(r1.c, null, 'the claim PIN holds the group');
    const pins = claimPins(p);
    assert.equal(pins.length, 1);
    const pin = pins[0]!;
    assert.deepEqual(pin.paths, ['orders.py', 'pricing.py']);
    assert.deepEqual(pin.cs_ids, cs1);
    const pair1 = core.view!.ready.find((x) => x.csId === cs1[0])!;
    const R1 = await core.repo.readTreeMap(pair1.R);
    assert.ok('h1' in pin.blobs);
    for (const path of pin.paths) {
      assert.equal(pin.blobs.h0[path], it1.A.get(path)!.oid, 'H0 = A');
      assert.equal(pin.blobs.h1[path], R1.get(path)!.oid, 'H1 = R');
    }
    assert.equal((await readWork(p, 'pricing.py'))!.toString('utf8'), py('pricing', ' # new price'), 'the disk untouched');
    await publish(fx, p);   // the PIN's creation op leaves board-only
    const board1 = await remoteTip(fx, p);
    const rev1 = core.holds.get(pin.id)!.rev;
    // CS2 closes on the pinned orders.py: it joins the PIN — paths ∪, cs_ids ∪, h1 refreshed from R — and journals no ready pair.
    const cs2 = await humanEdit(fx, p, { 'orders.py': py('orders', ' # uses price, v2'), 'reports.py': py('reports', ' # orders report') });
    assert.deepEqual(cs2, [], 'no ready pair for CS2');
    const grown = core.holds.get(pin.id)!;
    assert.deepEqual(grown.paths, ['orders.py', 'pricing.py', 'reports.py']);
    const cs2Id = core.cs.table().cs.map((e) => e.cs_id).find((id) => id !== cs1[0])!;
    assert.deepEqual(grown.cs_ids, [cs1[0]!, cs2Id].sort());
    assert.equal(grown.rev, rev1 + 1, 'one rev');
    assert.ok('h1' in grown.blobs);
    const disk = async (path: string): Promise<Oid> => core.repo.hashBytes((await readWork(p, path))!, false);
    assert.equal(grown.blobs.h1['orders.py'], await disk('orders.py'), 'h1 refreshed from R');
    assert.equal(grown.blobs.h1['reports.py'], await disk('reports.py'));
    assert.equal(grown.blobs.h1['pricing.py'], pin.blobs.h1['pricing.py']);
    assert.ok(!grown.guards.some((g) => g.name === `dependency:${pin.id}`), 'no dependency guard naming the record itself');
    assert.equal(core.view!.ready.some((x) => x.csId === cs2Id), false);
    await publish(fx, p);
    const ops = (await holdOpsSince(p, board1, await remoteTip(fx, p))).filter((x) => x.op.hold_id === pin.id);
    assert.equal(ops.length, 1, 'one hold op for the growth');
    assert.equal(await remoteLiveCode(fx, p), tip0, 'none of the three files changed on the live chain while held');
    // The claim PREDICATE releases (Task 12a's recordStep stood in): the group is re-captured and one commit carries all three files.
    claimed = false;
    await core.holds.releaseGuard(pin.id, `claim:${CLAIM}`);
    assert.equal(captureDue(core), true, 'the bundle is due for its recapture');
    const re = await capture(p);
    assert.deepEqual(re.captured.sort(), [cs1[0]!, cs2Id].sort());
    const r = await publish(fx, p);
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    const C = await core.repo.readCommit(r.c!);
    const changed = (await core.repo.run(['diff-tree', '--no-commit-id', '--name-only', '-r', C.parents[0]!, r.c!])).stdout.toString('utf8').trim().split('\n').sort();
    assert.deepEqual(changed, ['orders.py', 'pricing.py', 'reports.py']);
    assert.deepEqual(parseCsTrailers(C.trailers).cs.map((t) => t.csId).sort(), [cs1[0]!, cs2Id].sort(), 'both Cowork-CS trailers');
    const tree = await treeOf(p, r.c!);
    assert.equal(await blobText(p, tree, 'orders.py'), py('orders', ' # uses price, v2'));
    assert.ok(seen.length >= 2);
  });
});

test('with noSymbols a CS that only references a held name from a file outside the PIN publishes on its own', T10, async () => {
  const gate: PublishGatePort = {
    gate: async (_repo, _tip, _A, _R, paths) => (paths.includes('pricing.py') ? { block: { claimId: CLAIM } } : { block: null }),
    claimStillBlocks: async () => true,
  };
  await withCores('bundle-nosymbols', { n: 1, files: FILES, ports: { gate } }, async (fx) => {
    const p = fx.peers[0]!;
    await humanEdit(fx, p, { 'pricing.py': py('pricing', ' # def new_price()') });
    assert.equal((await publish(fx, p)).c, null);
    assert.equal(claimPins(p).length, 1);
    await humanEdit(fx, p, { 'invoice.py': py('invoice', ' # new_price()') });
    const r = await publish(fx, p);
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    const tree = await treeOf(p, r.c!);
    assert.equal(await blobText(p, tree, 'invoice.py'), py('invoice', ' # new_price()'));
    assert.equal(await blobText(p, tree, 'pricing.py'), py('pricing'), 'the held file stays A');
  });
});

test('HLD-48: while a CS has a non-terminal SHADOW none of its mid-turn passing captures is ready; at its stop T0 passing publishes the rest and T0 failing makes a PIN dependency:<shadow id>', T10, async () => {
  const pass: EditCheckPort = { check: async () => ({ verdict: 'pass' }) };
  const t0: T0RegionsPort = { check: async (_r, _t, _o, paths): Promise<T0Verdict> => (paths.includes('b.py') ? { pass: false, paths: ['b.py'], item: 2 } : { pass: true }) };
  await withCores('bundle-shadow', { n: 1, files: FILES, ports: { editCheck: pass, t0Regions: t0 } }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    const it0 = await prep(p);
    const shadowOf = async (seat: string): Promise<string> => core.holds.hold({
      ...shadowRecord(`claim:${CLAIM}`, 'shadow.py', it0.A.get('shadow.py')!.oid, await core.repo.hashBytes(buf(py('shadow', ` # denied for ${seat}`)), true), seat),
      cs_ids: [`${seat}/1`],
    });
    const sa = await shadowOf(SA);
    const sb = await shadowOf(SB);
    // Seat A's mid-turn passing capture is not ready while its SHADOW exists.
    for (const [seat, path] of [[SA, 'a.py'], [SB, 'b.py']] as const) {
      await writeWork(p, path, py(path.slice(0, 1), ` # ${seat.slice(0, 1)}`));
      queueSignal(core, effect(seat, [path]));
      await prep(p);
      queueSignal(core, { kind: 'checkpoint', seat, source: 'edit', candSeq: 1, paths: [path] });
    }
    const mid = await capture(p);
    assert.deepEqual(mid.captured.sort(), [`${SA}/1`, `${SB}/1`]);
    assert.ok(publicationGroups(core).every((g) => !g.ready), 'R3-42: not ready while a SHADOW exists');
    const tip = await remoteLiveCode(fx, p);
    assert.equal((await publish(fx, p)).c, null);
    assert.equal(await remoteLiveCode(fx, p), tip);
    // The stops: A's T0 passes (the rest publishes, the request stays); B's T0 fails: a PIN dependency:<B's shadow id>.
    queueSignal(core, { kind: 'stop', seat: SA });
    queueSignal(core, { kind: 'stop', seat: SB });
    await capture(p);
    const r = await publish(fx, p);
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    const tree = await treeOf(p, r.c!);
    assert.equal(await blobText(p, tree, 'a.py'), py('a', ' # a'));
    assert.equal(await blobText(p, tree, 'b.py'), py('b'));
    assert.equal(r.k7.length, 1);
    const pin = core.holds.get(r.k7[0]!)!;
    assert.deepEqual([pin.kind, pin.paths, pin.guards.map((g) => g.name)], ['PIN', ['b.py'], [`dependency:${sb}`]]);
    assert.ok(core.holds.get(sa) !== undefined && core.holds.get(sa)!.state === 'PARKED', 'A\'s SHADOW (its request) stays');
    assert.equal(pin.guards.map(guardName)[0], 'dependency');
  });
});

test('HLD-66 shape: a wake-scope PIN made by pinCs over a wake CS\'s LIVE paths (origin wake) holds its whole group: nothing publishes, the disk is untouched, and heldPins lists it', T10, async () => {
  await withCores('bundle-wake', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    await writeWork(p, 'w.py', py('w', ' # woken'));
    await writeWork(p, 'a.py', py('a', ' # woken'));
    queueSignal(core, effect(SA, ['w.py', 'a.py'], 'wake'));
    await prep(p);
    queueSignal(core, { kind: 'stop', seat: SA });
    const { it } = await capture(p);
    const h1: BlobMap = {};
    for (const path of ['a.py', 'w.py']) setBlob(h1, path, it.mat!.sDiskMap.get(path)!.oid);
    const id = await core.holds.hold(pinCs('wake-scope', [`${SA}/1`], ['w.py'], it.A, h1, 'wake', 'none'));
    const rec = core.holds.get(id)!;
    assert.deepEqual([rec.origin, rec.paths, rec.guards.map((g) => g.name)], ['wake', ['w.py'], ['wake-scope']]);
    assert.deepEqual(heldPins(core.holds).map((x) => x.id), [id]);
    const tip = await remoteLiveCode(fx, p);
    for (let i = 0; i < 2; i++) assert.equal((await publish(fx, p)).c, null, 'nothing of the group publishes');
    assert.equal(await remoteLiveCode(fx, p), tip);
    assert.equal((await readWork(p, 'w.py'))!.toString('utf8'), py('w', ' # woken'), 'the disk untouched');
    assert.equal((await readWork(p, 'a.py'))!.toString('utf8'), py('a', ' # woken'));
  });
});
