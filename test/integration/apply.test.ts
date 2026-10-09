// Apply (01-engine §3.11; ENG-06, ENG-29…ENG-36; INV-ENG-PROGRESS; HLD-41, HLD-53; DAT-29, DAT-33; rulings R-02, R-05) and
// the iteration preparation (01-engine §3.5 steps 1–3), on EngineCores over real clones of a file:// remote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import { applyNeeded, applyStep, FREE_SPACE_MARGIN_BYTES, type ApplyReport } from '../../src/engine/apply.js';
import { captureDue, prepareIteration, type IterationCtx } from '../../src/engine/core.js';
import type { MutantId } from '../../src/engine/deps.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import type { TreeMap } from '../../src/git/repo.js';
import { setCrashHandler } from '../../src/ports/crashpoint.js';
import { makeCores, readWork, workPath, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import * as hp from '../helpers/publishHelpers.js';
import { publishStep } from '../../src/engine/publish.js';

const lines = (n: number, f: (i: number) => string = (i) => `line ${i}`): string => Array.from({ length: n }, (_, i) => `${f(i + 1)}\n`).join('');
const buf = (s: string): Buffer => Buffer.from(s, 'utf8');

const K_BASE = lines(12);
const P_BASE = lines(40, (i) => `value_${i} = ${i}  # p.py row ${i}`);

const FILES: Record<string, Buffer> = {
  '.gitignore': buf('.env\n'),
  '.gitattributes': buf('gen/** linguist-generated\n'),
  'README.md': buf('# apply fixture\n'),
  'notes.md': buf('# Notes\n\nalpha\n'),
  'src/a.ts': buf('export const a = 1;\n'),
  'src/k.txt': buf(K_BASE),
  'p.py': buf(P_BASE),
  'gen/out.txt': buf('g1\n'),
  'x.txt': buf('x1\n'),
};

let iter = 0;

/** prepareIteration with a fresh fetch; the iteration must be prepared. */
async function prep(p: PeerFixture, materialize: boolean | 'auto' = 'auto'): Promise<IterationCtx> {
  const r = await prepareIteration(p.core, ++iter, { materialize, forceFetch: true });
  assert.ok(r.ok, `prepareIteration failed: ${JSON.stringify(r)}`);
  return r.it;
}

/** One permitted apply: 10 s later, prepared, applied. */
async function apply(fx: CoreFixture, p: PeerFixture): Promise<{ it: IterationCtx; r: ApplyReport }> {
  fx.advance(10_000);
  const it = await prep(p);
  return { it, r: await applyStep(p.core, it) };
}

async function stateA(p: PeerFixture): Promise<TreeMap> {
  const view = p.core.view;
  assert.ok(view !== null);
  return p.core.repo.readTreeMap(view.base);
}

async function tipEntry(p: PeerFixture, live: Oid, path: string): Promise<{ oid: Oid } | undefined> {
  const tree = (await p.core.repo.readCommit(live)).tree;
  return (await p.core.repo.readTreeMap(tree)).get(path);
}

function setMutants(p: PeerFixture, m: MutantId[]): void {
  p.deps.testMutants = new Set(m);
}

async function withCores<T>(label: string, opts: Parameters<typeof makeCores>[1], fn: (fx: CoreFixture, p: PeerFixture) => Promise<T>): Promise<T> {
  const fx = await makeCores(label, opts);
  try {
    await fx.bootstrap();
    return await fn(fx, fx.peers[0]!);
  } finally {
    await fx.cleanup();
  }
}

test('applyNeeded is any A[p] ≠ TIP[p] over applicable paths; mutant M17 misses a pending path', async () => {
  await withCores('apply-needed', { n: 1, files: FILES }, async (fx, p) => {
    const it0 = await prep(p, false);
    assert.equal(applyNeeded(p.core, it0), false, 'A == TIP after the bootstrap');
    // A teammate change of src/a.ts, applied while a share-read holder (Excel-like) refuses its rename.
    await fx.pushTeamChange({ 'src/a.ts': buf('export const a = 2;\n') });
    const release = p.fs.holdLock(workPath(p, 'src/a.ts'), 'share-read');
    const { r } = await apply(fx, p);
    release();
    assert.equal(r.ran, true);
    assert.equal(r.deferred.get('src/a.ts'), 'locked');
    const view = p.core.view!;
    assert.equal(view.meta.pending['src/a.ts'], 'locked', 'the deferred path is pending');
    const it = await prep(p, false);
    assert.equal(view.laC, it.tip, 'LA_C == TIP: the apply completed with a pending path');
    assert.notEqual(it.A.get('src/a.ts')?.oid, it.tipMap.get('src/a.ts')?.oid);
    assert.equal(applyNeeded(p.core, it), true, 'the pending path triggers the apply');
    // The progress oracle (INV-ENG-PROGRESS: the unlocked pending path is written at the next permitted apply) fails
    // under mutant M17 (TIP != LA_C) at every permitted apply, and holds without it (TC-TST-02 form).
    const progress = async (): Promise<boolean> => {
      const { r: next } = await apply(fx, p);
      const onDisk = await readWork(p, 'src/a.ts');
      return next.written.includes('src/a.ts') && onDisk !== null && onDisk.equals(buf('export const a = 2;\n'))
        && (await stateA(p)).get('src/a.ts')?.oid === it.tipMap.get('src/a.ts')?.oid;
    };
    setMutants(p, ['M17']);
    assert.equal(await progress(), false, 'M17: the pending path is not applied at the next permitted apply');
    assert.equal(await progress(), false, 'M17: nor at the one after');
    assert.deepEqual(await readWork(p, 'src/a.ts'), buf('export const a = 1;\n'));
    setMutants(p, []);
    assert.equal(await progress(), true, 'the progress oracle holds without the mutant');
    assert.deepEqual(p.core.view!.meta.pending, {});
  });
});

test('a path deferred by a share-read lock is applied at the next permitted apply after unlock, even with TIP == LA_C', async () => {
  await withCores('apply-progress', { n: 1, files: FILES }, async (fx, p) => {
    const { live } = await fx.pushTeamChange({ 'src/a.ts': buf('export const a = 3;\n') });
    const release = p.fs.holdLock(workPath(p, 'src/a.ts'), 'share-read');
    const first = await apply(fx, p);
    assert.equal(first.r.deferred.get('src/a.ts'), 'locked');
    assert.deepEqual(await readWork(p, 'src/a.ts'), buf('export const a = 1;\n'), 'nothing written while locked');
    release();
    assert.equal(p.core.view!.laC, live, 'TIP == LA_C before this apply (the locked apply completed)');
    const second = await apply(fx, p);
    assert.equal(second.r.ran, true);
    assert.deepEqual(second.r.written, ['src/a.ts']);
    assert.deepEqual(await readWork(p, 'src/a.ts'), buf('export const a = 3;\n'));
    assert.equal((await stateA(p)).get('src/a.ts')?.oid, (await tipEntry(p, live, 'src/a.ts'))?.oid, 'A[p] := TIP[p] after the verified write');
    assert.deepEqual(p.core.view!.meta.pending, {});
  });
});

test('at most one apply per 10 s Δmono', async () => {
  await withCores('apply-coalesce', { n: 1, files: FILES }, async (fx, p) => {
    await fx.pushTeamChange({ 'src/a.ts': buf('export const a = 4;\n') });
    const one = await apply(fx, p);
    assert.equal(one.r.ran, true);
    await fx.pushTeamChange({ 'x.txt': buf('x2\n') });
    fx.advance(5_000);
    const it = await prep(p);
    const two = await applyStep(p.core, it);
    assert.equal(two.ran, false);
    assert.equal(two.skipped, 'coalesced');
    assert.deepEqual(await readWork(p, 'x.txt'), buf('x1\n'));
    fx.advance(5_000);
    const three = await applyStep(p.core, await prep(p));
    assert.equal(three.ran, true, '10 s after the last apply');
    assert.deepEqual(await readWork(p, 'x.txt'), buf('x2\n'));
  });
});

test('free space below 2 × bytes + 256 MB defers the whole apply as disk_low', async () => {
  await withCores('apply-disklow', { n: 1, files: FILES }, async (fx, p) => {
    const before = p.core.view!;
    await fx.pushTeamChange({ 'src/a.ts': buf('export const a = 5;\n'), 'x.txt': buf('x5\n') });
    p.fs.freeBytes = async () => FREE_SPACE_MARGIN_BYTES + 10;   // well below 2 × bytes + 256 MB
    const { r } = await apply(fx, p);
    assert.equal(r.ran, false);
    assert.equal(r.skipped, 'disk_low');
    assert.equal(r.deferred.get('src/a.ts'), 'disk_low');
    assert.equal(r.deferred.get('x.txt'), 'disk_low');
    assert.deepEqual(await readWork(p, 'src/a.ts'), buf('export const a = 1;\n'));
    assert.deepEqual(await readWork(p, 'x.txt'), buf('x1\n'));
    assert.equal(p.core.view!.base, before.base, 'A unchanged');
    assert.equal(p.core.view!.laC, before.laC, 'LA_C unchanged: the apply did not complete');
    assert.equal(p.core.view!.intent.kind, 'none', 'no intent journaled');
  });
});

test('a whole-apply disk_low commits a meta.pending-only transition naming every blocked path; when space returns they are written and pending empties (P2-DISKLOW-PENDING)', async () => {
  await withCores('apply-disklow-pending', { n: 1, files: FILES }, async (fx, p) => {
    // A locked deferral first: src/a.ts is pending 'locked'.
    await fx.pushTeamChange({ 'src/a.ts': buf('export const a = 14;\n') });
    const release = p.fs.holdLock(workPath(p, 'src/a.ts'), 'share-read');
    const locked = await apply(fx, p);
    release();
    assert.equal(locked.r.deferred.get('src/a.ts'), 'locked');
    assert.deepEqual(p.core.view!.meta.pending, { 'src/a.ts': 'locked' });
    // The disk fills; a teammate changes x.txt and creates .env over the user's ignored local .env (a collision).
    await writeWork(p, '.env', 'LOCAL_SECRET=1\n');
    const { live } = await fx.pushTeamChange({ 'x.txt': buf('x14\n'), '.env': buf('TEAM=1\n') });
    p.fs.freeBytes = async () => FREE_SPACE_MARGIN_BYTES + 10;
    const before = p.core.view!;
    const mark = fx.trace.events.length;
    for (let i = 0; i < 3; i++) {
      const { r } = await apply(fx, p);
      assert.equal(r.skipped, 'disk_low', `disk_low apply ${i + 1}`);
      assert.equal(r.deferred.get('x.txt'), 'disk_low');
      assert.equal(r.notApplicable.get('.env'), 'collision');
    }
    const view = p.core.view!;
    assert.deepEqual(view.meta.pending, { '.env': 'collision', 'src/a.ts': 'disk_low', 'x.txt': 'disk_low' }, 'every blocked path, the stale locked reason replaced');
    assert.deepEqual((await p.core.state.read())?.meta.pending, view.meta.pending);
    assert.equal(fx.trace.since(mark).filter((e) => e.kind === 'state').length, 1, 'one transition: the second and third disk_low applies change nothing');
    assert.deepEqual([view.base, view.laC, view.laB, view.snap, view.intent, view.ready, view.t], [before.base, before.laC, before.laB, before.snap, before.intent, before.ready, before.t],
      'A, LA_C, LA_B, snap, intent, journal trees and ready pairs unchanged');
    assert.deepEqual({ ...view.meta, pending: before.meta.pending }, before.meta, 'only meta.pending changed');
    assert.deepEqual(await readWork(p, 'x.txt'), buf('x1\n'));
    assert.deepEqual(await readWork(p, 'src/a.ts'), buf('export const a = 1;\n'));
    // Space returns and the user removed the local .env: every blocked path is written and pending empties.
    p.fs.freeBytes = async () => 1_000_000_000_000;
    await rm(workPath(p, '.env'));
    const ok = await apply(fx, p);
    assert.deepEqual(ok.r.written, ['.env', 'src/a.ts', 'x.txt']);
    assert.deepEqual(await readWork(p, 'src/a.ts'), buf('export const a = 14;\n'));
    assert.deepEqual(await readWork(p, 'x.txt'), buf('x14\n'));
    assert.deepEqual(await readWork(p, '.env'), buf('TEAM=1\n'));
    assert.equal(p.core.view!.laC, live);
    assert.deepEqual(p.core.view!.meta.pending, {});
  });
});

test('an ignored local .env stays byte-identical as a collision while src/a.ts of the same CS applies', async () => {
  await withCores('apply-collision', { n: 1, files: FILES }, async (fx, p) => {
    await writeWork(p, '.env', 'LOCAL_SECRET=1\n');
    await fx.pushTeamChange({ '.env': buf('TEAM=1\n'), 'src/a.ts': buf('export const a = 6;\n') });
    const { r } = await apply(fx, p);
    assert.equal(r.ran, true);
    assert.equal(r.notApplicable.get('.env'), 'collision');
    assert.equal(r.deferred.has('src/a.ts'), false, 'no closure deferral');
    assert.deepEqual(r.written, ['src/a.ts']);
    assert.deepEqual(await readWork(p, '.env'), buf('LOCAL_SECRET=1\n'), 'the local bytes are untouched');
    assert.deepEqual(await readWork(p, 'src/a.ts'), buf('export const a = 6;\n'));
    assert.equal((await stateA(p)).has('.env'), false, 'A[.env] stays absent');
    assert.equal(p.core.view!.meta.pending['.env'], 'collision');
  });
});

test('a persistent collision leaves the apply trigger; once the local file is gone the path rejoins it and is written (P2-NA-TRIGGER)', async () => {
  await withCores('apply-na-trigger', { n: 1, files: FILES }, async (fx, p) => {
    await writeWork(p, '.env', 'LOCAL_SECRET=1\n');
    await fx.pushTeamChange({ '.env': buf('TEAM=1\n'), 'src/a.ts': buf('export const a = 12;\n') });
    const first = await apply(fx, p);
    assert.equal(first.r.notApplicable.get('.env'), 'collision');
    assert.deepEqual(first.r.written, ['src/a.ts']);
    assert.deepEqual(p.core.view!.meta.pending, { '.env': 'collision' });
    // Idle iterations: the collision alone triggers no apply, no materialize, no merge and no state transition.
    const mark = fx.trace.events.length;
    for (let i = 0; i < 2; i++) {
      fx.advance(10_000);
      const idle = await prep(p);
      assert.equal(applyNeeded(p.core, idle), false, 'a collision that still holds is out of the trigger');
      assert.equal(idle.mat, null, "'auto' does not materialize for it");
      assert.equal((await applyStep(p.core, idle)).skipped, 'nothing');
    }
    assert.deepEqual(fx.trace.since(mark).filter((e) => e.kind === 'merge' || e.kind === 'state' || e.kind === 'apply').map((e) => e.kind), []);
    assert.deepEqual(await readWork(p, '.env'), buf('LOCAL_SECRET=1\n'));
    // The user removes the local .env: the re-check clears, the path rejoins the trigger and is written.
    await rm(workPath(p, '.env'));
    fx.advance(10_000);
    const back = await prep(p);
    assert.equal(applyNeeded(p.core, back), true, 'the cleared collision rejoins the trigger');
    const r = await applyStep(p.core, back);
    assert.deepEqual(r.written, ['.env']);
    assert.deepEqual(await readWork(p, '.env'), buf('TEAM=1\n'));
    assert.deepEqual(p.core.view!.meta.pending, {});
    assert.equal(applyNeeded(p.core, await prep(p, false)), false);
  });
});

test('an incoming change to a QUARANTINED path is never written live: not applicable as quarantine, A keeps its entry, and it does not loop the trigger (P2-QUARANTINE-IN)', async () => {
  const SETTINGS = buf('{ "permissions": { "allow": [] } }\n');
  await withCores('apply-quarantine', { n: 1, files: { ...FILES, '.claude/settings.json': SETTINGS } }, async (fx, p) => {
    const aBefore = (await stateA(p)).get('.claude/settings.json')?.oid;
    assert.ok(aBefore !== undefined);
    await fx.pushTeamChange({
      '.claude/settings.json': buf('{ "permissions": { "allow": ["Bash(*)"] }, "hooks": { "PreToolUse": [] } }\n'),
      'src/a.ts': buf('export const a = 13;\n'),
    });
    const { it, r } = await apply(fx, p);
    assert.equal(it.scope('.claude/settings.json').cls, 'QUARANTINED');
    assert.equal(r.ran, true);
    assert.deepEqual(r.written, ['src/a.ts'], 'only the LIVE path of the change-set is written');
    assert.equal(r.notApplicable.get('.claude/settings.json'), 'quarantine');
    assert.equal(r.deferred.has('.claude/settings.json'), false);
    assert.deepEqual(await readWork(p, '.claude/settings.json'), SETTINGS, "the user's Claude settings are untouched");
    assert.deepEqual(await readWork(p, 'src/a.ts'), buf('export const a = 13;\n'));
    assert.equal((await stateA(p)).get('.claude/settings.json')?.oid, aBefore, 'A keeps its entry');
    assert.deepEqual(p.core.view!.meta.pending, { '.claude/settings.json': 'quarantine' });
    assert.deepEqual((await p.core.state.read())?.meta.pending, { '.claude/settings.json': 'quarantine' }, 'parseMeta reads the reason back');
    // The trigger does not loop on it (P2-NA-TRIGGER).
    fx.advance(10_000);
    const idle = await prep(p);
    assert.equal(applyNeeded(p.core, idle), false);
    assert.equal((await applyStep(p.core, idle)).skipped, 'nothing');
    assert.deepEqual(await readWork(p, '.claude/settings.json'), SETTINGS);
  });
});

test('con.py and a:b.txt are unmaterializable on platform win32 while the rest of their group applies', async () => {
  await withCores('apply-unmat', { n: 1, files: FILES, platform: 'win32' }, async (fx, p) => {
    await fx.pushTeamChange({ 'con.py': buf('print(1)\n'), 'a:b.txt': buf('ab\n'), 'x.txt': buf('x7\n') });
    const { r } = await apply(fx, p);
    assert.equal(r.ran, true);
    assert.equal(r.notApplicable.get('con.py'), 'unmaterializable');
    assert.equal(r.notApplicable.get('a:b.txt'), 'unmaterializable');
    assert.deepEqual(r.written, ['x.txt']);
    assert.deepEqual(await readWork(p, 'x.txt'), buf('x7\n'));
    assert.equal(await readWork(p, 'con.py'), null);
    assert.equal(p.core.view!.meta.pending['con.py'], 'unmaterializable');
    const A = await stateA(p);
    assert.equal(A.has('con.py') || A.has('a:b.txt'), false, 'not-applicable paths keep A[p]');
    // Later applies continue, and the carried paths alone never trigger one.
    assert.equal(applyNeeded(p.core, await prep(p, false)), false);
    await fx.pushTeamChange({ 'x.txt': buf('x8\n') });
    const next = await apply(fx, p);
    assert.deepEqual(next.r.written, ['x.txt']);
    assert.deepEqual(await readWork(p, 'x.txt'), buf('x8\n'));
  });
});

test('an apply-side K4 commits its conflict record before the writer renames p; afterwards the record is OFF_DISK and A[p] = TIP[p]', async () => {
  await withCores('apply-k4', { n: 1, files: FILES }, async (fx, p) => {
    await writeWork(p, 'src/k.txt', K_BASE.replace('line 2\n', 'line 2 local\n'));
    await prep(p);   // the local edit is seen
    const { live } = await fx.pushTeamChange({ 'src/k.txt': buf(K_BASE.replace('line 2\n', 'line 2 team\n')) });
    let seenAtRename: string | null = null;
    p.fs.interpose('rename', `src${sep}k.txt`, async () => {
      const recs = p.core.holds.all().filter((h) => h.paths.includes('src/k.txt'));
      seenAtRename = recs.map((h) => `${h.kind}/${h.state}/${h.residence}/${h.guards.map((g) => g.name).join(',')}`).join(';');
    });
    const { r } = await apply(fx, p);
    assert.equal(seenAtRename, 'PATCH/CONFLICTED/ON_DISK/conflict', 'the record existed, ON_DISK CONFLICTED, when p was renamed');
    assert.equal(r.records.length, 1);
    const rec = p.core.holds.get(r.records[0]!);
    assert.ok(rec !== undefined);
    assert.equal(rec.residence, 'OFF_DISK');
    assert.equal(rec.state, 'CONFLICTED');
    assert.ok('s2' in rec.blobs);
    const local = await p.core.repo.hashBytes(buf(K_BASE.replace('line 2\n', 'line 2 local\n')), false);
    assert.equal(rec.blobs.s2['src/k.txt'], local, 'the record holds LOCAL');
    assert.deepEqual(await readWork(p, 'src/k.txt'), buf(K_BASE.replace('line 2\n', 'line 2 team\n')));
    assert.equal((await stateA(p)).get('src/k.txt')?.oid, (await tipEntry(p, live, 'src/k.txt'))?.oid);
  });
});

test('apply first: TIP renamed p.py to p2.py and edited line 3 while the local side edited line 25 — disk gets TIP\'s p2.py and no p.py, and one K4 record holding the local p.py exists before the delete', async () => {
  await withCores('apply-rename', { n: 1, files: FILES }, async (fx, p) => {
    const localP = P_BASE.replace('value_25 = 25', 'value_25 = 2500');
    await writeWork(p, 'p.py', localP);
    await prep(p);
    const teamP2 = P_BASE.replace('value_3 = 3', 'value_3 = 300');
    await fx.pushTeamChange({ 'p.py': null, 'p2.py': buf(teamP2) });
    let recordsAtDelete = -1;
    p.fs.interpose('rename', `${sep}p.py`, async () => {
      recordsAtDelete = p.core.holds.all().filter((h) => h.paths.includes('p.py') && h.guards.some((g) => g.name === 'conflict')).length;
    });
    const { r } = await apply(fx, p);
    assert.equal(r.ran, true);
    assert.equal(recordsAtDelete, 1, 'one K4 record for p.py existed when the writer moved p.py away');
    assert.deepEqual(await readWork(p, 'p2.py'), buf(teamP2), "TIP's p2.py, without the local line 25 edit");
    assert.equal(await readWork(p, 'p.py'), null);
    const recs = p.core.holds.all().filter((h) => h.guards.some((g) => g.name === 'conflict'));
    assert.equal(recs.length, 1);
    const rec = recs[0]!;
    assert.deepEqual(rec.paths, ['p.py']);
    assert.ok('s2' in rec.blobs);
    assert.equal(rec.blobs.s2['p.py'], await p.core.repo.hashBytes(buf(localP), false), 'the record holds the local p.py');
    const A = await stateA(p);
    assert.equal(A.has('p.py'), false);
    assert.equal(A.get('p2.py')?.oid, await p.core.repo.hashBytes(buf(teamP2), false));
  });
});

test('a same-position append to notes.md is written as the D9 concat with no record', async () => {
  await withCores('apply-concat', { n: 1, files: FILES }, async (fx, p) => {
    await writeWork(p, 'notes.md', '# Notes\n\nalpha\nlocal line\n');
    await prep(p);
    await fx.pushTeamChange({ 'notes.md': buf('# Notes\n\nalpha\nteam line\n') });
    const { r } = await apply(fx, p);
    assert.deepEqual(r.written, ['notes.md']);
    assert.deepEqual(await readWork(p, 'notes.md'), buf('# Notes\n\nalpha\nteam line\nlocal line\n'));
    assert.deepEqual(r.records, []);
    assert.equal(p.core.holds.all().length, 0, 'no record');
  });
});

test('UNMANAGED paths follow TIP without a write; SAVE_ONLY paths are written like LIVE', async () => {
  await withCores('apply-unmanaged', { n: 1, files: FILES }, async (fx, p) => {
    const { live } = await fx.pushTeamChange({ 'gen/out.txt': buf('g2\n'), '.gitignore': buf('.env\n*.log\n') });
    const mark = fx.trace.events.length;
    const { r } = await apply(fx, p);
    assert.equal(r.ran, true);
    assert.deepEqual(await readWork(p, 'gen/out.txt'), buf('g1\n'), 'the UNMANAGED path is never written');
    assert.deepEqual(await readWork(p, '.gitignore'), buf('.env\n*.log\n'), 'the SAVE_ONLY path is written');
    const A = await stateA(p);
    const tipGen = await tipEntry(p, live, 'gen/out.txt');
    assert.equal(A.get('gen/out.txt')?.oid, tipGen?.oid, 'A[UNMANAGED] := TIP');
    const index = await p.core.repo.listIndex(join(p.deps.paths.coworkDir, `${p.core.refs.e}.index`));
    assert.equal(index.get('gen/out.txt')?.oid, tipGen?.oid, 'its private-index entry is TIP[p]');
    const causes = new Map(fx.trace.since(mark).flatMap((e) => (e.kind === 'A_set' ? [[e.path, e.cause] as const] : [])));
    assert.equal(causes.get('gen/out.txt'), 'unmanaged_follow');
    assert.equal(causes.get('.gitignore'), 'write_verified');
  });
});

test('one ENG-36 state update sets A, LA_C := TIP, LA_B := T, snap, pending and the rebased ready pairs', async () => {
  await withCores('apply-eng36', { n: 1, files: FILES }, async (fx, p) => {
    const core = p.core;
    const capture = async (): Promise<string> => {
      fx.advance(20_000);
      const it = await prep(p, true);
      const cap = await core.cs.capture(core.repo, it.mat!.sDiskMap, it.A, core.scratch('r'));
      assert.ok(cap !== null && cap.pair !== null, 'the human CS closed after 20 s quiet');
      await core.commit({ ready: core.cs.ready(), meta: { ...core.view!.meta, cs_human_next: cap.nextN } });
      return cap.pair.csId;
    };
    // (a) a ready pair on notes.md, (b) a ready pair on src/k.txt: two publication groups.
    await writeWork(p, 'notes.md', '# Notes\n\nalpha\nlocal line\n');
    await prep(p);
    const csNotes = await capture();
    await writeWork(p, 'src/k.txt', K_BASE.replace('line 2\n', 'line 2 local\n'));
    fx.advance(1_000);
    await prep(p);
    const csK = await capture();
    assert.deepEqual(core.view!.ready.map((r) => r.csId), [csNotes, csK]);

    const { board, live } = await fx.pushTeamChange({
      'notes.md': buf('# Notes\n\nalpha\nteam line\n'),
      'src/k.txt': buf(K_BASE.replace('line 2\n', 'line 2 team\n')),
      'gen/out.txt': buf('g3\n'),
    });
    const mark = fx.trace.events.length;
    fx.advance(10_000);
    const it = await prep(p);
    const r = await applyStep(core, it);
    assert.equal(r.ran, true);
    const states = fx.trace.since(mark).filter((e) => e.kind === 'state');
    assert.equal(states.length, 2, 'the intent J, then ONE ENG-36 update');
    const view = core.view!;
    assert.equal(view.laC, live, 'LA_C := TIP');
    assert.equal(view.laB, board, 'LA_B := T');
    assert.equal(view.snap, it.mat!.sDisk, 'snap := the S_disk the apply merged against');
    assert.deepEqual(view.meta.pending, {});
    assert.equal(view.intent.kind, 'none');
    const A = await stateA(p);
    const tipTree = await core.repo.readTreeMap((await core.repo.readCommit(live)).tree);
    for (const path of ['notes.md', 'src/k.txt', 'gen/out.txt']) assert.equal(A.get(path)?.oid, tipTree.get(path)?.oid, `A[${path}] := TIP[${path}]`);
    // (a) the concat write keeps CS notes ready with R[p] == M_disk[p] (the verified-written concat) and A_cap == A_new.
    assert.deepEqual(view.ready.map((x) => x.csId), [csNotes]);
    const pair = view.ready[0]!;
    const concat = await core.repo.hashBytes(buf('# Notes\n\nalpha\nteam line\nlocal line\n'), false);
    assert.equal((await core.repo.readTreeMap(pair.R)).get('notes.md')?.oid, concat);
    assert.equal((await core.repo.readTreeMap(pair.A)).get('notes.md')?.oid, tipTree.get('notes.md')?.oid);
    // (b) the TAKE_TIP displacement cancels CS k; with every member closed it is re-captured from the next completed snapshot.
    assert.deepEqual(r.cancelled, [csK]);
    assert.equal(core.cs.closeDue(), true, 'a recapture is due without waiting for a hook');
    fx.advance(3_000);
    const next = await prep(p, 'auto');
    assert.ok(next.mat !== null, "'auto' materializes for the due recapture");
    const re = await core.cs.capture(core.repo, next.mat.sDiskMap, next.A, core.scratch('r'));
    assert.ok(re !== null && re.pair !== null && re.pair.paths.includes('src/k.txt'));
    const causes = fx.trace.since(mark).flatMap((e) => (e.kind === 'A_set' ? [`${e.path}:${e.cause}`] : [])).sort();
    assert.deepEqual(causes, ['gen/out.txt:unmanaged_follow', 'notes.md:write_verified', 'src/k.txt:write_verified']);
  });
});

test('a stranded restore keeps only its group journaled and no new intent is written while strandedPaths() is non-empty; after the restore succeeds the intent clears (P2-NARROW, P2-STRANDED)', async () => {
  await withCores('apply-stranded', { n: 1, files: FILES }, async (fx, p) => {
    // Two change-sets, so two write groups.
    await fx.pushTeamChange({ 'x.txt': buf('x15\n') });
    const { live } = await fx.pushTeamChange({ 'src/a.ts': buf('export const a = 15;\n') });
    // src/a.ts: P2's link fails, so do the rollback's relink of its .old and the next sweep's retry.
    p.fs.addRule({ op: 'link', pathIncludes: workPath(p, 'src/a.ts'), code: 'EPERM', times: 3 });
    const { it: first, r } = await apply(fx, p);
    assert.equal(r.ran, true);
    assert.deepEqual(r.written, ['x.txt'], 'the other group is written');
    assert.equal(r.deferred.get('src/a.ts'), 'locked');
    assert.deepEqual(p.core.writer.strandedPaths(), ['src/a.ts']);
    assert.equal(await readWork(p, 'src/a.ts'), null, 'p is absent while its restore is stranded');
    const view = p.core.view!;
    assert.equal(view.laC, live);
    assert.equal((await stateA(p)).get('x.txt')?.oid, first.tipMap.get('x.txt')?.oid, 'A moved for the written group');
    assert.equal(view.intent.kind, 'apply');
    assert.deepEqual(view.intent.kind === 'apply' ? view.intent.groups.map((g) => g.entries.map((e) => e.path)) : null, [['src/a.ts']], 'ONLY the stranded group stays journaled');
    assert.deepEqual([...view.t.keys()].sort(), ['M', 'S', 'TIP'], 'with its journal trees');
    assert.deepEqual(view.meta.pending, { 'src/a.ts': 'locked' });
    // While strandedPaths() is non-empty no new intent is journaled: the next permitted apply is gated.
    await fx.pushTeamChange({ 'README.md': buf('# changed\n') });
    const mark = fx.trace.events.length;
    fx.advance(10_000);
    const it = await prep(p);   // its sweep retries the restore: the third link failure
    assert.deepEqual(p.core.writer.strandedPaths(), ['src/a.ts']);
    assert.equal(applyNeeded(p.core, it), true);
    assert.equal(it.mat, null, "'auto' does not materialize for a gated apply");
    const gated = await applyStep(p.core, it);
    assert.equal(gated.ran, false);
    assert.equal(gated.skipped, 'stranded');
    assert.deepEqual(fx.trace.since(mark).filter((e) => e.kind === 'state' || e.kind === 'merge').map((e) => e.kind), [], 'no merge, no state transition');
    assert.equal(p.core.view, view, 'the narrowed intent is still the journaled one');
    assert.deepEqual(await readWork(p, 'README.md'), buf('# apply fixture\n'));
    // The next sweep restores p and the kept intent clears.
    fx.advance(1_000);
    const it2 = await prep(p);
    assert.deepEqual(p.core.writer.strandedPaths(), []);
    assert.deepEqual(await readWork(p, 'src/a.ts'), buf('export const a = 1;\n'), 'p restored from its .old');
    assert.equal(p.core.view!.intent.kind, 'none', 'the intent cleared');
    assert.equal(p.core.view!.t.size, 0);
    assert.equal(p.core.view!.base, view.base, 'nothing else changed');
    // The next permitted apply writes the rest (the coalesce window was not used by the gated apply).
    assert.equal((await applyStep(p.core, it2)).ran, true);
    assert.deepEqual(await readWork(p, 'src/a.ts'), buf('export const a = 15;\n'));
    assert.deepEqual(await readWork(p, 'README.md'), buf('# changed\n'));
    assert.deepEqual(p.core.view!.meta.pending, {});
    assert.equal(p.core.view!.intent.kind, 'none');
  });
});

test('a stranded path is never observed: every tick skips it and no human CS closes, materializes or captures while a restore is stranded; after the restore the capture holds no deletion of it (P2-STRANDED-SKIP)', async () => {
  await withCores('apply-stranded-skip', { n: 1, files: FILES }, async (fx, p) => {
    const core = p.core;
    const stranded = 7;   // prepared iterations while the restore stays stranded, 4 s apart: 28 s > the 20 s CS quiet
    await fx.pushTeamChange({ 'src/a.ts': buf('export const a = 15;\n') });
    // src/a.ts: P2's link fails, so do the rollback's relink of its .old and one sweep retry per prepared iteration.
    p.fs.addRule({ op: 'link', pathIncludes: workPath(p, 'src/a.ts'), code: 'EPERM', times: 2 + stranded });
    const { r } = await apply(fx, p);
    assert.equal(r.deferred.get('src/a.ts'), 'locked');
    assert.deepEqual(core.writer.strandedPaths(), ['src/a.ts']);
    assert.equal(await readWork(p, 'src/a.ts'), null, 'p is absent while its restore is stranded');
    const aOid = (await stateA(p)).get('src/a.ts')?.oid;
    // A local edit during the strand opens the human CS: without the gate its capture would be due 20 s later.
    await writeWork(p, 'notes.md', '# Notes\n\nalpha\nlocal line\n');
    const observed: string[] = [];
    for (let i = 1; i <= stranded; i++) {
      fx.advance(4_000);
      const it = await prep(p);   // 'auto'; its sweep retries the restore and fails again
      assert.deepEqual(core.writer.strandedPaths(), ['src/a.ts'], `iteration ${i}: the restore is still stranded`);
      const tick = it.tick!;
      observed.push(...tick.changed);
      assert.equal(tick.dirty.has('src/a.ts') || tick.changed.has('src/a.ts') || tick.excluded.has('src/a.ts'), false,
        `iteration ${i}: the stranded path is never observed (dirty ${JSON.stringify(tick.dirty.get('src/a.ts'))}, excluded ${tick.excluded.get('src/a.ts')})`);
      assert.equal(it.mat, null, `iteration ${i}: no materialize while a restore is stranded`);
      assert.equal(captureDue(core), false, `iteration ${i}: no capture while a restore is stranded`);
    }
    assert.deepEqual(observed, ['notes.md'], 'the local edit was observed, the stranded path never');
    assert.equal(core.cs.closeDue(), true, 'the human CS is quiet: only the stranded restore holds its capture');
    assert.deepEqual(core.view!.ready, [], 'no ready pair was captured');
    // The next sweep restores p: the capture is due again and holds the local edit only.
    fx.advance(4_000);
    const it = await prep(p);
    assert.deepEqual(core.writer.strandedPaths(), []);
    assert.deepEqual(await readWork(p, 'src/a.ts'), buf('export const a = 1;\n'), 'p restored from its .old');
    assert.equal(it.tick!.dirty.has('src/a.ts'), false, 'the restored p reads clean');
    assert.equal(captureDue(core), true);
    assert.ok(it.mat !== null, "'auto' materializes for the due capture");
    assert.equal(it.mat.sDiskMap.get('src/a.ts')?.oid, aOid, 'S_disk keeps p');
    const cap = await core.cs.capture(core.repo, it.mat.sDiskMap, it.A, core.scratch('r'));
    assert.ok(cap !== null && cap.pair !== null);
    assert.deepEqual(cap.pair.paths, ['notes.md'], 'no deletion of the stranded path is captured');
    assert.equal((await core.repo.readTreeMap(cap.pair.R)).has('src/a.ts'), false);
  });
});

test("crashpoint('apply.intent') fires after the intent is journaled and before any .new; crashpoint('apply.state') after the state update", async () => {
  await withCores('apply-crashpoints', { n: 1, files: FILES }, async (fx, p) => {
    const { live } = await fx.pushTeamChange({ 'src/a.ts': buf('export const a = 9;\n') });
    fx.advance(10_000);
    const it = await prep(p);
    const oldA = it.A.get('src/a.ts')?.oid;
    const tmp = join(p.deps.paths.coworkDir, 'tmp');
    const seen: string[] = [];
    const checks: string[] = [];
    setCrashHandler((name) => {
      if (!name.startsWith('apply.')) return;
      seen.push(name);
      const view = p.core.view!;
      if (name === 'apply.intent') {
        checks.push(`intent:${view.intent.kind}:${view.t.has('M') && view.t.has('S') && view.t.has('TIP')}`);
        checks.push(`new:${readdirSync(tmp).filter((f) => f.endsWith('.new')).length}`);
      }
      if (name === 'apply.state') {
        checks.push(`state:${view.intent.kind}:${view.laC === live}`);
        checks.push(`memA:${it.A.get('src/a.ts')?.oid === oldA}`);
      }
    });
    try {
      const r = await applyStep(p.core, it);
      assert.equal(r.ran, true);
    } finally {
      setCrashHandler(null);
    }
    assert.deepEqual(seen, ['apply.intent', 'apply.group.phase1', 'apply.group.phase2', 'apply.state']);
    assert.deepEqual(checks, ['intent:apply:true', 'new:0', 'state:none:true', 'memA:true']);
    assert.notEqual(it.A.get('src/a.ts')?.oid, oldA, 'the in-memory A follows after the crashpoint');
  });
});

test('a failed fetch is reported to the governor without moving its anchor or counting a pre-emption', async () => {
  await withCores('prepare-failed-fetch', { n: 1, files: FILES }, async (fx, p) => {
    const core = p.core;
    // A ready pair, so the governor sees allowed pending work.
    await writeWork(p, 'x.txt', 'x local\n');
    await prep(p);
    fx.advance(20_000);
    const it = await prep(p, true);
    const cap = await core.cs.capture(core.repo, it.mat!.sDiskMap, it.A, core.scratch('r'));
    assert.ok(cap !== null);
    await core.commit({ ready: core.cs.ready(), meta: { ...core.view!.meta, cs_human_next: cap.nextN } });
    fx.advance(3_000);
    await prep(p);   // T observed (unchanged since the bootstrap), pending
    const moved = `${fx.remote.dir}.away`;
    await rename(fx.remote.dir, moved);
    fx.advance(3_000);
    const failed = await prepareIteration(core, ++iter, { materialize: false, forceFetch: true });
    assert.ok(failed.ok && failed.it.fetched !== null && !failed.it.fetched.ok && !failed.it.fetched.deferred, 'the fetch failed');
    await rename(moved, fx.remote.dir);
    fx.advance(31_000);   // past the 30 s network backoff
    const back = await prepareIteration(core, ++iter, { materialize: false, forceFetch: true });
    assert.ok(back.ok && back.it.fetched?.ok === true, 'the fetch succeeded again');
    // The board tip never changed: its anchor is 34 s old, so the window (G_eff ≤ 10 s, rank 1) is open now.
    assert.equal(core.governor.msUntilWindow(1), 0);
  });
});

/** Every sharedindex.* file anywhere under dir (a split index writes them). */
function sharedIndexFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).filter((f) => basename(f).startsWith('sharedindex.')).sort();
}

test("a user's core.splitIndex=true makes no apply write a sharedindex.* file in the gitdir (ruling P2-SPLITINDEX)", async () => {
  await withCores('apply-splitindex', { n: 1, files: FILES }, async (fx, p) => {
    await p.core.repo.run(['config', 'core.splitIndex', 'true']);
    const gitDir = p.deps.paths.gitDir;
    assert.deepEqual(sharedIndexFiles(gitDir), [], 'none before the apply');
    await fx.pushTeamChange({ 'src/a.ts': buf('export const a = 11;\n'), 'x.txt': buf('x11\n') });
    const { r } = await apply(fx, p);
    assert.deepEqual(r.written, ['src/a.ts', 'x.txt']);
    assert.deepEqual(await readWork(p, 'x.txt'), buf('x11\n'));
    assert.deepEqual(sharedIndexFiles(gitDir), [], 'the scratch and private index calls wrote no shared index');
  });
});

test('prepareIteration fetches, checks, folds and ticks, and materializes only when asked', async () => {
  const fx = await makeCores('prepare', { n: 1, files: FILES });
  try {
    const p = fx.peers[0]!;
    assert.deepEqual(await prepareIteration(p.core, 1, { materialize: true, forceFetch: true }), { ok: false, why: 'no_state' });
    await fx.bootstrap();
    const { board, live } = await fx.pushTeamChange({ 'x.txt': buf('x10\n') });
    const mark = fx.trace.events.length;
    const r = await prepareIteration(p.core, 2, { materialize: false, forceFetch: true });
    assert.ok(r.ok);
    const it = r.it;
    assert.equal(it.n, 2);
    assert.ok(it.fetched !== null && it.fetched.ok && !it.fetched.deferred);
    assert.ok(fx.trace.since(mark).some((e) => e.kind === 'fetch' && e.board === board), 'one fetch of the board');
    assert.equal(it.T, board);
    assert.equal(it.tip, live);
    assert.equal(it.fold.height, 1, 'B0 and the teammate commit folded');
    assert.deepEqual(it.version, { proto: false, regionSpec: false, checkpointMismatch: false });
    assert.deepEqual(it.pushStates, []);
    assert.ok(it.tick !== null && !it.tick.failed);
    assert.equal(it.mat, null, 'no materialize unless asked');
    assert.equal(it.tipMap.get('x.txt')?.oid, await p.core.repo.hashBytes(buf('x10\n'), false));
    assert.equal(it.scope('gen/out.txt').cls, 'UNMANAGED');
    assert.equal(it.scope('src/a.ts').cls, 'LIVE');
    fx.advance(3_000);
    const r2 = await prepareIteration(p.core, 3, { materialize: true, forceFetch: false });
    assert.ok(r2.ok);
    assert.ok(r2.it.mat !== null, 'materialized when asked');
    assert.equal(r2.it.A, it.A, 'the same A map across iterations (P2-ATREE)');
  } finally {
    await fx.cleanup();
  }
});

test('final review FB-1: a temp name of the next intent held by a file that refuses the move defers the whole apply locked before anything is recorded, journaled or written; the next permitted apply moves the holder aside and writes', async () => {
  await withCores('apply-fb1-locked', { n: 1, files: FILES }, async (fx, p) => {
    const tmp = join(p.deps.paths.coworkDir, 'tmp');
    const stale = join(tmp, '0.0.old');
    await writeFile(stale, 'a leftover of an earlier run\n');
    p.fs.addRule({ op: 'rename', pathIncludes: stale, code: 'EBUSY', times: 1 });
    await fx.pushTeamChange({ 'x.txt': buf('x2\n') });
    const stateBefore = await p.core.repo.readRef(p.core.refs.state);
    const { r } = await apply(fx, p);
    assert.equal(r.ran, false);
    assert.equal(r.skipped, 'locked');
    assert.equal(r.deferred.get('x.txt'), 'locked');
    assert.equal(await p.core.repo.readRef(p.core.refs.state), stateBefore, 'no intent was journaled (no state transition)');
    assert.deepEqual(await readWork(p, 'x.txt'), buf('x1\n'), 'nothing was written');
    const next = await apply(fx, p);
    assert.deepEqual(next.r.written, ['x.txt']);
    assert.deepEqual(await readWork(p, 'x.txt'), buf('x2\n'));
    const kept = readdirSync(tmp).filter((n) => /^orphan-.*\.old$/.test(n));
    assert.equal(kept.length, 1, 'the holder was moved aside to an orphan name, never deleted');
  });
});

test('final review FB-2: a local edit saved between the tick and P1 is re-merged into the written file and joins the open human change-set, so its capture publishes it', async () => {
  await withCores('apply-fb2-remerge', { n: 1, files: { 'README.md': buf('# fb2\n'), 'a.txt': buf(lines(12, (i) => `row ${i}`)) } }, async (fx, p) => {
    const BASE = lines(12, (i) => `row ${i}`);
    const USER = BASE.replace('row 10\n', 'row 10 by the user\n');
    await prep(p);
    await fx.pushTeamChange({ 'a.txt': buf(BASE.replace('row 1\n', 'row 1 by the team\n')) });
    fx.advance(10_000);
    const it = await prep(p);
    assert.equal(p.core.cs.openPaths().has('a.txt'), false, 'the tick saw a.txt clean');
    let saved = false;
    const restore = hp.wrapGit(p, async (args, opts, inner) => {
      if (!saved && args.includes('cat-file') && args.includes('--filters')) {
        saved = true;   // the user saves a.txt after the tick, while P0 runs
        await writeWork(p, 'a.txt', USER);
      }
      return inner(args, opts);
    });
    const r = await applyStep(p.core, it);
    restore();
    assert.deepEqual(r.written, ['a.txt']);
    const disk = (await readWork(p, 'a.txt'))?.toString('utf8') ?? '';
    assert.ok(disk.includes('row 1 by the team') && disk.includes('row 10 by the user'), 'the re-merge kept both edits on disk');
    assert.equal(p.core.cs.openPaths().has('a.txt'), true, 'the re-merged path joined the open human change-set');
    fx.advance(25_000);
    const it2 = await prep(p, true);
    const pair = await hp.captureReady(p, it2);
    assert.ok(pair.paths.includes('a.txt'));
    fx.advance(30_000);
    const pub = await publishStep(p.core, await prep(p));
    assert.equal(pub.outcome, 'landed', JSON.stringify(pub));
    assert.ok(pub.c !== null, `a code commit: ${JSON.stringify(pub)}`);
    const remote = (await hp.blobText(p, await hp.treeOf(p, pub.c), 'a.txt')) ?? '';
    assert.ok(remote.includes('row 10 by the user') && remote.includes('row 1 by the team'), 'the user\'s edit reached the team');
  });
});

/** The engine's non-terminal ON_DISK CONFLICTED conflict records on `path`. */
function onDiskConflicts(p: PeerFixture, path: string): string[] {
  return p.core.holds.nonTerminal()
    .filter((h) => h.kind === 'PATCH' && h.state === 'CONFLICTED' && h.residence === 'ON_DISK' && h.paths.includes(path) && h.guards.some((g) => g.name === 'conflict'))
    .map((h) => h.id);
}

test('final review FB-5: a publish-side K4 record whose LOCAL the user edited again before the apply goes OFF_DISK when the apply writes TIP[p] (with the apply\'s own new record), so the next edit of p publishes', async () => {
  const ts = (name: string): string => lines(12, (i) => `export const ${name}${i} = ${i};`);
  const withRow = (text: string, i: number, value: string): string => {
    const rs = text.split('\n');
    rs[i - 1] = value;
    return rs.join('\n');
  };
  const X_LOCAL = withRow(ts('x'), 2, 'export const x2 = 200; // local');
  const X_MORE = withRow(X_LOCAL, 10, 'export const x10 = 1000; // more local');
  const X_TEAM = withRow(ts('x'), 2, 'export const x2 = 300; // team');
  await withCores('apply-fb5-k4', { n: 1, files: { 'README.md': buf('# fb5\n'), 'src/x.ts': buf(ts('x')), 'src/y.ts': buf(ts('y')) } }, async (fx, p) => {
    await hp.editAndCapture(fx, p, { 'src/x.ts': X_LOCAL, 'src/y.ts': withRow(ts('y'), 6, 'export const y6 = 600; // local') });
    await fx.pushTeamChange({ 'src/x.ts': buf(X_TEAM) });
    await prep(p);
    fx.advance(6_000);
    const pub1 = await publishStep(p.core, await prep(p));
    assert.equal(pub1.outcome, 'landed', JSON.stringify(pub1));
    assert.equal(pub1.records.length, 1, 'the publish-side K4 record R1');
    const r1 = pub1.records[0]!;
    assert.deepEqual(onDiskConflicts(p, 'src/x.ts'), [r1], 'R1 is ON_DISK: LOCAL is still on disk');
    // The user edits x again before the apply: the apply's TAKE_TIP has another s2, so it makes its own record R2.
    await writeWork(p, 'src/x.ts', X_MORE);
    await prep(p);
    const { r } = await apply(fx, p);
    assert.deepEqual(r.written, ['src/x.ts']);
    assert.equal(r.records.length, 1);
    assert.notEqual(r.records[0], r1, 'R2 is a second record');
    assert.deepEqual(await readWork(p, 'src/x.ts'), buf(X_TEAM), 'TIP[p] is on disk');
    assert.deepEqual(onDiskConflicts(p, 'src/x.ts'), [], 'no LOCAL of any record is on disk: every one is OFF_DISK (INV-HLD-OFFDISK)');
    // A later edit of x on top of TIP is published.
    const LATER = withRow(X_TEAM, 11, 'export const x11 = 1100; // later');
    const { pair } = await hp.editAndCapture(fx, p, { 'src/x.ts': LATER });
    assert.ok(pair.paths.includes('src/x.ts'));
    fx.advance(30_000);
    const pub2 = await publishStep(p.core, await prep(p));
    assert.equal(pub2.outcome, 'landed', JSON.stringify(pub2));
    assert.ok(pub2.c !== null);
    assert.equal(await hp.blobText(p, await hp.treeOf(p, pub2.c), 'src/x.ts'), LATER, 'the later edit reached the team');
  });
});

test('final review (ledger Task 13:234): under core.ignorecase a TIP holding two spellings of one new file (Notes.txt + notes.txt from a case-sensitive teammate) makes both not applicable unmaterializable, so the rest of their change-set applies instead of deferring race (EEXIST at the second create) forever', async () => {
  const fx = await makeCores('apply-case-pair', { n: 1, files: FILES });
  try {
    const p = fx.peers[0]!;
    // Git sets core.ignorecase=true when it clones onto a case-insensitive volume (Windows, macOS); set here for Linux,
    // before the snapshot reads it (once per instance).
    await p.core.repo.run(['config', 'core.ignorecase', 'true']);
    await fx.bootstrap();
    await fx.pushTeamChange({ 'Notes.txt': buf('upper\n'), 'notes.txt': buf('lower\n'), 'src/a.ts': buf('export const a = 2;\n') });
    const { r } = await apply(fx, p);
    assert.equal(r.ran, true);
    assert.equal(r.notApplicable.get('Notes.txt'), 'unmaterializable');
    assert.equal(r.notApplicable.get('notes.txt'), 'unmaterializable');
    assert.deepEqual(r.written, ['src/a.ts'], 'the rest of the change-set applies');
    assert.equal(r.deferred.size, 0, 'no race deferral');
    assert.deepEqual(await readWork(p, 'src/a.ts'), buf('export const a = 2;\n'));
    assert.equal(await readWork(p, 'notes.txt'), null, 'neither spelling is written');
    assert.deepEqual(p.core.view!.meta.pending, { 'Notes.txt': 'unmaterializable', 'notes.txt': 'unmaterializable' });
    const A = await stateA(p);
    assert.equal(A.has('Notes.txt') || A.has('notes.txt'), false, 'A keeps its entries (none)');
    // P2-NA-TRIGGER: the pair's per-loop re-check (unmaterializableHere) holds, so it alone never triggers an apply.
    assert.equal(applyNeeded(p.core, await prep(p, false)), false, 'the pair alone triggers no apply');
    // A later teammate change elsewhere applies as usual; the pair stays not applicable while TIP holds both.
    await fx.pushTeamChange({ 'README.md': buf('# apply fixture, later\n') });
    const next = await apply(fx, p);
    assert.deepEqual(next.r.written, ['README.md']);
    assert.equal(next.r.notApplicable.get('notes.txt'), 'unmaterializable');
    // One spelling leaves TIP: the other is an ordinary new file again.
    await fx.pushTeamChange({ 'Notes.txt': null });
    const last = await apply(fx, p);
    assert.deepEqual(last.r.written, ['notes.txt']);
    assert.deepEqual(await readWork(p, 'notes.txt'), buf('lower\n'));
  } finally {
    await fx.cleanup();
  }
});

test('final review FB-6: on Windows a TIP holding a root drive-prefix name (a:b.txt, which git refuses in any index) never wedges the apply: a path whose merge needs a whole-path edit over that tree (a D9 concat) is deferred unmaterializable (meta.pending, nothing written, A kept) instead of throwing, the clean paths of the same apply are written, and once the name leaves TIP the deferred path applies', {
  skip: process.platform !== 'win32' ? 'git refuses a root drive-prefix name in an index only on Windows' : false,
}, async () => {
  await withCores('apply-fb6-colon', { n: 1, files: FILES, platform: 'win32' }, async (fx, p) => {
    await fx.pushTeamChange({ 'a:b.txt': buf('ab\n'), 'x.txt': buf('x7\n') });
    const first = await apply(fx, p);
    assert.deepEqual(first.r.written, ['x.txt'], 'an apply with no whole-path edit was never affected');
    assert.equal(first.r.notApplicable.get('a:b.txt'), 'unmaterializable');
    // A same-position append on both sides: the D9 concat is a whole-path replacement in t/M's scratch index, whose
    // read-tree of the merged tree (holding TIP's a:b.txt) git refuses. A separate teammate commit changes x.txt.
    const LOCAL = buf('# Notes\n\nalpha\nlocal line\n');
    await writeWork(p, 'notes.md', LOCAL);
    await prep(p);
    await fx.pushTeamChange({ 'notes.md': buf('# Notes\n\nalpha\nteam line\n') });
    await fx.pushTeamChange({ 'x.txt': buf('x8\n') });
    const aNotes = (await stateA(p)).get('notes.md');
    const second = await apply(fx, p);   // no IndexRefusedPathError / GitCommandError out of applyStep (the respawn loop)
    assert.equal(second.r.ran, true);
    assert.deepEqual(second.r.written, ['x.txt'], 'the clean path of the same apply is written');
    assert.equal(second.r.deferred.get('notes.md'), 'unmaterializable');
    assert.equal(p.core.view!.meta.pending['notes.md'], 'unmaterializable', 'listed: status shows it not_applicable/unmaterializable');
    assert.deepEqual(await readWork(p, 'notes.md'), LOCAL, 'the local side stays');
    assert.deepEqual((await stateA(p)).get('notes.md'), aNotes, 'A keeps its entry');
    assert.equal(p.core.view!.intent.kind, 'none');
    assert.equal(await readWork(p, 'a:b.txt'), null);
    // The name leaves TIP: the deferred path applies (the concat) at the next permitted apply.
    await fx.pushTeamChange({ 'a:b.txt': null });
    const third = await apply(fx, p);
    assert.deepEqual(third.r.written, ['notes.md']);
    assert.deepEqual(await readWork(p, 'notes.md'), buf('# Notes\n\nalpha\nteam line\nlocal line\n'));
    assert.equal(p.core.view!.meta.pending['notes.md'], undefined);
  });
});

test('final review FB-6 (POSIX twin): where git indexes a root drive-prefix name (a:b.txt) the same apply builds the D9 concat over the merged tree holding it and writes it at once: nothing is deferred unmaterializable', {
  skip: process.platform === 'win32' ? 'git for Windows refuses a root drive-prefix name in an index (the Windows test above)' : false,
}, async () => {
  await withCores('apply-fb6-colon-posix', { n: 1, files: FILES }, async (fx, p) => {
    await fx.pushTeamChange({ 'a:b.txt': buf('ab\n'), 'x.txt': buf('x7\n') });
    const first = await apply(fx, p);
    assert.deepEqual(first.r.written, ['x.txt']);
    assert.equal(first.r.notApplicable.get('a:b.txt'), 'unmaterializable', 'carried by its name on every platform (P2-DOTGIT)');
    const LOCAL = buf('# Notes\n\nalpha\nlocal line\n');
    await writeWork(p, 'notes.md', LOCAL);
    await prep(p);
    await fx.pushTeamChange({ 'notes.md': buf('# Notes\n\nalpha\nteam line\n') });
    await fx.pushTeamChange({ 'x.txt': buf('x8\n') });
    const second = await apply(fx, p);
    assert.equal(second.r.ran, true);
    assert.deepEqual(second.r.written, ['notes.md', 'x.txt'], 'the concat is written with the clean path');
    assert.equal(second.r.deferred.has('notes.md'), false);
    assert.equal(p.core.view!.meta.pending['notes.md'], undefined);
    assert.deepEqual(await readWork(p, 'notes.md'), buf('# Notes\n\nalpha\nteam line\nlocal line\n'));
    assert.equal(await readWork(p, 'a:b.txt'), null, 'the carried name is never written');
  });
});

test('final review (group FC\'s LEFT item, apply side): a teammate adding the file src/d while this peer adds src/d/x.ts never drops the local src/d/x.ts from M_disk without a record: the apply displaces it like a TAKE_TIP — a K4 record holding LOCAL (stages ABSENT, LOCAL, ABSENT) committed before the writer moves it away — and once the emptied src/d is gone the next apply writes TIP\'s file', async () => {
  await withCores('apply-dir-file', { n: 1, files: FILES }, async (fx, p) => {
    const LOCAL = buf('export const dx = 1;\n');
    await writeWork(p, 'src/d/x.ts', LOCAL);
    await prep(p);   // the local creation is seen
    await fx.pushTeamChange({ 'src/d': buf('team d\n') });
    let recordsAtMove = -1;
    p.fs.interpose('rename', `d${sep}x.ts`, async () => {
      recordsAtMove = p.core.holds.all().filter((h) => h.paths.includes('src/d/x.ts') && h.guards.some((g) => g.name === 'conflict')).length;
    });
    const { r } = await apply(fx, p);
    assert.equal(r.ran, true);
    assert.equal(r.records.length, 1, `one K4 record for the displaced src/d/x.ts (report: ${JSON.stringify({ written: r.written, deleted: r.deleted, na: [...r.notApplicable], deferred: [...r.deferred], records: r.records })})`);
    const rec = p.core.holds.get(r.records[0]!);
    assert.ok(rec !== undefined && 's2' in rec.blobs && 's1' in rec.blobs && 's3' in rec.blobs);
    assert.deepEqual(rec.paths, ['src/d/x.ts']);
    assert.equal(rec.blobs.s2['src/d/x.ts'], await p.core.repo.hashBytes(LOCAL, false), 'the record holds LOCAL');
    assert.equal(rec.blobs.s1['src/d/x.ts'], ABSENT);
    assert.equal(rec.blobs.s3['src/d/x.ts'], ABSENT);
    assert.equal(recordsAtMove, 1, 'the record existed when the writer moved src/d/x.ts away');
    assert.equal(rec.residence, 'OFF_DISK', 'the verified removal leaves no LOCAL on disk');
    assert.deepEqual(r.deleted, ['src/d/x.ts']);
    assert.equal(await readWork(p, 'src/d/x.ts'), null);
    assert.equal(r.notApplicable.get('src/d'), 'collision', 'the local directory was still there when this apply looked');
    // The emptied directory went with its last file: the collision clears, the path rejoins the trigger and is written.
    fx.advance(10_000);
    const back = await prep(p);
    assert.equal(applyNeeded(p.core, back), true);
    const r2 = await applyStep(p.core, back);
    assert.deepEqual(r2.written, ['src/d']);
    assert.deepEqual(await readWork(p, 'src/d'), buf('team d\n'));
    assert.deepEqual(p.core.view!.meta.pending, {});
  });
});

test('final review (group FC\'s LEFT item, apply side): a ready pair carrying the displaced src/d/x.ts is cancelled with it (CS_READY_CANCELLED, the K4 record names its change-set), so nothing publishes the removed file afterwards; the pair\'s other path is re-captured and published', async () => {
  await withCores('apply-dir-file-ready', { n: 1, files: FILES }, async (fx, p) => {
    const LOCAL = buf('export const dx = 1;\n');
    const { pair } = await hp.editAndCapture(fx, p, { 'src/d/x.ts': LOCAL, 'x.txt': 'x local\n' });
    assert.deepEqual([...pair.paths].sort(), ['src/d/x.ts', 'x.txt']);
    await fx.pushTeamChange({ 'src/d': buf('team d\n') });
    const { r } = await apply(fx, p);
    assert.equal(r.records.length, 1);
    assert.deepEqual(p.core.holds.get(r.records[0]!)?.cs_ids, [pair.csId], 'the record names the change-set');
    assert.deepEqual(r.cancelled, [pair.csId], `the pair leaves with the displaced file (ready: ${JSON.stringify(p.core.cs.ready().map((x) => x.paths))})`);
    assert.deepEqual(p.core.cs.ready(), []);
    assert.equal(await readWork(p, 'src/d/x.ts'), null);
    // x.txt is re-captured from the disk and published; src/d/x.ts never is.
    fx.advance(20_000);
    const it = await prep(p, true);
    if (captureDue(p.core)) await hp.captureReady(p, it);
    fx.advance(6_000);
    await prep(p);
    const pub = await publishStep(p.core, await prep(p));
    assert.equal(pub.outcome, 'landed', JSON.stringify(pub));
    const C = await hp.treeOf(p, pub.c!);
    assert.equal(await hp.blobText(p, C, 'x.txt'), 'x local\n');
    assert.equal(C.has('src/d/x.ts'), false);
    assert.equal(await hp.blobText(p, C, 'src/d'), 'team d\n');
  });
});

test('final review (group FC\'s LEFT item): a path named __proto__ keeps its meta.pending entry as an own key (never the prototype setter), read back by parseMeta; once written it leaves pending', async () => {
  const PROTO = '__proto__';
  await withCores('apply-proto', { n: 1, files: { ...FILES, [PROTO]: buf('proto v0\n') } }, async (fx, p) => {
    await fx.pushTeamChange({ [PROTO]: buf('proto v1\n') });
    await fx.pushTeamChange({ 'x.txt': buf('x9\n') });   // a change-set of its own (HLD-53: not deferred with __proto__)
    const release = p.fs.holdLock(workPath(p, PROTO), 'share-read');
    const { r } = await apply(fx, p);
    release();
    assert.equal(r.deferred.get(PROTO), 'locked');
    assert.deepEqual(r.written, ['x.txt']);
    const pending = p.core.view!.meta.pending;
    assert.equal(Object.hasOwn(pending, PROTO), true, `meta.pending names __proto__ (keys: ${JSON.stringify(Object.keys(pending))})`);
    assert.equal(pending[PROTO], 'locked');
    const read = await p.core.state.read();
    assert.ok(read !== null);
    assert.equal(Object.hasOwn(read.meta.pending, PROTO) && read.meta.pending[PROTO] === 'locked', true, 'parseMeta reads it back');
    const next = await apply(fx, p);
    assert.deepEqual(next.r.written, [PROTO]);
    assert.deepEqual(await readWork(p, PROTO), buf('proto v1\n'));
    assert.equal(Object.hasOwn(p.core.view!.meta.pending, PROTO), false);
  });
});
