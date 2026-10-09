// Publish paths no other test reaches (Task 14 round 1, finding 12): every publishStep gate, resolvePushIntent's deferred-view
// guard and its discard branch, governedPush's probe-delete body, its foreign-ref refusal and its own window gate, the intent
// cleared after a denial, applyPushOk's A_cap guard, the P2-PIN skip in the composition with the HLD-41 rebase of the skipped
// pair at the landed update, publishPending, a watchdog-killed push as slow_push, publish.sent before the classify fetch, and
// "a 429 is a failed fetch". Each test is shaped so that removing the line it covers changes what it observes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OpDraft } from '../../src/board/ops.js';
import type { IterationCtx } from '../../src/engine/core.js';
import { governedPush, publishPending, publishStep, resolvePushIntent, type AttemptClass } from '../../src/engine/publish.js';
import { ABSENT, parseOid } from '../../src/git/oid.js';
import { pushSpec, runPush } from '../../src/git/push.js';
import { setCrashHandler } from '../../src/ports/crashpoint.js';
import { LEASE_STOP_SYNC_MS } from '../../src/ports/lease.js';
import { gitCallsOf, writeWork, type PeerFixture } from '../helpers/coreFixture.js';
import {
  blobText, buf, captureReady, editAndCapture, failedResult, lines, prep, pushCalls, remoteBoard, stateA, treeOf, withCores, wrapGit,
} from '../helpers/publishHelpers.js';

const ts = (name: string): string => lines(12, (i) => `export const ${name}${i} = ${i};`);
function withRow(text: string, i: number, row: string): string {
  const rs = text.split('\n');
  rs[i - 1] = row;
  return rs.join('\n');
}
const FILES: Record<string, Buffer> = {
  'README.md': buf('# gates fixture\n'),
  'src/a.ts': buf(ts('a')),
  'src/x.ts': buf(ts('x')),
  'src/y.ts': buf(ts('y')),
};
const HTTP_429 = 'error: RPC failed; HTTP 429 curl 22 The requested URL returned error: 429\n';
const freezeEvent = (): OpDraft => ({ type: 'event', cid: '', kind: 'freeze', refs: [], reason_code: 'FREEZE_EPOCH' });
let edits = 0;
const nextEdit = (): Record<string, string> => ({ 'src/a.ts': withRow(ts('a'), 3, `export const a3 = ${1000 + ++edits};`) });

/** Fetch and ls-remote answer nothing (exit 128, `stderr`) while `on.blind`. */
function blindFetch(p: PeerFixture, stderr = 'fatal: unable to access the remote\n'): { blind: boolean } {
  const on = { blind: false };
  wrapGit(p, async (args, opts, inner) => {
    if (on.blind && (args[0] === 'fetch' || args[0] === 'ls-remote')) return failedResult(128, stderr);
    return inner(args, opts);
  });
  return on;
}

// ---- the gates of publishStep (one subtest per gate; each skips the iteration that publishes without it) ----------

test('publishStep gates: each stops an iteration that publishes without it', async (t) => {
  await withCores('gates-all', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const fetch = blindFetch(p);
    let it: IterationCtx = (await editAndCapture(fx, p, nextEdit())).it;
    const skipped = async (x: IterationCtx, why: string): Promise<void> => {
      const r = await publishStep(p.core, x);
      assert.deepEqual([r.attempted, r.outcome, r.why], [false, 'skipped', why], JSON.stringify(r));
      assert.equal(pushCalls(p), 0, 'no push');
      assert.equal(p.core.view!.intent.kind === 'push', false, 'no push intent');
    };
    await t.test('a failed fetch (no publish in an iteration whose fetch failed)', async () => {
      fetch.blind = true;
      const failed = await prep(p);
      fetch.blind = false;
      assert.equal(failed.fetched?.ok, false);
      await skipped(failed, 'fetch_failed');
    });
    fx.advance(31_000);   // past the fetch backoff
    it = await prep(p, true);
    await t.test('no board tip', async () => skipped({ ...it, T: ABSENT }, 'no_board'));
    await t.test('a journaled intent other than a push', async () => {
      await p.core.commit({ intent: { kind: 'local', origin: 'human', entries: [] } });
      await skipped(it, 'intent');
      await p.core.commit({ intent: { kind: 'none' } });
    });
    await t.test('a stranded restore (P2-NARROW: no new intent)', async () => {
      p.core.writer.strandedPaths = () => ['src/a.ts'];
      try {
        await skipped(it, 'stranded');
      } finally {
        Reflect.deleteProperty(p.core.writer, 'strandedPaths');
      }
    });
    await t.test('a failed snapshot', async () => {
      await skipped({ ...it, tick: null }, 'snapshot_failed');
      await skipped({ ...it, tick: { ...it.tick!, failed: true } }, 'snapshot_failed');
    });
    await t.test('a filter failure in the tick or the materialization (P2-SNAPFILTERS)', async () => {
      await skipped({ ...it, tick: { ...it.tick!, publishBlocked: true } }, 'filter_failure');
      await skipped({ ...it, mat: { ...it.mat!, publishBlocked: true } }, 'filter_failure');
    });
    // CCI-50 (Task 17 ruling): without a lease for 2 min the loop takes no new capture, but the ready pairs captured
    // before still flush — publishStep composes only already-captured pairs, so the stopped lease gates nothing here.
    await t.test('the same iteration without a gate condition publishes, also without a lease for 2 min (the flush)', async () => {
      const r = await publishStep(p.core, { ...it, leaseIdleMs: LEASE_STOP_SYNC_MS });
      assert.equal(r.outcome, 'landed', JSON.stringify(r));
    });
  });
});

test('a 429 is a failed fetch: its throttle signal is taken before the failed-fetch gate (fallback entered, nothing published)', async () => {
  await withCores('gates-429-failed', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await editAndCapture(fx, p, nextEdit());
    const fetch = blindFetch(p, HTTP_429);
    fetch.blind = true;
    const it = await prep(p);
    fetch.blind = false;
    assert.deepEqual([it.fetched?.ok, it.fetched?.httpThrottle], [false, 'http_429']);
    assert.equal(p.core.governor.mode(), 'normal');
    const r = await publishStep(p.core, it);
    assert.deepEqual([r.outcome, r.why], ['skipped', 'fetch_failed']);
    assert.equal(p.core.governor.mode(), 'fallback', 'the failed fetch\'s 429 entered the fallback');
    assert.equal(p.core.governor.fallbackSource(), 'http_429');
    assert.equal(pushCalls(p), 0);
  });
});

// ---- resolvePushIntent -------------------------------------------------------------------------------------------

/** The push reaches the server (or not, when `lands` is false); the client sees no porcelain line and the classify fetch fails. */
function lostClassification(p: PeerFixture, lands: boolean): { phase: 'push' | 'blind' | 'off' } {
  const s = { phase: 'push' as 'push' | 'blind' | 'off' };
  wrapGit(p, async (args, opts, inner) => {
    if (s.phase === 'push' && args[0] === 'push') {
      s.phase = 'blind';
      if (lands) await inner(args, opts);
      return failedResult(-1, 'error: killed\n');
    }
    if (s.phase === 'blind' && (args[0] === 'fetch' || args[0] === 'ls-remote')) return failedResult(128, 'fatal: unable to access the remote\n');
    return inner(args, opts);
  });
  return s;
}

test('resolvePushIntent never resolves from a deferred view (its tip may predate the push): the landed intent is kept', async () => {
  await withCores('gates-resolve-deferred', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const s = lostClassification(p, true);
    const { it } = await editAndCapture(fx, p, nextEdit());
    const r = await publishStep(p.core, it);
    assert.deepEqual([r.outcome, r.why], ['network', 'unobserved']);
    s.phase = 'off';
    // The iteration's own view predates the push (board T, the lease): as a deferred view it must not be read.
    const stale: IterationCtx = { ...it, fetched: { ...it.fetched!, deferred: true } };
    const res = await resolvePushIntent(p.core, stale);
    assert.deepEqual([res.outcome, res.why], ['skipped', 'intent_unresolved']);
    assert.equal(p.core.view!.intent.kind, 'push', 'kept (a discard here would publish the change twice)');
    fx.advance(31_000);
    const landed = await resolvePushIntent(p.core, await prep(p));
    assert.deepEqual([landed.outcome, landed.bnew], ['landed', r.bnew]);
  });
});

test('resolvePushIntent discards an intent whose Bnew is not on the fetched chain; the next window publishes the change once', async () => {
  await withCores('gates-resolve-discard', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const s = lostClassification(p, false);   // the push never reaches the server
    const T0 = await remoteBoard(fx, p);
    const { it } = await editAndCapture(fx, p, nextEdit());
    const r = await publishStep(p.core, it);
    assert.deepEqual([r.outcome, r.why], ['network', 'unobserved']);
    s.phase = 'off';
    fx.advance(31_000);
    const it2 = await prep(p);
    assert.equal(it2.T, T0, 'the board did not move');
    const res = await resolvePushIntent(p.core, it2);
    assert.deepEqual([res.outcome, res.why], ['skipped', 'resolved']);
    const view = p.core.view!;
    assert.deepEqual([view.intent.kind, view.t.size, view.ready.length], ['none', 0, 1], 'discarded; the pair waits');
    fx.advance(6_000);
    const again = await publishStep(p.core, await prep(p));
    assert.equal(again.outcome, 'landed', JSON.stringify(again));
    assert.notEqual(again.bnew, r.bnew);
    assert.equal((await p.core.repo.readCommit(again.bnew!)).parents[0], T0, 'one publish on top of the unchanged board');
  });
});

// ---- governedPush --------------------------------------------------------------------------------------------------

test('governedPush: a deleteProbe body deletes the own probe ref (counted, traced); a foreign probe ref is refused before counting; its own window gate denies', async () => {
  await withCores('gates-governed', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prep(p);
    const probe = p.core.refs.probe(p.core.peerId);
    const X = p.core.view!.laC;
    const made = await runPush(p.core.repo, fx.remote.url, [pushSpec(X, probe, ABSENT)], []);
    assert.equal(made.statuses.get(probe), 'ok');
    const before = p.core.pushAttempts;
    const classify = async (): Promise<AttemptClass> => ({ outcome: 'ok', transient: false, landed: false });
    const del = await governedPush(p.core, 'probe', { deleteProbe: { ref: probe, lease: X } }, true, 1, classify);
    assert.ok(del !== 'denied');
    assert.equal(del.raw.statuses.get(probe), 'ok');
    assert.equal((await fx.remote.refs())[probe], undefined, 'the probe ref is gone');
    assert.equal(p.core.pushAttempts, before + 1, 'counted');
    const traced = fx.trace.ofKind('push').at(-1)!;
    assert.deepEqual([traced.purpose, traced.outcome], ['probe', 'ok']);
    // Another peer's probe ref: refused before the gate counts anything.
    const other = p.core.refs.probe('0123456789abcdef0123456789abcdef');
    const calls = pushCalls(p);
    await assert.rejects(governedPush(p.core, 'probe', { deleteProbe: { ref: other, lease: X } }, true, 1, classify), /not this peer's probe ref/);
    assert.deepEqual([p.core.pushAttempts, pushCalls(p)], [before + 1, calls]);
    // Not exempt, right after an attempt: the G_eff spacing denies it (traced, not counted, nothing spawned).
    const denied = await governedPush(p.core, 'board_only', { specs: [pushSpec(X, p.core.refs.remoteCode, X)] }, false, 1, classify);
    assert.equal(denied, 'denied');
    assert.deepEqual([p.core.pushAttempts, pushCalls(p)], [before + 1, calls]);
    assert.equal(fx.trace.ofKind('push').at(-1)!.outcome, 'denied');
  });
});

test('a push denied by governedPush after the intent was journaled clears the intent (nothing pushed, the pair waits)', async () => {
  await withCores('gates-denied-intent', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { it } = await editAndCapture(fx, p, nextEdit());
    // Between the intent and the push, a fetch observes a new tip: the window closes (the anchor moved).
    fx.scheduler.onYield = async (name) => {
      if (name === 'publish.beforePush') p.core.governor.onFetch(parseOid('1'.repeat(40)), 1, false, true);
    };
    const r = await publishStep(p.core, it);
    fx.scheduler.onYield = null;
    assert.deepEqual([r.attempted, r.outcome, r.why], [false, 'skipped', 'window'], JSON.stringify(r));
    assert.deepEqual([p.core.view!.intent.kind, p.core.view!.t.size], ['none', 0], 'the journaled intent is cleared');
    assert.equal(pushCalls(p), 0);
    assert.equal(p.core.view!.ready.length, 1);
  });
});

// ---- applyPushOk's A_cap guard ------------------------------------------------------------------------------------------

test('applyPushOk moves A[p] to C[p] only where A[p] is unchanged since the capture (A_cap): an A moved after the composition stays', async () => {
  await withCores('gates-acap', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const X_LOCAL = withRow(ts('x'), 2, 'export const x2 = 22;');
    const Y_LOCAL = withRow(ts('y'), 2, 'export const y2 = 22;');
    const { it } = await editAndCapture(fx, p, { 'src/x.ts': X_LOCAL, 'src/y.ts': Y_LOCAL });
    const moved = await p.core.repo.hashBytes(buf(withRow(ts('x'), 9, 'export const x9 = 99; // moved')), true);
    fx.scheduler.onYield = async (name) => {
      if (name !== 'publish.beforePush') return;
      // A[x] moves after the composition (as an update of the state between capture and landing would).
      const view = p.core.view!;
      const base = await p.core.repo.editTree(view.base, [{ path: 'src/x.ts', mode: '100644', oid: moved }], join(p.deps.paths.coworkDir, 'tmp', 'test-acap.index'));
      await p.core.commit({ base });
    };
    const mark = fx.trace.events.length;
    const r = await publishStep(p.core, it);
    fx.scheduler.onYield = null;
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    const C = await treeOf(p, r.c!);
    const A = await stateA(p);
    assert.equal(await blobText(p, C, 'src/x.ts'), X_LOCAL, 'C carries the captured edit');
    assert.equal(A.get('src/x.ts')?.oid, moved, 'A_cap[x] ≠ A[x]: A keeps its newer entry');
    assert.equal(A.get('src/y.ts')?.oid, C.get('src/y.ts')?.oid, 'A_cap[y] == A[y]: A := C[y]');
    const aSet = fx.trace.since(mark).filter((e) => e.kind === 'A_set').map((e) => (e.kind === 'A_set' ? e.path : ''));
    assert.deepEqual(aSet, ['src/y.ts']);
  });
});

// ---- P2-PIN in the composition, HLD-41 at the landed update ----------------------------------------------------------

test('P2-PIN: a ready pair touching a held PIN is skipped by the composition and stays journaled; the landed update rebases it (HLD-41) through tmp/r.index (P2-SCRATCHLOCK)', async () => {
  await withCores('gates-pin-rebase', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const A0 = await stateA(p);
    const X1 = withRow(ts('x'), 2, 'export const x2 = 20; // first');
    const X2 = withRow(X1, 9, 'export const x9 = 90; // second');
    const Y2 = withRow(ts('y'), 5, 'export const y5 = 50;');
    const { pair: pair1 } = await editAndCapture(fx, p, { 'src/x.ts': X1 });
    const { pair: pair2, it } = await editAndCapture(fx, p, { 'src/x.ts': X2, 'src/y.ts': Y2 });
    assert.deepEqual(pair2.paths, ['src/x.ts', 'src/y.ts']);
    const localY = (await p.core.repo.readTreeMap(pair2.R)).get('src/y.ts')!.oid;
    await p.core.holds.hold({
      kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths: ['src/y.ts'], blobs: { h0: { 'src/y.ts': A0.get('src/y.ts')!.oid }, h1: { 'src/y.ts': localY } },
      guard: 'join', origin: 'human', cs_ids: [], displaced_by: null, local_only: false,
    });
    await writeFile(`${p.core.scratch('r')}.lock`, '');   // a leftover lock of the rebase's scratch index
    const r = await publishStep(p.core, it);
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    const C = await treeOf(p, r.c!);
    assert.equal(await blobText(p, C, 'src/x.ts'), X1, 'only pair 1 is published (pair 2 is skipped whole)');
    assert.equal(C.get('src/y.ts')?.oid, A0.get('src/y.ts')!.oid);
    const view = p.core.view!;
    assert.deepEqual(view.ready.map((x) => x.csId), [pair2.csId], 'the skipped pair stays journaled');
    assert.ok(!view.ready.some((x) => x.csId === pair1.csId));
    const A = await stateA(p);
    assert.equal(A.get('src/x.ts')?.oid, C.get('src/x.ts')?.oid, 'A := C[x]');
    const rebased = view.ready[0]!;
    assert.equal((await p.core.repo.readTreeMap(rebased.A)).get('src/x.ts')?.oid, A.get('src/x.ts')?.oid, 'HLD-41: A_cap[x] := A_new[x]');
    assert.equal(await blobText(p, await p.core.repo.readTreeMap(rebased.R), 'src/x.ts'), X2, 'R[x] keeps both edits');
  });
});

// ---- publishPending (PRO-42) ---------------------------------------------------------------------------------------------

test('publishPending: allowed ops, or ready pairs whose P differs from A (a base mismatch reads as pending); never code outside the ok state', async () => {
  await withCores('gates-pending', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    let it = await prep(p);
    assert.equal(await publishPending(p.core, it), false, 'nothing queued');
    p.core.outbox.add(freezeEvent());
    assert.equal(await publishPending(p.core, it), true, 'an allowed op');
    assert.equal(await publishPending(p.core, { ...it, pushStates: ['offline'] }), false, 'an op no active state allows');
    p.core.outbox.drop(() => true);
    // A pair whose edit was reverted before the close: P == A.
    await writeWork(p, 'src/a.ts', withRow(ts('a'), 4, 'export const a4 = 44;'));
    await prep(p);
    await writeWork(p, 'src/a.ts', ts('a'));
    await prep(p);
    fx.advance(20_000);
    it = await prep(p, true);
    await captureReady(p, it);
    assert.equal(await publishPending(p.core, it), false, 'a ready pair with P == A');
    it = (await editAndCapture(fx, p, { 'src/x.ts': withRow(ts('x'), 3, 'export const x3 = 33;') })).it;
    assert.equal(await publishPending(p.core, it), true, 'P differs from A');
    assert.equal(await publishPending(p.core, { ...it, pushStates: ['frozen'] }), false, 'no code while frozen');
    p.core.outbox.add(freezeEvent());
    assert.equal(await publishPending(p.core, { ...it, pushStates: ['frozen'] }), true, 'a freeze event may leave while frozen');
    p.core.outbox.drop(() => true);
    // A moved under the ready pair: composeP refuses (ENG-39), which reads as pending (the publish reports it).
    const moved = await p.core.repo.hashBytes(buf(withRow(ts('x'), 9, 'export const x9 = 999; // moved')), true);
    assert.notEqual(moved, (await stateA(p)).get('src/x.ts')?.oid);
    const base = await p.core.repo.editTree(p.core.view!.base, [{ path: 'src/x.ts', mode: '100644', oid: moved }], join(p.deps.paths.coworkDir, 'tmp', 'test-pending.index'));
    await p.core.commit({ base });
    assert.equal(await publishPending(p.core, await prep(p)), true, 'a base mismatch is pending');
  });
});

// ---- push signals and ordering ----------------------------------------------------------------------------------------------

test('a push killed by the watchdog is a slow_push throttle signal (the fallback starts)', async () => {
  await withCores('gates-killed', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    wrapGit(p, async (args, opts, inner) => {
      const r = await inner(args, opts);
      return args[0] === 'push' ? { ...r, killedByWatchdog: true } : r;
    });
    const { it } = await editAndCapture(fx, p, nextEdit());
    const r = await publishStep(p.core, it);
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    assert.equal(p.core.governor.mode(), 'fallback');
    assert.equal(p.core.governor.fallbackSource(), 'slow_push');
  });
});

test('publish.sent fires after the push returned and before the classify step\'s fresh fetch', async () => {
  await withCores('gates-sent-order', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    wrapGit(p, async (args, opts, inner) => {
      const r = await inner(args, opts);   // the server accepts
      return args[0] === 'push' ? failedResult(-1, 'error: killed\n') : r;   // no porcelain line: a fresh fetch classifies
    });
    const { it } = await editAndCapture(fx, p, nextEdit());
    const fetches = (): number => gitCallsOf(p).filter((c) => c.args[0] === 'fetch').length;
    const before = fetches();
    const seen: Array<{ fetches: number; pushes: number }> = [];
    setCrashHandler((name) => {
      if (name === 'publish.sent') seen.push({ fetches: fetches(), pushes: pushCalls(p) });
    });
    let r;
    try {
      r = await publishStep(p.core, it);
    } finally {
      setCrashHandler(null);
    }
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    assert.deepEqual(seen, [{ fetches: before, pushes: 1 }], 'publish.sent: the push returned, no classify fetch yet');
    assert.equal(fetches(), before + 1, 'the classify fetch ran after publish.sent');
  });
});

