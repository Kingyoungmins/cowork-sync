// The fold (02-protocol §3.3, §3.4, §3.9; PRO-14…PRO-16, PRO-20, PRO-22, PRO-23, PRO-25…PRO-29, PRO-39, PRO-47,
// PRO-48; glossary §7, §24 default 9; rulings R-12, R-13).
//
// foldCommit is the 7-step algorithm for one board commit: pure (the previous state is never mutated), total
// (any BoardDraft folds; malformed input is a no-op, never an exception) and deterministic. It reads only its
// draft: no clock, no network, no local seat state. Plan 2 implements the effects of join, leave, seat_start,
// seat_end, event, caps and save; claim, release, request, request_status, answer, note, presume_absent and
// hold are generically checked and then fold as no-ops, so claims, requests, holds and notes stay empty (R-12).
//
// Folder walks a real board's first-parent chain: incrementally from a persisted (board, state), or, for a
// joiner or lost state, from the newest checkpoint at or below the tip, trusted (glossary §24 default 9).
// Every checkpoint height it folds is compared byte for byte; a mismatch is refolded once from the newest
// checkpoint this Folder byte-verified on the chain, else from genesis (P2-REFOLD), and one that persists
// sets checkpointMismatch (PRO-28, R-13). The verification is exported and restored across restarts
// (P2-FOLDPERSIST).
import { isOid, type Oid } from '../git/oid.js';
import type { GitRepo } from '../git/repo.js';
import { validId } from '../sec/validators.js';
import { readBoardCommit, RemoteContentError, type BoardCommitData, type BoardDraft, type WriterId } from './boardCommit.js';
import { canonicalBytes, type Json } from './canonicalJson.js';
import { parseOpId, type EpochId, type OpId, type PeerId } from './ids.js';
import { OPS_MAX_BYTES, OPS_MAX_LINES, parseOpLine, PLAN2_FOLDED_TYPES, REASON_CODE_RE, type EventKind, type JoinOp, type Op, type OpType, type TeamCaps } from './ops.js';
import { PROTO, type ProtocolJson } from './protocol.js';

export interface PeerRec {
  epoch: EpochId; status: 'active' | 'left' | 'absent'; retired_epochs: EpochId[];
  display: string; plugin_version: string; plugin_sha: string; regionSpec: string;
  config_fingerprint: Json; coauthor_optin: false | string; last_seq: number; last_height: number;
}
export interface FoldEvent { kind: EventKind; refs: string[]; reason_code: string; op_id: string; height: number; }
export interface FoldState {
  v: 1; height: number; proto: number; teamRegionSpec: string;
  caps: TeamCaps | null;
  peers: Record<PeerId, PeerRec>;
  /** Keyed `<peer>/<epoch>/<seat_id>`. */
  seats: Record<string, { status: 'live' | 'ended'; permission_mode: string; ended_height?: number }>;
  /** Empty in Plan 2 (R-12). */
  claims: Record<string, Json>; requests: Record<string, Json>; holds: Record<string, Json>; notes: Record<string, Json>;
  /** Keyed by the cid the op carried (never re-derived). */
  events: Record<string, FoldEvent>;
  last_save: { save_commit: string; saved_live: string; chain_base: string; height: number } | null;
  /** Claims, requests, holds, events, notes and ended seats (02-protocol §2 "record"). */
  record_count: number;
}
/**
 * An op of a commit written by this peer that folded as a no-op (02-protocol §2 "own-op rejection").
 * generic: step 3b (writer, seq or epoch: PRO-24 first bullet, renumber); type: the op failed its schema
 * (type 'unknown' for an unknown type) or its type-specific validity. A line without a parsable op id is not
 * reported, and lines past the first 1,000 / 64 KiB are not read at all.
 */
export interface OwnRejection { opId: string; type: OpType | 'unknown'; reason: 'generic' | 'type'; }
/**
 * Plan 8a (R-V03; 12 §2 "op verdict", §9.7 item 1): what the fold decided for one ops.jsonl line, for every writer.
 * effective: applied by a type with an effect in this build; unfolded: generic- and type-valid, folded as a deterministic
 * no-op (a type outside PLAN2_FOLDED_TYPES, R-12); rejected: the rest.
 */
export type OpVerdictKind = 'effective' | 'unfolded' | 'rejected';
export interface OpVerdict {
  /** 0-based index into BoardDraft.opsLines. */
  line: number;
  /** The parsed op's id; null when the fold did not parse the line (malformed, or never read). */
  opId: string | null;
  type: OpType | 'unknown';
  verdict: OpVerdictKind;
  /**
   * Only with 'rejected': malformed = parseOpLine or parseOpId null; generic = genericOk false, a line past the
   * 1,000-line/64 KiB loop bounds or a commit without an attributable writer (such lines are never parsed: opId null,
   * type 'unknown'); type = applyOp false.
   */
  reason?: 'malformed' | 'generic' | 'type';
}
/**
 * landedOwnOpIds: this peer's ops of the commit that folded without rejection (disjoint from ownRejections).
 * opVerdicts (Plan 8a, R-V03): one entry per opsLines element, in line order; independent of `self`.
 */
export interface FoldStepResult { state: FoldState; ownRejections: OwnRejection[]; landedOwnOpIds: string[]; protoMismatch: boolean; opVerdicts: OpVerdict[]; }

export const CHECKPOINT_EVERY = 256;
export const COMPACT_AGE = 512;
export const K_EVICT = 200;
export const REPLAY_MAX = 255;

const CONFLICT_KINDS: ReadonlySet<string> = new Set<EventKind>(['K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7', 'breach']);
const EVENT_KINDS: ReadonlySet<string> = new Set<EventKind>(['K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7', 'breach', 'freeze', 'unfreeze', 'incident', 'nonretryable', 'health']);
const OP_TYPES: ReadonlySet<string> = new Set<OpType>([
  'join', 'leave', 'caps', 'seat_start', 'seat_end', 'claim', 'release', 'request', 'request_status', 'answer', 'note', 'presume_absent', 'hold', 'event', 'save',
]);
const HOST_THROTTLED = 'HOST_THROTTLED';
/** An H() value: 8 Crockford base32 characters. */
const CID_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

type Seat = FoldState['seats'][string];
type Obj = Record<string, unknown>;

const has = (o: object, k: string): boolean => Object.hasOwn(o, k);
const isInt = (x: unknown, min: number): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= min;

function peerOf(s: FoldState, peer: string): PeerRec | undefined {
  return has(s.peers, peer) ? s.peers[peer] : undefined;
}

/** The empty state B0 folds onto (height −1): teamRegionSpec starts as the genesis protocol.json value (PRO-48). */
export function initialFoldState(protocol: ProtocolJson): FoldState {
  return {
    v: 1, height: -1, proto: isInt(protocol.proto, 0) ? protocol.proto : 0, teamRegionSpec: protocol.regionSpec, caps: null,
    peers: {}, seats: {}, claims: {}, requests: {}, holds: {}, notes: {}, events: {}, last_save: null, record_count: 0,
  };
}

/** A Cowork-Writer the fold can attribute: two 128-bit hex ids and a seq >= 1 (else every op is a no-op). */
function validWriter(w: WriterId | null): WriterId | null {
  if (w === null || typeof w !== 'object') return null;
  return validId('hex128', w.peer) && validId('hex128', w.epoch) && isInt(w.seq, 1) ? w : null;
}

/**
 * Step 3b (PRO-16): the op is the writer's (peer, epoch); its seq is below the writer seq, above the previous
 * op of the writer in this commit and above last_seq when the writer's epoch is the recorded one; the epoch
 * is not retired; and it is active, or the op is a join. Checked against the state as the commit has changed
 * it so far (a join of a new epoch makes later ops of the commit count against the new epoch).
 */
function genericOk(s: FoldState, w: WriterId, id: OpId, prevSeq: number, type: OpType): boolean {
  if (id.peer !== w.peer || id.epoch !== w.epoch) return false;
  if (id.seq >= w.seq || id.seq <= prevSeq) return false;
  const rec = peerOf(s, w.peer);
  if (rec !== undefined) {
    if (rec.retired_epochs.includes(w.epoch)) return false;
    if (rec.epoch === w.epoch && id.seq <= rec.last_seq) return false;
  }
  return type === 'join' || (rec !== undefined && rec.epoch === w.epoch && rec.status === 'active');
}

function endSeats(s: FoldState, peer: string, epoch: string, h: number): void {
  const prefix = `${peer}/${epoch}/`;
  for (const [key, seat] of Object.entries(s.seats)) {
    if (key.startsWith(prefix) && seat.status === 'live') s.seats[key] = { status: 'ended', permission_mode: seat.permission_mode, ended_height: h };
  }
}

/**
 * The join row of the §3.3 table (PRO-20): an unknown peer or a new epoch becomes the active recorded epoch
 * with last_seq := the join's seq, and a new epoch retires the previous one (its seats end; its claims and
 * addressed requests would be released/returned, none exist in Plan 2); a left or absent epoch rejoins with
 * its last_seq kept. The announced fields are recorded every time.
 */
function applyJoin(s: FoldState, w: WriterId, op: JoinOp, seq: number, h: number): void {
  const cf = op.config_fingerprint;
  const fields = {
    display: op.display, plugin_version: op.plugin_version, plugin_sha: op.plugin_sha, regionSpec: op.regionSpec,
    config_fingerprint: { filters: Object.fromEntries(Object.entries(cf.filters)), autocrlf: cf.autocrlf, eol_attrs: cf.eol_attrs, git: cf.git } as Json,
    coauthor_optin: op.coauthor_optin,
  };
  const rec = peerOf(s, w.peer);
  if (rec === undefined) {
    s.peers[w.peer] = { epoch: w.epoch, status: 'active', retired_epochs: [], ...fields, last_seq: seq, last_height: -1 };
    return;
  }
  if (rec.epoch !== w.epoch) {
    rec.retired_epochs.push(rec.epoch);
    endSeats(s, w.peer, rec.epoch, h);
    rec.epoch = w.epoch;
    rec.last_seq = seq;
  }
  rec.status = 'active';
  Object.assign(rec, fields);
}

/** Step 3c: type-specific validity and effects of a generically valid op; false = deterministic no-op. */
function applyOp(s: FoldState, w: WriterId, op: Op, seq: number, h: number): boolean {
  switch (op.type) {
    case 'join':
      applyJoin(s, w, op, seq, h);
      return true;
    case 'leave': {
      peerOf(s, w.peer)!.status = 'left';
      endSeats(s, w.peer, w.epoch, h);
      return true;
    }
    case 'seat_start': {
      const key = `${w.peer}/${w.epoch}/${op.seat_id}`;
      if (has(s.seats, key) && s.seats[key]!.status === 'live') return false;
      s.seats[key] = { status: 'live', permission_mode: op.permission_mode };
      return true;
    }
    case 'seat_end': {
      const key = `${w.peer}/${w.epoch}/${op.seat_id}`;
      const cur = has(s.seats, key) ? s.seats[key]! : undefined;
      if (cur === undefined || cur.status !== 'live') return false;
      s.seats[key] = { status: 'ended', permission_mode: cur.permission_mode, ended_height: h };
      return true;
    }
    case 'event': {
      // PRO-22: a conflict kind whose cid is already folded is a no-op (INV-ONE-EVENT backstop).
      if (CONFLICT_KINDS.has(op.kind) && has(s.events, op.cid)) return false;
      s.events[op.cid] = { kind: op.kind, refs: [...op.refs], reason_code: op.reason_code, op_id: op.id, height: h };
      return true;
    }
    case 'caps':
      s.caps = { custom_refs: op.custom_refs, lease: op.lease, delete: op.delete, push_options: op.push_options, two_parent_ok: op.two_parent_ok };
      return true;
    case 'save':
      // PRO-23: released_claim_ids would release the writer's own seats' claims; Plan 2 has none (R-12).
      s.last_save = { save_commit: op.save_commit, saved_live: op.saved_live, chain_base: op.chain_base, height: h };
      return true;
    default:
      // claim, release, request, request_status, answer, note, presume_absent, hold: no-ops in Plan 2 (R-12).
      return true;
  }
}

/** An own malformed line is reported only when it carries a parsable op id (else there is no op to act on). */
function malformedRejection(line: string): OwnRejection | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const id = (v as Obj)['id'];
  const type = (v as Obj)['type'];
  if (typeof id !== 'string' || parseOpId(id) === null) return null;
  return { opId: id, type: typeof type === 'string' && OP_TYPES.has(type) ? (type as OpType) : 'unknown', reason: 'type' };
}

/** Step 6 (PRO-48): switch to X′ when every peer of R announced X′ in its latest join. */
function reevaluateTeamRegionSpec(s: FoldState): void {
  const r = rankedSet(s);
  if (r.length === 0) return;
  const x = s.peers[r[0]!]!.regionSpec;
  if (x !== s.teamRegionSpec && r.every((p) => s.peers[p]!.regionSpec === x)) s.teamRegionSpec = x;
}

/**
 * Step 7 (PRO-27): drop terminal records with terminal_height <= h − 512. In Plan 2 those are events
 * (terminal at creation) and ended seats; no claim or request exists to reference a seat (R-12).
 * Live seats are never dropped.
 */
function compact(s: FoldState, h: number): void {
  const limit = h - COMPACT_AGE;
  for (const [cid, e] of Object.entries(s.events)) {
    if (e.height <= limit) delete s.events[cid];
  }
  for (const [key, seat] of Object.entries(s.seats)) {
    if (seat.status === 'ended' && seat.ended_height !== undefined && seat.ended_height <= limit) delete s.seats[key];
  }
}

function countRecords(s: FoldState): number {
  let ended = 0;
  for (const seat of Object.values(s.seats)) if (seat.status === 'ended') ended++;
  return Object.keys(s.claims).length + Object.keys(s.requests).length + Object.keys(s.holds).length
    + Object.keys(s.events).length + Object.keys(s.notes).length + ended;
}

/**
 * 02-protocol §3.3 7-step algorithm for one commit at height prev.height + 1 (0 for B0). Pure, total, never
 * throws; compaction at h mod 256 == 0. Only the first 1,000 lines whose LF lies within the first 64 KiB
 * are read (an over-16 KiB line among them is malformed). last_seq never decreases within an epoch (a
 * stale writer seq cannot make an already folded op id valid again, PRO-16).
 */
export function foldCommit(prev: FoldState, c: BoardDraft, self: PeerId): FoldStepResult {
  const s = structuredClone(prev);
  const h = prev.height + 1;
  s.height = h;
  const ownRejections: OwnRejection[] = [];
  const landedOwnOpIds: string[] = [];
  // Plan 8a (R-V03): one verdict per line, decided where the loop decides; a line the loop never reaches (no
  // attributable writer, or past the 1,000-line/64 KiB bounds) keeps this default.
  const opVerdicts: OpVerdict[] = c.opsLines.map((_, line) => ({ line, opId: null, type: 'unknown', verdict: 'rejected', reason: 'generic' }));
  // Step 2: another proto sets the local VERSION flag; folding continues (PRO-47).
  const proto = isInt(c.protocol.proto, 0) ? c.protocol.proto : 0;
  s.proto = proto;
  // Step 1: no attributable writer → every op is a no-op; go to step 5 (which then has nobody to update).
  const w = validWriter(c.writer);
  if (w !== null) {
    const own = w.peer === self;
    let prevSeq = 0;
    let bytes = 0;
    const n = Math.min(c.opsLines.length, OPS_MAX_LINES);
    for (let i = 0; i < n; i++) {
      const line = c.opsLines[i]!;
      bytes += Buffer.byteLength(line, 'utf8') + 1;
      if (bytes > OPS_MAX_BYTES) break;
      // Step 3a: schema, SEC-35 validators, registry reason codes; unknown fields ignored.
      const op = parseOpLine(line);
      if (op === null) {
        opVerdicts[i] = { line: i, opId: null, type: 'unknown', verdict: 'rejected', reason: 'malformed' };
        const r = own ? malformedRejection(line) : null;
        if (r !== null) ownRejections.push(r);
        continue;
      }
      const id = parseOpId(op.id);
      if (id === null) {
        // parseOpLine already refuses such an id (the line above); this guard reports it exactly as that refusal does.
        opVerdicts[i] = { line: i, opId: null, type: 'unknown', verdict: 'rejected', reason: 'malformed' };
        continue;
      }
      // Step 3b.
      const ok = genericOk(s, w, id, prevSeq, op.type);
      if (id.peer === w.peer && id.epoch === w.epoch && id.seq > prevSeq) prevSeq = id.seq;
      if (!ok) {
        opVerdicts[i] = { line: i, opId: op.id, type: op.type, verdict: 'rejected', reason: 'generic' };
        if (own) ownRejections.push({ opId: op.id, type: op.type, reason: 'generic' });
        continue;
      }
      // Step 3c.
      if (!applyOp(s, w, op, id.seq, h)) {
        opVerdicts[i] = { line: i, opId: op.id, type: op.type, verdict: 'rejected', reason: 'type' };
        if (own) ownRejections.push({ opId: op.id, type: op.type, reason: 'type' });
        continue;
      }
      opVerdicts[i] = { line: i, opId: op.id, type: op.type, verdict: PLAN2_FOLDED_TYPES.has(op.type) ? 'effective' : 'unfolded' };
      if (own) landedOwnOpIds.push(op.id);
    }
    // Step 4: Cowork-CS trailers are landing facts for grants (PRO-19); no grants exist in Plan 2 (R-12).
    // Step 5: the commit consumed a window, even when every op was a no-op.
    const rec = peerOf(s, w.peer);
    if (rec !== undefined) {
      rec.last_height = h;
      if (rec.epoch === w.epoch) rec.last_seq = Math.max(rec.last_seq, w.seq);
    }
  }
  // Step 6.
  reevaluateTeamRegionSpec(s);
  // Step 7.
  if (h % CHECKPOINT_EVERY === 0) compact(s, h);
  s.record_count = countRecords(s);
  return { state: s, ownRejections, landedOwnOpIds, protoMismatch: proto !== PROTO, opVerdicts };
}

/** RFC 8785 canonical JSON of the state (integers only): the checkpoint/state.json and journal bytes. */
export function serializeFold(s: FoldState): Buffer {
  return canonicalBytes(s as unknown as Json);
}

const STATE_KEYS = ['caps', 'claims', 'events', 'height', 'holds', 'last_save', 'notes', 'peers', 'proto', 'record_count', 'requests', 'seats', 'teamRegionSpec', 'v'];
const PEER_KEYS = ['coauthor_optin', 'config_fingerprint', 'display', 'epoch', 'last_height', 'last_seq', 'plugin_sha', 'plugin_version', 'regionSpec', 'retired_epochs', 'status'];
const CAPS_KEYS = ['custom_refs', 'delete', 'lease', 'push_options', 'two_parent_ok'];
const EVENT_KEYS = ['height', 'kind', 'op_id', 'reason_code', 'refs'];
const SAVE_KEYS = ['chain_base', 'height', 'save_commit', 'saved_live'];
const PEER_STATUS: ReadonlySet<string> = new Set(['active', 'left', 'absent']);

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function keysAre(o: Obj, keys: readonly string[]): boolean {
  const k = Object.keys(o).sort();
  return k.length === keys.length && k.every((x, i) => x === keys[i]);
}
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

function toPeer(v: unknown): PeerRec | null {
  if (!isObj(v) || !keysAre(v, PEER_KEYS)) return null;
  const { epoch, status, retired_epochs: retired, display, plugin_version: pv, plugin_sha: ps, regionSpec, config_fingerprint: cf, coauthor_optin: co, last_seq: ls, last_height: lh } = v;
  if (typeof epoch !== 'string' || !validId('hex128', epoch) || typeof status !== 'string' || !PEER_STATUS.has(status)) return null;
  if (!isStrArray(retired) || !retired.every((e) => validId('hex128', e))) return null;
  if (typeof display !== 'string' || typeof pv !== 'string' || typeof ps !== 'string' || typeof regionSpec !== 'string') return null;
  if (co !== false && typeof co !== 'string') return null;
  if (!isInt(ls, 0) || !isInt(lh, -1)) return null;
  return {
    epoch, status: status as PeerRec['status'], retired_epochs: retired, display, plugin_version: pv, plugin_sha: ps, regionSpec,
    config_fingerprint: cf as Json, coauthor_optin: co, last_seq: ls, last_height: lh,
  };
}

function toSeat(v: unknown): Seat | null {
  if (!isObj(v) || typeof v['permission_mode'] !== 'string') return null;
  if (v['status'] === 'live' && keysAre(v, ['permission_mode', 'status'])) return { status: 'live', permission_mode: v['permission_mode'] };
  if (v['status'] === 'ended' && keysAre(v, ['ended_height', 'permission_mode', 'status']) && isInt(v['ended_height'], 0)) {
    return { status: 'ended', permission_mode: v['permission_mode'], ended_height: v['ended_height'] };
  }
  return null;
}

function toEvent(v: unknown): FoldEvent | null {
  if (!isObj(v) || !keysAre(v, EVENT_KEYS)) return null;
  const { kind, refs, reason_code: rc, op_id: opId, height } = v;
  if (typeof kind !== 'string' || !EVENT_KINDS.has(kind) || !isStrArray(refs)) return null;
  if (typeof rc !== 'string' || !REASON_CODE_RE.test(rc) || typeof opId !== 'string' || !validId('op', opId) || !isInt(height, 0)) return null;
  return { kind: kind as EventKind, refs, reason_code: rc, op_id: opId, height };
}

/** Each value through `conv`, every key through `keyOk` (checked before it is used as a property name). */
function toRecord<T>(v: unknown, keyOk: (k: string) => boolean, conv: (x: unknown) => T | null): Record<string, T> | null {
  if (!isObj(v)) return null;
  const out: Record<string, T> = {};
  for (const [k, x] of Object.entries(v)) {
    if (!keyOk(k)) return null;
    const t = conv(x);
    if (t === null) return null;
    out[k] = t;
  }
  return out;
}

const seatKeyOk = (k: string): boolean => {
  const parts = k.split('/');
  return parts.length === 3 && parts.every((p) => validId('hex128', p));
};

function toFoldState(v: unknown): FoldState | null {
  if (!isObj(v) || !keysAre(v, STATE_KEYS)) return null;
  if (v['v'] !== 1 || !isInt(v['height'], -1) || !isInt(v['proto'], 0) || typeof v['teamRegionSpec'] !== 'string' || !isInt(v['record_count'], 0)) return null;
  const capsV = v['caps'];
  let caps: TeamCaps | null = null;
  if (capsV !== null) {
    if (!isObj(capsV) || !keysAre(capsV, CAPS_KEYS) || !CAPS_KEYS.every((k) => typeof capsV[k] === 'boolean')) return null;
    caps = { custom_refs: capsV['custom_refs'] as boolean, lease: capsV['lease'] as boolean, delete: capsV['delete'] as boolean, push_options: capsV['push_options'] as boolean, two_parent_ok: capsV['two_parent_ok'] as boolean };
  }
  const saveV = v['last_save'];
  let lastSave: FoldState['last_save'] = null;
  if (saveV !== null) {
    if (!isObj(saveV) || !keysAre(saveV, SAVE_KEYS) || !isOid(saveV['save_commit']) || !isOid(saveV['saved_live']) || !isOid(saveV['chain_base']) || !isInt(saveV['height'], 0)) return null;
    lastSave = { save_commit: saveV['save_commit'], saved_live: saveV['saved_live'], chain_base: saveV['chain_base'], height: saveV['height'] };
  }
  const peers = toRecord(v['peers'], (k) => validId('hex128', k), toPeer);
  const seats = toRecord(v['seats'], seatKeyOk, toSeat);
  const events = toRecord(v['events'], (k) => CID_RE.test(k), toEvent);
  const opaque = (x: unknown): Record<string, Json> | null => (isObj(x) ? (x as Record<string, Json>) : null);
  const claims = opaque(v['claims']);
  const requests = opaque(v['requests']);
  const holds = opaque(v['holds']);
  const notes = opaque(v['notes']);
  if (peers === null || seats === null || events === null || claims === null || requests === null || holds === null || notes === null) return null;
  const s: FoldState = {
    v: 1, height: v['height'], proto: v['proto'], teamRegionSpec: v['teamRegionSpec'], caps, peers, seats, claims, requests, holds, notes, events,
    last_save: lastSave, record_count: v['record_count'],
  };
  return countRecords(s) === s.record_count && !datedAbove(s) ? s : null;
}

/**
 * A record dated above the state's own height (final review minor, board): a fold at height h dates every event and
 * ended seat at the height that made it, a peer's last_height at its last board commit and the last save at its
 * commit, all ≤ h. Such a state is no fold's output; trusted as a joiner's checkpoint, a future-dated HOST_THROTTLED
 * event would read as newly folded on every later fold and restart the fallback every tick.
 */
function datedAbove(s: FoldState): boolean {
  const h = s.height;
  if (s.last_save !== null && s.last_save.height > h) return true;
  if (Object.values(s.events).some((e) => e.height > h)) return true;
  if (Object.values(s.seats).some((x) => x.ended_height !== undefined && x.ended_height > h)) return true;
  return Object.values(s.peers).some((p) => p.last_height > h);
}

/** The state serializeFold wrote, or null: anything else (another schema, non-canonical bytes, a BOM) is refused. */
export function parseFold(buf: Buffer): FoldState | null {
  try {
    const s = toFoldState(JSON.parse(buf.toString('utf8')));
    return s !== null && serializeFold(s).equals(buf) ? s : null;
  } catch {
    return null;
  }
}

/** Peers with an active epoch, sorted (glossary §3 live set). */
export function liveSet(s: FoldState): PeerId[] {
  return Object.keys(s.peers).filter((p) => s.peers[p]!.status === 'active').sort();
}

/** The live set minus ghosts: peers whose last board commit is K_EVICT or more heights below the state's height (−1: none). */
export function rankedSet(s: FoldState): PeerId[] {
  return liveSet(s).filter((p) => s.height - s.peers[p]!.last_height < K_EVICT);
}

/** PRO-39: 1 + |{p ∈ R : (last_height(p), p) < (last_height(self), self)}| (−1 when none); 1 when self ∉ R. */
export function governorRank(s: FoldState, self: PeerId): number {
  const r = rankedSet(s);
  if (!r.includes(self)) return 1;
  const mine = s.peers[self]!.last_height;
  let before = 0;
  for (const p of r) {
    const lh = s.peers[p]!.last_height;
    if (lh < mine || (lh === mine && p < self)) before++;
  }
  return 1 + before;
}

const isThrottle = (e: FoldEvent): boolean => e.kind === 'health' && e.reason_code === HOST_THROTTLED;

/** PRO-55 restart rule: a HOST_THROTTLED health event within the last `heights` first-parent heights. */
export function recentThrottleEvent(s: FoldState, heights: number): boolean {
  return Object.values(s.events).some((e) => isThrottle(e) && s.height - e.height < heights);
}

export interface VersionVerdict { proto: boolean; regionSpec: boolean; checkpointMismatch: boolean; }
/**
 * A board commit a fold call folded: where it sits and what it points at, never its bodies (final review FA-3: a
 * hostile range packs thousands of commits carrying multi-MB entries into a small push, so a call must not keep a body
 * per commit).
 */
export interface FoldedCommit {
  oid: Oid; firstParent: Oid | null; liveCode: Oid;
  /** The commit's protocol.json as read: on the newest record of the call only (the loop reads the tip's). */
  protocol?: ProtocolJson;
}
export interface FoldOutcome {
  board: Oid; state: FoldState;
  /** Folded by this call, oldest first: light records (FoldedCommit). */
  newCommits: FoldedCommit[];
  ownRejections: OwnRejection[]; landedOwnOpIds: string[];
  version: VersionVerdict;
  /** HOST_THROTTLED health events among newCommits. */
  throttleEventsFolded: number;
}

/** Commits read ahead of the one being folded (each read is a few git calls); nothing else of a range is held. */
const READ_AHEAD = 8;
/**
 * The commits one fold call keeps for a refold's second pass over them (estimated bytes, least recently used out
 * first). An honest board commit costs about a kilobyte, so a refold re-reads nothing on any realistic range; a hostile
 * range of multi-MB bodies is simply re-read.
 */
const READ_CACHE_MAX_BYTES = 16 * 1_048_576;

/**
 * What a cached BoardCommitData costs, counted from above: its ops lines and regionSpec as UTF-16, its checkpoint
 * bytes, every parent, change-set trailer and held id (a 1 MiB commit message can carry ~10,000 Cowork-CS trailers, and
 * git accepts ~21,000 repeated parents), and some overhead. readBoardCommit's strings hold no part of the commit text.
 */
function readCost(c: BoardCommitData): number {
  let n = 1_024 + 2 * c.protocol.regionSpec.length + (c.checkpoint?.length ?? 0);
  n += 128 * c.parents.length + 256 * c.cs.length + 128 * c.heldIds.length;
  for (const line of c.opsLines) n += 64 + 2 * line.length;
  return n;
}

/** Commits read by one fold call, bounded by READ_CACHE_MAX_BYTES (final review FA-3: never one entry per commit of a range). */
class ReadCache {
  private readonly entries = new Map<Oid, { c: BoardCommitData; cost: number }>();
  private bytes = 0;

  /** The cached commit, when it was read with its checkpoint or none is needed. */
  get(oid: Oid, withCheckpoint: boolean): BoardCommitData | undefined {
    const hit = this.entries.get(oid);
    if (hit === undefined || (withCheckpoint && hit.c.checkpoint === null)) return undefined;
    this.entries.delete(oid);
    this.entries.set(oid, hit);
    return hit.c;
  }

  put(c: BoardCommitData): void {
    const old = this.entries.get(c.oid);
    if (old !== undefined) {
      this.entries.delete(c.oid);
      this.bytes -= old.cost;
    }
    const cost = readCost(c);
    if (cost > READ_CACHE_MAX_BYTES) return;
    this.entries.set(c.oid, { c, cost });
    this.bytes += cost;
    for (const [oid, e] of this.entries) {
      if (this.bytes <= READ_CACHE_MAX_BYTES) break;
      this.entries.delete(oid);
      this.bytes -= e.cost;
    }
  }
}

interface StepReport { ownRejections: OwnRejection[]; landedOwnOpIds: string[]; throttle: number; }
interface Plan { state: FoldState; oids: Oid[]; }

function reportOf(r: FoldStepResult): StepReport {
  const h = r.state.height;
  const throttle = Object.values(r.state.events).filter((e) => e.height === h && isThrottle(e)).length;
  return { ownRejections: r.ownRejections, landedOwnOpIds: r.landedOwnOpIds, throttle };
}

/** PRO-28's byte comparison: the commit carries a checkpoint/state.json equal to serializeFold(s). */
function matches(c: BoardCommitData, s: FoldState): boolean {
  return c.checkpoint !== null && serializeFold(s).equals(c.checkpoint);
}

/**
 * What a Folder knows beyond the fold state (P2-FOLDPERSIST): the newest checkpoint it byte-verified (the
 * only refold base besides genesis, P2-REFOLD) and the R-13 flag. The caller persists it with each fold-state
 * update (meta.fold_verified, meta.checkpoint_mismatch) and passes it back at construction after a restart.
 */
export interface FoldVerification { verified: { board: Oid; height: number } | null; checkpointMismatch: boolean; }

/** A byte-verified checkpoint; `state` is a private copy (never handed out), null after a restore until the checkpoint is read back. */
interface Verified { board: Oid; height: number; state: FoldState | null; }

/** A restored verified checkpoint must name a commit oid at a checkpoint height; anything else is dropped. */
function restoredVerified(r: FoldVerification | null | undefined): Verified | null {
  const v = r?.verified;
  if (v === null || v === undefined || typeof v !== 'object') return null;
  return isOid(v.board) && isInt(v.height, 0) && v.height % CHECKPOINT_EVERY === 0 ? { board: v.board, height: v.height, state: null } : null;
}

/**
 * Incremental fold along the first-parent chain. from null (join, lost state): start at the newest checkpoint
 * ≤ tip (≤ 255 replayed), trusted (glossary §24 default 9) and never marked verified; B0 is verified on the
 * way by folding it once from the empty state. A `from` whose board is unknown, off the tip's first-parent
 * chain, or not at from.state's height is discarded and the fold starts at the checkpoint (PRO-25); `from` is
 * never handed to git. Every checkpoint height folded is compared byte for byte (PRO-28): a match marks it
 * verified and clears checkpointMismatch; a mismatch → one refold from the newest checkpoint this Folder
 * verified on this chain, below the checked height and at or below the height this call started from (so every
 * report of the call is recomputed), else from genesis (P2-REFOLD), whose state replaces the incremental one and
 * whose reports replace this call's; still different → checkpointMismatch, kept until a later checkpoint matches
 * (R-13), across restarts through `restored` (P2-FOLDPERSIST). A refold therefore never starts from an
 * unverified base. A board whose chain does not start at a genesis board commit is not foldable and throws
 * (the incident check guards the chain's shape before any fold); readBoardCommit's errors propagate as is.
 */
export class Folder {
  private readonly repo: GitRepo;
  private readonly self: PeerId;
  /** The checkpoint this Folder most recently byte-verified (PRO-28): the refold base when it is on the chain. */
  private verified: Verified | null;
  /** A checkpoint mismatch that survived one refold (R-13); cleared when a later checkpoint matches. */
  private mismatch: boolean;
  /** The last tip whose height this Folder counted (heightOf). */
  private known: { tip: Oid; height: number } | null = null;

  constructor(repo: GitRepo, self: PeerId, restored?: FoldVerification | null) {
    this.repo = repo;
    this.self = self;
    this.verified = restoredVerified(restored);
    this.mismatch = restored?.checkpointMismatch === true;
  }

  /** The verification to persist with the fold state (P2-FOLDPERSIST). */
  verification(): FoldVerification {
    const v = this.verified;
    return { verified: v === null ? null : { board: v.board, height: v.height }, checkpointMismatch: this.mismatch };
  }

  async foldTo(tip: Oid, from: { board: Oid; state: FoldState } | null, ownRegionSpec: string): Promise<FoldOutcome> {
    const cache = new ReadCache();
    const H = await this.heightOf(tip);
    const plan = (from === null ? null : await this.continueFrom(tip, H, from)) ?? (await this.startFromCheckpoint(tip, H, cache));
    let state = plan.state;
    // Every height above `start` is this call's: a refold must recompute all of their reports (P2-REFOLD).
    const start = plan.state.height;
    const reports = new Map<number, StepReport>();
    // Read in order, a few commits ahead, and folded as read: the call keeps a light record per commit (final review
    // FA-3), the newest commit's protocol.json, and the bounded read cache.
    const newCommits: FoldedCommit[] = [];
    let newest: ProtocolJson | null = null;
    for await (const c of this.readSeq(plan.oids, start + 1, cache)) {
      const r = foldCommit(state, c, this.self);
      state = r.state;
      reports.set(state.height, reportOf(r));
      if (state.height % CHECKPOINT_EVERY === 0) state = await this.verify(c, state, start, reports, cache);
      newCommits.push({ oid: c.oid, firstParent: c.firstParent, liveCode: c.liveCode });
      newest = c.protocol;
    }
    const last = newCommits[newCommits.length - 1];
    if (last !== undefined && newest !== null) last.protocol = newest;
    const ownRejections: OwnRejection[] = [];
    const landedOwnOpIds: string[] = [];
    let throttleEventsFolded = 0;
    for (const h of [...reports.keys()].sort((a, b) => a - b)) {
      const r = reports.get(h)!;
      ownRejections.push(...r.ownRejections);
      landedOwnOpIds.push(...r.landedOwnOpIds);
      throttleEventsFolded += r.throttle;
    }
    return {
      board: tip, state, newCommits, ownRejections, landedOwnOpIds,
      version: { proto: state.proto !== PROTO, regionSpec: ownRegionSpec !== state.teamRegionSpec, checkpointMismatch: this.mismatch },
      throttleEventsFolded,
    };
  }

  /**
   * The height H of a board tip: B0's only parent is the parentless L0, so the first-parent chain of a tip at
   * height H has H + 2 commits. A commit's chain never changes, so the last tip's height is remembered and an
   * unchanged tip (the idle loop) costs no git call.
   */
  private async heightOf(tip: Oid): Promise<number> {
    if (this.known !== null && this.known.tip === tip) return this.known.height;
    const H = (await this.repo.firstParentCount(tip)) - 2;
    if (!(H >= 0)) throw new RemoteContentError(`Folder: ${tip} is not a board commit`);
    this.known = { tip, height: H };
    return H;
  }

  /**
   * PRO-25: the commits after from.board up to tip (height H), when from.board is the commit at from.state's
   * height on tip's first-parent chain (the tip itself, with nothing to fold, when that height is H); else null
   * (discard `from`). Only the tip's own chain is listed, so an unknown, unrelated or off-chain from.board never
   * reaches git.
   */
  private async continueFrom(tip: Oid, H: number, from: { board: Oid; state: FoldState }): Promise<Plan | null> {
    const h0 = from.state.height;
    if (!Number.isSafeInteger(h0) || h0 < 0 || h0 > H) return null;
    if (h0 === H) return from.board === tip ? { state: from.state, oids: [] } : null;
    const n = H - h0;
    const chain = await this.repo.firstParents(tip, null, n + 1);
    if (chain.length !== n + 1 || chain[n] !== from.board) return null;
    return { state: from.state, oids: chain.slice(0, n).reverse() };
  }

  /**
   * PRO-29: the newest checkpoint at or below the tip that parses at its own height, trusted (glossary §24
   * default 9) and not marked verified (P2-REFOLD). At height 0 the fold of B0 from the empty state is
   * compared with B0's checkpoint instead: a match verifies B0 (same reads); otherwise the fold starts at genesis.
   */
  private async startFromCheckpoint(tip: Oid, H: number, cache: ReadCache): Promise<Plan> {
    for (let c = H - (H % CHECKPOINT_EVERY); c >= 0; c -= CHECKPOINT_EVERY) {
      const chain = (await this.repo.firstParents(tip, null, H - c + 1)).reverse();
      if (chain.length !== H - c + 1) throw new RemoteContentError(`Folder: the first-parent chain of ${tip} is shorter than its count`);
      const ck = await this.read(chain[0]!, true, cache);
      if (c === 0) {
        if (ck.firstParent !== null) break;
        const s0 = foldCommit(initialFoldState(ck.protocol), ck, this.self).state;
        if (!matches(ck, s0)) break;
        this.markVerified(ck.oid, 0, s0);
        return { state: s0, oids: chain.slice(1) };
      }
      const s = ck.checkpoint === null ? null : parseFold(ck.checkpoint);
      if (s !== null && s.height === c) return { state: s, oids: chain.slice(1) };
    }
    return this.fromGenesis(tip, H, cache);
  }

  private async fromGenesis(at: Oid, h: number, cache: ReadCache): Promise<Plan> {
    const chain = (await this.repo.firstParents(at, null, h + 1)).reverse();
    // B0 sits at height 0, a checkpoint height: read with its checkpoint, the fold's own pass finds it in the cache.
    const b0 = chain.length === h + 1 ? await this.read(chain[0]!, true, cache) : null;
    if (b0 === null || b0.firstParent !== null) throw new RemoteContentError(`Folder: the first-parent chain of ${at} does not start at a genesis board commit`);
    return { state: initialFoldState(b0.protocol), oids: chain };
  }

  /**
   * PRO-28 at a checkpoint height h: match → verified, flag cleared; mismatch → one refold (P2-REFOLD), whose
   * state and reports replace the incremental ones; still different → checkpointMismatch (R-13). A checkpoint
   * below h that the refold byte-matches on its way is verified too (B0 first, when it starts at genesis).
   * `start` is the height this call started folding from (its reports cover start + 1..h).
   */
  private async verify(c: BoardCommitData, state: FoldState, start: number, reports: Map<number, StepReport>, cache: ReadCache): Promise<FoldState> {
    const h = state.height;
    if (matches(c, state)) {
      this.markVerified(c.oid, h, state);
      this.mismatch = false;
      return state;
    }
    const base = await this.refoldBase(c.oid, h, start, cache);
    let s = base.state;
    for await (const x of this.readSeq(base.oids, base.state.height + 1, cache)) {
      const r = foldCommit(s, x, this.self);
      s = r.state;
      if (reports.has(s.height)) reports.set(s.height, reportOf(r));
      if (s.height < h && s.height % CHECKPOINT_EVERY === 0 && matches(x, s)) this.markVerified(x.oid, s.height, s);
    }
    if (matches(c, s)) {
      this.markVerified(c.oid, h, s);
      this.mismatch = false;
    } else {
      this.mismatch = true;
    }
    return s;
  }

  /**
   * Records a byte-verified checkpoint. Its state is a private copy: the state a call returns (or folds on
   * from) is the caller's, and a caller that edits it must not change a later refold's base.
   */
  private markVerified(board: Oid, height: number, state: FoldState): void {
    this.verified = { board, height, state: structuredClone(state) };
  }

  /**
   * P2-REFOLD: the newest checkpoint this Folder byte-verified, when it lies below h and at or below `start`
   * (so the refold recomputes every report this call produced: one at h itself would fold nothing, one above
   * `start` would keep the reports between `start` and it) and it is the commit at its height on the
   * first-parent chain of `at` (height h); else genesis. Never a checkpoint the board merely carries: a wrong
   * but self-consistent lineage would match its own later checkpoints. A restored checkpoint's state is read
   * back from its commit (the bytes this Folder matched before the restart).
   */
  private async refoldBase(at: Oid, h: number, start: number, cache: ReadCache): Promise<Plan> {
    const v = this.verified;
    if (v !== null && v.height < h && v.height <= start) {
      const n = h - v.height;
      const chain = await this.repo.firstParents(at, null, n + 1);
      if (chain.length === n + 1 && chain[n] === v.board) {
        v.state ??= await this.checkpointState(v.board, v.height, cache);
        if (v.state !== null) return { state: v.state, oids: chain.slice(0, n).reverse() };
      }
    }
    return this.fromGenesis(at, h, cache);
  }

  /** The checkpoint/state.json of `board` when it parses at `height`, else null. */
  private async checkpointState(board: Oid, height: number, cache: ReadCache): Promise<FoldState | null> {
    const ck = await this.read(board, true, cache);
    const s = ck.checkpoint === null ? null : parseFold(ck.checkpoint);
    return s !== null && s.height === height ? s : null;
  }

  /**
   * One board commit, from the call's cache or read (readBoardCommit's errors propagate typed). checkpoint/state.json is
   * read only when the caller compares or parses it (a checkpoint height, the starting checkpoint); held/ never (Plan 2
   * reads no held/ subtree). Every size and type check still runs on both.
   */
  private async read(oid: Oid, withCheckpoint: boolean, cache: ReadCache): Promise<BoardCommitData> {
    const hit = cache.get(oid, withCheckpoint);
    if (hit !== undefined) return hit;
    const c = await readBoardCommit(this.repo, oid, { checkpoint: withCheckpoint, held: false });
    cache.put(c);
    return c;
  }

  /**
   * The commits of `oids` in order, `oids[i]` at height firstHeight + i (its checkpoint read when that height is a
   * checkpoint height), read at most READ_AHEAD ahead of the one handed out: memory is bounded by the read-ahead, not
   * by the range (final review FA-3). A read that fails throws when its turn comes, so the earliest failing commit's
   * error is the one that propagates.
   */
  private async *readSeq(oids: readonly Oid[], firstHeight: number, cache: ReadCache): AsyncGenerator<BoardCommitData> {
    const ahead: Array<Promise<BoardCommitData>> = [];
    let next = 0;
    const fill = (): void => {
      while (ahead.length < READ_AHEAD && next < oids.length) {
        const i = next++;
        const p = this.read(oids[i]!, (firstHeight + i) % CHECKPOINT_EVERY === 0, cache);
        // Awaited in order below; a later read that fails meanwhile (or after an abandoned walk) is not an unhandled rejection.
        p.catch(() => undefined);
        ahead.push(p);
      }
    };
    fill();
    while (ahead.length > 0) {
      const c = await ahead.shift()!;
      fill();
      yield c;
    }
  }
}
