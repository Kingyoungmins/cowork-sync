// Property: MASK(S_disk) is A plus every unheld local edit (Plan 3 Task 2; 05-holds HLD-15, HLD-19; D3, D8). fast-check, 100
// runs (05 P1's ≥ 1,000-trial run is Task 14), on one real clone: a 20-line A, 1–4 local edits ≥ 2 unchanged lines apart (git
// merges edits on adjacent lines as one conflict, Global Constraints), a random non-empty subset held by 1–3 `revert` PATCH records
// (every run exercises step 5); the result is A with exactly the unheld edits, and assertSPub passes on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { assertSPub, maskEntries } from '../../src/holds/mask.js';
import { RebaseCache } from '../../src/holds/rebase.js';
import { inputs, pair, record, tmap, ulidOf, withMaskRepo } from '../helpers/maskFixture.js';

const PATH = 'src/twenty.txt';
const LINES = 20;
const A_ROWS = Array.from({ length: LINES }, (_, i) => `line ${i + 1}`);
const text = (rs: readonly string[]): string => `${rs.join('\n')}\n`;
const apply = (edits: ReadonlyArray<readonly [number, string]>): string => {
  const rs = [...A_ROWS];
  for (const [n, s] of edits) rs[n - 1] = s;
  return text(rs);
};

/** 1–4 distinct line numbers in 1..20, pairwise ≥ 3 apart (≥ 2 unchanged lines between). */
const positions = fc.uniqueArray(fc.integer({ min: 1, max: LINES }), { minLength: 1, maxLength: 4 })
  .map((ps) => [...ps].sort((x, y) => x - y))
  .filter((ps) => ps.every((p, i) => i === 0 || p - ps[i - 1]! >= 3));

/** A random held subset that always holds at least one edit (index `must` is held whatever its drawn flag). */
const scenario = positions.chain((ps) => fc.record({
  ps: fc.constant(ps),
  drawn: fc.array(fc.boolean(), { minLength: ps.length, maxLength: ps.length }),
  must: fc.integer({ min: 0, max: ps.length - 1 }),
  owner: fc.array(fc.integer({ min: 0, max: 2 }), { minLength: ps.length, maxLength: ps.length }),
  tag: fc.integer({ min: 0, max: 9999 }),
}).map(({ drawn, must, ...rest }) => ({ ...rest, held: drawn.map((h, i) => h || i === must) })));

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

test('property: MASK(S_disk) is A plus every unheld local edit', T10, async () => {
  await withMaskRepo('mask-prop', async (c) => {
    const a = await c.blob(text(A_ROWS));
    const A = tmap({ [PATH]: a });
    await fc.assert(fc.asyncProperty(scenario, async ({ ps, held, owner, tag }) => {
      const edits = ps.map((n) => [n, `edit ${tag} of line ${n}`] as const);
      const X = tmap({ [PATH]: await c.blob(apply(edits)) });
      // Up to 3 records, each holding the held edits assigned to it (a record with none is not created).
      const byRecord = new Map<number, Array<readonly [number, string]>>();
      edits.forEach((e, i) => {
        if (!held[i]) return;
        const k = owner[i]!;
        byRecord.set(k, [...(byRecord.get(k) ?? []), e]);
      });
      const records = [];
      for (const [k, es] of [...byRecord].sort(([x], [y]) => x - y)) {
        records.push(record(pair(a, await c.blob(apply(es)), PATH), { paths: [PATH], id: ulidOf(k) }));
      }
      assert.ok(records.length >= 1, `at least one held edit (held ${JSON.stringify(held)})`);
      const inp = inputs(A, records);
      const out = await maskEntries(c.repo, X, inp, new RebaseCache(c.repo, () => true));
      const want = apply(edits.filter((_, i) => !held[i]));
      assert.equal((await c.repo.readBlob(out.entries.get(PATH)!.oid)).toString('utf8'), want);
      assert.deepEqual(out.conflicted, []);
      assert.deepEqual(await assertSPub(c.repo, X, out, inp, new RebaseCache(c.repo, () => true)), { ok: true });
    }), { numRuns: 100, seed: 0x2a2a, endOnFailure: true });
  });
});
