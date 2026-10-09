// The office and the map canvases (12 §3.5.1–§3.5.3, §3.6, §3.7; VIZ-13, VIZ-16, VIZ-19, VIZ-22, VIZ-23; R-V32, R-V51): the art
// layers composed at art resolution by render/raster.ts (the static layer only when the layout or its options change, the sprite
// layer per drawn frame), put into art-size offscreen canvases and drawn at an integer zoom Z (never ctx.scale(dpr); smoothing
// off; CSS pixelated); text — zone signs, plaques, name tags, the "you" marker, "+n" counts, place labels and bubbles — with
// fillText at device resolution on plates cached per (string, size, theme). Walks follow A* (ui/path.ts, cached per layout
// version) at 4 tiles/s within 3 s, poofing with no path or at ≥ 4× over 12 tiles; the loop (ui/loop.ts) draws at most 12
// frames/s and only when a frame index changes, and stops when paused, under reduced motion or with no actor on screen. The
// panel scrolls (the office grows downward; Z changes only on open, resize or a user zoom) and follows a new event's desk only
// when the reader has not scrolled for 30 s. Colours come only from the palette. Browser only.
import { actorKey } from '../model/events.js';
import { BIG_TABLE, DOOR, OFFICE_W, TILE_PX, cellOrigin, deskTiles, isBlocked, officeTiles, type Layout, type Tile } from '../model/layout.js';
import { placeLabel } from '../model/labels.js';
import type { Scene } from '../model/scene.js';
import { ENV, FIXED, ICON_TONES, PALETTE, mix, type Rgb } from '../render/palette.js';
import { blit, composeSprites, composeStatic, iconColour, placeTile, rgba, type Rgba, type SpritePhase } from '../render/raster.js';
import { ICONS, type FrameName } from '../render/sprites.js';
import type { LayoutVM, OverlayVM } from '../server/viewModel.js';
import { TRIP_MAX_MS, WALK_TILES_PER_S } from '../ui/anim.js';
import { BubbleSet } from '../ui/bubbles.js';
import { createLoop } from '../ui/loop.js';
import { headerLamp, roomDots, sceneOverlayMarks } from '../ui/map.js';
import { PathCache, findPath, shouldPoof } from '../ui/path.js';
import { staticFor } from '../ui/seek.js';
import { FollowRule, ZoomState, mapZoom } from '../ui/zoom.js';
import { placeText, type Translate } from './a11y.js';

type Look = { hue: number; accessory: number };

/** One room as the office draws it: its layout (model form and served form, for the sign and plaque text), looks and name tags by handle. */
export interface OfficeRoom {
  id: string; layout: Layout; layoutVM: LayoutVM; looks: ReadonlyMap<string, Look>; names: ReadonlyMap<string, string>;
}
/** One cell of the map (12 §3.5.1). */
export interface MapRoom {
  id: string; label: string; scene: Scene | null; looks: ReadonlyMap<string, Look>; homeOrder: readonly string[];
  down: boolean; noBoard: boolean; gone: boolean; overlay: OverlayVM | null;
}
export interface OfficeDeps {
  t: Translate;
  reduced(): boolean;
  paused(): boolean;
  /** A character (or a pet's owner) was clicked: filter the log to that person. */
  person(handle: string): void;
  /** A desk was clicked: filter the log to that file. */
  desk(desk: number): void;
  /** A map cell was clicked. */
  selectRoom(id: string): void;
  /** The person filter: that character's place label is drawn. */
  highlighted(): string | null;
}
export interface Office {
  room(r: OfficeRoom | null): void;
  /** The scene to draw. animate: walk to the new places and pop the beat's bubbles (a live beat or a replay step); else snap. */
  show(s: Scene, o: { live: boolean; overlay: OverlayVM | null; speed: number; animate: boolean }): void;
  toggleCoarse(): boolean;
  zoomBy(delta: number): void;
  resize(): void;
  /** Reduced motion or pause changed. */
  motion(): void;
  map(rooms: readonly MapRoom[], selected: string | null, focused: string | null): void;
  /** Live: scroll to a desk unless the reader scrolled in the last 30 s. */
  follow(desk: number): void;
  /** Labels in the current language (plates are cached per string, so nothing else changes). */
  relabel(): void;
}

const WALK_FRAMES: readonly FrameName[] = Object.freeze(['squash', 'rise', 'peak', 'land']);
const WALK_FRAME_MS = 100, IDLE_MS = 600, RELAXED_MS = 900;
const PATHS_MAX = 512, PLATES_MAX = 600;
const CELL_W = 48, CELL_H = 32;                     // a map cell, art px (12 §3.5.1)
const DOT = 4, DOT_GAP = 2, DOTS_PER_ROW = 8;
const TEXT_CSS_PX = 11, SMALL_CSS_PX = 9, PLATE_PAD = 2;
const DARK_QUERY = '(prefers-color-scheme: dark)';

/** A palette colour as a CSS colour (the one place a colour becomes a string). */
function cssColour(c: Rgb): string {
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
/** A palette colour over an Rgba rectangle (art px, clipped). */
function fill(out: Rgba, x0: number, y0: number, w: number, h: number, c: Rgb): void {
  for (let y = Math.max(0, y0); y < Math.min(out.h, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(out.w, x0 + w); x++) {
      const i = (y * out.w + x) * 4;
      out.data[i] = c[0]; out.data[i + 1] = c[1]; out.data[i + 2] = c[2]; out.data[i + 3] = 255;
    }
  }
}
function frame(out: Rgba, x0: number, y0: number, w: number, h: number, c: Rgb): void {
  fill(out, x0, y0, w, 1, c);
  fill(out, x0, y0 + h - 1, w, 1, c);
  fill(out, x0, y0, 1, h, c);
  fill(out, x0 + w - 1, y0, 1, h, c);
}

/** An Rgba into a canvas of its size (through ImageData; no smoothing is involved at 1:1). */
function put(c: HTMLCanvasElement, img: Rgba): void {
  if (c.width !== img.w) c.width = img.w;
  if (c.height !== img.h) c.height = img.h;
  const ctx = c.getContext('2d');
  if (ctx === null) return;
  const data = ctx.createImageData(img.w, img.h);
  data.data.set(img.data);
  ctx.putImageData(data, 0, 0);
}

/** A walk in progress or a standing actor: where it stands (or goes), its path and timing, its facing and idle phase. */
interface Motion { to: Tile; path: Tile[] | null; t0: number; dur: number; left: boolean; phase: number; pose: 'idle' | 'sit' | 'relaxed'; peer: string | null; }

export function createOffice(canvas: HTMLCanvasElement, mapCanvas: HTMLCanvasElement, scrollBox: HTMLElement, deps: OfficeDeps): Office {
  const { t } = deps;
  const zoom = new ZoomState(OFFICE_W * TILE_PX);
  const follow = new FollowRule();
  const paths = new PathCache(PATHS_MAX);
  const bubbles = new BubbleSet();
  const plates = new Map<string, HTMLCanvasElement>();
  const staticCanvas = document.createElement('canvas');
  const spriteCanvas = document.createElement('canvas');
  const darkQuery = window.matchMedia(DARK_QUERY);
  let opened = false;
  let room: OfficeRoom | null = null;
  let scene: Scene | null = null;
  let live = true;
  let overlay: OverlayVM | null = null;
  let staticKey = '';
  let programmaticScroll = false;
  const motions = new Map<string, Motion>();

  const dpr = (): number => (Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1);
  const still = (): boolean => deps.reduced() || deps.paused();

  // ---------------------------------------------------------------------------------------------------------
  // Motion: walks along A*, poofs, idle phases

  const walking = (m: Motion, now: number): boolean => m.path !== null && now < m.t0 + m.dur;
  /** The tile a motion shows at `now`: along its path while walking, else its target. */
  const tileAt = (m: Motion, now: number): Tile => {
    if (m.path === null || !walking(m, now) || m.path.length < 2) return m.to;
    const p = Math.max(0, Math.min(1, (now - m.t0) / m.dur)) * (m.path.length - 1);
    const i = Math.min(m.path.length - 2, Math.floor(p));
    const a = m.path[i]!, b = m.path[i + 1]!, f = p - i;
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
  };
  const frameAt = (m: Motion, now: number): FrameName => {
    // The loop's rAF time can precede the walk's start (a frame's time is taken before its callbacks run): clamp at the first frame.
    if (walking(m, now)) return WALK_FRAMES[Math.floor(Math.max(0, now - m.t0) / WALK_FRAME_MS) % WALK_FRAMES.length]!;
    if (still()) return 'idle0';
    const period = m.pose === 'relaxed' ? RELAXED_MS : IDLE_MS;
    return Math.floor(Math.max(0, now + m.phase) / period) % 2 === 0 ? 'idle0' : 'idle1';
  };
  /** The target tile and pose of every drawn actor of a scene, by actor key. */
  const targets = (s: Scene, layout: Layout): Map<string, { to: Tile; pose: Motion['pose']; seed: number; peer: string | null }> => {
    const out = new Map<string, { to: Tile; pose: Motion['pose']; seed: number; peer: string | null }>();
    let i = 0;
    for (const [peer, c] of s.characters) out.set(actorKey({ peer }), { to: placeTile(c.place, layout, s), pose: c.pose, seed: i++, peer });
    for (const [seat, p] of s.pets) if (p.live) out.set(actorKey({ seat }), { to: placeTile(p.place, layout, s), pose: p.pose, seed: i++, peer: null });
    return out;
  };

  const show = (s: Scene, o: { live: boolean; overlay: OverlayVM | null; speed: number; animate: boolean }): void => {
    const layout = room?.layout;
    scene = s;
    live = o.live;
    overlay = o.overlay;
    if (layout === undefined) return;
    const now = performance.now();
    const speed = Number.isFinite(o.speed) && o.speed > 0 ? o.speed : 1;
    const animate = o.animate && !still();
    const next = targets(s, layout);
    const size = officeTiles(layout);
    for (const key of [...motions.keys()]) if (!next.has(key)) motions.delete(key);
    for (const [key, tg] of next) {
      const m = motions.get(key);
      const phase = tg.seed % 2 === 0 ? 0 : IDLE_MS;
      if (m === undefined) {
        // A newcomer walks in from the door when the beat is animated; a pet appears in place (a puff).
        const from = tg.peer !== null && animate ? { x: DOOR.x, y: DOOR.y } : null;
        motions.set(key, { to: tg.to, path: null, t0: now, dur: 0, left: false, phase, pose: tg.pose, peer: tg.peer });
        if (from !== null) walk(motions.get(key)!, from, tg.to, layout, size, speed, now);
        continue;
      }
      m.pose = tg.pose;
      if (m.to.x === tg.to.x && m.to.y === tg.to.y) continue;
      const here = tileAt(m, now);
      m.to = tg.to;
      m.path = null;
      if (animate) walk(m, { x: Math.round(here.x), y: Math.round(here.y) }, tg.to, layout, size, speed, now);
    }
    if (animate && room !== null) {
      for (const e of s.beat) {
        if (e.kind === 'request_open' && e.note !== null) bubbles.show(actorKey(e.from), room.id, e.note, now, speed);
        else if (e.kind === 'answer' && e.note !== null) bubbles.show(actorKey(e.holder), room.id, e.note, now, speed);
        else if (e.kind === 'note') bubbles.show(actorKey(e.actor), room.id, e.text, now, speed);
      }
    }
    loop.wake();
  };

  /** Starts a walk from → to (A* cached per layout version); no path, or ≥ 4× over 12 tiles: the actor poofs to its target. */
  const walk = (m: Motion, from: Tile, to: Tile, layout: Layout, size: { w: number; h: number }, speed: number, now: number): void => {
    const path = paths.get(layout.version, from, to, () => findPath(from, to, (x) => isBlocked(layout, x), size));
    if (shouldPoof(path, speed) || path === null || path.length < 2) return;
    m.path = path;
    m.t0 = now;
    m.dur = Math.min(((path.length - 1) / WALK_TILES_PER_S) * 1_000, TRIP_MAX_MS) / speed;
    m.left = to.x < from.x;
  };

  // ---------------------------------------------------------------------------------------------------------
  // Text plates (fillText at device resolution, cached per string, size and theme)

  const plate = (text: string, px: number): HTMLCanvasElement => {
    const dark = darkQuery.matches;
    const key = `${dark ? 1 : 0}|${px}|${text}`;
    const hit = plates.get(key);
    if (hit !== undefined) return hit;
    if (plates.size >= PLATES_MAX) plates.clear();
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    const font = `${Math.round(px)}px system-ui, sans-serif`;
    let w = 1;
    if (ctx !== null) {
      ctx.font = font;
      w = Math.max(1, Math.ceil(ctx.measureText(text).width));
    }
    const pad = Math.round(PLATE_PAD * dpr());
    c.width = w + 2 * pad;
    c.height = Math.ceil(px * 1.3) + 2 * pad;
    const g = c.getContext('2d');
    if (g !== null) {
      g.fillStyle = cssColour(dark ? ENV.wall : FIXED.eyeWhite);
      g.fillRect(0, 0, c.width, c.height);
      g.font = font;
      g.textBaseline = 'top';
      g.fillStyle = cssColour(dark ? FIXED.eyeWhite : FIXED.pupil);
      g.fillText(text, pad, pad);
    }
    plates.set(key, c);
    return c;
  };
  /** A plate centred on (x, bottom) in device px. */
  const plateAt = (ctx: CanvasRenderingContext2D, text: string, px: number, x: number, bottom: number): void => {
    const p = plate(text, px);
    ctx.drawImage(p, Math.round(x - p.width / 2), Math.round(bottom - p.height));
  };

  // ---------------------------------------------------------------------------------------------------------
  // Drawing

  const sizeCanvas = (c: HTMLCanvasElement, aw: number, ah: number, z: number): void => {
    const w = aw * z, h = ah * z;
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    const r = dpr();
    c.style.width = `${w / r}px`;
    c.style.height = `${h / r}px`;
  };

  const phaseFor = (now: number): SpritePhase => {
    const s = scene!;
    const published = new Set<number>();
    for (const e of s.beat) if (e.kind === 'publish') published.add(e.target);
    const layout = room!.layout;
    return {
      reduced: deps.reduced(),
      frame: (key) => {
        const m = motions.get(key);
        return m === undefined ? 'idle0' : frameAt(m, now);
      },
      tile: (key) => {
        const m = motions.get(key);
        return m === undefined ? { x: DOOR.x, y: DOOR.y } : tileAt(m, now);
      },
      facingLeft: (key) => motions.get(key)?.left ?? false,
      screen: (desk) => (published.has(desk) && deskTiles(layout, desk).desk.length > 0 ? 'published' : 'idle'),
    };
  };

  /** The overlay of the own room on a live scene (VIZ-13: never on a past scene): the "you" arrow, parcels at "you", the cart and boxes at the door. */
  const overlayIcons = (out: Rgba, phase: SpritePhase): { you: Tile | null; parcels: number; cart: number; boxes: number } | null => {
    const marks = sceneOverlayMarks(overlay, !live);
    if (marks === null) return null;
    const you = marks.you !== null && scene!.characters.has(marks.you) ? phase.tile(actorKey({ peer: marks.you })) : null;
    if (you !== null) {
      blit(out, ICONS.you, iconColour('you'), Math.round(you.x * TILE_PX) + 4, Math.round(you.y * TILE_PX) - 2 * TILE_PX);
      if (marks.parcels > 0) blit(out, ICONS.parcel, iconColour('parcel'), Math.round(you.x * TILE_PX) + TILE_PX, Math.round(you.y * TILE_PX) + 4);
    }
    if (marks.cart > 0) blit(out, ICONS.cart, iconColour('cart'), (DOOR.x + 1) * TILE_PX, (DOOR.y + 1) * TILE_PX);
    if (marks.boxes > 0) blit(out, ICONS.parcel, iconColour('parcel'), (DOOR.x + 1) * TILE_PX + 9, (DOOR.y + 1) * TILE_PX);
    return { you, parcels: marks.parcels, cart: marks.cart, boxes: marks.boxes };
  };

  const draw = (now: number): void => {
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    if (room === null || scene === null) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const layout = room.layout;
    const s = scene;
    const tiles = officeTiles(layout);
    const aw = tiles.w * TILE_PX, ah = tiles.h * TILE_PX;
    const z = zoom.z;
    sizeCanvas(canvas, aw, ah, z);
    const so = staticFor(layout, s, { live, coarse: zoom.coarse });
    const key = `${layout.version}|${so.dashedFrom}|${[...so.dimmed].join(',')}|${so.coarse}|${[...so.lockboxDesks].join(',')}`;
    if (key !== staticKey || staticCanvas.width !== aw || staticCanvas.height !== ah) {
      put(staticCanvas, composeStatic(layout, so));
      staticKey = key;
    }
    const phase = phaseFor(now);
    const sprites = composeSprites(s, layout, room.looks, phase);
    const marks = overlayIcons(sprites, phase);
    put(spriteCanvas, sprites);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(staticCanvas, 0, 0, aw * z, ah * z);
    ctx.drawImage(spriteCanvas, 0, 0, aw * z, ah * z);
    text(ctx, s, layout, phase, z, now, marks);
  };

  /** Signs, plaques, counts, name tags, the "you" label, place labels and bubbles, in device px over the art. */
  const text = (ctx: CanvasRenderingContext2D, s: Scene, layout: Layout, phase: SpritePhase, z: number, now: number,
                marks: { you: Tile | null; parcels: number; cart: number; boxes: number } | null): void => {
    const r = dpr();
    const big = TEXT_CSS_PX * r, small = SMALL_CSS_PX * r;
    const px = (art: number): number => art * z;
    const vm = room!.layoutVM;
    if (!zoom.coarse) {
      for (const zn of vm.zones) {
        for (const g of zn.cells) {
          const o = cellOrigin(g);                       // the sign plate spans the cell's columns 0–5 of its row 0
          plateAt(ctx, zn.sign, small, px((o.x + 3) * TILE_PX), px(o.y * TILE_PX + 12));
        }
      }
      for (const d of vm.desks) {
        if (d.kind === 'big_table' || d.cell === null || d.slot === null || d.ordinal >= layout.desks.length) continue;
        const tl = deskTiles(layout, d.ordinal).desk[0]!;
        const label = d.kind === 'shelf' ? t('UI_VIZ_SHELF_DESK', { zone: vm.zones[d.zone ?? -1]?.sign ?? '?' }) : d.plaque;
        if (label !== null) plateAt(ctx, label, small, px(tl.x * TILE_PX + TILE_PX), px(tl.y * TILE_PX + TILE_PX + 6));
      }
    }
    // "+n": visitors beyond four, and boxes beyond three (raster.ts boxSlot geometry).
    for (const [d, ds] of s.desks) {
      if (ds.more <= 0 || d >= layout.desks.length) continue;
      const c = deskTiles(layout, d).chair;
      const at = d === BIG_TABLE ? { x: 20 * TILE_PX + 4, y: TILE_PX + 2 } : { x: (c.x + 2) * TILE_PX + 4, y: (c.y + 1) * TILE_PX + 4 };
      plateAt(ctx, t('UI_VIZ_MORE', { n: ds.more }), small, px(at.x + 4), px(at.y));
    }
    const boxes = new Map<number, number>();
    for (const b of s.boxes.values()) boxes.set(b.desk, (boxes.get(b.desk) ?? 0) + 1);
    for (const [d, n] of boxes) {
      if (n <= 3 || d >= layout.desks.length) continue;
      const tl = deskTiles(layout, d).desk[0]!;
      const x = tl.x * TILE_PX + (d === BIG_TABLE ? 4 : 1) + 3 * 9, y = tl.y * TILE_PX + (d === BIG_TABLE ? 4 : -3);
      plateAt(ctx, t('UI_VIZ_MORE', { n: n - 3 }), small, px(x + 4), px(y));
    }
    // A publish at the big table names its count.
    for (const e of s.beat) {
      if (e.kind === 'publish' && e.target === BIG_TABLE) plateAt(ctx, t('UI_VIZ_BIG_TABLE', { n: e.n }), small, px(19 * TILE_PX), px(TILE_PX));
    }
    // Name tags above the characters; the person filter's place label under its character.
    const highlighted = deps.highlighted();
    for (const [peer, c] of s.characters) {
      if (c.place.at === 'visitor' && c.place.tile >= 4) continue;
      const tile = phase.tile(actorKey({ peer }));
      const cx = px(tile.x * TILE_PX + TILE_PX / 2);
      plateAt(ctx, room!.names.get(peer) ?? peer, big, cx, px(tile.y * TILE_PX - 9));
      if (peer === highlighted) {
        const label = placeText(t, placeLabel(s, { peer }, layout));
        if (label !== null) plateAt(ctx, label, small, cx, px(tile.y * TILE_PX + TILE_PX) + small * 1.6);
      }
    }
    if (marks !== null) {
      if (marks.you !== null) {
        plateAt(ctx, t('UI_VIZ_YOU'), big, px(marks.you.x * TILE_PX + TILE_PX / 2), px(marks.you.y * TILE_PX - 2 * TILE_PX - 1));
        if (marks.parcels > 1) plateAt(ctx, t('UI_VIZ_MORE', { n: marks.parcels }), small, px(marks.you.x * TILE_PX + TILE_PX + 12), px(marks.you.y * TILE_PX + 4));
      }
      if (marks.cart > 1) plateAt(ctx, t('UI_VIZ_MORE', { n: marks.cart }), small, px((DOOR.x + 1) * TILE_PX + 4), px((DOOR.y + 1) * TILE_PX));
      if (marks.boxes > 1) plateAt(ctx, t('UI_VIZ_MORE', { n: marks.boxes }), small, px((DOOR.x + 1) * TILE_PX + 13), px((DOOR.y + 1) * TILE_PX));
    }
    // Bubbles above their actors (12 §3.8): at most one per actor and three per room, the lines of wrapBubble.
    for (const b of bubbles.active(now)) {
      const m = motions.get(b.actor);
      if (m === undefined) continue;
      const tile = tileAt(m, now);
      b.lines.forEach((line, i) => {
        plateAt(ctx, line, big, px(tile.x * TILE_PX + TILE_PX / 2), px(tile.y * TILE_PX - 9) - big * 1.4 * (b.lines.length - i));
      });
    }
  };

  /** Changes exactly when a drawn frame index, a walking tile or the bubble set changes. */
  const frameKey = (now: number): string => {
    const parts: string[] = [];
    for (const [key, m] of motions) {
      const tl = tileAt(m, now);
      parts.push(`${key}:${frameAt(m, now)}:${Math.round(tl.x * TILE_PX)}:${Math.round(tl.y * TILE_PX)}`);
    }
    parts.push(String(bubbles.active(now).length));
    return parts.join('|');
  };
  /** Nothing to animate: paused, reduced motion, nothing on screen. */
  const idle = (now: number): boolean => {
    if (scene === null || room === null || motions.size === 0) return bubbles.active(now).length === 0;
    if (!still()) return false;
    for (const m of motions.values()) if (walking(m, now)) return false;
    return bubbles.active(now).length === 0;
  };
  const loop = createLoop({ raf: (cb) => requestAnimationFrame(cb), cancel: (id) => cancelAnimationFrame(id) }, frameKey, idle, draw);

  // ---------------------------------------------------------------------------------------------------------
  // Input: clicks on actors and desks; scrolling

  canvas.addEventListener('click', (e) => {
    if (room === null || scene === null) return;
    const z = zoom.z, r = dpr();
    const ax = (e.offsetX * r) / z, ay = (e.offsetY * r) / z;
    const tile = { x: Math.floor(ax / TILE_PX), y: Math.floor(ay / TILE_PX) };
    const now = performance.now();
    for (const [peer] of scene.characters) {
      const m = motions.get(actorKey({ peer }));
      if (m === undefined) continue;
      const at = tileAt(m, now);
      if (Math.round(at.x) === tile.x && Math.round(at.y) === tile.y) return deps.person(peer);
    }
    for (const [seat, p] of scene.pets) {
      const m = motions.get(actorKey({ seat }));
      if (m === undefined || !p.live) continue;
      const at = tileAt(m, now);
      if (Math.round(at.x) === tile.x && Math.round(at.y) === tile.y) return deps.person(p.owner);
    }
    for (const d of room.layout.desks) {
      if (d.kind !== 'big_table' && (d.cell === null || d.slot === null)) continue;
      if (deskTiles(room.layout, d.ordinal).desk.some((x) => x.x === tile.x && x.y === tile.y)) return deps.desk(d.ordinal);
    }
  });
  scrollBox.addEventListener('scroll', () => {
    if (programmaticScroll) programmaticScroll = false;
    else follow.scrolled(performance.now());
  });

  // ---------------------------------------------------------------------------------------------------------
  // The map (12 §3.5.1): one 48 × 32 art cell per room in server order, drawn at max(1, Z − 1)

  let mapRooms: readonly MapRoom[] = [];
  mapCanvas.addEventListener('click', (e) => {
    const cellPx = (CELL_H * mapZoom(zoom.z)) / dpr();
    const i = Math.floor(e.offsetY / cellPx);
    const r = mapRooms[i];
    if (r !== undefined) deps.selectRoom(r.id);
  });
  const drawMap = (rooms: readonly MapRoom[], selected: string | null, focused: string | null): void => {
    mapRooms = rooms;
    const mz = mapZoom(zoom.z);
    const out = rgba(CELL_W, Math.max(1, CELL_H * rooms.length));
    const greyDot = mix(ENV.wall, FIXED.eyeWhite, 0.45);
    rooms.forEach((r, i) => {
      const y0 = i * CELL_H;
      const dots = r.scene === null ? { grey: r.down || r.noBoard || r.gone, dots: [] } : roomDots(r.scene, r.looks, r.homeOrder, { down: r.down, noBoard: r.noBoard, gone: r.gone });
      fill(out, 0, y0, CELL_W, CELL_H, dots.grey ? mix(ENV.wall, FIXED.eyeWhite, 0.15) : ENV.floorA);
      dots.dots.forEach((d, j) => {
        const x = (j % DOTS_PER_ROW) * (DOT + DOT_GAP) + 1, y = y0 + 16 + Math.floor(j / DOTS_PER_ROW) * (DOT + DOT_GAP);
        const c = d.hue === null ? greyDot : PALETTE.bodies[d.hue] ?? greyDot;
        if (d.hollow) frame(out, x, y, DOT, DOT, c);
        else fill(out, x, y, DOT, DOT, c);
      });
      const lamp = headerLamp(r.overlay);
      if (lamp !== null) fill(out, CELL_W - 6, y0 + 2, 4, 4, lamp.down ? greyDot : lamp.unreadable ? ICON_TONES.health[0] : ICON_TONES.tick[0]);
      if (r.id === selected) frame(out, 0, y0, CELL_W, CELL_H, ENV.accent);
      if (r.id === focused) frame(out, 1, y0 + 1, CELL_W - 2, CELL_H - 2, FIXED.eyeWhite);
    });
    const w = CELL_W * mz, h = out.h * mz;
    const art = document.createElement('canvas');
    put(art, out);
    sizeCanvas(mapCanvas, out.w, out.h, mz);
    const ctx = mapCanvas.getContext('2d');
    if (ctx === null) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(art, 0, 0, w, h);
    const small = SMALL_CSS_PX * dpr();
    rooms.forEach((r, i) => {
      const p = plate(r.label, small);
      ctx.drawImage(p, 2 * mz, i * CELL_H * mz + 2 * mz);
    });
  };
  darkQuery.addEventListener('change', () => {
    plates.clear();
    loop.wake();
  });

  return {
    room(r): void {
      room = r;
      staticKey = '';
      motions.clear();
      if (!opened && r !== null) {
        opened = true;
        zoom.open(scrollBox.clientWidth * dpr());
      }
      loop.wake();
    },
    show,
    toggleCoarse(): boolean {
      zoom.toggleCoarse();
      staticKey = '';
      loop.wake();
      return zoom.coarse;
    },
    zoomBy(delta): void {
      zoom.userZoom(delta);
      loop.wake();
    },
    resize(): void {
      zoom.resize(scrollBox.clientWidth * dpr());
      loop.wake();
    },
    motion(): void {
      if (still()) {
        const now = performance.now();
        for (const m of motions.values()) if (walking(m, now)) m.path = null;   // stop every walk where it ends
      }
      loop.wake();
    },
    map: drawMap,
    follow(desk): void {
      if (room === null || desk >= room.layout.desks.length || !follow.follow(performance.now())) return;
      const d = room.layout.desks[desk]!;
      if (d.kind !== 'big_table' && (d.cell === null || d.slot === null)) return;
      const y = (deskTiles(room.layout, desk).desk[0]!.y * TILE_PX * zoom.z) / dpr();
      if (y >= scrollBox.scrollTop && y <= scrollBox.scrollTop + scrollBox.clientHeight - TILE_PX) return;
      programmaticScroll = true;
      scrollBox.scrollTop = Math.max(0, y - scrollBox.clientHeight / 2);
    },
    relabel(): void {
      loop.wake();
    },
  };
}
