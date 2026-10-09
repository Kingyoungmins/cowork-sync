// The start scene of a segment (12 §3.3.5; VIZ-10, VIZ-12, VIZ-21) and the owner of a board seat key (R-V47). Server only:
// it reads Plan 2's FoldState. Pure: it reads only its fold state, the home spots of the start peers in the layout and
// (from the plans that fold them) the desks of HELD and STALE claims, so a segment's start scene does not depend on the
// desks later extensions append.
import { liveSet, rankedSet, type FoldEvent, type FoldState } from '../../board/fold.js';
import { parseOpId } from '../../board/ids.js';
import type { PeerRef, SeatRef } from './events.js';
import type { Layout } from './layout.js';
import { homeSpot, settlePlaces } from './placement.js';
import { emptyScene, type CharacterState, type Scene } from './scene.js';

const HOST_THROTTLED = 'HOST_THROTTLED';

/** Board-full levels (12 §3.4): near_full at record_count ≥ 4,000, full at ≥ 5,000; slowed for 180 heights after HOST_THROTTLED.
 *  Defined here and re-exported by timeline.ts (their contract home), so start.ts imports nothing from timeline.ts at run time
 *  and timeline.ts can import startScene and ownerOfSeatKey from here (no import cycle). */
export const BOARD_NEAR_FULL = 4_000, BOARD_FULL = 5_000, SLOWED_HEIGHTS = 180;

/** R-V47: the peer segment of a board seat key "<peer>/<epoch>/<seat_id>" (the whole key when it has no separator). */
export function ownerOfSeatKey(seat: SeatRef): PeerRef {
  const i = seat.indexOf('/');
  return i < 0 ? seat : seat.slice(0, i);
}

/** The writer peer of a folded event and its order among that peer's events: (height, op seq). */
function writerOf(e: FoldEvent): { peer: PeerRef; height: number; seq: number } | null {
  const id = parseOpId(e.op_id);
  return id === null ? null : { peer: id.peer, height: e.height, seq: id.seq };
}

/**
 * The start scene of a segment at hs from fold state s (initialFoldState → an empty scene), at position (hs, 0, 0).
 * Characters: PeerRec.status active or absent; ghost = in liveSet(s) and not in rankedSet(s); frozen when the peer's newest
 * freeze/unfreeze event (by height, then op seq) is a freeze (its reason_code); slowed until h + 180 for a HOST_THROTTLED
 * health event at h with h + 180 > hs; rules when regionSpec ≠ teamRegionSpec; credit when coauthor_optin ≠ false. Pets: the
 * live seats whose owner is drawn, variants in sorted seat-key order per owner. Badge from record_count only. Every actor
 * placed by §3.5.4 with no publish history. beat = []. s.claims, s.requests and s.holds are empty in Plan 2; each plan that
 * adds those fold effects adds their reading here.
 */
export function startScene(s: FoldState, hs: number, layout: Layout): Scene {
  const scene = emptyScene({ height: hs, sub: 0, k: 0 });
  const live = new Set(liveSet(s));
  const ranked = new Set(rankedSet(s));
  const newestFreeze = new Map<PeerRef, { height: number; seq: number; e: FoldEvent }>();
  const slowedUntil = new Map<PeerRef, number>();
  for (const e of Object.values(s.events)) {
    const w = writerOf(e);
    if (w === null) continue;
    if (e.kind === 'freeze' || e.kind === 'unfreeze') {
      const cur = newestFreeze.get(w.peer);
      if (cur === undefined || w.height > cur.height || (w.height === cur.height && w.seq > cur.seq)) newestFreeze.set(w.peer, { height: w.height, seq: w.seq, e });
    }
    if (e.kind === 'health' && e.reason_code === HOST_THROTTLED && e.height + SLOWED_HEIGHTS > hs) {
      slowedUntil.set(w.peer, Math.max(slowedUntil.get(w.peer) ?? 0, e.height + SLOWED_HEIGHTS));
    }
  }
  for (const peer of Object.keys(s.peers).sort()) {
    const rec = s.peers[peer]!;
    if (rec.status !== 'active' && rec.status !== 'absent') continue;
    const fz = newestFreeze.get(peer);
    const c: CharacterState = {
      place: { at: 'home', spot: homeSpot(layout, peer) }, pose: 'idle', lastPublish: null, lastDesk: null, lastClaimOp: null,
      ghost: live.has(peer) && !ranked.has(peer),
      absent: rec.status === 'absent',
      frozen: fz !== undefined && fz.e.kind === 'freeze' ? fz.e.reason_code : null,
      slowedUntil: slowedUntil.get(peer) ?? null,
      rules: rec.regionSpec !== s.teamRegionSpec,
      credit: rec.coauthor_optin !== false,
    };
    scene.characters.set(peer, c);
  }
  const variants = new Map<PeerRef, number>();
  for (const key of Object.keys(s.seats).sort()) {
    if (s.seats[key]!.status !== 'live') continue;
    const owner = ownerOfSeatKey(key);
    if (!scene.characters.has(owner)) continue;
    const variant = variants.get(owner) ?? 0;
    variants.set(owner, variant + 1);
    scene.pets.set(key, { place: { at: 'behind', peer: owner }, pose: 'idle', lastPublish: null, lastDesk: null, lastClaimOp: null, owner, variant, live: true, ssCode: null });
  }
  scene.badge = s.record_count >= BOARD_FULL ? 'full' : s.record_count >= BOARD_NEAR_FULL ? 'near_full' : 'none';
  settlePlaces(scene, layout, null, null);
  return scene;
}
