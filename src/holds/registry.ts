// The local hold registry refs/cowork-local/<enc(b)>/holds (glossary §9; 05-holds HLD-01…HLD-07, HLD-09, §2 age anchor;
// rulings R-02, R-03, R3-09…R3-14).
//
// An append-only commit chain: each transition is one commit `cowork-holds` whose first parent is the previous
// registry commit and whose tree is the whole registry,
//
//   records/<id>.json   blob   the newest rev of every record (src/holds/record.ts, canonical JSON)
//   blobs/<oid>         blob   every blob a record names, and every pre-image and target an inflight operator names (Task 5; ABSENT has no entry)
//                              and every blob a restore wrote that local.json's `restored` still names (E16-E)
//   local.json          blob   this PC's bookkeeping the record schema cannot carry (R3-13; present only when non-empty)
//
// so every referenced blob is reachable for `git gc --prune=now`; older revs and the blobs they named stay
// reachable through the chain. Metadata trees come from mktree (ruling R-15). The ref changes only by one CAS
// update-ref --create-reflog per registry commit, with crashpoint('registry.cas') immediately before and after it; a
// lost CAS is a second writer (security log, RegistryCasLostError; the caller exits as for ENG-03). load()
// re-attaches the registry at start (HLD-01). Blob content enters only by oid: the caller wrote it through the
// pinned clean path (HLD-03), and the registry refuses an oid that is not a blob in the object store.
//
// Plan 3 (Task 1): hold() takes every Table 3 guard with the 05 §2 grammar and the INCOMING kind, guard-less births only
// OFF_DISK PARKED (R3-10); HLD-07 one change, one id (holdOutcome: R-02's stage dedupe, the K4 onto an ON_DISK record of
// the same path set, then equal or REBASE-converging records, R3-14); local_only recomputed at every rev (R3-12); guards
// compose with AND (addGuard/releaseGuard); a record carrying a guard outside Table 3 is never released or transitioned
// here (HLD-05, R3-09), only its age re-persisted; offers through offerNext (HLD-09); batched commits (commitMany); and
// the 05 §2 age anchor (ageMs, flushAgeAnchors). This module reads no claim state (HLD-06).
// Ruling R3-EF4-24 (DAT-46 defence in depth): a record whose held side carries a restore-marker row is local_only at that rev
// (a content-free stub mirror), never refused; the verdict reads the held-side blobs (one cat-file --batch for those not known yet).
import { canonicalBytes, type Json } from '../board/canonicalJson.js';
import type { PeerId } from '../board/ids.js';
import { hasRestoreMarkerRow } from '../data/rows.js';
import type { ScopeClass } from '../data/scope.js';
import { ABSENT, isOid, OidError, parseOid, type Oid, type OidOrAbsent } from '../git/oid.js';
import { GitCommandError, type GitRepo, type MktreeEntry, type TreeMap } from '../git/repo.js';
import type { Clock } from '../ports/clock.js';
import { crashpoint } from '../ports/crashpoint.js';
import type { Log } from '../ports/log.js';
import { ulid, type Random } from '../ports/random.js';
import type { Trace } from '../ports/trace.js';
import { validId, validPathSyntax } from '../sec/validators.js';
import { offerNext, type OfferEvent } from './offers.js';
import { HoldOperatorError, type RebaseCache } from './rebase.js';
import {
  TERMINAL_STATES, blobAt, guardName, guardRow, heldSide, isTerminal, isUnknownGuard, localOnlyCauses, makeGuard, parseRecord, serializeRecord,
  type BlobMap, type Guard, type HoldBlobs, type HoldKind, type HoldRecord, type Offer, type Residence,
} from './record.js';

export interface NewRecord {
  kind: HoldKind; residence: Residence; state: 'ACTIVE' | 'CONFLICTED' | 'PARKED';
  paths: string[]; blobs: HoldBlobs;
  guard: string | null;          // `<name>[:<arg>]` from Table 3; null only for an OFF_DISK PARKED birth (R3-10)
  origin: string; cs_ids: string[]; displaced_by: string | null;
  local_only?: boolean;          // ignored since Plan 3: recomputed (HLD-03, R3-12)
  offer?: Offer;                 // default 'none'; 'pending_leftover' at a SHADOW/K2/K3/K6 birth (HLD-09)
  peer_authors?: string[];       // default []
  companionOf?: string;          // a marker companion's parent (05 §3.4 item 3)
  copyOf?: string;               // Task 12b: HLD-64's copy-restore copy of the foreign record `copyOf` (local.json `copies` until its RESTORE completes)
  settleCopyOf?: string;         // final review r2 A-2: the restart's safety copy of record `settleCopyOf`'s interrupted whole park (local.json `settleCopies`)
}
// Plan 2 record shapes: conflict = PATCH CONFLICTED (ON_DISK on the publish side until the apply writes TIP, then OFF_DISK; R-02);
// restart = PATCH ACTIVE ON_DISK; phantom, host-reject, join = PIN ACTIVE ON_DISK; eol-bom = PATCH ACTIVE ON_DISK (whole path).
export interface RegistryDeps {
  repo: GitRepo; ref: string; random: Random; clock: Clock; peer: PeerId; trace: Trace; log: Log;   // Plan 2
  scopeOf: () => (path: string) => ScopeClass;   // the current iteration's scope (R3-12)
  A: () => TreeMap;                              // the current A (HLD-07 convergence)
  rebase: RebaseCache;
}
export interface HoldOutcome { id: string; created: boolean; attachedGuard: string | null; conflictedExisting: boolean; }
export type HoldPatch = Partial<Pick<HoldRecord, 'residence' | 'state' | 'blobs' | 'guards' | 'offer' | 'declines' | 'displaced_by' | 'paths' | 'cs_ids' | 'peer_authors'>>;
/** No prev_rev value: a prev_rev rejection is a race and always re-drafts, never recorded (R3-27); generic/type recorded like validator (R3-70). */
export type MirrorRejectReason = 'validator' | 'held_subtree' | 'local_only_stub' | 'generic' | 'type';
/**
 * A PARK, RESTORE or ON_DISK --discard between its registry commit and its final transition (record before displacement, HLD-16): settled at
 * restart by DISK_EQ (settleHoldOps). (Task 1 declares it; Task 5 uses park/restore, Task 11 discard with final = { state: 'RESOLVED_DISCARD' })
 */
export interface InflightOp {
  op: 'park' | 'restore' | 'discard';
  entries: Array<{ path: string; expected: OidOrAbsent; target: OidOrAbsent }>;   // expected = the pre-image per path, target = the write
  final: HoldPatch;                                                                // the closing transition, committed after WRITTEN
  explicit: boolean;                                                               // a restore marks the record explicit when it completes
  /**
   * Final review r3 A3-3 (Ruling R3-FF3-A3): set by PARK (op 'park' only) to its own HLD-16 decision — true when it withheld r whole
   * (PIN, CONFLICTED, local_only, a whole-path guard, R3-18 on the pre-park sides, or a MASK conflict) and so refreshed the held side
   * := S_disk first, false for a target of r's step-5 MASK alone. The restart settlement reads it instead of recomputing R3-18 from the
   * refreshed record; absent in the markers park's entry, every other op's and an entry written before this field (then recomputed).
   */
  whole?: boolean;
}
/** Registry tree blob local.json (R3-13); never mirrored; a Plan 2 tree without local.json loads as all-empty. */
export interface RegistryLocal {
  companions: Record<string, string>;
  explicit: string[];
  rejected: Record<string, { key: string; reason: MirrorRejectReason }>;
  inflight: Record<string, InflightOp>;   // hold id → its interrupted-operator bookkeeping (Task 1)
  keepSyncing: string[];                  // sorted, unique: paths whose `generated?` record was answered "keep syncing"; written by markKeepSyncing (Task 11)
  /**
   * Task 12b (carry 3): HLD-64 copy-restore copies whose RESTORE has not completed — copy id → the foreign hold id it copies; set in the
   * copy's creation commit (NewRecord.copyOf), cleared once the copy is restored (or ended). A restart ends a copy still OFF_DISK here
   * GONE (settleHoldOps): a copy is made only for its one command, whose repeat makes a fresh one. Absent from local.json when empty.
   */
  copies: Record<string, string>;
  /**
   * Final review r2 A-2: the safety copies settleHoldOps made for interrupted whole parks (holdOps.ts settleCopy) — copy id → the record
   * whose park it settled; set in the copy's creation commit (NewRecord.settleCopyOf), so no later restart takes a copy with h0 ABSENT
   * for a collision-take capture (R3-67's settlement); cleared at a restart once the copy is restored (ON_DISK) or ended. Not HLD-64's
   * `copies` (whose OFF_DISK entries a restart ends GONE). Absent from local.json and from this object when empty (an older registry's
   * bytes and shape are unchanged).
   */
  settleCopies?: Record<string, string>;
  /**
   * E16-E (HLD-17, HLD-26 (b); contract "no unobserved delta … in this run or after a restart"): a RESTORE's observed writes that a
   * restart must still recognise — record id → one entry per written path: `written` (the blob the restore wrote) and `snap`
   * (state:snap's entry at p when it wrote: the restart reseeds the private index from state:snap and a restore makes no snap transition,
   * HLD-57 (e), so the first materialized delta of p after a restart starts there). Set in the restore's final commit (and in the
   * restart's completion of an interrupted restore); dropped by the commit that moves the record off the disk or ends it. The written
   * blobs are named by blobs/ (gc keeps them: R3-EF4-13 judges a later delta from the written blob). Absent when empty (an older
   * registry's bytes and shape are unchanged). Ruling R3-EF4-30: one entry per path over the whole map, the newest write wins — a
   * restore's commit removes its paths from every other id's list (and an id whose list empties).
   */
  restored?: Record<string, RestoredWrite[]>;
}

/** One restore write the restart re-seeds into ObservedWrites (RegistryLocal.restored). */
export interface RestoredWrite { path: string; written: OidOrAbsent; snap: OidOrAbsent; }

/** A second writer moved the registry ref: security log + exit (as ENG-03). */
export class RegistryCasLostError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'RegistryCasLostError';
  }
}

/** The registry commit subject. */
const HOLDS_SUBJECT = 'cowork-holds';
/** The security log code of a lost registry CAS. */
const CAS_LOST_CODE = 'HOLDS_CAS_LOST';
const RECORDS = 'records/';
const BLOBS = 'blobs/';
const RECORD_SUFFIX = '.json';
const LOCAL_JSON = 'local.json';
/** A valid ULID used only to validate a birth before its id is drawn. */
const PROBE_ID = '00000000000000000000000000';
const KINDS: ReadonlySet<string> = new Set<HoldKind>(['PATCH', 'PIN', 'INCOMING']);
const PATCH_KEYS: ReadonlySet<string> = new Set(['residence', 'state', 'blobs', 'guards', 'offer', 'declines', 'displaced_by', 'paths', 'cs_ids', 'peer_authors']);
/** Patch members a record carrying an unknown guard refuses (HLD-05: never released or transitioned here). */
const GUARDED_PATCH_KEYS: readonly string[] = ['state', 'residence', 'guards', 'offer'];
const REJECT_REASONS: ReadonlySet<string> = new Set<MirrorRejectReason>(['validator', 'held_subtree', 'local_only_stub', 'generic', 'type']);
const INFLIGHT_OPS: ReadonlySet<string> = new Set(['park', 'restore', 'discard']);
const EMPTY_LOCAL: RegistryLocal = deepFreeze({ companions: {}, explicit: [], rejected: {}, inflight: {}, keepSyncing: [], copies: {} });
/** HLD-17: the displacement guards a RESTORE releases (G2 #8: a copy attached to an ON_DISK record never adds them). */
const RESTORE_RELEASES: ReadonlySet<string> = new Set(['conflict', 'claim-breach', 'base-move']);

function sameMap(a: BlobMap, b: BlobMap): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => blobAt(b, k) !== undefined && blobAt(a, k) === blobAt(b, k));
}

function sameBlobs(a: HoldBlobs, b: HoldBlobs): boolean {
  if ('h1' in a && 'h1' in b) return sameMap(a.h0, b.h0) && sameMap(a.h1, b.h1);
  if ('s2' in a && 's2' in b) return sameMap(a.s1, b.s1) && sameMap(a.s2, b.s2) && sameMap(a.s3, b.s3);
  return false;
}

/**
 * EF4 E4-1 (ruling R3-EF4-7; 05-holds §3.4 items 3–4, 03-data line 319: "a record carrying `markers` is never refreshed from disk"): a
 * stage call (K4) whose attach would put its stages on a target carrying `markers` is a caller-contract violation (TypeError). The
 * registry cannot read blobs, so it cannot tell a marker-bearing s2 from a clean one; the caller (apply.ts k4OntoMarkers) keeps the
 * displaced marker file in a marker companion and transitions the target with marker-free stages itself. Stages equal to the target's
 * own are no refresh.
 */
function refuseMarkersRefresh(target: HoldRecord, stages: HoldBlobs): void {
  if (!target.guards.some((g) => guardName(g) === 'markers') || sameBlobs(target.blobs, stages)) return;
  throw new TypeError(`hold: a K4 (stage call) onto hold record ${target.id}, which carries markers, would refresh it from disk (05 §3.4 item 3): keep the marker file in a marker companion`);
}

/** An HLD-07 attach: the target record and the patch (possibly empty) that adds the birth to it. */
interface Attach { target: HoldRecord; patch: HoldPatch; attachedGuard: string | null; conflictedExisting: boolean; }

function samePaths(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((p, i) => p === b[i]);
}

function blobOids(r: HoldRecord): Oid[] {
  const out: Oid[] = [];
  for (const m of Object.values(r.blobs) as BlobMap[]) for (const o of Object.values(m)) if (o !== ABSENT) out.push(o);
  return out;
}

/**
 * Task 5: the pre-image and target blobs of every interrupted operator (local.json `inflight`). blobs/ names them too while the
 * entry exists, so a `git gc --prune=now` between an operator's registry commit and its write never drops the bytes restart's
 * settlement (settleHoldOps) and the private index it reseeds may still name (Review Focus 3).
 */
function inflightOids(l: RegistryLocal): Oid[] {
  const out: Oid[] = [];
  for (const op of Object.values(l.inflight)) for (const e of op.entries) for (const o of [e.expected, e.target]) if (o !== ABSENT) out.push(o);
  // E16-E: a restore's written blob stays reachable while a restart may re-seed it (RegistryLocal.restored).
  for (const ws of Object.values(l.restored ?? {})) for (const w of ws) if (w.written !== ABSENT) out.push(w.written);
  return out;
}

/** E16-E: local.json without the `restored` entries of records that `stored` moves off the disk or ends (none left: the key dropped). */
function pruneRestored(l: RegistryLocal, stored: readonly HoldRecord[]): RegistryLocal {
  const r = l.restored;
  if (r === undefined) return l;
  const gone = stored.filter((x) => Object.prototype.hasOwnProperty.call(r, x.id) && (isTerminal(x) || x.residence !== 'ON_DISK')).map((x) => x.id);
  return gone.length === 0 ? l : editLocal(l, (m) => { for (const id of gone) delete m.restored![id]; });
}

/** Every blob the registry tree keeps reachable: those the records name and those the inflight operators name. */
function namedOids(records: Iterable<HoldRecord>, l: RegistryLocal): string[] {
  return [...new Set<string>([...[...records].flatMap(blobOids), ...inflightOids(l)])].sort();
}

/** The held side of a birth's blob maps (h1, or s2 for a stage record). */
function heldOf(b: HoldBlobs): BlobMap {
  return 'h1' in b ? b.h1 : b.s2;
}

/** R3-EF4-24: the held side (h1, or s2) of a blob set as given, before validation; undefined for a malformed one (serializeRecord refuses it). */
function heldMap(b: unknown): BlobMap | undefined {
  if (b === null || typeof b !== 'object') return undefined;
  const m: unknown = 'h1' in b ? (b as { h1: unknown }).h1 : (b as { s2?: unknown }).s2;
  return m !== null && typeof m === 'object' ? (m as BlobMap) : undefined;
}

/** The blob oids a side names (ABSENT and anything malformed left out). */
function sideOids(m: BlobMap | undefined): string[] {
  return m === undefined ? [] : Object.values(m).filter((o): o is Oid => typeof o === 'string' && isOid(o));
}

/** A blob read that failed for the object (a corrupt or missing object): git's refusal or the batch parser's (publish.ts unreadableError). */
const unreadableBlob = (e: unknown): boolean => e instanceof GitCommandError || e instanceof OidError || (e instanceof Error && Object.getPrototypeOf(e) === Error.prototype);

/** The original base side: h0, or s1 for a stage record. */
function baseOf(b: HoldBlobs): BlobMap {
  return 'h0' in b ? b.h0 : b.s1;
}

function unknownGuards(r: HoldRecord): Guard[] {
  return r.guards.filter(isUnknownGuard);
}

/** Freezes a parsed record and every object and array inside it (records are plain JSON trees). */
function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    for (const x of Object.values(v as Record<string, unknown>)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

/** The stored form of a record: parsed back from its canonical bytes (a validated deep copy that shares nothing with a caller), deeply frozen. */
function storedRecord(buf: Buffer): HoldRecord {
  return deepFreeze(parseRecord(buf));
}

// ---- local.json ------------------------------------------------------------------------------------------------------

function localIsEmpty(l: RegistryLocal): boolean {
  return Object.keys(l.companions).length === 0 && l.explicit.length === 0 && Object.keys(l.rejected).length === 0
    && Object.keys(l.inflight).length === 0 && l.keepSyncing.length === 0 && Object.keys(l.copies).length === 0
    && Object.keys(l.settleCopies ?? {}).length === 0 && Object.keys(l.restored ?? {}).length === 0;
}

/**
 * local.json's canonical bytes; an empty `copies` (Task 12b) and an empty `settleCopies` (final review r2 A-2) are left out, so a
 * registry that never copied keeps its earlier bytes.
 */
function localBytes(l: RegistryLocal): Buffer {
  const { copies, settleCopies, restored, ...rest } = l;
  return canonicalBytes({
    ...rest,
    ...(Object.keys(copies).length === 0 ? {} : { copies }),
    ...(settleCopies === undefined || Object.keys(settleCopies).length === 0 ? {} : { settleCopies }),
    ...(restored === undefined || Object.keys(restored).length === 0 ? {} : { restored }),
  } as unknown as Json);
}

class LocalFormatError extends TypeError {
  constructor(what: string) {
    super(`hold registry local.json: ${what}`);
    this.name = 'LocalFormatError';
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sortedUnique(xs: readonly string[]): boolean {
  return xs.every((x, i) => i === 0 || (xs[i - 1] as string) < x);
}

const oidOrAbsent = (v: unknown): boolean => v === ABSENT || isOid(v);

/** One InflightOp as written by this module (shape only; its final patch is validated when it is committed). */
function checkInflight(id: string, v: unknown): InflightOp {
  if (!isPlainObject(v)) throw new LocalFormatError(`inflight[${id}] is not an object`);
  const keys = Object.keys(v).sort().join(',');
  if (keys !== 'entries,explicit,final,op' && keys !== 'entries,explicit,final,op,whole') throw new LocalFormatError(`inflight[${id}] has keys ${keys}`);
  if (typeof v['op'] !== 'string' || !INFLIGHT_OPS.has(v['op'])) throw new LocalFormatError(`inflight[${id}].op`);
  if (typeof v['explicit'] !== 'boolean') throw new LocalFormatError(`inflight[${id}].explicit`);
  if ('whole' in v && (typeof v['whole'] !== 'boolean' || v['op'] !== 'park')) throw new LocalFormatError(`inflight[${id}].whole`);   // final review r3 A3-3
  if (!isPlainObject(v['final']) || !Object.keys(v['final']).every((k) => PATCH_KEYS.has(k))) throw new LocalFormatError(`inflight[${id}].final`);
  const entries = v['entries'];
  if (!Array.isArray(entries)) throw new LocalFormatError(`inflight[${id}].entries`);
  for (const e of entries) {
    if (!isPlainObject(e) || Object.keys(e).sort().join(',') !== 'expected,path,target') throw new LocalFormatError(`inflight[${id}] entry shape`);
    if (typeof e['path'] !== 'string' || !validPathSyntax(e['path']) || !oidOrAbsent(e['expected']) || !oidOrAbsent(e['target'])) {
      throw new LocalFormatError(`inflight[${id}] entry values`);
    }
  }
  return v as unknown as InflightOp;
}

/**
 * local.json as written by this module: canonical JSON of the RegistryLocal shape (`keepSyncing` may be missing: []; `copies` too: {};
 * `settleCopies` is present only when non-empty, final review r2 A-2).
 */
function parseLocal(buf: Buffer): RegistryLocal {
  let v: unknown;
  try {
    v = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new LocalFormatError('not JSON');
  }
  if (!isPlainObject(v)) throw new LocalFormatError('not an object');
  if (!canonicalBytes(v as Json).equals(buf)) throw new LocalFormatError('not canonical JSON');
  const keys = Object.keys(v).filter((k) => k !== 'keepSyncing' && k !== 'copies' && k !== 'settleCopies' && k !== 'restored').sort().join(',');
  if (keys !== 'companions,explicit,inflight,rejected' || Object.keys(v).length > 8) throw new LocalFormatError(`keys ${Object.keys(v).join(',')}`);
  const restored = (v as Record<string, unknown>)['restored'];
  if (restored !== undefined && (!isPlainObject(restored) || Object.keys(restored).length === 0
    || !Object.entries(restored).every(([k, ws]) => validId('ulid', k) && Array.isArray(ws) && ws.length > 0
      && ws.every((w) => isPlainObject(w) && Object.keys(w).sort().join(',') === 'path,snap,written' && typeof w['path'] === 'string'
        && validPathSyntax(w['path']) && oidOrAbsent(w['written']) && oidOrAbsent(w['snap']))))) {
    throw new LocalFormatError('restored');
  }
  const { companions, explicit, rejected, inflight } = v as Record<string, unknown>;
  const keepSyncing = (v as Record<string, unknown>)['keepSyncing'] ?? [];
  const copies = (v as Record<string, unknown>)['copies'] ?? {};
  const settleCopies = (v as Record<string, unknown>)['settleCopies'];
  const ulidOk = (x: unknown): boolean => typeof x === 'string' && validId('ulid', x);
  if (!isPlainObject(companions) || !Object.entries(companions).every(([k, p]) => ulidOk(k) && ulidOk(p))) throw new LocalFormatError('companions');
  if (!Array.isArray(explicit) || !explicit.every(ulidOk) || !sortedUnique(explicit as string[])) throw new LocalFormatError('explicit');
  if (!isPlainObject(rejected) || !Object.entries(rejected).every(([k, r]) => ulidOk(k) && isPlainObject(r)
    && Object.keys(r).sort().join(',') === 'key,reason' && typeof r['key'] === 'string' && (r['key'] as string).length > 0
    && typeof r['reason'] === 'string' && REJECT_REASONS.has(r['reason']))) {
    throw new LocalFormatError('rejected');
  }
  if (!isPlainObject(inflight)) throw new LocalFormatError('inflight');
  const flights: Record<string, InflightOp> = {};
  for (const [id, op] of Object.entries(inflight)) {
    if (!ulidOk(id)) throw new LocalFormatError('inflight id');
    flights[id] = checkInflight(id, op);
  }
  if (!Array.isArray(keepSyncing) || !keepSyncing.every((p) => typeof p === 'string' && validPathSyntax(p)) || !sortedUnique(keepSyncing as string[])) {
    throw new LocalFormatError('keepSyncing');
  }
  if (!isPlainObject(copies) || !Object.entries(copies).every(([k, f]) => ulidOk(k) && ulidOk(f))) throw new LocalFormatError('copies');
  if (settleCopies !== undefined && (!isPlainObject(settleCopies) || Object.keys(settleCopies).length === 0
    || !Object.entries(settleCopies).every(([k, f]) => ulidOk(k) && ulidOk(f)))) {
    throw new LocalFormatError('settleCopies');
  }
  return deepFreeze({
    companions: companions as Record<string, string>, explicit: explicit as string[],
    rejected: rejected as RegistryLocal['rejected'], inflight: flights, keepSyncing: keepSyncing as string[], copies: copies as Record<string, string>,
    ...(settleCopies === undefined ? {} : { settleCopies: settleCopies as Record<string, string> }),
    ...(restored === undefined ? {} : { restored: restored as Record<string, RestoredWrite[]> }),
  });
}

/** A deep copy of `l` with `edit` applied, frozen (an emptied `settleCopies` or `restored` is dropped: one shape with parseLocal). */
function editLocal(l: RegistryLocal, edit: (m: RegistryLocal) => void): RegistryLocal {
  const m = JSON.parse(JSON.stringify(l)) as RegistryLocal;
  edit(m);
  m.explicit = [...new Set(m.explicit)].sort();
  m.keepSyncing = [...new Set(m.keepSyncing)].sort();
  if (m.settleCopies !== undefined && Object.keys(m.settleCopies).length === 0) delete m.settleCopies;
  if (m.restored !== undefined && Object.keys(m.restored).length === 0) delete m.restored;
  return deepFreeze(m);
}

// ---- the registry --------------------------------------------------------------------------------------------------

/** The current registry: its head commit, its records by id, each record's blob oid, local.json and tree caches. */
interface Snapshot {
  head: Oid | null;
  records: Map<string, HoldRecord>;
  recordOids: Map<string, Oid>;
  local: RegistryLocal;
  /** The sorted blob oids blobs/ names, its tree (null: not known yet) and local.json's oid (null: absent). */
  named: readonly string[];
  blobsTree: Oid | null;
  localOid: Oid | null;
}

export class HoldRegistry {
  private readonly d: RegistryDeps;
  private cur: Snapshot | null = null;
  /** Per record: the monoMs from which this run's Δmono is not yet in age_anchor.mono_accum_ms (05-holds §2). */
  private readonly monoFrom = new Map<string, number>();
  /** The tail of the in-process queue: every load and write runs one at a time, so two overlapping calls never race one CAS. */
  private tail: Promise<unknown> = Promise.resolve();
  /** R3-EF4-24: blob oid → it carries a restore-marker row (DAT-46). Blobs never change, so a verdict never goes stale. */
  private readonly markerBlobs = new Map<string, boolean>();

  constructor(d: RegistryDeps) {
    this.d = d;
  }

  /** Runs `fn` after every earlier queued call settled (a failure does not stop the queue). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Re-attach (HLD-01): read the ref; an absent ref is an empty registry. A malformed registry throws. Also reads local.json. */
  load(): Promise<void> {
    return this.serial(() => this.loadNow());
  }

  private async loadNow(): Promise<void> {
    const { repo, ref, clock } = this.d;
    const head = await repo.readRef(ref);
    const records = new Map<string, HoldRecord>();
    const recordOids = new Map<string, Oid>();
    let local = EMPTY_LOCAL;
    let localOid: Oid | null = null;
    let named: string[] = [];
    if (head !== null) {
      const bad = (what: string): Error => new Error(`hold registry ${ref} at ${head}: ${what}`);
      const info = await repo.readCommit(head);
      if (info.subject !== HOLDS_SUBJECT || info.trailers.length !== 0 || info.parents.length > 1) throw bad('not a cowork-holds commit');
      const leaves = await repo.readTreeMap(info.tree);
      const blobNames = new Set<string>();
      for (const [path, e] of leaves) {
        if (e.mode !== '100644') throw bad(`${path} is not a blob`);
        if (path.startsWith(RECORDS) && path.endsWith(RECORD_SUFFIX) && !path.slice(RECORDS.length).includes('/')) {
          recordOids.set(path.slice(RECORDS.length, -RECORD_SUFFIX.length), e.oid);
        } else if (path.startsWith(BLOBS) && path.slice(BLOBS.length) === e.oid) {
          blobNames.add(e.oid);
        } else if (path === LOCAL_JSON) {
          localOid = e.oid;
        } else {
          throw bad(`unexpected entry ${JSON.stringify(path)}`);
        }
      }
      const ids = [...recordOids.keys()];
      const bufs = await repo.readBlobs([...ids.map((id) => recordOids.get(id)!), ...(localOid === null ? [] : [localOid])]);
      ids.forEach((id, i) => {
        const r = storedRecord(bufs[i]!);
        if (r.id !== id) throw bad(`records/${id}.json holds record ${r.id}`);
        records.set(id, r);
      });
      if (localOid !== null) local = parseLocal(bufs[ids.length]!);
      named = namedOids(records.values(), local);
      if (named.length !== blobNames.size || named.some((o) => !blobNames.has(o))) throw bad('blobs/ does not match the blobs the records name');
    }
    this.cur = { head, records, recordOids, local, named, blobsTree: null, localOid };
    this.monoFrom.clear();
    const now = clock.monoMs();
    for (const id of records.keys()) this.monoFrom.set(id, now);
  }

  // ---- queries ----

  /** Every record, newest rev, in id (ULID) order. Records are deeply frozen stored copies (never a caller's object). */
  all(): readonly HoldRecord[] {
    return [...this.snapshot().records.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  nonTerminal(): readonly HoldRecord[] {
    return this.all().filter((r) => !isTerminal(r));
  }

  get(id: string): HoldRecord | undefined {
    return this.snapshot().records.get(id);
  }

  /** Non-terminal records naming `path`, in ULID order. */
  byPath(path: string): readonly HoldRecord[] {
    return this.nonTerminal().filter((r) => r.paths.includes(path));
  }

  /** The marker companions of record `id` (local.json `companions`), any state, in ULID order. */
  companionsOf(id: string): readonly HoldRecord[] {
    const companions = this.snapshot().local.companions;
    return this.all().filter((r) => companions[r.id] === id);
  }

  isCompanion(id: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.snapshot().local.companions, id);
  }

  /** Final review r2 A-2: `id` is a restart's safety copy of an interrupted whole park (local.json `settleCopies`). */
  isSettleCopy(id: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.snapshot().local.settleCopies ?? {}, id);
  }

  /** local.json (R3-13), deeply frozen. */
  local(): Readonly<RegistryLocal> {
    return this.snapshot().local;
  }

  head(): Oid | null {
    return this.snapshot().head;
  }

  /** Non-terminal records that MASK reads (ON_DISK with guards or local_only, CONFLICTED); maskEntries applies the steps. */
  maskingRecords(): readonly HoldRecord[] {
    return this.nonTerminal().filter((r) => (r.residence === 'ON_DISK' && (r.guards.length > 0 || r.local_only)) || r.state === 'CONFLICTED'
      || r.guards.some((g) => guardName(g) === 'claim-breach'));
  }

  /** max(Δwall since anchor_wall_ms, mono_accum_ms + Δmono of this run) (05-holds §2, INV-CLOCK). */
  ageMs(r: HoldRecord): number {
    const { clock } = this.d;
    const now = clock.monoMs();
    const from = this.monoFrom.get(r.id) ?? now;
    return Math.max(Math.floor(clock.wallMs()) - r.age_anchor.anchor_wall_ms, r.age_anchor.mono_accum_ms + Math.max(0, Math.floor(now - from)));
  }

  // ---- births ----

  /** HLD-05 for every Table 3 guard and kind INCOMING; = (await holdOutcome(n)).id. */
  async hold(n: NewRecord): Promise<string> {
    return (await this.holdOutcome(n)).id;
  }

  /**
   * HLD-07: attach to an equal or REBASE-converging record of the same kind and paths (new rev); a stage call on held paths → that record
   * CONFLICTED with stages; R-02 stage dedupe kept; else one commit with a new ULID record. Order: the stage branch (R-02 dedupe, then K4 onto an
   * ON_DISK PATCH/PIN of the same path set), then equal/converging non-terminal records in ULID order (first match wins), then a new record; a
   * guard-less call attaches only by Plan 2's exact dedupe and never when companionOf is set; a restart safety copy (settleCopyOf) never
   * attaches to its parent or to any ON_DISK record (final review r3 A3-1); an ON_DISK call attached to an OFF_DISK record moves
   * it ON_DISK in the same rev (OFF_DISK CONFLICTED → ON_DISK CONFLICTED), its age restarting. Marker companions and records carrying a guard
   * outside Table 3 are never an attach target. Queued behind earlier calls.
   */
  holdOutcome(n: NewRecord): Promise<HoldOutcome> {
    return this.serial(() => this.holdNow(n));
  }

  private async holdNow(n: NewRecord): Promise<HoldOutcome> {
    const snap = this.snapshot();
    const guard = this.checkBirth(snap, n);
    const paths = [...new Set(n.paths)].sort();
    const draft = await this.draftRecord(snap, n, guard, paths, PROBE_ID);
    serializeRecord(draft);   // the birth is a valid record (Table 1, blob maps, the pathless rule) before any attach
    const hit = await this.attachOf(this.nonTerminalSorted(snap), (id) => this.companionIn(snap, id), n, guard, paths);
    if (hit !== null) {
      if (Object.keys(hit.patch).length > 0) await this.writePatches(snap, [{ id: hit.target.id, patch: hit.patch }]);
      return { id: hit.target.id, created: false, attachedGuard: hit.attachedGuard, conflictedExisting: hit.conflictedExisting };
    }

    const id = this.newId(snap);
    const record = await this.draftRecord(snap, n, guard, paths, id);
    const local = n.companionOf === undefined && n.copyOf === undefined && n.settleCopyOf === undefined ? snap.local : editLocal(snap.local, (m) => {
      if (n.companionOf !== undefined) m.companions[id] = n.companionOf;
      if (n.copyOf !== undefined) m.copies[id] = n.copyOf;
      if (n.settleCopyOf !== undefined) m.settleCopies = { ...(m.settleCopies ?? {}), [id]: n.settleCopyOf };
    });
    const [stored] = await this.write(snap, [record], local);
    this.monoFrom.set(id, this.d.clock.monoMs());
    this.emitHold(stored!);
    return { id, created: true, attachedGuard: null, conflictedExisting: false };
  }

  /**
   * HLD-07 (R3-14): the record among `candidates` (non-terminal, ULID order) that holds the same change as birth `n`, with the patch
   * that attaches the birth to it (possibly empty), or null for a new record. Order: the stage branch (R-02 dedupe, then the K4 onto an
   * ON_DISK PATCH/PIN of the same path set), then equal or REBASE-converging records of the same kind and path set (first match wins);
   * a guard-less call matches only Plan 2's exact dedupe and never when companionOf is set. Marker companions and records carrying a
   * guard outside Table 3 are never targets. A restart safety copy (settleCopyOf, final review r3 A3-1, Ruling R3-FF3-A1) never attaches
   * to the record whose park it settles nor to any ON_DISK record — that record still holds the bytes on a disk the park may have
   * changed, which is what the copy guards against — so a repeat of the settlement attaches only to an OFF_DISK record (the copy made the
   * first time). A conflict call (a stage record, or state CONFLICTED) makes its target CONFLICTED, with the call's stages — never on a
   * target carrying `markers` (a TypeError, refuseMarkersRefresh: the K4 branch and the converging conflict branch; EF4 E4-1); an ON_DISK
   * call moves an OFF_DISK target ON_DISK (its age restarting, nextRev); cs_ids become the union. A candidate whose REBASE is an operator
   * error (HoldOperatorError) is skipped.
   * G2 #8 (HLD-64, ruling R3-EF4-30): the K4 branch is a K4 on this peer's disk — an ON_DISK stage call (the apply's or the publish's
   * TAKE_TIP, R-02) — never an OFF_DISK birth: HLD-64's copy (copyOf) of a departed peer's K4 record took this peer's own ON_DISK record over
   * the same path set, its pair replaced by the foreign stages. A copy attaches to an ON_DISK record only as the same change (equal or
   * converging), and then as the copy's RESTORE would leave it: no stages, no CONFLICTED, no displacement guard (`conflict`,
   * `claim-breach`, `base-move`, which RESTORE releases, HLD-17) — only its other guard and its cs_ids; the R-02 dedupe never takes a copy
   * onto an ON_DISK record.
   */
  private async attachOf(
    candidates: readonly HoldRecord[], isCompanion: (id: string) => boolean, n: NewRecord, guard: Guard | null, paths: readonly string[],
  ): Promise<Attach | null> {
    const held = heldOf(n.blobs);
    const settle = n.settleCopyOf;
    const copy = n.copyOf !== undefined;
    const targets = candidates.filter((r) => samePaths(r.paths, paths) && !isCompanion(r.id) && unknownGuards(r).length === 0
      && (settle === undefined || (r.id !== settle && r.residence !== 'ON_DISK')));
    const same = targets.filter((r) => r.kind === n.kind);
    const csOf = (r: HoldRecord): HoldPatch => {
      const union = [...new Set([...r.cs_ids, ...n.cs_ids])].sort();
      return n.cs_ids.every((c) => r.cs_ids.includes(c)) ? {} : { cs_ids: union };
    };
    if (guard === null) {
      if (n.companionOf !== undefined) return null;
      const twin = same.find((r) => r.guards.length === 0 && sameMap(heldSide(r), held) && ('h1' in r.blobs) === ('h1' in n.blobs));
      return twin === undefined ? null : { target: twin, patch: csOf(twin), attachedGuard: null, conflictedExisting: false };
    }
    const adds = (r: HoldRecord): boolean => !r.guards.some((g) => g.name === guard.name);
    const guardOf = (r: HoldRecord): HoldPatch => (adds(r) ? { guards: [...r.guards, guard] } : {});
    if ('s2' in n.blobs) {
      const stages = n.blobs;
      // R-02: same kind, paths and s2 on a stage record carrying the call's guard: its s1/s3 follow the newer call; an ON_DISK
      // call moves an OFF_DISK target ON_DISK in the same rev (its age restarting), so it masks during the caller's write window.
      const dedupe = same.find((r) => (!copy || r.residence !== 'ON_DISK') && 's2' in r.blobs && r.guards.some((g) => g.name === guard.name) && sameMap(r.blobs.s2, stages.s2));
      if (dedupe !== undefined) {
        const patch: HoldPatch = { ...(sameBlobs(dedupe.blobs, stages) ? {} : { blobs: stages }), ...csOf(dedupe) };
        if (n.residence === 'ON_DISK' && dedupe.residence !== 'ON_DISK') {
          // Table 1 has no ON_DISK PARKED: a parked stage record moved back ON_DISK is CONFLICTED (the round-1 K4 rule; Task 5).
          patch.residence = 'ON_DISK';
          if (dedupe.state !== 'CONFLICTED') patch.state = 'CONFLICTED';
        }
        return { target: dedupe, patch, attachedGuard: null, conflictedExisting: patch.state === 'CONFLICTED' };
      }
      // HLD-07 / 05 P6: a K4 on a path set an ON_DISK PATCH or PIN already holds transitions that record — a K4 on this disk only (an
      // ON_DISK stage call; G2 #8: never an OFF_DISK birth such as HLD-64's copy).
      const held4 = n.residence === 'ON_DISK' ? targets.find((r) => r.residence === 'ON_DISK' && (r.kind === 'PATCH' || r.kind === 'PIN')) : undefined;
      if (held4 !== undefined) {
        refuseMarkersRefresh(held4, stages);
        return {
          target: held4, patch: { state: 'CONFLICTED', blobs: stages, ...guardOf(held4), ...csOf(held4) },
          attachedGuard: adds(held4) ? guard.name : null, conflictedExisting: true,
        };
      }
    }
    const conflictCall = 's2' in n.blobs || n.state === 'CONFLICTED';
    // The birth's own original pair (base and held side on every path) is r's change at every A: the same REBASE, decided without git
    // (HLD-02: content hashes may dedupe). Any other birth is compared with r's CURRENT H1' (converges; final review r2 D-1: an h1
    // equal to r's stored side over another base is another change once an apply has moved A under r).
    const base = baseOf(n.blobs);
    for (const r of same) {
      if (!(await this.holdsChange(r, base, held))) continue;
      if (copy && r.residence === 'ON_DISK') {
        // G2 #8: the copy's change is r's, already on this disk (HLD-64, R3-EF4-30): what its RESTORE would leave, nothing more.
        const adding = !RESTORE_RELEASES.has(guardName(guard)) && adds(r);
        return { target: r, patch: { ...(adding ? { guards: [...r.guards, guard] } : {}), ...csOf(r) }, attachedGuard: adding ? guard.name : null, conflictedExisting: false };
      }
      const patch: HoldPatch = { ...guardOf(r), ...csOf(r) };
      const residence = n.residence === 'ON_DISK' ? 'ON_DISK' : r.residence;
      if (residence !== r.residence) patch.residence = residence;
      if (conflictCall) {
        // The conflict lands on the existing record: CONFLICTED with the call's stages (a K4 whose target is OFF_DISK; R-02's
        // follow-up after the TIP write is then ON_DISK CONFLICTED → OFF_DISK CONFLICTED).
        if (r.state !== 'CONFLICTED') patch.state = 'CONFLICTED';
        if ('s2' in n.blobs) refuseMarkersRefresh(r, n.blobs);
        if ('s2' in n.blobs && !sameBlobs(r.blobs, n.blobs)) patch.blobs = n.blobs;
        return { target: r, patch, attachedGuard: adds(r) ? guard.name : null, conflictedExisting: true };
      }
      if (residence !== r.residence) patch.state = r.state === 'CONFLICTED' ? 'CONFLICTED' : 'ACTIVE';
      return { target: r, patch, attachedGuard: adds(r) ? guard.name : null, conflictedExisting: false };
    }
    return null;
  }

  /**
   * HLD-07's identity test, the one code path attachOf and holdersOf share: record r (of the caller's kind and path set) holds the
   * change whose original pair is (base, held). The pair's own sides equal r's (the same REBASE at every A, decided without git; HLD-02),
   * or r's CURRENT H1' at A is `held` (rebase.converges; final review r2 D-1: an h1 equal to r's stored side over another base is another
   * change once an apply has moved A under r). A REBASE conflict at A leaves r no H1', so nothing converges to it; a candidate whose
   * REBASE is an operator error (HoldOperatorError) is no match, never a failure.
   */
  private async holdsChange(r: HoldRecord, base: BlobMap, held: BlobMap): Promise<boolean> {
    try {
      return (sameMap(baseOf(r.blobs), base) && sameMap(heldSide(r), held)) || await this.d.rebase.converges(r, this.d.A(), held);
    } catch (e) {
      if (e instanceof HoldOperatorError) return false;   // this candidate's REBASE cannot be computed: not a match, never a failed birth
      throw e;
    }
  }

  /**
   * F2 #151 (HLD-07 "one change MUST have one id", INV-HLD-SINGLE): the non-terminal records other than `except`, in ULID order, that
   * hold the change of the pair `blobs` over `kind` and path set `paths` — the records a rev giving `except` that pair would make a
   * second id of (holdsChange, attachOf's identity test). Left out: marker companions (never the same change: their held side is the
   * displaced marker file) and `except`'s restart safety copy or parent (local.json settleCopies, either direction: the deliberate
   * duplicate O-LIVE-RECORD exempts). Records carrying a guard outside Table 3 are included: a caller that would end or merge one
   * refuses instead (HLD-05). A read: nothing is written.
   */
  async holdersOf(except: string, kind: HoldKind, paths: readonly string[], blobs: HoldBlobs): Promise<HoldRecord[]> {
    const snap = this.snapshot();
    const set = [...new Set(paths)].sort();
    const settle = snap.local.settleCopies ?? {};
    const base = baseOf(blobs);
    const held = heldOf(blobs);
    const out: HoldRecord[] = [];
    for (const r of this.nonTerminalSorted(snap)) {
      if (r.id === except || r.kind !== kind || !samePaths(r.paths, set) || this.companionIn(snap, r.id)) continue;
      if (settle[r.id] === except || settle[except] === r.id) continue;
      if (await this.holdsChange(r, base, held)) out.push(r);
    }
    return out;
  }

  /** R3-10 and the 05 §2 grammar: the birth's guard (null for a guard-less birth); TypeError on anything else. */
  private checkBirth(snap: Snapshot, n: NewRecord): Guard | null {
    if (!KINDS.has(n.kind)) throw new TypeError(`hold: kind ${String(n.kind)} is not PATCH, PIN or INCOMING`);
    const guard = n.guard === null ? null : makeGuard(n.guard);
    if (guard === null && !(n.residence === 'OFF_DISK' && n.state === 'PARKED')) {
      throw new TypeError(`hold: a guard-less birth is OFF_DISK PARKED only (R3-10), not ${String(n.residence)} ${String(n.state)}`);
    }
    if (n.kind === 'INCOMING' && !(n.residence === 'ON_DISK' && n.state === 'ACTIVE')) throw new TypeError('hold: an INCOMING record is born ON_DISK ACTIVE');
    if (n.companionOf !== undefined && !snap.records.has(n.companionOf)) throw new TypeError(`hold: companionOf ${JSON.stringify(n.companionOf)} is not a record`);
    if (n.settleCopyOf !== undefined && !snap.records.has(n.settleCopyOf)) throw new TypeError(`hold: settleCopyOf ${JSON.stringify(n.settleCopyOf)} is not a record`);
    return guard;
  }

  /** The rev-1 record of a birth (local_only recomputed, R3-12, R3-EF4-24). */
  private async draftRecord(snap: Snapshot, n: NewRecord, guard: Guard | null, paths: string[], id: string): Promise<HoldRecord> {
    const { clock, peer } = this.d;
    const r: HoldRecord = {
      id, rev: 1, owner: peer,
      kind: n.kind, residence: n.residence, state: n.state, offer: n.offer ?? 'none',
      declines: 0, displaced_by: n.displaced_by,
      paths, blobs: n.blobs, guards: guard === null ? [] : [guard],
      origin: n.origin, cs_ids: [...n.cs_ids], peer_authors: [...(n.peer_authors ?? [])], local_only: false,
      age_anchor: { since_rev: 1, anchor_wall_ms: Math.floor(clock.wallMs()), mono_accum_ms: 0 }, proto: 1,
    };
    return { ...r, local_only: await this.localOnlyOf(snap, r, n.companionOf !== undefined) };
  }

  private newId(snap: Snapshot, taken: ReadonlySet<string> = new Set()): string {
    const id = ulid(this.d.random, this.d.clock);
    if (snap.records.has(id) || taken.has(id)) throw new Error(`hold: ULID ${id} is already a record id`);
    return id;
  }

  // ---- transitions ----

  /** One rev, one commit; a terminal state sets residence null; local_only recomputed; refuses a terminal record and, on a record carrying a guard outside Table 3, any state, residence, guards or offer patch (HLD-05). */
  transition(id: string, patch: HoldPatch): Promise<HoldRecord> {
    return this.serial(async () => {
      const snap = this.snapshot();
      this.checkPatch(this.existing(snap, id, 'transition'), patch, 'transition');
      const [stored] = await this.writePatches(snap, [{ id, patch }]);
      return stored!;
    });
  }

  /**
   * transition()'s refusals of a caller's patch (also every commitMany patch): a record carrying a guard outside Table 3 takes no state,
   * residence, guards or offer patch (HLD-05); every patched guard is a Table 3 guard (05 §2 grammar) with its fixed class and owner, so
   * no patch can give a record a guard that would freeze it. Table 1 and the schema are checked when the next rev is serialized.
   */
  private checkPatch(prev: HoldRecord, patch: HoldPatch, what: string): void {
    for (const k of Object.keys(patch)) if (!PATCH_KEYS.has(k)) throw new TypeError(`${what}: ${k} is not a patchable field`);
    const unknown = unknownGuards(prev);
    if (unknown.length > 0 && GUARDED_PATCH_KEYS.some((k) => Object.prototype.hasOwnProperty.call(patch, k))) {
      throw new TypeError(`${what}: hold record ${prev.id} carries ${unknown.map((g) => g.name).join(', ')}, a guard this daemon never releases or transitions (HLD-05)`);
    }
    if (patch.guards !== undefined) {
      if (!Array.isArray(patch.guards)) throw new TypeError(`${what}: guards is not an array`);
      for (const g of patch.guards) {
        const want = makeGuard(g.name);
        if (want.class !== g.class || want.owner !== g.owner) throw new TypeError(`${what}: guard ${g.name} must be ${want.class}/${want.owner} (Table 3)`);
      }
    }
  }

  /**
   * Several creations and transitions in ONE registry commit (markers park, park-all, R1 batches); `local` edits local.json in the same commit.
   * Creations are births under the R3-10 rules; a creation that is the change of a non-terminal record as this batch's patches leave it
   * (or of an earlier creation of the same batch) by HLD-07's attach decision is refused (one change, one id: the caller uses hold(), which
   * attaches). Patches follow transition()'s rules (checkPatch). Any refused entry writes nothing. records = the stored creations, then the
   * patched records, in call order.
   */
  commitMany(
    creates: readonly NewRecord[], patches: ReadonlyArray<{ id: string; patch: HoldPatch }>,
    local?: {
      setInflight?: Readonly<Record<string, InflightOp>>; clearInflight?: readonly string[]; explicit?: readonly string[]; clearCopies?: readonly string[];
      clearSettleCopies?: readonly string[];   // final review r2 A-2: the settleCopies entries that end (the copy restored or ended)
      setRestored?: Readonly<Record<string, readonly RestoredWrite[]>>;   // E16-E: a restore's writes a restart re-seeds (RegistryLocal.restored)
    },
  ): Promise<{ created: string[]; records: HoldRecord[] }> {
    return this.serial(async () => {
      const snap = this.snapshot();
      const ids = new Set<string>();
      for (const { id, patch } of patches) {
        if (ids.has(id)) throw new TypeError(`commitMany: ${id} is patched twice`);
        ids.add(id);
        this.checkPatch(this.existing(snap, id, 'commitMany'), patch, 'commitMany');
      }
      // R3-EF4-24: every held side this batch writes, learned in one read before any rev is drafted.
      await this.learnMarkers([
        ...patches.map(({ id, patch }) => heldMap(patch.blobs ?? this.existing(snap, id, 'commitMany').blobs)),
        ...creates.map((n) => heldMap(n.blobs)),
      ]);
      // HLD-07 compares each creation with the records as this batch's own patches leave them (a record the batch ends is no
      // candidate; a record whose held side the batch replaces is compared by its new one), plus the batch's earlier creations.
      const next: Array<{ record: HoldRecord; monoFrom: number }> = [];
      for (const { id, patch } of patches) next.push(await this.nextRev(snap, this.existing(snap, id, 'commitMany'), patch));
      const patched = new Map(next.map((x) => [x.record.id, x.record] as const));
      const after = this.nonTerminalSorted(snap).map((r) => patched.get(r.id) ?? r).filter((r) => !isTerminal(r));
      const taken = new Set<string>();
      const born: HoldRecord[] = [];
      const companions: Array<[string, string]> = [];
      const byId = (a: HoldRecord, b: HoldRecord): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      for (const [i, n] of creates.entries()) {
        if (n.settleCopyOf !== undefined) throw new TypeError(`commitMany: creation ${i} is a settle copy, born through holdOutcome (its repeat attaches, HLD-07)`);
        const guard = this.checkBirth(snap, n);
        const paths = [...new Set(n.paths)].sort();
        serializeRecord(await this.draftRecord(snap, n, guard, paths, PROBE_ID));
        const candidates = [...after, ...born].sort(byId);
        const hit = await this.attachOf(candidates, (x) => this.companionIn(snap, x) || companions.some(([c]) => c === x), n, guard, paths);
        if (hit !== null) {
          throw new TypeError(`commitMany: creation ${i} is the change of hold record ${hit.target.id} (HLD-07 one change, one id): use hold(), which attaches`);
        }
        const id = this.newId(snap, taken);
        taken.add(id);
        born.push(await this.draftRecord(snap, n, guard, paths, id));
        if (n.companionOf !== undefined) companions.push([id, n.companionOf]);
      }
      if (local !== undefined) {
        for (const [id, op] of Object.entries(local.setInflight ?? {})) {
          if (!snap.records.has(id) && !taken.has(id)) throw new TypeError(`commitMany: inflight names unknown record ${id}`);
          checkInflight(id, JSON.parse(JSON.stringify(op)));
        }
        for (const id of local.explicit ?? []) if (!snap.records.has(id)) throw new TypeError(`commitMany: explicit names unknown record ${id}`);
        for (const id of Object.keys(local.setRestored ?? {})) if (!snap.records.has(id)) throw new TypeError(`commitMany: restored names unknown record ${id}`);
      }
      const nextLocal = companions.length === 0 && local === undefined ? snap.local : editLocal(snap.local, (m) => {
        for (const [c, p] of companions) m.companions[c] = p;
        for (const [id, op] of Object.entries(local?.setInflight ?? {})) m.inflight[id] = JSON.parse(JSON.stringify(op)) as InflightOp;
        for (const id of local?.clearInflight ?? []) delete m.inflight[id];
        for (const id of local?.clearCopies ?? []) delete m.copies[id];
        for (const id of local?.clearSettleCopies ?? []) if (m.settleCopies !== undefined) delete m.settleCopies[id];
        for (const [id, ws] of Object.entries(local?.setRestored ?? {})) {
          if (ws.length === 0) {
            if (m.restored !== undefined) delete m.restored[id];
            continue;
          }
          // Ruling R3-EF4-30: one entry per path, the newest write wins (as ObservedWrites.record keeps p's last write). The restart
          // re-seeds in record-id order and every entry of p carries the same snap (no snap transition, HLD-57 (e)), so an older
          // entry left beside this one would be re-seeded instead of the bytes on disk. Each path this list names leaves every other
          // id's list, and an id whose list empties leaves the map (parseLocal requires a non-empty list).
          const named = new Set(ws.map((w) => w.path));
          for (const [other, ows] of Object.entries(m.restored ?? {})) {
            if (other === id) continue;
            const kept = ows.filter((w) => !named.has(w.path));
            if (kept.length === ows.length) continue;
            if (kept.length === 0) delete m.restored![other];
            else m.restored![other] = kept;
          }
          m.restored = { ...(m.restored ?? {}), [id]: ws.map((w) => ({ path: w.path, written: w.written, snap: w.snap })) };
        }
        m.explicit.push(...(local?.explicit ?? []));
      });
      const stored = await this.write(snap, [...born, ...next.map((x) => x.record)], nextLocal);
      const now = this.d.clock.monoMs();
      for (const r of born) this.monoFrom.set(r.id, now);
      for (const x of next) this.monoFrom.set(x.record.id, x.monoFrom);
      for (const r of stored) this.emitHold(r);
      return { created: born.map((r) => r.id), records: stored };
    });
  }

  /** Adds a Table 3 guard (05 §2 grammar) in one rev; a guard the record already carries is no change (no commit). Unknown guards it carries stay. */
  addGuard(id: string, full: string): Promise<HoldRecord> {
    return this.serial(async () => {
      const g = makeGuard(full);
      const snap = this.snapshot();
      const prev = this.existing(snap, id, 'addGuard');
      if (prev.guards.some((x) => x.name === g.name)) return prev;
      const [stored] = await this.writePatches(snap, [{ id, patch: { guards: [...prev.guards, g] } }]);
      return stored!;
    });
  }

  /** Releases one (record, guard) pair (HLD-07 AND); a guard outside Table 3, or one the record does not carry, refuses (TypeError). */
  releaseGuard(id: string, full: string): Promise<HoldRecord> {
    return this.serial(async () => {
      if (guardRow(full) === null) throw new TypeError(`releaseGuard: ${JSON.stringify(full)} is not a Table 3 guard; this daemon never releases it (HLD-05)`);
      const snap = this.snapshot();
      const prev = this.existing(snap, id, 'releaseGuard');
      const at = prev.guards.findIndex((g) => g.name === full);
      if (at < 0) throw new TypeError(`releaseGuard: hold record ${id} does not carry ${full}`);
      const [stored] = await this.writePatches(snap, [{ id, patch: { guards: prev.guards.filter((_, i) => i !== at) } }]);
      return stored!;
    });
  }

  /** HLD-09 through offerNext; null on an illegal event (nothing written); 'declined' also increments declines. */
  offerEvent(id: string, ev: OfferEvent): Promise<HoldRecord | null> {
    return this.serial(async () => {
      const snap = this.snapshot();
      const prev = this.existing(snap, id, 'offerEvent');
      const unknown = unknownGuards(prev);
      if (unknown.length > 0) throw new TypeError(`offerEvent: hold record ${id} carries ${unknown.map((g) => g.name).join(', ')} (HLD-05)`);
      const offer = offerNext(prev, ev);
      if (offer === null) return null;
      const [stored] = await this.writePatches(snap, [{ id, patch: { offer, ...(ev === 'declined' ? { declines: prev.declines + 1 } : {}) } }]);
      return stored!;
    });
  }

  /**
   * 05 §2: one commit re-persisting every non-terminal record's accumulated Δmono (clean exit); no op. The count written. Its revs
   * recompute local_only (R3-12) like any rev: a rev whose local_only flips emits its hold trace event, the others none.
   * `carryLocalOnly` (ruling R3-FF2-C1): the caller has no scope input at all (an Engine with no state: a lost or too-new state, so no
   * EPOCH_BASE to classify at), and these revs carry each record's local_only unchanged instead of failing every record closed.
   */
  flushAgeAnchors(o: { carryLocalOnly?: boolean } = {}): Promise<number> {
    return this.serial(async () => {
      const snap = this.snapshot();
      const now = this.d.clock.monoMs();
      const next: HoldRecord[] = [];
      const flipped = new Set<string>();
      const due = this.nonTerminalSorted(snap).filter((r) => Math.max(0, Math.floor(now - (this.monoFrom.get(r.id) ?? now))) > 0);
      if (o.carryLocalOnly !== true) await this.learnMarkers(due.map((r) => heldMap(r.blobs)));   // R3-EF4-24: one read for every rev
      for (const r of due) {
        const elapsed = Math.max(0, Math.floor(now - (this.monoFrom.get(r.id) ?? now)));
        const moved: HoldRecord = { ...r, rev: r.rev + 1, age_anchor: { ...r.age_anchor, mono_accum_ms: r.age_anchor.mono_accum_ms + elapsed } };
        const localOnly = o.carryLocalOnly === true ? r.local_only : await this.localOnlyOf(snap, moved, this.companionIn(snap, r.id));
        if (localOnly !== r.local_only) flipped.add(r.id);
        next.push({ ...moved, local_only: localOnly });
      }
      if (next.length === 0) return 0;
      const stored = await this.write(snap, next, snap.local);
      for (const r of next) this.monoFrom.set(r.id, now);
      for (const r of stored) if (flipped.has(r.id)) this.emitHold(r);
      return next.length;
    });
  }

  // ---- local.json ----

  markExplicit(id: string): Promise<void> {
    return this.editLocalNow('markExplicit', id, (m) => { if (!m.explicit.includes(id)) m.explicit.push(id); });
  }

  markMirrorRejected(id: string, key: string, reason: MirrorRejectReason): Promise<void> {
    if (typeof key !== 'string' || key.length === 0) return Promise.reject(new TypeError('markMirrorRejected: empty key'));
    if (!REJECT_REASONS.has(reason)) return Promise.reject(new TypeError(`markMirrorRejected: ${String(reason)} is not a rejection reason`));
    return this.editLocalNow('markMirrorRejected', id, (m) => { m.rejected[id] = { key, reason }; });
  }

  clearMirrorRejected(id: string): Promise<void> {
    return this.editLocalNow('clearMirrorRejected', id, (m) => { delete m.rejected[id]; });
  }

  /**
   * DAT-39's "keep syncing" answer (Task 11, contract addition 1): the record's paths join local.keepSyncing (sorted, unique) in one
   * registry commit (none when every path is there already), so churnStep never asks again for them. The record must carry
   * `generated?` or `generated?:exclude` (a TypeError otherwise); a terminal record is accepted (the answer outlives it).
   */
  markKeepSyncing(id: string): Promise<void> {
    return this.editLocalNow('markKeepSyncing', id, (m) => {
      const r = this.snapshot().records.get(id)!;
      if (!r.guards.some((g) => guardName(g) === 'generated?')) throw new TypeError(`markKeepSyncing: hold record ${id} carries no generated? guard`);
      m.keepSyncing.push(...r.paths);
    });
  }

  /** One registry commit changing only local.json (none when nothing changes). */
  private editLocalNow(what: string, id: string, edit: (m: RegistryLocal) => void): Promise<void> {
    return this.serial(async () => {
      const snap = this.snapshot();
      this.existing(snap, id, what, true);
      const next = editLocal(snap.local, edit);
      if (localBytes(next).equals(localBytes(snap.local))) return;
      await this.write(snap, [], next);
    });
  }

  // ---- internals ----

  private snapshot(): Snapshot {
    if (this.cur === null) throw new Error('HoldRegistry: load() first (HLD-01 re-attach)');
    return this.cur;
  }

  private existing(snap: Snapshot, id: string, what: string, terminalOk = false): HoldRecord {
    const prev = snap.records.get(id);
    if (prev === undefined) throw new TypeError(`${what}: unknown hold record ${JSON.stringify(id)}`);
    if (!terminalOk && isTerminal(prev)) throw new TypeError(`${what}: hold record ${id} is terminal (${prev.state})`);
    return prev;
  }

  private nonTerminalSorted(snap: Snapshot): HoldRecord[] {
    return [...snap.records.values()].filter((r) => !isTerminal(r)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  private companionIn(snap: Snapshot, id: string): boolean {
    return Object.prototype.hasOwnProperty.call(snap.local.companions, id);
  }

  /**
   * HLD-03 / R3-12 at this rev: the record's local_only from the current scope; another record's LOCAL_ONLY effect counts as not LIVE.
   * R3-71: a scope that cannot be had (scopeOf() throws) or cannot classify a path makes the record local_only (never fails open).
   * R3-EF4-24 (DAT-46 defence in depth): a held side (h1, or s2 of a stage record) carrying a restore-marker row makes it local_only
   * too, so its bytes never reach held/ (the content-free stub); the birth is never refused for it.
   */
  private async localOnlyOf(snap: Snapshot, r: HoldRecord, companion: boolean): Promise<boolean> {
    // An INCOMING record (ON_DISK by schema, holding TIP's bytes) never makes a path LOCAL_ONLY (core.ts localOnlyScope, Task 6).
    const others = [...snap.records.values()].filter((x) => x.id !== r.id && !isTerminal(x) && x.residence === 'ON_DISK' && x.local_only && x.kind !== 'INCOMING');
    const otherLocalOnly = (p: string): boolean => others.some((x) => x.paths.includes(p));
    let scope: (path: string) => ScopeClass;
    try {
      scope = this.d.scopeOf();
    } catch (e) {
      scope = () => {
        throw e;
      };
    }
    if (localOnlyCauses(r, scope, companion, otherLocalOnly).length > 0) return true;
    const held = heldMap(r.blobs);
    await this.learnMarkers([held]);
    return sideOids(held).some((o) => this.markerBlobs.get(o) !== false);
  }

  /**
   * R3-EF4-24: learns whether each blob of `sides` not known yet carries a restore-marker row (DAT-46: hasRestoreMarkerRow, LF or
   * CRLF, row 1's BOM ignored, no binary gate), in one cat-file --batch; no git call when every blob is known. A blob that cannot be
   * read stays unknown, which localOnlyOf reads as carrying one (local_only never fails open, R3-71's rule) — not remembered, so a
   * later rev reads it again.
   */
  private async learnMarkers(sides: Iterable<BlobMap | undefined>): Promise<void> {
    const want = new Set<string>();
    for (const m of sides) for (const o of sideOids(m)) if (!this.markerBlobs.has(o)) want.add(o);
    if (want.size === 0) return;
    const oids = [...want] as Oid[];
    let bufs: Buffer[];
    try {
      bufs = await this.d.repo.readBlobs(oids);
    } catch (e) {
      if (!unreadableBlob(e)) throw e;
      return;
    }
    oids.forEach((o, i) => this.markerBlobs.set(o, hasRestoreMarkerRow(bufs[i]!)));
  }

  /** The next rev of a non-terminal record under `patch` (validated by the write): residence null for a terminal state, the age anchor, local_only. */
  private async nextRev(snap: Snapshot, prev: HoldRecord, patch: HoldPatch): Promise<{ record: HoldRecord; monoFrom: number }> {
    for (const k of Object.keys(patch)) if (!PATCH_KEYS.has(k)) throw new TypeError(`transition: ${k} is not a patchable field`);
    if (isTerminal(prev)) throw new TypeError(`transition: hold record ${prev.id} is terminal (${prev.state})`);
    const { clock } = this.d;
    const rev = prev.rev + 1;
    const now = clock.monoMs();
    const from = this.monoFrom.get(prev.id) ?? now;
    const elapsed = Math.max(0, Math.floor(now - from));
    const state = patch.state ?? prev.state;
    // A terminal state carries no residence (glossary §9): the registry sets it null whatever the patch says.
    const residence = TERMINAL_STATES.has(state) ? null : (patch.residence !== undefined ? patch.residence : prev.residence);
    // The age restarts when the record (re)becomes ON_DISK; otherwise this run's Δmono is re-persisted (05-holds §2).
    const ageStarts = residence === 'ON_DISK' && prev.residence !== 'ON_DISK';
    const moved: HoldRecord = {
      ...prev,
      ...(patch.blobs !== undefined ? { blobs: patch.blobs } : {}),
      ...(patch.guards !== undefined ? { guards: patch.guards.map((g) => ({ ...g })) } : {}),
      ...(patch.offer !== undefined ? { offer: patch.offer } : {}),
      ...(patch.declines !== undefined ? { declines: patch.declines } : {}),
      ...(patch.displaced_by !== undefined ? { displaced_by: patch.displaced_by } : {}),
      ...(patch.paths !== undefined ? { paths: [...new Set(patch.paths)].sort() } : {}),
      ...(patch.cs_ids !== undefined ? { cs_ids: [...patch.cs_ids] } : {}),
      ...(patch.peer_authors !== undefined ? { peer_authors: [...patch.peer_authors] } : {}),
      state, residence, rev,
      age_anchor: ageStarts
        ? { since_rev: rev, anchor_wall_ms: Math.floor(clock.wallMs()), mono_accum_ms: 0 }
        : { ...prev.age_anchor, mono_accum_ms: prev.age_anchor.mono_accum_ms + elapsed },
    };
    const record = { ...moved, local_only: await this.localOnlyOf(snap, moved, this.companionIn(snap, prev.id)) };
    return { record, monoFrom: ageStarts ? now : from + elapsed };
  }

  /** New revs of existing records in one commit, their trace events after the CAS. */
  private async writePatches(snap: Snapshot, patches: ReadonlyArray<{ id: string; patch: HoldPatch }>): Promise<HoldRecord[]> {
    const prevs = patches.map(({ id, patch }) => ({ prev: this.existing(snap, id, 'transition'), patch }));
    await this.learnMarkers(prevs.map(({ prev, patch }) => heldMap(patch.blobs ?? prev.blobs)));   // R3-EF4-24: one read
    const next: Array<{ record: HoldRecord; monoFrom: number }> = [];
    for (const { prev, patch } of prevs) next.push(await this.nextRev(snap, prev, patch));
    const stored = await this.write(snap, next.map((x) => x.record), snap.local);
    for (const x of next) this.monoFrom.set(x.record.id, x.monoFrom);
    for (const r of stored) this.emitHold(r);
    return stored;
  }

  private emitHold(r: HoldRecord): void {
    this.d.trace.emit({
      kind: 'hold', peer: this.d.peer, id: r.id, holdKind: r.kind, guard: r.guards[0]?.name ?? '', guards: r.guards.map((g) => g.name),
      paths: [...r.paths], residence: r.residence, state: r.state, rev: r.rev, localOnly: r.local_only,
    });
  }

  /**
   * One registry commit holding every record with `records` replacing their ids' entries and local.json = `local`; memory changes only after the
   * CAS. Every record is validated (serializeRecord) and every newly named oid checked to be a blob before any object is written. Memory keeps the
   * records parsed back from their canonical bytes, deeply frozen (returned), never the caller's objects.
   */
  private async write(snap: Snapshot, records: readonly HoldRecord[], local0: RegistryLocal): Promise<HoldRecord[]> {
    const { repo, ref, log } = this.d;
    const bufs = records.map((r) => serializeRecord(r));   // validates before any object is written
    const stored = bufs.map((b) => storedRecord(b));
    const local = pruneRestored(local0, stored);   // E16-E: a record off the disk or ended keeps no restore write to re-seed
    const known = new Set(snap.named);
    const fresh = [...new Set([...stored.flatMap(blobOids), ...inflightOids(local)])].filter((o) => !known.has(o));
    if (fresh.length > 0) {
      const r = await repo.run(['cat-file', '--batch-check'], { stdin: Buffer.from(`${fresh.join('\n')}\n`, 'utf8') });
      const lines = r.stdout.toString('utf8').split('\n');
      fresh.forEach((o, i) => {
        const parts = (lines[i] ?? '').split(' ');
        if (parts.length !== 3 || parts[0] !== o || parts[1] !== 'blob') throw new Error(`hold record: ${o} is not a blob in the object store`);
      });
    }

    const all = new Map(snap.records);
    const recordOids = new Map(snap.recordOids);
    for (const [i, s] of stored.entries()) {
      all.set(s.id, s);
      recordOids.set(s.id, await repo.hashBytes(bufs[i]!, true));
    }
    const named = namedOids(all.values(), local);
    const blobsTree = snap.blobsTree !== null && samePaths(named, snap.named)
      ? snap.blobsTree
      : await repo.mktree(named.map((o): MktreeEntry => ({ name: o, mode: '100644', type: 'blob', oid: parseOid(o) })));
    const recordsTree = await repo.mktree([...recordOids.keys()].sort().map((id): MktreeEntry => (
      { name: `${id}${RECORD_SUFFIX}`, mode: '100644', type: 'blob', oid: recordOids.get(id)! }
    )));
    let localOid: Oid | null = null;
    if (!localIsEmpty(local)) {
      const bytes = localBytes(local);
      localOid = snap.localOid !== null && bytes.equals(localBytes(snap.local)) ? snap.localOid : await repo.hashBytes(bytes, true);
    }
    const root = await repo.mktree([
      { name: 'blobs', mode: '040000', type: 'tree', oid: blobsTree },
      ...(localOid === null ? [] : [{ name: LOCAL_JSON, mode: '100644', type: 'blob', oid: localOid } as MktreeEntry]),
      { name: 'records', mode: '040000', type: 'tree', oid: recordsTree },
    ]);
    const commit = await repo.commitTree({ tree: root, parents: snap.head === null ? [] : [snap.head], subject: HOLDS_SUBJECT, trailers: [] });

    crashpoint('registry.cas');
    const ok = await repo.casRef(ref, commit, snap.head, HOLDS_SUBJECT);
    if (!ok) {
      log.write('security', CAS_LOST_CODE, { ref, expected: snap.head, commit });
      throw new RegistryCasLostError(`${ref} is no longer at ${snap.head ?? '(absent)'}: a second writer`);
    }
    crashpoint('registry.cas');
    this.cur = { head: commit, records: all, recordOids, local, named, blobsTree, localOid };
    return stored;
  }
}
