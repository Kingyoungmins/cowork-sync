// Plan 3's shared declarations (Task 1 declares them so later parallel tasks never edit these lines): every Plan 3
// TraceEvent variant, the widened MutantId and AttributionPort, EngineCore.rebase and EngineCore.holdCode (X-03, T-09).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyStep } from '../../src/engine/apply.js';
import { prepareIteration, type EngineCore } from '../../src/engine/core.js';
import { humanOnlyAttribution, type AttributionPort, type MutantId } from '../../src/engine/deps.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import { RebaseCache } from '../../src/holds/rebase.js';
import type { HoldRecord } from '../../src/holds/record.js';
import type { TraceEvent } from '../../src/ports/trace.js';
import { gitCallsOf, makeCores, type PeerFixture } from '../helpers/coreFixture.js';
import { TraceRecorder } from '../sim/traceRecorder.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;
const buf = (s: string): Buffer => Buffer.from(s, 'utf8');
const T9 = '1\n2\n3\n4\n5\n6\n7\n8\n9\n';
const PEER = '0123456789abcdef0123456789abcdef';

test('TraceEvent declares every Plan 3 variant', T10, async () => {
  const events: TraceEvent[] = [
    { kind: 'hold', peer: PEER, id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', holdKind: 'INCOMING', guard: 'lock', guards: ['lock'], paths: ['src/a.ts'], residence: 'ON_DISK', state: 'ACTIVE', rev: 1, localOnly: false },
    { kind: 'hold', peer: PEER, id: '01ARZ3NDEKTSV4RRFFQ69G5FAW', holdKind: 'PATCH', guard: '', guards: [], paths: ['src/b.ts'], residence: null, state: 'GONE', rev: 3, localOnly: true },
    {
      kind: 'apply', peer: PEER, tip: 'a'.repeat(40), written: ['x'], deferred: ['y'],
      groups: [{ paths: ['x'], outcome: 'written', reason: null }, { paths: ['y'], outcome: 'deferred', reason: 'locked' }],
      notApplicable: [{ path: 'z', reason: 'collision' }], mDisk: 'b'.repeat(40),
    },
    { kind: 'mask', peer: PEER, sDisk: 's', aTree: 'a', registry: null, partial: ['p'], withheld: ['w'], conflicted: [] },
    {
      kind: 'compose', peer: PEER, tip: 't', aTree: 'a', registry: 'r', pTree: 'p',
      pairs: [{ csId: `${PEER}/human/1`, R: 'r', A: 'a', order: 1, paths: ['x'] }],
      groups: [{ key: 'g', csIds: [`${PEER}/human/1`], paths: ['x'], pins: [], ready: true }],
      withheldWhole: [{ key: 'g', paths: [] }],
    },
    { kind: 'mirror', peer: PEER, bnew: 'b', holds: [{ id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', rev: 2, localOnly: false, held: 1 }] },
    { kind: 'discard', peer: PEER, id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', rev: 4, held: [{ path: 'x', blob: null }] },
    { kind: 'repair', peer: PEER, path: 'x', from: 'f', to: 't' },
    { kind: 'form_violation', peer: PEER, path: 'x', commit: 'c' },
    { kind: 'edit_check', peer: PEER, cs: 'cs', verdict: 'incomplete' },
    { kind: 'mass', peer: PEER, entered: true, paths: 12 },
  ];
  const rec = new TraceRecorder();
  for (const e of events) rec.emit(e);
  for (const kind of ['hold', 'apply', 'mask', 'compose', 'mirror', 'discard', 'repair', 'form_violation', 'edit_check', 'mass'] as const) {
    const got = rec.ofKind(kind);
    assert.deepEqual(got, events.filter((e) => e.kind === kind), kind);
    assert.ok(got.length >= 1, kind);
  }
  const holdKinds: Equals<Extract<TraceEvent, { kind: 'hold' }>['holdKind'], 'PATCH' | 'PIN' | 'INCOMING'> = true;
  const residence: Equals<Extract<TraceEvent, { kind: 'hold' }>['residence'], 'ON_DISK' | 'OFF_DISK' | null> = true;
  const editVerdict: Equals<Extract<TraceEvent, { kind: 'edit_check' }>['verdict'], 'pass' | 'fail' | 'incomplete'> = true;
  assert.ok(holdKinds && residence && editVerdict);

  // Plan 2's apply emit carries the widened fields, filled by Task 6: every write group with its outcome and group-level reason, the
  // not-applicable paths and the tree of M_disk (INV-GROUP input).
  const fx = await makeCores('trace-p3-apply', { n: 1 });
  try {
    await fx.bootstrap();
    const p = fx.peers[0]!;
    await fx.pushTeamChange({ 'src/b.txt': buf('alpha\nbeta\ngamma\ndelta\n') });
    fx.advance(10_000);
    const r = await prepareIteration(p.core, 1, { materialize: 'auto', forceFetch: true });
    assert.ok(r.ok);
    const report = await applyStep(p.core, r.it);
    assert.equal(report.ran, true);
    const applies = fx.trace.ofKind('apply');
    assert.equal(applies.length, 1);
    const mDisk = applies[0]!.mDisk;
    assert.ok(mDisk !== null && /^[0-9a-f]{40}$/.test(mDisk), 'mDisk: a tree oid');
    assert.equal((await p.core.repo.readTreeMap(mDisk as Oid)).get('src/b.txt')?.oid, r.it.tipMap.get('src/b.txt')?.oid, "M_disk holds TIP's b.txt");
    assert.deepEqual(applies[0], {
      kind: 'apply', peer: p.core.peerId, tip: r.it.tip, written: ['src/b.txt'], deferred: [],
      groups: [{ paths: ['src/b.txt'], outcome: 'written', reason: null }], notApplicable: [], mDisk,
    });
  } finally {
    await fx.cleanup();
  }
});

test('MutantId and AttributionPort widen', T10, () => {
  const plan3: MutantId[] = ['M19', 'M25', 'M28', 'M33', 'M38', 'M39'];
  const plan4: MutantId[] = ['M21', 'M22', 'M46_1', 'M46_2', 'M46_3', 'M46_4'];
  const all: MutantId[] = ['M05', 'M06', 'M07', 'M12', 'M17', 'M18', 'M20', ...plan3, ...plan4];
  assert.equal(new Set(all).size, 19);
  // Plan 4 Task 5 (R4-62): the six flag ids joined the union; the Plan 3 ids stay.
  const port: Equals<keyof AttributionPort, 'removalAttributed' | 'shrinkAttributed' | 'observedEdit' | 'hookAttributed'> = true;
  assert.ok(port);
  for (const p of ['src/a.txt', 'notes.md', 'deep/dir/x.bin']) {
    assert.equal(humanOnlyAttribution.removalAttributed(p), false);
    assert.equal(humanOnlyAttribution.shrinkAttributed(p), true);
    assert.equal(humanOnlyAttribution.observedEdit(p), false);
    assert.equal(humanOnlyAttribution.hookAttributed(p), false);
  }
  assert.ok(Object.isFrozen(humanOnlyAttribution));
});

/** A guarded ON_DISK PATCH over `path` held directly (no registry), for core.rebase. */
function patch(path: string, h0: Oid, h1: Oid): HoldRecord {
  return {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', rev: 1, owner: PEER, kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', offer: 'none',
    declines: 0, displaced_by: null, paths: [path], blobs: { h0: { [path]: h0 }, h1: { [path]: h1 } },
    guards: [{ name: 'revert', class: 'DECISION', owner: 'HLD' }], origin: 'human', cs_ids: [], peer_authors: [], local_only: false,
    age_anchor: { since_rev: 1, anchor_wall_ms: 0, mono_accum_ms: 0 }, proto: 1,
  };
}

const mergeFileCalls = (p: PeerFixture): number => gitCallsOf(p).filter((c) => c.args.includes('merge-file')).length;

test('EngineCore gains rebase and holdCode', T10, async () => {
  const files: Record<string, Buffer> = {
    '.gitattributes': buf('*.dat binary\n*.enc filter=crypt\n'),
    'src/t9.txt': buf(T9),
    'src/t9.dat': buf(T9),
    'src/t9.enc': buf(T9),
  };
  const fx = await makeCores('trace-p3-core', { n: 1, files });
  try {
    await fx.bootstrap();
    const p = fx.peers[0]!;
    const core: EngineCore = p.core;
    assert.ok(core.rebase instanceof RebaseCache);
    assert.equal(core.holdCode, null, 'holdCode is null after build');
    const r = await prepareIteration(core, 1, { materialize: false, forceFetch: true });   // EPOCH_BASE attributes of A ∪ TIP
    assert.ok(r.ok);
    const repo = core.repo;
    const two = await repo.hashBytes(buf(T9.replace('2\n', 'two\n')), true);
    const eight = await repo.hashBytes(buf(T9.replace('8\n', 'eight\n')), true);
    const t9 = await repo.hashBytes(buf(T9), true);
    const A = new Map([['src/t9.txt', { path: 'src/t9.txt', mode: '100644' as const, oid: eight }], ['src/t9.dat', { path: 'src/t9.dat', mode: '100644' as const, oid: eight }],
      ['src/t9.enc', { path: 'src/t9.enc', mode: '100644' as const, oid: eight }]]);
    // A text, unfiltered path is merged (mergeable(p) = pathIsText(p) && !pathIsFiltered(p)) ...
    const before = mergeFileCalls(p);
    const text = await core.rebase.rebase(patch('src/t9.txt', t9, two), A);
    assert.equal(mergeFileCalls(p), before + 1);
    assert.ok(text.ok);
    assert.deepEqual(await repo.readBlob(text.h1p['src/t9.txt'] as Oid), buf(T9.replace('2\n', 'two\n').replace('8\n', 'eight\n')));
    // ... while a binary-by-attribute and a filtered path take the whole-path rule (A ∉ {H0, H1}: a conflict, no merge-file).
    for (const path of ['src/t9.dat', 'src/t9.enc']) {
      assert.deepEqual(await core.rebase.rebase(patch(path, t9, two), A), { ok: false, conflicted: [path] }, path);
    }
    assert.equal(mergeFileCalls(p), before + 1);
    // The registry shares the core's cache: a hold() whose H1 REBASE-converges fills it, so core.rebase answers from memory.
    // A[src/t9.txt] becomes T9{8:eight} by an applied team change.
    await fx.pushTeamChange({ 'src/t9.txt': buf(T9.replace('8\n', 'eight\n')) });
    fx.advance(10_000);
    const r2 = await prepareIteration(core, 2, { materialize: 'auto', forceFetch: true });
    assert.ok(r2.ok);
    assert.equal((await applyStep(core, r2.it)).written.includes('src/t9.txt'), true);
    const id = await core.holds.hold({
      kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: ['src/t9.txt'], blobs: { h0: { 'src/t9.txt': t9 }, h1: { 'src/t9.txt': two } },
      guard: 'revert', origin: 'human', cs_ids: [], displaced_by: null,
    });
    const rev1 = core.holds.get(id)!;
    const merged = await repo.hashBytes(buf(T9.replace('2\n', 'two\n').replace('8\n', 'eight\n')), true);
    const out = await core.holds.holdOutcome({
      kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: ['src/t9.txt'], blobs: { h0: { 'src/t9.txt': eight }, h1: { 'src/t9.txt': merged } },
      guard: 'join', origin: 'human', cs_ids: [], displaced_by: null,
    });
    assert.deepEqual(out, { id, created: false, attachedGuard: 'join', conflictedExisting: false });
    const calls = mergeFileCalls(p);
    const again = await core.rebase.rebase(rev1, A);
    assert.equal(mergeFileCalls(p), calls, 'the registry\'s REBASE of rev 1 at A[p] = T9{8:eight} is in core.rebase');
    assert.deepEqual(again, { ok: true, h0p: { 'src/t9.txt': eight }, h1p: { 'src/t9.txt': merged } });
    assert.notEqual(ABSENT, merged);
  } finally {
    await fx.cleanup();
  }
});
