// Incidents in the loop (01-engine §3.7; ENG-20, ENG-21; 01-engine tests 18 and 19; rulings R-21, R-23, R-27): a board
// rewound, rewritten, deleted or with a jumped last parent freezes every peer (FREEZE(INCIDENT), incident-<n>) with no
// apply and no board or code push; each detecting peer pushes one ABSENT-leased displaced copy of its LA_B in an
// ordinary window (none when 3 displaced refs exist); a missing or rewound mirror is never an incident. EngineCores over
// real clones of a file:// remote; git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rename } from 'node:fs/promises';
import { oid12, type Oid } from '../../src/git/oid.js';
import { incidentStatus } from '../../src/engine/recover.js';
import { startDispatch } from '../../src/engine/start.js';
import { gitCallsOf, readWork, type PeerFixture } from '../helpers/coreFixture.js';
import {
  boardOn, catchUp, forceRemote, inIncident, liveOf, liveOn, poll, pushSpawnsOf, remoteDisplaced,
} from '../helpers/incidentFixture.js';
import { buf, editAndCapture, LogRecorder, prep, withCores } from '../helpers/publishHelpers.js';
import { publishStep } from '../../src/engine/publish.js';
import { gitRemote, localCoworkRefs, restartCore } from '../helpers/startFixture.js';

const FILES: Record<string, Buffer> = {
  'README.md': buf('# incident fixture\n'),
  'x.txt': buf('x v0\n'),
  'y.txt': buf('y v0\n'),
};

/** The window wait after the detecting fetch moved the governor's anchor (G_eff = 5 s at budget 12; 10 s before any fold of the run). */
const PAST_WINDOW_MS = 11_000;

async function firstParent(p: PeerFixture, c: Oid): Promise<Oid> {
  return (await p.core.repo.readCommit(c)).parents[0]!;
}

type Corruption = 'rewound' | 'second_parent' | 'deleted' | 'jumped';
const EXPECTED_WHY: Record<Corruption, string> = { rewound: 'board_not_ff', second_parent: 'board_not_ff', deleted: 'board_missing', jumped: 'code_not_ff' };

test('a rewound board, a rewrite keeping the old chain as second parent, a deleted board and a jumped last parent each raise INCIDENT within 2 polls on every peer with zero applies and zero board or code pushes', async () => {
  for (const kind of ['rewound', 'second_parent', 'deleted', 'jumped'] as const) {
    await withCores(`incident-${kind}`, { n: 2, files: FILES }, async (fx) => {
      const p1 = fx.peers[0]!;
      const { board: B1 } = await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
      for (const p of fx.peers) await catchUp(fx, p);
      const B0 = await firstParent(p1, B1);
      const L0 = await liveOf(p1, B0);
      const board = p1.core.refs.remoteBoard;
      // The observed board, and the observed code (the check's TIP: the observed board's last parent; null when the
      // board is gone).
      let observed: Oid | null = null;
      let observedCode: Oid | null = null;
      if (kind === 'rewound') {
        observed = B0;
        observedCode = L0;
      } else if (kind === 'second_parent') {
        // A board-shaped commit whose first parent is B0 and whose second parent keeps the old chain (B1): a bare
        // ancestry test passes it, FP_OK does not. Its last parent is B1.
        observed = await p1.core.repo.commitTree({ tree: (await p1.core.repo.readCommit(B1)).tree, parents: [B0, B1], subject: (await p1.core.repo.readCommit(B1)).subject, trailers: [] });
        observedCode = B1;
      } else if (kind === 'jumped') {
        // 01-engine test 18: a board commit on B1 whose last parent jumps to a NON-DESCENDANT of LA_C (a live commit
        // forking from L0, beside L1).
        observedCode = await liveOn(p1, [L0]);
        observed = await boardOn(p1, B1, observedCode);
      }
      await forceRemote(fx, p1, board, observed);
      const remoteBefore = await fx.remote.refs();
      const traceFrom = fx.trace.events.length;
      const disk = await Promise.all(fx.peers.map((p) => readWork(p, 'x.txt')));

      for (const p of fx.peers) {
        let polls = 0;
        while (!inIncident(p) && polls < 2) {
          polls += 1;
          const r = await poll(p);
          if (r.incident) assert.equal(r.why, EXPECTED_WHY[kind], `${kind}: ${p.name}'s verdict`);
          fx.advance(2_500);
        }
        assert.ok(inIncident(p), `${kind}: ${p.name} is in INCIDENT within 2 polls`);
        assert.deepEqual(p.core.view!.meta.incident, { n: 1, observed_board: observed, observed_code: observedCode }, `${kind}: meta.incident`);
        assert.equal(p.core.view!.meta.incident_next, 2);
      }
      // More polls past the window: the displaced copy is the only push.
      for (let i = 0; i < 2; i++) {
        fx.advance(PAST_WINDOW_MS);
        for (const p of fx.peers) assert.equal((await poll(p)).incident, true, `${kind}: ${p.name} stays in INCIDENT`);
      }
      const events = fx.trace.since(traceFrom);
      assert.equal(events.filter((e) => e.kind === 'apply').length, 0, `${kind}: zero applies`);
      assert.equal(events.filter((e) => e.kind === 'A_set').length, 0, `${kind}: A never set`);
      assert.equal(events.filter((e) => e.kind === 'publish').length, 0, `${kind}: nothing composed for a publish`);
      const pushes = events.filter((e) => e.kind === 'push' && e.outcome !== 'denied');
      assert.ok(pushes.every((e) => e.kind === 'push' && e.purpose === 'displaced'), `${kind}: only displaced copies are pushed: ${JSON.stringify(pushes)}`);
      assert.equal(pushes.length, fx.peers.length, `${kind}: one displaced copy per peer`);
      assert.equal(events.filter((e) => e.kind === 'incident').length, fx.peers.length, `${kind}: one incident event per peer`);
      const after = await fx.remote.refs();
      assert.equal(after[board], remoteBefore[board], `${kind}: the board is untouched`);
      assert.equal(after[p1.core.refs.remoteCode], remoteBefore[p1.core.refs.remoteCode], `${kind}: the mirror is untouched`);
      for (const [i, p] of fx.peers.entries()) assert.deepEqual(await readWork(p, 'x.txt'), disk[i], `${kind}: ${p.name}'s work tree is untouched`);
    });
  }
});

test('each detecting peer pushes one ABSENT-leased displaced copy of LA_B and stores incident-<n>; with 3 displaced refs present the copy stays local and the status says kept_local', async () => {
  await withCores('incident-displaced', { n: 2, files: FILES }, async (fx) => {
    const p1 = fx.peers[0]!;
    const { board: B1 } = await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
    for (const p of fx.peers) await catchUp(fx, p);
    const B0 = await firstParent(p1, B1);
    await forceRemote(fx, p1, p1.core.refs.remoteBoard, B0);
    const attempts0 = fx.peers.map((p) => p.core.pushAttempts);
    const spawns0 = fx.peers.map((p) => pushSpawnsOf(gitCallsOf(p)));
    const traceFrom = fx.trace.events.length;
    const logs = fx.peers.map((p) => {
      const l = new LogRecorder();
      p.deps.log = l;
      return l;
    });

    for (const p of fx.peers) assert.equal((await poll(p)).incident, true);
    for (const p of fx.peers) {
      assert.equal(await p.core.repo.readRef(p.core.refs.incident(1)), B0, `${p.name}: incident-1 holds the observed bad tip`);
      assert.equal(incidentStatus(p.core)?.displaced, 'pending', `${p.name}: the copy waits for an ordinary window (R-21)`);
    }
    for (let i = 0; i < 3; i++) {
      fx.advance(PAST_WINDOW_MS);
      for (const p of fx.peers) await poll(p);
    }
    const ref = p1.core.refs.displaced(B1);
    assert.deepEqual(await remoteDisplaced(fx, p1), { [ref]: B1 }, 'one displaced ref: a copy of LA_B');
    for (const [i, p] of fx.peers.entries()) {
      const mine = fx.trace.since(traceFrom).filter((e) => e.kind === 'push' && e.peer === p.core.peerId && e.outcome !== 'denied');
      assert.equal(mine.length, 1, `${p.name}: exactly one push`);
      const push = mine[0]!;
      assert.ok(push.kind === 'push' && push.purpose === 'displaced');
      assert.ok(push.kind === 'push' && push.argv.includes(`--force-with-lease=${ref}:`), `${p.name}: an ABSENT lease`);
      assert.ok(push.kind === 'push' && push.argv.includes(`${B1}:${ref}`));
      assert.equal(p.core.pushAttempts - attempts0[i]!, 1, `${p.name}: one counted attempt`);
      assert.equal(pushSpawnsOf(gitCallsOf(p)) - spawns0[i]!, 1, `${p.name}: one push process`);
      assert.deepEqual(p.core.view!.meta.displaced, [oid12(B1)]);
      assert.equal(incidentStatus(p.core)?.displaced, 'pushed');
      assert.ok(logs[i]!.lines.some((l) => l.code === 'INCIDENT' && l.params['n'] === 1 && l.params['old_board'] === B1 && l.params['new_board'] === B0), `${p.name}: INCIDENT with old and new oids`);
      // The INCIDENT event names where the copy of LA_B goes.
      assert.equal(logs[i]!.lines.find((l) => l.code === 'INCIDENT')?.params['displaced'], ref, `${p.name}: INCIDENT names the displaced ref`);
    }
  });

  await withCores('incident-displaced-full', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { board: B1 } = await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
    await catchUp(fx, p);
    const B0 = await firstParent(p, B1);
    const L0 = await liveOf(p, B0);
    const L1 = await liveOf(p, B1);
    for (const o of [B0, L0, L1]) await gitRemote(fx, ['update-ref', p.core.refs.displaced(o), o]);
    const before = await remoteDisplaced(fx, p);
    assert.equal(Object.keys(before).length, 3);
    await forceRemote(fx, p, p.core.refs.remoteBoard, B0);
    const log = new LogRecorder();
    p.deps.log = log;
    const spawns0 = pushSpawnsOf(gitCallsOf(p));
    assert.equal((await poll(p)).incident, true);
    for (let i = 0; i < 3; i++) {
      fx.advance(PAST_WINDOW_MS);
      await poll(p);
    }
    assert.equal(pushSpawnsOf(gitCallsOf(p)) - spawns0, 0, 'no push: the copy stays local');
    assert.deepEqual(await remoteDisplaced(fx, p), before);
    assert.equal(await p.core.repo.readRef(p.core.refs.incident(1)), B0, 'incident-1 is stored');
    assert.equal(incidentStatus(p.core)?.displaced, 'kept_local', 'the status says kept_local');
    assert.ok(log.lines.some((l) => l.code === 'INCIDENT_DISPLACED' && l.params['state'] === 'kept_local'), log.text());
    assert.equal(log.lines.find((l) => l.code === 'INCIDENT')?.params['displaced'], 'kept_local', 'the INCIDENT event says kept_local');
    assert.deepEqual(p.core.view!.meta.displaced, []);
  });
});

test('a peer in INCIDENT whose fetch fails stays in INCIDENT: no UNFROZEN line and meta.incident unchanged', async () => {
  await withCores('incident-fetch-failed', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { board: B1 } = await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
    await catchUp(fx, p);
    await forceRemote(fx, p, p.core.refs.remoteBoard, await firstParent(p, B1));
    assert.equal((await poll(p)).incident, true);
    const incident0 = p.core.view!.meta.incident;
    const log = new LogRecorder();
    p.deps.log = log;
    // The remote is unreachable: the iteration checks the last checked board, which passes, but nothing was fetched.
    const away = `${fx.remote.dir}.away`;
    await rename(fx.remote.dir, away);
    try {
      fx.advance(PAST_WINDOW_MS);
      const r = await poll(p);
      assert.equal(r.it?.fetched?.ok, false, 'the fetch failed');
      assert.equal(r.cleared, false, 'no clearing on a failed fetch');
    } finally {
      await rename(away, fx.remote.dir);
    }
    assert.ok(inIncident(p), 'still in INCIDENT');
    assert.deepEqual(p.core.view!.meta.incident, incident0, 'meta.incident unchanged');
    assert.ok(!log.lines.some((l) => l.code === 'UNFROZEN'), log.text());
  });
});

test('a board ref that names a non-commit object is an incident whose observed value is stored at incident-<n> as it is', async () => {
  await withCores('incident-board-blob', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const blob = await p.core.repo.hashBytes(buf('not a board commit\n'), true);
    await forceRemote(fx, p, p.core.refs.remoteBoard, blob);
    const r = await poll(p);
    assert.equal(r.incident, true);
    assert.equal(r.why, 'board_shape');
    assert.equal(await p.core.repo.readRef(p.core.refs.incident(1)), blob, 'incident-1 holds the blob');
    assert.deepEqual(p.core.view!.meta.incident, { n: 1, observed_board: blob, observed_code: null });
  });
});

test('a restart with state present and the board absent enters INCIDENT (board_missing) on its first iteration and pushes nothing but the displaced copy', async () => {
  await withCores('incident-restart-board-gone', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const laB = p.core.view!.laB;
    const code = (await fx.remote.refs())[p.core.refs.remoteCode];
    await gitRemote(fx, ['update-ref', '-d', p.core.refs.remoteBoard]);
    await restartCore(p);
    const r = await startDispatch(p.core, { publishLocal: null });
    assert.ok(r.ok && r.mode === 'restart', JSON.stringify(r));
    const spawns0 = pushSpawnsOf(gitCallsOf(p));
    const traceFrom = fx.trace.events.length;

    const first = await poll(p);
    assert.equal(first.incident, true, 'the first iteration takes the incident branch');
    assert.equal(first.why, 'board_missing');
    assert.ok(inIncident(p));
    assert.deepEqual(p.core.view!.meta.incident, { n: 1, observed_board: null, observed_code: null });
    assert.ok(!(await localCoworkRefs(p)).some((ref) => ref.includes('/incident-')), 'no incident-<n> ref: the board is ABSENT');
    for (let i = 0; i < 3; i++) {
      fx.advance(PAST_WINDOW_MS);
      assert.equal((await poll(p)).incident, true);
    }
    assert.equal(pushSpawnsOf(gitCallsOf(p)) - spawns0, 1, 'one push');
    const pushes = fx.trace.since(traceFrom).filter((e) => e.kind === 'push' && e.outcome !== 'denied');
    assert.deepEqual(pushes.map((e) => e.kind === 'push' && e.purpose), ['displaced']);
    const after = await fx.remote.refs();
    assert.equal(after[p.core.refs.remoteBoard], undefined, 'the board stays absent');
    assert.equal(after[p.core.refs.remoteCode], code, 'the mirror is untouched');
    assert.equal(after[p.core.refs.displaced(laB)], laB, 'the displaced copy of LA_B');
  });
});

test('a missing or rewound mirror alone never raises INCIDENT', async () => {
  await withCores('incident-mirror-alone', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { board: B1 } = await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
    await catchUp(fx, p);
    const L0 = await liveOf(p, await firstParent(p, B1));
    const L1 = await liveOf(p, B1);
    const code = p.core.refs.remoteCode;

    await forceRemote(fx, p, code, null);
    for (let i = 0; i < 2; i++) {
      fx.advance(2_500);
      const r = await poll(p);
      assert.equal(r.incident, false, 'a missing mirror is no incident');
    }
    assert.ok(!inIncident(p));
    // The next publish recreates it at live_code(previous board tip).
    await editAndCapture(fx, p, { 'y.txt': 'y local\n' });
    fx.advance(PAST_WINDOW_MS);
    const pub = await publishStep(p.core, await prep(p));
    assert.equal(pub.outcome, 'landed');
    assert.equal((await fx.remote.refs())[code], L1, 'the mirror is recreated at TIP');

    await forceRemote(fx, p, code, L0);
    for (let i = 0; i < 2; i++) {
      fx.advance(2_500);
      const r = await poll(p);
      assert.equal(r.incident, false, 'a rewound mirror is no incident');
    }
    assert.ok(!inIncident(p));
    assert.equal(p.core.view!.meta.incident, null);
  });
});
