// PARK (Plan 3 Task 5; 05-holds §3.4 item 3, HLD-16, Table 4 `--park` operator half; Review Focus 2; rulings R3-11, R3-23,
// R3-60): the target per path (r's step-5 MASK alone, else A[p]), the held-side refresh first for a PIN, a CONFLICTED or a
// whole-path record, inflight[r] committed before writeLocalGroup and the final patch after WRITTEN, all or none, FROZEN and
// POSTPONED before any registry write; and the carried R-02 fix (a stage dedupe onto an OFF_DISK PARKED record attaches ON_DISK
// CONFLICTED). Notation (Task 1 notes): T9 is "1\n…9\n" at src/t9.txt; T9{2:two} replaces line 2. Real git; never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collisionTake, park, restore } from '../../src/engine/holdOps.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import type { InflightOp } from '../../src/holds/registry.js';
import { readWork, workPath, writeWork, type PeerFixture } from '../helpers/coreFixture.js';
import { blob, nr, P, pair, prepIt, recordLog, registryCommits, stages, withPeers } from '../helpers/holdOpsFixture.js';
import { T9, t9 } from '../helpers/maskFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const U = 'src/u9.txt';
const HUMAN = { humanEvidence: true, displacedBy: null, refreshMustBeDurable: false } as const;
const LEAVE_OP = '0123456789abcdef0123456789abcdef/00112233445566778899aabbccddeeff/7';

/** local.json of a registry commit (all-empty when absent). */
async function localAt(p: PeerFixture, commit: Oid): Promise<{ inflight: Record<string, InflightOp> }> {
  const e = (await p.core.repo.readTreeMap((await p.core.repo.readCommit(commit)).tree)).get('local.json');
  return e === undefined ? { inflight: {} } : JSON.parse((await p.core.repo.readBlob(e.oid)).toString('utf8'));
}

/** The registry commits after `from` (oldest first). */
async function registrySince(p: PeerFixture, from: Oid | null): Promise<Oid[]> {
  const head = p.core.holds.head();
  if (head === null) return [];
  return (await p.core.repo.firstParents(head, from, 1_000)).reverse();
}

test('PARK of an ACTIVE PATCH writes the step-5 MASK of r alone', T10, async () => {
  await withPeers('park-patch', {}, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, P, t9([2, 'two'], [6, 'six']));
    const it = await prepIt(p, { holdPaths: [P] });
    const id = await p.core.holds.hold(nr({ blobs: pair(it.A.get(P)!.oid, await blob(p, t9([2, 'two']))) }));
    const head0 = p.core.holds.head();
    const log = recordLog(p);
    const { commits, result } = await registryCommits(p, () => park(p.core, it, id, { humanEvidence: false, displacedBy: null, refreshMustBeDurable: false }));
    assert.deepEqual(result, { kind: 'PARKED', companion: null });
    assert.deepEqual(await readWork(p, P), Buffer.from(t9([6, 'six'])), "the disk is r's step-5 MASK alone: the human's row 6 stays");
    const r = p.core.holds.get(id)!;
    assert.deepEqual([r.residence, r.state, r.displaced_by], ['OFF_DISK', 'PARKED', null]);
    assert.deepEqual(r.blobs, pair(it.A.get(P)!.oid, await blob(p, t9([2, 'two']))), 'an ACTIVE PATCH is never refreshed');
    assert.equal(commits, 2, 'two registry commits');
    const [c1, c2] = await registrySince(p, head0);
    const set = (await localAt(p, c1!)).inflight[id];
    assert.equal(set?.op, 'park', 'commit 1 sets inflight[r]');
    assert.deepEqual(set?.entries, [{ path: P, expected: it.mat!.sDiskMap.get(P)!.oid, target: await blob(p, t9([6, 'six'])) }]);
    assert.deepEqual((await localAt(p, c2!)).inflight, {}, 'commit 2: the final patch with the inflight cleared');
    assert.deepEqual(log.lines.find((l) => l.code === 'HOLD_PARKED')?.params, { path: P, hid: id });
  });
});

test('PARK passes displaced_by through (S6 and the stop park name their op)', T10, async () => {
  await withPeers('park-displaced', {}, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, P, t9([2, 'two']));
    const it = await prepIt(p, { holdPaths: [P] });
    const id = await p.core.holds.hold(nr({ blobs: pair(it.A.get(P)!.oid, await blob(p, t9([2, 'two']))) }));
    assert.deepEqual(await park(p.core, it, id, { humanEvidence: false, displacedBy: LEAVE_OP, refreshMustBeDurable: false }), { kind: 'PARKED', companion: null });
    assert.equal(p.core.holds.get(id)!.displaced_by, LEAVE_OP);
    assert.deepEqual(await readWork(p, P), Buffer.from(T9));
  });
});

test('PARK of a PIN or CONFLICTED record refreshes the held side first and writes A[p]', T10, async () => {
  await withPeers('park-pin', {}, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, P, t9([2, 'two'], [6, 'six']));
    await writeWork(p, U, t9([3, 'mine']));
    const it = await prepIt(p, { holdPaths: [P, U] });
    const t = it.A.get(P)!.oid;
    const pin = await p.core.holds.hold(nr({ kind: 'PIN', guard: 'join', blobs: pair(t, await blob(p, t9([2, 'two']))) }));
    const head0 = p.core.holds.head();
    assert.deepEqual(await park(p.core, it, pin, HUMAN), { kind: 'PARKED', companion: null });
    const [c1] = await registrySince(p, head0);
    const first = JSON.parse((await p.core.repo.readBlob((await p.core.repo.readTreeMap((await p.core.repo.readCommit(c1!)).tree)).get(`records/${pin}.json`)!.oid)).toString('utf8'));
    assert.equal(first.blobs.h1[P], it.mat!.sDiskMap.get(P)!.oid, 'commit 1 sets h1 := S_disk[p] ...');
    assert.equal((await localAt(p, c1!)).inflight[pin]?.op, 'park', '... and inflight[r] together');
    assert.deepEqual(await readWork(p, P), Buffer.from(T9), 'the disk becomes A[p]');
    const r = p.core.holds.get(pin)!;
    assert.deepEqual([r.residence, r.state], ['OFF_DISK', 'PARKED']);
    assert.equal('h1' in r.blobs ? r.blobs.h1[P] : null, it.mat!.sDiskMap.get(P)!.oid, 'the PIN holds every byte the park removed');
    // An ON_DISK CONFLICTED stage record (a K4 whose TIP write is pending): s2 refreshed, OFF_DISK CONFLICTED.
    const u0 = it.A.get(U)!.oid;
    const k4 = await p.core.holds.hold(nr({ paths: [U], state: 'CONFLICTED', guard: 'conflict', origin: 'daemon', blobs: stages(u0, await blob(p, t9([3, 'three'])), await blob(p, t9([3, 'team'])), U) }));
    assert.deepEqual(await park(p.core, it, k4, HUMAN), { kind: 'PARKED', companion: null });
    const k = p.core.holds.get(k4)!;
    assert.deepEqual([k.residence, k.state], ['OFF_DISK', 'CONFLICTED']);
    assert.equal('s2' in k.blobs ? k.blobs.s2[U] : null, it.mat!.sDiskMap.get(U)!.oid, 's2 := S_disk[p]');
    assert.deepEqual(await readWork(p, U), Buffer.from(T9));
  });
});

test('PARK with refreshMustBeDurable returns REFRESHED and writes nothing', T10, async () => {
  await withPeers('park-refresh', {}, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, P, t9([2, 'two'], [6, 'six']));
    const it = await prepIt(p, { holdPaths: [P] });
    const pin = await p.core.holds.hold(nr({ kind: 'PIN', guard: 'join', blobs: pair(it.A.get(P)!.oid, await blob(p, t9([2, 'two']))) }));
    const o = { humanEvidence: false, displacedBy: null, refreshMustBeDurable: true };
    const out = await park(p.core, it, pin, o);
    const r = p.core.holds.get(pin)!;
    assert.deepEqual(out, { kind: 'REFRESHED', rev: r.rev });
    assert.equal('h1' in r.blobs ? r.blobs.h1[P] : null, it.mat!.sDiskMap.get(P)!.oid, 'the refresh rev holds S_disk[p]');
    assert.equal(r.residence, 'ON_DISK');
    assert.deepEqual(p.core.holds.local().inflight, {}, 'no inflight entry');
    assert.deepEqual(await readWork(p, P), Buffer.from(t9([2, 'two'], [6, 'six'])), 'disk unchanged');
    // Once that rev is durable (the caller's S6 decides), the same call parks.
    assert.deepEqual(await park(p.core, it, pin, o), { kind: 'PARKED', companion: null });
    assert.deepEqual(await readWork(p, P), Buffer.from(T9));
  });
});

test('PARK is all or none', T10, async () => {
  await withPeers('park-all-or-none', { files: { 'README.md': Buffer.from('# r\n'), 'a.txt': Buffer.from(T9), 'b.txt': Buffer.from(T9) } }, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, 'a.txt', t9([2, 'a']));
    await writeWork(p, 'b.txt', t9([2, 'b']));
    const it = await prepIt(p, { holdPaths: ['a.txt', 'b.txt'] });
    const t = it.A.get('a.txt')!.oid;
    const pin = await p.core.holds.hold(nr({ kind: 'PIN', guard: 'join', paths: ['a.txt', 'b.txt'], blobs: { h0: { 'a.txt': t, 'b.txt': t }, h1: { 'a.txt': t, 'b.txt': t } } }));
    const release = p.fs.holdLock(workPath(p, 'b.txt'), 'share-none');
    try {
      assert.deepEqual(await park(p.core, it, pin, HUMAN), { kind: 'LOCKED' });
    } finally {
      release();
    }
    assert.deepEqual(await readWork(p, 'a.txt'), Buffer.from(t9([2, 'a'])), 'a.txt byte-identical');
    assert.deepEqual(await readWork(p, 'b.txt'), Buffer.from(t9([2, 'b'])), 'b.txt byte-identical');
    const r = p.core.holds.get(pin)!;
    assert.equal(r.residence, 'ON_DISK');
    assert.equal(r.rev, 2, 'at the refresh rev');
    assert.deepEqual(p.core.holds.local().inflight, {}, 'inflight cleared');
  });
});

test('Review Focus 2: PARK under a share-read and under a share-none holder reports LOCKED and changes nothing', T10, async () => {
  await withPeers('park-locked', {}, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, P, t9([2, 'two'], [6, 'six']));
    const it = await prepIt(p, { holdPaths: [P] });
    const id = await p.core.holds.hold(nr({ blobs: pair(it.A.get(P)!.oid, await blob(p, t9([2, 'two']))) }));
    for (const mode of ['share-read', 'share-none'] as const) {
      for (const humanEvidence of [true, false]) {
        const before = p.core.holds.get(id)!;
        const release = p.fs.holdLock(workPath(p, P), mode);
        try {
          assert.deepEqual(await park(p.core, it, id, { humanEvidence, displacedBy: null, refreshMustBeDurable: false }), { kind: 'LOCKED' }, `${mode} ${humanEvidence}`);
        } finally {
          release();
        }
        assert.deepEqual(await readWork(p, P), Buffer.from(t9([2, 'two'], [6, 'six'])), 'disk unchanged');
        const r = p.core.holds.get(id)!;
        assert.deepEqual([r.residence, r.state, r.rev], [before.residence, before.state, before.rev], 'residence unchanged');
        assert.deepEqual(p.core.holds.local().inflight, {});
      }
    }
  });
});

test('PARK refuses local_only and INCOMING records and skips the pathless host-reject PIN', T10, async () => {
  await withPeers('park-not-parkable', { files: { 'README.md': Buffer.from('# r\n'), [P]: Buffer.from(T9), '.env': Buffer.from('A=1\n') } }, async (fx) => {
    const p = fx.peers[0]!;
    const it = await prepIt(p, { holdPaths: [P, '.env'] });
    const t = it.A.get(P)!.oid;
    const env = await p.core.holds.hold(nr({ paths: ['.env'], guard: 'restart', origin: 'daemon', blobs: pair(it.A.get('.env')!.oid, await blob(p, 'A=2\n'), '.env') }));
    assert.equal(p.core.holds.get(env)!.local_only, true, '.env is secret-like');
    const incoming = await p.core.holds.hold(nr({ kind: 'INCOMING', guard: 'lock', origin: 'daemon', blobs: pair(t, await blob(p, t9([2, 'team']))) }));
    const pathless = await p.core.holds.hold({ kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths: [], blobs: { h0: {}, h1: {} }, guard: 'host-reject', origin: 'daemon', cs_ids: [], displaced_by: null });
    for (const id of [env, incoming, pathless]) {
      const { commits, result } = await registryCommits(p, () => park(p.core, it, id, HUMAN));
      assert.deepEqual(result, { kind: 'NOT_PARKABLE' }, id);
      assert.equal(commits, 0, 'no registry commit');
    }
  });
});

test('PARK of a record carrying markers is the markers park', T10, async () => {
  await withPeers('park-markers', {}, async (fx) => {
    const p = fx.peers[0]!;
    const ROWS = '1\n<<<<<<< cowork:disk\nTWO\n||||||| cowork:base\n2\n=======\ntwo\n>>>>>>> cowork:held\n3\n4\n5\n6\n7\n8\n9\n';
    await writeWork(p, P, ROWS);
    const it = await prepIt(p, { holdPaths: [P] });
    const t = it.A.get(P)!.oid;
    const two = await blob(p, t9([2, 'two']));
    const id = await p.core.holds.hold(nr({ blobs: pair(t, two) }));
    await p.core.holds.addGuard(id, 'markers');
    const out = await park(p.core, it, id, HUMAN);
    assert.equal(out.kind, 'PARKED');
    assert.ok(out.kind === 'PARKED' && out.companion !== null, 'the markers park returned its companion');
    const r = p.core.holds.get(id)!;
    assert.deepEqual(r.blobs, pair(t, two), 'never refreshed from disk');
    assert.deepEqual(r.guards.map((g) => g.name), ['revert'], 'markers released');
    assert.deepEqual(await readWork(p, P), Buffer.from(T9));
  });
});

test('PARK under FREEZE writes only with human evidence', T10, async () => {
  await withPeers('park-freeze', {}, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, P, t9([2, 'two']));
    await p.core.commit({ meta: { ...p.core.view!.meta, freeze_reasons: ['MASS'] } });
    const it = await prepIt(p, { holdPaths: [P] });
    const id = await p.core.holds.hold(nr({ blobs: pair(it.A.get(P)!.oid, await blob(p, t9([2, 'two']))) }));
    const { commits, result } = await registryCommits(p, () => park(p.core, it, id, { humanEvidence: false, displacedBy: null, refreshMustBeDurable: false }));
    assert.deepEqual(result, { kind: 'FROZEN' });
    assert.equal(commits, 0, 'nothing changes');
    assert.deepEqual(await readWork(p, P), Buffer.from(t9([2, 'two'])));
    assert.deepEqual(await park(p.core, it, id, HUMAN), { kind: 'PARKED', companion: null });
    assert.deepEqual(await readWork(p, P), Buffer.from(T9));
  });
});

test('PARK whose disk changed since S_disk reports MISMATCH and keeps the residence', T10, async () => {
  await withPeers('park-mismatch', {}, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, P, t9([2, 'two']));
    const it = await prepIt(p, { holdPaths: [P] });
    const id = await p.core.holds.hold(nr({ blobs: pair(it.A.get(P)!.oid, await blob(p, t9([2, 'two']))) }));
    await writeWork(p, P, t9([2, 'two'], [9, 'nine']));   // edited after the materialization
    assert.deepEqual(await park(p.core, it, id, HUMAN), { kind: 'MISMATCH' });
    assert.equal(p.core.holds.get(id)!.residence, 'ON_DISK');
    assert.deepEqual(p.core.holds.local().inflight, {}, 'inflight cleared');
    assert.deepEqual(await readWork(p, P), Buffer.from(t9([2, 'two'], [9, 'nine'])));
  });
});

test('carried R-02 fix: a stage dedupe onto an OFF_DISK PARKED stage record attaches ON_DISK CONFLICTED', T10, async () => {
  await withPeers('park-r02', {}, async (fx) => {
    const p = fx.peers[0]!;
    await prepIt(p);
    const t = await blob(p, T9);
    const s = stages(t, await blob(p, t9([2, 'local'])), await blob(p, t9([2, 'team'])));
    const id = await p.core.holds.hold(nr({ residence: 'OFF_DISK', state: 'PARKED', guard: 'conflict', origin: 'daemon', blobs: s }));
    const out = await p.core.holds.holdOutcome(nr({ state: 'CONFLICTED', guard: 'conflict', origin: 'daemon', blobs: s }));
    assert.equal(out.id, id, 'R-02 dedupe: the same record');
    assert.equal(out.created, false);
    const r = p.core.holds.get(id)!;
    assert.deepEqual([r.residence, r.state, r.rev], ['ON_DISK', 'CONFLICTED', 2], 'ON_DISK CONFLICTED in one rev (Table 1 has no ON_DISK PARKED)');
  });
});

test('PARK, RESTORE and the collision take never write over a kept push intent or a stranded restore', T10, async () => {
  await withPeers('park-postponed', { files: { 'README.md': Buffer.from('# r\n'), '.gitignore': Buffer.from('.env\n'), [P]: Buffer.from(T9), [U]: Buffer.from(T9) } }, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, P, t9([2, 'two']));
    await writeWork(p, '.env', 'SECRET=local\n');
    await fx.pushTeamChange({ '.env': Buffer.from('SECRET=team\n') });
    const it = await prepIt(p, { holdPaths: [P, U], forceFetch: true });
    const t = it.A.get(P)!.oid;
    const parkId = await p.core.holds.hold(nr({ blobs: pair(t, await blob(p, t9([2, 'two']))) }));
    const restoreId = await p.core.holds.hold(nr({ paths: [U], residence: 'OFF_DISK', state: 'PARKED', blobs: pair(t, await blob(p, t9([4, 'four'])), U) }));
    const c = await p.core.holds.hold(nr({ kind: 'INCOMING', paths: ['.env'], guard: 'collision', origin: 'daemon', blobs: pair(ABSENT, it.tipMap.get('.env')!.oid, '.env') }));
    const tryAll = async (why: 'push_intent' | 'stranded'): Promise<void> => {
      const { commits, result } = await registryCommits(p, async () => [
        await park(p.core, it, parkId, HUMAN),
        await restore(p.core, it, restoreId, { humanEvidence: true, actor: 'human' }),
        await collisionTake(p.core, it, c),
      ]);
      assert.deepEqual(result, [{ kind: 'POSTPONED', why }, { kind: 'POSTPONED', why }, 'POSTPONED'], why);
      assert.equal(commits, 0, `${why}: no registry commit`);
      assert.deepEqual(await readWork(p, P), Buffer.from(t9([2, 'two'])));
      assert.deepEqual(await readWork(p, U), Buffer.from(T9));
      assert.deepEqual(await readWork(p, '.env'), Buffer.from('SECRET=local\n'));
    };
    // A kept push intent (the only record of a push that may have landed, R3-23).
    const view = p.core.view!;
    await p.core.commit({ intent: { kind: 'push', bnew: view.laB, c: null, lease_board: ABSENT, lease_code: ABSENT, cs_ids: [], writer_seq: 1, op_ids: [] }, t: new Map([['P', view.base]]) });
    await tryAll('push_intent');
    await p.core.commit({ intent: { kind: 'none' }, t: new Map() });
    // A stranded restore (P2-STRANDED): the writer reports the path whose .old waits at its intent name.
    p.core.writer.strandedPaths = () => ['src/elsewhere.txt'];
    await tryAll('stranded');
  });
});
