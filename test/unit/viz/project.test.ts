// Plan 8a Task 9: the view-model projection (12 §3.10.6 allowlist and never-served list, §3.8 seen_ms, §3.6 labels; VIZ-24,
// VIZ-35; R-V23, R-V28, R-V43, R-V47, R-V50, R-V51, R-V56, R-V73): what is served, in which shape, and what never is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostname, userInfo } from 'node:os';
import { initialFoldState, type FoldState, type PeerRec } from '../../../src/board/fold.js';
import type { Card } from '../../../src/viz/model/cards.js';
import type { PeerRef, SceneEvent } from '../../../src/viz/model/events.js';
import { phOf } from '../../../src/viz/model/labels.js';
import { startScene } from '../../../src/viz/model/start.js';
import type { Scene } from '../../../src/viz/model/scene.js';
import type { CardModel, PeerInfo, TimelinePageModel } from '../../../src/viz/server/models.js';
import {
  createHandleTable, PATHS_MAX_BYTES, projectCard, projectDelta, projectEvent, projectLayout, projectOverlay, projectPage, projectRoom,
  projectScene, projectWorld, servedPaths, vizText, type HandleTable,
} from '../../../src/viz/server/project.js';
import { escapeJson, frameSse, SSE_MAX_BYTES } from '../../../src/viz/server/stream.js';
import type { ActorVM, EventVM, StreamPayload } from '../../../src/viz/server/viewModel.js';
import type { ActorRef } from '../../../src/viz/model/events.js';
import { DRAFT_PROTOCOL, ev } from '../../helpers/vizEvents.js';
import {
  allKindsEvents, cardOf, deltaOf, layoutOf, OVERLAY, PA, PB, PC, PD, peerInfo, peerOf, PATHS4, ROOM_ID, SA, sceneAfter, snapshotOf, SPEC,
} from '../../helpers/vizModels.js';

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');
const keysOf = (o: object): string[] => Object.keys(o).sort();

test("T-VIZ-view-model: no projected value contains coauthor_optin's name or e-mail, a config_fingerprint key, plugin_sha, an absolute path, the OS user or host name, a 64-hex token or a commit e-mail", () => {
  const rec = (display: string, coauthor: false | string): PeerRec => ({
    epoch: 'e'.repeat(32), status: 'active', retired_epochs: [], display, plugin_version: '0.2.0', plugin_sha: 'c0ffee5a'.repeat(8), regionSpec: 'rs-1',
    config_fingerprint: { filters: { lfs: 'git-lfs filter-process' }, autocrlf: 'input', eol_attrs: 'zz-eol-attrs', git: '2.47.1', fp_private_key_zq: 'zq-value' },
    coauthor_optin: coauthor, last_seq: 3, last_height: 12,
  });
  const fold: FoldState = { ...initialFoldState(DRAFT_PROTOCOL), height: 12, peers: { [PA]: rec('Ann', 'Ann <ann@corp.example>'), [PB]: rec('Bo', false) } };
  const layout = layoutOf(PATHS4, [PA, PB]);
  const scene = startScene(fold, 12, layout);
  const peers = new Map<PeerRef, PeerInfo>(Object.entries(fold.peers).map(([p, r]) => [p, { display: r.display, pluginVersion: r.plugin_version, status: r.status }]));
  const spec = { ...SPEC, gitDir: 'C:\\Users\\someone\\work\\shop-app\\.git', canonicalRoot: '/home/someone/work/shop-app' };
  const card: CardModel = { card: cardOf([12, 1001, 0], { actor: { peer: PA } }), foldedAt: 5 };
  const m = snapshotOf({ spec, layout, scene, peers, pets: new Map(), cards: [card], window: { h0: 0, h1: 12 } });
  assert.equal(scene.characters.get(PA)?.credit, true, 'the credit badge is shown; the name and e-mail behind it are not');

  const h = createHandleTable();
  const served = [
    projectWorld([m], 7, false, [], 1_000, h),
    projectRoom(m, 1_000, h),
    projectPage({ roomId: ROOM_ID, from: 1, to: 12, scene, events: [], cards: [card], layout: null }, 1_000, h),
    projectDelta(deltaOf({ cards: [card], peers, kind: 'snapshot', scene }), 1_000, h),
  ].map((x) => JSON.stringify(x)).join('\n');

  const os = [userInfo().username, hostname()].filter((x) => x.length >= 3);
  const fixtures = JSON.stringify([fold, spec, m.cards, [...peers]]);
  for (const x of os) assert.ok(!fixtures.toLowerCase().includes(x.toLowerCase()), `fixture names differ from the OS name ${x}`);
  const never = [
    'Ann <ann@corp.example>', 'ann@corp.example', 'corp.example', '@',
    '"filters"', '"autocrlf"', '"eol_attrs"', 'zz-eol-attrs', '"fp_private_key_zq"', 'zq-value', 'git-lfs', '2.47.1', 'plugin_sha', 'c0ffee5a',
    'someone', 'C:\\\\Users', '/home/', '.git', 'refs/cowork-remote', ...os,
  ];
  for (const x of never) assert.ok(!served.toLowerCase().includes(x.toLowerCase()), `served data contains ${x}`);
  assert.doesNotMatch(served, /[0-9a-f]{64}/, 'no 64-hex token');
  assert.doesNotMatch(served, /[0-9a-f]{32}/, 'no whole peer id either: handles only');
});

/** The projection rule applied to a model value by field name (what projectEvent must give, written independently). */
function expectedVM(e: SceneEvent, h: HandleTable): Record<string, unknown> {
  const actor = (a: ActorRef): ActorVM => ('peer' in a ? { peer: h.peer(a.peer) } : { seat: h.seat(a.seat) });
  const out: Record<string, unknown> = { at: [e.height, e.sub, e.k] };
  for (const [k, v] of Object.entries(e)) {
    if (k === 'height' || k === 'sub' || k === 'k') continue;
    if ((k === 'peer' || k === 'owner') && typeof v === 'string') out[k] = h.peer(v);   // owner: a peer on pet events, an actor on box
    else if (k === 'seat') out[k] = h.seat(v as string);
    else if (k === 'holdId' || k === 'claimId') out[k] = v === null ? null : h.shortId(v as string);
    else if (['actor', 'on', 'owner', 'from', 'holder', 'requester', 'grantee'].includes(k) && typeof v === 'object' && v !== null) out[k] = actor(v as ActorRef);
    else if (k === 'line') out[k] = v === null ? null : 'actor' in (v as object) ? { actor: actor((v as { actor: ActorRef }).actor) } : { claimId: h.shortId((v as { claimId: string }).claimId) };
    else if (k === 'target' && e.kind === 'note') out[k] = v === null ? null : 'claimId' in (v as object) ? { claimId: h.shortId((v as { claimId: string }).claimId) } : v;
    else out[k] = v;
  }
  return out;
}

test('Maps become [key, value] arrays in ascending UTF-16 key order, Position becomes Pos, and nothing is added or renamed', () => {
  const h = createHandleTable();
  const events = allKindsEvents();
  // Events: every kind, field by field.
  const kinds = new Set<string>();
  for (const e of events) {
    kinds.add(e.kind);
    const vm = projectEvent(e, h) as unknown as Record<string, unknown>;
    assert.deepEqual(vm, expectedVM(e, h), e.kind);
    assert.deepEqual(keysOf(vm), keysOf({ ...e, at: 0 }).filter((k) => k !== 'height' && k !== 'sub' && k !== 'k'), e.kind);
  }
  assert.equal(kinds.size, 32, 'one event of every kind');
  const spawn = projectEvent(events.find((e) => e.kind === 'pet_spawn')!, h) as Extract<EventVM, { kind: 'pet_spawn' | 'pet_poof' }>;
  assert.equal(spawn.owner, h.peer(PA), 'pet_spawn carries its owner as a handle (R-V47)');
  const poof = projectEvent(events.find((e) => e.kind === 'pet_poof')!, h) as Extract<EventVM, { kind: 'pet_spawn' | 'pet_poof' }>;
  assert.equal(poof.owner, h.peer(PB));

  // Scenes: the same keys as the model at every level; Maps in ascending key order; positions as Pos.
  const layout = layoutOf();
  for (let i = 1; i <= events.length; i++) {
    const s: Scene = sceneAfter(events.slice(0, i), layout);
    const vm = projectScene(s, h);
    assert.deepEqual(keysOf(vm), keysOf(s));
    assert.deepEqual(vm.at, [s.at.height, s.at.sub, s.at.k]);
    const ascending = (keys: Array<string | number>): void => {
      for (let j = 1; j < keys.length; j++) assert.ok(keys[j - 1]! < keys[j]!, `ascending at ${i}: ${String(keys[j - 1])} < ${String(keys[j])}`);
    };
    for (const list of [vm.characters, vm.pets, vm.claims, vm.requests, vm.boxes, vm.bangs]) ascending(list.map(([k]) => k));
    ascending(vm.desks.map(([k]) => k));
    assert.deepEqual(vm.characters.map(([k]) => k).sort(), [...s.characters.keys()].map((p) => h.peer(p)).sort());
    for (const [k, c] of vm.characters) {
      const model = [...s.characters].find(([p]) => h.peer(p) === k)![1];
      assert.deepEqual(keysOf(c), keysOf(model));
      assert.deepEqual(c.lastPublish, model.lastPublish === null ? null : [model.lastPublish.height, model.lastPublish.sub, model.lastPublish.k]);
    }
    for (const [, p] of vm.pets) assert.deepEqual(keysOf(p), keysOf([...s.pets.values()][0]!));
    for (const [k, c] of vm.claims) {
      const model = [...s.claims].find(([id]) => h.shortId(id) === k)![1];
      assert.deepEqual(keysOf(c), keysOf(model), 'ClaimState keys, at included (R-V73)');
      assert.deepEqual(c.at, [model.at.height, model.at.sub, model.at.k]);
    }
    for (const [d, ds] of vm.desks) assert.deepEqual(keysOf(ds), keysOf(s.desks.get(d)!));
    for (const [, r] of vm.requests) assert.deepEqual(keysOf(r), ['desk', 'from', 'holder', 'status']);
    for (const [, b] of vm.boxes) assert.deepEqual(keysOf(b), keysOf([...s.boxes.values()][0]!));
    assert.equal(vm.beat.length, s.beat.length);
  }
  // A scene with more peers than one: keys sorted by UTF-16 order of the served handle.
  const many = sceneAfter([PD, PB, PC, PA].map((peer, i) => ev('person_enter', [1, 1 + i, 0], { peer })), layout);
  assert.deepEqual(projectScene(many, h).characters.map(([k]) => k), [PA, PB, PC, PD].map((p) => h.peer(p)));

  // Cards: the Card fields plus seen_ms, nothing else.
  const card: Card = cardOf([3, 1001, 0], { target: { seat: SA }, displayId: 'R0000000A', parent: 'R0000000A', label: 'Mod.parse', text: 'hi' });
  const cvm = projectCard({ card, foldedAt: null }, 0, h);
  assert.deepEqual(keysOf(cvm), keysOf({ ...card, seen_ms: 0 }));
  assert.deepEqual(cvm.at, [3, 1001, 0]);
  assert.deepEqual(cvm.target, { seat: h.seat(SA) });

  // Layout: desks carry `first` (R-V51), homeOrder holds handles, the delta's fields are the wire names.
  const l = layoutOf(PATHS4, [PB, PA], 7);
  const lvm = projectLayout(l, h);
  assert.deepEqual(lvm.homeOrder, [h.peer(PB), h.peer(PA)]);
  assert.deepEqual(lvm.desks.map((d) => d.first), l.desks.map((d) => d.first));
  assert.ok(lvm.desks.slice(1).every((d) => d.first === 7));
  for (const d of lvm.desks) assert.deepEqual(keysOf(d), ['cell', 'first', 'kind', 'lockbox', 'ordinal', 'path', 'plaque', 'slot', 'zone']);
});

test('seen_ms is nowMono − foldedAt for cards with an anchor and null otherwise', () => {
  const h = createHandleTable();
  const live: CardModel = { card: cardOf([20, 1001, 0]), foldedAt: 4_000 };
  const before: CardModel = { card: cardOf([3, 1001, 0]), foldedAt: null };   // initial window, earlier page or a re-fold without an anchor
  assert.equal(projectCard(live, 64_000, h).seen_ms, 60_000);
  assert.equal(projectCard(before, 64_000, h).seen_ms, null);
  const page: TimelinePageModel = { roomId: ROOM_ID, from: 0, to: 20, scene: sceneAfter([], layoutOf()), events: [], cards: [before, live], layout: null };
  assert.deepEqual(projectPage(page, 10_000, h).cards.map((c) => c.seen_ms), [null, 6_000]);
  const room = projectRoom(snapshotOf({ cards: [before, live] }), 5_000, h);
  assert.deepEqual(room.cards.map((c) => c.seen_ms), [null, 1_000]);
  const delta = projectDelta(deltaOf({ cards: [live] }), 4_500, h);
  assert.deepEqual((delta[0] as Extract<StreamPayload, { type: 'timeline' }>).cards.map((c) => c.seen_ms), [500]);
});

test('overlay VM: whole offline minutes, no message_params or not_converged, freeze_reasons and publish_pause only from their closed sets, null in demo mode', () => {
  const h = createHandleTable();
  const raw = {
    ...OVERLAY, state: 'frozen', offlineMin: 12.9, freezeReasons: ['PAUSED', 'UI_VIZ_LINK_REUSED', 'EPOCH', 'RF_VIZ_START_FAILED'], publishPause: 'AUTH',
    message_params: { path: '/home/someone/x' }, not_converged: ['src/secret.ts'], message_code: 'X',
  };
  const o = projectOverlay(raw, h)!;
  assert.deepEqual(keysOf(o), ['down', 'freeze_reasons', 'holds', 'incoming', 'offline_min', 'publish_pause', 'ready', 'state', 'unreadable', 'you']);
  assert.equal(o.offline_min, 12);
  assert.deepEqual(o.freeze_reasons, ['PAUSED', 'EPOCH']);
  assert.equal(o.publish_pause, 'AUTH');
  assert.equal(o.state, 'frozen');
  assert.equal(o.you, h.peer(PA));
  assert.deepEqual([o.holds, o.incoming, o.ready, o.down, o.unreadable], [1, 2, 3, false, false]);
  const text = JSON.stringify(o);
  for (const x of ['message', 'not_converged', 'secret', 'someone', 'versionSkew']) assert.ok(!text.includes(x), x);
  assert.equal(projectOverlay({ ...raw, publishPause: 'SEC_VIZ_BAD_HOST' }, h)!.publish_pause, null);
  assert.equal(projectOverlay({ ...raw, state: 'UI_VIZ_LINK_REUSED' }, h)!.state, '?');
  assert.equal(projectOverlay({ ...raw, offlineMin: null }, h)!.offline_min, null);
  assert.equal(projectOverlay({ ...raw, offlineMin: 0.4 }, h)!.offline_min, 0);
  assert.equal(projectOverlay({ ...raw, you: null }, h)!.you, null);
  assert.equal(projectOverlay(null, h), null);
  const m = snapshotOf({ overlay: raw });
  assert.notEqual(projectWorld([m], 0, false, [], 0, h).rooms[0]!.overlay, null);
  assert.equal(projectWorld([m], 0, true, [], 0, h).rooms[0]!.overlay, null, 'null in demo mode');
});

test('characters: CharacterVM.ph comes from phOf and no teammate is ever PH_OFFLINE', () => {
  const OK = peerOf('a00001'), LEFT = peerOf('a00002'), ABSENT = peerOf('a00003'), FROZEN = peerOf('a00004'), PAUSED = peerOf('a00005');
  const NOHOOKS = peerOf('a00006'), SLOWED = peerOf('a00007'), GHOST = peerOf('a00008'), FORGED = peerOf('a00009');
  const all = [OK, LEFT, ABSENT, FROZEN, PAUSED, NOHOOKS, SLOWED, GHOST, FORGED];
  const layout = layoutOf(PATHS4, all);
  const scene = sceneAfter([
    ...all.map((peer, i) => ev('person_enter', [1, 1 + i, 0], { peer })),
    ev('person_exit', [2, 1, 0], { peer: LEFT }),
    ev('person_absent', [2, 2, 0], { peer: ABSENT }),
    ev('person_freeze', [2, 3, 0], { peer: FROZEN, reasonCode: 'EPOCH' }),
    ev('person_freeze', [2, 4, 0], { peer: PAUSED, reasonCode: 'PAUSED' }),
    ev('person_freeze', [2, 5, 0], { peer: NOHOOKS, reasonCode: 'NOHOOKS' }),
    ev('person_slowed', [2, 6, 0], { peer: SLOWED, until: 182 }),
    ev('person_freeze', [2, 7, 0], { peer: FORGED, reasonCode: 'UI_VIZ_LINK_REUSED' }),
    ev('person_ghost', [2, 1002, 0], { peer: GHOST }),
    ev('person_slowed', [3, 1, 0], { peer: OK, until: 3 }),
  ], layout);
  const status = (p: PeerRef): PeerInfo['status'] => (p === LEFT ? 'left' : p === ABSENT ? 'absent' : 'active');
  const peers = new Map<PeerRef, PeerInfo>(all.map((p) => [p, peerInfo(`P${p.slice(4, 6)}`, status(p))]));
  const h = createHandleTable();
  const room = projectRoom(snapshotOf({ layout, scene, peers, pets: new Map() }), 0, h);
  const ph = new Map(room.characters.map((c) => [c.handle, c.ph]));
  const want = new Map<PeerRef, string | null>([
    [OK, 'PH_OK'], [LEFT, 'PH_LEFT'], [ABSENT, 'PH_PRESUMED_ABSENT'], [FROZEN, 'PH_FROZEN'], [PAUSED, 'PH_PAUSED'], [NOHOOKS, 'PH_NOT_COORDINATED'],
    [SLOWED, 'PH_SLOWED'], [GHOST, null], [FORGED, 'PH_FROZEN'],
  ]);
  for (const [p, code] of want) {
    assert.equal(ph.get(h.peer(p)), code, p);
    assert.equal(ph.get(h.peer(p)), phOf(scene.characters.get(p), status(p), scene.at), `${p}: phOf`);
  }
  assert.ok(![...ph.values()].includes('PH_OFFLINE'));
  assert.equal(room.characters.length, all.length, 'every peer of the room, the one that left included');
});

test('T-VIZ-api (paths): a 256-path change-set of 80-emoji paths and of 80-grapheme paths with 30 combining marks each is served as the longest prefix within 16 KiB with n = 256, identically by projectEvent, projectCard, projectPage and projectDelta', () => {
  const emoji = (i: number): string => String.fromCodePoint(0x1F600 + (i % 64));
  // U+0336 (combining long stroke overlay) composes with no base, so the paths stay NFC. With 30 marks (2 UTF-8 bytes each) on each of
  // 80 graphemes a path is 4,880 bytes, beyond validPathSyntax's 4,096 (the fold rejects such a path): every one serves as '?'. With 24
  // marks a path is valid (3,920 bytes + its folder) and its mark-stacked graphemes keep 4 marks each (R-V50).
  const marked = (i: number, marks: number): string => String.fromCharCode(0x61 + (i % 26)) + String.fromCharCode(0x336).repeat(marks);
  const markPaths = (marks: number): string[] => Array.from({ length: 256 }, (_, i) => `m${i}/${Array.from({ length: 80 }, (_, j) => marked(i + j, marks)).join('')}`);
  const sets: Array<[string, string[], boolean]> = [
    ['emoji', Array.from({ length: 256 }, (_, i) => `d${i}/${Array.from({ length: 80 }, (_, j) => emoji(i + j)).join('')}`), true],
    ['marks30', markPaths(30), false],
    ['marks24', markPaths(24), true],
  ];
  for (const [name, paths, valid] of sets) {
    const h = createHandleTable();
    const all = paths.map((p) => vizText('path', p));
    let k = 0;
    while (k < all.length && bytes(escapeJson(all.slice(0, k + 1))) <= PATHS_MAX_BYTES) k++;
    if (valid) {
      assert.ok(k > 0 && k < 256, `${name}: a strict prefix (${k})`);
      for (const s of all) assert.ok(s !== '?' && !/\p{M}{5}/u.test(s), `${name}: a valid path, at most 4 marks per grapheme`);
    } else {
      assert.ok(all.every((s) => s === '?') && k === 256, `${name}: over 4,096 bytes, each path serves as '?', and all of them fit`);
    }
    const want = all.slice(0, k);
    assert.deepEqual(servedPaths(paths), want, name);
    const e = ev('publish', [9, 1001, 0], { actor: { peer: PA }, target: 1, others: [], paths, n: 256, state: 'closed', checks: 'pass', origin: 'human' });
    const card: CardModel = { card: cardOf([9, 1001, 0], { paths, n: 256 }), foldedAt: 1 };
    const evm = projectEvent(e, h) as Extract<EventVM, { kind: 'publish' }>;
    const cvm = projectCard(card, 2, h);
    const page = projectPage({ roomId: ROOM_ID, from: 9, to: 9, scene: sceneAfter([], layoutOf()), events: [e], cards: [card], layout: null }, 2, h);
    const [msg] = projectDelta(deltaOf({ events: [e], cards: [card] }), 2, h) as [Extract<StreamPayload, { type: 'timeline' }>];
    for (const got of [evm, cvm, page.events[0] as Extract<EventVM, { kind: 'publish' }>, page.cards[0]!, msg.events[0] as Extract<EventVM, { kind: 'publish' }>, msg.cards[0]!]) {
      assert.deepEqual(got.paths, want, name);
      assert.equal(got.n, 256, `${name}: n unchanged`);
    }
    assert.ok(bytes(escapeJson(evm)) < SSE_MAX_BYTES / 2 && bytes(escapeJson(cvm)) < SSE_MAX_BYTES / 2, `${name}: the event and its card each fit`);
    assert.ok(bytes(frameSse(1, msg)) <= SSE_MAX_BYTES, `${name}: the stream message stays within 64 KiB`);
  }
});

test('projectWorld serves captions only in demo mode, each through its closed code set or the caption text check', () => {
  const h = createHandleTable();
  const m = snapshotOf({ overlay: null });
  const caps = [
    { room: ROOM_ID, height: 3, code: 'UI_VIZ_DEMO_CAPTION_2', text: null },
    { room: ROOM_ID, height: 4, code: 'UI_VIZ_LINK_REUSED', text: null },
    { room: ROOM_ID, height: 5, code: null, text: '<b>Two people</b>, two PCs' },
    { room: 'a', height: 6, code: 'UI_VIZ_DEMO_CAPTION_1', text: null },
  ];
  const w = projectWorld([m], 3, true, caps, 0, h);
  assert.deepEqual(w.captions, [
    { room_id: ROOM_ID, height: 3, code: 'UI_VIZ_DEMO_CAPTION_2', text: null },
    { room_id: ROOM_ID, height: 4, code: null, text: null },
    { room_id: ROOM_ID, height: 5, code: null, text: vizText('caption', '<b>Two people</b>, two PCs') },
  ]);
  assert.deepEqual(projectWorld([m], 3, false, caps, 0, h).captions, []);
  assert.equal(w.v, 1);
  assert.equal(w.cursor, 3);
  assert.equal(w.demo, true);
  void PC;
});
