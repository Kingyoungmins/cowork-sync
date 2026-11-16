// src/claude/daemon/ctx.ts — the daemon context (06 §3.17; Task 5). Phase 1 declares the types; the modules DaemonCtx
// names are Task 5's own (seats, seatLease, engineView, versions, regions) or stub modules (Tasks 6–16), imported as
// types only so no stub value is evaluated here.
import type { Fs } from '../../ports/fs.js';
import type { GitRepo } from '../../git/repo.js';
import type { Notifier } from '../../ports/notifier.js';
import type { Random } from '../../ports/random.js';
import type { Scheduler } from '../../ports/scheduler.js';
import type { Clock } from '../../ports/clock.js';
import type { Log } from '../../ports/log.js';
import type { Trace } from '../../ports/trace.js';
import type { Ipc } from '../../ports/ipc.js';
import type { SecurityLog } from '../../sec/securityLog.js';
import type { Params } from '../../i18n/render.js';
import type { UserPrefs } from '../wire/pluginData.js';
import type { HookFrame, McpHelloFrame } from '../wire/frames.js';
import type { EditTrigger } from './editCheckpoints.js';
import type { CarrierItem, CarrierKind } from './carriers.js';
import type { TurnItems } from './stop.js';
import type { DiskSnapshots } from './hookRead.js';
import type { Seat, SeatRegistry } from './seats.js';
import type { SeatLeasePort } from './seatLease.js';
import type { TurnOrigin } from './turns.js';
import type { SignalPump } from './signals.js';
import type { Ringer } from './ring.js';
import type { EventStore } from './events.js';
import type { BudgetMeter } from './meter.js';
import type { Transitions } from './transitions.js';
import type { LeaseTable } from './leases.js';
import type { DeferSet } from './defer.js';
import type { AttributionWindows } from './attribution.js';
import type { SeatHealth } from './health.js';
import type { Liveness } from './liveness.js';
import type { ShadowRecorder } from './shadow.js';
import type { ViewBlobs, ReadSets } from './post.js';
import type { ApplyJournal } from './attribJournal.js';
import type { EditCheckpoints } from './editCheckpoints.js';
import type { EvidenceStore } from './evidence.js';
import type { ActingVerbRegistry } from './acting.js';
import type { HumanActivity } from './since.js';
import type { EngineView } from './engineView.js';
import type { ClaudeBindings, RegionsPort, CoordToolsPort, CoordHooksPort, DigestPort, SlotExtraPort, DueRequestsPort, FlowPort, WrapPort, NoteScanPort, RevertViewPort } from './claudeDaemon.js';
import type { WakePolicy } from './ring.js';
import type { WakeScopePort } from './wakeScope.js';
import type { VersionPolicy } from './versions.js';

export interface DaemonPorts { clock: Clock; random: Random; fs: Fs; scheduler: Scheduler; git: GitRepo; ipc: Ipc; notifier: Notifier; }

export interface HookRequest {
  frame: HookFrame; seat: Seat; startedMono: number;
  extend(ms: number): boolean;                                                       // SUSPECT only, once (CCI-17)
  turn: { doorbell: boolean; newTurn: boolean; origin: 'human' | 'wake' } | null;    // set by step turn.prompt (UserPromptSubmit) for the steps after it
  trigger: EditTrigger | null;                                                       // A12-1: set by post.edit and txn.close, read by checkpoint.trigger (Task 13)
}

export interface ReplyDraft {
  carrier: CarrierKind; items: CarrierItem[];
  deny: { code: string; params: Params; form: 'T1' | 'T1R' | 'other' } | null;   // G1: exit 2 reason (first deny wins; later steps skip)
  block: { code: string; params: Params } | null;                               // K2 (PostToolUse) or STOP_SUMMARY (Stop)
  done: boolean;                                                                 // a step ended the pipeline for this event
}

export type HookStep = (r: HookRequest, d: ReplyDraft, ctx: DaemonCtx) => Promise<void>;

export interface DaemonCtx {
  readonly repo: LiveRepoLocal; readonly ports: DaemonPorts; readonly log: Log; readonly security: SecurityLog; readonly trace: Trace; readonly engine: EngineView;
  readonly bindings: ClaudeBindings; readonly prefs: () => UserPrefs; readonly versions: VersionPolicy; readonly seats: SeatRegistry; readonly seatLease: SeatLeasePort;
  readonly turns: TurnOrigin; readonly items: TurnItems; readonly signals: SignalPump; readonly ring: Ringer;
  readonly events: EventStore; readonly meter: BudgetMeter; readonly transitions: Transitions;
  readonly reads: DiskSnapshots; readonly leases: LeaseTable; readonly defer: DeferSet; readonly windows: AttributionWindows;
  readonly health: SeatHealth; readonly liveness: Liveness; readonly shadows: ShadowRecorder; readonly views: ViewBlobs; readonly readSets: ReadSets;
  readonly journal: ApplyJournal; readonly checkpoints: EditCheckpoints; readonly evidence: EvidenceStore; readonly acting: ActingVerbRegistry; readonly activity: HumanActivity;
  /** X-53 (C-LOCALE, F2 #56): the daemon process's OS locale, read once at start by src/daemon/run.ts
   *  (ClaudeDaemonDeps.osLocale); null when the OS gives none. createClaudeDaemon always sets it; the member is
   *  optional only so the ctx doubles other suites type `as DaemonCtx` keep compiling — read it as `ctx.osLocale ?? null`. */
  readonly osLocale?: string | null;
}

/** The live repo identity (src/data/canonRoot.ts LiveRepo); re-declared locally so ctx.ts imports no engine or daemon
 *  composition value. */
interface LiveRepoLocal { root: string; gitdir: string; coworkDir: string; dataDir: string; endpointRoot: string; }
export type { LiveRepoLocal as LiveRepo };

// Names the plan's ctx.ts block references but Phase 1 keeps type-only through their owning stub modules:
export type { McpHelloFrame, RegionsPort, WakePolicy, WakeScopePort, CoordToolsPort, CoordHooksPort, DigestPort, SlotExtraPort, DueRequestsPort, FlowPort, WrapPort, NoteScanPort, RevertViewPort, ClaudeBindings };
