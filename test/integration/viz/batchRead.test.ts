// Batched board and live commit readers (Plan 8a Task 2; 12 §3.3.2, §9.7 items 2, 3 and 8; rulings R-V05, R-V69).
// Boards come from tools/viz/boardWriter.ts; the over-cap and mistyped fixtures are built in the test with
// `git hash-object -w` and `mktree`, never through src/. Every git call goes through a runner spy. Long scripted boards
// (600 and 1,280 commits): batchReadLarge.test.ts; the 32 MiB --batch budget: batchReadBudget.test.ts; board trees and
// missing objects: batchReadTrees.test.ts; rounds git dies on and unparseable objects: batchReadUnreadable.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBoardReadFailure, parseCommitObject, readLiveCommits, type BoardRead, type LiveRead } from '../../../src/board/batchRead.js';
import { readBoardCommit } from '../../../src/board/boardCommit.js';
import { parseOid, type Oid } from '../../../src/git/oid.js';
import type { CommitInfo, GitRepo } from '../../../src/git/repo.js';
import { BoardWriter } from '../../../tools/viz/boardWriter.js';
import { makeRepoFixture } from '../../helpers/repoFixture.js';
import { chain, checkpointTree, commitBytes, hashRaw, IDENT, many, mktree, readOnce, SEAT, spyRepo } from '../../helpers/vizBatchRead.js';

/** The commit as git itself reports it: tree and parents (rev-parse), subject (log %s) and trailers (interpret-trailers --parse). */
async function commitByGit(repo: GitRepo, oid: Oid): Promise<CommitInfo> {
  const out = async (args: string[], stdin?: Buffer): Promise<string> => (await repo.run(args, stdin === undefined ? {} : { stdin })).stdout.toString('utf8');
  const tree = parseOid(await out(['rev-parse', `${oid}^{tree}`]));
  const parents = (await out(['rev-parse', `${oid}^@`])).split('\n').filter((l) => l.length > 0).map((l) => parseOid(l));
  const subject = (await out(['log', '-1', '--format=%s', oid])).replace(/\n$/, '');
  const message = Buffer.from(await out(['log', '-1', '--format=%B', oid]), 'utf8');
  const trailers = (await out(['interpret-trailers', '--parse'], message)).split('\n').filter((l) => l.length > 0).map((l) => {
    const i = l.indexOf(': ');
    return { key: l.slice(0, i), value: l.slice(i + 2) };
  });
  return { oid, tree, parents, subject, trailers };
}

test('parseCommitObject equals GitRepo.readCommit', async () => {
  const fx = await makeRepoFixture('viz-batchread-parse');
  try {
    const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'main', seed: 'br-parse' });
    const b0 = await w.genesis('ann');
    const b1 = await w.commit({ writer: 'ann', cs: [{ paths: ['src/a.txt'] }] });
    const moved = await w.commit({ writer: 'ann', code: 'base_move' });
    const b0Info = await fx.repo.readCommit(b0);
    const movedInfo = await fx.repo.readCommit(moved);
    const live = movedInfo.parents[1]!;
    const base = (await fx.repo.readCommit(live)).parents[1]!;
    const body = async (oid: Oid): Promise<Buffer> => (await fx.repo.run(['cat-file', 'commit', oid])).stdout;
    // Board, live (genesis L0, ordinary, base move) and base commits against git's own reading of them.
    let trailered = 0;
    for (const oid of [b0, b0Info.parents[0]!, b1, (await fx.repo.readCommit(b1)).parents[1]!, moved, live, base]) {
      const want = await commitByGit(fx.repo, oid);
      trailered += want.trailers.length > 0 ? 1 : 0;
      assert.deepEqual(parseCommitObject(oid, await body(oid)), want, oid);
      assert.deepEqual(await fx.repo.readCommit(oid), want, oid);
    }
    assert.ok(trailered >= 6, 'the board and live commits carry trailers');
    // Hand-written commit objects with literal expectations: no parent, three parents, a non-ASCII subject and
    // trailer value (P2-UTF8), an extra header and a body paragraph before the trailers.
    const tree = b0Info.tree;
    const ident = 'Fixture <fixture@cowork.invalid> 1700000000 +0000';
    const raw = async (head: string, message: string): Promise<Oid> =>
      parseOid((await fx.repo.run(['hash-object', '-t', 'commit', '-w', '--stdin'], { stdin: Buffer.from(`${head}author ${ident}\ncommitter ${ident}\n\n${message}`, 'utf8') })).stdout.toString('utf8'));
    const odd = await raw(`tree ${tree}\nparent ${b0}\nparent ${b1}\nparent ${moved}\n`, 'caf\u{E9} \u{D55C}\u{AE00} \u{1F600}\n\nbody line\n\nX-Name: \u{AE40} \u{C624}\nCowork-Seat: human\n');
    assert.deepEqual(parseCommitObject(odd, await body(odd)), {
      oid: odd, tree, parents: [b0, b1, moved], subject: 'caf\u{E9} \u{D55C}\u{AE00} \u{1F600}',
      trailers: [{ key: 'X-Name', value: '\u{AE40} \u{C624}' }, { key: 'Cowork-Seat', value: 'human' }],
    });
    const root = await raw(`tree ${tree}\n`, 'root only\n');
    assert.deepEqual(parseCommitObject(root, await body(root)), { oid: root, tree, parents: [], subject: 'root only', trailers: [] });
    const encoded = await raw(`tree ${tree}\nparent ${b0}\n`, 'subject\n\nCowork-Writer: x\n');
    const withEncoding = Buffer.from((await body(encoded)).toString('utf8').replace('\n\n', '\nencoding UTF-8\n\n'), 'utf8');
    assert.deepEqual(parseCommitObject(encoded, withEncoding), { oid: encoded, tree, parents: [b0], subject: 'subject', trailers: [{ key: 'Cowork-Writer', value: 'x' }] });
  } finally {
    await fx.cleanup();
  }
});

test('over-cap, mistyped and missing objects are reported and never read', async () => {
  const fx = await makeRepoFixture('viz-batchread-caps');
  try {
    const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'main', seed: 'br-caps' });
    const b0 = await w.genesis('ann');
    const good = await w.commit({ writer: 'ann', cs: [{ paths: ['src/a.txt'] }] });
    const goodInfo = await fx.repo.readCommit(good);
    const live = goodInfo.parents[1]!;
    const emptyOps = await hashRaw(fx, 'blob', Buffer.alloc(0));
    const smallTree = await mktree(fx, [['040000', 'checkpoint', await checkpointTree(fx)], ['100644', 'ops.jsonl', emptyOps]]);
    // A live commit only an over-cap board commit names: never read (the board commit is refused first).
    const liveOnly = await hashRaw(fx, 'commit', commitBytes(goodInfo.tree, [live], 'named by an over-cap board commit only\n'));

    const bigMessage = await hashRaw(fx, 'commit', commitBytes(smallTree, [b0, live], `big\n\n${'m'.repeat(2 * 1024 * 1024)}\n`));
    const tag = await hashRaw(fx, 'tag', Buffer.from(`object ${good}\ntype commit\ntag t1\ntagger ${IDENT}\n\ntag\n`, 'utf8'));
    const bigOpsBlob = await hashRaw(fx, 'blob', Buffer.from(`${'o'.repeat(1_023)}\n`.repeat(70), 'utf8'));
    const bigOps = await hashRaw(fx, 'commit', commitBytes(await mktree(fx, [['100644', 'ops.jsonl', bigOpsBlob]]), [b0, liveOnly], 'ops\n'));
    const bigCkBlob = await hashRaw(fx, 'blob', Buffer.alloc(5_000_001, 0x20));
    const ckTree = await mktree(fx, [['100644', 'state.json', bigCkBlob]]);
    const bigCk = await hashRaw(fx, 'commit', commitBytes(await mktree(fx, [['100644', 'ops.jsonl', emptyOps], ['040000', 'checkpoint', ckTree]]), [b0, live], 'checkpoint\n'));
    const orphan = await hashRaw(fx, 'commit', commitBytes(smallTree, [], 'no parent\n'));
    const missing = 'd'.repeat(40) as Oid;
    // Board commits whose live commit (last parent) is over the cap, a tag, or missing.
    const liveBig = await hashRaw(fx, 'commit', commitBytes(smallTree, [b0, bigMessage], 'live big\n'));
    const liveTag = await hashRaw(fx, 'commit', commitBytes(smallTree, [b0, tag], 'live tag\n'));
    const liveMissing = await hashRaw(fx, 'commit', commitBytes(smallTree, [b0, missing], 'live missing\n'));

    const { repo, calls } = spyRepo(fx);
    // Board commits that are over a cap, mistyped, parentless or missing.
    const items = [
      { oid: bigMessage, height: 1 }, { oid: tag, height: 2 }, { oid: bigOps, height: 3 }, { oid: bigCk, height: 256 },
      { oid: bigCk, height: 257 }, { oid: orphan, height: 5 }, { oid: missing, height: 6 }, { oid: good, height: 7 },
    ];
    const out = await readOnce(repo, items, { withLive: true });
    const reasons = out.map((r) => (isBoardReadFailure(r) ? r.malformed : 'ok'));
    assert.deepEqual(reasons, ['commit_too_large', 'not_commit', 'ops_too_large', 'board_too_large', 'board_too_large', 'no_parent', 'missing', 'ok']);
    for (let i = 0; i < 7; i++) assert.deepEqual(out[i], { oid: items[i]!.oid, height: items[i]!.height, malformed: reasons[i] });
    // The same reasons readBoardCommit gives (a missing oid is its plain Error).
    for (let i = 0; i < 6; i++) await assert.rejects(readBoardCommit(fx.repo, items[i]!.oid), (e: unknown) => (e as { reason?: string }).reason === reasons[i]);
    await assert.rejects(readBoardCommit(fx.repo, missing));
    assert.deepEqual(calls.map((c) => c.args), [['cat-file', '--batch-check'], ['cat-file', '--batch']]);
    for (const never of [bigMessage, tag, bigOpsBlob, bigCkBlob, missing, liveOnly]) assert.ok(!calls[1]!.stdin.includes(never), `${never} was read`);

    // Board commits whose live commit is over the cap, a tag or missing. (A separate batch: git resolves <oid>^2 through
    // its in-process object cache, so a tag the same process already parsed as a board item would read as missing there;
    // the viewer's items come from rev-list --first-parent and are commits.)
    calls.length = 0;
    const liveItems = [{ oid: liveBig, height: 7 }, { oid: liveTag, height: 8 }, { oid: liveMissing, height: 9 }, { oid: good, height: 10 }];
    const lives = (await readOnce(repo, liveItems, { withLive: true })).map((r) => {
      assert.ok(!isBoardReadFailure(r));
      return r.live;
    });
    assert.deepEqual(lives.slice(0, 3), [{ oid: bigMessage, malformed: 'commit_too_large' }, { oid: tag, malformed: 'not_commit' }, { oid: missing, malformed: 'missing' }]);
    assert.ok(lives[3] !== null && lives[3] !== 'same' && !('malformed' in lives[3]) && lives[3].oid === live);
    assert.deepEqual(calls.map((c) => c.args), [['cat-file', '--batch-check'], ['cat-file', '--batch']]);
    for (const never of [bigMessage, tag, missing]) assert.ok(!calls[1]!.stdin.includes(never), `${never} was read`);

    calls.length = 0;
    const lr = await readLiveCommits(repo, [bigMessage, tag, missing, live, live]);
    assert.equal(lr.next, 5);
    assert.deepEqual(lr.reads.slice(0, 3), [{ oid: bigMessage, malformed: 'commit_too_large' }, { oid: tag, malformed: 'not_commit' }, { oid: missing, malformed: 'missing' }]);
    assert.equal((lr.reads[3] as LiveRead).oid, live);
    assert.deepEqual(lr.reads[4], lr.reads[3]);
    assert.deepEqual(calls.map((c) => c.args), [['cat-file', '--batch-check'], ['cat-file', '--batch']]);
    assert.equal(calls[1]!.stdin, `${live}\n`);

    // Plan 2 FA-2: a board commit without a checkpoint/state.json blob is entry_missing, as readBoardCommit refuses it.
    const noCk = await hashRaw(fx, 'commit', commitBytes(await mktree(fx, [['100644', 'ops.jsonl', emptyOps]]), [b0, live], 'no checkpoint\n'));
    assert.deepEqual(await readOnce(repo, [{ oid: noCk, height: 3 }], { withLive: true }), [{ oid: noCk, height: 3, malformed: 'entry_missing' }]);
    await assert.rejects(readBoardCommit(fx.repo, noCk), (e: unknown) => (e as { reason?: string }).reason === 'entry_missing');
  } finally {
    await fx.cleanup();
  }
});

test('live reads: parents, writer, seats, cs, csPaths, base and info match what the writer put in liveCommitTrailers', async () => {
  const fx = await makeRepoFixture('viz-batchread-live');
  try {
    const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'main', seed: 'br-live' });
    await w.genesis('ann');
    await w.commit({ writer: 'ann', cs: [{ paths: ['src/a.txt', 'src/b.txt'] }, { paths: many(300, 'big') }] });   // ordinary
    await w.commit({ writer: 'ann', code: 'base_move' });                                                          // base move
    await w.commit({ writer: 'ann' });                                                                             // board-only
    await w.commit({ writer: 'ann', cs: [{ seat: SEAT, paths: ['src/c.txt'] }], seats: [SEAT, 'human'] });
    const oids = await chain(fx.repo, w.tip().oid);
    const out = (await readOnce(fx.repo, oids.map((oid, height) => ({ oid, height })), { withLive: true })) as BoardRead[];
    const branchTip = await fx.repo.resolve('refs/heads/main');
    const ann = w.peer('ann');
    const lives = out.map((r) => r.live);
    assert.equal(lives[3], 'same');
    for (const h of [0, 1, 2, 4]) {
      const l = lives[h] as LiveRead;
      assert.ok(l !== null && typeof l === 'object' && !('malformed' in l), `height ${h}`);
      assert.equal(l.oid, out[h]!.liveCode);
      assert.deepEqual(l.info, await fx.repo.readCommit(l.oid));
      assert.equal(l.writer?.peer, ann.peer);
      assert.deepEqual(l.writer, out[h]!.writer, `height ${h}: the live commit and the board commit share the writer`);
    }
    const [l0, l1, l2, , l4] = lives as LiveRead[];
    // Genesis L0 (<B0>^1): no parents, Cowork-Base = the branch tip.
    assert.deepEqual(l0!.info.parents, []);
    assert.equal(l0!.base, branchTip);
    assert.deepEqual(l0!.seats, []);
    // Ordinary: [prevLive], seats [human], two change-sets, the > 256-path one without a list.
    assert.deepEqual(l1!.info.parents, [l0!.oid]);
    assert.equal(l1!.base, null);
    assert.deepEqual(l1!.seats, ['human']);
    assert.equal(l1!.cs.length, 2);
    assert.deepEqual([...l1!.csPaths.keys()], [l1!.cs[0]!.csId]);
    assert.deepEqual(l1!.csPaths.get(l1!.cs[0]!.csId), ['src/a.txt', 'src/b.txt']);
    assert.equal(l1!.cs[1]!.paths, 300);
    assert.deepEqual(out[1]!.csPaths, l1!.csPaths, 'the board commit carries the same Cowork-CS-Paths');
    // Base move: [prevLive, X] with Cowork-Base X.
    assert.equal(l2!.info.parents.length, 2);
    assert.equal(l2!.info.parents[0], l1!.oid);
    assert.equal(l2!.base, l2!.info.parents[1]);
    // Seats in trailer order (liveCommitTrailers sorts them).
    assert.deepEqual(l4!.seats, [SEAT, 'human'].sort());
    assert.equal(l4!.cs[0]!.csId, `${SEAT}/1`);
    // readLiveCommits reads the same.
    assert.deepEqual(await readLiveCommits(fx.repo, [l0!.oid, l1!.oid, l2!.oid, l4!.oid]), { reads: [l0, l1, l2, l4], next: 4 });
  } finally {
    await fx.cleanup();
  }
});
