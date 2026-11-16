// The HLD-19 assertions (Plan 3 Task 2; 05-holds HLD-19, HLD-42; glossary §21 INV-MASK; ENG-41 (i); CS-19, D8, D-05; ruling
// R3-20): assertSPub over S_pub (clauses `reapply` and `revert_line`) and assertP over P (`p_class`, `p_local_only`, `p_withheld`,
// `p_range`), and ENG-41 (i)'s `masked` = "withheld whole by a record". Notation: test/helpers/maskFixture.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import type { TreeEntry, TreeMap } from '../../src/git/repo.js';
import { assertP, assertSPub, maskEntries, type MaskInputs, type MaskResult } from '../../src/holds/mask.js';
import { RebaseCache } from '../../src/holds/rebase.js';
import type { HoldRecord } from '../../src/holds/record.js';
import { binary, inputs, P, pair, record, T9, t9, t9Delete, t9Insert, tmap, ulidOf, withMaskRepo, type MaskCtx } from '../helpers/maskFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

interface Case { what: string; inp: MaskInputs; X: TreeMap; }

/** Every MASK case of mask.p3.test.ts that the HLD-19 clauses read, built on one clone. */
async function cases(c: MaskCtx): Promise<Case[]> {
  const a = await c.blob(T9);
  const two = await c.blob(t9([2, 'two']));
  const eight = await c.blob(t9([8, 'eight']));
  const A = tmap({ [P]: a });
  const r = record(pair(a, two));
  const r1 = record(pair(a, two), { id: ulidOf(1) });
  const r2 = record(pair(a, eight), { id: ulidOf(2) });
  const out: Case[] = [
    { what: 'step 5: an edit two lines away', inp: inputs(A, [r]), X: tmap({ [P]: await c.blob(t9([2, 'two'], [6, 'six'])) }) },
    { what: 'step 5: two records in ULID order', inp: inputs(A, [r1, r2]), X: tmap({ [P]: await c.blob(t9([2, 'two'], [5, 'five'], [8, 'eight'])) }) },
    { what: 'step 5: a conflict', inp: inputs(A, [r]), X: tmap({ [P]: await c.blob(t9([2, 'two'], [3, 'three'])) }) },
    { what: 'step 5: the held change not on disk', inp: inputs(A, [r]), X: tmap({ [P]: await c.blob(t9([6, 'six'])) }) },
    { what: 'step 5: a team identical change', inp: inputs(tmap({ [P]: two }), [r]), X: tmap({ [P]: await c.blob(t9([2, 'two'], [6, 'six'])) }) },
    { what: 'step 5: a held insertion', inp: inputs(A, [record(pair(a, await c.blob(t9Insert(4, 'x1', 'x2'))))]), X: tmap({ [P]: await c.blob(t9Insert(4, 'x1', 'x2')) }) },
    { what: 'step 5: a held deletion', inp: inputs(A, [record(pair(a, await c.blob(t9Delete(3))))]), X: tmap({ [P]: await c.blob(t9Delete(3)) }) },
    { what: 'ABSENT: a held file deletion', inp: inputs(A, [record(pair(a, ABSENT))]), X: tmap({}) },
    { what: 'ABSENT: a held file deletion with new bytes', inp: inputs(A, [record(pair(a, ABSENT))]), X: tmap({ [P]: two }) },
    { what: 'ABSENT: a held creation', inp: inputs(tmap({}), [record(pair(ABSENT, two))]), X: tmap({ [P]: two }) },
    {
      what: 'binary', inp: inputs(tmap({ 'b.bin': await c.blob(binary(0)) }), [record(pair(await c.blob(binary(0)), await c.blob(binary(1)), 'b.bin'), { paths: ['b.bin'] })]),
      X: tmap({ 'b.bin': await c.blob(binary(2)) }),
    },
    { what: 'a path class', inp: inputs(A, [], { scope: { [P]: 'QUARANTINED' } }), X: tmap({ [P]: two }) },
    { what: 'a local_only record', inp: inputs(A, [record(pair(a, two), { local_only: true })]), X: tmap({ [P]: two }) },
    { what: 'a PIN', inp: inputs(A, [record(pair(a, two), { kind: 'PIN', guards: ['join'] })]), X: tmap({ [P]: two }) },
    { what: 'no record', inp: inputs(A, []), X: tmap({ [P]: two, 'src/new.txt': eight }) },
  ];
  return out;
}

test('assertSPub passes on maskEntries\' own output', T10, async () => {
  await withMaskRepo('assert-spub-ok', async (c) => {
    for (const k of await cases(c)) {
      const sPub = await maskEntries(c.repo, k.X, k.inp, new RebaseCache(c.repo, () => true));
      assert.deepEqual(await assertSPub(c.repo, k.X, sPub, k.inp, new RebaseCache(c.repo, () => true)), { ok: true }, k.what);
    }
  });
});

/** sPub with entries[p] replaced. */
function withEntry(sPub: MaskResult, p: string, oid: Oid): MaskResult {
  const entries = new Map(sPub.entries);
  entries.set(p, { path: p, mode: '100644', oid });
  return { ...sPub, entries };
}

test('assertSPub \'reapply\' fails when S_pub differs from MASK on a step-5 path, and ignores withheld paths', T10, async () => {
  await withMaskRepo('assert-spub-reapply', async (c) => {
    const a = await c.blob(T9);
    const A = tmap({ [P]: a });
    const inp = inputs(A, [record(pair(a, await c.blob(t9([2, 'two']))))]);
    const X = tmap({ [P]: await c.blob(t9([2, 'two'], [6, 'six'])) });
    const sPub = await maskEntries(c.repo, X, inp, new RebaseCache(c.repo, () => true));
    const SIX = await c.blob(t9([6, 'SIX']));
    assert.deepEqual(await assertSPub(c.repo, X, withEntry(sPub, P, SIX), inp, new RebaseCache(c.repo, () => true)), { ok: false, clause: 'reapply', path: P });
    // The same replacement on a withheld path (a step-5 conflict) is ignored.
    const Xc = tmap({ [P]: await c.blob(t9([2, 'two'], [3, 'three'])) });
    const conflicted = await maskEntries(c.repo, Xc, inp, new RebaseCache(c.repo, () => true));
    assert.ok(conflicted.withheld.has(P));
    assert.deepEqual(await assertSPub(c.repo, Xc, withEntry(conflicted, P, SIX), inp, new RebaseCache(c.repo, () => true)), { ok: true });
  });
});

test('assertSPub \'revert_line\' fails when diff(A, S_pub) carries a line of an ON_DISK revert record\'s change', T10, async () => {
  await withMaskRepo('assert-spub-revert', async (c) => {
    const a = await c.blob(T9);
    const A = tmap({ [P]: a });
    const two = await c.blob(t9([2, 'two']));
    const X = tmap({ [P]: await c.blob(t9([2, 'two'], [6, 'six'])) });
    const revert = inputs(A, [record(pair(a, two))]);
    const sPub = await maskEntries(c.repo, X, revert, new RebaseCache(c.repo, () => true));
    // S_pub[p] := X[p]: the held `two` left in. Re-applying is idempotent, so `reapply` holds; the revert line is caught.
    const leaky = withEntry(sPub, P, X.get(P)!.oid);
    assert.deepEqual(await assertSPub(c.repo, X, leaky, revert, new RebaseCache(c.repo, () => true)), { ok: false, clause: 'revert_line', path: P });
    // The same unmasked S_pub with a `join` PATCH instead passes: only `revert` lines are an HLD-19 clause.
    const join = inputs(A, [record(pair(a, two), { guards: ['join'] })]);
    assert.deepEqual(await assertSPub(c.repo, X, leaky, join, new RebaseCache(c.repo, () => true)), { ok: true });
  });
});

test('assertP fails on each planted P', T10, async () => {
  await withMaskRepo('assert-p', async (c) => {
    const a = await c.blob(T9);
    const two = await c.blob(t9([2, 'two']));
    const ci = '.github/workflows/ci.yml';
    const env = 'config/.env.local';
    const k4 = 'src/k4.txt';
    const A = tmap({ [P]: a, [ci]: await c.blob('on: push\n'), [env]: await c.blob('KEY=1\n'), [k4]: a });
    const records: HoldRecord[] = [
      record(pair(a, two)),
      record(pair(A.get(env)!.oid, await c.blob('KEY=2\n'), env), { paths: [env], guards: ['revert'], local_only: true }),
      record({ s1: { [k4]: a }, s2: { [k4]: two }, s3: { [k4]: a } }, { paths: [k4], state: 'CONFLICTED', guards: ['conflict'] }),
    ];
    const inp = inputs(A, records, { scope: { [ci]: 'QUARANTINED' } });
    // R: an unheld edit on line 6 next to the held line 2; P == MASK(R) passes.
    const R = new Map(A);
    R.set(P, { path: P, mode: '100644', oid: await c.blob(t9([2, 'two'], [6, 'six'])) });
    const masked = await maskEntries(c.repo, R, inp, new RebaseCache(c.repo, () => true));
    assert.deepEqual(await assertP(c.repo, masked.entries, inp), { ok: true }, 'P == MASK(R)');
    const plant = async (p: string, bytes: string): Promise<Map<string, TreeEntry>> => {
      const out = new Map(masked.entries);
      out.set(p, { path: p, mode: '100644', oid: await c.blob(bytes) });
      return out;
    };
    assert.deepEqual(await assertP(c.repo, await plant(ci, 'on: [push]\n'), inp), { ok: false, clause: 'p_class', path: ci });
    assert.deepEqual(await assertP(c.repo, await plant(env, 'KEY=2\n'), inp), { ok: false, clause: 'p_local_only', path: env });
    assert.deepEqual(await assertP(c.repo, await plant(k4, t9([6, 'six'])), inp), { ok: false, clause: 'p_withheld', path: k4 });
    // A step-5 path whose P blob still carries the held change: the reverse merge of r is clean but changes it.
    assert.deepEqual(await assertP(c.repo, await plant(P, t9([2, 'two'], [6, 'six'])), inp), { ok: false, clause: 'p_range', path: P });
  });
});

// "ENG-41 (i) keeps meaning withheld whole by a record" is in publish.mask.test.ts: it runs through publishStep, so it checks the
// `masked` publish.ts's own compose() computes (Plan 3 Task 2 fix round 1), not a test-local formula.
