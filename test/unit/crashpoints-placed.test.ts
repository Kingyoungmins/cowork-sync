// 01-engine test 52 (ENG-59; TST-06; L-CRASHPOINTS): the crashpoints Plan 2 places — the 13 names of ENG-59 plus
// registry.cas (HLD-01, two call sites) — are crashpoint() call sites in src/, exactly those, and every one is in
// test/crashpoints.json. The kill matrix over them is test/integration/sim.crash.test.ts (01-engine test 26).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { lintCrashpoints } from '../../tools/lint/rules.js';
import { PLAN2_CRASHPOINTS } from '../helpers/plan2Crashpoints.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(full));
    else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Every crashpoint('<literal>') call in src/ outside the port itself: [file, name] (the AST, so comments do not count). */
function callSites(): Array<{ file: string; name: string }> {
  const out: Array<{ file: string; name: string }> = [];
  for (const full of sourceFiles(join(REPO, 'src'))) {
    const file = relative(REPO, full).split('\\').join('/');
    if (file === 'src/ports/crashpoint.ts') continue;
    const sf = ts.createSourceFile(file, readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'crashpoint') {
        const arg0 = node.arguments[0];
        assert.ok(arg0 !== undefined && ts.isStringLiteral(arg0), `${file}: crashpoint() takes a string literal`);
        out.push({ file, name: arg0.text });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

test('the 14 Plan 2 crashpoint names are call sites in src/ and all appear in test/crashpoints.json', () => {
  const sites = callSites();
  const names = [...new Set(sites.map((s) => s.name))].sort();
  assert.deepEqual(names, [...PLAN2_CRASHPOINTS], 'the call sites in src/ are exactly the 14 Plan 2 names');
  assert.equal(PLAN2_CRASHPOINTS.length, 14);
  // registry.cas: immediately before and after the holds CAS (two call sites, one name); every other name once.
  const count = (n: string): number => sites.filter((s) => s.name === n).length;
  assert.equal(count('registry.cas'), 2);
  assert.deepEqual(sites.filter((s) => s.name === 'registry.cas').map((s) => s.file), ['src/holds/registry.ts', 'src/holds/registry.ts']);
  for (const n of PLAN2_CRASHPOINTS) if (n !== 'registry.cas') assert.equal(count(n), 1, `${n}: one call site`);
  const catalogue = JSON.parse(readFileSync(join(REPO, 'test', 'crashpoints.json'), 'utf8')) as string[];
  for (const n of PLAN2_CRASHPOINTS) assert.ok(catalogue.includes(n), `${n} is in test/crashpoints.json`);
  assert.deepEqual(lintCrashpoints(sites.map((s) => s.name), catalogue), [], 'L-CRASHPOINTS is clean');
});
