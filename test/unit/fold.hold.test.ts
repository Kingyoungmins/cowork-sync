// The `hold` fold effect (Plan 3 Task 3): PRO-21 validity and effect, the PRO-24 own-rejection reasons with holdId and
// foldedRev, terminal_height, PRO-27 hold compaction and holdsCompactedAt, record_count with holds (PRO-06, T-PRO-33),
// parseFold of typed holds, the local_only stub (R3-24) and the pathless host-reject PIN (R3-11). Pure unit tests over
// BoardDrafts; the git-reading Folder side is test/integration/folder.hold.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BoardDraft, WriterId } from '../../src/board/boardCommit.js';
import { canonicalBytes, canonicalJson, type Json } from '../../src/board/canonicalJson.js';
import {
  foldCommit,
  holdsCompactedAt,
  initialFoldState,
  parseFold,
  serializeFold,
  type FoldedHold,
  type FoldState,
  type FoldStepResult,
  type OwnRejection,
} from '../../src/board/fold.js';
import { eventCid, parseOpLine, type HoldOpGuard } from '../../src/board/ops.js';
import { genesisProtocol } from '../../src/board/protocol.js';
import type { Oid } from '../../src/git/oid.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const P1 = 'a1'.repeat(16);
const P2 = 'b2'.repeat(16);
const E1 = 'e1'.repeat(16);
const L0 = '1'.repeat(40) as Oid;
const PROTOCOL = genesisProtocol(12, 'rs-1');
const ID = '01J9ZQ3C5X0000000000000000';
const ID2 = '01J9ZQ3C5X0000000000000002';
const ulidN = (n: number): string => `01J9ZQ3C5X${String(n).padStart(16, '0')}`;
const L = (o: Record<string, unknown>): string => canonicalJson(o as Json);
const TERMINAL = new Set(['SUBSUMED', 'GONE', 'RESOLVED_PUBLISH', 'RESOLVED_DISCARD']);
const REVERT: HoldOpGuard = { name: 'revert', class: 'DECISION', owner: 'HLD' };
const HOST_REJECT: HoldOpGuard = { name: 'host-reject', class: 'DECISION', owner: 'ENG' };

function joinL(opId: string): string {
  return L({
    id: opId, type: 'join', display: 'Peer', plugin_version: '0.3.0', plugin_sha: 'f'.repeat(64), proto: 1, regionSpec: 'rs-1',
    config_fingerprint: { filters: {}, autocrlf: '', eol_attrs: '', git: '2.47.1' }, coauthor_optin: false,
  });
}

interface HoldFields {
  hold_id?: string; rev: number; prev_rev: number | null; kind?: string; residence?: string | null; state?: string; offer?: string;
  guards?: HoldOpGuard[]; paths?: string[]; origin?: string; cs_ids?: string[]; peer_authors?: string[]; local_only?: boolean;
}
/** The §7 fields of a hold op (defaults: an ACTIVE revert PATCH on a.txt), without id and type. */
function fields(o: HoldFields): Record<string, unknown> {
  const state = o.state ?? 'ACTIVE';
  const residence = o.residence !== undefined ? o.residence : TERMINAL.has(state) ? null : state === 'PARKED' ? 'OFF_DISK' : 'ON_DISK';
  return {
    hold_id: o.hold_id ?? ID, rev: o.rev, prev_rev: o.prev_rev, kind: o.kind ?? 'PATCH', residence, state, offer: o.offer ?? 'none',
    guards: o.guards ?? [REVERT], paths: o.paths ?? ['a.txt'], origin: o.origin ?? 'human', cs_ids: o.cs_ids ?? [], peer_authors: o.peer_authors ?? [],
    local_only: o.local_only ?? false,
  };
}
const holdL = (opId: string, o: HoldFields): string => L({ id: opId, type: 'hold', ...fields(o) });

interface Step { prev: FoldState; d: BoardDraft; r: FoldStepResult; }

/** One board, folded commit by commit as `self` sees it; each peer writes epoch E1 with its own seq counter. */
class Board {
  state: FoldState = initialFoldState(PROTOCOL);
  private readonly seqs = new Map<string, number>();
  constructor(readonly self: string) {}
  /** The next op id of `peer`. */
  id(peer: string): string {
    const n = (this.seqs.get(peer) ?? 0) + 1;
    this.seqs.set(peer, n);
    return `${peer}/${E1}/${n}`;
  }
  commit(peer: string, lines: readonly string[], heldIds: readonly string[] = []): Step {
    const seq = (this.seqs.get(peer) ?? 0) + 1;
    this.seqs.set(peer, seq);
    const writer: WriterId = { peer, epoch: E1, seq };
    const prev = this.state;
    const d: BoardDraft = { liveCode: L0, writer, cs: [], protocol: PROTOCOL, opsLines: [...lines], checkpoint: null, heldIds: [...heldIds] };
    const r = foldCommit(prev, d, this.self);
    this.state = r.state;
    return { prev, d, r };
  }
  /** Empty commits of `peer` until the state is at height h. */
  idleTo(peer: string, h: number): void {
    while (this.state.height < h) this.commit(peer, []);
  }
  /** Reads that TypeScript does not narrow from an earlier assertion on the same property path. */
  height(): number {
    return this.state.height;
  }
  hold(id: string): FoldedHold | undefined {
    return this.state.holds[id];
  }
}
/** The same commit folded by another peer. */
const as = (st: Step, self: string): FoldStepResult => foldCommit(st.prev, st.d, self);
const rej = (opId: string, reason: OwnRejection['reason'], holdId: string | null, foldedRev: number | null, type: OwnRejection['type'] = 'hold'): OwnRejection =>
  ({ opId, type, reason, holdId, foldedRev });
const lastId = (st: Step): string => (JSON.parse(st.d.opsLines[st.d.opsLines.length - 1]!) as { id: string }).id;

/** P1 and P2 joined; P1 created ID (rev 1) at height 10 and moved it to rev 3 (CONFLICTED, offered) at height 11. */
function setup(): Board {
  const b = new Board(P1);
  b.commit(P1, [joinL(b.id(P1))]);
  b.commit(P2, [joinL(b.id(P2))]);
  b.idleTo(P1, 9);
  b.commit(P1, [holdL(b.id(P1), { rev: 1, prev_rev: null })], [ID]);
  b.commit(P1, [holdL(b.id(P1), REV3)], [ID]);
  assert.equal(b.state.height, 11);
  return b;
}
const REV3: HoldFields = {
  rev: 3, prev_rev: 1, kind: 'PIN', state: 'CONFLICTED', offer: 'offered', guards: [{ name: 'conflict', class: 'DECISION', owner: 'DAT' }, REVERT],
  paths: ['a.txt', 'docs/b.md'], origin: 'daemon', cs_ids: [`${P1}/human/4`], peer_authors: [P2],
};

test("the fold stores the owner's latest op and derives owner from the creating op's writer", T10, () => {
  const b = new Board(P1);
  b.commit(P1, [joinL(b.id(P1))]);
  b.commit(P2, [joinL(b.id(P2))]);
  b.idleTo(P1, 9);
  const counts: number[] = [b.state.record_count];
  const create = b.commit(P1, [holdL(b.id(P1), { rev: 1, prev_rev: null })], [ID]);
  assert.equal(b.state.height, 10);
  assert.deepEqual(create.r.ownRejections, []);
  assert.deepEqual(create.r.landedOwnOpIds, [lastId(create)]);
  counts.push(b.state.record_count);
  b.commit(P1, [holdL(b.id(P1), REV3)], [ID]);
  assert.equal(b.state.height, 11);
  counts.push(b.state.record_count);
  const { hold_id: _h, prev_rev: _p, ...latest } = fields(REV3);
  assert.deepEqual(b.state.holds[ID], { ...latest, owner: P1 }, 'the rev-3 fields, no id/type/prev_rev, owner = the creating writer');
  assert.deepEqual(Object.keys(b.state.holds[ID]!).sort(), ['cs_ids', 'guards', 'kind', 'local_only', 'offer', 'origin', 'owner', 'paths', 'peer_authors', 'residence', 'rev', 'state']);
  assert.deepEqual(counts, [0, 1, 1], 'record_count rose by 1 at height 10 only');
  // Another peer's fold of the same chain holds the same entry: owner is folded, not the folding peer.
  const other = new Board(P2);
  other.commit(P1, [joinL(other.id(P1))]);
  other.commit(P2, [joinL(other.id(P2))]);
  other.idleTo(P1, 9);
  other.commit(P1, [holdL(other.id(P1), { rev: 1, prev_rev: null })], [ID]);
  other.commit(P1, [holdL(other.id(P1), REV3)], [ID]);
  assert.ok(serializeFold(other.state).equals(serializeFold(b.state)));
});

test('T-PRO-05: a hold rev race applies the first op and rejects the second with prev_rev', T10, () => {
  const b = setup();
  const first = b.commit(P1, [holdL(b.id(P1), { ...REV3, rev: 4, prev_rev: 3, state: 'ACTIVE' })], [ID]);
  assert.equal(b.state.height, 12);
  assert.deepEqual(first.r.ownRejections, []);
  assert.equal(b.state.holds[ID]?.rev, 4);
  const second = b.commit(P1, [holdL(b.id(P1), { ...REV3, rev: 5, prev_rev: 3, state: 'CONFLICTED' })], [ID]);
  assert.equal(b.state.height, 13);
  assert.deepEqual(second.r.ownRejections, [rej(lastId(second), 'prev_rev', ID, 4)]);
  assert.deepEqual(second.r.landedOwnOpIds, []);
  assert.equal(b.state.holds[ID]?.rev, 4);
  assert.equal(b.state.holds[ID]?.state, 'ACTIVE', 'the first op is the folded record');
  // The same race inside one commit: the earlier line wins.
  const ids = [b.id(P1), b.id(P1)];
  const both = b.commit(P1, [holdL(ids[0]!, { ...REV3, rev: 6, prev_rev: 4 }), holdL(ids[1]!, { ...REV3, rev: 7, prev_rev: 4, state: 'PARKED' })], [ID]);
  assert.deepEqual(both.r.landedOwnOpIds, [ids[0]]);
  assert.deepEqual(both.r.ownRejections, [rej(ids[1]!, 'prev_rev', ID, 6)]);
  assert.equal(b.state.holds[ID]?.rev, 6);
  // A create of a folded id is a prev_rev mismatch (folded rev 6, op null); an update of an unknown id has folded rev null.
  const recreate = b.commit(P1, [holdL(b.id(P1), { rev: 1, prev_rev: null })], [ID]);
  assert.deepEqual(recreate.r.ownRejections, [rej(lastId(recreate), 'prev_rev', ID, 6)]);
  const unknown = b.commit(P1, [holdL(b.id(P1), { hold_id: ID2, rev: 2, prev_rev: 1 })], [ID2]);
  assert.deepEqual(unknown.r.ownRejections, [rej(lastId(unknown), 'prev_rev', ID2, null)]);
  assert.equal(b.state.holds[ID2], undefined);
});

test('T-PRO-05: a non-owner hold op is a no-op told to its writer', T10, () => {
  const b = setup();
  const before = serializeFold(b.state);
  const st = b.commit(P2, [holdL(b.id(P2), { ...REV3, rev: 4, prev_rev: 3 })], [ID]);
  const expected = structuredClone(st.prev);
  expected.height = 12;
  expected.peers[P2]!.last_height = 12;
  expected.peers[P2]!.last_seq = st.d.writer!.seq;
  assert.deepEqual(b.state.holds[ID], st.prev.holds[ID], 'holds[id] unchanged');
  assert.ok(serializeFold(b.state).equals(serializeFold(expected)), 'only the step-5 counters and the height moved');
  assert.ok(!serializeFold(b.state).equals(before));
  assert.deepEqual(as(st, P2).ownRejections, [rej(lastId(st), 'type', ID, 3)], "P2's own rejection");
  assert.deepEqual(st.r.ownRejections, [], 'P1 sees no rejection');
  // The owner check comes before prev_rev: a non-owner op with a stale prev_rev, or a non-owner create, is 'type' too.
  const stale = b.commit(P2, [holdL(b.id(P2), { ...REV3, rev: 9, prev_rev: 1 })], [ID]);
  assert.deepEqual(as(stale, P2).ownRejections, [rej(lastId(stale), 'type', ID, 3)]);
  const create = b.commit(P2, [holdL(b.id(P2), { rev: 1, prev_rev: null })], [ID]);
  assert.deepEqual(as(create, P2).ownRejections, [rej(lastId(create), 'type', ID, 3)]);
  // P2 may create and update its own record.
  const own = b.commit(P2, [holdL(b.id(P2), { hold_id: ID2, rev: 1, prev_rev: null })], [ID2]);
  assert.deepEqual(as(own, P2).ownRejections, []);
  assert.equal(b.state.holds[ID2]?.owner, P2);
});

test('T-PRO-05: a local_only op carried with held/<id>/ is rejected local_only_stub', T10, () => {
  const b = setup();
  const create = b.commit(P1, [holdL(b.id(P1), { hold_id: ID2, rev: 1, prev_rev: null, local_only: true })], [ID, ID2]);
  assert.deepEqual(create.r.ownRejections, [rej(lastId(create), 'local_only_stub', ID2, null)]);
  assert.equal(b.state.holds[ID2], undefined, 'no-op');
  // An update to local_only of a mirrored record whose held/ subtree is still carried: rejected too.
  const update = b.commit(P1, [holdL(b.id(P1), { ...REV3, rev: 4, prev_rev: 3, local_only: true })], [ID]);
  assert.deepEqual(update.r.ownRejections, [rej(lastId(update), 'local_only_stub', ID, 3)]);
  assert.equal(b.state.holds[ID]?.rev, 3);
  // A terminal local_only op carried with the subtree is still not a stub.
  const terminal = b.commit(P1, [holdL(b.id(P1), { ...REV3, rev: 4, prev_rev: 3, state: 'GONE', local_only: true })], [ID]);
  assert.deepEqual(terminal.r.ownRejections, [rej(lastId(terminal), 'local_only_stub', ID, 3)]);
  // Without the subtree the stub folds valid.
  const stub = b.commit(P1, [holdL(b.id(P1), { hold_id: ID2, rev: 1, prev_rev: null, local_only: true })], [ID]);
  assert.deepEqual(stub.r.ownRejections, []);
  assert.equal(b.hold(ID2)?.local_only, true);
});

test('T-PRO-05: a mirrored non-terminal record without held/<id>/ is rejected held_subtree', T10, () => {
  const b = setup();
  const records = b.state.record_count;
  const bare = b.commit(P1, [holdL(b.id(P1), { hold_id: ID2, rev: 1, prev_rev: null, state: 'ACTIVE', paths: ['a.txt'] })], []);
  assert.deepEqual(bare.r.ownRejections, [rej(lastId(bare), 'held_subtree', ID2, null)]);
  assert.equal(b.state.holds[ID2], undefined);
  // Another id's subtree does not count.
  const wrong = b.commit(P1, [holdL(b.id(P1), { hold_id: ID2, rev: 1, prev_rev: null, state: 'ACTIVE', paths: ['a.txt'] })], [ID]);
  assert.deepEqual(wrong.r.ownRejections, [rej(lastId(wrong), 'held_subtree', ID2, null)]);
  // An update of a mirrored record whose subtree the commit no longer carries.
  const dropped = b.commit(P1, [holdL(b.id(P1), { ...REV3, rev: 4, prev_rev: 3, state: 'ACTIVE' })], []);
  assert.deepEqual(dropped.r.ownRejections, [rej(lastId(dropped), 'held_subtree', ID, 3)]);
  assert.equal(b.state.record_count, records);
  // The same op terminal (RESOLVED_DISCARD) needs no subtree; nor does the pathless host-reject PIN (R3-11).
  const discard = b.commit(P1, [holdL(b.id(P1), { hold_id: ID2, rev: 1, prev_rev: null, state: 'RESOLVED_DISCARD', paths: ['a.txt'] })], []);
  assert.deepEqual(discard.r.ownRejections, []);
  assert.equal(b.hold(ID2)?.state, 'RESOLVED_DISCARD');
  const pin = ulidN(3);
  const pathless = b.commit(P1, [holdL(b.id(P1), { hold_id: pin, rev: 1, prev_rev: null, kind: 'PIN', state: 'ACTIVE', paths: [], guards: [HOST_REJECT], origin: 'daemon' })], []);
  assert.deepEqual(pathless.r.ownRejections, []);
  assert.deepEqual(b.state.holds[pin]?.paths, []);
  assert.equal(b.state.record_count, records + 2);
});

test('an own hold line that fails parsing is rejected validator with its hold_id', T10, () => {
  const b = setup();
  const badPath = (opId: string, holdId: string): string => L({ id: opId, type: 'hold', ...fields({ hold_id: holdId, rev: 4, prev_rev: 3, paths: ['docs/12:30-notes.md'] }) });
  const known = b.commit(P1, [badPath(b.id(P1), ID)], [ID]);
  assert.deepEqual(known.r.ownRejections, [rej(lastId(known), 'validator', ID, 3)], 'a folded record: its folded rev');
  const fresh = b.commit(P1, [badPath(b.id(P1), ID2)], [ID2]);
  assert.deepEqual(fresh.r.ownRejections, [rej(lastId(fresh), 'validator', ID2, null)], 'an unfolded id: foldedRev null');
  // A hold line with no usable hold_id is still a validator rejection, with holdId null.
  const noId = b.commit(P1, [L({ id: b.id(P1), type: 'hold', ...fields({ hold_id: 'x', rev: 1, prev_rev: null }) })]);
  assert.deepEqual(noId.r.ownRejections, [rej(lastId(noId), 'validator', null, null)]);
  // A teammate's malformed hold line is nobody's rejection here.
  const theirs = b.commit(P2, [badPath(b.id(P2), ID)], [ID]);
  assert.deepEqual(theirs.r.ownRejections, []);
  // An unparsable claim line keeps Plan 2's 'type', with no hold id.
  const claim = b.commit(P1, [L({ id: b.id(P1), type: 'claim', claim_id: 'abcdefghijklmnop' })]);
  assert.deepEqual(claim.r.ownRejections, [rej(lastId(claim), 'type', null, null, 'claim')]);
  // A hold op that the generic checks of step 3b reject keeps Plan 2's 'generic', with its hold id and folded rev.
  const staleSeq = `${P1}/${E1}/1`;
  const generic = b.commit(P1, [holdL(staleSeq, { ...REV3, rev: 4, prev_rev: 3 })], [ID]);
  assert.deepEqual(generic.r.ownRejections, [rej(staleSeq, 'generic', ID, 3)]);
  assert.equal(b.state.holds[ID]?.rev, 3);
});

test('terminal_height is set by the op that enters a terminal state', T10, () => {
  const b = setup();
  b.commit(P1, [holdL(b.id(P1), { hold_id: ID2, rev: 1, prev_rev: null })], [ID2]);
  b.idleTo(P1, 19);
  b.commit(P1, [holdL(b.id(P1), { ...REV3, rev: 6, prev_rev: 3, state: 'SUBSUMED' })], [ID]);
  assert.equal(b.state.height, 20);
  assert.equal(b.state.holds[ID]?.terminal_height, 20);
  assert.equal(b.state.holds[ID]?.residence, null);
  assert.ok(!Object.hasOwn(b.state.holds[ID2]!, 'terminal_height'), 'a non-terminal record has none');
  // A later terminal op keeps the height at which the record became terminal.
  b.commit(P1, [holdL(b.id(P1), { ...REV3, rev: 7, prev_rev: 6, state: 'GONE' })], [ID]);
  assert.equal(b.state.holds[ID]?.state, 'GONE');
  assert.equal(b.state.holds[ID]?.rev, 7);
  assert.equal(b.state.holds[ID]?.terminal_height, 20);
  // A terminal record never becomes non-terminal again: the reviving op is a 'type' no-op (so compaction is a function of the
  // state before the commit, holdsCompactedAt).
  const revive = b.commit(P1, [holdL(b.id(P1), { ...REV3, rev: 8, prev_rev: 7, state: 'ACTIVE' })], [ID]);
  assert.deepEqual(revive.r.ownRejections, [rej(lastId(revive), 'type', ID, 7)]);
  assert.equal(b.state.holds[ID]?.state, 'GONE');
  // A create that is terminal at once gets the height of its commit.
  b.commit(P1, [holdL(b.id(P1), { hold_id: ulidN(5), rev: 1, prev_rev: null, state: 'RESOLVED_PUBLISH' })]);
  assert.equal(b.state.holds[ulidN(5)]?.terminal_height, b.state.height);
});

test('compaction drops terminal holds older than two checkpoints and never a non-terminal one', T10, () => {
  const [A, B, C, D, E] = [1, 2, 3, 4, 5].map(ulidN) as [string, string, string, string, string];
  const b = new Board(P1);
  b.commit(P1, [joinL(b.id(P1))]);
  b.idleTo(P1, 9);
  b.commit(P1, [
    holdL(b.id(P1), { hold_id: A, rev: 1, prev_rev: null }),
    holdL(b.id(P1), { hold_id: B, rev: 1, prev_rev: null }),
    holdL(b.id(P1), { hold_id: C, rev: 1, prev_rev: null, state: 'PARKED' }),
    holdL(b.id(P1), { hold_id: D, rev: 1, prev_rev: null, offer: 'offered' }),
    holdL(b.id(P1), { hold_id: E, rev: 1, prev_rev: null }),
  ], [A, B, C, D, E]);
  assert.equal(b.state.height, 10);
  assert.equal(Object.keys(b.state.holds).length, 5);
  b.idleTo(P1, 499);
  b.commit(P1, [holdL(b.id(P1), { hold_id: A, rev: 2, prev_rev: 1, state: 'RESOLVED_PUBLISH' })], [A, B, C, D, E]);
  assert.equal(b.state.holds[A]?.terminal_height, 500);
  b.idleTo(P1, 512);
  b.commit(P1, [holdL(b.id(P1), { hold_id: B, rev: 2, prev_rev: 1, state: 'GONE' })], [B, C, D, E]);
  assert.equal(b.state.holds[B]?.terminal_height, 513);
  const results = new Map<number, FoldStepResult>();
  while (b.height() < 1280) {
    const st = b.commit(P1, []);
    const h = b.height();
    results.set(h, st.r);
    if (h % 256 !== 0) assert.deepEqual(st.r.compactedHolds, [], `nothing is compacted at ${h}`);
    if (h === 1023 || h === 1279) assert.equal(st.r.state.record_count, h === 1023 ? 5 : 4);
  }
  assert.deepEqual(results.get(768)?.compactedHolds, [], 'A (500) is not ≤ 768 − 512');
  const at1024 = results.get(1024)!;
  assert.deepEqual(at1024.compactedHolds, [A], 'exactly A: 500 ≤ 512');
  assert.equal(at1024.state.holds[A], undefined);
  assert.equal(at1024.state.holds[B]?.terminal_height, 513, 'B (513) is kept at 1024');
  assert.equal(at1024.state.record_count, 4);
  const at1280 = results.get(1280)!;
  assert.deepEqual(at1280.compactedHolds, [B], 'B: 513 ≤ 768');
  assert.equal(at1280.state.record_count, 3);
  for (const s of [at1024.state, at1280.state]) {
    assert.equal(s.holds[C]?.state, 'PARKED', 'PARKED is never compacted');
    assert.equal(s.holds[D]?.offer, 'offered', 'an offered record is never compacted');
    assert.equal(s.holds[E]?.state, 'ACTIVE');
  }
});

test("PRO-27's boundary is '<=': a terminal hold with terminal_height = h − 512 is dropped at h, one at h − 511 is kept", T10, () => {
  const [X, Y] = [ulidN(21), ulidN(22)];
  const b = new Board(P1);
  b.commit(P1, [joinL(b.id(P1))]);
  b.commit(P1, [holdL(b.id(P1), { hold_id: X, rev: 1, prev_rev: null }), holdL(b.id(P1), { hold_id: Y, rev: 1, prev_rev: null })], [X, Y]);
  b.idleTo(P1, 511);
  b.commit(P1, [holdL(b.id(P1), { hold_id: X, rev: 2, prev_rev: 1, state: 'GONE' })], [X, Y]);
  assert.equal(b.height(), 512);
  b.commit(P1, [holdL(b.id(P1), { hold_id: Y, rev: 2, prev_rev: 1, state: 'SUBSUMED' })], [Y]);
  assert.equal(b.hold(X)?.terminal_height, 512);
  assert.equal(b.hold(Y)?.terminal_height, 513);
  b.idleTo(P1, 1023);
  assert.deepEqual(holdsCompactedAt(b.state, 1024), [X], 'X: 512 <= 1024 - 512; Y: 513 > 512');
  const st = b.commit(P1, []);
  assert.deepEqual(st.r.compactedHolds, [X]);
  assert.equal(b.hold(X), undefined, 'dropped at exactly h - 512');
  assert.equal(b.hold(Y)?.terminal_height, 513, 'kept at h - 511');
  assert.equal(b.state.record_count, st.prev.record_count - 1);
});

test('ruling (spec-edit list PRO-21): a terminal hold never returns to non-terminal, and terminal → terminal keeps the first terminal_height', T10, () => {
  const b = setup();
  b.idleTo(P1, 29);
  b.commit(P1, [holdL(b.id(P1), { ...REV3, rev: 4, prev_rev: 3, state: 'RESOLVED_PUBLISH' })], [ID]);
  assert.equal(b.height(), 30);
  assert.equal(b.hold(ID)?.terminal_height, 30);
  const records = b.state.record_count;
  // Half 1: every reviving op — to each non-terminal state, with the right prev_rev and its held/ subtree — is the owner's
  // own 'type' no-op; the folded record stays as it was.
  let rev = 4;
  for (const state of ['ACTIVE', 'CONFLICTED', 'PARKED'] as const) {
    const before = structuredClone(b.state.holds[ID]);
    const revive = b.commit(P1, [holdL(b.id(P1), { ...REV3, rev: rev + 1, prev_rev: rev, state })], [ID]);
    assert.deepEqual(revive.r.ownRejections, [rej(lastId(revive), 'type', ID, rev)], `${state}: rejected 'type'`);
    assert.deepEqual(revive.r.landedOwnOpIds, []);
    assert.deepEqual(b.state.holds[ID], before, `${state}: the terminal record is unchanged`);
  }
  // Half 2: terminal → terminal applies (rev and state move) but keeps the height at which the record first became terminal.
  for (const state of ['SUBSUMED', 'GONE', 'RESOLVED_DISCARD', 'RESOLVED_PUBLISH'] as const) {
    b.idleTo(P1, b.height() + 7);
    const step = b.commit(P1, [holdL(b.id(P1), { ...REV3, rev: rev + 2, prev_rev: rev, state })]);
    rev += 2;
    assert.deepEqual(step.r.ownRejections, [], `${state}: applies`);
    assert.equal(b.hold(ID)?.state, state);
    assert.equal(b.hold(ID)?.rev, rev);
    assert.equal(b.hold(ID)?.terminal_height, 30, `${state}: terminal_height stays 30 (the commit is at ${b.height()})`);
  }
  assert.equal(b.state.record_count, records, 'no record was added or revived');
  // A new record takes a new id: its create folds, non-terminal.
  const fresh = b.commit(P1, [holdL(b.id(P1), { hold_id: ID2, rev: 1, prev_rev: null })], [ID2]);
  assert.deepEqual(fresh.r.ownRejections, []);
  assert.equal(b.hold(ID2)?.state, 'ACTIVE');
  assert.ok(!Object.hasOwn(b.hold(ID2)!, 'terminal_height'));
  assert.equal(b.state.record_count, records + 1);
});

test('T-PRO-33 fold part: holds count toward the 5,000-record cap and compaction relieves it', T10, () => {
  const b = new Board(P1);
  b.commit(P1, [joinL(b.id(P1))]);
  // 40 holds, terminal from their creation at height 1.
  const terminal = Array.from({ length: 40 }, (_, i) => ulidN(100 + i));
  b.commit(P1, terminal.map((hid) => holdL(b.id(P1), { hold_id: hid, rev: 1, prev_rev: null, state: 'GONE' })));
  assert.equal(b.state.record_count, 40);
  b.idleTo(P1, 256);
  // 4,960 events at heights 257.., in commits that fit the 1,000-line / 64 KiB caps.
  let events = 0;
  while (events < 4_960) {
    const lines: string[] = [];
    let bytes = 0;
    while (events < 4_960 && lines.length < 300) {
      const opId = b.id(P1);
      const l = L({ id: opId, type: 'event', cid: eventCid(opId, 'health'), kind: 'health', refs: [], reason_code: 'BOARD_FULL' });
      bytes += Buffer.byteLength(l) + 1;
      lines.push(l);
      events++;
    }
    assert.ok(bytes < 65_536);
    const st = b.commit(P1, lines);
    assert.equal(st.r.landedOwnOpIds.length, lines.length);
  }
  const firstEvent = Math.min(...Object.values(b.state.events).map((e) => e.height));
  assert.ok(firstEvent > 256, 'every event is newer than 768 − 512');
  b.idleTo(P1, 767);
  assert.equal(b.state.record_count, 5_000, 'holds count toward the record cap');
  assert.deepEqual(holdsCompactedAt(b.state, 768), [...terminal].sort());
  const st = b.commit(P1, []);
  assert.equal(b.state.height, 768);
  assert.deepEqual(st.r.compactedHolds, [...terminal].sort());
  assert.equal(b.state.record_count, 4_960);
  for (const hid of terminal) assert.equal(b.state.holds[hid], undefined);
  assert.equal(Object.keys(b.state.events).length, 4_960);
});

test('parseFold reads typed holds and refuses a malformed hold entry', T10, () => {
  const b = setup();
  b.commit(P1, [holdL(b.id(P1), { hold_id: ID2, rev: 1, prev_rev: null, local_only: true, paths: ['.env'] })]);
  b.commit(P1, [holdL(b.id(P1), { hold_id: ulidN(3), rev: 1, prev_rev: null, kind: 'PIN', paths: [], guards: [HOST_REJECT], origin: 'daemon' })]);
  b.commit(P1, [holdL(b.id(P1), { ...REV3, rev: 4, prev_rev: 3, state: 'RESOLVED_DISCARD' })], [ID]);
  const s = b.state;
  assert.equal(Object.keys(s.holds).length, 3);
  assert.ok(s.holds[ID]?.terminal_height !== undefined);
  const bytes = serializeFold(s);
  const back = parseFold(bytes);
  assert.ok(back !== null);
  assert.deepEqual(back, s);
  assert.ok(serializeFold(back).equals(bytes));

  /** The state with one edit to holds[ID] (or ID2), re-serialized canonically: only the hold entry is wrong. */
  const edited = (edit: (h: Record<string, Json>) => void, hid = ID): Buffer => {
    const v = JSON.parse(bytes.toString('utf8')) as { holds: Record<string, Record<string, Json>> };
    edit(v.holds[hid]!);
    return canonicalBytes(v as unknown as Json);
  };
  const cases: Array<[string, Buffer]> = [
    ['rev 0', edited((h) => { h['rev'] = 0; })],
    ['an extra key', edited((h) => { h['blobs'] = {}; })],
    ['no owner', edited((h) => { delete h['owner']; })],
    ['an owner that is no peer id', edited((h) => { h['owner'] = 'P1'; })],
    ['a non-integer terminal_height', edited((h) => { h['terminal_height'] = 1.5; })],
    ['a negative terminal_height', edited((h) => { h['terminal_height'] = -1; })],
    ['a terminal entry without terminal_height', edited((h) => { delete h['terminal_height']; })],
    ['a non-terminal entry with terminal_height', edited((h) => { h['terminal_height'] = 3; }, ID2)],
    ['a prev_rev key', edited((h) => { h['prev_rev'] = null; })],
    ['an unknown state', edited((h) => { h['state'] = 'WIP'; })],
    ['an invalid path', edited((h) => { h['paths'] = ['docs/12:30-notes.md']; }, ID2)],
    ['a guard without a class', edited((h) => { h['guards'] = [{ name: 'revert', owner: 'HLD' }]; })],
    ['a pathless entry that is no PIN', edited((h) => { h['kind'] = 'PATCH'; }, ulidN(3))],
    ['a pathless PIN without host-reject', edited((h) => { h['guards'] = [{ name: 'phantom', class: 'DECISION', owner: 'ENG' }]; }, ulidN(3))],
  ];
  for (const [what, buf] of cases) assert.equal(parseFold(buf), null, what);
  // A hold keyed by something other than a ULID.
  const v = JSON.parse(bytes.toString('utf8')) as { holds: Record<string, Json> };
  v.holds['not-a-ulid'] = v.holds[ID]!;
  delete v.holds[ID];
  assert.equal(parseFold(canonicalBytes(v as unknown as Json)), null, 'a key that is no ULID');
});

test('a local_only stub keeps its paths and no oid', T10, () => {
  const b = setup();
  // The stub's line also carries smuggled oid-bearing fields (a writer that put its blobs into the op): neither the parsed op,
  // nor the folded entry, nor the state bytes may keep one.
  const OID1 = 'c'.repeat(40);
  const OID2 = 'd'.repeat(64);
  const stubLine = L({
    id: b.id(P1), type: 'hold',
    ...fields({ hold_id: ID2, rev: 1, prev_rev: null, local_only: true, paths: ['.env', 'config/secret.key'], guards: [{ name: 'secret-scan', class: 'DECISION', owner: 'SEC (local human, glossary §16)' }] }),
    blobs: { h0: { '.env': OID1 }, h1: { '.env': OID2, 'config/secret.key': OID1 } }, oid: OID1, held: [OID2], tree: OID1,
  });
  const st = b.commit(P1, [stubLine]);
  assert.deepEqual(st.r.ownRejections, []);
  const entry: FoldedHold | undefined = b.state.holds[ID2];
  assert.ok(entry !== undefined);
  assert.deepEqual(entry.paths, ['.env', 'config/secret.key'], 'names, not content');
  assert.equal(entry.local_only, true);
  assert.deepEqual(Object.keys(entry).sort(), ['cs_ids', 'guards', 'kind', 'local_only', 'offer', 'origin', 'owner', 'paths', 'peer_authors', 'residence', 'rev', 'state']);
  const oidsIn = (x: unknown): string[] => {
    const strings: string[] = [];
    const walk = (y: unknown): void => {
      if (typeof y === 'string') strings.push(y);
      else if (Array.isArray(y)) y.forEach(walk);
      else if (y !== null && typeof y === 'object') Object.entries(y).forEach(([k, v]) => { strings.push(k); walk(v); });
    };
    walk(x);
    return strings.filter((s) => /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(s));
  };
  assert.deepEqual(oidsIn(JSON.parse(stubLine)).sort(), [OID1, OID1, OID1, OID1, OID2, OID2].sort(), 'the line does carry oids');
  assert.deepEqual(oidsIn(parseOpLine(stubLine)), [], 'no object id in the parsed op');
  assert.deepEqual(oidsIn(entry), [], `no object id in ${JSON.stringify(entry)}`);
  const bytes = serializeFold(b.state).toString('utf8');
  assert.ok(!bytes.includes(OID1) && !bytes.includes(OID2), 'no object id in state.json');
});

test('the pathless host-reject PIN op of a board-only NONRETRYABLE folds valid', T10, () => {
  const b = setup();
  const before = b.state.record_count;
  const pin = ulidN(9);
  const st = b.commit(P1, [holdL(b.id(P1), { hold_id: pin, rev: 1, prev_rev: null, kind: 'PIN', state: 'ACTIVE', paths: [], cs_ids: [], origin: 'daemon', guards: [HOST_REJECT] })], []);
  assert.deepEqual(st.r.ownRejections, []);
  assert.deepEqual(st.r.landedOwnOpIds, [lastId(st)]);
  assert.deepEqual(b.state.holds[pin], {
    rev: 1, kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', offer: 'none', guards: [HOST_REJECT], paths: [], origin: 'daemon', cs_ids: [], peer_authors: [],
    local_only: false, owner: P1,
  });
  assert.equal(b.state.record_count, before + 1, 'counted in record_count');
  // Resume ends it SUBSUMED with host-reject kept (R3-39): a terminal op with no subtree, valid too.
  const end = b.commit(P1, [holdL(b.id(P1), { hold_id: pin, rev: 2, prev_rev: 1, kind: 'PIN', state: 'SUBSUMED', paths: [], origin: 'daemon', guards: [HOST_REJECT] })], []);
  assert.deepEqual(end.r.ownRejections, []);
  assert.equal(b.state.holds[pin]?.terminal_height, b.state.height);
});
