// The office layout (12 §3.5.2–§3.5.3): zones, the append-only desk allocation, the page's delta form, tile coordinates and
// blocked tiles. Desks never move and are never removed while the viewer runs (VIZ-16); every table keyed by a path, zone
// or desk key is a Map (VIZ-37). Shared with the page (R-V35): imports only events.ts and the area rule src/data/zone.ts
// (rev 2.5, F04-a), itself a member of the client program.
import { ROOT_ZONE, zone as zoneOf } from '../../data/zone.js';
import type { DeskRef, PeerRef, Position } from './events.js';

/** s1/s2 for a path of three or more segments, s1 for two, '·' for a root-level file: a re-export of the shared area rule zone(p). */
export { zoneOf };
/** '·', the root zone: the area rule's one definition (src/data/zone.ts), re-exported (F04-a final review M1). */
export { ROOT_ZONE };

/** key: zone(p) as a path key (pathKey), '…' for overflow; cells: grid cell indices. */
export interface Zone { index: number; key: string; cells: number[]; }
/**
 * key: a file desk's is pathKey(p), a folder desk's its zone key + '/', a shelf desk's its zone key + '/…', the big table's
 * '⌂' — unique, because no path key equals a reserved key (pathKey). path: the real path of a file desk, else null.
 */
export interface Desk { ordinal: number; key: string; kind: 'big_table' | 'file' | 'folder' | 'shelf';
                        zone: number | null; cell: number | null; slot: number | null; path: string | null; lockbox: boolean;
                        first: number; }                // R-V51: the height that first touched it (0 for the big table; hs for start-state claim paths)
/**
 * version: +1 per desk, grid cell or home entry added (R-V57: a home-only delta is a real version step, so the page's R-V49
 * no-op rule never drops a new teammate); deskOf: every desk-eligible path → its desk (server and model only).
 */
export interface Layout { version: number; zones: Zone[]; desks: Desk[]; homeOrder: PeerRef[]; deskOf: ReadonlyMap<string, DeskRef>; }
/** zones: new or grown (whole); desks and homeOrder: new only. */
export interface LayoutDelta { fromVersion: number; version: number; zones: Zone[]; desks: Desk[]; homeOrder: PeerRef[]; }
export interface Tile { x: number; y: number; }

export const TILE_PX = 16, GRID_COLS = 3, CELL_W = 7, CELL_H = 10, LOBBY_H = 4, OFFICE_W = 21, HOME_SPOTS = 16;
export const ZONES_MAX = 15, CELLS_PER_ZONE = 4, SLOTS_PER_CELL = 6, FILE_DESKS_PER_ZONE = 23, VISITOR_TILES = 4;
export const OVERFLOW_ZONE = '…', BIG_TABLE_KEY = '⌂';
export const BIG_TABLE: DeskRef = 0;
export const DOOR: Tile = Object.freeze({ x: 1, y: 0 });

/** Lobby furniture (§3.5.2): the big table (4 × 2 tiles), its chair and visitors; the door cluster beyond 16 home spots. */
const BIG_TABLE_X0 = 17, BIG_TABLE_X1 = 20, BIG_TABLE_Y0 = 1, BIG_TABLE_Y1 = 2;
const BIG_TABLE_CHAIR: Tile = { x: 18, y: 3 };
const BIG_TABLE_VISITORS: readonly Tile[] = [{ x: 16, y: 3 }, { x: 17, y: 3 }, { x: 19, y: 3 }, { x: 20, y: 3 }];
const DOOR_CLUSTER: readonly Tile[] = [{ x: 0, y: 1 }, { x: 0, y: 2 }, { x: 0, y: 3 }, { x: 1, y: 2 }, { x: 1, y: 3 }];
const HOME_ROW = 8;
const SLOT_W = 3, SLOT_H = 3;

/** An immutable desk in the fixed field order (a desk never changes once allocated). */
function makeDesk(d: Omit<Desk, 'lockbox'> & { lockbox?: boolean }): Desk {
  return Object.freeze({
    ordinal: d.ordinal, key: d.key, kind: d.kind, zone: d.zone, cell: d.cell, slot: d.slot, path: d.path, lockbox: d.lockbox ?? false, first: d.first,
  });
}
function copyZone(z: Zone): Zone {
  return { index: z.index, key: z.key, cells: [...z.cells] };
}
const BIG_TABLE_DESK: Desk = makeDesk({ ordinal: BIG_TABLE, key: BIG_TABLE_KEY, kind: 'big_table', zone: null, cell: null, slot: null, path: null, first: 0 });

/** Version 0: the big table alone, no zones, no home entries. */
export function emptyLayout(): Layout {
  return { version: 0, zones: [], desks: [BIG_TABLE_DESK], homeOrder: [], deskOf: new Map() };
}

/**
 * Keys derived from teammate paths never equal a reserved key ('…' the overflow zone, '·' the root zone, '⌂' the big table,
 * '<zone>/…' a shelf): a path segment that is one of the three glyphs, or that starts with ':', is written with a ':' prefix.
 * No valid path holds ':' (validPathSyntax), so ordinary paths keep their spec keys, and the prefix keeps the map injective.
 */
const KEY_ESCAPE = ':';
const RESERVED_SEGMENTS: ReadonlySet<string> = new Set([OVERFLOW_ZONE, ROOT_ZONE, BIG_TABLE_KEY]);
function pathKey(s: string): string {
  return s.split('/').map((seg) => (RESERVED_SEGMENTS.has(seg) || seg.startsWith(KEY_ESCAPE) ? KEY_ESCAPE + seg : seg)).join('/');
}
/** The real name behind a path key (for plaques). */
function unPathKey(s: string): string {
  return s.split('/').map((seg) => (seg.startsWith(KEY_ESCAPE) ? seg.slice(KEY_ESCAPE.length) : seg)).join('/');
}
/** The zone key of a path: '·' for a root-level file, else pathKey(zoneOf(p)) — a folder named '·' or '…' is a zone of its own. */
function zoneKeyOf(p: string): string {
  return p.includes('/') ? pathKey(zoneOf(p)) : ROOT_ZONE;
}

export class LayoutFrozenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayoutFrozenError';
  }
}

interface ZoneState { zone: Zone; deskCount: number; shelf: DeskRef | null; }   // deskCount: file (or, in '…', folder) desks

/** Append-only §3.5.3 allocation; never moves or removes a desk; version +1 per desk, grid cell or home entry added (R-V57). */
export class LayoutBuilder {
  private version: number;
  private readonly zones: Zone[];
  private readonly zoneByKey = new Map<string, ZoneState>();
  private readonly desks: Desk[];
  private readonly deskOf: Map<string, DeskRef>;
  /** Overflow folder zone(p) → its folder desk in '…'. */
  private readonly folderOf = new Map<string, DeskRef>();
  private readonly homeOrder: PeerRef[];
  private readonly homeSet: Set<PeerRef>;
  private cells: number;
  private regularZones: number;
  private frozen = false;
  private takenVersion: number;
  private takenDesks: number;
  private takenHome: number;
  private readonly grown = new Set<number>();

  constructor(base: Layout) {
    this.version = base.version;
    this.zones = base.zones.map(copyZone);
    this.desks = base.desks.map((d) => makeDesk(d));
    this.deskOf = new Map(base.deskOf);
    this.homeOrder = [...base.homeOrder];
    this.homeSet = new Set(this.homeOrder);
    this.cells = 0;
    this.regularZones = 0;
    const states: ZoneState[] = this.zones.map((zone) => ({ zone, deskCount: 0, shelf: null }));
    for (const zs of states) {
      this.zoneByKey.set(zs.zone.key, zs);
      this.cells += zs.zone.cells.length;
      if (zs.zone.key !== OVERFLOW_ZONE) this.regularZones++;
    }
    for (const d of this.desks) {
      if (d.zone === null) continue;
      const zs = states[d.zone];
      if (zs === undefined) throw new RangeError(`layout: desk ${d.ordinal} names zone ${d.zone}, which does not exist`);
      if (d.kind === 'shelf') zs.shelf = d.ordinal;
      else zs.deskCount++;
      if (d.kind === 'folder') this.folderOf.set(d.key.slice(0, -1), d.ordinal);
    }
    this.takenVersion = this.version;
    this.takenDesks = this.desks.length;
    this.takenHome = this.homeOrder.length;
  }

  /** The desk of a desk-eligible path, allocated on first touch at height h (Desk.first = h). */
  desk(path: string, h: number): DeskRef {
    const known = this.deskOf.get(path);
    if (known !== undefined) return known;
    if (this.frozen) throw new LayoutFrozenError(`layout is frozen: no desk for a path first touched at height ${h}`);
    let key = zoneKeyOf(path);                                    // never OVERFLOW_ZONE: a real folder '…' is ':…'
    let folder: string | null = null;
    let zs = this.zoneByKey.get(key);
    if (zs === undefined && this.regularZones >= ZONES_MAX) {
      // The 16th zone and beyond: one folder desk per overflow folder in the '…' zone.
      folder = key;
      const existing = this.folderOf.get(folder);
      if (existing !== undefined) {
        this.deskOf.set(path, existing);
        return existing;
      }
      key = OVERFLOW_ZONE;
      zs = this.zoneByKey.get(key);
    }
    zs ??= this.newZone(key);
    let ref: DeskRef;
    if (zs.deskCount < FILE_DESKS_PER_ZONE) {
      const n = zs.deskCount;
      const cellIndex = Math.floor(n / SLOTS_PER_CELL);
      if (cellIndex >= zs.zone.cells.length) this.addCell(zs);   // the newest cell is full: an annex cell
      ref = this.addDesk({
        kind: folder === null ? 'file' : 'folder',
        key: folder === null ? pathKey(path) : `${folder}/`,
        zone: zs.zone.index, cell: zs.zone.cells[cellIndex]!, slot: n % SLOTS_PER_CELL,
        path: folder === null ? path : null, first: h,
      });
      zs.deskCount++;
      if (folder !== null) this.folderOf.set(folder, ref);
    } else {
      // 23 file desks fill the zone's four cells but the 24th slot, which holds its shelf.
      if (zs.shelf === null) {
        zs.shelf = this.addDesk({
          kind: 'shelf', key: `${zs.zone.key}/${OVERFLOW_ZONE}`,
          zone: zs.zone.index, cell: zs.zone.cells[CELLS_PER_ZONE - 1]!, slot: SLOTS_PER_CELL - 1, path: null, first: h,
        });
      }
      ref = zs.shelf;
    }
    this.deskOf.set(path, ref);
    return ref;
  }

  has(path: string): boolean {
    return this.deskOf.has(path);
  }

  /** Appends a peer to homeOrder when absent, one version step (R-V57); home spots never move (§3.6). */
  home(peer: PeerRef): void {
    if (this.homeSet.has(peer)) return;
    if (this.frozen) throw new LayoutFrozenError('layout is frozen: no new home spot');
    this.homeSet.add(peer);
    this.homeOrder.push(peer);
    this.version++;
  }

  /** Later allocation throws LayoutFrozenError (re-fold of a retained range on the head layout). */
  freeze(): void {
    this.frozen = true;
  }

  /** A snapshot: new arrays, new zones and a new Map; desks are immutable and shared. */
  layout(): Layout {
    return { version: this.version, zones: this.zones.map(copyZone), desks: [...this.desks], homeOrder: [...this.homeOrder], deskOf: new Map(this.deskOf) };
  }

  /** The additions since the previous takeDelta (or the base): new or grown zones, new desks, new home entries; null when none. */
  takeDelta(): LayoutDelta | null {
    if (this.desks.length === this.takenDesks && this.homeOrder.length === this.takenHome && this.grown.size === 0) return null;
    const d: LayoutDelta = {
      fromVersion: this.takenVersion,
      version: this.version,
      zones: [...this.grown].sort((a, b) => a - b).map((i) => copyZone(this.zones[i]!)),
      desks: this.desks.slice(this.takenDesks),
      homeOrder: this.homeOrder.slice(this.takenHome),
    };
    this.takenVersion = this.version;
    this.takenDesks = this.desks.length;
    this.takenHome = this.homeOrder.length;
    this.grown.clear();
    return d;
  }

  private newZone(key: string): ZoneState {
    const zone: Zone = { index: this.zones.length, key, cells: [] };
    const zs: ZoneState = { zone, deskCount: 0, shelf: null };
    this.zones.push(zone);
    this.zoneByKey.set(key, zs);
    if (key !== OVERFLOW_ZONE) this.regularZones++;
    this.addCell(zs);
    return zs;
  }

  /** The next free grid cell, in creation order. */
  private addCell(zs: ZoneState): void {
    if (zs.zone.cells.length >= CELLS_PER_ZONE) throw new RangeError(`layout: zone ${zs.zone.index} already has ${CELLS_PER_ZONE} cells`);
    zs.zone.cells.push(this.cells++);
    this.grown.add(zs.zone.index);
    this.version++;
  }

  private addDesk(d: Omit<Desk, 'ordinal' | 'lockbox'>): DeskRef {
    const desk = makeDesk({ ordinal: this.desks.length, ...d });
    this.desks.push(desk);
    this.version++;
    return desk.ordinal;
  }
}

/**
 * The page's form: l plus a delta, as a new layout. d.fromVersion !== l.version throws (the page reloads the world). The page
 * knows no deskOf beyond the file desks' own paths (a folder or shelf desk names no path; LayoutVM carries no deskOf).
 */
export function applyLayoutDelta(l: Layout, d: LayoutDelta): Layout {
  if (d.fromVersion !== l.version) throw new RangeError(`layout delta from version ${d.fromVersion} does not apply to version ${l.version}`);
  const zones = l.zones.map(copyZone);
  for (const z of d.zones) {
    if (z.index < zones.length && zones[z.index]!.key === z.key) zones[z.index] = copyZone(z);
    else if (z.index === zones.length) zones.push(copyZone(z));
    else throw new RangeError(`layout delta zone ${z.index} does not follow zone ${zones.length - 1}`);
  }
  const desks = [...l.desks];
  const deskOf = new Map(l.deskOf);
  for (const desk of d.desks) {
    if (desk.ordinal !== desks.length) throw new RangeError(`layout delta desk ${desk.ordinal} does not follow desk ${desks.length - 1}`);
    desks.push(makeDesk(desk));
    if (desk.kind === 'file' && desk.path !== null) deskOf.set(desk.path, desk.ordinal);
  }
  const present = new Set(l.homeOrder);
  const homeOrder = [...l.homeOrder, ...d.homeOrder.filter((p) => !present.has(p))];
  return { version: d.version, zones, desks, homeOrder, deskOf };
}

function cellCount(l: Layout): number {
  let n = 0;
  for (const z of l.zones) n += z.cells.length;
  return n;
}

/** w = 21, h = 4 + 10·⌈cells / 3⌉ (tiles). */
export function officeTiles(l: Layout): { w: number; h: number } {
  return { w: OFFICE_W, h: LOBBY_H + CELL_H * Math.ceil(cellCount(l) / GRID_COLS) };
}

/** < 16: (2 + 2·(i mod 8), 1 + ⌊i / 8⌋); ≥ 16: the door cluster (0, 1), (0, 2), (0, 3), (1, 2), (1, 3), round-robin. */
export function homeTile(spot: number): Tile {
  if (!Number.isSafeInteger(spot) || spot < 0) throw new RangeError(`homeTile: not a home spot ${spot}`);
  if (spot < HOME_SPOTS) return { x: 2 + 2 * (spot % HOME_ROW), y: 1 + Math.floor(spot / HOME_ROW) };
  const c = DOOR_CLUSTER[(spot - HOME_SPOTS) % DOOR_CLUSTER.length]!;
  return { x: c.x, y: c.y };
}

/** (7·(g mod 3), 4 + 10·⌊g / 3⌋) */
export function cellOrigin(g: number): Tile {
  return { x: CELL_W * (g % GRID_COLS), y: LOBBY_H + CELL_H * Math.floor(g / GRID_COLS) };
}

/** The cell origin + (3·(s mod 2), 1 + 3·⌊s / 2⌋). */
export function slotOrigin(g: number, s: number): Tile {
  const o = cellOrigin(g);
  return { x: o.x + SLOT_W * (s % 2), y: o.y + 1 + SLOT_H * Math.floor(s / 2) };
}

/** A slot desk covers (x, y) and (x + 1, y), its chair is (x, y + 1), its visitors (x + 1, y + 1), (x + 2, y + 1), (x, y + 2), (x + 1, y + 2). */
export function deskTiles(l: Layout, d: DeskRef): { desk: Tile[]; chair: Tile; visitors: Tile[] } {
  const desk = Number.isSafeInteger(d) && d >= 0 ? l.desks[d] : undefined;
  if (desk === undefined) throw new RangeError(`deskTiles: no desk ${d}`);
  if (desk.kind === 'big_table') {
    const tiles: Tile[] = [];
    for (let y = BIG_TABLE_Y0; y <= BIG_TABLE_Y1; y++) for (let x = BIG_TABLE_X0; x <= BIG_TABLE_X1; x++) tiles.push({ x, y });
    return { desk: tiles, chair: { ...BIG_TABLE_CHAIR }, visitors: BIG_TABLE_VISITORS.map((v) => ({ ...v })) };
  }
  if (desk.cell === null || desk.slot === null) throw new RangeError(`deskTiles: desk ${d} has no slot`);
  const { x, y } = slotOrigin(desk.cell, desk.slot);
  return {
    desk: [{ x, y }, { x: x + 1, y }],
    chair: { x, y: y + 1 },
    visitors: [{ x: x + 1, y: y + 1 }, { x: x + 2, y: y + 1 }, { x, y: y + 2 }, { x: x + 1, y: y + 2 }],
  };
}

/** Occupied (cell, slot) pairs of a desks array, as cell · 6 + slot; memoized per array and length (desks only grow). */
const occupiedMemo = new WeakMap<readonly Desk[], { n: number; slots: Set<number> }>();
function occupiedSlots(desks: readonly Desk[]): Set<number> {
  const memo = occupiedMemo.get(desks);
  if (memo !== undefined && memo.n === desks.length) return memo.slots;
  const slots = new Set<number>();
  for (const d of desks) if (d.cell !== null && d.slot !== null) slots.add(d.cell * SLOTS_PER_CELL + d.slot);
  occupiedMemo.set(desks, { n: desks.length, slots });
  return slots;
}

/** Blocked: the lobby wall (row 0 but the door), desk and big-table tiles, and everything outside the office. */
export function isBlocked(l: Layout, t: Tile): boolean {
  const { x, y } = t;
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return true;
  if (x < 0 || y < 0 || x >= OFFICE_W || y >= officeTiles(l).h) return true;
  if (y === 0) return x !== DOOR.x;
  if (y < LOBBY_H) return x >= BIG_TABLE_X0 && x <= BIG_TABLE_X1 && y >= BIG_TABLE_Y0 && y <= BIG_TABLE_Y1;
  const lx = x % CELL_W;
  const ly = (y - LOBBY_H) % CELL_H;
  if (ly === 0 || lx === CELL_W - 1) return false;                  // the sign row and the aisle column
  const ry = ly - 1;
  if (ry % SLOT_H !== 0 || lx % SLOT_W === 2) return false;          // only a slot's first row, first two columns hold its desk
  const g = Math.floor(x / CELL_W) + GRID_COLS * Math.floor((y - LOBBY_H) / CELL_H);
  const s = Math.floor(lx / SLOT_W) + 2 * Math.floor(ry / SLOT_H);
  return occupiedSlots(l.desks).has(g * SLOTS_PER_CELL + s);
}

/** file: its basename; folder: its folder (the real name, never the ':'-prefixed key); shelf and big table: null (the page
 *  labels them from their templates). */
export function plaqueOf(d: Desk): string | null {
  if (d.kind === 'file') {
    const p = d.path ?? unPathKey(d.key);
    return p.slice(p.lastIndexOf('/') + 1);
  }
  if (d.kind === 'folder') return unPathKey(d.key.endsWith('/') ? d.key.slice(0, -1) : d.key);
  return null;
}

/** R-V51: rewinding keeps the head layout and draws a desk dashed when it was first touched after the scene position. */
export function isDashed(d: Desk, at: Position | null): boolean {
  return at !== null && d.first > at.height;
}
