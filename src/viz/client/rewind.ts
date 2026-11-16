// The rewind bar (12 §3.9.1, §3.11 "Keyboard"; VIZ-26, VIZ-40; R-V28): the axis is the selected room's window [h0, h1] in heights;
// its ticks differ by glyph shape (a small bar for a publish, "!" for a conflict, a speech glyph for a request, a star for a save,
// a door for joins and leaves, a snowflake for a freeze, and the page's own "caught up" marks), drawn from the art's 8×8 icons in
// the scene palette; hovering names the height and its card. Controls: play/pause, the slider (arrow keys ±1 height, PageUp and
// PageDown ±64; none with Ctrl, Meta or Alt; PageDown does nothing at the live tip), the speed selector, the live pill (back to the
// tip, following it; grey and not pressed whenever the stream is not live, VIZ-42) and "load earlier". Browser only.
import type { SceneEvent } from '../model/events.js';
import { iconColour, rgba, blit, type Rgba } from '../render/raster.js';
import { ICON_TONES } from '../render/palette.js';
import { ICONS, type IconName } from '../render/sprites.js';
import type { Tick } from '../server/viewModel.js';
import { keyActionFor, livePillState, modifiedKey, stepBy } from '../ui/a11y.js';
import { SPEEDS } from '../ui/anim.js';
import { CLS, button, el, setPressed, type Translate } from './a11y.js';

const TICK_PX = 8;
/** A publish: a small bar (2 × 6 art px) in the tick icon's main tone. */
const BAR_W = 2, BAR_H = 6;
const GLYPH_ICON: Readonly<Record<Tick['glyph'], IconName | null>> = Object.freeze({
  publish: null, conflict: 'bang', request: 'speech', save: 'star', door: 'door', freeze: 'snowflake',
});

/** R-V28: the tick of a scene event (for pages the page loads below the window, which the server serves without ticks). */
export function tickOf(e: SceneEvent): Tick | null {
  switch (e.kind) {
    case 'publish': return { h: e.height, glyph: 'publish' };
    case 'conflict': return { h: e.height, glyph: 'conflict' };
    case 'request_open': return { h: e.height, glyph: 'request' };
    case 'save': return { h: e.height, glyph: 'save' };
    case 'person_enter': case 'person_respawn': case 'person_exit': return { h: e.height, glyph: 'door' };
    case 'person_freeze': return { h: e.height, glyph: 'freeze' };
    default: return null;
  }
}

/** The publish tick: a bar in the palette (clipped to the strip). */
function bar(out: Rgba, x0: number, y0: number): void {
  const c = ICON_TONES.tick[0];
  for (let y = Math.max(0, y0); y < Math.min(out.h, y0 + BAR_H); y++) {
    for (let x = Math.max(0, x0); x < Math.min(out.w, x0 + BAR_W); x++) {
      const i = (y * out.w + x) * 4;
      out.data[i] = c[0]; out.data[i + 1] = c[1]; out.data[i + 2] = c[2]; out.data[i + 3] = 255;
    }
  }
}

export interface RewindState {
  h0: number; h1: number; at: number; live: boolean; playing: boolean; speed: number;
  /** The stream is not live (ui/a11y.ts streamStale: reconnecting, stopped, a refused link or a lost session): the live pill is grey. */
  stale: boolean;
  canEarlier: boolean; ticks: readonly Tick[]; caught: readonly number[];
}
export interface RewindDeps {
  t: Translate;
  seek(h: number): void;
  play(on: boolean): void;
  speed(s: number): void;
  live(): void;
  earlier(): void;
  /** The text of the card at a tick's height (its activity card for a publish), for the hover; null when none. */
  describe(h: number): string | null;
}
export interface Rewind {
  update(s: RewindState): void;
  relabel(): void;
}

export function createRewind(root: HTMLElement, deps: RewindDeps): Rewind {
  const { t } = deps;
  let state: RewindState = { h0: 0, h1: 0, at: 0, live: true, playing: false, speed: 1, stale: false, canEarlier: false, ticks: [], caught: [] };
  let drawnKey = '';

  const playButton = button(CLS.control, root, () => deps.play(!state.playing));
  const track = el('div', CLS.track, root);
  const ticks = el('canvas', CLS.ticks, track);
  ticks.classList.add(CLS.pixel);
  const slider = el('input', CLS.slider, track);
  slider.type = 'range';
  slider.step = String(1);
  const position = el('span', CLS.position, root);
  const speed = el('select', CLS.control, root);
  for (const s of SPEEDS) {
    const o = el('option', null, speed);
    o.value = String(s);
    o.textContent = `${s}\u{00D7}`;
  }
  speed.value = String(1);
  const livePill = button(CLS.livePill, root, () => deps.live());
  const earlier = button(CLS.control, root, () => deps.earlier());

  slider.addEventListener('input', () => deps.seek(Number(slider.value)));
  slider.addEventListener('keydown', (e) => {
    const action = keyActionFor(e.key, false, modifiedKey(e));   // the slider's own keys; none with Ctrl, Meta or Alt (12 §3.11)
    if (action === 'page_back' || action === 'page_fwd') {
      e.preventDefault();
      // ±64 within the window; PageDown at the live tip does nothing (12 §3.9.1: live already shows the tip and follows it).
      const by = stepBy(action, state.live && state.at === state.h1);
      if (by !== null) deps.seek(Math.min(state.h1, Math.max(state.h0, state.at + by)));
    }
  });
  speed.addEventListener('change', () => deps.speed(Number(speed.value)));
  ticks.addEventListener('pointermove', (e) => {
    const h = heightAt(e.offsetX);
    if (h === null) {
      ticks.title = '';
      return;
    }
    const text = deps.describe(h);
    ticks.title = text === null ? `#${h}` : `#${h} \u{00B7} ${text}`;
  });

  /** The tick nearest to a pointer x (CSS px), within half a glyph; null when none. */
  const heightAt = (x: number): number | null => {
    let best: { h: number; d: number } | null = null;
    for (const k of state.ticks) {
      const d = Math.abs(xOf(k.h) + TICK_PX / 2 - x);
      if (d <= TICK_PX / 2 && (best === null || d < best.d)) best = { h: k.h, d };
    }
    return best === null ? null : best.h;
  };
  const xOf = (h: number): number => {
    const w = Math.max(TICK_PX, ticks.width - TICK_PX);
    const span = Math.max(1, state.h1 - state.h0);
    return Math.round(((h - state.h0) / span) * w);
  };

  /** The tick strip: one 8×8 glyph per tick in the art's palette, redrawn only when the ticks, the window or the width change. */
  const drawTicks = (): void => {
    const w = Math.max(TICK_PX, Math.floor(track.clientWidth));
    const key = `${w}:${state.h0}:${state.h1}:${state.ticks.length}:${state.caught.length}`;
    if (key === drawnKey) return;
    drawnKey = key;
    ticks.width = w;
    ticks.height = TICK_PX;
    const out = rgba(w, TICK_PX);
    for (const k of state.ticks) {
      const icon = GLYPH_ICON[k.glyph];
      if (icon === null) bar(out, xOf(k.h) + 3, 1);
      else blit(out, ICONS[icon], iconColour(icon), xOf(k.h), 0);
    }
    for (const h of state.caught) blit(out, ICONS.caught_up, iconColour('caught_up'), xOf(h), 0);
    const ctx = ticks.getContext('2d');
    if (ctx === null) return;
    const img = ctx.createImageData(out.w, out.h);
    img.data.set(out.data);
    ctx.putImageData(img, 0, 0);
  };

  const relabel = (): void => {
    playButton.textContent = t(state.playing ? 'UI_VIZ_CTRL_PAUSE' : 'UI_VIZ_CTRL_PLAY');
    // The slider's accessible name (12 §3.9.1, the Task 14 ruling): UI_VIZ_CTRL_POSITION; aria-valuetext reads the height (#h).
    slider.setAttribute('aria-label', t('UI_VIZ_CTRL_POSITION'));
    speed.setAttribute('aria-label', t('UI_VIZ_CTRL_SPEED'));
    livePill.textContent = t('UI_VIZ_CTRL_LIVE');
    earlier.textContent = t('UI_VIZ_CTRL_LOAD_EARLIER');
  };

  return {
    update(s: RewindState): void {
      const ticksChanged = s.ticks !== state.ticks || s.caught !== state.caught || s.h0 !== state.h0 || s.h1 !== state.h1;
      state = s;
      if (ticksChanged) drawnKey = '';
      slider.min = String(s.h0);
      slider.max = String(s.h1);
      slider.value = String(s.at);
      slider.setAttribute('aria-valuetext', `#${s.at}`);
      position.textContent = `#${s.at}`;
      speed.value = String(s.speed);
      setPressed(playButton, s.playing);
      // VIZ-42: the live look and aria-pressed only on a live stream; grey whenever it is stale (ui/a11y.ts livePillState).
      const pill = livePillState(s);
      setPressed(livePill, pill.pressed);
      livePill.classList.toggle(CLS.liveOn, pill.on);
      livePill.classList.toggle(CLS.liveOff, pill.off);
      earlier.disabled = !s.canEarlier;
      relabel();
      drawTicks();
    },
    relabel,
  };
}
