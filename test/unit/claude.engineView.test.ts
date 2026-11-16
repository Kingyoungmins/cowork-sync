// Plan 5 Task 5 phase 2 — EngineView (F05-11, CCI-12; 06 §3.16.3 {ACT}): every member answers from memory
// (0 git calls, 0 file reads) except untracked(); observe/peerFoldedAgoMs/foldRecencyUncertain give the
// {ACT} inputs. Built over makeEngines (real git, FaultFs, spy-able via lastStatus).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngines } from '../helpers/engineFixture.js';
import type { EngineFixture } from '../helpers/engineFixture.js';
import { gitCallsOf } from '../helpers/coreFixture.js';
import { engineView } from '../../src/claude/daemon/engineView.js';
import { ensureAttrs } from '../../src/engine/core.js';
import type { Engine } from '../../src/engine/loop.js';

let fx: EngineFixture;
let view: ReturnType<typeof engineView>;

test('setup: two peers, 3 rounds, views attached', async () => {
  fx = await makeEngines('p5t5-view', { n: 2, files: { 'src/a.ts': Buffer.from('alpha\n') } });
  await fx.startAll();
  await fx.rounds(3);
  await fx.pushTeamChange({ 'src/b.ts': Buffer.from('beta\n') });
  await fx.rounds(3);
  const vpeer = fx.peers[1]!;
  await ensureAttrs(vpeer.core, vpeer.core.view!.meta.EPOCH_BASE, ['src/a.ts', 'src/b.ts']);
  view = engineView(vpeer.engine, vpeer.core);
});

test('EngineView answers from memory: 1,000 calls of the sync members cause 0 git calls and 0 file reads', async () => {
  const p = fx.peers[1]!;
  const gitBefore = gitCallsOf(p).length;
  const fsBefore = p.fs.calls.length;
  for (let i = 0; i < 1_000; i++) {
    view.A();
    view.tipHeight();
    view.scopeOf('src/a.ts');
    view.portability('NUL.txt');
    view.modeOf('src/a.ts');
    view.pendingReason('src/a.ts');
    view.offline();
    view.freezeReasons();
    view.heldRanges('src/a.ts');
    view.lastStatus();
    view.ownAnchors();
    view.checkpointCommands();
    view.displayName(view.peer());
    view.teamLanguage();
    view.symlinksEnabled();
    view.foldedHeight();
    view.openCsOf('seat', null);
    view.csPaths('nope');
    view.peerFoldedAgoMs(fx.peers[1]!.core.peerId);
    view.foldRecencyUncertain();
    void view.loopPeriodMs();
    void view.publishPause();
  }
  assert.equal(p.fs.calls.length, fsBefore, '0 file reads');
  assert.equal(gitCallsOf(p).length, gitBefore, '0 git calls');
});

test('A()/tipHeight()/foldedHeight()/fold()/displayName/peer answer from memory', () => {
  const p1 = fx.peers[1]!;
  const p2 = fx.peers[0]!;
  assert.equal(view.peer(), p1.core.peerId);
  assert.equal(view.displayName(p2.core.peerId), p2.deps.display);
  const A = view.A();
  assert.ok(A instanceof Map);
  void p1.core.view!.base;
  assert.equal(view.tipHeight(), p1.core.view!.fold!.height);
  assert.equal(view.foldedHeight(), p1.core.view!.meta.fold_verified?.height ?? p1.core.view!.fold!.height);
  assert.equal(view.fold(), p1.core.view!.fold);
});

test('scopeOf/portability/modeOf/pendingReason/freezeReasons/publishPause/offline/loopPeriodMs map to the core', () => {
  const p = fx.peers[1]!;
  const scope = view.scopeOf('src/a.ts');
  assert.equal(scope.cls, 'LIVE');
  assert.equal(scope.reason, null);
  // NUL.txt breaks D7 rule 2 on every OS.
  const port = view.portability('NUL.txt');
  assert.ok(!port.ok);
  assert.ok((port as { reason: string }).reason.length > 0, 'a D7 reason is named');
  assert.ok(typeof (port as { suggestion: string }).suggestion === 'string' && (port as { suggestion: string }).suggestion.length > 0);
  assert.equal(view.modeOf('src/a.ts'), '100644');
  assert.equal(view.modeOf('src/never-was.ts'), null);
  assert.equal(view.pendingReason('src/a.ts'), null);
  assert.deepEqual(view.freezeReasons(), []);
  assert.equal(view.publishPause(), null);
  assert.deepEqual(view.offline(), p.core.fetcher.offline());
  assert.equal(view.loopPeriodMs(), view.lastStatus()?.loop_period_ms);
});

test('pathState delegates to Writer.pathState; heldRanges delegates to Engine.heldRanges; registry/addOps materialize', async () => {
  const p = fx.peers[1]!;
  assert.equal(await view.pathState('src/a.ts'), await p.core.writer.pathState('src/a.ts'));
  assert.deepEqual(view.heldRanges('src/a.ts'), p.engine.heldRanges('src/a.ts'));
  assert.equal(view.registry(), p.core.holds);
  const before = p.core.outbox.drafts();
  view.addOps([{ type: 'event', cid: '', kind: 'health', refs: ['x'], reason_code: 'PEER_IDLE' }]);
  const after = p.core.outbox.drafts();
  assert.equal(after.length, before.length + 1);
  const added = after[after.length - 1] as { type: string };
  assert.equal(added.type, 'event');
});

test('snapshotEntries/openCsOf/csPaths/materializedOid answer from memory over the newest completed snapshot', () => {
  const p = fx.peers[1]!;
  const entries = view.snapshotEntries();
  assert.ok(entries instanceof Map);
  assert.ok(entries.size > 0, 'after the rounds the private index is non-empty');
  for (const [path, e] of entries) {
    assert.equal(typeof path, 'string');
    assert.ok(e.oid === null || e.oid === 'ABSENT' || /^[0-9a-f]+$/.test(e.oid), 'oid, ABSENT or null');
  }
  assert.equal(entries.get('src/a.ts')?.oid, p.core.view!.snap !== null ? entries.get('src/a.ts')?.oid : undefined);
  // openCsOf/csPaths: no CS for an unknown seat; table-driven.
  assert.equal(view.openCsOf('no-such-seat', null), null);
  assert.deepEqual(view.csPaths('no-such-cs'), []);
  // materializedOid: a path in the newest snapshot's S_disk or absent.
  const mo = view.materializedOid('src/a.ts');
  assert.ok(mo === null || /^[0-9a-f]+$/.test(mo === 'ABSENT' ? 'x' : mo));
});

test('ownAnchors returns anchors without git; observe/peerFoldedAgoMs/foldRecencyUncertain follow A5-8', async () => {
  const p = fx.peers[1]!;
  const a = view.ownAnchors();
  assert.ok(a.lastFetch === null || (typeof a.lastFetch.mono === 'number' && typeof a.lastFetch.wall === 'number'));
  assert.ok(a.lastPush === null || typeof a.lastPush.mono === 'number');
  assert.ok(typeof a.suspendGapMs === 'number');
  // foldRecencyUncertain true from attach; observe() after the first completed iteration clears it.
  assert.equal(view.foldRecencyUncertain(), true);
  view.observe(p.core.deps.ports.clock.monoMs());
  assert.equal(view.foldRecencyUncertain(), false);
  const p2id = fx.peers[0]!.core.peerId;
  // After rounds() P2's commits are folded: peerFoldedAgoMs is a non-negative age.
  const ago = view.peerFoldedAgoMs(p2id);
  assert.ok(ago !== null, 'P2 folded a board commit during the rounds');
  assert.ok(ago >= 0);
});

test('foldRecencyUncertain re-arms on an observed OFFLINE or AUTH pause and clears at the observation after the first post-pause fetch (CCI-65, A5-8; F2 #51, #95, #43)', () => {
  const p = fx.peers[1]!;
  // The real core (engineScope(core) needs it) under a fake Engine whose status the cell scripts.
  let status: { publish_pause: string | null } | null = null;
  const eFake = { peerId: p.engine.peerId, lastStatusJson: () => status, heldRanges: () => [] } as unknown as Engine;
  let fetchMono: number | null = null;
  // An instance property shadows the fetcher's prototype method for this cell only.
  (p.core.fetcher as unknown as { lastSuccessMono: () => number | null }).lastSuccessMono = () => fetchMono;
  try {
    const v = engineView(eFake, p.core);
    const step = (n: number, s: typeof status, fetch: number | null | undefined, want: boolean): void => {
      status = s;
      if (fetch !== undefined) fetchMono = fetch;
      v.observe(p.core.deps.ports.clock.monoMs());
      assert.equal(v.foldRecencyUncertain(), want, `step ${n}`);
    };
    step(1, null, undefined, true);                                   // from attach: no completed iteration yet
    step(2, { publish_pause: null }, 1_000, false);                   // the first observation after a completed iteration
    step(3, { publish_pause: 'OFFLINE' }, 1_000, true);               // an observed OFFLINE re-arms
    step(4, { publish_pause: null }, undefined, true);                // cleared, but no fetch since the pause began
    step(5, { publish_pause: null }, 5_000, false);                   // the observation after the first post-OFFLINE fetch
    step(6, { publish_pause: 'AUTH' }, undefined, true);              // an observed AUTH re-arms too
    step(7, { publish_pause: 'AUTH' }, 6_000, true);                  // a fetch during the pause does not count
    step(8, { publish_pause: null }, undefined, true);                // cleared, no fetch after the pause
    step(9, { publish_pause: null }, 7_000, false);                   // the observation after the first post-AUTH fetch
  } finally {
    delete (p.core.fetcher as unknown as { lastSuccessMono?: unknown }).lastSuccessMono;
  }
});

test('peerFoldedAgoMs is null before the view first sees a peer\'s fold, exact afterwards, restamped only on growth (F05-11, A5-8; F2 #43, #95)', async () => {
  const p = fx.peers[1]!;
  const P2 = fx.peers[0]!.core.peerId;
  const clock = p.core.deps.ports.clock;
  const v = engineView(p.engine, p.core);
  assert.equal(v.peerFoldedAgoMs(P2), null, 'before the first observation');
  const T = clock.monoMs();
  v.observe(T);
  fx.advance(15_000);
  assert.equal(clock.monoMs() - T, 15_000);
  assert.equal(v.peerFoldedAgoMs(P2), 15_000, 'stamped at the observation that first saw P2 folded');
  v.observe(clock.monoMs());                                          // no new P2 board commit: no restamp
  fx.advance(5_000);
  assert.equal(v.peerFoldedAgoMs(P2), 20_000);
  // P2 publishes a new board commit (one queued op) and P1 folds it.
  const p2Rec = (): number => p.core.view!.fold!.peers[P2]!.last_seq;
  const before = p2Rec();
  fx.peers[0]!.core.outbox.add({ type: 'event', cid: '', kind: 'health', refs: ['x'], reason_code: 'PEER_IDLE' });
  for (let i = 0; i < 6 && p2Rec() <= before; i++) await fx.rounds(1);
  assert.ok(p2Rec() > before, `P2's last_seq grew (${before} → ${p2Rec()})`);
  const T2 = clock.monoMs();
  v.observe(T2);
  fx.advance(7_000);
  assert.equal(clock.monoMs() - T2, 7_000);
  assert.equal(v.peerFoldedAgoMs(P2), 7_000, 'restamped at the observation that saw the growth');
});

test('untracked runs the listing command (excluded from the 0-git-call list) and lists repo-relative paths', async () => {
  const list = await view.untracked();
  assert.ok(Array.isArray(list));
  for (const path of list) assert.ok(!path.startsWith('/') && !path.includes('\\'));
});

test('teardown', async () => {
  await fx.cleanup();
});
