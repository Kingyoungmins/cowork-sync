// HLD-06, CS-28 structural form (Plan 3 Task 8): the revert detector, MASK, REBASE, PARK, RESTORE and R1 modules read no claim
// state — no import whose specifier names a claim module, no identifier `claims`, and no read of FoldState.claims. 05 P5 (the
// behavioural form) runs in Plan 4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MODULES = [
  'src/holds/revert.ts', 'src/holds/mask.ts', 'src/holds/rebase.ts', 'src/holds/evaluate.ts', 'src/holds/provenance.ts',
  'src/engine/holdOps.ts', 'src/engine/detect.ts',
];

/** Every import / export-from specifier, every identifier named `claims` and every `.claims` / `['claims']` read of a module. */
function scan(file: string, text: string): { specifiers: string[]; claimIdentifiers: number; claimReads: number } {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers: string[] = [];
  let claimIdentifiers = 0;
  let claimReads = 0;
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier !== undefined && ts.isStringLiteral(n.moduleSpecifier)) {
      specifiers.push(n.moduleSpecifier.text);
    }
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const a = n.arguments[0];
      if (a !== undefined && ts.isStringLiteralLike(a)) specifiers.push(a.text);
    }
    if (ts.isIdentifier(n) && n.text === 'claims') claimIdentifiers += 1;
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'claims') claimReads += 1;
    if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && n.argumentExpression.text === 'claims') claimReads += 1;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { specifiers, claimIdentifiers, claimReads };
}

test('the revert detector, MASK, REBASE, PARK, RESTORE and R1 modules import nothing that reads claim state', T10, () => {
  for (const file of MODULES) {
    const text = readFileSync(join(ROOT, ...file.split('/')), 'utf8');
    const s = scan(file, text);
    assert.ok(s.specifiers.length > 0, `${file}: imports were found (the scan reads the module)`);
    assert.deepEqual(s.specifiers.filter((x) => /claim/i.test(x)), [], `${file}: no claim module`);
    assert.equal(s.claimIdentifiers, 0, `${file}: no identifier "claims"`);
    assert.equal(s.claimReads, 0, `${file}: FoldState.claims is read nowhere`);
  }
  // The scan does see a claim read when one is planted.
  const planted = scan('src/holds/x.ts', `import { claimStillBlocks } from '../claims/gate.js';\nconst n = fold.claims.size;\nconst m = fold['claims'];\n`);
  assert.deepEqual(planted.specifiers, ['../claims/gate.js']);
  assert.equal(planted.claimReads, 2);
});
