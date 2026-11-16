// Mirroring and durability of hold records on EngineCores over real clones of a file:// remote (Plan 3 Task 4; glossary §7,
// §9; 05-holds F3, F6, HLD-04, HLD-10, HLD-62, HLD-64; PRO-21 writer side, PRO-27; D-12, D-18, D-19, DAT-43, DAT-46;
// rulings R3-24…R3-29, R3-56): mirrorSync drafts one op per mirror-worthy change, Bnew carries the held/<id>/ subtrees of the
// ops it places, local_only records are content-free stubs, compaction removes held/ subtrees, terminal records are never
// re-mirrored, unreadable held blobs are never drafted and the tip's held/ tree is read once per board oid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readBoardCommit, type HeldBlob } from '../../src/board/boardCommit.js';
import { foldCommit } from '../../src/board/fold.js';
import type { OpDraft } from '../../src/board/ops.js';
import { mirrorSync, publishStep } from '../../src/engine/publish.js';
import type { Oid } from '../../src/git/oid.js';
import { heldBlobs } from '../../src/holds/mirror.js';
import { gitCallsOf, type PeerFixture } from '../helpers/coreFixture.js';
import { T9, t9 } from '../helpers/maskFixture.js';
import {
  durableAt, durableNow, heldIn, holdOpsOf, holdOpsSince, holdPatch, remoteTip, win,
} from '../helpers/mirrorFixture.js';
import { buf, LogRecorder, prep, pushCalls, stateA, withCores } from '../helpers/publishHelpers.js';
import { restartCore } from '../helpers/startFixture.js';
import { tallBoard } from '../helpers/tallBoard.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const P = 'src/t9.txt';
const FILES: Record<string, Buffer> = {
  'README.md': buf('# mirror fixture\n'),
  [P]: buf(T9),
  'src/a.txt': buf('a1\na2\na3\n'),
  '.gitignore': buf('*.log\n'),
};
const freezeEvent = (): OpDraft => ({ type: 'event', cid: '', kind: 'freeze', refs: [], reason_code: 'FREEZE_EPOCH' });

/** The mirror trace events of peer p. */
function mirrorEvents(fx: Parameters<Parameters<typeof withCores>[2]>[0], p: PeerFixture): Array<{ bnew: string; holds: unknown }> {
  return fx.trace.ofKind('mirror').filter((e) => e.peer === p.core.peerId).map((e) => ({ bnew: e.bnew, holds: e.holds }));
}

/** The oid of tree `<board>:held/<id>` (null when absent). */
async function heldTreeOid(p: PeerFixture, board: Oid, id: string): Promise<string | null> {
  const r = await p.core.repo.run(['rev-parse', '--verify', '--quiet', `${board}:held/${id}`], { okCodes: [0, 1, 128] });
  return r.code === 0 ? r.stdout.toString('utf8').trim() : null;
}

test('a new record is mirrored by the next publish with its held/ subtree and becomes durable', T10, async () => {
  await withCores('mirror-new', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prep(p);
    const { id, h0, h1 } = await holdPatch(p, P, t9([4, 'four held']));
    assert.equal(await durableNow(p, id), false, 'never mirrored');
    const { r } = await win(fx, p);
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    assert.equal(r.c, null, 'P == A: a board-only push');
    assert.deepEqual(r.mirrored, [id]);
    const ops = await holdOpsOf(p, r.bnew!);
    assert.deepEqual(ops.map((o) => [o.hold_id, o.rev, o.prev_rev, o.local_only]), [[id, 1, null, false]]);
    assert.deepEqual(await heldIn(p, r.bnew!, id), [{ stage: 'h0', path: P, oid: h0 as Oid }, { stage: 'h1', path: P, oid: h1 }] satisfies HeldBlob[]);
    assert.deepEqual(mirrorEvents(fx, p), [{ bnew: r.bnew!, holds: [{ id, rev: 1, localOnly: false, held: 2 }] }]);
    assert.equal(await durableNow(p, id), true, 'durable after the next fold');
  });
});

test('a durable record drafts nothing more; an age flush or a declines change keeps it durable', T10, async () => {
  await withCores('mirror-quiet', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prep(p);
    const { id } = await holdPatch(p, P, t9([4, 'four held']));
    assert.equal((await win(fx, p)).r.outcome, 'landed');
    const tip = await remoteTip(fx, p);
    const pushes = pushCalls(p);
    for (let i = 0; i < 10; i++) {
      const { r } = await win(fx, p);
      assert.deepEqual([r.outcome, r.attempted], ['nothing', false], `window ${i}`);
    }
    assert.equal(await remoteTip(fx, p), tip, 'zero hold ops: nothing pushed');
    assert.equal(pushCalls(p), pushes);
    const rev = p.core.holds.get(id)!.rev;
    fx.advance(5_000);
    assert.ok((await p.core.holds.flushAgeAnchors()) >= 1);
    assert.equal(p.core.holds.get(id)!.rev, rev + 1, 'the age flush is a new rev');
    await p.core.holds.transition(id, { declines: 2 });
    for (let i = 0; i < 3; i++) assert.equal((await win(fx, p)).r.outcome, 'nothing');
    assert.equal(p.core.outbox.size, 0, 'nothing drafted');
    assert.equal(pushCalls(p), pushes);
    assert.equal(await durableNow(p, id), true, 'still durable at an older folded rev');
  });
});

test('a guard release mirrors exactly one op chained on the folded rev', T10, async () => {
  await withCores('mirror-release', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prep(p);
    const { id } = await holdPatch(p, P, t9([4, 'four held']));
    assert.equal((await win(fx, p)).r.outcome, 'landed');
    await p.core.holds.addGuard(id, 'join');
    assert.equal((await win(fx, p)).r.outcome, 'landed');
    const it = await prep(p);
    assert.equal(it.fold.holds[id]?.rev, 2, 'durable at folded rev 2');
    assert.equal(await durableAt(p, it, id), true);
    const before = await remoteTip(fx, p);
    await p.core.holds.releaseGuard(id, 'join');
    const { r } = await win(fx, p);
    assert.equal(r.outcome, 'landed');
    for (let i = 0; i < 3; i++) assert.equal((await win(fx, p)).r.outcome, 'nothing');
    const ops = await holdOpsSince(p, before, await remoteTip(fx, p));
    assert.deepEqual(ops.map((x) => [x.op.hold_id, x.op.rev, x.op.prev_rev, x.op.guards.map((g) => g.name)]), [[id, 3, 2, ['revert']]]);
  });
});

test('a held-side refresh replaces an unsent draft and chains on a sent one', T10, async () => {
  await withCores('mirror-refresh', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const it0 = await prep(p);
    const { id, h0 } = await holdPatch(p, P, t9([4, 'v1']));
    // An unsent draft (no seq yet), then a transition changing h1: the draft is replaced.
    assert.deepEqual((await mirrorSync(p.core, it0)).drafted, [id]);
    const v2 = await p.core.repo.hashBytes(buf(t9([4, 'v2'])), true);
    await p.core.holds.transition(id, { blobs: { h0: { [P]: h0 }, h1: { [P]: v2 } } });
    assert.deepEqual((await mirrorSync(p.core, it0)).drafted, [id]);
    assert.equal(p.core.outbox.size, 1, 'one pending op for the record');
    const before = await remoteTip(fx, p);
    const { r } = await win(fx, p);
    assert.equal(r.outcome, 'landed');
    let ops = await holdOpsSince(p, before, r.bnew!);
    assert.deepEqual(ops.map((x) => [x.op.rev, x.op.prev_rev]), [[2, null]], 'one op in the next Bnew');
    assert.deepEqual((await heldIn(p, r.bnew!, id))?.find((b) => b.stage === 'h1')?.oid, v2, 'carrying the newest held/<id>/');
    // An allocated op whose push was rejected, then a transition: the next op chains on the sent op's rev.
    const v3 = await p.core.repo.hashBytes(buf(t9([4, 'v3'])), true);
    await p.core.holds.transition(id, { blobs: { h0: { [P]: h0 }, h1: { [P]: v3 } } });
    await fx.remote.rejectNext(1, 'transient-failed', '/board');
    const rejected = await win(fx, p);
    assert.equal(rejected.r.outcome, 'transient', JSON.stringify(rejected.r));
    const sent = p.core.outbox.allocatedHold(id);
    assert.deepEqual([sent?.rev, sent?.prev_rev], [3, 2], 'the sent op keeps its seq');
    const v4 = await p.core.repo.hashBytes(buf(t9([4, 'v4'])), true);
    await p.core.holds.transition(id, { blobs: { h0: { [P]: h0 }, h1: { [P]: v4 } } });
    const after = await remoteTip(fx, p);
    const landed = await win(fx, p, 31_000);
    assert.equal(landed.r.outcome, 'landed', JSON.stringify(landed.r));
    ops = await holdOpsSince(p, after, landed.r.bnew!);
    assert.deepEqual(ops.map((x) => [x.op.rev, x.op.prev_rev]), [[3, 2], [4, 3]], 'the new op has prev_rev = the sent op\'s rev');
    assert.equal((await heldIn(p, landed.r.bnew!, id))?.find((b) => b.stage === 'h1')?.oid, v4);
    assert.equal(await durableNow(p, id), true);
  });
});

test('a local_only record mirrors as a content-free stub', T10, async () => {
  await withCores('mirror-stub', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prep(p);
    const { id } = await holdPatch(p, '.env', 'TOKEN=1\n');
    assert.equal(p.core.holds.get(id)!.local_only, true, 'secret-like');
    const { r } = await win(fx, p);
    assert.equal(r.outcome, 'landed');
    const [op] = await holdOpsOf(p, r.bnew!);
    assert.deepEqual([op?.hold_id, op?.local_only, op?.paths], [id, true, ['.env']]);
    assert.equal(await heldIn(p, r.bnew!, id), null, 'no held/<id>/');
    assert.deepEqual(mirrorEvents(fx, p).at(-1)?.holds, [{ id, rev: 1, localOnly: true, held: 0 }]);
    const it = await prep(p);
    assert.equal(it.fold.holds[id]?.local_only, true, 'folded without rejection');
    assert.deepEqual(p.core.holds.local().rejected, {});
    assert.equal(await durableAt(p, it, id), false, 'a local_only record is never durable');
    assert.equal((await win(fx, p)).r.outcome, 'nothing', 'and it is not re-mirrored');
  });
});

test('a record that turns local_only removes its held/<id>/ in the same Bnew', T10, async () => {
  await withCores('mirror-turn-local', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prep(p);
    const { id } = await holdPatch(p, 'src/a.txt', 'a1\na2 held\na3\n');
    const first = await win(fx, p);
    assert.ok((await heldIn(p, first.r.bnew!, id)) !== null, 'mirrored with held/<id>/');
    await p.core.holds.addGuard(id, 'secret-scan');
    assert.equal(p.core.holds.get(id)!.local_only, true);
    const { r } = await win(fx, p);
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    const [op] = await holdOpsOf(p, r.bnew!);
    assert.deepEqual([op?.rev, op?.prev_rev, op?.local_only], [2, 1, true], 'the stub op');
    assert.equal(await heldIn(p, r.bnew!, id), null, 'held/<id>/ removed in the Bnew carrying the stub');
    const it = await prep(p);
    assert.equal(it.fold.holds[id]?.local_only, true, 'the fold accepts it');
    assert.deepEqual(p.core.holds.local().rejected, {}, 'no local_only_stub rejection');
  });
});

test('a K4 record mirrors its stages for a LIVE path and only a stub for a SAVE_ONLY path', T10, async () => {
  await withCores('mirror-k4', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prep(p);
    const A = await stateA(p);
    const k4 = async (path: string, local: string, team: string): Promise<{ id: string; s: [Oid, Oid, Oid] }> => {
      const s: [Oid, Oid, Oid] = [A.get(path)!.oid, await p.core.repo.hashBytes(buf(local), true), await p.core.repo.hashBytes(buf(team), true)];
      const id = await p.core.holds.hold({
        kind: 'PATCH', residence: 'OFF_DISK', state: 'CONFLICTED', paths: [path], blobs: { s1: { [path]: s[0] }, s2: { [path]: s[1] }, s3: { [path]: s[2] } },
        guard: 'conflict', origin: 'daemon', cs_ids: [], displaced_by: null,
      });
      return { id, s };
    };
    const live = await k4('src/a.txt', 'a1\na2 local\na3\n', 'a1\na2 team\na3\n');
    const save = await k4('.gitignore', '*.log\n*.tmp\n', '*.log\n*.bak\n');
    assert.equal(p.core.holds.get(save.id)!.local_only, true, 'SAVE_ONLY: local_only');
    const { r } = await win(fx, p);
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    assert.deepEqual(await heldIn(p, r.bnew!, live.id), [
      { stage: 's1', path: 'src/a.txt', oid: live.s[0] }, { stage: 's2', path: 'src/a.txt', oid: live.s[1] }, { stage: 's3', path: 'src/a.txt', oid: live.s[2] },
    ]);
    assert.equal(await heldIn(p, r.bnew!, save.id), null, 'no held/ entry for the SAVE_ONLY path');
    const ops = await holdOpsOf(p, r.bnew!);
    assert.deepEqual(ops.map((o) => [o.hold_id, o.local_only, o.state, o.residence]).sort(), [[live.id, false, 'CONFLICTED', 'OFF_DISK'], [save.id, true, 'CONFLICTED', 'OFF_DISK']].sort());
    assert.equal(await durableNow(p, live.id), true);
  });
});

test('a held/ blob with a restore-marker row never reaches the remote', T10, async () => {
  await withCores('mirror-marker', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const log = new LogRecorder();
    p.deps.log = log;
    await prep(p);
    const MARK = '||||||| cowork:base';
    const { id } = await holdPatch(p, P, `1\n2\n${MARK}\n3\n`);
    // Ruling R3-EF4-24 (DAT-46 defence in depth): such a record is created local_only, never refused, so it mirrors as the
    // content-free stub and the window lands — before the ruling its held/ put reached ENG-41 (j), which aborted every window
    // (that backstop is still there: publish.markerHeld.test.ts plants a record the registry did not make).
    assert.equal(p.core.holds.get(id)!.local_only, true, 'local_only: a content-free stub');
    const { r } = await win(fx, p);
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    assert.deepEqual((await holdOpsOf(p, r.bnew!)).map((o) => [o.hold_id, o.local_only]), [[id, true]], 'the stub op');
    assert.equal(await heldIn(p, r.bnew!, id), null, 'no held/<id>/');
    assert.ok(!log.lines.some((l) => l.code === 'NOT_CONVERGED'), log.text());
    // No object of the remote contains the row.
    const objs = spawnSync('git', ['--git-dir', fx.remote.dir, 'rev-list', '--objects', '--all'], { encoding: 'utf8' });
    assert.equal(objs.status, 0, objs.stderr);
    for (const o of objs.stdout.split('\n').filter((l) => l.length > 0).map((l) => l.split(' ')[0]!)) {
      const t = spawnSync('git', ['--git-dir', fx.remote.dir, 'cat-file', '-t', o], { encoding: 'utf8' }).stdout.trim();
      if (t !== 'blob') continue;
      const content = spawnSync('git', ['--git-dir', fx.remote.dir, 'cat-file', 'blob', o], { encoding: 'latin1' }).stdout;
      assert.ok(!content.includes(MARK), `blob ${o} holds a restore-marker row`);
    }
  });
});

test('RESOLVED_DISCARD is mirrored as one op and its held/ subtree stays until compaction', T10, async () => {
  await withCores('mirror-discard', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prep(p);
    const { id } = await holdPatch(p, P, t9([4, 'four held']));
    const { id: lo } = await holdPatch(p, '.env', 'TOKEN=1\n');
    const first = await win(fx, p);
    assert.equal(first.r.outcome, 'landed');
    const tree = await heldTreeOid(p, first.r.bnew!, id);
    assert.ok(tree !== null);
    await p.core.holds.transition(id, { state: 'RESOLVED_DISCARD' });
    await p.core.holds.transition(lo, { state: 'RESOLVED_DISCARD' });
    const before = await remoteTip(fx, p);
    const { r } = await win(fx, p);
    assert.equal(r.outcome, 'landed');
    const ops = await holdOpsSince(p, before, r.bnew!);
    assert.deepEqual(ops.map((x) => [x.op.hold_id, x.op.state, x.op.residence, x.op.local_only]).sort(), [[id, 'RESOLVED_DISCARD', null, false], [lo, 'RESOLVED_DISCARD', null, true]].sort(), 'one op each (a stub for local_only)');
    assert.equal(await heldTreeOid(p, r.bnew!, id), tree, 'held/<id>/ stays, by the same oid');
    assert.equal(await heldIn(p, r.bnew!, lo), null);
    // A later Bnew still carries it by the same oid.
    p.core.outbox.add(freezeEvent());
    const later = await win(fx, p);
    assert.equal(later.r.outcome, 'landed');
    assert.deepEqual(await holdOpsOf(p, later.r.bnew!), [], 'no further hold op');
    assert.equal(await heldTreeOid(p, later.r.bnew!, id), tree);
    const it = await prep(p);
    assert.equal(it.fold.holds[id]?.state, 'RESOLVED_DISCARD');
    assert.equal(await durableAt(p, it, id), true);
  });
});

test('INCOMING creation ops wait for creationDue and a record released earlier emits nothing', T10, async () => {
  await withCores('mirror-incoming', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prep(p);
    const A = await stateA(p);
    const incoming = async (guard: string, path: string): Promise<string> => {
      const tip = await p.core.repo.hashBytes(buf(`${path} from TIP\n`), true);
      return p.core.holds.hold({
        kind: 'INCOMING', residence: 'ON_DISK', state: 'ACTIVE', paths: [path], blobs: { h0: { [path]: A.get(path)!.oid }, h1: { [path]: tip } },
        guard, origin: 'daemon', cs_ids: [], displaced_by: null,
      });
    };
    const um = await incoming('unmaterializable', 'src/a.txt');
    const col = await incoming('collision', P);
    const tip0 = await remoteTip(fx, p);
    // Age 30 s: no op.
    fx.advance(30_000);
    assert.equal((await publishStep(p.core, await prep(p))).outcome, 'nothing', 'no op at age 30 s');
    assert.equal(p.core.outbox.size, 0);
    // The collision record is released (SUBSUMED) at age 40 s, before its creation op was due.
    fx.advance(10_000);
    await p.core.holds.transition(col, { state: 'SUBSUMED' });
    // Age 60 s: one op for the unmaterializable record.
    fx.advance(20_000);
    const { r } = await win(fx, p, 0);
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    for (let i = 0; i < 5; i++) await win(fx, p, 30_000);
    const ops = await holdOpsSince(p, tip0, await remoteTip(fx, p));
    assert.deepEqual(ops.map((x) => [x.op.hold_id, x.op.prev_rev]), [[um, null]], 'one op, and none ever for the released record');
  });
});

test('the pathless host-reject PIN\'s creation and terminal ops carry no held/ put', T10, async () => {
  await withCores('mirror-hostreject', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    p.core.outbox.add(freezeEvent());
    await prep(p);
    fx.advance(6_000);
    await fx.remote.rejectNext(3, 'policy', '/board');
    assert.equal((await publishStep(p.core, await prep(p))).outcome, 'transient');
    fx.advance(31_000);
    assert.equal((await publishStep(p.core, await prep(p))).outcome, 'transient');
    fx.advance(61_000);
    const r3 = await publishStep(p.core, await prep(p));
    assert.equal(r3.outcome, 'nonretryable', JSON.stringify(r3));
    const pin = p.core.holds.nonTerminal()[0]!;
    assert.deepEqual([pin.paths, heldBlobs(pin)], [[], []]);
    // Task 8's resume clears NONRETRYABLE; here the state is cleared by hand (the 3rd rejection's 120 s backoff passes).
    await p.core.commit({ meta: { ...p.core.view!.meta, nonretryable: null, rejections: null } });
    const { r } = await win(fx, p, 121_000);
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    assert.deepEqual((await holdOpsOf(p, r.bnew!)).map((o) => [o.hold_id, o.prev_rev, o.paths]), [[pin.id, null, []]]);
    assert.equal(await heldIn(p, r.bnew!, pin.id), null, 'no held/<id>/ for the creation op');
    let it = await prep(p);
    assert.equal(await durableAt(p, it, pin.id), true, 'durable on its folded entry alone');
    // resume ends it SUBSUMED with its guards unchanged (R3-39): the terminal op carries no held/ either.
    await p.core.holds.transition(pin.id, { state: 'SUBSUMED' });
    const t = await win(fx, p, 61_000);
    assert.equal(t.r.outcome, 'landed', JSON.stringify(t.r));
    assert.deepEqual((await holdOpsOf(p, t.r.bnew!)).map((o) => [o.state, o.guards.map((g) => g.name)]), [['SUBSUMED', ['host-reject']]]);
    assert.equal(await heldIn(p, t.r.bnew!, pin.id), null);
    it = await prep(p);
    assert.equal(it.fold.holds[pin.id]?.state, 'SUBSUMED', 'both fold without an own rejection');
    assert.deepEqual(p.core.holds.local().rejected, {});
  });
});

test('a record whose held-side blob cannot be read is not drafted', T10, async () => {
  await withCores('mirror-corrupt', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const log = new LogRecorder();
    p.deps.log = log;
    await prep(p);
    const { id, h1 } = await holdPatch(p, P, t9([4, 'only in this test: corrupt me']));
    const dir = join(p.deps.paths.gitDir, 'objects', h1.slice(0, 2));
    assert.ok(readdirSync(dir).includes(h1.slice(2)), 'the record blob is loose');
    const file = join(dir, h1.slice(2));
    chmodSync(file, 0o644);
    writeFileSync(file, Buffer.from('this is not a zlib stream', 'utf8'));
    p.core.outbox.add(freezeEvent());
    const { r } = await win(fx, p);
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    assert.equal(r.c, null, 'board-only');
    assert.deepEqual((await readBoardCommit(p.core.repo, r.bnew!)).opsLines.map((l) => (JSON.parse(l) as { type: string }).type), ['event'], 'the event only');
    assert.equal(p.core.outbox.pendingHold(id), null, 'no hold op for r is drafted');
    assert.equal(p.core.holdCode?.code, 'HOLD_MASK_INVALID');
    assert.ok(log.lines.some((l) => l.code === 'HOLD_MASK_INVALID' && l.params['hold_id'] === id), log.text());
    const pushes = pushCalls(p);
    const again = await win(fx, p);
    assert.deepEqual([again.r.attempted, again.r.outcome], [false, 'nothing'], 'nothing else pending: zero push attempts');
    assert.equal(pushCalls(p), pushes);
  });
});

test('HLD-64: a restart re-drafts every non-durable record before the first publish', T10, async () => {
  await withCores('mirror-hld64', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prep(p);
    const { id: durable } = await holdPatch(p, P, t9([4, 'four held']));
    assert.equal((await win(fx, p)).r.outcome, 'landed');
    const { id: fresh } = await holdPatch(p, 'src/a.txt', 'a1\na2 held\na3\n');
    await restartCore(p);
    const it = await prep(p);
    assert.equal(await durableAt(p, it, durable), true);
    assert.deepEqual(await mirrorSync(p.core, it), { drafted: [fresh], rejected: [] }, 'exactly one op, for the never-mirrored record');
    assert.equal(p.core.outbox.size, 1);
  });
});

test('heldOfTip reads the tip\'s held/ tree once per board oid', T10, async () => {
  await withCores('mirror-heldoftip', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prep(p);
    await holdPatch(p, P, t9([4, 'four held']));
    // A held/ listing starts with one `cat-file --batch-check` of `<board>:held` (final review F13 r2: the held/ walk, no ls-tree -r).
    const heldReads = (): number => gitCallsOf(p).filter((c) => c.args[0] === 'cat-file' && /^[0-9a-f]+:held\n$/.test(c.opts.stdin?.toString('utf8') ?? '')).length;
    const it = await prep(p);
    const n0 = heldReads();
    await mirrorSync(p.core, it);
    await mirrorSync(p.core, it);
    assert.equal(heldReads(), n0 + 1, 'two mirrorSync calls on the same tip make one held/ listing');
    await fx.pushTeamChange({ 'README.md': buf('# moved on\n') });
    const it2 = await prep(p);
    await mirrorSync(p.core, it2);
    await mirrorSync(p.core, it2);
    assert.equal(heldReads(), n0 + 2, 'a new tip makes one more');
  });
});

test('a terminal record with no folded entry and no pending or allocated op is never re-mirrored', T10, async () => {
  await withCores('mirror-terminal', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prep(p);
    // (a) A record mirrored and ended at a low height; the board grows past a compaction (768 ≡ 0 mod 256, terminal ≤ 768 − 512).
    const { id } = await holdPatch(p, P, t9([4, 'four held']));
    assert.equal((await win(fx, p)).r.outcome, 'landed');
    await p.core.holds.transition(id, { state: 'RESOLVED_DISCARD' });
    assert.equal((await win(fx, p)).r.outcome, 'landed');
    let it = await prep(p);
    const terminalAt = it.fold.holds[id]?.terminal_height;
    assert.ok(terminalAt !== undefined && terminalAt <= 256, 'terminal at a low height');
    await tallBoard(fx, p, it, 770, new Map([[768, { remove: [id] }]]));
    it = await prep(p);
    assert.equal(Object.hasOwn(it.fold.holds, id), false, 'compacted from the fold');
    const count = it.fold.record_count;
    const tip = await remoteTip(fx, p);
    for (let i = 0; i < 10; i++) assert.equal((await win(fx, p)).r.outcome, 'nothing');
    assert.equal(await remoteTip(fx, p), tip, 'zero hold ops');
    await restartCore(p);
    it = await prep(p);
    assert.deepEqual(await mirrorSync(p.core, it), { drafted: [], rejected: [] }, 'a restart drafts nothing for it');
    assert.equal(it.fold.record_count, count, 'record_count unchanged');
    // (b) An INCOMING collision record ended SUBSUMED at age 40 s, then a restart.
    const A = await stateA(p);
    const col = await p.core.holds.hold({
      kind: 'INCOMING', residence: 'ON_DISK', state: 'ACTIVE', paths: ['src/a.txt'],
      blobs: { h0: { 'src/a.txt': A.get('src/a.txt')!.oid }, h1: { 'src/a.txt': await p.core.repo.hashBytes(buf('team\n'), true) } },
      guard: 'collision', origin: 'daemon', cs_ids: [], displaced_by: null,
    });
    fx.advance(40_000);
    assert.deepEqual((await mirrorSync(p.core, await prep(p))).drafted, [], 'not due at 40 s');
    await p.core.holds.transition(col, { state: 'SUBSUMED' });
    fx.advance(60_000);
    await restartCore(p);
    assert.deepEqual(await mirrorSync(p.core, await prep(p)), { drafted: [], rejected: [] }, 'the fresh core drafts nothing for it');
  });
});

test('the Bnew at a compaction height removes the held/ subtrees of the holds the fold drops there', T10, async () => {
  await withCores('mirror-compact', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    let it = await prep(p);
    // A teammate's record: created with held/<R>/ at height 2, ended RESOLVED_DISCARD at height 400.
    const R = '01J9ZQ3C5X00000000000000R1';
    const blob = await p.core.repo.hashBytes(buf('a1\na2 team held\na3\n'), true);
    const op = (rev: number, prev: number | null, state: string, residence: string | null): Record<string, unknown> => ({
      type: 'hold', hold_id: R, rev, prev_rev: prev, kind: 'PATCH', residence, state, offer: 'none', guards: [{ name: 'revert', class: 'DECISION', owner: 'HLD' }],
      paths: ['src/a.txt'], origin: 'human', cs_ids: [], peer_authors: [], local_only: false,
    });
    const { tip } = await tallBoard(fx, p, it, 1023, new Map([
      [2, { ops: [op(1, null, 'ACTIVE', 'ON_DISK')], put: new Map([[R, [{ stage: 'h1' as const, path: 'src/a.txt', oid: blob }]]]) }],
      [400, { ops: [op(2, 1, 'RESOLVED_DISCARD', null)] }],
    ]));
    await prep(p);
    // 1,023 landings revealed by one fetch: the sliding team guard holds every attempt for 60 s (PRO-40).
    fx.advance(61_000);
    it = await prep(p);
    assert.equal(it.T, tip);
    assert.equal(it.fold.height, 1023);
    assert.equal(it.fold.holds[R]?.terminal_height, 400);
    assert.ok((await heldIn(p, tip, R)) !== null, 'the tip still carries held/<R>/');
    p.core.outbox.add(freezeEvent());
    const r = await publishStep(p.core, it);
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    const data = await readBoardCommit(p.core.repo, r.bnew!);
    assert.equal(await heldIn(p, r.bnew!, R), null, 'the Bnew at 1024 has no held/<R>/');
    const step = foldCommit(it.fold, data, p.core.peerId);
    assert.equal(step.state.height, 1024);
    assert.deepEqual(step.compactedHolds, [R], 'that fold\'s compactedHolds names it');
    assert.ok(data.checkpoint !== null, 'a checkpoint at 1024');
    await prep(p);
    assert.equal(p.core.folder.verification().checkpointMismatch, false, 'the checkpoint at 1024 matches the fold');
    assert.equal(p.core.folder.verification().verified?.height, 1024);
  });
});
