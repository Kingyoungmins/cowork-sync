// The ABI spike (R4-10; Plan 4 Task 1's first commit): every pinned grammar loads into the pinned
// web-tree-sitter runtime and parses one snippet per language; the pinned versions are exact and
// equal package-lock.json. A failure here stops the task for a controller ruling (another 0.27.x
// patch or grammar version, never a second parser, REG-03).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GRAMMAR_VERSIONS, LANGUAGES } from '../../src/regions/runtime.js';
import type { Language } from '../../src/regions/types.js';
import { initParser } from '../../src/regions/worker/parser.js';
import { testRegionRuntime, testWorkerInit } from '../helpers/regionRuntime.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/** One clean snippet per language, its expected root node type and a broken variant (one closing token deleted). */
const SPIKE: Readonly<Record<Language, { root: string; clean: string; broken: string }>> = {
  // A 12-row file: `import os`, a decorated function, a class with one method.
  python: {
    root: 'module',
    clean: [
      'import os',
      '',
      '',
      '@decorator',
      'def compute(a, b):',
      '    total = a + b',
      '    return total',
      '',
      '',
      'class Box:',
      '    def size(self):',
      '        return os.sep',
      '',
    ].join('\n'),
    broken: [
      'import os',
      '',
      '',
      '@decorator',
      'def compute(a, b:',
      '    total = a + b',
      '    return total',
      '',
      '',
      'class Box:',
      '    def size(self):',
      '        return os.sep',
      '',
    ].join('\n'),
  },
  // A class with get/set accessors and an arrow const.
  javascript: {
    root: 'program',
    clean: 'class Box {\n  get size() { return this._size; }\n  set size(v) { this._size = v; }\n}\nconst double = (x) => x * 2;\n',
    broken: 'class Box {\n  get size() { return this._size; }\n  set size(v) { this._size = v; }\n\nconst double = (x) => x * 2;\n',
  },
  // An interface, two overload signatures plus the implementation, an enum.
  typescript: {
    root: 'program',
    clean: 'interface Shape { area(): number; }\nfunction scale(x: number): number;\nfunction scale(x: string): string;\n'
      + 'function scale(x: any): any { return x; }\nenum Color { Red, Green }\n',
    broken: 'interface Shape { area(): number; }\nfunction scale(x: number): number;\nfunction scale(x: string): string;\n'
      + 'function scale(x: any): any { return x; }\nenum Color { Red, Green \n',
  },
  // A function component returning JSX.
  tsx: {
    root: 'program',
    clean: 'function Hello(props: { name: string }) {\n  return <div className="hello">{props.name}</div>;\n}\n',
    broken: 'function Hello(props: { name: string }) {\n  return <div className="hello">{props.name}</div>;\n\n',
  },
  // A namespace, a class with Calc(int) and Calc(double), a property and a constructor.
  c_sharp: {
    root: 'compilation_unit',
    clean: [
      'namespace Shop',
      '{',
      '    public class Pricing',
      '    {',
      '        public Pricing() { }',
      '        public int Total { get; set; }',
      '        public int Calc(int a) { return a; }',
      '        public double Calc(double a) { return a; }',
      '    }',
      '}',
      '',
    ].join('\n'),
    broken: [
      'namespace Shop',
      '{',
      '    public class Pricing',
      '    {',
      '        public Pricing() { }',
      '        public int Total { get; set; }',
      '        public int Calc(int a) { return a; }',
      '        public double Calc(double a) { return a; }',
      '    }',
      '',
    ].join('\n'),
  },
};

test('every pinned grammar loads and parses its spike snippet', async () => {
  const runtime = await testRegionRuntime();
  const host = await initParser(testWorkerInit(runtime));
  assert.deepEqual(
    Object.fromEntries(host.availability()),
    { python: 'ok', javascript: 'ok', typescript: 'ok', tsx: 'ok', c_sharp: 'ok' },
  );
  assert.equal(SPIKE.python.clean.split('\n').length - 1, 12, 'the python snippet is a 12-row file');
  for (const lang of LANGUAGES) {
    const s = SPIKE[lang];
    const clean = host.parse(lang, Buffer.from(s.clean, 'utf8'), `${lang}:clean`, null);
    assert.ok(typeof clean === 'object', `${lang}: the clean snippet did not parse (${String(clean)})`);
    assert.equal(clean.rootNode.type, s.root, `${lang}: root node type`);
    assert.equal(clean.rootNode.hasError, false, `${lang}: hasError on the clean snippet`);
    const broken = host.parse(lang, Buffer.from(s.broken, 'utf8'), `${lang}:broken`, null);
    assert.ok(typeof broken === 'object', `${lang}: the broken snippet did not parse (${String(broken)})`);
    assert.equal(broken.rootNode.hasError, true, `${lang}: no hasError on the broken snippet`);
  }
});

test('the pinned versions are exact and equal package-lock.json', () => {
  assert.match(GRAMMAR_VERSIONS['web-tree-sitter'], /^0\.27\.\d+$/);
  const lock = JSON.parse(readFileSync(`${repoRoot}package-lock.json`, 'utf8')) as {
    packages: Record<string, { version?: string }>;
  };
  const pkg = JSON.parse(readFileSync(`${repoRoot}package.json`, 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const packageOf: Readonly<Record<keyof typeof GRAMMAR_VERSIONS, string>> = {
    'web-tree-sitter': 'web-tree-sitter',
    python: 'tree-sitter-python',
    javascript: 'tree-sitter-javascript',
    typescript: 'tree-sitter-typescript',
    tsx: 'tree-sitter-typescript',
    c_sharp: 'tree-sitter-c-sharp',
  };
  assert.deepEqual(Object.keys(GRAMMAR_VERSIONS).sort(), Object.keys(packageOf).sort());
  for (const [key, name] of Object.entries(packageOf) as [keyof typeof GRAMMAR_VERSIONS, string][]) {
    assert.equal(GRAMMAR_VERSIONS[key], lock.packages[`node_modules/${name}`]?.version, `${key} vs package-lock ${name}`);
  }
  assert.equal(GRAMMAR_VERSIONS.typescript, GRAMMAR_VERSIONS.tsx, 'typescript and tsx come from one package');
  for (const name of new Set(Object.values(packageOf))) {
    const declared = pkg.devDependencies?.[name];
    assert.ok(declared !== undefined, `${name} is a devDependency`);
    assert.match(declared, /^\d+\.\d+\.\d+$/, `${name}: a bare exact version (no ^, ~, range or tag)`);
    assert.equal(declared, lock.packages[`node_modules/${name}`]?.version, `${name}: package.json equals package-lock.json`);
    assert.equal(pkg.dependencies?.[name], undefined, `${name} is not a runtime dependency`);
  }
});
