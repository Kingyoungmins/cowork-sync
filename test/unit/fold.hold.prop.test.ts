// holdsCompactedAt (Plan 3 Task 3; PRO-27, Contract additions): the writer of the commit at height h removes the held/
// subtrees of exactly the holds the fold drops there, so the prediction from the state before the commit must equal
// foldCommit's compactedHolds whatever the commit at h carries — creates, updates, terminal → terminal ops and attempts
// to revive a terminal record included.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BoardDraft } from '../../src/board/boardCommit.js';
import { canonicalJson, type Json } from '../../src/board/canonicalJson.js';
import { CHECKPOINT_EVERY, foldCommit, holdsCompactedAt, initialFoldState, parseFold, serializeFold, type FoldedHold, type FoldState } from '../../src/board/fold.js';
import { genesisProtocol } from '../../src/board/protocol.js';
import type { Oid } from '../../src/git/oid.js';
import { randomInt, seededRandom, type Random } from '../../src/ports/random.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const P1 = 'a1'.repeat(16);
const P2 = 'b2'.repeat(16);
const E1 = 'e1'.repeat(16);
const L0 = '1'.repeat(40) as Oid;
const PROTOCOL = genesisProtocol(12, 'rs-1');
const STATES = ['ACTIVE', 'CONFLICTED', 'PARKED', 'SUBSUMED', 'GONE', 'RESOLVED_PUBLISH', 'RESOLVED_DISCARD'] as const;
const TERMINAL: ReadonlySet<string> = new Set(['SUBSUMED', 'GONE', 'RESOLVED_PUBLISH', 'RESOLVED_DISCARD']);
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const L = (o: Record<string, unknown>): string => canonicalJson(o as Json);

function ulidOf(r: Random): string {
  let s = String(randomInt(r, 8));
  for (let i = 0; i < 25; i++) s += CROCKFORD[randomInt(r, 32)];
  return s;
}
const residenceOf = (state: string): 'ON_DISK' | 'OFF_DISK' | null => (TERMINAL.has(state) ? null : state === 'PARKED' ? 'OFF_DISK' : 'ON_DISK');

/** P1 and P2 joined at heights 0 and 1 (last_seq 2 each). */
function base(): FoldState {
  const join = (peer: string): string => L({
    id: `${peer}/${E1}/1`, type: 'join', display: 'Peer', plugin_version: '0.3.0', plugin_sha: 'f'.repeat(64), proto: 1, regionSpec: 'rs-1',
    config_fingerprint: { filters: {}, autocrlf: '', eol_attrs: '', git: '2.47.1' }, coauthor_optin: false,
  });
  const d = (peer: string): BoardDraft => ({ liveCode: L0, writer: { peer, epoch: E1, seq: 2 }, cs: [], protocol: PROTOCOL, opsLines: [join(peer)], checkpoint: null, heldIds: [] });
  return foldCommit(foldCommit(initialFoldState(PROTOCOL), d(P1), P1).state, d(P2), P1).state;
}

/** A fold state with up to 14 holds of either owner, half of them terminal at a height in 0..2047. */
function generatedState(r: Random, b: FoldState): FoldState {
  const s = structuredClone(b);
  const n = randomInt(r, 15);
  for (let i = 0; i < n; i++) {
    const state = STATES[randomInt(r, STATES.length)]!;
    const entry: FoldedHold = {
      rev: 1 + randomInt(r, 6), kind: (['PATCH', 'PIN', 'INCOMING'] as const)[randomInt(r, 3)]!, residence: residenceOf(state), state,
      offer: 'none', guards: [{ name: 'revert', class: 'DECISION', owner: 'HLD' }], paths: ['a.txt'], origin: 'human', cs_ids: [], peer_authors: [],
      local_only: randomInt(r, 4) === 0, owner: randomInt(r, 3) === 0 ? P2 : P1,
    };
    if (TERMINAL.has(state)) entry.terminal_height = randomInt(r, 2_048);
    s.holds[ulidOf(r)] = entry;
  }
  s.record_count = Object.keys(s.holds).length;
  return s;
}

/** The commit at h: up to 5 ops of P1 — updates of its records (to any state: revivals and terminal → terminal included) and creates. */
function generatedDraft(r: Random, s: FoldState): BoardDraft {
  const lines: string[] = [];
  let seq = 10;
  const ids = Object.keys(s.holds).filter((k) => s.holds[k]!.owner === P1);
  const k = randomInt(r, 6);
  for (let i = 0; i < k; i++) {
    const state = STATES[randomInt(r, STATES.length)]!;
    const target = ids.length > 0 && randomInt(r, 4) !== 0 ? ids[randomInt(r, ids.length)]! : null;
    const folded = target === null ? null : s.holds[target]!;
    lines.push(L({
      id: `${P1}/${E1}/${seq++}`, type: 'hold', hold_id: target ?? ulidOf(r), rev: (folded?.rev ?? 0) + 1, prev_rev: folded?.rev ?? null,
      kind: 'PATCH', residence: residenceOf(state), state, offer: 'none', guards: [{ name: 'revert', class: 'DECISION', owner: 'HLD' }],
      paths: ['a.txt'], origin: 'human', cs_ids: [], peer_authors: [], local_only: false,
    }));
  }
  const heldIds = [...Object.keys(s.holds), ...lines.map((l) => (JSON.parse(l) as { hold_id: string }).hold_id)];
  return { liveCode: L0, writer: { peer: P1, epoch: E1, seq: 100 }, cs: [], protocol: PROTOCOL, opsLines: lines, checkpoint: null, heldIds };
}

/** The full forms of the long sweeps run only with COWORK_SIM_LONG=1 (the nightly job); every push runs the fast forms. */
const LONG = process.env['COWORK_SIM_LONG'] === '1';
const ALL_HEIGHTS = Array.from({ length: 2_048 }, (_, i) => i + 1);
/** Every checkpoint height in 1…2048 and its two neighbours, plus both ends: where compaction can and cannot happen. */
const EDGE_HEIGHTS = [...new Set([1, 2, 2_047, 2_048, ...Array.from({ length: 8 }, (_, k) => [256 * (k + 1) - 1, 256 * (k + 1), 256 * (k + 1) + 1]).flat()])]
  .filter((h) => h >= 1 && h <= 2_048).sort((a, b) => a - b);

// Full form (COWORK_SIM_LONG=1): 200 states × every height 1…2048 (~400,000 folds). Fast form (every push): 200 states × the
// edge heights, and the first 16 states × every height.
test('holdsCompactedAt predicts exactly what foldCommit drops', T10, () => {
  const b = base();
  let dropped = 0;
  let revivals = 0;
  for (let i = 0; i < 200; i++) {
    const r = seededRandom(`holds-compacted-${i}`);
    const s = generatedState(r, b);
    assert.ok(parseFold(serializeFold(s)) !== null, `state ${i} is a well-formed fold state`);
    const d = generatedDraft(r, s);
    for (const h of LONG || i < 16 ? ALL_HEIGHTS : EDGE_HEIGHTS) {
      const prev: FoldState = { ...s, height: h - 1 };
      const predicted = holdsCompactedAt(prev, h);
      const out = foldCommit(prev, d, P1);
      assert.deepEqual(predicted, out.compactedHolds, `state ${i}, height ${h}`);
      if (h % CHECKPOINT_EVERY !== 0) {
        assert.deepEqual(predicted, [], `state ${i}: nothing is compacted at ${h}`);
        continue;
      }
      dropped += out.compactedHolds.length;
      for (const hid of out.compactedHolds) assert.equal(out.state.holds[hid], undefined);
      for (const [hid, x] of Object.entries(out.state.holds)) {
        assert.ok(!(TERMINAL.has(x.state) && x.terminal_height! <= h - 512), `state ${i}: ${hid} should have been dropped at ${h}`);
      }
      revivals += out.ownRejections.filter((x) => x.reason === 'type' && x.holdId !== null && TERMINAL.has(s.holds[x.holdId]?.state ?? '')).length;
    }
  }
  assert.ok(dropped > 100, `the generated states exercise compaction (${dropped} drops)`);
  assert.ok(revivals > 0, 'and commits at h that try to revive a terminal record');
});
