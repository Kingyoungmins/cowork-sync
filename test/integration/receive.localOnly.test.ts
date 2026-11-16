// Local-only conflicts (Plan 3 Task 6; 05-holds HLD-55, Table 3 `local-only-conflict`; 03-data §3.9 D8 step 0, P-DAT-02 DEFER
// leg; rulings R3-21, R3-31): an incoming change whose merge would displace the local side of a path held by a non-terminal ON_DISK
// local_only record is never applied over it — the conflict function answers DEFER `local_only_conflict`, the closure is deferred
// and becomes one INCOMING `local-only-conflict` record at 60 s; it is released (SUBSUMED) by the apply that follows once the
// local_only record ends or stops being local_only. Real git on file:// clones; never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localOnlyScope } from '../../src/engine/core.js';
import { readWork, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { incomingRecords, loop, onlyWithGuard } from '../helpers/incomingFixture.js';
import { holdPatch } from '../helpers/mirrorFixture.js';
import { buf, withCores } from '../helpers/publishHelpers.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const ENV = 'config/.env.local';
const Y = 'src/y.txt';
const BASE_ENV = 'K=1\nX=2\nY=3\n';
const LOCAL_ENV = 'K=1\nX=local secret\nY=3\n';
const TEAM_ENV = 'K=1\nX=team\nY=3\n';
const FILES = { 'README.md': buf('# local only\n'), [ENV]: buf(BASE_ENV), [Y]: buf('y1\ny2\n'), 'config/app.ini': buf('a=1\nb=2\nc=3\n') };

/** The local edit held by an ON_DISK PATCH (made with hold()) that is local_only, and the teammate's same-line change in one CS with y.txt. */
async function setup(fx: CoreFixture, p: PeerFixture, path: string, local: string, team: string, guard: string): Promise<string> {
  await loop(p);   // warm-up
  await writeWork(p, path, local);
  const { id } = await holdPatch(p, path, local, guard);
  assert.equal(p.core.holds.get(id)!.local_only, true, 'the record is local_only');
  await fx.pushTeamChange({ [path]: buf(team), [Y]: buf('y1\ny2 team\n') });
  fx.advance(10_000);
  return id;
}

test('an incoming change that would displace a local_only path defers its closure', T10, async () => {
  await withCores('rlocal-defer', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    // config/.env.local is tracked (LIVE); the PATCH over it is local_only by the secret-like pattern (HLD-03).
    await setup(fx, p, ENV, LOCAL_ENV, TEAM_ENV, 'revert');
    const first = await loop(p);
    assert.equal(first.apply.deferred.get(ENV), 'local_only_conflict', 'conflict returns DEFER local_only_conflict (D8 step 0)');
    assert.equal(first.apply.deferred.get(Y), 'closure');
    assert.deepEqual(first.apply.closures, [{ paths: [ENV, Y], reason: 'local_only_conflict', path: ENV }], 'the closure is deferred');
    assert.equal((await readWork(p, ENV))?.toString(), LOCAL_ENV, 'the local side is never displaced');
    assert.equal((await readWork(p, Y))?.toString(), 'y1\ny2\n');
    for (let t = 10; t < 60; t += 10) {
      fx.advance(10_000);
      assert.deepEqual((await loop(p)).created, [], `no record at +${t} s`);
    }
    fx.advance(10_000);
    const due = await loop(p);
    assert.equal(due.created.length, 1, 'at 60 s');
    const r = onlyWithGuard(p, 'local-only-conflict');
    assert.deepEqual([r.kind, r.state, r.paths], ['INCOMING', 'ACTIVE', [ENV, Y]], 'one record over the closure');
    assert.equal(r.local_only, true, 'its secret-like path keeps it a stub');
    assert.equal((await readWork(p, ENV))?.toString(), LOCAL_ENV);
  });
});

test('an INCOMING record never makes a path LOCAL_ONLY (the R3-21 amendment)', T10, async () => {
  // An INCOMING record holds TIP's bytes, none of this disk's: it never drives D5 row 9 or D8 step 0 (core.ts localOnlyScope) and
  // never keeps another record local_only (the registry's local_only recompute), else HLD-55's release would deadlock. app.ini is not
  // secret-like: its PATCH is local_only by its `secret-scan` guard alone.
  await withCores('rlocal-incoming-scope', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const ini = 'config/app.ini';
    const lo = await setup(fx, p, ini, 'a=1\nb=local\nc=3\n', 'a=1\nb=team\nc=3\n', 'secret-scan');
    for (let t = 0; t <= 60; t += 10) {
      await loop(p);
      fx.advance(10_000);
    }
    const r = onlyWithGuard(p, 'local-only-conflict');
    assert.deepEqual([r.paths, r.local_only], [[ini, Y], true], 'the INCOMING record is a stub: app.ini is LOCAL_ONLY by the PATCH');
    const scope = localOnlyScope(p.core);
    assert.equal(scope.paths.has(ini), true, 'app.ini is LOCAL_ONLY by its own local_only PATCH');
    assert.equal(scope.paths.has(Y), false, 'the INCOMING record does not make y.txt LOCAL_ONLY (localOnlyScope)');
    const { id } = await holdPatch(p, Y, 'y1\ny2 mine\n', 'revert');
    assert.equal(p.core.holds.get(id)!.local_only, false, 'a record on y.txt is not local_only for the INCOMING record covering it');
    await p.core.holds.releaseGuard(lo, 'secret-scan');
    assert.equal(p.core.holds.get(lo)!.local_only, false, 'the PATCH stops being local_only: the INCOMING record on app.ini does not keep it (registry)');
  });
});

test('the local-only-conflict record is released when the local_only record ends', T10, async () => {
  // (a) The local_only record ends (RESOLVED_DISCARD, the disk back to A): the next apply writes the closure.
  await withCores('rlocal-release-end', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const lo = await setup(fx, p, ENV, LOCAL_ENV, TEAM_ENV, 'revert');
    for (let t = 0; t <= 60; t += 10) {
      await loop(p);
      fx.advance(10_000);
    }
    const r = onlyWithGuard(p, 'local-only-conflict');
    await writeWork(p, ENV, BASE_ENV);
    await p.core.holds.transition(lo, { state: 'RESOLVED_DISCARD' });
    const l = await loop(p);
    assert.deepEqual(l.apply.written, [ENV, Y], 'the next apply writes the closure');
    assert.equal((await readWork(p, ENV))?.toString(), TEAM_ENV);
    assert.equal(p.core.holds.get(r.id)!.state, 'SUBSUMED');
    assert.deepEqual(incomingRecords(p), []);
  });
  // (b) The local_only record stops being local_only (its `secret-scan` guard is released on a path that is not secret-like): the
  // conflict function no longer defers; D8 takes TIP with a K4 record of the local side, and the closure applies.
  await withCores('rlocal-release-flag', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const ini = 'config/app.ini';
    const lo = await setup(fx, p, ini, 'a=1\nb=local\nc=3\n', 'a=1\nb=team\nc=3\n', 'secret-scan');
    for (let t = 0; t <= 60; t += 10) {
      await loop(p);
      fx.advance(10_000);
    }
    const r = onlyWithGuard(p, 'local-only-conflict');
    await p.core.holds.releaseGuard(lo, 'secret-scan');
    assert.equal(p.core.holds.get(lo)!.local_only, false);
    const l = await loop(p);
    assert.deepEqual(l.apply.written, [ini, Y], 'the next apply writes the closure');
    assert.equal(p.core.holds.get(r.id)!.state, 'SUBSUMED');
    assert.ok(p.core.holds.all().some((h) => h.guards.some((g) => g.name === 'conflict') && h.paths.includes(ini)), 'the local side kept in a K4 record');
  });
});
