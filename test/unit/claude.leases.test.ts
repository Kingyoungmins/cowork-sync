// test/unit/claude.leases.test.ts — the lease table (06 §3.7.1–§3.7.4, CCI-20…CCI-22, CCI-24, INV-CCI-LEASE,
// O-LEASE): the tool_use_id-keyed INFLIGHT fence, the per-event release rules, the backstops (INFLIGHT 120 s, READ
// 120 s / ≤ 3 renewals / 300 s hard cap, TXN 120 s cap), the READ lease lifecycle, the TXN open/close facts, the
// expiry counters and the `lease.release` step over HookRequest fixtures (unit with VirtualClock, TraceRecorder).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LeaseTable, scanTxnOpen, type InflightLease, type Txn } from '../../src/claude/daemon/leases.js';
import { runStep } from '../../src/claude/daemon/pipeline.js';
import { C } from '../../src/claude/wire/constants.js';
import { VirtualClock } from '../sim/vclock.js';
import { TraceRecorder } from '../sim/traceRecorder.js';
import type { DaemonCtx, HookRequest } from '../../src/claude/daemon/ctx.js';
import type { Seat } from '../../src/claude/daemon/seats.js';
import type { DiskSnapshots } from '../../src/claude/daemon/hookRead.js';
import type { PredictResultCopy } from '../../src/claude/daemon/claudeDaemon.js';
import { ABSENT, type Oid, type OidOrAbsent } from '../../src/git/oid.js';
import { realFs, type FsLstat } from '../../src/ports/fs.js';
import { FaultFs } from '../sim/faultfs.js';
import { makeTempRoot } from '../helpers/tmp.js';
import type { Log } from '../../src/ports/log.js';
import type { TraceEvent } from '../../src/ports/trace.js';

const S = 's'.repeat(32);
const K1 = 'k'.repeat(64);

type LeaseEv = Extract<TraceEvent, { kind: 'lease' }>;
const leaseEvents = (trace: TraceRecorder): LeaseEv[] => trace.events.filter((e): e is LeaseEv => e.kind === 'lease');

const make = () => {
  const clock = new VirtualClock({ startMono: 0 });
  const trace = new TraceRecorder();
  const leases = new LeaseTable(clock, trace, {} as unknown as DiskSnapshots);
  return { clock, trace, leases };
};

const infl = (toolUseId: string, over: Partial<Omit<InflightLease, 'kind' | 'acquiredMono' | 'toolUseId'>> = {}): Omit<InflightLease, 'kind' | 'acquiredMono'> =>
  ({ toolUseId, seatId: S, agentId: null, sessionId: 's1', path: 'src/a.ts', foldHeight: 0, pre: null, approximate: false, synthetic: false, preHeld: null, view: null, tentative: null, ...over });

const openTxnOf = (toolUseId: string, over: Partial<Omit<Txn, 'kind' | 'openMono' | 'toolUseId'>> = {}): Omit<Txn, 'kind' | 'openMono'> =>
  ({ toolUseId, seatId: S, agentId: null, sessionId: 's1', tool: 'Bash', foldHeight: 0, sOpen: {}, approximate: false, background: false, csId: null, view: null, ...over });

const tentative = { status: 'located' } as unknown as PredictResultCopy;

// ---- the INFLIGHT fence ---------------------------------------------------------------------------------------------

test('INFLIGHT: keyed by tool_use_id, never released by a sibling PreToolUse; fencedPaths is the only fence view', () => {
  const { leases } = make();
  leases.acquireInflight(infl('tu1'));
  leases.acquireInflight(infl('tu2'));
  assert.deepEqual([...leases.fencedPaths()], [['src/a.ts', 'fence']], 'two leases, one fence row');
  leases.acquireInflight(infl('tu3', { path: 'src/b.ts' }));        // a third PreToolUse releases nothing
  leases.release('tu1', 'post');
  assert.deepEqual([...leases.fencedPaths()], [['src/a.ts', 'fence'], ['src/b.ts', 'fence']], 'tu2 keeps the fence');
  leases.release('tu2', 'post');
  assert.deepEqual([...leases.fencedPaths()], [['src/b.ts', 'fence']], 'the last release drops the fence');
  assert.deepEqual(leases.release('tu1', 'post'), null, 'a released id releases nothing again');
  assert.equal(leases.inflight('tu2'), null);
  assert.ok(leases.inflight('tu3') !== null);
});

test('a release drops the tentative claim state with it (Plan 4 C-5); a re-acquired lease starts without one', () => {
  const { leases } = make();
  leases.acquireInflight(infl('tu1', { tentative }));
  leases.release('tu1', 'post');
  const l2 = leases.acquireInflight(infl('tu1', { tentative }));
  assert.ok(l2.tentative !== null, 'the new lease carries its own tentative state');
  leases.release('tu1', 'post');
  assert.equal(leases.inflight('tu1'), null);
});

// ---- the per-event release rules ------------------------------------------------------------------------------------

test('each release event of 06 §3.7.1 releases exactly its leases, with one trace row each', () => {
  const { trace, leases } = make();
  leases.acquireInflight(infl('tuPost'));
  leases.acquireInflight(infl('tuFail'));
  leases.acquireInflight(infl('tuDeny'));
  leases.openTxn(openTxnOf('txDeny'));
  leases.release('tuPost', 'post');
  leases.release('tuFail', 'post_failure');
  leases.release('tuDeny', 'permission_denied');
  leases.release('txDeny', 'permission_denied');
  assert.deepEqual(
    leaseEvents(trace).filter((e) => e.op === 'release').map((e) => [e.key, e.why]),
    [['tuPost', 'post'], ['tuFail', 'post_failure'], ['tuDeny', 'permission_denied'], ['txDeny', 'permission_denied']],
  );

  const t2 = make();
  t2.leases.acquireInflight(infl('b1'));
  t2.leases.acquireInflight(infl('b2'));
  t2.leases.acquireInflight(infl('keep'));
  t2.leases.release('b1', 'batch');
  t2.leases.release('b2', 'batch');
  assert.deepEqual(
    leaseEvents(t2.trace).filter((e) => e.op === 'release').map((e) => e.key),
    ['b1', 'b2'],
    'batch releases every listed id, not the unlisted one',
  );

  const t3 = make();
  t3.leases.acquireInflight(infl('a', { sessionId: 's1' }));
  t3.leases.acquireInflight(infl('b', { sessionId: 's2' }));
  t3.leases.acquireInflight(infl('g1', { agentId: 'a1' }));
  t3.leases.acquireInflight(infl('g2', { agentId: 'a2' }));
  t3.leases.acquireRead(S, 'src/r.ts');
  const endAll = t3.leases.releaseSeat(S, { }, 'seat_end').map((l) => ('toolUseId' in l ? l.toolUseId : l.path));
  assert.deepEqual([...endAll].sort(), ['a', 'b', 'g1', 'g2', 'src/r.ts'], 'a seat end releases every lease, TXN and READ of the seat');
  assert.equal(leaseEvents(t3.trace).filter((e) => e.op === 'release' && e.why === 'seat_end').length, 5);

  const t4 = make();
  t4.leases.acquireInflight(infl('a', { sessionId: 's1' }));
  t4.leases.acquireInflight(infl('b', { sessionId: 's2' }));
  t4.leases.releaseSeat(S, { sessionId: 's1' }, 'session_end');
  assert.ok(t4.leases.inflight('a') === null && t4.leases.inflight('b') !== null, 'session_end keeps the leases of other sessions');

  const t5 = make();
  t5.leases.acquireInflight(infl('g1', { agentId: 'a1' }));
  t5.leases.acquireInflight(infl('g2', { agentId: 'a2' }));
  t5.leases.releaseSeat(S, { agentId: 'a1' }, 'subagent_stop');
  assert.ok(t5.leases.inflight('g1') === null && t5.leases.inflight('g2') !== null, 'subagent_stop keeps the leases of other agents');

  const t6 = make();
  t6.leases.acquireInflight(infl('x', { sessionId: 's2' }));
  t6.leases.releaseSeat(S, { }, 'stop');
  assert.equal(t6.leases.inflight('x'), null, 'stop releases all of the seat');
});

// ---- the backstops --------------------------------------------------------------------------------------------------

test('the INFLIGHT backstop is 120 s with why backstop; expire() reports it and notifies subscribers', () => {
  const { clock, leases, trace } = make();
  const seen: InflightLease[] = [];
  leases.onExpired((l) => seen.push(l));
  leases.acquireInflight(infl('tu1'));
  clock.advance(119_999);
  assert.deepEqual(leases.expire(), { expired: [], capped: [], reads: [] });
  clock.advance(1);
  const r = leases.expire();
  assert.equal(r.expired.length, 1);
  assert.equal(leases.inflight('tu1'), null);
  assert.equal(leaseEvents(trace).at(-1)?.why, 'backstop');
  assert.equal(seen.length, 1, 'the expiry subscriber fired once');
});

test('READ: a never-renewed lease expires at 120 s and renewed ones stop at the 300 s hard cap', () => {
  const { clock, leases } = make();
  leases.acquireRead(S, 'src/a.ts');
  clock.advance(100_000);
  leases.renewReads(S);                                     // renewal 1
  clock.advance(100_000);
  leases.renewReads(S);                                     // renewal 2 → expires 300_000 (the cap)
  clock.advance(80_000);                                    // 280_000
  leases.renewReads(S);                                     // renewal 3 (the last)
  clock.advance(10_000);                                    // 290_000
  leases.renewReads(S);                                     // renewal 4: ignored
  clock.advance(9_999);                                     // 299_999
  assert.deepEqual(leases.expire().reads, [], 'still live under the hard cap');
  clock.advance(1);                                         // 300_000
  const r = leases.expire();
  assert.equal(r.reads.length, 1, 'expired at the 300 s hard cap');
  assert.deepEqual([...leases.fencedPaths()], []);

  const t2 = make();
  t2.leases.acquireRead(S, 'src/a.ts');
  t2.clock.advance(119_999);
  assert.deepEqual(t2.leases.expire().reads, []);
  t2.clock.advance(1);
  assert.equal(t2.leases.expire().reads.length, 1, 'a never-renewed READ expires at 120 s');
});

test('TXN: the 120 s cap closes it with why cap and fires the subscribers; txnOpen/sinceMono track the table', () => {
  const { clock, leases, trace } = make();
  const closes: Array<[string, string]> = [];
  leases.onTxnClosed(async (t, why) => { closes.push([t.toolUseId, why]); });
  leases.openTxn(openTxnOf('tx1'));
  assert.equal(leases.txnOpen(), true);
  assert.equal(leases.txnOpenSinceMono(), 0);
  clock.advance(119_999);
  assert.deepEqual(leases.expire().capped, []);
  clock.advance(1);
  const r = leases.expire();
  assert.equal(r.capped.length, 1);
  assert.equal(leases.txnOpen(), false);
  assert.equal(leases.txnOpenSinceMono(), null);
  assert.equal(leaseEvents(trace).at(-1)?.why, 'cap');
  assert.deepEqual(closes, [['tx1', 'cap']]);
});

test('READ: renewals at 0 (the acquiring step), 10, 20, 30 and 40 s → expiry 150 s; the one at 0 extends nothing and the fourth is ignored', () => {
  const { clock, leases, trace } = make();
  const lease = leases.acquireRead(S, 'src/a.ts');
  leases.renewReads(S);                                     // 0: the acquiring step's own renewal extends nothing
  for (let i = 0; i < 4; i++) {
    clock.advance(10_000);
    leases.renewReads(S);                                   // 10 s, 20 s, 30 s (the third counted), 40 s (ignored)
  }
  assert.equal(lease.renewals, 3);
  assert.equal(lease.expiresMono, 150_000, 'the third counted renewal (at 30 s) set the expiry');
  assert.equal(leaseEvents(trace).filter((e) => e.op === 'renew').length, 3, 'one renew row per counted renewal');
  clock.advance(149_999 - 40_000);
  assert.deepEqual(leases.expire().reads, [], 'still live at 149,999');
  clock.advance(1);
  assert.equal(leases.expire().reads.length, 1, 'released at 150,000');
});

test('an expired READ lease is never renewed back', () => {
  const { clock, leases, trace } = make();
  const lease = leases.acquireRead(S, 'src/a.ts');
  clock.advance(C.READ_LEASE_MS);                           // 120,000: expired, not yet swept by the 1 s ticker
  leases.renewReads(S);
  assert.equal(lease.renewals, 0, 'not renewed');
  assert.equal(lease.expiresMono, 120_000, 'not revived');
  assert.deepEqual(leases.expire().reads.map((l) => l.path), ['src/a.ts'], 'the next sweep releases it');
  assert.deepEqual([leaseEvents(trace).at(-1)?.op, leaseEvents(trace).at(-1)?.why], ['release', 'backstop']);
});

test('a renewal at the hard cap is not counted', () => {
  const { clock, leases } = make();
  const lease = leases.acquireRead(S, 'src/a.ts');
  for (const at of [100_000, 200_000, 280_000, 290_000]) {
    clock.advance(at - clock.monoMs());
    leases.renewReads(S);
  }
  assert.equal(lease.renewals, 2, 'the renewals at 280 s and 290 s extend nothing past the 300 s cap');
  assert.equal(lease.expiresMono, 300_000);
  clock.advance(9_999);
  assert.deepEqual(leases.expire().reads, []);
  clock.advance(1);
  assert.equal(leases.expire().reads.length, 1, 'released at 300,000');
});

// ---- READ lease lifecycle -------------------------------------------------------------------------------------------

test('READ leases: released by the edit-class Post of that seat on that path only', () => {
  const { leases } = make();
  leases.acquireRead(S, 'src/a.ts');
  leases.acquireRead(S, 'src/a.ts');                        // re-acquiring a live lease returns it
  assert.deepEqual([...leases.fencedPaths()], [['src/a.ts', 'read_lease']]);
  const T = 't'.repeat(32);
  leases.acquireRead(T, 'src/a.ts');
  leases.releaseRead(T, 'src/a.ts', 'next_edit_post');      // another seat's edit Post does not release the lease of S
  assert.deepEqual([...leases.fencedPaths()], [['src/a.ts', 'read_lease']]);
  assert.ok(leases.releaseRead(S, 'src/a.ts', 'next_edit_post') !== null);
  assert.deepEqual([...leases.fencedPaths()], []);
  assert.equal(leases.releaseRead(S, 'src/a.ts', 'next_edit_post'), null);
});

// ---- TXN facts ------------------------------------------------------------------------------------------------------

test('openTxn records S_open and the open instant; txnOpen stays true until the last TXN closes', () => {
  const { clock, leases } = make();
  const sOpen = { 'src/a.ts': 'a'.repeat(40) as Oid, 'src/b.ts': 'ABSENT' as const };
  leases.openTxn(openTxnOf('tx1', { sOpen, approximate: true }));
  clock.advance(120_000);
  leases.openTxn(openTxnOf('tx2', { sOpen: {} }));
  const t1 = leases.txn('tx1')!;
  assert.deepEqual({ ...t1.sOpen, approximate: t1.approximate }, { ...sOpen, approximate: true }, 'the open snapshot and the stat-bound flag are kept');
  assert.equal(leases.txnOpen(), true);
  leases.release('tx1', 'post');
  assert.equal(leases.txnOpen(), true, 'tx2 keeps the worktree TXN open');
  assert.equal(leases.txnOpenSinceMono(), 120_000, 'tx2 opened at 120,000 while tx1 was open');
  clock.advance(120_000);
  leases.release('tx2', 'new_turn');
  assert.equal(leases.txnOpen(), false);
});

test('openTxn records S_open, the open fold height and the 20 ms stat bound', async () => {
  const { root, cleanup } = await makeTempRoot('txn-open-scan');
  try {
    const clock = new VirtualClock({ startMono: 0 });
    const abs = (p: string): string => join(root, p);
    const names = Array.from({ length: 200 }, (_, i) => `f${String(i).padStart(3, '0')}.ts`);
    for (const n of names) await writeFile(abs(n), `row ${n}\n`);
    const entries = new Map<string, { oid: OidOrAbsent; stat: FsLstat | null }>();
    for (const n of names) entries.set(n, { oid: 'a'.repeat(40) as Oid, stat: await realFs.lstat(abs(n)) });
    for (const n of ['f005.ts', 'f100.ts', 'f150.ts']) await appendFile(abs(n), 'x');   // dirty against S_open

    const fs = new FaultFs(realFs);
    const scan = await scanTxnOpen(fs, clock, entries, abs);
    assert.deepEqual([...scan.preDirty].sort(), ['f005.ts', 'f100.ts', 'f150.ts'], 'the stat-dirty files keep their pre-window attribution');
    assert.equal(scan.approximate, false);
    assert.equal(scan.statted, 200);
    assert.equal(fs.calls.filter((c) => c.startsWith('lstat ')).length, 200, 'every entry statted through the Fs port');
    assert.equal(Object.keys(scan.sOpen).length, 200, 'S_open names every entry');
    assert.equal(scan.sOpen['f000.ts'], 'a'.repeat(40));

    // A FaultFs slowing lstat by 1 ms (virtual) each: the scan passes 20 ms → approximate, the rest unstatted.
    const slow = new FaultFs(realFs);
    slow.interpose('lstat', root, async () => { clock.advance(1); }, 200);
    const bounded = await scanTxnOpen(slow, clock, entries, abs);
    assert.equal(bounded.approximate, true, 'the 20 ms bound was exceeded: the window is approximate');
    assert.equal(bounded.statted, 20);
    assert.equal(slow.calls.filter((c) => c.startsWith('lstat ')).length, 20, 'the remaining entries are unstatted');
    assert.deepEqual([...bounded.preDirty], ['f005.ts'], 'only the statted dirty file');
    assert.equal(Object.keys(bounded.sOpen).length, 200);

    // A deleted file whose entry has an oid is dirty; an ABSENT entry without a stat whose file now exists is dirty; a
    // tracked entry without a baseline stat is undecidable: not pre-dirty, the window approximate (Ruling t8a-6).
    await writeFile(abs('new.ts'), 'new\n');
    const anyStat = entries.get('f000.ts')!.stat;
    const edge = new Map<string, { oid: OidOrAbsent; stat: FsLstat | null }>([
      ['gone.ts', { oid: 'b'.repeat(40) as Oid, stat: anyStat }],
      ['new.ts', { oid: ABSENT, stat: null }],
      ['f001.ts', { oid: 'c'.repeat(40) as Oid, stat: null }],
    ]);
    const e = await scanTxnOpen(new FaultFs(realFs), clock, edge, abs);
    assert.deepEqual([...e.preDirty].sort(), ['gone.ts', 'new.ts']);
    assert.equal(e.approximate, true, 'the undecidable entry marks the window approximate');
    assert.equal(e.statted, 3);

    // openTxn keeps what the scan computed.
    const { leases } = make();
    leases.openTxn({ ...openTxnOf('tx1', { foldHeight: 7 }), sOpen: bounded.sOpen, approximate: bounded.approximate, preDirty: bounded.preDirty });
    const t = leases.txn('tx1')!;
    assert.equal(t.foldHeight, 7, 'the open fold height');
    assert.deepEqual(t.sOpen, bounded.sOpen, 'S_open');
    assert.equal(t.approximate, true, 'the stat-bound flag');
    assert.deepEqual([...(t.preDirty ?? [])], ['f005.ts'], 'the pre-dirty set');
  } finally {
    await cleanup();
  }
});

test('onTxnClosed subscribers see every TXN release with its why', async () => {
  const { leases } = make();
  const seen: Array<[string, string]> = [];
  leases.onTxnClosed(async (t, why) => { seen.push([t.toolUseId, why]); });
  for (const why of ['post', 'post_failure', 'permission_denied', 'background_return', 'new_turn', 'stop', 'stop_failure', 'session_end', 'seat_end'] as const) {
    leases.openTxn(openTxnOf(`tx-${why}`, { background: why === 'background_return' }));
    if (why === 'seat_end') leases.releaseSeat(S, { }, why);
    else leases.release(`tx-${why}`, why);
  }
  leases.openTxn(openTxnOf('tx-cap'));
  leases.release('tx-cap', 'cap');
  assert.deepEqual(seen, [
    ['tx-post', 'post'], ['tx-post_failure', 'post_failure'], ['tx-permission_denied', 'permission_denied'],
    ['tx-background_return', 'background_return'], ['tx-new_turn', 'new_turn'], ['tx-stop', 'stop'],
    ['tx-stop_failure', 'stop_failure'], ['tx-session_end', 'session_end'], ['tx-seat_end', 'seat_end'], ['tx-cap', 'cap'],
  ]);
});

test('a throwing expiry subscriber is logged; the other subscriber and the rest of expire() still run', async () => {
  const clock = new VirtualClock({ startMono: 0 });
  const rows: Array<{ level: string; code: string; params: unknown }> = [];
  const log: Log = { write: (level, code, params) => { rows.push({ level, code, params }); } };
  const leases = new LeaseTable(clock, new TraceRecorder(), {} as unknown as DiskSnapshots, log);
  const seen: string[] = [];
  leases.onExpired(() => { throw new Error('subscriber 1 broke'); });
  leases.onExpired((l) => { seen.push(l.toolUseId); });
  leases.acquireInflight(infl('tu1'));
  leases.acquireInflight(infl('tu2', { path: 'src/b.ts' }));
  leases.openTxn(openTxnOf('tx1'));
  clock.advance(C.INFLIGHT_BACKSTOP_MS);
  let r: ReturnType<LeaseTable['expire']> | null = null;
  assert.doesNotThrow(() => { r = leases.expire(); }, 'a subscriber failure never escapes expire()');
  assert.deepEqual(seen, ['tu1', 'tu2'], 'the other subscriber saw both leases');
  assert.deepEqual([r!.expired.map((l) => l.toolUseId), r!.capped.map((t) => t.toolUseId)], [['tu1', 'tu2'], ['tx1']], 'both released, and the TXN cap still ran');
  assert.deepEqual([leases.inflight('tu1'), leases.inflight('tu2'), leases.txn('tx1')], [null, null, null]);
  const row = (where: string, error: string) => ({ level: 'error', code: 'DAEMON_INTERNAL_ERROR', params: { where, error } });
  assert.deepEqual(rows, [row('leases.onExpired', 'Error: subscriber 1 broke'), row('leases.onExpired', 'Error: subscriber 1 broke')], 'one row per failed call');
  // A rejecting onTxnClosed subscriber is logged once its promise settles (it was swallowed silently before).
  rows.length = 0;
  leases.onTxnClosed(async () => { throw new RangeError('close broke'); });
  leases.openTxn(openTxnOf('tx2'));
  leases.release('tx2', 'post');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(rows, [row('leases.onTxnClosed', 'RangeError: close broke')]);
});

test('expiredPerSeatHour counts backstop expiries of the last seat-hour', () => {
  const { clock, leases } = make();
  for (let i = 0; i < 6; i++) {
    leases.acquireInflight(infl(`tu${i}`));
    clock.advance(C.INFLIGHT_BACKSTOP_MS);
    leases.expire();
  }
  assert.equal(leases.expiredPerSeatHour(S), 6, 'six expiries within one seat-hour (over 5 flags doctor)');
  clock.advance(C.SEAT_HOUR_MS + 1);
  assert.equal(leases.expiredPerSeatHour(S), 0);
});

// ---- the `lease.release` step ---------------------------------------------------------------------------------------

const seatOf = (): Seat => ({ seatId: S, seatKey: K1, claudePid: 1, number: 1, aliases: [], sessionIds: new Set(['s1']), createdMono: 0, wiring: 'FULL', flags: new Set(), wiringCause: null, activity: 'MID_TURN', lastHookMono: null, lastHeartbeatMono: null, mcpConnected: true, ccVersion: null, pluginVersion: '0.0.0', hookProto: 3, permissionMode: 'default', turn: { promptId: null, origin: null, recordedPromptId: null, pending: [], lastHumanPromptMono: null, wakeTurnStartMono: null }, ended: false });

interface StepRig { clock: VirtualClock; trace: TraceRecorder; leases: LeaseTable; boundaries: string[]; seatEnds: string[]; ctx: DaemonCtx; }

const makeStepRig = (): StepRig => {
  const clock = new VirtualClock({ startMono: 0 });
  const trace = new TraceRecorder();
  const leases = new LeaseTable(clock, trace, {} as unknown as DiskSnapshots);
  const boundaries: string[] = [];
  const seatEnds: string[] = [];
  const ctx = {
    ports: { clock },
    leases,
    defer: { onTurnBoundary: (seatId: string) => { boundaries.push(seatId); } },
    windows: { onSeatBoundary: (seatId: string) => { seatEnds.push(seatId); } },
  } as unknown as DaemonCtx;
  return { clock, trace, leases, boundaries, seatEnds, ctx };
};

const hOf = (sessionId = 's1', agentId: string | null = null): Record<string, unknown> =>
  ({ seat_key: K1, claude_pid: 1, session_id: sessionId, agent_id: agentId, agent_type: null, prompt_id: 'p', permission_mode: 'default', repo_root: '/', plugin_version: '0.0.0', hook_proto: 3 });

const reqOf = (rig: StepRig, event: string, payload: Record<string, unknown>, turn: { doorbell: boolean; newTurn: boolean } | null): { r: HookRequest; d: { deny: null } } => {
  const frame = { t: 'hook', event, h: hOf(payload['__session'] as string | undefined, payload['__agent'] as string | undefined), payload: { ...payload, __session: undefined, __agent: undefined } };
  const r = { frame, seat: seatOf(), startedMono: rig.clock.monoMs(), extend: () => false, turn, trigger: null } as unknown as HookRequest;
  return { r, d: { deny: null } };
};

test('lease.release: a new-turn UserPromptSubmit releases everything and calls onTurnBoundary; a doorbell one releases nothing', async () => {
  const rig = makeStepRig();
  rig.leases.acquireInflight(infl('tu1'));
  rig.leases.acquireRead(S, 'src/r.ts');
  rig.leases.openTxn(openTxnOf('tx1'));
  const up = reqOf(rig, 'UserPromptSubmit', { event: 'UserPromptSubmit', nonces: [] }, { doorbell: false, newTurn: true });
  await runStep('lease.release', up.r as never, up.d as never, rig.ctx);
  assert.equal(rig.leases.txnOpen(), false);
  assert.deepEqual([...rig.leases.fencedPaths()], []);
  assert.deepEqual(rig.boundaries, [S]);

  const rig2 = makeStepRig();
  rig2.leases.acquireInflight(infl('tu1'));
  const read = rig2.leases.acquireRead(S, 'src/r.ts');
  rig2.clock.advance(10_000);
  const bell = reqOf(rig2, 'UserPromptSubmit', { event: 'UserPromptSubmit', nonces: ['cws-x'] }, { doorbell: true, newTurn: false });
  await runStep('lease.release', bell.r as never, bell.d as never, rig2.ctx);
  assert.ok(rig2.leases.inflight('tu1') !== null, 'a mid-turn doorbell releases nothing');
  assert.deepEqual(
    [...rig2.leases.fencedPaths()].sort(([a], [b]) => (a < b ? -1 : 1)),
    [['src/a.ts', 'fence'], ['src/r.ts', 'read_lease']],
    'the doorbell released nothing (the fence stands)',
  );
  assert.deepEqual([read.renewals, read.expiresMono], [1, 130_000], 'and renewed the READ lease (10 s later: 130,000)');
});

test('lease.release: an edit-class Post releases the READ lease of that path only', async () => {
  const rig = makeStepRig();
  rig.leases.acquireRead(S, 'src/a.ts');
  rig.leases.acquireRead(S, 'src/b.ts');
  const post = reqOf(rig, 'PostToolUse', { event: 'PostToolUse', tool_use_id: 'tu1', tool_name: 'Edit', path: 'src/a.ts' }, null);
  await runStep('lease.release', post.r as never, post.d as never, rig.ctx);
  assert.deepEqual([...rig.leases.fencedPaths()], [['src/b.ts', 'read_lease']]);
  const post2 = reqOf(rig, 'PostToolUse', { event: 'PostToolUse', tool_use_id: 'tu2', tool_name: 'Read', path: 'src/b.ts' }, null);
  await runStep('lease.release', post2.r as never, post2.d as never, rig.ctx);
  assert.deepEqual([...rig.leases.fencedPaths()], [['src/b.ts', 'read_lease']], 'a Read Post is not an edit-class Post');
  const post3 = reqOf(rig, 'PostToolUse', { event: 'PostToolUse', tool_use_id: 'tu3', tool_name: 'Write', path: 'src/b.ts' }, null);
  await runStep('lease.release', post3.r as never, post3.d as never, rig.ctx);
  assert.deepEqual([...rig.leases.fencedPaths()], []);
});

test('lease.release: PostToolUseFailure and PermissionDenied release by id; PostToolBatch releases every listed id', async () => {
  const rig = makeStepRig();
  rig.leases.acquireInflight(infl('tu1'));
  rig.leases.acquireInflight(infl('tu2'));
  const fail = reqOf(rig, 'PostToolUseFailure', { event: 'PostToolUseFailure', tool_use_id: 'tu1' }, null);
  await runStep('lease.release', fail.r as never, fail.d as never, rig.ctx);
  assert.ok(rig.leases.inflight('tu1') === null && rig.leases.inflight('tu2') !== null);
  const deny = reqOf(rig, 'PermissionDenied', { event: 'PermissionDenied', tool_use_id: 'tu2' }, null);
  await runStep('lease.release', deny.r as never, deny.d as never, rig.ctx);
  assert.ok(rig.leases.inflight('tu2') === null);

  const rig2 = makeStepRig();
  rig2.leases.acquireInflight(infl('b1'));
  rig2.leases.acquireInflight(infl('b2'));
  const batch = reqOf(rig2, 'PostToolBatch', { event: 'PostToolBatch', tool_use_ids: ['b1', 'b2'] }, null);
  await runStep('lease.release', batch.r as never, batch.d as never, rig2.ctx);
  assert.deepEqual([...rig2.leases.fencedPaths()], []);
});

test('lease.release: Stop/StopFailure release all, close the turn boundary and end the late-write tags; SessionEnd and SubagentStop keep their scopes', async () => {
  const rig = makeStepRig();
  rig.leases.acquireInflight(infl('tu1', { sessionId: 's2' }));
  rig.leases.openTxn(openTxnOf('tx1', { sessionId: 's2' }));
  const stop = reqOf(rig, 'Stop', { event: 'Stop', stop_hook_active: false, background_tasks_running: 0, ids_in_last_message: null }, null);
  await runStep('lease.release', stop.r as never, stop.d as never, rig.ctx);
  assert.deepEqual(rig.leases.openFor(S), { inflight: 0, txns: 0 });
  assert.deepEqual(rig.boundaries, [S]);
  assert.deepEqual(rig.seatEnds, [S]);

  const rig2 = makeStepRig();
  rig2.leases.acquireInflight(infl('tu1', { sessionId: 's1' }));
  rig2.leases.acquireInflight(infl('tu2', { sessionId: 's2' }));
  const end = reqOf(rig2, 'SessionEnd', { event: 'SessionEnd', __session: 's2' }, null);
  await runStep('lease.release', end.r as never, end.d as never, rig2.ctx);
  assert.ok(rig2.leases.inflight('tu1') !== null && rig2.leases.inflight('tu2') === null, 'SessionEnd keeps the leases of other sessions');

  const rig3 = makeStepRig();
  rig3.leases.acquireInflight(infl('g1', { agentId: 'a1' }));
  rig3.leases.acquireInflight(infl('g2', { agentId: 'a2' }));
  const sub = reqOf(rig3, 'SubagentStop', { event: 'SubagentStop', __agent: 'a1' }, null);
  await runStep('lease.release', sub.r as never, sub.d as never, rig3.ctx);
  assert.ok(rig3.leases.inflight('g1') === null && rig3.leases.inflight('g2') !== null, 'SubagentStop keeps the leases of other agents');
});

test('lease.release: PostToolBatch releases exactly the listed ids; an unlisted lease of the seat stays', async () => {
  const rig = makeStepRig();
  for (const id of ['b1', 'b2', 'keep']) rig.leases.acquireInflight(infl(id));
  const batch = reqOf(rig, 'PostToolBatch', { event: 'PostToolBatch', tool_use_ids: ['b1', 'b2'] }, null);
  await runStep('lease.release', batch.r as never, batch.d as never, rig.ctx);
  assert.ok(rig.leases.inflight('keep') !== null, 'the unlisted lease of the seat stays');
  assert.deepEqual([...rig.leases.fencedPaths()], [['src/a.ts', 'fence']], 'its fence stands');
  assert.deepEqual(leaseEvents(rig.trace).filter((e) => e.op === 'release').map((e) => [e.key, e.why]), [['b1', 'batch'], ['b2', 'batch']]);
});

test("lease.release: a background TXN's PostToolUse releases it as background_return, a foreground one as post", async () => {
  const rig = makeStepRig();
  rig.leases.openTxn(openTxnOf('txBg', { background: true }));
  rig.leases.openTxn(openTxnOf('txFg'));
  for (const id of ['txBg', 'txFg']) {
    const post = reqOf(rig, 'PostToolUse', { event: 'PostToolUse', tool_use_id: id, tool_name: 'Bash', path: null }, null);
    await runStep('lease.release', post.r as never, post.d as never, rig.ctx);
  }
  assert.deepEqual(leaseEvents(rig.trace).filter((e) => e.op === 'release').map((e) => [e.key, e.why]), [['txBg', 'background_return'], ['txFg', 'post']]);
  assert.equal(rig.leases.txnOpen(), false);
});

test('lease.release: StopFailure releases all of the seat with why stop_failure and closes the boundary', async () => {
  const rig = makeStepRig();
  rig.leases.acquireInflight(infl('tu1', { sessionId: 's2' }));
  rig.leases.openTxn(openTxnOf('tx1'));
  rig.leases.acquireRead(S, 'src/r.ts');
  const sf = reqOf(rig, 'StopFailure', { event: 'StopFailure', error: 'rate_limit' }, null);
  await runStep('lease.release', sf.r as never, sf.d as never, rig.ctx);
  assert.deepEqual(rig.leases.openFor(S), { inflight: 0, txns: 0 });
  assert.deepEqual([...rig.leases.fencedPaths()], [], 'the READ lease went too');
  assert.deepEqual(
    leaseEvents(rig.trace).filter((e) => e.op === 'release').map((e) => [e.key, e.why]),
    [['tu1', 'stop_failure'], ['tx1', 'stop_failure'], ['src/r.ts', 'stop_failure']],
  );
  assert.deepEqual(rig.boundaries, [S], 'the turn boundary closed');
  assert.deepEqual(rig.seatEnds, [S], 'the late-write tags ended');
});

test('lease.release: every event that runs the step renews the READ leases, counted only when it extends', async () => {
  const rig = makeStepRig();
  const lease = rig.leases.acquireRead(S, 'src/r.ts');
  rig.clock.advance(10_000);
  const bell = reqOf(rig, 'UserPromptSubmit', { event: 'UserPromptSubmit', nonces: ['cws-x'] }, { doorbell: true, newTurn: false });
  await runStep('lease.release', bell.r as never, bell.d as never, rig.ctx);
  assert.deepEqual([lease.renewals, lease.expiresMono], [1, 130_000], 'the doorbell step renewed it');
  const read = reqOf(rig, 'PostToolUse', { event: 'PostToolUse', tool_use_id: 'tuR', tool_name: 'Read', path: 'src/r.ts' }, null);
  await runStep('lease.release', read.r as never, read.d as never, rig.ctx);
  assert.deepEqual([lease.renewals, lease.expiresMono], [1, 130_000], 'a step at the same instant extends nothing: not counted');
  // post.read acquires before lease.release in STEP_ORDER: the acquiring step's own renewal extends nothing.
  const fresh = rig.leases.acquireRead(S, 'src/q.ts');
  const read2 = reqOf(rig, 'PostToolUse', { event: 'PostToolUse', tool_use_id: 'tuQ', tool_name: 'Read', path: 'src/q.ts' }, null);
  await runStep('lease.release', read2.r as never, read2.d as never, rig.ctx);
  assert.equal(fresh.renewals, 0);
  assert.deepEqual(leaseEvents(rig.trace).filter((e) => e.op === 'renew').map((e) => e.key), ['src/r.ts'], 'one renew row in all: the doorbell one');
});
