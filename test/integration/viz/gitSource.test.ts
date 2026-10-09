// The git room source, frames (Plan 8a Task 7; 12 §3.3.1–§3.3.4, §6; VIZ-06, VIZ-07, VIZ-11, VIZ-15; rulings R-V19, R-V69,
// R-V74): real boards written by tools/viz/boardWriter.ts (and by git plumbing where Plan 2's writer refuses to build the
// fixture) in clones on file:// remotes, read through VizGit and a runner spy. The 1,300-height board's per-oid reference
// covers sampled heights by default and every height with COWORK_VIZ_SLOW=1 (readBoardCommit costs four git processes per
// oid; 1,043 of them exceed a loaded CI leg's 60 s file budget). The poll side (changed, pinning, advance) is in
// gitSourcePoll.test.ts, kept apart so each file stays within that budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveShape, parseCsTrailers, readBoardCommit } from '../../../src/board/boardCommit.js';
import { CHECKPOINT_EVERY, parseFold, serializeFold, type FoldState } from '../../../src/board/fold.js';
import type { Oid } from '../../../src/git/oid.js';
import { foldFrame, toDraft, ZERO_PEER, type Frame, type FrameCode } from '../../../src/viz/model/frame.js';
import { BoardObjectMissingError } from '../../../src/viz/source/git.js';
import { BoardWriter } from '../../../tools/viz/boardWriter.js';
import { makeRepoFixture, type RepoFixture } from '../../helpers/repoFixture.js';
import { testRunner } from '../../helpers/tmp.js';
import { chain, commitBytes, hashRaw, mktree, NOT_STORED } from '../../helpers/vizBatchRead.js';
import { collect, script, sourceOf, type SpiedVizGit } from '../../helpers/vizSource.js';

const SLOW = process.env['COWORK_VIZ_SLOW'] === '1';

/**
 * The frame at h folded from `before` with the draft readBoardCommit gives for its oid and the live-commit facts of its
 * live commit, read alone (GitRepo.readCommit) — the per-oid reference of the batched source.
 */
async function referenceFrame(fx: RepoFixture, oids: readonly Oid[], h: number, before: FoldState): Promise<Frame> {
  const data = await readBoardCommit(fx.repo, oids[h]!);
  const live = await fx.repo.readCommit(data.liveCode);
  const prevLive = h === 0 ? null : (await readBoardCommit(fx.repo, oids[h - 1]!)).liveCode;
  const changed = prevLive !== null && data.liveCode !== prevLive;
  const bases = live.trailers.filter((t) => t.key === 'Cowork-Base').map((t) => t.value);
  const code: FrameCode = {
    changed, shape: h === 0 ? liveShape(live, null) : changed ? liveShape(live, prevLive) : null,
    seats: live.trailers.filter((t) => t.key === 'Cowork-Seat').map((t) => t.value), base: bases.length === 1 ? bases[0]! : null,
  };
  const csPaths = parseCsTrailers((await fx.repo.readCommit(oids[h]!)).trailers).paths;
  return foldFrame(before, { height: h, oid: oids[h]!, draft: toDraft(data), csPaths, code, malformed: false }, ZERO_PEER);
}

/** Every `cat-file --batch-check` call's board items: its stdin lines naming `<oid>^{tree}`. */
const batchItems = (sg: SpiedVizGit): number[] =>
  sg.calls.filter((c) => c.args[0] === 'cat-file' && c.args[1] === '--batch-check').map((c) => c.stdin.split('\n').filter((l) => l.endsWith('^{tree}')).length);

test('git source frames equal folding readBoardCommit per oid', async (t) => {
  const fx = await makeRepoFixture('viz-gitsrc-1300');
  try {
    const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'main', seed: 'gitsrc-1300' });
    await w.genesis('ann');
    await w.join('bob');
    await w.commitMany(script(1_298));
    assert.equal(w.tip().height, 1_299);
    const oids = await chain(fx.repo, w.tip().oid);
    const { src, sg } = sourceOf(fx, w.ref);

    const tip = await src.tip();
    assert.deepEqual(tip, { height: 1_299, key: w.tip().oid });
    const s256 = await src.startAt(256);
    assert.deepEqual(s256, parseFold((await readBoardCommit(fx.repo, oids[256]!)).checkpoint!), 'startAt(256) = parseFold of the height-256 checkpoint');
    const before = sg.calls.length;
    const frames = await collect(src.frames(s256, 257, 1_299, ZERO_PEER));
    assert.deepEqual(frames.map((f) => f.height), Array.from({ length: 1_043 }, (_, i) => 257 + i));
    const reads = batchItems({ ...sg, calls: sg.calls.slice(before) });
    assert.ok(reads.length >= 1 && reads.every((n) => n <= 1_280), `batches ≤ 1,280: ${JSON.stringify(reads)}`);
    assert.equal(frames[0]!.before, s256, 'the first frame folds from the start state');
    for (let i = 1; i < frames.length; i++) assert.equal(frames[i]!.before, frames[i - 1]!.after, `height ${frames[i]!.height}: one chain of states`);
    for (const f of frames) {
      assert.equal(f.oid, oids[f.height]);
      assert.equal(f.malformed, false);
      assert.equal(f.protoMismatch, false);
      assert.equal(f.checkpoint, f.height % CHECKPOINT_EVERY === 0 ? 'match' : null, `height ${f.height}: the PRO-28 compare with the writer's own checkpoint`);
    }
    assert.deepEqual(frames[frames.length - 1]!.after, w.fold(), 'the tip state equals the writer\'s own fold');

    // From height 0: two batches (1,280 + 20), the same frames above 256 and the same tip state.
    const s0 = await src.startAt(0);
    const at0 = sg.calls.length;
    const all = await collect(src.frames(s0, 0, 1_299, ZERO_PEER));
    assert.deepEqual(batchItems({ ...sg, calls: sg.calls.slice(at0) }), [1_280, 20]);
    const strip = (f: Frame): unknown => ({ ...f, before: null, after: null });
    assert.deepEqual(all.slice(257).map(strip), frames.map(strip));
    assert.deepEqual(all[all.length - 1]!.after, w.fold());

    // The per-oid reference (readBoardCommit and readCommit for each oid, folded from the same state).
    const sample = SLOW ? frames.map((f) => f.height) : [0, 1, 2, 3, 257, 258, 300, 511, 512, 513, 767, 768, 1_023, 1_024, 1_279, 1_280, 1_281, 1_298, 1_299];
    if (!SLOW) t.diagnostic(`per-oid reference over ${sample.length} sampled heights (COWORK_VIZ_SLOW=1: every height)`);
    for (const h of sample) {
      const got = h <= 256 ? all[h]! : frames[h - 257]!;
      assert.deepEqual(await referenceFrame(fx, oids, h, got.before), got, `height ${h}`);
    }
  } finally {
    await fx.cleanup();
  }
});

test('a missing live commit stops the batch; a not_commit or over-cap live commit gives shape null', async () => {
  const fx = await makeRepoFixture('viz-gitsrc-malformed');
  try {
    const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'main', seed: 'gitsrc-malformed' });
    await w.genesis('ann');
    await w.commit({ writer: 'ann', cs: [{ paths: ['src/a.txt'] }] });   // 1
    await w.malformed('live_not_commit');                                 // 2
    await w.commit({ writer: 'ann', cs: [{ paths: ['src/b.txt'] }] });   // 3
    await w.malformed('live_three_parents');                              // 4
    await w.malformed('board_ops_too_large');                             // 5
    await w.commit({ writer: 'ann' });                                    // 6: board-only, after a no-op draft
    await w.commit({ writer: 'ann', cs: [{ paths: ['src/c.txt'] }] });   // 7
    const { src } = sourceOf(fx, w.ref);
    const tip = (await src.tip())!;
    assert.equal(tip.height, 7);
    const frames = await collect(src.frames(await src.startAt(0), 0, 7, ZERO_PEER));
    // Height 3's live commit continues the live chain from height 1's, not from the tag height 2 named: no live step from the
    // previous liveCode, so its shape is null too (liveShape(live commit, previous liveCode), 12 §3.3.4).
    assert.deepEqual(frames.map((f) => [f.code.changed, f.code.shape, f.malformed]), [
      [false, 'genesis', false], [true, 'ordinary', false], [true, null, false], [true, null, false],
      [true, null, false], [false, null, true], [false, null, false], [true, 'ordinary', false],
    ]);
    // R-V19: the over-cap board commit folds as the no-op draft of the previous draft.
    const noop = frames[5]!;
    assert.deepEqual([noop.writer, noop.ops, noop.cs, [...noop.csPaths], noop.code], [null, [], [], [], { changed: false, shape: null, seats: [], base: null }]);
    assert.deepEqual(noop.after.peers, noop.before.peers);
    // The frame after it compares with the live commit the no-op draft carried (unchanged), then folds on.
    assert.equal(frames[7]!.after.height, 7);

    // A board commit naming a live commit the store lacks (a partial clone): the batch stops before any of its frames.
    const top = await fx.repo.readCommit(w.tip().oid);
    const bad = await hashRaw(fx, 'commit', commitBytes(top.tree, [w.tip().oid, NOT_STORED], 'board\n'));
    const good = await hashRaw(fx, 'commit', commitBytes(top.tree, [bad, top.parents[1]!], 'board\n'));
    await fx.repo.run(['update-ref', w.ref, good]);
    const { src: s2 } = sourceOf(fx, w.ref);
    const t2 = (await s2.tip())!;
    assert.equal(t2.height, 9);
    const yielded: Frame[] = [];
    await assert.rejects(async () => {
      for await (const f of s2.frames(await s2.startAt(0), 0, 9, ZERO_PEER)) yielded.push(f);
    }, (e: unknown) => e instanceof BoardObjectMissingError && e.height === 8);
    assert.deepEqual(yielded, [], 'nothing of the batch is yielded');
    // Heights below it still fold.
    assert.equal((await collect(s2.frames(await s2.startAt(0), 0, 7, ZERO_PEER))).length, 8);
  } finally {
    await fx.cleanup();
  }
});

/**
 * A board written with git plumbing (Plan 2's writer refuses both fixtures): `n` board-only commits on top of `prev` naming
 * the live commit `live`, each tree = ops.jsonl (empty) + protocol.json (`protocol`) + checkpoint/ (`checkpoint`).
 */
async function handBoard(fx: RepoFixture, o: { prev: Oid | null; live: Oid; protocol: Oid; checkpoint: Oid; n: number }): Promise<Oid> {
  const ops = await hashRaw(fx, 'blob', Buffer.alloc(0));
  const tree = await mktree(fx, [['100644', 'ops.jsonl', ops], ['100644', 'protocol.json', o.protocol], ['040000', 'checkpoint', o.checkpoint]]);
  let prev = o.prev;
  for (let i = 0; i < o.n; i++) prev = await hashRaw(fx, 'commit', commitBytes(tree, prev === null ? [o.live] : [prev, o.live], `board ${i}\n`));
  return prev!;
}

test('T-VIZ-version (source): a board with proto = 2 reports protoMismatch on every frame; a corrupted checkpoint reports mismatch and folding continues', async () => {
  const fx = await makeRepoFixture('viz-gitsrc-version');
  try {
    // proto = 2 from genesis (PRO-47: fold on, never wrong state).
    const head = await fx.repo.readCommit((await fx.repo.resolve('refs/heads/main'))!);
    const l0 = await hashRaw(fx, 'commit', commitBytes(head.tree, [], 'live\n'));
    const proto2 = await hashRaw(fx, 'blob', Buffer.from('{"G_s":5,"S_s":1.5,"budget":12,"proto":2,"regionSpec":"rs-1"}', 'utf8'));
    const ckBlob = await hashRaw(fx, 'blob', Buffer.from('not a fold state', 'utf8'));
    const ckTree = await mktree(fx, [['100644', 'state.json', ckBlob]]);
    const b0 = await handBoard(fx, { prev: null, live: l0, protocol: proto2, checkpoint: ckTree, n: 1 });
    const tip2 = await handBoard(fx, { prev: b0, live: l0, protocol: proto2, checkpoint: ckTree, n: 3 });
    await fx.repo.run(['update-ref', 'refs/cowork-remote/proto2/board', tip2]);
    const { src: p2 } = sourceOf(fx, 'refs/cowork-remote/proto2/board');
    const t2 = (await p2.tip())!;
    assert.equal(t2.height, 3);
    const pf = await collect(p2.frames(await p2.startAt(0), 0, 3, ZERO_PEER));
    assert.deepEqual(pf.map((f) => f.protoMismatch), [true, true, true, true]);
    assert.ok(pf.every((f) => f.after.proto === 2));
    assert.equal(pf[0]!.checkpoint, 'mismatch', 'a checkpoint that is not the fold');

    // A corrupted checkpoint at 256 on a Plan 2 board: mismatch there, the next frame folds on.
    const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'main', seed: 'gitsrc-version' });
    await w.genesis('ann');
    await w.join('bob');
    await w.commitMany(script(254));
    assert.equal(w.tip().height, 255);
    const t255 = await fx.repo.readCommit(w.tip().oid);
    const protocol = (await testRunner().run(['rev-parse', `${w.tip().oid}:protocol.json`], { class: 'local', cwd: fx.paths.workTree })).stdout.toString('utf8').trim() as Oid;
    const corrupt = await handBoard(fx, { prev: w.tip().oid, live: t255.parents[1]!, protocol, checkpoint: ckTree, n: 2 });
    await fx.repo.run(['update-ref', w.ref, corrupt]);
    const { src } = sourceOf(fx, w.ref);
    assert.equal((await src.tip())!.height, 257);
    const frames = await collect(src.frames(await src.startAt(0), 0, 257, ZERO_PEER));
    assert.deepEqual([frames[0]!.checkpoint, frames[256]!.checkpoint, frames[257]!.checkpoint], ['match', 'mismatch', null]);
    assert.equal(frames[257]!.after.height, 257, 'folding continues past the mismatch');
    assert.ok(frames.every((f) => !f.protoMismatch));
    // A window starting at the corrupted checkpoint folds up to it from the checkpoint below instead.
    assert.deepEqual(await src.startAt(256), frames[256]!.after);
    assert.ok(!serializeFold(frames[256]!.after).equals(Buffer.from('not a fold state')));
  } finally {
    await fx.cleanup();
  }
});
