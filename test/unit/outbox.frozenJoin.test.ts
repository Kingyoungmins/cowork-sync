// A joiner frozen before its epoch's first board push (ruling R3-EF4-3; 02-protocol §3.8 FREEZE row, §3.3 step 3b, PRO-16,
// PRO-45; 08-lifecycle §3.3 step 6.8; Plan 2 final review FC-7): the epoch's pending `join` leaves in the FREEZE row and in the
// FREEZE + VERSION regionSpec intersection, so it leads that push and the fold records the epoch. Without it every other op of
// that push — the freeze event and the hold mirrors PRO-45 lets leave — folds as a generic no-op on every peer (meas-holds-53:
// ownRejections [event 'generic', hold 'generic'], O-LIVE-RECORD single).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BoardDraft, WriterId } from '../../src/board/boardCommit.js';
import { canonicalJson, type Json } from '../../src/board/canonicalJson.js';
import { foldCommit, initialFoldState } from '../../src/board/fold.js';
import { OPS_MAX_BYTES, OPS_MAX_LINES, type OpDraft } from '../../src/board/ops.js';
import { Outbox, type PushState, type SeqAllocator } from '../../src/board/outbox.js';
import { genesisProtocol } from '../../src/board/protocol.js';
import type { Oid } from '../../src/git/oid.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const OTHER = 'a1'.repeat(16);
const OTHER_EPOCH = 'e1'.repeat(16);
const PEER = '0123456789abcdef0123456789abcdef';
const EPOCH = 'fedcba9876543210fedcba9876543210';
const SELF = { peer: PEER, epoch: EPOCH };
const ROOM = { maxOps: OPS_MAX_LINES, maxBytes: OPS_MAX_BYTES };
const PROTOCOL = genesisProtocol(12, 'rs-1');
const L0 = '1'.repeat(40) as Oid;
const HID = '01KDVD82VHM2MBHMTM9Y3Z68F8';

class Counter implements SeqAllocator {
  constructor(public n: number) {}
  next(): number {
    return this.n++;
  }
}

const joinDraft = (): OpDraft => ({
  type: 'join', display: 'Peer p2', plugin_version: '0.1.0-preview', plugin_sha: 'f'.repeat(64), proto: 1, regionSpec: 'rs-1',
  config_fingerprint: { filters: {}, autocrlf: '', eol_attrs: '', git: '' }, coauthor_optin: false,
});
const freezeMass = (): OpDraft => ({ type: 'event', cid: '', kind: 'freeze', refs: [], reason_code: 'MASS' });
/** meas-holds-53's local_only portability stub (content-free: no oid, no held/ subtree). */
const stub = (): OpDraft => ({
  type: 'hold', hold_id: HID, rev: 1, prev_rev: null, kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', offer: 'none',
  guards: [{ name: 'portability', class: 'DECISION', owner: 'DAT' }], paths: ['np/x-1.txt'], origin: 'human', cs_ids: [], peer_authors: [], local_only: true,
});

/** The board after the genesis peer's join: the joiner is not a peer of the fold yet. */
function boardWithOther(): ReturnType<typeof initialFoldState> {
  const join = canonicalJson({ id: `${OTHER}/${OTHER_EPOCH}/1`, ...joinDraft(), display: 'Peer p0' } as unknown as Json);
  const d: BoardDraft = { liveCode: L0, writer: { peer: OTHER, epoch: OTHER_EPOCH, seq: 2 }, cs: [], protocol: PROTOCOL, opsLines: [join], checkpoint: null, heldIds: [] };
  return foldCommit(initialFoldState(PROTOCOL), d, OTHER).state;
}

for (const states of [['frozen'], ['frozen', 'version_board_only']] as PushState[][]) {
  test(`a joiner frozen (${states.join(' + ')}) before its first board push: the join leads that push and its hold mirror folds`, T10, () => {
    // The engine's order: the join draft at join (start.ts), the MASS freeze event at detection (detect.ts enterMass), the mirror (mirrorSync).
    const box = new Outbox();
    box.add(joinDraft());
    box.add(freezeMass());
    box.replaceHold(stub() as never);
    assert.equal(box.pendingAllowed(states), true);
    const alloc = new Counter(1);
    const ops = box.take(states, SELF, alloc, ROOM);
    const writer: WriterId = { ...SELF, seq: alloc.next() };
    const d: BoardDraft = { liveCode: L0, writer, cs: [], protocol: PROTOCOL, opsLines: ops.map((o) => canonicalJson(o as unknown as Json)), checkpoint: null, heldIds: [] };
    const r = foldCommit(boardWithOther(), d, PEER);
    assert.deepEqual(r.ownRejections, [], 'no op of the first push folds as a no-op');
    assert.ok(Object.hasOwn(r.state.peers, PEER), 'the fold records the joiner');
    assert.equal(r.state.peers[PEER]?.epoch, EPOCH, 'under its new epoch');
    assert.equal(ops[0]?.type, 'join', 'the epoch\'s join leads its first push (Plan 2 final review FC-7)');
    assert.equal(r.state.holds[HID]?.local_only, true, 'the local_only stub folds (O-LIVE-RECORD single)');
  });
}

test('a frozen joiner with only its join pending pushes the join alone (board-only, PRO-42 "allowed outbox ops")', T10, () => {
  const box = new Outbox();
  box.add(joinDraft());
  for (const states of [['frozen'], ['frozen', 'version_board_only'], ['version_board_only']] as PushState[][]) {
    assert.equal(box.pendingAllowed(states), true, states.join(' + '));
  }
  for (const states of [['incident'], ['config_net'], ['offline'], ['nonretryable'], ['version_proto'], ['frozen', 'offline']] as PushState[][]) {
    assert.equal(box.pendingAllowed(states), false, `${states.join(' + ')}: an empty row keeps the join queued`);
  }
  const ops = box.take(['frozen'], SELF, new Counter(1), ROOM);
  assert.deepEqual(ops.map((o) => o.type), ['join']);
});
