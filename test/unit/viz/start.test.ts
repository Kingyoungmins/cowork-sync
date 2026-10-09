// Plan 8a Task 5: the start scene of a segment (12 sec. 3.3.5; VIZ-10, VIZ-12, VIZ-21): a checkpoint fold state built by
// Plan 2's own foldCommit (plus the one PeerRec status Plan 2 cannot fold, absent) -> exactly the sec. 3.3.5 start scene.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WriterId } from '../../../src/board/boardCommit.js';
import { canonicalJson, type Json } from '../../../src/board/canonicalJson.js';
import { foldCommit, initialFoldState, liveSet, rankedSet, type FoldState } from '../../../src/board/fold.js';
import { eventCid, type EventKind } from '../../../src/board/ops.js';
import type { PeerRef } from '../../../src/viz/model/events.js';
import { ZERO_PEER } from '../../../src/viz/model/frame.js';
import { emptyLayout } from '../../../src/viz/model/layout.js';
import { phOf } from '../../../src/viz/model/labels.js';
import { emptyScene, isSlowed, type CharacterState, type PetState, type Scene } from '../../../src/viz/model/scene.js';
import { startScene } from '../../../src/viz/model/start.js';
import { DRAFT_PROTOCOL, draft } from '../../helpers/vizEvents.js';
import { officeOf } from '../../helpers/vizScene.js';

const hex = (n: number): string => n.toString(16).padStart(32, '0');
const EPOCH = hex(0xe0);

/** A writer with its own op seq: each op takes the next seq, then the commit's Cowork-Writer seq one above them. */
class Writer {
  private seq = 0;
  constructor(readonly id: PeerRef) {}
  op(o: Record<string, Json>): string {
    const id = `${this.id}/${EPOCH}/${++this.seq}`;
    return canonicalJson(o['type'] === 'event' ? { id, ...o, cid: eventCid(id, o['kind'] as EventKind) } : { id, ...o });
  }
  writer(): WriterId {
    return { peer: this.id, epoch: EPOCH, seq: ++this.seq };
  }
}
const join = (regionSpec = 'rs-1', coauthor: false | string = false): Record<string, Json> => ({
  type: 'join', display: 'Teammate', plugin_version: '0.2.0', plugin_sha: 'f'.repeat(64), proto: 1, regionSpec,
  config_fingerprint: { filters: {}, autocrlf: '', eol_attrs: '', git: '2.47.1' }, coauthor_optin: coauthor,
});
const event = (kind: EventKind, reason = 'TEST_REASON'): Record<string, Json> => ({ type: 'event', kind, refs: [], reason_code: reason });
const seat = (type: 'seat_start' | 'seat_end', id: string): Record<string, Json> => ({ type, seat_id: id, permission_mode: 'default' });

// One peer per start-scene fact, named by role; ids sorted in this order, so homeOrder spots follow it.
const A = hex(1), B = hex(2), C = hex(3), F = hex(4), G = hex(5), K = hex(6), L = hex(7), R = hex(8), S = hex(9);
const SEAT_A1 = hex(0xa1), SEAT_A2 = hex(0xa2), SEAT_K1 = hex(0xb1), SEAT_K2 = hex(0xb2), SEAT_L1 = hex(0xc1);
const key = (peer: PeerRef, seatId: string): string => `${peer}/${EPOCH}/${seatId}`;
const HS = 512;

/** Heights 0..hs folded by Plan 2's foldCommit: the special commits at their heights, the rotation's empty commits elsewhere. */
function foldBoard(hs: number, peers: readonly PeerRef[], special: ReadonlyMap<number, [PeerRef, Array<Record<string, Json>>]>, rotation: readonly PeerRef[]): FoldState {
  const w = new Map(peers.map((p) => [p, new Writer(p)]));
  let s = initialFoldState(DRAFT_PROTOCOL);
  for (let h = 0; h <= hs; h++) {
    const [peer, ops] = special.get(h) ?? [rotation[h % rotation.length]!, []];
    const wr = w.get(peer)!;
    const lines = ops.map((o) => wr.op(o));
    s = foldCommit(s, draft({ writer: wr.writer(), opsLines: lines }), ZERO_PEER).state;
  }
  assert.equal(s.height, hs);
  return s;
}

/**
 * Heights 0-512: A joins with two seats (ending one at 10, with an old HOST_THROTTLED event), G joins at 1 and never
 * commits again (a ghost by 512), B, C, F, S, R (another regionSpec) and K (co-author opt-in, two seats started in reverse
 * key order) join, L joins with a seat and leaves; F unfreezes then freezes at 30 (newest: freeze); C freezes then unfreezes
 * at 40 (newest: unfreeze); S posts HOST_THROTTLED 100 heights before 512; everyone else commits in rotation to stay ranked.
 */
function checkpointState(): FoldState {
  const s = foldBoard(HS, [A, B, C, F, G, K, L, R, S], new Map<number, [PeerRef, Array<Record<string, Json>>]>([
    [0, [A, [join(), seat('seat_start', SEAT_A1), seat('seat_start', SEAT_A2)]]],
    [1, [G, [join()]]], [2, [B, [join()]]], [3, [C, [join()]]], [4, [F, [join()]]], [5, [S, [join()]]], [6, [R, [join('rs-2')]]],
    [7, [K, [join('rs-1', 'Kim <kim@example.com>'), seat('seat_start', SEAT_K2), seat('seat_start', SEAT_K1)]]],
    [8, [L, [join(), seat('seat_start', SEAT_L1)]]], [9, [L, [{ type: 'leave' }]]],
    [10, [A, [event('health', 'HOST_THROTTLED'), seat('seat_end', SEAT_A2)]]],
    [30, [F, [event('unfreeze'), event('freeze', 'EPOCH')]]],
    [40, [C, [event('freeze', 'MASS'), event('unfreeze')]]],
    [HS - 100, [S, [event('health', 'HOST_THROTTLED')]]],
  ]), [A, B, C, F, S, R, K]);
  // Plan 2 folds presume_absent as a no-op, so the absent status is written into the checkpoint by hand; and a live seat
  // whose owner is not drawn (L left) stands for a seat the fold keeps while its owner is gone.
  s.peers[B]!.status = 'absent';
  s.seats[key(L, SEAT_L1)] = { status: 'live', permission_mode: 'default' };
  return s;
}

const HOME_ORDER = [A, B, C, F, G, K, R, S];

function character(spot: number, o: Partial<CharacterState> = {}): CharacterState {
  return { place: { at: 'home', spot }, pose: 'idle', lastPublish: null, lastDesk: null, lastClaimOp: null, ghost: false, absent: false, frozen: null, slowedUntil: null, rules: false, credit: false, ...o };
}
function pet(owner: PeerRef, variant: number): PetState {
  return { place: { at: 'behind', peer: owner }, pose: 'idle', lastPublish: null, lastDesk: null, lastClaimOp: null, owner, variant, live: true, ssCode: null };
}

test('T-VIZ-start: startScene gives exactly the 12 \u{a7}3.3.5 start scene', () => {
  const st = checkpointState();
  // The fixture holds what the test names: a ghost, an absent and a left peer, events, live and ended seats.
  assert.deepEqual(liveSet(st).filter((p) => !rankedSet(st).includes(p)), [G]);
  assert.equal(st.peers[L]!.status, 'left');
  assert.equal(st.seats[key(A, SEAT_A2)]!.status, 'ended');
  assert.equal(st.teamRegionSpec, 'rs-1');
  const before = structuredClone(st);
  const layout = officeOf(['src/a.ts'], HOME_ORDER);
  const s = startScene(st, HS, layout);
  assert.deepEqual(st, before, 'startScene reads its state only');

  const expected: Scene = emptyScene({ height: HS, sub: 0, k: 0 });
  expected.characters = new Map<PeerRef, CharacterState>([
    [A, character(0)],                                    // active; its HOST_THROTTLED at 10 ended at 190 <= 512
    [B, character(1, { absent: true })],
    [C, character(2)],                                    // its newest freeze/unfreeze event is an unfreeze
    [F, character(3, { frozen: 'EPOCH' })],               // newest is the freeze (same height, a higher op seq)
    [G, character(4, { ghost: true })],
    [K, character(5, { credit: true })],
    [R, character(6, { rules: true })],
    [S, character(7, { slowedUntil: HS - 100 + 180 })],
  ]);
  expected.pets = new Map<string, PetState>([
    [key(A, SEAT_A1), pet(A, 0)],
    [key(K, SEAT_K1), pet(K, 0)],                         // sorted seat-key order, not seat_start order
    [key(K, SEAT_K2), pet(K, 1)],
  ]);
  assert.deepEqual(s, expected);

  // The badge comes from record_count alone.
  assert.equal(st.record_count < 4_000, true);
  for (const [count, badge] of [[3_999, 'none'], [4_000, 'near_full'], [4_999, 'near_full'], [5_000, 'full'], [7_000, 'full']] as const) {
    assert.equal(startScene({ ...st, record_count: count }, HS, layout).badge, badge, `record_count ${count}`);
  }
  // initialFoldState (hs = 0) gives an empty scene.
  assert.deepEqual(startScene(initialFoldState(DRAFT_PROTOCOL), 0, emptyLayout()), emptyScene({ height: 0, sub: 0, k: 0 }));
});

test('T-VIZ-start: startScene is independent of desks appended later', () => {
  const st = checkpointState();
  const small = officeOf(['src/a.ts', 'src/b.ts'], HOME_ORDER);
  const large = officeOf(Array.from({ length: 39 }, (_, i) => `z${i % 7}/f${i}.ts`), HOME_ORDER);
  assert.equal(small.desks.length, 3);
  assert.equal(large.desks.length, 40);
  const a = startScene(st, HS, small);
  assert.deepEqual(startScene(st, HS, large), a);
  assert.equal(a.desks.size, 0, 'Scene.desks is sparse: no entry for a desk with no event, chair, visitor or claim');
});

test('T-VIZ-start: a freeze re-posted inside the compaction horizon (R-V71) still shows; one compacted away degrades to PH_OK, never a crash', () => {
  // P froze (PAUSED) at 30 and, still frozen, re-posts its freeze whenever its last one is older than 256 heights (300,
  // 560, 820); N froze (NOHOOKS) at 31 and never re-posts. At 1,024 the fold has dropped every event at or below 512.
  const P = hex(0x11), N = hex(0x12), hs = 1_024;
  const st = foldBoard(hs, [P, N], new Map<number, [PeerRef, Array<Record<string, Json>>]>([
    [0, [P, [join()]]], [1, [N, [join()]]],
    [30, [P, [event('freeze', 'PAUSED')]]], [31, [N, [event('freeze', 'NOHOOKS')]]],
    [300, [P, [event('freeze', 'PAUSED')]]], [560, [P, [event('freeze', 'PAUSED')]]], [820, [P, [event('freeze', 'PAUSED')]]],
  ]), [P, N]);
  assert.deepEqual(Object.values(st.events).map((e) => [e.kind, e.reason_code, e.height]).sort(), [['freeze', 'PAUSED', 560], ['freeze', 'PAUSED', 820]]);
  const s = startScene(st, hs, officeOf([], [P, N]));
  const at = { height: hs, sub: 0, k: 0 };
  assert.equal(s.characters.get(P)!.frozen, 'PAUSED');
  assert.equal(phOf(s.characters.get(P), 'active', at), 'PH_PAUSED');
  assert.equal(s.characters.get(N)!.frozen, null, 'its freeze was compacted away');
  assert.equal(phOf(s.characters.get(N), 'active', at), 'PH_OK');
});

test('T-VIZ-start: slowed until the largest h + 180 over the HOST_THROTTLED events with h + 180 > hs; h + 180 = hs is not slowed', () => {
  const S1 = hex(0x21), S2 = hex(0x22), S3 = hex(0x23), hs = 256;
  const throttled = (): Record<string, Json> => event('health', 'HOST_THROTTLED');
  const st = foldBoard(hs, [S1, S2, S3], new Map<number, [PeerRef, Array<Record<string, Json>>]>([
    [0, [S1, [join()]]], [1, [S2, [join()]]], [2, [S3, [join()]]],
    [hs - 180, [S1, [throttled()]]],                     // ends exactly at hs
    [hs - 179, [S2, [throttled()]]],                     // ends one height after hs
    [hs - 156, [S3, [throttled()]]], [hs - 106, [S3, [throttled()]]], [hs - 130, [S3, [event('health', 'TEST_REASON')]]],
  ]), [S1, S2, S3]);
  const s = startScene(st, hs, officeOf([], [S1, S2, S3]));
  assert.deepEqual([S1, S2, S3].map((p) => s.characters.get(p)!.slowedUntil), [null, hs + 1, hs + 74]);
  assert.equal(isSlowed(s.characters.get(S2)!, { height: hs, sub: 0, k: 0 }), true);
  assert.equal(phOf(s.characters.get(S1), 'active', { height: hs, sub: 0, k: 0 }), 'PH_OK');
});
