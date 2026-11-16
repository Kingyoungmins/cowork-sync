// test/unit/claude.attribution.test.ts — the attribution windows and the AttributionPort binding (06 §3.8.3, CCI-24,
// CCI-27, HLD-26, HLD-35, R5-27…R5-29, A8-6): the one rule set (INFLIGHT call, TXN window, 3 s formatter grace, else
// human-class), the R5-28 answers, the R5-27 path-level expiry taint, the R5-29 late-write seat tags, editedSince,
// and the A12-4 closed-TXN records (unit with VirtualClock).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AttributionWindows, hookAttribution } from '../../src/claude/daemon/attribution.js';
import { LeaseTable, type InflightLease, type Txn } from '../../src/claude/daemon/leases.js';
import { C } from '../../src/claude/wire/constants.js';
import { VirtualClock } from '../sim/vclock.js';
import type { DiskSnapshots } from '../../src/claude/daemon/hookRead.js';
import type { AppliedPath } from '../../src/engine/deps.js';
import type { Oid } from '../../src/git/oid.js';

const S = 's'.repeat(32);
const T = 't'.repeat(32);

const infl = (toolUseId: string, over: Partial<Omit<InflightLease, 'kind' | 'acquiredMono' | 'toolUseId'>> = {}): Omit<InflightLease, 'kind' | 'acquiredMono'> =>
  ({ toolUseId, seatId: S, agentId: null, sessionId: 's1', path: 'a.ts', foldHeight: 0, pre: null, approximate: false, synthetic: false, preHeld: null, view: null, tentative: null, ...over });
const openTxnOf = (toolUseId: string, seatId: string, over: Partial<Omit<Txn, 'kind' | 'openMono' | 'toolUseId'>> = {}): Omit<Txn, 'kind' | 'openMono'> =>
  ({ toolUseId, seatId, agentId: null, sessionId: 's1', tool: 'Bash', foldHeight: 0, sOpen: {}, approximate: false, background: false, csId: null, view: null, ...over });

const make = () => {
  const clock = new VirtualClock({ startMono: 0 });
  const leases = new LeaseTable(clock, { emit: () => undefined }, {} as unknown as DiskSnapshots);
  const windows = new AttributionWindows(clock, leases);
  return { clock, leases, windows };
};

test('one rule set: INFLIGHT call, TXN window, 3 s formatter grace, else human-class (CCI-27, 06 §3.8.3)', () => {
  const { clock, leases, windows } = make();
  leases.acquireInflight(infl('tu1'));
  const a = windows.attribute('a.ts');
  assert.deepEqual(
    a?.map((x) => ({ seatId: x.seatId, toolUseId: x.toolUseId, via: x.via, csId: x.csId })),
    [{ seatId: S, toolUseId: 'tu1', via: 'inflight', csId: null }],
  );
  // Two open TXNs of two seats overlap every path: both entries.
  leases.openTxn(openTxnOf('tu2', S));
  leases.openTxn(openTxnOf('tu3', T));
  const both = windows.attribute('a.ts');
  assert.deepEqual(both?.map((x) => [x.seatId, x.via]).sort(), [[S, 'inflight'], [S, 'txn'], [T, 'txn']].sort());
  leases.release('tu2', 'post');
  leases.release('tu3', 'post');
  leases.release('tu1', 'post');
  assert.equal(windows.attribute('a.ts'), null);
  // The 3 s formatter grace: at t + 2,999 via grace, at t + 3,001 human-class.
  windows.onEditPost(S, 'a.ts');
  clock.advance(2_999);
  assert.deepEqual(windows.attribute('a.ts')?.map((x) => x.via), ['grace']);
  clock.advance(2);
  assert.equal(windows.attribute('a.ts'), null);
});

test('hookAttribution answers per R5-28', () => {
  const { clock, leases, windows } = make();
  const port = hookAttribution(windows);
  leases.acquireInflight(infl('tu1'));
  assert.equal(port.removalAttributed('a.ts'), true);
  assert.equal(port.shrinkAttributed('a.ts'), true, 'R-25 kept');
  assert.equal(port.observedEdit('a.ts'), true, 'an INFLIGHT window is an edit-class window');
  assert.equal(port.hookAttributed('a.ts'), true);
  leases.release('tu1', 'post');
  leases.openTxn(openTxnOf('tx1', S));
  assert.equal(port.removalAttributed('a.ts'), true);
  assert.equal(port.observedEdit('a.ts'), false, 'a TXN window is a shell one: not an observed edit');
  assert.equal(port.hookAttributed('a.ts'), true);
  leases.release('tx1', 'post');
  windows.onEditPost(S, 'a.ts');
  assert.equal(port.observedEdit('a.ts'), true, 'the grace is an edit-class window');
  clock.advance(C.FORMATTER_GRACE_MS + 1);
  assert.equal(port.removalAttributed('a.ts'), false);
  assert.equal(port.observedEdit('a.ts'), false);
  assert.equal(port.hookAttributed('a.ts'), false);
  assert.equal(port.shrinkAttributed('a.ts'), true, 'outside every window only shrinkAttributed stays true');
  // No member takes a blob argument (the binding's arity is 1).
  assert.equal(port.removalAttributed.length, 1);
  assert.equal(port.observedEdit.length, 1);
  assert.equal(port.hookAttributed.length, 1);
  assert.equal(port.shrinkAttributed.length, 1);
});

test('a TXN keeps the pre-window attribution of its pre-dirty paths (CCI-22, 06 §3.7.3)', () => {
  const { leases, windows } = make();
  leases.openTxn(openTxnOf('tx1', S, { preDirty: new Set(['x.ts']) }));
  assert.equal(windows.attribute('x.ts'), null, 'x.ts was dirty against S_open: no TXN row (its pre-window attribution stands)');
  assert.deepEqual(windows.attribute('y.ts')?.map((a) => [a.toolUseId, a.via]), [['tx1', 'txn']], 'a clean path is in the window');
  leases.acquireInflight(infl('tu1', { path: 'x.ts' }));
  assert.deepEqual(windows.attribute('x.ts')?.map((a) => a.via), ['inflight'], 'the other rows still apply to a pre-dirty path');
});

test('the R5-27 expiry taint is path-level until the seat next edit Post on the path (CCI-24, INV-CCI-EXPIRY-TAINT)', () => {
  const { clock, leases, windows } = make();
  const port = hookAttribution(windows);
  const l = leases.acquireInflight(infl('tu1', { path: 'f.ts' }));
  clock.advance(60_000);                                   // the writer wrote f.ts at 60,000
  clock.advance(C.INFLIGHT_BACKSTOP_MS - 60_000);          // the lease expires at 120,000
  leases.expire();
  windows.onExpiry(l, true);                               // writerWroteAfterAcquire true
  assert.equal(port.observedEdit('f.ts'), false, 'tainted: no window answers an observed edit either');
  windows.onEditPost(S, 'f.ts');                           // the seat's next edit-class Post on the path
  assert.equal(port.observedEdit('f.ts'), true, 'the Post cleared the taint and opened the grace');
  clock.advance(C.FORMATTER_GRACE_MS + 1);
  assert.equal(port.observedEdit('f.ts'), false);
  assert.equal(windows.tainted('f.ts'), false, 'the taint is gone (the grace GC is lazy; the taint set is not)');
  // An expiry with no writer write after acquisition sets no taint.
  const l2 = leases.acquireInflight(infl('tu2', { path: 'f.ts' }));
  clock.advance(C.INFLIGHT_BACKSTOP_MS);
  leases.expire();
  windows.onExpiry(l2, false);
  windows.onEditPost(S, 'f.ts');
  clock.advance(C.FORMATTER_GRACE_MS + 1);
  assert.equal(windows.tainted('f.ts'), false);
});

const applied = (path: string): AppliedPath[] => [{ path, from: 'a'.repeat(40) as Oid, to: 'b'.repeat(40) as Oid, writer: 'P2' }];

test("R5-27: an expiry before the writer's write keeps a candidate; the write after the expiry taints the path until the seat's next confirmed edit Post (06 test 19 order)", () => {
  const { clock, leases, windows } = make();
  const port = hookAttribution(windows);
  leases.acquireInflight(infl('tu1', { path: 'f.ts' }));          // Claude's Write of f.ts admitted at 0; its Post never lands
  clock.advance(C.INFLIGHT_BACKSTOP_MS);                          // the backstop at 120,000
  const [l] = leases.expire().expired;
  assert.ok(l !== undefined);
  assert.equal(windows.writerWroteAfter('f.ts', l.acquiredMono), false, 'the fence held the teammate change back: no write yet');
  windows.onExpiry(l, false);
  assert.equal(windows.tainted('f.ts'), false, 'no taint before a writer write');
  clock.advance(10_000);
  windows.onWriterApplied(applied('f.ts'));                        // B's change applies after the expiry (130,000)
  assert.equal(windows.tainted('f.ts'), true, 'the write after the expiry taints the path');
  assert.equal(port.observedEdit('f.ts'), false);
  leases.acquireInflight(infl('tu2', { path: 'f.ts' }));          // another tool of S on the same path
  assert.equal(port.observedEdit('f.ts'), false, 'stricter than that call: every later delta on the path');
  windows.onEditPost(S, 'f.ts', 'tu1');                           // the stale call's own late Post
  assert.equal(windows.tainted('f.ts'), true, "the stale call's own Post never clears it");
  windows.onEditPost(T, 'f.ts', 'tx');                            // another seat's edit Post
  assert.equal(windows.tainted('f.ts'), true, "another seat's Post never clears it");
  assert.equal(port.observedEdit('f.ts'), false);
  windows.onEditPost(S, 'f.ts', 'tu2');                           // the seat's next confirmed edit-class Post on it
  assert.equal(windows.tainted('f.ts'), false);
  assert.equal(port.observedEdit('f.ts'), true, 'tu2 and its grace answer an observed edit again');
});

test('R5-27: an expiry with no writer write sets no taint; the candidate ends at the seat boundary or its next edit Post', () => {
  const { clock, leases, windows } = make();
  leases.acquireInflight(infl('tu1', { path: 'f.ts' }));
  clock.advance(C.INFLIGHT_BACKSTOP_MS);
  const [l] = leases.expire().expired;
  windows.onExpiry(l!, false);
  windows.onSeatBoundary(S);                                      // the seat's Stop/StopFailure or its seat end
  windows.onWriterApplied(applied('f.ts'));
  assert.equal(windows.tainted('f.ts'), false, 'the boundary ended the candidate');

  const b = make();
  b.leases.acquireInflight(infl('tu1', { path: 'f.ts' }));
  b.clock.advance(C.INFLIGHT_BACKSTOP_MS);
  const [l2] = b.leases.expire().expired;
  b.windows.onExpiry(l2!, false);
  b.windows.onEditPost(S, 'f.ts', 'tuX');                         // the seat's next edit Post on the path
  b.windows.onWriterApplied(applied('f.ts'));
  assert.equal(b.windows.tainted('f.ts'), false, 'the edit Post ended the candidate');
});

test('R5-27: a writer write seen while the lease lived taints at the expiry; a write before the acquisition does not', () => {
  const { clock, leases, windows } = make();
  leases.acquireInflight(infl('tu1', { path: 'f.ts' }));          // acquired at 0
  clock.advance(60_000);
  windows.onWriterApplied(applied('f.ts'));                        // the writer wrote f.ts at 60,000
  clock.advance(C.INFLIGHT_BACKSTOP_MS - 60_000);
  const [l] = leases.expire().expired;
  assert.equal(windows.writerWroteAfter('f.ts', l!.acquiredMono), true);
  windows.onExpiry(l!, true);
  assert.equal(windows.tainted('f.ts'), true);

  const b = make();
  b.windows.onWriterApplied(applied('g.ts'));                      // a write at 0
  b.clock.advance(1_000);
  const l2 = b.leases.acquireInflight(infl('tu2', { path: 'g.ts' }));   // acquired at 1,000
  assert.equal(b.windows.writerWroteAfter('g.ts', l2.acquiredMono), false, 'a write before the acquisition does not count');
  assert.equal(b.windows.writerWroteAfter('g.ts', 0), true, 'a write in the acquisition millisecond counts (>=, Ruling t8a-2)');
});

test('late writes are human-class with a display-only seat tag until the seat next Stop or seat end (R5-29, HLD-35)', () => {
  const { clock, leases, windows } = make();
  leases.openTxn(openTxnOf('tx1', S));
  const t1 = leases.txn('tx1')!;
  leases.release('tx1', 'cap');                            // the cap closes it (why cap)
  windows.onTxnClose(t1, 'cap');                           // the composition wires the same call over onTxnClosed
  assert.equal(windows.attribute('g.ts'), null);
  assert.equal(windows.seatTag('g.ts'), S);
  leases.openTxn(openTxnOf('tx2', S, { background: true }));
  const t2 = leases.txn('tx2')!;
  leases.release('tx2', 'background_return');
  windows.onTxnClose(t2, 'background_return');
  clock.advance(1_000);
  assert.equal(windows.seatTag('g.ts'), S, 'the newest live late window names the seat');
  windows.onSeatBoundary(S);                               // the seat's Stop/StopFailure or its seat end
  assert.equal(windows.seatTag('g.ts'), null);
  // A delta with no window at all has no tag.
  const other = make();
  assert.equal(other.windows.seatTag('h.ts'), null);
});

test('editedSince lists the seat attributed paths of the window (A8-6)', () => {
  const { clock, windows } = make();
  windows.onEditPost(S, 'a.ts');
  windows.attribute('a.ts');                               // attributed at 0
  clock.advance(600_000);
  windows.onEditPost(S, 'b.ts');
  windows.attribute('b.ts');                               // attributed at 600,000
  clock.advance(1_100_000);
  windows.onEditPost(S, 'c.ts');
  windows.attribute('c.ts');                               // attributed at 1,700,000
  clock.advance(300_000);                                  // now 2,000,000
  assert.deepEqual([...windows.editedSince(S, 2_000_000 - 1_800_000)].sort(), ['b.ts', 'c.ts']);
  assert.deepEqual([...windows.editedSince(T, 0)], []);
});

test('A12-4: a closed TXN keeps answering removal/hook attribution for the paths closeTxn attributed', () => {
  const { clock, leases, windows } = make();
  leases.openTxn(openTxnOf('tx1', S));
  const t = leases.txn('tx1')!;
  leases.release('tx1', 'post');
  windows.attributeClosed(t, ['k.ts'], clock.monoMs() + 2_000);
  const port = hookAttribution(windows);
  assert.equal(port.removalAttributed('k.ts'), true, 'the closed record answers removalAttributed and is consumed by it');
  assert.equal(port.removalAttributed('k.ts'), false, 'consumed');
  windows.attributeClosed(t, ['m.ts'], clock.monoMs() + 2_000);
  assert.equal(port.hookAttributed('m.ts'), true, 'hookAttributed reads a valid closed record non-consumingly');
  assert.equal(port.hookAttributed('m.ts'), true);
  clock.advance(2_001);
  assert.equal(port.hookAttributed('m.ts'), false, 'untilMono passed');
});

test('bashEditDiff is never an input of the attribution modules (CCI-27)', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const f of ['attribution.ts', 'leases.ts', 'defer.ts']) {
    const text = await readFile(`src/claude/daemon/${f}`, 'utf8');
    assert.ok(!text.includes('bashEditDiff'), `${f} never names bashEditDiff`);
    assert.ok(!text.includes('tool_response'), `${f} never reads tool_response`);
  }
});

/** One seat's life for the bounded-state cells: an attributed edit, a capped TXN with a never-consumed closed record, an
 *  expired lease, the seat end, then 60 s of quiet (180 s of clock per seat). */
function seatLife(r: ReturnType<typeof make>, i: number): void {
  const { clock, leases, windows } = r;
  const id = `seat${String(i).padStart(4, '0')}`.padEnd(32, 'x');   // 1,000 distinct seat ids
  const p = `p${i}.ts`;
  leases.acquireInflight(infl(`tu${i}a`, { seatId: id, path: p }));
  assert.ok(windows.attribute(p) !== null);
  leases.release(`tu${i}a`, 'post');
  windows.onEditPost(id, p, `tu${i}a`);
  leases.openTxn(openTxnOf(`tx${i}`, id));
  const t = leases.txn(`tx${i}`)!;
  leases.release(`tx${i}`, 'cap');
  windows.onTxnClose(t, 'cap');
  windows.attributeClosed(t, [p], clock.monoMs() + 2_000);          // never consumed by a tick
  windows.onWriterApplied(applied(p));                              // a writer write before the next lease: no candidate to promote
  leases.acquireInflight(infl(`tu${i}b`, { seatId: id, path: p }));
  clock.advance(C.INFLIGHT_BACKSTOP_MS);
  for (const l of leases.expire().expired) windows.onExpiry(l, false);
  leases.releaseSeat(id, { }, 'seat_end');
  windows.onSeatBoundary(id);
  clock.advance(60_000);
}

test('1,000 seats: lease, attribution and expiry state stays bounded', () => {
  const r = make();
  for (let i = 0; i < 1_000; i++) seatLife(r, i);
  const w = r.windows.stateSizes();
  assert.equal(w.late, 0, 'late-write tags end at the boundary');
  assert.equal(w.candidates, 0, 'expiry candidates end at the boundary');
  assert.equal(w.taints, 0);
  assert.ok(w.closed <= 1, `closed records past untilMono are pruned: ${w.closed}`);
  assert.ok(w.graces <= 1, `spent graces are pruned: ${w.graces}`);
  assert.ok(w.editedSeats <= Math.ceil(1_800_000 / 180_000) + 2, `edited entries older than the 30-min window are pruned: ${w.editedSeats}`);
  assert.ok(w.writes <= 2, `writer writes older than 2 × the backstop are pruned: ${w.writes}`);
  const l = r.leases.stateSizes();
  assert.deepEqual({ inflights: l.inflights, txns: l.txns, expirySeats: l.expirySeats, readSeats: l.readSeats, reads: l.reads }, { inflights: 0, txns: 0, expirySeats: 0, readSeats: 0, reads: 0 });
});
