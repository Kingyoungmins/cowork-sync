// A peer cut off from the remote (Review Focus 3; 01-engine §3.6, ENG-19, tests 23 (network part) and 49; glossary §25.2
// item 4). Real git: the remote is renamed away, or one peer's network calls fail the way an unreachable host fails
// (exit 128, nothing on stdout); git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { StatusJson } from '../../src/engine/status.js';
import { OFFLINE_AFTER_MS } from '../../src/engine/fetcher.js';
import { writeWork, type PeerFixture } from '../helpers/coreFixture.js';
import { assertConverged, logOf, quiesce, storedText, withEngines } from '../helpers/engineFixture.js';
import { failedResult, wrapGit } from '../helpers/publishHelpers.js';

async function statusOf(p: PeerFixture): Promise<StatusJson> {
  return JSON.parse((await readFile(join(p.deps.paths.coworkDir, 'status.json'))).toString('utf8')) as StatusJson;
}

test('offline_for_s grows with Δmono in status.json while the remote is unreachable', async () => {
  await withEngines('partition-offline', { n: 1 }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    await fx.rounds(2);
    const lastOk = p.core.fetcher.lastSuccessMono()!;
    const away = `${fx.remote.dir}.away`;
    await rename(fx.remote.dir, away);
    try {
      let prev = -1;
      let sawOffline = false;
      for (let i = 0; i < 40; i++) {
        fx.advance(5_000);
        await p.engine.iterate();
        const s = await statusOf(p);
        const since = p.clock.monoMs() - lastOk;
        if (since <= OFFLINE_AFTER_MS) {
          assert.notEqual(s.state, 'offline', `not offline after ${since} ms`);
          continue;
        }
        assert.deepEqual([s.state, s.publish_pause, s.message_code], ['offline', 'OFFLINE', 'OFFLINE'], `after ${since} ms`);
        const forS = s.message_params['offline_for_s'] as number;
        assert.equal(forS, Math.floor(since / 1_000), 'offline_for_s is the local Δmono since the last successful fetch');
        assert.ok(forS > prev, 'it grows at every write');
        // SEC-18's explanation labels; Plan 2 does not classify the failure, so it names both.
        assert.deepEqual([s.message_params['label'], s.message_params['explanation']], ['OFFLINE', 'network-or-auth']);
        if (!sawOffline) {
          // R-27: the transition is an engine event in the daemon log once, with the same offline_for_s (one source).
          const lines = logOf(p).lines.filter((l) => l.code === 'OFFLINE');
          assert.equal(lines.length, 1, 'one OFFLINE event');
          assert.equal(lines[0]!.params['offline_for_s'], forS, 'the log and status.json read one offline_for_s');
        }
        sawOffline = true;
        prev = forS;
      }
      assert.ok(sawOffline);
    } finally {
      await rename(away, fx.remote.dir);
    }
    // Back online at the next allowed fetch (the backoff is ≤ 5 min).
    for (let i = 0; i < 70 && (await statusOf(p)).state !== 'ok'; i++) {
      fx.advance(5_000);
      await p.engine.iterate();
    }
    const s = await statusOf(p);
    assert.equal(s.state, 'ok');
    assert.ok(s.last_fetch_age_ms !== null && s.last_fetch_age_ms < 5_000);
    // The way back is the ONLINE engine event (R-27): in status.json and once in the daemon log.
    assert.deepEqual([s.message_code, s.message_params], ['ONLINE', {}]);
    assert.equal(logOf(p).lines.filter((l) => l.code === 'ONLINE').length, 1);
    assert.equal(logOf(p).lines.filter((l) => l.code === 'OFFLINE').length, 1);
  });
});

test('a peer cut off from the remote for 10 virtual minutes goes OFFLINE after 30 s, spaces fetches 30 s, 60 s, … ≤ 5 min, pushes nothing, keeps capturing; after reconnect it fetches, checks, folds, applies and publishes once; everything converges', async () => {
  const files = { 'README.md': Buffer.from('# partition\n'), 'p1.txt': Buffer.from('p1\n'), 'p2.txt': Buffer.from('p2\n'), 'p3.txt': Buffer.from('p3\n') };
  await withEngines('partition-10min', { n: 3, files }, async (fx) => {
    await fx.startAll();
    await fx.rounds(3);
    const [p1, p2, p3] = fx.peers as [typeof fx.peers[0], typeof fx.peers[0], typeof fx.peers[0]];
    const attempts: number[] = [];
    let cut = true;
    const restore = wrapGit(p3, async (args, opts, inner) => {
      if (opts.class !== 'network') return inner(args, opts);
      if (args[0] === 'fetch') attempts.push(p3.clock.monoMs());
      return cut ? failedResult(128, "fatal: unable to access 'remote': Could not resolve host\n") : inner(args, opts);
    });
    try {
      const t0 = p3.clock.monoMs();
      const pushes3 = p3.core.pushAttempts;
      const mark = fx.trace.events.length;
      await writeWork(p1, 'p1.txt', 'p1 edited during the partition\n');
      await writeWork(p2, 'p2.txt', 'p2 edited during the partition\n');
      await writeWork(p3, 'p3.txt', 'p3 edited offline\n');
      // Rounds of 5 s for the cut-off peer; the other two iterate every round for the first minute (their edits publish
      // and cross), then every 20 s (idle peers: their loop period is 10 s, so 20 s is no suspend gap).
      let offlineAt: number | null = null;
      for (let round = 1; p3.clock.monoMs() - t0 < 600_000; round++) {
        fx.advance(5_000);
        if (round <= 12 || round % 4 === 0) {
          await p1.engine.iterate();
          await p2.engine.iterate();
        }
        await p3.engine.iterate();
        if (offlineAt === null && (await statusOf(p3)).state === 'offline') offlineAt = p3.clock.monoMs() - t0;
      }
      assert.ok(offlineAt !== null && offlineAt > 30_000 && offlineAt <= 40_000, `OFFLINE after 30 s (at ${String(offlineAt)} ms)`);
      assert.equal(p3.core.pushAttempts, pushes3, 'no push of any kind while offline');
      assert.equal(p3.core.cs.ready().length, 1, 'the offline edit is captured');
      // Network backoff 30 s doubling to 5 min, measured between attempt starts (rounds of 5 s).
      const gaps = attempts.slice(1).map((t, i) => t - attempts[i]!);
      const want = [30_000, 60_000, 120_000, 240_000];
      assert.ok(gaps.length >= 4, `fetch attempts at ${attempts.map((t) => t - t0).join(', ')}`);
      for (let i = 0; i < gaps.length; i++) {
        const w = want[i] ?? 300_000;
        assert.ok(gaps[i]! >= w && gaps[i]! <= w + 5_000, `gap ${i}: ${gaps[i]} ms, want ${w} ms (+ one round)`);
      }
      assert.ok(gaps.every((g) => g <= 305_000), 'never above 5 min');
      // The others kept syncing meanwhile.
      assert.equal(await storedText(p2, 'p1.txt'), 'p1 edited during the partition\n');
      assert.equal(await storedText(p3, 'p1.txt'), 'p1\n', 'nothing new is applied while offline');

      // Reconnect: the next allowed fetch (≤ 5 min later) runs the ordinary loop on the fetched tip, in the 01-engine §3.5
      // order: fetch (with its check and fold) → apply → publish → push.
      cut = false;
      const before = attempts.length;
      const reconnect = fx.trace.events.length;
      while (attempts.length === before) await fx.rounds(1, 5_000);
      for (let i = 0; i < 12 && !fx.trace.since(reconnect).some((e) => e.kind === 'push' && e.peer === p3.core.peerId); i++) await fx.rounds(1, 5_000);
      const own = fx.trace.since(reconnect).filter((e) => 'peer' in e && e.peer === p3.core.peerId);
      const firstOk = own.findIndex((e) => e.kind === 'fetch' && e.ok);
      const firstApply = own.findIndex((e) => e.kind === 'apply');
      const firstPublish = own.findIndex((e) => e.kind === 'publish');
      const firstPush = own.findIndex((e) => e.kind === 'push');
      const order = own.map((e) => e.kind).join(',');
      assert.ok(firstOk >= 0 && firstApply > firstOk && firstPublish > firstApply && firstPush > firstPublish, `fetch → apply → publish → push: ${order}`);
      assert.ok(!own.slice(0, firstOk).some((e) => e.kind === 'apply' || e.kind === 'publish' || e.kind === 'push'), `nothing before the fetch: ${order}`);
      const q = await quiesce(fx, { k: 20, maxRounds: 200 });
      const converged = await assertConverged(fx, q.tStar);
      assert.equal(converged.get('p3.txt'), 'p3 edited offline\n', 'no lost edit');
      assert.equal(converged.get('p1.txt'), 'p1 edited during the partition\n');
      assert.equal(converged.get('p2.txt'), 'p2 edited during the partition\n');
      const landed = fx.trace.since(mark).filter((e) => e.kind === 'push' && e.peer === p3.core.peerId && e.purpose === 'publish' && e.outcome === 'landed');
      assert.equal(landed.length, 1, 'published once');
      assert.equal(p3.core.pushAttempts - pushes3, fx.trace.since(mark).filter((e) => e.kind === 'push' && e.peer === p3.core.peerId && e.outcome !== 'denied').length);
    } finally {
      restore();
    }
  });
});
