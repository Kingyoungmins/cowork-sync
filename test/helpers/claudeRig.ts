// test/helpers/claudeRig.ts — the integration double set for the daemon side of a ClaudeEnginePort binding (Plan 5
// Task 8's test doubles: a real LeaseTable over a VirtualClock and a real DeferSet; doubles for SeatHealth, ReadSets
// and the seat registry). The engine binds rig.defer through makeEngines' engineDeps; the test drives the lease
// table directly. F2 (#22 #27, rulings R-T8B-7, R-T8B-10): the rig may ride a given clock (the engine fixture's own
// peer clock, so lease ages and engine instants are on one clock); lazyClaudePort lets engineDeps be built before
// that rig; until() waits on a condition instead of a fixed real-time sleep; harnessRounds() is the seatHarness
// equivalent of EngineFixture.rounds; bindEngineClaude() binds each harness engine to its daemon's ClaudeEnginePort.
import assert from 'node:assert/strict';
import { DeferSet } from '../../src/claude/daemon/defer.js';
import { LeaseTable, type InflightLease, type Txn } from '../../src/claude/daemon/leases.js';
import type { DaemonCtx } from '../../src/claude/daemon/ctx.js';
import type { DiskSnapshots } from '../../src/claude/daemon/hookRead.js';
import type { ClaudeEnginePort } from '../../src/engine/deps.js';
import { TraceRecorder } from '../sim/traceRecorder.js';
import { VirtualClock } from '../sim/vclock.js';
import type { SeatHarness } from './seatHarness.js';

export const RIG_SEAT = 'c'.repeat(32);

export interface RigOpts {
  /** The seat's full-read set (its coalescing / pull-mode rows). */
  readSet?: ReadonlySet<string>;
  /** The meter's PULL_MODE answer for RIG_SEAT. */
  pullMode?: boolean;
  /** F2 (R-T8B-10): the clock the LeaseTable and the DeferSet use — the engine fixture's own peer clock, so a lease's
   *  age and the engine's instants are read on one clock. Absent: a fresh VirtualClock at mono 0 (the rig's own). */
  clock?: VirtualClock;
}

export interface DaemonRig {
  readonly seatId: string;
  readonly clock: VirtualClock;
  readonly trace: TraceRecorder;
  readonly leases: LeaseTable;
  readonly defer: DeferSet;
}

/** A real DeferSet over a real LeaseTable (VirtualClock), with doubles for the rest of DaemonCtx. */
export function daemonRig(o?: RigOpts): DaemonRig {
  const clock = o?.clock ?? new VirtualClock({ startMono: 0 });
  const trace = new TraceRecorder();
  const leases = new LeaseTable(clock, trace, {} as unknown as DiskSnapshots);
  const seatId = RIG_SEAT;
  const ctx = {
    ports: { clock },
    leases,
    health: { degradedPaths: (): Map<string, string> => new Map() },
    readSets: { fullReadSet: (s: string): ReadonlySet<string> => (s === seatId && o?.readSet !== undefined ? o.readSet : new Set()) },
    meter: { inPullMode: (s: string): boolean => o?.pullMode === true && s === seatId },
    seats: {
      seats: (): Array<{ seat_id: string; number: number }> => (o?.readSet !== undefined ? [{ seat_id: seatId, number: 1 }] : []),
      bySeatId: (s: string): { lastHookMono: number } | null => (s === seatId && o?.readSet !== undefined ? { lastHookMono: clock.monoMs() } : null),
      seatActivity: (): 'MID_TURN' => 'MID_TURN',
    },
  } as unknown as DaemonCtx;
  return { seatId, clock, trace, leases, defer: new DeferSet(ctx) };
}

/**
 * F2 (R-T8B-10): a ClaudeEnginePort that forwards every member to `get()` at call time, so makeEngines' engineDeps can be
 * built before the rig that needs the fixture's clock (set the rig before startAll: the first call reads it).
 */
export function lazyClaudePort(get: () => ClaudeEnginePort): ClaudeEnginePort {
  return {
    txnOpen: () => get().txnOpen(),
    deferred: () => get().deferred(),
    recheck: (paths) => get().recheck(paths),
    fenced: () => get().fenced(),
    applied: (paths, detail) => get().applied(paths, detail),
  };
}

/**
 * F2 (#27): waits until `cond()` holds, polling every 20 ms of real time (an unref'd timer), and fails
 * "<what> not within <capMs> ms" at the cap — for a condition the real scheduler brings about (the daemon's 1 s
 * housekeeping ticker, a pipe frame), never a fixed sleep.
 */
export async function until(cond: () => boolean | Promise<boolean>, what: string, capMs = 30_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - t0 >= capMs) assert.fail(`${what} not within ${capMs} ms`);
    await new Promise<void>((r) => { setTimeout(r, 20).unref(); });
  }
}

/**
 * F2: the seatHarness equivalent of EngineFixture.rounds (which moves only the fixture clocks): n times, h.advance(loopMs)
 * — the daemon clock and every fixture clock — then every engine's iterate() in peer order.
 */
export async function harnessRounds(h: SeatHarness, n: number, loopMs = 2_500): Promise<void> {
  for (let i = 0; i < n; i++) {
    await h.advance(loopMs);
    for (const p of h.engines.peers) await p.engine.iterate();
  }
}

/**
 * F2: binds every harness engine's ClaudeEnginePort to its daemon's engineDeps.claude (= ctx.defer), as the production
 * composition does (src/daemon/run.ts spreads the daemon's engineDeps into the EngineDeps it builds the Engine from).
 * seatHarness builds the engines before their daemons and passes only the lease (Carry: seatHarness should bind claude
 * lazily, as it binds the lease); the engine reads deps.claude at every call, so binding it here, after the harness is
 * built and before any start, is the production wiring. The attribution port is not rebound (the snapshotter captured it at
 * construction); the cells that use this read ctx.windows directly.
 */
export function bindEngineClaude(h: SeatHarness): void {
  for (const [i, p] of h.engines.peers.entries()) {
    const d = h.daemons[i];
    assert.ok(d !== undefined, `bindEngineClaude: no daemon for peer ${i}`);
    assert.equal(p.core.deps, p.deps, 'the engine core reads the fixture deps object');
    p.deps.claude = d.engineDeps.claude;
    assert.equal(p.core.deps.claude, d.ctx.defer, 'the engine reads the daemon DeferSet');
  }
}

/** An INFLIGHT lease body (kind and acquiredMono are the table's). */
export const inflOf = (toolUseId: string, path: string, over?: Partial<InflightLease>): Omit<InflightLease, 'kind' | 'acquiredMono'> => ({
  toolUseId, seatId: RIG_SEAT, agentId: null, sessionId: 's1', path, foldHeight: 0, pre: null,
  approximate: false, synthetic: false, preHeld: null, view: null, tentative: null, ...over,
});

/** A TXN body (kind and openMono are the table's). */
export const txnOf = (toolUseId: string, over?: Partial<Txn>): Omit<Txn, 'kind' | 'openMono'> => ({
  toolUseId, seatId: RIG_SEAT, agentId: null, sessionId: 's1', tool: 'Bash' as const, foldHeight: 0, sOpen: {},
  approximate: false, background: false, csId: null, view: null, ...over,
});
