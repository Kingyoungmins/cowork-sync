// Plan 8a Task 8: seen anchors (12 §3.8 "seen {n} min ago", VIZ-11; R-V28): a height first folded by tick()'s fast-forward
// carries the store's Δmono at that fold, in one height → anchor map for the whole window that retention never trims; the
// initial window, "load earlier", re-folds of dropped ranges (which serve the stored anchor again) and an incident rebuild
// (which drops the map: its heights named another chain) create none. Real boards in a clone on a file:// remote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CardModel } from '../../../src/viz/server/models.js';
import { BoardWriter } from '../../../tools/viz/boardWriter.js';
import { VirtualClock } from '../../sim/vclock.js';
import { makeRepoFixture } from '../../helpers/repoFixture.js';
import { gitRoom, pubs, writeStatus, type GitRoom } from '../../helpers/vizStore.js';

/** Every card of [from, to], page by page as the page asks for them, and the folds that took. */
async function cardsOf(r: GitRoom, from: number, to: number): Promise<{ cards: CardModel[]; folds: number }> {
  const f0 = r.spy.folds;
  const cards: CardModel[] = [];
  for (let f = from; f <= to;) {
    const p = await r.store.page(f, to);
    assert.ok(p !== null, `page ${f}`);
    cards.push(...p.cards);
    f = p.to + 1;
  }
  return { cards, folds: r.spy.folds - f0 };
}

test('T-VIZ-log (anchors): heights first folded by tick()\'s fast-forward carry their Δmono fold time; the initial window, earlier(), page() re-folds and a rebuild create none', async () => {
  const fx = await makeRepoFixture('viz-anchors');
  try {
    const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'main', seed: 'anchors' });
    await w.genesis('ann');
    await w.join('bob');
    await w.commitMany(pubs(1_299));
    const machine = { now: 5_000_000 };
    writeStatus(fx.paths.gitDir, { state: 'ok', heartbeat_mono_ms: machine.now });
    const clock = new VirtualClock({ startMono: 10_000 });
    const r = gitRoom(fx, w.ref, { clock, deps: { machineMonoMs: () => machine.now } });
    await r.store.init();
    assert.deepEqual(r.store.snapshot().window, { h0: 256, h1: 1_300 });
    // The initial window: no anchor.
    assert.ok(r.store.snapshot().cards.every((c) => c.foldedAt === null));
    assert.ok((await cardsOf(r, 257, 1_300)).cards.every((c) => c.foldedAt === null));

    // Live: 3 commits at T1, then 65 (a snapshot delta) at T2.
    const tick = async (n: number, dir: string): Promise<number> => {
      await w.commitMany(pubs(n, dir));
      clock.advance(2_500);
      const at = clock.monoMs();
      assert.ok((await r.store.tick()).delta !== null);
      return at;
    };
    const t1 = await tick(3, 'a');
    const t2 = await tick(65, 'b');
    const seen = (h: number): number | null => (h <= 1_300 ? null : h <= 1_303 ? t1 : h <= 1_368 ? t2 : null);
    const first = await cardsOf(r, 1_281, 1_368);
    assert.equal(first.folds, 0);
    assert.deepEqual(first.cards.map((c) => c.foldedAt), first.cards.map((c) => seen(c.card.at.height)), 'their Δmono fold time');
    assert.ok(first.cards.some((c) => c.foldedAt === t1) && first.cards.some((c) => c.foldedAt === t2));
    assert.deepEqual(r.store.snapshot().cards.map((c) => c.foldedAt), r.store.snapshot().cards.map((c) => seen(c.card.at.height)));

    // Three more ticks of 900 at T3…T5: the heights up to 2,048 are dropped from memory, but not their anchors.
    const t3 = await tick(900, 'c'), t4 = await tick(900, 'd'), t5 = await tick(900, 'e');
    assert.equal(r.store.snapshot().window.h1, 4_068);
    const again = await cardsOf(r, 1_281, 1_368);
    assert.ok(again.folds > 0, 're-folded');
    assert.deepEqual(again.cards, first.cards, 'a re-folded card\'s foldedAt equals the one first served');
    const live = await cardsOf(r, 1_369, 4_068);
    const at = (h: number): number => (h <= 2_268 ? t3 : h <= 3_168 ? t4 : t5);
    assert.deepEqual(live.cards.map((c) => c.foldedAt), live.cards.map((c) => at(c.card.at.height)), 'retention never drops an anchor inside the window');

    // "Load earlier": no anchor.
    const e = await r.store.earlier();
    assert.ok(e !== null && e.cards.length > 0);
    assert.ok(e.cards.every((c) => c.foldedAt === null));
    assert.ok((await cardsOf(r, 0, 256)).cards.every((c) => c.foldedAt === null));

    // An incident rebuild drops the map: the rebuilt window's cards carry none, the same heights included.
    machine.now += 2_500;
    writeStatus(fx.paths.gitDir, { state: 'incident', heartbeat_mono_ms: machine.now });
    clock.advance(2_500);
    assert.equal((await r.store.tick()).change, 'state');
    machine.now += 2_500;
    writeStatus(fx.paths.gitDir, { state: 'ok', heartbeat_mono_ms: machine.now });
    clock.advance(2_500);
    assert.equal((await r.store.tick()).change, 'rebuilt');
    const m = r.store.snapshot();
    assert.deepEqual(m.window, { h0: 2_816, h1: 4_068 });
    assert.ok(m.cards.every((c) => c.foldedAt === null));
    assert.ok((await cardsOf(r, 2_816, 4_068)).cards.every((c) => c.foldedAt === null));
  } finally {
    await fx.cleanup();
  }
});
