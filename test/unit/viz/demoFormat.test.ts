// The demo log format cowork-viz-demo/1 (Plan 8a Task 7; 12 §3.9.3 as amended by the owner's choice of 2026-10-08; VIZ-27,
// VIZ-37; ruling R-V19; S18): parseDemoLog's strict rules (each refusal names its line), serializeDemoLog's round trip, and
// DemoRoomSource folding each record as the same BoardDraft a board commit gives (toDraft, foldFrame) — no git, no file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseCsTrailers, parseWriter } from '../../../src/board/boardCommit.js';
import { initialFoldState, type FoldState } from '../../../src/board/fold.js';
import type { ProtocolJson } from '../../../src/board/protocol.js';
import { foldFrame, toDraft, ZERO_PEER, type Frame, type FrameCode } from '../../../src/viz/model/frame.js';
import { buildTimeline, serializeTimeline } from '../../../src/viz/model/timeline.js';
import {
  BUNDLED_DEMO_MAX_BYTES, CAPTION_TEXT_MAX, DEMO_FORMAT, DEMO_MAX_BYTES, DemoRoomSource, demoRoomId, parseDemoLog, serializeDemoLog, type DemoCommit, type DemoLog,
} from '../../../src/viz/source/demo.js';
import {
  CAPTION_CODES, captionLine, commitLine, commitRecord, csIdOf, csOf, DEMO_PROTOCOL, demoBuffer, demoPeer, eventOp, headerLine, joinOp, storyLines, writerOf,
} from '../../helpers/vizDemo.js';

const HEADER = headerLine([{ room: 'a', name: 'shop-app', branch: 'main' }]);
const sha1 = (s: string): string => createHash('sha1').update(s, 'utf8').digest('hex');

function parsed(buf: Buffer): DemoLog {
  const r = parseDemoLog(buf, CAPTION_CODES);
  assert.ok('rooms' in r, `refused at line ${JSON.stringify(r)}`);
  return r;
}
function refusedAt(lines: readonly string[] | Buffer, line: number, what: string): void {
  const buf = Buffer.isBuffer(lines) ? lines : demoBuffer(lines);
  assert.deepEqual(parseDemoLog(buf, CAPTION_CODES), { line }, what);
}

/** Every frame of one room, folded by DemoRoomSource from height 0. */
async function demoFrames(log: DemoLog, room: string, self = ZERO_PEER): Promise<{ start: FoldState; frames: Frame[] }> {
  const header = log.rooms.find((r) => r.room === room)!;
  const src = new DemoRoomSource(header, log.commits.get(room)!);
  const tip = (await src.tip())!;
  const start = await src.startAt(0);
  const frames: Frame[] = [];
  for await (const f of src.frames(start, 0, tip.height, self)) frames.push(f);
  return { start, frames };
}
const serialized = (start: FoldState, frames: Frame[]): string => serializeTimeline(buildTimeline({ h0: 0, start, frames }));

/** The board reading of the same records (12 §3.9.3, written out independently): the drafts a board with these commits gives. */
function referenceFrames(commits: readonly DemoCommit[], room: string): { start: FoldState; frames: Frame[] } {
  const protocol = commits[0]!.protocol!;
  let prev = initialFoldState(protocol);
  const start = prev;
  let liveCode = '';
  const frames = commits.map((c) => {
    if (c.height === 0 || c.code.changed) liveCode = c.live ?? sha1(`${room}:${c.height}:live`);
    const draft = toDraft({
      liveCode, writer: c.writer === null ? null : parseWriter(c.writer), protocol, opsLines: c.ops, checkpoint: null, heldIds: c.held,
      cs: parseCsTrailers(c.cs.map((value) => ({ key: 'Cowork-CS', value }))).cs,
    });
    const code: FrameCode = { changed: c.code.changed, shape: c.height === 0 ? 'genesis' : c.code.base !== null ? 'base_move' : 'ordinary', seats: c.code.seats, base: c.code.base };
    const f = foldFrame(prev, { height: c.height, oid: sha1(`${room}:${c.height}:board`), draft, csPaths: new Map(c.csPaths), code, malformed: false }, ZERO_PEER);
    prev = f.after;
    return f;
  });
  return { start, frames };
}

/** A frame without its transient start state (the chain of states is compared through `after`). */
const strip = (f: Frame): Omit<Frame, 'before'> => {
  const { before: _before, ...rest } = f;
  return rest;
};

test('T-VIZ-demo-format: valid logs fold to the expected timeline and protocol is carried from height 0 with no protoMismatch', async () => {
  assert.equal(DEMO_FORMAT, 'cowork-viz-demo/1');
  assert.deepEqual([DEMO_MAX_BYTES, BUNDLED_DEMO_MAX_BYTES, CAPTION_TEXT_MAX], [4 * 1024 * 1024, 64 * 1024, 120]);
  const log = parsed(demoBuffer([HEADER, ...storyLines('a'), captionLine('a', 2, { code: 'UI_VIZ_DEMO_CAPTION_1' }), captionLine('a', 5, { text: 'Two people, two PCs, only git in between.' })]));
  assert.deepEqual(log.rooms, [{ room: 'a', name: 'shop-app', branch: 'main' }]);
  assert.deepEqual(log.captions, [{ room: 'a', height: 2, code: 'UI_VIZ_DEMO_CAPTION_1', text: null }, { room: 'a', height: 5, code: null, text: 'Two people, two PCs, only git in between.' }]);
  const commits = log.commits.get('a')!;
  assert.deepEqual(commits.map((c) => [c.height, c.line]), [[0, 2], [1, 3], [2, 4], [3, 5], [4, 6], [5, 7]]);
  assert.ok(commits.every((c) => c.csPaths instanceof Map));
  assert.deepEqual(commits[0]!.protocol, DEMO_PROTOCOL);
  assert.ok(commits.slice(1).every((c) => c.protocol === null && c.held.length === 0 && c.live === null && c.claims === null));

  const { start, frames } = await demoFrames(log, 'a');
  assert.deepEqual(frames.map((f) => f.height), [0, 1, 2, 3, 4, 5]);
  for (const f of frames) {
    assert.equal(f.protoMismatch, false, `height ${f.height}: protocol carried from height 0`);
    assert.equal(f.after.proto, 1);
    assert.equal(f.malformed, false);
    assert.equal(f.oid, sha1(`a:${f.height}:board`), 'the transient oid is synthesized');
  }
  assert.deepEqual(frames[0]!.code, { changed: false, shape: 'genesis', seats: [], base: 'f'.repeat(40) });
  assert.deepEqual(frames[2]!.code, { changed: true, shape: 'ordinary', seats: ['human'], base: null });
  assert.deepEqual(frames[5]!.code, { changed: false, shape: null, seats: [], base: null });
  // The expected timeline: the same records read as board drafts.
  const ref = referenceFrames(commits, 'a');
  assert.deepEqual(frames.map(strip), ref.frames.map(strip));
  const text = serialized(start, frames);
  assert.equal(text, serialized(ref.start, ref.frames));
  const kinds = buildTimeline({ h0: 0, start, frames }).events.map((e) => e.kind);
  assert.deepEqual(kinds.filter((k) => k !== 'pose_relaxed'), ['room_open', 'person_enter', 'person_enter', 'publish', 'publish', 'person_freeze', 'person_thaw']);
  const publishes = buildTimeline({ h0: 0, start, frames }).events.filter((e) => e.kind === 'publish');
  assert.deepEqual(publishes.map((e) => (e.kind === 'publish' ? [e.paths, e.n] : null)), [[['src/a.ts', 'src/b.ts'], 2], [[], 300]]);

  // Two rooms, a demo room id per room and salt, and the serializer's round trip.
  const two = parsed(demoBuffer([headerLine([{ room: 'a', name: 'shop-app', branch: 'main' }, { room: 'b2', name: 'other', branch: 'dev' }]), ...storyLines('a'), ...storyLines('b2')]));
  assert.deepEqual([...two.commits.keys()], ['a', 'b2']);
  assert.match(demoRoomId(Buffer.alloc(16), 'a'), /^r[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.notEqual(demoRoomId(Buffer.alloc(16), 'a'), demoRoomId(Buffer.alloc(16), 'b2'));
  assert.notEqual(demoRoomId(Buffer.alloc(16), 'a'), demoRoomId(Buffer.alloc(16, 1), 'a'));
  for (const x of [log, two]) {
    const again = serializeDemoLog(x);
    assert.ok(!again.includes(0x0d) && again[0] !== 0xef, 'LF, no BOM');
    assert.deepEqual(parsed(again), x);
  }
});

/** The story with line `n` (1-based, header = 1) replaced by `with` (a list: several lines; empty: removed). */
function edited(n: number, ...withLines: string[]): string[] {
  const lines = [HEADER, ...storyLines('a'), captionLine('a', 4, { code: 'UI_VIZ_DEMO_CAPTION_2' })];
  lines.splice(n - 1, 1, ...withLines);
  return lines;
}
/** Story line `n` (2–7, heights 0–5) as a record, changed by `fn`. */
function rec(n: number, fn: (r: Record<string, unknown>) => void): string {
  const r = JSON.parse([HEADER, ...storyLines('a')][n - 1]!) as Record<string, unknown>;
  fn(r);
  return JSON.stringify(r);
}

test('T-VIZ-demo-format: every invalid record refuses the whole file with its line number', () => {
  parsed(demoBuffer(edited(99)));   // the base log is valid
  const ann = demoPeer('a1', 'Ann');
  const cs3 = csOf(ann, 9, 3);
  const id3 = csIdOf(ann, 9);
  const withCs = (cs: string[], csPaths: Record<string, unknown>) => (r: Record<string, unknown>): void => {
    r['code'] = { changed: true, seats: ['human'], base: null };
    r['cs'] = cs;
    r['csPaths'] = csPaths;
  };
  const many = (n: number): string[] => Array.from({ length: n }, (_, i) => `p/${String(i).padStart(4, '0')}.ts`);
  const cases: Array<[string, string[] | Buffer, number]> = [
    ['a second header', edited(3, HEADER, [HEADER, ...storyLines('a')][2]!), 3],
    ['a missing header', edited(1), 1],
    ['an unknown t', edited(4, JSON.stringify({ t: 'note', room: 'a', height: 2 })), 4],
    ['an unknown field', edited(4, rec(4, (r) => { r['extra'] = 1; })), 4],
    ['a height-0 commit without protocol', edited(2, rec(2, (r) => { delete r['protocol']; })), 2],
    ['protocol at height > 0', edited(3, rec(3, (r) => { r['protocol'] = DEMO_PROTOCOL; })), 3],
    ['a protocol with a missing field', edited(2, rec(2, (r) => { r['protocol'] = { proto: 1, regionSpec: 'rs-1', budget: 12, G_s: 5 }; })), 2],
    ['non-consecutive heights', edited(4), 4],
    ['a repeated height', edited(4, [HEADER, ...storyLines('a')][2]!), 4],
    ['a room not in the header', edited(3, rec(3, (r) => { r['room'] = 'zz'; })), 3],
    ['a bad writer', edited(3, rec(3, (r) => { r['writer'] = 'not-a-writer'; })), 3],
    ['a cs value parseCsTrailers refuses', edited(4, rec(4, withCs(['garbage state=closed'], {}))), 4],
    ['0 csPaths entries', edited(4, rec(4, withCs([csOf(ann, 9, 0)], { [csIdOf(ann, 9)]: [] }))), 4],
    ['257 csPaths entries', edited(4, rec(4, withCs([csOf(ann, 9, 257)], { [id3]: many(257) }))), 4],
    ['unsorted paths', edited(4, rec(4, withCs([cs3], { [id3]: ['src/c.ts', 'src/a.ts', 'src/b.ts'] }))), 4],
    ['duplicate paths', edited(4, rec(4, withCs([cs3], { [id3]: ['src/a.ts', 'src/a.ts', 'src/b.ts'] }))), 4],
    ['a path failing validPathSyntax', edited(4, rec(4, withCs([cs3], { [id3]: ['../up.ts', 'src/a.ts', 'src/b.ts'] }))), 4],
    ['a csPaths key naming no cs entry', edited(4, rec(4, withCs([cs3], { [csIdOf(ann, 8)]: ['a', 'b', 'c'] }))), 4],
    ['1,001 ops', edited(5, rec(5, (r) => { r['ops'] = Array.from({ length: 1_001 }, () => '{}'); })), 5],
    ['a 16 KiB + 1 op', edited(5, rec(5, (r) => { r['ops'] = ['x'.repeat(16 * 1024 + 1)]; })), 5],
    ['ops over 64 KiB', edited(5, rec(5, (r) => { r['ops'] = Array.from({ length: 5 }, () => 'y'.repeat(16 * 1024 - 1)); })), 5],
    ['a caption with both code and text', edited(8, JSON.stringify({ t: 'caption', room: 'a', height: 1, code: 'UI_VIZ_DEMO_CAPTION_1', text: 'hi' })), 8],
    ['a caption with neither', edited(8, JSON.stringify({ t: 'caption', room: 'a', height: 1 })), 8],
    ['an unknown caption code', edited(8, captionLine('a', 1, { code: 'UI_VIZ_DEMO_CAPTION_9' })), 8],
    ['a caption code outside the pattern', edited(8, captionLine('a', 1, { code: 'UI_VIZ_DEMO_BANNER' })), 8],
    ['a 121-character caption', edited(8, captionLine('a', 1, { text: 'c'.repeat(121) })), 8],
    ['an empty caption', edited(8, captionLine('a', 1, { text: '' })), 8],
    ['a caption beyond its room\'s heights', edited(8, captionLine('a', 6, { text: 'later' })), 8],
    ['a caption of a room not in the header', edited(8, captionLine('q', 1, { text: 'who' })), 8],
    ['a caption with an unknown field', edited(8, JSON.stringify({ t: 'caption', room: 'a', height: 1, text: 'x', at: 1 })), 8],
    ['a header with an unknown field', edited(1, JSON.stringify({ t: 'header', format: DEMO_FORMAT, rooms: [{ room: 'a', name: 'shop-app', branch: 'main' }], v: 2 })), 1],
    ['a header of another format', edited(1, JSON.stringify({ t: 'header', format: 'cowork-viz-demo/2', rooms: [{ room: 'a', name: 'shop-app', branch: 'main' }] })), 1],
    ['a header room id outside ^[a-z0-9]{1,8}$', edited(1, headerLine([{ room: 'A', name: 'shop-app', branch: 'main' }])), 1],
    ['a header with no rooms', edited(1, headerLine([])), 1],
    ['a header with 33 rooms', edited(1, headerLine(Array.from({ length: 33 }, (_, i) => ({ room: `r${i}`, name: 'n', branch: 'b' })))), 1],
    ['a header room twice', edited(1, headerLine([{ room: 'a', name: 'x', branch: 'main' }, { room: 'a', name: 'y', branch: 'main' }])), 1],
    ['a 41-character room name', edited(1, headerLine([{ room: 'a', name: 'n'.repeat(41), branch: 'main' }])), 1],
    ['an empty line', edited(4, ''), 4],
    ['a record that is not an object', edited(4, '[1,2]'), 4],
    ['a line that is not JSON', edited(4, '{"t":"commit",'), 4],
  ];
  for (const [what, lines, line] of cases) refusedAt(lines, line, what);
  // The same records within the rules parse: each refusal above is its rule's, not another's.
  const opsTotal = Array.from({ length: 4 }, () => 'y'.repeat(16 * 1024 - 1));   // 4 × (16,383 + LF) = 65,536 bytes
  const controls: Array<[string, string[]]> = [
    ['three sorted paths', edited(4, rec(4, withCs([cs3], { [id3]: ['src/a.ts', 'src/b.ts', 'src/c.ts'] })))],
    ['256 csPaths entries', edited(4, rec(4, withCs([csOf(ann, 9, 256)], { [id3]: many(256) })))],
    ['a change-set without a list', edited(4, rec(4, withCs([cs3], {})))],
    ['1,000 ops', edited(5, rec(5, (r) => { r['ops'] = Array.from({ length: 1_000 }, () => '{}'); }))],
    ['a 16 KiB op', edited(5, rec(5, (r) => { r['ops'] = ['x'.repeat(16 * 1024)]; }))],
    ['ops of exactly 64 KiB', edited(5, rec(5, (r) => { r['ops'] = opsTotal; }))],
    ['a 120-character caption', edited(8, captionLine('a', 5, { text: '\u{1F600}'.repeat(120) }))],
    ['a writer of null', edited(3, rec(3, (r) => { r['writer'] = null; }))],
    ['a caption before its commits', [HEADER, captionLine('a', 5, { text: 'early' }), ...storyLines('a')]],
  ];
  for (const [what, lines] of controls) parsed(demoBuffer(lines)).rooms.length > 0 || assert.fail(what);

  // Byte-level refusals: a CR, a BOM, invalid UTF-8, each at its line.
  const base = demoBuffer(edited(99));
  const at = (n: number): number => { let p = 0; for (let i = 1; i < n; i++) p = base.indexOf(0x0a, p) + 1; return p; };
  refusedAt(Buffer.from(base.toString('utf8').replace(/\n/g, (m, off: number) => (off === at(5) - 1 ? '\r\n' : m)), 'utf8'), 4, 'a CR');
  refusedAt(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), base]), 1, 'a BOM');
  const bad = Buffer.from(base);
  bad[at(6) + 5] = 0xff;
  refusedAt(bad, 6, 'invalid UTF-8');
  refusedAt(Buffer.alloc(0), 0, 'an empty file');
});

test('T-VIZ-demo-format: csPaths keys __proto__ and constructor are refused as naming no cs entry and change no prototype', () => {
  const protoNames = Object.getOwnPropertyNames(Object.prototype).sort();
  const ann = demoPeer('a1', 'Ann');
  for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const line = rec(4, (r) => {
      r['code'] = { changed: true, seats: ['human'], base: null };
      r['cs'] = [csOf(ann, 9, 1)];
      r['csPaths'] = {};
    }).replace('"csPaths":{}', `"csPaths":{${JSON.stringify(key)}:["src/polluted.ts"]}`);
    assert.ok(line.includes(key));
    refusedAt(edited(4, line), 4, `csPaths key ${key}`);
  }
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), protoNames, 'Object.prototype is unchanged');
  assert.equal(({} as Record<string, unknown>)['0'], undefined);
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
  // A valid csPaths becomes a Map whose keys are the board's cs ids.
  const ok = parsed(demoBuffer([HEADER, ...storyLines('a')]));
  const m = ok.commits.get('a')![2]!.csPaths;
  assert.ok(m instanceof Map);
  assert.deepEqual([...m.entries()], [[csIdOf(demoPeer('a1', 'Ann'), 1), ['src/a.ts', 'src/b.ts']]]);
});

test('T-VIZ-demo-format: interleaved rooms and held lists fold as on a board; an op line parseOpLine refuses is a fold no-op exactly as on a board', async () => {
  const rooms = [{ room: 'a', name: 'one', branch: 'main' }, { room: 'b', name: 'two', branch: 'main' }];
  const a = storyLines('a');
  const b = storyLines('b');
  const interleaved = parsed(demoBuffer([headerLine(rooms), ...a.flatMap((l, i) => [l, b[i]!])]));
  const separate = parsed(demoBuffer([headerLine(rooms), ...a, ...b]));
  for (const room of ['a', 'b']) {
    const x = await demoFrames(interleaved, room);
    const y = await demoFrames(separate, room);
    assert.equal(serialized(x.start, x.frames), serialized(y.start, y.frames), `room ${room}: interleaving changes nothing`);
    assert.deepEqual(interleaved.commits.get(room)!.map((c) => c.height), [0, 1, 2, 3, 4, 5]);
  }

  // Held lists and refused op lines: the demo frames equal the board reading of the same drafts, line for line.
  const ann = demoPeer('a1', 'Ann');
  const bob = demoPeer('b2', 'Bob');
  const g = [joinOp(ann), '{"truncated":', 'not json at all', '{}', JSON.stringify({ id: 'x/y/1', type: 'join' })];
  const lines = [
    headerLine([{ room: 'a', name: 'one', branch: 'main' }]),
    commitLine({ room: 'a', height: 0, writer: writerOf(ann), protocol: DEMO_PROTOCOL, ops: g, held: [] }),
    commitLine({ room: 'a', height: 1, writer: writerOf(bob), ops: [joinOp(bob)], held: ['01HZZZZZZZZZZZZZZZZZZZZZZZ'] }),
    commitLine({ room: 'a', height: 2, writer: null, ops: [eventOp(ann, 'freeze', 'EPOCH')], held: ['01HZZZZZZZZZZZZZZZZZZZZZZZ', '01J00000000000000000000000'] }),
    commitLine({ room: 'a', height: 3, writer: writerOf(ann), ops: ['{"id":"' + `${ann.peer}/${ann.epoch}/99` + '","type":"event"}'] }),
  ];
  const log = parsed(demoBuffer(lines));
  const commits = log.commits.get('a')!;
  assert.deepEqual(commits.map((c) => c.held), [[], ['01HZZZZZZZZZZZZZZZZZZZZZZZ'], ['01HZZZZZZZZZZZZZZZZZZZZZZZ', '01J00000000000000000000000'], []]);
  const got = await demoFrames(log, 'a');
  const ref = referenceFrames(commits, 'a');
  assert.deepEqual(got.frames.map(strip), ref.frames.map(strip));
  assert.equal(serialized(got.start, got.frames), serialized(ref.start, ref.frames));
  const h0 = got.frames[0]!;
  assert.deepEqual(h0.ops.map((o) => [o.verdict, o.op === null]), [['effective', false], ['rejected', true], ['rejected', true], ['rejected', true], ['rejected', true]]);
  assert.deepEqual(got.frames[2]!.ops.map((o) => o.verdict), ['rejected'], 'no writer: every op a no-op, as on a board');
  // A refused line changes no state: the fold of height 0 equals the fold without those lines.
  const clean = foldFrame(initialFoldState(DEMO_PROTOCOL), {
    height: 0, oid: 'x', csPaths: new Map(), code: { changed: false, shape: 'genesis', seats: [], base: null }, malformed: false,
    draft: toDraft({ liveCode: '0'.repeat(40), writer: parseWriter(commits[0]!.writer!), cs: [], protocol: DEMO_PROTOCOL, opsLines: [g[0]!], checkpoint: null, heldIds: [] }),
  }, ZERO_PEER);
  assert.deepEqual(h0.after, clean.after);
});

test('T-VIZ-demo-format: live and claims', async () => {
  const live1 = 'ab'.repeat(20);
  const live2 = 'cd'.repeat(32);
  const story = storyLines('a');
  const L = (n: number, fn: (r: Record<string, unknown>) => void): string => rec(n, fn);
  const claims = {
    trees: [[live1, 'src/a.ts', 'ef'.repeat(20)], [live1, 'src/gone.ts', 'ABSENT'], ['12'.repeat(32), 'src/b.ts', '34'.repeat(32)]],
    pairs: [[`${'a1'.repeat(16)}/${'e1'.repeat(16)}/7`, `${'b2'.repeat(16)}/${'e2'.repeat(16)}/3`, true], ['abcdefghij234567', `${'b2'.repeat(16)}/${'e2'.repeat(16)}/4`, false]],
  };
  const withLive = [HEADER, story[0]!, story[1]!, L(4, (r) => { r['live'] = live1; r['claims'] = claims; }), L(5, (r) => { r['live'] = live2; }), story[4]!, L(7, (r) => { r['claims'] = { trees: [], pairs: [] }; })];
  const plain = [HEADER, ...story];
  const x = parsed(demoBuffer(withLive));
  const commits = x.commits.get('a')!;
  assert.deepEqual(commits.map((c) => c.live), [null, null, live1, live2, null, null], 'live as written; unchanged records carry none of their own');
  assert.deepEqual(commits[2]!.claims, claims);
  assert.deepEqual(commits[5]!.claims, { trees: [], pairs: [] });
  // live stands in for the synthesized liveCode (and later unchanged records inherit it): the timeline is the same.
  const a = await demoFrames(x, 'a');
  const b = await demoFrames(parsed(demoBuffer(plain)), 'a');
  assert.equal(serialized(a.start, a.frames), serialized(b.start, b.frames), 'live and claims change no Plan 2 fold');
  const ref = referenceFrames(commits, 'a');
  assert.deepEqual(a.frames.map(strip), ref.frames.map(strip));
  // The round trip keeps both fields.
  assert.deepEqual(parsed(serializeDemoLog(x)), x);

  const base = (fn: (r: Record<string, unknown>) => void): string[] => [HEADER, story[0]!, story[1]!, L(4, fn), ...story.slice(3)];
  const cl = (over: Record<string, unknown>) => (r: Record<string, unknown>): void => { r['claims'] = { ...claims, ...over }; };
  const bad: Array<[string, (r: Record<string, unknown>) => void]> = [
    ['live on an unchanged record', (r) => { r['code'] = { changed: false, seats: [], base: null }; r['live'] = live1; }],
    ['a non-oid live', (r) => { r['live'] = 'AB'.repeat(20); }],
    ['a short live', (r) => { r['live'] = 'ab'.repeat(19); }],
    ['a claims tree with a non-oid commit', cl({ trees: [['zz'.repeat(20), 'src/a.ts', 'ABSENT']] })],
    ['a claims tree with a non-oid entry', cl({ trees: [[live1, 'src/a.ts', 'absent']] })],
    ['a claims tree with a bad path', cl({ trees: [[live1, '/abs/a.ts', 'ABSENT']] })],
    ['a claims tree of two fields', cl({ trees: [[live1, 'src/a.ts']] })],
    ['a non-boolean pair answer', cl({ pairs: [[`${'a1'.repeat(16)}/${'e1'.repeat(16)}/7`, `${'b2'.repeat(16)}/${'e2'.repeat(16)}/3`, 'yes']] })],
    ['a pair id that is no id', cl({ pairs: [['not an id', `${'b2'.repeat(16)}/${'e2'.repeat(16)}/3`, true]] })],
    ['a tree key twice', cl({ trees: [[live1, 'src/a.ts', 'ABSENT'], [live1, 'src/a.ts', 'ef'.repeat(20)]] })],
    ['a pair key twice', cl({ pairs: [...claims.pairs, claims.pairs[0]!] })],
    ['an unknown claims key', cl({ extra: [] })],
    ['claims without pairs', (r) => { r['claims'] = { trees: [] }; }],
    ['claims that is not an object', (r) => { r['claims'] = [[], []]; }],
    ['trees over 1,000', cl({ trees: Array.from({ length: 1_001 }, (_, i) => [live1, `t/${i}.ts`, 'ABSENT']) })],
    ['pairs over 4,096', cl({ pairs: Array.from({ length: 4_097 }, (_, i) => [`${'a1'.repeat(16)}/${'e1'.repeat(16)}/${i + 1}`, `${'b2'.repeat(16)}/${'e2'.repeat(16)}/1`, true]) })],
  ];
  for (const [what, fn] of bad) refusedAt(base(fn), 4, what);
  // At the caps exactly: accepted.
  parsed(demoBuffer(base(cl({ trees: Array.from({ length: 1_000 }, (_, i) => [live1, `t/${i}.ts`, 'ABSENT']), pairs: Array.from({ length: 4_096 }, (_, i) => [`${'a1'.repeat(16)}/${'e1'.repeat(16)}/${i + 1}`, `${'b2'.repeat(16)}/${'e2'.repeat(16)}/1`, true]) }))));
  assert.equal(commitRecord({ room: 'a', height: 0, writer: null }).t, 'commit');
});
