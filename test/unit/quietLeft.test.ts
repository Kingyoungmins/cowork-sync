// ChangeSets.quietLeftMs() (Plan 3 Task 18; rev 2.5, F14; FEAT-F14-04 — O8's estimate input; 05-holds HLD-35, HLD-36): the Δmono until
// the open human CS (or the open recovered CS) reaches its 20 s quiet close, 0 once due (a /cowork done included), null with neither
// open. A pure read: it changes no CS. A ChangeSets on a VirtualClock with scripted observations and signals; no git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChangeSets, HUMAN_CS_QUIET_MS, type CsTable } from '../../src/holds/changesets.js';
import { VirtualClock } from '../sim/vclock.js';

const PEER = '0123456789abcdef0123456789abcdef';
const SEAT = 'a'.repeat(32);
const EMPTY_TABLE: CsTable = { v: 1, next_order: 1, seats: {}, cs: [], orders: {}, passing: {} };

test('quietLeftMs is 20,000 minus the Δmono since the human CS\'s last observed delta, 0 once due, null with no open human or recovered CS, and 0 after done()', () => {
  assert.equal(HUMAN_CS_QUIET_MS, 20_000);
  const clock = new VirtualClock({ startMono: 1_000 });
  const cs = new ChangeSets(PEER, clock);
  assert.equal(cs.quietLeftMs(), null, 'no CS at all');
  // A seat CS is no human or recovered CS.
  cs.signal({ kind: 'effect', seat: SEAT, agent: null, toolUseId: 'toolu_1', paths: ['seat.py'], turnOrigin: 'prompt' });
  cs.observe([]);
  assert.equal(cs.quietLeftMs(), null, 'an open seat CS only');

  cs.observe(['a.txt']);
  assert.equal(cs.quietLeftMs(), 20_000, 'the human CS opened now');
  clock.advance(7_000);
  assert.equal(cs.quietLeftMs(), 13_000);
  const table = JSON.stringify(cs.table());
  for (let i = 0; i < 100; i++) assert.equal(cs.quietLeftMs(), 13_000);
  assert.equal(JSON.stringify(cs.table()), table, 'a pure read');
  assert.equal(cs.closeDue(), false);
  assert.equal(cs.quietLeftMs(), 13_000, 'closeDue() moved nothing quietLeftMs reads');
  cs.observe(['b.txt']);                  // a new delta on the human CS restarts its quiet period
  assert.equal(cs.quietLeftMs(), 20_000);
  clock.advance(19_999);
  assert.equal(cs.quietLeftMs(), 1);
  clock.advance(1);
  assert.equal(cs.quietLeftMs(), 0, 'due');
  assert.equal(cs.closeDue(), true, 'the same instant closeDue reports the close');
  clock.advance(60_000);
  assert.equal(cs.quietLeftMs(), 0, 'never negative');

  // done(): due at once.
  const cs2 = new ChangeSets(PEER, clock);
  cs2.observe(['c.txt']);
  clock.advance(3_000);
  assert.equal(cs2.quietLeftMs(), 17_000);
  cs2.done();
  assert.equal(cs2.quietLeftMs(), 0, 'after /cowork done');

  // The recovered CS (HLD-36): 20 s of quiet counted only while no seat is busy; 0 once every busy seat has stopped.
  const cs3 = new ChangeSets(PEER, clock);
  cs3.restore([], 1, EMPTY_TABLE, null);   // a journaled table and no cache: one recovered CS
  assert.equal(cs3.quietLeftMs(), null, 'an empty recovered CS is not counted as open');
  cs3.observe(['d.txt']);
  assert.equal(cs3.quietLeftMs(), 20_000);
  clock.advance(5_000);
  assert.equal(cs3.quietLeftMs(), 15_000);
  cs3.signal({ kind: 'activity', seat: SEAT, activity: 'MID_TURN' });
  clock.advance(30_000);
  assert.equal(cs3.quietLeftMs(), 15_000, 'the quiet does not count while a seat is MID_TURN');
  // A pure read while the seat is busy: 100 calls change neither its answer, nor closeDue's, nor the table.
  const busyTable = JSON.stringify(cs3.table());
  const dueBefore = cs3.closeDue();
  assert.equal(dueBefore, false, 'not due while the seat is busy');
  for (let i = 0; i < 100; i++) assert.equal(cs3.quietLeftMs(), 15_000);
  assert.equal(cs3.closeDue(), dueBefore);
  assert.equal(JSON.stringify(cs3.table()), busyTable);
  clock.advance(1_000);
  assert.equal(cs3.quietLeftMs(), 15_000, 'still frozen: the calls started no quiet count');
  cs3.signal({ kind: 'stop', seat: SEAT });
  assert.equal(cs3.quietLeftMs(), 0, 'the busy seat\'s stop releases it');
});
