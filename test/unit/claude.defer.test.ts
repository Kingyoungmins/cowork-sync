// test/unit/claude.defer.test.ts — the DeferSet (CCI-23, ENG-31, 01 §3.11, R5-25, F14, A8-4/A8-5): the computed
// deferred map with its tags (fence, read_lease, degraded, coalesce_mid_turn, coalesce_pull_mode), the P1 recheck,
// the apply coalescing and pull-mode rules, and the applied() fan-out (unit over ctx doubles, memory only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeferSet } from '../../src/claude/daemon/defer.js';
import { LeaseTable, type InflightLease, type Txn } from '../../src/claude/daemon/leases.js';
import { C } from '../../src/claude/wire/constants.js';
import { VirtualClock } from '../sim/vclock.js';
import type { DaemonCtx } from '../../src/claude/daemon/ctx.js';
import type { SeatRegistry, Seat } from '../../src/claude/daemon/seats.js';
import type { SeatHealth } from '../../src/claude/daemon/health.js';
import type { BudgetMeter } from '../../src/claude/daemon/meter.js';
import type { ReadSets } from '../../src/claude/daemon/post.js';
import type { AppliedPath } from '../../src/engine/deps.js';
import type { Oid } from '../../src/git/oid.js';
import type { DiskSnapshots } from '../../src/claude/daemon/hookRead.js';
import type { Log } from '../../src/ports/log.js';

const S = 's'.repeat(32);
const T = 't'.repeat(32);

/** The lease-table fixtures the defer tests share. */
const infl = (toolUseId: string, over: Partial<Omit<InflightLease, 'kind' | 'acquiredMono' | 'toolUseId'>> = {}): Omit<InflightLease, 'kind' | 'acquiredMono'> =>
  ({ toolUseId, seatId: S, agentId: null, sessionId: 's1', path: 'src/a.ts', foldHeight: 0, pre: null, approximate: false, synthetic: false, preHeld: null, view: null, tentative: null, ...over });
const openTxnOf = (toolUseId: string, over: Partial<Omit<Txn, 'kind' | 'openMono' | 'toolUseId'>> = {}): Omit<Txn, 'kind' | 'openMono'> =>
  ({ toolUseId, seatId: S, agentId: null, sessionId: 's1', tool: 'Bash', foldHeight: 0, sOpen: {}, approximate: false, background: false, csId: null, view: null, ...over });

interface Rig {
  clock: VirtualClock;
  leases: LeaseTable;
  ctx: DaemonCtx;
  degraded: Map<string, string>;
  readSets: Map<string, Set<string>>;
  pulls: Set<string>;
  seats: Array<{ seat_id: string; number: number; activity: 'IDLE' | 'MID_TURN'; lastHookMono: number | null }>;
  seat: Seat;
  logs: Array<{ level: string; code: string; params: Readonly<Record<string, unknown>> | undefined }>;
}

const seatOf = (seatId: string, number: number): Seat => ({
  seatId, seatKey: 'k'.repeat(64), claudePid: number, number, aliases: [], sessionIds: new Set(['s1']), createdMono: 0,
  wiring: 'FULL', flags: new Set(), wiringCause: null, activity: 'IDLE', lastHookMono: null, lastHeartbeatMono: null,
  mcpConnected: true, ccVersion: null, pluginVersion: '0.0.0', hookProto: 3, permissionMode: 'default',
  turn: { promptId: null, origin: null, recordedPromptId: null, pending: [], lastHumanPromptMono: null, wakeTurnStartMono: null }, ended: false,
} as unknown as Seat);

const make = (): Rig => {
  const clock = new VirtualClock({ startMono: 0 });
  const leases = new LeaseTable(clock, { emit: () => undefined }, {} as unknown as DiskSnapshots);
  const degraded = new Map<string, string>();
  const readSets = new Map<string, Set<string>>();
  const pulls = new Set<string>();
  const seat = seatOf(S, 1);
  const seatT = seatOf(T, 2);                                                        // a second, idle seat (number 2)
  const seatsState = {
    seats: [
      { seat_id: S, number: 1, activity: 'IDLE' as const, wiring: 'FULL' as const, flags: [] as const, lastHookMono: null },
      { seat_id: T, number: 2, activity: 'IDLE' as const, wiring: 'FULL' as const, flags: [] as const, lastHookMono: null },
    ],
  };
  const health = { degradedPaths: () => degraded } as unknown as SeatHealth;
  const readSetsPort = { fullReadSet: (seatId: string) => readSets.get(seatId) ?? new Set<string>() } as unknown as ReadSets;
  const meter = { inPullMode: (seatId: string) => pulls.has(seatId) } as unknown as BudgetMeter;
  const seats = {
    seats: () => seatsState.seats,
    bySeatId: (id: string) => (id === S ? seat : id === T ? seatT : null),
    seatActivity: (id: string) => (id === S ? seat.activity : id === T ? seatT.activity : 'ENDED'),
  } as unknown as SeatRegistry;
  const logs: Rig['logs'] = [];
  const log: Log = { write: (level, code, params) => { logs.push({ level, code, params }); } };
  const ctx = {
    ports: { clock },
    leases,
    health,
    readSets: readSetsPort,
    meter,
    seats,
    log,
  } as unknown as DaemonCtx;
  return { clock, leases, ctx, degraded, readSets, pulls, seats: seatsState.seats, seat, logs };
};

const midTurn = (rig: Rig, hookAgo: number): void => {
  rig.seat.activity = 'MID_TURN';
  rig.seat.lastHookMono = rig.clock.monoMs() - hookAgo;
  rig.seats[0]!.activity = 'MID_TURN';
  rig.seats[0]!.lastHookMono = rig.seat.lastHookMono;
};

test('deferred(): fence, read_lease, coalesced and DEGRADED paths with their tags (T-F14-incoming-deferred daemon side)', () => {
  const rig = make();
  const defer = new DeferSet(rig.ctx);
  rig.leases.acquireInflight(infl('tu1', { path: 'a.ts' }));                       // INFLIGHT on a.ts → 'fence'
  rig.leases.acquireRead(S, 'b.ts');                                               // READ on b.ts → 'read_lease'
  rig.degraded.set('c.ts', S);                                                     // a DEGRADED seat's path → read_lease, source degraded
  midTurn(rig, 10_000);                                                            // a MID_TURN seat, hook 10 s ago
  rig.readSets.set(S, new Set(['d.ts']));
  // The last apply into the read set was 30 s ago (before the read below): one applied() now, then 30 s of virtual time.
  let fanout = 0;
  defer.onApplied(() => { fanout += 1; });
  defer.applied(['d.ts']);                                                         // the apply at mono 10,000
  assert.equal(fanout, 1);
  rig.clock.advance(30_000);                                                       // now 40,000: hook age 40 s, apply age 30 s

  const map = defer.deferred();
  assert.deepEqual(
    [...map].sort(([a], [b]) => (a < b ? -1 : 1)),
    [['a.ts', 'fence'], ['b.ts', 'read_lease'], ['c.ts', 'read_lease'], ['d.ts', 'read_lease']],
  );
  const tags = defer.tags();
  assert.deepEqual(tags.get('a.ts'), { path: 'a.ts', reason: 'fence', source: 'fence', seatNumber: 1, sinceMono: 0, lastApplyIntoReadSetMono: null }, "the fence tag names the lease's seat and acquisition instant (plan:2975)");
  assert.equal(tags.get('b.ts')?.source, 'read_lease');
  assert.equal(tags.get('c.ts')?.source, 'degraded');
  assert.equal(tags.get('c.ts')?.seatNumber, 1);
  assert.equal(tags.get('d.ts')?.source, 'coalesce_mid_turn');
  assert.equal(tags.get('d.ts')?.seatNumber, 1);
  assert.equal(tags.get('d.ts')?.lastApplyIntoReadSetMono, rig.clock.monoMs() - 30_000, 'the coalesced tag carries the last-apply instant');
  // A PULL_MODE seat's read set defers with source coalesce_pull_mode.
  rig.pulls.add(S);
  assert.equal(defer.tags().get('d.ts')?.source, 'coalesce_pull_mode');
  // txnOpen() true adds no per-path entries (the engine skips the worktree).
  rig.leases.openTxn(openTxnOf('tx1'));
  assert.ok(!defer.deferred().has('z.ts'));
  assert.deepEqual([...defer.deferred().keys()].filter((p) => p === 'txn').length, 0, 'TXN is not a per-path row');
});

test('a deferred path is answered from memory: fenced before any apply attempt keeps the fence reason (R5-30, C17)', () => {
  const rig = make();
  const defer = new DeferSet(rig.ctx);
  rig.leases.acquireInflight(infl('tu1', { path: 'a.ts' }));
  assert.equal(defer.deferred().get('a.ts'), 'fence');
  assert.equal(defer.tags().get('a.ts')?.reason, 'fence', 'the tag names the same reason, memory only');
  // A 'pending' pathState is never mapped to a deny by the defer set: it has no pathState input at all.
  assert.ok(!defer.deferred().has('not/touched.ts'));
});

test('apply coalescing: one apply per 2 min into a MID_TURN seat read set; silent over 60 s is not coalescing', () => {
  const rig = make();
  midTurn(rig, 5_000);
  rig.readSets.set(S, new Set(['d.ts']));
  const defer = new DeferSet(rig.ctx);
  assert.deepEqual([...defer.deferred()], [], 'nothing applied yet: the read set applies now');
  defer.applied(['d.ts']);                                          // the apply at t
  midTurn(rig, 0);                                                  // the seat is still live (a hook just landed)
  assert.deepEqual([...defer.deferred()], [['d.ts', 'read_lease']], 'the just-applied seat defers until t + 120,000 (that apply was the one of its window)');
  rig.clock.advance(C.READSET_APPLY_SPACING_MS - 1_000);
  midTurn(rig, 0);
  assert.deepEqual([...defer.deferred()], [['d.ts', 'read_lease']], 'still within the spacing window');
  rig.clock.advance(1_000);
  midTurn(rig, 0);
  assert.deepEqual([...defer.deferred()], [], 'not deferred after the spacing window: the next apply may land');
  defer.applied(['d.ts']);
  rig.clock.advance(1_000);
  midTurn(rig, 0);
  assert.deepEqual([...defer.deferred()], [['d.ts', 'read_lease']], 'the next applied() re-arms the spacing');

  const rig2 = make();
  midTurn(rig2, C.MID_TURN_TRAFFIC_MS + 1_000);                     // MID_TURN by activity but silent for 61 s
  rig2.readSets.set(S, new Set(['d.ts']));
  const defer2 = new DeferSet(rig2.ctx);
  defer2.applied(['d.ts']);
  rig2.clock.advance(1_000);
  assert.deepEqual([...defer2.deferred()], [], 'a silent seat coalesces nothing');
});

test('PULL_MODE: applies into the read set only at its Stop or UserPromptSubmit', () => {
  const rig = make();
  rig.pulls.add(S);
  rig.readSets.set(S, new Set(['e.ts']));
  const defer = new DeferSet(rig.ctx);
  assert.deepEqual([...defer.deferred()], [['e.ts', 'read_lease']], 'deferred while in PULL_MODE');
  rig.clock.advance(1_000);
  assert.deepEqual([...defer.deferred()], [['e.ts', 'read_lease']]);
  defer.onTurnBoundary(S);                                          // the seat's Stop (lease.release)
  assert.deepEqual([...defer.deferred()], [], 'not deferred at the turn boundary');
  defer.applied(['e.ts']);
  assert.deepEqual([...defer.deferred()], [['e.ts', 'read_lease']], 'deferred again until the next boundary');
  defer.onTurnBoundary(S);
  assert.deepEqual([...defer.deferred()], []);
});

test('recheck at P1: a fence opened after J defers that path; a TXN open defers every remaining path (CCI-23, BL2-05)', () => {
  const rig = make();
  const defer = new DeferSet(rig.ctx);
  assert.deepEqual([...defer.recheck(['a.ts', 'b.ts'])], [], 'nothing after J');
  rig.leases.acquireInflight(infl('tu1', { path: 'b.ts' }));
  assert.deepEqual([...defer.recheck(['a.ts', 'b.ts'])], [['b.ts', 'fence']]);
  rig.leases.openTxn(openTxnOf('tx1'));
  assert.deepEqual(
    [...defer.recheck(['a.ts', 'b.ts'])].sort(([a], [b]) => (a < b ? -1 : 1)),
    [['a.ts', 'txn'], ['b.ts', 'fence']],
    'a TXN open on the worktree defers every remaining path',
  );
});

test('applied fans out once per call with the per-path detail and records the last-apply instants (A8-4, A8-5)', () => {
  const rig = make();
  const defer = new DeferSet(rig.ctx);
  const seen: Array<ReadonlyArray<AppliedPath>> = [];
  defer.onApplied((detail) => { seen.push(detail); });
  const detail: AppliedPath[] = [{ path: 'a.ts', from: '1'.repeat(40) as Oid, to: '2'.repeat(40) as Oid, writer: 'P2' }];
  defer.applied(['a.ts'], detail);
  assert.deepEqual(seen, [detail]);
  defer.applied(['a.ts'], detail);
  assert.equal(seen.length, 2, 'every subscriber call fans out once');
  const unsub = defer.onApplied(() => { throw new Error('must not fire after the unsubscribe'); });
  unsub();
  defer.applied(['a.ts'], detail);
  assert.equal(seen.length, 3, 'the unsubscribe removed only its own callback; the first subscriber still fans out');
  // The last-apply instant feeds the coalescing of the seat whose read set holds the path.
  midTurn(rig, 1_000);
  rig.readSets.set(S, new Set(['a.ts']));
  const defer2 = new DeferSet(rig.ctx);
  defer2.applied(['a.ts']);
  assert.deepEqual([...defer2.deferred()], [['a.ts', 'read_lease']], 'the apply into the MID_TURN seat read set re-arms its coalescing');
  assert.equal(defer2.tags().get('a.ts')?.lastApplyIntoReadSetMono, rig.clock.monoMs());
});

test("fence and read_lease tags carry the oldest lease's seat number and instant (plan:2975, F14)", () => {
  const rig = make();
  const defer = new DeferSet(rig.ctx);
  rig.leases.acquireRead(T, 'z.ts');                                               // T's per-seat READ map is created first
  rig.leases.acquireInflight(infl('tuS', { path: 'f.ts' }));                       // S fences f.ts at 0
  rig.leases.acquireRead(S, 'c.ts');                                               // S reads c.ts at 0
  rig.clock.advance(1_000);
  rig.leases.acquireInflight(infl('tuT', { path: 'f.ts', seatId: T }));            // T fences f.ts at 1,000
  rig.leases.acquireRead(T, 'c.ts');                                               // T reads c.ts at 1,000 (iterated before S's)
  rig.clock.advance(4_000);
  rig.leases.acquireRead(T, 'b.ts');                                               // T reads b.ts at 5,000
  rig.clock.advance(10_000);
  const tags = defer.tags();
  assert.deepEqual(tags.get('b.ts'), { path: 'b.ts', reason: 'read_lease', source: 'read_lease', seatNumber: 2, sinceMono: 5_000, lastApplyIntoReadSetMono: null });
  assert.deepEqual([tags.get('f.ts')?.seatNumber, tags.get('f.ts')?.sinceMono], [1, 0], "the oldest fence (S's) names the tag");
  assert.deepEqual([tags.get('c.ts')?.seatNumber, tags.get('c.ts')?.sinceMono], [1, 0], "the oldest READ lease (S's) names the tag");
  rig.leases.release('tuS', 'post');
  assert.deepEqual([defer.tags().get('f.ts')?.seatNumber, defer.tags().get('f.ts')?.sinceMono], [2, 1_000], "S's release leaves T's fence");
});

test('a throwing onApplied subscriber is logged and the fan-out continues', () => {
  const rig = make();
  const defer = new DeferSet(rig.ctx);
  const seen: Array<ReadonlyArray<AppliedPath>> = [];
  defer.onApplied(() => { throw new TypeError('subscriber A broke'); });
  defer.onApplied((d) => { seen.push(d); });
  const detail: AppliedPath[] = [{ path: 'a.ts', from: '1'.repeat(40) as Oid, to: '2'.repeat(40) as Oid, writer: 'P2' }];
  assert.doesNotThrow(() => defer.applied(['a.ts'], detail), 'the engine step never sees a subscriber failure');
  assert.deepEqual(seen, [detail], 'subscriber B got the detail once');
  assert.deepEqual(rig.logs, [{ level: 'error', code: 'DAEMON_INTERNAL_ERROR', params: { where: 'defer.onApplied', error: 'TypeError: subscriber A broke' } }]);
  // A ctx without a log (some test stubs) still never throws.
  const bare = new DeferSet({ ...rig.ctx, log: undefined } as unknown as DaemonCtx);
  bare.onApplied(() => { throw new Error('x'); });
  assert.doesNotThrow(() => bare.applied(['a.ts']));
});
