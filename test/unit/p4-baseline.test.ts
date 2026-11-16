// R4-01's re-baseline check (Task 5, the first tests before any other change): every Plan 2 and Plan 3 name the
// contract cites exists with its cited signature, and Tasks 1–4 stay green on merged Plan 3 (the suites run in CI;
// this file asserts the structural parts). A failing assertion stops the task for a controller ruling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { grammarlessEditCheck, openGate, passT0Regions, plan3Ports, noSymbols } from '../../src/holds/ports.js';
import { HOLD_CODES } from '../../src/holds/codes.js';
import { heldRanges, assertSPub, assertP, maskEntries } from '../../src/holds/mask.js';
import type { T0Verdict, EditCheckVerdict } from '../../src/holds/ports.js';
import type { EngineDeps } from '../../src/engine/deps.js';
import type { PortsOverride } from '../helpers/coreFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PEER = '0123456789abcdef0123456789abcdef';

test('every Plan 2 and Plan 3 name this contract cites exists with its cited signature', T10, async () => {
  // The §Interfaces preamble list, assigned to the types Plan 2's contract (with its rulings) and Plan 3's state.
  const bindings = {
    grammarlessEditCheck, openGate, passT0Regions, noSymbols, plan3Ports, heldRanges, assertSPub, assertP, maskEntries,
  };
  for (const [name, v] of Object.entries(bindings)) assert.notEqual(v, undefined, `${name} missing`);
  // plan3Ports() deep-equals the four Plan 3 bindings.
  assert.deepEqual(plan3Ports(), { editCheck: grammarlessEditCheck, t0Regions: passT0Regions, gate: openGate, symbols: noSymbols });
  // openGate.claimStillBlocks(anyRecord) is true (fail closed).
  assert.equal(await openGate.claimStillBlocks({ paths: ['a.py'] } as Parameters<typeof openGate.claimStillBlocks>[0]), true);
  // HOLD_CODES contains BOARD_FULL.
  assert.equal((HOLD_CODES as readonly string[]).includes('BOARD_FULL'), true);
  // Plan 3 Task 10's amended contract is present: findings? (T0Finding's narrow, with reason) / entries? / the
  // per-peer ports function form / lastCheck.
  const fail: T0Verdict = { pass: false, paths: ['b.py'], item: 2, findings: [{ check: 2, path: 'b.py', reason: 'incompatible_caller' }] };
  assert.deepEqual(fail.findings, [{ check: 2, path: 'b.py', reason: 'incompatible_caller' }]);
  const ec: EditCheckVerdict = { verdict: 'incomplete', entries: [{ path: 'a.py', reason: 'no_snapshot' }] };
  assert.deepEqual(ec.entries, [{ path: 'a.py', reason: 'no_snapshot' }]);
  const fnForm: NonNullable<PortsOverride | ((deps: EngineDeps, peerIndex: number) => PortsOverride)> = (deps: EngineDeps, i: number) => {
    void deps; void i;
    return {};
  };
  void fnForm;
  // The Plan 3 Task 10 amendments are in the source (X-05…X-08, X-15): the class ChangeSets carries the instance
  // store lastCheck (X-05).
  assert.match(readFileSync(join(ROOT, 'src', 'holds', 'changesets.ts'), 'utf8'), /readonly lastCheck\s*[:=]/, 'ChangeSets.lastCheck exists (X-05)');
  // The ledger records whether Plan 3 Task 17's revertCs.ts exists (R4-46's caller; X-09).
  const revertCs = readdirSync(join(ROOT, 'src', 'holds')).includes('revertCs.ts');
  assert.equal(revertCs, true, 'src/holds/revertCs.ts exists (recorded for R4-46)');
  // The source files really declare them (the imports above are the compile check; ts parses the one smoke file).
  const sf = ts.createSourceFile('src/holds/ports.ts', readFileSync(join(ROOT, 'src', 'holds', 'ports.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const text = sf.getText();
  for (const n of ['grammarlessEditCheck', 'openGate', 'passT0Regions', 'plan3Ports']) {
    assert.match(text, new RegExp(`export (function|const) ${n}\\b`), `src/holds/ports.ts exports ${n}`);
  }
  assert.match(text, /export const noSymbols\b/, 'noSymbols exists in src/holds/ports.ts');
  void PEER;
});

test('Tasks 1-4 stay green on merged Plan 3: coworkOff literals all carry workingTreeEncoding', T10, () => {
  // Any Plan 3 PathAttrs literal was widened in this task (R4-01): grep 'coworkOff:' over test/ lists only literals
  // that carry workingTreeEncoding too — or sit in a Partial<PathAttrs> position (a partial merge over NO_ATTRS),
  // which the checker admits only when it type-checks as Partial<PathAttrs> without one.
  const bad: string[] = [];
  const scan = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) scan(p);
      else if (e.name.endsWith('.ts')) {
        const text = readFileSync(p, 'utf8');
        if (!text.includes('coworkOff:')) continue;
        const sf = ts.createSourceFile(p, text, ts.ScriptTarget.Latest, true);
        const visit = (n: ts.Node): void => {
          if (ts.isObjectLiteralExpression(n)) {
            const props = n.properties.filter((x): x is ts.PropertyAssignment => ts.isPropertyAssignment(x) && ts.isIdentifier(x.name));
            if (props.some((x) => x.name.getText() === 'coworkOff') && !props.some((x) => x.name.getText() === 'workingTreeEncoding')) {
              // A spread over NO_ATTRS (or PLAIN_ATTRS) fills workingTreeEncoding, and a literal nested inside a call
              // argument chain (a partial-attrs helper like inputs({ 'p': { coworkOff: true } }) over NO_ATTRS) is a
              // partial too. Only a bare literal assigned to a full PathAttrs position is a miss.
              const spreads = n.properties.filter(ts.isSpreadAssignment).map((x) => x.expression.getText());
              const insideArgs = ts.isCallExpression(n.parent) || ts.isPropertyAssignment(n.parent);
              if (spreads.length === 0 && !insideArgs) bad.push(`${p.replace(/\\/gu, '/')}:${n.getStart(sf) + 1}`);
            }
          }
          ts.forEachChild(n, visit);
        };
        visit(sf);
      }
    }
  };
  scan(join(ROOT, 'test'));
  assert.deepEqual(bad, [], 'every PathAttrs literal with coworkOff: also sets workingTreeEncoding (or spreads a *_ATTRS base)');
});
