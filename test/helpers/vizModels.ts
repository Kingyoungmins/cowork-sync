// Hand-written model fixtures for the view-model projection tests (Plan 8a Task 9; 12 §3.10.6): ids that fit the served
// aliases (peers whose first 6 hex differ, ULID-shaped hold and claim ids, R… request ids), one event of every SceneEvent kind,
// cards, room snapshots, fake StoreLike rooms, and the page side of VIZ-26 (unprojection with ids kept as handles).
import type { Card } from '../../src/viz/model/cards.js';
import type { ActorRef, PeerRef, Position, SceneEvent, SeatRef } from '../../src/viz/model/events.js';
import { emptyLayout, LayoutBuilder, type Layout } from '../../src/viz/model/layout.js';
import { lookTable } from '../../src/viz/model/looks.js';
import { emptyScene, SceneReducer, type Place, type Scene } from '../../src/viz/model/scene.js';
import type { CardModel, PeerInfo, PetInfo, RoomDelta, RoomSnapshotModel, StoreLike, Tick, TimelinePageModel } from '../../src/viz/server/models.js';
import { createHandleTable, projectEvent, projectLayout, projectScene } from '../../src/viz/server/project.js';
import type { ActorVM, EventVM, LayoutVM, PlaceVM, Pos, SceneVM } from '../../src/viz/server/viewModel.js';
import type { Overlay, RoomSpec } from '../../src/viz/source/roomSource.js';
import { ev } from './vizEvents.js';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** n in base 32 (Crockford), `width` digits. */
const b32 = (n: number, width: number): string => {
  let s = '';
  for (let i = 0; i < width; i++, n = Math.floor(n / 32)) s = CROCKFORD[n % 32]! + s;
  return s;
};

/** A peer id whose first 6 hex are `head` (6 hex digits), so handles stay 6 characters. */
export const peerOf = (head: string): PeerRef => head + '0'.repeat(26);
export const PA = peerOf('a1b2c3'), PB = peerOf('b2c3d4'), PC = peerOf('c3d4e5'), PD = peerOf('d4e5f6');
export const PEERS4: readonly PeerRef[] = [PA, PB, PC, PD];
/** A board seat key "<peer>/<epoch>/<seat_id>". */
export const seatOf = (owner: PeerRef, n: number): SeatRef => `${owner}/${'e'.repeat(32)}/${n.toString(16).padStart(32, '0')}`;
export const SA = seatOf(PA, 1), SB = seatOf(PB, 1);
/** A ULID-shaped hold or claim id whose first 4 characters differ by n. */
export const ulidOf = (n: number): string => `0${b32(n, 3)}${'Q'.repeat(22)}`;
export const reqOf = (n: number): string => `R${b32(n, 8)}`;
export const cidOf = (n: number): string => b32(n, 8);
export const ROOM_ID = 'rABCDEFGH';
export const PATHS4: readonly string[] = ['src/a.ts', 'src/b.ts', 'docs/c.md', 'd.txt'];

/** homeOrder = peers, one file desk per path (ordinals 1, 2, …). */
export function layoutOf(paths: readonly string[] = PATHS4, peers: readonly PeerRef[] = PEERS4, first = 1): Layout {
  const b = new LayoutBuilder(emptyLayout());
  for (const p of peers) b.home(p);
  for (const p of paths) b.desk(p, first);
  return b.layout();
}

const actorP = (peer: PeerRef): ActorRef => ({ peer });
const actorS = (seat: SeatRef): ActorRef => ({ seat });

/** One event of every SceneEvent kind, in board order, over PA…PD, SA, SB, desks 1–4 (claims and holds by ULID-shaped ids). */
export function allKindsEvents(): SceneEvent[] {
  const C1 = ulidOf(1), C2 = ulidOf(2), H1 = ulidOf(101), R1 = reqOf(1);
  return [
    ev('room_open', [0, 0, 0], {}),
    ev('person_enter', [1, 1, 0], { peer: PA }),
    ev('person_enter', [1, 2, 0], { peer: PB }),
    ev('person_enter', [1, 3, 0], { peer: PC }),
    ev('pet_spawn', [2, 1001, 0], { seat: SA, owner: PA }),
    ev('pet_spawn', [2, 1001, 1], { seat: SB, owner: PB }),
    ev('publish', [3, 1001, 0], { actor: actorP(PA), target: 1, others: [2], paths: ['src/a.ts', 'src/b.ts'], n: 2, state: 'closed', checks: 'pass', origin: 'human' }),
    ev('publish', [4, 1001, 0], { actor: actorS(SA), target: 2, others: [], paths: ['src/b.ts'], n: 1, state: 'checkpoint', checks: 'skipped', origin: 'prompt' }),
    ev('room_sign', [5, 1001, 0], { sign: 'branch_moved' }),
    ev('room_badge', [5, 1002, 0], { level: 'near_full' }),
    ev('person_freeze', [6, 1, 0], { peer: PB, reasonCode: 'EPOCH' }),
    ev('person_thaw', [7, 1, 0], { peer: PB }),
    ev('person_slowed', [8, 1, 0], { peer: PC, until: 188 }),
    ev('person_bang', [8, 2, 0], { peer: PC, bang: 'host' }),
    ev('person_badge', [8, 3, 0], { actor: actorP(PC), badge: 'health', on: true, code: 'HOST_THROTTLED' }),
    ev('person_badge', [8, 4, 0], { actor: actorS(SB), badge: 'health', on: true, code: 'SS_NO_HOOKS' }),
    ev('person_badge', [8, 5, 0], { actor: actorP(PA), badge: 'rules', on: true, code: null }),
    ev('conflict', [9, 1, 0], { conflict: 'k4', source: 'hold', on: actorP(PA), desk: 1, holdId: H1, cid: null, eventKind: null, line: { actor: actorP(PB) } }),
    ev('conflict', [9, 2, 0], { conflict: 'breach', source: 'event', on: actorP(PB), desk: null, holdId: null, cid: cidOf(7), eventKind: 'breach', line: null }),
    ev('box', [10, 1, 0], { holdId: H1, owner: actorP(PA), holdKind: 'PATCH', residence: 'ON_DISK', state: 'CONFLICTED', offer: 'pending_leftover', desk: 1, localOnly: false, terminal: false }),
    ev('claim_take', [11, 1, 0], { claimId: C1, seat: SA, desk: 2, order: 10, label: { simple: 'parse', qualname: 'Mod.parse' }, granularity: 'symbol', lines: [10, 20], otherRules: false }),
    ev('claim_take', [11, 2, 0], { claimId: C2, seat: SB, desk: 3, order: 5, label: null, granularity: 'file', lines: null, otherRules: true }),
    ev('claim_move', [12, 1, 0], { claimId: C1, seat: SA, desk: 2, order: 12, label: { simple: 'parse', qualname: 'Mod.parse' }, granularity: 'block', lines: [12, 22], otherRules: false }),
    ev('request_open', [13, 1, 0], { request: R1, from: actorP(PC), holder: actorS(SA), desk: 2, requestKind: 'handoff', estMinutes: 5, attempt: 1, note: 'may I?' }),
    ev('request_status', [13, 2, 0], { request: R1, holder: actorS(SA), status: 'queued_until_turn_end' }),
    ev('claim_reserve', [14, 1, 0], { claimId: C1, request: R1, requester: actorP(PC) }),
    ev('grant_start', [14, 2, 0], { claimId: C2, grantee: actorP(PA) }),
    ev('note', [15, 1, 0], { actor: actorP(PB), target: { claimId: C2 }, text: 'heads up' }),
    ev('note', [15, 2, 0], { actor: actorP(PB), target: { request: R1 }, text: 'ok' }),
    ev('answer', [16, 1, 0], { request: R1, holder: actorS(SA), verb: 'later', by: 'human', note: null }),
    ev('grant_end', [17, 1, 0], { claimId: C2, grantee: actorP(PA) }),
    ev('claim_stale', [17, 2, 0], { claimId: C2 }),
    ev('claim_release', [18, 1, 0], { claimId: C2, reason: 'explicit' }),
    ev('save', [19, 1, 0], { peer: PA, desks: [1, 2] }),
    ev('person_absent', [20, 1, 0], { peer: PC }),
    ev('person_ghost', [20, 1002, 0], { peer: PB }),
    ev('person_unghost', [21, 1002, 0], { peer: PB }),
    ev('pose_relaxed', [21, 1002, 1], { actor: actorP(PA) }),
    ev('person_respawn', [22, 1, 0], { peer: PC }),
    ev('pet_poof', [22, 1001, 0], { seat: SB, owner: PB }),
    ev('person_enter', [23, 1, 0], { peer: PD }),
    ev('person_exit', [24, 1, 0], { peer: PD }),
  ];
}

/** The scene after events, reduced from an empty scene at (0, 0, 0) over `layout`. */
export function sceneAfter(events: readonly SceneEvent[], layout: Layout): Scene {
  const r = new SceneReducer(emptyScene({ height: 0, sub: 0, k: 0 }), () => layout);
  for (const e of events) r.push(e);
  return r.scene();
}

export function cardOf(at: [number, number, number], o: Partial<Card> = {}): Card {
  const [height, sub, k] = at;
  return {
    id: `${height}.${sub}.${k}`, at: { height, sub, k }, group: 'activity', code: 'UI_VIZ_CARD_PUBLISH', actor: { peer: PA }, target: null,
    paths: ['src/a.ts'], n: 1, desks: [1], displayId: null, parent: null, label: null, text: null, detail: null, ...o,
  };
}

export const SPEC: RoomSpec = {
  id: ROOM_ID, kind: 'git', label: 'shop-app', branch: 'main', gitDir: '/home/someone/work/shop-app/.git',
  boardRef: 'refs/cowork-remote/main/board', canonicalRoot: '/home/someone/work/shop-app',
};

export const OVERLAY: Overlay = {
  state: 'ok', freezeReasons: [], publishPause: null, down: false, unreadable: false, offlineMin: null, holds: 1, incoming: 2, ready: 3, you: PA, versionSkew: false,
};

export const peerInfo = (display: string, status: PeerInfo['status'] = 'active', pluginVersion = '0.2.0'): PeerInfo => ({ display, pluginVersion, status });

/** A room snapshot over hand-written parts; the defaults are the all-kinds scene with four peers and two pets. */
export function snapshotOf(o: Partial<RoomSnapshotModel> = {}): RoomSnapshotModel {
  const layout = o.layout ?? layoutOf();
  const scene = o.scene ?? sceneAfter(allKindsEvents(), layout);
  const peers = o.peers ?? new Map<PeerRef, PeerInfo>([[PA, peerInfo('Ann')], [PB, peerInfo('Bo')], [PC, peerInfo('Cy', 'absent')], [PD, peerInfo('Di', 'left')]]);
  const pets = o.pets ?? new Map<SeatRef, PetInfo>([[SA, { owner: PA, live: true, ssCode: null, variant: 0 }], [SB, { owner: PB, live: false, ssCode: 'SS_NO_HOOKS', variant: 0 }]]);
  return {
    spec: o.spec ?? SPEC, window: o.window ?? { h0: 0, h1: scene.at.height }, gone: o.gone ?? false, badges: o.badges ?? [], unknown: o.unknown ?? 0,
    layout, looks: o.looks ?? lookTable(peers.keys()), peers, pets, scene,
    cards: o.cards ?? [{ card: cardOf([3, 1001, 0]), foldedAt: null }], ticks: o.ticks ?? [{ h: 3, glyph: 'publish' }], overlay: o.overlay === undefined ? OVERLAY : o.overlay,
  };
}

/** A StoreLike over a fixed snapshot; counts snapshot() calls; page() answers `pageOf`. */
export class FakeStore implements StoreLike {
  snapshots = 0;
  pages = 0;
  readonly ready: Promise<void>;
  private release: () => void = () => {};
  constructor(public model: RoomSnapshotModel, public pageOf: (from: number, to: number) => TimelinePageModel | null = () => null, gated = false) {
    this.ready = gated ? new Promise<void>((r) => { this.release = r; }) : Promise.resolve();
  }
  open(): void { this.release(); }
  snapshot(): RoomSnapshotModel { this.snapshots++; return this.model; }
  page(from: number, to: number): Promise<TimelinePageModel | null> { this.pages++; return Promise.resolve(this.pageOf(from, to)); }
  earlier(): Promise<TimelinePageModel | null> { return Promise.resolve(null); }
  tick(): Promise<{ delta: RoomDelta | null; overlay: Overlay | null; change: 'state' | 'rebuilt' | null }> { return Promise.resolve({ delta: null, overlay: null, change: null }); }
}

export const deltaOf = (o: Partial<RoomDelta> = {}): RoomDelta => ({
  roomId: ROOM_ID, kind: 'timeline', window: { h0: 0, h1: 30 }, events: [], cards: [], ticks: [] as Tick[], layout: null,
  peers: new Map(), pets: new Map(), scene: null, ...o,
});

// ---- The page side of VIZ-26: the projection rule inverted, ids kept as handles ----

const unPos = (p: Pos): Position => ({ height: p[0], sub: p[1], k: p[2] });
const unActor = (a: ActorVM): ActorRef => ('peer' in a ? { peer: a.peer } : { seat: a.seat });
function unPlace(p: PlaceVM): Place {
  switch (p.at) {
    case 'home': return { at: 'home', spot: p.spot };
    case 'visitor': return { at: 'visitor', desk: p.desk, tile: p.tile };
    case 'facing': return { at: 'facing', actor: unActor(p.actor), desk: p.desk };
    case 'behind': return { at: 'behind', peer: p.peer };
    default: return { at: p.at, desk: p.desk };
  }
}

/** EventVM → SceneEvent: at → (height, sub, k); every other field kept (handles are the page's ids). */
export function unprojectEvent(e: EventVM): SceneEvent {
  const { at, ...rest } = structuredClone(e) as EventVM & Record<string, unknown>;
  return { ...rest, height: at[0], sub: at[1], k: at[2] } as unknown as SceneEvent;
}

const unState = <T extends { place: PlaceVM; lastPublish: Pos | null; lastClaimOp: Pos | null }>(v: T) => ({
  ...v, place: unPlace(v.place), lastPublish: v.lastPublish === null ? null : unPos(v.lastPublish), lastClaimOp: v.lastClaimOp === null ? null : unPos(v.lastClaimOp),
});

/** SceneVM → Scene: arrays → Maps, Pos → Position. */
export function unprojectScene(s: SceneVM): Scene {
  const v = structuredClone(s);
  return {
    at: unPos(v.at), badge: v.badge, branchMovedAt: v.branchMovedAt,
    characters: new Map(v.characters.map(([k, c]) => [k, unState(c)])),
    pets: new Map(v.pets.map(([k, p]) => [k, unState(p)])),
    desks: new Map(v.desks.map(([k, d]) => [k, { ...d, chair: d.chair === null ? null : unActor(d.chair), visitors: d.visitors.map(unActor) }])),
    claims: new Map(v.claims.map(([k, c]) => [k, { ...c, grantee: c.grantee === null ? null : unActor(c.grantee), at: unPos(c.at) }])),
    requests: new Map(v.requests.map(([k, r]) => [k, { ...r, from: unActor(r.from), holder: unActor(r.holder) }])),
    boxes: new Map(v.boxes.map(([k, b]) => [k, { ...b, owner: unActor(b.owner) }])),
    bangs: new Map(v.bangs.map(([k, b]) => [k, { on: unActor(b.on), desk: b.desk }])),
    beat: v.beat.map(unprojectEvent),
  };
}

/** LayoutVM → Layout with handles in homeOrder (what the reducer reads: homeOrder; desks by ordinal). */
export function unprojectLayout(l: LayoutVM): Layout {
  return {
    version: l.version, zones: l.zones.map((z) => ({ index: z.index, key: z.sign, cells: [...z.cells] })),
    desks: l.desks.map((d) => ({ ...d, key: d.path ?? `#${d.ordinal}` })), homeOrder: [...l.homeOrder], deskOf: new Map(),
  };
}

/**
 * VIZ-26 over the projection: the server reduces `events` from an empty start over `layout`, and its scene after each event is
 * projected (`serverVM`) and read back as the page holds it (`server`: unprojected, ids kept as handles); the page reduces the
 * projected events (unprojected) from the projected start over the projected layout (`page`). Every id is registered before
 * anything is projected, so handles are stable across the whole sequence. The page never re-projects: its scene is compared
 * in its own (unprojected) form.
 */
export function projectedReduction(events: readonly SceneEvent[], layout: Layout): { serverVM: SceneVM[]; server: Scene[]; page: Scene[] } {
  const h = createHandleTable();
  const start = emptyScene({ height: 0, sub: 0, k: 0 });
  const serverScenes: Scene[] = [];
  const r = new SceneReducer(start, () => layout);
  for (const e of events) {
    r.push(e);
    serverScenes.push(r.scene());
  }
  // Register every id first (a collision would change earlier handles), then project for real.
  for (const e of events) projectEvent(e, h);
  for (const s of serverScenes) projectScene(s, h);
  projectLayout(layout, h);
  h.takeCollision();
  const serverVM = serverScenes.map((s) => projectScene(s, h));
  const pageLayout = unprojectLayout(projectLayout(layout, h));
  const p = new SceneReducer(unprojectScene(projectScene(start, h)), () => pageLayout);
  const page: Scene[] = [];
  for (const e of events) {
    p.push(unprojectEvent(projectEvent(e, h)));
    page.push(p.scene());
  }
  return { serverVM, server: serverVM.map(unprojectScene), page };
}
