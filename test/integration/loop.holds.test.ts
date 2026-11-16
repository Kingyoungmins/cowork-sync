// The loop with holds (Plan 3 Task 12a; 01-engine §3.5 rows D, M, R, P, T, ENG-13, ENG-14, ENG-28; 05-holds HLD-08 placement,
// HLD-20…HLD-23, HLD-31, HLD-43; D9, E3, CS-25; rulings R3-19, R3-20, R3-23, R3-30, R3-53, R3-57, R3-62, R3-69; contract additions
// 2 and 5–8): Engine.iterate runs prepareIteration, resolvePushIntent, detectStep, maskStep, captureStep, applyStep, recordStep,
// publishStep and timerStep in that order with Plan 2 Task 17's gates kept. makeEngines({n: 2}) on real clones of one file:// remote;
// the synthetic teammate (fx.pushTeamChange) writes the teammate lines; git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { codePending, foldPatch, massResumePending, SNAP_PRE_FREEZE } from '../../src/engine/core.js';
import { queueSignal, readCsCache } from '../../src/engine/csStep.js';
import { Engine } from '../../src/engine/loop.js';
import type { PublishReport } from '../../src/engine/publish.js';
import { lostStateRebuild, restart } from '../../src/engine/restart.js';
import { readCsTable } from '../../src/engine/state.js';
import { enc } from '../../src/git/enc.js';
import type { Oid } from '../../src/git/oid.js';
import { ChangeSets, pinCs, shadowRecord } from '../../src/holds/changesets.js';
import type { PublishGatePort } from '../../src/holds/ports.js';
import type { TraceEvent } from '../../src/ports/trace.js';
import { countCalls, logOf, remoteBoardTip, withEngines, type EngineFixture } from '../helpers/engineFixture.js';
import { forceRemote, liveOf } from '../helpers/incidentFixture.js';
import { fpy, humanRemovesTeamLine, remoteLiveFiles, restartEngine, roundsUntil, statusOf, T10, teammateLine, withGuard } from '../helpers/loopHoldsFixture.js';
import { buf, failedResult, setMutants, wrapGit } from '../helpers/publishHelpers.js';
import { gitCallsOf, readWork, workPath, writeWork, type PeerFixture } from '../helpers/coreFixture.js';
import { gitIn } from '../helpers/startFixture.js';

const N = 30;
const FILES: Record<string, Buffer> = {
  'README.md': buf('# loop holds\n'),
  'f.py': buf(fpy(N)),
  'g.py': buf(fpy(12).replace(/row_/g, 'g_')),
  'other.txt': buf('other 1\nother 2\nother 3\n'),
};
/** The Task 8 MASS fixture's shape: 200 tracked pkg/ files of 20 rows; the formatter rewrites 180 of them with double quotes. */
const N_PKG = 200;
const N_FMT = 180;
const pkg = (i: number): string => `pkg/m${i}.py`;
const pkgText = (i: number, q: string): string => Array.from({ length: 20 }, (_, j) => `x_${j} = ${q}v${i}_${j}${q}\n`).join('');
const MASS_FILES: Record<string, Buffer> = {
  ...FILES,
  ...Object.fromEntries(Array.from({ length: N_PKG }, (_, i) => [pkg(i), buf(pkgText(i, "'"))])),
};

/** The first index ≥ from of an event of this peer matching `pred`, else -1. */
function indexOf(events: readonly TraceEvent[], from: number, pred: (e: TraceEvent) => boolean): number {
  for (let i = from; i < events.length; i++) if (pred(events[i]!)) return i;
  return -1;
}

type EnginePeer = EngineFixture['peers'][number];

const ofPeer = (p: PeerFixture) => (e: TraceEvent): boolean => (e as { peer?: string }).peer === p.core.peerId;

/** Starts both engines and lets them settle. */
async function started(fx: EngineFixture): Promise<EnginePeer> {
  await fx.startAll();
  await fx.rounds(2);
  return fx.peers[0]!;
}

test('iterate runs prepareIteration, resolvePushIntent, detectStep, maskStep, captureStep, applyStep, recordStep, publishStep, timerStep and sweepRing in that order, with Plan 2\'s step-0 gates, incident branch and throttle hand-off kept', T10, async () => {
  await withEngines('lh-order', { n: 2, files: FILES }, async (fx) => {
    const p = await started(fx);
    await teammateLine(fx, p, N, 10);   // applied in the round just run (the next apply waits 10 s, APPLY_COALESCE_MS)
    // A teammate change elsewhere, fetched by the next iteration (its new tip re-anchors the governor window) but applied only by the
    // closing iteration below; and a stale save that drops the teammate's line between materializations, with an untainted edit of
    // g.py in the same human CS.
    await fx.pushTeamChange({ 'other.txt': buf('other 1\nother 2 team\nother 3\n') });
    await writeWork(p, 'f.py', fpy(N));
    await writeWork(p, 'g.py', fpy(12, { replace: { 6: 'g_6 = 66' } }).replace(/row_/g, 'g_'));
    fx.advance(2_500);
    await p.engine.iterate();   // a detection tick: the human CS opens, nothing is materialized, the apply waits for its 10 s
    assert.equal(withGuard(p, 'revert').length, 0, 'no record before a materialization');
    assert.equal((await readWork(p, 'other.txt'))!.toString('utf8'), 'other 1\nother 2\nother 3\n', 'not applied yet');
    fx.advance(21_000);
    const sweeps = countCalls(p.core.writer, 'sweepRing');
    const from = fx.trace.events.length;
    await p.engine.iterate();   // the 20 s close: materialize, detect, mask, capture, apply, record, publish
    const ev = fx.trace.events;
    const mine = ofPeer(p);
    const recs = withGuard(p, 'revert');
    assert.equal(recs.length, 1, 'the revert detector held the teammate line');
    const iHold = indexOf(ev, from, (e) => mine(e) && e.kind === 'hold' && e.id === recs[0]!.id);
    const iMask = indexOf(ev, from, (e) => mine(e) && e.kind === 'mask');
    const iState = indexOf(ev, Math.max(iHold, iMask), (e) => mine(e) && e.kind === 'state');
    const iApply = indexOf(ev, from, (e) => mine(e) && e.kind === 'apply');
    const iPublish = indexOf(ev, from, (e) => mine(e) && e.kind === 'publish');
    assert.ok(iHold >= 0 && iMask > iHold, `the revert record (D) precedes the mask event (M): ${iHold} ${iMask}`);
    assert.ok(iState > iMask, 'the capture\'s state update follows the MASK (CS-25: detection before any ready capture)');
    assert.ok(iApply > iState, `the capture's state event precedes the apply event: ${iState} ${iApply}`);
    assert.ok(iPublish > iState, `and the publish event: ${iState} ${iPublish}`);
    assert.equal(sweeps.n, 1, 'Writer.sweepRing ran once in the iteration');
    sweeps.restore();
    const live = await remoteLiveFiles(fx, p);
    assert.match(live.get('g.py')!, /g_6 = 66/, 'the human CS was captured and its untainted edit published in that iteration');
    assert.match(live.get('f.py')!, /TEAM = 1/, 'the teammate line stays on the live chain (MASK withheld the revert)');
    assert.equal(live.get('other.txt'), 'other 1\nother 2 team\nother 3\n');

    // A kept push intent: the push lands and its report is lost (the classify fetch fails), so the intent stays journaled.
    await writeWork(p, 'other.txt', 'other 1 mine\nother 2 team\nother 3\n');
    await fx.rounds(1);
    fx.advance(21_000);
    let phase: 'push' | 'blind' | 'off' = 'push';
    const restore = wrapGit(p, async (args, opts, inner) => {
      if (phase === 'push' && args[0] === 'push') {
        phase = 'blind';
        await inner(args, opts);
        return failedResult(-1, 'error: killed\n');
      }
      if (phase === 'blind' && (args[0] === 'fetch' || args[0] === 'ls-remote')) return failedResult(128, 'fatal: unable to access the remote\n');
      return inner(args, opts);
    });
    try {
      await p.engine.iterate();
      assert.equal(p.core.view!.intent.kind, 'push', 'the ambiguous intent is kept');
    } finally {
      phase = 'off';
    }
    restore();
    await fx.pushTeamChange({ 'g.py': buf(fpy(12, { replace: { 6: 'g_6 = 66', 11: 'g_11 = team' } }).replace(/row_/g, 'g_')) });
    fx.advance(31_000);   // past the fetch backoff
    const fetchesBefore = gitCallsOf(p).filter((c) => c.args[0] === 'fetch' || c.args[0] === 'ls-remote').length;
    const from2 = fx.trace.events.length;
    await p.engine.iterate();
    const fetches = gitCallsOf(p).filter((c) => c.args[0] === 'fetch' || c.args[0] === 'ls-remote').length - fetchesBefore;
    assert.equal(fetches, 1, 'resolvePushIntent used the iteration\'s own fetch (no second fetch)');
    assert.equal(p.core.view!.intent.kind, 'none', 'resolved (landed) in the iteration');
    const ev2 = fx.trace.events;
    const iOk = indexOf(ev2, from2, (e) => mine(e) && e.kind === 'A_set' && e.cause === 'push_confirmed');
    const iApply2 = indexOf(ev2, from2, (e) => mine(e) && e.kind === 'apply');
    assert.ok(iOk >= 0 && iApply2 > iOk, `the intent's ok update precedes applyStep: ${iOk} ${iApply2}`);
    assert.match((await readWork(p, 'g.py'))!.toString('utf8'), /g_11 = team/, 'the apply ran after it');

    // A 429 on the iteration fetch with nothing to publish still reaches the governor's fallback (Plan 2 Task 14 carry).
    await fx.rounds(3);
    assert.equal(p.core.governor.mode(), 'normal');
    let armed = true;
    const restore429 = wrapGit(p, async (args, opts, inner) => {
      if (armed && args[0] === 'fetch') {
        armed = false;
        return failedResult(128, "error: RPC failed; HTTP 429 curl 22 The requested URL returned error: 429\nfatal: expected 'packfile'\n");
      }
      return inner(args, opts);
    });
    try {
      fx.advance(2_500);
      await p.engine.iterate();
      assert.equal(p.core.governor.mode(), 'fallback', 'the iteration fetch signal reached the governor');
    } finally {
      restore429();
    }

    // Writer.sweepRing runs every iteration.
    const sweeps2 = countCalls(p.core.writer, 'sweepRing');
    for (let i = 0; i < 3; i++) {
      fx.advance(2_500);
      await p.engine.iterate();
    }
    assert.equal(sweeps2.n, 3, 'one sweep per iteration');
    sweeps2.restore();

    // An incident (the board ref rewound to a commit that is no board commit): prepareIteration returns ok: false with why incident;
    // the iteration enters, then keeps, the incident and runs no hold step (no detection, no MASK, no registry change).
    const main = (await fx.remote.refs())['refs/heads/main'] as Oid;
    await forceRemote(fx, p, p.core.refs.remoteBoard, main);
    const registry = p.core.holds.head();
    const observes = countCalls(p.core.breaker, 'observe');
    const from3 = fx.trace.events.length;
    for (let i = 0; i < 2; i++) {
      fx.advance(2_500);
      await p.engine.iterate();
      assert.ok(p.core.view!.meta.freeze_reasons.includes('INCIDENT'), `iteration ${i + 1}: in the incident`);
    }
    assert.equal(observes.n, 0, 'no breaker tick');
    observes.restore();
    assert.equal(fx.trace.events.slice(from3).filter((e) => mine(e) && (e.kind === 'mask' || e.kind === 'hold' || e.kind === 'apply' || e.kind === 'publish')).length, 0, 'no hold step, apply or publish');
    assert.equal(p.core.holds.head(), registry, 'no registry commit');
    assert.equal((await statusOf(p)).state, 'incident');
  });
});

/** g.py with row `k` edited (`v` its value): every call a distinct human edit of g.py. */
const gpy = (k: number, v: string): string => fpy(12, { replace: { [k]: `g_${k} = ${v}` } }).replace(/row_/g, 'g_');

/** `n` iterations of p alone, 2.5 s apart, each after a fresh human edit of g.py (the human CS stays open: no capture is due). */
async function editingRounds(fx: EngineFixture, p: EnginePeer, n: number, tag: string): Promise<void> {
  for (let i = 0; i < n; i++) {
    await writeWork(p, 'g.py', gpy(3, `${tag}${i}`));
    fx.advance(2_500);
    await p.engine.iterate();
  }
}

const masks = (fx: EngineFixture, p: PeerFixture, from = 0): number => fx.trace.events.slice(from).filter((e) => e.kind === 'mask' && e.peer === p.core.peerId).length;

test('the breaker observes every detection tick and the revert detector runs only on iterations that materialize', T10, async () => {
  await withEngines('lh-detect', { n: 2, files: FILES }, async (fx) => {
    const p = await started(fx);
    await teammateLine(fx, p, N, 10);
    const observes = countCalls(p.core.breaker, 'observe');
    const from = fx.trace.events.length;
    // The stale save drops the teammate line; the human keeps editing g.py, so no capture is due and nothing materializes.
    await writeWork(p, 'f.py', fpy(N));
    fx.advance(2_500);
    await p.engine.iterate();
    await editingRounds(fx, p, 4, 'a');
    assert.equal(observes.n, 5, 'the breaker observed each of the 5 detection ticks that changed a path');
    assert.equal(masks(fx, p, from), 0, 'no iteration materialized');
    assert.equal(withGuard(p, 'revert').length, 0, 'the revert detector ran on no tick (it reads only a newly materialized S_disk)');
    // A tick that changes nothing gives the breaker nothing to observe (paths only, HLD-30).
    fx.advance(2_500);
    await p.engine.iterate();
    assert.equal(observes.n, 5);
    // The close materializes: the detector runs on that S_disk, before its merge and capture.
    fx.advance(21_000);
    await p.engine.iterate();
    assert.equal(masks(fx, p, from), 1, 'one materialization');
    const recs = withGuard(p, 'revert');
    assert.equal(recs.length, 1, 'the revert detector ran on the materializing iteration');
    assert.deepEqual(recs[0]!.paths, ['f.py']);
    observes.restore();
  });
});

test('maskStep runs only on materializing iterations and S_pub stays the MASK of the last materialized S_disk between them', T10, async () => {
  await withEngines('lh-mask', { n: 2, files: FILES }, async (fx) => {
    const p = await started(fx);
    const teamText = await teammateLine(fx, p, N, 10);
    const rec = await humanRemovesTeamLine(fx, p, N);
    await fx.rounds(2);
    const ins0 = await p.engine.inspect();
    assert.ok(ins0.sPub !== null, 'S_pub after the materialization');
    const teamBlob = await p.core.repo.hashBytes(buf(teamText), false);
    assert.equal(ins0.sPub.get('f.py')?.oid, teamBlob, 'S_pub keeps the teammate line (the revert record masks it)');
    const from = fx.trace.events.length;
    // Tick-only iterations (each reaches applyStep, with nothing to apply, and recordStep's R1 and PREDICATEs): S_pub, the held ranges
    // and the mask events do not change (R3-62: no re-MASK outside a materialization).
    await editingRounds(fx, p, 6, 'b');
    const ins1 = await p.engine.inspect();
    assert.deepEqual(ins1.sPub, ins0.sPub, 'S_pub unchanged across tick-only iterations and recordStep');
    assert.deepEqual(ins1.ranges, ins0.ranges);
    assert.equal(masks(fx, p, from), 0, 'no mask event between materializations');
    assert.equal(p.core.holds.get(rec.id)!.state, 'ACTIVE');
    // The next materialization computes S_pub once: one mask event naming the registry head maskEntries read.
    fx.advance(21_000);
    const head = p.core.holds.head();
    await p.engine.iterate();
    const ev = fx.trace.events.slice(from).filter((e): e is Extract<TraceEvent, { kind: 'mask' }> => e.kind === 'mask' && e.peer === p.core.peerId);
    assert.equal(ev.length, 1, 'one mask event per materialization');
    assert.equal(ev[0]!.registry, head, 'the registry head maskEntries read (no record changed before it)');
    assert.equal(ev[0]!.sDisk, p.core.snapshot.last()!.sDisk);
    const ins2 = await p.engine.inspect();
    assert.equal(ins2.sPub!.get('g.py')?.oid, await p.core.repo.hashBytes(buf(gpy(3, 'b5')), false), 'S_pub follows the new S_disk');
    assert.equal(ins2.sPub!.get('f.py')?.oid, teamBlob, 'and keeps masking the held line');
  });
});

/** Five rows the human inserts above everything (the M28 fixture shape: the held row moves 5 rows down on disk). */
const FIVE = 'h_1 = 1\nh_2 = 2\nh_3 = 3\nh_4 = 4\nh_5 = 5\n';

/** This iteration's PublishReport (the Engine's own record of it; null when publishStep was not reached). */
const lastPublish = (p: EnginePeer): PublishReport | null => Reflect.get(p.engine, 'lastPublish') as PublishReport | null;

/** The live code commit at the remote board tip (its last parent). */
async function remoteLive(fx: EngineFixture, p: PeerFixture): Promise<Oid> {
  await p.core.fetcher.fetch(true);
  return liveOf(p, (await remoteBoardTip(fx)) as Oid);
}

/**
 * The M28 fixture through the loop: the teammate's `TEAM = 1` is row 30 of f.py; a stale save drops it and inserts FIVE above (the
 * human's own rows). The loop's next materialization holds the dropped row in one `revert` PATCH (its h1 = A without TEAM).
 */
async function staleSaveAbove(fx: EngineFixture, p: EnginePeer): Promise<string> {
  const team = await teammateLine(fx, p, N, 29);
  await writeWork(p, 'f.py', FIVE + fpy(N));
  return team;
}

test('an assertP failure blocks only its own window\'s code part', T10, async () => {
  await withEngines('lh-assertp', { n: 2, files: FILES }, async (fx) => {
    const p = await started(fx);
    const log = logOf(p);
    const team = await staleSaveAbove(fx, p);
    fx.advance(2_500);
    await p.engine.iterate();   // the human CS opens
    // The close iteration's fetch sees a fresh teammate tip (it re-anchors the window): the CS is captured, nothing is composed.
    await fx.pushTeamChange({ 'other.txt': buf('other 1\nother 2 team\nother 3\n') });
    fx.advance(21_000);
    await p.engine.iterate();
    assert.equal(withGuard(p, 'revert').length, 1, 'the dropped row is held');
    assert.equal(p.core.maskInvalid, false, 'S_pub is valid (M28 off)');
    assert.equal(p.core.cs.ready().length, 1, 'the ready CS is captured and waits for its window');
    const codeBefore = await remoteLive(fx, p);
    const masksBefore = masks(fx, p);
    // One window under M28 (MASK step 5 positional), with no materialization: assertP fails p_range, the code part is dropped.
    setMutants(p, ['M28']);
    fx.advance(6_000);
    await p.engine.iterate();
    const r1 = lastPublish(p)!;
    assert.equal(r1.maskInvalid, true, JSON.stringify(r1));
    assert.equal(r1.c, null, 'no live commit');
    assert.deepEqual(log.lines.filter((l) => l.code === 'HOLD_MASK_INVALID').map((l) => l.params['clause']), ['p_range']);
    assert.equal(p.core.maskInvalid, false, 'an assertP failure never sets EngineCore.maskInvalid (R3-57)');
    assert.equal(await remoteLive(fx, p), codeBefore);
    // The next window, with no new edit, apply or materialization, composes and checks P again and lands the code commit.
    setMutants(p, []);
    fx.advance(12_000);
    await p.engine.iterate();
    const r2 = lastPublish(p)!;
    assert.equal(r2.outcome, 'landed', JSON.stringify(r2));
    assert.ok(r2.c !== null && r2.maskInvalid === false);
    assert.equal(masks(fx, p), masksBefore, 'neither window materialized');
    assert.equal((await remoteLiveFiles(fx, p)).get('f.py'), FIVE + team, 'the untainted rows publish; the held row stays');
  });
});

test('while maskInvalid or massResumePending holds, allowedPending reports no code pending to the governor', T10, async () => {
  await withEngines('lh-pending', { n: 2, files: MASS_FILES }, async (fx) => {
    const p = await started(fx);
    const seen: Array<{ pending: boolean; ops: boolean; code: boolean }> = [];
    const gov = p.core.governor;
    const onFetch = gov.onFetch.bind(gov);
    gov.onFetch = (tip, revealed, firstOfRun, pending): void => {
      seen.push({ pending, ops: p.core.outbox.pendingAllowed([]), code: codePending(p.core, []) });
      onFetch(tip, revealed, firstOfRun, pending);
    };
    // maskInvalid: M28 makes the materialization's assertSPub fail; the ready CS is captured, its code withheld.
    setMutants(p, ['M28']);
    await staleSaveAbove(fx, p);
    await roundsUntil(fx, () => p.core.maskInvalid && p.core.cs.ready().length > 0, 'S_pub invalid with a ready CS');
    await roundsUntil(fx, () => p.core.outbox.size === 0, 'the record\'s op left board-only');
    seen.length = 0;
    await fx.rounds(3);
    assert.ok(seen.length >= 3 && seen.every((s) => !s.code && !s.ops && !s.pending), `no code pending while maskInvalid: ${JSON.stringify(seen)}`);
    // The next passing assertSPub (M28 off) at a materialization whose window is closed (a fresh teammate tip): code is pending again.
    setMutants(p, []);
    await fx.pushTeamChange({ 'other.txt': buf('other 1\nother 2 team\nother 3\n') });
    fx.advance(10_000);
    await p.engine.iterate();
    assert.equal(p.core.maskInvalid, false, 'cleared by the passing assertSPub');
    assert.equal(p.core.cs.ready().length, 1, 'not published yet (the window)');
    seen.length = 0;
    fx.advance(2_500);   // the next fetch (2.5 s spacing) reports to the governor
    await p.engine.iterate();
    assert.equal(seen[0]?.code, true, 'code pending again');
    assert.equal(seen[0]?.pending, true);
    await roundsUntil(fx, () => p.core.cs.ready().length === 0, 'the code published');
    // massResumePending: the formatter trips MASS, its CS is captured under the freeze, and resume lifts MASS.
    for (let i = 0; i < N_FMT; i++) await writeWork(p, pkg(i), pkgText(i, '"'));
    fx.advance(2_500);
    await p.engine.iterate();
    assert.ok(p.core.view!.meta.freeze_reasons.includes('MASS'));
    fx.advance(21_000);
    await p.engine.iterate();
    assert.ok(p.core.cs.ready().some((x) => x.paths.includes(pkg(0))), 'captured under MASS');
    assert.deepEqual((await p.engine.resume()).massLifted, true);
    assert.equal(massResumePending(p.core), true);
    seen.length = 0;
    fx.advance(2_500);
    await p.engine.iterate();   // prepareIteration's fetch reports to the governor, then massResumeStep runs
    assert.equal(seen[0]?.code, false, 'no code pending while massResumePending');
    assert.equal(massResumePending(p.core), false, 'massResumeStep ran in that iteration');
    fx.advance(2_500);
    await p.engine.iterate();
    assert.equal(seen[1]?.code, true, 'code pending again after massResumeStep');
  });
});

test('a pending green or tool checkpoint makes the loop materialize and capture', T10, async () => {
  await withEngines('lh-checkpoint', { n: 2, files: FILES }, async (fx) => {
    const p = await started(fx);
    let k = 0;
    for (const source of ['green', 'tool'] as const) {
      const seat = source === 'green' ? 'a'.repeat(32) : 'b'.repeat(32);
      await writeWork(p, 'g.py', fpy(12, { replace: { 4: `g_4 = ${source}` } }).replace(/row_/g, 'g_'));
      queueSignal(p.core, { kind: 'effect', seat, agent: null, toolUseId: `toolu_${++k}`, paths: ['g.py'], turnOrigin: 'prompt' });
      fx.advance(2_500);
      await p.engine.iterate();   // the tick: the effect's claim keeps g.py with the seat CS
      const cs = p.core.cs.table().cs.find((e) => e.seat === seat && e.state === 'open');
      assert.ok(cs !== undefined && cs.paths.includes('g.py'), `${source}: the seat CS holds g.py`);
      const from = fx.trace.events.length;
      queueSignal(p.core, { kind: 'checkpoint', seat, source, candSeq: k, paths: ['g.py'] });
      fx.advance(2_500);
      await p.engine.iterate();   // no other occasion: no apply, no human close
      assert.equal(masks(fx, p, from), 1, `${source}: the iteration materialized`);
      const view = p.core.view!;
      assert.ok(view.ready.some((r) => r.csId === cs.cs_id) || p.core.cs.table().cs.find((e) => e.cs_id === cs.cs_id)?.publishes === 1,
        `${source}: captureStep journaled the seat CS's pair`);
      assert.equal(p.core.cs.table().passing[cs.cs_id] ?? true, true, `${source}: a passing pair`);
      await roundsUntil(fx, async () => (await remoteLiveFiles(fx, p)).get('g.py')?.includes(`g_4 = ${source}`) === true, `${source}: published`);
    }
  });
});

test('an apply of a teammate change elsewhere in a file whose held revert row is on disk merges from S_disk: the held row survives on disk and A changes only by the verified write', T10, async () => {
  await withEngines('lh-apply-sdisk', { n: 2, files: FILES }, async (fx) => {
    const p = await started(fx);
    await teammateLine(fx, p, N, 10);
    const rec = await humanRemovesTeamLine(fx, p, N);
    await fx.rounds(2);
    // The teammate changes row 25 of f.py; the apply merges with S_disk (no TEAM) as ours, never S_pub (TEAM re-added by MASK).
    const tipText = fpy(N, { after: { 10: 'TEAM = 1' }, replace: { 25: 'row_25 = team25' } });
    await fx.pushTeamChange({ 'f.py': buf(tipText) });
    const from = fx.trace.events.length;
    await roundsUntil(fx, async () => (await readWork(p, 'f.py'))?.toString('utf8').includes('team25') === true, 'the teammate row applied');
    assert.equal((await readWork(p, 'f.py'))!.toString('utf8'), fpy(N, { replace: { 25: 'row_25 = team25' } }), 'the held removal survives on disk');
    const applies = fx.trace.events.slice(from).filter((e): e is Extract<TraceEvent, { kind: 'apply' }> => e.kind === 'apply' && e.peer === p.core.peerId);
    assert.ok(applies.some((a) => a.written.includes('f.py')), 'one verified write of f.py');
    const A = await p.core.repo.readTreeMap(p.core.view!.base);
    assert.equal(A.get('f.py')!.oid, await p.core.repo.hashBytes(buf(tipText), false), 'A[f.py] := TIP[f.py] by the verified write');
    const r = p.core.holds.get(rec.id)!;
    assert.deepEqual([r.residence, r.state], ['ON_DISK', 'ACTIVE'], 'the record still holds its change (R1 after the apply)');
    assert.match((await remoteLiveFiles(fx, p)).get('f.py')!, /TEAM = 1/, 'nothing removed the teammate row from the live chain');
  });
});

test('ENG-28 / R3-20: with mutant M28 and a revert record on row 30 after the human inserted 5 rows above it, assertSPub fails: HOLD_MASK_INVALID in status, no live commit that loop, the record\'s hold op still goes out board-only, and S_disk is never pushed', T10, async () => {
  await withEngines('lh-m28', { n: 2, files: FILES }, async (fx) => {
    const p = await started(fx);
    setMutants(p, ['M28']);
    const team = await staleSaveAbove(fx, p);
    const codeBefore = await remoteLive(fx, p);
    const boardBefore = await remoteBoardTip(fx);
    await roundsUntil(fx, () => withGuard(p, 'revert').length > 0, 'the revert record');
    const rec = withGuard(p, 'revert')[0]!;
    assert.equal(p.core.maskInvalid, true, 'assertSPub failed at the materialization');
    const r = lastPublish(p);
    assert.ok(r !== null && r.maskInvalid === true && r.c === null, `no live commit that loop: ${JSON.stringify(r)}`);
    assert.equal(r.codeSkipped, 'mask_invalid');
    // The record's hold op goes out board-only: the board (its fold, read at the next fetch) holds it, the live code is unchanged.
    await roundsUntil(fx, async () => (await remoteBoardTip(fx)) !== boardBefore && (foldPatch(p.core)?.fold ?? p.core.view!.fold!).holds[rec.id] !== undefined, 'the board-only push of the record\'s op');
    await fx.rounds(4);
    assert.equal(await remoteLive(fx, p), codeBefore, 'no live commit while S_pub is invalid');
    assert.equal((await remoteLiveFiles(fx, p)).get('f.py'), team, 'S_disk (FIVE, no TEAM) is never pushed');
    const s = await statusOf(p);
    assert.equal(s.message_code, 'HOLD_MASK_INVALID', JSON.stringify(s));
    assert.ok(s.pending.not_converged.includes('f.py'));
  });
});

test('after Engine.resume() lifts MASS, the next iterate() materializes because massResumePending is true, no live commit lands before massResumeStep\'s state update, and then the formatted files publish in one live commit', T10, async () => {
  await withEngines('lh-mass', { n: 2, files: MASS_FILES }, async (fx) => {
    const p = await started(fx);
    const codeBefore = await remoteLive(fx, p);
    // The formatter: one tick trips MASS (FREEZE: nothing publishes code); resume comes before the formatter's CS closes.
    for (let i = 0; i < N_FMT; i++) await writeWork(p, pkg(i), pkgText(i, '"'));
    fx.advance(2_500);
    await p.engine.iterate();
    assert.ok(p.core.view!.meta.freeze_reasons.includes('MASS'));
    fx.advance(2_500);
    await p.engine.iterate();
    assert.equal(lastPublish(p)?.c ?? null, null);
    assert.deepEqual(await p.engine.resume(), { nonretryable: false, hostRejectReleased: null, massLifted: true });
    assert.equal(massResumePending(p.core), true);
    // One iteration with no other materialize occasion (no apply, the CS's 20 s not over): it materializes, massResumeStep runs in
    // detectStep and drops snap_pre_freeze in its state update, and its publishStep sends no code.
    const from = fx.trace.events.length;
    fx.advance(2_500);
    await p.engine.iterate();
    assert.equal(masks(fx, p, from), 1, 'it.mat non-null');
    assert.equal(p.core.view!.keep.has(SNAP_PRE_FREEZE), false, 'snap_pre_freeze dropped');
    assert.equal(massResumePending(p.core), false);
    const r = lastPublish(p)!;
    assert.deepEqual([r.c, r.codeSkipped], [null, 'mass_resume'], JSON.stringify(r));
    assert.equal(await remoteLive(fx, p), codeBefore, 'no live commit before massResumeStep\'s state update');
    // After 20 s the batch's one human CS closes: one live commit carries the formatted files.
    await roundsUntil(fx, async () => (await remoteLive(fx, p)) !== codeBefore, 'the formatted files published', 16);
    const live = await remoteLive(fx, p);
    assert.equal((await p.core.repo.readCommit(live)).parents[0], codeBefore, 'one live commit');
    const tree = await p.core.repo.readTreeMap((await p.core.repo.readCommit(live)).tree);
    for (let i = 0; i < N_FMT; i++) assert.equal((await p.core.repo.readBlob(tree.get(pkg(i))!.oid)).toString('utf8'), pkgText(i, '"'), pkg(i));
  });
});

test('recordStep is the only R1 call site: a held change undone on disk ends GONE after the next materializing iteration, a record whose H1 reached A ends SUBSUMED, and a MASK conflict makes the record CONFLICTED with HOLD_CONFLICTED in status', T10, async () => {
  await withEngines('lh-r1', { n: 2, files: FILES }, async (fx) => {
    const p = await started(fx);
    const log = logOf(p);
    const team = await teammateLine(fx, p, N, 10);
    // GONE: the human puts the teammate line back; tick-only iterations leave the record ACTIVE (R1 reads the last materialized
    // S_disk), the next materialization ends it GONE.
    const r1 = await humanRemovesTeamLine(fx, p, N);
    await fx.rounds(2);
    await writeWork(p, 'f.py', team);
    for (let i = 0; i < 3; i++) {
      fx.advance(2_500);
      await p.engine.iterate();
    }
    assert.equal(p.core.holds.get(r1.id)!.state, 'ACTIVE', 'no materialization yet: R1 still sees the held change on S_disk');
    await roundsUntil(fx, () => p.core.holds.get(r1.id)!.state !== 'ACTIVE', 'R1 at the next materialization');
    assert.equal(p.core.holds.get(r1.id)!.state, 'GONE');
    assert.ok(log.lines.some((l) => l.code === 'HOLD_GONE' && l.params['hid'] === r1.id));
    // SUBSUMED: the line removed again (a new record), then the teammate removes it too: A reaches H1.
    const r2 = await humanRemovesTeamLine(fx, p, N);
    assert.notEqual(r2.id, r1.id);
    await fx.pushTeamChange({ 'f.py': buf(fpy(N)) });
    await roundsUntil(fx, () => p.core.holds.get(r2.id)!.state !== 'ACTIVE', 'R1 after the apply');
    assert.equal(p.core.holds.get(r2.id)!.state, 'SUBSUMED');
    assert.ok(log.lines.some((l) => l.code === 'HOLD_SUBSUMED' && l.params['hid'] === r2.id));
    // CONFLICTED: a new teammate line, removed by a stale save; then the human edits the rows on both sides of it, so the step-5
    // reverse merge that re-adds the line conflicts (maskStep's `conflicted`, transitioned by recordStep's evaluateRecords).
    const team3 = await teammateLine(fx, p, N, 20, 'TEAM_2 = 2');
    void team3;
    const r3 = await humanRemovesTeamLine(fx, p, N);
    await fx.rounds(2);
    await writeWork(p, 'f.py', fpy(N, { replace: { 20: 'row_20 = edited', 21: 'row_21 = edited' } }));
    await roundsUntil(fx, () => p.core.holds.get(r3.id)!.state === 'CONFLICTED', 'the MASK conflict transitioned');
    const s = await statusOf(p);
    assert.equal(s.message_code, 'HOLD_CONFLICTED', JSON.stringify([s.state, s.message_code, s.message_params]));
    assert.equal(s.message_params['hid'], r3.id);
  });
});

/** A restore-marker block of a cowork RESTORE (DAT-46 rows). */
const MARKED = 'm1\n<<<<<<< cowork:disk\nm2 local\n||||||| cowork:base\nm2\n=======\nm2 held\n>>>>>>> cowork:held\nm3\n';

test('recordStep releases markers when the rows are gone and eol-bom when the path passes canon, never releases claim under openGate, releases claim when a scripted gate\'s claimStillBlocks answers false, and calls releaseDependencyGuards and incomingStep', T10, async () => {
  const files = { ...FILES, 'm.txt': buf('m1\nm2\nm3\n'), 'mixed.txt': buf('a\r\nb\nc\r\nd\n'), '.gitignore': buf('.env\n') };
  await withEngines('lh-predicates', { n: 2, files }, async (fx) => {
    const p = await started(fx);
    // markers: an ON_DISK record over m.txt whose rows are on disk; the human removes them; the next materialization releases it.
    await writeWork(p, 'm.txt', MARKED);
    const A = await p.core.repo.readTreeMap(p.core.view!.base);
    const markers = await p.core.holds.hold({
      kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: ['m.txt'], guard: 'markers', origin: 'human', cs_ids: [], displaced_by: null,
      blobs: { h0: { 'm.txt': A.get('m.txt')!.oid }, h1: { 'm.txt': await p.core.repo.hashBytes(buf('m1\nm2 held\nm3\n'), true) } },
    });
    await fx.rounds(1);
    fx.advance(21_000);
    await fx.rounds(2);
    assert.deepEqual(p.core.holds.get(markers)!.guards.map((g) => g.name), ['markers'], 'the rows are on disk: markers holds');
    await writeWork(p, 'm.txt', 'm1\nm2 held\nm3\n');
    await roundsUntil(fx, () => p.core.holds.get(markers)!.guards.length === 0, 'markers released at a materialization without rows');
    // eol-bom and the dependency guard: a canon-refused (mixed EOL) save holds mixed.txt whole (eol-bom), whose captured CS gets a
    // dependency PIN at publish (HLD-42); a later save passing canon releases eol-bom (GONE), and releaseDependencyGuards the PIN.
    await writeWork(p, 'mixed.txt', 'a\nb\nc\nd\nE\n');
    await roundsUntil(fx, () => withGuard(p, 'eol-bom').length === 1, 'the eol-bom record');
    const eol = withGuard(p, 'eol-bom')[0]!;
    await roundsUntil(fx, () => withGuard(p, 'dependency').length === 1, 'the dependency PIN', 12);
    const dep = withGuard(p, 'dependency')[0]!;
    assert.deepEqual(dep.guards.map((g) => g.name), [`dependency:${eol.id}`]);
    await writeWork(p, 'mixed.txt', 'a\r\nb\nc\r\nd\nE\n');
    await roundsUntil(fx, () => p.core.holds.get(eol.id)!.state === 'GONE', 'eol-bom released');
    assert.deepEqual(p.core.holds.get(eol.id)!.guards, []);
    assert.deepEqual(p.core.holds.get(dep.id)!.guards, [], 'releaseDependencyGuards released the PIN in the same recordStep');
    await roundsUntil(fx, async () => (await remoteLiveFiles(fx, p)).get('mixed.txt') === 'a\r\nb\nc\r\nd\nE\n', 'the canon-passing bytes published');
    // incomingStep: an incoming creation over a locally ignored file is one INCOMING `collision` record at once (HLD-53).
    await writeWork(p, '.env', 'LOCAL=1\n');
    await fx.pushTeamChange({ '.env': buf('TEAM=1\n') });
    await roundsUntil(fx, () => p.core.holds.nonTerminal().some((r) => r.kind === 'INCOMING' && r.paths[0] === '.env'), 'the INCOMING collision record');
    // claim under openGate: never released (its PREDICATE answers true, fail closed).
    const claim = await p.core.holds.hold({
      kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths: ['g.py'], guard: 'claim:abcdefghij234567', origin: 'human', cs_ids: [], displaced_by: null,
      blobs: { h0: { 'g.py': A.get('g.py')!.oid }, h1: { 'g.py': A.get('g.py')!.oid } },
    });
    await fx.rounds(3);
    assert.deepEqual(p.core.holds.get(claim)!.guards.map((g) => g.name), ['claim:abcdefghij234567'], 'openGate never releases a claim');
  });
  // claim under a scripted gate: Task 10's I2 path bundle through the loop.
  const CLAIM = 'abcdefghij234567';
  let claimed = true;
  const gate: PublishGatePort = {
    gate: async (_repo, _tip, _A, _R, paths) => (claimed && paths.includes('pricing.py') ? { block: { claimId: CLAIM } } : { block: null }),
    claimStillBlocks: async () => claimed,
  };
  const py = (name: string, tag = ''): string => fpy(12, { replace: { 4: `${name}_4 = 4${tag}` } }).replace(/row_/g, `${name}_`);
  const bundleFiles = { 'README.md': buf('# bundle\n'), 'pricing.py': buf(py('pricing')), 'orders.py': buf(py('orders')), 'reports.py': buf(py('reports')) };
  await withEngines('lh-claim', { n: 2, files: bundleFiles, ports: { gate } }, async (fx) => {
    const p = await started(fx);
    const tip0 = await remoteLive(fx, p);
    await writeWork(p, 'pricing.py', py('pricing', ' # new price'));
    await writeWork(p, 'orders.py', py('orders', ' # uses price'));
    await roundsUntil(fx, () => withGuard(p, 'claim').length === 1, 'the claim PIN over CS1', 16);
    const pin = withGuard(p, 'claim')[0]!;
    assert.deepEqual(pin.paths, ['orders.py', 'pricing.py']);
    await writeWork(p, 'orders.py', py('orders', ' # uses price, v2'));
    await writeWork(p, 'reports.py', py('reports', ' # orders report'));
    await roundsUntil(fx, () => p.core.holds.get(pin.id)!.paths.length === 3, 'CS2 joins the PIN as a bundle', 16);
    await fx.rounds(4);
    assert.equal(await remoteLive(fx, p), tip0, 'nothing published while the claim holds');
    claimed = false;
    fx.advance(2_500);
    await p.engine.iterate();
    assert.deepEqual(p.core.holds.get(pin.id)!.guards, [], 'recordStep released claim:abcdefghij234567');
    await roundsUntil(fx, async () => (await remoteLive(fx, p)) !== tip0, 'the bundle published');
    const live = await remoteLive(fx, p);
    assert.equal((await p.core.repo.readCommit(live)).parents[0], tip0, 'one live commit');
    const changed = (await p.core.repo.run(['diff-tree', '--no-commit-id', '--name-only', '-r', tip0, live])).stdout.toString('utf8').trim().split('\n').sort();
    assert.deepEqual(changed, ['orders.py', 'pricing.py', 'reports.py'], 'the three files in one live commit');
  });
});

test('HLD-21: heldRanges(\'f.py\') is [[12, 12]] for an ON_DISK revert PATCH holding row 12 after the materializing iteration, stays so after a save until the next materialization, and is [] for a PIN path', T10, async () => {
  await withEngines('lh-ranges', { n: 2, files: FILES }, async (fx) => {
    const p = await started(fx);
    // The teammate changes row 12; a stale save puts the old row 12 back: the revert record holds the teammate's row on disk.
    const teamText = fpy(N, { replace: { 12: 'row_12 = team12' } });
    await fx.pushTeamChange({ 'f.py': buf(teamText) });
    await roundsUntil(fx, async () => (await readWork(p, 'f.py'))?.toString('utf8') === teamText, 'the teammate row applied');
    const rec = await humanRemovesTeamLine(fx, p, N);
    assert.deepEqual(p.engine.heldRanges('f.py'), [[12, 12]]);
    // A save that inserts a row above it: no materialization yet, the ranges stay those of the last materialized S_disk.
    await writeWork(p, 'f.py', `row_0 = 0\n${fpy(N)}`);
    fx.advance(2_500);
    await p.engine.iterate();
    assert.deepEqual(p.engine.heldRanges('f.py'), [[12, 12]], 'unchanged until the next materialization');
    fx.advance(21_000);
    await p.engine.iterate();
    assert.deepEqual(p.engine.heldRanges('f.py'), [[13, 13]], 'the next materialization moves the range with the row');
    assert.equal(p.core.holds.get(rec.id)!.state, 'ACTIVE');
    // A PIN path is withheld whole: no ranges.
    const A = await p.core.repo.readTreeMap(p.core.view!.base);
    await p.core.holds.hold({
      kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths: ['g.py'], guard: 'join', origin: 'human', cs_ids: [], displaced_by: null,
      blobs: { h0: { 'g.py': A.get('g.py')!.oid }, h1: { 'g.py': A.get('g.py')!.oid } },
    });
    await writeWork(p, 'g.py', fpy(12, { replace: { 7: 'g_7 = 77' } }).replace(/row_/g, 'g_'));
    fx.advance(2_500);
    await p.engine.iterate();
    fx.advance(21_000);
    await p.engine.iterate();
    assert.deepEqual(p.engine.heldRanges('g.py'), []);
    assert.deepEqual(p.engine.heldRanges('README.md'), []);
  });
});

test('HLD-22/23 data: records made by pinCs and shadowRecord keep origin <seat>/<agent> and cs_ids in the record and its op, and Engine declares no unacked member', T10, async () => {
  await withEngines('lh-pincs', { n: 2, files: FILES }, async (fx) => {
    const p = await started(fx);
    const seat = 'c'.repeat(32);
    const origin = `${seat}/agent_7`;
    const csId = `${seat}/3`;
    const A = await p.core.repo.readTreeMap(p.core.view!.base);
    const h1 = await p.core.repo.hashBytes(buf(fpy(12, { replace: { 2: 'g_2 = seat' } }).replace(/row_/g, 'g_')), true);
    const pin = await p.core.holds.hold(pinCs('claim:abcdefghij234567', [csId], ['g.py'], A, { 'g.py': h1 }, origin, 'pending_leftover'));
    const shadow = await p.core.holds.hold(shadowRecord('claim:abcdefghij234567', 'other.txt', A.get('other.txt')!.oid, h1, origin));
    for (const id of [pin, shadow]) {
      const r = p.core.holds.get(id)!;
      assert.equal(r.origin, origin, 'the record keeps origin <seat>/<agent>');
    }
    assert.deepEqual(p.core.holds.get(pin)!.cs_ids, [csId]);
    // The ops: mirrored through the loop's publish (board-only), folded with the same origin and cs_ids (HLD-22, HLD-23 data).
    await roundsUntil(fx, () => {
      const fold = foldPatch(p.core)?.fold ?? p.core.view!.fold;
      return fold !== null && fold.holds[pin] !== undefined && fold.holds[shadow] !== undefined;
    }, 'both ops folded');
    const fold = foldPatch(p.core)?.fold ?? p.core.view!.fold!;
    assert.equal(fold.holds[pin]!.origin, origin);
    assert.deepEqual(fold.holds[pin]!.cs_ids, [csId]);
    assert.equal(fold.holds[shadow]!.origin, origin);
    // X-13: the unacknowledged-item list is Plan 5's TurnItems.unacked; the Engine declares none.
    assert.equal(Reflect.get(p.engine, 'unacked'), undefined);
    assert.equal('unacked' in Engine.prototype, false);
  });
});

test('R3-30: a closure deferred by a lock for 50 s, then a daemon restart, gets its INCOMING record 60 s after the restart, and meta.pending keeps its rows while the record exists', T10, async () => {
  await withEngines('lh-r330', { n: 2, files: FILES }, async (fx) => {
    const p = await started(fx);
    await fx.rounds(2);   // the stat cache knows other.txt clean: the holder is met by the writer
    const release = p.fs.holdLock(workPath(p, 'other.txt'), 'share-none');
    try {
      await fx.pushTeamChange({ 'other.txt': buf('other 1\nother 2 team\nother 3\n') });
      await roundsUntil(fx, () => Object.hasOwn(p.core.view!.meta.pending, 'other.txt'), 'the closure deferred by the lock');
      const incoming = (): number => p.core.holds.nonTerminal().filter((r) => r.kind === 'INCOMING' && r.paths.includes('other.txt')).length;
      await fx.rounds(18);   // 45 s more: the closure is about 50 s old
      assert.equal(incoming(), 0, 'no record before 60 s');
      // A daemon restart: the 60 s clocks live in memory (TransientClocks) and start again.
      await restartEngine(p);
      assert.equal(incoming(), 0);
      await fx.rounds(20);   // 50 s after the restart: still none, although the deferral is now 100 s old
      assert.equal(incoming(), 0, 'the clock restarted at daemon start');
      await roundsUntil(fx, () => incoming() === 1, 'the INCOMING record 60 s after the restart', 6);
      const rec = p.core.holds.nonTerminal().find((r) => r.kind === 'INCOMING' && r.paths.includes('other.txt'))!;
      assert.deepEqual(rec.guards.map((g) => g.name), ['lock']);
      assert.ok(Object.hasOwn(p.core.view!.meta.pending, 'other.txt'), 'meta.pending keeps its row while the record exists (R-05)');
      await fx.rounds(2);
      assert.ok(Object.hasOwn(p.core.view!.meta.pending, 'other.txt'));
    } finally {
      release();
    }
    await roundsUntil(fx, async () => (await readWork(p, 'other.txt'))?.toString('utf8') === 'other 1\nother 2 team\nother 3\n', 'applied after the lock went');
    await fx.rounds(2);
    assert.equal(Object.hasOwn(p.core.view!.meta.pending, 'other.txt'), false);
    assert.equal(p.core.holds.nonTerminal().filter((r) => r.kind === 'INCOMING').length, 0, 'the record ended with the apply');
  });
});

test('every attachState is followed by an awaited attachCsTable, so a restart with a stale cache keeps the journaled orders and passing flags', T10, async () => {
  // Every ChangeSets.restore call of this test: attachCsTable passes the journaled table (or null), attachState alone passes none.
  const calls: Array<{ journaled: 'undefined' | 'null' | 'table' }> = [];
  const orig = ChangeSets.prototype.restore;
  ChangeSets.prototype.restore = function (this: ChangeSets, ...a: Parameters<ChangeSets['restore']>): void {
    calls.push({ journaled: a[2] === undefined ? 'undefined' : a[2] === null ? 'null' : 'table' });
    orig.apply(this, a);
  };
  try {
    await withEngines('lh-attach', { n: 2, files: FILES }, async (fx) => {
      await fx.startAll();
      assert.equal(calls.filter((c) => c.journaled !== 'undefined').length, 2, 'genesis and join each awaited attachCsTable');
      await fx.rounds(2);
      const p = fx.peers[0]!;
      const seat = 'a'.repeat(32);
      // Seat A's open CS on f.py and g.py stays uncovered; the human edits g.py too and other.txt: the human CS's capture shares g.py
      // with the open seat CS, so its pair is not passing (HLD-39); A's f.py delta stays outside every pair.
      await writeWork(p, 'f.py', fpy(N, { replace: { 3: 'row_3 = seat' } }));
      await writeWork(p, 'g.py', fpy(12, { replace: { 2: 'g_2 = seat' } }).replace(/row_/g, 'g_'));
      await fx.signal(0, { kind: 'effect', seat, agent: null, toolUseId: 'toolu_1', paths: ['f.py', 'g.py'], turnOrigin: 'prompt' });
      await fx.signal(0, { kind: 'activity', seat, activity: 'MID_TURN' });
      fx.advance(2_500);
      await p.engine.iterate();
      await writeWork(p, 'g.py', fpy(12, { replace: { 2: 'g_2 = seat', 9: 'g_9 = human' } }).replace(/row_/g, 'g_'));
      await writeWork(p, 'other.txt', 'other 1 human\nother 2\nother 3\n');
      fx.advance(2_500);
      await p.engine.iterate();
      // The kill: the cache as it was before the capturing state commit (written by the iteration before it) stays.
      const cacheFile = join(p.deps.paths.coworkDir, 'cs', `${enc(p.deps.branch)}.json`);
      const stale = await readFile(cacheFile);
      fx.advance(21_000);
      await p.engine.iterate();   // the human CS closes: one capturing state commit
      const journaled = (await readCsTable(p.core.repo, p.core.view!))!;
      const human = Object.keys(journaled.orders).find((id) => !id.startsWith(seat));
      assert.ok(human !== undefined, `a human pair journaled: ${JSON.stringify(journaled)}`);
      assert.equal(journaled.passing[human], false, 'not passing: the open seat CS in its group is uncovered');
      // Seat A, still open, edits f.py again: a delta outside every pair (the group capture gave A's CS a pair of its own paths).
      await writeWork(p, 'f.py', fpy(N, { replace: { 3: 'row_3 = seat, again' } }));
      await writeFile(cacheFile, stale);   // killed after the state commit, before writeCsCache
      assert.equal(await readCsCache(p.core), null, 'the cache names an older state commit');
      // The restart: before the first iteration, the table has the journaled orders, next_order and passing; the open-CS deltas
      // (seat A's newer f.py, its membership lost with the cache) form one recovered CS.
      await restartEngine(p);
      assert.equal(calls[calls.length - 1]!.journaled, 'table', 'restart awaited attachCsTable with the journaled table');
      const ins = await p.engine.inspect();
      assert.deepEqual(ins.csTable.orders, journaled.orders);
      assert.equal(ins.csTable.next_order, journaled.next_order);
      assert.deepEqual(ins.csTable.passing, journaled.passing, 'a non-passing pair stays non-passing');
      assert.equal(ins.csTable.cs.filter((e) => e.kind === 'recovered').length, 1, `one recovered CS: ${JSON.stringify(ins.csTable.cs)}`);
      // The first tick after the reseed reports the deltas: seat A's f.py (outside every pair) joins the recovered CS; g.py, whose
      // change the journaled human pair carries, joins nothing.
      fx.advance(2_500);
      await p.engine.iterate();
      const recovered = p.core.cs.table().cs.filter((e) => e.kind === 'recovered');
      assert.equal(recovered.length, 1);
      assert.deepEqual(recovered[0]!.paths, ['f.py'], 'the open seat CS\'s delta outside every pair is in it');
      // A lost-state rebuild (the state ref gone while this core was live: restart's lost path) and a re-anchor's rebuild each await
      // attachCsTable too.
      const before = calls.length;
      await gitIn(p, ['update-ref', '-d', p.core.refs.state]);
      const rep = await restart(p.core);
      assert.ok(rep.lostState !== null, 'a lost-state rebuild');
      assert.ok(calls.slice(before).some((c) => c.journaled !== 'undefined'), 'the lost-state rebuild awaited attachCsTable');
      const before2 = calls.length;
      await lostStateRebuild(p.core, (await remoteBoardTip(fx)) as Oid, 're_anchor', undefined, { displaced: [] });
      assert.ok(calls.slice(before2).some((c) => c.journaled !== 'undefined'), 'the re-anchor rebuild awaited attachCsTable');
    });
  } finally {
    ChangeSets.prototype.restore = orig;
  }
});

test('CS_UNPUBLISHED_NUDGE fires once per open seat CS 300 s after its oldest uncovered effect, and CS_GROUP_WAITING once per group episode after 10 min unpublished with a ready member; neither publishes anything', T10, async () => {
  await withEngines('lh-nudge', { n: 2, files: FILES }, async (fx) => {
    const p = await started(fx);
    const log = logOf(p);
    const A = 'a'.repeat(32);
    const B = 'b'.repeat(32);
    const tip0 = await remoteLive(fx, p);
    // Seat A edits g.py and stays MID_TURN with its effect uncovered (no checkpoint, no stop).
    await writeWork(p, 'g.py', fpy(12, { replace: { 2: 'g_2 = A' } }).replace(/row_/g, 'g_'));
    await fx.signal(0, { kind: 'effect', seat: A, agent: null, toolUseId: 'toolu_a1', paths: ['g.py'], turnOrigin: 'prompt' });
    await fx.signal(0, { kind: 'activity', seat: A, activity: 'MID_TURN' });
    // Seat B edits g.py's other end and other.txt, then stops: its CS is captured, ready but not publishable (A shares g.py).
    await writeWork(p, 'g.py', fpy(12, { replace: { 2: 'g_2 = A', 10: 'g_10 = B' } }).replace(/row_/g, 'g_'));
    await writeWork(p, 'other.txt', 'other 1 B\nother 2\nother 3\n');
    await fx.signal(0, { kind: 'effect', seat: B, agent: null, toolUseId: 'toolu_b1', paths: ['g.py', 'other.txt'], turnOrigin: 'prompt' });
    await fx.signal(0, { kind: 'stop', seat: B });
    assert.ok(p.core.cs.ready().some((r) => r.csId.startsWith(B)), 'B\'s CS is captured');
    const nudges = (): Array<Record<string, unknown>> => log.lines.filter((l) => l.code === 'CS_UNPUBLISHED_NUDGE').map((l) => l.params);
    const waits = (): Array<Record<string, unknown>> => log.lines.filter((l) => l.code === 'CS_GROUP_WAITING').map((l) => l.params);
    // 290 s: no nudge yet; past 300 s: exactly one for A's CS.
    await fx.rounds(29, 10_000);
    assert.deepEqual(nudges(), [], 'not before 300 s');
    await fx.rounds(2, 10_000);
    const aCs = p.core.cs.table().cs.find((e) => e.seat === A && e.state === 'open')!.cs_id;
    assert.deepEqual(nudges(), [{ cs: aCs, n: 1 }], 'once, for A\'s open CS');
    // 600 s after B's ready member waited: one CS_GROUP_WAITING naming the open seat A.
    await fx.rounds(28, 10_000);
    assert.equal(waits().length, 0, 'not before 10 min');
    await fx.rounds(3, 10_000);
    assert.equal(waits().length, 1, 'once per group episode');
    assert.equal(waits()[0]!['seats'], A);
    await fx.rounds(10, 10_000);
    assert.equal(nudges().length, 1, 'still once');
    assert.equal(waits().length, 1, 'still once');
    assert.equal(await remoteLive(fx, p), tip0, 'neither nudge publishes anything');
    // A's stop ends the episode: the group publishes in one commit.
    await fx.signal(0, { kind: 'stop', seat: A });
    await roundsUntil(fx, async () => (await remoteLive(fx, p)) !== tip0, 'the group published after A\'s stop');
  });
});

// R3-53's name: `src/old:v2.py` (a colon fails SEC-35's validPathSyntax) on Linux and macOS; on a Windows host, where no file name can
// hold a colon, an NFD spelling (also not stageable: record paths are NFC, glossary §9) stands in for it.
const BAD = process.platform === 'win32' ? 'src/old\u{d55c}v2.py'.normalize('NFD') : 'src/old:v2.py';

test('R3-53 in status: a blocked non-portable path and every path of the human group it keeps back are in not_converged, and PATH_NOT_PORTABLE is the status message until the name is fixed', T10, async () => {
  const files = { ...FILES, 'src/old.py': buf('old 1\nold 2\n'), 'src/other.py': buf('other 1\nother 2\n') };
  await withEngines('lh-r353', { n: 2, files }, async (fx) => {
    const p = await started(fx);
    const tip0 = await remoteLive(fx, p);
    await rename(workPath(p, 'src/old.py'), workPath(p, BAD));
    await writeWork(p, 'src/other.py', 'other 1\nother 2 edited\n');
    let s = await statusOf(p);
    for (let i = 0; i < 2 && !s.pending.not_converged.includes('src/old.py'); i++) {
      fx.advance(2_500);
      await p.engine.iterate();
      s = await statusOf(p);
    }
    assert.ok([BAD, 'src/old.py', 'src/other.py'].every((q) => s.pending.not_converged.includes(q)), JSON.stringify(s.pending.not_converged));
    const why = (await p.engine.inspect()).notConvergedWhy!;
    assert.equal(why['src/old.py']?.cause, 'blocked_publish');
    assert.equal(why['src/other.py']?.cause, 'blocked_publish');
    assert.equal(s.state, 'degraded');
    assert.equal(s.message_code, 'PATH_NOT_PORTABLE');
    assert.deepEqual(Object.keys(s.message_params).sort(), ['path', 'rule']);
    assert.equal(s.message_params['path'], BAD);
    fx.advance(21_000);
    await fx.rounds(3);
    assert.equal(await remoteLive(fx, p), tip0, 'the gate keeps the human CS back: the deletion is never published alone');
    assert.equal((await statusOf(p)).message_code, 'PATH_NOT_PORTABLE', 'until the name is fixed');
    // The rename to a portable name: the group publishes in one commit and every path leaves not_converged within 2 iterations.
    await rename(workPath(p, BAD), workPath(p, 'src/old_v2.py'));
    await roundsUntil(fx, async () => (await remoteLive(fx, p)) !== tip0, 'the landed publish', 16);
    const live = await remoteLiveFiles(fx, p);
    assert.equal(live.has('src/old.py'), false);
    assert.equal(live.get('src/old_v2.py'), 'old 1\nold 2\n');
    assert.equal(live.get('src/other.py'), 'other 1\nother 2 edited\n');
    for (let i = 0; i < 2 && (await statusOf(p)).pending.not_converged.length > 0; i++) {
      fx.advance(2_500);
      await p.engine.iterate();
    }
    assert.deepEqual((await statusOf(p)).pending.not_converged, [], 'gone within 2 iterations of the landed publish');
    // The gate is open again for later human work: an edit of another file while a second one is still being edited publishes at its
    // own close, never waiting on a CS opened after the fix.
    const tip1 = await remoteLive(fx, p);
    await writeWork(p, 'g.py', fpy(12, { replace: { 7: 'g_7 = later' } }).replace(/row_/g, 'g_'));
    fx.advance(2_500);
    await p.engine.iterate();
    fx.advance(21_000);
    await p.engine.iterate();   // g.py's CS closes and is captured
    await writeWork(p, 'other.txt', 'other 1\nother 2\nother 3 still typing\n');   // a new human CS opens
    await roundsUntil(fx, async () => (await remoteLive(fx, p)) !== tip1, 'the later edit published while another human CS is open', 4);
    assert.equal((await remoteLiveFiles(fx, p)).get('g.py'), fpy(12, { replace: { 7: 'g_7 = later' } }).replace(/row_/g, 'g_'));
  });
});

test('the Task 9 and Task 11 carries: Engine.signal never runs inside a start, a restart or a resolve, so their observe() calls never drop a seat\'s claim, and the first tick after a restart copies no ready pair\'s captured change into a human CS', T10, async () => {
  await withEngines('lh-claims', { n: 2, files: FILES }, async (fx) => {
    const p = await started(fx);
    const A = 'a'.repeat(32);
    const effectOf = (paths: string[], n: number): Parameters<EngineFixture['signal']>[1] => ({ kind: 'effect', seat: A, agent: null, toolUseId: `toolu_c${n}`, paths, turnOrigin: 'prompt' });
    // The paths of the open human and recovered CSs, read from ChangeSets' memory (a human CS before its first capture has no cs_id and
    // no table entry).
    const humanOpen = (): string[] => (Reflect.get(p.core.cs, 'css') as Array<{ kind: string; state: string; paths: Set<string> }>)
      .filter((c) => c.kind !== 'seat' && c.state === 'open').flatMap((c) => [...c.paths]).sort();
    // Seat A's change of g.py is captured at its stop and not published yet (a fresh teammate tip closes that iteration's window).
    await writeWork(p, 'g.py', fpy(12, { replace: { 8: 'g_8 = A1' } }).replace(/row_/g, 'g_'));
    await fx.signal(0, effectOf(['g.py'], 1));
    await fx.pushTeamChange({ 'other.txt': buf('other 1\nother 2 team\nother 3\n') });
    await fx.signal(0, { kind: 'stop', seat: A });
    assert.deepEqual(p.core.view!.ready.map((r) => [r.csId, r.paths]), [[`${A}/1`, ['g.py']]], 'A/1 journaled, unpublished');
    // A daemon restart, with A's next effect (on f.py) signalled while start() runs: it is queued behind the start, so the restart's
    // restore and R-01 re-form never see (or drop) its claim, and the first tick attributes f.py to A's CS.
    const fresh = await Engine.create(p.deps);
    p.core = fresh.core;
    p.engine = fresh;
    await writeWork(p, 'f.py', fpy(N, { replace: { 5: 'row_5 = A2' } }));
    const [r] = await Promise.all([fresh.start({ publishLocal: null }), fresh.signal(effectOf(['f.py'], 2))]);
    assert.ok(r.ok && r.mode === 'restart', JSON.stringify(r));
    fx.advance(2_500);
    await p.engine.iterate();   // the first tick after the reseed reports g.py (A/1's captured change) and f.py
    const a2 = p.core.cs.table().cs.find((e) => e.seat === A && e.state === 'open');
    assert.ok(a2 !== undefined && a2.paths.includes('f.py'), `the claim survived the restart: ${JSON.stringify(p.core.cs.table().cs)}`);
    assert.deepEqual(humanOpen(), [], 'no human CS took f.py or A/1\'s already-captured g.py');
    // A resolve between a signal and the next tick: its own prepareIteration's tick honours the claim before --publish's observe().
    await fx.pushTeamChange({ 'f.py': buf(fpy(N, { after: { 20: 'TEAM_R = 1' } })) });
    await roundsUntil(fx, async () => (await readWork(p, 'f.py'))?.toString('utf8') === fpy(N, { after: { 20: 'TEAM_R = 1' }, replace: { 5: 'row_5 = A2' } }), 'the teammate line merged under A\'s row');
    const rec = await humanRemovesTeamLine(fx, p, N, { replace: { 5: 'row_5 = A2' } });
    await fx.rounds(2);
    await writeWork(p, 'other.txt', 'other 1\nother 2 team\nother 3 A\n');
    await fx.signal(0, effectOf(['other.txt'], 3));
    assert.equal((await fx.resolve(0, rec.id, 'publish')).kind, 'done');
    const a = p.core.cs.table().cs.find((e) => e.seat === A && e.state === 'open');
    assert.ok(a !== undefined && a.paths.includes('other.txt'), `the claim survived the resolve: ${JSON.stringify(p.core.cs.table().cs)}`);
    assert.equal(humanOpen().includes('other.txt'), false, 'other.txt is not in a human CS');
    assert.ok(humanOpen().includes('f.py'), '--publish put the record\'s path into the human CS (Table 4)');
  });
});
