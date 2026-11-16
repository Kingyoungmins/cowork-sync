// test/integration/claude.engineWiring.test.ts — Plan 5 Task 8 (A8-9, A8-5; 06 §3.17): the daemon's engine bindings
// on the real composition (seatHarness over makeEngines): engineDeps.claude IS the ctx's one DeferSet, engineDeps
// .attribution is the frozen hookAttribution(windows) port answering from the windows, the engine lease port reads
// the seat lease, the 1 s housekeeping ticker expires the lease table (trace `lease` release 'backstop'; a capped
// TXN opens the R5-29 late window), the seat's end releases its leases with 'seat_end' (SeatRegistry.onEnd), and
// EngineCore.onHoldCode routes hold codes into the seat's event store (routeHoldCode). The real-scheduler waits are
// condition waits with a cap (until(), F2 #27). F2 additions on makeEngines: tickSkip ∪ fenced (a fenced path is never
// re-read by a detection tick; plan l. 2991, ENG-23), onHoldCode's every raise in order with a throwing listener
// isolated (plan l. 2998; F2 #110 #21), and an in-run reseed keeping the hook-read spill files (R-F2-16; F2 #105).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { seatHarness, type SeatHarness } from '../helpers/seatHarness.js';
import { raiseHoldCodes, tickSkip } from '../../src/engine/core.js';
import type { HoldCodeRaise } from '../../src/holds/incoming.js';
import { C } from '../../src/claude/wire/constants.js';
import { DiskSnapshots } from '../../src/claude/daemon/hookRead.js';
import { StageDir } from '../../src/engine/stagedRead.js';
import type { FsLstat } from '../../src/ports/fs.js';
import { daemonRig, inflOf, until } from '../helpers/claudeRig.js';
import { logOf, makeEngines } from '../helpers/engineFixture.js';
import { workPath, writeWork } from '../helpers/coreFixture.js';
import { gitIn } from '../helpers/startFixture.js';
import { buf, prep } from '../helpers/publishHelpers.js';

const T10 = { timeout: 10 * 60_000 };
const SOCKET = 'c1c0-wiring';
const SEAT_A = 'a'.repeat(32);
const SEAT_E = 'e'.repeat(32);

async function withHarness<T>(fn: (h: SeatHarness) => Promise<T>): Promise<T> {
  const h = await seatHarness({ peers: 1, humanLeaseMin: 0 });
  try {
    return await fn(h);
  } finally {
    await h.cleanup();
  }
}

const infl = (toolUseId: string, seatId: string) => ({
  toolUseId, seatId, agentId: null, sessionId: 's1', path: 'src/a.ts', foldHeight: 0, pre: null,
  approximate: false, synthetic: false, preHeld: null, view: null, tentative: null,
});
const shellTxn = (toolUseId: string, seatId: string) => ({
  toolUseId, seatId, agentId: null, sessionId: 's1', tool: 'Bash' as const, foldHeight: 0, sOpen: {},
  approximate: false, background: false, csId: null, view: null,
});

/** A FaultFs call line's path, '/'-separated and lower-cased (Windows paths compare case-insensitively). */
const norm = (s: string): string => s.replace(/\\/g, '/').toLowerCase();

test('engineDeps bind the daemon: claude = ctx.defer, attribution = the frozen windows port, lease = the seat lease', async () => {
  await withHarness(async (h) => {
    await h.engines.startAll();
    const d = h.daemons[0]!;
    assert.equal(d.engineDeps.claude, d.ctx.defer, 'engineDeps.claude is the ctx DeferSet');
    assert.equal(d.engineDeps.claude.txnOpen(), d.ctx.leases.txnOpen(), 'txnOpen reads the lease table');
    assert.ok(Object.isFrozen(d.engineDeps.attribution), 'hookAttribution(windows) is frozen');
    assert.equal(d.engineDeps.lease.idleMs(), d.ctx.seatLease.idleMs(), 'the engine lease port reads the seat lease');
    // The attribution port answers from ctx.windows: a formatter grace makes the edit observed; its expiry does not.
    d.ctx.windows.onEditPost(SEAT_A, 'src/a.ts');
    assert.equal(d.engineDeps.attribution.observedEdit('src/a.ts'), true, 'inside the grace');
    await h.advance(C.FORMATTER_GRACE_MS + 1_000);
    assert.equal(d.engineDeps.attribution.observedEdit('src/a.ts'), false, 'the grace expired');
  });
});

test('the 1 s housekeeping ticker expires the lease table: the INFLIGHT backstop and the TXN cap', async () => {
  await withHarness(async (h) => {
    await h.engines.startAll();
    const d = h.daemons[0]!;
    d.ctx.leases.acquireInflight(infl('tu-exp', SEAT_A));
    d.ctx.leases.openTxn(shellTxn('tx-cap', SEAT_E));
    const before = h.trace.ofKind('lease').length;
    await h.advance(C.INFLIGHT_BACKSTOP_MS + 2_000);
    // the ticker fires on the real scheduler (≤ 1 s per fire): wait for the fire that expires the table
    await until(() => d.ctx.leases.inflight('tu-exp') === null && d.ctx.leases.txn('tx-cap') === null, 'the 1 s ticker expired the table');
    assert.equal(d.ctx.leases.inflight('tu-exp'), null, 'the INFLIGHT backstop expired it');
    assert.equal(d.ctx.leases.txn('tx-cap'), null, 'the TXN cap closed it');
    const rel = h.trace.ofKind('lease').slice(before);
    assert.ok(rel.some((e) => e.op === 'release' && e.lease === 'INFLIGHT' && e.key === 'tu-exp' && e.why === 'backstop'), JSON.stringify(rel));
    assert.ok(rel.some((e) => e.op === 'release' && e.lease === 'TXN' && e.key === 'tx-cap' && e.why === 'cap'), JSON.stringify(rel));
    assert.equal(d.ctx.windows.seatTag('src/a.ts'), SEAT_E, 'the cap close opened the R5-29 late window');
  });
});

test("the seat's end releases its leases and TXN with 'seat_end' (SeatRegistry.onEnd → leases.releaseSeat)", async () => {
  await withHarness(async (h) => {
    await h.engines.startAll();
    const d = h.daemons[0]!;
    const seat = h.fakeSeat(0, { socketValue: SOCKET });
    await seat.hello();
    await until(() => seat.seatId() !== null, 'the pipe bound the seat id');
    const seatId = seat.seatId();
    assert.ok(seatId !== null, 'the pipe bound the seat id');
    d.ctx.leases.acquireInflight(infl('tu-end', seatId));
    d.ctx.leases.openTxn(shellTxn('tx-end', seatId));
    const before = h.trace.ofKind('lease').length;
    await seat.mcpEof();                                       // the seat end the registry learns from the server
    await until(() => d.ctx.leases.inflight('tu-end') === null && d.ctx.leases.txn('tx-end') === null, 'seat_end released');
    assert.equal(d.ctx.leases.inflight('tu-end'), null, 'the INFLIGHT lease went with the seat');
    assert.equal(d.ctx.leases.txn('tx-end'), null, 'the TXN went with the seat');
    const rel = h.trace.ofKind('lease').slice(before);
    assert.ok(rel.some((e) => e.op === 'release' && e.why === 'seat_end' && e.lease === 'INFLIGHT' && e.key === 'tu-end' && e.seat === seatId), JSON.stringify(rel));
    assert.ok(rel.some((e) => e.op === 'release' && e.why === 'seat_end' && e.lease === 'TXN' && e.key === 'tx-end' && e.seat === seatId), JSON.stringify(rel));
  });
});

test('EngineCore.onHoldCode → routeHoldCode: a seat CS nudge lands in the event store; a peer CS is not routed', async () => {
  await withHarness(async (h) => {
    await h.engines.startAll();
    const d = h.daemons[0]!;
    const seat = h.fakeSeat(0, { socketValue: SOCKET });
    await seat.hello();
    await until(() => seat.seatId() !== null, 'the pipe bound the seat id');
    const seatId = seat.seatId();
    assert.ok(seatId !== null, 'the pipe bound the seat id');
    const core = h.engines.peers[0]!.core;
    const raise = (code: string, params: Record<string, unknown>): void =>
      raiseHoldCodes(core, [{ code, params } as unknown as HoldCodeRaise]);
    raise('CS_UNPUBLISHED_NUDGE', { cs: `${seatId}/prompt/3`, n: 2 });
    assert.equal(core.holdCode?.code, 'CS_UNPUBLISHED_NUDGE', 'the status code is set');
    const pend = d.ctx.events.pending(seatId);
    const nudge = pend.find((e) => e.code === 'CS_UNPUBLISHED_NUDGE');
    assert.ok(nudge !== undefined, JSON.stringify(pend));
    assert.equal(nudge.params.n, 2);
    // A peer CS (its first segment is no seat id) routes to no seat.
    const before = d.ctx.events.pending(seatId).length;
    raise('CS_UNPUBLISHED_NUDGE', { cs: 'notaseat/human/1', n: 9 });
    assert.equal(d.ctx.events.pending(seatId).length, before, 'the peer CS is not routed');
  });
});

test('EngineCore.onHoldCode sees every raise in order with its params; a throwing listener is logged and the next listener and the status still see every raise (plan l. 2998; F2 #110 #21)', T10, async () => {
  const fx = await makeEngines('p5-wiring-holdcode', { n: 1 });
  try {
    const p = fx.peers[0]!;
    const seen: HoldCodeRaise[] = [];
    let thrown = 0;
    p.core.onHoldCode(() => {
      thrown += 1;
      throw new Error('listener boom');
    });
    p.core.onHoldCode((r) => { seen.push(r); });
    const S = 's'.repeat(32);
    const raises = [
      { code: 'INCOMING_WAITING', params: { cs: 'P2/7', path: 'b.txt', reason: 'locked' } },
      { code: 'CS_UNPUBLISHED_NUDGE', params: { cs: `${S}/3`, n: 2 } },
    ] as unknown as HoldCodeRaise[];
    const log0 = logOf(p).lines.length;
    raiseHoldCodes(p.core, raises);
    assert.equal(thrown, 2, 'the throwing listener was called for both raises');
    assert.deepEqual(seen.map((r) => [r.code, r.params]), [
      ['INCOMING_WAITING', { cs: 'P2/7', path: 'b.txt', reason: 'locked' }],
      ['CS_UNPUBLISHED_NUDGE', { cs: `${S}/3`, n: 2 }],
    ], 'the second listener saw both raises, in order, with their params');
    assert.deepEqual(p.core.holdCode, { code: 'CS_UNPUBLISHED_NUDGE', params: { cs: `${S}/3`, n: 2 } }, 'the status holds the newest raise');
    const lines = logOf(p).lines.slice(log0);
    assert.deepEqual(lines.filter((l) => l.code === 'INCOMING_WAITING' || l.code === 'CS_UNPUBLISHED_NUDGE').map((l) => [l.level, l.code]),
      [['info', 'INCOMING_WAITING'], ['info', 'CS_UNPUBLISHED_NUDGE']], 'both code lines are logged as before');
    const failed = lines.filter((l) => l.code === 'CLAUDE_LISTENER_FAILED');
    assert.deepEqual(failed.map((l) => [l.level, l.params]), [
      ['error', { at: 'onHoldCode', code: 'Error' }],
      ['error', { at: 'onHoldCode', code: 'Error' }],
    ], `each listener failure is logged once, without its message: ${JSON.stringify(lines)}`);
  } finally {
    await fx.cleanup();
  }
});

test('tickSkip ∪ fenced: a fenced path is never re-read by a detection tick; after the release the next tick reads it (plan l. 2991, ENG-23, BL2-03, X-2.1)', T10, async () => {
  const rig = daemonRig();
  const FA = 'src/a.ts';
  const fx = await makeEngines('p5-wiring-tickskip', { n: 1, files: { [FA]: buf('a zero\n'), 'src/b.ts': buf('b zero\n') }, engineDeps: () => ({ claude: rig.defer }) });
  try {
    await fx.startAll();
    const p = fx.peers[0]!;
    const abs = norm(workPath(p, FA));
    const names = (from: number): string[] => p.fs.calls.slice(from).filter((c) => norm(c).includes(abs));
    rig.leases.acquireInflight(inflOf('tu1', FA));
    const mark = p.fs.calls.length;
    await writeWork(p, FA, 'a one (written under the fence)\n');   // new bytes: a non-skipping tick would read them
    const markAfterWrite = p.fs.calls.length;
    assert.equal(markAfterWrite, mark, 'the test write goes through node:fs, not the engine FaultFs');
    for (let i = 0; i < 10; i++) {
      fx.advance(2_500);
      const it = await prep(p);
      assert.ok(it.tick !== null, `tick ${i + 1} ran`);
      assert.ok(tickSkip(p.core).has(FA), `tick ${i + 1}: TickInput.skip holds the fenced path`);
    }
    assert.deepEqual(names(mark), [], 'no lstat or read of the fenced path by any of the 10 ticks');
    assert.ok(!p.core.cs.openPaths().has(FA), 'the fenced path never entered the human CS');
    rig.leases.release('tu1', 'post');
    const mark2 = p.fs.calls.length;
    fx.advance(2_500);
    await prep(p);
    assert.ok(!tickSkip(p.core).has(FA), 'released: no longer skipped');
    assert.ok(names(mark2).some((c) => c.startsWith('lstat ')), `the next tick lstat'd it: ${JSON.stringify(names(mark2))}`);
    assert.ok(p.core.cs.openPaths().has(FA), 'the human CS observed it');
  } finally {
    await fx.cleanup();
  }
});

test('an in-run reseed keeps the hook-read spill files: bytesOf still returns the bytes; the start-time reseed removes them (R-F2-16; F2 #105)', T10, async () => {
  const fx = await makeEngines('p5-wiring-spill', { n: 1 });
  try {
    await fx.startAll();
    const p = fx.peers[0]!;
    const stage = new StageDir(p.deps.ports.fs, join(p.deps.paths.coworkDir, 'tmp', 'stage'));
    const snaps = new DiskSnapshots(p.core.repo, p.deps.ports.fs, stage, 1);   // cap 1 byte: everything spills
    const bytes = buf('hook-read pre-image\n');
    const stat = (await p.deps.ports.fs.lstat(workPath(p, 'src/a.txt'))) as FsLstat;
    const s = await snaps.take('src/a.txt', { kind: 'ok', bytes, stat });
    assert.ok(s.spill !== null, 'the snapshot spilled');
    assert.ok(existsSync(s.spill), `the spill file exists: ${s.spill}`);
    const copy = await stage.write('src/copy.txt', buf('a stage copy\n'));
    assert.ok(existsSync(copy));
    // The in-run reseed, driven through its one caller (F2 fix round 1): materialize's PrivateIndexObjectMissing retry. As in
    // snapshot.gc.test.ts, a blob only the private index names is pruned by `git gc --prune=now`; the next materialization's
    // write-tree exits 128, the Snapshotter reseeds from state:snap (keepHookSpill) and materializes once more.
    const log = logOf(p);
    await writeWork(p, 'src/a.txt', 'a edited for the private index only\n');
    fx.advance(2_500);
    const it1 = await prep(p, true);
    const blobA = it1.mat!.sRawMap.get('src/a.txt')!.oid;
    assert.notEqual(blobA, it1.A.get('src/a.txt')?.oid, 'the private index holds the edit');
    await gitIn(p, ['gc', '-q', '--prune=now']);
    assert.equal(await p.core.repo.hasObject(blobA, 'blob'), false, 'gc pruned the private-index-only blob');
    await writeWork(p, 'src/b2.txt', 'a second edit\n');
    fx.advance(2_500);
    const it2 = await prep(p, true);
    assert.ok(it2.mat !== null, 'the retry materialized');
    assert.equal(log.lines.filter((l) => l.code === 'PRIVATE_INDEX_RESEEDED').length, 1, `the in-run retry reseeded once: ${log.text()}`);
    assert.ok((await snaps.bytesOf(s)).equals(bytes), 'bytesOf still returns the spilled bytes after the in-run reseed');
    assert.equal(readFileSync(s.spill).equals(bytes), true);
    assert.equal(existsSync(copy), false, 'the stage copy outside the spill directory is gone');
    // The start-time reseed (no option) empties the whole stage, the spill files included (SEC-37).
    await p.core.snapshot.reseed(p.core.view!.snap);
    assert.equal(existsSync(s.spill), false, 'the plain reseed removed the spill file');
    assert.ok(existsSync(stage.root), 'the stage root is recreated');
    // F2 fix round 1 (SEC-37): a stage root that is a junction/symlink is never followed by the keep-spill clear — the
    // entries of the link's target outside tmp/stage/ stay, and the root becomes a real directory again.
    const outside = join(p.deps.paths.coworkDir, 'tmp', 'outside-stage');
    mkdirSync(outside, { recursive: true });
    const sentinel = join(outside, 'sentinel.txt');
    writeFileSync(sentinel, 'outside the stage\n');
    rmSync(stage.root, { recursive: true, force: true });
    symlinkSync(outside, stage.root, 'junction');
    await p.core.snapshot.reseed(p.core.view!.snap, { keepHookSpill: true });
    assert.ok(existsSync(sentinel), 'the link target\'s entry outside tmp/stage/ is untouched');
    const rootSt = lstatSync(stage.root);
    assert.ok(rootSt.isDirectory() && !rootSt.isSymbolicLink(), 'the stage root is a real directory again');
  } finally {
    await fx.cleanup();
  }
});
