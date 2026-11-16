// Arity compatibility (Plan 4 Task 7; 04 §3.10 "Arity compatibility"; REG-27, R1-145) over signature slices from real parses
// (RegionService.table over inlineWorkers with the pinned grammars).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { arityCompatible, type CallArgs } from '../../src/regions/interface.js';
import type { RegionTable, SigSlice, TableOrNone } from '../../src/regions/types.js';
import { unitService, type UnitService } from '../helpers/regionUnitService.js';

let u: UnitService;
before(async () => {
  u = await unitService();
});
after(async () => {
  await u.close();
});

const isTable = (t: TableOrNone): t is RegionTable => !('kind' in t);

/** The slices of every non-residue unit named `simple` in a parsed file. */
async function slicesOf(path: string, rows: readonly string[], simple: string): Promise<SigSlice[]> {
  const t = await u.table(path, Buffer.from(`${rows.join('\n')}\n`, 'utf8'));
  assert.ok(isTable(t) && t.grammar !== null, path);
  const out = t.units.filter((x) => !x.residue && x.label.simple === simple).map((x) => x.sigSlice);
  assert.ok(out.length > 0 && out.every((s) => s !== null), `${path}: slices of ${simple}`);
  return out as SigSlice[];
}

const call = (positional: number, keywords: string[] = [], splat = false): CallArgs => ({ positional, keywords, splat });

test('Python arity: required positional, surplus positional, keywords, splats', async () => {
  const f = await slicesOf('a.py', ['def f(a, b, c=1, *, k, m=2):', '    return a'], 'f');
  assert.equal(arityCompatible('python', f, call(2, ['k'])), true);
  assert.equal(arityCompatible('python', f, call(1, ['k'])), false, 'b missing');
  assert.equal(arityCompatible('python', f, call(0, ['a', 'b', 'k'])), true);
  assert.equal(arityCompatible('python', f, call(4, ['k'])), false, 'no *args');
  assert.equal(arityCompatible('python', f, call(2, ['k', 'z'])), false, 'no **kwargs');
  assert.equal(arityCompatible('python', f, call(0, [], true)), 'note', 'f(*xs)');
  assert.equal(arityCompatible('python', f, call(2, [], true)), 'note', 'f(1, 2, **opts)');
  const g = await slicesOf('a.py', ['def g(a, *args, **kw):', '    return a'], 'g');
  assert.equal(arityCompatible('python', g, call(3, ['z'])), true);
  // a keyword naming a parameter already bound positionally, and a positional-only parameter passed by keyword
  assert.equal(arityCompatible('python', f, call(2, ['a', 'k'])), false, 'a given twice');
  const po = await slicesOf('a.py', ['def h(a, /, b):', '    return a'], 'h');
  assert.equal(arityCompatible('python', po, call(0, ['a', 'b'])), false, 'a is positional-only');
});

test('JS/TS arity: required ≤ count ≤ max without rest', async () => {
  const t = await slicesOf('a.ts', ['function t(a, b = 1) {', '  return a;', '}'], 't');
  assert.equal(arityCompatible('typescript', t, call(0)), false);
  assert.equal(arityCompatible('typescript', t, call(1)), true);
  assert.equal(arityCompatible('typescript', t, call(2)), true);
  assert.equal(arityCompatible('typescript', t, call(3)), false);
  const r = await slicesOf('a.ts', ['function u(a, ...r) {', '  return a;', '}'], 'u');
  assert.equal(arityCompatible('typescript', r, call(4)), true);
  assert.equal(arityCompatible('typescript', t, call(0, [], true)), 'note', 't(...xs)');
  const js = await slicesOf('a.js', ['function t(a, b = 1) {', '  return a;', '}'], 't');
  assert.equal(arityCompatible('javascript', js, call(3)), false);
});

test('C# arity: some overload covers the count and every named argument', async () => {
  const two = ['class Svc', '{', '    public int Calc(int a) { return a; }', '    public int Calc(int a, int b, int c = 0) { return a + b + c; }', '}'];
  const calc = await slicesOf('S.cs', two, 'Calc');
  assert.equal(calc.length, 2);
  assert.equal(arityCompatible('c_sharp', calc, call(1)), true);
  assert.equal(arityCompatible('c_sharp', calc, call(2)), true);
  assert.equal(arityCompatible('c_sharp', calc, call(3)), true);
  assert.equal(arityCompatible('c_sharp', calc, call(0, ['b', 'a'])), true);
  assert.equal(arityCompatible('c_sharp', calc, call(4)), false);
  assert.equal(arityCompatible('c_sharp', calc, call(0, ['a', 'd'])), false);
  const withParams = await slicesOf('S.cs', [...two.slice(0, 4), '    public int Calc(int a, params int[] rest) { return a; }', '}'], 'Calc');
  assert.equal(withParams.length, 3);
  assert.equal(arityCompatible('c_sharp', withParams, call(4)), true);
  assert.equal(arityCompatible('c_sharp', calc, call(1)), true, 'types are not checked: Calc("x")');
});
