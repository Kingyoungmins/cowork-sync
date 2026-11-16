// The git room source's first window read with its start state (viz-hosted-perf; 12 §3.12 row 4, §3.13 `startAt(h, upTo)`):
// startAt(h0, upTo) reads h0…upTo in one batch and the next frames() call takes those reads instead of reading them again —
// never changing what is returned or folded. Here: over a checkpoint that parses at h0 > 0, the frames equal a source that reads
// h0 alone, a shorter frames() takes a slice and the rest is read anew, and an upTo outside the pinned chain reads h0 alone; over a
// malformed board commit at h0 (no checkpoint/state.json, `entry_missing`) no read is kept, so frames() reads the window again and
// its frames equal a fold from genesis. Real boards in clones on file:// remotes (the skew test's fast-import tail for the second);
// apart from gitSourceSkew.test.ts for the 60 s file budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOid, type Oid } from '../../../src/git/oid.js';
import { ZERO_PEER, type Frame } from '../../../src/viz/model/frame.js';
import { BoardWriter } from '../../../tools/viz/boardWriter.js';
import { makeRepoFixture, type RepoFixture } from '../../helpers/repoFixture.js';
import { testRunner } from '../../helpers/tmp.js';
import { hashRaw, mktree } from '../../helpers/vizBatchRead.js';
import { collect, script, sourceOf, type SpiedVizGit } from '../../helpers/vizSource.js';

/** Every `cat-file --batch-check` call's board items (its stdin lines naming `<oid>^{tree}`), from call `from` on. */
const batchItems = (sg: SpiedVizGit, from: number): number[] =>
  sg.calls.slice(from).filter((c) => c.args[0] === 'cat-file' && c.args[1] === '--batch-check').map((c) => c.stdin.split('\n').filter((l) => l.endsWith('^{tree}')).length);
/** A frame without its fold states (compared at the ends instead: 1,023 of them are slow to deep-compare). */
const strip = (f: Frame): unknown => ({ ...f, before: null, after: null });

test('startAt(h0, upTo) over a checkpoint that parses at h0 = 256 (tip 1,279): one batch for h0 and the window, frames() reads nothing and its frames equal those of a source that reads h0 alone; a shorter frames() takes a slice, the rest is read anew; an upTo outside the chain reads h0 alone', async () => {
  const fx = await makeRepoFixture('viz-gitsrc-window');
  try {
    const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'main', seed: 'gitsrc-window' });
    await w.genesis('ann');
    await w.join('bob');
    await w.commitMany(script(1_278));
    assert.equal(w.tip().height, 1_279);
    // The reference: h0 read alone (no upTo), then the window's frames read by frames() itself.
    const { src: ref, sg: rg } = sourceOf(fx, w.ref);
    assert.deepEqual(await ref.tip(), { height: 1_279, key: w.tip().oid });
    let n = rg.calls.length;
    const refStart = await ref.startAt(256);
    assert.deepEqual(batchItems(rg, n), [1], 'the checkpoint at 256 parses: h0 alone, no fold-up');
    assert.equal(refStart.height, 256);
    const want = await collect(ref.frames(refStart, 257, 1_279, ZERO_PEER));
    assert.equal(want.length, 1_023);

    const { src, sg } = sourceOf(fx, w.ref);
    await src.tip();
    n = sg.calls.length;
    const start = await src.startAt(256, 1_279);
    assert.deepEqual(batchItems(sg, n), [1_024], 'h0 and the window 257…1,279 in one --batch-check/--batch pair');
    assert.deepEqual(start, refStart, 'the same start state');
    n = sg.calls.length;
    const got = await collect(src.frames(start, 257, 1_279, ZERO_PEER));
    assert.deepEqual(sg.calls.slice(n), [], 'frames() takes the reads startAt made: no git process');
    assert.deepEqual(got.map(strip), want.map(strip));
    assert.deepEqual(got.at(-1)!.after, want.at(-1)!.after);

    // A frames() call shorter than upTo takes the first reads only; the rest of the window is then read by frames() itself.
    const { src: part, sg: pg } = sourceOf(fx, w.ref);
    await part.tip();
    const pStart = await part.startAt(256, 1_279);
    n = pg.calls.length;
    const head = await collect(part.frames(pStart, 257, 300, ZERO_PEER));
    assert.deepEqual(pg.calls.slice(n), [], 'the slice 257…300: no git process');
    assert.deepEqual(head.map(strip), want.slice(0, 44).map(strip));
    assert.deepEqual(head.at(-1)!.after, want[43]!.after);
    n = pg.calls.length;
    const rest = await collect(part.frames(head.at(-1)!.after, 301, 1_279, ZERO_PEER));
    assert.deepEqual(batchItems(pg, n), [979], 'the reads are taken once: 301…1,279 read anew');
    assert.deepEqual(rest.map(strip), want.slice(44).map(strip));
    assert.deepEqual(rest.at(-1)!.after, want.at(-1)!.after);

    // An upTo above the pinned tip or below h0 is not a window of this chain: h0 is read alone, as without upTo.
    for (const upTo of [1_280, 255]) {
      n = rg.calls.length;
      assert.deepEqual(await ref.startAt(256, upTo), refStart);
      assert.deepEqual(batchItems(rg, n), [1], `upTo ${upTo}: h0 alone`);
    }
  } finally {
    await fx.cleanup();
  }
});

/**
 * `n` board-only commits on top of `from` into `ref`, by one git fast-import (the skew test's tail): each names the live commit
 * `live`, holds an empty ops.jsonl, the protocol.json blob `protocol` and, except the first when `bareFirst`, the tree
 * `checkpoint` at checkpoint/ (a board commit without checkpoint/state.json reads as malformed `entry_missing`). Returns the tip.
 */
async function tail(fx: RepoFixture, o: { ref: string; from: Oid; live: Oid; protocol: Oid; checkpoint: Oid; n: number; bareFirst: boolean }): Promise<Oid> {
  const ops = await hashRaw(fx, 'blob', Buffer.alloc(0));
  const parts: string[] = [];
  for (let i = 0; i < o.n; i++) {
    const msg = `window ${i}\n`;
    parts.push(`commit ${o.ref}\nmark :${i + 1}\ncommitter F <f@cowork.invalid> 1700000000 +0000\ndata ${Buffer.byteLength(msg, 'utf8')}\n${msg}`);
    parts.push(`from ${i === 0 ? o.from : `:${i}`}\nmerge ${o.live}\ndeleteall\n`);
    parts.push(`M 100644 ${ops} ops.jsonl\nM 100644 ${o.protocol} protocol.json\n${i === 0 && o.bareFirst ? '' : `M 040000 ${o.checkpoint} checkpoint\n`}\n`);
  }
  parts.push(`get-mark :${o.n}\ndone\n`);
  const r = await fx.repo.run(['fast-import', '--quiet', '--done'], { stdin: Buffer.from(parts.join(''), 'utf8') });
  return parseOid(r.stdout.toString('utf8').trim());
}

test('startAt(h0, upTo) over a malformed board commit at h0 = 256 (no checkpoint/state.json): no read is kept, so frames() reads the window again, and the start state and the frames equal a fold from genesis', async () => {
  const fx = await makeRepoFixture('viz-gitsrc-window-malformed');
  try {
    const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'main', seed: 'gitsrc-window-malformed' });
    await w.genesis('ann');
    await w.join('bob');
    await w.commitMany(script(254));
    assert.equal(w.tip().height, 255);
    const base = w.tip().oid;
    const live = (await fx.repo.readCommit(base)).parents[1]!;
    const protocol = parseOid((await testRunner().run(['rev-parse', `${base}:protocol.json`], { class: 'local', cwd: fx.paths.workTree })).stdout.toString('utf8').trim());
    // Above 256 a checkpoint this build cannot parse (as in gitSourceSkew.test.ts): only 256's absence matters here.
    const blob = await hashRaw(fx, 'blob', Buffer.from('{"v":2,"height":0,"from":"a newer build"}\n', 'utf8'));
    const checkpoint = await mktree(fx, [['100644', 'state.json', blob]]);
    const tip = await tail(fx, { ref: w.ref, from: base, live, protocol, checkpoint, n: 1_024, bareFirst: true });   // heights 256…1,279

    const { src: ref } = sourceOf(fx, w.ref);
    assert.deepEqual(await ref.tip(), { height: 1_279, key: tip });
    const all = await collect(ref.frames(await ref.startAt(0), 0, 1_279, ZERO_PEER));
    assert.deepEqual([all[255]!.malformed, all[256]!.malformed, all[257]!.malformed], [false, true, false], 'the board commit at 256 alone is malformed');

    const { src, sg } = sourceOf(fx, w.ref);
    await src.tip();
    let n = sg.calls.length;
    const start = await src.startAt(256, 1_279);
    // The window read with h0 (before h0 is known to be malformed), then genesis and 0…256 folded up.
    assert.deepEqual(batchItems(sg, n), [1_024, 1, 257]);
    assert.deepEqual(start, all[256]!.after);
    n = sg.calls.length;
    const window = await collect(src.frames(start, 257, 1_279, ZERO_PEER));
    assert.deepEqual(batchItems(sg, n), [1_023], 'no read kept after a malformed h0: the window is read again');
    assert.deepEqual(window.map(strip), all.slice(257).map(strip));
    assert.deepEqual(window.at(-1)!.after, all[1_279]!.after);
  } finally {
    await fx.cleanup();
  }
});
