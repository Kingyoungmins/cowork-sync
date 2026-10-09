// Accessibility logic (12 §3.11 "Accessibility"; VIZ-40; R-V56): the canvas summary's counts (UI_VIZ_SCENE_SUMMARY), the rate
// limit of the polite log announcements, the keyboard map, and the rows of the visually hidden people list. Pure and DOM-free
// (R-V33); the page renders the codes and wires the keys.
import type { Layout } from '../model/layout.js';
import { placeLabel, type PlaceLabel } from '../model/labels.js';
import type { Scene } from '../model/scene.js';
import { PH_CODES, SS_CODES } from '../i18n/codes.js';
import type { CharacterVM, Handle } from '../server/viewModel.js';
import { exclaimPersists } from './anim.js';

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

export type KeyAction = 'live' | 'clear_filters' | 'zoom_in' | 'zoom_out' | 'step_back' | 'step_fwd' | 'page_back' | 'page_fwd' | 'select';

/** 12 §3.11 "Keyboard" and §3.9.1: L returns to live, Esc clears the filters, +/- zoom, the arrows step ±1 height, PageUp/PageDown
 *  ±64, Enter selects. KeyboardEvent.key → action, on a frozen null-prototype table (no key reaches Object.prototype). */
export const KEYS: Readonly<Record<string, KeyAction>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, KeyAction>, {
    L: 'live', l: 'live', Escape: 'clear_filters', '+': 'zoom_in', '-': 'zoom_out', ArrowLeft: 'step_back', ArrowRight: 'step_fwd',
    PageUp: 'page_back', PageDown: 'page_fwd', Enter: 'select',
  } satisfies Record<string, KeyAction>),
);

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
