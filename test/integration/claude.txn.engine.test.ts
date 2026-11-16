// test/integration/claude.txn.engine.test.ts — Plan 5 Task 8 (06-claude §3.7.3, ENG-23, ENG-13 (c), 01 test 55's TXN
// clause, 01-engine §3.11 defer table row 7, BL2-04; 06 §3.16.1, TC-CCI-14's apply half; A8-4, A8-5): the TXN gate
// and the defer set's coalescing rows on the real apply path over real git. While a TXN is open the engine takes no
// detection tick and no materialization and its apply is refused ('txn', F2 #59), but fetch and fold continue — through
// Engine.iterate, the real loop (F2 #104: a capture that falls due mid-TXN waits for the close too); an edit checkpoint
// queued during the TXN through Engine.signal captures at the close. A conflict take-TIP write on a leased path defers
// with 'conflicted_leased' (the local side stays; after the release the same check re-merges), and this peer's own
// ready pair publishes in the same iteration. A PULL_MODE seat's full-read set applies at its turn boundary and
// defers again after the apply; applied() fans out once per written group with the exact per-path detail (F2 #22 #106).
// 06 test 20 / TC-CCI-06 (F2 #35 #86 #106) runs on the production composition (seatHarness, the engine bound to the
// daemon's ctx.defer): a 30-file codemod under one TXN never yields a live commit with 0 < k < 30 of its files; the
// codemod's shell writes are unobserved (HLD-26, R5-28), so the close trips the mass-change breaker (MASS) and
// HLD-31's post-resume batch publishes the 30 as one human CS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyStep } from '../../src/engine/apply.js';
import { captureDue, massResumePending } from '../../src/engine/core.js';
import { publishStep } from '../../src/engine/publish.js';
import { resume } from '../../src/engine/resume.js';
import { parseCsTrailers, parseWriter } from '../../src/board/boardCommit.js';
import { humanCsN } from '../../src/holds/changesets.js';
import type { Oid } from '../../src/git/oid.js';
import type { AppliedPath, ClaudeEnginePort } from '../../src/engine/deps.js';
import type { CsSignal } from '../../src/holds/signals.js';
import type { Txn } from '../../src/claude/daemon/leases.js';
import { bindEngineClaude, daemonRig, harnessRounds, txnOf, until, type DaemonRig } from '../helpers/claudeRig.js';
import { seatHarness } from '../helpers/seatHarness.js';
import { countCalls, makeEngines, remoteBoardTip, type EngineFixture } from '../helpers/engineFixture.js';
import { readWork, writeWork, type PeerFixture } from '../helpers/coreFixture.js';
import { roundsUntil } from '../helpers/loopHoldsFixture.js';
import { buf, editAndCapture, prep } from '../helpers/publishHelpers.js';
import { testRunner } from '../helpers/tmp.js';

const T10 = { timeout: 10 * 60_000 };
const F = 'src/f.ts';
const BASE = 'one\ntwo\nthree\n';
const TEAM = 'one\ntwo\nthree\nTEAM row\n';
const TEAMS = [1, 2, 3].map((k) => `one\ntwo\nthree\nTEAM row ${k}\n`);
const E = 'src/e.ts';
const E1 = 'e one\n';
const E2 = 'e one\ne two\n';
const E3 = 'e one\ne two\ne three\n';
const C = 'src/c.ts';
const C_BASE = 'alpha\nbeta\ngamma\n';
const C_LOCAL = 'LOCAL alpha\nbeta\ngamma\n';
const C_TEAM = 'TEAM alpha\nbeta\ngamma\n';
const G = 'src/g.ts';
const G_BASE = 'g one\ng two\ng three\n';
const G_HUMAN = 'g one\ng two (human)\ng three\n';

/** An open TXN on the rig whose table the engine reads through the bound DeferSet. */
async function withTxnEngine<T>(label: string, files: Record<string, Buffer>, fn: (fx: EngineFixture, rig: DaemonRig, p: EngineFixture['peers'][number]) => Promise<T>): Promise<T> {
  const rig = daemonRig();
  const fx = await makeEngines(label, { n: 1, files, engineDeps: () => ({ claude: rig.defer }) });
  try {
    await fx.startAll();
    return await fn(fx, rig, fx.peers[0]!);
  } finally {
    await fx.cleanup();
  }
}

/** The text of `path` in the live code of the remote board tip, read in the bare remote itself (no fetch by any peer). */
async function remoteLiveText(fx: EngineFixture, path: string): Promise<string | null> {
  const board = await remoteBoardTip(fx);
  assert.ok(board !== undefined, 'a remote board');
  const runner = testRunner();
  const r = await runner.run(['show', '-s', '--format=%P', board], { class: 'local', cwd: fx.remote.dir });
  assert.equal(r.code, 0, r.stderr.toString('utf8'));
  const parents = r.stdout.toString('utf8').trim().split(' ');
  const live = parents[parents.length - 1]!;
  const b = await runner.run(['cat-file', 'blob', `${live}:${path}`], { class: 'local', cwd: fx.remote.dir });   // exit 128 when the path is absent
  return b.code === 0 ? b.stdout.toString('utf8') : null;
}

/** The live code commit of board commit `board` (its last parent), read in the bare remote. */
async function remoteLiveOf(fx: EngineFixture, board: string): Promise<string> {
  const r = await testRunner().run(['show', '-s', '--format=%P', board], { class: 'local', cwd: fx.remote.dir });
  assert.equal(r.code, 0, r.stderr.toString('utf8'));
  const parents = r.stdout.toString('utf8').trim().split(' ');
  return parents[parents.length - 1]!;
}

/** Every path of commit `c`'s tree, read in the bare remote. */
async function treeNames(fx: EngineFixture, c: string): Promise<string[]> {
  const r = await testRunner().run(['ls-tree', '-r', '--name-only', c], { class: 'local', cwd: fx.remote.dir });
  assert.equal(r.code, 0, r.stderr.toString('utf8'));
  return r.stdout.toString('utf8').split('\n').filter((l) => l.length > 0);
}

/** Every path of the remote board tip's live code. */
async function remoteLiveTree(fx: EngineFixture): Promise<string[]> {
  const board = await remoteBoardTip(fx);
  assert.ok(board !== undefined, 'a remote board');
  return treeNames(fx, await remoteLiveOf(fx, board));
}

/** The live commits after `from` up to the remote board tip's live code, first-parent, oldest first. */
async function liveChainSince(fx: EngineFixture, from: string): Promise<string[]> {
  const board = await remoteBoardTip(fx);
  assert.ok(board !== undefined, 'a remote board');
  const r = await testRunner().run(['rev-list', '--first-parent', '--reverse', `${from}..${await remoteLiveOf(fx, board)}`], { class: 'local', cwd: fx.remote.dir });
  assert.equal(r.code, 0, r.stderr.toString('utf8'));
  return r.stdout.toString('utf8').split('\n').filter((l) => l.length > 0);
}

/** The peer id of the one Cowork-Writer trailer of live commit `live` (as apply.ts reads the incoming writer, X5-06). */
async function writerPeer(p: PeerFixture, live: Oid): Promise<string> {
  const ws = (await p.core.repo.readCommit(live)).trailers.filter((t) => t.key === 'Cowork-Writer');
  assert.equal(ws.length, 1, `one Cowork-Writer trailer on ${live}`);
  const w = parseWriter(ws[0]!.value);
  assert.ok(w !== null, `a well-formed Cowork-Writer on ${live}: ${ws[0]!.value}`);
  return w.peer;
}

const ofPeer = <K extends { peer: string }>(events: readonly K[], p: PeerFixture): K[] => events.filter((e) => e.peer === p.core.peerId);

test('while a TXN is open the engine takes no snapshot and no apply; fetch and fold continue (three loop iterations, each fetching and folding the new board commit); after the close the next iteration applies (06 §3.7.3; F2 #22 #59)', T10, async () => {
  await withTxnEngine('p5-txn-gate', { [F]: buf(BASE) }, async (fx, rig, p) => {
    rig.leases.openTxn(txnOf('tx1'));
    const ticks = countCalls(p.core.snapshot, 'tick');
    const mats = countCalls(p.core.snapshot, 'materialize');
    try {
      for (const [k, team] of TEAMS.entries()) {
        const fetches0 = ofPeer(fx.trace.ofKind('fetch'), p).length;
        const applies0 = ofPeer(fx.trace.ofKind('apply'), p).length;
        await fx.pushTeamChange({ [F]: buf(team) });
        await fx.rounds(1);   // 2,500 ms = FETCH_SPACING_MS: the round's iteration fetches
        const fetched = ofPeer(fx.trace.ofKind('fetch'), p).slice(fetches0);
        assert.ok(fetched.some((e) => e.ok), `round ${k + 1}: ≥ 1 successful fetch while the TXN is open: ${JSON.stringify(fetched)}`);
        assert.equal(p.core.leasedFold?.tip, await remoteBoardTip(fx), `round ${k + 1}: the round folded the new board commit`);
        assert.equal(ticks.n, 0, `round ${k + 1}: no detection tick while the TXN is open`);
        assert.equal(mats.n, 0, `round ${k + 1}: no materialization while the TXN is open`);
        assert.equal(ofPeer(fx.trace.ofKind('apply'), p).length, applies0, `round ${k + 1}: no apply trace while the TXN is open`);
        assert.equal((await readWork(p, F))?.toString('utf8'), BASE, `round ${k + 1}: nothing written`);
      }
      const it = await prep(p, true);
      assert.equal(it.txnOpen, true, 'the iteration context names the open TXN');
      assert.equal(it.tick, null, 'no detection tick while the TXN is open');
      assert.equal(it.mat, null, 'no materialization while the TXN is open');
      assert.equal(it.admission?.skipped, 'txn', 'the apply admission names the TXN');
      assert.equal(it.tipMap.get(F)?.oid, await p.core.repo.hashBytes(buf(TEAMS[2]!), true), 'the fetch and fold continued: the board tip holds the third teammate change');
      const r = await applyStep(p.core, it);
      assert.deepEqual([r.ran, r.skipped], [false, 'txn'], JSON.stringify(r));
      assert.equal(ticks.n, 0);
      assert.equal(mats.n, 0);
    } finally {
      ticks.restore();
      mats.restore();
    }
    assert.equal((await readWork(p, F))?.toString('utf8'), BASE, 'nothing written');
    // The close: the next iterations tick, materialize and apply the teammate's rows.
    rig.leases.release('tx1', 'post');
    await roundsUntil(fx, async () => (await readWork(p, F))?.toString('utf8') === TEAMS[2], 'the apply after the close', 4);
  });
});

test('01 test 55: an Edit reported while a Bash TXN is open is captured at the TXN close (Engine.signal checkpoint queued while txnOpen() is true starts no capture; the first iteration after the close captures the bytes written during it)', T10, async () => {
  await withTxnEngine('p5-txn-checkpoint', { [F]: buf(BASE) }, async (fx, rig, p) => {
    await fx.rounds(2);
    rig.leases.openTxn(txnOf('tx1'));
    await writeWork(p, F, TEAM);                                // the seat writes during the TXN
    const effect: CsSignal = { kind: 'effect', seat: rig.seatId, agent: null, toolUseId: 'toolu_txn1', paths: [F], turnOrigin: 'prompt' };
    const checkpoint: CsSignal = { kind: 'checkpoint', seat: rig.seatId, source: 'edit', candSeq: 1, paths: [F] };
    await p.engine.signal(effect);
    await p.engine.signal(checkpoint);                          // its out-of-cycle iteration ran
    assert.equal(p.core.cs.ready().length, 0, 'the checkpoint queued while the TXN is open started no capture');
    assert.ok(p.core.cs.pendingCandidates().some((c) => c.paths.includes(F)), `the candidate waits: ${JSON.stringify(p.core.cs.pendingCandidates())}`);
    await fx.rounds(2);
    assert.equal(p.core.cs.ready().length, 0, 'no loop iteration captures while the TXN is open either');
    assert.notEqual(await remoteLiveText(fx, F), TEAM, 'nothing of the TXN published');
    rig.leases.release('tx1', 'post');
    const pubs0 = ofPeer(fx.trace.ofKind('publish'), p).length;
    await fx.rounds(1);                                         // the first iteration after the close
    const pair = p.core.cs.ready().find((x) => x.paths.includes(F));
    if (pair !== undefined) {
      // F2 fix round 1 (the 5d8e65d cell's `cap.captured deepEqual [S/1]`): the capture is the seat's own edit candidate.
      assert.equal(pair.csId, `${rig.seatId}/1`, `the ready pair naming f.ts is the seat's candidate: ${JSON.stringify(p.core.cs.ready())}`);
      assert.equal((await p.core.repo.readTreeMap(pair.R)).get(F)?.oid, await p.core.repo.hashBytes(buf(TEAM), true), 'the captured R holds the bytes written during the TXN');
    } else {
      // captured and published by that same iteration
      const pubs = ofPeer(fx.trace.ofKind('publish'), p).slice(pubs0);
      assert.ok(pubs.length > 0, 'that iteration published its capture');
      assert.equal(await remoteLiveText(fx, F), TEAM, 'the live tip holds the bytes written during the TXN');
      // F2 fix round 1: the published change-set of f.ts is the seat's candidate, never a human CS.
      const csOf: Array<{ csId: string; paths: string[] | undefined }> = [];
      for (const e of pubs) {
        if (e.c === null) continue;
        const t = parseCsTrailers((await p.core.repo.readCommit(e.c as Oid)).trailers);
        for (const c of t.cs) csOf.push({ csId: c.csId, paths: t.paths.get(c.csId) });
      }
      assert.ok(csOf.some((c) => c.csId === `${rig.seatId}/1`), `the published CS ids include the seat's candidate: ${JSON.stringify(csOf)}`);
      assert.ok(!csOf.some((c) => humanCsN(c.csId) !== null && (c.paths === undefined || c.paths.includes(F))), `no human CS published f.ts: ${JSON.stringify(csOf)}`);
    }
  });
});

test('a capture that falls due while a TXN is open waits for the close: no tick, no materialization and no capture through Engine.iterate (06 §3.7.3; F2 #104)', T10, async () => {
  await withTxnEngine('p5-txn-capturedue', { [G]: buf(G_BASE) }, async (fx, rig, p) => {
    await writeWork(p, G, G_HUMAN);
    await fx.rounds(1);
    assert.ok(p.core.cs.openPaths().has(G), `the tick observed g.ts into the human CS: ${JSON.stringify([...p.core.cs.openPaths()])}`);
    rig.leases.openTxn(txnOf('tx1'));
    const mats = countCalls(p.core.snapshot, 'materialize');
    const ticks = countCalls(p.core.snapshot, 'tick');
    try {
      await fx.rounds(10);                                      // 25 s: the human CS's 20 s quiet passes mid-TXN
      assert.equal(mats.n, 0, 'no materialization while the TXN is open');
      assert.equal(ticks.n, 0, 'no detection tick while the TXN is open');
      assert.equal(captureDue(p.core), true, 'the capture fell due during the TXN');
      assert.ok(!p.core.cs.ready().some((x) => x.paths.includes(G)), `no ready pair names g.ts: ${JSON.stringify(p.core.cs.ready())}`);
      assert.notEqual(await remoteLiveText(fx, G), G_HUMAN, 'nothing captured mid-TXN reached the live tip');
      rig.leases.release('tx1', 'post');
      await roundsUntil(fx, async () => (await remoteLiveText(fx, G)) === G_HUMAN, 'captured and published after the close', 4);
      assert.ok(mats.n >= 1, `the capture after the close materialized (${mats.n})`);
    } finally {
      mats.restore();
      ticks.restore();
    }
  });
});

test('a TXN that opens while prepareIteration\'s detection tick is in flight keeps that same prepare from materializing — a due capture (\'auto\') and a forced one (true) alike (06 §3.7.3; F2 #104 fix round 1)', T10, async () => {
  await withTxnEngine('p5-txn-during-tick', { [G]: buf(G_BASE) }, async (fx, rig, p) => {
    await writeWork(p, G, G_HUMAN);
    await fx.rounds(1);
    assert.ok(p.core.cs.openPaths().has(G), `the tick observed g.ts into the human CS: ${JSON.stringify([...p.core.cs.openPaths()])}`);
    fx.advance(25_000);                                          // the human CS's 20 s quiet passes: a capture is due
    assert.equal(captureDue(p.core), true, 'a capture is due');
    // The daemon's PreToolUse(Bash) handler runs on the same event loop while the tick awaits its fs/git calls: here the
    // TXN opens right after the tick's own work, before prepareIteration decides its materialization.
    const snap = p.core.snapshot as unknown as { tick: (inp: unknown) => Promise<unknown> };
    const origTick = snap.tick;
    let openAt: string | null = null;
    snap.tick = async (inp: unknown): Promise<unknown> => {
      const r = await origTick.call(p.core.snapshot, inp);
      if (openAt !== null) rig.leases.openTxn(txnOf(openAt));
      openAt = null;
      return r;
    };
    const mats = countCalls(p.core.snapshot, 'materialize');
    try {
      for (const [k, mode] of [['tx-auto', 'auto'], ['tx-forced', true]] as const) {
        openAt = k;
        const it = await prep(p, mode);
        assert.ok(rig.leases.txnOpen(), `${k}: the TXN opened during the tick and is open now`);
        assert.equal(mats.n, 0, `${k}: no materialization while the TXN is open (materialize calls: ${mats.n})`);
        assert.equal(it.mat, null, `${k}: the context carries no materialization`);
        // F2 #104 fix round 2: the context names the TXN that opened during the tick, so a reader of it.txnOpen alone
        // (the pending I2b writeGate) sees the same TXN the materialization gate saw.
        assert.equal(it.txnOpen, true, `${k}: it.txnOpen names the TXN that opened during the tick`);
        rig.leases.release(k, 'post');
      }
    } finally {
      mats.restore();
      snap.tick = origTick;
    }
  });
});

test('a conflict take-TIP write on a leased path defers conflicted_leased, keeps the local side; the seat\'s own ready pair publishes in the same iteration; after the release the displacement proceeds with its K4', T10, async () => {
  const rig = daemonRig();
  const fx = await makeEngines('p5-txn-conflicted-leased', { n: 1, files: { [C]: buf(C_BASE), 'src/own.txt': buf('own\n') }, engineDeps: () => ({ claude: rig.defer }) });
  try {
    await fx.startAll();
    const p = fx.peers[0]!;
    // The seat's own captured pair (its publish must not be delayed by the deferral).
    const { it: capIt } = await editAndCapture(fx, p, { 'src/own.txt': 'own, local\n' });
    void capIt;
    // The conflicting incoming change while a READ lease holds the path.
    rig.leases.acquireRead(rig.seatId, C);
    await writeWork(p, C, C_LOCAL);
    await fx.pushTeamChange({ [C]: buf(C_TEAM) });
    fx.advance(20_000);
    const r = await applyStep(p.core, await prep(p, true));
    assert.ok(!r.written.includes(C), `the take-TIP displacement is refused: ${JSON.stringify(r)}`);
    assert.equal(r.deferred.get(C), 'conflicted_leased', 'the take-TIP displacement is refused with the row-7 reason');
    assert.equal(p.core.view!.meta.pending[C], 'conflicted_leased');
    assert.equal((await readWork(p, C))?.toString('utf8'), C_LOCAL, 'the seat\'s local side stays on the disk');
    // This peer's own publish in the same iteration is not delayed (BL2-04).
    fx.advance(30_000);
    const pub = await publishStep(p.core, await prep(p));
    assert.equal(pub.outcome, 'landed', JSON.stringify(pub));
    assert.ok(pub.c !== null, 'the seat\'s own pair landed');
    // After the release the same check re-merges: the take-TIP displacement the lease refused now proceeds,
    // with its K4 record (the seat's local side is preserved in the record's stages, HLD-41).
    rig.leases.releaseRead(rig.seatId, C, 'next_edit_post');
    fx.advance(10_000);
    const r2 = await applyStep(p.core, await prep(p, true));
    assert.ok(r2.written.includes(C), `the displacement proceeds after the release: ${JSON.stringify(r2)}`);
    assert.equal((await readWork(p, C))?.toString('utf8'), C_TEAM, 'the TIP side is on the disk');
    const k4 = p.core.holds.nonTerminal().find((x) => x.kind === 'PATCH' && x.paths.length === 1 && x.paths[0] === C);
    assert.ok(k4 !== undefined, 'the K4 record exists');
  } finally {
    await fx.cleanup();
  }
});

test('PULL_MODE: the read set applies at its turn boundary, defers again after the apply until the next boundary; applied() fans out with the per-path detail (A8-4, A8-5)', T10, async () => {
  const rig = daemonRig({ readSet: new Set([E]), pullMode: true });
  const seen: Array<ReadonlyArray<AppliedPath>> = [];
  const seen2: Array<ReadonlyArray<AppliedPath>> = [];
  rig.defer.onApplied((d) => seen.push(d));
  rig.defer.onApplied((d) => seen2.push(d));
  const fx = await makeEngines('p5-txn-pullmode', { n: 1, files: { [E]: buf(E1) }, engineDeps: () => ({ claude: rig.defer }) });
  try {
    await fx.startAll();
    const p = fx.peers[0]!;
    const t2 = await fx.pushTeamChange({ [E]: buf(E2) });
    fx.advance(10_000);
    const r0 = await applyStep(p.core, await prep(p, true));
    assert.ok(!r0.written.includes(E), JSON.stringify(r0));
    assert.equal(r0.deferred.get(E), 'read_lease', 'the pull-mode read set is deferred');
    assert.equal(rig.defer.tags().get(E)?.source, 'coalesce_pull_mode', 'the memory-only tag names the source');
    // The seat's Stop (the turn boundary): the read set may apply again until the next applied().
    rig.defer.onTurnBoundary(rig.seatId);
    fx.advance(10_000);
    const r1 = await applyStep(p.core, await prep(p, true));
    assert.ok(r1.written.includes(E), JSON.stringify(r1));
    assert.equal((await readWork(p, E))?.toString('utf8'), E2);
    // The apply itself was applied() into the read set: the next change defers again until the next boundary.
    await fx.pushTeamChange({ [E]: buf(E3) });
    fx.advance(10_000);
    const r2 = await applyStep(p.core, await prep(p, true));
    assert.ok(!r2.written.includes(E), `deferred again after the apply: ${JSON.stringify(r2)}`);
    // The fan-out: every subscriber called once with exactly the written path and its detail.
    assert.equal(seen.length, 1, `one fan-out: ${JSON.stringify(seen)}`);
    assert.equal(seen2.length, 1, 'the second subscriber was called once too');
    const d = seen[0]!;
    assert.equal(d.length, 1);
    assert.equal(d[0]!.path, E);
    assert.equal(d[0]!.to, await p.core.repo.hashBytes(buf(E2), true), 'to is the written blob');
    assert.equal(d[0]!.from, await p.core.repo.hashBytes(buf(E1), true), 'from is the pre-apply A (E1)');
    assert.equal(d[0]!.writer, await writerPeer(p, t2.live), 'writer is the incoming live commit\'s writer');
  } finally {
    await fx.cleanup();
  }
});

test('applied() is called once per written group with exactly the written paths: from = the pre-apply A, to = the written blob, writer = the incoming CS\'s writer (plan l. 2997, A8-5; F2 #22 #106)', T10, async () => {
  const rig = daemonRig();
  const calls: Array<{ paths: string[]; detail: AppliedPath[] }> = [];
  const port: ClaudeEnginePort = {
    txnOpen: () => rig.defer.txnOpen(),
    deferred: () => rig.defer.deferred(),
    recheck: (paths) => rig.defer.recheck(paths),
    fenced: () => rig.defer.fenced(),
    applied: (paths, detail) => {
      calls.push({ paths: [...paths], detail: [...(detail ?? [])] });
      rig.defer.applied(paths, detail);
    },
  };
  const PA = 'src/a.ts';
  const PB = 'src/b.ts';
  const PC = 'src/c.ts';
  const X0: Record<string, string> = { [PA]: 'a zero\n', [PB]: 'b zero\n', [PC]: 'c zero\n' };
  const X1: Record<string, string> = { [PA]: 'a one\n', [PB]: 'b one\n', [PC]: 'c one\n' };
  const fx = await makeEngines('p5-txn-applied-groups', { n: 1, files: { [PA]: buf(X0[PA]!), [PB]: buf(X0[PB]!), [PC]: buf(X0[PC]!) }, engineDeps: () => ({ claude: port }) });
  try {
    await fx.startAll();
    const p = fx.peers[0]!;
    const t1 = await fx.pushTeamChange({ [PA]: buf(X1[PA]!), [PB]: buf(X1[PB]!) });   // CS 1 → write group 1 {a, b}
    const t2 = await fx.pushTeamChange({ [PC]: buf(X1[PC]!) });                      // CS 2 → write group 2 {c}
    fx.advance(10_000);
    calls.length = 0;
    const r = await applyStep(p.core, await prep(p, true));
    assert.deepEqual([...r.written].sort(), [PA, PB, PC], JSON.stringify(r));
    assert.equal(calls.length, 2, `one applied() call per written group: ${JSON.stringify(calls)}`);
    const byFirst = [...calls].sort((x, y) => ([...x.paths].sort()[0]! < [...y.paths].sort()[0]! ? -1 : 1));
    assert.deepEqual([...byFirst[0]!.paths].sort(), [PA, PB], 'group 1: exactly its written paths');
    assert.deepEqual([...byFirst[1]!.paths].sort(), [PC], 'group 2: exactly its written path');
    const w1 = await writerPeer(p, t1.live);
    const w2 = await writerPeer(p, t2.live);
    for (const [g, call] of byFirst.entries()) {
      assert.deepEqual(call.detail.map((x) => x.path).sort(), [...call.paths].sort(), `group ${g + 1}: one detail entry per written path`);
      for (const x of call.detail) {
        assert.equal(x.from, await p.core.repo.hashBytes(buf(X0[x.path]!), true), `${x.path}: from is the pre-apply A`);
        assert.equal(x.to, await p.core.repo.hashBytes(buf(X1[x.path]!), true), `${x.path}: to is the written blob`);
        assert.equal(x.writer, x.path === PC ? w2 : w1, `${x.path}: writer is the incoming CS's writer`);
        assert.equal(typeof x.writer, 'string');
      }
    }
  } finally {
    await fx.cleanup();
  }
});

test('a 30-file codemod at 100 ms spacing never yields a live commit with 0 < k < 30 of its files; an apply waits for the TXN close; writes after the cap and from a background process are human-class with a seat tag; a formatter write within 3 s joins the CS (06 test 20, TC-CCI-06, CCI-22, CCI-27; plan l. 3001)', T10, async () => {
  const h = await seatHarness({ peers: 2 });
  try {
    bindEngineClaude(h);   // the production composition: the engine's ClaudeEnginePort is the daemon's ctx.defer
    await h.engines.startAll();
    const pa = h.engines.peers[0]!;
    const pb = h.engines.peers[1]!;
    const ctx = h.daemons[0]!.ctx;
    const fx = h.engines;
    await harnessRounds(h, 2);
    const OTHER = 'src/b.txt';
    const OTHER_BASE = (await readWork(pa, OTHER))!.toString('utf8');
    const OTHER_B = `${OTHER_BASE}B's row\n`;
    const S = 'a'.repeat(32);
    const shellTxn = (toolUseId: string, background = false): Omit<Txn, 'kind' | 'openMono'> => ({
      toolUseId, seatId: S, agentId: null, sessionId: 's1', tool: 'Bash', foldHeight: 0, sOpen: {}, approximate: false, background, csId: null, view: null,
    });
    const CM = Array.from({ length: 30 }, (_, i) => `src/cm/f${String(i).padStart(2, '0')}.ts`);
    const board0 = await remoteBoardTip(fx);
    assert.ok(board0 !== undefined);
    const live0 = await remoteLiveOf(fx, board0);
    // The codemod: one Bash TXN on A; B's teammate change starts at the same time (B's own engine captures and publishes it).
    ctx.leases.openTxn(shellTxn('tx-codemod'));
    await writeWork(pb, OTHER, OTHER_B);
    for (const [i, path] of CM.entries()) {
      await writeWork(pa, path, `export const f${i} = ${i};\n`);
      if (i === 14) {
        // mid-run, what a parallel Edit's Post would send: the seat's effect over all 30 paths and an edit checkpoint
        await pa.engine.signal({ kind: 'effect', seat: S, agent: null, toolUseId: 'toolu_codemod', paths: CM, turnOrigin: 'prompt' });
        await pa.engine.signal({ kind: 'checkpoint', seat: S, source: 'edit', candSeq: 1, paths: CM });
      }
      if ((i + 1) % 25 === 0) for (const p of fx.peers) await p.engine.iterate();   // a loop iteration every 2.5 s of writes
      await h.advance(100);
    }
    // "pytest": the TXN stays open while B's change reaches the remote and A fetches it; A applies nothing meanwhile.
    let rounds = 0;
    for (; rounds < 24; rounds++) {
      await harnessRounds(h, 1);
      assert.ok(ctx.leases.txnOpen(), 'the TXN is still open');
      assert.equal((await readWork(pa, OTHER))?.toString('utf8'), OTHER_BASE, `round ${rounds}: A's apply waits for the TXN close`);
      if (rounds >= 8 && (await remoteLiveText(fx, OTHER)) === OTHER_B && pa.core.leasedFold?.tip === (await remoteBoardTip(fx))) break;
    }
    assert.equal(await remoteLiveText(fx, OTHER), OTHER_B, 'B published its change while the TXN was open');
    assert.equal(pa.core.leasedFold?.tip, await remoteBoardTip(fx), 'A fetched and folded it while the TXN was open');
    await harnessRounds(h, 1);
    assert.equal((await readWork(pa, OTHER))?.toString('utf8'), OTHER_BASE, 'A still has not applied it: the TXN is open');
    // The close: the first post-close tick reads all 30 codemod writes at once. They are a Bash TXN's writes —
    // never observed (HLD-26; R5-28 keeps the breaker's attribution port to edit-class windows) — so the mass-change
    // breaker enters MASS, and FREEZE(MASS) keeps B's apply withheld until the human resume. HLD-31's post-resume
    // batch then observes every changed LIVE path into one human CS (publishing under S1) — that one-CS batch is
    // what keeps the invariant below (one commit holds all 30 or none).
    assert.ok(ctx.leases.release('tx-codemod', 'post') !== null);
    await harnessRounds(h, 1);
    assert.ok(pa.core.view!.meta.freeze_reasons.includes('MASS'), 'the breaker entered MASS at the first post-close tick');
    assert.equal((await readWork(pa, OTHER))?.toString('utf8'), OTHER_BASE, 'the apply waits under FREEZE(MASS)');
    assert.deepEqual(await resume(pa.core), { nonretryable: false, hostRejectReleased: null, massLifted: true }, 'the human resume lifts MASS');
    assert.ok(massResumePending(pa.core), 'the post-resume batch is pending');
    let done = false;
    for (let r = 0; r < 30 && !done; r++) {
      await harnessRounds(h, 1);
      const files = await remoteLiveTree(fx);
      done = CM.every((p) => files.includes(p)) && (await readWork(pa, OTHER))?.toString('utf8') === OTHER_B;
    }
    assert.ok(done, 'after the resume A applied B\'s change and published the codemod (the post-resume batch)');
    // Every live commit since the TXN opened holds 0 or all 30 of the codemod files (first-parent over the live chain).
    const chain = await liveChainSince(fx, live0);
    assert.ok(chain.length > 0, 'live commits landed since the TXN opened');
    for (const c of chain) {
      const k = (await treeNames(fx, c)).filter((p) => CM.includes(p)).length;
      assert.ok(k === 0 || k === CM.length, `live commit ${c} holds ${k} of the 30 codemod files (never 0 < k < 30)`);
    }
    // The attribution half (ctx.windows): a write after the 120 s cap is human-class with the seat tag.
    ctx.leases.openTxn(shellTxn('tx-cap'));
    await h.advance(121_000);
    ctx.leases.expire();                                         // the 1 s housekeeping (or its ticker, whichever ran first)
    await until(() => ctx.leases.txn('tx-cap') === null, 'the TXN cap closed tx-cap');
    await writeWork(pa, 'src/late.ts', 'late\n');
    assert.equal(ctx.windows.attribute('src/late.ts'), null, 'a write after the cap is human-class');
    assert.equal(ctx.windows.seatTag('src/late.ts'), S, 'with the seat tag');
    // A background process writing after its tool returned: human-class with the seat tag too.
    ctx.leases.openTxn(shellTxn('tx-bg', true));
    assert.ok(ctx.leases.release('tx-bg', 'background_return') !== null);
    await writeWork(pa, 'src/bg.ts', 'bg\n');
    assert.equal(ctx.windows.attribute('src/bg.ts'), null, 'a background write after the return is human-class');
    assert.equal(ctx.windows.seatTag('src/bg.ts'), S, 'with the seat tag');
    // A formatter write within 3 s after an Edit's Post joins the seat's CS (the grace window).
    ctx.windows.onEditPost(S, 'src/fmt.ts');
    await h.advance(2_000);
    await writeWork(pa, 'src/fmt.ts', 'formatted\n');
    assert.equal(ctx.windows.attribute('src/fmt.ts')?.[0]?.via, 'grace', 'the formatter write 2 s after the Post is the seat\'s (grace)');
  } finally {
    await h.cleanup();
  }
});
