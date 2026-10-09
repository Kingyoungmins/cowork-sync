// Plan 8a Task 13: the small pure page modules (R-V33) — unprojection (R-V23, R-V47, R-V73), the idempotent layout delta
// (R-V49, R-V57), the fragment (12 §3.8 "Filters", §3.10.2; R-V22), zoom and following (12 §3.5.3, §3.7; VIZ-16), the
// accessibility logic (12 §3.11; VIZ-40, R-V56) and the Map rule for served keys (VIZ-37).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import type { Position, SceneEvent } from '../../../src/viz/model/events.js';
import { deskTiles, emptyLayout, isBlocked, LayoutBuilder, officeTiles, plaqueOf, type Layout } from '../../../src/viz/model/layout.js';
import { emptyScene, reduceScene, SceneReducer, type Scene } from '../../../src/viz/model/scene.js';
import type { CardVM, CharacterVM, EventVM, LayoutDeltaVM, LayoutVM, Pos, SceneVM } from '../../../src/viz/server/viewModel.js';
import { Announcer, KEYS, peopleList, sceneSummaryParams } from '../../../src/viz/ui/a11y.js';
import { BubbleSet } from '../../../src/viz/ui/bubbles.js';
import { consumeLaunchToken, formatFilterFragment, parseFilterFragment, takeLaunchToken } from '../../../src/viz/ui/fragment.js';
import { LogModel } from '../../../src/viz/ui/logModel.js';
import { roomDots } from '../../../src/viz/ui/map.js';
import { PathCache } from '../../../src/viz/ui/path.js';
import { applyLayoutDeltaVM, unprojectEvent, unprojectLayout, unprojectScene } from '../../../src/viz/ui/unproject.js';
import { autoZoom, clampZoom, FollowRule, mapZoom, ZoomState } from '../../../src/viz/ui/zoom.js';
import { ev } from '../../helpers/vizEvents.js';
import { eventsArb, RANDOM_OFFICE } from '../../helpers/vizScene.js';

// ---------------------------------------------------------------------------------------------------------------
// The projection rule written as its inverse's test oracle: Position → Pos, Maps → [key, value] arrays in ascending key
// order (the shape Task 9's projection serves; ids are already handles here, so nothing is renamed).

type Plain = unknown;
const toPos = (p: Position): Pos => [p.height, p.sub, p.k];
/** Every nested Position (an object with exactly height, sub and k) becomes a Pos; every Map an ascending entry array. */
function vmOf(v: Plain): Plain {
  if (v instanceof Map) return [...v.entries()].sort(([a], [b]) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0)).map(([k, x]) => [k, vmOf(x)]);
  if (Array.isArray(v)) return v.map(vmOf);
  if (typeof v === 'object' && v !== null) {
    const keys = Object.keys(v);
    if (keys.length === 3 && 'height' in v && 'sub' in v && 'k' in v) return toPos(v as Position);
    const out: Record<string, Plain> = {};
    for (const k of keys) out[k] = vmOf((v as Record<string, Plain>)[k]);
    return out;
  }
  return v;
}
function eventVM(e: SceneEvent): EventVM {
  const { height, sub, k, ...rest } = e;
  return { at: [height, sub, k], ...(vmOf(rest) as object) } as EventVM;
}
function sceneVM(s: Scene): SceneVM {
  const { at, beat, ...rest } = s;
  return { at: toPos(at), ...(vmOf(rest) as object), beat: beat.map(eventVM) } as SceneVM;
}
function layoutVM(l: Layout): LayoutVM {
  return {
    version: l.version,
    zones: l.zones.map((z) => ({ index: z.index, sign: z.key, cells: [...z.cells] })),
    desks: l.desks.map((d) => ({ ordinal: d.ordinal, kind: d.kind, zone: d.zone, cell: d.cell, slot: d.slot, plaque: plaqueOf(d), path: d.path, lockbox: d.lockbox, first: d.first })),
    homeOrder: [...l.homeOrder],
  };
}

const HA = 'a1a1a1', HB = 'b2b2b2', HC = 'c3c3c3';
const SEAT_A = 'K7Q2ZP';

test('unproject inverts the projection rule: Pos ↔ (height, sub, k), arrays ↔ Maps, ids kept as handles, pet events keep their owner handle', () => {
  // Hand-written: a pet event keeps its owner handle as the owner (R-V47), and the seat handle stays the seat id.
  const spawn = unprojectEvent({ at: [12, 1_001, 0], seed: 7, kind: 'pet_spawn', seat: SEAT_A, owner: HA });
  assert.deepEqual(spawn, { height: 12, sub: 1_001, k: 0, seed: 7, kind: 'pet_spawn', seat: SEAT_A, owner: HA });
  const poof = unprojectEvent({ at: [13, 1, 2], seed: 1, kind: 'pet_poof', seat: SEAT_A, owner: HA });
  assert.equal(poof.kind, 'pet_poof');
  assert.equal(poof.kind === 'pet_poof' ? poof.owner : null, HA);

  // A served scene: Pos fields restored, entry arrays become Maps (keys are the handles), the beat unprojected, and each claim's
  // `at` (R-V73) rebuilt as a Position.
  type ClaimEntry = SceneVM['claims'][number][1] & { at: Pos };
  const claims: Array<[string, ClaimEntry]> = [['Hc000001', {
    seat: SEAT_A, desk: 1, order: 10, label: { simple: 'parse', qualname: 'M.parse' }, granularity: 'symbol', lines: [10, 15], stale: false,
    reservedFor: null, grantee: null, otherRules: false, at: [20, 3, 0],
  }]];
  const vm: Omit<SceneVM, 'claims'> & { claims: Array<[string, ClaimEntry]> } = {
    at: [21, 1_002, 1], badge: 'near_full', branchMovedAt: 5,
    characters: [[HA, { place: { at: 'chair', desk: 2 }, pose: 'sit', lastPublish: [19, 1_001, 0], lastDesk: 2, lastClaimOp: null,
      ghost: false, absent: false, frozen: null, slowedUntil: 30, rules: true, credit: false }]],
    pets: [[SEAT_A, { place: { at: 'chair', desk: 1 }, pose: 'idle', lastPublish: null, lastDesk: null, lastClaimOp: [20, 3, 0], owner: HA, variant: 0, live: true, ssCode: 'SS_FULL' }]],
    desks: [[1, { lastEvent: 20, chair: { seat: SEAT_A }, visitors: [{ peer: HB }], more: 0, claims: ['Hc000001'] }]],
    claims,
    requests: [['R00000001', { from: { peer: HB }, holder: { seat: SEAT_A }, desk: 1, status: 'asked' }]],
    boxes: [['H0000001', { owner: { peer: HA }, desk: 1, holdKind: 'PIN', residence: 'ON_DISK', state: 'CONFLICTED', localOnly: false }]],
    bangs: [['H0000001', { on: { peer: HA }, desk: 1 }]],
    beat: [{ at: [21, 1_002, 0], seed: 3, kind: 'pose_relaxed', actor: { peer: HB } }],
  };
  const s = unprojectScene(vm);
  assert.deepEqual(s.at, { height: 21, sub: 1_002, k: 1 });
  assert.ok(s.characters instanceof Map && s.pets instanceof Map && s.desks instanceof Map && s.claims instanceof Map);
  assert.ok(s.requests instanceof Map && s.boxes instanceof Map && s.bangs instanceof Map);
  assert.deepEqual(s.characters.get(HA)!.lastPublish, { height: 19, sub: 1_001, k: 0 });
  assert.deepEqual(s.pets.get(SEAT_A)!.lastClaimOp, { height: 20, sub: 3, k: 0 });
  assert.equal(s.pets.get(SEAT_A)!.owner, HA);
  assert.deepEqual(s.claims.get('Hc000001')!.at, { height: 20, sub: 3, k: 0 });
  assert.deepEqual(s.desks.get(1)!.chair, { seat: SEAT_A });
  assert.deepEqual(s.beat, [{ height: 21, sub: 1_002, k: 0, seed: 3, kind: 'pose_relaxed', actor: { peer: HB } }]);
  // Round trip: projecting the unprojected scene gives the served scene back.
  assert.deepEqual(sceneVM(s), vm);

  // Every kind, random sequences over the handles of the random office: unprojectEvent(project(e)) = e, and the page's
  // reduction of unprojected events from an unprojected start equals the reduction of the events themselves.
  fc.assert(fc.property(eventsArb({ maxLength: 40 }), (events) => {
    for (const e of events) assert.deepEqual(unprojectEvent(eventVM(e)), e);
    const r = new SceneReducer(emptyScene({ height: 0, sub: 0, k: 0 }), () => RANDOM_OFFICE);
    for (const e of events) r.push(e);
    const served = r.scene();
    assert.deepEqual(unprojectScene(sceneVM(served)), served);
    const page = reduceScene({ segments: [{ hs: 0, start: unprojectScene(sceneVM(emptyScene({ height: 0, sub: 0, k: 0 }))) }], events: events.map((e) => unprojectEvent(eventVM(e))), layout: RANDOM_OFFICE },
      events.at(-1) ?? { height: 0, sub: 0, k: 0 });
    assert.deepEqual(sceneVM(page), sceneVM(served));
  }), { numRuns: 40 });

  // The layout: deskOf rebuilt from the file desks' paths; tiles, blocked tiles and plaques unchanged.
  const b = new LayoutBuilder(emptyLayout());
  for (const p of [HA, HB]) b.home(p);
  ['src/a.ts', 'src/b.ts', 'test/c.ts', 'top.md'].forEach((p, i) => b.desk(p, 10 + i));
  const l = b.layout();
  const u = unprojectLayout(layoutVM(l));
  assert.equal(u.version, l.version);
  assert.deepEqual(u.homeOrder, l.homeOrder);
  assert.deepEqual([...u.deskOf.entries()].sort(), [...l.deskOf.entries()].sort());
  assert.deepEqual(u.zones.map((z) => [z.index, z.cells]), l.zones.map((z) => [z.index, z.cells]));
  assert.deepEqual(u.desks.map((d) => [d.ordinal, d.kind, d.zone, d.cell, d.slot, d.path, d.lockbox, d.first, plaqueOf(d)]),
    l.desks.map((d) => [d.ordinal, d.kind, d.zone, d.cell, d.slot, d.path, d.lockbox, d.first, plaqueOf(d)]));
  assert.deepEqual(officeTiles(u), officeTiles(l));
  const { w, h } = officeTiles(l);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) assert.equal(isBlocked(u, { x, y }), isBlocked(l, { x, y }), `${x},${y}`);
  for (const d of l.desks) assert.deepEqual(deskTiles(u, d.ordinal), deskTiles(l, d.ordinal));
});

// ---------------------------------------------------------------------------------------------------------------

const desk = (ordinal: number, path: string, first: number): LayoutVM['desks'][number] =>
  ({ ordinal, kind: 'file', zone: 0, cell: 0, slot: ordinal - 1, plaque: path.slice(path.lastIndexOf('/') + 1), path, lockbox: false, first });
const BASE: LayoutVM = {
  version: 3, zones: [{ index: 0, sign: 'src', cells: [0] }],
  desks: [{ ordinal: 0, kind: 'big_table', zone: null, cell: null, slot: null, plaque: null, path: null, lockbox: false, first: 0 }, desk(1, 'src/a.ts', 1)],
  homeOrder: [HA],
};

test('applyLayoutDeltaVM applies each delta once', () => {
  const d1: LayoutDeltaVM = { from_version: 3, version: 5, zones: [{ index: 0, sign: 'src', cells: [0] }], desks: [desk(2, 'src/b.ts', 40)], homeOrder: [HB] };
  const l1 = applyLayoutDeltaVM(BASE, d1);
  assert.notEqual(l1, 'reload');
  if (l1 === 'reload') return;
  assert.equal(l1.version, 5);
  assert.deepEqual(l1.desks.map((d) => d.ordinal), [0, 1, 2]);
  assert.deepEqual(l1.homeOrder, [HA, HB]);
  assert.deepEqual(BASE.desks.length, 2, 'the input layout is not changed');
  // The same delta from the stream and in a TimelinePage: the second one is a no-op (the very same layout object).
  assert.equal(applyLayoutDeltaVM(l1, d1), l1);
  // Any delta whose version is not above the page's is a no-op, whatever its from_version.
  assert.equal(applyLayoutDeltaVM(l1, { ...d1, from_version: 1, version: 4 }), l1);
  assert.equal(applyLayoutDeltaVM(l1, { ...d1, from_version: 5, version: 5 }), l1);
  // A gap: from_version is not the page's version and version is greater → reload the world.
  assert.equal(applyLayoutDeltaVM(l1, { from_version: 6, version: 7, zones: [], desks: [desk(3, 'src/c.ts', 50)], homeOrder: [] }), 'reload');
  assert.equal(applyLayoutDeltaVM(l1, { from_version: 4, version: 6, zones: [], desks: [desk(3, 'src/c.ts', 50)], homeOrder: [] }), 'reload');
  // A home-only delta is a real version step (R-V57): the new teammate is kept.
  const l2 = applyLayoutDeltaVM(l1, { from_version: 5, version: 6, zones: [], desks: [], homeOrder: [HC] });
  assert.ok(l2 !== 'reload' && l2.version === 6 && l2.homeOrder.join() === [HA, HB, HC].join());
  // A grown zone is replaced by its index; a new zone appended; desks that do not follow the last ordinal → reload.
  const l3 = applyLayoutDeltaVM(BASE, { from_version: 3, version: 5, zones: [{ index: 0, sign: 'src', cells: [0, 1] }, { index: 1, sign: 'test', cells: [2] }], desks: [], homeOrder: [] });
  assert.ok(l3 !== 'reload');
  assert.deepEqual(l3.zones, [{ index: 0, sign: 'src', cells: [0, 1] }, { index: 1, sign: 'test', cells: [2] }]);
  assert.equal(applyLayoutDeltaVM(BASE, { from_version: 3, version: 4, zones: [], desks: [desk(5, 'src/z.ts', 9)], homeOrder: [] }), 'reload');
  // A zone that does not follow (a gap in the indices, or another sign at an existing index, as model applyLayoutDelta refuses) → reload.
  assert.equal(applyLayoutDeltaVM(BASE, { from_version: 3, version: 4, zones: [{ index: 2, sign: 'docs', cells: [3] }], desks: [], homeOrder: [] }), 'reload');
  assert.equal(applyLayoutDeltaVM(BASE, { from_version: 3, version: 4, zones: [{ index: 0, sign: 'test', cells: [0, 1] }], desks: [], homeOrder: [] }), 'reload');
});

// ---------------------------------------------------------------------------------------------------------------

test('fragment: #k= must be 64 lowercase hex; filters parse only ^r[0-9A-HJKMNP-TV-Z]{8}$, ^[0-9a-f]{6,32}$ and ^(0|[1-9][0-9]{0,4})$; nothing is ever read as a path', () => {
  const hex = 'ab'.repeat(32);
  assert.equal(takeLaunchToken(`#k=${hex}`), hex);
  for (const bad of ['', '#', `#k=${hex.toUpperCase()}`, `#k=${hex}0`, `#k=${hex.slice(1)}`, `k=${hex}`, `#k=${hex}&room=r00000000`, `#K=${hex}`, `#k= ${hex}`,
    `#k=${hex.slice(0, 63)}g`, `#k=${hex}\n`]) assert.equal(takeLaunchToken(bad), null, JSON.stringify(bad));

  // consumeLaunchToken: the launch hash is cleared before the token is returned (before any request), valid or not; a filter
  // fragment is left alone.
  const log: string[] = [];
  const loc = { hash: `#k=${hex}`, clear(): void { log.push('clear'); this.hash = ''; } };
  assert.equal(consumeLaunchToken(loc), hex);
  assert.deepEqual(log, ['clear']);
  const junk = { hash: '#k=nothex', clear(): void { log.push('clear junk'); this.hash = ''; } };
  assert.equal(consumeLaunchToken(junk), null);
  assert.deepEqual(log, ['clear', 'clear junk']);
  const filters = { hash: '#room=r0123ABCD', clear(): void { log.push('clear filters'); } };
  assert.equal(consumeLaunchToken(filters), null);
  assert.deepEqual(log, ['clear', 'clear junk']);

  assert.deepEqual(parseFilterFragment('#room=r0123ABCD&peer=3f2a1b&desk=12'), { room: 'r0123ABCD', peer: '3f2a1b', desk: 12 });
  assert.deepEqual(parseFilterFragment('#peer=3f2a1b9c'), { room: null, peer: '3f2a1b9c', desk: null });
  assert.deepEqual(parseFilterFragment(''), { room: null, peer: null, desk: null });
  // Each value through its fixed regex; anything else is null — paths, traversal, prototype keys, encodings, out-of-range numbers.
  for (const [h, want] of [
    ['#room=r0123ABCI', { room: null, peer: null, desk: null }],          // I is not in Crockford base32
    ['#room=R0123ABCD', { room: null, peer: null, desk: null }],
    ['#peer=3F2A1B', { room: null, peer: null, desk: null }],
    ['#peer=3f2a1', { room: null, peer: null, desk: null }],
    [`#peer=${'a'.repeat(33)}`, { room: null, peer: null, desk: null }],
    ['#desk=src/a.ts', { room: null, peer: null, desk: null }],
    ['#desk=..%2Fetc', { room: null, peer: null, desk: null }],
    ['#desk=012', { room: null, peer: null, desk: null }],
    ['#desk=123456', { room: null, peer: null, desk: null }],
    ['#desk=99999', { room: null, peer: null, desk: 99_999 }],
    ['#desk=0', { room: null, peer: null, desk: 0 }],
    ['#__proto__=x&constructor=y&room=__proto__', { room: null, peer: null, desk: null }],
    ['#room=r0123ABCD&room=rZZZZZZZZ', { room: 'r0123ABCD', peer: null, desk: null }],
    ['room=r0123ABCD', { room: null, peer: null, desk: null }],
    ['#room=r0123ABCD%26peer%3D3f2a1b', { room: null, peer: null, desk: null }],
  ] as const) assert.deepEqual(parseFilterFragment(h), want, h);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'x'), false);

  assert.equal(formatFilterFragment({ room: 'r0123ABCD', peer: '3f2a1b', desk: 12 }), '#room=r0123ABCD&peer=3f2a1b&desk=12');
  assert.equal(formatFilterFragment({ room: null, peer: null, desk: 0 }), '#desk=0');
  assert.equal(formatFilterFragment({ room: null, peer: null, desk: null }), '');
  // An invalid value never reaches the fragment (a path, a negative or fractional desk).
  assert.equal(formatFilterFragment({ room: 'src/a.ts', peer: '../x', desk: -1 }), '');
  assert.equal(formatFilterFragment({ room: null, peer: null, desk: 1.5 }), '');
  for (const f of [{ room: 'r0123ABCD', peer: '3f2a1b', desk: 12 }, { room: null, peer: 'abcdef0123', desk: null }]) assert.deepEqual(parseFilterFragment(formatFilterFragment(f)), f);
});

test('T-VIZ-layout (zoom): Z = max(2, ⌊panelW / worldW⌋) on open, resize or a user zoom only; a growing office never changes Z and never enters the coarse view; follow only after 30 s without a user scroll', () => {
  assert.equal(autoZoom(1_000, 336), 2);
  assert.equal(autoZoom(1_400, 336), 4);
  assert.equal(autoZoom(3_000, 336), 8);
  assert.equal(autoZoom(100, 336), 2);
  assert.equal(autoZoom(1_000, 0), 2);
  assert.deepEqual([1, 2, 5, 8, 9, 4.6, Number.NaN].map(clampZoom), [2, 2, 5, 8, 8, 5, 2]);
  assert.deepEqual([1, 2, 3, 8].map(mapZoom), [1, 1, 2, 7]);

  const z = new ZoomState(336);
  assert.equal(z.coarse, false);
  z.open(1_400);
  assert.equal(z.z, 4);
  z.officeGrew();                      // the office grows downward only: Z and the view stay
  z.officeGrew();
  assert.equal(z.z, 4);
  assert.equal(z.coarse, false);
  z.resize(700);
  assert.equal(z.z, 2);
  z.userZoom(+1);
  assert.equal(z.z, 3);
  z.userZoom(+10);
  assert.equal(z.z, 8);
  z.userZoom(-10);
  assert.equal(z.z, 2);
  z.officeGrew();
  assert.equal(z.z, 2);
  z.toggleCoarse();                    // only the user enters the coarse view
  assert.equal(z.coarse, true);
  z.officeGrew();
  assert.equal(z.coarse, true);
  z.toggleCoarse();
  assert.equal(z.coarse, false);

  const f = new FollowRule();
  assert.equal(f.follow(0), true);
  f.scrolled(1_000);
  assert.equal(f.follow(1_000), false);
  assert.equal(f.follow(30_999), false);
  assert.equal(f.follow(31_000), true);
  f.scrolled(40_000);
  assert.equal(f.follow(69_999), false);
  assert.equal(f.follow(70_000), true);
});

// ---------------------------------------------------------------------------------------------------------------

test('a11y: the scene summary counts people, Claude sessions, open requests and conflicts; announcements at most one per 10 s, summarising; the keyboard map; peopleList rows carry the PH code and placeLabel\'s UI_VIZ_LAST_SHARED_HERE or UI_VIZ_HOLDING, never PH_OFFLINE', () => {
  const b = new LayoutBuilder(emptyLayout());
  for (const p of [HA, HB, HC]) b.home(p);
  b.desk('src/a.ts', 1);
  b.desk('src/b.ts', 1);
  const layout = b.layout();
  const SEAT_B = 'M4N5P6';
  const events: SceneEvent[] = [
    ev('person_enter', [1, 1, 0], { peer: HA }),
    ev('person_enter', [1, 2, 0], { peer: HB }),
    ev('person_enter', [1, 3, 0], { peer: HC }),
    ev('pet_spawn', [2, 1_001, 0], { seat: SEAT_A, owner: HA }),
    ev('pet_spawn', [2, 1_001, 1], { seat: SEAT_B, owner: HB }),
    ev('claim_take', [3, 1, 0], { claimId: 'cl1', seat: SEAT_A, desk: 2, order: 4, label: { simple: 'parse', qualname: 'M.parse' }, granularity: 'symbol', lines: [4, 9], otherRules: false }),
    ev('publish', [4, 1_001, 0], { actor: { peer: HA }, target: 1, others: [], paths: ['src/a.ts'], n: 1, state: 'closed', checks: 'pass', origin: 'human' }),
    ev('person_freeze', [5, 1, 0], { peer: HB, reasonCode: 'PAUSED' }),
    ev('request_open', [6, 1, 0], { request: 'R00000001', from: { peer: HC }, holder: { seat: SEAT_A }, desk: 2, requestKind: 'handoff', estMinutes: null, attempt: 1, note: null }),
    ev('conflict', [7, 1, 0], { conflict: 'k4', source: 'hold', on: { peer: HB }, desk: 1, holdId: 'H0000001', cid: null, eventKind: null, line: null }),
    ev('pet_poof', [8, 1_001, 0], { seat: SEAT_B, owner: HB }),
    ev('person_badge', [8, 1_002, 0], { actor: { seat: SEAT_A }, badge: 'health', on: true, code: 'SS_NO_HOOKS' }),
  ];
  const r = new SceneReducer(emptyScene({ height: 0, sub: 0, k: 0 }), () => layout);
  for (const e of events) r.push(e);
  const s = r.scene();
  // 3 people, 1 live Claude session (the poofed one does not count), 1 open request, 1 conflict.
  assert.deepEqual(sceneSummaryParams(s), { people: 3, sessions: 1, open: 1, conflicts: 1 });
  // An event-sourced conflict counts while it is in the beat.
  const r2 = new SceneReducer(s, () => layout);
  r2.push(ev('conflict', [9, 1, 0], { conflict: 'breach', source: 'event', on: { peer: HC }, desk: null, holdId: null, cid: 'ABCDEFGH', eventKind: 'breach', line: null }));
  assert.equal(sceneSummaryParams(r2.scene()).conflicts, 2);

  // Announcements: the first at once, then at most one per 10 s, each the newest summary (what arrived meanwhile).
  const a = new Announcer(10_000);
  assert.equal(a.offer('one', 0), 'one');
  assert.equal(a.offer('two', 4_000), null);
  assert.equal(a.offer('three', 9_999), null);
  assert.equal(a.flush(9_999), null);
  assert.equal(a.flush(10_000), 'three');
  assert.equal(a.flush(10_001), null);
  assert.equal(a.offer('four', 12_000), null);
  assert.equal(a.offer('five', 20_000), 'five');
  assert.equal(a.offer('six', 30_000), 'six');

  // The keyboard map of 12 §3.11 and §3.9.1, on a null-prototype table.
  assert.deepEqual(
    ['L', 'l', 'Escape', '+', '-', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Enter'].map((k) => KEYS[k]),
    ['live', 'live', 'clear_filters', 'zoom_in', 'zoom_out', 'step_back', 'step_fwd', 'page_back', 'page_fwd', 'select'],
  );
  for (const k of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'x']) assert.equal(KEYS[k], undefined, k);

  const chars: CharacterVM[] = [
    { handle: HA, name: 'Ann', hue: 0, accessory: 1, ph: 'PH_OK', version: '0.1.0', badges: [] },
    { handle: HB, name: 'Bo', hue: 1, accessory: 2, ph: 'PH_PAUSED', version: '0.1.0', badges: [] },
    { handle: HC, name: 'Cy', hue: 2, accessory: 3, ph: 'PH_OFFLINE', version: '0.1.0', badges: [] },   // a forged label never shows
    { handle: 'd4d4d4', name: 'Gone', hue: 3, accessory: 4, ph: 'PH_LEFT', version: '0.1.0', badges: [] }, // not in the scene: no row
  ];
  const rows = peopleList(s, chars, layout);
  // `person` is the handle a row's button filters the log by (12 §3.11, VIZ-40): a character's own, a pet's owner (the log's person
  // filter matches peers only, so a pet's seat handle would empty it; the canvas maps a clicked pet to its owner the same way).
  assert.deepEqual(rows, [
    { handle: HA, person: HA, name: 'Ann', ph: 'PH_OK', place: { code: 'UI_VIZ_LAST_SHARED_HERE', path: 'src/a.ts', height: 4 } },
    { handle: HB, person: HB, name: 'Bo', ph: 'PH_PAUSED', place: null },
    { handle: HC, person: HC, name: 'Cy', ph: null, place: null },
    { handle: SEAT_A, person: HA, name: 'Ann', ph: 'SS_NO_HOOKS', place: { code: 'UI_VIZ_HOLDING', label: 'parse' } },
  ]);
  for (const row of rows) assert.notEqual(row.ph, 'PH_OFFLINE');
  // A pet's row filters the log to its owner's cards (a seat handle passes no card).
  const log = new LogModel();
  const pub = (h: number, peer: string): CardVM => ({
    id: `${h}.1001.0`, at: [h, 1_001, 0], group: 'activity', code: 'UI_VIZ_CARD_PUBLISH', actor: { peer }, target: null, paths: ['src/a.ts'], n: 1, desks: [1],
    displayId: null, parent: null, label: null, text: null, detail: null, seen_ms: null,
  });
  log.add([pub(4, HA), pub(5, HB)], 0);
  const groups = new Set<CardVM['group']>(['conversation', 'activity', 'conflict']);
  const petRow = rows.find((r) => r.handle === SEAT_A)!;
  assert.equal(log.rows({ peer: petRow.person, desk: null, groups, system: false }).length, 1);
  assert.equal(log.rows({ peer: petRow.handle, desk: null, groups, system: false }).length, 0, 'the seat handle would empty the log');
});

// ---------------------------------------------------------------------------------------------------------------

test('T-VIZ-text (client): every table keyed by a served string is a Map: __proto__, constructor and prototype handles, paths and display ids change no prototype', () => {
  const HOSTILE = ['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', '__proto__/a.ts', 'constructor/prototype.ts'];
  const before = Object.getOwnPropertyNames(Object.prototype).sort().join();
  const pos = (h: number): Pos => [h, 1_001, 0];

  // Unprojection: characters, pets, desks, claims, requests, boxes and bangs keyed by hostile handles and ids.
  for (const id of HOSTILE) {
    const vm: SceneVM = {
      at: pos(5), badge: 'none', branchMovedAt: null,
      characters: [[id, { place: { at: 'home', spot: 0 }, pose: 'idle', lastPublish: null, lastDesk: null, lastClaimOp: null, ghost: false, absent: false, frozen: null, slowedUntil: null, rules: false, credit: false }]],
      pets: [[id, { place: { at: 'behind', peer: id }, pose: 'idle', lastPublish: null, lastDesk: null, lastClaimOp: null, owner: id, variant: 0, live: true, ssCode: null }]],
      desks: [[1, { lastEvent: 1, chair: { peer: id }, visitors: [], more: 0, claims: [id] }]],
      claims: [], requests: [[id, { from: { peer: id }, holder: { seat: id }, desk: 1, status: null }]],
      boxes: [[id, { owner: { peer: id }, desk: 1, holdKind: 'PIN', residence: 'ON_DISK', state: 'CONFLICTED', localOnly: false }]],
      bangs: [[id, { on: { peer: id }, desk: null }]], beat: [],
    };
    const s = unprojectScene(vm);
    assert.ok(s.characters.has(id) && s.pets.has(id) && s.requests.has(id) && s.boxes.has(id) && s.bangs.has(id), id);
    assert.equal(s.characters.size, 1);
  }
  // The layout: hostile paths rebuild deskOf as a Map.
  const l = unprojectLayout({ ...BASE, desks: [...BASE.desks, ...HOSTILE.map((p, i) => desk(2 + i, p, 3))] });
  for (const p of HOSTILE) assert.ok(l.deskOf.has(p), p);
  assert.equal(l.deskOf.get('__proto__'), 2);
  const grown = applyLayoutDeltaVM(BASE, { from_version: 3, version: 4, zones: [], desks: [desk(2, '__proto__', 9)], homeOrder: ['__proto__'] });
  assert.ok(grown !== 'reload' && grown.homeOrder.includes('__proto__'));

  // The log: cards with hostile display ids, paths and actors; request_status chips keyed by a hostile request id.
  const log = new LogModel();
  const card = (h: number, id: string): CardVM => ({ id: `${h}.1001.0`, at: pos(h), group: 'activity', code: 'UI_VIZ_CARD_PUBLISH', actor: { peer: id }, target: null,
    paths: [id], n: 1, desks: [1], displayId: id, parent: null, label: null, text: null, detail: null, seen_ms: null });
  log.add(HOSTILE.map((id, i) => card(i + 1, id)), 0);
  log.status({ at: [9, 1, 0], seed: 0, kind: 'request_status', request: '__proto__', holder: { peer: 'constructor' }, status: 'asked' });
  const rows = log.rows({ peer: null, desk: null, groups: new Set<CardVM['group']>(['conversation', 'activity', 'conflict']), system: false });
  assert.equal(rows.length, HOSTILE.length);
  assert.ok(rows.every((r) => r.kind === 'merged' && r.chips.length === 1));

  // Bubbles keyed by hostile actor ids, a path cache with hostile tiles never keyed by object property, map looks.
  const bubbles = new BubbleSet();
  for (const id of HOSTILE) bubbles.show(id, '__proto__', 'hi', 0, 1);
  assert.equal(bubbles.active(1).length, 3);
  const cache = new PathCache(4);
  assert.deepEqual(cache.get(1, { x: 0, y: 0 }, { x: 1, y: 0 }, () => [{ x: 0, y: 0 }, { x: 1, y: 0 }]), [{ x: 0, y: 0 }, { x: 1, y: 0 }]);
  const scene = emptyScene({ height: 1, sub: 0, k: 0 });
  for (const id of HOSTILE) scene.characters.set(id, { place: { at: 'home', spot: 0 }, pose: 'idle', lastPublish: null, lastDesk: null, lastClaimOp: null, ghost: false, absent: false, frozen: null, slowedUntil: null, rules: false, credit: false });
  const looks = new Map(HOSTILE.map((id, i) => [id, { hue: i % 7, accessory: 0 }]));
  const dots = roomDots(scene, looks, HOSTILE, { down: false, noBoard: false, gone: false });
  assert.deepEqual(dots.dots.map((d) => d.actor), HOSTILE);
  assert.deepEqual(dots.dots.map((d) => d.hue), HOSTILE.map((_, i) => i % 7));
  // peopleList: a character whose handle is a prototype name.
  const people = peopleList(scene, [{ handle: '__proto__', name: 'x', hue: 0, accessory: 0, ph: 'PH_OK', version: '1', badges: [] }], RANDOM_OFFICE);
  assert.deepEqual(people.map((p) => p.handle), ['__proto__']);
  // Fragments never become object keys.
  parseFilterFragment('#__proto__=1&constructor=2&prototype=3');

  assert.equal(Object.getOwnPropertyNames(Object.prototype).sort().join(), before);
  assert.equal(({} as Record<string, unknown>).x, undefined);
});
