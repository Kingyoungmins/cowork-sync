// Resume (Plan 3 Task 8; R-28 extended, ENG-45, HLD-31, Table 3 `host-reject`; rulings R3-02, R3-11, R3-38, R3-39, R-26, R-28;
// contract addition 5): resume() clears NONRETRYABLE and the streak, releases the host-reject guard (the pathless PIN ends SUBSUMED
// with its guard kept), lifts MASS keeping snap_pre_freeze, and `node dist/daemon.js resume` runs it under daemon.lock, printing the
// ResumeReport. Rejections come from the bare remote's pre-receive hook (fixture rejectNext). Git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readBoardCommit } from '../../src/board/boardCommit.js';
import { Folder } from '../../src/board/fold.js';
import { parseOpLine } from '../../src/board/ops.js';
import { runDaemon, type DaemonArgs, type DaemonIo } from '../../src/daemon/run.js';
import { IN_TREE_DAEMON } from '../helpers/regionDeps.js';
import type { PeerFixture } from '../helpers/coreFixture.js';
import { PLAN2_REGION_SPEC } from '../../src/engine/deps.js';
import { enterMass, SNAP_PRE_FREEZE } from '../../src/engine/detect.js';
import { evaluateRecords } from '../../src/engine/holdOps.js';
import { DaemonLock, Engine } from '../../src/engine/loop.js';
import { publishStep, type PublishReport } from '../../src/engine/publish.js';
import { resume } from '../../src/engine/resume.js';
import { parseRecord } from '../../src/holds/record.js';
import { PLUGIN_VERSION } from '../../src/version.js';
import { countCalls, lockOf, withEngines } from '../helpers/engineFixture.js';
import { buf, editAndCapture, lines, prep, withCores } from '../helpers/publishHelpers.js';
import { gitIn } from '../helpers/startFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const ts = (name: string): string => lines(12, (i) => `export const ${name}${i} = ${i};`);
const FILES: Record<string, Buffer> = { 'README.md': buf('# resume fixture\n'), 'src/a.ts': buf(ts('a')), 'src/z.ts': buf(ts('z')) };
let edits = 0;
const nextEdit = (): Record<string, string> => ({ 'src/a.ts': ts('a').replace('export const a3 = 3;', `export const a3 = ${1000 + ++edits};`) });

const attempt = async (p: PeerFixture): Promise<PublishReport> => publishStep(p.core, await prep(p));

/** publishStep until it attempts a push: the governor's window, spacing and ENG-44 backoff (30 s doubling) pass on the virtual clock. */
async function attempted(fx: Parameters<Parameters<typeof withCores>[2]>[0], p: PeerFixture): Promise<PublishReport> {
  for (let i = 0; i < 40; i++) {
    const r = await attempt(p);
    if (r.outcome !== 'skipped' || r.why !== 'window') return r;
    fx.advance(10_000);
  }
  assert.fail('no attempt');
}

/** Three rejections of the same publish with the board unchanged (Plan 2's setup): NONRETRYABLE and its host-reject PIN. */
async function nonretryable(fx: Parameters<Parameters<typeof withCores>[2]>[0], p: PeerFixture): Promise<string> {
  await fx.remote.rejectNext(3, 'policy', '/board');
  assert.equal((await attempted(fx, p)).outcome, 'transient');
  assert.equal((await attempted(fx, p)).outcome, 'transient');
  const r3 = await attempted(fx, p);
  assert.equal(r3.outcome, 'nonretryable', JSON.stringify(r3));
  return p.core.view!.meta.nonretryable!.hold_id;
}

/** publishStep until a push lands (the governor's windows and the backoff on the virtual clock). */
async function untilLanded(fx: Parameters<Parameters<typeof withCores>[2]>[0], p: PeerFixture): Promise<PublishReport> {
  for (let i = 0; i < 40; i++) {
    fx.advance(10_000);
    const r = await attempt(p);
    if (r.outcome === 'landed') return r;
  }
  assert.fail('no landing');
}

test('resume clears meta.nonretryable and the streak and releases the host-reject guard of meta.nonretryable.hold_id; the PIN\'s group publishes in the next window and R1 ends it SUBSUMED', T10, async () => {
  await withCores('resume-host-reject', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { pair } = await editAndCapture(fx, p, nextEdit());
    const id = await nonretryable(fx, p);
    const pin = p.core.holds.get(id)!;
    assert.deepEqual([pin.kind, pin.guards.map((g) => g.name), pin.paths], ['PIN', ['host-reject'], pair.paths]);
    const report = await resume(p.core);
    assert.deepEqual(report, { nonretryable: true, hostRejectReleased: id, massLifted: false });
    assert.deepEqual([p.core.view!.meta.nonretryable, p.core.view!.meta.rejections], [null, null]);
    const released = p.core.holds.get(id)!;
    assert.deepEqual([released.state, released.residence, released.guards], ['ACTIVE', 'ON_DISK', []], 'the guard released, the record kept');
    const r = await untilLanded(fx, p);
    assert.ok(r.c !== null, 'the PIN\'s group published');
    await evaluateRecords(p.core, await prep(p, true), new Set(), []);
    assert.equal(p.core.holds.get(id)!.state, 'SUBSUMED');
  });
});

test('three new rejections after resume add host-reject again to the same record', T10, async () => {
  await withCores('resume-again', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await editAndCapture(fx, p, nextEdit());
    const id = await nonretryable(fx, p);
    await resume(p.core);
    const rev = p.core.holds.get(id)!.rev;
    fx.advance(61_000);
    const again = await nonretryable(fx, p);
    assert.equal(again, id, 'one id (HLD-07)');
    const rec = p.core.holds.get(id)!;
    assert.ok(rec.rev > rev, 'a new rev');
    assert.deepEqual([rec.state, rec.guards.map((g) => g.name)], ['ACTIVE', ['host-reject']], 'the guard back');
    assert.equal(p.core.holds.nonTerminal().length, 1);
  });
});

test('the pathless host-reject PIN of a board-only NONRETRYABLE ends SUBSUMED in resume\'s registry commit with host-reject kept', T10, async () => {
  await withCores('resume-pathless', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    p.core.outbox.add({ type: 'event', cid: '', kind: 'freeze', refs: [], reason_code: 'FREEZE_EPOCH' });
    await prep(p);
    fx.advance(6_000);
    const id = await nonretryable(fx, p);
    assert.deepEqual(p.core.holds.get(id)!.paths, [], 'pathless');
    // The daemon's next iteration under the pause (before the human's resume): mirrorSync drafts the PIN's creation op, which waits
    // with every other op while NONRETRYABLE holds the pushes (PRO-45).
    fx.advance(10_000);
    const paused = await attempt(p);
    assert.deepEqual([paused.outcome, paused.why], ['skipped', 'state']);
    assert.notEqual(p.core.outbox.pendingHold(id), null, 'the creation op waits');
    const spy = countCalls(p.core.holds, 'releaseGuard');
    const head = p.core.holds.head();
    const report = await resume(p.core);
    assert.deepEqual(report, { nonretryable: true, hostRejectReleased: id, massLifted: false });
    assert.equal(spy.n, 0, 'no releaseGuard');
    spy.restore();
    assert.notEqual(p.core.holds.head(), head, "resume's registry commit");
    const rec = p.core.holds.get(id)!;
    assert.deepEqual([rec.state, rec.residence, rec.guards.map((g) => g.name), rec.paths], ['SUBSUMED', null, ['host-reject'], []]);
    // records/<id>.json of the registry head re-parses.
    const tree = await p.core.repo.readTreeMap((await p.core.repo.readCommit(p.core.holds.head()!)).tree);
    const stored = parseRecord(await p.core.repo.readBlob(tree.get(`records/${id}.json`)!.oid));
    assert.deepEqual([stored.state, stored.guards.map((g) => g.name), stored.paths], ['SUBSUMED', ['host-reject'], []]);
    // Its terminal hold op leaves with the next landing, parses, and folds without an own rejection.
    const landed = await untilLanded(fx, p);
    const opLines = (await readBoardCommit(p.core.repo, landed.bnew!)).opsLines.filter((l) => l.includes(id));
    const ops = opLines.map((l) => parseOpLine(l));
    assert.ok(ops.length > 0 && ops.every((o) => o !== null && o.type === 'hold'), 'the hold op parses');
    assert.ok(ops.some((o) => o !== null && o.type === 'hold' && o.state === 'SUBSUMED'), 'the terminal op');
    const folded = await new Folder(p.core.repo, p.core.peerId).foldTo(landed.bnew!, null, PLAN2_REGION_SPEC);
    assert.deepEqual(folded.ownRejections.filter((x) => x.holdId === id), [], 'no own rejection');
    assert.equal(folded.state.holds[id]?.state, 'SUBSUMED');
    assert.deepEqual(folded.state.holds[id]?.guards.map((g) => g.name), ['host-reject']);
  });
});

test('resume lifts MASS, keeps snap_pre_freeze and drafts one event{kind: unfreeze, reason_code: MASS}', T10, async () => {
  await withCores('resume-mass', { n: 1 }, async (fx) => {
    const p = fx.peers[0]!;
    await enterMass(p.core, await prep(p), 'window', { paths: 11 });
    const kept = p.core.view!.keep.get(SNAP_PRE_FREEZE);
    assert.ok(kept !== undefined && p.core.view!.meta.freeze_reasons.includes('MASS'));
    const report = await resume(p.core);
    assert.deepEqual(report, { nonretryable: false, hostRejectReleased: null, massLifted: true });
    assert.ok(!p.core.view!.meta.freeze_reasons.includes('MASS'));
    assert.equal(p.core.view!.keep.get(SNAP_PRE_FREEZE), kept, 'snap_pre_freeze kept');
    const unfreeze = p.core.outbox.drafts().filter((d) => d.type === 'event' && (d as { kind: string }).kind === 'unfreeze');
    assert.deepEqual(unfreeze.map((d) => (d as { reason_code: string }).reason_code), ['MASS'], 'one unfreeze event');
  });
});

test('resume with nothing pending reports all false and makes no state or registry commit', T10, async () => {
  await withCores('resume-nothing', { n: 1 }, async (fx) => {
    const p = fx.peers[0]!;
    const state = await p.core.repo.readRef(p.core.refs.state);
    const holds = await p.core.repo.readRef(p.core.refs.holds);
    assert.deepEqual(await resume(p.core), { nonretryable: false, hostRejectReleased: null, massLifted: false });
    assert.equal(await p.core.repo.readRef(p.core.refs.state), state);
    assert.equal(await p.core.repo.readRef(p.core.refs.holds), holds);
  });
});

test('resume clears NONRETRYABLE when the host-reject record it names is already terminal or missing', T10, async () => {
  await withCores('resume-terminal', { n: 1 }, async (fx) => {
    const p = fx.peers[0]!;
    const P = 'src/a.txt';
    const pause = async (holdId: string): Promise<void> => {
      const v = p.core.view!;
      await p.core.commit({ meta: { ...v.meta, nonretryable: { lease: v.laB, hold_id: holdId }, rejections: { lease: v.laB, n: 3 } } });
    };
    const pin = async (): Promise<string> => {
      const A = await p.core.repo.readTreeMap(p.core.view!.base);
      return p.core.holds.hold({
        kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths: [P],
        blobs: { h0: { [P]: A.get(P)!.oid }, h1: { [P]: await p.core.repo.hashBytes(buf('one\nlocal edit\n'), true) } },
        guard: 'host-reject', origin: 'daemon', cs_ids: [], displaced_by: null,
      });
    };
    const reflog = async (): Promise<number> => (await gitIn(p, ['log', '-g', '--format=%H', p.core.refs.state])).split('\n').filter((l) => l.length > 0).length;
    const check = async (holdId: string, what: string): Promise<void> => {
      await pause(holdId);
      const head = p.core.holds.head();
      const n = await reflog();
      assert.deepEqual(await resume(p.core), { nonretryable: true, hostRejectReleased: null, massLifted: false }, what);
      assert.equal(p.core.holds.head(), head, `${what}: no registry commit`);
      assert.equal(await reflog(), n + 1, `${what}: one state CAS`);
      assert.deepEqual([p.core.view!.meta.nonretryable, p.core.view!.meta.rejections], [null, null], what);
    };
    // GONE by R1: the human reverted the edit (S_disk == A).
    const gone = await pin();
    await evaluateRecords(p.core, await prep(p, true), new Set(), []);
    assert.equal(p.core.holds.get(gone)!.state, 'GONE');
    await check(gone, 'GONE');
    // RESOLVED_DISCARD by Task 11's verb (transition).
    const discarded = await pin();
    await p.core.holds.transition(discarded, { state: 'RESOLVED_DISCARD' });
    await check(discarded, 'RESOLVED_DISCARD');
    // Missing: an id no record has (as after a scratch registry was deleted).
    await check('01J0000000000000000000ZZZZ', 'missing');
  });
});

// ---- daemon.js resume (R-28 extended, R3-02, R3-39) --------------------------------------------------------------------

function daemonEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) if (/^(https?_proxy|all_proxy|no_proxy|git_ssh_command|git_ssh|git_ssh_variant)$/i.test(k)) delete env[k];
  return env;
}
function session(): { io: DaemonIo; lines: string[] } {
  const out: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => out.push(l), onStop: () => undefined }, lines: out };
}
function args(dir: string): DaemonArgs {
  return { cmd: 'resume', repo: dir, branch: 'main', publish: null, name: null, remote: null, confirm: null, id: null, verb: null, dataDir: null, pluginRoot: null, spawned: false };
}

test('node dist/daemon.js resume refuses with exit 1 while a live daemon holds daemon.lock, takes the lock itself for its run (a dead pid\'s lock is replaced, R-26), and with no daemon prints the ResumeReport as one JSON line and exits 0; Engine.resumeAfterNonretryable() returns report.nonretryable', T10, async () => {
  await withEngines('resume-cli', { n: 1 }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    await fx.rounds(2);
    const dir = p.deps.paths.workTree;
    const coworkDir = p.deps.paths.coworkDir;
    // NONRETRYABLE with a pathless host-reject PIN (as a board-only publish leaves it).
    const pause = async (core: Engine['core']): Promise<string> => {
      const v = core.view!;
      const holdId = await core.holds.hold({
        kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths: [], blobs: { h0: {}, h1: {} }, guard: 'host-reject', origin: 'daemon',
        cs_ids: [], displaced_by: null,
      });
      await core.commit({ meta: { ...v.meta, nonretryable: { lease: v.laB, hold_id: holdId }, rejections: { lease: v.laB, n: 3 } } });
      return holdId;
    };
    const holdId = await pause(p.core);

    // A live daemon (this fixture's) holds daemon.lock: refused, nothing written.
    const busy = session();
    assert.equal(await runDaemon(args(dir), daemonEnv(), busy.io, IN_TREE_DAEMON), 1);
    assert.ok(busy.lines.some((l) => l.startsWith('DAEMON_ALREADY_RUNNING')), busy.lines.join('\n'));
    assert.equal((await p.core.state.read())!.meta.nonretryable?.hold_id, holdId);

    // The daemon is gone but its lock names a dead pid: replaced (R-26), the resume runs under it and releases it.
    await lockOf(p).release();
    const dead = spawnSync(process.execPath, ['-e', '']).pid!;
    await writeFile(join(coworkDir, 'daemon.lock'), `${JSON.stringify({ pid: dead, plugin_version: PLUGIN_VERSION, instance: 'dead-daemon', started: null })}\n`);
    const res = session();
    assert.equal(await runDaemon(args(dir), daemonEnv(), res.io, IN_TREE_DAEMON), 0, res.lines.join('\n'));
    const json = res.lines.filter((l) => l.startsWith('{'));
    assert.equal(json.length, 1, res.lines.join('\n'));
    assert.deepEqual(JSON.parse(json[0]!), { nonretryable: true, hostRejectReleased: holdId, massLifted: false });
    const after = (await p.core.state.read())!;
    assert.deepEqual([after.meta.nonretryable, after.meta.rejections], [null, null]);
    assert.equal(existsSync(join(coworkDir, 'daemon.lock')), false, 'the resume released the lock it took');

    // Engine.resumeAfterNonretryable() is Engine.resume()'s report.nonretryable.
    const lock = await DaemonLock.acquire(p.deps.ports.fs, coworkDir, { pluginVersion: PLUGIN_VERSION, instance: 'resume-cli-test' });
    assert.ok(lock instanceof DaemonLock);
    try {
      const engine = await Engine.create(p.deps);
      assert.equal(await engine.resumeAfterNonretryable(), false, 'nothing pending: report.nonretryable false');
      await pause(engine.core);
      assert.equal(await engine.resumeAfterNonretryable(), true, 'NONRETRYABLE cleared: report.nonretryable true');
      assert.equal(engine.core.view!.meta.nonretryable, null);
    } finally {
      await lock.release();
    }
  });
});

