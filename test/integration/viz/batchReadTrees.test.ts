// Batched board reads: board trees and missing objects (Plan 8a Task 2; 12 §3.3.2, §9.7 item 8; rulings R-V05, R-V19,
// R-V69). Which entries the fold reads is git's own lookup of the names it reads; an entry object the store lacks reads
// `missing`, an absent, wrongly typed or gitlink entry and a tree git cannot decode read as readBoardCommit reads them
// (an absent checkpoint/state.json blob: `entry_missing`, Plan 2 FA-2, never `missing`).
// Fixtures are written with git's own plumbing in the test (test/helpers/vizBatchRead.ts), never through src/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { isBoardReadFailure, type BoardRead } from '../../../src/board/batchRead.js';
import { readBoardCommit } from '../../../src/board/boardCommit.js';
import type { Oid } from '../../../src/git/oid.js';
import { BoardWriter } from '../../../tools/viz/boardWriter.js';
import { makeRepoFixture } from '../../helpers/repoFixture.js';
import {
  boardData, checkpointTree, commitBytes, hashRaw, mktree, NOT_STORED, NOT_STORED_2, rawTree, readOnce, spyRepo, type TreeRecord,
} from '../../helpers/vizBatchRead.js';

test('a missing board object (partial clone) reads as missing; an absent or gitlink entry does not; held/ subtrees are the held ids', async () => {
  const fx = await makeRepoFixture('viz-batchread-missing');
  try {
    const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'main', seed: 'br-missing' });
    const b0 = await w.genesis('ann');
    const live = (await fx.repo.readCommit(await w.commit({ writer: 'ann', cs: [{ paths: ['src/a.txt'] }] }))).parents[1]!;
    const blob = (text: string): Promise<Oid> => hashRaw(fx, 'blob', Buffer.from(text, 'utf8'));
    const board = async (tree: Oid, label: string): Promise<Oid> => hashRaw(fx, 'commit', commitBytes(tree, [b0, live], `${label}\n`));
    const ops = await blob('');
    const lostOps = await blob('{"lost":"ops"}\n');
    const lostProto = await blob('{"proto":1,"lost":"protocol"}\n');
    const lostState = await blob('{"lost":"state"}\n');
    const lostCk = await mktree(fx, [['100644', 'state.json', await blob('{"lost":"checkpoint tree"}\n')]]);
    const lostHeld = await mktree(fx, [['040000', 'x1', await mktree(fx, [['100644', 'f', await blob('lost held\n')]])]]);
    const leaf = await mktree(fx, [['100644', 'claim.json', await blob('{}\n')]]);
    const held = await mktree(fx, [['040000', 'h-0001', leaf], ['100644', 'not-a-hold', ops], ['040000', 'h-0002', leaf]]);
    const keptState = await blob('{"kept":"checkpoint"}\n');
    const gitlink = 'e'.repeat(40) as Oid;

    const missOps = await board(await mktree(fx, [['100644', 'ops.jsonl', lostOps]]), 'ops blob missing');
    const missProto = await board(await mktree(fx, [['100644', 'ops.jsonl', ops], ['100644', 'protocol.json', lostProto]]), 'protocol blob missing');
    const missState = await board(await mktree(fx, [['100644', 'ops.jsonl', ops], ['040000', 'checkpoint', await mktree(fx, [['100644', 'state.json', lostState]])]]), 'state blob missing');
    const missCk = await board(await mktree(fx, [['100644', 'ops.jsonl', ops], ['040000', 'checkpoint', lostCk]]), 'checkpoint tree missing');
    const missHeld = await board(await mktree(fx, [['100644', 'ops.jsonl', ops], ['040000', 'held', lostHeld]]), 'held tree missing');
    const lostRoot = await mktree(fx, [['100644', 'ops.jsonl', ops], ['100644', 'protocol.json', await blob('{"proto":1,"root":"lost"}\n')]]);
    const missRoot = await board(lostRoot, 'root tree missing');
    const ck = await checkpointTree(fx);
    const absent = await board(await mktree(fx, [['100644', 'ops.jsonl', ops], ['040000', 'checkpoint', ck]]), 'no protocol or held');
    const linked = await board(await mktree(fx, [['160000', 'ops.jsonl', gitlink], ['040000', 'checkpoint', ck], ['160000', 'held', gitlink]]), 'gitlinks');
    // Plan 2 FA-2: no checkpoint/state.json blob (absent, or a gitlink) is entry_missing, as readBoardCommit refuses it.
    const noCk = await board(await mktree(fx, [['100644', 'ops.jsonl', ops]]), 'no protocol, checkpoint or held');
    const linkedCk = await board(await mktree(fx, [['100644', 'ops.jsonl', ops], ['160000', 'checkpoint', gitlink]]), 'checkpoint gitlink');
    const kept = await board(await mktree(fx, [['100644', 'ops.jsonl', ops], ['040000', 'held', held], ['040000', 'checkpoint', await mktree(fx, [['100644', 'state.json', keptState]])]]), 'held ids');
    // The partial clone: these objects are gone from the store (loose objects, removed by path).
    for (const o of [lostOps, lostProto, lostState, lostCk, lostHeld, lostRoot]) rmSync(join(fx.paths.gitDir, 'objects', o.slice(0, 2), o.slice(2)));

    const items = [
      { oid: missOps, height: 1 }, { oid: missProto, height: 2 }, { oid: missState, height: 256 }, { oid: missState, height: 257 },
      { oid: missCk, height: 4 }, { oid: missHeld, height: 5 }, { oid: missRoot, height: 6 }, { oid: absent, height: 7 },
      { oid: linked, height: 512 }, { oid: kept, height: 768 }, { oid: kept, height: 9 }, { oid: noCk, height: 10 }, { oid: linkedCk, height: 1024 },
    ];
    const out = await readOnce(fx.repo, items, { withLive: true });
    assert.deepEqual(out.slice(0, 7), items.slice(0, 7).map((it) => ({ ...it, malformed: 'missing' })));
    for (const r of out.slice(7, 11)) assert.ok(!isBoardReadFailure(r), JSON.stringify(r));
    const [a, l, k768, k9] = out.slice(7, 11) as BoardRead[];
    // Absent and gitlink entries read as readBoardCommit reads them (nothing), not as missing objects.
    for (const [r, oid] of [[a!, absent], [l!, linked], [k768!, kept]] as const) assert.deepEqual({ ...boardData(r), checkpoint: null }, { ...(await readBoardCommit(fx.repo, oid)), checkpoint: null });
    assert.deepEqual([a!.opsLines, a!.heldIds, a!.checkpoint, l!.opsLines, l!.heldIds, l!.checkpoint], [[], [], null, [], [], Buffer.from('{}\n', 'utf8')]);
    // No checkpoint/state.json blob: entry_missing, the reason readBoardCommit gives, never missing.
    assert.deepEqual(out.slice(11), items.slice(11).map((it) => ({ ...it, malformed: 'entry_missing' })));
    for (const oid of [noCk, linkedCk]) await assert.rejects(readBoardCommit(fx.repo, oid), (e: unknown) => (e as { reason?: string }).reason === 'entry_missing');
    // held/: the subtree names in tree order; a blob under held/ is not a hold.
    assert.deepEqual(k768!.heldIds, ['h-0001', 'h-0002']);
    assert.deepEqual(k9!.heldIds, ['h-0001', 'h-0002']);
    assert.ok(k768!.checkpoint !== null && k768!.checkpoint.equals(Buffer.from('{"kept":"checkpoint"}\n')));
    assert.equal(k9!.checkpoint, null);
  } finally {
    await fx.cleanup();
  }
});

test('a malformed board tree that git still resolves reads as readBoardCommit reads it; the other items of the round are unaffected', async () => {
  const fx = await makeRepoFixture('viz-batchread-badtree');
  try {
    const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'main', seed: 'br-badtree' });
    const b0 = await w.genesis('ann');
    const before = await w.commit({ writer: 'ann', cs: [{ paths: ['src/a.txt'] }] });
    const after = await w.commit({ writer: 'ann', cs: [{ paths: ['src/b.txt'] }] });
    const live = (await fx.repo.readCommit(before)).parents[1]!;
    const blob = (text: string): Promise<Oid> => hashRaw(fx, 'blob', Buffer.from(text, 'utf8'));
    const board = async (tree: Oid, label: string): Promise<Oid> => hashRaw(fx, 'commit', commitBytes(tree, [b0, live], `${label}\n`));
    const ops = await blob('{"not":"an op"}\n');
    const protocol = await blob('{"proto":1}\n');
    const q = await blob('q\n');
    // A record git cannot decode (no space after the mode), after entries that every name the fold reads sorts before:
    // git's lookups never reach it, so --batch-check answers every name (the reviewer's probe).
    const bad = Buffer.concat([Buffer.from('100644zz\0', 'latin1'), Buffer.from(q, 'hex')]);
    const badRoot = await board(await rawTree(fx, [['40000', 'checkpoint', await checkpointTree(fx)], ['100644', 'ops.jsonl', ops], ['100644', 'protocol.json', protocol], ['100644', 'q', q], ['100644', 'r', q], bad]), 'malformed board tree');
    // checkpoint/ trees ending in the same record: one whose state.json lookup stops before it (t sorts after
    // state.json), one that lists state.json (a blob not in the store) first. Neither has a state.json git resolves:
    // entry_missing (Plan 2 FA-2), as readBoardCommit refuses them.
    const badCk = await board(await rawTree(fx, [['40000', 'checkpoint', await rawTree(fx, [['100644', 't', q], ['100644', 'u', q], bad])], ['100644', 'ops.jsonl', ops]]), 'malformed checkpoint tree');
    const badCkState = await board(await rawTree(fx, [['40000', 'checkpoint', await rawTree(fx, [['100644', 'state.json', NOT_STORED], ['100644', 'z', q], bad])], ['100644', 'ops.jsonl', ops]]), 'malformed checkpoint tree listing state.json');

    const { repo, calls } = spyRepo(fx);
    const items = [{ oid: before, height: 1 }, { oid: badRoot, height: 2 }, { oid: badCk, height: 256 }, { oid: badCkState, height: 257 }, { oid: after, height: 3 }];
    const out = await readOnce(repo, items, { withLive: true });
    assert.deepEqual(calls.map((c) => c.args), [['cat-file', '--batch-check'], ['cat-file', '--batch']], 'git answered every name of the round');
    for (const i of [0, 1, 4]) {
      const r = out[i]!;
      assert.ok(!isBoardReadFailure(r), `item ${i}: ${JSON.stringify(r)}`);
      assert.deepEqual({ ...boardData(r), checkpoint: null }, { ...(await readBoardCommit(fx.repo, items[i]!.oid)), checkpoint: null }, `item ${i}`);
    }
    // The unparseable checkpoint/ trees' unresolved state.json reads as absent, as readBoardCommit reads it: entry_missing.
    assert.deepEqual(out.slice(2, 4), items.slice(2, 4).map((it) => ({ ...it, malformed: 'entry_missing' })));
    for (const oid of [badCk, badCkState]) await assert.rejects(readBoardCommit(fx.repo, oid), (e: unknown) => (e as { reason?: string }).reason === 'entry_missing');
    const root = out[1] as BoardRead;
    // The unparseable tree's unresolved names read as absent, as readBoardCommit reads them; what git resolved is read.
    assert.deepEqual([root.opsLines, root.heldIds, root.checkpoint], [['{"not":"an op"}'], [], null]);
    // The live commits of the round: read once, then 'same'; the item after the malformed ones reads its own.
    assert.equal(root.live, 'same');
    const last = (out[4] as BoardRead).live;
    assert.ok(last !== null && last !== 'same' && !('malformed' in last) && last.oid === (await fx.repo.readCommit(after)).parents[1]);
  } finally {
    await fx.cleanup();
  }
});

test('a wrongly typed entry whose object is missing reads as absent, as the fold reads it; git\'s own lookup decides which entry a name is, a slash-named leaf included', async () => {
  const fx = await makeRepoFixture('viz-batchread-wrongtype');
  try {
    const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'main', seed: 'br-wrongtype' });
    const b0 = await w.genesis('ann');
    const live = (await fx.repo.readCommit(b0)).parents[0]!;   // L0: any live commit will do here
    const blob = (text: string): Promise<Oid> => hashRaw(fx, 'blob', Buffer.from(text, 'utf8'));
    const ops = await blob('');
    const q = await blob('q\n');
    const board = async (label: string, records: readonly TreeRecord[]): Promise<Oid> => hashRaw(fx, 'commit', commitBytes(await rawTree(fx, records), [b0, live], `${label}\n`));
    const ckOf = async (records: readonly TreeRecord[]): Promise<TreeRecord> => ['40000', 'checkpoint', await rawTree(fx, records)];

    // Absent: the tree's mode names another type than the fold reads (git's canon_mode: a directory, a regular file or
    // symlink, else a gitlink), or git's own lookup does not reach the entry (it takes the first entry of a name and
    // stops at the first entry that sorts after it). readBoardCommit reads them as absent whatever the store holds.
    // These carry a checkpoint/state.json git resolves (Plan 2 FA-2), so they read.
    const ck: TreeRecord = ['40000', 'checkpoint', await checkpointTree(fx)];
    const absent = [
      await board('ops.jsonl is a directory', [ck, ['40000', 'ops.jsonl', NOT_STORED]]),
      await board('protocol.json is a directory', [ck, ['100644', 'ops.jsonl', ops], ['40000', 'protocol.json', NOT_STORED]]),
      await board('held is a file', [ck, ['100644', 'held', NOT_STORED], ['100644', 'ops.jsonl', ops]]),
      await board('unsorted: q before ops.jsonl', [ck, ['100644', 'q', q], ['100644', 'ops.jsonl', NOT_STORED]]),
      await board('duplicate ops.jsonl, a directory first', [ck, ['40000', 'ops.jsonl', NOT_STORED], ['100644', 'ops.jsonl', NOT_STORED_2]]),
    ];
    // The same lookups for checkpoint/state.json itself: absent, so the board commit is entry_missing (Plan 2 FA-2), the
    // reason readBoardCommit gives, never missing, whatever the store holds.
    const noCheckpoint = [
      await board('checkpoint is a file', [['100644', 'checkpoint', NOT_STORED], ['100644', 'ops.jsonl', ops]]),
      await board('state.json is a directory', [await ckOf([['40000', 'state.json', NOT_STORED]]), ['100644', 'ops.jsonl', ops]]),
      await board('gitlinks by canon_mode', [['170000', 'checkpoint', NOT_STORED], ['0', 'held', NOT_STORED], ['100644', 'ops.jsonl', ops], ['160000', 'protocol.json', NOT_STORED]]),
      await board('unsorted: checkpoint0 before checkpoint', [['100644', 'checkpoint0', q], await ckOf([['100644', 'state.json', NOT_STORED]]), ['100644', 'ops.jsonl', ops]]),
      // A record named `checkpoint/state.json` that comes first is the entry git's lookup of that path takes (a full
      // name match before any directory); it counts by its own mode, and checkpoint/ is never descended into.
      await board('slash-named leaf is a tree', [['40000', 'checkpoint/state.json', NOT_STORED], await ckOf([['100644', 'state.json', NOT_STORED_2]]), ['100644', 'ops.jsonl', ops]]),
      await board('slash-named leaf is a gitlink', [['160000', 'checkpoint/state.json', NOT_STORED], await ckOf([['100644', 'state.json', NOT_STORED_2]]), ['100644', 'ops.jsonl', ops]]),
      // checkpoint/ itself counts only when git's lookup of checkpoint/state.json reaches it.
      await board('unsorted: checkpoint0 before a missing checkpoint/ tree', [['100644', 'checkpoint0', q], ['40000', 'checkpoint', NOT_STORED], ['100644', 'ops.jsonl', ops]]),
      await board('slash-named tree leaf before a missing checkpoint/ tree', [['40000', 'checkpoint/state.json', NOT_STORED], ['40000', 'checkpoint', NOT_STORED_2], ['100644', 'ops.jsonl', ops]]),
    ];
    // Missing: the mode names the type the fold reads (a symlink is a blob; modes as git parses them).
    const missing = [
      await board('protocol.json is a symlink', [['100644', 'ops.jsonl', ops], ['120000', 'protocol.json', NOT_STORED]]),
      await board('ops.jsonl is executable', [['100755', 'ops.jsonl', NOT_STORED]]),
      await board('held with a zero-padded mode', [['040000', 'held', NOT_STORED], ['100644', 'ops.jsonl', ops]]),
      // The slash-named leaf git resolves is a blob the store lacks, with no checkpoint/ directory or one without state.json.
      await board('slash-named blob leaf, no checkpoint/', [['100644', 'checkpoint/state.json', NOT_STORED], ['100644', 'ops.jsonl', ops]]),
      await board('slash-named blob leaf before a checkpoint/ without state.json', [['100644', 'checkpoint/state.json', NOT_STORED], await ckOf([['100644', 'z', q]]), ['100644', 'ops.jsonl', ops]]),
    ];

    const items = [...absent, ...noCheckpoint, ...missing].map((oid, i) => ({ oid, height: i + 1 }));
    const out = await readOnce(fx.repo, items, { withLive: true });
    assert.deepEqual(out.map((r) => (isBoardReadFailure(r) ? r.malformed : 'read')),
      [...absent.map(() => 'read'), ...noCheckpoint.map(() => 'entry_missing'), ...missing.map(() => 'missing')]);
    for (let i = 0; i < absent.length; i++) {
      const r = out[i]!;
      assert.ok(!isBoardReadFailure(r), `absent ${i}: ${JSON.stringify(r)}`);
      assert.deepEqual({ ...boardData(r), checkpoint: null }, { ...(await readBoardCommit(fx.repo, absent[i]!)), checkpoint: null }, `absent ${i}`);
      assert.deepEqual([r.opsLines, r.heldIds, r.checkpoint], [[], [], null], `absent ${i}`);
    }
    for (const oid of noCheckpoint) await assert.rejects(readBoardCommit(fx.repo, oid), (e: unknown) => (e as { reason?: string }).reason === 'entry_missing', oid);
    const rest = absent.length + noCheckpoint.length;
    assert.deepEqual(out.slice(absent.length, rest), items.slice(absent.length, rest).map((it) => ({ ...it, malformed: 'entry_missing' })));
    assert.deepEqual(out.slice(rest), items.slice(rest).map((it) => ({ ...it, malformed: 'missing' })));
  } finally {
    await fx.cleanup();
  }
});
