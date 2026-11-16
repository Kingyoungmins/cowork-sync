// The edit check (Plan 3 Task 10; 05-holds HLD-67 steps 1, 3, 4, HLD-39, HLD-35, HLD-36, U10, I12, TC-HLD-11 (b), (c), (e), (g);
// 04-regions §3.20 check 4's size clause; rulings R3-03, R3-41; rev 2.5: glossary §29.8, 05 §2 `last_check`, 10 §3.5.1, X-05,
// X-06, X-08): scripted EditCheckPorts through CoreOptions.ports; a candidate is a checkpoint{source: 'edit', candSeq, paths} signal,
// a materializing iteration and captureStep. Real clones of a file:// remote; git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseCsTrailers } from '../../src/board/boardCommit.js';
import { applyStep } from '../../src/engine/apply.js';
import { type IterationCtx } from '../../src/engine/core.js';
import { captureStep, queueSignal, writeCsCache } from '../../src/engine/csStep.js';
import { publishStep, type PublishReport } from '../../src/engine/publish.js';
import { restart } from '../../src/engine/restart.js';
import { readCsTable } from '../../src/engine/state.js';
import { enc } from '../../src/git/enc.js';
import type { Oid } from '../../src/git/oid.js';
import type { TreeEntry } from '../../src/git/repo.js';
import { HUMAN_CS_QUIET_MS } from '../../src/holds/changesets.js';
import { grammarlessEditCheck, type EditCheckPort, type EditCheckVerdict } from '../../src/holds/ports.js';
import type { CsSignal } from '../../src/holds/signals.js';
import { workPath, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { countCalls } from '../helpers/engineFixture.js';
import { buf, lines, LogRecorder, prep, remoteLiveCode, withCores } from '../helpers/publishHelpers.js';
import { testRunner } from '../helpers/tmp.js';

const T10 = { timeout: 10 * 60_000 };
const S = 'a'.repeat(32);
const S2 = 'b'.repeat(32);
const CS = `${S}/1`;

const py = (name: string, tag = ''): string => lines(12, (i) => `${name}_${i} = ${i}${i === 4 ? tag : ''}`);
const NOTES = '# Notes\n\nl1\nl2\nl3\nl4\nl5\nl6\n';
const FILES: Record<string, Buffer> = {
  'README.md': buf('# edit check fixture\n'),
  'a.py': buf(py('a')), 'b.py': buf(py('b')), 'c.py': buf(py('c')), 'test_a.py': buf(py('t')), 'x.py': buf(py('x')), 'h.py': buf(py('h')),
  'notes.md': buf(NOTES),
};

let tool = 0;
function effect(seat: string, paths: readonly string[]): CsSignal {
  return { kind: 'effect', seat, agent: null, toolUseId: `toolu_${++tool}`, paths, turnOrigin: 'prompt' };
}

/** A seat writes `files` and reports them in one effect; the next detection tick observes them (claimed by the effect). */
async function seatWrite(p: PeerFixture, seat: string, files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) await writeWork(p, path, text);
  queueSignal(p.core, effect(seat, Object.keys(files)));
  await prep(p);
}

/** An edit checkpoint of the seat's CS (06-claude §3.12.1's candidate; Plan 5 feeds it from hooks). */
function checkpoint(p: PeerFixture, seat: string, candSeq: number, paths: readonly string[]): void {
  assert.equal(queueSignal(p.core, { kind: 'checkpoint', seat, source: 'edit', candSeq, paths }), true, 'an edit checkpoint asks for an out-of-cycle iteration');
}

/** A materializing iteration and captureStep. */
async function settle(p: PeerFixture): Promise<{ it: IterationCtx; captured: string[]; verdicts: string[] }> {
  const it = await prep(p, true);
  const r = await captureStep(p.core, it);
  return { it, captured: r.captured, verdicts: r.candidates.map((c) => `${c.csId}:${c.verdict}`) };
}

/** One publishStep in an open governor window. */
async function publish(fx: CoreFixture, p: PeerFixture): Promise<PublishReport> {
  fx.advance(6_000);
  return publishStep(p.core, await prep(p));
}

/**
 * An EditCheckPort answering the queued verdicts in turn (pass when the queue is empty; 'grammarless' runs the Plan 3 binding) and
 * recording every call.
 */
function scripted(): { port: EditCheckPort; calls: Array<{ a: Oid; r: Oid; tip: Oid; csPaths: string[] }>; queue: Array<EditCheckVerdict | 'grammarless'> } {
  const calls: Array<{ a: Oid; r: Oid; tip: Oid; csPaths: string[] }> = [];
  const queue: Array<EditCheckVerdict | 'grammarless'> = [];
  return {
    calls, queue,
    port: {
      async check(repo, a, r, tip, csPaths): Promise<EditCheckVerdict> {
        calls.push({ a, r, tip, csPaths: [...csPaths] });
        const next = queue.shift() ?? { verdict: 'pass' };
        return next === 'grammarless' ? grammarlessEditCheck.check(repo, a, r, tip, csPaths) : next;
      },
    },
  };
}

function editChecks(fx: CoreFixture): Array<{ cs: string; verdict: string }> {
  return fx.trace.ofKind('edit_check').map((e) => ({ cs: e.cs, verdict: e.verdict }));
}

async function commitsOnRemote(fx: CoreFixture, p: PeerFixture): Promise<string | undefined> {
  return remoteLiveCode(fx, p);
}

test('grammarlessEditCheck passes checks 1–3 and fails check 4 when a touched path whose TIP blob is non-empty merges to absent, empty or under 50 % of TIP\'s stored size', T10, async () => {
  await withCores('ec-grammarless', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const repo = p.core.repo;
    const scratch = p.core.scratch('cmp');
    const entry = async (path: string, size: number): Promise<TreeEntry> => ({ path, mode: '100644', oid: await repo.hashBytes(Buffer.from('y'.repeat(size), 'utf8'), true) });
    const tree = async (es: TreeEntry[]): Promise<Oid> => repo.writeTreeMap(new Map(es.map((e) => [e.path, e])), scratch);
    const base = await entry('big.txt', 1_000);
    const other = await entry('other.txt', 1_000);
    const A = await tree([base, other]);
    const TIP = A;
    const r = async (es: TreeEntry[]): Promise<Oid> => tree([other, ...es]);
    // 499 bytes of a 1,000-byte TIP blob: under 50 %.
    assert.deepEqual(await grammarlessEditCheck.check(repo, A, await r([await entry('big.txt', 499)]), TIP, ['big.txt']), { verdict: 'fail', failed: [4] });
    // Empty, and absent (deleted).
    assert.deepEqual(await grammarlessEditCheck.check(repo, A, await r([await entry('big.txt', 0)]), TIP, ['big.txt']), { verdict: 'fail', failed: [4] });
    assert.deepEqual(await grammarlessEditCheck.check(repo, A, await r([]), TIP, ['big.txt']), { verdict: 'fail', failed: [4] });
    // Exactly 500 bytes, a growth and a path absent from TIP pass.
    assert.deepEqual(await grammarlessEditCheck.check(repo, A, await r([await entry('big.txt', 500)]), TIP, ['big.txt']), { verdict: 'pass' });
    assert.deepEqual(await grammarlessEditCheck.check(repo, A, await r([await entry('big.txt', 1_500)]), TIP, ['big.txt']), { verdict: 'pass' });
    assert.deepEqual(await grammarlessEditCheck.check(repo, A, await r([base, await entry('new.txt', 3)]), TIP, ['new.txt']), { verdict: 'pass' });
    // Restricted to the CS's paths: a shrink of a path the CS does not hold is not checked.
    const shrunkOther = await tree([base, await entry('other.txt', 10)]);
    assert.deepEqual(await grammarlessEditCheck.check(repo, A, shrunkOther, TIP, ['big.txt']), { verdict: 'pass' });
    // M is the merge with TIP: a teammate's growth of big.txt makes the CS's cut relative to TIP's size.
    const tipBig = await tree([await entry('big.txt', 2_000), other]);
    assert.deepEqual(await grammarlessEditCheck.check(repo, A, await r([await entry('big.txt', 999)]), tipBig, ['big.txt']), { verdict: 'fail', failed: [], entries: [{ path: 'big.txt', reason: 'merge_conflict' }] },
      'both sides rewrote the one-line file: merge-tree conflicts');
    // Commits are accepted for trees.
    const head = (await repo.resolve('HEAD'))!;
    assert.deepEqual(await grammarlessEditCheck.check(repo, head, head, head, ['README.md']), { verdict: 'pass' });
  });
});

test('a passing candidate of the CS\'s publication group becomes the group\'s ready pairs in one state update, and the port saw (A, R, TIP, the CS\'s own paths)', T10, async () => {
  const seen: Array<{ a: Oid; r: Oid; tip: Oid; csPaths: string[] }> = [];
  const spy: EditCheckPort = {
    async check(repo, a, r, tip, csPaths) {
      seen.push({ a, r, tip, csPaths: [...csPaths] });
      return grammarlessEditCheck.check(repo, a, r, tip, csPaths);
    },
  };
  await withCores('ec-pass', { n: 1, files: FILES, ports: { editCheck: spy } }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    await seatWrite(p, S, { 'a.py': py('a', ' # v2'), 'b.py': py('b', ' # v2') });
    checkpoint(p, S, 1, ['a.py', 'b.py']);
    const aTree = core.view!.base;
    const commits = countCalls(core, 'commit');
    const { it, captured, verdicts } = await settle(p);
    commits.restore();
    assert.deepEqual(verdicts, [`${CS}:pass`]);
    assert.deepEqual(captured, [CS]);
    assert.equal(commits.n, 1, 'one state update');
    assert.equal(seen.length, 1);
    const call = seen[0]!;
    assert.equal(call.a, aTree, 'A');
    assert.equal(call.tip, it.tip, 'TIP');
    assert.deepEqual(call.csPaths, ['a.py', 'b.py'], 'the CS\'s own paths');
    const R = await core.repo.readTreeMap(call.r);
    for (const path of ['a.py', 'b.py']) assert.equal(R.get(path)?.oid, it.mat!.sDiskMap.get(path)?.oid, `R[${path}] = the candidate's S_disk`);
    assert.equal(R.get('c.py')?.oid, it.A.get('c.py')?.oid, 'A elsewhere');
    const pair = core.view!.ready.find((x) => x.csId === CS)!;
    const journaled = await core.repo.readTreeMap(pair.R);
    for (const path of ['a.py', 'b.py']) assert.equal(journaled.get(path)?.oid, R.get(path)?.oid, 'the journaled pair carries the candidate\'s R');
    assert.deepEqual(editChecks(fx), [{ cs: CS, verdict: 'pass' }]);
    assert.equal(core.cs.table().passing[CS], true);
    assert.equal(core.cs.table().cs.find((e) => e.cs_id === CS)!.covered, true, 'the pass covers the latest effect');
    assert.deepEqual(core.cs.groups([]).map((g) => [g.key, g.ready]), [[CS, true]]);
  });
});

test('a failing candidate leaves the state commit, the registry head, the outbox and core.holdCode unchanged and its R blobs referenced by no ref', T10, async () => {
  const s = scripted();
  await withCores('ec-fail', { n: 1, files: FILES, ports: { editCheck: s.port } }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    const log = new LogRecorder();
    p.deps.log = log;
    await seatWrite(p, S, { 'a.py': py('a', ' # failing cut') });
    checkpoint(p, S, 1, ['a.py']);
    s.queue.push({ verdict: 'fail', failed: [1], entries: [{ check: 1, path: 'a.py', line: 4, reason: 'new_error_node' }] });
    const state = core.view!.commit;
    const registry = core.holds.head();
    const outbox = JSON.stringify(core.outbox.toJson());
    const holdCode = core.holdCode;
    const board = (await fx.remote.refs())[core.refs.remoteBoard];
    const { verdicts } = await settle(p);
    assert.deepEqual(verdicts, [`${CS}:fail`]);
    assert.equal(core.view!.commit, state, 'the state commit');
    assert.equal(core.holds.head(), registry, 'the registry head');
    assert.equal(JSON.stringify(core.outbox.toJson()), outbox, 'the outbox');
    assert.equal(core.holdCode, holdCode, 'core.holdCode');
    assert.deepEqual(core.view!.ready, []);
    // Only the trace event and (rev 2.5, D1) the memory-only last_check slot.
    assert.deepEqual(editChecks(fx), [{ cs: CS, verdict: 'fail' }]);
    assert.deepEqual(core.cs.lastCheck.get(CS), { edit_n: 1, kind: 'fail', check: 1, path: 'a.py', line: 4, more: 0 });
    assert.deepEqual(log.lines, [], 'the daemon log carries nothing new');
    // The candidate's R tree and blob: loose objects no ref reaches.
    const cand = s.calls[0]!;
    const R = await core.repo.readTreeMap(cand.r);
    const blob = R.get('a.py')!.oid;
    const r = await testRunner().run(['rev-list', '--objects', '--all'], { class: 'local', cwd: p.deps.paths.workTree });
    const reachable = r.stdout.toString('utf8');
    assert.equal(reachable.includes(blob), false, 'no ref reaches the candidate\'s blob');
    assert.equal(reachable.includes(cand.r), false, 'no ref reaches the candidate\'s tree');
    // The board carries nothing new: a publish window has nothing to send.
    const pub = await publish(fx, p);
    assert.equal(pub.outcome, 'nothing', JSON.stringify(pub));
    assert.equal((await fx.remote.refs())[core.refs.remoteBoard], board);
  });
});

test('an incomplete verdict is a fail', T10, async () => {
  const s = scripted();
  await withCores('ec-incomplete', { n: 1, files: FILES, ports: { editCheck: s.port } }, async (fx) => {
    const p = fx.peers[0]!;
    await seatWrite(p, S, { 'a.py': py('a', ' # over budget') });
    checkpoint(p, S, 1, ['a.py']);
    s.queue.push({ verdict: 'incomplete' });
    const state = p.core.view!.commit;
    const { verdicts, captured } = await settle(p);
    assert.deepEqual(verdicts, [`${CS}:incomplete`]);
    assert.deepEqual(captured, []);
    assert.equal(p.core.view!.commit, state);
    assert.deepEqual(p.core.view!.ready, []);
    assert.equal((await publish(fx, p)).outcome, 'nothing');
    assert.deepEqual(editChecks(fx), [{ cs: CS, verdict: 'incomplete' }]);
  });
});

test('rev 2.5: a failing candidate writes last_check from its first entry — fail with check, path and line, conflict for merge_conflict, incomplete for an incomplete verdict or a no_snapshot/no_merge entry, more = the other entries — and a verdict without entries gives check = failed[0]', T10, async () => {
  const s = scripted();
  await withCores('ec-lastcheck', { n: 1, files: FILES, ports: { editCheck: s.port } }, async (fx) => {
    const p = fx.peers[0]!;
    const lc = p.core.cs.lastCheck;
    const cases: Array<[EditCheckVerdict, unknown]> = [
      [{ verdict: 'fail', failed: [2, 3], entries: [{ check: 2, path: 'a.py', line: 14, reason: 'incompatible_caller' }, { check: 3, path: 'b.py', line: 3, reason: 'unresolved_import' }] },
        { kind: 'fail', check: 2, path: 'a.py', line: 14, more: 1 }],
      [{ verdict: 'fail', failed: [], entries: [{ path: 'a.py', reason: 'merge_conflict' }] }, { kind: 'conflict', path: 'a.py', more: 0 }],
      [{ verdict: 'incomplete' }, { kind: 'incomplete', more: 0 }],
      [{ verdict: 'fail', failed: [], entries: [{ path: 'b.py', reason: 'no_snapshot' }, { path: 'a.py', reason: 'no_merge' }] }, { kind: 'incomplete', path: 'b.py', more: 1 }],
      [{ verdict: 'fail', failed: [4] }, { kind: 'fail', check: 4, more: 0 }],
    ];
    for (const [k, [verdict, want]] of cases.entries()) {
      const candSeq = k + 1;
      await seatWrite(p, S, { 'a.py': py('a', ` # edit ${candSeq}`) });
      checkpoint(p, S, candSeq, ['a.py']);
      s.queue.push(verdict);
      const { verdicts } = await settle(p);
      assert.deepEqual(verdicts, [`${CS}:${verdict.verdict}`], `case ${candSeq}`);
      assert.deepEqual(lc.get(CS), { edit_n: candSeq, ...(want as object) }, `case ${candSeq}: edit_n = candSeq`);
      fx.advance(2_000);
    }
    // grammarlessEditCheck's own failure (check 4, no entries): a.py cut to well under half of TIP's size (a shrink the
    // snapshot reads only from its second stable tick, R-25).
    await seatWrite(p, S, { 'a.py': 'a_1 = 1\n' });
    fx.advance(1_500);
    await prep(p);
    checkpoint(p, S, 6, ['a.py']);
    s.queue.push('grammarless');
    assert.deepEqual((await settle(p)).verdicts, [`${CS}:fail`]);
    assert.deepEqual(lc.get(CS), { edit_n: 6, kind: 'fail', check: 4, more: 0 });
    // A noted edit_n wins over cand_seq (Plan 5's EditCheckpoints notes first).
    lc.noteCandidate(CS, 7, 42);
    await seatWrite(p, S, { 'a.py': 'a_1 = 2\n' });
    fx.advance(1_500);
    await prep(p);
    checkpoint(p, S, 7, ['a.py']);
    s.queue.push({ verdict: 'fail', failed: [4] });
    assert.deepEqual((await settle(p)).verdicts, [`${CS}:fail`]);
    assert.deepEqual(lc.get(CS), { edit_n: 42, kind: 'fail', check: 4, more: 0 });
  });
});

test('rev 2.5: a later passing candidate with a higher edit_n clears last_check and sets last_pass.ready; its publish sets last_pass.shared; the CS\'s close clears the slot', T10, async () => {
  const s = scripted();
  await withCores('ec-lastpass', { n: 1, files: FILES, ports: { editCheck: s.port } }, async (fx) => {
    const p = fx.peers[0]!;
    const lc = p.core.cs.lastCheck;
    await seatWrite(p, S, { 'a.py': py('a', ' # half') });
    checkpoint(p, S, 1, ['a.py']);
    s.queue.push({ verdict: 'fail', failed: [1] });
    await settle(p);
    assert.equal(lc.get(CS)?.edit_n, 1);
    assert.deepEqual(lc.pass(CS), { ready: null, shared: null });
    await seatWrite(p, S, { 'a.py': py('a', ' # whole') });
    checkpoint(p, S, 2, ['a.py']);
    const { verdicts } = await settle(p);
    assert.deepEqual(verdicts, [`${CS}:pass`]);
    assert.equal(lc.get(CS), null, 'a passing capture with a higher edit_n clears last_check');
    assert.deepEqual(lc.pass(CS), { ready: 2, shared: null });
    const pub = await publish(fx, p);
    assert.equal(pub.outcome, 'landed', JSON.stringify(pub));
    assert.deepEqual(lc.pass(CS), { ready: 2, shared: 2 }, 'its publish sets last_pass.shared');
    queueSignal(p.core, { kind: 'stop', seat: S });
    assert.equal(lc.get(CS), null);
    assert.deepEqual(lc.pass(CS), { ready: null, shared: null }, 'the CS\'s close clears the slot');
  });
});

test('rev 2.5: last_check is never in the CS table, the cs/<enc(b)>.json cache, a state commit or the registry, and is empty after a restart', T10, async () => {
  const s = scripted();
  await withCores('ec-memory', { n: 1, files: FILES, ports: { editCheck: s.port } }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    // A passing candidate first, so a table is journaled; then a failing one keeps last_check.
    await seatWrite(p, S, { 'b.py': py('b', ' # ok') });
    checkpoint(p, S, 1, ['b.py']);
    await settle(p);
    await seatWrite(p, S, { 'a.py': py('a', ' # broken') });
    checkpoint(p, S, 2, ['a.py']);
    s.queue.push({ verdict: 'fail', failed: [2], entries: [{ check: 2, path: 'a.py', line: 7, reason: 'incompatible_caller' }] });
    await settle(p);
    assert.deepEqual(core.cs.lastCheck.get(CS), { edit_n: 2, kind: 'fail', check: 2, path: 'a.py', line: 7, more: 0 });
    await writeCsCache(core);
    const view = core.view!;
    assert.ok((await readCsTable(core.repo, view)) !== null, 'a table is journaled');
    const keys = ['"edit_n"', '"more"', '"line"', 'last_check', 'last_pass'];
    const tableTree = view.keep.get('cs')!;
    const tableBytes = (await core.repo.readBlob((await core.repo.readTreeMap(tableTree)).get('table.json')!.oid)).toString('utf8');
    const cacheBytes = (await readFile(core.path(`cs/${enc(p.deps.branch)}.json`))).toString('utf8');
    const metaBytes = (await testRunner().run(['cat-file', '-p', `${view.commit}:meta`], { class: 'local', cwd: p.deps.paths.workTree })).stdout.toString('utf8');
    for (const k of keys) {
      assert.equal(tableBytes.includes(k), false, `journal/keep/cs/table.json carries no ${k}`);
      assert.equal(cacheBytes.includes(k), false, `the cache carries no ${k}`);
      assert.equal(metaBytes.includes(k), false, `the state commit's meta carries no ${k}`);
    }
    assert.equal(JSON.stringify(core.cs.table()).includes('edit_n'), false);
    assert.equal(core.holds.head(), null, 'no registry commit');
    // Lost at daemon restart.
    await restart(core);
    assert.equal(core.cs.lastCheck.get(CS), null);
    assert.deepEqual(core.cs.lastCheck.pass(CS), { ready: null, shared: null });
  });
});

test('rev 2.5: an HLD-41 withdrawal of a passing capture clears last_pass.ready', T10, async () => {
  await withCores('ec-withdraw', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    core.cs.lastCheck.noteCandidate(CS, 1, 5);
    // The passing capture appends at the end of notes.md.
    await seatWrite(p, S, { 'notes.md': `${NOTES}seat v1\n` });
    checkpoint(p, S, 1, ['notes.md']);
    assert.deepEqual((await settle(p)).verdicts, [`${CS}:pass`]);
    assert.deepEqual(core.cs.lastCheck.pass(CS), { ready: 5, shared: null });
    // A later member effect on notes.md (the heading; the append taken back), then the teammate appends at the end.
    await seatWrite(p, S, { 'notes.md': NOTES.replace('# Notes', '# NOTES') });
    await fx.pushTeamChange({ 'notes.md': buf(`${NOTES}team\n`) });
    fx.advance(10_000);
    const r = await applyStep(core, await prep(p));
    assert.equal(r.ran, true);
    assert.deepEqual(r.written, ['notes.md']);
    assert.deepEqual(r.cancelled, [], 'a withdrawal, not a cancellation');
    assert.deepEqual(core.view!.ready, [], 'no pair left');
    assert.deepEqual(core.cs.lastCheck.pass(CS), { ready: null, shared: null }, 'last_pass.ready follows the journal');
  });
});

test('a fail after a pass leaves the earlier ready pair journaled and it publishes in the next window', T10, async () => {
  const s = scripted();
  await withCores('ec-fail-after-pass', { n: 1, files: FILES, ports: { editCheck: s.port } }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    const passing = py('a', ' # helper');
    await seatWrite(p, S, { 'a.py': passing });
    checkpoint(p, S, 1, ['a.py']);
    await settle(p);
    const pair = core.view!.ready.find((x) => x.csId === CS)!;
    await seatWrite(p, S, { 'a.py': py('a', ' # helper and a half-typed caller(') });
    checkpoint(p, S, 2, ['a.py']);
    s.queue.push({ verdict: 'fail', failed: [1] });
    assert.deepEqual((await settle(p)).verdicts, [`${CS}:fail`]);
    assert.deepEqual(core.view!.ready.map((x) => [x.csId, x.R, x.order]), [[CS, pair.R, pair.order]], 'the passing pair stays journaled');
    const pub = await publish(fx, p);
    assert.equal(pub.outcome, 'landed', JSON.stringify(pub));
    const tree = await core.repo.readTreeMap((await core.repo.readCommit(pub.c!)).tree);
    assert.equal((await core.repo.readBlob(tree.get('a.py')!.oid)).toString('utf8'), passing, 'the passing capture published');
  });
});

test('an older candSeq never replaces a newer passing capture', T10, async () => {
  await withCores('ec-candseq', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    await seatWrite(p, S, { 'a.py': py('a', ' # five') });
    checkpoint(p, S, 5, ['a.py']);
    assert.deepEqual((await settle(p)).verdicts, [`${CS}:pass`]);
    const five = core.view!.ready.find((x) => x.csId === CS)!;
    // candSeq 4's checkpoint arrives late, over newer bytes, and passes: the journaled pair stays candSeq 5's.
    await seatWrite(p, S, { 'a.py': py('a', ' # later') });
    checkpoint(p, S, 4, ['a.py']);
    const state = core.view!.commit;
    assert.deepEqual((await settle(p)).verdicts, [`${CS}:pass`]);
    assert.equal(core.view!.commit, state, 'nothing journaled');
    assert.deepEqual(core.view!.ready.map((x) => [x.csId, x.R, x.order]), [[CS, five.R, five.order]]);
  });
});

test('a candidate whose group path cannot be read stably fails silently: no pair, no record, no message', T10, async () => {
  const s = scripted();
  await withCores('ec-unstable', { n: 1, files: FILES, ports: { editCheck: s.port } }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    const log = new LogRecorder();
    p.deps.log = log;
    await seatWrite(p, S, { 'a.py': py('a', ' # x'), 'b.py': py('b', ' # x') });
    // The seat writes b.py again and asks for its edit check; b.py cannot be read while the candidate's iteration reads it (a
    // holder without share-read), so the group's snapshot of b.py is not stable.
    await writeWork(p, 'b.py', py('b', ' # x, again'));
    queueSignal(core, effect(S, ['b.py']));
    checkpoint(p, S, 1, ['a.py', 'b.py']);
    const release = p.fs.holdLock(workPath(p, 'b.py'), 'share-none');
    let out;
    try {
      out = await settle(p);
    } finally {
      release();
    }
    assert.deepEqual(out.verdicts, [`${CS}:incomplete`]);
    assert.deepEqual(out.captured, []);
    assert.equal(s.calls.length, 0, 'the edit check never ran');
    assert.deepEqual(core.view!.ready, [], 'no pair');
    assert.equal(core.holds.all().length, 0, 'no record');
    assert.deepEqual(log.lines, [], 'no message');
    assert.equal(core.cs.lastCheck.get(CS)?.kind, 'incomplete');
  });
});

test('a human CS and a recovered CS never call EditCheckPort', T10, async () => {
  const s = scripted();
  await withCores('ec-human', { n: 1, files: FILES, ports: { editCheck: s.port } }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    const human = `${core.peerId}/human/1`;
    // A human CS: unattributed edits, captured at its 20 s quiet close; an edit checkpoint of a seat with no CS changes nothing.
    await writeWork(p, 'h.py', py('h', ' # human'));
    await prep(p);
    checkpoint(p, S, 1, ['h.py']);
    fx.advance(HUMAN_CS_QUIET_MS);
    const first = await settle(p);
    assert.deepEqual(first.captured, [human]);
    assert.deepEqual(first.verdicts, []);
    // A recovered CS (the table journaled, the cache lost): its deltas are captured at its close, never checked.
    core.cs.restore(core.view!.ready, core.view!.meta.cs_human_next, await readCsTable(core.repo, core.view!), null);
    await writeWork(p, 'x.py', py('x', ' # recovered'));
    await prep(p);
    assert.ok(core.cs.table().cs.some((e) => e.kind === 'recovered' && e.paths.includes('x.py')));
    fx.advance(HUMAN_CS_QUIET_MS);
    const second = await settle(p);
    assert.equal(second.captured.length, 1);
    assert.deepEqual(second.verdicts, []);
    assert.equal(s.calls.length, 0, 'EditCheckPort was never called');
    assert.deepEqual(editChecks(fx), []);
  });
});

test('05 I12 Plan 3 part: edits 40 s apart with verdicts fail [2], pass, pass publish nothing after the first, both edits in one commit with state=checkpoint seq=1 after the second, seq=2 after the third, and state=closed at the stop only if something changed after the third capture', T10, async () => {
  const s = scripted();
  await withCores('ec-i12', { n: 1, files: FILES, ports: { editCheck: s.port } }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    const tip0 = await commitsOnRemote(fx, p);
    // 1: a.py changes a signature; its callers in b.py are not updated yet — check 2 fails.
    await seatWrite(p, S, { 'a.py': py('a', ' # def f(x, y)') });
    checkpoint(p, S, 1, ['a.py']);
    s.queue.push({ verdict: 'fail', failed: [2], entries: [{ check: 2, path: 'b.py', line: 4, reason: 'incompatible_caller' }] });
    await settle(p);
    assert.equal((await publish(fx, p)).outcome, 'nothing', 'nothing publishes after the first edit');
    assert.equal(await commitsOnRemote(fx, p), tip0);
    // 2 (40 s later): b.py's callers — passes: both edits in one commit, state=checkpoint seq=1.
    fx.advance(40_000);
    await seatWrite(p, S, { 'b.py': py('b', ' # f(x, y)') });
    checkpoint(p, S, 2, ['a.py', 'b.py']);
    await settle(p);
    const second = await publish(fx, p);
    assert.equal(second.outcome, 'landed', JSON.stringify(second));
    const c2 = await core.repo.readCommit(second.c!);
    assert.deepEqual(parseCsTrailers(c2.trailers).cs.map((t) => [t.csId, t.state, t.seq]), [[CS, 'checkpoint', 1]]);
    const changed2 = (await core.repo.run(['diff-tree', '--no-commit-id', '--name-only', '-r', c2.parents[0]!, second.c!])).stdout.toString('utf8').trim().split('\n').sort();
    assert.deepEqual(changed2, ['a.py', 'b.py']);
    // 3 (40 s later): test_a.py — passes: seq=2.
    fx.advance(40_000);
    await seatWrite(p, S, { 'test_a.py': py('t', ' # test f(x, y)') });
    checkpoint(p, S, 3, ['test_a.py']);
    await settle(p);
    const third = await publish(fx, p);
    assert.equal(third.outcome, 'landed', JSON.stringify(third));
    const c3 = await core.repo.readCommit(third.c!);
    assert.deepEqual(parseCsTrailers(c3.trailers).cs.map((t) => [t.csId, t.state, t.seq]), [[CS, 'checkpoint', 2]]);
    // The stop with nothing changed after the third capture: no state=closed commit.
    const tip3 = await commitsOnRemote(fx, p);
    queueSignal(core, { kind: 'stop', seat: S });
    await settle(p);
    const after = await publish(fx, p);
    assert.notEqual(after.outcome, 'landed');
    assert.equal(await commitsOnRemote(fx, p), tip3, 'no closed commit when nothing changed');
    // A second seat whose CS changes after its last passing capture: the stop publishes state=closed.
    const cs2 = `${S2}/1`;
    await seatWrite(p, S2, { 'x.py': py('x', ' # one') });
    checkpoint(p, S2, 1, ['x.py']);
    await settle(p);
    assert.equal((await publish(fx, p)).outcome, 'landed');
    await seatWrite(p, S2, { 'x.py': py('x', ' # two') });
    queueSignal(core, { kind: 'stop', seat: S2 });
    await settle(p);
    const closed = await publish(fx, p);
    assert.equal(closed.outcome, 'landed', JSON.stringify(closed));
    const cc = await core.repo.readCommit(closed.c!);
    assert.deepEqual(parseCsTrailers(cc.trailers).cs.map((t) => [t.csId, t.state, t.seq]), [[cs2, 'closed', 2]]);
  });
});

test('TC-HLD-11 (g): a seat editing every 10 s for 10 virtual minutes with every check failing publishes nothing until a check passes or the turn ends', T10, async () => {
  const s = scripted();
  await withCores('ec-tc11g', { n: 1, files: FILES, ports: { editCheck: s.port } }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    /** One failing edit every 10 virtual seconds: the edit, its candidate and a publishStep that composes nothing. */
    const failingEdit = async (i: number): Promise<void> => {
      await seatWrite(p, S, { 'a.py': py('a', ` # edit ${i} (`) });
      checkpoint(p, S, i, ['a.py']);
      s.queue.push({ verdict: 'fail', failed: [1] });
      const { verdicts } = await settle(p);
      assert.deepEqual(verdicts, [`${CS}:fail`], `edit ${i}`);
      const r = await publishStep(core, await prep(p));
      // 'nothing' is publishStep's answer before any window gate: no group is ready, so no code is composed (HLD-12).
      assert.equal(r.outcome, 'nothing', `edit ${i}: no time-capped WIP publish (HLD-12) ${JSON.stringify(r)}`);
      fx.advance(10_000);
    };
    const tip0 = await commitsOnRemote(fx, p);
    const start = p.clock.monoMs();
    for (let i = 1; i <= 60; i++) await failingEdit(i);
    assert.ok(p.clock.monoMs() - start >= 600_000, `10 virtual minutes of failing edits (${p.clock.monoMs() - start} ms)`);
    assert.equal(await commitsOnRemote(fx, p), tip0, 'no live commit in 10 virtual minutes');
    assert.equal(s.calls.length, 60);
    // Exit 1: the first passing check publishes (state=checkpoint seq=1).
    await seatWrite(p, S, { 'a.py': py('a', ' # complete') });
    checkpoint(p, S, 61, ['a.py']);
    assert.deepEqual((await settle(p)).verdicts, [`${CS}:pass`]);
    const pub = await publish(fx, p);
    assert.equal(pub.outcome, 'landed', JSON.stringify(pub));
    assert.deepEqual(parseCsTrailers((await core.repo.readCommit(pub.c!)).trailers).cs.map((t) => [t.csId, t.state, t.seq]), [[CS, 'checkpoint', 1]]);
    fx.advance(4_000);
    // Exit 2: failing edits again publish nothing until the turn ends; the stop's closing capture then publishes the last edit
    // (a closed CS's group is ready without any check, HLD-39), state=closed seq=2.
    const tip1 = await commitsOnRemote(fx, p);
    for (let i = 62; i <= 67; i++) await failingEdit(i);
    assert.equal(await commitsOnRemote(fx, p), tip1, 'no live commit while the checks fail again');
    queueSignal(core, { kind: 'stop', seat: S });
    assert.deepEqual((await settle(p)).captured, [CS], 'the turn end captures the CS');
    const end = await publish(fx, p);
    assert.equal(end.outcome, 'landed', JSON.stringify(end));
    const ce = await core.repo.readCommit(end.c!);
    assert.deepEqual(parseCsTrailers(ce.trailers).cs.map((t) => [t.csId, t.state, t.seq]), [[CS, 'closed', 2]]);
    const tree = await core.repo.readTreeMap(ce.tree);
    assert.equal((await core.repo.readBlob(tree.get('a.py')!.oid)).toString('utf8'), py('a', ' # edit 67 ('), 'the turn end publishes the last edit');
    assert.equal(s.calls.length, 67, 'the closing capture runs no edit check');
  });
});

test('TC-HLD-11 (e): a human CS is captured only after 20 s quiet or done()', T10, async () => {
  const s = scripted();
  await withCores('ec-tc11e', { n: 1, files: FILES, ports: { editCheck: s.port } }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    await writeWork(p, 'h.py', py('h', ' # one'));
    await prep(p);
    fx.advance(HUMAN_CS_QUIET_MS - 1_000);
    assert.deepEqual((await settle(p)).captured, [], '19 s quiet: not yet');
    fx.advance(1_000);
    assert.deepEqual((await settle(p)).captured, [`${core.peerId}/human/1`], '20 s quiet');
    await writeWork(p, 'h.py', py('h', ' # two'));
    await prep(p);
    assert.deepEqual((await settle(p)).captured, []);
    core.cs.done();
    // The group capture of the closing CS (human/1's ready pair shares h.py, so it is captured with it, HLD-40).
    assert.ok((await settle(p)).captured.includes(`${core.peerId}/human/2`), '/cowork done closes it at once');
    assert.equal(s.calls.length, 0);
  });
});
