// The hold fold on a real board chain (Plan 3 Task 3; F4, F5 fold side, PRO-21, INV-PRO-FOLD): genesis and checkpoint folds
// of a hold-emitting board agree byte for byte, Folders of different peers report the same own-rejection set per writer,
// and Folder.takeHoldRejections drains the own hold rejections. Real git on a file:// clone; the board is written by
// importBoard (held/<id>/ subtrees included).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { WriterId } from '../../src/board/boardCommit.js';
import { canonicalJson, type Json } from '../../src/board/canonicalJson.js';
import { CHECKPOINT_EVERY, Folder, foldCommit, initialFoldState, parseFold, serializeFold, type FoldState, type OwnRejection } from '../../src/board/fold.js';
import { genesisProtocol } from '../../src/board/protocol.js';
import type { Oid } from '../../src/git/oid.js';
import { foldAll, generateBoard, genDraft, honestCheckpoints, importBoard, type GenBoard } from '../helpers/foldBoard.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };
/** The full forms of the long sweeps run only with COWORK_SIM_LONG=1 (the nightly job); every push runs the fast forms. */
const LONG = process.env['COWORK_SIM_LONG'] === '1';

/** The board: 600 commits in the full form, 540 in the fast form (its prefix; both cross the compactions at 256 and 512). */
const N = LONG ? 600 : 540;
const LIVE = '1'.repeat(40) as Oid;
const fixtures: RepoFixture[] = [];
after(async () => {
  for (const f of fixtures) await f.cleanup();
});

const bytes = (s: FoldState): Buffer => serializeFold(s);
const same = (a: FoldState, b: FoldState): boolean => bytes(a).equals(bytes(b));

/** The own rejections writer `self` gets for heights from..to, folded over `states` (any peer's chain of states). */
function rejectionsOf(gen: GenBoard, states: readonly FoldState[], self: string, from: number, to: number): OwnRejection[] {
  const out: OwnRejection[] = [];
  for (let h = from; h <= to; h++) {
    const prev = h === 0 ? initialFoldState(gen.protocol) : states[h - 1]!;
    out.push(...foldCommit(prev, genDraft(gen, gen.commits[h]!, LIVE), self).ownRejections);
  }
  return out;
}

test('INV-PRO-FOLD with holds: genesis and checkpoint folds agree and own rejections are identical', T10, async () => {
  const gen = generateBoard('folder-holds', N, { holds: true, peers: 3 });
  assert.equal(gen.peers.length, 3);
  const states = new Map(gen.peers.map((p) => [p, foldAll(gen, p, LIVE)] as const));
  const ref = states.get(gen.peers[0]!)!;
  const refBytes = ref.map(bytes);
  // The fold state does not depend on who folds.
  for (const p of gen.peers.slice(1)) {
    const mine = states.get(p)!;
    for (let h = 0; h < N; h++) assert.ok(bytes(mine[h]!).equals(refBytes[h]!), `${p} at ${h}`);
  }
  // The generated board exercises the hold fold: records of every peer, revs beyond 1, terminal records, every own
  // rejection reason, and compaction of the B0 hold at 512.
  const final = ref[N - 1]!;
  const owners = new Set(Object.values(final.holds).map((h) => h.owner));
  assert.equal(owners.size, 3, 'every peer owns a record');
  assert.ok(Object.values(final.holds).some((h) => h.rev > 2), 'valid chains');
  assert.ok(Object.values(final.holds).some((h) => h.terminal_height !== undefined), 'terminal records');
  assert.ok(Object.values(final.holds).some((h) => h.local_only) && Object.values(final.holds).some((h) => h.paths.length === 0), 'stubs and pathless PINs');
  const all = gen.peers.flatMap((p) => rejectionsOf(gen, ref, p, 1, N - 1));
  const reasons = new Set(all.filter((x) => x.type === 'hold').map((x) => x.reason));
  for (const reason of ['prev_rev', 'type', 'local_only_stub', 'held_subtree', 'validator'] as const) assert.ok(reasons.has(reason), `a ${reason} rejection`);
  assert.ok(gen.b0HoldId !== undefined);
  assert.equal(ref[511]!.holds[gen.b0HoldId]?.terminal_height, 0);
  assert.equal(ref[512]!.holds[gen.b0HoldId], undefined, 'compaction at 512 dropped the B0 hold');
  assert.ok(Object.keys(ref[N - 1]!.holds).length > 20);

  // From genesis (foldAll above, from B0's checkpoint in the full form) and from every honest checkpoint, the pure fold is
  // byte-identical at every later height.
  const honest = honestCheckpoints(ref);
  assert.deepEqual([...honest.keys()], [0, CHECKPOINT_EVERY, 2 * CHECKPOINT_EVERY]);
  for (const [c, ck] of honest) {
    if (c === 0 && !LONG) continue;
    let s = parseFold(ck);
    assert.ok(s !== null, `checkpoint ${c} parses`);
    for (let h = c + 1; h < N; h++) {
      s = foldCommit(s, genDraft(gen, gen.commits[h]!, LIVE), gen.peers[1]!).state;
      assert.ok(bytes(s).equals(refBytes[h]!), `from checkpoint ${c}: height ${h}`);
    }
  }
  // Folding B0 from the empty state gives its checkpoint.
  assert.ok(bytes(foldCommit(initialFoldState(gen.protocol), genDraft(gen, gen.commits[0]!, LIVE), gen.peers[2]!).state).equals(honest.get(0)!));

  // Real git: Folders of different peers fold to the same state, byte-verify the checkpoints they pass, and each reports
  // exactly its writer's own rejections as any other peer's fold computes them. Fast form (every push): P1 from height 500
  // (crossing the checkpoint at 512) and a joiner of P2 (from the checkpoint at 512). Full form (COWORK_SIM_LONG=1; ~950
  // more commit reads): also P0 from genesis and P1 from the checkpoint at 256.
  const f = await makeRepoFixture('folder-holds');
  fixtures.push(f);
  const A = (await importBoard(f.repo, 'refs/cowork-test/holds', gen, honest)).oids;
  const [P0, P1, P2] = gen.peers as [string, string, string];
  const runs: Array<{ what: string; self: string; from: number; other: string }> = [
    { what: 'P1 from 500', self: P1, from: 500, other: P2 },
    ...(LONG ? [{ what: 'P0 from genesis', self: P0, from: 0, other: P2 }, { what: 'P1 from 256', self: P1, from: 256, other: P0 }] : []),
  ];
  let holdRejections = 0;
  for (const run of runs) {
    const folder = new Folder(f.repo, run.self);
    const start = run.from;
    const out = await folder.foldTo(A[N - 1]!, { board: A[start]!, state: start % CHECKPOINT_EVERY === 0 ? parseFold(honest.get(start)!)! : ref[start]! }, 'rs-1');
    assert.ok(same(out.state, ref[N - 1]!), `${run.what}: the state at ${N - 1}`);
    assert.equal(out.version.checkpointMismatch, false, run.what);
    assert.deepEqual(folder.verification(), { verified: { board: A[512]!, height: 512 }, checkpointMismatch: false }, run.what);
    // Per writer: what its own Folder reports equals the fold of another peer's chain of states with that writer as self.
    assert.deepEqual(out.ownRejections, rejectionsOf(gen, states.get(run.other)!, run.self, start + 1, N - 1), run.what);
    // The hold rejections are drained in the same order.
    assert.deepEqual(folder.takeHoldRejections(), out.ownRejections.filter((x) => x.type === 'hold'), run.what);
    holdRejections += out.ownRejections.filter((x) => x.type === 'hold').length;
  }
  // A joiner of the third peer (from the checkpoint at 512) agrees too.
  const joiner = new Folder(f.repo, P2);
  const out2 = await joiner.foldTo(A[N - 1]!, null, 'rs-1');
  assert.ok(same(out2.state, ref[N - 1]!));
  assert.deepEqual(out2.ownRejections, rejectionsOf(gen, states.get(P1)!, P2, 513, N - 1));
  assert.deepEqual(joiner.takeHoldRejections(), out2.ownRejections.filter((x) => x.type === 'hold'));
  holdRejections += out2.ownRejections.filter((x) => x.type === 'hold').length;
  assert.ok(holdRejections > 0, 'the Folders reported own hold rejections');
});

const P = 'a1'.repeat(16);
const Q = 'b2'.repeat(16);
const E = 'e1'.repeat(16);
const ID1 = '01J9ZQ3C5X0000000000000001';
const ID2 = '01J9ZQ3C5X0000000000000002';
const L = (o: Record<string, unknown>): string => canonicalJson(o as Json);
const opId = (peer: string, seq: number): string => `${peer}/${E}/${seq}`;
const joinL = (peer: string, seq: number): string => L({
  id: opId(peer, seq), type: 'join', display: 'Peer', plugin_version: '0.3.0', plugin_sha: 'f'.repeat(64), proto: 1, regionSpec: 'rs-1',
  config_fingerprint: { filters: {}, autocrlf: '', eol_attrs: '', git: '2.47.1' }, coauthor_optin: false,
});
const holdL = (peer: string, seq: number, holdId: string, rev: number, prevRev: number | null, o: Record<string, unknown> = {}): string => L({
  id: opId(peer, seq), type: 'hold', hold_id: holdId, rev, prev_rev: prevRev, kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', offer: 'none',
  guards: [{ name: 'revert', class: 'DECISION', owner: 'HLD' }], paths: ['src/a.ts'], origin: 'human', cs_ids: [], peer_authors: [], local_only: false, ...o,
});

test('Folder.takeHoldRejections drains the own hold rejections folded since the last call', T10, async () => {
  const w = (peer: string, seq: number): WriterId => ({ peer, epoch: E, seq });
  const gen: GenBoard = {
    protocol: genesisProtocol(12, 'rs-1'), peers: [P, Q], b0SeatKey: '',
    commits: [
      { writer: w(P, 2), lines: [joinL(P, 1)] },
      { writer: w(Q, 2), lines: [joinL(Q, 1)] },
      { writer: w(P, 5), lines: [holdL(P, 3, ID1, 1, null), holdL(P, 4, ID2, 1, null, { local_only: true })], heldIds: [ID1, ID2] },   // ID2: local_only_stub
      { writer: w(P, 8), lines: [holdL(P, 6, ID1, 2, 1), L({ id: opId(P, 7), type: 'seat_end', seat_id: 'c'.repeat(32), permission_mode: 'default' })], heldIds: [ID1] },   // seat_end: 'type'
      { writer: w(P, 10), lines: [holdL(P, 9, ID1, 4, 1)], heldIds: [ID1] },                                                            // ID1: prev_rev (folded 2)
      { writer: w(Q, 4), lines: [holdL(Q, 3, ID1, 3, 2)], heldIds: [ID1] },                                                             // Q's non-owner op: not P's
    ],
  };
  const states = foldAll(gen, P, LIVE);
  const f = await makeRepoFixture('folder-drain');
  fixtures.push(f);
  const A = (await importBoard(f.repo, 'refs/cowork-test/drain', gen, honestCheckpoints(states))).oids;
  const folder = new Folder(f.repo, P);
  assert.deepEqual(folder.takeHoldRejections(), [], 'nothing folded yet');
  // One call over three commits (heights 2..4), with two own hold rejections and one non-hold rejection of P.
  const out = await folder.foldTo(A[4]!, { board: A[1]!, state: states[1]! }, 'rs-1');
  assert.equal(out.newCommits.length, 3);
  const stub: OwnRejection = { opId: opId(P, 4), type: 'hold', reason: 'local_only_stub', holdId: ID2, foldedRev: null };
  const seatEnd: OwnRejection = { opId: opId(P, 7), type: 'seat_end', reason: 'type', holdId: null, foldedRev: null };
  const stale: OwnRejection = { opId: opId(P, 9), type: 'hold', reason: 'prev_rev', holdId: ID1, foldedRev: 2 };
  assert.deepEqual(out.ownRejections, [stub, seatEnd, stale], 'FoldOutcome.ownRejections keeps every own rejection');
  // Both hold rejections, oldest first, then nothing; the non-hold rejection stays in FoldOutcome.ownRejections only.
  assert.deepEqual(folder.takeHoldRejections(), [stub, stale]);
  assert.deepEqual(folder.takeHoldRejections(), []);
  // A later call that folds a teammate's commit, or nothing, adds nothing.
  const more = await folder.foldTo(A[5]!, { board: A[4]!, state: out.state }, 'rs-1');
  assert.deepEqual(more.ownRejections, []);
  await folder.foldTo(A[5]!, { board: A[5]!, state: more.state }, 'rs-1');
  assert.deepEqual(folder.takeHoldRejections(), []);
  // Re-folding heights this Folder already reported (a `from` behind them, or a joiner's fold from the checkpoint) reports
  // nothing again, drained or not: the queue is keyed by (height, op id).
  await folder.foldTo(A[4]!, { board: A[1]!, state: states[1]! }, 'rs-1');
  assert.deepEqual(folder.takeHoldRejections(), [], 'a re-fold of drained heights');
  await folder.foldTo(A[3]!, { board: A[1]!, state: states[1]! }, 'rs-1');
  await folder.foldTo(A[4]!, { board: A[1]!, state: states[1]! }, 'rs-1');
  await folder.foldTo(A[5]!, null, 'rs-1');
  assert.deepEqual(folder.takeHoldRejections(), [], 'repeated re-folds accumulate no duplicate');
  // Q's Folder drains only Q's own hold rejection (its non-owner op).
  const qf = new Folder(f.repo, Q);
  await qf.foldTo(A[5]!, null, 'rs-1');
  assert.deepEqual(qf.takeHoldRejections(), [{ opId: opId(Q, 3), type: 'hold', reason: 'type', holdId: ID1, foldedRev: 2 }]);
  // A re-fold that has not been drained yet does not double the queue either.
  await qf.foldTo(A[5]!, { board: A[1]!, state: states[1]! }, 'rs-1');
  await qf.foldTo(A[5]!, { board: A[2]!, state: states[2]! }, 'rs-1');
  assert.deepEqual(qf.takeHoldRejections(), []);
});

/**
 * A board for the P2-REFOLD tests. Height 0 (B0, P): P's join and a local_only stub carried with its held/ subtree (a
 * local_only_stub rejection). Heights 1–2: Q joins, P creates ID1. Then `empty` empty commits of P, then one commit of P
 * with ID1 rev 2 (valid) and a stale rev 3 with prev_rev 1 (a prev_rev rejection, folded rev 2), then one empty commit.
 */
function refoldBoard(empty: number): { gen: GenBoard; v3: number } {
  const w = (peer: string, seq: number): WriterId => ({ peer, epoch: E, seq });
  const commits: GenBoard['commits'] = [
    { writer: w(P, 3), lines: [joinL(P, 1), holdL(P, 2, ID2, 1, null, { local_only: true })], heldIds: [ID2] },
    { writer: w(Q, 2), lines: [joinL(Q, 1)] },
    { writer: w(P, 5), lines: [holdL(P, 4, ID1, 1, null)], heldIds: [ID1] },
  ];
  // P's empty commits use writer seqs 6.. (each above the last); the two ops come after them.
  let seq = 5;
  for (let i = 0; i < empty; i++) commits.push({ writer: w(P, ++seq), lines: [], heldIds: [ID1] });
  commits.push({ writer: w(P, seq + 3), lines: [holdL(P, seq + 1, ID1, 2, 1), holdL(P, seq + 2, ID1, 3, 1)], heldIds: [ID1] });
  commits.push({ writer: w(P, seq + 4), lines: [], heldIds: [ID1] });
  return { gen: { protocol: genesisProtocol(12, 'rs-1'), peers: [P, Q], b0SeatKey: '', commits }, v3: seq + 2 };
}

/** importBoard with honest checkpoints except B0's, which is not the fold of B0: a fold from genesis hits P2-REFOLD at 0. */
async function importRefoldBoard(label: string, gen: GenBoard, states: readonly FoldState[]): Promise<RepoFixture & { A: Oid[] }> {
  const checkpoints = new Map(honestCheckpoints(states));
  checkpoints.set(0, serializeFold(initialFoldState(gen.protocol)));
  const f = await makeRepoFixture(label);
  fixtures.push(f);
  return { ...f, A: (await importBoard(f.repo, `refs/cowork-test/${label}`, gen, checkpoints)).oids };
}

test('takeHoldRejections reports the P2-REFOLD replacements once, never the reports they replaced', T10, async () => {
  // Fast form: a P2-REFOLD at height 0 (B0's checkpoint differs) recomputes height 0's report; it is drained once, and
  // folding the same heights again (P2-REFOLD included) queues nothing.
  const { gen, v3 } = refoldBoard(0);
  const states = foldAll(gen, P, LIVE);
  const stub: OwnRejection = { opId: opId(P, 2), type: 'hold', reason: 'local_only_stub', holdId: ID2, foldedRev: null };
  const stale: OwnRejection = { opId: opId(P, v3), type: 'hold', reason: 'prev_rev', holdId: ID1, foldedRev: 2 };
  assert.deepEqual(rejectionsOf(gen, states, P, 0, gen.commits.length - 1), [stub, stale]);
  const { repo, A } = await importRefoldBoard('folder-refold', gen, states);
  const folder = new Folder(repo, P);
  const first = await folder.foldTo(A[4]!, null, 'rs-1');
  assert.equal(first.version.checkpointMismatch, true, 'B0 was refolded and still differs');
  assert.deepEqual(first.ownRejections, [stub, stale]);
  assert.deepEqual(folder.takeHoldRejections(), [stub, stale], 'each once, the refolded height 0 included');
  await folder.foldTo(A[4]!, null, 'rs-1');
  await folder.foldTo(A[4]!, { board: A[1]!, state: states[1]! }, 'rs-1');
  assert.deepEqual(folder.takeHoldRejections(), [], 'a second P2-REFOLD and a re-fold of the same heights queue nothing');

  // Full form (COWORK_SIM_LONG=1; the fold reads 257 commits): from a wrong `from` state (ID1 missing) the incremental fold
  // of 255 rejects both ops prev_rev with foldedRev null; the checkpoint at 256 then differs, the P2-REFOLD from genesis
  // replaces those reports, and only the replacement is drained.
  if (!LONG) return;
  const long = refoldBoard(252);
  assert.equal(long.gen.commits.length, 257);
  const ls = foldAll(long.gen, P, LIVE);
  const lstub: OwnRejection = { ...stub };
  const lstale: OwnRejection = { ...stale, opId: opId(P, long.v3) };
  assert.deepEqual(rejectionsOf(long.gen, ls, P, 0, 256), [lstub, lstale]);
  const lf = await importRefoldBoard('folder-refold-long', long.gen, ls);
  const lfolder = new Folder(lf.repo, P);
  await lfolder.foldTo(lf.A[4]!, null, 'rs-1');
  assert.deepEqual(lfolder.takeHoldRejections(), [lstub]);
  const wrong = structuredClone(ls[254]!);
  delete wrong.holds[ID1];
  wrong.record_count -= 1;
  const out = await lfolder.foldTo(lf.A[256]!, { board: lf.A[254]!, state: wrong }, 'rs-1');
  assert.ok(same(out.state, ls[256]!), 'the refold state replaced the incremental one');
  assert.equal(out.version.checkpointMismatch, false, 'the refold matches the checkpoint at 256');
  assert.deepEqual(out.ownRejections, [lstale], 'the replaced reports of this call');
  assert.deepEqual(lfolder.takeHoldRejections(), [lstale], 'the replacement, never the replaced prev_rev/null reports');
  await lfolder.foldTo(lf.A[256]!, { board: lf.A[254]!, state: ls[254]! }, 'rs-1');
  await lfolder.foldTo(lf.A[256]!, null, 'rs-1');
  assert.deepEqual(lfolder.takeHoldRejections(), []);
});
