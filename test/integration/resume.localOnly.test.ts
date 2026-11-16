// local_only in a process that never prepared an iteration (Plan 3 final review F12; 05-holds §2 and HLD-03 "recomputed at every rev",
// HLD-61, HLD-62, INV-HLD-DURABLE; rulings R3-12, R3-25, R3-45, R3-71): `daemon.js resume` (Engine.create, Engine.resume, Engine.drain;
// no start), and a recover/resolve whose start was refused, write registry revs — resume's release of the host-reject guard, drain's
// age-anchor flush — before any iteration scoped a path. Those revs recompute local_only from the start-time scope at EPOCH_BASE
// (R3-12), which then holds A and the attributes of every record's path; without them R3-71's fail-closed rule made every record
// local_only, and the next run stripped every held/<id>/ from the board and withheld the records' whole files. An Engine created on a
// lost or too-new state has no view, so no EPOCH_BASE to scope at: its drain's revs carry local_only unchanged (ruling R3-FF2-C1), and a
// failed attribute read before a drain is logged, never silent. makeEngines on real clones of one file:// remote, runDaemon in-process
// on the real ports; git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDaemon, type DaemonArgs, type DaemonIo } from '../../src/daemon/run.js';
import { IN_TREE_DAEMON } from '../helpers/regionDeps.js';
import { DaemonLock, Engine } from '../../src/engine/loop.js';
import type { Oid } from '../../src/git/oid.js';
import { HOLD_CODES, HOLD_LOG_CODES } from '../../src/holds/codes.js';
import { PLUGIN_VERSION } from '../../src/version.js';
import { lockOf, logOf, withEngines, type EngineFixture } from '../helpers/engineFixture.js';
import { untilDurable } from '../helpers/escalationFixture.js';
import { T10 } from '../helpers/loopHoldsFixture.js';
import { buf } from '../helpers/publishHelpers.js';
import { gitIn } from '../helpers/startFixture.js';

const FILES: Record<string, Buffer> = { 'README.md': buf('# local_only fixture\n'), 'src/a.ts': buf('export const a = 1;\n') };

type EnginePeer = EngineFixture['peers'][number];

async function started(fx: EngineFixture): Promise<EnginePeer> {
  await fx.startAll();
  await fx.rounds(2);
  return fx.peers[0]!;
}

/** A LIVE ON_DISK `restart` PATCH on src/a.ts (h0 = A, h1 = held local bytes): local_only false. */
async function restartPatch(p: EnginePeer): Promise<string> {
  const A = await p.core.repo.readTreeMap(p.core.view!.base);
  const id = await p.core.holds.hold({
    kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: ['src/a.ts'], guard: 'restart', origin: 'daemon', cs_ids: [], displaced_by: null,
    blobs: { h0: { 'src/a.ts': A.get('src/a.ts')!.oid }, h1: { 'src/a.ts': await p.core.repo.hashBytes(buf('export const a = 2; // held\n'), true) } },
  });
  assert.equal(p.core.holds.get(id)!.local_only, false, 'a LIVE record is not local_only');
  return id;
}

/** The record's held/<id>/ entries on the board commit `board` (the stage paths), or [] when there are none. */
async function heldOnBoard(p: EnginePeer, board: Oid, id: string): Promise<string[]> {
  const out = await gitIn(p, ['ls-tree', '-r', '--name-only', board, '--', `held/${id}`], false);
  return out === '' ? [] : out.split('\n');
}

function daemonEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) if (/^(https?_proxy|all_proxy|no_proxy|git_ssh_command|git_ssh|git_ssh_variant)$/i.test(k)) delete env[k];
  return env;
}
function session(): { io: DaemonIo; lines: string[] } {
  const out: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => out.push(l), onStop: () => undefined }, lines: out };
}
const resumeArgs = (dir: string): DaemonArgs => ({ cmd: 'resume', repo: dir, branch: 'main', publish: null, name: null, remote: null, confirm: null, id: null, verb: null, dataDir: null, pluginRoot: null, spawned: false });
const resolveArgs = (dir: string, id: string): DaemonArgs => ({ cmd: 'resolve', repo: dir, branch: 'main', publish: null, name: null, remote: null, confirm: null, id, verb: 'publish', dataDir: null, pluginRoot: null, spawned: false });

/** The state ref names a blob (an unparsable object): Engine.create meets a lost state (LostStateError) and has no view. */
async function loseState(p: EnginePeer): Promise<void> {
  const A = await p.core.repo.readTreeMap(p.core.view!.base);
  await gitIn(p, ['update-ref', p.core.refs.state, A.get('src/a.ts')!.oid], false);
}

test('drain of an Engine that never prepared an iteration flushes the age anchors and recomputes local_only from the start-time scope: a LIVE record stays local_only false', T10, async () => {
  await withEngines('lo-drain', { n: 1, files: FILES }, async (fx) => {
    const p = await started(fx);
    const id = await restartPatch(p);
    const before = p.core.holds.get(id)!;
    // A process that never started (daemon.js resume, a refused start): Engine.create, then drain.
    const fresh = await Engine.create(p.deps);
    fx.advance(5_000);
    await fresh.drain(null);
    const r = fresh.core.holds.get(id)!;
    assert.equal(r.rev, before.rev + 1, 'the age-anchor rev was written');
    assert.ok(r.age_anchor.mono_accum_ms > before.age_anchor.mono_accum_ms, 'the accumulated Δmono flushed');
    assert.equal(r.local_only, false, 'the age-anchor rev kept the LIVE record mirrored (R3-12 with the start-time scope, not R3-71\'s fail-closed)');
  });
});

test('Engine.resume in an Engine that never prepared an iteration releases the host-reject guard of a PIN with paths under the start-time scope: local_only stays false, so the PIN\'s group can publish (ENG-45, R3-39)', T10, async () => {
  await withEngines('lo-resume', { n: 1, files: FILES }, async (fx) => {
    const p = await started(fx);
    const A = await p.core.repo.readTreeMap(p.core.view!.base);
    const pin = await p.core.holds.hold({
      kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths: ['src/a.ts'], guard: 'host-reject', origin: 'daemon', cs_ids: [], displaced_by: null,
      blobs: { h0: { 'src/a.ts': A.get('src/a.ts')!.oid }, h1: { 'src/a.ts': await p.core.repo.hashBytes(buf('export const a = 3; // rejected\n'), true) } },
    });
    assert.equal(p.core.holds.get(pin)!.local_only, false);
    const v = p.core.view!;
    await p.core.commit({ meta: { ...v.meta, nonretryable: { lease: v.laB, hold_id: pin }, rejections: { lease: v.laB, n: 3 } } });
    const fresh = await Engine.create(p.deps);
    const report = await fresh.resume();
    assert.deepEqual(report, { nonretryable: true, hostRejectReleased: pin, massLifted: false });
    const r = fresh.core.holds.get(pin)!;
    assert.deepEqual(r.guards.map((g) => g.name), [], 'the host-reject guard released');
    assert.equal(r.local_only, false, 'the release rev was classed with the start-time scope (never failed closed)');
  });
});

test('node dist/daemon.js resume keeps every record\'s local_only, and the next run keeps the record\'s held/<id>/ on the board (INV-HLD-DURABLE)', T10, async () => {
  await withEngines('lo-resume-cli', { n: 1, files: FILES }, async (fx) => {
    const p = await started(fx);
    const id = await restartPatch(p);
    await untilDurable(fx, p, [id]);
    const heldBefore = await heldOnBoard(p, p.core.view!.laB, id);
    assert.ok(heldBefore.length > 0, 'the record is mirrored with its held/ entries');
    await p.engine.drain(null);
    // No daemon runs: `daemon.js resume` with nothing to resume (all false).
    await lockOf(p).release();
    const s = session();
    assert.equal(await runDaemon(resumeArgs(p.deps.paths.workTree), daemonEnv(), s.io, IN_TREE_DAEMON), 0, s.lines.join('\n'));
    assert.deepEqual(JSON.parse(s.lines.find((l) => l.startsWith('{'))!), { nonretryable: false, hostRejectReleased: null, massLifted: false });
    // The next run.
    const lock = await DaemonLock.acquire(p.deps.ports.fs, p.deps.paths.coworkDir, { pluginVersion: PLUGIN_VERSION, instance: 'lo-next-run' });
    assert.ok(lock instanceof DaemonLock);
    try {
      const next = await Engine.create(p.deps);
      assert.equal(next.core.holds.get(id)!.local_only, false, 'daemon.js resume left the record mirrored');
      const r = await next.start({ publishLocal: null });
      assert.ok(r.ok && r.mode === 'restart', JSON.stringify(r));
      for (let i = 0; i < 8; i++) {
        fx.advance(10_000);
        await next.iterate();
      }
      assert.equal(next.core.holds.get(id)!.local_only, false);
      assert.deepEqual(await heldOnBoard(p, next.core.view!.laB, id), heldBefore, 'the next run kept held/<id>/ on the board');
      await next.drain(null);
    } finally {
      await lock.release();
    }
  });
});

test('drain of an Engine created on a lost state (no view, no EPOCH_BASE to scope at) flushes the age anchors and carries every record\'s local_only unchanged: a LIVE record stays false (R3-FF2-C1)', T10, async () => {
  await withEngines('lo-lost-drain', { n: 1, files: FILES }, async (fx) => {
    const p = await started(fx);
    const id = await restartPatch(p);
    await p.engine.drain(null);
    await loseState(p);
    const fresh = await Engine.create(p.deps);
    assert.equal(fresh.core.view, null, 'a lost state: Engine.create has no view');
    const before = fresh.core.holds.get(id)!;
    fx.advance(5_000);
    await fresh.drain(null);
    const r = fresh.core.holds.get(id)!;
    assert.equal(r.local_only, false, 'the lost-state drain kept the LIVE record mirrored (no scope input: local_only carried, not failed closed)');
    assert.equal(r.rev, before.rev + 1, 'the age-anchor rev was written (05 §2: a clean exit flushes the ages)');
    assert.ok(r.age_anchor.mono_accum_ms > before.age_anchor.mono_accum_ms, 'the accumulated Δmono flushed');
  });
});

test('node dist/daemon.js resolve on a lost state answers HOLD_NOT_OWNER, and its drain keeps every record\'s local_only (R3-FF2-C1)', T10, async () => {
  await withEngines('lo-lost-resolve', { n: 1, files: FILES }, async (fx) => {
    const p = await started(fx);
    const id = await restartPatch(p);
    const before = p.core.holds.get(id)!;
    await p.engine.drain(null);
    await loseState(p);
    await lockOf(p).release();
    const s = session();
    assert.equal(await runDaemon(resolveArgs(p.deps.paths.workTree, id), daemonEnv(), s.io, IN_TREE_DAEMON), 1, s.lines.join('\n'));
    assert.ok(s.lines.some((l) => l.startsWith(`HOLD_NOT_OWNER ${JSON.stringify({ hid: id })}`)), s.lines.join('\n'));
    const lock = await DaemonLock.acquire(p.deps.ports.fs, p.deps.paths.coworkDir, { pluginVersion: PLUGIN_VERSION, instance: 'lo-lost-check' });
    assert.ok(lock instanceof DaemonLock);
    try {
      const after = await Engine.create(p.deps);
      assert.equal(after.core.view, null);
      const r = after.core.holds.get(id)!;
      assert.ok(r.rev > before.rev, `the command's drain wrote the age-anchor rev (${before.rev} -> ${r.rev})`);
      assert.equal(r.local_only, false, 'daemon.js resolve on a lost state left the record mirrored');
    } finally {
      await lock.release();
    }
  });
});

test('a failed attribute read before a no-iteration drain is logged (RECORD_SCOPE_FAILED), and the rev stays fail closed (R3-71: local_only never fails open)', T10, async () => {
  await withEngines('lo-attr-fail', { n: 1, files: FILES }, async (fx) => {
    const p = await started(fx);
    const id = await restartPatch(p);
    const fresh = await Engine.create(p.deps);
    // check-attr fails (a git error): the start-time scope has no attributes for the record's path.
    fresh.core.attrs.snapshot = (): never => {
      throw new Error('check-attr failed');
    };
    const log = logOf(p);
    const from = log.lines.length;
    fx.advance(5_000);
    await fresh.drain(null);
    assert.deepEqual(log.lines.slice(from).filter((l) => l.code === 'RECORD_SCOPE_FAILED').map((l) => [l.level, l.params]), [['error', { at: 'drain', error: 'Error' }]],
      'the failed read is logged, never silent');
    // Integration I-4 (r2 fix C concern 2): a registered daemon-log-only code (HOLD_LOG_CODES), never a status code.
    assert.ok(HOLD_LOG_CODES.includes('RECORD_SCOPE_FAILED') && !HOLD_CODES.includes('RECORD_SCOPE_FAILED'), 'RECORD_SCOPE_FAILED is in HOLD_LOG_CODES');
    assert.equal(fresh.core.holds.get(id)!.local_only, true, 'an unscoped path fails closed (R3-71)');
  });
});
