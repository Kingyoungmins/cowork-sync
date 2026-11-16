// F14's engine-side inputs (Plan 3 Task 18; rev 2.5, F14; X-11, follow-up F-P3-3; 10-product §3.5.1 "Inputs", UX-33, UX-34,
// FEAT-F14-04, -05, -13; roadmap row 3's O2/O3/O7/I2 inputs).
//
// Memory only (UX-33, FEAT-F14-05): built from the last iteration's in-memory state with no git process, no Fs call, no snapshot,
// materialization, ref, registry or board write. Every fact the query needs that no component keeps on its own is kept at the moment
// the engine already has it — the snapshot tick (dirty paths and exclusions with their first sightings, Snapshotter.flowView), the state
// commits (meta.pending's and the push intent's first sightings), the daemon start (the CSs open and the meta.pending rows then, the
// ticks the start ran), the fold (the TIP tree), HLD-54's closure clocks (TransientClocks, the deferral anchors), the Engine (its publish
// pause and loop period, read from their one source) and the apply's existing LA_C..TIP trailer read (each incoming path's writer) —
// never by a new git process, file read or ref read on the query path or the iteration path (core.ts FlowMemory). Plan 5's flow handler reads it once per request; Plan 7's pure flowEntries consumes it beside Plan 5's
// ClaudeFlowInputs (seats, activity, PULL_MODE, read sets, the defer tags fence/read_lease/txn/conflicted_leased, TXN-open instants,
// edit checks in flight), which this type does not carry. No status.json field, op, record, event, trace kind or message code is
// added (UX-34).
import { governorRank } from '../board/fold.js';
import type { PeerId } from '../board/ids.js';
import type { WaitDetail } from '../board/governor.js';
import { ABSENT } from '../git/oid.js';
import type { NotSharedReason, ScopeClass } from '../data/scope.js';
import { heldPins, type CsTableEntry, type HeldPin, type PublicationGroup } from '../holds/changesets.js';
import { deferralAges, type NotApplicableReason } from '../holds/incoming.js';
import type { HoldKind, HoldState, Residence } from '../holds/record.js';
import { flowAnchors, flowRegistrySets, flowScope, incomingDifference, NOT_APPLICABLE_REASONS, type EngineCore } from './core.js';

export interface EngineFlowInputs {
  nowMono: number; loopPeriodMs: number; tipHeight: number | null; fetchedAgeMs: number | null;
  frozen: boolean; paused: boolean; B: number;                                                        // any FREEZE reason; any publish pause; the effective budget B_eff
  dirtyPaths: ReadonlyArray<{ path: string; firstSeenMono: number }>;                                 // disk ≠ A as of the last snapshot (no newer read)
  incomingPaths: ReadonlyArray<{ path: string; writer: PeerId; name: string }>;                       // A ≠ TIP; writer and Cowork-Writer display name kept from the applies' reads
  pushIntentPaths: ReadonlyArray<{ path: string; sinceMono: number }>;                                 // a kept push intent's paths
  exclusions: ReadonlyArray<{ path: string; reason: string; firstSeenMono: number; setAtStart: boolean }>;   // snapshot and transient exclusions, first seen this run
  deferred: ReadonlyArray<{ path: string; reason: string; firstSeenMono: number; setAtStart: boolean }>;     // apply-side deferrals (TransientClocks: HLD-54's anchor)
  notApplicable: ReadonlyArray<{ path: string; reason: NotApplicableReason }>;
  pendingFirstSeenMono: number | null; lastApplyMono: number | null; quietLeftMs: number | null;       // quietLeftMs = ChangeSets.quietLeftMs()
  cs: ReadonlyArray<CsTableEntry & { openAtStart: boolean }>;                                          // the CS table's rows (seat, human, recovered)
  groups: readonly PublicationGroup[]; heldPins: readonly HeldPin[];
  holds: ReadonlyArray<{ id: string; kind: HoldKind; residence: Residence; state: HoldState; guards: readonly string[]; paths: readonly string[];
    cs_ids: readonly string[]; local_only: boolean; ageMs: number }>;                                  // the hold registry's non-terminal rows (incl. INCOMING)
  // ---- Task 18 additions (contract addition 1; fields flowEntries needs that the list above lacks, additive) ----
  /** Governor.waitDetail() at this peer's rank in the newest fold: O6's estimate and its variant (FEAT-F14-13, 10-product §3.5.1 O6). */
  wait: WaitDetail;
  /**
   * The `in` paths whose writer is not known without reading a commit, which the query never does. (a) TIP moved after the last apply
   * (apply coalescing, a FREEZE, a kept push intent, no lease): the next admitted apply's trailer read moves them to incomingPaths.
   * (b) The newest commit an apply read for the path carried no valid Cowork-Writer: listed until a newer commit with one changes it.
   * (c) A not-applicable row pending since before this daemon started: the kept writers are memory only, and incomingBase leaves
   * not-applicable rows out of its walk, so an apply of this run reads its commit only when a deferred row's walk reaches back past
   * it, or when a newer commit changes the path; until then it stays here. A row that became not applicable during the run keeps its
   * writer across later applies (audit #25). Sorted.
   */
  incomingUnread: readonly string[];
  /**
   * Fix round 1 (finding 2: O2's input, the `out` domain's "dirty non-LIVE paths"): per path any other field names, its scope class and
   * not-shared reason (null for LIVE) as the engine classed it — a tracked or TIP path's from the newest prepared iteration's D5 scope
   * (core.ts flowScope), a new path the last tick did not admit with its D6 reason (cls NOT_ADMITTED), any other new path from that
   * scope too. A path the engine has not classed (no attributes requested for it: e.g. a seat effect's path never seen on disk) is not
   * listed. Sorted by path.
   */
  scopes: ReadonlyArray<{ path: string; cls: ScopeClass; reason: NotSharedReason | null }>;
}

const byPath = (a: { path: string }, b: { path: string }): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * The engine-side flow inputs of this moment (contract addition 1): see EngineFlowInputs. Every list is sorted by path (cs by cs_id,
 * groups by key, holds by id). Times are this PC's Δmono (INV-CLOCK); `setAtStart` marks an anchor set at this daemon's start (an
 * exclusion first seen by a detection tick the start ran, a meta.pending row the started state already held and that stayed pending
 * since), `openAtStart` a CS that was open when this daemon attached its first state. `paused` and `loopPeriodMs` are the Engine's own
 * (publishPauseOf over the inputs its status.json reads, the period it chose: core.ts attachFlowLoop); a core no Engine drives has none,
 * and this throws.
 */
export function buildFlowInputs(core: EngineCore): EngineFlowInputs {
  const clock = core.deps.ports.clock;
  const nowMono = clock.monoMs();
  const view = core.view;
  const meta = view?.meta ?? null;
  const fa = flowAnchors(core);
  if (fa.loop === null) throw new Error('buildFlowInputs: no Engine drives this core (attachFlowLoop)');
  const start = fa.start;
  const snap = core.snapshot.flowView();
  const lastFetch = core.fetcher.lastSuccessMono();

  const dirtyPaths = [...snap.dirty].map(([path, firstSeenMono]) => ({ path, firstSeenMono })).sort(byPath);
  const startTicks = start?.ticks ?? null;
  const exclusions = [...snap.excluded]
    .map(([path, e]) => ({ path, reason: e.reason as string, firstSeenMono: e.firstSeenMono, setAtStart: startTicks !== null && e.firstTick <= startTicks }))
    .sort(byPath);

  // meta.pending: the not-applicable rows (I2) and the deferrals (I3). A deferral's anchor (fix round 1, finding 7) is HLD-54's: the
  // clock of the current closure holding the path (TransientClocks, deferralAges), which restarts when the closure's path set changes
  // and whose 60 s create its INCOMING record; a path pending since this daemon started takes the start instead (the anchor restarts
  // at daemon start, FEAT-F14-14 — the run's first closure clock starts only at its first apply); a deferral no clock names yet (an
  // apply's deferral before its recordStep, or one outside any write group) takes this daemon's first sighting of its row.
  // pendingFirstSeenMono = the earliest anchor of the pending rows (a not-applicable row's: its first sighting).
  const pending = meta?.pending ?? {};
  const deferred: Array<EngineFlowInputs['deferred'][number]> = [];
  const notApplicable: Array<EngineFlowInputs['notApplicable'][number]> = [];
  const clockAges = deferralAges(core.transient);
  let pendingFirstSeenMono: number | null = null;
  for (const path of Object.keys(pending)) {
    const reason = pending[path]!;
    const seen = fa.pendingSeen.get(path) ?? nowMono;
    let first = seen;
    if (NOT_APPLICABLE_REASONS.has(reason)) {
      notApplicable.push({ path, reason: reason as NotApplicableReason });
    } else {
      const atStart = start !== null && start.pending.has(path);
      const age = clockAges.get(path);
      first = atStart ? start.mono : age !== undefined ? nowMono - age : seen;
      deferred.push({ path, reason, firstSeenMono: first, setAtStart: atStart });
    }
    pendingFirstSeenMono = pendingFirstSeenMono === null ? first : Math.min(pendingFirstSeenMono, first);
  }
  deferred.sort(byPath);
  notApplicable.sort(byPath);

  // The kept push intent: the paths of the ready pairs it names.
  const pushIntentPaths: Array<EngineFlowInputs['pushIntentPaths'][number]> = [];
  const intent = view?.intent ?? null;
  if (intent !== null && intent.kind === 'push') {
    const named = new Set(intent.cs_ids);
    const since = fa.push?.mono ?? nowMono;
    const paths = new Set<string>();
    for (const pair of core.cs.ready()) if (named.has(pair.csId)) for (const p of pair.paths) paths.add(p);
    for (const path of paths) pushIntentPaths.push({ path, sinceMono: since });
    pushIntentPaths.sort(byPath);
  }

  // A ≠ TIP: with the writer the applies' trailer reads kept (merged, audit #25) while TIP[p] is still the blob that read saw, else unread.
  const incomingPaths: Array<EngineFlowInputs['incomingPaths'][number]> = [];
  const incomingUnread: string[] = [];
  const tip = fa.tip;
  for (const path of incomingDifference(core)) {
    const w = fa.incoming.get(path);
    if (w !== undefined && (tip?.get(path)?.oid ?? ABSENT) === w.blob) incomingPaths.push({ path, writer: w.writer, name: w.name });
    else incomingUnread.push(path);
  }

  const pins = heldPins(core.holds);
  const fold = fa.fold;
  // A non-terminal record always has a residence (checkRecord's Table 1); only a terminal one has none.
  const holds = core.holds.nonTerminal().flatMap((r) => (r.residence === null ? [] : [{
    id: r.id, kind: r.kind, residence: r.residence, state: r.state, guards: r.guards.map((g) => g.name), paths: [...r.paths],
    cs_ids: [...r.cs_ids], local_only: r.local_only, ageMs: core.holds.ageMs(r),
  }]));
  const cs = core.cs.table().cs.map((e) => ({ ...e, openAtStart: start?.open.has(e.cs_id) === true }));
  const groups = core.cs.groupsView(pins);

  // O2's input: the class of every path named above (fix round 1, finding 2) — a new file the last tick did not admit by its D6 reason
  // (the tick lists only files outside the private index, every tick), any other path by the scope the engine classed it with; a path
  // the engine has not classed is left out.
  const named = new Set<string>();
  for (const list of [dirtyPaths, incomingPaths, pushIntentPaths, exclusions, deferred, notApplicable]) for (const x of list) named.add(x.path);
  for (const p of incomingUnread) named.add(p);
  for (const list of [cs, groups, pins, holds]) for (const x of list) for (const p of x.paths) named.add(p);
  const scopeOf = flowScope(core);
  const scopes: Array<EngineFlowInputs['scopes'][number]> = [];
  for (const path of [...named].sort()) {
    const refused = snap.notAdmitted.get(path);
    const s = refused !== undefined ? { cls: 'NOT_ADMITTED' as const, reason: refused } : scopeOf(path);
    if (s !== null) scopes.push({ path, cls: s.cls, reason: s.reason });
  }
  return {
    nowMono, loopPeriodMs: fa.loop.loopPeriodMs, tipHeight: fold?.height ?? null, fetchedAgeMs: lastFetch === null ? null : Math.max(0, nowMono - lastFetch),
    frozen: (meta?.freeze_reasons.length ?? 0) > 0, paused: fa.loop.paused, B: core.governor.effective().B,
    dirtyPaths, incomingPaths, pushIntentPaths, exclusions, deferred, notApplicable,
    pendingFirstSeenMono, lastApplyMono: core.lastApplyMono, quietLeftMs: core.cs.quietLeftMs(),
    cs, groups, heldPins: pins, holds,
    wait: core.governor.waitDetail(fold === null ? 1 : governorRank(fold, core.peerId)),
    incomingUnread, scopes,
  };
}

/**
 * Stage O9 (10-product §3.5.1): true when `path` is a member of an open seat CS that a non-terminal SHADOW record (a K1 PATCH held
 * OFF_DISK under a `claim` guard, shadowCsIds) names in its cs_ids. X-11's per-path form (Plan 7's draft named it hasShadow(csId); X-11
 * rules the path form, which Plan 7 calls per path). Memory only; the registry is read once per registry state (core.ts
 * flowRegistrySets, fix round 1 finding 8) and the CS table, tens of rows, per call — so a CS that closes with no registry write reads
 * fresh.
 */
export function hasShadow(core: EngineCore, path: string): boolean {
  const named = flowRegistrySets(core).shadowIds;
  if (named.size === 0) return false;
  return core.cs.table().cs.some((e) => e.kind === 'seat' && e.state === 'open' && named.has(e.cs_id) && e.paths.includes(path));
}
