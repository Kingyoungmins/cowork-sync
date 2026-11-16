// src/claude/daemon/claudeDaemon.ts — the composition root (06 §3.17; R5-02, R5-19). It declares the port and binding
// types (ClaudeBindings and its twelve ports), Plan 5's default binding set (plan5Bindings), and createClaudeDaemon: the
// one DaemonCtx, the engineDeps the Engine is built with, the re-callable attach that binds every engine-bound member to
// the Engine run.ts started (C-ATTACH), the 1 s ticker loop, and close (a version drain ends in requestStop, C-STOP).
// Every neutral binding is R5-55 (never throws); the two composition slots (outboxCoordSlot, plan3RevertViewSlot) and the
// ports whose task has not landed throw Error('Plan 5 Task <owning task>') on a call.
import type { Json } from '../../board/canonicalJson.js';
import type { DeferReason } from '../../holds/groups.js';
import type { Hunk, Granularity, Ranges, Label } from '../../regions/types.js';
import type { RevertView } from '../../holds/revertCs.js';
import type { Oid } from '../../git/oid.js';
import type { LastCheck } from '../../holds/lastCheck.js';
import type { PeerId } from '../../board/ids.js';
import type { CarrierItem } from './carriers.js';
import type { WakePolicy } from './ring.js';
import type { WakeScopePort } from './wakeScope.js';

// X-38: Plan 5 owns the mechanics (carriers, caps, slots, metering, delivery, turn origin, nonce, ringing); Plan 6 owns
// content and decisions and reaches seats only through these ports, bound in its one file src/coord/adapters/claude.ts —
// bindClaude(coordinator, ctx: DaemonCtx): Partial<ClaudeBindings> (coordTools, coordHooks, wakeScope, wakePolicy,
// digest, slotExtra, dueRequests). X-111: the daemon composes ClaudeBindings = {...plan5Bindings(o), ...bindClaude
// (coordinator, ctx) (Plan 6), ...Plan 7's noteScan/flow/wrap bindings} in src/daemon/run.ts (SIM:
// test/sim/engineAdapter.ts; tests: test/helpers/seatHarness.ts); each plan edits only its own line.
export interface ClaudeBindings { regions: RegionsPort; wakeScope: WakeScopePort; wakePolicy: WakePolicy; coordTools: CoordToolsPort; coordHooks: CoordHooksPort;
  digest: DigestPort; slotExtra: SlotExtraPort | null; dueRequests: DueRequestsPort; flow: FlowPort; wrap: WrapPort; noteScan: NoteScanPort; revertView: RevertViewPort; }

/** V-10 (O-16): renamed from K1DenyInput — the port's input is no longer the same shape as Plan 6's Coordinator
 *  K1DenyInput (one name per shape); Plan 6's bindClaude maps a K1DenyHookInput to its K1DenyInput. */
export interface K1DenyHookInput { seat: string; agent: string; toolUseId: string; turnId: string; path: string; claimId: string; holdId: string; newRecord: boolean;
  holders: ReadonlyArray<{ peer: PeerId; seat: string; claimId: string; sibling: boolean; siblingClaimOpKey: string | null }>;
  hunksInBase: readonly Hunk[]; }   // V-10 (Plan 6's O-16): the denied edit's PredictResult.hunksInBase. wholeFileCause and whitespaceOnly are not port fields (Plan 5 cannot
                                    // compute them: they are Plan 6's adapter helpers, X-24); Plan 6's bindClaude fills them from hunksInBase, its claim view and the live tree
                                    // into its own Coordinator input before composing the deny
export interface K2Input { seat: string; agent: string; toolUseId: string; csId: string; holdId: string; claimIds: readonly string[]; holders: K1DenyHookInput['holders']; foldedAtPre: boolean; }
export interface ReadInput { seat: string; agent: string; path: string; read: { offset?: number; limit?: number; full: boolean; enoent: boolean; size: number }; viewBlob: Oid; lineCount: number; }
export interface CoordHooksPort {
  onK1Deny(i: K1DenyHookInput): Promise<{ items: CarrierItem[]; cid: string; rid: string; creationOpId: string } | null>;   // after the K1 pre-record is written (CCI-18), before the G1 reply
  onK2(i: K2Input): Promise<CarrierItem[]>;                                                                         // after the K2 PIN exists, before the block reply
  onUserPromptSubmit(seat: string, p: { promptId: string; nonces: readonly string[]; midTurn: boolean }): void;     // after TurnOrigin classified the prompt (CCI-37)
  onLeaseLost(seat: string): void;                                                                                  // the seat's lease is no longer valid (R5-35)
  onRead(i: ReadInput): void;                                                                                       // PostToolUse(Read) of a LIVE path (F05)
  grantPaused(seat: string, claimId: string): boolean;                                                              // the G1 GRANT_PAUSE row (13b)
}
/** R5-55 (neutral, never throws): every call a no-op — onK1Deny → null, onK2 → [], the others void, grantPaused → false. */
export const noCoordHooks: CoordHooksPort = Object.freeze({
  onK1Deny: async (): Promise<{ items: CarrierItem[]; cid: string; rid: string; creationOpId: string } | null> => null,
  onK2: async (): Promise<CarrierItem[]> => [],
  onUserPromptSubmit: (): void => undefined,
  onLeaseLost: (): void => undefined,
  onRead: (): void => undefined,
  grantPaused: (): boolean => false,
});

/** X-39: Plan 5's MCP-tools port (renamed from CoordPort) with exactly Plan 6's CoordTools members and result; ToolCtx
 *  and ToolResult are structural copies of Plan 6's (pinned equal by a type-level test once Plan 6 lands). */
export type ToolCtx = { seat: string; agent: string; turnOrigin: 'human' | 'wake' | null; lang: ClaudeLang };
export type ClaudeLang = 'en' | 'ko';
export type ToolResult = { ok: true; text: string; queued?: string } | { ok: false; code: string; text: string };   // ≤ 400 chars, cowork_show ≤ 8,000
export interface CoordToolsPort {
  request(c: ToolCtx, a: { rid: string; mode: 'handoff' | 'go_first'; est_minutes?: number; note?: string }): Promise<ToolResult>;
  respond(c: ToolCtx, a: { rid: string; verb: 'accept' | 'decline' | 'later' | 'release'; note?: string }): Promise<ToolResult>;
  note(c: ToolCtx, a: { text: string }): Promise<ToolResult>;
  release(c: ToolCtx, a: { claim_id: string }): Promise<ToolResult>;                    // 'all' allowed; over RegionsPort.releaseClaims (X-22)
  show(c: ToolCtx, a: { id: string | readonly string[] }): Promise<ToolResult>;          // never isError; Plan 5's binding accepts one string (R5-08), Plan 6 widens
  status(c: ToolCtx): Promise<ToolResult>;                                               // never isError
}
/** X-51: Plan 5's note/status scan port (X-51); the scanner itself (scanSecrets, scanHit, scanD2) is Plan 7's alone. */
export interface NoteScanPort { scan(text: string, kind: 'note' | 'status'): Promise<{ available: boolean; hit: boolean }>; }

/** X-74: Plan 7 binds it (its stage table and rendering are Plan 7's, X-11). */
export interface FlowPort { entries(claude: ClaudeFlowInputs, selector: FlowSelector, max: number): { entries: FlowEntryWire[]; omitted: number }; }
export type FlowSelector = { all: true; detail: 'section' | 'flow' } | { path: string };
export interface FlowEntryWire { path: string; dir: 'out' | 'in'; stage: string; code: string; params: Params; }
export type Params = Readonly<Record<string, string | number | null>>;
/** X-11: Plan 5's daemon half of the F14 inputs (seats, defer tags, the TXN-open instant, edit checks in flight); the
 *  engine half is Plan 3 Task 18's Engine.flowInputs(). */
export interface ClaudeFlowInputs {
  seats: ReadonlyArray<{ seatId: string; number: number; activity: SeatActivity; pullMode: boolean; fullReadSet: readonly string[]; lastApplyIntoReadSetMono: number | null }>;
  defer: ReadonlyMap<string, DeferTag>; txnOpenSinceMono: number | null;
  editChecks: ReadonlyArray<{ csId: string; seatNumber: number; editN: number; inFlight: number | null; waiting: number | null }>;
  lastCheck: (csId: string) => LastCheck | null; lastPass: (csId: string) => { ready: number | null; shared: number | null };
}
export type SeatActivity = 'IDLE' | 'ENDED' | 'MID_TURN' | 'AWAITING_PERMISSION';
export type DeferTag = { path: string; reason: DeferReason; source: DeferSource; seatNumber: number | null; sinceMono: number; lastApplyIntoReadSetMono: number | null };
export type DeferSource = 'fence' | 'read_lease' | 'txn' | 'conflicted_leased' | 'degraded' | 'coalesce_mid_turn' | 'coalesce_pull_mode';

/** Plan 7 (F12): its wrapHandler body becomes this binding (X-57). V-16: a Promise, because Plan 7's producer reads git
 *  within ATTRIBUTION_BUDGET_MS. */
export interface WrapPort { rows(caller: { seatKey: string | null }): Promise<Json>; }
/** Plan 6 (COO-13, COO-26); markAsked when the block's batch is DELIVERED. */
export interface DueRequestsPort { dueRequests(seatId: string): AskRef[]; markAsked(asks: readonly AskRef[]): void; }
export type AskRef = { reqId: string; toHolderSeat: string; attempt: number; rid: string; label: string; requester: string; mode: 'go_first' | 'handoff' };
/** X-09: RevertView is declared by Plan 3 Task 17 in src/holds/revertCs.ts and imported here — no local copy. */
export interface RevertViewPort { view(csId: string): Promise<RevertView>; }

// Structural copies of Plan 4's (X-20; Task 18's type-level test pins Plan 4's exports assignable to them).
export interface DiskSnapshotIdCopy { readonly kind: 'disk'; readonly path: string; readonly oid: Oid; }   // 04 §2
export type BlobRefCopy = Oid | DiskSnapshotIdCopy;
export interface SeatKeyCopy { readonly peer: PeerId; readonly seat: string; }   // seat = a seat_id (32 hex) or 'human'
export interface ClaimLabelCopy { readonly kind: string; readonly qualname: string; readonly simple: string; readonly type: string; readonly disc: string; }
export interface ClaimGrantCopy { readonly req_id: string; readonly grantee: { peer: string; epoch: string; seat: string }; readonly cs_id: string; readonly since_height: number; }
export interface ViewClaimCopy { readonly claimId: string; readonly path: string; readonly holder: SeatKeyCopy & { readonly epoch: string; readonly agent: string };
  readonly granularity: Granularity; readonly label: ClaimLabelCopy; readonly regionSpec: string; readonly csId: string; readonly source: unknown;   // source: Plan 4's ClaimSource
  readonly order: { readonly tier: 0 | 1; readonly a: number; readonly b: number }; readonly grant: ClaimGrantCopy | null; readonly reservedForReq: string | null; }
export interface ClaimViewCopy { readonly tip: Oid; readonly claims: readonly ViewClaimCopy[]; }
export interface TurnContextCopy { readonly origin: 'prompt' | 'wake'; readonly firstConfirmedInTurn: ReadonlySet<string>; }
export interface PredictQueryCopy { readonly seat: string; readonly agent: string; readonly tool: 'Edit' | 'MultiEdit' | 'Write' | 'NotebookEdit'; readonly input: Json; readonly path: string;
  readonly disk: DiskSnapshotIdCopy | 'unstable'; readonly viewBlob: BlobRefCopy | null; readonly turn: TurnContextCopy; }
export interface PredictResultCopy { readonly status: 'located' | 'locate_failed' | 'undecided';
  readonly diskLines: Ranges;
  readonly hunksInBase: readonly Hunk[]; readonly touches: ReadonlyArray<{ readonly claimId: string; readonly reason: string }>;
  readonly moved: { readonly fromLabel: Label; readonly toLabel: Label | 'TOMBSTONE' } | null; readonly fallbackUsed: boolean;
  readonly ownTouches: ReadonlyArray<{ readonly claimId: string; readonly suspect: boolean; readonly granted: boolean }>; readonly ownContained: boolean; }
export interface DraftCopy { readonly claimId: string; readonly seat: SeatKeyCopy; readonly agent: string; readonly csId: string; readonly path: string; readonly srcBlob: BlobRefCopy;
  readonly srcRanges: Ranges; readonly granularity: Granularity; readonly label: ClaimLabelCopy; readonly confirmSeq: number; }
export interface SeatEffectCopy { readonly seat: string; readonly agent: string; readonly csId: string; readonly path: string; readonly pre: BlobRefCopy | 'ABSENT';
  readonly post: DiskSnapshotIdCopy | 'unstable' | 'ABSENT'; readonly secondRead?: DiskSnapshotIdCopy; readonly turn: TurnContextCopy; readonly viewAtOpen?: ClaimViewCopy; }
export interface ConfirmResultCopy { readonly status: 'confirmed' | 'deferred'; readonly hunksInBase: readonly Hunk[];
  readonly touches: ReadonlyArray<{ readonly claimId: string; readonly holder: SeatKeyCopy; readonly reason: string }>; readonly drafts: readonly DraftCopy[]; readonly notOwnContained: readonly Hunk[]; }
export type ReleaseReasonCopy = 'explicit' | 'answer' | 'save' | 'seat_end' | 'stop' | 'reservation_transfer';   // Plan 4's; Plan 5 uses explicit, seat_end, stop

/** The Plan 4 port (04 §3.1, REG-19, REG-28…REG-35). X-20: Plan 4's API is the contract; the port carries Plan 4's
 *  member and field names verbatim, and the types are structural copies of Plan 4's so Plan 5 compiles before Plan 4
 *  merges; Task 18's type-level test pins Plan 4's exports assignable to them. */
export interface RegionsPort {
  predict(q: PredictQueryCopy): Promise<PredictResultCopy>;   // REG-28 (normalized locate), Plan 4's Engine.predict
  seatEffect(e: SeatEffectCopy): Promise<ConfirmResultCopy>;   // REG-29, REG-33 (Plan 4's Engine.seatEffect)
  claimView(): ClaimViewCopy | null;                           // glossary §3; null before the first fold
  claimViewOf(reader: SeatKeyCopy): readonly ViewClaimCopy[];   // the F05 reader view
  mapRanges(from: BlobRefCopy, to: BlobRefCopy, ranges: Ranges, mode: 'local'): Promise<Ranges | 'TOMBSTONE' | 'WHOLE_FILE'>;   // Plan 4's RegionService.mapRanges, local mode
  verifiedLabel(claimId: string, anchor: Oid): ClaimLabelCopy | null;   // cache only (REG-34); never triggers a parse
  claimNotes(claimId: string, against?: BlobRefCopy | 'ABSENT'): Promise<ReadonlyArray<{ code: string; params: Params }>>;
  releaseClaims(holder: SeatKeyCopy, reason: ReleaseReasonCopy, target: readonly string[] | 'all'): { drafts: readonly DraftCopy[]; refused: ReadonlyArray<{ claimId: string; why: 'not_own' | 'unlanded' }> };
}

/** X-23: Plan 4's one label display helper ('?' for null); a structural copy with the same rule until Task 18
 *  re-exports src/claims/labels.ts's. Pure. */
export function claimLabelText(l: ClaimLabelCopy | null): string {
  return l === null ? '?' : l.simple;
}

// ---- Plan 5 default bindings (R5-05, R5-08…R5-11, R5-37, R5-42, R5-53; X-39, X-40, X-51) ------------------------------------
// The bindings live with their owning concern modules and the composition re-exports them here; plan5Bindings assembles
// the set: the never-throwing ones (noCoordHooks above, plus the module-owned noRegions, plan5WakeScope, neverRing,
// codeOnlyDigest, noDueRequests, noFlowEntries, noWrap, unavailableScan / canaryScan) and the two composition slots below.
import { noRegions } from './regions.js';
import { plan5WakeScope } from './wakeScope.js';
import { neverRing } from './ring.js';
import { codeOnlyDigest, dropDigestSeat, type DigestPort, type SlotExtraPort } from './carriers.js';
import { noDueRequests } from './stop.js';
import { noFlowEntries, noWrap } from './flow.js';
import { unavailableScan, canaryScan, outboxCoord } from './mcpTools.js';
import { plan3RevertView } from './undoView.js';
import type { DaemonCtx } from './ctx.js';

export { noRegions, plan5WakeScope, neverRing, codeOnlyDigest, noDueRequests, noFlowEntries, noWrap, unavailableScan, canaryScan, plan3RevertView };
export type { DigestPort, SlotExtraPort };

/** F2 #41 (Ruling): the composition slot of coordTools. plan5Bindings has no ctx, so it returns this frozen port and
 *  createClaudeDaemon binds it to outboxCoord(ctx) (R5-10) at composition; every call throws Error('Plan 5 Task 14'),
 *  as outboxCoord's stub does (A5-5). */
export const outboxCoordSlot: CoordToolsPort = Object.freeze({
  request: slotRefuse, respond: slotRefuse, note: slotRefuse, release: slotRefuse, show: slotRefuse, status: slotRefuse,
}) as unknown as CoordToolsPort;
/** F2 #41 (Ruling): the composition slot of revertView, bound to plan3RevertView(core) at every attach; view() rejects
 *  with Error('Plan 5 Task 14'), as plan3RevertView's stub does. */
export const plan3RevertViewSlot: RevertViewPort = Object.freeze({
  view: async (): Promise<never> => slotRefuse(),
});
function slotRefuse(): never { throw new Error('Plan 5 Task 14'); }

/** R5-53 (plan:1299-1301): Plan 5's default binding set, exactly the twelve ClaudeBindings members (scriptedRing only in
 *  SIM/FakeHost). slotExtra is null until Plan 6 binds it; noteScan is unavailableScan in production builds, canaryScan in
 *  test builds (X-51); coordTools and revertView are the composition slots, which createClaudeDaemon binds to
 *  outboxCoord(ctx) (R5-10) and plan3RevertView(core) — the plan's "outboxCoord … plan3RevertView" name the bound result.
 *  X-111: {...plan5Bindings(o), ...partial} replaces only the members `partial` names. */
export function plan5Bindings(o: { testBuild: boolean }): ClaudeBindings {
  return {
    regions: noRegions,
    wakeScope: plan5WakeScope,
    wakePolicy: neverRing,
    coordTools: outboxCoordSlot,
    coordHooks: noCoordHooks,
    digest: codeOnlyDigest,
    slotExtra: null,
    dueRequests: noDueRequests,
    flow: noFlowEntries,
    wrap: noWrap,
    noteScan: o.testBuild ? canaryScan : unavailableScan,
    revertView: plan3RevertViewSlot,
  };
}

// ---- Phase 3a-1: the composition root (06 §3.17; A5-5, A5-11, A5-12, A5-14) ------------------------------------------------
import { join } from 'node:path';
import { machineMonoMs } from '../../ports/clock.js';
import { errnoCode } from '../../ports/fs.js';
import type { GitRepo } from '../../git/repo.js';
import type { CsSignal } from '../../holds/signals.js';
import { readUserJson } from '../wire/pluginData.js';
import { HOOK_PROTO } from '../wire/frames.js';
import type { LiveRepo } from '../../data/canonRoot.js';
import type { Log } from '../../ports/log.js';
import type { SecurityLog } from '../../sec/securityLog.js';
import type { Engine } from '../../engine/loop.js';
import type { EngineCore as Core } from '../../engine/core.js';
import type { ClaudeEnginePort, AttributionPort, MutantId } from '../../engine/deps.js';
import type { LeasePort } from '../../ports/lease.js';
import type { Trace } from '../../ports/trace.js';
import type { DaemonPorts } from './ctx.js';
import type { OpDraft } from '../../board/ops.js';
import { StageDir } from '../../engine/stagedRead.js';
import type { EngineView } from './engineView.js';
import { newPeerId } from '../../board/ids.js';
import { VersionPolicy } from './versions.js';
import { SeatRegistry } from './seats.js';
import { SeatLeasePort } from './seatLease.js';
import { engineView } from './engineView.js';
import { ClaudeServer } from './server.js';
import { TICK_ORDER, registerTicker, runTicker } from './pipeline.js';
import { EventStore, routeHoldCode } from './events.js';
import { BudgetMeter } from './meter.js';
import { Transitions } from './transitions.js';
import { TurnOrigin } from './turns.js';
import { TurnItems } from './stop.js';
import { SignalPump } from './signals.js';
import { Ringer } from './ring.js';
import { LeaseTable } from './leases.js';
import { AttributionWindows, hookAttribution } from './attribution.js';
import { DeferSet } from './defer.js';
import { DiskSnapshots } from './hookRead.js';
import { SeatHealth } from './health.js';
import { Liveness } from './liveness.js';
import { ShadowRecorder } from './shadow.js';
import { ViewBlobs, ReadSets } from './post.js';
import { ApplyJournal } from './attribJournal.js';
import { EditCheckpoints } from './editCheckpoints.js';
import { EvidenceStore } from './evidence.js';
import { ActingVerbRegistry } from './acting.js';
import { HumanActivity } from './since.js';

export interface ClaudeDaemonDeps { repo: LiveRepo; key: Buffer; endpoint: string; pluginVersion: string; ports: DaemonPorts; log: Log; security: SecurityLog; trace: Trace;
  /** plan:1324: the twelve members; the composition copies the object (never writes the caller's) and binds its two slots
   *  (outboxCoordSlot, plan3RevertViewSlot); any other value — Plan 6's bindClaude spread, a harness double — is kept. */
  bindings: ClaudeBindings; testMutants?: ReadonlySet<MutantId>;
  hookProto?: number;   // A5-14 (R5-62): default HOOK_PROTO; VersionPolicy({pluginVersion, hookProto}) — tests run a daemon of proto 3
  osLocale: string | null;   // X-53 input (added by the reconciliation pass): the daemon process's OS locale, read once at start by src/daemon/run.ts; with ctx.prefs().language and
                             //   EngineView.teamLanguage() it feeds resolveHumanLang({user, team, osLocale}), whose claudeLang(lh) is the L_c of every daemon-rendered Claude text
  /** A5-12 (R5-55), test-only: these DaemonCtx members replaced by doubles after createClaudeDaemon builds the rest; production passes none. */
  ctxOverrides?: Partial<Pick<DaemonCtx, 'events' | 'leases' | 'health' | 'readSets' | 'views' | 'turns' | 'signals' | 'reads'>>;
  /** A7-6 (decision 7-10): Transitions' heartbeatNow — the same source as EngineDeps.heartbeatMs; machineMonoMs in
   *  production (the default), the harness's virtual clock in tests. */
  heartbeatMs?: () => number;
  /** C-STOP (F2 #90, 06 §3.17.3 "drains and exits"): close('version') calls it exactly once per daemon, after the drain
   *  and the server close (in a finally, so also when the drain throws or no engine was ever attached); close('drain')
   *  and close('removal') never call it. src/daemon/run.ts wires it to its runCommand stop, so runIterations returns
   *  and daemon.lock is released. Optional: a composition without it only drains. */
  requestStop?: () => void;
  pidAlive: (pid: number) => boolean; }   // A5-11: production process.kill(pid, 0) — true on success or EPERM, false on ESRCH; the tickers use ports.scheduler (DaemonPorts.scheduler)

export interface ClaudeDaemon {
  /** Bound into EngineDeps before the Engine is built: claude = ctx.defer (Task 8's DeferSet), attribution =
   *  hookAttribution(windows), lease = the SeatLeasePort; every DeferSet read a later task owns returns its neutral
   *  value (R5-55), so no engine iteration reaches a throwing stub. Every Engine run.ts builds (respawns included) gets
   *  the same three. */
  readonly engineDeps: { claude: ClaudeEnginePort; attribution: AttributionPort; lease: LeasePort };
  /** A5-12 (R5-55), in this order: await ctx.shadows.convertLeftovers() (every surviving tmp/deny-*.bin converted before anything else, 06 §3.6.6 step 7); EngineView;
   *  SignalPump; the hold-code observer (EngineCore.onHoldCode → Task 7's routeHoldCode, A8-9) and the status observer (Engine.onStatus → ctx.transitions.observe);
   *  ctx.checkpoints.attachEngine(engine) (Task 13 subscribes onCandidateSettled/onCaptureTaken there); the fold-step and human-CS subscriptions (Task 16). No hook frame is answered before it resolves.
   *  C-ATTACH (F2 #91): re-callable — src/daemon/run.ts calls it after every successful Engine.start, respawns included;
   *  each call unsubscribes the previous engine's observers and rebinds every engine-bound member in one synchronous
   *  block (decision 7-21); the same pair again is harmless. A call that throws leaves the previous binding whole, and
   *  a call superseded by a newer one during its await binds nothing (the newest attach wins). */
  attach(engine: Engine, core: Core): Promise<void>;
  listen(): Promise<'serving' | 'reuse' | 'SEC_REFUSE_IPC_SQUATTER'>;
  readonly ctx: DaemonCtx;
  /** The bound server, or null before listen / after close (close clears it; additive, the tests' routing cells use it). */
  readonly server: import('./server.js').ClaudeServer | null;
  txnOpen(): boolean;                                                                                   // X5-27 (Plan 7 LIF-28)
  close(why: 'drain' | 'removal' | 'version'): Promise<void>;
}

/** The 64 MB cap of DiskSnapshots' in-memory bytes (§1675). */
const DISK_CAP_BYTES = 64 * 1024 * 1024;

/** A5-7: the registered tickers are daemon-agnostic (each reads the ctx runTicker passes), so the registration
 *  is once per process (registerTicker throws on a duplicate); the 1 s loop itself is per daemon (armTickers). */
let daemonTickersRegistered = false;
function registerDaemonTickers(): void {
  if (daemonTickersRegistered) return;
  daemonTickersRegistered = true;
  registerTicker('seats', (c) => { return c.seats.tick(); });
  // F2 #7 (decision 7-24): the 1 s window roll of the live PULL_MODE-flagged seats (06 §3.11.4: PULL_MODE ends at the
  // next budget hour, also on an idle seat); only flagged seats are touched, so no unflagged seat's window is anchored
  // by the ticker (the lazy anchoring at the first hook stays, plan:1626).
  registerTicker('meter', (c) => {
    for (const s of c.seats.seats()) if (s.activity !== 'ENDED' && s.flags.includes('PULL_MODE')) c.meter.inPullMode(s.seat_id);
  });
  registerTicker('leases', (c) => { c.leases.expire(); });   // Task 8: the INFLIGHT/READ backstops and the TXN cap, on the 1 s housekeeping tick
  registerTicker('engineView', (c) => { c.engine.observe(c.ports.clock.monoMs()); });
}

/** The composition (R5-02). Decisions recorded here:
 *  7-1 the SeatLeasePort is built before its SeatRegistry (engineDeps precede the Engine, A5-13): its source reads a
 *      holder that attach fills, so pre-attach only the human lease can hold the peer awake and idleMs() is 0 only
 *      because no lease has ever been valid; ctx.engine is likewise undefined until attach (nothing reads it first).
 *  7-3 (F2 #98) the registry's peer is a random id minted at composition until the first attach; every attach sets the
 *      engine's peer id (SeatRegistry.bindPeer), which the seat-end claim release (X-22), the seat and ipc traces and
 *      peerId() carry from then on. Seats can exist before attach (an MCP hello is not held by the server); they keep
 *      the registry, only its peer id changes.
 *  7-4 the A5-6 'serve_then_drain' trigger has no pinned ClaudeServer member: the composition binds close('version')
 *      through ClaudeServer.setVersionDrain; a failing close is logged (DAEMON_INTERNAL_ERROR, R-F2-14), never left
 *      unhandled.
 *  7-5 ctx.prefs reads <dataDir>/user.json once, async, into a cache (readUserJson, lenient; R5-12): the pinned
 *      `prefs(): UserPrefs` is sync, so a read raced by an early call answers the defaults.
 *  7-7 the A5-12 status observer: Task 7 landed Engine.onStatus (A7-6), and attach subscribes it (→ ctx.transitions.observe)
 *      and EngineCore.onHoldCode (→ routeHoldCode, A8-9); each attach first unsubscribes the previous engine's two, so a
 *      crashed engine's status never reaches Transitions (F2 #10).
 *  7-8 (F2 #69, #77) ONE SignalPump, built at composition over a delegating engine: before the first attach its
 *      signal(s) queues {s, resolve, reject} (preAttachSignals) and returns that promise; attach points it at the
 *      attached Engine and flushes the queue in send order (engine.signal(s).then(resolve, reject)), the same rule as
 *      preAttachDrafts (decision 7-12): the window ends at the first start or the process exits. Its `core` getter is
 *      the attached engine's core (nextCandSeq). A ctxOverrides.signals double is never replaced, and SeatRegistry
 *      sends through ctx.signals at call time, so a double also gets the pre-attach seat signals. SeatHealth and
 *      HumanActivity are still built over neutral stand-ins {markSince: noop, foldedHeight: 0, setFreezeReason: noop};
 *      Task 9/16 bind theirs and must rebind them on every attach (C-ATTACH).
 *  7-9 Liveness's production providers (pluginEnabled/keyHash/runtimeExists/shutdown) are run.ts's (Task 9): the
 *      composition constructs it over neutral providers.
 *  7-10 A7-6: Transitions' heartbeatNow is machineMonoMs (the R-35 source), not the daemon clock.
 *  7-11 txnOpen delegates to ctx.leases.txnOpen() (X5-27), Task 8's LeaseTable.
 *  7-21 (C-ATTACH, F2 #91 #77 #10) attach(engine, core) is re-callable: run.ts calls it after every successful
 *      Engine.start. Order: (1) the attach generation is taken and the git port follows core.repo (7-23); (2) await
 *      ctx.shadows.convertLeftovers(); a newer attach started during the await -> this one returns, binding nothing;
 *      (3) one synchronous block, no await, so a concurrent hook never sees a half-rebound ctx. Its fallible half runs
 *      first, in R5-55's order: the EngineView and the revertView port are built, ctx.checkpoints.attachEngine(engine),
 *      then core.onHoldCode and engine.onStatus are subscribed; a throw in it unsubscribes the new observers, puts the
 *      git port back and rethrows, so the previous binding stays whole (attachEngine gets the engine as its argument;
 *      ctx.engine and the SignalPump still name the previous engine while it runs). Then the commit half: unsubscribe the previous
 *      onStatus/onHoldCode; the EngineView; the SignalPump target and the pre-attach signal flush; seats.bindPeer and
 *      leases.peer; windows.csOf; the revertView slot; the preAttachDrafts flush; server.setReady(); armTickers()
 *      (one loop per daemon). The same pair again: one subscription each, no duplicate flush, one ticker loop.
 *  7-22 (C-STOP, F2 #90) close('version') = drain(null), server close, then ClaudeDaemonDeps.requestStop() once per
 *      daemon, in a finally (also after a throwing drain, and with no engine attached).
 *  7-23 (C-GIT, F2 #50 #73) ctx.ports.git and DiskSnapshots' repo are one delegating GitRepo: d.ports.git before the
 *      first attach, the attached core.repo after it, so a hook-read hash carries -c attr.tree=<EPOCH_BASE> and the
 *      required-filter pairs of the engine's ctx (DAT-13). run.ts may keep passing its config repo as ports.git.
 *  7-24 (F2 #7) the composition registers the `meter` ticker (before `ring` in TICK_ORDER).
 *  7-25 (R-F2-14, F2 #46 #101) a throwing ticker is logged as DAEMON_INTERNAL_ERROR {where: 'ticker', ticker, error}
 *      and the run goes on with the next ticker; the next second's run is scheduled as always. A ticker that keeps
 *      throwing the same error text is logged once, not once a second: the line is written again only after that
 *      ticker ran clean once or threw another text. A run that fires after close() starts no ticker.
 */
export function createClaudeDaemon(d: ClaudeDaemonDeps): ClaudeDaemon {
  type MutableCtx = { -readonly [K in keyof DaemonCtx]: DaemonCtx[K] };
  const seatsHolder: { registry: SeatRegistry | null } = { registry: null };
  const engineHolder: { view: EngineView | null } = { view: null };
  const serverHolder: { server: ClaudeServer | null } = { server: null };
  const preAttachDrafts: Array<Extract<OpDraft, { type: 'seat_start' | 'seat_end' | 'event' }>> = [];   // decision 7-12

  // Decision 7-23 (C-GIT): the git port follows the attached core's repo (its ctx carries EPOCH_BASE and the drivers).
  const gitHolder: { repo: GitRepo } = { repo: d.ports.git };
  const ports: DaemonPorts = { ...d.ports, git: delegatingRepo(d.ports.git, gitHolder) };

  // Decision 7-8 (F2 #69, #77): the one SignalPump's engine — queues before the first attach, then the attached Engine.
  const engineRef: { current: Engine | null } = { current: null };
  const preAttachSignals: Array<{ s: CsSignal; resolve: () => void; reject: (e: unknown) => void }> = [];
  const pumpEngine = {
    signal(s: CsSignal): Promise<void> {
      const e = engineRef.current;
      if (e === null) return new Promise<void>((resolve, reject) => { preAttachSignals.push({ s, resolve, reject }); });
      return e.signal(s);
    },
    get core(): Core | undefined { return engineRef.current?.core; },
  } as unknown as Engine;

  // R5-12 (decision 7-5): the lenient user.json read, cached; an early call answers the defaults.
  let prefsCache: import('../wire/pluginData.js').UserPrefs | null = null;
  const prefsDefaults = readUserJson(null);
  void d.ports.fs.readFile(join(d.repo.dataDir, 'user.json')).then(
    (b: Buffer) => { prefsCache = readUserJson(b.toString('utf8')); },
    () => { prefsCache = prefsDefaults; });

  // plan:1324 (F2 #41): the composition's own copy; the caller's object (one per harness, shared by every peer) is never written.
  const bindings: ClaudeBindings = { ...d.bindings };
  const ownRevertView = bindings.revertView === plan3RevertViewSlot;

  const events = new EventStore(d.ports.clock, d.ports.random, d.trace);
  const transitions = new Transitions(d.heartbeatMs ?? machineMonoMs);   // decision 7-10 (A7-6); hoisted so the seat's end drops its row (F2 #9)
  const meter = new BudgetMeter(d.ports.clock, (seatId, on) => {
    const s = seatsHolder.registry?.bySeatId(seatId);
    if (s !== null && s !== undefined) seatsHolder.registry?.setFlag(s, 'PULL_MODE', on);   // A5-5: the meter's onPullMode pre-wiring
  });
  const ctxHolder: { ctx: DaemonCtx | null } = { ctx: null };
  const seats = new SeatRegistry({
    clock: d.ports.clock, random: d.ports.random, trace: d.trace, peer: newPeerId(d.ports.random),   // decision 7-3 (bindPeer at attach)
    outbox: (draft) => {
      const e = engineHolder.view;
      if (e === null) { preAttachDrafts.push(draft); return; }   // decision 7-12: buffered, flushed in order at attach
      e.addOps([draft]);
    },
    pidAlive: d.pidAlive,
    notice: (seatId, code, params) => { events.queueSeatContext(seatId, code, params); },  // A5-5: SeatRegistry.notice pre-wiring
    signals: { send: (s) => { ctxHolder.ctx?.signals.send(s); } },                        // decision 7-8: ctx.signals at call time
    regions: bindings.regions,                                                             // X-22 (decision 5-1)
    log: d.log,                                                                            // F2 #110: the Log that isolates an onEnd subscriber's throw (F2 #57's listeners; the I-14 LeaseTable line)
  });
  seatsHolder.registry = seats;
  // F2 #9 (the named exception, t7b's LAST COMMIT): bind the composition's OWN instances — never ctx.events or
  // ctx.transitions, so a ctxOverrides double (ring test, composition test) is never called. The live-seat source
  // of 'all' (call-time ids), and the seat's end drops its store row and transitions row (F2 #8 #9 #57).
  events.bindLiveSeats(() => seats.seats().filter((s) => s.activity !== 'ENDED').map((s) => s.seat_id));
  seats.onEnd(async (seat) => { if (seat.seatId === null) return; events.dropSeat(seat.seatId); transitions.dropSeat(seat.seatId); });
  const leasesHolder: { table: LeaseTable | null } = { table: null };   // decision 7-1: the human turn's `released` reads Task 8's table lazily
  const turns = new TurnOrigin(seats, d.ports.clock, d.trace,
    { openFor: (seatId: string) => leasesHolder.table?.openFor(seatId) ?? { inflight: 0, txns: 0 } },   // Task 6: the A6-1 released count; 0 until Task 8
    d.testMutants);                                                                        // Task 6: the M44 site (A6-11)
  const stageDir = new StageDir(d.ports.fs, join(d.repo.coworkDir, 'tmp', 'stage'));
  const reads = new DiskSnapshots(ports.git, d.ports.fs, stageDir, DISK_CAP_BYTES);          // decision 7-23: the delegating repo
  const leases = new LeaseTable(d.ports.clock, d.trace, reads, d.log);   // t8a's Carry C-1: the daemon Log (ctx.log carries it) isolates subscriber throws (F2 #110)
  leasesHolder.table = leases;
  const windows = new AttributionWindows(d.ports.clock, leases);
  leases.onTxnClosed(async (t, why) => { windows.onTxnClose(t, why); });   // R5-29: a cap or background-return close opens the seat's late-write window
  const items = new TurnItems();
  // Task 8: the seat's end releases every lease and TXN of the seat (why 'seat_end') and ends its R5-29 late-write tags;
  // C-3 (F2 #57): it also ends the seat's TurnItems turn (ctx.items.endTurn) and drops its BudgetMeter window.
  seats.onEnd(async (seat) => {
    const id = seat.seatId;
    if (id === null) return;
    leases.releaseSeat(id, {}, 'seat_end');
    windows.onSeatBoundary(id);
    ctxHolder.ctx?.items.endTurn(id);
    dropDigestSeat(ctxHolder.ctx!, id);   // t7a fix round 1: the seat's digest seen set dies with the seat (bounded state)
    meter.drop(id);                                                    // F2 #57: no meter window outlives its seat
  });
  const journal = new ApplyJournal();
  const views = new ViewBlobs();
  const readSets = new ReadSets();
  const versions = new VersionPolicy({ pluginVersion: d.pluginVersion, hookProto: d.hookProto ?? HOOK_PROTO });
  const seatLease = new SeatLeasePort(
    { leaseSeats: () => seatsHolder.registry?.leaseSeats() ?? [], pidAlive: d.pidAlive, queuePeerIdle: () => seatsHolder.registry?.queuePeerIdle() },
    d.ports.clock, () => undefined, (seatId) => bindings.coordHooks.onLeaseLost(seatId));   // X-40 (decision 5-2); the PEER_IDLE draft queue lives in SeatLeasePort
  const ownSignals = new SignalPump(pumpEngine, d.log);                                     // decision 7-8: one pump for the daemon's life

  const ctx = {
    repo: d.repo, ports, log: d.log, security: d.security, trace: d.trace,
    engine: undefined as never,   // decision 7-1: the engine arrives at attach
    bindings,
    prefs: (): import('../wire/pluginData.js').UserPrefs => prefsCache ?? prefsDefaults,
    versions, seats, seatLease, turns, items, signals: ownSignals, ring: undefined as never, events, meter,
    transitions,                                                   // decision 7-10 (A7-6), hoisted for the F2 #9 seat-end drop
    reads, leases, defer: undefined as never, windows,
    health: undefined as never, liveness: undefined as never, shadows: undefined as never, views, readSets,
    journal, checkpoints: undefined as never, evidence: undefined as never, acting: undefined as never, activity: undefined as never,
    osLocale: d.osLocale,          // C-LOCALE (X-53, F2 #56): read once by run.ts
  } as DaemonCtx;
  ctxHolder.ctx = ctx;
  const m = ctx as unknown as MutableCtx;
  // plan:1299-1301 (F2 #41): the coordTools slot is outboxCoord with ctx (R5-10); a caller's own port (Plan 6's
  // bindClaude, a harness double) is kept. The revertView slot is bound at every attach (plan3RevertView(core)).
  if (bindings.coordTools === outboxCoordSlot) bindings.coordTools = outboxCoord(ctx);
  m.defer = new DeferSet(ctx);
  // I-14 (INV-CCI-EXPIRY-TAINT, F2 #103; the names are t8a's Carry C-1): the composition-time taint subscriptions —
  // made once, on the objects shared across engines (DeferSet, LeaseTable), not per attach. An expired INFLIGHT
  // lease taints its path now when a writer write landed after its acquisition, else waits as a candidate that the
  // writer's apply promotes (the fence holds the writer's apply until the expiry — the plan's own scenario).
  const unsubscribes: Array<() => void> = [];
  unsubscribes.push(leases.onExpired((l) => { windows.onExpiry(l, windows.writerWroteAfter(l.path, l.acquiredMono)); }));
  unsubscribes.push(m.defer.onApplied((detail) => { windows.onWriterApplied(detail); }));
  void unsubscribes;   // kept: a future teardown unsubscribes; the objects outlive every engine
  m.health = new SeatHealth(ctx, { setFreezeReason: async () => undefined });   // decision 7-8 (Task 9 rebinds)
  m.liveness = new Liveness(ctx, { pluginEnabled: async () => true, keyHash: async () => null, runtimeExists: async () => true, shutdown: async () => undefined });   // decision 7-9
  m.shadows = new ShadowRecorder(ctx);
  m.checkpoints = new EditCheckpoints(ctx);
  m.evidence = new EvidenceStore(ctx, d.key);
  m.acting = new ActingVerbRegistry(ctx);
  m.activity = new HumanActivity(ctx, { markSince: () => undefined, foldedHeight: () => 0 }, ctx.prefs);   // decision 7-8
  m.ring = new Ringer(ctx, (seatId, f) => serverHolder.server?.sendToSeat(seatId, f) ?? false);   // Task 6: over the real ctx (the ring ticker reads ports.random, seats, trace)

  // A5-12 (R5-55), test-only: the overrides replace exactly the named members, after everything else is built.
  if (d.ctxOverrides !== undefined) {
    const target = m as unknown as Record<string, unknown>;
    for (const k of ['events', 'leases', 'health', 'readSets', 'views', 'turns', 'signals', 'reads'] as const) {
      const v = d.ctxOverrides[k];
      if (v !== undefined) target[k] = v;
    }
  }

  const subs: { status: (() => void) | null; holdCode: (() => void) | null } = { status: null, holdCode: null };   // decision 7-21
  const tickerState = { armed: false, stopped: false };
  const tickerErrors = new Map<string, string>();   // decision 7-25: the last logged error text per ticker id
  let attachGen = 0;                                // decision 7-21: the newest attach's generation
  let boundRepo: GitRepo = d.ports.git;             // decision 7-23: the repo of the last attach that bound
  let stopRequested = false;   // decision 7-22: requestStop once per daemon
  registerDaemonTickers();
  const armTickers = (): void => {
    if (tickerState.armed || tickerState.stopped) return;
    tickerState.armed = true;
    const step = async (): Promise<void> => {
      try {
        for (const id of TICK_ORDER) {                                    // one run at a time: the next fire is scheduled after this run
          if (tickerState.stopped) break;                                 // decision 7-25: nothing runs after close
          try {
            await runTicker(id, ctx);
            tickerErrors.delete(id);
          } catch (e) {
            const error = errText(e);
            if (tickerErrors.get(id) !== error) {                         // decision 7-25: a persistent failure is logged once
              tickerErrors.set(id, error);
              d.log.write('error', 'DAEMON_INTERNAL_ERROR', { where: 'ticker', ticker: id, error });   // R-F2-14
            }
          }
        }
      } finally {
        if (!tickerState.stopped) d.ports.scheduler.schedule(step, d.ports.clock.monoMs() + 1_000);
        else tickerState.armed = false;
      }
    };
    d.ports.scheduler.schedule(step, d.ports.clock.monoMs() + 1_000);
  };
  const daemon: ClaudeDaemon = {
    // A5-5 as amended by Task 8: the engine reads ctx.defer (the one DeferSet, built over the lease table — its
    // applied() instants and onApplied fan-out are shared with the daemon) and hookAttribution(windows).
    engineDeps: { claude: ctx.defer, attribution: hookAttribution(windows), lease: seatLease },
    ctx,
    get server() { return serverHolder.server; },   // additive (server.test's routing cells)
    async attach(engine: Engine, core: Core): Promise<void> {
      const gen = ++attachGen;                                                                 // decision 7-21: the newest attach wins
      // (the git port goes back to boundRepo, the bound core's, when this attach fails)
      gitHolder.repo = core.repo;                                                              // decision 7-23, before convertLeftovers (it hashes deny shadows)
      try {
        await ctx.shadows.convertLeftovers();                                                  // A5-12, first (06 §3.6.6 step 7)
      } catch (e) {
        if (gen === attachGen) gitHolder.repo = boundRepo;
        throw e;
      }
      if (gen !== attachGen) return;                                                           // superseded during the await: bind nothing
      // Decision 7-21: one synchronous block from here (no await), so a concurrent hook never sees a half-rebound ctx.
      // The fallible half first: nothing of the previous binding changes until all of it succeeded.
      let holdOff: (() => void) | null = null;
      let statusOff: (() => void) | null = null;
      let view: EngineView;
      let revert: RevertViewPort | null;
      try {
        view = engineView(engine, core);                                                       // A5-12, the EngineView
        revert = ownRevertView ? plan3RevertView(core) : null;                                 // plan:1301: the composition's slot, per core
        ctx.checkpoints.attachEngine(engine);                                                  // A5-12 (the R5-55 neutral until Task 13), R5-55's order
        holdOff = core.onHoldCode((r) => { routeHoldCode(r, ctx); });                         // A8-9: Task 7's routeHoldCode consumes every hold-code raise
        statusOff = engine.onStatus((s) => ctx.transitions.observe(s, d.ports.clock.monoMs()));   // A7-6: every status.json reaches Transitions (decision 7-7)
      } catch (e) {
        holdOff?.();
        statusOff?.();
        gitHolder.repo = boundRepo;
        throw e;
      }
      // The commit half.
      subs.status?.();                                                                         // the previous engine's observers end
      subs.holdCode?.();
      subs.holdCode = holdOff;
      subs.status = statusOff;
      boundRepo = core.repo;
      m.engine = view;
      engineHolder.view = view;
      engineRef.current = engine;                                                              // decision 7-8: the pump's target
      for (const q of preAttachSignals.splice(0)) engine.signal(q.s).then(q.resolve, q.reject);   // in send order
      seats.bindPeer(core.peerId);                                                             // decision 7-3 (F2 #98)
      leases.peer = core.peerId;                                                               // O-LEASE: the lease trace rows carry the daemon's peer id
      windows.csOf = (seatId, agentId) => m.engine.openCsOf(seatId, agentId);                  // A6-6: the INFLIGHT/grace rows carry the seat's open CS
      if (revert !== null) bindings.revertView = revert;
      const buffered = preAttachDrafts.splice(0);                                              // decision 7-12: flushed in order
      for (const draft of buffered) m.engine.addOps([draft]);
      serverHolder.server?.setReady();                                                         // decision 7-15: held hooks flush now
      armTickers();                                                                            // A5-7: the 1 s ticker loop starts with the sync (once per daemon)
      // The fold-step and human-CS subscriptions are Task 16's.
    },
    async listen(): Promise<'serving' | 'reuse' | 'SEC_REFUSE_IPC_SQUATTER'> {
      const server = new ClaudeServer(ctx, d.key, d.endpoint);
      serverHolder.server = server;
      server.setVersionDrain(() => {                                                           // decision 7-4
        daemon.close('version').catch((e: unknown) => {
          d.log.write('error', 'DAEMON_INTERNAL_ERROR', { where: 'version_drain', error: errText(e) });   // R-F2-14: logged, never unhandled
        });
      });
      if (engineRef.current !== null) server.setReady();                                       // attached before listen: hooks can answer at once
      return server.listen();
    },
    txnOpen(): boolean {
      return ctx.leases.txnOpen();                                                             // X5-27 (decision 7-11)
    },
    async close(why: 'drain' | 'removal' | 'version'): Promise<void> {
      tickerState.stopped = true;                                                              // A5-7: the ticker loop ends with the daemon
      try {
        try {
          const engine = engineRef.current;
          if (why !== 'removal' && engine !== null) await engine.drain(why === 'version' ? null : 'IDLE_NO_SESSION');
        } finally {
          // 'removal': Task 9's stopgap (LIF-36) — the server close only, until that task lands. The listener closes
          // even when the drain threw.
          try {
            await serverHolder.server?.close();
          } finally {
            serverHolder.server = null;                                                        // the getter answers null after close
          }
        }
      } finally {
        if (why === 'version' && !stopRequested) {                                             // decision 7-22 (C-STOP): the process exits
          stopRequested = true;
          d.requestStop?.();
        }
      }
    },
  };
  return daemon;
}

/** R-F2-14's log text of a caught error: the errno code or the error's name, never its message (SEC-38; F2 t5-run's
 *  Code-edit request — the t5-compose form logged `name: message`, whose message carries free text). */
function errText(e: unknown): string {
  return errnoCode(e) ?? (e instanceof Error ? e.name : 'unknown');
}

/** Decision 7-23: a GitRepo whose every member is read from holder.repo at call time (methods bound to that repo). */
function delegatingRepo(base: GitRepo, holder: { repo: GitRepo }): GitRepo {
  return new Proxy(base, {
    get(_target, key) {
      const r = holder.repo;
      const v: unknown = Reflect.get(r, key, r);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(r) : v;
    },
  });
}
