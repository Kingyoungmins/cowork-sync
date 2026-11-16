// incomingStep in the test loop (Plan 3 Task 6; 05-holds HLD-32, HLD-53, HLD-54; 03-data DAT-29, DAT-33; 09-security SEC-32 (the
// record); glossary §9, §20; rulings R3-29, R3-30, R3-56): not-applicable paths are INCOMING records at once whose creation op waits
// 60 s (a record released earlier emits nothing), an incoming change to a quarantined path is a local_only `quarantine-review`
// record, and a publish-side exclusion (unreadable, unstable) becomes one PIN after 60 s Δmono — one op at creation, one at release,
// none when the path holds nothing (h0 and h1 ABSENT). The loop is incomingFixture's (Task 12's recordStep makes the same calls).
// Real git on file:// clones; never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { applyStep } from '../../src/engine/apply.js';
import { recordStep } from '../../src/engine/holdSteps.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import { readWork, workPath, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { incomingRecords, loop, onlyWithGuard, privateBlobs, registryHead, withGuard } from '../helpers/incomingFixture.js';
import { holdOpsSince, remoteTip } from '../helpers/mirrorFixture.js';
import { buf, LogRecorder, prep, withCores } from '../helpers/publishHelpers.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const QUARANTINED = '.claude/settings.json';

async function boardOpsOf(fx: CoreFixture, p: PeerFixture, from: Oid, id: string): Promise<string[]> {
  return (await holdOpsSince(p, from, await remoteTip(fx, p))).filter((x) => x.op.hold_id === id).map((x) => x.op.state);
}

test('each not-applicable path gets its own INCOMING record at once', T10, async () => {
  const files = { 'README.md': buf('# not applicable\n'), '.gitignore': buf('.env\n'), 'src/a.txt': buf('a\n') };
  await withCores('inc-na', { n: 1, files, platform: 'win32' }, async (fx) => {
    const p = fx.peers[0]!;
    const log = new LogRecorder();
    p.deps.log = log;
    await writeWork(p, '.env', 'SECRET=local\n');
    await fx.pushTeamChange({ 'con.py': buf('print(1)\n'), '.env': buf('SECRET=team\n'), [QUARANTINED]: buf('{"hooks":{}}\n'), 'src/x.txt': buf('x\n') });
    fx.advance(10_000);
    const l = await loop(p);
    assert.deepEqual([...l.apply.notApplicable].sort(), [['.claude/settings.json', 'quarantine'], ['.env', 'collision'], ['con.py', 'unmaterializable']]);
    assert.deepEqual(l.apply.written, ['src/x.txt'], 'the rest of the CS is not deferred');
    assert.deepEqual(l.apply.closures, []);
    assert.equal(l.created.length, 3, 'the first incomingStep creates three records');
    const byPath = new Map(incomingRecords(p).map((r) => [r.paths[0]!, r] as const));
    const want: Array<[string, string, boolean]> = [['con.py', 'unmaterializable', false], ['.env', 'collision', true], [QUARANTINED, 'quarantine-review', true]];
    for (const [path, guard, localOnly] of want) {
      const r = byPath.get(path)!;
      assert.ok(r !== undefined, path);
      assert.deepEqual([r.kind, r.residence, r.state, r.paths, r.guards.map((g) => g.name), r.local_only], ['INCOMING', 'ON_DISK', 'ACTIVE', [path], [guard], localOnly], path);
      assert.ok('h1' in r.blobs);
      assert.equal(r.blobs.h0[path], ABSENT, `${path}: h0 = A[p] (ABSENT for a creation)`);
      assert.equal(r.blobs.h1[path], l.it.tipMap.get(path)!.oid, `${path}: h1 = TIP[p]`);
    }
    const ids = { con: byPath.get('con.py')!.id, env: byPath.get('.env')!.id };
    assert.equal(l.apply.notApplicableRules.get('con.py'), 2);
    assert.deepEqual(l.codes, [
      { code: 'INCOMING_COLLISION', params: { id: ids.env, path: '.env' } },
      { code: 'INCOMING_UNMATERIALIZABLE', params: { id: ids.con, path: 'con.py', rule: 2 } },
    ]);
    assert.deepEqual(log.lines.filter((x) => x.code.startsWith('INCOMING_')).map((x) => x.code), ['INCOMING_COLLISION', 'INCOMING_UNMATERIALIZABLE'], 'the log carries both');
    assert.deepEqual(p.core.holdCode, l.codes.at(-1), 'holdCode the newest');
    // A second loop creates nothing more and raises nothing again.
    fx.advance(10_000);
    const again = await loop(p);
    assert.deepEqual([again.created, again.codes], [[], []]);
  });
});

test("a not-applicable record's creation op waits 60 s and one released earlier emits nothing", T10, async () => {
  const files = { 'README.md': buf('# creation op\n'), '.gitignore': buf('.env\n') };
  await withCores('inc-na-op', { n: 1, files, platform: 'win32' }, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, '.env', 'SECRET=local\n');
    await fx.pushTeamChange({ 'con.py': buf('c\n'), '.env': buf('SECRET=team\n') });
    fx.advance(10_000);
    await loop(p, { mirror: true });
    const um = onlyWithGuard(p, 'unmaterializable');
    const col = onlyWithGuard(p, 'collision');
    const drafted = new Set<string>();
    for (let t = 10; t <= 90; t += 10) {
      if (t === 30) await fx.pushTeamChange({ '.env': null });   // TIP no longer contains .env
      fx.advance(10_000);
      await loop(p, { mirror: true });
      for (const id of [um.id, col.id]) if (p.core.outbox.pendingHold(id) !== null) drafted.add(id);
      if (t < 60) assert.equal(p.core.outbox.pendingHold(um.id), null, `+${t} s: the creation op waits`);
      if (t === 40) assert.equal(p.core.holds.get(col.id)!.state, 'SUBSUMED', 'the collision record ended at 40 s');
    }
    assert.ok(drafted.has(um.id), 'the unmaterializable record is drafted at age 60 s');
    assert.equal(p.core.outbox.pendingHold(um.id)?.state, 'ACTIVE');
    assert.ok(!drafted.has(col.id), 'a record released before its creation op was drafted emits nothing, ever');
  });
});

test('a quarantine-review record comes from an incoming change to a quarantined path', T10, async () => {
  const files = { 'README.md': buf('# quarantine\n'), [QUARANTINED]: buf('{}\n') };
  await withCores('inc-quarantine', { n: 1, files }, async (fx) => {
    const p = fx.peers[0]!;
    await fx.pushTeamChange({ [QUARANTINED]: buf('{"hooks":{"PreToolUse":[]}}\n') });
    fx.advance(10_000);
    const l = await loop(p);
    assert.equal(l.apply.notApplicable.get(QUARANTINED), 'quarantine');
    assert.equal((await readWork(p, QUARANTINED))?.toString(), '{}\n', 'apply leaves it unwritten');
    const r = onlyWithGuard(p, 'quarantine-review');
    assert.deepEqual([r.kind, r.state, r.paths, r.local_only], ['INCOMING', 'ACTIVE', [QUARANTINED], true], 'local_only by the LIVE-only rule');
    for (let i = 0; i < 6; i++) {
      fx.advance(10_000);
      await loop(p, { mirror: true });
    }
    const op = p.core.outbox.pendingHold(r.id);
    assert.ok(op !== null);
    assert.equal(op.local_only, true, 'mirrored only as a stub');
    assert.equal(p.core.holds.get(r.id)!.state, 'ACTIVE', 'its release is Plan 7\'s (/cowork review --accept)');
  });
});

test('an unreadable path makes no record for 59 s and one PIN at 60 s', T10, async () => {
  const files = { 'README.md': buf('# unreadable\n'), 'src/a.txt': buf('a1\na2\n') };
  await withCores('inc-unreadable', { n: 1, files }, async (fx) => {
    const p = fx.peers[0]!;
    await loop(p);
    await writeWork(p, 'src/a.txt', 'a1\na2 local\n');
    p.fs.holdLock(workPath(p, 'src/a.txt'), 'share-none');
    fx.advance(2_500);
    const head = registryHead(p);
    let pin: string | null = null;
    for (let t = 0; t <= 60_000; t += 2_500) {
      const l = await loop(p, { mirror: true });
      assert.equal(l.it.tick!.excluded.get('src/a.txt'), 'unreadable', `+${t} ms: staged reads fail`);
      if (t < 60_000) {
        assert.equal(registryHead(p), head, `+${t} ms: nothing`);
        assert.ok(!p.core.outbox.drafts().some((d) => d.type === 'hold'));
      } else {
        assert.equal(l.created.length, 1, 'one PIN at 60 s');
        pin = l.created[0]!;
      }
      fx.advance(2_500);
    }
    const r = p.core.holds.get(pin!)!;
    const A = (await loop(p)).it.A;
    const priv = await privateBlobs(p);
    assert.deepEqual([r.kind, r.residence, r.state, r.paths, r.guards.map((g) => g.name), r.local_only], ['PIN', 'ON_DISK', 'ACTIVE', ['src/a.txt'], ['unreadable'], false]);
    assert.ok('h1' in r.blobs);
    assert.equal(r.blobs.h0['src/a.txt'], A.get('src/a.txt')!.oid, 'h0 = A[p]');
    assert.equal(r.blobs.h1['src/a.txt'], priv('src/a.txt'), 'h1 = the blob the private index holds');
  });
});

test('an unstable secret-like path becomes a local_only PIN guarded unstable', T10, async () => {
  const files = { 'README.md': buf('# unstable\n'), '.env.dev': buf('DEV=1\n') };
  await withCores('inc-unstable', { n: 1, files }, async (fx) => {
    const p = fx.peers[0]!;
    await loop(p);
    // Every read of the file meets a writer that just changed it: the staged read's size check fails twice (UNSTABLE).
    let n = 0;
    const abs = workPath(p, '.env.dev');
    p.fs.interpose('readFile', '.env.dev', async () => {
      n++;
      await writeFile(abs, `DEV=${'x'.repeat(n % 7)}${n}\n`);
    }, 100_000);
    await writeWork(p, '.env.dev', 'DEV=2\n');
    fx.advance(2_500);
    let created: string[] = [];
    for (let t = 0; t <= 60_000 && created.length === 0; t += 10_000) {
      const l = await loop(p);
      assert.equal(l.it.tick!.excluded.get('.env.dev'), 'unstable', `+${t} ms`);
      created = l.created;
      fx.advance(10_000);
    }
    const r = onlyWithGuard(p, 'unstable');
    assert.deepEqual(created, [r.id]);
    assert.deepEqual([r.kind, r.state, r.paths, r.local_only], ['PIN', 'ACTIVE', ['.env.dev'], true], 'local_only by the secret-like pattern (a stub)');
  });
});

test('a transient record is released when the condition clears: one op at creation, one at release', T10, async () => {
  const files = { 'README.md': buf('# transient release\n'), 'src/a.txt': buf('a1\na2\n') };
  await withCores('inc-transient-release', { n: 1, files }, async (fx) => {
    const p = fx.peers[0]!;
    const from = p.core.view!.laB;
    await loop(p);
    await writeWork(p, 'src/a.txt', 'a1\na2 local\n');
    const release = p.fs.holdLock(workPath(p, 'src/a.txt'), 'share-none');
    fx.advance(10_000);
    let id: string | null = null;
    for (let t = 0; t <= 70_000 && id === null; t += 10_000) {
      id = (await loop(p, { publish: true })).created[0] ?? null;
      fx.advance(10_000);
    }
    assert.ok(id !== null);
    for (let i = 0; i < 2; i++) {
      await loop(p, { publish: true });
      fx.advance(10_000);
    }
    release();   // the holder closes
    const l = await loop(p, { publish: true });
    assert.equal(p.core.holds.get(id)!.state, 'SUBSUMED');
    assert.deepEqual(l.released, [id]);
    for (let i = 0; i < 3; i++) {
      fx.advance(10_000);
      await loop(p, { publish: true });
    }
    assert.deepEqual(await boardOpsOf(fx, p, from, id), ['ACTIVE', 'SUBSUMED'], 'the board saw exactly two hold ops for it');
  });
});

test('an unreadable new file that was never staged gets no PIN', T10, async () => {
  const files = { 'README.md': buf('# never staged\n'), 'src/a.txt': buf('a\n') };
  await withCores('inc-never-staged', { n: 1, files }, async (fx) => {
    const p = fx.peers[0]!;
    await loop(p);
    const release = p.fs.holdLock(workPath(p, 'src/new.txt'), 'share-none');
    await writeWork(p, 'src/new.txt', 'new\n');
    fx.advance(2_500);
    const head = registryHead(p);
    const pushes = p.core.pushAttempts;
    for (let t = 0; t <= 120_000; t += 10_000) {
      const l = await loop(p, { publish: true });
      assert.equal(l.it.tick!.excluded.get('src/new.txt'), 'unreadable', `+${t} ms`);
      assert.deepEqual(l.created, [], `+${t} ms: no record (A[p] and privateBlob(p) are both ABSENT)`);
      fx.advance(10_000);
    }
    assert.equal(registryHead(p), head, 'no registry commit');
    assert.deepEqual(withGuard(p, 'unreadable'), []);
    assert.equal(p.core.pushAttempts, pushes, 'nothing of it is published');
    assert.ok(p.core.transient.ages().has('path:src/new.txt'), 'still a listed transient exclusion (its not_converged line is Task 12a\'s)');
    release();
    const l = await loop(p);
    assert.ok(l.it.tick!.changed.has('src/new.txt'), 'after unlock the file is read');
    assert.ok(p.core.cs.openPaths().has('src/new.txt'), 'and joins the human CS');
    assert.equal(p.core.transient.ages().has('path:src/new.txt'), false);
  });
});

test('Task EF (item 2): an edit held without read sharing before any tick staged it (h0 = h1 = A[p]) is ONE unreadable PIN for as long as the lock lasts — recordStep\'s R1 keeps it, never SUBSUMED and re-created — and it ends SUBSUMED once the path reads again', T10, async () => {
  const files = { 'README.md': buf('# unreadable, never staged edit\n'), 'src/a.txt': buf('a1\na2\n') };
  await withCores('inc-unreadable-one', { n: 1, files }, async (fx) => {
    const p = fx.peers[0]!;
    /** The loop's order for these steps: prepareIteration ('auto'), applyStep, recordStep (R1, the PREDICATE guards, incomingStep). */
    const iteration = async (): Promise<void> => {
      fx.advance(2_500);
      const it = await prep(p, 'auto');
      await recordStep(p.core, it, await applyStep(p.core, it));
    };
    await prep(p, true);   // a materialized S_disk exists, as on a running peer (R1 reads the last one)
    const A = p.core.view!.base;
    await writeWork(p, 'src/a.txt', 'a1\na2 local\n');
    const release = p.fs.holdLock(workPath(p, 'src/a.txt'), 'share-none');
    try {
      for (let t = 0; t < 150_000; t += 2_500) await iteration();
      const pins = withGuard(p, 'unreadable');
      assert.equal(pins.length, 1, `one unreadable PIN over 150 s of the lock: ${JSON.stringify(pins.map((r) => [r.id, r.state, r.rev]))}`);
      const r = pins[0]!;
      assert.deepEqual([r.kind, r.residence, r.state, r.paths], ['PIN', 'ON_DISK', 'ACTIVE', ['src/a.txt']], 'it lives while the path stays unreadable');
      assert.ok('h1' in r.blobs);
      const a = (await p.core.repo.readTreeMap(A)).get('src/a.txt')!.oid;
      assert.deepEqual([r.blobs.h0['src/a.txt'], r.blobs.h1['src/a.txt']], [a, a], 'the never-staged edit: h0 = h1 = A[p]');
    } finally {
      release();
    }
    for (let i = 0; i < 4 && withGuard(p, 'unreadable')[0]!.state === 'ACTIVE'; i++) await iteration();
    const after = withGuard(p, 'unreadable');
    assert.deepEqual(after.map((r) => r.state), ['SUBSUMED'], 'released when the path reads again, and no second PIN');
  });
});
