// 05 U1 (Plan 3 Task 5; HLD-13…HLD-17, 05-holds §3.4 items 1–4; Review Focus 5): REBASE, MASK, PARK and RESTORE on a BOM+CRLF
// stored-form fixture give the expected stored-form blobs, and their base is ENG's A[p], never tree(LA_C)[p]: for a pending
// path (A[p] the old version, tree(LA_C)[p] holding TIP's unapplied edit next to the held row) a test-local copy of each operator
// that takes tree(LA_C)[p] as its base yields a different blob or a spurious conflict, and the production PARK on a real pending
// path (an apply deferred by a share-read holder) writes the A-based blob (a tree(LA_C)-based park fails it). Real git; never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyStep } from '../../src/engine/apply.js';
import { park, restore } from '../../src/engine/holdOps.js';
import { rows, hasBom } from '../../src/data/rows.js';
import type { Oid, OidOrAbsent } from '../../src/git/oid.js';
import type { GitRepo, TreeEntry } from '../../src/git/repo.js';
import { maskEntries } from '../../src/holds/mask.js';
import { RebaseCache } from '../../src/holds/rebase.js';
import { seededRandom } from '../../src/ports/random.js';
import { runMergeFile } from '../../src/git/merge.js';
import { readWork, workPath, writeWork } from '../helpers/coreFixture.js';
import { blob, nr, pair, prepIt, withPeers } from '../helpers/holdOpsFixture.js';
import { record, withMaskRepo } from '../helpers/maskFixture.js';
import { buf } from '../helpers/publishHelpers.js';
import { generateBigBomCrlf } from '../sim/fixtures/bigBomCrlf.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const F = 'big.py';

/** `b` with 1-based row n's content (its ending and row 1's BOM kept) replaced. */
function withRow(b: Buffer, n: number, content: string): Buffer {
  const rs = rows(b);
  const row = rs[n - 1]!;
  const crlf = row.length >= 2 && row[row.length - 2] === 0x0d;
  const bom = n === 1 && hasBom(row);
  rs[n - 1] = Buffer.concat([bom ? row.subarray(0, 3) : Buffer.alloc(0), Buffer.from(content, 'utf8'), Buffer.from(crlf ? '\r\n' : '\n', 'latin1')]);
  return Buffer.concat(rs);
}

/** A test-local merge-file -p --object-id (the operator's own form, with the caller's base; run by runMergeFile, G1-FILEFORM): [rc, output]. */
async function mf(repo: GitRepo, cur: Oid, base: Oid, other: Oid, diff3 = false): Promise<readonly [number, Buffer]> {
  const r = await runMergeFile(repo, ['merge-file', '-p', ...(diff3 ? ['--diff3'] : []), '--object-id', cur, base, other]);
  assert.ok(r.rc >= 0, `merge-file error rc ${r.rc}`);
  return [r.rc, r.out];
}

const tm = (path: string, oid: OidOrAbsent): Map<string, TreeEntry> => new Map(oid === 'ABSENT' ? [] : [[path, { path, mode: '100644', oid: oid as Oid }]]);

test('05 U1: REBASE, MASK, PARK and RESTORE on BOM+CRLF stored-form fixtures; a tree(LA_C) base fails', T10, async () => {
  const base = generateBigBomCrlf(2_000, seededRandom('t5-u1'));
  const HELD = '# held change on row 10';
  const TEAM = '# team change on row 500';
  const LOCAL = '# local change on row 900';
  const NEXT = '# TIP edit next to the held row (row 11), not applied yet';

  // The four operators on the fixture (a peer whose A carries the team row 500, the held row 10 and a local row 900 on disk).
  await withPeers('u1-ops', { files: { 'README.md': buf('# u1\n'), [F]: base } }, async (fx) => {
    const p = fx.peers[0]!;
    const A = withRow(base, 500, TEAM);
    await fx.pushTeamChange({ [F]: A });
    fx.advance(10_000);
    assert.ok((await applyStep(p.core, await prepIt(p, { forceFetch: true }))).written.includes(F));
    const sDisk = withRow(withRow(A, 10, HELD), 900, LOCAL);
    await writeWork(p, F, sDisk);
    const it = await prepIt(p, { holdPaths: [F] });
    const h0 = await blob(p, base);
    const h1 = await blob(p, withRow(base, 10, HELD));
    const id = await p.core.holds.hold(nr({ paths: [F], blobs: pair(h0, h1, F) }));
    const r = p.core.holds.get(id)!;
    // REBASE: H1' = A with the held row.
    const rb = await p.core.rebase.rebase(r, it.A);
    assert.ok(rb.ok);
    assert.equal(rb.h1p[F], await blob(p, withRow(A, 10, HELD)), "REBASE: H1' = A + the held row, stored form");
    // MASK: S_disk without the held row.
    const m = await maskEntries(p.core.repo, it.mat!.sDiskMap, { A: it.A, scope: () => 'LIVE', records: [r], mergeable: () => true }, new RebaseCache(p.core.repo, () => true));
    const masked = withRow(A, 900, LOCAL);
    assert.equal(m.entries.get(F)?.oid, await blob(p, masked), 'MASK: A + the local row');
    // PARK writes the same blob; RESTORE puts the held row back.
    assert.deepEqual(await park(p.core, it, id, { humanEvidence: true, displacedBy: null, refreshMustBeDurable: false }), { kind: 'PARKED', companion: null });
    assert.deepEqual(await readWork(p, F), masked, 'PARK: the step-5 result, byte for byte (BOM, CRLF)');
    fx.advance(2_500);
    const it2 = await prepIt(p, { holdPaths: [F] });
    assert.deepEqual(await restore(p.core, it2, id, { humanEvidence: true, actor: 'human' }), { kind: 'RESTORED', markers: false });
    assert.deepEqual(await readWork(p, F), sDisk, 'RESTORE: the held row back, every other byte kept');
  });

  // A pending path: A[p] is the old version, tree(LA_C)[p] holds TIP's unapplied edit next to the held row.
  await withMaskRepo('u1-pending', async (c) => {
    const A = await c.blob(base);
    const laC = await c.blob(withRow(base, 11, NEXT));
    const h0 = A;
    const h1 = await c.blob(withRow(base, 10, HELD));
    const sDisk = await c.blob(withRow(withRow(base, 10, HELD), 900, LOCAL));
    const r = record(pair(h0, h1, F), { paths: [F] });
    const cache = new RebaseCache(c.repo, () => true);
    // REBASE from A: clean, H1' = h1. From tree(LA_C): a spurious conflict (rows 10 and 11 are adjacent).
    const rb = await cache.rebase(r, tm(F, A));
    assert.ok(rb.ok && rb.h1p[F] === h1);
    const [rcWrong] = await mf(c.repo, laC, h0, h1);
    assert.notEqual(rcWrong, 0, 'REBASE with a tree(LA_C) base: a spurious conflict');
    // MASK from A: S_disk without the held row. With tree(LA_C) as H0' (the LA_C-based pair): a different blob or a conflict.
    const m = await maskEntries(c.repo, tm(F, sDisk), { A: tm(F, A), scope: () => 'LIVE', records: [r], mergeable: () => true }, cache);
    const want = await c.blob(withRow(base, 900, LOCAL));
    assert.equal(m.entries.get(F)?.oid, want, 'MASK from A');
    const [rcMask, outMask] = await mf(c.repo, sDisk, h1, laC);
    assert.ok(rcMask !== 0 || (await c.repo.hashBytes(outMask, false)) !== want, 'MASK with a tree(LA_C) base differs');
    // PARK's target is MASK's; its LA_C-based copy brings TIP's unapplied row 11 onto the disk.
    assert.ok(rcMask !== 0 || outMask.toString('utf8').includes(NEXT), 'PARK with a tree(LA_C) base writes an unapplied team row');
    // RESTORE over a disk at A: from its base h0 the held row comes back; with tree(LA_C) as base a different blob or a conflict.
    const [rcOk, outOk] = await mf(c.repo, A, h0, h1, true);
    assert.equal(rcOk, 0);
    assert.equal(await c.repo.hashBytes(outOk, false), h1, 'RESTORE from h0');
    const [rcR, outR] = await mf(c.repo, A, laC, h1, true);
    assert.ok(rcR !== 0 || (await c.repo.hashBytes(outR, false)) !== h1, 'RESTORE with a tree(LA_C) base differs');
  });

  // The production PARK on a real pending path: TIP's row-11 edit is applied while a share-read holder refuses the rename (deferred
  // 'locked'), so LA_C := TIP while A[F] keeps the old version (ENG-36). park() must take A[F] as its base: a park based on
  // tree(LA_C)[F] conflicts (rows 10 and 11 are adjacent) and writes TIP's unapplied row 11 onto the disk.
  await withPeers('u1-pending-park', { files: { 'README.md': buf('# u1\n'), [F]: base } }, async (fx) => {
    const p = fx.peers[0]!;
    const TIP = withRow(base, 11, NEXT);
    await fx.pushTeamChange({ [F]: TIP });
    const release = p.fs.holdLock(workPath(p, F), 'share-read');
    fx.advance(10_000);
    let deferred: string | undefined;
    try {
      deferred = (await applyStep(p.core, await prepIt(p, { forceFetch: true }))).deferred.get(F);
    } finally {
      release();
    }
    assert.equal(deferred, 'locked', 'the apply deferred F');
    const sDisk = withRow(withRow(base, 10, HELD), 900, LOCAL);
    await writeWork(p, F, sDisk);
    fx.advance(2_500);
    const it = await prepIt(p, { holdPaths: [F] });
    assert.equal(it.A.get(F)?.oid, await blob(p, base), 'A[F] is the old version');
    assert.equal(it.tipMap.get(F)?.oid, await blob(p, TIP), 'tree(LA_C)[F] = TIP[F] carries the unapplied row 11');
    const id = await p.core.holds.hold(nr({ paths: [F], blobs: pair(await blob(p, base), await blob(p, withRow(base, 10, HELD)), F) }));
    assert.deepEqual(await park(p.core, it, id, { humanEvidence: true, displacedBy: null, refreshMustBeDurable: false }), { kind: 'PARKED', companion: null });
    const disk = (await readWork(p, F))!;
    assert.deepEqual(disk, withRow(base, 900, LOCAL), 'PARK from A[F]: the held row gone, the local row kept, every other byte the old version');
    assert.equal(disk.includes(Buffer.from(NEXT, 'utf8')), false, "no unapplied team row reaches the disk");
    assert.deepEqual([p.core.holds.get(id)!.residence, p.core.holds.get(id)!.state], ['OFF_DISK', 'PARKED'], 'never a spurious conflict');
  });
});
