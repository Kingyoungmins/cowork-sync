// Look assignment (12 §3.6; VIZ-18): a character's body hue and accessory come from its peer_id alone, never from a display
// name, a window or another peer, so one peer looks the same in every room, window, viewer and run. Server only (node:crypto).
import { createHash } from 'node:crypto';
import type { PeerRef } from './events.js';

export type LookTable = ReadonlyMap<PeerRef, { hue: number; accessory: number }>;
export const HUE_COUNT = 7, ACCESSORY_COUNT = 8, LOOK_COUNT = 56;

const LOOK_SALT = Buffer.from('viz-look', 'utf8');
const NUL = Buffer.from([0]);

/** n = sha256(utf8(peer) ‖ 0x00 ‖ utf8("viz-look")).readUInt32BE(0) (R-V20); L = n mod 56, hue = L mod 7, accessory = ⌊L / 7⌋. */
export function lookOf(peer: PeerRef): { hue: number; accessory: number } {
  const n = createHash('sha256').update(Buffer.concat([Buffer.from(peer, 'utf8'), NUL, LOOK_SALT])).digest().readUInt32BE(0);
  const l = n % LOOK_COUNT;
  return { hue: l % HUE_COUNT, accessory: Math.floor(l / HUE_COUNT) };
}

/** The look of every peer, keyed by peer_id (a Map, VIZ-37); no collision probing, so two peers can share a look. */
export function lookTable(peers: Iterable<PeerRef>): LookTable {
  const t = new Map<PeerRef, { hue: number; accessory: number }>();
  for (const p of peers) if (!t.has(p)) t.set(p, lookOf(p));
  return t;
}
