// Receive-side collisions (Plan 3 Task 6; 03-data DAT-29, I-DAT-08 record half; 01-engine TC-ENG-16, ENG-36 `disk_equal`; 05-holds
// HLD-54, Table 4; rulings R3-31, R3-33, D-08): an incoming creation onto a local untracked or ignored file never overwrites it; the
// path becomes its own INCOMING `collision` record (INCOMING_COLLISION {id, path}), is skipped by every snapshot while that record
// lives (never in the private index, S_disk or P), and the rest of its change-set applies. A creation whose local file already
// holds TIP's bytes is applied with no write (A[p] := TIP[p], cause disk_equal), which also ends a collision record once the
// collision take wrote TIP's bytes. Real git on file:// clones; never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, stat, utimes } from 'node:fs/promises';
import { tickSkip } from '../../src/engine/core.js';
import { collisionTake } from '../../src/engine/holdOps.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import type { TreeMap } from '../../src/git/repo.js';
import { readWork, workPath, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { incomingRecords, loop, onlyWithGuard, withGuard } from '../helpers/incomingFixture.js';
import { buf, LogRecorder, prep, remoteCode, withCores } from '../helpers/publishHelpers.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const LOCAL = 'SECRET=local\n';
const TEAM = 'SECRET=team\n';

/** Every live commit the remote code ref gained since `from`, with its tree. */
async function pushedTrees(fx: CoreFixture, p: PeerFixture, from: Oid): Promise<TreeMap[]> {
  const tip = await remoteCode(fx, p);
  if (tip === undefined || tip === from) return [];
  const commits = await p.core.repo.firstParents(tip as Oid, from, 10_000);
  const out: TreeMap[] = [];
  for (const c of commits) out.push(await p.core.repo.readTreeMap((await p.core.repo.readCommit(c)).tree));
  return out;
}

/** Whether the peer's work tree folds case (NTFS, APFS by default): README.md is found as README.MD. */
async function foldsCase(p: PeerFixture): Promise<boolean> {
  try {
    await stat(workPath(p, 'README.MD'));
    return true;
  } catch {
    return false;
  }
}

test('R3-33 never takes disk_equal through a case variant: a case-only rename with identical bytes keeps the file', T10, async () => {
  // A teammate's `git mv` that changes only the case (both directions). On a case-folding volume lstat and the staged read of the
  // new spelling land on the old spelling's file, which the same apply deletes: taking disk_equal there would leave no file and the
  // next human CS would publish the deletion to the team. On a case-sensitive volume FaultFs emulates the fold for reads.
  const SAME = 'same bytes\n';
  for (const [from, to] of [['Foo.txt', 'foo.txt'], ['foo.txt', 'Foo.txt']] as const) {
    await withCores(`rcoll-case-${to}`, { n: 1, files: { 'README.md': buf('# case rename\n'), [from]: buf(SAME), 'src/a.txt': buf('a\n') } }, async (fx) => {
      const p = fx.peers[0]!;
      if (!(await foldsCase(p))) p.fs.foldCase(p.deps.paths.workTree);
      const L0 = p.core.view!.laC;
      await loop(p);
      await fx.pushTeamChange({ [from]: null, [to]: buf(SAME) });
      for (let i = 0; i < 8; i++) {
        fx.advance(10_000);
        await loop(p, { capture: true, publish: true });
      }
      const names = await readdir(p.deps.paths.workTree);
      assert.ok(names.includes(to) && !names.includes(from), `${from} -> ${to}: the disk holds the new spelling (${JSON.stringify(names)})`);
      assert.equal((await readWork(p, to))?.toString(), SAME);
      const it = await prep(p);
      assert.equal(it.A.get(to)?.oid, it.tipMap.get(to)?.oid, 'A[to] = TIP[to]');
      assert.equal(it.A.has(from), false);
      const trees = await pushedTrees(fx, p, L0);
      assert.ok(trees.length >= 1);
      for (const t of trees) assert.equal(t.get(to)?.oid, it.tipMap.get(to)?.oid, 'no live commit drops the new spelling');
      assert.deepEqual(incomingRecords(p), [], 'no record is left');
    });
  }
});

test('TC-ENG-16 / I-DAT-08 record half: an incoming .env never overwrites a locally ignored .env', T10, async () => {
  const files = { 'README.md': buf('# collision\n'), '.gitignore': buf('.env\n'), 'src/a.txt': buf('a1\na2\n') };
  await withCores('rcoll-tceng16', { n: 1, files }, async (fx) => {
    const p = fx.peers[0]!;
    const log = new LogRecorder();
    p.deps.log = log;
    await writeWork(p, '.env', LOCAL);
    const before = await stat(workPath(p, '.env'));
    await fx.pushTeamChange({ '.env': buf(TEAM), 'src/a.txt': buf('a1\na2 team\n') });
    fx.advance(10_000);
    const l = await loop(p);
    assert.deepEqual(await readWork(p, '.env'), buf(LOCAL), "B's ignored .env stays byte-identical");
    assert.equal((await stat(workPath(p, '.env'))).mtimeMs, before.mtimeMs);
    assert.deepEqual(l.apply.written, ['src/a.txt'], "the CS's other paths apply");
    const r = onlyWithGuard(p, 'collision');
    assert.deepEqual([r.kind, r.residence, r.state, r.paths, r.local_only], ['INCOMING', 'ON_DISK', 'ACTIVE', ['.env'], true]);
    assert.ok('h1' in r.blobs);
    assert.deepEqual([r.blobs.h0['.env'], r.blobs.h1['.env']], [ABSENT, l.it.tipMap.get('.env')!.oid]);
    assert.deepEqual(l.codes, [{ code: 'INCOMING_COLLISION', params: { id: r.id, path: '.env' } }]);
    assert.deepEqual(p.core.holdCode, { code: 'INCOMING_COLLISION', params: { id: r.id, path: '.env' } });
    assert.deepEqual(log.lines.filter((x) => x.code === 'INCOMING_COLLISION').map((x) => [x.level, x.params]), [['warn', { id: r.id, path: '.env' }]]);
    // Its creation op is the local_only stub, drafted at age 60 s (R3-29).
    for (let i = 0; i < 6; i++) {
      fx.advance(10_000);
      await loop(p, { mirror: true });
    }
    const op = p.core.outbox.pendingHold(r.id);
    assert.ok(op !== null, 'drafted at 60 s');
    assert.equal(op.local_only, true, 'a content-free stub');
  });
});

test("P2-NA-TRIGGER's re-check of a pending collision stays stat-based: DISK_EQ only when the file's stat or TIP's blob changed", T10, async () => {
  const files = { 'README.md': buf('# cheap re-check\n'), '.gitignore': buf('.env\n'), 'src/a.txt': buf('a\n') };
  await withCores('rcoll-cheap', { n: 1, files }, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, '.env', LOCAL);
    await fx.pushTeamChange({ '.env': buf(TEAM) });
    fx.advance(10_000);
    await loop(p);
    const r = onlyWithGuard(p, 'collision');
    const eq = p.core.diskEq.eq.bind(p.core.diskEq);
    let calls = 0;
    p.core.diskEq.eq = async (...a: Parameters<typeof eq>) => {
      if (a[0] === '.env') calls++;
      return eq(...a);
    };
    // The R3-33 spelling guard (spelledExactly) lists the work tree's directories; an unchanged not-equal verdict needs neither.
    const root = p.deps.paths.workTree;
    p.fs.calls.length = 0;
    for (let i = 0; i < 5; i++) {
      fx.advance(10_000);
      const l = await loop(p);
      assert.equal(l.apply.skipped, 'nothing', `loop ${i}: the collision stays out of the apply trigger`);
    }
    assert.ok(calls <= 1, `five idle loops read the ignored .env at most once (${calls} DISK_EQ calls)`);
    const listings = p.fs.calls.filter((c) => c === `readdir ${root}`).length;
    assert.ok(listings <= 1, `five idle loops list the work tree at most once (${listings} readdir calls): the re-check is stat-based`);
    // A new stat (the human edits .env) is compared again; TIP's bytes then return it to the trigger (R3-33).
    calls = 0;
    await writeWork(p, '.env', 'SECRET=local 2\n');
    fx.advance(10_000);
    await loop(p);
    assert.equal(calls, 1, 'one DISK_EQ for the new stat');
    await writeWork(p, '.env', TEAM);
    fx.advance(10_000);
    await loop(p);
    fx.advance(10_000);
    const l = await loop(p);
    assert.equal(l.it.A.get('.env')?.oid, l.it.tipMap.get('.env')!.oid, 'disk_equal once the bytes equal TIP');
    assert.equal(p.core.holds.get(r.id)!.state, 'SUBSUMED');
  });
});

test("a collision record's path is skipped by every snapshot while it is non-terminal", T10, async () => {
  // .env is not ignored here, so the untracked listing names it: without the skip, every tick would see it as a new file.
  const files = { 'README.md': buf('# skip\n'), 'src/a.txt': buf('a1\na2\n') };
  await withCores('rcoll-skip', { n: 1, files }, async (fx) => {
    const p = fx.peers[0]!;
    const L0 = p.core.view!.laC;
    await writeWork(p, '.env', LOCAL);
    await fx.pushTeamChange({ '.env': buf(TEAM) });
    fx.advance(10_000);
    await loop(p);
    const r = onlyWithGuard(p, 'collision');
    assert.ok(tickSkip(p.core).has('.env'), 'tickSkip(core) contains .env');
    const localBlob = await p.core.repo.hashBytes(buf(LOCAL), false);
    // A human edit elsewhere is captured and published meanwhile, so P is composed in these loops.
    await writeWork(p, 'src/a.txt', 'a1\na2 human\n');
    for (let i = 0; i < 10; i++) {
      fx.advance(10_000);
      const l = await loop(p, { capture: true, publish: true });
      const tick = l.it.tick!;
      assert.ok(!tick.dirty.has('.env') && !tick.changed.has('.env') && !tick.notAdmitted.has('.env') && !tick.excluded.has('.env'), `tick ${i}: .env neither new nor changed`);
      assert.ok(l.it.mat === null || !l.it.mat.sDiskMap.has('.env'), `loop ${i}: .env never in S_disk`);
    }
    assert.equal(p.core.holds.get(r.id)!.state, 'ACTIVE');
    assert.deepEqual(withGuard(p, 'conflict'), [], 'no add/add K4 record');
    const trees = await pushedTrees(fx, p, L0);
    assert.ok(trees.length >= 1, 'the human edit was published');
    for (const t of trees) assert.notEqual(t.get('.env')?.oid, localBlob, "no P carries B's .env");
    assert.deepEqual(await readWork(p, '.env'), buf(LOCAL));
  });
});

test('I-DAT-08 quiet-period variant: an untracked notes.txt created 100 ms before the add lands becomes a collision record', T10, async () => {
  const files = { 'README.md': buf('# quiet\n'), 'src/a.txt': buf('a1\na2\n') };
  await withCores('rcoll-quiet', { n: 1, files }, async (fx) => {
    const p = fx.peers[0]!;
    const L0 = p.core.view!.laC;
    await fx.pushTeamChange({ 'notes.txt': buf('team notes\n') });
    // B's notes.txt (not ignored) is 100 ms old by the peer's wall clock when the add is applied: the quiet period keeps it out of
    // the snapshot, so it is a collision, never local work.
    await writeWork(p, 'notes.txt', 'my notes\n');
    const t = (p.clock.wallMs() - 100) / 1_000;
    await utimes(workPath(p, 'notes.txt'), t, t);
    const l = await loop(p);
    assert.equal(l.apply.notApplicable.get('notes.txt'), 'collision');
    const r = onlyWithGuard(p, 'collision');
    assert.deepEqual(r.paths, ['notes.txt']);
    const mine = await p.core.repo.hashBytes(buf('my notes\n'), false);
    await writeWork(p, 'src/a.txt', 'a1\na2 human\n');
    for (let i = 0; i < 10; i++) {
      fx.advance(10_000);
      await loop(p, { capture: true, publish: true });
    }
    assert.deepEqual(withGuard(p, 'conflict'), [], 'no K4 record');
    for (const tree of await pushedTrees(fx, p, L0)) assert.notEqual(tree.get('notes.txt')?.oid, mine, "no push of B's notes.txt bytes");
    assert.equal((await readWork(p, 'notes.txt'))?.toString(), 'my notes\n');
    assert.equal(p.core.holds.get(r.id)!.state, 'ACTIVE');
  });
});

test("R3-33: a creation target equal to TIP's blob is applied with no write", T10, async () => {
  const files = { 'README.md': buf('# disk equal\n'), '.gitignore': buf('.env*\n'), 'src/a.txt': buf('a\n') };
  await withCores('rcoll-diskeq', { n: 1, files }, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, '.env', TEAM);   // the local bytes already equal the team's
    const before = await stat(workPath(p, '.env'));
    await fx.pushTeamChange({ '.env': buf(TEAM) });
    fx.advance(10_000);
    const l = await loop(p);
    const tipEnv = l.it.tipMap.get('.env')!.oid;
    assert.equal(l.it.A.get('.env')?.oid, tipEnv, 'A[.env] := TIP[.env]');
    assert.deepEqual(fx.trace.ofKind('A_set').filter((e) => e.path === '.env').map((e) => [e.blob, e.cause]), [[tipEnv, 'disk_equal']]);
    assert.deepEqual(l.apply.written, [], 'no write');
    assert.equal((await stat(workPath(p, '.env'))).mtimeMs, before.mtimeMs, "the file's mtime unchanged");
    assert.deepEqual(withGuard(p, 'collision'), [], 'no collision record');
    assert.equal(p.core.view!.meta.pending['.env'], undefined);
    // A collision proper: the take writes TIP's bytes, then the next apply does the same and the collision record ends SUBSUMED.
    await writeWork(p, '.env.prod', 'P=local\n');
    await fx.pushTeamChange({ '.env.prod': buf('P=team\n') });
    fx.advance(10_000);
    await loop(p);
    const c = onlyWithGuard(p, 'collision');
    assert.deepEqual(c.paths, ['.env.prod']);
    const it = await prep(p, true);
    assert.equal(await collisionTake(p.core, it, c.id), 'WRITTEN');
    assert.equal((await readWork(p, '.env.prod'))?.toString(), 'P=team\n');
    fx.advance(10_000);
    const after = await loop(p);
    assert.equal(after.it.A.get('.env.prod')?.oid, after.it.tipMap.get('.env.prod')!.oid);
    assert.deepEqual(fx.trace.ofKind('A_set').filter((e) => e.path === '.env.prod').map((e) => e.cause), ['disk_equal']);
    assert.equal(p.core.holds.get(c.id)!.state, 'SUBSUMED');
    assert.deepEqual(incomingRecords(p), []);
    assert.equal(tickSkip(p.core).has('.env.prod'), false, 'no longer skipped');
  });
});
