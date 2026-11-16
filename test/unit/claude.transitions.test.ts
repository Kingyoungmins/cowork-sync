// test/unit/claude.transitions.test.ts — the transition deliverer (CCI-44, A7-6, A7-9, 06 §3.6.2): transitionItems'
// pure pairing, the per-seat last-seen baseline (each seat's transition since it last saw the status, computed at
// its hook), the first-seen materialization, DAEMON_DOWN once per heartbeat, the 10-minute OFFLINE/AUTH repeat once
// per seat per episode, and the plan's Transitions cells. Every assertion is on codes, slots and typed params.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transitionItems, transitionDeliverStep, Transitions, type TransitionTriple } from '../../src/claude/daemon/transitions.js';
import { EventStore } from '../../src/claude/daemon/events.js';
import type { DaemonCtx, HookRequest, ReplyDraft } from '../../src/claude/daemon/ctx.js';
import { seededRandom } from '../../src/ports/random.js';
import { TraceRecorder } from '../sim/traceRecorder.js';
import type { StatusJson } from '../../src/engine/status.js';
import { VirtualClock } from '../sim/vclock.js';
import { C } from '../../src/claude/wire/constants.js';
import { codeOnlyDigest, finishReply } from '../../src/claude/daemon/carriers.js';
import { BudgetMeter } from '../../src/claude/daemon/meter.js';
import { noDueRequests } from '../../src/claude/daemon/claudeDaemon.js';

const status = (o: Partial<StatusJson>): StatusJson => ({
  v: 1, state: 'ok', freeze_reasons: [], publish_pause: null, branch: 'b', peer_id: 'peer-1', plugin_version: '0.0.0',
  heartbeat_mono_ms: 0, loop_period_ms: 1000, last_fetch_age_ms: null, last_push_age_ms: null,
  pending: { cs_ready: 0, cs_open: 0, holds_active: 0, holds_local_only: 0, incoming: 0, not_converged: [] },
  claims_held: 0, requests_in: 0, requests_out: 0, adopt: { state: 'current', reasons: [] },
  message_code: null, message_params: {}, ...o,
});

const baseline: TransitionTriple = { state: 'ok', freeze_reasons: [], publish_pause: null, offline_for_s: 0, offlineRepeatSent: false };
const codes = (items: readonly { code: string }[]): string[] => items.map((i) => i.code);
const ofSlot = (items: readonly { slot: string }[], slot: string): number => items.filter((i) => i.slot === slot).length;

test('transitionItems: freeze added/removed, the pause rows and the cleared pause pair one system + one context item', () => {
  const frozen = transitionItems(baseline, status({ freeze_reasons: ['PAUSED'] }));
  assert.deepEqual(codes(frozen), ['FROZEN', 'FROZEN']);
  assert.equal(ofSlot(frozen, 'system'), 1);
  assert.equal(ofSlot(frozen, 'context'), 1);
  assert.deepEqual(frozen[0]!.params, { reason: 'PAUSED' });
  const unfrozen = transitionItems({ ...baseline, freeze_reasons: ['PAUSED'] }, status({}));
  assert.deepEqual(codes(unfrozen), ['UNFROZEN', 'UNFROZEN']);
  assert.deepEqual(unfrozen[0]!.params, { reason: 'PAUSED' });
  const offline = transitionItems(baseline, status({ publish_pause: 'OFFLINE', message_params: { offline_for_s: 45, label: 'OFFLINE' } }));
  assert.deepEqual(codes(offline), ['OFFLINE', 'OFFLINE']);
  assert.deepEqual(offline[0]!.params, { offline_for_s: 45, label: 'OFFLINE' });
  const auth = transitionItems(baseline, status({ publish_pause: 'AUTH', message_params: { label: 'AUTH' } }));
  assert.deepEqual(codes(auth), ['OFFLINE', 'OFFLINE']);          // AUTH pauses under the OFFLINE code with its label
  assert.deepEqual(auth[0]!.params, { offline_for_s: 0, label: 'AUTH' });
  const nonretryable = transitionItems(baseline, status({ publish_pause: 'NONRETRYABLE', message_params: { hold_id: 'h1' } }));
  assert.deepEqual(codes(nonretryable), ['NONRETRYABLE', 'NONRETRYABLE']);
  assert.deepEqual(nonretryable[0]!.params, { hold_id: 'h1' });   // the PIN id only, never the host's text
  const version = transitionItems(baseline, status({ publish_pause: 'VERSION', message_params: { form: 'plugin' } }));
  assert.deepEqual(codes(version), ['VERSION_PAUSED', 'VERSION_PAUSED']);
  assert.deepEqual(version[0]!.params, { form: 'plugin' });
  const online = transitionItems({ ...baseline, publish_pause: 'OFFLINE' }, status({}));
  assert.deepEqual(codes(online), ['ONLINE', 'ONLINE']);
  assert.deepEqual(online[0]!.params, {});
  // No change, no items; a return to ok adds nothing beyond the component lines.
  assert.deepEqual(transitionItems(baseline, status({})), []);
  assert.deepEqual(transitionItems({ ...baseline, state: 'incident' }, status({ state: 'ok' })), []);
});

test('transitionItems: degraded/incident announces its message_code only when no freeze or pause change rides along', () => {
  const degraded = transitionItems(baseline, status({ state: 'degraded', message_code: 'SYNC_LAG', message_params: { n: 3 } }));
  assert.deepEqual(codes(degraded), ['SYNC_LAG', 'SYNC_LAG']);
  assert.deepEqual(degraded[0]!.params, { n: 3 });
  const withFreeze = transitionItems(baseline, status({ state: 'degraded', freeze_reasons: ['INCIDENT'], message_code: 'SYNC_LAG', message_params: {} }));
  assert.deepEqual(codes(withFreeze), ['FROZEN', 'FROZEN']);      // the freeze line only (the message would be a duplicate)
  const okAgain = transitionItems({ ...baseline, state: 'degraded' }, status({ state: 'ok' }));
  assert.deepEqual(okAgain, []);
});

test('forSeat hands each seat its transition since it last saw the status, once; a seat first seen mid-status materializes from its baseline', () => {
  const t = new Transitions(() => 0);
  t.observe(status({ freeze_reasons: ['EPOCH'] }), 0);
  const first = t.forSeat('s1');
  assert.deepEqual(codes(first), ['FROZEN', 'FROZEN']);
  assert.deepEqual(t.forSeat('s1'), []);                          // consumed once
  t.observe(status({}), 0);
  assert.deepEqual(codes(t.forSeat('s1')), ['UNFROZEN', 'UNFROZEN']);
  assert.deepEqual(t.forSeat('s2'), []);                          // s2's own baseline is the current status: no transition
  // A seat first seen mid-episode sees the current status as its transition.
  const t2 = new Transitions(() => 0);
  t2.observe(status({ freeze_reasons: ['MASS'] }), 0);
  assert.deepEqual(codes(t2.forSeat('s9')), ['FROZEN', 'FROZEN']);
});

test('DAEMON_DOWN is announced once per seat until a fresh status re-arms it', () => {
  const clock = new VirtualClock({ startMono: 0 });
  const t = new Transitions(() => clock.monoMs());
  t.observe(status({ heartbeat_mono_ms: 0, loop_period_ms: 1000 }), 0);
  clock.advance(2500);
  assert.deepEqual(t.forSeat('s1'), []);                          // 2,500 ≤ 3×1,000: still fresh
  clock.advance(1000);                                            // 3,500 > 3,000
  const down = t.forSeat('s1');
  assert.deepEqual(codes(down), ['DAEMON_DOWN', 'DAEMON_DOWN']);
  assert.deepEqual(codes(t.forSeat('s1')), []);                   // once per heartbeat
  t.observe(status({ heartbeat_mono_ms: 3500, loop_period_ms: 1000 }), 0);   // a fresh status
  clock.advance(0);
  const again = t.forSeat('s1');
  assert.deepEqual(codes(again), []);                             // the fresh heartbeat is not stale
  clock.advance(4000);
  assert.deepEqual(codes(t.forSeat('s1')), ['DAEMON_DOWN', 'DAEMON_DOWN']);
});

test('the 10-minute OFFLINE repeat fires once per episode at the first observation ≥ 600 s', () => {
  const t = new Transitions(() => 0);
  t.observe(status({ publish_pause: 'OFFLINE', message_params: { offline_for_s: 100, label: 'OFFLINE' } }), 0);
  const first = t.forSeat('s1');
  assert.deepEqual(codes(first), ['OFFLINE', 'OFFLINE']);
  assert.deepEqual(first[0]!.params, { offline_for_s: 100, label: 'OFFLINE' });
  t.observe(status({ publish_pause: 'OFFLINE', message_params: { offline_for_s: 700, label: 'OFFLINE' } }), 0);
  const rep = t.forSeat('s1');
  assert.deepEqual(codes(rep), ['OFFLINE', 'OFFLINE']);           // the repeat pair
  assert.deepEqual(rep[0]!.params, { offline_for_s: 700, label: 'OFFLINE', repeat: 'true' });
  t.observe(status({ publish_pause: 'OFFLINE', message_params: { offline_for_s: 800, label: 'OFFLINE' } }), 0);
  assert.deepEqual(t.forSeat('s1'), []);                          // once per episode
  t.observe(status({ publish_pause: null, message_params: {} }), 0);
  assert.deepEqual(codes(t.forSeat('s1')), ['ONLINE', 'ONLINE']);
  t.observe(status({ publish_pause: 'OFFLINE', message_params: { offline_for_s: 900, label: 'OFFLINE' } }), 0);
  const second = t.forSeat('s1');                                 // a new episode: the first OFFLINE pair, no repeat flag
  assert.deepEqual(second[0]!.params, { offline_for_s: 900, label: 'OFFLINE' });
  // A seat first exposed inside a long episode counts it as the episode's first pair: no repeat for it.
  const t2 = new Transitions(() => 0);
  t2.observe(status({ publish_pause: 'OFFLINE', message_params: { offline_for_s: 700, label: 'OFFLINE' } }), 0);
  const s2 = t2.forSeat('s2');
  assert.deepEqual(s2[0]!.params, { offline_for_s: 700, label: 'OFFLINE' });
  t2.observe(status({ publish_pause: 'OFFLINE', message_params: { offline_for_s: 800, label: 'OFFLINE' } }), 0);
  assert.deepEqual(t2.forSeat('s2'), []);
});

// ---- F2 #14 and the plan's Transitions cells (plan 2880, 2883) ------------------------------------------------------------

const lines = (items: readonly { code: string; slot: string; params: unknown }[]): Array<[string, string, unknown]> =>
  items.map((i) => [i.code, i.slot, i.params]);
const pairOf = (code: string, params: unknown): Array<[string, string, unknown]> => [[code, 'system', params], [code, 'context', params]];

test('one systemMessage and one context line per seat per status.json transition; a stale heartbeat renders DAEMON_DOWN', () => {
  const clock = new VirtualClock({ startMono: 1_000 });
  const t = new Transitions(() => clock.monoMs());
  const hb = { heartbeat_mono_ms: 1_000, loop_period_ms: 2_500 };
  t.observe(status({ ...hb }), 0);
  for (const s of ['A', 'B', 'C']) assert.deepEqual(t.forSeat(s), [], `${s} is seen at the ok baseline`);
  t.observe(status({ ...hb, state: 'frozen', freeze_reasons: ['NOHOOKS'] }), 0);
  assert.deepEqual(lines(t.forSeat('A')), pairOf('FROZEN', { reason: 'NOHOOKS' }));
  t.observe(status({ ...hb, state: 'frozen', freeze_reasons: ['EPOCH', 'NOHOOKS'] }), 0);
  assert.deepEqual(lines(t.forSeat('A')), pairOf('FROZEN', { reason: 'EPOCH' }));
  const byReason = (l: Array<[string, string, unknown]>): string[] => l.map((x) => JSON.stringify(x)).sort();   // the order of two pairs from one hook is not the contract
  assert.deepEqual(byReason(lines(t.forSeat('C'))), byReason([...pairOf('FROZEN', { reason: 'EPOCH' }), ...pairOf('FROZEN', { reason: 'NOHOOKS' })]), 'C gets both FROZEN pairs at once');
  t.observe(status({ ...hb }), 0);
  assert.deepEqual(lines(t.forSeat('A')), [...pairOf('UNFROZEN', { reason: 'EPOCH' }), ...pairOf('UNFROZEN', { reason: 'NOHOOKS' })]);
  assert.deepEqual(lines(t.forSeat('B')), [], "B gets nothing: its last-seen triple equals the current one");
  // The 2885 numbers: heartbeat 1,000, loop period 2,500 → stale only past 1,000 + 3 × 2,500 = 8,500.
  clock.advance(8_500 - clock.monoMs());
  assert.deepEqual(t.forSeat('A'), [], 'at 8,500 the heartbeat is not stale yet');
  clock.advance(1);
  assert.deepEqual(lines(t.forSeat('A')), pairOf('DAEMON_DOWN', {}));
  assert.deepEqual(lines(t.forSeat('B')), pairOf('DAEMON_DOWN', {}));
  assert.deepEqual(t.forSeat('A'), [], 'once per seat until a fresh status');
});

test('the OFFLINE text is repeated once per seat when the episode reaches 10 min', () => {
  const t = new Transitions(() => 0);
  const off = (s: number): StatusJson => status({ state: 'offline', publish_pause: 'OFFLINE', message_params: { offline_for_s: s, label: 'OFFLINE' } });
  t.observe(status({}), 0);
  assert.deepEqual(t.forSeat('s1'), []);
  assert.deepEqual(t.forSeat('s2'), []);                          // s2 is known at the ok baseline, then makes no hook until 900
  t.observe(off(42), 0);
  assert.deepEqual(lines(t.forSeat('s1')), pairOf('OFFLINE', { offline_for_s: 42, label: 'OFFLINE' }));
  t.observe(off(599), 0);
  assert.deepEqual(t.forSeat('s1'), [], 'no repeat before 600 s');
  t.observe(off(600), 0);
  assert.deepEqual(lines(t.forSeat('s1')), pairOf('OFFLINE', { offline_for_s: 600, label: 'OFFLINE', repeat: 'true' }));
  t.observe(off(900), 0);
  assert.deepEqual(t.forSeat('s1'), [], 'one repeat per episode');
  assert.deepEqual(lines(t.forSeat('s2')), pairOf('OFFLINE', { offline_for_s: 900, label: 'OFFLINE' }), 'a seat whose first hook of the episode comes at 900 gets one pair only');
  assert.deepEqual(t.forSeat('s2'), []);
  // A new episode resets the repeat.
  t.observe(status({}), 0);
  assert.deepEqual(lines(t.forSeat('s1')), pairOf('ONLINE', {}));
  t.observe(off(30), 0);
  assert.deepEqual(lines(t.forSeat('s1')), pairOf('OFFLINE', { offline_for_s: 30, label: 'OFFLINE' }));
  t.observe(off(600), 0);
  assert.deepEqual(lines(t.forSeat('s1')), pairOf('OFFLINE', { offline_for_s: 600, label: 'OFFLINE', repeat: 'true' }));
});

test('F2 #14: AUTH repeats once after OFFLINE_NOTICE_AGAIN_MS', () => {
  const again = C.OFFLINE_NOTICE_AGAIN_MS / 1000;
  const t = new Transitions(() => 0);
  const auth = (s: number): StatusJson => status({ state: 'offline', publish_pause: 'AUTH', message_params: { offline_for_s: s, label: 'AUTH' } });
  t.observe(status({}), 0);
  assert.deepEqual(t.forSeat('s1'), []);
  t.observe(auth(42), 0);
  assert.deepEqual(lines(t.forSeat('s1')), pairOf('OFFLINE', { offline_for_s: 42, label: 'AUTH' }));
  t.observe(auth(again - 1), 0);
  assert.deepEqual(t.forSeat('s1'), []);
  t.observe(auth(again), 0);
  assert.deepEqual(lines(t.forSeat('s1')), pairOf('OFFLINE', { offline_for_s: again, label: 'AUTH', repeat: 'true' }), 'the 10-minute repeat applies to AUTH too');
  t.observe(auth(again + 300), 0);
  assert.deepEqual(t.forSeat('s1'), []);
});

// ---- F2 #11: transition.deliver writes store rows (at-least-once) ---------------------------------------------------------

const SEAT = 'e'.repeat(32);
const stepCtx = (): DaemonCtx =>
  ({ transitions: new Transitions(() => 0), events: new EventStore(new VirtualClock({ startMono: 0 }), seededRandom('f2-11-step'), new TraceRecorder()) }) as never;
const hookOf = (): HookRequest => ({ seat: { seatId: SEAT, ended: false } }) as never;
const draft = (deny: ReplyDraft['deny'] = null): ReplyDraft => ({ items: [], deny, block: null }) as never;

test('F2 #11: transition.deliver stores each pair as two store rows that a never-printed reply re-offers and printed retires', async () => {
  const ctx = stepCtx();
  ctx.transitions.observe(status({ state: 'frozen', freeze_reasons: ['EPOCH'] }), 0);
  const d = draft();
  await transitionDeliverStep(hookOf(), d, ctx);
  assert.deepEqual(d.items, [], 'no transition rides d.items');
  const rows = ctx.events.pending(SEAT);
  assert.deepEqual(rows.map((e) => [e.code, e.slot, e.family, e.params, e.carriers]), [
    ['FROZEN', 'system', 'transition', { reason: 'EPOCH' }, ['session_start', 'ups', 'pre_context', 'post']],
    ['FROZEN', 'context', 'transition', { reason: 'EPOCH' }, ['session_start', 'ups', 'pre_context', 'post']],
  ]);
  const ids = rows.map((e) => e.id);
  ctx.events.batch(SEAT, ids, 'post');
  ctx.events.nextHook(SEAT);                                      // that reply was never printed
  assert.deepEqual(ctx.events.pending(SEAT).map((e) => e.id), ids, 'the same two rows are offered again');
  const b = ctx.events.batch(SEAT, ids, 'post');
  ctx.events.printed(b);
  assert.deepEqual(ctx.events.pending(SEAT), []);
  const d2 = draft();
  await transitionDeliverStep(hookOf(), d2, ctx);
  assert.deepEqual(ctx.events.pending(SEAT), [], 'the next step call adds nothing');
  assert.deepEqual(d2.items, []);
});


// ---- F2 #38: the plan's remaining Transitions cells (plan 2881, 2882, 2884-2886, 2888) -----------------------------------

test('NONRETRYABLE renders only the host-reject PIN id', () => {
  const s = status({ publish_pause: 'NONRETRYABLE', message_code: 'NONRETRYABLE', message_params: { hold_id: '01JAXZ0000000000000000000A', text: 'remote: rejected by policy' } });
  const items = transitionItems(baseline, s);
  assert.deepEqual(items.map((i) => ({ code: i.code, params: i.params })), [
    { code: 'NONRETRYABLE', params: { hold_id: '01JAXZ0000000000000000000A' } },
    { code: 'NONRETRYABLE', params: { hold_id: '01JAXZ0000000000000000000A' } },
  ]);
  assert.ok(!JSON.stringify(items).includes('remote:'), 'never the host text');
  const t = new Transitions(() => 0);
  t.observe(s, 0);
  const viaSeat = t.forSeat('s1');
  assert.deepEqual(viaSeat.map((i) => i.params), [{ hold_id: '01JAXZ0000000000000000000A' }, { hold_id: '01JAXZ0000000000000000000A' }]);
  assert.ok(!JSON.stringify(viaSeat).includes('remote:'));
});

test("OFFLINE and AUTH carry this PC's offline_for_s; their end renders ONLINE", () => {
  const t = new Transitions(() => 0);
  t.observe(status({}), 0);
  assert.deepEqual(t.forSeat('s1'), []);
  t.observe(status({ state: 'offline', publish_pause: 'OFFLINE', message_params: { offline_for_s: 42 } }), 0);
  assert.deepEqual(lines(t.forSeat('s1')), pairOf('OFFLINE', { offline_for_s: 42, label: 'OFFLINE' }));
  t.observe(status({ state: 'offline', publish_pause: 'AUTH', message_params: { offline_for_s: 50 } }), 0);
  assert.deepEqual(lines(t.forSeat('s1')), pairOf('OFFLINE', { offline_for_s: 50, label: 'AUTH' }), 'AUTH labels itself when the status names no label');
  t.observe(status({}), 0);
  assert.deepEqual(lines(t.forSeat('s1')), pairOf('ONLINE', {}));
  t.observe(status({ state: 'paused', publish_pause: 'VERSION', message_params: { form: 'plugin' } }), 0);
  assert.deepEqual(lines(t.forSeat('s1')), pairOf('VERSION_PAUSED', { form: 'plugin' }));
});

test('state degraded renders the status code; recovery to ok renders nothing', () => {
  const t = new Transitions(() => 0);
  t.observe(status({}), 0);
  assert.deepEqual(t.forSeat('s1'), []);
  t.observe(status({ state: 'degraded', message_code: 'HOLD_DIVERGED_REGIONS', message_params: { n: 2, age: 61 } }), 0);
  assert.deepEqual(lines(t.forSeat('s1')), pairOf('HOLD_DIVERGED_REGIONS', { n: 2, age: 61 }));
  t.observe(status({}), 0);
  assert.deepEqual(t.forSeat('s1'), [], 'degraded → ok renders nothing');
  t.observe(status({ state: 'incident', message_code: 'INCIDENT', message_params: { n: 1, kind: 'mass' } }), 0);
  assert.deepEqual(lines(t.forSeat('s1')), pairOf('INCIDENT', { n: 1, kind: 'mass' }));
});

test('a stale heartbeat renders DAEMON_DOWN once per seat until a fresh status is observed', () => {
  const clock = new VirtualClock({ startMono: 0 });
  const t = new Transitions(() => clock.monoMs());
  t.observe(status({ heartbeat_mono_ms: 1_000, loop_period_ms: 2_500 }), 0);
  clock.advance(8_500);
  assert.deepEqual(t.forSeat('s1'), [], 'heartbeat clock 8,500: not stale');
  assert.deepEqual(t.forSeat('s2'), []);
  clock.advance(1);
  assert.deepEqual(lines(t.forSeat('s1')), pairOf('DAEMON_DOWN', {}));
  assert.deepEqual(lines(t.forSeat('s2')), pairOf('DAEMON_DOWN', {}));
  assert.deepEqual(t.forSeat('s1'), []);
  assert.deepEqual(t.forSeat('s2'), []);
  t.observe(status({ heartbeat_mono_ms: 8_501, loop_period_ms: 2_500 }), 0);   // a newer heartbeat re-arms
  assert.deepEqual(t.forSeat('s1'), []);
  clock.advance(7_500);
  assert.deepEqual(t.forSeat('s1'), [], '8,501 + 3 × 2,500 is not stale yet');
  clock.advance(1);
  assert.deepEqual(lines(t.forSeat('s1')), pairOf('DAEMON_DOWN', {}));
  assert.deepEqual(lines(t.forSeat('s2')), pairOf('DAEMON_DOWN', {}));
});

test('transition lines never ride a G1', async () => {
  const ctx = stepCtx();
  ctx.transitions.observe(status({ state: 'frozen', freeze_reasons: ['EPOCH'] }), 0);
  const g1 = draft({ code: 'EDIT_FROZEN', params: {}, form: 'T1' } as never);
  await transitionDeliverStep(hookOf(), g1, ctx);
  assert.deepEqual(g1.items, [], 'a deny draft gets no transition item');
  assert.deepEqual(ctx.events.pending(SEAT), [], 'and no store row');
  const d = draft();                                              // the next exit-0 hook: Transitions did not advance on the G1
  await transitionDeliverStep(hookOf(), d, ctx);
  assert.deepEqual(codes(ctx.events.pending(SEAT)), ['FROZEN', 'FROZEN'], 'the next exit-0 reply carries it once');
  await transitionDeliverStep(hookOf(), draft(), ctx);
  assert.equal(ctx.events.pending(SEAT).length, 2);
});

test('no other engine event is routed by Plan 5', () => {
  for (const code of ['LOST_STATE', 'PHANTOM', 'DEFERRED', 'SAVE_REPORT']) {
    assert.deepEqual(transitionItems(baseline, status({ message_code: code, message_params: { n: 1 } })), [], `${code} on ok → ok`);
    assert.deepEqual(transitionItems({ ...baseline, state: 'degraded' }, status({ state: 'degraded', message_code: code, message_params: { n: 1 } })), [], `${code} on degraded → degraded`);
  }
  const t = new Transitions(() => 0);
  t.observe(status({}), 0);
  assert.deepEqual(t.forSeat('s1'), []);
  t.observe(status({ message_code: 'LOST_STATE', message_params: { n: 1 } }), 0);
  assert.deepEqual(t.forSeat('s1'), []);
  t.observe(status({ state: 'degraded', message_code: 'PHANTOM', message_params: { n: 1 } }), 0);
  assert.deepEqual(lines(t.forSeat('s1')), pairOf('PHANTOM', { n: 1 }), 'a state change announces the code');
  t.observe(status({ state: 'degraded', message_code: 'SAVE_REPORT', message_params: { n: 2 } }), 0);
  assert.deepEqual(t.forSeat('s1'), [], 'degraded → degraded with another code renders nothing');
});

// ---- F2 fix round 1 ---------------------------------------------------------------------------------------------------

test("F2 #11 r1: a DAEMON_DOWN row still open when the status is fresh again is retired at the seat's next hook", async () => {
  // DAEMON_DOWN is a fact about the present: while the heartbeat is stale its rows ride until printed, and once a
  // fresh status is current the seat's next hook retires any of them still open, so a recovered daemon never says
  // edits are paused (06-claude.md DAEMON_DOWN).
  const clock = new VirtualClock({ startMono: 0 });
  const ctx = ({ transitions: new Transitions(() => clock.monoMs()), events: new EventStore(clock, seededRandom('f2-r1-down'), new TraceRecorder()) }) as unknown as DaemonCtx;
  const delivered: string[][] = [];
  ctx.events.onDelivered((_s, ids) => delivered.push([...ids]));
  const hook = async (): Promise<void> => {                       // the STEP_ORDER tail: transition.deliver, then event.deliver's nextHook
    await transitionDeliverStep(hookOf(), draft(), ctx);
    ctx.events.nextHook(SEAT);
  };
  ctx.transitions.observe(status({ heartbeat_mono_ms: 1_000, loop_period_ms: 2_500 }), 0);
  await hook();
  assert.deepEqual(ctx.events.pending(SEAT), [], 'fresh at the baseline: nothing');
  clock.advance(9_000);                                           // 9,000 > 1,000 + 3 × 2,500: stale
  await hook();
  const down = ctx.events.pending(SEAT);
  assert.deepEqual(codes(down), ['DAEMON_DOWN', 'DAEMON_DOWN']);
  ctx.events.batch(SEAT, down.map((e) => e.id), 'post');          // the loader gave up: that reply is never printed
  await hook();
  assert.deepEqual(codes(ctx.events.pending(SEAT)), ['DAEMON_DOWN', 'DAEMON_DOWN'], 'still stale: the un-printed line rides again');
  ctx.transitions.observe(status({ heartbeat_mono_ms: 10_000, loop_period_ms: 2_500 }), 0);   // the loop recovered
  await hook();
  assert.deepEqual(ctx.events.pending(SEAT), [], 'a fresh status retires the open DAEMON_DOWN rows');
  assert.deepEqual(delivered, [], 'retired, never delivered');
  // The cap-drop path: a DAEMON_DOWN row left pending (never batched) goes the same way.
  clock.advance(9_000);                                           // 18,000 > 10,000 + 7,500: stale again
  await hook();
  assert.deepEqual(codes(ctx.events.pending(SEAT)), ['DAEMON_DOWN', 'DAEMON_DOWN']);
  ctx.transitions.observe(status({ heartbeat_mono_ms: 18_000, loop_period_ms: 2_500 }), 0);
  await hook();
  assert.deepEqual(ctx.events.pending(SEAT), [], 'the cap-dropped DAEMON_DOWN row is retired too');
  assert.equal(ctx.events.sizes().rows, 0);
});

test('F2 #14 r1: a new OFFLINE episode that starts while the seat makes no hook still gets its 10-minute repeat', () => {
  const t = new Transitions(() => 0);
  const off = (s: number): StatusJson => status({ state: 'offline', publish_pause: 'OFFLINE', message_params: { offline_for_s: s, label: 'OFFLINE' } });
  t.observe(status({}), 0);
  assert.deepEqual(t.forSeat('s1'), []);
  t.observe(off(650), 0);
  assert.deepEqual(lines(t.forSeat('s1')), pairOf('OFFLINE', { offline_for_s: 650, label: 'OFFLINE' }), 'a first exposure at ≥ 600 s counts as the repeat');
  t.observe(status({}), 0);                                       // the episode ends; s1 makes no hook
  t.observe(off(30), 0);                                          // a new episode: offline_for_s starts again
  assert.deepEqual(t.forSeat('s1'), [], 'OFFLINE → OFFLINE: the net diff since s1 last saw it is empty');
  t.observe(off(700), 0);
  assert.deepEqual(lines(t.forSeat('s1')), pairOf('OFFLINE', { offline_for_s: 700, label: 'OFFLINE', repeat: 'true' }), 'the new episode repeats at 10 min');
  t.observe(off(900), 0);
  assert.deepEqual(t.forSeat('s1'), [], 'once per episode');
});

test('F2 #57 r1: Transitions.dropSeat forgets the seat, so a re-seen seat id starts from the baseline', () => {
  const clock = new VirtualClock({ startMono: 0 });
  const t = new Transitions(() => clock.monoMs());
  t.observe(status({ state: 'frozen', freeze_reasons: ['EPOCH'], heartbeat_mono_ms: 0, loop_period_ms: 1_000 }), 0);
  assert.deepEqual(lines(t.forSeat('s1')), pairOf('FROZEN', { reason: 'EPOCH' }));
  assert.deepEqual(t.forSeat('s1'), []);
  clock.advance(3_001);
  assert.deepEqual(lines(t.forSeat('s1')), pairOf('DAEMON_DOWN', {}));
  assert.deepEqual(t.forSeat('s1'), []);
  t.dropSeat('s1');
  assert.deepEqual(lines(t.forSeat('s1')), [...pairOf('FROZEN', { reason: 'EPOCH' }), ...pairOf('DAEMON_DOWN', {})], 'from the baseline, with a fresh staleness mark');
  assert.deepEqual(t.forSeat('s1'), []);
});

test('plan 2886, the finishReply leg: a G1 answered while a FROZEN transition row is pending carries no FROZEN', async () => {
  const clock = new VirtualClock({ startMono: 0 });
  const events = new EventStore(clock, seededRandom('f2-r1-g1'), new TraceRecorder());
  const ctx = {
    trace: new TraceRecorder(), engine: { peer: () => 'peer-1', teamLanguage: () => null },
    bindings: { slotExtra: null, digest: codeOnlyDigest, dueRequests: noDueRequests }, prefs: () => ({ language: null }),
    events, meter: new BudgetMeter(clock, () => undefined), transitions: new Transitions(() => 0),
  } as unknown as DaemonCtx;
  ctx.transitions.observe(status({ state: 'frozen', freeze_reasons: ['EPOCH'] }), 0);
  await transitionDeliverStep(hookOf(), draft(), ctx);            // an earlier exit-0 hook stored the FROZEN pair
  const frozenIds = ctx.events.pending(SEAT).map((e) => e.id);
  assert.equal(frozenIds.length, 2, 'the FROZEN pair is pending');
  const r = {
    frame: { t: 'hook', event: 'PreToolUse', h: {}, payload: { event: 'PreToolUse', tool_name: 'Edit', tool_use_id: 't1' } },
    seat: { seatId: SEAT, ended: false }, startedMono: 0, extend: () => false, turn: null, trigger: null,
  } as unknown as HookRequest;
  const d = { carrier: 'pre_deny', items: [], deny: { code: 'HELDREG', params: { reason: 'x' }, form: 'T1' }, block: null, done: false } as unknown as ReplyDraft;
  await transitionDeliverStep(r, d, ctx);
  const reply = finishReply(r, d, ctx);
  assert.ok(!reply.text.includes('FROZEN') && !(reply.system ?? '').includes('FROZEN'), `the deny text has no FROZEN: ${JSON.stringify(reply)}`);
  assert.ok(!reply.events.some((id) => frozenIds.includes(id)), 'no transition row rides the G1');
  assert.deepEqual(ctx.events.pending(SEAT).map((e) => e.id), frozenIds, 'the pair stays pending for the next exit-0 reply');
});
