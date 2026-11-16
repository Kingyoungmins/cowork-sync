// The interface classifier's pure parts (Plan 4 Task 7; 04 §3.10 "Signature slices", "Classes", "Note-only cases"; REG-26,
// R1-079, R1-140, R1-141, R1-146, contract addition 3). Slices come from real parses of the pinned grammars (RegionService.table
// over inlineWorkers, DiskSnapshotIds); classification compares base and ours units, never edits.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { CALLER_STOPLIST, MAX_HITS_PER_NAME, arityCompatible, classifyUnit, jsonKeyPaths } from '../../src/regions/interface.js';
import { interfaceCheck } from '../../src/regions/interfaceService.js';
import { hunks, normalizeRanges } from '../../src/regions/mapper.js';
import { lineArray } from '../../src/regions/lines.js';
import type { Label, ParamSlice, RegionTable, SigSlice, TableOrNone, Unit } from '../../src/regions/types.js';
import { UNIT_EPOCH_BASE, unitService, type UnitService } from '../helpers/regionUnitService.js';

let u: UnitService;
before(async () => {
  u = await unitService();
});
after(async () => {
  await u.close();
});

const src = (rows: readonly string[]): Buffer => Buffer.from(`${rows.join('\n')}\n`, 'utf8');
const isTable = (t: TableOrNone): t is RegionTable => !('kind' in t);

async function tableOf(path: string, rows: readonly string[]): Promise<RegionTable> {
  const t = await u.table(path, src(rows));
  assert.ok(isTable(t) && t.grammar !== null, `${path} has a symbol table`);
  return t;
}

/** The unit (not a class residue) whose qualname is q (and, when given, whose disc is d). */
async function unitOf(path: string, rows: readonly string[], q: string, d?: string): Promise<Unit> {
  const t = await tableOf(path, rows);
  const hit = t.units.find((x) => !x.residue && x.label.qualname === q && (d === undefined || x.label.disc === d));
  assert.ok(hit !== undefined, `${path}: a unit ${q}${d ?? ''}`);
  return hit;
}

const P = (name: string, kind: ParamSlice['kind'], o: { hasDefault?: boolean; default?: string; destructured?: string[]; type?: string } = {}): ParamSlice => ({
  name, kind, hasDefault: o.hasDefault ?? o.default !== undefined, destructured: o.destructured ?? null, type: o.type ?? null, ...(o.default === undefined ? {} : { default: o.default }),
});

test('sigSlice: Python function, class and module slices', async () => {
  const f = await unitOf('m.py', ['@cache', 'def f(a, /, b, c=1, *args, d, e=2, **kw) -> int:', '    return a'], 'f');
  assert.deepEqual(f.sigSlice, {
    lang: 'python', unit: 'function',
    params: [P('a', 'posonly'), P('b', 'pos'), P('c', 'pos', { default: '1' }), P('args', 'varargs'), P('d', 'kwonly'), P('e', 'kwonly', { default: '2' }), P('kw', 'varkw')],
    decorators: ['cache'], returns: 'int',
  });
  const cartRows = ['class Cart(Base, Mixin):', '    TAX = 0.2', '', '    def add(self, item):', '        self.items.append(item)', '', '    def total(self):', '        return 0'];
  const cartTable = await tableOf('cart.py', cartRows);
  const cartSlice: SigSlice = { lang: 'python', unit: 'class', bases: ['Base', 'Mixin'], methods: ['add', 'total'], assignments: ['TAX'] };
  const cartUnits = cartTable.units.filter((x) => x.label.qualname === 'Cart');
  assert.equal(cartUnits.length, 2, 'the class unit and its residue');
  for (const x of cartUnits) assert.deepEqual(x.sigSlice, cartSlice, `${x.residue ? 'the residue' : 'the class unit'} carries the class slice`);
  const mod = await tableOf('mod.py', ["__all__ = ['f', 'g']", 'MAX_ITEMS = 5', 'helper_x = 1', '', '', 'def f():', '    return MAX_ITEMS', '', '', 'def g():', '    return helper_x']);
  const all = mod.units.find((x) => x.label.qualname === '__all__');
  assert.ok(all !== undefined && all.kind === 'const');
  assert.deepEqual(all.sigSlice, { lang: 'python', unit: 'module', all: ['f', 'g'], upperNames: ['MAX_ITEMS'] });
  const max = mod.units.find((x) => x.label.qualname === 'MAX_ITEMS');
  assert.ok(max !== undefined && max.kind === 'const', 'MAX_ITEMS is a const unit of its own (R4-19)');
  assert.equal(max.sigSlice, null);
});

test('sigSlice: JS/TS and C# slices', async () => {
  const total = await unitOf('t.ts', ['export function total(items, {tax, discount} = {}, ...rest) {', '  return 0;', '}'], 'total');
  assert.deepEqual(total.sigSlice, {
    lang: 'typescript',
    params: [P('items', 'plain'), P('', 'plain', { destructured: ['tax', 'discount'], default: '{}' }), P('rest', 'rest')],
    exported: true, exportName: 'total', members: [],
  });
  const cart = await unitOf('c.ts', ['export class Cart {', '  add() {}', '  get size() { return 0; }', '}'], 'Cart');
  assert.deepEqual(cart.sigSlice, { lang: 'typescript', params: null, exported: true, exportName: 'Cart', members: ['add', 'size'] });
  const svc = ['class Svc', '{', '    public static decimal Calc(int a, ref decimal b, out int c, params int[] rest)', '    {', '        c = a;', '        return b;', '    }', '',
    '    public int Count { get; }', '', '    private void Hidden(int x = 3) { }', '}'];
  const calc = await unitOf('Svc.cs', svc, 'Svc.Calc');
  assert.deepEqual(calc.sigSlice, {
    lang: 'c_sharp', isPrivate: false, modifiers: ['public', 'static'], returns: 'decimal',
    params: [P('a', 'plain', { type: 'int' }), P('b', 'ref', { type: 'decimal' }), P('c', 'out', { type: 'int' }), P('rest', 'params', { type: 'int[]' })],
    memberType: null, overloadKey: 'Svc\u{0}Calc',
  });
  const count = await unitOf('Svc.cs', svc, 'Svc.Count');
  assert.deepEqual(count.sigSlice, { lang: 'c_sharp', isPrivate: false, modifiers: ['public'], returns: null, params: [], memberType: 'int', overloadKey: 'Svc\u{0}Count' });
  const hidden = await unitOf('Svc.cs', svc, 'Svc.Hidden');
  assert.ok(hidden.sigSlice !== null && hidden.sigSlice.lang === 'c_sharp' && hidden.sigSlice.isPrivate, 'a private method');
  assert.deepEqual(hidden.sigSlice.params, [P('x', 'plain', { type: 'int', default: '3' })]);
});

test('jsonKeyPaths returns sorted dot paths with [] for array elements, null for invalid JSON', () => {
  assert.deepEqual(jsonKeyPaths(Buffer.from('{"a":{"b":1},"c":[{"d":2}]}', 'utf8')), ['a', 'a.b', 'c', 'c[].d']);
  assert.equal(jsonKeyPaths(Buffer.from('{', 'utf8')), null);
  assert.equal(jsonKeyPaths(Buffer.from([0x7b, 0xff, 0x7d])), null, 'not UTF-8');
});

const py = (sig: string, body = '    return 1'): string[] => [`def ${sig}:`, body];
const BREAKING = (kind: string): { cls: 'breaking'; breaking: string } => ({ cls: 'breaking', breaking: kind });
const COMPATIBLE = { cls: 'compatible', breaking: null } as const;
const NOTE = { cls: 'note', breaking: null } as const;

test('classifyUnit: the breaking kinds per language', async () => {
  const fab = await unitOf('m.py', py('f(a, b)'), 'f');
  assert.deepEqual(classifyUnit(fab, null), BREAKING('removed'));
  assert.deepEqual(classifyUnit(fab, await unitOf('m.py', py('f(a)'), 'f')), BREAKING('param_removed'));
  assert.deepEqual(classifyUnit(fab, await unitOf('m.py', py('f(b, a)'), 'f')), BREAKING('param_reordered'));
  assert.deepEqual(classifyUnit(fab, await unitOf('m.py', py('f(a, c)'), 'f')), BREAKING('param_renamed'));
  assert.deepEqual(classifyUnit(await unitOf('m.py', py('f(a)'), 'f'), await unitOf('m.py', py('f(a, b)'), 'f')), BREAKING('required_added'));
  const fa = await unitOf('m.py', py('f(a)'), 'f');
  assert.deepEqual(classifyUnit(await unitOf('m.py', py('f(a, *args)'), 'f'), fa), BREAKING('varargs_removed'));
  assert.deepEqual(classifyUnit(await unitOf('m.py', py('f(a, **kw)'), 'f'), fa), BREAKING('varargs_removed'));
  const exported = await unitOf('t.ts', ['export function total(items) {', '  return 0;', '}'], 'total');
  const local = await unitOf('t.ts', ['function total(items) {', '  return 0;', '}'], 'total');
  assert.deepEqual(classifyUnit(exported, local), BREAKING('removed'), 'the export removed');
  assert.deepEqual(classifyUnit(local, await unitOf('t.ts', ['function total(items, tax) {', '  return 0;', '}'], 'total')), BREAKING('required_added'));
  const calc1 = await unitOf('S.cs', ['class Svc', '{', '    public int Calc(int a) { return a; }', '}'], 'Svc.Calc');
  const calc2 = await unitOf('S.cs', ['class Svc', '{', '    public int Calc(int a, int b) { return a; }', '}'], 'Svc.Calc');
  assert.deepEqual(classifyUnit(calc1, calc2), BREAKING('overload_gone'), 'the sole overload no longer accepts the old calls');
});

test('classifyUnit: compatible and note', async () => {
  const fa = await unitOf('m.py', py('f(a)'), 'f');
  assert.deepEqual(classifyUnit(fa, await unitOf('m.py', py('f(a)', '    return 2'), 'f')), COMPATIBLE, 'body-only');
  assert.deepEqual(classifyUnit(fa, await unitOf('m.py', py('f(a, b=1)'), 'f')), COMPATIBLE);
  assert.deepEqual(classifyUnit(fa, await unitOf('m.py', py('f(a, *, k=None)'), 'f')), COMPATIBLE);
  const t1 = await unitOf('t.ts', ['function total(items) {', '  return 0;', '}'], 'total');
  assert.deepEqual(classifyUnit(t1, await unitOf('t.ts', ['function total(items, tax = 0) {', '  return 0;', '}'], 'total')), COMPATIBLE);
  const both = ['class Svc', '{', '    public int Calc(int a) { return a; }', '    public int Calc(int a, int b) { return a + b; }', '}'];
  const calcOld = await unitOf('S.cs', ['class Svc', '{', '    public int Calc(int a) { return a; }', '}'], 'Svc.Calc');
  assert.deepEqual(classifyUnit(calcOld, await unitOf('S.cs', both, 'Svc.Calc', '(int)')), COMPATIBLE, 'the old overload is unchanged');
  assert.deepEqual(classifyUnit(null, await unitOf('S.cs', both, 'Svc.Calc', '(int,int)')), COMPATIBLE, 'an added overload');
  const h1 = await unitOf('S.cs', ['class Svc', '{', '    private int H(int a) { return a; }', '}'], 'Svc.H');
  const h2 = await unitOf('S.cs', ['class Svc', '{', '    private int H(int a, int b) { return a; }', '}'], 'Svc.H');
  assert.deepEqual(classifyUnit(h1, h2), COMPATIBLE, 'a changed private C# method');
  assert.deepEqual(classifyUnit(null, fa), COMPATIBLE);
  assert.deepEqual(classifyUnit(await unitOf('m.py', ['@cache', ...py('f(a)')], 'f'), await unitOf('m.py', ['@lru_cache', ...py('f(a)')], 'f')), NOTE, 'a decorator change');
  assert.deepEqual(classifyUnit(await unitOf('m.py', py('f(a, b=1)'), 'f'), await unitOf('m.py', py('f(a, b=2)'), 'f')), NOTE, 'a default-value change');
});

/** interfaceCheck over in-memory views (no stored tree, so no git): one path, base → ours, out = ours. */
async function checkOne(path: string, base: readonly string[], ours: readonly string[]) {
  const b = src(base);
  const o = src(ours);
  const view = (bytes: Buffer) => u.s.view(null, new Map([[path, u.snap(path, bytes)]]));
  const rows = normalizeRanges(hunks(lineArray(b), lineArray(o)).filter((h) => h.bLo <= h.bHi).map((h) => [h.bLo, h.bHi] as const));
  return interfaceCheck(u.s, { base: view(b), ours: view(o), out: view(o), csPaths: [path], csRows: new Map([[path, rows]]), epochBase: UNIT_EPOCH_BASE }, u.s.deps.budgets.deadline('t0', 4));
}

const PRICING = ["CURRENCY = 'EUR'", '', '', 'def compute_price(qty, unit):', '    return qty * unit', '', '', 'def fmt(x):', "    return f'{x:.2f}'"];

test('a rename is a removal plus an addition', async () => {
  const renamed = PRICING.map((r) => r.replace('compute_price', 'calc_price'));
  const before = await unitOf('pricing.py', PRICING, 'compute_price');
  const afterU = await unitOf('pricing.py', renamed, 'calc_price');
  assert.deepEqual(classifyUnit(before, null), BREAKING('removed'));
  assert.deepEqual(classifyUnit(null, afterU), COMPATIBLE);
  const r = await checkOne('pricing.py', PRICING, renamed);
  const label: Label = { kind: 'function', qualname: 'compute_price', simple: 'compute_price', type: '', disc: '' };
  assert.deepEqual(r.breaking, [{ path: 'pricing.py', label, name: 'compute_price', kind: 'removed', removal: true }]);
  assert.deepEqual(r.symbolDelta.added, [afterU.label]);
  assert.equal(r.incomplete, false);
});

// fix r1 finding 1: 04 §3.10 "breaking: a unit or export removed" — a name that survives only as another kind of unit (a value,
// a class, a property) is the old unit removed, never a compatible change (P2); two JS/TS callables (a function declaration and a
// const bound to a function, Task 4's const kind) still compare by their parameter lists
test('classifyUnit: a name that survives as another kind of unit is the old unit removed', async () => {
  const asValue = PRICING.map((r, i) => (i === 3 ? 'compute_price = make_pricer()' : i === 4 ? '' : r));
  const asClass = PRICING.map((r, i) => (i === 3 ? 'class compute_price:' : i === 4 ? '    pass' : r));
  const def = await unitOf('pricing.py', PRICING, 'compute_price');
  const value = await unitOf('pricing.py', asValue, 'compute_price');
  const cls = await unitOf('pricing.py', asClass, 'compute_price');
  assert.deepEqual([def.kind, value.kind, cls.kind], ['function', 'const', 'class']);
  assert.deepEqual(classifyUnit(def, value), BREAKING('removed'), 'a function that became a value');
  assert.deepEqual(classifyUnit(def, cls), BREAKING('removed'), 'a function that became a class');
  const label: Label = { kind: 'function', qualname: 'compute_price', simple: 'compute_price', type: '', disc: '' };
  for (const ours of [asValue, asClass]) {
    const r = await checkOne('pricing.py', PRICING, ours);
    assert.deepEqual(r.breaking, [{ path: 'pricing.py', label, name: 'compute_price', kind: 'removed', removal: true }]);
    assert.equal(r.incomplete, false);
  }
  // C#: a parameterless method that became a property of the same name (same overload key, no call accepts it any more)
  const svc = (member: string): string[] => ['class Svc', '{', `    ${member}`, '}'];
  const method = await unitOf('S.cs', svc('public int Count() { return 0; }'), 'Svc.Count');
  const prop = await unitOf('S.cs', svc('public int Count { get; }'), 'Svc.Count');
  assert.deepEqual([method.kind, prop.kind], ['method', 'property']);
  assert.deepEqual(classifyUnit(method, prop), BREAKING('removed'));
  const cs = await checkOne('S.cs', svc('public int Count() { return 0; }'), svc('public int Count { get; }'));
  assert.deepEqual(cs.breaking.map((b) => [b.name, b.kind, b.removal]), [['Count', 'removed', true]]);
  // JS/TS: a function declaration and a const bound to an arrow are both callables (compared by parameters), a class and a const
  // bound to a class expression are both classes; a function and a class are not the same shape
  const fnDecl = await unitOf('t.ts', ['export function total(items) {', '  return 0;', '}'], 'total');
  const arrow = await unitOf('t.ts', ['export const total = (items) => 0;'], 'total');
  const clsTs = await unitOf('t.ts', ['export class total {', '  add() {}', '}'], 'total');
  const clsConst = await unitOf('t.ts', ['export const total = class {', '  add() {}', '};'], 'total');
  assert.deepEqual([fnDecl.kind, arrow.kind, clsTs.kind, clsConst.kind], ['function', 'const', 'class', 'const']);
  assert.deepEqual(classifyUnit(fnDecl, arrow), COMPATIBLE, 'the same parameters');
  assert.deepEqual(classifyUnit(arrow, fnDecl), COMPATIBLE);
  assert.deepEqual(classifyUnit(fnDecl, await unitOf('t.ts', ['export const total = (items, tax) => 0;'], 'total')), BREAKING('required_added'));
  assert.deepEqual(classifyUnit(clsTs, clsConst), COMPATIBLE, 'a class and a class-valued const');
  assert.deepEqual(classifyUnit(fnDecl, clsTs), BREAKING('removed'), 'a function that became a class');
  assert.deepEqual(classifyUnit(arrow, clsConst), BREAKING('removed'), 'a function-valued const that became a class-valued one');
  const tsFn = ['export function total(items) {', '  return 0;', '}'];
  assert.deepEqual((await checkOne('t.ts', tsFn, ['export const total = (items) => 0;'])).breaking, []);
  assert.deepEqual((await checkOne('t.ts', tsFn, ['export class total {', '  add() {}', '}'])).breaking.map((b) => [b.name, b.kind, b.removal]), [['total', 'removed', true]]);
  // a const bound to a call is no unit at all (Task 4's table), so the function is removed with no successor
  assert.deepEqual((await checkOne('t.ts', tsFn, ['export const total = makeTotal();'])).breaking.map((b) => [b.name, b.kind, b.removal]), [['total', 'removed', true]]);
});

// fix r1 finding 3: 04 §3.10's JS/TS slice row and its breaking list say nothing about TypeScript overload sets (REG-17 is the
// claim-touch rule), so this pins the current reading: an overload set's unit carries no parameter list (its implementation
// signature is not callable), a changed overload signature is compatible and arity never refutes a call of it; its export status
// still counts
test('a TS overload set carries no parameter list: a changed overload signature is compatible (pinned; 04 §3.10 is silent)', async () => {
  const set = (sigs: readonly string[], impl: string, exp = 'export '): string[] => [...sigs.map((x) => `${exp}function f(${x}): void;`), `${exp}function f(${impl}) {`, '  return;', '}'];
  const before = await unitOf('o.ts', set(['a: string', 'a: number'], 'a: any'), 'f');
  assert.equal(before.label.disc, 'overload');
  assert.deepEqual(before.sigSlice, { lang: 'typescript', params: null, exported: true, exportName: 'f', members: [] });
  const changed = await unitOf('o.ts', set(['a: string, b: string', 'a: number'], 'a: any, b?: any'), 'f');
  assert.deepEqual(classifyUnit(before, changed), COMPATIBLE, 'a new required parameter in one overload');
  const fewer = await unitOf('o.ts', set(['a: string', 'a: number, b: number'], 'a: any, b?: any'), 'f');
  assert.deepEqual(classifyUnit(before, fewer), COMPATIBLE);
  assert.equal(arityCompatible('typescript', [before.sigSlice as SigSlice], { positional: 7, keywords: [], splat: false }), true, 'arity never refutes an overload set');
  assert.deepEqual(classifyUnit(before, await unitOf('o.ts', set(['a: string', 'a: number'], 'a: any', ''), 'f')), BREAKING('removed'), 'the export removed');
  // a plain function that becomes an overload set (disc '' → 'overload') is still a callable of the same name, not a removal
  assert.deepEqual((await checkOne('o.ts', ['export function f(a: any) {', '  return;', '}'], set(['a: string', 'a: number'], 'a: any'))).breaking, []);
});

test('classification is net over the CS, base versus ours, never per edit', async () => {
  const base = ['def f(a, b):', '    return a + b'];
  const intermediate = ['def f(a):', '    return a'];   // a state of the CS that is never passed to the check
  assert.deepEqual(classifyUnit(await unitOf('n.py', base, 'f'), await unitOf('n.py', intermediate, 'f')), BREAKING('param_removed'));
  const r = await checkOne('n.py', base, ['def f(a, b):', '    return a * b']);
  assert.deepEqual(r.breaking, []);
  assert.deepEqual(r.symbolDelta, { added: [], signatureChanged: [] });
});

test('CALLER_STOPLIST and MAX_HITS_PER_NAME', () => {
  assert.deepEqual([...CALLER_STOPLIST].sort(), ['__init__', 'close', 'get', 'init', 'load', 'main', 'run', 'save', 'set', 'update']);
  assert.equal(CALLER_STOPLIST.size, 10);
  assert.equal(MAX_HITS_PER_NAME, 50);
});
