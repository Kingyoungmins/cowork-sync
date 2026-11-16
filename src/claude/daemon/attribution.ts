// src/claude/daemon/attribution.ts — the attribution windows and the AttributionPort binding (06 §3.8.3, CCI-24, CCI-27,
// HLD-26, HLD-35, R5-27…R5-29). Task 8: the real bodies. One rule set (CCI-27): INFLIGHT call, TXN window, 3 s
// formatter grace, else human-class. R5-28 is the binding; R5-27's expiry taint is path-level until the seat's next
// confirmed edit Post on the path (never the expired call's own Post, never another seat's), and it is set by a writer
// write that lands after the acquisition — while the lease lived, or after its expiry (the fence holds the writer's
// apply until then: 06 test 19's order); R5-29's late writes carry a display-only seat tag until the seat's next
// Stop/StopFailure or its seat end. A seat end releases every lease (the composition's onEnd wire), so a window of a
// dead seat does not outlive its release; the grace's ≤ 3 s tail is bounded and display-safe. Memory only, bounded with
// uptime (prune); all times from the Clock port.
import { C } from '../wire/constants.js';
import type { Clock } from '../../ports/clock.js';
import type { AttributionPort, AppliedPath } from '../../engine/deps.js';
import type { ReleaseWhy, InflightLease, Txn, LeaseTable } from './leases.js';

export interface Attributed { seatId: string; agentId: string | null; csId: string | null; toolUseId: string | null; via: 'inflight' | 'txn' | 'grace'; }

interface GraceRecord { seatId: string; path: string; untilMono: number; }
/** A12-4: a TXN closed by its own call keeps answering removal/hook attribution for the paths closeTxn attributed. */
interface ClosedRecord { seatId: string; agentId: string | null; csId: string | null; toolUseId: string | null; paths: Set<string>; untilMono: number; }
/** R5-29: a late window opened by a cap or background-return close; the tag names the seat until the boundary. */
interface LateRecord { seatId: string; sinceMono: number; }
/** R5-27: the expired call that tainted a path (only its seat's next edit Post of another call clears it). */
interface TaintRecord { seatId: string; toolUseId: string; sinceMono: number; }
/** R5-27: an expiry with no writer write after the acquisition yet — a later writer write on the path promotes it. */
interface Candidate { path: string; seatId: string; toolUseId: string; acquiredMono: number; }

const graceKey = (seatId: string, path: string): string => `${seatId}\u0000${path}`;
/** The prune cadence (clock time) of the per-uptime tables (F2 #57). */
const PRUNE_EVERY_MS = 60_000;

export class AttributionWindows {
  /** Additive: the composition injects EngineView.openCsOf (A6-6) so INFLIGHT/grace entries carry the seat's open CS. */
  csOf: (seatId: string, agentId: string | null) => string | null = () => null;

  private readonly graces = new Map<string, GraceRecord>();
  private readonly taints = new Map<string, TaintRecord>();       // R5-27: path → its taint (observedEdit false)
  private readonly candidates = new Map<string, Candidate>();     // R5-27: tool_use_id → an expiry awaiting a writer write
  private readonly writes = new Map<string, number>();            // path → mono of the newest writer write (writerWroteAfter)
  private readonly closed: ClosedRecord[] = [];
  private readonly late: LateRecord[] = [];
  private readonly edited = new Map<string, Map<string, number>>();   // A8-6: seatId → (path → last attributed mono)
  private lastPruneMono = Number.NEGATIVE_INFINITY;

  /** Phase 3a-1: the composition passes the clock and the lease table. */
  constructor(private readonly clock: Clock, private readonly leases: LeaseTable) { }

  /** Opens the 3 s formatter grace. R5-27's "until the seat's next confirmed edit-class Post on it": the path's taint is
   *  cleared only by its own seat's Post of another call — `toolUseId` (additive, optional; null = a caller that does not
   *  know it) equal to the expired call's is that stale call's own late Post and keeps the taint; another seat's Post
   *  keeps it too. The seat's expiry candidates on the path end here (its write landed; a later writer apply merges
   *  over it) (Ruling t8a-1, F2 #103). */
  onEditPost(seatId: string, path: string, toolUseId: string | null = null): void {
    const now = this.clock.monoMs();
    this.prune(now);
    this.graces.set(graceKey(seatId, path), { seatId, path, untilMono: now + C.FORMATTER_GRACE_MS });
    const t = this.taints.get(path);
    if (t !== undefined && t.seatId === seatId && (toolUseId === null || toolUseId !== t.toolUseId)) this.taints.delete(path);
    for (const [id, c] of this.candidates) if (c.seatId === seatId && c.path === path) this.candidates.delete(id);
  }

  /** CCI-24 taint (path-level, R5-27): an INFLIGHT lease expired before its Post. `writerWroteAfterAcquire` (the
   *  composition passes writerWroteAfter(l.path, l.acquiredMono)) true → the path is tainted now; false → a candidate
   *  that the next writer write on the path promotes (onWriterApplied), until the seat's next edit Post on the path or
   *  its boundary (F2 #103). */
  onExpiry(l: InflightLease, writerWroteAfterAcquire: boolean): void {
    const now = this.clock.monoMs();
    this.prune(now);
    if (writerWroteAfterAcquire) this.taints.set(l.path, { seatId: l.seatId, toolUseId: l.toolUseId, sinceMono: now });
    else this.candidates.set(l.toolUseId, { path: l.path, seatId: l.seatId, toolUseId: l.toolUseId, acquiredMono: l.acquiredMono });
  }

  /** Additive (F2 #103): every engine write of a group (DeferSet.applied's detail — incoming writer or not, a deletion
   *  too) records its instant per path and promotes every expiry candidate on the path to a taint (06 test 19: the
   *  writer applies the teammate's change only after the expired fence lets it). */
  onWriterApplied(detail: ReadonlyArray<AppliedPath>): void {
    const now = this.clock.monoMs();
    this.prune(now);
    for (const d of detail) {
      this.writes.set(d.path, now);
      for (const [id, c] of this.candidates) {
        if (c.path !== d.path) continue;
        this.taints.set(c.path, { seatId: c.seatId, toolUseId: c.toolUseId, sinceMono: now });
        this.candidates.delete(id);
      }
    }
  }

  /** Additive (F2 #103): whether a writer write on the path landed at or after `sinceMono` (a lease's acquisition; the
   *  acquisition millisecond counts — the stricter side, Ruling t8a-2). */
  writerWroteAfter(path: string, sinceMono: number): boolean {
    const at = this.writes.get(path);
    return at !== undefined && at >= sinceMono;
  }

  /** After a cap or a background return (R5-29): deltas first seen after this close are human-class with a
   *  display-only seat tag until the seat's next Stop/StopFailure (onSeatBoundary) or its seat end. */
  onTxnClose(t: Txn, why: ReleaseWhy): void {
    if (why === 'cap' || why === 'background_return') this.late.push({ seatId: t.seatId, sinceMono: this.clock.monoMs() });
  }

  /** Additive (R5-29's boundary): the seat's Stop/StopFailure (the lease.release step) and its seat end (the
   *  composition's onEnd wire) clear its late-write tags and end its R5-27 expiry candidates; a taint survives them
   *  (R5-27 has no seat-end clause; the map is bounded by distinct paths) (Ruling t8a-1). */
  onSeatBoundary(seatId: string): void {
    for (let i = this.late.length - 1; i >= 0; i--) if (this.late[i]!.seatId === seatId) this.late.splice(i, 1);
    for (const [id, c] of this.candidates) if (c.seatId === seatId) this.candidates.delete(id);
  }

  /** Every overlapping window of every seat (the stricter result applies to claims and conflicts); null →
   *  human-class. Each answer records the attribution instant (A8-6's editedSince input). */
  attribute(path: string): Attributed[] | null {
    const now = this.clock.monoMs();
    this.prune(now);
    const out: Attributed[] = [];
    for (const l of this.leases.inflightOn(path)) {
      out.push({ seatId: l.seatId, agentId: l.agentId, csId: this.csOf(l.seatId, l.agentId), toolUseId: l.toolUseId, via: 'inflight' });
    }
    for (const t of this.leases.txnsAll()) {
      // CCI-22: a path already dirty against S_open keeps its pre-window attribution — no TXN row (the other rows still
      // apply) (Ruling t8a-7, F2 #34).
      if (t.preDirty?.has(path) === true) continue;
      out.push({ seatId: t.seatId, agentId: t.agentId, csId: t.csId, toolUseId: t.toolUseId, via: 'txn' });
    }
    for (const [key, g] of [...this.graces]) {
      if (g.untilMono <= now) {
        this.graces.delete(key);   // lazy GC of a spent grace
        continue;
      }
      if (g.path === path) out.push({ seatId: g.seatId, agentId: null, csId: this.csOf(g.seatId, null), toolUseId: null, via: 'grace' });
    }
    if (out.length === 0) return null;
    for (const a of out) {
      let perSeat = this.edited.get(a.seatId);
      if (perSeat === undefined) {
        perSeat = new Map();
        this.edited.set(a.seatId, perSeat);
      }
      perSeat.set(path, now);
    }
    return out;
  }

  /** Display-only seat tag of a human-class late write (R5-29, F04); the newest live late window names the seat;
   *  null with no live late window. */
  seatTag(_path: string): string | null {
    let best: LateRecord | null = null;
    for (const r of this.late) if (best === null || r.sinceMono >= best.sinceMono) best = r;
    return best?.seatId ?? null;
  }

  /** A8-6: the seat's attributed paths of the window (Task 9's DEGRADED 30-min edit set input). It answers only within
   *  DEGRADED_SET_WINDOW_MS: older attribution instants are pruned (Ruling t8a-8, F2 #57). */
  editedSince(seatId: string, sinceMono: number): ReadonlySet<string> {
    const out = new Set<string>();
    const perSeat = this.edited.get(seatId);
    if (perSeat === undefined) return out;
    for (const [path, at] of perSeat) if (at > sinceMono) out.add(path);
    return out;
  }

  /** A12-4: a TXN closed by its own call keeps answering removal/hook attribution for the paths closeTxn attributed
   *  until the first detection tick after the close observes them or untilMono (2 loop periods) passes. */
  attributeClosed(t: Txn, paths: readonly string[], untilMono: number): void {
    this.prune(this.clock.monoMs());
    this.closed.push({ seatId: t.seatId, agentId: t.agentId, csId: t.csId, toolUseId: t.toolUseId, paths: new Set(paths), untilMono });
  }

  /** Additive: a valid closed record still covers the path (hookAttributed's A12-4 clause; non-consuming). */
  hasClosed(path: string): boolean {
    const now = this.clock.monoMs();
    return this.closed.some((r) => r.untilMono > now && r.paths.has(path));
  }

  /** Additive: the tick's observation of the path consumes the closed record's entry (A12-4's "until the first
   *  detection tick after the close observes them"); answers whether it answered from one. */
  consumeClosed(path: string): boolean {
    const now = this.clock.monoMs();
    for (let i = 0; i < this.closed.length; i++) {
      const r = this.closed[i]!;
      if (r.untilMono <= now) continue;
      if (!r.paths.delete(path)) continue;
      if (r.paths.size === 0) this.closed.splice(i, 1);
      return true;
    }
    return false;
  }

  /** Additive: the R5-27 expiry taint of the path (observedEdit's consumer). */
  tainted(path: string): boolean {
    return this.taints.has(path);
  }

  /** The state stays bounded with uptime (F2 #57): at most once per PRUNE_EVERY_MS of clock time (from attribute,
   *  onEditPost, onExpiry, onWriterApplied, attributeClosed) spent graces and closed records past their untilMono,
   *  attribution instants older than DEGRADED_SET_WINDOW_MS (and empty seat maps) and writer writes older than two
   *  INFLIGHT backstops (no live lease can ask about them) are dropped. Candidates end at the seat's boundary; taints
   *  are bounded by distinct paths; late tags end at the boundary. */
  private prune(now: number): void {
    if (now - this.lastPruneMono < PRUNE_EVERY_MS) return;
    this.lastPruneMono = now;
    for (const [key, g] of this.graces) if (g.untilMono <= now) this.graces.delete(key);
    const live = this.closed.filter((r) => r.untilMono > now);
    this.closed.length = 0;
    this.closed.push(...live);
    for (const [seatId, perSeat] of this.edited) {
      for (const [p, at] of perSeat) if (now - at > C.DEGRADED_SET_WINDOW_MS) perSeat.delete(p);
      if (perSeat.size === 0) this.edited.delete(seatId);
    }
    for (const [p, at] of this.writes) if (now - at > 2 * C.INFLIGHT_BACKSTOP_MS) this.writes.delete(p);
  }

  /** Additive diagnostics (F2 #57): the sizes of every per-uptime table. */
  stateSizes(): { graces: number; taints: number; candidates: number; closed: number; late: number; editedSeats: number; editedPaths: number; writes: number } {
    let editedPaths = 0;
    for (const perSeat of this.edited.values()) editedPaths += perSeat.size;
    return {
      graces: this.graces.size, taints: this.taints.size, candidates: this.candidates.size, closed: this.closed.length,
      late: this.late.length, editedSeats: this.edited.size, editedPaths, writes: this.writes.size,
    };
  }
}

/** The AttributionPort binding: removalAttributed and observedEdit/hookAttributed per R5-28; shrinkAttributed keeps
 *  Plan 2's R-25 answer (true). observedEdit is true only for edit-class windows (INFLIGHT and grace; a TXN window
 *  is a shell one, taint-checked as UNOBSERVED) minus the R5-27 taints. */
export function hookAttribution(w: AttributionWindows): AttributionPort {
  return Object.freeze({
    removalAttributed: (path: string): boolean => w.attribute(path) !== null || w.consumeClosed(path),
    shrinkAttributed: (_path: string): boolean => true,
    observedEdit: (path: string): boolean => {
      if (w.tainted(path)) return false;
      const a = w.attribute(path);
      return a !== null && a.some((x) => x.via !== 'txn');
    },
    hookAttributed: (path: string): boolean => w.attribute(path) !== null || w.hasClosed(path),
  });
}
