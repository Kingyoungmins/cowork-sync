// The change-set table on EngineCores over a real clone (Plan 3 Task 9): group captures of seat and human CSs (HLD-40),
// the CS table in journal/keep/cs/table.json (R3-40), the tableless order = n mode (R3-68), restore from the journaled
// table and the cache (R3-69, HLD-36), P2-STRANDED-SKIP in captureStep (R3-23), passing captures (HLD-39) and the cache
// cs/<enc(b)>.json. Signals go through queueSignal(core, s); a capture is a materializing iteration plus captureStep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalBytes, type Json } from '../../src/board/canonicalJson.js';
import { applyStep } from '../../src/engine/apply.js';
import { captureDue, prepareIteration, type IterationCtx } from '../../src/engine/core.js';
import { captureStep, queueSignal, readCsCache, writeCsCache } from '../../src/engine/csStep.js';
import { publishStep } from '../../src/engine/publish.js';
import { csTableKeep, readCsTable } from '../../src/engine/state.js';
import { enc } from '../../src/git/enc.js';
import { readyKey, type CsTable } from '../../src/holds/changesets.js';
import type { CsSignal } from '../../src/holds/signals.js';
import { gitCallsOf, workPath, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { buf, captureReady, lines, prep, withCores } from '../helpers/publishHelpers.js';
import { testRunner } from '../helpers/tmp.js';

const T10 = { timeout: 10 * 60_000 };
const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const QUIET = 20_000;

const py = (name: string, tag = ''): string => lines(12, (i) => `${name}_${i} = ${i}${i === 4 ? tag : ''}`);
const FILES: Record<string, Buffer> = {
  'README.md': buf('# cs table fixture\n'),
  'a.py': buf(py('a')), 'b.py': buf(py('b')), 'c.py': buf(py('c')), 'd.py': buf(py('d')),
  'h.py': buf(py('h')), 'x.py': buf(py('x')), 's.txt': buf('s1\n'),
};

let tool = 0;
function effect(seat: string, paths: readonly string[], o: { agent?: string | null; turnOrigin?: 'prompt' | 'wake' } = {}): CsSignal {
  return { kind: 'effect', seat, agent: o.agent ?? null, toolUseId: `toolu_${++tool}`, paths, turnOrigin: o.turnOrigin ?? 'prompt' };
}

/** A seat writes `files` and reports them in one effect; the next detection tick observes them (claimed by the effect). */
async function seatWrite(p: PeerFixture, seat: string, files: Record<string, string>): Promise<IterationCtx> {
  for (const [path, text] of Object.entries(files)) await writeWork(p, path, text);
  queueSignal(p.core, effect(seat, Object.keys(files)));
  return prep(p);
}

/** A human edit: written and observed by a detection tick (no effect claims it). */
async function humanWrite(p: PeerFixture, files: Record<string, string>): Promise<IterationCtx> {
  for (const [path, text] of Object.entries(files)) await writeWork(p, path, text);
  return prep(p);
}

/** A materializing iteration and captureStep. */
async function capture(p: PeerFixture): Promise<{ it: IterationCtx; captured: string[] }> {
  const it = await prep(p, true);
  const r = await captureStep(p.core, it);
  assert.deepEqual(r.candidates, []);
  return { it, captured: r.captured };
}

const humanId = (p: PeerFixture, n: number): string => `${p.core.peerId}/human/${n}`;

/** A later state commit that changes nothing but its date (a new commit oid): the table and the cache are not rewritten. */
async function laterCommit(fx: CoreFixture, p: PeerFixture): Promise<void> {
  const before = p.core.view!.commit;
  fx.advance(1_000);
  await p.core.commit({ meta: { ...p.core.view!.meta } });
  assert.notEqual(p.core.view!.commit, before);
}

function pairOf(p: PeerFixture, csId: string): NonNullable<ReturnType<PeerFixture['core']['cs']['ready']>[number]> {
  const pair = p.core.view!.ready.find((x) => x.csId === csId);
  assert.ok(pair !== undefined, `${csId} is journaled: ${JSON.stringify(p.core.view!.ready.map((x) => x.csId))}`);
  return pair;
}

/** The entry names of `<treeish>:<dir>` ([] when it does not exist). */
async function journalKeys(p: PeerFixture, treeish: string, dir: string): Promise<string[]> {
  const r = await testRunner().run(['ls-tree', '--name-only', `${treeish}:${dir}`], { class: 'local', cwd: p.deps.paths.workTree });
  return r.code === 0 ? r.stdout.toString('utf8').split('\n').filter((l) => l.length > 0) : [];
}

test('a capture at a seat CS\'s stop journals one ready pair per member CS of the group, each over its own paths, with one shared order, R = S_disk unmasked and A_cap = A', T10, async () => {
  await withCores('cst-group', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    await seatWrite(p, A, { 'a.py': py('a', ' # seat'), 'b.py': py('b', ' # seat') });
    await humanWrite(p, { 'b.py': py('b', ' # seat and human'), 'c.py': py('c', ' # human') });
    // ON_DISK records mask a.py and b.py (whole path): R is still S_disk.
    const it0 = await prep(p, true);
    for (const path of ['a.py', 'b.py']) {
      await core.holds.hold({
        kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: [path], guard: 'eol-bom', origin: 'daemon', cs_ids: [], displaced_by: null,
        blobs: { h0: { [path]: it0.A.get(path)!.oid }, h1: { [path]: it0.mat!.sDiskMap.get(path)!.oid } },
      });
    }
    assert.equal(core.holds.maskingRecords().length, 2);
    queueSignal(core, { kind: 'stop', seat: A });
    const { it, captured } = await capture(p);
    assert.deepEqual(captured.sort(), [`${A}/1`, humanId(p, 1)].sort(), 'one pair per member CS of the group');
    const seat = pairOf(p, `${A}/1`);
    const human = pairOf(p, humanId(p, 1));
    assert.equal(seat.order, human.order, 'one shared order');
    assert.deepEqual(seat.paths, ['a.py', 'b.py']);
    assert.deepEqual(human.paths, ['b.py', 'c.py']);
    const R = await core.repo.readTreeMap(seat.R);
    const Acap = await core.repo.readTreeMap(seat.A);
    for (const path of seat.paths) {
      assert.equal(R.get(path)?.oid, it.mat!.sDiskMap.get(path)?.oid, `R[${path}] = S_disk[${path}] (not masked)`);
      assert.equal(Acap.get(path)?.oid, it.A.get(path)?.oid, `A_cap[${path}] = A[${path}]`);
    }
    assert.equal((await core.repo.readTreeMap(human.R)).get('c.py')?.oid, it.mat!.sDiskMap.get('c.py')?.oid);
    assert.deepEqual((await journalKeys(p, core.view!.commit, 'journal/ready')).sort(), [readyKey(`${A}/1`), readyKey(humanId(p, 1))].sort(),
      'journal/ready/<base64url(cs_id)>');
    assert.deepEqual(await journalKeys(p, core.view!.commit, `journal/ready/${readyKey(`${A}/1`)}`), ['A', 'R']);
  });
});

test('the capture\'s state update carries journal/keep/cs/table.json as canonical JSON and leaves the other keep entries unchanged; a state commit that captures nothing does not rewrite the table', T10, async () => {
  await withCores('cst-keep', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    const empty = await core.repo.emptyTree();
    await core.commit({ keep: new Map([['snap_pre_freeze', empty]]) });
    await seatWrite(p, A, { 'x.py': py('x', ' # seat') });
    queueSignal(core, { kind: 'stop', seat: A });
    const { captured } = await capture(p);
    assert.deepEqual(captured, [`${A}/1`]);
    const view = core.view!;
    assert.equal(view.keep.get('snap_pre_freeze'), empty, 'the other keep entries are unchanged');
    const cs = view.keep.get('cs');
    assert.ok(cs !== undefined);
    assert.deepEqual(await journalKeys(p, cs, ''), ['table.json']);
    const bytes = await core.repo.readBlob((await core.repo.readTreeMap(cs)).get('table.json')!.oid);
    assert.ok(canonicalBytes(JSON.parse(bytes.toString('utf8')) as Json).equals(bytes), 'canonical JSON');
    assert.deepEqual(JSON.parse(bytes.toString('utf8')), core.cs.table());
    // An iteration with nothing to capture commits nothing; a later transition leaves the table as it is.
    const it = await prep(p, true);
    assert.deepEqual(await captureStep(core, it), { captured: [], candidates: [] });
    assert.equal(core.view!.commit, view.commit);
    await laterCommit(fx, p);
    assert.equal(core.view!.keep.get('cs'), cs, 'not rewritten');
  });
});

test('readCsTable round-trips the table and csTableKeep names it \'cs\'; StateStore.read accepts seat cs_ids in journal/ready and takes ReadyPair.order from the table; without a table a human pair\'s order is n', T10, async () => {
  await withCores('cst-read', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    // Without a table: Plan 2's capture, order = n.
    await humanWrite(p, { 'h.py': py('h', ' # human') });
    fx.advance(QUIET);
    const pair = await captureReady(p, await prep(p, true));
    assert.equal(pair.csId, humanId(p, 1));
    assert.equal(await readCsTable(core.repo, core.view!), null);
    let read = await core.state.read();
    assert.deepEqual(read!.ready.map((x) => [x.csId, x.order]), [[humanId(p, 1), 1]]);
    // A seat capture writes the table.
    await seatWrite(p, A, { 'x.py': py('x', ' # seat') });
    queueSignal(core, { kind: 'stop', seat: A });
    await capture(p);
    const t = await readCsTable(core.repo, core.view!);
    assert.ok(t !== null);
    assert.deepEqual(t, core.cs.table(), 'round trip');
    const [name, tree] = await csTableKeep(core.repo, t);
    assert.equal(name, 'cs');
    assert.equal(tree, core.view!.keep.get('cs'), 'the same canonical bytes, the same tree');
    read = await core.state.read();
    assert.deepEqual(read!.ready.map((x) => [x.csId, x.order]), [[humanId(p, 1), 1], [`${A}/1`, t.orders[`${A}/1`]!]]);
    assert.equal(t.orders[`${A}/1`], 2);
    assert.equal(t.orders[humanId(p, 1)], 1);
  });
});

test('commit() refuses a ready pair whose order the table does not name once a table exists', T10, async () => {
  await withCores('cst-refuse', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    await seatWrite(p, A, { 'x.py': py('x', ' # seat') });
    queueSignal(core, { kind: 'stop', seat: A });
    await capture(p);
    const view = core.view!;
    const pair = pairOf(p, `${A}/1`);
    await assert.rejects(core.commit({ ready: [...view.ready, { ...pair, csId: `${A}/9`, order: 9 }] }), /order/);
    await assert.rejects(core.commit({ ready: [{ ...pair, order: pair.order + 1 }] }), /order/);
    await assert.rejects(core.commit({ ready: [...view.ready, { ...pair, csId: humanId(p, 7), order: 7 }] }), /order/,
      'a human pair needs the table too once one exists');
    assert.equal(core.view, view, 'nothing was written');
    await core.commit({ ready: view.ready });
  });
});

test('the first table names every Plan 2-style pair: a group capture after a human pair journaled without a table gets a strictly larger order and its commit is accepted', T10, async () => {
  await withCores('cst-first', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    await humanWrite(p, { 'h.py': py('h', ' # human') });
    fx.advance(QUIET);
    const old = await captureReady(p, await prep(p, true));
    assert.deepEqual([old.csId, old.order], [humanId(p, 1), 1]);
    assert.equal(core.view!.keep.has('cs'), false);
    await seatWrite(p, A, { 'x.py': py('x', ' # seat') });
    queueSignal(core, { kind: 'stop', seat: A });
    await capture(p);
    const t = await readCsTable(core.repo, core.view!);
    assert.ok(t !== null);
    assert.equal(t.orders[humanId(p, 1)], 1, 'the Plan 2-style pair keeps order n');
    assert.equal(t.orders[`${A}/1`], 2, 'the group capture sorts after it');
    assert.equal(t.next_order, 3);
    assert.equal(t.passing[humanId(p, 1)], true, 'a Plan 2 pair counts as passing');
    assert.ok((await core.state.read()) !== null, 'StateStore.commit accepted it');
    // captureReady after that commits the table keep entry, and is accepted.
    await humanWrite(p, { 'c.py': py('c', ' # human') });
    fx.advance(QUIET);
    const next = await captureReady(p, await prep(p, true));
    assert.deepEqual([next.csId, next.order], [humanId(p, 2), 3]);
    const t2 = await readCsTable(core.repo, core.view!);
    assert.equal(t2!.orders[humanId(p, 2)], 3);
    assert.equal(t2!.next_order, 4);
    assert.deepEqual((await core.state.read())!.ready.map((x) => x.order), [1, 2, 3]);
  });
});

test('capture keeps Plan 2\'s call shape', T10, async () => {
  await withCores('cst-shape', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    await humanWrite(p, { 'h.py': py('h', ' # human') });
    fx.advance(QUIET);
    const it = await prep(p, true);
    const r = await core.cs.capture(core.repo, it.mat!.sDiskMap, it.A, core.scratch('r'));
    assert.ok(r !== null && r.pair !== null);
    assert.deepEqual(Object.keys(r).sort(), ['nextN', 'pair', 'pairs']);
    assert.equal(r.pair, r.pairs[0], 'pair is the first closing CS\'s pair');
    assert.equal(r.pairs.length, 1);
    assert.equal(r.pair.csId, humanId(p, 1));
    assert.equal(r.nextN, 2);
  });
});

test('a group capture that a kept push intent defers changes nothing: no first table is built and the Plan 2 form still applies', T10, async () => {
  await withCores('cst-kept', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    await humanWrite(p, { 'h.py': py('h', ' # one') });
    fx.advance(QUIET);
    const old = await captureReady(p, await prep(p, true));
    // The open human CS shares h.py with the pair a kept push intent names: their one group waits for the intent.
    await humanWrite(p, { 'h.py': py('h', ' # two') });
    fx.advance(QUIET);
    const it = await prep(p, true);
    const before = core.cs.table();
    assert.equal(await core.cs.capture(core.repo, it.mat!.sDiskMap, it.A, core.scratch('r'), new Set([old.csId]), []), null);
    assert.deepEqual(core.cs.table(), before, 'nothing changed');
    assert.equal(core.cs.closeDue(), true, 'the close is still due');
    // The loop's Plan 2 call (no pins) still takes the tableless form: order = n.
    const r = await core.cs.capture(core.repo, it.mat!.sDiskMap, it.A, core.scratch('r'), new Set([old.csId]));
    assert.ok(r !== null && r.pair !== null);
    assert.deepEqual([r.pair.csId, r.pair.order], [humanId(p, 2), 2]);
  });
});

test('without a journaled table a Plan 2-style capture keeps order = n and is accepted', T10, async () => {
  await withCores('cst-r368', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    // A restart with meta.cs_human_next = 5, no journaled pair and no table.
    await core.commit({ meta: { ...core.view!.meta, cs_human_next: 5 } });
    core.cs.restore(core.view!.ready, 5, null, null);
    await humanWrite(p, { 'h.py': py('h', ' # human') });
    fx.advance(QUIET);
    const pair = await captureReady(p, await prep(p, true));   // the loop's Plan 2 call, no captureStep
    assert.deepEqual([pair.csId, pair.order], [humanId(p, 5), 5]);
    assert.equal(core.view!.keep.has('cs'), false, 'no table is written');
    assert.deepEqual((await core.state.read())!.ready.map((x) => [x.csId, x.order]), [[humanId(p, 5), 5]]);
    // A later captureStep capture writes the first table: orders[human/5] = 5 and next_order 6 before the capture.
    await humanWrite(p, { 'c.py': py('c', ' # human') });
    fx.advance(QUIET);
    const { captured } = await capture(p);
    assert.deepEqual(captured, [humanId(p, 6)]);
    const t = await readCsTable(core.repo, core.view!);
    assert.equal(t!.orders[humanId(p, 5)], 5);
    assert.equal(t!.orders[humanId(p, 6)], 6, 'the capture took next_order 6');
    assert.equal(t!.next_order, 7);
  });
});

test('a Plan 2-shape capture → publish → capture cycle with no captureStep call writes no table and every state update is accepted', T10, async () => {
  await withCores('cst-p2cycle', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    const mark = fx.trace.events.length;
    await humanWrite(p, { 'h.py': py('h', ' # one') });
    fx.advance(QUIET);
    await captureReady(p, await prep(p, true));
    await prep(p);
    fx.advance(6_000);
    const r = await publishStep(core, await prep(p));
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    await humanWrite(p, { 'c.py': py('c', ' # two') });
    fx.advance(QUIET);
    await captureReady(p, await prep(p, true));
    const states = fx.trace.since(mark).flatMap((e) => (e.kind === 'state' ? [e.next] : []));
    assert.ok(states.length >= 3, `capture, publish (intent + ok update) and capture: ${states.length} state commits`);
    for (const s of states) assert.equal((await journalKeys(p, s, 'journal/keep')).includes('cs'), false, `${s} holds no journal/keep/cs/`);
    assert.ok((await core.state.read()) !== null);
  });
});

/** R3-69's three cache cases over one journaled table naming a non-passing pair of A/1 and next_order 7. */
async function restoreCase(label: string, cache: 'fresh' | 'stale' | 'none'): Promise<void> {
  await withCores(label, { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    // A/1 and the open human CS share a.py: A's stop captures both, not passing (the human CS is open and uncovered).
    await seatWrite(p, A, { 'a.py': py('a', ' # seat') });
    await humanWrite(p, { 'a.py': py('a', ' # seat and human') });
    queueSignal(core, { kind: 'stop', seat: A });
    await capture(p);
    const t0 = core.cs.table();
    assert.equal(t0.passing[`${A}/1`], false);
    await core.commit({ keep: new Map([...core.view!.keep, await csTableKeep(core.repo, { ...t0, next_order: 7 })]) });
    const journaled = await readCsTable(core.repo, core.view!);
    assert.equal(journaled!.next_order, 7);
    await writeCsCache(core);
    if (cache === 'stale') await laterCommit(fx, p);
    if (cache === 'none') await unlink(join(p.deps.paths.coworkDir, 'cs', `${enc(p.deps.branch)}.json`));
    const cached = await readCsCache(core);
    assert.equal(cached !== null, cache === 'fresh', `readCsCache for a ${cache} cache`);
    core.cs.restore(core.view!.ready, core.view!.meta.cs_human_next, journaled, cached);
    assert.equal(core.cs.table().passing[`${A}/1`], false, 'passing comes from the journaled table');
    assert.equal(core.cs.table().next_order, 7);
    // Plan 2's error-path restore (journaled undefined) keeps the in-memory table.
    const before = core.cs.table();
    core.cs.restore(core.view!.ready, core.view!.meta.cs_human_next);
    assert.deepEqual(core.cs.table(), before);
    // An unpublished delta outside a ready pair: the human CS with a fresh cache, one recovered CS otherwise.
    await humanWrite(p, { 'd.py': py('d', ' # after the restore') });
    fx.advance(QUIET);
    const { captured } = await capture(p);
    const t = core.cs.table();
    const withD = t.cs.find((e) => e.paths.includes('d.py'));
    assert.ok(withD !== undefined && captured.includes(withD.cs_id));
    assert.equal(withD.kind, cache === 'fresh' ? 'human' : 'recovered');
    assert.equal(t.orders[withD.cs_id], 7, 'the next capture\'s order is 7');
    assert.match(withD.cs_id, /^[0-9a-f]{32}\/human\/[1-9][0-9]*$/, 'a human-class cs_id');
  });
}

test('restore takes orders, next_order and passing from the journaled table and only open membership from the cache', T10, async (t) => {
  await t.test('(a) a fresh cache', () => restoreCase('cst-restore-fresh', 'fresh'));
  await t.test('(b) a stale cache', () => restoreCase('cst-restore-stale', 'stale'));
  await t.test('(c) no cache', () => restoreCase('cst-restore-none', 'none'));
});

test('fix round 1 (finding 3): Plan 2\'s error-path restore after an HLD-41 rebase (apply.ts\'s failed state update) keeps a non-passing pair non-passing', T10, async () => {
  await withCores('cst-rebase-restore', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    await seatWrite(p, A, { 'a.py': py('a', ' # seat') });
    await humanWrite(p, { 'a.py': py('a', ' # seat and human') });
    queueSignal(core, { kind: 'stop', seat: A });
    const { it } = await capture(p);
    const before = core.cs.table();
    assert.deepEqual(before.passing, { [`${A}/1`]: false, [humanId(p, 1)]: false });
    // apply.ts's order: the HLD-41 rebase changes memory (here A moves on a.py with no write: the group is cancelled), the state
    // update fails, and the error path restores the journal's pairs (journaled undefined).
    const prev = core.view!;
    const res = await core.cs.rebase(core.repo, [{ path: 'a.py', aOld: it.A.get('a.py') ?? null, aNew: null, written: 'none', sDiskBefore: null, writtenEntry: null }], core.scratch('r'));
    assert.deepEqual(res.cancelled.sort(), [`${A}/1`, humanId(p, 1)].sort());
    core.cs.restore(prev.ready, prev.meta.cs_human_next);
    assert.deepEqual(core.cs.table().passing, before.passing, 'no pass flip');
    assert.deepEqual(core.cs.table(), before);
  });
});

test('no capture is journaled while a restore is stranded', T10, async () => {
  await withCores('cst-stranded', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    await fx.pushTeamChange({ 's.txt': buf('s2\n') });
    // s.txt: P2's link fails, the rollback's relink of its .old too, and the sweeps of the next two iterations.
    p.fs.addRule({ op: 'link', pathIncludes: workPath(p, 's.txt'), code: 'EPERM', times: 4 });
    fx.advance(10_000);
    const r = await applyStep(core, await prep(p));
    assert.equal(r.deferred.get('s.txt'), 'locked');
    assert.deepEqual(core.writer.strandedPaths(), ['s.txt']);
    await humanWrite(p, { 'h.py': py('h', ' # human') });   // the third link failure
    fx.advance(QUIET);
    assert.equal(core.cs.closeDue(), true, 'the human CS is due to close');
    const view = core.view!;
    const it = await prep(p, true);   // the fourth: still stranded, and materialized
    assert.deepEqual(core.writer.strandedPaths(), ['s.txt']);
    assert.ok(it.mat !== null);
    assert.deepEqual(await captureStep(core, it), { captured: [], candidates: [] });
    assert.equal(core.view, view, 'the state commit is unchanged');
    fx.advance(1_000);
    await prep(p);   // the sweep restores s.txt
    assert.deepEqual(core.writer.strandedPaths(), []);
    const { captured } = await capture(p);
    assert.deepEqual(captured, [humanId(p, 1)]);
    assert.deepEqual(pairOf(p, humanId(p, 1)).paths, ['h.py']);
  });
});

test('a captureStep whose state update fails restores ChangeSets: the closed seat CS is still due and the next iteration captures it', T10, async () => {
  await withCores('cst-rollback', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    await seatWrite(p, A, { 'x.py': py('x', ' # one') });
    queueSignal(core, { kind: 'stop', seat: A });
    await capture(p);   // the first table is journaled
    await seatWrite(p, A, { 'a.py': py('a', ' # two') });
    // An open human CS outside A/2's group, not quiet yet: it has no cs_id, so the table does not list it.
    await humanWrite(p, { 'h.py': py('h', ' # human, open') });
    queueSignal(core, { kind: 'stop', seat: A });
    const view = core.view!;
    const commit = core.commit.bind(core);
    core.commit = async () => {
      throw new Error('injected state update failure');
    };
    try {
      await assert.rejects(captureStep(core, await prep(p, true)), /injected/);
    } finally {
      core.commit = commit;
    }
    assert.equal(core.view, view);
    assert.deepEqual(core.cs.ready().map((x) => x.csId), [`${A}/1`], 'the journal\'s pairs');
    assert.equal(core.cs.table().cs.find((e) => e.cs_id === `${A}/2`)?.state, 'closed');
    assert.equal(core.cs.closeDue(), true, 'A/2\'s closing capture is still due');
    assert.ok(core.cs.openPaths().has('h.py'), 'the open human CS (no cs_id yet) keeps its delta through the restore');
    const { captured } = await capture(p);
    assert.deepEqual(captured, [`${A}/2`]);
    assert.equal(pairOf(p, `${A}/2`).order, pairOf(p, `${A}/1`).order + 1);
    fx.advance(QUIET);
    assert.deepEqual((await capture(p)).captured, [humanId(p, 1)], 'the human CS still closes and is captured');
    assert.deepEqual(pairOf(p, humanId(p, 1)).paths, ['h.py']);
  });
});

test('a materialization that captureDue did not ask for captures nothing', T10, async () => {
  await withCores('cst-holdpaths', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    await humanWrite(p, { 'h.py': py('h', ' # human') });
    assert.equal(captureDue(core), false, 'the human CS is not quiet yet');
    const r = await prepareIteration(core, 900_001, { materialize: false, forceFetch: true, holdPaths: new Set(['h.py']) });
    assert.ok(r.ok && r.it.mat !== null, 'materialized for a hold-record occasion');
    const view = core.view!;
    assert.deepEqual(await captureStep(core, r.it), { captured: [], candidates: [] });
    assert.equal(core.view, view);
    assert.deepEqual(core.view!.ready, []);
  });
});

test('a non-passing capture never replaces an unpublished passing pair, and a CS without a pair always gets one', T10, async () => {
  await withCores('cst-passing', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    await seatWrite(p, A, { 'a.py': py('a', ' # v1') });
    queueSignal(core, { kind: 'checkpoint', seat: A, source: 'green', candSeq: 1, paths: ['a.py'] });
    assert.equal(captureDue(core), true, 'a pending green checkpoint makes a capture due');
    await capture(p);
    const passing = pairOf(p, `${A}/1`);
    assert.equal(core.cs.table().passing[`${A}/1`], true);
    // The human CS joins the group through a.py, then A/1 gets a newer, uncovered effect.
    await humanWrite(p, { 'a.py': py('a', ' # v2 human') });
    await seatWrite(p, A, { 'a.py': py('a', ' # v3 seat') });
    assert.equal(core.cs.table().cs.find((e) => e.cs_id === `${A}/1`)!.covered, false, 'a later effect is not covered');
    fx.advance(QUIET);
    const { captured } = await capture(p);
    assert.deepEqual(captured, [humanId(p, 1)], 'only the human CS gets a pair');
    const kept = pairOf(p, `${A}/1`);
    assert.deepEqual([kept.R, kept.A, kept.order], [passing.R, passing.A, passing.order], 'A/1 keeps its passing pair');
    assert.equal(core.cs.table().passing[`${A}/1`], true);
    assert.equal(core.cs.table().passing[humanId(p, 1)], false);
    assert.deepEqual(pairOf(p, humanId(p, 1)).paths, ['a.py']);
  });
});

test('a newer passing capture of the same group supersedes the older one', T10, async () => {
  await withCores('cst-newer', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    await seatWrite(p, A, { 'a.py': py('a', ' # v1') });
    queueSignal(core, { kind: 'checkpoint', seat: A, source: 'green', candSeq: 1, paths: ['a.py'] });
    await capture(p);
    const first = pairOf(p, `${A}/1`);
    // A later edit (writeWork's 1 µs mtime steps can collide at the 2026 virtual wall, so a same-size rewrite needs the clock to move).
    fx.advance(2_500);
    await seatWrite(p, A, { 'a.py': py('a', ' # v2') });
    queueSignal(core, { kind: 'checkpoint', seat: A, source: 'tool', candSeq: 2, paths: ['a.py'] });
    const { it } = await capture(p);
    const second = pairOf(p, `${A}/1`);
    assert.equal(core.view!.ready.length, 1, 'one pair per CS');
    assert.ok(second.order > first.order);
    assert.notEqual(second.R, first.R);
    assert.equal((await core.repo.readTreeMap(second.R)).get('a.py')?.oid, it.mat!.sDiskMap.get('a.py')?.oid);
    assert.equal(core.cs.table().passing[`${A}/1`], true);
  });
});

test('edits after the trigger stay in the open CS and are not in the journaled pair', T10, async () => {
  await withCores('cst-after', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    await seatWrite(p, A, { 'a.py': py('a', ' # v1') });
    queueSignal(core, { kind: 'checkpoint', seat: A, source: 'green', candSeq: 1, paths: ['a.py'] });
    const { it } = await capture(p);
    const v1 = it.mat!.sDiskMap.get('a.py')!.oid;
    fx.advance(2_500);   // a later edit (a same-size rewrite needs the clock to move: writeWork's 1 µs mtime steps can collide)
    await seatWrite(p, A, { 'a.py': py('a', ' # v2'), 'b.py': py('b', ' # v2') });
    const after = await capture(p);   // nothing is due
    assert.notEqual(after.it.mat!.sDiskMap.get('a.py')?.oid, v1, 'the disk holds the later edit');
    const pair = pairOf(p, `${A}/1`);
    assert.equal((await core.repo.readTreeMap(pair.R)).get('a.py')?.oid, v1, 'R keeps the captured blob');
    assert.deepEqual(pair.paths, ['a.py']);
    const e = core.cs.table().cs.find((x) => x.cs_id === `${A}/1`)!;
    assert.equal(e.state, 'open');
    assert.deepEqual(e.paths, ['a.py', 'b.py'], 'the later edits stay in the open CS');
  });
});

test('a capture is where R is first written: ticks before it write no object and its iteration writes each dirty group blob once', T10, async () => {
  await withCores('cst-w6', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    const writes = (from: number, to?: number): Map<string, number> => {
      const count = new Map<string, number>();
      for (const c of gitCallsOf(p).slice(from, to)) {
        if (c.args[0] === 'add') {
          for (const path of (c.opts.stdin as Buffer | undefined)?.toString('utf8').split('\0').filter((x) => x.length > 0) ?? []) count.set(path, (count.get(path) ?? 0) + 1);
        } else if (c.args[0] === 'hash-object' && c.args.includes('-w')) {
          const path = c.args.find((x) => x.startsWith('--path='))?.slice('--path='.length) ?? '(stdin)';
          count.set(path, (count.get(path) ?? 0) + 1);
        }
      }
      return count;
    };
    const t0 = gitCallsOf(p).length;
    await seatWrite(p, A, { 'a.py': py('a', ' # seat'), 'b.py': py('b', ' # seat') });
    for (let i = 0; i < 3; i++) {
      fx.advance(2_500);
      await writeWork(p, 'a.py', py('a', ` # seat ${i}`));
      queueSignal(core, effect(A, ['a.py']));
      await prep(p);
    }
    assert.deepEqual([...writes(t0)], [], 'detection ticks write no object');
    queueSignal(core, { kind: 'stop', seat: A });
    const t1 = gitCallsOf(p).length;
    const it = await prep(p, true);
    const t2 = gitCallsOf(p).length;
    const r = await captureStep(core, it);
    assert.deepEqual(r.captured, [`${A}/1`]);
    assert.deepEqual([...writes(t1, t2)].sort(), [['a.py', 1], ['b.py', 1]], 'one materialization writes each dirty group blob once');
    // The capture's own route (c) writes are metadata (the CS table, meta and intent blobs of its state update), never a path's blob.
    assert.deepEqual([...writes(t2)].filter(([path]) => path !== '(stdin)'), [], 'the capture itself writes no path blob: R names the materialized ones');
    const R = await core.repo.readTreeMap(pairOf(p, `${A}/1`).R);
    assert.equal(R.get('a.py')?.oid, it.mat!.sDiskMap.get('a.py')?.oid);
  });
});

test('writeCsCache after a membership-changing signal writes cs/<enc(b)>.json naming the current state commit with the open seat CS\'s members, and readCsCache returns it only when it names view.commit', T10, async () => {
  await withCores('cst-cache', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    queueSignal(core, effect(A, ['a.py']));
    await writeCsCache(core);
    const file = join(p.deps.paths.coworkDir, 'cs', `${enc(p.deps.branch)}.json`);
    const bytes = await readFile(file);
    const doc = JSON.parse(bytes.toString('utf8')) as { state: string; table: CsTable };
    assert.ok(canonicalBytes(doc as unknown as Json).equals(bytes), 'canonical JSON');
    assert.deepEqual(Object.keys(doc).sort(), ['state', 'table']);
    assert.equal(doc.state, core.view!.commit);
    const e = doc.table.cs.find((x) => x.cs_id === `${A}/1`);
    assert.ok(e !== undefined && e.state === 'open');
    assert.deepEqual(e.paths, ['a.py']);
    assert.deepEqual(await readCsCache(core), doc.table);
    await laterCommit(fx, p);
    assert.equal(await readCsCache(core), null, 'a later state commit without a rewrite makes it stale');
    // B's membership change rewrites it for the current commit.
    queueSignal(core, effect(B, ['b.py']));
    await writeCsCache(core);
    assert.deepEqual((await readCsCache(core))!.cs.map((x) => x.cs_id), [`${A}/1`, `${B}/1`]);
    // Fix round 1 (finding 5): a transient Windows EPERM/EBUSY on the rename is retried (3 × 50 ms) and the write lands.
    queueSignal(core, effect(B, ['c.py']));
    p.fs.addRule({ op: 'rename', pathIncludes: `${enc(p.deps.branch)}.json`, code: 'EPERM', times: 1 });
    p.fs.addRule({ op: 'rename', pathIncludes: `${enc(p.deps.branch)}.json`, code: 'EBUSY', times: 1 });
    await writeCsCache(core);
    assert.deepEqual((await readCsCache(core))!.cs.find((x) => x.cs_id === `${B}/1`)?.paths, ['b.py', 'c.py'], 'the retried write landed');
    // A write that still fails after its retries leaves no cache behind (it would name the current commit with older membership:
    // the table reads as lost, the safe direction) and does not throw into the signal path.
    queueSignal(core, effect(B, ['d.py']));
    p.fs.addRule({ op: 'rename', pathIncludes: `${enc(p.deps.branch)}.json`, code: 'EPERM', times: 4 });
    await writeCsCache(core);
    assert.equal(await readCsCache(core), null, 'no cache with the older membership survives a failed write');
    assert.deepEqual(await readdir(join(p.deps.paths.coworkDir, 'cs')), [], 'no temp file is left in cs/');
    await writeCsCache(core);
    assert.deepEqual((await readCsCache(core))!.cs.find((x) => x.cs_id === `${B}/1`)?.paths, ['b.py', 'c.py', 'd.py']);
  });
});

test('fix round 1 (finding 5): overlapping writeCsCache calls run one at a time in call order and never delete each other\'s cache', T10, async () => {
  await withCores('cst-cache-queue', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    const name = `${enc(p.deps.branch)}.json`;
    queueSignal(core, effect(A, ['a.py']));
    // The first call's rename waits a few turns of the event loop: an unserialized second call would overwrite the shared temp file
    // and lose its own rename (ENOENT), then delete the first call's cache.
    p.fs.interpose('rename', name, async () => {
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    });
    const mark = p.fs.calls.length;
    const first = writeCsCache(core);
    queueSignal(core, effect(B, ['b.py']));
    const second = writeCsCache(core);
    await Promise.all([first, second]);
    const ops = p.fs.calls.slice(mark).filter((c) => c.includes(name)).map((c) => c.split(' ')[0]);
    assert.deepEqual(ops.filter((op) => op === 'writeFile' || op === 'rename'), ['writeFile', 'rename', 'writeFile', 'rename'], 'one write at a time');
    assert.deepEqual((await readCsCache(core))!.cs.map((x) => x.cs_id), [`${A}/1`, `${B}/1`], 'the later call\'s membership');
    // The temp directory is created when it is missing.
    await rm(join(p.deps.paths.coworkDir, 'tmp'), { recursive: true, force: true });
    await writeCsCache(core);
    assert.ok((await readCsCache(core)) !== null);
  });
});
