// test/unit/claude.events.test.ts — the EventStore cells (CCI-41, INV-CCI-DOORBELL, V-10, A7-1, A7-2, X5-27) and
// routeHoldCode's routing (R5-09, BL3-07, glossary §25.2 item 9). Every assertion is on ids, states and the
// onDelivered record; the store is the real one over a VirtualClock and a fixed-bytes Random.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventStore, routeHoldCode } from '../../src/claude/daemon/events.js';
import type { DaemonCtx } from '../../src/claude/daemon/ctx.js';
import { VirtualClock } from '../sim/vclock.js';
import { TraceRecorder } from '../sim/traceRecorder.js';
import { seededRandom } from '../../src/ports/random.js';

// A counting Random: every ulid call consumes 10 fresh bytes, so ids stay unique without any wall-time ordering.
let counter = 0;
const random: import('../../src/ports/random.js').Random = { bytes: (n: number) => Uint8Array.from({ length: n }, () => (counter = (counter + 1) % 256)) };

const make = () => {
  const clock = new VirtualClock({ startMono: 0 });
  return { clock, store: new EventStore(clock, random, new TraceRecorder()) };
};

const S1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const S2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const S3 = 'cccccccccccccccccccccccccccccccc';

const addNote = (s: EventStore, seatId: string | 'all', extra: Record<string, unknown> = {}): string[] =>
  s.add(seatId, { code: 'HELD_CS', params: {}, family: 'bystander', mandatory: false, slot: 'context', ...extra } as never);

test('add queues per seat in arrival order; pending lists only pending; batch+printed delivers once', () => {
  const { store } = make();
  const rec: Array<{ seatId: string; ids: readonly string[]; how: { carrier: string; batchId: string | null; nonce: string | null } }> = [];
  store.onDelivered((seatId, ids, how) => rec.push({ seatId, ids, how: { ...how } }));
  const [e1] = addNote(store, S1);
  const [e2] = addNote(store, S1);
  const [o1] = addNote(store, S2);
  assert.ok(e1 !== undefined && e2 !== undefined && o1 !== undefined && e1 !== e2);
  assert.deepEqual(store.pending(S1).map((e) => e.id), [e1, e2]);
  assert.deepEqual(store.pending(S2).map((e) => e.id), [o1]);
  assert.equal(store.pending(S3).length, 0);
  const batchId = store.batch(S1, [e1, e2, 'missing'], 'post');   // an unknown id is skipped
  assert.ok(batchId !== '');
  assert.deepEqual(store.pending(S1), []);                        // in_batch is not pending
  store.printed(batchId);
  store.printed(batchId);                                         // a repeated printed delivers nothing more
  assert.deepEqual(rec, [{ seatId: S1, ids: [e1, e2], how: { carrier: 'post', batchId, nonce: null } }]);
  assert.deepEqual(store.pending(S1), []);
  const empty = store.batch(S1, []);                              // nothing pending: the batch is created empty
  store.printed(empty);
  assert.equal(rec.length, 1);                                    // …and delivers nothing more
  assert.equal(store.cursor(S1), 2);
  assert.equal(store.cursor(S2), 0);
});

test('F2 #9: add(\'all\') returns one id per live seat at call time; a seat that appears later and an ended seat get nothing', () => {
  const { clock, store } = make();
  const live = [S1, S2];
  store.bindLiveSeats(() => live);
  clock.advance(5);
  const atCall = clock.monoMs();
  const ids = addNote(store, 'all');                              // the old code returned [] and copied at each hook
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);                                // one event id per target seat (Plan:1532)
  assert.deepEqual(store.pending(S1).map((e) => e.id), [ids[0]]); // held at once, before any hook
  assert.deepEqual(store.pending(S2).map((e) => e.id), [ids[1]]);
  assert.equal(store.pending(S1)[0]!.createdMono, atCall);        // the call time, not the hook time
  assert.deepEqual(store.pending(S3), []);
  live.push(S3);                                                  // a seat that appears later gets nothing
  store.nextHook(S3);
  assert.deepEqual(store.pending(S3), []);                        // an ended seat is not in the source either
});

test('F2 #9: queueSystemMessage and queueSeatContext(\'all\') return their ids, slot system / context', () => {
  const { store } = make();
  store.bindLiveSeats(() => [S1, S2]);
  const sys = store.queueSystemMessage('HELD_CS', { n: 2 });
  assert.equal(sys.length, 2);
  assert.notEqual(sys[0], sys[1]);
  assert.equal(store.pending(S1)[0]!.slot, 'system');
  assert.equal(store.pending(S2)[0]!.slot, 'system');
  const ctxIds = store.queueSeatContext('all', 'X_P5', {});
  assert.equal(ctxIds.length, 2);
  assert.equal(store.pending(S1)[1]!.id, ctxIds[0]);
  assert.equal(store.pending(S1)[1]!.slot, 'context');
});

test('F2 #9: unbound, \'all\' targets the seats whose last hook was live (the learned set)', () => {
  const { store } = make();
  store.nextHook(S1);
  store.nextHook(S2, { ended: true });                            // S2's last hook was ended: not live
  const ids = addNote(store, 'all');
  assert.equal(ids.length, 1);                                    // S1 only
  assert.deepEqual(store.pending(S1).map((e) => e.id), ids);
  assert.deepEqual(store.pending(S2), []);
  store.dropSeat(S1);                                             // a dropped seat leaves the learned set
  assert.deepEqual(addNote(store, 'all'), []);
});

test('V-10: an un-printed batch is re-queued with the same ids at the next hook and re-sent in full', () => {
  const { store } = make();
  const [e1] = addNote(store, S1);
  assert.ok(e1 !== undefined);
  const b1 = store.batch(S1, [e1], 'ups');
  store.nextHook(S1);                                             // the batch was never printed
  assert.deepEqual(store.pending(S1).map((e) => e.id), [e1]);     // the same id, pending again
  const b2 = store.batch(S1, [e1], 'ups');
  assert.notEqual(b2, b1);
  store.printed(b2);
  assert.deepEqual(store.pending(S1), []);
  assert.equal(store.cursor(S1), 2);                              // each batch that took the event counts it
});

test('a doorbell-carried event is delivered by the nonce only, exactly once, and never again via a pull carrier', () => {
  const { store } = make();
  const rec: Array<{ ids: readonly string[]; how: { carrier: string; nonce: string | null } }> = [];
  store.onDelivered((_seatId, ids, how) => rec.push({ ids, how: { carrier: how.carrier, nonce: how.nonce } }));
  const [e1] = addNote(store, S1);
  assert.ok(e1 !== undefined);
  store.doorbellSent('n1', [e1]);
  assert.deepEqual(store.nonceSeen('n0'), []);                    // an unknown nonce delivers nothing
  assert.deepEqual(store.nonceSeen('n1'), [e1]);
  assert.deepEqual(rec, [{ ids: [e1], how: { carrier: 'doorbell', nonce: 'n1' } }]);
  assert.deepEqual(store.nonceSeen('n1'), []);                    // never twice
  const [e2] = addNote(store, S1);
  assert.ok(e2 !== undefined);
  store.doorbellSent('n2', [e2]);
  const b = store.batch(S1, [e2], 'post');
  store.printed(b);                                               // the pull carrier delivered it first
  assert.deepEqual(rec[rec.length - 1]!.how.carrier, 'post');
  assert.deepEqual(store.nonceSeen('n2'), []);                    // the doorbell path delivers nothing more
});

test('addFirst is claimed by the first exit-0 hook and never by a second seat', () => {
  const { store } = make();
  store.addFirst({ code: 'HELD_CS', params: {}, family: 'note', mandatory: false, slot: 'context' });
  assert.deepEqual(store.pending(S1), []);
  store.nextHook(S1);
  const p = store.pending(S1);
  assert.equal(p.length, 1);
  store.nextHook(S2);
  assert.deepEqual(store.pending(S2), []);                        // claimed once
  store.addFirst({ code: 'HELD_CS', params: {}, family: 'note', mandatory: false, slot: 'context' });
  store.nextHook(S3, { ended: true });                            // an ended seat does not claim
  store.nextHook(S2);
  assert.equal(store.pending(S2).length, 1);
});

test('F2 #4: two addFirst rows before any hook go, in order, to the first live seat that hooks and to no other seat, and retire once delivered', () => {
  const { store } = make();
  const rec: Array<{ seatId: string; ids: readonly string[] }> = [];
  store.onDelivered((seatId, ids) => rec.push({ seatId, ids }));
  const h1 = store.addFirst({ code: 'HOLD_MIRROR_REJECTED', params: { rid: 'r1' }, family: 'note', mandatory: false, slot: 'context' });
  const h2 = store.addFirst({ code: 'HOLD_MIRROR_REJECTED', params: { rid: 'r2' }, family: 'note', mandatory: false, slot: 'context' });
  assert.deepEqual(store.pending(S1), []);                        // unclaimed: no seat lists it
  store.nextHook(S1);
  assert.deepEqual(store.pending(S1).map((e) => e.id), [h1, h2], 'the first live seat to hook claims both rows, in order, by their own ids');
  store.nextHook(S2);
  assert.deepEqual(store.pending(S2), [], 'a second seat gets no copy of either row');
  const b = store.batch(S1, [h1, h2], 'post');
  store.printed(b);
  assert.deepEqual(rec, [{ seatId: S1, ids: [h1, h2] }]);
  store.nextHook(S3);
  store.nextHook(S2);
  assert.deepEqual(store.pending(S3), [], 'a later seat gets nothing: the rows retired once delivered');
  assert.deepEqual(store.pending(S2), []);
  assert.deepEqual(store.pending(S1), []);
});

const openFields = (s: EventStore): Record<string, number> => {
  const z = s.sizes();
  return { rows: z.rows, open: z.open, unprinted: z.unprinted, nonces: z.nonces, unclaimed: z.unclaimed };
};

test('F2 #8: 10,000 delivered events leave no rows, batches, queue entries or nonces behind', () => {
  // A seeded Random: the counting one repeats its ulids every 128 draws on a still clock, and 11,000 events need
  // distinct ids.
  const store = new EventStore(new VirtualClock({ startMono: 0 }), seededRandom('f2-8-history'), new TraceRecorder());
  const seats = [S1, S2, S3, 'dddddddddddddddddddddddddddddddd'];
  let delivered = 0;
  store.onDelivered((_s, ids) => { delivered += ids.length; });
  let lastBatch = '';
  for (let i = 0; i < 10_000; i++) {
    const seat = seats[i % 4]!;
    const [id] = addNote(store, seat);
    lastBatch = store.batch(seat, [id!], 'post');
    store.printed(lastBatch);
  }
  for (let i = 0; i < 500; i++) {                                 // the doorbell path: delivered by the nonce UPS
    const seat = seats[i % 4]!;
    const [id] = addNote(store, seat);
    store.doorbellSent(`cws-${i.toString(16).padStart(16, '0')}`, [id!]);
    assert.deepEqual(store.nonceSeen(`cws-${i.toString(16).padStart(16, '0')}`), [id]);
  }
  for (let i = 0; i < 500; i++) {                                 // the PULL_MODE path: retired at compose time
    const seat = seats[i % 4]!;
    store.retire(addNote(store, seat));
  }
  for (const seat of seats) store.nextHook(seat);
  assert.equal(delivered, 10_500, 'every printed or nonce-delivered event fired once; retire fired none');
  assert.deepEqual(openFields(store), { rows: 0, open: 0, unprinted: 0, nonces: 0, unclaimed: 0 });
  store.printed(lastBatch);                                       // a repeated printed still delivers nothing
  assert.deepEqual(store.nonceSeen(`cws-${(0).toString(16).padStart(16, '0')}`), []);   // a spent nonce delivers nothing
  assert.equal(delivered, 10_500);
  for (const seat of seats) assert.deepEqual(store.pending(seat), []);
});

test('F2 #8: dropSeat forgets the seat\'s rows, un-printed batches, nonces and cursor, and returns its claimed addFirst rows to the next seat', () => {
  const { store } = make();
  const rec: unknown[] = [];
  store.onDelivered((_s, ids) => rec.push(ids));
  const f = store.addFirst({ code: 'HOLD_MIRROR_REJECTED', params: { rid: 'r1' }, family: 'note', mandatory: false, slot: 'context' });
  store.nextHook(S1);                                             // S1 claims the addFirst row and never delivers it
  const ten: string[] = [];
  for (let i = 0; i < 10; i++) ten.push(...addNote(store, S1));
  const two = [...addNote(store, S1), ...addNote(store, S1)];
  const b = store.batch(S1, two, 'post');                         // one un-printed batch
  store.doorbellSent('cws-00000000000000aa', [ten[0]!]);          // one doorbell nonce
  assert.deepEqual(openFields(store), { rows: 13, open: 13, unprinted: 1, nonces: 1, unclaimed: 0 });
  assert.equal(store.cursor(S1), 2);
  store.dropSeat(S1);
  assert.deepEqual(openFields(store), { rows: 1, open: 0, unprinted: 0, nonces: 0, unclaimed: 1 });   // only the returned addFirst row
  assert.equal(store.cursor(S1), 0);
  assert.deepEqual(store.pending(S1), []);
  store.printed(b);                                               // the dropped batch delivers nothing
  assert.deepEqual(store.nonceSeen('cws-00000000000000aa'), []);  // the dropped nonce delivers nothing
  assert.deepEqual(rec, []);
  store.nextHook(S2);
  assert.deepEqual(store.pending(S2).map((e) => e.id), [f], 'the next live seat claims the returned row by its own id');
  assert.equal(store.sizes().unclaimed, 0);
});

test("F2 #49: add('') names no seat: no row and no broadcast", () => {
  const { store } = make();
  const before = store.sizes().rows;
  assert.deepEqual(addNote(store, ''), []);
  assert.deepEqual(store.queueSeatContext('', 'HELD_CS', {}), []);
  assert.equal(store.sizes().rows, before);
  store.nextHook(S1);
  assert.deepEqual(store.pending(S1), [], 'no seat materializes a copy of a seatless row');
});

test('retire drops the suppressed ids without delivering them (A7-3)', () => {
  const { store } = make();
  const [e1] = addNote(store, S1);
  const [e2] = addNote(store, S1);
  assert.ok(e1 !== undefined && e2 !== undefined);
  store.retire([e1, 'unknown']);
  assert.deepEqual(store.pending(S1).map((e) => e.id), [e2]);     // e1 is gone from the seat's queue
  const b = store.batch(S1, [e2]);
  store.printed(b);
  store.retire([e2]);                                             // an already-delivered row stays delivered
  const rec: unknown[] = [];
  store.onDelivered((_s, ids) => rec.push(ids));
  assert.deepEqual(rec, []);
});

// ---- routeHoldCode (R5-09) ------------------------------------------------------------------------------------------------

function holdCtx(store: EventStore, o: { seats?: Array<{ seat_id: string; activity: string }>; bySeat?: Record<string, { ended: boolean }>; fullRead?: Record<string, string[]>; registry?: Map<string, { origin: string; id: string }> } = {}): DaemonCtx {
  return {
    events: store,
    seats: {
      seats: () => o.seats ?? [],
      bySeatId: (sid: string) => (o.bySeat ?? {})[sid] ?? null,
    },
    readSets: { fullReadSet: (sid: string) => new Set((o.fullRead ?? {})[sid] ?? []) },
    engine: { registry: () => o.registry ?? new Map() },
  } as unknown as DaemonCtx;
}

test('CS_UNPUBLISHED_NUDGE posts once per CS to the seat segment and skips a peer CS; PULL suppression retires it later', () => {
  const { store } = make();
  const ctx = holdCtx(store);
  const first = routeHoldCode({ code: 'CS_UNPUBLISHED_NUDGE', params: { cs: `${S1}/a1`, n: 2 } }, ctx);
  assert.equal(first.length, 1);
  const row = store.pending(S1)[0]!;
  assert.equal(row.code, 'CS_UNPUBLISHED_NUDGE');
  assert.deepEqual(row.params, { n: 2 });
  assert.equal(row.family, 'nudge');
  assert.deepEqual(row.carriers, ['post']);
  assert.deepEqual(routeHoldCode({ code: 'CS_UNPUBLISHED_NUDGE', params: { cs: `${S1}/a1`, n: 3 } }, ctx), []);   // once per CS
  assert.deepEqual(routeHoldCode({ code: 'CS_UNPUBLISHED_NUDGE', params: { cs: 'peer-1/human/1', n: 1 } }, ctx), []);   // a peer CS names no seat
  store.retire(first);                                            // under PULL_MODE the nudge retires (BL3-07)
  assert.deepEqual(store.pending(S1), []);
});

test('F2 #57: the once-per-CS nudge set forgets an ended seat\'s CS ids', () => {
  const { store } = make();
  const ctx = holdCtx(store, { registry: new Map([['hold-1', { origin: `${S1}/a1`, id: 'rid-1' }]]) });
  assert.equal(routeHoldCode({ code: 'CS_UNPUBLISHED_NUDGE', params: { cs: `${S1}/a1`, n: 1 } }, ctx).length, 1);
  assert.equal(routeHoldCode({ code: 'CS_UNPUBLISHED_NUDGE', params: { cs: `${S2}/b1`, n: 1 } }, ctx).length, 1);
  assert.equal(routeHoldCode({ code: 'HOLD_MIRROR_REJECTED', params: { hold_id: 'hold-1' } }, ctx).length, 1);
  assert.equal(store.sizes().onceKeys, 3, 'two nudge keys and one mirror key live in the store');
  store.dropSeat(S1);
  assert.equal(store.sizes().onceKeys, 2, 'the S1/ nudge key is gone; S2\'s and the mirror key stay');
  assert.deepEqual(routeHoldCode({ code: 'CS_UNPUBLISHED_NUDGE', params: { cs: `${S2}/b1`, n: 2 } }, ctx), [], 'S2 keeps its once');
  assert.deepEqual(routeHoldCode({ code: 'HOLD_MIRROR_REJECTED', params: { hold_id: 'hold-1' } }, ctx), [], 'once per hold id for the daemon run');
});

test('CS_GROUP_WAITING and CS_READY_CANCELLED post to the named seat; INCOMING_WAITING goes to seats whose full-read set holds the path', () => {
  const { store } = make();
  const ctx = holdCtx(store, {
    seats: [{ seat_id: S1, activity: 'MID_TURN' }, { seat_id: S2, activity: 'ENDED' }],
    fullRead: { [S1]: ['src/a.ts'], [S2]: ['src/a.ts'] },
  });
  const g = routeHoldCode({ code: 'CS_GROUP_WAITING', params: { cs: `${S1}/a1` } }, ctx);
  assert.equal(g.length, 1);
  const w = routeHoldCode({ code: 'INCOMING_WAITING', params: { path: 'src/a.ts' } }, ctx);
  assert.deepEqual(w.length, 1);                                  // S2 is ENDED → skipped
  assert.equal(store.pending(S1).filter((e) => e.code === 'INCOMING_WAITING').length, 1);
  const c = routeHoldCode({ code: 'CS_READY_CANCELLED', params: { cs: `${S2}/a1` } }, ctx);
  assert.equal(c.length, 1);
  assert.deepEqual(routeHoldCode({ code: 'HOLD_CREATED', params: {} }, ctx), []);   // not routed
});

test('HOLD_MIRROR_REJECTED goes to the origin seat as {rid}; a second one is once per hold id; an ended origin seat uses addFirst', () => {
  const { store } = make();
  const reg = new Map([['hold-1', { origin: `${S1}/a1`, id: 'rid-9' }]]);
  const ctx = holdCtx(store, { registry: reg });
  const first = routeHoldCode({ code: 'HOLD_MIRROR_REJECTED', params: { hold_id: 'hold-1' } }, ctx);
  assert.equal(first.length, 1);
  const row = store.pending(S1)[0]!;
  assert.deepEqual(row.params, { rid: 'rid-9' });                 // the display id, never the host's text
  assert.deepEqual(routeHoldCode({ code: 'HOLD_MIRROR_REJECTED', params: { hold_id: 'hold-1' } }, ctx), []);
  const b = store.batch(S1, store.pending(S1).map((e) => e.id));   // deliver the first note before the addFirst part
  store.printed(b);
  const ctx2 = holdCtx(store, { registry: new Map([['hold-2', { origin: `${S2}/a1`, id: 'rid-2' }]]), bySeat: { [S2]: { ended: true } } });
  const second = routeHoldCode({ code: 'HOLD_MIRROR_REJECTED', params: { hold_id: 'hold-2' } }, ctx2);
  assert.equal(second.length, 1);                                 // addFirst: the next exit-0 hook carries it
  store.nextHook(S1);
  const p = store.pending(S1);
  assert.equal(p.length, 1);
  assert.deepEqual(p[0]!.params, { rid: 'rid-2' });
});

// ---- F2 fix round 1 ---------------------------------------------------------------------------------------------------

test('F2 #8 r1: dropSeat puts the claimed addFirst rows back at the front of the unclaimed FIFO, in their original order', () => {
  const { store } = make();
  const af = (rid: string): string => store.addFirst({ code: 'HOLD_MIRROR_REJECTED', params: { rid }, family: 'note', mandatory: false, slot: 'context' });
  const r1 = af('r1');
  const r2 = af('r2');
  store.nextHook(S1);                                             // S1 claims r1 and r2 and never delivers them
  const u = af('u');                                              // a third row no seat has claimed yet
  assert.deepEqual(store.pending(S1).map((e) => e.id), [r1, r2]);
  store.dropSeat(S1);
  assert.equal(store.sizes().unclaimed, 3);
  store.nextHook(S2);
  assert.deepEqual(store.pending(S2).map((e) => e.id), [r1, r2, u], 'the returned rows first, in their order, then the unclaimed one');
});

test('F2 #57 r1: routeHoldCode posts nothing for a seat that has ended, so a dropped seat gets no new row or once-key', () => {
  const { store } = make();
  const ctx = holdCtx(store, { bySeat: { [S1]: { ended: true }, [S2]: { ended: false } } });
  store.dropSeat(S1);                                             // the seat's end ran before the raise
  assert.deepEqual(routeHoldCode({ code: 'CS_UNPUBLISHED_NUDGE', params: { cs: `${S1}/a1`, n: 1 } }, ctx), []);
  assert.deepEqual(routeHoldCode({ code: 'CS_GROUP_WAITING', params: { cs: `${S1}/a1` } }, ctx), []);
  assert.deepEqual(routeHoldCode({ code: 'CS_READY_CANCELLED', params: { cs: `${S1}/a1` } }, ctx), []);
  assert.deepEqual(store.sizes(), { rows: 0, open: 0, unprinted: 0, nonces: 0, unclaimed: 0, onceKeys: 0 }, 'nothing re-created for the ended seat');
  assert.equal(routeHoldCode({ code: 'CS_UNPUBLISHED_NUDGE', params: { cs: `${S2}/b1`, n: 1 } }, ctx).length, 1, 'a live seat still gets its nudge');
});
