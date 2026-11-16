// The interface check on real git (Plan 4 Task 7; 04 §3.10, §3.20 "Caller search without a stored merged tree"; REG-26, REG-27,
// REG-31, REG-35, INV-REG-READ; T-REG-09, R1-009, R1-142…R1-148, R2-E12, R4-44, R4-50, R4-69, R4-72). A file:// fixture clone,
// trees from commitFiles (mktree for names Git for Windows' index drops, ruling PF-10), the pinned grammars on inlineWorkers and a
// VirtualClock, so no budget expires unless a test injects it. interfaceCheck(s, {base, ours, out, csPaths, csRows, epochBase},
// budgets.deadline('t0', 4)) unless a test says otherwise; csRows are the b-side rows of hunks(base[p], ours[p]).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { AttrCache } from '../../src/data/attrs.js';
import { buildGitInvocation, type GitCallOptions } from '../../src/git/flags.js';
import { mergeTree } from '../../src/git/merge.js';
import { parseOid, type Oid } from '../../src/git/oid.js';
import { GitCommandError, GitRepo, type RunOpts } from '../../src/git/repo.js';
import type { GitRunner } from '../../src/git/runner.js';
import { realFs } from '../../src/ports/fs.js';
import type { Log } from '../../src/ports/log.js';
import { clockBudgets, testBudgetInjector, type BudgetInjector, type BudgetKind, type Deadline, type RegionBudgets } from '../../src/regions/budgets.js';
import { TableCache } from '../../src/regions/cache.js';
import type { Finding, InterfaceResult } from '../../src/regions/interface.js';
import { callerHits, interfaceCheck, wholeWordRows } from '../../src/regions/interfaceService.js';
import { lineArray } from '../../src/regions/lines.js';
import { hunks, normalizeRanges } from '../../src/regions/mapper.js';
import type { RegionWorkers } from '../../src/regions/pool.js';
import { RegionService } from '../../src/regions/service.js';
import { SnapshotStore } from '../../src/regions/snapshots.js';
import type { BlobRef, Label, Ranges, TreeView } from '../../src/regions/types.js';
import { inlineWorkers } from '../../src/regions/worker/inline.js';
import { commitFiles } from '../helpers/commitFiles.js';
import { looseObjectCount, readGuard } from '../helpers/regionAsserts.js';
import { fixture } from '../helpers/regionFixtures.js';
import { blobIdOf, testRegionRuntime, testSnapshot } from '../helpers/regionRuntime.js';
import { fixtureContext, makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import { VirtualClock } from '../sim/vclock.js';

interface Suite { f: RepoFixture; workers: RegionWorkers; attrs: AttrCache; epochBase: Oid; }
let S: Suite;

before(async () => {
  const f = await makeRepoFixture('interface-check');
  const epochBase = await commitFiles(f, { 'README.md': 'epoch\n' });
  const attrs = new AttrCache(f.repo, realFs);
  await attrs.snapshot(epochBase, ['a.py']);
  S = { f, workers: await inlineWorkers(await testRegionRuntime()), attrs, epochBase };
});

after(async () => {
  await S.workers.close();
  await S.f.cleanup();
});

// ---- harness --------------------------------------------------------------------------------------------------------------------

interface Svc {
  readonly s: RegionService;
  readonly snapshots: SnapshotStore;
  readonly clock: VirtualClock;
  readonly budgetCalls: Array<readonly [BudgetKind, number | undefined]>;
  readonly onBudget: Array<readonly [string, string]>;
  readonly logs: string[];
}

async function service(o: { repo?: GitRepo; inject?: BudgetInjector; snapshots?: SnapshotStore } = {}): Promise<Svc> {
  const runtime = await testRegionRuntime();
  const clock = new VirtualClock();
  const inner = clockBudgets(clock, o.inject);
  const budgetCalls: Array<readonly [BudgetKind, number | undefined]> = [];
  const budgets: RegionBudgets = { deadline: (k, f) => { budgetCalls.push([k, f]); return inner.deadline(k, f); } };
  const snapshots = o.snapshots ?? new SnapshotStore();
  const onBudget: Array<readonly [string, string]> = [];
  const logs: string[] = [];
  const log: Log = { write: (_level, code) => { logs.push(code); } };
  const s = new RegionService({
    repo: o.repo ?? S.f.repo, workers: S.workers, budgets, cache: new TableCache(), snapshots, regionSpec: runtime.regionSpec, log, clock,
    attrs: (e, p) => S.attrs.snapshot(e, p), privateIndex: join(S.f.paths.gitDir, 'cowork', 'private.index'), onBudget: (p, b) => onBudget.push([p, b]),
  });
  return { s, snapshots, clock, budgetCalls, onBudget, logs };
}

type Files = Readonly<Record<string, string | Buffer>>;
const buf = (b: string | Buffer | undefined): Buffer => (b === undefined ? Buffer.alloc(0) : typeof b === 'string' ? Buffer.from(b, 'utf8') : b);
const text = (rows: readonly string[]): string => `${rows.join('\n')}\n`;

async function treeOf(files: Files): Promise<Oid> {
  return (await S.f.repo.readCommit(await commitFiles(S.f, files))).tree;
}

/** The rows the CS wrote in ours[p]: the b-sides of hunks(base[p], ours[p]). */
function rowsWritten(base: string | Buffer | undefined, ours: string | Buffer | undefined): Ranges {
  return normalizeRanges(hunks(lineArray(buf(base)), lineArray(buf(ours))).filter((h) => h.bLo <= h.bHi).map((h) => [h.bLo, h.bHi] as const));
}

const changed = (base: Files, ours: Files): string[] => [...new Set([...Object.keys(base), ...Object.keys(ours)])]
  .filter((p) => !buf(base[p]).equals(buf(ours[p])) || (base[p] === undefined) !== (ours[p] === undefined)).sort();

interface Run { base: Files; ours: Files; out: Files | Oid; csPaths?: string[]; deadline?: Deadline; views?: { ours?: TreeView; out?: TreeView } }

async function check(sv: Svc, r: Run): Promise<InterfaceResult> {
  const base = sv.s.view(await treeOf(r.base));
  const ours = r.views?.ours ?? sv.s.view(await treeOf(r.ours));
  const out = r.views?.out ?? sv.s.view(typeof r.out === 'string' ? r.out : await treeOf(r.out));
  const csPaths = r.csPaths ?? changed(r.base, r.ours);
  const csRows = new Map(csPaths.map((p) => [p, rowsWritten(r.base[p], r.ours[p])] as const));
  return interfaceCheck(sv.s, { base, ours, out, csPaths, csRows, epochBase: S.epochBase }, r.deadline ?? sv.s.deps.budgets.deadline('t0', 4));
}

const F = (path: string, line: number, name: string, removal = false): Finding => ({ path, line, name, removal });
const fn = (name: string): Label => ({ kind: 'function', qualname: name, simple: name, type: '', disc: '' });

/** A GitRepo over the fixture whose `run` and runner calls are recorded; onGrep runs before every grep reaches git. */
function spyRepo(onGrep?: (opts: RunOpts) => Promise<void>): { repo: GitRepo; runs: Array<{ args: string[]; opts: RunOpts }>; calls: Array<{ args: string[]; opts: GitCallOptions }> } {
  const runs: Array<{ args: string[]; opts: RunOpts }> = [];
  const calls: Array<{ args: string[]; opts: GitCallOptions }> = [];
  const runner: GitRunner = { run: (args, opts) => { calls.push({ args, opts }); return S.f.runner.run(args, opts); } };
  const inner = new GitRepo(runner, S.f.paths, fixtureContext);
  const repo = new Proxy(inner, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (prop !== 'run' || typeof v !== 'function') return v;
      const run = v as GitRepo['run'];
      return async (args: string[], opts: RunOpts = {}) => {
        runs.push({ args, opts });
        if (args[0] === 'grep' && onGrep !== undefined) await onGrep(opts);
        return run.call(receiver, args, opts);
      };
    },
  });
  return { repo, runs, calls };
}

// ---- X7 (R4-69) and PRICE (the Notes) ---------------------------------------------------------------------------------------------

const x7 = (side: 'base' | 'ours' | 'theirs'): Record<string, Buffer> => ({ 'lib.py': fixture(`interface/X7/${side}/lib.py`), 'orders.py': fixture(`interface/X7/${side}/orders.py`) });

async function x7Out(theirs: Record<string, Buffer> = x7('theirs')): Promise<Oid> {
  const m = await mergeTree(S.f.repo, await treeOf(x7('base')), await treeOf(x7('ours')), await treeOf(theirs));
  assert.equal(m.rc, 0, 'the CAS re-merge is clean');
  return m.tree;
}

const X7_BREAKING = [{ path: 'lib.py', label: fn('foo'), name: 'foo', kind: 'param_removed', removal: false }];

const PRICE: Readonly<Record<'pricing.py' | 'orders.py' | 'reports.py', readonly string[]>> = {
  'pricing.py': ["CURRENCY = 'EUR'", '', '', 'def compute_price(qty, unit):', '    return qty * unit', '', '', 'def fmt(x):', "    return f'{x:.2f}'"],
  'orders.py': ['from pricing import compute_price', '', '', 'def checkout(qty):', '    return compute_price(qty, 2)'],
  'reports.py': ['import pricing', '', '', 'def report(q):', '    return pricing.compute_price(q, 3)'],
};
const priceFiles = (): Record<string, string> => Object.fromEntries(Object.entries(PRICE).map(([p, rows]) => [p, text(rows)]));
/** PRICE with row r of path replaced. */
const withRow = (files: Record<string, string>, path: string, row: number, value: string): Record<string, string> => {
  const rows = (files[path] as string).split('\n');
  rows[row - 1] = value;
  return { ...files, [path]: rows.join('\n') };
};
const CURRENCY_REQUIRED = 'def compute_price(qty, unit, currency):';

// ---- tests ----------------------------------------------------------------------------------------------------------------------------

test("T-REG-09 unit: X7's re-merged caller of the old arity is an incompatibleCallers entry at orders.py:14", async () => {
  const sv = await service();
  const r = await check(sv, { base: x7('base'), ours: x7('ours'), out: await x7Out() });
  assert.deepEqual(r.breaking, X7_BREAKING);
  assert.deepEqual(r.incompatibleCallers, [F('orders.py', 14, 'foo')]);
  assert.equal(r.incomplete, false);
  assert.equal(r.incompleteBudget, null);
  // the negative control: Bob's row 14 calls foo(price), one argument
  const theirs = x7('theirs');
  const bob = { ...theirs, 'orders.py': Buffer.from(theirs['orders.py'].toString('utf8').replace('    total = foo(price, qty)', '    total = foo(price)'), 'utf8') };
  const neg = await check(sv, { base: x7('base'), ours: x7('ours'), out: await x7Out(bob) });
  assert.deepEqual(neg.breaking, X7_BREAKING);
  assert.deepEqual(neg.incompatibleCallers, []);
  assert.equal(neg.incomplete, false);
});

test('callers the CS wrote itself are never entries, and a CS that updates every caller produces none', async () => {
  const sv = await service();
  const base = priceFiles();
  let ours = withRow(base, 'pricing.py', 4, CURRENCY_REQUIRED);
  ours = withRow(ours, 'orders.py', 5, "    return compute_price(qty, 2, 'EUR')");
  const all = withRow(ours, 'reports.py', 5, "    return pricing.compute_price(q, 3, 'EUR')");
  const r = await check(sv, { base, ours: all, out: all });
  assert.deepEqual(r.breaking.map((b) => [b.name, b.kind]), [['compute_price', 'required_added']]);
  assert.deepEqual(r.incompatibleCallers, []);
  assert.deepEqual(r.orphanCalls, []);
  const partial = await check(sv, { base, ours, out: ours });
  assert.deepEqual(partial.incompatibleCallers, [F('reports.py', 5, 'compute_price')]);
  // a call the CS wrote itself is no incompatibleCallers entry even with the old arity: the callee check reports it instead
  const own = withRow(withRow(base, 'pricing.py', 4, CURRENCY_REQUIRED), 'orders.py', 5, '    return compute_price(qty, 2)  # rewritten');
  const mine = await check(sv, { base, ours: own, out: own });
  assert.deepEqual(mine.incompatibleCallers, [F('reports.py', 5, 'compute_price')]);
  assert.deepEqual(mine.orphanCalls, [F('orders.py', 5, 'compute_price')]);
});

// fix r1 finding 1: a function whose name survives only as a value or a class is removed (04 §3.10 "a unit or export removed"),
// never a compatible change, so every definite caller is a removal entry (P2)
test('a removed function whose name survives as a value or a class is a removal, and its callers are removal entries', async () => {
  const sv = await service();
  const base = priceFiles();
  for (const [row4, row5] of [['compute_price = make_pricer()', ''], ['class compute_price:', '    pass']] as const) {
    const ours = withRow(withRow(base, 'pricing.py', 4, row4), 'pricing.py', 5, row5);
    const r = await check(sv, { base, ours, out: ours });
    assert.deepEqual(r.breaking, [{ path: 'pricing.py', label: fn('compute_price'), name: 'compute_price', kind: 'removed', removal: true }], row4);
    assert.deepEqual(r.incompatibleCallers, [F('orders.py', 5, 'compute_price', true), F('reports.py', 5, 'compute_price', true)], row4);
    // `from pricing import compute_price` still resolves (out's pricing.py defines the name), so no unresolvedImports entry: the import
    // works at run time, the calls break
    assert.deepEqual(r.unresolvedImports, [], row4);
    assert.equal(r.incomplete, false, row4);
  }
});

test('orphan call: a call this CS adds to a callee TIP made incompatible', async () => {
  const sv = await service();
  const util = text(['def foo(a, b):', '    return a + b']);
  const main = ['from util import foo', '', '', 'def run():', '    return 0', ''];
  const base = { 'util.py': util, 'main.py': text(main) };
  const ours = { 'util.py': util, 'main.py': text([...main, 'def run2():', '    return foo(1, 2)']) };
  const out = { 'util.py': text(['def foo(a):', '    return a']), 'main.py': ours['main.py'] };
  const r = await check(sv, { base, ours, out });
  assert.deepEqual(r.breaking, []);
  assert.deepEqual(r.orphanCalls, [F('main.py', 8, 'foo')]);
  assert.deepEqual(r.incompatibleCallers, []);
});

test('unresolved import names: Python dotted, relative and JS/TS specifiers', async () => {
  const sv = await service();
  // a name the CS imports that out's pricing.py lacks
  const base = priceFiles();
  const rows = [...PRICE['orders.py']];
  rows.splice(1, 0, 'from pricing import CURRENCY_DEFAULT');
  const ours = { ...base, 'orders.py': text(rows) };
  const r = await check(sv, { base, ours, out: ours });
  assert.deepEqual(r.unresolvedImports, [F('orders.py', 2, 'CURRENCY_DEFAULT')]);
  // dotted: a/b.py before a/b/__init__.py
  const importer = { 'x.py': text(['from a.b import n', '', '', 'def go():', '    return n']) };
  const baseX = { 'x.py': text(['def go():', '    return 1']) };
  const both = { ...importer, 'a/b.py': text(['m = 1']), 'a/b/__init__.py': text(['n = 1']) };
  assert.deepEqual((await check(sv, { base: { ...baseX, 'a/b.py': both['a/b.py'], 'a/b/__init__.py': both['a/b/__init__.py'] }, ours: both, out: both })).unresolvedImports,
    [F('x.py', 1, 'n')], 'a/b.py is resolved first and lacks n');
  const pkgOnly = { ...importer, 'a/b/__init__.py': text(['n = 1']) };
  assert.deepEqual((await check(sv, { base: { ...baseX, 'a/b/__init__.py': pkgOnly['a/b/__init__.py'] }, ours: pkgOnly, out: pkgOnly })).unresolvedImports, []);
  // relative: from ..m import n in pkg/sub/x.py resolves pkg/m.py (decoys: m.py and pkg/sub/m.py define n)
  const rel = { 'pkg/sub/x.py': text(['from ..m import n', '', '', 'def go():', '    return n']), 'pkg/m.py': text(['k = 1']), 'm.py': text(['n = 1']), 'pkg/sub/m.py': text(['n = 1']) };
  const relBase = { ...rel, 'pkg/sub/x.py': text(['def go():', '    return 1']) };
  assert.deepEqual((await check(sv, { base: relBase, ours: rel, out: rel })).unresolvedImports, [F('pkg/sub/x.py', 1, 'n')]);
  const relOk = { ...rel, 'pkg/m.py': text(['n = 1']) };
  assert.deepEqual((await check(sv, { base: { ...relBase, 'pkg/m.py': relOk['pkg/m.py'] }, ours: relOk, out: relOk })).unresolvedImports, []);
  // JS/TS: m.ts, m.tsx, m.js, m.jsx, m.mjs, m.cjs, then m/index.* in that order — candidate k lacks n, every later one defines it
  const candidates = ['m.ts', 'm.tsx', 'm.js', 'm.jsx', 'm.mjs', 'm.cjs', 'm/index.ts', 'm/index.tsx', 'm/index.js', 'm/index.jsx', 'm/index.mjs', 'm/index.cjs'];
  const jsImporter = text(["import { n } from './m';", '', 'export const v = n;']);
  for (let k = 0; k < candidates.length; k++) {
    const files: Record<string, string> = { 'x.ts': jsImporter };
    candidates.forEach((c, i) => {
      if (i === k) files[c] = text(['export const other = 1;']);
      else if (i > k) files[c] = text(['export const n = 1;']);
    });
    const jsBase = { ...files, 'x.ts': text(['export const v = 1;']) };
    assert.deepEqual((await check(sv, { base: jsBase, ours: files, out: files })).unresolvedImports, [F('x.ts', 1, 'n')], `${candidates[k] as string} is tried before the later candidates`);
  }
  // an importer outside the CS of a name this CS removed
  const mBase = { 'm.py': text(['def n():', '    return 1', '', '', 'def k():', '    return 2']), 'x.py': text(['from m import n', '', '', 'def use():', '    return 1']) };
  const mOurs = { ...mBase, 'm.py': text(['def k():', '    return 2']) };
  const removed = await check(sv, { base: mBase, ours: mOurs, out: mOurs });
  assert.deepEqual(removed.breaking.map((b) => [b.name, b.kind, b.removal]), [['n', 'removed', true]]);
  assert.deepEqual(removed.unresolvedImports, [F('x.py', 1, 'n', true)]);
});

test('possible-only hits, more than 50 hits and stoplist names produce notes only', async () => {
  const sv = await service();
  const base = { ...priceFiles(), 'misc.py': text(['def go(obj):', '    return obj.compute_price(1, 2)']) };
  const ours = withRow(base, 'pricing.py', 4, CURRENCY_REQUIRED);
  const possible = await check(sv, { base, ours, out: ours, csPaths: ['pricing.py'] });
  assert.ok(possible.notes.some((n) => n.path === 'misc.py' && n.line === 2 && n.kind === 'possible'));
  assert.ok(!possible.incompatibleCallers.some((x) => x.path === 'misc.py'), 'a possible hit is no entry');
  // 51 definite-looking calls of one breaking name
  const calls = Array.from({ length: 51 }, (_, i) => `x${i} = helper(${i})`);
  const hBase = { 'h.py': text(['def helper(a):', '    return a']), 'callers.py': text(['from h import helper', '', ...calls]) };
  const hOurs = { ...hBase, 'h.py': text(['def helper(a, b):', '    return a']) };
  const many = await check(sv, { base: hBase, ours: hOurs, out: hOurs });
  assert.deepEqual(many.notes.filter((n) => n.kind === 'too_many_hits'), [{ path: 'h.py', line: null, kind: 'too_many_hits' }]);
  assert.deepEqual(many.incompatibleCallers, []);
  // a stoplist name
  const sBase = { 'store.py': text(['class Store:', '    def save(self):', '        return 1', '', '    def load_all(self):', '        return self.save()']) };
  const sOurs = { 'store.py': text(['class Store:', '    def load_all(self):', '        return self.save()']) };
  const stop = await check(sv, { base: sBase, ours: sOurs, out: sOurs });
  assert.deepEqual(stop.breaking.map((b) => [b.name, b.kind]), [['save', 'removed']]);
  assert.deepEqual(stop.notes, [{ path: 'store.py', line: null, kind: 'stoplist' }]);
  assert.deepEqual(stop.incompatibleCallers, []);
  // a JSON key rename
  const json = await check(sv, { base: { 'config.json': '{"a": 1}\n' }, ours: { 'config.json': '{"b": 1}\n' }, out: { 'config.json': '{"b": 1}\n' } });
  assert.deepEqual(json.notes, [{ path: 'config.json', line: null, kind: 'json_key' }]);
  assert.deepEqual(json.breaking, []);
});

test('an insertion before a unit produces no breaking entry', async () => {
  const sv = await service();
  const base = priceFiles();
  const rows = [...PRICE['pricing.py']];
  rows.splice(3, 0, 'def tax(x):', '    return x * 0.2', '');
  const ours = { ...base, 'pricing.py': text(rows) };
  const r = await check(sv, { base, ours, out: ours });
  assert.deepEqual(r.breaking, []);
  assert.deepEqual(r.symbolDelta.added, [fn('tax')]);
});

test('definite versus possible callers', async () => {
  const sv = await service();
  // Python: a same-file bare call, from-import, import + module call, self.m() in the defining class; possible: x.compute_price(…)
  const pyBase = {
    ...priceFiles(),
    'pricing.py': text([...PRICE['pricing.py'], '', '', 'def total(q):', '    return compute_price(q, 1)']),
    'misc.py': text(['def go(x):', '    return x.compute_price(1, 2)']),
    'cart.py': text(['class Cart:', '    def m(self, a):', '        return a', '', '    def use(self):', '        return self.m(1)']),
  };
  let pyOurs = withRow(pyBase, 'pricing.py', 4, CURRENCY_REQUIRED);
  pyOurs = withRow(pyOurs, 'cart.py', 2, '    def m(self, a, b):');
  const py = await check(sv, { base: pyBase, ours: pyOurs, out: pyOurs });
  assert.deepEqual(py.incompatibleCallers, [F('cart.py', 6, 'm'), F('orders.py', 5, 'compute_price'), F('pricing.py', 13, 'compute_price'), F('reports.py', 5, 'compute_price')]);
  assert.deepEqual(py.notes.filter((n) => n.kind === 'possible'), [{ path: 'misc.py', line: 2, kind: 'possible' }]);
  // TS: a named import from './total' and this.m() inside the class
  const tsBase = {
    'total.ts': text(['export function total(items) {', '  return items.length;', '}']),
    'app.ts': text(["import { total } from './total';", '', 'export const n = total([1]);']),
    'k.ts': text(['export class K {', '  m(a) {', '    return a;', '  }', '  use() {', '    return this.m(1);', '  }', '}']),
  };
  let tsOurs = withRow(tsBase, 'total.ts', 1, 'export function total(items, tax) {');
  tsOurs = withRow(tsOurs, 'k.ts', 2, '  m(a, b) {');
  const ts = await check(sv, { base: tsBase, ours: tsOurs, out: tsOurs });
  assert.deepEqual(ts.incompatibleCallers, [F('app.ts', 3, 'total'), F('k.ts', 6, 'm')]);
  // C#: inside the same type, inside another partial part of it, and Svc.Calc(…)
  const csBase = {
    'Svc.cs': text(['namespace N', '{', '    public partial class Svc', '    {', '        public int Calc(int a) { return a; }', '        public int Use() { return Calc(1); }', '    }', '}']),
    'Svc2.cs': text(['namespace N', '{', '    public partial class Svc', '    {', '        int Z() { return Calc(2); }', '    }', '}']),
    'Other.cs': text(['namespace N', '{', '    class Other', '    {', '        int W() { return Svc.Calc(3); }', '    }', '}']),
  };
  const csOurs = withRow(csBase, 'Svc.cs', 5, '        public int Calc(int a, int b) { return a + b; }');
  const cs = await check(sv, { base: csBase, ours: csOurs, out: csOurs });
  assert.deepEqual(cs.breaking.map((b) => [b.name, b.kind]), [['Calc', 'overload_gone']]);
  assert.deepEqual(cs.incompatibleCallers, [F('Other.cs', 5, 'Calc'), F('Svc.cs', 6, 'Calc'), F('Svc2.cs', 5, 'Calc')]);
});

test('hits in the definition itself, in comments and in strings are dropped, except UPPER_CASE names in strings', async () => {
  const sv = await service();
  // a recursive call inside the definition (row 5, not written by the CS), a comment and a string literal
  const pricing = [...PRICE['pricing.py']];
  pricing[4] = '    return qty * unit if qty else compute_price(1, 1)';
  const base = { 'pricing.py': text(pricing), 'orders.py': text(['from pricing import compute_price', '', '', 'def checkout(qty):', '    # compute_price(1)', '    s = "compute_price(1, 2)"', '    return s']) };
  const ours = withRow(base, 'pricing.py', 4, CURRENCY_REQUIRED);
  const r = await check(sv, { base, ours, out: ours });
  assert.deepEqual(r.incompatibleCallers, []);
  assert.deepEqual(r.notes, []);
  const cBase = { 'config.py': text(['MAX_ITEMS = 5', 'OTHER = 1']), 'use.py': text(['import config', '', '', 'def lim(cfg):', '    return getattr(cfg, "MAX_ITEMS")']) };
  const cOurs = { ...cBase, 'config.py': text(['OTHER = 1']) };
  const c = await check(sv, { base: cBase, ours: cOurs, out: cOurs });
  assert.deepEqual(c.breaking.map((b) => [b.name, b.kind]), [['MAX_ITEMS', 'removed']]);
  assert.deepEqual(c.notes, [{ path: 'use.py', line: 5, kind: 'possible' }]);
  assert.deepEqual(c.incompatibleCallers, []);
});

test('symbolDelta and referencedNames (05 §8 Q2 default)', async () => {
  const sv = await service();
  const base = priceFiles();
  const ours = { ...base, 'pricing.py': text([
    'from decimal import Decimal', "CURRENCY = 'EUR'", "CURRENCY_DEFAULT = 'EUR'", '', '', CURRENCY_REQUIRED, '    return Decimal(qty * unit) + fmt2(CURRENCY_DEFAULT)', '', '',
    'def fmt(x, rate=1):', "    return f'{x:.2f}'", '', '', 'def fmt2(x):', '    return fmt(x)',
  ]) };
  const r = await check(sv, { base, ours, out: ours, csPaths: ['pricing.py'] });
  assert.deepEqual(r.symbolDelta.added, [{ kind: 'const', qualname: 'CURRENCY_DEFAULT', simple: 'CURRENCY_DEFAULT', type: '', disc: '' }, fn('fmt2')]);
  assert.deepEqual(r.symbolDelta.signatureChanged, [fn('compute_price'), fn('fmt')]);
  assert.deepEqual(r.referencedNames.imports, ['Decimal']);
  assert.deepEqual(r.referencedNames.identifiers, ['CURRENCY_DEFAULT', 'Decimal', 'compute_price', 'currency', 'decimal', 'fmt', 'fmt2', 'qty', 'rate', 'unit', 'x']);
  for (const n of ['fmt2', 'CURRENCY_DEFAULT', 'Decimal']) assert.ok(r.referencedNames.identifiers.includes(n), n);
});

test('the caller grep is one git grep per breaking name with explicit pathspec magic', async () => {
  const spy = spyRepo();
  const sv = await service({ repo: spy.repo });
  const base = { 'pricing.py': text(PRICE['pricing.py']), 'orders.py': text(PRICE['orders.py']), 'README.md': 'compute_price is documented here\n' };
  const ours = withRow(base, 'pricing.py', 4, CURRENCY_REQUIRED);
  const outTree = await treeOf(ours);
  spy.runs.length = 0;
  spy.calls.length = 0;
  await check(sv, { base, ours, out: outTree });
  const greps = spy.runs.filter((x) => x.args[0] === 'grep');
  assert.equal(greps.length, 1);
  const g = greps[0] as { args: string[]; opts: RunOpts };
  assert.deepEqual(g.args, ['grep', '-z', '-n', '-w', '-F', '-e', 'compute_price', outTree, '--', ':(literal)orders.py', ':(literal)pricing.py']);
  assert.equal(g.opts.attrTree, S.epochBase);
  assert.deepEqual(g.opts.okCodes, [0, 1]);
  assert.ok(!('config' in g.opts), 'no RunOpts.config');
  assert.equal(g.opts.literalPathspecs, undefined);
  const call = spy.calls.find((x) => x.args === g.args);
  assert.ok(call !== undefined, 'the runner saw the grep');
  const inv = buildGitInvocation(call.args, call.opts, { hooksPath: S.f.paths.gitDir, platform: process.platform, daemonEnv: {}, testBuild: true });
  assert.equal(inv.argv.filter((a) => a === 'core.quotepath=off').length, 1, 'exactly one -c core.quotepath=off, from the forced list');
  assert.ok(inv.argv.includes(`attr.tree=${S.epochBase}`));
  assert.equal(inv.env.LC_ALL, 'C');
  assert.ok(!('GIT_LITERAL_PATHSPECS' in inv.env));
});

test('paths with *, ?, [ or a leading : stay literal in the split search', async () => {
  const spy = spyRepo();
  const sv = await service({ repo: spy.repo });
  const blob = (s: string): Promise<Oid> => S.f.repo.hashBytes(Buffer.from(s, 'utf8'), true);
  const tip = await S.f.repo.mktree([
    { name: 'a*[b].py', mode: '100644', type: 'blob', oid: await blob('x = 1\nfoo()\n') },
    { name: 'ab.py', mode: '100644', type: 'blob', oid: await blob('foo()\n') },
    { name: ':x.py', mode: '100644', type: 'blob', oid: await blob('y = 2\nz = 3\nfoo()\n') },
  ]);
  const overlay = new Map<string, BlobRef>([['a*[b].py', testSnapshot(sv.snapshots, 'a*[b].py', Buffer.from('a = 1\nb = 2\nc = 3\nfoo(1)\n', 'utf8'))]]);
  const hits = await callerHits(sv.s, sv.s.view(tip, overlay), 'foo', [':x.py', 'a*[b].py', 'ab.py'], S.epochBase, sv.s.deps.budgets.deadline('caller_grep', 4));
  assert.deepEqual(hits, [{ path: ':x.py', line: 3 }, { path: 'a*[b].py', line: 4 }, { path: 'ab.py', line: 1 }]);
  const grep = spy.runs.find((x) => x.args[0] === 'grep');
  assert.ok(grep !== undefined && grep.args.includes(':(exclude,literal)a*[b].py'), 'a literal exclude (a glob exclude would also drop ab.py)');
  assert.ok(grep.args.includes(':(literal):x.py') && grep.args.includes(':(literal)a*[b].py'));
});

/** Windows' CreateProcess command line: 32,767 UTF-16 units including its terminating NUL (libuv quotes an argument with a space,
 *  a tab or a quote, escaping quotes and the backslashes before them; the bound below is the worst case). */
const WINDOWS_CMDLINE_MAX = 32_767;
const quotedLength = (a: string): number => (a.length > 0 && !/[ \t"]/u.test(a) ? a.length : 2 * a.length + 2);
/** The runner's hooks path (test/helpers/tmp.ts emptyHooksDir), so the measured command line is the one git was given. */
const TEST_HOOKS = join(realpathSync.native(tmpdir()), 'cowork-test-empty-hooks');
function commandLineLength(call: { args: string[]; opts: GitCallOptions }): number {
  const inv = buildGitInvocation(call.args, call.opts, { hooksPath: TEST_HOOKS, platform: process.platform, daemonEnv: {}, testBuild: true });
  return ['git', ...inv.argv].reduce((n, a) => n + quotedLength(a) + 1, 0);
}

// fix r1 finding 2: the pathspecs are split by their summed (quoted) length, the excludes going with the chunk that includes their
// path (an exclude of a path the chunk does not include changes nothing), so every git command line stays under Windows' limit
test('the caller grep splits long pathspec lists so every git command line stays under the Windows limit', async (t) => {
  const spy = spyRepo();
  const sv = await service({ repo: spy.repo });
  const pad = 'p'.repeat(120);
  const stored = Array.from({ length: 150 }, (_, i) => `t_${pad}_${String(i).padStart(3, '0')}.py`);
  const replaced = Array.from({ length: 300 }, (_, i) => `o_${pad}_${String(i).padStart(3, '0')}.py`);
  const tipBlob = await S.f.repo.hashBytes(Buffer.from('x = 1\nfoo(1)\n', 'utf8'), true);
  const tip = await S.f.repo.mktree([...stored, ...replaced].map((name) => ({ name, mode: '100644' as const, type: 'blob' as const, oid: tipBlob })));
  const overlay = new Map<string, BlobRef>(replaced.map((p) => [p, testSnapshot(sv.snapshots, p, Buffer.from('foo(2)\n', 'utf8'))]));
  // the excludes alone are longer than a whole Windows command line
  assert.ok(replaced.reduce((n, p) => n + `:(exclude,literal)${p}`.length + 1, 0) > WINDOWS_CMDLINE_MAX);
  const paths = [...stored, ...replaced].sort();
  spy.calls.length = 0;
  const hits = await callerHits(sv.s, sv.s.view(tip, overlay), 'foo', paths, S.epochBase, sv.s.deps.budgets.deadline('caller_grep', 4));
  // TIP's row 2 on the stored paths, the overlay's row 1 (and never TIP's row 2) on the replaced ones
  assert.deepEqual(hits, paths.map((p) => ({ path: p, line: p.startsWith('o_') ? 1 : 2 })));
  const greps = spy.calls.filter((x) => x.args[0] === 'grep');
  assert.ok(greps.length >= 2, `several greps (${greps.length})`);
  for (const g of greps) assert.ok(commandLineLength(g) < WINDOWS_CMDLINE_MAX, `a command line of ${commandLineLength(g)} units`);
  t.diagnostic(`${greps.length} greps, longest command line ${Math.max(...greps.map(commandLineLength))} units`);
  // every searched path is included by exactly one grep, and each exclude rides with its own include
  const included = greps.flatMap((g) => g.args.filter((a) => a.startsWith(':(literal)')).map((a) => a.slice(':(literal)'.length)));
  assert.deepEqual(included.sort(), paths);
  for (const g of greps) {
    const inc = new Set(g.args.filter((a) => a.startsWith(':(literal)')).map((a) => a.slice(':(literal)'.length)));
    const exc = g.args.filter((a) => a.startsWith(':(exclude,literal)')).map((a) => a.slice(':(exclude,literal)'.length));
    assert.deepEqual(exc, [...inc].filter((p) => overlay.has(p)).sort());
  }
  // one path longer than a whole command line can never be searched: incomplete, and no git call is made
  spy.calls.length = 0;
  const huge = `${'h'.repeat(WINDOWS_CMDLINE_MAX)}.py`;
  assert.equal(await callerHits(sv.s, sv.s.view(tip), 'foo', [huge], S.epochBase, sv.s.deps.budgets.deadline('caller_grep', 4)), 'incomplete');
  assert.deepEqual(spy.calls.filter((x) => x.args[0] === 'grep'), []);
});

// fix r1 finding 2: a git failure other than an abort (a spawn failure, rc 128) is the check's incomplete result, never an exception
test('a failing git call in the check makes it incomplete, never an exception', async () => {
  const sv = await service();
  const missing = parseOid('1'.repeat(S.epochBase.length));
  // a grep on a tree that is not in the object store exits 128
  assert.equal(await callerHits(sv.s, sv.s.view(missing), 'foo', ['a.py'], S.epochBase, sv.s.deps.budgets.deadline('caller_grep', 4)), 'incomplete');
  // a grep the runner fails inside interfaceCheck (X7 inputs)
  const spy = spyRepo(async () => {
    throw new GitCommandError(['grep'], 128, Buffer.from('fatal: simulated grep failure', 'utf8'));
  });
  const failing = await service({ repo: spy.repo });
  const r = await check(failing, { base: x7('base'), ours: x7('ours'), out: await x7Out() });
  assert.deepEqual([r.incomplete, r.incompleteBudget], [true, 'caller']);
  assert.ok(spy.runs.some((x) => x.args[0] === 'grep'), 'the grep was attempted');
  // a tree read (ls-tree) that fails outside the grep
  const r2 = await check(sv, { base: x7('base'), ours: x7('ours'), out: missing });
  assert.deepEqual([r2.incomplete, r2.incompleteBudget], [true, 'caller']);
});

test('the split caller search equals a grep of a stored copy of out over 1,000 seeded trees', async () => {
  const sv = await service();
  const NAMES = ['foo', 'bar', 'baz', 'qux', 'quux', 'corge'] as const;
  const TOKENS = [...NAMES, 'x', 'foo_bar', 'xfoo', 'baz2', '\u{e9}', '(', ')', ' ', '.', '"', '#', '\r'];
  const contentArb = fc.array(fc.array(fc.constantFrom(...TOKENS), { maxLength: 6 }).map((a) => a.join('')), { minLength: 1, maxLength: 8 })
    .map((rows) => Buffer.from(`${rows.join('\n')}\n`, 'utf8'));
  const pool = [...new Map(fc.sample(contentArb, { seed: 4407, numRuns: 64 }).map((b) => [b.toString('latin1'), b])).values()];
  // every pool blob is written once, test-side, before any measurement
  const poolDir = join(S.f.paths.coworkDir, 'tmp', 'pool');
  await mkdir(poolDir, { recursive: true });
  const files = await Promise.all(pool.map(async (b, i) => {
    const p = join(poolDir, `c${i}`);
    await writeFile(p, b);
    return p;
  }));
  const hashed = (await S.f.repo.run(['hash-object', '-w', '--no-filters', '--stdin-paths'], { stdin: Buffer.from(`${files.join('\n')}\n`, 'utf8') })).stdout.toString('utf8').trim().split('\n');
  const oids = hashed.map((h) => parseOid(h));
  pool.forEach((b, i) => assert.equal(oids[i], blobIdOf(b)));
  const NORMAL = ['a.py', 'b.ts', 'c.py', 'd.ts', 'e.py', 'f.ts', 'g.py', 'h.ts', 'i.py', 'j.ts', 'ab.py', 'x1.ts'];
  const SPECIAL = ['a*[b].py', 'x[1].ts', '*.py', '[ab].py'];
  const caseArb = fc.record({
    tip: fc.uniqueArray(fc.constantFrom(...NORMAL, ...SPECIAL), { minLength: 5, maxLength: 12 }),
    contents: fc.array(fc.nat(pool.length - 1), { minLength: 12, maxLength: 12 }),
    special: fc.constantFrom(...SPECIAL),
    specialContent: fc.nat(pool.length - 1),
    size: fc.integer({ min: 1, max: 3 }),
    pick: fc.nat(),
    modContent: fc.nat(pool.length - 1),
    name: fc.constantFrom(...NAMES),
  });
  const cases = fc.sample(caseArb, { seed: 20261010, numRuns: 1_000 }).map((c) => {
    const tip = new Map(c.tip.map((p, i) => [p, c.contents[i] as number]));
    const overlay = new Map<string, number | 'ABSENT'>([[c.special, c.specialContent]]);
    const rest = c.tip.filter((p) => p !== c.special);
    if (c.size >= 2 && rest.length > 0) overlay.set(rest[c.pick % rest.length] as string, 'ABSENT');
    const normal = rest.filter((p) => !overlay.has(p));
    if (c.size === 3 && normal.length > 0) overlay.set(normal[(c.pick >> 3) % normal.length] as string, c.modContent);
    const mPrime = new Map(tip);
    for (const [p, v] of overlay) {
      if (v === 'ABSENT') mPrime.delete(p);
      else mPrime.set(p, v);
    }
    return { tip, overlay, mPrime, name: c.name };
  });
  const mktreeBatch = async (trees: ReadonlyArray<ReadonlyMap<string, number>>): Promise<Oid[]> => {
    const parts: string[] = [];
    for (const t of trees) {
      for (const [p, i] of t) parts.push(`100644 blob ${oids[i] as string}\t${p}\u{0}`);
      parts.push('\u{0}');
    }
    const r = await S.f.repo.run(['mktree', '-z', '--batch'], { stdin: Buffer.from(parts.join(''), 'utf8') });
    return r.stdout.toString('utf8').trim().split('\n').map((h) => parseOid(h));
  };
  const tipTrees = await mktreeBatch(cases.map((c) => c.tip));
  const loose = await looseObjectCount(S.f.paths.gitDir);
  const got: string[][] = [];
  for (const [i, c] of cases.entries()) {
    const overlay = new Map<string, BlobRef | 'ABSENT'>();
    for (const [p, v] of c.overlay) overlay.set(p, v === 'ABSENT' ? 'ABSENT' : testSnapshot(sv.snapshots, p, pool[v] as Buffer));
    const paths = [...c.mPrime.keys()].sort();
    const hits = await callerHits(sv.s, sv.s.view(tipTrees[i] as Oid, overlay), c.name, paths, S.epochBase, sv.s.deps.budgets.deadline('caller_grep', 4));
    assert.notEqual(hits, 'incomplete');
    got.push((hits as Array<{ path: string; line: number }>).map((h) => `${h.path}:${h.line}`).sort());
  }
  assert.equal(await looseObjectCount(S.f.paths.gitDir), loose, 'callerHits wrote no object');
  // the stored copies of M', built afterwards, and one reference grep per name over all of its cases' trees
  const mTrees = await mktreeBatch(cases.map((c) => c.mPrime));
  const want = cases.map(() => [] as string[]);
  for (const name of NAMES) {
    const idx = cases.flatMap((c, i) => (c.name === name ? [i] : []));
    if (idx.length === 0) continue;
    const trees = idx.map((i) => mTrees[i] as Oid);
    const r = await S.f.repo.run(['grep', '-z', '-n', '-w', '-F', '-e', name, ...new Set(trees)], { okCodes: [0, 1] });
    const out = r.stdout;
    let at = 0;
    while (at < out.length) {
      const nl = out.indexOf(0x0a, at);
      const rec = out.subarray(at, nl < 0 ? out.length : nl);
      at = nl < 0 ? out.length : nl + 1;
      const z1 = rec.indexOf(0);
      const z2 = rec.indexOf(0, z1 + 1);
      assert.ok(z1 > 41 && z2 > z1, `a grep record ${JSON.stringify(rec.toString('latin1'))}`);
      const tree = rec.toString('latin1', 0, 40);
      const path = rec.toString('utf8', 41, z1);
      const line = Number(rec.toString('latin1', z1 + 1, z2));
      for (const i of idx) if (mTrees[i] === tree) want[i]?.push(`${path}:${line}`);
    }
  }
  cases.forEach((c, i) => {
    assert.deepEqual(got[i], (want[i] as string[]).sort(), `case ${i}: ${c.name} over ${JSON.stringify([...c.mPrime.keys()])} with overlay ${JSON.stringify([...c.overlay])}`);
  });
});

test('wholeWordRows is the byte-wise git grep -w -F predicate', async () => {
  const rows = ['foo(x)', 'foo_bar()', 'xfoo()', '\u{e9} foo', 'foo2', 'foo'];
  const blob = Buffer.from(`${rows.join('\n')}\n`, 'utf8');
  assert.deepEqual(wholeWordRows(lineArray(blob), 'foo'), [1, 4, 6]);
  // bytes ≥ 0x80 are boundaries under LC_ALL=C (é directly before the name), a later occurrence can match after an earlier one fails
  const more = Buffer.from(`${['\u{e9}foo', 'xfoo foo', 'foox', 'foo\r'].join('\n')}\n`, 'utf8');
  assert.deepEqual(wholeWordRows(lineArray(more), 'foo'), [1, 2, 4]);
  // the same rows from git itself
  for (const b of [blob, more]) {
    const tree = await S.f.repo.mktree([{ name: 'w.py', mode: '100644', type: 'blob', oid: await S.f.repo.hashBytes(b, true) }]);
    const r = await S.f.repo.run(['grep', '-z', '-n', '-w', '-F', '-e', 'foo', tree], { okCodes: [0, 1] });
    const lines = r.stdout.toString('latin1').split('\n').filter((x) => x !== '').map((x) => Number(x.split('\u{0}')[1]));
    assert.deepEqual(wholeWordRows(lineArray(b), 'foo'), lines);
  }
});

test('over budget the check stops and returns incomplete, never a pass', async () => {
  const run = (sv: Svc, deadline?: Deadline): Promise<InterfaceResult> => x7Out().then((out) => check(sv, { base: x7('base'), ours: x7('ours'), out, ...(deadline === undefined ? {} : { deadline }) }));
  const t0 = testBudgetInjector();
  const sv1 = await service({ inject: t0 });
  t0.expire('t0', 1);
  const d1 = sv1.s.deps.budgets.deadline('t0', 4);
  assert.equal(d1.budgetMs, 2_000, 'BUDGETS.t0Ms × BUDGETS.t0StopFactor');
  const r1 = await run(sv1, d1);
  assert.equal(r1.incomplete, true);
  assert.equal(r1.incompleteBudget, 'caller');
  const ec = testBudgetInjector();
  const sv2 = await service({ inject: ec });
  ec.expire('edit_check', 1);
  const d2 = sv2.s.deps.budgets.deadline('edit_check', 1);
  assert.equal(d2.budgetMs, 500);
  const r2 = await run(sv2, d2);
  assert.deepEqual([r2.incomplete, r2.incompleteBudget], [true, 'caller']);
  // a grep whose abort fires: the spy holds the grep until the deadline has passed and its abort signal fired
  let sv3: Svc | null = null;
  const spy = spyRepo(async (opts) => {
    (sv3 as Svc).clock.advance(10_000);
    for (let i = 0; i < 1_000 && opts.abort?.aborted !== true; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(opts.abort?.aborted, true, 'the grep was aborted at the deadline');
  });
  sv3 = await service({ repo: spy.repo });
  const r3 = await run(sv3);
  assert.equal(r3.incomplete, true);
  assert.ok(spy.runs.some((x) => x.args[0] === 'grep'), 'the grep had started');
  // with no injection the X7 result is complete
  const r4 = await run(await service());
  assert.deepEqual([r4.incomplete, r4.incompleteBudget], [false, null]);
  assert.deepEqual(r4.incompatibleCallers, [F('orders.py', 14, 'foo')]);
});

test('the caller grep stops at its own 4× budget', async () => {
  const inject = testBudgetInjector();
  const spy = spyRepo();
  const sv = await service({ repo: spy.repo, inject });
  inject.expire('caller_grep', 1);
  const out = await x7Out();
  spy.runs.length = 0;
  const r = await check(sv, { base: x7('base'), ours: x7('ours'), out });
  assert.deepEqual([r.incomplete, r.incompleteBudget], [true, 'grep']);
  assert.ok(!spy.runs.some((x) => x.args[0] === 'grep'), 'the grep never started');
  assert.ok(sv.budgetCalls.some(([k, f]) => k === 'caller_grep' && f === 4), "the search's deadline is deadline('caller_grep', 4)");
  assert.equal((await service()).s.deps.budgets.deadline('caller_grep', 4).budgetMs, 600, '4 × BUDGETS.callerGrepMs');
  assert.deepEqual(sv.onBudget, [], 'interfaceCheck raises nothing itself (REGION_BUDGET is the T0 binding’s)');
  assert.deepEqual(sv.logs, []);
});

test("a WHOLE_FILE image of the CS's rows keeps the check complete and checks every caller", async () => {
  const sv = await service();
  const base = priceFiles();
  const rewrite = ['from pricing import compute_price', ...Array.from({ length: 5_996 }, (_, i) => `v_${i} = ${i}`), '', 'def checkout(amount):', '    return compute_price(amount, 2)'];
  assert.equal(rewrite.length, 6_000);
  const ours = { ...withRow(base, 'pricing.py', 4, CURRENCY_REQUIRED), 'orders.py': text(rewrite) };
  // the call row is one the CS wrote (no base row equals it), so only the WHOLE_FILE rule makes it a checked caller
  assert.ok(rowsWritten(base['orders.py'], ours['orders.py']).some(([lo, hi]) => lo <= 6_000 && 6_000 <= hi));
  const r = await check(sv, { base, ours, out: ours });
  assert.equal(r.incomplete, false);
  assert.ok(r.incompatibleCallers.some((x) => x.path === 'orders.py' && x.line === 6_000 && x.name === 'compute_price' && !x.removal), 'the call is an entry at its out row');
});

test('interfaceCheck writes nothing and reads no DiskSnapshotId oid through cat-file', async () => {
  const plain = S.f.repo;
  const outTree = await x7Out();
  const outMap = await plain.readTreeMap(outTree);
  const outBlobs = await plain.readBlobs([outMap.get('lib.py')?.oid as Oid, outMap.get('orders.py')?.oid as Oid]);
  const baseTree = await treeOf(x7('base'));
  const snapshots = new SnapshotStore();
  const sv = await service({ repo: readGuard(plain, snapshots), snapshots });
  const ours = x7('ours');
  const oursView = sv.s.view(baseTree, new Map<string, BlobRef>([['lib.py', testSnapshot(snapshots, 'lib.py', ours['lib.py'])], ['orders.py', testSnapshot(snapshots, 'orders.py', ours['orders.py'])]]));
  const outView = sv.s.view(baseTree, new Map<string, BlobRef>([['lib.py', testSnapshot(snapshots, 'lib.py', outBlobs[0] as Buffer)], ['orders.py', testSnapshot(snapshots, 'orders.py', outBlobs[1] as Buffer)]]));
  const refs = async (): Promise<string> => (await plain.run(['for-each-ref', '--format=%(refname) %(objectname)'])).stdout.toString('utf8');
  const index = async (): Promise<string> => (await readFile(join(S.f.paths.gitDir, 'index'))).toString('base64');
  const before = { loose: await looseObjectCount(S.f.paths.gitDir), refs: await refs(), index: await index() };
  const r = await check(sv, { base: x7('base'), ours, out: outTree, views: { ours: oursView, out: outView } });
  assert.deepEqual(r.incompatibleCallers, [F('orders.py', 14, 'foo')], 'the same verdict from the split search');
  assert.equal(r.incomplete, false);
  assert.equal(await looseObjectCount(S.f.paths.gitDir), before.loose, 'no object written');
  assert.equal(await refs(), before.refs, 'no ref changed');
  assert.equal(await index(), before.index, 'no index file changed');
});

test('every InterfaceResult field is filled', async () => {
  const sv = await service();
  const outTree = await x7Out();
  const r = await check(sv, { base: x7('base'), ours: x7('ours'), out: outTree });
  assert.deepEqual(Object.keys(r).sort(), ['breaking', 'incompatibleCallers', 'incomplete', 'incompleteBudget', 'notes', 'orphanCalls', 'referencedNames', 'symbolDelta', 'unresolvedImports']);
  assert.deepEqual(Object.keys(r.symbolDelta).sort(), ['added', 'signatureChanged']);
  assert.deepEqual(Object.keys(r.referencedNames).sort(), ['identifiers', 'imports']);
  const outMap = await S.f.repo.readTreeMap(outTree);
  for (const f of [...r.incompatibleCallers, ...r.orphanCalls, ...r.unresolvedImports]) {
    const e = outMap.get(f.path);
    assert.ok(e !== undefined, f.path);
    const rows = lineArray(await S.f.repo.readBlob(e.oid)).length;
    assert.ok(Number.isInteger(f.line) && f.line >= 1 && f.line <= rows, `${f.path}:${f.line} is a row of out`);
  }
  assert.ok(r.incompatibleCallers.length > 0);
});
