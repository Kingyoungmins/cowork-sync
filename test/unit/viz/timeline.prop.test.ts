// Plan 8a Task 6: the timeline's determinism and append-only laws (12 §3.3.5; VIZ-10, VIZ-16, INV-VIZ-DET; R-V20, R-V21, R-V51):
// seeds, T-VIZ-append-only, T-VIZ-self, prependTimeline and TimelineBuilder.replay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { initialFoldState } from '../../../src/board/fold.js';
import { comparePos, reduceScene } from '../../../src/viz/model/scene.js';
import type { Frame } from '../../../src/viz/model/frame.js';
import { LayoutBuilder, LayoutFrozenError } from '../../../src/viz/model/layout.js';
import {
  buildTimeline, eventSeed, extendTimeline, prependTimeline, serializeTimeline, TimelineBuilder, type FrameOutput, type Timeline,
} from '../../../src/viz/model/timeline.js';
import { join } from 'node:path';
import {
  FIXTURE_PROTOCOL, fixtureFrames, loadRowFixture, peerOf, ROW_FIXTURE_DIR, rowFixtureNames, type FixtureFrame, type RowFixture,
} from '../../helpers/vizRows.js';

const G: FixtureFrame = { writer: 'A', ops: [{ type: 'join', display: 'Ann' }, { type: 'caps' }] };
const START = initialFoldState(FIXTURE_PROTOCOL);
const fixture = (frames: FixtureFrame[]): RowFixture => ({ row: 'gen', plan: 2, about: '', frames });

/** One frame of the ops of every row the Plan 2 fold applies (and the code rows), by a peer of A–D. */
const PEERS = ['A', 'B', 'C', 'D'];
const FILES = ['src/a.ts', 'src/b.ts', 'src/x/c.ts', 'test/d.ts', 'docs/e.md', 'f.ts', 'lib/g/h.ts', 'lib/g/i.ts'];
const frameArb: fc.Arbitrary<FixtureFrame> = fc.tuple(fc.constantFrom(...PEERS), fc.constantFrom(1, 1, 1, 2), fc.nat({ max: 21 }), fc.subarray(FILES, { minLength: 1, maxLength: 4 }))
  .map(([p, epoch, kind, files]): FixtureFrame => {
    const w = epoch === 1 ? p : `${p}@2`;
    const ev = (k: string, rc: string): FixtureFrame => ({ writer: w, ops: [{ type: 'event', kind: k, reason_code: rc }] });
    switch (kind) {
      case 0: case 1: return { writer: w, ops: [{ type: 'join', regionSpec: files.length > 2 ? 'rs-2' : 'rs-1', coauthor_optin: files.length === 1 ? 'x' : false, plugin_version: files.length > 3 ? '0.0.1' : '0.0.0' }] };
      case 2: return { writer: w, ops: [{ type: 'leave' }] };
      case 3: return { writer: w, ops: [{ type: 'seat_start', seat: files.length % 2 === 0 ? 'S1' : 'S2' }] };
      case 4: return { writer: w, ops: [{ type: 'seat_end', seat: files.length % 2 === 0 ? 'S1' : 'S2' }] };
      case 5: return ev('freeze', 'EPOCH');
      case 6: return ev('unfreeze', 'EPOCH');
      case 7: return ev('health', 'HOST_THROTTLED');
      case 8: return ev('health', 'BRANCH_ESCAPE');
      case 9: return ev('nonretryable', 'NONRETRYABLE');
      case 10: return ev('breach', 'BREACH');
      case 11: return ev('K4', 'CONFLICT_K4');
      case 12: return ev('incident', 'INCIDENT');
      case 13: return { writer: w, ops: [{ type: 'save' }], code: { shape: 'base_move', base: 'd'.repeat(40) } };
      case 14: return { writer: w, code: { shape: 'base_move', base: 'e'.repeat(40) } };
      case 15: return { writer: w, cs: [{ human: p, n: 1 + files.length, files }] };
      case 16: return { writer: w, cs: [{ human: p, n: 1, files: files.slice(0, 1) }, { seat: 'S1', turn: 1, files }], code: { shape: 'ordinary', seats: ['human', 'S2'] } };
      case 17: return { writer: w, cs: [{ human: p, n: 1, count: 300 }] };
      case 18: return { writer: w, code: { shape: 'ordinary' } };
      case 19: return { writer: w, cs: [{ human: p, n: 1, files }], code: { changed: false } };
      case 20: return { malformed: true };
      default: return { writer: w };
    }
  });

test('seeds follow eventSeed and contain no oid', () => {
  // eventSeed: the first four sha256 bytes of utf8(base ‖ ':' ‖ k), big-endian (R-V20).
  for (const [base, k] of [['x', 0], ['7:-:1001', 3], [`${peerOf('A')}/${'e1'.repeat(16)}/4`, 2]] as const) {
    assert.equal(eventSeed(base, k), createHash('sha256').update(`${base}:${k}`, 'utf8').digest().readUInt32BE(0));
  }
  for (const n of rowFixtureNames(process.cwd())) {
    const fx = loadRowFixture(join(process.cwd(), ROW_FIXTURE_DIR, n));
    if (fx.row === 'board_full') continue;                         // long; its events are room-level (base by height) only
    const frames = fixtureFrames(fx);
    const t = buildTimeline({ h0: 0, start: START, frames });
    for (const e of t.events) {
      const f = frames[e.height]!;
      const base = e.sub >= 1 && e.sub <= 1000 ? (f.ops[e.sub - 1]!.op as { id: string }).id : `${e.height}:${f.writer?.peer ?? '-'}:${e.sub}`;
      assert.equal(e.seed, eventSeed(base, e.k), `${n} ${e.height}.${e.sub}.${e.k}`);
    }
    // Two frame sequences that differ only in oid serialize byte-identically, and no oid reaches the serialization.
    const other = frames.map((f, i) => ({ ...f, oid: createHash('sha1').update(`other ${i}`).digest('hex') }));
    const a = serializeTimeline(t);
    assert.equal(serializeTimeline(buildTimeline({ h0: 0, start: START, frames: other })), a, n);
    for (const f of [...frames, ...other]) assert.ok(!a.includes(f.oid), `${n}: oid ${f.oid}`);
  }
});

test('T-VIZ-append-only: 2,000 generated frames split at 50 random points: the extendTimeline chain serializes byte-equal to one buildTimeline, segments and their start scenes included', () => {
  fc.assert(fc.property(fc.array(frameArb, { minLength: 1999, maxLength: 1999 }), fc.uniqueArray(fc.integer({ min: 1, max: 1999 }), { minLength: 50, maxLength: 50 }), (specs, cuts) => {
    const frames = fixtureFrames(fixture([G, ...specs]));
    assert.equal(frames.length, 2000);
    const whole = buildTimeline({ h0: 0, start: START, frames });
    const points = [...cuts].sort((a, b) => a - b);
    let t = buildTimeline({ h0: 0, start: START, frames: frames.slice(0, points[0]) });
    for (let i = 0; i < points.length; i++) t = extendTimeline(t, frames.slice(points[i], points[i + 1] ?? frames.length));
    assert.equal(serializeTimeline(t), serializeTimeline(whole));
    assert.deepEqual(t, whole);
    // The carry is recomputed from the timeline alone: a copy (no builder state behind it) extends to the same timeline.
    const mid = points[25]!;
    const fresh = { ...buildTimeline({ h0: 0, start: START, frames: frames.slice(0, mid) }) };
    assert.equal(serializeTimeline(extendTimeline(fresh, frames.slice(mid))), serializeTimeline(whole));
    // The generated frames reach the rows the Plan 2 fold applies (measured: ≈ 800 events per 2,000 frames; every kind below
    // appears ≥ 7 times on average, so none is missing by chance), and the chain's layout is the whole build's.
    const kinds = new Set(whole.events.map((e) => e.kind));
    for (const k of ['room_open', 'person_enter', 'person_exit', 'pet_spawn', 'pet_poof', 'person_badge', 'person_freeze', 'person_thaw', 'person_bang',
      'conflict', 'publish', 'room_sign', 'save', 'pose_relaxed'] as const) assert.ok(kinds.has(k), k);
    assert.deepEqual(t.layout, whole.layout);
  }), { numRuns: 2, endOnFailure: true });                         // no shrinking: one run folds and builds 2,000 frames
});

test('T-VIZ-self: the timeline is identical for self = each peer and = zeros', () => {
  const frames = (self: string): Frame[] => fixtureFrames(fixture([G, { writer: 'B', ops: [{ type: 'join' }] }, { writer: 'B', ops: [{ line: '{"id":"x","type":"leave"}' }, { type: 'leave' }] },
    { writer: 'A', cs: [{ human: 'A', n: 1, files: ['src/a.ts'] }] }, { writer: 'C', ops: [{ type: 'join' }] }, { writer: 'C', ops: [{ type: 'event', kind: 'freeze', reason_code: 'EPOCH' }] },
    { writer: 'A', ops: [{ line: `{"id":"${peerOf('A')}/${'e1'.repeat(16)}/1","type":"leave"}` }] }]), self);
  const want = serializeTimeline(buildTimeline({ h0: 0, start: START, frames: frames('0'.repeat(32)) }));
  for (const p of ['A', 'B', 'C', 'D']) assert.equal(serializeTimeline(buildTimeline({ h0: 0, start: START, frames: frames(peerOf(p)) })), want, p);
  for (const n of rowFixtureNames(process.cwd())) {
    const fx = loadRowFixture(join(process.cwd(), ROW_FIXTURE_DIR, n));
    if (fx.row === 'board_full') continue;
    const zero = serializeTimeline(buildTimeline({ h0: 0, start: START, frames: fixtureFrames(fx) }));
    for (const p of ['A', 'B', 'D']) assert.equal(serializeTimeline(buildTimeline({ h0: 0, start: START, frames: fixtureFrames(fx, peerOf(p)) })), zero, `${n} self ${p}`);
  }
});

/** A 700-height board: B and C join; publishes touch paths only below 512 (old/*), across (both/*) and only above (new/*). */
function longBoard(): Frame[] {
  const specs: FixtureFrame[] = [G, { writer: 'B', ops: [{ type: 'join' }] }, { writer: 'C', ops: [{ type: 'join', regionSpec: 'rs-2' }] }];
  for (let h = 3; h <= 700; h++) {
    const p = PEERS[h % 3]!;
    if (h % 7 === 0) specs.push({ writer: p, cs: [{ human: p, n: h, files: h < 512 ? [`old/f${h % 40}.ts`, `both/g${h % 5}.ts`] : [`new/f${h % 30}.ts`, `both/g${h % 5}.ts`] }] });
    else if (h % 97 === 0) specs.push({ writer: p, ops: [{ type: 'event', kind: 'freeze', reason_code: 'EPOCH' }] });
    else if (h % 101 === 0) specs.push({ writer: p, ops: [{ type: 'seat_start', seat: 'S1' }] });
    else specs.push({ writer: p });
  }
  return fixtureFrames(fixture(specs));
}

test('prependTimeline prepends one segment, appends the earlier page\'s new desks after every existing desk, changes no ordinal, and leaves the scene at 100 random positions above the old h0 unchanged', () => {
  const frames = longBoard();
  const t = buildTimeline({ h0: 512, start: frames[512]!.after, frames: frames.slice(513) });
  assert.deepEqual(t.segments.map((s) => s.hs), [512]);
  const p = prependTimeline(t, { h0: 256, start: frames[256]!.after, frames: frames.slice(257, 513) });
  assert.deepEqual([p.h0, p.h1, p.segments.map((s) => s.hs)], [256, 700, [256, 512]]);
  assert.equal(p.segments[1], t.segments[1 - 1]);
  // The earlier page's events first, then the window's, unchanged.
  const early = p.events.slice(0, p.events.length - t.events.length);
  assert.deepEqual(p.events.slice(early.length), t.events);
  assert.ok(early.length > 0 && early.every((e) => e.height > 256 && e.height <= 512));
  assert.deepEqual(p.cards.slice(p.cards.length - t.cards.length), t.cards);
  // Desks: every existing desk keeps its ordinal and key; the earlier page's new desks (old/*) come after them, first-touched below 512.
  assert.deepEqual(p.layout.desks.slice(0, t.layout.desks.length), t.layout.desks);
  const added = p.layout.desks.slice(t.layout.desks.length);
  assert.ok(added.length > 0 && added.every((d) => d.key.startsWith('old/') && d.first > 256 && d.first <= 512));
  for (const [path, d] of t.layout.deskOf) assert.equal(p.layout.deskOf.get(path), d, path);
  assert.ok(p.layout.version > t.layout.version);
  // The scene at 100 random positions above the old h0 is unchanged.
  fc.assert(fc.property(fc.integer({ min: 513, max: 700 }), fc.integer({ min: 0, max: 1003 }), fc.nat({ max: 5 }), (height, sub, k) => {
    assert.deepEqual(reduceScene(p, { height, sub, k }), reduceScene(t, { height, sub, k }));
  }), { numRuns: 100 });
  // Prepending down to 0 starts from initialFoldState with the frames from height 0.
  const q = prependTimeline(p, { h0: 0, start: START, frames: frames.slice(0, 257) });
  assert.deepEqual([q.h0, q.segments.map((s) => s.hs)], [0, [0, 256, 512]]);
  assert.equal(q.events[0]!.kind, 'room_open');
  assert.deepEqual(q.layout.desks.slice(0, p.layout.desks.length), p.layout.desks);
  // Positions stay unique and increasing across the segments.
  for (let i = 1; i < q.events.length; i++) assert.ok(comparePos(q.events[i - 1]!, q.events[i]!) < 0);
});

test('TimelineBuilder.replay from a kept carry reproduces the events first built for that range and throws LayoutFrozenError if a new desk would be needed', () => {
  const frames = longBoard();
  const head: Timeline = buildTimeline({ h0: 0, start: START, frames });
  // The carry the store keeps at the checkpoint height 512.
  const b = TimelineBuilder.open(0, START);
  for (const f of frames.slice(0, 513)) b.push(f);
  const carry = b.carry();
  assert.equal(b.h1(), 512);
  const r = TimelineBuilder.replay(carry, head.layout);
  const events = [], cards = [];
  for (const f of frames.slice(513)) {
    const o = r.push(f);
    events.push(...o.events);
    cards.push(...o.cards);
    assert.equal(o.layout, null);
  }
  assert.deepEqual(events, head.events.filter((e) => e.height > 512));
  assert.deepEqual(cards, head.cards.filter((c) => c.at.height > 512));
  assert.equal(r.h1(), 700);
  // A frame naming a path the head layout lacks needs a new desk: the frozen layout refuses it.
  const r2 = TimelineBuilder.replay(carry, head.layout);
  const novel = fixtureFrames(fixture([G, { writer: 'A', cs: [{ human: 'A', n: 1, files: ['zzz/new.ts'] }] }]))[1]!;
  assert.throws(() => r2.push({ ...frames[513]!, cs: novel.cs, csPaths: novel.csPaths, code: novel.code, writer: frames[513]!.writer }), LayoutFrozenError);
  // The carry is a copy: replaying does not change it.
  assert.equal(carry.scene.at.height, 512);
});

/**
 * Plan 8a Task 8 (controller answer Q1): the room store's live head. A 700-height board whose publishes below 400 touch
 * old/* and both/*, above it new/* (desks first touched after the carry), with saves after 400 (their confetti covers desks
 * published before it: the carry's savedDesks) and joins after it (new home spots).
 */
function continueBoard(): Frame[] {
  const specs: FixtureFrame[] = [G, { writer: 'B', ops: [{ type: 'join' }] }, { writer: 'C', ops: [{ type: 'join', regionSpec: 'rs-2' }] }];
  for (let h = 3; h <= 700; h++) {
    const p = PEERS[h % 3]!;
    if (h === 450 || h === 620) specs.push({ writer: p, ops: [{ type: 'save' }], code: { shape: 'base_move', base: 'd'.repeat(40) } });
    else if (h === 480) specs.push({ writer: 'D', ops: [{ type: 'join' }] });
    else if (h % 7 === 0) specs.push({ writer: p, cs: [{ human: p, n: h, files: h < 400 ? [`old/f${h % 40}.ts`, `both/g${h % 5}.ts`] : [`new/f${h % 30}.ts`, `both/g${h % 5}.ts`] }] });
    else if (h % 97 === 0) specs.push({ writer: p, ops: [{ type: 'event', kind: 'freeze', reason_code: 'EPOCH' }] });
    else specs.push({ writer: p });
  }
  return fixtureFrames(fixture(specs));
}

test('TimelineBuilder.replay(carry, layout, false) continues a timeline: frames k+1..n give the events, cards and layout deltas buildTimeline gives for them', () => {
  const frames = continueBoard();
  // The reference: one builder over every frame (buildTimeline's own loop), its per-frame outputs kept.
  const ref = TimelineBuilder.open(0, START);
  const refOut = frames.map((f) => ref.push(f));
  const head = ref.timeline();
  assert.deepEqual(serializeTimeline(head), serializeTimeline(buildTimeline({ h0: 0, start: START, frames })));
  // The store's form: no long-lived builder — a builder to k, then a fresh unfrozen continuation from its carry and layout,
  // chained at several split points (each continuation starts from the previous one's carry and layout).
  for (const splits of [[400], [130, 400, 455, 619], [449, 450, 451]]) {
    const a = TimelineBuilder.open(0, START);
    for (const f of frames.slice(0, splits[0]! + 1)) a.push(f);
    let carry = a.carry();
    let layout = a.timeline().layout;
    const outs: FrameOutput[] = [];
    for (let i = 0; i < splits.length; i++) {
      const lo = splits[i]! + 1, hi = i + 1 < splits.length ? splits[i + 1]! : frames.length - 1;
      const c = TimelineBuilder.replay(carry, layout, false);
      for (const f of frames.slice(lo, hi + 1)) outs.push(c.push(f));
      assert.equal(c.h1(), hi);
      carry = c.carry();
      layout = c.timeline().layout;
    }
    assert.deepEqual(outs, refOut.slice(splits[0]! + 1), `events, cards, layout deltas and unknown counts after ${splits.join(', ')}`);
    assert.deepEqual(layout, head.layout, 'the same layout: new desks and home spots in the same order');
    assert.deepEqual(carry, ref.carry(), 'the same carry at the tip');
  }
  // The save at 450 lists desks published before 400 (the carry's savedDesks, preserved by the continuation).
  const save = head.events.find((e) => e.kind === 'save' && e.height === 450);
  assert.ok(save !== undefined && save.kind === 'save');
  const oldDesks = new Set(head.layout.desks.filter((d) => d.key.startsWith('old/')).map((d) => d.ordinal));
  assert.ok(save.desks.some((d) => oldDesks.has(d)), 'savedDesks carried across the split');
  // New desks and home spots exist after the split (the continuation allocated them).
  assert.ok(head.layout.desks.some((d) => d.key.startsWith('new/') && d.first > 400));
  assert.ok(head.layout.homeOrder.includes(peerOf('D')));

  // Desks another builder appended meanwhile (as "load earlier" does) stay where they are: the continuation's new desks come
  // after them, no ordinal is given twice (VIZ-16).
  const a = TimelineBuilder.open(0, START);
  for (const f of frames.slice(0, 401)) a.push(f);
  const carry = a.carry();
  const before = a.timeline().layout;
  const lb = new LayoutBuilder(before);
  lb.desk('zzz/earlier.ts', 3);
  const grown = lb.layout();
  assert.equal(grown.desks.length, before.desks.length + 1);
  const g = TimelineBuilder.replay(carry, grown, false);
  for (const f of frames.slice(401)) g.push(f);
  const gl = g.timeline().layout;
  assert.deepEqual(gl.desks.slice(0, grown.desks.length), grown.desks, 'existing desks unchanged');
  assert.deepEqual(gl.desks.map((d) => d.ordinal), gl.desks.map((_, i) => i), 'ordinals unique and dense');
  assert.deepEqual(gl.desks.slice(grown.desks.length).map((d) => d.key), head.layout.desks.slice(before.desks.length).map((d) => d.key), 'the head\'s new desks, after the appended one');

  // The default stays a frozen re-fold.
  const r = TimelineBuilder.replay(carry, before);
  const novel = fixtureFrames(fixture([G, { writer: 'A', cs: [{ human: 'A', n: 1, files: ['zzz/new.ts'] }] }]))[1]!;
  assert.throws(() => r.push({ ...frames[401]!, cs: novel.cs, csPaths: novel.csPaths, code: novel.code, writer: frames[401]!.writer }), LayoutFrozenError);
  // An unfrozen one allocates it.
  const u = TimelineBuilder.replay(carry, before, false);
  const out = u.push({ ...frames[401]!, cs: novel.cs, csPaths: novel.csPaths, code: novel.code, writer: frames[401]!.writer });
  assert.ok(out.layout !== null && out.layout.desks.some((d) => d.key === 'zzz/new.ts' && d.ordinal === before.desks.length));
});
