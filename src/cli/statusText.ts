// `cowork status`: status.json (glossary §14) read for the CLI, and the short human summary built from it. Pure: the caller reads
// the files (daemon.lock, status.json, the fold of the local state) and renders the lines. Unlike the viewer's reader
// (src/viz/source/status.ts, which never reads them), the CLI shows message_code, message_params and pending.not_converged: the
// summary is for the person on this PC, about this PC's clone.
import type { Params } from '../i18n/render.js';

/** The status.json fields the summary uses; every other field is ignored. */
export interface StatusView {
  state: string; branch: string; peer_id: string; freeze_reasons: string[]; publish_pause: string | null;
  heartbeat_mono_ms: number; loop_period_ms: number; last_fetch_age_ms: number | null; last_push_age_ms: number | null;
  pending: { cs_ready: number; cs_open: number; holds_active: number; incoming: number; not_converged: string[] };
  message_code: string | null; message_params: Record<string, unknown>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isMs = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const count = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);

/** Strict UTF-8 and JSON, v 1, and the fields above with their types; null when any of that fails. */
export function parseStatusJson(buf: Buffer): StatusView | null {
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf));
  } catch {
    return null;
  }
  if (!isObj(v) || v['v'] !== 1) return null;
  const { state, branch, peer_id: peer, freeze_reasons: fr, publish_pause: pp, heartbeat_mono_ms: hb, loop_period_ms: lp } = v;
  const { last_fetch_age_ms: lf, last_push_age_ms: lpush, pending, message_code: mc, message_params: mp } = v;
  if (!isStr(state) || !isStr(branch) || !isStr(peer) || !Array.isArray(fr) || !fr.every(isStr) || !(pp === null || isStr(pp))) return null;
  if (!isMs(hb) || !isMs(lp) || lp === 0 || !(lf === null || isMs(lf)) || !(lpush === null || isMs(lpush)) || !isObj(pending)) return null;
  const nc = pending['not_converged'];
  return {
    state, branch, peer_id: peer, freeze_reasons: [...fr], publish_pause: pp,
    heartbeat_mono_ms: hb, loop_period_ms: lp, last_fetch_age_ms: lf, last_push_age_ms: lpush,
    pending: {
      cs_ready: count(pending['cs_ready']), cs_open: count(pending['cs_open']), holds_active: count(pending['holds_active']),
      incoming: count(pending['incoming']), not_converged: Array.isArray(nc) ? nc.filter(isStr) : [],
    },
    message_code: isStr(mc) ? mc : null,
    message_params: isObj(mp) ? mp : {},
  };
}

/** A duration for people: `12 s`, `3 min`, `2 h`, `4 d` (rounded down). */
export function ageText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1_000));
  if (s < 120) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 120) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} d`;
}

/** The daemon wrote this status more than 3 loop periods ago, or its heartbeat is ahead of this boot's clock (written before a reboot). */
export function statusStale(s: StatusView, nowMachineMono: number): boolean {
  return nowMachineMono - s.heartbeat_mono_ms > 3 * s.loop_period_ms || s.heartbeat_mono_ms > nowMachineMono + s.loop_period_ms;
}

const MAX_PATHS = 5;
const MAX_MESSAGE = 300;

/** `a.txt (not_applicable: collision)`: a not_converged path with its cause and qualifier from NOT_CONVERGED's params, when they line up. */
function notConvergedText(s: StatusView): string {
  const paths = s.pending.not_converged;
  const mp = s.message_params;
  const causes = s.message_code === 'NOT_CONVERGED' && Array.isArray(mp['causes']) && Array.isArray(mp['paths'])
    && mp['paths'].length === mp['causes'].length ? { paths: mp['paths'] as unknown[], causes: mp['causes'] as unknown[] } : null;
  const one = (p: string): string => {
    const i = causes === null ? -1 : causes.paths.indexOf(p);
    const c = i < 0 ? null : causes!.causes[i];
    if (!isObj(c) || !isStr(c['cause'])) return p;
    const q = [c['guard'], c['reason'], c['check']].find(isStr);
    return `${p} (${c['cause']}${q === undefined ? '' : `: ${q}`})`;
  };
  const shown = paths.slice(0, MAX_PATHS).map(one).join(', ');
  return paths.length > MAX_PATHS ? `${shown} and ${paths.length - MAX_PATHS} more` : shown;
}

function messageText(s: StatusView): string | null {
  if (s.message_code === null || s.message_code === 'NOT_CONVERGED') return null;
  const params = Object.keys(s.message_params).length === 0 ? '' : ` ${JSON.stringify(s.message_params)}`;
  const text = `${s.message_code}${params}`;
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 3)}...` : text;
}

export interface StatusInput {
  /** daemon.lock names a live holder. */
  live: boolean;
  /** status.json: parsed, absent (null) or present but unreadable. */
  status: StatusView | null | 'unreadable';
  nowMachineMono: number;
  /** Display names of the active peers on the board (this clone's marked), or null when the local board state cannot be read. */
  peers: string[] | null;
  files: { status: string; log: string };
  /** The command prefix (`/cowork`, or `node "<root>/dist/cli.js"`). */
  c: string;
}

export interface StatusSummary { lines: Array<{ code: string; params: Params }>; healthy: boolean; }

/**
 * The summary: one headline (running, starting, stale, down or never run), then the detail rows of the last status written.
 * healthy (exit 0) only when the daemon runs, its status is fresh, and its state is ok.
 */
export function statusSummary(i: StatusInput): StatusSummary {
  const lines: StatusSummary['lines'] = [];
  const s = i.status === 'unreadable' ? null : i.status;
  if (!i.live && i.status === null) return { lines: [{ code: 'UI_COWORK_STATUS_NEVER', params: { c: i.c } }], healthy: false };
  let healthy = false;
  if (!i.live) {
    lines.push({ code: 'UI_COWORK_STATUS_DOWN', params: { branch: s?.branch ?? '?', state: s?.state ?? '?', c: i.c } });
  } else if (s === null) {
    lines.push({ code: 'UI_COWORK_STATUS_STARTING', params: {} });
  } else if (statusStale(s, i.nowMachineMono)) {
    lines.push({ code: 'UI_COWORK_STATUS_STALE', params: { age: ageText(i.nowMachineMono - s.heartbeat_mono_ms), state: s.state } });
  } else {
    lines.push({ code: 'UI_COWORK_STATUS_RUNNING', params: { branch: s.branch, peer: s.peer_id.slice(0, 8), state: s.state } });
    healthy = s.state === 'ok';
  }
  if (i.status === 'unreadable') lines.push({ code: 'UI_COWORK_STATUS_UNREADABLE', params: { path: i.files.status } });
  if (s !== null) {
    if (i.peers !== null && i.peers.length > 0) lines.push({ code: 'UI_COWORK_STATUS_PEERS', params: { peers: i.peers.join(', ') } });
    // The ages were measured when the status was written; they have grown since by the heartbeat's age.
    const since = Math.max(0, i.nowMachineMono - s.heartbeat_mono_ms);
    const ago = (ms: number | null, none: string): string => (ms === null ? none : `${ageText(ms + since)} ago`);
    lines.push({ code: 'UI_COWORK_STATUS_PUSH', params: { age: ago(s.last_push_age_ms, 'none since the daemon started') } });
    lines.push({ code: 'UI_COWORK_STATUS_FETCH', params: { age: ago(s.last_fetch_age_ms, 'none since the daemon started') } });
    const p = s.pending;
    lines.push({ code: 'UI_COWORK_STATUS_PENDING', params: { ready: p.cs_ready, open: p.cs_open, incoming: p.incoming, holds: p.holds_active } });
    if (s.freeze_reasons.length > 0) lines.push({ code: 'UI_COWORK_STATUS_FROZEN', params: { reasons: s.freeze_reasons.join(', ') } });
    if (s.publish_pause !== null) lines.push({ code: 'UI_COWORK_STATUS_PAUSE', params: { pause: s.publish_pause } });
    if (p.not_converged.length > 0) lines.push({ code: 'UI_COWORK_STATUS_NOT_CONVERGED', params: { paths: notConvergedText(s) } });
    const m = messageText(s);
    if (m !== null) lines.push({ code: 'UI_COWORK_STATUS_MESSAGE', params: { message: m } });
  }
  lines.push({ code: 'UI_COWORK_STATUS_FILES', params: { status: i.files.status, log: i.files.log } });
  return { lines, healthy };
}
