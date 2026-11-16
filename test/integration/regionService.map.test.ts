// RegionService's hunks and mapRanges (R4-17, contract line 780): hunks(from, to) of two blobRefs in a worker at
// full D — an 'ABSENT' side is the empty file, a missing object is 'WHOLE_FILE' (REG-35) with its log line — and
// mapRanges(from, to, ranges, mode) with the mode deadline; local mode's deadline is BUDGETS.mapLocalMs, fold mode's
// the map budget; an injected overrun degrades to 'WHOLE_FILE' and attributes REGION_BUDGET {path, budget: 'map'}
// through onBudget only when the path is given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hunks as mapperHunks, mapRangesLines } from '../../src/regions/mapper.js';
import type { BlobRef, Ranges } from '../../src/regions/types.js';
import { unitService } from '../helpers/regionUnitService.js';
import { testBudgetInjector } from '../../src/regions/budgets.js';
import { fixture } from '../helpers/regionFixtures.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const A = Buffer.from('a\nb\nc\nd\ne\n');
const B = Buffer.from('a\nb\nX\nd\ne\nf\n');   // c → X (row 3), + f (row 6)
const rows = (b: Buffer): Buffer[] => b.toString('utf8').split('\n').slice(0, -1).map((x) => Buffer.from(x));

test('hunks over two snapshot blobs matches the mapper and answers WHOLE_FILE for a missing object or an ABSENT side', T10, async () => {
  // A repo stub whose readBlobs always throws and whose hasObject answers false: bytes() classifies every oid read
  // as a missing object (REG-35) without touching git.
  const missingRepo = {
    readBlobs: async (): Promise<never[]> => { throw new Error('git failed'); },
    hasObject: async (): Promise<boolean> => false,
  } as unknown as never;
  const u = await unitService({ repo: missingRepo });
  try {
    const m = u.snap('src/x.py', B);
    const s = u.snap('src/x.py', A);
    const direct = await u.s.hunks(m, s);
    assert.ok(Array.isArray(direct), 'two snapshot blobs answer Hunk[]');
    assert.deepEqual(
      direct,
      mapperHunks(rows(B), rows(A)),
      'the worker\u2019s hunks equal the mapper\u2019s over the same rows',
    );
    // An 'ABSENT' side is the empty file: everything is one insertion into B's b-side.
    const fromAbsent = await u.s.hunks('ABSENT', s);
    assert.ok(Array.isArray(fromAbsent));
    assert.deepEqual(fromAbsent, [{ aLo: 1, aHi: 0, bLo: 1, bHi: 5 }]);
    const toAbsent = await u.s.hunks(s, 'ABSENT');
    assert.ok(Array.isArray(toAbsent));
    assert.deepEqual(toAbsent, [{ aLo: 1, aHi: 5, bLo: 1, bHi: 0 }]);
    // A missing object (an oid no object holds) is WHOLE_FILE, with its REGION_OBJECT_MISSING log line (log-only).
    // The unit repo stub answers hasObject: false, so bytes() classifies the read as a missing object without git.
    const missing = await u.s.hunks(m, '0123456789abcdef0123456789abcdef01234567' as BlobRef);
    assert.equal(missing, 'WHOLE_FILE');
  } finally {
    await u.close();
  }
});

test('mapRanges fold and local match mapRangesLines over snapshots; an injected overrun degrades to WHOLE_FILE', T10, async () => {
  const u = await unitService();
  try {
    const m = u.snap('src/x.py', B);
    const s = u.snap('src/x.py', A);
    const ranges: Ranges = [[1, 5]];
    const fold = await u.s.mapRanges(m, s, ranges, 'fold');
    const want = mapRangesLines(rows(B), rows(A), ranges, 'fold');
    assert.deepEqual(fold, want, 'fold mode over snapshots equals the mapper\u2019s answer');
    // Local mode: the 200 ms cap never expires under inline jobs without an injection.
    const local = await u.s.mapRanges(m, s, ranges, 'local');
    assert.deepEqual(local, want, 'local mode over snapshots equals the mapper\u2019s answer');
  } finally {
    await u.close();
  }
  // The injected overrun degrades to WHOLE_FILE; onBudget fires with the path when it is given.
  const inject = testBudgetInjector();
  inject.expire('map', 3);   // the next 3 map deadlines start expired: 2 mapRanges + 1 hunks below.
  const v = await unitService({ inject });
  try {
    const m = v.snap('src/x.py', B);
    const s = v.snap('src/x.py', A);
    const hits: Array<{ path: string; budget: string }> = [];
    v.s.deps.onBudget = (path, budget) => hits.push({ path, budget });
    assert.equal(await v.s.mapRanges(m, s, [[1, 5]], 'local'), 'WHOLE_FILE', 'a local-mode overrun degrades whole');
    assert.deepEqual(hits, [{ path: '', budget: 'map' }], 'without a path the attribution carries no path');
    assert.equal(await v.s.mapRanges(m, s, [[1, 5]], 'local', 'src/x.py'), 'WHOLE_FILE', 'with a path too');
    assert.deepEqual(hits, [{ path: '', budget: 'map' }, { path: 'src/x.py', budget: 'map' }], 'the path attributes the second overrun');
    // hunks\u2019 overrun has no path either.
    assert.equal(await v.s.hunks(m, s), 'WHOLE_FILE');
    assert.deepEqual(hits, [{ path: '', budget: 'map' }, { path: 'src/x.py', budget: 'map' }, { path: '', budget: 'map' }]);
  } finally {
    await v.close();
  }
});

test('hunks and mapRanges run FoldMapper/1 in a worker over blobRefs', T10, async () => {
  // The brief's values on the 5,960-row fixture: hunks('ABSENT', blob) is one pure insertion of all rows; mapRanges of the
  // compute_total image [[5331, 5339]] in fold mode equals mapRangesLines on the same rows (big_lf.py -> py_same_tail_def_after).
  const base = fixture('big_lf.py');
  const post = fixture('rc_touch/py_same_tail_def_after.post.py');
  const u = await unitService();
  try {
    const a = u.snap('hot.py', base);
    const b = u.snap('hot.py', post);
    const n = rows(post).length;
    assert.deepEqual(await u.s.hunks('ABSENT', b), [{ aLo: 1, aHi: 0, bLo: 1, bHi: n }], 'one pure insertion of every row');
    assert.deepEqual(await u.s.hunks(a, b), mapperHunks(rows(base), rows(post)));
    assert.deepEqual(await u.s.mapRanges(a, b, [[5331, 5339]], 'fold'), mapRangesLines(rows(base), rows(post), [[5331, 5339]], 'fold'));
  } finally {
    await u.close();
  }
  // A local mapping under inject.stallMs('map', 201) is WHOLE_FILE and, with the optional path, calls onBudget(path, 'map') once.
  const inject = testBudgetInjector();
  inject.stallMs('map', 201);
  const v = await unitService({ inject });
  try {
    const hits: Array<{ path: string; budget: string }> = [];
    v.s.deps.onBudget = (path, budget) => hits.push({ path, budget });
    const a = v.snap('hot.py', base);
    const b = v.snap('hot.py', post);
    assert.equal(await v.s.mapRanges(a, b, [[5331, 5339]], 'local', 'hot.py'), 'WHOLE_FILE');
    assert.deepEqual(hits, [{ path: 'hot.py', budget: 'map' }], 'onBudget(path, map) once');
    // The stall was for one deadline only: the next local mapping succeeds.
    assert.notEqual(await v.s.mapRanges(a, b, [[5331, 5339]], 'local', 'hot.py'), 'WHOLE_FILE');
    assert.equal(hits.length, 1);
  } finally {
    await v.close();
  }
});
