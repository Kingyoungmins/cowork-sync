// Start dispatch, genesis and join (08-lifecycle Table 3.3-A, §3.3.2, §3.3.3; 01-engine §3.14; ENG-51, ENG-52, ENG-59
// join.first_apply; PRO-07; LIF-06…LIF-08 subsets; rulings R-08, R-19, R-22, R-23; 01-engine tests 21, 44, 57 part), on
// EngineCores over real clones of a file:// remote. Git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join as joinPath } from 'node:path';
import { buildBoardCommit, CODE_SUBJECT, liveCommitTrailers, readBoardCommit, type BoardDraft, type WriterId } from '../../src/board/boardCommit.js';
import { foldCommit, initialFoldState, serializeFold } from '../../src/board/fold.js';
import { newEpoch } from '../../src/board/ids.js';
import { parseOpLine, serializeOps, type Op } from '../../src/board/ops.js';
import { genesisProtocol, type ProtocolJson } from '../../src/board/protocol.js';
import { createEngineCore, liveCodeOf, prepareIteration } from '../../src/engine/core.js';
import { PLAN2_REGION_SPEC } from '../../src/engine/deps.js';
import { RemoteContentError } from '../../src/engine/errors.js';
import { liveBase } from '../../src/engine/incident.js';
import { publishStep } from '../../src/engine/publish.js';
import { startDispatch } from '../../src/engine/start.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import { pushSpec, runPush } from '../../src/git/push.js';
import type { MktreeEntry } from '../../src/git/repo.js';
import { setCrashHandler } from '../../src/ports/crashpoint.js';
import { gitCallsOf, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { blobText, buf, captureReady, editAndCapture, failedResult, LogRecorder, prep, setMutants, treeOf, wrapGit } from '../helpers/publishHelpers.js';
import { gitIn, gitRemote, localCoworkRefs, pushSpawns, restartCore, startOk, withStart } from '../helpers/startFixture.js';
import { testRunner } from '../helpers/tmp.js';

const FILES: Record<string, Buffer> = {
  'README.md': buf('# start fixture\n'),
  'src/a.txt': buf('one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n'),
  'src/b.txt': buf('alpha\nbeta\ngamma\n'),
};

const peerOf = (fx: CoreFixture, i: number): PeerFixture => fx.peers[i]!;
const short = (o: string): string => o.slice(0, 8);

async function remoteRefs(fx: CoreFixture): Promise<Record<string, string>> {
  return fx.remote.refs();
}

async function headTree(p: PeerFixture): Promise<Oid> {
  const head = await p.core.repo.resolve('HEAD');
  assert.ok(head !== null);
  return (await p.core.repo.readCommit(head)).tree;
}

/** Every loose object file under .git/objects/<2 hex>/ (sorted). */
function looseObjects(p: PeerFixture): string[] {
  const root = joinPath(p.deps.paths.gitDir, 'objects');
  const out: string[] = [];
  for (const d of readdirSync(root)) {
    if (!/^[0-9a-f]{2}$/.test(d)) continue;
    for (const f of readdirSync(joinPath(root, d))) out.push(`${d}${f}`);
  }
  return out.sort();
}

/** The private index's bytes, or null when it does not exist. */
function privateIndex(p: PeerFixture): Buffer | null {
  const f = joinPath(p.deps.paths.coworkDir, `${p.core.refs.e}.index`);
  return existsSync(f) ? readFileSync(f) : null;
}

/** The genesis push of `args` without the refspec and lease of `ref` (a host that refuses one ref of a non-atomic push). */
function withoutRef(args: string[], ref: string): string[] {
  return args.filter((a) => a !== `--force-with-lease=${ref}:` && !a.endsWith(`:${ref}`));
}

test('genesis builds L0 = tree(Hr) with no parents and Cowork-Base, B0 with [join, caps], pushes both in one push with ABSENT leases and creates state [L0, B0] with A = tree(L0), EPOCH_BASE = Hr, H_adopt = HEAD', async () => {
  await withStart('start-genesis', { n: 1, files: FILES }, async (fx) => {
    const p = peerOf(fx, 0);
    const repo = p.core.repo;
    const hr = (await remoteRefs(fx))['refs/heads/main'] as Oid;
    assert.equal(await repo.resolve('HEAD'), hr);
    const r = await startDispatch(p.core, { publishLocal: null });
    assert.deepEqual(r, { ok: true, mode: 'genesis', restart: null });

    const refs = await remoteRefs(fx);
    const B0 = refs[p.core.refs.remoteBoard] as Oid;
    const L0 = refs[p.core.refs.remoteCode] as Oid;
    assert.ok(B0 !== undefined && L0 !== undefined, 'board and mirror landed');
    const l0 = await repo.readCommit(L0);
    assert.deepEqual(l0.parents, [], 'L0 has no parents');
    assert.equal(l0.tree, await headTree(p), 'L0 = tree(Hr)');
    assert.equal(l0.subject, CODE_SUBJECT);
    assert.ok(l0.trailers.some((t) => t.key === 'Cowork-Base' && t.value === hr), 'L0 carries Cowork-Base: Hr');
    const b0 = await readBoardCommit(repo, B0);
    assert.deepEqual(b0.parents, [L0], 'B0 = [L0]');
    const ops = b0.opsLines.map((l) => parseOpLine(l));
    assert.deepEqual(ops.map((o) => o?.type), ['join', 'caps']);
    assert.equal(b0.protocol.proto, 1);
    assert.equal(b0.writer?.peer, p.core.peerId);

    const pushes = fx.trace.ofKind('push').filter((e) => e.purpose === 'genesis');
    assert.equal(pushes.length, 1, 'one genesis push');
    const argv = pushes[0]!.argv;
    assert.ok(argv.includes(`--force-with-lease=${p.core.refs.remoteBoard}:`), 'board leased ABSENT');
    assert.ok(argv.includes(`--force-with-lease=${p.core.refs.remoteCode}:`), 'mirror leased ABSENT');
    assert.ok(argv.includes(`${B0}:${p.core.refs.remoteBoard}`) && argv.includes(`${L0}:${p.core.refs.remoteCode}`), 'both refspecs in one push');

    const view = p.core.view;
    assert.ok(view !== null);
    assert.deepEqual([view.laC, view.laB], [L0, B0], 'state [L0, B0]');
    assert.equal(view.base, l0.tree, 'A = tree(L0)');
    assert.equal(view.meta.EPOCH_BASE, hr);
    assert.equal(view.meta.H_adopt, await repo.resolve('HEAD'));
    assert.equal(view.meta.expected_epoch.symref, 'refs/heads/main');
    assert.equal(view.meta.seq_next, (b0.writer?.seq ?? 0) + 1, 'seq_next above the genesis writer seq (PRO-08)');
    assert.deepEqual([view.meta.cs_human_next, view.meta.incident_next], [1, 1]);
    assert.equal(view.meta.fold_board, B0);
    assert.equal(view.intent.kind, 'none');
    assert.deepEqual((await p.core.state.read())?.commit, view.commit, 'the state ref names the new state');
    const aSet = fx.trace.ofKind('A_set').filter((e) => e.cause === 'genesis');
    const l0Map = await repo.readTreeMap(l0.tree);
    assert.equal(aSet.length, l0Map.size, "one A_set 'genesis' per path of tree(L0)");
    for (const e of aSet) assert.equal(e.blob, l0Map.get(e.path)?.oid);
  });
});

test('host.pushBudgetPerMin 6, 24, absent and 30 seed budget 6, 24, 12 and 12; a config change after genesis changes nothing', async () => {
  const cases: Array<[unknown, number]> = [[6, 6], [24, 24], [undefined, 12], [30, 12]];
  for (const [value, budget] of cases) {
    const files = { ...FILES, ...(value === undefined ? {} : { '.cowork/config.json': buf(`${JSON.stringify({ host: { pushBudgetPerMin: value } })}\n`) }) };
    await withStart(`start-budget-${String(value)}`, { n: 2, files }, async (fx) => {
      const [p1, p2] = [peerOf(fx, 0), peerOf(fx, 1)];
      await startOk(p1, 'genesis');
      const B0 = (await remoteRefs(fx))[p1.core.refs.remoteBoard] as Oid;
      assert.equal((await readBoardCommit(p1.core.repo, B0)).protocol.budget, budget, `budget for ${String(value)}`);
      if (value !== 6) return;
      // The stored budget: protocol.json in B0's tree, by blob.
      const protocolBlob = async (p: PeerFixture, board: Oid): Promise<string | undefined> =>
        (await p.core.repo.readTreeMap((await p.core.repo.readCommit(board)).tree)).get('protocol.json')?.oid;
      const stored = await protocolBlob(p1, B0);
      // A later config change (the config is quarantined: it moves only by git) is never read for the budget again:
      // neither p1's restart nor p2's join nor either peer's publish changes the stored budget.
      const cfg24 = JSON.stringify({ host: { pushBudgetPerMin: 24 } }) + '\n';
      await writeWork(p1, '.cowork/config.json', cfg24);
      await writeWork(p2, '.cowork/config.json', cfg24);
      for (const p of [p1, p2]) assert.equal(await readFile(joinPath(p.deps.paths.workTree, '.cowork', 'config.json'), 'utf8'), cfg24, `${p.name}: the config changed`);
      await restartCore(p1);
      await startOk(p1, 'restart');
      await prep(p1);
      assert.equal(p1.core.governor.effective().B, 6, "the restarted peer's governor keeps the stored budget");
      await startOk(p2, 'join');
      fx.advance(30_000);
      const r2 = await publishStep(p2.core, await prep(p2));
      assert.equal(r2.outcome, 'landed', JSON.stringify(r2));
      assert.equal((await readBoardCommit(p2.core.repo, r2.bnew!)).protocol.budget, 6);
      assert.equal(await protocolBlob(p2, r2.bnew!), stored, "the joiner's first publish carries B0's protocol.json unchanged");
      assert.equal(p2.core.governor.effective().B, 6, "the joiner's governor follows the board's budget");
      await editAndCapture(fx, p1, { 'src/b.txt': 'alpha\nbeta by p1\ngamma\n' });
      fx.advance(30_000);
      const r1 = await publishStep(p1.core, await prep(p1));
      assert.equal(r1.outcome, 'landed', JSON.stringify(r1));
      assert.equal(await protocolBlob(p1, r1.bnew!), stored, "the restarted peer's publish carries B0's protocol.json unchanged");
    });
  }
});

test('two peers starting together (interleaved at start.beforeGenesisPush) make one genesis; the other refetches and joins', async () => {
  await withStart('start-genesis-race', { n: 2, files: FILES }, async (fx) => {
    const [p1, p2] = [peerOf(fx, 0), peerOf(fx, 1)];
    let arrived = 0;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    fx.scheduler.onYield = async (name) => {
      if (name !== 'start.beforeGenesisPush') return;
      arrived += 1;
      if (arrived === 2) open();
      await gate;
    };
    const rs = await Promise.all([startDispatch(p1.core, { publishLocal: null }), startDispatch(p2.core, { publishLocal: null })]);
    fx.scheduler.onYield = null;
    assert.equal(arrived, 2, 'both built L0/B0 before either pushed');
    assert.deepEqual(rs.map((r) => (r.ok ? r.mode : r.code)).sort(), ['genesis', 'join']);
    const winner = rs[0]!.ok && rs[0]!.mode === 'genesis' ? p1 : p2;
    const loser = winner === p1 ? p2 : p1;
    const board = (await remoteRefs(fx))[winner.core.refs.remoteBoard] as Oid;
    assert.equal(winner.core.view?.laB, board, 'the winner holds the one genesis board');
    assert.equal(loser.core.view?.laB, board, 'the loser joined on that board');
    assert.equal((await winner.core.repo.firstParentCount(board)) - 2, 0, 'one genesis: the board is at height 0');
    assert.ok(loser.core.outbox.size > 0, "the loser's join op waits for its first publish");
    // The loser's lost-race observation runs outside the Fetcher: the run's first Fetcher fetch is its join's first apply.
    const loserEvents = fx.trace.events.filter((e) => 'peer' in e && e.peer === loser.core.peerId);
    const firstState = loserEvents.findIndex((e) => e.kind === 'state');
    assert.ok(firstState >= 0);
    assert.deepEqual(loserEvents.slice(0, firstState).filter((e) => e.kind === 'fetch'), [], 'no Fetcher fetch before the join created its state');
  });
});

test('no state, board deleted, mirror present refuses GENESIS_BOARD_MISSING and writes nothing locally or remotely', async () => {
  await withStart('start-board-missing', { n: 2, files: FILES }, async (fx) => {
    const [p1, p2] = [peerOf(fx, 0), peerOf(fx, 1)];
    await startOk(p1, 'genesis');
    await gitRemote(fx, ['update-ref', '-d', p1.core.refs.remoteBoard]);
    const before = await remoteRefs(fx);
    assert.ok(before[p1.core.refs.remoteCode] !== undefined && before[p1.core.refs.remoteBoard] === undefined);
    const pushesBefore = pushSpawns(gitCallsOf(p2));
    const r = await startDispatch(p2.core, { publishLocal: null });
    assert.deepEqual(r, { ok: false, code: 'GENESIS_BOARD_MISSING', params: { branch: 'main' } });
    assert.deepEqual(await remoteRefs(fx), before, 'nothing written remotely');
    assert.equal(pushSpawns(gitCallsOf(p2)), pushesBefore, 'no push');
    assert.deepEqual(await localCoworkRefs(p2), [], 'no state, no registry');
    assert.equal(p2.core.view, null);
    assert.deepEqual(readdirSync(joinPath(p2.deps.paths.coworkDir, 'tmp')).filter((f) => !f.startsWith('stage')), [], 'nothing left in tmp/');
  });
});

test('join: HEAD == Hb proceeds; a strict ancestor refuses START_HEAD_BEHIND; ahead or diverged refuses START_HEAD_AHEAD; HEAD == Hr ≠ Hb refuses START_HEAD_AHEAD with base_move unsupported', async () => {
  await withStart('start-join-head', { n: 2, files: FILES }, async (fx) => {
    const [p1, p2] = [peerOf(fx, 0), peerOf(fx, 1)];
    const S = (await remoteRefs(fx))['refs/heads/main'] as Oid;
    // The branch moves to S2 before genesis: Hb = Hr = S2.
    await gitIn(p1, ['commit', '-q', '--allow-empty', '-m', 's2']);
    await gitIn(p1, ['push', '-q', fx.remote.url, 'HEAD:refs/heads/main']);
    const S2 = (await gitIn(p1, ['rev-parse', 'HEAD'])) as Oid;
    await startOk(p1, 'genesis');
    assert.equal(p1.core.view?.meta.EPOCH_BASE, S2);

    const refused = async (code: string, params: Record<string, unknown>): Promise<void> => {
      const r = await startDispatch(p2.core, { publishLocal: null });
      assert.deepEqual(r, { ok: false, code, params }, `refused ${code}`);
      assert.deepEqual(await localCoworkRefs(p2), [], `${code} writes no state`);
      assert.equal(p2.core.view, null);
    };
    // p2 at S, a strict ancestor of Hb.
    assert.equal(await gitIn(p2, ['rev-parse', 'HEAD']), S);
    await refused('START_HEAD_BEHIND', { head8: short(S), base8: short(S2) });
    // Diverged: a local commit on S.
    await gitIn(p2, ['commit', '-q', '--allow-empty', '-m', 'local on S']);
    await refused('START_HEAD_AHEAD', { c8: short(await gitIn(p2, ['rev-parse', 'HEAD'])) });
    // Ahead: S2 plus a local commit.
    await gitIn(p2, ['fetch', '-q', fx.remote.url, '+refs/heads/main:refs/remotes/origin/main']);
    await gitIn(p2, ['reset', '-q', '--hard', S2]);
    await gitIn(p2, ['commit', '-q', '--allow-empty', '-m', 'local on S2']);
    await refused('START_HEAD_AHEAD', { c8: short(await gitIn(p2, ['rev-parse', 'HEAD'])) });
    // HEAD == Hr != Hb: the branch moved to S3 after genesis (no base move in Plan 2, R-08).
    await gitIn(p1, ['commit', '-q', '--allow-empty', '-m', 's3']);
    await gitIn(p1, ['push', '-q', fx.remote.url, 'HEAD:refs/heads/main']);
    const S3 = (await gitIn(p1, ['rev-parse', 'HEAD'])) as Oid;
    await gitIn(p2, ['fetch', '-q', fx.remote.url, '+refs/heads/main:refs/remotes/origin/main']);
    await gitIn(p2, ['reset', '-q', '--hard', S3]);
    await refused('START_HEAD_AHEAD', { c8: short(S3), base_move: 'unsupported' });
    // HEAD == Hb.
    await gitIn(p2, ['reset', '-q', '--hard', S2]);
    await startOk(p2, 'join');
    assert.equal(p2.core.view?.meta.EPOCH_BASE, S2, 'EPOCH_BASE := Hb');
    assert.equal(p2.core.view?.meta.H_adopt, S2, 'H_adopt := HEAD');
  });
});

test('join sets A := tree(HEAD) and state [L_b, T], applies first, then LA_C := TIP; join.first_apply fires between the first apply and the first publish', async () => {
  await withStart('start-join-apply', { n: 2, files: FILES }, async (fx) => {
    const [p1, p2] = [peerOf(fx, 0), peerOf(fx, 1)];
    await startOk(p1, 'genesis');
    const L0 = p1.core.view!.laC;
    await editAndCapture(fx, p1, { 'src/b.txt': 'alpha\nBETA from p1\ngamma\n' });
    fx.advance(30_000);
    const pub = await publishStep(p1.core, await prep(p1));
    assert.equal(pub.outcome, 'landed');
    const T = pub.bnew!;
    const TIP = pub.c!;

    const traceFrom = fx.trace.events.length;
    const seen: string[] = [];
    setCrashHandler((name) => {
      if (name !== 'join.first_apply') return;
      const v = p2.core.view!;
      seen.push(`${name}:laC=${v.laC === TIP}:pushes=${pushSpawns(gitCallsOf(p2))}:outbox=${p2.core.outbox.size}`);
    });
    try {
      await startOk(p2, 'join');
    } finally {
      setCrashHandler(null);
    }
    assert.deepEqual(seen, ['join.first_apply:laC=true:pushes=0:outbox=1'], 'after the first apply (LA_C = TIP), before any push');
    const states = fx.trace.since(traceFrom).filter((e) => e.kind === 'state' && e.peer === p2.core.peerId);
    const first = states[0];
    assert.ok(first !== undefined && first.kind === 'state');
    assert.equal(first.prev, null, 'the join creates the state ref');
    assert.deepEqual([first.laC, first.laB], [L0, T], 'state [L_b, T] (L_b = the genesis commit that introduced Hb)');
    assert.equal(first.base, await headTree(p2), 'A := tree(HEAD)');
    const view = p2.core.view!;
    assert.deepEqual([view.laC, view.laB], [TIP, T], 'LA_C := TIP only after the first apply');
    assert.equal(await blobText(p2, await treeOf(p2, view.laC), 'src/b.txt'), 'alpha\nBETA from p1\ngamma\n');
    assert.equal((await p2.core.repo.readTreeMap(view.base)).get('src/b.txt')?.oid, (await treeOf(p2, TIP)).get('src/b.txt')?.oid, 'A follows the verified write');
    const head = await p2.core.repo.readTreeMap(await headTree(p2));
    const aSet = fx.trace.since(traceFrom).filter((e) => e.kind === 'A_set' && e.peer === p2.core.peerId && e.cause === 'join');
    assert.equal(aSet.length, head.size, "one A_set 'join' per path of tree(HEAD)");
    for (const e of aSet) if (e.kind === 'A_set') assert.equal(e.blob, head.get(e.path)?.oid);
  });
});

test('a join with nothing opted in publishes OUT == tree(TIP)', async () => {
  await withStart('start-join-noop', { n: 2, files: FILES }, async (fx) => {
    const [p1, p2] = [peerOf(fx, 0), peerOf(fx, 1)];
    await startOk(p1, 'genesis');
    await startOk(p2, 'join');
    const tip = p2.core.view!.laC;
    fx.advance(30_000);
    const r = await publishStep(p2.core, await prep(p2));
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    assert.equal(r.c, null, 'no code commit: OUT == tree(TIP)');
    const b = await readBoardCommit(p2.core.repo, r.bnew!);
    assert.equal(b.liveCode, tip, 'the board-only commit repeats TIP');
    assert.deepEqual(b.opsLines.map((l) => parseOpLine(l)?.type), ['join'], 'the join op rides the first publish');
  });
});

test('ENG-52 step 8: after a join with nothing opted in, the first publish is board-only (OUT == tree(TIP)) even when a ready pair is already waiting; the pair rides the next publish', async () => {
  await withStart('start-join-step8', { n: 2, files: FILES }, async (fx) => {
    const [p1, p2] = [peerOf(fx, 0), peerOf(fx, 1)];
    await startOk(p1, 'genesis');
    await startOk(p2, 'join');
    const tip = p2.core.view!.laC;
    // A local edit made after the join closes into a ready pair before the first publish could run (e.g. offline).
    const { pair } = await editAndCapture(fx, p2, { 'src/a.txt': 'one\ntwo\nthree\nfour by p2\nfive\nsix\nseven\neight\n' });
    fx.advance(30_000);
    const first = await publishStep(p2.core, await prep(p2));
    assert.equal(first.outcome, 'landed', JSON.stringify(first));
    assert.equal(first.c, null, 'the first publish has OUT == tree(TIP)');
    const b = await readBoardCommit(p2.core.repo, first.bnew!);
    assert.equal(b.liveCode, tip);
    assert.deepEqual(b.opsLines.map((l) => parseOpLine(l)?.type), ['join']);
    assert.deepEqual(p2.core.view!.ready.map((x) => x.csId), [pair.csId], 'the pair stays journaled for the next publish');
    fx.advance(30_000);
    const second = await publishStep(p2.core, await prep(p2));
    assert.equal(second.outcome, 'landed', JSON.stringify(second));
    assert.ok(second.c !== null, 'the next publish carries the pair');
    assert.equal(await blobText(p2, await treeOf(p2, second.c), 'src/a.txt'), 'one\ntwo\nthree\nfour by p2\nfive\nsix\nseven\neight\n');
  });
});

test('local work at genesis and at join with publishLocal null refuses START_PREVIEW{n_in, m_out, unshared}; none holds it in one masked join PIN; all publishes it after the first apply', async () => {
  await withStart('start-preview', { n: 2, files: FILES }, async (fx) => {
    const [p1, p2] = [peerOf(fx, 0), peerOf(fx, 1)];
    const LOCAL_A = 'one\ntwo\nTHREE local\nfour\nfive\nsix\nseven\neight\n';
    // Genesis with local work.
    await writeWork(p1, 'src/a.txt', LOCAL_A);
    await writeWork(p1, 'new.txt', 'a new local file\n');
    await writeWork(p1, '.env', 'SECRET=1\n');
    const objects0 = looseObjects(p1);
    const index0 = privateIndex(p1);
    const r0 = await startDispatch(p1.core, { publishLocal: null });
    assert.deepEqual(r0, { ok: false, code: 'START_PREVIEW', params: { n_in: 0, m_out: 2, unshared: 1 } });
    assert.deepEqual(Object.keys(await remoteRefs(fx)), ['refs/heads/main'], 'nothing pushed');
    assert.deepEqual(await localCoworkRefs(p1), []);
    assert.deepEqual(looseObjects(p1), objects0, 'the preview wrote no git object');
    assert.deepEqual(privateIndex(p1), index0, 'the private index is unchanged');
    assert.deepEqual(readdirSync(joinPath(p1.deps.paths.coworkDir, 'tmp', 'stage')), [], 'no stage copy is left');
    const A0 = await p1.core.repo.readTreeMap(await headTree(p1));
    await startOk(p1, 'genesis', { publishLocal: 'none' });
    const pins = p1.core.holds.nonTerminal().filter((h) => h.guards.some((g) => g.name === 'join'));
    assert.equal(pins.length, 1, 'one join PIN');
    const pin = pins[0]!;
    assert.deepEqual(
      {
        kind: pin.kind, residence: pin.residence, state: pin.state, paths: pin.paths, guards: pin.guards.map((g) => g.name),
        origin: pin.origin, cs_ids: pin.cs_ids, local_only: pin.local_only, displaced_by: pin.displaced_by, blobs: pin.blobs,
      },
      {
        kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths: ['new.txt', 'src/a.txt'], guards: ['join'],
        origin: 'human', cs_ids: [], local_only: false, displaced_by: null,
        blobs: {
          h0: { 'new.txt': ABSENT, 'src/a.txt': A0.get('src/a.txt')!.oid },
          h1: { 'new.txt': await p1.core.repo.hashBytes(buf('a new local file\n'), false), 'src/a.txt': await p1.core.repo.hashBytes(buf(LOCAL_A), false) },
        },
      },
      'the exact join PIN',
    );
    assert.ok(p1.core.holds.maskingRecords().some((h) => h.id === pin.id), 'the PIN masks its paths');
    // Nothing of it is ever published: the CS that forms is held back by the PIN (P2-PIN), P == A.
    fx.advance(30_000);
    await prep(p1);
    fx.advance(30_000);
    const it = await prep(p1, true);
    const cap = await p1.core.cs.capture(p1.core.repo, it.mat!.sDiskMap, it.A, p1.core.scratch('r'));
    if (cap !== null) await p1.core.commit({ ready: p1.core.cs.ready(), meta: { ...p1.core.view!.meta, cs_human_next: cap.nextN } });
    const codeBefore = (await remoteRefs(fx))[p1.core.refs.remoteCode];
    const pub = await publishStep(p1.core, await prep(p1));
    assert.notEqual(pub.outcome, 'landed', JSON.stringify(pub));
    assert.equal((await remoteRefs(fx))[p1.core.refs.remoteCode], codeBefore, 'no code published');

    // Join with local work, and an incoming teammate change (n_in > 0).
    await fx.pushTeamChange({ 'README.md': buf('# start fixture, edited by the team\n') });
    await writeWork(p2, 'src/b.txt', 'alpha\nbeta\ngamma\ndelta from p2\n');
    const r1 = await startDispatch(p2.core, { publishLocal: null });
    assert.deepEqual(r1, { ok: false, code: 'START_PREVIEW', params: { n_in: 1, m_out: 1, unshared: 0 } });
    assert.deepEqual(await localCoworkRefs(p2), []);
    // A second preview after the disk changed again writes no object either (the first one's fetch brought the board).
    const objects1 = looseObjects(p2);
    const index1 = privateIndex(p2);
    await writeWork(p2, 'src/b.txt', 'alpha\nbeta\ngamma\ndelta from p2, again\n');
    const r2 = await startDispatch(p2.core, { publishLocal: null });
    assert.deepEqual(r2, { ok: false, code: 'START_PREVIEW', params: { n_in: 1, m_out: 1, unshared: 0 } });
    assert.deepEqual(looseObjects(p2), objects1, 'the join preview wrote no git object');
    assert.deepEqual(privateIndex(p2), index1, 'the private index is unchanged');
    await startOk(p2, 'join', { publishLocal: 'all' });
    // M is one human CS after the first apply, closed now; Engine.start captures it at once through the loop's step 4
    // (final review FC-8; loop.test.ts covers that), here (startDispatch alone) by the same capture on a materialized
    // iteration.
    assert.ok(p2.core.cs.openPaths().has('src/b.txt') && p2.core.cs.closeDue(), 'M is one human CS, closed for the first capture');
    assert.equal(p2.core.cs.ready().length, 0, 'startDispatch itself captures nothing');
    await captureReady(p2, await prep(p2, true));
    assert.ok(p2.core.cs.ready().some((pair) => pair.paths.includes('src/b.txt')), 'the first capture holds M');
    fx.advance(30_000);
    const out = await publishStep(p2.core, await prep(p2));
    assert.equal(out.outcome, 'landed', JSON.stringify(out));
    assert.ok(out.c !== null);
    assert.equal(await blobText(p2, await treeOf(p2, out.c), 'src/b.txt'), 'alpha\nbeta\ngamma\ndelta from p2, again\n');
    assert.equal(await blobText(p2, await treeOf(p2, out.c), 'README.md'), '# start fixture, edited by the team\n', 'the incoming change was applied first');
  });
});

test('a board with proto 2 refuses START_VERSION', async () => {
  await withStart('start-version', { n: 1, files: FILES }, async (fx) => {
    const p = peerOf(fx, 0);
    const repo = p.core.repo;
    const hr = await repo.resolve('HEAD') as Oid;
    // A board written by a newer plugin: protocol.json proto 2.
    const epoch = newEpoch(p.deps.ports.random);
    const other = 'e'.repeat(32);
    const writer: WriterId = { peer: other, epoch, seq: 2 };
    const L0 = await repo.commitTree({ tree: (await repo.readCommit(hr)).tree, parents: [], subject: CODE_SUBJECT, trailers: liveCommitTrailers(writer, [], [], new Map(), hr) });
    const protocol: ProtocolJson = { ...genesisProtocol(12, PLAN2_REGION_SPEC), proto: 2 };
    const ops: Op[] = [{ id: `${other}/${epoch}/1`, type: 'caps', custom_refs: true, lease: true, delete: true, push_options: false, two_parent_ok: true }];
    const draft: BoardDraft = { liveCode: L0, writer, cs: [], protocol, checkpoint: null, heldIds: [], opsLines: serializeOps(ops).toString('utf8').split('\n').filter((l) => l.length > 0) };
    const s0 = foldCommit(initialFoldState(protocol), draft, other).state;
    const B0 = await buildBoardCommit(repo, { prevBoard: null, liveCode: L0, writer, ops, cs: [], csPaths: new Map(), protocol, checkpoint: serializeFold(s0) });
    const pushed = await runPush(repo, fx.remote.url, [pushSpec(B0, p.core.refs.remoteBoard, ABSENT), pushSpec(L0, p.core.refs.remoteCode, ABSENT)], []);
    assert.equal(pushed.statuses.get(p.core.refs.remoteBoard), 'ok');
    const before = await remoteRefs(fx);
    const r = await startDispatch(p.core, { publishLocal: null });
    assert.deepEqual(r, { ok: false, code: 'START_VERSION', params: { board_proto: 2, own_proto: 1 } });
    assert.deepEqual(await remoteRefs(fx), before);
    assert.deepEqual(await localCoworkRefs(p), []);
  });
});

test('state present and board absent dispatches RESTART, never START_BOARD_GONE, and the next prepareIteration returns the incident branch with why board_missing', async () => {
  await withStart('start-board-gone', { n: 1, files: FILES }, async (fx) => {
    const p = peerOf(fx, 0);
    await startOk(p, 'genesis');
    await gitRemote(fx, ['update-ref', '-d', p.core.refs.remoteBoard]);
    await restartCore(p);
    const r = await startDispatch(p.core, { publishLocal: null });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.mode, 'restart');
    const prepared = await prepareIteration(p.core, 1, { materialize: false, forceFetch: true });
    assert.equal(prepared.ok, false);
    assert.ok(!prepared.ok && prepared.why === 'incident' && prepared.verdict.why === 'board_missing', JSON.stringify(prepared));
  });
});

test('a tmp/ on another volume than the work tree (rename probe EXDEV) refuses START_REPO_SHAPE{reason: tmp_volume} and writes nothing', async () => {
  await withStart('start-tmp-volume', { n: 1, files: FILES }, async (fx) => {
    const p = peerOf(fx, 0);
    p.fs.addRule({ op: 'rename', pathIncludes: 'rename-probe', code: 'EXDEV', times: 1 });
    const r = await startDispatch(p.core, { publishLocal: null });
    assert.deepEqual(r, { ok: false, code: 'START_REPO_SHAPE', params: { reason: 'tmp_volume' } });
    assert.deepEqual(Object.keys(await remoteRefs(fx)), ['refs/heads/main']);
    assert.deepEqual(await localCoworkRefs(p), []);
    assert.deepEqual(readdirSync(joinPath(p.deps.paths.coworkDir, 'tmp')).filter((f) => !f.startsWith('stage')), [], 'the probe file is removed');
  });
});

test('the rename probe removes stale ~cowork-rename-probe*.tmp files first, retries EPERM/EBUSY on the Clock port and never fails because of leftovers', async () => {
  await withStart('start-rename-probe', { n: 1, files: FILES }, async (fx) => {
    const p = peerOf(fx, 0);
    const root = p.deps.paths.workTree;
    // Leftovers of crashed starts: more than any fixed number of probe names.
    const stale = Array.from({ length: 20 }, (_, k) => joinPath(root, k === 0 ? '~cowork-rename-probe.tmp' : `~cowork-rename-probe-${k}.tmp`));
    for (const f of stale) await writeFile(f, 'stale\n');
    // A Windows scanner holds the probe file twice.
    p.fs.addRule({ op: 'rename', pathIncludes: 'rename-probe', code: 'EPERM', times: 1 });
    p.fs.addRule({ op: 'rename', pathIncludes: 'rename-probe', code: 'EBUSY', times: 1 });
    const mono = p.clock.monoMs();
    await startOk(p, 'genesis');
    assert.equal(p.clock.monoMs() - mono >= 200, true, 'two 100 ms backoffs on the Clock port');
    for (const f of stale) assert.equal(existsSync(f), false, `${f} removed`);
    assert.deepEqual(readdirSync(root).filter((n) => n.startsWith('~cowork-rename-probe')), [], 'no probe file is left');
  });
});

test('the other start refusals write nothing: a detached HEAD or an operation marker (START_HEAD_STATE), an unreachable remote (START_REMOTE), no branch on the remote (START_BRANCH_NOT_ON_REMOTE), a local ref-update failure (START_REMOTE), HEAD behind or ahead of Hr at genesis and a restart against another repository (START_REPO_IDENTITY)', async () => {
  await withStart('start-refusals', { n: 2, files: FILES }, async (fx) => {
    const [p, other] = [peerOf(fx, 0), peerOf(fx, 1)];
    const refused = async (code: string, params: Record<string, unknown>): Promise<void> => {
      const spawns = pushSpawns(gitCallsOf(p));
      const before = await remoteRefs(fx);
      const r = await startDispatch(p.core, { publishLocal: null });
      assert.deepEqual(r, { ok: false, code, params }, code);
      assert.equal(pushSpawns(gitCallsOf(p)), spawns, `${code}: no push`);
      assert.deepEqual(await remoteRefs(fx), before, `${code}: nothing written remotely`);
    };
    const main = (await remoteRefs(fx))['refs/heads/main'] as Oid;
    await gitIn(p, ['checkout', '-q', '--detach']);
    await refused('START_HEAD_STATE', { op: 'detached' });
    await gitIn(p, ['checkout', '-q', 'main']);
    const mergeHead = joinPath(p.deps.paths.gitDir, 'MERGE_HEAD');
    await writeFile(mergeHead, `${main}\n`);
    await refused('START_HEAD_STATE', { op: 'MERGE_HEAD' });
    await unlink(mergeHead);
    const url = p.deps.url;
    p.deps.url = `${url}-missing`;
    await refused('START_REMOTE', { reason: 'unreachable' });
    p.deps.url = url;
    await gitRemote(fx, ['update-ref', '-d', 'refs/heads/main']);
    await refused('START_BRANCH_NOT_ON_REMOTE', { remote: 'origin', branch: 'main' });
    await gitRemote(fx, ['update-ref', 'refs/heads/main', main]);
    // A fetch destination the fetch cannot create — a ref already named like a directory of it (not an own stale lock,
    // which the start removes first, final review FC-6): the remote answers, the local ref update fails (P2-FETCHLOCAL).
    await gitIn(p, ['update-ref', '-d', p.core.refs.localBranch]);
    const blocker = `${p.core.refs.localBranch}/blocker`;
    await gitIn(p, ['update-ref', blocker, main]);
    await refused('START_REMOTE', { reason: 'local_ref_update' });
    await gitIn(p, ['update-ref', '-d', blocker]);
    // HEAD behind Hr, then diverged from it, at genesis.
    await gitIn(other, ['commit', '-q', '--allow-empty', '-m', 'the branch moves']);
    await gitIn(other, ['push', '-q', fx.remote.url, 'HEAD:refs/heads/main']);
    const S2 = await gitIn(other, ['rev-parse', 'HEAD']);
    await refused('START_HEAD_BEHIND', { head8: short(main), base8: short(S2) });
    await gitIn(p, ['commit', '-q', '--allow-empty', '-m', 'local, unpushed']);
    await refused('START_HEAD_AHEAD', { c8: short(await gitIn(p, ['rev-parse', 'HEAD'])) });
    await gitIn(p, ['fetch', '-q', fx.remote.url, '+refs/heads/main:refs/remotes/origin/main']);
    await gitIn(p, ['reset', '-q', '--hard', S2]);
    assert.deepEqual(await localCoworkRefs(p), [], 'no refusal wrote a local cowork ref');

    await startOk(p, 'genesis');
    // The remote's branch now names another repository (an unrelated root commit).
    const empty = await gitRemote(fx, ['mktree']);
    const foreign = (await testRunner().run(['commit-tree', empty, '-m', 'another repository'], {
      class: 'refupdate', cwd: fx.remote.dir, identity: { name: 'Other', email: 'other@cowork.invalid' },
    })).stdout.toString('utf8').trim();
    await gitRemote(fx, ['update-ref', 'refs/heads/main', foreign]);
    await restartCore(p);
    const stateBefore = await p.core.repo.readRef(p.core.refs.state);
    await refused('START_REPO_IDENTITY', {});
    assert.equal(await p.core.repo.readRef(p.core.refs.state), stateBefore, 'the state is left as it was');
  });
});

test('a state written by a newer plugin (meta v 2) refuses START_STATE_NEWER{meta_v, own_v} and leaves the state as it is', async () => {
  await withStart('start-state-newer', { n: 1, files: FILES }, async (fx) => {
    const p = peerOf(fx, 0);
    await startOk(p, 'genesis');
    const view = p.core.view!;
    // A newer plugin's state commit: the same parents, a root meta blob with v 2.
    const metaV2 = await p.core.repo.hashBytes(buf(`${JSON.stringify({ ...view.meta, v: 2 })}\n`), true);
    const entries: MktreeEntry[] = [{ name: 'meta', mode: '100644', type: 'blob', oid: metaV2 }];
    const tree = await p.core.repo.mktree(entries);
    const newer = await p.core.repo.commitTree({ tree, parents: [view.laC, view.laB], subject: 'cowork state (a newer plugin)', trailers: [] });
    await gitIn(p, ['update-ref', p.core.refs.state, newer]);
    await restartCore(p);
    const spawns = pushSpawns(gitCallsOf(p));
    const r = await startDispatch(p.core, { publishLocal: null });
    assert.deepEqual(r, { ok: false, code: 'START_STATE_NEWER', params: { meta_v: 2, own_v: 1 } });
    assert.equal(await p.core.repo.readRef(p.core.refs.state), newer, 'the newer state is left as it was');
    assert.equal(pushSpawns(gitCallsOf(p)), spawns, 'no push');
  });
});

test('a malformed board refuses a join START_REMOTE{reason: board_malformed} and writes nothing', async () => {
  await withStart('start-board-malformed', { n: 2, files: FILES }, async (fx) => {
    const [p1, p2] = [peerOf(fx, 0), peerOf(fx, 1)];
    await startOk(p1, 'genesis');
    // A board ref naming a commit with no parent: readBoardCommit refuses it (BoardMalformedError no_parent).
    const empty = await gitRemote(fx, ['mktree']);
    const bad = (await testRunner().run(['commit-tree', empty, '-m', 'not a board commit'], {
      class: 'refupdate', cwd: fx.remote.dir, identity: { name: 'Other', email: 'other@cowork.invalid' },
    })).stdout.toString('utf8').trim();
    await gitRemote(fx, ['update-ref', p1.core.refs.remoteBoard, bad]);
    const before = await remoteRefs(fx);
    const spawns = pushSpawns(gitCallsOf(p2));
    const r = await startDispatch(p2.core, { publishLocal: null });
    assert.deepEqual(r, { ok: false, code: 'START_REMOTE', params: { reason: 'board_malformed' } });
    assert.deepEqual(await localCoworkRefs(p2), [], 'no state, no registry');
    assert.equal(p2.core.view, null);
    assert.equal(pushSpawns(gitCallsOf(p2)), spawns, 'no push');
    assert.deepEqual(await remoteRefs(fx), before);
  });
});

test('a board whose live chain carries no Cowork-Base (live_base fails with RemoteContentError, not BoardMalformedError) refuses a join START_REMOTE{reason: board_malformed} and writes nothing', async () => {
  await withStart('start-board-no-base', { n: 1, files: FILES }, async (fx) => {
    const p = peerOf(fx, 0);
    const repo = p.core.repo;
    const hr = (await repo.resolve('HEAD')) as Oid;
    // A board-shaped genesis whose live code has no Cowork-Base trailer: readBoardCommit and the fold accept it.
    const epoch = newEpoch(p.deps.ports.random);
    const other = 'c'.repeat(32);
    const writer: WriterId = { peer: other, epoch, seq: 2 };
    const L0 = await repo.commitTree({ tree: (await repo.readCommit(hr)).tree, parents: [], subject: CODE_SUBJECT, trailers: liveCommitTrailers(writer, [], [], new Map(), null) });
    const protocol = genesisProtocol(12, PLAN2_REGION_SPEC);
    const ops: Op[] = [{ id: `${other}/${epoch}/1`, type: 'caps', custom_refs: true, lease: true, delete: true, push_options: false, two_parent_ok: true }];
    const draft: BoardDraft = { liveCode: L0, writer, cs: [], protocol, checkpoint: null, heldIds: [], opsLines: serializeOps(ops).toString('utf8').split('\n').filter((l) => l.length > 0) };
    const s0 = foldCommit(initialFoldState(protocol), draft, other).state;
    const B0 = await buildBoardCommit(repo, { prevBoard: null, liveCode: L0, writer, ops, cs: [], csPaths: new Map(), protocol, checkpoint: serializeFold(s0) });
    const pushed = await runPush(repo, fx.remote.url, [pushSpec(B0, p.core.refs.remoteBoard, ABSENT), pushSpec(L0, p.core.refs.remoteCode, ABSENT)], []);
    assert.equal(pushed.statuses.get(p.core.refs.remoteBoard), 'ok');
    const before = await remoteRefs(fx);
    const r = await startDispatch(p.core, { publishLocal: null });
    assert.deepEqual(r, { ok: false, code: 'START_REMOTE', params: { reason: 'board_malformed' } });
    assert.deepEqual(await remoteRefs(fx), before);
    assert.deepEqual(await localCoworkRefs(p), [], 'no state, no registry');
  });
});

test('genesis decides "landed" from both the board and the mirror: a landed mirror with a refused board refuses START_REMOTE{genesis_push_failed} and the next start reads GENESIS_BOARD_MISSING; a landed board with a refused mirror is no genesis either', async () => {
  await withStart('start-genesis-partial-board', { n: 1, files: FILES }, async (fx) => {
    const p = peerOf(fx, 0);
    // A host that applies the mirror update of the non-atomic genesis push and refuses the board update.
    const restore = wrapGit(p, async (args, opts, inner) => (args[0] === 'push' && args.some((a) => a.endsWith(`:${p.core.refs.remoteBoard}`)) ? inner(withoutRef(args, p.core.refs.remoteBoard), opts) : inner(args, opts)));
    let r;
    try {
      r = await startDispatch(p.core, { publishLocal: null });
    } finally {
      restore();
    }
    assert.deepEqual(r, { ok: false, code: 'START_REMOTE', params: { reason: 'genesis_push_failed' } });
    const refs = await remoteRefs(fx);
    assert.ok(refs[p.core.refs.remoteCode] !== undefined && refs[p.core.refs.remoteBoard] === undefined, 'the mirror landed, the board did not');
    assert.deepEqual(await localCoworkRefs(p), [], 'no state');
    const again = await startDispatch(p.core, { publishLocal: null });
    assert.deepEqual(again, { ok: false, code: 'GENESIS_BOARD_MISSING', params: { branch: 'main' } });
  });
  await withStart('start-genesis-partial-mirror', { n: 1, files: FILES }, async (fx) => {
    const p = peerOf(fx, 0);
    const restore = wrapGit(p, async (args, opts, inner) => (args[0] === 'push' && args.some((a) => a.endsWith(`:${p.core.refs.remoteBoard}`)) ? inner(withoutRef(args, p.core.refs.remoteCode), opts) : inner(args, opts)));
    let r;
    try {
      r = await startDispatch(p.core, { publishLocal: null });
    } finally {
      restore();
    }
    assert.deepEqual(r, { ok: false, code: 'START_REMOTE', params: { reason: 'genesis_push_failed' } });
    assert.deepEqual(await localCoworkRefs(p), [], 'no state');
    // The board exists: the next start joins it (the mirror heals at the first publish).
    await startOk(p, 'join');
  });
});

test('every refusal of a fresh clone leaves its object store, private index and stage untouched (the preview is computed read-only)', async () => {
  await withStart('start-preview-readonly', { n: 1, files: FILES }, async (fx) => {
    const p = peerOf(fx, 0);
    await writeWork(p, 'src/b.txt', 'alpha\nbeta\ngamma, local\n');
    await writeWork(p, 'fresh.txt', 'brand new\n');
    const objects0 = looseObjects(p);
    const index0 = privateIndex(p);
    // START_REFUSED_CUSTOM_REFS after the preview passed with publishLocal 'none' (the probe's own commits aside).
    await fx.remote.rejectNext(3, 'policy', 'refs/cowork/');
    const r = await startDispatch(p.core, { publishLocal: 'none' });
    assert.deepEqual(r, { ok: false, code: 'START_REFUSED_CUSTOM_REFS', params: {} });
    assert.deepEqual(privateIndex(p), index0, 'the private index is unchanged');
    assert.deepEqual(readdirSync(joinPath(p.deps.paths.coworkDir, 'tmp', 'stage')), [], 'no stage copy is left');
    // The only new objects are the probe's own commits and their empty tree: no blob of the local work was written.
    const added = looseObjects(p).filter((o) => !objects0.includes(o));
    for (const o of added) {
      const type = await gitIn(p, ['cat-file', '-t', o]);
      assert.ok(type === 'commit' || type === 'tree', `${o}: only the probe's own commits and their empty tree (${type})`);
    }
  });
});

test('final review FB-6: on Windows a branch whose tree holds a root drive-prefix name (a:b.txt, which no index can hold) refuses START_REPO_SHAPE{reason: path_not_indexable} and writes nothing, never a GitCommandError respawn loop', {
  skip: process.platform !== 'win32' ? 'git refuses a root drive-prefix name in an index only on Windows' : false,
}, async () => {
  await withStart('start-fb6-colon', { n: 1, files: FILES }, async (fx) => {
    const p = peerOf(fx, 0);
    // A commit from a teammate on another OS adds a:b.txt to the branch (built with mktree: no index can hold it here).
    const head = await gitIn(p, ['rev-parse', 'HEAD']);
    const root = (await gitIn(p, ['ls-tree', '-z', 'HEAD^{tree}'])).split('\0').filter((r) => r.length > 0);
    const blob = await p.core.repo.hashBytes(buf('ab\n'), true);
    const entries: MktreeEntry[] = root.map((r) => {
      const [meta, name] = r.split('\t') as [string, string];
      const [mode, type, oid] = meta.split(' ') as [MktreeEntry['mode'], MktreeEntry['type'], string];
      return { name, mode, type, oid: oid as Oid };
    });
    const tree = await p.core.repo.mktree([...entries, { name: 'a:b.txt', mode: '100644', type: 'blob', oid: blob }]);
    const c = await gitIn(p, ['commit-tree', tree, '-p', head, '-m', 'a teammate adds a:b.txt']);
    await gitIn(p, ['update-ref', 'refs/heads/main', c]);
    await gitIn(p, ['push', '-q', fx.remote.url, `${c}:refs/heads/main`]);
    const before = await remoteRefs(fx);
    const r = await startDispatch(p.core, { publishLocal: null });
    assert.deepEqual(r, { ok: false, code: 'START_REPO_SHAPE', params: { reason: 'path_not_indexable' } });
    assert.deepEqual(await remoteRefs(fx), before, 'nothing written remotely');
    assert.deepEqual(await localCoworkRefs(p), [], 'no state');
  });
});

test('final review FB-6 (POSIX twin): where git indexes a root drive-prefix name, a branch whose tree holds a:b.txt starts (genesis): A holds the name, the carried path is never written to disk', {
  skip: process.platform === 'win32' ? 'git for Windows refuses a root drive-prefix name in an index (the Windows test above)' : false,
}, async () => {
  await withStart('start-fb6-colon-posix', { n: 1, files: FILES }, async (fx) => {
    const p = peerOf(fx, 0);
    const head = await gitIn(p, ['rev-parse', 'HEAD']);
    const root = (await gitIn(p, ['ls-tree', '-z', 'HEAD^{tree}'])).split('\0').filter((r) => r.length > 0);
    const blob = await p.core.repo.hashBytes(buf('ab\n'), true);
    const entries: MktreeEntry[] = root.map((r) => {
      const [meta, name] = r.split('\t') as [string, string];
      const [mode, type, oid] = meta.split(' ') as [MktreeEntry['mode'], MktreeEntry['type'], string];
      return { name, mode, type, oid: oid as Oid };
    });
    const tree = await p.core.repo.mktree([...entries, { name: 'a:b.txt', mode: '100644', type: 'blob', oid: blob }]);
    const c = await gitIn(p, ['commit-tree', tree, '-p', head, '-m', 'a teammate adds a:b.txt']);
    await gitIn(p, ['update-ref', 'refs/heads/main', c]);
    await gitIn(p, ['push', '-q', fx.remote.url, `${c}:refs/heads/main`]);
    const r = await startDispatch(p.core, { publishLocal: null });
    assert.deepEqual(r, { ok: true, mode: 'genesis', restart: null });
    assert.equal((await p.core.repo.readTreeMap(p.core.view!.base)).get('a:b.txt')?.oid, blob, 'A holds the name');
    assert.equal(existsSync(joinPath(p.deps.paths.workTree, 'a:b.txt')), false, 'never written');
  });
});

// ---- fix round 2 ----

test('remote-content errors are typed at their source (RemoteContentError): live_base of a chain without Cowork-Base, live_code of a board commit without a parent and the fold of a commit that is no board chain', async () => {
  await withStart('start-typed-remote', { n: 1, files: FILES }, async (fx) => {
    const p = peerOf(fx, 0);
    const repo = p.core.repo;
    const hr = (await repo.resolve('HEAD')) as Oid;
    await assert.rejects(liveBase(repo, hr), (e: unknown) => e instanceof RemoteContentError && /Cowork-Base/.test(e.message), 'live_base');
    const parentless = await repo.commitTree({ tree: await repo.mktree([]), parents: [], subject: 'no parent', trailers: [] });
    await assert.rejects(liveCodeOf(p.core, parentless), (e: unknown) => e instanceof RemoteContentError, 'live_code');
    await assert.rejects(p.core.folder.foldTo(parentless, null, PLAN2_REGION_SPEC), (e: unknown) => e instanceof RemoteContentError, 'the fold');
  });
});

test('a local plain Error inside the join\'s board reads (an EIO) is thrown as it is, never reported as START_REMOTE{board_malformed}', async () => {
  await withStart('start-join-local-error', { n: 2, files: FILES }, async (fx) => {
    const [p1, p2] = [peerOf(fx, 0), peerOf(fx, 1)];
    await startOk(p1, 'genesis');
    const err = Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO', syscall: 'read' });
    p2.core.folder.foldTo = async () => {
      throw err;
    };
    await assert.rejects(startDispatch(p2.core, { publishLocal: null }), (e: unknown) => e === err);
    assert.deepEqual(await localCoworkRefs(p2), [], 'nothing written');
  });
});

test('GENESIS_PUSH_PARTIAL is logged only for an observed outcome: a genesis push whose connection drops and whose classify fetch gets no answer refuses START_REMOTE{reason: unreachable} without it, and the next start resolves by observation (the board landed: JOIN)', async () => {
  await withStart('start-genesis-unobserved', { n: 1, files: FILES }, async (fx) => {
    const p = peerOf(fx, 0);
    const log = new LogRecorder();
    p.deps.log = log;
    await restartCore(p);
    let dropped = false;
    const restore = wrapGit(p, async (args, opts, inner) => {
      if (args[0] === 'push' && args.some((a) => a.endsWith(`:${p.core.refs.remoteBoard}`))) {
        await inner(args, opts);   // the host applies it; the connection drops before any status line
        dropped = true;
        return failedResult(128, 'fatal: the remote end hung up unexpectedly\n');
      }
      if (dropped && (args[0] === 'fetch' || args[0] === 'ls-remote')) return failedResult(128, 'fatal: unable to access the remote\n');
      return inner(args, opts);
    });
    let r;
    try {
      r = await startDispatch(p.core, { publishLocal: null });
    } finally {
      restore();
    }
    assert.deepEqual(r, { ok: false, code: 'START_REMOTE', params: { reason: 'unreachable' } });
    assert.equal(log.lines.some((l) => l.code === 'GENESIS_PUSH_PARTIAL'), false, 'no GENESIS_PUSH_PARTIAL for an outcome nobody observed');
    assert.deepEqual(await localCoworkRefs(p), [], 'no state');
    await startOk(p, 'join');
  });
});

test('the preview\'s cleanup never masks its result: a tmp/preview directory a holder keeps (its removal fails) still refuses START_PREVIEW', async () => {
  await withStart('start-preview-cleanup', { n: 1, files: FILES }, async (fx) => {
    const p = peerOf(fx, 0);
    await writeWork(p, 'src/b.txt', 'alpha\nbeta\ngamma, local\n');
    const dir = joinPath(p.deps.paths.coworkDir, 'tmp', 'preview');
    const rmrf = p.fs.rmrf.bind(p.fs);
    let calls = 0;
    p.fs.rmrf = async (d: string): Promise<void> => {
      if (d === dir && ++calls === 2) throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${d}'`), { code: 'EBUSY', syscall: 'rmdir', path: d });
      return rmrf(d);
    };
    let r;
    try {
      r = await startDispatch(p.core, { publishLocal: null });
    } finally {
      p.fs.rmrf = rmrf;
    }
    assert.equal(calls >= 2, true, 'the cleanup ran and failed');
    assert.deepEqual(r, { ok: false, code: 'START_PREVIEW', params: { n_in: 0, m_out: 1, unshared: 0 } });
  });
});

// ---- fix round 3 ----

/** A parentless commit created in the bare remote (no board commit: readBoardCommit and the Folder refuse it). */
async function parentlessInRemote(fx: CoreFixture): Promise<Oid> {
  const empty = await gitRemote(fx, ['mktree']);
  return (await testRunner().run(['commit-tree', empty, '-m', 'not a board commit'], {
    class: 'refupdate', cwd: fx.remote.dir, identity: { name: 'Other', email: 'other@cowork.invalid' },
  })).stdout.toString('utf8').trim() as Oid;
}

const eio = (): Error => Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO', syscall: 'read' });

test('prepareIteration maps a RemoteContentError of the fold or the live-chain reads exactly like a BoardMalformedError (incident board_shape), never an exception: with M07 a board ref naming a parentless commit passes the incident check and the Folder refuses it; a plain local Error from the fold is thrown as it is', async () => {
  await withStart('prepare-remote-content', { n: 1, files: FILES }, async (fx) => {
    const p = peerOf(fx, 0);
    await startOk(p, 'genesis');
    const B0 = p.core.view!.laB;
    const bad = await parentlessInRemote(fx);
    await gitRemote(fx, ['update-ref', p.core.refs.remoteBoard, bad]);
    // M07 switches the incident check off, so the fold is the first reader of the board (its RemoteContentError).
    setMutants(p, ['M07']);
    const prepared = await prepareIteration(p.core, 1, { materialize: false, forceFetch: true });
    assert.ok(!prepared.ok && prepared.why === 'incident' && prepared.verdict.why === 'board_shape' && prepared.verdict.observedBoard === bad, JSON.stringify(prepared));
    assert.equal(p.core.view!.laB, B0, 'nothing committed');
    // A local failure of the fold is no remote content.
    setMutants(p, []);
    await gitRemote(fx, ['update-ref', p.core.refs.remoteBoard, B0]);
    const err = eio();
    p.core.folder.foldTo = async () => {
      throw err;
    };
    await assert.rejects(prepareIteration(p.core, 2, { materialize: false, forceFetch: true }), (e: unknown) => e === err);
  });
});

test('once join or genesis has committed a state, a later RemoteContentError is no START_REMOTE refusal (refusals write nothing): startDispatch returns ok and the loop\'s incident path takes over (a fold error in the join\'s first apply; an injected one after the genesis state, its local work still observed); before any state is written the refusal stays and nothing is written', async () => {
  await withStart('start-remote-after-state-join', { n: 2, files: FILES }, async (fx) => {
    const [p1, p2] = [peerOf(fx, 0), peerOf(fx, 1)];
    await startOk(p1, 'genesis');
    const remote = (): RemoteContentError => new RemoteContentError('Folder: the first-parent chain does not start at a genesis board commit (injected)');
    // Before any state: the join's own fold read refuses, nothing written.
    const fold = p2.core.folder.foldTo.bind(p2.core.folder);
    p2.core.folder.foldTo = async () => {
      throw remote();
    };
    const before = await startDispatch(p2.core, { publishLocal: null });
    assert.deepEqual(before, { ok: false, code: 'START_REMOTE', params: { reason: 'board_malformed' } });
    assert.equal(p2.core.view, null, 'no state');
    assert.deepEqual(await localCoworkRefs(p2), [], 'nothing written');
    // After the join's state: its first apply's fold (the second fold call) meets remote content.
    let calls = 0;
    p2.core.folder.foldTo = async (...a) => {
      if (++calls === 1) return fold(...a);
      throw remote();
    };
    const points: string[] = [];
    setCrashHandler((name) => {
      points.push(name);
    });
    let r;
    try {
      r = await startDispatch(p2.core, { publishLocal: null });
    } finally {
      setCrashHandler(null);
    }
    assert.deepEqual(r, { ok: true, mode: 'join', restart: null });
    assert.ok(calls >= 2, 'the first apply folded');
    assert.ok((await p2.core.state.read()) !== null, 'the join state stays');
    assert.ok(points.includes('join.first_apply'), 'the join ran to join.first_apply');
    const next = await prepareIteration(p2.core, 1, { materialize: false, forceFetch: true });
    assert.ok(!next.ok && next.why === 'incident' && next.verdict.why === 'board_shape', `the loop's incident path: ${JSON.stringify(next)}`);
  });
  await withStart('start-remote-after-state-genesis', { n: 1, files: FILES }, async (fx) => {
    const p = peerOf(fx, 0);
    await writeWork(p, 'src/b.txt', 'alpha\nbeta\ngamma, local\n');
    const log = new LogRecorder();
    p.deps.log = log;
    // After the genesis state: closing the local work's change-set ('all') meets remote content (injected; the capture
    // itself is the loop's, final review FC-8).
    const done = p.core.cs.done.bind(p.core.cs);
    p.core.cs.done = (): void => {
      done();
      throw new RemoteContentError('injected after the genesis state');
    };
    const r = await startDispatch(p.core, { publishLocal: 'all' });
    assert.deepEqual(r, { ok: true, mode: 'genesis', restart: null });
    assert.ok((await p.core.state.read()) !== null, 'the genesis state stays');
    assert.ok(p.core.cs.openPaths().has('src/b.txt'), 'the local work is still observed (the loop captures it)');
    assert.ok(log.lines.some((l) => l.code === 'START_REMOTE_AFTER_STATE' && l.params['mode'] === 'genesis'), 'START_REMOTE_AFTER_STATE');
  });
});

test('live_base refuses remote content with RemoteContentError on every branch: a Cowork-Base value that is no oid, several Cowork-Base trailers, and a base commit that is neither a genesis nor a base move', async () => {
  await withStart('start-live-base-branches', { n: 1, files: FILES }, async (fx) => {
    const p = peerOf(fx, 0);
    const repo = p.core.repo;
    const hr = (await repo.resolve('HEAD')) as Oid;
    const tree = (await repo.readCommit(hr)).tree;
    const base = (value: string) => ({ key: 'Cowork-Base', value });
    const cases: Array<[string, Oid, RegExp]> = [
      ['no oid', await repo.commitTree({ tree, parents: [], subject: CODE_SUBJECT, trailers: [base('not-an-oid')] }), /no oid/],
      ['several', await repo.commitTree({ tree, parents: [], subject: CODE_SUBJECT, trailers: [base(hr), base(hr)] }), /carries 2 Cowork-Base trailers/],
      ['neither', await repo.commitTree({ tree, parents: [hr], subject: CODE_SUBJECT, trailers: [base(hr)] }), /neither a genesis nor a base move/],
    ];
    for (const [name, L, re] of cases) {
      await assert.rejects(liveBase(repo, L), (e: unknown) => e instanceof RemoteContentError && re.test(e.message), name);
    }
  });
});

/** A stale empty file at `rel` under the peer's gitdir (a lock a killed process left); its absolute path. */
async function plantLeftover(p: PeerFixture, rel: string): Promise<string> {
  const f = joinPath(p.deps.paths.gitDir, ...rel.split('/'));
  await mkdir(joinPath(f, '..'), { recursive: true });
  await writeFile(f, '');
  return f;
}

test('final review FC-6: own locks a killed first start left (refs/cowork-remote and refs/cowork-local locks, <e>.index.lock, tmp scratch-index locks) are removed before genesis or join: the start proceeds instead of refusing or crashing every time', async () => {
  await withStart('start-fc6-ownlocks', { n: 2, files: FILES }, async (fx) => {
    const [p1, p2] = [peerOf(fx, 0), peerOf(fx, 1)];
    const e1 = p1.core.refs.e;
    // Genesis: a fetch-destination lock (START_REMOTE{local_ref_update} on every start before) and a private index lock
    // (read-tree 'File exists' on every start before), with a scratch-index lock.
    const genesisLocks = [
      await plantLeftover(p1, `refs/cowork-remote/${e1}/branch.lock`),
      await plantLeftover(p1, `cowork/${e1}.index.lock`),
      await plantLeftover(p1, 'cowork/tmp/r.index.lock'),
    ];
    await startOk(p1, 'genesis');
    for (const f of genesisLocks) assert.equal(existsSync(f), false, `${f} removed`);
    // Join: the same kinds on the second clone, and the registry's lock (pinLocalWork's CAS).
    const e2 = p2.core.refs.e;
    const joinLocks = [
      await plantLeftover(p2, `refs/cowork-remote/${e2}/board.lock`),
      await plantLeftover(p2, `cowork/${e2}.index.lock`),
      await plantLeftover(p2, `refs/cowork-local/${e2}/holds.lock`),
    ];
    await writeWork(p2, 'src/b.txt', 'alpha\nbeta\ngamma\nlocal, held\n');
    await startOk(p2, 'join', { publishLocal: 'none' });
    for (const f of joinLocks) assert.equal(existsSync(f), false, `${f} removed`);
    assert.equal(p2.core.holds.nonTerminal().filter((h) => h.guards.some((g) => g.name === 'join')).length, 1, 'the join PIN was written');
  });
});

test('final review FC-6: with a state present, a stale refs/cowork-remote lock is removed before the identity fetch, so START_REPO_IDENTITY is checked on that run', async () => {
  await withStart('start-fc6-identity', { n: 1, files: FILES }, async (fx) => {
    const p = peerOf(fx, 0);
    await startOk(p, 'genesis');
    // The remote's branch now names another repository, and a killed run left a lock on the branch's fetch destination.
    const empty = await gitRemote(fx, ['mktree']);
    const foreign = (await testRunner().run(['commit-tree', empty, '-m', 'another repository'], {
      class: 'refupdate', cwd: fx.remote.dir, identity: { name: 'Other', email: 'other@cowork.invalid' },
    })).stdout.toString('utf8').trim();
    await gitRemote(fx, ['update-ref', 'refs/heads/main', foreign]);
    await restartCore(p);
    await plantLeftover(p, `refs/cowork-remote/${p.core.refs.e}/branch.lock`);
    const r = await startDispatch(p.core, { publishLocal: null });
    assert.deepEqual(r, { ok: false, code: 'START_REPO_IDENTITY', params: {} });
  });
});

test('final review FC minor: a branch whose cowork refs case-fold onto another branch\'s (main has a state; Main starts on the same clone: one loose ref directory on a case-insensitive file system) refuses START_BRANCH_NAME{reason: case_fold, other} before it reads or writes anything', async () => {
  await withStart('start-casefold', { n: 1, files: FILES }, async (fx) => {
    const p = peerOf(fx, 0);
    await startOk(p, 'genesis');
    const other = await createEngineCore({ ...p.deps, branch: 'Main' });
    const refs = await localCoworkRefs(p);
    const fetches = gitCallsOf(p).filter((c) => c.args[0] === 'fetch').length;
    const r = await startDispatch(other, { publishLocal: null });
    assert.deepEqual(r, { ok: false, code: 'START_BRANCH_NAME', params: { reason: 'case_fold', other: 'main' } });
    assert.deepEqual(await localCoworkRefs(p), refs, 'nothing written');
    assert.equal(gitCallsOf(p).filter((c) => c.args[0] === 'fetch').length, fetches, 'refused before any fetch');
  });
});

test('final review FC minor: a state whose meta names another branch is never attached to this one: START_BRANCH_NAME{reason: case_fold, other: meta.branch}, nothing written', async () => {
  await withStart('start-state-branch', { n: 1, files: FILES }, async (fx) => {
    const p = peerOf(fx, 0);
    await startOk(p, 'genesis');
    // main's cowork refs renamed to Main's in packed-refs (case-exact on every file system): Main's state ref now holds
    // a state written for main, and no ref of main is left to collide with.
    await gitIn(p, ['pack-refs', '--all']);
    const packed = joinPath(p.deps.paths.gitDir, 'packed-refs');
    const text = await readFile(packed, 'utf8');
    const lines = text.split('\n').filter((l) => l.length > 0);
    const header = lines.filter((l) => l.startsWith('#'));
    const entries = lines.filter((l) => !l.startsWith('#')).map((l) => l.replace(/ refs\/(cowork-local|cowork-remote)\/main\//, ' refs/$1/Main/'));
    entries.sort((x, y) => {
      const [a, b] = [x.slice(x.indexOf(' ') + 1), y.slice(y.indexOf(' ') + 1)];
      return a < b ? -1 : a > b ? 1 : 0;
    });
    await writeFile(packed, `${[...header, ...entries].join('\n')}\n`);
    assert.deepEqual((await localCoworkRefs(p)).filter((r) => r.includes('/main/')), [], 'no cowork ref of main is left');
    const other = await createEngineCore({ ...p.deps, branch: 'Main' });
    const view = await other.state.read();
    assert.equal(view?.meta.branch, 'main', 'Main\'s state ref holds main\'s state');
    const refs = await localCoworkRefs(p);
    const r = await startDispatch(other, { publishLocal: null });
    assert.deepEqual(r, { ok: false, code: 'START_BRANCH_NAME', params: { reason: 'case_fold', other: 'main' } });
    assert.deepEqual(await localCoworkRefs(p), refs, 'nothing written');
  });
});

test('final review FC minor: local work on a path named __proto__ is held by the join PIN of --publish=none (path-keyed maps hold own properties, never a prototype)', async () => {
  // A tracked file named __proto__ (a computed key: an own property, as git's tree holds it).
  await withStart('start-proto-pin', { n: 1, files: { ...FILES, ['__proto__']: buf('v0 of a file named __proto__\n') } }, async (fx) => {
    const p = peerOf(fx, 0);
    await writeWork(p, '__proto__', 'local work on __proto__\n');
    const A0 = await p.core.repo.readTreeMap(await headTree(p));
    await startOk(p, 'genesis', { publishLocal: 'none' });
    const pins = p.core.holds.nonTerminal().filter((h) => h.guards.some((g) => g.name === 'join'));
    assert.equal(pins.length, 1, 'one join PIN');
    const pin = pins[0]!;
    assert.deepEqual(pin.paths, ['__proto__']);
    assert.ok('h0' in pin.blobs);
    assert.deepEqual([Object.keys(pin.blobs.h0), Object.keys(pin.blobs.h1)], [['__proto__'], ['__proto__']], 'both maps name the path as an own key');
    assert.equal(pin.blobs.h0['__proto__'], A0.get('__proto__')!.oid);
    assert.equal(pin.blobs.h1['__proto__'], await p.core.repo.hashBytes(buf('local work on __proto__\n'), false));
  });
});
