// R4-17's held-range re-basing, integrated (the HLD-21 suites stay Plan 3's): heldRanges' row source is
// src/regions/mapper.ts's hunks() over the same M_disk and S_disk bytes (the mapper computes them in-process over the
// blobs' own rows), the same 1-based inclusive S_disk rows and the same zero-length range after a pure deletion. The
// held rows are exactly the diff's: one import changed the source, no expected value moved (the controller's stop rule).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hunks } from '../../src/regions/mapper.js';
import { assertP, assertSPub, heldRanges, maskEntries, type MaskResult } from '../../src/holds/mask.js';
import { RebaseCache } from '../../src/holds/rebase.js';
import { inputs, looseObjects, P, pair, record, T9, t9, t9Delete, t9Insert, tmap, withMaskRepo } from '../helpers/maskFixture.js';
import { fixture } from '../helpers/regionFixtures.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const linesOf = (s: string): Buffer[] => s.split('\n').slice(0, -1).map((x) => Buffer.from(x));

test('heldRanges\u2019 rows are hunks(MASK_PATCH(S_disk[p]), S_disk[p]) rows, computed over the real blobs', T10, async () => {
  await withMaskRepo('held-ranges-p4', async (c) => {
    const a = await c.blob(T9);
    const A = tmap({ [P]: a });
    const cases: Array<[string, string, string, Array<readonly [number, number]>]> = [
      ['a held line two lines from an unheld edit', t9([2, 'two']), t9([2, 'two'], [6, 'six']), [[2, 2]]],
      ['a held insertion', t9Insert(4, 'x1', 'x2'), t9Insert(4, 'x1', 'x2'), [[5, 6]]],
      ['a held deletion: the zero-length range after S_disk row 2', t9Delete(3), t9Delete(3), [[3, 2]]],
    ];
    for (const [what, held, disk, want] of cases) {
      const r = record(pair(a, await c.blob(held)));
      const sDisk = tmap({ [P]: await c.blob(disk) });
      const sPub: MaskResult = await maskEntries(c.repo, sDisk, inputs(A, [r]), new RebaseCache(c.repo, () => true));
      assert.deepEqual([...sPub.partial], [P], `${what}: a step-5 path`);
      const before = looseObjects(c.f);
      const ranges = await heldRanges(c.repo, sDisk, sPub);
      assert.deepEqual(ranges.get(P), want, what);
      assert.deepEqual(looseObjects(c.f), before, `${what}: the loose-object count is unchanged by the call`);
      // The rows match mapper hunks over the very bytes the blobs hold (in-process, so no object is written).
      const mRows = linesOf(await c.text(sPub.entries.get(P)?.oid));
      const sRows = linesOf(await c.text(sDisk.get(P)?.oid));
      const wantRows: Array<readonly [number, number]> = [];
      for (const h of hunks(mRows, sRows)) {
        if (h.bHi >= h.bLo) wantRows.push([h.bLo, h.bHi]);
        else if (h.aHi >= h.aLo) wantRows.push([h.bLo, h.bLo - 1]);
      }
      assert.deepEqual(ranges.get(P), wantRows, `${what}: the mapper's rows are the held rows`);
      // assertSPub and assertP still hold (Plan 3's own invariants, unchanged by the row source).
      assert.deepEqual(await assertSPub(c.repo, sDisk, sPub, inputs(A, [r]), new RebaseCache(c.repo, () => true)), { ok: true }, what);
      assert.deepEqual(await assertP(c.repo, sPub.entries, inputs(A, [r])), { ok: true }, what);
    }
  });
});

test('held rows follow FoldMapper/1 on the same-tail fixture', T10, async () => {
  // An ON_DISK revert PATCH with h0 = big_lf.py, h1 = py_same_tail_def_after and S_disk[p] = h1: the held rows are FoldMapper/1's
  // same-tail hunk {aLo: 5342, aHi: 5341, bLo: 5342, bHi: 5350} (the insertion after 5341, 04 §3.4), never another tie choice.
  await withMaskRepo('held-ranges-same-tail', async (c) => {
    const HOT = 'hot.py';
    const h0 = await c.blob(fixture('big_lf.py'));
    const h1 = await c.blob(fixture('rc_touch/py_same_tail_def_after.post.py'));
    const A = tmap({ [HOT]: h0 });
    const r = record(pair(h0, h1, HOT), { paths: [HOT] });
    const sDisk = tmap({ [HOT]: h1 });
    const sPub: MaskResult = await maskEntries(c.repo, sDisk, inputs(A, [r]), new RebaseCache(c.repo, () => true));
    assert.deepEqual([...sPub.partial], [HOT], 'a step-5 path');
    const ranges = await heldRanges(c.repo, sDisk, sPub);
    assert.deepEqual(Object.fromEntries(ranges), { [HOT]: [[5342, 5350]] }, 'the held rows are the inserted def after row 5341');
    assert.deepEqual(await assertSPub(c.repo, sDisk, sPub, inputs(A, [r]), new RebaseCache(c.repo, () => true)), { ok: true }, 'assertSPub on the same record passes');
  });
  // A held pure deletion (h0 = T9, h1 = T9-{3}, Plan 3's notation) stays the zero-length range after S_disk row 2.
  await withMaskRepo('held-ranges-deletion', async (c) => {
    const a = await c.blob(T9);
    const d = await c.blob(t9Delete(3));
    const r = record(pair(a, d));
    const sDisk = tmap({ [P]: d });
    const sPub = await maskEntries(c.repo, sDisk, inputs(tmap({ [P]: a }), [r]), new RebaseCache(c.repo, () => true));
    assert.deepEqual(Object.fromEntries(await heldRanges(c.repo, sDisk, sPub)), { [P]: [[3, 2]] });
  });
});
