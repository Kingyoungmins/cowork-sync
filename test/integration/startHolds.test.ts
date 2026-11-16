// Start and restart with holds (Plan 3 Task 12b; 05-holds HLD-64, HLD-01, HLD-25; F7 start; DAT-32; contract addition 3; rulings
// R3-26, R3-40, R3-53, R3-59, R3-69): a restart re-attaches the registry before the first publish, loads the provenance journal,
// restores the change-set table, and its first window re-mirrors every non-durable record; PARKED records are offered for RESTORE only
// after the start's TIP has been applied (one HOLD_PARKED log line); a lost-state `restart` record mirrors like any record; a joiner's
// journal starts empty at the join point and a rebuild reaches back no further; a not-stageable non-portable name blocks the human
// CS from the first tick on; and the start-time capture is captureStep's, with the CS table. makeEngines on real clones of one
// file:// remote; the synthetic teammate writes the teammate lines; git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rename, unlink } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { provRebuildFrom, stateJoinPoint } from '../../src/engine/core.js';
import { readCsTable } from '../../src/engine/state.js';
import { lineHash } from '../../src/holds/provenance.js';
import type { TraceEvent } from '../../src/ports/trace.js';
import { readWork, workPath, writeWork, type PeerFixture } from '../helpers/coreFixture.js';
import { logOf, remoteBoardTip, withEngines, type EngineFixture } from '../helpers/engineFixture.js';
import { rec, untilDurable, untilNoOpenCs } from '../helpers/escalationFixture.js';
import { fpy, humanRemovesTeamLine, remoteLiveFiles, restartEngine, roundsUntil, T10, teammateLine, withGuard } from '../helpers/loopHoldsFixture.js';
import { buf, failedResult, wrapGit } from '../helpers/publishHelpers.js';
import { gitIn } from '../helpers/startFixture.js';

const N = 30;
const WIN = process.platform === 'win32';
/** R3-53's not-stageable name (Task 7's): `a:b`-style off win32 (SEC-35), a dotgit-alias component on win32 (NTFS cannot hold `:`). */
const NOT_STAGEABLE = WIN ? '.g\u{200c}it/old.py' : 'src/old:v2.py';
const FILES: Record<string, Buffer> = {
  'README.md': buf('# start holds\n'),
  'f.py': buf(fpy(N)),
  'g.txt': buf('g1\ng2\ng3\n'),
  'other.txt': buf('o1\no2\no3\n'),
  'src/old.py': buf('print("old")\n'),
};

type EnginePeer = EngineFixture['peers'][number];

async function started(fx: EngineFixture): Promise<EnginePeer> {
  await fx.startAll();
  await fx.rounds(2);
  return fx.peers[0]!;
}

const mine = (p: PeerFixture) => (e: TraceEvent): boolean => (e as { peer?: string }).peer === p.core.peerId;

function offline(p: PeerFixture): () => void {
  return wrapGit(p, async (args, opts, inner) => (args[0] === 'fetch' || args[0] === 'ls-remote' || args[0] === 'push'
    ? failedResult(128, 'fatal: unable to access the remote\n') : inner(args, opts)));
}

test('HLD-64 / F7 start: a restart re-attaches the registry before the first publish, loads provenance, restores the CS table from a fresh cache, and the first window re-mirrors every non-durable record', T10, async () => {
  await withEngines('start-f7', { n: 1, files: FILES }, async (fx) => {
    let p = await started(fx);
    await teammateLine(fx, p, N, 10);
    const durable = (await humanRemovesTeamLine(fx, p, N)).id;
    await untilDurable(fx, p, [durable]);
    await untilNoOpenCs(fx, p);
    // A record no window has mirrored yet, and an open seat CS (the effect signal writes the CS cache, naming the state commit).
    const A = await p.core.repo.readTreeMap(p.core.view!.base);
    const pending = await p.core.holds.hold({ kind: 'PATCH', residence: 'OFF_DISK', state: 'PARKED', paths: ['g.txt'], guard: 'revert', origin: 'human', cs_ids: [], displaced_by: null, blobs: { h0: { 'g.txt': A.get('g.txt')!.oid }, h1: { 'g.txt': await p.core.repo.hashBytes(buf('g1\ng2 held\ng3\n'), true) } } });
    await writeWork(p, 'other.txt', 'o1\no2 seat\no3\n');
    await fx.signal(0, { kind: 'effect', seat: 'aa'.repeat(16), agent: null, toolUseId: 'tu1', paths: ['other.txt'], turnOrigin: 'prompt' });
    assert.ok(p.core.cs.table().cs.some((e) => e.kind === 'seat' && e.state === 'open' && e.paths.includes('other.txt')));
    await p.engine.drain(null);
    const pushes = p.core.pushAttempts;
    await restartEngine(p);
    p = fx.peers[0]!;
    // Before any iteration: the registry, the provenance journal and the CS table are back.
    assert.deepEqual([durable, pending].map((id) => p.core.holds.get(id)?.id), [durable, pending], 'the registry re-attached');
    assert.equal(p.core.pushAttempts, 0, 'nothing published by the start');
    assert.ok(pushes > 0);
    assert.ok(p.core.prov.newest() !== null, 'the provenance journal is loaded');
    assert.ok(p.core.prov.addedBy(lineHash(buf('TEAM = 1'))).some((w) => w !== p.core.peerId), 'the teammate line is protected');
    assert.ok(p.core.cs.table().cs.some((e) => e.kind === 'seat' && e.state === 'open' && e.paths.includes('other.txt')), 'the open seat CS restored from the cache');
    assert.equal((await p.engine.inspect()).mirror[pending]?.durable, false);
    // The first window (the first Bnew of this run carrying hold ops) re-mirrors the non-durable record.
    const from = fx.trace.events.length;
    const firstMirror = (): TraceEvent | undefined => fx.trace.events.slice(from).filter(mine(p)).find((e) => e.kind === 'mirror');
    await roundsUntil(fx, () => firstMirror() !== undefined, 'the first window', 8);
    const first = firstMirror()!;
    assert.ok(first.kind === 'mirror' && first.holds.some((h) => h.id === pending), 'the first window carried its op');
    await untilDurable(fx, p, [pending, durable]);
  });
});

test('PARKED records appear in restoreOffers only after the start\'s TIP has been applied, with one HOLD_PARKED log line', T10, async () => {
  await withEngines('start-offers', { n: 1, files: FILES }, async (fx) => {
    let p = await started(fx);
    const log = logOf(p);
    await teammateLine(fx, p, N, 10);
    const id = (await humanRemovesTeamLine(fx, p, N)).id;
    assert.equal((await fx.resolve(0, id, 'park')).kind, 'done');
    await untilDurable(fx, p, [id]);
    assert.deepEqual((await p.engine.inspect()).restoreOffers, [id]);
    await p.engine.drain(null);
    await fx.pushTeamChange({ 'other.txt': buf('o1\no2 team\no3\n') });   // TIP moves while the daemon is down
    await restartEngine(p);
    p = fx.peers[0]!;
    const lines = (): number => log.lines.filter((l) => l.code === 'HOLD_PARKED' && l.params.next === '/cowork resolve <id> --restore').length;
    const before = lines();
    assert.deepEqual((await p.engine.inspect()).restoreOffers, [], 'not before the start\'s TIP is applied');
    await roundsUntil(fx, async () => (await readWork(p, 'other.txt'))?.toString('utf8') === 'o1\no2 team\no3\n', 'TIP applied', 6);
    assert.deepEqual((await p.engine.inspect()).restoreOffers, [id], 'offered once TIP is applied');
    assert.equal(lines(), before + 1, 'one HOLD_PARKED line');
    assert.deepEqual(log.lines.filter((l) => l.code === 'HOLD_PARKED').at(-1)!.params, { hids: id, next: '/cowork resolve <id> --restore' });
    await fx.rounds(3);
    assert.equal(lines(), before + 1, 'still one');
  });
});

test('a lost-state restart record mirrors in the next window like any record', T10, async () => {
  await withEngines('start-lost', { n: 1, files: FILES }, async (fx) => {
    const p = await started(fx);
    // The state ref deleted under a live daemon (ENG-54: lost while this core was live, never a re-join), with a local edit no chain
    // holds on disk: the start's restart rebuilds the state and keeps the bytes in a masked `restart` record.
    await writeWork(p, 'g.txt', 'g1\ng2 a local edit no chain holds\ng3\n');
    await gitIn(p, ['update-ref', '-d', p.core.refs.state]);
    const r = await p.engine.start({ publishLocal: null });
    assert.ok(r.ok && r.mode === 'restart' && r.restart?.lostState !== null && r.restart?.lostState !== undefined, JSON.stringify(r));
    const ids = r.restart!.lostState!.records;
    assert.equal(ids.length, 1, 'one restart record');
    const id = ids[0]!;
    assert.deepEqual([rec(p, id).guards.map((g) => g.name), rec(p, id).residence, rec(p, id).local_only], [['restart'], 'ON_DISK', false]);
    const from = fx.trace.events.length;
    await fx.rounds(1);
    assert.ok(fx.trace.events.slice(from).filter(mine(p)).some((e) => e.kind === 'mirror' && e.holds.some((h) => h.id === id)), 'its op left in the next window');
    await untilDurable(fx, p, [id]);
  });
});

test('a peer joining after a teammate added TEAM_OLD starts with an empty provenance journal: its edit removing TEAM_OLD creates no revert record, while a line the teammate adds after the join stays protected; after deleting the journal and restarting, the rebuild back to provRebuildFrom gives the same verdicts', T10, async () => {
  await withEngines('start-prov', { n: 2, files: FILES }, async (fx) => {
    const [p0, p1] = fx.peers as [EnginePeer, EnginePeer];
    const s0 = await p0.engine.start({ publishLocal: null });
    assert.ok(s0.ok && s0.mode === 'genesis');
    for (let i = 0; i < 2; i++) {
      fx.advance(2_500);
      await p0.engine.iterate();
    }
    const old = fpy(N, { after: { 10: 'TEAM_OLD = 1' } });
    const { live: tip } = await fx.pushTeamChange({ 'f.py': buf(old) });
    const s1 = await p1.engine.start({ publishLocal: null });
    assert.ok(s1.ok && s1.mode === 'join');
    assert.equal((await readWork(p1, 'f.py'))?.toString('utf8'), old, 'the join applied TIP');
    // The join loaded the journal at TIP (load(tip, tip)): its first apply's advance appended nothing before the load point.
    assert.equal(await stateJoinPoint(p1.core), tip, 'the join point is the live code of the join\'s laB (TIP)');
    assert.deepEqual(p1.core.prov.addedBy(lineHash(buf('TEAM_OLD = 1'))), [], 'no pre-join protection');
    await fx.rounds(2);
    await writeWork(p1, 'f.py', fpy(N));
    fx.advance(21_000);
    await fx.rounds(3);
    assert.deepEqual(withGuard(p1, 'revert'), [], 'removing TEAM_OLD creates no revert record');
    await roundsUntil(fx, async () => (await remoteLiveFiles(fx, p1)).get('f.py') === fpy(N), 'the removal published', 8);
    // A line the teammate adds after the join stays protected.
    const added = fpy(N, { after: { 20: 'TEAM_NEW = 1' } });
    await fx.pushTeamChange({ 'f.py': buf(added) });
    await roundsUntil(fx, async () => (await readWork(p1, 'f.py'))?.toString('utf8') === added, 'TEAM_NEW applied');
    assert.ok(p1.core.prov.addedBy(lineHash(buf('TEAM_NEW = 1'))).some((w) => w !== p1.core.peerId));
    await humanRemovesTeamLine(fx, p1, N);
    // The journal deleted while the daemon is down: the restart rebuilds it over (provRebuildFrom, laC], no further than the join point.
    await p1.engine.drain(null);
    await unlink(join(p1.deps.paths.coworkDir, 'prov', `${p1.core.refs.e}.jsonl`));
    await restartEngine(p1);
    const q = fx.peers[1]!;
    assert.equal(await provRebuildFrom(q.core), tip, 'the rebuild reaches back to the join point only');
    assert.deepEqual(q.core.prov.addedBy(lineHash(buf('TEAM_OLD = 1'))), [], 'TEAM_OLD: still unprotected');
    assert.ok(q.core.prov.addedBy(lineHash(buf('TEAM_NEW = 1'))).some((w) => w !== q.core.peerId), 'TEAM_NEW: still protected');
  });
});

test('a restart with a not-stageable non-portable name on disk publishes nothing of the human CS', T10, async () => {
  await withEngines('start-portability', { n: 1, files: FILES }, async (fx) => {
    let p = await started(fx);
    await p.engine.drain(null);
    // src/old.py renamed to a name no record can carry while the daemon is down.
    const to = workPath(p, NOT_STAGEABLE);
    await mkdir(dirname(to), { recursive: true });
    await rename(workPath(p, 'src/old.py'), to);
    const tip = await remoteBoardTip(fx);
    await restartEngine(p);
    p = fx.peers[0]!;
    await fx.rounds(1);
    assert.ok(p.core.cs.blocked().has(NOT_STAGEABLE), 'the first detection tick ran portabilityStep before any publish');
    fx.advance(21_000);
    await fx.rounds(6);
    assert.ok(p.core.cs.blocked().has(NOT_STAGEABLE));
    const live = await remoteLiveFiles(fx, p);
    assert.equal(live.get('src/old.py'), 'print("old")\n', 'the deletion of src/old.py is never published alone');
    assert.notEqual(tip, undefined);
  });
});

test('a restart\'s captureLocalWork goes through captureStep once a CS table exists', T10, async () => {
  await withEngines('start-cstable', { n: 1, files: FILES }, async (fx) => {
    let p = await started(fx);
    // A capture of the loop (captureStep) journals the CS table.
    await writeWork(p, 'g.txt', 'g1\ng2 mine\ng3\n');
    await fx.rounds(1);
    fx.advance(21_000);
    await roundsUntil(fx, async () => (await remoteLiveFiles(fx, p)).get('g.txt') === 'g1\ng2 mine\ng3\n', 'published', 12);
    const table0 = await readCsTable(p.core.repo, p.core.view!);
    assert.ok(table0 !== null, 'a CS table is journaled');
    await p.engine.drain(null);
    await writeWork(p, 'other.txt', 'o1\no2 while down\no3\n');   // an unpublished human delta on disk at restart
    await restartEngine(p);
    p = fx.peers[0]!;
    const reconnect = offline(p);   // keep the pair journaled (unpublished) to read it
    try {
      fx.advance(21_000);
      await roundsUntil(fx, () => p.core.cs.ready().some((x) => x.paths.includes('other.txt')), 'the restart\'s capture', 12);
    } finally {
      reconnect();
    }
    const pair = p.core.cs.ready().find((x) => x.paths.includes('other.txt'))!;
    const journaled = p.core.view!.ready.find((x) => x.csId === pair.csId);
    assert.ok(journaled !== undefined, 'StateStore.commit accepted the update');
    const table = await readCsTable(p.core.repo, p.core.view!);
    assert.equal(table?.orders[pair.csId], journaled.order, 'the order the journaled table names');
    assert.ok(journaled.order > Math.max(0, ...Object.values(table0.orders)), 'after every earlier order');
  });
});

test('the start-time capture of R-22 \'all\' goes through captureStep: the genesis journals the CS table with the pair', T10, async () => {
  await withEngines('start-all-table', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, 'local.txt', 'local work before the start\n');
    const r = await p.engine.start({ publishLocal: 'all' });
    assert.ok(r.ok && r.mode === 'genesis', JSON.stringify(r));
    const ready = p.core.view!.ready;
    assert.equal(ready.length, 1, 'M captured at the start');
    const table = await readCsTable(p.core.repo, p.core.view!);
    assert.ok(table !== null, 'the CS table journaled with the pair (captureStep, R3-40)');
    assert.equal(table.orders[ready[0]!.csId], ready[0]!.order);
    await fx.rounds(3);
    assert.equal((await remoteLiveFiles(fx, p)).get('local.txt'), 'local work before the start\n');
  });
});
