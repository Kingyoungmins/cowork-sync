// The fixed step order (06 §3.4.2, §3.7, §3.8.4 step 3, §3.12, §3.14, §3.15); Task 5 declares it with every step a
// no-op stub; each concern module registers its own steps (registerStep) when its task lands; no later task reorders
// STEP_ORDER. Phase 1 ships the tables and the registries; the runner semantics live in server.ts's dispatch (Phase 3).
import type { DaemonCtx, HookRequest, ReplyDraft, HookStep } from './ctx.js';
import type { HookEvent } from '../wire/frames.js';

export type StepId = 'seat.register' | 'version.check' | 'health.observe' | 'turn.prompt' | 'turn.expansion' | 'turn.stop' | 'lease.release' | 'evidence.expansion'
  | 'activity.mark' | 'gate.edit' | 'gate.shell' | 'post.edit' | 'post.read' | 'txn.close' | 'checkpoint.trigger' | 'signal.emit' | 'journal.attribution'
  | 'carrier.context' | 'recap.system' | 'stop.decide' | 'transition.deliver' | 'event.deliver';

export const STEP_ORDER: Readonly<Record<HookEvent, readonly StepId[]>> = Object.freeze({
  // A13-9: the PostToolUseFailure entry ships with Task 5's table, a no-op until Task 13 registers the step; a
  // Bash/PowerShell TXN closed by its own PostToolUseFailure is trigger (b); an edit-class PostToolUseFailure carries no
  // trigger, so the step is a no-op there.
  SessionStart: ['seat.register', 'version.check', 'health.observe', 'signal.emit', 'carrier.context', 'transition.deliver', 'event.deliver'],
  UserPromptSubmit: ['seat.register', 'turn.prompt', 'lease.release', 'signal.emit', 'activity.mark', 'carrier.context', 'recap.system', 'transition.deliver', 'event.deliver'],
  UserPromptExpansion: ['seat.register', 'turn.expansion', 'evidence.expansion', 'activity.mark'],   // no output, never blocks
  PreToolUse: ['seat.register', 'version.check', 'health.observe', 'gate.edit', 'gate.shell', 'transition.deliver', 'event.deliver'],
  PostToolUse: ['seat.register', 'health.observe', 'post.edit', 'post.read', 'txn.close', 'lease.release', 'checkpoint.trigger', 'signal.emit', 'journal.attribution', 'carrier.context', 'transition.deliver', 'event.deliver'],
  PostToolUseFailure: ['seat.register', 'health.observe', 'txn.close', 'lease.release', 'checkpoint.trigger', 'signal.emit', 'event.deliver'],
  PermissionDenied: ['seat.register', 'health.observe', 'txn.close', 'lease.release', 'signal.emit', 'event.deliver'],   // a PermissionDenied close is never a checkpoint
  PostToolBatch: ['seat.register', 'lease.release'],
  Stop: ['seat.register', 'stop.decide', 'signal.emit', 'lease.release', 'turn.stop', 'event.deliver'],
  StopFailure: ['seat.register', 'stop.decide', 'signal.emit', 'lease.release', 'turn.stop', 'event.deliver'],
  SubagentStart: ['seat.register', 'signal.emit', 'carrier.context'],
  SubagentStop: ['seat.register', 'lease.release', 'signal.emit'],
  SessionEnd: ['seat.register', 'lease.release', 'signal.emit'],
  Notification: ['seat.register', 'health.observe'],
} as const satisfies Record<HookEvent, readonly StepId[]>);

// seat.register also renews the seat lease, observes activity and, for every event except UserPromptSubmit, calls
// TurnOrigin.onOtherHook (fallback (b), R5-36). That routing lives in the composition (Phase 3); Phase 1 ships the
// tables and the registries only.

const steps = new Map<StepId, HookStep>();

/** Registers one pipeline step; throws when id is already registered (no later task reorders STEP_ORDER). */
export function registerStep(id: StepId, step: HookStep): void {
  if (steps.has(id)) throw new Error(`registerStep: ${id} is already registered`);
  steps.set(id, step);
}

/** An unregistered step is a no-op; a step's `d.done = true` stops the later steps of that event (the runner, Phase 3);
 *  a later deny never replaces an earlier one — the first deny is kept. */
export async function runStep(id: StepId, r: HookRequest, d: ReplyDraft, ctx: DaemonCtx): Promise<void> {
  const step = steps.get(id);
  if (step === undefined) return;
  const before = d.deny;
  await step(r, d, ctx);
  if (before !== null && d.deny !== before) d.deny = before;
}

/** A5-7 daemon tickers: ClaudeDaemon runs every registered ticker in TICK_ORDER once per second (Δmono, the Scheduler
 *  port; one run at a time; a throwing ticker is logged as DAEMON_INTERNAL_ERROR and the run goes on, R-F2-14). The
 *  composition (claudeDaemon.ts) registers `seats` (SeatRegistry.tick: pairing windows, the 5 s pid checks, heartbeat
 *  loss), `meter` (F2 #7: the 1 s window roll of PULL_MODE-flagged seats, so an idle seat leaves PULL_MODE at its
 *  seat-hour boundary — before `ring`, which then sees the cleared flag in the same run), `leases` (Task 8's backstops)
 *  and `engineView` (EngineView.observe, A5-8); the concern modules register theirs at module load (turns, idle, ring),
 *  as with registerStep. */
export type TickerId = 'seats' | 'turns' | 'idle' | 'meter' | 'ring' | 'leases' | 'health' | 'liveness' | 'engineView';

export const TICK_ORDER: readonly TickerId[] = Object.freeze(['seats', 'turns', 'idle', 'meter', 'ring', 'leases', 'health', 'liveness', 'engineView'] as const);

type Ticker = (ctx: DaemonCtx) => Promise<void> | void;

const tickers = new Map<TickerId, Ticker>();

/** Registers one ticker; throws on a duplicate (as with registerStep). */
export function registerTicker(id: TickerId, fn: Ticker): void {
  if (tickers.has(id)) throw new Error(`registerTicker: ${id} is already registered`);
  tickers.set(id, fn);
}

/** An unregistered ticker is a no-op. One run at a time: the composition schedules the next second's run only after
 *  the current run ended, so a ticker slower than 1 s never overlaps itself. */
export async function runTicker(id: TickerId, ctx: DaemonCtx): Promise<void> {
  const fn = tickers.get(id);
  if (fn === undefined) return;
  await fn(ctx);
}
