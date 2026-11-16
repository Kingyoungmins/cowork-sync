// HLD-37 trailers of Plan 3 (Task 9): Cowork-CS with the 1-based seq, state checkpoint|closed, origin, checks from the
// latest checks_run, and one Cowork-Seat per contributing seat and human (glossary §5; 05 U6, I12 trailer half; rulings
// R3-40, R3-43). Seat CSs come from scripted signals (R3-05); every capture is followed by one landed publishStep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { liveCommitTrailers, parseCsTrailers, type CsTrailer } from '../../src/board/boardCommit.js';
import { newEpoch } from '../../src/board/ids.js';
import { applyStep } from '../../src/engine/apply.js';
import { captureStep, queueSignal } from '../../src/engine/csStep.js';
import { publishStep, type PublishReport } from '../../src/engine/publish.js';
import { readCsTable } from '../../src/engine/state.js';
import type { CommitInfo, TreeEntry } from '../../src/git/repo.js';
import { ChangeSets, HUMAN_CS_QUIET_MS } from '../../src/holds/changesets.js';
import type { CsSignal } from '../../src/holds/signals.js';
import { seededRandom } from '../../src/ports/random.js';
import { writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { buf, captureReady, lines, prep, pushCalls, withCores } from '../helpers/publishHelpers.js';
import { makeRepoFixture } from '../helpers/repoFixture.js';
import { VirtualClock } from '../sim/vclock.js';

const T10 = { timeout: 10 * 60_000 };
const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const C = 'c'.repeat(32);
const QUIET = 20_000;

const py = (name: string, tag = ''): string => lines(12, (i) => `${name}_${i} = ${i}${i === 4 ? tag : ''}`);
const FILES: Record<string, Buffer> = {
  'README.md': buf('# trailers fixture\n'),
  'a.py': buf(py('a')), 'b.py': buf(py('b')), 'c.py': buf(py('c')), 'h.py': buf(py('h')),
};

let tool = 0;
function effect(seat: string, paths: readonly string[], turnOrigin: 'prompt' | 'wake' = 'prompt'): CsSignal {
  return { kind: 'effect', seat, agent: null, toolUseId: `toolu_${++tool}`, paths, turnOrigin };
}

async function seatWrite(p: PeerFixture, seat: string, files: Record<string, string>, turnOrigin: 'prompt' | 'wake' = 'prompt'): Promise<void> {
  for (const [path, text] of Object.entries(files)) await writeWork(p, path, text);
  queueSignal(p.core, effect(seat, Object.keys(files), turnOrigin));
  await prep(p);
}

/** A materializing iteration and captureStep: the captured cs_ids. */
async function capture(p: PeerFixture): Promise<string[]> {
  return (await captureStep(p.core, await prep(p, true))).captured;
}

/** One publishStep in an open governor window. */
async function publish(fx: CoreFixture, p: PeerFixture): Promise<PublishReport> {
  await prep(p);
  fx.advance(6_000);
  return publishStep(p.core, await prep(p));
}

async function landed(fx: CoreFixture, p: PeerFixture): Promise<{ commit: CommitInfo; cs: CsTrailer[]; seats: string[] }> {
  const r = await publish(fx, p);
  assert.equal(r.outcome, 'landed', JSON.stringify(r));
  assert.ok(r.c !== null);
  const commit = await p.core.repo.readCommit(r.c);
  return { commit, cs: parseCsTrailers(commit.trailers).cs, seats: commit.trailers.filter((t) => t.key === 'Cowork-Seat').map((t) => t.value) };
}

test('05 U6: Cowork-CS trailers round-trip cs_id, state, seq, origin, checks and paths for a seat CS and a human CS', T10, async () => {
  const f = await makeRepoFixture('trailers-u6');
  try {
    const dir = join(f.paths.coworkDir, 'tmp');
    await mkdir(dir, { recursive: true });
    const scratch = join(dir, 'u6.index');
    const disk = new Map<string, TreeEntry>();
    for (const p of ['s1.py', 's2.py', 'h.py']) disk.set(p, { path: p, mode: '100644', oid: await f.repo.hashBytes(Buffer.from(`${p}\n`, 'utf8'), true) });
    const clock = new VirtualClock();
    const peer = '0123456789abcdef0123456789abcdef';
    const cs = new ChangeSets(peer, clock);
    cs.restore([], 4, null);
    // Seat A's third CS, wake-originated, with a green checks_run and one checkpoint publish behind it.
    for (const s of [effect(A, ['x1.py']), { kind: 'stop', seat: A }, effect(A, ['x2.py']), { kind: 'stop', seat: A }] as CsSignal[]) cs.signal(s);
    cs.signal(effect(A, ['s1.py', 's2.py'], 'wake'));
    cs.signal({ kind: 'checks_run', seat: A, ok: true });
    cs.signal({ kind: 'checkpoint', seat: A, source: 'green', candSeq: 1, paths: ['s1.py', 's2.py'] });
    const first = await cs.capture(f.repo, disk, new Map(), scratch, new Set(), []);
    assert.ok(first !== null && first.pairs.some((x) => x.csId === `${A}/3`));
    cs.published([`${A}/3`]);
    cs.signal(effect(A, ['s1.py'], 'wake'));
    cs.signal({ kind: 'checkpoint', seat: A, source: 'tool', candSeq: 2, paths: ['s1.py'] });
    await cs.capture(f.repo, disk, new Map(), scratch, new Set(), []);
    // The human CS <peer>/human/4, closed.
    cs.observe(['h.py']);
    clock.advance(HUMAN_CS_QUIET_MS);
    const h = await cs.capture(f.repo, disk, new Map(), scratch, new Set(), []);
    assert.ok(h !== null && h.pair !== null && h.pair.csId === `${peer}/human/4`);
    const want: CsTrailer[] = [
      { csId: `${A}/3`, state: 'checkpoint', seq: 2, origin: 'wake', checks: 'pass', paths: 2 },
      { csId: `${peer}/human/4`, state: 'closed', seq: 1, origin: 'human', checks: 'skipped', paths: 1 },
    ];
    const got = [cs.trailer(`${A}/3`, 2), cs.trailer(`${peer}/human/4`, 1)];
    assert.deepEqual(got, want);
    const csPaths = new Map([[`${A}/3`, ['s1.py', 's2.py']], [`${peer}/human/4`, ['h.py']]]);
    const writer = { peer, epoch: newEpoch(seededRandom('u6')), seq: 3 };
    const commit = await f.repo.commitTree({ tree: await f.repo.emptyTree(), parents: [], subject: 'u6', trailers: liveCommitTrailers(writer, [A, 'human'], got, csPaths, null) });
    const back = parseCsTrailers((await f.repo.readCommit(commit)).trailers);
    assert.deepEqual(back.cs, want);
    assert.deepEqual(back.paths.get(`${A}/3`), ['s1.py', 's2.py']);
    assert.deepEqual(back.paths.get(`${peer}/human/4`), ['h.py']);
  } finally {
    await f.cleanup();
  }
});

test('a CS with 257 paths carries no Cowork-CS-Paths and the receiver\'s IncomingCs covers the whole commit', T10, async () => {
  await withCores('trailers-257', { n: 2, files: FILES }, async (fx) => {
    const [p, q] = [fx.peers[0]!, fx.peers[1]!];
    const names = Array.from({ length: 257 }, (_, i) => `many/f${String(i).padStart(3, '0')}.txt`);
    for (const name of names) await writeWork(p, name, `${name}\n`);
    await prep(p);
    fx.advance(QUIET);
    assert.deepEqual(await capture(p), [`${p.core.peerId}/human/1`]);
    const { commit, cs } = await landed(fx, p);
    assert.deepEqual(cs, [{ csId: `${p.core.peerId}/human/1`, state: 'closed', seq: 1, origin: 'human', checks: 'skipped', paths: 257 }]);
    assert.equal(commit.trailers.some((t) => t.key === 'Cowork-CS-Paths'), false, 'no Cowork-CS-Paths over 256 paths');
    fx.advance(10_000);
    const r = await applyStep(q.core, await prep(q, 'auto'));
    assert.equal(r.ran, true);
    const incoming = r.incoming.find((x) => x.csId === `${p.core.peerId}/human/1`);
    assert.ok(incoming !== undefined);
    assert.deepEqual([...incoming.paths].sort(), [...names].sort(), 'the receiver\'s IncomingCs covers the whole commit');
  });
});

test('the first publish of a human CS carries seq=1 state=closed origin=human checks=skipped and Cowork-Seat: human', T10, async () => {
  await withCores('trailers-human', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, 'h.py', py('h', ' # human'));
    await prep(p);
    fx.advance(QUIET);
    const pair = await captureReady(p, await prep(p, true));
    const { cs, seats } = await landed(fx, p);
    assert.deepEqual(cs, [{ csId: pair.csId, state: 'closed', seq: 1, origin: 'human', checks: 'skipped', paths: 1 }]);
    assert.deepEqual(seats, ['human']);
  });
});

test('05 I12 trailer half: a seat CS published at a green checkpoint, then at a tool checkpoint, then at its stop carries seq=1 state=checkpoint checks=pass, seq=2 state=checkpoint checks=pass and seq=3 state=closed, with one Cowork-Seat line naming the seat', T10, async () => {
  await withCores('trailers-i12', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    const pick = (cs: CsTrailer[]): Omit<CsTrailer, 'paths'> => {
      assert.equal(cs.length, 1);
      const { paths: _paths, ...rest } = cs[0]!;
      return rest;
    };
    await seatWrite(p, A, { 'a.py': py('a', ' # v1') });
    queueSignal(core, { kind: 'checks_run', seat: A, ok: true });
    queueSignal(core, { kind: 'checkpoint', seat: A, source: 'green', candSeq: 1, paths: ['a.py'] });
    assert.deepEqual(await capture(p), [`${A}/1`]);
    let r = await landed(fx, p);
    assert.deepEqual(pick(r.cs), { csId: `${A}/1`, state: 'checkpoint', seq: 1, origin: 'prompt', checks: 'pass' });
    assert.deepEqual(r.seats, [A], 'one Cowork-Seat line naming the seat');
    await seatWrite(p, A, { 'a.py': py('a', ' # v2') });
    queueSignal(core, { kind: 'checkpoint', seat: A, source: 'tool', candSeq: 2, paths: ['a.py'] });
    assert.deepEqual(await capture(p), [`${A}/1`]);
    r = await landed(fx, p);
    assert.deepEqual(pick(r.cs), { csId: `${A}/1`, state: 'checkpoint', seq: 2, origin: 'prompt', checks: 'pass' });
    assert.deepEqual(r.seats, [A]);
    await seatWrite(p, A, { 'a.py': py('a', ' # v3') });
    queueSignal(core, { kind: 'stop', seat: A });
    assert.deepEqual(await capture(p), [`${A}/1`]);
    r = await landed(fx, p);
    assert.deepEqual(pick(r.cs), { csId: `${A}/1`, state: 'closed', seq: 3, origin: 'prompt', checks: 'pass' });
    assert.deepEqual(r.seats, [A]);
  });
});

test('a stop that changed nothing since the last published capture makes no push', T10, async () => {
  await withCores('trailers-q16', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    await seatWrite(p, A, { 'a.py': py('a', ' # v1') });
    queueSignal(core, { kind: 'checkpoint', seat: A, source: 'green', candSeq: 1, paths: ['a.py'] });
    await capture(p);
    await landed(fx, p);
    const pushes = pushCalls(p);
    queueSignal(core, { kind: 'stop', seat: A });
    await capture(p);
    const r = await publish(fx, p);
    assert.equal(r.outcome, 'nothing', JSON.stringify(r));
    assert.equal(pushCalls(p), pushes, 'P == A for the CS\'s paths: no trailer-only commit');
    assert.equal(core.cs.table().cs.some((e) => e.cs_id === `${A}/1`), false, 'the closed CS left the table');
  });
});

test('a CS of a wake-originated turn carries origin=wake and a prompt-originated one origin=prompt', T10, async () => {
  await withCores('trailers-origin', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    await seatWrite(p, A, { 'a.py': py('a', ' # wake') }, 'wake');
    await seatWrite(p, B, { 'b.py': py('b', ' # prompt') }, 'prompt');
    queueSignal(core, { kind: 'stop', seat: A });
    queueSignal(core, { kind: 'stop', seat: B });
    assert.deepEqual((await capture(p)).sort(), [`${A}/1`, `${B}/1`]);
    const { cs, seats } = await landed(fx, p);
    assert.deepEqual(cs.map((c) => [c.csId, c.origin]).sort(), [[`${A}/1`, 'wake'], [`${B}/1`, 'prompt']]);
    assert.deepEqual(seats, [A, B]);
  });
});

test('checks follows the latest checks_run before the capture: green then failing then capture gives checks=fail, failing then green gives checks=pass, none gives checks=skipped', T10, async () => {
  await withCores('trailers-checks', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    await seatWrite(p, A, { 'a.py': py('a', ' # A') });
    await seatWrite(p, B, { 'b.py': py('b', ' # B') });
    await seatWrite(p, C, { 'c.py': py('c', ' # C') });
    for (const s of [
      { kind: 'checks_run', seat: A, ok: true }, { kind: 'checks_run', seat: A, ok: false },
      { kind: 'checks_run', seat: B, ok: false }, { kind: 'checks_run', seat: B, ok: true },
    ] as CsSignal[]) queueSignal(core, s);
    for (const seat of [A, B, C]) queueSignal(core, { kind: 'checkpoint', seat, source: 'green', candSeq: 1, paths: [] });
    assert.deepEqual((await capture(p)).sort(), [`${A}/1`, `${B}/1`, `${C}/1`]);
    // A checks_run after the capture changes nothing the capture already took.
    queueSignal(core, { kind: 'checks_run', seat: C, ok: false });
    const { cs } = await landed(fx, p);
    assert.deepEqual(cs.map((c) => [c.csId, c.checks]).sort(), [[`${A}/1`, 'fail'], [`${B}/1`, 'pass'], [`${C}/1`, 'skipped']]);
  });
});

test('a publish carrying two CSs carries one Cowork-CS per CS and one Cowork-Seat per contributing seat and human', T10, async () => {
  await withCores('trailers-two', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    await seatWrite(p, A, { 'a.py': py('a', ' # seat') });
    await writeWork(p, 'h.py', py('h', ' # human'));
    await prep(p);
    fx.advance(QUIET);
    queueSignal(core, { kind: 'stop', seat: A });
    const captured = await capture(p);
    assert.deepEqual(captured.sort(), [`${A}/1`, `${core.peerId}/human/1`].sort());
    const { cs, seats } = await landed(fx, p);
    assert.deepEqual(cs.map((c) => c.csId).sort(), captured.sort(), 'one Cowork-CS per CS');
    assert.deepEqual(seats, [A, 'human'], 'one Cowork-Seat per contributing seat and human');
  });
});

test('fix round 1 (finding 3): a push-ok state update that fails rolls ChangeSets back fully: passing, the publish counts and the trailers are unchanged, and the resolution counts each publish once', T10, async () => {
  await withCores('trailers-okfail', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    // A/1 and the human CS share a.py. A/1 stays open, covered by a green checkpoint; the human CS closes after its 20 s quiet: one
    // passing capture of both (Plan 3 Task 10: only a passing capture is ready and publishes, HLD-39). The open A/1 stays in the
    // table after its publish, so its publish count shows whether the resolution counted the publish once.
    await seatWrite(p, A, { 'a.py': py('a', ' # seat') });
    await writeWork(p, 'a.py', py('a', ' # seat and human'));
    await prep(p);
    queueSignal(core, { kind: 'checks_run', seat: A, ok: true });
    queueSignal(core, { kind: 'checkpoint', seat: A, source: 'green', candSeq: 1, paths: ['a.py'] });
    fx.advance(QUIET);
    const human = `${core.peerId}/human/1`;
    assert.deepEqual((await capture(p)).sort(), [`${A}/1`, human].sort());
    const before = core.cs.table();
    assert.deepEqual(before.passing, { [`${A}/1`]: true, [human]: true });
    assert.deepEqual(before.cs.filter((e) => e.cs_id === `${A}/1`).map((e) => [e.state, e.covered, e.publishes]), [['open', true, 0]]);
    const trailersBefore = [core.cs.trailer(`${A}/1`, 1), core.cs.trailer(human, 1)];
    assert.deepEqual(trailersBefore.map((t) => [t.state, t.seq, t.origin]), [['checkpoint', 1, 'prompt'], ['closed', 1, 'human']]);
    // The push lands; the ok update's state commit fails (not a lost CAS): the push intent stays journaled.
    const commit = core.commit.bind(core);
    core.commit = async (t) => {
      if (t.intent?.kind === 'none' && t.laB !== undefined) throw new Error('injected ok update failure');
      return commit(t);
    };
    try {
      await prep(p);
      fx.advance(6_000);
      await assert.rejects(publishStep(core, await prep(p)), /injected/);
    } finally {
      core.commit = commit;
    }
    assert.equal(core.view!.intent.kind, 'push');
    assert.deepEqual(core.cs.table(), before, 'the in-memory table is the one before the ok update');
    assert.deepEqual([core.cs.trailer(`${A}/1`, 1), core.cs.trailer(human, 1)], trailersBefore, 'the trailers are unchanged');
    // The resolution of the kept push intent applies the ok update once.
    const r = await publish(fx, p);
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    const t = await readCsTable(core.repo, core.view!);
    assert.equal(t!.cs.some((e) => e.cs_id === human), false, 'the closed, fully published human CS left the table');
    assert.deepEqual(t!.passing, {});
    assert.equal(core.view!.intent.kind, 'none', 'the resolution applied the ok update');
    assert.deepEqual([t!.cs.find((e) => e.cs_id === `${A}/1`)?.state, t!.cs.find((e) => e.cs_id === `${A}/1`)?.publishes], ['open', 1], 'one publish counted once');
    assert.equal(core.cs.trailer(`${A}/1`, 1).seq, 2);
  });
});

test('published() raises the CS\'s publish count in the table written by the push-ok state update, and a closed, fully published CS leaves the table at that update', T10, async () => {
  await withCores('trailers-published', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    await seatWrite(p, A, { 'a.py': py('a', ' # v1') });
    queueSignal(core, { kind: 'checkpoint', seat: A, source: 'green', candSeq: 1, paths: ['a.py'] });
    await capture(p);
    let t = await readCsTable(core.repo, core.view!);
    assert.equal(t!.cs.find((e) => e.cs_id === `${A}/1`)!.publishes, 0);
    await landed(fx, p);
    t = await readCsTable(core.repo, core.view!);
    const e = t!.cs.find((x) => x.cs_id === `${A}/1`);
    assert.ok(e !== undefined);
    assert.deepEqual([e.state, e.publishes], ['open', 1], 'the push-ok update wrote the raised count');
    assert.equal(t!.orders[`${A}/1`], undefined, 'its pair left with the publish');
    await seatWrite(p, A, { 'a.py': py('a', ' # v2') });
    queueSignal(core, { kind: 'stop', seat: A });
    await capture(p);
    assert.equal((await readCsTable(core.repo, core.view!))!.cs.find((x) => x.cs_id === `${A}/1`)!.state, 'closed');
    await landed(fx, p);
    t = await readCsTable(core.repo, core.view!);
    assert.equal(t!.cs.some((x) => x.cs_id === `${A}/1`), false, 'a closed, fully published CS leaves the table');
    assert.deepEqual(core.view!.ready, []);
  });
});
