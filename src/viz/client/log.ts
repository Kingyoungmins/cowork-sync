// The log panel (12 §3.8 "Panel", "Cards", "Activity cards", "Card content", "Order and scrolling", "Filters"; VIZ-11, VIZ-24,
// VIZ-25, VIZ-37): the selected room's LogModel (ui/logModel.ts) as DOM through textContent only. Each card shows its actor (look
// swatch and name tag, a button that filters the log to that person), its UI_VIZ_CARD_* text, teammate free text inside the quoted
// frame only, status and file chips (a file chip filters the log to its desk), its display id, and its position label (seen n min
// ago, before this view opened, or #height in replay). The list follows new cards unless the reader scrolled up, when a "new"
// pill jumps down. Filters: all, person, file, and the four kinds, combined with AND. (rev 2.5, F32; 12 §3.8.1) The person-filter
// chip carries the follow toggle (UI_VIZ_CTRL_FOLLOW, aria-pressed), and while the selected room follows someone the now card sits at
// the top of the panel: a section labelled by UI_VIZ_FOLLOWING (a region), not a card of the list — never merged, filtered or counted;
// its rows come from ui/follow.ts's nowRows and reach the DOM through textContent only. Browser only.
import type { ActorVM, CardVM } from '../server/viewModel.js';
import type { NowRow } from '../ui/follow.js';
import { cardText, type LogFilter, type LogModel, type LogRow } from '../ui/logModel.js';
import { CLS, HUE_CLS, button, el, setPressed, type Translate } from './a11y.js';

/** request_status → the label of its status chip (12 §3.8: a status chip on its request card, with the icon's label). */
const STATUS_CODE: Readonly<Record<string, string>> = Object.freeze(Object.assign(Object.create(null) as Record<string, string>, {
  asked: 'UI_VIZ_ICON_ASKED', queued_until_turn_end: 'UI_VIZ_ICON_QUEUED', awaiting_human: 'UI_VIZ_ICON_AWAITING_HUMAN',
  undeliverable: 'UI_VIZ_ICON_UNDELIVERABLE', returned: 'UI_VIZ_CHIP_ASKED_AGAIN',
}));
/** A kind filter: its group and its label. */
const KINDS: ReadonlyArray<{ group: CardVM['group']; code: string }> = Object.freeze([
  { group: 'conversation', code: 'UI_VIZ_FILTER_CONVERSATION' }, { group: 'activity', code: 'UI_VIZ_FILTER_ACTIVITY' },
  { group: 'conflict', code: 'UI_VIZ_FILTER_CONFLICTS' }, { group: 'system', code: 'UI_VIZ_FILTER_SYSTEM' },
]);
const BOTTOM_SLACK_PX = 4;

export interface LogDeps {
  t: Translate;
  /** The name tag of an actor: a peer's tag, a pet's owner tag. */
  nameOf(a: ActorVM): string;
  /** The look hue of an actor (a pet: its owner's), null when the page has none. */
  hueOf(a: ActorVM): number | null;
  /** The peer handle a person filter takes for an actor (a pet: its owner), null when unknown. */
  personOf(a: ActorVM): string | null;
  /** A desk ordinal by served path, and a desk's path (the file filter). */
  deskOfPath(path: string): number | null;
  pathOfDesk(desk: number): string | null;
  /** A desk's name by kind for card text when the card has no file chip (model/labels.ts deskName), null when unknown. */
  deskNameOf(desk: number): string | null;
  /** The filters changed: the page re-renders (and mirrors the person filter on the canvas). */
  changed(): void;
  /** Changes whenever a name tag, a look or a pet's owner the cards show changes (the list is rebuilt then too). */
  version(): number;
  /** The selected room follows the person filter's peer (12 §3.8.1). */
  following(): boolean;
  /** The follow toggle (on the person-filter chip or the now card): follow the person filter's peer, or stop. */
  toggleFollow(): void;
  /** A click on the now card's UI_VIZ_FOLLOWING chip: the camera centres the followed actors at once. */
  recentre(): void;
}

/** What the now card shows (12 §3.8.1): the followed peer's name tag and look, the reason its PH_FROZEN label nests, and its rows. */
export interface NowView { name: string; hue: number | null; reason: string; rows: readonly NowRow[]; }

export interface LogPanel {
  /** The room's cards as rows (12 §3.8); the list's DOM is rebuilt only when the rows, their labels or the names they show changed,
   *  so a stream payload or a replay step that changes nothing keeps the reader's text selection and screen-reader position. */
  render(model: LogModel | null, o: { replay: boolean; nowMono: number }): void;
  filter(): LogFilter;
  person(handle: string | null): void;
  desk(desk: number | null): void;
  /** Esc: back to every kind but system, no person and no file. */
  clear(): void;
  /** The now card (null: no follow in the selected room), rebuilt only when what it shows changed. */
  now(v: NowView | null): void;
  relabel(): void;
}

export function createLogPanel(root: HTMLElement, deps: LogDeps): LogPanel {
  const { t } = deps;
  const nowBox = el('section', CLS.now, root);         // a section with an accessible name: a region (12 §3.8.1, FEAT-F32-11)
  nowBox.hidden = true;
  const filters = el('div', CLS.filters, root);
  const list = el('ul', CLS.cards, root);
  const pill = button(CLS.newPill, root, () => {
    list.scrollTop = list.scrollHeight;
    pill.hidden = true;
  });
  pill.hidden = true;
  list.addEventListener('scroll', () => {
    if (atBottom()) pill.hidden = true;
  });

  const groups = new Set<CardVM['group']>(['conversation', 'activity', 'conflict']);
  let system = false;
  let peer: string | null = null;
  let deskFilter: number | null = null;
  let lastIds = new Set<string>();
  let current: { model: LogModel | null; replay: boolean; nowMono: number } = { model: null, replay: false, nowMono: 0 };
  let built: { model: LogModel | null; key: string } | null = null;   // what the list's DOM shows now (null: rebuild)

  const allButton = button(CLS.filter, filters, () => {
    clear();
    deps.changed();
  });
  const kindButtons = KINDS.map((k) => {
    const b = button(CLS.filter, filters, () => {
      if (k.group === 'system') system = !system;
      else if (groups.has(k.group)) groups.delete(k.group);
      else groups.add(k.group);
      deps.changed();
    });
    return { k, b };
  });
  const personChip = button(CLS.filter, filters, () => {
    peer = null;
    deps.changed();
  });
  const followToggle = button(CLS.filter, filters, () => deps.toggleFollow());
  const fileChip = button(CLS.filter, filters, () => {
    deskFilter = null;
    deps.changed();
  });

  const atBottom = (): boolean => list.scrollTop + list.clientHeight >= list.scrollHeight - BOTTOM_SLACK_PX;
  const clear = (): void => {
    groups.clear();
    groups.add('conversation');
    groups.add('activity');
    groups.add('conflict');
    system = false;
    peer = null;
    deskFilter = null;
  };

  const syncFilters = (): void => {
    allButton.textContent = t('UI_VIZ_FILTER_ALL');
    setPressed(allButton, peer === null && deskFilter === null && groups.size === 3);
    for (const { k, b } of kindButtons) {
      b.textContent = t(k.code);
      setPressed(b, k.group === 'system' ? system : groups.has(k.group));
    }
    personChip.hidden = peer === null;
    personChip.textContent = peer === null ? '' : `${t('UI_VIZ_FILTER_PERSON')}: ${deps.nameOf({ peer })} \u{00D7}`;
    setPressed(personChip, peer !== null);
    followToggle.hidden = peer === null;               // shown with a person filter (12 §3.8.1)
    followToggle.textContent = t('UI_VIZ_CTRL_FOLLOW');
    setPressed(followToggle, peer !== null && deps.following());
    const path = deskFilter === null ? null : deps.pathOfDesk(deskFilter);
    fileChip.hidden = deskFilter === null;
    fileChip.textContent = deskFilter === null ? '' : `${t('UI_VIZ_FILTER_FILE')}: ${path ?? `#${deskFilter}`} \u{00D7}`;
    setPressed(fileChip, deskFilter !== null);
  };

  /** The buttons of the current render by a stable key (card id and role), so a rebuild keeps keyboard focus where it was. */
  let focusables = new Map<string, HTMLElement>();
  /** Each request card's list item by display id: a now-card id scrolls the list to it (12 §3.8 "Card content"). */
  let cardsById = new Map<string, HTMLElement>();

  /** The actor line: look swatch and name tag (a button filtering the log to that person). */
  const actorHead = (parent: Element, a: ActorVM | null, displayId: string | null, key: string): void => {
    const head = el('div', CLS.head, parent);
    if (a !== null) {
      const hue = deps.hueOf(a);
      const swatch = el('span', CLS.swatch, head);
      if (hue !== null && hue >= 0 && hue < HUE_CLS.length) swatch.classList.add(HUE_CLS[hue]!);
      const who = deps.personOf(a);
      const name = button(CLS.name, head, () => {
        if (who === null) return;
        peer = who;
        deps.changed();
      });
      name.textContent = deps.nameOf(a);
      focusables.set(`${key}|`, name);
    }
    if (displayId !== null) el('span', CLS.meta, head).textContent = displayId;
  };

  const fileChips = (parent: Element, paths: readonly string[], more: number, key: string): void => {
    if (paths.length === 0 && more <= 0) return;
    const chips = el('div', CLS.chips, parent);
    for (const p of paths) {
      const chip = button(CLS.chip, chips, () => {
        const d = deps.deskOfPath(p);
        if (d === null) return;
        deskFilter = d;
        deps.changed();
      });
      chip.textContent = p;
      focusables.set(`${key}|${p}`, chip);
    }
    if (more > 0) el('span', CLS.chip, chips).textContent = t('UI_VIZ_MORE', { n: more });
  };

  const position = (parent: Element, c: CardVM): void => {
    const model = current.model;
    if (model === null) return;
    const s = model.seenLabel(c, current.nowMono, current.replay);
    const meta = el('div', CLS.meta, parent);
    switch (s.kind) {
      case 'seen_ago':
        meta.textContent = t('UI_VIZ_SEEN_AGO', { n: s.n });
        break;
      case 'before_open':
        meta.textContent = `#${s.height} \u{00B7} ${t('UI_VIZ_SEEN_BEFORE_OPEN')}`;
        break;
      case 'height':
        meta.textContent = `#${s.height}`;
        break;
    }
  };

  const cardNode = (c: CardVM, answers: readonly CardVM[], statusChips: readonly string[]): HTMLLIElement => {
    const li = el('li', CLS.card);
    if (c.displayId !== null && !cardsById.has(c.displayId)) cardsById.set(c.displayId, li);
    if (c.group === 'system') li.classList.add(CLS.cardSystem);
    if (c.detail !== null) li.title = c.detail;                      // a raw reason code only in the detail tooltip (12 §3.8)
    actorHead(li, c.actor, c.displayId, c.id);
    const { code, params, quoted } = cardText(c, deps.nameOf, deps.deskNameOf);
    el('div', CLS.text, li).textContent = t(code, params);
    if (quoted !== null) el('blockquote', CLS.quote, li).textContent = quoted;   // teammate text: the quoted frame only (VIZ-25)
    if (statusChips.length > 0) {
      const chips = el('div', CLS.chips, li);
      for (const s of statusChips) {
        const label = STATUS_CODE[s];
        if (label !== undefined) el('span', CLS.chip, chips).textContent = t(label);
      }
    }
    if (c.code !== 'UI_VIZ_CARD_PUBLISH') fileChips(li, c.paths, 0, c.id);
    position(li, c);
    if (answers.length > 0) {
      const ul = el('ul', CLS.answers, li);
      for (const a of answers) ul.append(cardNode(a, [], []));
    }
    return li;
  };

  const mergedNode = (row: Extract<LogRow, { kind: 'merged' }>): HTMLLIElement => {
    const li = el('li', CLS.card);
    const key = row.cards[0]!.id;
    actorHead(li, row.actor, null, key);
    const n = row.cards.reduce((sum, c) => sum + c.n, 0);
    el('div', CLS.text, li).textContent = t('UI_VIZ_CARD_PUBLISH', { name: deps.nameOf(row.actor), n });
    fileChips(li, row.chips, row.more, key);
    position(li, row.cards[row.cards.length - 1]!);
    return li;
  };

  const render = (model: LogModel | null, o: { replay: boolean; nowMono: number }): void => {
    current = { model, replay: o.replay, nowMono: o.nowMono };
    syncFilters();
    const rows = model === null ? [] : model.rows(filter());
    const key = model === null ? '' : `${deps.version()}|${model.key(rows, o.nowMono, o.replay)}`;
    if (built !== null && built.model === model && built.key === key) return;   // nothing the list shows changed
    built = { model, key };
    const follow = atBottom();
    const focused = [...focusables].find(([, e]) => e === document.activeElement)?.[0] ?? null;
    focusables = new Map();
    cardsById = new Map();
    const nodes = rows.map((r) => (r.kind === 'card' ? cardNode(r.card, r.answers, r.chips) : mergedNode(r)));
    list.replaceChildren(...nodes);
    if (focused !== null) focusables.get(focused)?.focus({ preventScroll: true });
    const ids = new Set<string>();
    for (const r of rows) for (const c of r.kind === 'card' ? [r.card, ...r.answers] : r.cards) ids.add(c.id);
    const arrived = [...ids].some((id) => !lastIds.has(id));
    lastIds = ids;
    if (follow) list.scrollTop = list.scrollHeight;
    else if (arrived) pill.hidden = false;
  };

  const filter = (): LogFilter => ({ peer, desk: deskFilter, groups: new Set(groups), system });

  // ---------------------------------------------------------------------------------------------------------
  // The now card (12 §3.8.1): the header (look swatch, the UI_VIZ_FOLLOWING chip, the PH label, the pressed toggle), then the rows

  let nowView: NowView | null = null;
  let nowKey = '';
  let nowFocus = new Map<string, HTMLElement>();
  /** A file chip of a holding row sets the file filter; a display id scrolls the log to its card. */
  const nowLink = (parent: Element, r: NowRow, key: string): void => {
    if (r.link === null) return;
    const link = r.link;
    const b = button(CLS.chip, parent, () => {
      if (r.row === 'holding') {
        const d = deps.deskOfPath(link);
        if (d === null) return;
        deskFilter = d;
        deps.changed();
        return;
      }
      const li = cardsById.get(link);
      // The list itself scrolls (never the page) until the card's top meets the list's top, wherever the card sits (an answer in its request).
      if (li !== undefined) list.scrollTop += li.getBoundingClientRect().top - list.getBoundingClientRect().top - list.clientTop;
    });
    b.textContent = link;
    nowFocus.set(key, b);
  };
  const nowRow = (r: NowRow, i: number, v: NowView): HTMLElement => {
    if (r.row === 'header') {
      const head = el('div', CLS.head);
      const swatch = el('span', CLS.swatch, head);
      if (v.hue !== null && v.hue >= 0 && v.hue < HUE_CLS.length) swatch.classList.add(HUE_CLS[v.hue]!);
      const chip = button(CLS.chip, head, () => deps.recentre());
      chip.textContent = t(r.code, r.params);
      nowFocus.set(`${i}`, chip);
      if (r.label !== null) el('span', CLS.meta, head).textContent = t(r.label, { reason: v.reason });
      const toggle = button(CLS.filter, head, () => deps.toggleFollow());
      toggle.textContent = t('UI_VIZ_CTRL_FOLLOW');
      setPressed(toggle, true);
      nowFocus.set(`${i}|`, toggle);
      return head;
    }
    const line = el('div', CLS.text);
    el('span', null, line).textContent = t(r.code, r.params);
    if (r.row === 'holding' && r.label !== null) line.title = t(r.label);           // the chair-tag label is unverified (12 §3.5.4)
    if ((r.row === 'asks' || r.row === 'asked_by') && r.label !== null) el('span', CLS.meta, line).textContent = t(r.label);   // the status icon's label
    nowLink(line, r, `${i}|${r.row}`);
    return line;
  };
  const renderNow = (): void => {
    const v = nowView;
    nowBox.hidden = v === null;
    const key = v === null ? '' : JSON.stringify(v);
    if (key === nowKey) return;
    nowKey = key;
    const focused = [...nowFocus].find(([, e]) => e === document.activeElement)?.[0] ?? null;
    nowFocus = new Map();
    if (v === null) {
      nowBox.removeAttribute('aria-label');
      nowBox.replaceChildren();
      return;
    }
    const header = v.rows.find((r) => r.row === 'header');
    if (header !== undefined) nowBox.setAttribute('aria-label', t(header.code, header.params));
    nowBox.replaceChildren(...v.rows.map((r, i) => nowRow(r, i, v)));
    if (focused !== null) nowFocus.get(focused)?.focus({ preventScroll: true });
  };

  return {
    render,
    filter,
    person(handle): void {
      peer = handle;
    },
    desk(d): void {
      deskFilter = d;
    },
    clear,
    now(v): void {
      nowView = v;
      renderNow();
    },
    relabel(): void {
      pill.textContent = t('UI_VIZ_NEW_PILL');
      built = null;                                     // the language changed: every card is rebuilt
      nowKey = '';                                      // and the now card
      render(current.model, current);
      renderNow();
    },
  };
}
