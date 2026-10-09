// Board ops: the glossary §7 schema, the ops.jsonl encoding and caps (02-protocol §3.1; PRO-03, PRO-05, PRO-06, PRO-11).
//
// parseOpLine is total: any line becomes an Op or null (malformed: a fold no-op, 02-protocol §3.3 step 3a).
// The seven types Plan 2 folds (R-12) are parsed into exactly their glossary §7 fields, unknown fields
// dropped; the other eight are opaque in Plan 2 (their effects are Plans 3, 4 and 6): every field is kept,
// and only their SEC-35 fields (paths and ids) and reason_code are checked here.
import { isOid } from '../git/oid.js';
import { validId, validPathSyntax } from '../sec/validators.js';
import { canonicalJson, MAX_JSON_DEPTH, type Json } from './canonicalJson.js';
import { H, parseOpId } from './ids.js';

export type OpType = 'join' | 'leave' | 'caps' | 'seat_start' | 'seat_end' | 'claim' | 'release' | 'request' | 'request_status' | 'answer' | 'note' | 'presume_absent' | 'hold' | 'event' | 'save';

const OP_TYPES: ReadonlySet<string> = new Set<OpType>([
  'join', 'leave', 'caps', 'seat_start', 'seat_end', 'claim', 'release', 'request', 'request_status', 'answer', 'note', 'presume_absent', 'hold', 'event', 'save',
]);

/** The types whose effects the Plan 2 fold implements (ruling R-12); the rest fold as no-ops. */
export const PLAN2_FOLDED_TYPES: ReadonlySet<OpType> = new Set<OpType>(['join', 'leave', 'caps', 'seat_start', 'seat_end', 'event', 'save']);

/** autocrlf: core.autocrlf or ''; eol_attrs: sha256 hex of the root .gitattributes blob oid at EPOCH_BASE or ''. */
export interface ConfigFingerprint { filters: Record<string, string>; autocrlf: string; eol_attrs: string; git: string; }
export interface JoinOp { id: string; type: 'join'; display: string; plugin_version: string; plugin_sha: string; proto: number; regionSpec: string; config_fingerprint: ConfigFingerprint; coauthor_optin: false | string; }
export interface LeaveOp { id: string; type: 'leave'; }
export interface CapsOp { id: string; type: 'caps'; custom_refs: boolean; lease: boolean; delete: boolean; push_options: boolean; two_parent_ok: boolean; }
export type TeamCaps = Omit<CapsOp, 'id' | 'type'>;
export interface SeatStartOp { id: string; type: 'seat_start'; seat_id: string; permission_mode: string; }
export interface SeatEndOp { id: string; type: 'seat_end'; seat_id: string; permission_mode: string; }
export type EventKind = 'K1' | 'K2' | 'K3' | 'K4' | 'K5' | 'K6' | 'K7' | 'breach' | 'freeze' | 'unfreeze' | 'incident' | 'nonretryable' | 'health';
export interface EventOp { id: string; type: 'event'; cid: string; kind: EventKind; refs: string[]; reason_code: string; }
export interface SaveOp { id: string; type: 'save'; save_commit: string; saved_live: string; chain_base: string; released_claim_ids: string[]; }
export interface OpaqueOp { id: string; type: 'claim' | 'release' | 'request' | 'request_status' | 'answer' | 'note' | 'presume_absent' | 'hold'; [field: string]: Json; }
export type Op = JoinOp | LeaveOp | CapsOp | SeatStartOp | SeatEndOp | EventOp | SaveOp | OpaqueOp;
/** An op before its seq is allocated; event drafts carry cid '' (filled at seq allocation). */
export type OpDraft = Op extends infer O ? (O extends { id: string } ? Omit<O, 'id'> : never) : never;

export const OPS_MAX_LINES = 1_000;
export const OPS_MAX_BYTES = 65_536;
export const OP_MAX_LINE_BYTES = 16_384;
/** Message-code registry names (glossary §19). */
export const REASON_CODE_RE = /^[A-Z][A-Z0-9_]{2,47}$/;

export class BoardCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoardCapError';
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
    default:
      return opaque(type, v);
  }
}

/** Fields of the opaque types that SEC-35 validates: paths and ids; plus reason_code (registry codes only). */
function opaque(type: OpType, v: Obj): Op | null {
  const required = type === 'claim' || type === 'request' ? 'path' : type === 'hold' ? 'paths' : null;
  if (required !== null && !(required in v)) return null;
  if ('path' in v && !(isStr(v['path']) && validPathSyntax(v['path']))) return null;
  if ('paths' in v && !(isStrArray(v['paths']) && v['paths'].every(validPathSyntax))) return null;
  if ('cs_id' in v && !(isStr(v['cs_id']) && validId('cs', v['cs_id']))) return null;
  if ('cs_ids' in v && !(isStrArray(v['cs_ids']) && v['cs_ids'].every((s) => validId('cs', s)))) return null;
  for (const k of ['hold_id', 'req_id']) {
    if (k in v && !(isStr(v[k]) && validId('ulid', v[k]))) return null;
  }
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
  if (ops.length > OPS_MAX_LINES) throw new BoardCapError(`ops.jsonl: ${ops.length} ops > ${OPS_MAX_LINES}`);
  const parts: Buffer[] = [];
  let total = 0;
  let prevSeq = 0;
  ops.forEach((op, i) => {
    const line = canonicalJson(op as unknown as Json);
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > OP_MAX_LINE_BYTES) throw new BoardCapError(`ops.jsonl line ${i + 1}: ${bytes} bytes > ${OP_MAX_LINE_BYTES}`);
    if (parseOpLine(line) === null) throw new Error(`serializeOps: op ${i + 1} (${String(op.type)}) fails the op schema`);
    const seq = (parseOpId(op.id) as { seq: number }).seq;
    if (seq <= prevSeq) throw new Error(`serializeOps: op ${i + 1} seq ${seq} does not increase (previous ${prevSeq})`);
    prevSeq = seq;
    total += bytes + 1;
    if (total > OPS_MAX_BYTES) throw new BoardCapError(`ops.jsonl: more than ${OPS_MAX_BYTES} bytes at op ${i + 1}`);
    parts.push(Buffer.from(`${line}\n`, 'utf8'));
  });
  return Buffer.concat(parts);
}

/** cid of a non-conflict event: H(event op id, kind) (02-protocol §3.2 item 4, PRO-11). */
export function eventCid(opId: string, kind: EventKind): string {
  return H(opId, kind);
}
