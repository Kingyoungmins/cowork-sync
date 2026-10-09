// This PC's local status of a room (12 §3.3.2, §3.3.6, §3.4 "Local overlay", §6; VIZ-13; rulings R-V24, R-V30, R-V46):
// status.json read with one bounded open-read-close only when its mtime changed (the daemon replaces it by rename every
// iteration, and on Windows a rename over an open file fails, glossary §26.1 W3), the <gitdir>/cowork/peer file, the "you"
// marker and the present-only overlay. Nothing here reaches a timeline (INV-VIZ-DET): the overlay is served on its own.
import { join } from 'node:path';
import type { Fs } from '../../ports/fs.js';
import type { PeerRef } from '../model/events.js';
import type { BoundedReader } from './boundedRead.js';
import type { Overlay } from './roomSource.js';

export const STATUS_MAX_BYTES = 1_048_576;
/** <gitdir>/cowork/peer: a 32-hex peer id and a newline; anything over this is not a peer file. */
const PEER_MAX_BYTES = 4_096;
const HEX128 = /^[0-9a-f]{32}$/;
/** The errors of a read that races a replace (rename over the file, a delete-pending file, a lock holder): keep the previous read. */
const REPLACE_ERRORS: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOENT']);

/** The status.json fields the viewer uses (12 §3.3.2); never message_code, message_params or pending.not_converged. */
export interface StatusFields {
  state: string; freeze_reasons: string[]; publish_pause: string | null; branch: string; peer_id: string; plugin_version: string;
  heartbeat_mono_ms: number; loop_period_ms: number; last_fetch_age_ms: number | null;
  pending: { cs_ready: number; holds_active: number; incoming: number };
}
/** present: status.json exists; unreadable: it exists but is over the cap, not a regular file or does not parse; fields: the last parsed values. */
export interface StatusRead { present: boolean; unreadable: boolean; mtimeNs: bigint | null; fields: StatusFields | null; }

function codeOf(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null ? (e as NodeJS.ErrnoException).code : undefined;
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isMs = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Strict UTF-8, then JSON, then a check of the used fields only; a fresh object (nothing else of the file is kept). */
function parseStatus(buf: Buffer): StatusFields | null {
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf));
  } catch {
    return null;
  }
  if (!isObj(v) || v['v'] !== 1) return null;
  const { state, freeze_reasons: fr, publish_pause: pp, branch, peer_id: peer, plugin_version: pv, heartbeat_mono_ms: hb, loop_period_ms: lp, last_fetch_age_ms: lf, pending } = v;
  if (!isStr(state) || !Array.isArray(fr) || !fr.every(isStr) || !(pp === null || isStr(pp)) || !isStr(branch) || !isStr(peer) || !isStr(pv)) return null;
  if (!isMs(hb) || !isMs(lp) || lp === 0 || !(lf === null || isMs(lf)) || !isObj(pending)) return null;
  const { cs_ready: ready, holds_active: holds, incoming } = pending;
  if (!isCount(ready) || !isCount(holds) || !isCount(incoming)) return null;
  return {
    state, freeze_reasons: [...fr], publish_pause: pp, branch, peer_id: peer, plugin_version: pv,
    heartbeat_mono_ms: hb, loop_period_ms: lp, last_fetch_age_ms: lf, pending: { cs_ready: ready, holds_active: holds, incoming },
  };
}

/**
 * Fs.lstat of <gitdir>/cowork/status.json: absent → present false (the last parsed fields kept); the mtime of prev → prev
 * itself (no open); else one BoundedReader read with max STATUS_MAX_BYTES (one open-read-close): too_large or not_file →
 * unreadable with the previous fields; strict UTF-8, JSON.parse and a schema check of the used fields only (message_params
 * and not_converged are never read; failing → unreadable with the previous fields). EPERM, EACCES, EBUSY or ENOENT during a
 * replace (on the lstat or the read) → prev (or, with no prev, a present read with no fields), so the next tick reads again.
 */
export async function readStatus(gitdir: string, prev: StatusRead | null, deps: { fs: Fs; reader: BoundedReader }): Promise<StatusRead> {
  const p = join(gitdir, 'cowork', 'status.json');
  const kept = prev?.fields ?? null;
  const racing = (): StatusRead => prev ?? { present: true, unreadable: false, mtimeNs: null, fields: null };
  let st;
  try {
    st = await deps.fs.lstat(p);
  } catch (e) {
    if (REPLACE_ERRORS.has(codeOf(e) ?? '')) return racing();
    throw e;
  }
  if (st === null) return { present: false, unreadable: false, mtimeNs: null, fields: kept };
  if (prev !== null && prev.present && prev.mtimeNs !== null && prev.mtimeNs === st.mtimeNs) return prev;
  let r: Buffer | 'not_file' | 'too_large' | null;
  try {
    r = await deps.reader.read(p, STATUS_MAX_BYTES);
  } catch (e) {
    if (REPLACE_ERRORS.has(codeOf(e) ?? '')) return racing();
    throw e;
  }
  if (r === null) return racing();
  const fields = typeof r === 'string' ? null : parseStatus(r);
  if (fields === null) return { present: true, unreadable: true, mtimeNs: st.mtimeNs, fields: kept };
  return { present: true, unreadable: false, mtimeNs: st.mtimeNs, fields };
}

/** <gitdir>/cowork/peer: one BoundedReader read with max 4,096; 32 lowercase hex after trim, else null (any error included). */
export async function readPeerFile(gitdir: string, reader: BoundedReader): Promise<PeerRef | null> {
  let r: Buffer | 'not_file' | 'too_large' | null;
  try {
    r = await reader.read(join(gitdir, 'cowork', 'peer'), PEER_MAX_BYTES);
  } catch {
    return null;
  }
  if (r === null || typeof r === 'string') return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(r).trim();
  } catch {
    return null;
  }
  return HEX128.test(text) ? text : null;
}

/** R-V46: the peer file's value, else the last parsed status.json peer_id when it matches ^[0-9a-f]{32}$, else null (self then uses ZERO_PEER). */
export function youOf(peerFile: PeerRef | null, s: StatusRead | null): PeerRef | null {
  if (peerFile !== null) return peerFile;
  const id = s?.fields?.peer_id;
  return id !== undefined && HEX128.test(id) ? id : null;
}

/**
 * The overlay (12 §3.3.6): the light is the last parsed state; down when status.json is missing (R-V24: the --repo argument
 * stands in for the live marker), when the last write says 'down' (an orderly exit), or when the heartbeat of the last
 * parsed fields is stale: nowMachineMono − heartbeat_mono_ms > 3 × loop_period_ms, or the heartbeat is ahead of this boot's
 * clock by more than one loop period (a daemon not restarted after a reboot: the machine-monotonic clock restarts at boot,
 * and on one boot no heartbeat is ahead of it — the margin absorbs either side's rounding; controller ruling, spec-edit
 * item 01 §3.16 / 12 §3.3.6) — never from an unreadable file, which keeps the previous values; the offline age
 * last_fetch_age_ms + max(0, nowMachineMono − heartbeat_mono_ms) in whole minutes while the state is 'offline'; the counts
 * from pending; version skew when plugin_version ≠ the viewer's. Before any parse the light is '?'.
 */
export function overlayOf(s: StatusRead, nowMachineMono: number, viewerVersion: string, you: PeerRef | null): Overlay {
  const f = s.fields;
  const stale = f !== null && (nowMachineMono - f.heartbeat_mono_ms > 3 * f.loop_period_ms || f.heartbeat_mono_ms > nowMachineMono + f.loop_period_ms);
  const down = !s.present || (!s.unreadable && f !== null && (f.state === 'down' || stale));
  const offlineMin = f !== null && f.state === 'offline' && f.last_fetch_age_ms !== null
    ? Math.floor((f.last_fetch_age_ms + Math.max(0, nowMachineMono - f.heartbeat_mono_ms)) / 60_000)
    : null;
  return {
    state: f?.state ?? (s.present ? '?' : 'down'),
    freezeReasons: f === null ? [] : [...f.freeze_reasons],
    publishPause: f?.publish_pause ?? null,
    down,
    unreadable: s.present && s.unreadable,
    offlineMin,
    holds: f?.pending.holds_active ?? 0,
    incoming: f?.pending.incoming ?? 0,
    ready: f?.pending.cs_ready ?? 0,
    you,
    versionSkew: f !== null && f.plugin_version !== viewerVersion,
  };
}
