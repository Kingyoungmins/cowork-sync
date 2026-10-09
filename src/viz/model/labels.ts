// Health and place labels (R-V56; 10-product §3.14; 12 §1.5 item 5, §3.5.4, §3.11; VIZ-17): the PH_* code of a teammate
// and the place label of a seated actor. Shared with the page (R-V35): imports only events.ts, layout.ts and scene.ts.
// A teammate is never PH_OFFLINE (12 §1.5 item 5, UX-22), and sitting is never "working on" (VIZ-17).
import type { ActorRef, Position } from './events.js';
import type { Layout } from './layout.js';
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

export type PlaceLabel = { code: 'UI_VIZ_HOLDING'; label: string | null } | { code: 'UI_VIZ_LAST_SHARED_HERE'; path: string | null; height: number };

/**
 * VIZ-17, R-V56: for a sitting actor (a chair or a stool), HOLDING when it holds a HELD claim at that desk (its newest there
 * by claim-op position; the tag's `simple`, or `qualname` when another claim on the desk shares that `simple`, 12 §3.5.4),
 * else LAST_SHARED_HERE for the desk of its newest publish (the desk's path; the publish height); null when not sitting
 * (home, behind, beside, facing, or standing on a visitor tile) or sitting for neither reason.
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
  if (st.lastPublish !== null && st.lastDesk === d) return { code: 'UI_VIZ_LAST_SHARED_HERE', path: layout.desks[d]?.path ?? null, height: st.lastPublish.height };
  return null;
}
