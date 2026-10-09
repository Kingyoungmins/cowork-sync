// Fold properties (Plan 2 Task 6): totality under fuzzing (T-PRO-11, INV-PRO-TOTAL) and checkpoint
// equivalence with compaction safety (T-PRO-10 subset, INV-PRO-FOLD, INV-PRO-COMPACT).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import fc from 'fast-check';
import { parseCsTrailers, parseWriter, type BoardDraft, type WriterId } from '../../src/board/boardCommit.js';
import { canonicalJson, type Json } from '../../src/board/canonicalJson.js';
import { eventCid } from '../../src/board/ops.js';
import { genesisProtocol, readProtocol } from '../../src/board/protocol.js';
import {
  CHECKPOINT_EVERY,
  COMPACT_AGE,
  foldCommit,
  initialFoldState,
  parseFold,
  serializeFold,
  type FoldState,
} from '../../src/board/fold.js';
import type { Oid } from '../../src/git/oid.js';
import { foldAll, generateBoard, genDraft } from '../helpers/foldBoard.js';

const SELF = '5e1f5e1f5e1f5e1f5e1f5e1f5e1f5e1f';
const OTHER = '07e207e207e207e207e207e207e207e2';
const E1 = 'e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1';
const L0 = '1'.repeat(40) as Oid;
const PROTOCOL = genesisProtocol(12, 'rs-1');
const opId = (peer: string, seq: number | string): string => `${peer}/${E1}/${seq}`;
const L = (o: Record<string, Json>): string => canonicalJson(o);

function joinL(peer: string, seq: number): string {
  return L({
    id: opId(peer, seq), type: 'join', display: 'Peer', plugin_version: '0.2.0', plugin_sha: 'f'.repeat(64), proto: 1, regionSpec: 'rs-1',
    config_fingerprint: { filters: {}, autocrlf: '', eol_attrs: '', git: '2.47.1' }, coauthor_optin: false,
  });
}

/** Two folded commits: SELF and OTHER joined (last_seq 2 each), a live seat and an event. */
function seededState(): FoldState {
  let s = initialFoldState(PROTOCOL);
  const d = (writer: WriterId, lines: string[]): BoardDraft => ({ liveCode: L0, writer, cs: [], protocol: PROTOCOL, opsLines: lines, checkpoint: null, heldIds: [] });
  s = foldCommit(s, d({ peer: SELF, epoch: E1, seq: 4 }, [joinL(SELF, 1), L({ id: opId(SELF, 2), type: 'seat_start', seat_id: 'a'.repeat(32), permission_mode: 'default' }), L({ id: opId(SELF, 3), type: 'event', cid: eventCid(opId(SELF, 3), 'freeze'), kind: 'freeze', refs: [], reason_code: 'EPOCH_CHANGED' })]), SELF).state;
  s = foldCommit(s, d({ peer: OTHER, epoch: E1, seq: 2 }, [joinL(OTHER, 1)]), SELF).state;
  return s;
}

const VALID_LINES: readonly string[] = [
  joinL(SELF, 5),
  L({ id: opId(SELF, 6), type: 'seat_start', seat_id: 'b'.repeat(32), permission_mode: 'plan' }),
  L({ id: opId(SELF, 7), type: 'event', cid: eventCid(opId(SELF, 7), 'health'), kind: 'health', refs: ['x'], reason_code: 'HOST_THROTTLED' }),
  L({ id: opId(SELF, 8), type: 'caps', custom_refs: true, lease: true, delete: true, push_options: true, two_parent_ok: false }),
  L({ id: opId(SELF, 9), type: 'note', target: null, text: 'n' }),
  L({ id: opId(SELF, 10), type: 'leave' }),
];

const deep = (d: number): string => `{"id":"${opId(SELF, 11)}","type":"note","x":${'['.repeat(d)}${']'.repeat(d)}}`;
const deepObject = (d: number): string => `${'{"a":'.repeat(d)}1${'}'.repeat(d)}`;

const lineArb: fc.Arbitrary<string> = fc.oneof(
  fc.string({ maxLength: 120 }),
  fc.string({ unit: 'binary', maxLength: 60 }),
  fc.uint8Array({ maxLength: 200 }).map((b) => Buffer.from(b).toString('utf8')),
  fc.uint8Array({ maxLength: 200 }).map((b) => Buffer.from(b).toString('latin1')),
  fc.tuple(fc.constantFrom(...VALID_LINES), fc.nat()).map(([l, i]) => l.slice(0, i % (l.length + 1))),   // truncated JSON
  fc.constantFrom(...VALID_LINES),
  fc.integer({ min: 65, max: 5_000 }).map(deep),                                                       // deep nesting
  fc.integer({ min: 65, max: 5_000 }).map(deepObject),
  fc.constantFrom(                                                                                       // huge numbers
    `{"id":"${opId(SELF, '99999999999999999999999')}","type":"leave"}`,
    `{"id":"${opId(SELF, 12)}","type":"join","proto":1e400,"display":"x"}`,
    `{"id":"${opId(SELF, 13)}","type":"event","cid":"AAAAAAAA","kind":"freeze","refs":[1e999],"reason_code":"ABC"}`,
    `{"id":"${opId(SELF, 14)}","type":"note","n":123456789012345678901234567890e300}`,
    `{"id":"${opId(SELF, 15)}","type":"seat_start","seat_id":"${'a'.repeat(32)}","permission_mode":-1e-400}`,
  ),
  fc.json().map((j) => j),
);

const writerArb: fc.Arbitrary<WriterId | null> = fc.oneof(
  fc.constant(null),
  fc.string({ maxLength: 80 }).map((s) => parseWriter(s)),
  fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }).map((seq) => ({ peer: SELF, epoch: E1, seq })),
  fc.integer({ min: 1, max: 40 }).map((seq) => ({ peer: OTHER, epoch: E1, seq })),
);

const protocolArb = fc.oneof(
  fc.constant(PROTOCOL),
  fc.uint8Array({ maxLength: 80 }).map((b) => readProtocol(Buffer.from(b))),
  fc.json().map((j) => readProtocol(Buffer.from(j, 'utf8'))),
);

const csArb = fc.array(fc.record({ key: fc.constantFrom('Cowork-CS', 'Cowork-CS-Paths', 'X'), value: fc.string({ maxLength: 60 }) }), { maxLength: 4 })
  .map((t) => parseCsTrailers(t).cs);

test('random bytes, truncated JSON, deep nesting and huge numbers never throw, and a 1,000-op commit folds in ≤ 50 ms', () => {
  const states = [initialFoldState(PROTOCOL), seededState()];
  fc.assert(
    fc.property(fc.constantFrom(0, 1), writerArb, fc.array(lineArb, { maxLength: 40 }), protocolArb, csArb, fc.constantFrom(SELF, OTHER), (si, writer, lines, protocol, cs, self) => {
      const prev = states[si]!;
      const before = serializeFold(prev);
      const d: BoardDraft = { liveCode: L0, writer, cs, protocol, opsLines: lines, checkpoint: null, heldIds: [] };
      const r = foldCommit(prev, d, self);
      assert.ok(serializeFold(prev).equals(before), 'the previous state is never mutated');
      const bytes = serializeFold(r.state);
      assert.equal(r.state.height, prev.height + 1);
      const back = parseFold(bytes);
      assert.ok(back !== null, 'every folded state serializes and parses back');
      assert.ok(serializeFold(back).equals(bytes));
      for (const x of r.ownRejections) assert.ok(x.reason === 'generic' || x.reason === 'type');
    }),
    { numRuns: 400 },
  );

  // Determinism on ordinary (shallow) input: the same commit folds to the same bytes and results.
  fc.assert(
    fc.property(writerArb, fc.array(fc.oneof(fc.constantFrom(...VALID_LINES), fc.string({ maxLength: 60 }), fc.json()), { maxLength: 30 }), (writer, lines) => {
      const d: BoardDraft = { liveCode: L0, writer, cs: [], protocol: PROTOCOL, opsLines: lines, checkpoint: null, heldIds: [] };
      const a = foldCommit(states[1]!, d, SELF);
      const b = foldCommit(states[1]!, d, SELF);
      assert.ok(serializeFold(a.state).equals(serializeFold(b.state)));
      assert.deepEqual(a.ownRejections, b.ownRejections);
      assert.deepEqual(a.landedOwnOpIds, b.landedOwnOpIds);
    }),
    { numRuns: 200 },
  );

  // 1,000 op lines of the writer (more than 64 KiB: the fold reads what fits) in ≤ 50 ms.
  const base = seededState();
  const lines: string[] = [];
  for (let seq = 5; lines.length < 1_000; seq++) {
    const k = seq % 4;
    const id = opId(SELF, seq);
    lines.push(
      k === 0 ? L({ id, type: 'event', cid: eventCid(id, 'freeze'), kind: 'freeze', refs: [], reason_code: 'EPOCH_CHANGED' })
        : k === 1 ? L({ id, type: 'seat_start', seat_id: seq.toString(16).padStart(32, '0'), permission_mode: 'default' })
          : k === 2 ? L({ id, type: 'seat_end', seat_id: (seq - 1).toString(16).padStart(32, '0'), permission_mode: 'default' })
            : L({ id, type: 'note', target: null, text: 'x' }),
    );
  }
  const d: BoardDraft = { liveCode: L0, writer: { peer: SELF, epoch: E1, seq: 2_000 }, cs: [], protocol: PROTOCOL, opsLines: lines, checkpoint: null, heldIds: [] };
  const times: number[] = [];
  let landed = 0;
  for (let i = 0; i < 8; i++) {
    const t0 = performance.now();
    const r = foldCommit(base, d, SELF);
    times.push(performance.now() - t0);
    landed = r.landedOwnOpIds.length;
  }
  assert.ok(landed > 300, `the fold read the first 64 KiB of ops (${landed} landed)`);
  const measured = times.slice(3).sort((a, b) => a - b);
  const median = measured[Math.floor(measured.length / 2)]!;
  assert.ok(median <= 50, `a 1,000-op commit folded in ${median.toFixed(1)} ms (runs: ${times.map((t) => t.toFixed(1)).join(', ')})`);
});

test('folds of one 600-commit board from genesis and from each checkpoint are byte-identical at every height, and no non-terminal record is compacted', () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), (seed) => {
      const gen = generateBoard(`fold-prop-${seed}`, 600);
      const self = gen.peers[1]!;
      const states = foldAll(gen, self, L0);
      const bytes = states.map((s) => serializeFold(s));
      assert.equal(states[599]!.height, 599);

      // From each checkpoint (its serialized bytes, as a joiner reads them) to the end.
      for (const c of [0, CHECKPOINT_EVERY, 2 * CHECKPOINT_EVERY]) {
        let s = parseFold(bytes[c]!);
        assert.ok(s !== null, `checkpoint ${c} parses`);
        for (let h = c + 1; h < 600; h++) {
          s = foldCommit(s, genDraft(gen, gen.commits[h]!, L0), self).state;
          assert.ok(serializeFold(s).equals(bytes[h]!), `seed ${seed}: from checkpoint ${c}, height ${h} differs`);
        }
      }

      // A record disappears only by compaction: at a checkpoint height, terminal, at least COMPACT_AGE old.
      let dropped = 0;
      for (let h = 1; h < 600; h++) {
        const prev = states[h - 1]!;
        const cur = states[h]!;
        for (const [key, seat] of Object.entries(prev.seats)) {
          if (cur.seats[key] !== undefined) continue;
          dropped++;
          assert.equal(h % CHECKPOINT_EVERY, 0, `seat ${key} vanished at height ${h}`);
          assert.equal(seat.status, 'ended', `a live seat was compacted at ${h}`);
          assert.ok(seat.ended_height !== undefined && seat.ended_height <= h - COMPACT_AGE);
        }
        for (const [cid, ev] of Object.entries(prev.events)) {
          if (cur.events[cid] !== undefined) continue;
          dropped++;
          assert.equal(h % CHECKPOINT_EVERY, 0, `event ${cid} vanished at height ${h}`);
          assert.ok(ev.height <= h - COMPACT_AGE);
        }
        for (const p of Object.keys(prev.peers)) assert.ok(cur.peers[p] !== undefined, `peer ${p} vanished`);
      }
      assert.ok(dropped >= 2, 'compaction at 512 dropped the height-0 event and the B0 seat');
      assert.ok(Object.values(states[511]!.events).some((e) => e.height === 0));
      assert.ok(!Object.values(states[512]!.events).some((e) => e.height === 0));
      // PRO-27 for seats: the seat B0 ended at height 0 is still there at 511 and gone at 512.
      assert.deepEqual(states[511]!.seats[gen.b0SeatKey], { status: 'ended', permission_mode: 'default', ended_height: 0 }, `seed ${seed}: the B0 seat at 511`);
      assert.equal(states[512]!.seats[gen.b0SeatKey], undefined, `seed ${seed}: the B0 seat was compacted at 512`);
    }),
    { numRuns: 6 },
  );
});
