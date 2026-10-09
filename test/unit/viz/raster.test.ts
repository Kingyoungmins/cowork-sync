// Plan 8a Task 12: the art layers composed at art resolution (12 §3.7, §3.5.2; VIZ-19, VIZ-22). raster.ts has no DOM, so
// the static and sprite layers of fixture scenes are hashed and pinned in test/golden/viz/frames.json; set
// COWORK_VIZ_GOLDEN_UPDATE=1 to rewrite that file after a deliberate art change (and review the art).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SUB_CODE, type ActorRef, type DeskRef, type PeerRef, type SceneEvent, type SeatRef } from '../../../src/viz/model/events.js';
import { BIG_TABLE, LayoutBuilder, deskTiles, emptyLayout, officeTiles, type Layout, type Tile } from '../../../src/viz/model/layout.js';
import { emptyScene, type CharacterState, type ClaimState, type DeskState, type PetState, type Place, type Scene } from '../../../src/viz/model/scene.js';
import { ENV, FIXED, PALETTE, deltaE2000, mix, srgbToLab, type Rgb } from '../../../src/viz/render/palette.js';
import { blit, composeSprites, composeStatic, iconColour, placeTile, rgba, type Rgba, type SpritePhase, type StaticOptions } from '../../../src/viz/render/raster.js';
import { ICONS, type FrameName } from '../../../src/viz/render/sprites.js';
import { ev } from '../../helpers/vizEvents.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GOLDEN = path.join(ROOT, 'test', 'golden', 'viz', 'frames.json');

type Look = { hue: number; accessory: number };
const P = (n: number): PeerRef => n.toString(16).padStart(32, '0');
const SEAT = (owner: PeerRef, n: number): SeatRef => `${owner}/E1/seat-${n}`;
const H = 100;

function ch(place: Place, o: Partial<CharacterState> = {}): CharacterState {
  return { place, pose: 'idle', lastPublish: null, lastDesk: null, lastClaimOp: null, ghost: false, absent: false, frozen: null, slowedUntil: null, rules: false, credit: false, ...o };
}
function pet(owner: PeerRef, place: Place, variant: number, o: Partial<PetState> = {}): PetState {
  return { place, pose: 'idle', lastPublish: null, lastDesk: null, lastClaimOp: null, owner, variant, live: true, ssCode: null, ...o };
}
function desk(o: Partial<DeskState>): DeskState {
  return { lastEvent: null, chair: null, visitors: [], more: 0, claims: [], ...o };
}
const home = (spot: number): Place => ({ at: 'home', spot });
const chair = (d: DeskRef): Place => ({ at: 'chair', desk: d });
const visitor = (d: DeskRef, t: number): Place => ({ at: 'visitor', desk: d, tile: t });

interface SceneSpec {
  height?: number;
  characters?: Array<[PeerRef, CharacterState]>;
  pets?: Array<[SeatRef, PetState]>;
  desks?: Array<[DeskRef, DeskState]>;
  claims?: Array<[string, ClaimState]>;
  boxes?: Array<[string, { owner: ActorRef; desk: DeskRef; holdKind: string; residence: string; state: string; localOnly: boolean }]>;
  bangs?: Array<[string, { on: ActorRef; desk: DeskRef | null }]>;
  beat?: SceneEvent[];
  badge?: Scene['badge'];
  branchMovedAt?: number | null;
}
function scene(o: SceneSpec): Scene {
  const s = emptyScene({ height: o.height ?? H, sub: SUB_CODE, k: 0 });
  for (const [k, v] of o.characters ?? []) s.characters.set(k, v);
  for (const [k, v] of o.pets ?? []) s.pets.set(k, v);
  for (const [k, v] of o.desks ?? []) s.desks.set(k, v);
  for (const [k, v] of o.claims ?? []) s.claims.set(k, v);
  for (const [k, v] of o.boxes ?? []) s.boxes.set(k, v);
  for (const [k, v] of o.bangs ?? []) s.bangs.set(k, v);
  s.beat = o.beat ?? [];
  s.badge = o.badge ?? 'none';
  s.branchMovedAt = o.branchMovedAt ?? null;
  return s;
}

/** The lobby alone (21 × 4 tiles). */
const L0 = emptyLayout();
/** Desks 1–10: src/viz a–g (cells 0 and its annex 1), docs/guide.md (2), README.md (3), test/t.ts (4); first heights 1, 11, …, 91. */
function layout1(): Layout {
  const b = new LayoutBuilder(emptyLayout());
  ['src/viz/a.ts', 'src/viz/b.ts', 'src/viz/c.ts', 'src/viz/d.ts', 'src/viz/e.ts', 'src/viz/f.ts', 'src/viz/g.ts', 'docs/guide.md', 'README.md', 'test/t.ts']
    .forEach((p, i) => b.desk(p, 1 + 10 * i));
  return b.layout();
}
const L1 = layout1();
/** 24 files in lib/: 23 file desks and the shelf desk (24) in the 24th slot. */
function layout2(): Layout {
  const b = new LayoutBuilder(emptyLayout());
  for (let i = 0; i < 24; i++) b.desk(`lib/f${String(i).padStart(2, '0')}.ts`, 1);
  return b.layout();
}
const L2 = layout2();

function actorPlace(s: Scene, key: string): Place {
  const c = key.startsWith('p:') ? s.characters.get(key.slice(2)) : s.pets.get(key.slice(2));
  assert.ok(c !== undefined, `no actor ${key}`);
  return c.place;
}
const STATIC0: StaticOptions = { dashedFrom: null, dimmed: new Set(), coarse: false, lockboxDesks: new Set() };

interface Fixture {
  name: string; layout: Layout; scene: Scene; looks: Array<[PeerRef, Look]>;
  static?: Partial<StaticOptions>; frames?: Record<string, FrameName>; left?: string[]; screens?: DeskRef[];
}
function phaseOf(fx: Pick<Fixture, 'layout' | 'scene' | 'frames' | 'left' | 'screens'>, reduced: boolean, tiles?: Record<string, Tile>): SpritePhase {
  return {
    reduced,
    frame: (a) => fx.frames?.[a] ?? 'idle0',
    tile: (a) => tiles?.[a] ?? placeTile(actorPlace(fx.scene, a), fx.layout, fx.scene),
    facingLeft: (a) => fx.left?.includes(a) ?? false,
    screen: (d) => (fx.screens?.includes(d) ? 'published' : 'idle'),
  };
}
const pk = (p: PeerRef): string => `p:${p}`;
const sk = (s: SeatRef): string => `s:${s}`;
const at3 = (sub: number, k = 0): [number, number, number] => [H, sub, k];

function fixtures(): Fixture[] {
  const looks16 = Array.from({ length: 16 }, (_, i): [PeerRef, Look] => [P(0x10 + i), { hue: i % 7, accessory: i % 8 }]);
  const o1 = P(0x1), o2 = P(0x2);
  return [
    { name: '01-coarse-office', layout: L1, scene: scene({}), looks: [], static: { coarse: true } },
    {
      // P5–P7 are relaxed (R-V64): the idle0 lean, the idle1 lean, and the idle1 lean facing left.
      name: '02-lobby', layout: L0,
      looks: [[P(1), { hue: 0, accessory: 0 }], [P(2), { hue: 2, accessory: 1 }], [P(3), { hue: 4, accessory: 2 }], [P(4), { hue: 6, accessory: 3 }],
        [P(5), { hue: 1, accessory: 0 }], [P(6), { hue: 3, accessory: 1 }], [P(7), { hue: 5, accessory: 7 }]],
      scene: scene({
        characters: [[P(1), ch(home(0))], [P(2), ch(home(1))], [P(3), ch(home(8))], [P(4), ch(home(17))],
          [P(5), ch(home(2), { pose: 'relaxed' })], [P(6), ch(home(3), { pose: 'relaxed' })], [P(7), ch(home(10), { pose: 'relaxed' })]],
      }),
      frames: { [pk(P(2))]: 'idle1', [pk(P(3))]: 'idle1', [pk(P(6))]: 'idle1', [pk(P(7))]: 'idle1' }, left: [pk(P(2)), pk(P(7))],
    },
    {
      name: '03-looks', layout: L0, looks: looks16,
      scene: scene({ characters: looks16.map(([p], i) => [p, ch(home(i))]) }),
      frames: Object.fromEntries(looks16.filter((_, i) => i % 2 === 1).map(([p]) => [pk(p), 'idle1'])),
    },
    {
      name: '04-ghost', layout: L0, looks: [[P(1), { hue: 1, accessory: 4 }], [P(2), { hue: 1, accessory: 4 }], [P(3), { hue: 3, accessory: 5 }]],
      scene: scene({ characters: [[P(1), ch(home(0), { ghost: true })], [P(2), ch(home(1))], [P(3), ch(home(2), { ghost: true, rules: true })]] }),
      frames: { [pk(P(2))]: 'idle1' },
    },
    {
      name: '05-frozen', layout: L0, looks: [[P(1), { hue: 2, accessory: 6 }], [P(2), { hue: 3, accessory: 7 }], [P(3), { hue: 4, accessory: 0 }], [P(4), { hue: 5, accessory: 1 }]],
      scene: scene({ characters: [[P(1), ch(home(0), { frozen: 'EPOCH' })], [P(2), ch(home(1), { frozen: 'PAUSED' })], [P(3), ch(home(2), { frozen: '?' })], [P(4), ch(home(3))]] }),
      frames: { [pk(P(1))]: 'idle1', [pk(P(2))]: 'idle1', [pk(P(3))]: 'idle1', [pk(P(4))]: 'idle1' },
    },
    {
      name: '06-slowed', layout: L0, looks: [[P(1), { hue: 6, accessory: 2 }], [P(2), { hue: 0, accessory: 3 }], [P(3), { hue: 1, accessory: 4 }]],
      scene: scene({ characters: [[P(1), ch(home(0), { slowedUntil: H + 50 })], [P(2), ch(home(1), { slowedUntil: H })], [P(3), ch(home(2))]] }),
    },
    {
      name: '07-absent', layout: L0, looks: [[P(1), { hue: 5, accessory: 5 }], [P(2), { hue: 2, accessory: 2 }]],
      scene: scene({ characters: [[P(1), ch(home(0), { absent: true })], [P(2), ch(home(1), { absent: true, frozen: 'EPOCH' })]] }),
      frames: { [pk(P(1))]: 'idle1', [pk(P(2))]: 'peak' },
    },
    {
      name: '08-badges', layout: L0,
      looks: [[P(1), { hue: 0, accessory: 6 }], [P(2), { hue: 1, accessory: 7 }], [P(3), { hue: 2, accessory: 0 }], [P(4), { hue: 3, accessory: 1 }], [P(5), { hue: 4, accessory: 2 }]],
      scene: scene({
        characters: [[P(1), ch(home(0), { rules: true })], [P(2), ch(home(1), { credit: true })], [P(3), ch(home(2), { rules: true, credit: true, slowedUntil: H + 1 })],
          [P(4), ch(home(3))], [P(5), ch(home(4))]],
        beat: [
          ev('person_badge', at3(1), { actor: { peer: P(4) }, badge: 'version', on: true, code: null }),
          ev('person_badge', at3(2), { actor: { peer: P(5) }, badge: 'health', on: true, code: 'HOST_THROTTLED' }),
          ev('person_badge', at3(3), { actor: { peer: P(1) }, badge: 'rules', on: false, code: null }),
        ],
      }),
    },
    {
      name: '09-pets', layout: L0, looks: [[o1, { hue: 1, accessory: 4 }], [o2, { hue: 5, accessory: 6 }]],
      scene: scene({
        characters: [[o1, ch(home(0))], [o2, ch(home(9))]],
        pets: [
          [SEAT(o1, 0), pet(o1, { at: 'behind', peer: o1 }, 0)], [SEAT(o1, 1), pet(o1, home(2), 1)], [SEAT(o1, 2), pet(o1, home(3), 2)],
          [SEAT(o1, 3), pet(o1, home(4), 3)], [SEAT(o1, 4), pet(o1, home(5), 4)], [SEAT(o1, 5), pet(o1, home(6), 5, { pose: 'relaxed' })],
          [SEAT(o2, 0), pet(o2, { at: 'behind', peer: o2 }, 12, { ssCode: 'SS_HOOKS_MISSING' })], [SEAT(o2, 1), pet(o2, chair(BIG_TABLE), 1, { live: false })],
        ],
        claims: [['c1', { seat: SEAT(o2, 1), desk: BIG_TABLE, order: 1, label: null, granularity: 'file', lines: null, stale: true, reservedFor: null, grantee: null, otherRules: false, at: { height: H - 1, sub: 1, k: 0 } }]],
        beat: [ev('pet_spawn', at3(1001), { seat: SEAT(o1, 1), owner: o1 })],
      }),
      frames: { [sk(SEAT(o1, 2))]: 'peak', [sk(SEAT(o1, 3))]: 'rise', [sk(SEAT(o1, 5))]: 'idle1' }, left: [sk(SEAT(o1, 4))],
    },
    {
      name: '10-desk-chair', layout: L1, looks: [[P(1), { hue: 2, accessory: 0 }], [P(2), { hue: 4, accessory: 1 }], [P(3), { hue: 6, accessory: 2 }]],
      scene: scene({
        characters: [[P(1), ch(chair(1), { pose: 'sit' })], [P(2), ch(visitor(1, 0))], [P(3), ch({ at: 'beside', desk: 3 })]],
        pets: [[SEAT(P(1), 0), pet(P(1), { at: 'stool', desk: 2 }, 0)]],
        desks: [[1, desk({ lastEvent: H, chair: { peer: P(1) }, visitors: [{ peer: P(2) }] })]],
        beat: [ev('publish', at3(1001), { actor: { peer: P(1) }, target: 1, others: [], paths: ['src/viz/a.ts'], n: 1, state: 'closed', checks: 'pass', origin: 'human' })],
      }),
      screens: [1], frames: { [pk(P(2))]: 'idle1' },
    },
    {
      name: '11-visitors-more', layout: L1, looks: Array.from({ length: 7 }, (_, i): [PeerRef, Look] => [P(i + 1), { hue: i % 7, accessory: (i * 3) % 8 }]),
      scene: scene({
        characters: [[P(1), ch(chair(2), { pose: 'sit' })], ...[0, 1, 2, 3, 4, 5].map((t): [PeerRef, CharacterState] => [P(t + 2), ch(visitor(2, t))])],
        desks: [[2, desk({ lastEvent: H, chair: { peer: P(1) }, visitors: [2, 3, 4, 5].map((n) => ({ peer: P(n) })), more: 2 })]],
      }),
    },
    {
      name: '12-big-table', layout: L1, looks: [[P(1), { hue: 3, accessory: 3 }], [P(2), { hue: 0, accessory: 4 }], [P(3), { hue: 6, accessory: 7 }]],
      scene: scene({
        characters: [[P(1), ch(chair(BIG_TABLE), { pose: 'sit' })], [P(2), ch(visitor(BIG_TABLE, 0))], [P(3), ch(visitor(BIG_TABLE, 3))]],
        desks: [[BIG_TABLE, desk({ lastEvent: H, chair: { peer: P(1) }, visitors: [{ peer: P(2) }, { peer: P(3) }], more: 1 })]],
        beat: [ev('publish', at3(1001), { actor: { peer: P(1) }, target: BIG_TABLE, others: [], paths: [], n: 300, state: 'closed', checks: 'pass', origin: 'human' })],
      }),
    },
    {
      name: '13-dashed', layout: L1, looks: [[P(1), { hue: 4, accessory: 5 }]],
      scene: scene({ height: 40, characters: [[P(1), ch(chair(1), { pose: 'sit' })]] }), static: { dashedFrom: 40 },
    },
    {
      name: '14-dimmed', layout: L1, looks: [[P(1), { hue: 5, accessory: 6 }]],
      scene: scene({ characters: [[P(1), ch(visitor(2, 1))]] }), static: { dimmed: new Set([BIG_TABLE, 2, 4]) },
    },
    {
      name: '15-walk', layout: L0,
      looks: [[P(1), { hue: 0, accessory: 0 }], [P(2), { hue: 1, accessory: 5 }], [P(3), { hue: 2, accessory: 2 }], [P(4), { hue: 3, accessory: 3 }], [P(5), { hue: 4, accessory: 5 }]],
      scene: scene({ characters: [1, 2, 3, 4, 5].map((n): [PeerRef, CharacterState] => [P(n), ch(home(n - 1))]) }),
      frames: { [pk(P(1))]: 'squash', [pk(P(2))]: 'rise', [pk(P(3))]: 'peak', [pk(P(4))]: 'land', [pk(P(5))]: 'squash' }, left: [pk(P(2)), pk(P(4))],
    },
    {
      name: '16-publish-planes', layout: L1, looks: [[P(1), { hue: 1, accessory: 1 }]],
      scene: scene({
        characters: [[P(1), ch(chair(1), { pose: 'sit' })]],
        pets: [[SEAT(P(1), 0), pet(P(1), chair(7), 1, { pose: 'sit' })]],
        beat: [
          ev('publish', at3(1001, 0), { actor: { peer: P(1) }, target: 1, others: [2, 3, 4, 5, 6], paths: [], n: 6, state: 'checkpoint', checks: 'fail', origin: 'human' }),
          ev('publish', at3(1001, 1), { actor: { seat: SEAT(P(1), 0) }, target: 7, others: [], paths: [], n: 1, state: 'closed', checks: 'skipped', origin: 'wake' }),
        ],
      }),
      screens: [1, 7],
    },
    {
      name: '17-conflicts', layout: L1, looks: [[P(1), { hue: 2, accessory: 3 }], [P(2), { hue: 3, accessory: 4 }], [P(3), { hue: 4, accessory: 5 }]],
      scene: scene({
        characters: [[P(1), ch(home(0))], [P(2), ch(home(1))], [P(3), ch(chair(2), { pose: 'sit' })]],
        bangs: [['H0000001', { on: { peer: P(3) }, desk: 2 }]],
        beat: [
          ev('conflict', at3(1), { conflict: 'generic', source: 'event', on: { peer: P(1) }, desk: null, holdId: null, cid: 'C0000001', eventKind: 'K1', line: null }),
          ev('person_bang', at3(2), { peer: P(2), bang: 'host' }),
        ],
      }),
    },
    {
      name: '18-boxes', layout: L1, looks: [[P(1), { hue: 5, accessory: 0 }]],
      scene: scene({
        characters: [[P(1), ch(home(0))]],
        boxes: [
          ['H1', { owner: { peer: P(1) }, desk: 1, holdKind: 'PIN', residence: 'ON_DISK', state: 'HELD', localOnly: false }],
          ['H2', { owner: { peer: P(1) }, desk: 2, holdKind: 'PIN', residence: 'INCOMING', state: 'HELD', localOnly: false }],
          ['H3', { owner: { peer: P(1) }, desk: BIG_TABLE, holdKind: 'PIN', residence: 'ON_DISK', state: 'HELD', localOnly: true }],
          ['H4', { owner: { peer: P(1) }, desk: 3, holdKind: 'PIN', residence: 'ON_DISK', state: 'HELD', localOnly: true }],
          ['H5', { owner: { peer: P(1) }, desk: 1, holdKind: 'PIN', residence: 'OFF_DISK', state: 'HELD', localOnly: false }],
          ['H6', { owner: { peer: P(1) }, desk: 99, holdKind: 'PIN', residence: 'ON_DISK', state: 'HELD', localOnly: false }],
          // Desk 4: a PARKED box and four more, so three boxes and the "+n" chip are drawn.
          ['H7', { owner: { peer: P(1) }, desk: 4, holdKind: 'PIN', residence: 'PARKED', state: 'HELD', localOnly: false }],
          ...['H8', 'H9', 'HA', 'HB'].map((k): [string, Box] => [k, { owner: { peer: P(1) }, desk: 4, holdKind: 'PIN', residence: 'ON_DISK', state: 'HELD', localOnly: false }]),
        ],
      }),
      static: { lockboxDesks: new Set([3]) },
    },
    {
      name: '19-conversation', layout: L1, looks: Array.from({ length: 9 }, (_, i): [PeerRef, Look] => [P(i + 1), { hue: (i * 2) % 7, accessory: i % 8 }]),
      scene: scene({
        characters: [
          ...[1, 2, 3, 4].map((n): [PeerRef, CharacterState] => [P(n), ch(chair(n), { pose: 'sit' })]),
          ...[5, 6, 7, 8, 9].map((n): [PeerRef, CharacterState] => [P(n), ch(home(n - 5))]),
        ],
        badge: 'near_full',
        beat: [
          ev('request_status', at3(1), { request: 'R00000001', holder: { peer: P(1) }, status: 'queued_until_turn_end' }),
          ev('request_status', at3(2), { request: 'R00000002', holder: { peer: P(2) }, status: 'asked' }),
          ev('request_status', at3(3), { request: 'R00000003', holder: { peer: P(3) }, status: 'awaiting_human' }),
          ev('request_status', at3(4), { request: 'R00000004', holder: { peer: P(4) }, status: 'undeliverable' }),
          ev('request_status', at3(5), { request: 'R00000005', holder: { peer: P(5) }, status: 'returned' }),
          ev('answer', at3(6), { request: 'R00000005', holder: { peer: P(5) }, verb: 'accept', by: 'claude', note: null }),
          ev('answer', at3(7), { request: 'R00000006', holder: { peer: P(6) }, verb: 'decline', by: 'human', note: null }),
          ev('answer', at3(8), { request: 'R00000007', holder: { peer: P(7) }, verb: 'later', by: 'claude', note: null }),
          ev('answer', at3(9), { request: 'R00000008', holder: { peer: P(8) }, verb: 'grant', by: 'daemon', note: null }),
          ev('request_open', at3(10), { request: 'R00000009', from: { peer: P(9) }, holder: { peer: P(1) }, desk: 1, requestKind: 'handoff', estMinutes: null, attempt: 1, note: null }),
          ev('save', at3(11), { peer: P(1), desks: [1, 2] }),
        ],
      }),
    },
    {
      name: '20-shelf-and-room-signs', layout: L2, looks: [[P(1), { hue: 6, accessory: 6 }]],
      scene: scene({ characters: [[P(1), ch(chair(24), { pose: 'sit' })]], badge: 'full', branchMovedAt: H - 10 }),
      screens: [1],
    },
  ];
}

function hashOf(r: Rgba): string {
  const head = new Uint8Array(8);
  new DataView(head.buffer).setUint32(0, r.w);
  new DataView(head.buffer).setUint32(4, r.h);
  return createHash('sha256').update(head).update(r.data).digest('hex');
}

test('T-VIZ-frames: the static and sprite layers of 20 fixture scenes, normal and reduced motion, hash to test/golden/viz/frames.json', () => {
  const fxs = fixtures();
  assert.equal(fxs.length, 20);
  assert.equal(new Set(fxs.map((f) => f.name)).size, 20);
  const got: Record<string, { static: string; normal: string; reduced: string }> = {};
  for (const fx of fxs) {
    const { w, h } = officeTiles(fx.layout);
    const looks = new Map(fx.looks);
    const st = composeStatic(fx.layout, { ...STATIC0, ...fx.static });
    const normal = composeSprites(fx.scene, fx.layout, looks, phaseOf(fx, false));
    const reduced = composeSprites(fx.scene, fx.layout, looks, phaseOf(fx, true));
    for (const r of [st, normal, reduced]) assert.deepEqual([r.w, r.h, r.data.length], [w * 16, h * 16, w * h * 256 * 4], fx.name);
    if (fx.scene.characters.size > 0) assert.ok(normal.data.some((v, i) => i % 4 === 3 && v > 0), `${fx.name}: sprites drawn`);
    got[fx.name] = { static: hashOf(st), normal: hashOf(normal), reduced: hashOf(reduced) };
  }
  // Reduced motion draws different art where something moves (bob, hop, sparkle, planes, exclaim), the same where nothing does.
  for (const n of ['02-lobby', '03-looks', '05-frozen', '09-pets', '10-desk-chair', '12-big-table', '15-walk', '16-publish-planes', '17-conflicts', '19-conversation']) {
    assert.notEqual(got[n]!.normal, got[n]!.reduced, `${n}: reduced motion changes nothing`);
  }
  for (const n of ['06-slowed', '18-boxes', '20-shelf-and-room-signs']) assert.equal(got[n]!.normal, got[n]!.reduced, `${n}: nothing moves`);
  // The relaxed actors of 02-lobby and 09-pets draw their own form: the same scenes with every pose idle hash differently.
  for (const fx of fxs.filter((f) => f.name === '02-lobby' || f.name === '09-pets')) {
    const idled = scene({});
    Object.assign(idled, fx.scene, {
      characters: new Map([...fx.scene.characters].map(([k, v]) => [k, { ...v, pose: v.pose === 'relaxed' ? 'idle' : v.pose }])),
      pets: new Map([...fx.scene.pets].map(([k, v]) => [k, { ...v, pose: v.pose === 'relaxed' ? 'idle' : v.pose }])),
    });
    const looks = new Map(fx.looks);
    for (const reduced of [false, true]) {
      const h = hashOf(composeSprites(idled, fx.layout, looks, phaseOf({ ...fx, scene: idled }, reduced)));
      assert.notEqual(h, got[fx.name]![reduced ? 'reduced' : 'normal'], `${fx.name}: the relaxed form differs from idle (reduced ${reduced})`);
    }
  }
  // Static layers differ by their options: coarse, dashed, dimmed, lockbox, shelf.
  const st = (n: string): string => got[n]!.static;
  assert.equal(st('10-desk-chair'), st('11-visitors-more'));
  for (const n of ['01-coarse-office', '13-dashed', '14-dimmed', '18-boxes', '20-shelf-and-room-signs']) assert.notEqual(st(n), st('10-desk-chair'), n);
  const sorted = Object.fromEntries(Object.keys(got).sort().map((k) => [k, got[k]!]));
  const text = `${JSON.stringify(sorted, null, 2)}\n`;
  if (process.env['COWORK_VIZ_GOLDEN_UPDATE'] === '1') {
    writeFileSync(GOLDEN, text, 'utf8');
    return;
  }
  assert.ok(existsSync(GOLDEN), `${GOLDEN} is missing: run with COWORK_VIZ_GOLDEN_UPDATE=1 once and review the art`);
  const bytes = readFileSync(GOLDEN);
  assert.ok(!bytes.includes(0x0d) && !(bytes[0] === 0xef && bytes[1] === 0xbb), 'frames.json is LF, UTF-8 without BOM');
  assert.deepEqual(JSON.parse(bytes.toString('utf8')), sorted);
});

/** The colour of an art pixel, or null when transparent. */
function px(r: Rgba, x: number, y: number): Rgb | null {
  const i = (y * r.w + x) * 4;
  return r.data[i + 3] === 0 ? null : [r.data[i]!, r.data[i + 1]!, r.data[i + 2]!];
}
function opaquePixels(r: Rgba): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) if (r.data[(y * r.w + x) * 4 + 3] !== 0) out.push([x, y]);
  return out;
}

test('composeSprites z-sorts by foot y, then actor key, and never reads outside the office', () => {
  const A = P(0xa), B = P(0xb);                                                       // actorKey(A) < actorKey(B)
  // One tile: the greater actor key is drawn last, whatever the Map order or the hues.
  for (const [hueA, hueB] of [[0, 5], [5, 0]] as const) {
    const s = scene({ characters: [[B, ch(home(5))], [A, ch(home(5))]] });
    const looks = new Map<string, Look>([[A, { hue: hueA, accessory: 7 }], [B, { hue: hueB, accessory: 7 }]]);
    const r = composeSprites(s, L0, looks, phaseOf({ layout: L0, scene: s }, false));
    assert.deepEqual(px(r, 12 * 16 + 8, 16 + 10), PALETTE.bodies[hueB], 'the body of B on top');
  }
  // A lower foot is drawn later even with the smaller key: A one tile below B, hopping up 3 pixels into B's feet.
  {
    const s = scene({ characters: [[A, ch(home(13))], [B, ch(home(5))]] });
    const looks = new Map<string, Look>([[A, { hue: 0, accessory: 7 }], [B, { hue: 5, accessory: 7 }]]);
    const r = composeSprites(s, L0, looks, phaseOf({ layout: L0, scene: s, frames: { [pk(A)]: 'peak' } }, false));
    assert.deepEqual(px(r, 12 * 16 + 5, 30), PALETTE.characters[0]![7]!.outline, 'A\u{2019}s head over B\u{2019}s feet');
    assert.deepEqual(px(r, 12 * 16 + 4, 30), PALETTE.characters[5]![7]!.outline, 'B\u{2019}s foot where A has no pixel');
  }
  // Clipped at every edge: a sprite and its badges past the right edge never wrap into the next row's left edge, a sprite
  // left of or above the office never wraps into the previous row, and a buffer is exactly the office.
  {
    const s = scene({
      characters: [[A, ch(home(0), { rules: true, credit: true, frozen: 'EPOCH' })]],
      pets: [[SEAT(A, 0), pet(A, home(1), 12)]],
    });
    const looks = new Map<string, Look>([[A, { hue: 3, accessory: 2 }]]);
    const r = composeSprites(s, L0, looks, phaseOf({ layout: L0, scene: s }, false, { [pk(A)]: { x: 20, y: 3 }, [sk(SEAT(A, 0))]: { x: 20, y: 0 } }));
    assert.deepEqual([r.w, r.h, r.data.length], [336, 64, 336 * 64 * 4]);
    const pts = opaquePixels(r);
    assert.ok(pts.length > 0);
    for (const [x, y] of pts) assert.ok(x >= 20 * 16 - 16 && y < 64, `pixel (${x}, ${y}) wrapped`);
  }
  {
    const s = scene({ characters: [[A, ch(home(0), { rules: true, credit: true })], [B, ch(home(1))], [P(0xc), ch(home(2))], [P(0xd), ch(home(3))]] });
    const tiles = { [pk(A)]: { x: -1, y: 1 }, [pk(B)]: { x: 0, y: -1 }, [pk(P(0xc))]: { x: 21, y: 2 }, [pk(P(0xd))]: { x: 5, y: 4 } };
    const r = composeSprites(s, L0, new Map(), phaseOf({ layout: L0, scene: s }, false, tiles));
    const pts = opaquePixels(r);
    assert.ok(pts.length > 0, 'the badges of the actor left of the office show at its left edge');
    for (const [x, y] of pts) assert.ok(x < 8 && y >= 8 && y < 16, `pixel (${x}, ${y}) wrapped`);
  }
  // Desk references outside the layout (a box, a "+n" chip, publish and save targets) draw nothing and throw nothing.
  {
    const s = scene({
      desks: [[42, desk({ more: 3 })]],
      boxes: [['H9', { owner: { peer: A }, desk: 99, holdKind: 'PIN', residence: 'INCOMING', state: 'HELD', localOnly: false }]],
      bangs: [['H8', { on: { peer: A }, desk: 77 }]],
      beat: [
        ev('publish', at3(1001), { actor: { peer: A }, target: 77, others: [88, -1, 1.5], paths: [], n: 1, state: 'closed', checks: 'pass', origin: 'human' }),
        ev('save', at3(1002), { peer: A, desks: [66] }),
      ],
    });
    const r = composeSprites(s, L0, new Map(), phaseOf({ layout: L0, scene: s, screens: [55] }, false));
    assert.deepEqual(opaquePixels(r), []);
  }
});

test('composeSprites draws no sprite for a poofed pet (live: false), wherever its place says it stands', () => {
  const A = P(0xa), seat = SEAT(A, 0);
  const looks = new Map<string, Look>([[A, { hue: 2, accessory: 3 }]]);
  const draw = (s: Scene): Rgba => composeSprites(s, L0, looks, phaseOf({ layout: L0, scene: s }, false));
  const owner: Array<[PeerRef, CharacterState]> = [[A, ch(home(0))]];
  const alone = draw(scene({ characters: owner }));
  for (const place of [{ at: 'behind', peer: A } as Place, home(5), chair(BIG_TABLE)]) {
    const live = draw(scene({ characters: owner, pets: [[seat, pet(A, place, 2, { ssCode: 'SS_NO_HOOKS' })]] }));
    const poofed = draw(scene({ characters: owner, pets: [[seat, pet(A, place, 2, { live: false, ssCode: 'SS_NO_HOOKS' })]] }));
    assert.notDeepEqual(live.data, alone.data, `${place.at}: a live pet is drawn`);
    assert.deepEqual(poofed.data, alone.data, `${place.at}: a poofed pet is not`);
  }
});

test('placeTile: home spots, chair, visitor tiles, facing a chair, behind (below, else above when blocked or outside)', () => {
  const s = scene({});
  const t = (p: Place, l: Layout = L1, sc: Scene = s): Tile => placeTile(p, l, sc);
  // Home spots 0–15 in two rows of eight, two tiles apart; beyond 16 the door cluster, round-robin.
  assert.deepEqual([0, 7, 8, 9, 15].map((i) => t(home(i))), [{ x: 2, y: 1 }, { x: 16, y: 1 }, { x: 2, y: 2 }, { x: 4, y: 2 }, { x: 16, y: 2 }]);
  assert.deepEqual([16, 17, 18, 19, 20, 21].map((i) => t(home(i))), [{ x: 0, y: 1 }, { x: 0, y: 2 }, { x: 0, y: 3 }, { x: 1, y: 2 }, { x: 1, y: 3 }, { x: 0, y: 1 }]);
  // Desk 1 is slot 0 of cell 0: desk (0, 5)–(1, 5), chair (0, 6), visitors (1, 6), (2, 6), (0, 7), (1, 7).
  assert.deepEqual(deskTiles(L1, 1).desk, [{ x: 0, y: 5 }, { x: 1, y: 5 }]);
  assert.deepEqual(t(chair(1)), { x: 0, y: 6 });
  assert.deepEqual(t(chair(BIG_TABLE)), { x: 18, y: 3 });
  assert.deepEqual([0, 1, 2, 3].map((i) => t(visitor(1, i))), [{ x: 1, y: 6 }, { x: 2, y: 6 }, { x: 0, y: 7 }, { x: 1, y: 7 }]);
  assert.deepEqual(t(visitor(1, 4)), { x: 1, y: 7 }, 'a fifth visitor stands on the last tile (counted in "+n", not drawn)');
  assert.deepEqual([0, 1, 2, 3].map((i) => t(visitor(BIG_TABLE, i))), [{ x: 16, y: 3 }, { x: 17, y: 3 }, { x: 19, y: 3 }, { x: 20, y: 3 }]);
  // A stool beside the chair; a supervising character on the first visitor tile no visitor takes.
  assert.deepEqual(t({ at: 'stool', desk: 1 }), { x: 1, y: 6 });
  assert.deepEqual(t({ at: 'beside', desk: 1 }), { x: 1, y: 6 });
  const busy = scene({ desks: [[1, desk({ visitors: [{ peer: P(1) }, { peer: P(2) }] })]] });
  assert.deepEqual(t({ at: 'beside', desk: 1 }, L1, busy), { x: 0, y: 7 });
  // Facing a chair: the tile in front of it (below), else the first free of left, right, above.
  assert.deepEqual(t({ at: 'facing', actor: { peer: P(1) }, desk: 1 }), { x: 0, y: 7 });
  assert.deepEqual(t({ at: 'facing', actor: { peer: P(1) }, desk: BIG_TABLE }, L0), { x: 17, y: 3 }, 'below the big table\u{2019}s chair is outside a lobby-only office');
  assert.deepEqual(t({ at: 'facing', actor: { peer: P(1) }, desk: BIG_TABLE }, L1), { x: 18, y: 4 });
  // Behind: one tile below the character, else above when the tile below is blocked or outside; no character: the door.
  const owner = P(7);
  const behind: Place = { at: 'behind', peer: owner };
  const withOwner = (p: Place): Scene => scene({ characters: [[owner, ch(p)]] });
  assert.deepEqual(t(behind, L1, withOwner(home(0))), { x: 2, y: 2 });
  assert.deepEqual(t(behind, L1, withOwner(visitor(1, 2))), { x: 0, y: 6 }, 'below (0, 8) is desk 3: blocked');
  assert.deepEqual(t(behind, L0, withOwner(visitor(BIG_TABLE, 0))), { x: 16, y: 2 }, 'below (16, 4) is outside the lobby-only office');
  assert.deepEqual(t(behind, L1, withOwner(visitor(BIG_TABLE, 0))), { x: 16, y: 4 });
  assert.deepEqual(t(behind, L0, withOwner(chair(BIG_TABLE))), { x: 18, y: 3 }, 'outside below and the table above: its own tile');
  assert.deepEqual(t(behind, L1, s), { x: 1, y: 0 }, 'no character: the door');
});

test('placeTile is total: a desk the layout does not have (or no desk ordinal at all) places the actor at the door', () => {
  const s = scene({});
  const door = { x: 1, y: 0 };
  for (const d of [10 + 1, 99, -1, 1.5, Number.NaN]) {
    for (const p of [chair(d), visitor(d, 0), visitor(d, 6), { at: 'stool', desk: d }, { at: 'beside', desk: d }, { at: 'facing', actor: { peer: P(1) }, desk: d }] as Place[]) {
      assert.deepEqual(placeTile(p, L1, s), door, `${JSON.stringify(p)} on L1`);
      assert.deepEqual(placeTile(p, L0, s), door, `${JSON.stringify(p)} on the lobby alone`);
    }
  }
  // A pet behind a character who stands at an unknown desk: one tile below the door.
  const owner = P(7);
  const sc = scene({ characters: [[owner, ch(chair(42))]] });
  assert.deepEqual(placeTile({ at: 'behind', peer: owner }, L1, sc), { x: 1, y: 1 });
  // Desk 10 exists in L1 (README.md is 9, test/t.ts is 10): the guard does not move a real desk.
  assert.deepEqual(placeTile(chair(10), L1, s), deskTiles(L1, 10).chair);
});

type Box = { owner: ActorRef; desk: DeskRef; holdKind: string; residence: string; state: string; localOnly: boolean };
const box = (d: DeskRef, residence = 'ON_DISK', localOnly = false): Box => ({ owner: { peer: P(1) }, desk: d, holdKind: 'PIN', residence, state: 'HELD', localOnly });
/** The sprite layer of a scene that holds only boxes. */
function boxesLayer(bs: Array<[string, Box]>, l: Layout = L1): Rgba {
  const s = scene({ boxes: bs });
  return composeSprites(s, l, new Map(), phaseOf({ layout: l, scene: s }, false));
}
/** The pixels of r in [x0, x1) × [y0, y1) as one array (RGBA). */
function region(r: Rgba, x0: number, y0: number, x1: number, y1: number): number[] {
  const out: number[] = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) for (let k = 0; k < 4; k++) out.push(r.data[(y * r.w + x) * 4 + k]!);
  return out;
}

test('the box row on a desk is capped at three boxes, then a "+n" chip in the fourth slot (its number is page text); nothing spills further', () => {
  // Desk 1's box row: slots 9 px apart from (1, 77); the slot desk spans x 0–31 and its slot x 0–47 (the next slot starts at 48).
  const keys = (n: number): Array<[string, Box]> => Array.from({ length: n }, (_, i) => [`H${i + 1}`, box(1)]);
  const three = boxesLayer(keys(3)), four = boxesLayer(keys(4)), five = boxesLayer(keys(5)), many = boxesLayer(keys(9));
  const chip = rgba(three.w, three.h);
  blit(chip, ICONS.more, iconColour('more'), 1 + 3 * 9, 77);
  for (const r of [four, five, many]) {
    assert.deepEqual(region(r, 0, 70, 28, 90), region(three, 0, 70, 28, 90), 'the first three boxes as drawn alone');
    assert.deepEqual(region(r, 28, 70, 37, 90), region(chip, 28, 70, 37, 90), 'the "+n" chip in the fourth slot');
    assert.ok(region(r, 37, 0, r.w, r.h).every((v) => v === 0) && region(r, 0, 90, 37, r.h).every((v) => v === 0), 'nothing beyond the chip');
  }
  assert.ok(region(three, 28, 0, three.w, three.h).every((v) => v === 0), 'three boxes: no chip');
  // The big table: the same cap, from (17·16 + 4, 16 + 4).
  const big = (n: number): Rgba => boxesLayer(Array.from({ length: n }, (_, i): [string, Box] => [`B${i}`, box(BIG_TABLE)]));
  const bigChip = rgba(three.w, three.h);
  blit(bigChip, ICONS.more, iconColour('more'), 17 * 16 + 4 + 3 * 9, 20);
  const b6 = big(6);
  assert.deepEqual(region(b6, 17 * 16, 0, 17 * 16 + 4 + 27, 64), region(big(3), 17 * 16, 0, 17 * 16 + 4 + 27, 64));
  assert.deepEqual(region(b6, 17 * 16 + 4 + 27, 0, b6.w, 64), region(bigChip, 17 * 16 + 4 + 27, 0, b6.w, 64));
});

test('OFF_DISK and PARKED boxes are drawn as an outlined (hollow) parcel, distinct from an ON_DISK box; lockbox and cart keep their forms', () => {
  const on = boxesLayer([['H1', box(1, 'ON_DISK')]]);
  const off = boxesLayer([['H1', box(1, 'OFF_DISK')]]);
  const parked = boxesLayer([['H1', box(1, 'PARKED')]]);
  assert.notDeepEqual(off.data, on.data);
  assert.deepEqual(parked.data, off.data, 'PARKED and OFF_DISK share the form');
  // The parcel's top-left is (1, 77): its edge (row 1, column 0) is drawn in both forms, its inside (row 2, column 1) only on disk.
  assert.notEqual(px(on, 1, 78), null);
  assert.deepEqual(px(off, 1, 78), px(on, 1, 78));
  assert.notEqual(px(on, 2, 79), null);
  assert.equal(px(off, 2, 79), null, 'hollow inside');
  // The outlined form is the parcel's own edge pixels: every opaque pixel of it is a pixel of the full parcel, in the same tone.
  const offPts = opaquePixels(off);
  assert.ok(offPts.length > 0 && offPts.length < opaquePixels(on).length);
  for (const [x, y] of offPts) assert.deepEqual(px(off, x, y), px(on, x, y));
  // A local_only stub stays a lockbox and an INCOMING record a cart, whatever its residence word.
  assert.deepEqual(boxesLayer([['H1', box(1, 'OFF_DISK', true)]]).data, boxesLayer([['H1', box(1, 'ON_DISK', true)]]).data);
  assert.notDeepEqual(boxesLayer([['H1', box(1, 'INCOMING')]]).data, off.data);
});

/** The opaque mask of row y of r, as a string of '#' and '.'. */
function maskRow(r: Rgba, y: number, x0: number, x1: number): string {
  let s = '';
  for (let x = x0; x < x1; x++) s += r.data[(y * r.w + x) * 4 + 3] === 0 ? '.' : '#';
  return s;
}

test('relaxed pose (R-V64): a leaning, reading form drawn from the pose \u{2014} never the idle form, static in reduced motion, alternating on idle0/idle1, eyes open', () => {
  const A = P(0xa), seat = SEAT(A, 0);
  const looks = new Map<string, Look>([[A, { hue: 2, accessory: 0 }]]);   // a beanie (rows 0–2): it leans with the head
  // The character alone at home spot 5, tile (12, 1): drawn from (192, 16).
  const person = (pose: CharacterState['pose'], frame: FrameName, reduced: boolean, o: Partial<CharacterState> = {}, left = false): Rgba => {
    const s = scene({ characters: [[A, ch(home(5), { pose, ...o })]] });
    return composeSprites(s, L0, looks, phaseOf({ layout: L0, scene: s, frames: { [pk(A)]: frame }, left: left ? [pk(A)] : [] }, reduced));
  };
  for (const reduced of [false, true]) {
    for (const f of ['idle0', 'idle1'] as const) assert.notDeepEqual(person('relaxed', f, reduced).data, person('idle', f, reduced).data, `${f}, reduced ${reduced}`);
  }
  assert.deepEqual(person('relaxed', 'idle1', true).data, person('relaxed', 'idle0', true).data, 'reduced motion: one static pose');
  assert.deepEqual(person('relaxed', 'idle0', true).data, person('relaxed', 'idle0', false).data, 'the static pose is the idle0 lean');
  assert.notDeepEqual(person('relaxed', 'idle0', false).data, person('relaxed', 'idle1', false).data, 'normal motion: the lean alternates');
  // The lean: the head rows (0\u{2013}8) move 1 px (right on idle0, left on idle1, mirrored when facing left), with no bob; the feet stay.
  const idle = person('idle', 'idle0', false);
  const shifted = (r: Rgba, y: number, dx: number): string => maskRow(r, y, 192 - dx - 2, 192 - dx + 18);
  for (const [f, dx] of [['idle0', 1], ['idle1', -1]] as const) {
    const r = person('relaxed', f, false);
    for (const row of [0, 1, 3, 5, 8]) assert.equal(maskRow(r, 16 + row, 190, 210), shifted(idle, 16 + row, dx), `${f}: row ${row} leans ${dx}`);
    for (const row of [13, 14]) assert.equal(maskRow(r, 16 + row, 190, 210), maskRow(idle, 16 + row, 190, 210), `${f}: row ${row} stays`);
    const mirrored = person('relaxed', f, false, {}, true);
    assert.equal(maskRow(mirrored, 16 + 5, 190, 210), shifted(person('idle', 'idle0', false, {}, true), 16 + 5, -dx), `${f}, facing left: mirrored`);
  }
  // Reading: a book over rows 9\u{2013}11 in the accessory tones (the mouth behind it), the eyes open and looking down at it:
  // row 6 all eye white, row 7 all pupil (never closed, never "zzz").
  const relaxed = person('relaxed', 'idle0', false);
  const count = (r: Rgba, y: number, c: Rgb): number => Array.from({ length: 20 }, (_, i) => px(r, 190 + i, y)).filter((v) => v !== null && v.join() === c.join()).length;
  const coverTone = PALETTE.characters[2]![0]!.accessory[0];
  for (const row of [9, 10, 11]) assert.ok(count(relaxed, 16 + row, coverTone) >= 6 && count(idle, 16 + row, coverTone) === 0, `book row ${row}`);
  assert.equal(count(relaxed, 16 + 9, FIXED.pupil), 0, 'the mouth is behind the book');
  assert.deepEqual([count(idle, 16 + 6, FIXED.eyeWhite), count(idle, 16 + 6, FIXED.pupil)], [2, 2], 'idle eyes: white and pupil side by side');
  assert.deepEqual([count(relaxed, 16 + 6, FIXED.eyeWhite), count(relaxed, 16 + 6, FIXED.pupil)], [4, 0], 'relaxed row 6: white');
  assert.deepEqual([count(relaxed, 16 + 7, FIXED.eyeWhite), count(relaxed, 16 + 7, FIXED.pupil)], [0, 4], 'relaxed row 7: pupils (looking down)');
  // Absent wins (eyes closed, zzz); a walk frame wins in normal motion; frozen keeps the static lean under the ice.
  assert.deepEqual(person('relaxed', 'idle0', false, { absent: true }).data, person('idle', 'idle0', false, { absent: true }).data);
  assert.deepEqual(person('relaxed', 'peak', false).data, person('idle', 'peak', false).data);
  assert.notDeepEqual(person('relaxed', 'idle1', false, { frozen: 'EPOCH' }).data, person('idle', 'idle1', false, { frozen: 'EPOCH' }).data);
  // A relaxed pet leans too: different from idle in both frames and motion modes, static in reduced motion.
  const critter = (pose: PetState['pose'], frame: FrameName, reduced: boolean): Rgba => {
    const s = scene({ pets: [[seat, pet(A, home(5), 2, { pose })]] });
    return composeSprites(s, L0, looks, phaseOf({ layout: L0, scene: s, frames: { [sk(seat)]: frame } }, reduced));
  };
  for (const reduced of [false, true]) {
    for (const f of ['idle0', 'idle1'] as const) assert.notDeepEqual(critter('relaxed', f, reduced).data, critter('idle', f, reduced).data, `pet ${f}, reduced ${reduced}`);
  }
  assert.deepEqual(critter('relaxed', 'idle1', true).data, critter('relaxed', 'idle0', true).data);
  assert.notDeepEqual(critter('relaxed', 'idle0', false).data, critter('relaxed', 'idle1', false).data);
});

test('every seat-variant mark tone actually drawn has \u{394}E \u{2265} 15 against both floor tones, for every look and variant', () => {
  const dE = (x: Rgb, y: Rgb): number => deltaE2000(srgbToLab(x), srgbToLab(y));
  // A pet alone at home spot 5, tile (12, 1): it is drawn from (196, 24), so its mark is every opaque pixel above row 24.
  const owner = P(1), seat = SEAT(owner, 0);
  let checked = 0;
  for (let hue = 0; hue < 7; hue++) {
    for (let acc = 0; acc < 8; acc++) {
      for (const variant of [1, 2, 3, 4, 12]) {
        const s = scene({ pets: [[seat, pet(owner, home(5), variant)]] });
        const r = composeSprites(s, L0, new Map([[owner, { hue, accessory: acc }]]), phaseOf({ layout: L0, scene: s }, false));
        const mark = opaquePixels(r).filter(([, y]) => y < 24);
        assert.ok(mark.length > 0, `variant ${variant}: a mark is drawn`);
        for (const [x, y] of mark) {
          const c = px(r, x, y)!;
          for (const fl of [ENV.floorA, ENV.floorB]) {
            assert.ok(dE(c, fl) >= 15, `hue ${hue}, accessory ${acc}, variant ${variant}: rgb(${c.join(', ')}) at (${x}, ${y}) is \u{394}E ${dE(c, fl).toFixed(1)} from the floor`);
          }
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 7 * 8 * 5);
});

test('composeStatic draws the floor checker, the lobby wall and door, zone signs, desks with monitors, chairs and plaques, and the big table; a dashed desk is an outline, a dimmed desk darker', () => {
  const r = composeStatic(L1, STATIC0);
  assert.deepEqual([r.w, r.h], [336, 24 * 16]);
  assert.deepEqual(px(r, 16 + 3, 16 + 3), ENV.floorA);                                 // tile (1, 1): (x + y) even
  assert.deepEqual(px(r, 3, 16 + 3), ENV.floorB);                                      // tile (0, 1)
  assert.deepEqual(px(r, 3 * 16 + 5, 5), ENV.wall);                                    // the lobby wall, row 0
  assert.deepEqual(px(r, 16 + 8, 8), ENV.deskA);                                       // the door (1, 0)
  assert.deepEqual(px(r, 17 * 16 + 8, 16 + 8), ENV.deskB);                             // the big table (17–20, 1–2)
  assert.deepEqual(px(r, 18 * 16 + 8, 3 * 16 + 5), ENV.deskB);                         // its chair (18, 3)
  assert.deepEqual(px(r, 2 * 16, 4 * 16 + 5), ENV.monitor);                            // the zone sign over cell 0's row 0
  // Desk 1: top surface, front, monitor screen overhanging the top edge, plaque plate on the front, chair below.
  assert.deepEqual(px(r, 0 * 16 + 1, 5 * 16 + 1), ENV.deskB);
  assert.deepEqual(px(r, 0 * 16 + 2, 5 * 16 + 5), ENV.deskA);
  assert.deepEqual(px(r, 0 * 16 + 12, 5 * 16 - 3), ENV.screenIdle);
  assert.deepEqual(px(r, 0 * 16 + 12, 5 * 16 + 8), ENV.monitor);
  assert.deepEqual(px(r, 0 * 16 + 8, 6 * 16 + 5), ENV.deskB);
  // Dashed: desks first touched after the scene height are a dashed outline only (no monitor, plaque or chair).
  const dashed = composeStatic(L1, { ...STATIC0, dashedFrom: 0 });
  assert.deepEqual(px(dashed, 0, 5 * 16), ENV.deskB);
  assert.deepEqual(px(dashed, 2, 5 * 16), ENV.floorB);                                 // the gap of the dash
  assert.deepEqual(px(dashed, 0 * 16 + 8, 5 * 16 + 8), ENV.floorB);                    // inside: floor
  assert.deepEqual(px(dashed, 0 * 16 + 12, 5 * 16 - 3), ENV.floorA);                   // no monitor over the sign row's margin
  assert.deepEqual(px(dashed, 0 * 16 + 8, 6 * 16 + 5), ENV.floorA);                    // no chair at (0, 6)
  assert.deepEqual(px(composeStatic(L1, { ...STATIC0, dashedFrom: 1 }), 0 * 16 + 1, 5 * 16 + 1), ENV.deskB, 'desk 1 (first 1) is solid at height 1');
  // Dimmed: the desk's tones mixed halfway to the wall tone.
  const dimmed = composeStatic(L1, { ...STATIC0, dimmed: new Set([1]) });
  assert.deepEqual(px(dimmed, 0 * 16 + 1, 5 * 16 + 1), mix(ENV.deskB, ENV.wall, 0.5));
  assert.deepEqual(px(dimmed, 7 * 16 + 1, 5 * 16 + 1), ENV.deskB, 'desk 7 is not dimmed');
  // A lockbox desk shows the lock glyph where its plaque would be.
  const locked = composeStatic(L1, { ...STATIC0, lockboxDesks: new Set([1]) });
  assert.notDeepEqual(locked.data, r.data);
  assert.deepEqual(px(locked, 0 * 16 + 1, 5 * 16 + 1), ENV.deskB);
});

test('rgba is transparent; blit clips at the edges, skips \u{2019}.\u{2019} and null colours, and flips', () => {
  const r = rgba(4, 3);
  assert.deepEqual([r.w, r.h, r.data.length], [4, 3, 48]);
  assert.ok(r.data.every((v) => v === 0));
  const red: Rgb = [255, 0, 0], blue: Rgb = [0, 0, 255];
  const colour = (k: string): Rgb | null => (k === 'a' ? red : k === 'A' ? blue : null);
  blit(r, ['aA.', 'Abo'], colour, 2, -1);                                             // row 0 above the buffer, column 4 right of it
  assert.deepEqual([px(r, 2, 0), px(r, 3, 0), px(r, 2, 1)], [blue, null, null]);
  assert.ok(opaquePixels(r).every(([x, y]) => x === 2 && y === 0));
  const f = rgba(3, 1);
  blit(f, ['aA.'], colour, 0, 0, true);
  assert.deepEqual([px(f, 0, 0), px(f, 1, 0), px(f, 2, 0)], [null, blue, red]);
  const g = rgba(2, 2);
  blit(g, [...ICONS.clipboard], () => FIXED.eyeWhite, -1, -1);
  assert.deepEqual(opaquePixels(g), [[0, 0], [1, 0], [0, 1], [1, 1]]);
});
