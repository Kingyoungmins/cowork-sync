// Receive-side and transient hold records (05-holds HLD-32, HLD-53…HLD-55; 03-data DAT-11, DAT-29, DAT-33; 09-security SEC-32 (the
// record); glossary §9 transient exception, §20 "60 s"; rulings R3-29…R3-31, R3-56). Pure decisions over the registry: the engine
// hands in this loop's A (after the apply), TIP, the apply's deferred write groups (closures), its not-applicable paths, the
// publish-side exclusions of the tick and the private-index blob of a path; nothing here reads the disk, git trees or claim
// state (HLD-06).
//
//   not applicable   each not-applicable path (`unmaterializable`, `collision`, an incoming change to a QUARANTINED path) is its
//                    own INCOMING record at once (h0 = A[p], h1 = TIP[p]); its creation op waits until it is 60 s old (R3-29,
//                    mirror.ts creationDue); INCOMING_UNMATERIALIZABLE / INCOMING_COLLISION come back in `codes`
//   closures         one deferred write group is one closure (R3-31); its clock 'closure:<sorted paths>' starts at first sight
//                    (INCOMING_WAITING once per episode) and at 60 s Δmono the closure becomes ONE INCOMING record (guard by
//                    INCOMING_GUARD_OF of its group-level reason; h0 = A, h1 = TIP's blobs); an INCOMING closure record that
//                    already covers part of a closure (the closure grew) widens to it at once, in one rev (HLD-07)
//   transient        a publish-side exclusion (`unreadable`, `unstable`) that lasts 60 s becomes one PIN (h0 = A[p], h1 = the
//                    private-index blob), none when both are ABSENT (R3-56: a never-staged new file holds nothing)
//   refresh/release  every non-terminal INCOMING record follows TIP (h1 := TIP[p], h0 := A[p], one rev when that moves) and ends
//                    SUBSUMED when every path has A[p] == TIP[p] (its paths applied, or TIP no longer changes them, HLD-54); a
//                    transient guard is released when its path leaves the exclusions (the record ends SUBSUMED when it holds
//                    no other guard)
//
// Existing records are found by their guards and transitioned (one commitMany per loop); hold() runs only for a record that does
// not exist yet, so a detection-only loop never REBASEs an existing record (glossary §26.1 W6). Ages live in memory
// (TransientClocks, R3-30): a restart restarts them, so a deferral older than 60 s gets its record ≤ 60 s after a restart.
import type { Json } from '../board/canonicalJson.js';
import type { PortRule } from '../data/scope.js';
import { ABSENT, type OidOrAbsent } from '../git/oid.js';
import type { TreeMap } from '../git/repo.js';
import type { Clock } from '../ports/clock.js';
import { validPathSyntax } from '../sec/validators.js';
import type { DeferReason, IncomingCs } from './groups.js';
import { blobAt, guardName, isUnknownGuard, makeGuard, setBlob, type BlobMap, type Guard, type HoldRecord } from './record.js';
import type { HoldPatch, HoldRegistry } from './registry.js';

/** HLD-32, glossary §20: a transient exclusion or an apply-side deferral becomes a record once it lasts this long (local Δmono). */
export const TRANSIENT_RECORD_MS = 60_000;

/** Δmono since a key was first seen in this daemon run; keys 'path:<p>' or 'closure:<sorted paths>' (R3-30). In memory only. */
export class TransientClocks {
  private readonly clock: Clock;
  private readonly first = new Map<string, number>();

  constructor(clock: Clock) {
    this.clock = clock;
  }

  /** Age in ms (0 at first sight). */
  see(key: string): number {
    const now = this.clock.monoMs();
    const at = this.first.get(key);
    if (at === undefined) {
      this.first.set(key, now);
      return 0;
    }
    return Math.max(0, Math.floor(now - at));
  }

  forget(key: string): void {
    this.first.delete(key);
  }

  /** Every key seen and not forgotten, with its age now. */
  ages(): ReadonlyMap<string, number> {
    const now = this.clock.monoMs();
    return new Map([...this.first].map(([k, at]) => [k, Math.max(0, Math.floor(now - at))] as const));
  }
}

export type NotApplicableReason = 'collision' | 'unmaterializable' | 'quarantine';
export type ClosureReason = Exclude<DeferReason, 'closure' | 'collision' | 'unmaterializable' | 'quarantine'>;

/** R3-31: a closure's guard comes from its group-level reason, never 'closure'. */
export const INCOMING_GUARD_OF: Readonly<Record<ClosureReason, 'lock' | 'eol-form' | 'local-only-conflict'>> = Object.freeze({
  eol_form: 'eol-form',
  local_only_conflict: 'local-only-conflict',
  fence: 'lock', read_lease: 'lock', txn: 'lock', unreadable: 'lock', unstable: 'lock', conflicted_leased: 'lock',
  disk_low: 'lock', locked: 'lock', mismatch: 'lock', race: 'lock', filter_failure: 'lock',
});

const isClosureReason = (r: DeferReason): r is ClosureReason => Object.prototype.hasOwnProperty.call(INCOMING_GUARD_OF, r);

/**
 * R3-31's group-level reason of one deferred write group: the first of eol_form > local_only_conflict > any other reason among its
 * entries (in the given order), `closure` ignored. A writer refusal of the whole group (DeferGroup 'unmaterializable', found at
 * write time) is an apply-side reason like a lock: 'locked'. A list with no reason but `closure` is a caller bug (writeGroups
 * defers a group only for a path's own reason): TypeError. Pure.
 */
export function closureReason(reasons: readonly DeferReason[]): ClosureReason {
  const own = reasons.filter((r) => r !== 'closure');
  if (own.length === 0) throw new TypeError('closureReason: a deferred write group needs a reason other than closure');
  if (own.includes('eol_form')) return 'eol_form';
  if (own.includes('local_only_conflict')) return 'local_only_conflict';
  return own.find(isClosureReason) ?? 'locked';
}

/** A message code incomingStep (or another src/holds step) asks the engine to raise. */
export interface HoldCodeRaise { code: string; params: Record<string, Json>; }

export interface IncomingInputs {
  A: TreeMap; tipMap: TreeMap;
  /**
   * Whether A[p] and TIP[p] differ (an entry's oid or mode, or one side absent): the engine passes treeDiff's sameTreeEntry negated
   * (Global Constraints "Shared helpers, never copied": src/holds takes tree comparisons as caller-supplied parameters). Task 6 fix
   * round 1 contract addition.
   */
  differs: (path: string) => boolean;
  /**
   * This loop's deferred write groups, one per group: ApplyReport.closures (R3-31); `path` (optional, controller ruling) is the path the
   * group waits for — INCOMING_WAITING names it, the closure's first path when absent.
   */
  closures: ReadonlyArray<{ paths: readonly string[]; reason: ClosureReason; path?: string }>;
  notApplicable: ReadonlyMap<string, NotApplicableReason>;
  rules: ReadonlyMap<string, PortRule>;                                         // the D7 rule of each `unmaterializable` path (ApplyReport.notApplicableRules)
  csOf: (path: string) => string | null;                                        // the incoming CS id of a deferred path (for INCOMING_WAITING {cs, path, reason}), from ApplyReport.incoming
  transient: ReadonlyMap<string, 'unreadable' | 'unstable'>;                   // publish-side exclusions of this tick
  privateBlob: (path: string) => OidOrAbsent;                                   // the blob the private index holds (h1 of a transient PIN)
}

/** ApplyReport.incoming → IncomingInputs.csOf: the newest incoming CS naming the path (incomingChangeSets lists the newest commit first). */
export function incomingCsOf(incoming: readonly IncomingCs[]): (path: string) => string | null {
  const of = new Map<string, string>();
  for (const cs of incoming) for (const p of cs.paths) if (!of.has(p)) of.set(p, cs.csId);
  return (p) => of.get(p) ?? null;
}

const CLOSURE_GUARDS: ReadonlySet<string> = new Set(['lock', 'eol-form', 'local-only-conflict']);
const TRANSIENT_GUARDS: ReadonlySet<string> = new Set(['unreadable', 'unstable']);
const GUARD_OF_NOT_APPLICABLE: Readonly<Record<NotApplicableReason, 'collision' | 'unmaterializable' | 'quarantine-review'>> = {
  collision: 'collision', unmaterializable: 'unmaterializable', quarantine: 'quarantine-review',
};
const CLOSURE_PREFIX = 'closure:';
const PATH_PREFIX = 'path:';
/** Separator of a closure key's paths: a valid repo path never holds NUL, so the key round-trips to its path list. */
const SEP = '\u0000';

/**
 * Plan 3 Task 12a (HLD-32, R3-30): the 60 s clock of every publish-side transient exclusion of a detection tick starts (or keeps
 * running) at the tick that saw it — detectStep's "transient clocks", so an iteration that never reaches recordStep (a fetch owed
 * after a suspend) still ages the exclusion; incomingStep forgets the clock of a path that left the exclusions.
 */
export function seeTransient(clocks: TransientClocks, transient: ReadonlyMap<string, 'unreadable' | 'unstable'>): void {
  for (const p of transient.keys()) clocks.see(`${PATH_PREFIX}${p}`);
}

/** Plan 3 Task 12a (R3-56, holdStatusInputs): the age (Δmono ms) of every running transient-exclusion clock, by path. */
export function transientAges(clocks: TransientClocks): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, age] of clocks.ages()) if (k.startsWith(PATH_PREFIX)) out.set(k.slice(PATH_PREFIX.length), age);
  return out;
}

/** Per clocks instance (one per EngineCore, a new one per daemon run): the current closures (key → group-level reason). */
const memory = new WeakMap<TransientClocks, Map<string, ClosureReason>>();

function closureKey(paths: readonly string[]): string {
  return `${CLOSURE_PREFIX}${[...new Set(paths)].sort().join(SEP)}`;
}

function closurePaths(key: string): string[] {
  return key.slice(CLOSURE_PREFIX.length).split(SEP);
}

/**
 * Plan 3 Task 18 (rev 2.5, F14; 10-product §3.5.1 I3 "reuses the HLD-54 deferral anchor", FEAT-F14-14): per deferred path, the age
 * (Δmono ms) of its HLD-54 clock — the clock of the current closure holding the path (the closures of the last apply that reported
 * any, incomingStep's `current`), whose 60 s create the closure's INCOMING record; a closure whose path set changed is a new clock. A
 * read-only view: nothing is seen or forgotten. Empty before incomingStep first ran on these clocks.
 */
export function deferralAges(clocks: TransientClocks): Map<string, number> {
  const out = new Map<string, number>();
  const current = memory.get(clocks);
  if (current === undefined) return out;
  const ages = clocks.ages();
  for (const key of current.keys()) {
    const age = ages.get(key);
    if (age === undefined) continue;
    for (const p of closurePaths(key)) out.set(p, Math.max(out.get(p) ?? 0, age));
  }
  return out;
}

const oidAt = (m: TreeMap, p: string): OidOrAbsent => m.get(p)?.oid ?? ABSENT;
const carries = (r: HoldRecord, names: ReadonlySet<string>): boolean => r.guards.some((g) => names.has(guardName(g)));
const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** h0 = A[p], h1 = TIP[p] on every path (HLD-54). */
function incomingBlobs(paths: readonly string[], A: TreeMap, T: TreeMap): { h0: BlobMap; h1: BlobMap } {
  const h0: BlobMap = {};
  const h1: BlobMap = {};
  for (const p of paths) {
    setBlob(h0, p, oidAt(A, p));
    setBlob(h1, p, oidAt(T, p));
  }
  return { h0, h1 };
}

function sameBlobMap(a: BlobMap, b: BlobMap): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => blobAt(b, k) !== undefined && blobAt(a, k) === blobAt(b, k));
}

function sameHolds(r: HoldRecord, want: { h0: BlobMap; h1: BlobMap }): boolean {
  return 'h1' in r.blobs && sameBlobMap(r.blobs.h0, want.h0) && sameBlobMap(r.blobs.h1, want.h1);
}

/**
 * One loop (HLD-53/54/55, HLD-32): not-applicable → INCOMING at once; closures ≥ 60 s → one INCOMING each; transient ≥ 60 s → one PIN,
 * none when h0 and h1 are both ABSENT (R3-56); releases (SUBSUMED) when applied, TIP no longer changes the paths, or the condition
 * cleared; h1 refreshed when TIP moves. A closure whose path set changes is a new closure for the 60 s rule (its key changes); an
 * INCOMING record already covering part of it widens (paths ∪, h1 from TIP) in a new rev — at once, with any TIP refresh of the same
 * loop in that one rev — instead of a second record being created (HLD-07; INV-GROUP's "one record per closure"). A closure clock is
 * forgotten only when none of its paths is still deferred (inp.differs: A[p] ≠ TIP[p]), so an apply coalesced away for 10 s keeps
 * the ages; the closures of the last apply that reported any stay current until then. A path failing validPathSyntax is no record's
 * path: it stays carried by scope class (UNMANAGED, P2-CARRY). The codes come back in `codes` (record ids exist only here):
 * INCOMING_UNMATERIALIZABLE {id, path, rule} (rule null when no D7 rule names the cause, e.g. a path beneath a symlink),
 * INCOMING_COLLISION {id, path}, INCOMING_WAITING {cs, path, reason} once per closure episode — `path` is the one the closure waits
 * for (its `path`, from the writer's GroupResult.path or the first path with the group-level reason), `cs` its incoming CS; the
 * engine caller passes them to raiseHoldCodes (core.ts).
 */
export async function incomingStep(reg: HoldRegistry, clocks: TransientClocks, inp: IncomingInputs): Promise<{ created: string[]; released: string[]; codes: HoldCodeRaise[] }> {
  const created: string[] = [];
  const released: string[] = [];
  const codes: HoldCodeRaise[] = [];
  const { A, tipMap: T, differs } = inp;
  let current = memory.get(clocks);
  if (current === undefined) memory.set(clocks, (current = new Map()));

  // ---- the registry's records this step owns (never one carrying a guard outside Table 3: HLD-05) ----
  const live = reg.nonTerminal().filter((r) => !r.guards.some(isUnknownGuard));
  const incoming = live.filter((r) => r.kind === 'INCOMING');
  const transientPins = live.filter((r) => r.kind === 'PIN' && carries(r, TRANSIENT_GUARDS));
  const patches = new Map<string, HoldPatch>();
  const ending = new Set<string>();

  // Release: every path applied or no longer changed by TIP (HLD-54); else follow TIP (R3-31: refreshed by a new rev).
  for (const r of incoming) {
    if (!r.paths.some(differs)) {
      patches.set(r.id, { state: 'SUBSUMED' });
      ending.add(r.id);
      continue;
    }
    const want = incomingBlobs(r.paths, A, T);
    if (!sameHolds(r, want)) patches.set(r.id, { blobs: want });
  }
  // Transient guards: released when the path left this tick's exclusions (HLD-32: one op at creation, one at release).
  for (const r of transientPins) {
    const kept = r.guards.filter((g) => !TRANSIENT_GUARDS.has(guardName(g)) || r.paths.some((p) => inp.transient.get(p) === guardName(g)));
    if (kept.length === r.guards.length) continue;
    if (kept.length === 0) {
      patches.set(r.id, { state: 'SUBSUMED' });
      ending.add(r.id);
    } else {
      patches.set(r.id, { guards: kept });
    }
  }

  // ---- closures (R3-30, R3-31) ----
  if (inp.closures.length > 0) {
    current.clear();
    for (const c of inp.closures) {
      const paths = [...new Set(c.paths)].filter((p) => validPathSyntax(p)).sort(byPath);
      if (paths.length === 0) continue;
      const key = closureKey(paths);
      const fresh = !clocks.ages().has(key);
      clocks.see(key);
      current.set(key, c.reason);
      if (fresh) {
        const blocker = c.path !== undefined && paths.includes(c.path) ? c.path : paths[0]!;   // the path the group waits for (HLD-53)
        codes.push({ code: 'INCOMING_WAITING', params: { cs: inp.csOf(blocker), path: blocker, reason: c.reason } });
      }
    }
  }
  for (const key of [...clocks.ages().keys()]) {
    if (!key.startsWith(CLOSURE_PREFIX)) continue;
    if (closurePaths(key).some(differs)) continue;   // still deferred
    clocks.forget(key);
    current.delete(key);
  }
  const ages = clocks.ages();
  const creations: Array<{ paths: string[]; guard: string }> = [];
  for (const [key, reason] of [...current].sort(([a], [b]) => byPath(a, b))) {
    const paths = closurePaths(key);
    const guard = INCOMING_GUARD_OF[reason];
    const cover = incoming.find((r) => !ending.has(r.id) && carries(r, CLOSURE_GUARDS) && r.paths.some((p) => paths.includes(p)));
    if (cover === undefined) {
      if ((ages.get(key) ?? 0) >= TRANSIENT_RECORD_MS) creations.push({ paths, guard });
      continue;
    }
    // The closure's record exists (HLD-07): it follows the closure at once — widened to it (paths ∪), h0/h1 from A/TIP and the
    // guard of the group-level reason — in one rev with any TIP refresh, never a second record.
    const union = [...new Set([...cover.paths, ...paths])].sort(byPath);
    const blobs = incomingBlobs(union, A, T);
    const guards: Guard[] = cover.guards.some((g) => g.name === guard) && cover.guards.length === 1 ? cover.guards : [makeGuard(guard)];
    const patch: HoldPatch = {};
    if (union.length !== cover.paths.length) patch.paths = union;
    if (!sameHolds(cover, blobs)) patch.blobs = blobs;
    if (guards !== cover.guards) patch.guards = guards;
    if (Object.keys(patch).length > 0) patches.set(cover.id, patch);
  }

  // ---- one commit for every release, refresh and widening ----
  if (patches.size > 0) {
    await reg.commitMany([], [...patches].map(([id, patch]) => ({ id, patch })));
    released.push(...ending);
  }

  // ---- not-applicable paths: their own INCOMING record at once (HLD-53, HLD-54) ----
  const afterwards = reg.nonTerminal().filter((r) => r.kind === 'INCOMING');
  for (const [p, reason] of [...inp.notApplicable].sort(([a], [b]) => byPath(a, b))) {
    if (!validPathSyntax(p) || !differs(p)) continue;
    const guard = GUARD_OF_NOT_APPLICABLE[reason];
    if (afterwards.some((r) => r.paths.length === 1 && r.paths[0] === p && r.guards.some((g) => guardName(g) === guard))) continue;
    const o = await reg.holdOutcome({
      kind: 'INCOMING', residence: 'ON_DISK', state: 'ACTIVE', paths: [p], blobs: incomingBlobs([p], A, T),
      guard, origin: 'daemon', cs_ids: [], displaced_by: null,
    });
    if (o.created) created.push(o.id);
    if (!o.created && o.attachedGuard === null) continue;
    if (reason === 'unmaterializable') codes.push({ code: 'INCOMING_UNMATERIALIZABLE', params: { id: o.id, path: p, rule: inp.rules.get(p) ?? null } });
    else if (reason === 'collision') codes.push({ code: 'INCOMING_COLLISION', params: { id: o.id, path: p } });
  }

  // ---- closures due at 60 s with no record yet: one INCOMING record each (HLD-54) ----
  for (const c of creations) {
    const o = await reg.holdOutcome({
      kind: 'INCOMING', residence: 'ON_DISK', state: 'ACTIVE', paths: c.paths, blobs: incomingBlobs(c.paths, A, T),
      guard: c.guard, origin: 'daemon', cs_ids: [], displaced_by: null,
    });
    if (o.created) created.push(o.id);
  }

  // ---- publish-side transient exclusions: one PIN at 60 s (HLD-32, R3-56) ----
  for (const key of [...clocks.ages().keys()]) {
    if (key.startsWith(PATH_PREFIX) && !inp.transient.has(key.slice(PATH_PREFIX.length))) clocks.forget(key);
  }
  const pinned = reg.nonTerminal().filter((r) => r.kind === 'PIN' && carries(r, TRANSIENT_GUARDS));
  for (const [p, why] of [...inp.transient].sort(([a], [b]) => byPath(a, b))) {
    if (!validPathSyntax(p)) continue;
    if (clocks.see(`${PATH_PREFIX}${p}`) < TRANSIENT_RECORD_MS) continue;
    if (pinned.some((r) => r.paths.includes(p) && r.guards.some((g) => guardName(g) === why))) continue;
    const h0 = oidAt(A, p);
    const h1 = inp.privateBlob(p);
    if (h0 === ABSENT && h1 === ABSENT) continue;   // R3-56: nothing to hold; the path stays a listed transient exclusion
    const b0: BlobMap = {};
    const b1: BlobMap = {};
    setBlob(b0, p, h0);
    setBlob(b1, p, h1);
    const o = await reg.holdOutcome({
      kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths: [p], blobs: { h0: b0, h1: b1 }, guard: why, origin: 'daemon', cs_ids: [], displaced_by: null,
    });
    if (o.created) created.push(o.id);
  }
  return { created, released, codes };
}
