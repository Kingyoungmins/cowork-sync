// The provenance journal on real clones (Plan 3 Task 8; 05-holds §2, HLD-25; 01-engine ENG-36, ENG-37; 05 U3, F3, TC-HLD-03;
// rulings R3-36, R3-59, contract addition 4): its entries, where it advances (after apply.state, at a landed push, at a lost-state
// rebuild), its load points (genesis/join load(tip, tip), restart load before resolveWriteIntent), the 14-day retention and the
// retention-bounded rebuild. A teammate is the core fixture's synthetic writer. Git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CODE_SUBJECT, liveCommitTrailers } from '../../src/board/boardCommit.js';
import { newEpoch, parseOpId } from '../../src/board/ids.js';
import { applyStep } from '../../src/engine/apply.js';
import { provRebuildFrom, stateJoinPoint } from '../../src/engine/core.js';
import { revertStep } from '../../src/engine/detect.js';
import { publishStep } from '../../src/engine/publish.js';
import { lostStateRebuild, restart } from '../../src/engine/restart.js';
import { ABSENT, parseOid, type Oid } from '../../src/git/oid.js';
import type { TreeMap } from '../../src/git/repo.js';
import { HOLD_CODES, HOLD_LOG_CODES } from '../../src/holds/codes.js';
import { lineHash, ProvenanceJournal, type ProvEntry } from '../../src/holds/provenance.js';
import { revertDetector, type DetectorDelta } from '../../src/holds/revert.js';
import { KilledAt, setCrashHandler } from '../../src/ports/crashpoint.js';
import { seededRandom } from '../../src/ports/random.js';
import { gitCallsOf, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { buf, captureReady, editAndCapture, LogRecorder, prep, withCores } from '../helpers/publishHelpers.js';
import { gitIn, restartCore, startOk, withStart } from '../helpers/startFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };
const DAY = 86_400_000;

const A0 = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n';
const hashOf = (s: string): string => lineHash(buf(s));

/** prov/<enc(b)>.jsonl of the peer. */
function journalFile(p: PeerFixture): string {
  return join(p.deps.paths.coworkDir, 'prov', `${p.core.refs.e}.jsonl`);
}

/** The journal file's entries, read test-side ([] when it is missing). */
async function journal(p: PeerFixture): Promise<ProvEntry[]> {
  let text: string;
  try {
    text = await readFile(journalFile(p), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  return text.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as ProvEntry);
}

/** The peer id of a live commit's Cowork-Writer (the synthetic teammate's for pushTeamChange's commits). */
async function writerOf(p: PeerFixture, live: Oid): Promise<string> {
  const t = (await p.core.repo.readCommit(live)).trailers.find((x) => x.key === 'Cowork-Writer')!;
  return parseOpId(t.value)!.peer;
}

/** The teammate lands `changes`; the peer fetches it and applies it (10 s after the last apply). */
async function applyTeam(fx: CoreFixture, p: PeerFixture, changes: Record<string, string | null>): Promise<{ live: Oid; board: Oid }> {
  const r = await fx.pushTeamChange(Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v === null ? null : buf(v)])));
  fx.advance(10_000);
  const report = await applyStep(p.core, await prep(p));
  assert.ok(report.ran, `the apply ran: ${report.skipped ?? ''}`);
  assert.equal(p.core.view!.laC, r.live, 'LA_C is the teammate commit');
  return r;
}

/** A standalone journal of the peer's repository at `name` (a file next to the real one). */
function journalAt(p: PeerFixture, name: string): ProvenanceJournal {
  return new ProvenanceJournal({
    fs: p.deps.ports.fs, file: join(p.deps.paths.coworkDir, 'prov', name), repo: p.core.repo, clock: p.deps.ports.clock, peer: p.core.peerId, log: p.deps.log,
  });
}

test('advance appends one entry per live commit in (old, next] with the Cowork-Writer peer, the Cowork-CS ids and add/del hashes of non-trivial changed rows only', T10, async () => {
  await withCores('prov-entries', { n: 1 }, async (fx) => {
    const p = fx.peers[0]!;
    assert.deepEqual(await journal(p), [], 'the bootstrap load leaves an empty journal');
    const c1 = await fx.pushTeamChange({ 'src/a.txt': buf('one\ntwo\nthree\nTEAM = 1\n}\nfour\nfive\nsix\nseven\neight\n') });
    const c2 = await fx.pushTeamChange({ 'src/a.txt': buf('one\ntwo\nTEAM = 1\n}\nfour\nfive\nsix\nseven\neight\n') });
    fx.advance(10_000);
    assert.ok((await applyStep(p.core, await prep(p))).ran);
    const team = await writerOf(p, c1.live);
    const entries = await journal(p);
    assert.equal(entries.length, 2, 'one entry per live commit in (L0, TIP]');
    const [e1, e2] = entries as [ProvEntry, ProvEntry];
    assert.equal(e1.commit, c1.live);
    assert.equal(e1.writer, team);
    assert.deepEqual(e1.cs_ids, [`${team}/human/1`]);
    assert.deepEqual(e1.paths, { 'src/a.txt': { add: [hashOf('TEAM = 1')], del: [] } }, "the trivial '}' is not listed");
    assert.equal(e1.t_local_ms, Math.floor(p.deps.ports.clock.wallMs()));
    assert.equal(e2.commit, c2.live);
    assert.deepEqual(e2.cs_ids, [`${team}/human/2`]);
    assert.deepEqual(e2.paths, { 'src/a.txt': { add: [], del: [hashOf('three')] } });
    assert.deepEqual(p.core.prov.addedBy(hashOf('TEAM = 1')), [team]);
    assert.deepEqual(p.core.prov.deletedBy(hashOf('three')), [team]);
    assert.equal(p.core.prov.newest(), c2.live);
  });
});

test('the journal advances after an apply, a landed push and a lost-state rebuild, and not after a commit that leaves laC unchanged', T10, async () => {
  await withCores('prov-sites', { n: 1 }, async (fx) => {
    const p = fx.peers[0]!;
    // An apply: +1, appended after the apply.state crashpoint (the anchor sees the journal without it, 11-testing §3.6).
    const c1 = await fx.pushTeamChange({ 'src/a.txt': buf(A0.replace('three\n', 'three\nTEAM = 1\n')) });
    fx.advance(10_000);
    const it = await prep(p);
    let atAnchor = -1;
    setCrashHandler((name) => {
      if (name === 'apply.state') atAnchor = p.core.prov.newest() === c1.live ? 1 : 0;
    });
    try {
      assert.ok((await applyStep(p.core, it)).ran);
    } finally {
      setCrashHandler(null);
    }
    assert.equal(atAnchor, 0, 'at apply.state the entry is not appended yet');
    assert.deepEqual((await journal(p)).map((e) => e.commit), [c1.live]);

    // A capture-only state commit leaves LA_C unchanged: +0.
    await writeWork(p, 'src/b.txt', 'alpha\nbeta mine\ngamma\n');
    await prep(p);
    fx.advance(20_000);
    const capIt = await prep(p, true);
    const before = p.core.view!.commit;
    await captureReady(p, capIt);
    assert.notEqual(p.core.view!.commit, before, 'the capture committed state');
    assert.equal((await journal(p)).length, 1, 'no entry for a commit that leaves LA_C unchanged');

    // This peer's own publish landing (applyPushOk): +1 with writer = this peer.
    const pub = await publishStep(p.core, capIt);
    assert.equal(pub.outcome, 'landed', JSON.stringify(pub));
    const afterPush = await journal(p);
    assert.equal(afterPush.length, 2);
    assert.equal(afterPush[1]!.commit, p.core.view!.laC);
    assert.equal(afterPush[1]!.writer, p.core.peerId);
    assert.deepEqual(afterPush[1]!.paths, { 'src/b.txt': { add: [hashOf('beta mine')], del: [hashOf('beta')] } });

    // A lost-state rebuild (state.rebuild/create, not EngineCore.commit): entries up to TIP, appended by restart.ts's advance.
    const c3 = await fx.pushTeamChange({ 'src/a.txt': buf(A0.replace('three\n', 'three\nTEAM = 1\n').replace('six\n', 'SIX TEAM\n')) });
    await prep(p);
    const T = (await p.core.repo.readRef(p.core.refs.localBoard))!;
    await gitIn(p, ['update-ref', '-d', p.core.refs.state]);
    await lostStateRebuild(p.core, T, 'lost_state');
    assert.equal(p.core.view!.laC, c3.live, 'LA_C := TIP');
    assert.deepEqual((await journal(p)).map((e) => e.commit), [c1.live, afterPush[1]!.commit, c3.live]);
    assert.deepEqual(p.core.prov.addedBy(hashOf('SIX TEAM')), [await writerOf(p, c3.live)]);
  });
});

test('advance is a no-op before load() and never appends commits before the load point', T10, async () => {
  await withCores('prov-loadpoint', { n: 1 }, async (fx) => {
    const p = fx.peers[0]!;
    const c0 = p.core.view!.laC;
    const c1 = await fx.pushTeamChange({ 'src/a.txt': buf(A0.replace('one\n', 'one\nC1 = 1\n')) });
    const c2 = await fx.pushTeamChange({ 'src/a.txt': buf(A0.replace('one\n', 'one\nC1 = 1\nC2 = 2\n')) });
    await prep(p);   // fetches c1 and c2 (no apply)
    const j = journalAt(p, 'standalone.jsonl');
    assert.equal(await j.advance(c0, c2.live, async () => null), 0, 'no-op before load');
    assert.equal(j.newest(), null);
    assert.equal(await j.load(c1.live, c1.live), 'rebuilt', 'a missing file: load(c1, c1) creates an empty journal');
    assert.equal(j.newest(), null);
    assert.equal(await j.advance(c0, c2.live, async () => null), 1, 'only commits after the load point');
    assert.equal(j.newest(), c2.live);
    const lines = (await readFile(join(p.deps.paths.coworkDir, 'prov', 'standalone.jsonl'), 'utf8')).split('\n').filter((l) => l.length > 0);
    assert.deepEqual(lines.map((l) => (JSON.parse(l) as ProvEntry).commit), [c2.live]);
  });
});

test('a state ref deleted while the daemon runs: the lost-state rebuild fills the journal over (old LA_C, TIP], so a stale save of a teammate line added in that span is a revert record', T10, async () => {
  await withCores('prov-lost', { n: 1 }, async (fx) => {
    const p = fx.peers[0]!;
    const before = A0.replace('two\n', 'two\nC0 = 0\n');
    const c0 = await applyTeam(fx, p, { 'src/a.txt': before });   // LA_C = c0: the journal's newest entry
    const withTeam = before.replace('five\n', 'five\nTEAM_LS = 1\n');
    const c1 = await fx.pushTeamChange({ 'src/a.txt': buf(withTeam) });   // not applied
    await prep(p);
    await gitIn(p, ['update-ref', '-d', p.core.refs.state]);
    const r = await restart(p.core);   // the next iteration's lost-state rebuild (the state ref is gone while the core runs)
    assert.ok(r.lostState !== null);
    assert.equal(p.core.view!.laC, c1.live);
    assert.deepEqual((await journal(p)).map((e) => e.commit), [c0.live, c1.live]);
    const team = await writerOf(p, c1.live);
    assert.deepEqual(p.core.prov.addedBy(hashOf('TEAM_LS = 1')), [team]);
    // TIP's version reaches the disk, then a stale save removes the teammate's line: one `revert` PATCH at the next materialization.
    fx.advance(10_000);
    await applyStep(p.core, await prep(p));
    assert.equal((await readFile(join(p.deps.paths.workTree, 'src', 'a.txt'), 'utf8')), withTeam);
    await revertStep(p.core, await prep(p, true));
    assert.equal(p.core.holds.nonTerminal().length, 0, 'nothing held yet');
    await writeWork(p, 'src/a.txt', before);
    await prep(p);
    fx.advance(1_000);
    const ids = await revertStep(p.core, await prep(p, true));
    assert.equal(ids.length, 1);
    const rec = p.core.holds.get(ids[0]!)!;
    assert.deepEqual([rec.kind, rec.residence, rec.state, rec.guards.map((g) => g.name), rec.paths], ['PATCH', 'ON_DISK', 'ACTIVE', ['revert'], ['src/a.txt']]);
  });
});

test('entries older than 14 days of local append time are pruned at the next append', T10, async () => {
  await withCores('prov-retention', { n: 1 }, async (fx) => {
    const p = fx.peers[0]!;
    const c1 = await applyTeam(fx, p, { 'src/a.txt': A0.replace('three\n', 'three\nTEAM = 1\n') });
    const team = await writerOf(p, c1.live);
    assert.deepEqual(p.core.prov.addedBy(hashOf('TEAM = 1')), [team]);
    fx.advance(15 * DAY);
    assert.deepEqual(p.core.prov.addedBy(hashOf('TEAM = 1')), [], 'outside the retention window');
    assert.equal((await journal(p)).length, 1, 'not pruned before the next append');
    const c2 = await applyTeam(fx, p, { 'src/a.txt': A0.replace('three\n', 'three\nTEAM = 1\n').replace('eight\n', 'eight\nTEAM2 = 2\n') });
    assert.deepEqual((await journal(p)).map((e) => e.commit), [c2.live], 'the old entry is gone');
    assert.deepEqual(p.core.prov.addedBy(hashOf('TEAM = 1')), []);
    assert.deepEqual(p.core.prov.addedBy(hashOf('TEAM2 = 2')), [team]);
  });
});

/** revertDetector's verdicts for prev = A[path] against each variant (hashed into the store), one delta at a time. */
async function verdicts(p: PeerFixture, path: string, variants: readonly string[]): Promise<boolean[]> {
  const A: TreeMap = await p.core.repo.readTreeMap(p.core.view!.base);
  const prev = A.get(path)!.oid;
  const out: boolean[] = [];
  for (const v of variants) {
    const next = await p.core.repo.hashBytes(buf(v), true);
    const d: DetectorDelta = { path, prev, next, binary: false };
    out.push((await revertDetector(p.core.repo, [d], p.core.prov, p.core.peerId, [], p.core.rebase, A)).length === 1);
  }
  return out;
}

test('load rebuilds a missing or corrupt journal from the live first-parent chain back to provRebuildFrom with t_local_ms = the rebuild time, and the revertDetector verdicts are identical before and after', T10, async () => {
  await withCores('prov-rebuild', { n: 1 }, async (fx) => {
    const p = fx.peers[0]!;
    // This peer's own row (MINE = 1, published), then the teammate's TEAM = 1 added and `three` deleted.
    await editAndCapture(fx, p, { 'src/a.txt': A0.replace('seven\n', 'seven\nMINE = 1\n') });
    const own = await publishStep(p.core, await prep(p));
    assert.equal(own.outcome, 'landed');
    const mine = A0.replace('seven\n', 'seven\nMINE = 1\n');
    const withTeam = mine.replace('two\n', 'two\nTEAM = 1\n').replace('three\n', '');
    await applyTeam(fx, p, { 'src/a.txt': withTeam });
    const variants = [
      withTeam.replace('TEAM = 1\n', ''),               // remove TEAM = 1: tainted
      withTeam.replace('four\n', 'three\nfour\n'),       // re-add three: tainted
      withTeam.replace('MINE = 1\n', 'MINE = 2\n'),      // edit an own row: not tainted
    ];
    const want = [true, true, false];
    assert.deepEqual(await verdicts(p, 'src/a.txt', variants), want, 'the intact journal');
    const intact = (await journal(p)).map((e) => e.commit);
    assert.equal(intact.length, 2);

    await rm(journalFile(p));
    fx.advance(60_000);
    const laC = p.core.view!.laC;
    assert.equal(await p.core.prov.load(laC, await provRebuildFrom(p.core)), 'rebuilt', 'a deleted journal is rebuilt');
    const rebuilt = await journal(p);
    assert.deepEqual(rebuilt.map((e) => e.commit), intact, 'the same live commits');
    for (const e of rebuilt) assert.equal(e.t_local_ms, Math.floor(p.deps.ports.clock.wallMs()), 't_local_ms = the rebuild time');
    assert.deepEqual(await verdicts(p, 'src/a.txt', variants), want, 'deleted and rebuilt');

    const lines = (await readFile(journalFile(p), 'utf8')).split('\n').filter((l) => l.length > 0);
    await writeFile(journalFile(p), `${[...lines.slice(0, -1), '{"x"'].join('\n')}\n`);
    assert.equal(await p.core.prov.load(laC, await provRebuildFrom(p.core)), 'rebuilt', 'a corrupt last line is rebuilt');
    assert.deepEqual((await journal(p)).map((e) => e.commit), intact);
    assert.deepEqual(await verdicts(p, 'src/a.txt', variants), want, 'corrupt and rebuilt');
  });
});

test('a rebuild stops at the retention cut: a teammate line applied 20 local days ago stays unprotected after the journal is deleted', T10, async () => {
  await withCores('prov-cut', { n: 1 }, async (fx) => {
    const p = fx.peers[0]!;
    const v1 = A0.replace('two\n', 'two\nTEAM_OLD = 1\n');
    const c1 = await applyTeam(fx, p, { 'src/a.txt': v1 });
    fx.advance(15 * DAY);
    const v2 = v1.replace('six\n', 'six\nTEAM_NEW = 1\n');
    const c2 = await applyTeam(fx, p, { 'src/a.txt': v2 });
    fx.advance(5 * DAY);
    const variants = [v2.replace('TEAM_OLD = 1\n', ''), v2.replace('TEAM_NEW = 1\n', '')];
    assert.deepEqual(await verdicts(p, 'src/a.txt', variants), [false, true], 'TEAM_OLD pruned, TEAM_NEW protected');

    await rm(journalFile(p));
    assert.equal(await provRebuildFrom(p.core), c1.live, 'the laC of the newest state-reflog entry older than 14 days');
    await restartCore(p);
    let loaded: string | null = null;
    const orig = p.core.prov.load.bind(p.core.prov);
    Reflect.set(p.core.prov, 'load', async (laC: Oid, from: Oid | null) => {
      const r = await orig(laC, from);
      loaded = `${r} ${laC} ${from}`;
      return r;
    });
    await restart(p.core);
    assert.equal(loaded, `rebuilt ${c2.live} ${c1.live}`);
    assert.deepEqual((await journal(p)).map((e) => e.commit), [c2.live], 'only (c1, c2]');
    assert.deepEqual(await verdicts(p, 'src/a.txt', variants), [false, true], 'the same verdicts after the rebuild');
  });
});

test('a journal left one commit behind by a kill at apply.state is advanced by load, not rebuilt', T10, async () => {
  await withCores('prov-behind', { n: 1 }, async (fx) => {
    const p = fx.peers[0]!;
    const c0 = await applyTeam(fx, p, { 'src/a.txt': A0.replace('one\n', 'one\nK0 = 0\n') });
    const spyLoad = (): { result: string | null } => {
      const box = { result: null as string | null };
      const orig = p.core.prov.load.bind(p.core.prov);
      Reflect.set(p.core.prov, 'load', async (laC: Oid, from: Oid | null) => {
        const r = await orig(laC, from);
        box.result = r;
        return r;
      });
      return box;
    };

    // (1) A kill at apply.state: the state CAS landed, the append had not run.
    const c1 = await fx.pushTeamChange({ 'src/a.txt': buf(A0.replace('one\n', 'one\nK0 = 0\nK1 = 1\n')) });
    fx.advance(10_000);
    const it1 = await prep(p);
    setCrashHandler((name) => {
      if (name === 'apply.state') throw new KilledAt(name);
    });
    try {
      await assert.rejects(applyStep(p.core, it1), (e: unknown) => e instanceof KilledAt);
    } finally {
      setCrashHandler(null);
    }
    assert.equal(p.core.view!.laC, c1.live, 'the state CAS landed');
    assert.deepEqual((await journal(p)).map((e) => e.commit), [c0.live], 'one commit behind');
    await restartCore(p);
    const box1 = spyLoad();
    await restart(p.core);
    assert.equal(box1.result, 'loaded');
    assert.deepEqual((await journal(p)).map((e) => e.commit), [c0.live, c1.live], 'the missing entry is present');

    // (2) A kill inside the append (FaultFs interposes on the journal's appendFile).
    const c2 = await fx.pushTeamChange({ 'src/a.txt': buf(A0.replace('one\n', 'one\nK0 = 0\nK1 = 1\nK2 = 2\n')) });
    fx.advance(10_000);
    const it2 = await prep(p);
    p.fs.interpose('appendFile', `${p.core.refs.e}.jsonl`, async () => {
      throw new KilledAt('prov.append');
    });
    await assert.rejects(applyStep(p.core, it2), (e: unknown) => e instanceof KilledAt);
    assert.equal(p.core.view!.laC, c2.live);
    assert.deepEqual((await journal(p)).map((e) => e.commit), [c0.live, c1.live]);
    await restartCore(p);
    const box2 = spyLoad();
    await restart(p.core);
    assert.equal(box2.result, 'loaded');
    assert.deepEqual((await journal(p)).map((e) => e.commit), [c0.live, c1.live, c2.live]);
  });
});

test('a failed advance marks the journal stale and the next laC move loads it, so the failed span is journaled in the same run; a busy rename at a pruning rewrite is retried', T10, async () => {
  // Task 8 fix round 1, findings 4 and 8 (controller ruling: a failed advanceProvenance marks the journal stale and the next advance
  // rebuilds through load(view.laC, provRebuildFrom(core))). Without it, a later advance walks only its own (old, next] and the failed
  // span stays out of the journal for the whole run (INV-HLD-NOREVERT's unsafe direction), and load() at the next restart sees a
  // newest entry on laC's chain and never fills the hole.
  await withCores('prov-stale', { n: 1 }, async (fx) => {
    const p = fx.peers[0]!;
    const log = new LogRecorder();
    p.deps.log = log;
    const v0 = A0.replace('one\n', 'one\nS0 = 0\n');
    const c0 = await applyTeam(fx, p, { 'src/a.txt': v0 });
    // (1) A disk-full append (not a crash): the apply itself succeeds, the journal stays one commit behind, one PROV_ADVANCE_FAILED.
    p.fs.addRule({ op: 'appendFile', pathIncludes: `${p.core.refs.e}.jsonl`, code: 'ENOSPC', times: 1 });
    const v1 = v0.replace('two\n', 'two\nS1 = 1\n');
    const c1 = await applyTeam(fx, p, { 'src/a.txt': v1 });
    assert.deepEqual((await journal(p)).map((e) => e.commit), [c0.live], 'the append failed');
    assert.equal(log.lines.filter((l) => l.code === 'PROV_ADVANCE_FAILED').length, 1);
    assert.deepEqual(p.core.prov.addedBy(hashOf('S1 = 1')), [], 'not journaled yet');
    // (2) The next laC move journals the failed span too, in this run.
    const v2 = v1.replace('four\n', 'four\nS2 = 2\n');
    const c2 = await applyTeam(fx, p, { 'src/a.txt': v2 });
    const team = await writerOf(p, c1.live);
    assert.deepEqual((await journal(p)).map((e) => e.commit), [c0.live, c1.live, c2.live], 'the failed span is in the file');
    assert.deepEqual(p.core.prov.addedBy(hashOf('S1 = 1')), [team], 'and protected in memory');
    assert.deepEqual(p.core.prov.addedBy(hashOf('S2 = 2')), [team]);
    // A stale save removing the line of the failed span is a revert record in this run.
    assert.deepEqual(await verdicts(p, 'src/a.txt', [v2.replace('S1 = 1\n', '')]), [true]);
    // (3) Every entry is older than 14 days at the next append, so it rewrites the file (temp + rename); a reader holding the
    // journal without share-delete fails the rename twice (EPERM): retried, the rewrite lands, no temp file stays behind.
    fx.advance(15 * DAY);
    p.fs.addRule({ op: 'rename', pathIncludes: `${p.core.refs.e}.jsonl`, code: 'EPERM', times: 2 });
    const c3 = await applyTeam(fx, p, { 'src/a.txt': v2.replace('six\n', 'six\nS3 = 3\n') });
    assert.deepEqual((await journal(p)).map((e) => e.commit), [c3.live], 'the pruning rewrite landed after the retries');
    assert.equal(log.lines.filter((l) => l.code === 'PROV_ADVANCE_FAILED').length, 1, 'no new failure');
    assert.deepEqual(await readFile(`${journalFile(p)}.tmp`).catch((e: NodeJS.ErrnoException) => e.code), 'ENOENT', 'no temp file');
    // Every code the journal and its advance wrote is a registered one (finding 5).
    const registered = new Set([...HOLD_CODES, ...HOLD_LOG_CODES]);
    assert.deepEqual(log.lines.filter((l) => l.code.startsWith('PROV_') && !registered.has(l.code)).map((l) => l.code), []);
  });
});

/** sha1 hex of raw bytes, test-side (the whole-blob summary hash). */
const sha1Raw = (b: Buffer): string => createHash('sha1').update(b).digest('hex');

test('binary churn and over-cap text are bounded: a binary path, and a text path whose changed rows exceed the per-path cap, are journaled as one whole-blob hash per side, and the detector still taints their whole-file restores', T10, async () => {
  // Task 8 fix round 1, finding 9 (controller ruling: bound binary churn; a per-path cap with a summary entry). A 1 MB random binary
  // split at LF gave ~8,000 row hashes per rewrite (~340 KB of JSON line), kept 14 days and re-parsed at every start.
  await withCores('prov-cap', { n: 1 }, async (fx) => {
    const p = fx.peers[0]!;
    const rnd = seededRandom('t8-prov-cap');
    const blob = (): Buffer => {
      const b = Buffer.from(rnd.bytes(1_048_576));
      b[0] = 0;   // binary: a NUL in the first 8,000 bytes
      return b;
    };
    const B1 = blob();
    const B2 = blob();
    const T1 = Array.from({ length: 4_200 }, (_, i) => `t1_${i} = ${i}\n`).join('');
    const c1 = await fx.pushTeamChange({ 'bin/data.bin': B1, 'src/big.txt': buf(T1) });
    fx.advance(10_000);
    assert.ok((await applyStep(p.core, await prep(p))).ran);
    const c2 = await fx.pushTeamChange({ 'bin/data.bin': B2 });
    fx.advance(10_000);
    assert.ok((await applyStep(p.core, await prep(p))).ran);
    const entries = await journal(p);
    assert.deepEqual(entries.map((e) => e.commit), [c1.live, c2.live]);
    assert.deepEqual(entries[0]!.paths['bin/data.bin'], { add: [sha1Raw(B1)], del: [] }, 'a binary path: one whole-blob hash per side');
    assert.deepEqual(entries[0]!.paths['src/big.txt'], { add: [sha1Raw(buf(T1))], del: [] }, '4,200 added rows exceed the cap: the summary');
    assert.deepEqual(entries[1]!.paths, { 'bin/data.bin': { add: [sha1Raw(B2)], del: [sha1Raw(B1)] } });
    assert.ok((await readFile(journalFile(p))).length < 4_096, 'the journal stays small');
    // The detector over the summaries (prev = A[path]): a stale copy of B1 over B2 is tainted (binary), deleting the teammate's
    // over-cap big.txt is tainted; an edit of one row of big.txt is not (the summary keeps no row hashes: the cap's accepted cost).
    const verdict = async (path: string, next: Buffer | null, binary: boolean): Promise<boolean> => {
      const A: TreeMap = await p.core.repo.readTreeMap(p.core.view!.base);
      const d: DetectorDelta = { path, prev: A.get(path)?.oid ?? ABSENT, next: next === null ? ABSENT : await p.core.repo.hashBytes(next, true), binary };
      return (await revertDetector(p.core.repo, [d], p.core.prov, p.core.peerId, [], p.core.rebase, A)).length === 1;
    };
    assert.equal(await verdict('bin/data.bin', B1, true), true, 'a stale binary copy');
    assert.equal(await verdict('src/big.txt', null, false), true, "deleting the teammate's over-cap file");
    assert.equal(await verdict('src/big.txt', buf(T1.replace('t1_7 = 7\n', 't1_7 = 77\n')), false), false, 'an edit of one of its rows');
    // The teammate deletes big.txt (4,200 removed rows: the summary); a stale copy of it re-created is tainted.
    const c3 = await fx.pushTeamChange({ 'src/big.txt': null });
    fx.advance(10_000);
    assert.ok((await applyStep(p.core, await prep(p))).ran);
    assert.deepEqual((await journal(p)).map((e) => [e.commit, e.paths]).slice(-1), [[c3.live, { 'src/big.txt': { add: [], del: [sha1Raw(buf(T1))] } }]]);
    assert.equal(await verdict('src/big.txt', buf(T1), false), true, 'a re-created stale copy of the deleted file');
  });
});

test("stateJoinPoint is the live code of the oldest reflog entry's laB, and a rebuild never reaches past it", T10, async () => {
  await withCores('prov-joinpoint', { n: 1 }, async (fx) => {
    const p = fx.peers[0]!;
    const L0 = p.core.view!.laC;
    const c1 = await applyTeam(fx, p, { 'src/a.txt': A0.replace('one\n', 'one\nJ1 = 1\n') });
    const c2 = await applyTeam(fx, p, { 'src/a.txt': A0.replace('one\n', 'one\nJ1 = 1\nJ2 = 2\n') });
    assert.equal(await stateJoinPoint(p.core), L0, 'L0 at genesis (the bootstrap)');
    assert.equal(await provRebuildFrom(p.core), L0, 'no entry older than 14 days: the join point');
    await rm(journalFile(p));
    assert.equal(await p.core.prov.load(c2.live, c1.live), 'rebuilt');
    assert.deepEqual((await journal(p)).map((e) => e.commit), [c2.live], 'load(laC, c1) rebuilds only c2');
    await rm(journalFile(p));
    await p.core.prov.load(c2.live, c2.live);
    assert.equal(await readFile(journalFile(p), 'utf8'), '', 'load(laC, laC) creates an empty journal');
    await gitIn(p, ['reflog', 'expire', '--expire=now', '--all']);
    assert.equal(await stateJoinPoint(p.core), null);
    assert.equal(await provRebuildFrom(p.core), null);
  });
  // A joined peer: its first state has laC = L_b (the commit that introduced its base), the join point is the TIP it joined at.
  await withStart('prov-joinpoint-join', { n: 2 }, async (fx) => {
    const [p0, p1] = fx.peers as [PeerFixture, PeerFixture];
    await startOk(p0, 'genesis');
    const L0 = p0.core.view!.laC;
    const c1 = await fx.pushTeamChange({ 'src/a.txt': buf(A0.replace('one\n', 'one\nJOIN = 1\n')) });
    await startOk(p1, 'join');
    assert.equal(await stateJoinPoint(p1.core), c1.live, 'the TIP its join started from');
    assert.notEqual(c1.live, L0);
    const first = (await gitIn(p1, ['log', '-g', '--format=%P', p1.core.refs.state])).split('\n').filter((l) => l.length > 0);
    assert.equal(first[first.length - 1]!.split(' ')[0], L0, "the joiner's first state has laC = L_b, not TIP");
  });
});

test("a joiner's first apply and a restart never protect history from before their load point", T10, async () => {
  await withStart('prov-join-restart', { n: 2 }, async (fx) => {
    const [p0, p1] = fx.peers as [PeerFixture, PeerFixture];
    await startOk(p0, 'genesis');
    const c1 = await fx.pushTeamChange({ 'src/a.txt': buf(A0.replace('one\n', 'one\nTEAM_OLD = 1\n')) });
    const loads: string[] = [];
    const orig = p1.core.prov.load.bind(p1.core.prov);
    Reflect.set(p1.core.prov, 'load', async (laC: Oid, from: Oid | null) => {
      loads.push(`${laC} ${from} applied=${p1.core.view!.laC === laC}`);
      return orig(laC, from);
    });
    await startOk(p1, 'join');
    assert.deepEqual(loads, [`${c1.live} ${c1.live} applied=false`], 'load(tip, tip) before the first apply');
    assert.equal(p1.core.view!.laC, c1.live, 'the first apply moved LA_C to TIP');
    assert.deepEqual(await journal(p1), [], 'no entry for the pre-join history');
    assert.deepEqual(p1.core.prov.addedBy(hashOf('TEAM_OLD = 1')), []);

    // Peer 0: c1 applied (journal [c1]), then c2's apply killed after its intent; the restart loads before the intent resolution.
    fx.advance(10_000);
    assert.ok((await applyStep(p0.core, await prep(p0))).ran);
    assert.deepEqual((await journal(p0)).map((e) => e.commit), [c1.live]);
    const c2 = await fx.pushTeamChange({ 'src/b.txt': buf('alpha\nbeta\ngamma\nTEAM2 = 2\n') });
    fx.advance(10_000);
    const it = await prep(p0);
    setCrashHandler((name) => {
      if (name === 'apply.intent') throw new KilledAt(name);
    });
    try {
      await assert.rejects(applyStep(p0.core, it), (e: unknown) => e instanceof KilledAt);
    } finally {
      setCrashHandler(null);
    }
    await restartCore(p0);
    const seen: string[] = [];
    const orig0 = p0.core.prov.load.bind(p0.core.prov);
    Reflect.set(p0.core.prov, 'load', async (laC: Oid, from: Oid | null) => {
      seen.push(`${laC} intent=${p0.core.view!.intent.kind}`);
      return orig0(laC, from);
    });
    const r = await restart(p0.core);
    assert.equal(r.intent, 'apply');
    assert.deepEqual(seen, [`${c1.live} intent=apply`], 'load right after attachState, before resolveWriteIntent');
    assert.equal(p0.core.view!.laC, c2.live, "the restart decision moved LA_C to the intent's tip");
    assert.deepEqual((await journal(p0)).map((e) => e.commit), [c1.live, c2.live], 'only commits after the load point, once each');
  });
});

test('advance computes row changes in-process: no git diff with -U0 or --unified=0 is spawned', T10, async () => {
  await withCores('prov-inproc', { n: 1 }, async (fx) => {
    const p = fx.peers[0]!;
    const start = gitCallsOf(p).length;
    let text = A0;
    for (let i = 1; i <= 3; i++) {
      text = text.replace('eight\n', `eight\nADV${i} = ${i}\n`);
      await applyTeam(fx, p, { 'src/a.txt': text });
    }
    assert.equal((await journal(p)).length, 3, 'three advances');
    const calls = gitCallsOf(p).slice(start);
    assert.ok(calls.some((c) => c.args[0] === 'diff-tree'), 'the tree diff is one diff-tree per commit');
    assert.deepEqual(calls.filter((c) => c.args.some((a) => a === '-U0' || a === '--unified=0' || a.startsWith('--unified'))).map((c) => c.args.join(' ')), []);
    assert.deepEqual(calls.filter((c) => c.args[0] === 'diff').map((c) => c.args.join(' ')), [], 'no git diff at all');
  });
});

test('a commit carrying Cowork-Base is recorded with writer branch:<X>', T10, async () => {
  await withCores('prov-basemove', { n: 1 }, async (fx) => {
    const p = fx.peers[0]!;
    const repo = p.core.repo;
    const L0 = p.core.view!.laC;
    const X = parseOid(await gitIn(p, ['rev-parse', 'HEAD']));
    const tree = await repo.editTree((await repo.readCommit(L0)).tree, [{ path: 'src/a.txt', mode: '100644', oid: await repo.hashBytes(buf(`${A0}BASE = 1\n`), true) }], p.core.scratch('a'));
    const writer = { peer: p.core.peerId, epoch: newEpoch(p.deps.ports.random), seq: 1 };
    const moved = await repo.commitTree({ tree, parents: [L0, X], subject: CODE_SUBJECT, trailers: liveCommitTrailers(writer, [], [], new Map(), X) });
    const j = journalAt(p, 'basemove.jsonl');
    await j.load(L0, L0);
    assert.equal(await j.advance(L0, moved, async () => null), 1);
    const e = JSON.parse((await readFile(join(p.deps.paths.coworkDir, 'prov', 'basemove.jsonl'), 'utf8')).trim()) as ProvEntry;
    assert.equal(e.writer, `branch:${X}`);
    assert.deepEqual(e.paths, { 'src/a.txt': { add: [hashOf('BASE = 1')], del: [] } });
    assert.deepEqual(j.addedBy(hashOf('BASE = 1')), [`branch:${X}`]);
  });
});

test('provenance depends only on the live chain: a commit on refs/heads/<b> that is not on the live chain adds and removes no entry', T10, async () => {
  await withCores('prov-branch', { n: 1 }, async (fx) => {
    const p = fx.peers[0]!;
    const repo = p.core.repo;
    const head = parseOid(await gitIn(p, ['rev-parse', 'HEAD']));
    const tree = await repo.editTree((await repo.readCommit(head)).tree, [{ path: 'src/a.txt', mode: '100644', oid: await repo.hashBytes(buf(`${A0}BRANCH = 1\n`), true) }], p.core.scratch('a'));
    const branchCommit = parseOid(await gitIn(p, ['commit-tree', tree, '-p', head, '-m', 'a human commit on the branch']));
    await gitIn(p, ['update-ref', 'refs/heads/main', branchCommit, head]);
    const c1 = await applyTeam(fx, p, { 'src/b.txt': 'alpha\nbeta\ngamma\nTEAM = 1\n' });
    const entries = await journal(p);
    assert.deepEqual(entries.map((e) => e.commit), [c1.live], 'only the live commit');
    assert.ok(!entries.some((e) => e.commit === branchCommit));
    assert.deepEqual(p.core.prov.addedBy(hashOf('BRANCH = 1')), []);
    // Partial (U3 "provenance survives a save" is Plan 7's): the branch move changed nothing the journal holds.
    assert.deepEqual(p.core.prov.addedBy(hashOf('TEAM = 1')), [await writerOf(p, c1.live)]);
  });
});
