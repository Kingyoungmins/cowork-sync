// The publish side of non-portable names on EngineCores over real clones (Plan 3 Task 7; 03-data §3.7 "Publish side", DAT-32,
// DAT-33, I-DAT-09 record half; glossary §9 LIVE-only rule and content-free stub; rulings R3-12, R3-17, R3-24, R3-35, R3-53):
// portabilityStep turns every NOT_ADMITTED `portability` new path a record can carry (stageable()) into one local_only ON_DISK
// PATCH `portability` (h0 ABSENT, h1 the staged copy), PATH_NOT_PORTABLE {id, path, rule}, a member path of the open human CS;
// it releases the guard when D7 passes and ends the record GONE when the name leaves the disk; a name no record can carry
// (R3-53) gets no record, no read and no CS membership, PATH_NOT_PORTABLE {path, rule} once per episode, and `unrecorded`.
//
// The non-portable name: `con.py` on Linux and macOS (D7 rule 2: a reserved device name) and, on win32, which cannot create a
// device name, a 100-syllable Hangul component plus `.txt` (304 UTF-8 bytes > 255, rule 2). The dotgit-alias name: `git~1/x.txt`
// off win32; on win32 an NTFS volume with 8.3 names resolves `git~1` to the clone's own `.git` (measured on this machine), so
// the test uses `.g<U+200C>it/x.txt`, a component isDotGitAlias reads as `.git` (HFS+ ignores U+200C) that NTFS keeps distinct.
// Git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { readHeld } from '../../src/board/boardCommit.js';
import { portable } from '../../src/data/scope.js';
import { applyStep } from '../../src/engine/apply.js';
import type { IterationCtx } from '../../src/engine/core.js';
import { portabilityStep } from '../../src/engine/dataRecords.js';
import { evaluateRecords } from '../../src/engine/holdOps.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import { projectOp } from '../../src/holds/mirror.js';
import { gitCallsOf, readWork, workPath, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { hashTestSide, remoteLive } from '../helpers/dataRecordsFixture.js';
import { prepIt, recordLog, withPeers } from '../helpers/holdOpsFixture.js';
import { holdOpsOf, win } from '../helpers/mirrorFixture.js';
import { buf, captureReady, prep, treeOf } from '../helpers/publishHelpers.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const WIN = process.platform === 'win32';
const NAME = WIN ? `${'\u{d55c}'.repeat(100)}.txt` : 'con.py';
const RENAMED = WIN ? 'ok.txt' : 'con_.py';
const ALIAS = WIN ? '.g\u{200c}it/x.txt' : 'git~1/x.txt';
const NFD_NAME = 'nfd/\u{d55c}.txt'.normalize('NFD');
const FILES: Record<string, Buffer> = {
  'README.md': buf('# portability fixture\n'),
  'src/a.txt': buf('one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n'),
  'src/old.py': buf('print("old")\n'),
};

type StepResult = Awaited<ReturnType<typeof portabilityStep>>;

/** advance(2_500), then a tick-only iteration and portabilityStep. */
async function tick(fx: CoreFixture, p: PeerFixture, ms = 2_500): Promise<{ it: IterationCtx; r: StepResult }> {
  fx.advance(ms);
  const it = await prepIt(p, { materialize: false });
  return { it, r: await portabilityStep(p.core, it) };
}

/** The FaultFs calls of `op` naming the work file of `path`. */
function fsCalls(p: PeerFixture, op: string, path: string, from = 0): string[] {
  const abs = workPath(p, path);
  return p.fs.calls.slice(from).filter((c) => c.startsWith(`${op} `) && c.slice(op.length + 1).split(' -> ')[0] === abs);
}

const PORTABILITY_GUARD = { name: 'portability', class: 'DECISION', owner: 'DAT' };

/** Creates the non-portable file and runs the tick that records it; the record must be created. */
async function createRecord(fx: CoreFixture, p: PeerFixture, bytes = 'print(1)\n'): Promise<{ id: string; it: IterationCtx; r: StepResult }> {
  await writeWork(p, NAME, bytes);
  const { it, r } = await tick(fx, p);
  assert.equal(it.tick?.notAdmitted.get(NAME), 'portability', 'precondition: the snapshot does not admit the name (D7 rule 2)');
  assert.equal(r.created.length, 1, JSON.stringify(r));
  return { id: r.created[0]!, it, r };
}

test('a human-created non-portable new file becomes one local_only ON_DISK PATCH with guard portability, h0 ABSENT and h1 the staged copy\'s blob, reported PATH_NOT_PORTABLE {id, path, rule: 2}', T10, async () => {
  await withPeers('t7-port-create', { files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prepIt(p, { materialize: false });
    const log = recordLog(p);
    const { id, r } = await createRecord(fx, p);
    assert.deepEqual(r, { created: [id], released: [], unrecorded: [] });
    const rec = p.core.holds.get(id)!;
    assert.deepEqual([rec.kind, rec.residence, rec.state], ['PATCH', 'ON_DISK', 'ACTIVE']);
    assert.deepEqual(rec.guards, [{ name: 'portability', class: 'DECISION', owner: 'DAT' }]);
    assert.equal(rec.local_only, true, 'registry recompute: the name is not LIVE (R3-12)');
    assert.deepEqual(rec.paths, [NAME]);
    assert.ok('h1' in rec.blobs);
    assert.equal(rec.blobs.h0[NAME], ABSENT);
    assert.equal(rec.blobs.h1[NAME], await hashTestSide(p, NAME, buf('print(1)\n')), 'h1 = the staged copy\'s blob');
    assert.equal(rec.origin, 'human');
    assert.deepEqual(rec.cs_ids, []);
    assert.deepEqual(p.core.holdCode, { code: 'PATH_NOT_PORTABLE', params: { id, path: NAME, rule: 2 } });
    assert.deepEqual(log.lines.filter((l) => l.code === 'PATH_NOT_PORTABLE').map((l) => l.params), [{ id, path: NAME, rule: 2 }], 'one log line');
  });
});

test('ten more ticks, one of them after an edit of the file, create no second record and no registry commit', T10, async () => {
  await withPeers('t7-port-once', { files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prepIt(p, { materialize: false });
    const log = recordLog(p);
    const { id } = await createRecord(fx, p);
    const head = p.core.holds.head();
    const h1 = (p.core.holds.get(id)!.blobs as { h1: Record<string, string> }).h1[NAME];
    const from = p.fs.calls.length;
    for (let k = 1; k <= 10; k++) {
      if (k === 5) await writeWork(p, NAME, 'print(2)\n');
      const { r } = await tick(fx, p);
      assert.deepEqual(r, { created: [], released: [], unrecorded: [] }, `tick ${k}`);
    }
    assert.equal(p.core.holds.head(), head, 'no registry commit');
    assert.equal((p.core.holds.get(id)!.blobs as { h1: Record<string, string> }).h1[NAME], h1, 'the record keeps its first h1');
    assert.deepEqual(fsCalls(p, 'readFile', NAME, from), [], 'the later bytes stay on the author\'s disk, unread');
    assert.deepEqual(await readWork(p, NAME), buf('print(2)\n'));
    assert.equal(log.lines.filter((l) => l.code === 'PATH_NOT_PORTABLE').length, 1, 'reported once');
  });
});

test('portabilityStep adds the path to the open human CS, so the CS\'s capture lists it with R and A_cap both lacking it', T10, async () => {
  await withPeers('t7-port-cs', { files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prepIt(p, { materialize: false });
    await writeWork(p, 'src/a.txt', 'one\ntwo edited\nthree\nfour\nfive\nsix\nseven\neight\n');
    await createRecord(fx, p);
    assert.deepEqual([...p.core.cs.openPaths()].sort(), [NAME, 'src/a.txt'].sort(), 'both are member paths of the open human CS');
    fx.advance(20_000);
    const pair = await captureReady(p, await prep(p, true));
    assert.ok(pair.paths.includes('src/a.txt'));
    // Plan 2's capture drops a member path that neither tree holds; listing it in the pair is Task 9's capture (reported).
    const R = await p.core.repo.readTreeMap(pair.R);
    const Acap = await p.core.repo.readTreeMap(pair.A);
    assert.equal(R.has(NAME), false, 'R lacks the name');
    assert.equal(Acap.has(NAME), false, 'A_cap lacks the name');
  });
});

test('the record\'s mirror is a content-free stub: the next window\'s board commit has no held/<id>/ subtree and no tree entry naming the file, and projectOp carries local_only true and no oid', T10, async () => {
  await withPeers('t7-port-stub', { files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prepIt(p, { materialize: false });
    const { id } = await createRecord(fx, p);
    const rec = p.core.holds.get(id)!;
    const h1 = (rec.blobs as { h1: Record<string, string> }).h1[NAME]!;
    const op = projectOp(rec, null);
    assert.equal(op.local_only, true);
    assert.deepEqual(op.paths, [NAME]);
    assert.ok(!Object.keys(op).some((k) => /oid|blob|^h[01]$|^s[123]$/.test(k)), `no oid field: ${Object.keys(op).join(',')}`);
    assert.ok(!JSON.stringify(op).includes(h1), 'no blob id anywhere in the op');
    const { r } = await win(fx, p);
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    assert.deepEqual(r.mirrored, [id]);
    const bnew = r.bnew as Oid;
    assert.equal(await readHeld(p.core.repo, bnew, id), null, 'no held/<id>/ subtree');
    const names = (await p.core.repo.run(['ls-tree', '-r', '-z', '--name-only', bnew])).stdout.toString('utf8').split('\0').filter((x) => x.length > 0);
    assert.ok(!names.some((x) => x.split('/').includes(NAME)), 'no tree entry names the file');
    const [mirrored] = (await holdOpsOf(p, bnew)).filter((o) => o.hold_id === id);
    assert.ok(mirrored !== undefined);
    assert.deepEqual([mirrored.local_only, mirrored.paths], [true, [NAME]], 'the stub keeps paths[] (R3-24)');
  });
});

test('final review F3: the record stays local_only at every later rev while it carries `portability` — after a tick requested its attributes, a flushAgeAnchors rev (a clean exit) and an addGuard rev — so no board commit ever gets a held/<id>/ subtree for it', T10, async () => {
  await withPeers('t7-port-laterrev', { files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prepIt(p, { materialize: false });
    const { id } = await createRecord(fx, p);
    assert.equal(p.core.holds.get(id)!.local_only, true, 'precondition: local_only at creation');
    const first = await win(fx, p);
    assert.equal(first.r.outcome, 'landed', JSON.stringify(first.r));
    assert.deepEqual(first.r.mirrored, [id], 'the creation stub lands');
    // The next tick's prepareIteration requests the attributes of every record path (ensureRecordAttrs), so the registry's D5
    // scope now classes the name LIVE; the guard still says D7 fails.
    const { r: again } = await tick(fx, p);
    assert.deepEqual(again.released, [], 'D7 still fails: the guard stays');
    fx.advance(5_000);
    assert.equal(await p.core.holds.flushAgeAnchors(), 1);
    const rec2 = p.core.holds.get(id)!;
    assert.deepEqual([rec2.rev, rec2.local_only, rec2.guards.map((g) => g.name)], [2, true, ['portability']], 'rev 2 (the age flush) keeps local_only');
    assert.equal(projectOp(rec2, null).local_only, true, 'its mirror key stays the stub');
    // A guard composed onto it (AND, HLD-07's attach path) is another rev: still local_only.
    await p.core.holds.addGuard(id, 'lock');
    const rec3 = p.core.holds.get(id)!;
    assert.deepEqual([rec3.rev, rec3.local_only], [3, true], 'rev 3 (addGuard) keeps local_only');
    // The next publish window re-mirrors nothing with held bytes: the remote board has no held/<id>/ subtree for the record.
    await win(fx, p);
    const tip = (await fx.remote.refs())[p.core.refs.remoteBoard] as Oid;
    assert.equal(await readHeld(p.core.repo, tip, id), null, 'no held/<id>/ on the remote board');
    const names = (await p.core.repo.run(['ls-tree', '-r', '-z', '--name-only', tip])).stdout.toString('utf8').split('\0').filter((x) => x.length > 0);
    assert.ok(!names.some((x) => x.split('/').includes(NAME)), 'no tree entry of the remote board names the file');
    for (const op of await holdOpsOf(p, tip)) if (op.hold_id === id) assert.equal(op.local_only, true, `op rev ${op.rev} is a stub`);
  });
});

test('the non-portable file is never in a pushed live tree', T10, async () => {
  await withPeers('t7-port-live', { files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prepIt(p, { materialize: false });
    await writeWork(p, 'src/a.txt', 'one\ntwo edited\nthree\nfour\nfive\nsix\nseven\neight\n');
    await createRecord(fx, p);
    fx.advance(20_000);
    await captureReady(p, await prep(p, true));
    for (let w = 1; w <= 3; w++) {
      await win(fx, p);
      const live = await remoteLive(fx, p);
      assert.ok(live.has('src/a.txt'), 'precondition: the live tree is read');
      assert.equal(live.has(NAME), false, `window ${w}`);
    }
  });
});

test('renaming the file to a portable name ends the record GONE at the next tick and the new name publishes as an ordinary new path', T10, async () => {
  await withPeers('t7-port-rename', { files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prepIt(p, { materialize: false });
    const { id } = await createRecord(fx, p);
    await rename(workPath(p, NAME), workPath(p, RENAMED));
    const at = fx.trace.events.length;
    const { r } = await tick(fx, p);
    assert.deepEqual(r, { created: [], released: [id], unrecorded: [] });
    assert.equal(p.core.holds.get(id)!.state, 'GONE');
    const holds = fx.trace.since(at).filter((e) => e.kind === 'hold' && e.id === id);
    assert.deepEqual(holds.map((e) => (e.kind === 'hold' ? e.state : '')), ['GONE'], 'trace hold state GONE');
    fx.advance(20_000);
    await captureReady(p, await prep(p, true));
    const { r: pub } = await win(fx, p);
    assert.equal(pub.outcome, 'landed', JSON.stringify(pub));
    assert.ok(pub.c !== null, 'a code publish');
    const live = await remoteLive(fx, p);
    assert.equal(live.get(RENAMED), await hashTestSide(p, RENAMED, buf('print(1)\n')), 'the new name is in the next pushed live tree');
    assert.equal(live.has(NAME), false);
  });
});

test('ignoring the non-portable file keeps its record and its guard: the tick stops flagging the name but D7 still fails it', T10, async () => {
  await withPeers('t7-port-ignored', { files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prepIt(p, { materialize: false });
    const { id } = await createRecord(fx, p);
    await writeWork(p, '.gitignore', `/${NAME}\n`);
    const head = p.core.holds.head();
    for (let k = 1; k <= 3; k++) {
      const { it, r } = await tick(fx, p);
      assert.equal(it.tick?.notAdmitted.has(NAME), false, `precondition: tick ${k} no longer lists the ignored name`);
      assert.deepEqual(r, { created: [], released: [], unrecorded: [] }, `tick ${k}: nothing released`);
    }
    const rec = p.core.holds.get(id)!;
    assert.deepEqual([rec.state, rec.guards, rec.local_only], ['ACTIVE', [PORTABILITY_GUARD], true], 'the guard stays, the record stays local_only');
    assert.equal(p.core.holds.head(), head, 'no registry commit');
  });
});

test('final review r2 A-3: portabilityStep never releases or ends an OFF_DISK portability record, whose name is off the disk because it was displaced', T10, async () => {
  // Defence in depth: since final review F3 a portability record stays local_only and PARK never runs on one, so the engine makes no
  // OFF_DISK portability record today — the test plants one (the record moved OFF_DISK PARKED, its file gone as a park leaves it).
  // The release/GONE loop reads "the name left the disk" as a rename or a deletion (I-DAT-09), which holds for an ON_DISK record only;
  // an OFF_DISK record's bytes live in the record alone (INV-NOLOSS).
  await withPeers('t7-port-offdisk', { files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prepIt(p, { materialize: false });
    const { id } = await createRecord(fx, p);
    await p.core.holds.transition(id, { residence: 'OFF_DISK', state: 'PARKED' });
    await unlink(workPath(p, NAME));
    const head = p.core.holds.head();
    const { r } = await tick(fx, p);
    assert.deepEqual(r, { created: [], released: [], unrecorded: [] }, 'nothing released');
    const rec = p.core.holds.get(id)!;
    assert.deepEqual([rec.residence, rec.state, rec.guards], ['OFF_DISK', 'PARKED', [PORTABILITY_GUARD]], 'the record keeps its bytes, state and guard');
    assert.equal(p.core.holds.head(), head, 'no registry commit');
  });
});

test('R1 leaves a portability record alone while its name is not admitted: the apply step\'s record evaluation keeps it ACTIVE with its guard', T10, async () => {
  await withPeers('t7-port-r1', { files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prepIt(p, { materialize: false });
    const { id } = await createRecord(fx, p);
    fx.advance(2_500);
    const it = await prep(p, true);
    assert.ok(it.mat !== null && !it.mat.sDiskMap.has(NAME), 'precondition: a materialization whose S_disk lacks the never-read name');
    const rep = await applyStep(p.core, it);
    const head = p.core.holds.head();
    assert.deepEqual(await evaluateRecords(p.core, it, new Set(rep.changedA), []), [], 'R1 transitions nothing');
    const rec = p.core.holds.get(id)!;
    assert.deepEqual([rec.state, rec.residence, rec.guards], ['ACTIVE', 'ON_DISK', [PORTABILITY_GUARD]]);
    assert.equal(p.core.holds.head(), head, 'no registry commit');
  });
});

test('a non-portable new file over the new-file cap is never read or stored: no record, PATH_NOT_PORTABLE {path, rule} without an id once per episode, listed in unrecorded', T10, async () => {
  await withPeers('t7-port-cap', { files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prepIt(p, { materialize: false });
    const log = recordLog(p);
    const head = p.core.holds.head();
    const fsFrom = p.fs.calls.length;
    const gitFrom = gitCallsOf(p).length;
    await writeWork(p, NAME, Buffer.alloc(p.core.config.sync.maxNewFileBytes + 1, 0x61));
    const { it, r } = await tick(fx, p);
    assert.equal(it.tick?.notAdmitted.get(NAME), 'portability', 'precondition: D7 (rule 2.6) is checked before the new-file cap (2.7)');
    assert.deepEqual(r, { created: [], released: [], unrecorded: [NAME] });
    for (let k = 0; k < 3; k++) assert.deepEqual((await tick(fx, p)).r, { created: [], released: [], unrecorded: [NAME] }, `tick ${k + 2}`);
    assert.equal(p.core.holds.head(), head, 'no record, no registry commit');
    assert.deepEqual(p.core.holdCode, { code: 'PATH_NOT_PORTABLE', params: { path: NAME, rule: 2 } });
    assert.equal(log.lines.filter((l) => l.code === 'PATH_NOT_PORTABLE').length, 1, 'one log line (one per episode)');
    assert.deepEqual(fsCalls(p, 'readFile', NAME, fsFrom), [], 'never read');
    assert.deepEqual(gitCallsOf(p).slice(gitFrom).filter((c) => c.args.includes('-w') || c.args.some((x) => x.includes(NAME))), [], 'nothing hashed or stored');
    assert.equal(p.core.cs.openPaths().has(NAME), false, 'never a CS member');
  });
});

test('on a case-sensitive host readme.md beside tracked README.md is a rule-4 record; deleting README.md releases its guard and both changes publish in one commit', { ...T10, skip: WIN || process.platform === 'darwin' ? 'needs a case-sensitive host (Linux)' : false }, async () => {
  await withPeers('t7-port-rule4', { files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prepIt(p, { materialize: false });
    await writeWork(p, 'readme.md', '# lower\n');
    const { it, r } = await tick(fx, p);
    assert.equal(it.tick?.notAdmitted.get('readme.md'), 'portability');
    assert.equal(r.created.length, 1);
    const id = r.created[0]!;
    assert.deepEqual(p.core.holdCode, { code: 'PATH_NOT_PORTABLE', params: { id, path: 'readme.md', rule: 4 } });
    assert.equal(p.core.holds.get(id)!.local_only, true);
    // README.md deleted: its removal is confirmed by a second read ≥ 1 s later; the tick after that admits readme.md.
    await unlink(workPath(p, 'README.md'));
    let released: string[] = [];
    let admittedAt = -1;
    for (let k = 0; k < 5 && released.length === 0; k++) {
      const t = await tick(fx, p);
      released = t.r.released;
      if (t.it.tick?.dirty.get('readme.md')?.kind === 'new') admittedAt = k;
      if (released.length === 0) assert.equal(t.it.tick?.notAdmitted.get('readme.md'), 'portability', `tick ${k}: still not admitted`);
    }
    assert.deepEqual(released, [id]);
    assert.ok(admittedAt >= 0, 'released at the tick that admitted readme.md');
    const rec = p.core.holds.get(id)!;
    assert.deepEqual([rec.guards, rec.local_only, rec.state, rec.residence], [[], false, 'ACTIVE', 'ON_DISK'], 'R3-17: guard-less, LIVE, ACTIVE');
    fx.advance(20_000);
    const pair = await captureReady(p, await prep(p, true));
    assert.deepEqual([...pair.paths].sort(), ['README.md', 'readme.md']);
    const before = p.core.view!.laC;
    const { r: pub } = await win(fx, p);
    assert.equal(pub.outcome, 'landed', JSON.stringify(pub));
    assert.ok(pub.c !== null);
    const after = pub.c as Oid;
    assert.equal((await p.core.repo.readCommit(after)).parents[0], before, 'one live commit on the previous live tip');
    const prevTree = await treeOf(p, before);
    const live = await treeOf(p, after);
    assert.deepEqual([prevTree.has('README.md'), prevTree.has('readme.md')], [true, false]);
    assert.equal(live.has('README.md'), false, 'the commit carries the deletion');
    assert.equal(live.get('readme.md')?.oid, (rec.blobs as { h1: Record<string, string> }).h1['readme.md'], 'and readme.md');
    const it2 = await prep(p, true);
    const rep = await applyStep(p.core, it2);
    await evaluateRecords(p.core, it2, new Set(rep.changedA), []);
    assert.equal(p.core.holds.get(id)!.state, 'SUBSUMED');
  });
});

test('a dotgit-alias new name gets no record, is never read, and is reported PATH_NOT_PORTABLE without an id', T10, async () => {
  await withPeers('t7-port-dotgit', { files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prepIt(p, { materialize: false });
    const log = recordLog(p);
    const head = p.core.holds.head();
    const from = p.fs.calls.length;
    await writeWork(p, ALIAS, 'x\n');
    const { it, r } = await tick(fx, p);
    assert.equal(it.tick?.notAdmitted.get(ALIAS), 'portability', 'precondition: the snapshot lists the alias as not admitted');
    assert.deepEqual(r, { created: [], released: [], unrecorded: [ALIAS] });
    assert.equal(p.core.holds.head(), head, 'no record, no registry commit');
    const rule = (portable(ALIAS, new Set()) as { ok: false; rule: number }).rule;
    assert.deepEqual(p.core.holdCode, { code: 'PATH_NOT_PORTABLE', params: { path: ALIAS, rule } });
    for (let k = 0; k < 10; k++) assert.deepEqual((await tick(fx, p)).r.unrecorded, [ALIAS]);
    assert.deepEqual([...fsCalls(p, 'lstat', ALIAS, from), ...fsCalls(p, 'readFile', ALIAS, from)], [], 'never lstat\'d or read');
    assert.equal(log.lines.filter((l) => l.code === 'PATH_NOT_PORTABLE').length, 1, 'one log line (one per episode)');
    assert.equal(p.core.cs.openPaths().has(ALIAS), false, 'never a CS member');
  });
});

test('R3-53: renaming src/old.py to src/old:v2.py (a name that fails SEC-35) creates no record, reports PATH_NOT_PORTABLE {path, rule} without an id, and never puts the bad name into a CS', { ...T10, skip: WIN ? 'win32 cannot create a name holding ":"' : false }, async () => {
  await withPeers('t7-port-colon', { files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prepIt(p, { materialize: false });
    const head = p.core.holds.head();
    const BAD = 'src/old:v2.py';
    await rename(workPath(p, 'src/old.py'), join(p.deps.paths.workTree, 'src', 'old:v2.py'));
    // The deletion of src/old.py is confirmed by a second read ≥ 1 s later.
    await tick(fx, p);
    const { r } = await tick(fx, p);
    assert.deepEqual(r, { created: [], released: [], unrecorded: [BAD] });
    assert.equal(p.core.holds.head(), head);
    assert.deepEqual(p.core.holdCode, { code: 'PATH_NOT_PORTABLE', params: { path: BAD, rule: 2 } });
    const open = p.core.cs.openPaths();
    assert.ok(open.has('src/old.py'), 'the deletion is in the human CS');
    assert.equal(open.has(BAD), false, 'the bad name is in no CS');
  });
});

test('an NFD-spelled new name is handled like a:b.txt', { ...T10, skip: process.platform === 'darwin' ? 'the host composes NFD names' : false }, async () => {
  await withPeers('t7-port-nfd', { files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prepIt(p, { materialize: false });
    const head = p.core.holds.head();
    await writeWork(p, NFD_NAME, 'nfd\n');
    const { it, r } = await tick(fx, p);
    assert.equal(it.tick?.notAdmitted.get(NFD_NAME), 'portability');
    assert.deepEqual(r, { created: [], released: [], unrecorded: [NFD_NAME] });
    assert.equal(p.core.holds.head(), head, 'no record');
    assert.deepEqual(p.core.holdCode, { code: 'PATH_NOT_PORTABLE', params: { path: NFD_NAME, rule: 1 } });
    assert.equal(p.core.cs.openPaths().has(NFD_NAME), false);
  });
});
