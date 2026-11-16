// INV-HLD-DURABLE and the INV-NOLOSS registry/held locations across a lost clone and a lost state ref (Plan 3 Task 15; 11-testing §7
// TC-HLD-04, TC-ENG-13 (Plan 3 part); 05-holds HLD-57 (a), HLD-62, HLD-64, INV-HLD-DURABLE; ENG-54; rulings R3-26, R3-48). Engines on real
// clones of one file:// bare remote (makeEngines); a fresh clone joins later as its own Engine; git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { BOARD_SUBJECT, boardTrailers, readBoardCommit, readHeldAll, type WriterId } from '../../src/board/boardCommit.js';
import { canonicalJson, type Json } from '../../src/board/canonicalJson.js';
import { foldCommit, initialFoldState, type FoldState } from '../../src/board/fold.js';
import { humanOnlyAttribution, noClaude, PLAN2_REGION_SPEC, type EngineDeps } from '../../src/engine/deps.js';
import { DaemonLock, Engine } from '../../src/engine/loop.js';
import { foldPatch } from '../../src/engine/core.js';
import { RELEASE_NAMESPACE } from '../../src/engine/refs.js';
import { restart } from '../../src/engine/restart.js';
import { parseOid, type Oid } from '../../src/git/oid.js';
import type { MktreeEntry } from '../../src/git/repo.js';
import { pushSpec, runPush } from '../../src/git/push.js';
import { plan3Ports } from '../../src/holds/ports.js';
import { guardName, isTerminal, type HoldRecord } from '../../src/holds/record.js';
import { KilledAt, setCrashHandler } from '../../src/ports/crashpoint.js';
import { realFs } from '../../src/ports/fs.js';
import { alwaysLeased } from '../../src/ports/lease.js';
import { seededRandom } from '../../src/ports/random.js';
import { PLUGIN_VERSION } from '../../src/version.js';
import { readWork, writeWork, type PeerFixture } from '../helpers/coreFixture.js';
import { testRegionDeps } from '../helpers/regionDeps.js';
import { lockOf, remoteBoardTip, withEngines, type EngineFixture } from '../helpers/engineFixture.js';
import { fpy, roundsUntil, withGuard } from '../helpers/loopHoldsFixture.js';
import { buf, LogRecorder } from '../helpers/publishHelpers.js';
import { gitIn } from '../helpers/startFixture.js';
import { testRunner } from '../helpers/tmp.js';
import { FaultFs } from '../sim/faultfs.js';
import { readBlob, readRegistry } from '../sim/holdsView.js';
import { findMarkers } from '../sim/markers.js';
import { heldSide } from '../sim/oracleNoloss.js';
import { clonePeer } from '../sim/peers.js';
import { SIM_WALL_EPOCH_MS, VirtualClock } from '../sim/vclock.js';

const T = { timeout: 30 * 60_000 };
const N = 12;
const FILES: Record<string, Buffer> = {
  'README.md': buf('# durability\n'),
  'f.py': buf(fpy(N)),
  'notes.txt': buf(Array.from({ length: 9 }, (_, k) => `note row ${k}\n`).join('')),
  'mixed.txt': buf('a\r\nb\nc\r\nd\n'),
  'worker.py': buf('w1\nw2\nw3\n'),
  'lock.txt': buf('l1\nl2\nl3\n'),
};

/** A peer that joins later: its own clone, clock (in step with p1's), FaultFs, daemon.lock and Engine on the fixture's remote, scheduler and trace. */
interface Fresh { name: string; dir: string; clock: VirtualClock; deps: EngineDeps; engine: Engine; lock: DaemonLock; }
async function freshPeer(fx: EngineFixture, name: string, like: PeerFixture): Promise<Fresh> {
  const runner = testRunner();
  const clone = await clonePeer(fx.remote, fx.root, { name, autocrlf: false, withFilter: false }, runner);
  // Its wall clock at least 60 s past the real now (as makeCores starts every peer's): the checkout's real mtimes are then past the
  // quiet window, not in this PC's future (a join would count every unsettled tracked path as local work).
  const clock = new VirtualClock({ wallOffsetMs: Math.max(like.clock.wallMs(), Date.now() + 60_000) - SIM_WALL_EPOCH_MS, startMono: like.clock.monoMs() });
  const fs = new FaultFs(realFs);
  const workTree = realpathSync.native(clone.dir);
  const deps: EngineDeps = {
    ports: { clock, random: seededRandom(`durability/${name}`), scheduler: fx.scheduler, fs, git: runner },
    trace: fx.trace, log: new LogRecorder(), lease: alwaysLeased, attribution: humanOnlyAttribution, claude: noClaude, heartbeatMs: () => clock.monoMs(),
    paths: { workTree, gitDir: join(workTree, '.git'), coworkDir: join(workTree, '.git', 'cowork') },
    branch: 'main', namespace: RELEASE_NAMESPACE, url: fx.remote.url, display: `Peer ${name}`, pluginVersion: PLUGIN_VERSION, pluginSha: 'f'.repeat(64),
    regionSpec: PLAN2_REGION_SPEC, platform: process.platform, testBuild: true, testMutants: new Set(), ...plan3Ports(),
    regions: await testRegionDeps({ clock }),   // Plan 4 Task 5 (R4-36): the test region module (inline workers)
  };
  const lock = await DaemonLock.acquire(fs, deps.paths.coworkDir, { pluginVersion: PLUGIN_VERSION, instance: `fresh-${name}` });
  assert.ok(lock instanceof DaemonLock, `${name}: daemon.lock`);
  const engine = await Engine.create(deps);
  fx.trace.names.set(engine.peerId, name);
  return { name, dir: workTree, clock, deps, engine, lock };
}

/** fx.rounds for the fixture's live peers plus the fresh one (its clock moves with theirs). */
async function roundsWith(fx: EngineFixture, fresh: Fresh, live: ReadonlyArray<PeerFixture & { engine: Engine }>, n: number, loopMs = 2_500): Promise<void> {
  for (let i = 0; i < n; i++) {
    fx.advance(loopMs);
    fresh.clock.advance(loopMs);
    for (const p of live) await p.engine.iterate();
    await fresh.engine.iterate();
  }
}

/** Every hold op of the board chain up to `tip`, folded test-side from B0: none may be rejected ("no fold-rejected hold op"). */
async function rejectedHoldOps(p: PeerFixture, tip: Oid): Promise<string[]> {
  const repo = p.core.repo;
  const chain: Oid[] = [];
  for (let c: Oid | null = tip; c !== null;) {
    const b = await readBoardCommit(repo, c);
    chain.push(c);
    c = b.parents.length >= 2 ? (b.parents[0] as Oid) : null;   // B0's parents are [L0]
  }
  chain.reverse();
  let state: FoldState | null = null;
  const out: string[] = [];
  for (const c of chain) {
    const b = await readBoardCommit(repo, c);
    state ??= initialFoldState(b.protocol!);
    const { parents: _p, firstParent: _f, oid: _o, ...draft } = b as typeof b & { parents: unknown; firstParent: unknown; oid: unknown };
    const step = foldCommit(state, draft, '0'.repeat(32));
    for (const v of step.opVerdicts) if (v.type === 'hold' && v.verdict === 'rejected') out.push(`${c}: ${v.opId} ${v.reason ?? ''}`);
    state = step.state;
  }
  return out;
}

test('TC-HLD-04 durability (makeEngines, 2 peers): p0 holds a revert PATCH, an OFF_DISK K4 PATCH, an eol-bom PATCH with the dependency PIN of its CS, and an INCOMING lock record; after one landed governed push of p0, p0 is killed (KilledAt at its next crashpoint), git gc --prune=now runs in the remote and p0\'s clone, p0\'s clone directory is deleted, and a fresh clone joins as p2: its fold lists every non-terminal non-local_only id of p0 with held/ blobs byte-equal to p0\'s last registry blobs; resolve(id, \'restore\') on p2 before p0 has left is refused HOLD_NOT_OWNER; the test then lands p0\'s `leave` op with a test-written board commit under p0\'s writer id and its next seq (Task 4\'s stale-prev_rev mechanism; Plan 3 has no stop verb), and after p2 folds it resolve(id, \'restore\') on p2 (HLD-64 copy-restore) writes byte-exact content under a new id; the run has no fold-rejected hold op', T, async () => {
  await withEngines('tc-hld-04', { n: 2, files: FILES }, async (fx) => {
    await fx.startAll({ publishLocal: 'all' });
    await fx.rounds(4);
    const [p0, p1] = [fx.peers[0]!, fx.peers[1]!];
    // A revert PATCH: a teammate's f.py line removed by p0's stale save.
    await fx.pushTeamChange({ 'f.py': buf(fpy(N, { after: { 4: 'TEAM = 1' } })) });
    await roundsUntil(fx, async () => (await readWork(p0, 'f.py'))?.toString('utf8').includes('TEAM = 1') === true, 'the teammate line applied');
    await writeWork(p0, 'f.py', fpy(N));   // a stale save without the line (nothing else changed: the copy-restore then writes h1 exactly)
    await roundsUntil(fx, () => withGuard(p0, 'revert').length === 1, 'the revert PATCH', 20);
    // An OFF_DISK K4 PATCH: p0's notes.txt row 4 against the team's same row.
    await writeWork(p0, 'notes.txt', Array.from({ length: 9 }, (_, k) => (k === 4 ? 'note row 4 p0\n' : `note row ${k}\n`)).join(''));
    await fx.pushTeamChange({ 'notes.txt': buf(Array.from({ length: 9 }, (_, k) => (k === 4 ? 'note row 4 team\n' : `note row ${k}\n`)).join('')) });
    await roundsUntil(fx, () => withGuard(p0, 'conflict').some((r) => r.residence === 'OFF_DISK'), 'the OFF_DISK K4 PATCH', 30);
    // An eol-bom PATCH (a canon-refused mixed-EOL save) with the dependency PIN of its CS (worker.py in the same CS).
    await writeWork(p0, 'mixed.txt', 'a\nb\nc\nd\nE\n');
    await writeWork(p0, 'worker.py', 'w1\nw2 p0\nw3\n');
    await roundsUntil(fx, () => withGuard(p0, 'eol-bom').length === 1 && withGuard(p0, 'dependency').length === 1, 'the eol-bom PATCH and its dependency PIN', 30);
    // An INCOMING lock record: lock.txt held share-read by another program while the team changes it, 60 s and more.
    const release = p0.fs.holdLock(`${sep}lock.txt`, 'share-read');
    await fx.pushTeamChange({ 'lock.txt': buf('l1\nl2 team\nl3\n') });
    await roundsUntil(fx, () => p0.core.holds.nonTerminal().some((r) => r.kind === 'INCOMING' && r.guards.some((g) => guardName(g) === 'lock')), 'the INCOMING lock record', 40, 5_000);
    // One landed governed push of p0 after all four exist: every non-terminal non-local_only record durable.
    const recs = (): HoldRecord[] => p0.core.holds.nonTerminal().filter((r) => !r.local_only);
    await roundsUntil(fx, async () => {
      const ins = await p0.engine.inspect();
      return recs().every((r) => ins.mirror[r.id]?.durable === true);
    }, 'every record durable after a landed push of p0', 20);
    const kinds = recs().map((r) => [r.kind, r.residence, r.guards.map((g) => guardName(g))]);
    for (const g of ['revert', 'conflict', 'eol-bom', 'dependency', 'lock']) assert.ok(kinds.some(([, , gs]) => (gs as string[]).includes(g)), `p0 holds a ${g} record: ${JSON.stringify(kinds)}`);
    // p0's last registry blobs, its writer identity and the board's fold of its seq — before its clone goes.
    const reg = await readRegistry(testRunner(), p0.deps.paths.workTree, 'main');
    const expected = new Map<string, Map<string, string>>();
    for (const r of reg.records.values()) {
      if (isTerminal(r) || r.local_only) continue;
      const m = new Map<string, string>();
      for (const [stage, side] of Object.entries(r.blobs as Record<string, Record<string, string>>)) for (const [path, oid] of Object.entries(side)) if (oid !== 'ABSENT') m.set(`${stage}/${path}`, oid);
      expected.set(r.id, m);
    }
    const revertId = recs().find((r) => r.guards.some((g) => guardName(g) === 'revert'))!.id;
    const revertH1 = heldSide(reg.records.get(revertId)!).find((x) => x.path === 'f.py')!.oid;
    const revertBytes = await readBlob(testRunner(), p0.deps.paths.workTree, parseOid(revertH1));
    const p0Id = p0.core.peerId;
    // p0 killed at its next crashpoint.
    let killed: string | null = null;
    const prev = setCrashHandler((name) => {
      if (killed === null) {
        killed = name;
        throw new KilledAt(name);
      }
    });
    try {
      await writeWork(p0, 'README.md', '# durability, p0 again\n');   // something to do, so the next iteration reaches a crashpoint
      for (let i = 0; i < 12 && killed === null; i++) {
        fx.advance(2_500);
        try {
          await p0.engine.iterate();
        } catch (e) {
          if (!(e instanceof KilledAt)) throw e;
        }
      }
    } finally {
      setCrashHandler(prev);
    }
    assert.ok(killed !== null, 'p0 was killed at a crashpoint');
    release();
    // gc --prune=now in the remote and p0's clone; then p0's clone directory is deleted.
    await testRunner().run(['gc', '--prune=now', '--quiet'], { class: 'local', cwd: fx.remote.dir });
    await gitIn(p0, ['gc', '--prune=now', '--quiet']);
    await lockOf(p0).release().catch(() => undefined);
    await rm(p0.deps.paths.workTree, { recursive: true, force: true });
    // A fresh clone joins as p2.
    const p2 = await freshPeer(fx, 'p3', p1);   // makeEngines names its peers p1 and p2 (the brief's p0 and p1): the fresh clone is p3
    try {
      const started = await p2.engine.start({ publishLocal: null });
      assert.ok(started.ok && started.mode === 'join', JSON.stringify(started));
      await roundsWith(fx, p2, [p1], 3);
      const tip = (await remoteBoardTip(fx)) as Oid;
      const fold = foldPatch(p2.engine.core)?.fold ?? p2.engine.core.view!.fold!;
      const held = await readHeldAll(p2.engine.core.repo, tip);
      for (const [id, want] of expected) {
        assert.ok(fold.holds[id] !== undefined && !['SUBSUMED', 'GONE', 'RESOLVED_PUBLISH', 'RESOLVED_DISCARD'].includes(fold.holds[id]!.state), `p2's fold lists p0's ${id}`);
        const got = new Map((held.get(id) ?? []).map((b) => [`${b.stage}/${b.path}`, b.oid as string]));
        assert.deepEqual(got, want, `held/${id}/ byte-equal to p0's last registry blobs`);
        for (const oid of got.values()) assert.ok((await readBlob(testRunner(), p2.dir, parseOid(oid))).length >= 0, `${oid} readable after gc`);
      }
      // Before p0 has left: refused.
      const before = await p2.engine.resolve(revertId, 'restore', { humanEvidence: true, actor: 'human' });
      assert.deepEqual(before, { kind: 'refused', code: 'HOLD_NOT_OWNER', params: { hid: revertId } });
      // p0's leave op, written by the test under p0's writer id and its next seq, leased on the tip.
      const T0 = (await remoteBoardTip(fx)) as Oid;
      const repo = p2.engine.core.repo;
      const rec = (foldPatch(p2.engine.core)?.fold ?? p2.engine.core.view!.fold!).peers[p0Id]!;
      const seq = rec.last_seq + 1;
      const writer: WriterId = { peer: p0Id, epoch: rec.epoch, seq: seq + 1 };
      const top = (await repo.run(['ls-tree', '-z', `${T0}^{tree}`])).stdout.toString('utf8').split('\0').filter((l) => l.length > 0);
      const entries: MktreeEntry[] = [];
      for (const line of top) {
        const tab = line.indexOf('\t');
        const [mode, type, oid] = line.slice(0, tab).split(' ') as [MktreeEntry['mode'], MktreeEntry['type'], Oid];
        const name = line.slice(tab + 1);
        if (name === 'protocol.json' || name === 'checkpoint' || name === 'held') entries.push({ name, mode, type, oid });
      }
      const opsLine = canonicalJson({ type: 'leave', id: `${p0Id}/${rec.epoch}/${seq}` } as unknown as Json);
      entries.push({ name: 'ops.jsonl', mode: '100644', type: 'blob', oid: await repo.hashBytes(Buffer.from(`${opsLine}\n`, 'utf8'), true) });
      const B = await repo.commitTree({ tree: await repo.mktree(entries), parents: [T0, (await readBoardCommit(repo, T0)).liveCode], subject: BOARD_SUBJECT, trailers: boardTrailers(writer, [], new Map()) });
      const pushed = await runPush(repo, fx.remote.url, [pushSpec(B, p2.engine.core.refs.remoteBoard, T0)], []);
      assert.equal(pushed.statuses.get(p2.engine.core.refs.remoteBoard), 'ok', 'p0\'s leave landed');
      await roundsWith(fx, p2, [p1], 3);
      const after = foldPatch(p2.engine.core)?.fold ?? p2.engine.core.view!.fold!;
      assert.equal(after.peers[p0Id]?.status, 'left', 'p2 folded p0\'s leave');
      const res = await p2.engine.resolve(revertId, 'restore', { humanEvidence: true, actor: 'human' });
      assert.equal(res.kind, 'done', JSON.stringify(res));
      const created = res.kind === 'done' ? res.created : null;
      assert.ok(created !== null && created !== revertId, `a new id: ${JSON.stringify(res)}`);
      assert.deepEqual(await readWork({ deps: p2.deps } as unknown as PeerFixture, 'f.py'), revertBytes, 'byte-exact content from held/<id>/');
      assert.deepEqual(await rejectedHoldOps(p1, (await remoteBoardTip(fx)) as Oid), [], 'no fold-rejected hold op');
    } finally {
      await p2.lock.release().catch(() => undefined);
    }
  });
});

test('TC-ENG-13 Plan 3 part: a lost state ref turns p0\'s unpublished marker row into a restart record that holds the marker in p0\'s registry until p0\'s next landed push and in its held/<id>/h1 blob after it', T, async () => {
  await withEngines('tc-eng-13', { n: 2, files: FILES }, async (fx) => {
    await fx.startAll({ publishLocal: 'all' });
    await fx.rounds(4);
    const p0 = fx.peers[0]!;
    const m = 'CWM_tceng13_1_p1';
    await writeWork(p0, 'notes.txt', `${Array.from({ length: 9 }, (_, k) => `note row ${k}\n`).join('')}unpublished ${m}\n`);
    const before = (await remoteBoardTip(fx)) as Oid;
    // The state ref deleted while the daemon runs: the live core's restart takes the lost-state path (ENG-54; "gone while this core was
    // live", never a re-join).
    await gitIn(p0, ['update-ref', '-d', p0.core.refs.state]);
    const r = await restart(p0.core);
    assert.ok(r.lostState !== null && r.lostState.mode === 'lost_state', `a lost-state rebuild: ${JSON.stringify(r)}`);
    assert.equal(await remoteBoardTip(fx), before, 'the rebuild published nothing before it completed');
    const reg = await readRegistry(testRunner(), p0.deps.paths.workTree, 'main');
    const rec = [...reg.records.values()].find((x) => !isTerminal(x) && x.guards.some((g) => guardName(g) === 'restart') && x.paths.includes('notes.txt'));
    assert.ok(rec !== undefined && rec.kind === 'PATCH', `a restart PATCH over notes.txt: ${JSON.stringify([...reg.records.values()].map((x) => [x.kind, x.guards, x.paths]))}`);
    const h1 = heldSide(rec).find((x) => x.path === 'notes.txt')!.oid;
    assert.ok(findMarkers(await readBlob(testRunner(), p0.deps.paths.workTree, parseOid(h1))).includes(m), 'the marker is in the restart record\'s h1 (registry)');
    // After p0's next landed push: held/<id>/h1/notes.txt on the board tip holds it.
    await roundsUntil(fx, async () => {
      const tip = (await remoteBoardTip(fx)) as Oid;
      const held = (await readHeldAll(p0.core.repo, tip)).get(rec.id) ?? [];
      const b = held.find((x) => x.stage === 'h1' && x.path === 'notes.txt');
      return b !== undefined && findMarkers(await p0.core.repo.readBlob(b.oid)).includes(m);
    }, 'held/<id>/h1/notes.txt on the board tip holds the marker', 20);
    const regs = await Promise.all(fx.peers.map((p) => readRegistry(testRunner(), p.deps.paths.workTree, 'main')));
    assert.equal(regs.filter((x) => x.records.has(rec.id)).length, 1, 'the record id is in exactly one peer\'s registry');
  });
});
