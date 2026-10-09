// R-V69's byte budget on both read paths (Plan 8a Task 2; 12 §3.3.2; rulings R-V69, R-V74): each call of
// readBoardCommits / readLiveCommits keeps at most 32 MiB of `cat-file --batch` output, whether its round is one --batch
// or, when git dies on the round, item-by-item rounds; the caller reads the rest from `next`. The near-cap fixtures are
// written with git's own plumbing in the test (test/helpers/vizBatchRead.ts), the corrupt loose objects with node:zlib;
// never through src/. Every git call goes through a runner spy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBoardReadFailure, readBoardCommits, type LiveRead } from '../../../src/board/batchRead.js';
import { BATCH_READ_MAX_BYTES, readBoardCommit } from '../../../src/board/boardCommit.js';
import type { Oid } from '../../../src/git/oid.js';
import { makeRepoFixture } from '../../helpers/repoFixture.js';
import {
  boardData, commitBytes, equalsEngine, hashRaw, keptBatchBytes, nearCapBoard, ownLive, plantCorrupt, rawTree, readAllBoard, readAllLive, reasonsOf,
  seenOf, smallBoard, spyRepo, type Call, type Step,
} from '../../helpers/vizBatchRead.js';

/** n item rounds that read: a --batch-check and a --batch, both completed. */
const pairs = (n: number): string[] => Array.from({ length: n }, () => ['--batch-check 0', '--batch 0']).flat();

/** R-V69 on every path: each call keeps at most 32 MiB of `cat-file --batch` output, and no --batch prints more. */
function withinBudget(steps: readonly Step[]): void {
  steps.forEach((s, k) => {
    const kept = keptBatchBytes(s.git);
    assert.ok(kept <= BATCH_READ_MAX_BYTES, `call ${k} kept ${kept} bytes of --batch output > ${BATCH_READ_MAX_BYTES}`);
    for (const c of s.git) assert.ok(c.args[1] !== '--batch' || c.stdout.length <= BATCH_READ_MAX_BYTES, `call ${k}: one --batch printed ${c.stdout.length} bytes`);
  });
}

/** The objects completed --batch calls read, with how often each was read. */
function readCounts(calls: readonly Call[]): Map<string, number> {
  const n = new Map<string, number>();
  for (const c of calls) {
    if (c.args[1] !== '--batch' || c.code !== 0) continue;
    for (const o of c.stdin.split('\n')) if (o.length > 0) n.set(o, (n.get(o) ?? 0) + 1);
  }
  return n;
}

test('each --batch stays within 32 MiB: a hostile board of near-cap commits is read as fitting prefixes, every item eventually (R-V69)', async () => {
  const fx = await makeRepoFixture('viz-batchread-budget');
  try {
    // Eight board commits of ~1 MB each (message), each with its own ~4.9 MB protocol.json and its own ~1 MB live
    // commit: ~55 MB of objects within every cap.
    const { b0, tree0, items, lives } = await nearCapBoard(fx, 'br-budget');
    const { repo, calls } = spyRepo(fx);
    const first = await readBoardCommits(repo, items, { withLive: true });
    const batches = (): Call[] => calls.filter((c) => c.args[1] === '--batch');
    const peak = (): number => Math.max(...batches().map((c) => c.stdout.length));
    assert.ok(peak() <= BATCH_READ_MAX_BYTES, `one --batch buffered ${peak()} bytes > ${BATCH_READ_MAX_BYTES}`);
    assert.ok(first.next >= 1 && first.next < items.length, `next ${first.next}`);

    calls.length = 0;
    const { out, steps } = await readAllBoard(repo, items, true);
    const rounds = steps.length;
    assert.ok(rounds >= 2, `${rounds} rounds`);
    assert.equal(calls.length, 2 * rounds, 'one --batch-check and one --batch per round');
    for (let i = 0; i < calls.length; i++) assert.deepEqual(calls[i]!.args, ['cat-file', i % 2 === 0 ? '--batch-check' : '--batch']);
    assert.ok(peak() <= BATCH_READ_MAX_BYTES, `one --batch buffered ${peak()} bytes > ${BATCH_READ_MAX_BYTES}`);
    assert.ok(batches().every((c) => c.stdout.length > 0));
    // Every item read, each board and live commit once across the rounds (an object every round shares, the empty
    // ops.jsonl blob, is read once per round), and each equal to readBoardCommit.
    const readLines = batches().flatMap((c) => c.stdin.split('\n').filter((x) => x.length > 0));
    for (const o of [...items.map((it) => it.oid), ...lives]) assert.equal(readLines.filter((x) => x === o).length, 1, `${o} read once`);
    for (let i = 0; i < items.length; i++) {
      const r = out[i]!;
      assert.ok(!isBoardReadFailure(r), `height ${i + 1}`);
      assert.deepEqual(boardData(r), { ...(await readBoardCommit(fx.repo, items[i]!.oid)), checkpoint: null });
      assert.ok(r.live !== null && r.live !== 'same' && !('malformed' in r.live) && r.live.oid === lives[i]);
    }

    // readLiveCommits: the same budget over many ~1 MB live commits.
    calls.length = 0;
    const repeated = Array.from({ length: 40 }, (_, i) => lives[i % lives.length]!);
    const huge = await Promise.all(Array.from({ length: 40 }, (_, i) => hashRaw(fx, 'commit', commitBytes(tree0, [b0], `big live ${i}\n\n${'x'.repeat(1_000_000)}\n`))));
    const all = [...repeated, ...huge];
    const { out: got } = await readAllLive(repo, all);
    assert.ok(batches().length >= 2, `${batches().length} --batch calls`);
    assert.ok(peak() <= BATCH_READ_MAX_BYTES, `one --batch buffered ${peak()} bytes > ${BATCH_READ_MAX_BYTES}`);
    got.forEach((r, i) => assert.equal((r as LiveRead).oid, all[i]));
  } finally {
    await fx.cleanup();
  }
});

test('the item-by-item path keeps the 32 MiB budget: a near-cap board with a tree git dies on is read in calls of at most 32 MiB of --batch output, the dying item unreadable (R-V74, R-V69)', async () => {
  const fx = await makeRepoFixture('viz-batchread-fatal-budget');
  try {
    const { items: near, lives } = await nearCapBoard(fx, 'br-fatal-budget');
    const q = await hashRaw(fx, 'blob', Buffer.from('q\n', 'utf8'));
    const noSpace = Buffer.concat([Buffer.from('100644zz\0', 'latin1'), Buffer.from(q, 'hex')]);
    const fatal = await hashRaw(fx, 'commit', commitBytes(await rawTree(fx, [['100644', 'd0123456789', q], noSpace]), [near[5]!.oid, lives[5]!], 'git dies on the board tree\n'));
    // Nine items: the eight near-cap board commits (~6.9 MB of --batch output each with its live commit: 4 fit 32 MiB,
    // 5 do not) with the one git dies on seventh.
    const oids = [...near.slice(0, 6).map((it) => it.oid), fatal, ...near.slice(6).map((it) => it.oid)];
    const items = oids.map((oid, i) => ({ oid, height: i + 1 }));

    const { repo, calls } = spyRepo(fx);
    const { out, steps } = await readAllBoard(repo, items, true, calls);
    withinBudget(steps);
    // First call: git dies on the round (its --batch-check names the fatal tree), the items are read one by one, and the
    // fifth near-cap item would push the call over 32 MiB: its --batch-check runs, its --batch does not.
    assert.deepEqual(steps.map((s) => s.next), [4, 5]);
    assert.deepEqual(seenOf(steps[0]!.git), ['--batch-check 128', ...pairs(4), '--batch-check 0']);
    // Second call (from the fifth item, the caller's prevLive carried): git dies again; the fatal item reads unreadable
    // at no cost, so the four near-cap items around it fit.
    assert.deepEqual(seenOf(steps[1]!.git), ['--batch-check 128', ...pairs(2), '--batch-check 128', ...pairs(2)]);
    // Every item read: the dying one unreadable, the others as readBoardCommit reads them, each with its own live
    // commit; every board and live commit read once (the item that did not fit is read by the next call only).
    assert.deepEqual(reasonsOf(out), ['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'unreadable', 'ok', 'ok']);
    assert.deepEqual(out[6], { oid: fatal, height: 7, malformed: 'unreadable' });
    await equalsEngine(fx, out);
    assert.deepEqual([0, 1, 2, 3, 4, 5, 7, 8].map((i) => ownLive(out[i])), lives);
    const counts = readCounts(calls);
    for (const o of [...near.map((it) => it.oid), ...lives]) assert.equal(counts.get(o), 1, `${o} read once`);
  } finally {
    await fx.cleanup();
  }
});

test('readLiveCommits keeps the 32 MiB budget on its item-by-item path: a corrupt live commit among ~1 MB ones reads unreadable at no cost (R-V74, R-V69)', async () => {
  const fx = await makeRepoFixture('viz-batchread-corrupt-budget');
  try {
    const { b0, tree } = await smallBoard(fx, 'br-corrupt-budget');
    const huge = await Promise.all(Array.from({ length: 40 }, (_, i) => hashRaw(fx, 'commit', commitBytes(tree, [b0], `big live ${i}\n\n${'x'.repeat(1_000_000)}\n`))));
    // --batch-check sizes it (~1 MB, its header inflates); --batch dies on it (exit 128).
    const corrupt = 'e3'.repeat(20) as Oid;
    plantCorrupt(fx, corrupt, 'commit', commitBytes(tree, [b0], `corrupt live\n\n${'c'.repeat(1_000_000)}\n`));
    // 42 oids: a ~1 MB live commit, the corrupt one, the first again, then the 39 other ~1 MB ones (33 of them fit
    // 32 MiB of --batch output, 34 do not).
    const oids = [huge[0]!, corrupt, huge[0]!, ...huge.slice(1)];

    const { repo, calls } = spyRepo(fx);
    const { out, steps } = await readAllLive(repo, oids, calls);
    withinBudget(steps);
    // First call: git dies on the round's --batch (the corrupt commit is in it), the oids are read one by one — the
    // corrupt one unreadable at no cost, the repeat not read again — and the 34th ~1 MB commit would push the call
    // over 32 MiB: its --batch-check runs, its --batch does not.
    assert.deepEqual(steps.map((s) => s.next), [35, 7]);
    assert.deepEqual(seenOf(steps[0]!.git), ['--batch-check 0', '--batch 128', ...pairs(1), '--batch-check 0', '--batch 128', ...pairs(32), '--batch-check 0']);
    assert.deepEqual(seenOf(steps[1]!.git), ['--batch-check 0', '--batch 0']);
    // Every oid read: the corrupt one unreadable, the repeat equal to the first, each ~1 MB commit read once.
    assert.deepEqual(out[1], { oid: corrupt, malformed: 'unreadable' });
    assert.deepEqual(out[2], out[0]);
    out.forEach((r, i) => {
      if (i !== 1) assert.ok(!('malformed' in r) && r.oid === oids[i], `oid ${i}: ${JSON.stringify('malformed' in r ? r : r.oid)}`);
    });
    const counts = readCounts(calls);
    for (const o of huge) assert.equal(counts.get(o), 1, `${o} read once`);
  } finally {
    await fx.cleanup();
  }
});
