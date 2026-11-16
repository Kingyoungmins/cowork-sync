// The rc_touch R2 table through the real pipeline (Plan 4 Task 6; 04 §3.6 VERIFIED rc_touch R2, §3.3 extent-convention/1 step 2,
// glossary §23; T-REG-02, TC-REG-02, REG-13, REG-14, R1-100…R1-108, INV-REG-NOLABEL basis). Base and post tables come from a
// RegionService over inlineWorkers (both registered as DiskSnapshotIds, so no git runs: the service's repo throws on any use),
// the claim is the base unit RC_TOUCH_R2 names, inBase is its ranges mapped by FoldMapper/1 in local mode, inPost the image of
// inBase under hunks(base, post), and the group-name hit comes from groupNameHit (C# rows) or is false.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import type { AttrSnapshot, PathAttrs } from '../../src/data/attrs.js';
import { parseOid } from '../../src/git/oid.js';
import type { GitRepo } from '../../src/git/repo.js';
import { clockBudgets } from '../../src/regions/budgets.js';
import { TableCache } from '../../src/regions/cache.js';
import { groupNameHit } from '../../src/regions/groupName.js';
import { lineArray, rangesIntersect } from '../../src/regions/lines.js';
import { D_CAP, editDistance, hunks, imageOf, mapRangesLines } from '../../src/regions/mapper.js';
import type { RegionWorkers } from '../../src/regions/pool.js';
import { RegionService } from '../../src/regions/service.js';
import { SnapshotStore } from '../../src/regions/snapshots.js';
import { touch, type TouchReason } from '../../src/regions/touch.js';
import type { Hunk, Label, Language, Ranges, RegionTable, TableOrNone, Unit } from '../../src/regions/types.js';
import { inlineWorkers } from '../../src/regions/worker/inline.js';
import { fixture, RC_TOUCH_R2 } from '../helpers/regionFixtures.js';
import { testRegionRuntime, testSnapshot } from '../helpers/regionRuntime.js';
import { VirtualClock } from '../sim/vclock.js';

const PLAIN: PathAttrs = { filter: null, merge: null, text: null, binary: false, eol: null, generated: false, coworkOff: false, workingTreeEncoding: null };
const EPOCH = parseOid('e'.repeat(40));

let workers: RegionWorkers;
let service: RegionService;
let ownSpec: string;

before(async () => {
  const runtime = await testRegionRuntime();
  ownSpec = runtime.regionSpec;
  workers = await inlineWorkers(runtime);
  const clock = new VirtualClock();
  const noGit = new Proxy({}, { get: (_t, prop) => { throw new Error(`no git in this test: repo.${String(prop)}`); } }) as GitRepo;
  service = new RegionService({
    repo: noGit, workers, budgets: clockBudgets(clock), cache: new TableCache(), snapshots: new SnapshotStore(), regionSpec: ownSpec,
    log: { write: (_l, code) => { throw new Error(`unexpected log line ${code}`); } }, clock,
    attrs: async (epochBase, _paths): Promise<AttrSnapshot> => ({ epochBase, get: () => PLAIN }),
    privateIndex: '/unused/private.index',
    onBudget: (path, b) => { throw new Error(`unexpected budget overrun ${path} ${b}`); },
  });
});

after(async () => {
  await workers.close();
});

/** The repo path of a fixture: its last component (the extension picks the grammar). */
const pathOf = (name: string): string => name.split('/').pop() as string;
const langOf = (path: string): Language => (path.endsWith('.cs') ? 'c_sharp' : path.endsWith('.js') ? 'javascript' : 'python');
const isTable = (t: TableOrNone): t is RegionTable => 'units' in t;

async function tableOf(path: string, bytes: Buffer, owner: string): Promise<RegionTable> {
  const t = await service.table(testSnapshot(service.deps.snapshots, path, bytes, owner), path, { epochBase: EPOCH });
  assert.ok(isTable(t), `${path}: a table`);
  return t;
}

/** The base leaf unit RC_TOUCH_R2's claimUnit names: qualname plus an optional #disc (no #disc = an empty disc). */
function unitOf(t: RegionTable, claimUnit: string): Unit {
  const [qualname, disc = ''] = claimUnit.split('#');
  const hits = t.units.filter((u) => u.leaf && u.label.qualname === qualname && u.label.disc === disc);
  assert.equal(hits.length, 1, `${claimUnit}: exactly one base unit`);
  return hits[0] as Unit;
}

/** The post leaf units a hunk adds or rewrites (the group-name rule's "added" input as this test computes it). */
const addedBy = (post: RegionTable, h: Hunk): Unit[] => (h.bLo <= h.bHi ? post.units.filter((u) => u.leaf && rangesIntersect(u.ranges, [[h.bLo, h.bHi]])) : []);

interface Case {
  readonly name: string; readonly lang: Language; readonly base: RegionTable; readonly post: RegionTable; readonly claim: Unit;
  readonly hunks: readonly Hunk[]; readonly inBase: Ranges; readonly inPost: Ranges | 'TOMBSTONE';
}

async function caseOf(name: string, path: string, base: Buffer, post: Buffer, claimUnit: string): Promise<Case> {
  const baseRows = lineArray(base);
  const postRows = lineArray(post);
  const bt = await tableOf(path, base, `${name}:base`);
  const pt = await tableOf(path, post, `${name}:post`);
  const claim = unitOf(bt, claimUnit);
  const inBase = mapRangesLines(baseRows, baseRows, claim.ranges, 'local', service.deps.budgets.deadline('map'));
  assert.ok(inBase !== 'WHOLE_FILE' && inBase !== 'TOMBSTONE', `${name}: the claim maps into base`);
  assert.ok(editDistance(baseRows, postRows, D_CAP) !== null, `${name}: D <= D_CAP before hunks()`);
  const hs = hunks(baseRows, postRows);
  return { name, lang: langOf(path), base: bt, post: pt, claim, hunks: hs, inBase, inPost: imageOf(hs, inBase) };
}

/** groupNameHit as a caller computes it for one hunk: C# rows from this daemon's own tables, false for the others. */
const groupHit = (c: Case, post: RegionTable, claim: Unit, h: Hunk): boolean => (c.lang === 'c_sharp' ? groupNameHit(c.lang, addedBy(post, h), [claim], null) : false);

function verdictOf(c: Case, h: Hunk, post: RegionTable = c.post, claim: Unit = c.claim): { touch: boolean; reason: TouchReason } {
  return touch(h, { granularity: 'symbol', regionSpec: ownSpec }, { inBase: c.inBase, inPost: c.inPost, post, groupNameHit: groupHit(c, post, claim, h) }, ownSpec);
}

let r2Cases: Promise<Case[]> | undefined;
const r2 = (): Promise<Case[]> => {
  r2Cases ??= (async () => {
    const out: Case[] = [];
    for (const r of RC_TOUCH_R2) out.push(await caseOf(r.name, pathOf(r.base), fixture(r.base), fixture(r.post), r.claimUnit));
    return out;
  })();
  return r2Cases;
};

test('the 15 rc_touch R2 rows give their verdicts and reasons', async () => {
  const cases = await r2();
  assert.equal(cases.length, 15);
  const got = cases.map((c) => {
    assert.equal(c.hunks.length, 1, `${c.name}: one hunk`);
    return [c.name, verdictOf(c, c.hunks[0] as Hunk)];
  });
  const expected = RC_TOUCH_R2.map((r) => [r.name, { touch: r.expect !== 'none', reason: r.expect }]);
  assert.deepEqual(got, expected);
  const v = (name: string): Case => cases.find((c) => c.name === name) as Case;

  // py_append_after_last_line touches only through step 4: a pure insertion after k = hi, inside the post extent 5331–5340
  const append = v('py_append_after_last_line');
  assert.deepEqual(append.hunks, [{ aLo: 5340, aHi: 5339, bLo: 5340, bHi: 5340 }]);
  assert.deepEqual(append.inBase, [[5331, 5339]]);
  assert.deepEqual(unitOf(append.post, 'compute_total').ranges, [[5331, 5340]], 'the post extent 5331–5340');
  // the half-typed boundary insertion lies outside compute_total's post extent; only the ERROR span covers it
  const half = v('py_boundary_insert_half_typed');
  assert.deepEqual(unitOf(half.post, 'compute_total').ranges, [[5331, 5339]]);
  assert.ok(rangesIntersect(half.post.errorSpans, [[5340, 5340]]));
  // cs_new_overload_not_adjacent_to_held: the range test is disjoint, the group-name hit is Calc@30
  const cs = v('cs_new_overload_not_adjacent_to_held');
  const h = cs.hunks[0] as Hunk;
  assert.deepEqual(cs.inBase, [[12, 15]]);
  assert.ok(h.aLo > h.aHi && (h.aHi < 11 || h.aHi > 15), 'a pure insertion with k outside [lo - 1, hi]: no step 2, 3 or 4 relation');
  const hit = addedBy(cs.post, h).filter((u) => u.label.simple === 'Calc');
  assert.deepEqual(hit.map((u) => [u.label.qualname, u.label.disc, u.ranges[0]?.[0]]), [['N.Svc.Calc', '(decimal)', 30]]);
});

/** Inserts rows after base row `after` of an LF file (0 = at the top). */
function insertRows(bytes: Buffer, after: number, rows: readonly string[]): Buffer {
  const lines = bytes.toString('utf8').split('\n');
  lines.splice(after, 0, ...rows);
  return Buffer.from(lines.join('\n'), 'utf8');
}

test('a comment-only insertion directly above a held unit touches it (glossary §23)', async () => {
  const rows: Array<[name: string, base: string, after: number, comment: string, claimUnit: string]> = [
    ['python', 'big_lf.py', 5330, '# note', 'compute_total'],
    ['c_sharp', 'csharp/Svc.cs', 11, '        /// <summary>', 'N.Svc.Calc#(int)'],
    ['javascript', 'rc_touch/account.js', 5, '  // note', 'Account.balance#set'],
  ];
  for (const [lang, name, at, comment, claimUnit] of rows) {
    const base = fixture(name);
    const direct = await caseOf(`${lang} direct`, pathOf(name), base, insertRows(base, at, [comment]), claimUnit);
    assert.deepEqual(direct.hunks, [{ aLo: at + 1, aHi: at, bLo: at + 1, bHi: at + 1 }], `${lang}: one row after k = lo - 1`);
    assert.equal(direct.inBase[0]?.[0], at + 1, `${lang}: the claim starts right below the insertion`);
    assert.deepEqual(verdictOf(direct, direct.hunks[0] as Hunk), { touch: true, reason: 'boundary-in-extent' }, `${lang}: directly above`);
    const apart = await caseOf(`${lang} apart`, pathOf(name), base, insertRows(base, at, [comment, '']), claimUnit);
    assert.equal(apart.hunks.length, 1);
    assert.deepEqual(verdictOf(apart, apart.hunks[0] as Hunk), { touch: false, reason: 'none' }, `${lang}: separated by an empty row`);
  }
});

const STEP_1_TO_4: ReadonlySet<TouchReason> = new Set(['degraded-whole-file', 'base-overlap', 'insert-inside', 'boundary-in-extent', 'boundary-in-error', 'boundary-no-table']);
const LABEL_FIELDS = ['kind', 'qualname', 'simple', 'type', 'disc'] as const;

test('labels can add a touch, never remove one', async () => {
  const cases = await r2();
  // validLabel-safe strings (SEC-35's field pattern): a pool of 64 per run, half drawn from a few names so that C# (type, simple)
  // pairs collide; every label field of every post unit and of the claimed base unit takes a pool entry chosen by a salted hash
  // of (row, side, unit, field), so each run relabels the whole tables
  const field = fc.oneof(fc.constantFrom('N.Svc', 'Calc', 'Svc', 'compute_total', 'set'), fc.stringMatching(/^[A-Za-z0-9_.:#<>,$@()-]{1,12}$/));
  const pick = (salt: number, ...xs: number[]): number => {
    let x = salt | 0;
    for (const v of xs) x = Math.imul(x ^ v, 0x9e3779b1) ^ (x >>> 15);
    return (x >>> 0) % 64;
  };
  let changed = 0;
  fc.assert(fc.property(fc.array(field, { minLength: 64, maxLength: 64 }), fc.integer(), (pool, salt) => {
    const relabel = (row: number, side: number, u: Unit): Unit => {
      const label = Object.fromEntries(LABEL_FIELDS.map((f, i) => [f, pool[pick(salt, row, side, u.unitId, i)] as string])) as unknown as Label;
      return { ...u, label };
    };
    cases.forEach((c, row) => {
      const post: RegionTable = { ...c.post, units: c.post.units.map((u) => relabel(row, 1, u)) };
      const claim = relabel(row, 0, c.claim);
      for (const h of c.hunks) {
        const honest = verdictOf(c, h);
        const noisy = verdictOf(c, h, post, claim);
        if (STEP_1_TO_4.has(honest.reason)) assert.deepEqual(noisy, honest, `${c.name}: a step 1-4 touch survives label noise`);
        if (noisy.reason !== honest.reason) {
          changed++;
          assert.equal(c.lang, 'c_sharp', `${c.name}: only a C# row's verdict moves`);
          assert.notEqual(groupHit(c, post, claim, h), groupHit(c, c.post, c.claim, h), `${c.name}: only through groupNameHit`);
          assert.deepEqual(new Set([noisy.reason, honest.reason]), new Set<TouchReason>(['group-name', 'none']));
        }
      }
    });
  }), { numRuns: 1_000, seed: 6_201 });
  assert.ok(changed > 0, 'label noise moved the C# group-name verdict at least once');
});
