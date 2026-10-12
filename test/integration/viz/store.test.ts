// Plan 8a Task 8: the room store over real boards (12 §3.3.3, §3.9.1, §3.9.2, §3.10.5, §3.10.6, §6; VIZ-09, VIZ-13, VIZ-15;
// R-V19, R-V29, R-V46): live ticks (a timeline delta, a snapshot delta), the overlay kept out of every delta and page, version
// coupling, no board / a vanished ref / a missing object, self, "load earlier" and the page scene (the window start is in
// window.test.ts). Pages follow the glossary's segments: a window that starts at h0 > 0 holds the heights from h0 + 1.
// Boards in clones on file:// remotes written by tools/viz/boardWriter.ts; every git call through VizGit; a VirtualClock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOid, type Oid } from '../../../src/git/oid.js';
import { ZERO_PEER } from '../../../src/viz/model/frame.js';
import { emptyScene } from '../../../src/viz/model/scene.js';
import { prependTimeline, type Timeline } from '../../../src/viz/model/timeline.js';
import type { Layout, LayoutDelta } from '../../../src/viz/model/layout.js';
import type { TimelinePageModel } from '../../../src/viz/server/models.js';
import { BoardWriter } from '../../../tools/viz/boardWriter.js';
import { VirtualClock } from '../../sim/vclock.js';
import { makeRepoFixture, type RepoFixture } from '../../helpers/repoFixture.js';
import { hashRaw, mktree } from '../../helpers/vizBatchRead.js';
import { collect, kinds, script, sourceOf } from '../../helpers/vizSource.js';
import {
  cardsIn, deepFind, eventsIn, gitRoom, hideObject, pubs, reference, removeStatus, sceneAtEnd, ticksOf, unplaced, VIEWER_VERSION,
  writePeerFile, writeStatus, type GitRoom,
} from '../../helpers/vizStore.js';

const NO_TICK = { delta: null, overlay: null, change: null };

async function board(fx: RepoFixture, seed: string): Promise<BoardWriter> {
  const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'main', seed });
  await w.genesis('ann');
  await w.join('bob');
  return w;
}

/** The layout delta from `a` to `b` (what LayoutBuilder.takeDelta gives across the additions). */
function delta(a: Layout, b: Layout): LayoutDelta {
  return {
    fromVersion: a.version, version: b.version,
    zones: b.zones.filter((z, i) => i >= a.zones.length || z.cells.length !== a.zones[i]!.cells.length),
    desks: b.desks.slice(a.desks.length), homeOrder: b.homeOrder.slice(a.homeOrder.length),
  };
}

/** Every page of [from, h1] as the page asks for them: each request from where the last one ended. */
async function pagesFrom(r: GitRoom, from: number): Promise<TimelinePageModel[]> {
  const out: TimelinePageModel[] = [];
  const h1 = r.store.snapshot().window.h1;
  for (let f = from; f <= h1;) {
    const p = await r.store.page(f, h1);
    assert.ok(p !== null, `page ${f}`);
    out.push(p);
    f = p.to + 1;
  }
  return out;
}

// The window start (VIZ-09) is pinned in window.test.ts (moved there in fix round 1 for the 60 s file budget).

test('tick(): 3 new commits → one timeline delta with their events, cards and ticks; 65 → one snapshot delta with the scene at the tip and its last 200 cards', async () => {
  const fx = await makeRepoFixture('viz-store-tick');
  try {
    const w = await board(fx, 'store-tick');
    await w.commitMany(pubs(150));
    const t0 = w.tip().height;
    const clock = new VirtualClock({ startMono: 5_000 });
    const r = gitRoom(fx, w.ref, { clock });
    await r.store.init();
    const layout0 = r.store.snapshot().layout;

    // Three new commits, one on a path no desk has yet.
    await w.commitMany([{ writer: 'ann', cs: [{ paths: ['fresh/x.txt'] }] }, { writer: 'bob', cs: [{ paths: ['src/f1.txt'] }, { paths: ['src/g2.txt'] }] }, { writer: 'ann' }]);
    clock.advance(2_500);
    const at1 = clock.monoMs();
    const one = await r.store.tick();
    const ref1 = await reference(fx, w.ref, 0);
    assert.equal(one.change, null);
    assert.equal(one.overlay, null);
    const d = one.delta;
    assert.ok(d !== null && d.kind === 'timeline');
    assert.deepEqual([d.roomId, d.window, d.scene], [r.spec.id, { h0: 0, h1: t0 + 3 }, null]);
    assert.ok(d.events.length > 0);
    assert.deepEqual(d.events, eventsIn(ref1.timeline.events, t0 + 1, t0 + 3));
    assert.deepEqual(d.cards, cardsIn(ref1.timeline.cards, t0 + 1, t0 + 3).map((card) => ({ card, foldedAt: at1 })));
    assert.deepEqual(d.ticks, ticksOf(d.events));
    assert.deepEqual(d.layout, delta(layout0, ref1.timeline.layout), 'one layout delta');
    assert.deepEqual(d.layout!.desks.map((x) => x.key), ['fresh/x.txt']);
    assert.deepEqual([d.peers.size, d.pets.size], [0, 0], 'no peer or pet is new or changed');

    // 65 new commits: one snapshot delta (12 §3.9.2).
    await w.commitMany(pubs(65, 'more'));
    clock.advance(2_500);
    const at2 = clock.monoMs();
    const two = await r.store.tick();
    const ref2 = await reference(fx, w.ref, 0);
    const s = two.delta;
    assert.ok(s !== null && s.kind === 'snapshot');
    assert.deepEqual([s.window, s.events], [{ h0: 0, h1: t0 + 68 }, []]);
    assert.deepEqual(s.scene, ref2.carry.scene, 'the scene at the tip');
    const seen = (h: number): number | null => (h <= t0 ? null : h <= t0 + 3 ? at1 : at2);
    assert.deepEqual(s.cards, ref2.timeline.cards.slice(-200).map((card) => ({ card, foldedAt: seen(card.at.height) })), 'its last 200 cards');
    assert.equal(s.cards.length, 200);
    // B1 (8a final review): the snapshot carries the ticks of the newly folded heights only (the page appends them); the window's
    // own ticks stay whole in the room snapshot the world serves.
    assert.deepEqual(s.ticks, ticksOf(eventsIn(ref2.timeline.events, t0 + 4, t0 + 68)), 'the ticks of the newly folded heights only');
    assert.ok(s.ticks.length > 0 && s.ticks.every((k) => k.h > t0 + 3));
    assert.deepEqual(s.layout, delta(ref1.timeline.layout, ref2.timeline.layout));
    const m = r.store.snapshot();
    assert.deepEqual([m.window, m.scene, m.cards, m.layout], [s.window, s.scene, s.cards, ref2.timeline.layout]);
    assert.deepEqual(m.ticks, ticksOf(ref2.timeline.events), 'the world keeps the ticks of the whole window');
    clock.advance(2_500);
    assert.deepEqual(await r.store.tick(), NO_TICK, 'an idle tick');
  } finally {
    await fx.cleanup();
  }
});

test('T-VIZ-overlay (store): no RoomDelta or TimelinePageModel holds an overlay value', async () => {
  const fx = await makeRepoFixture('viz-store-overlay');
  try {
    const w = await board(fx, 'store-overlay');
    await w.commitMany(pubs(1_600));
    const C = {
      state: 'CANARY_Q7_STATE', reason: 'CANARY_Q7_REASON', pause: 'CANARY_Q7_PAUSE', branch: 'canary-q7-branch', peer: 'c0ffee17'.repeat(4),
      version: '9.9.9-canary-q7', hb: 987_650_000, fetch: 987_640_000, ready: 987_651, holds: 987_652, incoming: 987_653,
    };
    writeStatus(fx.paths.gitDir, {
      state: C.state, freeze_reasons: [C.reason], publish_pause: C.pause, branch: C.branch, peer_id: C.peer, plugin_version: C.version,
      heartbeat_mono_ms: C.hb, loop_period_ms: 2_500, last_fetch_age_ms: C.fetch,
      pending: { cs_ready: C.ready, cs_open: 0, holds_active: C.holds, holds_local_only: 0, incoming: C.incoming, not_converged: [] },
    });
    const clock = new VirtualClock();
    const r = gitRoom(fx, w.ref, { clock, deps: { machineMonoMs: () => C.hb + 1_000 } });
    await r.store.init();
    assert.equal(r.store.snapshot().window.h0, 512);
    const served: unknown[] = [];
    await w.commitMany(pubs(3, 'x'));
    clock.advance(2_500);
    served.push((await r.store.tick()).delta);
    await w.commitMany(pubs(65, 'y'));
    clock.advance(2_500);
    served.push((await r.store.tick()).delta);
    const h1 = r.store.snapshot().window.h1;
    served.push(await r.store.page(h1 - 100, h1), await r.store.page(600, 900), await r.store.page(512, 600));
    served.push(await r.store.earlier(), await r.store.page(0, 50));
    assert.ok(served.every((x) => x !== null), 'two deltas and five pages');
    const strings = [C.state, C.reason, C.pause, C.branch, C.peer, C.version];
    const numbers = [C.hb, C.fetch, C.ready, C.holds, C.incoming];
    assert.deepEqual(deepFind(served, strings, numbers), [], 'no overlay value in any delta or page');
    // Only RoomSnapshotModel.overlay carries them.
    const m = r.store.snapshot();
    assert.deepEqual(deepFind({ ...m, overlay: null }, strings, numbers), []);
    assert.deepEqual(m.overlay, {
      state: C.state, freezeReasons: [C.reason], publishPause: C.pause, down: false, unreadable: false, offlineMin: null,
      holds: C.holds, incoming: C.incoming, ready: C.ready, you: C.peer, versionSkew: true,
    });
  } finally {
    await fx.cleanup();
  }
});

/**
 * `n` board-only commits on top of the tip by one git fast-import, as a newer teammate build writes them: protocol.json with
 * proto 2 (the fold's protoMismatch) and a checkpoint/state.json this build's fold never produces (a PRO-28 mismatch at
 * heights divisible by 256); no Cowork-Writer, an empty ops.jsonl, the tip's live commit again (code unchanged).
 */
async function newerTail(fx: RepoFixture, w: BoardWriter, n: number): Promise<Oid> {
  const base = w.tip().oid;
  const live = (await fx.repo.readCommit(base)).parents[1]!;
  const ops = await hashRaw(fx, 'blob', Buffer.alloc(0));
  const protocol = await hashRaw(fx, 'blob', Buffer.from('{"G_s":5,"S_s":1.5,"budget":12,"proto":2,"regionSpec":"rs-1"}', 'utf8'));
  const state = await hashRaw(fx, 'blob', Buffer.from('{"v":2,"from":"a newer build"}\n', 'utf8'));
  const checkpoint = await mktree(fx, [['100644', 'state.json', state]]);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const msg = `newer ${i}\n`;
    parts.push(`commit ${w.ref}\nmark :${i + 1}\ncommitter F <f@cowork.invalid> 1700000000 +0000\ndata ${Buffer.byteLength(msg, 'utf8')}\n${msg}`);
    parts.push(`from ${i === 0 ? base : `:${i}`}\nmerge ${live}\ndeleteall\n`);
    parts.push(`M 100644 ${ops} ops.jsonl\nM 100644 ${protocol} protocol.json\nM 040000 ${checkpoint} checkpoint\n\n`);
  }
  parts.push(`get-mark :${n}\ndone\n`);
  const r = await fx.repo.run(['fast-import', '--quiet', '--done'], { stdin: Buffer.from(parts.join(''), 'utf8') });
  return parseOid(r.stdout.toString('utf8').trim());
}

test('T-VIZ-version (store): version skew, newer protocol and checkpoint mismatch never stop the fold; unknown counts add up over the window', async () => {
  const fx = await makeRepoFixture('viz-store-version');
  try {
    const w = await board(fx, 'store-version');
    await w.commitMany(script(1_400));
    assert.equal(w.tip().height, 1_401);
    writeStatus(fx.paths.gitDir, { plugin_version: 'skewed-9.9.9', heartbeat_mono_ms: 1_000_000 });
    const clock = new VirtualClock();
    const r = gitRoom(fx, w.ref, { clock, deps: { machineMonoMs: () => 1_001_000 } });
    await r.store.init();
    let m = r.store.snapshot();
    assert.notEqual('skewed-9.9.9', VIEWER_VERSION);
    assert.deepEqual([m.window, m.badges], [{ h0: 256, h1: 1_401 }, ['UI_VIZ_VERSION_SKEW']]);
    assert.ok(m.unknown > 0);
    assert.equal(m.unknown, (await reference(fx, w.ref, 256)).unknown, 'the unknown count of the window');

    // A newer build's tail across the checkpoint height 1,536: both badges, and the fold goes on to the tip.
    await newerTail(fx, w, 140);
    clock.advance(2_500);
    const t = await r.store.tick();
    assert.equal(t.change, 'state');
    assert.ok(t.delta !== null && t.delta.kind === 'snapshot');
    m = r.store.snapshot();
    assert.deepEqual([m.window, m.badges], [{ h0: 256, h1: 1_541 }, ['UI_VIZ_VERSION_SKEW', 'UI_VIZ_NEWER_PROTOCOL', 'UI_VIZ_CHECKPOINT_MISMATCH']]);
    const ref = await reference(fx, w.ref, 256);
    assert.deepEqual(m.scene, ref.carry.scene, 'folded to the tip');
    assert.equal(m.unknown, ref.unknown);
    // "Load earlier" adds its frames' unknown counts: the window's sum, over every frame once.
    assert.ok((await r.store.earlier()) !== null);
    m = r.store.snapshot();
    assert.equal(m.window.h0, 0);
    assert.equal(m.unknown, (await reference(fx, w.ref, 0)).unknown, 'the unknown count over 0…1,541');
    clock.advance(2_500);
    assert.deepEqual(await r.store.tick(), { delta: null, overlay: null, change: 'state' }, 'the earlier page\'s count is reported at the next tick');
    assert.deepEqual(r.store.snapshot().badges, ['UI_VIZ_VERSION_SKEW', 'UI_VIZ_NEWER_PROTOCOL', 'UI_VIZ_CHECKPOINT_MISMATCH']);
  } finally {
    await fx.cleanup();
  }
});

test('no board yet, a vanished ref and a missing board or live object show UI_VIZ_NO_BOARD and keep the last scene; the next tick retries and folds once the object exists', async () => {
  const fx = await makeRepoFixture('viz-store-noboard');
  try {
    const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'main', seed: 'store-noboard' });
    const clock = new VirtualClock();
    const r = gitRoom(fx, w.ref, { clock });
    const tick = async (): Promise<Awaited<ReturnType<typeof r.store.tick>>> => {
      clock.advance(2_500);
      return r.store.tick();
    };
    // No board yet: an empty room.
    await r.store.init();
    let m = r.store.snapshot();
    assert.deepEqual([m.badges, m.window, m.cards, m.ticks, m.unknown], [['UI_VIZ_NO_BOARD'], { h0: 0, h1: 0 }, [], [], 0]);
    assert.deepEqual(m.scene, emptyScene({ height: 0, sub: 0, k: 0 }));
    assert.equal(await r.store.page(0, 10), null);
    assert.equal(await r.store.earlier(), null);
    assert.deepEqual(await tick(), NO_TICK, 'still none');

    // The board appears: the next tick folds it as a new window (the page reloads the world).
    await w.genesis('ann');
    await w.join('bob');
    await w.commitMany(pubs(10));
    assert.deepEqual(await tick(), { delta: null, overlay: null, change: 'rebuilt' });
    m = r.store.snapshot();
    assert.deepEqual([m.badges, m.window], [[], { h0: 0, h1: 11 }]);
    assert.deepEqual(m.scene, (await reference(fx, w.ref, 0)).carry.scene);
    const scene = m.scene;

    // The ref vanishes: the last scene stays; it comes back: the badge clears.
    const tip = w.tip().oid;
    await fx.repo.run(['update-ref', '-d', w.ref]);
    assert.deepEqual(await tick(), { delta: null, overlay: null, change: 'state' });
    m = r.store.snapshot();
    assert.deepEqual([m.badges, m.window, m.scene], [['UI_VIZ_NO_BOARD'], { h0: 0, h1: 11 }, scene]);
    await fx.repo.run(['update-ref', w.ref, tip]);
    assert.deepEqual(await tick(), { delta: null, overlay: null, change: 'state' });
    assert.deepEqual(r.store.snapshot().badges, []);

    // A live commit the clone lacks (a partial clone; transports are disabled): nothing of the batch is folded.
    await w.commit({ writer: 'ann', cs: [{ paths: ['src/new1.txt'] }] });
    await w.commit({ writer: 'bob', cs: [{ paths: ['src/new2.txt'] }] });
    const live = (await fx.repo.readCommit(w.tip().oid)).parents.at(-1)!;
    let restore = hideObject(fx.paths.gitDir, live);
    let folds = r.spy.folds;
    assert.deepEqual(await tick(), { delta: null, overlay: null, change: 'state' });
    m = r.store.snapshot();
    assert.deepEqual([m.badges, m.window, m.scene, r.spy.folds], [['UI_VIZ_NO_BOARD'], { h0: 0, h1: 11 }, scene, folds]);
    // Restored: the next tick retries on its own (no ref change, so no rev-parse) and folds.
    restore();
    let calls = r.git.calls.length;
    let back = await tick();
    assert.deepEqual([back.change, back.delta?.kind, back.delta?.window], ['state', 'timeline', { h0: 0, h1: 13 }]);
    assert.deepEqual(kinds(r.git.calls.slice(calls)), ['cat-file --batch-check', 'cat-file --batch'], 'the pinned target again, no rev-parse');
    assert.deepEqual(r.store.snapshot().badges, []);

    // A board object the clone lacks (an ops.jsonl of its own).
    await w.commit({ writer: 'ann', ops: [{ type: 'event', cid: '', kind: 'freeze', refs: [], reason_code: 'EPOCH' }] });
    const ops = parseOid((await fx.repo.run(['rev-parse', `${w.tip().oid}:ops.jsonl`])).stdout.toString('utf8').trim());
    restore = hideObject(fx.paths.gitDir, ops);
    folds = r.spy.folds;
    const kept = r.store.snapshot().scene;
    assert.deepEqual(await tick(), { delta: null, overlay: null, change: 'state' });
    m = r.store.snapshot();
    assert.deepEqual([m.badges, m.window.h1, m.scene, r.spy.folds], [['UI_VIZ_NO_BOARD'], 13, kept, folds]);
    assert.deepEqual(await tick(), NO_TICK, 'still missing: the badge stays, nothing new to report');
    restore();
    calls = r.git.calls.length;
    back = await tick();
    assert.deepEqual([back.change, back.delta?.window], ['state', { h0: 0, h1: 14 }]);
    assert.ok(!kinds(r.git.calls.slice(calls)).includes('rev-parse --verify'));
    assert.deepEqual(r.store.snapshot().badges, []);
    assert.deepEqual(r.store.snapshot().scene, (await reference(fx, w.ref, 0)).carry.scene);
  } finally {
    await fx.cleanup();
  }
});

test('self comes from the peer file, else status.json\'s peer_id, else zeros', async () => {
  const fx = await makeRepoFixture('viz-store-self');
  try {
    const w = await board(fx, 'store-self');
    await w.commitMany(script(80));
    const ann = w.peer('ann').peer, bob = w.peer('bob').peer;
    const clock = new VirtualClock();
    const deps = { machineMonoMs: () => 1_001_000 };
    writeStatus(fx.paths.gitDir, { peer_id: bob, heartbeat_mono_ms: 1_000_000 });
    writePeerFile(fx.paths.gitDir, ann);
    const a = gitRoom(fx, w.ref, { clock, n: 1, deps });
    await a.store.init();
    writePeerFile(fx.paths.gitDir, null);
    const b = gitRoom(fx, w.ref, { clock, n: 2, deps });
    await b.store.init();
    removeStatus(fx.paths.gitDir);
    const c = gitRoom(fx, w.ref, { clock, n: 3, deps });
    await c.store.init();
    const rooms = [a, b, c];
    assert.deepEqual(rooms.map((x) => x.spy.frames.map((f) => f.self)), [[ann], [bob], [ZERO_PEER]]);
    assert.deepEqual(rooms.map((x) => x.store.snapshot().overlay?.you ?? null), [ann, bob, null], 'the overlay\'s "you" by the same rule');

    // A live tick folds with the same self; the timeline does not depend on it.
    await w.commitMany(script(6));
    clock.advance(2_500);
    const deltas = [];
    for (const x of rooms) deltas.push((await x.store.tick()).delta);
    assert.deepEqual(rooms.map((x) => x.spy.frames.map((f) => f.self)), [[ann, ann], [bob, bob], [ZERO_PEER, ZERO_PEER]]);
    const same = (o: unknown): unknown => JSON.parse(JSON.stringify(o, (k, v: unknown) => (k === 'roomId' ? undefined : v instanceof Map ? [...v] : v)));
    assert.ok(deltas[0] !== null);
    assert.deepEqual(same(deltas[1]), same(deltas[0]));
    assert.deepEqual(same(deltas[2]), same(deltas[0]));
    const view = async (x: GitRoom): Promise<unknown> => {
      const s = x.store.snapshot();
      return same({ window: s.window, scene: s.scene, cards: s.cards, ticks: s.ticks, layout: s.layout, unknown: s.unknown, peers: s.peers, pets: s.pets, page: await x.store.page(1, 80) });
    };
    assert.deepEqual(await view(b), await view(a));
    assert.deepEqual(await view(c), await view(a));
  } finally {
    await fx.cleanup();
  }
});

test('earlier(): h0 moves down 256, one segment is prepended, the new desks come as one layout delta, scenes above the old h0 are unchanged', async () => {
  const fx = await makeRepoFixture('viz-store-earlier');
  try {
    const w = await board(fx, 'store-earlier');
    await w.commitMany(pubs(500, 'early'));
    await w.commitMany(pubs(1_100, 'late'));
    assert.equal(w.tip().height, 1_601);
    const clock = new VirtualClock();
    const r = gitRoom(fx, w.ref, { clock });
    await r.store.init();
    const before = r.store.snapshot();
    assert.deepEqual(before.window, { h0: 512, h1: 1_601 });
    assert.ok(before.layout.desks.every((d) => d.kind === 'big_table' || d.key.startsWith('late/')));
    const above = await pagesFrom(r, 513);

    const e = await r.store.earlier();
    assert.ok(e !== null);
    // The reference: the segment (256, 512] folded on the layout the window had, from the checkpoint at 256. Its page is the
    // segment's own heights 257 … 512 (glossary "segment": hs + 1 up to the next segment's hs), the old h0 512 included.
    const seg = await reference(fx, w.ref, 256, before.layout, 512);
    assert.deepEqual([e.roomId, e.from, e.to], [r.spec.id, 257, 512]);
    assert.deepEqual(e.scene, seg.timeline.segments[0]!.start, 'the new segment\'s start scene');
    assert.deepEqual(e.events, eventsIn(seg.timeline.events, 257, 512));
    assert.ok(e.events.some((x) => x.height === 512), 'the old h0\'s events come with the earlier page');
    assert.deepEqual(e.cards, cardsIn(seg.timeline.cards, 257, 512).map((card) => ({ card, foldedAt: null })));
    assert.deepEqual(e.layout, delta(before.layout, seg.timeline.layout), 'the new desks as one layout delta');
    assert.ok(e.layout!.desks.length > 0 && e.layout!.desks.every((d) => d.key.startsWith('early/') && d.first > 256 && d.first <= 512));
    const after = r.store.snapshot();
    assert.deepEqual(after.window, { h0: 256, h1: 1_601 });
    assert.deepEqual(after.layout, seg.timeline.layout);
    assert.deepEqual(after.layout.desks.slice(0, before.layout.desks.length), before.layout.desks, 'no desk moved');
    assert.deepEqual(after.ticks, [...ticksOf(seg.timeline.events), ...before.ticks], 'the ticks of the whole window');
    assert.deepEqual([after.scene, after.cards], [before.scene, before.cards]);
    // Scenes above the old h0 are unchanged: every page above it is served as before.
    assert.deepEqual(await pagesFrom(r, 513), above);
    // The old h0 is a height of the earlier segment now (12 §3.3.5).
    const at512 = await r.store.page(512, 600);
    assert.ok(at512 !== null);
    assert.deepEqual([at512.from, at512.to], [512, 512]);
    assert.deepEqual(at512.events, eventsIn(seg.timeline.events, 512, 512));
    assert.deepEqual(unplaced(at512.scene), unplaced(sceneAtEnd(seg.timeline, 511)));
  } finally {
    await fx.cleanup();
  }
});

test('page() below h0 extends exactly one segment per call', async () => {
  const fx = await makeRepoFixture('viz-store-below');
  try {
    const w = await board(fx, 'store-below');
    await w.commitMany(script(1_850));
    const clock = new VirtualClock();
    const r = gitRoom(fx, w.ref, { clock });
    await r.store.init();
    assert.deepEqual(r.store.snapshot().window, { h0: 768, h1: 1_851 });
    let full: Timeline = (await reference(fx, w.ref, 768)).timeline;
    const { src } = sourceOf(fx, w.ref);
    await src.tip();
    // A page whose `from` lies below the window's first height (h0 + 1; height h0 itself belongs to the segment below, glossary
    // "segment") extends the window by one segment and answers that segment's page: from 0 (a `to` below the new segment reads
    // as the segment's first page, [h0' + 1, hs], or [0, …] for the genesis segment), and from the old h0 itself ([hs, hs], the
    // scene at the end of hs − 1).
    for (const [from, h0, folds, page] of [[0, 512, 256, [513, 768]], [512, 256, 256, [512, 512]], [0, 0, 257, [0, 100]]] as const) {
      const f0 = r.spy.folds;
      const p = await r.store.page(from, from + 100);
      assert.ok(p !== null);
      assert.equal(r.store.snapshot().window.h0, h0, 'one segment per call');
      assert.equal(r.spy.folds - f0, folds, 'that segment\'s frames, once');
      assert.deepEqual([p.from, p.to], page, `from ${from}: that segment's page`);
      const start = await src.startAt(h0);
      full = prependTimeline(full, { h0, start, frames: await collect(src.frames(start, h0 === 0 ? 0 : h0 + 1, full.segments[0]!.hs, ZERO_PEER)) });
      assert.deepEqual(p.events, eventsIn(full.events, p.from, p.to));
      if (from === 0) assert.deepEqual(p.scene, full.segments[0]!.start, 'the new segment\'s start scene');
      else assert.deepEqual(unplaced(p.scene), unplaced(sceneAtEnd(full, from - 1)), 'the scene at the end of the height below the old h0');
      assert.deepEqual(r.store.snapshot().layout, full.layout);
    }
    // At h0 = 0 nothing is below: the page is served as asked, with nothing folded (the whole window is retained).
    const f0 = r.spy.folds;
    const p = await r.store.page(0, 100);
    assert.ok(p !== null);
    assert.deepEqual([p.from, p.to, r.store.snapshot().window.h0, r.spy.folds - f0], [0, 100, 0, 0]);
    assert.deepEqual(p.events, eventsIn(full.events, 0, 100));
  } finally {
    await fx.cleanup();
  }
});

test('T-VIZ-start (page scene): TimelinePage.scene at a segment start is that segment\'s start scene, and elsewhere the scene at the last position of from − 1', async () => {
  const fx = await makeRepoFixture('viz-store-start');
  try {
    const w = await board(fx, 'store-start');
    await w.commitMany(script(1_300));
    const clock = new VirtualClock();
    const r = gitRoom(fx, w.ref, { clock });
    await r.store.init();
    assert.deepEqual(r.store.snapshot().window, { h0: 256, h1: 1_301 });
    // Before "load earlier": the window's first height is 257, its segment's first (12 §3.3.3; height 256 belongs to the segment
    // below, and a page from it would extend the window, R-V29).
    const head = await reference(fx, w.ref, 256);
    const p257 = await r.store.page(257, 267);
    assert.ok(p257 !== null);
    assert.deepEqual(p257.scene, head.timeline.segments[0]!.start, 'from 257: the segment\'s start scene');
    const e = await r.store.earlier();
    assert.ok(e !== null);
    // The store's timeline, built independently: the window at 256 with the segment (0, 256] prepended.
    const { src } = sourceOf(fx, w.ref);
    await src.tip();
    const g = await src.startAt(0);
    const t = prependTimeline(head.timeline, { h0: 0, start: g, frames: await collect(src.frames(g, 0, 256, ZERO_PEER)) });
    assert.deepEqual(t.segments.map((s) => s.hs), [0, 256]);
    // "Load earlier" of the genesis segment (heights 0 … 256, 257 of them): its first page of 256, from its start scene.
    assert.deepEqual([e.from, e.to, e.scene], [0, 255, t.segments[0]!.start]);
    assert.deepEqual(e.events, eventsIn(t.events, 0, 255));
    // Segment starts: from = 0 (the genesis segment, its frames from height 0) and from − 1 = 256 (the window's segment).
    for (const [from, i] of [[0, 0], [257, 1]] as const) {
      const p = await r.store.page(from, from + 10);
      assert.ok(p !== null);
      assert.deepEqual(p.scene, t.segments[i]!.start, `from ${from}: segment ${t.segments[i]!.hs}'s start scene`);
    }
    assert.notDeepEqual(unplaced(t.segments[1]!.start), unplaced(sceneAtEnd(t, 256)), 'a segment start is not the scene the segment below ends with');
    // Elsewhere: the scene at the last position of from − 1 (its last event, or (from − 1, 0, 0) when it has none).
    for (const from of [1, 2, 255, 256, 300, 512, 513, 1_000, 1_301]) {
      const p = await r.store.page(from, from + 10);
      assert.ok(p !== null);
      const want = sceneAtEnd(t, from - 1);
      assert.deepEqual(unplaced(p.scene), unplaced(want), `from ${from}`);
      const last = t.events.filter((e) => e.height === from - 1).at(-1);
      assert.deepEqual(p.scene.at, last === undefined ? { height: from - 1, sub: 0, k: 0 } : { height: last.height, sub: last.sub, k: last.k });
      assert.deepEqual(p.events, eventsIn(t.events, from, p.to));
    }
  } finally {
    await fx.cleanup();
  }
});
