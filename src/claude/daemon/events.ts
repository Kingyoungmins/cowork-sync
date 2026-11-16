// src/claude/daemon/events.ts — the per-seat event store (CCI-41, INV-CCI-DOORBELL, R5-09; 06 §3.14.3, Task 7).
// Pull delivery: events are delivered on printed{batch_id} only; an un-printed batch is re-queued at the seat's
// next hook (V-10) and re-sent in full; a doorbell-carried event is delivered by the nonce UserPromptSubmit only;
// whichever path delivers an event does so exactly once. The store holds open state only (F2 #8): a row lives while
// it is pending, in an un-printed batch, or an addFirst row no seat has claimed yet, and it is deleted the moment it
// is delivered (printed, nonceSeen) or retired; an empty or printed batch, a spent nonce and an ended seat's state
// (dropSeat) go the same way. Memory and every per-hook walk are bounded by the open events, never by history, and
// a delivered id is simply not found again, which is what keeps a repeated printed or a late nonce from delivering
// twice. The pinned constructor stays (clock, random, trace). F2 #9: 'all' and queueSystemMessage mint one event id
// per live seat at call time — the live seats are the bound source (bindLiveSeats) when the composition binds one,
// else the learned set (seats whose most recent nextHook was live, minus dropped seats); a seat that appears later
// and an ended seat get nothing.
import type { Clock } from '../../ports/clock.js';
import type { Random } from '../../ports/random.js';
import type { Trace } from '../../ports/trace.js';
import type { CarrierKind } from './carriers.js';
import type { Params } from './claudeDaemon.js';
import type { DaemonCtx } from './ctx.js';
import type { HoldCodeRaise } from '../../holds/incoming.js';
import { ulid } from '../../ports/random.js';

export interface SeatEvent { id: string; seatId: string; code: string; params: Params; family: string; mandatory: boolean; slot: 'context' | 'system' | 'both'; createdMono: number;
  state: 'pending' | 'in_batch' | 'delivered'; viaNonce: string | null;
  carriers: readonly CarrierKind[] | null; }   // A7-2: null = any exit-0 carrier; Plan 3's four status-only codes use ['post'], the Stop block ['stop']

/** What add / addFirst take: one event without its id, seat or delivery state. */
type NewEvent = { code: string; params: Params; family: string; mandatory: boolean; slot: 'context' | 'system' | 'both'; carriers?: readonly CarrierKind[] | null };

/** One open row. `seat` is the seat it is queued for; null only while an addFirst row waits unclaimed (A7-1).
 *  `nonces` are the doorbell posts that carried it, so deleting the row also empties those nonces. */
interface EventRow { e: Omit<SeatEvent, 'state' | 'seatId'>; seat: string | null; state: 'pending' | 'in_batch'; fromAddFirst: boolean; nonces: Set<string>; }

/** One un-printed batch with at least one event (an empty batch is never stored; its id is still returned). */
interface BatchRow { id: string; seatId: string; ids: readonly string[]; carrier: CarrierKind | null; }

type DeliveredCb = (seatId: string, ids: readonly string[], how: { carrier: CarrierKind | 'doorbell'; batchId: string | null; nonce: string | null }) => void;

export class EventStore {
  private readonly rows = new Map<string, EventRow>();              // id → open row (pending or in an un-printed batch) or an unclaimed addFirst row
  private readonly openBySeat = new Map<string, Set<string>>();     // seatId → its open ids in arrival order (a Set keeps insertion order)
  private readonly unprinted = new Map<string, BatchRow>();         // batch_id → an un-printed batch
  private readonly batchesBySeat = new Map<string, Set<string>>();  // seatId → its un-printed batch ids
  private readonly doorbell = new Map<string, Set<string>>();       // nonce → the open ids it was posted for ('sent' posts only)
  private readonly unclaimed: string[] = [];                        // A7-1: the addFirst row ids no seat has claimed yet, FIFO (F2 #4)
  private readonly liveSrc: (() => Iterable<string>) | null = null; // F2 #9: the composition's bound live-seat source ('all')
  private readonly learned = new Set<string>();                     // F2 #9: unbound fallback — seats whose most recent nextHook was live, minus dropped
  private readonly nudgedCs = new Set<string>();                    // CS_UNPUBLISHED_NUDGE: once per CS; a seat's CS keys go at its dropSeat (F2 #57)
  private readonly mirrored = new Set<string>();                    // HOLD_MIRROR_REJECTED: once per hold id for the daemon run
  private readonly cursorBySeat = new Map<string, number>();
  private readonly subs: DeliveredCb[] = [];

  /** The pinned three-parameter constructor; the store emits no trace of its own (the carrier trace is finishReply's). */
  constructor(private readonly clock: Clock, private readonly random: Random, _trace: Trace) { }

  private mint(o: NewEvent, seat: string | null, fromAddFirst: boolean): string {
    const id = ulid(this.random, this.clock);
    const e: Omit<SeatEvent, 'state' | 'seatId'> = {
      id, code: o.code, params: o.params, family: o.family, mandatory: o.mandatory, slot: o.slot,
      createdMono: this.clock.monoMs(), viaNonce: null, carriers: o.carriers === undefined ? null : o.carriers,
    };
    this.rows.set(id, { e, seat, state: 'pending', fromAddFirst, nonces: new Set() });
    if (seat !== null) this.index(seat, id);
    return id;
  }

  private index(seatId: string, id: string): void {
    let s = this.openBySeat.get(seatId);
    if (s === undefined) { s = new Set(); this.openBySeat.set(seatId, s); }
    s.add(id);
  }

  /** Removes the row's id from every doorbell nonce that carried it; a nonce left with no id is deleted. */
  private unlinkNonces(id: string, row: EventRow): void {
    for (const n of row.nonces) {
      const s = this.doorbell.get(n);
      if (s === undefined) continue;
      s.delete(id);
      if (s.size === 0) this.doorbell.delete(n);
    }
    row.nonces.clear();
  }

  /** Deletes one row (delivered or retired) and every reference to it. */
  private deleteRow(id: string): EventRow | undefined {
    const row = this.rows.get(id);
    if (row === undefined) return undefined;
    this.rows.delete(id);
    if (row.seat !== null) {
      const s = this.openBySeat.get(row.seat);
      if (s !== undefined) { s.delete(id); if (s.size === 0) this.openBySeat.delete(row.seat); }
    } else {
      const i = this.unclaimed.indexOf(id);
      if (i >= 0) this.unclaimed.splice(i, 1);
    }
    this.unlinkNonces(id, row);
    return row;
  }

  private forgetBatch(b: BatchRow): void {
    this.unprinted.delete(b.id);
    const s = this.batchesBySeat.get(b.seatId);
    if (s !== undefined) { s.delete(b.id); if (s.size === 0) this.batchesBySeat.delete(b.seatId); }
  }

  /** One event id per target seat; a concrete seatId queues immediately; '' names no seat, so nothing is stored and
   *  [] is returned (F2 #49). 'all' mints one per-seat row per live seat at call time and returns their ids (F2 #9):
   *  the live seats are the bound source when one is bound, else the learned set. */
  add(seatId: string | 'all', e: NewEvent): string[] {
    if (seatId === '') return [];
    if (seatId === 'all') {
      const live = this.liveSrc !== null ? [...this.liveSrc()] : [...this.learned];
      return live.map((seat) => this.mint(e, seat, false));
    }
    return [this.mint(e, seatId, false)];
  }

  /** F2 #9, additive: binds the composition's live-seat source of 'all' (one call, at composition time). Unbinding
   *  is not a thing: the source lives as long as the daemon. */
  bindLiveSeats(src: () => Iterable<string>): void {
    (this.liveSrc as unknown as (() => Iterable<string>) | null) = src;
  }

  /** A7-1: delivered to the first seat whose exit-0 hook arrives next, once (glossary §25.2 item 9). Every addFirst
   *  row waits in a FIFO until a live seat's next hook claims it; several unclaimed rows go, in order, to that one
   *  seat (F2 #4). A claimed row whose seat ends undelivered goes back to the front of the FIFO (dropSeat). */
  addFirst(e: { code: string; params: Params; family: string; mandatory: boolean; slot: 'context' | 'system' | 'both' }): string {
    const id = this.mint(e, null, true);
    this.unclaimed.push(id);
    return id;
  }

  /** X5-27 (P7 A5-9): one context item for the target seat (or every live seat) at its next exit-0 output. */
  queueSeatContext(target: 'all' | string, code: string, params: Params): string[] {
    return this.add(target, { code, params, family: 'note', mandatory: false, slot: 'context' });
  }

  /** Every live seat's next exit-0 output once (X5-27). */
  queueSystemMessage(code: string, params: Params): string[] {
    return this.add('all', { code, params, family: 'note', mandatory: false, slot: 'system' });
  }

  /** The seat's pending rows in arrival order (a row in an un-printed batch is not pending until nextHook). */
  pending(seatId: string): readonly SeatEvent[] {
    const s = this.openBySeat.get(seatId);
    if (s === undefined) return [];
    const out: SeatEvent[] = [];
    for (const id of s) {
      const row = this.rows.get(id);
      if (row !== undefined && row.state === 'pending') out.push({ ...row.e, seatId, state: 'pending' });
    }
    return out;
  }

  /** A reply lists its events; they are delivered only on printed{batch_id}. An optional carrier records the
   *  reply's CarrierKind for onDelivered (finishReply passes the kind it derived). A reply batches only its own
   *  seat's pending rows; an unknown, foreign or not-pending id is skipped, and a batch that took nothing is not
   *  stored (its id is still returned, and its printed delivers nothing). */
  batch(seatId: string, ids: readonly string[], carrier?: CarrierKind): string {
    const batchId = ulid(this.random, this.clock);
    const take: string[] = [];
    for (const id of ids) {
      const row = this.rows.get(id);
      if (row === undefined || row.state !== 'pending' || row.seat !== seatId) continue;
      row.state = 'in_batch';
      take.push(id);
    }
    if (take.length === 0) return batchId;
    this.unprinted.set(batchId, { id: batchId, seatId, ids: take, carrier: carrier ?? null });
    let s = this.batchesBySeat.get(seatId);
    if (s === undefined) { s = new Set(); this.batchesBySeat.set(seatId, s); }
    s.add(batchId);
    this.cursorBySeat.set(seatId, (this.cursorBySeat.get(seatId) ?? 0) + take.length);
    return batchId;
  }

  /** Delivers the batch's events once and forgets them; a repeated, empty, dropped or re-queued batch id delivers
   *  nothing. */
  printed(batchId: string): void {
    const b = this.unprinted.get(batchId);
    if (b === undefined) return;
    this.forgetBatch(b);
    const ids: string[] = [];
    for (const id of b.ids) {
      const row = this.rows.get(id);
      if (row === undefined || row.state !== 'in_batch') continue;   // delivered by its nonce meanwhile, or retired
      this.deleteRow(id);
      ids.push(id);
    }
    if (ids.length > 0) this.fire(b.seatId, ids, { carrier: b.carrier ?? 'post', batchId, nonce: null });
  }

  /** V-10: re-queues the seat's un-printed batches (their events go back to 'pending' with the same ids, in their
   *  arrival order), then, for a live seat (the additive fact {ended}), claims every unclaimed addFirst row and
   *  records the seat in the learned 'all' set (F2 #9: its most recent hook is now live). */
  nextHook(seatId: string, o?: { ended?: boolean }): void {
    const bs = this.batchesBySeat.get(seatId);
    if (bs !== undefined) {
      this.batchesBySeat.delete(seatId);
      for (const batchId of bs) {
        const b = this.unprinted.get(batchId);
        if (b === undefined) continue;
        this.unprinted.delete(batchId);
        for (const id of b.ids) {
          const row = this.rows.get(id);
          if (row !== undefined && row.state === 'in_batch') row.state = 'pending';
        }
      }
    }
    if (o?.ended === true) { this.learned.delete(seatId); return; }   // F2 #9: the most recent hook was ended
    this.learned.add(seatId);
    // A7-1: this live seat claims every unclaimed addFirst row, in order (F2 #4).
    for (const id of this.unclaimed.splice(0)) {
      const row = this.rows.get(id);
      if (row === undefined) continue;
      row.seat = seatId;
      this.index(seatId, id);
    }
  }

  /** Doorbell-carried events are delivered only when a UserPromptSubmit carries that nonce; a sent/refused/error
   *  post never removes an event. Only open rows are recorded; a post whose rows are all gone stores nothing. */
  doorbellSent(nonce: string, ids: readonly string[]): void {
    for (const id of ids) {
      const row = this.rows.get(id);
      if (row === undefined || row.seat === null) continue;
      row.e.viaNonce = nonce;
      row.nonces.add(nonce);
      let s = this.doorbell.get(nonce);
      if (s === undefined) { s = new Set(); this.doorbell.set(nonce, s); }
      s.add(id);
    }
  }

  /** Delivers the nonce's still-open events once and forgets the nonce; an event a pull carrier delivered first is
   *  already gone, so it is not delivered twice. */
  nonceSeen(nonce: string): readonly string[] {
    const s = this.doorbell.get(nonce);
    if (s === undefined) return [];
    this.doorbell.delete(nonce);
    const out: string[] = [];
    let seatId = '';
    for (const id of [...s]) {
      const row = this.deleteRow(id);
      if (row === undefined) continue;
      if (out.length === 0) seatId = row.seat ?? '';
      out.push(id);
    }
    if (out.length > 0) this.fire(seatId, out, { carrier: 'doorbell', batchId: null, nonce });
    return out;
  }

  cursor(seatId: string): number {
    return this.cursorBySeat.get(seatId) ?? 0;
  }

  /** F05-05 (Plan 6 noticed sets); V-10 (Plan 6's O-6): how names the printed batch's reply carrier, or 'doorbell'. */
  onDelivered(cb: DeliveredCb): () => void {
    this.subs.push(cb);
    return () => {
      const i = this.subs.indexOf(cb);
      if (i >= 0) this.subs.splice(i, 1);
    };
  }

  /** A7-3's note, additive: the ids PULL_MODE dropped at compose time retire as delivered — dropped, not delivered
   *  late, never charged, and never an onDelivered call. */
  retire(ids: readonly string[]): void {
    for (const id of ids) this.deleteRow(id);
  }

  /** The seat's end (F2 #8, #57), additive: forgets its open rows, its un-printed batches, their doorbell nonces, its
   *  cursor and its once-per-CS nudge keys; a claimed addFirst row it never delivered goes back to the front of the
   *  unclaimed FIFO, in its original order, for the next live seat. */
  dropSeat(seatId: string): void {
    const bs = this.batchesBySeat.get(seatId);
    if (bs !== undefined) {
      this.batchesBySeat.delete(seatId);
      for (const batchId of bs) this.unprinted.delete(batchId);
    }
    const open = this.openBySeat.get(seatId);
    const back: string[] = [];
    if (open !== undefined) {
      this.openBySeat.delete(seatId);
      for (const id of open) {
        const row = this.rows.get(id);
        if (row === undefined) continue;
        this.unlinkNonces(id, row);
        if (row.fromAddFirst) {
          row.seat = null;
          row.state = 'pending';
          row.e.viaNonce = null;
          back.push(id);
        } else this.rows.delete(id);
      }
    }
    this.unclaimed.unshift(...back);
    this.cursorBySeat.delete(seatId);
    this.learned.delete(seatId);   // F2 #9: a dropped seat leaves the learned 'all' set
    const prefix = `${seatId}/`;
    for (const k of [...this.nudgedCs]) if (k.startsWith(prefix)) this.nudgedCs.delete(k);
  }

  /** Introspection for tests and a later /cowork status (F2 #8): rows = open plus unclaimed rows, open = the ids
   *  queued for seats, unprinted = un-printed batches, nonces = doorbell nonces with an open id, unclaimed = addFirst
   *  rows no seat holds, onceKeys = the routeHoldCode once-keys (nudge and mirror). */
  sizes(): { rows: number; open: number; unprinted: number; nonces: number; unclaimed: number; onceKeys: number } {
    let open = 0;
    for (const s of this.openBySeat.values()) open += s.size;
    return { rows: this.rows.size, open, unprinted: this.unprinted.size, nonces: this.doorbell.size, unclaimed: this.unclaimed.length, onceKeys: this.nudgedCs.size + this.mirrored.size };
  }

  /** @internal routeHoldCode's once-sets: true the first time a key is marked (nudge = a CS id, mirror = a hold id). */
  markOnce(kind: 'nudge' | 'mirror', key: string): boolean {
    const s = kind === 'nudge' ? this.nudgedCs : this.mirrored;
    if (s.has(key)) return false;
    s.add(key);
    return true;
  }

  private fire(seatId: string, ids: readonly string[], how: { carrier: CarrierKind | 'doorbell'; batchId: string | null; nonce: string | null }): void {
    // t7b fix round 1 (review, ROBUST): iterate a copy — a subscriber that removes itself inside the loop (Plan 6
    // F05-05) must not shift the array under the for-of and skip its neighbour.
    for (const cb of [...this.subs]) cb(seatId, ids, how);
  }
}

/** A7-5: the consumer of every Plan 3 hold-code raise (fed by EngineCore.onHoldCode, A8-9). The seat segment of a
 *  CS id is a seat id exactly when it is 32 hex — a peer CS ('<peer>/human/<n>') names no seat and is not routed.
 *  The once-sets live in the store (markOnce): nudge keys go at the seat's end, mirror keys stay for the daemon run. */
export function routeHoldCode(r: HoldCodeRaise, ctx: DaemonCtx): string[] {
  const seatOfCs = (cs: string): string | null => {
    const i = cs.indexOf('/');
    if (i <= 0) return null;
    const seat = cs.slice(0, i);
    return /^[0-9a-f]{32}$/.test(seat) ? seat : null;
  };
  const post = (seatId: string, code: string, params: Params, family: string): string[] =>
    ctx.events.add(seatId, { code, params, family, mandatory: false, slot: 'context', carriers: ['post'] });
  // A seat that has ended never hooks again and its dropSeat already ran, so a raise for its CS posts nothing and
  // marks no once-key (F2 #57, fix round 1; HOLD_MIRROR_REJECTED below reads the same fact).
  const ended = (seatId: string): boolean => ctx.seats.bySeatId(seatId)?.ended === true;
  switch (r.code) {
    case 'CS_UNPUBLISHED_NUDGE': {
      const cs = String((r.params as { cs?: string }).cs ?? '');
      const seat = seatOfCs(cs);
      if (seat === null || ended(seat)) return [];
      if (!ctx.events.markOnce('nudge', cs)) return [];              // once per CS (BL3-07, R2-C4)
      const n = (r.params as { n?: number }).n;
      return post(seat, r.code, { n: typeof n === 'number' ? n : null }, 'nudge');
    }
    case 'INCOMING_WAITING': {
      const path = String((r.params as { path?: string }).path ?? '');
      if (path === '') return [];
      const out: string[] = [];
      for (const s of ctx.seats.seats()) {
        if (s.seat_id === '' || s.activity === 'ENDED') continue;      // a live seat only (the summary's activity is 'ENDED' for an ended seat)
        if (ctx.readSets.fullReadSet(s.seat_id).has(path)) out.push(...post(s.seat_id, r.code, r.params as Params, 'note'));
      }
      return out;
    }
    case 'CS_GROUP_WAITING':
    case 'CS_READY_CANCELLED': {
      const seat = seatOfCs(String((r.params as { cs?: string }).cs ?? ''));
      return seat === null || ended(seat) ? [] : post(seat, r.code, r.params as Params, 'note');
    }
    case 'HOLD_MIRROR_REJECTED': {
      const holdId = String((r.params as { hold_id?: string }).hold_id ?? '');
      if (holdId === '') return [];
      if (!ctx.events.markOnce('mirror', holdId)) return [];         // once per hold id (glossary §25.2 item 9)
      const rec = ctx.engine.registry().get(holdId);
      const originSeat = seatOfCs(rec?.origin ?? '');
      const rid = rec?.id ?? holdId;
      if (originSeat === null || ended(originSeat)) {
        return [ctx.events.addFirst({ code: r.code, params: { rid }, family: 'note', mandatory: false, slot: 'context' })];
      }
      return post(originSeat, r.code, { rid }, 'note');
    }
    default:
      return [];                                                     // HOLD_CREATED and other codes are not routed (R5-09)
  }
}
