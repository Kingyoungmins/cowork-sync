// Task 14 carries handled in the Task 15 fix round (rulings in progress.md, "Task 14: Ruling (carry to Task 15 fix
// round …)"): the governor's allowed-pending flag counts no P2-PIN-skipped pair, the capture resets its scratch index
// before writeTreeMap's read-tree (P2-SCRATCHLOCK), and a failing scratch reset inside publishStep is a build failure,
// never an exception. EngineCores over real clones of a file:// remote; git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ScratchResetError } from '../../src/engine/diskEq.js';
import { publishStep, resolvePushIntent } from '../../src/engine/publish.js';
import { startDispatch } from '../../src/engine/start.js';
import { writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { blobText, buf, captureReady, editAndCapture, LogRecorder, prep, pushCalls, remoteBoard, stateA, treeOf, withCores } from '../helpers/publishHelpers.js';
import { restartCore } from '../helpers/startFixture.js';

const FILES: Record<string, Buffer> = {
  'README.md': buf('# carries fixture\n'),
  'src/a.txt': buf('one\ntwo\nthree\nfour\nfive\n'),
  'src/b.txt': buf('alpha\nbeta\ngamma\n'),
};

const peer = (fx: CoreFixture): PeerFixture => fx.peers[0]!;

test('the governor counts no P2-PIN-skipped pair as pending: with only a pinned pair waiting, nothing is pending (msUntilWindow is Infinity)', async () => {
  await withCores('carry-pinned-pending', { n: 1, files: FILES }, async (fx) => {
    const p = peer(fx);
    const A0 = await stateA(p);
    const { pair } = await editAndCapture(fx, p, { 'src/a.txt': 'one\nTWO local\nthree\nfour\nfive\n' });
    await prep(p);
    assert.ok(Number.isFinite(p.core.governor.msUntilWindow(1)), 'control: an unpinned ready pair is pending work');
    const local = (await p.core.repo.readTreeMap(pair.R)).get('src/a.txt')!.oid;
    await p.core.holds.hold({
      kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths: ['src/a.txt'], blobs: { h0: { 'src/a.txt': A0.get('src/a.txt')!.oid }, h1: { 'src/a.txt': local } },
      guard: 'join', origin: 'human', cs_ids: [], displaced_by: null, local_only: false,
    });
    fx.advance(3_000);
    await prep(p);
    assert.equal(p.core.governor.msUntilWindow(1), Infinity, 'a pair P2-PIN holds back waits for a human, not for a window');
    assert.deepEqual(p.core.view!.ready.map((x) => x.csId), [pair.csId], 'the pinned pair stays journaled');
  });
});

test('a capture whose tmp/r.index.lock was left by a killed git child still captures (the scratch index is reset first, P2-SCRATCHLOCK)', async () => {
  await withCores('carry-capture-lock', { n: 1, files: FILES }, async (fx) => {
    const p = peer(fx);
    const lock = `${p.core.scratch('r')}.lock`;
    await writeFile(lock, 'a killed write-tree left this\n');
    const { pair } = await editAndCapture(fx, p, { 'src/b.txt': 'alpha\nBETA local\ngamma\n' });
    assert.equal(await blobText(p, await p.core.repo.readTreeMap(pair.R), 'src/b.txt'), 'alpha\nBETA local\ngamma\n');
  });
});

test('the capture resets its scratch index with the shared helper (src/git/scratchIndex.ts): an unlink failure on tmp/r.index rejects with ScratchResetError (errno code kept), and the same close captures once the holder is gone', async () => {
  await withCores('carry-capture-reset-typed', { n: 1, files: FILES }, async (fx) => {
    const p = peer(fx);
    await writeWork(p, 'src/b.txt', 'alpha\nBETA local\ngamma\n');
    await prep(p);
    fx.advance(20_000);
    const it = await prep(p, true);
    p.fs.addRule({ op: 'unlink', pathIncludes: join('tmp', 'r.index'), code: 'EPERM', times: 1 });
    await assert.rejects(
      p.core.cs.capture(p.core.repo, it.mat!.sDiskMap, it.A, p.core.scratch('r')),
      (e: unknown) => e instanceof ScratchResetError && e.code === 'EPERM',
    );
    const pair = await captureReady(p, it);
    assert.equal(await blobText(p, await p.core.repo.readTreeMap(pair.R), 'src/b.txt'), 'alpha\nBETA local\ngamma\n');
  });
});

test('a scratch reset failure in the ok update after a landing keeps the push intent (the update resolves later), logs SCRATCH_RESET_FAILED at most once per 10 min while the holder persists, and once the holder is gone the next resolve applies it', async () => {
  await withCores('carry-okupdate-reset', { n: 1, files: FILES }, async (fx) => {
    const p = peer(fx);
    const log = new LogRecorder();
    p.deps.log = log;
    const { pair } = await editAndCapture(fx, p, { 'src/a.txt': 'one\ntwo\nthree\nFOUR local\nfive\n' });
    fx.advance(30_000);
    const it = await prep(p);
    // A share-read holder on tmp/r.index from the landing on (publishStep's build never resets tmp/r.index).
    const release = p.fs.holdLock(join('tmp', 'r.index'), 'share-read');
    const resets = (): number => log.lines.filter((l) => l.code === 'SCRATCH_RESET_FAILED').length;
    const r = await publishStep(p.core, it);
    assert.deepEqual([r.outcome, r.why], ['skipped', 'intent_unresolved'], JSON.stringify(r));
    const kept = p.core.view!.intent;
    assert.equal(kept.kind, 'push', 'the push intent stays journaled');
    assert.equal(await remoteBoard(fx, p), kept.kind === 'push' ? kept.bnew : null, 'the push landed');
    assert.equal(resets(), 1, 'logged once');
    assert.deepEqual(p.core.cs.ready().map((x) => x.csId), [pair.csId], 'the pair is still ready in memory (nothing applied)');
    fx.advance(60_000);
    const again = await resolvePushIntent(p.core, await prep(p));
    assert.deepEqual([again.outcome, again.why], ['skipped', 'intent_unresolved']);
    assert.equal(resets(), 1, 'not again within 10 min');
    fx.advance(10 * 60_000);
    await resolvePushIntent(p.core, await prep(p));
    assert.equal(resets(), 2, 'again after 10 min while the holder persists');
    release();
    const done = await resolvePushIntent(p.core, await prep(p));
    assert.deepEqual([done.outcome, done.why], ['landed', 'resolved']);
    assert.equal(p.core.view!.intent.kind, 'none');
    assert.equal(p.core.view!.laB, kept.kind === 'push' ? kept.bnew : null, 'LA_B := Bnew');
    assert.deepEqual(p.core.cs.ready(), [], 'the published pair left the journal');
    assert.equal((await stateA(p)).get('src/a.txt')?.oid, await p.core.repo.hashBytes(buf('one\ntwo\nthree\nFOUR local\nfive\n'), false), 'A[p] := C[p]');
  });
});

test('the ok update catches a scratch-index failure only before it changes any memory: a holder on tmp/a.index that appears after the pre-reset (the A edit\'s own reset) keeps the intent with the pair still ready in memory and the next resolve applies it; an error thrown after memory changed (inside the HLD-41 rebase) is never reported as a kept intent: publishStep and the restart\'s resolve reject with it, and a later restart lands the push by observation', async () => {
  await withCores('carry-okupdate-a-index', { n: 1, files: FILES }, async (fx) => {
    const p = peer(fx);
    const log = new LogRecorder();
    p.deps.log = log;
    const text = 'one\ntwo\nthree\nfour\nFIVE local\n';
    const { pair } = await editAndCapture(fx, p, { 'src/a.txt': text });
    fx.advance(30_000);
    const it = await prep(p);
    // tmp/a.index is unlinked twice by the ok update: its pre-reset, then the reset before the A edit's read-tree.
    const aIndex = p.core.scratch('a');
    const unlink = p.fs.unlink.bind(p.fs);
    let n = 0;
    p.fs.unlink = async (f: string): Promise<void> => {
      if (f === aIndex && ++n === 2) throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${f}'`), { code: 'EPERM', syscall: 'unlink', path: f });
      return unlink(f);
    };
    let r;
    try {
      r = await publishStep(p.core, it);
    } finally {
      p.fs.unlink = unlink;
    }
    assert.equal(n >= 2, true, 'the A edit\'s reset ran and failed');
    assert.deepEqual([r.outcome, r.why], ['skipped', 'intent_unresolved'], JSON.stringify(r));
    const kept = p.core.view!.intent;
    assert.equal(kept.kind, 'push', 'the push intent stays journaled');
    assert.equal(await remoteBoard(fx, p), kept.kind === 'push' ? kept.bnew : null, 'the push landed');
    assert.deepEqual(p.core.cs.ready().map((x) => x.csId), [pair.csId], 'the pair is still ready in memory: nothing changed before the failure');
    assert.ok(log.lines.some((l) => l.code === 'SCRATCH_RESET_FAILED' && l.params['file'] === aIndex), 'SCRATCH_RESET_FAILED names tmp/a.index');
    const done = await resolvePushIntent(p.core, await prep(p));
    assert.deepEqual([done.outcome, done.why], ['landed', 'resolved']);
    assert.deepEqual(p.core.cs.ready(), [], 'the published pair left the journal');
    assert.equal((await stateA(p)).get('src/a.txt')?.oid, await p.core.repo.hashBytes(buf(text), false), 'A[p] := C[p]');
  });
  await withCores('carry-okupdate-after-memory', { n: 1, files: FILES }, async (fx) => {
    const p = peer(fx);
    const text = 'one\ntwo\nthree\nfour\nFIVE local\n';
    await editAndCapture(fx, p, { 'src/a.txt': text });
    fx.advance(30_000);
    const it = await prep(p);
    const late = (): ScratchResetError => new ScratchResetError(p.core.scratch('r'), { code: 'EPERM' });
    // A failure after cs.published changed memory (inside the HLD-41 rebase of the pairs left).
    const fail = (q: PeerFixture): void => {
      q.core.cs.rebase = async () => {
        throw late();
      };
    };
    fail(p);
    await assert.rejects(publishStep(p.core, it), (e: unknown) => e instanceof ScratchResetError, 'publishStep');
    const kept = (await p.core.state.read())!.intent;
    assert.equal(kept.kind, 'push', 'the state still holds the push intent');
    assert.equal(await remoteBoard(fx, p), kept.kind === 'push' ? kept.bnew : null, 'the push landed');
    // The restart's resolve meets the same failure after memory changed: thrown, never a kept intent.
    await restartCore(p);
    fail(p);
    await assert.rejects(startDispatch(p.core, { publishLocal: null }), (e: unknown) => e instanceof ScratchResetError, 'the restart');
    assert.equal((await p.core.state.read())!.intent.kind, 'push', 'still journaled');
    // A clean restart lands it by observation.
    await restartCore(p);
    const r = await startDispatch(p.core, { publishLocal: null });
    assert.ok(r.ok && r.mode === 'restart' && r.restart?.pushResolved === 'landed', JSON.stringify(r));
    assert.equal(p.core.view!.laB, kept.kind === 'push' ? kept.bnew : null, 'LA_B := Bnew');
    assert.deepEqual(p.core.cs.ready(), [], 'the published pair left the journal');
    assert.equal((await stateA(p)).get('src/a.txt')?.oid, await p.core.repo.hashBytes(buf(text), false), 'A[p] := C[p]');
  });
});

test('a Windows unlink failure inside the scratch-index reset of publishStep is a build failure (aborted, build_failed), never thrown; the next window publishes', async () => {
  await withCores('carry-reset-unlink', { n: 1, files: FILES }, async (fx) => {
    const p = peer(fx);
    await editAndCapture(fx, p, { 'src/a.txt': 'one\ntwo\nTHREE local\nfour\nfive\n' });
    fx.advance(30_000);
    const it = await prep(p);
    const outbox = JSON.stringify(p.core.outbox.toJson());
    // A share-read holder (or an antivirus scan) on tmp/p.index: the reset's unlink fails with EPERM.
    p.fs.addRule({ op: 'unlink', pathIncludes: join('tmp', 'p.index'), code: 'EPERM', times: 1 });
    const r = await publishStep(p.core, it);
    assert.deepEqual([r.outcome, r.why], ['aborted', 'build_failed'], JSON.stringify(r));
    assert.equal(pushCalls(p), 0, 'nothing was pushed');
    assert.equal(p.core.view!.intent.kind, 'none', 'no push intent was journaled');
    assert.equal(JSON.stringify(p.core.outbox.toJson()), outbox, 'the outbox is as it was');
    fx.advance(30_000);
    const next = await publishStep(p.core, await prep(p));
    assert.equal(next.outcome, 'landed', JSON.stringify(next));
    assert.equal(await blobText(p, await treeOf(p, next.c!), 'src/a.txt'), 'one\ntwo\nTHREE local\nfour\nfive\n');
  });
});
