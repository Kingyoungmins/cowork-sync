// The git room source over checkpoints this build cannot parse (Plan 8a Task 7, fix round 1; 12 §3.3.3; UI_VIZ_VERSION_SKEW,
// controller ruling of round 1): parseFold needs serializeFold(s) to equal the stored bytes, so a teammate's newer build
// writes checkpoints this one refuses at every checkpoint height. startAt then folds up from the newest state below that it
// can trust; the states it folds at checkpoint heights are kept per room (by height and board oid, bounded), so the next
// startAt — a later window, a "load earlier" page — folds up from the last good state once, never from genesis again.
// Real boards in clones on file:// remotes: a BoardWriter board to height 255, then board-only commits with an unparseable
// checkpoint/state.json written by one git fast-import. Kept apart from gitSource.test.ts for the 60 s file budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOid, type Oid } from '../../../src/git/oid.js';
import { ZERO_PEER, type Frame } from '../../../src/viz/model/frame.js';
import { FOLD_CACHE_MAX } from '../../../src/viz/source/git.js';
import type { TipInfo } from '../../../src/viz/source/roomSource.js';
import { BoardWriter } from '../../../tools/viz/boardWriter.js';
import { makeRepoFixture, type RepoFixture } from '../../helpers/repoFixture.js';
import { testRunner } from '../../helpers/tmp.js';
import { hashRaw, mktree } from '../../helpers/vizBatchRead.js';
import { collect, script, sourceOf, type SpiedVizGit } from '../../helpers/vizSource.js';

/** Every `cat-file --batch-check` call's board items (its stdin lines naming `<oid>^{tree}`), from call `from` on. */
const batchItems = (sg: SpiedVizGit, from: number): number[] =>
  sg.calls.slice(from).filter((c) => c.args[0] === 'cat-file' && c.args[1] === '--batch-check').map((c) => c.stdin.split('\n').filter((l) => l.endsWith('^{tree}')).length);
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

/**
 * `n` board-only commits on top of `from` into `ref`, by one git fast-import (a process per commit would cost the file
 * budget): each names the live commit `live`, holds an empty ops.jsonl, the protocol.json blob `protocol` and the tree
 * `checkpoint` at checkpoint/, and has the message "<tag> <i>" (so two tails from one commit differ). Returns the tip.
 */
async function skewTail(fx: RepoFixture, o: { ref: string; from: Oid; live: Oid; protocol: Oid; checkpoint: Oid; n: number; tag: string }): Promise<Oid> {
  const ops = await hashRaw(fx, 'blob', Buffer.alloc(0));
  const parts: string[] = [];
  for (let i = 0; i < o.n; i++) {
    const msg = `${o.tag} ${i}\n`;
    parts.push(`commit ${o.ref}\nmark :${i + 1}\ncommitter F <f@cowork.invalid> 1700000000 +0000\ndata ${Buffer.byteLength(msg, 'utf8')}\n${msg}`);
    parts.push(`from ${i === 0 ? o.from : `:${i}`}\nmerge ${o.live}\ndeleteall\n`);
    parts.push(`M 100644 ${ops} ops.jsonl\nM 100644 ${o.protocol} protocol.json\nM 040000 ${o.checkpoint} checkpoint\n\n`);
  }
  parts.push(`get-mark :${o.n}\ndone\n`);
  const r = await fx.repo.run(['fast-import', '--quiet', '--done'], { stdin: Buffer.from(parts.join(''), 'utf8') });
  return parseOid(r.stdout.toString('utf8').trim());
}

/** A BoardWriter board to height 255 (its checkpoint at 0 parses), then `n` skewed board-only commits at 256 and above. */
async function skewBoard(fx: RepoFixture, n: number): Promise<{ w: BoardWriter; base: Oid; live: Oid; protocol: Oid; checkpoint: Oid; tip: Oid }> {
  const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'main', seed: 'gitsrc-skew' });
  await w.genesis('ann');
  await w.join('bob');
  await w.commitMany(script(254));
  assert.equal(w.tip().height, 255);
  const base = w.tip().oid;
  const live = (await fx.repo.readCommit(base)).parents[1]!;
  const protocol = parseOid((await testRunner().run(['rev-parse', `${base}:protocol.json`], { class: 'local', cwd: fx.paths.workTree })).stdout.toString('utf8').trim());
  // A newer build's checkpoint: valid JSON this build's parseFold refuses (serializeFold of what it reads is not these bytes).
  const blob = await hashRaw(fx, 'blob', Buffer.from('{"v":2,"height":0,"from":"a newer build"}\n', 'utf8'));
  const checkpoint = await mktree(fx, [['100644', 'state.json', blob]]);
  const tip = await skewTail(fx, { ref: w.ref, from: base, live, protocol, checkpoint, n, tag: 'skew' });
  return { w, base, live, protocol, checkpoint, tip };
}

test('startAt over unparseable checkpoints (version skew): the second call folds up once from the last cached state, a repeat runs no git, and a cached state is kept only for its board oid', async () => {
  const fx = await makeRepoFixture('viz-gitsrc-skew');
  try {
    const b = await skewBoard(fx, 258);   // heights 256…513: the checkpoints at 256 and 512 do not parse
    // The reference: every frame from genesis, folded by a source of its own.
    const { src: ref } = sourceOf(fx, b.w.ref);
    assert.deepEqual(await ref.tip(), { height: 513, key: b.tip });
    const all = await collect(ref.frames(await ref.startAt(0), 0, 513, ZERO_PEER));
    assert.deepEqual([all[0]!.checkpoint, all[256]!.checkpoint, all[512]!.checkpoint], ['match', 'mismatch', 'mismatch'], 'genesis parses; 256 and 512 do not');

    const { src, sg } = sourceOf(fx, b.w.ref);
    let last: TipInfo = (await src.tip())!;
    // The first startAt(256): no checkpoint below it parses but genesis, so it folds 0…256 (the cost of skew, once).
    let n = sg.calls.length;
    assert.deepEqual(await src.startAt(256), all[256]!.after);
    assert.ok(Math.max(...batchItems(sg, n)) === 257, `startAt(256) folds from genesis: ${JSON.stringify(batchItems(sg, n))}`);

    // startAt(512): its own checkpoint and then 256's are read; 256's state is the cached one, so only 257…512 are folded.
    n = sg.calls.length;
    const s512 = await src.startAt(512);
    assert.deepEqual(s512, all[512]!.after);
    const items = batchItems(sg, n);
    assert.ok(Math.max(...items) <= 256 && sum(items) <= 258, `startAt(512) folds 257…512 only, never 0…256 again: ${JSON.stringify(items)}`);

    // A repeat (the store's rebuild, a "load earlier" page at a cached height): no git process at all, and a fresh object.
    n = sg.calls.length;
    const again = await src.startAt(512);
    const again256 = await src.startAt(256);
    assert.deepEqual(sg.calls.slice(n), [], 'cached states: no git process');
    assert.deepEqual([again, again256], [all[512]!.after, all[256]!.after]);
    assert.notEqual(again, s512, 'a cached state is handed out as a copy');
    // The frames that follow a cached start still fold on (their first frame's seed is read).
    const tail = await collect(src.frames(again, 513, 513, ZERO_PEER));
    const strip = (f: Frame): unknown => ({ ...f, before: null, after: null });
    assert.deepEqual(tail.map(strip), [strip(all[513]!)]);
    assert.deepEqual(tail[0]!.after, all[513]!.after);

    // A rewrite above 256 (a teammate rebuilt 301…513): 256's board oid is unchanged, 512's is new — 256 stays cached, 512
    // is folded again from it (a state cached for another oid is never served).
    const at300 = all[300]!.oid as Oid;
    const altTip = await skewTail(fx, { ref: 'refs/cowork-remote/alt/board', from: at300, live: b.live, protocol: b.protocol, checkpoint: b.checkpoint, n: 213, tag: 'alt' });
    await fx.repo.run(['update-ref', b.w.ref, altTip]);
    const rw = await src.advance(last);
    assert.deepEqual(rw, { kind: 'rewrite', to: { height: 513, key: altTip } });
    last = rw.kind === 'rewrite' ? rw.to : last;
    const { src: altRef } = sourceOf(fx, b.w.ref);
    await altRef.tip();
    const altAll = await collect(altRef.frames(await altRef.startAt(0), 0, 513, ZERO_PEER));
    assert.equal(altAll[256]!.oid, all[256]!.oid);
    assert.notEqual(altAll[512]!.oid, all[512]!.oid);
    n = sg.calls.length;
    assert.deepEqual(await src.startAt(512), altAll[512]!.after);
    const altItems = batchItems(sg, n);
    assert.ok(altItems.length > 0 && Math.max(...altItems) <= 256 && sum(altItems) <= 258, `the rewritten 512 is folded again from the cached 256: ${JSON.stringify(altItems)}`);
  } finally {
    await fx.cleanup();
  }
});

test('startAt over unparseable checkpoints: at most FOLD_CACHE_MAX folded states are kept per room, the least recently used dropped first', async () => {
  const fx = await makeRepoFixture('viz-gitsrc-skew-bound');
  try {
    const levels = FOLD_CACHE_MAX + 1;
    const top = levels * 256;
    const b = await skewBoard(fx, top - 255);   // heights 256…top: none of the `levels` checkpoints parses
    const { src, sg } = sourceOf(fx, b.w.ref);
    assert.deepEqual(await src.tip(), { height: top, key: b.tip });
    // One startAt at the top folds every level up from genesis and caches each of them; only the newest FOLD_CACHE_MAX stay.
    let n = sg.calls.length;
    const sTop = await src.startAt(top);
    assert.equal(sTop.height, top);
    assert.equal(Math.max(...batchItems(sg, n)), 257, 'the first fold starts at genesis');
    // The lowest kept level (top − (FOLD_CACHE_MAX − 1) · 256) is served with no git process …
    n = sg.calls.length;
    const kept = await src.startAt(top - (FOLD_CACHE_MAX - 1) * 256);
    assert.deepEqual(sg.calls.slice(n), [], 'the oldest kept level: cached');
    assert.equal(kept.height, top - (FOLD_CACHE_MAX - 1) * 256);
    // … and the level below it was dropped: it is folded from genesis again.
    n = sg.calls.length;
    const dropped = await src.startAt(256);
    assert.equal(dropped.height, 256);
    assert.equal(Math.max(...batchItems(sg, n)), 257, 'the dropped level is folded from genesis again');
    // Folding 256 again made it the most recent entry and dropped the least recently used one (top − 15 · 256 was used
    // just now, so the next oldest, top − 14 · 256, is the one gone); the top stays.
    n = sg.calls.length;
    await src.startAt(top);
    await src.startAt(256);
    await src.startAt(top - (FOLD_CACHE_MAX - 1) * 256);
    assert.deepEqual(sg.calls.slice(n), [], 'the recently used levels stay cached');
    n = sg.calls.length;
    await src.startAt(top - (FOLD_CACHE_MAX - 2) * 256);
    assert.ok(batchItems(sg, n).length > 0, 'the least recently used level was dropped');
  } finally {
    await fx.cleanup();
  }
});
