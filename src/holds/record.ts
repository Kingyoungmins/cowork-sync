// The hold record (glossary §9 verbatim; 05-holds §3.2, Table 1, Table 3; ruling R-03). One record is one
// `records/<id>.json` blob in the local registry (src/holds/registry.ts): canonical JSON (RFC 8785) of exactly
// the glossary §9 keys, an ABSENT side written as the string "ABSENT". parseRecord accepts only what
// serializeRecord writes: the schema, Table 1's residence × state combinations and canonical bytes.
//
// Plan 3 (Task 1; R3-09, R3-12): the closed Table 3 guard table with the 05 §2 argument grammar and `{REASON}` keys, the
// HLD-03 local_only causes and the 05 §2 whole-path test. Validation is Plan 2's: a guard name may be any text (a name
// outside Table 3 loads as an unknown DECISION guard, HLD-05), INCOMING is ON_DISK ACTIVE or terminal, and the pathless
// host-reject PIN of Plan 2 Task 14 stays the only empty-path record.
import { canonicalBytes, type Json } from '../board/canonicalJson.js';
import type { PeerId } from '../board/ids.js';
import { isSecretLike, type ScopeClass } from '../data/scope.js';
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

// ---- Table 3: the closed guard table (05-holds §3.3, §2; HLD-05; ruling R3-09) ----------------------------------------

export type GuardClass = 'PREDICATE' | 'DECISION';
/** 05-holds §2 `{REASON}` keys (Table 3's last column, plus `local` for a local_only record). */
export type ReasonKey = 'answer' | 'bundle' | 'checks' | 'unstable' | 'incoming' | 'form' | 'markers' | 'local' | 'revert' | 'conflict' | 'git' | 'user' | 'wake-scope';
export type GuardName = 'claim' | 'dependency' | 't0' | 'unreadable' | 'unstable' | 'lock' | 'unmaterializable' | 'eol-bom' | 'eol-form' | 'markers'
  | 'local-only-conflict' | 'filter-failure' | 'secret-scan' | 'revert' | 'conflict' | 'claim-breach' | 'base-move' | 'join' | 'restart' | 'phantom'
  | 'host-reject' | 'portability' | 'generated?' | 'collision' | 'quarantine-review' | 'wake-scope';
/**
 * One Table 3 row: class, the owner column verbatim, the `{REASON}` key, whether the guard withholds its path whole (05 §2),
 * whether Table 3 names a human `--publish` among its releases, and whether the name takes a `:<arg>` (05 §2 grammar).
 */
export interface GuardRow { name: GuardName; cls: GuardClass; owner: string; key: ReasonKey; wholePath: boolean; humanRelease: boolean; takesArg: boolean; }

const row = (name: GuardName, cls: GuardClass, owner: string, key: ReasonKey, wholePath = false, humanRelease = false, takesArg = false): GuardRow =>
  Object.freeze({ name, cls, owner, key, wholePath, humanRelease, takesArg });

/** 05-holds Table 3 in row order, owner column verbatim (HLD-05). */
export const GUARD_TABLE: readonly GuardRow[] = Object.freeze([
  row('claim', 'PREDICATE', 'HLD/REG', 'answer', false, false, true),
  row('dependency', 'PREDICATE', 'HLD', 'bundle', false, false, true),
  row('t0', 'PREDICATE', 'HLD/REG', 'checks'),
  row('unreadable', 'PREDICATE', 'HLD/ENG', 'unstable'),
  row('unstable', 'PREDICATE', 'HLD/ENG', 'unstable'),
  row('lock', 'PREDICATE', 'HLD/ENG', 'incoming'),
  row('unmaterializable', 'PREDICATE', 'DAT', 'incoming'),
  row('eol-bom', 'PREDICATE', 'DAT', 'form', true),
  row('eol-form', 'PREDICATE', 'DAT', 'form'),
  row('markers', 'PREDICATE', 'DAT/HLD', 'markers', true),
  row('local-only-conflict', 'PREDICATE', 'HLD', 'incoming'),
  row('filter-failure', 'DECISION', 'DAT/SEC', 'local', false, true),
  row('secret-scan', 'DECISION', 'SEC (local human, glossary §16)', 'local', false, true),
  row('revert', 'DECISION', 'HLD', 'revert', false, true),
  row('conflict', 'DECISION', 'DAT', 'conflict', false, true),
  row('claim-breach', 'DECISION', 'DAT/COO', 'conflict', false, true),
  row('base-move', 'DECISION', 'ENG', 'git'),
  row('join', 'DECISION', 'LIF', 'user', false, true),
  row('restart', 'DECISION', 'ENG', 'git', false, true),
  row('phantom', 'DECISION', 'ENG', 'user', false, true),
  row('host-reject', 'DECISION', 'ENG', 'user'),
  row('portability', 'DECISION', 'DAT', 'user', true),
  row('generated?', 'DECISION', 'DAT', 'user', true, true, true),
  row('collision', 'DECISION', 'DAT', 'user', false, true, true),
  row('quarantine-review', 'DECISION', 'SEC (local human)', 'user'),
  row('wake-scope', 'DECISION', 'local human', 'wake-scope', false, true),
]);

const ROW_INDEX: ReadonlyMap<string, number> = new Map(GUARD_TABLE.map((r, i) => [r.name, i] as const));

/** The name part of `<name>[:<arg>]`. */
function namePart(full: string): string {
  const colon = full.indexOf(':');
  return colon < 0 ? full : full.slice(0, colon);
}

/** Row of `<name>[:<arg>]`; null for a name outside Table 3 (an unknown DECISION guard: never released or transitioned here, HLD-05). */
export function guardRow(full: string): GuardRow | null {
  const i = ROW_INDEX.get(namePart(full));
  return i === undefined ? null : GUARD_TABLE[i]!;
}

/** claim_id: 16 lowercase base32 characters (glossary §2 "claim"). */
const CLAIM_ID = /^[a-z2-7]{16}$/;
/** 05 §2 guard arguments: required for claim and dependency, the two human answers for generated? and collision, none elsewhere. */
const ARG_RULES: Readonly<Partial<Record<GuardName, { required: boolean; ok: (arg: string) => boolean }>>> = {
  claim: { required: true, ok: (a) => CLAIM_ID.test(a) },
  dependency: { required: true, ok: (a) => validId('ulid', a) },
  'generated?': { required: false, ok: (a) => a === 'exclude' },
  collision: { required: false, ok: (a) => a === 'keep' },
};

/** A Table 3 guard with its fixed class and owner; throws on an unknown name or a malformed argument (05 §2 grammar; `generated?:exclude`, `collision:keep`). */
export function makeGuard(full: string): Guard {
  if (typeof full !== 'string') throw new TypeError(`guard: ${String(full)} is not a string`);
  const r = guardRow(full);
  if (r === null) throw new TypeError(`guard: ${JSON.stringify(full)} is not a Table 3 guard`);
  const colon = full.indexOf(':');
  const rule = ARG_RULES[r.name];
  if (colon < 0) {
    if (rule?.required === true) throw new TypeError(`guard: ${r.name} needs an argument`);
  } else if (rule === undefined || !rule.ok(full.slice(colon + 1))) {
    throw new TypeError(`guard: ${JSON.stringify(full)} has a malformed argument`);
  }
  return { name: full, class: r.cls, owner: r.owner };
}

/** The `<arg>` of a guard, or null. */
export function guardArg(g: Guard): string | null {
  const colon = g.name.indexOf(':');
  return colon < 0 ? null : g.name.slice(colon + 1);
}

/** A guard whose name is outside Table 3 (written by a newer daemon): a DECISION guard this daemon never releases or transitions (HLD-05). */
export function isUnknownGuard(g: Guard): boolean {
  return guardRow(g.name) === null;
}

/** The guards Plan 2 creates (ruling R-03), a view of GUARD_TABLE. */
export type Plan2Guard = Extract<GuardName, 'conflict' | 'restart' | 'phantom' | 'host-reject' | 'eol-bom' | 'join'>;

/** 05-holds Table 3's class of the Plan 2 guards (eol-bom PREDICATE, the rest DECISION), derived from GUARD_TABLE. */
export const PLAN2_GUARD_CLASS: Readonly<Record<Plan2Guard, GuardClass>> = Object.freeze(Object.fromEntries(
  (['conflict', 'restart', 'phantom', 'host-reject', 'eol-bom', 'join'] as const).map((n) => [n, guardRow(n)!.cls] as const),
) as Record<Plan2Guard, GuardClass>);

/** 05-holds §2 "whole-path guard" (by name, without a `:<arg>`); every guard of a local_only record withholds its path whole too (MASK step 2). */
export const WHOLE_PATH_GUARDS: ReadonlySet<string> = Object.freeze(new Set(GUARD_TABLE.filter((r) => r.wholePath).map((r) => r.name)));

/** Terminal states carry no residence (glossary §9, 05-holds Table 1). */
export const TERMINAL_STATES: ReadonlySet<HoldState> = Object.freeze(new Set<HoldState>(['SUBSUMED', 'GONE', 'RESOLVED_PUBLISH', 'RESOLVED_DISCARD']));

export function isTerminal(r: HoldRecord): boolean {
  return TERMINAL_STATES.has(r.state);
}

/**
 * A BlobMap entry by own key: `__proto__` and `constructor` are valid root paths, so a plain `m[p]` read (which finds
 * Object.prototype members) or write (which `__proto__` turns into a prototype change) is never used on a BlobMap.
 */
export function blobAt(m: BlobMap, path: string): OidOrAbsent | undefined {
  return Object.prototype.hasOwnProperty.call(m, path) ? m[path] : undefined;
}

/** Sets a BlobMap entry as an own enumerable property (see blobAt). */
export function setBlob(m: BlobMap, path: string, oid: OidOrAbsent): void {
  Object.defineProperty(m, path, { value: oid, enumerable: true, writable: true, configurable: true });
}

/** The held version: h1, or s2 (LOCAL) for a stage record. */
export function heldSide(r: HoldRecord): BlobMap {
  return 'h1' in r.blobs ? r.blobs.h1 : r.blobs.s2;
}

/** The name part of a guard `<name>[:<arg>]`. */
export function guardName(g: Guard): string {
  return namePart(g.name);
}

/** Table 3 row index of a guard; an unknown name ranks after every row (05 §2 `{REASON}`, Task 1). */
function rank(g: Guard): number {
  return ROW_INDEX.get(guardName(g)) ?? GUARD_TABLE.length;
}

/**
 * {REASON} key (05 §2): 'local' for a local_only record, else the key of the first DECISION guard in Table 3 row order, else
 * of the first PREDICATE guard (record order ignored); `dependency:<id>` → 'answer' when record <id> carries a `claim` guard
 * (a SHADOW PATCH or a claim PIN), else 'bundle'; an unknown name is a DECISION guard ranked after every row → 'user';
 * null for an empty guard set.
 */
export function reasonKey(r: HoldRecord, lookup: (id: string) => HoldRecord | undefined): ReasonKey | null {
  if (r.local_only) return 'local';
  if (r.guards.length === 0) return null;
  const isDecision = (g: Guard): boolean => isUnknownGuard(g) || guardRow(g.name)!.cls === 'DECISION';
  const decision = r.guards.filter(isDecision);
  const pool = decision.length > 0 ? decision : r.guards;
  const first = [...pool].sort((a, b) => rank(a) - rank(b))[0]!;
  const row = guardRow(first.name);
  if (row === null) return 'user';
  if (row.name === 'dependency') {
    const target = lookup(guardArg(first) ?? '');
    const viaClaim = target !== undefined && (target.kind === 'PATCH' || target.kind === 'PIN') && target.guards.some((g) => guardName(g) === 'claim');
    return viaClaim ? 'answer' : 'bundle';
  }
  return row.key;
}

export type LocalOnlyCause = 'filter-failure' | 'secret-scan' | 'secret-like' | 'not-live' | 'marker-companion';

/**
 * HLD-03 / DAT-31: why the record is local_only at this rev ([] = it is not); secret-like per the U10 list in src/data/scope.ts.
 * A LOCAL_ONLY scope class counts as 'not-live' only when otherLocalOnly(p) — another non-terminal ON_DISK local_only record
 * (id ≠ r.id) covers p, computed by the registry — else as LIVE (r's own effect, D5 row 9). A path the scope cannot classify
 * (scopeOf throws: a scope error, attributes never requested) counts as 'not-live': local_only never fails open (R3-71).
 * A record carrying `portability` counts as 'not-live' too (final review F3): its name is NOT_ADMITTED by D6 rule 2.6 for exactly as
 * long as the guard holds (portabilityStep releases it when D7 passes), while the registry's scope is D5 (scopeOfTracked, no D7 row),
 * which classes a stageable name LIVE once a later iteration requested its attributes (ensureRecordAttrs) — without this every later
 * rev (an age flush at a clean exit, an attach, a guard) would make the record mirrored and put the not-admitted bytes into held/.
 * Causes in declaration order.
 */
export function localOnlyCauses(
  r: Pick<HoldRecord, 'paths' | 'guards'>, scopeOf: (path: string) => ScopeClass, isCompanion: boolean, otherLocalOnly: (path: string) => boolean,
): LocalOnlyCause[] {
  const out: LocalOnlyCause[] = [];
  const names = new Set(r.guards.map(guardName));
  if (names.has('filter-failure')) out.push('filter-failure');
  if (names.has('secret-scan')) out.push('secret-scan');
  if (r.paths.some((p) => isSecretLike(p))) out.push('secret-like');
  const notLive = (p: string): boolean => {
    let cls: ScopeClass;
    try {
      cls = scopeOf(p);
    } catch {
      return true;   // R3-71: no bytes are mirrored for a path we cannot classify
    }
    return cls === 'LOCAL_ONLY' ? otherLocalOnly(p) : cls !== 'LIVE';
  };
  if (names.has('portability') || r.paths.some(notLive)) out.push('not-live');
  if (isCompanion) out.push('marker-companion');
  return out;
}

/** 05 §2 whole-path guards: eol-bom, generated? (any argument), portability, markers, and every guard of a local_only record. */
export function hasWholePathGuard(r: HoldRecord): boolean {
  if (r.local_only && r.guards.length > 0) return true;
  return r.guards.some((g) => WHOLE_PATH_GUARDS.has(guardName(g)));
}

/**
 * A K4 record (03-data DAT-43) that still IS the conflict function's TAKE_TIP displacement: stage blobs, CONFLICTED, still carrying the
 * displacement guard `conflict` (ruling R3-EF4-14; the engine's other readings of a pending displacement key on the same guard: apply.ts
 * onDiskConflictRecords, evaluate.ts "displacement pending"). Only such a record is INV-HLD-ATOMIC-PUB's exception (c) (glossary §24
 * default 3): it never pins its group (HLD-42). Stage blobs are a lasting mark of a K4-born record, the displacement a passing one:
 * HLD-17's RESTORE releases `conflict` and the record keeps its stages, so from then on it withholds like any other record (`markers`
 * after a conflicted restore, MASK step 4 while it stays CONFLICTED). HLD-42's OFF_DISK `claim-breach` pin is Plan 4's (no such guard in
 * Plan 3) and is not read here.
 */
export function isK4Displacement(r: HoldRecord): boolean {
  return 's2' in r.blobs && r.state === 'CONFLICTED' && r.guards.some((g) => guardName(g) === 'conflict');
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
