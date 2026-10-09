// /cowork recover (01-engine §3.7 Recover; ENG-22, ENG-59 recover.displaced / recover.reanchor; PRO-25; 01-engine tests
// 18 (recover part), 35 and 39; INV-FF's recover exception, INV-OID; rulings R-21, R-27 and the Task 16 fix-round
// rulings): the preview/confirm id (a stale id is refused with a fresh preview), the restore (V copied to recover's own
// displaced/<peer>/v-<n> when it is not on X's chain, X and live_code(X) pushed with --force-with-lease), re-runs after a
// kill or a failed push, the re-anchor of a late peer through the lost-state rebuild in ONE state update, a kept push
// intent resolved first, the refusals with their reasons, the displaced-ref validation, and the other peers clearing
// INCIDENT with a refold, and a stranded restore across a re-anchor decided by ENG-54 from its .old (final review FD).
// Also the lost-state rebuild's per-path primitive (Task 15 carry). EngineCores over real clones
// of a file:// remote; git is never mocked (a runner wrapper only fails one call the way git does).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { readBoardCommit } from '../../src/board/boardCommit.js';
import type { Json } from '../../src/board/canonicalJson.js';
import { Folder, serializeFold } from '../../src/board/fold.js';
import { parseOpId } from '../../src/board/ids.js';
import type { OpDraft } from '../../src/board/ops.js';
import { applyStep } from '../../src/engine/apply.js';
import { captureDue, markApplyIntentKept, prepareIteration, tickInputOf } from '../../src/engine/core.js';
import { PLAN2_REGION_SPEC } from '../../src/engine/deps.js';
import { publishStep, resolvePushIntent } from '../../src/engine/publish.js';
import { DISPLACED_SKIP_LOG_MAX, recover, type RecoverResult } from '../../src/engine/recover.js';
import { lostStateRebuild } from '../../src/engine/restart.js';
import type { Intent, JournalTree } from '../../src/engine/state.js';
import { LOCAL_INTENT_KEEP, localIntentKeep } from '../../src/engine/writer.js';
import { lsRemotePrefix } from '../../src/git/fetch.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import { KilledAt, setCrashHandler } from '../../src/ports/crashpoint.js';
import type { TraceEvent } from '../../src/ports/trace.js';
import { gitCallsOf, readWork, workPath, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import {
  addPackedRefs, boardOn, catchUp, forceRemote, inIncident, joinBoard, KillAfterLog, liveOf, liveOn, localDisplaced, poll, pushSpawnsOf,
  remoteDisplaced, vCopyRef,
} from '../helpers/incidentFixture.js';
import { buf, editAndCapture, failedResult, lines, LogRecorder, prep, stateA, withCores, wrapGit } from '../helpers/publishHelpers.js';
import { gitIn, gitRemote, restartCore, startOk } from '../helpers/startFixture.js';

const FILES: Record<string, Buffer> = {
  'README.md': buf('# recover fixture\n'),
  'x.txt': buf('x v0\n'),
  'y.txt': buf('y v0\n'),
};

const PAST_WINDOW_MS = 11_000;

async function firstParent(p: PeerFixture, c: Oid): Promise<Oid> {
  return (await p.core.repo.readCommit(c)).parents[0]!;
}

async function blob(p: PeerFixture, text: string): Promise<Oid> {
  return p.core.repo.hashBytes(buf(text), false);
}

/** The peer enters INCIDENT on its next poll and pushes its displaced copy in a later window. */
async function detect(fx: CoreFixture, p: PeerFixture): Promise<void> {
  assert.equal((await poll(p)).incident, true, `${p.name}: INCIDENT`);
  fx.advance(PAST_WINDOW_MS);
  assert.equal((await poll(p)).incident, true);
}

function okPreview(r: RecoverResult): asserts r is Extract<RecoverResult, { ok: true }> {
  assert.ok(r.ok, `recover refused: ${JSON.stringify(r)}`);
}

function refusal(r: RecoverResult): string {
  assert.ok(!r.ok, `recover did not refuse: ${JSON.stringify(r)}`);
  return r.ok ? '' : r.code;
}

/** A RECOVER_OFFLINE refusal's params. */
function offlineOf(r: RecoverResult): Record<string, Json> {
  assert.equal(refusal(r), 'RECOVER_OFFLINE', JSON.stringify(r));
  return r.ok ? {} : r.params;
}

/** The fresh preview a RECOVER_PREVIEW_STALE refusal carries (glossary §15: stale ids refused with a fresh preview). */
function stalePreview(r: RecoverResult): { id: string; X: Oid | null; V: string; mode: string } {
  assert.equal(refusal(r), 'RECOVER_PREVIEW_STALE', JSON.stringify(r));
  const pv = (r.ok ? {} : r.params['preview']) as Record<string, Json>;
  return { id: String(pv['id']), X: pv['X'] as Oid | null, V: String(pv['V']), mode: String(pv['mode']) };
}

/** Push events (attempted, not denied) of one peer since a trace index. */
function pushesOf(fx: CoreFixture, p: PeerFixture, from: number): Array<Extract<TraceEvent, { kind: 'push' }>> {
  return fx.trace.since(from).filter((e): e is Extract<TraceEvent, { kind: 'push' }> => e.kind === 'push' && e.peer === p.core.peerId && e.outcome !== 'denied');
}

/** Throws KilledAt at the first hit of `point` (a dead process). */
async function killedAt<T>(point: string, fn: () => Promise<T>): Promise<void> {
  setCrashHandler((name) => {
    if (name === point) throw new KilledAt(name);
  });
  try {
    await assert.rejects(fn(), (e: unknown) => e instanceof KilledAt && e.point === point, `killed at ${point}`);
  } finally {
    setCrashHandler(null);
  }
}

/** A git call of the peer refused the way git refuses (exit 128, no output) while `match` holds; returns the restore function. */
function failGit(p: PeerFixture, match: (args: string[]) => boolean): () => void {
  return wrapGit(p, (args, opts, inner) => (match(args) ? Promise.resolve(failedResult(128)) : inner(args, opts)));
}

test('recover without --confirm changes nothing and returns a preview id', async () => {
  await withCores('recover-preview', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { board: B1 } = await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
    await catchUp(fx, p);
    const B0 = await firstParent(p, B1);
    await forceRemote(fx, p, p.core.refs.remoteBoard, B0);
    await detect(fx, p);

    const state0 = await p.core.repo.readRef(p.core.refs.state);
    const remote0 = await fx.remote.refs();
    const locals0 = await p.core.repo.listRefs('refs/cowork-local/');
    const holds0 = p.core.holds.all().length;
    const spawns0 = pushSpawnsOf(gitCallsOf(p));
    const r = await recover(p.core, null);
    okPreview(r);
    assert.equal(r.done, false);
    assert.match(r.preview.id, /^[0-9a-f]{6}$/);
    assert.deepEqual(
      { mode: r.preview.mode, V: r.preview.V, X: r.preview.X, candidates: r.preview.candidates, restartPaths: r.preview.restartPaths, pushIntent: r.preview.pushIntent },
      { mode: 'restore', V: B0, X: B1, candidates: [B1], restartPaths: [], pushIntent: null },
    );
    const again = await recover(p.core, null);
    okPreview(again);
    assert.equal(again.preview.id, r.preview.id, 'the same situation gives the same id');
    // A stale id is refused with a fresh preview (glossary §15): nothing is done.
    const stale = r.preview.id === 'abcdef' ? 'abcde0' : 'abcdef';
    assert.equal(stalePreview(await recover(p.core, stale)).id, r.preview.id);

    assert.equal(await p.core.repo.readRef(p.core.refs.state), state0, 'the state is unchanged');
    assert.deepEqual(await fx.remote.refs(), remote0, 'the remote is unchanged');
    assert.deepEqual(await p.core.repo.listRefs('refs/cowork-local/'), locals0, 'no local cowork ref is written');
    assert.equal(p.core.holds.all().length, holds0);
    assert.equal(pushSpawnsOf(gitCallsOf(p)), spawns0, 'no push');
    assert.ok(inIncident(p));
  });
});

test('recover with the preview id displaces V when it is not on X\'s chain, hits recover.displaced, then pushes X to the board and live_code(X) to the mirror with --force-with-lease and clears INCIDENT', async () => {
  await withCores('recover-restore', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { board: B1 } = await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
    await catchUp(fx, p);
    const B0 = await firstParent(p, B1);
    const [L0, L1] = [await liveOf(p, B0), await liveOf(p, B1)];
    // A well-shaped rewrite forking at B0, the mirror moved along with it.
    const L1x = await liveOn(p, [L0]);
    const V = await boardOn(p, B0, L1x);
    const { remoteBoard: board, remoteCode: code } = p.core.refs;
    await forceRemote(fx, p, board, V);
    await forceRemote(fx, p, code, L1x);
    await detect(fx, p);

    const prev = await recover(p.core, null);
    okPreview(prev);
    assert.deepEqual([prev.preview.mode, prev.preview.V, prev.preview.X], ['restore', V, B1]);
    assert.ok((await localDisplaced(p)).length > 0, 'the preview fetched the displaced copies');
    const from = fx.trace.events.length;
    const hits: Array<{ name: string; at: number }> = [];
    setCrashHandler((name) => {
      if (name.startsWith('recover.')) hits.push({ name, at: fx.trace.events.length });
    });
    let r: RecoverResult;
    try {
      r = await recover(p.core, prev.preview.id);
    } finally {
      setCrashHandler(null);
    }
    okPreview(r);
    assert.equal(r.done, true);
    const pushes = pushesOf(fx, p, from);
    assert.deepEqual(pushes.map((e) => e.purpose), ['displaced', 'recover']);
    const vref = vCopyRef(p, 1);
    assert.ok(pushes[0]!.argv.includes(`--force-with-lease=${vref}:`) && pushes[0]!.argv.includes(`${V}:${vref}`), 'V is copied to recover\'s own displaced/<peer>/v-1 with an ABSENT lease');
    const rp = pushes[1]!.argv;
    assert.ok(rp.includes(`--force-with-lease=${board}:${V}`) && rp.includes(`${B1}:${board}`), 'X over the observed V');
    assert.ok(rp.includes(`--force-with-lease=${code}:${L1x}`) && rp.includes(`${L1}:${code}`), 'live_code(X) over the fetched mirror');
    assert.deepEqual(hits.map((h) => h.name), ['recover.displaced']);
    const firstPushAt = fx.trace.events.indexOf(fx.trace.since(from).find((e) => e.kind === 'push' && e.outcome !== 'denied')!);
    const secondPushAt = fx.trace.events.lastIndexOf(fx.trace.since(from).filter((e) => e.kind === 'push' && e.outcome !== 'denied').at(-1)!);
    assert.ok(firstPushAt < hits[0]!.at && hits[0]!.at <= secondPushAt, 'recover.displaced lies after step 4 and before step 5');

    const after = await fx.remote.refs();
    assert.equal(after[board], B1, 'the board is X');
    assert.equal(after[code], L1, 'the mirror is live_code(X)');
    assert.equal(after[vref], V, 'the observed bad tip is kept in a displaced ref');
    assert.equal(after[p.core.refs.displaced(B1)], B1, 'the detection copy stays');
    assert.ok(!inIncident(p), 'INCIDENT is cleared');
    assert.equal(p.core.view!.meta.incident, null);
    assert.deepEqual(await localDisplaced(p), [], 'the local copies of the displaced refs are deleted');
    fx.advance(PAST_WINDOW_MS);
    const next = await poll(p);
    assert.equal(next.incident, false, 'the ordinary loop resumes');
    assert.equal(p.core.view!.laB, B1);
  });
});

test('other peers clear INCIDENT when their check passes again and refold', async () => {
  await withCores('recover-others', { n: 2, files: FILES }, async (fx) => {
    const [p1, p2] = [fx.peers[0]!, fx.peers[1]!];
    const board = p1.core.refs.remoteBoard;
    const { board: B1 } = await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
    for (const p of fx.peers) await catchUp(fx, p);
    const B0 = await firstParent(p1, B1);
    // A teammate's board-only join lands on B1; p2 folds it (nothing to apply, so its LA_B stays B1); p1 never sees it.
    const ghost = await joinBoard(p2, B1, 'Ghost');
    await forceRemote(fx, p2, board, ghost.board);
    fx.advance(2_500);
    assert.equal((await poll(p2)).incident, false);
    assert.equal(p2.core.view!.laB, B1, 'a board-only commit moves no LA_B');
    // The board is rewound to B0: both freeze, and p2's incident entry persists its fold of the rewound join.
    await forceRemote(fx, p1, board, B0);
    for (const p of fx.peers) assert.equal((await poll(p)).incident, true);
    assert.equal(p2.core.view!.meta.fold_board, ghost.board, 'p2 persisted the fold of the commit the rewind removed');
    fx.advance(PAST_WINDOW_MS);
    for (const p of fx.peers) await poll(p);
    // p2 only previews (its local copies of the displaced refs are fetched); p1 recovers X = B1.
    okPreview(await recover(p2.core, null));
    assert.ok((await localDisplaced(p2)).length > 0);
    const prev = await recover(p1.core, null);
    okPreview(prev);
    assert.equal(prev.preview.X, B1);
    const done = await recover(p1.core, prev.preview.id);
    okPreview(done);
    assert.equal(done.done, true);
    // The team continues on the restored tip: a change, then another teammate's join (built where p1 fetched B2).
    const { board: B2 } = await fx.pushTeamChange({ 'y.txt': buf('y v1\n') });
    fx.advance(PAST_WINDOW_MS);
    assert.equal((await poll(p1)).incident, false);
    const late = await joinBoard(p1, B2, 'Late');
    await forceRemote(fx, p1, board, late.board);

    const log = new LogRecorder();
    p2.deps.log = log;
    fx.advance(10_000);
    const r = await poll(p2);
    assert.equal(r.incident, false, 'the check passes again');
    assert.equal(r.cleared, true, 'clearIncidentIfHealed cleared it');
    assert.ok(!inIncident(p2));
    assert.equal(p2.core.view!.meta.incident, null);
    assert.ok(log.lines.some((l) => l.code === 'UNFROZEN' && l.params['reason'] === 'INCIDENT'), log.text());
    // PRO-25: the persisted fold is the restored chain's, refolded: the teammate's join on it is in, the rewound join out.
    const fold = p2.core.view!.fold!;
    assert.equal(p2.core.view!.meta.fold_board, late.board);
    assert.ok(late.peer in fold.peers, 'the join on the restored chain is folded');
    assert.ok(!(ghost.peer in fold.peers), 'the join of the rewound commit is gone (a refold, not a continuation)');
    const fresh = await new Folder(p2.core.repo, p2.core.peerId).foldTo(late.board, null, PLAN2_REGION_SPEC);
    assert.ok(serializeFold(fold).equals(serializeFold(fresh.state)), 'equal to a fold from the checkpoint');
    assert.deepEqual(await localDisplaced(p2), [], 'clearing deletes the local copies of the displaced refs');
    // The same iteration applies again.
    assert.equal(r.apply?.ran, true);
    assert.equal((await readWork(p2, 'y.txt'))?.toString('utf8'), 'y v1\n');
    assert.equal(p2.core.view!.laB, late.board);
  });
});

test('recover refuses RECOVER_NOT_IN_INCIDENT, RECOVER_OFFLINE, RECOVER_AMBIGUOUS and RECOVER_DISPLACED_FULL in their situations', async () => {
  await withCores('recover-refusals', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { remoteBoard: board } = p.core.refs;
    const { board: B1 } = await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
    const { board: B2 } = await fx.pushTeamChange({ 'y.txt': buf('y v1\n') });
    await catchUp(fx, p);
    const B0 = await firstParent(p, B1);
    const [L0, L1] = [await liveOf(p, B0), await liveOf(p, B1)];
    const spawns0 = pushSpawnsOf(gitCallsOf(p));

    assert.equal(refusal(await recover(p.core, null)), 'RECOVER_NOT_IN_INCIDENT');
    assert.equal(refusal(await recover(p.core, 'abcdef')), 'RECOVER_NOT_IN_INCIDENT');

    await forceRemote(fx, p, board, B1);
    await detect(fx, p);
    const state0 = await p.core.repo.readRef(p.core.refs.state);
    const spawns1 = pushSpawnsOf(gitCallsOf(p));
    assert.equal(spawns1 - spawns0, 1, 'the detection copy only');

    // RECOVER_OFFLINE{fetch}: no fetch succeeds now.
    const away = `${fx.remote.dir}.away`;
    await rename(fx.remote.dir, away);
    try {
      assert.equal(offlineOf(await recover(p.core, null))['reason'], 'fetch');
    } finally {
      await rename(away, fx.remote.dir);
    }
    // A human recover fetches now: the network backoff that failure armed does not defer it (step 1).
    okPreview(await recover(p.core, null));
    // RECOVER_OFFLINE{fetch}: the displaced refs cannot be listed.
    const unfail = failGit(p, (args) => args[0] === 'ls-remote');
    try {
      assert.equal(offlineOf(await recover(p.core, null))['reason'], 'fetch');
    } finally {
      unfail();
    }

    // RECOVER_AMBIGUOUS: a displaced candidate that forks from LA_B's chain; the params name the displaced refs.
    const F = await boardOn(p, B1, await liveOn(p, [L1]));
    const fref = p.core.refs.displaced(F);
    await forceRemote(fx, p, fref, F);
    const amb = await recover(p.core, null);
    assert.equal(refusal(amb), 'RECOVER_AMBIGUOUS');
    assert.ok(!amb.ok && Array.isArray(amb.params['candidates']) && (amb.params['candidates'] as string[]).includes(F) && (amb.params['candidates'] as string[]).includes(B2), JSON.stringify(amb));
    assert.deepEqual(!amb.ok && amb.params['displaced'], [p.core.refs.displaced(B2), fref].sort(), 'the displaced ref names');
    await forceRemote(fx, p, fref, null);

    // RECOVER_DISPLACED_FULL: V is not on X's chain and 3 displaced refs exist (V forks at the displaced B0 but its last
    // parent jumps, so the team-already-recovered check fails and the normal recover needs a slot for V).
    const G = await boardOn(p, B0, await liveOn(p, [await liveOn(p, [L0])]));
    await forceRemote(fx, p, board, G);
    for (const o of [B0, B1]) await gitRemote(fx, ['update-ref', p.core.refs.displaced(o), o]);
    assert.equal(Object.keys(await remoteDisplaced(fx, p)).length, 3);
    const full = await recover(p.core, null);
    assert.equal(refusal(full), 'RECOVER_DISPLACED_FULL');
    assert.equal(refusal(await recover(p.core, 'abcdef')), 'RECOVER_DISPLACED_FULL');

    assert.equal(pushSpawnsOf(gitCallsOf(p)), spawns1, 'no refusal pushes anything');
    assert.equal(await p.core.repo.readRef(p.core.refs.state), state0, 'no refusal changes the state');
    assert.ok(inIncident(p));
  });
});

test('a mirror moved onto the bad chain is healed by the recover push', async () => {
  await withCores('recover-mirror', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { remoteBoard: board, remoteCode: code } = p.core.refs;
    const { board: B1 } = await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
    await catchUp(fx, p);
    const B0 = await firstParent(p, B1);
    const L1 = await liveOf(p, B1);
    const bad = await liveOn(p, [await liveOf(p, B0)]);
    await forceRemote(fx, p, board, B0);
    await forceRemote(fx, p, code, bad);
    await detect(fx, p);
    const prev = await recover(p.core, null);
    okPreview(prev);
    const from = fx.trace.events.length;
    const r = await recover(p.core, prev.preview.id);
    okPreview(r);
    assert.equal(r.done, true);
    assert.equal((await fx.remote.refs())[code], L1, 'the mirror equals live_code(X)');
    const rp = pushesOf(fx, p, from).find((e) => e.purpose === 'recover')!;
    assert.ok(rp.argv.includes(`--force-with-lease=${code}:${bad}`), 'leased on the fetched mirror');
  });
});

test('a teammate completed recover, then a peer whose LA_B is the displaced rewrite confirms: RECOVER_AMBIGUOUS, never a force push of the rewrite over the restored board', async () => {
  await withCores('recover-stale-after-team', { n: 2, files: FILES }, async (fx) => {
    const [p1, p2] = [fx.peers[0]!, fx.peers[1]!];
    const board = p1.core.refs.remoteBoard;
    const { board: B1 } = await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
    for (const p of fx.peers) await catchUp(fx, p);
    const { board: B2 } = await fx.pushTeamChange({ 'x.txt': buf('x v2\n') });
    await catchUp(fx, p1);
    // A well-shaped rewrite forking at B1 (its live step carries B2's tree, so applying it moves LA_B): p2, still at B1,
    // takes it as an ordinary fast-forward; p1 detects it.
    const L2tree = (await p1.core.repo.readCommit(await liveOf(p1, B2))).tree;
    const F = await boardOn(p1, B1, await liveOn(p1, [await liveOf(p1, B1)], L2tree));
    await forceRemote(fx, p1, board, F);
    await catchUp(fx, p2);
    assert.equal(p2.core.view!.laB, F);
    // p1 recovers B2 over F (F kept in p1's own displaced/<p1>/v-1).
    await detect(fx, p1);
    const prev1 = await recover(p1.core, null);
    okPreview(prev1);
    assert.deepEqual([prev1.preview.mode, prev1.preview.V, prev1.preview.X], ['restore', F, B2]);
    okPreview(await recover(p1.core, prev1.preview.id));
    assert.equal((await fx.remote.refs())[board], B2);

    // p2 is the stale peer now: its LA_B F is off the restored chain; it pushes its copy of F.
    await detect(fx, p2);
    assert.deepEqual(await remoteDisplaced(fx, p2), { [p2.core.refs.displaced(B2)]: B2, [vCopyRef(p1, 1)]: F, [p2.core.refs.displaced(F)]: F });
    const remote0 = await fx.remote.refs();
    const state0 = await p2.core.repo.readRef(p2.core.refs.state);
    const spawns = pushSpawnsOf(gitCallsOf(p2));
    // p1's detection copy of B2 equals V and stays a candidate (only recover's own v-<n> copies are dropped): F and B2
    // fork at B1, so neither holds the other.
    const amb = await recover(p2.core, null);
    assert.equal(refusal(amb), 'RECOVER_AMBIGUOUS');
    assert.deepEqual(!amb.ok && amb.params['candidates'], [B2, F].sort());
    assert.deepEqual(!amb.ok && amb.params['displaced'], [p2.core.refs.displaced(B2), p2.core.refs.displaced(F)].sort());
    // A confirm, whatever id it carries, refuses the same way.
    assert.equal(refusal(await recover(p2.core, 'abcdef')), 'RECOVER_AMBIGUOUS');
    assert.deepEqual(await fx.remote.refs(), remote0, 'the restored board stays');
    assert.equal(pushSpawnsOf(gitCallsOf(p2)), spawns, 'no push');
    assert.equal(await p2.core.repo.readRef(p2.core.refs.state), state0, 'no state change');
    assert.ok(inIncident(p2));

    // With the fork point B1 displaced too (an earlier incident's copy), step 2a(i) leaves the displaced value equal to V
    // out, so the same peer re-anchors onto the restored board: still no push of any kind.
    await gitRemote(fx, ['update-ref', p2.core.refs.displaced(B1), B1]);
    const re = await recover(p2.core, null);
    okPreview(re);
    assert.deepEqual([re.preview.mode, re.preview.V, re.preview.X], ['reanchor', B2, null]);
    const done = await recover(p2.core, re.preview.id);
    okPreview(done);
    assert.equal(done.done, true);
    assert.equal(pushSpawnsOf(gitCallsOf(p2)), spawns, 'no push');
    assert.equal((await fx.remote.refs())[board], B2, 'the restored board stays');
    assert.equal(p2.core.view!.laB, B2);
    assert.ok(!inIncident(p2));
  });
});

test('restore never force-pushes an X whose chain fails the incident CHECK or that is not board-shaped: RECOVER_AMBIGUOUS{x_check, ref} before any push or crashpoint', async () => {
  await withCores('recover-x-check', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const refs = p.core.refs;
    const { board: B1 } = await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
    await catchUp(fx, p);
    const B0 = await firstParent(p, B1);
    const [L0, L1] = [await liveOf(p, B0), await liveOf(p, B1)];
    // V: a well-shaped rewrite forking at B0, so a restore would first copy V (step 4) and pass recover.displaced.
    const V = await boardOn(p, B0, await liveOn(p, [L0]));
    await forceRemote(fx, p, refs.remoteBoard, V);
    await detect(fx, p);
    const state0 = await p.core.repo.readRef(refs.state);
    const remote0 = await fx.remote.refs();
    const spawns = pushSpawnsOf(gitCallsOf(p));

    const xCheck = async (X: Oid, why: string): Promise<void> => {
      const ref = refs.displaced(X);
      await forceRemote(fx, p, ref, X);
      const pv = await recover(p.core, null);
      assert.equal(refusal(pv), 'RECOVER_AMBIGUOUS');
      assert.deepEqual(!pv.ok && [pv.params['reason'], pv.params['ref'], pv.params['why']], ['x_check', ref, why], JSON.stringify(pv));
      const hits: string[] = [];
      setCrashHandler((name) => {
        if (name.startsWith('recover.')) hits.push(name);
      });
      let c: RecoverResult;
      try {
        c = await recover(p.core, 'abcdef');
      } finally {
        setCrashHandler(null);
      }
      assert.equal(refusal(c), 'RECOVER_AMBIGUOUS');
      assert.equal(!c.ok && c.params['reason'], 'x_check');
      assert.deepEqual(hits, [], 'no crashpoint: the check runs before step 4');
      assert.equal(pushSpawnsOf(gitCallsOf(p)), spawns, 'no push: neither the copy of V nor X');
      assert.deepEqual(await fx.remote.refs(), { ...remote0, [ref]: X });
      await forceRemote(fx, p, ref, null);
    };
    // A copy of a newer chain whose last parent jumps (two live steps in one board commit): live_shape.
    await xCheck(await boardOn(p, B1, await liveOn(p, [await liveOn(p, [L1])])), 'live_shape');
    // A commit on B1 that is not a board commit (no markers): board_shape.
    const tree = (await p.core.repo.readCommit(B1)).tree;
    await xCheck(await p.core.repo.commitTree({ tree, parents: [B1, L1], subject: 'not a board commit', trailers: [] }), 'board_shape');

    assert.equal(await p.core.repo.readRef(refs.state), state0, 'no state change');
    assert.ok(inIncident(p));
    // Without the bad copies X is LA_B again and the restore runs.
    const prev = await recover(p.core, null);
    okPreview(prev);
    assert.deepEqual([prev.preview.mode, prev.preview.V, prev.preview.X], ['restore', V, B1]);
  });
});

test('a displaced candidate whose live code is malformed remote content (a parentless live commit) fails step 2a\'s CHECK, never throws, and the normal recover restores LA_B', async () => {
  await withCores('recover-remote-content', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { remoteBoard: board } = p.core.refs;
    const { board: B1 } = await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
    await catchUp(fx, p);
    // L0: the root live code commit at the bottom of every board chain (the genesis board's only parent).
    const L0 = (await p.core.repo.firstParents(B1, null, 1_000)).at(-1)!;
    assert.deepEqual((await p.core.repo.readCommit(L0)).parents, []);
    // V straight on L0: the newest first-parent commit of LA_B's chain on V's is L0.
    const tree = (await p.core.repo.readCommit(B1)).tree;
    const V = await p.core.repo.commitTree({ tree, parents: [L0, await liveOn(p, [L0])], subject: 'a rewrite on the live root', trailers: [] });
    await forceRemote(fx, p, board, V);
    await detect(fx, p);
    // A displaced ref holding L0: step 2a's D, whose live code does not exist (live_code(L0): RemoteContentError).
    await forceRemote(fx, p, p.core.refs.displaced(L0), L0);
    const r = await recover(p.core, null);
    okPreview(r);
    assert.deepEqual([r.preview.mode, r.preview.V, r.preview.X, r.preview.candidates], ['restore', V, B1, [B1, L0].sort()]);
    const done = await recover(p.core, r.preview.id);
    okPreview(done);
    assert.equal(done.done, true);
    assert.equal((await fx.remote.refs())[board], B1);
    assert.equal((await fx.remote.refs())[vCopyRef(p, 1)], V);
    assert.ok(!inIncident(p));
  });
});

test('a confirm killed at recover.displaced re-runs to completion: the copy of V is reused, X goes to the board and live_code(X) to the mirror, INCIDENT clears', async () => {
  await withCores('recover-rerun-displaced', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { remoteBoard: board, remoteCode: code } = p.core.refs;
    const { board: B1 } = await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
    await catchUp(fx, p);
    const B0 = await firstParent(p, B1);
    const L1 = await liveOf(p, B1);
    const Lx = await liveOn(p, [await liveOf(p, B0)]);
    const V = await boardOn(p, B0, Lx);
    await forceRemote(fx, p, board, V);
    await forceRemote(fx, p, code, Lx);
    await detect(fx, p);
    const prev = await recover(p.core, null);
    okPreview(prev);
    assert.deepEqual([prev.preview.mode, prev.preview.V, prev.preview.X], ['restore', V, B1]);

    await killedAt('recover.displaced', () => recover(p.core, prev.preview.id));
    const vref = vCopyRef(p, 1);
    assert.deepEqual(await remoteDisplaced(fx, p), { [p.core.refs.displaced(B1)]: B1, [vref]: V }, 'V was copied before the kill');
    assert.equal((await fx.remote.refs())[board], V);
    assert.ok(inIncident(p));

    // The re-run: V's own copy is no candidate, so the plan (and its id) is the same.
    const again = await recover(p.core, null);
    okPreview(again);
    assert.equal(again.preview.id, prev.preview.id);
    const spawns = pushSpawnsOf(gitCallsOf(p));
    const done = await recover(p.core, again.preview.id);
    okPreview(done);
    assert.equal(done.done, true);
    assert.equal(pushSpawnsOf(gitCallsOf(p)) - spawns, 1, 'only the recover push: no second copy of V');
    const after = await fx.remote.refs();
    assert.equal(after[board], B1, 'the board is X');
    assert.equal(after[code], L1, 'the mirror is live_code(X)');
    assert.deepEqual(await remoteDisplaced(fx, p), { [p.core.refs.displaced(B1)]: B1, [vref]: V }, 'one copy of V');
    assert.ok(!inIncident(p));
  });
});

test('a copy of V or a recover push rejected by the host refuses RECOVER_OFFLINE{rejected}, one that loses its lease RECOVER_OFFLINE{lease_lost}, and a re-run completes', async () => {
  await withCores('recover-push-failures', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { remoteBoard: board } = p.core.refs;
    const { board: B1 } = await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
    await catchUp(fx, p);
    const B0 = await firstParent(p, B1);
    const L0 = await liveOf(p, B0);
    const F1 = await boardOn(p, B0, await liveOn(p, [L0]));
    const F2 = await boardOn(p, B0, await liveOn(p, [L0]));
    assert.notEqual(F1, F2);
    await forceRemote(fx, p, board, F1);
    await detect(fx, p);
    const [v1, v2] = [vCopyRef(p, 1), vCopyRef(p, 2)];

    // The host rejects the copy of V (step 4).
    await fx.remote.rejectNext(1, 'transient-failed', '/v-');
    let prev = await recover(p.core, null);
    okPreview(prev);
    const r1 = offlineOf(await recover(p.core, prev.preview.id));
    assert.deepEqual([r1['reason'], r1['push']], ['rejected', 'displaced']);
    assert.equal((await fx.remote.refs())[v1], undefined);

    // The host rejects the recover push (the board stays V): a transient rejection.
    await fx.remote.rejectNext(1, 'transient-failed', board);
    prev = await recover(p.core, null);
    okPreview(prev);
    const r2 = offlineOf(await recover(p.core, prev.preview.id));
    assert.deepEqual([r2['reason'], r2['push']], ['rejected', 'recover']);
    assert.equal((await fx.remote.refs())[v1], F1, 'the copy of V landed before the rejected recover push');
    assert.equal((await fx.remote.refs())[board], F1);

    // Another rewrite lands between the plan and the recover push: its lease is lost.
    prev = await recover(p.core, null);
    okPreview(prev);
    assert.equal(prev.preview.V, F1);
    const unwrap = wrapGit(p, async (args, opts, inner) => {
      if (args[0] === 'push' && args.includes(`--force-with-lease=${board}:${F1}`)) await forceRemote(fx, p, board, F2);
      return inner(args, opts);
    });
    let r3: RecoverResult;
    try {
      r3 = await recover(p.core, prev.preview.id);
    } finally {
      unwrap();
    }
    assert.deepEqual([offlineOf(r3)['reason'], offlineOf(r3)['push']], ['lease_lost', 'recover']);
    assert.equal((await fx.remote.refs())[board], F2);
    assert.ok(inIncident(p));

    // The re-run: the copy of F1 is no candidate; the new V gets its own copy.
    prev = await recover(p.core, null);
    okPreview(prev);
    assert.deepEqual([prev.preview.V, prev.preview.X, prev.preview.candidates], [F2, B1, [B1]]);
    const done = await recover(p.core, prev.preview.id);
    okPreview(done);
    assert.equal(done.done, true);
    assert.equal((await fx.remote.refs())[board], B1);
    assert.deepEqual(await remoteDisplaced(fx, p), { [p.core.refs.displaced(B1)]: B1, [v1]: F1, [v2]: F2 });
    assert.ok(!inIncident(p));
  });
});

test('a late peer after a completed recover that displaced V restores its newer chain before the team builds on X and re-anchors after, never RECOVER_AMBIGUOUS; a failing first-parent walk in step 2a refuses RECOVER_OFFLINE{walk}', async () => {
  await withCores('recover-late-after-restore', { n: 2, files: FILES }, async (fx) => {
    const [px, py] = [fx.peers[0]!, fx.peers[1]!];
    const board = px.core.refs.remoteBoard;
    const { board: B1 } = await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
    const { board: B2 } = await fx.pushTeamChange({ 'x.txt': buf('x v2\n') });
    for (const p of fx.peers) await catchUp(fx, p);
    await fx.pushTeamChange({ 'y.txt': buf('y on the old chain\n') });
    const { board: B4 } = await fx.pushTeamChange({ 'w.txt': buf('w on the old chain\n') });
    await catchUp(fx, py);
    // A well-shaped rewrite forking at B1 while Y sleeps; X detects it, recovers B2 and keeps V in its own
    // displaced/<px>/v-1.
    const F = await boardOn(px, B1, await liveOn(px, [await liveOf(px, B1)]));
    await forceRemote(fx, px, board, F);
    await detect(fx, px);
    const xp = await recover(px.core, null);
    okPreview(xp);
    assert.deepEqual([xp.preview.X, xp.preview.V], [B2, F]);
    okPreview(await recover(px.core, xp.preview.id));
    assert.equal((await fx.remote.refs())[vCopyRef(px, 1)], F);
    assert.equal((await fx.remote.refs())[board], B2);

    // Y wakes before the team builds on B2: its LA_B is ahead of X, so its recover restores its newer chain (step 3: the
    // copy of F is recover's own and no candidate; the displaced B2, equal to V, is one and lies on B4's chain, so X = B4,
    // a fast-forward; never AMBIGUOUS).
    await detect(fx, py);
    const a = await recover(py.core, null);
    okPreview(a);
    assert.deepEqual([a.preview.mode, a.preview.V, a.preview.X, a.preview.candidates], ['restore', B2, B4, [B2, B4].sort()]);

    // The team builds on B2 (Y did not confirm).
    await fx.pushTeamChange({ 't.txt': buf('t on the new chain\n') });
    const { board: Bn } = await fx.pushTeamChange({ 'x.txt': buf('x v3 on the new chain\n') });

    // Step 2a fails closed: a failing first-parent walk of V is no proof either way.
    const unfail = failGit(py, (args) => args[0] === 'rev-list' && args.includes('--first-parent') && args.includes(Bn) && !args.some((x) => x.startsWith('^')));
    try {
      assert.equal(offlineOf(await recover(py.core, null))['reason'], 'walk');
    } finally {
      unfail();
    }
    const b = await recover(py.core, null);
    okPreview(b);
    assert.deepEqual([b.preview.mode, b.preview.V, b.preview.X], ['reanchor', Bn, null]);
    const spawns = pushSpawnsOf(gitCallsOf(py));
    const done = await recover(py.core, b.preview.id);
    okPreview(done);
    assert.equal(done.done, true);
    assert.equal(pushSpawnsOf(gitCallsOf(py)), spawns, 'no push');
    assert.equal(py.core.view!.laB, Bn);
    assert.ok(!inIncident(py));
    assert.deepEqual(await localDisplaced(py), [], 'the re-anchor deletes the local copies of the displaced refs');
  });
});

test('a late peer whose newer commits are not on the restored chain re-anchors: no force push, incident-<n>-own written before any state change, recover.reanchor hit, own-only bytes become restart records, a new epoch, LOST_STATE{re_anchor}', async () => {
  await withCores('recover-reanchor', { n: 2, files: FILES }, async (fx) => {
    const [px, py] = [fx.peers[0]!, fx.peers[1]!];
    const refs = py.core.refs;
    // Everyone is at B2 ("B100").
    const { board: B1 } = await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
    const { board: B2 } = await fx.pushTeamChange({ 'x.txt': buf('x v2\n') });
    for (const p of fx.peers) await catchUp(fx, p);
    // Y alone sees B3, B4 ("B101..B105"); X is offline.
    await fx.pushTeamChange({ 'y.txt': buf('y on the old chain\n') });
    const { board: B4 } = await fx.pushTeamChange({ 'w.txt': buf('w on the old chain\n') });
    await catchUp(fx, py);
    // The board is rewound to B1 ("B50"); X detects it and recovers B2; the team continues on B2.
    await forceRemote(fx, px, refs.remoteBoard, B1);
    await detect(fx, px);
    const px1 = await recover(px.core, null);
    okPreview(px1);
    assert.deepEqual([px1.preview.mode, px1.preview.X], ['restore', B2]);
    okPreview(await recover(px.core, px1.preview.id));
    assert.equal((await fx.remote.refs())[refs.remoteBoard], B2);
    await fx.pushTeamChange({ 't.txt': buf('t on the new chain\n') });
    const { board: Bn } = await fx.pushTeamChange({ 'x.txt': buf('x v3 on the new chain\n') });
    await catchUp(fx, px);

    // Y wakes: INCIDENT, its displaced copy of B4.
    await detect(fx, py);
    assert.deepEqual(await remoteDisplaced(fx, py), { [refs.displaced(B2)]: B2, [refs.displaced(B4)]: B4 });
    const n = py.core.view!.meta.incident!.n;
    // Y has unlanded ops: one allocated under its old epoch (a publish built it), one never placed.
    const FREEZE: OpDraft = { type: 'event', cid: '', kind: 'freeze', refs: [], reason_code: 'EPOCH' };
    const UNFREEZE: OpDraft = { type: 'event', cid: '', kind: 'unfreeze', refs: [], reason_code: 'EPOCH' };
    const epoch0 = py.core.view!.meta.epoch;
    let seq = py.core.view!.meta.seq_next;
    py.core.outbox.add(FREEZE);
    assert.equal(py.core.outbox.take([], { peer: py.core.peerId, epoch: epoch0 }, { next: () => seq++ }, { maxOps: 1_000, maxBytes: 65_536 }).length, 1);
    py.core.outbox.add(UNFREEZE);
    await py.core.commit({ meta: { ...py.core.view!.meta, seq_next: seq, outbox: py.core.outbox.toJson() } });
    const outbox0 = py.core.view!.meta.outbox;
    const drafts = { entries: [{ draft: FREEZE, op: null }, { draft: UNFREEZE, op: null }] } as unknown as Json;

    // A re-anchor needs the symbolic branch HEAD: a detached HEAD refuses and nothing is written.
    const state0 = await py.core.repo.readRef(refs.state);
    await gitIn(py, ['checkout', '-q', '--detach']);
    try {
      const h = await recover(py.core, null);
      assert.equal(refusal(h), 'RECOVER_HEAD_STATE');
      assert.deepEqual(!h.ok && h.params, { op: 'detached' });
    } finally {
      await gitIn(py, ['checkout', '-q', 'main']);
    }
    assert.equal(await py.core.repo.readRef(refs.state), state0);
    assert.equal(await py.core.repo.readRef(refs.incidentOwn(n)), null, 'no incident-<n>-own');

    const prev = await recover(py.core, null);
    okPreview(prev);
    assert.deepEqual(
      { mode: prev.preview.mode, V: prev.preview.V, X: prev.preview.X, restartPaths: prev.preview.restartPaths },
      { mode: 'reanchor', V: Bn, X: null, restartPaths: ['w.txt', 'y.txt'] },
    );
    const spawns0 = pushSpawnsOf(gitCallsOf(py));
    const remote0 = await fx.remote.refs();

    // A kill at recover.reanchor: incident-<n>-own is written, the state is not changed; after a restart nothing of the
    // re-anchor happened and the outbox is intact.
    await killedAt('recover.reanchor', () => recover(py.core, prev.preview.id));
    assert.equal(await py.core.repo.readRef(refs.incidentOwn(n)), B4, 'incident-<n>-own holds LA_B');
    assert.equal(await py.core.repo.readRef(refs.state), state0, 'no state change before the crashpoint');
    await restartCore(py);
    await startOk(py, 'restart');
    assert.ok(inIncident(py), 'none of the re-anchor');
    assert.equal(py.core.view!.laB, B4);
    assert.deepEqual(py.core.view!.meta.outbox, outbox0, 'the outbox is intact');

    // Run again; the process dies right after the rebuild's LOST_STATE line, i.e. after its state update: after a restart
    // the whole re-anchor is there (ONE state update), with the outbox rebuilt.
    const again = await recover(py.core, null);
    okPreview(again);
    assert.equal(again.preview.mode, 'reanchor');
    const log = new KillAfterLog('LOST_STATE');
    py.deps.log = log;
    const hits: string[] = [];
    setCrashHandler((name) => {
      if (name.startsWith('recover.')) hits.push(name);
    });
    try {
      await assert.rejects(recover(py.core, again.preview.id), KilledAt);
    } finally {
      setCrashHandler(null);
    }
    assert.deepEqual(hits, ['recover.reanchor']);
    assert.ok(log.lines.some((l) => l.code === 'LOST_STATE' && l.params['mode'] === 're_anchor'), log.text());
    py.deps.log = new LogRecorder();
    await restartCore(py);
    await startOk(py, 'restart');
    assert.equal(pushSpawnsOf(gitCallsOf(py)), spawns0, 'no push of any kind: never a force push over the team');
    assert.deepEqual(await fx.remote.refs(), remote0, 'the remote is unchanged');
    const view = py.core.view!;
    assert.equal(view.laB, Bn, 'LA_B := V');
    assert.equal(view.laC, await liveOf(py, Bn), 'LA_C := live_code(V)');
    assert.notEqual(view.meta.epoch, epoch0, 'a new epoch');
    assert.ok(!inIncident(py) && view.meta.incident === null, 'INCIDENT is cleared');
    assert.deepEqual(view.meta.displaced, []);
    assert.equal(view.meta.fold_board, Bn, 'the fold persisted with the re-anchor is the new LA_B\'s');
    assert.ok(view.fold !== null && serializeFold(view.fold).equals(serializeFold((await new Folder(py.core.repo, py.core.peerId).foldTo(Bn, null, PLAN2_REGION_SPEC)).state)));
    // The same drafts, no op allocated under the old epoch, led by the new epoch's join op (final review FC-7).
    const rebuilt = (view.meta.outbox as { entries: Array<{ draft: { type: string }; op: unknown }> }).entries;
    assert.deepEqual([rebuilt[0]!.draft.type, rebuilt[0]!.op], ['join', null], 'the join op of the new epoch leads');
    assert.deepEqual({ entries: rebuilt.slice(1) }, drafts, 'then the same drafts, no op allocated under the old epoch');
    assert.equal(await py.core.repo.readRef(refs.incidentOwn(n)), B4);
    const recs = py.core.holds.nonTerminal().filter((h) => h.guards.some((g) => g.name === 'restart'));
    assert.deepEqual(recs.map((h) => h.paths[0]).sort(), ['w.txt', 'y.txt'], 'own-only bytes become restart records');
    for (const h of recs) {
      const path = h.paths[0]!;
      assert.ok('h1' in h.blobs && h.blobs.h1[path] === await blob(py, `${path[0]} on the old chain\n`), `${path}: the record holds the own bytes`);
      assert.ok(py.core.holds.maskingRecords().some((m) => m.id === h.id), `${path}: masked`);
    }
    assert.equal((await readWork(py, 'y.txt'))?.toString('utf8'), 'y on the old chain\n', 'the own bytes stay on disk');

    // No other peer enters INCIDENT; Y follows the team without touching its recorded paths, and its next publish sends
    // the rebuilt ops under the new epoch.
    fx.advance(PAST_WINDOW_MS);
    assert.equal((await poll(px)).incident, false);
    for (let i = 0; i < 5 && py.core.outbox.size > 0; i++) {
      fx.advance(PAST_WINDOW_MS);
      assert.equal((await poll(py)).incident, false);
    }
    assert.equal(py.core.outbox.size, 0, 'the rebuilt ops landed');
    const epoch1 = py.core.view!.meta.epoch;
    let sent: Array<{ id: string; type: string; kind?: string }> = [];
    for (const c of await py.core.repo.firstParents(py.core.view!.laB, Bn, 10)) {
      const ops = (await readBoardCommit(py.core.repo, c)).opsLines.map((l) => JSON.parse(l) as { id: string; type: string; kind?: string });
      sent = [...ops.filter((o) => parseOpId(o.id)?.peer === py.core.peerId), ...sent];
    }
    assert.deepEqual(sent.map((o) => o.kind ?? o.type), ['join', 'freeze', 'unfreeze'], 'the join op of the new epoch first (final review FC-7)');
    assert.ok(sent.every((o) => parseOpId(o.id)?.epoch === epoch1), `sent under the new epoch: ${JSON.stringify(sent)}`);
    assert.equal((await readWork(py, 't.txt'))?.toString('utf8'), 't on the new chain\n');
    assert.equal((await readWork(py, 'x.txt'))?.toString('utf8'), 'x v3 on the new chain\n');
    assert.equal((await readWork(py, 'y.txt'))?.toString('utf8'), 'y on the old chain\n');
    assert.equal((await stateA(py)).get('y.txt')?.oid, await blob(py, 'y v0\n'), 'A follows the team chain');
  });
});

test('a bad-shaped commit on the restored tip and a plain rewind with an old displaced ref take the normal recover, not the re-anchor', async () => {
  await withCores('recover-controls', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { remoteBoard: board } = p.core.refs;
    const { board: B1 } = await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
    const { board: B2 } = await fx.pushTeamChange({ 'x.txt': buf('x v2\n') });
    const { board: B3 } = await fx.pushTeamChange({ 'y.txt': buf('y v1\n') });
    await catchUp(fx, p);
    const B0 = await firstParent(p, B1);
    const [L1, L2] = [await liveOf(p, B1), await liveOf(p, B2)];
    // B2 was restored by an earlier recover: its displaced copy is a candidate; this peer's chain goes on to B3.
    await gitRemote(fx, ['update-ref', p.core.refs.displaced(B2), B2]);

    // A bad-shaped commit pushed on top of B2 (its last parent jumps): the check from B2 fails, so no re-anchor.
    const bad = await boardOn(p, B2, await liveOn(p, [await liveOn(p, [L2])]));
    await forceRemote(fx, p, board, bad);
    await detect(fx, p);
    const a = await recover(p.core, null);
    okPreview(a);
    assert.deepEqual([a.preview.mode, a.preview.V, a.preview.X], ['restore', bad, B3]);

    // A well-shaped rewrite forking at B1, where no displaced candidate is: no re-anchor either.
    const fork = await boardOn(p, B1, await liveOn(p, [L1]));
    await forceRemote(fx, p, board, fork);
    const c = await recover(p.core, null);
    okPreview(c);
    assert.deepEqual([c.preview.mode, c.preview.V, c.preview.X], ['restore', fork, B3]);

    // A plain rewind to B1 while an old displaced copy of B0 from an earlier incident still exists.
    await gitRemote(fx, ['update-ref', p.core.refs.displaced(B0), B0]);
    await forceRemote(fx, p, board, B1);
    const b = await recover(p.core, null);
    okPreview(b);
    assert.deepEqual([b.preview.mode, b.preview.V, b.preview.X], ['restore', B1, B3]);
    assert.ok(b.preview.candidates.includes(B0));
    const done = await recover(p.core, b.preview.id);
    okPreview(done);
    assert.equal(done.done, true);
    assert.equal((await fx.remote.refs())[board], B3, 'the normal recover pushed X');
    assert.ok(!inIncident(p));
  });
});

test('a kept push intent: the preview reports it and changes nothing; a confirm resolves it first — unresolved refuses RECOVER_OFFLINE{push_intent_unresolved} with the state unchanged, not landed discards it and the same id goes on', async () => {
  await withCores('recover-intent-not-landed', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const board = p.core.refs.remoteBoard;
    const { board: B1 } = await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
    await catchUp(fx, p);
    const B0 = await firstParent(p, B1);
    await editAndCapture(fx, p, { 'y.txt': 'y local\n' });
    fx.advance(30_000);
    const it = await prep(p);
    await killedAt('publish.out_built', () => publishStep(p.core, it));
    const kept = p.core.view!.intent;
    assert.ok(kept.kind === 'push');
    // The board is rewound; the restarted peer cannot resolve the intent (its check fails) and enters INCIDENT.
    await forceRemote(fx, p, board, B0);
    await restartCore(p);
    const s = await startOk(p, 'restart');
    assert.equal(s.restart?.pushResolved, null);
    await detect(fx, p);
    assert.equal(p.core.view!.intent.kind, 'push');

    const state0 = await p.core.repo.readRef(p.core.refs.state);
    const prev = await recover(p.core, null);
    okPreview(prev);
    assert.deepEqual(prev.preview.pushIntent, { bnew: kept.bnew, lease_board: kept.lease_board }, 'the preview reports the kept intent');
    assert.deepEqual([prev.preview.mode, prev.preview.V, prev.preview.X], ['restore', B0, B1]);
    assert.equal(await p.core.repo.readRef(p.core.refs.state), state0, 'the preview changes nothing');

    // Unresolved: the first-parent walk of the fetched board after the lease fails.
    const spawns = pushSpawnsOf(gitCallsOf(p));
    const unfail = failGit(p, (args) => args[0] === 'rev-list' && args.includes(`^${kept.lease_board}`));
    try {
      assert.equal(offlineOf(await recover(p.core, prev.preview.id))['reason'], 'push_intent_unresolved');
    } finally {
      unfail();
    }
    assert.equal(await p.core.repo.readRef(p.core.refs.state), state0, 'the state is unchanged');
    assert.equal(p.core.view!.intent.kind, 'push');
    assert.equal(pushSpawnsOf(gitCallsOf(p)), spawns, 'no push');

    // Not landed (Bnew is not on V's chain): discarded, (LA_B, V, X, A) did not move, so the same id restores.
    const done = await recover(p.core, prev.preview.id);
    okPreview(done);
    assert.equal(done.done, true);
    assert.equal(p.core.view!.intent.kind, 'none');
    assert.equal((await fx.remote.refs())[board], B1);
    assert.ok(!inIncident(p));
  });
});

test('a kept push intent that landed below a bad commit: the confirm resolves it (LA_B moves), refuses RECOVER_PREVIEW_STALE with a fresh preview and pushes nothing; the fresh id restores Bnew', async () => {
  await withCores('recover-intent-landed', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const board = p.core.refs.remoteBoard;
    await editAndCapture(fx, p, { 'y.txt': 'y local\n' });
    fx.advance(30_000);
    const it = await prep(p);
    const laB0 = p.core.view!.laB;
    await killedAt('publish.landed', () => publishStep(p.core, it));
    const kept = p.core.view!.intent;
    assert.ok(kept.kind === 'push');
    const bnew = kept.bnew;
    assert.equal((await fx.remote.refs())[board], bnew, 'the push landed');
    // A bad-shaped commit on top of Bnew (its last parent jumps): the restarted peer cannot observe its landing.
    const V = await boardOn(p, bnew, await liveOn(p, [await liveOn(p, [await liveOf(p, bnew)])]));
    await forceRemote(fx, p, board, V);
    await restartCore(p);
    assert.equal((await startOk(p, 'restart')).restart?.pushResolved, null);
    // INCIDENT; its ENG-21 copy of LA_B waits for an ordinary window.
    assert.equal((await poll(p)).incident, true);
    assert.deepEqual(await remoteDisplaced(fx, p), {}, 'the copy is still pending');
    assert.equal(p.core.view!.laB, laB0);

    const prev = await recover(p.core, null);
    okPreview(prev);
    assert.deepEqual([prev.preview.mode, prev.preview.V, prev.preview.X, prev.preview.pushIntent?.bnew], ['restore', V, laB0, bnew]);
    const spawns = pushSpawnsOf(gitCallsOf(p));
    const remote0 = await fx.remote.refs();
    const fresh = stalePreview(await recover(p.core, prev.preview.id));
    assert.deepEqual([fresh.mode, fresh.X], ['restore', bnew], 'the fresh preview restores Bnew');
    assert.notEqual(fresh.id, prev.preview.id);
    assert.equal(pushSpawnsOf(gitCallsOf(p)), spawns, 'nothing pushed');
    assert.deepEqual(await fx.remote.refs(), remote0, 'the remote is unchanged');
    assert.equal(p.core.view!.laB, bnew, 'the intent was resolved as landed');
    assert.equal(p.core.view!.intent.kind, 'none');
    assert.ok(inIncident(p));

    // The pending copy goes out in the next window: the LA_B the incident entered with, under the name its INCIDENT
    // event gave (the cached ref and its value), although LA_B has moved since.
    fx.advance(PAST_WINDOW_MS);
    assert.equal((await poll(p)).incident, true);
    assert.deepEqual(await remoteDisplaced(fx, p), { [p.core.refs.displaced(laB0)]: laB0 }, 'the copy of the entry LA_B under its own name');
    const fresh2 = await recover(p.core, null);
    okPreview(fresh2);
    assert.deepEqual([fresh2.preview.mode, fresh2.preview.X, fresh2.preview.candidates], ['restore', bnew, [laB0, bnew].sort()]);

    const done = await recover(p.core, fresh2.preview.id);
    okPreview(done);
    assert.equal(done.done, true);
    assert.equal((await fx.remote.refs())[board], bnew);
    assert.equal((await fx.remote.refs())[vCopyRef(p, 1)], V);
    assert.ok(!inIncident(p));
  });
});

test('a deleted board (V = ABSENT) is restored with an ABSENT lease, also when the confirm is killed at recover.displaced and re-run after a real restart', async () => {
  await withCores('recover-board-deleted', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { remoteBoard: board, remoteCode: code } = p.core.refs;
    const { board: B1 } = await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
    await catchUp(fx, p);
    const L1 = await liveOf(p, B1);
    await gitRemote(fx, ['update-ref', '-d', board]);
    await detect(fx, p);
    const prev = await recover(p.core, null);
    okPreview(prev);
    assert.deepEqual([prev.preview.mode, prev.preview.V, prev.preview.X], ['restore', ABSENT, B1]);

    await killedAt('recover.displaced', () => recover(p.core, prev.preview.id));
    assert.equal((await fx.remote.refs())[board], undefined);
    await restartCore(p);
    await startOk(p, 'restart');
    assert.ok(inIncident(p), 'INCIDENT survives the restart');
    assert.equal((await poll(p)).why, 'board_missing');

    const again = await recover(p.core, null);
    okPreview(again);
    assert.equal(again.preview.id, prev.preview.id);
    const from = fx.trace.events.length;
    const done = await recover(p.core, again.preview.id);
    okPreview(done);
    assert.equal(done.done, true);
    const pushes = pushesOf(fx, p, from);
    assert.deepEqual(pushes.map((e) => e.purpose), ['recover'], 'nothing to displace');
    assert.ok(pushes[0]!.argv.includes(`--force-with-lease=${board}:`) && pushes[0]!.argv.includes(`${B1}:${board}`), 'X over an ABSENT board');
    const after = await fx.remote.refs();
    assert.equal(after[board], B1);
    assert.equal(after[code], L1);
    assert.deepEqual(await remoteDisplaced(fx, p), { [p.core.refs.displaced(B1)]: B1 });
    assert.ok(!inIncident(p));
  });
});

test('displaced refs from the remote: names failing the path, portability or shape checks are skipped and logged, at most 12 are fetched, a non-commit value is no candidate, and a copy ahead of LA_B that passes the incident CHECK is X', async () => {
  await withCores('recover-displaced-names', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const refs = p.core.refs;
    const prefix = refs.displacedPrefix;
    const { board: B1 } = await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
    await catchUp(fx, p);
    const B0 = await firstParent(p, B1);
    const L1 = await liveOf(p, B1);
    await forceRemote(fx, p, refs.remoteBoard, B0);
    await detect(fx, p);
    // A copy of a newer, well-shaped chain: X by the first-parent rule, and its chain passes the CHECK from LA_B.
    const E = await boardOn(p, B1, await liveOn(p, [L1]));
    await forceRemote(fx, p, refs.displaced(E), E);
    // A well-shaped name holding a blob.
    const notCommit = await p.core.repo.hashBytes(buf('not a commit\n'), true);
    await forceRemote(fx, p, `${prefix}000000000000`, notCommit);
    // 13 more well-shaped names (holding V = B0) and three odd ones, in packed-refs (no file system has to hold them).
    const more: Record<string, Oid> = {};
    for (let i = 1; i <= 13; i++) more[`${prefix}ffffffffff${String(i).padStart(2, '0')}`] = B0;
    more[`${prefix}x|y`] = B1;
    more[`${prefix}ABCDEF012345`] = B1;
    more[`${prefix}notes`] = B1;
    await addPackedRefs(fx, more);

    // The prefix listing (lsRemotePrefix, src/git/fetch.ts) names every ref under the prefix, nested ones too.
    const listed = await lsRemotePrefix(p.core.repo, fx.remote.url, prefix);
    assert.ok(listed.ok);
    assert.equal(listed.values.size, 19);
    assert.equal(listed.values.get(`${prefix}x|y`), B1);

    const log = new LogRecorder();
    p.deps.log = log;
    const r = await recover(p.core, null);
    okPreview(r);
    // The fillers hold V (= B0): a displaced value equal to V stays a step-3 candidate (only recover's own v-<n> copies
    // are dropped); it lies on E's chain.
    assert.deepEqual([r.preview.mode, r.preview.V, r.preview.X, r.preview.candidates], ['restore', B0, E, [B0, B1, E].sort()]);
    assert.equal((await localDisplaced(p)).length, 12, 'at most DISPLACED_CAP x 4 fetched');
    const skipped = log.lines.filter((l) => l.code === 'DISPLACED_REF_SKIPPED').map((l) => String(l.params['reason'])).sort();
    assert.deepEqual(skipped, ['cap', 'cap', 'cap', 'cap', 'not_commit', 'portable', 'shape', 'shape'], log.text());
  });
});

test('every recover push is a counted governed push whose argv has --force-with-lease and never \'+\' or --force', async () => {
  await withCores('recover-governed', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { board: B1 } = await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
    await catchUp(fx, p);
    const B0 = await firstParent(p, B1);
    const V = await boardOn(p, B0, await liveOn(p, [await liveOf(p, B0)]));
    await forceRemote(fx, p, p.core.refs.remoteBoard, V);
    const from = fx.trace.events.length;
    const attempts0 = p.core.pushAttempts;
    const spawns0 = pushSpawnsOf(gitCallsOf(p));
    await detect(fx, p);
    const prev = await recover(p.core, null);
    okPreview(prev);
    okPreview(await recover(p.core, prev.preview.id));

    const pushes = pushesOf(fx, p, from);
    assert.deepEqual(pushes.map((e) => e.purpose), ['displaced', 'displaced', 'recover'], 'the detection copy, the copy of V, the recover push');
    assert.equal(p.core.pushAttempts - attempts0, 3, 'each one is a counted attempt');
    assert.equal(pushSpawnsOf(gitCallsOf(p)) - spawns0, 3, 'and nothing else spawned a push');
    for (const e of pushes) {
      const url = e.argv.indexOf(fx.remote.url);
      assert.ok(url > 0, JSON.stringify(e.argv));
      const specs = e.argv.slice(url + 1);
      assert.ok(specs.length > 0);
      for (const s of specs) {
        assert.ok(!s.startsWith('+'), `no forced refspec: ${s}`);
        const ref = s.slice(s.indexOf(':') + 1);
        assert.ok(e.argv.some((a) => a.startsWith(`--force-with-lease=${ref}:`)), `${ref} is leased`);
      }
      assert.ok(!e.argv.includes('--force'), 'never --force');
      assert.ok(e.argv.every((a) => !a.startsWith('--force') || a.startsWith('--force-with-lease=')), 'only explicit-expect leases');
    }
  });
});

test('lostStateRebuild\'s per-path primitive decides only the given paths against the chain\'s versions and changes nothing but A', async () => {
  await withCores('recover-perpath', { n: 1, files: { ...FILES, 'w.txt': buf('w v0\n') } }, async (fx) => {
    const p = fx.peers[0]!;
    await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
    await catchUp(fx, p);
    const { board: T } = await fx.pushTeamChange({ 'x.txt': buf('x v2\n') });   // fetched, not applied
    // The disk: x.txt back at the genesis version, local edits of y.txt (not asked) and w.txt (asked; no version matches).
    await writeWork(p, 'x.txt', 'x v0\n');
    await writeWork(p, 'y.txt', 'y local\n');
    await writeWork(p, 'w.txt', 'w local\n');
    fx.advance(2_000);
    await poll(p);   // fetches T; nothing is applied (inside the 10 s apply coalescing window)
    const before = p.core.view!;
    const A0 = await stateA(p);

    const r = await lostStateRebuild(p.core, T, 'lost_state', new Set(['x.txt', 'w.txt']));
    const view = p.core.view!;
    assert.deepEqual([view.laB, view.laC, view.snap, view.meta.epoch], [before.laB, before.laC, before.snap, before.meta.epoch], 'only A changes');
    const A = await stateA(p);
    assert.equal(A.get('x.txt')?.oid, await blob(p, 'x v0\n'), 'x.txt: the newest version on the chain the disk matches');
    assert.equal(A.get('w.txt')?.oid, await blob(p, 'w v0\n'), 'w.txt: unmatched, A := TIP[p] with a record');
    assert.equal(A.get('y.txt')?.oid, A0.get('y.txt')?.oid, 'y.txt: not asked, A keeps its entry');
    const recs = p.core.holds.nonTerminal().filter((h) => h.guards.some((g) => g.name === 'restart'));
    assert.deepEqual(recs.map((h) => h.paths), [['w.txt']], 'one record, for the asked unmatched path');
    assert.ok('h1' in recs[0]!.blobs && recs[0]!.blobs.h1['w.txt'] === await blob(p, 'w local\n'));
    assert.deepEqual(r, { mode: 'lost_state', records: [recs[0]!.id], paths: ['w.txt', 'x.txt'] });
  });
});

test('lostStateRebuild\'s per-path primitive with metaOverrides throws (a programming error) and changes nothing', async () => {
  await withCores('recover-perpath-overrides', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { board: T } = await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
    await catchUp(fx, p);
    const state0 = await p.core.repo.readRef(p.core.refs.state);
    await assert.rejects(lostStateRebuild(p.core, T, 'lost_state', new Set(['x.txt']), { displaced: [] }), /metaOverrides/);
    assert.equal(await p.core.repo.readRef(p.core.refs.state), state0, 'nothing changed');
  });
});

test('a clear whose deletion of the local displaced copies fails still clears INCIDENT: the failure is logged, and the next clear deletes them', async () => {
  await withCores('recover-drop-local', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const board = p.core.refs.remoteBoard;
    const { board: B1 } = await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
    await catchUp(fx, p);
    const B0 = await firstParent(p, B1);
    await forceRemote(fx, p, board, B0);
    await detect(fx, p);
    const prev = await recover(p.core, null);
    okPreview(prev);
    const kept = await localDisplaced(p);
    assert.ok(kept.length > 0, 'the preview fetched the displaced copies');

    const log = new LogRecorder();
    p.deps.log = log;
    const localPrefix = `refs/cowork-remote/${p.core.refs.e}/displaced/`;
    const unfail = failGit(p, (args) => args[0] === 'update-ref' && args[1] === '-d' && (args[2] ?? '').startsWith(localPrefix));
    let r: RecoverResult;
    try {
      r = await recover(p.core, prev.preview.id);
    } finally {
      unfail();
    }
    okPreview(r);
    assert.equal(r.done, true);
    assert.equal((await fx.remote.refs())[board], B1);
    assert.ok(!inIncident(p) && p.core.view!.meta.incident === null, 'INCIDENT is cleared');
    assert.deepEqual(await localDisplaced(p), kept, 'the local copies are still there');
    assert.ok(log.lines.some((l) => l.code === 'DISPLACED_LOCAL_DROP_FAILED' && kept.includes(String(l.params['ref']))), log.text());
    assert.ok(log.lines.some((l) => l.code === 'UNFROZEN' && l.params['by'] === 'recover'), log.text());

    // The next clear (a new incident that heals) deletes them.
    await forceRemote(fx, p, board, B0);
    await detect(fx, p);
    await forceRemote(fx, p, board, B1);
    fx.advance(PAST_WINDOW_MS);
    const healed = await poll(p);
    assert.equal(healed.cleared, true);
    assert.deepEqual(await localDisplaced(p), [], 'deleted at the next clear');
  });
});

test('a recover push the governor still denies after the cap wait refuses RECOVER_OFFLINE{denied} and changes nothing; the same id completes once it is allowed', async () => {
  await withCores('recover-denied', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const board = p.core.refs.remoteBoard;
    const { board: B1 } = await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
    await catchUp(fx, p);
    const B0 = await firstParent(p, B1);
    const V = await boardOn(p, B0, await liveOn(p, [await liveOf(p, B0)]));
    await forceRemote(fx, p, board, V);
    await detect(fx, p);
    const prev = await recover(p.core, null);
    okPreview(prev);
    const state0 = await p.core.repo.readRef(p.core.refs.state);
    const spawns = pushSpawnsOf(gitCallsOf(p));
    // An attempt in flight that never ends: the governor denies every attempt, exempt ones too (PRO-40).
    p.core.governor.onAttemptStart();
    let r: RecoverResult;
    try {
      r = await recover(p.core, prev.preview.id);
    } finally {
      p.core.governor.onAttemptEnd({ durationMs: 1, killed: false, hadRefStatus: false, transient: false, landed: false });
    }
    const off = offlineOf(r);
    assert.deepEqual([off['reason'], off['push'], off['outcome']], ['denied', 'displaced', 'denied']);
    assert.equal(pushSpawnsOf(gitCallsOf(p)), spawns, 'no push');
    assert.equal(await p.core.repo.readRef(p.core.refs.state), state0);
    assert.ok(inIncident(p));
    const done = await recover(p.core, prev.preview.id);
    okPreview(done);
    assert.equal(done.done, true);
    assert.equal((await fx.remote.refs())[board], B1);
  });
});

test('final review FC minor: the re-anchor keeps a write intent journaled for a stranded restore (P2-STRANDED: the only durable name of its .old) with its t/ and keep/, and the narrowed apply intent this run kept is still cleared once no restore is stranded', async () => {
  for (const kind of ['apply', 'local'] as const) {
    await withCores(`recover-reanchor-kept-${kind}`, { n: 1, files: FILES }, async (fx) => {
      const p = fx.peers[0]!;
      await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
      await catchUp(fx, p);
      const view = p.core.view!;
      const T = view.laB;
      const A = await stateA(p);
      const intent: Intent = kind === 'apply'
        ? { kind: 'apply', tip: view.laC, board: T, groups: [{ n: 0, entries: [{ path: 'y.txt', kind: 'modify', slot: 0 }] }] }
        : { kind: 'local', origin: 'writer', entries: [{ path: 'y.txt', expected: A.get('y.txt')!.oid, target: 'DELETE', slot: 0 }] };
      const t = new Map<JournalTree, Oid>(kind === 'apply' ? [['M', view.base], ['S', view.snap], ['TIP', view.base]] : []);
      const keep = new Map(view.keep);
      if (kind === 'local') keep.set(LOCAL_INTENT_KEEP, await p.core.repo.mktree(localIntentKeep(intent)));
      await p.core.commit({ intent, t, keep });
      if (kind === 'apply') markApplyIntentKept(p.core, true);   // this run's apply narrowed it to a stranded group (P2-NARROW)

      await lostStateRebuild(p.core, T, 're_anchor', undefined, { displaced: [] });
      const after = p.core.view!;
      assert.notEqual(after.meta.epoch, view.meta.epoch, `${kind}: the re-anchor ran (a new epoch)`);
      if (kind === 'local') {
        assert.deepEqual(after.intent, intent, 'local: the journaled write intent is kept as it is');
        assert.deepEqual([...after.t], [...t], 'local: with its journal trees');
      } else {
        // Final review FC round 2: kept with its groups and t/M, rewritten onto the re-anchor's chain (tip, board, t/S,
        // t/TIP), so a restart's ENG-53 resolution commits this transition's LA_C, LA_B, snap and A again.
        assert.deepEqual(after.intent, { ...intent, tip: after.laC, board: after.laB }, 'apply: the journaled write intent is kept on the new chain');
        assert.deepEqual([...after.t].sort(), [['M', view.base], ['S', after.snap], ['TIP', after.base]], 'apply: t/M kept, t/S and t/TIP the re-anchor\'s');
      }
      if (kind === 'local') assert.equal(after.keep.get(LOCAL_INTENT_KEEP), keep.get(LOCAL_INTENT_KEEP), 'local: its blobs stay reachable (P2-INTENTREACH)');
      if (kind === 'apply') {
        // No restore is stranded in this writer: the next iteration's sweep clears the narrowed apply intent as it would
        // have without the re-anchor (the run's mark survives the re-anchor's attachState).
        fx.advance(3_000);
        await prep(p);
        assert.equal(p.core.view!.intent.kind, 'none', 'apply: cleared once nothing is stranded');
      }
    });
  }
});

test('final review FC round 2: a re-anchor that keeps a narrowed apply intent (P2-NARROW) rewrites it onto the re-anchor\'s chain (tip, board, t/S, t/TIP; its groups and t/M kept), so a restart before the sweep clears it replays nothing of the old chain: LA_B, LA_C, snap and A stay the re-anchor\'s and no INCIDENT follows', async () => {
  await withCores('recover-reanchor-kept-apply-restart', { n: 2, files: FILES }, async (fx) => {
    const [px, py] = [fx.peers[0]!, fx.peers[1]!];
    const refs = py.core.refs;
    // recover.test's re-anchor shape: Y's LA_B (B4) is off the chain the team restored and continued (B2 … Bn).
    const { board: B1 } = await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
    await fx.pushTeamChange({ 'x.txt': buf('x v2\n') });
    for (const p of fx.peers) await catchUp(fx, p);
    await fx.pushTeamChange({ 'y.txt': buf('y on the old chain\n') });
    const { board: B4 } = await fx.pushTeamChange({ 'w.txt': buf('w on the old chain\n') });
    await catchUp(fx, py);
    await forceRemote(fx, px, refs.remoteBoard, B1);
    await detect(fx, px);
    const px1 = await recover(px.core, null);
    okPreview(px1);
    okPreview(await recover(px.core, px1.preview.id));
    await fx.pushTeamChange({ 't.txt': buf('t on the new chain\n') });
    const { board: Bn } = await fx.pushTeamChange({ 'x.txt': buf('x v3 on the new chain\n') });
    await detect(fx, py);

    // Y's last apply (on B4) kept a narrowed intent for a stranded group (P2-NARROW): one group on x.txt, whose disk is
    // the group's target, so the restart reads it complete and only the chain values decide the outcome.
    const view = py.core.view!;
    assert.equal(view.laB, B4);
    const intent: Intent = { kind: 'apply', tip: view.laC, board: view.laB, groups: [{ n: 0, entries: [{ path: 'x.txt', kind: 'modify', slot: 0 }] }] };
    const t = new Map<JournalTree, Oid>([['M', view.base], ['S', view.snap], ['TIP', view.base]]);
    await py.core.commit({ intent, t });
    markApplyIntentKept(py.core, true);
    const prev = await recover(py.core, null);
    okPreview(prev);
    assert.deepEqual([prev.preview.mode, prev.preview.V], ['reanchor', Bn]);
    okPreview(await recover(py.core, prev.preview.id));
    const after = py.core.view!;
    assert.equal(after.laB, Bn, 'the re-anchor: LA_B := V');
    assert.equal(after.intent.kind, 'apply', 'the narrowed apply intent stays journaled (the only durable name of a stranded .old)');

    // A restart (crash, respawn, `run`) before any sweep clears the kept intent: ENG-53 resolves it, and its update must
    // not move LA_B, LA_C, snap or A back to the old chain.
    await restartCore(py);
    await startOk(py, 'restart');
    const v = py.core.view!;
    assert.equal(v.laB, Bn, 'LA_B stays V, never the old chain\'s board');
    assert.equal(v.laC, after.laC, 'LA_C stays live_code(V)');
    assert.equal(v.snap, after.snap, 'snap stays the re-anchor\'s S_disk');
    assert.equal(v.base, after.base, 'A stays the re-anchor\'s');
    assert.equal(v.intent.kind, 'none', 'the restart resolved the kept intent');
    assert.ok(!inIncident(py), 'not in INCIDENT after the restart');
    const displaced0 = await remoteDisplaced(fx, py);
    for (let i = 0; i < 3; i++) {
      fx.advance(PAST_WINDOW_MS);
      assert.equal((await poll(py)).incident, false, `iteration ${i}: no INCIDENT (LA_B is V, on the board's chain)`);
    }
    assert.deepEqual(await remoteDisplaced(fx, py), displaced0, 'no ENG-21 displaced copy of the old chain takes a slot');
    assert.equal(py.core.view!.laB, await fx.remote.refs().then((r) => r[refs.remoteBoard]), 'Y follows the board');

    // The kept intent the re-anchor wrote (checked last, so a replay of the old chain is what fails first).
    assert.ok(after.intent.kind === 'apply');
    assert.equal(after.intent.tip, after.laC, 'intent.tip := live_code(V) (the re-anchor\'s LA_C)');
    assert.equal(after.intent.board, after.laB, 'intent.board := V (the re-anchor\'s LA_B)');
    assert.deepEqual(after.intent.groups, intent.groups, 'its groups are kept: the .old/.new/.redo names derive from them');
    assert.equal(after.t.get('M'), view.base, 't/M (the group\'s write targets) is kept');
    assert.equal(after.t.get('S'), after.snap, 't/S := the re-anchor\'s S_disk');
    assert.equal(after.t.get('TIP'), after.base, 't/TIP := the re-anchor\'s A (a target match leaves A as the re-anchor decided it)');
  });
});

test('final review FC round 2: a real stranded restore across a re-anchor onto a board off the old chain: the restart relinks the .old through the kept intent\'s names, LA_B stays V, the next iterations raise no INCIDENT, and relinked bytes that are an older version on V\'s chain are A[p] with V\'s version applied over them (final review FD: ENG-54 read them from the .old), no record, never published', async () => {
  for (const variant of ['V keeps y.txt', 'V changes y.txt'] as const) {
    await withCores(`recover-reanchor-stranded-restart-${variant === 'V keeps y.txt' ? 'keep' : 'change'}`, { n: 1, files: FILES }, async (fx) => {
      const p = fx.peers[0]!;
      const board = p.core.refs.remoteBoard;
      const { board: B1 } = await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
      await catchUp(fx, p);
      // B2 changes y.txt; its write and the rollback's relink of y.txt's .old fail: the restore is stranded (P2-STRANDED)
      // and the apply keeps only that group journaled (P2-NARROW).
      const { board: B2 } = await fx.pushTeamChange({ 'y.txt': buf('y v1\n') });
      p.fs.addRule({ op: 'link', pathIncludes: workPath(p, 'y.txt'), code: 'EPERM', times: 2 });
      fx.advance(10_000);
      const r = await poll(p);
      assert.equal(r.apply?.deferred.get('y.txt'), 'locked', variant);
      assert.deepEqual(p.core.writer.strandedPaths(), ['y.txt'], variant);
      assert.equal(await readWork(p, 'y.txt'), null, `${variant}: y.txt is absent while its restore is stranded`);
      const kept = p.core.view!;
      assert.equal(kept.laB, B2, variant);
      assert.ok(kept.intent.kind === 'apply' && kept.intent.board === B2, variant);
      const g = kept.intent.groups[0]!;
      const oldFile = join(p.deps.paths.coworkDir, 'tmp', `${g.n}.${g.entries[0]!.slot}.old`);
      assert.equal(readFileSync(oldFile, 'utf8'), 'y v0\n', `${variant}: the stranded .old holds the only copy of y.txt`);

      // The board is rewritten to V, on B1 and off B2's chain (y.txt as at B1, or changed); step 2a's re-anchor onto it
      // while the restore is stranded.
      const liveB1 = await liveOf(p, B1);
      let treeV: Oid | undefined;
      const yV = variant === 'V keeps y.txt' ? 'y v0\n' : 'y on V\n';
      if (variant === 'V changes y.txt') {
        const base = await p.core.repo.readTreeMap((await p.core.repo.readCommit(liveB1)).tree);
        const yOid = await p.core.repo.hashBytes(buf(yV), true);
        treeV = await p.core.repo.mktree([...base.values()].map((e) => ({ name: e.path, mode: e.mode, type: 'blob' as const, oid: e.path === 'y.txt' ? yOid : e.oid })));
      }
      const liveV = await liveOn(p, [liveB1], treeV);
      const V = await boardOn(p, B1, liveV);
      await forceRemote(fx, p, board, V);
      const restartRecs = (): string[] => p.core.holds.nonTerminal().filter((h) => h.guards.some((x) => x.name === 'restart')).map((h) => h.id);
      const recs0 = restartRecs();
      await lostStateRebuild(p.core, V, 're_anchor', undefined, { displaced: [] });
      assert.equal(p.core.view!.laB, V, variant);
      assert.ok(p.core.view!.intent.kind === 'apply', `${variant}: the intent naming the stranded .old is kept`);
      // Final review FD: ENG-54 reads y.txt from its .old ('y v0', B1's version, on V's chain either way): A[y.txt] := it.
      assert.equal((await stateA(p)).get('y.txt')?.oid, await blob(p, 'y v0\n'), `${variant}: the re-anchor decided A[y.txt] := the .old's version on V's chain`);

      // A restart before any sweep: the fresh writer knows no stranded path; ENG-53 relinks the .old by the intent's names.
      await restartCore(p);
      await startOk(p, 'restart');
      const v = p.core.view!;
      assert.equal(v.laB, V, `${variant}: LA_B stays V, never B2`);
      assert.equal(v.intent.kind, 'none', variant);
      assert.equal((await readWork(p, 'y.txt'))?.toString('utf8'), 'y v0\n', `${variant}: the restart put y.txt back from its .old`);
      assert.equal(existsSync(oldFile), false, variant);
      for (let i = 0; i < 2; i++) {
        fx.advance(10_000);
        assert.equal((await poll(p)).incident, false, `${variant}, iteration ${i}: no INCIDENT`);
      }
      assert.equal(await liveOf(p, p.core.view!.laB), liveV, `${variant}: LA_B on V (at most a board-only commit of the new epoch's join op)`);
      // V keeps y.txt: the relinked bytes are V's. V changes it: the relinked bytes are its older version, which the
      // re-anchor made A[y.txt] (final review FD), so the next apply put V's version on disk over them.
      assert.equal((await readWork(p, 'y.txt'))?.toString('utf8'), yV, `${variant}: y.txt on disk is V's version`);
      assert.equal((await stateA(p)).get('y.txt')?.oid, await blob(p, yV), `${variant}: A[y.txt] is V's version`);
      // The restart's ENG-53 decision read the relinked bytes as the kept intent's pre-image (t/S: the .old as the
      // re-anchor read it), so neither the re-anchor nor the restart holds them in a record.
      const added = p.core.holds.nonTerminal().filter((h) => !recs0.includes(h.id) && h.guards.some((x) => x.name === 'restart'));
      assert.deepEqual(added, [], `${variant}: no restart record`);
      const remoteLive = await liveOf(p, (await fx.remote.refs())[board] as Oid);
      assert.equal((await p.core.repo.readTreeMap((await p.core.repo.readCommit(remoteLive)).tree)).get('y.txt')?.oid, await blob(p, yV), `${variant}: nothing of the relinked bytes is published`);
    });
  }
});

let fdIteration = 10_000;

/**
 * One iteration in the loop's order (01-engine §3.5; loop.ts): prepare (its sweep relinks a stranded restore), the human
 * CS captured when it is due (captureDue), a kept push intent resolved, apply, publish.
 */
async function iterateCapturing(p: PeerFixture): Promise<void> {
  const r = await prepareIteration(p.core, ++fdIteration, { materialize: 'auto', forceFetch: true });
  assert.ok(r.ok, `prepareIteration: ${JSON.stringify(r)}`);
  const it = r.it;
  if (captureDue(p.core)) {
    if (it.mat === null) it.mat = await p.core.snapshot.materialize(tickInputOf(p.core, it));
    const cap = await p.core.cs.capture(p.core.repo, it.mat.sDiskMap, it.A, p.core.scratch('r'));
    if (cap !== null) await p.core.commit({ ready: p.core.cs.ready(), meta: { ...p.core.view!.meta, cs_human_next: cap.nextN } });
  }
  if (p.core.view!.intent.kind === 'push') await resolvePushIntent(p.core, it);
  await applyStep(p.core, it);
  await publishStep(p.core, it);
}

interface FdVariant {
  readonly name: string;
  /** The pre-apply bytes the stranded .old holds: y.txt as at B1 (a team version), or a local edit of line 1. */
  readonly old: 'team' | 'local';
  /** The .old vanished before the re-anchor (FB-3: the sweep restores p from the blob it held). */
  readonly vanish: boolean;
  /** A share-none holder on the .old during the re-anchor (its read fails EBUSY: unreadable), released right after. */
  readonly lockOld: boolean;
  readonly then: 'sweep' | 'restart';
  /** V's y.txt: as at B1, line 4 changed, or deleted. */
  readonly atV: 'kept' | 'changed' | 'deleted';
}

const FD_BASE = lines(8);
const FD_LOCAL = lines(8, (i) => (i === 1 ? 'line 1 local' : `line ${i}`));
const FD_ON_B2 = lines(8, (i) => (i === 8 ? 'line 8 on B2' : `line ${i}`));
const FD_ON_V = lines(8, (i) => (i === 4 ? 'line 4 on V' : `line ${i}`));

/**
 * Final review FD: B2's apply strands y.txt's restore (`link EPERM ×2`), V is a board on B1 off B2's chain, the re-anchor
 * (`lostStateRebuild(V, 're_anchor')`) runs while the restore is stranded, then four capturing iterations (or a restart
 * first). ENG-54 decides y.txt from its .old (DISK_EQ form (3)) — bytes on V's chain become A[y] and V's version (or its
 * deletion) is applied over them; a local edit V's chain lacks becomes a masked restart record — so the relinked pre-apply
 * bytes are never published over V's change. An .old that cannot be read there (fix round 1) is decided by `pre`, the
 * blob P1 verified it held, the same way.
 */
async function fdStrandedReanchor(k: number, v: FdVariant): Promise<void> {
  await withCores(`recover-fd-stranded-${k}`, { n: 1, files: { ...FILES, 'y.txt': buf(FD_BASE) } }, async (fx) => {
    const p = fx.peers[0]!;
    const board = p.core.refs.remoteBoard;
    const { board: B1 } = await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
    await catchUp(fx, p);
    // B2 changes y.txt (line 8; a local edit of line 1 merges with it); its write and the rollback's relink of y.txt's
    // .old fail: the restore is stranded (P2-STRANDED), the .old holds the only copy of the pre-apply bytes.
    if (v.old === 'local') await writeWork(p, 'y.txt', FD_LOCAL);
    await fx.pushTeamChange({ 'y.txt': buf(FD_ON_B2) });
    p.fs.addRule({ op: 'link', pathIncludes: workPath(p, 'y.txt'), code: 'EPERM', times: 2 });
    fx.advance(10_000);
    const r = await poll(p);
    assert.equal(r.apply?.deferred.get('y.txt'), 'locked', v.name);
    assert.deepEqual(p.core.writer.strandedPaths(), ['y.txt'], v.name);
    const kept = p.core.view!;
    assert.ok(kept.intent.kind === 'apply', v.name);
    const g = kept.intent.groups[0]!;
    const oldFile = join(p.deps.paths.coworkDir, 'tmp', `${g.n}.${g.entries[0]!.slot}.old`);
    const preApply = v.old === 'local' ? FD_LOCAL : FD_BASE;
    assert.equal(readFileSync(oldFile, 'utf8'), preApply, `${v.name}: the stranded .old holds the pre-apply bytes`);

    // V: a board on B1, off B2's chain, whose live code keeps y.txt as at B1, changes its line 4, or deletes it (then
    // neither TIP nor the re-anchor's S_disk has it); the re-anchor onto it while the restore is stranded (the tick skips
    // y.txt: P2-STRANDED-SKIP).
    const liveB1 = await liveOf(p, B1);
    const atB1 = await p.core.repo.readTreeMap((await p.core.repo.readCommit(liveB1)).tree);
    const yV = v.atV === 'changed' ? await p.core.repo.hashBytes(buf(FD_ON_V), true) : v.atV === 'kept' ? atB1.get('y.txt')!.oid : null;
    const treeV = await p.core.repo.mktree([...atB1.values()].filter((e) => yV !== null || e.path !== 'y.txt')
      .map((e) => ({ name: e.path, mode: e.mode, type: 'blob' as const, oid: e.path === 'y.txt' && yV !== null ? yV : e.oid })));
    const V = await boardOn(p, B1, await liveOn(p, [liveB1], treeV));
    await forceRemote(fx, p, board, V);
    // The .old vanished (FB-3: an AV quarantine, a cleaned tmp/): the sweep restores p from the blob it held.
    if (v.vanish) await unlink(oldFile);
    const restartRecs = (): Array<{ id: string; paths: string[]; h0: string | undefined; h1: string | undefined }> => p.core.holds.nonTerminal()
      .filter((h) => h.guards.some((x) => x.name === 'restart'))
      .map((h) => ({ id: h.id, paths: [...h.paths], h0: 'h0' in h.blobs ? h.blobs.h0['y.txt'] : undefined, h1: 'h1' in h.blobs ? h.blobs.h1['y.txt'] : undefined }));
    const recs0 = restartRecs().map((h) => h.id);
    // Fix round 1: a share-none holder on the .old (a Windows reader that opened it without FILE_SHARE_*): its read at the
    // re-anchor fails EBUSY (the same holder that fails link() strands a restore), released before the sweep.
    const release = v.lockOld ? p.fs.holdLock(oldFile, 'share-none') : null;
    const callsBefore = p.fs.calls.length;
    try {
      await lostStateRebuild(p.core, V, 're_anchor', undefined, { displaced: [] });
    } finally {
      release?.();
    }
    if (v.lockOld) {
      // The holder was in force: the rebuild's read of the .old (DISK_EQ form (3)) was refused, so `pre` decided.
      assert.ok(p.fs.calls.slice(callsBefore).some((c) => c.startsWith('readFile ') && c.includes(oldFile)), `${v.name}: the re-anchor tried to read the .old`);
      assert.ok(existsSync(oldFile), `${v.name}: the .old is still there (unreadable, not vanished)`);
    }
    assert.equal(p.core.view!.laB, V, v.name);
    const aAtReanchor = (await stateA(p)).get('y.txt')?.oid;
    const recsAtReanchor = restartRecs().filter((h) => !recs0.includes(h.id));
    // Never a record holding A[p]'s own blob (h0 == h1): it would mask y.txt's later local edits for nothing.
    for (const h of recsAtReanchor) assert.notEqual(h.h1, h.h0, `${v.name}: a restart record never holds its own base`);

    if (v.then === 'restart') {
      // A restart before any sweep: the fresh writer knows no stranded path; ENG-53 relinks the .old by the intent's names.
      await restartCore(p);
      await startOk(p, 'restart');
      assert.equal(p.core.view!.laB, V, `${v.name}: LA_B stays V`);
    }
    // The sweep relinks (or restores) y.txt, the human CS closes 20 s later and captures, and every iteration publishes.
    for (let i = 0; i < 4; i++) {
      fx.advance(10_000);
      await iterateCapturing(p);
    }

    // The consequence first: nothing of the pre-apply bytes is published over V's change (or V's deletion).
    const remoteLive = await liveOf(p, (await fx.remote.refs())[board] as Oid);
    const remoteY = (await p.core.repo.readTreeMap((await p.core.repo.readCommit(remoteLive)).tree)).get('y.txt')?.oid ?? null;
    assert.equal(remoteY, yV, `${v.name}: the remote keeps V's y.txt (the relinked pre-apply bytes are never published over it)`);
    assert.deepEqual(p.core.writer.strandedPaths(), [], `${v.name}: the restore completed`);
    assert.equal(p.core.view!.intent.kind, 'none', v.name);
    assert.equal(p.core.view!.laB, await fx.remote.refs().then((x) => x[board]), `${v.name}: Y follows the board`);
    assert.equal((await stateA(p)).get('y.txt')?.oid ?? null, yV, `${v.name}: A[y.txt] ends at V's version`);
    const added = restartRecs().filter((h) => !recs0.includes(h.id));
    if (v.old === 'team') {
      // ENG-54: the .old's bytes (or `pre`, when the .old vanished or cannot be read) match the version before V's change
      // on V's chain → A[p] := that version, no record; the next apply then puts V's version on disk over them (V's
      // deletion: removes y.txt; V keeps it: nothing to write).
      assert.equal(aAtReanchor, await blob(p, FD_BASE), `${v.name}: the re-anchor decided A[y.txt] := the .old's version on V's chain`);
      assert.deepEqual(recsAtReanchor, [], `${v.name}: no restart record at the re-anchor`);
      const onDisk = v.atV === 'deleted' ? null : v.atV === 'kept' ? FD_BASE : FD_ON_V;
      assert.equal((await readWork(p, 'y.txt'))?.toString('utf8') ?? null, onDisk, `${v.name}: V's version is on disk over the restored pre-apply bytes`);
      assert.deepEqual(added, [], `${v.name}: no restart record`);
    } else {
      // ENG-54: the local edit matches no version on V's chain → A[p] := TIP[p] with a 'restart' record holding the
      // .old's bytes, made by the re-anchor itself; masked, not published, not overwritten (and a restart before the
      // sweep, whose ENG-53 decision reads the relinked bytes as the kept intent's pre-image, makes no second one).
      assert.equal(aAtReanchor, yV, `${v.name}: the re-anchor decided A[y.txt] := TIP[y.txt]`);
      assert.deepEqual(recsAtReanchor.map((h) => [h.paths, h.h1]), [[['y.txt'], await blob(p, FD_LOCAL)]], `${v.name}: the re-anchor holds the .old's bytes in one restart record`);
      assert.deepEqual(added.map((h) => h.id), recsAtReanchor.map((h) => h.id), `${v.name}: that record and no other`);
      assert.ok(p.core.holds.maskingRecords().some((h) => h.id === recsAtReanchor[0]!.id), `${v.name}: masked`);
      assert.equal((await readWork(p, 'y.txt'))?.toString('utf8'), FD_LOCAL, `${v.name}: the relinked local edit stays on disk`);
    }
  });
}

// One test per scenario (fix round 1: a failure in one never hides the others).
const FD_VARIANTS: readonly FdVariant[] = [
  { name: 'an older team version, no restart', old: 'team', vanish: false, lockOld: false, then: 'sweep', atV: 'changed' },
  { name: 'an older team version whose .old vanished, no restart', old: 'team', vanish: true, lockOld: false, then: 'sweep', atV: 'changed' },
  { name: 'an older team version V deleted, no restart', old: 'team', vanish: false, lockOld: false, then: 'sweep', atV: 'deleted' },
  { name: 'a local edit, no restart', old: 'local', vanish: false, lockOld: false, then: 'sweep', atV: 'changed' },
  { name: 'a local edit, a restart before the sweep', old: 'local', vanish: false, lockOld: false, then: 'restart', atV: 'changed' },
  { name: 'an older team version V keeps, the .old unreadable at the re-anchor (share-none EBUSY), no restart', old: 'team', vanish: false, lockOld: true, then: 'sweep', atV: 'kept' },
  { name: 'an older team version V changes, the .old unreadable at the re-anchor (share-none EBUSY), no restart', old: 'team', vanish: false, lockOld: true, then: 'sweep', atV: 'changed' },
];
for (const [k, v] of FD_VARIANTS.entries()) {
  test(`final review FD: a stranded restore across a re-anchor (${v.name}): ENG-54 decides p from its .old (DISK_EQ form (3); \`pre\` when it vanished or cannot be read) — bytes on V's chain become A[p] and V's version (or deletion) is applied over them, a local edit V's chain lacks becomes a masked restart record, never one holding A[p] itself — so the relinked pre-apply bytes are never published over V's change`, async () => {
    await fdStrandedReanchor(k, v);
  });
}

test('final review FC minor: DISPLACED_REF_SKIPPED is bounded: a remote holding many unusable displaced names logs at most DISPLACED_SKIP_LOG_MAX of them, then one line counting the rest', async () => {
  await withCores('recover-displaced-skip-cap', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const refs = p.core.refs;
    const prefix = refs.displacedPrefix;
    const { board: B1 } = await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
    await catchUp(fx, p);
    const B0 = await firstParent(p, B1);
    await forceRemote(fx, p, refs.remoteBoard, B0);
    await detect(fx, p);
    const junk: Record<string, Oid> = {};
    for (let i = 0; i < 40; i++) junk[`${prefix}junk-${String(i).padStart(2, '0')}`] = B1;
    await addPackedRefs(fx, junk);
    const log = new LogRecorder();
    p.deps.log = log;
    okPreview(await recover(p.core, null));
    const lines = log.lines.filter((l) => l.code === 'DISPLACED_REF_SKIPPED');
    const each = lines.filter((l) => l.params['reason'] === 'shape');
    assert.equal(each.length, DISPLACED_SKIP_LOG_MAX, `at most ${DISPLACED_SKIP_LOG_MAX} lines name a skipped ref (${each.length} did)`);
    assert.deepEqual(lines.filter((l) => l.params['reason'] === 'more').map((l) => l.params['omitted']), [40 - DISPLACED_SKIP_LOG_MAX], 'one line counts the rest');
  });
});
