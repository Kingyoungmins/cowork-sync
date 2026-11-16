// src/claude/daemon/stop.ts — the Stop decision (CCI-42, INV-CCI-ASK-ONCE, 06 §3.15). Task 7: TurnItems (R5-39),
// noDueRequests (R5-10) and stopDecision — at most one block per turn; never when stop_hook_active; never in a
// wake-originated turn; (a) this turn's denied/held/recorded/not-shared items (any agent_id, the main agent
// first, each agent's items in record order) whose ids are not all in ids_in_last_message (null → block whenever
// such items exist); (b) due asks when background_tasks_running is 0, each (request identity, attempt) at most
// once ever; SubagentStop never blocks.
import type { HookPayload } from '../wire/frames.js';
import type { AskRef, DueRequestsPort } from './claudeDaemon.js';
import type { Seat } from './seats.js';
import type { Params } from './claudeDaemon.js';
import type { DaemonCtx, HookRequest, ReplyDraft } from './ctx.js';
import { registerStep } from './pipeline.js';

export { AskRef };

interface TurnEntry { agentId: string | null; kind: 'denied' | 'held' | 'recorded' | 'not_shared'; id: string; }

/** The seat's last Stop block row: its store event id and, while its batch is unconfirmed, the asks listener's off. */
interface BlockRow { evId: string; off: (() => void) | null; }

export class TurnItems {   // R5-39: the one unacked source (Plan 3's Engine.unacked stub is dropped, X-13)
  private readonly bySeat = new Map<string, TurnEntry[]>();
  private readonly asked = new Set<string>();   // (request identity, attempt) ever asked — stopDecision's (b) memory
  private readonly blocked = new Set<string>();   // CCI-42: at most one block per turn
  private readonly blockRows = new Map<string, BlockRow>();   // F2 #3 #57: at most one pending stop_truth row per seat

  /** HLD-23 unacked(seat) and Stop (a) input: denied (SHADOW ids), held (PIN ids), recorded, not-shared (NOT_SHARED
   *  paths) items of the current turn, per agent_id. */
  record(seatId: string, agentId: string | null, kind: 'denied' | 'held' | 'recorded' | 'not_shared', id: string): void {
    const q = this.bySeat.get(seatId) ?? [];
    q.push({ agentId, kind, id });
    this.bySeat.set(seatId, q);
  }

  forTurn(seatId: string): ReadonlyArray<{ agentId: string | null; kind: string; id: string }> {
    return this.bySeat.get(seatId) ?? [];
  }

  unacked(seatId: string): string[] {
    return (this.bySeat.get(seatId) ?? []).map((e) => e.id);
  }

  endTurn(seatId: string): void {   // a new human or wake turn, Stop/StopFailure (after stop.decide), seat end
    this.bySeat.delete(seatId);
    this.blocked.delete(seatId);
    // F2 #57: the turn's block can no longer be confirmed for this turn — its asks listener ends here (the row id is
    // kept, so the seat's next Stop/StopFailure still retires the row and an un-printed ask is asked again).
    const b = this.blockRows.get(seatId);
    if (b !== undefined && b.off !== null) { const off = b.off; b.off = null; off(); }
  }

  /** F2 #3 #57: records the seat's Stop block row (at most one pending stop_truth row per seat) and its asks
   *  listener's off (null when the block has no asks). */
  setBlockRow(seatId: string, evId: string, off: (() => void) | null): void {
    this.blockRows.set(seatId, { evId, off });
  }

  /** F2 #3: removes and returns the seat's previous Stop block row (stop.decide retires it at the next Stop or
   *  StopFailure); null when there is none. */
  takeBlockRow(seatId: string): { evId: string; off: (() => void) | null } | null {
    const b = this.blockRows.get(seatId);
    if (b === undefined) return null;
    this.blockRows.delete(seatId);
    return b;
  }

  /** F2 #57: the block row's batch was confirmed and its listener removed itself; the row id stays recorded. */
  clearBlockListener(seatId: string, evId: string): void {
    const b = this.blockRows.get(seatId);
    if (b !== undefined && b.evId === evId) b.off = null;
  }

  /** CCI-42's at-most-one-block-per-turn memory (the step reads it as stopDecision's blockedThisTurn). */
  markBlocked(seatId: string): void {
    this.blocked.add(seatId);
  }

  blockedThisTurn(seatId: string): boolean {
    return this.blocked.has(seatId);
  }

  /** (b)'s once-ever memory; internal to this module's stopDecision path. */
  markAskedKeys(keys: readonly string[]): void {
    for (const k of keys) this.asked.add(k);
  }

  askedKeys(): readonly string[] {
    return [...this.asked];
  }

  /** F2 #57: one (request identity, attempt) key's once-ever lookup (a Set.has; askedKeys copies the whole set). The
   *  asked set is meant to last — "at most once ever" (INV-CCI-ASK-ONCE) — and is never pruned. */
  hasAsked(key: string): boolean {
    return this.asked.has(key);
  }
}

/** R5-10: no due requests exist before Plan 6 (COO-13, COO-26) — REAL. */
export const noDueRequests: DueRequestsPort = Object.freeze({
  dueRequests: (_seatId: string): AskRef[] => [],
  markAsked: (_asks: readonly AskRef[]): void => undefined,
});

/** (a): the items whose ids are not all in ids_in_last_message; null last message → block whenever such items
 *  exist. Items of the main agent (null) come first, then agents in first-record order, each agent's items in
 *  record order (CCI-30 item 2, R2-A1 Stop half). */
function itemsToReport(items: readonly TurnEntry[], idsInLastMessage: readonly string[] | null): TurnEntry[] {
  if (items.length === 0) return [];
  if (idsInLastMessage !== null) {
    const set = new Set(idsInLastMessage);
    const rest = items.filter((e) => !set.has(e.id));
    if (rest.length === 0) return [];
    return ordered(rest);
  }
  return ordered(items);
}

/** CCI-30 item 2: agent_id null first, then agents in first-record order; record order within an agent. */
function ordered(entries: readonly TurnEntry[]): TurnEntry[] {
  const main = entries.filter((e) => e.agentId === null);
  const agents: string[] = [];
  for (const e of entries) if (e.agentId !== null && !agents.includes(e.agentId)) agents.push(e.agentId);
  const out = [...main];
  for (const a of agents) out.push(...entries.filter((e) => e.agentId === a));
  return out;
}

const askKey = (a: AskRef): string => `${a.reqId}@${a.attempt}`;

/** At most one decision: block per turn; never when stop_hook_active; never in a wake-originated turn; (a) the
 *  turn's items whose ids are not all in ids_in_last_message; (b) due asks when background_tasks_running is 0,
 *  each (request identity, attempt) at most once ever; SubagentStop never blocks. */
export function stopDecision(seat: Seat, p: Extract<HookPayload, { event: 'Stop' | 'SubagentStop' }>, items: TurnItems, due: DueRequestsPort, blockedThisTurn: boolean):
  { block: { code: 'STOP_SUMMARY'; params: Params; itemIds: string[]; asks: AskRef[] } | null } {
  if (p.event !== 'Stop') return { block: null };                     // SubagentStop never blocks (CCI-42)
  if (p.stop_hook_active || blockedThisTurn) return { block: null };  // the continuation or the turn's second Stop
  if (seat.turn.origin === 'wake') return { block: null };            // a wake turn is never blocked
  const turnItems = items.forTurn(seat.seatId ?? '') as TurnEntry[];
  const report = itemsToReport(turnItems, p.ids_in_last_message);
  const asks = p.background_tasks_running === 0
    ? due.dueRequests(seat.seatId ?? '').filter((a) => !items.hasAsked(askKey(a)))
    : [];
  if (report.length === 0 && asks.length === 0) return { block: null };
  const itemIds = report.map((e) => e.id);
  const itemParams = report.map((e) => ({ agent: e.agentId, kind: e.kind, id: e.id }));
  const params: Params = {
    items: JSON.stringify(itemParams),
    asks: JSON.stringify(asks.map((a) => ({ rid: a.rid, label: a.label, requester: a.requester, mode: a.mode }))),
  };   // the (a) items and the due asks as JSON strings (the code-line render substitutes values verbatim and caps nothing)
  return { block: { code: 'STOP_SUMMARY', params, itemIds, asks } };
}

/** (b)'s once-ever key (the step marks the same keys on the batch's printed). */
export function askKeyOf(a: AskRef): string {
  return `${a.reqId}@${a.attempt}`;
}

// ---- The stop.decide step (A7-7; Task 7 registers it) ------------------------------------------------------------------

/** stop.decide: runs stopDecision; a block sets d.block (the STOP_SUMMARY reason; the typed (a) items and the due
 *  asks ride its fields), adds the block's store event (family 'stop_truth', mandatory, slot 'both', carriers
 *  ['stop'], params = the block's own params) whose printed triggers markAsked (INV-CCI-ASK-ONCE), and marks the turn
 *  blocked (CCI-42's one block); a Stop that does not block ends the turn's items at once (R5-39).
 *  F2 #3: a Stop block is re-derived, not replayed — at its next Stop or StopFailure the seat's previous stop_truth
 *  row is retired (ended without delivery and without markAsked; a delivered row is a no-op) and its asks listener
 *  removed, so an ask whose block was never confirmed is asked again, in full, by the next blocking Stop (06:717:
 *  asked_at at the block's confirmed batch; at-least-once). The row is listed only by the block reply it renders. */
export async function stopDecideStep(r: HookRequest, d: ReplyDraft, ctx: DaemonCtx): Promise<void> {
  const seat = r.seat;
  const seatId = seat.seatId ?? '';
  if (seatId === '') return;
  const p = r.frame.payload;
  if (p.event === 'Stop' || p.event === 'StopFailure') {
    const prev = ctx.items.takeBlockRow(seatId);
    if (prev !== null) { prev.off?.(); ctx.events.retire([prev.evId]); }
  }
  // StopFailure ends the turn's items (R5-39). stop.decide is not in SessionEnd's pipeline (pipeline.ts); an ended
  // seat's TurnItems go through seats.onEnd → ctx.items.endTurn (the composition's line, C-3).
  if (p.event === 'StopFailure') { ctx.items.endTurn(seatId); return; }
  if (p.event !== 'Stop') return;
  const res = stopDecision(seat, p, ctx.items, ctx.bindings.dueRequests, ctx.items.blockedThisTurn(seatId));
  if (res.block === null) { ctx.items.endTurn(seatId); return; }
  ctx.items.markBlocked(seatId);
  d.block = { code: res.block.code, params: res.block.params };
  const [evId] = ctx.events.add(seatId, { code: 'STOP_SUMMARY', params: res.block.params, family: 'stop_truth', mandatory: true, slot: 'both', carriers: ['stop'] });
  if (evId === undefined) return;
  const asks = res.block.asks;
  let off: (() => void) | null = null;
  if (asks.length > 0) {
    let fired = false;
    const sub = ctx.events.onDelivered((_sid, ids) => {
      if (fired || !ids.includes(evId)) return;
      // F2 fix round 1: the off is deferred — removing this listener inside the store's delivery loop would make the
      // subscriber registered after it miss this delivery; `fired` keeps the listener one-shot until the off runs.
      fired = true;
      queueMicrotask(sub);
      ctx.items.clearBlockListener(seatId, evId);
      ctx.items.markAskedKeys(asks.map(askKeyOf));
      ctx.bindings.dueRequests.markAsked(asks);
    });
    off = sub;
  }
  ctx.items.setBlockRow(seatId, evId, off);
}

registerStep('stop.decide', stopDecideStep);
