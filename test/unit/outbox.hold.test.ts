// The outbox's hold drafts (Plan 3 Task 4; HLD-10, PRO-06, PRO-09; R3-25): one pending op per record (replaceHold,
// pendingHold, allocatedHold) and PRO-06's withholding of record-creating drafts in take and pendingAllowed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOpId } from '../../src/board/ids.js';
import { isHoldCreation, OPS_MAX_BYTES, OPS_MAX_LINES, type HoldOp, type Op, type OpDraft } from '../../src/board/ops.js';
import { Outbox, type SeqAllocator } from '../../src/board/outbox.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const PEER = '0123456789abcdef0123456789abcdef';
const EPOCH = 'fedcba9876543210fedcba9876543210';
const SELF = { peer: PEER, epoch: EPOCH };
const ROOM = { maxOps: OPS_MAX_LINES, maxBytes: OPS_MAX_BYTES };
const X = '01J9ZQ3C5X00000000000000XX';
const Y = '01J9ZQ3C5X00000000000000YY';

class Counter implements SeqAllocator {
  constructor(public n: number) {}
  next(): number {
    return this.n++;
  }
}

/** A hold draft of record `id` at `rev` chained on `prev`. */
function hold(id: string, rev: number, prev: number | null, state: HoldOp['state'] = 'ACTIVE'): Omit<HoldOp, 'id'> {
  return {
    type: 'hold', hold_id: id, rev, prev_rev: prev, kind: 'PATCH', residence: state === 'ACTIVE' ? 'ON_DISK' : null, state, offer: 'none',
    guards: [{ name: 'revert', class: 'DECISION', owner: 'HLD' }], paths: ['src/a.txt'], origin: 'human', cs_ids: [], peer_authors: [], local_only: false,
  };
}
const event = (): OpDraft => ({ type: 'event', cid: '', kind: 'freeze', refs: [], reason_code: 'FREEZE_EPOCH' });
const seqOf = (op: Op): number => (parseOpId(op.id) as { seq: number }).seq;
const holdIds = (ops: readonly Op[]): Array<[string, number]> => ops.filter((o): o is HoldOp => o.type === 'hold').map((o) => [o.hold_id, o.rev]);

test('replaceHold keeps one pending op per record', T10, () => {
  const box = new Outbox();
  box.replaceHold(hold(X, 1, null));
  box.replaceHold(hold(X, 2, null));
  assert.equal(box.size, 1, 'one entry for X before any seq');
  assert.deepEqual(box.pendingHold(X), hold(X, 2, null), 'the newer draft');
  assert.equal(box.allocatedHold(X), null);
  // Another record's draft is its own entry.
  box.replaceHold(hold(Y, 1, null));
  assert.equal(box.size, 2);
  // After take allocates a seq to X's op, a third replaceHold appends a new entry, and pendingHold returns the newest one.
  const taken = box.take([], SELF, new Counter(10), ROOM);
  assert.deepEqual(holdIds(taken), [[X, 2], [Y, 1]]);
  assert.deepEqual(box.allocatedHold(X)?.rev, 2);
  box.replaceHold(hold(X, 3, 2));
  assert.equal(box.size, 3, 'the allocated op is kept; the new draft is appended');
  assert.deepEqual(box.pendingHold(X), hold(X, 3, 2));
  assert.equal(box.allocatedHold(X)?.rev, 2, 'the newest allocated op is still the sent one');
  // A fourth replaceHold replaces the unallocated third, never the allocated op.
  box.replaceHold(hold(X, 4, 2));
  assert.equal(box.size, 3);
  assert.deepEqual(box.pendingHold(X), hold(X, 4, 2));
  // The next take places both of X's ops in seq order (the allocated one first).
  const again = box.take([], SELF, new Counter(20), ROOM);
  assert.deepEqual(holdIds(again), [[X, 2], [Y, 1], [X, 4]]);
  assert.ok(again.every((op, i) => i === 0 || seqOf(again[i - 1]!) < seqOf(op)));
  assert.equal(box.pendingHold('01J9ZQ3C5X00000000000000ZZ'), null);
  // A draft that cannot form a valid op line is refused like add() refuses it.
  assert.throws(() => box.replaceHold({ ...hold(X, 5, 2), paths: ['a:b.txt'] }), TypeError);
  assert.deepEqual(box.pendingHold(X), hold(X, 4, 2), 'nothing changed');
});

test('take withholds the drafts withhold names and pendingAllowed ignores them', T10, () => {
  const box = new Outbox();
  box.replaceHold(hold(X, 1, null));          // a creation (PRO-06: record-creating)
  box.replaceHold(hold(Y, 3, 2));             // an update queued after it
  box.add(event());
  box.replaceHold(hold('01J9ZQ3C5X00000000000000ZZ', 2, 1, 'SUBSUMED'));   // an ending op
  const withhold = (d: OpDraft): boolean => isHoldCreation(d);
  const taken = box.take([], SELF, new Counter(1), { ...ROOM, withhold });
  assert.deepEqual(taken.map((o) => (o.type === 'hold' ? o.hold_id : o.type)), [Y, 'event', '01J9ZQ3C5X00000000000000ZZ'], 'the update, the event and the ending op');
  assert.deepEqual(taken.map(seqOf), [1, 2, 3], 'seq order kept for the placed ones');
  assert.equal(box.allocatedHold(X), null, 'the withheld creation stays unallocated');
  assert.deepEqual(box.pendingHold(X), hold(X, 1, null));
  // The placed ops are still pending (unlanded): pendingAllowed counts them; with only the withheld creation left it is false.
  assert.equal(box.pendingAllowed([], withhold), true);
  const fresh = new Outbox();
  fresh.replaceHold(hold(X, 1, null));
  assert.equal(fresh.pendingAllowed([], withhold), false);
  assert.equal(fresh.pendingAllowed(['frozen'], withhold), false);
  assert.equal(fresh.pendingAllowed(['frozen']), true, 'hold mirrors ride FREEZE');
  assert.deepEqual(fresh.take([], SELF, new Counter(1), { ...ROOM, withhold }), []);
  // Once the cap is relieved, the creation is taken (seq above every other).
  assert.deepEqual(holdIds(box.take([], SELF, new Counter(4), ROOM)).map(([id]) => id), [Y, '01J9ZQ3C5X00000000000000ZZ', X]);
});
