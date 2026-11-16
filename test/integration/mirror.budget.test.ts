// The push budget of hold mirrors (Plan 3 Task 4; 02-protocol PRO-06, PRO-38; 05-holds B2, HLD-10; T-PRO-16; INV-ONE-EVENT;
// rulings R3-25, R3-26): at the 5,000-record cap hold creations wait while ending and updating ops land and one BOARD_FULL
// health event goes out per episode; on a board the 5 MB tree cap refuses held/ puts on (R3-74; fix round 1 ruling) the
// put-carrying hold drafts wait while code, ending ops, stubs and events land; an op withheld at either cap after a failed
// push is never the base of a later op of its record (fix round 2: no prev_rev loop); hold-related pushes stay at or below the
// mirror-worthy transitions; a permanent record
// costs one op and then zero pushes. The long tests drive Plan 2's loop composition by hand (makeEngines and Engine.iterate
// are Plan 2 Tasks 17–20, not on this base, R3-72): mirrorFixture's loopOnce on every peer, every LOOP_MS of virtual time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_TREE_MAX_BYTES, readBoardCommit, type HeldBlob } from '../../src/board/boardCommit.js';
import { publishStep } from '../../src/engine/publish.js';
import type { IterationCtx } from '../../src/engine/core.js';
import type { Oid } from '../../src/git/oid.js';
import { T9, t9 } from '../helpers/maskFixture.js';
import { durableNow, heldIn, holdOpsOf, holdOpsSince, holdPatch, loopOnce, remoteTip, win } from '../helpers/mirrorFixture.js';
import { blobText, buf, editAndCapture, LogRecorder, prep, treeOf, withCores } from '../helpers/publishHelpers.js';
import { restartCore } from '../helpers/startFixture.js';
import { tallBoard } from '../helpers/tallBoard.js';
import type { CoreFixture, PeerFixture } from '../helpers/coreFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const P = 'src/t9.txt';
const FILES: Record<string, Buffer> = {
  'README.md': buf('# mirror budget fixture\n'),
  [P]: buf(T9),
  'src/a.txt': buf('a1\na2\na3\n'),
  'src/b.txt': buf('b1\nb2\nb3\n'),
  'src/c.txt': buf('c1\nc2\nc3\n'),
};
/**
 * The virtual time between two loop iterations of the long tests: the idle loop period is 10 s (ENG-13); one iteration per
 * 30 s keeps an hour of two peers to 240 prepared iterations on real git, and every mirror-worthy transition still reaches
 * the next iteration (the budget property counts pushes, which only iterations make).
 */
const LOOP_MS = 30_000;

/** One window at the record cap: the fold of the prepared iteration reads 5,000 folded records (PRO-06). */
async function capped(fx: CoreFixture, p: PeerFixture, advanceMs = 6_000): Promise<{ it: IterationCtx; r: Awaited<ReturnType<typeof publishStep>> }> {
  fx.advance(advanceMs);
  const it = await prep(p);
  it.fold = { ...it.fold, record_count: 5_000 };
  return { it, r: await publishStep(p.core, it) };
}

/** The BOARD_FULL health events of peer p's fold at the newest prepared iteration. */
async function boardFullEvents(p: PeerFixture): Promise<number> {
  const it = await prep(p);
  return Object.values(it.fold.events).filter((e) => e.kind === 'health' && e.reason_code === 'BOARD_FULL').length;
}

test('PRO-06: at 5,000 folded records hold creations are withheld while ending and updating ops land', T10, async () => {
  await withCores('mbudget-cap', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const log = new LogRecorder();
    p.deps.log = log;
    await prep(p);
    const { id: upd } = await holdPatch(p, 'src/a.txt', 'a1\na2 held\na3\n');
    await p.core.holds.addGuard(upd, 'join');
    const { id: end } = await holdPatch(p, 'src/b.txt', 'b1\nb2 held\nb3\n');
    assert.equal((await win(fx, p)).r.outcome, 'landed', 'both mirrored below the cap');
    await p.core.holds.releaseGuard(upd, 'join');
    await p.core.holds.transition(end, { state: 'RESOLVED_DISCARD' });
    const { id: fresh } = await holdPatch(p, P, t9([4, 'four held']));
    // At the cap: the update and the ending op land, the creation stays unallocated, one BOARD_FULL event goes out.
    const first = await capped(fx, p);
    assert.equal(first.r.outcome, 'landed', JSON.stringify(first.r));
    const ops = await holdOpsOf(p, first.r.bnew!);
    assert.deepEqual(ops.map((o) => [o.hold_id, o.state]).sort(), [[upd, 'ACTIVE'], [end, 'RESOLVED_DISCARD']].sort());
    assert.ok(p.core.outbox.pendingHold(fresh) !== null && p.core.outbox.allocatedHold(fresh) === null, 'the creation op waits unallocated');
    assert.equal(await boardFullEvents(p), 1, 'the BOARD_FULL event is not withheld');
    // 02-protocol §2.1: BOARD_FULL carries the params records and cap, in status and in the daemon log.
    const told = { records: '5000', cap: '5000' };
    assert.deepEqual(p.core.holdCode, { code: 'BOARD_FULL', params: told });
    assert.deepEqual(log.lines.filter((l) => l.code === 'BOARD_FULL').map((l) => [l.level, l.params]), [['warn', told]]);
    // Ten more windows at the cap: no second event, BOARD_FULL told once.
    for (let i = 0; i < 10; i++) assert.equal((await capped(fx, p)).r.outcome, 'nothing', `window ${i}`);
    assert.equal(await boardFullEvents(p), 1);
    assert.equal(log.lines.filter((l) => l.code === 'BOARD_FULL').length, 1, 'told once for the episode');
    // A fold already holding that event's cid drafts none (a restart inside the episode).
    await restartCore(p);
    assert.equal((await capped(fx, p)).r.outcome, 'nothing');
    assert.equal(await boardFullEvents(p), 1);
    // Compaction relieves the cap: the creation op lands.
    const relieved = await win(fx, p);
    assert.equal(relieved.r.outcome, 'landed', JSON.stringify(relieved.r));
    assert.deepEqual((await holdOpsOf(p, relieved.r.bnew!)).map((o) => [o.hold_id, o.prev_rev]), [[fresh, null]]);
    // A later cap episode drafts a new event.
    await holdPatch(p, 'src/c.txt', 'c1\nc2 held\nc3\n');
    const later = await capped(fx, p);
    assert.equal(later.r.outcome, 'landed', JSON.stringify(later.r));
    assert.deepEqual(await holdOpsOf(p, later.r.bnew!), [], 'the new creation waits');
    assert.equal(await boardFullEvents(p), 2, 'one new event for the new episode');
  });
});

/**
 * n h1 entries of 193-byte names (a 221-byte tree entry each with sha1 ids, the last one `lastExtra` bytes longer) on blob
 * x: one wide h1 tree object (Task 3's capBoards shape).
 */
function wide(x: Oid, n: number, tag: string, lastExtra = 0): HeldBlob[] {
  return Array.from({ length: n }, (_, i) => ({ stage: 'h1' as const, path: `${tag}-${String(i).padStart(6, '0')}-${'n'.repeat(i === n - 1 ? 180 + lastExtra : 180)}.txt`, oid: x }));
}

/** The §3.1 held/ part of `board` measured test-side from git objects: held/ and every tree object under it, at every path. */
async function heldSum(p: PeerFixture, board: Oid): Promise<number> {
  const repo = p.core.repo;
  const top = await repo.run(['rev-parse', '--verify', '--quiet', `${board}:held`], { okCodes: [0, 1, 128] });
  if (top.code !== 0) return 0;
  const heldOid = top.stdout.toString('utf8').trim();
  const listed = (await repo.run(['ls-tree', '-r', '-d', heldOid])).stdout.toString('utf8').split('\n').filter((l) => l.length > 0);
  const names = [heldOid, ...listed.map((l) => l.split('\t')[0]!.split(' ')[2]!)];
  const out = (await repo.run(['cat-file', '--batch-check'], { stdin: Buffer.from(`${names.join('\n')}\n`, 'utf8') })).stdout.toString('utf8');
  return out.split('\n').filter((l) => l.length > 0).reduce((a, l) => a + Number(l.split(' ')[2]), 0);
}

/** How far under the cap a teammate's over-cap board leaves its held/ part (the files then take the total over the cap). */
const HELD_SLACK = 50;

/**
 * Wide held/<id>/ puts for `ids` (the first ones 12,000 entries each, the last sized to fit) that bring the held/ part of a
 * board built on `board` to exactly BOARD_TREE_MAX_BYTES − HELD_SLACK. Final review F13 (02-protocol §3.1 reader rule): a
 * reader refuses a held/ over the cap (board_too_large), so a teammate that ignored the writer rule can leave only the TOTAL
 * over it — held/ just under, ops.jsonl + protocol.json + checkpoint/state.json (more than HELD_SLACK bytes) over the rest.
 * Each new id adds a 53-byte held/ entry (sha1) and a 29-byte <id> tree over its h1 tree.
 */
async function underCapPuts(p: PeerFixture, board: Oid, x: Oid, ids: readonly string[]): Promise<Map<string, HeldBlob[]>> {
  const ENTRY = 6 + 1 + 193 + 1 + 20;
  const SUBTREE = 5 + 1 + 26 + 1 + 20 + (5 + 1 + 2 + 1 + 20);   // the held/ entry and the <id> tree
  let left = BOARD_TREE_MAX_BYTES - HELD_SLACK - (await heldSum(p, board));
  const puts = new Map<string, HeldBlob[]>();
  ids.forEach((id, k) => {
    const tag = String.fromCharCode(97 + k);
    if (k < ids.length - 1) {
      puts.set(id, wide(x, 12_000, tag));
      left -= SUBTREE + 12_000 * ENTRY;
      return;
    }
    const bytes = left - SUBTREE;
    const n = Math.floor(bytes / ENTRY);
    puts.set(id, wide(x, n, tag, bytes - n * ENTRY));
  });
  return puts;
}
/** Two teammate hold ids whose wide held/ subtrees (underCapPuts: about 2.65 and 2.35 MB of tree objects) put the board over the cap together. */
const W1 = '01JA0000000000000000000001';
const W2 = '01JA0000000000000000000002';

/** The oid of tree `<board>:held/<id>` (null when absent). */
async function heldTreeOid(p: PeerFixture, board: Oid, id: string): Promise<string | null> {
  const r = await p.core.repo.run(['rev-parse', '--verify', '--quiet', `${board}:held/${id}`], { okCodes: [0, 1, 128] });
  return r.code === 0 ? r.stdout.toString('utf8').trim() : null;
}

/**
 * 02-protocol §3.1 measured test-side from git objects (not the writer's arithmetic): ops.jsonl + protocol.json +
 * checkpoint/state.json + every tree object under held/, held/ itself included.
 */
async function boardTotal(p: PeerFixture, board: Oid): Promise<number> {
  const repo = p.core.repo;
  const sizes = async (names: readonly string[]): Promise<number> => {
    const out = (await repo.run(['cat-file', '--batch-check'], { stdin: Buffer.from(`${names.join('\n')}\n`, 'utf8') })).stdout.toString('utf8');
    return out.split('\n').filter((l) => l.length > 0).reduce((a, l) => a + (l.endsWith(' missing') ? 0 : Number(l.split(' ')[2])), 0);
  };
  const files = await sizes([`${board}:ops.jsonl`, `${board}:protocol.json`, `${board}:checkpoint/state.json`]);
  const top = await repo.run(['rev-parse', '--verify', '--quiet', `${board}:held`], { okCodes: [0, 1, 128] });
  if (top.code !== 0) return files;
  const heldOid = top.stdout.toString('utf8').trim();
  // git's own listing of the tree objects under held/ (`-r -d`: trees only).
  const listed = (await repo.run(['ls-tree', '-r', '-d', heldOid])).stdout.toString('utf8').split('\n').filter((l) => l.length > 0);
  return files + (await sizes([heldOid, ...listed.map((l) => l.split('\t')[0]!.split(' ')[2]!)]));
}

test('a held/ put the 5 MB tree cap refuses is withheld while code, ending ops, stubs and events land (PRO-06, R3-74)', T10, async () => {
  await withCores('mbudget-tree', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const log = new LogRecorder();
    p.deps.log = log;
    // A window G (5 s) plus this peer's rank slot (S 1.5 s) after the fetch that last moved the tip: the teammate writers this
    // test plants join the fold (PRO-40).
    const W = 10_000;
    const told = (code: string): Array<{ code: string; params: unknown }> => log.lines.filter((l) => l.code === code).map((l) => ({ code: l.code, params: l.params }));
    await prep(p);
    const { id: end } = await holdPatch(p, 'src/b.txt', 'b1\nb2 held\nb3\n');
    const { id: upd } = await holdPatch(p, 'src/a.txt', 'a1\na2 held\na3\n');
    const first = await win(fx, p);
    assert.equal(first.r.outcome, 'landed', 'both mirrored below the cap');
    const endTree = await heldTreeOid(p, first.r.bnew!, end);
    assert.ok(endTree !== null, 'held/<end>/ on the board');
    // A teammate that ignored the writer cap leaves the board over 5,000,000 bytes: two wide held/ subtrees bring held/ to just
    // under the cap (the readers refuse a held/ over it, final review F13) and the files take the total over it, so every
    // reader still folds the board.
    let it = await prep(p);
    const x = await p.core.repo.hashBytes(buf('x\n'), true);
    const h = it.fold.height + 1;
    const { tip: over } = await tallBoard(fx, p, it, h, new Map([[h, { put: await underCapPuts(p, it.T as Oid, x, [W1, W2]) }]]), 'tree-cap/over');
    await prep(p);   // the fetch that reveals the planted tip anchors the governor
    assert.equal(await heldSum(p, over), BOARD_TREE_MAX_BYTES - HELD_SLACK, 'held/ alone is within the cap');
    assert.ok((await boardTotal(p, over)) > BOARD_TREE_MAX_BYTES, 'the board is over the cap');

    // Pending: a code edit, an ending op (end), a stub creation (local_only) and two ops that put held/ (upd's update, fresh's creation).
    await p.core.holds.transition(end, { state: 'RESOLVED_DISCARD' });
    await p.core.holds.addGuard(upd, 'join');
    const { id: fresh } = await holdPatch(p, 'src/c.txt', 'c1\nc2 held\nc3\n');
    const { id: stub } = await holdPatch(p, '.env', 'TOKEN=1\n');
    assert.equal(p.core.holds.get(stub)!.local_only, true, 'a content-free stub');
    await editAndCapture(fx, p, { 'README.md': '# mirror budget fixture, edited\n' });
    const w = await win(fx, p, W);
    assert.equal(w.r.outcome, 'landed', JSON.stringify({ r: w.r, buildFailed: told('PUBLISH_BUILD_FAILED') }));
    // The code commit lands.
    assert.ok(w.r.c !== null, 'a code commit');
    assert.equal((await readBoardCommit(p.core.repo, w.r.bnew!)).liveCode, w.r.c);
    assert.equal(await blobText(p, await treeOf(p, w.r.c!), 'README.md'), '# mirror budget fixture, edited\n');
    // The ending op and the stub land without a put; the ops that put held/ wait unchanged in the outbox.
    const ops = await holdOpsOf(p, w.r.bnew!);
    assert.deepEqual(ops.map((o) => [o.hold_id, o.state, o.local_only]).sort(), [[end, 'RESOLVED_DISCARD', false], [stub, 'ACTIVE', true]].sort());
    assert.deepEqual([...w.r.mirrored].sort(), [end, stub].sort());
    assert.equal(await heldTreeOid(p, w.r.bnew!, end), endTree, 'held/<end>/ carried by the same oid, never re-put');
    assert.equal(await heldIn(p, w.r.bnew!, fresh), null, 'no held/<fresh>/');
    assert.ok(p.core.outbox.pendingHold(fresh) !== null && p.core.outbox.allocatedHold(fresh) === null, 'the creation waits unallocated');
    assert.ok(p.core.outbox.pendingHold(upd) !== null, 'the update waits');
    // BOARD_FULL {records, cap} to status and the log, once; no build failure.
    const params = { records: String(w.it.fold.record_count), cap: String(BOARD_TREE_MAX_BYTES) };
    assert.deepEqual(p.core.holdCode, { code: 'BOARD_FULL', params });
    assert.deepEqual(told('BOARD_FULL'), [{ code: 'BOARD_FULL', params }]);
    assert.deepEqual(told('PUBLISH_BUILD_FAILED'), []);
    it = await prep(p);
    assert.equal(it.fold.holds[end]?.state, 'RESOLVED_DISCARD', 'the ending op folded');
    assert.equal(it.fold.holds[stub]?.local_only, true, 'the stub folded');

    // The next window sends the episode's one BOARD_FULL health event; then nothing is pushed while only withheld puts wait.
    const ev = await win(fx, p, W);
    assert.equal(ev.r.outcome, 'landed', JSON.stringify(ev.r));
    assert.deepEqual(await holdOpsOf(p, ev.r.bnew!), []);
    assert.equal(await boardFullEvents(p), 1);
    const quiet = await remoteTip(fx, p);
    for (let i = 0; i < 10; i++) assert.equal((await win(fx, p, W)).r.outcome, 'nothing', `window ${i}`);
    assert.equal(await remoteTip(fx, p), quiet, 'zero pushes');
    assert.equal(await boardFullEvents(p), 1);
    assert.equal(told('BOARD_FULL').length, 1, 'told once for the episode');
    assert.deepEqual(told('PUBLISH_BUILD_FAILED'), []);

    // A teammate's removal brings the board under the cap: the withheld update and creation land with their held/ puts.
    it = await prep(p);
    const h2 = it.fold.height + 1;
    await tallBoard(fx, p, it, h2, new Map([[h2, { remove: [W2] }]]), 'tree-cap/relief');
    await prep(p);
    const relieved = await win(fx, p, W);
    assert.equal(relieved.r.outcome, 'landed', JSON.stringify(relieved.r));
    assert.deepEqual((await holdOpsOf(p, relieved.r.bnew!)).map((o) => o.hold_id).sort(), [upd, fresh].sort());
    assert.ok((await heldIn(p, relieved.r.bnew!, fresh)) !== null, 'the creation carries its held/ subtree');
    assert.equal(await durableNow(p, fresh), true);
    assert.equal(await durableNow(p, upd), true);

    // A later over-cap board is a new episode: BOARD_FULL is told again and its event lands.
    it = await prep(p);
    const h3 = it.fold.height + 1;
    const { tip: overAgain } = await tallBoard(fx, p, it, h3, new Map([[h3, { put: await underCapPuts(p, it.T as Oid, x, [W2]) }]]), 'tree-cap/again');
    await prep(p);
    assert.equal(await heldSum(p, overAgain), BOARD_TREE_MAX_BYTES - HELD_SLACK, 'held/ alone is within the cap again');
    assert.ok((await boardTotal(p, overAgain)) > BOARD_TREE_MAX_BYTES, 'the board is over the cap again');
    const { id: later } = await holdPatch(p, P, t9([4, 'four held']));
    const again = await win(fx, p, W);
    assert.equal(again.r.outcome, 'nothing', JSON.stringify(again.r));
    assert.ok(p.core.outbox.pendingHold(later) !== null && p.core.outbox.allocatedHold(later) === null, 'the new creation waits');
    assert.equal(told('BOARD_FULL').length, 2, 'one more for the new episode');
    assert.equal((await win(fx, p, W)).r.outcome, 'landed');
    assert.equal(await boardFullEvents(p), 2);
    assert.deepEqual(told('PUBLISH_BUILD_FAILED'), []);
  });
});

/** The allocated (sent, not landed) op of record `id` as [rev, prev_rev]; null when none. */
function sentOf(p: PeerFixture, id: string): [number, number | null] | null {
  const op = p.core.outbox.allocatedHold(id);
  return op === null ? null : [op.rev, op.prev_rev];
}

/**
 * A record r mirrored below the cap (rev 1 folded), then r's update (join added, registry rev 2, an op that puts held/<r>/)
 * sent in a window the host rejects '(failed)': the op keeps its seq, allocated and never landed. Then a teammate leaves the
 * board over the 5 MB tree cap (the shape of the tree-cap test above) and this peer fetches it.
 */
async function sentThenOverCap(fx: CoreFixture, p: PeerFixture, seed: string): Promise<string> {
  await prep(p);
  const { id } = await holdPatch(p, 'src/a.txt', 'a1\na2 held\na3\n');
  assert.equal((await win(fx, p)).r.outcome, 'landed', 'rev 1 folded');
  await p.core.holds.addGuard(id, 'join');
  await fx.remote.rejectNext(1, 'transient-failed', '/board');
  const rejected = await win(fx, p);
  assert.equal(rejected.r.outcome, 'transient', JSON.stringify(rejected.r));
  assert.deepEqual(sentOf(p, id), [2, 1], 'the update is allocated and did not land');
  const it = await prep(p);
  const x = await p.core.repo.hashBytes(buf('x\n'), true);
  const h = it.fold.height + 1;
  const { tip } = await tallBoard(fx, p, it, h, new Map([[h, { put: await underCapPuts(p, it.T as Oid, x, [W1, W2]) }]]), seed);
  await prep(p);   // the fetch that reveals the planted tip anchors the governor
  assert.equal(await heldSum(p, tip), BOARD_TREE_MAX_BYTES - HELD_SLACK, 'held/ alone is within the cap (final review F13)');
  assert.ok((await boardTotal(p, tip)) > BOARD_TREE_MAX_BYTES, 'the board is over the cap');
  return id;
}

/** After r's terminal op landed in `ended`: it folded (no prev_rev rejection), nothing of r is pending, and ten windows push nothing. */
async function endedAndQuiet(fx: CoreFixture, p: PeerFixture, id: string, W: number): Promise<void> {
  const it = await prep(p);
  assert.equal(it.fold.holds[id]?.state, 'RESOLVED_DISCARD', 'the terminal op folded without a rejection');
  assert.equal(p.core.outbox.pendingHold(id), null, 'nothing of r is pending');
  const quiet = await remoteTip(fx, p);
  for (let i = 0; i < 10; i++) assert.equal((await win(fx, p, W)).r.outcome, 'nothing', `window ${i}`);
  assert.equal(await remoteTip(fx, p), quiet, 'zero pushes');
}

test('a put-carrying op withheld by the tree cap after a failed push is dropped, so the record\'s terminal op chains on the folded rev and lands once (fix round 2)', T10, async () => {
  await withCores('mbudget-tree-end', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const W = 10_000;   // G plus the teammate's rank slot (PRO-40), as in the tree-cap test above
    const id = await sentThenOverCap(fx, p, 'tree-end/over');
    // The first window on the over-cap tip: the put is refused, the allocated update is withheld (the tree-cap episode opens).
    const held = await win(fx, p, 31_000);
    assert.equal(held.r.outcome, 'nothing', JSON.stringify(held.r));
    assert.deepEqual(sentOf(p, id), [2, 1], 'the update stays allocated, withheld');
    // r ends: exactly one terminal op, chained on the folded rev 1 (never on the withheld op's rev 2).
    await p.core.holds.transition(id, { state: 'RESOLVED_DISCARD' });
    const ended = await win(fx, p, W);
    assert.equal(ended.r.outcome, 'landed', JSON.stringify(ended.r));
    assert.deepEqual((await holdOpsOf(p, ended.r.bnew!)).map((o) => [o.hold_id, o.state, o.prev_rev]), [[id, 'RESOLVED_DISCARD', 1]]);
    await endedAndQuiet(fx, p, id, W);
  });
});

test('a terminal op sent beside a tree-cap-withheld op of its record is re-drafted on the folded rev, never re-sent on the withheld rev (fix round 2)', T10, async () => {
  await withCores('mbudget-tree-split', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const W = 10_000;
    const id = await sentThenOverCap(fx, p, 'tree-split/over');
    // r ends before any window saw the over-cap tip: its terminal op is drafted on the allocated update (rev 2); the build
    // with puts is refused, the rebuild withholds the update and sends the terminal op alone, and the host rejects that push.
    await p.core.holds.transition(id, { state: 'RESOLVED_DISCARD' });
    await fx.remote.rejectNext(1, 'transient-failed', '/board');
    const lost = await win(fx, p, 31_000);
    assert.equal(lost.r.outcome, 'transient', JSON.stringify(lost.r));
    assert.deepEqual((await holdOpsOf(p, lost.r.bnew!)).map((o) => [o.hold_id, o.state, o.prev_rev]), [[id, 'RESOLVED_DISCARD', 2]]);
    assert.deepEqual(sentOf(p, id), [3, 2], 'the update and the terminal op are both allocated');
    // The next window (after the second rejection's 60 s backoff): one terminal op on the folded rev 1, folded; then nothing.
    const ended = await win(fx, p, 61_000);
    assert.equal(ended.r.outcome, 'landed', JSON.stringify(ended.r));
    assert.deepEqual((await holdOpsOf(p, ended.r.bnew!)).map((o) => [o.hold_id, o.state, o.prev_rev]), [[id, 'RESOLVED_DISCARD', 1]]);
    await endedAndQuiet(fx, p, id, W);
  });
});

test('a creation withheld at the record cap after a failed push is never the base of its record\'s later update or terminal op (fix round 2)', T10, async () => {
  await withCores('mbudget-cap-chain', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prep(p);
    const start = await remoteTip(fx, p);
    const { id: upd } = await holdPatch(p, 'src/a.txt', 'a1\na2 held\na3\n');
    const { id: end } = await holdPatch(p, 'src/b.txt', 'b1\nb2 held\nb3\n');
    // Below the cap both creations are sent in a window the host rejects: allocated, never landed.
    await fx.remote.rejectNext(1, 'transient-failed', '/board');
    assert.equal((await win(fx, p)).r.outcome, 'transient');
    assert.deepEqual([sentOf(p, upd), sentOf(p, end)], [[1, null], [1, null]]);
    // upd's update is chained on its allocated creation and sent in a second rejected window: both of upd's ops are allocated.
    await p.core.holds.addGuard(upd, 'join');
    await fx.remote.rejectNext(1, 'transient-failed', '/board');
    assert.equal((await win(fx, p, 31_000)).r.outcome, 'transient');
    assert.deepEqual(sentOf(p, upd), [2, 1]);
    // end ends while its creation waits.
    await p.core.holds.transition(end, { state: 'RESOLVED_DISCARD' });
    // At the cap the creations are withheld; no op of upd or end may leave chained on them (the fold holds neither record).
    const first = await capped(fx, p, 61_000);
    assert.equal(first.r.outcome, 'landed', JSON.stringify(first.r));
    assert.deepEqual(await holdOpsOf(p, first.r.bnew!), [], 'no hold op leaves: only the BOARD_FULL event');
    assert.equal(p.core.outbox.pendingHold(end), null, 'end never reached the board: nothing to mirror (R3-26)');
    const pending = p.core.outbox.pendingHold(upd);
    assert.deepEqual([pending?.rev, pending?.prev_rev, pending?.guards.map((g) => g.name)], [2, null, ['revert', 'join']], 'upd waits as one creation');
    assert.equal(p.core.outbox.allocatedHold(upd), null, 'unallocated');
    for (let i = 0; i < 10; i++) assert.equal((await capped(fx, p)).r.outcome, 'nothing', `window ${i}`);
    // Relief: upd's creation lands and folds; end never appears on the board.
    const relieved = await win(fx, p);
    assert.equal(relieved.r.outcome, 'landed', JSON.stringify(relieved.r));
    assert.equal(await durableNow(p, upd), true);
    const ops = await holdOpsSince(p, start, await remoteTip(fx, p));
    assert.deepEqual(ops.map((x) => [x.op.hold_id, x.op.rev, x.op.prev_rev]), [[upd, 2, null]], 'one op ever landed: upd\'s creation');
    assert.equal((await prep(p)).fold.holds[end], undefined);
  });
});

test('05 B2: hold-related pushes stay at or below mirror-worthy transitions', T10, async () => {
  await withCores('mbudget-b2', { n: 2, files: FILES }, async (fx) => {
    const [p1, p2] = [fx.peers[0]!, fx.peers[1]!];
    for (const p of fx.peers) await prep(p);
    const start = await remoteTip(fx, p1);
    const { id } = await holdPatch(p1, P, t9([4, 'permanent revert']));   // one permanent revert record
    let joined = false;
    let worthy = 1;   // the creation
    for (let t = LOOP_MS, k = 0; t <= 3_600_000; t += LOOP_MS) {
      for (const p of [p1, p2]) await loopOnce(p);
      fx.advance(LOOP_MS);
      if (t % 300_000 !== 0) continue;
      // A scripted transition every 5 min: flushAgeAnchors (not mirror-worthy) and addGuard/releaseGuard of join alternately.
      k += 1;
      if (k % 2 === 1) {
        await p1.core.holds.flushAgeAnchors();
      } else {
        if (joined) await p1.core.holds.releaseGuard(id, 'join');
        else await p1.core.holds.addGuard(id, 'join');
        joined = !joined;
        worthy += 1;
      }
    }
    for (const p of [p1, p2]) await loopOnce(p);
    assert.equal(worthy, 7, 'creation + 6 guard changes');
    const carriers = new Set((await holdOpsSince(p1, start, await remoteTip(fx, p1))).map((x) => x.board));
    assert.ok(carriers.size >= 1 && carriers.size <= worthy, `pushes carrying a hold op: ${carriers.size} ≤ ${worthy}`);
    void p2;
  });
});

test('T-PRO-16 Plan 3 part: 90 minutes with one permanent PATCH and no edits give exactly one hold op, then zero pushes', T10, async () => {
  await withCores('mbudget-tpro16', { n: 2, files: FILES }, async (fx) => {
    const [p1, p2] = [fx.peers[0]!, fx.peers[1]!];
    for (const p of fx.peers) await prep(p);
    const start = await remoteTip(fx, p1);
    // The non-escalating guard generated? (HLD-60's 10-minute event is for revert records only).
    const { id } = await holdPatch(p1, P, t9([4, 'generated']), 'generated?');
    let firstLanding: number | null = null;
    for (let t = 0; t < 90 * 60_000; t += LOOP_MS) {
      for (const p of [p1, p2]) {
        const { r } = await loopOnce(p);
        if (r.outcome === 'landed' && firstLanding === null) firstLanding = fx.trace.events.length;
      }
      fx.advance(LOOP_MS);
    }
    const ops = await holdOpsSince(p1, start, await remoteTip(fx, p1));
    assert.deepEqual(ops.map((x) => [x.op.hold_id, x.op.prev_rev]), [[id, null]], 'the creation mirror is the only op');
    assert.ok(firstLanding !== null);
    const after = fx.trace.events.slice(firstLanding).filter((e) => e.kind === 'push');
    assert.deepEqual(after, [], 'zero push attempts for the remaining time');
    void p2;
  });
});
