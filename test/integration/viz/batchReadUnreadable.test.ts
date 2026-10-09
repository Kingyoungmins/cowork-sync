// No hostile board stops a room (Plan 8a Task 2, ruling R-V74; 12 §3.3.2, R-V19): a round git dies on is read again item
// by item and only the items git still dies on read `unreadable`; a board or live commit whose header does not parse
// and a held/ tree that does not parse are per-item outcomes too, never a thrown round (R-V69's 32 MiB budget on that
// path: batchReadBudget.test.ts). Fixtures are written with git's own plumbing in the test
// (test/helpers/vizBatchRead.ts), the corrupt loose objects with node:zlib; never through src/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readBoardCommits, readLiveCommits, type BoardRead, type LiveRead } from '../../../src/board/batchRead.js';
import { buildDaemonEnv } from '../../../src/git/env.js';
import { parseOid, type Oid } from '../../../src/git/oid.js';
import { GitCommandError, GitRepo } from '../../../src/git/repo.js';
import { createGitRunner } from '../../../src/git/runner.js';
import { realClock } from '../../../src/ports/clock.js';
import { fixtureContext, makeRepoFixture } from '../../helpers/repoFixture.js';
import {
  checkpointTree, commitBytes, equalsEngine, hashRaw, IDENT, mktree, ownLive, plantCorrupt, rawTree, reasonsOf, seenOf, smallBoard, spyRepo,
} from '../../helpers/vizBatchRead.js';

test('a round git dies on is read again item by item: a board tree git cannot decode reads unreadable, the other items as readBoardCommit reads them (R-V74)', async () => {
  const fx = await makeRepoFixture('viz-batchread-fatal');
  try {
    const { b0, before, after, tree, live, afterLive } = await smallBoard(fx, 'br-fatal');
    const q = await hashRaw(fx, 'blob', Buffer.from('q\n', 'utf8'));
    const ops = await hashRaw(fx, 'blob', Buffer.from('{"not":"an op"}\n', 'utf8'));
    const board = async (t: Oid, label: string): Promise<Oid> => hashRaw(fx, 'commit', commitBytes(t, [b0, live], `${label}\n`));
    // Records git cannot decode where its lookups of the round's names reach them: `cat-file --batch-check` exits 128
    // ("fatal: malformed mode in tree entry"), and readBoardCommit's own --batch-check dies the same way.
    const noSpace = Buffer.concat([Buffer.from('100644zz\0', 'latin1'), Buffer.from(q, 'hex')]);
    const badMode = Buffer.concat([Buffer.from('1x0644 q\0', 'latin1'), Buffer.from(q, 'hex')]);
    const fatal1 = await board(await rawTree(fx, [['100644', 'd0123456789', q], noSpace]), 'git dies on the board tree');
    const fatal2 = await board(await rawTree(fx, [['100644', 'ops.jsonl', ops], badMode]), 'git dies on the board tree after ops.jsonl');
    // A well-formed board commit that names before's live commit.
    const echo = await board(tree, 'echo');

    const { repo, calls } = spyRepo(fx);
    const items = [
      { oid: before, height: 1 }, { oid: fatal1, height: 2 }, { oid: echo, height: 3 }, { oid: fatal2, height: 4 },
      { oid: after, height: 5 }, { oid: before, height: 6 }, { oid: echo, height: 7 },
    ];
    const { reads: out, next } = await readBoardCommits(repo, items, { withLive: true });
    assert.equal(next, items.length);
    assert.deepEqual(reasonsOf(out), ['ok', 'unreadable', 'ok', 'unreadable', 'ok', 'ok', 'ok']);
    assert.deepEqual([out[1], out[3]], [{ oid: fatal1, height: 2, malformed: 'unreadable' }, { oid: fatal2, height: 4, malformed: 'unreadable' }]);
    await equalsEngine(fx, out);
    // The failed round, then one round per item: an item git still dies on stops at its own --batch-check.
    assert.deepEqual(seenOf(calls), [
      '--batch-check 128',
      '--batch-check 0', '--batch 0', '--batch-check 128', '--batch-check 0', '--batch 0', '--batch-check 128',
      '--batch-check 0', '--batch 0', '--batch-check 0', '--batch 0', '--batch-check 0', '--batch 0',
    ]);
    const checks = calls.slice(1).filter((c) => c.args[1] === '--batch-check');
    checks.forEach((c, i) => {
      const names = c.stdin.split('\n').filter((l) => l.length > 0);
      assert.ok(names.length > 0 && names.every((n) => n.startsWith(items[i]!.oid)), `item ${i}: its own names only`);
    });
    // Live commits: an item after an unreadable one reads its own (the preceding live commit was not reported);
    // 'same' still holds between two items that read.
    assert.deepEqual([ownLive(out[0]), ownLive(out[2]), ownLive(out[4]), ownLive(out[5])], [live, live, afterLive, live]);
    assert.equal((out[6] as BoardRead).live, 'same');
    // The caller's prevLive carries into the item-by-item path.
    const tail = await readBoardCommits(repo, [{ oid: echo, height: 3 }, { oid: fatal2, height: 4 }, { oid: echo, height: 5 }], { withLive: true, prevLive: live });
    assert.equal(tail.next, 3);
    assert.deepEqual(reasonsOf(tail.reads), ['ok', 'unreadable', 'ok']);
    assert.equal((tail.reads[0] as BoardRead).live, 'same');
    assert.equal(ownLive(tail.reads[2]), live);

    // Only git's die() code (128) starts the item-by-item path: a git that cannot be started (-1, as a watchdog kill or
    // an abort also reads) fails the round once, as before, and is retried next tick; nothing reads as unreadable.
    const noGit = createGitRunner({
      clock: realClock, hooksPath: join(fx.root, 'no-hooks'), daemonEnv: buildDaemonEnv(process.env as Record<string, string | undefined>, []),
      gitPath: join(fx.root, 'no git here', process.platform === 'win32' ? 'git.exe' : 'git'),
    });
    let spawns = 0;
    const unstartable = new GitRepo({ run: (args, opts) => { spawns++; return noGit.run(args, opts); } }, fx.paths, fixtureContext);
    const notStarted = (e: unknown): boolean => e instanceof GitCommandError && e.code === -1;
    await assert.rejects(readBoardCommits(unstartable, items, { withLive: true }), notStarted);
    await assert.rejects(readLiveCommits(unstartable, [live, afterLive]), notStarted);
    assert.equal(spawns, 2, 'one attempt per call, no item-by-item retries');
  } finally {
    await fx.cleanup();
  }
});

test('a --batch git dies on (an object it cannot inflate) is read again item by item; readLiveCommits too (R-V74)', async () => {
  const fx = await makeRepoFixture('viz-batchread-corrupt');
  try {
    const { b0, before, after, tree, live, afterLive } = await smallBoard(fx, 'br-corrupt');
    const corruptOps = 'e1'.repeat(20) as Oid;
    plantCorrupt(fx, corruptOps, 'blob', Buffer.alloc(4_000, 0x61));
    const corruptLive = 'e2'.repeat(20) as Oid;
    plantCorrupt(fx, corruptLive, 'commit', commitBytes(tree, [live], `corrupt live\n\n${'l'.repeat(2_000)}\n`));
    const opsBoard = await hashRaw(fx, 'commit', commitBytes(await rawTree(fx, [['40000', 'checkpoint', await checkpointTree(fx)], ['100644', 'ops.jsonl', corruptOps]]), [b0, live], 'ops.jsonl cannot be inflated\n'));
    const liveBoard = await hashRaw(fx, 'commit', commitBytes(tree, [b0, corruptLive], 'its live commit cannot be inflated\n'));

    const { repo, calls } = spyRepo(fx);
    const items = [{ oid: before, height: 1 }, { oid: opsBoard, height: 2 }, { oid: after, height: 3 }, { oid: liveBoard, height: 4 }];
    const { reads: out, next } = await readBoardCommits(repo, items, { withLive: true });
    assert.equal(next, items.length);
    assert.deepEqual(reasonsOf(out), ['ok', 'unreadable', 'ok', 'unreadable']);
    assert.deepEqual([out[1], out[3]], [{ oid: opsBoard, height: 2, malformed: 'unreadable' }, { oid: liveBoard, height: 4, malformed: 'unreadable' }]);
    await equalsEngine(fx, out);
    assert.deepEqual([ownLive(out[0]), ownLive(out[2])], [live, afterLive]);
    assert.deepEqual(seenOf(calls), [
      '--batch-check 0', '--batch 128',
      '--batch-check 0', '--batch 0', '--batch-check 0', '--batch 128', '--batch-check 0', '--batch 0', '--batch-check 0', '--batch 128',
    ]);
    // Without its live commit the same board commit reads (readBoardCommit never reads the live commit).
    const alone = await readBoardCommits(repo, [{ oid: liveBoard, height: 4 }]);
    await equalsEngine(fx, alone.reads);
    assert.equal(reasonsOf(alone.reads)[0], 'ok');

    calls.length = 0;
    const lr = await readLiveCommits(repo, [live, corruptLive, afterLive, corruptLive]);
    // The failed round, then one round per distinct oid (a repeated oid is not read again).
    assert.deepEqual(seenOf(calls), ['--batch-check 0', '--batch 128', '--batch-check 0', '--batch 0', '--batch-check 0', '--batch 128', '--batch-check 0', '--batch 0']);
    assert.equal(lr.next, 4);
    assert.deepEqual(lr.reads.map((r) => ('malformed' in r ? r.malformed : r.oid)), [live, 'unreadable', afterLive, 'unreadable']);
    assert.deepEqual(lr.reads[1], { oid: corruptLive, malformed: 'unreadable' });
    assert.deepEqual(lr.reads[0], (await readLiveCommits(repo, [live])).reads[0]);
  } finally {
    await fx.cleanup();
  }
});

test('a board or live commit whose header does not parse reads unreadable, and a held/ tree that does not parse gives no held ids; the round is not thrown (R-V74)', async () => {
  const fx = await makeRepoFixture('viz-batchread-unparsed');
  try {
    const { b0, before, after, tree, live } = await smallBoard(fx, 'br-unparsed');
    // Since Plan 2 FA-1 parseCommitObject reads the header exactly as git's parse_commit_buffer does, so only a commit
    // git itself cannot parse reads unreadable: a `parent zzz` right after `tree`. hash-object refuses such a commit, so
    // it is written with --literally; a fetch without fsck can still bring one.
    const literal = async (bytes: string): Promise<Oid> =>
      parseOid((await fx.repo.run(['hash-object', '-t', 'commit', '--literally', '-w', '--stdin'], { stdin: Buffer.from(bytes, 'utf8') })).stdout.toString('utf8'));
    const badBoard = await literal(`tree ${tree}\nparent zzz\nparent ${b0}\nparent ${live}\nauthor ${IDENT}\ncommitter ${IDENT}\n\nboard\n`);
    const badLive = await literal(`tree ${tree}\nparent zzz\nauthor ${IDENT}\ncommitter ${IDENT}\n\nlive\n`);
    // What git accepts reads as git reads it (FA-1): a `parent` after `committer` is ignored, upper-case hex is an oid.
    const oddBoard = await hashRaw(fx, 'commit', Buffer.from(`tree ${tree}\nparent ${b0}\nparent ${live}\nauthor ${IDENT}\ncommitter ${IDENT}\nparent zzz\n\nboard\n`, 'utf8'));
    const oddLive = await hashRaw(fx, 'commit', Buffer.from(`tree ${tree}\nparent ${live.toUpperCase()}\nauthor ${IDENT}\ncommitter ${IDENT}\n\nlive\n`, 'utf8'));
    const namesBadLive = await hashRaw(fx, 'commit', commitBytes(tree, [b0, badLive], 'names an unparseable live commit\n'));
    // A held/ tree git resolves (`<oid>:held` decodes only the board tree) whose second record is cut short.
    const ops = await hashRaw(fx, 'blob', Buffer.from('{"not":"an op"}\n', 'utf8'));
    const leaf = await mktree(fx, [['100644', 'claim.json', await hashRaw(fx, 'blob', Buffer.from('{}\n', 'utf8'))]]);
    const heldBad = await rawTree(fx, [['40000', 'h-0001', leaf], Buffer.from('40000 h-0002\0abc', 'latin1')]);
    const heldBoard = await hashRaw(fx, 'commit', commitBytes(await mktree(fx, [['040000', 'checkpoint', await checkpointTree(fx)], ['100644', 'ops.jsonl', ops], ['040000', 'held', heldBad]]), [b0, live], 'held tree cut short\n'));

    const { repo, calls } = spyRepo(fx);
    const items = [
      { oid: before, height: 1 }, { oid: badBoard, height: 2 }, { oid: namesBadLive, height: 3 }, { oid: heldBoard, height: 4 }, { oid: after, height: 5 },
      { oid: oddBoard, height: 6 },
    ];
    const { reads: out, next } = await readBoardCommits(repo, items, { withLive: true });
    assert.equal(next, items.length);
    assert.deepEqual(seenOf(calls), ['--batch-check 0', '--batch 0'], 'git answered every name: one round');
    assert.deepEqual(reasonsOf(out), ['ok', 'unreadable', 'ok', 'ok', 'ok', 'ok']);
    assert.deepEqual(out[1], { oid: badBoard, height: 2, malformed: 'unreadable' });
    // The board commit that names the unparseable live commit reads; its live shape is null.
    await equalsEngine(fx, [out[0]!, out[2]!, out[4]!, out[5]!]);
    assert.deepEqual((out[5] as BoardRead).parents, [b0, live]);
    assert.deepEqual((out[2] as BoardRead).live, { oid: badLive, malformed: 'unreadable' });
    // The held/ tree that does not parse: no held ids; the rest of that board commit reads.
    const held = out[3] as BoardRead;
    assert.deepEqual([held.heldIds, held.opsLines, held.liveCode], [[], ['{"not":"an op"}'], live]);
    assert.equal(ownLive(out[4]), (await fx.repo.readCommit(after)).parents[1]);

    const lr = await readLiveCommits(repo, [badLive, live, oddLive]);
    assert.deepEqual(lr.reads[0], { oid: badLive, malformed: 'unreadable' });
    assert.equal((lr.reads[1] as LiveRead).oid, live);
    assert.deepEqual((lr.reads[2] as LiveRead).info.parents, [live]);
  } finally {
    await fx.cleanup();
  }
});
