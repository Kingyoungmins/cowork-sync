// The hold record (glossary §9 verbatim; 05-holds §3.2, Table 1, Table 3; ruling R-03). One record is one
// `records/<id>.json` blob in the local registry (src/holds/registry.ts): canonical JSON (RFC 8785) of exactly
// the glossary §9 keys, an ABSENT side written as the string "ABSENT". parseRecord accepts only what
// serializeRecord writes: the schema, Table 1's residence × state combinations and canonical bytes.
import { canonicalBytes, type Json } from '../board/canonicalJson.js';
import type { PeerId } from '../board/ids.js';
import { ABSENT, isOid, type OidOrAbsent } from '../git/oid.js';
import { validId, validPathSyntax } from '../sec/validators.js';

export type HoldKind = 'PATCH' | 'PIN' | 'INCOMING';
export type Residence = 'ON_DISK' | 'OFF_DISK';
export type HoldState = 'ACTIVE' | 'CONFLICTED' | 'PARKED' | 'SUBSUMED' | 'GONE' | 'RESOLVED_PUBLISH' | 'RESOLVED_DISCARD';
export type Offer = 'none' | 'pending_leftover' | 'offered' | 'accepted' | 'returned';
export type BlobMap = Record<string, OidOrAbsent>;
export type HoldBlobs = { h0: BlobMap; h1: BlobMap } | { s1: BlobMap; s2: BlobMap; s3: BlobMap };
export interface Guard { name: string; class: 'PREDICATE' | 'DECISION'; owner: string; }
/** 05-holds §2 "age anchor content". */
export interface AgeAnchor { since_rev: number; anchor_wall_ms: number; mono_accum_ms: number; }
export interface HoldRecord {
  id: string; rev: number; owner: PeerId;
  kind: HoldKind; residence: Residence | null; state: HoldState; offer: Offer;
  declines: number; displaced_by: string | null;
  paths: string[];                          // repo-relative POSIX NFC, sorted
  blobs: HoldBlobs; guards: Guard[];
  origin: string;                           // 'human' | 'daemon' in Plan 2
  cs_ids: string[]; peer_authors: string[]; local_only: boolean;
  age_anchor: AgeAnchor; proto: 1;
}

/** The guards Plan 2 creates (ruling R-03). */
export type Plan2Guard = 'conflict' | 'restart' | 'phantom' | 'host-reject' | 'eol-bom' | 'join';

/** 05-holds Table 3: eol-bom is a PREDICATE guard, the rest are DECISION guards. */
export const PLAN2_GUARD_CLASS: Readonly<Record<Plan2Guard, 'PREDICATE' | 'DECISION'>> = Object.freeze({
  conflict: 'DECISION', restart: 'DECISION', phantom: 'DECISION', 'host-reject': 'DECISION', 'eol-bom': 'PREDICATE', join: 'DECISION',
});

/** 05-holds §2 "whole-path guard" (by name, without a `:<arg>`); every guard of a local_only record withholds its path whole too (MASK step 2). */
export const WHOLE_PATH_GUARDS: ReadonlySet<string> = Object.freeze(new Set(['eol-bom', 'generated?', 'portability', 'markers']));

/** Terminal states carry no residence (glossary §9, 05-holds Table 1). */
export const TERMINAL_STATES: ReadonlySet<HoldState> = Object.freeze(new Set<HoldState>(['SUBSUMED', 'GONE', 'RESOLVED_PUBLISH', 'RESOLVED_DISCARD']));

export function isTerminal(r: HoldRecord): boolean {
  return TERMINAL_STATES.has(r.state);
}

/** The held version: h1, or s2 (LOCAL) for a stage record. */
export function heldSide(r: HoldRecord): BlobMap {
  return 'h1' in r.blobs ? r.blobs.h1 : r.blobs.s2;
}

/** The name part of a guard `<name>[:<arg>]`. */
export function guardName(g: Guard): string {
  const colon = g.name.indexOf(':');
  return colon < 0 ? g.name : g.name.slice(0, colon);
}

// ---- validation ----------------------------------------------------------------------------------------

class RecordFormatError extends TypeError {
  constructor(what: string) {
    super(`hold record: ${what}`);
    this.name = 'RecordFormatError';
  }
}

type Obj = Record<string, unknown>;

function check(ok: boolean, what: string): void {
  if (!ok) throw new RecordFormatError(what);
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function exactKeys(v: unknown, want: readonly string[], what: string): Obj {
  check(isObj(v), `${what} is not an object`);
  const o = v as Obj;
  const have = Object.keys(o).sort();
  const w = [...want].sort();
  check(have.length === w.length && have.every((k, i) => k === w[i]), `${what} has keys [${have.join(', ')}]`);
  return o;
}

const int = (v: unknown, min: number): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
const CONTROL = /[\x00-\x1f\x7f]/;
const KINDS: ReadonlySet<string> = new Set<HoldKind>(['PATCH', 'PIN', 'INCOMING']);
const STATES: ReadonlySet<string> = new Set<HoldState>(['ACTIVE', 'CONFLICTED', 'PARKED', 'SUBSUMED', 'GONE', 'RESOLVED_PUBLISH', 'RESOLVED_DISCARD']);
const OFFERS: ReadonlySet<string> = new Set<Offer>(['none', 'pending_leftover', 'offered', 'accepted', 'returned']);
/** 05-holds Table 1: the non-terminal states each residence allows. */
const RESIDENCE_STATES: Readonly<Record<Residence, ReadonlySet<string>>> = {
  ON_DISK: new Set(['ACTIVE', 'CONFLICTED']),
  OFF_DISK: new Set(['PARKED', 'CONFLICTED']),
};
const RECORD_KEYS = [
  'id', 'rev', 'owner', 'kind', 'residence', 'state', 'offer', 'declines', 'displaced_by', 'paths', 'blobs', 'guards',
  'origin', 'cs_ids', 'peer_authors', 'local_only', 'age_anchor', 'proto',
];
const MAX_TEXT = 256;

function text(v: unknown, what: string): string {
  check(typeof v === 'string' && v.length > 0 && v.length <= MAX_TEXT && !CONTROL.test(v), `${what} must be a non-empty string without control characters`);
  return v as string;
}

/** One per-path blob map: keys exactly `paths` (h1 may omit paths of a filter-failure record, glossary §9), values oids or ABSENT. */
function checkBlobMap(v: unknown, paths: readonly string[], what: string, mayOmit: boolean): void {
  check(isObj(v), `${what} is not an object`);
  const m = v as Obj;
  const want = new Set(paths);
  for (const [p, o] of Object.entries(m)) {
    check(want.has(p), `${what} names ${JSON.stringify(p)}, which is not a path of the record`);
    check(o === ABSENT || isOid(o), `${what}[${JSON.stringify(p)}] must be an object id or ABSENT`);
  }
  if (!mayOmit) check(Object.keys(m).length === paths.length, `${what} does not name every path of the record`);
}

/** The whole glossary §9 schema plus Table 1 (residence × state); throws RecordFormatError (a TypeError). */
function checkRecord(v: unknown): HoldRecord {
  const o = exactKeys(v, RECORD_KEYS, 'record');
  check(typeof o['id'] === 'string' && validId('ulid', o['id']), 'id must be a ULID');
  check(int(o['rev'], 1), 'rev must be a safe integer >= 1');
  check(typeof o['owner'] === 'string' && validId('hex128', o['owner']), 'owner must be a peer id');
  check(typeof o['kind'] === 'string' && KINDS.has(o['kind']), 'kind must be PATCH, PIN or INCOMING');
  check(typeof o['state'] === 'string' && STATES.has(o['state']), 'unknown state');
  const state = o['state'] as HoldState;
  const residence = o['residence'];
  if (TERMINAL_STATES.has(state)) {
    check(residence === null, `a terminal record (${state}) has no residence`);
  } else {
    check(residence === 'ON_DISK' || residence === 'OFF_DISK', `a ${state} record needs residence ON_DISK or OFF_DISK`);
    check(RESIDENCE_STATES[residence as Residence].has(state), `${String(residence)} ${state} is not a residence × state of Table 1`);
    check(o['kind'] !== 'INCOMING' || (residence === 'ON_DISK' && state === 'ACTIVE'), 'an INCOMING record is ON_DISK ACTIVE or terminal');
  }
  check(typeof o['offer'] === 'string' && OFFERS.has(o['offer']), 'unknown offer');
  check(int(o['declines'], 0), 'declines must be a safe integer >= 0');
  check(o['displaced_by'] === null || (typeof o['displaced_by'] === 'string' && validId('op', o['displaced_by'])), 'displaced_by must be an op id or null');

  check(Array.isArray(o['guards']), 'guards is not an array');
  const guards = o['guards'] as unknown[];
  for (const g of guards) {
    const go = exactKeys(g, ['name', 'class', 'owner'], 'guard');
    text(go['name'], 'guard name');
    check(go['class'] === 'PREDICATE' || go['class'] === 'DECISION', 'guard class must be PREDICATE or DECISION');
    text(go['owner'], 'guard owner');
  }
  const filterFailure = (guards as Guard[]).some((g) => guardName(g) === 'filter-failure');
  const blobs = o['blobs'];
  check(isObj(blobs), 'blobs is not an object');

  check(Array.isArray(o['paths']), 'paths is not an array');
  const paths = o['paths'] as unknown[];
  // The one pathless record (Task 14 ruling, 05-holds F6): the host-reject PIN of a NONRETRYABLE board-only publish, which
  // has no change-set to hold — a PIN (h0/h1) carrying the host-reject guard. Every other record names at least one path.
  const pathlessHostReject = o['kind'] === 'PIN' && 'h0' in (blobs as Obj) && (guards as Guard[]).some((g) => guardName(g) === 'host-reject');
  check(paths.length > 0 || pathlessHostReject, 'paths is empty');
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    check(typeof p === 'string' && validPathSyntax(p), `paths[${i}] is not a valid path`);
    check(i === 0 || (paths[i - 1] as string) < (p as string), 'paths must be sorted and unique');
  }
  const ps = paths as string[];

  if ('h0' in (blobs as Obj)) {
    const b = exactKeys(blobs, ['h0', 'h1'], 'blobs');
    checkBlobMap(b['h0'], ps, 'blobs.h0', false);
    checkBlobMap(b['h1'], ps, 'blobs.h1', filterFailure);
  } else {
    const b = exactKeys(blobs, ['s1', 's2', 's3'], 'blobs');
    for (const s of ['s1', 's2', 's3']) checkBlobMap(b[s], ps, `blobs.${s}`, false);
  }

  text(o['origin'], 'origin');
  check(Array.isArray(o['cs_ids']) && (o['cs_ids'] as unknown[]).every((x) => typeof x === 'string' && validId('cs', x)), 'cs_ids must be change-set ids');
  check(Array.isArray(o['peer_authors']) && (o['peer_authors'] as unknown[]).every((x) => typeof x === 'string' && validId('hex128', x)), 'peer_authors must be peer ids');
  check(typeof o['local_only'] === 'boolean', 'local_only must be a boolean');
  const a = exactKeys(o['age_anchor'], ['since_rev', 'anchor_wall_ms', 'mono_accum_ms'], 'age_anchor');
  check(int(a['since_rev'], 1) && (a['since_rev'] as number) <= (o['rev'] as number), 'age_anchor.since_rev must be in 1..rev');
  check(int(a['anchor_wall_ms'], 0) && int(a['mono_accum_ms'], 0), 'age_anchor times must be safe integers >= 0');
  check(o['proto'] === 1, 'proto must be 1');
  return v as HoldRecord;
}

/** Canonical JSON of a valid record; anything outside the schema throws a TypeError before a byte is produced. */
export function serializeRecord(r: HoldRecord): Buffer {
  checkRecord(r);
  return canonicalBytes(r as unknown as Json);
}

/** The inverse of serializeRecord: JSON of the glossary §9 schema in canonical form, else a TypeError. */
export function parseRecord(buf: Buffer): HoldRecord {
  let v: unknown;
  try {
    v = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new RecordFormatError('not JSON');
  }
  const r = checkRecord(v);
  check(canonicalBytes(v as Json).equals(buf), 'not canonical JSON');
  return r;
}
