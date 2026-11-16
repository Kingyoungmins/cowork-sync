// Step D on the out-of-loop iterations (Plan 3 final review F11; 01-engine §3.5 step 4, §3.8 occasion (c), ENG-14; 05-holds HLD-27,
// HLD-28, HLD-30, HLD-63; glossary §26.1 W6): Engine.resolve and Engine.parkAllForStop prepare an iteration that runs a detection tick
// (its dirty-set changes are a per-tick delta) and materializes the record's paths (PrepareOptions.holdPaths: the private-index entries
// move, Materialized.prevMap is the only copy of the old ones). The mass-change breaker runs on that tick and the revert detector on that
// materialization before anything acts on them, or the next loop iteration never sees either: a stale save that removes a teammate's line
// is absorbed without a `revert` record and published, and a formatter's batch never trips FREEZE(MASS). makeEngines on real clones of
// one file:// remote; the synthetic teammate (fx.pushTeamChange) writes the teammate lines; git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureAttrs } from '../../src/engine/core.js';
import { ABSENT } from '../../src/git/oid.js';
import { readWork, writeWork, type PeerFixture } from '../helpers/coreFixture.js';
import { withEngines, type EngineFixture } from '../helpers/engineFixture.js';
import { untilNoOpenCs } from '../helpers/escalationFixture.js';
import { fpy, remoteLiveFiles, restartEngine, roundsUntil, T10, teammateLine, withGuard } from '../helpers/loopHoldsFixture.js';
import { buf } from '../helpers/publishHelpers.js';

const N = 30;
const FILES: Record<string, Buffer> = { 'README.md': buf('# out-of-loop detection\n'), 'f.py': buf(fpy(N)) };
/** 16 tracked files: the breaker's window threshold is max(10, 2 % of 16) = 10 paths. */
const SRC: Record<string, Buffer> = { 'README.md': buf('# breaker\n') };
for (let i = 0; i < 15; i++) SRC[`src/f${i}.ts`] = buf(`export const v${i} = ${i};\n`);

type EnginePeer = EngineFixture['peers'][number];

async function started(fx: EngineFixture): Promise<EnginePeer> {
  await fx.startAll();
  await fx.rounds(2);
  return fx.peers[0]!;
}

/** The `leave` op id Plan 7 would allocate: this peer's next own op id. */
const leaveOpOf = (p: PeerFixture): string => `${p.core.peerId}/${p.core.view!.meta.epoch}/${p.core.view!.meta.seq_next}`;

test('Engine.resolve runs the revert detector on its hold-path materialization: a stale save that drops a teammate line, then any resolve inside the CS quiet period, makes a revert record, and the line stays on the team branch while the untainted edit publishes', T10, async () => {
  await withEngines('old-resolve-revert', { n: 1, files: FILES }, async (fx) => {
    const p = await started(fx);
    await teammateLine(fx, p, N, 10);
    // A record on f.py the human resolves; it already ended (R1's SUBSUMED, stood in here), so the verb answers HOLD_ALREADY_RESOLVED and
    // writes nothing — Engine.resolve still prepares with holdPaths = its paths before resolve() decides anything.
    const A = await p.core.repo.readTreeMap(p.core.view!.base);
    const a = A.get('f.py')!.oid;
    const id = await p.core.holds.hold({ kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths: ['f.py'], blobs: { h0: { 'f.py': a }, h1: { 'f.py': a } }, guard: 'join', origin: 'human', cs_ids: [], displaced_by: null });
    await p.core.holds.transition(id, { state: 'SUBSUMED' });
    // The human's stale buffer: TEAM = 1 is gone, and the human's own edit of row 25 is there.
    const stale = fpy(N, { replace: { 25: 'row_25 = human' } });
    await writeWork(p, 'f.py', stale);
    fx.advance(1_000);   // inside the human CS's 20 s quiet period: no loop iteration materializes before the resolve
    const res = await fx.resolve(0, id, 'publish');
    assert.deepEqual([res.kind, res.kind === 'done' ? res.code : null], ['done', 'HOLD_ALREADY_RESOLVED'], JSON.stringify(res));
    const recs = withGuard(p, 'revert');
    assert.equal(recs.length, 1, `the revert detector ran on the resolve's materialization: ${JSON.stringify(recs.map((r) => [r.id, r.paths]))}`);
    assert.deepEqual(recs[0]!.paths, ['f.py']);
    // The human CS publishes the untainted edit; the teammate's line stays on the team branch (HLD-27/28, INV-HLD-NOREVERT).
    await roundsUntil(fx, async () => (await remoteLiveFiles(fx, p)).get('f.py')?.includes('row_25 = human') === true, 'the untainted edit published', 24);
    assert.match((await remoteLiveFiles(fx, p)).get('f.py')!, /TEAM = 1/, 'the teammate line was not reverted on the team branch');
    assert.equal((await readWork(p, 'f.py'))?.toString('utf8'), stale, 'the disk keeps the human\'s bytes (the record holds the removal)');
  });
});

test('Engine.resolve runs the mass-change breaker on its detection tick: a formatter rewrites 12 of 16 files and a resolve inside one loop period enters FREEZE(MASS), and the batch never publishes', T10, async () => {
  await withEngines('old-resolve-mass', { n: 1, files: SRC }, async (fx) => {
    const p = await started(fx);
    const before = await remoteLiveFiles(fx, p);
    for (let i = 0; i < 12; i++) await writeWork(p, `src/f${i}.ts`, `export const v${i} = ${i}; // formatted\n`);
    // Any resolve: an id this peer does not hold (HOLD_NOT_OWNER) still runs the iteration's detection tick.
    const res = await fx.resolve(0, 'NOSUCHRECORD0000', 'publish');
    assert.deepEqual([res.kind, res.kind === 'refused' ? res.code : null], ['refused', 'HOLD_NOT_OWNER'], JSON.stringify(res));
    assert.ok(p.core.view!.meta.freeze_reasons.includes('MASS'), `the breaker saw the resolve's tick: ${JSON.stringify(p.core.view!.meta.freeze_reasons)}`);
    // 30 s of loop: the CS's quiet period is over, yet nothing of the batch publishes code under FREEZE(MASS).
    await fx.rounds(12);
    assert.ok(p.core.view!.meta.freeze_reasons.includes('MASS'));
    const after = await remoteLiveFiles(fx, p);
    for (let i = 0; i < 12; i++) assert.equal(after.get(`src/f${i}.ts`), before.get(`src/f${i}.ts`), `src/f${i}.ts: not published`);
  });
});

test('parkAllForStop runs the revert detector before it parks: a stale save on a candidate\'s path that drops a teammate line becomes a revert record, the stop parks it and the candidate both, so the line survives the stop, a restart and the next publishes', T10, async () => {
  await withEngines('old-stop-revert', { n: 1, files: FILES }, async (fx) => {
    let p = await started(fx);
    const team = await teammateLine(fx, p, N, 10);
    // A stop candidate on f.py: an ON_DISK PATCH holding the human's row-25 edit (h0 = A[f.py], h1 = the disk).
    const held = fpy(N, { after: { 10: 'TEAM = 1' }, replace: { 25: 'row_25 = held' } });
    await writeWork(p, 'f.py', held);
    const A = await p.core.repo.readTreeMap(p.core.view!.base);
    assert.equal((await p.core.repo.readBlob(A.get('f.py')!.oid)).toString('utf8'), team);
    const r = await p.core.holds.hold({
      kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: ['f.py'], guard: 'restart', origin: 'daemon', cs_ids: [], displaced_by: null,
      blobs: { h0: { 'f.py': A.get('f.py')!.oid }, h1: { 'f.py': await p.core.repo.hashBytes(buf(held), true) } },
    });
    await untilNoOpenCs(fx, p);
    assert.deepEqual(withGuard(p, 'revert'), [], 'no revert record yet');
    // A stale buffer drops TEAM = 1 (the held row-25 edit kept), and the stop comes before any loop iteration materializes it.
    await writeWork(p, 'f.py', fpy(N, { replace: { 25: 'row_25 = held' } }));
    fx.advance(1_000);
    const res = await p.engine.parkAllForStop(leaveOpOf(p));
    const reverts = p.core.holds.all().filter((x) => x.paths.includes('f.py') && x.guards.some((g) => g.name === 'revert'));
    assert.equal(reverts.length, 1, `the stop's iteration held the teammate-line removal in a revert record: ${JSON.stringify(res)}`);
    // HLD-63 step 3 (ruling R3-FF2-C2): the revert record shares r's path and parks too — r's park rewrote f.py, so the revert record
    // parks on a re-materialized S_disk, not on the one r's park made stale. Both OFF_DISK; the disk is A again (TEAM = 1, row 25 as A).
    const y = reverts[0]!.id;
    assert.deepEqual({ parked: [...res.parked].sort(), failed: res.failed }, { parked: [r, y].sort(), failed: [] }, JSON.stringify(res));
    for (const id of [r, y]) assert.deepEqual([p.core.holds.get(id)!.state, p.core.holds.get(id)!.residence], ['PARKED', 'OFF_DISK'], id);
    assert.equal((await readWork(p, 'f.py'))?.toString('utf8'), team, 'the stop left the team version on the disk');
    // The stop's drain, a restart (reseeded from state:snap, ObservedWrites empty) and the next publishes: TEAM = 1 stays on the team branch.
    await p.engine.drain(null);
    await restartEngine(p);
    p = fx.peers[0]!;
    await fx.rounds(16);
    assert.match((await remoteLiveFiles(fx, p)).get('f.py')!, /TEAM = 1/, 'the teammate line was not reverted on the team branch');
  });
});

test('integration I-4 (r2 rereview C): when the first park of the stop shrinks the shared path by more than 50 %, the stop waits the confirm interval and re-materializes once more, so the later candidate parks too', T10, async () => {
  // Probe zz_rr2_c: r holds an 80-line addition and the teammate line's removal is a revert record Y on the same path; r's
  // park writes the team version, < 50 % of the bytes the stop materialized first, so the re-materialization's tick holds f.py as
  // 'shrink' until a second sighting >= SHRINK_STABLE_MS later.
  await withEngines('old-stop-shrink', { n: 1, files: FILES }, async (fx) => {
    const p = await started(fx);
    const team = await teammateLine(fx, p, N, 10);
    const big = Array.from({ length: 80 }, (_, i) => `big_block_line_${i} = "a fairly long line of held text ${i}"`).join('\n');
    const held = fpy(N, { after: { 10: 'TEAM = 1', 25: big } });
    await writeWork(p, 'f.py', held);
    const A = await p.core.repo.readTreeMap(p.core.view!.base);
    const r = await p.core.holds.hold({
      kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: ['f.py'], guard: 'restart', origin: 'daemon', cs_ids: [], displaced_by: null,
      blobs: { h0: { 'f.py': A.get('f.py')!.oid }, h1: { 'f.py': await p.core.repo.hashBytes(buf(held), true) } },
    });
    await untilNoOpenCs(fx, p);
    await writeWork(p, 'f.py', fpy(N, { after: { 25: big } }));
    fx.advance(1_000);
    const res = await p.engine.parkAllForStop(leaveOpOf(p));
    const reverts = p.core.holds.all().filter((x) => x.paths.includes('f.py') && x.guards.some((g) => g.name === 'revert'));
    assert.equal(reverts.length, 1, JSON.stringify(res));
    const y = reverts[0]!.id;
    assert.deepEqual({ parked: [...res.parked].sort(), failed: res.failed }, { parked: [r, y].sort(), failed: [] }, JSON.stringify(res));
    for (const id of [r, y]) assert.deepEqual([p.core.holds.get(id)!.state, p.core.holds.get(id)!.residence], ['PARKED', 'OFF_DISK'], id);
    assert.equal((await readWork(p, 'f.py'))?.toString('utf8'), team, 'the stop left the team version on the disk');
  });
});

test('integration I-4 (r2 rereview C): when the first park of the stop deletes the shared path, the later candidate parks on the re-materialization too', T10, async () => {
  // Two `restart` PATCHes create new.py (not in A) with different contents; the first park writes A (ABSENT: a deletion). The rereview
  // read this as 'deletion_pending' on the re-materialization's tick; it is not — the park removes new.py's private-index entry, so the
  // tick has no tracked entry to confirm missing (this cell passed before the fix too): a guard for the deletion half of the sub-case.
  await withEngines('old-stop-delete', { n: 1, files: FILES }, async (fx) => {
    const p = await started(fx);
    const one = 'one = 1\n';
    await writeWork(p, 'new.py', one);
    // Two loops (5 s, inside its CS's 20 s quiet period): a tick admits new.py, so the iteration's scope classes it LIVE (the records
    // below are then local_only false: stop candidates) and nothing publishes it yet (A still lacks it).
    await fx.rounds(2);
    assert.equal(p.core.holds.all().length, 0);
    await ensureAttrs(p.core, p.core.view!.meta.EPOCH_BASE, ['new.py']);   // what a hold-creating caller requests first (R3-71)
    const mk = async (h1: string): Promise<string> => p.core.holds.hold({
      kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: ['new.py'], guard: 'restart', origin: 'daemon', cs_ids: [], displaced_by: null,
      blobs: { h0: { 'new.py': ABSENT }, h1: { 'new.py': await p.core.repo.hashBytes(buf(h1), true) } },
    });
    const r = await mk(one);
    const y = await mk('two = 2\n');
    assert.deepEqual([r, y].map((id) => [p.core.holds.get(id)!.local_only, p.core.holds.get(id)!.residence, p.core.holds.get(id)!.state]), [[false, 'ON_DISK', 'ACTIVE'], [false, 'ON_DISK', 'ACTIVE']], 'two stop candidates');
    fx.advance(1_000);
    const res = await p.engine.parkAllForStop(leaveOpOf(p));
    assert.deepEqual({ parked: [...res.parked].sort(), failed: res.failed }, { parked: [r, y].sort(), failed: [] }, JSON.stringify(res));
    for (const id of [r, y]) assert.deepEqual([p.core.holds.get(id)!.state, p.core.holds.get(id)!.residence], ['PARKED', 'OFF_DISK'], id);
    assert.equal(await readWork(p, 'new.py'), null, 'the stop left A (no new.py) on the disk');
  });
});
