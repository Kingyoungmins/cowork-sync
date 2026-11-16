// HLD-42's dependency PIN and R3-53's readiness gate (Plan 3 Task 10; 05-holds HLD-42, HLD-07, HLD-52, INV-HLD-ATOMIC-PUB exceptions
// (a)–(c); 03-data D-07, DAT-06, DAT-32, DAT-33, DAT-39, TC-HLD-10 dependency half, I-DAT-20 PIN half; rulings R3-35, R3-44, R3-53):
// a ready group a MASK steps 2–4 record withholds whole on R becomes one PIN dependency:<id> over its LIVE paths before P is composed,
// and a group holding a human or recovered CS waits while a non-portable name no record can carry exists. Real clones; git is never
// mocked. EF3 (HLD-24, R3-46, R3-53, INV-NOSILENT): the status half of both — the paths R3-53's latch keeps back after a fix, and a
// released (guard-less) dependency PIN's paths, are in not_converged until they publish and R1 ends the PIN.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { hasRestoreMarkerRow } from '../../src/data/rows.js';
import type { IterationCtx } from '../../src/engine/core.js';
import { captureStep, queueSignal } from '../../src/engine/csStep.js';
import { portabilityStep } from '../../src/engine/dataRecords.js';
import { evaluateRecords } from '../../src/engine/holdOps.js';
import { holdStatusInputs, settleHoldCode } from '../../src/engine/holdSteps.js';
import { publishPending, publishStep, releaseDependencyGuards, type PublishReport } from '../../src/engine/publish.js';
import type { NotConvergedWhy } from '../../src/engine/status.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import { heldPins } from '../../src/holds/changesets.js';
import type { PublishGatePort, T0RegionsPort } from '../../src/holds/ports.js';
import type { NewRecord } from '../../src/holds/registry.js';
import { guardName, type HoldRecord } from '../../src/holds/record.js';
import type { CsSignal } from '../../src/holds/signals.js';
import { workPath, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { remoteCoworkBlobs } from '../helpers/holdOpsFixture.js';
import { holdOpsSince, remoteTip } from '../helpers/mirrorFixture.js';
import { blobText, buf, editAndCapture, lines, LogRecorder, prep, remoteLiveCode, stateA, treeOf, withCores } from '../helpers/publishHelpers.js';

const T10 = { timeout: 10 * 60_000 };
const WIN = process.platform === 'win32';
const SEAT = 'a'.repeat(32);
const py = (name: string, tag = ''): string => lines(12, (i) => `${name}_${i} = ${i}${i === 4 ? tag : ''}`);
const FILES: Record<string, Buffer> = {
  'README.md': buf('# dependency PIN fixture\n'),
  'settings.ini': buf('[core]\nkey = 1\n'),
  'worker.py': buf(py('worker')),
  'app.py': buf(py('app')),
  '.env': buf('KEY=1\n'),
  'gen/api.ts': buf('export const api = 1;\n'),
  'src/use.ts': buf('export const use = 1;\n'),
  'src/old.py': buf('print("old")\n'),
  'src/other.py': buf(py('other')),
  'a.py': buf(py('a')), 'b.py': buf(py('b')), 'c.py': buf(py('c')), 'x.py': buf(py('x')),
  '.github/workflows/ci.yml': buf('on: push\n'),
};

let tool = 0;
function effect(seat: string, paths: readonly string[]): CsSignal {
  return { kind: 'effect', seat, agent: null, toolUseId: `toolu_${++tool}`, paths, turnOrigin: 'prompt' };
}

/** One publishStep in an open governor window. */
async function publish(fx: CoreFixture, p: PeerFixture): Promise<PublishReport> {
  fx.advance(6_000);
  return publishStep(p.core, await prep(p));
}

/** An ON_DISK ACTIVE PATCH over `path` (h0 = A[path], h1 = the materialized S_disk blob) with `guard`: a creator's record stood in. */
async function holdOn(p: PeerFixture, it: IterationCtx, path: string, guard: string, extra: Partial<NewRecord> = {}): Promise<string> {
  const h1 = it.mat?.sDiskMap.get(path)?.oid ?? it.A.get(path)!.oid;
  return p.core.holds.hold({
    kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: [path], guard, origin: 'daemon', cs_ids: [], displaced_by: null,
    blobs: { h0: { [path]: it.A.get(path)?.oid ?? ABSENT }, h1: { [path]: h1 } }, ...extra,
  });
}

const dependencyPinsOf = (p: PeerFixture): HoldRecord[] => p.core.holds.nonTerminal().filter((r) => r.kind === 'PIN' && r.guards.some((g) => guardName(g) === 'dependency'));

test('D-07 / HLD-42 example: a human CS changing settings.ini (an eol-bom record) and worker.py becomes one PIN dependency:<eol-bom id> over both LIVE paths before P is composed; nothing publishes; EOL_MIXED_HELD {id, path: \'settings.ini\'} is raised once', T10, async () => {
  await withCores('dep-d07', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const log = new LogRecorder();
    p.deps.log = log;
    const tip0 = await remoteLiveCode(fx, p);
    const { pair, it } = await editAndCapture(fx, p, { 'settings.ini': '[core]\r\nkey = 2\r\n', 'worker.py': py('worker', ' # reads key') });
    const eol = await holdOn(p, it, 'settings.ini', 'eol-bom');
    const r = await publish(fx, p);
    assert.equal(r.c, null, `nothing publishes: ${JSON.stringify(r)}`);
    const pins = dependencyPinsOf(p);
    assert.equal(pins.length, 1);
    const pin = pins[0]!;
    assert.deepEqual(r.dependencyPins, [pin.id]);
    assert.deepEqual(pin.paths, ['settings.ini', 'worker.py'], 'both LIVE paths');
    assert.deepEqual(pin.guards.map((g) => g.name), [`dependency:${eol}`]);
    assert.deepEqual([pin.residence, pin.state, pin.local_only, pin.cs_ids], ['ON_DISK', 'ACTIVE', false, [pair.csId]]);
    const R = await p.core.repo.readTreeMap(pair.R);
    assert.ok('h1' in pin.blobs);
    for (const path of pin.paths) {
      assert.equal(pin.blobs.h0[path], it.A.get(path)!.oid, `H0[${path}] = A`);
      assert.equal(pin.blobs.h1[path], R.get(path)!.oid, `H1[${path}] = R`);
    }
    assert.deepEqual(p.core.holdCode, { code: 'EOL_MIXED_HELD', params: { id: eol, path: 'settings.ini' } });
    // Later windows: nothing publishes and the code is not raised again.
    for (let i = 0; i < 3; i++) assert.equal((await publish(fx, p)).c, null);
    assert.equal(log.lines.filter((l) => l.code === 'EOL_MIXED_HELD').length, 1, 'raised once');
    assert.equal(await remoteLiveCode(fx, p), tip0);
    assert.deepEqual(p.core.view!.ready.map((x) => x.csId), [pair.csId], 'the pair stays journaled');
  });
});

test('when the eol-bom guard releases, releaseDependencyGuards releases the dependency guard and both files publish in one commit', T10, async () => {
  await withCores('dep-release', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { it } = await editAndCapture(fx, p, { 'settings.ini': '[core]\r\nkey = 2\r\n', 'worker.py': py('worker', ' # reads key') });
    const eol = await holdOn(p, it, 'settings.ini', 'eol-bom');
    await publish(fx, p);
    const pin = dependencyPinsOf(p)[0]!;
    // R-07's canon-pass release stood in.
    await p.core.holds.releaseGuard(eol, 'eol-bom');
    assert.deepEqual(await releaseDependencyGuards(p.core, await prep(p)), [pin.id]);
    assert.deepEqual(p.core.holds.get(pin.id)!.guards, []);
    const r = await publish(fx, p);
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    assert.ok(r.c !== null);
    const C = await p.core.repo.readCommit(r.c);
    const changed = (await p.core.repo.run(['diff-tree', '--no-commit-id', '--name-only', '-r', C.parents[0]!, r.c])).stdout.toString('utf8').trim().split('\n').sort();
    assert.deepEqual(changed, ['settings.ini', 'worker.py'], 'both files in one commit (HLD-52)');
  });
});

test('PIN paths exclude a local_only record\'s paths: a CS of .env (a secret-like local_only record) and app.py pins only app.py, never joins the local_only record and is itself local_only false', T10, async () => {
  await withCores('dep-localonly', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { it } = await editAndCapture(fx, p, { '.env': 'KEY=2\n', 'app.py': py('app', ' # uses KEY') });
    const env = await holdOn(p, it, '.env', 'revert');
    assert.equal(p.core.holds.get(env)!.local_only, true, 'a secret-like path: the record is local_only');
    const r = await publish(fx, p);
    assert.equal(r.c, null);
    const pins = dependencyPinsOf(p);
    assert.equal(pins.length, 1);
    assert.deepEqual(r.dependencyPins, [pins[0]!.id]);
    assert.deepEqual(pins[0]!.paths, ['app.py']);
    assert.deepEqual(pins[0]!.guards.map((g) => g.name), [`dependency:${env}`]);
    assert.equal(pins[0]!.local_only, false);
    assert.notEqual(pins[0]!.id, env, 'never joined to the local_only record');
    assert.deepEqual(p.core.holds.get(env)!.guards.map((g) => g.name), ['revert']);
  });
});

test('final review F10: a guard-less ON_DISK local_only target still withholds its path whole (MASK step 2), so the dependency PIN is not released and no window re-attaches it: no registry commit, no hold op, no push', T10, async () => {
  await withCores('dep-localonly-churn', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    const tip0 = await remoteLiveCode(fx, p);
    const { it } = await editAndCapture(fx, p, { '.env': 'KEY=3\n', 'app.py': py('app', ' # uses KEY 3') });
    const env = await holdOn(p, it, '.env', 'revert');
    assert.equal((await publish(fx, p)).c, null);
    const pin = dependencyPinsOf(p)[0]!;
    assert.deepEqual(pin.guards.map((g) => g.name), [`dependency:${env}`]);
    // The human's --publish of the revert stood in: the guard releases; the record stays ON_DISK and local_only (a secret-like path).
    await core.holds.releaseGuard(env, 'revert');
    const e = core.holds.get(env)!;
    assert.deepEqual([e.guards, e.residence, e.state, e.local_only], [[], 'ON_DISK', 'ACTIVE', true]);
    // Two windows land the hold ops that are already due (the record's stub rev).
    for (let i = 0; i < 2; i++) assert.equal((await publish(fx, p)).c, null);
    const head = core.holds.head();
    const rev = core.holds.get(pin.id)!.rev;
    const board = await remoteTip(fx, p);
    for (let w = 0; w < 3; w++) {
      assert.deepEqual(await releaseDependencyGuards(core, await prep(p)), [], `window ${w}: .env is still withheld whole by its local_only record`);
      const r = await publish(fx, p);
      assert.deepEqual([r.c, r.dependencyPins], [null, []], `window ${w}: nothing publishes, no PIN attach: ${JSON.stringify(r)}`);
    }
    assert.deepEqual(core.holds.get(pin.id)!.guards.map((g) => g.name), [`dependency:${env}`], 'the PIN keeps holding the group');
    assert.equal(core.holds.get(pin.id)!.rev, rev, 'no new PIN rev');
    assert.equal(core.holds.head(), head, 'no registry commit');
    assert.equal(await remoteTip(fx, p), board, 'no board push (02 §3.8: push only on change)');
    assert.equal(await remoteLiveCode(fx, p), tip0);
  });
});

test('later loops attach to the same dependency PIN and no second PIN is made over a held PIN\'s group', T10, async () => {
  await withCores('dep-attach', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { it } = await editAndCapture(fx, p, { 'settings.ini': '[core]\r\nkey = 3\r\n', 'worker.py': py('worker', ' # key 3') });
    const eol = await holdOn(p, it, 'settings.ini', 'eol-bom');
    await publish(fx, p);
    const pin = dependencyPinsOf(p)[0]!;
    for (let i = 0; i < 3; i++) assert.deepEqual((await publish(fx, p)).dependencyPins, [], `window ${i}: the group is held, no second PIN`);
    assert.equal(dependencyPinsOf(p).length, 1);
    // The PIN's guard released while the eol-bom record still withholds settings.ini: the next loop attaches to the same PIN.
    await p.core.holds.releaseGuard(pin.id, `dependency:${eol}`);
    const r = await publish(fx, p);
    assert.deepEqual(r.dependencyPins, [pin.id], 'HLD-07: the same record');
    assert.equal(r.c, null);
    assert.equal(dependencyPinsOf(p).length, 1);
    assert.deepEqual(p.core.holds.get(pin.id)!.guards.map((g) => g.name), [`dependency:${eol}`]);
  });
});

test('a path-class mask, a step-5 PATCH mask and a K4 TAKE_TIP OFF_DISK record do not pin the group: the rest publishes', T10, async () => {
  await withCores('dep-exceptions', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    // (a) A seat CS holding a QUARANTINED path beside a LIVE one: MASK step 1 resets the path class, a.py publishes.
    await writeWork(p, '.github/workflows/ci.yml', 'on: [push, pull_request]\n');
    await writeWork(p, 'a.py', py('a', ' # seat'));
    queueSignal(core, effect(SEAT, ['.github/workflows/ci.yml', 'a.py']));
    await prep(p);
    queueSignal(core, { kind: 'stop', seat: SEAT });
    await captureStep(core, await prep(p, true));
    let r = await publish(fx, p);
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    assert.deepEqual(r.dependencyPins, []);
    let tree = await treeOf(p, r.c! as Oid);
    assert.equal((await core.repo.readBlob(tree.get('a.py')!.oid)).toString('utf8'), py('a', ' # seat'));
    assert.equal((await core.repo.readBlob(tree.get('.github/workflows/ci.yml')!.oid)).toString('utf8'), 'on: push\n');
    // (b) A step-5 PATCH on b.py's row 4 beside a change of c.py and of b.py's row 10: the PATCH withholds its row only.
    const { it } = await editAndCapture(fx, p, { 'b.py': py('b', ' # held row').replace('b_10 = 10', 'b_10 = 100'), 'c.py': py('c', ' # c') });
    await core.holds.hold({
      kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: ['b.py'], guard: 'revert', origin: 'human', cs_ids: [], displaced_by: null,
      blobs: { h0: { 'b.py': it.A.get('b.py')!.oid }, h1: { 'b.py': await core.repo.hashBytes(buf(py('b', ' # held row')), true) } },
    });
    r = await publish(fx, p);
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    assert.deepEqual(r.dependencyPins, []);
    tree = await treeOf(p, r.c! as Oid);
    assert.equal((await core.repo.readBlob(tree.get('b.py')!.oid)).toString('utf8'), py('b').replace('b_10 = 10', 'b_10 = 100'), 'the unheld row publishes');
    assert.equal((await core.repo.readBlob(tree.get('c.py')!.oid)).toString('utf8'), py('c', ' # c'));
    // (c) An OFF_DISK CONFLICTED K4 record (a TAKE_TIP displacement) on x.py beside a change of worker.py.
    const k = await editAndCapture(fx, p, { 'x.py': py('x', ' # local'), 'worker.py': py('worker', ' # w') });
    await core.holds.hold({
      kind: 'PATCH', residence: 'OFF_DISK', state: 'CONFLICTED', paths: ['x.py'], guard: 'conflict', origin: 'daemon', cs_ids: [k.pair.csId], displaced_by: null,
      blobs: { s1: { 'x.py': k.it.A.get('x.py')!.oid }, s2: { 'x.py': k.it.mat!.sDiskMap.get('x.py')!.oid }, s3: { 'x.py': k.it.A.get('x.py')!.oid } },
    });
    r = await publish(fx, p);
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    assert.deepEqual(r.dependencyPins, [], 'INV-HLD-ATOMIC-PUB exception (c)');
    tree = await treeOf(p, r.c! as Oid);
    assert.equal((await core.repo.readBlob(tree.get('worker.py')!.oid)).toString('utf8'), py('worker', ' # w'));
    assert.equal(dependencyPinsOf(p).length, 0);
  });
});

test('TC-HLD-10 dependency half / I-DAT-20 PIN half: a CS touching gen/api.ts (a generated? record) and src/use.ts is PINned dependency:<generated? id> and nothing of it publishes', T10, async () => {
  await withCores('dep-generated', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const tip0 = await remoteLiveCode(fx, p);
    const { it } = await editAndCapture(fx, p, { 'gen/api.ts': 'export const api = 2;\n', 'src/use.ts': 'export const use = api;\n' });
    const gen = await holdOn(p, it, 'gen/api.ts', 'generated?');
    const r = await publish(fx, p);
    assert.equal(r.c, null);
    const pins = dependencyPinsOf(p);
    assert.equal(pins.length, 1);
    assert.deepEqual(pins[0]!.guards.map((g) => g.name), [`dependency:${gen}`]);
    assert.deepEqual(pins[0]!.paths, ['gen/api.ts', 'src/use.ts']);
    for (let i = 0; i < 2; i++) assert.equal((await publish(fx, p)).c, null);
    assert.equal(await remoteLiveCode(fx, p), tip0, 'nothing of the CS publishes');
  });
});

// The non-portable new name a record can carry (stageable(), Task 7's host names) and one no record can carry (R3-53).
const NAME = WIN ? `src/${'\u{d55c}'.repeat(100)}.py` : 'src/con.py';
const BAD = WIN ? 'src/.g\u{200c}it/old_v2.py' : 'src/old:v2.py';

/** A detection tick (advance first) and portabilityStep, as the loop's detect step runs them (Task 12a). */
async function tickPort(fx: CoreFixture, p: PeerFixture, ms = 2_500, materialize = false): Promise<IterationCtx> {
  fx.advance(ms);
  const it = await prep(p, materialize);
  await portabilityStep(p.core, it);
  return it;
}

test('DAT-32: a human move of src/old.py to the non-portable name never publishes the deletion of src/old.py alone', T10, async () => {
  await withCores('dep-dat32', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    const tip0 = await remoteLiveCode(fx, p);
    await prep(p);
    await rename(workPath(p, 'src/old.py'), workPath(p, NAME));
    let it = await tickPort(fx, p);
    it = await tickPort(fx, p, 1_500);   // the deletion is confirmed by a second read ≥ 1 s later
    const port = core.holds.nonTerminal().find((r) => r.guards.some((g) => guardName(g) === 'portability'));
    assert.ok(port !== undefined, 'the portability record');
    // The human CS holds the deletion of src/old.py and the record's path (R3-35): captured after 20 s quiet.
    fx.advance(20_000);
    it = await prep(p, true);
    await portabilityStep(core, it);
    assert.ok((await captureStep(core, it)).captured.length > 0);
    const r = await publish(fx, p);
    const pins = dependencyPinsOf(p);
    assert.equal(pins.length, 1);
    assert.deepEqual(r.dependencyPins, [pins[0]!.id]);
    assert.deepEqual(pins[0]!.guards.map((g) => g.name), [`dependency:${port.id}`]);
    assert.deepEqual(pins[0]!.paths, ['src/old.py']);
    for (let i = 0; i < 2; i++) await publish(fx, p);
    assert.equal(await remoteLiveCode(fx, p), tip0, 'the live chain keeps src/old.py');
    const tree = await treeOf(p, (await remoteLiveCode(fx, p)) as Oid);
    assert.ok(tree.has('src/old.py'));
  });
});

test('R3-53: a move of src/old.py to src/old:v2.py publishes nothing while the bad name exists, and the fix publishes the move in one commit', T10, async () => {
  await withCores('dep-r353', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    const tip0 = await remoteLiveCode(fx, p);
    await prep(p);
    const regHead = core.holds.head();
    const board0 = await remoteTip(fx, p);
    const pending: boolean[] = [];
    const orig = core.governor.onFetch.bind(core.governor);
    core.governor.onFetch = (tip, revealed, first, pend): void => {
      pending.push(pend);
      orig(tip, revealed, first, pend);
    };
    await mkdir(dirname(workPath(p, BAD)), { recursive: true });
    await rename(workPath(p, 'src/old.py'), workPath(p, BAD));
    await tickPort(fx, p);
    await tickPort(fx, p, 1_500);
    // A further human edit meanwhile, then 20 s quiet: both human captures wait behind the gate.
    await writeWork(p, 'src/other.py', py('other', ' # meanwhile'));
    await tickPort(fx, p);
    fx.advance(20_000);
    const it = await prep(p, true);
    await portabilityStep(core, it);
    await captureStep(core, it);
    assert.deepEqual([...core.cs.blocked()], [BAD]);
    const groups = core.cs.groups(heldPins(core.holds));
    assert.ok(groups.length > 0 && groups.every((g) => !g.ready), JSON.stringify(groups));
    assert.ok(core.cs.ready().some((x) => x.paths.includes('src/old.py')), 'the human CS holding the deletion is captured');
    assert.ok(core.cs.ready().some((x) => x.paths.includes('src/other.py')));
    // A seat CS's group (no human or recovered CS) publishes while the set is non-empty: the gate holds back the human side only.
    await writeWork(p, 'x.py', py('x', ' # seat'));
    queueSignal(core, effect(SEAT, ['x.py']));
    await tickPort(fx, p);
    queueSignal(core, { kind: 'stop', seat: SEAT });
    const it2 = await tickPort(fx, p, 100, true);
    await captureStep(core, it2);
    const seatPub = await publish(fx, p);
    assert.equal(seatPub.outcome, 'landed', JSON.stringify(seatPub));
    const seatTree = await treeOf(p, seatPub.c! as Oid);
    assert.equal((await core.repo.readBlob(seatTree.get('x.py')!.oid)).toString('utf8'), py('x', ' # seat'));
    assert.ok(seatTree.has('src/old.py'), 'the seat publish carries no deletion');
    const tip1 = await remoteLiveCode(fx, p);
    // 10 windows: nothing of the human side publishes.
    for (let i = 0; i < 10; i++) {
      fx.advance(6_000);
      const w = await prep(p);
      await portabilityStep(core, w);
      assert.equal(await publishPending(core, w), false, `window ${i}: publishPending`);
      const rr = await publishStep(core, w);
      assert.notEqual(rr.outcome, 'landed', `window ${i}`);
    }
    assert.ok(pending.slice(-10).every((x) => !x), 'the governor\'s pending is false');
    assert.equal(await remoteLiveCode(fx, p), tip1, 'no live commit changes src/old.py');
    assert.equal(core.holds.head(), regHead, 'no registry record');
    assert.equal((await holdOpsSince(p, board0, await remoteTip(fx, p))).length, 0, 'no hold op on the board');
    assert.equal(core.holdCode?.code, 'PATH_NOT_PORTABLE');
    assert.notEqual(tip1, tip0, 'the seat publish landed before the windows');
    // The fix: a portable name. At the next tick the set is empty; the deletion and the new file publish in one commit.
    await rename(workPath(p, BAD), workPath(p, 'src/old_v2.py'));
    await tickPort(fx, p);
    assert.deepEqual([...core.cs.blocked()], []);
    fx.advance(20_000);
    const it3 = await prep(p, true);
    await portabilityStep(core, it3);
    await captureStep(core, it3);
    const fixed = await publish(fx, p);
    assert.equal(fixed.outcome, 'landed', JSON.stringify(fixed));
    const C = await core.repo.readCommit(fixed.c!);
    const changed = (await core.repo.run(['diff-tree', '--no-commit-id', '--name-status', '-r', C.parents[0]!, fixed.c!])).stdout.toString('utf8').trim().split('\n').sort();
    assert.deepEqual(changed, ['A\tsrc/old_v2.py', 'D\tsrc/old.py', 'M\tsrc/other.py'].sort());
  });
});

test('a dependency guard releases when its target record ends GONE', T10, async () => {
  await withCores('dep-gone', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { it } = await editAndCapture(fx, p, { 'settings.ini': '[core]\r\nkey = 4\r\n', 'worker.py': py('worker', ' # 4') });
    const eol = await holdOn(p, it, 'settings.ini', 'eol-bom');
    await publish(fx, p);
    const pin = dependencyPinsOf(p)[0]!;
    assert.deepEqual(await releaseDependencyGuards(p.core, await prep(p)), [], 'the target still withholds');
    await p.core.holds.transition(eol, { state: 'GONE' });
    assert.deepEqual(await releaseDependencyGuards(p.core, await prep(p)), [pin.id]);
    assert.deepEqual(p.core.holds.get(pin.id)!.guards, []);
  });
});

test('a human CS whose only path is a portability record\'s creates no dependency PIN', T10, async () => {
  await withCores('dep-portonly', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    const calls: NewRecord[] = [];
    const orig = core.holds.hold.bind(core.holds);
    core.holds.hold = async (n) => {
      calls.push(n);
      return orig(n);
    };
    await prep(p);
    await writeWork(p, NAME, 'print(1)\n');
    await tickPort(fx, p);
    const port = core.holds.nonTerminal().find((r) => r.guards.some((g) => guardName(g) === 'portability'));
    assert.ok(port !== undefined);
    const head = core.holds.head();
    const tip0 = await remoteLiveCode(fx, p);
    fx.advance(20_000);
    const it = await prep(p, true);
    await portabilityStep(core, it);
    await captureStep(core, it);
    for (let i = 0; i < 3; i++) {
      const r = await publish(fx, p);
      assert.deepEqual(r.dependencyPins, []);
      assert.equal(r.c, null);
    }
    assert.equal(dependencyPinsOf(p).length, 0, 'no dependency PIN');
    assert.equal(core.holds.head(), head, 'no registry commit');
    assert.equal(await remoteLiveCode(fx, p), tip0, 'nothing pushed for the group');
    assert.ok(calls.length >= 1 && calls.every((n) => n.paths.length > 0), 'hold() is never called with paths: []');
    await unlink(workPath(p, NAME)).catch(() => undefined);
  });
});

test('Task EF (item 1): DAT-32 with a recorded name — a human CS of NAME (a portability record) and src/other.py is PINned dependency:<portability id>; renaming NAME to src/fixed.py ends the record, and src/other.py publishes with src/fixed.py in one commit once the fixed name\'s CS is captured (R3-53\'s latch), never alone in the window after the PIN releases', T10, async () => {
  await withCores('dep-np-fix', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    const tip0 = await remoteLiveCode(fx, p);
    await prep(p);
    await writeWork(p, NAME, 'print("not portable")\n');
    await writeWork(p, 'src/other.py', py('other', ' # beside the bad name'));
    await tickPort(fx, p);
    const port = core.holds.nonTerminal().find((r) => r.guards.some((g) => guardName(g) === 'portability'));
    assert.ok(port !== undefined, 'the portability record');
    // The human CS closes after 20 s quiet: its pair (src/other.py) is journaled and the group is PINned (HLD-42).
    fx.advance(20_000);
    let it = await prep(p, true);
    await portabilityStep(core, it);
    assert.ok((await captureStep(core, it)).captured.length > 0);
    assert.equal((await publish(fx, p)).c, null, 'no code commit (a board-only push may carry the hold ops)');
    const pins = dependencyPinsOf(p);
    assert.equal(pins.length, 1);
    assert.deepEqual([pins[0]!.guards.map((g) => g.name), pins[0]!.paths], [[`dependency:${port.id}`], ['src/other.py']]);
    assert.equal(await remoteLiveCode(fx, p), tip0);
    // The fix: a portable name. The next tick observes src/fixed.py into a new human CS and ends the record (the name left the disk);
    // recordStep's releaseDependencyGuards releases the PIN in that loop.
    await rename(workPath(p, NAME), workPath(p, 'src/fixed.py'));
    it = await tickPort(fx, p);
    assert.equal(core.holds.get(port.id)!.state, 'GONE');
    assert.ok(core.cs.openPaths().has('src/fixed.py'), 'the fixed name opened a human CS');
    assert.deepEqual(await releaseDependencyGuards(core, it), [pins[0]!.id]);
    // The windows before that CS's capture publish nothing of the group: the deletion-free other half never goes alone (DAT-32).
    for (let i = 0; i < 2; i++) {
      const w = await publish(fx, p);
      assert.equal(w.c, null, `window ${i}: no code commit: ${JSON.stringify(w)}`);
    }
    assert.equal(await remoteLiveCode(fx, p), tip0, 'src/other.py waits for the fixed name');
    // The fixed name's CS closes and is captured: both publish in one commit.
    fx.advance(20_000);
    it = await prep(p, true);
    await portabilityStep(core, it);
    await captureStep(core, it);
    const fixed = await publish(fx, p);
    assert.equal(fixed.outcome, 'landed', JSON.stringify(fixed));
    const C = await core.repo.readCommit(fixed.c!);
    const changed = (await core.repo.run(['diff-tree', '--no-commit-id', '--name-status', '-r', C.parents[0]!, fixed.c!])).stdout.toString('utf8').trim().split('\n').sort();
    assert.deepEqual(changed, ['A\tsrc/fixed.py', 'M\tsrc/other.py']);
    assert.equal(changed.some((l) => l.includes(NAME)), false, 'the non-portable name never reaches the live tree');
  });
});

// ---- EF3: the status half (HLD-24, R3-46, R3-53, INV-NOSILENT) -------------------------------------------------------------------

/** R3-53's cause for a path of a group the gate (or its latch) keeps back (Task 12a). */
const GATE: NotConvergedWhy = { cause: 'blocked_publish', guard: 'portability' };
/** Plan 3's not_converged causes (holdStatusInputs without Plan 2's base) of `paths`; null for a path not listed. */
const causesOf = (p: PeerFixture, paths: readonly string[]): Record<string, NotConvergedWhy | null> =>
  Object.fromEntries(paths.map((x) => [x, holdStatusInputs(p.core, null).notConvergedCauses.get(x) ?? null]));
/** One materializing iteration, then R1 over every path (a landed publish moved A): the loop's recordStep half that ends records. */
async function r1(p: PeerFixture): Promise<void> {
  const it = await prep(p, true);
  await evaluateRecords(p.core, it, new Set(it.A.keys()), []);
}

test('EF3 (R3-53, R3-46, INV-NOSILENT): after a recorded name\'s fix releases its dependency PIN, the windows R3-53\'s latch keeps src/other.py back list it and src/fixed.py in not_converged as blocked_publish (guard portability); once both landed and R1 ran, the PIN is SUBSUMED and neither is listed', T10, async () => {
  await withCores('dep-np-latch', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    await prep(p);
    await writeWork(p, NAME, 'print("not portable")\n');
    await writeWork(p, 'src/other.py', py('other', ' # beside the bad name'));
    await tickPort(fx, p);
    const port = core.holds.nonTerminal().find((r) => r.guards.some((g) => guardName(g) === 'portability'));
    assert.ok(port !== undefined, 'the portability record');
    fx.advance(20_000);
    let it = await prep(p, true);
    await portabilityStep(core, it);
    assert.ok((await captureStep(core, it)).captured.length > 0);
    assert.equal((await publish(fx, p)).c, null, 'no code commit');
    const pin = dependencyPinsOf(p)[0]!;
    assert.deepEqual(causesOf(p, ['src/other.py']), { 'src/other.py': { cause: 'blocked_publish', guard: 'dependency' } }, 'the held PIN lists its path');
    // The fix: the tick ends the record and latches R3-53's gate on the fixed name's open CS; recordStep releases the PIN.
    await rename(workPath(p, NAME), workPath(p, 'src/fixed.py'));
    it = await tickPort(fx, p);
    assert.equal(core.holds.get(port.id)!.state, 'GONE');
    assert.deepEqual(await releaseDependencyGuards(core, it), [pin.id]);
    const rel = core.holds.get(pin.id)!;
    assert.deepEqual([rel.guards, rel.residence, rel.state], [[], 'ON_DISK', 'ACTIVE'], 'released (R3-17)');
    assert.equal(core.cs.ready().some((x) => x.paths.includes('src/other.py')), true, 'its pair is ready');
    assert.deepEqual(causesOf(p, ['src/other.py', 'src/fixed.py']), { 'src/other.py': GATE, 'src/fixed.py': GATE }, 'the latch keeps both groups back: listed');
    for (let i = 0; i < 2; i++) {
      const w = await publish(fx, p);
      assert.equal(w.c, null, `window ${i}: no code commit: ${JSON.stringify(w)}`);
      assert.deepEqual(causesOf(p, ['src/other.py', 'src/fixed.py']), { 'src/other.py': GATE, 'src/fixed.py': GATE }, `window ${i}: still listed`);
    }
    // The fixed name's CS closes and is captured: the latch lets go, both publish in one commit, and R1 ends the released PIN.
    fx.advance(20_000);
    it = await prep(p, true);
    await portabilityStep(core, it);
    await captureStep(core, it);
    const fixed = await publish(fx, p);
    assert.equal(fixed.outcome, 'landed', JSON.stringify(fixed));
    await r1(p);
    assert.equal(core.holds.get(pin.id)!.state, 'SUBSUMED', 'the released PIN ends once its pair landed');
    assert.deepEqual(causesOf(p, ['src/other.py', 'src/fixed.py']), { 'src/other.py': null, 'src/fixed.py': null }, 'nothing left listed');
  });
});

test('EF3 (R3-53, INV-NOSILENT): a name no record can carry — after its fix, the windows R3-53\'s latch keeps the human side back list src/old.py, src/other.py and src/old_v2.py in not_converged as blocked_publish (guard portability); once the move landed none is', T10, async () => {
  await withCores('dep-r353-latch', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    await prep(p);
    await mkdir(dirname(workPath(p, BAD)), { recursive: true });
    await rename(workPath(p, 'src/old.py'), workPath(p, BAD));
    await tickPort(fx, p);
    await tickPort(fx, p, 1_500);
    await writeWork(p, 'src/other.py', py('other', ' # meanwhile'));
    await tickPort(fx, p);
    fx.advance(20_000);
    let it = await prep(p, true);
    await portabilityStep(core, it);
    await captureStep(core, it);
    assert.deepEqual([...core.cs.blocked()], [BAD]);
    assert.equal(core.holds.nonTerminal().length, 0, 'no record');
    assert.deepEqual(causesOf(p, ['src/old.py', 'src/other.py']), { 'src/old.py': GATE, 'src/other.py': GATE }, 'while blocked: listed (Task 12a)');
    // The fix: a portable name. The set empties at the next tick, which latches the gate on the new name's open CS.
    await rename(workPath(p, BAD), workPath(p, 'src/old_v2.py'));
    it = await tickPort(fx, p);
    assert.deepEqual([...core.cs.blocked()], []);
    const all = ['src/old.py', 'src/other.py', 'src/old_v2.py'];
    const held = { 'src/old.py': GATE, 'src/other.py': GATE, 'src/old_v2.py': GATE };
    assert.deepEqual(causesOf(p, all), held, 'the latch keeps the human side back: listed');
    for (let i = 0; i < 2; i++) {
      const w = await publish(fx, p);
      assert.equal(w.c, null, `window ${i}: no code commit: ${JSON.stringify(w)}`);
      assert.deepEqual(causesOf(p, all), held, `window ${i}: still listed`);
    }
    fx.advance(20_000);
    it = await prep(p, true);
    await portabilityStep(core, it);
    await captureStep(core, it);
    const fixed = await publish(fx, p);
    assert.equal(fixed.outcome, 'landed', JSON.stringify(fixed));
    assert.deepEqual(causesOf(p, all), { 'src/old.py': null, 'src/other.py': null, 'src/old_v2.py': null }, 'nothing left listed');
  });
});

test('EF3 (HLD-24, R3-46, R3-61): a released dependency PIN and its released target (guards [], ON_DISK ACTIVE) keep their paths in not_converged until their pair landed and R1 ended them; a guard-less ON_DISK CONFLICTED record is listed and an OFF_DISK one is not; diverged counts only records with a guard; a code naming a released record clears at the status write, one naming the CONFLICTED record stays', T10, async () => {
  await withCores('dep-released', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    const { it } = await editAndCapture(fx, p, { 'settings.ini': '[core]\r\nkey = 5\r\n', 'worker.py': py('worker', ' # reads key 5') });
    const eol = await holdOn(p, it, 'settings.ini', 'eol-bom');
    await publish(fx, p);
    const pin = dependencyPinsOf(p)[0]!;
    await core.holds.releaseGuard(eol, 'eol-bom');   // the canon-pass release of R-07 stood in
    assert.deepEqual(await releaseDependencyGuards(core, await prep(p)), [pin.id]);
    for (const id of [eol, pin.id]) {
      const r = core.holds.get(id)!;
      assert.deepEqual([r.guards, r.residence, r.state], [[], 'ON_DISK', 'ACTIVE'], `${id} released`);
    }
    const listed = (): string[] => ['settings.ini', 'worker.py'].filter((x) => holdStatusInputs(core, null).notConvergedCauses.get(x)?.cause === 'blocked_publish');
    assert.deepEqual(listed(), ['settings.ini', 'worker.py'], 'HLD-24: every path of every ON_DISK record');
    assert.equal(holdStatusInputs(core, null).diverged, null, 'diverged counts only records with a guard (contract addition 4)');
    core.holdCode = { code: 'HOLD_RESTORED', params: { hid: pin.id, path: 'worker.py' } };
    settleHoldCode(core, holdStatusInputs(core, null).notConvergedCauses);
    assert.equal(core.holdCode, null, 'a code naming a released record clears at once (R3-61)');
    const landed = await publish(fx, p);
    assert.equal(landed.outcome, 'landed', JSON.stringify(landed));
    assert.deepEqual(listed(), ['settings.ini', 'worker.py'], 'landed, R1 not yet run: the records still wait');
    await r1(p);
    assert.deepEqual([core.holds.get(eol)!.state, core.holds.get(pin.id)!.state], ['SUBSUMED', 'SUBSUMED'], 'R1 ends both once A carries their content');
    assert.deepEqual(listed(), [], 'nothing left listed');
    // A guard-less record MASK still withholds whole (an ON_DISK CONFLICTED one, HLD-42, R3-17 (b)) is listed; an OFF_DISK one is not.
    const it2 = await prep(p, true);
    const conflicted = await holdOn(p, it2, 'app.py', 'revert');
    await core.holds.releaseGuard(conflicted, 'revert');
    await core.holds.transition(conflicted, { state: 'CONFLICTED' });
    const parked = await holdOn(p, it2, 'a.py', 'revert');
    await core.holds.releaseGuard(parked, 'revert');
    await core.holds.transition(parked, { residence: 'OFF_DISK', state: 'PARKED' });
    const s = holdStatusInputs(core, null);
    assert.deepEqual(s.notConvergedCauses.get('app.py'), { cause: 'blocked_publish', guard: 'patch' }, 'the guard-less CONFLICTED record');
    assert.equal(s.notConvergedCauses.has('a.py'), false, 'never an OFF_DISK record (HLD-24)');
    assert.equal(s.diverged, null);
    core.holdCode = { code: 'HOLD_CONFLICTED', params: { path: 'app.py', author: null, hid: conflicted } };
    settleHoldCode(core, s.notConvergedCauses);
    assert.equal(core.holdCode?.code, 'HOLD_CONFLICTED', 'a code naming the CONFLICTED record stays while it withholds');
  });
});

// ---- final review F4: restore markers never enter a PIN built from R (05 §3.4 items 3–4, DAT-46, HLD-42, HLD-45) ----------------

const M = 'm.txt';
const Z = 'z.txt';
/** A conflicted RESTORE's file on disk: `cowork:` restore-marker rows (DAT-45). */
const MARKED = 'm1\n<<<<<<< cowork:disk\nm2 local\n||||||| cowork:base\nm2\n=======\nm2 held\n>>>>>>> cowork:held\nm3\n';
const MFILES: Record<string, Buffer> = { ...FILES, [M]: buf('m1\nm2\nm3\n'), [Z]: buf('z1\n') };

/** The record a conflicted RESTORE leaves (HLD-17): ON_DISK ACTIVE PATCH, its own clean held side, guard `markers` (whole-path). */
async function markersRecord(p: PeerFixture, path: string): Promise<string> {
  const A = await stateA(p);
  return p.core.holds.hold({
    kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: [path], guard: 'markers', origin: 'human', cs_ids: [], displaced_by: null,
    blobs: { h0: { [path]: A.get(path)!.oid }, h1: { [path]: await p.core.repo.hashBytes(buf('m1\nm2 held\nm3\n'), true) } },
  });
}

/** Every non-terminal record's side blob that holds a restore-marker row, as `id:path`. */
async function markedRecordBlobs(p: PeerFixture): Promise<string[]> {
  const out: string[] = [];
  for (const r of p.core.holds.nonTerminal()) {
    for (const side of Object.values(r.blobs) as Array<Record<string, string>>) {
      for (const [path, oid] of Object.entries(side)) {
        if (oid !== ABSENT && hasRestoreMarkerRow(await p.core.repo.readBlob(oid as Oid))) out.push(`${r.id}:${path}`);
      }
    }
  }
  return out;
}

/** N publish windows; the aborted ones as [why, assert]. */
async function windows(fx: CoreFixture, p: PeerFixture, n: number): Promise<Array<[string | null, PublishReport['assert']]>> {
  const aborted: Array<[string | null, PublishReport['assert']]> = [];
  for (let i = 0; i < n; i++) {
    const r = await publish(fx, p);
    if (r.outcome === 'aborted') aborted.push([r.why, r.assert]);
  }
  return aborted;
}

/** An unrelated later human edit of z.txt publishes while the markers record still withholds m.txt; m.txt stays A on the live chain. */
async function unrelatedEditPublishes(fx: CoreFixture, p: PeerFixture): Promise<void> {
  await editAndCapture(fx, p, { [Z]: 'z1 edited\n' });
  let landed: PublishReport | null = null;
  for (let i = 0; i < 3 && landed === null; i++) {
    const r = await publish(fx, p);
    assert.notEqual(r.outcome, 'aborted', JSON.stringify(r));
    if (r.c !== null) landed = r;
  }
  assert.ok(landed !== null, 'the unrelated edit publishes');
  const tree = await treeOf(p, landed.c!);
  assert.equal(await blobText(p, tree, Z), 'z1 edited\n');
  assert.equal(await blobText(p, tree, M), 'm1\nm2\nm3\n', 'the marker file never reaches the live chain');
}

test('final review F4 (HLD-42, DAT-46): a group whose m.txt a markers record withholds is PINned dependency:<id> over its other LIVE paths only; the restore-marker rows never enter the PIN\'s held side, no window aborts with ENG-41 (j), and an unrelated later edit publishes', T10, async () => {
  await withCores('dep-markers', { n: 1, files: MFILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prep(p);
    const mk = await markersRecord(p, M);
    const { pair } = await editAndCapture(fx, p, { [M]: MARKED, 'worker.py': py('worker', ' # beside the marker file') });
    assert.deepEqual(await windows(fx, p, 4), [], 'no window aborts');
    const pins = dependencyPinsOf(p);
    assert.equal(pins.length, 1);
    assert.deepEqual([pins[0]!.paths, pins[0]!.guards.map((g) => g.name), pins[0]!.cs_ids], [['worker.py'], [`dependency:${mk}`], [pair.csId]], 'm.txt stays only in its own record');
    assert.deepEqual(await markedRecordBlobs(p), [], 'no record side carries a restore-marker row');
    assert.deepEqual(p.core.view!.ready.map((x) => x.csId), [pair.csId], 'the pair stays journaled');
    await unrelatedEditPublishes(fx, p);
    assert.equal(p.core.holds.get(mk)!.residence, 'ON_DISK');
    for (const b of await remoteCoworkBlobs(fx)) assert.equal(hasRestoreMarkerRow(b), false, 'no restore-marker row in refs/cowork/*');
  });
});

test('final review F4 (HLD-49, DAT-46): a later CS on the markers-withheld m.txt (rows still on disk) joins the group\'s dependency PIN without bringing m.txt into it; no window aborts with ENG-41 (j)', T10, async () => {
  await withCores('dep-markers-join', { n: 1, files: MFILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    await prep(p);
    await markersRecord(p, M);
    const { pair } = await editAndCapture(fx, p, { [M]: MARKED, 'worker.py': py('worker', ' # beside the marker file') });
    assert.deepEqual(await windows(fx, p, 2), [], 'no window aborts');
    const pin = dependencyPinsOf(p)[0]!;
    assert.deepEqual(pin.paths, ['worker.py']);
    // The human goes on resolving: a second save of m.txt that still has restore-marker rows, closed by its quiet period. Its CS
    // shares m.txt with the pinned group, so captureStep bundles it into the PIN (HLD-49).
    await writeWork(p, M, MARKED.replace('m2 local', 'm2 local, second try'));
    await prep(p);
    fx.advance(20_000);
    await captureStep(core, await prep(p, true));
    const grown = core.holds.get(pin.id)!;
    assert.equal(grown.cs_ids.length, 2, `the second CS joined the PIN: ${JSON.stringify(grown.cs_ids)} (pair ${pair.csId})`);
    assert.deepEqual(grown.paths, ['worker.py'], 'm.txt stays only in its own record');
    assert.deepEqual(await markedRecordBlobs(p), [], 'no record side carries a restore-marker row');
    assert.deepEqual(await windows(fx, p, 3), [], 'no window aborts');
    for (const b of await remoteCoworkBlobs(fx)) assert.equal(hasRestoreMarkerRow(b), false, 'no restore-marker row in refs/cowork/*');
  });
});

test('final review F4 (HLD-42): a CS whose only path a markers record withholds gets no PIN (nothing LIVE is left to pin) and waits for the window; no window aborts with ENG-41 (j)', T10, async () => {
  await withCores('dep-markers-one', { n: 1, files: MFILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prep(p);
    await markersRecord(p, M);
    const { pair } = await editAndCapture(fx, p, { [M]: MARKED });
    assert.deepEqual(await windows(fx, p, 4), [], 'no window aborts');
    assert.equal(dependencyPinsOf(p).length, 0, 'no dependency PIN');
    assert.deepEqual(await markedRecordBlobs(p), []);
    assert.deepEqual(p.core.view!.ready.map((x) => x.csId), [pair.csId], 'the pair stays journaled');
    await unrelatedEditPublishes(fx, p);
    for (const b of await remoteCoworkBlobs(fx)) assert.equal(hasRestoreMarkerRow(b), false, 'no restore-marker row in refs/cowork/*');
  });
});

test('final review F4 (HLD-45, DAT-46): a gate block on a group with a markers-withheld m.txt makes the claim PIN over the group\'s other LIVE paths only; no window aborts with ENG-41 (j)', T10, async () => {
  const CLAIM = 'abcdefghij234567';
  const gate: PublishGatePort = {
    gate: async (_repo, _tip, _A, _R, paths) => (paths.includes(M) ? { block: { claimId: CLAIM } } : { block: null }),
    claimStillBlocks: async () => true,
  };
  await withCores('dep-markers-claim', { n: 1, files: MFILES, ports: { gate } }, async (fx) => {
    const p = fx.peers[0]!;
    await prep(p);
    await markersRecord(p, M);
    const { pair } = await editAndCapture(fx, p, { [M]: MARKED, 'worker.py': py('worker', ' # beside the marker file') });
    assert.deepEqual(await windows(fx, p, 4), [], 'no window aborts');
    const claims = p.core.holds.nonTerminal().filter((r) => r.kind === 'PIN' && r.guards.some((g) => g.name === `claim:${CLAIM}`));
    assert.equal(claims.length, 1);
    assert.deepEqual([claims[0]!.paths, claims[0]!.cs_ids], [['worker.py'], [pair.csId]], 'm.txt stays only in its own record');
    assert.deepEqual(await markedRecordBlobs(p), []);
    await unrelatedEditPublishes(fx, p);
    for (const b of await remoteCoworkBlobs(fx)) assert.equal(hasRestoreMarkerRow(b), false, 'no restore-marker row in refs/cowork/*');
  });
});

// ---- final review r2 B-2 (ruling R3-FF2-B2; HLD-45, HLD-50, HLD-42, INV-SECRET): no PIN built from R takes a local_only record's path -----
// The iteration's scope classes a path of a non-terminal ON_DISK local_only record LOCAL_ONLY (D5 row 9, R3-21) only when the record
// existed when prepareIteration built it: a record a step of the same iteration makes (detectStep's revert detector runs after the
// scope) leaves its path LIVE until the next iteration, so the PIN's LIVE-path filter alone does not keep it out. The tests stand that
// in: the record is made after `prep`, and publishStep runs on that iteration.

/** A local_only record's bytes: a stood-in plaintext that a failed clean filter left (Plan 7 creates filter-failure records; the registry accepts them, R3-08). */
const FF_TEXT = py('x', ' # FILTER_FAILED_PLAINTEXT');

test('final review r2 B-2 (HLD-45, INV-SECRET): a gate block makes each claim PIN over its group\'s LIVE paths minus every local_only record\'s path — .env (secret-like) and x.py (filter-failure), both recorded in this iteration — so the PINs stay local_only false and no x.py byte reaches refs/cowork/*', T10, async () => {
  const C1 = 'abcdefghij234567';
  const C2 = 'bcdefghij2345677';
  const gate: PublishGatePort = {
    gate: async (_repo, _tip, _A, _R, paths) => (paths.includes('app.py') ? { block: { claimId: C1 } } : paths.includes('worker.py') ? { block: { claimId: C2 } } : { block: null }),
    claimStillBlocks: async () => true,
  };
  await withCores('dep-localonly-claim', { n: 1, files: FILES, ports: { gate } }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    const one = await editAndCapture(fx, p, { '.env': 'KEY=7\n', 'app.py': py('app', ' # uses KEY 7') });
    const two = await editAndCapture(fx, p, { 'x.py': FF_TEXT, 'worker.py': py('worker', ' # reads x') });
    fx.advance(6_000);
    const now = await prep(p);
    assert.deepEqual([now.scope('.env').cls, now.scope('x.py').cls], ['LIVE', 'LIVE'], 'the iteration\'s scope predates both records');
    const env = await holdOn(p, one.it, '.env', 'revert');
    const ff = await holdOn(p, two.it, 'x.py', 'filter-failure');
    assert.deepEqual([core.holds.get(env)!.local_only, core.holds.get(ff)!.local_only], [true, true]);
    const r = await publishStep(core, now);
    assert.notEqual(r.outcome, 'aborted', JSON.stringify(r));
    assert.equal(r.c, null, 'both groups are held');
    const claimOf = (id: string): HoldRecord[] => core.holds.nonTerminal().filter((x) => x.kind === 'PIN' && x.guards.some((g) => g.name === `claim:${id}`));
    const [c1, c2] = [claimOf(C1), claimOf(C2)];
    assert.deepEqual([c1.length, c2.length], [1, 1]);
    assert.deepEqual([c1[0]!.paths, c1[0]!.local_only, c1[0]!.cs_ids], [['app.py'], false, [one.pair.csId]], '.env stays only in its own record');
    assert.deepEqual([c2[0]!.paths, c2[0]!.local_only, c2[0]!.cs_ids], [['worker.py'], false, [two.pair.csId]], 'x.py stays only in its own record');
    // Later windows (their scopes class both paths LOCAL_ONLY) keep the PINs as they are; the mirrors land.
    for (let w = 0; w < 2; w++) assert.notEqual((await publish(fx, p)).outcome, 'aborted');
    assert.deepEqual([core.holds.get(c1[0]!.id)!.paths, core.holds.get(c2[0]!.id)!.paths], [['app.py'], ['worker.py']]);
    for (const b of await remoteCoworkBlobs(fx)) {
      assert.ok(!b.equals(buf(FF_TEXT)), 'the filter-failure path\'s bytes never reach refs/cowork/*');
      assert.ok(!b.equals(buf('KEY=7\n')), 'the secret-like path\'s bytes never reach refs/cowork/*');
    }
  });
});

test('final review r2 B-2 (HLD-50 K7, INV-SECRET): a T0 failure makes the K7 PIN over the group\'s LIVE paths minus a local_only record\'s path — a secret-like .env record carrying generated?:exclude, the one MASK steps 2–4 record dependencySlot does not pin first, recorded in this iteration', T10, async () => {
  const t0: T0RegionsPort = { check: async (_r, _tip, _out, paths) => (paths.includes('app.py') ? { pass: false, paths: ['app.py'], item: 1 } : { pass: true }) };
  await withCores('dep-localonly-k7', { n: 1, files: FILES, ports: { t0Regions: t0 } }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    const { it, pair } = await editAndCapture(fx, p, { '.env': 'KEY=8\n', 'app.py': py('app', ' # uses KEY 8') });
    fx.advance(6_000);
    const now = await prep(p);
    assert.equal(now.scope('.env').cls, 'LIVE', 'the iteration\'s scope predates the record');
    const env = await holdOn(p, it, '.env', 'generated?:exclude');
    assert.equal(core.holds.get(env)!.local_only, true, 'a secret-like path: the record is local_only');
    const r = await publishStep(core, now);
    assert.notEqual(r.outcome, 'aborted', JSON.stringify(r));
    assert.deepEqual([r.c, r.dependencyPins], [null, []], 'nothing publishes; dependencySlot pins nothing for a generated?:exclude target');
    const k7 = core.holds.nonTerminal().filter((x) => x.kind === 'PIN' && x.guards.some((g) => g.name === 't0'));
    assert.equal(k7.length, 1);
    assert.deepEqual(r.k7, [k7[0]!.id]);
    assert.deepEqual([k7[0]!.paths, k7[0]!.local_only, k7[0]!.cs_ids], [['app.py'], false, [pair.csId]], '.env stays only in its own record');
    assert.deepEqual(core.holds.get(env)!.paths, ['.env']);
  });
});

test('final review r3 B3-2 (HLD-49, HLD-42, INV-SECRET): a later CS joining a dependency PIN as a bundle never adds a local_only record\'s path — .env (secret-like) and x.py (filter-failure), recorded in this iteration — and a PIN path a local_only record now withholds (worker.py, filter-failure) keeps the PIN\'s H1; the PIN stays local_only false', T10, async () => {
  await withCores('dep-localonly-join', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    // The D-07 shape: a dependency PIN over settings.ini and worker.py.
    const { pair, it } = await editAndCapture(fx, p, { 'settings.ini': '[core]\r\nkey = 2\r\n', 'worker.py': py('worker', ' # reads key') });
    await holdOn(p, it, 'settings.ini', 'eol-bom');
    assert.equal((await publish(fx, p)).c, null);
    const pin = dependencyPinsOf(p)[0]!;
    assert.deepEqual([pin.paths, pin.local_only], [['settings.ini', 'worker.py'], false]);
    assert.ok('h1' in pin.blobs);
    const pinnedWorker = pin.blobs.h1['worker.py'];
    // A second save over the pinned worker.py and two more paths; the CS closes after its quiet period and lands on a pinned path,
    // so captureStep bundles it into the PIN (HLD-49). The three local_only records are made after the iteration's scope was built.
    const WORKER_FF = py('worker', ' # FILTER_FAILED_PLAINTEXT');
    await writeWork(p, 'worker.py', WORKER_FF);
    await writeWork(p, '.env', 'KEY=9\n');
    await writeWork(p, 'x.py', FF_TEXT);
    await prep(p);
    fx.advance(20_000);
    const now = await prep(p, true);
    assert.deepEqual(['.env', 'x.py', 'worker.py'].map((x) => now.scope(x).cls), ['LIVE', 'LIVE', 'LIVE'], 'the iteration\'s scope predates the records');
    const env = await holdOn(p, now, '.env', 'revert');
    const ff = await holdOn(p, now, 'x.py', 'filter-failure');
    const ffw = await holdOn(p, now, 'worker.py', 'filter-failure');
    assert.deepEqual([env, ff, ffw].map((id) => core.holds.get(id)!.local_only), [true, true, true]);
    await captureStep(core, now);
    const grown = core.holds.get(pin.id)!;
    assert.equal(grown.cs_ids.length, 2, `the second CS joined the PIN: ${JSON.stringify(grown.cs_ids)} (pair ${pair.csId})`);
    assert.deepEqual(grown.paths, ['settings.ini', 'worker.py'], '.env and x.py stay only in their own records');
    assert.equal(grown.local_only, false, 'the PIN is not made local_only by a path it does not own');
    assert.ok('h1' in grown.blobs);
    assert.deepEqual(Object.keys(grown.blobs.h1).sort(), ['settings.ini', 'worker.py']);
    assert.equal(grown.blobs.h1['worker.py'], pinnedWorker, 'worker.py keeps the PIN\'s H1: the plaintext a local_only record withholds never enters it');
    assert.deepEqual([env, ff, ffw].map((id) => core.holds.get(id)!.paths), [['.env'], ['x.py'], ['worker.py']]);
    // Later windows keep the PIN as it is, and none of the withheld bytes reach refs/cowork/*.
    for (let w = 0; w < 2; w++) assert.notEqual((await publish(fx, p)).outcome, 'aborted');
    assert.deepEqual(core.holds.get(pin.id)!.paths, ['settings.ini', 'worker.py']);
    for (const b of await remoteCoworkBlobs(fx)) {
      for (const text of [FF_TEXT, WORKER_FF, 'KEY=9\n']) assert.ok(!b.equals(buf(text)), `a local_only record's bytes never reach refs/cowork/*: ${text.slice(0, 20)}`);
    }
  });
});

// ---- final review r2 B-1 (ruling R3-FF2-B1; ENG-41 (k), DAT-46 live half): the fail-closed backstop behind every masking site -----

test('final review r2 B-1 (ENG-41 (k), DAT-46): a ready pair whose R holds restore-marker rows that no record withholds (a missed masking site, stood in: no markers record) aborts every window with publish_assert:k on m.txt, so no row reaches refs/cowork/*; a later save without the rows publishes the group', T10, async () => {
  await withCores('dep-markers-k', { n: 1, files: MFILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prep(p);
    await editAndCapture(fx, p, { [M]: MARKED, 'worker.py': py('worker', ' # beside the marker file') });
    assert.equal(p.core.holds.nonTerminal().length, 0, 'no record withholds m.txt');
    const k = ['publish_assert:k', { check: 'k', path: M }];
    assert.deepEqual(await windows(fx, p, 2), [k, k], 'P carries the rows, so (e) passes; (k) refuses the new live blob');
    for (const b of await remoteCoworkBlobs(fx)) assert.equal(hasRestoreMarkerRow(b), false, 'no restore-marker row in refs/cowork/*');
    // The human resolves the rows: a new human CS over m.txt (two ticks: the save's mtime quiet period, then the observation) joins
    // the group, whose capture re-takes m.txt from the disk; both files publish in one commit.
    await writeWork(p, M, 'm1\nm2 resolved\nm3\n');
    await prep(p);
    fx.advance(1_000);
    await prep(p);
    fx.advance(20_000);
    await captureStep(p.core, await prep(p, true));
    let landed: PublishReport | null = null;
    for (let i = 0; i < 3 && landed === null; i++) {
      const r = await publish(fx, p);
      assert.notEqual(r.outcome, 'aborted', JSON.stringify(r));
      if (r.c !== null) landed = r;
    }
    assert.ok(landed !== null, 'the group publishes once the rows are gone');
    const tree = await treeOf(p, landed.c!);
    assert.equal(await blobText(p, tree, M), 'm1\nm2 resolved\nm3\n');
    assert.equal(await blobText(p, tree, 'worker.py'), py('worker', ' # beside the marker file'));
    for (const b of await remoteCoworkBlobs(fx)) assert.equal(hasRestoreMarkerRow(b), false, 'no restore-marker row in refs/cowork/*');
  });
});

// ---- integration I-6 redo (Ruling R3-FF5-B1, superseding R3-FF4-B1 (b); 05 §3.6 R1 amended): a guard-less ON_DISK PIN whose S_disk ==
// A on every path ends at R1 before step 1 — SUBSUMED when its REBASE gives H1' == A (RESOLVED_PUBLISH if explicit), else GONE — so a
// released PIN whose H1 is not what landed (B3-2/F4's frozen H1, or a same-line re-edit before its group landed) never sticks CONFLICTED
// with nothing left on disk to resolve, withholding the path and pinning every later save's group (R3-FF2-B0). A PIN carrying any guard
// is untouched; a guard-less PIN whose change is still on disk follows R1 as before. One stateless rule: no in-memory mark. -------------

/** The H1 blob of `path` in record `id` (an h0/h1 record). */
const h1Of = (p: PeerFixture, id: string, path: string): string | undefined => (p.core.holds.get(id)!.blobs as { h1: Record<string, string> }).h1[path];

/** Up to `n` windows, each after a 20 s quiet period and a materializing capture, until one lands a live commit (that report). */
async function landWindows(fx: CoreFixture, p: PeerFixture, n = 4): Promise<PublishReport | null> {
  for (let i = 0; i < n; i++) {
    fx.advance(20_000);
    await captureStep(p.core, await prep(p, true));
    const w = await publish(fx, p);
    assert.notEqual(w.outcome, 'aborted', JSON.stringify(w));
    if (w.outcome === 'landed' && w.c !== null) return w;
  }
  return null;
}

/** The R1 codes (HOLD_CONFLICTED, HOLD_SUBSUMED — also RESOLVED_PUBLISH's — and HOLD_GONE) the log holds for record `id`, in order. */
const r1CodesOf = (log: LogRecorder, id: string): string[] =>
  log.lines.filter((l) => ['HOLD_CONFLICTED', 'HOLD_SUBSUMED', 'HOLD_GONE'].includes(l.code) && l.params['hid'] === id).map((l) => l.code);

/** A later save of worker.py (V) publishes: it lands within a few windows and A carries it. */
async function laterSavePublishes(fx: CoreFixture, p: PeerFixture, V: string): Promise<void> {
  await writeWork(p, 'worker.py', V);
  await prep(p);
  assert.ok((await landWindows(fx, p)) !== null, 'the later save publishes (no CONFLICTED PIN withholds worker.py or pins its group)');
  assert.equal(await blobText(p, await stateA(p), 'worker.py'), V);
}

test('integration I-6 redo (R3-FF5-B1, probe zz_rr3_h1freeze): a dependency PIN whose worker.py H1 stayed frozen (v1) while a local_only record withheld it, released explicitly (a human --publish stood in), its group landing the newer V2: R1 ends it GONE — the disk is at A on every path and H1\' != A — never CONFLICTED, never RESOLVED_PUBLISH, and a later save of worker.py publishes', T10, async () => {
  await withCores('dep-i6-localonly', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    const log = new LogRecorder();
    p.deps.log = log;
    const { it } = await editAndCapture(fx, p, { 'settings.ini': '[core]\r\nkey = 2\r\n', 'worker.py': py('worker', ' # reads key') });
    const eol = await holdOn(p, it, 'settings.ini', 'eol-bom');
    assert.equal((await publish(fx, p)).c, null);
    const pin = dependencyPinsOf(p)[0]!;
    const v1 = h1Of(p, pin.id, 'worker.py');
    // A second save of worker.py (the same row) joins the PIN while a local_only filter-failure record made in this iteration covers it.
    const V2 = py('worker', ' # reads key v2');
    await writeWork(p, 'worker.py', V2);
    await prep(p);
    fx.advance(20_000);
    const now = await prep(p, true);
    const ffw = await holdOn(p, now, 'worker.py', 'filter-failure');
    await captureStep(core, now);
    assert.equal(core.holds.get(pin.id)!.cs_ids.length, 2, 'the CS joined the PIN');
    assert.equal(h1Of(p, pin.id, 'worker.py'), v1, 'B3-2: H1 stays frozen while the record withholds worker.py');
    // The filter recovers: the record ends (stood in), the eol-bom target releases (R-07 stood in), and with it the PIN, explicitly.
    await core.holds.transition(ffw, { state: 'RESOLVED_DISCARD' });
    await core.holds.releaseGuard(eol, 'eol-bom');
    assert.deepEqual(await releaseDependencyGuards(core, await prep(p)), [pin.id]);
    await core.holds.markExplicit(pin.id);
    assert.ok((await landWindows(fx, p)) !== null, 'the group lands');
    assert.equal(await blobText(p, await stateA(p), 'worker.py'), V2, 'A carries V2, not the PIN\'s frozen v1');
    assert.equal(h1Of(p, pin.id, 'worker.py'), v1, 'nothing refreshed the PIN\'s H1 (one mechanism: R1)');
    await r1(p);
    const end = core.holds.get(pin.id)!;
    assert.deepEqual([end.state, end.residence, end.guards], ['GONE', null, []], 'guard-less, S_disk == A on every path, REBASE(v1 onto V2) conflicts: GONE');
    assert.deepEqual(r1CodesOf(log, pin.id), ['HOLD_GONE'], 'never CONFLICTED, SUBSUMED or RESOLVED_PUBLISH');
    await laterSavePublishes(fx, p, py('worker', ' # reads key v3'));
  });
});

test('integration I-6 redo (R3-FF5-B1, F4\'s markers keep-rule shape): a PIN path kept at the PIN\'s blob while a markers record withheld it (the restore-marker rows never enter H1), the human resolving the rows to the held side: once the group landed R1 ends the PIN GONE (H1\' != A) and the markers record SUBSUMED, no record side carries a row, and a later save publishes', T10, async () => {
  await withCores('dep-i6-markers', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    const log = new LogRecorder();
    p.deps.log = log;
    const { it } = await editAndCapture(fx, p, { 'settings.ini': '[core]\r\nkey = 2\r\n', 'worker.py': py('worker', ' # reads key') });
    const eol = await holdOn(p, it, 'settings.ini', 'eol-bom');
    assert.equal((await publish(fx, p)).c, null);
    const pin = dependencyPinsOf(p)[0]!;
    const v1 = h1Of(p, pin.id, 'worker.py');
    // A conflicted RESTORE on worker.py (HLD-17, stood in): its markers record withholds worker.py whole; the human's next save still has
    // the restore-marker rows, and its CS joins the PIN (F4: the PIN keeps its blob, the rows never enter it).
    const A0 = await stateA(p);
    const HELD = py('worker', ' # held');
    const mk = await core.holds.hold({
      kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: ['worker.py'], guard: 'markers', origin: 'human', cs_ids: [], displaced_by: null,
      blobs: { h0: { 'worker.py': A0.get('worker.py')!.oid }, h1: { 'worker.py': await core.repo.hashBytes(buf(HELD), true) } },
    });
    const ROWS = `${py('worker', ' # reads key')}<<<<<<< cowork:disk\nmine\n=======\nheld\n>>>>>>> cowork:held\n`;
    await writeWork(p, 'worker.py', ROWS);
    await prep(p);
    fx.advance(20_000);
    await captureStep(core, await prep(p, true));
    assert.equal(core.holds.get(pin.id)!.cs_ids.length, 2, 'the CS joined the PIN');
    assert.equal(h1Of(p, pin.id, 'worker.py'), v1, 'F4: H1 stays at the PIN\'s blob while the markers record withholds worker.py');
    // The human resolves the rows by keeping the held side; the markers PREDICATE releases on that disk (stood in), then the eol-bom
    // target and the PIN.
    await writeWork(p, 'worker.py', HELD);
    await prep(p);
    fx.advance(20_000);
    await prep(p, true);
    await core.holds.releaseGuard(mk, 'markers');
    await core.holds.releaseGuard(eol, 'eol-bom');
    assert.deepEqual(await releaseDependencyGuards(core, await prep(p)), [pin.id]);
    assert.ok((await landWindows(fx, p)) !== null, 'the group lands');
    assert.equal(await blobText(p, await stateA(p), 'worker.py'), HELD);
    await r1(p);
    assert.deepEqual([core.holds.get(pin.id)!.state, core.holds.get(mk)!.state], ['GONE', 'SUBSUMED'], 'the PIN: guard-less, disk at A, REBASE(v1 onto HELD) conflicts → GONE; the markers record: H1\' == A');
    assert.deepEqual(r1CodesOf(log, pin.id), ['HOLD_GONE'], 'the PIN was never CONFLICTED or SUBSUMED');
    assert.deepEqual(await markedRecordBlobs(p), [], 'no record side carries a restore-marker row');
    await laterSavePublishes(fx, p, py('worker', ' # held v3'));
  });
});

test('integration I-6 redo (R3-FF5-B1, probe rr3probe-base — no freeze involved): a released dependency PIN (H1 = V2) whose worker.py gets a same-line V3 before its group lands ends GONE once V3 landed (the disk at A, H1\' != A), so a later save V4 publishes', T10, async () => {
  await withCores('dep-i6-base', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    const log = new LogRecorder();
    p.deps.log = log;
    const { it } = await editAndCapture(fx, p, { 'settings.ini': '[core]\r\nkey = 2\r\n', 'worker.py': py('worker', ' # reads key') });
    const eol = await holdOn(p, it, 'settings.ini', 'eol-bom');
    assert.equal((await publish(fx, p)).c, null);
    const pin = dependencyPinsOf(p)[0]!;
    const V2 = py('worker', ' # reads key v2');
    await writeWork(p, 'worker.py', V2);
    await prep(p);
    fx.advance(20_000);
    await captureStep(core, await prep(p, true));
    assert.equal(h1Of(p, pin.id, 'worker.py'), await core.repo.hashBytes(buf(V2), true), 'HLD-49: the join took V2 into H1');
    await core.holds.releaseGuard(eol, 'eol-bom');
    assert.deepEqual(await releaseDependencyGuards(core, await prep(p)), [pin.id]);
    // The human tweaks the same line again before the group lands (HLD-38 joins only held PINs, so H1 stays V2).
    const V3 = py('worker', ' # reads key v3');
    await writeWork(p, 'worker.py', V3);
    await prep(p);
    fx.advance(2_000);
    await r1(p);
    assert.deepEqual([core.holds.get(pin.id)!.state, r1CodesOf(log, pin.id)], ['ACTIVE', []], 'the disk is not at A: R1 as before (REBASE clean, ACTIVE)');
    assert.ok((await landWindows(fx, p)) !== null, 'the group lands');
    assert.equal(await blobText(p, await stateA(p), 'worker.py'), V3, 'A carries V3, the PIN\'s H1 is V2');
    await r1(p);
    assert.deepEqual([core.holds.get(pin.id)!.state, r1CodesOf(log, pin.id)], ['GONE', ['HOLD_GONE']], 'guard-less, disk at A, REBASE(V2 onto V3) conflicts: GONE, never CONFLICTED');
    await laterSavePublishes(fx, p, py('worker', ' # reads key v4'));
  });
});

test('integration I-6 redo (R3-FF5-B1): a guarded claim PIN whose REBASE conflicts stays CONFLICTED with its guard and H1 while the disk is at A — before, while and after a markers record withholds its path, whatever this process saw first (no in-memory mark decides anything); a guard-less PIN whose held change is on disk stays CONFLICTED too, and ends GONE only once the human\'s disk is back at A', T10, async () => {
  for (const lookFirst of [false, true]) {
    await withCores(`dep-i6-claim-${String(lookFirst)}`, { n: 1, files: FILES }, async (fx) => {
      const p = fx.peers[0]!;
      const core = p.core;
      const it0 = await prep(p, true);
      const x = await core.repo.hashBytes(buf(py('worker', ' # x')), true);
      const y = await core.repo.hashBytes(buf(py('worker', ' # y')), true);
      const CLAIM = 'claim:abcdefghij234567';
      const claim = await core.holds.hold({
        kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths: ['worker.py'], guard: CLAIM, origin: 'human', cs_ids: [], displaced_by: null,
        blobs: { h0: { 'worker.py': x }, h1: { 'worker.py': y } },
      });
      const unchanged = (why: string): void => {
        const r = core.holds.get(claim)!;
        assert.deepEqual([r.state, r.residence, r.guards.map((g) => g.name), h1Of(p, claim, 'worker.py')], ['CONFLICTED', 'ON_DISK', [CLAIM], y], `lookFirst=${String(lookFirst)} ${why}`);
      };
      if (lookFirst) {
        await r1(p);   // this process's first R1 comes before any withholder exists (a long-running daemon)
        unchanged('before the markers record');
      }
      const mk = await holdOn(p, it0, 'worker.py', 'markers', { blobs: { h0: { 'worker.py': it0.A.get('worker.py')!.oid }, h1: { 'worker.py': y } } });
      await r1(p);
      unchanged('while the markers record withholds worker.py');
      await core.holds.transition(mk, { state: 'RESOLVED_DISCARD' });
      for (let i = 0; i < 2; i++) {
        await r1(p);
        unchanged('after the markers record ended: REBASE(H1) conflicts (R1 step 1) and the PIN carries a guard');
      }
      // The same PIN without its guard (released): its held change y on disk keeps R1 step 1; the human's return to A ends it GONE.
      await core.holds.releaseGuard(claim, CLAIM);
      await writeWork(p, 'worker.py', py('worker', ' # y'));
      await prep(p);
      fx.advance(20_000);
      await r1(p);
      assert.equal(core.holds.get(claim)!.state, 'CONFLICTED', `lookFirst=${String(lookFirst)}: y is on disk, not A: R1 step 1 as before`);
      await writeWork(p, 'worker.py', py('worker'));
      await prep(p);
      fx.advance(20_000);
      await r1(p);
      assert.equal(core.holds.get(claim)!.state, 'GONE', `lookFirst=${String(lookFirst)}: guard-less, the disk back at A on every path: GONE`);
    });
  }
});
