// RESTORE (Plan 3 Task 5; 05-holds §3.4 item 4, HLD-17, Table 4 `--restore` operator half; 03-data §3.9 Restore cases 1–4,
// DAT-45; 05 I13; HLD-26 (b); rulings R3-16, R3-18, R3-23): D is the clean blob of the disk now (the iteration's staged-copy
// materialization); `merge-file -p --diff3 --object-id -L cowork:disk -L cowork:base -L cowork:held D b held`; rc 0 → canon of the
// result, rc > 0 or a marker row → the result as merged plus guard `markers`; binary by the whole-path rule and human only;
// deletions and recreations by cases 2–3; ON_DISK with the displacement guard released; recorded as an observed write.
// Notation (Task 1 notes): T9 is "1\n…9\n" at src/t9.txt; T9{2:two} replaces line 2. Real git on file:// clones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyStep } from '../../src/engine/apply.js';
import { evaluateRecords, restore } from '../../src/engine/holdOps.js';
import { recordStep } from '../../src/engine/holdSteps.js';
import { publishStep } from '../../src/engine/publish.js';
import { hasRestoreMarkerRow } from '../../src/data/rows.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import { maskEntries } from '../../src/holds/mask.js';
import { RebaseCache } from '../../src/holds/rebase.js';
import { guardName, isTerminal } from '../../src/holds/record.js';
import { readWork, workPath, writeWork, type PeerFixture } from '../helpers/coreFixture.js';
import { blob, callsDuring, nr, P, pair, prepIt, recordLog, stages, withPeers } from '../helpers/holdOpsFixture.js';
import { binary, T9, t9 } from '../helpers/maskFixture.js';
import { mergeSides } from '../helpers/mergeFileArgs.js';
import { buf, captureReady, prep, remoteLiveCode, stateA, treeOf } from '../helpers/publishHelpers.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const HUMAN = { humanEvidence: true, actor: 'human' } as const;
const OTHER = 'src/other.txt';

/** A = T9{8:eight} through a teammate's change applied here (s3 = A, disk = A). */
async function teamEight(fx: Parameters<Parameters<typeof withPeers>[2]>[0], p: PeerFixture): Promise<void> {
  await fx.pushTeamChange({ [P]: buf(t9([8, 'eight'])) });
  fx.advance(10_000);
  const r = await applyStep(p.core, await prepIt(p, { forceFetch: true }));
  assert.ok(r.written.includes(P), JSON.stringify(r));
}

/** A K4 record OFF_DISK CONFLICTED [conflict] with s1 = T9, s2 = T9{2:two}, s3 = A. */
async function k4(p: PeerFixture): Promise<string> {
  return p.core.holds.hold(nr({
    residence: 'OFF_DISK', state: 'CONFLICTED', guard: 'conflict', origin: 'daemon',
    blobs: stages(await blob(p, T9), await blob(p, t9([2, 'two'])), await blob(p, t9([8, 'eight']))),
  }));
}

test('a clean text RESTORE writes the merge and releases the displacement guard', T10, async () => {
  await withPeers('restore-clean', {}, async (fx) => {
    const p = fx.peers[0]!;
    await teamEight(fx, p);
    const id = await k4(p);
    fx.advance(2_500);
    const it = await prepIt(p, { holdPaths: [P] });
    const log = recordLog(p);
    const { calls, result } = await callsDuring(p, () => restore(p.core, it, id, HUMAN));
    assert.deepEqual(result, { kind: 'RESTORED', markers: false });
    const mf = calls.filter((c) => c.args[0] === 'merge-file');
    assert.equal(mf.length, 1);
    for (const a of ['-p', '--diff3']) assert.ok(mf[0]!.args.includes(a), a);
    // Ruling G1-FILEFORM: merge-file runs over scratch copies of D, b and held (named by their oids), never with --object-id.
    assert.deepEqual(mergeSides(mf[0]!.args), [it.mat!.sRawMap.get(P)!.oid, await blob(p, T9), await blob(p, t9([2, 'two']))], 'D, b, held');
    assert.deepEqual(mf[0]!.args.filter((_, i, all) => all[i - 1] === '-L'), ['cowork:disk', 'cowork:base', 'cowork:held']);
    const merged = t9([2, 'two'], [8, 'eight']);
    assert.deepEqual(await readWork(p, P), Buffer.from(merged));
    const r = p.core.holds.get(id)!;
    assert.deepEqual([r.residence, r.state, r.guards.length], ['ON_DISK', 'ACTIVE', 0], 'ON_DISK ACTIVE, the displacement guard released');
    assert.ok(p.core.holds.local().explicit.includes(id), 'local().explicit has r');
    assert.equal(p.core.observed.consume(P, await blob(p, merged)), true, 'an observed write (HLD-26 (b))');
    assert.deepEqual(log.lines.find((l) => l.code === 'HOLD_RESTORED')?.params, { hid: id, path: P });
    assert.deepEqual(p.core.holds.local().inflight, {});
  });
});

test('a conflicted text RESTORE writes cowork: markers and adds markers', T10, async () => {
  await withPeers('restore-conflicted', {}, async (fx) => {
    const p = fx.peers[0]!;
    await teamEight(fx, p);
    const id = await k4(p);
    await writeWork(p, P, t9([2, 'TWO'], [8, 'eight']));
    const it = await prepIt(p, { holdPaths: [P] });
    const log = recordLog(p);
    assert.deepEqual(await restore(p.core, it, id, HUMAN), { kind: 'RESTORED', markers: true });
    const disk = (await readWork(p, P))!.toString('utf8').split('\n');
    assert.equal(disk[1], '<<<<<<< cowork:disk');
    assert.equal(disk[3], '||||||| cowork:base');
    assert.equal(disk[5], '=======');
    assert.equal(disk[7], '>>>>>>> cowork:held');
    const r = p.core.holds.get(id)!;
    assert.deepEqual(r.guards.map((g) => g.name), ['markers']);
    assert.deepEqual(p.core.holdCode, { code: 'RESTORE_MARKERS', params: { id, path: P, rows: [2, 4, 6, 8] } }, 'the 1-based marker rows');
    assert.deepEqual(log.lines.find((l) => l.code === 'RESTORE_MARKERS')?.params, { id, path: P, rows: '2,4,6,8' });
    const sDisk = new Map([[P, { path: P, mode: '100644' as const, oid: await blob(p, (await readWork(p, P))!) }]]);
    const m = await maskEntries(p.core.repo, sDisk, { A: it.A, scope: () => 'LIVE', records: [r], mergeable: () => true }, new RebaseCache(p.core.repo, () => true));
    assert.ok(m.withheld.has(P), 'maskEntries withholds p');
  });
});

test('every guard other than the displacement stays', T10, async () => {
  await withPeers('restore-guards', {}, async (fx) => {
    const p = fx.peers[0]!;
    const it0 = await prepIt(p, { holdPaths: [P] });
    const id = await p.core.holds.hold(nr({ residence: 'OFF_DISK', state: 'PARKED', blobs: pair(it0.A.get(P)!.oid, await blob(p, t9([2, 'two']))) }));
    const it = await prepIt(p, { holdPaths: [P] });
    assert.deepEqual(await restore(p.core, it, id, HUMAN), { kind: 'RESTORED', markers: false });
    const r = p.core.holds.get(id)!;
    assert.deepEqual([r.residence, r.state, r.guards.map((g) => g.name)], ['ON_DISK', 'ACTIVE', ['revert']]);
    assert.deepEqual(await readWork(p, P), Buffer.from(t9([2, 'two'])));
  });
});

test('a restore whose result has a restore-marker row adds markers even at rc 0', T10, async () => {
  await withPeers('restore-rows-rc0', {}, async (fx) => {
    const p = fx.peers[0]!;
    const ROWS = '1\n<<<<<<< cowork:disk\nTWO\n=======\ntwo\n>>>>>>> cowork:held\n3\n4\n5\n6\n7\n8\n9\n';
    const it0 = await prepIt(p);
    const id = await p.core.holds.hold(nr({ residence: 'OFF_DISK', state: 'PARKED', guard: null, blobs: pair(it0.A.get(P)!.oid, await blob(p, ROWS)) }));
    const it = await prepIt(p, { holdPaths: [P] });
    assert.deepEqual(await restore(p.core, it, id, HUMAN), { kind: 'RESTORED', markers: true });
    assert.deepEqual(await readWork(p, P), Buffer.from(ROWS), 'merged cleanly onto the disk (= A), written as merged');
    assert.deepEqual(p.core.holds.get(id)!.guards.map((g) => g.name), ['markers']);
  });
});

test('05 I13 operator half (HLD-42, R3-EF4-14): nothing of the human CS publishes until the rows are gone — the rest of it waits as a dependency PIN — then the edit and the rest publish in one commit and the record ends RESOLVED_PUBLISH', T10, async () => {
  await withPeers('restore-i13', {}, async (fx) => {
    const p = fx.peers[0]!;
    await teamEight(fx, p);
    const id = await k4(p);
    await writeWork(p, P, t9([2, 'TWO'], [8, 'eight']));
    const it = await prepIt(p, { holdPaths: [P] });
    assert.deepEqual(await restore(p.core, it, id, HUMAN), { kind: 'RESTORED', markers: true });
    const tip0 = await remoteLiveCode(fx, p);
    // The rows are an ordinary local change of the human CS. markers withholds p whole (MASK step 3), and RESTORE released `conflict`,
    // so the record is no longer the K4 displacement (INV-HLD-ATOMIC-PUB exception (c) is over, R3-EF4-14): the rest of the CS
    // (src/other.txt) is PINned dependency:<id> and nothing of it publishes (05 I13: "nothing published"; HLD-42).
    await writeWork(p, OTHER, 'other, with the restore\n');
    await prep(p);
    fx.advance(20_000);
    const it1 = await prep(p, true);
    await captureReady(p, it1);
    fx.advance(30_000);
    const r1 = await publishStep(p.core, await prep(p));
    assert.equal(r1.c, null, JSON.stringify(r1));
    assert.equal(await remoteLiveCode(fx, p), tip0, 'nothing published');
    const pins = p.core.holds.nonTerminal().filter((r) => r.kind === 'PIN' && r.guards.some((g) => guardName(g) === 'dependency'));
    assert.equal(pins.length, 1, JSON.stringify(pins.map((x) => [x.id, x.guards, x.paths])));
    const pin = pins[0]!;
    assert.deepEqual([pin.guards.map((g) => g.name), pin.paths], [[`dependency:${id}`], [OTHER]], 'the markers path stays out of the PIN (pinnablePaths)');
    // The human removes the rows; the markers PREDICATE (Task 12a's recordStep) releases the guard at the next materialization whose
    // S_disk has no restore-marker row, and then the dependency guard (releaseDependencyGuards: the target withholds nothing).
    await writeWork(p, P, t9([2, 'two'], [8, 'eight']));
    assert.equal(hasRestoreMarkerRow((await readWork(p, P))!), false);
    await prep(p);
    fx.advance(1_500);   // the rows' removal shrinks the file by more than half: a second tick 1 s later confirms it (R-25)
    await prep(p);
    fx.advance(20_000);
    const it2 = await prep(p, true);
    assert.deepEqual(p.core.holds.get(id)!.guards.map((g) => g.name), ['markers'], 'not released before recordStep');
    await recordStep(p.core, it2, await applyStep(p.core, it2));
    assert.deepEqual(p.core.holds.get(id)!.guards, [], 'recordStep released markers');
    assert.deepEqual(p.core.holds.get(pin.id)!.guards, [], 'and the dependency guard');
    // The newest capture (rows removed) replaces the r1 one (HLD-40); the r1 pair's restore-marker rows would abort the window (ENG-41 (k)).
    await captureReady(p, it2);
    fx.advance(30_000);
    const r2 = await publishStep(p.core, await prep(p));
    assert.equal(r2.outcome, 'landed', JSON.stringify(r2));
    const tree = await treeOf(p, r2.c!);
    assert.equal((await p.core.repo.readBlob(tree.get(P)!.oid)).toString('utf8'), t9([2, 'two'], [8, 'eight']), 'the edit publishes');
    assert.equal((await p.core.repo.readBlob(tree.get(OTHER)!.oid)).toString('utf8'), 'other, with the restore\n', 'with the rest of its CS, in one commit');
    const it3 = await prepIt(p, { materialize: true, forceFetch: true });
    assert.ok((await evaluateRecords(p.core, it3, new Set(), [])).includes(id));
    assert.equal(p.core.holds.get(id)!.state, 'RESOLVED_PUBLISH');
    assert.ok(isTerminal(p.core.holds.get(pin.id)!), `the guard-less PIN ends too: ${p.core.holds.get(pin.id)!.state}`);
  });
});

test('binary RESTORE is human only and writes the held side whole only over the base or A', T10, async () => {
  const BIN = 'bin.dat';
  await withPeers('restore-binary', { files: { 'README.md': Buffer.from('# bin\n'), [BIN]: binary(2) } }, async (fx) => {
    const p = fx.peers[0]!;
    await prepIt(p);
    const [b0, b1, b2] = [await blob(p, binary(0)), await blob(p, binary(1)), await blob(p, binary(2))];
    const rec = (): Promise<string> => p.core.holds.hold(nr({ paths: [BIN], residence: 'OFF_DISK', state: 'CONFLICTED', guard: 'conflict', origin: 'daemon', blobs: stages(b0, b1, b2, BIN) }));
    for (const disk of [0, 2]) {
      await writeWork(p, BIN, binary(disk));
      fx.advance(2_500);
      const it = await prepIt(p, { holdPaths: [BIN] });
      const id = await rec();
      assert.deepEqual(await restore(p.core, it, id, HUMAN), { kind: 'RESTORED', markers: false }, `disk B${disk}`);
      assert.deepEqual(await readWork(p, BIN), binary(1), `disk B${disk}: the held side whole`);
      await p.core.holds.transition(id, { state: 'GONE' });
    }
    await writeWork(p, BIN, binary(3));
    fx.advance(2_500);
    const it = await prepIt(p, { holdPaths: [BIN] });
    const id = await rec();
    assert.deepEqual(await restore(p.core, it, id, HUMAN), { kind: 'REFUSED', code: 'HOLD_RESTORE_CONFLICT' });
    assert.deepEqual(await readWork(p, BIN), binary(3), 'nothing written');
    assert.equal(p.core.holds.get(id)!.residence, 'OFF_DISK');
    // A Claude restore of a binary record: refused before any read.
    const fsFrom = p.fs.calls.length;
    const { calls, result } = await callsDuring(p, () => restore(p.core, it, id, { humanEvidence: false, actor: 'claude' }));
    assert.deepEqual(result, { kind: 'REFUSED', code: 'RESTORE_BINARY_HUMAN_ONLY' });
    assert.deepEqual(calls.filter((c) => c.args[0] !== 'cat-file'), [], 'no git call but object reads');
    assert.equal(p.fs.calls.slice(fsFrom).filter((c) => c.includes(workPath(p, BIN))).length, 0, 'no read of the working file');
  });
});

test('deletions and recreations follow 03-data §3.9 cases 2–3', T10, async () => {
  await withPeers('restore-cases', {}, async (fx) => {
    const p = fx.peers[0]!;
    const it0 = await prepIt(p);
    const t = it0.A.get(P)!.oid;
    // Case 2: s2 ABSENT (the local side deleted p), disk D present → writeLocal(p, D, DELETE).
    const del = await p.core.holds.hold(nr({ residence: 'OFF_DISK', state: 'CONFLICTED', guard: 'conflict', origin: 'daemon', blobs: stages(t, ABSENT, await blob(p, t9([8, 'eight']))) }));
    const it = await prepIt(p, { holdPaths: [P] });
    assert.deepEqual(await restore(p.core, it, del, HUMAN), { kind: 'RESTORED', markers: false });
    assert.equal(await readWork(p, P), null, 'the file is gone');
    // Case 3: D ABSENT (TIP deleted p) and s2 present → writeLocal(p, ABSENT, s2).
    await p.core.holds.transition(del, { state: 'GONE' });
    const U = 'src/u9.txt';
    const re = await p.core.holds.hold(nr({ paths: [U], residence: 'OFF_DISK', state: 'CONFLICTED', guard: 'conflict', origin: 'daemon', blobs: stages(t, await blob(p, t9([5, 'five'])), ABSENT, U) }));
    const { unlink } = await import('node:fs/promises');
    await unlink(workPath(p, U));
    fx.advance(1_500);
    await prepIt(p);
    fx.advance(1_500);
    const it2 = await prepIt(p, { holdPaths: [U] });
    assert.equal(it2.mat!.sDiskMap.has(U), false, 'D = ABSENT');
    assert.deepEqual(await restore(p.core, it2, re, HUMAN), { kind: 'RESTORED', markers: false });
    assert.deepEqual(await readWork(p, U), Buffer.from(t9([5, 'five'])), 'recreated');
  });
});

test('RESTORE waits while the record is ON_DISK with its TIP write pending', T10, async () => {
  await withPeers('restore-pending', {}, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, P, t9([2, 'local']));
    const it = await prepIt(p, { holdPaths: [P] });
    const id = await p.core.holds.hold(nr({ state: 'CONFLICTED', guard: 'conflict', origin: 'daemon', blobs: stages(it.A.get(P)!.oid, await blob(p, t9([2, 'local'])), await blob(p, t9([2, 'team']))) }));
    const { calls, result } = await callsDuring(p, () => restore(p.core, it, id, HUMAN));
    assert.deepEqual(result, { kind: 'POSTPONED', why: 'tip_write_pending' });
    assert.equal(calls.length, 0, 'no write');
    assert.deepEqual(await readWork(p, P), Buffer.from(t9([2, 'local'])));
  });
});

// EF4 round 2 group P concern 1: only the TAKE_TIP displacement itself (isK4Displacement: stages, CONFLICTED, guard `conflict`) waits for
// its TIP write. A K4 record that a RESTORE already brought back (`conflict` released, its stages kept) and that later became CONFLICTED
// (seed 22's rev-4 shape, ON_DISK CONFLICTED []) has no TIP write pending: a POSTPONED answer would postpone it forever, so it takes the
// ordinary "ON_DISK record" answer (a TypeError: Table 4 restores OFF_DISK records; resolve answers an ON_DISK --restore itself).
test('RESTORE of a restored K4 record that became CONFLICTED again (stages, no `conflict`) is not postponed as a pending TIP write', T10, async () => {
  await withPeers('restore-restored-conflicted', {}, async (fx) => {
    const p = fx.peers[0]!;
    await teamEight(fx, p);
    const id = await k4(p);
    fx.advance(2_500);
    assert.deepEqual(await restore(p.core, await prepIt(p, { holdPaths: [P] }), id, HUMAN), { kind: 'RESTORED', markers: false });
    const restored = p.core.holds.get(id)!;
    assert.equal(restored.residence, 'ON_DISK');
    assert.ok('s2' in restored.blobs, 'the record keeps its stages');
    assert.deepEqual(restored.guards.map(guardName), [], 'conflict released');
    await p.core.holds.transition(id, { state: 'CONFLICTED' });   // a later REBASE conflict (R1), as seed 22's rev 4
    const disk = await readWork(p, P);
    fx.advance(2_500);
    const it = await prepIt(p, { holdPaths: [P] });
    const { calls, result } = await callsDuring(p, () => restore(p.core, it, id, HUMAN).then((v) => v, (e: unknown) => e));
    assert.ok(result instanceof TypeError && /is ON_DISK/.test(result.message), `not POSTPONED: ${JSON.stringify(result)}`);
    assert.equal(calls.length, 0, 'no git call, no write');
    assert.deepEqual(await readWork(p, P), disk, 'the disk is unchanged');
    assert.equal(p.core.holds.get(id)!.state, 'CONFLICTED');
  });
});

test('a Claude RESTORE under FREEZE is refused HOLD_FROZEN; the human verb writes', T10, async () => {
  await withPeers('restore-freeze', {}, async (fx) => {
    const p = fx.peers[0]!;
    const it0 = await prepIt(p);
    const id = await p.core.holds.hold(nr({ residence: 'OFF_DISK', state: 'PARKED', blobs: pair(it0.A.get(P)!.oid, await blob(p, t9([2, 'two']))) }));
    await p.core.commit({ meta: { ...p.core.view!.meta, freeze_reasons: ['MASS'] } });
    const it = await prepIt(p, { holdPaths: [P] });
    assert.deepEqual(await restore(p.core, it, id, { humanEvidence: false, actor: 'claude' }), { kind: 'REFUSED', code: 'HOLD_FROZEN' });
    assert.equal(p.core.holds.get(id)!.residence, 'OFF_DISK');
    assert.deepEqual(await restore(p.core, it, id, HUMAN), { kind: 'RESTORED', markers: false });
    assert.deepEqual(await readWork(p, P), Buffer.from(t9([2, 'two'])));
  });
});

test('RESTORE under a share-none holder reports LOCKED and writes nothing', T10, async () => {
  await withPeers('restore-locked', {}, async (fx) => {
    const p = fx.peers[0]!;
    const it0 = await prepIt(p);
    const id = await p.core.holds.hold(nr({ residence: 'OFF_DISK', state: 'PARKED', blobs: pair(it0.A.get(P)!.oid, await blob(p, t9([2, 'two']))) }));
    const it = await prepIt(p, { holdPaths: [P] });
    const release = p.fs.holdLock(workPath(p, P), 'share-none');
    try {
      assert.deepEqual(await restore(p.core, it, id, HUMAN), { kind: 'LOCKED' });
    } finally {
      release();
    }
    assert.equal(p.core.holds.get(id)!.residence, 'OFF_DISK');
    assert.deepEqual(p.core.holds.local().inflight, {}, 'inflight cleared');
    assert.deepEqual(await readWork(p, P), Buffer.from(T9));
    assert.equal((await stateA(p)).has(P), true);
  });
});

test('a RESTORE over a disk that became binary (UTF-16LE, no attribute) is refused by the whole-path rule, never a merge-file failure', T10, async () => {
  // R3-18 / DAT-04 on every side, D included: Windows PowerShell 5.1's `>` and Out-File re-save a text file as UTF-16LE (BOM FF FE,
  // CRLF), whose NULs make it binary when no working-tree-encoding attribute names it. No merge-file runs on it.
  await withPeers('restore-binary-disk', {}, async (fx) => {
    const p = fx.peers[0]!;
    const it0 = await prepIt(p);
    const id = await p.core.holds.hold(nr({ residence: 'OFF_DISK', state: 'PARKED', blobs: pair(it0.A.get(P)!.oid, await blob(p, t9([2, 'two']))) }));
    const U16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(T9.replace(/\n/g, '\r\n'), 'utf16le')]);
    await writeWork(p, P, U16);
    fx.advance(2_500);
    const it = await prepIt(p, { holdPaths: [P] });
    const D: Oid = it.mat!.sRawMap.get(P)!.oid;
    assert.notEqual(D, it.A.get(P)!.oid, 'the disk is neither A nor the base');
    const before = p.core.holds.get(id)!;
    const { calls, result } = await callsDuring(p, () => restore(p.core, it, id, HUMAN));
    assert.deepEqual(result, { kind: 'REFUSED', code: 'HOLD_RESTORE_CONFLICT' }, 'human: D is neither the base nor A');
    assert.equal(calls.filter((c) => c.args.includes('merge-file')).length, 0, 'no merge-file on a binary disk');
    assert.deepEqual(await restore(p.core, it, id, { humanEvidence: false, actor: 'claude' }), { kind: 'REFUSED', code: 'RESTORE_BINARY_HUMAN_ONLY' }, 'claude: binary is human only');
    assert.deepEqual(await readWork(p, P), U16, 'nothing written');
    const after = p.core.holds.get(id)!;
    assert.deepEqual([after.residence, after.state, after.rev, after.guards.map((g) => g.name)], [before.residence, before.state, before.rev, ['revert']]);
    assert.deepEqual(p.core.holds.local().inflight, {}, 'no in-flight entry');
  });
});
