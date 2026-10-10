// The loop (Plan 2 Task 17; 01-engine §3.5, ENG-13…ENG-19, ENG-55…ENG-57; rulings R-07, R-11, R-16, R-18, R-35; the
// Plan 1 ledger carry "monotonic time across sleep"; the Task 14 carries on HTTP throttle signals and unresolved push
// intents; the Task 15 carry on recover under daemon.lock). Real git against file:// bare remotes; git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BOARD_SUBJECT, readBoardCommit } from '../../src/board/boardCommit.js';
import { readProtocol, serializeProtocol } from '../../src/board/protocol.js';
import { foldPatch } from '../../src/engine/core.js';
import { regionSpecId } from '../../src/engine/deps.js';
import { DaemonLock, daemonLockHeld, Engine, LOOP_ACTIVE_MS, LOOP_IDLE_MS, runLoop, type MaskViolation } from '../../src/engine/loop.js';
import type { StatusJson } from '../../src/engine/status.js';
import type { Oid } from '../../src/git/oid.js';
import { ReadyBaseMismatchError } from '../../src/holds/changesets.js';
import type { MktreeEntry } from '../../src/git/repo.js';
import { LEASE_EXIT_MS, LEASE_STOP_SYNC_MS, type LeasePort } from '../../src/ports/lease.js';
import { PLUGIN_VERSION } from '../../src/version.js';
import { VirtualScheduler } from '../sim/vscheduler.js';
import { seededRandom } from '../../src/ports/random.js';
import { readWork, workPath, writeWork, type PeerFixture } from '../helpers/coreFixture.js';
import { assertConverged, countCalls, logOf, quiesce, remoteBoardTip, storedText, withEngines, type EngineFixture } from '../helpers/engineFixture.js';
import { boardOn, forceRemote, liveOf, liveOn } from '../helpers/incidentFixture.js';
import { buf, captureReady, failedResult, lines, prep, wrapGit } from '../helpers/publishHelpers.js';

const sleepReal = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function statusOf(p: PeerFixture): Promise<StatusJson> {
  return JSON.parse((await readFile(join(p.deps.paths.coworkDir, 'status.json'))).toString('utf8')) as StatusJson;
}

/** The live code tree of the remote board tip, as path → text. */
async function remoteLiveFiles(fx: EngineFixture, p: PeerFixture): Promise<Map<string, string>> {
  const T = (await remoteBoardTip(fx)) as Oid;
  const repo = p.core.repo;
  await p.core.fetcher.fetch(true);
  const live = await liveOf(p, T);
  const out = new Map<string, string>();
  for (const [path, e] of await repo.readTreeMap((await repo.readCommit(live)).tree)) out.set(path, (await repo.readBlob(e.oid)).toString('utf8'));
  return out;
}

/** Rewrites a working file in its stored LF form (CRLF on an autocrlf=true peer, as its editor would keep it). */
async function edit(p: PeerFixture, path: string, f: (s: string) => string): Promise<void> {
  const next = f((await storedText(p, path)) ?? '');
  await writeWork(p, path, p.clone.opts.autocrlf ? next.replace(/\n/g, '\r\n') : next);
}

const CONVERGE_FILES: Record<string, Buffer> = {
  'README.md': buf('# loop\n'),
  'shared.txt': buf(lines(30, (i) => `shared ${i}`)),
  'same.txt': buf(lines(5, (i) => `same ${i}`)),
  'p1.txt': buf('p1 a\np1 b\n'),
  'p2.txt': buf('p2 a\np2 b\n'),
  'p3.txt': buf('p3 a\np3 b\n'),
};

// Its own timeout (tools/test/run-tests.mjs sets 10 min per test on Node 24+, and 60 min per file before 24): ~160 s alone, the
// 20 + 40 quiescence rounds of three peers are in its title, and a loaded CI machine runs it several times slower.
test('three peers (one autocrlf=true) editing different files, disjoint bands of one file and one shared line converge within 20 rounds of the last landing, then make zero pushes for 40 rounds', { timeout: 20 * 60_000 }, async () => {
  await withEngines('loop-converge', { n: 3, files: CONVERGE_FILES, autocrlf: [false, true, false] }, async (fx) => {
    await fx.startAll();
    await fx.rounds(2);
    const [p1, p2, p3] = fx.peers as [typeof fx.peers[0], typeof fx.peers[0], typeof fx.peers[0]];
    await edit(p1, 'p1.txt', (s) => s.replace('p1 b', 'p1 B'));
    await edit(p2, 'p2.txt', (s) => s.replace('p2 b', 'p2 B'));
    await edit(p3, 'p3.txt', (s) => s.replace('p3 b', 'p3 B'));
    await edit(p1, 'shared.txt', (s) => s.replace('shared 4\n', 'shared 4 by p1\n'));
    await edit(p2, 'shared.txt', (s) => s.replace('shared 14\n', 'shared 14 by p2\n'));
    await edit(p3, 'shared.txt', (s) => s.replace('shared 24\n', 'shared 24 by p3\n'));
    await edit(p1, 'same.txt', (s) => s.replace('same 3\n', 'same 3 by p1\n'));
    await edit(p2, 'same.txt', (s) => s.replace('same 3\n', 'same 3 by p2\n'));

    const q = await quiesce(fx, { k: 20, maxRounds: 200 });
    const files = await assertConverged(fx, q.tStar);
    for (const [path, want] of [['p1.txt', 'p1 B'], ['p2.txt', 'p2 B'], ['p3.txt', 'p3 B']] as const) assert.match(files.get(path)!, new RegExp(want));
    const shared = files.get('shared.txt')!;
    for (const band of ['shared 4 by p1', 'shared 14 by p2', 'shared 24 by p3']) assert.ok(shared.includes(`${band}\n`), `shared.txt keeps ${band}`);
    // The same line: exactly one version won; the loser's version is one K4 record (R-02), never lost.
    const same = files.get('same.txt')!;
    assert.ok(same.includes('same 3 by p1\n') !== same.includes('same 3 by p2\n'), `same.txt holds one version: ${JSON.stringify(same)}`);
    const k4 = [p1, p2].flatMap((p) => p.core.holds.all().filter((r) => r.paths.includes('same.txt') && r.guards.some((g) => g.name === 'conflict')));
    assert.equal(k4.length, 1, 'one K4 record for the displaced same-line version');
    for (const p of fx.peers) assert.equal((await statusOf(p)).state, 'ok');

    // 40 more rounds: zero push attempts by any peer and an unchanged tip (INV-CONVERGE, R-32).
    const before = fx.peers.map((p) => p.core.pushAttempts);
    await fx.rounds(40);
    assert.deepEqual(fx.peers.map((p) => p.core.pushAttempts), before, 'zero pushes after quiescence');
    assert.equal(await remoteBoardTip(fx), q.tStar);
  });
});

test('iterations never overlap and fetches stay single-flight inside the loop', async () => {
  await withEngines('loop-overlap', { n: 1 }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    await fx.rounds(1);
    const log: string[] = [];
    let inflight = 0;
    let maxInflight = 0;
    let release!: () => void;
    let gate: Promise<void> | null = new Promise<void>((r) => { release = r; });
    const restore = wrapGit(p, async (args, opts, inner) => {
      if (args[0] !== 'fetch') return inner(args, opts);
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      log.push('fetch-start');
      try {
        if (gate !== null) {
          const g = gate;
          gate = null;
          await g;
        }
        return await inner(args, opts);
      } finally {
        inflight -= 1;
        log.push('fetch-end');
      }
    });
    const emit = fx.trace.emit.bind(fx.trace);
    fx.trace.emit = (ev) => {
      if (ev.kind === 'iteration' && ev.peer === p.core.peerId) log.push(`iteration ${ev.n}`);
      emit(ev);
    };
    try {
      // The Engine observes completed fetches through the hook it gave the Fetcher, never by replacing its methods.
      assert.equal(Object.prototype.hasOwnProperty.call(p.core.fetcher, 'fetch'), false, 'Fetcher.fetch is not patched');
      fx.advance(3_000);
      const first = p.engine.iterate();
      while (!log.includes('fetch-start')) await sleepReal(5);
      // An out-of-cycle fresh-fetch request and a second iteration while the first one's fetch is in flight.
      p.engine.requestFreshFetch();
      let secondDone = false;
      const second = p.engine.iterate().then((r) => {
        secondDone = true;
        return r;
      });
      const direct = p.core.fetcher.fetch(true);   // joins the in-flight fetch (single flight)
      await sleepReal(300);
      assert.equal(secondDone, false, 'the second iteration waits for the first');
      assert.deepEqual(log, ['fetch-start'], 'no second fetch while one is in flight');
      release();
      const [r1, r2] = await Promise.all([first, second]);
      await direct;
      assert.equal(maxInflight, 1, 'never two fetches at once');
      assert.equal(r2.n, r1.n + 1);
      // 01-engine §3.5: a fresh-fetch request that arrives while a fetch is in flight waits for that fetch instead of
      // starting another: the second iteration decides on the first one's answer.
      assert.deepEqual(log, ['fetch-start', 'fetch-end', `iteration ${r1.n}`, `iteration ${r2.n}`]);
      assert.equal(r1.fetched, true);
      assert.equal(r2.fetched, false, 'the request was served by the fetch in flight');
      // A request with no fetch in flight starts one at once, inside the 2.5 s spacing.
      p.engine.requestFreshFetch();
      const r3 = await p.engine.iterate();
      assert.equal(r3.fetched, true, 'the request forced a fetch inside the spacing');
      // Without a request, an iteration inside the spacing runs no fetch (P2-NOSLEEP: the last view, deferred).
      const r4 = await p.engine.iterate();
      assert.equal(r4.fetched, false);
      assert.equal(log.filter((l) => l === 'fetch-start').length, 2);
      assert.equal(maxInflight, 1);
    } finally {
      restore();
      fx.trace.emit = emit;
    }
  });
});

test('a 60 s wall-only suspend and a 60 s advance of both clocks between iterations each force a fetch before any apply or publish', async () => {
  await withEngines('loop-suspend', { n: 1 }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    let abandons = 0;
    const abandon = p.core.fetcher.abandon.bind(p.core.fetcher);
    p.core.fetcher.abandon = () => {
      abandons += 1;
      abandon();
    };
    await fx.rounds(3);
    assert.equal(abandons, 0, 'an ordinary period is no suspend');
    const ownKinds = (from: number): string[] => fx.trace.since(from).filter((e) => 'peer' in e && e.peer === p.core.peerId).map((e) => e.kind);

    // (1) Δwall − Δmono = 60 s: the next iteration starts 0.5 s Δmono after the previous fetch, inside the 2.5 s spacing.
    await fx.pushTeamChange({ 'team1.txt': buf('t1\n') });
    p.clock.suspend(60_000);
    fx.advance(500);
    let mark = fx.trace.events.length;
    const r1 = await p.engine.iterate();
    assert.equal(abandons, 1, 'the suspend gap abandons in-flight network calls');
    assert.equal(r1.fetched, true, 'a fetch ran although the spacing had not passed');
    assert.equal(r1.applied, true, 'the apply ran on the freshly fetched tip');
    let kinds = ownKinds(mark);
    assert.ok(kinds.includes('fetch') && kinds.indexOf('fetch') < kinds.indexOf('apply'), `fetch before apply: ${kinds.join(',')}`);
    assert.ok(!kinds.slice(0, kinds.indexOf('fetch')).some((k) => k === 'apply' || k === 'push' || k === 'publish' || k === 'merge'), `nothing decided before the fetch: ${kinds.join(',')}`);
    assert.equal(await storedText(p, 'team1.txt'), 't1\n');

    // (2) both clocks 60 s (Δmono > 3 × the loop period): a local edit and a team change, one iteration.
    await writeWork(p, 'local.txt', 'mine\n');
    await fx.rounds(1);
    await fx.pushTeamChange({ 'team2.txt': buf('t2\n') });
    fx.advance(60_000);
    mark = fx.trace.events.length;
    const r2 = await p.engine.iterate();
    assert.equal(abandons, 2);
    assert.equal(r2.fetched, true);
    assert.equal(r2.applied, true);
    kinds = ownKinds(mark);
    const firstFetch = kinds.indexOf('fetch');
    assert.ok(firstFetch >= 0 && firstFetch < kinds.indexOf('apply'), `fetch before apply: ${kinds.join(',')}`);
    assert.ok(!kinds.slice(0, firstFetch).some((k) => k === 'push' || k === 'publish' || k === 'merge'), `nothing decided before the fetch: ${kinds.join(',')}`);
    // The capture's publish waits for its governed window (the fetch just observed a new tip), then lands.
    await fx.rounds(4);
    assert.equal((await remoteLiveFiles(fx, p)).get('local.txt'), 'mine\n');

    // (3) A long iteration is no suspend: Δmono > 3 × the period is measured from the END of the previous iteration (and
    // Δwall − Δmono from its START is 0: both clocks moved). One iteration whose fetch takes 40 s of Δmono (more than 3
    // idle periods), then an ordinary period.
    await fx.rounds(2, 10_000);
    const slow = wrapGit(p, async (args, opts, inner) => {
      if (args[0] === 'fetch') p.clock.advance(40_000);
      return inner(args, opts);
    });
    try {
      fx.advance(10_000);
      await p.engine.iterate();
    } finally {
      slow();
    }
    const before = abandons;
    fx.advance(2_500);
    await p.engine.iterate();
    assert.equal(abandons, before, 'a long iteration followed by an ordinary period is no suspend');
  });
});

test('a sleep that starts inside an iteration (during its fetch) is seen by the next iteration: it abandons, decides no apply before a fetch succeeds, and owes that fetch', async () => {
  await withEngines('loop-suspend-inside', { n: 1 }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    await fx.rounds(3);
    let abandons = 0;
    const abandon = p.core.fetcher.abandon.bind(p.core.fetcher);
    p.core.fetcher.abandon = () => {
      abandons += 1;
      abandon();
    };
    // team1 applied (the 10 s apply coalescing starts over).
    await fx.pushTeamChange({ 'team1.txt': buf('t1\n') });
    fx.advance(10_500);
    await p.engine.iterate();
    assert.equal(await storedText(p, 'team1.txt'), 't1\n');

    // team2 is fetched by an iteration whose fetch spans a 60 s sleep of the PC (wall only); its apply waits (coalescing).
    await fx.pushTeamChange({ 'team2.txt': buf('t2\n') });
    let sleepInFetch = true;
    let cut = false;
    const restore = wrapGit(p, async (args, opts, inner) => {
      if (args[0] === 'fetch' && sleepInFetch) {
        sleepInFetch = false;
        p.clock.suspend(60_000);
      }
      if (cut && opts.class === 'network') return failedResult(128, "fatal: unable to access 'remote': Could not resolve host\n");
      return inner(args, opts);
    });
    try {
      fx.advance(6_000);
      const r0 = await p.engine.iterate();
      assert.equal(sleepInFetch, false, 'the iteration fetched, and the PC slept inside that fetch');
      assert.equal(r0.applied, false, 'coalesced: team2 fetched, not applied yet');
      assert.equal(abandons, 0, 'the iteration that slept cannot see its own sleep');

      // The next iteration 5 s later (less than 3 active periods: no Δmono suspend) and without network: Δwall − Δmono
      // counts from the START of the previous iteration, so the sleep inside it is a suspend. 11 s after the apply the
      // coalescing would admit team2.
      cut = true;
      fx.advance(5_000);
      const r1 = await p.engine.iterate();
      assert.equal(abandons, 1, 'the next iteration abandons in-flight network calls');
      assert.equal(r1.applied, false, 'no apply on the tip fetched across the sleep: the fetch after it failed');
      assert.equal(await storedText(p, 'team2.txt'), null);
      // The fetch is owed: later iterations decide no apply either until one succeeds.
      for (let i = 0; i < 4; i++) {
        fx.advance(5_000);
        const r = await p.engine.iterate();
        assert.equal(r.applied, false, `iteration ${i}: the fetch is still owed`);
      }
      assert.equal(await storedText(p, 'team2.txt'), null);
      assert.equal(abandons, 1, 'one suspend');

      // The network returns: the first fetch that succeeds comes before the apply.
      cut = false;
      const mark = fx.trace.events.length;
      for (let i = 0; i < 30 && (await storedText(p, 'team2.txt')) === null; i++) {
        fx.advance(5_000);
        await p.engine.iterate();
      }
      assert.equal(await storedText(p, 'team2.txt'), 't2\n', 'applied after the successful fetch');
      const own = fx.trace.since(mark).filter((e) => 'peer' in e && e.peer === p.core.peerId);
      const okFetch = own.findIndex((e) => e.kind === 'fetch' && 'ok' in e && e.ok === true);
      const firstApply = own.findIndex((e) => e.kind === 'apply');
      assert.ok(okFetch >= 0 && okFetch < firstApply, `an ok fetch before the apply: ${own.map((e) => e.kind).join(',')}`);
    } finally {
      restore();
    }
  });
});

test('after a suspend the loop keeps capturing but decides no apply or publish until a fetch has succeeded, also while the remote stays unreachable for a whole backoff', async () => {
  await withEngines('loop-suspend-mustfetch', { n: 1 }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    await fx.rounds(3);
    let abandons = 0;
    const abandon = p.core.fetcher.abandon.bind(p.core.fetcher);
    p.core.fetcher.abandon = () => {
      abandons += 1;
      abandon();
    };
    // team1 applied; team2 fetched and folded but held by the 10 s apply coalescing.
    await fx.pushTeamChange({ 'team1.txt': buf('t1\n') });
    fx.advance(10_500);
    await p.engine.iterate();
    assert.equal(await storedText(p, 'team1.txt'), 't1\n');
    await fx.pushTeamChange({ 'team2.txt': buf('t2\n') });
    fx.advance(3_000);
    await p.engine.iterate();
    assert.equal(await storedText(p, 'team2.txt'), null, 'coalesced: fetched, not applied yet');

    // The PC sleeps 60 s and wakes without network; a local edit is made at the wake.
    let cut = true;
    const restore = wrapGit(p, async (args, opts, inner) => (cut && opts.class === 'network' ? failedResult(128, "fatal: unable to access 'remote': Could not resolve host\n") : inner(args, opts)));
    try {
      await writeWork(p, 'local.txt', 'written at the wake\n');
      const pushes = p.core.pushAttempts;
      p.clock.suspend(60_000);
      fx.advance(8_000);   // 11 s since the apply: the coalescing would admit it now
      let r = await p.engine.iterate();
      assert.equal(abandons, 1, 'the suspend was seen');
      assert.equal(r.applied, false, 'no apply on the tip fetched before the suspend: the fetch after it failed');
      assert.equal(await storedText(p, 'team2.txt'), null);
      // A whole backoff without the remote: captures go on (the edit closes after 20 s), no apply, no push.
      for (let i = 0; i < 12; i++) {
        fx.advance(5_000);
        r = await p.engine.iterate();
        assert.equal(r.applied, false, `iteration ${i}: no apply before a fetch succeeded`);
      }
      assert.equal(p.core.cs.ready().length, 1, 'the edit made at the wake was captured');
      assert.equal(p.core.pushAttempts, pushes, 'no push of any kind');
      assert.equal(await storedText(p, 'team2.txt'), null);
      assert.equal(abandons, 1, 'one suspend');

      // The network returns: the first fetch that succeeds lets the apply and the publish run.
      cut = false;
      for (let i = 0; i < 40 && (await storedText(p, 'team2.txt')) === null; i++) {
        fx.advance(5_000);
        await p.engine.iterate();
      }
      assert.equal(await storedText(p, 'team2.txt'), 't2\n', 'applied after the successful fetch');
      for (let i = 0; i < 12 && (await remoteLiveFiles(fx, p)).get('local.txt') === undefined; i++) await fx.rounds(1);
      assert.equal((await remoteLiveFiles(fx, p)).get('local.txt'), 'written at the wake\n', 'published after it');
    } finally {
      restore();
    }
  });
});

test('after a suspend a local fetch failure (a stale ref lock) is not retried by forced fetches: the owed fetch follows the normal schedule, shows as NOT_CONVERGED{fetch_owed} after 60 s, and the apply waits until a fetch succeeds', async () => {
  await withEngines('loop-owed-local', { n: 1 }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    await fx.rounds(3);
    // A team change on the remote and a stale lock on the local board ref: every fetch the remote answers then fails to
    // update that ref — a LOCAL failure (P2-FETCHLOCAL: never OFFLINE, no network backoff).
    await fx.pushTeamChange({ 'team.txt': buf('t\n') });
    const lock = `${join(p.deps.paths.gitDir, ...p.core.refs.localBoard.split('/'))}.lock`;
    await mkdir(dirname(lock), { recursive: true });
    await writeFile(lock, '');
    const ownFetches = (from: number): boolean[] => fx.trace.since(from).flatMap((e) => (e.kind === 'fetch' && e.peer === p.core.peerId ? [e.ok] : []));
    try {
      p.clock.suspend(60_000);
      fx.advance(2_500);
      const owedAt = p.clock.monoMs();
      let mark = fx.trace.events.length;
      let r = await p.engine.iterate();
      assert.equal(r.applied, false);
      assert.deepEqual(ownFetches(mark), [false], 'the forced fetch after the suspend ran and failed locally');

      // Two minutes at the loop's own pace (its nextDueMs, as runLoop schedules it): after the failed forced fetch the
      // owed fetch is not forced again and does not keep the loop at the active pace — nothing else is pending, so the
      // loop idles at 10 s and the fetch is retried at that pace, never every 2.5 s.
      mark = fx.trace.events.length;
      let degradedAt: number | null = null;
      while (p.clock.monoMs() - owedAt < 120_000) {
        fx.advance(r.nextDueMs);
        r = await p.engine.iterate();
        assert.equal(r.applied, false, 'no apply before a fetch succeeded');
        if (degradedAt === null && (await statusOf(p)).message_code === 'NOT_CONVERGED') degradedAt = p.clock.monoMs() - owedAt;
      }
      const attempts = ownFetches(mark);
      assert.ok(attempts.length <= 13 && attempts.every((ok) => !ok), `fetches at the idle pace, none forced: ${attempts.length}`);
      assert.equal((await statusOf(p)).loop_period_ms, LOOP_IDLE_MS);
      // The owed fetch shows in status after 60 s (not before), path-less while nothing is captured; logged once.
      assert.equal(degradedAt, 60_000);
      const s = await statusOf(p);
      assert.deepEqual([s.state, s.message_code, s.message_params, s.pending.not_converged], ['degraded', 'NOT_CONVERGED', { cause: 'fetch_owed', paths: [], causes: [] }, []]);
      const owedLogs = (): number => logOf(p).lines.filter((l) => l.code === 'NOT_CONVERGED' && l.params['cause'] === 'fetch_owed').length;
      assert.equal(owedLogs(), 1);
      assert.equal(await storedText(p, 'team.txt'), null);

      // Captures go on (LIF-38); the captured pair's paths wait for the owed fetch too.
      await writeWork(p, 'local.txt', 'mine\n');
      for (let i = 0; i < 12; i++) {
        fx.advance(2_500);
        await p.engine.iterate();
      }
      assert.equal(p.core.cs.ready().length, 1, 'captured while the fetch is owed');
      const s2 = await statusOf(p);
      assert.deepEqual([s2.state, s2.message_code, s2.message_params, s2.pending.not_converged],
        ['degraded', 'NOT_CONVERGED', { cause: 'fetch_owed', paths: ['local.txt'], causes: [{ cause: 'fetch_owed' }] }, ['local.txt']]);

      // The lock removed (the human's fix): the next fetch succeeds, the apply and the publish follow, status ok again.
      await rm(lock);
      for (let i = 0; i < 12 && (await storedText(p, 'team.txt')) === null; i++) {
        fx.advance(2_500);
        await p.engine.iterate();
      }
      assert.equal(await storedText(p, 'team.txt'), 't\n', 'applied once a fetch succeeded');
      for (let i = 0; i < 12 && (await remoteLiveFiles(fx, p)).get('local.txt') === undefined; i++) await fx.rounds(1);
      assert.equal((await remoteLiveFiles(fx, p)).get('local.txt'), 'mine\n', 'published');
      const s3 = await statusOf(p);
      assert.deepEqual([s3.state, s3.pending.not_converged], ['ok', []]);
      assert.equal(owedLogs(), 1);
    } finally {
      await rm(lock, { force: true });
    }
  });
});

test('with .git/index.lock present the loop only fetches and folds, raises INDEX_LOCK_WAIT after 30 s of the same mtime, and never deletes it', async () => {
  await withEngines('loop-indexlock', { n: 1 }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    await fx.rounds(2);
    await writeWork(p, 'local.txt', 'mine\n');
    await fx.rounds(1);
    const team = await fx.pushTeamChange({ 'team.txt': buf('t\n') });
    const lock = join(p.deps.paths.gitDir, 'index.lock');
    await writeFile(lock, '');
    const lockStat = await stat(lock);
    const newMtime = new Date(Math.floor(lockStat.mtimeMs) + 60_000);
    const before = { commit: p.core.view!.commit, pushes: p.core.pushAttempts, ready: p.core.cs.ready().length };
    const mark = fx.trace.events.length;
    const waits = (): number => logOf(p).lines.filter((l) => l.code === 'INDEX_LOCK_WAIT').length;
    // ENG-15: fetch and fold only — no detection tick, no change-set observation, no ring sweep (it writes the work tree).
    const spies = [countCalls(p.core.writer, 'sweepRing'), countCalls(p.core.snapshot, 'tick'), countCalls(p.core.cs, 'observe'), countCalls(p.core.snapshot, 'materialize')];
    try {
      fx.advance(21_000);   // the open change-set is due and the apply coalescing passed
      const t0 = p.clock.monoMs();
      // Steps ≤ 7 s of Δmono (no suspend gap); the lock is first seen at t0.
      const at = async (ms: number): Promise<void> => {
        fx.advance(t0 + ms - p.clock.monoMs());
        const r = await p.engine.iterate();
        assert.equal(r.applied, false);
        assert.equal(r.pushAttempts, 0);
      };
      for (const ms of [0, 7_000, 14_000, 21_000, 28_000, 29_999]) await at(ms);
      assert.equal(waits(), 0, 'no notice before 30 s of the same mtime');
      await at(30_000);
      assert.equal(waits(), 1, 'one INDEX_LOCK_WAIT at 30 s of the same mtime');
      const s = await statusOf(p);
      assert.deepEqual([s.message_code, s.message_params], ['INDEX_LOCK_WAIT', { age: 30 }], '08-lifecycle: INDEX_LOCK_WAIT{age}');
      await at(37_000);
      assert.equal(waits(), 1, 'one notice per mtime');
      // Another mtime (a new git command took the lock): its own 30 s. (A Date holds whole milliseconds: the new mtime is
      // computed from the floor of the old one, which can carry a sub-millisecond fraction on NTFS.)
      await utimes(lock, newMtime, newMtime);
      for (const ms of [40_000, 47_000, 54_000, 61_000, 68_000, 69_999]) await at(ms);
      assert.equal(waits(), 1, 'the new mtime restarted the 30 s');
      await at(70_000);
      assert.equal(waits(), 2, 'a second notice 30 s after the mtime changed');
      assert.deepEqual(spies.map((x) => x.n), [0, 0, 0, 0], 'sweepRing, tick, observe, materialize');
    } finally {
      for (const x of spies) x.restore();
    }
    assert.equal(p.core.view!.commit, before.commit, 'no state update: no capture, no apply');
    assert.equal(p.core.pushAttempts, before.pushes, 'no publish');
    assert.equal(p.core.cs.ready().length, before.ready, 'no capture');
    assert.equal(foldPatch(p.core)?.meta.fold_board, team.board, 'the fold followed the fetched board');
    const kinds = fx.trace.since(mark).filter((e) => 'peer' in e && e.peer === p.core.peerId).map((e) => e.kind);
    assert.ok(kinds.includes('fetch'));
    assert.ok(!kinds.some((k) => k === 'apply' || k === 'push' || k === 'publish' || k === 'hold'), kinds.join(','));
    assert.equal((await statusOf(p)).message_code, 'INDEX_LOCK_WAIT');
    const lastMtime = (await stat(lock)).mtimeMs;
    assert.ok(Math.abs(lastMtime - newMtime.getTime()) < 1, `never deleted or touched by the daemon (the mtime the test set last): ${lastMtime} vs ${newMtime.getTime()}`);
    assert.equal(await readWork(p, 'team.txt'), null);

    // The lock goes away: the next iterations apply, capture and publish.
    await rm(lock);
    await fx.rounds(3);
    assert.equal(await storedText(p, 'team.txt'), 't\n');
    assert.equal((await remoteLiveFiles(fx, p)).get('local.txt'), 'mine\n');
    assert.notEqual((await statusOf(p)).message_code, 'INDEX_LOCK_WAIT');
  });
});

/**
 * A board commit on the remote tip whose protocol.json says proto 2 (test code: a writer of another protocol version;
 * PRO-04's carried blob replaced), with a live change.
 */
async function landProto2Board(fx: EngineFixture, p: PeerFixture, changes: Record<string, string>): Promise<Oid> {
  const repo = p.core.repo;
  await p.core.fetcher.fetch(true);
  const T = (await remoteBoardTip(fx)) as Oid;
  const tip = await liveOf(p, T);
  const tipTree = (await repo.readCommit(tip)).tree;
  const edits = [];
  for (const [path, text] of Object.entries(changes)) edits.push({ path, mode: '100644' as const, oid: await repo.hashBytes(buf(text), true) });
  const tree = await repo.editTree(tipTree, edits, join(p.deps.paths.coworkDir, 'tmp', 'test-proto.index'));
  const B = await boardOn(p, T, await liveOn(p, [tip], tree));
  const c = await repo.readCommit(B);
  // The root entries (the carried checkpoint/ subtree included), protocol.json replaced.
  const entries: MktreeEntry[] = [];
  for (const rec of (await repo.run(['ls-tree', '-z', c.tree])).stdout.toString('utf8').split('\0').filter((x) => x.length > 0)) {
    const [meta, name] = rec.split('\t') as [string, string];
    const [mode, type, oid] = meta.split(' ') as [MktreeEntry['mode'], MktreeEntry['type'], Oid];
    const value = name === 'protocol.json' ? await repo.hashBytes(serializeProtocol({ ...readProtocol(await repo.readBlob(oid)), proto: 2 }), true) : oid;
    entries.push({ name, mode, type, oid: value });
  }
  const B2 = await repo.commitTree({ tree: await repo.mktree(entries), parents: c.parents, subject: c.subject, trailers: c.trailers });
  await forceRemote(fx, p, p.core.refs.remoteBoard, B2);
  assert.equal((await readBoardCommit(repo, B2)).protocol.proto, 2);
  return B2;
}

test('a board with proto 2 gets zero pushes while apply continues; an own regionSpec ≠ teamRegionSpec pauses code pushes and allows the board-only list', async () => {
  await withEngines('loop-version-proto', { n: 2 }, async (fx) => {
    await fx.startAll();
    await fx.rounds(3);
    const [p1, p2] = fx.peers as [typeof fx.peers[0], typeof fx.peers[0]];
    await writeWork(p2, 'mine.txt', 'p2 work\n');
    await fx.rounds(1);
    await landProto2Board(fx, p1, { 'team.txt': 'from another version\n' });
    const pushes = p2.core.pushAttempts;
    await fx.rounds(12);   // the change-set closes (20 s) and the apply coalescing passes
    assert.equal(await storedText(p2, 'team.txt'), 'from another version\n', 'apply continues');
    assert.equal(p2.core.pushAttempts, pushes, 'zero pushes of any kind');
    assert.equal(p2.core.cs.ready().length, 1, 'the local work is captured and waits');
    const s = await statusOf(p2);
    assert.equal(s.publish_pause, 'VERSION');
    assert.deepEqual([s.state, s.message_code, s.message_params], ['degraded', 'VERSION_PAUSED', { form: 'proto', cause: null }]);
    assert.ok(s.pending.not_converged.includes('mine.txt'), 'a ready pair a pause keeps from publishing is listed');
    // 01-engine §2: blocked_publish with the publish pause that keeps it.
    assert.deepEqual((await p2.engine.inspect()).notConvergedWhy?.['mine.txt'], { cause: 'blocked_publish', reason: 'VERSION' });
  });

  await withEngines('loop-version-region', { n: 2 }, async (fx) => {
    const [p1, p2] = fx.peers as [typeof fx.peers[0], typeof fx.peers[0]];
    p2.deps.regionSpec = regionSpecId(['FoldMapper/2', 'extent-convention/1', 'label-convention/1']);
    await fx.startAll();
    await fx.rounds(4);
    // The board-only list: p2's join op landed (it is a live peer of the fold).
    const T = (await remoteBoardTip(fx)) as Oid;
    assert.equal(p2.core.view!.laB, T);
    assert.equal(foldPatch(p2.core)?.fold.peers[p2.core.peerId]?.status ?? p2.core.view!.fold?.peers[p2.core.peerId]?.status, 'active');
    // Code pushes paused for p2; p1 keeps publishing and p2 applies it.
    await writeWork(p2, 'p2.txt', 'p2 code\n');
    await writeWork(p1, 'p1.txt', 'p1 code\n');
    await fx.rounds(14);
    const remote = await remoteLiveFiles(fx, p1);
    assert.equal(remote.get('p1.txt'), 'p1 code\n');
    assert.equal(remote.get('p2.txt'), undefined, 'no code push under the regionSpec pause');
    assert.equal(await storedText(p2, 'p1.txt'), 'p1 code\n');
    const s = await statusOf(p2);
    assert.deepEqual([s.publish_pause, s.message_code, s.message_params], ['VERSION', 'VERSION_PAUSED', { form: 'regionSpec', cause: null }]);
    assert.deepEqual((await p2.engine.inspect()).notConvergedWhy?.['p2.txt'], { cause: 'blocked_publish', reason: 'VERSION' });
    assert.equal((await statusOf(p1)).publish_pause, null);
  });
});

test('after 3 min without a lease no capture, apply or new publish happens but ready pairs still flush; after 10 min the engine drains with status down and IDLE_NO_SESSION; a plain drain writes down without a code', async () => {
  await withEngines('loop-lease', { n: 2 }, async (fx) => {
    await fx.startAll();
    await fx.rounds(3);
    const [p1, p2] = fx.peers as [typeof fx.peers[0], typeof fx.peers[0]];
    // A ready pair captured while the lease was valid (captured, not yet published).
    await writeWork(p1, 'ready.txt', 'captured\n');
    await fx.rounds(1);
    fx.advance(21_000);
    await captureReady(p1, await prep(p1, true));
    assert.equal(p1.core.cs.ready().length, 1);

    let idleSince: number | null = null;
    const lease: LeasePort = { idleMs: () => (idleSince === null ? 0 : p1.clock.monoMs() - idleSince) };
    p1.deps.lease = lease;
    idleSince = p1.clock.monoMs() - 180_000;   // 3 min without a lease
    assert.ok(lease.idleMs() >= LEASE_STOP_SYNC_MS);
    await writeWork(p1, 'later.txt', 'not captured\n');
    await fx.pushTeamChange({ 'team.txt': buf('t\n') });
    for (let i = 0; i < 12; i++) {
      fx.advance(2_500);
      const r = await p1.engine.iterate();
      assert.equal(r.applied, false, 'no apply without a lease');
    }
    const remote = await remoteLiveFiles(fx, p1);
    assert.equal(remote.get('ready.txt'), 'captured\n', 'the already-captured ready pair flushed');
    assert.equal(remote.get('later.txt'), undefined, 'no new capture or publish');
    assert.equal(p1.core.cs.ready().length, 0);
    assert.equal(await readWork(p1, 'team.txt'), null, 'no apply');

    // 10 min without a lease: runLoop drains the engine (IDLE_NO_SESSION).
    idleSince = p1.clock.monoMs() - (LEASE_EXIT_MS - 15_000);
    const sched = new VirtualScheduler(p1.clock, seededRandom('lease-loop'));
    const h1 = runLoop(p1.engine, { scheduler: sched, clock: p1.clock, lease });
    let finished = false;
    void h1.finished.then(() => { finished = true; });
    for (let i = 0; i < 40 && !finished; i++) {
      await sched.step();
      await sleepReal(1);
    }
    await h1.finished;
    assert.equal(p1.engine.drained, true);
    const s1 = await statusOf(p1);
    assert.deepEqual([s1.state, s1.message_code], ['down', 'IDLE_NO_SESSION']);
    assert.ok(p1.clock.monoMs() - idleSince >= LEASE_EXIT_MS);
    const r = await p1.engine.iterate();
    assert.equal(r.fetched, false, 'a drained engine iterates no more');

    // A plain drain (stop): down without a code.
    const sched2 = new VirtualScheduler(p2.clock, seededRandom('plain-loop'));
    const h2 = runLoop(p2.engine, { scheduler: sched2, clock: p2.clock, lease: p2.deps.lease });
    await sched2.step();
    await h2.stop();
    await h2.finished;
    const s2 = await statusOf(p2);
    assert.deepEqual([s2.state, s2.message_code], ['down', null]);
    assert.equal(p2.engine.drained, true);
  });
});

test('runLoop iterates every LOOP_ACTIVE_MS while work is pending and every LOOP_IDLE_MS otherwise, one at a time', async () => {
  await withEngines('loop-period', { n: 1 }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    const sched = new VirtualScheduler(p.clock, seededRandom('period'));
    const h = runLoop(p.engine, { scheduler: sched, clock: p.clock, lease: p.deps.lease });
    const at: number[] = [];
    const emit = fx.trace.emit.bind(fx.trace);
    fx.trace.emit = (ev) => {
      if (ev.kind === 'iteration') at.push(p.clock.monoMs());
      emit(ev);
    };
    try {
      for (let i = 0; i < 4; i++) await sched.step();
      assert.equal(sched.pending(), 1, 'one iteration scheduled at a time');
      const idleGaps = at.slice(1).map((t, i) => t - at[i]!);
      assert.ok(idleGaps.every((g) => g === LOOP_IDLE_MS), `idle gaps ${idleGaps.join(',')}`);
      await writeWork(p, 'w.txt', 'x\n');
      at.length = 0;
      for (let i = 0; i < 4; i++) await sched.step();
      const gaps = at.slice(1).map((t, i) => t - at[i]!);
      assert.ok(gaps.every((g) => g <= LOOP_ACTIVE_MS), `active gaps ${gaps.join(',')}`);
      assert.equal((await statusOf(p)).loop_period_ms, LOOP_ACTIVE_MS);
    } finally {
      fx.trace.emit = emit;
      await h.stop();
    }
  });
});

test('a canon refusal on a LIVE path creates one ON_DISK eol-bom PATCH that masks the path and drops its guard when a later snapshot passes canon', async () => {
  const files = { 'README.md': buf('# eol\n'), 'mixed.txt': buf('a\r\nb\nc\r\nd\n') };
  await withEngines('loop-eolbom', { n: 1, files }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    await fx.rounds(2);
    const eolBom = () => p.core.holds.all().filter((r) => r.paths.includes('mixed.txt') && r.origin === 'daemon' && r.kind === 'PATCH');
    // A matched row's ending changes in a MIXED file: canon refuses (D1 step 3).
    await writeWork(p, 'mixed.txt', 'a\nb\nc\nd\nE\n');
    await fx.rounds(1);
    fx.advance(21_000);
    await p.engine.iterate();
    let recs = eolBom();
    assert.equal(recs.length, 1, 'one eol-bom record');
    assert.deepEqual([recs[0]!.residence, recs[0]!.state, recs[0]!.guards.map((g) => g.name)], ['ON_DISK', 'ACTIVE', ['eol-bom']]);
    assert.ok(p.core.holds.maskingRecords().some((r) => r.id === recs[0]!.id), 'the record masks the path');
    assert.equal((await remoteLiveFiles(fx, p)).get('mixed.txt'), 'a\r\nb\nc\r\nd\n', 'nothing of the refused bytes is published');
    await fx.rounds(4);
    assert.equal(eolBom().length, 1, 'still one record');
    // A later snapshot passes canon: the guard is dropped and the change publishes.
    await writeWork(p, 'mixed.txt', 'a\r\nb\nc\r\nd\nE\n');
    await fx.rounds(1);
    fx.advance(21_000);
    await p.engine.iterate();
    await fx.rounds(2);
    recs = eolBom();
    assert.equal(recs.length, 1);
    assert.deepEqual(recs[0]!.guards, [], 'the eol-bom guard is dropped');
    // Released records end in a terminal state (GONE: the refused bytes left the disk) instead of piling up ACTIVE.
    assert.deepEqual([recs[0]!.state, recs[0]!.residence], ['GONE', null], 'terminal');
    assert.ok(!p.core.holds.nonTerminal().some((r) => r.id === recs[0]!.id), 'no longer counted in holds_active');
    assert.ok(!p.core.holds.maskingRecords().some((r) => r.id === recs[0]!.id), 'masks nothing any more');
    assert.equal((await remoteLiveFiles(fx, p)).get('mixed.txt'), 'a\r\nb\nc\r\nd\nE\n');
  });
});

test('a 429 on the iteration fetch with nothing to publish still enters the fallback', async () => {
  await withEngines('loop-429', { n: 1 }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    await fx.rounds(2);
    assert.equal(p.core.governor.mode(), 'normal');
    let armed = true;
    const restore = wrapGit(p, async (args, opts, inner) => {
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
      const s = await statusOf(p);
      assert.deepEqual([s.state, s.message_code, s.message_params['source'], s.message_params['signal']], ['ok', 'HOST_THROTTLED', 'own', 'http_429']);
      assert.equal(p.core.outbox.size, 0, 'a fetch-only signal with nothing pending posts no event (R-18)');

      // An iteration that never reaches publishStep (index.lock: fetch and fold only) hands its signal over too.
      fx.advance(31 * 60_000);
      await fx.rounds(1);
      assert.equal(p.core.governor.mode(), 'normal');
      const lock = join(p.deps.paths.gitDir, 'index.lock');
      await writeFile(lock, '');
      armed = true;
      fx.advance(2_500);
      await p.engine.iterate();
      assert.equal(p.core.governor.mode(), 'fallback');
      await rm(lock);
    } finally {
      restore();
    }
  });
});

test('a fallback with no own signal known (an own folded HOST_THROTTLED event) shows HOST_THROTTLED with source own and signal null', async () => {
  await withEngines('loop-throttle-own', { n: 1 }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    await fx.rounds(2);
    // Task 7 ruling: fallbackSource() is null while mode() is fallback for an own folded event with no own signal.
    p.core.governor.onThrottleEventFolded(true);
    assert.deepEqual([p.core.governor.mode(), p.core.governor.fallbackSource()], ['fallback', null]);
    fx.advance(2_500);
    await p.engine.iterate();
    const s = await statusOf(p);
    assert.deepEqual([s.state, s.message_code, s.message_params['source'], s.message_params['signal']], ['ok', 'HOST_THROTTLED', 'own', null]);
    assert.equal(s.message_params['budget'], 6, 'the fallback budget');
  });
});

test('a branch already rewritten at the first classification is logged once and shown: BRANCH_REWRITTEN{hb, hr: missing} in ok', async () => {
  await withEngines('loop-branch-first', { n: 1 }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    // R-08: the live branch deleted on the remote before the engine's first iteration (Hr missing).
    await forceRemote(fx, p, 'refs/heads/main', null);
    fx.advance(2_500);
    await p.engine.iterate();
    const lines = (): number => logOf(p).lines.filter((l) => l.code === 'BRANCH_REWRITTEN').length;
    assert.equal(lines(), 1, 'logged at the first classification');
    const s = await statusOf(p);
    // 01-engine §2: Hb (8 hex), Hr (8 hex) or missing.
    assert.deepEqual([s.state, s.message_code, s.message_params], ['ok', 'BRANCH_REWRITTEN', { hb: p.core.view!.meta.EPOCH_BASE.slice(0, 8), hr: 'missing' }]);
    await fx.rounds(3);
    assert.equal(lines(), 1, 'once');
    assert.equal((await statusOf(p)).message_code, 'BRANCH_REWRITTEN');
  });
});

test('an INV-MASK violation (ENG-28) stops the capture and every publish of its iteration and shows in status as not_converged with cause publish_assert', async () => {
  await withEngines('loop-invmask', { n: 1 }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    await fx.rounds(2);
    await writeWork(p, 'a.txt', 'mine\n');
    await fx.rounds(1);
    fx.advance(21_000);
    // Fault injection at the assertion's boundary: the INV-MASK check (the Engine's sPubHolds, typed by its MaskViolation
    // result so a changed shape fails to compile) reports a held path in S_pub.
    assert.equal(typeof Reflect.get(p.engine, 'sPubHolds'), 'function', 'the injection point exists');
    const fault = async (): Promise<MaskViolation> => ({ path: 'a.txt', check: 'INV-MASK' });
    Reflect.set(p.engine, 'sPubHolds', fault);
    try {
      const r = await p.engine.iterate();
      assert.equal(r.pushAttempts, 0, 'no publish');
      assert.equal(p.core.cs.ready().length, 0, 'no capture');
      const s = await statusOf(p);
      // 01-engine §3.5 step 4: NOT_CONVERGED{cause: publish_assert, check: INV-MASK}.
      assert.deepEqual([s.state, s.message_code, s.message_params, s.pending.not_converged], [
        'degraded', 'NOT_CONVERGED', { cause: 'publish_assert', check: 'INV-MASK', paths: ['a.txt'], causes: [{ cause: 'publish_assert', check: 'INV-MASK' }] }, ['a.txt'],
      ]);
      assert.equal(logOf(p).lines.filter((l) => l.code === 'NOT_CONVERGED' && l.params['cause'] === 'publish_assert' && l.params['check'] === 'INV-MASK' && l.params['path'] === 'a.txt').length, 1);
    } finally {
      Reflect.deleteProperty(p.engine, 'sPubHolds');
    }
    // The next iterations pass the check: the path leaves not_converged, is captured and publishes.
    await fx.rounds(4);
    const s2 = await statusOf(p);
    assert.deepEqual([s2.state, s2.pending.not_converged], ['ok', []]);
    assert.equal((await remoteLiveFiles(fx, p)).get('a.txt'), 'mine\n');
  });
});

test('NOT_CONVERGED carries each cause with its 01-engine §2 qualifier: an incoming change over an ignored local file is not_applicable with guard collision', async () => {
  const files = { '.gitignore': buf('.env\n'), 'README.md': buf('# nc\n'), 'a.txt': buf('a\n') };
  await withEngines('loop-nc-collision', { n: 1, files }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    await fx.rounds(2);
    // An ignored local .env, then a teammate commits a .env of its own (and an ordinary change).
    await writeWork(p, '.env', 'LOCAL_SECRET=1\n');
    await fx.pushTeamChange({ '.env': buf('TEAM=1\n'), 'a.txt': buf('a2\n') });
    for (let i = 0; i < 12 && (await storedText(p, 'a.txt')) !== 'a2\n'; i++) await fx.rounds(1);
    assert.equal(await storedText(p, 'a.txt'), 'a2\n', 'the rest of the change applied');
    assert.deepEqual(await readWork(p, '.env'), buf('LOCAL_SECRET=1\n'), 'the local bytes untouched');
    const s = await statusOf(p);
    assert.deepEqual([s.state, s.message_code, s.message_params, s.pending.not_converged], [
      'degraded', 'NOT_CONVERGED', { cause: 'not_applicable', guard: 'collision', paths: ['.env'], causes: [{ cause: 'not_applicable', guard: 'collision' }] }, ['.env'],
    ]);
    assert.deepEqual((await p.engine.inspect()).notConvergedWhy, { '.env': { cause: 'not_applicable', guard: 'collision' } });
  });
});

test('a kept ambiguous push intent older than 60 s shows as not_converged push_unresolved (degraded), logged once per 10 min', async () => {
  await withEngines('loop-unresolved', { n: 1 }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    await fx.rounds(2);
    await writeWork(p, 'a.txt', 'mine\n');
    await fx.rounds(1);
    fx.advance(21_000);
    let failWalks = false;
    let pushes = 0;
    const restore = wrapGit(p, async (args, opts, inner) => {
      if (args[0] === 'push' && pushes === 0) {
        pushes += 1;
        // The push lands, a teammate lands right on top, and the report is lost (no status line).
        const real = await inner(args, opts);
        await fx.pushTeamChange({ 'team.txt': buf('t\n') });
        failWalks = true;
        return { ...failedResult(128), durationMs: real.durationMs };
      }
      if (failWalks && args[0] === 'rev-list' && args.includes('--max-count=10000') && args.some((a) => a.startsWith('^'))) return failedResult(128);
      return inner(args, opts);
    });
    const unresolvedLogs = (): number => logOf(p).lines.filter((l) => l.code === 'NOT_CONVERGED' && l.params['cause'] === 'push_unresolved').length;
    try {
      await p.engine.iterate();
      assert.equal(p.core.view!.intent.kind, 'push', 'the ambiguous intent is kept (the first-parent walk failed)');
      await fx.rounds(4);
      assert.equal(p.core.view!.intent.kind, 'push');
      assert.notEqual((await statusOf(p)).state, 'degraded', 'not before 60 s');
      assert.equal(unresolvedLogs(), 0);
      await fx.rounds(22);   // > 60 s
      const s = await statusOf(p);
      assert.deepEqual([s.state, s.message_code, s.message_params['cause']], ['degraded', 'NOT_CONVERGED', 'push_unresolved']);
      assert.ok(s.pending.not_converged.includes('a.txt'));
      assert.equal(unresolvedLogs(), 1);
      assert.equal(await readWork(p, 'team.txt'), null, 'apply stalls behind the intent (P2-PUSHINTENT-FIRST)');
      fx.advance(5 * 60_000);
      await p.engine.iterate();
      assert.equal(unresolvedLogs(), 1, 'at most once per 10 min');
      fx.advance(5 * 60_000 + 1_000);
      await p.engine.iterate();
      assert.equal(unresolvedLogs(), 2);
      // The walk works again: the intent resolves as landed, the apply follows.
      failWalks = false;
      await fx.rounds(6);
      assert.equal(p.core.view!.intent.kind, 'none');
      assert.equal(await storedText(p, 'team.txt'), 't\n');
      assert.equal((await statusOf(p)).state, 'ok');
    } finally {
      restore();
    }
  });
});

/**
 * The boards the remote log shows for the board ref whose live code tree held `path` (fetched first, so every board on
 * the tip's first-parent chain is readable in the peer's repo).
 */
async function boardsHolding(fx: EngineFixture, p: PeerFixture, path: string): Promise<string[]> {
  await p.core.fetcher.fetch(true);
  const repo = p.core.repo;
  const out: string[] = [];
  for (const e of await fx.remote.readRemoteLog()) {
    if (e.ref !== p.core.refs.remoteBoard || /^0+$/.test(e.new)) continue;
    const live = await liveOf(p, e.new as Oid);
    if ((await repo.readTreeMap((await repo.readCommit(live)).tree)).has(path)) out.push(e.new);
  }
  return out;
}

/** Rounds until a tick observed the deletion of `path` (the delete CS opened), then its 20 s quiet period and the round that closes it. */
async function deleteCsClosed(fx: EngineFixture, p: PeerFixture, path: string): Promise<void> {
  for (let i = 0; i < 8 && !p.core.cs.openPaths().has(path); i++) await fx.rounds(1);
  assert.ok(p.core.cs.openPaths().has(path), `a tick observed the deletion of ${path}`);
  fx.advance(21_000);
  await fx.rounds(1);
}

/** A push that lands on the server while the client sees no report, with walks that fail until `walks.fail` is cleared. */
function ambiguousLandingPush(fx: EngineFixture, p: PeerFixture): { walks: { fail: boolean }; restore: () => void } {
  const walks = { fail: false };
  let pushes = 0;
  const restore = wrapGit(p, async (args, opts, inner) => {
    if (args[0] === 'push' && pushes === 0) {
      pushes += 1;
      // The push lands, a teammate lands right on top (only a first-parent walk can find Bnew), the report is lost.
      const real = await inner(args, opts);
      await fx.pushTeamChange({ 'team.txt': buf('t\n') });
      walks.fail = true;
      return { ...failedResult(128), durationMs: real.durationMs };
    }
    if (walks.fail && args[0] === 'rev-list' && args.includes('--max-count=10000') && args.some((a) => a.startsWith('^'))) return failedResult(128);
    return inner(args, opts);
  });
  return { walks, restore };
}

test('Task 19 ruling (round 3): the user deletes the file an ambiguous push created, the delete CS closes behind the kept intent (the pair it names is not shrunk), the intent resolves landed: the file stays absent on disk and its deletion is published', async () => {
  await withEngines('loop-kept-landed', { n: 1 }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    await fx.rounds(2);
    await writeWork(p, 'made.txt', 'made here\n');
    await fx.rounds(1);
    fx.advance(21_000);
    const { walks, restore } = ambiguousLandingPush(fx, p);
    try {
      await p.engine.iterate();
      const intent = p.core.view!.intent;
      assert.equal(intent.kind, 'push', 'the ambiguous intent is kept (the first-parent walk failed)');
      const X = p.core.cs.ready().find((r) => r.paths.includes('made.txt'));
      assert.ok(X !== undefined && intent.kind === 'push' && intent.cs_ids.includes(X.csId), 'the kept intent names the pair that created made.txt');

      await rm(workPath(p, 'made.txt'));
      await deleteCsClosed(fx, p, 'made.txt');
      assert.equal(p.core.view!.intent.kind, 'push', 'still kept');
      assert.deepEqual(p.core.cs.ready().map((r) => [r.csId, r.paths]), [[X.csId, ['made.txt']]], 'the pair the kept intent names is not shrunk');
      assert.ok(p.core.cs.openPaths().has('made.txt'), 'the vanished path waits in pending');
      assert.equal(await readWork(p, 'made.txt'), null);

      walks.fail = false;    // the walk works again: the intent resolves as landed
      for (let i = 0; i < 20 && p.core.view!.intent.kind === 'push'; i++) {
        await fx.rounds(1);
        assert.equal(await readWork(p, 'made.txt'), null, `round ${i}: the local deletion is never reverted by the apply`);
      }
      assert.equal(p.core.view!.intent.kind, 'none', 'the intent resolved');
      await quiesce(fx, { k: 6, maxRounds: 80 });
      assert.equal(await readWork(p, 'made.txt'), null, 'made.txt stays absent on disk');
      assert.equal(await storedText(p, 'team.txt'), 't\n', 'the teammate change applied');
      const files = await remoteLiveFiles(fx, p);
      assert.equal(files.has('made.txt'), false, 'the deletion is published');
      assert.equal(files.get('team.txt'), 't\n');
      assert.deepEqual(p.core.cs.ready(), []);
      assert.equal(p.core.cs.openPaths().size, 0);
    } finally {
      restore();
    }
  });
});

test('Task 19 ruling (round 3): the same deletion behind a kept intent whose push never reached the server: once the intent resolves (not landed) the deferred path re-closes before any publish, so the created-then-deleted file is never published', async () => {
  await withEngines('loop-kept-lost', { n: 1 }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    await fx.rounds(2);
    await writeWork(p, 'made.txt', 'made here\n');
    await fx.rounds(1);
    fx.advance(21_000);
    let phase: 'push' | 'blind' | 'off' = 'push';
    const restore = wrapGit(p, async (args, opts, inner) => {
      if (phase === 'push' && args[0] === 'push') {
        phase = 'blind';
        return failedResult(-1, 'error: killed\n');   // the server never got it; the client sees no report
      }
      if (phase === 'blind' && (args[0] === 'fetch' || args[0] === 'ls-remote')) return failedResult(128, 'fatal: unable to access the remote\n');
      return inner(args, opts);
    });
    try {
      await p.engine.iterate();
      const intent = p.core.view!.intent;
      assert.equal(intent.kind, 'push', 'the unobserved attempt keeps its intent');
      const X = p.core.cs.ready().find((r) => r.paths.includes('made.txt'));
      assert.ok(X !== undefined && intent.kind === 'push' && intent.cs_ids.includes(X.csId));

      await rm(workPath(p, 'made.txt'));
      await deleteCsClosed(fx, p, 'made.txt');
      assert.equal(p.core.view!.intent.kind, 'push', 'still kept (the remote is unreachable)');
      assert.deepEqual(p.core.cs.ready().map((r) => [r.csId, r.paths]), [[X.csId, ['made.txt']]], 'the pair the kept intent names is not shrunk');
      assert.ok(p.core.cs.openPaths().has('made.txt'));

      phase = 'off';
      fx.advance(6 * 60_000);   // past the fetch backoff and the push window of the failed attempt
      for (let i = 0; i < 40 && p.core.view!.intent.kind === 'push'; i++) await fx.rounds(1);
      assert.equal(p.core.view!.intent.kind, 'none', 'the intent resolved (not landed: discarded)');
      await quiesce(fx, { k: 6, maxRounds: 80 });
      assert.deepEqual(await boardsHolding(fx, p, 'made.txt'), [], 'no published board ever held made.txt');
      assert.equal(await readWork(p, 'made.txt'), null);
      assert.deepEqual(p.core.cs.ready(), [], 'the pair, which only created made.txt, left');
      assert.equal(p.core.cs.openPaths().size, 0);
    } finally {
      restore();
    }
  });
});

/**
 * Final review FD (Task 19 round-3 residual): the round-3 'loop-kept-lost' scenario up to the closed delete CS (made.txt
 * created, captured into X, X's push unobserved and its intent kept, made.txt deleted, the vanished path waiting in
 * pending), then the daemon dies (pending is not journaled) and starts again. `atRestart`: the remote is reachable (ENG-53
 * resolves the intent: not landed) or still unreachable (the intent stays kept; the loop resolves it later).
 */
async function keptLostRestart(atRestart: 'reachable' | 'unreachable'): Promise<void> {
  await withEngines(`loop-kept-lost-restart-${atRestart}`, { n: 1 }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    await fx.rounds(2);
    await writeWork(p, 'made.txt', 'made here\n');
    await fx.rounds(1);
    fx.advance(21_000);
    let phase: 'push' | 'blind' | 'off' = 'push';
    const restore = wrapGit(p, async (args, opts, inner) => {
      if (phase === 'push' && args[0] === 'push') {
        phase = 'blind';
        return failedResult(-1, 'error: killed\n');   // the server never got it; the client sees no report
      }
      if (phase === 'blind' && (args[0] === 'fetch' || args[0] === 'ls-remote')) return failedResult(128, 'fatal: unable to access the remote\n');
      return inner(args, opts);
    });
    // What the restart left (asserted after the consequence, so a regression shows the published creation first).
    let atRestartState: { inPairs: boolean; inJournal: boolean; pending: boolean } | null = null;
    try {
      await p.engine.iterate();
      const intent = p.core.view!.intent;
      assert.equal(intent.kind, 'push', 'the unobserved attempt keeps its intent');
      const X = p.core.cs.ready().find((r) => r.paths.includes('made.txt'));
      assert.ok(X !== undefined && intent.kind === 'push' && intent.cs_ids.includes(X.csId), 'the kept intent names the pair that created made.txt');

      await rm(workPath(p, 'made.txt'));
      await deleteCsClosed(fx, p, 'made.txt');
      assert.equal(p.core.view!.intent.kind, 'push', 'still kept (the remote is unreachable)');
      assert.deepEqual(p.core.cs.ready().map((r) => [r.csId, r.paths]), [[X.csId, ['made.txt']]], 'the pair the kept intent names is not shrunk');
      assert.ok(p.core.cs.openPaths().has('made.txt'), 'the vanished path waits in pending (memory only)');
      // No apply ran since made.txt was created, so state:snap never held it: the restart's reseeded private index lacks
      // it like the disk does, and no tick after the restart can observe it again.
      assert.equal((await p.core.repo.readTreeMap(p.core.view!.snap)).has('made.txt'), false, 'state:snap lacks made.txt');

      // The daemon dies (its open CS and pending with it) and is started again: ENG-53 resolves the kept intent by
      // observation first (not landed: discarded; or, the remote still unreachable, kept), then R-01 re-forms the CS.
      if (atRestart === 'reachable') phase = 'off';
      const fresh = await Engine.create(p.deps);
      p.core = fresh.core;
      p.engine = fresh;
      const r = await fresh.start({ publishLocal: null });
      assert.ok(r.ok && r.mode === 'restart', JSON.stringify(r));
      assert.equal(await readWork(p, 'made.txt'), null);
      if (atRestart === 'reachable') {
        assert.equal(r.restart?.pushResolved, 'discarded', 'the restart resolved the kept intent: not landed');
        assert.equal(p.core.view!.intent.kind, 'none');
        atRestartState = { inPairs: p.core.cs.ready().some((x) => x.paths.includes('made.txt')), inJournal: p.core.view!.ready.some((x) => x.paths.includes('made.txt')), pending: p.core.cs.openPaths().has('made.txt') };
      } else {
        assert.equal(r.restart?.pushResolved, null, 'unresolved: the remote is still unreachable');
        assert.equal(p.core.view!.intent.kind, 'push', 'the intent stays kept');
        atRestartState = { inPairs: p.core.cs.ready().some((x) => x.csId === X.csId && x.paths.includes('made.txt')), inJournal: p.core.view!.ready.some((x) => x.paths.includes('made.txt')), pending: p.core.cs.openPaths().has('made.txt') };
        phase = 'off';
        fx.advance(6 * 60_000);   // past the fetch backoff and the push window of the failed attempt
        for (let i = 0; i < 40 && p.core.view!.intent.kind === 'push'; i++) await fx.rounds(1);
        assert.equal(p.core.view!.intent.kind, 'none', 'the loop resolved the intent (not landed: discarded)');
      }
    } finally {
      restore();
    }

    await quiesce(fx, { k: 6, maxRounds: 80 });
    assert.deepEqual(await boardsHolding(fx, p, 'made.txt'), [], 'no published board ever held made.txt');
    assert.equal(await readWork(p, 'made.txt'), null, 'made.txt stays absent on disk');
    assert.deepEqual(p.core.cs.ready(), [], 'the pair, which only created made.txt, left');
    assert.equal(p.core.cs.openPaths().size, 0);
    // The mechanism. Reachable: the restart itself dropped made.txt from its pair and journaled the pairs. Unreachable: the
    // pair the still-kept intent names stays whole, and made.txt waits in pending again (re-closed once the loop resolved
    // the intent: loop.ts's capture right after the discard).
    assert.deepEqual(atRestartState, atRestart === 'reachable'
      ? { inPairs: false, inJournal: false, pending: false }
      : { inPairs: true, inJournal: true, pending: true }, 'the ready pairs and pending right after the restart');
  });
}

for (const atRestart of ['reachable', 'unreachable'] as const) {
  test(`final review FD (Task 19 round-3 residual): the deletion waits in pending behind a kept push intent and the daemon dies (pending is not journaled); restarted with the remote ${atRestart}, the R-01 re-form drops the created-then-deleted path from the ready pair (${atRestart === 'reachable' ? 'the restart resolved the intent: not landed' : 'the intent still kept: the path waits in pending again until the loop resolves it'}) before any publish, so the creation is never published`, async () => {
    await keptLostRestart(atRestart);
  });
}

test('recover runs inside the running daemon as a request serialized with its iterations, and only while daemon.lock is held', async () => {
  await withEngines('loop-recover', { n: 1 }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    await fx.rounds(2);
    // The board ref vanishes from the remote: INCIDENT (board_missing).
    const boardBefore = (await remoteBoardTip(fx)) as Oid;
    const laC = p.core.view!.laC;
    await forceRemote(fx, p, p.core.refs.remoteBoard, null);
    await fx.rounds(1);
    assert.ok(p.core.view!.meta.freeze_reasons.includes('INCIDENT'));
    const inc = await statusOf(p);
    // 01-engine §2 INCIDENT{n, old oids, observed oids (absent), displaced ref or kept_local}.
    assert.deepEqual([inc.state, inc.message_code], ['incident', 'INCIDENT']);
    assert.deepEqual(
      { ...inc.message_params, displaced: typeof inc.message_params['displaced'] },
      { n: 1, why: 'board_missing', old_board: boardBefore, old_code: laC, new_board: null, new_code: null, displaced: 'string' },
      JSON.stringify(inc.message_params),
    );

    const log: string[] = [];
    let release!: () => void;
    let gate: Promise<void> | null = new Promise<void>((r) => { release = r; });
    const restore = wrapGit(p, async (args, opts, inner) => {
      if (args[0] === 'fetch' || args[0] === 'ls-remote') {
        log.push(args[0]);
        if (gate !== null) {
          const g = gate;
          gate = null;
          await g;
        }
      }
      return inner(args, opts);
    });
    const emit = fx.trace.emit.bind(fx.trace);
    fx.trace.emit = (ev) => {
      if (ev.kind === 'iteration') log.push('iteration');
      emit(ev);
    };
    try {
      fx.advance(3_000);
      const it = p.engine.iterate();
      while (log.length === 0) await sleepReal(5);
      const rec = p.engine.recover(null);
      await sleepReal(200);
      assert.deepEqual(log, ['fetch'], 'the recover request waits for the iteration in flight');
      release();
      await it;
      const r = await rec;
      assert.ok(r.ok, JSON.stringify(r));
      assert.equal(r.done, false, 'no --confirm: a preview');
      assert.match(r.preview.id, /^[0-9a-f]{6}$/);
      const at = log.indexOf('iteration');
      assert.ok(at > 0 && at < log.length - 1, `the recover request's network calls all follow the iteration: ${log.join(',')}`);
    } finally {
      restore();
      fx.trace.emit = emit;
    }

    // A held lock is never acquired twice; without daemon.lock neither recover nor resume runs.
    const again = await DaemonLock.acquire(p.deps.ports.fs, p.deps.paths.coworkDir, { pluginVersion: PLUGIN_VERSION, instance: 'other' });
    assert.ok(!(again instanceof DaemonLock), 'a held lock is not acquired twice');
    const lockFile = join(p.deps.paths.coworkDir, 'daemon.lock');
    const held = await readFile(lockFile);
    await rm(lockFile);
    assert.equal(await daemonLockHeld(p.deps.ports.fs, p.deps.paths.coworkDir), false);
    await assert.rejects(p.engine.recover(null), /daemon\.lock/);
    await assert.rejects(p.engine.resumeAfterNonretryable(), /daemon\.lock/);
    await writeFile(lockFile, held);
    assert.equal(await daemonLockHeld(p.deps.ports.fs, p.deps.paths.coworkDir), true);

    // The incident heals by itself (the board ref is back where LA_B is): ok with UNFROZEN{reasons: [INCIDENT]}, never
    // the INCIDENT code in an ok status.
    await forceRemote(fx, p, p.core.refs.remoteBoard, boardBefore);
    fx.advance(3_000);
    await p.engine.iterate();
    assert.deepEqual(p.core.view!.meta.freeze_reasons, [], 'healed');
    const healed = await statusOf(p);
    assert.deepEqual([healed.state, healed.message_code, healed.message_params], ['ok', 'UNFROZEN', { reasons: ['INCIDENT'] }]);
    assert.ok(logOf(p).lines.some((l) => l.code === 'UNFROZEN' && l.params['reasons'] === '["INCIDENT"]'), 'logged');
  });
});

/** Final review FC-2/FC-4: one human CS on `path` captured by the loop (the publish of that iteration is the test's to watch). */
async function loopCapture(fx: EngineFixture, p: PeerFixture, path: string, text: string): Promise<void> {
  await writeWork(p, path, text);
  await fx.rounds(1);
  fx.advance(21_000);
}

test('final review FC-2/FC-4: a publish_assert abort inside publishStep (ENG-39 a_cap, every window) shows in status as NOT_CONVERGED{publish_assert, check: a_cap} on its path until a publish lands, and the loop never re-iterates sooner than its period', async () => {
  await withEngines('loop-fc2-acap', { n: 1 }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    await fx.rounds(2);
    await loopCapture(fx, p, 'a.txt', 'mine\n');
    // An A_cap mismatch a rebase bug left: composeP refuses every window (ENG-39), before any window or build.
    const cs = p.core.cs;
    Reflect.set(cs, 'composeP', async (): Promise<never> => {
      throw new ReadyBaseMismatchError('a.txt');
    });
    const dues: number[] = [];
    try {
      for (let i = 0; i < 6; i++) {
        const r = await p.engine.iterate();
        dues.push(r.nextDueMs);
        assert.equal(r.pushAttempts, 0, 'nothing is pushed');
        fx.advance(Math.max(r.nextDueMs, 1));
      }
      assert.equal(p.core.cs.ready().length, 1, 'the ready pair waits');
      assert.ok(dues.every((d) => d >= LOOP_ACTIVE_MS), `no hot loop: nextDueMs ${dues.join(',')}`);
      const s = await statusOf(p);
      // 01-engine §2: NOT_CONVERGED{cause: publish_assert, check: <letter>}.
      assert.deepEqual([s.state, s.message_code, s.message_params, s.pending.not_converged], [
        'degraded', 'NOT_CONVERGED', { cause: 'publish_assert', check: 'a_cap', paths: ['a.txt'], causes: [{ cause: 'publish_assert', check: 'a_cap' }] }, ['a.txt'],
      ]);
      assert.deepEqual((await p.engine.inspect()).notConvergedWhy, { 'a.txt': { cause: 'publish_assert', check: 'a_cap' } });
    } finally {
      Reflect.deleteProperty(cs, 'composeP');
    }
    // The check passes again: the pair publishes and the path leaves not_converged.
    await fx.rounds(3);
    const s2 = await statusOf(p);
    assert.deepEqual([s2.state, s2.pending.not_converged], ['ok', []]);
    assert.equal((await remoteLiveFiles(fx, p)).get('a.txt'), 'mine\n');
  });
});

test('final review FC-2: an ENG-41 letter that names no path (d: Bnew is not a commit) lists every path the publish would carry as NOT_CONVERGED{publish_assert, check: d}, until a publish lands', async () => {
  await withEngines('loop-fc2-pathless', { n: 1 }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    await fx.rounds(2);
    await loopCapture(fx, p, 'a.txt', 'mine\n');
    // ENG-41 (d): the board commit git wrote does not read back as a commit (the engine's only hasObject(Bnew, 'commit')).
    const repo = p.core.repo;
    const orig = repo.hasObject.bind(repo);
    Reflect.set(repo, 'hasObject', async (oid: Oid, type: Parameters<typeof orig>[1]): Promise<boolean> => {
      if (type === 'commit' && (await orig(oid, 'commit')) && (await repo.readCommit(oid)).subject === BOARD_SUBJECT) return false;
      return orig(oid, type);
    });
    try {
      const r = await p.engine.iterate();
      assert.equal(r.pushAttempts, 0, 'nothing is pushed');
      assert.ok(logOf(p).lines.some((l) => l.code === 'NOT_CONVERGED' && l.params['cause'] === 'publish_assert' && l.params['check'] === 'd'), 'the publish aborted with ENG-41 (d)');
      const s = await statusOf(p);
      assert.deepEqual([s.state, s.message_code, s.message_params, s.pending.not_converged], [
        'degraded', 'NOT_CONVERGED', { cause: 'publish_assert', check: 'd', paths: ['a.txt'], causes: [{ cause: 'publish_assert', check: 'd' }] }, ['a.txt'],
      ]);
    } finally {
      Reflect.deleteProperty(repo, 'hasObject');
    }
    await fx.rounds(3);
    const s2 = await statusOf(p);
    assert.deepEqual([s2.state, s2.pending.not_converged], ['ok', []]);
    assert.equal((await remoteLiveFiles(fx, p)).get('a.txt'), 'mine\n');
  });
});

test('final review FC-4: while a ready pair waits and nothing but the window could publish it — .git/index.lock held, or an INV-MASK violation every iteration — the loop re-iterates no sooner than its period', async () => {
  await withEngines('loop-fc4-spin', { n: 1 }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    await fx.rounds(2);
    // One ready pair journaled (captured outside the loop), then the window ages past its opening.
    await writeWork(p, 'README.md', 'edited by the human\n');
    await prep(p);
    fx.advance(20_000);
    await captureReady(p, await prep(p, true));
    fx.advance(30_000);
    assert.equal(p.core.cs.ready().length, 1);

    // (a) a human `git commit` with its editor open: .git/index.lock held (ENG-15: fetch and fold only).
    const lock = join(p.deps.paths.gitDir, 'index.lock');
    await writeFile(lock, '');
    const lockDues: number[] = [];
    try {
      for (let i = 0; i < 6; i++) {
        const r = await p.engine.iterate();
        lockDues.push(r.nextDueMs);
        fx.advance(Math.max(r.nextDueMs, 1));
      }
    } finally {
      await rm(lock, { force: true });
    }
    assert.ok(lockDues.every((d) => d >= LOOP_ACTIVE_MS), `index.lock: nextDueMs ${lockDues.join(',')}`);
    assert.equal(p.core.cs.ready().length, 1, 'the ready pair waited under index.lock');

    // (b) a second human CS (observed outside the loop, so the waiting pair is not published meanwhile) due at every
    // iteration, whose S_pub fails INV-MASK (ENG-28: no capture, no publish).
    await writeWork(p, 'src/b.txt', 'b edited\n');
    await prep(p);
    fx.advance(21_000);
    Reflect.set(p.engine, 'sPubHolds', async (): Promise<MaskViolation> => ({ path: 'src/b.txt', check: 'INV-MASK' }));
    const maskDues: number[] = [];
    try {
      for (let i = 0; i < 6; i++) {
        const r = await p.engine.iterate();
        maskDues.push(r.nextDueMs);
        assert.equal(r.pushAttempts, 0);
        fx.advance(Math.max(r.nextDueMs, 1));
      }
    } finally {
      Reflect.deleteProperty(p.engine, 'sPubHolds');
    }
    assert.ok(maskDues.every((d) => d >= LOOP_ACTIVE_MS), `INV-MASK: nextDueMs ${maskDues.join(',')}`);
    assert.equal(p.core.cs.ready().length, 1, 'the ready pair still waits');
  });
});


test('final review FC-4: a ready pair that waits only for its window still re-iterates when the governor says the window opens (sooner than the period)', async () => {
  await withEngines('loop-fc4-window', { n: 1 }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    await fx.rounds(2);
    await loopCapture(fx, p, 'a.txt', 'mine\n');
    // The window is closed (publishStep: skipped 'window') and the governor says it opens in 700 ms.
    const gov = p.core.governor;
    Reflect.set(gov, 'mayAttempt', (): boolean => false);
    Reflect.set(gov, 'msUntilWindow', (): number => 700);
    try {
      const r = await p.engine.iterate();
      assert.equal(r.pushAttempts, 0);
      assert.equal(p.core.cs.ready().length, 1, 'the pair waits for its window');
      assert.equal(r.nextDueMs, 700, 'the next iteration runs when the window opens');
    } finally {
      Reflect.deleteProperty(gov, 'mayAttempt');
      Reflect.deleteProperty(gov, 'msUntilWindow');
    }
  });
});

test('final review FC-5: resume after NONRETRYABLE ends the host-reject PIN (05-holds: lifted by resume, the publish is retried), so the next iterations retry the rejected publish once and it lands', async () => {
  await withEngines('loop-fc5-resume', { n: 1 }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    await fx.rounds(2);
    await fx.remote.rejectNext(3, 'policy', '/board');
    await writeWork(p, 'a.txt', 'rejected, then resumed\n');
    for (let i = 0; i < 120 && p.core.view!.meta.nonretryable === null; i++) {
      fx.advance(LOOP_ACTIVE_MS);
      await p.engine.iterate();
    }
    const nonretryable = p.core.view!.meta.nonretryable;
    assert.ok(nonretryable !== null, 'NONRETRYABLE after the third rejection');
    const pin = p.core.holds.get(nonretryable.hold_id)!;
    assert.deepEqual([pin.kind, pin.state, pin.guards.map((g) => g.name), pin.paths], ['PIN', 'ACTIVE', ['host-reject'], ['a.txt']]);
    const pushes = p.core.pushAttempts;
    await fx.rounds(4);
    assert.equal(p.core.pushAttempts, pushes, 'paused: no attempt while NONRETRYABLE');

    assert.equal(await p.engine.resumeAfterNonretryable(), true);
    assert.deepEqual([p.core.view!.meta.nonretryable, p.core.view!.meta.rejections], [null, null]);
    assert.equal(p.core.cs.ready().length, 1, 'the rejected change-set is still journaled');

    // The retry: the change-set's code (with R-27's queued `event{kind: nonretryable}`) in one attempt.
    let landedAt = -1;
    for (let i = 0; i < 60 && landedAt < 0; i++) {
      fx.advance(LOOP_ACTIVE_MS);
      await p.engine.iterate();
      if (p.core.cs.ready().length === 0) landedAt = p.core.pushAttempts;
    }
    assert.ok(landedAt >= 0, `the rejected change-set was retried and published (attempts since the pause: ${p.core.pushAttempts - pushes})`);
    assert.equal(landedAt - pushes, 1, 'one retry');
    assert.equal((await remoteLiveFiles(fx, p)).get('a.txt'), 'rejected, then resumed\n');
    const ended = p.core.holds.get(nonretryable.hold_id)!;
    assert.deepEqual([ended.state, ended.residence], ['RESOLVED_PUBLISH', null], 'the host-reject PIN ended');
    assert.ok(!p.core.holds.nonTerminal().some((r) => r.id === nonretryable.hold_id));
    const s = await statusOf(p);
    assert.deepEqual([s.state, s.pending.not_converged], ['ok', []]);
  });
});

test('final review FC-8: --publish=all local work at genesis goes through the loop\'s step 4: a canon-refused (mixed EOL) path gets its eol-bom hold and its raw bytes are never published', async () => {
  const files = { 'README.md': buf('# eol at start\n'), 'mixed.txt': buf('a\r\nb\nc\r\nd\n') };
  await withEngines('loop-fc8-start-all', { n: 1, files }, async (fx) => {
    const p = fx.peers[0]!;
    // Local work before the first start: a matched row's ending changes in a MIXED file (canon refuses, R-07), and an
    // ordinary edit that publishes.
    await writeWork(p, 'mixed.txt', 'a\nb\nc\nd\nE\n');
    await writeWork(p, 'README.md', '# eol at start, edited\n');
    await fx.startAll({ publishLocal: 'all' });
    for (let i = 0; i < 8 && (await remoteLiveFiles(fx, p)).get('README.md') !== '# eol at start, edited\n'; i++) await fx.rounds(1);
    assert.equal((await remoteLiveFiles(fx, p)).get('README.md'), '# eol at start, edited\n', 'the local work published');
    assert.equal((await remoteLiveFiles(fx, p)).get('mixed.txt'), 'a\r\nb\nc\r\nd\n', 'nothing of the refused bytes is published');
    const recs = p.core.holds.nonTerminal().filter((r) => r.paths.includes('mixed.txt') && r.guards.some((g) => g.name === 'eol-bom'));
    assert.equal(recs.length, 1, 'one eol-bom hold masks the refused path');
    assert.equal((await readWork(p, 'mixed.txt'))?.toString('utf8'), 'a\nb\nc\nd\nE\n', 'the local bytes stay on disk');
  });
});

test('final review FC-8: --publish=all local work is captured by the start itself (through step 4), so its change-set holds what was on disk then: an edit made after the start, before the first iteration, forms its own change-set with its own quiet period', async () => {
  const files = { 'README.md': buf('# start boundary\n'), 'a.txt': buf('a v0\n') };
  await withEngines('loop-fc8-boundary', { n: 1, files }, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, 'README.md', '# start boundary, local\n');
    await fx.startAll({ publishLocal: 'all' });
    assert.deepEqual(p.core.cs.ready().map((x) => x.paths), [['README.md']], 'M is captured at the start');
    await writeWork(p, 'a.txt', 'a edited after the start\n');
    fx.advance(2_500);
    await p.engine.iterate();
    assert.ok(!p.core.cs.ready().some((x) => x.paths.includes('a.txt')), 'the later edit is in no ready pair after one iteration');
    assert.ok(p.core.cs.openPaths().has('a.txt'), 'it is in an open change-set of its own');
  });
});
