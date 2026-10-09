// The map of rooms and the local overlay on the page (12 §3.5.1 "The map", §3.3.6 "Local overlay"; VIZ-13): each room cell's
// dots, the own room's lamp in the header, and the overlay marks drawn on a live scene only — never on a past scene. Pure and
// DOM-free (R-V33); every table keyed by a served id is a Map (VIZ-37).
import type { Scene } from '../model/scene.js';
import type { Handle, OverlayVM } from '../server/viewModel.js';

export const MAP_DOTS_MAX = 16, MAP_SCROLL_AFTER = 8;

/**
 * ≤ 16 dots: ranked (non-ghost) characters first in homeOrder, then the rest of the live set; ghosts grey, absent hollow; the
 * whole cell grey when the room is down, its board ref vanished, or it is gone. Within each part the characters homeOrder lists
 * come first in its order, then the others in scene order. hue: the character's look, null for a ghost, a character without a
 * look, or any dot of a grey cell.
 */
export function roomDots(s: Scene, looks: ReadonlyMap<string, { hue: number; accessory: number }>, homeOrder: readonly string[],
                         room: { down: boolean; noBoard: boolean; gone: boolean }): { grey: boolean; dots: Array<{ actor: string; hue: number | null; hollow: boolean }> } {
  const grey = room.down || room.noBoard || room.gone;
  const rank = new Map<string, number>();
  homeOrder.forEach((h, i) => { if (!rank.has(h)) rank.set(h, i); });
  const all = [...s.characters.entries()].map(([actor, c], i) => ({ actor, c, i, r: rank.get(actor) ?? Number.POSITIVE_INFINITY }));
  all.sort((a, b) => Number(a.c.ghost) - Number(b.c.ghost) || a.r - b.r || a.i - b.i);
  const dots = all.slice(0, MAP_DOTS_MAX).map(({ actor, c }) => ({
    actor,
    hue: grey || c.ghost ? null : looks.get(actor)?.hue ?? null,
    hollow: c.absent,
  }));
  return { grey, dots };
}

/** The own room's lamp in the header (live and replay). */
export function headerLamp(o: OverlayVM | null): { state: string; unreadable: boolean; down: boolean } | null {
  return o === null ? null : { state: o.state, unreadable: o.unreadable, down: o.down };
}

/** The overlay drawn on the scene (parcels at "you", the delivery cart and packed boxes at the door, the "you" marker): null in replay and for any room
 *  but its own (VIZ-13: never on a past scene). */
export function sceneOverlayMarks(o: OverlayVM | null, replay: boolean): { you: Handle | null; parcels: number; cart: number; boxes: number } | null {
  if (o === null || replay) return null;
  return { you: o.you, parcels: o.holds, cart: o.incoming, boxes: o.ready };
}
