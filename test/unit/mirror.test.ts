// The record → `hold` op mirror (Plan 3 Task 4; glossary §7, HLD-04, HLD-10, HLD-62, PRO-21 writer side; R3-24…R3-29):
// projectOp, heldBlobs, mirrorKey, mirrorWorthy, creationDue, checkMirror and isDurable as pure functions over hand-built
// records (no git).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HeldBlob } from '../../src/board/boardCommit.js';
import type { FoldedHold } from '../../src/board/fold.js';
import { parseOpLine, type HoldOp } from '../../src/board/ops.js';
import { ABSENT, parseOid, type Oid } from '../../src/git/oid.js';
import { checkMirror, creationDue, heldBlobs, isDurable, mirrorKey, mirrorShown, mirrorWorthy, projectOp } from '../../src/holds/mirror.js';
import { makeGuard, type HoldBlobs, type HoldRecord } from '../../src/holds/record.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const PEER = '0123456789abcdef0123456789abcdef';
const EPOCH = 'fedcba9876543210fedcba9876543210';
const ID = '01J9ZQ3C5X00000000000000AA';
const o = (n: number): Oid => parseOid(n.toString(16).padStart(40, '0'));
const X = o(0x10);
const Y = o(0x11);
const Z = o(0x12);

function rec(over: Partial<HoldRecord> = {}): HoldRecord {
  const paths = over.paths ?? ['a.txt'];
  const blobs: HoldBlobs = over.blobs ?? { h0: Object.fromEntries(paths.map((p) => [p, X])), h1: Object.fromEntries(paths.map((p) => [p, Y])) };
  return {
    id: ID, rev: 1, owner: PEER, kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', offer: 'none', declines: 0, displaced_by: null,
    paths, blobs, guards: [makeGuard('revert')], origin: 'human', cs_ids: [], peer_authors: [], local_only: false,
    age_anchor: { since_rev: 1, anchor_wall_ms: 1_000, mono_accum_ms: 0 }, proto: 1,
    ...over,
  } as HoldRecord;
}

/** The folded entry the fold would store for op `op` written by PEER. */
function folded(op: Omit<HoldOp, 'id'>, extra: Partial<FoldedHold> = {}): FoldedHold {
  const { type: _t, hold_id: _h, prev_rev: _p, ...f } = op;
  return { ...f, guards: f.guards.map((g) => ({ ...g })), paths: [...f.paths], cs_ids: [...f.cs_ids], peer_authors: [...f.peer_authors], owner: PEER, ...extra };
}

test('projectOp maps a record to the glossary §7 fields', T10, () => {
  const r = rec({
    rev: 4, offer: 'offered', declines: 1, displaced_by: `${PEER}/${EPOCH}/7`, cs_ids: [`${PEER}/human/1`, `${PEER}/human/2`],
    guards: [makeGuard('revert'), makeGuard('join')], peer_authors: [EPOCH],
  });
  const op = projectOp(r, 3);
  assert.deepEqual(op, {
    type: 'hold', hold_id: ID, rev: 4, prev_rev: 3, kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', offer: 'offered',
    guards: [{ name: 'revert', class: 'DECISION', owner: 'HLD' }, { name: 'join', class: 'DECISION', owner: 'LIF' }],
    paths: ['a.txt'], origin: 'human', cs_ids: [`${PEER}/human/1`, `${PEER}/human/2`], peer_authors: [EPOCH], local_only: false,
  });
  for (const k of ['declines', 'displaced_by', 'blobs', 'age_anchor', 'owner']) assert.ok(!(k in op), `${k} is not in the op`);
  // The op is a valid op line once it has an id.
  assert.notEqual(parseOpLine(JSON.stringify({ ...op, id: `${PEER}/${EPOCH}/9` })), null);
  // A creation projects prev_rev null; a terminal record projects residence null (the registry stores it so).
  assert.equal(projectOp(r, null).prev_rev, null);
  const done = rec({ rev: 5, state: 'RESOLVED_DISCARD', residence: null });
  assert.equal(projectOp(done, 4).residence, null);
  assert.equal(projectOp(done, 4).state, 'RESOLVED_DISCARD');
  // The guards are copies: editing the op never edits the record.
  op.guards[0]!.name = 'x';
  assert.equal(r.guards[0]!.name, 'revert');
  // When the board's rev ran ahead of the registry's (a race, R3-27), the op's rev rises above prev_rev.
  assert.deepEqual([projectOp(rec({ rev: 2 }), 2).rev, projectOp(rec({ rev: 2 }), 2).prev_rev], [3, 2]);
});

test('heldBlobs lists every stage of a non-local_only record and never an ABSENT side', T10, () => {
  const patch = rec({ paths: ['a.txt', 'b.txt'], blobs: { h0: { 'a.txt': X, 'b.txt': ABSENT }, h1: { 'a.txt': Y, 'b.txt': Z } } });
  assert.deepEqual(heldBlobs(patch), [
    { stage: 'h0', path: 'a.txt', oid: X }, { stage: 'h1', path: 'a.txt', oid: Y }, { stage: 'h1', path: 'b.txt', oid: Z },
  ] satisfies HeldBlob[]);
  const stages = rec({ state: 'CONFLICTED', blobs: { s1: { 'a.txt': X }, s2: { 'a.txt': Y }, s3: { 'a.txt': Z } } });
  assert.deepEqual(heldBlobs(stages), [{ stage: 's1', path: 'a.txt', oid: X }, { stage: 's2', path: 'a.txt', oid: Y }, { stage: 's3', path: 'a.txt', oid: Z }]);
  assert.deepEqual(heldBlobs(rec({ local_only: true })), []);
  // Paths in git's order (UTF-8 bytes) within a stage.
  const two = rec({ paths: ['b.txt', 'a\u{e9}.txt'], blobs: { h0: { 'b.txt': X, 'a\u{e9}.txt': X }, h1: { 'b.txt': ABSENT, 'a\u{e9}.txt': ABSENT } } });
  assert.deepEqual(heldBlobs(two).map((b) => b.path), ['a\u{e9}.txt', 'b.txt']);
  // The pathless host-reject PIN holds nothing.
  assert.deepEqual(heldBlobs(rec({ kind: 'PIN', paths: [], blobs: { h0: {}, h1: {} }, guards: [makeGuard('host-reject')] })), []);
});

test('mirrorKey ignores rev and prev_rev; mirrorWorthy follows R3-25', T10, () => {
  const base = rec({ rev: 3 });
  assert.equal(mirrorKey(base), mirrorKey({ ...base, rev: 9 }));
  assert.equal(mirrorWorthy(null, base), true, 'a creation');
  const worthy: Array<[string, HoldRecord]> = [
    ['residence', { ...base, residence: 'OFF_DISK', state: 'PARKED' }],
    ['state', { ...base, state: 'CONFLICTED' }],
    ['offer', { ...base, offer: 'pending_leftover' }],
    ['guard set', { ...base, guards: [makeGuard('revert'), makeGuard('join')] }],
    ['h1', { ...base, blobs: { h0: { 'a.txt': X }, h1: { 'a.txt': Z } } }],
    ['local_only', { ...base, local_only: true }],
  ];
  for (const [what, next] of worthy) assert.equal(mirrorWorthy(base, next), true, what);
  const stage = rec({ state: 'CONFLICTED', blobs: { s1: { 'a.txt': X }, s2: { 'a.txt': Y }, s3: { 'a.txt': Z } } });
  assert.equal(mirrorWorthy(stage, { ...stage, blobs: { s1: { 'a.txt': X }, s2: { 'a.txt': Z }, s3: { 'a.txt': Z } } }), true, 's2');
  const quiet: Array<[string, HoldRecord]> = [
    ['age_anchor', { ...base, age_anchor: { since_rev: 1, anchor_wall_ms: 1_000, mono_accum_ms: 60_000 } }],
    ['declines', { ...base, declines: 2 }],
    ['displaced_by', { ...base, displaced_by: `${PEER}/${EPOCH}/3` }],
    ['rev', { ...base, rev: base.rev + 1 }],
  ];
  for (const [what, next] of quiet) assert.equal(mirrorWorthy(base, next), false, what);
});

test('creationDue waits 60 s only for not-applicable INCOMING records', T10, () => {
  const incoming = (guard: string): HoldRecord => rec({ kind: 'INCOMING', guards: [makeGuard(guard)] });
  for (const g of ['unmaterializable', 'collision', 'quarantine-review']) {
    assert.equal(creationDue(incoming(g), 59_999), false, `${g} at 59,999 ms`);
    assert.equal(creationDue(incoming(g), 60_000), true, `${g} at 60,000 ms`);
  }
  for (const g of ['lock', 'eol-form', 'local-only-conflict']) assert.equal(creationDue(incoming(g), 0), true, g);
  for (const g of ['unreadable', 'unstable']) assert.equal(creationDue(rec({ kind: 'PIN', guards: [makeGuard(g)] }), 0), true, g);
  for (const r of [rec(), rec({ kind: 'PIN', guards: [makeGuard('join')] }), rec({ guards: [makeGuard('collision')] })]) assert.equal(creationDue(r, 0), true);
});

test('checkMirror is the PRO-21 writer check', T10, () => {
  const live = (p: string): boolean => p.startsWith('src/');
  assert.deepEqual(checkMirror(rec({ paths: ['src/a.txt'] }), live), { ok: true });
  assert.deepEqual(checkMirror(rec({ paths: ['.github/workflows/ci.yml'] }), live), { ok: false, reason: 'local_only_stub' });
  // A join PIN over 300 paths: its op line is about 18 KB, over the 16 KiB line cap.
  const paths = Array.from({ length: 300 }, (_, i) => `src/gen/f${String(i).padStart(3, '0')}-${'x'.repeat(40)}.txt`);
  const pin = rec({ kind: 'PIN', paths, guards: [makeGuard('join')], blobs: { h0: Object.fromEntries(paths.map((p) => [p, ABSENT])), h1: Object.fromEntries(paths.map((p) => [p, Y])) } });
  assert.ok(JSON.stringify(projectOp(pin, null)).length > 16_384);
  assert.deepEqual(checkMirror(pin, live), { ok: false, reason: 'validator' });
  // A local_only record over a quarantined path mirrors as the stub.
  assert.deepEqual(checkMirror(rec({ paths: ['.github/workflows/ci.yml'], local_only: true }), live), { ok: true });
  // A non-terminal, non-local_only record with paths and nothing to put cannot fold valid (PRO-21 held/ rule).
  assert.deepEqual(checkMirror(rec({ paths: ['src/a.txt'], blobs: { h0: { 'src/a.txt': ABSENT }, h1: { 'src/a.txt': ABSENT } } }), live), { ok: false, reason: 'held_subtree' });
});

test('isDurable compares the folded entry and the tip\'s held/ with the record', T10, () => {
  const r = rec({ rev: 3 });
  const tip = heldBlobs(r);
  assert.equal(isDurable(r, folded(projectOp(r, 2)), tip), true);
  // An age flush since: the folded entry is at an older rev with an identical projection.
  assert.equal(isDurable({ ...r, rev: 5 }, folded(projectOp(r, 2)), tip), true);
  // The tip's held/ names another h1.
  assert.equal(isDurable(r, folded(projectOp(r, 2)), [tip[0]!, { stage: 'h1', path: 'a.txt', oid: Z }]), false);
  // The folded state differs.
  assert.equal(isDurable(r, folded(projectOp({ ...r, state: 'CONFLICTED' }, 2)), tip), false);
  // No held/ on the tip for a non-local_only record with paths.
  assert.equal(isDurable(r, folded(projectOp(r, 2)), null), false);
  assert.equal(isDurable(r, undefined, tip), false);
  // The pathless host-reject PIN: durable with no held/ at all.
  const pin = rec({ kind: 'PIN', paths: [], blobs: { h0: {}, h1: {} }, guards: [makeGuard('host-reject')], origin: 'daemon' });
  assert.equal(isDurable(pin, folded(projectOp(pin, null)), null), true);
  // A local_only record is never durable, though the board shows its stub (mirrorShown: mirrorSync drafts nothing more).
  const lo = rec({ local_only: true });
  assert.equal(isDurable(lo, folded(projectOp(lo, null)), null), false);
  assert.equal(mirrorShown(lo, folded(projectOp(lo, null)), null), true);
  assert.equal(mirrorShown(lo, folded(projectOp(lo, null)), tip), false, 'a held/<id>/ the stub must not have');
  assert.equal(mirrorShown(r, folded(projectOp(r, 2)), tip), true);
  // The tip's list in any order compares as a set of entries.
  assert.equal(isDurable(r, folded(projectOp(r, 2)), [...tip].reverse()), true);
});
