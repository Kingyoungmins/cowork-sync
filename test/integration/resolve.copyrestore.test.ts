// HLD-64's copy-restore through /cowork resolve (Plan 3 Task 11; 05-holds HLD-57 (a)'s exception, HLD-64, 05 I9 copy-restore, F7, the
// §1 refusal table; rulings R3-10 (the fourth guard-less birth); contract addition 4): a record of a peer whose `leave` op folded is
// never adopted, but a human `--restore` of it on another clone creates a NEW local record copying the board's held/<id>/ blobs
// (origin human, displaced_by null, the foreign kind, paths and guards) and RESTOREs it; the foreign record is left untouched. Without
// a folded leave op the same restore is refused HOLD_NOT_OWNER. makeCores({n: 2}); real git on file:// clones; never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sep } from 'node:path';
import { BOARD_SUBJECT, boardTrailers, buildBoardCommit } from '../../src/board/boardCommit.js';
import { CHECKPOINT_EVERY } from '../../src/board/fold.js';
import { newEpoch, newPeerId } from '../../src/board/ids.js';
import type { Op } from '../../src/board/ops.js';
import { joinDraft, prepareIteration } from '../../src/engine/core.js';
import { mirrorSync } from '../../src/engine/publish.js';
import { RELEASE_NAMESPACE, refNames } from '../../src/engine/refs.js';
import { resolve, type ResolveResult } from '../../src/engine/resolve.js';
import { fetchRefs } from '../../src/git/fetch.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import { pushSpec, runPush } from '../../src/git/push.js';
import type { MktreeEntry } from '../../src/git/repo.js';
import { seededRandom } from '../../src/ports/random.js';
import { readWork, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { blob, nr, pair, prepIt } from '../helpers/holdOpsFixture.js';
import { T9, t9 } from '../helpers/maskFixture.js';
import { win } from '../helpers/mirrorFixture.js';
import { buf, prep, withCores } from '../helpers/publishHelpers.js';
import { HUMAN, landHoldOps } from '../helpers/resolveFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const P = 'src/t9.txt';
const Q = 'src/q9.txt';
const FILES: Record<string, Buffer> = { 'README.md': buf('# copy-restore\n'), [P]: buf(T9), [Q]: buf(T9) };
const done = (code: string, id: string, created: string | null = null): ResolveResult => ({ kind: 'done', code, id, created });

/**
 * Peer 0 (the first clone) holds a revert record over P and a guard-less OFF_DISK PARKED PATCH over Q (Plan 2's ring late-write
 * shape), both mirrored with their held/ subtrees and landed; its revert record is parked first (its disk back to A).
 */
async function peerZeroRecords(fx: CoreFixture): Promise<{ p: PeerFixture; rev: string; bare: string }> {
  const p = fx.peers[0]!;
  await writeWork(p, P, t9([2, 'two'], [6, 'six']));
  const it0 = await prepIt(p, { materialize: false });
  const a = it0.A.get(P)!.oid;
  const rev = await p.core.holds.hold(nr({ paths: [P], blobs: pair(a, await blob(p, t9([2, 'two'])), P) }));
  const bare = await p.core.holds.hold(nr({ paths: [Q], residence: 'OFF_DISK', state: 'PARKED', guard: null, origin: 'daemon', blobs: pair(a, await blob(p, t9([8, 'late'])), Q) }));
  const it = await prepIt(p, { holdPaths: [P] });
  assert.deepEqual(await resolve(p.core, it, rev, 'park', HUMAN), done('HOLD_PARKED', rev));
  await landHoldOps(fx, p);
  return { p, rev, bare };
}

async function leave(fx: CoreFixture, p: PeerFixture): Promise<void> {
  p.core.outbox.add({ type: 'leave' });
  for (let i = 0; i < 6 && p.core.outbox.size > 0; i++) await win(fx, p);
  assert.equal(p.core.outbox.size, 0, 'the leave op landed');
}

test('05 I9 copy-restore: after peer 0\'s revert record mirrors and peer 0\'s leave op folds, a fresh clone\'s --restore of that record creates a new local record and restores it byte-exact from held/<id>/, leaving peer 0\'s folded record untouched', T10, async () => {
  await withCores('copy-restore', { n: 2, files: FILES }, async (fx) => {
    const { p, rev, bare } = await peerZeroRecords(fx);
    await leave(fx, p);
    const q = fx.peers[1]!;
    assert.deepEqual(q.core.holds.all(), [], 'a fresh clone: no registry record');
    const it = await prepIt(q, { forceFetch: true, holdPaths: [P, Q] });
    assert.equal(it.fold.peers[p.core.peerId]?.status, 'left', "precondition: peer 0's leave op folded");
    const folded = { rev: it.fold.holds[rev], bare: it.fold.holds[bare] };
    for (const [id, path, held, guards] of [[rev, P, t9([2, 'two']), ['revert']], [bare, Q, t9([8, 'late']), []]] as const) {
      const res = await resolve(q.core, it, id, 'restore', HUMAN);
      assert.equal(res.kind, 'done', JSON.stringify(res));
      const created = res.kind === 'done' ? res.created : null;
      assert.ok(created !== null && created !== id, 'a NEW local record');
      assert.deepEqual(res, done('HOLD_RESTORED', id, created));
      const copy = q.core.holds.get(created)!;
      assert.equal(copy.owner, q.core.peerId);
      assert.deepEqual([copy.origin, copy.displaced_by, copy.kind, copy.paths, copy.guards.map((g) => g.name)], ['human', null, 'PATCH', [path], [...guards]], "origin human, displaced_by null, peer 0's kind, paths and guards");
      assert.deepEqual([copy.residence, copy.state], ['ON_DISK', 'ACTIVE'], 'restored');
      assert.deepEqual(await readWork(q, path), Buffer.from(held), 'byte-exact from held/<id>/');
      assert.equal(q.core.holds.get(id), undefined, 'the foreign record is never adopted');
    }
    const after = (await prep(q)).fold;
    assert.deepEqual({ rev: after.holds[rev], bare: after.holds[bare] }, folded, "peer 0's folded records untouched");
    assert.equal(q.core.outbox.drafts().some((d) => d.type === 'hold' && (d.hold_id === rev || d.hold_id === bare)), false, 'no op for the foreign records');
  });
});

test('a copy-restore whose RESTORE does not complete leaves no copy behind (it ends GONE, no hold op) and returns the refusal; repeated once the file is free it restores from a fresh copy', T10, async () => {
  await withCores('copy-restore-locked', { n: 2, files: FILES }, async (fx) => {
    const { p, rev } = await peerZeroRecords(fx);
    await leave(fx, p);
    const q = fx.peers[1]!;
    const it = await prepIt(q, { forceFetch: true, holdPaths: [P] });
    assert.equal(it.fold.peers[p.core.peerId]?.status, 'left', "precondition: peer 0's leave op folded");
    // A share-none holder on the target: the copy's RESTORE meets it (LOCKED).
    const release = q.fs.holdLock(`${sep}${P.replace('/', sep)}`, 'share-none');
    let res: ResolveResult;
    try {
      res = await resolve(q.core, it, rev, 'restore', HUMAN);
    } finally {
      release();
    }
    assert.deepEqual(res, { kind: 'locked', paths: [P] });
    assert.deepEqual(q.core.holds.nonTerminal(), [], 'no copy is left behind as a live record');
    const [gone, ...more] = q.core.holds.all();
    assert.deepEqual([gone?.state, more.length], ['GONE', 0], 'the one copy made ended GONE, as a failed collision capture does (R3-67)');
    assert.deepEqual(q.core.holds.local().inflight, {}, 'no inflight entry');
    await mirrorSync(q.core, it);
    assert.equal(q.core.outbox.drafts().some((d) => d.type === 'hold'), false, 'and it is never mirrored');
    assert.equal((await readWork(q, P))?.toString('utf8'), T9, 'nothing written');
    // Repeated once the file is free: a fresh copy, restored.
    const it2 = await prepIt(q, { forceFetch: true, holdPaths: [P] });
    const again = await resolve(q.core, it2, rev, 'restore', HUMAN);
    const created = again.kind === 'done' ? again.created : null;
    assert.ok(created !== null && created !== gone!.id, JSON.stringify(again));
    assert.deepEqual(again, done('HOLD_RESTORED', rev, created));
    assert.equal((await readWork(q, P))?.toString('utf8'), t9([2, 'two']), 'restored byte-exact');
  });
});

test('R3-EF4-30 (EF5 merge Z-4): a copy-restore whose copy HLD-07 attaches to an ON_DISK record of this peer (the same change, already on the disk) answers HOLD_RESTORED with no write, as --restore of an ON_DISK record does — never restore()\'s TypeError', T10, async () => {
  await withCores('copy-restore-onto-ondisk', { n: 2, files: FILES }, async (fx) => {
    const { p, rev } = await peerZeroRecords(fx);
    await leave(fx, p);
    const q = fx.peers[1]!;
    // q holds the same change itself, ON_DISK: an ACTIVE revert PATCH over P with peer 0's pair (base A[P], held 'two').
    await writeWork(q, P, t9([2, 'two']));
    const it0 = await prepIt(q, { holdPaths: [P] });
    const own = await q.core.holds.hold(nr({ paths: [P], blobs: pair(it0.A.get(P)!.oid, await blob(q, t9([2, 'two']))) }));
    assert.deepEqual([q.core.holds.get(own)!.residence, q.core.holds.get(own)!.state], ['ON_DISK', 'ACTIVE']);
    const it = await prepIt(q, { forceFetch: true, holdPaths: [P] });
    assert.equal(it.fold.peers[p.core.peerId]?.status, 'left', "precondition: peer 0's leave op folded");
    const res = await resolve(q.core, it, rev, 'restore', HUMAN);
    assert.deepEqual(res, done('HOLD_RESTORED', rev, own), 'the copy attached to q\'s own ON_DISK record: its bytes are on the disk');
    const r = q.core.holds.get(own)!;
    assert.deepEqual([r.residence, r.state, r.guards.map((g) => g.name)], ['ON_DISK', 'ACTIVE', ['revert']], 'the record is left as it is');
    assert.equal(q.core.holds.all().length, 1, 'no copy record is created');
    assert.deepEqual(q.core.holds.local().inflight, {}, 'no restore was started');
    assert.equal((await readWork(q, P))?.toString('utf8'), t9([2, 'two']), 'nothing written');
  });
});

// G2 #8 (2026-10-20 audit; HLD-64, HLD-07, ruling R3-EF4-30; probe scratchpad/audit/probes-p3engine/probe.copyRestoreK4.test.ts): the copy
// of a departed peer's OFF_DISK CONFLICTED K4 record took this peer's own ON_DISK record over the same path through attachOf's K4 branch —
// its pair replaced by the foreign stages, CONFLICTED, `conflict` added (a fake TAKE_TIP displacement) — and the Z-4 early return answered
// HOLD_RESTORED with nothing restored. The K4 branch is an ON_DISK stage call's only: the copy is a NEW record and is restored.
test('G2 #8: a copy-restore of a departed peer\'s K4 record over a path where this peer holds its own, different ON_DISK record restores a NEW copy and leaves this peer\'s record untouched (never its stages, never CONFLICTED)', T10, async () => {
  await withCores('copy-restore-k4-own', { n: 2, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const it0 = await prepIt(p, { materialize: false });
    const a = it0.A.get(P)!.oid;
    const s2 = await blob(p, t9([2, 'peer0-local']));
    // Peer 0: an OFF_DISK CONFLICTED K4 stage record (its displaced local side s2), mirrored with held/<id>/s1,s2,s3; then it leaves.
    const k4 = await p.core.holds.hold(nr({
      paths: [P], residence: 'OFF_DISK', state: 'CONFLICTED', guard: 'conflict', origin: 'daemon',
      blobs: { s1: { [P]: a }, s2: { [P]: s2 }, s3: { [P]: await blob(p, t9([2, 'team-tip'])) } },
    }));
    await landHoldOps(fx, p);
    await leave(fx, p);
    const q = fx.peers[1]!;
    // q: its own ON_DISK revert PATCH over P holding another change (row 6).
    await writeWork(q, P, t9([6, 'q-own']));
    const itq = await prepIt(q, { holdPaths: [P] });
    const own = await q.core.holds.hold(nr({ paths: [P], blobs: pair(itq.A.get(P)!.oid, await blob(q, t9([6, 'q-own']))) }));
    const before = q.core.holds.get(own)!;
    const it = await prepIt(q, { forceFetch: true, holdPaths: [P] });
    assert.equal(it.fold.peers[p.core.peerId]?.status, 'left', "precondition: peer 0's leave op folded");
    const res = await resolve(q.core, it, k4, 'restore', HUMAN);
    const created = res.kind === 'done' ? res.created : null;
    assert.ok(created !== null && created !== own && created !== k4, `a NEW local record: ${JSON.stringify(res)}`);
    assert.deepEqual(res, done('HOLD_RESTORED', k4, created));
    assert.deepEqual(q.core.holds.get(own), before, "this peer's own record is untouched");
    const copy = q.core.holds.get(created)!;
    assert.deepEqual([copy.residence, copy.state, copy.guards.map((g) => g.name), copy.origin], ['ON_DISK', 'ACTIVE', [], 'human'], 'the copy restored, its displacement released');
    assert.equal((await readWork(q, P))?.toString('utf8'), t9([2, 'peer0-local'], [6, 'q-own']), "peer 0's change is on the disk, q's kept");
  });
});

test('the same restore without a folded leave op is refused HOLD_NOT_OWNER', T10, async () => {
  await withCores('copy-restore-no-leave', { n: 2, files: FILES }, async (fx) => {
    const { rev } = await peerZeroRecords(fx);
    const q = fx.peers[1]!;
    const it = await prepIt(q, { forceFetch: true, holdPaths: [P] });
    assert.ok(it.fold.holds[rev] !== undefined, 'precondition: the fold names the record');
    const head = q.core.holds.head();
    assert.deepEqual(await resolve(q.core, it, rev, 'restore', HUMAN), { kind: 'refused', code: 'HOLD_NOT_OWNER', params: { hid: rev } });
    assert.equal(q.core.holds.head(), head, 'no record created');
    assert.equal((await readWork(q, P))?.toString('utf8'), T9, 'nothing written');
  });
});

// ---- final review F14: a copy-restore never writes a path this PC quarantines (SEC-31/SEC-33, glossary §16, INV-SANITIZE) ----

/**
 * A hostile teammate forges one board commit on the current tip — join (so its ops attribute), a `hold` op over a
 * quarantined path with a held/<id>/h1 blob (the fold checks only owner/prev_rev/the stub rule/held presence; LIVE-ness is
 * writer-side only, PRO-21), then a `leave` op — and pushes it. Returns the forged hold id and the planted bytes.
 */
async function forgeQuarantinedRecord(fx: CoreFixture, p: PeerFixture, path: string, bytes: Buffer): Promise<{ hid: string }> {
  const repo = p.core.repo;
  const refs = refNames('main', RELEASE_NAMESPACE);
  const f = await fetchRefs(repo, fx.remote.url, refs.fetchSpecs);
  const T = f.values.get(refs.remoteBoard);
  assert.ok(T !== undefined && T !== ABSENT, 'the board tip is fetched');
  const b = await repo.readCommit(T);
  const tip = b.parents[b.parents.length - 1]!;
  // Keep the forged commit off a checkpoint height (height 1 after bootstrap), so it carries protocol/checkpoint by oid.
  const height = (await repo.firstParentCount(T)) - 2 + 1;
  assert.notEqual(height % CHECKPOINT_EVERY, 0, 'precondition: the forged commit is not at a checkpoint height');
  const rnd = seededRandom('forger');
  const peer = newPeerId(rnd);
  const epoch = newEpoch(rnd);
  const writer = { peer, epoch, seq: 4 };
  const oid = await repo.hashBytes(bytes, true);
  const hid = '01J9ZQ3C5X000000000000000A';
  const ops: Op[] = [
    { id: `${peer}/${epoch}/1`, ...(await joinDraft(p.core)), display: 'Victim Name' } as Op,
    { id: `${peer}/${epoch}/2`, type: 'hold', hold_id: hid, rev: 1, prev_rev: null, kind: 'PATCH', residence: 'OFF_DISK', state: 'PARKED', offer: 'none', guards: [], paths: [path], origin: 'human', cs_ids: [], peer_authors: [], local_only: false },
    { id: `${peer}/${epoch}/3`, type: 'leave' },
  ];
  const board = await buildBoardCommit(repo, { prevBoard: T, liveCode: tip, writer, ops, cs: [], csPaths: new Map(), protocol: null, checkpoint: null, held: { put: new Map([[hid, [{ stage: 'h1', path, oid }]]]), remove: new Set() } });
  const out = await runPush(repo, fx.remote.url, [pushSpec(board, refs.remoteBoard, T)], []);
  assert.equal(out.statuses.get(refs.remoteBoard), 'ok', 'the forged board pushed');
  return { hid };
}

test('F14: a human copy-restore of a forged record over a quarantined path (.claude/settings.json) writes nothing and creates no record', T10, async () => {
  const QPATH = '.claude/settings.json';
  const EVIL = buf('{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"calc.exe"}]}]}}\n');
  await withCores('copy-restore-quarantine', { n: 2, files: FILES }, async (fx) => {
    const forger = fx.peers[0]!;
    const { hid } = await forgeQuarantinedRecord(fx, forger, QPATH, EVIL);
    const q = fx.peers[1]!;
    const it = await prepIt(q, { forceFetch: true, holdPaths: [QPATH] });
    assert.equal(it.scope(QPATH).cls, 'QUARANTINED', 'precondition: the path is quarantined on this PC (glossary §16)');
    assert.ok(it.fold.holds[hid] !== undefined, 'precondition: the forged record folded');
    const head = q.core.holds.head();
    const before = await readWork(q, QPATH);

    const res = await resolve(q.core, it, hid, 'restore', HUMAN);
    // Final review F13 r2 (E-4): the refusal names each path's scope class and reason; `quarantine-review` (SEC-33's review)
    // is the guard only because the path is QUARANTINED.
    const notLive = [{ path: QPATH, cls: 'QUARANTINED', reason: it.scope(QPATH).reason }];
    assert.deepEqual(res, { kind: 'refused', code: 'HOLD_GUARDS_REMAIN', params: { hid, guards: ['quarantine-review'], not_live: notLive } }, JSON.stringify(res));
    assert.deepEqual(await readWork(q, QPATH), before, 'the quarantined execution surface is never written (SEC-31)');
    assert.equal(q.core.holds.head(), head, 'no copy record is created');
    assert.deepEqual(q.core.holds.all(), [], 'nothing in the registry');
  });
});

test('E-4: a copy-restore over a path this PC does not sync for another reason than quarantine (.gitignore: save-only) is refused with that class and reason, not labelled quarantine-review', T10, async () => {
  const PATH = '.gitignore';
  await withCores('copy-restore-save-only', { n: 2, files: FILES }, async (fx) => {
    const { hid } = await forgeQuarantinedRecord(fx, fx.peers[0]!, PATH, buf('*.log\n'));
    const q = fx.peers[1]!;
    const it = await prepIt(q, { forceFetch: true, holdPaths: [PATH] });
    assert.ok(it.fold.holds[hid] !== undefined, 'precondition: the forged record folded');
    const head = q.core.holds.head();
    const before = await readWork(q, PATH);
    const res = await resolve(q.core, it, hid, 'restore', HUMAN);
    // The copy-restore requested the path's attributes (R3-71), so this iteration's scope classifies it now.
    const s = it.scope(PATH);
    assert.ok(s.cls !== 'LIVE' && s.cls !== 'QUARANTINED' && s.reason === 'save-only', `precondition: ${PATH} is not synced here, for save-only (${JSON.stringify(s)})`);
    assert.deepEqual(res,{ kind: 'refused', code: 'HOLD_GUARDS_REMAIN', params: { hid, guards: [], not_live: [{ path: PATH, cls: s.cls, reason: 'save-only' }] } }, JSON.stringify(res));
    assert.deepEqual(await readWork(q, PATH), before, 'nothing written');
    assert.equal(q.core.holds.head(), head, 'no copy record is created');
  });
});

// The '.' escape ('./.claude/settings.json', '.vscode/./tasks.json', …) is refused at parse: validPathSyntax now rejects a
// '.' component, so parseOpLine makes such a hold op a deterministic no-op at the fold (test/unit/ops.test.ts 'malformed
// lines parse to null') and serializeOps refuses to even build it on the writer side — so it never reaches a copy-restore.

/**
 * A hostile teammate hand-builds a board commit on the current tip whose held/ is a deduplicated tree bomb (a tiny root
 * reached by astronomically many paths) and pushes it. buildBoardCommit cannot express this (a put is a flat blob list), so
 * the tree is built by hand: the previous board's ops.jsonl/protocol.json/checkpoint carried by oid, held/ swapped for the
 * bomb. Returns the forged tip oid.
 */
async function pushBombTip(fx: CoreFixture, p: PeerFixture): Promise<Oid> {
  const repo = p.core.repo;
  const refs = refNames('main', RELEASE_NAMESPACE);
  const f = await fetchRefs(repo, fx.remote.url, refs.fetchSpecs);
  const T = f.values.get(refs.remoteBoard);
  assert.ok(T !== undefined && T !== ABSENT, 'the board tip is fetched');
  const commit = await repo.readCommit(T);
  const liveTip = commit.parents[commit.parents.length - 1]!;
  const x = await repo.hashBytes(buf('x\n'), true);
  const t3 = await repo.mktree(Array.from({ length: 100 }, (_, i) => ({ name: `f${String(i).padStart(5, '0')}`, mode: '100644', type: 'blob', oid: x } as MktreeEntry)));
  const t2 = await repo.mktree(Array.from({ length: 100 }, (_, i) => ({ name: `d${String(i).padStart(5, '0')}`, mode: '040000', type: 'tree', oid: t3 } as MktreeEntry)));
  const t1 = await repo.mktree([{ name: 'h0', mode: '040000', type: 'tree', oid: t2 }]);
  const ulid = (i: number): string => `01J9ZQ3C5X${String(i).padStart(16, '0')}`;
  const held = await repo.mktree(Array.from({ length: 50 }, (_, i) => ({ name: ulid(i), mode: '040000', type: 'tree', oid: t1 } as MktreeEntry)));
  const recs = (await repo.run(['ls-tree', '-z', commit.tree])).stdout.toString('utf8').split('\0').filter((s) => s.length > 0);
  const top = recs.map((rec): MktreeEntry => {
    const tab = rec.indexOf('\t');
    const [mode = '', type = '', oid = ''] = rec.slice(0, tab).split(' ');
    return { name: rec.slice(tab + 1), mode: mode as MktreeEntry['mode'], type: type as MktreeEntry['type'], oid: oid as Oid };
  }).filter((e) => e.name !== 'held');
  const tree = await repo.mktree([...top, { name: 'held', mode: '040000', type: 'tree', oid: held }]);
  const rnd = seededRandom('bomb-forger');
  const writer = { peer: newPeerId(rnd), epoch: newEpoch(rnd), seq: 4 };
  const board = await repo.commitTree({ tree, parents: [T, liveTip], subject: BOARD_SUBJECT, trailers: boardTrailers(writer, [], new Map()) });
  const out = await runPush(repo, fx.remote.url, [pushSpec(board, refs.remoteBoard, T)], []);
  assert.equal(out.statuses.get(refs.remoteBoard), 'ok', 'the bomb board pushed');
  return board;
}

test('F13 end-to-end: a bomb board tip makes a peer enter a board_shape incident, not crash, and stays so on the next fetch (no held/ expansion, no crash loop)', T10, async () => {
  await withCores('bomb-tip-incident', { n: 2, files: FILES }, async (fx) => {
    const bomb = await pushBombTip(fx, fx.peers[0]!);
    const q = fx.peers[1]!;
    let threw: unknown = null;
    let r;
    try {
      r = await prepareIteration(q.core, 1, { materialize: 'auto', forceFetch: true });
    } catch (e) {
      threw = e;
    }
    assert.equal(threw, null, 'preparing the iteration never throws (no OOM, no uncaught error)');
    assert.ok(r !== undefined && !r.ok && r.why === 'incident', `a board_shape incident, not a fold: ${JSON.stringify(r)}`);
    assert.equal(r.verdict.why, 'board_shape', 'the over-cap held/ bomb reads as board_shape');
    assert.equal(r.T, bomb, 'observed the bomb tip');
    // A second fetch of the same tip stays an incident (the crash loop the finding describes would instead re-crash).
    const r2 = await prepareIteration(q.core, 2, { materialize: 'auto', forceFetch: true });
    assert.ok(!r2.ok && r2.why === 'incident' && r2.verdict.why === 'board_shape', `still an incident: ${JSON.stringify(r2)}`);
  });
});
