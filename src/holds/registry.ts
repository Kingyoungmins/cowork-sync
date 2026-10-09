// The local hold registry refs/cowork-local/<enc(b)>/holds (glossary §9; 05-holds HLD-01…HLD-05; rulings R-02, R-03).
//
// An append-only commit chain: each transition is one commit `cowork-holds` whose first parent is the previous
// registry commit and whose tree is the whole registry,
//
//   records/<id>.json   blob   the newest rev of every record (src/holds/record.ts, canonical JSON)
//   blobs/<oid>         blob   every blob a record names (ABSENT has no entry)
//
// so every referenced blob is reachable for `git gc --prune=now`; older revs and the blobs they named stay
// reachable through the chain. Metadata trees come from mktree (ruling R-15). The ref changes only by one CAS
// update-ref --create-reflog per transition, with crashpoint('registry.cas') immediately before and after it; a
// lost CAS is a second writer (security log, RegistryCasLostError; the caller exits as for ENG-03). load()
// re-attaches the registry at start (HLD-01). Blob content enters only by oid: the caller wrote it through the
// pinned clean path (HLD-03), and the registry refuses an oid that is not a blob in the object store.
import type { PeerId } from '../board/ids.js';
import { ABSENT, parseOid, type Oid } from '../git/oid.js';
import type { GitRepo, MktreeEntry } from '../git/repo.js';
import type { Clock } from '../ports/clock.js';
import { crashpoint } from '../ports/crashpoint.js';
import type { Log } from '../ports/log.js';
import { ulid, type Random } from '../ports/random.js';
import type { Trace } from '../ports/trace.js';
import {
  PLAN2_GUARD_CLASS, guardName, isTerminal, parseRecord, serializeRecord,
  type BlobMap, type Guard, type HoldBlobs, type HoldRecord, type Plan2Guard, type Residence,
} from './record.js';

export interface NewRecord {
  kind: 'PATCH' | 'PIN'; residence: Residence; state: 'ACTIVE' | 'CONFLICTED' | 'PARKED';
  paths: string[]; blobs: HoldBlobs;
  guard: Plan2Guard | null;                 // null only for the ring late-write PATCH (OFF_DISK PARKED, ruling R-03 (iii))
  origin: string; cs_ids: string[]; displaced_by: string | null; local_only: boolean;
}
// Plan 2 record shapes: conflict = PATCH CONFLICTED (ON_DISK on the publish side until the apply writes TIP, then OFF_DISK; R-02);
// restart = PATCH ACTIVE ON_DISK; phantom, host-reject, join = PIN ACTIVE ON_DISK; eol-bom = PATCH ACTIVE ON_DISK (whole path).
export interface RegistryDeps { repo: GitRepo; ref: string; random: Random; clock: Clock; peer: PeerId; trace: Trace; log: Log; }

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
/** 05-holds Table 3 owner column of the Plan 2 guards. */
const GUARD_OWNER: Readonly<Record<Plan2Guard, string>> = { conflict: 'DAT', 'eol-bom': 'DAT', restart: 'ENG', phantom: 'ENG', 'host-reject': 'ENG', join: 'LIF' };
const RECORDS = 'records/';
const BLOBS = 'blobs/';
const RECORD_SUFFIX = '.json';

function sameMap(a: BlobMap, b: BlobMap): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k]);
}

function sameGuardNames(a: readonly Guard[], b: readonly Guard[]): boolean {
  const na = a.map((g) => g.name).sort();
  const nb = b.map((g) => g.name).sort();
  return na.length === nb.length && na.every((n, i) => n === nb[i]);
}

function blobOids(r: HoldRecord): Oid[] {
  const out: Oid[] = [];
  for (const m of Object.values(r.blobs) as BlobMap[]) for (const o of Object.values(m)) if (o !== ABSENT) out.push(o);
  return out;
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

/** The current registry: its head commit, its records by id and each record's blob oid. */
interface Snapshot { head: Oid | null; records: Map<string, HoldRecord>; recordOids: Map<string, Oid>; }

export class HoldRegistry {
  private readonly d: RegistryDeps;
  private cur: Snapshot | null = null;
  /** Per record: the monoMs from which this run's Δmono is not yet in age_anchor.mono_accum_ms (05-holds §2). */
  private readonly monoFrom = new Map<string, number>();
  /** The tail of the in-process queue: load(), hold() and transition() run one at a time, so two overlapping calls never race one CAS. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(d: RegistryDeps) {
    this.d = d;
  }

  /** Runs `fn` after every earlier queued call settled (a failure does not stop the queue). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Re-attach (HLD-01): read the ref; an absent ref is an empty registry. A malformed registry throws. */
  load(): Promise<void> {
    return this.serial(() => this.loadNow());
  }

  private async loadNow(): Promise<void> {
    const { repo, ref, clock } = this.d;
    const head = await repo.readRef(ref);
    const records = new Map<string, HoldRecord>();
    const recordOids = new Map<string, Oid>();
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
        } else {
          throw bad(`unexpected entry ${JSON.stringify(path)}`);
        }
      }
      const ids = [...recordOids.keys()];
      const bufs = await repo.readBlobs(ids.map((id) => recordOids.get(id)!));
      ids.forEach((id, i) => {
        const r = storedRecord(bufs[i]!);
        if (r.id !== id) throw bad(`records/${id}.json holds record ${r.id}`);
        records.set(id, r);
      });
      const named = new Set<string>([...records.values()].flatMap(blobOids));
      if (named.size !== blobNames.size || [...named].some((o) => !blobNames.has(o))) throw bad('blobs/ does not match the blobs the records name');
    }
    this.cur = { head, records, recordOids };
    this.monoFrom.clear();
    const now = clock.monoMs();
    for (const id of records.keys()) this.monoFrom.set(id, now);
  }

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

  /**
   * HLD-05 hold(). Dedupe among non-terminal records: an h0/h1 record dedupes on kind + guard + paths + h1; a stage
   * record (s1/s2/s3) dedupes on kind + guard + paths + s2 ONLY, and its s1/s3 are then updated to the newer call's
   * stages by transition() (R-02). A dedupe returns the existing id; otherwise one registry commit with a new ULID
   * record at rev 1; crashpoint('registry.cas') immediately before and after the CAS. Queued behind earlier calls.
   */
  hold(n: NewRecord): Promise<string> {
    return this.serial(() => this.holdNow(n));
  }

  private async holdNow(n: NewRecord): Promise<string> {
    const snap = this.snapshot();
    const { clock, peer } = this.d;
    if (n.kind !== 'PATCH' && n.kind !== 'PIN') throw new TypeError(`hold: kind ${String(n.kind)} is not PATCH or PIN`);
    if (n.guard !== null && !Object.prototype.hasOwnProperty.call(PLAN2_GUARD_CLASS, n.guard)) throw new TypeError(`hold: ${String(n.guard)} is not a Plan 2 guard`);
    const guards: Guard[] = n.guard === null ? [] : [{ name: n.guard, class: PLAN2_GUARD_CLASS[n.guard], owner: GUARD_OWNER[n.guard] }];
    const paths = [...new Set(n.paths)].sort();

    for (const r of snap.records.values()) {
      if (isTerminal(r) || r.kind !== n.kind || !sameGuardNames(r.guards, guards)) continue;
      if (r.paths.length !== paths.length || r.paths.some((p, i) => p !== paths[i])) continue;
      if ('h1' in r.blobs && 'h1' in n.blobs) {
        if (sameMap(r.blobs.h1, n.blobs.h1)) return r.id;
      } else if ('s2' in r.blobs && 's2' in n.blobs) {
        if (!sameMap(r.blobs.s2, n.blobs.s2)) continue;
        if (!sameMap(r.blobs.s1, n.blobs.s1) || !sameMap(r.blobs.s3, n.blobs.s3)) await this.transitionNow(r.id, { blobs: n.blobs });
        return r.id;
      }
    }

    const id = ulid(this.d.random, clock);
    if (snap.records.has(id)) throw new Error(`hold: ULID ${id} is already a record id`);
    const record: HoldRecord = {
      id, rev: 1, owner: peer,
      kind: n.kind, residence: n.residence, state: n.state, offer: 'none',
      declines: 0, displaced_by: n.displaced_by,
      paths, blobs: n.blobs, guards,
      origin: n.origin, cs_ids: [...n.cs_ids], peer_authors: [], local_only: n.local_only,
      age_anchor: { since_rev: 1, anchor_wall_ms: Math.floor(clock.wallMs()), mono_accum_ms: 0 }, proto: 1,
    };
    await this.write(snap, record);
    this.monoFrom.set(id, clock.monoMs());
    this.d.trace.emit({ kind: 'hold', peer, id, holdKind: n.kind, guard: guards.map((g) => g.name).join(','), paths, residence: n.residence });
    return id;
  }

  /** A new rev of a non-terminal record, one registry commit; the result must still be a valid record (Table 1). Queued behind earlier calls. */
  transition(id: string, patch: Partial<Pick<HoldRecord, 'residence' | 'state' | 'blobs' | 'guards'>>): Promise<HoldRecord> {
    return this.serial(() => this.transitionNow(id, patch));
  }

  /** transition() inside the queue (hold()'s stage update calls it directly: queuing it again would wait for itself). */
  private async transitionNow(id: string, patch: Partial<Pick<HoldRecord, 'residence' | 'state' | 'blobs' | 'guards'>>): Promise<HoldRecord> {
    const snap = this.snapshot();
    const { clock, peer } = this.d;
    const prev = snap.records.get(id);
    if (prev === undefined) throw new Error(`transition: unknown hold record ${JSON.stringify(id)}`);
    if (isTerminal(prev)) throw new Error(`transition: hold record ${id} is terminal (${prev.state})`);
    const rev = prev.rev + 1;
    const now = clock.monoMs();
    const from = this.monoFrom.get(id) ?? now;
    const elapsed = Math.max(0, Math.floor(now - from));
    const residence = patch.residence !== undefined ? patch.residence : prev.residence;
    // The age restarts when the record (re)becomes ON_DISK; otherwise this run's Δmono is re-persisted (05-holds §2).
    const ageStarts = residence === 'ON_DISK' && prev.residence !== 'ON_DISK';
    const next: HoldRecord = {
      ...prev,
      ...(patch.residence !== undefined ? { residence: patch.residence } : {}),
      ...(patch.state !== undefined ? { state: patch.state } : {}),
      ...(patch.blobs !== undefined ? { blobs: patch.blobs } : {}),
      ...(patch.guards !== undefined ? { guards: patch.guards.map((g) => ({ ...g })) } : {}),
      rev,
      age_anchor: ageStarts
        ? { since_rev: rev, anchor_wall_ms: Math.floor(clock.wallMs()), mono_accum_ms: 0 }
        : { ...prev.age_anchor, mono_accum_ms: prev.age_anchor.mono_accum_ms + elapsed },
    };
    const stored = await this.write(snap, next);
    this.monoFrom.set(id, ageStarts ? now : from + elapsed);
    if (residence !== null && residence !== prev.residence) {
      this.d.trace.emit({ kind: 'hold', peer, id, holdKind: stored.kind === 'PIN' ? 'PIN' : 'PATCH', guard: stored.guards.map((g) => g.name).join(','), paths: [...stored.paths], residence });
    }
    return stored;
  }

  /** Non-terminal records that MASK reads (ON_DISK with guards or local_only, CONFLICTED); maskEntries applies the steps. */
  maskingRecords(): readonly HoldRecord[] {
    return this.nonTerminal().filter((r) => (r.residence === 'ON_DISK' && (r.guards.length > 0 || r.local_only)) || r.state === 'CONFLICTED'
      || r.guards.some((g) => guardName(g) === 'claim-breach'));
  }

  private snapshot(): Snapshot {
    if (this.cur === null) throw new Error('HoldRegistry: load() first (HLD-01 re-attach)');
    return this.cur;
  }

  /**
   * One registry commit holding every record with `record` replacing its id's entry; memory changes only after the CAS.
   * Memory keeps the record parsed back from its canonical bytes, deeply frozen (returned), never the caller's objects:
   * a caller mutating its blob maps later cannot make memory differ from the stored bytes (the next tree's blobs/).
   */
  private async write(snap: Snapshot, record: HoldRecord): Promise<HoldRecord> {
    const { repo, ref, log } = this.d;
    const buf = serializeRecord(record);   // validates before any object is written
    const stored = storedRecord(buf);
    const own = [...new Set(blobOids(stored))];
    if (own.length > 0) {
      const r = await repo.run(['cat-file', '--batch-check'], { stdin: Buffer.from(`${own.join('\n')}\n`, 'utf8') });
      const lines = r.stdout.toString('utf8').split('\n');
      own.forEach((o, i) => {
        const parts = (lines[i] ?? '').split(' ');
        if (parts.length !== 3 || parts[0] !== o || parts[1] !== 'blob') throw new Error(`hold record ${stored.id}: ${o} is not a blob in the object store`);
      });
    }

    const records = new Map(snap.records);
    records.set(stored.id, stored);
    const recordOids = new Map(snap.recordOids);
    recordOids.set(stored.id, await repo.hashBytes(buf, true));

    const recordEntries: MktreeEntry[] = [...recordOids.keys()].sort().map((id) => (
      { name: `${id}${RECORD_SUFFIX}`, mode: '100644', type: 'blob', oid: recordOids.get(id)! }
    ));
    const named = [...new Set([...records.values()].flatMap(blobOids))].sort();
    const blobEntries: MktreeEntry[] = named.map((o) => ({ name: o, mode: '100644', type: 'blob', oid: parseOid(o) }));
    const root = await repo.mktree([
      { name: 'blobs', mode: '040000', type: 'tree', oid: await repo.mktree(blobEntries) },
      { name: 'records', mode: '040000', type: 'tree', oid: await repo.mktree(recordEntries) },
    ]);
    const commit = await repo.commitTree({ tree: root, parents: snap.head === null ? [] : [snap.head], subject: HOLDS_SUBJECT, trailers: [] });

    crashpoint('registry.cas');
    const ok = await repo.casRef(ref, commit, snap.head, HOLDS_SUBJECT);
    if (!ok) {
      log.write('security', CAS_LOST_CODE, { ref, expected: snap.head, commit });
      throw new RegistryCasLostError(`${ref} is no longer at ${snap.head ?? '(absent)'}: a second writer`);
    }
    crashpoint('registry.cas');
    this.cur = { head: commit, records, recordOids };
    return stored;
  }
}
