// Plan 3 re-baseline (ruling R3-01, R3-66): every Plan 1/Plan 2 name of the Plan 3 contract's §Interfaces preamble that Plan 2
// Tasks 1–14 produce, plus the Plan 2 names Task 1's Consumes line adds, exists with the signature the Plan 2 contract (and its
// ledger rulings) states. The type assertions below are checked by `npm run typecheck` (tsconfig includes test/); a name that
// is missing or differs fails the build, which stops Task 1 for a controller ruling. The runtime part checks the Task 14 fix
// round's pathless host-reject PIN and the registry.cas crashpoint.
//
// Not checked by the first test (Task 2's first test, R3-01; the last two tests of this file check them, the R3-72 rounds): the names
// of Plan 2 Tasks 15–20 — Engine, EngineInspection, StatusInputs,
// computeStatus, restart, lostStateRebuild, startDispatch, runDaemon, DaemonArgs, realEngine, PROFILES, GeneratorProfile,
// exitOracles, makeEngines, Engine.resumeAfterNonretryable. Plan 1 names (Clock, Anchor, Random, ulid, Fs, crashpoint,
// KilledAt, seededRandom, VirtualClock, Oracle, SimContext) are "used as they are in the code" (Plan 2 contract preamble):
// their existence and the members Plan 3 calls are checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalBytes, type Json } from '../../src/board/canonicalJson.js';
import { buildBoardCommit, liveCommitTrailers, parseWriter, type BoardBuild, type CsTrailer, type WriterId } from '../../src/board/boardCommit.js';
import type { FoldedHold, FoldState, OwnRejection } from '../../src/board/fold.js';
import type { PeerId } from '../../src/board/ids.js';
import { eventCid, type EventKind, type EventOp, type OpDraft } from '../../src/board/ops.js';
import { Outbox, type PushState } from '../../src/board/outbox.js';
import { hashRouteB, type FilterFailure } from '../../src/data/blobRoutes.js';
import { canon, type CanonResult } from '../../src/data/canon.js';
import { form, hasRestoreMarkerRow, isBinaryBytes, rows, type Form } from '../../src/data/rows.js';
import { SECRET_LIKE_PATTERNS, type NotSharedReason, type Scope, type ScopeClass, type ScopeInputs } from '../../src/data/scope.js';
import { applyStep, type ApplyReport } from '../../src/engine/apply.js';
import { prePushAsserts, type AssertLetter, type PrePushInput } from '../../src/engine/assertions.js';
import { createEngineCore, pathIsFiltered, pathIsText, prepareIteration, type EngineCore, type IterationCtx, type PrepareOptions, type Prepared } from '../../src/engine/core.js';
import type { AttributionPort, EngineDeps, MutantId } from '../../src/engine/deps.js';
import { DiskEq } from '../../src/engine/diskEq.js';
import type { Meta } from '../../src/engine/meta.js';
import { publishStep, type PublishReport } from '../../src/engine/publish.js';
import { Snapshotter, type Exclusion, type Materialized, type TickInput, type TickResult } from '../../src/engine/snapshot.js';
import { StageDir, stagedRead, type ReadOutcome } from '../../src/engine/stagedRead.js';
import { StateStore, type StateView, type Transition } from '../../src/engine/state.js';
import { Writer, type WriteLocalResult } from '../../src/engine/writer.js';
import { mergeFile, mergeTree, type MergeFileOpts, type MergeFileResult, type MergeTreeResult } from '../../src/git/merge.js';
import { ABSENT, type Absent, type Oid, type OidOrAbsent } from '../../src/git/oid.js';
import { GitRepo, type CommitSpec, type MktreeEntry, type RunOpts, type TreeEntry, type TreeMap } from '../../src/git/repo.js';
import type { GitResult } from '../../src/git/runner.js';
import { writeGroups, type DeferReason, type IncomingCs, type WriteGroupsResult } from '../../src/holds/groups.js';
import {
  GUARD_TABLE, guardName, heldSide, isTerminal, makeGuard, parseRecord, serializeRecord, TERMINAL_STATES, WHOLE_PATH_GUARDS,
  type AgeAnchor, type BlobMap, type Guard, type HoldBlobs, type HoldKind, type HoldRecord, type HoldState, type Offer, type Residence,
} from '../../src/holds/record.js';
import { HoldRegistry, RegistryCasLostError } from '../../src/holds/registry.js';
import { anchorNow, elapsedMono, ownStaleness, suspendGapMs, SUSPEND_GAP_THRESHOLD_MS, type Anchor, type Clock } from '../../src/ports/clock.js';
import { crashpoint, KilledAt } from '../../src/ports/crashpoint.js';
import type { Fs } from '../../src/ports/fs.js';
import type { Log, LogLevel, LogParam } from '../../src/ports/log.js';
import { seededRandom, ulid, type Random } from '../../src/ports/random.js';
import type { Trace, TraceEvent } from '../../src/ports/trace.js';
import { validId, validPathSyntax } from '../../src/sec/validators.js';
import { makeCores } from '../helpers/coreFixture.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import type { Oracle, SimContext } from '../sim/harness.js';
import { TraceRecorder } from '../sim/traceRecorder.js';
import { VirtualClock } from '../sim/vclock.js';
// Plan 3 Task 2 (R3-01 second half, ruling R3-72): the Plan 2 Tasks 15–16 names on this base.
import { DISPLACED_CAP, type RecoverResult } from '../../src/engine/recover.js';
import {
  LOST_STATE_MAX_COMMITS, lostStateRebuild, OP_MARKERS, restart, StartRefused, type LostStateReport, type RestartReport,
} from '../../src/engine/restart.js';
import { startDispatch, type StartOptions, type StartResult } from '../../src/engine/start.js';
// The R3-72 follow-up round (F1 audit fix #27): the Plan 2 Tasks 17–20 names.
import { computeStatus, type StatusInputs, type StatusJson } from '../../src/engine/status.js';
import { Engine, type EngineInspection, type IterationReport } from '../../src/engine/loop.js';
import { runDaemon, type DaemonArgs, type DaemonIo } from '../../src/daemon/run.js';
import { makeEngines, type EngineFixture } from '../helpers/engineFixture.js';
import { realEngine, type RealEngineOptions } from '../sim/engineAdapter.js';
import { PROFILES, type GeneratorProfile } from '../sim/generators.js';
import { exitOracles } from '../sim/oracles.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

/** Exact type equality (both directions, including any/never). */
type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;
/** Compile-time only: a value of type T used where the contract's type C is required (T assignable to C). */
function as<C>(_v: C): void {}
const t = <T>(): T => undefined as unknown as T;

// ---- git layer (Plan 2 Task 2) ------------------------------------------------------------------------------------
const oidIsBranded: Equals<Oid extends string ? true : false, true> = true;
const absent: Equals<typeof ABSENT, 'ABSENT'> = true;
const oidOrAbsent: Equals<OidOrAbsent, Oid | Absent> = true;
as<{ path: string; mode: '100644' | '100755' | '120000' | '160000'; oid: Oid }>(t<TreeEntry>());
const treeMap: Equals<TreeMap, ReadonlyMap<string, TreeEntry>> = true;
as<(repo: GitRepo, current: OidOrAbsent, base: OidOrAbsent, other: OidOrAbsent, opts?: MergeFileOpts) => Promise<MergeFileResult>>(mergeFile);
const mergeFileResult: Equals<MergeFileResult, { rc: number; out: Buffer }> = true;
as<(repo: GitRepo, base: Oid, ours: Oid, theirs: Oid) => Promise<MergeTreeResult>>(mergeTree);
// The GitRepo members Task 1 calls (hashBytes, mktree, commitTree, casRef, readTreeMap, readBlobs, run).
as<(bytes: Buffer, write: boolean) => Promise<Oid>>(t<GitRepo['hashBytes']>());
as<(entries: readonly MktreeEntry[]) => Promise<Oid>>(t<GitRepo['mktree']>());
as<(c: CommitSpec) => Promise<Oid>>(t<GitRepo['commitTree']>());
as<(ref: string, next: Oid, prev: Oid | null, reason: string) => Promise<boolean>>(t<GitRepo['casRef']>());
as<(tree: Oid) => Promise<TreeMap>>(t<GitRepo['readTreeMap']>());
as<(oids: readonly Oid[]) => Promise<Buffer[]>>(t<GitRepo['readBlobs']>());
as<(args: string[], opts?: RunOpts) => Promise<GitResult>>(t<GitRepo['run']>());

// ---- ports (Plan 1 names as in the code; Plan 2 Task 1 additions) ---------------------------------------------------
as<{ monoMs(): number; wallMs(): number }>(t<Clock>());
// Anchor (Global Constraints "Time": every timer is a Δ from a local Anchor; anchorNow, elapsedMono, ownStaleness, suspendGapMs).
as<{ readonly mono: number; readonly wall: number }>(t<Anchor>());
as<(clock: Clock) => Anchor>(anchorNow);
as<(clock: Clock, a: Anchor) => number>(elapsedMono);
as<(clock: Clock, a: Anchor) => number>(ownStaleness);
as<(clock: Clock, a: Anchor) => number>(suspendGapMs);
as<number>(SUSPEND_GAP_THRESHOLD_MS);
as<(random: Random, clock: Clock) => string>(ulid);
as<(seed: string) => Random>(seededRandom);
as<(name: string) => void>(crashpoint);
as<new (name: string) => Error>(KilledAt);
as<{ readFile(p: string): Promise<Buffer>; mkdirp(p: string, mode?: number): Promise<void> }>(t<Fs>());
as<{ emit(ev: TraceEvent): void }>(t<Trace>());
as<{ write(level: LogLevel, code: string, params?: Readonly<Record<string, LogParam>>): void }>(t<Log>());
const json: Equals<Json, null | boolean | number | string | Json[] | { [k: string]: Json }> = true;
const peerId: Equals<PeerId, string> = true;
as<(v: Json) => Buffer>(canonicalBytes);
as<(kind: 'op' | 'ulid' | 'cs' | 'hex128', s: string) => boolean>(validId);
as<(p: string) => boolean>(validPathSyntax);

// ---- data (Plan 2 Tasks 3, 4, 6) ----------------------------------------------------------------------------------
const scopeClass: Equals<ScopeClass, 'LIVE' | 'SAVE_ONLY' | 'UNMANAGED' | 'QUARANTINED' | 'NOT_ADMITTED' | 'LOCAL_ONLY'> = true;
const scope: Equals<Scope, { cls: ScopeClass; reason: NotSharedReason | null }> = true;
as<{ localOnlyPaths: ReadonlySet<string>; hooksPathDir: string | null; mergeDrivers: ReadonlySet<string> }>(t<ScopeInputs>());
as<readonly string[]>(SECRET_LIKE_PATTERNS);
as<(blob: Buffer) => boolean>(hasRestoreMarkerRow);
as<(blob: Buffer) => boolean>(isBinaryBytes);
as<(blob: Buffer) => Buffer[]>(rows);
as<(blob: Buffer) => Form>(form);
as<(next: Buffer, ref: Buffer | null, skip: boolean) => CanonResult>(canon);
as<(repo: GitRepo, path: string, stageFile: string, write: boolean) => Promise<Oid | FilterFailure>>(hashRouteB);

// ---- board (Plan 2 Tasks 5, 7, 8) ---------------------------------------------------------------------------------
// Plan 3 Task 3 types FoldState.holds and widens OwnRejection.reason (Plan 3 contract, Board): pinned to exactly those types.
as<{ v: 1; height: number; holds: Record<string, FoldedHold>; record_count: number }>(t<FoldState>());
const ownRejection: Equals<OwnRejection['reason'], 'generic' | 'type' | 'prev_rev' | 'validator' | 'held_subtree' | 'local_only_stub'> = true;
const pushState: Equals<PushState, 'ok' | 'frozen' | 'incident' | 'config_net' | 'offline' | 'nonretryable' | 'version_proto' | 'version_board_only'> = true;
as<{ id: string; type: 'event'; cid: string; kind: EventKind; refs: string[]; reason_code: string }>(t<EventOp>());
as<(opId: string, kind: EventKind) => string>(eventCid);
as<OpDraft>(t<Omit<EventOp, 'id'>>());
as<{ add(draft: OpDraft): void; pendingAllowed(states: readonly PushState[]): boolean; toJson(): Json }>(t<Outbox>());
as<(j: Json) => Outbox>(Outbox.fromJson);
as<{ prevBoard: Oid | null; liveCode: Oid; writer: WriterId; cs: readonly CsTrailer[]; checkpoint: Buffer | null }>(t<BoardBuild>());
as<(repo: GitRepo, b: BoardBuild) => Promise<Oid>>(buildBoardCommit);
as<{ csId: string; state: 'closed' | 'checkpoint'; seq: number; origin: 'prompt' | 'wake' | 'human'; checks: 'pass' | 'fail' | 'skipped'; paths: number }>(t<CsTrailer>());
as<(writer: WriterId, seats: readonly string[], cs: readonly CsTrailer[], csPaths: ReadonlyMap<string, readonly string[]>, base: Oid | null) => unknown[]>(liveCommitTrailers);
as<(s: string) => WriterId | null>(parseWriter);

// ---- holds (Plan 2 Tasks 9, 11, 13) -------------------------------------------------------------------------------
const holdKind: Equals<HoldKind, 'PATCH' | 'PIN' | 'INCOMING'> = true;
const residence: Equals<Residence, 'ON_DISK' | 'OFF_DISK'> = true;
const holdState: Equals<HoldState, 'ACTIVE' | 'CONFLICTED' | 'PARKED' | 'SUBSUMED' | 'GONE' | 'RESOLVED_PUBLISH' | 'RESOLVED_DISCARD'> = true;
const offer: Equals<Offer, 'none' | 'pending_leftover' | 'offered' | 'accepted' | 'returned'> = true;
const blobMap: Equals<BlobMap, Record<string, OidOrAbsent>> = true;
const holdBlobs: Equals<HoldBlobs, { h0: BlobMap; h1: BlobMap } | { s1: BlobMap; s2: BlobMap; s3: BlobMap }> = true;
const guard: Equals<Guard, { name: string; class: 'PREDICATE' | 'DECISION'; owner: string }> = true;
const ageAnchor: Equals<AgeAnchor, { since_rev: number; anchor_wall_ms: number; mono_accum_ms: number }> = true;
const holdRecord: Equals<HoldRecord, {
  id: string; rev: number; owner: PeerId; kind: HoldKind; residence: Residence | null; state: HoldState; offer: Offer;
  declines: number; displaced_by: string | null; paths: string[]; blobs: HoldBlobs; guards: Guard[]; origin: string;
  cs_ids: string[]; peer_authors: string[]; local_only: boolean; age_anchor: AgeAnchor; proto: 1;
}> = true;
as<(r: HoldRecord) => BlobMap>(heldSide);
as<(r: HoldRecord) => boolean>(isTerminal);
as<(g: Guard) => string>(guardName);
as<ReadonlySet<string>>(WHOLE_PATH_GUARDS);
as<ReadonlySet<HoldState>>(TERMINAL_STATES);
as<(r: HoldRecord) => Buffer>(serializeRecord);
as<(buf: Buffer) => HoldRecord>(parseRecord);
as<{
  load(): Promise<void>; all(): readonly HoldRecord[]; nonTerminal(): readonly HoldRecord[];
  get(id: string): HoldRecord | undefined; maskingRecords(): readonly HoldRecord[];
}>(t<HoldRegistry>());
as<new (message?: string) => Error>(RegistryCasLostError);
as<(incoming: readonly IncomingCs[], applicable: ReadonlySet<string>, deferred: ReadonlyMap<string, DeferReason>) => WriteGroupsResult>(writeGroups);
const incomingCs: Equals<IncomingCs, { commit: Oid; csId: string; paths: string[] }> = true;

// ---- engine (Plan 2 Tasks 9, 10, 12, 13, 14) ------------------------------------------------------------------------
as<(fs: Fs, abs: string) => Promise<ReadOutcome>>(stagedRead);
as<{ write(path: string, bytes: Buffer): Promise<string>; abs(path: string): string; readonly root: string }>(t<StageDir>());
as<{ tick(inp: TickInput): Promise<TickResult>; materialize(inp: TickInput, only?: ReadonlySet<string>): Promise<Materialized>; last(): Materialized | null }>(t<Snapshotter>());
as<{ sRaw: Oid; sDisk: Oid; sRawMap: TreeMap; sDiskMap: TreeMap; canonRefused: ReadonlySet<string> }>(t<Materialized>());
as<{ dirty: ReadonlyMap<string, unknown>; changed: ReadonlySet<string>; excluded: ReadonlyMap<string, Exclusion>; failed: boolean; carried: ReadonlySet<string> }>(t<TickResult>());
const exclusion: Equals<Exclusion, 'unreadable' | 'unstable' | 'filter_failure' | 'shrink' | 'deletion_pending' | 'quiet'> = true;
as<{ eq(path: string, x: TreeEntry | Absent, sRaw: TreeEntry | null): Promise<unknown> }>(t<DiskEq>());
as<{
  writeLocal(path: string, expected: OidOrAbsent, target: Oid | 'DELETE', origin: string, humanEvidence?: boolean): Promise<WriteLocalResult>;
  writeLocalGroup(entries: ReadonlyArray<{ path: string; expected: OidOrAbsent; target: Oid | 'DELETE' }>, origin: string, humanEvidence?: boolean): Promise<WriteLocalResult>;
  strandedPaths(): string[];
}>(t<Writer>());
const writeLocalResult: Equals<WriteLocalResult,
  | { kind: 'WRITTEN' } | { kind: 'MISMATCH'; found: OidOrAbsent } | { kind: 'LOCKED' } | { kind: 'COLLISION' }
  | { kind: 'FROZEN' } | { kind: 'DEFERRED'; reason: DeferReason } | { kind: 'PHANTOM' }> = true;
as<{ commit(prev: StateView, t: Transition): Promise<StateView>; read(): Promise<StateView | null> }>(t<StateStore>());
as<{ commit: Oid; laC: Oid; laB: Oid; base: Oid; snap: Oid; meta: Meta; keep: ReadonlyMap<string, Oid>; fold: FoldState | null }>(t<StateView>());
as<Transition>(t<{ laC?: Oid; snap?: Oid; meta?: Meta; keep?: ReadonlyMap<string, Oid> }>());
as<{ EPOCH_BASE: Oid; pending: Record<string, DeferReason>; nonretryable: null | { lease: Oid; hold_id: string }; cs_human_next: number }>(t<Meta>());
as<{ view: StateView | null; holds: HoldRegistry; repo: GitRepo; deps: EngineDeps; commit(t: Transition): Promise<StateView> }>(t<EngineCore>());
as<{ n: number; tip: Oid; tipMap: TreeMap; A: TreeMap; epochBase: Oid; scopeInputs: ScopeInputs; scope(path: string): Scope; mat: Materialized | null }>(t<IterationCtx>());
as<(deps: EngineDeps) => Promise<EngineCore>>(createEngineCore);
as<(core: EngineCore, n: number, o: PrepareOptions) => Promise<Prepared>>(prepareIteration);
as<(core: EngineCore, p: string) => boolean>(pathIsText);
as<(core: EngineCore, p: string) => boolean>(pathIsFiltered);
as<{ ran: boolean; written: string[]; deleted: string[]; deferred: Map<string, DeferReason>; records: string[]; cancelled: string[] }>(t<ApplyReport>());
as<(core: EngineCore, it: IterationCtx) => Promise<ApplyReport>>(applyStep);
as<{ attempted: boolean; why: string | null; bnew: Oid | null; c: Oid | null; records: string[] }>(t<PublishReport>());
as<(core: EngineCore, it: IterationCtx) => Promise<PublishReport>>(publishStep);
as<{ T: OidOrAbsent; tip: Oid; P: TreeMap; scope: (p: string) => ScopeClass; masked: (p: string) => boolean; heldAdded: ReadonlyArray<{ holdId: string; path: string; oid: Oid; localOnly: boolean; live: boolean }> }>(t<PrePushInput>());
as<(inp: PrePushInput) => Promise<{ ok: true } | { ok: false; letter: AssertLetter; path: string | null }>>(prePushAsserts);
// deps.ts before Task 1 widens it (the widened members are Task 1's own test, trace.p3 / deps).
as<{ removalAttributed(path: string): boolean; shrinkAttributed(path: string): boolean }>(t<AttributionPort>());
as<MutantId>('M05');
as<MutantId>('M20');

// ---- test helpers (Plan 1 / Plan 2 Task 13) -----------------------------------------------------------------------
as<(label: string, opts?: { files?: Record<string, Buffer>; autocrlf?: boolean; filter?: boolean }) => Promise<RepoFixture>>(makeRepoFixture);
as<(label: string, opts: { n: number; files?: Record<string, Buffer>; autocrlf?: readonly boolean[]; seed?: string; mutants?: ReadonlySet<MutantId> }) => Promise<unknown>>(makeCores);
as<{ emit(ev: TraceEvent): void; readonly events: readonly TraceEvent[]; ofKind<K extends TraceEvent['kind']>(kind: K): Array<Extract<TraceEvent, { kind: K }>> }>(new TraceRecorder());
as<Clock>(new VirtualClock());
as<{ advance(ms: number): void }>(new VirtualClock());
as<Oracle | SimContext | null>(null);

const typeLevel = [
  oidIsBranded, absent, oidOrAbsent, treeMap, mergeFileResult, json, peerId, scopeClass, scope, ownRejection, pushState,
  holdKind, residence, holdState, offer, blobMap, holdBlobs, guard, ageAnchor, holdRecord, incomingCs, exclusion, writeLocalResult,
];

const PEER = '0123456789abcdef0123456789abcdef';

function pinRecord(guards: Guard[], paths: string[]): HoldRecord {
  const h: BlobMap = {};
  for (const p of paths) h[p] = ABSENT;
  return {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', rev: 1, owner: PEER, kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', offer: 'none',
    declines: 0, displaced_by: null, paths, blobs: { h0: { ...h }, h1: { ...h } }, guards, origin: 'daemon',
    cs_ids: [], peer_authors: [], local_only: false, age_anchor: { since_rev: 1, anchor_wall_ms: 0, mono_accum_ms: 0 }, proto: 1,
  };
}

test('every Plan 2 name of Tasks 1–14 the Plan 3 contract cites exists with its cited signature', T10, () => {
  // Type level: the assertions above compiled (npm run typecheck); each const is `true` by construction.
  assert.ok(typeLevel.every((x) => x === true));

  // The Task 14 fix round's pathless host-reject PIN loads; paths [] with any other guard is refused.
  const hostReject: Guard = { name: 'host-reject', class: 'DECISION', owner: 'ENG' };
  const ok = pinRecord([hostReject], []);
  assert.deepEqual(parseRecord(serializeRecord(ok)), ok);
  assert.equal(parseRecord(canonicalBytes(ok as unknown as Json)).origin, 'daemon');
  const others = GUARD_TABLE.filter((r) => r.name !== 'host-reject')
    .map((r) => makeGuard(r.name === 'claim' ? 'claim:abcdefghij234567' : r.name === 'dependency' ? 'dependency:01ARZ3NDEKTSV4RRFFQ69G5FAV' : r.name));
  assert.equal(others.length, GUARD_TABLE.length - 1);
  for (const other of others) {
    assert.throws(() => serializeRecord(pinRecord([other], [])), TypeError, `paths [] with ${other.name}`);
    assert.throws(() => parseRecord(canonicalBytes(pinRecord([other], []) as unknown as Json)), TypeError, `paths [] with ${other.name}`);
  }

  // Anchor at run time: the Δs of Global Constraints "Time" on a virtual clock.
  const vc = new VirtualClock();
  const a = anchorNow(vc);
  vc.advance(1_500);
  assert.deepEqual([elapsedMono(vc, a), ownStaleness(vc, a), suspendGapMs(vc, a)], [1_500, 1_500, 0]);
  assert.equal(SUSPEND_GAP_THRESHOLD_MS, 5_000);

  // test/crashpoints.json lists registry.cas (HLD-01's two call sites, one name).
  const names = JSON.parse(readFileSync(join(process.cwd(), 'test', 'crashpoints.json'), 'utf8')) as string[];
  assert.ok(names.includes('registry.cas'));
});

// ---- Plan 3 Task 2: the re-baseline's second half (R3-01), Plan 2 Tasks 15–16 on this base (ruling R3-72) ----------------
// Each name as the Plan 2 controller contract.md states it (its text wins over the plan doc, Plan 3 contract header).
as<(core: EngineCore, opts: StartOptions) => Promise<StartResult>>(startDispatch);
as<{ publishLocal: 'all' | 'none' | null }>(t<StartOptions>());
as<(core: EngineCore) => Promise<RestartReport>>(restart);
as<(core: EngineCore, T: Oid, mode: 'lost_state' | 're_anchor', paths?: ReadonlySet<string>, metaOverrides?: Partial<Meta>) => Promise<LostStateReport>>(lostStateRebuild);
as<{ mode: 'lost_state' | 're_anchor'; records: string[]; paths: string[] }>(t<LostStateReport>());
as<{ ok: true; done: boolean } | { ok: false; code: string }>(t<RecoverResult>());

test('every Plan 2 name of Tasks 15–16 the Plan 3 contract cites exists with its cited signature', T10, () => {
  // Type level: the assertions above compiled (npm run typecheck). Run time: the declared parameter lists (a dropped or added
  // parameter changes Function.length; lostStateRebuild keeps its five, Plan 3 preflight "Task 8 keeps lostStateRebuild's 5
  // parameters") and the Plan 2 constants the Plan 3 Global Constraints quote.
  assert.deepEqual([startDispatch.length, restart.length, lostStateRebuild.length], [2, 1, 5]);
  assert.equal(LOST_STATE_MAX_COMMITS, 500, 'lost-state rebuild reads ≤ 500 first-parent commits');
  assert.equal(DISPLACED_CAP, 3, '≤ 3 displaced refs per branch');
  // The operation markers restart refuses on (START_HEAD_STATE) and the error it refuses with.
  assert.deepEqual([...OP_MARKERS].sort(), ['BISECT_LOG', 'CHERRY_PICK_HEAD', 'MERGE_HEAD', 'REBASE_HEAD', 'REVERT_HEAD', 'rebase-apply', 'rebase-merge', 'sequencer']);
  assert.ok(Object.isFrozen(OP_MARKERS));
  const refused = new StartRefused('START_HEAD_STATE', { op: 'MERGE_HEAD' });
  assert.deepEqual([refused.name, refused.code, refused.params], ['StartRefused', 'START_HEAD_STATE', { op: 'MERGE_HEAD' }]);
});

// ---- the R3-72 follow-up round (F1 audit fix #27): Plan 2 Tasks 17–20 on this base ------------------------------------------
// Plan 2 Tasks 17–20 merged into Plan 3 long ago; these assertions are the Task 2 RED file kept at wip/p3-t2-backup b2d9201
// (test/unit/p3-baseline-engine.test.ts), with the two Plan 3 widenings that file predates: DaemonArgs.cmd gained 'resolve'
// (Plan 3's /cowork resolve) and PROFILES gained 'holds' (Plan 3 Task 16). Plan 2 Task 17's eol-bom record suite is not re-run here:
// it is test/integration/loop.test.ts's eol-bom tests (npm test runs them with the widened registry). The second placeholder, "the
// literal grep over Plan 2 Tasks 17–20 for each constructor literal a Plan 3 task widens", is dropped (ruling in the F1 G4 report):
// its job was to route each widening to an owning task at dispatch time; every Plan 3 task has landed, so there is no dispatch left to
// route, and the type-check still fails on a literal that misses a required field.
as<(i: StatusInputs) => StatusJson>(computeStatus);
as<{ refused: { code: string; params: Record<string, Json> } | null; notConverged: readonly string[] }>(t<StatusInputs>());
as<(deps: EngineDeps) => Promise<Engine>>(Engine.create);
as<{
  readonly peerId: PeerId; readonly core: EngineCore;
  start(opts: StartOptions): Promise<StartResult>; iterate(): Promise<IterationReport>; done(): void; requestFreshFetch(): void;
  recover(confirm: string | null): Promise<RecoverResult>; resumeAfterNonretryable(): Promise<boolean>; inspect(): Promise<EngineInspection>;
  drain(downCode: 'IDLE_NO_SESSION' | null): Promise<void>; readonly drained: boolean;
}>(t<Engine>());
as<{ peerId: PeerId; laC: Oid; laB: Oid; aTree: Oid; snapTree: Oid; epochBase: Oid; pending: Record<string, DeferReason>; notConverged: string[]; holds: HoldRecord[]; pushAttempts: number; status: StatusJson }>(t<EngineInspection>());
as<(args: DaemonArgs, env: Readonly<Record<string, string | undefined>>, io: DaemonIo) => Promise<number>>(runDaemon);
as<{ cmd: 'run' | 'recover' | 'resume' | 'resolve'; repo: string; branch: string; publish: 'all' | 'none' | null; name: string | null; remote: string | null; confirm: string | null; id: string | null; verb: string | null; dataDir: string | null; pluginRoot: string | null; spawned: boolean }>(t<DaemonArgs>());
const daemonCommand: Equals<DaemonArgs['cmd'], 'run' | 'recover' | 'resume' | 'resolve'> = true;
as<(label: string, opts: { n: number; files?: Record<string, Buffer>; autocrlf?: readonly boolean[]; seed?: string; mutants?: ReadonlySet<MutantId> }) => Promise<EngineFixture>>(makeEngines);
as<(opts?: RealEngineOptions) => unknown>(realEngine);
as<Readonly<Record<'edits' | 'faults' | 'holds', GeneratorProfile>>>(PROFILES);
as<() => Oracle[]>(exitOracles);
as<{ phase: 'ops' | 'quiescence' | 'extra' }>(t<SimContext>());

test('every Plan 2 name of Tasks 17–20 the Plan 3 contract cites exists with its cited signature (R3-72 follow-up round)', T10, () => {
  // Type level: the assertions above compiled (npm run typecheck). Run time: what a type cannot show.
  assert.equal(daemonCommand, true);
  assert.equal(typeof Engine.create, 'function');
  assert.equal(typeof Engine.prototype.resumeAfterNonretryable, 'function', 'R-28, R3-39');
  assert.equal(exitOracles().length, 6, 'exitOracles() without holds is Plan 2\'s six');
  assert.deepEqual(Object.keys(PROFILES).sort(), ['edits', 'faults', 'holds']);
  assert.deepEqual([computeStatus.length, runDaemon.length, makeEngines.length], [1, 3, 2]);
});
