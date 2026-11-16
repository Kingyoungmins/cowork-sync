// Ruling R3-EF4-28 (delta review I2; HLD-08 "the K4 local side, once ENG- verified the TIP write", HLD-41; final review FB-5): the
// post-write OFF_DISK move of the displacement K4 records of p runs for EVERY verified written or deleted path, not only for this apply's
// own TAKE_TIP paths — as the restart decision (resolveWriteIntent) does — and such a write counts `take_tip` for HLD-41. Before, an
// apply-side K4 whose write group the writer deferred stayed ON_DISK CONFLICTED [conflict] for good once a later apply wrote p by a clean
// merge: R1 kept it CONFLICTED (UNSEPARABLE, disk ≠ A), MASK step 4 withheld p whole (the human's later edits never published), and
// --restore / --discard were dead ends. And an ON_DISK --discard of a CONFLICTED record first refreshes its held side := S_disk (PARK's
// whole refresh), so the ended record holds what the discard took off the disk. Real git on file:// clones; never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyStep } from '../../src/engine/apply.js';
import { evaluateRecords } from '../../src/engine/holdOps.js';
import { maskInputsOf } from '../../src/engine/publish.js';
import { resolve } from '../../src/engine/resolve.js';
import { restart } from '../../src/engine/restart.js';
import type { Oid } from '../../src/git/oid.js';
import type { RebaseChange } from '../../src/holds/changesets.js';
import { maskEntries } from '../../src/holds/mask.js';
import { blobAt, heldSide } from '../../src/holds/record.js';
import { KilledAt, setCrashHandler } from '../../src/ports/crashpoint.js';
import { readWork, workPath, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { blob, nr, P, prepIt, stages, withPeers } from '../helpers/holdOpsFixture.js';
import { T9, t9 } from '../helpers/maskFixture.js';
import { buf } from '../helpers/publishHelpers.js';
import { HUMAN } from '../helpers/resolveFixture.js';
import { restartCore } from '../helpers/startFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };
const K4 = (p: PeerFixture): string[] => p.core.holds.nonTerminal().filter((r) => 's2' in r.blobs && r.guards.some((g) => g.name === 'conflict')).map((r) => r.id);
const state = (p: PeerFixture, id: string): [string, string, string[]] => {
  const r = p.core.holds.get(id)!;
  return [String(r.residence), r.state, r.guards.map((g) => g.name)];
};
/** A stage record's stage blob at P. */
const stageOf = (p: PeerFixture, id: string, s: 's1' | 's2' | 's3'): string | undefined => {
  const b = p.core.holds.get(id)!.blobs;
  return 's1' in b ? blobAt(b[s], P) : undefined;
};

/** Every RebaseChange handed to HLD-41 (ChangeSets.rebase) while the peer runs. */
function rebaseChanges(p: PeerFixture): RebaseChange[] {
  const seen: RebaseChange[] = [];
  const cs = p.core.cs;
  const rebase = cs.rebase.bind(cs);
  cs.rebase = async (repo, changes, scratch) => {
    seen.push(...changes);
    return rebase(repo, changes, scratch);
  };
  return seen;
}

/**
 * Local row 5 'five local', teammate row 5 'five team': the apply TAKE_TIPs p (its K4 record before the write), and the human saves
 * again between the materialization and the write (`resave`): the writer's pre-image check fails and the group defers ('mismatch').
 */
async function deferredK4(fx: CoreFixture, p: PeerFixture, resave: string): Promise<string> {
  await writeWork(p, P, t9([5, 'five local']));
  fx.advance(2_000);
  await prepIt(p);
  fx.advance(1_500);
  await prepIt(p, { materialize: true });
  await fx.pushTeamChange({ [P]: buf(t9([5, 'five team'])) });
  fx.advance(11_000);
  const it = await prepIt(p, { forceFetch: true, materialize: true });
  await writeWork(p, P, resave);
  const a1 = await applyStep(p.core, it);
  assert.equal(a1.deferred.get(P), 'mismatch', JSON.stringify([...a1.deferred]));
  const k4 = K4(p);
  assert.equal(k4.length, 1, 'one K4 record');
  assert.deepEqual(state(p, k4[0]!), ['ON_DISK', 'CONFLICTED', ['conflict']]);
  return k4[0]!;
}

test('R3-EF4-28: a K4 whose write group the writer deferred goes OFF_DISK when a later apply writes p by a clean merge; the write is take_tip for HLD-41; R1 leaves it OFF_DISK and MASK no longer withholds p', T10, async () => {
  await withPeers('k4-deferred-clean', {}, async (fx) => {
    const p = fx.peers[0]!;
    const id = await deferredK4(fx, p, t9([8, 'eight local']));
    const s2 = stageOf(p, id, 's2');
    // Next apply: S_disk = row 8 local, TIP = row 5 team → a clean merge writes both.
    fx.advance(2_000);
    await prepIt(p);
    fx.advance(11_000);
    const it2 = await prepIt(p, { forceFetch: true, materialize: true });
    const changes = rebaseChanges(p);
    const a2 = await applyStep(p.core, it2);
    assert.ok(a2.written.includes(P), JSON.stringify(a2));
    assert.equal((await readWork(p, P))!.toString('utf8'), t9([5, 'five team'], [8, 'eight local']));
    // HLD-08: the verified write displaced the K4's local side — OFF_DISK in this apply, CONFLICTED and its stages kept.
    assert.deepEqual(state(p, id), ['OFF_DISK', 'CONFLICTED', ['conflict']], 'the K4 record went OFF_DISK after the verified write');
    assert.equal(stageOf(p, id, 's2'), s2, 'its local side is kept');
    // HLD-41: the write of p is a take_tip, as the restart decision counts it (no written entry handed on).
    const ch = changes.filter((c) => c.path === P);
    assert.deepEqual(ch.map((c) => [c.written, c.writtenEntry]), [['take_tip', null]]);
    // R1 after the writes on a fresh materialization: the record stays OFF_DISK; MASK leaves p alone, so 'eight local' publishes.
    fx.advance(2_000);
    await prepIt(p);
    fx.advance(1_500);
    const it3 = await prepIt(p, { materialize: true });
    await evaluateRecords(p.core, it3, new Set([P]), []);
    assert.equal(p.core.holds.get(id)!.residence, 'OFF_DISK');
    const masked = await maskEntries(p.core.repo, it3.mat!.sDiskMap, maskInputsOf(p.core, it3, p.core.holds.maskingRecords()), p.core.rebase);
    assert.equal(masked.withheld.has(P), false, 'p is not withheld whole');
    assert.equal(masked.entries.get(P)?.oid, it3.mat!.sDiskMap.get(P)?.oid, 'S_pub[p] is the disk\'s bytes');
  });
});

test('R3-EF4-28: a K4 whose write group the writer deferred goes OFF_DISK when a later apply deletes p (a verified deletion)', T10, async () => {
  await withPeers('k4-deferred-delete', {}, async (fx) => {
    const p = fx.peers[0]!;
    // The human's re-save puts p back to A: the next apply's merge takes TIP's side cleanly — here, a teammate's deletion of p.
    const id = await deferredK4(fx, p, T9);
    await fx.pushTeamChange({ [P]: null });
    fx.advance(2_000);
    await prepIt(p);
    fx.advance(11_000);
    const a2 = await applyStep(p.core, await prepIt(p, { forceFetch: true, materialize: true }));
    assert.ok(a2.deleted.includes(P), JSON.stringify(a2));
    assert.equal(await readWork(p, P), null);
    assert.deepEqual(state(p, id), ['OFF_DISK', 'CONFLICTED', ['conflict']], 'the K4 record went OFF_DISK after the verified deletion');
  });
});

test('R3-EF4-28: an ON_DISK --discard of a CONFLICTED record refreshes its held side := S_disk before writing A[p], so the ended record holds the bytes the discard took off the disk', T10, async () => {
  await withPeers('k4-deferred-discard', {}, async (fx) => {
    const p = fx.peers[0]!;
    const id = await deferredK4(fx, p, t9([8, 'eight local']));
    const s1 = stageOf(p, id, 's1');
    const s3 = stageOf(p, id, 's3');
    fx.advance(2_000);
    await prepIt(p);
    fx.advance(1_500);
    const it = await prepIt(p, { materialize: true });
    const disk = it.mat!.sDiskMap.get(P)!.oid;
    assert.equal(disk, await blob(p, t9([8, 'eight local'])));
    const res = await resolve(p.core, it, id, 'discard', HUMAN);
    assert.deepEqual(res, { kind: 'done', code: 'RESOLVED_DISCARD', id, created: null });
    assert.equal((await readWork(p, P))!.toString('utf8'), T9, 'A[p] written');
    const r = p.core.holds.get(id)!;
    assert.equal(r.state, 'RESOLVED_DISCARD');
    assert.deepEqual(r.blobs, stages(s1 as Oid, disk, s3 as Oid), 'held side := S_disk (the discarded \'eight local\'), base and TIP stages kept');
  });
});

test('R3-EF4-28: --discard refreshes no record carrying `markers` (05 §3.4: never refreshed from disk) and no held side with a restore-marker row', T10, async () => {
  await withPeers('k4-deferred-discard-markers', {}, async (fx) => {
    const p = fx.peers[0]!;
    const MARKED = t9([4, '>>>>>>> cowork:held']);
    await writeWork(p, P, MARKED);
    const it0 = await prepIt(p, { materialize: true });
    const a = it0.A.get(P)!.oid;
    const held = await blob(p, t9([2, 'two']));
    const team = await blob(p, t9([2, 'team']));
    const done = (id: string): unknown => ({ kind: 'done', code: 'RESOLVED_DISCARD', id, created: null });
    // (1) A CONFLICTED record carrying `markers` (its marker file belongs to no held side; a marker companion keeps one).
    const m = await p.core.holds.hold(nr({ state: 'CONFLICTED', guard: 'markers', origin: 'daemon', blobs: stages(a, held, team) }));
    assert.deepEqual(await resolve(p.core, await prepIt(p, { holdPaths: [P] }), m, 'discard', HUMAN), done(m));
    assert.equal(blobAt(heldSide(p.core.holds.get(m)!), P), held, 'a markers record\'s held side is never refreshed from disk');
    assert.deepEqual(await readWork(p, P), buf(T9), 'A[p] written');
    // (2) A CONFLICTED `conflict` record whose disk holds a restore-marker row (a stale save): such bytes never enter a held side.
    await writeWork(p, P, MARKED);
    const c = await p.core.holds.hold(nr({ state: 'CONFLICTED', guard: 'conflict', origin: 'daemon', blobs: stages(a, held, team) }));
    const it = await prepIt(p, { holdPaths: [P] });
    assert.equal(it.mat!.sDiskMap.get(P)?.oid, await blob(p, MARKED));
    assert.deepEqual(await resolve(p.core, it, c, 'discard', HUMAN), done(c));
    assert.equal(blobAt(heldSide(p.core.holds.get(c)!), P), held, 'no held side with a restore-marker row (DAT-46, ENG-41 (j))');
    assert.deepEqual(await readWork(p, P), buf(T9));
  });
});

/** A conflicted RESTORE's result on disk: restore-marker rows around row 2 (as apply.k4.p3.test.ts). */
const ROWS = '1\n<<<<<<< cowork:disk\nTWO\n||||||| cowork:base\n2\n=======\ntwo\n>>>>>>> cowork:held\n3\n4\n5\n6\n7\n8\n9\n';

/**
 * EF4 E4-1's K4 onto a markers record r whose TIP write the writer deferred (a share-read holder): r ON_DISK CONFLICTED
 * [markers, conflict] with marker-free stages, its companion GONE, the marker file still on disk.
 */
async function deferredMarkersK4(fx: CoreFixture, p: PeerFixture): Promise<string> {
  await writeWork(p, P, ROWS);
  const it0 = await prepIt(p, { holdPaths: [P] });
  const a = it0.A.get(P)!.oid;
  const r = await p.core.holds.hold(nr({ guard: 'markers', origin: 'daemon', blobs: stages(a, await blob(p, t9([2, 'two'])), await blob(p, t9([2, 'team']))) }));
  await fx.pushTeamChange({ [P]: buf(t9([2, 'TEAM2'])) });
  fx.advance(10_000);
  const it = await prepIt(p, { forceFetch: true });
  const release = p.fs.holdLock(workPath(p, P), 'share-read');
  try {
    assert.equal((await applyStep(p.core, it)).deferred.get(P), 'locked');
  } finally {
    release();
  }
  assert.deepEqual(state(p, r), ['ON_DISK', 'CONFLICTED', ['markers', 'conflict']]);
  return r;
}

test('R3-EF4-28 with `markers`: a later clean write whose bytes have no restore-marker row moves a deferred markers K4 OFF_DISK (markers released); one that keeps a marker row on disk leaves it ON_DISK with `markers` (never unmasked)', T10, async () => {
  for (const resolved of [true, false]) {
    await withPeers(`k4-deferred-markers-${resolved ? 'clean' : 'rows'}`, {}, async (fx) => {
      const p = fx.peers[0]!;
      const r = await deferredMarkersK4(fx, p);
      // The human resolves the rows: back to A whole, or row 2 back to A with a stale marker row left at row 8.
      const disk = resolved ? T9 : t9([8, '>>>>>>> cowork:held']);
      await writeWork(p, P, disk);
      fx.advance(2_000);
      await prepIt(p);
      fx.advance(10_000);
      const a2 = await applyStep(p.core, await prepIt(p, { forceFetch: true, materialize: true }));
      assert.ok(a2.written.includes(P), JSON.stringify(a2));
      assert.equal(a2.records.length, 0, 'a clean merge, no TAKE_TIP');
      const want = resolved ? t9([2, 'TEAM2']) : t9([2, 'TEAM2'], [8, '>>>>>>> cowork:held']);
      assert.equal((await readWork(p, P))!.toString('utf8'), want);
      assert.deepEqual(state(p, r), resolved ? ['OFF_DISK', 'CONFLICTED', ['conflict']] : ['ON_DISK', 'CONFLICTED', ['markers', 'conflict']]);
    });
  }
});

/** Throws KilledAt at the `nth` hit of `point` (a dead process: the core is abandoned). */
async function killedAt<T>(point: string, nth: number, fn: () => Promise<T>): Promise<void> {
  let hits = 0;
  setCrashHandler((name) => {
    if (name === point && ++hits === nth) throw new KilledAt(name);
  });
  try {
    await assert.rejects(fn(), (e: unknown) => e instanceof KilledAt && e.point === point, `killed at ${point} #${nth}`);
  } finally {
    setCrashHandler(null);
  }
}

test('R3-EF4-31 (EF5 merge M-3): the restart decision of that clean write, killed after the verified write and before the in-process move, decides as the apply does — no restore-marker row written: OFF_DISK, `markers` released, take_tip; the rows kept: ON_DISK with `markers`, the write `clean`', T10, async () => {
  for (const resolved of [true, false]) {
    await withPeers(`k4-deferred-markers-restart-${resolved ? 'clean' : 'rows'}`, {}, async (fx) => {
      const p = fx.peers[0]!;
      const r = await deferredMarkersK4(fx, p);
      await writeWork(p, P, resolved ? T9 : t9([8, '>>>>>>> cowork:held']));
      fx.advance(2_000);
      await prepIt(p);
      fx.advance(10_000);
      const it = await prepIt(p, { forceFetch: true, materialize: true });
      // Killed after the write group's verified write (its round trip done), before the post-write OFF_DISK move and the state update.
      await killedAt('apply.group.phase2', 1, () => applyStep(p.core, it));
      const want = resolved ? t9([2, 'TEAM2']) : t9([2, 'TEAM2'], [8, '>>>>>>> cowork:held']);
      assert.equal((await readWork(p, P))!.toString('utf8'), want, 'the clean merge is on disk');
      assert.deepEqual(state(p, r), ['ON_DISK', 'CONFLICTED', ['markers', 'conflict']], 'the crashed apply never moved the record');
      await restartCore(p);
      const changes = rebaseChanges(p);
      const report = await restart(p.core);
      assert.equal(report.intent, 'apply');
      assert.deepEqual(state(p, r), resolved ? ['OFF_DISK', 'CONFLICTED', ['conflict']] : ['ON_DISK', 'CONFLICTED', ['markers', 'conflict']],
        resolved ? 'no marker row written: the decision moves r OFF_DISK and releases markers' : 'the written bytes keep a marker row: r stays ON_DISK with markers (never unmasked)');
      assert.deepEqual(changes.filter((c) => c.path === P).map((c) => c.written), [resolved ? 'take_tip' : 'clean'], 'HLD-41 counts the write as the apply would');
    });
  }
});
