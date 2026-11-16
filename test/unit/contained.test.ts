// The containment form of touch (Plan 4 Task 6; 04 §3.6 "Containment form", glossary §1 S5; REG-33, T-REG-25 unit table,
// R1-011, R1-045, R1-110…R1-113). contained answers whether a hunk lies entirely inside the seat's own claims O; it reuses touch's
// inputs and step-4 extent test and only narrows. The two T-REG-25 rows about the own-claim set itself (claims first confirmed in
// the current wake turn are not in O; a non-LIVE path has no O) are pinned at the caller, Task 11 (confirm.notOwnContained,
// predict.ownContained).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { contained, type OwnClaimImage } from '../../src/regions/contained.js';
import { lineArray, normalizeRanges } from '../../src/regions/lines.js';
import { hunks, imageOf } from '../../src/regions/mapper.js';
import { touch, type TouchReason } from '../../src/regions/touch.js';
import type { Hunk, NoTable, NoTableReason, Ranges, RegionTable, TableOrNone, Unit } from '../../src/regions/types.js';
import { fixture, HOT_ZONE, RC_TOUCH_R2 } from '../helpers/regionFixtures.js';
import { testTable } from '../helpers/regionRuntime.js';

const OWN = 'a'.repeat(64);
const noTable = (reason: NoTableReason): NoTable => ({ kind: 'NO_TABLE', reason, lineCount: null });
const NO_TABLE_REASONS: readonly NoTableReason[] = ['budget', 'conflict_markers', 'binary', 'special', 'grammarless_small'];
const COMPUTE_TOTAL: Ranges = [HOT_ZONE.computeTotal];   // [[5331, 5339]]

const pathOf = (name: string): string => name.split('/').pop() as string;

interface Row { readonly name: string; readonly hunks: readonly Hunk[]; readonly post: RegionTable; readonly base: RegionTable; readonly claim: Unit; }

/** The base leaf unit RC_TOUCH_R2's claimUnit names: qualname plus an optional #disc (no #disc = an empty disc). */
function unitOf(t: RegionTable, claimUnit: string): Unit {
  const [qualname, disc = ''] = claimUnit.split('#');
  const hits = t.units.filter((u) => u.leaf && u.label.qualname === qualname && u.label.disc === disc);
  assert.equal(hits.length, 1, `${claimUnit}: exactly one base unit`);
  return hits[0] as Unit;
}

let rowsP: Promise<Row[]> | undefined;
/** The 15 rc_touch R2 rows: their hunks and the production tables of base and post. */
const r2 = (): Promise<Row[]> => {
  rowsP ??= (async () => {
    const out: Row[] = [];
    for (const r of RC_TOUCH_R2) {
      const base = fixture(r.base);
      const post = fixture(r.post);
      const bt = await testTable(pathOf(r.base), base);
      out.push({ name: r.name, hunks: hunks(lineArray(base), lineArray(post)), base: bt, post: await testTable(pathOf(r.post), post), claim: unitOf(bt, r.claimUnit) });
    }
    return out;
  })();
  return rowsP;
};
const row = async (name: string): Promise<Row> => (await r2()).find((r) => r.name === name) as Row;

/** An own HELD symbol claim mapped into base as inBase, with its image under the hunk list. */
const own = (inBase: Ranges, hs: readonly Hunk[]): OwnClaimImage => ({ granularity: 'symbol', inBase, inPost: imageOf(hs, inBase) });

test('contained: body edits, deletions and inside insertions of an own claim', async () => {
  const body = await row('py_body_edit');
  assert.equal(contained(body.hunks[0] as Hunk, [own(COMPUTE_TOTAL, body.hunks)], body.post), true, '(2) a body edit');
  const del: Hunk = { aLo: 5334, aHi: 5335, bLo: 5334, bHi: 5333 };
  assert.equal(contained(del, [own(COMPUTE_TOTAL, [del])], body.base), true, '(2) a deletion of rows 5334-5335');
  const ins: Hunk = { aLo: 5334, aHi: 5333, bLo: 5334, bHi: 5334 };
  assert.equal(contained(ins, [own(COMPUTE_TOTAL, [ins])], body.base), true, '(3) an insertion after row 5333');
  const append = await row('py_append_after_last_line');
  assert.deepEqual(append.hunks, [{ aLo: 5340, aHi: 5339, bLo: 5340, bHi: 5340 }]);
  assert.equal(contained(append.hunks[0] as Hunk, [own(COMPUTE_TOTAL, append.hunks)], append.post), true, '(4) a boundary insertion inside the post extent');
});

test('not contained: spanning hunks, error- or table-decided boundaries, group-name-only hits, WHOLE_FILE own claims', async () => {
  const body = await row('py_body_edit');
  const spanning: Hunk = { aLo: 5339, aHi: 5342, bLo: 5339, bHi: 5342 };   // the own function's last row and the unclaimed compute_tax
  assert.equal(contained(spanning, [own(COMPUTE_TOTAL, [spanning])], body.base), false);
  const half = await row('py_boundary_insert_half_typed');
  const h = half.hunks[0] as Hunk;
  assert.equal(contained(h, [own(COMPUTE_TOTAL, half.hunks)], half.post), false, 'decided only by an ERROR span');
  for (const reason of NO_TABLE_REASONS) assert.equal(contained(h, [own(COMPUTE_TOTAL, half.hunks)], noTable(reason)), false, `post NO_TABLE{${reason}}`);
  const append = await row('py_append_after_last_line');
  assert.equal(contained(append.hunks[0] as Hunk, [own(COMPUTE_TOTAL, append.hunks)], noTable('budget')), false, 'the in-extent boundary insertion without a table');
  const cs = await row('cs_new_overload_not_adjacent_to_held');
  assert.deepEqual([cs.claim.label.qualname, cs.claim.label.disc], ['N.Svc.Calc', '(int)']);
  assert.equal(contained(cs.hunks[0] as Hunk, [own(cs.claim.ranges, cs.hunks)], cs.post), false, 'contained has no group-name input');
  // an own claim whose mapping returned WHOLE_FILE contributes nothing to U
  const whole: OwnClaimImage = { granularity: 'symbol', inBase: 'WHOLE_FILE', inPost: 'WHOLE_FILE' };
  for (const r of await r2()) {
    for (const x of r.hunks) assert.equal(contained(x, [whole], r.post), false, `${r.name}: a WHOLE_FILE own claim`);
  }
  for (const x of [spanning, { aLo: 5334, aHi: 5333, bLo: 5334, bHi: 5334 }, { aLo: 5335, aHi: 5335, bLo: 5335, bHi: 5335 }]) {
    assert.equal(contained(x, [whole], body.post), false);
  }
  // a TOMBSTONE image places nothing in post: a boundary insertion is not contained
  assert.equal(contained(append.hunks[0] as Hunk, [{ granularity: 'symbol', inBase: COMPUTE_TOTAL, inPost: 'TOMBSTONE' }], append.post), false);
  assert.equal(contained(append.hunks[0] as Hunk, [], append.post), false, 'an empty O contains nothing');
});

test('an own file claim contains every hunk on its path', async () => {
  const file: OwnClaimImage = { granularity: 'file', inBase: 'WHOLE_FILE', inPost: 'WHOLE_FILE' };
  let n = 0;
  for (const r of await r2()) {
    for (const h of r.hunks) {
      assert.equal(contained(h, [file], r.post), true, `${r.name}: (1)`);
      assert.equal(contained(h, [file], noTable('budget')), true, `${r.name}: (1) needs no table`);
      n++;
    }
  }
  assert.equal(n, 15);
});

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const leaf = (unitId: number, ranges: Ranges): Unit => ({
  unitId, kind: 'block', label: { kind: 'block', qualname: '', simple: '', type: '', disc: '' }, ranges, parentUnitId: null, leaf: true, residue: false, sigSlice: null, granularity: 'block',
});
const NOT_CONTAINED_BOUNDARY: ReadonlySet<TouchReason> = new Set(['boundary-in-error', 'boundary-no-table']);
const CONTAINED_REASONS: ReadonlySet<TouchReason> = new Set(['degraded-whole-file', 'base-overlap', 'insert-inside', 'boundary-in-extent']);

/** Random hunks, claims and post tables on a 40-row base. */
const rangeArb = fc.tuple(fc.integer({ min: 1, max: 40 }), fc.integer({ min: 0, max: 5 })).map(([lo, n]): [number, number] => [lo, Math.min(40, lo + n)]);
const rangesArb = fc.array(rangeArb, { minLength: 1, maxLength: 3 }).map(normalizeRanges);
const hunkArb: fc.Arbitrary<Hunk> = fc.oneof(
  fc.tuple(fc.integer({ min: 0, max: 40 }), fc.integer({ min: 1, max: 4 })).map(([k, n]) => ({ aLo: k + 1, aHi: k, bLo: k + 1, bHi: k + n })),
  fc.tuple(fc.integer({ min: 1, max: 40 }), fc.integer({ min: 0, max: 4 }), fc.integer({ min: 0, max: 4 })).map(([lo, d, n]) => ({ aLo: lo, aHi: Math.min(40, lo + d), bLo: lo, bHi: lo + n - 1 })),
);
const postArb: fc.Arbitrary<TableOrNone> = fc.oneof(
  fc.constantFrom(...NO_TABLE_REASONS).map(noTable),
  fc.tuple(fc.array(rangeArb, { maxLength: 4 }), fc.array(rangeArb, { maxLength: 2 })).map(([units, errors]): RegionTable => ({
    grammar: null, regionSpec: OWN, decodable: true, lineCount: 50, units: units.map((r, i) => leaf(i + 1, [r])), imports: null,
    errorSpans: [...errors].sort((a, b) => a[0] - b[0]), errorCount: errors.length, labelCounts: {},
  })),
);

test('contained never consults the registry, labels or group names, and only narrows', async () => {
  const keys: Exact<keyof OwnClaimImage, 'granularity' | 'inBase' | 'inPost'> = true;
  assert.ok(keys);
  // on the 15 rows (real and every NO_TABLE post) and on random hunks, claims and tables: whenever touch answers
  // boundary-in-error or boundary-no-table the hunk is not contained, and a contained hunk always touches its claim
  const pairs: Array<[Hunk, OwnClaimImage, TableOrNone]> = [];
  for (const r of await r2()) {
    for (const post of [r.post, ...NO_TABLE_REASONS.map(noTable)]) for (const h of r.hunks) pairs.push([h, own(r.claim.ranges, r.hunks), post]);
  }
  const law = (h: Hunk, o: OwnClaimImage, post: TableOrNone): void => {
    const t = touch(h, { granularity: o.granularity, regionSpec: OWN }, { inBase: o.inBase, inPost: o.inPost, post, groupNameHit: true }, OWN);
    const c = contained(h, [o], post);
    if (NOT_CONTAINED_BOUNDARY.has(t.reason)) assert.equal(c, false, `${JSON.stringify(h)} ${t.reason}`);
    if (c) assert.ok(CONTAINED_REASONS.has(t.reason), `contained but touch says ${t.reason}: ${JSON.stringify(h)}`);
  };
  for (const [h, o, post] of pairs) law(h, o, post);
  fc.assert(fc.property(hunkArb, rangesArb, postArb, (h, inBase, post) => {
    law(h, { granularity: 'symbol', inBase, inPost: imageOf([h], inBase) }, post);
  }), { numRuns: 1_000, seed: 6_301 });
});
