// Health and place labels (R-V56; 10-product §3.14; 12 §1.5 item 5, §3.5.4, §3.11; VIZ-17): the PH_* code of a teammate
// and the place label of a seated actor, and the name of a desk by its kind (the place label's and the now card's one helper).
// Shared with the page (R-V35): imports only events.ts, layout.ts and scene.ts.
// A teammate is never PH_OFFLINE (12 §1.5 item 5, UX-22), and sitting is never "working on" (VIZ-17).
import type { ActorRef, DeskRef, Position } from './events.js';
import { plaqueOf, type Layout } from './layout.js';
import { comparePos, isSlowed, type CharacterState, type ClaimState, type Scene } from './scene.js';

/**
 * First match wins (R-V56): status left → PH_LEFT; status absent → PH_PRESUMED_ABSENT; frozen PAUSED → PH_PAUSED, NOHOOKS →
 * PH_NOT_COORDINATED, any other reason or '?' → PH_FROZEN; slowed at `at` → PH_SLOWED; ghost → null (no label fits; the
 * ghost look is its sign); else PH_OK; never PH_OFFLINE (10-product §3.14: every other label takes precedence over PH_SLOWED).
 */
export function phOf(c: CharacterState | undefined, status: 'active' | 'left' | 'absent', at: Position): string | null {
  if (status === 'left') return 'PH_LEFT';
  if (status === 'absent') return 'PH_PRESUMED_ABSENT';
  if (c !== undefined && c.frozen !== null) return c.frozen === 'PAUSED' ? 'PH_PAUSED' : c.frozen === 'NOHOOKS' ? 'PH_NOT_COORDINATED' : 'PH_FROZEN';
  if (c !== undefined && isSlowed(c, at)) return 'PH_SLOWED';
  if (c !== undefined && c.ghost) return null;
  return 'PH_OK';
}

/**
 * What a place label or a now-card row names a desk by (12 §3.5.4, §3.8.1, by the desk's kind; final review B3: moved here from
 * ui/follow.ts so both share it): a file desk's path (its plaque when the path is unknown), a folder desk's plaque (its folder), a
 * shelf desk's zone sign + '/…' — which is the shelf's own key (layout.ts: a shelf desk's key is its zone key + '/…'; on the page,
 * ui/unproject.ts keys it by the served zone sign), so this file builds no string with a '/' (scene.test.ts's opaque-id scan) —
 * null at the big table (the page says UI_VIZ_NOW_LAST_SHARED_TABLE there); '?' only for an ordinal the layout lacks.
 */
export function deskName(layout: Layout, d: DeskRef): string | null {
  const desk = Number.isSafeInteger(d) && d >= 0 ? layout.desks[d] : undefined;
  if (desk === undefined) return '?';
  switch (desk.kind) {
    case 'big_table': return null;
    case 'file': return desk.path ?? plaqueOf(desk) ?? '?';
    case 'folder': return plaqueOf(desk) ?? '?';
    case 'shelf': return desk.key;
  }
}

/** HOLDING {label}, or LAST_SHARED_HERE {path, height} with path = deskName: null exactly at the big table (the variant with no path,
 *  which the page renders as UI_VIZ_NOW_LAST_SHARED_TABLE {height}; final review B3). */
export type PlaceLabel = { code: 'UI_VIZ_HOLDING'; label: string | null } | { code: 'UI_VIZ_LAST_SHARED_HERE'; path: string | null; height: number };

/**
 * VIZ-17, R-V56: for a sitting actor (a chair or a stool), HOLDING when it holds a HELD claim at that desk (its newest there
 * by claim-op position; the tag's `simple`, or `qualname` when another claim on the desk shares that `simple`, 12 §3.5.4),
 * else LAST_SHARED_HERE for the desk of its newest publish (the desk named by kind, deskName: null at the big table; the publish
 * height); null when not sitting (home, behind, beside, facing, or standing on a visitor tile) or sitting for neither reason.
 */
export function placeLabel(s: Scene, actor: ActorRef, layout: Layout): PlaceLabel | null {
  const st = 'peer' in actor ? s.characters.get(actor.peer) : s.pets.get(actor.seat);
  if (st === undefined || ('seat' in actor && !s.pets.get(actor.seat)!.live)) return null;
  const pl = st.place;
  if (pl.at !== 'chair' && pl.at !== 'stool') return null;
  const d = pl.desk;
  if ('seat' in actor) {
    const list = s.desks.get(d)?.claims ?? [];
    let held: ClaimState | null = null;
    for (const c of s.claims.values()) {
      if (c.stale || c.seat !== actor.seat || c.desk !== d) continue;
      if (held === null || comparePos(c.at, held.at) > 0) held = c;
    }
    if (held !== null) {
      const own = held.label;
      if (own === null) return { code: 'UI_VIZ_HOLDING', label: null };
      const shared = list.some((id) => {
        const o = s.claims.get(id);
        return o !== undefined && o !== held && o.label !== null && o.label.simple === own.simple;
      });
      return { code: 'UI_VIZ_HOLDING', label: shared ? own.qualname : own.simple };
    }
  }
  if (st.lastPublish !== null && st.lastDesk === d) return { code: 'UI_VIZ_LAST_SHARED_HERE', path: deskName(layout, d), height: st.lastPublish.height };
  return null;
}
