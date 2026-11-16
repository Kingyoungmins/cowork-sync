// test/integration/claude.writerRecheck.test.ts — Plan 5 Task 8 (T-P5-writer-recheck; CCI-23, BL2-04, BL2-05;
// 01-engine §3.11, ENG-31): the defer set's D-level rows and the writer's P1 re-check over the bound
// ClaudeEnginePort on the real apply path (real git against a file:// bare remote, makeEngines). A lease held at
// the admission defers the whole write group at D with its reason (the group's other paths 'closure'); a fence or
// TXN opened between the intent (J) and a group's P1 defers that group at P1 — nothing of it is written; the
// open TXN then keeps the next apply out entirely; the released group applies at the next iteration. The
// DeferSet rides its own LeaseTable over a VirtualClock (the plan's integration double set: doubles for
// SeatHealth/ReadSets/the seat registry), bound through makeEngines' engineDeps option. F2: with no hit the re-check
// runs exactly once per group, before its P1 (plan l. 2996; #21 #106), and a throwing applied() listener never aborts
// the apply (#110).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyStep } from '../../src/engine/apply.js';
import { DeferSet } from '../../src/claude/daemon/defer.js';
import { LeaseTable, type InflightLease, type Txn } from '../../src/claude/daemon/leases.js';
import type { DaemonCtx } from '../../src/claude/daemon/ctx.js';
import type { AppliedPath, ClaudeEnginePort } from '../../src/engine/deps.js';
import { VirtualClock } from '../sim/vclock.js';
import { logOf, makeEngines } from '../helpers/engineFixture.js';
import { readWork, workPath, type PeerFixture } from '../helpers/coreFixture.js';
import { buf, prep } from '../helpers/publishHelpers.js';

const S = 's'.repeat(32);
const A = 'src/a.ts';
const B = 'src/b.ts';
const BASE_A = 'base a\n';
const BASE_B = 'base b\n';
const TEAM = 'team row\n';

interface Rig { clock: VirtualClock; leases: LeaseTable; defer: DeferSet; }

/** The plan's integration double set for the daemon side (as the defer unit tests build it). */
function rig(): Rig {
  const clock = new VirtualClock({ startMono: 0 });
  const leases = new LeaseTable(clock, { emit: () => undefined } as never, {} as never);
  const ctx = {
    ports: { clock },
    leases,
    health: { degradedPaths: () => new Map() },
    readSets: { fullReadSet: () => new Set<string>() },
    meter: { inPullMode: () => false },
    seats: { seats: () => [], bySeatId: () => null, seatActivity: () => 'ENDED' },
  } as unknown as DaemonCtx;
  return { clock, leases, defer: new DeferSet(ctx) };
}

const infl = (toolUseId: string, path: string): Omit<InflightLease, 'kind' | 'acquiredMono'> =>
  ({ toolUseId, seatId: S, agentId: null, sessionId: 's1', path, foldHeight: 0, pre: null, approximate: false, synthetic: false, preHeld: null, view: null, tentative: null });
const openTxn = (toolUseId: string): Omit<Txn, 'kind' | 'openMono'> =>
  ({ toolUseId, seatId: S, agentId: null, sessionId: 's1', tool: 'Bash' as const, foldHeight: 0, sOpen: {}, approximate: false, background: false, csId: null, view: null });

/** The DeferSet behind a port whose first P1 re-check arms `arm` (a fence or TXN opened after J, before a later
 *  group's P1); the answer of the arming call itself is the pre-arm state. */
function armedPort(r: Rig, arm: () => void): { port: ClaudeEnginePort; recheckCalls: { n: number } } {
  let armed = false;
  const recheckCalls = { n: 0 };
  const port: ClaudeEnginePort = {
    txnOpen: () => r.defer.txnOpen(),
    deferred: () => r.defer.deferred(),
    recheck: (paths) => {
      recheckCalls.n += 1;
      const hit = r.defer.recheck(paths);
      if (!armed) {
        armed = true;
        arm();
      }
      return hit;
    },
    fenced: () => r.defer.fenced(),
    applied: (paths, detail) => r.defer.applied(paths, detail),
  };
  return { port, recheckCalls };
}

const sorted = (m: ReadonlyMap<string, string>): Array<[string, string]> => [...m].sort(([x], [y]) => (x < y ? -1 : 1));

test('recheck answers fences first, then the open TXN (the P1 answer map)', () => {
  const r = rig();
  assert.deepEqual([...r.defer.recheck([A, B])], [], 'nothing open: no row');
  r.leases.acquireInflight(infl('tu1', B));
  assert.deepEqual([...r.defer.recheck([A, B])], [[B, 'fence']], 'the lease fence wins for its path');
  r.leases.openTxn(openTxn('tx1'));
  assert.deepEqual(sorted(r.defer.recheck([A, B])), [[A, 'txn'], [B, 'fence']], 'the remaining path defers with txn; the fenced one keeps fence');
  const r2 = rig();
  r2.leases.openTxn(openTxn('tx2'));
  assert.deepEqual(sorted(r2.defer.recheck([A, B])), [[A, 'txn'], [B, 'txn']], 'a TXN open defers every remaining path');
});

test('a lease held at the admission defers the whole group at D: nothing written, pending {b: fence, a: closure}; the release applies both in one group (CCI-23, ENG-31, INV-GROUP)', { timeout: 10 * 60_000 }, async () => {
  const r = rig();
  const fx = await makeEngines('p5-dlevel-fence', {
    n: 1,
    files: { [A]: buf(BASE_A), [B]: buf(BASE_B) },
    engineDeps: () => ({ claude: r.defer }),
  });
  try {
    await fx.startAll();
    const p = fx.peers[0]!;
    await fx.pushTeamChange({ [A]: buf(TEAM), [B]: buf(TEAM) });   // one CS → one group of both paths
    fx.advance(10_000);
    r.leases.acquireInflight(infl('tu1', B));
    const r1 = await applyStep(p.core, await prep(p, true));
    assert.ok(r1.ran, JSON.stringify(r1));
    assert.deepEqual(r1.written, [], 'nothing of the group was written');
    assert.deepEqual(r1.deleted, []);
    assert.deepEqual(sorted(r1.deferred), [[A, 'closure'], [B, 'fence']], 'the leased path defers with its reason, its group-mate with closure');
    assert.equal(p.core.view!.meta.pending[B], 'fence', 'meta.pending carries the lease reason');
    assert.equal(p.core.view!.meta.pending[A], 'closure');
    assert.equal((await readWork(p, A))?.toString('utf8'), BASE_A, 'the local file is untouched');
    assert.equal((await readWork(p, B))?.toString('utf8'), BASE_B, 'the local file is untouched');
    r.leases.release('tu1', 'post');
    fx.advance(10_000);
    const r2 = await applyStep(p.core, await prep(p, true));
    assert.ok(r2.written.includes(A) && r2.written.includes(B), `after the release both paths apply in one group: ${JSON.stringify(r2)}`);
    assert.equal((await readWork(p, A))?.toString('utf8'), TEAM);
    assert.equal((await readWork(p, B))?.toString('utf8'), TEAM);
  } finally {
    await fx.cleanup();
  }
});

test('T-P5-writer-recheck: a fence opened after J defers the later group at P1 with reason fence (nothing of it written)', { timeout: 10 * 60_000 }, async () => {
  const r = rig();
  const { port } = armedPort(r, () => r.leases.acquireInflight(infl('tu1', B)));
  const fx = await makeEngines('p5-p1-fence', {
    n: 1,
    files: { [A]: buf(BASE_A), [B]: buf(BASE_B) },
    engineDeps: () => ({ claude: port }),
  });
  try {
    await fx.startAll();
    const p = fx.peers[0]!;
    await fx.pushTeamChange({ [A]: buf(TEAM) });   // two CSes → two write groups (G1 = a, G2 = b)
    await fx.pushTeamChange({ [B]: buf(TEAM) });
    fx.advance(10_000);
    const r1 = await applyStep(p.core, await prep(p, true));
    assert.ok(r1.ran, JSON.stringify(r1));
    assert.deepEqual(r1.written, [A], 'G1 (a.ts) was written');
    assert.deepEqual(sorted(r1.deferred), [[B, 'fence']], 'G2 (b.ts) deferred at its P1 with the fence reason');
    assert.equal(p.core.view!.meta.pending[B], 'fence', 'meta.pending carries the fence');
    assert.equal((await readWork(p, A))?.toString('utf8'), TEAM, 'G1 landed');
    assert.equal((await readWork(p, B))?.toString('utf8'), BASE_B, 'nothing of the deferred group touched the disk');
    r.leases.release('tu1', 'post');
    fx.advance(10_000);
    const r2 = await applyStep(p.core, await prep(p, true));
    assert.ok(r2.written.includes(B), `the released group applies at the next iteration: ${JSON.stringify(r2)}`);
    assert.equal((await readWork(p, B))?.toString('utf8'), TEAM);
  } finally {
    await fx.cleanup();
  }
});

test('T-P5-writer-recheck: a TXN opened after J defers the later group with txn; the open TXN then keeps the next apply out', { timeout: 10 * 60_000 }, async () => {
  const r = rig();
  const { port } = armedPort(r, () => r.leases.openTxn(openTxn('tx-race')));
  const fx = await makeEngines('p5-p1-txn', {
    n: 1,
    files: { [A]: buf(BASE_A), [B]: buf(BASE_B) },
    engineDeps: () => ({ claude: port }),
  });
  try {
    await fx.startAll();
    const p = fx.peers[0]!;
    await fx.pushTeamChange({ [A]: buf(TEAM) });
    await fx.pushTeamChange({ [B]: buf(TEAM) });
    fx.advance(10_000);
    const r1 = await applyStep(p.core, await prep(p, true));
    assert.ok(r1.ran, JSON.stringify(r1));
    assert.deepEqual(r1.written, [A], 'G1 (a.ts) was written');
    assert.deepEqual(sorted(r1.deferred), [[B, 'txn']], 'G2 (b.ts) deferred at its P1 with txn');
    assert.ok(r.leases.txnOpen(), 'the TXN is open on the worktree');
    assert.equal((await readWork(p, B))?.toString('utf8'), BASE_B, 'nothing of the deferred group touched the disk');
    // The open TXN keeps the next apply out entirely (the admission's own gate; the iteration's tick is null too).
    fx.advance(10_000);
    const it = await prep(p, true);
    assert.equal(it.tick, null, 'no detection tick while the TXN is open');
    const r2 = await applyStep(p.core, it);
    assert.deepEqual([r2.ran, r2.skipped], [false, 'txn'], JSON.stringify(r2));   // F2 #59: the reason names the TXN
    // The close: the group applies.
    r.leases.release('tx-race', 'post');
    fx.advance(10_000);
    const r3 = await applyStep(p.core, await prep(p, true));
    assert.ok(r3.written.includes(B), `the close frees the group: ${JSON.stringify(r3)}`);
    assert.equal((await readWork(p, B))?.toString('utf8'), TEAM);
  } finally {
    await fx.cleanup();
  }
});

test('with no hit recheck is called exactly once per group, before the group\'s P1 (plan l. 2996, T-P5-writer-recheck)', { timeout: 10 * 60_000 }, async () => {
  const r = rig();
  const holder: { p?: PeerFixture } = {};
  const seen: Array<{ paths: string[]; disk: Record<string, string> }> = [];
  const port: ClaudeEnginePort = {
    txnOpen: () => r.defer.txnOpen(),
    deferred: () => r.defer.deferred(),
    recheck: (paths) => {
      const p = holder.p!;
      // the disk at the re-check instant, read synchronously inside the call
      seen.push({ paths: [...paths], disk: { [A]: readFileSync(workPath(p, A), 'utf8'), [B]: readFileSync(workPath(p, B), 'utf8') } });
      return r.defer.recheck(paths);
    },
    fenced: () => r.defer.fenced(),
    applied: (paths, detail) => r.defer.applied(paths, detail),
  };
  const fx = await makeEngines('p5-p1-once', { n: 1, files: { [A]: buf(BASE_A), [B]: buf(BASE_B) }, engineDeps: () => ({ claude: port }) });
  try {
    await fx.startAll();
    const p = fx.peers[0]!;
    holder.p = p;
    await fx.pushTeamChange({ [A]: buf(TEAM) });   // two CSes → two write groups (G1 = a, G2 = b)
    await fx.pushTeamChange({ [B]: buf(TEAM) });
    fx.advance(10_000);
    seen.length = 0;
    const r1 = await applyStep(p.core, await prep(p, true));
    assert.deepEqual([...r1.written].sort(), [A, B], JSON.stringify(r1));
    assert.equal(seen.length, 2, `recheck is called exactly once per group: ${JSON.stringify(seen)}`);
    assert.deepEqual(seen.map((x) => x.paths), [[A], [B]], 'one call per group, in group order, with exactly its paths');
    assert.deepEqual(seen[0]!.disk, { [A]: BASE_A, [B]: BASE_B }, 'G1 re-checked before its P1: nothing written yet');
    assert.deepEqual(seen[1]!.disk, { [A]: TEAM, [B]: BASE_B }, 'G2 re-checked before its P1: G1 already on disk, G2 not yet');
  } finally {
    await fx.cleanup();
  }
});

test('a throwing applied() listener never aborts the apply: every group is written, the state update commits, the failure is logged (F2 #110)', { timeout: 10 * 60_000 }, async () => {
  const r = rig();
  let thrown = 0;
  // The engine's own guard (apply.ts:1095-1100, F2 #110) covers the ClaudeEnginePort call: the port forwards to the
  // DeferSet and then throws, per the plan's double. The DeferSet's own onApplied fan-out is isolated inside
  // DeferSet.applied since the merge (ruling t8a-10: a subscriber throw is logged DAEMON_INTERNAL_ERROR, never thrown
  // into the engine step), so a subscriber can no longer reach the engine guard — the port is the layer this cell owns.
  const port = {
    txnOpen: () => r.defer.txnOpen(),
    deferred: () => r.defer.deferred(),
    recheck: (paths: readonly string[]) => r.defer.recheck(paths),
    fenced: () => r.defer.fenced(),
    applied: (paths: readonly string[], detail?: ReadonlyArray<AppliedPath>): void => {
      r.defer.applied(paths, detail);
      thrown += 1;
      throw new Error('listener boom');
    },
  };
  const fx = await makeEngines('p5-applied-throws', { n: 1, files: { [A]: buf(BASE_A), [B]: buf(BASE_B) }, engineDeps: () => ({ claude: port }) });
  try {
    await fx.startAll();
    const p = fx.peers[0]!;
    await fx.pushTeamChange({ [A]: buf(TEAM) });   // two CSes → two write groups
    await fx.pushTeamChange({ [B]: buf(TEAM) });
    fx.advance(10_000);
    const log0 = logOf(p).lines.length;
    const it = await prep(p, true);
    const r1 = await applyStep(p.core, it);        // resolves: the listener failure is isolated
    assert.deepEqual([...r1.written].sort(), [A, B], JSON.stringify(r1));
    assert.equal(thrown, 2, 'the listener was called once per written group');
    assert.equal((await readWork(p, A))?.toString('utf8'), TEAM);
    assert.equal((await readWork(p, B))?.toString('utf8'), TEAM);
    const view = p.core.view!;
    assert.equal(view.meta.pending[A], undefined, 'nothing pending for a');
    assert.equal(view.meta.pending[B], undefined, 'nothing pending for b');
    assert.equal(view.laC, it.tip, 'the ENG-36 state update ran (LA_C = the applied tip)');
    const failed = logOf(p).lines.slice(log0).filter((l) => l.code === 'CLAUDE_LISTENER_FAILED');
    assert.deepEqual(failed.map((l) => [l.level, l.params]), [
      ['error', { at: 'applied', code: 'Error' }],
      ['error', { at: 'applied', code: 'Error' }],
    ], 'one error line per throwing group, without the message');
  } finally {
    await fx.cleanup();
  }
});
