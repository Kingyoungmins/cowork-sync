// Plan 8a Task 6: foldFrame (12 §3.3.3, §3.3.4; R-V03, R-V19, R-V25, PRO-28): the checkpoint compare is display-only (the owner's
// 2026-10-08 choice withdrew the X-92 re-seed: the viewer always continues from its own fold).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WriterId } from '../../../src/board/boardCommit.js';
import { canonicalBytes, canonicalJson, type Json } from '../../../src/board/canonicalJson.js';
import { foldCommit, initialFoldState, parseFold, serializeFold, type FoldState } from '../../../src/board/fold.js';
import { parseOpLine } from '../../../src/board/ops.js';
import { foldFrame, ZERO_PEER, type FrameCode, type FrameInput } from '../../../src/viz/model/frame.js';
import { draft, DRAFT_PROTOCOL } from '../../helpers/vizEvents.js';

const A = 'a1'.repeat(16), EA = 'ea'.repeat(16);
const W = (seq: number): WriterId => ({ peer: A, epoch: EA, seq });
const join = (seq: number, extra: Record<string, Json> = {}): string => canonicalJson({
  id: `${A}/${EA}/${seq}`, type: 'join', display: 'Ann', plugin_version: '0.0.0', plugin_sha: '0'.repeat(64), proto: 1, regionSpec: 'rs-1',
  config_fingerprint: { filters: {}, autocrlf: '', eol_attrs: '', git: '2.43.0' }, coauthor_optin: false, ...extra,
});
const caps = (seq: number): string => canonicalJson({ id: `${A}/${EA}/${seq}`, type: 'caps', custom_refs: true, lease: true, delete: true, push_options: false, two_parent_ok: true });
const UNCHANGED: FrameCode = { changed: false, shape: null, seats: [], base: null };
const input = (height: number, d = draft({ writer: null }), code: FrameCode = UNCHANGED): FrameInput =>
  ({ height, oid: 'b'.repeat(40), draft: d, csPaths: new Map(), code, malformed: false });

/** The state after B0 (A's join and caps), then moved to height h − 1 so that the next fold lands at h. */
function stateAt(h: number): FoldState {
  const s = foldCommit(initialFoldState(DRAFT_PROTOCOL), draft({ writer: W(3), opsLines: [join(1), caps(2)] }), ZERO_PEER).state;
  return { ...s, height: h - 1 };
}

test('foldFrame: code.changed false at height 0, shape read only when changed, protoMismatch and the checkpoint compare reported', () => {
  const s0 = initialFoldState(DRAFT_PROTOCOL);
  const b0 = draft({ writer: W(3), opsLines: [join(1), caps(2), '{not json', join(9)] });
  // Height 0: the genesis L0 is never a "change" (12 §3.3.4), whatever the source said; its shape stays.
  const f0 = foldFrame(s0, input(0, b0, { changed: true, shape: 'genesis', seats: [], base: 'c'.repeat(40) }), ZERO_PEER);
  assert.deepEqual(f0.code, { changed: false, shape: 'genesis', seats: [], base: 'c'.repeat(40) });
  assert.equal(f0.height, 0);
  assert.equal(f0.before, s0);
  assert.deepEqual(f0.after, foldCommit(s0, b0, ZERO_PEER).state);
  assert.deepEqual(f0.writer, W(3));
  // Every ops.jsonl line, with the fold's verdict; op is the parsed op for parsed lines, null otherwise.
  assert.deepEqual(f0.ops.map((o) => [o.line, o.type, o.verdict]), [[0, 'join', 'effective'], [1, 'caps', 'effective'], [2, 'unknown', 'rejected'], [3, 'join', 'rejected']]);
  assert.deepEqual(f0.ops[0]!.op, parseOpLine(join(1)) as unknown as Json);
  assert.equal(f0.ops[2]!.op, null);
  assert.deepEqual(f0.ops[3]!.op, parseOpLine(join(9)) as unknown as Json);   // parsed, then generically rejected (seq ≥ writer seq)
  assert.equal(f0.protoMismatch, false);
  assert.equal(f0.checkpoint, null);
  assert.equal(f0.malformed, false);

  // Later heights: an unchanged frame's shape is not read (null), a changed one keeps the source's shape.
  const s1 = f0.after;
  assert.deepEqual(foldFrame(s1, input(1, draft({ writer: null }), { changed: false, shape: 'ordinary', seats: ['human'], base: null }), ZERO_PEER).code,
    { changed: false, shape: null, seats: ['human'], base: null });
  assert.deepEqual(foldFrame(s1, input(1, draft({ writer: null }), { changed: true, shape: 'base_move', seats: [], base: 'd'.repeat(40) }), ZERO_PEER).code,
    { changed: true, shape: 'base_move', seats: [], base: 'd'.repeat(40) });
  // A newer protocol: the fold's protoMismatch.
  assert.equal(foldFrame(s1, input(1, draft({ writer: null, protocol: { ...DRAFT_PROTOCOL, proto: 2 } })), ZERO_PEER).protoMismatch, true);
  // R-V19: the malformed flag is carried.
  assert.equal(foldFrame(s1, { ...input(1), malformed: true }, ZERO_PEER).malformed, true);
  // A frame must follow its state: height prev.height + 1.
  assert.throws(() => foldFrame(s1, input(5), ZERO_PEER), RangeError);

  // PRO-28 at a checkpoint height: byte-equal → match; any other bytes → mismatch with the viewer's own fold; off 256 → null.
  const prev = stateAt(256);
  const own = foldCommit(prev, draft({ writer: null }), ZERO_PEER).state;
  const good = foldFrame(prev, input(256, draft({ writer: null, checkpoint: serializeFold(own) })), ZERO_PEER);
  assert.equal(good.checkpoint, 'match');
  assert.deepEqual(good.after, own);
  const bad = foldFrame(prev, input(256, draft({ writer: null, checkpoint: Buffer.from('{"v":1}') })), ZERO_PEER);
  assert.equal(bad.checkpoint, 'mismatch');
  assert.deepEqual(bad.after, own);
  assert.equal(foldFrame(prev, input(256), ZERO_PEER).checkpoint, null);
  const off = stateAt(255);
  assert.equal(foldFrame(off, input(255, draft({ writer: null, checkpoint: Buffer.from('{"v":1}') })), ZERO_PEER).checkpoint, null);
});

test("T-VIZ-version (checkpoint): a checkpoint byte-equal to the viewer's fold reads match; a checkpoint that differs in any member reads mismatch and the next frame folds from the viewer's own after, never from the checkpoint", () => {
  const prev = stateAt(256);
  const own = foldCommit(prev, draft({ writer: null }), ZERO_PEER).state;
  const at256 = (checkpoint: Buffer | null): FrameInput => input(256, draft({ writer: null, checkpoint }));
  // Byte-equal: match, and the frame's after is the viewer's own fold.
  const same = foldFrame(prev, at256(serializeFold(own)), ZERO_PEER);
  assert.equal(same.checkpoint, 'match');
  assert.deepEqual(same.after, own);

  // A well-formed checkpoint that differs only in claim records (what a later plan's daemon writes) is a mismatch like any
  // other difference (12 §3.3.3: display-only): the viewer keeps its own fold, and the next frame folds from it.
  const theirs: FoldState = { ...own, claims: { c1: { path: 'src/a.ts', seat: `${A}/${EA}/${'5'.repeat(32)}` } }, record_count: own.record_count + 1 };
  const theirBytes = canonicalBytes(theirs as unknown as Json);
  assert.notEqual(parseFold(theirBytes), null);
  const claimsOnly = foldFrame(prev, at256(theirBytes), ZERO_PEER);
  assert.equal(claimsOnly.checkpoint, 'mismatch');
  assert.deepEqual(claimsOnly.after, own);
  const next = foldFrame(claimsOnly.after, input(257), ZERO_PEER);
  assert.equal(next.before, claimsOnly.after);
  assert.deepEqual([next.after.claims, next.after.record_count], [{}, own.record_count]);
  assert.equal(next.checkpoint, null);

  // Any other difference: mismatch, own fold (another team regionSpec, a trailing line feed, an unparseable file).
  const others: Array<Buffer> = [
    canonicalBytes({ ...own, teamRegionSpec: 'rs-9' } as unknown as Json),
    Buffer.concat([serializeFold(own), Buffer.from([0x0a])]),
    Buffer.from('{"v":1}'),
  ];
  for (const b of others) {
    const f = foldFrame(prev, at256(b), ZERO_PEER);
    assert.equal(f.checkpoint, 'mismatch');
    assert.deepEqual(f.after, own);
  }
  // The withdrawn re-seed (X-92 as revised by the owner, 2026-10-08) is pinned by behaviour above — a parseable claims-only
  // checkpoint never becomes after, and the next frame folds from the viewer's own state — not by foldFrame's parameter count,
  // which Task 20 (F-8a-13) extends with the claim inputs.
});
