// The art layers at art resolution (12 §3.7): pure RGBA buffers with no DOM, so the page puts them into an art-size offscreen
// canvas drawn at an integer zoom, and tests hash them (T-VIZ-frames). The static layer (floor, walls, door, zone signs, desks,
// monitors, chairs, plaque plates, the big table) is recomposed only on a layout or option change; the sprite layer (characters,
// pets, badges and icons) per drawn frame, z-sorted by foot y, then actor key. Text (names, plaques, bubbles, "+n" counts) is the
// page's fillText. Every write is clipped to the buffer, so nothing outside the office is ever read or wrapped (VIZ-19, VIZ-22).
// Shared with the page (R-V35): imports only the client-program model files and render/**.
import { actorKey, type DeskRef, type SceneEvent } from '../model/events.js';
import { BIG_TABLE, DOOR, TILE_PX, VISITOR_TILES, cellOrigin, deskTiles, homeTile, isBlocked, isDashed, officeTiles, type Layout, type Tile } from '../model/layout.js';
import { SIGN_HEIGHTS, type CharacterState, type PetState, type Place, type Scene } from '../model/scene.js';
import { ENV, FIXED, ICON_TONES, ORANGE_BANG, PALETTE, mix, type CharacterColours, type Rgb } from './palette.js';
import { ACCESSORIES, BASE, DIGITS, ICONS, PET, SEAT_VARIANTS, TILES, frameOf, frameRow, type AccessoryName, type FrameName, type IconName, type SpriteMap } from './sprites.js';

export interface Rgba { readonly w: number; readonly h: number; readonly data: Uint8ClampedArray; }

/** A transparent buffer of w × h art pixels (RGBA, straight alpha). */
export function rgba(w: number, h: number): Rgba {
  if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w < 0 || h < 0) throw new RangeError(`rgba: no buffer of ${w} x ${h}`);
  return { w, h, data: new Uint8ClampedArray(w * h * 4) };
}

/** One pixel, straight-alpha source-over in integers (deterministic on every engine). */
function put(dst: Rgba, x: number, y: number, c: Rgb, alpha: number): void {
  const d = dst.data, i = (y * dst.w + x) * 4;
  const da = d[i + 3]!;
  if (alpha >= 255 || da === 0) {
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = Math.min(255, alpha);
    return;
  }
  const keep = da * (255 - alpha);                 // the destination's share, × 255
  const out = alpha * 255 + keep;                  // the result's alpha, × 255
  for (let k = 0; k < 3; k++) d[i + k] = Math.round((c[k]! * alpha * 255 + d[i + k]! * keep) / out);
  d[i + 3] = Math.round(out / 255);
}

function paint(dst: Rgba, map: SpriteMap, colour: (key: string) => Rgb | null, x: number, y: number, flip: boolean, alpha: number): void {
  const x0 = Math.round(x), y0 = Math.round(y);
  for (let r = 0; r < map.length; r++) {
    const py = y0 + r;
    if (py < 0 || py >= dst.h) continue;
    const row = map[r]!;
    const w = row.length;
    for (let c = 0; c < w; c++) {
      const px = x0 + c;
      if (px < 0 || px >= dst.w) continue;
      const key = row[flip ? w - 1 - c : c]!;
      if (key === '.') continue;
      const rgb = colour(key);
      if (rgb !== null) put(dst, px, py, rgb, alpha);
    }
  }
}

/** Draws map opaquely with its top-left at (x, y): '.' and keys the colour function maps to null are skipped; clipped at every edge. */
export function blit(dst: Rgba, map: SpriteMap, colour: (key: string) => Rgb | null, x: number, y: number, flip = false): void {
  paint(dst, map, colour, x, y, flip, 255);
}

// ---------------------------------------------------------------------------------------------------------
// Colours

/** Tile keys (sprites.ts TILES): a A floor, o wall, b h desk, k monitor, l screen. */
function envColour(key: string): Rgb | null {
  switch (key) {
    case 'a': return ENV.floorA;
    case 'A': return ENV.floorB;
    case 'o': return ENV.wall;
    case 'b': return ENV.deskA;
    case 'h': return ENV.deskB;
    case 'k': return ENV.monitor;
    case 'l': return ENV.screenIdle;
    default: return null;
  }
}
const DIM_T = 0.5;                                  // a dimmed desk: its tones mixed halfway to the wall tone
function dimColour(key: string): Rgb | null {
  const c = envColour(key);
  return c === null ? null : mix(c, ENV.wall, DIM_T);
}
function tonesColour(t: readonly [Rgb, Rgb]): (key: string) => Rgb | null {
  return (k) => (k === 'a' ? t[0] : k === 'A' ? t[1] : k === 'o' ? FIXED.pupil : k === 'w' ? FIXED.eyeWhite : k === 'l' ? FIXED.lens : null);
}
/** The colour function of an icon (sprites.ts ICONS) in its own tones (palette.ts ICON_TONES). */
export function iconColour(name: IconName): (key: string) => Rgb | null {
  return tonesColour(ICON_TONES[name]);
}
const whiteColour = (k: string): Rgb | null => (k === 'w' ? FIXED.eyeWhite : null);
/** Luma grey (Rec. 601) in integers: the ghost's desaturation. */
function grey(c: Rgb): Rgb {
  const g = Math.round((299 * c[0] + 587 * c[1] + 114 * c[2]) / 1000);
  return [g, g, g];
}
function characterColour(c: CharacterColours, ghost: boolean, outline: Rgb): (key: string) => Rgb | null {
  const f = (k: string): Rgb | null => {
    switch (k) {
      case 'o': case 'f': return outline;
      case 'b': return c.body;
      case 'h': return c.highlight;
      case 'c': return FIXED.cheek;
      case 'w': return FIXED.eyeWhite;
      case 'k': return FIXED.pupil;
      case 'a': return c.accessory[0];
      case 'A': return c.accessory[1];
      case 'l': return FIXED.lens;
      default: return null;
    }
  };
  return ghost ? (k) => { const v = f(k); return v === null ? null : grey(v); } : f;
}

type Look = { hue: number; accessory: number };
/** Look accessory index → overlay (palette.ts ACCESSORY_NAMES order). */
const ACCESSORY_ORDER: readonly AccessoryName[] = Object.freeze(['beanie', 'headphones', 'sunglasses', 'scarf', 'sprout', 'cap', 'bow', 'glasses']);
/** A look outside the table (a missing or malformed entry) draws as hue 0, accessory 0 rather than not at all. */
function coloursOf(look: Look | undefined): { colours: CharacterColours; accessory: AccessoryName } {
  const okHue = look !== undefined && Number.isInteger(look.hue) && look.hue >= 0 && look.hue < PALETTE.characters.length;
  const row = PALETTE.characters[okHue ? look.hue : 0]!;
  const okAcc = look !== undefined && Number.isInteger(look.accessory) && look.accessory >= 0 && look.accessory < row.length;
  const acc = okAcc ? look.accessory : 0;
  return { colours: row[acc]!, accessory: ACCESSORY_ORDER[acc]! };
}

// ---------------------------------------------------------------------------------------------------------
// The static layer

export interface StaticOptions { dashedFrom: number | null; dimmed: ReadonlySet<DeskRef>; coarse: boolean; lockboxDesks: ReadonlySet<DeskRef>; }   // dashedFrom: the
                                                 // scene height on a past scene (desks with isDashed drawn as dashed outlines), null live (R-V51)

const MONITOR_DX = 10, MONITOR_DY = -5, MONITOR_W = 12;   // the monitor overhangs the desk's top edge (12 §3.5.2)
const PLAQUE_DX = 6, PLAQUE_DY = 6;                // the plaque plate on the desk's front
const LOCK_DX = 12, LOCK_DY = 4;                   // a lockbox desk's lock glyph in place of the plaque (12 §3.5.3)
const SIGN_TILES = 6;                              // a zone sign spans the cell's columns 0–5 (column 6 is the aisle)
const DESK_W = 2 * TILE_PX, DESK_H = TILE_PX;

/** A 2-on, 2-off dashed rectangle outline, clockwise from the top-left corner. */
function dashedRect(dst: Rgba, x: number, y: number, w: number, h: number, c: Rgb): void {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < w; i++) pts.push([x + i, y]);
  for (let j = 1; j < h; j++) pts.push([x + w - 1, y + j]);
  for (let i = w - 2; i >= 0; i--) pts.push([x + i, y + h - 1]);
  for (let j = h - 2; j >= 1; j--) pts.push([x, y + j]);
  pts.forEach(([px, py], n) => {
    if (((n >> 1) & 1) === 0 && px >= 0 && py >= 0 && px < dst.w && py < dst.h) put(dst, px, py, c, 255);
  });
}

/** A decimal number as one map of 3×5 DIGITS glyphs, one transparent column apart. */
function numberMap(n: number): SpriteMap {
  const ds = [...String(n)].map((ch) => DIGITS[ch.charCodeAt(0) - 48]!);
  return Array.from({ length: 5 }, (_, r) => ds.map((d) => d[r]!).join('.'));
}

/** Floor checker, walls, door, zone-sign plates, desks, monitors, plaque plates, big table — at art resolution (text is the page's fillText). */
export function composeStatic(layout: Layout, o: StaticOptions): Rgba {
  const { w, h } = officeTiles(layout);
  const out = rgba(w * TILE_PX, h * TILE_PX);
  for (let ty = 0; ty < h; ty++) for (let tx = 0; tx < w; tx++) blit(out, (tx + ty) % 2 === 0 ? TILES.floorA : TILES.floorB, envColour, tx * TILE_PX, ty * TILE_PX);
  for (let tx = 0; tx < w; tx++) blit(out, tx === DOOR.x ? TILES.door : TILES.wall, envColour, tx * TILE_PX, DOOR.y * TILE_PX);
  for (const z of layout.zones) {
    for (const g of z.cells) {
      const c = cellOrigin(g);
      for (let i = 0; i < SIGN_TILES; i++) blit(out, TILES.signPlate, envColour, (c.x + i) * TILE_PX, c.y * TILE_PX);
    }
  }
  const big = deskTiles(layout, BIG_TABLE);
  const bigColour = o.dimmed.has(BIG_TABLE) ? dimColour : envColour;
  blit(out, TILES.bigTable, bigColour, big.desk[0]!.x * TILE_PX, big.desk[0]!.y * TILE_PX);
  blit(out, TILES.chair, bigColour, big.chair.x * TILE_PX, big.chair.y * TILE_PX);
  if (o.coarse) {
    // The coarse view (a user toggle, 12 §3.5.3): each zone is one table in its first cell, with its desk count.
    for (const z of layout.zones) {
      const g = z.cells[0];
      if (g === undefined) continue;
      const c = cellOrigin(g);
      const x = (c.x + 1) * TILE_PX, y = (c.y + 3) * TILE_PX;
      blit(out, TILES.bigTable, envColour, x, y);
      const count = numberMap(layout.desks.filter((d) => d.zone === z.index).length);
      blit(out, count, whiteColour, x + 32 - Math.floor(count[0]!.length / 2), y + 10);
    }
    return out;
  }
  const at = o.dashedFrom === null ? null : { height: o.dashedFrom, sub: 0, k: 0 };
  for (const d of layout.desks) {
    if (d.kind === 'big_table' || d.cell === null || d.slot === null) continue;
    const t = deskTiles(layout, d.ordinal);
    const x = t.desk[0]!.x * TILE_PX, y = t.desk[0]!.y * TILE_PX;
    if (isDashed(d, at)) {
      dashedRect(out, x, y, DESK_W, DESK_H, ENV.deskB);   // first touched after the scene position: an outline only (R-V51)
      continue;
    }
    const colour = o.dimmed.has(d.ordinal) ? dimColour : envColour;
    blit(out, TILES.chair, colour, t.chair.x * TILE_PX, t.chair.y * TILE_PX);
    if (d.kind === 'shelf') blit(out, TILES.shelf, colour, x, y);
    else {
      blit(out, TILES.desk, colour, x, y);
      blit(out, TILES.monitor, colour, x + MONITOR_DX, y + MONITOR_DY);
    }
    if (o.lockboxDesks.has(d.ordinal)) blit(out, ICONS.lock, iconColour('lock'), x + LOCK_DX, y + LOCK_DY);
    else blit(out, TILES.plaque, colour, x + PLAQUE_DX, y + PLAQUE_DY);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Placement

/**
 * Where a Place stands (12 §3.5.2): a home spot (≥ 16: the door cluster); a desk's chair; its visitor tile (a tile ≥ 4 is counted
 * in the desk's "+n" and not drawn — it stands on the last visitor tile); a stool = the first visitor tile, beside the chair;
 * beside (supervising) = the first visitor tile the desk's visitors leave free (the last one when all four are taken); facing a
 * chair = the tile below it (in front), else the first free of left, right and above; behind = one tile below the character,
 * else one above when the tile below is blocked or outside the office, else the character's own tile; a pet whose character
 * is not in the scene stands at the door. Total: a desk the layout does not have (a page whose layout lags the scene, a
 * malformed reference) places the actor at the door too, never throws.
 */
export function placeTile(place: Place, layout: Layout, s: Scene): Tile {
  if (place.at !== 'home' && place.at !== 'behind' && !deskOk(layout, place.desk)) return { x: DOOR.x, y: DOOR.y };
  switch (place.at) {
    case 'home': return homeTile(place.spot);
    case 'chair': return deskTiles(layout, place.desk).chair;
    case 'stool': return deskTiles(layout, place.desk).visitors[0]!;
    case 'visitor': {
      const v = deskTiles(layout, place.desk).visitors;
      return v[Math.min(Math.max(0, place.tile), v.length - 1)] ?? v[0]!;
    }
    case 'beside': {
      const v = deskTiles(layout, place.desk).visitors;
      return v[Math.min(s.desks.get(place.desk)?.visitors.length ?? 0, v.length - 1)]!;
    }
    case 'facing': {
      const c = deskTiles(layout, place.desk).chair;
      for (const [dx, dy] of [[0, 1], [-1, 0], [1, 0], [0, -1]] as const) {
        const t = { x: c.x + dx, y: c.y + dy };
        if (!isBlocked(layout, t)) return t;
      }
      return c;
    }
    case 'behind': {
      const owner = s.characters.get(place.peer);
      if (owner === undefined || owner.place.at === 'behind') return { x: DOOR.x, y: DOOR.y };
      const t = placeTile(owner.place, layout, s);
      const below = { x: t.x, y: t.y + 1 };
      if (!isBlocked(layout, below)) return below;
      const above = { x: t.x, y: t.y - 1 };
      if (!isBlocked(layout, above)) return above;
      return t;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// The sprite layer

/**
 * What the page's animation state machine tells the art, per actor key (events.ts actorKey: 'p:<peer>' or 's:<seat>', the keys of
 * the scene's character and pet maps) and per desk ordinal: the frame (sprites.ts FrameName; reduced motion draws the static form),
 * the tile it stands on (placeTile, or a tile of its walk), its facing, and whether a desk's screen shows a publish this beat.
 */
export interface SpritePhase { reduced: boolean; frame(actor: string): FrameName; tile(actor: string): Tile; facingLeft(actor: string): boolean; screen(desk: DeskRef): 'idle' | 'published'; }

const GHOST_ALPHA = 128;                           // ghost: 50 % alpha, desaturated (12 §3.7)
const STALE_ALPHA = 128;                           // a pet whose every claim is STALE: the ghost chair's translucent pet
const ICE_ALPHA = 80;                              // the ice block over a frozen character
const BADGE = 8, BADGE_GAP = 1, JUMP = 2;          // badges are 8×8 icons in a row above the head; an exclaim jumps 2 px
const PET_SIZE = 8, PET_DX = 4, PET_DY = 8;        // the 8×8 pet stands at the bottom centre of its tile
const PLANES_MAX = 4;                              // paper planes to at most 4 other desks, then "+n" (12 §3.7)
const DOT: SpriteMap = Object.freeze(['ww', 'ww']); // reduced motion: a static dot on a plane's desk

interface Badge { icon: IconName; tones: readonly [Rgb, Rgb]; jump: boolean; }
const badge = (icon: IconName): Badge => ({ icon, tones: ICON_TONES[icon], jump: false });

const STATUS_ICON: Readonly<Record<string, IconName>> = Object.freeze({
  queued_until_turn_end: 'queued', asked: 'asked', awaiting_human: 'awaiting_human', undeliverable: 'undeliverable',
});
const ANSWER_ICON: Readonly<Record<string, IconName>> = Object.freeze({ accept: 'accepted', grant: 'accepted', decline: 'declined', later: 'later' });

/** The one-beat marks of scene.beat (12 §3.4, §3.7), by actor key. */
interface BeatMarks { pops: Map<string, IconName[]>; exclaim: Map<string, readonly [Rgb, Rgb]>; published: Set<string>; }
function beatMarks(beat: readonly SceneEvent[]): BeatMarks {
  const m: BeatMarks = { pops: new Map(), exclaim: new Map(), published: new Set() };
  const pop = (key: string, icon: IconName | undefined): void => {
    if (icon === undefined) return;
    const list = m.pops.get(key);
    if (list === undefined) m.pops.set(key, [icon]);
    else list.push(icon);
  };
  for (const e of beat) {
    switch (e.kind) {
      case 'person_badge':
        if (e.on && (e.badge === 'version' || e.badge === 'health')) pop(actorKey(e.actor), e.badge);
        break;
      case 'publish':
        m.published.add(actorKey(e.actor));
        if (e.origin === 'wake') pop(actorKey(e.actor), 'wake');
        break;
      case 'pet_spawn': pop(actorKey({ seat: e.seat }), 'think'); break;
      case 'request_status': pop(actorKey(e.holder), Object.hasOwn(STATUS_ICON, e.status) ? STATUS_ICON[e.status] : undefined); break;
      case 'answer': pop(actorKey(e.holder), e.by === 'daemon' ? 'daemon' : Object.hasOwn(ANSWER_ICON, e.verb) ? ANSWER_ICON[e.verb] : undefined); break;
      case 'request_open': if (e.requestKind === 'handoff') pop(actorKey(e.from), 'parcel'); break;
      case 'conflict': m.exclaim.set(actorKey(e.on), ICON_TONES.bang); break;
      case 'person_bang': m.exclaim.set(actorKey({ peer: e.peer }), ORANGE_BANG); break;
      default: break;
    }
  }
  return m;
}

/** A row of 8×8 badges from (left, top), 1 px apart; an exclaim jumps 2 px. */
function drawBadges(out: Rgba, badges: readonly Badge[], left: number, top: number, alpha: number): void {
  badges.forEach((b, i) => paint(out, ICONS[b.icon], tonesColour(b.tones), left + i * (BADGE + BADGE_GAP), top - (b.jump ? JUMP : 0), false, alpha));
}
const rowWidth = (n: number): number => n * (BADGE + BADGE_GAP) - BADGE_GAP;

interface Ctx { out: Rgba; scene: Scene; looks: ReadonlyMap<string, Look>; phase: SpritePhase; marks: BeatMarks; bangOn: ReadonlySet<string>; }

/** The exclaim (one beat: a jump, or in reduced motion a static coloured outline) or the persistent "!" of a non-terminal record. */
function bangBadge(ctx: Ctx, key: string): Badge | null {
  const ex = ctx.marks.exclaim.get(key);
  if (ex !== undefined) return { icon: 'bang', tones: ex, jump: !ctx.phase.reduced };
  return ctx.bangOn.has(key) ? badge('bang') : null;
}

// The relaxed pose (12 §3.4 pose_relaxed: "leaning, reading", never zzz; §3.7: 2 × 900 ms lean, reduced motion a static pose;
// R-V64: drawn here from the pose, no FrameName). On the idle phase the head — base rows 0–8, eyes, cheeks and any accessory
// rows with it — leans 1 px, right on idle0 (and in reduced motion) and left on idle1, mirrored when facing left, with no bob;
// the eyes look down (row 6 all white, row 7 all pupil: open, never closed) at a book held in front of the mouth. A relaxed
// pet leans its rows 0–3 the same way (no book: it has no hands).
const LEAN_ROWS = 9, PET_LEAN_ROWS = 4;
/** The base map with the eyes looking down: the pupils of row 6 turn white, the whites of row 7 turn pupil. */
const READING: SpriteMap = Object.freeze(BASE.map((r, i) => (i === 6 ? r.replace(/k/g, 'w') : i === 7 ? r.replace(/w/g, 'k') : r)));
/** The book over base rows 9–11, seen from its back: cover in accessory tone a (ΔE ≥ 15 from the body), spine A. */
const BOOK: SpriteMap = Object.freeze(['aaaAAaaa', 'aaaAAaaa', 'aaaAAaaa']);
const BOOK_DX = 4, BOOK_DY = 9;

/** The lean of a relaxed actor on frame f: +1 on idle0, −1 on idle1, mirrored when facing left; 0 for every other frame. */
function leanOf(f: FrameName, flip: boolean): number {
  const dx = f === 'idle0' ? 1 : f === 'idle1' ? -1 : 0;
  return flip ? -dx : dx;
}
/** Paints map with its first `rows` rows shifted dx art pixels (the relaxed lean); dx 0 paints it whole. */
function paintLeaning(out: Rgba, map: SpriteMap, colour: (key: string) => Rgb | null, x0: number, y0: number, flip: boolean, alpha: number, rows: number, dx: number): void {
  if (dx === 0) {
    paint(out, map, colour, x0, y0, flip, alpha);
    return;
  }
  paint(out, map.slice(0, rows), colour, x0 + dx, y0, flip, alpha);
  paint(out, map.slice(rows), colour, x0, y0 + rows, flip, alpha);
}

function drawCharacter(ctx: Ctx, key: string, peer: string, c: CharacterState, tile: Tile): void {
  const { out, phase } = ctx;
  let f = phase.frame(key);
  if (c.absent) f = 'eyesClosed';                                   // zzz
  else if (f !== 'eyesClosed' && (phase.reduced || c.frozen !== null)) f = 'idle0';   // reduced motion: static; frozen: no bob
  const relaxed = c.pose === 'relaxed' && (f === 'idle0' || f === 'idle1');   // a walk frame or closed eyes win
  const flip = phase.facingLeft(key);
  const lean = relaxed ? leanOf(f, flip) : 0;
  const { map, dy } = relaxed ? { map: READING, dy: 0 } : frameOf(f);   // relaxed: the lean replaces the bob
  const x0 = Math.round(tile.x * TILE_PX), y0 = Math.round(tile.y * TILE_PX) + dy;
  const alpha = c.ghost ? GHOST_ALPHA : 255;
  const { colours, accessory } = coloursOf(ctx.looks.get(peer));
  const ex = ctx.marks.exclaim.get(key);
  const colour = characterColour(colours, c.ghost, phase.reduced && ex !== undefined ? ex[0] : colours.outline);
  paintLeaning(out, map, colour, x0, y0, flip, alpha, LEAN_ROWS, lean);
  for (const [row, s] of ACCESSORIES[accessory]) {
    const to = frameRow(f, row);
    if (to !== null) paint(out, [s], colour, x0 + (row < LEAN_ROWS ? lean : 0), y0 + to, flip, alpha);
  }
  if (relaxed) paint(out, BOOK, colour, x0 + BOOK_DX, y0 + BOOK_DY, flip, alpha);
  if (c.frozen !== null && c.frozen !== 'PAUSED') paintLeaning(out, map, () => ICON_TONES.ice[0], x0, y0, flip, ICE_ALPHA, LEAN_ROWS, lean);
  const badges: Badge[] = [];
  const bang = bangBadge(ctx, key);
  if (bang !== null) badges.push(bang);
  if (c.frozen !== null) badges.push(badge(c.frozen === 'PAUSED' ? 'paused' : 'ice'));
  if (c.slowedUntil !== null && ctx.scene.at.height < c.slowedUntil) badges.push(badge('snail'));
  if (c.absent) badges.push(badge('zzz'));
  if (c.rules) badges.push(badge('rules'));
  if (c.credit) badges.push(badge('credit'));
  for (const icon of ctx.marks.pops.get(key) ?? []) badges.push(badge(icon));
  if (phase.reduced && c.pose === 'sit' && ctx.marks.published.has(key)) badges.push(badge('keyboard'));   // sit and type, static
  drawBadges(out, badges, x0 + TILE_PX / 2 - Math.floor(rowWidth(badges.length) / 2), y0 - BADGE, alpha);   // centred above the head
}

/**
 * The seat variant drawn above the pet: 1–3 the SEAT_VARIANTS marks with `a` in its owner's highlight and `A` in its owner's
 * body, ≥ 4 the number in DIGITS (eye white). Not the accessory tones: a dark pair (sunglasses #222222, headphones #333344)
 * vanishes on the floor, while every highlight and body clears both floor tones by ΔE ≥ 15 (pinned by a raster test).
 */
function variantMark(variant: number, c: CharacterColours): { map: SpriteMap; colour: (key: string) => Rgb | null } | null {
  if (!Number.isSafeInteger(variant) || variant <= 0) return null;
  const m = SEAT_VARIANTS[variant];
  if (m !== undefined) return m === null ? null : { map: m, colour: tonesColour([c.highlight, c.body]) };
  return { map: numberMap(variant), colour: whiteColour };
}

function drawPet(ctx: Ctx, key: string, seat: string, p: PetState, tile: Tile): void {
  const { out, phase } = ctx;
  const f: FrameName = phase.reduced ? 'idle0' : phase.frame(key);   // reduced motion: static
  const relaxed = p.pose === 'relaxed' && (f === 'idle0' || f === 'idle1');
  const flip = phase.facingLeft(key);
  const lean = relaxed ? leanOf(f, flip) : 0;
  const dy = relaxed ? 0 : frameOf(f).dy;
  const x0 = Math.round(tile.x * TILE_PX) + PET_DX, y0 = Math.round(tile.y * TILE_PX) + PET_DY + dy;
  const { colours } = coloursOf(ctx.looks.get(p.owner));
  let held = 0, stale = 0;
  for (const cl of ctx.scene.claims.values()) {
    if (cl.seat !== seat) continue;
    held++;
    if (cl.stale) stale++;
  }
  const alpha = held > 0 && stale === held ? STALE_ALPHA : 255;
  const ex = ctx.marks.exclaim.get(key);
  const outline = phase.reduced && ex !== undefined ? ex[0] : colours.outline;
  const shine = mix(colours.highlight, FIXED.eyeWhite, 0.35);
  // VIZ-21: the owner's colours — its highlight as the body, its outline as the outline.
  const colour = (k: string): Rgb | null => (k === 'o' ? outline : k === 'b' ? colours.highlight : k === 'h' ? shine : k === 'c' ? FIXED.cheek : k === 'k' ? FIXED.pupil : null);
  paintLeaning(out, PET, colour, x0, y0, flip, alpha, PET_LEAN_ROWS, lean);
  const mark = variantMark(p.variant, colours);
  if (mark !== null) paint(out, mark.map, mark.colour, x0 + lean + PET_DX - Math.floor(mark.map[0]!.length / 2), y0 - mark.map.length, false, alpha);
  const badges: Badge[] = [];
  const bang = bangBadge(ctx, key);
  if (bang !== null) badges.push(bang);
  if (p.ssCode !== null) badges.push(badge('health'));                // the SS_* label is the page's text; the badge marks it
  for (const icon of ctx.marks.pops.get(key) ?? []) badges.push(badge(icon));
  if (phase.reduced && p.pose === 'sit' && ctx.marks.published.has(key)) badges.push(badge('keyboard'));
  drawBadges(out, badges, x0 + PET_SIZE + BADGE_GAP, y0, alpha);   // beside the pet: above it stands its character when behind
}

/** A desk the layout has and can place (the big table, or a desk with its cell and slot): deskTiles cannot throw for it. */
function deskOk(layout: Layout, d: DeskRef): boolean {
  if (!Number.isSafeInteger(d) || d < 0 || d >= layout.desks.length) return false;
  const desk = layout.desks[d]!;
  return desk.kind === 'big_table' || (desk.cell !== null && desk.slot !== null);
}
/** The top-left art pixel of a desk's first tile. */
function deskPx(layout: Layout, d: DeskRef): { x: number; y: number } {
  const t = deskTiles(layout, d).desk[0]!;
  return { x: t.x * TILE_PX, y: t.y * TILE_PX };
}

/** The thin outline of a map: its pixels next to a transparent one or the edge, keys kept. */
function outlineOf(m: SpriteMap): SpriteMap {
  return Object.freeze(m.map((row, y) => [...row].map((ch, x) => {
    if (ch === '.') return '.';
    const at = (xx: number, yy: number): string => m[yy]?.[xx] ?? '.';
    return at(x - 1, y) === '.' || at(x + 1, y) === '.' || at(x, y - 1) === '.' || at(x, y + 1) === '.' ? ch : '.';
  }).join('')));
}
/** The filing cabinet's thin outline (room badge near_full). */
const CABINET_OUTLINE: SpriteMap = outlineOf(ICONS.cabinet);
/** A record whose change-set is off the disk (OFF_DISK, PARKED: "on a shelf", 12 §3.4): the parcel as a hollow outline. */
const PARCEL_SHELVED: SpriteMap = outlineOf(ICONS.parcel);
const BOXES_MAX = 3;                               // boxes drawn per desk; the rest are one "+n" chip in the fourth slot

/** A box's form (12 §3.4): local_only lockbox, INCOMING delivery cart, OFF_DISK/PARKED hollow parcel, else the parcel. */
function boxForm(b: { residence: string; localOnly: boolean }): { map: SpriteMap; icon: IconName } {
  if (b.localOnly) return { map: ICONS.lockbox, icon: 'lockbox' };
  if (b.residence === 'INCOMING') return { map: ICONS.cart, icon: 'cart' };
  if (b.residence === 'OFF_DISK' || b.residence === 'PARKED') return { map: PARCEL_SHELVED, icon: 'parcel' };
  return { map: ICONS.parcel, icon: 'parcel' };
}

/** Characters, pets, badges and icons, z-sorted by foot y, then actorKey; looks by peer (or handle in the page). */
export function composeSprites(scene: Scene, layout: Layout, looks: ReadonlyMap<string, { hue: number; accessory: number }>, phase: SpritePhase): Rgba {
  const { w, h } = officeTiles(layout);
  const out = rgba(w * TILE_PX, h * TILE_PX);
  const bangOn = new Set<string>();
  for (const b of scene.bangs.values()) bangOn.add(actorKey(b.on));
  const ctx: Ctx = { out, scene, looks, phase, marks: beatMarks(scene.beat), bangOn };
  const reduced = phase.reduced;

  // Desk furniture of the moment: published screens, parcels, carts and lockboxes, "+n" chips.
  for (const d of layout.desks) {
    if (d.kind === 'big_table' || d.kind === 'shelf' || d.cell === null || phase.screen(d.ordinal) !== 'published') continue;
    const p = deskPx(layout, d.ordinal);
    paint(out, TILES.monitor, (k) => (k === 'l' ? ENV.screenPublished : null), p.x + MONITOR_DX, p.y + MONITOR_DY, false, 255);
  }
  // A desk's box row: at most three boxes in key order, then one "+n" chip (UI_VIZ_MORE; the page writes the number) in the
  // fourth slot, so the row stays inside the desk's slot (36 of its 48 px; 40 of the big table's 64).
  const onDesk = new Map<DeskRef, number>();
  const boxSlot = (d: DeskRef, i: number): { x: number; y: number } => {
    const p = deskPx(layout, d);
    return { x: p.x + (d === BIG_TABLE ? 4 : 1) + i * (BADGE + BADGE_GAP), y: p.y + (d === BIG_TABLE ? 4 : -3) };
  };
  for (const [, b] of [...scene.boxes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!deskOk(layout, b.desk)) continue;
    const i = onDesk.get(b.desk) ?? 0;
    onDesk.set(b.desk, i + 1);
    if (i >= BOXES_MAX) continue;
    const { map, icon } = boxForm(b);
    const at = boxSlot(b.desk, i);
    paint(out, map, iconColour(icon), at.x, at.y, false, 255);
  }
  for (const [d, n] of onDesk) {
    if (n <= BOXES_MAX) continue;
    const at = boxSlot(d, BOXES_MAX);
    paint(out, ICONS.more, iconColour('more'), at.x, at.y, false, 255);
  }
  for (const [d, ds] of [...scene.desks].sort(([a], [b]) => a - b)) {
    if (ds.more <= 0 || !deskOk(layout, d)) continue;
    // The "+n" chip (UI_VIZ_MORE; the number is the page's text): on the big table's right end, or on a slot's free aisle tile.
    const c = deskTiles(layout, d).chair;
    const p = d === BIG_TABLE ? { x: 20 * TILE_PX + 4, y: TILE_PX + 2 } : { x: (c.x + 2) * TILE_PX + 4, y: (c.y + 1) * TILE_PX + 4 };
    paint(out, ICONS.more, iconColour('more'), p.x, p.y, false, 255);
  }

  // Actors, z-sorted by foot y, then actor key; a visitor beyond the fourth tile is only counted in "+n".
  const hidden = (pl: Place): boolean => pl.at === 'visitor' && pl.tile >= VISITOR_TILES;
  const items: Array<{ key: string; foot: number; draw: () => void }> = [];
  for (const [peer, c] of scene.characters) {
    if (hidden(c.place)) continue;
    const key = actorKey({ peer });
    const tile = phase.tile(key);
    items.push({ key, foot: Math.round(tile.y * TILE_PX) + TILE_PX - 1, draw: () => drawCharacter(ctx, key, peer, c, tile) });
  }
  for (const [seat, p] of scene.pets) {
    if (!p.live) continue;                         // a poofed pet is kept in the scene (its variant stays taken), never drawn
    if (hidden(p.place)) continue;
    const key = actorKey({ seat });
    const tile = phase.tile(key);
    items.push({ key, foot: Math.round(tile.y * TILE_PX) + TILE_PX - 1, draw: () => drawPet(ctx, key, seat, p, tile) });
  }
  items.sort((a, b) => a.foot - b.foot || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const it of items) it.draw();

  // The beat's desk effects in a row above the desk, the first left of the monitor and the rest right of it: sparkle (reduced:
  // a star), "done" flag, green tick, "+n" planes; planes (reduced: dots) on the other desks; confetti (reduced: a stamp).
  const effects = (d: DeskRef, icons: readonly IconName[]): void => {
    const p = deskPx(layout, d);
    icons.forEach((icon, i) => {
      const dx = i === 0 ? 0 : MONITOR_DX + MONITOR_W + (i - 1) * (BADGE + BADGE_GAP);
      paint(out, ICONS[icon], iconColour(icon), p.x + dx, p.y - BADGE, false, 255);
    });
  };
  for (const e of scene.beat) {
    if (e.kind === 'publish') {
      if (deskOk(layout, e.target)) {
        const row: IconName[] = [reduced ? 'star' : 'sparkle'];
        if (e.state === 'closed') row.push('flag');
        if (e.checks === 'pass') row.push('tick');
        if (e.others.length > PLANES_MAX) row.push('more');
        effects(e.target, row);
      }
      for (const d of e.others.slice(0, PLANES_MAX)) {
        if (!deskOk(layout, d)) continue;
        const p = deskPx(layout, d);
        if (reduced) paint(out, DOT, whiteColour, p.x + 3, p.y - 5, false, 255);
        else paint(out, ICONS.plane, iconColour('plane'), p.x, p.y - BADGE, false, 255);
      }
    } else if (e.kind === 'save') {
      for (const d of e.desks) if (deskOk(layout, d)) effects(d, [reduced ? 'stamp' : 'confetti']);
    }
  }

  // The room: the base-move sign beside the door for 64 heights, the board-full cabinet (near_full: its outline) on the wall.
  if (scene.branchMovedAt !== null && scene.at.height - scene.branchMovedAt < SIGN_HEIGHTS) {
    paint(out, ICONS.sign, iconColour('sign'), (DOOR.x + 1) * TILE_PX + 4, DOOR.y * TILE_PX + 4, false, 255);
  }
  if (scene.badge !== 'none') {
    paint(out, scene.badge === 'full' ? ICONS.cabinet : CABINET_OUTLINE, iconColour('cabinet'), 20 * TILE_PX + 4, 4, false, 255);
  }
  return out;
}
