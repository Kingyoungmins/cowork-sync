// test/unit/claude.meter.test.ts — the seat-hour budget meter (CCI-46, CCI-61, R5-43): the touch anchor, the lazy
// window rollover (counters reset, PULL_MODE cleared once), the trip rules (injected, reminder count and chars),
// the saturated claim_ahead share that never trips, the shown-but-never-counted slash, and the Δmono readings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BudgetMeter } from '../../src/claude/daemon/meter.js';
import { C } from '../../src/claude/wire/constants.js';
import { VirtualClock } from '../sim/vclock.js';

const make = () => {
  const clock = new VirtualClock({ startMono: 0 });
  const pulls: Array<[string, boolean]> = [];
  const meter = new BudgetMeter(clock, (seatId, on) => pulls.push([seatId, on]));
  return { clock, meter, pulls };
};

test('touch anchors the seat-hour window once; later touches never re-anchor a live window', () => {
  const { clock, meter } = make();
  meter.touch('s1');
  assert.equal(meter.usage('s1').windowLeftMs, C.SEAT_HOUR_MS);
  clock.advance(1000);
  meter.touch('s1');
  assert.equal(meter.usage('s1').windowLeftMs, C.SEAT_HOUR_MS - 1000);   // the first anchor stands
  meter.touch('s2');
  assert.equal(meter.usage('s2').windowLeftMs, C.SEAT_HOUR_MS);          // one window per seat
});

test('injected charges count into the window; crossing the seat-hour cap trips PULL_MODE once', () => {
  const { clock, meter, pulls } = make();
  meter.touch('s1');                                                     // the anchor (event.deliver calls it)
  meter.charge('s1', 'inject', C.INJECTED_CHARS_PER_SEAT_HOUR - 1);
  assert.equal(meter.usage('s1').injected, C.INJECTED_CHARS_PER_SEAT_HOUR - 1);
  assert.equal(meter.inPullMode('s1'), false);
  meter.charge('s1', 'inject', 10);                                      // strictly over the cap trips
  assert.equal(meter.inPullMode('s1'), true);
  assert.deepEqual(pulls, [['s1', true]]);
  meter.charge('s1', 'inject', 10);                                      // no second callback while already tripped
  assert.deepEqual(pulls, [['s1', true]]);
  assert.equal(meter.pullModeLeftMs('s1'), C.SEAT_HOUR_MS);
  clock.advance(1000);
  assert.equal(meter.pullModeLeftMs('s1'), C.SEAT_HOUR_MS - 1000);
  assert.equal(meter.pullModeLeftMs('s2'), 0);                           // not in PULL_MODE: 0
});

test('the lazy rollover resets the counters, clears PULL_MODE once and re-anchors at the boundary crossing', () => {
  const { clock, meter, pulls } = make();
  meter.touch('s1');
  meter.charge('s1', 'inject', C.INJECTED_CHARS_PER_SEAT_HOUR + 1);      // trip
  assert.deepEqual(pulls, [['s1', true]]);
  clock.advance(C.SEAT_HOUR_MS + 5);
  const u = meter.usage('s1');                                           // the first meter call past the boundary
  assert.equal(u.injected, 0);
  assert.equal(u.pullMode, false);
  assert.equal(u.windowLeftMs, C.SEAT_HOUR_MS);                          // re-anchored at now
  assert.deepEqual(pulls, [['s1', true], ['s1', false]]);                // the clear fired exactly once
  clock.advance(C.SEAT_HOUR_MS + 5);
  meter.usage('s1');                                                     // another clean boundary clears nothing
  assert.deepEqual(pulls, [['s1', true], ['s1', false]]);
});

test('reminder estimates count one per applied path and trip by count or by chars (R2-D5)', () => {
  const { meter } = make();
  meter.touch('s1');
  for (let i = 0; i <= C.REMINDERS_PER_SEAT_HOUR; i++) meter.reminder('s1', 10);   // the (cap+1)-th trip
  assert.equal(meter.inPullMode('s1'), true);
  assert.equal(meter.usage('s1').reminders, C.REMINDERS_PER_SEAT_HOUR + 1);
  meter.touch('s2');
  meter.reminder('s2', C.REMINDER_CHARS_PER_SEAT_HOUR + 1);              // one over-sized estimate trips at once
  assert.equal(meter.inPullMode('s2'), true);
  assert.equal(meter.usage('s2').reminders, 1);
  assert.equal(meter.usage('s2').reminderChars, C.REMINDER_CHARS_PER_SEAT_HOUR + 1);
});

test('claim_ahead saturates at its share, counts into injected and never trips PULL_MODE (CCI-61)', () => {
  const { meter, pulls } = make();
  meter.touch('s1');
  assert.equal(meter.shareLeft('s1', 'claim_ahead'), C.CLAIM_AHEAD_SHARE_CHARS);
  meter.charge('s1', 'claim_ahead', C.CLAIM_AHEAD_SHARE_CHARS + 5000);
  assert.equal(meter.shareLeft('s1', 'claim_ahead'), 0);
  const u = meter.usage('s1');
  assert.equal(u.claimAhead, C.CLAIM_AHEAD_SHARE_CHARS);
  assert.equal(u.injected, C.CLAIM_AHEAD_SHARE_CHARS);                   // the saturated share, nothing more
  assert.equal(u.pullMode, false);
  assert.deepEqual(pulls, []);
});

test('slash is shown, never counted; doorbells count once per post; cacheCold is the neutral false', () => {
  const { meter } = make();
  meter.touch('s1');
  meter.charge('s1', 'slash', 500);
  meter.charge('s1', 'doorbell', 30);
  meter.charge('s1', 'system', 20);
  const u = meter.usage('s1');
  assert.equal(u.slashShown, 500);
  assert.equal(u.doorbells, 1);
  assert.equal(u.injected, 50);                                          // the slash chars never counted
  assert.equal(meter.cacheCold('s1'), false);
  meter.charge('s1', 'doorbell', 900);                                   // plan:2895: doorbell text is counted in full
  assert.equal(meter.usage('s1').injected, 50 + 900);
  assert.equal(meter.usage('s1').doorbells, 2);
});
