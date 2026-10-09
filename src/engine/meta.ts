// meta.json of the state commit (01-engine §3.2; ENG-05; LIF-37 meta_v): the 01-engine §3.2 fields plus the
// Plan 2 additions flagged for that section (ruling R-14: outbox, fold_board, cs_human_next, incident_next;
// controller ruling P2-FOLDPERSIST: fold_verified, checkpoint_mismatch). No wall-clock or monotonic timestamp:
// every timer restarts at daemon start (INV-CLOCK).
//
// The bytes are RFC 8785 canonical JSON. parseMeta accepts exactly what serializeMeta writes: v first (a newer
// meta_v refuses the branch whatever else it holds), then the exact key set, every field's type, and the
// canonical byte form; serializeMeta validates by the same parser, so an invalid Meta never reaches git.
import { canonicalBytes, type Json } from '../board/canonicalJson.js';
import type { EpochId, PeerId } from '../board/ids.js';
import type { ThrottleSignal } from '../board/governor.js';
import { enc } from '../git/enc.js';
import { isOid, type Oid } from '../git/oid.js';
import type { DeferReason } from '../holds/groups.js';
import { validId, validPathSyntax } from '../sec/validators.js';

export type FreezeReason = 'EPOCH' | 'MASS' | 'PAUSED' | 'INCIDENT' | 'CONFIG' | 'NOHOOKS';
export type ConfigDetail = 'url' | 'identity' | 'filter' | 'public';
export interface Meta {
  v: 1; proto: 1;
  peer_id: PeerId; epoch: EpochId; seq_next: number;
  branch: string; enc: string;
  pinned: { url: string; identity: string[] };
  H_adopt: Oid; EPOCH_BASE: Oid;
  expected_epoch: { symref: string; head: Oid; stash: Oid | null };
  freeze_reasons: FreezeReason[]; config_detail: ConfigDetail[];
  incident: null | { n: number; observed_board: Oid | null; observed_code: Oid | null };
  nonretryable: null | { lease: Oid; hold_id: string };
  rejections: null | { lease: Oid; n: number };
  throttle: null | { signal: ThrottleSignal };
  pending: Record<string, DeferReason>;
  displaced: string[];                 // oid12 list (cap 3)
  // Plan 2 additions — flagged for 01-engine §3.2:
  fold_board: Oid | null;
  fold_verified: { board: Oid; height: number } | null;   // P2-FOLDPERSIST (Folder.verification())
  checkpoint_mismatch: boolean;                          // P2-FOLDPERSIST; R-13 pause survives restarts
  outbox: Json;
  cs_human_next: number;
  incident_next: number;
}

/** meta.v > 1: written by a newer plugin; the branch is 'refused' (LIF-37). */
export class MetaTooNewError extends Error {
  /** The newer meta.json's `v` (START_STATE_NEWER{meta_v}); null when the caller did not read one. */
  readonly metaV: number | null;
  constructor(message?: string, metaV: number | null = null) {
    super(message);
    this.name = 'MetaTooNewError';
    this.metaV = metaV;
  }
}

/** The meta.json version this build writes and reads (START_STATE_NEWER{own_v}). */
export const META_V = 1;
const DISPLACED_CAP = 3;

const FREEZE_REASONS: ReadonlySet<string> = new Set(Object.keys({ EPOCH: 1, MASS: 1, PAUSED: 1, INCIDENT: 1, CONFIG: 1, NOHOOKS: 1 } satisfies Record<FreezeReason, 1>));
const CONFIG_DETAILS: ReadonlySet<string> = new Set(Object.keys({ url: 1, identity: 1, filter: 1, public: 1 } satisfies Record<ConfigDetail, 1>));
const THROTTLE_SIGNALS: ReadonlySet<string> = new Set(Object.keys({ http_429: 1, http_5xx: 1, slow_push: 1, rejection_streak: 1 } satisfies Record<ThrottleSignal, 1>));
const DEFER_REASONS: ReadonlySet<string> = new Set(Object.keys({
  fence: 1, read_lease: 1, txn: 1, unreadable: 1, unstable: 1, conflicted_leased: 1, eol_form: 1, local_only_conflict: 1,
  disk_low: 1, locked: 1, mismatch: 1, race: 1, closure: 1, filter_failure: 1, collision: 1, unmaterializable: 1, quarantine: 1,
} satisfies Record<DeferReason, 1>));

const META_KEYS = [
  'v', 'proto', 'peer_id', 'epoch', 'seq_next', 'branch', 'enc', 'pinned', 'H_adopt', 'EPOCH_BASE', 'expected_epoch',
  'freeze_reasons', 'config_detail', 'incident', 'nonretryable', 'rejections', 'throttle', 'pending', 'displaced',
  'fold_board', 'fold_verified', 'checkpoint_mismatch', 'outbox', 'cs_human_next', 'incident_next',
];

type Obj = Record<string, unknown>;

class MetaFormatError extends Error {
  constructor(what: string) {
    super(`meta.json: ${what}`);
    this.name = 'MetaFormatError';
  }
}

function isObj(v: unknown): v is Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function obj(v: unknown, keys: readonly string[], what: string): Obj {
  if (!isObj(v)) throw new MetaFormatError(`${what} is not an object`);
  const have = Object.keys(v).sort();
  const want = [...keys].sort();
  if (have.length !== want.length || have.some((k, i) => k !== want[i])) {
    throw new MetaFormatError(`${what} has keys [${have.join(', ')}], expected [${want.join(', ')}]`);
  }
  return v;
}

function int(v: unknown, min: number, what: string): void {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) throw new MetaFormatError(`${what} must be a safe integer >= ${min}`);
}

function oid(v: unknown, what: string): void {
  if (!isOid(v)) throw new MetaFormatError(`${what} must be an object id`);
}

function oidOrNull(v: unknown, what: string): void {
  if (v !== null) oid(v, what);
}

function str(v: unknown, what: string, nonEmpty = false): void {
  if (typeof v !== 'string' || (nonEmpty && v.length === 0)) throw new MetaFormatError(`${what} must be a${nonEmpty ? ' non-empty' : ''} string`);
}

function members(v: unknown, allowed: (x: unknown) => boolean, what: string, max = Infinity): void {
  if (!Array.isArray(v) || v.length > max) throw new MetaFormatError(`${what} must be an array${max < Infinity ? ` of at most ${max}` : ''}`);
  if (!v.every(allowed)) throw new MetaFormatError(`${what} has an invalid member`);
  if (new Set(v).size !== v.length) throw new MetaFormatError(`${what} has a duplicate member`);
}

/** The v1 field checks, after v === 1 was established. */
function checkV1(m: Obj): void {
  obj(m, META_KEYS, 'meta');
  if (m['proto'] !== 1) throw new MetaFormatError('proto must be 1');
  if (typeof m['peer_id'] !== 'string' || !validId('hex128', m['peer_id'])) throw new MetaFormatError('peer_id must be 32 lowercase hex');
  if (typeof m['epoch'] !== 'string' || !validId('hex128', m['epoch'])) throw new MetaFormatError('epoch must be 32 lowercase hex');
  int(m['seq_next'], 1, 'seq_next');
  str(m['branch'], 'branch', true);
  str(m['enc'], 'enc', true);
  let e: string;
  try {
    e = enc(m['branch'] as string);
  } catch {
    throw new MetaFormatError('branch cannot be encoded');
  }
  if (m['enc'] !== e) throw new MetaFormatError('enc is not enc(branch)');

  const pinned = obj(m['pinned'], ['url', 'identity'], 'pinned');
  str(pinned['url'], 'pinned.url', true);
  members(pinned['identity'], isOid, 'pinned.identity');

  oid(m['H_adopt'], 'H_adopt');
  oid(m['EPOCH_BASE'], 'EPOCH_BASE');
  const ee = obj(m['expected_epoch'], ['symref', 'head', 'stash'], 'expected_epoch');
  str(ee['symref'], 'expected_epoch.symref');
  oid(ee['head'], 'expected_epoch.head');
  oidOrNull(ee['stash'], 'expected_epoch.stash');

  members(m['freeze_reasons'], (x) => typeof x === 'string' && FREEZE_REASONS.has(x), 'freeze_reasons');
  members(m['config_detail'], (x) => typeof x === 'string' && CONFIG_DETAILS.has(x), 'config_detail');

  if (m['incident'] !== null) {
    const inc = obj(m['incident'], ['n', 'observed_board', 'observed_code'], 'incident');
    int(inc['n'], 1, 'incident.n');
    oidOrNull(inc['observed_board'], 'incident.observed_board');
    oidOrNull(inc['observed_code'], 'incident.observed_code');
  }
  if (m['nonretryable'] !== null) {
    const nr = obj(m['nonretryable'], ['lease', 'hold_id'], 'nonretryable');
    oid(nr['lease'], 'nonretryable.lease');
    if (typeof nr['hold_id'] !== 'string' || !validId('ulid', nr['hold_id'])) throw new MetaFormatError('nonretryable.hold_id must be a ULID');
  }
  if (m['rejections'] !== null) {
    const rj = obj(m['rejections'], ['lease', 'n'], 'rejections');
    oid(rj['lease'], 'rejections.lease');
    int(rj['n'], 1, 'rejections.n');
  }
  if (m['throttle'] !== null) {
    const th = obj(m['throttle'], ['signal'], 'throttle');
    if (typeof th['signal'] !== 'string' || !THROTTLE_SIGNALS.has(th['signal'])) throw new MetaFormatError('throttle.signal is not a throttle signal');
  }

  const pending = m['pending'];
  if (!isObj(pending)) throw new MetaFormatError('pending is not an object');
  for (const [p, reason] of Object.entries(pending)) {
    if (!validPathSyntax(p)) throw new MetaFormatError(`pending path ${JSON.stringify(p)} is not a valid path`);
    if (typeof reason !== 'string' || !DEFER_REASONS.has(reason)) throw new MetaFormatError(`pending reason of ${JSON.stringify(p)} is not a defer reason`);
  }
  members(m['displaced'], (x) => typeof x === 'string' && /^[0-9a-f]{12}$/.test(x), 'displaced', DISPLACED_CAP);

  oidOrNull(m['fold_board'], 'fold_board');
  if (m['fold_verified'] !== null) {
    const fv = obj(m['fold_verified'], ['board', 'height'], 'fold_verified');
    oid(fv['board'], 'fold_verified.board');
    int(fv['height'], 0, 'fold_verified.height');
  }
  if (typeof m['checkpoint_mismatch'] !== 'boolean') throw new MetaFormatError('checkpoint_mismatch must be a boolean');
  // outbox: any JSON value; Outbox.fromJson validates its entries when the engine restores it.
  int(m['cs_human_next'], 1, 'cs_human_next');
  int(m['incident_next'], 1, 'incident_next');
}

/**
 * The Meta of a meta.json blob. A `v` integer above 1 throws MetaTooNewError before anything else is read;
 * any other deviation from what serializeMeta writes (another v, a missing or extra key, a field of the wrong
 * type, non-canonical bytes, a BOM) throws an Error.
 */
export function parseMeta(buf: Buffer): Meta {
  let v: unknown;
  try {
    v = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new MetaFormatError('not JSON');
  }
  if (!isObj(v)) throw new MetaFormatError('not an object');
  const ver = v['v'];
  if (typeof ver === 'number' && Number.isSafeInteger(ver) && ver > META_V) {
    throw new MetaTooNewError(`meta.json: meta_v ${ver} is newer than ${META_V}`, ver);
  }
  if (ver !== META_V) throw new MetaFormatError(`v must be ${META_V}`);
  checkV1(v);
  let canonical: Buffer;
  try {
    canonical = canonicalBytes(v as Json);
  } catch {
    throw new MetaFormatError('not serializable as canonical JSON');
  }
  if (!canonical.equals(buf)) throw new MetaFormatError('bytes are not canonical JSON');
  return v as unknown as Meta;
}

/** Canonical JSON (RFC 8785), no timestamps (ENG-05). A Meta parseMeta would refuse (an extra key included) throws. */
export function serializeMeta(m: Meta): Buffer {
  const buf = canonicalBytes(m as unknown as Json);
  parseMeta(buf);
  return buf;
}
