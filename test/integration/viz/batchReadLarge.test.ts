// Batched board reads over long scripted boards (Plan 8a Task 2; 12 §3.3.2, §9.7 items 2 and 8; rulings R-V05, R-V69):
// a 600-commit board against readBoardCommit and a full 1,280-commit batch against the process count. Kept apart from
// batchRead.test.ts so each file stays within the 60 s integration budget under load. Boards come from
// tools/viz/boardWriter.ts (`commitMany`, one git fast-import); every git call of the reader goes through a runner spy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBoardReadFailure, readBoardCommits, readLiveCommits, READ_BATCH_MAX, type BoardRead } from '../../../src/board/batchRead.js';
import { decodeCsPaths, readBoardCommit, type BoardCommitData } from '../../../src/board/boardCommit.js';
import type { Oid } from '../../../src/git/oid.js';
import type { GitRepo } from '../../../src/git/repo.js';
import { BoardWriter, type ScriptCommit } from '../../../tools/viz/boardWriter.js';
import { makeRepoFixture, type RepoFixture } from '../../helpers/repoFixture.js';
import { boardData, chain, many, readOnce, SEAT, spyRepo } from '../../helpers/vizBatchRead.js';

async function readEach(repo: GitRepo, oids: readonly Oid[]): Promise<BoardCommitData[]> {
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

function script(n: number): ScriptCommit[] {
  const kinds: ScriptCommit[] = [
    { writer: 'ann', cs: [{ paths: ['src/a.txt'] }, { paths: ['src/b.txt', 'docs/x.md'], checks: 'pass' }] },
    { writer: 'bob', code: 'base_move' },
    { writer: 'bob', cs: [{ paths: many(300, 'big') }] },
    { writer: 'ann', ops: [{ type: 'seat_start', seat_id: SEAT, permission_mode: 'default' }] },
    { writer: 'ann', cs: [{ seat: SEAT, origin: 'wake', paths: ['src/c.txt'] }] },
    { writer: 'ann', ops: [{ type: 'seat_end', seat_id: SEAT, permission_mode: 'default' }] },
    { writer: 'bob', ops: [{ type: 'event', cid: '', kind: 'freeze', refs: ['src/a.txt'], reason_code: 'TEST_REASON' }] },
    { writer: 'bob', rawOps: ['{"truncated":', '[]'] },
    { writer: null, rawOps: ['{}'] },
    { writer: 'ann', badWriterTrailer: true },
    { writer: 'bob', cs: [{ paths: many(256, 'edge') }] },
    { writer: 'ann' },
  ];
  return Array.from({ length: n }, (_, i) => kinds[i % kinds.length]!);
}

async function writtenBoard(fx: RepoFixture, height: number, seed: string): Promise<{ w: BoardWriter; oids: Oid[] }> {
  const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'main', seed });
  await w.genesis('ann');
  await w.join('bob');
  await w.commitMany(script(height - 1));
  assert.equal(w.tip().height, height);
  return { w, oids: await chain(fx.repo, w.tip().oid) };
}

test('readBoardCommits equals readBoardCommit for every oid of a 600-commit scripted board, except checkpoint off multiples of 256', async () => {
  const fx = await makeRepoFixture('viz-batchread-equal');
  try {
    const { oids } = await writtenBoard(fx, 599, 'br-equal');
    assert.equal(oids.length, 600);
    const items = oids.map((oid, height) => ({ oid, height }));
    const { repo, calls } = spyRepo(fx);
    const batch = await readOnce(repo, items);
    const each = await readEach(fx.repo, oids);
    let withPaths = 0;
    let bigSets = 0;
    for (let h = 0; h < oids.length; h++) {
      const r = batch[h]!;
      assert.ok(!isBoardReadFailure(r), `height ${h}`);
      assert.equal(r.height, h);
      assert.equal(r.live, null, 'withLive defaults to false');
      const want = each[h]!;
      if (h % 256 === 0) assert.ok(r.checkpoint !== null && want.checkpoint !== null && r.checkpoint.equals(want.checkpoint), `height ${h}: checkpoint`);
      else assert.equal(r.checkpoint, null, `height ${h}: no checkpoint off multiples of 256`);
      assert.deepEqual({ ...boardData(r), checkpoint: null }, { ...want, checkpoint: null }, `height ${h}`);
      // csPaths: the decoded Cowork-CS-Paths trailers of the board commit itself.
      const expected = new Map<string, string[]>();
      for (const t of r.info.trailers) {
        if (t.key !== 'Cowork-CS-Paths') continue;
        const sp = t.value.indexOf(' ');
        expected.set(t.value.slice(0, sp), decodeCsPaths(t.value.slice(sp + 1))!);
      }
      assert.deepEqual(r.csPaths, expected, `height ${h}: csPaths`);
      withPaths += expected.size;
      for (const c of r.cs) {
        if (c.paths > 256) {
          bigSets++;
          assert.equal(r.csPaths.has(c.csId), false, `height ${h}: a > 256-path change-set has no path list`);
        }
      }
    }
    assert.ok(withPaths > 100 && bigSets > 40, `path lists ${withPaths}, big change-sets ${bigSets}`);
    // A kept checkpoint is a copy, not a view that pins the whole --batch output.
    const stdout = calls.find((c) => c.args[1] === '--batch')!.stdout;
    for (const h of [0, 256, 512]) assert.notEqual((batch[h] as BoardRead).checkpoint!.buffer, stdout.buffer, `height ${h}: checkpoint is a view of the --batch output`);
    // info is the board commit as GitRepo.readCommit reads it (sampled).
    for (let h = 0; h < oids.length; h += 37) assert.deepEqual((batch[h] as BoardRead).info, await fx.repo.readCommit(oids[h]!));
  } finally {
    await fx.cleanup();
  }
});

test('a batch is exactly one cat-file --batch-check and one cat-file --batch process', async () => {
  const fx = await makeRepoFixture('viz-batchread-procs');
  try {
    const { oids } = await writtenBoard(fx, READ_BATCH_MAX - 1, 'br-procs');
    assert.equal(oids.length, READ_BATCH_MAX);
    const { repo, calls } = spyRepo(fx);
    const items = oids.map((oid, height) => ({ oid, height }));
    const out = await readOnce(repo, items, { withLive: true });
    assert.deepEqual(calls.map((c) => c.args), [['cat-file', '--batch-check'], ['cat-file', '--batch']]);
    // Every live commit named once at most on the --batch stdin; a repeated one is 'same' and not read again.
    const read = calls[1]!.stdin.split('\n').filter((l) => l.length > 0);
    assert.equal(new Set(read).size, read.length, 'an object is read once');
    let same = 0;
    let lives = 0;
    for (let h = 0; h < out.length; h++) {
      const r = out[h] as BoardRead;
      assert.ok(!isBoardReadFailure(r));
      if (r.live === 'same') {
        same++;
        assert.equal(r.liveCode, (out[h - 1] as BoardRead).liveCode, `height ${h}: 'same' repeats the preceding live commit`);
      } else {
        lives++;
        assert.ok(r.live !== null && !('malformed' in r.live), `height ${h}`);
        assert.equal(r.live.oid, r.liveCode);
        assert.notEqual(r.liveCode, h === 0 ? null : (out[h - 1] as BoardRead).liveCode);
        assert.ok(read.includes(r.liveCode));
      }
    }
    assert.ok(same > 300 && lives > 300, `same ${same}, read ${lives}`);
    // opts.prevLive: the first item's live commit is the caller's.
    const k = out.findIndex((r, h) => h > 0 && (r as BoardRead).live === 'same' && (out[h + 1] as BoardRead).live !== 'same');
    assert.ok(k > 0);
    calls.length = 0;
    const tail = await readOnce(repo, items.slice(k, k + 2), { withLive: true, prevLive: (out[k - 1] as BoardRead).liveCode });
    assert.equal((tail[0] as BoardRead).live, 'same');
    assert.deepEqual((tail[1] as BoardRead).live, (out[k + 1] as BoardRead).live);
    assert.ok(!calls[1]!.stdin.includes((tail[0] as BoardRead).liveCode), 'the caller\'s live commit is not read again');

    // 1,281 items (or oids) → RangeError, nothing spawned; no items → no process.
    calls.length = 0;
    const over = [...items, { oid: oids[0]!, height: 0 }];
    await assert.rejects(readBoardCommits(repo, over), RangeError);
    await assert.rejects(readLiveCommits(repo, over.map((i) => i.oid)), RangeError);
    assert.deepEqual(await readBoardCommits(repo, []), { reads: [], next: 0 });
    assert.deepEqual(await readLiveCommits(repo, []), { reads: [], next: 0 });
    assert.equal(calls.length, 0);
    // readLiveCommits: one --batch-check and one --batch for many live commits.
    const liveOids = out.map((r) => (r as BoardRead).liveCode);
    const lr = await readLiveCommits(repo, liveOids);
    assert.deepEqual(calls.map((c) => c.args), [['cat-file', '--batch-check'], ['cat-file', '--batch']]);
    assert.equal(lr.next, liveOids.length);
    assert.equal(lr.reads.length, liveOids.length);
    assert.equal(new Set(calls[1]!.stdin.split('\n').filter((l) => l.length > 0)).size, new Set(liveOids).size);
  } finally {
    await fx.cleanup();
  }
});
