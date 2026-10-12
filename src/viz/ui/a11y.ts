// Accessibility logic (12 §3.11 "Accessibility"; VIZ-40; R-V56): the canvas summary's counts (UI_VIZ_SCENE_SUMMARY), the rate
// limit of the polite log announcements, the keyboard map (keys act only without Ctrl, Meta or Alt; the rewind keys' steps), the
// signs that must not rest on colour or look alone — the live pill on a stale stream (VIZ-42) and the status lamp's text (VIZ-19) —
// and the rows of the visually hidden people list. Pure and DOM-free (R-V33); the page renders the codes and wires the keys.
import type { Layout } from '../model/layout.js';
import { placeLabel, type PlaceLabel } from '../model/labels.js';
import type { Scene } from '../model/scene.js';
import { PH_CODES, SS_CODES } from '../i18n/codes.js';
import type { CharacterVM, Handle } from '../server/viewModel.js';
import { exclaimPersists } from './anim.js';
import type { ConnState } from './conn.js';

export const ANNOUNCE_GAP_MS = 10_000;

/**
 * UI_VIZ_SCENE_SUMMARY's parameters: the characters in the scene, the live Claude sessions (live pets), the open requests, and the
 * conflicts showing a "!" — the persistent ones of non-terminal hold records and the one-beat ones of the scene's beat.
 */
export function sceneSummaryParams(s: Scene): { people: number; sessions: number; open: number; conflicts: number } {
  let sessions = 0;
  for (const p of s.pets.values()) if (p.live) sessions++;
  const beatConflicts = s.beat.filter((e) => e.kind === 'conflict' && !exclaimPersists(e)).length;
  return { people: s.characters.size, sessions, open: s.requests.size, conflicts: s.bangs.size + beatConflicts };
}

/**
 * aria-live="polite", rate-limited to one announcement per minGapMs (12 §3.11: one per 10 s). offer() returns the summary to
 * announce now, or null when the gap has not passed; a held summary is replaced by each newer one (it summarises what arrived
 * meanwhile) and flush() returns it once the gap has passed.
 */
export class Announcer {
  private last: number | null = null;
  private held: string | null = null;
  constructor(private readonly minGapMs: number) {}
  offer(summary: string, nowMono: number): string | null {
    if (this.ready(nowMono)) return this.announce(summary, nowMono);
    this.held = summary;
    return null;
  }
  flush(nowMono: number): string | null {
    return this.held !== null && this.ready(nowMono) ? this.announce(this.held, nowMono) : null;
  }
  private ready(nowMono: number): boolean {
    return this.last === null || nowMono - this.last >= this.minGapMs;
  }
  private announce(summary: string, nowMono: number): string {
    this.last = nowMono;
    this.held = null;
    return summary;
  }
}

/**
 * 12 §3.11 "Reduced motion": the effective setting is the in-page toggle's override when the reader has pressed it, else the OS's
 * `prefers-reduced-motion`; the toggle flips the effective setting, so it overrides the OS in both directions. The page holds one
 * (client/a11y.ts) and everything that moves reads it — the office's walks and the follow camera's pan or jump (ui/follow.ts).
 */
export class MotionPreference {
  #override: boolean | null = null;
  reduced(osReduced: boolean): boolean {
    return this.#override ?? osReduced;
  }
  toggle(osReduced: boolean): void {
    this.#override = !this.reduced(osReduced);
  }
}

export type KeyAction ='live' | 'clear_filters' | 'zoom_in' | 'zoom_out' | 'step_back' | 'step_fwd' | 'page_back' | 'page_fwd' | 'select' | 'follow';

/** 12 §3.11 "Keyboard" and §3.9.1: L returns to live, Esc clears the filters, +/- zoom, the arrows step ±1 height, PageUp/PageDown
 *  ±64, Enter selects; (rev 2.5, F32; Task 19) F toggles following the person-filtered character (12 §3.8.1). KeyboardEvent.key →
 *  action, on a frozen null-prototype table (no key reaches Object.prototype). */
export const KEYS: Readonly<Record<string, KeyAction>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, KeyAction>, {
    L: 'live', l: 'live', Escape: 'clear_filters', '+': 'zoom_in', '-': 'zoom_out', ArrowLeft: 'step_back', ArrowRight: 'step_fwd',
    PageUp: 'page_back', PageDown: 'page_fwd', Enter: 'select', F: 'follow', f: 'follow',
  } satisfies Record<string, KeyAction>),
);

/** A keydown's modifier state, structurally a KeyboardEvent (the page passes the event itself). */
export interface KeyModifiers { ctrlKey: boolean; metaKey: boolean; altKey: boolean; getModifierState(key: string): boolean; }
/** Whether Ctrl, Meta or Alt is held (12 §3.11 "Keyboard", §3.8.1: page keys act only without them, so the browser keeps its own
 *  shortcuts — find, the address bar, zoom, back and forward). AltGraph, which Windows reports as Ctrl+Alt, types a character on many
 *  layouts, so its Ctrl and Alt are not modifiers here; Meta still is. Shift is never one: it is part of the key ('F', '+'). */
export function modifiedKey(e: KeyModifiers): boolean {
  return e.metaKey || (!e.getModifierState('AltGraph') && (e.ctrlKey || e.altKey));
}

/** The page's action for a key (Task 19, a pure form of the page's key guard): KEYS[key]; with focus in a form control (a text field,
 *  the language or speed select) only Esc acts, so typing never steps the replay, zooms or toggles a follow (12 §3.8.1: F with focus
 *  not in a form control); with Ctrl, Meta or Alt held (`modified`, from modifiedKey) no key acts — Ctrl+F searches the page, it does
 *  not toggle a follow (FEAT-F32-02). null: the key does nothing here. */
export function keyActionFor(key: string, inFormControl: boolean, modified: boolean): KeyAction | null {
  if (modified) return null;
  const action = Object.hasOwn(KEYS, key) ? KEYS[key]! : null;
  return action === null || (inFormControl && action !== 'clear_filters') ? null : action;
}

/** 12 §3.9.1: PageUp and PageDown step the replay by 64 heights, the arrows by 1. */
export const PAGE_STEP_HEIGHTS = 64;
/** The heights a rewind key moves the position by (12 §3.9.1): −1/+1 for the arrows, −64/+64 for PageUp/PageDown; null for any other
 *  action, and for a forward key at the live tip (`atLiveTip`: the page shows the tip live) — live already shows the newest height and
 *  follows it, so the key does nothing there instead of turning live into a replay of the tip. */
export function stepBy(action: KeyAction, atLiveTip: boolean): number | null {
  switch (action) {
    case 'step_back': return -1;
    case 'page_back': return -PAGE_STEP_HEIGHTS;
    case 'step_fwd': return atLiveTip ? null : 1;
    case 'page_fwd': return atLiveTip ? null : PAGE_STEP_HEIGHTS;
    default: return null;
  }
}

/** Whether the stream is known not to be live (VIZ-42; 12 §3.10.5, §6): every connection state but live and booting — reconnecting,
 *  stopped (after the retries and the world reload failed, or a `bye`), a refused link and a lost session. */
export function streamStale(c: ConnState): boolean {
  return c !== 'live' && c !== 'booting';
}
/** The rewind bar's live pill (12 §3.9.1, §3.10.5, §6; VIZ-42): `on` (the live look) and aria-pressed only while the page shows the tip
 *  live on a live stream; `off` (grey, dashed) whenever the stream is stale, in live and replay alike — a stale scene never reads as live. */
export function livePillState(s: { live: boolean; stale: boolean }): { on: boolean; off: boolean; pressed: boolean } {
  const on = s.live && !s.stale;
  return { on, off: s.stale, pressed: on };
}

/** The text code of a room's status lamp (VIZ-19: colour is never the only carrier; 12 §3.4 overlay rows), from headerLamp's light:
 *  UI_VIZ_ROOM_DOWN when the daemon is down (which wins, as the lamp's colour does), UI_VIZ_STATUS_UNREADABLE when status.json could
 *  not be read, else null (the healthy light needs no words). */
export function lampCode(l: { down: boolean; unreadable: boolean } | null): 'UI_VIZ_ROOM_DOWN' | 'UI_VIZ_STATUS_UNREADABLE' | null {
  if (l === null) return null;
  return l.down ? 'UI_VIZ_ROOM_DOWN' : l.unreadable ? 'UI_VIZ_STATUS_UNREADABLE' : null;
}

/** A served label code of its closed set, else null; a teammate is never PH_OFFLINE (12 §1.5 item 5, UX-22). */
const phLabel = (ph: string | null): string | null => (ph !== null && PH_CODES.has(ph) && ph !== 'PH_OFFLINE' ? ph : null);
const ssLabel = (ss: string | null): string | null => (ss !== null && SS_CODES.has(ss) ? ss : null);

/** A row of the hidden people list; `person` is the peer handle its button filters the log by (a pet's owner, VIZ-40). */
export interface PersonRow { handle: Handle; person: Handle; name: string; ph: string | null; place: PlaceLabel | null; }

/**
 * One row per character of the room (12 §3.11 hidden list): handle, name tag, PH code (CharacterVM.ph, or the pet's SS code), placeLabel (model/labels.ts).
 * Characters in the served order, each only while it is in the scene; then the scene's live pets, named by their owner's tag
 * (the owner handle when the page has no tag for it). A row's `person` is the character's own handle, a pet's owner (from the
 * scene, never parsed from the seat, R-V47): the log's person filter matches peers, as a pet clicked on the canvas filters by
 * its owner.
 */
export function peopleList(s: Scene, characters: readonly CharacterVM[], layout: Layout): PersonRow[] {
  const rows: PersonRow[] = [];
  const names = new Map<string, string>();
  const listed = new Set<string>();
  for (const c of characters) {
    if (!names.has(c.handle)) names.set(c.handle, c.name);
    if (!s.characters.has(c.handle) || listed.has(c.handle)) continue;
    listed.add(c.handle);
    rows.push({ handle: c.handle, person: c.handle, name: c.name, ph: phLabel(c.ph), place: placeLabel(s, { peer: c.handle }, layout) });
  }
  for (const [seat, p] of s.pets) {
    if (!p.live) continue;
    rows.push({ handle: seat, person: p.owner, name: names.get(p.owner) ?? p.owner, ph: ssLabel(p.ssCode), place: placeLabel(s, { seat }, layout) });
  }
  return rows;
}
