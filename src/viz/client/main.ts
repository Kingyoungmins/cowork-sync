// The page (12-visualizer §3.5–§3.11; bundled as an iife into dist/viz.js as /app.js, §3.13 "Build"). boot() removes the launch
// fragment with history.replaceState(null, '', '/') before any request (§3.10.2), then runs the connection (ui/conn.ts over
// client/api.ts): redemption or the tab's stored session, the world, the stream. Every human string is renderWith over the
// catalogs of /api/v1/strings (VIZ-39, ui/strings.ts); before a session there are none, so the four sessionless states come from
// the page's bundled en table. The page keeps per room the head layout, looks, name tags, the log and what it holds of the
// timeline (ui/roomView.ts: the world's head scene, the stream's events, timeline pages loaded below it, the seek cache, the live
// queue); live beats play at 300 ms and snap to the newest scene after a 5 s backlog; replay steps at 800 ms / k and draws only
// heights the page holds — a seek to a height still loading keeps the last frame until it arrives (§3.9.1, VIZ-26). Demo mode
// shows its banner and plays from h0 with its captions (R-V32). (rev 2.5, F32; Task 19) One FollowSet per page, in memory only
// (FEAT-F32-01): a room's follow pins the log's person filter while that room is selected, the office consults the follow camera
// instead of the 30 s rule there, and the now card above the log is recomputed from the scene on screen after each beat and seek.
// Browser only: DOM, canvas and event glue (R-V33).
import { LANGS, type Lang, type Params } from '../../i18n/render.js';
import type { SceneEvent } from '../model/events.js';
import { deskName } from '../model/labels.js';
import type { Layout } from '../model/layout.js';
import type { Scene } from '../model/scene.js';
import type {
  ActorVM, CaptionVM, CardVM, CharacterVM, LayoutVM, OverlayVM, PetVM, RoomVM, StreamPayload, Tick, TimelinePage, World,
} from '../server/viewModel.js';
import { keyActionFor, lampCode, modifiedKey, stepBy, streamStale } from '../ui/a11y.js';
import { LIVE_BEAT_MS, replayBeatMs, SPEEDS } from '../ui/anim.js';
import { Connection, firstRoom, type ConnIo, type ConnState } from '../ui/conn.js';
import { beatScroll, FollowSet, nowCard, nowRows } from '../ui/follow.js';
import { consumeLaunchToken } from '../ui/fragment.js';
import { cardText, LogModel } from '../ui/logModel.js';
import { headerLamp } from '../ui/map.js';
import { LivePlayer, RoomView, type ViewPage } from '../ui/roomView.js';
import { PageCatalogs } from '../ui/strings.js';
import { applyLayoutDeltaVM, unprojectEvent, unprojectLayout, unprojectScene } from '../ui/unproject.js';
import { CLS, button, createA11y, el, setPressed, type A11y } from './a11y.js';
import { createConnIo } from './api.js';
import { createLogPanel, type LogPanel } from './log.js';
import { createOffice, type Office } from './office.js';
import { createRewind, tickOf, type Rewind } from './rewind.js';

const LANG_KEY = 'UI_VIZ_CTRL_LANGUAGE';               // localStorage: the language switcher's choice (a per-viewer convenience)
const SEEN_REFRESH_MS = 60_000;
const STATE_CODE: Readonly<Record<ConnState, string | null>> = Object.freeze({
  booting: null, live: null, reconnecting: 'UI_VIZ_RECONNECTING', stopped: 'UI_VIZ_STOPPED', link_reused: 'UI_VIZ_LINK_REUSED',
  link_expired: 'UI_VIZ_LINK_EXPIRED', need_link: 'UI_VIZ_NEED_LINK',
});

type Look = { hue: number; accessory: number };
/** A timeline page as read (ui/roomView.ts's ViewPage) with the served page it came from (its cards and layout delta). */
type PageOf = ViewPage & { vm: TimelinePage };
/** What the page holds of one room. */
interface RoomState {
  id: string; label: string; branch: string; gone: boolean; badges: string[]; unknown: number;
  layoutVM: LayoutVM; layout: Layout;
  looks: Map<string, Look>; characters: Map<string, CharacterVM>; pets: Map<string, PetVM>; names: Map<string, string>;
  owners: Map<string, string>;                          // seat handle → owner handle, from served pets and pet events (R-V47)
  overlay: OverlayVM | null;
  tl: RoomView<PageOf>;                                 // the timeline the page holds (segments, events, pages, seek cache, loads)
  live: LivePlayer;                                     // live: the scene on screen and the events not yet played
  log: LogModel;
  textVersion: number;                                  // bumped when a name tag, a look or a pet's owner changes (the log rebuilds)
  ticks: Tick[]; caught: number[];
  captions: Map<number, CaptionVM[]>;
}

/** The page's language: the switcher's stored choice, else the browser's language among the six, else en. */
function initialLang(): Lang {
  try {
    const kept = localStorage.getItem(LANG_KEY);
    const hit = LANGS.find((l) => l === kept);
    if (hit !== undefined) return hit;
  } catch {
    // no storage: the browser's language
  }
  const nav = typeof navigator === 'object' ? navigator.language.toLowerCase() : '';
  return LANGS.find((l) => nav === l.toLowerCase() || nav.startsWith(l.slice(0, 2).toLowerCase())) ?? LANGS[0]!;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function isPage(v: unknown): v is TimelinePage {
  return isObject(v) && typeof v['room_id'] === 'string' && typeof v['from'] === 'number' && typeof v['to'] === 'number' && isObject(v['scene'])
    && Array.isArray(v['events']) && Array.isArray(v['cards']);
}

export function boot(): void {
  // 12 §3.10.2: the launch fragment leaves the URL bar before any request.
  const launch = consumeLaunchToken({ hash: location.hash, clear: () => history.replaceState(null, '', '/') });
  const io: ConnIo = createConnIo();
  const strings = new PageCatalogs();
  let lang: Lang = initialLang();
  const t = (code: string, params: Params = {}): string => strings.render(code, params, lang);
  const hasStrings = (): boolean => strings.has(lang);

  // ---------------------------------------------------------------------------------------------------------
  // The DOM, in the Tab order of 12 §3.11: map rooms → people list → log filters → cards → rewind bar → controls

  const root = document.getElementById('app') ?? document.body;
  const appRoot = document.documentElement;
  const app = el('div', CLS.app, root);
  const top = el('header', CLS.top, app);
  const banner = el('div', CLS.banner, top);
  banner.hidden = true;
  const lamp = el('span', CLS.lamp, top);
  lamp.hidden = true;
  lamp.setAttribute('role', 'img');                    // the light with a label (VIZ-19: never colour alone)
  const roomTitle = el('span', CLS.status, top);
  const status = el('div', CLS.status, top);
  status.setAttribute('role', 'status');
  const notice = el('div', CLS.notice, top);
  const main = el('div', CLS.main, app);
  const mapNav = el('nav', CLS.map, main);
  const mapCanvas = el('canvas', CLS.pixel, mapNav);
  const roomList = el('ul', CLS.rooms, mapNav);
  roomList.classList.add(CLS.srOnly);
  const officeSection = el('section', CLS.office, main);
  const people = el('ul', CLS.people, officeSection);
  people.classList.add(CLS.srOnly);
  const scrollBox = el('div', CLS.scroll, officeSection);
  const canvas = el('canvas', CLS.pixel, scrollBox);
  const caption = el('div', CLS.caption, officeSection);
  const logAside = el('aside', CLS.log, main);
  const live = el('div', CLS.srOnly, app);
  const rewindBar = el('footer', CLS.rewind, app);
  const controls = el('div', CLS.controls, app);

  // ---------------------------------------------------------------------------------------------------------
  // State

  let connState: ConnState = 'booting';
  let world: World | null = null;
  const rooms = new Map<string, RoomState>();
  let order: string[] = [];
  let selected: string | null = null;
  let focusedRoom: string | null = null;
  /** live, or replay at `at` (always a height the page holds while shown). */
  const mode = { live: true, at: 0, playing: false, speed: 1 };
  /** A seek to a height the selected room is still loading: shown (and then played, if asked) once it is held; the last frame
   *  stays meanwhile. Each new seek replaces it. */
  let pending: { h: number; play: boolean } | null = null;
  let beatTimer: number | null = null;
  let stepTimer: number | null = null;
  let captionUntil: number | null = null;
  /** Who each room follows (12 §3.8.1): page memory only — never sent, stored, logged or put in the fragment (FEAT-F32-01). */
  const follows = new FollowSet((room, n) => {
    // FEAT-F32-11 (SHOULD): the selected room's follow start and end, whatever caused them, are offered to the announcer (≤ 1 per 10 s).
    if (room === selected) a11y.announce(t(n.code, { name: sel()?.names.get(n.peer) ?? n.peer }));
  });

  const sel = (): RoomState | null => (selected === null ? null : rooms.get(selected) ?? null);
  /** A card's desk named by kind in the selected room (cardText's {path} when the card has no file chip; final review group B). */
  const deskNameOfSel = (d: number): string | null => { const r = sel(); return r === null ? null : deskName(r.layout, d); };
  /** The peer the selected room follows, or null. */
  const followed = (): string | null => (selected === null ? null : follows.get(selected));
  const session = (): string => io.storage.get().session ?? '';
  const withSession = (): { method: 'GET'; headers: Record<string, string> } => ({ method: 'GET', headers: { 'X-Cowork-Session': session() } });

  // ---------------------------------------------------------------------------------------------------------
  // Parts

  const a11y: A11y = createA11y({
    root: appRoot, canvas, people, live, controls, t,
    onMotion: () => office.motion(),
    onPerson: (h) => filterPerson(h),
    onFollow: (h) => followPerson(h),
    followed: () => followed(),
  });
  const office: Office = createOffice(canvas, mapCanvas, scrollBox, {
    t,
    reduced: () => a11y.reduced(),
    paused: () => a11y.paused(),
    person: (h) => filterPerson(h),
    desk: (d) => {
      logPanel.desk(d);
      renderLog();
    },
    selectRoom: (id) => select(id),
    highlighted: () => logPanel.filter().peer,
    followed: () => followed(),
  });
  const logPanel: LogPanel = createLogPanel(logAside, {
    t,
    nameOf: (a) => nameOf(a),
    hueOf: (a) => {
      const r = sel();
      const h = r === null ? null : personOf(a);
      return r === null || h === null ? null : r.looks.get(h)?.hue ?? null;
    },
    personOf: (a) => personOf(a),
    deskOfPath: (p) => sel()?.layoutVM.desks.find((d) => d.path === p)?.ordinal ?? null,
    deskNameOf: (d) => deskNameOfSel(d),
    pathOfDesk: (d) => {
      const desk = sel()?.layoutVM.desks[d];
      return desk === undefined ? null : desk.path ?? desk.plaque;
    },
    changed: () => {
      filterChanged();
      renderLog();
      redraw();
    },
    version: () => sel()?.textVersion ?? 0,
    following: () => followed() !== null,
    toggleFollow: () => toggleFollow(),
    recentre: () => office.camera('chip'),
  });
  const rewind: Rewind = createRewind(rewindBar, {
    t,
    seek: (h) => seek(h),
    play: (on) => {
      const r = sel();
      if (r === null) return;
      if (on && mode.live) return seek(r.tl.h0, true);   // from live: replay the window from h0
      play(on);
    },
    speed: (s) => {
      mode.speed = SPEEDS.includes(s) ? s : 1;
      updateRewind();
    },
    live: () => goLive(),
    earlier: () => {
      const r = sel();
      if (r !== null) void r.tl.earlier().then(() => { if (r === sel()) office.camera('earlier'); });
    },
    describe: (h) => {
      const r = sel();
      if (r === null) return null;
      // The tick's card from the log's own store (≤ 2,000 per room, the oldest dropped first): a publish tick's activity card.
      const cards = r.log.at(h);
      const c = cards.find((x) => x.code === 'UI_VIZ_CARD_PUBLISH') ?? cards[0];
      if (c !== undefined) return cardLine(c);
      return r.caught.includes(h) ? t('UI_VIZ_CAUGHT_UP') : null;
    },
  });

  // The controls after the rewind bar: language, zoom, the coarse view (the a11y toggles are created in createA11y).
  const langSelect = el('select', CLS.control, controls);
  for (const l of LANGS) {
    const o = el('option', null, langSelect);
    o.value = l;
    o.textContent = l;
  }
  langSelect.value = lang;
  langSelect.addEventListener('change', () => void setLang(langSelect.value));
  const zoomOut = button(CLS.control, controls, () => office.zoomBy(-1));
  zoomOut.textContent = '\u{2212}';
  const zoomIn = button(CLS.control, controls, () => office.zoomBy(1));
  zoomIn.textContent = '+';
  const coarse = button(CLS.control, controls, () => setPressed(coarse, office.toggleCoarse()));
  setPressed(coarse, false);

  // ---------------------------------------------------------------------------------------------------------
  // Names, looks and text

  function personOf(a: ActorVM): string | null {
    if ('peer' in a) return a.peer;
    return sel()?.owners.get(a.seat) ?? null;
  }
  function nameOf(a: ActorVM): string {
    const r = sel();
    const h = personOf(a);
    if (h === null) return '?';
    return r?.names.get(h) ?? h;
  }
  function cardLine(c: CardVM): string {
    const x = cardText(c, nameOf, deskNameOfSel);
    return t(x.code, x.params);
  }

  /** /api/v1/strings for l, once per language; the answer is filed under the language it names (ui/strings.ts). */
  async function loadStrings(l: Lang): Promise<void> {
    if (strings.asked(l)) return;
    try {
      const res = await io.request({ r: 'strings', lang: l }, withSession());
      if (res.status === 200) strings.accept(l, res.json);
    } catch {
      // no catalog yet: asked again on the next world or language change
    }
  }
  async function setLang(value: string): Promise<void> {
    const l = LANGS.find((x) => x === value);
    if (l === undefined) return;
    lang = l;
    try {
      localStorage.setItem(LANG_KEY, l);
    } catch {
      // a per-viewer convenience only
    }
    await loadStrings(l);
    relabel();
  }
  function relabel(): void {
    // Two buttons, two names (12 §3.11): the control code with the sign each one shows.
    zoomOut.setAttribute('aria-label', `${t('UI_VIZ_CTRL_ZOOM')} \u{2212}`);
    zoomIn.setAttribute('aria-label', `${t('UI_VIZ_CTRL_ZOOM')} +`);
    coarse.textContent = t('UI_VIZ_CTRL_COARSE');
    langSelect.setAttribute('aria-label', t('UI_VIZ_CTRL_LANGUAGE'));
    a11y.relabel();
    logPanel.relabel();
    rewind.relabel();
    office.relabel();
    refresh();
  }

  // ---------------------------------------------------------------------------------------------------------
  // Rooms from the world and the stream

  function roomOf(vm: RoomVM, captions: readonly CaptionVM[]): RoomState {
    const layout = unprojectLayout(vm.layout);
    const start = unprojectScene(vm.scene);
    const r: RoomState = {
      id: vm.room_id, label: vm.label, branch: vm.branch, gone: vm.gone, badges: [...vm.badges], unknown: vm.unknown,
      layoutVM: vm.layout, layout,
      looks: new Map(vm.looks), characters: new Map(vm.characters.map((c) => [c.handle, c])), pets: new Map(vm.pets.map((p) => [p.seat, p])),
      owners: new Map([...vm.scene.pets.map(([seat, p]): [string, string] => [seat, p.owner]), ...vm.pets.map((p): [string, string] => [p.seat, p.owner])]),
      names: new Map(vm.characters.map((c) => [c.handle, c.name])), overlay: vm.overlay,
      tl: null as unknown as RoomView<PageOf>, live: null as unknown as LivePlayer,
      log: new LogModel(), textVersion: 0, ticks: [...vm.ticks], caught: [], captions: new Map(),
    };
    r.tl = new RoomView<PageOf>(vm.room_id, start, vm.window, layout, {
      page: (from, to) => fetchPage(r, from, to),
      merged: (pages) => mergedPages(r, pages),
      changed: () => loadChanged(r),
    });
    r.live = new LivePlayer(start, () => r.layout);
    addCards(r, vm.cards);
    for (const c of captions) {
      if (c.room_id !== r.id) continue;
      const list = r.captions.get(c.height) ?? [];
      list.push(c);
      r.captions.set(c.height, list);
    }
    return r;
  }
  function addCards(r: RoomState, cards: readonly CardVM[]): void {
    r.log.add(cards, performance.now());
  }
  /** A pet event names its owner (R-V47): the log names a pet's cards after it, never parsing the seat handle. */
  function learnOwner(r: RoomState, e: SceneEvent): void {
    if ((e.kind === 'pet_spawn' || e.kind === 'pet_poof') && r.owners.get(e.seat) !== e.owner) {
      r.owners.set(e.seat, e.owner);
      r.textVersion++;
    }
  }
  function setLayout(r: RoomState, l: LayoutVM): void {
    r.layoutVM = l;
    r.layout = unprojectLayout(l);
    r.tl.setLayout(r.layout);
  }
  function upsert(r: RoomState, characters: readonly CharacterVM[], pets: readonly PetVM[]): void {
    for (const c of characters) {
      const look = r.looks.get(c.handle);
      if (r.names.get(c.handle) !== c.name || look?.hue !== c.hue || look.accessory !== c.accessory) r.textVersion++;
      r.characters.set(c.handle, c);
      r.names.set(c.handle, c.name);
      r.looks.set(c.handle, { hue: c.hue, accessory: c.accessory });
    }
    for (const p of pets) {
      if (r.owners.get(p.seat) !== p.owner) r.textVersion++;
      r.pets.set(p.seat, p);
      r.owners.set(p.seat, p.owner);
    }
  }

  function onWorld(w: World): void {
    world = w;
    const prev = selected;
    // A world reload ends a room's follow when the room no longer lists the followed handle (R-V22: extended after a collision).
    for (const vm of w.rooms) follows.worldReloaded(vm.room_id, new Set(vm.characters.map((c) => c.handle)));
    rooms.clear();
    for (const vm of w.rooms) rooms.set(vm.room_id, roomOf(vm, w.captions));
    order = w.rooms.map((r) => r.room_id);
    selected = firstRoom(w, prev ?? io.storage.get().room);
    keepFilters();
    stopTimers();
    pending = null;
    mode.live = true;
    mode.playing = false;
    void loadStrings(lang).then(() => {
      relabel();
      enterRoom(true);
      if (w.demo) startDemo();
    });
    enterRoom(true);
  }
  /** The log filters after a world reload (12 §3.8 "Filters", §3.8.1; R-V22): the selected room's follow, when the follow set kept it,
   *  pins the person filter; else a person filter on a handle the room no longer lists (extended after a collision) is cleared, and so
   *  is a file filter on a desk beyond the room's layout. */
  function keepFilters(): void {
    const r = sel();
    const f = logPanel.filter();
    const pinned = selected === null ? null : follows.get(selected);
    if (pinned !== null) logPanel.person(pinned);
    else if (f.peer !== null && (r === null || !r.characters.has(f.peer))) logPanel.person(null);
    if (f.desk !== null && (r === null || f.desk >= r.layout.desks.length)) logPanel.desk(null);
  }

  function onPayload(p: StreamPayload): void {
    switch (p.type) {
      case 'timeline': {
        const r = rooms.get(p.room_id);
        if (r === undefined) return;
        upsert(r, p.characters, p.pets);
        const events = p.events.map(unprojectEvent);
        for (const e of events) learnOwner(r, e);
        const added = r.tl.append(events, p.h1);
        for (const vm of p.events) if (vm.kind === 'request_status') r.log.status(vm);
        addCards(r, p.cards);
        r.ticks.push(...p.ticks);
        if (r.id === selected && mode.live) {
          r.live.push(added);
          if (p.cards.length > 0) a11y.announce(cardLine(p.cards[p.cards.length - 1]!));
          scheduleBeat();
        } else r.live.reset(r.tl.head());
        return roomChanged(r);
      }
      case 'room_snapshot': {
        const r = rooms.get(p.room_id);
        if (r === undefined) return;
        const start = unprojectScene(p.scene);
        for (const [seat, pet] of p.scene.pets) {
          if (r.owners.get(seat) !== pet.owner) r.textVersion++;
          r.owners.set(seat, pet.owner);
        }
        upsert(r, p.characters, p.pets);
        r.tl.snapshot(start, p.window);
        r.live.reset(start);
        // The ticks of the newly folded heights (8a final review B1): appended, as the tick-only timeline parts that may follow are.
        r.ticks.push(...p.ticks);
        r.caught = [...r.caught, p.window.h1];
        addCards(r, p.cards);
        if (r.id === selected) {
          if (mode.live) {
            office.show(start, { live: true, overlay: r.overlay, speed: 1, animate: false });
            office.camera('snapshot');
            a11y.scene(start, [...r.characters.values()], r.layout);
          } else if (pending === null && !r.tl.holds(mode.at)) {
            // The replay position is no longer held (the view restarted at the new tip): it loads again; the last frame stays.
            pending = { h: mode.at, play: false };
            void r.tl.want(mode.at);
          }
        }
        return roomChanged(r);
      }
      case 'layout': {
        const r = rooms.get(p.room_id);
        if (r === undefined) return;
        const l = applyLayoutDeltaVM(r.layoutVM, p.layout);
        if (l !== 'reload') setLayout(r, l);
        return roomChanged(r);
      }
      case 'overlay': {
        const r = rooms.get(p.room_id);
        if (r === undefined) return;
        r.overlay = p.overlay;
        if (r.id === selected && mode.live) office.show(r.live.scene(), { live: true, overlay: r.overlay, speed: 1, animate: false });
        return roomChanged(r);
      }
      case 'room': {
        const r = rooms.get(p.room_id);
        if (r === undefined) return;
        r.label = p.label;
        r.branch = p.branch;
        r.gone = p.gone;
        r.badges = [...p.badges];
        r.unknown = p.unknown;
        return roomChanged(r);
      }
      default:
        return;                                         // reset, bye: the connection reloads or stops
    }
  }
  /** A payload changed room r: the selected room re-renders its header, log and rewind bar; any other room only its map cell. */
  function roomChanged(r: RoomState): void {
    if (r.id === selected) refresh();
    else renderMap();
  }

  // ---------------------------------------------------------------------------------------------------------
  // Live beats, replay steps and seeking

  function stopTimers(): void {
    if (beatTimer !== null) clearTimeout(beatTimer);
    if (stepTimer !== null) clearTimeout(stepTimer);
    beatTimer = null;
    stepTimer = null;
  }
  /** The caption of a beat (demo, R-V32): shown from its height for one beat. */
  function captionFor(r: RoomState, h: number, beatMs: number): void {
    const list = r.captions.get(h);
    const c = list?.[0];
    if (c === undefined) {
      if (captionUntil !== null && performance.now() >= captionUntil) {
        caption.textContent = '';
        caption.classList.remove(CLS.quote);
        captionUntil = null;
      }
      return;
    }
    if (c.code !== null) {
      caption.textContent = t(c.code);
      caption.classList.remove(CLS.quote);
    } else {
      caption.textContent = c.text ?? '';
      caption.classList.add(CLS.quote);                // demo text is data: the quoted frame (VIZ-25)
    }
    captionUntil = performance.now() + beatMs;
  }
  function scheduleBeat(): void {
    if (beatTimer === null && pending === null) beatTimer = window.setTimeout(() => liveBeat(), 0);
  }
  /** One live beat (ui/roomView.ts LivePlayer): the events of the next queued height, or a snap to the newest scene ("caught up").
   *  Beats wait while a seek loads (the last frame stays). */
  function liveBeat(): void {
    beatTimer = null;
    const r = sel();
    if (r === null || !mode.live || pending !== null) return;
    const b = r.live.beat(() => r.tl.head());
    if (b === null) return;
    if (b.kind === 'snap') {
      r.caught = [...r.caught, b.height];
      office.show(b.scene, { live: true, overlay: r.overlay, speed: 1, animate: false });
      office.camera('snapshot');
      a11y.scene(b.scene, [...r.characters.values()], r.layout);
      refresh();
      return;
    }
    office.show(b.scene, { live: true, overlay: r.overlay, speed: 1, animate: true });
    // 12 §3.8.1: in a room with a follow the follow camera replaces the 30 s rule (beatScroll, ui/follow.ts).
    const scroll = beatScroll(followed(), b.events);
    if (scroll?.by === 'camera') office.camera('beat');
    else if (scroll?.by === 'rule') office.follow(scroll.desk);
    captionFor(r, b.height, LIVE_BEAT_MS);
    a11y.scene(b.scene, [...r.characters.values()], r.layout);
    renderNow();
    updateRewind();
    if (r.live.queued() > 0) beatTimer = window.setTimeout(() => liveBeat(), LIVE_BEAT_MS);
  }

  /** The scene on screen now: live, the scene the beats reached; replay, the scene at the position — null when the page does not
   *  hold it (a snapshot restarted the view): then nothing is drawn and the last frame stays (VIZ-26). */
  function shownScene(r: RoomState): Scene | null {
    return mode.live ? r.live.scene() : r.tl.sceneAt(mode.at);
  }
  /** The replay position on screen: a step of the playing replay (cause 'beat', animated) or a seek. In replay the follow camera is the
   *  only automatic scroll (12 §3.8.1). */
  function showReplay(cause: 'beat' | 'seek'): void {
    const r = sel();
    if (r === null) return;
    const s = r.tl.sceneAt(mode.at);
    if (s !== null) {
      office.show(s, { live: false, overlay: null, speed: mode.speed, animate: cause === 'beat' });
      office.camera(cause);
      captionFor(r, mode.at, replayBeatMs(mode.speed));
      a11y.scene(s, [...r.characters.values()], r.layout);
    }
    renderLog();
    updateRewind();
  }
  function play(on: boolean): void {
    mode.playing = on && !mode.live;
    if (stepTimer !== null) clearTimeout(stepTimer);
    stepTimer = null;
    if (mode.playing) stepTimer = window.setTimeout(() => replayStep(), replayBeatMs(mode.speed));
    updateRewind();
  }
  function replayStep(): void {
    stepTimer = null;
    const r = sel();
    if (r === null || mode.live || !mode.playing) return;
    if (pending === null) {
      const next = r.tl.nextHeight(mode.at);
      if (next === null) {
        mode.playing = false;
        updateRewind();
        return;
      }
      mode.at = next;                                   // an event the page holds: inside its one held run
      showReplay('beat');
    }                                                   // else a position is loading: try again next beat
    stepTimer = window.setTimeout(() => replayStep(), replayBeatMs(mode.speed));
  }
  /** Replay at height at, which the page holds; then play when asked. */
  function showAt(at: number, andPlay: boolean): void {
    if (beatTimer !== null) clearTimeout(beatTimer);
    beatTimer = null;
    mode.live = false;
    mode.at = at;
    showReplay('seek');
    if (andPlay) play(true);
  }
  /** A seek (the slider, the keys, play from live, the demo start): a held height shows at once; any other loads first and shows
   *  when it arrives, the last frame staying meanwhile; a newer seek replaces a waiting one (ui/roomView.ts keeps it, never drops it). */
  function seek(h: number, andPlay = false): void {
    const r = sel();
    if (r === null || !Number.isSafeInteger(h)) return;
    const at = Math.min(Math.max(h, r.tl.h0), r.tl.top());
    if (r.tl.holds(at)) {
      pending = null;
      r.tl.dropTarget();
      showAt(at, andPlay);
      return;
    }
    pending = { h: at, play: andPlay };
    if (beatTimer !== null) clearTimeout(beatTimer);
    beatTimer = null;
    void r.tl.want(at);
    updateRewind();
  }
  /** A room's load started, merged a range or ended (ui/roomView.ts): a waiting seek shows once held; a load that ended without it
   *  failed, and the page stays where it was (live beats resume). The rewind bar greys "load earlier" while a load runs; a merged
   *  range's cards and the window's new h0 show. */
  function loadChanged(r: RoomState): void {
    if (r !== sel()) return;
    if (pending !== null) {
      const p = pending;
      if (r.tl.holds(p.h)) {
        pending = null;
        showAt(p.h, p.play);
      } else if (!r.tl.loading()) {
        pending = null;
        if (mode.live) scheduleBeat();
      }
    }
    refresh();
  }
  function goLive(): void {
    const r = sel();
    stopTimers();
    pending = null;
    mode.live = true;
    mode.playing = false;
    if (r === null) return refresh();
    r.tl.dropTarget();
    r.live.reset(r.tl.head());
    office.show(r.live.scene(), { live: true, overlay: r.overlay, speed: 1, animate: false });
    office.camera('seek');                              // back to the tip: a jump, like a seek
    a11y.scene(r.live.scene(), [...r.characters.values()], r.layout);
    refresh();
  }

  // ---------------------------------------------------------------------------------------------------------
  // Timeline pages (12 §3.10.5; R-V29, R-V49): fetched here, assembled by ui/roomView.ts

  /** One page [from, to] (the server may clip `to`), read; null when refused or unreadable. */
  async function fetchPage(r: RoomState, from: number, to: number): Promise<PageOf | null> {
    let res: { status: number; json: unknown };
    try {
      res = await io.request({ r: 'timeline', room: r.id, from, to }, withSession());
    } catch {
      return null;
    }
    if (res.status !== 200 || !isPage(res.json)) return null;
    const vm = res.json;
    try {
      return { room: vm.room_id, from: vm.from, to: vm.to, start: unprojectScene(vm.scene), events: vm.events.map(unprojectEvent), vm };
    } catch {
      return null;                                      // a page the page cannot read is a failed page
    }
  }
  /** The pages of one whole range joined the room's view (ascending): their layout deltas (R-V49), pet owners (R-V47), request
   *  statuses, cards, and the ticks of an earlier segment's pages (served without ticks, R-V28) — the pages from at or below h0
   *  (h0 still the old one here: height h0 > 0 belongs to the segment below; the window's own pages start at h0 + 1). */
  function mergedPages(r: RoomState, pages: readonly PageOf[]): void {
    const earlier: Tick[] = [];                         // in height order: the range's pages ascend (the genesis segment comes in two)
    for (const p of pages) {
      if (p.vm.layout !== null) {
        const l = applyLayoutDeltaVM(r.layoutVM, p.vm.layout);
        if (l !== 'reload') setLayout(r, l);
      }
      for (const e of p.events) learnOwner(r, e);
      for (const e of p.vm.events) if (e.kind === 'request_status') r.log.status(e);
      addCards(r, p.vm.cards);
      if (r.tl.h0 > 0 && p.from <= r.tl.h0) earlier.push(...p.events.map(tickOf).filter((x): x is Tick => x !== null));
    }
    if (earlier.length > 0) r.ticks = [...earlier, ...r.ticks];
  }
  /** Demo mode: the window is loaded and played from h0 at 1×. */
  function startDemo(): void {
    const r = sel();
    if (r !== null) seek(r.tl.h0, true);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Rendering

  function select(id: string): void {
    if (!rooms.has(id) || id === selected) return;
    sel()?.tl.dropTarget();
    selected = id;
    io.storage.set({ room: id });
    stopTimers();
    pending = null;
    mode.live = true;
    mode.playing = false;
    // Not a person-filter change (12 §3.8.1): that room's own follow, or none, pins the person filter; the left room's follow is kept.
    logPanel.person(follows.get(id));
    logPanel.desk(null);
    enterRoom(false);
  }
  /** Shows the selected room from its head scene. */
  function enterRoom(fresh: boolean): void {
    const r = sel();
    office.room(r);
    if (r !== null) {
      r.live.reset(r.tl.head());
      office.show(r.live.scene(), { live: true, overlay: r.overlay, speed: 1, animate: false });
      office.camera('room');
      a11y.scene(r.live.scene(), [...r.characters.values()], r.layout);
    } else a11y.scene(null, [], null);
    if (fresh) caption.textContent = '';
    refresh();
  }
  function filterPerson(h: string): void {
    logPanel.person(h);
    filterChanged();
    renderLog();
    redraw();
  }
  /** The person filter may have changed: another person, a cleared filter or Esc ends the selected room's follow (12 §3.8.1); the
   *  followed peer itself again ends nothing. */
  function filterChanged(): void {
    if (selected !== null) follows.filterChanged(selected, logPanel.filter().peer);
    a11y.refresh();
  }
  /** The toggle on the person-filter chip, the now card's toggle, or F: follow the person filter's peer, or stop following; nothing
   *  without a person filter. */
  function toggleFollow(): void {
    if (selected === null) return;
    const p = follows.toggle(selected, logPanel.filter().peer);
    if (p !== null) followStarted(p);
    else followChanged();
  }
  /** The second button of a hidden people-list row (12 §3.11): follow that row's person (the person filter becomes it), or stop. */
  function followPerson(h: string): void {
    if (selected === null) return;
    if (followed() === h) return toggleFollow();
    logPanel.person(h);
    filterChanged();
    const p = follows.toggle(selected, h);
    if (p !== null) followStarted(p);
    else followChanged();
  }
  /** A follow started: the person filter is its peer and the camera centres it (the follow set offered the start to the announcer). */
  function followStarted(peer: string): void {
    logPanel.person(peer);
    office.camera('start');
    followChanged();
  }
  function followChanged(): void {
    a11y.refresh();
    renderLog();
    redraw();
  }
  /** The now card (12 §3.8.1) from the scene on screen, the layout and the character table; the last card stays while a replay position
   *  loads (nothing is drawn then either). */
  function renderNow(): void {
    const r = sel();
    const peer = followed();
    if (r === null || peer === null) return logPanel.now(null);
    const s = shownScene(r);
    if (s === null) return;
    const name = (h: string): string => r.names.get(h) ?? h;
    logPanel.now({
      name: name(peer), hue: r.looks.get(peer)?.hue ?? null, reason: s.characters.get(peer)?.frozen ?? '?',
      rows: nowRows(nowCard(s, r.layout, peer), s, name),
    });
  }
  function redraw(): void {
    const r = sel();
    if (r === null) return;
    const s = shownScene(r);
    if (s === null) return;                             // not held: the last frame stays
    office.show(s, { live: mode.live, overlay: mode.live ? r.overlay : null, speed: mode.speed, animate: false });
  }
  function renderLog(): void {
    const r = sel();
    logPanel.render(r === null ? null : r.log, { replay: !mode.live, nowMono: performance.now() });
    renderNow();
  }
  function updateRewind(): void {
    const r = sel();
    if (r === null) return;
    const top = r.tl.top();
    const at = pending !== null ? pending.h : mode.live ? top : mode.at;
    rewind.update({
      h0: r.tl.h0, h1: top, at, live: mode.live, playing: mode.playing, speed: mode.speed, stale: streamStale(connState),
      canEarlier: r.tl.canEarlier(), ticks: r.ticks, caught: r.caught,
    });
  }
  function renderHeader(): void {
    const code = STATE_CODE[connState];
    status.hidden = code === null;
    if (code !== null) {
      status.setAttribute('data-code', code);
      // Before a session there is no served catalog: the four sessionless states come from the bundled en table; another state
      // shows its code.
      status.textContent = strings.can(code, lang) ? t(code) : code;
    }
    appRoot.setAttribute('data-state', connState);
    banner.hidden = world === null || !world.demo;
    banner.textContent = hasStrings() ? t('UI_VIZ_DEMO_BANNER') : '';
    const r = sel();
    const notes: string[] = [];
    if (world !== null && world.rooms.length === 0) notes.push(t('UI_VIZ_NO_ROOMS'));
    if (r !== null) {
      roomTitle.textContent = r.branch === '' ? r.label : `${r.label} \u{00B7} ${r.branch}`;
      if (r.gone) notes.push(t('UI_VIZ_ROOM_GONE'));
      for (const b of r.badges) notes.push(t(b));
      const lampState = headerLamp(r.overlay);
      lamp.hidden = lampState === null;
      if (lampState !== null) {
        lamp.className = CLS.lamp;
        lamp.classList.add(lampState.down ? CLS.lampDown : lampState.unreadable ? CLS.lampWarn : CLS.lampOk);
        lamp.title = lampState.state;
        const lampWord = lampCode(lampState);            // VIZ-19: the label names a down or unreadable state, not the colour alone
        lamp.setAttribute('aria-label', lampWord === null ? lampState.state : `${lampState.state} \u{00B7} ${t(lampWord)}`);
        if (lampState.down) notes.push(t('UI_VIZ_ROOM_DOWN'));
        if (lampState.unreadable) notes.push(t('UI_VIZ_STATUS_UNREADABLE'));
      }
      const offline = r.overlay?.offline_min ?? null;
      if (offline !== null) notes.push(t('UI_VIZ_LAST_FETCH', { n: offline }));
      const badge = shownScene(r)?.badge ?? 'none';     // a position not held shows no board badge
      if (badge === 'full') notes.push(t('UI_VIZ_BOARD_FULL'));
      else if (badge === 'near_full') notes.push(t('UI_VIZ_BOARD_NEAR_FULL'));
    } else {
      roomTitle.textContent = '';
      lamp.hidden = true;
    }
    notice.textContent = hasStrings() ? notes.join(' \u{00B7} ') : '';
  }
  /** The map canvas (12 §3.5.1): every room's cell, the selected one outlined, the keyboard-focused one marked. */
  function drawMap(): void {
    const list = order.map((id) => rooms.get(id)).filter((r): r is RoomState => r !== undefined);
    office.map(list.map((r) => ({
      id: r.id, label: r.label, scene: r.tl.head(), looks: r.looks, homeOrder: r.layout.homeOrder,
      down: r.overlay?.down ?? false, noBoard: r.badges.includes('UI_VIZ_NO_BOARD'), gone: r.gone, overlay: r.overlay,
    })), selected, focusedRoom);
  }
  let roomsKey = '';
  const roomButtons = new Map<string, HTMLButtonElement>();   // room id → its button (Map: room ids are served strings)
  /** The map plus its room buttons (for Tab and screen readers), rebuilt only when a room's label or the selection changed, so a
   *  live update never takes the keyboard focus off a room button. */
  function renderMap(): void {
    drawMap();
    const list = order.map((id) => rooms.get(id)).filter((r): r is RoomState => r !== undefined);
    const rows = list.map((r) => {
      const name = r.branch === '' ? r.label : `${r.label} \u{00B7} ${r.branch}`;
      // VIZ-19: the map's status lamp is not colour alone — a down or unreadable room says so in its button.
      const code = lampCode(headerLamp(r.overlay));
      return { id: r.id, text: code === null || !hasStrings() ? name : `${name} \u{00B7} ${t(code)}`, current: r.id === selected };
    });
    const key = JSON.stringify(rows);
    if (key === roomsKey) return;
    roomsKey = key;
    const focused = [...roomButtons].find(([, b]) => b === document.activeElement)?.[0] ?? null;
    roomButtons.clear();
    roomList.replaceChildren(...rows.map((r) => {
      const li = el('li', null);
      const b = button(CLS.room, li, () => select(r.id));
      b.textContent = r.text;
      if (r.current) b.setAttribute('aria-current', 'true');
      b.addEventListener('focus', () => {
        focusedRoom = r.id;
        drawMap();
      });
      b.addEventListener('blur', () => {
        if (focusedRoom === r.id) focusedRoom = null;
        drawMap();
      });
      roomButtons.set(r.id, b);
      return li;
    }));
    if (focused !== null) roomButtons.get(focused)?.focus({ preventScroll: true });
  }
  function refresh(): void {
    renderHeader();
    renderMap();
    renderLog();
    updateRewind();
  }

  // ---------------------------------------------------------------------------------------------------------
  // Keys, resizing, seen labels

  document.addEventListener('keydown', (e) => {
    const target = e.target;
    const typing = target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;
    const action = keyActionFor(e.key, typing, modifiedKey(e));   // none with Ctrl, Meta or Alt held (12 §3.11, §3.8.1)
    if (action === null) return;
    const r = sel();
    switch (action) {
      case 'live':
        goLive();
        break;
      case 'clear_filters':
        // Esc (8a has no export panel): every filter cleared, and so the selected room's follow ends (12 §3.11, §3.8.1).
        logPanel.clear();
        filterChanged();
        renderLog();
        redraw();
        break;
      case 'follow':
        toggleFollow();
        break;
      case 'zoom_in':
        office.zoomBy(1);
        break;
      case 'zoom_out':
        office.zoomBy(-1);
        break;
      case 'step_back': case 'step_fwd': case 'page_back': case 'page_fwd': {
        if (r === null) return;
        // ±1 or ±64 from the position on screen; a forward key at the tip shown live does nothing (12 §3.9.1: live already shows the tip).
        const by = stepBy(action, mode.live && pending === null);
        if (by === null) return;
        const from = pending !== null ? pending.h : mode.live ? r.tl.top() : mode.at;
        e.preventDefault();
        seek(from + by);
        break;
      }
      case 'select':
        return;                                         // Enter: the focused control's own action
    }
  });
  window.addEventListener('resize', () => {
    office.resize();
    renderMap();
    updateRewind();
  });
  window.setInterval(() => {
    if (mode.live) renderLog();
  }, SEEN_REFRESH_MS);

  // ---------------------------------------------------------------------------------------------------------
  // The connection

  const conn = new Connection(io, {
    state: (s) => {
      connState = s;
      if (s !== 'live' && s !== 'booting' && s !== 'reconnecting') stopTimers();
      renderHeader();
      updateRewind();
    },
    world: (w) => onWorld(w),
    payload: (p) => onPayload(p),
  });
  relabel();
  void conn.start(launch);
}

boot();
