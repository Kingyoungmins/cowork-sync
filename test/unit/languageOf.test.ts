// R4-16: the language of a path is the byte-exact lowercase extension of its last component (R1-071, OQ-27).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { languageOf } from '../../src/regions/runtime.js';

test('languageOf maps the byte-exact lowercase extension of the last component', () => {
  const expected: ReadonlyArray<readonly [string, string | null]> = [
    ['a.py', 'python'], ['pkg/a.pyi', 'python'],
    ['a.js', 'javascript'], ['a.mjs', 'javascript'], ['a.cjs', 'javascript'], ['a.jsx', 'javascript'],
    ['a.ts', 'typescript'], ['a.mts', 'typescript'], ['a.cts', 'typescript'], ['types/a.d.ts', 'typescript'],
    ['a.tsx', 'tsx'], ['src/x.test.tsx', 'tsx'],
    ['Svc.cs', 'c_sharp'],
    ['Foo.PY', null], ['a.Py', null], ['a.TS', null], ['a.pyw', null], ['a.md', null], ['a.ipynb', null], ['Makefile', null],
    ['.py', null],          // a dotfile has no extension (path.posix.extname semantics)
    ['dir.py/README', null], // last component only
  ];
  for (const [path, lang] of expected) assert.equal(languageOf(path), lang, path);
});
