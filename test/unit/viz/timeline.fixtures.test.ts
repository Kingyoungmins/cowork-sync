// Plan 8a Task 6: the timeline builder over the 12 §3.4 row fixtures (T-VIZ-timeline-fixtures, T-VIZ-version, T-VIZ-placement,
// T-VIZ-start; 12 §3.3.5, §3.4, §3.5.3, §3.5.4; R-V17, R-V18, R-V19, R-V42, R-V44, R-V45, R-V47, R-V51; X-91).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { liveSet, rankedSet } from '../../../src/board/fold.js';
import { PLAN2_FOLDED_TYPES, type OpType } from '../../../src/board/ops.js';
import { actorKey, type ActorRef, type SceneEvent } from '../../../src/viz/model/events.js';
import type { Frame } from '../../../src/viz/model/frame.js';
import { reduceScene, SceneReducer } from '../../../src/viz/model/scene.js';
import { actorOfCs, OP_SCENE_ROWS, TimelineBuilder, type Timeline } from '../../../src/viz/model/timeline.js';
import { emptyLayout } from '../../../src/viz/model/layout.js';
import {
  epochOf, fixtureFrames, fixtureTimeline, loadRowFixture, peerOf, ROW_FIXTURE_DIR, ROW_GOLDEN_DIR, rowFixtureNames, rowGolden, seatIdOf, seatKeyOf,
  startOf, type RowFixture, type RowTimeline,
} from '../../helpers/vizRows.js';

const ROOT = process.cwd();
const NAMES = rowFixtureNames(ROOT);
const FX = new Map<string, RowFixture>(NAMES.map((n) => [n.replace(/\.json$/, ''), loadRowFixture(join(ROOT, ROW_FIXTURE_DIR, n))]));
const fx = (name: string): RowFixture => {
  const f = FX.get(name);
  if (f === undefined) throw new Error(`no fixture ${name}`);
  return f;
};
const TL = new Map<string, RowTimeline>();
const tl = (name: string): RowTimeline => {
  let t = TL.get(name);
  if (t === undefined) TL.set(name, (t = fixtureTimeline(fx(name))));
  return t;
};

/** Peer and seat aliases back from their ids ('A', 'A/S1'). */
const ALIAS = new Map<string, string>();
for (const a of ['A', 'B', 'C', 'D']) {
  ALIAS.set(peerOf(a), a);
  for (const s of ['S1', 'S2']) for (const e of [1, 2]) ALIAS.set(`${peerOf(a)}/${epochOf(e)}/${seatIdOf(s)}`, `${a}${e === 1 ? '' : `@${e}`}/${s}`);
}
const al = (id: string): string => ALIAS.get(id) ?? id;
const actor = (a: ActorRef): string => ('peer' in a ? al(a.peer) : al(a.seat));
/** "height.sub.k kind facts": the facts each row is about, compactly. */
function brief(e: SceneEvent): string {
  const at = `${e.height}.${e.sub}.${e.k} ${e.kind}`;
  switch (e.kind) {
    case 'person_enter': case 'person_respawn': case 'person_exit': case 'person_thaw': case 'person_absent': case 'person_ghost': case 'person_unghost':
      return `${at} ${al(e.peer)}`;
    case 'person_freeze': return `${at} ${al(e.peer)} ${e.reasonCode}`;
    case 'person_slowed': return `${at} ${al(e.peer)} ${e.until}`;
    case 'person_bang': return `${at} ${al(e.peer)} ${e.bang}`;
    case 'person_badge': return `${at} ${actor(e.actor)} ${e.badge}:${e.on}${e.code === null ? '' : ` ${e.code}`}`;
    case 'pet_spawn': case 'pet_poof': return `${at} ${al(e.seat)} of ${al(e.owner)}`;
    case 'pose_relaxed': return `${at} ${actor(e.actor)}`;
    case 'publish': return `${at} ${actor(e.actor)} @${e.target}+[${e.others.join(',')}] ${JSON.stringify(e.paths)} n=${e.n} ${e.state}/${e.checks}/${e.origin}`;
    case 'room_badge': return `${at} ${e.level}`;
    case 'room_sign': return `${at} ${e.sign}`;
    case 'conflict': return `${at} ${e.conflict}/${e.source} on ${actor(e.on)} desk=${e.desk} cid=${e.cid === null ? null : 'yes'} kind=${e.eventKind} line=${JSON.stringify(e.line)}`;
    case 'save': return `${at} ${al(e.peer)} [${e.desks.join(',')}]`;
    default: return at;
  }
}
const briefs = (name: string): string[] => tl(name).timeline.events.map(brief);

/** What each Plan 2 row fixture must show (12 §3.4), position by position. */
const EXPECT: Readonly<Record<string, readonly string[]>> = {
  genesis: ['0.0.0 room_open', '0.1.0 person_enter A'],
  join_new: ['0.0.0 room_open', '0.1.0 person_enter A', '1.1.0 person_enter B'],
  join_epoch: ['0.0.0 room_open', '0.1.0 person_enter A', '1.1.0 pet_spawn A/S2 of A', '1.2.0 pet_spawn A/S1 of A',
    '2.1.0 person_respawn A', '2.1.1 pet_poof A/S1 of A', '2.1.2 pet_poof A/S2 of A'],
  join_version: ['0.0.0 room_open', '0.1.0 person_enter A', '1.1.0 person_badge A version:true'],
  join_rules: ['0.0.0 room_open', '0.1.0 person_enter A', '1.1.0 person_enter B', '1.1.1 person_badge B rules:true', '2.1.0 person_badge B rules:false'],
  rules_change: ['0.0.0 room_open', '0.1.0 person_enter A', '1.1.0 person_enter B', '1.1.1 person_badge B rules:true', '2.1.0 person_exit A',
    '2.1002.0 person_badge B rules:false', '3.1.0 person_enter D', '3.1.1 person_badge D rules:true',
    '201.1002.0 person_ghost B', '201.1002.1 person_badge B rules:true', '201.1002.2 person_badge D rules:false', '203.1002.0 person_unghost B'],
  join_credit: ['0.0.0 room_open', '0.1.0 person_enter A', '1.1.0 person_enter B', '1.1.1 person_badge B credit:true'],
  leave: ['0.0.0 room_open', '0.1.0 person_enter A', '1.1.0 person_enter B', '2.1.0 pet_spawn B/S2 of B', '2.2.0 pet_spawn B/S1 of B',
    '3.1.0 person_exit B', '3.1.1 pet_poof B/S1 of B', '3.1.2 pet_poof B/S2 of B'],
  join_back: ['0.0.0 room_open', '0.1.0 person_enter A', '1.1.0 person_enter B', '1.1.1 person_badge B credit:true', '2.1.0 person_exit B',
    '3.1.0 person_enter B', '3.1.1 person_badge B credit:true'],
  seat_start: ['0.0.0 room_open', '0.1.0 person_enter A', '1.1.0 pet_spawn A/S1 of A'],
  seat_end: ['0.0.0 room_open', '0.1.0 person_enter A', '1.1.0 pet_spawn A/S1 of A', '2.1.0 pet_poof A/S1 of A'],
  seat_footprint: ['0.0.0 room_open', '0.1.0 person_enter A', '1.1001.0 pet_spawn A/S1 of A', '1.1001.1 pet_spawn A/S2 of A',
    '1.1001.2 publish A @1+[] ["src/a.ts"] n=1 closed/pass/human', '1.1001.3 publish A/S1 @2+[] ["src/b.ts"] n=1 checkpoint/pass/prompt'],
  publish_cs: ['0.0.0 room_open', '0.1.0 person_enter A', '1.1001.0 publish A @1+[2,3,4] ["src/b.ts","src/a.ts","test/t.ts","src/c.ts"] n=4 closed/pass/human',
    '1.1001.1 publish A @5+[] ["docs/x.md"] n=1 closed/fail/human'],
  publish_big: ['0.0.0 room_open', '0.1.0 person_enter A', '1.1001.0 publish A @0+[] [] n=300 closed/pass/human'],
  publish_nocs: ['0.0.0 room_open', '0.1.0 person_enter A', '1.1001.0 publish A @0+[] [] n=0 closed/skipped/human'],
  base_move: ['0.0.0 room_open', '0.1.0 person_enter A', '1.1001.0 room_sign branch_moved'],
  save: ['0.0.0 room_open', '0.1.0 person_enter A', '1.1001.0 publish A @1+[] ["src/a.ts"] n=1 closed/pass/human',
    '2.1001.0 publish A @2+[3] ["src/b.ts","test/c.ts"] n=2 closed/pass/human', '3.1.0 save A [1,2,3]',
    '4.1001.0 publish A @2+[] ["src/b.ts"] n=1 closed/pass/human', '5.1.0 save A [2]'],
  freeze: ['0.0.0 room_open', '0.1.0 person_enter A', '1.1.0 person_freeze A EPOCH'],
  unfreeze: ['0.0.0 room_open', '0.1.0 person_enter A', '1.1.0 person_freeze A EPOCH', '2.1.0 person_thaw A'],
  slowed: ['0.0.0 room_open', '0.1.0 person_enter A', '5.1.0 person_slowed A 185'],
  health_other: ['0.0.0 room_open', '0.1.0 person_enter A', '1.1.0 person_badge A health:true BRANCH_ESCAPE'],
  nonretryable: ['0.0.0 room_open', '0.1.0 person_enter A', '1.1.0 person_bang A host'],
  event_breach: ['0.0.0 room_open', '0.1.0 person_enter A', '1.1.0 conflict breach/event on A desk=null cid=yes kind=breach line=null'],
  event_k: ['0.0.0 room_open', '0.1.0 person_enter A', '1.1.0 conflict generic/event on A desk=null cid=yes kind=K4 line=null',
    '2.1.0 conflict generic/event on A desk=null cid=yes kind=K7 line=null'],
  ghost: ['0.0.0 room_open', '0.1.0 person_enter A', '1.1.0 person_enter B', '201.1002.0 person_ghost B', '202.1002.0 person_unghost B'],
  relaxed: ['0.0.0 room_open', '0.1.0 person_enter A', '1.1001.0 publish A @1+[] ["src/a.ts"] n=1 closed/pass/human', '65.1002.0 pose_relaxed A',
    '71.1001.0 publish A @1+[] ["src/a.ts"] n=1 closed/pass/human', '135.1002.0 pose_relaxed A'],
  board_full: ['0.0.0 room_open', '0.1.0 person_enter A', '764.1002.0 room_badge near_full', '766.350.0 room_badge full',
    '768.1002.0 room_badge near_full', '1024.1002.0 room_badge none'],
  // 12 §3.4 "full from that event … until a frame with record_count < 5,000" (controller ruling, round 1: the event's own frame
  // only): full at the event's line, none at sub 1,002 of the next frame; no second room_badge while the room is full.
  board_full_event: ['0.0.0 room_open', '0.1.0 person_enter A', '3.1.0 room_badge full', '4.1002.0 room_badge none', '5.1.0 room_badge full',
    '7.1002.0 room_badge none'],
  incident: ['0.0.0 room_open', '0.1.0 person_enter A'],
};

test('T-VIZ-timeline-fixtures: every row the Plan 2 fold applies gives its golden events with positions', () => {
  const plan2Rows = ['genesis', 'join_new', 'join_epoch', 'join_version', 'join_rules', 'rules_change', 'join_credit', 'leave', 'join_back', 'seat_start',
    'seat_end', 'seat_footprint', 'publish_cs', 'publish_big', 'publish_nocs', 'base_move', 'save', 'freeze', 'unfreeze', 'slowed', 'board_full',
    'board_full_event', 'health_other', 'nonretryable', 'event_breach', 'event_k', 'ghost', 'relaxed'];
  for (const r of plan2Rows) {
    assert.deepEqual(briefs(r), EXPECT[r], r);
    assert.ok(Number.isInteger(fx(r).plan) && fx(r).plan >= 2 && fx(r).plan <= 7, `${r}: marked with its plan`);
  }
  // Every fixture's golden, byte for byte (test/golden/viz/rows/<row>.events.json, regenerated only by viz:golden, X-91).
  for (const n of NAMES) {
    const golden = readFileSync(join(ROOT, ROW_GOLDEN_DIR, n.replace(/\.json$/, '.events.json')), 'utf8');
    const name = n.replace(/\.json$/, '');
    assert.equal(rowGolden(fx(name), tl(name)), golden, n);
    assert.ok(!golden.includes('\r') && !golden.startsWith('\u{FEFF}'), `${n}: LF, no BOM`);
  }
  // Every pet_spawn and pet_poof carries its owner (R-V47); unknown counts of the applied rows: only board_full's incidents.
  for (const n of FX.keys()) {
    for (const e of tl(n).timeline.events) if (e.kind === 'pet_spawn' || e.kind === 'pet_poof') assert.equal(e.owner, e.seat.split('/')[0], n);
  }
  for (const r of plan2Rows.filter((x) => x !== 'board_full')) assert.deepEqual(tl(r).unknown, [], r);
  assert.equal(tl('board_full').unknown.reduce((a, [, n]) => a + n, 0), 4999);     // every incident, never the BOARD_FULL health event
  // Cards: the join row's card, the rules card only when on, a credit badge and footprint spawns uncarded, the publish cards.
  const codes = (n: string): string[] => tl(n).timeline.cards.map((c) => `${c.id} ${c.code}`);
  assert.deepEqual(codes('join_back'), ['0.0.0 UI_VIZ_CARD_ROOM_OPEN', '0.1.0 UI_VIZ_CARD_JOIN', '1.1.0 UI_VIZ_CARD_JOIN', '2.1.0 UI_VIZ_CARD_LEAVE', '3.1.0 UI_VIZ_CARD_JOIN']);
  assert.deepEqual(codes('join_rules').slice(2), ['1.1.0 UI_VIZ_CARD_JOIN', '1.1.1 UI_VIZ_CARD_RULES']);
  assert.deepEqual(codes('seat_footprint').slice(2), ['1.1001.2 UI_VIZ_CARD_PUBLISH', '1.1001.3 UI_VIZ_CARD_PUBLISH']);
  assert.deepEqual(codes('join_epoch').slice(2), ['1.1.0 UI_VIZ_CARD_SEAT_START', '1.2.0 UI_VIZ_CARD_SEAT_START', '2.1.0 UI_VIZ_CARD_REJOIN']);
  assert.deepEqual(codes('board_full').slice(2), ['766.350.0 UI_VIZ_CARD_BOARD_FULL']);
  // board_full_event: every BOARD_FULL op folds effective (so the repeats reach the row), far below 4,000 records; one card per
  // entry into full.
  const bfe = fixtureFrames(fx('board_full_event'));
  assert.deepEqual([3, 5, 6].map((h) => bfe[h]!.ops.map((o) => o.verdict)), [['effective'], ['effective', 'effective'], ['effective']]);
  assert.ok(bfe.every((f) => f.after.record_count < 4000));
  assert.deepEqual(codes('board_full_event').slice(2), ['3.1.0 UI_VIZ_CARD_BOARD_FULL', '5.1.0 UI_VIZ_CARD_BOARD_FULL']);
});

test('T-VIZ-timeline-fixtures: a step-6 teamRegionSpec switch with no join flips the rules badge at sub 1,002', () => {
  const frames = fixtureFrames(fx('rules_change'));
  const t = tl('rules_change').timeline;
  // The flips with no join of their own (sub 1,002): B off after A leaves; B on (and D off) when B's ghosting leaves D alone in R.
  const flips = t.events.filter((e) => e.kind === 'person_badge' && e.badge === 'rules' && e.sub === 1002).map(brief);
  assert.deepEqual(flips, ['2.1002.0 person_badge B rules:false', '201.1002.1 person_badge B rules:true', '201.1002.2 person_badge D rules:false']);
  // Fold step 6 did switch teamRegionSpec at those heights, with no join in the frame.
  assert.deepEqual(frames.filter((f) => f.before.teamRegionSpec !== f.after.teamRegionSpec).map((f) => [f.height, f.after.teamRegionSpec, f.ops.some((o) => o.type === 'join')]),
    [[2, 'rs-2', false], [201, 'rs-3', false]]);
  // The badge equals regionSpec ≠ teamRegionSpec of `after` for every drawn character at the end of every frame.
  for (const f of frames) {
    const s = reduceScene(t, { height: f.height, sub: Number.MAX_SAFE_INTEGER, k: 0 });
    for (const [p, c] of s.characters) assert.equal(c.rules, f.after.peers[p]!.regionSpec !== f.after.teamRegionSpec, `${f.height} ${al(p)}`);
    // And the ghost look follows the fold's own rule (liveSet ∖ rankedSet).
    const live = new Set(liveSet(f.after)), ranked = new Set(rankedSet(f.after));
    for (const [p, c] of s.characters) assert.equal(c.ghost, live.has(p) && !ranked.has(p), `${f.height} ghost ${al(p)}`);
  }
});

test('T-VIZ-version (unit): rows whose op is unfolded in Plan 2 make no event and count in unknown', () => {
  const unfolded: Array<[string, number]> = [['claim', 4], ['release', 4], ['request', 6], ['request_status', 6], ['answer', 6], ['note', 6], ['presume_absent', 6], ['hold', 3]];
  for (const [type, plan] of unfolded) {
    const name = `unfolded_${type}`;
    assert.equal(fx(name).plan, plan, `${name}: marked with the plan that folds it`);
    const frames = fixtureFrames(fx(name));
    assert.deepEqual(frames[2]!.ops.map((o) => [o.type, o.verdict]), [[type, 'unfolded']], name);
    assert.deepEqual(tl(name).timeline.events.filter((e) => e.height === 2), [], name);
    assert.deepEqual(tl(name).unknown, [[2, 1]], name);
  }
  // An op of an unknown type (malformed) and a generic-invalid op (another peer's op id): rejected, no event, one unknown each.
  assert.deepEqual(fixtureFrames(fx('unknown_type'))[1]!.ops.map((o) => [o.type, o.verdict]), [['unknown', 'rejected']]);
  assert.deepEqual(tl('unknown_type').timeline.events.filter((e) => e.height === 1), []);
  assert.deepEqual(tl('unknown_type').unknown, [[1, 1]]);
  assert.deepEqual(fixtureFrames(fx('rejected'))[2]!.ops.map((o) => [o.type, o.verdict]), [['leave', 'rejected']]);
  assert.deepEqual(tl('rejected').timeline.events.filter((e) => e.height === 2), []);
  assert.deepEqual(tl('rejected').unknown, [[2, 1]]);
});

test('caps makes no event and is not unknown; event{incident} makes no event and counts unknown', () => {
  const g = fixtureFrames(fx('genesis'))[0]!;
  assert.deepEqual(g.ops.map((o) => [o.line, o.type, o.verdict]), [[0, 'join', 'effective'], [1, 'caps', 'effective']]);
  assert.deepEqual(tl('genesis').timeline.events.filter((e) => e.sub === 2), []);
  assert.deepEqual(tl('genesis').unknown, []);
  const i = fixtureFrames(fx('incident'))[1]!;
  assert.deepEqual(i.ops.map((o) => [o.type, o.verdict]), [['event', 'effective']]);
  assert.deepEqual(tl('incident').timeline.events.filter((e) => e.height === 1), []);
  assert.deepEqual(tl('incident').unknown, [[1, 1]]);
});

test('a board-only publish makes no code event; a not_commit or commit_too_large live read gives shape null and counts unknown; a malformed board commit folds as a noopDraft frame that counts unknown', () => {
  const bo = fixtureFrames(fx('board_only'));
  assert.equal(bo[2]!.code.changed, false);
  assert.equal(bo[2]!.cs.length, 1);
  assert.deepEqual(briefs('board_only').filter((s) => s.startsWith('2.')), []);
  assert.deepEqual(tl('board_only').unknown, []);
  const sn = fixtureFrames(fx('live_shape_null'));
  assert.deepEqual(sn[1]!.code, { changed: true, shape: null, seats: [], base: null });
  assert.deepEqual(briefs('live_shape_null').filter((s) => s.startsWith('1.')), []);
  assert.deepEqual(tl('live_shape_null').unknown, [[1, 1]]);
  const m = fixtureFrames(fx('malformed'));
  assert.equal(m[2]!.malformed, true);
  assert.deepEqual([m[2]!.writer, m[2]!.ops, m[2]!.cs, m[2]!.code], [null, [], [], { changed: false, shape: null, seats: [], base: null }]);
  assert.deepEqual(m[2]!.after.peers, m[2]!.before.peers);
  assert.deepEqual(briefs('malformed').filter((s) => s.startsWith('2.')), []);
  assert.deepEqual(tl('malformed').unknown, [[2, 1]]);
});

test('positions are unique and increasing, k follows the row order, then ascending seat key, then claim id', () => {
  for (const n of FX.keys()) {
    const evs = tl(n).timeline.events;
    for (let i = 1; i < evs.length; i++) {
      const a = evs[i - 1]!, b = evs[i]!;
      assert.ok(a.height < b.height || (a.height === b.height && (a.sub < b.sub || (a.sub === b.sub && a.k < b.k))), `${n}: ${brief(a)} < ${brief(b)}`);
      // k counts 0, 1, 2, … within one (height, sub).
      if (a.height === b.height && a.sub === b.sub) assert.equal(b.k, a.k + 1, n);
      else assert.equal(b.k, 0, `${n}: ${brief(b)}`);
    }
  }
  // Row order first (respawn, then its poofs; exit, then its poofs; spawns before the publishes; enter, then the badges), then
  // ascending seat key — the fixtures start their seats S2 before S1. No claim exists on a Plan 2 board (claim ids: Plans 4/6).
  assert.ok(seatKeyOf('A', 'S1') < seatKeyOf('A', 'S2'));
  assert.deepEqual(briefs('join_epoch').slice(4), ['2.1.0 person_respawn A', '2.1.1 pet_poof A/S1 of A', '2.1.2 pet_poof A/S2 of A']);
  assert.deepEqual(briefs('leave').slice(5), ['3.1.0 person_exit B', '3.1.1 pet_poof B/S1 of B', '3.1.2 pet_poof B/S2 of B']);
  assert.deepEqual(briefs('seat_footprint').slice(2).map((s) => s.split(' ').slice(0, 3).join(' ')),
    ['1.1001.0 pet_spawn A/S1', '1.1001.1 pet_spawn A/S2', '1.1001.2 publish A', '1.1001.3 publish A/S1']);
  // The sub-1,002 order: room level first, then per actor in (peer, seat key) order, ghost, unghost, rules, relaxed.
  assert.deepEqual(briefs('rules_change').filter((s) => s.startsWith('201.')), ['201.1002.0 person_ghost B', '201.1002.1 person_badge B rules:true', '201.1002.2 person_badge D rules:false']);
});

test('T-VIZ-placement (cs grammar): actorOfCs: a human id of the writer → its character; a human id naming another peer → the writer\'s character; a seat id → the pet <writer.peer>/<writer.epoch>/<seat_id>', () => {
  const A = peerOf('A'), B = peerOf('B'), E = epochOf(1), S = seatIdOf('S1');
  const w = { peer: A, epoch: E, seq: 9 };
  assert.deepEqual(actorOfCs(`${A}/human/3`, w), { peer: A });
  assert.deepEqual(actorOfCs(`${B}/human/1`, w), { peer: A });
  assert.deepEqual(actorOfCs(`${S}/7`, w), { seat: `${A}/${E}/${S}` });
  // (peerOf('z') has hex letters, so its upper-case form is not a peer id; 'A''s is all digits.)
  for (const bad of ['', 'x', `${A}/human/0`, `${A}/human/01`, `${S}/0`, `${A}/robot/1`, `${peerOf('z').toUpperCase()}/human/1`]) assert.equal(actorOfCs(bad, w), null, bad);
});

test('T-VIZ-placement (server): target desk: most paths, then the actor\'s most recent desk, then the first desk key; other desks get planes in ascending ordinal', () => {
  // 23 files of zone src fill its file desks; three more go to its shelf desk, which then holds most of a change-set's paths.
  const fill = Array.from({ length: 23 }, (_, i) => `src/f${String(i).padStart(2, '0')}.ts`);
  const t = fixtureTimeline({
    row: 'target', plan: 2, about: '', frames: [
      { writer: 'A', ops: [{ type: 'join' }, { type: 'caps' }] }, { writer: 'B', ops: [{ type: 'join' }] },
      { writer: 'A', cs: [{ human: 'A', n: 1, files: fill }] },                                                   // h2: desks 1–23
      { writer: 'A', cs: [{ human: 'A', n: 2, files: ['src/x1.ts', 'src/x2.ts', 'src/x3.ts', 'a/b.ts'] }] },      // h3: shelf (3) vs a/b.ts (1)
      { writer: 'B', cs: [{ human: 'B', n: 1, files: ['src/f05.ts'] }] },                                         // h4: B sits at f05
      { writer: 'B', cs: [{ human: 'B', n: 2, files: ['src/f01.ts', 'src/f05.ts', 'src/f09.ts'] }] },             // h5: tie → f05 (B's last desk)
      { writer: 'A', cs: [{ human: 'A', n: 3, files: ['src/f09.ts', 'src/f02.ts'] }] },                         // h6: tie, A's last desk not among them → first key f02
    ],
  }).timeline;
  const desk = (p: string): number => t.layout.deskOf.get(p)!;
  const pubs = t.events.filter((e): e is Extract<SceneEvent, { kind: 'publish' }> => e.kind === 'publish');
  const shelf = desk('src/x1.ts');
  assert.equal(t.layout.desks[shelf]!.kind, 'shelf');
  assert.equal(desk('src/x2.ts'), shelf);
  assert.deepEqual([pubs[1]!.target, pubs[1]!.others], [shelf, [desk('a/b.ts')]]);
  assert.deepEqual([pubs[2]!.target, pubs[2]!.others], [desk('src/f05.ts'), []]);
  assert.deepEqual([pubs[3]!.target, pubs[3]!.others], [desk('src/f05.ts'), [desk('src/f01.ts'), desk('src/f09.ts')]]);
  assert.ok(desk('src/f01.ts') < desk('src/f09.ts'));
  assert.deepEqual([pubs[4]!.target, pubs[4]!.others], [desk('src/f02.ts'), [desk('src/f09.ts')]]);
  // The first change-set: 23 desks, target the first key, the 22 others ascending.
  assert.deepEqual([pubs[0]!.target, pubs[0]!.others], [desk('src/f00.ts'), fill.slice(1).map(desk)]);
});

test('T-VIZ-placement: across every fixture of this task the only actor-to-actor walks come from request_open', () => {
  for (const n of FX.keys()) {
    const t = tl(n).timeline;
    const r = new SceneReducer(t.segments[0]!.start, () => t.layout);
    for (const e of t.events) {
      assert.notEqual(e.kind, 'request_open', n);
      r.push(e);
      const s = r.scene();
      for (const c of [...s.characters.values(), ...s.pets.values()]) assert.notEqual(c.place.at, 'facing', `${n} ${brief(e)}`);
    }
  }
});

test('first touch: within one change-set paths are allocated sorted; across a frame in op line order, then trailer order; each new desk\'s first is the frame\'s height', () => {
  const t = fixtureTimeline({
    row: 'touch', plan: 2, about: '', frames: [
      { writer: 'A', ops: [{ type: 'join' }, { type: 'caps' }] },
      { writer: 'A', repeat: 2 },
      { writer: 'A', cs: [{ human: 'A', n: 1, files: ['z/y.ts', 'b/a.ts', 'm.ts'] }, { human: 'A', n: 2, files: ['a/z.ts', 'b/a.ts'] }] },   // h3
      { writer: 'A', cs: [{ human: 'A', n: 3, files: ['c/c.ts', 'a/z.ts'] }] },                                                       // h4
    ],
  }).timeline;
  // Plan 2 ops name no desk-eligible path (claims, requests and holds are unfolded), so a frame's order is its trailer order.
  assert.deepEqual(t.layout.desks.map((d) => [d.ordinal, d.key, d.first]),
    [[0, '\u{2302}', 0], [1, 'b/a.ts', 3], [2, 'm.ts', 3], [3, 'z/y.ts', 3], [4, 'a/z.ts', 3], [5, 'c/c.ts', 4]]);
});

test('T-VIZ-start (relaxed): the first pose_relaxed of an actor comes 64 heights after its first publish inside the segment, and never twice without a publish between', () => {
  assert.deepEqual(briefs('relaxed').filter((s) => s.includes('relaxed') || s.includes('publish')),
    ['1.1001.0 publish A @1+[] ["src/a.ts"] n=1 closed/pass/human', '65.1002.0 pose_relaxed A', '71.1001.0 publish A @1+[] ["src/a.ts"] n=1 closed/pass/human', '135.1002.0 pose_relaxed A']);
  // In every fixture: per actor, a publish lies between two pose_relaxed, and each comes 64 heights after the newest publish.
  for (const n of FX.keys()) {
    const last = new Map<string, number | 'relaxed'>();
    for (const e of tl(n).timeline.events) {
      if (e.kind === 'publish') last.set(actorKey(e.actor), e.height);
      if (e.kind === 'pose_relaxed') {
        const p = last.get(actorKey(e.actor));
        assert.ok(typeof p === 'number' && e.height === p + 64, `${n} ${brief(e)}`);
        last.set(actorKey(e.actor), 'relaxed');
      }
    }
  }
  // A segment starts with no publish history: a window opened at h0 = 256 above an earlier publish relaxes 64 heights after its own first publish.
  const seg: RowFixture = {
    row: 'seg', plan: 2, about: '', frames: [
      { writer: 'A', ops: [{ type: 'join' }, { type: 'caps' }] }, { writer: 'A', repeat: 249 },
      { writer: 'A', cs: [{ human: 'A', n: 1, files: ['src/a.ts'] }] }, { writer: 'A', repeat: 69 },                  // a publish at 250
      { writer: 'A', cs: [{ human: 'A', n: 2, files: ['src/a.ts'] }] }, { writer: 'A', repeat: 70 },                  // a publish at 320
    ],
  };
  const frames = fixtureFrames(seg);
  const relaxedAt = (t: Timeline): number[] => t.events.filter((e) => e.kind === 'pose_relaxed').map((e) => e.height);
  assert.deepEqual(relaxedAt(fixtureTimeline(seg).timeline), [314, 384]);
  const b = TimelineBuilder.open(256, frames[256]!.after, emptyLayout());
  for (const f of frames.slice(257)) b.push(f);
  assert.deepEqual(relaxedAt(b.timeline()), [384]);
});

test('the op → scene mapping table: every Plan 2 folded type has its rows; a type outside PLAN2_FOLDED_TYPES has none and its ops count in unknown', () => {
  assert.deepEqual(new Set(OP_SCENE_ROWS.keys()), new Set(PLAN2_FOLDED_TYPES));
  const outside: OpType[] = ['claim', 'release', 'request', 'request_status', 'answer', 'note', 'presume_absent', 'hold'];
  for (const t of outside) assert.equal(OP_SCENE_ROWS.has(t), false, t);
  // An op of such a type that a later build's fold made effective, before that plan adds its row: no event, one unknown.
  const frames = fixtureFrames(fx('join_new'));
  const f1 = frames[1]!;
  const forged: Frame = { ...f1, ops: [{ line: 0, type: 'claim', op: { id: `${peerOf('B')}/${epochOf(1)}/5`, type: 'claim', path: 'src/a.ts' }, verdict: 'effective' }] };
  const b = TimelineBuilder.open(0, startOf(fx('join_new')));
  b.push(frames[0]!);
  const out = b.push(forged);
  assert.deepEqual([out.events, out.cards, out.unknown], [[], [], 1]);
});
