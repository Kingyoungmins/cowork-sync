// Board ops: the glossary §7 schema, the ops.jsonl encoding and caps (02-protocol §3.1; PRO-03, PRO-05, PRO-06, PRO-11).
//
// parseOpLine is total: any line becomes an Op or null (malformed: a fold no-op, 02-protocol §3.3 step 3a).
// The types the fold implements — Plan 2's seven (R-12) and Plan 3's `hold` (R3-24) — are parsed into exactly their
// glossary §7 fields, unknown fields dropped; the other seven are opaque (their effects are Plans 4 and 6): every
// field is kept, and only their SEC-35 fields (paths and ids) and reason_code are checked here.
import { isOid } from '../git/oid.js';
import { validId, validPathSyntax } from '../sec/validators.js';
import { canonicalJson, MAX_JSON_DEPTH, type Json } from './canonicalJson.js';
import { H, parseOpId } from './ids.js';

export type OpType = 'join' | 'leave' | 'caps' | 'seat_start' | 'seat_end' | 'claim' | 'release' | 'request' | 'request_status' | 'answer' | 'note' | 'presume_absent' | 'hold' | 'event' | 'save';

const OP_TYPES: ReadonlySet<string> = new Set<OpType>([
  'join', 'leave', 'caps', 'seat_start', 'seat_end', 'claim', 'release', 'request', 'request_status', 'answer', 'note', 'presume_absent', 'hold', 'event', 'save',
]);

/**
 * The types whose effects the fold implements (ruling R-12, plus `hold` since Plan 3 Task 3; the name is kept); the rest fold
 * as no-ops. The one place the fold's op verdicts read (Plan 8a, R-V03): an applied op of a type in this set is 'effective',
 * of any other type 'unfolded' — so a plan that gives a type its effect adds the type here in the same commit (X-90).
 */
export const PLAN2_FOLDED_TYPES: ReadonlySet<OpType> = new Set<OpType>(['join', 'leave', 'caps', 'seat_start', 'seat_end', 'event', 'save', 'hold']);

/** autocrlf: core.autocrlf or ''; eol_attrs: sha256 hex of the root .gitattributes blob oid at EPOCH_BASE or ''. */
export interface ConfigFingerprint { filters: Record<string, string>; autocrlf: string; eol_attrs: string; git: string; }
export interface JoinOp { id: string; type: 'join'; display: string; plugin_version: string; plugin_sha: string; proto: number; regionSpec: string; config_fingerprint: ConfigFingerprint; coauthor_optin: false | string; }
export interface LeaveOp { id: string; type: 'leave'; }
export interface CapsOp { id: string; type: 'caps'; custom_refs: boolean; lease: boolean; delete: boolean; push_options: boolean; two_parent_ok: boolean; }
export type TeamCaps = Omit<CapsOp, 'id' | 'type'>;
export interface SeatStartOp { id: string; type: 'seat_start'; seat_id: string; permission_mode: string; }
export interface SeatEndOp { id: string; type: 'seat_end'; seat_id: string; permission_mode: string; }
export type EventKind = 'K1' | 'K2' | 'K3' | 'K4' | 'K5' | 'K6' | 'K7' | 'breach' | 'freeze' | 'unfreeze' | 'incident' | 'nonretryable' | 'health';

/** The five-field claim label (label-convention/1; REG-14, SEC-35) — Task 5 type-only; Task 8 adds ClaimOp (R4-25). */
export interface ClaimLabel { kind: string; qualname: string; simple: string; type: string; disc: string; }
export interface EventOp { id: string; type: 'event'; cid: string; kind: EventKind; refs: string[]; reason_code: string; }
export interface SaveOp { id: string; type: 'save'; save_commit: string; saved_live: string; chain_base: string; released_claim_ids: string[]; }
/** A hold record's guard as the record carries it (glossary §9 `{name, class, owner}`), an unknown name included (HLD-05). */
export interface HoldOpGuard { name: string; class: 'PREDICATE' | 'DECISION'; owner: string; }
/**
 * The `hold` op (glossary §7, PRO-21; R3-24): exactly these fields. No blob oid and no text field: a mirrored record's
 * bytes are the held/<hold_id>/ tree entries of the carrying commit (PRO-05), and a local_only record is a content-free
 * stub (its paths, no oid, no held/ subtree). `declines`, `displaced_by`, `blobs`, `age_anchor` and `owner` are not in it.
 */
export interface HoldOp {
  id: string; type: 'hold';
  hold_id: string; rev: number; prev_rev: number | null;
  kind: 'PATCH' | 'PIN' | 'INCOMING'; residence: 'ON_DISK' | 'OFF_DISK' | null;
  state: 'ACTIVE' | 'CONFLICTED' | 'PARKED' | 'SUBSUMED' | 'GONE' | 'RESOLVED_PUBLISH' | 'RESOLVED_DISCARD';
  offer: 'none' | 'pending_leftover' | 'offered' | 'accepted' | 'returned';
  guards: HoldOpGuard[]; paths: string[]; origin: string; cs_ids: string[]; peer_authors: string[]; local_only: boolean;
}
export interface OpaqueOp { id: string; type: 'claim' | 'release' | 'request' | 'request_status' | 'answer' | 'note' | 'presume_absent'; [field: string]: Json; }
export type Op = JoinOp | LeaveOp | CapsOp | SeatStartOp | SeatEndOp | EventOp | SaveOp | HoldOp | OpaqueOp;
/** An op before its seq is allocated; event drafts carry cid '' (filled at seq allocation). */
export type OpDraft = Op extends infer O ? (O extends { id: string } ? Omit<O, 'id'> : never) : never;

/** The parser's value sets, pinned equal to record.ts's HoldKind, HoldState, Offer and Residence by a unit test (board imports nothing from holds). */
export const HOLD_OP_KINDS: ReadonlySet<string> = new Set<HoldOp['kind']>(['PATCH', 'PIN', 'INCOMING']);
export const HOLD_OP_STATES: ReadonlySet<string> = new Set<HoldOp['state']>(['ACTIVE', 'CONFLICTED', 'PARKED', 'SUBSUMED', 'GONE', 'RESOLVED_PUBLISH', 'RESOLVED_DISCARD']);
export const HOLD_OP_OFFERS: ReadonlySet<string> = new Set<HoldOp['offer']>(['none', 'pending_leftover', 'offered', 'accepted', 'returned']);
/** The non-null residences (a terminal record's residence is null). */
export const HOLD_OP_RESIDENCES: ReadonlySet<string> = new Set<Exclude<HoldOp['residence'], null>>(['ON_DISK', 'OFF_DISK']);

/** PRO-06: a `hold` op or draft with prev_rev === null is record-creating (R3-25); Task 4 withholds these at the 5,000-record cap. */
export function isHoldCreation(d: OpDraft | Op): boolean {
  return d.type === 'hold' && (d as { prev_rev?: unknown }).prev_rev === null;
}

export const OPS_MAX_LINES = 1_000;
export const OPS_MAX_BYTES = 65_536;
export const OP_MAX_LINE_BYTES = 16_384;
/** Message-code registry names (glossary §19). */
export const REASON_CODE_RE = /^[A-Z][A-Z0-9_]{2,47}$/;

/** A board build refused by a cap; `cap` is the cap that tripped (EF5 minors: BOARD_FULL names it, e.g. HELD_LISTING_MAX_BYTES). */
export class BoardCapError extends Error {
  readonly cap: number;
  constructor(message: string, cap: number) {
    super(message);
    this.name = 'BoardCapError';
    this.cap = cap;
  }
}

const EVENT_KINDS: ReadonlySet<string> = new Set<EventKind>(['K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7', 'breach', 'freeze', 'unfreeze', 'incident', 'nonretryable', 'health']);
/** An H() value: 8 Crockford base32 characters. */
const CID_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}
const isStr = (v: unknown): v is string => typeof v === 'string';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

function fingerprint(v: unknown): ConfigFingerprint | null {
  if (!isObj(v) || !isObj(v['filters'])) return null;
  const filters = v['filters'];
  if (!Object.values(filters).every(isStr)) return null;
  const { autocrlf, eol_attrs: eolAttrs, git } = v;
  if (!isStr(autocrlf) || !isStr(eolAttrs) || !isStr(git)) return null;
  // fromEntries defines own properties, so a "__proto__" driver name stays a plain key.
  return { filters: Object.fromEntries(Object.entries(filters as Record<string, string>)), autocrlf, eol_attrs: eolAttrs, git };
}

/** The typed Plan 2 ops: exactly their glossary §7 fields (unknown fields dropped); null when one is missing or out of range. */
function typed(id: string, type: OpType, v: Obj): Op | null {
  switch (type) {
    case 'join': {
      const { display, plugin_version: pv, plugin_sha: ps, proto, regionSpec, coauthor_optin: co } = v;
      const cf = fingerprint(v['config_fingerprint']);
      if (!isStr(display) || !isStr(pv) || !isStr(ps) || !isStr(regionSpec) || cf === null) return null;
      if (typeof proto !== 'number' || !Number.isSafeInteger(proto) || proto < 0) return null;
      if (co !== false && !isStr(co)) return null;
      return { id, type, display, plugin_version: pv, plugin_sha: ps, proto, regionSpec, config_fingerprint: cf, coauthor_optin: co };
    }
    case 'leave':
      return { id, type };
    case 'caps': {
      const { custom_refs: cr, lease, delete: del, push_options: po, two_parent_ok: tp } = v;
      if (!isBool(cr) || !isBool(lease) || !isBool(del) || !isBool(po) || !isBool(tp)) return null;
      return { id, type, custom_refs: cr, lease, delete: del, push_options: po, two_parent_ok: tp };
    }
    case 'seat_start':
    case 'seat_end': {
      const { seat_id: seat, permission_mode: mode } = v;
      if (!isStr(seat) || !validId('hex128', seat) || !isStr(mode)) return null;
      return { id, type, seat_id: seat, permission_mode: mode };
    }
    case 'event': {
      const { cid, kind, refs, reason_code: rc } = v;
      if (!isStr(cid) || !CID_RE.test(cid) || !isStr(kind) || !EVENT_KINDS.has(kind) || !isStrArray(refs)) return null;
      if (!isStr(rc) || !REASON_CODE_RE.test(rc)) return null;
      return { id, type, cid, kind: kind as EventKind, refs: [...refs], reason_code: rc };
    }
    case 'save': {
      const { save_commit: sc, saved_live: sl, chain_base: cb, released_claim_ids: rel } = v;
      if (!isOid(sc) || !isOid(sl) || !isOid(cb) || !isStrArray(rel)) return null;
      return { id, type, save_commit: sc, saved_live: sl, chain_base: cb, released_claim_ids: [...rel] };
    }
    case 'hold':
      return holdOp(id, v);
    default:
      return opaque(type, v);
  }
}

/** The longest guard name, guard owner or origin a hold op carries (record.ts's text rule). */
const MAX_TEXT = 256;
const GUARD_CLASSES: ReadonlySet<string> = new Set<HoldOpGuard['class']>(['PREDICATE', 'DECISION']);
/** The one guard that admits a pathless record, on a PIN only (R3-11; record.ts's rule): a board-only NONRETRYABLE's PIN. */
const PATHLESS_GUARD = 'host-reject';

const isInt = (x: unknown, min: number): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= min;

/** Non-empty, at most 256 UTF-16 units, no C0 control character and no DEL (as record.ts checks guard names, owners and origin). */
function isText(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_TEXT) return false;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

/** The name part of a guard `<name>[:<arg>]`. */
const guardNamePart = (name: string): string => {
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(0, colon);
};

/** What a hold op shares with its folded entry: every §7 field but id, type, hold_id and prev_rev. */
export type HoldFields = Omit<HoldOp, 'id' | 'type' | 'hold_id' | 'prev_rev'>;

/**
 * The shared fields of a hold op, checked field by field (PRO-21; R3-11, R3-24), as new objects; null when one is missing
 * or malformed: rev ≥ 1; kind, residence (or null), state and offer in their sets; guards `{name, class, owner}` (other
 * keys of a guard dropped, an unknown name kept); paths valid (SEC-35 validPathSyntax), sorted by UTF-16 code units and
 * unique as record.ts sorts them, and empty only for a PIN with a host-reject guard; origin non-empty; cs_ids change-set ids;
 * peer_authors peer ids; local_only a boolean. Shared by parseOpLine and parseFold (the folded entry, FoldState.holds).
 */
export function parseHoldFields(v: Readonly<Record<string, unknown>>): HoldFields | null {
  const { rev, kind, residence, state, offer, guards, paths, origin, cs_ids: csIds, peer_authors: authors, local_only: localOnly } = v;
  if (!isInt(rev, 1)) return null;
  if (!isStr(kind) || !HOLD_OP_KINDS.has(kind)) return null;
  if (residence !== null && !(isStr(residence) && HOLD_OP_RESIDENCES.has(residence))) return null;
  if (!isStr(state) || !HOLD_OP_STATES.has(state) || !isStr(offer) || !HOLD_OP_OFFERS.has(offer)) return null;
  if (!Array.isArray(guards)) return null;
  const gs: HoldOpGuard[] = [];
  for (const g of guards as unknown[]) {
    if (!isObj(g)) return null;
    const { name, class: cls, owner } = g;
    if (!isText(name) || !isStr(cls) || !GUARD_CLASSES.has(cls) || !isText(owner)) return null;
    gs.push({ name, class: cls as HoldOpGuard['class'], owner });
  }
  if (!isStrArray(paths) || !paths.every(validPathSyntax)) return null;
  for (let i = 1; i < paths.length; i++) {
    if (!(paths[i - 1]! < paths[i]!)) return null;
  }
  // record.ts's one pathless record: a PIN carrying the host-reject guard (R3-11).
  if (paths.length === 0 && !(kind === 'PIN' && gs.some((g) => guardNamePart(g.name) === PATHLESS_GUARD))) return null;
  if (!isText(origin)) return null;
  if (!isStrArray(csIds) || !csIds.every((s) => validId('cs', s))) return null;
  if (!isStrArray(authors) || !authors.every((s) => validId('hex128', s))) return null;
  if (!isBool(localOnly)) return null;
  return {
    rev, kind: kind as HoldOp['kind'], residence: residence as HoldOp['residence'], state: state as HoldOp['state'], offer: offer as HoldOp['offer'],
    guards: gs, paths: [...paths], origin, cs_ids: [...csIds], peer_authors: [...authors], local_only: localOnly,
  };
}

/** The typed hold op (glossary §7): hold_id a ULID, prev_rev null or 1 ≤ prev_rev < rev, the shared fields; unknown fields dropped. */
function holdOp(id: string, v: Obj): HoldOp | null {
  const { hold_id: holdId, prev_rev: prevRev } = v;
  if (!isStr(holdId) || !validId('ulid', holdId)) return null;
  const f = parseHoldFields(v);
  if (f === null) return null;
  const prev = prevRev === null ? null : isInt(prevRev, 1) && prevRev < f.rev ? prevRev : undefined;
  if (prev === undefined) return null;
  return { id, type: 'hold', hold_id: holdId, prev_rev: prev, ...f };
}

/** Fields of the opaque types that SEC-35 validates: paths and ids; plus reason_code (registry codes only). */
function opaque(type: OpType, v: Obj): Op | null {
  const required = type === 'claim' || type === 'request' ? 'path' : null;
  if (required !== null && !(required in v)) return null;
  if ('path' in v && !(isStr(v['path']) && validPathSyntax(v['path']))) return null;
  if ('paths' in v && !(isStrArray(v['paths']) && v['paths'].every(validPathSyntax))) return null;
  if ('cs_id' in v && !(isStr(v['cs_id']) && validId('cs', v['cs_id']))) return null;
  if ('cs_ids' in v && !(isStrArray(v['cs_ids']) && v['cs_ids'].every((s) => validId('cs', s)))) return null;
  if ('req_id' in v && !(isStr(v['req_id']) && validId('ulid', v['req_id']))) return null;
  if ('reason_code' in v && !(isStr(v['reason_code']) && REASON_CODE_RE.test(v['reason_code']))) return null;
  return v as OpaqueOp;
}

/**
 * True when v nests arrays/objects deeper than max (a scalar is depth 0, a container 1 + its deepest member).
 * An explicit stack, never recursion: the verdict cannot depend on the native stack.
 */
function nestedDeeperThan(v: unknown, max: number): boolean {
  const values: unknown[] = [v];
  const depths: number[] = [1];
  while (values.length > 0) {
    const x = values.pop();
    const d = depths.pop() as number;
    if (typeof x !== 'object' || x === null) continue;
    if (d > max) return true;
    for (const child of Array.isArray(x) ? x : Object.values(x)) {
      if (typeof child === 'object' && child !== null) {
        values.push(child);
        depths.push(d + 1);
      }
    }
  }
  return false;
}

/**
 * One ops.jsonl line → its op, or null when it is malformed: over 16 KiB, not a JSON object, nested deeper
 * than MAX_JSON_DEPTH (ruling P2-DEPTH; the whole line counts, unknown fields included), an unknown type, a
 * missing or out-of-range field, an id or path failing SEC-35, a reason_code outside the registry pattern, or
 * a value canonicalJson cannot write (1e999). Unknown fields are ignored. Never throws.
 */
export function parseOpLine(line: string): Op | null {
  try {
    if (typeof line !== 'string' || Buffer.byteLength(line, 'utf8') > OP_MAX_LINE_BYTES) return null;
    const v: unknown = JSON.parse(line);
    if (nestedDeeperThan(v, MAX_JSON_DEPTH) || !isObj(v)) return null;
    const { id, type } = v;
    if (!isStr(id) || parseOpId(id) === null || !isStr(type) || !OP_TYPES.has(type)) return null;
    const op = typed(id, type as OpType, v);
    if (op === null) return null;
    canonicalJson(op as unknown as Json);
    return op;
  } catch {
    return null;
  }
}

/**
 * ops.jsonl bytes: one canonical JSON line per op, each ending in LF, seqs strictly increasing.
 * Over 1,000 ops, a line over 16 KiB or more than 64 KiB in total → BoardCapError (PRO-03, PRO-06);
 * an op that would not parse back (parseOpLine null) or a seq that does not increase → Error.
 */
export function serializeOps(ops: readonly Op[]): Buffer {
  if (ops.length > OPS_MAX_LINES) throw new BoardCapError(`ops.jsonl: ${ops.length} ops > ${OPS_MAX_LINES}`, OPS_MAX_LINES);
  const parts: Buffer[] = [];
  let total = 0;
  let prevSeq = 0;
  ops.forEach((op, i) => {
    const line = canonicalJson(op as unknown as Json);
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > OP_MAX_LINE_BYTES) throw new BoardCapError(`ops.jsonl line ${i + 1}: ${bytes} bytes > ${OP_MAX_LINE_BYTES}`, OP_MAX_LINE_BYTES);
    if (parseOpLine(line) === null) throw new Error(`serializeOps: op ${i + 1} (${String(op.type)}) fails the op schema`);
    const seq = (parseOpId(op.id) as { seq: number }).seq;
    if (seq <= prevSeq) throw new Error(`serializeOps: op ${i + 1} seq ${seq} does not increase (previous ${prevSeq})`);
    prevSeq = seq;
    total += bytes + 1;
    if (total > OPS_MAX_BYTES) throw new BoardCapError(`ops.jsonl: more than ${OPS_MAX_BYTES} bytes at op ${i + 1}`, OPS_MAX_BYTES);
    parts.push(Buffer.from(`${line}\n`, 'utf8'));
  });
  return Buffer.concat(parts);
}

/** cid of a non-conflict event: H(event op id, kind) (02-protocol §3.2 item 4, PRO-11). */
export function eventCid(opId: string, kind: EventKind): string {
  return H(opId, kind);
}
