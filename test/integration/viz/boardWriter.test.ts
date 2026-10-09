// tools/viz/boardWriter.ts: scripted boards over Plan 2's board writer (Plan 8a Task 2; V10, R-V19). Real git on a
// makeRepoFixture clone; every board is read back with Plan 2's readers and folded with the build's foldCommit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBoardReadFailure, readBoardCommits, readLiveCommits, type BoardRead, type BoardReadFailure, type LiveRead } from '../../../src/board/batchRead.js';
import { boardShapeOk, liveShape, readBoardCommit, BoardMalformedError, type BoardCommitData, type BoardDraft } from '../../../src/board/boardCommit.js';
import { CHECKPOINT_EVERY, foldCommit, initialFoldState, serializeFold, type FoldState } from '../../../src/board/fold.js';
import type { GitCallOptions } from '../../../src/git/flags.js';
import type { Oid } from '../../../src/git/oid.js';
import type { GitRepo } from '../../../src/git/repo.js';
import type { GitResult, GitRunner } from '../../../src/git/runner.js';
import { noopDraft, toDraft, ZERO_PEER } from '../../../src/viz/model/frame.js';
import { BoardWriter, type ScriptCommit } from '../../../tools/viz/boardWriter.js';
import { FIXTURE_WALL_MS, makeRepoFixture } from '../../helpers/repoFixture.js';

const SEAT = '5ea75ea75ea75ea75ea75ea75ea75ea7';

async function chainOf(repo: GitRepo, tip: Oid): Promise<Oid[]> {
  const r = await repo.run(['rev-list', '--first-parent', '--reverse', tip]);
  return r.stdout.toString('utf8').split('\n').filter((l) => l.length > 0) as Oid[];
}

/** The board chain from B0 (the L0 root of the first-parent walk dropped). */
async function boardChain(repo: GitRepo, tip: Oid): Promise<Oid[]> {
  return (await chainOf(repo, tip)).slice(1);
}

async function readAll(repo: GitRepo, oids: readonly Oid[]): Promise<BoardCommitData[]> {
  const out: BoardCommitData[] = new Array<BoardCommitData>(oids.length);
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < oids.length) {
      const i = next++;
      out[i] = await readBoardCommit(repo, oids[i]!);
    }
  }));
  return out;
}

/** The fold of a read-back chain from B0's protocol; states[h] after height h. */
function foldChain(commits: readonly BoardCommitData[]): FoldState[] {
  let s = initialFoldState(commits[0]!.protocol);
  return commits.map((c) => {
    s = foldCommit(s, toDraft(c), ZERO_PEER).state;
    return s;
  });
}

/** A chain from height 0 through readBoardCommits, round after round (R-V69), live commits included. */
async function readChain(repo: GitRepo, oids: readonly Oid[]): Promise<Array<BoardRead | BoardReadFailure>> {
  const out: Array<BoardRead | BoardReadFailure> = [];
  let prevLive: Oid | null = null;
  while (out.length < oids.length) {
    const { reads, next } = await readBoardCommits(repo, oids.slice(out.length).map((oid, i) => ({ oid, height: out.length + i })), { withLive: true, prevLive });
    assert.ok(next > 0);
    out.push(...reads);
    const lastRead = reads[reads.length - 1]!;
    prevLive = isBoardReadFailure(lastRead) ? null : lastRead.liveCode;
  }
  return out;
}

/** The fold of a read-back chain under R-V19: a malformed board commit folds as noopDraft(previous draft). */
function foldRV19(reads: ReadonlyArray<BoardRead | BoardReadFailure>): FoldState[] {
  const first = reads[0]!;
  assert.ok(!isBoardReadFailure(first));
  let s = initialFoldState(first.protocol);
  let prev: BoardDraft = toDraft(first);
  return reads.map((r, h) => {
    const d = h === 0 ? prev : isBoardReadFailure(r) ? noopDraft(prev) : toDraft(r);
    s = foldCommit(s, d, ZERO_PEER).state;
    prev = d;
    return s;
  });
}

/** `<name> <email> <secs> +0000` of a commit's author and committer lines. */
async function identityOf(repo: GitRepo, oid: string): Promise<{ author: string; committer: string }> {
  const raw = (await repo.run(['cat-file', '-p', oid])).stdout.toString('utf8');
  const line = (k: string): string => raw.split('\n').find((l) => l.startsWith(`${k} `))!.slice(k.length + 1);
  return { author: line('author'), committer: line('committer') };
}

/** A wallMs that returns a new second on every call (every commit object then has its own date). */
function ticking(): { wallMs: () => number; issued: number[] } {
  const issued: number[] = [];
  return { issued, wallMs: () => { const ms = FIXTURE_WALL_MS + issued.length * 1_000; issued.push(ms); return ms; } };
}

test('the board writer\'s boards pass boardShapeOk and liveShape and carry checkpoints that byte-match the fold', async () => {
  const fx = await makeRepoFixture('viz-boardwriter-shape');
  try {
    const clock = ticking();
    const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'main', seed: 'bw-shape', wallMs: clock.wallMs });
    assert.equal(w.ref, 'refs/cowork-remote/main/board');
    const b0 = await w.genesis('ann');
    assert.deepEqual(w.tip(), { oid: b0, height: 0 });
    await w.join('bob');
    await w.commit({ writer: 'ann', cs: [{ paths: ['src/a.txt', 'src/b.txt'] }] });                       // ordinary
    await w.commit({ writer: 'bob', code: 'base_move' });                                                   // base move
    await w.commit({ writer: 'ann' });                                                                      // board-only
    await w.commit({ writer: 'bob', ops: [{ type: 'seat_start', seat_id: SEAT, permission_mode: 'default' }], cs: [{ seat: SEAT, origin: 'prompt', paths: ['src/c.txt'] }] });
    await w.commit({ writer: 'ann', ops: [{ type: 'event', cid: '', kind: 'freeze', refs: [], reason_code: 'TEST_REASON' }] });
    const tip = w.tip();
    assert.equal(tip.height, 6);
    const ref = await fx.repo.readRef(w.ref);
    assert.equal(ref, tip.oid);

    const oids = await boardChain(fx.repo, tip.oid);
    assert.equal(oids.length, 7);
    const commits = await readAll(fx.repo, oids);
    const expectShape: Array<'genesis' | 'ordinary' | 'base_move' | 'same'> = ['genesis', 'same', 'ordinary', 'base_move', 'same', 'ordinary', 'same'];
    for (let h = 0; h < commits.length; h++) {
      const info = await fx.repo.readCommit(oids[h]!);
      assert.ok(boardShapeOk(info, h === 0 ? null : oids[h - 1]!), `height ${h}: board shape`);
      const c = commits[h]!;
      const prevLive = h === 0 ? null : commits[h - 1]!.liveCode;
      if (expectShape[h] === 'same') {
        assert.equal(c.liveCode, prevLive, `height ${h}: a board-only step repeats the live commit`);
      } else {
        assert.equal(liveShape(await fx.repo.readCommit(c.liveCode), prevLive), expectShape[h], `height ${h}: live shape`);
      }
      assert.notEqual(c.writer, null, `height ${h}: Cowork-Writer`);
    }
    // L0 names the branch tip as its base; the base move's second parent is the new base.
    const l0 = await fx.repo.readCommit(commits[0]!.liveCode);
    assert.deepEqual(l0.trailers.filter((t) => t.key === 'Cowork-Base').map((t) => t.value), [await fx.repo.resolve('refs/heads/main')]);
    const moved = await fx.repo.readCommit(commits[3]!.liveCode);
    assert.deepEqual(moved.trailers.filter((t) => t.key === 'Cowork-Base').map((t) => t.value), [moved.parents[1]]);
    // Cowork-Seat values of the seat change-set.
    const seated = await fx.repo.readCommit(commits[5]!.liveCode);
    assert.deepEqual(seated.trailers.filter((t) => t.key === 'Cowork-Seat').map((t) => t.value), [SEAT]);

    // Checkpoints: B0's equals the fold of B0; the writer's fold equals the read-back fold.
    const states = foldChain(commits);
    assert.ok(commits[0]!.checkpoint !== null && commits[0]!.checkpoint.equals(serializeFold(states[0]!)));
    assert.ok(serializeFold(w.fold()).equals(serializeFold(states[states.length - 1]!)));

    // V10: each writer peer's commits carry <peer>@cowork.invalid and the wallMs dates.
    const peers = { ann: w.peer('ann').peer, bob: w.peer('bob').peer };
    for (let h = 0; h < commits.length; h++) {
      const c = commits[h]!;
      const who = c.writer!.peer;
      assert.ok(who === peers.ann || who === peers.bob);
      for (const oid of [oids[h]!, ...(expectShape[h] === 'same' ? [] : [c.liveCode])]) {
        const id = await identityOf(fx.repo, oid);
        assert.equal(id.author, id.committer);
        const m = /^(\S.*) <([0-9a-f]{32})@cowork\.invalid> ([0-9]+) \+0000$/.exec(id.author);
        assert.ok(m !== null, `height ${h}: ${id.author}`);
        assert.equal(m[2], who, `height ${h}: the commit is the writer's`);
        assert.ok(clock.issued.includes(Number(m[3]) * 1_000), `height ${h}: a wallMs date`);
      }
    }

    // rewrite(h): a chain whose old tip is not a first-parent ancestor of the new one; heights below h are shared.
    const rewritten = await w.rewrite(4);
    assert.deepEqual(w.tip(), { oid: rewritten, height: 4 });
    assert.equal(await fx.repo.readRef(w.ref), rewritten);
    const newChain = await boardChain(fx.repo, rewritten);
    assert.deepEqual(newChain.slice(0, 4), oids.slice(0, 4));
    assert.notEqual(newChain[4], oids[4]);
    assert.ok(!newChain.includes(tip.oid));
    assert.equal(await fx.repo.isAncestor(tip.oid, rewritten), false);
    const after = await w.commit({ writer: 'bob', cs: [{ paths: ['src/a.txt'] }] });
    assert.deepEqual(w.tip(), { oid: after, height: 5 });
    const reread = await readAll(fx.repo, await boardChain(fx.repo, after));
    assert.ok(serializeFold(w.fold()).equals(serializeFold(foldChain(reread)[5]!)));

    // malformed(kind): the three R-V19 fixtures, then an ordinary commit; the writer's fold after each step is kept.
    const folds = new Map<number, Buffer>();
    const opsBig = await w.malformed('board_ops_too_large');
    folds.set(w.tip().height, serializeFold(w.fold()));
    assert.equal(w.tip().height, 6);
    await assert.rejects(readBoardCommit(fx.repo, opsBig), (e: unknown) => e instanceof BoardMalformedError && e.reason === 'ops_too_large');
    const tagged = await w.malformed('live_not_commit');
    folds.set(w.tip().height, serializeFold(w.fold()));
    const three = await w.malformed('live_three_parents');
    folds.set(w.tip().height, serializeFold(w.fold()));
    assert.equal(w.tip().height, 8);
    const last = await w.commit({ writer: 'ann', cs: [{ paths: ['src/b.txt'] }] });
    folds.set(w.tip().height, serializeFold(w.fold()));
    assert.equal(w.tip().height, 9);

    // The whole chain read back in one go: every height says what malformed() claims for it, and the writer's fold at
    // each of those heights is the R-V19 fold of the read-back chain (a malformed board commit folds as noopDraft).
    const chain9 = await boardChain(fx.repo, last);
    assert.deepEqual(chain9.slice(6), [opsBig, tagged, three, last]);
    const reads = await readChain(fx.repo, chain9);
    reads.forEach((r, h) => assert.equal(isBoardReadFailure(r), h === 6, `height ${h}: ${JSON.stringify(isBoardReadFailure(r) ? r : r.live)}`));
    assert.deepEqual(reads[6], { oid: opsBig, height: 6, malformed: 'ops_too_large' });
    const [r7, r8, r9] = reads.slice(7) as BoardRead[];
    assert.deepEqual(r7!.live, { oid: r7!.liveCode, malformed: 'not_commit' });
    assert.deepEqual(await readLiveCommits(fx.repo, [r7!.liveCode]), { reads: [{ oid: r7!.liveCode, malformed: 'not_commit' }], next: 1 });
    const live5 = (reads[5] as BoardRead).liveCode;
    const live8 = r8!.live as LiveRead;
    assert.ok(live8 !== null && typeof live8 === 'object' && !('malformed' in live8));
    assert.equal(live8.info.parents.length, 3);
    assert.equal(live8.info.parents[0], live5, 'the three-parent live commit follows the last real live commit');
    assert.equal(liveShape(live8.info, live5), null);
    const live9 = r9!.live as LiveRead;
    assert.ok(live9 !== null && typeof live9 === 'object' && !('malformed' in live9));
    assert.equal(liveShape(live9.info, live8.oid), 'ordinary');
    const v19 = foldRV19(reads);
    for (const [h, bytes] of folds) assert.ok(bytes.equals(serializeFold(v19[h]!)), `height ${h}: the writer's fold is the R-V19 fold`);
  } finally {
    await fx.cleanup();
  }
});

/** A runner that answers exit code 1, without running git, for the calls `failOn` picks. */
function flakyRunner(inner: GitRunner): GitRunner & { failOn: ((args: string[]) => boolean) | null } {
  const r: GitRunner & { failOn: ((args: string[]) => boolean) | null } = {
    failOn: null,
    run(args: string[], opts: GitCallOptions): Promise<GitResult> {
      if (r.failOn?.(args) === true) {
        return Promise.resolve({ code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('injected failure', 'utf8'), killedByWatchdog: false, aborted: false, durationMs: 0 });
      }
      return inner.run(args, opts);
    },
  };
  return r;
}

test('BoardWriter changes its state only after the git write succeeds', async () => {
  const fa = await makeRepoFixture('viz-boardwriter-atomic');
  const fb = await makeRepoFixture('viz-boardwriter-clean');
  try {
    const flaky = flakyRunner(fa.runner);
    const a = await BoardWriter.create({ runner: flaky, paths: fa.paths, branch: 'main', seed: 'bw-atomic' });
    const b = await BoardWriter.create({ runner: fb.runner, paths: fb.paths, branch: 'main', seed: 'bw-atomic' });
    const updateRef = (args: string[]): boolean => args[0] === 'update-ref';
    flaky.failOn = updateRef;
    await assert.rejects(a.genesis('ann'), /injected failure/);
    assert.throws(() => a.tip(), /no board yet/);
    flaky.failOn = null;
    await a.genesis('ann');
    await b.genesis('ann');
    assert.deepEqual(a.tip(), b.tip());
    // Every write that fails (a new peer, a new epoch, a seat counter, a base move, a tag, one fast-import, a rewrite)
    // leaves the writer as it was: retried, it writes exactly what a writer that never failed writes.
    const steps: Array<[string, (w: BoardWriter) => Promise<unknown>]> = [
      ['a commit by a new peer', (w) => w.commit({ writer: 'carl', ops: [{ type: 'event', cid: '', kind: 'freeze', refs: [], reason_code: 'TEST_REASON' }], cs: [{ paths: ['src/a.txt'] }] })],
      ['a join with a new epoch', (w) => w.join('ann', { newEpoch: true })],
      ['a seat change-set', (w) => w.commit({ writer: 'ann', cs: [{ seat: SEAT, paths: ['src/b.txt'] }] })],
      ['a base move', (w) => w.commit({ writer: 'carl', code: 'base_move' })],
      // (fast-import before the tag: its `from` parses the previous board commit, which a tag parent makes unparsable)
      ['one fast-import', (w) => w.commitMany([{ writer: 'dora', cs: [{ paths: ['src/c.txt'] }] }, { writer: 'ann', cs: [{ seat: SEAT, paths: ['src/d.txt'] }] }])],
      ['a tag as the live commit', (w) => w.malformed('live_not_commit')],
      ['a rewrite', (w) => w.rewrite(2)],
    ];
    for (const [what, step] of steps) {
      const before = { tip: a.tip(), fold: serializeFold(a.fold()), ann: a.peer('ann') };
      flaky.failOn = what === 'one fast-import' ? (args) => args[0] === 'fast-import' : updateRef;
      await assert.rejects(step(a), /injected failure|moved under the writer/, what);
      flaky.failOn = null;
      assert.deepEqual(a.tip(), before.tip, `${what}: the tip moved`);
      assert.ok(serializeFold(a.fold()).equals(before.fold), `${what}: the fold moved`);
      assert.deepEqual(a.peer('ann'), before.ann, `${what}: the peer record moved`);
      await step(a);
      await step(b);
      assert.deepEqual(a.tip(), b.tip(), `${what}: the retry wrote something else`);
    }
    assert.deepEqual(a.peer('carl'), b.peer('carl'));
    assert.deepEqual(a.peer('dora'), b.peer('dora'));
    assert.deepEqual(await chainOf(fa.repo, a.tip().oid), await chainOf(fb.repo, b.tip().oid));
  } finally {
    await fa.cleanup();
    await fb.cleanup();
  }
});

/** A script that touches every ScriptCommit form. */
function variety(): ScriptCommit[] {
  const many = Array.from({ length: 300 }, (_, i) => `many/f${String(i).padStart(3, '0')}.txt`);
  return [
    { writer: 'ann', cs: [{ paths: ['src/a.txt'] }, { paths: ['src/b.txt', 'docs/x.md'], checks: 'pass' }] },
    { writer: 'bob', code: 'base_move' },
    { writer: 'bob', cs: [{ paths: many }] },                                                     // > 256 paths: no Cowork-CS-Paths
    { writer: 'ann', ops: [{ type: 'seat_start', seat_id: SEAT, permission_mode: 'default' }] },
    { writer: 'ann', cs: [{ seat: SEAT, state: 'checkpoint', origin: 'wake', paths: ['src/c.txt'] }], seats: [SEAT, 'human'] },
    { writer: 'ann', ops: [{ type: 'seat_end', seat_id: SEAT, permission_mode: 'default' }] },
    { writer: 'bob', ops: [{ type: 'event', cid: '', kind: 'health', refs: [], reason_code: 'HOST_THROTTLED' }] },
    { writer: 'bob', rawOps: ['{"truncated":', '[]'] },
    { writer: null, rawOps: ['{}'] },
    { writer: 'ann', badWriterTrailer: true, ops: [{ type: 'leave' }] },
    { writer: 'bob', code: 'ordinary' },
    { writer: 'ann', code: 'unchanged', cs: [{ paths: ['src/a.txt'] }] },
  ];
}

const filler = (i: number): ScriptCommit => (i % 3 === 0 ? { writer: 'bob', cs: [{ paths: [`f/${i}.txt`] }] } : { writer: i % 2 === 0 ? 'ann' : 'bob' });

test('commitMany and step-by-step commit give identical oids', async () => {
  const fa = await makeRepoFixture('viz-boardwriter-many');
  const fb = await makeRepoFixture('viz-boardwriter-step');
  try {
    const ca = ticking();
    const cb = ticking();
    const a = await BoardWriter.create({ runner: fa.runner, paths: fa.paths, branch: 'main', seed: 'bw-equal', wallMs: ca.wallMs });
    const b = await BoardWriter.create({ runner: fb.runner, paths: fb.paths, branch: 'main', seed: 'bw-equal', wallMs: cb.wallMs });
    for (const w of [a, b]) {
      await w.genesis('ann');
      await w.join('bob');
    }
    assert.equal(a.tip().oid, b.tip().oid, 'the same seed and dates give the same genesis');
    const script = variety();
    const aTip = await a.commitMany(script);
    for (const c of script) await b.commit(c);
    assert.deepEqual(a.tip(), b.tip());
    assert.equal(aTip, b.tip().oid);

    // Across a checkpoint height: a writes all of it in one import, b imports most of it and steps over 256.
    const toGo = CHECKPOINT_EVERY + 4 - a.tip().height;
    const rest = Array.from({ length: toGo }, (_, i) => filler(i));
    const split = rest.length - 10;
    await a.commitMany(rest);
    await b.commitMany(rest.slice(0, split));
    for (const c of rest.slice(split)) await b.commit(c);
    assert.deepEqual(a.tip(), b.tip());
    assert.equal(a.tip().height, CHECKPOINT_EVERY + 4);
    assert.deepEqual(await chainOf(fa.repo, a.tip().oid), await chainOf(fb.repo, b.tip().oid));
    assert.deepEqual(ca.issued, cb.issued, 'the same dates in the same order');
    assert.ok(serializeFold(a.fold()).equals(serializeFold(b.fold())));
    // The checkpoint at 256 byte-matches the fold of the read-back chain.
    const oids = await boardChain(fa.repo, a.tip().oid);
    const commits = await readAll(fa.repo, oids);
    const states = foldChain(commits);
    assert.ok(commits[CHECKPOINT_EVERY]!.checkpoint!.equals(serializeFold(states[CHECKPOINT_EVERY]!)));
    assert.ok(commits[0]!.checkpoint!.equals(serializeFold(states[0]!)));
  } finally {
    await fa.cleanup();
    await fb.cleanup();
  }

  // A 1,024-height board is written in under 10 s (one git fast-import), on a branch whose name needs enc().
  const fx = await makeRepoFixture('viz-boardwriter-long');
  try {
    await fx.repo.run(['update-ref', 'refs/heads/feat/long', (await fx.repo.resolve('refs/heads/main'))!]);
    const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'feat/long', seed: 'bw-long' });
    await w.genesis('ann');
    await w.join('bob');
    const t0 = performance.now();
    await w.commitMany(Array.from({ length: 1_023 }, (_, i) => filler(i)));
    const took = performance.now() - t0;
    assert.equal(w.tip().height, 1_024);
    assert.equal(w.ref, 'refs/cowork-remote/feat%2Flong/board');
    assert.equal(await fx.repo.readRef(w.ref), w.tip().oid);
    assert.ok(took < 10_000, `commitMany took ${Math.round(took)} ms`);
    // The checkpoints at 256, 512, 768 and 1,024 byte-match the writer's own fold of the read-back chain.
    const oids = await boardChain(fx.repo, w.tip().oid);
    const read = await readBoardCommits(fx.repo, oids.map((oid, height) => ({ oid, height })));
    assert.equal(read.next, oids.length);
    const drafts = read.reads.map((r) => {
      assert.ok(!isBoardReadFailure(r));
      return r;
    });
    const states = foldChain(drafts);
    for (const h of [256, 512, 768, 1_024]) assert.ok(drafts[h]!.checkpoint!.equals(serializeFold(states[h]!)), `checkpoint ${h}`);
  } finally {
    await fx.cleanup();
  }
});
