// The recovered change-set (05-holds HLD-36; glossary §25 F2; 05 F2; rulings R3-05, R3-40, R3-69): when the open-CS table
// is lost (cs/<enc(b)>.json missing or naming an older state commit), every unpublished delta outside a ready pair forms one
// `recovered` CS with a human-class cs_id; the journaled table keeps the seats' turn_seq, the orders and readiness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { captureStep, queueSignal, readCsCache, writeCsCache } from '../../src/engine/csStep.js';
import { publishStep } from '../../src/engine/publish.js';
import { readCsTable } from '../../src/engine/state.js';
import { diffPaths } from '../../src/engine/treeDiff.js';
import { enc } from '../../src/git/enc.js';
import { ChangeSets } from '../../src/holds/changesets.js';
import type { CsSignal } from '../../src/holds/signals.js';
import { writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { buf, lines, prep, stateA, treeOf, withCores } from '../helpers/publishHelpers.js';

const T10 = { timeout: 10 * 60_000 };
const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const QUIET = 20_000;

const py = (name: string, tag = ''): string => lines(12, (i) => `${name}_${i} = ${i}${i === 4 ? tag : ''}`);
const FILES: Record<string, Buffer> = {
  'README.md': buf('# recovered fixture\n'),
  'a.py': buf(lines(12, (i) => (i === 3 ? 'def area(w, h):' : `a_${i} = ${i}`))),
  'b.py': buf(py('b')), 'c.py': buf(py('c')), 'n.py': buf(py('n')), 'x.py': buf(py('x')),
};

let tool = 0;
function effect(seat: string, paths: readonly string[]): CsSignal {
  return { kind: 'effect', seat, agent: null, toolUseId: `toolu_${++tool}`, paths, turnOrigin: 'prompt' };
}

async function seatWrite(p: PeerFixture, seat: string, files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) await writeWork(p, path, text);
  queueSignal(p.core, effect(seat, Object.keys(files)));
  await prep(p);
}

async function capture(p: PeerFixture): Promise<string[]> {
  return (await captureStep(p.core, await prep(p, true))).captured;
}

const cacheFile = (p: PeerFixture): string => join(p.deps.paths.coworkDir, 'cs', `${enc(p.deps.branch)}.json`);

/**
 * Seat A's first CS captured (x.py), then A/2 open mid-turn with effects on a.py (a signature change) and b.py; a human CS on
 * c.py is captured after that, so the journaled table names A/2 open and turn_seq 2; the cache is written for that state.
 */
async function midTurn(fx: CoreFixture, p: PeerFixture): Promise<void> {
  const core = p.core;
  await seatWrite(p, A, { 'x.py': py('x', ' # A/1') });
  queueSignal(core, { kind: 'stop', seat: A });
  assert.deepEqual(await capture(p), [`${A}/1`]);
  await seatWrite(p, A, { 'a.py': lines(12, (i) => (i === 3 ? 'def area(w, h, unit):' : `a_${i} = ${i}`)) });
  await seatWrite(p, A, { 'b.py': py('b', ' # A/2') });
  await writeWork(p, 'c.py', py('c', ' # human'));
  await prep(p);
  fx.advance(QUIET);
  assert.deepEqual(await capture(p), [`${core.peerId}/human/1`]);
  const t = await readCsTable(core.repo, core.view!);
  assert.deepEqual(t!.seats, { [A]: { turn_seq: 2 } });
  assert.deepEqual(t!.cs.find((e) => e.cs_id === `${A}/2`)?.paths, ['a.py', 'b.py']);
  await writeCsCache(core);
}

/**
 * The restart's restore with the given cache, then R-01's re-form: the unpublished deltas outside a ready pair (diff(A, S_disk)
 * minus the ready paths) are observed.
 */
async function restoreAndReform(p: PeerFixture, cache: Awaited<ReturnType<typeof readCsCache>>): Promise<void> {
  const core = p.core;
  const view = core.view!;
  core.cs.restore(view.ready, view.meta.cs_human_next, await readCsTable(core.repo, view), cache);
  const it = await prep(p, true);
  const ready = new Set(core.cs.ready().flatMap((r) => r.paths));
  core.cs.observe(diffPaths(it.A, it.mat!.sDiskMap).filter((q) => !ready.has(q)));
}

/** The recovered CS once captured: its table entry. */
function recoveredEntry(p: PeerFixture): { cs_id: string; paths: string[] } {
  const e = p.core.cs.table().cs.filter((x) => x.kind === 'recovered');
  assert.equal(e.length, 1, `one recovered CS: ${JSON.stringify(p.core.cs.table().cs)}`);
  return e[0]!;
}

test('05 F2: with cs/<enc(b)>.json deleted mid-turn, every unpublished delta outside a ready pair forms one recovered CS with a human-class cs_id, and the journaled turn_seq keeps the seat\'s next CS at <seat>/<turn_seq + 1>', T10, async () => {
  await withCores('rec-f2', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    await midTurn(fx, p);
    await unlink(cacheFile(p));
    assert.equal(await readCsCache(core), null);
    await restoreAndReform(p, null);
    assert.deepEqual([...core.cs.openPaths()].sort(), ['a.py', 'b.py'], 'one CS holds the unpublished deltas');
    assert.equal(core.cs.table().cs.some((e) => e.cs_id === `${A}/2`), false, 'A/2\'s membership is lost with the table');
    queueSignal(core, effect(A, ['n.py']));
    assert.ok(core.cs.table().cs.some((e) => e.cs_id === `${A}/3` && e.state === 'open'), 'the next effect opens A/3');
    core.cs.done();
    await capture(p);
    const rec = recoveredEntry(p);
    assert.match(rec.cs_id, new RegExp(`^${core.peerId}/human/2$`), 'a human-class cs_id');
    assert.deepEqual(rec.paths, ['a.py', 'b.py']);
  });
});

test('the recovered CS stays open while a seat reported MID_TURN or AWAITING_PERMISSION, closes 20 s after that seat\'s stop, and its capture publishes a.py and b.py in one commit', T10, async () => {
  await withCores('rec-midturn', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    await midTurn(fx, p);
    await unlink(cacheFile(p));
    await restoreAndReform(p, null);
    queueSignal(core, { kind: 'activity', seat: A, activity: 'MID_TURN' });
    for (let i = 0; i < 6; i++) {
      fx.advance(10_000);
      assert.deepEqual(await capture(p), [], `${(i + 1) * 10} s quiet while A is MID_TURN: still open`);
    }
    queueSignal(core, { kind: 'activity', seat: A, activity: 'AWAITING_PERMISSION' });
    fx.advance(30_000);
    assert.equal(core.cs.closeDue(), false, 'AWAITING_PERMISSION keeps it open too');
    queueSignal(core, { kind: 'stop', seat: A });
    fx.advance(QUIET);
    const captured = await capture(p);
    const rec = recoveredEntry(p);
    assert.ok(captured.includes(rec.cs_id), 'captured');
    await prep(p);
    fx.advance(6_000);
    const r = await publishStep(core, await prep(p));
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    const parent = (await core.repo.readCommit(r.c!)).parents[0]!;
    const changed = diffPaths(await treeOf(p, parent), await treeOf(p, r.c!));
    assert.ok(changed.includes('a.py') && changed.includes('b.py'), `one live commit holds both files: ${JSON.stringify(changed)}`);
  });
});

test('with no seat activity the recovered CS closes after 20 s quiet like the human CS, and done() closes it at once', T10, async () => {
  await withCores('rec-quiet', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    await midTurn(fx, p);
    await unlink(cacheFile(p));
    await restoreAndReform(p, null);
    fx.advance(QUIET - 1);
    assert.equal(core.cs.closeDue(), false);
    fx.advance(1);
    assert.equal(core.cs.closeDue(), true, '20 s quiet with no seat MID_TURN or AWAITING_PERMISSION');
    await capture(p);
    assert.deepEqual(recoveredEntry(p).paths, ['a.py', 'b.py']);

    // done() closes a recovered CS at once.
    await writeCsCache(core);
    await unlink(cacheFile(p));
    const view = core.view!;
    core.cs.restore(view.ready, view.meta.cs_human_next, await readCsTable(core.repo, view), null);
    core.cs.observe(['n.py']);
    assert.equal(core.cs.closeDue(), false);
    core.cs.done();
    assert.equal(core.cs.closeDue(), true, 'done() closes it at once');
  });
});

test('a stale cache naming an older state commit is treated as lost; a fresh one restores the open seat CS with its members', T10, async () => {
  await withCores('rec-stale', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    await midTurn(fx, p);
    // Fresh: A/2 comes back open with its members; nothing is recovered. The restart's R-01 re-form then observes every
    // unpublished delta outside a ready pair, A/2's paths included: they stay with A/2 (fix round 1, finding 4).
    const fresh = await readCsCache(core);
    assert.ok(fresh !== null);
    await restoreAndReform(p, fresh);
    const a2 = core.cs.table().cs.find((e) => e.cs_id === `${A}/2`);
    assert.ok(a2 !== undefined);
    assert.deepEqual([a2.state, a2.paths], ['open', ['a.py', 'b.py']]);
    assert.deepEqual(core.cs.counts(), { open: 1, ready: 2 }, 'the re-form opens no human CS over A/2\'s paths');
    assert.deepEqual([...core.cs.openPaths()].sort(), ['a.py', 'b.py']);
    fx.advance(QUIET);
    assert.equal(core.cs.closeDue(), false, 'nothing closes on a 20 s timer while A/2 is open');
    await seatWrite(p, A, { 'n.py': py('n', ' # A/2 after the restart') });
    assert.deepEqual(core.cs.table().cs.find((e) => e.cs_id === `${A}/2`)?.paths, ['a.py', 'b.py', 'n.py'], 'the seat\'s next effect extends A/2');
    assert.equal(core.cs.table().cs.some((e) => e.kind === 'recovered'), false);
    assert.deepEqual(core.cs.counts(), { open: 1, ready: 2 }, 'nothing is recovered');
    // Stale: a later state commit without a cache rewrite.
    fx.advance(1_000);
    await core.commit({ meta: { ...core.view!.meta } });
    assert.equal(await readCsCache(core), null, 'a cache naming an older state commit reads as lost');
    await restoreAndReform(p, null);
    assert.equal(core.cs.table().cs.some((e) => e.cs_id === `${A}/2`), false);
    core.cs.done();
    await capture(p);
    assert.deepEqual(recoveredEntry(p).paths, ['a.py', 'b.py', 'n.py']);
  });
});

test('a seat effect after recovery opens a new seat CS covering only its own paths', T10, async () => {
  await withCores('rec-newseat', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    await midTurn(fx, p);
    await unlink(cacheFile(p));
    await restoreAndReform(p, null);
    await seatWrite(p, A, { 'n.py': py('n', ' # after the loss') });
    const a3 = core.cs.table().cs.find((e) => e.cs_id === `${A}/3`);
    assert.ok(a3 !== undefined);
    assert.deepEqual(a3.paths, ['n.py']);
    queueSignal(core, { kind: 'stop', seat: A });
    assert.deepEqual(await capture(p), [`${A}/3`], 'the recovered CS is not part of A/3\'s capture');
    assert.deepEqual(core.view!.ready.find((x) => x.csId === `${A}/3`)?.paths, ['n.py']);
    // Fix round 1 (findings 1–2): the recovered CS has its human-class cs_id from its creation, so the table and the cache list it.
    assert.deepEqual(core.cs.table().cs.filter((e) => e.kind === 'recovered').map((e) => [e.state, e.paths]), [['open', ['a.py', 'b.py']]], 'the recovered CS is still open');
    assert.deepEqual([...core.cs.openPaths()].sort(), ['a.py', 'b.py']);
  });
});

/** A restart: a new process's ChangeSets (no in-memory table, activity or claims) restored from the journal and the cache, then R-01's re-form. */
async function restart(p: PeerFixture, cache: Awaited<ReturnType<typeof readCsCache>>): Promise<void> {
  (p.core as { cs: ChangeSets }).cs = new ChangeSets(p.core.peerId, p.clock, p.fs);
  await restoreAndReform(p, cache);
}

test('fix round 1 (findings 1–2): an open recovered CS is carried by the cache: after a restart with a fresh cache it is still the recovered CS, waits while its seat is MID_TURN and closes at that seat\'s stop', T10, async () => {
  await withCores('rec-cache', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await midTurn(fx, p);
    await unlink(cacheFile(p));
    await restoreAndReform(p, null);
    queueSignal(p.core, { kind: 'activity', seat: A, activity: 'MID_TURN' });
    // A's next effect opens A/3: a membership change, so the cache is written (it now names the current state commit).
    await seatWrite(p, A, { 'n.py': py('n', ' # A/3') });
    await writeCsCache(p.core);
    const fresh = await readCsCache(p.core);
    assert.ok(fresh !== null, 'a fresh cache');
    await restart(p, fresh);
    const core = p.core;
    assert.deepEqual(core.cs.table().cs.filter((e) => e.kind === 'recovered').map((e) => [e.state, e.paths]), [['open', ['a.py', 'b.py']]], 'the recovered CS keeps its kind');
    assert.deepEqual(core.cs.table().cs.find((e) => e.cs_id === `${A}/3`)?.paths, ['n.py']);
    assert.deepEqual(core.cs.counts(), { open: 2, ready: 2 }, 'no human CS re-forms beside them');
    // The seat reports its activity again after the restart.
    queueSignal(core, { kind: 'activity', seat: A, activity: 'MID_TURN' });
    for (let i = 0; i < 6; i++) {
      fx.advance(10_000);
      assert.deepEqual(await capture(p), [], `${(i + 1) * 10} s while A is MID_TURN: nothing is captured`);
    }
    queueSignal(core, { kind: 'stop', seat: A });
    const captured = await capture(p);
    const rec = recoveredEntry(p);
    assert.deepEqual(captured.sort(), [`${A}/3`, rec.cs_id].sort(), 'A\'s stop releases the recovered CS');
    assert.deepEqual(core.view!.ready.find((x) => x.csId === rec.cs_id)?.paths, ['a.py', 'b.py']);
  });
});

/**
 * restart.ts's tail in its order, with the cache the restart reads (R3-69's attachCsTable, Task 12a, stands in for the restore): a
 * new process's ChangeSets restored from the journal and the cache, the private index reseeded from state:snap (the snapshot's
 * dirty set cleared, so the first tick reports every path whose disk differs from snap), then reformOpenCs's observe of the LIVE
 * paths where A ≠ snap outside the ready pairs.
 */
async function restartReseeded(p: PeerFixture, cache: Awaited<ReturnType<typeof readCsCache>>, beforeReform: () => Promise<void>): Promise<void> {
  (p.core as { cs: ChangeSets }).cs = new ChangeSets(p.core.peerId, p.clock, p.fs);
  const core = p.core;
  const view = core.view!;
  core.cs.restore(view.ready, view.meta.cs_human_next, await readCsTable(core.repo, view), cache);
  await beforeReform();
  await core.snapshot.reseed(view.snap);
  const ready = new Set(core.cs.ready().flatMap((r) => r.paths));
  core.cs.observe(diffPaths(await stateA(p), await core.repo.readTreeMap(view.snap)).filter((q) => !ready.has(q)));
}

// Fix round 2: an effect of the restored seat must not end the restored paths' attribution. Its claims hold only its own paths
// and live for one observe(); the restored paths a.py and b.py are reported again by the first tick after the reseed.
const ROUND2 = [
  { name: 'an effect on a new path between the re-form and the first tick', label: 'rec-reseed-new', when: 'tick', path: 'n.py', text: py('n', ' # A/2 after the restart') },
  { name: 'an effect on a restored path before the re-form (its claim ends at the re-form\'s observe)', label: 'rec-reseed-old', when: 'reform', path: 'a.py', text: lines(12, (i) => (i === 3 ? 'def area(w, h, unit, scale):' : `a_${i} = ${i}`)) },
] as const;

for (const v of ROUND2) {
  test(`fix round 2: after a restart that restores the open seat CS from a fresh cache, ${v.name} keeps every restored path with the seat CS at the first tick, never on a 20 s human timer`, T10, async () => {
    await withCores(v.label, { n: 1, files: FILES }, async (fx) => {
      const p = fx.peers[0]!;
      await midTurn(fx, p);
      const fresh = await readCsCache(p.core);
      assert.ok(fresh !== null, 'a fresh cache');
      // Claude's next tool call lands during the restart's tail or before the loop's first tick.
      const toolCall = async (): Promise<void> => {
        await writeWork(p, v.path, v.text);
        queueSignal(p.core, effect(A, [v.path]));
      };
      await restartReseeded(p, fresh, v.when === 'reform' ? toolCall : async () => {});
      const core = p.core;
      if (v.when === 'tick') {
        assert.deepEqual(core.cs.table().cs.find((e) => e.cs_id === `${A}/2`)?.paths, ['a.py', 'b.py'], 'A/2 is restored open');
        await toolCall();
      }
      const a2 = [...new Set(['a.py', 'b.py', v.path])].sort();
      // The first tick after the reseed compares the disk with snap, which predates A/2: a.py and b.py are reported as changed.
      const it = await prep(p);
      const changed = [...(it.tick?.changed ?? [])].sort();
      assert.ok(a2.every((q) => changed.includes(q)), `the first tick reports A/2's paths: ${JSON.stringify(changed)}`);
      assert.deepEqual(core.cs.table().cs.find((e) => e.cs_id === `${A}/2`)?.paths, a2, 'A/2 keeps its restored paths and takes the effect\'s');
      // The same tick also reports c.py and x.py (snap predates the unpublished ready pairs A/1 and human/1 too), which open a
      // human CS by Plan 2's first-tick rule (counts().open is 2 here); so the discriminating checks run at that CS's 20 s close.
      fx.advance(QUIET);
      const captured = await capture(p);
      assert.equal(captured.includes(`${A}/2`), false, `A/2 is not captured on a 20 s timer: ${JSON.stringify(captured)}`);
      assert.equal(core.view!.ready.some((r) => r.paths.includes('a.py') || r.paths.includes('b.py')), false, `no pair carries A/2's paths before its stop: ${JSON.stringify(core.view!.ready)}`);
      assert.equal(core.cs.counts().open, 1, 'A/2 is the only open CS');
      assert.deepEqual([...core.cs.openPaths()].sort(), a2);
      fx.advance(QUIET);
      assert.equal(core.cs.closeDue(), false, 'nothing closes on a 20 s timer while A/2 is open');
      // The seat's stop closes A/2 with every path, attributed to the seat alone.
      queueSignal(core, { kind: 'stop', seat: A });
      assert.deepEqual(await capture(p), [`${A}/2`]);
      assert.deepEqual(core.view!.ready.find((r) => r.csId === `${A}/2`)?.paths, a2);
    });
  });
}

test('fix round 1 (findings 1–2): a captureStep whose state update fails keeps an open recovered CS, with its kind and its HLD-36 close rule', T10, async () => {
  await withCores('rec-rollback', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    await midTurn(fx, p);
    await unlink(cacheFile(p));
    await restoreAndReform(p, null);
    queueSignal(core, { kind: 'activity', seat: A, activity: 'MID_TURN' });
    // Seat B's CS on n.py closes: a capture of another group is due.
    await seatWrite(p, B, { 'n.py': py('n', ' # B/1') });
    queueSignal(core, { kind: 'stop', seat: B });
    const view = core.view!;
    const commit = core.commit.bind(core);
    core.commit = async () => {
      throw new Error('injected state update failure');
    };
    try {
      await assert.rejects(captureStep(core, await prep(p, true)), /injected/);
    } finally {
      core.commit = commit;
    }
    assert.equal(core.view, view);
    assert.deepEqual(core.cs.table().cs.filter((e) => e.kind === 'recovered').map((e) => [e.state, e.paths]), [['open', ['a.py', 'b.py']]], 'the recovered CS keeps its kind');
    assert.deepEqual(await capture(p), [`${B}/1`], 'B/1\'s capture runs again');
    for (let i = 0; i < 6; i++) {
      fx.advance(10_000);
      assert.deepEqual(await capture(p), [], `${(i + 1) * 10} s while A is MID_TURN: the recovered CS stays open`);
    }
    queueSignal(core, { kind: 'stop', seat: A });
    const rec = recoveredEntry(p);
    assert.deepEqual(await capture(p), [rec.cs_id], 'A\'s stop releases it');
  });
});
