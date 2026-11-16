// src/claude/daemon/leases.ts — the lease table (06 §3.7.1–§3.7.4, CCI-20…CCI-22, CCI-24, INV-CCI-LEASE, O-LEASE).
// Task 8: the real bodies and the `lease.release` step. INFLIGHT is the G2/G3 fence (keyed by tool_use_id), READ is
// CCI-21's full-read lease (one per (seat, path), renewed on hook activity ≤ 3 times, hard cap 300 s), TXN is the
// shell/monitor transaction (CCI-22). Every lifecycle change emits a trace `lease` event (acquire, renew, release
// with why). All times come from the Clock port (L-CLOCK).
import { C } from '../wire/constants.js';
import { registerStep } from './pipeline.js';
import type { Clock } from '../../ports/clock.js';
import type { Trace } from '../../ports/trace.js';
import { nullLog, type Log } from '../../ports/log.js';
import { sameStat, type Fs, type FsLstat } from '../../ports/fs.js';
import { ABSENT, type OidOrAbsent } from '../../git/oid.js';
import type { ClaimViewCopy, PredictResultCopy } from './claudeDaemon.js';
import type { HeldRead, DiskSnapshot, DiskSnapshots } from './hookRead.js';
import type { ShellTool } from '../wire/frames.js';
import type { HookRequest, DaemonCtx } from './ctx.js';

export type ReleaseWhy = 'post' | 'post_failure' | 'permission_denied' | 'batch' | 'new_turn' | 'stop' | 'stop_failure' | 'session_end' | 'subagent_stop'
  | 'seat_end' | 'backstop' | 'cap' | 'background_return' | 'next_edit_post' | 'synthetic_done';

export interface InflightLease { kind: 'INFLIGHT'; toolUseId: string; seatId: string; agentId: string | null; sessionId: string; path: string; acquiredMono: number;
  foldHeight: number; pre: DiskSnapshot | null; approximate: boolean; synthetic: boolean;   // synthetic: cowork_resolve restore (06 §3.16.3)
  preHeld: HeldRead | null;     // A8-2: the gate passes its HeldRead with pre: null; after the reply it settles it and calls setPre
  view: ClaimViewCopy | null;       // X-20: the claim view read at the Pre (filled by Task 10's gate)
  tentative: PredictResultCopy | null; }   // X-20 (Plan 4 C-5): the predicted TENTATIVE claims of this G2/G3 — Plan 5 fence state, discarded at the lease's release

export interface ReadLease { kind: 'READ'; seatId: string; path: string; firstMono: number; expiresMono: number; renewals: number; }

export interface Txn { kind: 'TXN'; toolUseId: string; seatId: string; agentId: string | null; sessionId: string; tool: ShellTool; openMono: number; foldHeight: number;
  sOpen: Readonly<Record<string, OidOrAbsent>>; approximate: boolean; background: boolean; csId: string | null;
  view: ClaimViewCopy | null;     // X-20: the claim view read when the TXN opened (K2 at close against it)
  preDirty?: ReadonlySet<string>; }   // additive (CCI-22, F2 #34): files dirty against S_open at the open (scanTxnOpen); absent = none

type TxnSub = (t: Txn, why: ReleaseWhy) => Promise<void>;
type ExpiredSub = (l: InflightLease) => void;
type LeaseKind = 'INFLIGHT' | 'READ' | 'TXN';

/** A failure's text for DAEMON_INTERNAL_ERROR: name and message only, never a stack or file content (R-37). */
const errText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : 'unknown');

export class LeaseTable {
  /** The trace peer (O-LEASE rows carry it); the composition sets it to the daemon's peer id. */
  peer = '';

  private readonly inflights = new Map<string, InflightLease>();
  private readonly readLeases = new Map<string, Map<string, ReadLease>>();   // seatId → (path → lease)
  private readonly txns = new Map<string, Txn>();
  private readonly txnSubs = new Set<TxnSub>();
  private readonly expiredSubs = new Set<ExpiredSub>();
  private readonly expiryTimes = new Map<string, number[]>();             // seatId → INFLIGHT backstop expiry monos

  /** `reads` gets every INFLIGHT lease's images back at its release (F2 #47, #59); `log` (additive) records subscriber
   *  failures as DAEMON_INTERNAL_ERROR (F2 #110). */
  constructor(private readonly clock: Clock, private readonly trace: Trace, private readonly reads: DiskSnapshots, private readonly log: Log = nullLog) { }

  /** A subscriber or image-release failure: logged, never thrown into the caller (F2 #110, #59). */
  private fail(where: string, e: unknown): void {
    try {
      this.log.write('error', 'DAEMON_INTERNAL_ERROR', { where, error: errText(e) });
    } catch {
      // a failing log never breaks the lease table
    }
  }

  /** Returns an INFLIGHT lease's images to DiskSnapshots at its release (06 §3.7.1 "deleted at release"; F2 #47): the
   *  gate's unsettled hold, and the settled pre-image's reference. The lease object keeps its fields (callers may still
   *  read its metadata). */
  private returnImages(l: InflightLease): void {
    if (l.preHeld !== null) this.reads.unhold(l.preHeld);
    if (l.pre !== null) void this.reads.release(l.pre).catch((e: unknown) => this.fail('leases.release', e));
  }

  private emit(seat: string, lease: LeaseKind, key: string, path: string | null, op: 'acquire' | 'renew' | 'release', why: string | null): void {
    this.trace.emit({ kind: 'lease', peer: this.peer, seat, lease, key, path, op, why });
  }

  private now(): number {
    return this.clock.monoMs();
  }

  /** CCI-20: after G2/G3 only (a denied call takes none); keyed by tool_use_id, refcounted per path (two leases may
   *  hold one path; fencedPaths dedupes); pre-image by one short read (the gate holds it — A8-2); never released by
   *  the seat's next PreToolUse. */
  acquireInflight(l: Omit<InflightLease, 'kind' | 'acquiredMono'>): InflightLease {
    const lease: InflightLease = { ...l, kind: 'INFLIGHT', acquiredMono: this.now() };
    this.inflights.set(lease.toolUseId, lease);
    this.emit(lease.seatId, 'INFLIGHT', lease.toolUseId, lease.path, 'acquire', null);
    return lease;
  }

  /** A8-2: the gate settles its HeldRead after the reply and hands the snapshot (its reference) over. A lease already
   *  released owns nothing: the snapshot is released at once; a lease's previous pre-image reference is returned (F2 #47). */
  setPre(toolUseId: string, pre: DiskSnapshot): void {
    const l = this.inflights.get(toolUseId);
    if (l === undefined) {
      void this.reads.release(pre).catch((e: unknown) => this.fail('leases.release', e));
      return;
    }
    if (l.pre !== null) void this.reads.release(l.pre).catch((e: unknown) => this.fail('leases.release', e));
    (l as { pre: DiskSnapshot | null }).pre = pre;
    (l as { preHeld: HeldRead | null }).preHeld = null;
  }

  /** CCI-21: a full Read (no offset/limit, not truncated) of a LIVE path (A12-8); 120 s, renewed on the seat's hook
   *  activity ≤ 3 times, hard cap 300 s; released by the seat's next edit-class Post on the path. There is no API to
   *  lease a ranged read (ranged reads are ReadSets records). Re-acquiring a live (seat, path) lease returns it. */
  acquireRead(seatId: string, path: string): ReadLease {
    let perSeat = this.readLeases.get(seatId);
    if (perSeat === undefined) {
      perSeat = new Map();
      this.readLeases.set(seatId, perSeat);
    }
    const existing = perSeat.get(path);
    if (existing !== undefined) return existing;
    const now = this.now();
    const lease: ReadLease = { kind: 'READ', seatId, path, firstMono: now, expiresMono: now + C.READ_LEASE_MS, renewals: 0 };
    perSeat.set(path, lease);
    this.emit(seatId, 'READ', path, path, 'acquire', null);
    return lease;
  }

  /** CCI-20/CCI-21: the seat's hook activity renews every READ lease (≤ 3 renewals, never past the hard cap). A renewal
   *  counts only when it moves the expiry (the acquiring step's own renewal and one at the hard cap extend nothing: no
   *  count, no trace row); a lease at or past its expiry is never renewed back — the next expire() releases it as
   *  backstop (Ruling t8a-5, F2 #58, #109). */
  renewReads(seatId: string): void {
    const perSeat = this.readLeases.get(seatId);
    if (perSeat === undefined) return;
    const now = this.now();
    for (const lease of perSeat.values()) {
      if (now >= lease.expiresMono) continue;
      if (lease.renewals >= C.READ_LEASE_RENEWALS) continue;
      const capped = Math.min(lease.firstMono + C.READ_LEASE_HARD_CAP_MS, now + C.READ_LEASE_MS);
      if (capped <= lease.expiresMono) continue;
      (lease as { renewals: number; expiresMono: number }).renewals = lease.renewals + 1;
      (lease as { expiresMono: number }).expiresMono = capped;
      this.emit(seatId, 'READ', lease.path, lease.path, 'renew', null);
    }
  }

  /** A8-3: the seat's next edit-class Post on the path releases its READ lease. */
  releaseRead(seatId: string, path: string, why: ReleaseWhy): ReadLease | null {
    const perSeat = this.readLeases.get(seatId);
    if (perSeat === undefined) return null;
    const lease = perSeat.get(path);
    if (lease === undefined) return null;
    perSeat.delete(path);
    if (perSeat.size === 0) this.readLeases.delete(seatId);
    this.emit(seatId, 'READ', path, path, 'release', why);
    return lease;
  }

  /** A8-3: every TXN release, with its why (post, post_failure, permission_denied, background_return, new_turn, stop,
   *  stop_failure, session_end, seat_end, cap); Task 12 subscribes closeTxn. */
  onTxnClosed(cb: (t: Txn, why: ReleaseWhy) => Promise<void>): () => void {
    this.txnSubs.add(cb);
    return () => {
      this.txnSubs.delete(cb);
    };
  }

  /** Additive: the INFLIGHT backstop expiries. The composition (claudeDaemon.ts) subscribes AttributionWindows.onExpiry
   *  with writerWroteAfter(l.path, l.acquiredMono) for the R5-27 taint (F2 #103). */
  onExpired(cb: (l: InflightLease) => void): () => void {
    this.expiredSubs.add(cb);
    return () => {
      this.expiredSubs.delete(cb);
    };
  }

  /** CCI-22: at PreToolUse(Bash|PowerShell|Monitor) after the advisory checks; S_open = the newest snapshot before the
   *  reply (Task 10's gate fills it — the lease stores what the gate computed with scanTxnOpen): `sOpen`, `approximate`
   *  (the 20 ms stat bound) and `preDirty` (the files dirty against S_open, which keep their pre-window attribution;
   *  absent = none) (F2 #34). */
  openTxn(t: Omit<Txn, 'kind' | 'openMono'>): Txn {
    const txn: Txn = { ...t, kind: 'TXN', openMono: this.now() };
    this.txns.set(txn.toolUseId, txn);
    this.emit(txn.seatId, 'TXN', txn.toolUseId, null, 'acquire', null);
    return txn;
  }

  inflight(toolUseId: string): InflightLease | null {
    return this.inflights.get(toolUseId) ?? null;
  }

  txn(toolUseId: string): Txn | null {
    return this.txns.get(toolUseId) ?? null;
  }

  /** Releases the INFLIGHT lease or TXN of toolUseId (a TXN close fires the onTxnClosed subscribers); the lease's
   *  tentative claim state is dropped with it (Plan 4 C-5). */
  release(toolUseId: string, why: ReleaseWhy): InflightLease | Txn | null {
    const l = this.inflights.get(toolUseId);
    if (l !== undefined) {
      this.inflights.delete(toolUseId);
      (l as { tentative: PredictResultCopy | null }).tentative = null;
      this.returnImages(l);
      this.emit(l.seatId, 'INFLIGHT', toolUseId, l.path, 'release', why);
      return l;
    }
    const t = this.txns.get(toolUseId);
    if (t !== undefined) {
      this.txns.delete(toolUseId);
      this.emit(t.seatId, 'TXN', toolUseId, null, 'release', why);
      this.fireTxnClosed(t, why);
      return t;
    }
    return null;
  }

  /** Every subscriber is called synchronously (its body runs before the release returns); a throw or a rejection is
   *  logged as DAEMON_INTERNAL_ERROR, never swallowed silently, and the next subscriber still runs (F2 #110, #59). */
  private fireTxnClosed(t: Txn, why: ReleaseWhy): void {
    for (const cb of [...this.txnSubs]) {
      try {
        void Promise.resolve(cb(t, why)).catch((e: unknown) => this.fail('leases.onTxnClosed', e));
      } catch (e) {
        this.fail('leases.onTxnClosed', e);
      }
    }
  }

  /** Releases every lease and TXN of the seat matching the scope (sessionId / agentId filters; empty = all), with
   *  why; returns what was released. A seat end also ends its TXN windows. */
  releaseSeat(seatId: string, scope: { sessionId?: string; agentId?: string }, why: ReleaseWhy): ReadonlyArray<InflightLease | Txn | ReadLease> {
    const out: Array<InflightLease | Txn | ReadLease> = [];
    for (const l of [...this.inflights.values()]) {
      if (l.seatId !== seatId) continue;
      if (scope.sessionId !== undefined && l.sessionId !== scope.sessionId) continue;
      if (scope.agentId !== undefined && l.agentId !== scope.agentId) continue;
      out.push(this.release(l.toolUseId, why) as InflightLease);
    }
    for (const t of [...this.txns.values()]) {
      if (t.seatId !== seatId) continue;
      if (scope.sessionId !== undefined && t.sessionId !== scope.sessionId) continue;
      if (scope.agentId !== undefined && t.agentId !== scope.agentId) continue;
      out.push(this.release(t.toolUseId, why) as Txn);
    }
    const perSeat = this.readLeases.get(seatId);
    if (perSeat !== undefined) {
      for (const lease of [...perSeat.values()]) {
        if (scope.sessionId !== undefined || scope.agentId !== undefined) break;   // READ leases are seat-wide, not per session/agent
        out.push(this.releaseRead(seatId, lease.path, why) as ReadLease);
      }
    }
    if (why === 'seat_end') this.expiryTimes.delete(seatId);   // an ended seat's expiry counter goes with it (F2 #57)
    return out;
  }

  /** Backstops: INFLIGHT 120 s (CCI-24 expiry facts returned), READ 120 s / 300 s, TXN cap 120 s (closed as 'cap').
   *  Expiry instants older than a seat-hour are dropped here (the counter is bounded with uptime, F2 #57). */
  expire(): { expired: InflightLease[]; capped: Txn[]; reads: ReadLease[] } {
    const now = this.now();
    const expired: InflightLease[] = [];
    const capped: Txn[] = [];
    const expiredReads: ReadLease[] = [];
    for (const l of [...this.inflights.values()]) {
      if (now < l.acquiredMono + C.INFLIGHT_BACKSTOP_MS) continue;
      this.inflights.delete(l.toolUseId);
      (l as { tentative: PredictResultCopy | null }).tentative = null;
      this.returnImages(l);
      this.emit(l.seatId, 'INFLIGHT', l.toolUseId, l.path, 'release', 'backstop');
      const times = this.expiryTimes.get(l.seatId) ?? [];
      times.push(now);
      this.expiryTimes.set(l.seatId, times);
      expired.push(l);
      for (const cb of [...this.expiredSubs]) {
        try {
          cb(l);
        } catch (e) {
          this.fail('leases.onExpired', e);   // the other subscribers and the rest of expire() still run (F2 #110)
        }
      }
    }
    for (const t of [...this.txns.values()]) {
      if (now < t.openMono + C.TXN_CAP_MS) continue;
      this.txns.delete(t.toolUseId);
      this.emit(t.seatId, 'TXN', t.toolUseId, null, 'release', 'cap');
      capped.push(t);
      this.fireTxnClosed(t, 'cap');
    }
    for (const [seatId, perSeat] of [...this.readLeases]) {
      for (const lease of [...perSeat.values()]) {
        if (now < lease.expiresMono) continue;
        perSeat.delete(lease.path);
        this.emit(seatId, 'READ', lease.path, lease.path, 'release', 'backstop');
        expiredReads.push(lease);
      }
      if (perSeat.size === 0) this.readLeases.delete(seatId);
    }
    for (const [seatId, times] of [...this.expiryTimes]) {
      const keep = times.filter((t) => now - t <= C.SEAT_HOUR_MS);
      if (keep.length === 0) this.expiryTimes.delete(seatId);
      else if (keep.length !== times.length) this.expiryTimes.set(seatId, keep);
    }
    return { expired, capped, reads: expiredReads };
  }

  /** The fence: every INFLIGHT path → 'fence', every READ path → 'read_lease' (the engine's tickSkip ∪ fenced and
   *  the defer set's first rows). */
  fencedPaths(): ReadonlyMap<string, 'fence' | 'read_lease'> {
    const out = new Map<string, 'fence' | 'read_lease'>();
    for (const l of this.inflights.values()) out.set(l.path, 'fence');
    for (const perSeat of this.readLeases.values()) {
      for (const lease of perSeat.values()) if (!out.has(lease.path)) out.set(lease.path, 'read_lease');
    }
    return out;
  }

  txnOpen(): boolean {
    return this.txns.size > 0;
  }

  txnOpenSinceMono(): number | null {
    let oldest: number | null = null;
    for (const t of this.txns.values()) if (oldest === null || t.openMono < oldest) oldest = t.openMono;
    return oldest;
  }

  openFor(seatId: string): { inflight: number; txns: number } {
    let inflight = 0;
    for (const l of this.inflights.values()) if (l.seatId === seatId) inflight += 1;
    let txns = 0;
    for (const t of this.txns.values()) if (t.seatId === seatId) txns += 1;
    return { inflight, txns };
  }

  /** Additive (attribution's input, 06 §3.8.3): the live INFLIGHT leases on one path. */
  inflightOn(path: string): ReadonlyArray<InflightLease> {
    const out: InflightLease[] = [];
    for (const l of this.inflights.values()) if (l.path === path) out.push(l);
    return out;
  }

  /** Additive (attribution's input): every open TXN — a TXN window is worktree-wide, so it overlaps every path. */
  txnsAll(): ReadonlyArray<Txn> {
    return [...this.txns.values()];
  }

  /** Additive (DeferSet's read_lease tag input, F2 #53): the live READ leases on one path, every seat's. */
  readsOn(path: string): ReadonlyArray<ReadLease> {
    const out: ReadLease[] = [];
    for (const perSeat of this.readLeases.values()) {
      const l = perSeat.get(path);
      if (l !== undefined) out.push(l);
    }
    return out;
  }

  /** The seat's INFLIGHT backstop expiries of the last seat-hour; > EXPIRED_LEASES_DOCTOR_PER_SEAT_HOUR flags doctor (Plan 7). */
  expiredPerSeatHour(seatId: string): number {
    const now = this.now();
    const times = (this.expiryTimes.get(seatId) ?? []).filter((t) => now - t <= C.SEAT_HOUR_MS);
    if (times.length === 0) this.expiryTimes.delete(seatId);   // a queried seat with none leaves no empty row (F2 #57)
    else this.expiryTimes.set(seatId, times);
    return times.length;
  }

  /** Additive diagnostics (F2 #57): the table's sizes (live INFLIGHT leases, open TXNs, seats with READ leases, READ
   *  leases, seats with recorded expiry instants). */
  stateSizes(): { inflights: number; txns: number; readSeats: number; reads: number; expirySeats: number } {
    let reads = 0;
    for (const perSeat of this.readLeases.values()) reads += perSeat.size;
    return { inflights: this.inflights.size, txns: this.txns.size, readSeats: this.readLeases.size, reads, expirySeats: this.expiryTimes.size };
  }
}

// ---- The TXN open-time scan (CCI-22, 06 §3.7.3) -----------------------------------------------------------------------

/** CCI-22 (06 §3.7.3): the stat scan Task 10's gate runs before openTxn. S_open = every entry of the newest completed
 *  snapshot (EngineView.snapshotEntries(): the private index's entries, oid and the stat it recorded). Each entry is
 *  lstat'ed through the Fs port in map order, bounded at TXN_DIRTY_STAT_BOUND_MS of clock time: a file already dirty
 *  against S_open is pre-dirty (it keeps its pre-window attribution, Txn.preDirty); when the bound is reached the window
 *  is approximate and the remaining entries stay unstatted (gap writes are attributed to the seat). An undecidable entry
 *  — an lstat error, or a tracked entry with no recorded stat whose file is present — is not pre-dirty and marks the
 *  window approximate: the spec's safe side (Ruling t8a-6, F2 #34). */
export async function scanTxnOpen(
  fs: Fs,
  clock: Clock,
  entries: ReadonlyMap<string, { oid: OidOrAbsent; stat: FsLstat | null }>,
  absOf: (path: string) => string,
): Promise<{ sOpen: Record<string, OidOrAbsent>; preDirty: ReadonlySet<string>; approximate: boolean; statted: number }> {
  const sOpen: Record<string, OidOrAbsent> = Object.fromEntries([...entries].map(([p, e]) => [p, e.oid]));
  const preDirty = new Set<string>();
  let approximate = false;
  let statted = 0;
  const t0 = clock.monoMs();
  for (const [p, e] of entries) {
    if (clock.monoMs() - t0 >= C.TXN_DIRTY_STAT_BOUND_MS) {
      approximate = true;
      break;
    }
    statted += 1;
    let cur: FsLstat | null;
    try {
      cur = await fs.lstat(absOf(p));
    } catch {
      approximate = true;
      continue;
    }
    if (cur === null) {
      if (e.oid !== ABSENT) preDirty.add(p);       // a tracked file deleted since S_open
    } else if (e.stat === null) {
      if (e.oid === ABSENT) preDirty.add(p);       // an absent entry whose file now exists
      else approximate = true;                     // no baseline stat: undecidable
    } else if (!sameStat(e.stat, cur)) {
      preDirty.add(p);
    }
  }
  return { sOpen, preDirty, approximate, statted };
}

// ---- The `lease.release` step (CCI-20, CCI-21, CCI-37 mid-turn rule, R1-502…R1-504; A8-4) ----------------------------

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** The per-event release rules: every event that runs the step renews the seat's READ leases first (CCI-20/CCI-21);
 *  a new-turn UserPromptSubmit (never the nonce-carrying doorbell one) and Stop/StopFailure release everything and
 *  close the turn boundary; an edit-class Post releases the READ lease of that path; SessionEnd keeps only that
 *  session's; SubagentStop keeps only that agent's; PostToolBatch releases every listed id. */
registerStep('lease.release', (r: HookRequest, _d, ctx: DaemonCtx): Promise<void> => {
  const seat = r.seat;
  const seatId = seat.seatId;
  const leases = ctx.leases;
  if (seatId !== null) leases.renewReads(seatId);
  const h = r.frame.h;
  const p = r.frame.payload;
  switch (p.event) {
    case 'UserPromptSubmit': {
      // turn.prompt ran before this step (STEP_ORDER); a doorbell turn releases nothing (CCI-37 mid-turn rule).
      if (r.turn === null || r.turn.doorbell) return Promise.resolve();
      if (!r.turn.newTurn) return Promise.resolve();
      if (seatId !== null) {
        leases.releaseSeat(seatId, { }, 'new_turn');   // the new turn releases all of the seat's leases and TXNs
        ctx.defer.onTurnBoundary(seatId);
      }
      return Promise.resolve();
    }
    case 'PostToolUse': {
      const id = p.tool_use_id;
      const txn = leases.txn(id);
      if (txn !== null) leases.release(id, txn.background ? 'background_return' : 'post');
      else if (leases.inflight(id) !== null) leases.release(id, 'post');
      if (seatId !== null && EDIT_TOOLS.has(p.tool_name) && p.path !== null) {
        leases.releaseRead(seatId, p.path, 'next_edit_post');
      }
      return Promise.resolve();
    }
    case 'PostToolUseFailure':
    case 'PermissionDenied': {
      leases.release(p.tool_use_id, p.event === 'PostToolUseFailure' ? 'post_failure' : 'permission_denied');
      return Promise.resolve();
    }
    case 'PostToolBatch': {
      for (const id of p.tool_use_ids) leases.release(id, 'batch');
      return Promise.resolve();
    }
    case 'Stop':
    case 'StopFailure': {
      if (seatId !== null) {
        leases.releaseSeat(seatId, { }, r.frame.event === 'Stop' ? 'stop' : 'stop_failure');   // Stop/StopFailure release all of the seat's
        ctx.defer.onTurnBoundary(seatId);
        ctx.windows.onSeatBoundary(seatId);   // R5-29: the seat's Stop/StopFailure ends its late-write tags
      }
      return Promise.resolve();
    }
    case 'SessionEnd': {
      if (seatId !== null) leases.releaseSeat(seatId, { sessionId: h.session_id }, 'session_end');
      return Promise.resolve();
    }
    case 'SubagentStop': {
      if (seatId !== null && h.agent_id !== null) leases.releaseSeat(seatId, { agentId: h.agent_id }, 'subagent_stop');
      return Promise.resolve();
    }
    default:
      return Promise.resolve();
  }
});
