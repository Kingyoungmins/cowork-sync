// Readiness of publication groups (Plan 3 Task 10; 05-holds HLD-39, HLD-41 cases (i), (ii), (iv), 05 U11, P2, INV-HLD-READY, O-READY;
// contract addition 8): makeCores({n: 2}); peer 1 is the teammate whose publishes peer 0 applies. Seat CSs come from scripted
// signals (R3-05); a capture is a materializing iteration plus captureStep. Git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyStep, type ApplyReport } from '../../src/engine/apply.js';
import { type IterationCtx } from '../../src/engine/core.js';
import { captureStep, queueSignal } from '../../src/engine/csStep.js';
import { publishPending, publishStep, type PublishReport } from '../../src/engine/publish.js';
import { pinCs } from '../../src/holds/changesets.js';
import { setBlob, type BlobMap } from '../../src/holds/record.js';
import type { CsSignal } from '../../src/holds/signals.js';
import { gitCallsOf, readWork, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { buf, captureReady, lines, LogRecorder, prep, withCores } from '../helpers/publishHelpers.js';

const T10 = { timeout: 10 * 60_000 };
const SA = 'a'.repeat(32);
const SB = 'b'.repeat(32);
const NOTES = '# Notes\n\nl1\nl2\nl3\nl4\nl5\nl6\n';
const py = (name: string, tag = ''): string => lines(12, (i) => `${name}_${i} = ${i}${i === 4 ? tag : ''}`);
const FILES: Record<string, Buffer> = {
  'README.md': buf('# readiness fixture\n'),
  'notes.md': buf(NOTES), 'a.py': buf(py('a')), 'b.py': buf(py('b')), 'c.py': buf(py('c')), 'd.py': buf(py('d')), 'e.py': buf(py('e')),
  'f.py': buf(py('f')), 'g.py': buf(py('g')),
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

async function capture(p: PeerFixture): Promise<{ it: IterationCtx; captured: string[] }> {
  const it = await prep(p, true);
  return { it, captured: (await captureStep(p.core, it)).captured };
}

async function publish(fx: CoreFixture, p: PeerFixture): Promise<PublishReport> {
  fx.advance(6_000);
  return publishStep(p.core, await prep(p));
}

/** The teammate (peer 1) edits `files` as a human, captures after the 20 s quiet period and publishes; it must land. */
async function teammate(fx: CoreFixture, files: Record<string, string>): Promise<void> {
  const t = fx.peers[1]!;
  for (const [path, text] of Object.entries(files)) await writeWork(t, path, text);
  await prep(t);
  fx.advance(20_000);
  await captureReady(t, await prep(t, true));
  const r = await publish(fx, t);
  assert.equal(r.outcome, 'landed', `the teammate's publish: ${JSON.stringify(r)}`);
}

/** Peer 0's next admitted apply (≥ 10 s after the last). */
async function apply(fx: CoreFixture, p: PeerFixture): Promise<ApplyReport> {
  fx.advance(10_000);
  return applyStep(p.core, await prep(p));
}

const readyIds = (p: PeerFixture): string[] => p.core.view!.ready.map((x) => x.csId).sort();

/**
 * Two open seat CSs sharing a.py, A also holding notes.md (appended at the end): B's green checkpoint covers B, then A's passing
 * edit check makes the passing capture of the group.
 */
async function passingGroup(p: PeerFixture): Promise<void> {
  await seatWrite(p, SA, { 'notes.md': `${NOTES}seat v1\n`, 'a.py': py('a', ' # A') });
  await seatWrite(p, SB, { 'a.py': py('a', ' # A and B'), 'b.py': py('b', ' # B') });
  queueSignal(p.core, { kind: 'checkpoint', seat: SB, source: 'green', candSeq: 1, paths: [] });
  queueSignal(p.core, { kind: 'checkpoint', seat: SA, source: 'edit', candSeq: 1, paths: ['notes.md', 'a.py'] });
  await capture(p);
  assert.deepEqual(readyIds(p), [`${SA}/1`, `${SB}/1`]);
  assert.deepEqual(p.core.cs.table().passing, { [`${SA}/1`]: true, [`${SB}/1`]: true });
  assert.deepEqual(p.core.cs.groups([]).map((g) => g.ready), [true]);
}

test('05 U11 apply half: an apply that cleanly merges p after a post-capture member effect on p withdraws the whole passing capture of the group with no CS_READY_CANCELLED and no pair left, and the group is re-captured at an open member\'s next trigger', T10, async () => {
  await withCores('ready-u11-withdraw', { n: 2, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const log = new LogRecorder();
    p.deps.log = log;
    await passingGroup(p);
    // A member effect on notes.md after the capture: the heading, the appended line taken back.
    await seatWrite(p, SA, { 'notes.md': NOTES.replace('# Notes', '# NOTES') });
    await teammate(fx, { 'notes.md': `${NOTES}team\n` });
    const r = await apply(fx, p);
    assert.equal(r.ran, true);
    assert.deepEqual(r.written, ['notes.md'], 'a clean merge of the heading and the teammate\'s append');
    assert.equal((await readWork(p, 'notes.md'))!.toString('utf8'), `${NOTES.replace('# Notes', '# NOTES')}team\n`);
    assert.deepEqual(r.cancelled, []);
    assert.deepEqual(readyIds(p), [], 'the whole group\'s passing capture is withdrawn, never one pair alone');
    assert.equal(log.lines.some((l) => l.code === 'CS_READY_CANCELLED'), false, 'no message');
    assert.deepEqual(p.core.cs.groups([]).map((g) => g.ready), [false]);
    // A's next edit checkpoint re-captures the whole group (B is still covered).
    queueSignal(p.core, { kind: 'checkpoint', seat: SA, source: 'edit', candSeq: 2, paths: ['notes.md'] });
    await capture(p);
    assert.deepEqual(readyIds(p), [`${SA}/1`, `${SB}/1`]);
    assert.deepEqual(p.core.cs.groups([]).map((g) => g.ready), [true]);
  });
});

test('the same apply with no post-capture effect keeps the group ready with R[p] := M_disk[p]', T10, async () => {
  await withCores('ready-u11-keep', { n: 2, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await passingGroup(p);
    await teammate(fx, { 'notes.md': `${NOTES}team\n` });
    const r = await apply(fx, p);
    assert.deepEqual(r.written, ['notes.md']);
    const written = (await readWork(p, 'notes.md'))!;
    assert.equal(written.toString('utf8'), `${NOTES}team\nseat v1\n`, 'the D9 concat');
    assert.deepEqual(readyIds(p), [`${SA}/1`, `${SB}/1`], 'the group stays ready');
    const pair = p.core.view!.ready.find((x) => x.csId === `${SA}/1`)!;
    assert.equal((await p.core.repo.readTreeMap(pair.R)).get('notes.md')?.oid, await p.core.repo.hashBytes(written, false), 'R[p] := M_disk[p]');
    assert.deepEqual(p.core.cs.groups([]).map((g) => g.ready), [true]);
  });
});

test('05 P2: a closed, captured 2-CS group appends a helper at the end of notes.md and a peer\'s same-position append applies as a D9 concat before the push: the group stays ready with R = the written blob and the helper publishes with no new trigger', T10, async () => {
  await withCores('ready-p2', { n: 2, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await seatWrite(p, SA, { 'notes.md': `${NOTES}helper()\n`, 'a.py': py('a', ' # uses helper') });
    await seatWrite(p, SB, { 'a.py': py('a', ' # uses helper, B'), 'c.py': py('c', ' # B') });
    queueSignal(p.core, { kind: 'stop', seat: SA });
    queueSignal(p.core, { kind: 'stop', seat: SB });
    await capture(p);
    assert.deepEqual(readyIds(p), [`${SA}/1`, `${SB}/1`]);
    await teammate(fx, { 'notes.md': `${NOTES}peer note\n` });
    const r = await apply(fx, p);
    assert.deepEqual(r.written, ['notes.md']);
    const written = (await readWork(p, 'notes.md'))!;
    assert.equal(written.toString('utf8'), `${NOTES}peer note\nhelper()\n`);
    const pair = p.core.view!.ready.find((x) => x.csId === `${SA}/1`)!;
    assert.equal((await p.core.repo.readTreeMap(pair.R)).get('notes.md')?.oid, await p.core.repo.hashBytes(written, false));
    // No new trigger: the next window publishes the group in one commit.
    const pub = await publish(fx, p);
    assert.equal(pub.outcome, 'landed', JSON.stringify(pub));
    const tree = await p.core.repo.readTreeMap((await p.core.repo.readCommit(pub.c!)).tree);
    assert.equal((await p.core.repo.readBlob(tree.get('notes.md')!.oid)).toString('utf8'), `${NOTES}peer note\nhelper()\n`, 'the helper published');
    assert.equal((await p.core.repo.readBlob(tree.get('c.py')!.oid)).toString('utf8'), py('c', ' # B'));
    assert.deepEqual(readyIds(p), []);
  });
});

test('05 P2 displacing variant: overlapping edits applied as TAKE_TIP cancel the readiness of the whole all-closed group with CS_READY_CANCELLED and it is re-captured at the next completed snapshot', T10, async () => {
  await withCores('ready-p2-take', { n: 2, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const log = new LogRecorder();
    p.deps.log = log;
    await seatWrite(p, SA, { 'd.py': py('d', ' # local'), 'e.py': py('e', ' # A') });
    await seatWrite(p, SB, { 'e.py': py('e', ' # A and B') });
    queueSignal(p.core, { kind: 'stop', seat: SA });
    queueSignal(p.core, { kind: 'stop', seat: SB });
    await capture(p);
    assert.deepEqual(readyIds(p), [`${SA}/1`, `${SB}/1`]);
    // The teammate changes the same line of d.py: TAKE_TIP displaces the local side (K4).
    await teammate(fx, { 'd.py': py('d', ' # team') });
    const r = await apply(fx, p);
    assert.equal(r.ran, true);
    assert.deepEqual(r.cancelled.sort(), [`${SA}/1`, `${SB}/1`], 'the whole group');
    assert.deepEqual(log.lines.filter((l) => l.code === 'CS_READY_CANCELLED').map((l) => l.params['cs_id']).sort(), [`${SA}/1`, `${SB}/1`]);
    assert.deepEqual(readyIds(p), []);
    assert.equal(r.records.length, 1, 'a K4 record holds the displaced local side');
    // Every member is closed: the group is re-captured at the next completed snapshot, with no new trigger.
    assert.equal(p.core.cs.closeDue(), true);
    fx.advance(3_000);
    const re = await capture(p);
    assert.deepEqual(re.captured.sort(), [`${SA}/1`, `${SB}/1`]);
  });
});

test('a not-ready group makes publishPending false and no push is spawned', T10, async () => {
  await withCores('ready-pending', { n: 2, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    // A is open and uncovered; B (sharing f.py) closes: its closing capture of the group is not passing.
    await seatWrite(p, SA, { 'f.py': py('f', ' # A') });
    await seatWrite(p, SB, { 'f.py': py('f', ' # A and B'), 'g.py': py('g', ' # B') });
    queueSignal(p.core, { kind: 'stop', seat: SB });
    await capture(p);
    assert.deepEqual(readyIds(p), [`${SA}/1`, `${SB}/1`]);
    assert.deepEqual(p.core.cs.table().passing, { [`${SA}/1`]: false, [`${SB}/1`]: false });
    fx.advance(6_000);
    const it = await prep(p);
    assert.equal(await publishPending(p.core, it), false);
    const pushes = gitCallsOf(p).filter((c) => c.args[0] === 'push').length;
    const r = await publishStep(p.core, it);
    assert.equal(r.outcome, 'nothing', JSON.stringify(r));
    assert.equal(gitCallsOf(p).filter((c) => c.args[0] === 'push').length, pushes, 'no push');
  });
});

test('a peer whose only ready pairs are in not-ready groups reports pending = false to the governor', T10, async () => {
  await withCores('ready-governor', { n: 2, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    const seen: boolean[] = [];
    const gov = core.governor;
    const orig = gov.onFetch.bind(gov);
    gov.onFetch = (tip, revealed, firstOfRun, pending): void => {
      seen.push(pending);
      orig(tip, revealed, firstOfRun, pending);
    };
    const pendingNow = async (): Promise<boolean> => {
      seen.length = 0;
      await prep(p);
      assert.ok(seen.length > 0, 'a fetch reached the governor');
      return seen.every((x) => x);
    };
    // (a) an open uncovered member.
    await seatWrite(p, SA, { 'f.py': py('f', ' # A') });
    await seatWrite(p, SB, { 'f.py': py('f', ' # A and B') });
    queueSignal(core, { kind: 'stop', seat: SB });
    await capture(p);
    assert.equal(await pendingNow(), false, 'an open uncovered member');
    // (b) a held PIN over a closed, ready group.
    await writeWork(p, 'c.py', py('c', ' # human'));
    await prep(p);
    fx.advance(20_000);
    const { it: itC } = await capture(p);
    const human1 = `${core.peerId}/human/1`;
    assert.ok(readyIds(p).includes(human1));
    const h1c: BlobMap = {};
    setBlob(h1c, 'c.py', itC.mat!.sDiskMap.get('c.py')!.oid);
    await core.holds.hold(pinCs('join', [human1], ['c.py'], itC.A, h1c, 'human', 'none'));
    assert.equal(await pendingNow(), false, 'a held PIN');
    // (c) a dependency PIN over a closed, ready group (its target an eol-bom record on another path).
    await writeWork(p, 'd.py', py('d', ' # human'));
    await prep(p);
    fx.advance(20_000);
    const { it: itD } = await capture(p);
    const human2 = `${core.peerId}/human/2`;
    const target = await core.holds.hold({
      kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: ['README.md'], guard: 'eol-bom', origin: 'daemon', cs_ids: [], displaced_by: null,
      blobs: { h0: { 'README.md': itD.A.get('README.md')!.oid }, h1: { 'README.md': itD.A.get('README.md')!.oid } },
    });
    const h1d: BlobMap = {};
    setBlob(h1d, 'd.py', itD.mat!.sDiskMap.get('d.py')!.oid);
    await core.holds.hold(pinCs(`dependency:${target}`, [human2], ['d.py'], itD.A, h1d, 'human', 'none'));
    assert.equal(await pendingNow(), false, 'a dependency PIN');
    // One ready, unheld group: pending.
    await writeWork(p, 'e.py', py('e', ' # human'));
    await prep(p);
    fx.advance(20_000);
    await capture(p);
    assert.equal(await pendingNow(), true, 'one ready, unheld group');
  });
});
