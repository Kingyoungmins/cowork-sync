// The mass-change breaker and FREEZE(MASS) on real clones (Plan 3 Task 8; 05-holds HLD-30, HLD-31; CS-29, CS-31; TC-HLD-07, 05 I7;
// mutant M33; rulings R3-38, R3-50, contract addition 3). 200 tracked files pkg/m<i>.py of 20 rows, plus f.py and g.py; the
// teammate's `TEAM = 1` row in f.py is applied; "the formatter" rewrites 180 of the pkg/ files with quote-style changes in one tick;
// breakerTick runs on every tick. Git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unlink } from 'node:fs/promises';
import { readBoardCommit } from '../../src/board/boardCommit.js';
import { parseOpLine } from '../../src/board/ops.js';
import { applyStep } from '../../src/engine/apply.js';
import type { IterationCtx } from '../../src/engine/core.js';
import { breakerTick, revertStep, SNAP_PRE_FREEZE } from '../../src/engine/detect.js';
import { publishStep } from '../../src/engine/publish.js';
import { restart } from '../../src/engine/restart.js';
import { massResumePending, massResumeStep, resume } from '../../src/engine/resume.js';
import { parseOid, type Oid } from '../../src/git/oid.js';
import { KilledAt, setCrashHandler } from '../../src/ports/crashpoint.js';
import { readWork, workPath, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { countCalls } from '../helpers/engineFixture.js';
import { buf, captureReady, LogRecorder, prep, remoteBoard, setMutants, treeOf, withCores } from '../helpers/publishHelpers.js';
import { gitIn, restartCore } from '../helpers/startFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const N_PKG = 200;
const N_FMT = 180;
const pkg = (i: number): string => `pkg/m${i}.py`;
const pkgText = (i: number, q: string): string => Array.from({ length: 20 }, (_, j) => `x_${j} = ${q}v${i}_${j}${q}\n`).join('');
const F0 = Array.from({ length: 12 }, (_, i) => `f_${i + 1} = ${i + 1}\n`).join('');
const F_TEAM = F0.replace('f_6 = 6\n', 'f_6 = 6\nTEAM = 1\n');
const G0 = 'g_1 = 1\ng_2 = 2\ng_3 = 3\n';
const FILES: Record<string, Buffer> = {
  'README.md': buf('# mass fixture\n'),
  'f.py': buf(F0),
  'g.py': buf(G0),
  ...Object.fromEntries(Array.from({ length: N_PKG }, (_, i) => [pkg(i), buf(pkgText(i, "'"))])),
};

/** The teammate's TEAM = 1 in f.py applied, then one materialization (the last materialized S_disk before any formatter). */
async function setup(fx: CoreFixture, p: PeerFixture): Promise<void> {
  await fx.pushTeamChange({ 'f.py': buf(F_TEAM) });
  fx.advance(10_000);
  assert.ok((await applyStep(p.core, await prep(p))).ran);
  assert.equal((await readWork(p, 'f.py'))?.toString('utf8'), F_TEAM);
  const it = await prep(p, true);
  assert.deepEqual(await revertStep(p.core, it), []);
}

/** The formatter: 180 pkg/ files rewritten with double quotes (one tick sees them all). */
async function format(p: PeerFixture): Promise<void> {
  for (let i = 0; i < N_FMT; i++) await writeWork(p, pkg(i), pkgText(i, '"'));
}

/** One detection tick (no materialization unless asked) and breakerTick on it. */
async function tick(fx: CoreFixture, p: PeerFixture, materialize = false): Promise<{ it: IterationCtx; why: 'window' | 'peer_lines' | null }> {
  fx.advance(2_500);
  const it = await prep(p, materialize);
  return { it, why: await breakerTick(p.core, it) };
}

/** The formatter's tick enters MASS. */
async function enterByFormatter(fx: CoreFixture, p: PeerFixture): Promise<IterationCtx> {
  await format(p);
  const { it, why } = await tick(fx, p);
  assert.equal(why, 'window');
  assert.ok(p.core.view!.meta.freeze_reasons.includes('MASS'));
  return it;
}

/**
 * The live code at the remote: the last parent of the remote board's tip. (The code mirror is not it: a publish sets the mirror to
 * the TIP it built on, ENG-43, so the mirror lags this peer's own newest live commit.)
 */
async function remoteLive(fx: CoreFixture, p: PeerFixture): Promise<Oid> {
  const b = await p.core.repo.readCommit(parseOid((await remoteBoard(fx, p))!));
  return b.parents[b.parents.length - 1]!;
}

const reverts = (p: PeerFixture): string[] => p.core.holds.nonTerminal().filter((r) => r.guards.some((g) => g.name === 'revert')).map((r) => r.id);

test('a formatter rewriting 180 files in one tick enters FREEZE(MASS)', T10, async () => {
  await withCores('mass-enter', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await setup(fx, p);
    const pre = p.core.snapshot.last()!.sDisk;
    const keepBefore = new Map(p.core.view!.keep);
    const traceFrom = fx.trace.events.length;
    await format(p);
    const { why } = await tick(fx, p);
    assert.equal(why, 'window');
    const view = p.core.view!;
    assert.ok(view.meta.freeze_reasons.includes('MASS'));
    assert.equal(view.keep.get(SNAP_PRE_FREEZE), pre, 'snap_pre_freeze = the last materialized S_disk before the tick');
    assert.deepEqual([...view.keep].filter(([k]) => k !== SNAP_PRE_FREEZE), [...keepBefore], 'the other keep entries unchanged');
    const events = p.core.outbox.drafts().filter((d) => d.type === 'event');
    assert.deepEqual(events.map((d) => [(d as { kind: string }).kind, (d as { reason_code: string }).reason_code]), [['freeze', 'MASS']], 'one freeze event');
    const mass = fx.trace.since(traceFrom).filter((e) => e.kind === 'mass');
    assert.deepEqual(mass.map((e) => ({ ...e, peer: '' })), [{ kind: 'mass', peer: '', entered: true, paths: N_FMT }]);
    assert.equal(p.core.holdCode?.code, 'FROZEN');
  });
});

test('snap_pre_freeze stays reachable under git gc --prune=now', T10, async () => {
  await withCores('mass-gc', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await setup(fx, p);
    // Task 8 fix round 1, finding 2: a local, never captured or published edit, materialized before the formatter, so the pre-freeze
    // tree holds a tree and a blob that only journal/keep/snap_pre_freeze references (no state, live, board or registry commit
    // carries them: a materialization commits no state, and the private index is no gc root).
    const LOCAL = '# mass fixture\nPRE_FREEZE_ONLY = 1\n';
    await writeWork(p, 'README.md', LOCAL);
    await prep(p);
    fx.advance(2_500);
    const mat = await prep(p, true);
    assert.deepEqual(await revertStep(p.core, mat), []);
    const pre = p.core.snapshot.last()!.sDisk;
    const localBlob = (await p.core.repo.readTreeMap(pre)).get('README.md')!.oid;
    assert.equal((await p.core.repo.readBlob(localBlob)).toString('utf8'), LOCAL);
    const reachable = async (o: string): Promise<boolean> => (await gitIn(p, ['rev-list', '--objects', '--all', '--reflog'])).includes(o);
    assert.equal(await reachable(pre), false, 'before the freeze nothing references the pre-freeze tree');
    await enterByFormatter(fx, p);
    await gitIn(p, ['gc', '-q', '--prune=now']);
    // Read first (a keep entry naming another tree, or none, leaves `pre` unreachable: gc prunes it and these reads fail).
    const map = await p.core.repo.readTreeMap(pre);
    assert.ok(map.size >= N_PKG + 2);
    const blobs = await p.core.repo.readBlobs([...map.values()].map((e) => e.oid));
    assert.equal(blobs.length, map.size, 'every blob of the kept tree is readable');
    assert.equal(blobs[[...map.keys()].indexOf(pkg(0))]!.toString('utf8'), pkgText(0, "'"), 'the pre-freeze bytes');
    assert.equal((await p.core.repo.readBlob(localBlob)).toString('utf8'), LOCAL, 'the blob only snap_pre_freeze references survived gc');
    assert.equal(p.core.view!.keep.get(SNAP_PRE_FREEZE), pre, 'the kept tree is that S_disk');
  });
});

test('while MASS is set nothing applies and no code publishes, and a revert record made at a capture\'s materialization mirrors through a board-only push with the freeze event', T10, async () => {
  await withCores('mass-boardonly', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await setup(fx, p);
    await enterByFormatter(fx, p);
    const team = await fx.pushTeamChange({ 'g.py': buf(`${G0}g_4 = 4\n`) });
    fx.advance(10_000);
    const ap = await applyStep(p.core, await prep(p));
    assert.deepEqual([ap.ran, ap.skipped], [false, 'frozen'], 'nothing applies');
    await writeWork(p, 'f.py', F0);   // a stale save deletes TEAM = 1
    await tick(fx, p);
    fx.advance(20_000);
    const it = await prep(p, true);
    const ids = await revertStep(p.core, it);
    assert.equal(ids.length, 1, 'the capture\'s materialization creates the f.py record');
    await captureReady(p, it);
    const r = await publishStep(p.core, it);
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    assert.equal(r.c, null, 'a board-only push');
    assert.equal(await remoteLive(fx, p), team.live, 'no live commit of this peer');
    const ops = (await readBoardCommit(p.core.repo, r.bnew!)).opsLines.map((l) => parseOpLine(l)!);
    assert.ok(ops.some((o) => o.type === 'event' && o.kind === 'freeze' && o.reason_code === 'MASS'), 'the freeze event');
    assert.ok(ops.some((o) => o.type === 'hold' && o.hold_id === ids[0]), "the record's hold op");
  });
});

test('nothing auto-releases MASS: 720 iterations over 30 virtual minutes keep it set and push no code', { timeout: 30 * 60_000 }, async () => {
  await withCores('mass-720', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await setup(fx, p);
    await enterByFormatter(fx, p);
    const code = await remoteLive(fx, p);
    for (let i = 0; i < 720; i++) {
      fx.advance(2_500);
      const it = await prep(p, p.core.cs.closeDue());
      assert.equal(await breakerTick(p.core, it), null);
      if (it.mat !== null && p.core.cs.closeDue()) await captureReady(p, it);
      await applyStep(p.core, it);
      const r = await publishStep(p.core, it);
      assert.equal(r.c, null, `iteration ${i}: no code`);
      assert.ok(p.core.view!.meta.freeze_reasons.includes('MASS'), `iteration ${i}: MASS kept`);
    }
    assert.ok(p.core.cs.ready().length > 0, 'the formatted change-set was captured and waits');
    assert.equal(await remoteLive(fx, p), code, 'no code pushed');
  });
});

test('mutant M33 lets the same formatter publish the 180 files without a freeze', T10, async () => {
  await withCores('mass-m33', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await setup(fx, p);
    setMutants(p, ['M33']);
    await format(p);
    const { why } = await tick(fx, p);
    assert.equal(why, null, 'breakerTick returns null (its one site)');
    assert.ok(!p.core.view!.meta.freeze_reasons.includes('MASS'));
    fx.advance(20_000);
    const it = await prep(p, true);
    await captureReady(p, it);
    const r = await publishStep(p.core, it);
    assert.equal(r.outcome, 'landed');
    assert.ok(r.c !== null, 'a code push: what the freeze test\'s zero-code-push assertion catches');
    const tree = await treeOf(p, await remoteLive(fx, p));
    assert.equal((await p.core.repo.readBlob(tree.get(pkg(0))!.oid)).toString('utf8'), pkgText(0, '"'), 'the formatted files reached the live chain');
  });
});

test('an 11-file node_modules flood of admitted new files trips MASS with 3 tracked files', T10, async () => {
  const files = { 'README.md': buf('# flood\n'), 'a.txt': buf('a\n'), 'b.txt': buf('b\n') };
  await withCores('mass-flood', { n: 1, files }, async (fx) => {
    const p = fx.peers[0]!;
    assert.equal(p.core.view === null ? 0 : (await p.core.repo.readTreeMap(p.core.view.base)).size, 3);
    for (let i = 0; i < 11; i++) await writeWork(p, `node_modules/x${i}.js`, `module.exports = ${i};\n`);
    const { it, why } = await tick(fx, p);
    assert.equal([...it.tick!.dirty.values()].filter((d) => d.kind === 'new').length, 11, 'admitted new files');
    assert.equal(why, 'window');
    assert.ok(p.core.view!.meta.freeze_reasons.includes('MASS'));
  });
});

test('an unobserved deletion of f.py, which holds the teammate\'s line, trips peer_lines; deleting g.py, whose lines are all pre-genesis, does not', T10, async () => {
  await withCores('mass-peerlines', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await setup(fx, p);
    await unlink(workPath(p, 'g.py'));
    assert.equal((await tick(fx, p)).why, null);
    const second = await tick(fx, p);
    assert.equal(second.it.tick!.dirty.get('g.py')?.kind, 'remove', 'the deletion is confirmed');
    assert.equal(second.why, null, 'no line of another writer in g.py');
    await unlink(workPath(p, 'f.py'));
    assert.equal((await tick(fx, p)).why, null);
    assert.equal((await tick(fx, p)).why, 'peer_lines');
    assert.ok(p.core.view!.meta.freeze_reasons.includes('MASS'));
  });
});

test('05 I7: formatter plus one stale revert — freeze, the record mirrors, resume, then the formatting publishes and the revert stays held', T10, async () => {
  await withCores('mass-i7', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const log = new LogRecorder();
    p.deps.log = log;
    await setup(fx, p);
    await enterByFormatter(fx, p);
    await writeWork(p, 'f.py', F0);
    await tick(fx, p);
    fx.advance(20_000);
    const it = await prep(p, true);
    const [rid] = await revertStep(p.core, it);
    assert.ok(rid !== undefined);
    await captureReady(p, it);
    const board = await publishStep(p.core, it);
    assert.deepEqual([board.outcome, board.c], ['landed', null], 'the record mirrors board-only');
    assert.ok(board.mirrored.includes(rid));
    const codeBefore = await remoteLive(fx, p);

    const report = await resume(p.core);
    assert.deepEqual(report, { nonretryable: false, hostRejectReleased: null, massLifted: true });
    assert.ok(massResumePending(p.core));
    fx.advance(2_500);
    const it2 = await prep(p, true);
    const viewBefore = p.core.view!.commit;
    const residue = await massResumeStep(p.core, it2);
    assert.deepEqual(residue, [rid], 'the f.py hunk attaches to the existing record (HLD-07)');
    assert.equal(p.core.holds.nonTerminal().filter((r) => r.paths.includes('f.py')).length, 1);
    const open = p.core.cs.openPaths();
    assert.equal(open.size, N_FMT + 1, 'the 181 changed LIVE paths form one human CS');
    assert.ok(open.has('f.py') && open.has(pkg(0)));
    assert.ok(!p.core.view!.keep.has(SNAP_PRE_FREEZE), 'snap_pre_freeze leaves the keep set');
    assert.notEqual(p.core.view!.commit, viewBefore, 'in one state update');
    const unfrozen = log.lines.filter((l) => l.code === 'UNFROZEN');
    assert.deepEqual(unfrozen.map((l) => l.params), [{ reason: 'MASS', residue: rid }]);

    const aBefore = p.core.view!.base;
    const fA = (await p.core.repo.readTreeMap(aBefore)).get('f.py')!.oid;
    fx.advance(20_000);
    const it3 = await prep(p, true);
    await revertStep(p.core, it3);
    await captureReady(p, it3);
    const pub = await publishStep(p.core, it3);
    assert.equal(pub.outcome, 'landed', JSON.stringify(pub));
    const tip = await remoteLive(fx, p);
    assert.equal((await p.core.repo.readCommit(tip)).parents[0], codeBefore, 'one live commit');
    const tree = await treeOf(p, tip);
    for (let i = 0; i < N_FMT; i++) assert.equal((await p.core.repo.readBlob(tree.get(pkg(i))!.oid)).toString('utf8'), pkgText(i, '"'), pkg(i));
    assert.equal(tree.get('f.py')!.oid, fA, 'f.py equal to A[f.py]: the revert stays held');
    const rec = p.core.holds.get(rid)!;
    assert.deepEqual([rec.residence, rec.state], ['ON_DISK', 'ACTIVE']);
  });
});

test("a kill after massResumeStep's registry commit and before its state update re-runs the batch after restart with no duplicate record", T10, async () => {
  await withCores('mass-kill', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await setup(fx, p);
    await enterByFormatter(fx, p);
    await writeWork(p, 'f.py', F0);   // the stale revert, never materialized before the resume
    await tick(fx, p);
    await resume(p.core);
    fx.advance(2_500);
    const it = await prep(p, true);
    let hits = 0;
    setCrashHandler((name) => {
      if (name === 'registry.cas' && ++hits === 2) throw new KilledAt(name);
    });
    try {
      await assert.rejects(massResumeStep(p.core, it), (e: unknown) => e instanceof KilledAt);
    } finally {
      setCrashHandler(null);
    }
    await restartCore(p);
    await restart(p.core);
    assert.equal(reverts(p).length, 1, 'the registry commit landed');
    assert.ok(p.core.view!.keep.has(SNAP_PRE_FREEZE), 'snap_pre_freeze is still kept');
    assert.ok(massResumePending(p.core));
    const before = reverts(p);
    fx.advance(2_500);
    const residue = await massResumeStep(p.core, await prep(p, true));
    assert.deepEqual(residue, before, 'massResumeStep runs again and attaches');
    assert.deepEqual(reverts(p), before, 'the record count is unchanged');
    assert.ok(!massResumePending(p.core));
  });
});

test('massResumePending is true from resume until massResumeStep\'s state update, and massResumeStep returns null when nothing is pending', T10, async () => {
  await withCores('mass-pending', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await setup(fx, p);
    assert.equal(massResumePending(p.core), false);
    assert.equal(await massResumeStep(p.core, await prep(p, true)), null, 'nothing pending');
    await enterByFormatter(fx, p);
    assert.equal(massResumePending(p.core), false, 'MASS is set: not pending');
    assert.equal(await massResumeStep(p.core, await prep(p, true)), null);
    await resume(p.core);
    assert.equal(massResumePending(p.core), true, 'from resume');
    assert.equal(await massResumeStep(p.core, await prep(p)), null, 'only on a materializing iteration');
    assert.equal(massResumePending(p.core), true);
    assert.deepEqual(await massResumeStep(p.core, await prep(p, true)), []);
    assert.equal(massResumePending(p.core), false, 'until its state update');
    assert.equal(await massResumeStep(p.core, await prep(p, true)), null);
  });
});

test('breakerTick observes nothing while MASS is set or the post-resume batch is pending, so the formatted paths never re-trip MASS after resume', T10, async () => {
  await withCores('mass-silent', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await setup(fx, p);
    await enterByFormatter(fx, p);
    const frozen = countCalls(p.core.breaker, 'observe');
    await writeWork(p, 'g.py', `${G0}g_9 = 9\n`);
    assert.equal((await tick(fx, p)).why, null);
    assert.equal(frozen.n, 0, 'nothing observed while MASS is set');
    frozen.restore();
    await resume(p.core);
    // A restart between resume and the batch: a fresh breaker, and the formatted paths are a tick's changes again.
    await restartCore(p);
    await restart(p.core);
    const pending = countCalls(p.core.breaker, 'observe');
    const first = await tick(fx, p);
    assert.ok(first.it.tick!.changed.size >= N_FMT, `the formatted paths are changes of the first tick (${first.it.tick!.changed.size})`);
    assert.equal(first.why, null);
    assert.equal(pending.n, 0, 'nothing observed while the batch is pending');
    assert.ok(!p.core.view!.meta.freeze_reasons.includes('MASS'), 'MASS is not re-entered');
    pending.restore();
    assert.ok((await massResumeStep(p.core, await prep(p, true))) !== null);
    for (let i = 0; i < 3; i++) assert.equal((await tick(fx, p)).why, null);
    assert.ok(!p.core.view!.meta.freeze_reasons.includes('MASS'));
  });
});

