// The page's DOM conventions and accessibility (12 §3.10.7 "Client", §3.11 "Accessibility"; VIZ-25, VIZ-37, VIZ-40): the fixed
// enum map of classes (data never selects a class outside it), the one element helper (text reaches the DOM only through
// textContent), the office canvas's UI_VIZ_SCENE_SUMMARY label, the visually hidden people list (one button per character that
// filters the log), the polite live region rate-limited to one announcement per 10 s, and the reduced-motion and pause toggles
// (the OS setting with an in-page override in both directions; the root carries data-motion="reduced" while motion is reduced).
// (rev 2.5, F32; 12 §3.8.1, FEAT-F32-11) Each row of the hidden people list carries a second button, the follow toggle for that row's
// person (aria-pressed while the selected room follows them). Browser only; nothing here touches the DOM at module load.
import type { Params } from '../../i18n/render.js';
import type { Layout } from '../model/layout.js';
import type { PlaceLabel } from '../model/labels.js';
import type { Scene } from '../model/scene.js';
import type { CharacterVM } from '../server/viewModel.js';
import { ANNOUNCE_GAP_MS, Announcer, MotionPreference, peopleList, sceneSummaryParams } from '../ui/a11y.js';

/** Every class the page sets, and exactly the classes app.css declares (tested both ways). */
export const CLS = Object.freeze({
  app: 'app', top: 'top', banner: 'banner', status: 'status', notice: 'notice',
  lamp: 'lamp', lampOk: 'lamp-ok', lampWarn: 'lamp-warn', lampDown: 'lamp-down',
  main: 'main', map: 'map', rooms: 'rooms', room: 'room', office: 'office', scroll: 'scroll', caption: 'caption', pixel: 'pixel',
  log: 'log', now: 'now', filters: 'filters', filter: 'filter', cards: 'cards', card: 'card', cardSystem: 'card-system', head: 'head', swatch: 'swatch',
  name: 'name', text: 'text', quote: 'quote', chips: 'chips', chip: 'chip', meta: 'meta', answers: 'answers', newPill: 'new-pill',
  rewind: 'rewind', track: 'track', ticks: 'ticks', slider: 'slider', position: 'position', control: 'control',
  livePill: 'live-pill', liveOn: 'live-on', liveOff: 'live-off', controls: 'controls', srOnly: 'sr-only', people: 'people', person: 'person',
  hue0: 'hue-0', hue1: 'hue-1', hue2: 'hue-2', hue3: 'hue-3', hue4: 'hue-4', hue5: 'hue-5', hue6: 'hue-6',
});
export type Cls = (typeof CLS)[keyof typeof CLS];
/** A look's swatch by its hue index (12 §3.6: the seven body hues; app.css .hue-<i> is PALETTE.bodies[i]). */
export const HUE_CLS = Object.freeze([CLS.hue0, CLS.hue1, CLS.hue2, CLS.hue3, CLS.hue4, CLS.hue5, CLS.hue6]);

/** The page's renderer: renderWith over the fetched catalogs, channel viz, the page's language (main.ts). */
export type Translate = (code: string, params?: Params) => string;

/** A new element of a fixed tag with at most one class of the enum map, appended to parent when given. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: Cls | null, parent?: Element): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls !== null) node.className = cls;
  if (parent !== undefined) parent.append(node);
  return node;
}

/** A button whose label is text (textContent only). */
export function button(cls: Cls, parent: Element, onClick: () => void): HTMLButtonElement {
  const b = el('button', cls, parent);
  b.type = 'button';
  b.addEventListener('click', () => onClick());
  return b;
}

/** aria-pressed as a token of the DOM API. */
export function setPressed(b: HTMLElement, on: boolean): void {
  b.setAttribute('aria-pressed', String(on));
}

/** The text of a place label (R-V56): UI_VIZ_HOLDING {label} or UI_VIZ_LAST_SHARED_HERE {path, height} with the desk named by kind
 *  (model/labels.ts deskName); at the big table (path null) UI_VIZ_NOW_LAST_SHARED_TABLE {height}, as the now card says it (final
 *  review B3: never the '?' of an unverified path); null when none. */
export function placeText(t: Translate, p: PlaceLabel | null): string | null {
  if (p === null) return null;
  if (p.code === 'UI_VIZ_HOLDING') return t(p.code, { label: p.label ?? '?' });
  return p.path === null ? t('UI_VIZ_NOW_LAST_SHARED_TABLE', { height: p.height }) : t(p.code, { path: p.path, height: p.height });
}

export interface A11y {
  /** The motion the scene may show now: reduced by the OS or the page's toggle; paused by the pause toggle. */
  reduced(): boolean;
  paused(): boolean;
  /** The canvas label and the people list for the scene on screen. */
  scene(s: Scene | null, characters: readonly CharacterVM[], layout: Layout | null): void;
  /** A summary of what arrived; announced at most once per 10 s (the newest held one is announced when the gap has passed). */
  announce(summary: string): void;
  /** The control labels in the current language. */
  relabel(): void;
  /** The people list again (a follow started or ended: its toggles' aria-pressed). */
  refresh(): void;
}

const MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * The accessibility layer over the page's parts: `canvas` gets role img and its summary, `people` (a list) the hidden buttons,
 * `live` the announcements, `controls` the reduced-motion and pause toggles. onMotion runs whenever either toggle or the OS
 * setting changes; onPerson when a person's button is pressed (the log filters to that person); onFollow when a row's follow toggle
 * is pressed, and followed() names whom the selected room follows.
 */
export function createA11y(o: {
  root: HTMLElement; canvas: HTMLCanvasElement; people: HTMLElement; live: HTMLElement; controls: HTMLElement; t: Translate;
  onMotion(): void; onPerson(handle: string): void; onFollow(handle: string): void; followed(): string | null;
}): A11y {
  const { root, canvas, people, live, t } = o;
  canvas.setAttribute('role', 'img');
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('role', 'status');
  const query = window.matchMedia(MOTION_QUERY);
  const motion = new MotionPreference();                 // the page's toggle over the OS setting (ui/a11y.ts)
  let paused = false;
  const announcer = new Announcer(ANNOUNCE_GAP_MS);
  let flushTimer: number | null = null;
  let last: { s: Scene | null; characters: readonly CharacterVM[]; layout: Layout | null } = { s: null, characters: [], layout: null };
  let peopleKey = '';
  const peopleButtons = new Map<string, HTMLButtonElement>();   // handle → its button (a Map: handles are served strings, VIZ-37)
  const followButtons = new Map<string, HTMLButtonElement>();   // handle → its row's follow toggle

  const reduced = (): boolean => motion.reduced(query.matches);
  const motionButton = button(CLS.control, o.controls, () => {
    motion.toggle(query.matches);
    applyMotion(true);
  });
  const pauseButton = button(CLS.control, o.controls, () => {
    paused = !paused;
    setPressed(pauseButton, paused);
    o.onMotion();
  });
  setPressed(pauseButton, false);
  /** The root's data-motion and the toggle's state; notify: tell the page (never during construction, before the page's parts exist). */
  const applyMotion = (notify: boolean): void => {
    const r = reduced();
    if (r) root.setAttribute('data-motion', 'reduced');
    else root.removeAttribute('data-motion');
    setPressed(motionButton, r);
    if (notify) o.onMotion();
  };
  query.addEventListener('change', () => applyMotion(true));

  const relabel = (): void => {
    motionButton.textContent = t('UI_VIZ_CTRL_REDUCED_MOTION');
    pauseButton.textContent = t(paused ? 'UI_VIZ_CTRL_PLAY' : 'UI_VIZ_CTRL_PAUSE');
    peopleKey = '';                                      // the language changed: every row is rebuilt
    renderScene();
  };

  const renderScene = (): void => {
    const { s, characters, layout } = last;
    pauseButton.textContent = t(paused ? 'UI_VIZ_CTRL_PLAY' : 'UI_VIZ_CTRL_PAUSE');
    if (s === null || layout === null) {
      canvas.removeAttribute('aria-label');
      people.replaceChildren();
      peopleKey = '';
      peopleButtons.clear();
      followButtons.clear();
      return;
    }
    const followed = o.followed();
    const p = sceneSummaryParams(s);
    canvas.setAttribute('aria-label', t('UI_VIZ_SCENE_SUMMARY', { people: p.people, sessions: p.sessions, open: p.open, conflicts: p.conflicts }));
    const rows = peopleList(s, characters, layout).map((r) => {
      const parts = [r.name];
      // PH_FROZEN names its reason (the character's folded freeze code, nested only when it is a registered reason, R-V43).
      if (r.ph !== null) parts.push(t(r.ph, { reason: s.characters.get(r.handle)?.frozen ?? '?' }));
      const place = placeText(t, r.place);
      if (place !== null) parts.push(place);
      return { handle: r.handle, person: r.person, text: parts.join(' \u{00B7} '), follow: [t('UI_VIZ_CTRL_FOLLOW'), r.name].join(' \u{00B7} '), on: followed === r.person };
    });
    // Rebuilt only when a row changed, keeping the focused person's button focused (a live beat must not steal keyboard focus).
    const key = JSON.stringify(rows);
    if (key === peopleKey) return;
    peopleKey = key;
    const focused = [...peopleButtons].find(([, b]) => b === document.activeElement)?.[0] ?? null;
    const focusedFollow = [...followButtons].find(([, b]) => b === document.activeElement)?.[0] ?? null;
    peopleButtons.clear();
    followButtons.clear();
    people.replaceChildren(...rows.map((r) => {
      const li = el('li', null);
      const b = button(CLS.person, li, () => o.onPerson(r.person));   // a pet's row filters by its owner (VIZ-40)
      b.textContent = r.text;
      peopleButtons.set(r.handle, b);
      // The second button (12 §3.8.1): follow this row's person in the selected room (a pet's row: its owner), or stop.
      const f = button(CLS.person, li, () => o.onFollow(r.person));
      f.textContent = r.follow;
      setPressed(f, r.on);
      followButtons.set(r.handle, f);
      return li;
    }));
    if (focused !== null) peopleButtons.get(focused)?.focus({ preventScroll: true });
    if (focusedFollow !== null) followButtons.get(focusedFollow)?.focus({ preventScroll: true });
  };

  applyMotion(false);
  return {
    reduced,
    paused: () => paused,
    scene(s, characters, layout): void {
      last = { s, characters, layout };
      renderScene();
    },
    announce(summary: string): void {
      const now = performance.now();
      const said = announcer.offer(summary, now);
      if (said !== null) live.textContent = said;
      else if (flushTimer === null) {
        flushTimer = window.setTimeout(() => {
          flushTimer = null;
          const held = announcer.flush(performance.now());
          if (held !== null) live.textContent = held;
        }, ANNOUNCE_GAP_MS);
      }
    },
    relabel,
    refresh: renderScene,
  };
}
