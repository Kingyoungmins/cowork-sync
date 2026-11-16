// test/unit/claude.stop.test.ts — the Stop decision (CCI-42, INV-CCI-ASK-ONCE, R5-39, R5-10): (a)'s report and its
// ordering (main agent first, record order within an agent), the ids_in_last_message filter, the guards
// (stop_hook_active, one block per turn, wake turns, SubagentStop), (b)'s due asks once ever, and stopDecideStep's
// store event whose printed marks the asks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TurnItems, stopDecision, stopDecideStep, askKeyOf, noDueRequests } from '../../src/claude/daemon/stop.js';
import { EventStore } from '../../src/claude/daemon/events.js';
import { BudgetMeter } from '../../src/claude/daemon/meter.js';
import { carrierContextStep, codeOnlyDigest, eventDeliverStep, finishReply } from '../../src/claude/daemon/carriers.js';
import type { AskRef, DueRequestsPort } from '../../src/claude/daemon/claudeDaemon.js';
import type { DaemonCtx, HookRequest, ReplyDraft } from '../../src/claude/daemon/ctx.js';
import type { ReplyFrame } from '../../src/claude/wire/frames.js';
import type { Seat } from '../../src/claude/daemon/seats.js';
import { registerClaudeCatalog } from '../../src/i18n/claude.js';
import { VirtualClock } from '../sim/vclock.js';
import { TraceRecorder } from '../sim/traceRecorder.js';
import { seededRandom } from '../../src/ports/random.js';

// 07's Stop overflow row (the same test entry as the carriers test; an identical re-registration is a no-op).
registerClaudeCatalog('en', { 'T-STOP.more': { text: 'and {k} more: cowork_status', params: { k: 'n' } } });

const seat = (origin: 'human' | 'wake' = 'human'): Seat => ({ seatId: 's1', turn: { origin } }) as unknown as Seat;

const stop = (over: Partial<{ stop_hook_active: boolean; background_tasks_running: number; ids_in_last_message: string[] | null }> = {}) =>
  ({ event: 'Stop', stop_hook_active: false, background_tasks_running: 0, ids_in_last_message: null, ...over }) as const;

const subStop = (): Parameters<typeof stopDecision>[1] =>
  ({ event: 'SubagentStop', stop_hook_active: false, background_tasks_running: 1, ids_in_last_message: null }) as never;

function items3(): TurnItems {
  const it = new TurnItems();
  it.record('s1', null, 'held', 'PIN-1');
  it.record('s1', 'a1', 'denied', 'SHADOW-1');
  it.record('s1', 'a1', 'recorded', 'rec-1');
  return it;
}

const ask = (reqId: string, attempt = 1): AskRef => ({ reqId, toHolderSeat: 's9', attempt, rid: `r-${reqId}`, label: 'hold', requester: 'peer-1', mode: 'go_first' });

test('(a): the turn items whose ids are not all acknowledged are reported, main agent first, in record order', () => {
  const it = items3();
  const d = stopDecision(seat(), stop(), it, noDueRequests, false);
  assert.ok(d.block !== null);
  assert.equal(d.block.code, 'STOP_SUMMARY');
  assert.deepEqual(d.block.itemIds, ['PIN-1', 'SHADOW-1', 'rec-1']);
  assert.deepEqual(JSON.parse(d.block.params.items as string), [
    { agent: null, kind: 'held', id: 'PIN-1' }, { agent: 'a1', kind: 'denied', id: 'SHADOW-1' }, { agent: 'a1', kind: 'recorded', id: 'rec-1' },
  ]);
  assert.deepEqual(d.block.asks, []);                                        // noDueRequests: Plan 5 has no due asks
  // ids_in_last_message filters: the acknowledged ids drop out, a null message never filters.
  const d2 = stopDecision(seat(), stop({ ids_in_last_message: ['PIN-1'] }), it, noDueRequests, false);
  assert.ok(d2.block !== null);
  assert.deepEqual(d2.block.itemIds, ['SHADOW-1', 'rec-1']);
  const d3 = stopDecision(seat(), stop({ ids_in_last_message: ['PIN-1', 'SHADOW-1', 'rec-1'] }), it, noDueRequests, false);
  assert.equal(d3.block, null);                                              // every id acknowledged → no block
  // A second agent's items keep their first-record order after the main agent's.
  const it2 = new TurnItems();
  it2.record('s1', 'b2', 'not_shared', 'p-b');
  it2.record('s1', null, 'held', 'PIN-2');
  it2.record('s1', 'a1', 'denied', 'p-a1');
  it2.record('s1', 'b2', 'recorded', 'p-b2');
  const d4 = stopDecision(seat(), stop(), it2, noDueRequests, false);
  assert.ok(d4.block !== null);
  assert.deepEqual(d4.block.itemIds, ['PIN-2', 'p-b', 'p-b2', 'p-a1']);
});

test('the guards: never when stop_hook_active, one block per turn, never in a wake turn, SubagentStop never blocks', () => {
  const it = items3();
  assert.equal(stopDecision(seat(), stop({ stop_hook_active: true }), it, noDueRequests, false).block, null);
  assert.equal(stopDecision(seat(), stop(), it, noDueRequests, true).block, null);           // blockedThisTurn
  assert.equal(stopDecision(seat('wake'), stop(), it, noDueRequests, false).block, null);
  assert.equal(stopDecision(seat(), subStop(), it, noDueRequests, false).block, null);
  assert.deepEqual(stopDecision(seat(), stop({ background_tasks_running: 1 }), new TurnItems(), noDueRequests, false).block, null);
});

test("(b): due asks ride the block when background_tasks_running is 0, each (identity, attempt) asked once ever", () => {
  const it = new TurnItems();
  const a1 = ask('req-1');
  const a2 = ask('req-2', 2);
  const due = { dueRequests: (_s: string) => [a1, a2], markAsked: () => undefined };
  const d = stopDecision(seat(), stop(), it, due, false);
  assert.ok(d.block !== null);
  assert.deepEqual(d.block.asks, [a1, a2]);
  assert.deepEqual(JSON.parse(d.block.params.asks as string), [
    { rid: 'r-req-1', label: 'hold', requester: 'peer-1', mode: 'go_first' }, { rid: 'r-req-2', label: 'hold', requester: 'peer-1', mode: 'go_first' },
  ]);
  it.markAskedKeys([a1].map(askKeyOf));                                      // the printed batch's mark
  const d2 = stopDecision(seat(), stop(), it, due, false);
  assert.ok(d2.block !== null);
  assert.deepEqual(d2.block.asks, [a2]);                                     // req-1@1 asked once ever
  assert.equal(askKeyOf(a2), 'req-2@2');
  it.markAskedKeys([a2].map(askKeyOf));
  // Asks never ride when background tasks are running: the block then comes from the items alone.
  const it3 = new TurnItems();
  it3.record('s1', null, 'held', 'PIN-9');
  const d3 = stopDecision(seat(), stop({ background_tasks_running: 1 }), it3, due, false);
  assert.ok(d3.block !== null);
  assert.deepEqual(d3.block.asks, []);
  // Nothing left to report and every ask asked: no block (the asked memory lives in the same TurnItems).
  const d4 = stopDecision(seat(), stop(), it, due, false);
  assert.equal(d4.block, null);
});

test('stopDecideStep: the block sets d.block and posts the mandatory stop event whose printed marks the asks', async () => {
  const clock = new VirtualClock({ startMono: 0 });
  const events = new EventStore(clock, seededRandom('stop-unit'), new TraceRecorder());
  const it = items3();
  const a1 = ask('req-9');
  const marked: AskRef[][] = [];
  const ctx = {
    items: it, events,
    bindings: { dueRequests: { dueRequests: (_s: string) => [a1], markAsked: (a: AskRef[]) => marked.push([...a]) } },
  } as unknown as DaemonCtx;
  const r = { seat: seat(), frame: { payload: stop() }, startedMono: 0 } as unknown as HookRequest;
  const d: ReplyDraft = { carrier: 'stop', items: [], deny: null, block: null, done: false };
  await stopDecideStep(r, d, ctx);
  assert.ok(d.block !== null);
  assert.equal(d.block.code, 'STOP_SUMMARY');
  const p = events.pending('s1');
  assert.equal(p.length, 1);
  assert.equal(p[0]!.code, 'STOP_SUMMARY');
  assert.equal(p[0]!.mandatory, true);
  assert.equal(p[0]!.slot, 'both');
  assert.deepEqual(p[0]!.carriers, ['stop']);
  assert.deepEqual(p[0]!.params, d.block.params, 'the store row carries the block’s own content (F2 #3)');
  const evId = p[0]!.id;
  const b = events.batch('s1', [evId]);
  events.printed(b);                                                         // the printed batch marks the asks (ASK-ONCE)
  assert.equal(marked.length, 1);
  assert.deepEqual(marked[0], [a1]);
  assert.ok(it.askedKeys().includes('req-9@1'));
  // A second Stop in the same turn never blocks again (CCI-42) and ends the turn's items (R5-39).
  const d2: ReplyDraft = { carrier: 'stop', items: [], deny: null, block: null, done: false };
  await stopDecideStep(r, d2, ctx);
  assert.equal(d2.block, null);
  assert.deepEqual(it.forTurn('s1'), []);
  // StopFailure ends the turn's items too.
  it.record('s1', null, 'held', 'PIN-3');
  const rf = { seat: seat(), frame: { payload: { event: 'StopFailure', reason: 'x' } }, startedMono: 0 } as unknown as HookRequest;
  const d3: ReplyDraft = { carrier: 'stop', items: [], deny: null, block: null, done: false };
  await stopDecideStep(rf, d3, ctx);
  assert.equal(d3.block, null);
  assert.deepEqual(it.forTurn('s1'), []);
});

// ---- F2 t7a: the Stop block's store row through the real pipeline order (stop.decide → event.deliver → finishReply) --

const S = 's1';
const liveSeat = (): Seat => ({ seatId: S, turn: { origin: 'human' }, ended: false }) as unknown as Seat;

/** The ctx the three Stop-path steps read (the real TurnItems, EventStore and BudgetMeter). */
function stopCtx(due: DueRequestsPort): DaemonCtx {
  const clock = new VirtualClock({ startMono: 0 });
  return {
    items: new TurnItems(),
    events: new EventStore(clock, seededRandom('stop-f2'), new TraceRecorder()),
    meter: new BudgetMeter(clock, () => undefined),
    trace: new TraceRecorder(),
    engine: { peer: () => 'peer-1', teamLanguage: () => null },
    prefs: () => ({ language: null }),
    bindings: { dueRequests: due, slotExtra: null, digest: codeOnlyDigest },
  } as unknown as DaemonCtx;
}

/** A due-request double: returns its asks while they are not marked; records every markAsked call. */
function dueOf(asks: AskRef[]): { port: DueRequestsPort; marked: AskRef[][] } {
  const marked: AskRef[][] = [];
  const done = new Set<string>();
  return {
    marked,
    port: {
      dueRequests: (_s: string) => asks.filter((a) => !done.has(askKeyOf(a))),
      markAsked: (a: readonly AskRef[]) => { marked.push([...a]); for (const x of a) done.add(askKeyOf(x)); },
    },
  };
}

/** One Stop hook in the pipeline order of pipeline.ts (stop.decide, then event.deliver, then the reply assembly). */
async function runStop(ctx: DaemonCtx, payload: ReturnType<typeof stop> = stop()): Promise<ReplyFrame> {
  const r = { frame: { t: 'hook', event: 'Stop', h: { agent_id: null }, payload }, seat: liveSeat(), startedMono: 0, turn: null, trigger: null, extend: () => false } as unknown as HookRequest;
  const d: ReplyDraft = { carrier: 'stop', items: [], deny: null, block: null, done: false };
  await stopDecideStep(r, d, ctx);
  await eventDeliverStep(r, d, ctx);
  return finishReply(r, d, ctx);
}

/** A new turn: carrier.context's endTurn, then the UserPromptSubmit's event.deliver (the re-queue of un-printed batches). */
async function newTurn(ctx: DaemonCtx): Promise<void> {
  ctx.items.endTurn(S);
  const r = { frame: { t: 'hook', event: 'UserPromptSubmit', h: { agent_id: null }, payload: { event: 'UserPromptSubmit', nonces: [] } }, seat: liveSeat(), startedMono: 0, turn: null, trigger: null, extend: () => false } as unknown as HookRequest;
  await eventDeliverStep(r, { carrier: 'ups', items: [], deny: null, block: null, done: false }, ctx);
}

const summaryLines = (text: string): string[] => text.split('\n').filter((l) => l.startsWith('[cowork-sync] STOP_SUMMARY'));

test('an un-printed Stop block is re-derived in full at the next blocking Stop: one STOP_SUMMARY line, its own batch, markAsked once', async () => {
  const R1 = ask('R1');
  const due = dueOf([R1]);
  const ctx = stopCtx(due.port);
  const seen: string[][] = [];
  ctx.events.onDelivered((_s, ids) => seen.push([...ids]));
  ctx.items.record(S, null, 'held', 'PIN-1');
  const reply1 = await runStop(ctx);
  assert.equal(reply1.decision, 'block');
  const l1 = summaryLines(reply1.text);
  assert.equal(l1.length, 1, `one STOP_SUMMARY line: ${JSON.stringify(reply1.text)}`);
  assert.ok(l1[0]!.includes('r-R1') && l1[0]!.includes('PIN-1'));
  assert.equal(reply1.events.length, 1);
  const E1 = reply1.events[0]!;
  // No printed (the hook was killed); the next turn's UserPromptSubmit re-queues the batch.
  await newTurn(ctx);
  const reply2 = await runStop(ctx);
  assert.equal(reply2.decision, 'block');
  const l2 = summaryLines(reply2.text);
  assert.equal(l2.length, 1, `one STOP_SUMMARY line: ${JSON.stringify(reply2.text)}`);
  assert.ok(l2[0]!.includes('r-R1'), 'the un-printed ask is asked again in full text');
  assert.equal(reply2.events.length, 1);
  const E2 = reply2.events[0]!;
  assert.notEqual(E2, E1, 'its own row, not the stale one');
  ctx.events.printed(reply2.batch_id);
  assert.deepEqual(due.marked, [[R1]], 'markAsked once, by the block whose printed arrived');
  assert.ok(!seen.some((ids) => ids.includes(E1)), 'the stale row is never delivered');
});

test('a later Stop that does not show the block never marks its asks', async () => {
  const R1 = ask('R1');
  const due = dueOf([R1]);
  const ctx = stopCtx(due.port);
  const reply1 = await runStop(ctx);                                         // blocks with the due ask R1
  assert.equal(reply1.decision, 'block');
  assert.ok(reply1.text.includes('r-R1'));
  // No printed for the block; the continuation Stop prints nothing.
  const cont = await runStop(ctx, stop({ stop_hook_active: true }));
  assert.equal(cont.decision, 'none');
  assert.equal(cont.text, '');
  assert.deepEqual(cont.events, []);
  ctx.events.printed(cont.batch_id);                                         // the loader always sends printed
  assert.deepEqual(due.marked, []);
  assert.ok(!ctx.items.askedKeys().includes('R1@1'));
  // The next turn's Stop blocks again with R1, in one line of its own row, and its printed marks R1 once.
  await newTurn(ctx);
  const reply3 = await runStop(ctx);
  assert.equal(reply3.decision, 'block');
  const l3 = summaryLines(reply3.text);
  assert.equal(l3.length, 1, `one STOP_SUMMARY line: ${JSON.stringify(reply3.text)}`);
  assert.ok(l3[0]!.includes('r-R1'));
  assert.equal(reply3.events.length, 1);
  assert.ok(!reply1.events.includes(reply3.events[0]!), 'the first block\u2019s row is not re-listed');
  ctx.events.printed(reply3.batch_id);
  assert.deepEqual(due.marked, [[R1]]);
});

test("stop.decide's asks listener leaves the store's other subscribers intact: one registered after it still sees that printed (F2 fix round 1)", async () => {
  // Review finding (ROBUST r1): the listener removed itself inside EventStore.fire's loop over its subscriber list,
  // so the subscriber right after it skipped that delivery.
  const R1 = ask('R1');
  const due = dueOf([R1]);
  const ctx = stopCtx(due.port);
  ctx.items.record(S, null, 'held', 'PIN-1');
  const reply = await runStop(ctx);
  assert.equal(reply.decision, 'block');
  const after: string[][] = [];
  ctx.events.onDelivered((_s, ids) => after.push([...ids]));
  ctx.events.printed(reply.batch_id);
  assert.deepEqual(after, [reply.events], 'the later subscriber sees the Stop block delivery');
  assert.deepEqual(due.marked, [[R1]], 'markAsked once');
  await Promise.resolve();
  ctx.events.printed(reply.batch_id);
  assert.deepEqual(due.marked, [[R1]], 'a repeated printed marks nothing more');
});

test('1,000 turns of un-printed ask blocks keep at most one live stop.decide listener per seat (F2 #57)', async () => {
  let turn = 0;
  const ctx = stopCtx({ dueRequests: (_s: string) => [ask('R' + turn)], markAsked: () => undefined });
  let live = 0;
  const events = ctx.events as EventStore;
  const subscribe = events.onDelivered.bind(events);
  events.onDelivered = (cb) => {
    live++;
    const off = subscribe(cb);
    let on = true;
    return () => { if (on) { on = false; live--; } off(); };
  };
  for (turn = 0; turn < 1000; turn++) {
    ctx.items.record(S, null, 'held', 'PIN-' + turn);
    const reply = await runStop(ctx);                                        // a block, never printed
    if (turn % 100 === 0) assert.equal(reply.decision, 'block');
    await newTurn(ctx);
  }
  assert.ok(live <= 1, `live stop.decide listeners: ${live}`);
  const stale = ctx.events.pending(S).filter((e) => e.family === 'stop_truth').length;
  assert.ok(stale <= 1, `pending stop_truth rows: ${stale}`);
});

test('the Stop block rides a batch and its reason is ≤ 1,200', async () => {
  // plan:2904 (CCI-42, INV-CCI-ASK-ONCE); plan:1649: the STOP_SUMMARY item goes through composeReply('stop', …)
  // (≤ 1,200, 'T-STOP.more' overflow). 40 (a) items do not fit: whole entries are shown, the rest counted by the MORE.
  const R1 = ask('R1');
  const due = dueOf([R1]);
  const ctx = stopCtx(due.port);
  for (let i = 0; i < 40; i++) ctx.items.record(S, null, 'denied', 'SHD-' + String(i).padStart(2, '0'));
  const r = { frame: { t: 'hook', event: 'Stop', h: { agent_id: null }, payload: stop() }, seat: liveSeat(), startedMono: 0, turn: null, trigger: null, extend: () => false } as unknown as HookRequest;
  const d: ReplyDraft = { carrier: 'stop', items: [], deny: null, block: null, done: false };
  await stopDecideStep(r, d, ctx);
  const row = ctx.events.pending(S).find((e) => e.code === 'STOP_SUMMARY');
  assert.ok(row !== undefined, 'the block is a store event');
  assert.equal(row.family, 'stop_truth');
  assert.equal(row.mandatory, true);
  assert.deepEqual(row.carriers, ['stop']);
  await eventDeliverStep(r, d, ctx);
  const reply = finishReply(r, d, ctx);
  assert.equal(reply.decision, 'block');
  assert.ok(reply.text.length <= 1200, `reason ${reply.text.length}`);
  const more = /\nand (\d+) more: cowork_status$/.exec(reply.text);
  assert.ok(more !== null, `the reply ends with the T-STOP.more line: ${JSON.stringify(reply.text.slice(-60))}`);
  const k = Number(more[1]);
  const reason = reply.text.split('\n')[0]!;
  const shown = reason.match(/SHD-\d\d/g) ?? [];
  assert.equal(shown.length + k, 40, 'the shown entries plus the MORE count are the 40 items');
  assert.deepEqual(shown, Array.from({ length: shown.length }, (_, i) => 'SHD-' + String(i).padStart(2, '0')), 'shown in order from SHD-00');
  const entries = JSON.parse(reason.slice(reason.indexOf(' items=') + ' items='.length)) as unknown[];
  assert.equal(entries.length, shown.length, 'no half entry: the items param is a whole JSON array');
  assert.ok(reason.includes('r-R1'), 'the due ask is whole in the reason');
  assert.deepEqual(reply.events, [row.id], 'the block rides a batch');
  ctx.events.printed(reply.batch_id);
  assert.deepEqual(due.marked, [[R1]], 'printed → markAsked once');
});

test("TurnItems.unacked lists the current turn's ids and endTurn clears them", () => {
  // plan:2905 (R5-39, HLD-23, BL3-06; X-13: no Plan 5 module names Engine.unacked).
  const it = new TurnItems();
  it.record('S', null, 'denied', 'SHD1');
  it.record('S', 'a1', 'held', 'PIN1');
  it.record('S', null, 'recorded', 'rec1');
  it.record('S', 'a1', 'not_shared', 'src/x.ts');
  it.record('T', null, 'held', 'PIN-T');
  assert.deepEqual(it.unacked('S'), ['SHD1', 'PIN1', 'rec1', 'src/x.ts'], 'all four kinds, record order, any agent');
  it.endTurn('S');
  assert.deepEqual(it.unacked('S'), []);
  assert.deepEqual(it.unacked('T'), ['PIN-T'], "seat T's items are untouched");
  // The source scan: no .ts file under src/claude/ (comments stripped — stop.ts names the dropped stub on purpose).
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'src', 'claude');
  const hits: string[] = [];
  let scanned = 0;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.ts')) {
        scanned++;
        const code = readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        if (/\b[Ee]ngine(\(\))?\.unacked\b/.test(code)) hits.push(p);
      }
    }
  };
  walk(root);
  assert.ok(scanned > 20, `scanned ${scanned} files`);
  assert.deepEqual(hits, []);
});

test("stop.decide ends the turn's items unless it blocked", async () => {
  // plan:2906 (R5-39).
  const ctx = stopCtx(noDueRequests);
  ctx.items.record(S, null, 'held', 'PIN-1');
  const blocked = await runStop(ctx);
  assert.equal(blocked.decision, 'block');
  assert.deepEqual(ctx.items.forTurn(S).map((e) => e.id), ['PIN-1'], 'a blocking Stop keeps the items for the continuation');
  const cont = await runStop(ctx, stop({ stop_hook_active: true }));
  assert.equal(cont.decision, 'none');
  assert.deepEqual(ctx.items.forTurn(S), [], 'the continuation returns no block and ends them');
  ctx.items.record(S, null, 'recorded', 'rec-1');
  const plain = await runStop(ctx, stop({ ids_in_last_message: ['rec-1'] }));
  assert.equal(plain.decision, 'none');
  assert.deepEqual(ctx.items.forTurn(S), [], 'a Stop that does not block ends them at once');
  // A new-turn UserPromptSubmit ends them in carrier.context (the registry double feeds codeOnlyDigestOf).
  ctx.items.record(S, null, 'held', 'PIN-2');
  const ctxU = { ...ctx, engine: { peer: () => 'peer-1', teamLanguage: () => null, registry: () => ({ nonTerminal: () => [], get: () => undefined }) }, readSets: { fullReadSet: () => new Set<string>() } } as unknown as DaemonCtx;
  const u = { frame: { t: 'hook', event: 'UserPromptSubmit', h: { agent_id: null }, payload: { event: 'UserPromptSubmit', nonces: [] } }, seat: liveSeat(), startedMono: 0, turn: { newTurn: true, doorbell: false, origin: 'human' }, trigger: null, extend: () => false } as unknown as HookRequest;
  await carrierContextStep(u, { carrier: 'ups', items: [], deny: null, block: null, done: false }, ctxU);
  assert.deepEqual(ctx.items.forTurn(S), [], 'the new turn ends the previous turn\u2019s items');
});
