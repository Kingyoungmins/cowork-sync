// src/claude/daemon/defer.ts — the ClaudeEnginePort binding (CCI-23, ENG-31, 01 §3.11, R5-25). Task 8: the real
// bodies. deferred() is recomputed per call from memory (leases, ctx.health.degradedPaths, ctx.readSets.fullReadSet,
// seat activity and lastHookMono, meter.inPullMode, the last-apply instants); it never reads a file. A coalesced or
// DEGRADED path enters D with the existing reason read_lease (R5-25); meta.pending's schema and parseMeta are
// unchanged (the engine writes them). `conflicted_leased` is chosen by the engine's admission, not here.
import { C } from '../wire/constants.js';
import type { ClaudeEnginePort, AppliedPath } from '../../engine/deps.js';
import type { DeferReason } from '../../holds/groups.js';
import type { DaemonCtx } from './ctx.js';
import type { DeferTag, DeferSource } from './claudeDaemon.js';

export type { DeferTag, DeferSource };

export class DeferSet implements ClaudeEnginePort {
  private readonly appliedSubs = new Set<(detail: ReadonlyArray<AppliedPath>) => void>();
  /** seatId → Δmono of the last applied() into that seat's full-read set (R5-25's instant). */
  private readonly lastApplyIntoReadSet = new Map<string, number>();
  /** seatId → an apply landed into the pull-mode seat's read set since its last turn boundary (deferred again). */
  private readonly pullAppliedSince = new Map<string, boolean>();

  /** Phase 3a-1: the composition passes the ctx. */
  constructor(private readonly ctx: DaemonCtx) { }

  txnOpen(): boolean {
    return this.ctx.leases.txnOpen();
  }

  deferred(): ReadonlyMap<string, DeferReason> {
    return this.compute().map;
  }

  /** F14 (R5-53): per path its source, seat number and instants, for I3/I4a/I4b; memory only. */
  tags(): ReadonlyMap<string, DeferTag> {
    return this.compute().tags;
  }

  private compute(): { map: Map<string, DeferReason>; tags: Map<string, DeferTag> } {
    const now = this.ctx.ports.clock.monoMs();
    const map = new Map<string, DeferReason>();
    const tags = new Map<string, DeferTag>();
    for (const [path, why] of this.ctx.leases.fencedPaths()) {
      map.set(path, why);
      const origin = this.leaseOrigin(path, why);
      tags.set(path, { path, reason: why, source: why, seatNumber: origin === null ? null : this.seatNumberOf(origin.seatId), sinceMono: origin?.sinceMono ?? now, lastApplyIntoReadSetMono: null });
    }
    // R5-25: a path in a DEGRADED seat's 30-min read or edit set enters D as read_lease with source 'degraded'.
    for (const [path, seatId] of this.ctx.health.degradedPaths()) {
      if (map.has(path)) continue;
      map.set(path, 'read_lease');
      tags.set(path, { path, reason: 'read_lease', source: 'degraded', seatNumber: this.seatNumberOf(seatId), sinceMono: now, lastApplyIntoReadSetMono: null });
    }
    // R5-25 coalescing: a MID_TURN (by activity, hook in the last 60 s) seat's full-read set applies at most one per
    // 2 min; a PULL_MODE seat's read set applies only at its Stop or UserPromptSubmit (the turn boundary).
    for (const s of this.ctx.seats.seats()) {
      const source = this.coalescingSource(s.seat_id);
      if (source === null) continue;
      const lastApply = this.lastApplyIntoReadSet.get(s.seat_id) ?? null;
      const deferred = source === 'coalesce_pull_mode'
        ? this.pullAppliedSince.get(s.seat_id) ?? true
        : lastApply !== null && now - lastApply < C.READSET_APPLY_SPACING_MS;
      if (!deferred) continue;
      for (const path of this.ctx.readSets.fullReadSet(s.seat_id)) {
        if (map.has(path)) continue;
        map.set(path, 'read_lease');
        tags.set(path, { path, reason: 'read_lease', source, seatNumber: s.number, sinceMono: now, lastApplyIntoReadSetMono: lastApply });
      }
    }
    return { map, tags };
  }

  /** The coalescing source of the seat, or null when it coalesces nothing now (R5-25, F14's I4a/I4b inputs). */
  private coalescingSource(seatId: string): 'coalesce_mid_turn' | 'coalesce_pull_mode' | null {
    if (this.ctx.meter.inPullMode(seatId)) return 'coalesce_pull_mode';
    const seat = this.ctx.seats.bySeatId(seatId);
    if (seat === null) return null;
    if (this.ctx.seats.seatActivity(seatId) !== 'MID_TURN') return null;
    if (seat.lastHookMono === null || this.ctx.ports.clock.monoMs() - seat.lastHookMono > C.MID_TURN_TRAFFIC_MS) return null;
    return 'coalesce_mid_turn';
  }

  /** F14 (plan:2975): a fence row names its oldest INFLIGHT lease (seat, acquisition instant), a read_lease row its
   *  oldest READ lease (seat, first acquisition) (F2 #53). */
  private leaseOrigin(path: string, why: 'fence' | 'read_lease'): { seatId: string; sinceMono: number } | null {
    let best: { seatId: string; sinceMono: number } | null = null;
    if (why === 'fence') {
      for (const l of this.ctx.leases.inflightOn(path)) if (best === null || l.acquiredMono < best.sinceMono) best = { seatId: l.seatId, sinceMono: l.acquiredMono };
    } else {
      for (const l of this.ctx.leases.readsOn(path)) if (best === null || l.firstMono < best.sinceMono) best = { seatId: l.seatId, sinceMono: l.firstMono };
    }
    return best;
  }

  private seatNumberOf(seatId: string): number | null {
    return this.ctx.seats.bySeatId(seatId)?.number ?? null;
  }

  /** A subscriber failure: logged as DAEMON_INTERNAL_ERROR (name and message only, never content, R-37), never thrown
   *  into the engine step that called applied() (Ruling t8a-10, F2 #110). A ctx without a log (a test stub) is fine. */
  private fail(where: string, e: unknown): void {
    try {
      this.ctx.log.write('error', 'DAEMON_INTERNAL_ERROR', { where, error: e instanceof Error ? `${e.name}: ${e.message}` : 'unknown' });
    } catch {
      // no log, or a failing one: the fan-out goes on
    }
  }

  /** P1 re-check of one write group (a fence or TXN opened after J): the lease table's fences, else a TXN open on
   *  the worktree → txn for every remaining path. Memory only. */
  recheck(paths: readonly string[]): ReadonlyMap<string, DeferReason> {
    const out = new Map<string, DeferReason>();
    const fences = this.ctx.leases.fencedPaths();
    for (const p of paths) {
      const why = fences.get(p);
      if (why !== undefined) {
        out.set(p, why);
        continue;
      }
      if (this.ctx.leases.txnOpen()) out.set(p, 'txn');
    }
    return out;
  }

  /** INFLIGHT-fenced paths: never re-read by a tick (TickInput.skip, ENG-23) — the lease table's 'fence' rows. */
  fenced(): ReadonlySet<string> {
    const out = new Set<string>();
    for (const [path, why] of this.ctx.leases.fencedPaths()) if (why === 'fence') out.add(path);
    return out;
  }

  /** A8-5: after every written group, once — the last-apply instant per seat whose full-read set holds one of the
   *  paths (R5-25's coalescing input) and the onApplied fan-out (Task 12's ApplyJournal subscribes). The engine calls
   *  this after the group is on disk and before its state update (apply.ts), so every subscriber is isolated: a throw
   *  is logged and the next subscriber still runs (F2 #110). */
  applied(paths: readonly string[], detail?: ReadonlyArray<AppliedPath>): void {
    const now = this.ctx.ports.clock.monoMs();
    for (const s of this.ctx.seats.seats()) {
      const set = this.ctx.readSets.fullReadSet(s.seat_id);
      for (const p of paths) {
        if (!set.has(p)) continue;
        this.lastApplyIntoReadSet.set(s.seat_id, now);
        if (this.ctx.meter.inPullMode(s.seat_id)) this.pullAppliedSince.set(s.seat_id, true);
        break;
      }
    }
    const payload = detail ?? [];
    for (const cb of [...this.appliedSubs]) {
      try {
        cb(payload);
      } catch (e) {
        this.fail('defer.onApplied', e);
      }
    }
  }

  /** A8-4: called by lease.release at a Stop, StopFailure or new-turn UserPromptSubmit (PULL_MODE applies) — the
   *  pull-mode seat's read set may apply again until its next applied(). */
  onTurnBoundary(seatId: string): void {
    this.pullAppliedSince.set(seatId, false);
  }

  /** A8-4: fan-out of applied(); returns the unsubscribe. */
  onApplied(cb: (detail: ReadonlyArray<AppliedPath>) => void): () => void {
    this.appliedSubs.add(cb);
    return () => {
      this.appliedSubs.delete(cb);
    };
  }
}
