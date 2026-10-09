import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ScopeClass } from '../../src/data/scope.js';
import type { TreeEntry, TreeMap } from '../../src/git/repo.js';
import { ChangeSets, HUMAN_CS_QUIET_MS, ReadyBaseMismatchError, readyKey, type RebaseChange, type ReadyPair } from '../../src/holds/changesets.js';
import { maskEntries } from '../../src/holds/mask.js';
import { HoldRegistry } from '../../src/holds/registry.js';
import { RELEASE_NAMESPACE, refNames } from '../../src/engine/refs.js';
import { nullLog } from '../../src/ports/log.js';
import { seededRandom } from '../../src/ports/random.js';
import { noTrace } from '../../src/ports/trace.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import { VirtualClock } from '../sim/vclock.js';

const PEER = '0123456789abcdef0123456789abcdef';
const BASE = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n';

interface Ctx {
  f: RepoFixture;
  clock: VirtualClock;
  cs: ChangeSets;
  scratch: string;
  /** A code tree as a map; null = absent. */
  tm(files: Record<string, string | null>): Promise<Map<string, TreeEntry>>;
  e(path: string, text: string): Promise<TreeEntry>;
  /** The R and A_cap trees of a pair as path → text. */
  read(pair: ReadyPair): Promise<{ R: Record<string, string>; A: Record<string, string> }>;
  /** Observe the paths, wait out the quiet period and capture. */
  close(paths: string[], sDisk: TreeMap, A: TreeMap): Promise<ReadyPair>;
}

/** The new ready pair of a capture that must have captured one (capture's pair is null when a close only shrank older pairs). */
function captured(got: { pair: ReadyPair | null; nextN: number } | null): ReadyPair {
  assert.ok(got !== null && got.pair !== null, 'the close captured a new ready pair');
  return got.pair;
}

let scratchN = 0;
async function setup(label: string): Promise<Ctx> {
  const f = await makeRepoFixture(label);
  const clock = new VirtualClock();
  const dir = join(f.paths.coworkDir, 'tmp');
  await mkdir(dir, { recursive: true });
  const scratch = join(dir, `cs-${scratchN++}.index`);
  const cs = new ChangeSets(PEER, clock);
  const e = async (path: string, text: string): Promise<TreeEntry> => ({ path, mode: '100644', oid: await f.repo.hashBytes(Buffer.from(text, 'utf8'), true) });
  const tm = async (files: Record<string, string | null>): Promise<Map<string, TreeEntry>> => {
    const m = new Map<string, TreeEntry>();
    for (const [p, t] of Object.entries(files)) if (t !== null) m.set(p, await e(p, t));
    return m;
  };
  const text = async (m: TreeMap): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    for (const [p, entry] of m) out[p] = (await f.repo.readBlob(entry.oid)).toString('utf8');
    return out;
  };
  const read = async (pair: ReadyPair): Promise<{ R: Record<string, string>; A: Record<string, string> }> => (
    { R: await text(await f.repo.readTreeMap(pair.R)), A: await text(await f.repo.readTreeMap(pair.A)) }
  );
  const close = async (paths: string[], sDisk: TreeMap, A: TreeMap): Promise<ReadyPair> => {
    cs.observe(paths);
    clock.advance(HUMAN_CS_QUIET_MS);
    return captured(await cs.capture(f.repo, sDisk, A, scratch));
  };
  return { f, clock, cs, scratch, tm, e, read, close };
}

const LIVE = (): ScopeClass => 'LIVE';

test('the human CS opens at the first change and closes 20 s Δmono after the last change on any of its paths; done() closes it at the next iteration', async () => {
  const c = await setup('cs-timer');
  try {
    const { cs, clock } = c;
    assert.equal(HUMAN_CS_QUIET_MS, 20_000);
    assert.deepEqual(cs.counts(), { open: 0, ready: 0 });
    cs.observe([]);
    assert.deepEqual(cs.counts(), { open: 0, ready: 0 }, 'no change opens nothing');
    assert.equal(cs.closeDue(), false);

    cs.observe(['a.txt']);
    assert.deepEqual(cs.counts(), { open: 1, ready: 0 }, 'the first change opens the CS');
    assert.deepEqual([...cs.openPaths()], ['a.txt']);
    clock.advance(19_999);
    assert.equal(cs.closeDue(), false);
    cs.observe(['b.txt']);                         // a change on another path extends the CS and restarts the timer
    assert.deepEqual([...cs.openPaths()].sort(), ['a.txt', 'b.txt']);
    clock.advance(19_999);
    assert.equal(cs.closeDue(), false, '20 s are counted from the last change on any path');
    cs.observe(['a.txt']);
    clock.advance(19_999);
    assert.equal(cs.closeDue(), false);
    clock.advance(1);
    assert.equal(cs.closeDue(), true, '20 s Δmono after the last change');

    const A =await c.tm({ 'a.txt': 'a0\n', 'b.txt': 'b0\n' });
    const sDisk = await c.tm({ 'a.txt': 'a1\n', 'b.txt': 'b1\n' });
    const first = captured(await cs.capture(c.f.repo, sDisk, A, c.scratch));
    assert.deepEqual(first.paths, ['a.txt', 'b.txt']);
    assert.deepEqual(cs.counts(), { open: 0, ready: 1 });
    assert.equal(cs.closeDue(), false);

    // done(): the open CS closes at the next iteration, without the quiet period.
    cs.observe(['c.txt']);
    assert.equal(cs.closeDue(), false);
    cs.done();
    assert.equal(cs.closeDue(), true);
    const second = captured(await cs.capture(c.f.repo, await c.tm({ 'c.txt': 'c1\n' }), A, c.scratch));
    assert.deepEqual(second.paths, ['c.txt']);
    // done() with nothing open does not close a later CS early.
    cs.done();
    cs.observe(['d.txt']);
    assert.equal(cs.closeDue(), false);
    clock.advance(HUMAN_CS_QUIET_MS);
    assert.equal(cs.closeDue(), true);
    assert.ok(await cs.capture(c.f.repo, await c.tm({ 'd.txt': 'd1\n' }), A, c.scratch) !== null);

    // The wall clock plays no part: a suspend (wall moves, mono does not) while the CS is not yet due does not close it.
    cs.observe(['e.txt']);
    clock.suspend(60_000);
    assert.equal(cs.closeDue(), false, 'a 60 s wall-clock jump is not 20 s of Δmono');
    clock.advance(HUMAN_CS_QUIET_MS);
    assert.equal(cs.closeDue(), true, '20 s Δmono closes it');
  } finally {
    await c.f.cleanup();
  }
});

test('capture writes sparse R and A trees of the CS paths with cs_id <peer>/human/<n> and n increments', async () => {
  const c = await setup('cs-capture');
  try {
    const { cs, f } = c;
    cs.restore([], 5);
    const A = await c.tm({ 'a.txt': 'a0\n', 'b.txt': 'b0\n', 'c.txt': 'c0\n', 'gone.txt': 'g0\n' });
    // S_disk: a edited, gone deleted, new created, c edited but not in this CS, tmp created and deleted again.
    const sDisk = await c.tm({ 'a.txt': 'a1\n', 'b.txt': 'b0\n', 'c.txt': 'c1\n', 'new.txt': 'n1\n' });
    cs.observe(['a.txt', 'gone.txt', 'new.txt', 'tmp.txt']);
    assert.equal(await cs.capture(f.repo, sDisk, A, c.scratch), null, 'not due: nothing is captured');
    c.clock.advance(HUMAN_CS_QUIET_MS);
    const got = await cs.capture(f.repo, sDisk, A, c.scratch);
    const pair = captured(got);
    const nextN = got!.nextN;
    assert.equal(pair.csId, `${PEER}/human/5`);
    assert.equal(pair.order, 5);
    assert.equal(nextN, 6, 'n increments (meta.cs_human_next)');
    // Sparse trees: only the CS's paths; R = S_disk (unmasked), A_cap = A; a path absent from both is not a CS path.
    assert.deepEqual(await c.read(pair), { R: { 'a.txt': 'a1\n', 'new.txt': 'n1\n' }, A: { 'a.txt': 'a0\n', 'gone.txt': 'g0\n' } });
    assert.deepEqual(pair.paths, ['a.txt', 'gone.txt', 'new.txt'], 'paths = the union of R\'s and A\'s entries (as StateStore derives them)');
    assert.deepEqual((await f.repo.readTreeMap(pair.R)).get('a.txt'), sDisk.get('a.txt'), 'R keeps S_disk\'s entries');
    assert.deepEqual(cs.ready(), [pair]);
    assert.deepEqual(cs.counts(), { open: 0, ready: 1 });
    assert.equal(cs.openPaths().size, 0);
    assert.equal(readyKey(pair.csId), Buffer.from(`${PEER}/human/5`, 'utf8').toString('base64url'));

    const next = await c.close(['b.txt', 'c.txt'], sDisk, A);
    assert.equal(next.csId, `${PEER}/human/6`);
    assert.equal(next.order, 6);
    assert.deepEqual(await c.read(next), { R: { 'b.txt': 'b0\n', 'c.txt': 'c1\n' }, A: { 'b.txt': 'b0\n', 'c.txt': 'c0\n' } });
    assert.deepEqual(cs.ready().map((p) => p.csId), [`${PEER}/human/5`, `${PEER}/human/6`]);

    // A CS whose only path is absent everywhere captures nothing and does not consume n.
    cs.observe(['tmp.txt']);
    c.clock.advance(HUMAN_CS_QUIET_MS);
    assert.equal(await cs.capture(f.repo, sDisk, A, c.scratch), null);
    assert.equal(cs.closeDue(), false, 'the empty CS is closed');
    assert.equal((await c.close(['a.txt'], sDisk, A)).csId, `${PEER}/human/7`);

    // restore(): the journal's pairs and meta.cs_human_next; n never reuses a journaled order.
    const again = new ChangeSets(PEER, c.clock);
    again.restore(cs.ready(), 3);
    assert.deepEqual(again.ready(), cs.ready());
    assert.deepEqual(again.counts(), { open: 0, ready: 3 });
    again.observe(['b.txt']);
    c.clock.advance(HUMAN_CS_QUIET_MS);
    const after = await again.capture(f.repo, sDisk, A, c.scratch);
    assert.equal(after!.pair!.csId, `${PEER}/human/8`);
    assert.equal(after!.nextN, 9);
  } finally {
    await c.f.cleanup();
  }
});

test('a file created and then deleted before it is published is never published: the delete CS\'s close drops the path from the older ready pairs (a pair left with no path leaves) and reports the journal change', async () => {
  const c = await setup('cs-create-delete');
  try {
    const { cs, f } = c;
    const mask = (A: TreeMap) => (X: TreeMap) => maskEntries(X, { A, scope: LIVE, records: [] });
    const text = async (e: TreeEntry | undefined): Promise<string | null> => (e === undefined ? null : (await f.repo.readBlob(e.oid)).toString('utf8'));
    const A = await c.tm({ 'a.txt': 'a0\n' });
    // human/1 created own.txt only; human/2 created own2.txt and edited a.txt. A never has either file.
    const only = await c.close(['own.txt'], await c.tm({ 'a.txt': 'a0\n', 'own.txt': 'o1\n' }), A);
    const both = await c.close(['own2.txt', 'a.txt'], await c.tm({ 'a.txt': 'a1\n', 'own.txt': 'o1\n', 'own2.txt': 'p1\n' }), A);
    assert.deepEqual(only.paths, ['own.txt']);
    assert.deepEqual(both.paths, ['a.txt', 'own2.txt']);

    // Both files are deleted on disk before any publish: the delete CS's paths are absent from S_disk and from A.
    const sDisk = await c.tm({ 'a.txt': 'a1\n' });
    cs.observe(['own.txt', 'own2.txt']);
    c.clock.advance(HUMAN_CS_QUIET_MS);
    const got = await cs.capture(f.repo, sDisk, A, c.scratch);
    assert.ok(got !== null, 'the close reports the journal change (non-null), so the caller commits ready() with nextN');
    assert.equal(got.pair, null, 'no new pair: a path absent from both trees is not a path of a pair');
    assert.equal(got.nextN, 3, 'no n is consumed');
    assert.deepEqual(cs.ready().map((p) => p.csId), [`${PEER}/human/2`], 'the pair that only created own.txt leaves');
    const shrunk = cs.ready()[0]!;
    assert.deepEqual(shrunk.paths, ['a.txt'], 'the older pair drops the deleted path and keeps its other edit');
    assert.deepEqual(await c.read(shrunk), { R: { 'a.txt': 'a1\n' }, A: { 'a.txt': 'a0\n' } });
    const composed = await cs.composeP(f.repo, A, mask(A), new Set());
    assert.deepEqual([...composed.P.keys()].sort(), ['a.txt'], 'P carries neither created-then-deleted file');
    assert.equal(await text(composed.P.get('a.txt')), 'a1\n');
    assert.deepEqual(composed.csIds, [`${PEER}/human/2`]);
    assert.deepEqual(cs.counts(), { open: 0, ready: 1 });
    assert.equal(cs.closeDue(), false, 'the delete CS is closed');

    // The journal holds the shrunk pair (StateStore derives paths from R ∪ A_cap): a restart composes the same P.
    const again = new ChangeSets(PEER, c.clock);
    again.restore(cs.ready(), got.nextN);
    assert.deepEqual([...(await again.composeP(f.repo, A, mask(A), new Set())).P.keys()].sort(), ['a.txt']);

    // A path absent from both trees that no ready pair covers still changes nothing: null, as before.
    cs.observe(['tmp.txt']);
    c.clock.advance(HUMAN_CS_QUIET_MS);
    assert.equal(await cs.capture(f.repo, sDisk, A, c.scratch), null);

    // A delete CS that also edits a path: its new pair is captured and the older pair still drops the deleted path.
    const third = await c.close(['own3.txt'], await c.tm({ 'a.txt': 'a1\n', 'own3.txt': 'q1\n' }), A);
    assert.equal(third.csId, `${PEER}/human/3`);
    cs.observe(['own3.txt', 'a.txt']);
    c.clock.advance(HUMAN_CS_QUIET_MS);
    const mixed = await cs.capture(f.repo, await c.tm({ 'a.txt': 'a2\n' }), A, c.scratch);
    assert.ok(mixed !== null && mixed.pair !== null);
    assert.equal(mixed.pair.csId, `${PEER}/human/4`);
    assert.deepEqual(mixed.pair.paths, ['a.txt']);
    assert.equal(mixed.nextN, 5);
    assert.deepEqual(cs.ready().map((p) => p.csId), [`${PEER}/human/2`, `${PEER}/human/4`], 'human/3 (own3.txt only) leaves');
    const last = await cs.composeP(f.repo, A, mask(A), new Set());
    assert.deepEqual([...last.P.keys()].sort(), ['a.txt']);
    assert.equal(await text(last.P.get('a.txt')), 'a2\n', 'the newest capture wins');
  } finally {
    await c.f.cleanup();
  }
});

/**
 * Task 19 ruling (fix round 3): X created p.txt and was pushed with an ambiguous outcome, so the kept push intent names X;
 * Y (newer, in no intent) edited p.txt again and a.txt. The user deletes p.txt and the delete CS closes behind the kept
 * intent. Returns the closed state for the landed and the not-landed branches.
 */
async function keptIntentDelete(label: string): Promise<{ c: Ctx; X: ReadyPair; Y: ReadyPair; A0: TreeMap; sDisk: TreeMap; kept: ReadonlySet<string> }> {
  const c = await setup(label);
  const { cs, f } = c;
  const A0 = await c.tm({ 'a.txt': 'a0\n' });
  const X = await c.close(['p.txt'], await c.tm({ 'a.txt': 'a0\n', 'p.txt': 'p1\n' }), A0);
  const Y = await c.close(['p.txt', 'a.txt'], await c.tm({ 'a.txt': 'a1\n', 'p.txt': 'p2\n' }), A0);
  const kept = new Set([X.csId]);
  const sDisk = await c.tm({ 'a.txt': 'a1\n' });
  cs.observe(['p.txt']);
  c.clock.advance(HUMAN_CS_QUIET_MS);
  const got = await cs.capture(f.repo, sDisk, A0, c.scratch, kept);
  assert.ok(got !== null && got.pair === null, 'Y shrank (a journal change, no new pair)');
  assert.equal(got.nextN, 3, 'no n is consumed');
  assert.deepEqual(cs.ready().map((p) => [p.csId, p.paths]), [[X.csId, ['p.txt']], [Y.csId, ['a.txt']]], 'the pair the kept intent names keeps p.txt; the unprotected newer pair drops it');
  assert.deepEqual(await c.read(cs.ready()[0]!), { R: { 'p.txt': 'p1\n' }, A: {} }, 'X is untouched: the ok update still reads A_cap[p.txt] = absent = A[p.txt]');
  assert.deepEqual(await c.read(cs.ready()[1]!), { R: { 'a.txt': 'a1\n' }, A: { 'a.txt': 'a0\n' } });
  assert.deepEqual([...cs.openPaths()], ['p.txt'], 'the vanished path waits in pending');
  assert.equal(cs.closeDue(), true, 'and re-closes at the next capture');
  // While the intent stays kept a re-close changes nothing (null: nothing to journal) and the path keeps waiting.
  assert.equal(await cs.capture(f.repo, sDisk, A0, c.scratch, kept), null);
  assert.deepEqual([...cs.openPaths()], ['p.txt']);
  assert.deepEqual(cs.ready().map((p) => p.csId), [X.csId, Y.csId]);
  return { c, X, Y, A0, sDisk, kept };
}

test('Task 19 ruling (round 3): a ready pair a kept push intent names is never shrunk; its vanished path waits in pending and re-closes once the intent resolved: landed (A has p, the disk lacks it) captures the deletion pair', async () => {
  const { c, X, sDisk } = await keptIntentDelete('cs-kept-landed');
  try {
    const { cs, f } = c;
    // The ok update of the landed push: A[p.txt] := C[p.txt] (X's A_cap of p.txt was absent, as A was) and X leaves.
    const A1 = await c.tm({ 'a.txt': 'a0\n', 'p.txt': 'p1\n' });
    cs.published([X.csId]);
    const del = captured(await cs.capture(f.repo, sDisk, A1, c.scratch, new Set()));
    assert.equal(del.csId, `${PEER}/human/3`);
    assert.deepEqual(del.paths, ['p.txt']);
    assert.deepEqual(await c.read(del), { R: {}, A: { 'p.txt': 'p1\n' } }, 'a deletion pair: R lacks p.txt, A_cap has it');
    assert.equal(cs.closeDue(), false);
    const composed = await cs.composeP(f.repo, A1, (X2) => maskEntries(X2, { A: A1, scope: LIVE, records: [] }), new Set());
    assert.deepEqual([...composed.P.keys()].sort(), ['a.txt'], 'the deletion is published');
  } finally {
    await c.f.cleanup();
  }
});

test('Task 19 ruling (round 3): not landed (the intent discarded), the next close drops the deferred path from the pair the intent named; a pair left with no path leaves', async () => {
  const { c, Y, A0, sDisk } = await keptIntentDelete('cs-kept-discarded');
  try {
    const { cs, f } = c;
    const got = await cs.capture(f.repo, sDisk, A0, c.scratch, new Set());
    assert.ok(got !== null && got.pair === null, 'the shrink is a journal change with no new pair');
    assert.deepEqual(cs.ready().map((p) => [p.csId, p.paths]), [[Y.csId, ['a.txt']]], 'X, which only created p.txt, leaves');
    assert.equal(cs.closeDue(), false);
    const composed = await cs.composeP(f.repo, A0, (X2) => maskEntries(X2, { A: A0, scope: LIVE, records: [] }), new Set());
    assert.deepEqual([...composed.P.keys()].sort(), ['a.txt'], 'the created-then-deleted file is never published');
  } finally {
    await c.f.cleanup();
  }
});

test('composeP takes the newest ready pair covering each path, A elsewhere, and applies MASK at compose time', async () => {
  const c = await setup('cs-compose');
  try {
    const { cs, f } = c;
    const A = await c.tm({ 'a.txt': 'a0\n', 'b.txt': 'b0\n', 'c.txt': 'c0\n', 'd.txt': 'd0\n', '.vscode/settings.json': '{}\n' });
    const p1 = await c.close(['a.txt', 'b.txt'], await c.tm({ 'a.txt': 'a1\n', 'b.txt': 'b1\n' }), A);
    // The newer pair edits b again, deletes c and touches a quarantined path (masked by path class).
    const p2 = await c.close(['b.txt', 'c.txt', '.vscode/settings.json'], await c.tm({ 'b.txt': 'b2\n', '.vscode/settings.json': '{"x":1}\n' }), A);
    const scope = (p: string): ScopeClass => (p.startsWith('.vscode/') ? 'QUARANTINED' : 'LIVE');

    const plain = await cs.composeP(f.repo, A, (X) => maskEntries(X, { A, scope, records: [] }), new Set());
    assert.deepEqual(plain.csIds, [p1.csId, p2.csId]);
    assert.deepEqual([...plain.csPaths.entries()], [[p1.csId, p1.paths], [p2.csId, p2.paths]]);
    const expect = async (P: Map<string, TreeEntry>, files: Record<string, string | null>): Promise<void> => {
      const want = await c.tm(files);
      assert.deepEqual(new Map([...P].sort()), new Map([...want].sort()));
    };
    await expect(plain.P, { 'a.txt': 'a1\n', 'b.txt': 'b2\n', 'c.txt': null, 'd.txt': 'd0\n', '.vscode/settings.json': '{}\n' });

    // A record created after the capture still masks (HLD-42: MASK runs at compose time).
    const holds = new HoldRegistry({ repo: f.repo, ref: refNames('main', RELEASE_NAMESPACE).holds, random: seededRandom('cs'), clock: c.clock, peer: PEER, trace: noTrace, log: nullLog });
    await holds.load();
    await holds.hold({
      kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: ['a.txt'],
      blobs: { h0: { 'a.txt': A.get('a.txt')!.oid }, h1: { 'a.txt': (await c.e('a.txt', 'a1\n')).oid } },
      guard: 'eol-bom', origin: 'human', cs_ids: [], displaced_by: null, local_only: false,
    });
    const masked = await cs.composeP(f.repo, A, (X) => maskEntries(X, { A, scope, records: holds.maskingRecords() }), new Set());
    await expect(masked.P, { 'a.txt': 'a0\n', 'b.txt': 'b2\n', 'c.txt': null, 'd.txt': 'd0\n', '.vscode/settings.json': '{}\n' });
    assert.deepEqual(masked.csIds, [p1.csId, p2.csId], 'a masked path does not take its CS out of P');
    assert.deepEqual(cs.ready().map((p) => p.csId), [p1.csId, p2.csId], 'composing removes nothing');

    // published() drops the published pairs.
    cs.published([p1.csId]);
    assert.deepEqual(cs.ready().map((p) => p.csId), [p2.csId]);
    const rest = await cs.composeP(f.repo, A, (X) => maskEntries(X, { A, scope: LIVE, records: [] }), new Set());
    await expect(rest.P, { 'a.txt': 'a0\n', 'b.txt': 'b2\n', 'c.txt': null, 'd.txt': 'd0\n', '.vscode/settings.json': '{"x":1}\n' });
    cs.published([p2.csId]);
    const none = await cs.composeP(f.repo, A, (X) => maskEntries(X, { A, scope: LIVE, records: [] }), new Set());
    assert.deepEqual(none.csIds, []);
    assert.deepEqual(new Map([...none.P].sort()), new Map([...A].sort()), 'P = A without ready pairs');
  } finally {
    await c.f.cleanup();
  }
});

test('composeP throws ReadyBaseMismatchError when A_cap ≠ A', async () => {
  const c = await setup('cs-mismatch');
  try {
    const { cs, f } = c;
    const A = await c.tm({ 'a.txt': BASE, 'b.txt': 'b0\n' });
    await c.close(['a.txt', 'n.txt'], await c.tm({ 'a.txt': `mine\n${BASE.slice(3)}`, 'b.txt': 'b0\n', 'n.txt': 'new\n' }), A);
    const mask = (A2: TreeMap) => (X: TreeMap) => maskEntries(X, { A: A2, scope: LIVE, records: [] });
    await cs.composeP(f.repo, A, mask(A), new Set());   // A_cap == A: fine

    // Mutant M20's shape: an apply changed A[a.txt] and the pair was not rebased, so A_cap ≠ A.
    const A2 = new Map(A);
    A2.set('a.txt', await c.e('a.txt', `${BASE}l9\n`));
    await assert.rejects(cs.composeP(f.repo, A2, mask(A2), new Set()), (e: unknown) => e instanceof ReadyBaseMismatchError && e.path === 'a.txt');
    // An entry A gained where A_cap is absent is a mismatch too; a path outside every pair is not checked.
    const A3 = new Map(A);
    A3.set('n.txt', await c.e('n.txt', 'theirs\n'));
    A3.set('b.txt', await c.e('b.txt', 'b9\n'));
    await assert.rejects(cs.composeP(f.repo, A3, mask(A3), new Set()), (e: unknown) => e instanceof ReadyBaseMismatchError && e.path === 'n.txt');
    // A mode change is a mismatch.
    const A4 = new Map(A);
    A4.set('a.txt', { ...A.get('a.txt')!, mode: '100755' });
    await assert.rejects(cs.composeP(f.repo, A4, mask(A4), new Set()), ReadyBaseMismatchError);
    assert.ok(new ReadyBaseMismatchError('x') instanceof Error);
  } finally {
    await c.f.cleanup();
  }
});

test('composeP skips a ready pair sharing a path with an ON_DISK PIN and keeps it journaled', async () => {
  const c = await setup('cs-pin');
  try {
    const { cs, f } = c;
    const A = await c.tm({ 'a.txt': 'a0\n', 'b.txt': 'b0\n', 'c.txt': 'c0\n' });
    const holds = new HoldRegistry({ repo: f.repo, ref: refNames('main', RELEASE_NAMESPACE).holds, random: seededRandom('pin'), clock: c.clock, peer: PEER, trace: noTrace, log: nullLog });
    await holds.load();
    // R-22 'none': local work held in one masked join PIN on a.txt.
    await holds.hold({
      kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths: ['a.txt'],
      blobs: { h0: { 'a.txt': A.get('a.txt')!.oid }, h1: { 'a.txt': (await c.e('a.txt', 'a-local\n')).oid } },
      guard: 'join', origin: 'human', cs_ids: [], displaced_by: null, local_only: false,
    });
    const pinnedPaths = new Set(holds.nonTerminal()
      .filter((r) => r.kind === 'PIN' && r.residence === 'ON_DISK' && r.guards.length > 0).flatMap((r) => r.paths));
    const mask = (X: TreeMap): Map<string, TreeEntry> => maskEntries(X, { A, scope: LIVE, records: holds.maskingRecords() });

    const pair = await c.close(['a.txt', 'b.txt'], await c.tm({ 'a.txt': 'a1\n', 'b.txt': 'b1\n', 'c.txt': 'c0\n' }), A);
    const r = await cs.composeP(f.repo, A, mask, pinnedPaths);
    assert.deepEqual(new Map([...r.P].sort()), new Map([...A].sort()), 'P equals A on both paths of the pinned group');
    assert.deepEqual(r.csIds, []);
    assert.equal(r.csPaths.size, 0);
    assert.deepEqual(cs.ready(), [pair], 'the pair stays journaled');

    // A pair that shares no path with the PIN still publishes; the pinned one is still skipped.
    const other = await c.close(['c.txt'], await c.tm({ 'a.txt': 'a1\n', 'b.txt': 'b1\n', 'c.txt': 'c1\n' }), A);
    const r2 = await cs.composeP(f.repo, A, mask, pinnedPaths);
    assert.deepEqual(r2.csIds, [other.csId]);
    assert.equal(r2.P.get('c.txt')!.oid, (await c.e('c.txt', 'c1\n')).oid);
    assert.equal(r2.P.get('b.txt')!.oid, A.get('b.txt')!.oid);
    assert.deepEqual(cs.ready().map((p) => p.csId), [pair.csId, other.csId]);
  } finally {
    await c.f.cleanup();
  }
});

test('rebase merges R[p] := merge-file(A_new, A_cap, R) when it is clean', async () => {
  const c = await setup('cs-rebase');
  try {
    const { cs, f } = c;
    const A = await c.tm({ 'a.txt': BASE, 'b.txt': 'b0\n', 'c.txt': 'c0\n', 'd.txt': 'd0\n', 'x.txt': 'x0\n' });
    const mine = BASE.replace('l1\n', 'mine\n');
    const pair = await c.close(['a.txt', 'b.txt', 'c.txt', 'd.txt'], await c.tm({ 'a.txt': mine, 'b.txt': 'b0\n', 'c.txt': 'c1\n', 'd.txt': 'd1\n' }), A);
    const other = await c.close(['x.txt'], await c.tm({ 'x.txt': 'x1\n' }), A);

    // The apply changed A on a (the teammate edited line 8), b (R == A_cap: the pair did not change b), c (the teammate made the
    // pair's own change) and y (in no pair); d keeps its A.
    const theirs = BASE.replace('l8\n', 'theirs\n');
    const A2 = await c.tm({ 'a.txt': theirs, 'b.txt': 'b2\n', 'c.txt': 'c1\n', 'd.txt': 'd0\n', 'x.txt': 'x0\n', 'y.txt': 'y2\n' });
    const ch = (path: string, written: RebaseChange['written'] = 'clean'): RebaseChange => ({
      path, aOld: A.get(path) ?? null, aNew: A2.get(path) ?? null, written, sDiskBefore: null, writtenEntry: null,
    });
    const res = await cs.rebase(f.repo, [ch('a.txt'), ch('b.txt'), ch('c.txt', 'none'), ch('y.txt')], c.scratch);
    assert.deepEqual(res.cancelled, []);
    assert.equal(res.recapture.size, 0);
    assert.deepEqual(res.ready.map((p) => p.csId), [pair.csId, other.csId]);
    assert.deepEqual(cs.ready(), res.ready);
    const rebased = res.ready[0]!;
    assert.equal(rebased.order, pair.order);
    assert.deepEqual(rebased.paths, pair.paths);
    assert.deepEqual(await c.read(rebased), {
      R: { 'a.txt': BASE.replace('l1\n', 'mine\n').replace('l8\n', 'theirs\n'), 'b.txt': 'b2\n', 'c.txt': 'c1\n', 'd.txt': 'd1\n' },
      A: { 'a.txt': theirs, 'b.txt': 'b2\n', 'c.txt': 'c1\n', 'd.txt': 'd0\n' },
    });
    assert.deepEqual(res.ready[1], other, 'a pair the update did not touch is unchanged');
    // A_cap == A again, so the publish assert passes.
    await cs.composeP(f.repo, A2, (X) => maskEntries(X, { A: A2, scope: LIVE, records: [] }), new Set());

    // A deletion in A where the pair left the path unchanged drops the path from the pair.
    const A3 = new Map(A2);
    A3.delete('b.txt');
    const res3 = await cs.rebase(f.repo, [{ path: 'b.txt', aOld: A2.get('b.txt')!, aNew: null, written: 'clean', sDiskBefore: null, writtenEntry: null }], c.scratch);
    assert.deepEqual(res3.ready[0]!.paths, ['a.txt', 'c.txt', 'd.txt']);
    await cs.composeP(f.repo, A3, (X) => maskEntries(X, { A: A3, scope: LIVE, records: [] }), new Set());
  } finally {
    await c.f.cleanup();
  }
});

test('a rebase conflict follows HLD-41\'s split', async () => {
  const c = await setup('cs-split');
  try {
    const { f } = c;
    const A = await c.tm({ 'a.txt': BASE, 'b.txt': 'b0\n', 'z.txt': 'z0\n' });
    const mine = BASE.replace('l1\n', 'mine\n');
    const sDisk = await c.tm({ 'a.txt': mine, 'b.txt': 'b1\n', 'z.txt': 'z1\n' });
    const A2 = new Map(A);
    A2.set('a.txt', await c.e('a.txt', BASE.replace('l1\n', 'theirs\n')));   // same line: merge-file conflicts
    const fresh = async (): Promise<{ cs: ChangeSets; pair: ReadyPair; z: ReadyPair }> => {
      const cs = new ChangeSets(PEER, c.clock);
      cs.restore([], 1);
      cs.observe(['a.txt', 'b.txt']);
      c.clock.advance(HUMAN_CS_QUIET_MS);
      const pair = captured(await cs.capture(f.repo, sDisk, A, c.scratch));
      cs.observe(['z.txt']);
      c.clock.advance(HUMAN_CS_QUIET_MS);
      const z = captured(await cs.capture(f.repo, sDisk, A, c.scratch));
      return { cs, pair, z };
    };
    const change = (written: RebaseChange['written'], sDiskBefore: TreeEntry | null, writtenEntry: TreeEntry | null): RebaseChange => (
      { path: 'a.txt', aOld: A.get('a.txt')!, aNew: A2.get('a.txt')!, written, sDiskBefore, writtenEntry }
    );
    const concat = await c.e('a.txt', `${mine}theirs-block\n`);

    // Clean or concat write with S_disk == R: the pair stays ready with R := the written blob, A_cap := A_new.
    for (const written of ['clean', 'concat'] as const) {
      const { cs, pair, z } = await fresh();
      const res = await cs.rebase(f.repo, [change(written, sDisk.get('a.txt')!, concat)], c.scratch);
      assert.deepEqual(res.cancelled, [], written);
      assert.equal(res.recapture.size, 0);
      assert.deepEqual(res.ready.map((p) => p.csId), [pair.csId, z.csId]);
      const R = await f.repo.readTreeMap(res.ready[0]!.R);
      const Acap = await f.repo.readTreeMap(res.ready[0]!.A);
      assert.equal(R.get('a.txt')!.oid, concat.oid);
      assert.equal(Acap.get('a.txt')!.oid, A2.get('a.txt')!.oid);
      assert.equal(R.get('b.txt')!.oid, sDisk.get('b.txt')!.oid, 'the pair\'s other paths are kept');
      assert.equal(cs.closeDue(), false);
    }

    // A later file effect on p (S_disk ≠ R before the apply): the whole capture is withdrawn, with no message.
    {
      const { cs, pair, z } = await fresh();
      const later = await c.e('a.txt', `${mine}later\n`);
      const res = await cs.rebase(f.repo, [change('clean', later, concat)], c.scratch);
      assert.deepEqual(res.cancelled, [], 'a withdrawal sends no CS_READY_CANCELLED');
      assert.deepEqual(res.ready.map((p) => p.csId), [z.csId], 'never one pair alone: the whole capture leaves');
      assert.deepEqual([...res.recapture].sort(), pair.paths);
      assert.equal(cs.closeDue(), true, 'every member is closed: re-captured at the next snapshot');
    }
    // ... and with the later edit in the open CS, the withdrawn paths are re-captured at that CS's close.
    {
      const { cs, pair } = await fresh();
      cs.observe(['a.txt']);
      const later = await c.e('a.txt', `${mine}later\n`);
      const res = await cs.rebase(f.repo, [change('clean', later, concat)], c.scratch);
      assert.deepEqual([...res.recapture].sort(), pair.paths);
      assert.deepEqual([...cs.openPaths()].sort(), pair.paths, 'the open member carries the withdrawn paths');
      assert.equal(cs.closeDue(), false, 'the open CS still waits for its quiet period');
      c.clock.advance(HUMAN_CS_QUIET_MS);
      assert.equal(cs.closeDue(), true);
      const sNow = await c.tm({ 'a.txt': `${BASE.replace('l1\n', 'theirs\n')}later\n`, 'b.txt': 'b1\n', 'z.txt': 'z1\n' });
      const re = captured(await cs.capture(f.repo, sNow, A2, c.scratch));
      assert.deepEqual(re.paths, ['a.txt', 'b.txt']);
    }

    // take_tip (the apply displaced the local side) and 'none' (A changed without a write): CS_READY_CANCELLED and a recapture.
    for (const written of ['take_tip', 'none'] as const) {
      const { cs, pair, z } = await fresh();
      const res = await cs.rebase(f.repo, [change(written, sDisk.get('a.txt')!, null)], c.scratch);
      assert.deepEqual(res.cancelled, [pair.csId], written);
      assert.deepEqual([...res.recapture].sort(), pair.paths);
      assert.deepEqual(res.ready.map((p) => p.csId), [z.csId]);
      assert.deepEqual(cs.ready(), res.ready);
      assert.equal(cs.closeDue(), true, 'all members closed: re-captured at the next completed snapshot');
      // The recapture: a new human CS id over the cancelled paths, R from the current S_disk, A_cap = the new A.
      const sNow = await c.tm({ 'a.txt': BASE.replace('l1\n', 'theirs\n'), 'b.txt': 'b1\n', 'z.txt': 'z1\n' });
      const got = captured(await cs.capture(f.repo, sNow, A2, c.scratch));
      assert.equal(got.csId, `${PEER}/human/3`);
      assert.deepEqual(got.paths, ['a.txt', 'b.txt']);
      assert.deepEqual(await c.read(got), { R: { 'a.txt': BASE.replace('l1\n', 'theirs\n'), 'b.txt': 'b1\n' }, A: { 'a.txt': BASE.replace('l1\n', 'theirs\n'), 'b.txt': 'b0\n' } });
      assert.equal(cs.closeDue(), false);
      await cs.composeP(f.repo, A2, (X) => maskEntries(X, { A: A2, scope: LIVE, records: [] }), new Set());
    }

    // A clean or concat write reported with no written entry while A_new has p (a clean write cannot have deleted p): R never
    // takes a deletion. The capture is withdrawn (no message) and re-captured from the disk at the next snapshot.
    {
      const { cs, pair, z } = await fresh();
      const res = await cs.rebase(f.repo, [change('clean', sDisk.get('a.txt')!, null)], c.scratch);
      assert.deepEqual(res.cancelled, []);
      assert.deepEqual([...res.recapture].sort(), pair.paths);
      assert.deepEqual(res.ready, [z], 'the pair is not kept with a deletion of a.txt in R');
      const re = captured(await cs.capture(f.repo, sDisk, A2, c.scratch));
      assert.deepEqual(await c.read(re), { R: { 'a.txt': mine, 'b.txt': 'b1\n' }, A: { 'a.txt': BASE.replace('l1\n', 'theirs\n'), 'b.txt': 'b0\n' } }, 'R is what the disk has');
    }

    // One-pair helper for the absent-side and mode cases below.
    const solo = async (paths: string[], s: TreeMap, base: TreeMap): Promise<{ cs: ChangeSets; pair: ReadyPair }> => {
      const cs = new ChangeSets(PEER, c.clock);
      cs.restore([], 1);
      cs.observe(paths);
      c.clock.advance(HUMAN_CS_QUIET_MS);
      return { cs, pair: captured(await cs.capture(f.repo, s, base, c.scratch)) };
    };
    const mode = (entry: TreeEntry, m: TreeEntry['mode']): TreeEntry => ({ ...entry, mode: m });

    // (a) modify/delete: the pair edited d.txt, the update deleted it (A_new absent).
    {
      const Ad = await c.tm({ 'd.txt': 'd0\n', 'e.txt': 'e0\n' });
      const sD = await c.tm({ 'd.txt': 'd1\n', 'e.txt': 'e1\n' });
      const Ad2 = new Map(Ad);
      Ad2.delete('d.txt');
      const del = (written: RebaseChange['written'], writtenEntry: TreeEntry | null): RebaseChange => (
        { path: 'd.txt', aOld: Ad.get('d.txt')!, aNew: null, written, sDiskBefore: sD.get('d.txt')!, writtenEntry }
      );
      for (const written of ['take_tip', 'none'] as const) {
        const { cs, pair } = await solo(['d.txt'], sD, Ad);
        const res = await cs.rebase(f.repo, [del(written, null)], c.scratch);
        assert.deepEqual(res.cancelled, [pair.csId], `modify/delete ${written}`);
        assert.deepEqual([...res.recapture], ['d.txt']);
        assert.deepEqual(res.ready, []);
      }
      // clean, S_disk == R: R := the written entry, A_cap := absent; the pair stays ready and P re-creates d.txt.
      {
        const kept = await c.e('d.txt', 'd1 kept\n');
        const { cs, pair } = await solo(['d.txt'], sD, Ad);
        const res = await cs.rebase(f.repo, [del('clean', kept)], c.scratch);
        assert.deepEqual(res.cancelled, []);
        assert.equal(res.recapture.size, 0);
        assert.deepEqual(res.ready.map((p) => [p.csId, p.paths]), [[pair.csId, ['d.txt']]]);
        assert.deepEqual(await c.read(res.ready[0]!), { R: { 'd.txt': 'd1 kept\n' }, A: {} });
        const { P } = await cs.composeP(f.repo, Ad2, (X) => maskEntries(X, { A: Ad2, scope: LIVE, records: [] }), new Set());
        assert.equal(P.get('d.txt')!.oid, kept.oid);
      }
      // clean, S_disk == R, no written entry on a one-path pair: nothing is left in R or A_cap, and the pair does not vanish
      // silently — it leaves ready() through `recapture` (withdrawn, no message); the recapture reads the disk.
      for (const diskHas of [false, true]) {
        const { cs } = await solo(['d.txt'], sD, Ad);
        const res = await cs.rebase(f.repo, [del('clean', null)], c.scratch);
        assert.deepEqual(res.cancelled, []);
        assert.deepEqual([...res.recapture], ['d.txt'], 'the pair leaves through recapture');
        assert.deepEqual(res.ready, []);
        assert.equal(cs.closeDue(), true);
        const sNow = diskHas ? await c.tm({ 'd.txt': 'd1\n', 'e.txt': 'e1\n' }) : await c.tm({ 'e.txt': 'e1\n' });
        const got = await cs.capture(f.repo, sNow, Ad2, c.scratch);
        if (diskHas) assert.deepEqual(await c.read(captured(got)), { R: { 'd.txt': 'd1\n' }, A: {} }, 'the disk still has d.txt: it is published, not deleted');
        else assert.equal(got, null, 'the disk has none and neither has A: nothing to publish');
        assert.equal(cs.closeDue(), false);
      }
      // ... and on a two-path pair: d.txt leaves the pair (A_new and the disk both lack it), e.txt stays ready; no deletion is published.
      {
        const { cs, pair } = await solo(['d.txt', 'e.txt'], sD, Ad);
        const res = await cs.rebase(f.repo, [del('clean', null)], c.scratch);
        assert.deepEqual(res.cancelled, []);
        assert.equal(res.recapture.size, 0);
        assert.deepEqual(res.ready.map((p) => [p.csId, p.paths]), [[pair.csId, ['e.txt']]]);
        const { P } = await cs.composeP(f.repo, Ad2, (X) => maskEntries(X, { A: Ad2, scope: LIVE, records: [] }), new Set());
        assert.equal(P.has('d.txt'), false);
        assert.equal(P.get('e.txt')!.oid, sD.get('e.txt')!.oid);
      }
    }

    // (b) add/add: the pair created n.txt, the update created it too with other bytes (A_cap absent, A_new present).
    {
      const An = await c.tm({ 'm.txt': 'm0\n' });
      const sN = await c.tm({ 'm.txt': 'm0\n', 'n.txt': 'mine new\n' });
      const An2 = new Map(An);
      An2.set('n.txt', await c.e('n.txt', 'their new\n'));
      const add = (written: RebaseChange['written'], writtenEntry: TreeEntry | null): RebaseChange => (
        { path: 'n.txt', aOld: null, aNew: An2.get('n.txt')!, written, sDiskBefore: sN.get('n.txt')!, writtenEntry }
      );
      for (const written of ['take_tip', 'none'] as const) {
        const { cs, pair } = await solo(['n.txt'], sN, An);
        const res = await cs.rebase(f.repo, [add(written, null)], c.scratch);
        assert.deepEqual(res.cancelled, [pair.csId], `add/add ${written}`);
        assert.deepEqual([...res.recapture], ['n.txt']);
        assert.deepEqual(res.ready, []);
      }
      const both = await c.e('n.txt', 'mine new\ntheir new\n');
      const { cs, pair } = await solo(['n.txt'], sN, An);
      const res = await cs.rebase(f.repo, [add('concat', both)], c.scratch);
      assert.deepEqual(res.cancelled, []);
      assert.deepEqual(res.ready.map((p) => p.csId), [pair.csId]);
      assert.deepEqual(await c.read(res.ready[0]!), { R: { 'n.txt': 'mine new\ntheir new\n' }, A: { 'n.txt': 'their new\n' } });
      await cs.composeP(f.repo, An2, (X) => maskEntries(X, { A: An2, scope: LIVE, records: [] }), new Set());
      // The same bytes added on both sides are no conflict: R keeps them and A_cap takes A_new.
      const same2 = await solo(['n.txt'], sN, An);
      const sameRes = await same2.cs.rebase(f.repo, [{ ...add('clean', null), aNew: sN.get('n.txt')! }], c.scratch);
      assert.deepEqual(sameRes.cancelled, []);
      assert.deepEqual(await c.read(sameRes.ready[0]!), { R: { 'n.txt': 'mine new\n' }, A: { 'n.txt': 'mine new\n' } });
    }

    // (c) a non-regular mode (120000, a symlink) on one side is a conflict even where merge-file would merge the bytes cleanly.
    {
      const Al = await c.tm({ 'l.txt': BASE });
      const sL = await c.tm({ 'l.txt': mine });                                   // R: line 1 edited, regular file
      const link = mode(await c.e('l.txt', BASE.replace('l8\n', 'theirs\n')), '120000');   // A_new: line 8 edited, now a symlink
      const Al2 = new Map(Al);
      Al2.set('l.txt', link);
      const lc = (written: RebaseChange['written'], writtenEntry: TreeEntry | null, aNew: TreeEntry = link): RebaseChange => (
        { path: 'l.txt', aOld: Al.get('l.txt')!, aNew, written, sDiskBefore: sL.get('l.txt')!, writtenEntry }
      );
      {
        const { cs, pair } = await solo(['l.txt'], sL, Al);
        const res = await cs.rebase(f.repo, [lc('take_tip', null)], c.scratch);
        assert.deepEqual(res.cancelled, [pair.csId], 'a symlink on A_new: no merge-file');
        assert.deepEqual(res.ready, []);
      }
      {
        const { cs, pair } = await solo(['l.txt'], sL, Al);
        const res = await cs.rebase(f.repo, [lc('clean', link)], c.scratch);
        assert.deepEqual(res.ready.map((p) => p.csId), [pair.csId]);
        const R = await f.repo.readTreeMap(res.ready[0]!.R);
        assert.deepEqual(R.get('l.txt'), { path: 'l.txt', mode: '120000', oid: link.oid }, 'R := the written entry, mode included');
      }
      // The symlink on R's side (the pair replaced the file by a link), A_new a regular edit: a conflict too.
      {
        const sLink = new Map([['l.txt', mode(sL.get('l.txt')!, '120000')]]);
        const { cs, pair } = await solo(['l.txt'], sLink, Al);
        const regular = await c.e('l.txt', BASE.replace('l8\n', 'theirs\n'));
        const res = await cs.rebase(f.repo, [{ ...lc('take_tip', null, regular), sDiskBefore: sLink.get('l.txt')! }], c.scratch);
        assert.deepEqual(res.cancelled, [pair.csId]);
      }
      // Three different modes (100644 → 100755 on R, 120000 on A_new) conflict before any merge.
      {
        const sX = new Map([['l.txt', mode(sL.get('l.txt')!, '100755')]]);
        const { cs, pair } = await solo(['l.txt'], sX, Al);
        const res = await cs.rebase(f.repo, [{ ...lc('none', null), sDiskBefore: sX.get('l.txt')! }], c.scratch);
        assert.deepEqual(res.cancelled, [pair.csId]);
      }
      // A mode-only change on one side merges cleanly: R's bytes with A_new's mode.
      {
        const { cs, pair } = await solo(['l.txt'], sL, Al);
        const exec = mode(Al.get('l.txt')!, '100755');
        const res = await cs.rebase(f.repo, [lc('clean', null, exec)], c.scratch);
        assert.deepEqual(res.ready.map((p) => p.csId), [pair.csId]);
        assert.deepEqual((await f.repo.readTreeMap(res.ready[0]!.R)).get('l.txt'), { path: 'l.txt', mode: '100755', oid: sL.get('l.txt')!.oid });
      }
    }
  } finally {
    await c.f.cleanup();
  }
});

test('a rebase withdrawal or cancellation takes the whole publication group: ready pairs sharing a path leave together', async () => {
  const c = await setup('cs-group');
  try {
    const { f } = c;
    const A = await c.tm({ 'a.txt': BASE, 'b.txt': 'b0\n', 'c.txt': 'c0\n', 'd.txt': BASE, 'z.txt': 'z0\n' });
    const mine = BASE.replace('l1\n', 'mine\n');
    const A2 = new Map(A);
    A2.set('a.txt', await c.e('a.txt', BASE.replace('l1\n', 'theirs\n')));   // same line as R: merge-file conflicts
    A2.set('d.txt', await c.e('d.txt', BASE.replace('l1\n', 'theirs\n')));
    // Four captures: (a, b), (b, c) and (c, d) are one publication group (HLD-38: transitive over shared paths); (z) is its own.
    const fresh = async (): Promise<{ cs: ChangeSets; p1: ReadyPair; p2: ReadyPair; p3: ReadyPair; z: ReadyPair }> => {
      const cs = new ChangeSets(PEER, c.clock);
      cs.restore([], 1);
      const cap = async (paths: string[], files: Record<string, string>): Promise<ReadyPair> => {
        cs.observe(paths);
        c.clock.advance(HUMAN_CS_QUIET_MS);
        return captured(await cs.capture(f.repo, await c.tm(files), A, c.scratch));
      };
      const p1 = await cap(['a.txt', 'b.txt'], { 'a.txt': mine, 'b.txt': 'b1\n' });
      const p2 = await cap(['b.txt', 'c.txt'], { 'b.txt': 'b2\n', 'c.txt': 'c1\n' });
      const p3 = await cap(['c.txt', 'd.txt'], { 'c.txt': 'c2\n', 'd.txt': mine });
      const z = await cap(['z.txt'], { 'z.txt': 'z1\n' });
      return { cs, p1, p2, p3, z };
    };
    const change = async (path: string, written: RebaseChange['written'], sDiskBefore: string | null, writtenText: string | null): Promise<RebaseChange> => ({
      path, aOld: A.get(path)!, aNew: A2.get(path)!, written,
      sDiskBefore: sDiskBefore === null ? null : await c.e(path, sDiskBefore),
      writtenEntry: writtenText === null ? null : await c.e(path, writtenText),
    });
    const group = ['a.txt', 'b.txt', 'c.txt', 'd.txt'];

    // take_tip on a.txt cancels p1, and with it every pair of its group (CS_READY_CANCELLED for each); z stays.
    {
      const { cs, p1, p2, p3, z } = await fresh();
      const res = await cs.rebase(f.repo, [await change('a.txt', 'take_tip', mine, null)], c.scratch);
      assert.deepEqual(res.cancelled, [p1.csId, p2.csId, p3.csId], 'never one pair alone');
      assert.deepEqual([...res.recapture].sort(), group);
      assert.deepEqual(res.ready, [z]);
      assert.deepEqual(cs.ready(), [z]);
      assert.equal(cs.closeDue(), true, 'all members closed: re-captured at the next snapshot');
      const re = (await cs.capture(f.repo, await c.tm({ 'a.txt': BASE.replace('l1\n', 'theirs\n'), 'b.txt': 'b2\n', 'c.txt': 'c2\n', 'd.txt': mine }), A2, c.scratch));
      assert.deepEqual(captured(re).paths, group, 'the whole group is re-captured as one CS');
    }
    // A later file effect on a.txt withdraws p1, and with it its group, silently.
    {
      const { cs, z } = await fresh();
      const res = await cs.rebase(f.repo, [await change('a.txt', 'clean', `${mine}later\n`, `${mine}merged\n`)], c.scratch);
      assert.deepEqual(res.cancelled, []);
      assert.deepEqual([...res.recapture].sort(), group);
      assert.deepEqual(res.ready, [z]);
    }
    // A withdrawal on a.txt and a cancellation on d.txt in one update: the group is cancelled (the stronger verdict).
    {
      const { cs, p1, p2, p3, z } = await fresh();
      const res = await cs.rebase(f.repo, [
        await change('a.txt', 'clean', `${mine}later\n`, `${mine}merged\n`),
        await change('d.txt', 'take_tip', mine, null),
      ], c.scratch);
      assert.deepEqual(res.cancelled, [p1.csId, p2.csId, p3.csId]);
      assert.deepEqual([...res.recapture].sort(), group);
      assert.deepEqual(res.ready, [z]);
    }
    // Kept groups are rebased as before: a clean R := written on a.txt keeps the whole group ready.
    {
      const { cs, p1, p2, p3, z } = await fresh();
      const res = await cs.rebase(f.repo, [await change('a.txt', 'clean', mine, `${mine}merged\n`)], c.scratch);
      assert.deepEqual(res.cancelled, []);
      assert.equal(res.recapture.size, 0);
      assert.deepEqual(res.ready.map((p) => p.csId), [p1.csId, p2.csId, p3.csId, z.csId]);
      assert.deepEqual(res.ready.slice(1), [p2, p3, z], 'pairs the update did not touch are unchanged');
      assert.equal((await f.repo.readTreeMap(res.ready[0]!.R)).get('a.txt')!.oid, (await c.e('a.txt', `${mine}merged\n`)).oid);
    }
  } finally {
    await c.f.cleanup();
  }
});
