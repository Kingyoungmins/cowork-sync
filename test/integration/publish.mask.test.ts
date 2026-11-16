// Publish with the asynchronous MASK (Plan 3 Task 2; 05-holds HLD-15, HLD-19, §6 "Registry blob corrupt", 05 F1; ENG-41 (i);
// CS-19, D8; rulings R3-19, R3-20, R3-57, R3-76; Plan 2 Task 14 decision 4) on EngineCores over real clones of a file:// remote:
// the governor window is checked before MASK runs, step-5 conflicts become CONFLICTED in one registry commit, never abort the window
// and (final review F9) are recomposed — MASK step 4 then withholds the record's paths whole and HLD-42 pins their groups —, an
// assertP failure drops the code part and keeps the board-only ops (HOLD_MASK_INVALID), a corrupt record blob pushes
// nothing, MASK's base is A[p] and its `mergeable` is the engine's attribute binding, and heldPathInP keeps Plan 2's letter split
// under publishStep's own `masked`. Notation: test/helpers/maskFixture.ts (T9, T9{2:two}).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readBoardCommit, readHeld } from '../../src/board/boardCommit.js';
import type { OpDraft } from '../../src/board/ops.js';
import { applyStep } from '../../src/engine/apply.js';
import { captureStep } from '../../src/engine/csStep.js';
import { maskStep, recordStep } from '../../src/engine/holdSteps.js';
import { publishPending, publishStep } from '../../src/engine/publish.js';
import { parseOid, type Oid } from '../../src/git/oid.js';
import { guardName, type HoldBlobs } from '../../src/holds/record.js';
import { gitCallsOf, readWork, workPath, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { T9, t9 } from '../helpers/maskFixture.js';
import { mergeSides } from '../helpers/mergeFileArgs.js';
import {
  blobText, buf, editAndCapture, LogRecorder, prep, pushCalls, remoteBoard, remoteCode, setMutants, stateA, stubCompose, treeOf, withCores,
} from '../helpers/publishHelpers.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const P = 'src/t9.txt';
const Q = 'src/t9b.txt';
const O = 'src/o.txt';
const O_EDIT = 'o1\no2 local\no3\n';
const FILES: Record<string, Buffer> = {
  'README.md': buf('# publish-mask fixture\n'),
  [P]: buf(T9),
  [Q]: buf(T9),
  [O]: buf('o1\no2\no3\n'),
  'src/x.ts': buf('export const x = 1;\n'),
  '.claude/settings.json': buf('{"a":1}\n'),
};
/** A pending op allowed in the ok state (a health event would be dropped in normal mode, P2-R18). */
const freezeEvent = (): OpDraft => ({ type: 'event', cid: '', kind: 'freeze', refs: [], reason_code: 'FREEZE_EPOCH' });

/** Advances past the governor window (a fetch that saw a new tip re-anchors it) and prepares the next iteration. */
async function windowOpen(fx: CoreFixture, p: PeerFixture): Promise<Awaited<ReturnType<typeof prep>>> {
  await prep(p);
  fx.advance(6_000);
  return prep(p);
}

/** An ON_DISK ACTIVE PATCH over the paths of `held` (h0 = A[p], h1 = held[p]) with `guard`; the registry computes local_only. */
async function revert(p: PeerFixture, held: Readonly<Record<string, string>>, guard = 'revert'): Promise<{ id: string; h1: Record<string, Oid> }> {
  const A = await stateA(p);
  const h0: Record<string, Oid> = {};
  const h1: Record<string, Oid> = {};
  for (const [path, text] of Object.entries(held)) {
    h0[path] = A.get(path)!.oid;
    h1[path] = await p.core.repo.hashBytes(buf(text), true);
  }
  const blobs: HoldBlobs = { h0, h1 };
  const id = await p.core.holds.hold({
    kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: Object.keys(held), blobs, guard, origin: 'human', cs_ids: [], displaced_by: null,
  });
  return { id, h1 };
}

/** The number of commits the registry ref gained since `from`. */
function registryCommitsSince(p: PeerFixture, from: Oid | null): number {
  const to = p.core.holds.head();
  if (to === null || to === from) return 0;
  const r = spawnSync('git', ['--git-dir', p.deps.paths.gitDir, 'rev-list', '--count', from === null ? to : `${from}..${to}`], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return Number(r.stdout.trim());
}

/** Counts composeP calls (publishStep's compose is the only caller in these tests). */
function countCompose(p: PeerFixture): { n: number } {
  const counter = { n: 0 };
  const cs = p.core.cs;
  const orig = cs.composeP.bind(cs);
  cs.composeP = async (repo, A, mask, pinned) => {
    counter.n += 1;
    return orig(repo, A, mask, pinned);
  };
  return counter;
}

test('the window is checked before MASK runs: with the window closed nothing is composed and no registry commit happens', T10, async () => {
  await withCores('pubmask-window', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prep(p);
    // r holds line 2 (`two`, on disk); the human's CS edits line 3 (adjacent: a step-5 conflict MASK would report) and src/o.txt.
    await writeWork(p, P, t9([2, 'two']));
    const { id } = await revert(p, { [P]: t9([2, 'two']) });
    await editAndCapture(fx, p, { [P]: t9([2, 'two'], [3, 'three']), [O]: O_EDIT });
    const composed = countCompose(p);
    const head = p.core.holds.head();
    const it = await windowOpen(fx, p);
    // A fetch that observes a new tip re-anchors the governor and closes the window (publish.gates.test.ts does the same).
    p.core.governor.onFetch(parseOid('1'.repeat(40)), 1, false, true);
    const calls = gitCallsOf(p).length;
    const closed = await publishStep(p.core, it);
    assert.deepEqual([closed.attempted, closed.outcome, closed.why], [false, 'skipped', 'window'], JSON.stringify(closed));
    assert.equal(composed.n, 0, 'compose never runs outside a window');
    assert.deepEqual(gitCallsOf(p).slice(calls).map((c) => c.args[0]).filter((c) => c === 'merge-file' || c === 'hash-object'), [], 'no merge-file, no object');
    assert.equal(p.core.holds.head(), head, 'no registry commit');
    assert.equal(p.core.holds.get(id)!.state, 'ACTIVE');
    assert.equal(p.core.holdCode, null);
    // In the next open window the same publish composes, commits r CONFLICTED and recomposes (final review F9): the group waits in a
    // dependency PIN (HLD-42) and only the board ops land.
    const open = await publishStep(p.core, await windowOpen(fx, p));
    assert.equal(open.outcome, 'landed', JSON.stringify(open));
    assert.equal(open.c, null, 'no live commit: src/o.txt waits with the conflicted path');
    assert.equal(composed.n, 3, 'conflict → recompose: pin → recompose: held');
    assert.equal(p.core.holds.get(id)!.state, 'CONFLICTED');
    assert.equal(open.dependencyPins.length, 1);
    assert.equal(registryCommitsSince(p, head), 2, 'the CONFLICTED commit, then the PIN');
  });
});

test('MASK conflicts at publish become CONFLICTED in one registry commit', T10, async () => {
  await withCores('pubmask-conflict', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prep(p);
    // r1 and r2 each hold line 2 (`two`, on disk) of their path; the human's CS edits line 3 of both (adjacent: both reverse merges
    // conflict) and src/o.txt.
    await writeWork(p, P, t9([2, 'two']));
    await writeWork(p, Q, t9([2, 'two']));
    const r1 = await revert(p, { [P]: t9([2, 'two']) });
    const r2 = await revert(p, { [Q]: t9([2, 'two']) });
    await editAndCapture(fx, p, { [P]: t9([2, 'two'], [3, 'three']), [Q]: t9([2, 'two'], [3, 'three']), [O]: O_EDIT });
    const head = p.core.holds.head();
    const code0 = await remoteCode(fx, p);
    const it = await windowOpen(fx, p);
    const r = await publishStep(p.core, it);
    assert.notEqual(r.outcome, 'aborted', JSON.stringify(r));
    assert.equal(r.maskInvalid, false);
    for (const { id } of [r1, r2]) {
      assert.equal(p.core.holds.get(id)!.state, 'CONFLICTED', id);
      assert.equal(p.core.holds.get(id)!.residence, 'ON_DISK', id);
      assert.equal(p.core.holds.get(id)!.rev, 2, `${id}: one CONFLICTED rev`);
    }
    // Final review F9: the recomposition pins the group — one dependency PIN naming both records (HLD-07 attaches the second).
    assert.equal(r.dependencyPins.length, 1);
    const pin = p.core.holds.get(r.dependencyPins[0]!)!;
    assert.deepEqual(pin.guards.map((g) => g.name).sort(), [`dependency:${r1.id}`, `dependency:${r2.id}`].sort());
    assert.deepEqual(pin.paths, [O, P, Q]);
    assert.equal(registryCommitsSince(p, head), 3, 'both records in one registry commit, then the PIN and its second guard');
    assert.equal(r.c, null, 'the CS\'s other path waits with the conflicted paths (HLD-42)');
    assert.equal(await remoteCode(fx, p), code0);
  });
});

test('a step-5 conflict on one path of a two-path record never aborts the window (R3-76); the record becomes CONFLICTED and the recomposition withholds both of its paths whole and pins the group (HLD-15, HLD-42; final review F9)', T10, async () => {
  await withCores('pubmask-r376', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const log = new LogRecorder();
    p.deps.log = log;
    await prep(p);
    // One record r holds line 2 (`two`, on disk) of P and of Q. The CS edits P two lines away (step 5 removes only the held line)
    // and Q next to the held line (Q's reverse merge conflicts), plus src/o.txt.
    await writeWork(p, P, t9([2, 'two']));
    await writeWork(p, Q, t9([2, 'two']));
    const { id } = await revert(p, { [P]: t9([2, 'two']), [Q]: t9([2, 'two']) });
    assert.deepEqual(p.core.holds.get(id)!.paths, [P, Q]);
    const { pair } = await editAndCapture(fx, p, { [P]: t9([2, 'two'], [6, 'six']), [Q]: t9([2, 'two'], [3, 'three']), [O]: O_EDIT });
    const code0 = await remoteCode(fx, p);
    const r = await publishStep(p.core, await windowOpen(fx, p));
    assert.notEqual(r.outcome, 'aborted', JSON.stringify(r));
    assert.deepEqual([r.why, r.maskInvalid, r.c], [null, false, null], JSON.stringify(r));
    assert.ok(!log.lines.some((l) => l.code === 'NOT_CONVERGED'), log.text());
    assert.equal(p.core.holds.get(id)!.state, 'CONFLICTED', 'the record is reported and transitioned (HLD-15)');
    assert.equal(r.dependencyPins.length, 1);
    const pin = p.core.holds.get(r.dependencyPins[0]!)!;
    assert.deepEqual([pin.guards.map((g) => g.name), pin.paths, pin.cs_ids], [[`dependency:${id}`], [O, P, Q], [pair.csId]]);
    assert.equal(await remoteCode(fx, p), code0, 'nothing of the group publishes while the record is CONFLICTED');
    assert.deepEqual(p.core.view!.ready.map((x) => x.csId), [pair.csId], 'the pair stays journaled');
  });
});

test('final review F9 (HLD-15, HLD-42, INV-HLD-ATOMIC-PUB): a step-5 conflict first seen by publishStep\'s compose (its capture ran in an out-of-cycle iteration, no recordStep) pins the group dependency:<id> in the same window: src/o.txt never publishes without the conflicted path, the pair stays journaled and the PIN holds the untainted line-3 edit', T10, async () => {
  await withCores('pubmask-f9', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prep(p);
    // r holds line 2 (`two`, on disk); the human then edits line 3 (adjacent: r's reverse merge conflicts) and src/o.txt.
    await writeWork(p, P, t9([2, 'two']));
    const { id } = await revert(p, { [P]: t9([2, 'two']) });
    await writeWork(p, P, t9([2, 'two'], [3, 'three']));
    await writeWork(p, O, O_EDIT);
    await prep(p);
    fx.advance(20_000);
    // The capture runs in an out-of-cycle iteration (loop.ts: maskStep, captureStep, then the `oneShot || owed` exit — no applyStep,
    // no recordStep), so maskStep's conflicted ids die with that iteration and r stays ACTIVE.
    const it1 = await prep(p, true);
    await maskStep(p.core, it1);
    const cap = await captureStep(p.core, it1);
    assert.equal(cap.captured.length, 1);
    const csId = cap.captured[0]!;
    assert.equal(p.core.holds.get(id)!.state, 'ACTIVE');
    // The next loop iteration materializes nothing (no capture due, nothing to apply): publishStep's compose sees the conflict first.
    const it2 = await windowOpen(fx, p);
    assert.equal(it2.mat, null);
    await maskStep(p.core, it2);
    await recordStep(p.core, it2, await applyStep(p.core, it2));
    assert.equal(p.core.holds.get(id)!.state, 'ACTIVE', 'no recordStep saw the conflict');
    const code0 = await remoteCode(fx, p);
    const head = p.core.holds.head();
    const composed = countCompose(p);
    const r = await publishStep(p.core, it2);
    assert.notEqual(r.outcome, 'aborted', JSON.stringify(r));
    assert.equal(r.c, null, `nothing of the group publishes: ${JSON.stringify(r)}`);
    assert.equal(await remoteCode(fx, p), code0, 'the live chain is unchanged');
    assert.equal(p.core.holds.get(id)!.state, 'CONFLICTED', 'HLD-15');
    const pins = p.core.holds.nonTerminal().filter((x) => x.kind === 'PIN' && x.guards.some((g) => guardName(g) === 'dependency'));
    assert.equal(pins.length, 1);
    const pin = pins[0]!;
    assert.deepEqual(r.dependencyPins, [pin.id]);
    assert.deepEqual([pin.guards.map((g) => g.name), pin.paths, pin.cs_ids], [[`dependency:${id}`], [O, P], [csId]]);
    assert.ok('h1' in pin.blobs);
    assert.equal((await p.core.repo.readBlob(pin.blobs.h1[P] as Oid)).toString('utf8'), t9([2, 'two'], [3, 'three']), 'the PIN holds the untainted line-3 edit (H1 = R)');
    assert.deepEqual(p.core.view!.ready.map((x) => x.csId), [csId], 'the pair stays journaled');
    assert.equal(registryCommitsSince(p, head), 2, 'the CONFLICTED commit, then the PIN');
    assert.equal(composed.n, 3, 'conflict → recompose: pin → recompose: held');
    // Later windows: the group stays held while r is CONFLICTED.
    const later = await publishStep(p.core, await windowOpen(fx, p));
    assert.equal(later.c, null, JSON.stringify(later));
    assert.equal(await remoteCode(fx, p), code0);
  });
});

test('an assertP failure drops the code part and keeps board-only ops', T10, async () => {
  await withCores('pubmask-assertp', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const log = new LogRecorder();
    p.deps.log = log;
    await prep(p);
    // r holds `two` on line 2 of src/t9.txt (on disk).
    await writeWork(p, P, t9([2, 'two']));
    const { id, h1 } = await revert(p, { [P]: t9([2, 'two']) });
    // A teammate inserted three lines above line 1; the apply merges it under the local `two` (now row 5).
    const teamText = `n1\nn2\nn3\n${T9}`;
    await fx.pushTeamChange({ [P]: buf(teamText) });
    fx.advance(10_000);
    const applied = await applyStep(p.core, await prep(p, 'auto'));
    assert.equal(applied.ran, true, String(applied.skipped));
    const withTwo = `n1\nn2\nn3\n${t9([2, 'two'])}`;
    assert.equal((await readWork(p, P))!.toString('utf8'), withTwo);
    assert.equal(await blobText(p, await stateA(p), P), teamText, 'A follows TIP');
    // The human's CS edits row 11 (T9's line 8); the ready pair carries `two` on row 5.
    const rows = withTwo.split('\n');
    rows[10] = 'eight edited';
    await editAndCapture(fx, p, { [P]: rows.join('\n') });
    p.core.outbox.add(freezeEvent());
    const codeBefore = await remoteCode(fx, p);
    const boardBefore = await remoteBoard(fx, p);
    setMutants(p, ['M28']);   // MASK step 5 as a positional withdrawal: `two` stays in P
    const it = await windowOpen(fx, p);
    const r = await publishStep(p.core, it);
    assert.equal(r.maskInvalid, true, JSON.stringify(r));
    assert.equal(r.outcome, 'landed', 'the board-only part lands');
    assert.equal(r.c, null, 'no live commit');
    assert.equal(await remoteCode(fx, p), codeBefore);
    assert.notEqual(await remoteBoard(fx, p), boardBefore);
    const b = await readBoardCommit(p.core.repo, r.bnew!);
    assert.equal(b.liveCode, it.tip, 'board-only: the live code is TIP');
    // Plan 3 Task 4: the board-only part carries the event op and r's creation `hold` op (its held/<r>/ mirror), no live commit.
    const ops = b.opsLines.map((l) => JSON.parse(l) as { type: string; kind?: string; hold_id?: string; prev_rev?: number | null });
    assert.deepEqual(ops.map((o) => (o.type === 'hold' ? ['hold', o.hold_id, o.prev_rev] : [o.type, o.kind])), [['event', 'freeze'], ['hold', id, null]]);
    assert.deepEqual((await readHeld(p.core.repo, r.bnew!, id))?.filter((e) => e.stage === 'h1'), [{ stage: 'h1', path: P, oid: h1[P]! }]);
    assert.equal(p.core.holdCode?.code, 'HOLD_MASK_INVALID');
    // The failing clause is assertP's held-range clause on the M28 path (CS-19, D8), not another clause or a MASK operator error.
    const invalid = log.lines.filter((l) => l.code === 'HOLD_MASK_INVALID');
    assert.deepEqual(invalid.map((l) => l.params), [{ clause: 'p_range', path: P }], log.text());
    assert.deepEqual(p.core.holdCode?.params, { clause: 'p_range', path: P });
    assert.equal(p.core.view!.ready.length, 1, 'the ready pair waits for the next window (R3-57)');
    // No object of the live chain on the remote (its code ref) holds S_disk[p]'s held line: the board carries it only as r's
    // held/<r>/h1 mirror above (HLD-04; Task 4), never in live code.
    const objs = spawnSync('git', ['--git-dir', fx.remote.dir, 'rev-list', '--objects', p.core.refs.remoteCode], { encoding: 'utf8' });
    assert.equal(objs.status, 0, objs.stderr);
    const blobs = objs.stdout.split('\n').filter((l) => l.length > 0).map((l) => l.split(' ')[0]!);
    for (const o of blobs) {
      const t = spawnSync('git', ['--git-dir', fx.remote.dir, 'cat-file', '-t', o], { encoding: 'utf8' }).stdout.trim();
      if (t !== 'blob') continue;
      const content = spawnSync('git', ['--git-dir', fx.remote.dir, 'cat-file', 'blob', o], { encoding: 'latin1' }).stdout;
      assert.ok(!content.split('\n').includes('two'), `blob ${o} holds the held line`);
    }
    // Without the mutant the next window publishes the unheld edit.
    setMutants(p, []);
    fx.advance(6_000);
    const ok = await publishStep(p.core, await prep(p));
    assert.equal(ok.outcome, 'landed', JSON.stringify(ok));
    assert.equal(ok.maskInvalid, false);
    assert.equal(await blobText(p, await treeOf(p, ok.c!), P), `n1\nn2\nn3\n${t9([8, 'eight edited'])}`);
  });
});

test('05 F1: a corrupt registry blob means no push and S_disk never pushed', T10, async () => {
  await withCores('pubmask-f1', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const log = new LogRecorder();
    p.deps.log = log;
    await prep(p);
    const heldText = t9([2, 'only in this test: corrupt me']);
    await writeWork(p, P, heldText);
    const { h1 } = await revert(p, { [P]: heldText });
    await editAndCapture(fx, p, { [P]: t9([2, 'only in this test: corrupt me'], [6, 'six']) });
    assert.equal(p.core.outbox.size, 0, 'nothing in the outbox');
    const dir = join(p.deps.paths.gitDir, 'objects', h1[P]!.slice(0, 2));
    assert.ok(readdirSync(dir).includes(h1[P]!.slice(2)), 'the record blob is loose');
    const file = join(dir, h1[P]!.slice(2));
    chmodSync(file, 0o644);
    writeFileSync(file, Buffer.from('this is not a zlib stream', 'utf8'));
    const refsBefore = await fx.remote.refs();
    const pushesBefore = pushCalls(p);
    const it = await windowOpen(fx, p);
    // PRO-42's predicate: a MASK that cannot run reads as pending (the publish then raises HOLD_MASK_INVALID), never as a throw.
    assert.equal(await publishPending(p.core, it), true, 'a HoldOperatorError in compose is pending work');
    const r = await publishStep(p.core, it);
    assert.equal(r.maskInvalid, true, JSON.stringify(r));
    assert.equal(r.attempted, false);
    assert.equal(pushCalls(p), pushesBefore, 'zero push attempts');
    assert.equal(p.core.holdCode?.code, 'HOLD_MASK_INVALID');
    assert.ok(log.lines.some((l) => l.code === 'HOLD_MASK_INVALID'), log.text());
    assert.deepEqual(await fx.remote.refs(), refsBefore, 'the remote\'s refs are unchanged');
  });
});

test('MASK\'s base is A[p], never tree(LA_C)[p], through the engine binding', T10, async () => {
  await withCores('pubmask-base', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prep(p);
    // A pending path (as rebase.test.ts builds it): the team's T9{3:three} is applied while a share-read holder refuses the rename
    // (deferred 'locked'), so LA_C := TIP while A[p] stays T9 (ENG-36).
    await fx.pushTeamChange({ [P]: buf(t9([3, 'three'])) });
    const release = p.fs.holdLock(workPath(p, P), 'share-read');
    fx.advance(10_000);
    const applied = await applyStep(p.core, await prep(p, 'auto'));
    release();
    assert.equal(applied.deferred.get(P), 'locked');
    const a = (await stateA(p)).get(P)!.oid;
    const three = await p.core.repo.hashBytes(buf(t9([3, 'three'])), true);
    assert.equal(await blobText(p, await stateA(p), P), T9, 'A[p] = T9');
    assert.equal((await treeOf(p, p.core.view!.laC)).get(P)?.oid, three, 'tree(LA_C)[p] = T9{3:three}');
    // r holds `two` on line 2 (on disk). At A[p] its REBASE is (T9, T9{2:two}) and the reverse merge is clean; at tree(LA_C)[p] the
    // REBASE would conflict (lines 2 and 3 are adjacent) and r would become CONFLICTED.
    await writeWork(p, P, t9([2, 'two']));
    const { id, h1 } = await revert(p, { [P]: t9([2, 'two']) });
    await editAndCapture(fx, p, { [O]: O_EDIT });
    const head = p.core.holds.head();
    const calls = gitCallsOf(p).length;
    const r = await publishStep(p.core, await windowOpen(fx, p));
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    assert.equal(p.core.holds.get(id)!.state, 'ACTIVE', 'no MASK conflict: MASK ran at A[p]');
    assert.equal(registryCommitsSince(p, head), 0, 'no CONFLICTED commit');
    const merges = gitCallsOf(p).slice(calls).filter((c) => c.args[0] === 'merge-file');
    assert.ok(merges.some((m) => { const s = mergeSides(m.args); return s[1] === h1[P] && s[2] === a; }), 'step 5 on p: mf(x, H1\'[p], H0\'[p] = A[p])');
    assert.ok(!merges.some((m) => m.args.includes(three)), 'tree(LA_C)[p] never reaches merge-file');
    assert.equal(await blobText(p, await treeOf(p, r.c!), O), O_EDIT);
  });
});

test('ENG-41 (i) keeps meaning withheld whole by a record', T10, async () => {
  await withCores('pubmask-eng41i', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const log = new LogRecorder();
    p.deps.log = log;
    await prep(p);
    // r holds line 2 of P, r2 line 2 of Q (both on disk). One CS edits Q next to its held line (a step-5 conflict: Q is withheld
    // whole by its record), a later one edits P two lines away (a step-5 partial path): two publication groups, since a conflict
    // pins its own group (HLD-42; final review F9) and P's partial path must be composed in a group of its own.
    await writeWork(p, Q, t9([2, 'two']));
    const r2 = await revert(p, { [Q]: t9([2, 'two']) });
    const q = await editAndCapture(fx, p, { [Q]: t9([2, 'two'], [3, 'three']) });
    await writeWork(p, P, t9([2, 'two']));
    await revert(p, { [P]: t9([2, 'two']) });
    const pp = await editAndCapture(fx, p, { [P]: t9([2, 'two'], [6, 'six']) });
    assert.deepEqual([q.pair.paths, pp.pair.paths], [[Q], [P]], 'two CSs, two groups');
    const RQ = await p.core.repo.readTreeMap(q.pair.R);
    const RP = await p.core.repo.readTreeMap(pp.pair.R);
    // 1. Q's step-5 conflict makes r2 CONFLICTED (HLD-15) and the recomposition pins Q's group (dependency:<r2>); P planted with its
    //    held line in the composition that follows: (i) passes (P is not withheld whole, MASK changed it partly) and assertP's
    //    p_range drops the code part.
    let restore = stubCompose(p, false, (Pm) => Pm.set(P, RP.get(P)!));
    const range = await publishStep(p.core, await windowOpen(fx, p));
    restore();
    assert.notEqual(range.why, 'publish_assert:i', JSON.stringify(range));
    assert.equal(range.maskInvalid, true, JSON.stringify(range));
    assert.deepEqual(log.lines.filter((l) => l.code === 'HOLD_MASK_INVALID').map((l) => l.params), [{ clause: 'p_range', path: P }], log.text());
    assert.equal(p.core.holds.get(r2.id)!.state, 'CONFLICTED');
    assert.equal(range.dependencyPins.length, 1);
    const pin = p.core.holds.get(range.dependencyPins[0]!)!;
    assert.deepEqual([pin.guards.map((g) => g.name), pin.paths], [[`dependency:${r2.id}`], [Q]]);
    // 2. Q planted back into P while its record is CONFLICTED (MASK step 4) and its group held: publishStep's compose().masked says
    //    (i), on Q only.
    restore = stubCompose(p, false, (Pm) => Pm.set(Q, RQ.get(Q)!));
    const i = await publishStep(p.core, await windowOpen(fx, p));
    restore();
    assert.deepEqual([i.outcome, i.why], ['aborted', 'publish_assert:i'], JSON.stringify(i));
    assert.deepEqual(log.lines.filter((l) => l.code === 'NOT_CONVERGED').map((l) => [l.params['check'], l.params['path']]), [['i', Q]], log.text());
    // 3. Unstubbed: Q's group waits in its dependency PIN while r2 stays CONFLICTED (HLD-42); P's group publishes its unheld edit.
    const held = await publishStep(p.core, await windowOpen(fx, p));
    assert.equal(held.outcome, 'landed', JSON.stringify(held));
    const out = await treeOf(p, held.c!);
    assert.equal(await blobText(p, out, P), t9([6, 'six']), 'P publishes without its held line');
    assert.equal(await blobText(p, out, Q), T9, 'Q stays A[q]');
  });
});

test('the engine binds MASK\'s mergeable to text and unfiltered at EPOCH_BASE: a -text step-5 path is withheld whole, never merged (R3-18)', T10, async () => {
  const RAW = 'src/raw.txt';
  await withCores('pubmask-mergeable', { n: 1, files: { ...FILES, '.gitattributes': buf(`${RAW} -text\n`), [RAW]: buf(T9) } }, async (fx) => {
    const p = fx.peers[0]!;
    await prep(p);
    // r holds line 2 of a text-content path whose EPOCH_BASE attributes say -text; the CS edits it two lines away and src/o.txt.
    await writeWork(p, RAW, t9([2, 'two']));
    const { id, h1 } = await revert(p, { [RAW]: t9([2, 'two']) });
    const { pair } = await editAndCapture(fx, p, { [RAW]: t9([2, 'two'], [6, 'six']), [O]: O_EDIT });
    const x = (await p.core.repo.readTreeMap(pair.R)).get(RAW)!.oid;
    const a = (await stateA(p)).get(RAW)!.oid;
    const calls = gitCallsOf(p).length;
    const r = await publishStep(p.core, await windowOpen(fx, p));
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    const out = await treeOf(p, r.c!);
    assert.equal(out.get(RAW)?.oid, a, 'withheld whole: the unheld line-6 edit does not publish either');
    assert.equal(await blobText(p, out, O), O_EDIT);
    const named = new Set<string>([a, h1[RAW]!, x]);
    assert.ok(!gitCallsOf(p).slice(calls).some((c) => c.args[0] === 'merge-file' && c.args.some((v) => named.has(v))), 'no merge-file names its oids');
    assert.equal(p.core.holds.get(id)!.state, 'ACTIVE');
  });
});

test('heldPathInP keeps Plan 2\'s letter split under the Plan 3 binding of masked', T10, async () => {
  const S = '.claude/settings.json';
  await withCores('pubmask-letters', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await editAndCapture(fx, p, { [O]: O_EDIT });
    // A quarantined path that differs from A in P (MASK step 1 lists it in `withheld`): INV-MASK, not (i).
    const cfg = await p.core.repo.hashBytes(buf('{"a":2}\n'), true);
    stubCompose(p, false, (Pm) => Pm.set(S, { path: S, mode: '100644', oid: cfg }));
    const q = await publishStep(p.core, await windowOpen(fx, p));
    assert.deepEqual([q.outcome, q.why], ['aborted', 'publish_assert:INV-MASK']);
    // The path of an ON_DISK `join` PIN that differs from A in P: (i).
    const A = await stateA(p);
    await p.core.holds.hold({
      kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths: ['src/x.ts'],
      blobs: { h0: { 'src/x.ts': A.get('src/x.ts')!.oid }, h1: { 'src/x.ts': await p.core.repo.hashBytes(buf('export const x = 2;\n'), true) } },
      guard: 'join', origin: 'human', cs_ids: [], displaced_by: null,
    });
    const x2 = await p.core.repo.hashBytes(buf('export const x = 3;\n'), true);
    stubCompose(p, true, (Pm) => Pm.set('src/x.ts', { path: 'src/x.ts', mode: '100644', oid: x2 }));
    const i = await publishStep(p.core, await windowOpen(fx, p));
    assert.deepEqual([i.outcome, i.why], ['aborted', 'publish_assert:i']);
    assert.equal(pushCalls(p), 0);
  });
});

// R3-72's third placeholder, "the loop's step-4 S_pub uses the async MASK", is dropped (F1 audit fix #27, ruling in the F1 G4 report):
// Plan 3 Task 12a built that call site (Engine.sPubHolds awaits maskStep, holdSteps.ts maskStep awaits maskEntries and runs
// assertSPub) and test/integration/loop.holds.test.ts proves it through the loop — "maskStep runs only on materializing iterations
// and S_pub stays the MASK of the last materialized S_disk", "ENG-28 / R3-20: … assertSPub fails: HOLD_MASK_INVALID" and "a MASK
// conflict makes the record CONFLICTED" (the ledger's :147 carry).
